/**
 * Durable session history.
 *
 * Deliberately separate from the in-memory diagnostics log in logger.ts. That log
 * stays small, redacted and RAM-only; this one is an explicit opt-in feature that
 * writes what actually happened to disk so a five-hour session can be recovered.
 *
 * Structured activity is append-only JSONL. ChatGPT messages are different: streaming
 * changes the content of one logical message, so storing each snapshot as another event
 * creates duplicate transcript rows by construction. New writes live as one atomically
 * replaceable shard per stable logical website identity. A legacy messages.json map is read
 * as an overlay until each record is naturally rewritten, avoiding a startup-wide migration.
 * Identity is decided by the page/Fiber producer before it gets here; this store never guesses
 * that two different website ids are one message from their text, turn or timing.
 *
 *   sessions/<id>/events.jsonl    tool/turn/error/activity events, append-only
 *   sessions/<id>/messages/*.json canonical user/assistant messages, one logical id per shard
 *   sessions/<id>/messages.json   legacy canonical map, read during lazy migration
 *   sessions/<id>/meta.json       the summary, rewritten atomically
 *   sessions/<id>/assets/<id>     screenshots and other binaries
 *   sessions/<id>/handoffs/<id>.json
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { CORE_NATIVE_OBSERVATION_MAX_SCOPES, CORE_NATIVE_OBSERVATION_MAX_BYTES, nativeObservationScopeKey,
  normalizedNativeCompletionObservation, type ScopedNativeCompletionObservation } from '../core-browser-evidence.js';
import path from 'node:path';
import type {
  AssetRef,
  DeletedSessionRecovery,
  Handoff,
  NewSessionEvent,
  ReasoningEffort,
  SessionEvent,
  SessionOrigin,
  SessionSummary,
  StoredText,
  ToolCallRecord
} from '../../shared/session.js';
import { continuationMarker, eventTokens, MAX_TOOL_RESULT_TOKENS, normalizedToolOutcome, storedTextTokens, workSequence } from '../../shared/session.js';
import { MAX_MULTI_AGENT_WORKERS } from '../../shared/types.js';
import { chronological, positionOf } from '../../shared/chronology.js';
import { automaticTitle, firstTitleMessage, legacyContextTitle, refreshUserTitle, userTitle } from './title.js';
import { agentPlanSchema, agentPlanUpdateSchema, preserveAcceptance, MAX_AGENT_PLAN_BYTES, type AgentPlan, type AgentPlanUpdate } from '../../shared/agent-plan.js';
import { getConfig } from '../config.js';
import { durableStoreReady } from '../durable.js';
import { logError, logInfo, logWarn } from '../logger.js';

/**
 * Caps on how much of a value is written *inline*, into the JSONL line itself.
 *
 * These are not caps on what is kept. Anything longer is written whole, redacted, as a
 * `.txt` asset beside the log and referenced by `StoredText.assetId`, so the exact
 * arguments of an edit and the exact output of a command stay recoverable however
 * large they were — which is the entire premise of calling this history the source of
 * truth. What the caps buy is a log whose lines a reader can still parse and a summary
 * pass can still skim.
 */
// A Compact & Resume handoff becomes the next chat's opening user message. This is a wire /
// storage safety bound, not a token budget; keep it comfortably above the model's 30k-token
// handoff ceiling so the recorder does not immediately turn the carried brief into an inline
// stub plus asset reference. Truly runaway messages still spill to assets through storeText().
export const MAX_USER_MESSAGE_CHARS = 256_000;
export const MAX_MESSAGE_CHARS = 12_000;
export const MAX_TOOL_ARGS_CHARS = 8_000;
export const MAX_TOOL_RESULT_CHARS = 8_000;
/** Nothing is spilled to an overflow asset past this; a note records the shortfall. */
export const MAX_OVERFLOW_ASSET_CHARS = 8 * 1024 * 1024;
/** A single line that cannot be parsed back is dropped; this bounds the damage. */
const MAX_LINE_BYTES = 512 * 1024;
/** How many sessions the UI shows. Lookups and pruning still see every session. */
const MAX_LISTED_SESSIONS = 200;
/** Bound for legacy/model-facing full-list scans. Identity and retention use the uncapped cached catalog. */
const MAX_SCANNED_SESSIONS = 5_000;
/** Keep the uncapped authoritative scan fast without opening thousands of files at once. */
const ATTACHMENT_CATALOG_READ_CONCURRENCY = 64;
/** Small shard reads are latency-bound on Windows; keep parallelism bounded to avoid I/O bursts. */
const CANONICAL_SHARD_READ_CONCURRENCY = 8;
/** Bounded, in-memory diagnostics; never message/result or read-success authority. */
const MAX_CANONICAL_SHARD_WARNINGS = 128;
const CANONICAL_SHARD_WARNING_INTERVAL_MS = 5 * 60_000;
const unreadableCanonicalShardWarnings = new Map<string, { failure: string; reportedAt: number }>();
let canonicalShardWarningEpoch = 0;

/** Manual sidebar deletes remain recoverable without keeping an unbounded second history. */
export const DELETED_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Windows can keep a just-flushed session directory open briefly while Defender, indexing or
 * Chromium releases its last handle. Delete and Undo are same-volume directory renames, so a
 * short sharing violation is safe to retry. Keep the schedule explicit and bounded: the caller
 * gets the original error after 20.5 seconds rather than an unbounded "working" state. A real
 * session lock has lasted roughly 15 seconds, so this still covers the observed recovery window.
 */
const SESSION_DIRECTORY_RENAME_RETRY_DELAYS_MS: readonly number[] = [
  100, 200, 400, 800,
  ...new Array<number>(19).fill(1_000)
];
const RETRYABLE_SESSION_DIRECTORY_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

let root = '';
/**
 * Current-conversation misses already proven against this process's durable catalog.
 *
 * Browser activity polls repeatedly ask about chats this app has never recorded. Re-scanning
 * every session folder for the same negative answer is pure work. Positive ownership remains
 * sourced from metadata; this cache only remembers a miss, and every operation that can create
 * that exact current attachment invalidates its key before a later lookup may trust it.
 */
const missingCurrentConversations = new Set<string>();

interface AttachmentCatalog {
  /** Durable summary projection used for attachment identity and the renderer summary index. */
  summaries: Map<string, SessionSummary>;
  /** Durable closed-session order. Open sessions are overlaid live and excluded while paging. */
  orderedIds: string[];
  current: Map<string, Set<string>>;
  historical: Map<string, Set<string>>;
  /**
   * Whether this pass actually read every folder it enumerated.
   *
   * An incomplete catalog may serve the folders it did read, but it is not proof of absence and
   * must never seed the process-lifetime negative conversation cache.
   */
  complete: boolean;
}

/**
 * Derived, rebuildable attachment index. Durable `meta.json` remains the authority.
 *
 * Some model-facing compatibility reads intentionally cap directory scans at 5,000. Conversation
 * identity and retention cannot use that cap: an arbitrary readdir prefix is not proof that an
 * older chat has no owner or is exempt from expiry. The catalog performs one uncapped,
 * crash-reconciling pass on first authoritative lookup, then normal `/activity`, renderer and
 * retention reads reuse it. Attachment mutations update it only after their durable write lands.
 */
let attachmentCatalog: AttachmentCatalog | null = null;
let attachmentCatalogLoading: Promise<AttachmentCatalog> | null = null;
/**
 * Invalidates an in-flight catalog build on ownership changes or when a live overlay retires.
 * Ordinary event/meta ticks do not touch it.
 */
let attachmentEpoch = 0;
const MAX_MISSING_CONVERSATION_CACHE = 1024;

function rememberMissingCurrentConversation(conversationId: string): void {
  missingCurrentConversations.add(conversationId);
  if (missingCurrentConversations.size <= MAX_MISSING_CONVERSATION_CACHE) return;
  const oldest = missingCurrentConversations.values().next().value as string | undefined;
  if (oldest) missingCurrentConversations.delete(oldest);
}

export function initSessionStore(userDataDir: string): void {
  unreadableCanonicalShardWarnings.clear();
  canonicalShardWarningEpoch++;
  root = path.join(userDataDir, 'sessions');
  sessionAssetUsage.clear();
  globalAssetUsage = null;
  missingCurrentConversations.clear();
  attachmentCatalog = null;
  attachmentCatalogLoading = null;
  attachmentEpoch = 0;
}

export function sessionsRoot(): string {
  return root;
}

/**
 * Refuses to touch the disk before somebody has said where.
 *
 * `root` starts empty, and `path.join('', id)` is a *relative* path — so an uninitialised
 * store does not fail, it writes real session folders into whatever the process's working
 * directory happens to be. That stayed invisible for as long as recording was off by
 * default; the moment it was switched on, a test run began scattering recordings through
 * the repository. In the app proper this cannot happen — `initSessionStore` is called
 * during start-up — which is exactly why it needs to be loud rather than left to chance.
 */
function assertReady(): void {
  if (root === '') {
    throw new Error('The session store was used before initSessionStore() named a directory');
  }
}

function sessionDir(id: string): string {
  assertReady();
  return path.join(root, id);
}

/** Text-only search index owned by the session folder. */
export function sessionSearchIndexPath(id: string): string {
  return path.join(sessionDir(id), 'search.txt');
}

function deletedSessionsRoot(): string {
  assertReady();
  // The leading dot makes this fail the session-id filter used by all normal catalog scans.
  return path.join(root, '.deleted-sessions');
}

function deletedSessionDir(id: string): string {
  return path.join(deletedSessionsRoot(), id);
}

function checkedDeletedSessionDir(id: string): string {
  assertSessionId(id);
  const trash = path.resolve(deletedSessionsRoot());
  const target = path.resolve(deletedSessionDir(id));
  if (!target.startsWith(trash + path.sep)) throw new Error('Deleted session path escaped the recovery folder');
  return target;
}

/** Ids are generated here and never taken from a caller, so this is a sanity check. */
function assertSessionId(id: string): void {
  if (!/^[0-9a-z-]{8,64}$/i.test(id)) throw new Error('Invalid session id');
}

function retryableSessionDirectoryRename(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && RETRYABLE_SESSION_DIRECTORY_RENAME_CODES.has(code);
}

async function renameSessionDirectory(
  source: string,
  destination: string,
  sessionId: string,
  operation: 'delete' | 'restore'
): Promise<void> {
  let retries = 0;
  for (;;) {
    try {
      await fs.rename(source, destination);
      if (retries > 0) {
        logInfo(`session ${operation} recovered from a temporary Windows directory lock for ${sessionId} after ${retries} retries`);
      }
      return;
    } catch (error) {
      if (!retryableSessionDirectoryRename(error) || retries >= SESSION_DIRECTORY_RENAME_RETRY_DELAYS_MS.length) {
        throw error;
      }
      if (retries === 0) {
        const code = (error as NodeJS.ErrnoException).code;
        logWarn(`session ${operation} directory rename for ${sessionId} was temporarily blocked (${code}); retrying for up to 20.5 seconds`);
      }
      const delay = SESSION_DIRECTORY_RENAME_RETRY_DELAYS_MS[retries]!;
      retries += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

// ------------------------------------------------------------------ state

interface OpenSession {
  summary: SessionSummary;
  /** Private restart custody; never part of renderer/model-facing summaries. */
  nativeCompletionFences: NativeCompletionPrivateState;
  /** Derived exact-work union; history owns it, this cache avoids replaying history on every append. */
  activeWorkIntervals: ActiveWorkInterval[];
  nextSeq: number;
  /** Highest durable journal/message seq already reflected by `summary`. */
  historySeq: number;
  /** Recent durable events, so incremental /activity polls do not reread the whole JSONL. */
  tail: SessionEvent[];
  /** Earliest cursor covered by tail; reopening starts with no journal rows cached. */
  tailFrom: number;
  activityHydrated: boolean;
  /** Serialises appends so two events can never interleave inside one line. */
  queue: Promise<void>;
  /** Canonical messages and background calls, replaced by stable message/call identity. */
  messages: Map<string, CanonicalEvent>;
  metaDirty: boolean;
  metaTimer: NodeJS.Timeout | null;
}

export type SessionAppendReadOptions = Pick<ReadOptions, 'kinds' | 'agent'> & {
  maxBytes?: number;
  before?: number;
};

/**
 * Queue-safe facts available to a conditional append.
 *
 * The predicate already owns this session's mutation queue. Calling a normal public reader from
 * it would try to join the same queue and deadlock, so history checks must use this bounded reader.
 */
export interface SessionAppendCurrent {
  readonly activeTurnId: string | null;
  readonly lastTurnOutcome: SessionSummary['lastTurnOutcome'];
  readRecentEvents(limit: number, options?: SessionAppendReadOptions): Promise<SessionEvent[]>;
}

export type SessionAppendPredicate = (
  current: SessionAppendCurrent
) => boolean | Promise<boolean>;

const open = new Map<string, OpenSession>();
/** One disk reconstruction per session; direct concurrent callers must share it. */
const opening = new Map<string, Promise<OpenSession>>();
interface DurableSessionSnapshot {
  summary: SessionSummary;
  messages: Map<string, CanonicalEvent>;
  historySeq: number;
  reconciled: boolean;
  /** Present when recovery already replayed history; otherwise ensureOpen hydrates it on demand. */
  activeWorkIntervals?: ActiveWorkInterval[];
}
/** Read-only recovery also shares one durable high-water check/rebuild per session. */
const reconciling = new Map<string, Promise<DurableSessionSnapshot | null>>();
const MAX_EVENT_TAIL = 4096;
/** Hard ceiling for a bounded recent-history disk read. */
const MAX_RECENT_READ_BYTES = 8 * 1024 * 1024;
const MAX_CANONICAL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_ASSET_BYTES = 192 * 1024 * 1024;
export const MAX_GLOBAL_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

const sessionAssetUsage = new Map<string, number>();
let globalAssetUsage: number | null = null;
let assetWriteQueue = Promise.resolve();

type MessageEvent = Extract<SessionEvent, { kind: 'user_message' | 'assistant_message' }>;
type CanonicalEvent = MessageEvent | Extract<SessionEvent, { kind: 'tool_call' }>;
type NewMessageEvent = MessageEvent extends infer Event
  ? Event extends MessageEvent
    ? Omit<Event, 'seq'>
    : never
  : never;

type ActiveWorkInterval = [start: number, end: number];

export interface WorkstreamActiveWork {
  sessionIds: string[];
  activeWorkMs: number;
  activeWorkMeasurement: 'unknown' | 'partial';
}

const NON_WORK_TOOL_CALLS = new Set(['keep_astra_on_forever', 'session_finish']);

/** Exact local execution intervals that this durable event proves, and nothing more. */
function activeWorkIntervalsForEvent(event: SessionEvent): ActiveWorkInterval[] {
  if (event.kind !== 'tool_call' || event.source !== 'mcp' ||
      event.call.attributionMethod !== 'request_id' || !event.call.requestId || !event.call.conversationId ||
      NON_WORK_TOOL_CALLS.has(event.call.tool)) return [];
  const intervals: ActiveWorkInterval[] = [];
  const append = (start: number, duration: number): void => {
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return;
    const end = start + duration;
    if (!Number.isFinite(end) || end <= start) return;
    intervals.push([start, end]);
  };
  append(event.time, event.call.durationMs);
  const process = event.call.process;
  if (process?.completedAt !== undefined && process.durationMs !== undefined &&
      Number.isFinite(process.completedAt) && Number.isFinite(process.durationMs) && process.durationMs > 0) {
    append(process.completedAt - process.durationMs, process.durationMs);
  }
  return intervals;
}

/** Keep one sorted disjoint union so concurrent/out-of-order calls cannot double-count time. */
function mergeActiveWorkInterval(intervals: ActiveWorkInterval[], candidate: ActiveWorkInterval): number {
  let [start, end] = candidate;
  let replacedMs = 0;
  let at = 0;
  while (at < intervals.length && intervals[at]![1] < start) at += 1;
  while (at < intervals.length && intervals[at]![0] <= end) {
    replacedMs += intervals[at]![1] - intervals[at]![0];
    start = Math.min(start, intervals[at]![0]);
    end = Math.max(end, intervals[at]![1]);
    intervals.splice(at, 1);
  }
  intervals.splice(at, 0, [start, end]);
  return Math.max(0, (end - start) - replacedMs);
}

function activeWorkDuration(intervals: readonly ActiveWorkInterval[]): number {
  let total = 0;
  for (const [start, end] of intervals) total = Math.min(Number.MAX_SAFE_INTEGER, total + (end - start));
  return total;
}

/**
 * Unions exact execution evidence across one stable prime session and its proven workers.
 *
 * Callers resolve family identity; this function deliberately knows only durable session ids.
 * Cold historical members stay cold: readDurableSnapshot repairs/reconstructs the durable
 * projection without inserting them into `open`, which would otherwise change retention and live
 * memory semantics merely because a controls/progress view was rendered. Summaries are never
 * added together because concurrent workers would double-count overlap.
 */
export async function workstreamActiveWork(sessionIds: readonly string[]): Promise<WorkstreamActiveWork> {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  const union: ActiveWorkInterval[] = [];
  const included: string[] = [];
  for (const id of ids) {
    try {
      const live = open.get(id);
      const snapshot = live ? null : await readDurableSnapshot(id);
      if (!live && !snapshot) {
        continue;
      }
      const intervals = live?.activeWorkIntervals ?? snapshot!.activeWorkIntervals ??
        await readActiveWorkIntervalsFromHistory(id, snapshot!.messages);
      included.push(id);
      for (const interval of intervals) mergeActiveWorkInterval(union, interval);
    } catch {
      // An unreadable/missing member cannot become invented work. Omit it from the proven family
      // projection; the resulting duration remains a lower bound and therefore partial/unknown.
      continue;
    }
  }
  const activeWorkMs = activeWorkDuration(union);
  return {
    sessionIds: included,
    activeWorkMs,
    // Proven intervals remain a valid lower bound even when another family member cannot be
    // read. `unknown` means exactly what SessionSummary documents: no exact interval evidence.
    activeWorkMeasurement: activeWorkMs > 0 ? 'partial' : 'unknown'
  };
}

function applyActiveWork(summary: SessionSummary, event: SessionEvent, intervals: ActiveWorkInterval[]): void {
  const evidence = activeWorkIntervalsForEvent(event);
  if (evidence.length === 0) return;
  let addedMs = 0;
  for (const interval of evidence) addedMs += mergeActiveWorkInterval(intervals, interval);
  summary.activeWorkMs = Math.min(Number.MAX_SAFE_INTEGER, (summary.activeWorkMs ?? 0) + addedMs);
  summary.activeWorkMeasurement = 'partial';
}

/** Internal checkpoint field persisted beside the public summary projection. */
const META_HISTORY_SEQ = '__historySeq';
// Alias shards remain forensic history, so the watermark alone cannot tell whether
// their duplicate token/event contributions have already been removed from metadata.
const META_CANONICAL_PROJECTION = '__canonicalProjection';
const META_TOKEN_ESTIMATE = '__tokenEstimate';
const META_NATIVE_COMPLETION_FENCES = '__nativeCompletionFences';
const NATIVE_FENCE_MAX_SLOTS = 32;
const NATIVE_FENCE_MAX_BYTES = CORE_NATIVE_OBSERVATION_MAX_BYTES;

/** Exact observed identity only. This checkpoint is neither a result nor Send authority. */
export interface SessionNativeCompletionFence {
  version: 1;
  profileId: string;
  sessionId: string;
  conversationId: string;
  documentId: string;
  navigationEpoch: number;
  observedAt: number;
  reason: 'open-call' | 'open-code' | 'inventory-incomplete';
  calls: number;
  codeCalls: number;
  openCalls: number;
  openCodeCalls: number;
  sourceUserMessageId: string | null;
  openRequestIds: string[] | null;
  coreCallMessageIds: string[] | null;
  allCoreRequestIds: string[] | null;
  codeCallMessageIds: string[] | null;
  openCodeCallMessageIds: string[] | null;
}
interface NativeCompletionSlot {
  profileId: string;
  sessionId: string;
  conversationId: string;
  /** Null is a durable clear, distinct from an absent legacy checkpoint. */
  fence: SessionNativeCompletionFence | null;
  /** Reject delayed recapture after this original observation was durably cleared. */
  retiredObservedAt: number | null;
  /** Exact prior negative witness retained behind a durable clear, never a result receipt. */
  clearedFence: SessionNativeCompletionFence | null;
  clearedAt: number | null;
  /** Independent diagnostic scopes, never replacements for fence/clearedFence. */
  observations?: ScopedNativeCompletionObservation[];
}
// v2 is written only when extra scopes exist, and never silently downgraded. Old
// strict readers must refuse it; rollback admission must inspect metadata AND backup.
interface NativeCompletionCheckpoint { version: 1 | 2; slots: Record<string, NativeCompletionSlot> }
interface NativeCompletionPrivateState { checkpoint: NativeCompletionCheckpoint | null; invalid: boolean }
const emptyNativeCompletionState = (): NativeCompletionPrivateState => ({ checkpoint: null, invalid: false });
const nativeFenceIdentity = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && /^[a-z0-9_.:-]+$/i.test(value);
const nativeFenceConversation = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f-]{8,64}$/i.test(value);
function normalizedNativeFence(value: unknown): SessionNativeCompletionFence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as SessionNativeCompletionFence;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 400;
  if (row.version !== 1 || !nativeFenceIdentity(row.profileId) || !nativeFenceIdentity(row.sessionId, 64) ||
      !nativeFenceConversation(row.conversationId) || !nativeFenceIdentity(row.documentId) ||
      !Number.isSafeInteger(row.navigationEpoch) || row.navigationEpoch < 0 ||
      !Number.isSafeInteger(row.observedAt) || row.observedAt <= 0 || row.observedAt > Date.now() ||
      !['open-call', 'open-code', 'inventory-incomplete'].includes(row.reason) ||
      !count(row.calls) || !count(row.codeCalls) || !count(row.openCalls) || !count(row.openCodeCalls) ||
      row.openCalls > row.calls || row.openCodeCalls > row.codeCalls ||
      (row.reason === 'open-call' && row.openCalls === 0) ||
      (row.reason === 'open-code' && row.openCodeCalls === 0) ||
      !(row.sourceUserMessageId === null || (typeof row.sourceUserMessageId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.sourceUserMessageId)))) return null;
  const ids = (values: unknown, length: number, max: number, unique: boolean): values is string[] | null =>
    values === null || (Array.isArray(values) && length <= 200 && values.length === length &&
      values.every(id => nativeFenceIdentity(id, max)) && (!unique || new Set(values).size === values.length));
  if (!ids(row.openRequestIds, row.openCalls, 100, false) ||
      !ids(row.coreCallMessageIds, row.calls, 200, true) ||
      !ids(row.allCoreRequestIds, row.calls, 100, false) ||
      !ids(row.codeCallMessageIds, row.codeCalls, 200, true) ||
      !ids(row.openCodeCallMessageIds, row.openCodeCalls, 200, true) ||
      (row.allCoreRequestIds !== null && row.coreCallMessageIds === null) ||
      (row.openCodeCallMessageIds !== null && row.codeCallMessageIds !== null &&
        row.openCodeCallMessageIds.some(id => !row.codeCallMessageIds!.includes(id)))) return null;
  const normalized: SessionNativeCompletionFence = {
    version: 1, profileId: row.profileId, sessionId: row.sessionId, conversationId: row.conversationId,
    documentId: row.documentId, navigationEpoch: row.navigationEpoch, observedAt: row.observedAt,
    reason: row.reason, calls: row.calls, codeCalls: row.codeCalls, openCalls: row.openCalls,
    openCodeCalls: row.openCodeCalls, sourceUserMessageId: row.sourceUserMessageId,
    openRequestIds: row.openRequestIds && [...row.openRequestIds],
    coreCallMessageIds: row.coreCallMessageIds && [...row.coreCallMessageIds],
    allCoreRequestIds: row.allCoreRequestIds && [...row.allCoreRequestIds],
    codeCallMessageIds: row.codeCallMessageIds && [...row.codeCallMessageIds],
    openCodeCallMessageIds: row.openCodeCallMessageIds && [...row.openCodeCallMessageIds]
  };
  // No unvalidated extra payload may hide in this identity-only field.
  return Object.keys(row).length === Object.keys(normalized).length ? normalized : null;
}
function normalizedNativeCompletionState(value: unknown, sessionId: string): NativeCompletionPrivateState {
  if (value === undefined) return emptyNativeCompletionState();
  const invalid = (): NativeCompletionPrivateState => ({ checkpoint: null, invalid: true });
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Buffer.byteLength(JSON.stringify(value), 'utf8') > NATIVE_FENCE_MAX_BYTES) return invalid();
  const row = value as NativeCompletionCheckpoint;
  if (![1, 2].includes(row.version) || Object.keys(row).length !== 2 || !row.slots ||
      typeof row.slots !== 'object' || Array.isArray(row.slots) || Object.keys(row.slots).length > NATIVE_FENCE_MAX_SLOTS) return invalid();
  const slots: Record<string, NativeCompletionSlot> = {};
  let observationCount = 0;
  for (const [conversationId, slot] of Object.entries(row.slots)) {
    if (!nativeFenceConversation(conversationId) || !slot || typeof slot !== 'object' ||
        Object.keys(slot).length !== (slot.observations === undefined ? 7 : 8) ||
        (row.version === 1 && slot.observations !== undefined) || slot.sessionId !== sessionId ||
        slot.conversationId !== conversationId || !nativeFenceIdentity(slot.profileId) ||
        !(slot.retiredObservedAt === null || (Number.isSafeInteger(slot.retiredObservedAt) &&
          slot.retiredObservedAt > 0 && slot.retiredObservedAt <= Date.now()))) return invalid();
    const fence = slot.fence === null ? null : normalizedNativeFence(slot.fence);
    if (slot.fence !== null && (!fence || fence.sessionId !== sessionId ||
        fence.conversationId !== conversationId || fence.profileId !== slot.profileId ||
        (slot.retiredObservedAt !== null && fence.observedAt <= slot.retiredObservedAt))) return invalid();
    const clearedFence = slot.clearedFence === null ? null : normalizedNativeFence(slot.clearedFence);
    if (slot.clearedFence !== null ? (!clearedFence || clearedFence.sessionId !== sessionId ||
        clearedFence.profileId !== slot.profileId || clearedFence.conversationId !== conversationId ||
        !Number.isSafeInteger(slot.clearedAt) || slot.clearedAt! < clearedFence.observedAt || slot.clearedAt! > Date.now())
      : slot.clearedAt !== null) return invalid();
    if ((!fence && !clearedFence) ||
        (fence && clearedFence && fence.observedAt <= clearedFence.observedAt)) return invalid();
    const observations = slot.observations === undefined ? undefined : normalizedNativeObservations(slot.observations);
    if (observations === null || (observations && observations.length === 0)) return invalid();
    observationCount += observations?.length ?? 0;
    if (observationCount > CORE_NATIVE_OBSERVATION_MAX_SCOPES) return invalid();
    slots[conversationId] = { profileId: slot.profileId, sessionId, conversationId, fence,
      retiredObservedAt: slot.retiredObservedAt, clearedFence, clearedAt: slot.clearedAt,
      ...(observations ? { observations } : {}) };
  }
  return { checkpoint: { version: row.version, slots }, invalid: false };
}

function normalizedNativeObservations(value: unknown): ScopedNativeCompletionObservation[] | null {
  if (!Array.isArray(value) || value.length > CORE_NATIVE_OBSERVATION_MAX_SCOPES) return null;
  const normalized = value.map(normalizedNativeCompletionObservation);
  if (normalized.some(item => item === null)) return null;
  const observations = normalized as ScopedNativeCompletionObservation[];
  return new Set(observations.map(nativeObservationScopeKey)).size === observations.length ? observations : null;
}
type PersistedSummary = SessionSummary & { [META_HISTORY_SEQ]?: number; [META_CANONICAL_PROJECTION]?: number; [META_TOKEN_ESTIMATE]?: number;
  [META_NATIVE_COMPLETION_FENCES]?: NativeCompletionCheckpoint };
interface MetaCheckpoint {
  summary: SessionSummary;
  nativeCompletionFences: NativeCompletionPrivateState;
  /** Null means metadata written by a version that did not yet persist a history watermark. */
  historySeq: number | null;
  canonicalProjectionCurrent: boolean;
  tokenEstimateCurrent: boolean;
  /** Derived migration signal; never persisted. */
  outcomeCountersMissing: boolean;
  /** Derived final-message activity boundary was added after the original summaries. */
  activityBoundaryMissing: boolean;
  /** Derived file-change totals were added after the original summaries. */
  fileChangeProjectionMissing: boolean;
  /** Exact active-work lower bound was added after the original summaries. */
  activeWorkProjectionMissing: boolean;
}

function messageKey(event: SessionEvent | Omit<MessageEvent, 'seq'>): string | null {
  if (event.kind === 'tool_call') return event.call?.callId ? `tool_call\u0000${event.call.callId}` : null;
  return (event.kind === 'user_message' || event.kind === 'assistant_message') && event.messageId
    ? `${event.kind}\u0000${event.messageId}` : null;
}

/** Rebuild the exact interval union once when a durable session becomes live after restart. */
async function readActiveWorkIntervalsFromHistory(
  id: string,
  messages: ReadonlyMap<string, CanonicalEvent>
): Promise<ActiveWorkInterval[]> {
  const intervals: ActiveWorkInterval[] = [];
  const canonicalKeys = new Set(messages.keys());
  let raw = '';
  try {
    raw = await fs.readFile(path.join(sessionDir(id), 'events.jsonl'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as SessionEvent;
      if (!event || typeof event.seq !== 'number' || typeof event.kind !== 'string') continue;
      const key = messageKey(event);
      if (key && canonicalKeys.has(key)) continue;
      for (const interval of activeWorkIntervalsForEvent(event)) mergeActiveWorkInterval(intervals, interval);
    } catch {
      // Unreadable history cannot become work time. The public measurement remains partial/unknown.
    }
  }
  for (const event of messages.values()) {
    for (const interval of activeWorkIntervalsForEvent(event)) mergeActiveWorkInterval(intervals, interval);
  }
  return intervals;
}

/** Exact equality for the fixed StoredText wire shape without serialising large prose. */
function storedTextEqual(left: StoredText | undefined, right: StoredText | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.text === right.text &&
    left.truncated === right.truncated &&
    left.chars === right.chars &&
    left.assetId === right.assetId &&
    left.digest === right.digest
  );
}

/**
 * Equality of authored/model text rather than its storage representation.
 *
 * A rewritten asset id, newly available digest, or inline/truncated representation is metadata
 * when the visible text and full character count are unchanged. When both sides have a digest it
 * is the stronger identity for a truncated body whose unseen suffix could otherwise differ.
 */
function storedSemanticTextEqual(left: StoredText, right: StoredText): boolean {
  return left.text === right.text && left.chars === right.chars &&
    (!left.digest || !right.digest || left.digest === right.digest);
}

function inputProvenanceEqual(
  left: Extract<SessionEvent, { kind: 'user_message' }>['inputProvenance'],
  right: Extract<SessionEvent, { kind: 'user_message' }>['inputProvenance']
): boolean {
  return left === right || !!(left && right && left.version === right.version &&
    left.authorship === right.authorship && left.sessionId === right.sessionId &&
    left.conversationId === right.conversationId && left.inputId === right.inputId &&
    left.nativeMessageId === right.nativeMessageId && left.deliveredAt === right.deliveredAt &&
    left.authoredSha256 === right.authoredSha256 && left.preparedSha256 === right.preparedSha256);
}

function messageSemanticTextEqual(previous: MessageEvent, next: NewMessageEvent): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === 'assistant_message' && next.kind === 'assistant_message') {
    return storedSemanticTextEqual(previous.message, next.message);
  }
  if (previous.kind === 'user_message' && next.kind === 'user_message') {
    // App-authored text excludes transport-only control framing. Once known, that is the
    // semantic user request; page rendering or delivery-envelope changes are metadata.
    if (previous.authoredText !== undefined || next.authoredText !== undefined) {
      return previous.authoredText === next.authoredText;
    }
    return storedSemanticTextEqual(previous.message, next.message);
  }
  return false;
}

function emptySummary(id: string, title: string, conversationId: string | null): SessionSummary {
  const now = Date.now();
  return {
    id,
    title,
    conversationId,
    chatIds: conversationId ? [conversationId] : [],
    startedAt: now,
    updatedAt: now,
    lastMessageAt: null,
    endedAt: null,
    events: 0,
    userMessages: 0,
    toolCalls: 0,
    fileEdits: 0,
    linesAdded: 0,
    linesRemoved: 0,
    approximateFileChanges: false,
    lastFileChangeAt: null,
    lastToolCallAt: null,
    activeWorkMs: 0,
    activeWorkMeasurement: 'unknown',
    lastAssistantFinalAt: null,
    lastTurnEndAt: null,
    lastFinishReportAt: null,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 0,
    contextTokens: 0,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastCommittedResumeHandoffId: null,
    lastTurnOutcome: null,
    activeTurnId: null,
    finishTurn: null,
    agents: [],
    origin: null
  };
}

/** Write complete contents and flush them before the atomic rename publishes the file. */
async function writeFileDurably(file: string, contents: string): Promise<void> {
  const handle = await fs.open(file, 'w');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Persists one summary atomically, without any live-entry bookkeeping.
 *
 * Split out so a *staged* summary can be written before it is published into memory. That
 * ordering is what makes the compaction rebind safe to fail: see rebindSession.
 */
async function writeSummary(summary: SessionSummary, historySeq: number, privateFences?: NativeCompletionPrivateState,
  expectedPrivateFences?: NativeCompletionPrivateState): Promise<void> {
  const dir = sessionDir(summary.id);
  const ownerRoot = root, ownerEpoch = canonicalShardWarningEpoch;
  const stillOwned = (): void => {
    if (root !== ownerRoot || canonicalShardWarningEpoch !== ownerEpoch)
      throw new Error('Session metadata owner changed before durable publication');
  };
  const target = path.join(dir, 'meta.json');
  const backup = path.join(dir, 'meta.backup.json');
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  // All summary writers, including cold history repair and rebind, retain the
  // private checkpoint. Unknown schema must never become an apparently empty hold.
  const diskFences = await nativeCompletionStateOnDisk(summary.id);
  const expectedFences = expectedPrivateFences ?? open.get(summary.id)?.nativeCompletionFences;
  if (diskFences.invalid || (expectedFences && JSON.stringify(expectedFences) !== JSON.stringify(diskFences)))
    throw new Error('Session native completion checkpoint changed or is unreadable; original metadata retained');
  const fences = privateFences ?? expectedFences ?? diskFences;
  stillOwned();
  if (fences.invalid) throw new Error('Session native completion checkpoint is unreadable; original metadata retained');
  const persisted: PersistedSummary = { ...summary, [META_HISTORY_SEQ]: historySeq, [META_CANONICAL_PROJECTION]: 1, [META_TOKEN_ESTIMATE]: 1,
    ...(fences.checkpoint ? { [META_NATIVE_COMPLETION_FENCES]: fences.checkpoint } : {}) };
  // Creation owns directory creation. A delayed metadata write must fail if deletion
  // already moved this directory, not resurrect a metadata-only active session.
  try {
    await writeFileDurably(tmp, JSON.stringify(persisted, null, 2));
    stillOwned();
    // Preserve the last validated checkpoint. Never copy arbitrary corrupt bytes over the
    // backup: parse/id validation is what makes this a recovery source rather than a second
    // name for the same damage.
    try {
      const current = JSON.parse(await fs.readFile(target, 'utf8')) as SessionSummary;
      if (current?.id === summary.id) {
        const backupTmp = `${backup}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFileDurably(backupTmp, JSON.stringify(current, null, 2));
          stillOwned();
          await fs.rename(backupTmp, backup);
        } finally {
          await fs.rm(backupTmp, { force: true }).catch(() => undefined);
        }
      }
    } catch {
      // First write, or an already damaged primary. Keep any existing valid backup.
    }
    // An external repair can change the private slot during backup/fsync awaits.
    // Never publish a stale whole-summary write over that different fence owner.
    if (JSON.stringify(await nativeCompletionStateOnDisk(summary.id)) !== JSON.stringify(diskFences))
      throw new Error('Session native completion checkpoint changed before durable publication');
    stillOwned();
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function writeMeta(entry: OpenSession): Promise<void> {
  await writeSummary(entry.summary, entry.historySeq);
  // The attachment catalog is also the process-lifetime summary index used by the paged UI.
  // Ordinary event ticks stay in `open` and are overlaid live, but once metadata is actually
  // written keep the cached durable projection current too. Do not rebuild attachment maps:
  // rename/end/token changes do not change conversation ownership.
  publishCachedSummary(entry.summary, false);
  entry.metaDirty = false;
}

/** Private restore read. A present null fence is a durable clear, not legacy absence. */
export async function readSessionNativeCompletionFenceCheckpoint(
  id: string, conversationId: string, profileId: string
): Promise<{ version: 1 | 2; fence: SessionNativeCompletionFence | null;
  clearedFence: SessionNativeCompletionFence | null; clearedAt: number | null;
  observations?: ScopedNativeCompletionObservation[] } | null> {
  assertSessionId(id);
  if (!nativeFenceConversation(conversationId) || !nativeFenceIdentity(profileId)) return null;
  const ownerRoot = root, ownerEpoch = canonicalShardWarningEpoch;
  const stillOwned = (): boolean => root === ownerRoot && canonicalShardWarningEpoch === ownerEpoch;
  const view = (state: NativeCompletionPrivateState, currentConversation: string | null) => {
    if (currentConversation !== conversationId) return null;
    if (state.invalid) throw new Error('Session native completion checkpoint is unreadable');
    const slot = state.checkpoint?.slots[conversationId];
    if (!slot || slot.sessionId !== id || slot.profileId !== profileId) return null;
    return { version: state.checkpoint!.version, fence: slot.fence ? normalizedNativeFence(slot.fence) : null,
      clearedFence: slot.clearedFence ? normalizedNativeFence(slot.clearedFence) : null, clearedAt: slot.clearedAt,
      ...(slot.observations ? { observations: normalizedNativeObservations(slot.observations)! } : {}) };
  };
  // Startup visits the metadata catalog, including old unrelated sessions. Do
  // not hydrate their message shards or make a read own their retention lifetime.
  // Existing hot/reconstruction owners still serialize any concurrent mutation.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!stillOwned()) return null;
    const entry = open.get(id);
    if (entry) return enqueueSessionOperation(entry, 'native completion read', async () => {
      if (!stillOwned() || entry.summary.conversationId !== conversationId) return null;
      if (entry.nativeCompletionFences.invalid) throw new Error('Session native completion checkpoint is unreadable');
      const disk = await nativeCompletionStateOnDisk(id);
      if (!stillOwned() || entry.summary.conversationId !== conversationId) return null;
      if (disk.invalid || JSON.stringify(disk) !== JSON.stringify(entry.nativeCompletionFences))
        throw new Error('Session native completion checkpoint changed or is unreadable');
      return view(entry.nativeCompletionFences, entry.summary.conversationId);
    });
    const restoring = opening.get(id) ?? reconciling.get(id);
    if (restoring) { await restoring; continue; }
    const checkpoint = await readMetaCheckpoint(id);
    if (!stillOwned()) return null;
    if (open.has(id) || opening.has(id) || reconciling.has(id)) continue;
    if (!checkpoint) throw new Error('Session native completion checkpoint metadata is unavailable');
    return view(checkpoint.nativeCompletionFences, checkpoint.summary.conversationId);
  }
  throw new Error('Session native completion owner changed during metadata read; retry after reconciliation');
}

export async function readSessionNativeCompletionFence(
  id: string, conversationId: string, profileId: string
): Promise<SessionNativeCompletionFence | null> {
  return (await readSessionNativeCompletionFenceCheckpoint(id, conversationId, profileId))?.fence ?? null;
}

/** Durable semantic CAS. No source/document rebinding, expiry or completion inference.
 * Clear only after the owner's exact native proof/ACK, retaining the negative checkpoint
 * through that synchronous ACK. A crash before the later clear conservatively restores it;
 * the private clear timestamp/witness is not itself a native result receipt. */
export async function compareAndSetSessionNativeCompletionFence(
  id: string, conversationId: string, profileId: string,
  expected: SessionNativeCompletionFence | null, next: SessionNativeCompletionFence | null,
  observationUpdate?: { expected: ScopedNativeCompletionObservation[]; next: ScopedNativeCompletionObservation[] }
): Promise<boolean> {
  if (!nativeFenceConversation(conversationId) || !nativeFenceIdentity(profileId)) return false;
  // Clone before yielding; later caller mutation cannot alter this admitted operation.
  const original = expected === null ? null : normalizedNativeFence(expected);
  const replacement = next === null ? null : normalizedNativeFence(next);
  if ((expected !== null && !original) || (next !== null && !replacement)) return false;
  const observedBefore = observationUpdate ? normalizedNativeObservations(observationUpdate.expected) : null;
  const observedNext = observationUpdate ? normalizedNativeObservations(observationUpdate.next) : null;
  if (observationUpdate && (!replacement || !observedBefore || !observedNext ||
      observedNext.length < observedBefore.length ||
      JSON.stringify(observedNext.slice(0, observedBefore.length)) !== JSON.stringify(observedBefore) ||
      observedNext.slice(observedBefore.length).some((item, offset) =>
        item.observedAt <= (original ?? replacement!).observedAt ||
        item.sourceUserMessageId === (original ?? replacement!).sourceUserMessageId ||
        item.observedAt < (observedNext[observedBefore.length + offset - 1]?.observedAt ?? 0)))) return false;
  if ([original, replacement].some(value => value &&
      (value.sessionId !== id || value.conversationId !== conversationId || value.profileId !== profileId))) return false;
  if (original && replacement) {
    // Existing identities are immutable. An incomplete census is a stronger
    // negative veto, never a completion or a changed original source. Missing
    // arrays may be enriched only after the caller proved that same scope.
    const arrays = ['openRequestIds', 'coreCallMessageIds', 'allCoreRequestIds',
      'codeCallMessageIds', 'openCodeCallMessageIds'] as const;
    const permitted = { ...original };
    if ((original.reason === 'open-call' || original.reason === 'open-code') &&
        replacement.reason === 'inventory-incomplete') permitted.reason = replacement.reason;
    for (const key of arrays) {
      if (original[key] === null) permitted[key] = replacement[key];
    }
    if (JSON.stringify(permitted) !== JSON.stringify(replacement)) return false;
  }
  const ownerRoot = root, ownerEpoch = canonicalShardWarningEpoch;
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'native completion checkpoint', async () => {
    if (root !== ownerRoot || canonicalShardWarningEpoch !== ownerEpoch ||
        entry.summary.conversationId !== conversationId) return false;
    const currentState = entry.nativeCompletionFences;
    if (currentState.invalid) throw new Error('Session native completion checkpoint is unreadable');
    const current = currentState.checkpoint?.slots[conversationId];
    if (current && (current.profileId !== profileId || current.sessionId !== id)) return false;
    if (JSON.stringify(current?.fence ?? null) !== JSON.stringify(original)) return false;
    if (observationUpdate && JSON.stringify(current?.observations ?? []) !== JSON.stringify(observedBefore)) return false;
    const retiredAt = Math.max(current?.retiredObservedAt ?? 0, current?.clearedFence?.observedAt ?? 0);
    if (replacement && replacement.observedAt <= retiredAt) return false;
    if (!original && !replacement) return true;
    const slots = { ...currentState.checkpoint?.slots };
    if (!current && Object.keys(slots).length >= NATIVE_FENCE_MAX_SLOTS) return false;
    slots[conversationId] = { profileId, sessionId: id, conversationId, fence: replacement,
      retiredObservedAt: replacement ? retiredAt || null : current?.retiredObservedAt ?? null,
      // A newer pending source must not discard the preceding exact clear while
      // its diagnostic resolution may still be queued. Both stay route-bound.
      clearedFence: replacement ? current?.clearedFence ?? null : original,
      clearedAt: replacement ? current?.clearedAt ?? null : Date.now(),
      ...((observedNext ?? current?.observations)?.length ? { observations: observedNext ?? current!.observations! } : {}) };
    if (Object.values(slots).reduce((total, slot) => total + (slot.observations?.length ?? 0), 0) >
        CORE_NATIVE_OBSERVATION_MAX_SCOPES) {
      logWarn('session native completion scoped observations refused: scope capacity exhausted; existing evidence retained');
      return false;
    }
    const version = currentState.checkpoint?.version === 2 || slots[conversationId]!.observations ? 2 : 1;
    const staged: NativeCompletionPrivateState = { checkpoint: { version, slots }, invalid: false };
    if (Buffer.byteLength(JSON.stringify(staged.checkpoint), 'utf8') > NATIVE_FENCE_MAX_BYTES) {
      logWarn('session native completion checkpoint refused: private byte capacity exhausted; existing evidence retained');
      return false;
    }
    await writeSummary(entry.summary, entry.historySeq, staged, currentState);
    if (root !== ownerRoot || canonicalShardWarningEpoch !== ownerEpoch ||
        entry.summary.conversationId !== conversationId) return false;
    entry.nativeCompletionFences = staged;
    entry.metaDirty = false;
    logInfo(`session native completion checkpoint ${replacement ? 'retained' : 'cleared'}; ` +
      `scopedObservations=${slots[conversationId]!.observations?.length ?? 0}; exact identity private, completion not inferred`);
    return true;
  });
}

/** Restore only the exact just-cleared negative witness after a failed final owner check. */
export async function reopenSessionNativeCompletionFence(
  id: string, conversationId: string, profileId: string, cleared: SessionNativeCompletionFence
): Promise<boolean> {
  const original = normalizedNativeFence(cleared);
  if (!original || original.sessionId !== id || original.conversationId !== conversationId || original.profileId !== profileId) return false;
  const ownerRoot = root, ownerEpoch = canonicalShardWarningEpoch;
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'native completion reopen', async () => {
    if (root !== ownerRoot || canonicalShardWarningEpoch !== ownerEpoch ||
        entry.summary.conversationId !== conversationId) return false;
    const previous = entry.nativeCompletionFences;
    if (previous.invalid) throw new Error('Session native completion checkpoint is unreadable');
    const slot = previous.checkpoint?.slots[conversationId];
    if (!slot || slot.profileId !== profileId || slot.fence !== null || slot.clearedAt === null ||
        JSON.stringify(slot.clearedFence) !== JSON.stringify(original)) return false;
    const staged: NativeCompletionPrivateState = { invalid: false, checkpoint: { version: previous.checkpoint!.version,
      slots: { ...previous.checkpoint!.slots, [conversationId]: { ...slot, fence: original,
        clearedFence: null, clearedAt: null } } } };
    await writeSummary(entry.summary, entry.historySeq, staged, previous);
    if (root !== ownerRoot || canonicalShardWarningEpoch !== ownerEpoch) return false;
    entry.nativeCompletionFences = staged;
    entry.metaDirty = false;
    logInfo('session native completion checkpoint reopened; exact retained negative witness only');
    return true;
  });
}

function enqueueSessionOperation<T>(entry: OpenSession, label: string, operation: () => Promise<T>): Promise<T> {
  const work = entry.queue.then(operation);
  entry.queue = work.then(
    () => undefined,
    (err: Error) => logError(`session ${label} failed: ${err.message}`)
  );
  return work;
}

/**
 * The summary is rewritten on a short delay rather than on every event. A long agent
 * session appends thousands of events; rewriting the summary for each one would turn
 * an append-only log into a write-amplified one for no benefit.
 */
function scheduleMeta(entry: OpenSession): void {
  entry.metaDirty = true;
  if (entry.metaTimer) return;
  entry.metaTimer = setTimeout(() => {
    entry.metaTimer = null;
    void enqueueSessionOperation(entry, 'meta write', async () => {
      if (entry.metaDirty) await writeMeta(entry);
    });
  }, 1500);
  entry.metaTimer.unref?.();
}

/** Flushes pending summary writes for shutdown and explicit checkpoints. */
export async function flushSessions(): Promise<void> {
  for (const entry of open.values()) {
    await flushSessionEntry(entry);
  }
}

/**
 * Joins only this session's queued journal/canonical mutations, including an in-flight
 * reconstruction. Ordinary event readers use the live summary and leave scheduleMeta batched.
 */
async function settleSessionWrites(sessionId: string): Promise<OpenSession | undefined> {
  let entry = open.get(sessionId);
  if (!entry) {
    const reconstructing = opening.get(sessionId);
    if (reconstructing) entry = await reconstructing;
  }
  if (entry) await entry.queue;
  return entry;
}

/** Explicit custody/deletion barriers still flush this exact session's summary. */
async function flushSession(sessionId: string): Promise<void> {
  const entry = await settleSessionWrites(sessionId);
  if (entry) await flushSessionEntry(entry);
}

/** Receipt custody barrier used before retiring a separately recorded source.
 * The ordinary high-throughput append is intentionally buffered, so its return
 * alone is not proof the destination JSONL survives process/storage failure.
 * Sync that exact existing journal; an unavailable/unsyncable file fails the
 * transfer and leaves the original Core result available for a later retry. */
export async function syncSessionJournal(sessionId: string): Promise<void> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  const handle = await fs.open(path.join(sessionDir(sessionId), 'events.jsonl'), 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function flushSessionEntry(entry: OpenSession): Promise<void> {
  if (entry.metaTimer) {
    clearTimeout(entry.metaTimer);
    entry.metaTimer = null;
  }
  await enqueueSessionOperation(entry, 'meta flush', async () => {
    if (entry.metaDirty) await writeMeta(entry);
  }).catch(() => undefined);
}

// ----------------------------------------------------------------- create

export async function createSession(options: {
  title?: string;
  titleSource?: SessionSummary['titleSource'];
  conversationId?: string | null;
  origin?: SessionOrigin | null;
}): Promise<SessionSummary> {
  const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const summary = emptySummary(id, options.title?.trim() || 'ChatGPT session', options.conversationId ?? null);
  summary.origin = options.origin ?? null;
  if (options.titleSource) summary.titleSource = options.titleSource;
  if (options.origin?.fromSessionId) {
    const source = await getSession(options.origin.fromSessionId);
    if (source?.projectId) summary.projectId = source.projectId;
  }
  // Invalidate before exposing the in-flight live entry. A cached miss must never hide a
  // session that this process has started creating, even while its first durable write awaits.
  if (summary.conversationId) missingCurrentConversations.delete(summary.conversationId);
  const entry: OpenSession = {
    summary,
    nativeCompletionFences: emptyNativeCompletionState(),
    activeWorkIntervals: [],
    nextSeq: 1,
    historySeq: 0,
    tail: [],
    tailFrom: 1,
    activityHydrated: true,
    queue: Promise.resolve(),
    messages: new Map(),
    metaDirty: false,
    metaTimer: null
  };
  open.set(id, entry);
  try {
    await fs.mkdir(sessionDir(id), { recursive: true });
    await fs.writeFile(path.join(sessionDir(id), 'events.jsonl'), '', { flag: 'a' });
    await fs.writeFile(path.join(sessionDir(id), 'messages.json'), '{}', { flag: 'a' });
    await writeMeta(entry);
    publishAttachmentSummary(entry.summary);
  } catch (error) {
    if (open.get(id) === entry) open.delete(id);
    throw error;
  }
  return { ...summary };
}

// ----------------------------------------------------------------- append

/**
 * Reads the highest seq already on disk, so a restart never reuses a number.
 *
 * Only a proven-absent journal is sequence zero. A transient Windows share lock, exhausted file
 * descriptor table, or unavailable volume must fail the read instead of fabricating an empty
 * history that later recovery could publish over a full session.
 */
async function lastSeqOnDisk(id: string): Promise<number> {
  const file = path.join(sessionDir(id), 'events.jsonl');
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 0;
    throw error;
  }
  // One valid event line may be almost MAX_LINE_BYTES and a crash can leave another
  // almost-full torn line after it. Read enough for both, otherwise the only parseable
  // predecessor can sit outside the tail window and restart would reuse sequence 1.
  const from = Math.max(0, size - (MAX_LINE_BYTES * 2 + 2));
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(size - from);
    await handle.read(buffer, 0, buffer.length, from);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as SessionEvent;
        if (typeof parsed.seq === 'number') return parsed.seq;
      } catch {
        // A torn final line is expected after a crash; keep looking backwards.
      }
    }
  } finally {
    await handle.close();
  }
  // The file is present but has no parseable line: a torn first write or a genuinely empty log.
  return 0;
}

/**
 * Closes off a torn last line before anything is appended after it.
 *
 * A crash mid-append leaves a line with no newline. Appending straight onto it would
 * glue a perfectly good new event onto the wreckage and lose that one too, so the
 * damage is sealed with a newline first: one event lost, which is the promise.
 */
async function sealTornTail(id: string): Promise<void> {
  const file = path.join(sessionDir(id), 'events.jsonl');
  try {
    const stat = await fs.stat(file);
    if (stat.size === 0) return;
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, stat.size - 1);
      if (buffer[0] === 0x0a) return;
    } finally {
      await handle.close();
    }
    await fs.appendFile(file, '\n', 'utf8');
    logWarn(`session ${id}: sealed an unterminated final line before appending`);
  } catch {
    // No file yet, or unreadable: the append will recreate it.
  }
}

/**
 * Diagnostic memory only: every attempt still reads and validates the current bytes.
 * Hashes/error codes stay private; no message content or filesystem exception text is logged.
 */
function warnUnreadableCanonicalShard(
  id: string, file: string, name: string, raw: Buffer | undefined, error: unknown, epoch: number
): void {
  if (epoch !== canonicalShardWarningEpoch) return;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const failure = raw
    ? 'bytes:' + createHash('sha256').update(raw).digest('hex')
    : 'read:' + (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN');
  const now = Date.now(), previous = unreadableCanonicalShardWarnings.get(file);
  const report = !previous || previous.failure !== failure ||
    now < previous.reportedAt || now - previous.reportedAt >= CANONICAL_SHARD_WARNING_INTERVAL_MS;
  unreadableCanonicalShardWarnings.delete(file);
  unreadableCanonicalShardWarnings.set(file, { failure, reportedAt: report ? now : previous!.reportedAt });
  while (unreadableCanonicalShardWarnings.size > MAX_CANONICAL_SHARD_WARNINGS)
    unreadableCanonicalShardWarnings.delete(unreadableCanonicalShardWarnings.keys().next().value!);
  if (report) logWarn(
    'session ' + id + ': ignored unreadable canonical message shard ' + name + '; existing history retained, shard unchanged'
  );
}


/** Canonical message snapshot file. Unknown/legacy shapes are ignored, never guessed. */
async function readCanonicalMessages(id: string, aliasesCollapsed?: () => void): Promise<Map<string, CanonicalEvent>> {
  const warningEpoch = canonicalShardWarningEpoch;
  const out = new Map<string, CanonicalEvent>();
  try {
    const raw = await fs.readFile(path.join(sessionDir(id), 'messages.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const event = value as CanonicalEvent;
      if ((event.kind !== 'user_message' && event.kind !== 'assistant_message' && event.kind !== 'tool_call') || typeof event.seq !== 'number') continue;
      const expected = messageKey(event);
      if (!expected || expected !== key) continue;
      out.set(key, event);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn(`session ${id}: canonical message file unreadable; legacy event log remains available`);
    }
  }
  // Incremental shards overlay the legacy whole-map snapshot. This makes migration lazy:
  // the first post-upgrade revision writes only its own logical message, while untouched
  // history remains readable from messages.json.
  const shards = path.join(sessionDir(id), 'messages');
  try {
    const names = (await fs.readdir(shards)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
    // Reading thousands of tiny shards serially made the one-time correlation migration spend
    // tens of seconds in Windows filesystem latency. Eight bounded reads overlap that latency
    // without opening every shard file at once or changing validation/publication order.
    for (let offset = 0; offset < names.length; offset += CANONICAL_SHARD_READ_CONCURRENCY) {
      const batch = await Promise.all(names.slice(offset, offset + CANONICAL_SHARD_READ_CONCURRENCY).map(async (name) => {
        const file = path.join(shards, name);
        let raw: Buffer | undefined;
        try {
          raw = await fs.readFile(file);
          const text = raw.toString('utf8');
          if (Buffer.byteLength(text, 'utf8') > MAX_CANONICAL_MESSAGE_BYTES) return null;
          const event = JSON.parse(text) as CanonicalEvent;
          const key = messageKey(event);
          if (!key) return null;
          const expectedName = `${createHash('sha256').update(key).digest('hex')}.json`;
          if (expectedName !== name) return null;
          if (warningEpoch === canonicalShardWarningEpoch) unreadableCanonicalShardWarnings.delete(file);
          return [key, event] as const;
        } catch (error) {
          warnUnreadableCanonicalShard(id, file, name, raw, error, warningEpoch);
          return null;
        }
      }));
      for (const entry of batch) {
        if (entry) out.set(entry[0], entry[1]);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logWarn(`session ${id}: canonical message shards unreadable`);
  }
  // Older builds persisted reload timestamp aliases as separate shards. Project
  // those exact provider UUIDs as one message without deleting forensic history.
  // First observation owns chronology; the latest terminal revision owns content.
  const providers = new Map<string, Array<[string, Extract<MessageEvent, { kind: 'assistant_message' }>]>>();
  for (const [key, event] of [...out].sort(([, a], [, b]) => (a.origin ?? a.seq) - (b.origin ?? b.seq))) {
    if (event.kind !== 'assistant_message' || !event.providerMessageId) continue;
    const group = providers.get(event.providerMessageId) ?? [];
    group.push([key, event]);
    providers.set(event.providerMessageId, group);
  }
  for (const group of providers.values()) {
    if (group.length < 2) continue;
    aliasesCollapsed?.();
    const [firstKey, first] = group[0]!;
    // Keep the winning content's own seq intact until selection finishes: a later
    // streaming alias advances the read cursor but must not outrank a terminal revision.
    let latest = first, seq = first.seq;
    for (const [key, event] of group) {
      const latestFinal = latest.final === true || latest.state === 'final';
      const eventFinal = event.final === true || event.state === 'final';
      if (latestFinal !== eventFinal ? eventFinal : event.seq > latest.seq) latest = event;
      seq = Math.max(seq, event.seq);
      out.delete(key);
    }
    const associations = new Set(group.map(([, event]) => event.inputReplyTo).filter((value): value is string => !!value));
    // Conflicting legacy aliases cannot inherit either question's positive custody proof.
    const { inputReplyTo: _association, ...latestWithoutAssociation } = latest;
    out.set(firstKey, { ...latestWithoutAssociation, messageId: first.messageId, origin: first.origin ?? first.seq,
      time: first.time, seq, turnId: group.find(([, event]) => event.turnId)?.[1].turnId,
      ...(associations.size === 1 ? { inputReplyTo: [...associations][0] } : {}),
      ...(group.some(([, event]) => event.inputAssociationPending === true) &&
          !(associations.size === 1 && group.some(([, event]) => event.inputReplyTo && event.inputAssociationPending === false))
        ? { inputAssociationPending: true } : {}),
      ...(associations.size > 1 ? { goalEligible: false }
        : group.some(([, event]) => event.goalEligible === true) ? { goalEligible: true } : {}) });
  }
  return out;
}

async function writeCanonicalMessage(id: string, key: string, event: CanonicalEvent): Promise<void> {
  const dir = path.join(sessionDir(id), 'messages');
  await fs.mkdir(dir, { recursive: true });
  const name = `${createHash('sha256').update(key).digest('hex')}.json`;
  const target = path.join(dir, name);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const text = JSON.stringify(event);
  if (Buffer.byteLength(text, 'utf8') > MAX_CANONICAL_MESSAGE_BYTES) {
    throw new Error('Canonical message is too large');
  }
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Explicit slow-path reconstruction from the durable journal plus canonical message shards.
 *
 * A stale metadata checkpoint cannot be patched incrementally for canonical revisions: the
 * shard contains only the newest body, so the token weight of the superseded revision is gone.
 * Rebuild the history-derived projection exactly, then preserve metadata-only facts (title,
 * attachment lineage, compaction latch, close state) from the last valid checkpoint.
 */
async function rebuildSummaryFromHistory(
  id: string,
  messages: Map<string, CanonicalEvent>,
  checkpoint: SessionSummary | null,
  historySeq: number,
  preserveAttachmentTurn = false,
  migrateTokenEstimate = false
): Promise<{ summary: SessionSummary; activeWorkIntervals: ActiveWorkInterval[] }> {
  const rebuilt = emptySummary(id, 'Recovered session', null);
  const activeWorkIntervals: ActiveWorkInterval[] = [];
  let sawProjected = false;
  let historicalReturnReduction = 0;
  const canonicalKeys = new Set(messages.keys());
  let carry = Buffer.alloc(0);
  const handle = await fs.open(path.join(sessionDir(id), 'events.jsonl'), 'r').catch(() => null);
  const accept = (line: Buffer): void => {
    if (line.length === 0 || line.length > MAX_LINE_BYTES) return;
    try {
      const event = JSON.parse(line.toString('utf8')) as SessionEvent;
      if (!event || typeof event.seq !== 'number' || typeof event.kind !== 'string') return;
      // Once a stable website message has a canonical shard, any old append-only snapshot with
      // the same identity is legacy storage for that same logical event, not another event.
      if (
        messageKey(event) &&
        canonicalKeys.has(messageKey(event)!)
      ) {
        return;
      }
      if (!sawProjected) {
        rebuilt.startedAt = event.time;
        rebuilt.updatedAt = event.time;
      }
      if (!sawProjected && event.kind === 'session_start') rebuilt.title = event.title || rebuilt.title;
      const eventConversation = 'conversationId' in event && typeof event.conversationId === 'string' ? event.conversationId : null;
      if (eventConversation) {
        rebuilt.conversationId = eventConversation;
        if (!rebuilt.chatIds.includes(eventConversation)) rebuilt.chatIds.push(eventConversation);
      }
      // Rebind already removed old frontends from current context. During estimation
      // migration, their return reductions belong only to the lifetime total.
      if (migrateTokenEstimate && event.kind === 'tool_call' && checkpoint?.conversationId &&
          event.call.conversationId && event.call.conversationId !== checkpoint.conversationId) {
        historicalReturnReduction += Math.max(0, storedTextTokens(event.call.result) - MAX_TOOL_RESULT_TOKENS);
      }
      applyToSummary(rebuilt, event, activeWorkIntervals);
      sawProjected = true;
    } catch {
      // A torn or corrupt line costs that line, not the complete session projection.
    }
  };
  try {
    if (handle) {
      const chunk = Buffer.alloc(64 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        let joined = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        let start = 0;
        for (;;) {
          const newline = joined.indexOf(0x0a, start);
          if (newline < 0) break;
          accept(joined.subarray(start, newline));
          start = newline + 1;
        }
        carry = joined.subarray(start);
        if (carry.length > MAX_LINE_BYTES) carry = Buffer.alloc(0);
      }
      accept(carry);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  for (const message of [...messages.values()].sort((left, right) => left.seq - right.seq)) {
    if (!sawProjected) {
      rebuilt.startedAt = message.time;
      rebuilt.updatedAt = message.time;
    }
    applyToSummary(rebuilt, message, activeWorkIntervals);
    sawProjected = true;
  }
  if (!sawProjected) {
    throw new Error(`Session ${id} has no recoverable metadata or history`);
  }

  const summary = checkpoint
    ? {
        ...checkpoint,
        updatedAt: Math.max(checkpoint.updatedAt, rebuilt.updatedAt),
        events: rebuilt.events,
        userMessages: rebuilt.userMessages,
        toolCalls: rebuilt.toolCalls,
        fileEdits: rebuilt.fileEdits,
        linesAdded: rebuilt.linesAdded,
        linesRemoved: rebuilt.linesRemoved,
        approximateFileChanges: rebuilt.approximateFileChanges,
        lastToolCallAt: rebuilt.lastToolCallAt,
        activeWorkMs: rebuilt.activeWorkMs,
        activeWorkMeasurement: rebuilt.activeWorkMeasurement,
        lastMessageAt: rebuilt.lastMessageAt,
        lastAssistantFinalAt: rebuilt.lastAssistantFinalAt,
        lastTurnEndAt: rebuilt.lastTurnEndAt,
        lastFinishReportAt: rebuilt.lastFinishReportAt,
        processExitNonzero: rebuilt.processExitNonzero,
        toolRejected: rebuilt.toolRejected,
        toolInternalErrors: rebuilt.toolInternalErrors,
        errors: rebuilt.errors,
        estimatedTokens: rebuilt.estimatedTokens,
        // `contextTokens` may have been reset by a durable rebind, which is metadata-only and
        // therefore cannot be reconstructed from the event log. Every history mutation changes
        // lifetime/context token totals by the same delta, so applying the rebuilt lifetime delta
        // to the checkpoint preserves that reset while still recovering message revisions exactly.
        contextTokens: Math.max(0, checkpoint.contextTokens + (rebuilt.estimatedTokens - checkpoint.estimatedTokens) + historicalReturnReduction),
        lastHandoffId: rebuilt.lastHandoffId,
        lastHandoffAt: rebuilt.lastHandoffAt,
        lastTurnOutcome: rebuilt.lastTurnOutcome,
        activeTurnId: preserveAttachmentTurn ? checkpoint.activeTurnId ?? null : rebuilt.activeTurnId ?? null,
        finishTurn: rebuilt.finishTurn?.conversationId === checkpoint.conversationId ? rebuilt.finishTurn : null,
        agents: [...new Set([...checkpoint.agents, ...rebuilt.agents])]
      }
    : rebuilt;
  logWarn(`session ${id}: rebuilt metadata from durable event/message history`);
  await writeSummary(summary, historySeq);
  return { summary, activeWorkIntervals };
}

/**
 * Reads the durable source of truth without making the session live.
 *
 * `meta.json` is a projection and can legitimately lag the journal or a canonical message
 * shard after a crash. Read-only callers still need the repaired projection, but routing them
 * through `ensureOpen()` would change lifetime semantics: merely viewing old history would put
 * it in `open` and make retention skip it. This helper performs the same high-water recovery
 * while leaving `open` untouched.
 */
async function readDurableSnapshot(id: string): Promise<DurableSessionSnapshot | null> {
  assertSessionId(id);
  const existing = reconciling.get(id);
  if (existing) return existing;
  const work = (async () => {
    let aliasesCollapsed = false;
    const messages = await readCanonicalMessages(id, () => { aliasesCollapsed = true; });
    let messageSeq = 0;
    for (const event of messages.values()) messageSeq = Math.max(messageSeq, event.seq);
    const journalSeq = await lastSeqOnDisk(id);
    const historySeq = Math.max(journalSeq, messageSeq);
    const checkpoint = await readMetaCheckpoint(id);
    const titleRepaired = checkpoint ? refreshUserTitle(checkpoint.summary, messages.values()) : false;

    // A pre-taxonomy checkpoint can have a current watermark but stale outcome classification.
    if (
      checkpoint?.historySeq === historySeq &&
      checkpoint.tokenEstimateCurrent &&
      (!aliasesCollapsed || checkpoint.canonicalProjectionCurrent) &&
      !checkpoint.outcomeCountersMissing &&
      !checkpoint.activityBoundaryMissing &&
      !checkpoint.fileChangeProjectionMissing &&
      !checkpoint.activeWorkProjectionMissing &&
      checkpoint.summary.finishTurn !== undefined
    ) {
      // A successful no-op migration is still a completed migration. Without this stamp,
      // every launch rereads all old transcripts that happened to contain no aliases.
      const migrated = !checkpoint.canonicalProjectionCurrent || titleRepaired;
      if (migrated) await writeSummary(checkpoint.summary, historySeq);
      return { summary: checkpoint.summary, messages, historySeq, reconciled: migrated };
    }
    if (checkpoint && historySeq === 0) {
      // Nothing to replay: stamp the empty legacy projection in place.
      const summary = {
        ...checkpoint.summary,
        ...(checkpoint.outcomeCountersMissing ? { errors: 0 } : {}),
        lastToolCallAt: null,
        activeWorkMs: 0,
        activeWorkMeasurement: 'unknown' as const,
        lastMessageAt: null,
        lastAssistantFinalAt: null,
        lastTurnEndAt: null,
        lastFinishReportAt: null,
        finishTurn: null
      };
      await writeSummary(summary, 0);
      return { summary, messages, historySeq: 0, reconciled: true, activeWorkIntervals: [] };
    }
    if (!checkpoint && historySeq === 0) return null;

    const rebuilt = await rebuildSummaryFromHistory(id, messages, checkpoint?.summary ?? null, historySeq, checkpoint?.historySeq === historySeq, !!checkpoint && !checkpoint.tokenEstimateCurrent);
    return { ...rebuilt, messages, historySeq, reconciled: true };
  })();
  reconciling.set(id, work);
  try {
    return await work;
  } finally {
    if (reconciling.get(id) === work) reconciling.delete(id);
  }
}

async function readAuthoritativeSummary(id: string): Promise<SessionSummary | null> {
  const live = open.get(id);
  if (live) return live.summary;
  const becomingLive = opening.get(id);
  if (becomingLive) return (await becomingLive).summary;
  const snapshot = await readDurableSnapshot(id);
  if (!snapshot) return null;
  // If a process-lifetime catalog already exists, or one is concurrently being built and may
  // already have passed this row, invalidate/update it after a recovery write. The catalog's own
  // build calls readDurableSnapshot directly, so its normal stale-row repairs do not self-loop.
  if (snapshot.reconciled && (attachmentCatalog || attachmentCatalogLoading)) {
    publishAttachmentSummary(snapshot.summary);
  }
  return snapshot.summary;
}

async function ensureOpen(id: string): Promise<OpenSession> {
  assertSessionId(id);
  const existing = open.get(id);
  if (existing) return existing;
  const inFlight = opening.get(id);
  if (inFlight) return inFlight;
  const reconstruction = (async () => {
    await sealTornTail(id);
    const snapshot = await readDurableSnapshot(id);
    if (!snapshot) throw new Error(`Session ${id} has no recoverable metadata or history`);
    const activeWorkIntervals = snapshot.activeWorkIntervals ??
      await readActiveWorkIntervalsFromHistory(id, snapshot.messages);
    const activeWorkMs = activeWorkDuration(activeWorkIntervals);
    const activeWorkMeasurement = activeWorkIntervals.length > 0 ? 'partial' as const : 'unknown' as const;
    const activeWorkReconciled = snapshot.summary.activeWorkMs !== activeWorkMs ||
      snapshot.summary.activeWorkMeasurement !== activeWorkMeasurement;
    if (activeWorkReconciled) {
      snapshot.summary.activeWorkMs = activeWorkMs;
      snapshot.summary.activeWorkMeasurement = activeWorkMeasurement;
    }
    const entry: OpenSession = {
      summary: snapshot.summary,
      nativeCompletionFences: (await readMetaCheckpoint(id))?.nativeCompletionFences ?? emptyNativeCompletionState(),
      activeWorkIntervals,
      nextSeq: snapshot.historySeq + 1,
      historySeq: snapshot.historySeq,
      tail: [],
      tailFrom: snapshot.historySeq + 1,
      activityHydrated: false,
      queue: Promise.resolve(),
      messages: snapshot.messages,
      metaDirty: activeWorkReconciled,
      metaTimer: null
    };
    open.set(id, entry);
    if (activeWorkReconciled) scheduleMeta(entry);
    if (snapshot.reconciled && (attachmentCatalog || attachmentCatalogLoading)) {
      publishAttachmentSummary(entry.summary);
    }
    return entry;
  })();
  opening.set(id, reconstruction);
  try {
    return await reconstruction;
  } finally {
    if (opening.get(id) === reconstruction) opening.delete(id);
  }
}

/** A hold-call result or app status is not evidence of new work. */
function noteFinishWork(summary: SessionSummary, event: SessionEvent): void {
  if (!summary.finishTurn || (event.turnId && event.turnId !== summary.finishTurn.turnId)) return;
  const meaningful = event.kind === 'user_message' || event.kind === 'assistant_message' ||
    (event.kind === 'progress' && event.source !== 'app') ||
    (event.kind === 'tool_call' && !['keep_astra_on_forever', 'session_finish'].includes(event.call.tool));
  if (meaningful) summary.finishTurn = { ...summary.finishTurn, workSeq: Math.max(summary.finishTurn.workSeq,
    workSequence(event)) };
}

function applyToSummary(summary: SessionSummary, event: SessionEvent, activeWorkIntervals: ActiveWorkInterval[]): void {
  summary.events += 1;
  // Never backwards. A tool call is written once the app knows which chat it belongs to,
  // which can be after the page has already reported the end of the turn it ran in, and
  // the call carries the time it started. Taking that literally would age a session back
  // to before its own last event and drop it down a list sorted by recency.
  summary.updatedAt = Math.max(summary.updatedAt, event.time);
  const tokens = eventTokens(event);
  summary.estimatedTokens += tokens;
  // What the attached chat is carrying. Reset by a compaction rebind; see rebindSession.
  summary.contextTokens += tokens;
  if (event.kind === 'user_message') summary.userMessages += 1;
  if (event.kind === 'user_message' || event.kind === 'assistant_message') {
    summary.lastMessageAt = Math.max(summary.lastMessageAt ?? 0, event.time);
  }
  if (event.kind === 'tool_call') {
    summary.toolCalls += 1;
    // File changes are evidence emitted by the tool owner. Count entries rather than claiming
    // unique files: one path may be edited several times during a long task, and each recorded
    // edit contributes real churn to the session's review summary.
    for (const change of event.call.changes ?? []) {
      summary.fileEdits += 1;
      summary.linesAdded += Math.max(0, Number.isFinite(change.added) ? change.added : 0);
      summary.linesRemoved += Math.max(0, Number.isFinite(change.removed) ? change.removed : 0);
      summary.approximateFileChanges ||= change.approximate === true;
    }
    if ((event.call.changes?.length ?? 0) > 0) {
      // Tool events retain their start time for transcript chronology. The file-change proof
      // timer is about when the mutation finished, so advance by the recorded duration.
      const completedAt = event.time + Math.max(0, event.call.durationMs ?? 0);
      summary.lastFileChangeAt = Math.max(summary.lastFileChangeAt ?? 0, completedAt);
    }
    summary.lastToolCallAt = Math.max(summary.lastToolCallAt ?? 0, event.time);
    if (event.call.endsActivity === true) {
      summary.lastFinishReportAt = Math.max(summary.lastFinishReportAt ?? 0, event.time);
    }
    const outcome = normalizedToolOutcome(event.call);
    if (outcome === 'process_exit_nonzero') summary.processExitNonzero += 1;
    if (outcome === 'tool_rejected') summary.toolRejected += 1;
    if (outcome === 'tool_internal_error') {
      summary.toolInternalErrors += 1;
      summary.errors += 1;
    }
  }
  if (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')) {
    summary.lastAssistantFinalAt = Math.max(summary.lastAssistantFinalAt ?? 0, event.time);
  }
  if (event.kind === 'chat_error') summary.errors += 1;
  if (event.kind === 'turn_end') {
    summary.lastTurnOutcome = event.outcome;
    summary.lastTurnEndAt = Math.max(summary.lastTurnEndAt ?? 0, event.time);
  }
  if (event.kind === 'turn_start') {
    summary.activeTurnId = event.turnId ?? `seq-${event.seq}`;
    if (summary.finishTurn?.turnId !== summary.activeTurnId) summary.finishTurn = {
      turnId: summary.activeTurnId, conversationId: summary.conversationId, startedAt: event.time,
      notified: false, released: false, decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null
    };
  }
  applyActiveWork(summary, event, activeWorkIntervals);
  if (event.kind === 'progress' && event.source === 'app' && event.turnId && summary.finishTurn?.turnId === event.turnId) {
    const finish = { ...summary.finishTurn };
    summary.finishTurn = finish;
    // IDs cover already-shipped event rows; new rows additionally carry typed control.
    if (event.progressId === `finish:${event.turnId}` || event.finishControl?.state === 'notified') finish.notified = true;
    const prefix = `finish-goal:${event.turnId}:`;
    const revision = event.finishControl?.state === 'decision' ? event.finishControl.revision
      : event.progressId?.startsWith(prefix) ? event.progressId.slice(prefix.length) : null;
    if (revision && /^[a-f0-9]{64}$/.test(revision) && finish.decisionRevision !== revision) {
      finish.decisionRevision = revision;
      finish.decisionAt = event.time;
      finish.decisionSeq = Number.isSafeInteger(event.finishControl?.workSeq) ? event.finishControl!.workSeq! : event.seq;
      finish.decisionInputRevision = event.finishControl?.inputRevision ?? null;
    } else if (revision === finish.decisionRevision && event.finishControl?.state === 'decision' && Number.isSafeInteger(event.finishControl.workSeq)) {
      finish.decisionSeq = Math.max(finish.decisionSeq, event.finishControl.workSeq!);
    }
    if (event.finishControl) finish.conversationId = event.finishControl.conversationId;
    if (event.finishControl?.state === 'released') finish.released = true;
  }
  noteFinishWork(summary, event);
  if (event.kind === 'turn_end' && (!event.turnId || summary.activeTurnId === event.turnId)) summary.activeTurnId = null;
  if (event.kind === 'handoff') {
    summary.lastHandoffId = event.handoffId;
    summary.lastHandoffAt = event.time;
  }
  if (event.agent && !summary.agents.includes(event.agent)) summary.agents.push(event.agent);
}

/**
 * Whether this chat is over its automatic-compaction line.
 *
 * A level, and deliberately not the edge this used to be. The edge version armed on the
 * below-to-above crossing and then waited for that turn to end cleanly, which had two
 * consequences the design never wanted: a single interrupted turn destroyed the trigger
 * forever (a counter that only grows never crosses the same line twice), and every
 * compaction it did manage to fire landed *after* the model had finished answering — the
 * one moment where a handoff is pointless, because the work it would carry across is
 * already done.
 *
 * So this half of the rule is just "over the line". The other half — that
 * the model is working *right now* — is a fact about the open browser connection rather
 * than about the recording, so it is asked at the point of use, in bridge.ts. That is what
 * keeps a stale 500k chat quiet when it is merely opened: it is over the line all day, and
 * nothing is running in it. The existing continuation transaction is the durable authority
 * once a stopped/settled chat asks for its handoff prompt; pre-barrier refusal owns no durable
 * state and may be attempted by a later generation.
 */
export function automaticCompactionAllowed(_summary?: SessionSummary | null): boolean {
  return getConfig().compaction.auto;
}

export function autoCompactionReady(summary: SessionSummary | null | undefined): boolean {
  if (!summary) return false;
  const refusal = summary.autoCompactionRefusal;
  if (refusal?.conversationId === summary.conversationId &&
      (!summary.activeTurnId || summary.activeTurnId === refusal.turnId)) return false;
  const config = getConfig().compaction;
  return automaticCompactionAllowed(summary) && config.autoTokens > 0 && summary.contextTokens >= config.autoTokens;
}

/** Persist eligibility before retiring the ticket, so a restart cannot refile the refused turn. */
export async function refuseAutomaticCompactionNow(id: string, conversationId: string, turnId: string | null,
  expectedHistorySeq?: number): Promise<void> {
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'automatic compaction refusal', async () => {
    if (entry.summary.conversationId !== conversationId ||
        (entry.summary.activeTurnId && entry.summary.activeTurnId !== turnId)) return;
    // A late legacy repair may have proved an ended source turn from its journal. A newer
    // turn can start AND end while that read yields, leaving activeTurnId null again. The
    // existing monotonic storage revision is only a staleness veto, never identity proof.
    if (expectedHistorySeq !== undefined && (!Number.isSafeInteger(expectedHistorySeq) ||
        expectedHistorySeq < 1 || entry.historySeq !== expectedHistorySeq)) return;
    const staged = { ...entry.summary, autoCompactionRefusal: { conversationId, turnId } };
    await writeSummary(staged, entry.historySeq);
    entry.summary = staged;
    publishAttachmentSummary(staged);
  });
}

/**
 * Appends one event and returns it with its assigned sequence number.
 *
 * The sequence number, not the timestamp, defines order: the extension and the MCP
 * server both feed this store and their clocks are the same clock, but events can
 * arrive out of order when the browser batches its observations.
 */
async function appendEventQueued(
  sessionId: string,
  event: NewSessionEvent,
  current?: SessionAppendPredicate
): Promise<SessionEvent | null> {
  const entry = await ensureOpen(sessionId);
  return enqueueSessionOperation(entry, 'append', async () => {
    if (current) {
      const accepted = await current({
        activeTurnId: entry.summary.activeTurnId ?? null,
        lastTurnOutcome: entry.summary.lastTurnOutcome,
        readRecentEvents: (limit, options = {}) =>
          readRecentEventsFromDisk(sessionId, limit, options)
      });
      if (!accepted) return null;
    }
    // Sequence assignment, durable append and projection update are one serial operation.
    // The previous implementation incremented nextSeq and mutated the summary *before* the
    // append succeeded. A disk failure therefore created a permanent seq gap and could even
    // persist meta.json claiming events/tool calls/tokens that never existed in events.jsonl.
    // Keep the append-only journal authoritative: nothing in memory advances until the line
    // is on disk.
    const full = { ...event, seq: entry.nextSeq } as SessionEvent;
    const line = `${JSON.stringify(full)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      throw new Error('Session event is too large to store');
    }
    try {
      await fs.appendFile(path.join(sessionDir(sessionId), 'events.jsonl'), line, 'utf8');
    } catch (error) {
      // Windows/filesystem errors are allowed to be uncertain commits: the write may have
      // reached disk before the promise rejected. Reconcile the authoritative tail before
      // another queued writer is admitted. A complete line is treated as committed; a torn
      // line is sealed and the normal browser/MCP retry may safely reuse that absent seq.
      await sealTornTail(sessionId);
      // Do not replace the original append failure with a second reconciliation read failure.
      // Zero is safe only here: Math.max cannot move the in-memory sequence backwards.
      const durableSeq = await lastSeqOnDisk(sessionId).catch(() => 0);
      if (durableSeq < full.seq) {
        entry.nextSeq = Math.max(entry.nextSeq, durableSeq + 1);
        throw error;
      }
      logWarn(`session ${sessionId}: append reported an error after sequence ${full.seq} was already durable`);
    }
    entry.nextSeq += 1;
    entry.tail.push(full);
    if (entry.tail.length > MAX_EVENT_TAIL) {
      const removed = entry.tail.splice(0, entry.tail.length - MAX_EVENT_TAIL);
      entry.tailFrom = removed[removed.length - 1]!.seq + 1;
    }
    applyToSummary(entry.summary, full, entry.activeWorkIntervals);
    entry.historySeq = full.seq;
    scheduleMeta(entry);
    return full;
  });
}

export function appendEvent(sessionId: string, event: NewSessionEvent): Promise<SessionEvent> {
  return appendEventQueued(sessionId, event) as Promise<SessionEvent>;
}

/** Appends only while a caller-owned condition still holds at this session's serial write point. */
export function appendEventIfCurrent(
  sessionId: string,
  event: NewSessionEvent,
  current: SessionAppendPredicate
): Promise<SessionEvent | null> {
  return appendEventQueued(sessionId, event, current);
}

/**
 * Creates or revises one canonical ChatGPT message by its own stable id.
 *
 * `seq` is the revision/cursor sequence so an incremental reader notices an update. `origin`
 * preserves the sequence/time position where that stable website message first appeared, so
 * revisions cannot move either a user response boundary or assistant prose through later work.
 */
export function upsertMessageEvent(
  sessionId: string,
  event: NewMessageEvent,
  options: { preferTime?: boolean; sparseGoalReceipt?: boolean } = {}
): Promise<{ event: MessageEvent; changed: boolean; contentChanged: boolean }> {
  const directKey = messageKey(event as MessageEvent);
  if (!directKey) throw new Error('Canonical message update requires ChatGPT messageId');
  return ensureOpen(sessionId).then((entry) => {
    const write = entry.queue.then(async () => {
      const appOwnedUserReceipt = event.kind === 'user_message' && event.source === 'app';
      const unverifiedNativeOwnerClaim = event.kind === 'user_message' && event.source !== 'app' &&
        (event.inputId !== undefined || event.inputDelivery !== undefined ||
          event.automationOrigin !== undefined || event.authoredText !== undefined ||
          event.preparedDeliverySha256 !== undefined || event.inputProvenance !== undefined);
      if (event.kind === 'user_message' && event.source === 'app' && event.inputProvenance !== undefined) {
        const proof = event.inputProvenance;
        if (!proof || proof.version !== 1 || !['human', 'automation'].includes(proof.authorship) ||
            proof.sessionId !== sessionId || !entry.summary.chatIds.includes(proof.conversationId) ||
            !proof.inputId || proof.inputId !== event.inputId || !proof.nativeMessageId ||
            proof.nativeMessageId !== event.messageId || proof.nativeMessageId.startsWith('input:') ||
            event.inputDelivery !== 'confirmed' || !Number.isFinite(proof.deliveredAt) || proof.deliveredAt < 0 ||
            typeof event.authoredText !== 'string' ||
            proof.authoredSha256 !== createHash('sha256').update(event.authoredText).digest('hex') ||
            !/^[a-f0-9]{64}$/.test(proof.preparedSha256) || proof.preparedSha256 !== event.preparedDeliverySha256 ||
            (proof.authorship === 'human' && event.automationOrigin !== undefined))
          throw new Error('Canonical Input provenance conflicts with its exact owned native receipt');
      }
      if (event.kind === 'user_message' && event.preparedDeliverySha256 !== undefined) {
        if (event.source !== 'app') {
          // Native/provider observations can describe what ChatGPT rendered,
          // not the bytes Main prepared or which selected Skills it read.
          // Drop this app-only custody field even on an ORIGINAL echo that
          // arrives before native ACK; it must never poison a later real owner.
          event = { ...event, preparedDeliverySha256: undefined };
        } else if (!/^[a-f0-9]{64}$/.test(event.preparedDeliverySha256) ||
                   createHash('sha256').update(event.message.text).digest('hex') !== event.preparedDeliverySha256) {
          throw new Error('Canonical prepared delivery witness does not match app-authored native bytes');
        }
      }
      // Provider text may precede Main's native ACK. Only Main can claim the
      // original Input, human correction, automatic origin or delivered state.
      // Keep the genuine observed body and provider identity independent.
      if (event.kind === 'user_message' && event.source !== 'app')
        event = { ...event, inputId: undefined, authoredText: undefined, automationOrigin: undefined,
          inputDelivery: undefined, inputProvenance: undefined,
          unverifiedAuthorshipClaim: unverifiedNativeOwnerClaim ? true : undefined };
      // The merger below preserves stronger provider body evidence, while the
      // valid later app ACK attaches its independently prepared instructions.
      const appPreparedDeliverySha256 = event.kind === 'user_message' && event.source === 'app'
        ? event.preparedDeliverySha256 : undefined;
      const appInputProvenance = event.kind === 'user_message' && event.source === 'app'
        ? event.inputProvenance : undefined;
      // Provider create_time can change after a tab reload while the actual message
      // UUID stays identical. Preserve the first canonical anchor on that exact
      // evidence; never collapse distinct authored segments by working-turn tuple
      // or matching text. Legacy observations without a provider UUID keep their key.
      const providerMessageId = event.kind === 'assistant_message' ? event.providerMessageId : undefined;
      const providerMatches = providerMessageId
        ? [...entry.messages.entries()].filter(([, candidate]) => candidate.kind === 'assistant_message' &&
            candidate.providerMessageId === providerMessageId)
        : [];
      const key = !entry.messages.has(directKey) && providerMatches.length === 1 ? providerMatches[0]![0] : directKey;
      const candidate = entry.messages.get(key);
      const previous = candidate?.kind === 'tool_call' ? undefined : candidate;
      const sameGeneratedInput = previous?.kind === 'user_message' && event.kind === 'user_message' &&
        previous.automationOrigin === 'goal' && event.automationOrigin === 'goal' &&
        !!previous.inputId && previous.inputId === event.inputId &&
        previous.inputDelivery === 'confirmed' && event.inputDelivery === 'confirmed';
      if (previous?.kind === 'user_message' && event.kind === 'user_message' &&
          event.source === 'extension' && previous.inputDelivery === 'confirmed' &&
          (!!previous.inputId || !!previous.automationOrigin)) {
        // The browser may revise the provider OBSERVATION under the exact native
        // UUID. It has no authority to replace Main's original human/automatic
        // owner, receipt classification or frozen instruction bytes, even when
        // its transport adapter happens to attach stale outbox-like metadata.
        event = { ...event, inputId: undefined, authoredText: undefined,
          automationOrigin: undefined, inputDelivery: undefined,
          preparedDeliverySha256: undefined };
      }
      if (previous?.kind === 'user_message' && event.kind === 'user_message' && event.source === 'app') {
        // One stable native message belongs to one actual app-authored Send.
        // A resumed Input, late Goal ACK or different outbox row cannot steal
        // the provider UUID and thereby impersonate a human correction or
        // convert an app continuation into human authority. Native page echoes
        // do not assert new app ownership and may still enrich this message.
        const differentInput = !!previous.inputId && !!event.inputId && previous.inputId !== event.inputId;
        const changedInputProvenance = !!previous.inputProvenance && !!event.inputProvenance &&
          !inputProvenanceEqual(previous.inputProvenance, event.inputProvenance);
        const differentGoal = event.automationOrigin === 'goal' &&
          ((!!previous.inputId && !sameGeneratedInput) || (!!previous.automationOrigin && previous.automationOrigin !== 'goal'));
        const differentAppInput = !!event.inputId &&
          ((previous.automationOrigin === 'goal' && !sameGeneratedInput) ||
            (!!previous.automationOrigin && !!event.automationOrigin &&
              previous.automationOrigin !== event.automationOrigin));
        // One native Goal message cannot carry two different *locally prepared*
        // instruction bodies. Genuine provider revisions only change message.text
        // and cannot rewrite this original ACKed payload. A duplicate with an
        // identical authoredText is the legitimate same-UUID recovery retry.
        const differentPreparedGoal = previous.automationOrigin === 'goal' &&
          event.automationOrigin === 'goal' && previous.authoredText !== undefined &&
          event.authoredText !== undefined && previous.authoredText !== event.authoredText;
        // The same Input UUID/native provider message can be recorded again after
        // a lost ACK, page remount or Main restore. Only the original human text
        // and complete selected-Skill/transport envelope are legitimate on that
        // app-owned retry. An out-of-order stale writer must not silently change
        // either one, even after a DIFFERENT provider-observed revision replaced
        // message.text. The hash is immutable metadata, never delivery proof.
        const sameInputOwner = !!previous.inputId && previous.inputId === event.inputId &&
          previous.inputDelivery === 'confirmed' && event.inputDelivery === 'confirmed';
        const changedHumanOriginal = sameInputOwner && previous.authoredText !== undefined &&
          event.authoredText !== undefined && previous.authoredText !== event.authoredText;
        const changedFrozenInput = sameInputOwner && !!previous.preparedDeliverySha256 &&
          !!event.preparedDeliverySha256 && previous.preparedDeliverySha256 !== event.preparedDeliverySha256;
        // An older pre-upgrade callback can omit the new hash. Do not treat that
        // omission as permission to rewrite a more recent hash-bound receipt.
        // The hash is not provider delivery proof; it is the *original prepared*
        // bytes Main already journaled under this native UUID.
        const changedHashlessRetry = sameInputOwner && options.sparseGoalReceipt !== true &&
          !!previous.preparedDeliverySha256 &&
          !event.preparedDeliverySha256 &&
          createHash('sha256').update(event.message.text).digest('hex') !== previous.preparedDeliverySha256;
        const lostInputIdentity = !!previous.inputId && !event.inputId;
        const changedAutomaticOrigin = !!previous.inputId && previous.inputId === event.inputId &&
          event.automationOrigin !== undefined && previous.automationOrigin !== event.automationOrigin;
        // Legacy full app receipts have no frozen hash. Their initial complete
        // app text is still stronger than a different late app projection; a
        // later full provider echo remains free to revise the observed body.
        const changedLegacyEnvelope = sameInputOwner && !previous.preparedDeliverySha256 &&
          previous.source === 'app' && !previous.message.truncated && previous.message.text.length > 0 &&
          event.message.text !== previous.message.text;
        if (differentInput || changedInputProvenance || differentGoal || differentAppInput || differentPreparedGoal ||
            changedHumanOriginal || changedFrozenInput || changedHashlessRetry ||
            changedLegacyEnvelope || lostInputIdentity || changedAutomaticOrigin)
          throw new Error('Canonical native user message conflicts with an existing authored message');
      }
      if (options.sparseGoalReceipt === true) {
        // A Goal recovery with only an actual native message ID does not know
        // which words the provider displayed. Protect an earlier full app
        // delivery or extension echo at this same canonical write point.
        // Reading history before this transaction is a TOCTOU: the native echo
        // could arrive in between and be replaced by the empty ACK afterward.
        if (event.kind !== 'user_message' || event.automationOrigin !== 'goal' ||
            event.message.text !== '' || event.message.truncated !== true)
          throw new Error('Sparse Goal receipt must carry only an incomplete native user message');
        if (previous?.kind === 'user_message') {
          // App-owned human inputs and another automation are different
          // authorities even if a provider reuses a message id after Resume.
          if ((previous.inputId && !sameGeneratedInput) || (previous.automationOrigin && previous.automationOrigin !== 'goal'))
            throw new Error('Native Goal receipt conflicts with an existing authored message');
          if (previous.message.text || previous.message.chars > 0) event = {
            ...event, source: previous.source, message: previous.message,
            ...(previous.textOrigin ? { textOrigin: previous.textOrigin } : {})
          };
        }
      }
      if (previous?.kind === 'user_message' && event.kind === 'user_message' &&
          previous.textOrigin === 'provider' && previous.message.truncated !== true &&
          previous.message.text.length > 0 && event.source === 'app') {
        // The app may retry a confirmed Input/Goal history projection after
        // its ACK was lost. Its frozen deliveryText is what we intended to
        // send, never better evidence than a complete native/provider body.
        // Preserve the latter at the canonical writer (echo and retry race
        // here), while retaining the original authoredText/automation owner.
        const sameInput = !!event.inputId && event.inputDelivery === 'confirmed' &&
          (!previous.inputId || previous.inputId === event.inputId) &&
          (!previous.automationOrigin || previous.automationOrigin === event.automationOrigin);
        const sameGoal = event.automationOrigin === 'goal' && !previous.inputId &&
          (!previous.automationOrigin || previous.automationOrigin === 'goal');
        if (sameInput || sameGoal) event = {
          ...event, source: previous.source, message: previous.message, textOrigin: 'provider'
        };
      }
      if (previous?.kind === 'user_message' && event.kind === 'user_message' &&
          event.source === 'extension' && (event.textOrigin === 'rendered' || event.message.truncated) &&
          previous.message.truncated !== true && previous.message.text.length > 0 &&
          (previous.automationOrigin === 'goal' ||
            (!!previous.inputId && previous.inputDelivery === 'confirmed'))) {
        // A provider UI can show nonempty but incomplete/flattened text while
        // hydrating a native message. That observation has less scope fidelity
        // than the full previously recorded Goal or authorized human Input.
        // It cannot erase original Skill bodies/corrections or assert complete
        // model receipt. A later *complete provider-backed* body still wins.
        event = { ...event, source: previous.source, message: previous.message,
          textOrigin: previous.textOrigin };
      }
      // A provider UI remount may temporarily expose a blank native user
      // bubble while its text is still loading. This cannot erase either a
      // known Goal/Loop continuation (including an incomplete ID-only Goal
      // receipt) or the complete frozen instruction behind a confirmed human
      // Input. A later *nonempty* provider body still revises the observation
      // while authoredText retains what the actual human originally requested.
      const preserveGoal = previous?.kind === 'user_message' && previous.automationOrigin === 'goal' &&
        (previous.message.text.length > 0 || previous.message.truncated);
      const preserveHuman = previous?.kind === 'user_message' && !!previous.inputId &&
        previous.inputDelivery === 'confirmed' && previous.message.text.length > 0 &&
        event.kind === 'user_message' && event.textOrigin !== 'provider';
      if (previous?.kind === 'user_message' && event.kind === 'user_message' &&
          event.source === 'extension' && event.message.text.length === 0 && (preserveGoal || preserveHuman)) {
        event = { ...event, message: previous.message,
          ...(previous.textOrigin ? { textOrigin: previous.textOrigin } : {}) };
      }
      // A changed provider timestamp caused this alias; it is not a correction of
      // the original anchor. Same-key DOM-to-Fiber timestamp promotion still applies.
      const preferTime = options.preferTime === true && key === directKey;
      if (previous && key !== directKey) event = { ...event, messageId: previous.messageId };
      if (previous?.kind === 'assistant_message' && event.kind === 'assistant_message' && previous.inputReplyTo &&
          ((event.inputReplyTo && event.inputReplyTo !== previous.inputReplyTo) ||
            (event.providerMessageId && event.providerMessageId !== previous.providerMessageId))) {
        throw new Error('Canonical native answer association conflicts with its accepted question or final identity');
      }
      // Final is terminal for one canonical ChatGPT message. The page can briefly re-report
      // an older streaming DOM snapshot after settling/remounting; accepting that snapshot
      // would turn a completed answer back into a partial one and could replace its text.
      if (
        previous?.kind === 'assistant_message' &&
        event.kind === 'assistant_message' &&
        (previous.final === true || previous.state === 'final') &&
        event.final !== true &&
        event.state !== 'final'
      ) {
        return { event: previous, changed: false, contentChanged: false };
      }

      // Message bodies can be hundreds of kilobytes. The old path JSON.stringify-compared the
      // same StoredText pair once while preserving rendered HTML and then again while deciding
      // whether the observation changed at all. StoredText has a fixed five-field shape, so a
      // direct comparison is exact and avoids repeated full-string serialisation/allocation on
      // every streaming observation.
      // Rendered bubbles can flatten Markdown/newlines or omit collapsed content while keeping
      // the exact native UUID. Preserve the provider body, including across recorder restarts,
      // without freezing genuine provider edits or legacy observations. Metadata still merges.
      // This quality flag is not receipt, lifecycle or automation authority.
      if (previous?.kind === 'user_message' && event.kind === 'user_message' &&
          previous.textOrigin === 'provider' && event.textOrigin === 'rendered') {
        event = { ...event, message: previous.message, textOrigin: 'provider' };
      }
      const sameMessage =
        previous?.kind === event.kind && storedTextEqual(previous.message, event.message);

      const nextEvent: NewMessageEvent =
        previous?.kind === 'assistant_message' && event.kind === 'assistant_message'
          ? {
              ...event,
              // The producer already supplied the stable website identity. Keep that exact
              // identity through every revision; a different id is a different logical row.
              messageId: previous.messageId,
              providerMessageId: event.providerMessageId ?? previous.providerMessageId,
              // `final` is a compatibility mirror of state, not an independent truth.
              state: event.state === 'final' || event.final === true ? 'final' : 'streaming',
              final: event.state === 'final' || event.final === true,
              // Goal eligibility is an accepted fact about this stable reply, not a property a
              // later sparse page snapshot may retract. This is what makes a 503/reload replay
              // re-offer the same durable obligation instead of silently dropping it.
              ...(previous.goalEligible === true ? { goalEligible: true } : {}),
              ...(previous.inputReplyTo ? { inputReplyTo: previous.inputReplyTo } : {}),
              // Sparse replays preserve a deferred join, independently of terminal
              // eligibility. Only Main's positive exact source proof clears it.
              ...(event.inputAssociationPending === false && event.inputReplyTo && event.goalEligible === true
                ? { inputAssociationPending: false }
                : previous.inputAssociationPending === true || event.inputAssociationPending === true
                  ? { inputAssociationPending: true }
                  : previous.inputAssociationPending === false ? { inputAssociationPending: false } : {}),
              // A sparse re-observation of the same prose must not throw away the richer
              // representation we already captured. If the prose itself changed, omitting
              // HTML deliberately falls back to the new plain text instead of showing stale
              // markup for different content.
              ...(event.renderedHtml === undefined && sameMessage
                ? { renderedHtml: previous.renderedHtml }
                : {})
            }
          : previous?.kind === 'user_message' && event.kind === 'user_message'
            ? { ...event, inputId: event.inputId ?? previous.inputId,
                ...(event.textOrigin === undefined && sameMessage && previous.textOrigin
                  ? { textOrigin: previous.textOrigin } : {}),
                automationOrigin: event.automationOrigin ?? previous.automationOrigin,
                authoredText: event.authoredText ?? previous.authoredText,
                // Only Main's app projection can establish prepared instruction
                // bytes. A provider echo can update message.text, not this hash.
                preparedDeliverySha256: previous.preparedDeliverySha256 ?? appPreparedDeliverySha256,
                inputProvenance: previous.inputProvenance ?? appInputProvenance,
                unverifiedAuthorshipClaim: appOwnedUserReceipt || previous.source === 'app' ||
                  !!previous.preparedDeliverySha256 ? undefined :
                  previous.unverifiedAuthorshipClaim ?? event.unverifiedAuthorshipClaim,
                reaction: event.reaction === undefined ? previous.reaction : event.reaction,
                // App-owned originals/previews retain their outbox identity when the
                // provider later observes different native attachment ids for that send.
                attachments: previous.inputId ? previous.attachments ?? event.attachments : event.attachments ?? previous.attachments,
                inputDelivery: previous.inputDelivery === 'confirmed' ? 'confirmed' : event.inputDelivery ?? previous.inputDelivery,
                model: event.model ?? previous.model,
                reasoningEffort: event.reasoningEffort ?? previous.reasoningEffort,
                assets: event.assets ?? previous.assets }
            : event;
      // A canonical assistant message belongs to exactly one generation permanently. Ownership
      // may still be *promoted* from "not known yet" to a durable generation id when the
      // recorder learns it late, but a settled assistant answer may never move to another turn.
      // User messages are different: their page-side turn marker is a boundary hint and can be
      // revised as ChatGPT re-homes the same stable user object, so preserve that existing
      // behaviour instead of freezing it under the first marker we happened to observe.
      //
      // Live 2026-08-21, session `00000019`: ChatGPT re-mounted its stop control for two
      // seconds well after a page load, the extension minted generation `g-11kz85q585v4s-0-1`
      // for it, and the re-observation of the already finished 08:40:34 answer re-filed that
      // answer under a turn that started at 08:45:22. The consequences are not cosmetic — the
      // answer is torn away from the eight tool calls that produced it, so the extension can
      // no longer prove its reconstruction of that turn complete and drops the whole response
      // back to ChatGPT's native rendering, and the desktop timeline draws an empty turn with
      // a five-minute-old message inside it.
      const settledTurnId =
        previous?.kind === 'assistant_message' && nextEvent.kind === 'assistant_message'
          ? previous.turnId ?? nextEvent.turnId ?? undefined
          : nextEvent.turnId ?? undefined;
      const semanticTextChanged = !previous || !messageSemanticTextEqual(previous, nextEvent);
      const assistantBecameFinal = previous?.kind === 'assistant_message' &&
        nextEvent.kind === 'assistant_message' &&
        previous.final !== true && previous.state !== 'final' &&
        (nextEvent.final === true || nextEvent.state === 'final');
      // This watermark is owned by the serial canonical store, not by extension input. The
      // commit observation makes a just-grown old provider row durable across an immediate app
      // restart; metadata-only revisions retain the previous semantic time exactly.
      const semanticUpdatedAt = semanticTextChanged || assistantBecameFinal
        ? Math.max(nextEvent.time, Date.now())
        : previous?.semanticUpdatedAt ?? previous?.time ?? nextEvent.time;
      if (
        previous &&
        previous.kind === nextEvent.kind &&
        sameMessage &&
        nextEvent.model === previous.model &&
        nextEvent.reasoningEffort === previous.reasoningEffort &&
        (nextEvent.kind !== 'user_message' || previous.kind !== 'user_message' ||
          nextEvent.unverifiedAuthorshipClaim === previous.unverifiedAuthorshipClaim) &&
        (previous.kind !== 'assistant_message' ||
          (nextEvent.kind === 'assistant_message' &&
            storedTextEqual(previous.renderedHtml, nextEvent.renderedHtml) &&
            previous.state === nextEvent.state &&
            previous.final === nextEvent.final &&
            previous.goalEligible === nextEvent.goalEligible &&
            previous.inputReplyTo === nextEvent.inputReplyTo &&
            previous.inputAssociationPending === nextEvent.inputAssociationPending &&
            previous.providerMessageId === nextEvent.providerMessageId)) &&
        (nextEvent.kind !== 'user_message' || previous.kind !== 'user_message' ||
          (nextEvent.textOrigin === previous.textOrigin && nextEvent.reaction === previous.reaction && nextEvent.inputId === previous.inputId && nextEvent.automationOrigin === previous.automationOrigin && nextEvent.authoredText === previous.authoredText && nextEvent.inputDelivery === previous.inputDelivery && nextEvent.preparedDeliverySha256 === previous.preparedDeliverySha256 && inputProvenanceEqual(nextEvent.inputProvenance, previous.inputProvenance) && JSON.stringify(nextEvent.assets) === JSON.stringify(previous.assets) && JSON.stringify(nextEvent.attachments) === JSON.stringify(previous.attachments))) &&
        (previous.turnId ?? undefined) === settledTurnId &&
        (nextEvent.agent === undefined || previous.agent === nextEvent.agent) &&
        (!preferTime || previous.time === nextEvent.time)
      ) {
        return { event: previous, changed: false, contentChanged: false };
      }
      const full = {
        ...nextEvent,
        semanticUpdatedAt,
        ...(nextEvent.kind === 'assistant_message' && nextEvent.final
          ? { finalContentSeq: sameMessage && previous?.kind === 'assistant_message' &&
                (previous.final === true || previous.state === 'final')
              // Old records do not prove when streaming content became terminal. Use the
              // last recorded final revision, never an earlier streaming origin. A known
              // terminal-content anchor still survives rendering-only revisions.
              ? previous.finalContentSeq ?? previous.seq
              : entry.nextSeq }
          : {}),
        // First appearance is chronology; current seq is delivery cursor/revision.
        // A page-model authored timestamp is stronger than a DOM first-sight timestamp. The
        // recorder opts into that correction explicitly; ordinary revisions still keep the
        // original first-seen time forever.
        time: preferTime ? nextEvent.time : previous?.time ?? nextEvent.time,
        ...(settledTurnId === undefined ? {} : { turnId: settledTurnId }),
        ...(previous?.agent && !nextEvent.agent ? { agent: previous.agent } : {}),
        ...(nextEvent.kind === 'assistant_message' || nextEvent.kind === 'user_message'
          ? { origin: previous?.kind === nextEvent.kind ? previous.origin ?? previous.seq : entry.nextSeq }
          : {}),
        seq: entry.nextSeq
      } as MessageEvent;

      await writeCanonicalMessage(sessionId, key, full);

      entry.nextSeq += 1;
      entry.messages.set(key, full);
      if (full.kind === 'user_message') refreshUserTitle(entry.summary, entry.messages.values());
      if (!previous) {
        applyToSummary(entry.summary, full, entry.activeWorkIntervals);
      } else {
        // A revision is not another logical event. Only its text/token weight and recency
        // replace what the previous snapshot contributed to the session projection.
        const delta = eventTokens(full) - eventTokens(previous);
        entry.summary.estimatedTokens = Math.max(0, entry.summary.estimatedTokens + delta);
        entry.summary.contextTokens = Math.max(0, entry.summary.contextTokens + delta);
        entry.summary.updatedAt = Math.max(entry.summary.updatedAt, nextEvent.time);
        entry.summary.lastMessageAt = Math.max(entry.summary.lastMessageAt ?? 0, nextEvent.time);
        noteFinishWork(entry.summary, full);
        if (full.kind === 'assistant_message' && (full.final === true || full.state === 'final')) {
          entry.summary.lastAssistantFinalAt = Math.max(
            entry.summary.lastAssistantFinalAt ?? 0,
            nextEvent.time
          );
        }
        if (full.agent && !entry.summary.agents.includes(full.agent)) entry.summary.agents.push(full.agent);
      }
      entry.historySeq = full.seq;
      scheduleMeta(entry);
      return { event: full, changed: true, contentChanged: !sameMessage };
    });
    entry.queue = write.then(
      () => undefined,
      (err: Error) => logError(`session message upsert failed: ${err.message}`)
    );
    return write;
  });
}

/** Canonical background launch: the call UUID owns its later process status. */
export async function recordProcessCall(sessionId: string, event: Omit<Extract<SessionEvent, { kind: 'tool_call' }>, 'seq'>): Promise<void> {
  // New Core witnesses always have an immutable original in the journal. A later
  // process exit or native binding revises that same logical call canonically.
  if (event.call.resultReceiptId) {
    await appendEvent(sessionId, event);
    return;
  }
  const entry = await ensureOpen(sessionId);
  await enqueueSessionOperation(entry, 'process call', async () => {
    const key = messageKey({ ...event, seq: 0 })!;
    if (entry.messages.has(key)) throw new Error('Process call identity already recorded');
    const full = { ...event, seq: entry.nextSeq, origin: entry.nextSeq };
    await writeCanonicalMessage(sessionId, key, full);
    entry.messages.set(key, full);
    entry.nextSeq += 1;
    entry.historySeq = full.seq;
    applyToSummary(entry.summary, full, entry.activeWorkIntervals);
    scheduleMeta(entry);
  });
}

/** Exit revises its launch; it is not a tool invocation, output receipt or turn boundary. */
export async function completeProcessCall(sessionId: string, callId: string, completion: {
  completedAt: number; durationMs: number; exitCode: number | null;
}): Promise<void> {
  const entry = await ensureOpen(sessionId);
  await enqueueSessionOperation(entry, 'process completion', async () => {
    const key = `tool_call\u0000${callId}`;
    const originals = entry.messages.has(key) ? [] : await originalToolCalls(sessionId, callId, 'callId');
    const previous = entry.messages.get(key) ?? (originals.length === 1 ? originals[0] : undefined);
    if (previous?.kind !== 'tool_call' || !previous.call.process || previous.call.process.completedAt !== undefined) return;
    const { exitCode } = completion;
    const failed = exitCode !== null && exitCode !== 0;
    const full: Extract<SessionEvent, { kind: 'tool_call' }> = {
      ...previous, seq: entry.nextSeq, origin: previous.origin ?? previous.seq,
      call: { ...previous.call, process: { ...previous.call.process, ...completion }, summary: {
        ...previous.call.summary,
        title: previous.call.summary.title.replace(/^Started /, failed ? 'Command failed ' : 'Completed '),
        metric: exitCode === null ? 'finished (exit unknown)' : failed ? `✕ exit ${exitCode}` : '✓ finished',
        tone: exitCode === null ? 'warn' : failed ? 'bad' : 'good'
      } }
    };
    await writeCanonicalMessage(sessionId, key, full);
    entry.messages.set(key, full);
    entry.nextSeq += 1;
    entry.historySeq = full.seq;
    const delta = eventTokens(full) - eventTokens(previous);
    entry.summary.estimatedTokens = Math.max(0, entry.summary.estimatedTokens + delta);
    if (full.call.conversationId === entry.summary.conversationId)
      entry.summary.contextTokens = Math.max(0, entry.summary.contextTokens + delta);
    applyActiveWork(entry.summary, full, entry.activeWorkIntervals);
    scheduleMeta(entry);
  });
}

type ToolEvent = Extract<SessionEvent, { kind: 'tool_call' }>;

/** Original executions, not prose matches or canonical revisions. The receipt
 * search remains the incumbent bounded-per-journal slow authority boundary. */
async function originalToolCalls(sessionId: string, identity: string,
  field: 'callId' | 'resultReceiptId'): Promise<ToolEvent[]> {
  let raw: string;
  try { raw = await fs.readFile(path.join(sessionDir(sessionId), 'events.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const found: ToolEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.includes(identity)) continue;
    const row = JSON.parse(line) as SessionEvent;
    if (row.kind !== 'tool_call' || row.call?.[field] !== identity) continue;
    if (!Number.isSafeInteger(row.seq) || !row.call.callId || !row.call.tool ||
        !row.call.args || !row.call.result) throw new Error('Original tool receipt integrity unverified');
    found.push(row);
  }
  return found;
}

/** Binding/exit revisions cannot change any execution identity, input or result. */
function sameReceiptExecution(original: ToolEvent, revision: ToolEvent): boolean {
  if (revision?.kind !== 'tool_call' || revision.source !== original.source ||
      revision.time !== original.time || revision.turnId !== original.turnId ||
      revision.agent !== original.agent ||
      (revision.origin ?? revision.seq) !== (original.origin ?? original.seq)) return false;
  const identity = (call: ToolCallRecord) => {
    const { nativeCallMessageId: _native, process, summary: _summary, ...rest } = call;
    return { ...rest, processSessionId: process?.sessionId ?? null };
  };
  return JSON.stringify(identity(original.call)) === JSON.stringify(identity(revision.call));
}

function canonicalToolPath(sessionId: string, callId: string): string {
  return path.join(sessionDir(sessionId), 'messages',
    createHash('sha256').update(`tool_call\u0000${callId}`).digest('hex') + '.json');
}

/** Fsync the actual canonical call, and reject replacement during the await. */
export async function syncCanonicalToolCall(sessionId: string, expected: ToolEvent): Promise<void> {
  const file = canonicalToolPath(sessionId, expected.call.callId);
  const handle = await fs.open(file, 'r+');
  let raw: string;
  try {
    raw = await handle.readFile('utf8');
    if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(expected))
      throw new Error('Canonical tool receipt changed before sync');
    await handle.sync();
  } finally { await handle.close(); }
  if (await fs.readFile(file, 'utf8') !== raw!) throw new Error('Canonical tool receipt replaced during sync');
}

/** Enrich one owned execution through the existing canonical call owner. The
 * original JSONL/header/result stay unchanged; no second MCP execution is added. */
export async function bindOwnedToolCallReceipt(sessionId: string, expected: ToolEvent,
  nativeCallMessageId: string, expectedHistorySeq: number): Promise<boolean> {
  const entry = await ensureOpen(sessionId);
  return enqueueSessionOperation(entry, 'native call receipt', async () => {
    if (entry.historySeq !== expectedHistorySeq ||
        entry.summary.conversationId !== expected.call.conversationId ||
        expected.source !== 'mcp' || expected.call.attributionMethod !== 'request_id' ||
        expected.call.attribution !== 'request_id' ||
        !/^[a-f0-9]{48}$/.test(expected.call.resultReceiptId ?? '') ||
        !nativeCallMessageId || nativeCallMessageId.length > 200) return false;
    const originals = await originalToolCalls(sessionId, expected.call.resultReceiptId!, 'resultReceiptId');
    const original = originals[0];
    if (originals.length !== 1 || !original || !sameReceiptExecution(original, expected)) return false;
    const key = messageKey(original)!;
    let current = original;
    try { current = JSON.parse(await fs.readFile(canonicalToolPath(sessionId, original.call.callId), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!sameReceiptExecution(original, current) ||
        current.call.nativeCallMessageId && current.call.nativeCallMessageId !== nativeCallMessageId) return false;
    const withoutNative = (call: ToolCallRecord) => {
      const { nativeCallMessageId: _native, ...rest } = call;
      return JSON.stringify(rest);
    };
    if (withoutNative(current.call) !== withoutNative(expected.call)) return false;
    const full: ToolEvent = current.call.nativeCallMessageId ? current : {
      ...current, seq: entry.nextSeq, origin: original.origin ?? original.seq,
      call: { ...current.call, nativeCallMessageId }
    };
    if (!current.call.nativeCallMessageId) await writeCanonicalMessage(sessionId, key, full);
    // Rename already committed this sequence even if the durability barrier
    // fails. Reserve it before yielding so a newer event cannot reuse it.
    // The binding/cache/history publication still waits for successful sync.
    entry.nextSeq = Math.max(entry.nextSeq, full.seq + 1);
    // A failed sync can leave the shard committed but unacknowledged. Retry the
    // same binding; a different native message can never overwrite that shard.
    await syncCanonicalToolCall(sessionId, full);
    entry.messages.set(key, full);
    entry.historySeq = Math.max(entry.historySeq, full.seq);
    scheduleMeta(entry);
    return true;
  });
}

// ------------------------------------------------------------------- read

export interface ReadOptions {
  /** First sequence number to return, inclusive. */
  from?: number;
  limit?: number;
  kinds?: readonly SessionEvent['kind'][];
  agent?: string;
  /** Native-final receipt readers require the ENTIRE original journal. Ordinary
   * history/UI views intentionally tolerate and report damaged legacy lines,
   * but skipping one here could hide a duplicate tool result and fabricate
   * uniqueness. Never repair, truncate or rewrite the original bytes. */
  requireIntegrity?: boolean;
}

/**
 * Reads events back.
 *
 * A malformed line is skipped and counted rather than throwing: the whole point of
 * an append-only log is that a half-written final line costs one event, not the
 * session. Reading the file in one go is fine at the sizes the caps allow.
 */
export async function readEvents(sessionId: string, options: ReadOptions = {}): Promise<SessionEvent[]> {
  assertSessionId(sessionId);
  await settleSessionWrites(sessionId);
  const from = options.from ?? 0;
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

  // /activity is an incremental feed. Canonical messages use their latest revision seq for
  // the cursor while preserving their first-appearance time/origin for chronology.
  const active = open.get(sessionId);
  if (options.from !== undefined && active) {
    if (from >= active.nextSeq) return [];
    const cacheFloor = active.tailFrom;
    if (from >= cacheFloor) {
      const cached: SessionEvent[] = [...active.tail, ...active.messages.values()].filter((parsed) => {
        if (active.tail.includes(parsed) && messageKey(parsed) && active.messages.has(messageKey(parsed)!)) return false;
        if (parsed.seq < from) return false;
        if (options.kinds && !options.kinds.includes(parsed.kind)) return false;
        if (options.agent && parsed.agent !== options.agent) return false;
        return true;
      });
      // `from` is a sequence cursor. Page in sequence order first and only then apply the
      // presentation chronology inside that bounded page; otherwise chronology may move a later
      // row ahead of an earlier seq at the slice boundary and advancing the cursor would skip it.
      const page = cached.sort((left, right) => left.seq - right.seq).slice(0, limit);
      return chronological(page);
    }
  }
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sessionDir(sessionId), 'events.jsonl'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (options.requireIntegrity) throw new Error('Session tool-result journal integrity unverified');
      raw = '';
    }
    else throw err;
  }
  // A missing terminal newline is an interrupted write, not proof the last
  // native result is absent. Check even if its preceding JSON happens to parse.
  let lastIntegritySeq = 0;
  let damagedTail = options.requireIntegrity && (!raw || !raw.endsWith('\n')) ? 1 : 0;
  const messages = active?.messages ?? (await readCanonicalMessages(sessionId));
  const canonicalKeys = new Set(messages.keys());
  const out: SessionEvent[] = [];
  let damaged = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: SessionEvent;
    try {
      parsed = JSON.parse(line) as SessionEvent;
    } catch {
      damaged++;
      continue;
    }
    if (typeof parsed?.seq !== 'number' || typeof parsed?.kind !== 'string') {
      damaged++;
      continue;
    }
    if (options.requireIntegrity) {
      if (!Number.isSafeInteger(parsed.seq) || parsed.seq <= lastIntegritySeq) damagedTail++;
      lastIntegritySeq = parsed.seq;
    }
    if (options.requireIntegrity && parsed.kind === 'tool_call') {
      const call = parsed.call;
      // JSON syntax alone is not a committed tool-result receipt. A torn or
      // foreign schema can remain valid JSON while omitting the exact call
      // identity used by native-final uniqueness checks. Do not allow a
      // malformed row to cause a 500 or disappear from a proof-of-absence.
      if (!call || typeof call !== 'object' ||
          typeof call.callId !== 'string' || call.callId.length === 0 ||
          typeof call.tool !== 'string' || call.tool.length === 0 ||
          !call.args || typeof call.args !== 'object' ||
          !call.result || typeof call.result !== 'object' ||
          !(typeof call.requestId === 'string' || call.requestId === null) ||
          !(typeof call.conversationId === 'string' || call.conversationId === null) ||
          !['request_id', 'result_receipt', 'unattributed', 'superseded'].includes(call.attributionMethod) ||
          (call.resultReceiptId !== undefined &&
            (typeof call.resultReceiptId !== 'string' || !/^[a-f0-9]{48}$/.test(call.resultReceiptId))) ||
          (call.nativeCallMessageId !== undefined &&
            (typeof call.nativeCallMessageId !== 'string' ||
              call.nativeCallMessageId.length === 0 || call.nativeCallMessageId.length > 200)) ||
          (call.attributionMethod === 'result_receipt' &&
            (!call.conversationId ||
              !call.nativeCallMessageId || !call.resultReceiptId))) {
        damaged++;
        continue;
      }
    }
    if (parsed.seq < from) continue;
    if (options.kinds && !options.kinds.includes(parsed.kind)) continue;
    if (options.agent && parsed.agent !== options.agent) continue;
    // Once a message has a canonical record, a pre-1.8 append-only snapshot with the same
    // ChatGPT identity is legacy journal history, not another transcript item.
    if (messageKey(parsed) && canonicalKeys.has(messageKey(parsed)!)) {
      continue;
    }
    out.push(parsed);
  }
  for (const message of messages.values()) {
    if (message.seq < from) continue;
    if (options.kinds && !options.kinds.includes(message.kind)) continue;
    if (options.agent && message.agent !== options.agent) continue;
    out.push(message);
  }
  if (damaged > 0 || damagedTail > 0) {
    logWarn(`session ${sessionId}: ${damaged + damagedTail} unverified journal line(s)`);
    if (options.requireIntegrity) throw new Error('Session tool-result journal integrity unverified');
  }
  // `seq` is the immutable cursor domain; logical chronology is only allowed to reorder a
  // bounded turn whose `turn_start` is present in this read window. Global time sorting used
  // to move unrelated/replayed page history across turn boundaries and disagreed with the
  // extension renderer, which already used the shared rule. One function now defines the
  // transcript order everywhere.
  if (options.from !== undefined) {
    const page = out.sort((left, right) => left.seq - right.seq).slice(0, limit);
    return chronological(page);
  }
  return chronological(out).slice(0, limit);
}

/**
 * Reads only the newest matching presentation window without materialising the whole JSONL journal.
 *
 * This exists for UI/default-history tails. Full-text search, call expansion and explicit old
 * cursors still use `readEvents()` because they genuinely need older rows. The scan walks the
 * journal backwards and stops once it has enough matching rows (or reaches the bounded byte
 * budget), so `limit: 1` cannot turn into a 40 MB read. Tool status revisions retain their
 * invocation position; they cannot displace newer model work from a limit-one read.
 */
export async function readRecentEvents(
  sessionId: string,
  limit: number,
  options: Pick<ReadOptions, 'kinds' | 'agent'> & { maxBytes?: number; before?: number; orderBySequence?: boolean } = {}
): Promise<SessionEvent[]> {
  assertSessionId(sessionId);
  await settleSessionWrites(sessionId);
  return readRecentEventsFromDisk(sessionId, limit, options);
}

/** The latest authored question, unaffected by later revisions of older messages. */
export async function readLatestUserMessage(sessionId: string): Promise<Extract<SessionEvent, { kind: 'user_message' }> | undefined> {
  assertSessionId(sessionId);
  await settleSessionWrites(sessionId);
  const [message] = await readRecentEventsFromDisk(sessionId, 1, { kinds: ['user_message'], orderByOrigin: true });
  return message?.kind === 'user_message' ? message : undefined;
}

/** Recorded local execution, not a native tool label or a request-id sighting alone. */
export async function turnHasMcpCall(sessionId: string, conversationId: string, turnId: string): Promise<boolean> {
  assertSessionId(sessionId);
  await settleSessionWrites(sessionId);
  // Attribution repair appends historical calls, often without a known turn. Such a tail
  // cannot erase earlier exact proof. Filter inside one bounded-buffer reverse scan so a
  // missing proof does not repeatedly rescan the journal for each presentation page.
  const calls = await readRecentEventsFromDisk(sessionId, 1, {
    kinds: ['tool_call'], before: Number.POSITIVE_INFINITY,
    acceptEvent: call => call.kind === 'tool_call' && call.turnId === turnId && call.source === 'mcp' &&
      call.call?.conversationId === conversationId &&
      ['request_id', 'result_receipt'].includes(call.call.attribution)
  });
  return calls.length > 0;
}

/** Late exact attribution can prove chat health without pretending historical work is new. */
export async function conversationHasMcpCallSince(
  sessionId: string, conversationId: string, startedAt: number, turnId: string | null
): Promise<boolean> {
  assertSessionId(sessionId);
  await settleSessionWrites(sessionId);
  const calls = await readRecentEventsFromDisk(sessionId, 1, {
    kinds: ['tool_call'], before: Number.POSITIVE_INFINITY,
    // Repaired calls may lack a local turn id. Exact conversation and original call
    // time still prove attribution; an explicitly different turn does not.
    acceptEvent: event => event.kind === 'tool_call' && event.source === 'mcp' && event.time >= startedAt &&
      (!event.turnId || event.turnId === turnId) && event.call?.conversationId === conversationId &&
      ['request_id', 'result_receipt'].includes(event.call.attribution)
  });
  return calls.length > 0;
}

async function readRecentEventsFromDisk(
  sessionId: string,
  limit: number,
  options: Pick<ReadOptions, 'kinds' | 'agent'> & {
    maxBytes?: number; before?: number; acceptEvent?: (event: SessionEvent) => boolean; orderByOrigin?: boolean;
    orderBySequence?: boolean
  } = {}
): Promise<SessionEvent[]> {
  const cap = Math.max(1, Math.min(MAX_EVENT_TAIL, Math.floor(limit)));
  const active = open.get(sessionId);
  const needsMessages =
    !options.kinds || options.kinds.includes('user_message') || options.kinds.includes('assistant_message') || options.kinds.includes('tool_call');
  const messages = needsMessages ? active?.messages ?? (await readCanonicalMessages(sessionId)) : new Map<string, CanonicalEvent>();
  const canonicalKeys = new Set(messages.keys());
  // Pre-canonical sessions could append every streaming revision of one stable website
  // message to events.jsonl. This reader builds a *presentation* tail, so those revisions are
  // one logical row here just as a canonical message is one row today. Because the journal is
  // scanned newest-first, the first key seen is the latest revision; duplicates must not spend
  // the row cap or a long old answer can hide every earlier user turn from Goal/history tails.
  const legacyMessageKeys = new Set<string>();
  const rawTail: SessionEvent[] = [];
  let damaged = 0;
  // Explicit history navigation may seek beyond the recent-tail budget. It streams backwards
  // in fixed chunks and retains only this page, never materializing the complete journal.
  const readBudget = options.before === undefined ? Math.max(64 * 1024, Math.min(MAX_RECENT_READ_BYTES, options.maxBytes ?? MAX_RECENT_READ_BYTES)) : Number.POSITIVE_INFINITY;

  const accept = (line: Buffer): void => {
    if (rawTail.length >= cap || line.length === 0) return;
    if (line.length > MAX_LINE_BYTES) {
      damaged += 1;
      return;
    }
    let parsed: SessionEvent;
    try {
      parsed = JSON.parse(line.toString('utf8')) as SessionEvent;
    } catch {
      damaged += 1;
      return;
    }
    if (typeof parsed?.seq !== 'number' || typeof parsed?.kind !== 'string') {
      damaged += 1;
      return;
    }
    if (options.before !== undefined && parsed.seq >= options.before) return;
    if (options.kinds && !options.kinds.includes(parsed.kind)) return;
    if (options.agent && parsed.agent !== options.agent) return;
    if (options.acceptEvent && !options.acceptEvent(parsed)) return;
    if (messageKey(parsed)) {
      const key = messageKey(parsed);
      if (key) {
        if (canonicalKeys.has(key) || legacyMessageKeys.has(key)) return;
        legacyMessageKeys.add(key);
      }
    }
    rawTail.push(parsed);
  };

  const file = path.join(sessionDir(sessionId), 'events.jsonl');
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file, 'r');
    let cursor = (await handle.stat()).size;
    let bytes = 0;
    let carry = Buffer.alloc(0);
    while (cursor > 0 && rawTail.length < cap && bytes < readBudget) {
      const wanted = Math.min(64 * 1024, cursor, readBudget - bytes);
      if (wanted <= 0) break;
      cursor -= wanted;
      const buffer = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, cursor);
      const joined = Buffer.concat([buffer.subarray(0, bytesRead), carry]);
      bytes += bytesRead;
      const firstNewline = joined.indexOf(0x0a);
      if (firstNewline < 0) {
        // A corrupt/no-newline tail used to repeatedly copy the complete 8 MiB budget:
        // 64 KiB + 128 KiB + ... . Retain only one maximum event while seeking a boundary.
        if (joined.length > MAX_LINE_BYTES + 1) damaged += 1;
        carry = joined.subarray(0, Math.min(joined.length, MAX_LINE_BYTES + 1));
        continue;
      }
      carry = joined.subarray(0, firstNewline);
      const complete = joined.subarray(firstNewline + 1);
      let endAt = complete.length;
      for (let at = complete.length - 1; at >= 0 && rawTail.length < cap; at--) {
        if (complete[at] !== 0x0a) continue;
        const line = complete.subarray(at + 1, endAt);
        if (line.length > 0) accept(line);
        endAt = at;
      }
      if (rawTail.length < cap && endAt > 0) accept(complete.subarray(0, endAt));
    }
    if (cursor === 0 && rawTail.length < cap && carry.length > 0) accept(carry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const candidates: SessionEvent[] = [...rawTail];
  for (const message of messages.values()) {
    if (options.before !== undefined &&
        (options.orderBySequence ? message.seq : workSequence(message)) >= options.before) continue;
    if (options.kinds && !options.kinds.includes(message.kind)) continue;
    if (options.agent && message.agent !== options.agent) continue;
    if (options.acceptEvent && !options.acceptEvent(message)) continue;
    candidates.push(message);
  }
  // Canonical message rewrites receive a fresh storage seq but retain their original
  // timeline position in `origin`. Select the window by that position too; otherwise a
  // rewritten opening prompt can displace a later turn_end from a limit-one boundary read.
  // Authority readers page with a storage-sequence cursor. Selecting those pages
  // by display origin can omit an old rewritten instruction at the page boundary.
  // Ordinary presentation tails keep their existing origin order.
  candidates.sort(options.orderBySequence
    ? (left, right) => left.seq - right.seq
    : (left, right) => positionOf(left) - positionOf(right) || workSequence(left) - workSequence(right));
  const selected = candidates.slice(Math.max(0, candidates.length - cap));
  if (damaged > 0) logWarn(`session ${sessionId}: skipped ${damaged} unreadable recent event line(s)`);
  return options.orderBySequence ? selected : chronological(selected);
}

/** Browser projection joins committed writes without forcing the debounced metadata to disk.
 * A cold store hydrates one bounded journal tail. Thereafter the existing append/message owners
 * maintain it, including revisions whose origin is older than the browser cursor. */
export async function readActivityEvents(sessionId: string, since: number, limit = 1200): Promise<{
  events: SessionEvent[]; reset: boolean; resumeBoundary: number;
  openingUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null;
  resumeUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null;
}> {
  const entry = await ensureOpen(sessionId);
  return enqueueSessionOperation(entry, 'activity read', async () => {
    if (!entry.activityHydrated) {
      const recent = await readRecentEventsFromDisk(sessionId, MAX_EVENT_TAIL);
      entry.tail = recent.filter((event) => !(messageKey(event) && entry.messages.has(messageKey(event)!)));
      // Old canonical messages do not prove that intervening journal rows fitted inside
      // the byte budget. Only the retained journal suffix establishes cursor coverage.
      entry.tailFrom = entry.tail.reduce((first, event) => Math.min(first, event.seq), entry.nextSeq);
      entry.activityHydrated = true;
    }
    const cap = Math.max(1, Math.min(MAX_EVENT_TAIL, Math.floor(limit)));
    const cursor = Number.isFinite(since) ? Math.max(0, since) : 0;
    const candidates = [...entry.tail, ...entry.messages.values()].sort((a, b) => a.seq - b.seq);
    const reset = cursor < entry.tailFrom && !(cursor === 0 && entry.tailFrom === 1);
    const selected = reset || cursor === 0
      ? candidates.slice(-cap)
      : candidates.filter((event) => event.seq >= cursor).slice(0, cap);
    // All canonical messages remain authoritative after tail eviction and message revision.
    let openingUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null = null;
    let resumeUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null = null;
    for (const event of candidates) {
      if (event.kind !== 'user_message') continue;
      const position = event.origin ?? event.seq;
      if (!openingUserMessage || position < (openingUserMessage.origin ?? openingUserMessage.seq)) openingUserMessage = event;
      if (continuationMarker(event.message.text)?.[1] === 'RESUME' &&
          (!resumeUserMessage || position > (resumeUserMessage.origin ?? resumeUserMessage.seq))) resumeUserMessage = event;
    }
    const resumeBoundary = resumeUserMessage ? resumeUserMessage.origin ?? resumeUserMessage.seq : 0;
    return { events: chronological(selected), reset: reset || (cursor === 0 && candidates.length > cap), resumeBoundary,
      openingUserMessage, resumeUserMessage };
  });
}

/**
 * Atomically keeps only the supplied tool calls in an Unattributed activity session.
 *
 * This is deliberately not a general history editor. 1.8.2 uses it for one deterministic
 * migration: calls whose exact request-id owner is now known are copied to that owner's
 * session, then removed from the legacy Unattributed bucket. Unknown calls remain under the
 * same local session id. Re-sequencing is safe here because this bucket has no ChatGPT
 * conversation, canonical messages, or turn lifecycle: it is only a holding area for calls.
 */
export async function rewriteUnattributedToolCalls(
  sessionId: string,
  calls: readonly Extract<SessionEvent, { kind: 'tool_call' }>[],
  scannedThroughSeq: number,
  deleteEmpty = false,
  /** Exact original snapshot through the high-water mark. A stale or replaced
   * source row can never be silently erased by a delayed two-journal repair. */
  expectedEvents?: readonly SessionEvent[]
): Promise<{ retained: number; deleted: boolean }> {
  assertSessionId(sessionId);
  const entry = await ensureOpen(sessionId);
  const rewrite = entry.queue.then(async () => {
    if (entry.summary.conversationId !== null || entry.summary.title !== 'Unattributed activity') {
      throw new Error(`Session ${sessionId} is not an Unattributed activity bucket`);
    }

    // `calls` is the repairer's snapshot of rows that were still unattributed. New MCP calls can
    // append to this same holding bucket while the repair is pre-copying assets/destinations. The
    // session queue orders those appends before this rewrite, but blindly writing only the old
    // snapshot would then erase them. Read the now-serialized journal and retain every tool call
    // that appeared after the snapshot's high-water seq. Appends that arrive after this operation
    // has been queued naturally run after the rewrite and receive fresh sequence numbers.
    const concurrentCalls: Extract<SessionEvent, { kind: 'tool_call' }>[] = [];
    const raw = await fs.readFile(path.join(sessionDir(sessionId), 'events.jsonl'), 'utf8');
    if (!raw || !raw.endsWith('\n'))
      throw new Error('Unattributed custody journal integrity unverified');
    const original = expectedEvents
      ? new Map(expectedEvents.map(row => [row.seq, JSON.stringify(row)]))
      : null;
    const confirmed = new Set<number>();
    let previousSeq = 0;
    for (const line of raw.slice(0, -1).split('\n')) {
      let event: SessionEvent;
      try { event = JSON.parse(line) as SessionEvent; }
      catch { throw new Error('Unattributed custody journal integrity unverified'); }
      if (!event || !Number.isSafeInteger(event.seq) || event.seq <= previousSeq ||
          (event.kind !== 'session_start' && event.kind !== 'tool_call'))
        throw new Error('Unattributed custody journal contains unverified protected history');
      previousSeq = event.seq;
      if (event.kind === 'tool_call') {
        const call = event.call;
        if (!call || typeof call.callId !== 'string' || !call.callId ||
            !call.args || typeof call.args !== 'object' ||
            !call.result || typeof call.result !== 'object' ||
            typeof call.tool !== 'string' || !call.tool ||
            !(typeof call.requestId === 'string' || call.requestId === null) ||
            !(typeof call.conversationId === 'string' || call.conversationId === null) ||
            !['unattributed', 'superseded'].includes(call.attributionMethod))
          throw new Error('Unattributed custody tool result identity unverified');
      }
      if (original && event.seq <= scannedThroughSeq) {
        if (original.get(event.seq) !== JSON.stringify(event))
          throw new Error('Unattributed custody source changed after original snapshot');
        confirmed.add(event.seq);
      }
      if (event.kind === 'tool_call' && event.seq > scannedThroughSeq) concurrentCalls.push(event);
    }
    if (original && confirmed.size !== original.size)
      throw new Error('Unattributed custody original snapshot incomplete');

    const start: SessionEvent = {
      seq: 1,
      time: entry.summary.startedAt,
      source: 'app',
      kind: 'session_start',
      conversationId: null,
      title: entry.summary.title
    };
    const retainedCalls = [...calls, ...concurrentCalls].sort((left, right) => left.seq - right.seq);
    // Only the recorder can prove this is not its writable bucket: a live call may hold
    // that bucket's id while preparing assets outside this queue. For inactive history,
    // the empty check and deletion share the same queue operation as concurrent-row capture.
    if (deleteEmpty && retainedCalls.length === 0 && entry.queue === settled) {
      if (entry.metaTimer) clearTimeout(entry.metaTimer);
      await fs.rm(sessionDir(sessionId), { recursive: true, force: true });
      if (open.get(sessionId) === entry) open.delete(sessionId);
      invalidateAssetUsage(sessionId);
      publishAttachmentRemoval(sessionId);
      return { retained: 0, deleted: true };
    }
    const kept: SessionEvent[] = [start, ...retainedCalls.map((event, index) => ({ ...event, seq: index + 2 }))];

    const target = path.join(sessionDir(sessionId), 'events.jsonl');
    const tmp = `${target}.repair-${process.pid}-${randomUUID()}.tmp`;
    try {
      // The existing durable writer syncs the COMPLETE replacement before it
      // can become authoritative. A rejected rename keeps the original bytes;
      // do not abandon an uncommitted temporary rewrite on ordinary failures.
      await writeFileDurably(tmp, kept.map((event) => `${JSON.stringify(event)}\n`).join(''));
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }

    const staged: SessionSummary = {
      ...entry.summary,
      updatedAt: entry.summary.startedAt,
      events: 0,
      userMessages: 0,
      toolCalls: 0,
      fileEdits: 0,
      linesAdded: 0,
      linesRemoved: 0,
      approximateFileChanges: false,
      lastFileChangeAt: null,
      lastToolCallAt: null,
      activeWorkMs: 0,
      activeWorkMeasurement: 'unknown',
      lastMessageAt: null,
      lastAssistantFinalAt: null,
      lastTurnEndAt: null,
      lastFinishReportAt: null,
      processExitNonzero: 0,
      toolRejected: 0,
      toolInternalErrors: 0,
      errors: 0,
      estimatedTokens: 0,
      contextTokens: 0,
      lastHandoffId: null,
      lastHandoffAt: null,
      lastCommittedResumeHandoffId: null,
      lastTurnOutcome: null,
      agents: []
    };
    const activeWorkIntervals: ActiveWorkInterval[] = [];
    for (const event of kept) applyToSummary(staged, event, activeWorkIntervals);
    const rewrittenHistorySeq = kept.at(-1)?.seq ?? 0;
    await writeSummary(staged, rewrittenHistorySeq);

    Object.assign(entry.summary, staged);
    entry.activeWorkIntervals = activeWorkIntervals;
    entry.nextSeq = kept.length + 1;
    entry.historySeq = rewrittenHistorySeq;
    entry.tail = kept.slice(-MAX_EVENT_TAIL);
    entry.tailFrom = entry.tail[0]?.seq ?? entry.nextSeq;
    entry.activityHydrated = true;
    entry.metaDirty = false;
    return { retained: retainedCalls.length, deleted: false };
  });
  const settled = rewrite.then(
    () => undefined,
    (err: Error) => logError(`session unattributed repair failed: ${err.message}`)
  );
  entry.queue = settled;
  return rewrite;
}

function normalizeSummary(id: string, raw: string): MetaCheckpoint | null {
  try {
    const parsed = JSON.parse(raw) as PersistedSummary;
    if (parsed?.id !== id) return null;
    const historySeq =
      Number.isSafeInteger(parsed[META_HISTORY_SEQ]) && (parsed[META_HISTORY_SEQ] as number) >= 0
        ? (parsed[META_HISTORY_SEQ] as number)
        : null;
    const { [META_HISTORY_SEQ]: _historySeq, [META_CANONICAL_PROJECTION]: canonicalProjection, [META_TOKEN_ESTIMATE]: tokenEstimate,
      [META_NATIVE_COMPLETION_FENCES]: privateFences, ...publicFields } = parsed;
    const publicSummary = publicFields as SessionSummary;
    if (publicSummary.titleSource !== undefined && !['fallback', 'provider', 'manual'].includes(publicSummary.titleSource)) delete publicSummary.titleSource;
    if (publicSummary.originalTitle !== undefined &&
        (typeof publicSummary.originalTitle !== 'string' || publicSummary.originalTitle.length > 120)) delete publicSummary.originalTitle;
    if (publicSummary.workerLimit !== undefined && publicSummary.workerLimit !== null) {
      if (Number.isSafeInteger(publicSummary.workerLimit) && publicSummary.workerLimit > MAX_MULTI_AGENT_WORKERS &&
          publicSummary.workerLimit <= 8) {
        publicSummary.workerLimit = MAX_MULTI_AGENT_WORKERS;
      } else if (!Number.isSafeInteger(publicSummary.workerLimit) || publicSummary.workerLimit < 1 ||
          publicSummary.workerLimit > MAX_MULTI_AGENT_WORKERS) {
        delete publicSummary.workerLimit;
      }
    }
    const selected = publicSummary.selectedModel;
    if (selected !== undefined && (!selected || typeof selected !== 'object' ||
        typeof selected.conversationId !== 'string' || typeof selected.model !== 'string' ||
        !/^[a-zA-Z0-9 ._-]{1,80}$/.test(selected.model) || !Number.isFinite(selected.observedAt))) {
      delete publicSummary.selectedModel;
    }
    const finish = publicSummary.finishTurn;
    if (finish !== undefined && finish !== null && (!finish || typeof finish !== 'object' ||
        typeof finish.turnId !== 'string' || !Number.isFinite(finish.startedAt) ||
        typeof finish.notified !== 'boolean' || typeof finish.released !== 'boolean' ||
        !Number.isSafeInteger(finish.workSeq) || finish.workSeq < 0 || !Number.isSafeInteger(finish.decisionSeq) || finish.decisionSeq < 0 ||
        !(finish.decisionInputRevision === null || (typeof finish.decisionInputRevision === 'string' && /^[a-f0-9]{64}$/.test(finish.decisionInputRevision))) ||
        !(finish.conversationId === null || typeof finish.conversationId === 'string') ||
        !(finish.decisionRevision === null || /^[a-f0-9]{64}$/.test(finish.decisionRevision)))) delete publicSummary.finishTurn;

    // A meta.json written before agents, app-opened chats or the session lineage existed
    // has no such field. A session recorded before the lineage was a single chat by
    // definition, and everything it holds was in that chat's context, so both defaults are
    // the truth rather than a placeholder.
    const outcomeCountersMissing =
      typeof publicSummary.processExitNonzero !== 'number' ||
      typeof publicSummary.toolRejected !== 'number' ||
      typeof publicSummary.toolInternalErrors !== 'number';
    const activityBoundaryMissing = !Object.prototype.hasOwnProperty.call(publicSummary, 'lastAssistantFinalAt');
    const fileChangeProjectionMissing = !Object.prototype.hasOwnProperty.call(publicSummary, 'fileEdits') ||
      !Object.prototype.hasOwnProperty.call(publicSummary, 'linesAdded') ||
      !Object.prototype.hasOwnProperty.call(publicSummary, 'linesRemoved') ||
      !Object.prototype.hasOwnProperty.call(publicSummary, 'approximateFileChanges');
    const activeWorkMsValid = typeof publicSummary.activeWorkMs === 'number' &&
      Number.isFinite(publicSummary.activeWorkMs) && publicSummary.activeWorkMs >= 0;
    const activeWorkMs = activeWorkMsValid ? publicSummary.activeWorkMs! : 0;
    const activeWorkMeasurementValid = publicSummary.activeWorkMeasurement === 'unknown' ||
      publicSummary.activeWorkMeasurement === 'partial';
    const activeWorkProjectionMissing = !Object.prototype.hasOwnProperty.call(publicSummary, 'activeWorkMs') ||
      !Object.prototype.hasOwnProperty.call(publicSummary, 'activeWorkMeasurement') ||
      !activeWorkMsValid || !activeWorkMeasurementValid ||
      (activeWorkMs > 0 && publicSummary.activeWorkMeasurement !== 'partial') ||
      (activeWorkMs === 0 && publicSummary.activeWorkMeasurement !== 'unknown');
    const progressReport = publicSummary.loopProgressReport;
    if (progressReport !== undefined) {
      const validPending = progressReport?.pending === undefined || (
        Number.isSafeInteger(progressReport.pending.thresholdMs) && progressReport.pending.thresholdMs > 0 &&
        typeof progressReport.pending.sourceTurnId === 'string' && progressReport.pending.sourceTurnId.length > 0 && progressReport.pending.sourceTurnId.length <= 200 &&
        typeof progressReport.pending.draftToken === 'string' && progressReport.pending.draftToken.length > 0 && progressReport.pending.draftToken.length <= 200 &&
        Number.isFinite(progressReport.pending.reservedAt) && progressReport.pending.reservedAt > 0
      );
      const validDelivered = progressReport?.delivered === undefined || (
        Number.isSafeInteger(progressReport.delivered.thresholdMs) && progressReport.delivered.thresholdMs > 0 &&
        typeof progressReport.delivered.messageId === 'string' && progressReport.delivered.messageId.length > 0 && progressReport.delivered.messageId.length <= 200 &&
        Number.isFinite(progressReport.delivered.confirmedAt) && progressReport.delivered.confirmedAt > 0 &&
        typeof progressReport.delivered.sourceTurnId === 'string' && progressReport.delivered.sourceTurnId.length > 0 && progressReport.delivered.sourceTurnId.length <= 200 &&
        typeof progressReport.delivered.draftToken === 'string' && progressReport.delivered.draftToken.length > 0 && progressReport.delivered.draftToken.length <= 200
      );
      if (!progressReport || typeof progressReport !== 'object' || !validPending || !validDelivered) {
        delete publicSummary.loopProgressReport;
      }
    }
    return {
      historySeq,
      nativeCompletionFences: normalizedNativeCompletionState(privateFences, id),
      canonicalProjectionCurrent: canonicalProjection === 1,
      tokenEstimateCurrent: tokenEstimate === 1,
      outcomeCountersMissing,
      activityBoundaryMissing,
      fileChangeProjectionMissing,
      activeWorkProjectionMissing,
      summary: {
        ...publicSummary,
        // Keep in-place increments numeric until the forced rebuild supplies the real values.
        processExitNonzero: publicSummary.processExitNonzero ?? 0,
        toolRejected: publicSummary.toolRejected ?? 0,
        toolInternalErrors: publicSummary.toolInternalErrors ?? 0,
        fileEdits: Number.isFinite(publicSummary.fileEdits) ? Math.max(0, publicSummary.fileEdits) : 0,
        linesAdded: Number.isFinite(publicSummary.linesAdded) ? Math.max(0, publicSummary.linesAdded) : 0,
        linesRemoved: Number.isFinite(publicSummary.linesRemoved) ? Math.max(0, publicSummary.linesRemoved) : 0,
        approximateFileChanges: publicSummary.approximateFileChanges === true,
        lastFileChangeAt:
          typeof publicSummary.lastFileChangeAt === 'number' && Number.isFinite(publicSummary.lastFileChangeAt)
            ? publicSummary.lastFileChangeAt
            : null,
        // A two-minute display clock is not worth replaying every legacy session during the
        // attachment-catalog scan. The next real tool call sets the exact value immediately.
        lastToolCallAt:
          typeof publicSummary.lastToolCallAt === 'number' && Number.isFinite(publicSummary.lastToolCallAt)
            ? publicSummary.lastToolCallAt
            : null,
        activeWorkMs,
        activeWorkMeasurement: activeWorkMs > 0 && activeWorkMeasurementValid
          ? 'partial'
          : 'unknown',
        lastMessageAt:
          typeof publicSummary.lastMessageAt === 'number' && Number.isFinite(publicSummary.lastMessageAt)
            ? publicSummary.lastMessageAt
            : Math.max(publicSummary.lastAssistantFinalAt ?? 0, publicSummary.startedAt),
        lastAssistantFinalAt:
          typeof publicSummary.lastAssistantFinalAt === 'number' && Number.isFinite(publicSummary.lastAssistantFinalAt)
            ? publicSummary.lastAssistantFinalAt
            : null,
        lastTurnEndAt:
          typeof publicSummary.lastTurnEndAt === 'number' && Number.isFinite(publicSummary.lastTurnEndAt)
            ? publicSummary.lastTurnEndAt
            : null,
        lastFinishReportAt:
          typeof publicSummary.lastFinishReportAt === 'number' && Number.isFinite(publicSummary.lastFinishReportAt)
            ? publicSummary.lastFinishReportAt
            : null,
        agents: Array.isArray(publicSummary.agents) ? publicSummary.agents : [],
        origin: publicSummary.origin ?? null,
        chatIds: Array.isArray(publicSummary.chatIds)
          ? publicSummary.chatIds
          : publicSummary.conversationId
            ? [publicSummary.conversationId]
            : [],
        contextTokens:
          typeof publicSummary.contextTokens === 'number' ? publicSummary.contextTokens : publicSummary.estimatedTokens,
        // Older summaries predate successful-resume provenance. Missing means unknown, never
        // "use lastHandoffId": capture publication happens before the continuation rebind.
        lastCommittedResumeHandoffId:
          typeof publicSummary.lastCommittedResumeHandoffId === 'string' &&
          /^[0-9a-z-]{8,64}$/i.test(publicSummary.lastCommittedResumeHandoffId)
            ? publicSummary.lastCommittedResumeHandoffId
            : null
      }
    };
  } catch {
    return null;
  }
}

/** Distinguish proven absence/damage from a filesystem that refused the read. */
async function readMetaFile(
  id: string,
  file: string
): Promise<{ checkpoint: MetaCheckpoint } | { checkpoint: null; state: 'absent' | 'damaged' }
  | { checkpoint: null; state: 'unreadable'; error: NodeJS.ErrnoException }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR') {
      return { checkpoint: null, state: 'absent' };
    }
    return { checkpoint: null, state: 'unreadable', error: failure };
  }
  const checkpoint = normalizeSummary(id, raw);
  return checkpoint ? { checkpoint } : { checkpoint: null, state: 'damaged' };
}

/** The durable projection of one session, or a truthful refusal when storage is unreadable. */
async function readMetaCheckpoint(id: string): Promise<MetaCheckpoint | null> {
  const dir = sessionDir(id);
  const primary = await readMetaFile(id, path.join(dir, 'meta.json'));
  if (primary.checkpoint) return primary.checkpoint;

  const backup = await readMetaFile(id, path.join(dir, 'meta.backup.json'));
  if (backup.checkpoint) {
    logWarn(`session ${id}: meta.json ${primary.state}; using the last validated checkpoint`);
    return backup.checkpoint;
  }

  const failure = primary.checkpoint === null && primary.state === 'unreadable' ? primary.error
    : backup.checkpoint === null && backup.state === 'unreadable' ? backup.error
      : null;
  if (failure) {
    throw new Error(`Session ${id} metadata could not be read (${failure.code ?? failure.message})`);
  }
  logWarn(
    `session ${id}: meta.json ${primary.state}, meta.backup.json ${backup.state}; ` +
      'refusing to treat it as an empty session'
  );
  return null;
}

/** Reuse metadata/backup parsing without logging first creation as corrupt history. */
async function nativeCompletionStateOnDisk(id: string): Promise<NativeCompletionPrivateState> {
  const primary = await readMetaFile(id, path.join(sessionDir(id), 'meta.json'));
  if (primary.checkpoint) return primary.checkpoint.nativeCompletionFences;
  const backup = await readMetaFile(id, path.join(sessionDir(id), 'meta.backup.json'));
  if (backup.checkpoint) return backup.checkpoint.nativeCompletionFences;
  if (primary.state === 'unreadable' || backup.state === 'unreadable')
    throw new Error('Session native completion metadata could not be read');
  return emptyNativeCompletionState();
}

async function readMeta(id: string): Promise<SessionSummary | null> {
  return (await readMetaCheckpoint(id))?.summary ?? null;
}

/**
 * A cold sidebar needs metadata, not every retained message body. A validated modern
 * checkpoint can prove that its projection follows all history writes: the journal and
 * legacy map are files, while canonical shards are replaced by rename, which changes
 * their directory's timestamp. Read the checkpoint timestamp BEFORE its contents so a
 * concurrent atomic metadata replacement can only make this test conservative.
 *
 * Equal clocks, old schemas, unreadable metadata and any newer history keep the existing
 * full recovery path. No guessed summary is allowed to suppress crash reconciliation.
 */
async function readCatalogSummary(id: string): Promise<SessionSummary | null> {
  const dir = sessionDir(id);
  try {
    const metadata = await fs.stat(path.join(dir, 'meta.json'));
    const checkpoint = normalizeSummary(id, await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (checkpoint && checkpoint.historySeq !== null && checkpoint.canonicalProjectionCurrent && checkpoint.tokenEstimateCurrent &&
        !checkpoint.outcomeCountersMissing && !checkpoint.activityBoundaryMissing && !checkpoint.fileChangeProjectionMissing &&
        !checkpoint.activeWorkProjectionMissing &&
        checkpoint.summary.finishTurn !== undefined && !legacyContextTitle(checkpoint.summary)) {
      const mutations = await Promise.all(['events.jsonl', 'messages.json', 'messages'].map(async name => {
        try { return (await fs.stat(path.join(dir, name))).mtimeMs; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
      }));
      if (metadata.mtimeMs > 0 && mutations.every(at => at < metadata.mtimeMs)) return checkpoint.summary;
    }
  } catch { /* Existing full reconstruction owns missing/corrupt/uncertain checkpoints. */ }
  return (await readDurableSnapshot(id))?.summary ?? null;
}

function addAttachment(map: Map<string, Set<string>>, conversationId: string, sessionId: string): void {
  if (!conversationId) return;
  const ids = map.get(conversationId) ?? new Set<string>();
  ids.add(sessionId);
  map.set(conversationId, ids);
}

function removeAttachment(map: Map<string, Set<string>>, conversationId: string, sessionId: string): void {
  if (!conversationId) return;
  const ids = map.get(conversationId);
  if (!ids) return;
  ids.delete(sessionId);
  if (ids.size === 0) map.delete(conversationId);
}

function indexSummary(catalog: AttachmentCatalog, summary: SessionSummary): void {
  catalog.summaries.set(summary.id, { ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] });
  if (summary.conversationId) addAttachment(catalog.current, summary.conversationId, summary.id);
  for (const chatId of summary.chatIds) addAttachment(catalog.historical, chatId, summary.id);
}

function unindexSummary(catalog: AttachmentCatalog, summary: SessionSummary): void {
  catalog.summaries.delete(summary.id);
  const orderedAt = catalog.orderedIds.indexOf(summary.id);
  if (orderedAt >= 0) catalog.orderedIds.splice(orderedAt, 1);
  if (summary.conversationId) removeAttachment(catalog.current, summary.conversationId, summary.id);
  for (const chatId of summary.chatIds) removeAttachment(catalog.historical, chatId, summary.id);
}

function insertSummaryOrder(catalog: AttachmentCatalog, summary: SessionSummary): void {
  let low = 0;
  let high = catalog.orderedIds.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const other = catalog.summaries.get(catalog.orderedIds[middle]!);
    if (!other || compareSummariesNewestFirst(summary, other) < 0) high = middle;
    else low = middle + 1;
  }
  catalog.orderedIds.splice(low, 0, summary.id);
}

/** Refreshes only the summary projection; attachment ownership is unchanged. */
function publishCachedSummary(summary: SessionSummary, reorder: boolean): void {
  const catalog = attachmentCatalog;
  if (!catalog) return;
  const clone = { ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] };
  catalog.summaries.set(summary.id, clone);
  if (!reorder) return;
  const orderedAt = catalog.orderedIds.indexOf(summary.id);
  if (orderedAt >= 0) catalog.orderedIds.splice(orderedAt, 1);
  insertSummaryOrder(catalog, clone);
}

/** Update the derived index only after an attachment mutation is durable. */
function publishAttachmentSummary(summary: SessionSummary): void {
  attachmentEpoch += 1;
  missingCurrentConversations.delete(summary.conversationId ?? '');
  const catalog = attachmentCatalog;
  if (!catalog) return;
  const previous = catalog.summaries.get(summary.id);
  if (previous) unindexSummary(catalog, previous);
  indexSummary(catalog, summary);
  insertSummaryOrder(catalog, catalog.summaries.get(summary.id)!);
}

/** Remove one durable session from the derived ownership index. */
function publishAttachmentRemoval(sessionId: string): void {
  attachmentEpoch += 1;
  const catalog = attachmentCatalog;
  if (!catalog) return;
  const previous = catalog.summaries.get(sessionId);
  if (previous) unindexSummary(catalog, previous);
}

/** A closing live session must become the durable ordered row before its live overlay vanishes. */
function publishClosedSummary(summary: SessionSummary): void {
  // If the first catalog pass already read this row before close, force that in-flight snapshot
  // to retry. Once a catalog exists, this is just one binary-positioned row update.
  attachmentEpoch += 1;
  publishCachedSummary(summary, true);
}

function newAttachmentCatalog(): AttachmentCatalog {
  return { summaries: new Map(), orderedIds: [], current: new Map(), historical: new Map(), complete: true };
}

/**
 * Builds the identity catalog from every valid session metadata folder, without the UI's
 * 5,000-session cap. If create/rebind/delete lands while the pass is reading disk, its epoch
 * change invalidates the pass and it is repeated, so a completed catalog is never a snapshot
 * that silently predates a concurrent ownership mutation.
 */
async function ensureAttachmentCatalog(): Promise<AttachmentCatalog> {
  if (attachmentCatalog) return attachmentCatalog;
  if (attachmentCatalogLoading) return attachmentCatalogLoading;
  const loading = (async () => {
    const startedAt = Date.now();
    for (;;) {
      assertReady();
      const epoch = attachmentEpoch;
      let names: string[];
      try {
        names = await fs.readdir(root);
      } catch (error) {
        // A fresh install legitimately has no sessions directory yet. Any other failure is not
        // evidence that the durable catalog is empty. Caching EBUSY/EACCES/IO errors here poisons
        // every ownership, retention and latest-handoff lookup for the rest of the process.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
        else throw error;
      }
      const catalog = newAttachmentCatalog();
      const candidates = names.filter((name) => /^[0-9a-z-]{8,64}$/i.test(name));
      let unread = 0;
      for (let offset = 0; offset < candidates.length; offset += ATTACHMENT_CATALOG_READ_CONCURRENCY) {
        const summaries = await Promise.all(
          candidates.slice(offset, offset + ATTACHMENT_CATALOG_READ_CONCURRENCY).map(async (name) => {
            const live = open.get(name);
            if (live) return live.summary;
            try {
              return await readCatalogSummary(name);
            } catch (error) {
              unread += 1;
              logWarn(`session catalog: ${name} could not be read this pass: ${(error as Error).message}`);
              return null;
            }
          })
        );
        for (const [index, summary] of summaries.entries()) {
          if (summary) indexSummary(catalog, summary);
          else {
            // A physical session folder with no recoverable summary is not an
            // absent session. It can still own a prepared handoff or unflushed
            // native result. An incomplete catalog may serve UI pages, but it
            // cannot authorize retention or an absence-based receipt transfer.
            unread += 1;
            logWarn(`session catalog: ${candidates[offset + index]} has no verified metadata or recoverable history`);
          }
        }
      }
      catalog.orderedIds = [...catalog.summaries.values()]
        .sort(compareSummariesNewestFirst)
        .map((summary) => summary.id);
      if (attachmentEpoch !== epoch) continue;
      if (unread > 0) {
        logWarn(`session catalog: ${unread} of ${candidates.length} folders unreadable; not caching this pass`);
        catalog.complete = false;
        return catalog;
      }
      attachmentCatalog = catalog;
      logInfo(`session catalog ready: ${catalog.summaries.size} sessions in ${Date.now() - startedAt} ms`);
      return catalog;
    }
  })();
  attachmentCatalogLoading = loading;
  try {
    return await loading;
  } finally {
    if (attachmentCatalogLoading === loading) attachmentCatalogLoading = null;
  }
}

/**
 * Every readable session, newest first. Live summaries win over what is on disk.
 *
 * Legacy/model-facing bounded list. Do not use this for correctness properties that promise
 * to see every retained session; identity, latest-handoff recovery and retention use the
 * uncapped process catalog instead.
 */
async function readAllSummaries(): Promise<SessionSummary[]> {
  assertReady();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const summaries: SessionSummary[] = [];
  const candidates = names.filter(name => /^[0-9a-z-]{8,64}$/i.test(name));
  if (candidates.length > MAX_SCANNED_SESSIONS)
    logWarn(`session store: more than ${MAX_SCANNED_SESSIONS} session folders; older ones were not scanned`);
  for (let offset = 0; offset < Math.min(candidates.length, MAX_SCANNED_SESSIONS); offset += ATTACHMENT_CATALOG_READ_CONCURRENCY) {
    const rows = await Promise.all(candidates.slice(offset, Math.min(offset + ATTACHMENT_CATALOG_READ_CONCURRENCY, MAX_SCANNED_SESSIONS))
      .map(async name => open.get(name)?.summary ?? await readMeta(name)));
    for (const summary of rows) if (summary) summaries.push({ ...summary });
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/**
 * Every valid session summary, with no maintenance/UI scan cap.
 *
 * Most callers deliberately stop after 5,000 folders so a pathological history cannot make a
 * routine UI refresh unbounded. `latestHandoff()` is different: its answer is a recovery
 * authority. Missing the newest resumable handoff because `readdir()` happened to return that
 * folder after an arbitrary cap can resume the wrong work. Keep the expensive path explicit
 * and use it only where "every session" is part of the contract.
 */
async function readEverySummary(): Promise<SessionSummary[]> {
  const catalog = await ensureAttachmentCatalog();
  const summaries = new Map<string, SessionSummary>();
  for (const summary of catalog.summaries.values()) summaries.set(summary.id, summary);
  // Live projections are authoritative between debounced meta writes.
  for (const entry of open.values()) summaries.set(entry.summary.id, entry.summary);
  return [...summaries.values()].map((summary) => ({ ...summary })).sort(compareSummariesNewestFirst);
}

export interface SessionListCursor {
  updatedAt: number;
  id: string;
}

export interface SessionPage {
  sessions: SessionSummary[];
  total: number;
  nextCursor: SessionListCursor | null;
}

function compareSummariesNewestFirst(left: SessionSummary, right: SessionSummary): number {
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

function comesAfterCursor(summary: SessionSummary, cursor: SessionListCursor): boolean {
  return summary.updatedAt < cursor.updatedAt || (summary.updatedAt === cursor.updatedAt && summary.id < cursor.id);
}

/**
 * One bounded UI page from a process-lifetime summary index.
 *
 * The first call pays the one metadata discovery pass that identity already needs. Every hot
 * refresh after that is memory-only in the number of retained summaries plus the tiny live
 * overlay; no coalesced recorder tick rereads thousands of meta.json files. The cursor is the
 * last visible sort key rather than an offset, so a live session moving to the front cannot make
 * history pagination duplicate/skip the boundary it already crossed.
 */
export async function listSessionPage(options: {
  limit?: number;
  cursor?: SessionListCursor;
} = {}): Promise<SessionPage> {
  const catalog = await ensureAttachmentCatalog();
  const limit = Math.max(1, Math.min(MAX_LISTED_SESSIONS, Math.floor(options.limit ?? MAX_LISTED_SESSIONS)));
  const openIds = new Set(open.keys());
  const candidates: SessionSummary[] = [];

  // Open summaries are authoritative between debounced metadata writes. There are normally one
  // or a handful, so overlay them explicitly instead of rebuilding/sorting every retained row.
  for (const entry of open.values()) {
    if (entry.summary.origin?.kind === 'helper') continue;
    if (options.cursor && !comesAfterCursor(entry.summary, options.cursor)) continue;
    candidates.push({ ...entry.summary, chatIds: [...entry.summary.chatIds], agents: [...entry.summary.agents] });
  }

  // The durable order is already maintained incrementally. Collect only one page plus one
  // sentinel; a hot first-page refresh therefore stays O(page + open sessions), even with
  // thousands of retained sessions. Deep pages scan to their cursor only when the user asks.
  let durableEligible = 0;
  let durableHasMore = false;
  for (const id of catalog.orderedIds) {
    if (openIds.has(id)) continue;
    const summary = catalog.summaries.get(id);
    if (!summary || summary.origin?.kind === 'helper' || (options.cursor && !comesAfterCursor(summary, options.cursor))) continue;
    if (durableEligible > limit) {
      durableHasMore = true;
      break;
    }
    candidates.push({ ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] });
    durableEligible += 1;
  }

  candidates.sort(compareSummariesNewestFirst);
  const sessions = candidates.slice(0, limit);
  const last = sessions.at(-1);
  const hasMore = durableHasMore || candidates.length > sessions.length;
  const nextCursor = hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null;
  let total = 0;
  for (const summary of catalog.summaries.values()) {
    if (!openIds.has(summary.id) && summary.origin?.kind !== 'helper') total += 1;
  }
  for (const entry of open.values()) if (entry.summary.origin?.kind !== 'helper') total += 1;
  return { sessions, total, nextCursor };
}

/** Newest first, capped for older internal/UI callers. */
export async function listSessions(): Promise<SessionSummary[]> {
  return (await listSessionPage({ limit: MAX_LISTED_SESSIONS })).sessions;
}

/** Full bounded compatibility/model-facing view. Never use it for retention or identity. */
/** Usage shares the live metadata index; it must not reopen every meta.json per visit. */
export async function listUsageSessions(): Promise<SessionSummary[]> {
  return readEverySummary();
}

export async function listAllSessions(): Promise<SessionSummary[]> {
  return readAllSummaries();
}

/** Uncapped authoritative catalog plus live projections, without reopening every metadata file. */
export async function indexedSessions(options: { requireComplete?: boolean } = {}): Promise<SessionSummary[]> {
  if (options.requireComplete && !(await ensureAttachmentCatalog()).complete)
    throw new Error('Session catalog custody incomplete');
  return readEverySummary();
}

/**
 * The exact receipt index is its ORIGINAL current-account session journals.
 * A foreign historical journal with unrelated torn/legacy bytes is not proof
 * that this independently generated 192-bit witness occurs there; refusing
 * every legitimate new result for that unrelated corruption would strand Loop
 * forever. Read the whole file without a presentation tail cap, then validate
 * every line which COULD contain the literal witness. A malformed, partial or
 * structurally invalid candidate still fails closed; never interpret a copied
 * receipt in arbitrary user prose/tool output as another MCP execution.
 *
 * The target/source themselves still undergo full strict readEvents integrity
 * at the native-final and custody transfer boundary. Catalog completeness and
 * read failures are separate, fail-closed requirements.
 */
export async function readReceiptWitnessOccurrences(
  sessionId: string,
  resultReceiptId: string
): Promise<Array<Extract<SessionEvent, { kind: 'tool_call' }>>> {
  assertSessionId(sessionId);
  if (!/^[a-f0-9]{48}$/.test(resultReceiptId)) throw new Error('Invalid receipt witness identity');
  await flushSession(sessionId);
  let raw: string;
  try { raw = await fs.readFile(path.join(sessionDir(sessionId), 'events.jsonl'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    raw = '';
  }
  if (raw.length === 0) {
    // Newly created eventless sessions may have no journal or an empty file.
    // A recorded session may not: either absence can conceal a foreign Core
    // execution, making a different receipt look globally unique.
    const summary = await getSession(sessionId);
    if (!summary || summary.toolCalls !== 0 || summary.events !== 0)
      throw new Error('Recorded session receipt journal missing or empty; custody unverified');
    return [];
  }
  if (!raw.includes(resultReceiptId)) return [];
  const matches: Array<Extract<SessionEvent, { kind: 'tool_call' }>> = [];
  for (const line of raw.split('\n')) {
    if (!line.includes(resultReceiptId)) continue;
    let event: SessionEvent;
    try { event = JSON.parse(line) as SessionEvent; }
    catch { throw new Error('Receipt witness journal row integrity unverified'); }
    if (event?.kind !== 'tool_call') continue;
    const call = event.call;
    if (!call || typeof call !== 'object' ||
        call.resultReceiptId === resultReceiptId &&
        (!Number.isSafeInteger(event.seq) || !call.callId || !call.tool ||
          !call.args || !call.result || !['unattributed', 'request_id', 'result_receipt', 'superseded'].includes(call.attributionMethod)))
      throw new Error('Receipt witness tool result integrity unverified');
    if (call.resultReceiptId === resultReceiptId)
      matches.push(event as Extract<SessionEvent, { kind: 'tool_call' }>);
  }
  // Canonical native bindings/process exits annotate the one immutable original;
  // they are not additional executions or a way to mint a historical witness.
  if (matches.length === 1) {
    const original = matches[0]!;
    try {
      const revision = JSON.parse(await fs.readFile(canonicalToolPath(sessionId, original.call.callId), 'utf8')) as ToolEvent;
      if (!sameReceiptExecution(original, revision) ||
          !Number.isSafeInteger(revision.seq) || revision.seq < original.seq ||
          revision.call.nativeCallMessageId !== undefined &&
          (typeof revision.call.nativeCallMessageId !== 'string' ||
            !revision.call.nativeCallMessageId || revision.call.nativeCallMessageId.length > 200))
        throw new Error('Canonical tool receipt identity changed');
      return [revision];
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return matches;
}

/**
 * Finds the durable session that owns one ChatGPT conversation id.
 *
 * `listSessions()` is intentionally capped for the UI and therefore must never be used as an
 * ownership index: once a chat falls outside the UI's current display cap, doing so silently turns "not in
 * the list" into "never existed" and can fork a second session for the same conversation.
 *
 * Page/browser reopen paths use the default current-only lookup. A proven late MCP request may
 * opt into `includeHistorical` so a conversation that was superseded by Compact & Resume still
 * resolves to the durable session whose `chatIds` lineage contains it. Ambiguity fails closed.
 */
export async function findSessionByConversation(
  conversationId: string,
  options: { includeHistorical?: boolean; requireUnique?: boolean } = {}
): Promise<SessionSummary | null> {
  if (!conversationId) return null;
  if (options.includeHistorical !== true && missingCurrentConversations.has(conversationId)) return null;
  const catalog = await ensureAttachmentCatalog();
  // A partial catalog or failed exact-session read cannot prove absence. Never let one transient
  // Windows lock poison the process-lifetime negative ownership cache.
  let unreadable = !catalog.complete;
  const answer = async (id: string): Promise<SessionSummary | null> => {
    try {
      return await getSession(id);
    } catch {
      unreadable = true;
      return null;
    }
  };
  const currentIds = new Set(catalog.current.get(conversationId) ?? []);
  // A create is deliberately visible to this process from the moment its live entry exists.
  // That prevents a concurrent recorder batch from manufacturing a second session while the
  // first session's initial files are still being written. Rebinds never expose B here early:
  // they mutate the live summary only after durable meta says B.
  for (const [id, entry] of open) {
    if (entry.summary.conversationId === conversationId) currentIds.add(id);
  }
  const current = (await Promise.all([...currentIds].map(answer)))
    .filter((summary): summary is SessionSummary => summary?.conversationId === conversationId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (current.length === 1) return current[0] ?? null;
  if (current.length > 1) {
    if (options.requireUnique === true) {
      logWarn(`session store: conversation ${conversationId} is current on ${current.length} sessions; refusing safety-sensitive lookup`);
      return null;
    }
    // Browser/page reopen semantics historically used the newest current session. Keep that
    // deterministic choice rather than manufacturing a third session. Safety-sensitive
    // callers (orphan retirement) opt into requireUnique above.
    return current[0] ?? null;
  }
  if (options.includeHistorical !== true) {
    if (!unreadable) rememberMissingCurrentConversation(conversationId);
    return null;
  }
  const historicalIds = new Set(catalog.historical.get(conversationId) ?? []);
  for (const [id, entry] of open) {
    if (entry.summary.chatIds.includes(conversationId)) historicalIds.add(id);
  }
  const historical = (await Promise.all([...historicalIds].map(answer)))
    .filter((summary): summary is SessionSummary => summary?.chatIds.includes(conversationId) === true)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (historical.length === 1) return historical[0] ?? null;
  if (historical.length > 1) {
    logWarn(`session store: conversation ${conversationId} appears in ${historical.length} session lineages; refusing to guess`);
  }
  return null;
}

/**
 * Has this ChatGPT conversation already been replaced inside any durable session lineage?
 *
 * This is intentionally independent of current attachment. Opening an old source chat after
 * Compact & Resume may create a new recording epoch for genuinely new user activity there, but
 * it must never restore automation authority that the successful A->B handoff retired. The
 * lineage is the durable fact: if any retained session contains A while being attached to a
 * different conversation, A is historical for browser recovery, Goal and Loop forever.
 */
export async function conversationWasSuperseded(conversationId: string): Promise<boolean> {
  if (!conversationId) return false;
  const catalog = await ensureAttachmentCatalog();
  const sessionIds = new Set(catalog.historical.get(conversationId) ?? []);
  for (const [id, entry] of open) {
    if (entry.summary.chatIds.includes(conversationId)) sessionIds.add(id);
  }
  for (const id of sessionIds) {
    const summary = open.get(id)?.summary ?? catalog.summaries.get(id) ?? null;
    if (summary?.chatIds.includes(conversationId) && summary.conversationId !== conversationId) return true;
  }
  return false;
}

/**
 * Whether one ChatGPT frontend is still the session's executable attachment.
 *
 * Historical `chatIds` are transcript lineage, not continuing authority. Compact & Resume
 * deliberately keeps A there so old messages remain readable, while `conversationId` moves to
 * B. Every caller that has to decide whether new work from A is still admissible uses this one
 * store-owned verdict rather than reinterpreting lineage for itself.
 */
export async function conversationAttachment(
  conversationId: string,
  sessionId: string | null = null
): Promise<'current' | 'superseded' | 'unknown'> {
  if (!conversationId) return 'unknown';
  if (sessionId) {
    const exact = await getSession(sessionId);
    if (!exact || !exact.chatIds.includes(conversationId)) return 'unknown';
    return exact.conversationId === conversationId ? 'current' : 'superseded';
  }
  const current = await findSessionByConversation(conversationId, { requireUnique: true });
  if (current) return 'current';
  return (await conversationWasSuperseded(conversationId)) ? 'superseded' : 'unknown';
}

/** Replacement guidance only; historical lineage never restores tool or Send authority. */
export async function replacementOf(
  conversationId: string,
  sessionId: string | null = null
): Promise<{ conversationId: string; title: string } | null> {
  if (!conversationId) return null;
  // Unlike upstream's first historical match, the incumbent attachment index must prove
  // uniqueness. A partial catalog cannot rule out a second owner. An exact caller retains
  // its independent session-bound lookup, including after a second Compact & Resume.
  if (!sessionId && !(await ensureAttachmentCatalog()).complete) return null;
  const summary = sessionId ? await getSession(sessionId)
    : await findSessionByConversation(conversationId, { includeHistorical: true, requireUnique: true });
  if (!summary?.chatIds.includes(conversationId) || !summary.conversationId || summary.conversationId === conversationId) return null;
  return { conversationId: summary.conversationId, title: summary.title === 'ChatGPT session' ? '' : summary.title };
}

/**
 * Filesystem time of the newest durable mutation belonging to a session.
 *
 * Session event timestamps describe when an action happened, not when it finally reached
 * disk. A five-minute MCP call therefore appends today with a `startedAt` from five minutes
 * ago. Stale/orphan cleanup must not look only at that semantic clock and immediately retire
 * work that was just written. The max mtime of the three mutable session projections is the
 * durable inactivity clock it needs.
 */
export async function sessionDurableModifiedAt(id: string): Promise<number | null> {
  assertSessionId(id);
  let newest = 0;
  for (const name of ['events.jsonl', 'messages.json', 'messages', 'meta.json']) {
    try {
      const stat = await fs.stat(path.join(sessionDir(id), name));
      newest = Math.max(newest, stat.mtimeMs);
    } catch {
      // A session can legitimately predate messages.json or have no structured events yet.
    }
  }
  return newest > 0 ? newest : null;
}

export async function getSession(id: string): Promise<SessionSummary | null> {
  assertSessionId(id);
  const summary = await readAuthoritativeSummary(id);
  return summary ? { ...summary } : null;
}

/** Current committed turn only; never loads history or borrows another conversation's state. */
export function loadedSessionTurn(id: string, conversationId: string): string | null {
  const summary = open.get(id)?.summary;
  const turn = summary?.finishTurn;
  return summary?.conversationId === conversationId && turn?.conversationId === conversationId
    ? turn.turnId : null;
}

/** Positive absence for retiring an exact delivered receipt, never corrupt metadata. */
export async function sessionDirectoryMissing(id: string): Promise<boolean> {
  assertSessionId(id);
  const dir = sessionDir(id);
  if (open.has(id) || opening.has(id)) return false;
  try {
    await fs.lstat(dir);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  // An unavailable history root is not evidence that the user removed this session.
  try {
    return (await fs.stat(root)).isDirectory() && !open.has(id) && !opening.has(id);
  } catch { return false; }
}

/** A plan is one replaceable session document, not another execution queue. */
async function readPlanFile(id: string): Promise<AgentPlan | null> {
  let handle;
  try {
    handle = await fs.open(path.join(sessionDir(id), 'plan.json'), 'r');
    const buffer = Buffer.alloc(MAX_AGENT_PLAN_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_AGENT_PLAN_BYTES) return null;
    const parsed = agentPlanSchema.safeParse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readSessionPlan(id: string): Promise<AgentPlan | null> {
  assertSessionId(id);
  await open.get(id)?.queue;
  return readPlanFile(id);
}

export async function updateSessionPlan(
  id: string, conversationId: string, input: AgentPlanUpdate, startedAt: number
): Promise<boolean> {
  const update = agentPlanUpdateSchema.parse(input);
  agentPlanSchema.parse({ ...update, updatedAt: startedAt });
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'plan', async () => {
    // Rebind and plan updates use this same queue. A delayed A call cannot overwrite
    // B's plan after Compact & Resume, even if A was current when the tool started.
    if (entry.summary.conversationId !== conversationId) return false;
    const previous = await readPlanFile(id);
    if (previous && previous.updatedAt > startedAt) return false;
    const plan = agentPlanSchema.parse({ ...preserveAcceptance(previous, update), updatedAt: startedAt });
    const bytes = JSON.stringify(plan);
    if (Buffer.byteLength(bytes) > MAX_AGENT_PLAN_BYTES) throw new Error('Plan exceeds its storage budget; consolidate working steps without dropping acceptance requirements.');
    const target = path.join(sessionDir(id), 'plan.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, 'utf8');
      await fs.rename(temporary, target);
      logInfo(`session plan saved: ${id}, ${plan.plan.length} steps, ${plan.checklist?.length ?? 0} acceptance requirements`);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    return true;
  });
}

export async function endSession(id: string): Promise<void> {
  const entry = open.get(id);
  if (!entry) return;
  if (entry.metaTimer) {
    clearTimeout(entry.metaTimer);
    entry.metaTimer = null;
  }
  await enqueueSessionOperation(entry, 'end', async () => {
    entry.summary.endedAt = Date.now();
    await writeMeta(entry);
    publishClosedSummary(entry.summary);
  });
  if (open.get(id) === entry) open.delete(id);
}

/**
 * Marks a session live again.
 *
 * Closing a ChatGPT tab ends its session, and reopening the same conversation
 * continues it — deliberately, so a chat is one history rather than a fragment per
 * visit. Without this the reopened session kept the `endedAt` from the close, and
 * everything after it was appended to a session the UI still drew as finished.
 */
export async function reopenSession(id: string): Promise<void> {
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'reopen', async () => {
    if (entry.summary.endedAt === null) return;
    entry.summary.endedAt = null;
    entry.summary.updatedAt = Date.now();
    await writeMeta(entry);
  });
}

export async function renameSession(id: string, title: string, source: SessionSummary['titleSource'] = 'manual', conversationId?: string): Promise<void> {
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'rename', async () => {
    const next = title.slice(0, 120);
    if (source !== 'manual') {
      if (conversationId && entry.summary.conversationId !== conversationId) return;
      const first = firstTitleMessage(entry.messages.values());
      const local = first ? userTitle(first.message.text, first.authoredText) : '';
      if (source === 'provider' && (entry.summary.titleSource === 'manual' ||
          (entry.summary.titleSource === 'fallback' && !!local && entry.summary.title === local))) {
        if (entry.summary.originalTitle === next) return;
        entry.summary.originalTitle = next;
        await writeMeta(entry);
        return;
      }
      if (!automaticTitle(entry.summary, firstTitleMessage(entry.messages.values()))) return;
      if (source === 'fallback' && entry.summary.titleSource === 'provider') return;
    }
    if (entry.summary.title === next && entry.summary.titleSource === source) return;
    if (source === 'manual' && entry.summary.titleSource !== 'manual' && !entry.summary.originalTitle) {
      entry.summary.originalTitle = entry.summary.title;
    }
    entry.summary.title = next;
    entry.summary.titleSource = source;
    if (source === 'provider') entry.summary.originalTitle = next;
    await writeMeta(entry);
  });
}

/** Persist a chat-owned worker cap without rewriting its recorded timeline. */
export async function setSessionWorkerLimit(id: string, workerLimit: number | null): Promise<void> {
  if (workerLimit !== null && (!Number.isSafeInteger(workerLimit) || workerLimit < 1 || workerLimit > MAX_MULTI_AGENT_WORKERS)) {
    throw new Error(`Sub-agent worker limit must be a whole number from 1 to ${MAX_MULTI_AGENT_WORKERS}`);
  }
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'worker-limit', async () => {
    const next = workerLimit ?? null;
    if ((entry.summary.workerLimit ?? null) === next) return;
    entry.summary.workerLimit = next;
    entry.summary.updatedAt = Date.now();
    await writeMeta(entry);
  });
}

/** Persist current provider selection independently of recording/history replay. */
export async function observeSessionModel(
  id: string, conversationId: string, model: string, observedAt: number,
  reasoningEffort?: ReasoningEffort
): Promise<void> {
  if (!/^[a-zA-Z0-9 ._-]{1,80}$/.test(model) || !Number.isFinite(observedAt)) return;
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'model-selection', async () => {
    // Late old-document reports cannot change the replacement's policy. Repeated observations
    // and delayed delivery receipts cannot overwrite a newer provider selection either.
    if (entry.summary.conversationId !== conversationId ||
        observedAt < (entry.summary.selectedModel?.observedAt ?? 0)) return;
    const selectedModel = { conversationId, model, observedAt, ...(reasoningEffort ? { reasoningEffort } : {}) };
    if (JSON.stringify(entry.summary.selectedModel) === JSON.stringify(selectedModel)) return;
    const staged = { ...entry.summary, selectedModel };
    await writeSummary(staged, entry.historySeq);
    entry.summary = staged;
    publishAttachmentSummary(staged);
  });
}

export type LoopProgressReportPending = NonNullable<NonNullable<SessionSummary['loopProgressReport']>['pending']>;
export type LoopProgressReportDelivered = NonNullable<NonNullable<SessionSummary['loopProgressReport']>['delivered']>;

/**
 * Reserves one exact two-hour report on the stable prime session.
 *
 * Existing unresolved custody wins. A restart asking about the same source turn receives the
 * original token instead of minting a second report; a newer turn cannot overwrite an ambiguous
 * older reservation.
 */
export async function reserveLoopProgressReport(
  id: string,
  pending: LoopProgressReportPending
): Promise<LoopProgressReportPending | null> {
  if (!Number.isSafeInteger(pending.thresholdMs) || pending.thresholdMs <= 0 ||
      !pending.sourceTurnId || pending.sourceTurnId.length > 200 ||
      !pending.draftToken || pending.draftToken.length > 200 ||
      !Number.isFinite(pending.reservedAt) || pending.reservedAt <= 0) return null;
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'loop progress report reservation', async () => {
    const current = entry.summary.loopProgressReport;
    const deliveredThrough = current?.delivered?.thresholdMs ?? 0;
    if (pending.thresholdMs <= deliveredThrough) return null;
    if (current?.pending) {
      return current.pending.sourceTurnId === pending.sourceTurnId ? { ...current.pending } : null;
    }
    const staged: SessionSummary = {
      ...entry.summary,
      loopProgressReport: {
        ...(current?.delivered ? { delivered: { ...current.delivered } } : {}),
        pending: { ...pending }
      }
    };
    await writeSummary(staged, entry.historySeq);
    entry.summary = staged;
    publishCachedSummary(staged, false);
    return { ...pending };
  });
}

export interface LoopProgressReportConfirmation {
  thresholdMs: number;
  sourceTurnId: string;
  draftToken: string;
  messageId: string;
  confirmedAt: number;
}

/**
 * Advances report custody only from the exact native ChatGPT user-message receipt.
 *
 * A bare Goal ACK never calls this. Repeating the same receipt after a lost bridge response is
 * idempotent; a conflicting token/message cannot consume the pending threshold.
 */
export async function confirmLoopProgressReport(
  id: string,
  draftToken: string,
  messageId: string,
  confirmedAt = Date.now()
): Promise<LoopProgressReportConfirmation | null> {
  if (!draftToken || draftToken.length > 200 || !messageId || messageId.length > 200 || !Number.isFinite(confirmedAt)) return null;
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'loop progress report confirmation', async () => {
    const current = entry.summary.loopProgressReport;
    const delivered = current?.delivered;
    if (delivered?.draftToken === draftToken) {
      if (delivered.messageId !== messageId) return null;
      return { ...delivered };
    }
    const pending = current?.pending;
    if (!pending || pending.draftToken !== draftToken) return null;
    const next: LoopProgressReportDelivered = {
      thresholdMs: pending.thresholdMs,
      sourceTurnId: pending.sourceTurnId,
      draftToken,
      messageId,
      confirmedAt
    };
    const staged: SessionSummary = {
      ...entry.summary,
      loopProgressReport: { delivered: next }
    };
    await writeSummary(staged, entry.historySeq);
    entry.summary = staged;
    publishCachedSummary(staged, false);
    return { ...next };
  });
}

/**
 * Releases one exact threshold reservation only when the browser positively proves that its
 * matching Goal draft was retired before native Send. Ambiguous/no-receipt ACKs must never call
 * this: they keep the pending token parked so restart/reload cannot mint a duplicate report.
 */
export async function releaseLoopProgressReport(
  id: string,
  draftToken: string,
  sourceTurnId: string
): Promise<boolean> {
  if (!draftToken || draftToken.length > 200 || !sourceTurnId || sourceTurnId.length > 200) return false;
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'loop progress report confirmed-unsent release', async () => {
    const current = entry.summary.loopProgressReport;
    const pending = current?.pending;
    if (!pending || pending.draftToken !== draftToken || pending.sourceTurnId !== sourceTurnId) return false;
    const staged: SessionSummary = {
      ...entry.summary,
      ...(current?.delivered
        ? { loopProgressReport: { delivered: { ...current.delivered } } }
        : { loopProgressReport: undefined })
    };
    await writeSummary(staged, entry.historySeq);
    entry.summary = staged;
    publishCachedSummary(staged, false);
    return true;
  });
}

/** Bind once before publishing project work; a task never silently changes folders. */
export async function bindSessionProject(id: string, projectId: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/i.test(projectId)) throw new Error('Invalid project id');
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'project', async () => {
    if (entry.summary.projectId === projectId) return;
    if (entry.summary.projectId) throw new Error('Session already belongs to another project');
    const staged = { ...entry.summary, projectId };
    await writeSummary(staged, entry.historySeq);
    entry.summary = staged;
    publishAttachmentSummary(staged);
  });
}

/**
 * Records that this app opened the chat, and names the session accordingly.
 *
 * One write rather than a rename followed by a stamp, because the two are the same
 * fact: the origin is where the name came from, and a session that carried one without
 * the other would either show the bootstrap prompt as its name or claim a role the
 * name contradicts.
 */
export async function setSessionOrigin(id: string, origin: SessionOrigin, title: string): Promise<void> {
  const inheritedProject = origin.fromSessionId ? (await getSession(origin.fromSessionId))?.projectId : undefined;
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'origin write', async () => {
    if (inheritedProject && entry.summary.projectId && entry.summary.projectId !== inheritedProject) throw new Error('Session origin belongs to another project');
    // The recorder computes its proposed title before joining this serialized queue. A
    // user rename may land in between, so manual precedence must be rechecked here at
    // the durable write authority instead of relying on that earlier snapshot.
    // A manual title is user authority regardless of when origin binding finally arrives. Worker
    // ACKs and restart repair are allowed to attach parent/role provenance, but never to replace a
    // label the user already edited while that origin was still pending.
    const keepManualTitle = entry.summary.titleSource === 'manual';
    const staged = { ...entry.summary, origin, title: (keepManualTitle ? entry.summary.title : title).slice(0, 120),
      ...(origin.kind === 'desktop' && origin.nickname ? { titleSource: 'manual' as const } : {}),
      ...(inheritedProject ? { projectId: inheritedProject } : {}) };
    await writeSummary(staged, entry.historySeq);
    entry.summary = staged;
    publishAttachmentSummary(staged);
  });
}

/**
 * Attaches this durable session to a different ChatGPT conversation.
 *
 * The single canonical session-transfer primitive: Compact & Resume does not create a
 * second session and copy state into it, it moves the one session's frontend from chat A
 * to chat B. Everything the session owns — its recorded history, its title, its origin, its
 * handoffs, and by extension the workspace and swarm binding keyed off it — follows for
 * free, precisely because none of it was ever keyed on the ChatGPT conversation.
 *
 * `contextTokens` is the one figure that resets, and it is not an exception to that rule:
 * it measures what the *attached chat* is carrying, and chat B is carrying only the
 * handoff. `estimatedTokens` keeps counting the session's whole life.
 *
 * Refuses rather than guesses when the session is not attached where the caller thinks it
 * is. That check is what makes the commit safe to retry and impossible to apply twice.
 *
 * ## Commit on success, never before
 *
 * The move is staged on a *clone* and only published into the live summary once the durable
 * write has actually landed. Mutating the live summary first and writing afterwards looked
 * equivalent and was not: a failed `writeMeta` returned false while memory already said
 * chat B, and the next scheduled flush then wrote that state to disk anyway — so a commit
 * that reported failure completed itself a second later. The requirement is absolute in the
 * other direction: a failed A→B commit leaves the session attached to A, in memory and on
 * disk alike. Publishing is a field-by-field copy into the existing object, because callers
 * hold that reference.
 */
export async function rebindSession(
  id: string,
  fromConversationId: string,
  toConversationId: string,
  committedResumeHandoffId?: string
): Promise<boolean> {
  if (!toConversationId || fromConversationId === toConversationId) return false;
  if (committedResumeHandoffId !== undefined && !/^[0-9a-z-]{8,64}$/i.test(committedResumeHandoffId)) return false;
  // Same rule as createSession: once a mutation may attach B, no pre-existing cached miss for
  // B is authoritative. Clearing it early is safe even if the move later refuses or fails.
  missingCurrentConversations.delete(toConversationId);
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'rebind', async () => {
    if (entry.summary.conversationId !== fromConversationId) return false;
    // Browser conversation ids are UUID-like. A handful of store unit tests deliberately
    // use short symbolic ids and reuse them across retained temp sessions; ownership safety
    // applies to the real identity domain rather than manufacturing a test-only collision.
    if (/^[0-9a-f-]{8,64}$/i.test(toConversationId)) {
      const target = await findSessionByConversation(toConversationId, { requireUnique: true });
      if (target && target.id !== id) {
        logWarn(`session ${id} cannot move to ${toConversationId}: that chat already belongs to ${target.id}`);
        return false;
      }
    }
    const staged: SessionSummary = {
      ...entry.summary,
      conversationId: toConversationId,
      chatIds: entry.summary.chatIds.includes(toConversationId)
        ? [...entry.summary.chatIds]
        : [...entry.summary.chatIds, toConversationId],
      contextTokens: 0,
      activeTurnId: null,
      finishTurn: null,
      ...(committedResumeHandoffId !== undefined
        ? { lastCommittedResumeHandoffId: committedResumeHandoffId }
        : {}),
      updatedAt: Date.now(),
      // A session whose chat was closed during the handover is live again the moment its new
      // chat is attached; leaving `endedAt` set would draw a visibly growing session as over.
      endedAt: null
    };

    try {
      await writeSummary(staged, entry.historySeq);
    } catch (err) {
      logWarn(`session ${id} could not be moved to ${toConversationId}: ${(err as Error).message}`);
      return false;
    }

    // Past this point nothing can fail: the durable record already says chat B.
    Object.assign(entry.summary, staged);
    entry.metaDirty = false;
    missingCurrentConversations.delete(toConversationId);
    publishAttachmentSummary(entry.summary);
    logInfo(`session ${id} moved from ChatGPT conversation ${fromConversationId} to ${toConversationId}`);
    return true;
  });
}

/**
 * Repairs successful-resume provenance after recovery proves the A→B session move already landed.
 *
 * Normal continuation commit writes this id atomically inside {@link rebindSession}. A crash can
 * leave the continuation WAL in `committing` after that metadata write, and older builds could
 * move the session before this field existed. In either case, the durable continuation's handoff
 * id plus the session already being attached to B authorises this one-field repair. Any other
 * current attachment is refused rather than inferred.
 */
export async function ensureCommittedResumeHandoff(
  id: string,
  conversationId: string,
  handoffId: string
): Promise<boolean> {
  if (!conversationId || !/^[0-9a-z-]{8,64}$/i.test(handoffId)) return false;
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'committed resume provenance repair', async () => {
    if (entry.summary.conversationId !== conversationId) return false;
    if (entry.summary.lastCommittedResumeHandoffId === handoffId) return true;
    const staged: SessionSummary = {
      ...entry.summary,
      // This is recovery of an already-landed semantic move, not new user/session activity.
      // Preserve the original recency rather than making an app restart reorder old sessions.
      lastCommittedResumeHandoffId: handoffId
    };
    await writeSummary(staged, entry.historySeq);
    Object.assign(entry.summary, staged);
    entry.metaDirty = false;
    publishCachedSummary(entry.summary, false);
    return true;
  });
}

// ----------------------------------------------------------------- assets

/**
 * Stores a binary beside the log and returns a reference.
 *
 * Content-addressed, so a screenshot taken twice costs one file. This is the whole
 * reason the log stays readable: a 300 KB PNG never becomes a 400 KB base64 string
 * inside a line that a summary pass then has to skip over.
 */
export async function writeAsset(
  sessionId: string,
  data: Buffer,
  mimeType: string
): Promise<AssetRef> {
  assertSessionId(sessionId);
  if (data.length === 0 || data.length > MAX_ASSET_BYTES) throw new Error('Session asset exceeds the per-asset limit');
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 32);
  const extension =
    mimeType === 'image/png'
      ? '.png'
      : mimeType === 'image/jpeg'
        ? '.jpg'
        : mimeType === 'text/plain'
          ? '.txt'
          : '.bin';
  const id = `${hash}${extension}`;
  const write = assetWriteQueue.then(async () => {
    const dir = path.join(sessionDir(sessionId), 'assets');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, id);
    try {
      await fs.stat(target);
      return { id, mimeType, bytes: data.length };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const used = await sessionAssetBytesOnDisk(sessionId);
    const globalUsed = await globalAssetBytesOnDisk();
    if (used + data.length > MAX_SESSION_ASSET_BYTES) throw new Error('Session asset quota exceeded');
    if (globalUsed + data.length > MAX_GLOBAL_ASSET_BYTES) throw new Error('Global session asset quota exceeded');
    try {
      await fs.writeFile(target, data, { flag: 'wx' });
      sessionAssetUsage.set(sessionId, used + data.length);
      globalAssetUsage = globalUsed + data.length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return { id, mimeType, bytes: data.length };
  });
  assetWriteQueue = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}

async function directoryFileBytes(dir: string): Promise<number> {
  let total = 0;
  let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  try {
    handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (!entry.isFile()) continue;
      try {
        total += (await fs.stat(path.join(dir, entry.name))).size;
      } catch {
        // A concurrent delete simply removes it from the durable total.
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return total;
}

async function sessionAssetBytesOnDisk(sessionId: string): Promise<number> {
  const cached = sessionAssetUsage.get(sessionId);
  if (cached !== undefined) return cached;
  const used = await directoryFileBytes(path.join(sessionDir(sessionId), 'assets'));
  sessionAssetUsage.set(sessionId, used);
  return used;
}

async function globalAssetBytesOnDisk(): Promise<number> {
  if (globalAssetUsage !== null) return globalAssetUsage;
  let total = 0;
  let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  try {
    handle = await fs.opendir(root);
    for await (const entry of handle) {
      if (!entry.isDirectory() || !/^[0-9a-z-]{8,64}$/i.test(entry.name)) continue;
      total += await sessionAssetBytesOnDisk(entry.name);
      if (total > MAX_GLOBAL_ASSET_BYTES) break;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  globalAssetUsage = total;
  return total;
}

function invalidateAssetUsage(sessionId: string): void {
  sessionAssetUsage.delete(sessionId);
  globalAssetUsage = null;
}

export async function readAsset(sessionId: string, assetId: string, maxBytes?: number): Promise<Buffer | null> {
  assertSessionId(sessionId);
  if (!/^[0-9a-f]{8,64}\.(png|jpg|txt|bin)$/.test(assetId)) return null;
  try {
    const file = path.join(sessionDir(sessionId), 'assets', assetId);
    if (maxBytes === undefined) return await fs.readFile(file);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) return null;
      // One bounded allocation and the same file handle throughout: an extra byte
      // detects growth after stat instead of letting readFile grow the allocation.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) return buffer.subarray(0, length);
        length += bytesRead;
      }
      return null;
    } finally { await handle.close(); }
  } catch {
    return null;
  }
}

/** Native-result transfer cannot discard an original overflow asset based on
 * the destination filename alone. Verify the bytes against their content ID,
 * compare the exact original payload and sync the existing file before the
 * source journal may be retired. Any mismatch/error keeps original custody. */
export async function verifyAndSyncSessionAsset(
  sessionId: string, assetId: string, expected: Buffer
): Promise<void> {
  assertSessionId(sessionId);
  if (!/^[0-9a-f]{32}\.(png|jpg|txt|bin)$/.test(assetId) ||
      expected.length === 0 || expected.length > MAX_ASSET_BYTES ||
      createHash('sha256').update(expected).digest('hex').slice(0, 32) !== assetId.slice(0, 32))
    throw new Error('Core receipt asset content identity unverified');
  const file = path.join(sessionDir(sessionId), 'assets', assetId);
  const handle = await fs.open(file, 'r+');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expected.length ||
        !(await handle.readFile()).equals(expected))
      throw new Error('Core receipt asset bytes unverified');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Stores text too long to sit inline, and returns the reference to put in the event.
 *
 * Content-addressed like any other asset, so a command run twice with the same enormous
 * output costs one file. Returns null only when the text is beyond even this — at which
 * point the event says so rather than pretending the record is complete.
 */
export async function writeOverflowText(sessionId: string, text: string): Promise<string | null> {
  if (text.length > MAX_OVERFLOW_ASSET_CHARS) return null;
  try {
    const asset = await writeAsset(sessionId, Buffer.from(text, 'utf8'), 'text/plain');
    return asset.id;
  } catch (err) {
    logWarn(`session ${sessionId}: overflow text not stored: ${(err as Error).message}`);
    return null;
  }
}

/** Reads back text spilled by writeOverflowText. */
export async function readOverflowText(sessionId: string, assetId: string): Promise<string | null> {
  const data = await readAsset(sessionId, assetId);
  return data ? data.toString('utf8') : null;
}

// --------------------------------------------------------------- handoffs

export async function saveHandoff(handoff: Handoff): Promise<void> {
  assertSessionId(handoff.sessionId);
  if (!/^[0-9a-z-]{8,64}$/i.test(handoff.id)) throw new Error('Invalid handoff identity');
  const dir = path.join(sessionDir(handoff.sessionId), 'handoffs');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${handoff.id}.json`);
  const tmp = path.join(dir, `.${handoff.id}.${randomUUID()}.tmp`);
  const payload = Buffer.from(JSON.stringify(handoff, null, 2), 'utf8');
  let staged = false;
  try {
    // One exact transaction owns each stage file, even across overlapping
    // preparation calls. Flush bytes before making the handoff discoverable.
    const handle = await fs.open(tmp, 'wx');
    staged = true;
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Same-directory hard-link publication is atomic and exclusive. A rename
    // could replace an already-accepted brief when two writers share an id.
    try {
      await fs.link(tmp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A retry may reuse this id only for the exact original bytes. Never
      // overwrite a different accepted handoff or adopt an incomplete file.
      if (!(await fs.readFile(target)).equals(payload))
        throw new Error('Handoff identity already belongs to different content');
    }
  } finally {
    if (staged) {
      // A crash can leave an unreferenced stage; readers never accept stages
      // as handoffs. Cleanup failure must not retract an already-published file.
      await fs.unlink(tmp).catch(() => logWarn('handoff staging cleanup unverified'));
    }
  }
}

export async function readHandoff(sessionId: string, handoffId: string): Promise<Handoff | null> {
  assertSessionId(sessionId);
  if (!/^[0-9a-z-]{8,64}$/i.test(handoffId)) return null;
  try {
    const raw = await fs.readFile(path.join(sessionDir(sessionId), 'handoffs', `${handoffId}.json`), 'utf8');
    const parsed = JSON.parse(raw) as Handoff;
    // Legacy handoffs omit provenance, not their immutable session/id owner.
    if (typeof parsed?.text !== 'string' || parsed.id !== handoffId || parsed.sessionId !== sessionId ||
        !Number.isFinite(parsed.createdAt) || parsed.createdAt < 0) return null;
    if (parsed.version !== undefined || parsed.provenance !== undefined) {
      const provenance = parsed.provenance;
      if (parsed.version !== 1 || parsed.id !== handoffId || parsed.sessionId !== sessionId || !provenance ||
          (provenance.sourceConversationId !== null &&
            (typeof provenance.sourceConversationId !== 'string' || !provenance.sourceConversationId ||
              provenance.sourceConversationId.length > 256)) ||
          (provenance.sourceGeneration !== null &&
            (!Number.isSafeInteger(provenance.sourceGeneration) || provenance.sourceGeneration < 1)) ||
          (provenance.sourceTurnId !== null &&
            (typeof provenance.sourceTurnId !== 'string' || !provenance.sourceTurnId ||
              provenance.sourceTurnId.length > 256)) ||
          (provenance.continuationId !== null &&
            (typeof provenance.continuationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(provenance.continuationId)))) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The newest handoff across every session — what a fresh chat asks for by default.
 *
 * Deliberately over every session rather than the capped UI list: the point of "the last
 * handoff" is that it is the last one, and "unless you happen to have more than two
 * hundred sessions" is not a property worth shipping.
 */
export async function latestHandoff(): Promise<Handoff | null> {
  const sessions = await readEverySummary();
  let best: Handoff | null = null;
  for (const summary of sessions) {
    if (!summary.lastHandoffId) continue;
    const handoff = await readHandoff(summary.id, summary.lastHandoffId);
    if (handoff && (!best || handoff.createdAt > best.createdAt)) best = handoff;
  }
  return best;
}

// ------------------------------------------------------------------ prune

/**
 * A brief can be exclusively published before its WAL/event acknowledgement
 * makes lastHandoffId current. A process crash in that gap leaves real content
 * that metadata-only expiry must not erase. Older, verified files already
 * superseded by a later event do not pin an expired session indefinitely.
 * Unreadable stages or unknown filenames remain protected evidence.
 */
async function retentionHasUnreconciledHandoffFiles(summary: SessionSummary): Promise<boolean> {
  const directory = path.join(sessionDir(summary.id), 'handoffs');
  const files = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const file of files) {
    if (!file.isFile() || !/^[0-9a-z-]{8,64}\.json$/i.test(file.name)) return true;
    const id = file.name.slice(0, -5);
    if (id === summary.lastHandoffId) continue;
    const handoff = await readHandoff(summary.id, id);
    if (!handoff || !Number.isFinite(summary.lastHandoffAt) ||
        handoff.createdAt >= summary.lastHandoffAt!) return true;
  }
  return false;
}

/**
 * Deletes sessions older than the retention window.
 *
 * A session that holds the newest handoff is kept regardless: deleting the thing a
 * fresh conversation is about to resume from would be the one unrecoverable mistake
 * this store can make.
 */
export async function pruneSessions(retainDays: number): Promise<number> {
  if (retainDays <= 0) {
    // Disabling ordinary recording retention has never disabled the separate
    // explicit manual-delete Trash expiration policy.
    await pruneDeletedSessions();
    return 0;
  }
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  // Retention is a completeness contract, not a UI query. Reuse the uncapped process-lifetime
  // catalog so an arbitrary `readdir()` prefix can never make session 5,001 immortal.
  // Partial metadata is also not proof that a more recent unreadable handoff is absent.
  const sessions = await indexedSessions({ requireComplete: true });
  // The incumbent transaction owners must get their own read-only vote before ANY
  // retention side effect. Their recorded states survive Main restart; neither
  // checking those states nor skipping a folder attempts a Send or a repair.
  const continuationHolds = (await import('./continuation.js')).retentionHeldContinuationSessions();
  // Standalone session-store tests have no durable queue. Production retention is
  // installed after the durable owner is initialized; its corruption/read failure
  // prevents destructive pruning rather than being interpreted as an empty outbox.
  const inputHolds = durableStoreReady()
    ? await (await import('./input.js')).retentionHeldInputSessions(sessions)
    : new Set<string>();
  let newestHandoff: Handoff | null = null;
  const uncertainHandoffOwners = new Set<string>();
  for (const summary of sessions) {
    if (!summary.lastHandoffId) continue;
    const handoff = await readHandoff(summary.id, summary.lastHandoffId);
    if (!handoff) {
      // A corrupt or missing brief could be the newest. Protect this owner AND
      // the newest independently readable one, without pinning every historical
      // completed handoff just because one other source is damaged.
      uncertainHandoffOwners.add(summary.id);
      continue;
    }
    if (!newestHandoff || handoff.createdAt > newestHandoff.createdAt) newestHandoff = handoff;
  }
  if (uncertainHandoffOwners.size)
    logWarn(`session retention: ${uncertainHandoffOwners.size} unreadable handoff owner(s) preserved`);
  // Trash has its separate explicit manual-delete window. Do not even enter its
  // expiration maintenance until the active recovery catalog and queue proved readable.
  await pruneDeletedSessions();
  let removed = 0;
  for (const summary of sessions) {
    if (summary.updatedAt >= cutoff) continue;
    if (open.has(summary.id)) continue;
    if (inputHolds.has(summary.id) || continuationHolds.has(summary.id) ||
        (summary.activeTurnId !== null && summary.activeTurnId !== undefined) ||
        summary.loopProgressReport?.pending ||
        (summary.lastCommittedResumeHandoffId && !summary.lastHandoffId)) continue;
    if (uncertainHandoffOwners.has(summary.id)) continue;
    if (newestHandoff && newestHandoff.sessionId === summary.id) continue;
    try {
      if (await retentionHasUnreconciledHandoffFiles(summary)) {
        logWarn(`session retention: ${summary.id} has uncommitted or unreadable handoff files`);
        continue;
      }
      // Reading a private checkpoint must not open old history merely to retain
      // it. The incumbent retention owner instead protects genuine unresolved
      // slots (including retired routes), and refuses unreadable private state.
      const current = await readMetaFile(summary.id, path.join(sessionDir(summary.id), 'meta.json'));
      if (!current.checkpoint || current.checkpoint.nativeCompletionFences.invalid ||
          Object.values(current.checkpoint.nativeCompletionFences.checkpoint?.slots ?? {}).some(slot => slot.fence !== null) ||
          current.checkpoint.summary.updatedAt >= cutoff ||
          current.checkpoint.summary.conversationId !== summary.conversationId) continue;
      // The session may have resumed between the first cold catalog snapshot
      // and this filesystem check. Never remove its newly writable history.
      if (open.has(summary.id)) continue;
      await fs.rm(sessionDir(summary.id), { recursive: true, force: true });
      invalidateAssetUsage(summary.id);
      publishAttachmentRemoval(summary.id);
      removed++;
    } catch (err) {
      logWarn(`could not remove old session ${summary.id}: ${(err as Error).message}`);
    }
  }
  return removed;
}

/** Permanently expires only manual-delete recovery copies older than 30 days. */
async function pruneDeletedSessions(now = Date.now()): Promise<void> {
  const trash = deletedSessionsRoot();
  const names = await fs.readdir(trash).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const id of names) {
    if (!/^[0-9a-z-]{8,64}$/i.test(id)) continue;
    const target = checkedDeletedSessionDir(id);
    try {
      const stat = await fs.stat(target);
      if (now - stat.mtimeMs < DELETED_SESSION_RETENTION_MS) continue;
      await fs.rm(target, { recursive: true, force: true });
      logInfo(`expired deleted-session recovery copy ${id}`);
    } catch (error) {
      logWarn(`could not expire deleted-session recovery copy ${id}: ${(error as Error).message}`);
    }
  }
}

/**
 * Removes a session from the active catalog but preserves its exact folder for Undo.
 *
 * This is an atomic rename on the same volume. It cannot leave half a transcript in the
 * sidebar and half in recovery, and a failed move leaves the original session untouched.
 */
export async function deleteSession(id: string): Promise<SessionSummary> {
  assertSessionId(id);
  await flushSession(id);
  const entry = open.get(id);
  if (entry) {
    if (entry.metaTimer) clearTimeout(entry.metaTimer);
    await entry.queue.catch(() => undefined);
    open.delete(id);
  }
  const summary = await readAuthoritativeSummary(id);
  if (!summary) throw new Error('Session not found');
  const recoveryRoot = deletedSessionsRoot();
  const recovery = deletedSessionDir(id);
  await fs.mkdir(recoveryRoot, { recursive: true });
  if (await fs.stat(recovery).then(() => true, () => false)) {
    // A delayed summary repair can recreate metadata after the transcript was moved.
    // Preserve that small folder inside the original recovery copy; never overwrite
    // the archived transcript or silently reconcile two independent histories.
    const files = await fs.readdir(sessionDir(id), { withFileTypes: true });
    const metadataOnly = files.length > 0 && files.every((file) =>
      file.isFile() && (file.name === 'meta.json' || file.name === 'meta.backup.json'));
    const recovered = normalizeSummary(id, await fs.readFile(path.join(recovery, 'meta.json'), 'utf8'));
    if (!metadataOnly || !recovered) throw new Error('A recovery copy for this session already exists; active history requires reconciliation');
    const retained = path.join(recovery, `.late-metadata-${randomUUID()}`);
    await renameSessionDirectory(sessionDir(id), retained, id, 'delete');
    logInfo(`session ${id}: preserved recreated metadata inside existing recovery copy`);
  } else {
    await renameSessionDirectory(sessionDir(id), recovery, id, 'delete');
  }
  const now = new Date();
  await fs.utimes(recovery, now, now).catch(() => undefined);
  invalidateAssetUsage(id);
  publishAttachmentRemoval(id);
  return summary;
}

/** Restores one recoverable manual deletion to the ordinary session catalog. */
export async function restoreDeletedSession(id: string): Promise<SessionSummary | null> {
  assertSessionId(id);
  const source = deletedSessionDir(id);
  const destination = sessionDir(id);
  if (!await fs.stat(source).then(() => true, () => false)) return null;
  if (await fs.stat(destination).then(() => true, () => false)) {
    throw new Error('A session with this id already exists');
  }
  await renameSessionDirectory(source, destination, id, 'restore');
  missingCurrentConversations.clear();
  const summary = await readAuthoritativeSummary(id);
  if (!summary) {
    await fs.rename(destination, source).catch(() => undefined);
    throw new Error('The deleted session has no recoverable metadata or history');
  }
  publishAttachmentSummary(summary);
  return summary;
}

export async function deletedSessionCount(): Promise<number> {
  const names = await fs.readdir(deletedSessionsRoot()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return names.filter((id) => /^[0-9a-z-]{8,64}$/i.test(id)).length;
}

/** Bounded metadata needed to fence old trash entries before permanent removal. */
export async function listDeletedSessions(): Promise<DeletedSessionRecovery[]> {
  const trash = deletedSessionsRoot();
  const names = await fs.readdir(trash).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const rows: DeletedSessionRecovery[] = [];
  for (const id of names) {
    if (!/^[0-9a-z-]{8,64}$/i.test(id)) continue;
    const dir = checkedDeletedSessionDir(id);
    let checkpoint: MetaCheckpoint | null = null;
    for (const file of ['meta.json', 'meta.backup.json']) {
      try {
        checkpoint = normalizeSummary(id, await fs.readFile(path.join(dir, file), 'utf8'));
        if (checkpoint) break;
      } catch {
        // A corrupt recovery copy can still be permanently removed by its validated id.
      }
    }
    const deletedAt = await fs.stat(dir).then(stat => stat.mtimeMs, () => null);
    rows.push({
      id,
      title: checkpoint?.summary.title ?? 'Unreadable deleted session',
      conversationId: checkpoint?.summary.conversationId ?? null,
      chatIds: checkpoint?.summary.chatIds ? [...checkpoint.summary.chatIds] : [],
      readable: checkpoint !== null,
      deletedAt,
      expiresAt: deletedAt === null ? null : deletedAt + DELETED_SESSION_RETENTION_MS
    });
  }
  return rows;
}

/** Permanently removes exactly one already-trashed local session folder. */
export async function permanentlyDeleteSession(id: string): Promise<boolean> {
  const target = checkedDeletedSessionDir(id);
  if (!await fs.stat(target).then(() => true, () => false)) return false;
  await fs.rm(target, { recursive: true, force: true });
  invalidateAssetUsage(id);
  logInfo(`permanently deleted local session recovery copy ${id}`);
  return true;
}

/** Permanently removes every validated entry in the app's own recovery folder. */
export async function emptyDeletedSessions(): Promise<number> {
  const rows = await listDeletedSessions();
  let removed = 0;
  for (const row of rows) if (await permanentlyDeleteSession(row.id)) removed += 1;
  return removed;
}

/** Test seam: forgets in-memory state without touching the files. */
export function resetSessionStoreForTests(): void {
  unreadableCanonicalShardWarnings.clear();
  canonicalShardWarningEpoch++;
  for (const entry of open.values()) if (entry.metaTimer) clearTimeout(entry.metaTimer);
  open.clear();
  opening.clear();
  reconciling.clear();
  sessionAssetUsage.clear();
  globalAssetUsage = null;
  missingCurrentConversations.clear();
  attachmentCatalog = null;
  attachmentCatalogLoading = null;
  attachmentEpoch = 0;
}

/** Test seam: puts the store back to never having been told where to write. */
export function unsetSessionRootForTests(): void {
  unreadableCanonicalShardWarnings.clear();
  canonicalShardWarningEpoch++;
  root = '';
  sessionAssetUsage.clear();
  globalAssetUsage = null;
  missingCurrentConversations.clear();
  attachmentCatalog = null;
  attachmentCatalogLoading = null;
  attachmentEpoch = 0;
}

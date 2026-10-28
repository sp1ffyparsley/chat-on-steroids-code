/**
 * Passive browser-side evidence for one Core tool-surface incident.
 *
 * This is deliberately a tiny diagnostic cache, not a tab/session/health authority. Chrome's
 * service worker authenticates the document id + navigation epoch before the bridge records a
 * row; the durable recorder and request-correlation registry remain the only owners of chat/tool
 * identity. Keeping this module dependency-free lets Bridge write observations without importing
 * MCP/Connection and closing their existing dependency cycle.
 */

export type CoreBrowserShell = 'classic' | 'alternate' | 'unknown';
export type CoreShellDiscovery = 'compatible' | 'failed' | 'unknown';

export const CORE_NATIVE_IDENTITY_REFUSAL_KEYS = Object.freeze([
  'currentQuestionMissing', 'currentQuestionUnselected', 'currentQuestionConflict',
  'nativeInvocationMissing', 'nativeInvocationMismatch', 'requestIdMissing',
  'decodedPathMissing', 'decodedPathForeign', 'serverMissing', 'serverMismatch',
  'toolMismatch', 'workingTurnMissing', 'workingTurnMismatch', 'turnExchangeMissing',
  'turnExchangeMismatch', 'nativeAncestryUnproved', 'priorRequestIdMissing',
  'priorRequestIdMismatch', 'priorResultResourceIncomplete', 'priorToolScopeMismatch'
] as const);
export type CoreNativeIdentityRefusalKey = typeof CORE_NATIVE_IDENTITY_REFUSAL_KEYS[number];
interface NativeIdentityRefusal { messageId: string; reasons: CoreNativeIdentityRefusalKey[] }

export const CORE_SHELL_CALL_REJECTION_KEYS = Object.freeze([
  'callCompletionVeto',
  'callLiveMappingMissing',
  'callLiveMappingConflict',
  'callPathMissing',
  'callReceiptMissing',
  'callReceiptConflict',
  'callNativePending',
  'callScopeConflict',
  'callExecUnresolved',
  'callRequestIdPresent', 'callRequestIdMissing', 'callInventoryMissing', 'callInventoryIncomplete',
  'callVetoReceiptChecked', 'callVetoReceiptMatched',
  'callJoinReferenceMissing', 'callJoinReferenceUnselected', 'callJoinReferenceConflict',
  'callJoinResultMissing', 'callJoinResultIdentity', 'callJoinDescriptorUnsupported',
  'callIdentityRecovered', 'callIdentityPriorPair',
  'callIdentityUserUnproved', 'callIdentityNativeUnproved',
  'callIdentityScopeUnproved', 'callIdentityParentUnproved',
  'callIdentitySelectedWithheld',
  'assistantTerminalReceiptChecked', 'assistantTerminalReceiptMatched',
  'callCompletedFalse', 'callCompletedUndefined', 'callCompletedNull', 'callCompletedMalformed', 'callStatusVeto',
  'callVetoStatusAbsent', 'callVetoStatusPending', 'callVetoStatusError', 'callVetoStatusDone',
  'callVetoStatusFinal', 'callVetoStatusCompleted', 'callVetoStatusComplete', 'callVetoStatusFinished',
  'callVetoStatusFinishedSuccessfully', 'callVetoStatusUnknown',
  'userTypedMissing', 'userIdentityInvalid', 'userTextEmpty', 'userTextUnsupported', 'userBudgetDropped', 'userProjected'
] as const);
type CoreShellCallRejectionKey = typeof CORE_SHELL_CALL_REJECTION_KEYS[number];
export type CoreShellScanRejects = {
  fiberMissing: number;
  ownerMissing: number;
  stableKeyMismatch: number;
  itemsOverLimit: number;
} & Partial<Record<CoreShellCallRejectionKey, number>>;

export interface CoreShellScanDiagnostic {
  selectorMatches: number;
  mapped: number;
  rejects: CoreShellScanRejects;
}
export interface OrdinaryFinalDiagnostic {
  /** Optional diagnostic witness in the exact same order as coreCallMessageIds. Never authority. */
  identityRefusals?: NativeIdentityRefusal[];
  reason: 'local-owner' | 'busy' | 'excluded-chat' | 'question-invalid' | 'turn-invalid' | 'open-call' | 'open-code' | 'final-invalid' | 'associated';
  questions: number;
  calls: number;
  openCalls: number;
  codeCalls: number;
  openCodeCalls: number;
  activeTurnMapped: boolean;
  /** A negative exact-turn capability, never proof of tool-free completion. */
  callInventoryComplete?: false;
  /** Verified native user UUID; optional when the exact question cannot be read. Not an input Send receipt. */
  sourceUserMessageId?: string;
  /** Positive idle/empty-composer checkpoint identity, NOT final/completion evidence.
   * Only a new process-local deliberate Resume of the exact stopped source can use it. */
  checkpointSourceUserMessageId?: string;
  /** Exact positive native final for opt-in forward-readiness; NEVER a tool-completion receipt. */
  settledFinalMessageId?: string;
  /** Unique request ids from the *unanswered* Core rows only; absent if any call has no unique id. */
  openRequestIds?: string[];
  /** Full native Core call message-id set; required to reject later sibling/retry substitutions. */
  coreCallMessageIds?: string[];
  /** Ordered workflow IDs of ALL native Core parents; distinct parents may share a workflow. */
  allCoreRequestIds?: string[];
  /** Native functions.exec message ids with missing provider tool-result receipts. */
  openCodeCallMessageIds?: string[];
  /** Entire native functions.exec parent set, including parents already answered in the initial scan. */
  codeCallMessageIds?: string[];
  /** Exact enclosing functions.exec message ids with validated native result receipts. */
  answeredCodeCallMessageIds?: string[];
}

/** Existing Bridge diagnostic freshness boundary, also used for truthful wait presentation. */
export const CORE_BROWSER_EVIDENCE_MAX_AGE_MS = 30_000;

export type PendingNativeCompletion = {
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
};

/** A complete, independently scoped native census retained behind an older fence.
 * This is private diagnostic evidence, never a pending fence, result or ACK candidate.
 * Keep the first complete observation of each exact scope immutable. */
export interface ScopedNativeCompletionObservation {
  documentId: string;
  navigationEpoch: number;
  observedAt: number;
  turnId: string;
  sourceUserMessageId: string;
  reason: 'open-call' | 'open-code' | 'associated';
  calls: number;
  codeCalls: number;
  openCalls: number;
  openCodeCalls: number;
  settledFinalMessageId: string | null;
  openRequestIds: string[];
  coreCallMessageIds: string[];
  allCoreRequestIds: string[];
  codeCallMessageIds: string[];
  openCodeCallMessageIds: string[];
  answeredCodeCallMessageIds: string[];
}

// Reuse the private checkpoint's existing route bound; no eviction of accepted scopes.
export const CORE_NATIVE_OBSERVATION_MAX_SCOPES = 32;
export const CORE_NATIVE_OBSERVATION_MAX_BYTES = 1024 * 1024;
export function nativeObservationScopeKey(row: ScopedNativeCompletionObservation): string {
  return JSON.stringify([row.documentId, row.navigationEpoch, row.sourceUserMessageId, row.turnId]);
}

/** Strict identity-only disk/browser boundary. Unknown/missing fields cannot replace a scope. */
export function normalizedNativeCompletionObservation(value: unknown): ScopedNativeCompletionObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as ScopedNativeCompletionObservation;
  const identity = (id: unknown, max = 200): id is string => typeof id === 'string' &&
    id.length > 0 && id.length <= max && /^[a-z0-9_.:-]+$/i.test(id);
  const uuid = (id: unknown): id is string => typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 &&
    Number(n) <= NATIVE_COMPLETION_PROOF_MAX_CALLS;
  if (Object.keys(row).length !== 17 || !identity(row.documentId) || !identity(row.turnId) ||
      !Number.isSafeInteger(row.navigationEpoch) || row.navigationEpoch < 0 ||
      !Number.isSafeInteger(row.observedAt) || row.observedAt <= 0 || row.observedAt > Date.now() ||
      !uuid(row.sourceUserMessageId) || !['open-call', 'open-code', 'associated'].includes(row.reason) ||
      !count(row.calls) || !count(row.codeCalls) || !count(row.openCalls) || !count(row.openCodeCalls) ||
      row.openCalls > row.calls || row.openCodeCalls > row.codeCalls ||
      (row.reason === 'open-call' && row.openCalls === 0) ||
      (row.reason === 'open-code' && row.openCodeCalls === 0) ||
      (row.reason === 'associated' && (row.openCalls !== 0 || row.openCodeCalls !== 0)) ||
      !(row.settledFinalMessageId === null || (uuid(row.settledFinalMessageId) &&
        row.settledFinalMessageId !== row.sourceUserMessageId))) return null;
  const ids = (values: unknown, length: number, max: number, unique: boolean): values is string[] =>
    Array.isArray(values) && values.length === length && values.every(id => identity(id, max)) &&
    (!unique || new Set(values).size === values.length);
  if (!ids(row.openRequestIds, row.openCalls, 100, false) ||
      !ids(row.coreCallMessageIds, row.calls, 200, true) ||
      !ids(row.allCoreRequestIds, row.calls, 100, false) ||
      !ids(row.codeCallMessageIds, row.codeCalls, 200, true) ||
      !ids(row.openCodeCallMessageIds, row.openCodeCalls, 200, true) ||
      !ids(row.answeredCodeCallMessageIds, row.codeCalls - row.openCodeCalls, 200, true) ||
      row.openCodeCallMessageIds.some(id => !row.codeCallMessageIds.includes(id)) ||
      row.answeredCodeCallMessageIds.some(id => !row.codeCallMessageIds.includes(id) || row.openCodeCallMessageIds.includes(id))) return null;
  const remaining = [...row.allCoreRequestIds];
  for (const id of row.openRequestIds) {
    const at = remaining.indexOf(id);
    if (at < 0) return null;
    remaining.splice(at, 1);
  }
  return { documentId: row.documentId, navigationEpoch: row.navigationEpoch, observedAt: row.observedAt,
    turnId: row.turnId, sourceUserMessageId: row.sourceUserMessageId, reason: row.reason,
    calls: row.calls, codeCalls: row.codeCalls, openCalls: row.openCalls, openCodeCalls: row.openCodeCalls,
    settledFinalMessageId: row.settledFinalMessageId, openRequestIds: [...row.openRequestIds],
    coreCallMessageIds: [...row.coreCallMessageIds], allCoreRequestIds: [...row.allCoreRequestIds],
    codeCallMessageIds: [...row.codeCallMessageIds], openCodeCallMessageIds: [...row.openCodeCallMessageIds],
    answeredCodeCallMessageIds: [...row.answeredCodeCallMessageIds] };
}

export interface CoreBrowserEvidenceSnapshot {
  conversationId: string;
  documentId: string;
  navigationEpoch: number;
  observedAt: number;
  shell: CoreBrowserShell;
  shellDiscovery: CoreShellDiscovery;
  shellScan?: CoreShellScanDiagnostic | null;
  ordinaryFinal?: OrdinaryFinalDiagnostic | null;
  /** An unresolved prior native result is not erased by a missing frame or a reload. */
  pendingCompletion?: PendingNativeCompletion | null;
  /** Independent complete scopes; never read by nativeCompletionCandidate/ACK. */
  retainedObservations?: ScopedNativeCompletionObservation[];
  requestIds: string[];
  turnId: string | null;
}

const MAX_CONVERSATIONS = 256;
const SHELL_SCAN_MAX = 400;
/** Complete identity sets share the existing Fiber/Bridge per-turn call bound, not a sampled trace limit. */
const NATIVE_COMPLETION_PROOF_MAX_CALLS = 200;
const snapshots = new Map<string, CoreBrowserEvidenceSnapshot>();
const conversationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f-]{8,64}$/i.test(value);
const bounded = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

/**
 * Rehydrate only the prior unresolved *evidence fence* from the incumbent
 * bounded local-incident store at Bridge startup. Incident snapshots intentionally
 * contain no raw provider/user/request identifiers, so this can never fabricate
 * an attributable completion or grant an automatic Send after a restart.
 */
export function retainUnverifiedNativeCompletionFromIncident(input: {
  conversationId: string; observedAt: number;
  reason: 'native_terminal_open_call' | 'native_terminal_open_code' | 'native_terminal_inventory_incomplete';
  openCalls: number; openCodeCalls: number
}): boolean {
  if (!conversationId(input.conversationId) || !Number.isFinite(input.observedAt) ||
      input.observedAt <= 0 || input.observedAt > Date.now() ||
      !Number.isInteger(input.openCalls) || input.openCalls < 0 || input.openCalls > SHELL_SCAN_MAX ||
      !Number.isInteger(input.openCodeCalls) || input.openCodeCalls < 0 || input.openCodeCalls > SHELL_SCAN_MAX)
    return false;
  if (snapshots.has(input.conversationId)) return false;
  const openCall = input.reason === 'native_terminal_open_call';
  const incomplete = input.reason === 'native_terminal_inventory_incomplete';
  if (!incomplete && (openCall ? input.openCalls === 0 : input.openCodeCalls === 0)) return false;
  const row: CoreBrowserEvidenceSnapshot = {
    conversationId: input.conversationId, documentId: 'retained-unverified-native-result',
    navigationEpoch: 0, observedAt: input.observedAt,
    shell: 'unknown', shellDiscovery: 'unknown', shellScan: null, ordinaryFinal: null,
    pendingCompletion: {
      documentId: 'retained-unverified-native-result', navigationEpoch: 0,
      observedAt: input.observedAt,
      reason: incomplete ? 'inventory-incomplete' : openCall ? 'open-call' : 'open-code',
      calls: input.openCalls, codeCalls: input.openCodeCalls,
      openCalls: input.openCalls, openCodeCalls: input.openCodeCalls,
      sourceUserMessageId: null, openRequestIds: null, coreCallMessageIds: null,
      allCoreRequestIds: null, codeCallMessageIds: null, openCodeCallMessageIds: null
    },
    requestIds: [], turnId: null
  };
  snapshots.set(input.conversationId, row);
  while (snapshots.size > MAX_CONVERSATIONS) snapshots.delete(snapshots.keys().next().value!);
  return true;
}

/** Restore a store-validated private checkpoint, never an authenticated browser frame.
 * Its original observation time/document/identities are retained exactly. A fresh
 * paired reader and the durable result owner must still establish completion;
 * checkpoint existence alone grants no ACK, rebind, freshness or Send authority. */
export function retainNativeCompletionFromCheckpoint(input: {
  conversationId: string; pending: PendingNativeCompletion
}): boolean {
  const pending = input.pending;
  if (!conversationId(input.conversationId) || snapshots.has(input.conversationId) ||
      !bounded(pending.documentId, 200) || pending.documentId === 'retained-unverified-native-result' ||
      !Number.isInteger(pending.navigationEpoch) || pending.navigationEpoch < 0 ||
      !Number.isFinite(pending.observedAt) || pending.observedAt <= 0 || pending.observedAt > Date.now()) return false;
  const copy: PendingNativeCompletion = { ...pending,
    openRequestIds: pending.openRequestIds ? [...pending.openRequestIds] : null,
    coreCallMessageIds: pending.coreCallMessageIds ? [...pending.coreCallMessageIds] : null,
    allCoreRequestIds: pending.allCoreRequestIds ? [...pending.allCoreRequestIds] : null,
    codeCallMessageIds: pending.codeCallMessageIds ? [...pending.codeCallMessageIds] : null,
    openCodeCallMessageIds: pending.openCodeCallMessageIds ? [...pending.openCodeCallMessageIds] : null };
  snapshots.set(input.conversationId, {
    conversationId: input.conversationId, documentId: pending.documentId,
    navigationEpoch: pending.navigationEpoch, observedAt: pending.observedAt,
    shell: 'unknown', shellDiscovery: 'unknown', ordinaryFinal: null,
    pendingCompletion: copy, requestIds: [], turnId: null
  });
  while (snapshots.size > MAX_CONVERSATIONS) snapshots.delete(snapshots.keys().next().value!);
  return true;
}

/** Rehydrate diagnostics only, without promoting any restored scope to a live frame. */
export function retainNativeCompletionObservationsFromCheckpoint(conversation: string,
  values: ScopedNativeCompletionObservation[]): boolean {
  if (!conversationId(conversation) || !Array.isArray(values) || values.length === 0 ||
      values.length > CORE_NATIVE_OBSERVATION_MAX_SCOPES) return false;
  const normalized = values.map(normalizedNativeCompletionObservation);
  if (normalized.some(value => !value)) return false;
  const observations = normalized as ScopedNativeCompletionObservation[];
  // Strict identities are ASCII, so JSON length is also its UTF-8 byte length.
  if (JSON.stringify(observations).length > CORE_NATIVE_OBSERVATION_MAX_BYTES) return false;
  const latest = observations[observations.length - 1]!;
  const row = snapshots.get(conversation) ?? { conversationId: conversation, documentId: latest.documentId,
    navigationEpoch: latest.navigationEpoch, observedAt: latest.observedAt, shell: 'unknown' as const,
    shellDiscovery: 'unknown' as const, ordinaryFinal: null, requestIds: [], turnId: null };
  if (new Set(observations.map(nativeObservationScopeKey)).size !== observations.length ||
      (row.retainedObservations && JSON.stringify(row.retainedObservations) !== JSON.stringify(observations))) return false;
  row.retainedObservations = observations;
  snapshots.set(conversation, row);
  while (snapshots.size > MAX_CONVERSATIONS) snapshots.delete(snapshots.keys().next().value!);
  return true;
}

/** A failed durable clear must not expose an ACK as published completion.
 * Keep any newer native fence; otherwise restore the exact original negative
 * witness that is still owned by the private store. Never replace live work. */
export function retainNativeCompletionAfterClearFailure(conversation: string, pending: PendingNativeCompletion): boolean {
  const row = snapshots.get(conversation);
  if (!row || row.pendingCompletion) return false;
  row.pendingCompletion = { ...pending,
    openRequestIds: pending.openRequestIds ? [...pending.openRequestIds] : null,
    coreCallMessageIds: pending.coreCallMessageIds ? [...pending.coreCallMessageIds] : null,
    allCoreRequestIds: pending.allCoreRequestIds ? [...pending.allCoreRequestIds] : null,
    codeCallMessageIds: pending.codeCallMessageIds ? [...pending.codeCallMessageIds] : null,
    openCodeCallMessageIds: pending.openCodeCallMessageIds ? [...pending.openCodeCallMessageIds] : null };
  return true;
}

/** An additional unmatched legacy/source incident cannot be explained by a
 * different private original. Preserve that original's identities, but withhold
 * terminality because the complete set of outstanding parents is unverified. */
export function retainAdditionalNativeCompletionUncertainty(conversation: string): boolean {
  const row = snapshots.get(conversation);
  if (!row?.pendingCompletion) return false;
  row.pendingCompletion = { ...row.pendingCompletion, reason: 'inventory-incomplete' };
  return true;
}

type CoreBrowserEvidenceInput = Omit<CoreBrowserEvidenceSnapshot, 'shellScan' | 'ordinaryFinal' | 'pendingCompletion' | 'retainedObservations'> &
  { shellScan?: unknown; ordinaryFinal?: unknown };

function openNativeCompletion(final: OrdinaryFinalDiagnostic | null | undefined): final is OrdinaryFinalDiagnostic & {
  reason: 'open-call' | 'open-code'
} {
  return Boolean(final && final.questions > 0 &&
    ((final.reason === 'open-call' && final.openCalls > 0) ||
      (final.reason === 'open-code' && final.openCodeCalls > 0)));
}

function shellScanDiagnostic(raw: unknown): CoreShellScanDiagnostic | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const rejectsRaw = source['rejects'];
  if (!rejectsRaw || typeof rejectsRaw !== 'object' || Array.isArray(rejectsRaw)) return null;
  const rejects = rejectsRaw as Record<string, unknown>;
  const counter = (value: unknown): number | null =>
    Number.isInteger(value) && Number(value) >= 0 && Number(value) <= SHELL_SCAN_MAX ? Number(value) : null;
  const selectorMatches = counter(source['selectorMatches']);
  const mapped = counter(source['mapped']);
  const fiberMissing = counter(rejects['fiberMissing']);
  const ownerMissing = counter(rejects['ownerMissing']);
  const stableKeyMismatch = counter(rejects['stableKeyMismatch']);
  const itemsOverLimit = counter(rejects['itemsOverLimit']);
  if ([selectorMatches, mapped, fiberMissing, ownerMissing, stableKeyMismatch, itemsOverLimit]
    .some(value => value === null)) return null;
  const normalizedRejects: CoreShellScanRejects = {
    fiberMissing: fiberMissing!,
    ownerMissing: ownerMissing!,
    stableKeyMismatch: stableKeyMismatch!,
    itemsOverLimit: itemsOverLimit!
  };
  for (const key of CORE_SHELL_CALL_REJECTION_KEYS) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(rejects, key); } catch { return null; }
    if (!descriptor) continue;
    const value = counter(descriptor.value);
    if (value === null) return null;
    normalizedRejects[key] = value;
  }
  // Legacy frames omit either complete pair; a partial or impossible pair is not usable evidence.
  const receiptChecked = Object.getOwnPropertyDescriptor(normalizedRejects, 'callVetoReceiptChecked')?.value;
  const receiptMatched = Object.getOwnPropertyDescriptor(normalizedRejects, 'callVetoReceiptMatched')?.value;
  const completionVeto = Object.getOwnPropertyDescriptor(normalizedRejects, 'callCompletionVeto')?.value;
  if ((receiptChecked === undefined) !== (receiptMatched === undefined) || receiptMatched > receiptChecked ||
      (completionVeto !== undefined && receiptChecked > completionVeto)) return null;
  const assistantReceiptChecked = Object.getOwnPropertyDescriptor(normalizedRejects, 'assistantTerminalReceiptChecked')?.value;
  const assistantReceiptMatched = Object.getOwnPropertyDescriptor(normalizedRejects, 'assistantTerminalReceiptMatched')?.value;
  if ((assistantReceiptChecked === undefined) !== (assistantReceiptMatched === undefined) ||
      assistantReceiptMatched > assistantReceiptChecked) return null;
  return {
    selectorMatches: selectorMatches!,
    mapped: mapped!,
    rejects: normalizedRejects
  };
}
/** Only complete per-parent diagnostics qualify; never infer them from page-wide counters. */
function identityRefusalsDiagnostic(raw: unknown, parents: readonly string[] | null): NativeIdentityRefusal[] | null {
  try {
    if (!parents || !Array.isArray(raw) || raw.length !== parents.length) return null;
    const result: NativeIdentityRefusal[] = [];
    for (let index = 0; index < parents.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(raw, String(index))?.value;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const messageId = Object.getOwnPropertyDescriptor(entry, 'messageId')?.value;
      const codes = Object.getOwnPropertyDescriptor(entry, 'reasons')?.value;
      if (messageId !== parents[index] || !Array.isArray(codes) || codes.length > CORE_NATIVE_IDENTITY_REFUSAL_KEYS.length) return null;
      const reasons: CoreNativeIdentityRefusalKey[] = [];
      for (let at = 0; at < codes.length; at++) {
        const code = Object.getOwnPropertyDescriptor(codes, String(at))?.value;
        if (!CORE_NATIVE_IDENTITY_REFUSAL_KEYS.includes(code) || reasons.includes(code)) return null;
        reasons.push(code);
      }
      result.push({ messageId, reasons });
    }
    return result;
  } catch { return null; }
}
function ordinaryFinalDiagnostic(raw: unknown): OrdinaryFinalDiagnostic | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row['reason'] !== 'string' ||
      !['local-owner', 'busy', 'excluded-chat', 'question-invalid', 'turn-invalid', 'open-call', 'open-code', 'final-invalid', 'associated'].includes(row['reason']) ||
      typeof row['activeTurnMapped'] !== 'boolean') return null;
  const counter = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= SHELL_SCAN_MAX;
  const questions = row['questions'], calls = row['calls'], openCalls = row['openCalls'], codeCalls = row['codeCalls'], openCodeCalls = row['openCodeCalls'];
  if (!counter(questions) || !counter(calls) || !counter(openCalls) || !counter(codeCalls) || !counter(openCodeCalls) ||
      openCalls > calls || openCodeCalls > codeCalls) return null;
  // A negative current capability has priority over any positive provider
  // completion label. This defense is also necessary on direct Main input;
  // never use an unverified inventory to construct a terminal candidate.
  const inventoryIncomplete = row['callInventoryComplete'] === false;
  const reason: OrdinaryFinalDiagnostic['reason'] = inventoryIncomplete
    ? 'turn-invalid' : row['reason'] as OrdinaryFinalDiagnostic['reason'];
  const source = typeof row['sourceUserMessageId'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row['sourceUserMessageId'])
    ? row['sourceUserMessageId'] : null;
  const settledFinal = !inventoryIncomplete && ['open-call', 'associated'].includes(reason) && source &&
    typeof row['settledFinalMessageId'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row['settledFinalMessageId']) &&
    row['settledFinalMessageId'] !== source ? row['settledFinalMessageId'] : null;
  const checkpointSource = !inventoryIncomplete && reason === 'turn-invalid' && row['activeTurnMapped'] === false &&
    typeof row['checkpointSourceUserMessageId'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row['checkpointSourceUserMessageId'])
    ? row['checkpointSourceUserMessageId'] : null;
  const requestIds = reason === 'open-call' && Array.isArray(row['openRequestIds']) &&
    openCalls > 0 && openCalls <= NATIVE_COMPLETION_PROOF_MAX_CALLS && row['openRequestIds'].length === openCalls &&
    row['openRequestIds'].every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 100)
    ? [...row['openRequestIds']] as string[] : null;
  const coreMessages = Array.isArray(row['coreCallMessageIds']) && calls <= NATIVE_COMPLETION_PROOF_MAX_CALLS &&
    row['coreCallMessageIds'].length === calls &&
    row['coreCallMessageIds'].every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 200) &&
    new Set(row['coreCallMessageIds']).size === row['coreCallMessageIds'].length
    ? [...row['coreCallMessageIds']] as string[] : null;
  const allCoreIds = coreMessages && Array.isArray(row['allCoreRequestIds']) && calls <= NATIVE_COMPLETION_PROOF_MAX_CALLS &&
    row['allCoreRequestIds'].length === calls &&
    row['allCoreRequestIds'].every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 100)
    ? [...row['allCoreRequestIds']] as string[] : null;
  const identityRefusals = inventoryIncomplete ? null : identityRefusalsDiagnostic(
    Object.getOwnPropertyDescriptor(raw, 'identityRefusals')?.value, coreMessages);
  const codeIds = (name: string, expected: number): string[] | null => {
    const values = row[name];
    return Array.isArray(values) && expected >= 0 && expected <= NATIVE_COMPLETION_PROOF_MAX_CALLS && values.length === expected &&
      values.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 200) &&
      new Set(values).size === values.length ? [...values] as string[] : null;
  };
  const openCodeIds = codeIds('openCodeCallMessageIds', openCodeCalls);
  const fullCodeIds = codeIds('codeCallMessageIds', codeCalls);
  const answeredCodeIds = codeIds('answeredCodeCallMessageIds', codeCalls - openCodeCalls);
  return { reason, questions, calls, openCalls, codeCalls, openCodeCalls,
    activeTurnMapped: row['activeTurnMapped'],
    ...(inventoryIncomplete
      ? { callInventoryComplete: false as const } : {}),
    ...(source ? { sourceUserMessageId: source } : {}),
    ...(checkpointSource && coreMessages && fullCodeIds ? { checkpointSourceUserMessageId: checkpointSource } : {}),
    ...(settledFinal ? { settledFinalMessageId: settledFinal } : {}),
    ...(requestIds ? { openRequestIds: requestIds } : {}),
    ...(coreMessages ? { coreCallMessageIds: coreMessages } : {}),
    ...(identityRefusals ? { identityRefusals } : {}),
    ...(allCoreIds ? { allCoreRequestIds: allCoreIds } : {}),
    ...(fullCodeIds ? { codeCallMessageIds: fullCodeIds } : {}),
    ...(openCodeIds ? { openCodeCallMessageIds: openCodeIds } : {}),
    ...(answeredCodeIds ? { answeredCodeCallMessageIds: answeredCodeIds } : {}) };
}

/** Shared provenance check for late enrichment and passive reader diagnostics. */
function sameNativeParentSet(row: CoreBrowserEvidenceSnapshot, pending: PendingNativeCompletion,
  final: OrdinaryFinalDiagnostic | null | undefined): boolean {
  return !!(row.shellDiscovery === 'compatible' && final && pending.sourceUserMessageId &&
    row.documentId === pending.documentId && row.navigationEpoch === pending.navigationEpoch &&
    final.sourceUserMessageId === pending.sourceUserMessageId && final.calls === pending.calls &&
    final.codeCalls === pending.codeCalls && pending.coreCallMessageIds && final.coreCallMessageIds &&
    pending.coreCallMessageIds.length === final.coreCallMessageIds.length &&
    pending.coreCallMessageIds.every((messageId, at) => final.coreCallMessageIds![at] === messageId) &&
    (pending.codeCalls === 0 || (pending.codeCallMessageIds && final.codeCallMessageIds &&
      pending.codeCallMessageIds.length === pending.codeCalls && final.codeCallMessageIds.length === pending.codeCalls &&
      pending.codeCallMessageIds.every((messageId, at) => final.codeCallMessageIds![at] === messageId))));
}

export function noteCoreBrowserEvidence(input: CoreBrowserEvidenceInput): boolean {
  if (!conversationId(input.conversationId)) return false;
  const documentId = bounded(input.documentId, 200);
  if (!documentId || !Number.isInteger(input.navigationEpoch) || input.navigationEpoch < 0 ||
      !Number.isFinite(input.observedAt) || input.observedAt <= 0) return false;
  const shell: CoreBrowserShell = ['classic', 'alternate', 'unknown'].includes(input.shell)
    ? input.shell : 'unknown';
  const shellDiscovery: CoreShellDiscovery = ['compatible', 'failed', 'unknown'].includes(input.shellDiscovery)
    ? input.shellDiscovery : 'unknown';
  const requestIds = [...new Set((Array.isArray(input.requestIds) ? input.requestIds : [])
    .flatMap((value) => {
      const id = bounded(value, 100);
      return id ? [id] : [];
    }))].slice(0, 16);
  const turnId = bounded(input.turnId, 200);
  const row: CoreBrowserEvidenceSnapshot = {
    conversationId: input.conversationId,
    documentId,
    navigationEpoch: input.navigationEpoch,
    observedAt: input.observedAt,
    shell,
    shellDiscovery,
    shellScan: shellScanDiagnostic(input.shellScan),
    ordinaryFinal: ordinaryFinalDiagnostic(input.ordinaryFinal),
    requestIds,
    turnId
  };
  const previous = snapshots.get(row.conversationId);
  if (previous && previous.observedAt > row.observedAt) return false;
  const pending = previous?.pendingCompletion ?? null;
  row.retainedObservations = previous?.retainedObservations?.map(value => normalizedNativeCompletionObservation(value)!);
  const finalObservation = row.ordinaryFinal;
  if (pending && row.shellDiscovery === 'compatible' && finalObservation && finalObservation.questions > 0 &&
      finalObservation.callInventoryComplete !== false && finalObservation.sourceUserMessageId !== pending.sourceUserMessageId &&
      row.observedAt > pending.observedAt && row.turnId) {
    const observation = normalizedNativeCompletionObservation({
      documentId, navigationEpoch: row.navigationEpoch, observedAt: row.observedAt, turnId: row.turnId,
      sourceUserMessageId: finalObservation.sourceUserMessageId, reason: finalObservation.reason,
      calls: finalObservation.calls, codeCalls: finalObservation.codeCalls,
      openCalls: finalObservation.openCalls, openCodeCalls: finalObservation.openCodeCalls,
      settledFinalMessageId: finalObservation.settledFinalMessageId ?? null,
      openRequestIds: finalObservation.openCalls === 0 ? [] : finalObservation.openRequestIds,
      coreCallMessageIds: finalObservation.coreCallMessageIds, allCoreRequestIds: finalObservation.allCoreRequestIds,
      codeCallMessageIds: finalObservation.codeCallMessageIds,
      openCodeCallMessageIds: finalObservation.openCodeCallMessageIds,
      answeredCodeCallMessageIds: finalObservation.codeCalls === 0 ? [] : finalObservation.answeredCodeCallMessageIds
    });
    const retained = row.retainedObservations ?? [];
    if (observation && !retained.some(value => nativeObservationScopeKey(value) === nativeObservationScopeKey(observation))) {
      if (retained.length >= CORE_NATIVE_OBSERVATION_MAX_SCOPES ||
          JSON.stringify([...retained, observation]).length > CORE_NATIVE_OBSERVATION_MAX_BYTES) return false;
      row.retainedObservations = [...retained, observation];
    }
  }
  if (row.ordinaryFinal?.reason === 'turn-invalid' &&
      row.ordinaryFinal.callInventoryComplete === false && row.ordinaryFinal.questions > 0) {
    // This selected provider turn cannot assert that its bounded prefix
    // contains every native Core/Code Mode invocation. Do not turn absent
    // request ids or an unknown tail into a tool-free final. Its original
    // negative observation survives even if the provider reader has since
    // disappeared; shellDiscovery remains failed/unknown, never spoofed as
    // compatible. Unlike an
    // attributable result fence, this negative evidence has NO exact native
    // call identity to complete automatically; preserve it through reloads,
    // partial scans and a later completed-looking provider frame.
    // Preserve earlier debt, but an unknown census is a stronger veto:
    // completing its previously known parents cannot prove the omitted tail.
    row.pendingCompletion = pending ? { ...pending, reason: 'inventory-incomplete' } : {
      documentId, navigationEpoch: row.navigationEpoch, observedAt: row.observedAt,
      reason: 'inventory-incomplete', calls: row.ordinaryFinal.calls,
      codeCalls: row.ordinaryFinal.codeCalls,
      openCalls: row.ordinaryFinal.openCalls,
      openCodeCalls: row.ordinaryFinal.openCodeCalls,
      // The selected native user is a provenance witness, not proof that
      // the omitted Core/Code Mode parents or results have been enumerated.
      sourceUserMessageId: row.ordinaryFinal.sourceUserMessageId ?? null, openRequestIds: null,
      coreCallMessageIds: null, allCoreRequestIds: null,
      codeCallMessageIds: null, openCodeCallMessageIds: null
    };
  } else if (!pending && row.shellDiscovery === 'compatible' && openNativeCompletion(row.ordinaryFinal)) {
    row.pendingCompletion = {
      documentId, navigationEpoch: row.navigationEpoch, observedAt: row.observedAt,
      reason: row.ordinaryFinal.reason, calls: row.ordinaryFinal.calls, codeCalls: row.ordinaryFinal.codeCalls,
      openCalls: row.ordinaryFinal.openCalls,
      openCodeCalls: row.ordinaryFinal.openCodeCalls,
      sourceUserMessageId: row.ordinaryFinal.sourceUserMessageId ?? null,
      openRequestIds: row.ordinaryFinal.openCalls > 0 ? row.ordinaryFinal.openRequestIds ?? null : [],
      coreCallMessageIds: row.ordinaryFinal.calls > 0 ? row.ordinaryFinal.coreCallMessageIds ?? null : [],
      allCoreRequestIds: row.ordinaryFinal.calls > 0 ? row.ordinaryFinal.allCoreRequestIds ?? null : [],
      codeCallMessageIds: row.ordinaryFinal.codeCalls > 0 ? row.ordinaryFinal.codeCallMessageIds ?? null : [],
      openCodeCallMessageIds: row.ordinaryFinal.openCodeCalls > 0
        ? row.ordinaryFinal.openCodeCallMessageIds ?? null : []
    };
  } else if (pending) {
    // A new/reloaded document's "Response complete", missing shell, or a
    // different turn's completed reply does not prove the earlier MCP result.
    // A later associated native final in the SAME document may belong to a different
    // question; even the correct one may precede durable MCP results. Main alone
    // acknowledges completion after the exact question and stored request results agree.
    const final = row.ordinaryFinal;
    const sameNativeCalls = sameNativeParentSet(row, pending, final);
    // Late request IDs can become available after the original open-call scan.
    // Enrich ONLY a known original set of native message IDs on the SAME
    // document+question with the SAME complete Core AND Code Mode parent
    // inventories. Validate the whole witness before changing any retained
    // field: a conflicting mixed census must not pin a late workflow forever
    // and prevent a subsequent valid original result from being reconciled.
    const allCoreRequestIds = pending.allCoreRequestIds ??
      (sameNativeCalls && final?.allCoreRequestIds ? [...final.allCoreRequestIds] : null);
    row.pendingCompletion = { ...pending,
      allCoreRequestIds,
      openRequestIds: pending.openRequestIds ? [...pending.openRequestIds] : null,
      coreCallMessageIds: pending.coreCallMessageIds ? [...pending.coreCallMessageIds] : null,
      codeCallMessageIds: pending.codeCallMessageIds ? [...pending.codeCallMessageIds] : null,
      openCodeCallMessageIds: pending.openCodeCallMessageIds ? [...pending.openCodeCallMessageIds] : null };
  }
  snapshots.delete(row.conversationId);
  snapshots.set(row.conversationId, row);
  while (snapshots.size > MAX_CONVERSATIONS) snapshots.delete(snapshots.keys().next().value!);
  return true;
}

/**
 * Positive current native reply, separately from unresolved per-tool completion.
 * This grants no action: the explicit Loop policy and durable source/outbox/physical-work
 * gates in Bridge still have to agree. Never changes the original pending fence.
 */
export function settledNativeTurnCandidate(conversation: string, now = Date.now()): {
  observedAt: number; documentId: string; navigationEpoch: number;
  sourceUserMessageId: string; finalMessageId: string;
  coreCallMessageIds: string[]; codeCallMessageIds: string[]
} | null {
  const row = snapshots.get(conversation), final = row?.ordinaryFinal;
  if (!row || !final || !Number.isFinite(now) || row.observedAt > now ||
      now - row.observedAt > CORE_BROWSER_EVIDENCE_MAX_AGE_MS ||
      row.shellDiscovery !== 'compatible' || final.activeTurnMapped ||
      !['open-call', 'associated'].includes(final.reason) || final.questions < 1 ||
      !final.sourceUserMessageId || !final.settledFinalMessageId ||
      final.sourceUserMessageId === final.settledFinalMessageId || final.openCodeCalls !== 0 ||
      !final.coreCallMessageIds || final.coreCallMessageIds.length !== final.calls ||
      (final.codeCalls > 0 && (!final.codeCallMessageIds || !final.answeredCodeCallMessageIds ||
        final.codeCallMessageIds.length !== final.codeCalls ||
        final.answeredCodeCallMessageIds.length !== final.codeCalls ||
        final.codeCallMessageIds.some(id => !final.answeredCodeCallMessageIds!.includes(id))))) return null;
  return { observedAt: row.observedAt, documentId: row.documentId, navigationEpoch: row.navigationEpoch,
    sourceUserMessageId: final.sourceUserMessageId, finalMessageId: final.settledFinalMessageId,
    coreCallMessageIds: [...final.coreCallMessageIds], codeCallMessageIds: [...final.codeCallMessageIds ?? []] };
}

/** Candidate for the incumbent Bridge's durable-tool-result check. Browser prose is not proof. */
export function nativeCompletionCandidate(conversation: string): {
  observedAt: number; pendingObservedAt: number; reason: PendingNativeCompletion['reason'];
  openCalls: number; allCoreRequestIds: string[] | null; coreCallMessageIds: string[] | null
} | null {
  const row = snapshots.get(conversation);
  const pending = row?.pendingCompletion;
  const final = row?.ordinaryFinal;
  // A later complete-looking provider frame cannot turn an unknown inventory
  // into a known original parent set, even when the exact user UUID agrees.
  // This candidate is exclusively for an originally COMPLETE tool census.
  if (!row || !pending || pending.reason === 'inventory-incomplete' || !pending.sourceUserMessageId || !final ||
      row.documentId !== pending.documentId || row.navigationEpoch !== pending.navigationEpoch ||
      row.shellDiscovery !== 'compatible' || final.reason !== 'associated' || final.questions < 1 ||
      final.openCalls !== 0 || final.openCodeCalls !== 0 ||
      final.sourceUserMessageId !== pending.sourceUserMessageId ||
      final.calls !== pending.calls || final.codeCalls !== pending.codeCalls ||
      (pending.calls > 0 &&
        (!pending.coreCallMessageIds || !pending.allCoreRequestIds ||
          pending.coreCallMessageIds.length !== pending.calls ||
          pending.allCoreRequestIds.length !== pending.calls ||
          !final.coreCallMessageIds || !final.allCoreRequestIds ||
          pending.coreCallMessageIds.some((id, at) => final.coreCallMessageIds![at] !== id) ||
          pending.allCoreRequestIds.some((id, at) => final.allCoreRequestIds![at] !== id))) ||
      // The entire original Code Mode parent set matters: an initially
      // *answered* parent might disappear while a different parent appears
      // before final. Checking only the initially open parent would then
      // promote a substituted result. Every original parent must persist
      // and have its own native result in the validated final frame.
      (pending.codeCalls > 0 && (!pending.codeCallMessageIds || !final.codeCallMessageIds ||
        !final.answeredCodeCallMessageIds || pending.codeCallMessageIds.length !== pending.codeCalls ||
        final.codeCallMessageIds.length !== pending.codeCalls ||
        pending.codeCallMessageIds.some((id, at) => final.codeCallMessageIds![at] !== id ||
          !final.answeredCodeCallMessageIds!.includes(id)))) ||
      (pending.openCodeCalls > 0 && (!pending.openCodeCallMessageIds ||
        pending.openCodeCallMessageIds.length !== pending.openCodeCalls ||
        !final.answeredCodeCallMessageIds ||
        pending.openCodeCallMessageIds.some(id => !final.answeredCodeCallMessageIds!.includes(id))))) return null;
  return { observedAt: row.observedAt, pendingObservedAt: pending.observedAt,
    reason: pending.reason, openCalls: pending.openCalls,
    allCoreRequestIds: pending.allCoreRequestIds ? [...pending.allCoreRequestIds] : null,
    coreCallMessageIds: pending.coreCallMessageIds ? [...pending.coreCallMessageIds] : null };
}

export interface NativeRequestIdentityDiagnostic {
  status: 'complete-original' | 'reader-withheld' | 'native-field-missing' | 'unverified';
  selectedFieldsPresent: number | null;
  selectedFieldsMissing: number | null;
  selectedIdentitiesWithheld: number | null;
  scopeRefusals: number | null;
  failureReasons?: { code: CoreNativeIdentityRefusalKey; calls: number }[] | null;
}

/** A missing admitted array does not prove provider metadata was absent. Only expose
 * reader counts for the very same original native parent set; never borrow stream IDs,
 * another question's counts or a later document to repair the retained fence. */
function nativeRequestIdentityDiagnostic(row: CoreBrowserEvidenceSnapshot,
  pending: PendingNativeCompletion | null | undefined): NativeRequestIdentityDiagnostic {
  const sameParents = pending && sameNativeParentSet(row, pending, row.ordinaryFinal);
  // Shell counters aggregate every mounted question, unlike the exact per-parent
  // refusal witness below. Matching the current final cannot scope page totals.
  const singleShell = row.shellScan?.selectorMatches === 1 && row.shellScan.mapped === 1;
  const counters = sameParents && singleShell ? row.shellScan?.rejects : null;
  const witness = sameParents ? row.ordinaryFinal?.identityRefusals : null;
  const failureReasons = witness ? CORE_NATIVE_IDENTITY_REFUSAL_KEYS.map(code =>
    ({ code, calls: witness.filter(call => call.reasons.includes(code)).length })).filter(item => item.calls > 0) : null;
  const shape = { selectedFieldsPresent: counters?.callRequestIdPresent ?? null,
    selectedFieldsMissing: counters?.callRequestIdMissing ?? null,
    selectedIdentitiesWithheld: counters?.callIdentitySelectedWithheld ?? null,
    scopeRefusals: counters?.callIdentityScopeUnproved ?? null };
  let status: NativeRequestIdentityDiagnostic['status'] = 'unverified';
  if (pending?.allCoreRequestIds && pending.allCoreRequestIds.length === pending.calls) status = 'complete-original';
  else if (pending && shape.selectedFieldsPresent !== null && shape.selectedFieldsMissing !== null &&
      shape.selectedFieldsPresent + shape.selectedFieldsMissing === pending.calls) {
    if (shape.selectedFieldsPresent > 0 && shape.selectedIdentitiesWithheld !== null &&
        shape.selectedIdentitiesWithheld > 0 && shape.selectedIdentitiesWithheld <= pending.calls) status = 'reader-withheld';
    else if (shape.selectedFieldsPresent === 0 && shape.selectedFieldsMissing > 0) status = 'native-field-missing';
  }
  return { status, ...shape, failureReasons };
}

/** Shape-only explanation of the existing candidate gate. Never completion or recovery authority. */
export interface NativeCompletionDiagnostic {
  reason: 'no-retained-fence' | 'inventory-incomplete' | 'original-source-missing' |
    'original-native-identity-missing' | 'original-request-identity-missing' | 'document-changed' |
    'question-changed' | 'parents-changed' | 'reader-unverified' | 'native-final-unverified' |
    'native-results-open' | 'native-proof-unverified' | 'durable-proof-required';
  retainedCalls: number; retainedCodeCalls: number;
  missingOriginalNativeIds: number; missingOriginalRequestIds: number;
  requestIdentity: NativeRequestIdentityDiagnostic;
  observation?: { observedAt: number; ageMs: number | null; freshness: 'fresh' | 'stale' | 'future' | 'unverified' };
}
function nativeCompletionDiagnosticFor(row: CoreBrowserEvidenceSnapshot, now: number): NativeCompletionDiagnostic {
  const validClock = Number.isFinite(now) && Number.isFinite(row.observedAt) && row.observedAt > 0;
  const ageMs = validClock && now >= row.observedAt ? now - row.observedAt : null;
  const freshness = !validClock ? 'unverified' : ageMs === null ? 'future'
    : ageMs > CORE_BROWSER_EVIDENCE_MAX_AGE_MS ? 'stale' : 'fresh';
  const pending = row.pendingCompletion, final = row.ordinaryFinal;
  const shape = { retainedCalls: pending?.calls ?? 0, retainedCodeCalls: pending?.codeCalls ?? 0,
    missingOriginalNativeIds: pending ? Math.max(0, pending.calls - (pending.coreCallMessageIds?.length ?? 0)) +
      Math.max(0, pending.codeCalls - (pending.codeCallMessageIds?.length ?? 0)) : 0,
    // Legacy field: calls lacking a COMPLETE admitted mapping, not a count of absent native metadata.
    missingOriginalRequestIds: pending ? Math.max(0, pending.calls - (pending.allCoreRequestIds?.length ?? 0)) : 0,
    requestIdentity: nativeRequestIdentityDiagnostic(row, pending),
    observation: { observedAt: row.observedAt, ageMs, freshness } as NonNullable<NativeCompletionDiagnostic['observation']> };
  const result = (reason: NativeCompletionDiagnostic['reason']) => ({ reason, ...shape });
  if (!pending) return result('no-retained-fence');
  if (pending.reason === 'inventory-incomplete') return result('inventory-incomplete');
  if (!pending.sourceUserMessageId) return result('original-source-missing');
  if (row.documentId !== pending.documentId || row.navigationEpoch !== pending.navigationEpoch)
    return result('document-changed');
  if (final?.sourceUserMessageId && final.sourceUserMessageId !== pending.sourceUserMessageId)
    return result('question-changed');
  if (shape.missingOriginalNativeIds) return result('original-native-identity-missing');
  if (shape.missingOriginalRequestIds) return result('original-request-identity-missing');
  const changed = (original: string[] | null, current: string[] | undefined) =>
    !!original?.length && (!current || original.length !== current.length || original.some((id, at) => current[at] !== id));
  if (final && (pending.calls !== final.calls || pending.codeCalls !== final.codeCalls ||
      changed(pending.coreCallMessageIds, final.coreCallMessageIds) ||
      changed(pending.allCoreRequestIds, final.allCoreRequestIds) ||
      changed(pending.codeCallMessageIds, final.codeCallMessageIds))) return result('parents-changed');
  if (row.shellDiscovery !== 'compatible') return result('reader-unverified');
  if (final && (final.openCalls > 0 || final.openCodeCalls > 0)) return result('native-results-open');
  if (!final || final.reason !== 'associated' || final.questions < 1 || !final.sourceUserMessageId)
    return result('native-final-unverified');
  // The actual gate remains the sole authority; a diagnostic fallback cannot create a candidate.
  const candidate = nativeCompletionCandidate(row.conversationId);
  return result(candidate?.observedAt === row.observedAt ? 'durable-proof-required' : 'native-proof-unverified');
}
export function nativeCompletionDiagnostic(conversation: string, now = Date.now()): NativeCompletionDiagnostic | null {
  const row = snapshots.get(conversation);
  return row ? nativeCompletionDiagnosticFor(row, now) : null;
}

/** Acknowledge only the unchanged candidate after Main has read the durable tool-call tail. */
export function acknowledgeNativeCompletion(conversation: string, observedAt: number,
  pendingObservedAt: number, confirmedRequestIds: readonly string[], confirmedNativeIds?: readonly string[]): boolean {
  const candidate = nativeCompletionCandidate(conversation);
  if (!candidate || candidate.observedAt !== observedAt || candidate.pendingObservedAt !== pendingObservedAt) return false;
  if (candidate.allCoreRequestIds === null ||
      confirmedRequestIds.length !== candidate.allCoreRequestIds.length ||
      candidate.allCoreRequestIds.some(id => !confirmedRequestIds.includes(id))) return false;
  if (confirmedNativeIds ?
      !candidate.coreCallMessageIds || confirmedNativeIds.length !== candidate.coreCallMessageIds.length ||
        confirmedNativeIds.some((id, at) => id !== candidate.coreCallMessageIds![at] ||
          confirmedRequestIds[at] !== candidate.allCoreRequestIds![at]) :
      new Set(candidate.allCoreRequestIds).size !== candidate.allCoreRequestIds.length) return false;
  const row = snapshots.get(conversation);
  if (!row) return false;
  row.pendingCompletion = null;
  return true;
}

export function coreBrowserEvidence(conversation: string): CoreBrowserEvidenceSnapshot | null {
  const row = snapshots.get(conversation);
  return row ? {
    ...row,
    shellScan: row.shellScan ? { ...row.shellScan, rejects: { ...row.shellScan.rejects } } : null,
    // The returned snapshot is observational. Neither a renderer nor a
    // diagnostic caller may mutate the retained identity arrays while Main
    // is awaiting a durable MCP result on a separate HTTP request.
    ordinaryFinal: row.ordinaryFinal ? { ...row.ordinaryFinal,
      ...(row.ordinaryFinal.identityRefusals ? { identityRefusals: row.ordinaryFinal.identityRefusals.map(item =>
        ({ messageId: item.messageId, reasons: [...item.reasons] })) } : {}),
      ...(row.ordinaryFinal.openRequestIds ? { openRequestIds: [...row.ordinaryFinal.openRequestIds] } : {}),
      ...(row.ordinaryFinal.coreCallMessageIds ? { coreCallMessageIds: [...row.ordinaryFinal.coreCallMessageIds] } : {}),
      ...(row.ordinaryFinal.allCoreRequestIds ? { allCoreRequestIds: [...row.ordinaryFinal.allCoreRequestIds] } : {}),
      ...(row.ordinaryFinal.codeCallMessageIds ? { codeCallMessageIds: [...row.ordinaryFinal.codeCallMessageIds] } : {}),
      ...(row.ordinaryFinal.openCodeCallMessageIds ? { openCodeCallMessageIds: [...row.ordinaryFinal.openCodeCallMessageIds] } : {}),
      ...(row.ordinaryFinal.answeredCodeCallMessageIds ? { answeredCodeCallMessageIds: [...row.ordinaryFinal.answeredCodeCallMessageIds] } : {})
    } : null,
    pendingCompletion: row.pendingCompletion ? { ...row.pendingCompletion,
      openRequestIds: row.pendingCompletion.openRequestIds ? [...row.pendingCompletion.openRequestIds] : null,
      coreCallMessageIds: row.pendingCompletion.coreCallMessageIds ? [...row.pendingCompletion.coreCallMessageIds] : null,
      allCoreRequestIds: row.pendingCompletion.allCoreRequestIds ? [...row.pendingCompletion.allCoreRequestIds] : null,
      codeCallMessageIds: row.pendingCompletion.codeCallMessageIds ? [...row.pendingCompletion.codeCallMessageIds] : null,
      openCodeCallMessageIds: row.pendingCompletion.openCodeCallMessageIds ?
        [...row.pendingCompletion.openCodeCallMessageIds] : null } : null,
    ...(row.retainedObservations ? { retainedObservations: row.retainedObservations.map(value =>
      normalizedNativeCompletionObservation(value)!) } : {}),
    requestIds: [...row.requestIds]
  } : null;
}

/** Fail-closed wait, never permission to send or recover. Staleness cannot prove resolution. */
export function nativeFinalEvidenceWait(
  evidence: CoreBrowserEvidenceSnapshot | null,
  now = Date.now()
): import('../shared/goal.js').GoalWait | null {
  const pending = evidence?.pendingCompletion;
  if (!evidence || !pending || !Number.isFinite(now) ||
      !Number.isFinite(pending.observedAt) || pending.observedAt <= 0) return null;
  // A small NTP/manual clock reversal, or a timestamp accepted just before
  // the caller sampled now, cannot turn an unverified result into a release.
  // Future stamps are uncertain/stale, NEVER completion evidence.
  // The unresolved fence keeps its original age for custody; freshness describes the
  // latest browser observation, not how long that original result has been missing.
  const stale = !Number.isFinite(evidence.observedAt) || evidence.observedAt <= 0 ||
    evidence.observedAt > now || pending.observedAt > now ||
    now - evidence.observedAt > CORE_BROWSER_EVIDENCE_MAX_AGE_MS;
  const final = evidence.ordinaryFinal;
  const changed = (original: string[] | null, observed?: string[]): boolean =>
    original !== null && original.length > 0 && (!observed || original.length !== observed.length ||
      original.some((id, index) => observed[index] !== id));
  // The browser may show Response complete while its original call is still
  // missing. Distinguish a *changed native identity* from simple late
  // publication in the existing GoalWait projection; never display the
  // private message/request ids, infer Send, or add a new diagnostic owner.
  const identitiesChanged = !stale && !!final && final.reason === 'associated' &&
    (evidence.documentId !== pending.documentId || evidence.navigationEpoch !== pending.navigationEpoch ||
      (!!pending.sourceUserMessageId && final.sourceUserMessageId !== pending.sourceUserMessageId) ||
      final.calls !== pending.calls || final.codeCalls !== pending.codeCalls ||
      changed(pending.coreCallMessageIds, final.coreCallMessageIds) ||
      changed(pending.allCoreRequestIds, final.allCoreRequestIds) ||
      changed(pending.codeCallMessageIds, final.codeCallMessageIds));
  const diagnostic = nativeCompletionDiagnosticFor(evidence, now);
  const blockers: Partial<Record<NativeCompletionDiagnostic['reason'], string>> = {
    'original-source-missing': 'The original native question was not observed.',
    'original-native-identity-missing': 'Original native call identifiers were not captured.',
    'original-request-identity-missing': 'Original tool-request associations remain unverified.',
    'document-changed': 'The browser document changed after the unresolved result.',
    'question-changed': 'The native question changed after the unresolved result.',
    'parents-changed': 'The native call inventory changed after the unresolved result.',
    'reader-unverified': 'The native page reader is not verified compatible.'
  };
  const reasons = !stale ? diagnostic.requestIdentity.failureReasons : null;
  const checks = reasons?.map(item => `${item.code.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} (${item.calls})`).join(', ');
  const observation = diagnostic.observation;
  const freshnessDetail = observation?.ageMs !== null && observation?.ageMs !== undefined
    ? `Browser evidence: ${Math.floor(observation.ageMs / 1000)}s old (${observation.freshness}).`
    : 'Browser evidence freshness is unknown; its observation clock is unverified.';
  return {
    reason: 'evidence',
    detail: [stale
      ? 'CoS last observed an unresolved native tool result, but that browser observation is stale and current activity is unknown. Elapsed time is not a completion receipt.'
      : pending.reason === 'inventory-incomplete'
        ? 'This native turn exposed only an incomplete Core/Code Mode call inventory. The number and completion of omitted native invocations are unknown; a later final-looking page cannot verify the original tool results.'
      : identitiesChanged
        ? 'The native question or tool identities changed since an unresolved Core/Code Mode call. The original result still has no exact terminal receipt.'
      : 'CoS cannot verify this final answer because exact native tool completion remains unresolved. This wait is not proof that work is running.',
      `Blocker: ${diagnostic.reason}.`, blockers[diagnostic.reason],
      checks ? `Native identity checks: ${checks}.` : null, freshnessDetail].filter(Boolean).join(' '),
    nextAction: 'Keep the current chat and saved work. Inspect its native tool/error state before a deliberate continuation; this status authorizes no replay.'
  };
}

export function resetCoreBrowserEvidenceForTests(): void {
  snapshots.clear();
}

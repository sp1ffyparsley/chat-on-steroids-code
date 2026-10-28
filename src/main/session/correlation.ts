/**
 * The single ownership join between ChatGPT's page model and an inbound MCP request.
 *
 * ChatGPT puts one opaque request id in both places:
 *   - HTTP `x-request-id` on the MCP request (normalised at ingress), and
 *   - `message.metadata.request_id` on the connector request in the page model.
 *
 * UUID version-only spellings share the documented upstream #1752/#1873 lookup key.
 * Original IDs stay stored; this grants no tool-completion proof and cannot fill missing IDs.
 * Nothing else is ownership evidence. In particular, tool names, timestamps, rendered
 * connector rows, the active tab and "the only chat generating" never enter this registry.
 *
 * Once that exact join has been proved it is permanent. `request_id` names one ChatGPT
 * workflow, and the MCP side may keep issuing calls after the page that originally exposed the
 * id has been reloaded, compacted or closed. Expiring the join after ten minutes was the live
 * 1.8.1 bug: the same still-running request went from correctly attributed to Unattributed
 * solely because its browser evidence aged out. A proven owner therefore has no time TTL - and
 * no later observation can move or erase it either.
 *
 * A second conversation claiming a proven id is a page that is wrong about itself: a React tree
 * still mounted from the chat before it, a fresh chat whose client-side thread id has not yet
 * become the server's, an id the site reused. The answer to a page that is wrong is to refuse
 * the claimant, not to disown a request whose calls are still arriving. Disowning it was the
 * visible failure: one contradicting sighting nulled the owner for good, and from then on every
 * call under that id waited fifteen seconds for evidence that could no longer be accepted and
 * landed in Unattributed activity. First proof wins, and it keeps winning.
 */

import { readDurableStrict, writeDurableNow, writeDurableSnapshotSoon } from '../durable.js';
import { indexedSessions, readRecentEvents } from './store.js';

export interface RequestCorrelation {
  requestId: string;
  conversationId: string;
  /** Durable local session epoch that owned this request when the page first proved it. */
  sessionId: string;
  messageId: string;
  /** First positively observed native Core invocation if the first sighting was rowless. */
  nativeCallMessageId?: string;
  /** More than one positively named native tool invocation shared this workflow id.
   * A workflow-level MCP result cannot identify which one returned. */
  nativeCallAmbiguous?: true;
  /** Exact recorder/native turn named with this request; absent on older or rowless proof. */
  turnId?: string;
  tool: string;
  observedAt: number;
}

const MAX_CORRELATIONS = 50_000;
const CORRELATIONS_STATE = 'request-correlations';
/**
 * 5 stores owners and nothing else; 6 also records that browser acknowledgements wait for
 * the snapshot, allowing startup to trust it without replaying canonical history.
 *
 * Versions 3 and 4 wrapped each row in a sticky `conflicted` flag, so a row could exist purely
 * to record that its id was unusable. Those rows say nothing this registry can act on any more:
 * read the owner out of the wrapper when one is there, and let a forgotten id be proved again
 * by exact evidence or by the recorded history reconciled below.
 */
const CORRELATIONS_STATE_VERSION = 6;

const byRequest = new Map<string, RequestCorrelation>();
const waiters = new Map<string, Set<() => void>>();
/**
 * Evidence grace belongs to the request, not each tool call in its workflow. All callers
 * measure their allowance from its first wait, so sequential and overlapping calls cannot
 * restart the clock. Keep the start rather than a spent flag: the recorder's longer grace
 * must remain available after a shorter identity lookup expires. This is only wait accounting,
 * never a negative ownership verdict; exact evidence always wins, even after every deadline.
 * Process-local and bounded: a restart or eviction may grant fresh grace, never an owner.
 */
const evidenceWindowStarts = new Map<string, number>();
const MAX_EVIDENCE_WINDOWS = 2_000;
let restored = false;
let restoring: Promise<void> | null = null;
// One monotonic snapshot epoch for the incumbent correlation owner. Failed ACK
// commits must remain owed even if the same native message is reported again:
// an unchanged in-memory lookup cannot prove the earlier disk write succeeded.
let correlationRevision = 0;
let committedCorrelationRevision = 0;
let correlationCommitQueue: Promise<void> = Promise.resolve();

interface PersistedCorrelations {
  version: number;
  /** Version 6 snapshots crossed the browser acknowledgement durability barrier. */
  complete?: boolean;
  entries: RequestCorrelation[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Upstream #1873/#1752: the provider may alter only the UUID version digit
 * between native metadata and MCP ingress. Keep original IDs in stored owners;
 * use one prefixed lookup key so opaque IDs cannot collide with UUID aliases.
 * This joins workflow ownership only, never an individual tool completion. */
function joinKey(requestId: string): string {
  return UUID.test(requestId)
    ? `uuid:${requestId.slice(0, 14)}${requestId.slice(15)}`.toLowerCase()
    : `id:${requestId}`;
}

function wake(key: string): void {
  const held = waiters.get(key);
  if (!held) return;
  waiters.delete(key);
  for (const resolve of held) resolve();
}

function trim(): void {
  while (byRequest.size > MAX_CORRELATIONS) {
    const first = byRequest.keys().next().value as string | undefined;
    if (!first) break;
    byRequest.delete(first);
    wake(first);
  }
}

function snapshot(): PersistedCorrelations {
  return {
    version: CORRELATIONS_STATE_VERSION,
    complete: true,
    entries: [...byRequest.values()].map((owner) => ({ ...owner }))
  };
}

function persist(): void {
  writeDurableSnapshotSoon(CORRELATIONS_STATE, snapshot);
}

/**
 * Whether a persisted row still carries everything an owner needs to be restored.
 *
 * The bar is exactly what this registry answers with: a request id, the conversation that
 * proved it, the session epoch that owned it, and when. `tool` is a diagnostic label, kept so
 * a stored row can be read by a human; no caller reads it, and the header above says why it
 * could not be evidence even if one did. Demanding a nonempty one here was therefore a bar the
 * registry itself does not have - and it silently deleted the rows that need restoring most.
 *
 * A request id is published on `message.metadata.request_id` before the `api_tool` message
 * naming the tool exists, so the page proves ownership first and names the tool later. Those
 * early sightings are stored with an empty tool on purpose - the join does not use the name,
 * and waiting for it is what used to file the call under Unattributed activity. Every one of
 * them then failed this check on the next launch, so a workflow whose calls were still arriving
 * lost its proven owner to a restart: the same permanence bug the header describes, arriving
 * through the door marked valid.
 */
function validCorrelation(value: unknown): value is RequestCorrelation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RequestCorrelation>;
  return (
    typeof item.requestId === 'string' && item.requestId.length > 0 && item.requestId.length <= 200 &&
    typeof item.conversationId === 'string' && item.conversationId.length > 0 && item.conversationId.length <= 200 &&
    typeof item.sessionId === 'string' && /^[0-9a-z-]{8,64}$/i.test(item.sessionId) &&
    typeof item.messageId === 'string' && item.messageId.length > 0 && item.messageId.length <= 300 &&
    typeof item.tool === 'string' && item.tool.length <= 100 &&
    typeof item.observedAt === 'number' && Number.isFinite(item.observedAt)
  );
}

/**
 * The owner in a persisted row, whatever shape the version that wrote it used.
 *
 * Versions 3 and 4 wrapped it as `{ requestId, value, conflicted }`, where a row with no value
 * was a sticky contradiction. Version 5 stores the owner itself. A wrapper with no usable value
 * carries no owner and is simply dropped, which is all that forgetting an old conflict takes.
 */
function storedOwner(raw: unknown): RequestCorrelation | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = 'value' in (raw as Record<string, unknown>) ? (raw as { value: unknown }).value : raw;
  if (!validCorrelation(value)) return null;
  const owner = { ...value };
  // Bad optional turn metadata must not destroy an otherwise valid historical request owner.
  // It stays unknown, never finish authority or a guess from the currently selected page.
  if (!validTurnId(owner.turnId)) delete owner.turnId;
  if (typeof owner.nativeCallMessageId !== 'string' ||
      owner.nativeCallMessageId.length === 0 || owner.nativeCallMessageId.length > 300)
    delete owner.nativeCallMessageId;
  if (owner.nativeCallAmbiguous !== true) delete owner.nativeCallAmbiguous;
  return owner;
}

function validTurnId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && /\S/u.test(value);
}

/**
 * Files one sighting against the permanent owner of its request id.
 *
 * Live ChatGPT gives every connector request in one turn the same request_id. messageId and
 * tool identify individual calls inside that turn, so differences there are expected and change
 * nothing. Conversation/session ownership remains first-proof-wins. The optional exact turn
 * also keeps its first proof; it may only enrich legacy unknown identity in that same session.
 *
 * The session epoch is first-proof-wins for the same conversation as well. Compact & Resume can
 * leave the old page model mounted while a newer local session epoch exists for that same old
 * conversation id, and re-observing the request from that stale page must not drag an in-flight
 * request into the newer epoch.
 */
function merge(input: RequestCorrelation, source: 'page' | 'restore' = 'page'): 'stored' | 'same' | 'refused' {
  const previous = byRequest.get(joinKey(input.requestId));
  if (!previous) {
    const owner = { ...input };
    if (!validTurnId(owner.turnId)) delete owner.turnId;
    byRequest.set(joinKey(input.requestId), owner);
    evidenceWindowStarts.delete(joinKey(input.requestId));
    trim();
    wake(joinKey(input.requestId));
    return 'stored';
  }

  // Refused, and nothing else: an opaque workflow id belongs to the ORIGINAL
  // conversation AND local session epoch. The same Chrome conversation can be
  // reopened/rebound into another session while an old result is still pending.
  // Treating that later epoch as "same" refreshed the old proof's timestamp and
  // let /correlations ACK a result for the wrong saved Loop obligation.
  // Neither conflicting claimant may renew or overwrite the old owner's proof.
  if (previous.conversationId !== input.conversationId ||
      previous.sessionId !== input.sessionId) return 'refused';

  // Request IDs identify a WHOLE native workflow, not a Core tool invocation.
  // A second positively named provider message under one ID proves that one
  // recorded MCP result cannot settle either specific native call. Retain that
  // negative fact in the existing durable correlation owner across reconnect and
  // restart. Untooled early request sightings, and synthetic message IDs rebuilt
  // from MCP history, are not additional native invocations.
  const typedNative = source === 'page' && Boolean(input.tool && input.messageId &&
    !input.messageId.startsWith('stream:') && !input.messageId.startsWith('stored:'));
  if (typedNative && !previous.nativeCallAmbiguous) {
    const firstNative = previous.nativeCallMessageId ??
      (previous.tool && !previous.messageId.startsWith('stream:') &&
        !previous.messageId.startsWith('stored:') ? previous.messageId : null);
    if (!firstNative) {
      previous.nativeCallMessageId = input.messageId;
      // An early rowless request proved its workflow owner, not a native
      // tool type. Upgrade that hint only with the first independently named
      // tool message. A matching workflow result cannot satisfy a different
      // tool's pending native final after this proof.
      previous.tool = input.tool;
    } else if (firstNative !== input.messageId ||
        (previous.tool && previous.tool !== input.tool)) {
      // One native message changing tool type is just as unsafe as two native
      // messages sharing this workflow. Keep the negative evidence sticky.
      previous.nativeCallAmbiguous = true;
    } else if (!previous.tool) {
      // Already-committed older v6 snapshots can contain the exact native
      // message ID but not its tool type. Re-observing that SAME positively
      // named tool safely enriches it; it is not a second invocation.
      previous.tool = input.tool;
    }
  }

  if (!previous.turnId && previous.sessionId === input.sessionId && validTurnId(input.turnId)) {
    previous.turnId = input.turnId;
  }

  if (input.observedAt > previous.observedAt) {
    previous.observedAt = input.observedAt;
    // trim() uses insertion order as the bounded registry's freshness order. Updating the
    // timestamp without moving this key left a live, repeatedly observed old request at the
    // eviction head, so enough newer ids could discard it while genuinely stale ids stayed.
    byRequest.delete(joinKey(input.requestId));
    byRequest.set(joinKey(input.requestId), previous);
  }
  return 'same';
}

/**
 * Restores request ownership before the bridge starts accepting page/MCP traffic.
 *
 * 1.8.2 persists this index directly. On the first 1.8.2 launch there is no index yet, so
 * rebuild it once from already-recorded request_id-attributed tool calls. Those records are
 * themselves the result of the exact page↔HTTP join, and let an old still-running workflow
 * remain owned across the upgrade even if its original tab is already gone.
 */
export async function restoreRequestCorrelations(): Promise<void> {
  if (restored) return;
  if (restoring) return restoring;
  restoring = restoreRequestCorrelationsOnce();
  try {
    await restoring;
    restored = true;
  } finally {
    restoring = null;
  }
}

async function restoreRequestCorrelationsOnce(): Promise<void> {

  // This index carries *negative* native-completion authority too: a committed
  // shared-workflow sibling veto cannot be reconstructed from tool-call JSONL,
  // which contains only the workflow request ID. A transient unreadable or
  // malformed index must therefore hold recovery rather than become an
  // apparently empty owner ledger and incorrectly release a native final.
  const saved = await readDurableStrict<PersistedCorrelations>(CORRELATIONS_STATE);
  let loaded = false;
  const completeIds = new Set<string>();
  // A committed v6 snapshot is the entire native-call *negative* evidence
  // ledger. Legacy migrations may drop invalid optional hints, but v6 may not:
  // silently normalizing a damaged nativeCallAmbiguous flag back to absent
  // would release a sibling's result after restart. Nor may duplicate request
  // owners make the first (possibly less restrictive) entry win.
  const complete = saved?.version === CORRELATIONS_STATE_VERSION && saved.complete === true &&
    Array.isArray(saved.entries) && saved.entries.length <= MAX_CORRELATIONS && saved.entries.every((raw) => {
      const owner = storedOwner(raw);
      if (!owner || !raw || typeof raw !== 'object' || 'value' in raw ||
          completeIds.has(joinKey(owner.requestId))) return false;
      const row = raw as unknown as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(row, 'nativeCallAmbiguous') &&
          row.nativeCallAmbiguous !== true) return false;
      if (Object.prototype.hasOwnProperty.call(row, 'nativeCallMessageId') &&
          (typeof row.nativeCallMessageId !== 'string' || row.nativeCallMessageId.length === 0 ||
            row.nativeCallMessageId.length > 300 || row.nativeCallMessageId.startsWith('stream:') ||
            row.nativeCallMessageId.startsWith('stored:'))) return false;
      if (Object.prototype.hasOwnProperty.call(row, 'turnId') && !validTurnId(row.turnId))
        return false;
      completeIds.add(joinKey(owner.requestId));
      return true;
    });
  // An explicitly committed v6 ledger with invalid rows is corrupt, not an
  // older migration snapshot. Keep its bytes intact for the original owner
  // instead of rebuilding from historical calls that cannot prove native IDs.
  if (saved?.version === CORRELATIONS_STATE_VERSION && saved.complete === true && !complete)
    throw new Error('Could not restore request-correlations state');
  if (saved && saved.version >= 3 && saved.version <= CORRELATIONS_STATE_VERSION && Array.isArray(saved.entries)) {
    for (const raw of saved.entries.slice(-MAX_CORRELATIONS)) {
      const owner = storedOwner(raw);
      if (!owner) continue;
      merge(owner, 'restore');
      loaded = true;
    }
    trim();
  }

  // Version 6 is committed before the browser receives correlation confirmation. It is the
  // complete owner ledger, so replaying every canonical message shard would add no evidence.
  // Older snapshots were debounced and require one migration scan to close their crash window.
  if (complete) return;

  // The durable index is a debounced snapshot, while attributed tool-call JSONL is appended
  // independently. A crash can therefore leave a perfectly valid *nonempty* snapshot that is
  // merely behind the session history. Treat the snapshot as a fast baseline, not as proof that
  // history has nothing newer. Reconcile the durable request-id facts on every restore; merge()
  // is idempotent for the same conversation and still makes contradictions sticky.
  let sessions;
  try {
    sessions = await indexedSessions();
  } catch (error) {
    // A valid direct snapshot can be restored before the session store is initialized (some
    // tests and narrowly scoped consumers do exactly that). In the real app the store is ready
    // before this function runs, so stale-snapshot reconciliation still happens there. With no
    // usable snapshot, however, history is the only recovery source and the initialization
    // error must remain visible rather than silently losing ownership.
    if (loaded) return;
    throw error;
  }
  // Oldest first. History is the one source that can disagree with itself here, because it
  // replays proofs this process did not watch happen, and the owner is whichever proof came
  // first. Sessions arrive newest-first, which would have made it whichever one came last.
  for (const session of sessions.slice(0, 100).reverse()) {
    // The persisted index is the baseline. Reconcile only a bounded newest crash window;
    // parsing every historical JSONL on every launch made startup proportional to years of
    // recorded work and could freeze the main process for a minute before the UI appeared.
    for (const event of await readRecentEvents(session.id, 1024, {
      kinds: ['tool_call'],
      maxBytes: 512 * 1024
    })) {
      if (event.kind !== 'tool_call') continue;
      const call = event.call;
      if (call.attributionMethod !== 'request_id' || !call.requestId || !call.conversationId) continue;
      merge({
        requestId: call.requestId,
        conversationId: call.conversationId,
        sessionId: session.id,
        messageId: `stored:${call.callId}`,
        tool: call.tool,
        observedAt: event.time
      }, 'restore');
    }
  }
  // Also when the snapshot on disk is an older version that held nothing usable: rewriting it
  // is what actually removes its conflict rows, and leaving them there would make every
  // later launch re-read a verdict this registry no longer has.
  // Publish the migration boundary before startup admits browser/MCP traffic. Every later new
  // owner crosses the same barrier in commitRequestCorrelations().
  await writeDurableNow(CORRELATIONS_STATE, snapshot());
}

/**
 * Durable browser-ack boundary for newly proved request owners.
 *
 * The synchronous registry remains immediately readable by in-flight MCP calls, while the
 * browser waits for this exact snapshot before retiring its correlation evidence. This removes
 * the crash window that previously forced every startup to rescan canonical session history.
 */
export function commitRequestCorrelations(): Promise<void> {
  // The whole owner snapshot AND its storage admission are serialized, not
  // merely the underlying disk writes. An older admitted proof can stall
  // before reaching durable.ts; without this queue its stale snapshot could
  // overwrite a newer sibling-call veto that another browser ACK just saved.
  const work = correlationCommitQueue.then(async () => {
    if (!correlationCommitPending()) return;
    const revision = correlationRevision;
    await writeDurableNow(CORRELATIONS_STATE, snapshot());
    // If a page sighting arrived during the await, it still needs a new commit.
    committedCorrelationRevision = Math.max(committedCorrelationRevision, revision);
  });
  correlationCommitQueue = work.then(() => undefined, () => undefined);
  return work;
}

/** A previously failed durable ACK is still owed even if a duplicate page sighting changes nothing. */
export function correlationCommitPending(): boolean {
  return correlationRevision > committedCorrelationRevision;
}

/**
 * Adds page evidence. `request_id` is a turn/workflow ownership key, not a per-tool-call id:
 * one ChatGPT turn can legitimately report several message ids/tools under the same key.
 * Re-reporting that key from the same conversation is therefore idempotent, and reporting it
 * from a different one is refused: the owner an id already has is the owner it keeps.
 */
export function observeRequestCorrelation(input: RequestCorrelation): 'stored' | 'same' | 'refused' {
  return observeRequestCorrelations([input])[0]!;
}

/**
 * Adds one page evidence batch while snapshotting the durable registry at most once.
 *
 * Fiber commonly reports several connector calls from one turn together. Feeding them through
 * the single-item API one by one cloned the complete (up to 50k-entry) registry after every new
 * request id, although `writeDurableSoon()` could only keep the newest pending snapshot. Merge
 * the complete synchronous batch first, then queue exactly one snapshot. Individual callers
 * keep the API above, so the durable queue boundary stays synchronous everywhere.
 */
export function observeRequestCorrelations(
  inputs: readonly RequestCorrelation[]
): Array<'stored' | 'same' | 'refused'> {
  let changed = false;
  const results = inputs.map((input) => {
    const previousObservedAt = byRequest.get(joinKey(input.requestId))?.observedAt;
    const previousTurnId = byRequest.get(joinKey(input.requestId))?.turnId;
    const previousTool = byRequest.get(joinKey(input.requestId))?.tool;
    const previousNativeCall = byRequest.get(joinKey(input.requestId))?.nativeCallMessageId;
    const previouslyAmbiguous = byRequest.get(joinKey(input.requestId))?.nativeCallAmbiguous;
    const result = merge(input);
    // A same-owner observation can still advance durable freshness/order. Persist that too so
    // an app restart cannot resurrect the pre-refresh eviction order. A refusal changes nothing
    // and therefore writes nothing.
    if (result === 'stored' || (result === 'same' && (previousObservedAt !== undefined && input.observedAt > previousObservedAt ||
        previousTurnId !== byRequest.get(joinKey(input.requestId))?.turnId ||
        previousTool !== byRequest.get(joinKey(input.requestId))?.tool ||
        previousNativeCall !== byRequest.get(joinKey(input.requestId))?.nativeCallMessageId ||
        previouslyAmbiguous !== byRequest.get(joinKey(input.requestId))?.nativeCallAmbiguous))) {
      changed = true;
    }
    return result;
  });
  if (changed) {
    correlationRevision++;
    persist();
  }
  return results;
}

/** Proven workflow lookup with only the documented UUID version alias; absent IDs stay unknown. */
export function requestCorrelation(requestId: string | null | undefined): RequestCorrelation | null {
  if (!requestId) return null;
  const held = byRequest.get(joinKey(requestId));
  return held ? { ...held } : null;
}

/**
 * Waits only for this workflow key. Late Fiber evidence is allowed; no other request or page
 * state can wake this into a successful ownership decision.
 */
export async function awaitRequestCorrelation(requestId: string | null | undefined, timeoutMs: number): Promise<RequestCorrelation | null> {
  if (!requestId) return null;
  const immediate = requestCorrelation(requestId);
  if (immediate || timeoutMs <= 0) return immediate;

  const key = joinKey(requestId);
  const now = performance.now();
  const startedAt = evidenceWindowStarts.get(key) ?? now;
  if (!evidenceWindowStarts.has(key)) {
    evidenceWindowStarts.set(key, startedAt);
    if (evidenceWindowStarts.size > MAX_EVIDENCE_WINDOWS) {
      evidenceWindowStarts.delete(evidenceWindowStarts.keys().next().value!);
    }
  }
  const remainingMs = timeoutMs - (now - startedAt);
  if (remainingMs <= 0) return null;

  let timer: NodeJS.Timeout | null = null;
  await new Promise<void>((resolve) => {
    const set = waiters.get(key) ?? new Set<() => void>();
    set.add(resolve);
    waiters.set(key, set);
    timer = setTimeout(() => {
      set.delete(resolve);
      if (set.size === 0) waiters.delete(key);
      resolve();
    }, remainingMs);
    timer.unref?.();
  });
  if (timer) clearTimeout(timer);
  return requestCorrelation(requestId);
}

/** A conversation being closed cannot invalidate an already issued request. */
export function resetCorrelationRegistryForTests(): void {
  byRequest.clear();
  evidenceWindowStarts.clear();
  restored = false;
  restoring = null;
  correlationRevision = 0;
  committedCorrelationRevision = 0;
  correlationCommitQueue = Promise.resolve();
  for (const requestId of [...waiters.keys()]) wake(requestId);
}

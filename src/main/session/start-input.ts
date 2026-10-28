/** Explicit desktop sends bring up the existing connection/browser authorities. */
import { connect, getStatus, onStatusChange } from '../connection.js';
import { requestBrowserConversationOpen, startBridge } from '../bridge.js';
import { wakeBrowserUrl, resetBrowserStartupForTests } from '../browser-startup.js';
import { wakeBrowserWork } from '../browser-wake.js';
import { getConfig } from '../config.js';
import { logWarn } from '../logger.js';
import { enqueueInput, cancelInput, listInputs, noteInputStartupError, onInputChange, rearmQueuedBrowserInput, userRequestedInput, workflowInputReady, type InputArgs, type InputEntry } from './input.js';

function wakeBrowser(entry: InputEntry, retry = false): Promise<void> {
  const marker = `cos-input=${encodeURIComponent(entry.id)}`;
  return wakeBrowserUrl(entry.conversationId ? `https://chatgpt.com/c/${encodeURIComponent(entry.conversationId)}` : `https://chatgpt.com/?${marker}#${marker}`, retry, getConfig().ui.backgroundChats === true,
    entry.workflow ? { current: () => getConfig().ui.automationPaused !== true } : undefined);
}
async function ready(signal?: AbortSignal): Promise<void> {
  await connect();
  signal?.throwIfAborted();
  // startTunnel returns a lifecycle handle before OpenAI /readyz or cloudflared's URL.
  // Await that existing status authority for this operation; never publish input early.
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); signal?.removeEventListener('abort', abort); reject(new Error('The connector did not become ready. Check its connection status and try again.')); }, 65000);
    timer.unref?.();
    const abort = () => { clearTimeout(timer); unsubscribe(); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    const inspect = () => {
      const status = getStatus();
      if (['starting-server', 'connecting-tunnel', 'offline'].includes(status.state)) return;
      clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort);
      if (status.state === 'connected') resolve();
      else reject(new Error(status.detail || 'Finish connection setup before sending.'));
    };
    unsubscribe = onStatusChange(inspect); inspect();
  });
  if (!await startBridge()) throw new Error('The browser bridge could not start. Your message has not been queued.');
}
async function deliver(entry: InputEntry, retry = false): Promise<InputEntry> {
  try {
    await wakeBrowser(entry, retry);
    return await noteInputStartupError(entry.id, null) ?? entry;
  } catch (error) {
    return await noteInputStartupError(entry.id, `Message queued. Browser startup failed: ${(error as Error).message}`) ?? entry;
  }
}
// Only in-progress pre-publication work lives here; durable outbox state owns delivery.
const starting = new Map<string, { controller: AbortController; sessionId: string | null }>();
interface WakeRetryTimers {
  generation: number;
  timers: NodeJS.Timeout[];
}
const retryTimers = new Map<string, WakeRetryTimers>();
const wakeRetryWarnings = new Set<string>();
let wakeRetrySyncGeneration = 0;
let wakeRetrySyncStarted = false;
let stopWakeRetryInputChanges: (() => void) | null = null;
let stopWakeRetrySessionChanges: (() => void) | null = null;
interface WakeRetrySyncRun {
  generation: number;
  again: boolean;
  promise: Promise<void>;
}
let wakeRetrySync: WakeRetrySyncRun | null = null;

function wakeRetrySyncActive(generation: number): boolean {
  return wakeRetrySyncStarted && generation === wakeRetrySyncGeneration;
}
function reportWakeRetryFailure(context: string, error: unknown, generation: number): void {
  if (!wakeRetrySyncActive(generation)) return;
  const detail = error instanceof Error ? error.message : String(error);
  const key = `${context}\n${detail}`;
  if (wakeRetryWarnings.has(key)) return;
  wakeRetryWarnings.add(key);
  logWarn(`queued input wake-retry ${context} failed: ${detail}`);
}
function clearQueuedWakeRetries(id: string, expected?: WakeRetryTimers): void {
  const owner = retryTimers.get(id);
  if (!owner || (expected && owner !== expected)) return;
  for (const timer of owner.timers) clearTimeout(timer);
  retryTimers.delete(id);
}
function queuedWakeRetryEligible(entry: InputEntry | undefined): boolean {
  return !!entry && entry.state === 'queued' && userRequestedInput(entry) &&
    entry.queuedBehindDelivery !== true && entry.queuedBehindBrowser !== true;
}
/**
 * A queued row is already the durable retry. Nudge the companion again if its first wake was
 * swallowed by MV3 suspension or a busy tab inventory, but never clone the row, press Send, or
 * open more tabs. The browser claim remains the single delivery authority.
 */
function scheduleQueuedWakeRetries(entry: InputEntry, restart = false, generation = wakeRetrySyncGeneration): void {
  const inputId = entry.id;
  if (!wakeRetrySyncActive(generation)) return;
  const existing = retryTimers.get(inputId);
  if (!queuedWakeRetryEligible(entry)) {
    if (existing?.generation === generation) clearQueuedWakeRetries(inputId, existing);
    return;
  }
  if (existing?.generation === generation && !restart) return;
  if (existing) clearQueuedWakeRetries(inputId, existing);
  const owner: WakeRetryTimers = { generation, timers: [] };
  owner.timers = [5_000, 15_000, 30_000].map(delay => {
    const timer = setTimeout(() => {
      if (!wakeRetrySyncActive(generation) || retryTimers.get(inputId) !== owner) return;
      void listInputs().then(rows => {
        if (!wakeRetrySyncActive(generation) || retryTimers.get(inputId) !== owner) return;
        const current = rows.find(row => row.id === inputId);
        if (!queuedWakeRetryEligible(current)) {
          clearQueuedWakeRetries(inputId, owner);
          return;
        }
        wakeBrowserWork();
      }).catch(error => reportWakeRetryFailure(`timer read for ${inputId}`, error, generation));
    }, delay);
    timer.unref?.();
    return timer;
  });
  retryTimers.set(inputId, owner);
}
async function syncQueuedWakeRetries(generation: number): Promise<void> {
  let rows = await listInputs();
  const needsNativeProof = rows.some(row => row.workflow && row.state === 'sent' && !row.workflowReceipt);
  if (!needsNativeProof && stopWakeRetrySessionChanges) {
    stopWakeRetrySessionChanges(); stopWakeRetrySessionChanges = null;
  }
  if (needsNativeProof) {
    if (!stopWakeRetrySessionChanges && wakeRetrySyncActive(generation)) {
      const { onSessionChange } = await import('./recorder.js');
      if (!wakeRetrySyncActive(generation)) return;
      stopWakeRetrySessionChanges = onSessionChange(() => {
        void queueQueuedWakeRetrySync(generation)
          .catch(error => reportWakeRetryFailure('session-change sync', error, generation));
      });
    }
    const { reconcileWorkflowInputs } = await import('./workflow.js');
    await reconcileWorkflowInputs(() => wakeRetrySyncActive(generation));
    rows = await listInputs();
  }
  if (!wakeRetrySyncActive(generation)) return;
  const eligible = new Set(rows.filter(row => queuedWakeRetryEligible(row) &&
    (!row.workflow || workflowInputReady(row, rows))).map(row => row.id));
  for (const [id, owner] of retryTimers) {
    if (owner.generation === generation && !eligible.has(id)) clearQueuedWakeRetries(id, owner);
  }
  for (const row of rows) if (eligible.has(row.id)) {
    if (row.workflow && !retryTimers.has(row.id)) {
      // First eligible recipe step after cold admission/dependency completion uses the
      // incumbent coalesced browser startup. Connected accounts never open extra tabs here.
      try { await wakeBrowser(row); }
      catch (error) { reportWakeRetryFailure(`recipe startup ${row.id}`, error, generation); }
      if (!wakeRetrySyncActive(generation)) return;
    }
    scheduleQueuedWakeRetries(row, false, generation);
  }
}
function queueQueuedWakeRetrySync(generation: number): Promise<void> {
  if (!wakeRetrySyncActive(generation)) return Promise.resolve();
  if (wakeRetrySync?.generation === generation) {
    wakeRetrySync.again = true;
    return wakeRetrySync.promise;
  }
  const run: WakeRetrySyncRun = { generation, again: false, promise: Promise.resolve() };
  const work = (async () => {
    do {
      run.again = false;
      await syncQueuedWakeRetries(generation);
    } while (run.again && wakeRetrySyncActive(generation));
  })();
  const tracked = work.finally(() => { if (wakeRetrySync === run) wakeRetrySync = null; });
  run.promise = tracked;
  wakeRetrySync = run;
  return tracked;
}
// Outbox commits are the event source. This re-arms the existing bounded wake owner when a
// same-chat/cross-chat follower becomes the head, including after process restart, without polling.
// Bootstrap must call this only after initDurableStore(). Importing this module happens earlier
// through IPC registration; reading the outbox at module evaluation time would otherwise cache an
// empty queue before the account-specific durable root exists.
export async function startQueuedWakeRetrySync(): Promise<void> {
  if (wakeRetrySyncStarted) return wakeRetrySync?.promise ?? Promise.resolve();
  wakeRetrySyncStarted = true;
  const generation = ++wakeRetrySyncGeneration;
  stopWakeRetryInputChanges = onInputChange(() => {
    void queueQueuedWakeRetrySync(generation)
      .catch(error => reportWakeRetryFailure('input-change sync', error, generation));
  });
  try {
    await queueQueuedWakeRetrySync(generation);
  } catch (error) {
    if (wakeRetrySyncActive(generation)) stopQueuedWakeRetrySync();
    throw error;
  }
}

/** Stops the restart wake owner before bounded shutdown can race a late outbox read or timer. */
export function stopQueuedWakeRetrySync(): void {
  wakeRetrySyncStarted = false;
  wakeRetrySyncGeneration += 1;
  stopWakeRetryInputChanges?.();
  stopWakeRetryInputChanges = null;
  stopWakeRetrySessionChanges?.();
  stopWakeRetrySessionChanges = null;
  for (const id of [...retryTimers.keys()]) clearQueuedWakeRetries(id);
  wakeRetryWarnings.clear();
  wakeRetrySync = null;
}
export async function cancelDesktopInput(id: string): Promise<boolean> {
  clearQueuedWakeRetries(id);
  const start = starting.get(id);
  if (start) { start.controller.abort(new Error('Input cancelled')); return true; }
  return cancelInput(id);
}
/** Cancels connection/browser startup that has not reached the durable outbox yet. */
export function cancelDesktopInputsForSession(sessionId: string): number {
  let cancelled = 0;
  for (const start of starting.values()) {
    if (start.sessionId !== sessionId || start.controller.signal.aborted) continue;
    start.controller.abort(new Error('Input cancelled because its conversation was deleted'));
    cancelled += 1;
  }
  return cancelled;
}
export async function sendDesktopInput(input: InputArgs): Promise<InputEntry> {
  if (input.mode === 'finish') return enqueueInput(input);
  if (starting.has(input.id)) throw new Error('Input already starting');
  const controller = new AbortController();
  const start = { controller, sessionId: input.sessionId };
  starting.set(input.id, start);
  try {
    await ready(controller.signal);
    controller.signal.throwIfAborted();
    const entry = await enqueueInput(input);
    // Cancellation can arrive while the durable enqueue is committing.
    if (controller.signal.aborted) { await cancelInput(input.id); controller.signal.throwIfAborted(); }
    starting.delete(input.id);
    if (entry.state !== 'queued' || entry.attachmentDelivery === 'tool' ||
        entry.workflow && !workflowInputReady(entry, await listInputs())) return entry;
    const delivered = await deliver(entry);
    scheduleQueuedWakeRetries(delivered, true);
    return delivered;
  } finally { if (starting.get(input.id) === start) starting.delete(input.id); }
}
export async function retryQueuedInputBrowser(
  id: string,
  requireAttentionFence = false,
  operatorReceipt?: string
): Promise<InputEntry | null> {
  // A deliberate retry is safe only before Chrome claims the row. Reuse the same durable UUID
  // and wake the existing companion; never clone the authored text or replay browser/Send state.
  if (requireAttentionFence !== (operatorReceipt !== undefined)) {
    throw new Error('A strict queued-input Retry requires exactly one operation receipt');
  }
  const queuedUserInput = (entry: InputEntry | undefined): entry is InputEntry =>
    !!entry && entry.state === 'queued' && userRequestedInput(entry);
  const attentionRetryable = (entry: InputEntry | undefined): entry is InputEntry =>
    queuedUserInput(entry) && entry.owner === null && entry.transportIntent !== 'tool' &&
    entry.deliveryAttentionAt !== undefined && entry.offeredAt === undefined &&
    entry.sendAuthorizedAt === undefined && entry.deliveredAt === undefined && entry.messageId === undefined;
  const existing = (await listInputs()).find(entry => entry.id === id);
  if (!(requireAttentionFence ? attentionRetryable(existing) : queuedUserInput(existing))) return null;
  const rearmed = await rearmQueuedBrowserInput(id, requireAttentionFence, operatorReceipt);
  // The durable outbox may have moved from queued to browser/cancelled while this
  // explicit Retry was being accepted. Do not prepare connector/browser authority
  // for a row that the existing serialized owner says is no longer retryable.
  if (!queuedUserInput(rearmed ?? undefined)) return rearmed;
  await ready();
  let entry = (await listInputs()).find(row => row.id === id);
  if (!queuedUserInput(entry)) return entry ?? null;
  // Manual Retry must visibly do more than rewrite the same queue row. Existing chats use the
  // extension's exact-tab focus-or-open authority; fresh chats retain their original marker.
  if (entry.conversationId) {
    const opened = await requestBrowserConversationOpen(entry.conversationId);
    entry = (await listInputs()).find(row => row.id === id);
    if (!queuedUserInput(entry)) return entry ?? null;
    if (!opened.ok) {
      const noted = await noteInputStartupError(entry.id, `Message remains queued. ${opened.message}`);
      scheduleQueuedWakeRetries(noted ?? entry, true);
      return noted;
    }
  }
  wakeBrowserWork();
  const delivered = await deliver(entry, true);
  scheduleQueuedWakeRetries(delivered, true);
  return delivered;
}
export function resetInputStartupForTests(): void {
  resetBrowserStartupForTests(); starting.clear();
  stopQueuedWakeRetrySync();
}

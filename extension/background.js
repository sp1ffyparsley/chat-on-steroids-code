/**
 * Service worker: the only part of the extension that talks to the app.
 *
 * The pairing token lives here and in chrome.storage.local, never in a content
 * script and never in the page. A content script that were somehow compromised can
 * ask this worker to post observations about the page it is already reading; it
 * cannot read the token, cannot reach the app on its own (the app refuses a
 * https://chatgpt.com origin), and there is no message that makes the app touch a
 * file, run a command or change a permission.
 *
 * Discovery is a scan of five fixed loopback ports for a /hello that identifies the
 * app. Nothing is broadcast and nothing listens.
 *
 * This worker also owns the observation journal. A content script lives only as long as
 * its page: a reload, a navigation or a crash takes its memory with it, and ChatGPT
 * virtualises old turns, so what is gone is often gone for good. So a content script
 * hands an observation over immediately and the durable copy lives here, in
 * chrome.storage.session — which survives this worker being shut down (Chrome does that
 * after seconds of idling) and dies with the browser, which is the right lifetime for a
 * record the app has not accepted yet.
 */

// MV3 service workers require static module imports. A dynamic import can reject before the
// service worker finishes registration, which silently removes browser-control recovery while
// leaving the rest of the companion apparently connected.
import { createBrowserControl } from './browser-control.js';

// One deterministic local port slot per supported instance profile. The extension still pins
// the exact instanceId after pairing, so discovering another local Luna process never grants it
// authority over this Chrome profile.
const PORTS = Array.from({ length: 32 }, (_, index) => 8765 + index);
const INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const HELLO_TIMEOUT_MS = 1200;
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * The deadline for the one route that waits on a model rather than on the app's own state.
 *
 * Every other request this worker makes is answered from something the app already has, so the
 * ordinary ten seconds is a generous ceiling for it. `/goal/open` is different: it holds the
 * connection open for a whole OpenRouter completion, which the app itself allows 180s for. A
 * shorter deadline here does not cancel that work — the app keeps going and the account is
 * still billed for the answer — it only guarantees nobody is left to receive it.
 *
 * So this sits above the app's own timeout on purpose. Whichever way the request ends, the
 * app's error handling is the half that gets to say why.
 */
const MODEL_REQUEST_TIMEOUT_MS = 190_000;

/** The reason a deadline aborts with, so it is a fact the caller can act on rather than prose. */
const TIMED_OUT = 'the app took too long to answer';
/** Bumped only when the request/response shape changes; the app compares it. */
const BRIDGE_PROTOCOL = 16;

/**
 * Journal caps. The byte figure is what actually matters — chrome.storage.session has a
 * ten-megabyte budget for the whole extension — and the count keeps a pathological run
 * of tiny events from making every write expensive.
 */
const MAX_JOURNAL = 4000;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const BATCH = 100;
const SHELL_SCAN_MAX = 400;
const RETRY_ALARM = 'clf-bridge-drain';

/** Rebuild the untrusted page diagnostic using only the fixed, non-content counter schema. */
function shellScanDiagnostic(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      !raw.rejects || typeof raw.rejects !== 'object' || Array.isArray(raw.rejects)) return null;
  const counter = value => Number.isInteger(value) && value >= 0 && value <= SHELL_SCAN_MAX ? value : null;
  const selectorMatches = counter(raw.selectorMatches);
  const mapped = counter(raw.mapped);
  const fiberMissing = counter(raw.rejects.fiberMissing);
  const ownerMissing = counter(raw.rejects.ownerMissing);
  const stableKeyMismatch = counter(raw.rejects.stableKeyMismatch);
  const itemsOverLimit = counter(raw.rejects.itemsOverLimit);
  if ([selectorMatches, mapped, fiberMissing, ownerMissing, stableKeyMismatch, itemsOverLimit]
    .some(value => value === null)) return null;
  const rejects = { fiberMissing, ownerMissing, stableKeyMismatch, itemsOverLimit };
  for (const key of ['callCompletionVeto', 'callLiveMappingMissing', 'callLiveMappingConflict',
    'callPathMissing', 'callReceiptMissing', 'callReceiptConflict', 'callNativePending',
    'callScopeConflict', 'callExecUnresolved',
    'callRequestIdPresent', 'callRequestIdMissing', 'callInventoryMissing', 'callInventoryIncomplete',
    'callVetoReceiptChecked', 'callVetoReceiptMatched',
    'callJoinReferenceMissing', 'callJoinReferenceUnselected', 'callJoinReferenceConflict',
    'callJoinResultMissing', 'callJoinResultIdentity', 'callJoinDescriptorUnsupported',
    'callIdentityRecovered', 'callIdentityPriorPair', 'callIdentityUserUnproved',
    'callIdentityNativeUnproved', 'callIdentityScopeUnproved', 'callIdentityParentUnproved',
    'callIdentitySelectedWithheld',
    'assistantTerminalReceiptChecked', 'assistantTerminalReceiptMatched',
    'callCompletedFalse', 'callCompletedUndefined', 'callCompletedNull', 'callCompletedMalformed', 'callStatusVeto',
    'callVetoStatusAbsent', 'callVetoStatusPending', 'callVetoStatusError', 'callVetoStatusDone',
    'callVetoStatusFinal', 'callVetoStatusCompleted', 'callVetoStatusComplete', 'callVetoStatusFinished',
    'callVetoStatusFinishedSuccessfully', 'callVetoStatusUnknown',
    'userTypedMissing', 'userIdentityInvalid', 'userTextEmpty', 'userTextUnsupported', 'userBudgetDropped', 'userProjected']) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(raw.rejects, key); } catch { return null; }
    if (!descriptor) continue;
    const value = counter(descriptor.value);
    if (value === null) return null;
    rejects[key] = value;
  }
  // Legacy frames omit either complete pair; a partial or impossible pair is not usable evidence.
  const receiptChecked = Object.getOwnPropertyDescriptor(rejects, 'callVetoReceiptChecked')?.value;
  const receiptMatched = Object.getOwnPropertyDescriptor(rejects, 'callVetoReceiptMatched')?.value;
  const completionVeto = Object.getOwnPropertyDescriptor(rejects, 'callCompletionVeto')?.value;
  if ((receiptChecked === undefined) !== (receiptMatched === undefined) || receiptMatched > receiptChecked ||
      (completionVeto !== undefined && receiptChecked > completionVeto)) return null;
  const assistantReceiptChecked = Object.getOwnPropertyDescriptor(rejects, 'assistantTerminalReceiptChecked')?.value;
  const assistantReceiptMatched = Object.getOwnPropertyDescriptor(rejects, 'assistantTerminalReceiptMatched')?.value;
  if ((assistantReceiptChecked === undefined) !== (assistantReceiptMatched === undefined) ||
      assistantReceiptMatched > assistantReceiptChecked) return null;
  return {
    selectorMatches,
    mapped,
    rejects
  };
}
/** Terminal diagnostics retain only a fixed shape plus exact, bounded native custody
 * identities. These optional IDs are forwarded to Main, never logged or stored as incident
 * text; the worker's own document/epoch stamp remains the browser authentication. */
const NATIVE_IDENTITY_REFUSAL_KEYS = new Set([
  'currentQuestionMissing', 'currentQuestionUnselected', 'currentQuestionConflict',
  'nativeInvocationMissing', 'nativeInvocationMismatch', 'requestIdMissing',
  'decodedPathMissing', 'decodedPathForeign', 'serverMissing', 'serverMismatch',
  'toolMismatch', 'workingTurnMissing', 'workingTurnMismatch', 'turnExchangeMissing',
  'turnExchangeMismatch', 'nativeAncestryUnproved', 'priorRequestIdMissing',
  'priorRequestIdMismatch', 'priorResultResourceIncomplete', 'priorToolScopeMismatch'
]);
/** Optional diagnostic codes stay attached to the worker-authenticated native parent inventory. */
function identityRefusalsDiagnostic(raw, parents) {
  try {
    if (!parents || !Array.isArray(raw) || raw.length !== parents.length) return null;
    const result = [];
    for (let index = 0; index < parents.length; index++) {
      const item = Object.getOwnPropertyDescriptor(raw, String(index))?.value;
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const messageId = Object.getOwnPropertyDescriptor(item, 'messageId')?.value;
      const codes = Object.getOwnPropertyDescriptor(item, 'reasons')?.value;
      if (messageId !== parents[index] || !Array.isArray(codes) || codes.length > NATIVE_IDENTITY_REFUSAL_KEYS.size) return null;
      const reasons = [];
      for (let at = 0; at < codes.length; at++) {
        const code = Object.getOwnPropertyDescriptor(codes, String(at))?.value;
        if (!NATIVE_IDENTITY_REFUSAL_KEYS.has(code) || reasons.includes(code)) return null;
        reasons.push(code);
      }
      result.push({ messageId, reasons });
    }
    return result;
  } catch { return null; }
}
function ordinaryFinalDiagnostic(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      !['local-owner', 'busy', 'excluded-chat', 'question-invalid', 'turn-invalid', 'open-call', 'open-code', 'final-invalid', 'associated'].includes(raw.reason) ||
      typeof raw.activeTurnMapped !== 'boolean') return null;
  const counter = value => Number.isInteger(value) && value >= 0 && value <= SHELL_SCAN_MAX;
  if (![raw.questions, raw.calls, raw.openCalls, raw.codeCalls, raw.openCodeCalls].every(counter) ||
      raw.openCalls > raw.calls || raw.openCodeCalls > raw.codeCalls) return null;
  // Incompatible/new provider readers can mislabel an incomplete census as
  // associated. The negative selected-turn capability outranks a positive
  // final label; keep the identity/counters, never the alleged terminal proof.
  const inventoryIncomplete = raw.callInventoryComplete === false;
  const reason = inventoryIncomplete ? 'turn-invalid' : raw.reason;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const sourceUserMessageId = typeof raw.sourceUserMessageId === 'string' && uuid.test(raw.sourceUserMessageId)
    ? raw.sourceUserMessageId : null;
  const settledFinalMessageId = !inventoryIncomplete && ['open-call', 'associated'].includes(reason) &&
    sourceUserMessageId && typeof raw.settledFinalMessageId === 'string' &&
    uuid.test(raw.settledFinalMessageId) && raw.settledFinalMessageId !== sourceUserMessageId
    ? raw.settledFinalMessageId : null;
  const openRequestIds = reason === 'open-call' && Array.isArray(raw.openRequestIds) &&
    raw.openCalls > 0 && raw.openCalls <= 200 && raw.openRequestIds.length === raw.openCalls &&
    raw.openRequestIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100)
    ? raw.openRequestIds : null;
  const codeIds = (field, expected) => Array.isArray(raw[field]) &&
    expected >= 0 && expected <= 200 && raw[field].length === expected &&
    raw[field].every(id => typeof id === 'string' && id.length > 0 && id.length <= 200) &&
    new Set(raw[field]).size === raw[field].length ? raw[field] : null;
  const coreCallMessageIds = codeIds('coreCallMessageIds', raw.calls);
  const identityRefusals = inventoryIncomplete ? null : identityRefusalsDiagnostic(
    Object.getOwnPropertyDescriptor(raw, 'identityRefusals')?.value, coreCallMessageIds);
  // A request identifies the whole workflow and may be shared by sibling calls.
  // Keep its ordered pairing with the unique native parent IDs; Main still
  // proves each parent's own durable terminal result before releasing a fence.
  const allCoreRequestIds = Array.isArray(raw.allCoreRequestIds) && raw.calls <= 200 &&
    raw.allCoreRequestIds.length === raw.calls &&
    raw.allCoreRequestIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100)
    ? raw.allCoreRequestIds : null;
  const codeCallMessageIds = codeIds('codeCallMessageIds', raw.codeCalls);
  const checkpointSourceUserMessageId = !inventoryIncomplete && reason === 'turn-invalid' && raw.activeTurnMapped === false &&
    coreCallMessageIds && codeCallMessageIds && typeof raw.checkpointSourceUserMessageId === 'string' &&
    uuid.test(raw.checkpointSourceUserMessageId) ? raw.checkpointSourceUserMessageId : null;
  const openCodeCallMessageIds = codeIds('openCodeCallMessageIds', raw.openCodeCalls);
  const answeredCodeCallMessageIds = codeIds('answeredCodeCallMessageIds', raw.codeCalls - raw.openCodeCalls);
  return { reason, questions: raw.questions, calls: raw.calls, openCalls: raw.openCalls,
    codeCalls: raw.codeCalls, openCodeCalls: raw.openCodeCalls, activeTurnMapped: raw.activeTurnMapped,
    ...(reason === 'busy' && raw.activeTurnMapped === false && raw.maintenanceIdle === true
      ? { maintenanceIdle: true } : {}),
    ...(inventoryIncomplete
      ? { callInventoryComplete: false } : {}),
    ...(sourceUserMessageId ? { sourceUserMessageId } : {}),
    ...(checkpointSourceUserMessageId ? { checkpointSourceUserMessageId } : {}),
    ...(settledFinalMessageId ? { settledFinalMessageId } : {}),
    ...(openRequestIds ? { openRequestIds } : {}),
    ...(coreCallMessageIds ? { coreCallMessageIds } : {}),
    ...(identityRefusals ? { identityRefusals } : {}),
    ...(allCoreRequestIds && coreCallMessageIds ? { allCoreRequestIds } : {}),
    ...(codeCallMessageIds ? { codeCallMessageIds } : {}),
    ...(openCodeCallMessageIds ? { openCodeCallMessageIds } : {}),
    ...(answeredCodeCallMessageIds ? { answeredCodeCallMessageIds } : {}) };
}
/**
 * How long the worker sleeps between maintenance passes, in minutes.
 *
 * Thirty seconds, because thirty seconds is the floor. Chrome fires an alarm at most twice a
 * minute and clamps anything shorter in a packed extension — an unpacked development copy is
 * exempt, which is the trap: 0.25 works on this machine and silently becomes 0.5 for everybody
 * who installs a release.
 *
 * The app owns repair deadlines and normally wakes this worker over its socket.
 * This alarm is the fallback when that wake is unavailable; it can add up to
 * thirty seconds before the next collection pass.
 *
 * That floor is also why one pass collects *every* repair now due rather than one: the app can
 * decide three at the same instant, and handing them out one per pass would spread three
 * reloads across a minute and a half for no reason anybody chose.
 *
 * A one-shot re-armed at the end of every pass, rather than `periodInMinutes`: a period may not
 * go below a minute at all, and that periodic form was why a repair armed at T+20 could wait
 * until T+75.
 */
const RETRY_PERIOD_MIN = 0.5;
let retryAlarmScheduled = false;

let port = null;
let token = null;
/** Durable local binding to the app instance this browser profile explicitly paired with. */
let instanceId = null;
let connectorIdentityOwner = null;
let connectorApps = {}, connectorNames = {};
/** Malformed copied storage or a discovered wrong instance fails closed instead of re-pairing. */
let instanceBindingError = null;
/** Nearby account identities are cheap localhost probes, cached across popup/status polls. */
let nearbyInstances = null;
let nearbyInstancesAt = 0;
let nearbyInstancesFlight = null;
/** Last connection tuple durably observed or written, so discovery never rewrites unchanged state. */
let persistedConnection = null;
let loaded = false;
/** Cold raw-source veto, not a durable grant: parsed-empty recovery data cannot prove enrollment. */
let unboundEnrollmentSource = false;
/**
 * The one `load()` in flight, shared by everything that has to wait for it.
 *
 * `loaded` alone is not a guard, because it is only set after two awaited storage reads.
 * Chrome stops this worker after seconds of idling, so the cold path is the normal path:
 * two tabs report at the same moment, both see `loaded === false`, and both walk the whole
 * of load(). The first finishes, its handler enqueues an observation and persists it — and
 * then the second finishes and assigns the journal it read *before* that write straight
 * over the global. The entry the first handler already answered `ok` for is gone, and
 * nothing anywhere reports a loss, because as far as both halves are concerned each did
 * its job. Serialising initialisation is the whole fix: after this, the second caller
 * awaits the same promise and never re-reads.
 */
let loading = null;

/**
 * Set when the user disconnected on purpose, and cleared only when they connect again.
 *
 * Without it, "Disconnect" cleared the token and the very next `/hello` handed this
 * browser a new one — a button whose effect lasted until the next poll, roughly two
 * seconds. Auto-provisioning is right for a browser that has never connected and wrong
 * for one that was told to stop, and only this flag can tell those two apart.
 */
let disconnected = false;
/**
 * Monotonic user connection intent for this worker lifetime.
 *
 * `/pair` is an async mint. A user can press Disconnect after that request has left but
 * before its response arrives; without an intent fence the old response writes its token and
 * clears `disconnected`, undoing the newer click. Worker restart needs no persisted generation
 * because an in-flight fetch cannot survive it; the persisted `disconnected` flag is the
 * cross-worker authority.
 */
let connectionEpoch = 0;

/**
 * The `/pair` in flight, shared by everything that wants a token.
 *
 * Several tabs coming back at once all find no token and all call `/pair`. Each call
 * mints a fresh credential and invalidates the one before it, so the tabs rotate each
 * other's tokens: every request 401s, drops its token, and provisions again. One promise
 * means one credential no matter how many callers arrive together.
 */
let pairing = null;
let pairingEpoch = -1;
let pairingReconnect = false;
/** Most recent pairing failure, for the popup. Process-local and never a credential. */
let pairingError = null;

/**
 * When the app was last confirmed to be on `port`, and how long that is believed for.
 *
 * `discover()` used to run a `/hello` before every authenticated request, which doubled
 * the bridge traffic of an already-chatty poll and, with several tabs open, could spend
 * the 900/min budget on nothing but asking whether the app was still there. A failed
 * request re-checks immediately, so nothing is lost by believing a recent answer.
 */
let portCheckedAt = 0;
let portCompatible = null;
let appVersion = null;
let appProtocol = null;
const PORT_TRUST_MS = 30_000;

/**
 * Observations accepted from content scripts but not yet accepted by the app.
 *
 * Each entry carries the conversation it was observed in, captured at that moment.
 * Flushing groups by that field rather than labelling a whole batch with whatever
 * conversation happens to be current — a tab that moves from chat A to chat B while the
 * app is unreachable would otherwise file A's messages into B's history.
 */
let journal = [];
/** Two transport slots, with one in-flight batch per conversation. The journal owns custody. */
const JOURNAL_CONCURRENCY = 2;
const journalWorkers = new Set();
const journalInFlight = new Map();
const journalFailed = new Set();
const journalServed = new Set();
const journalPreferences = new Set();

/**
 * What the last /events delivery did, kept only so the popup can show it.
 *
 * Nothing in the transport reads this. It exists because "is my chat actually reaching
 * the app?" was previously answerable only by reading the app's log, and a popup that
 * cannot answer it is a popup that gets replaced by guesswork.
 */
let delivery = { at: 0, ok: null, events: 0, total: 0, conversationId: null, status: 0, error: null };
/** Idempotent conversation-close deliveries awaiting an app ACK. */
let closeOutbox = [];
/** Successful extension-owned removals awaiting their exact tabs.onRemoved receipt. */
let automaticTabRetirements = {};
let closing = false;
/**
 * Command acknowledgements accepted from a content script but not yet accepted by the app.
 *
 * A fresh ChatGPT page is allowed to disappear immediately after it tells this worker that
 * its bootstrap was sent. Keeping that result only in the page, or only in the request that
 * happens to be in flight, creates a classic lost-final-ACK window: the app may commit the
 * command and the HTTP response may still be lost, after which the page is gone and nobody
 * retries. This outbox is worker-owned and storage.session-backed for exactly the same reason
 * as the observation journal. The wire payload is intentionally the existing /commands/ack
 * body unchanged; durability is a transport concern, not a protocol fork.
 */
let commandAckOutbox = [];
/**
 * Native Sends authorized in one ChatGPT document but not yet tied to the provider's user row.
 *
 * A fresh chat can replace its document immediately after the click. The content script's
 * in-memory receipt then disappears even though ChatGPT accepted the message and began MCP work.
 * Keep only a SHA-256 fingerprint and the old document's exact claim in storage.session; the
 * next document in the same tab may convert it into the existing durable input ACK after it
 * journals a matching native user row. No prompt text and no resend authority live here.
 */
let pendingInputReceipts = {};
const PENDING_INPUT_RECEIPT_MS = 120_000;
// Short-lived proof that this exact document just asked the app for its URL marker and the app
// said the command is terminal. Kept in memory: an extension restart makes the page redeem again
// before it can ask for cleanup, which is safer than persisting tab ids across browser lifetimes.
const staleCommandDocuments = new Map();
let ackingCommands = false;

/**
 * Which ChatGPT conversation each browser tab currently represents.
 *
 * Conversation lifetime is a browser-level fact, not a document-level one. A content
 * script dies on reload and `pagehide` fires even though the tab and conversation are
 * still alive; with two tabs on one chat, either document can disappear while the other
 * remains. Keeping this in the service worker lets a tab reload without closing the
 * app-side session and lets `/closed` mean the last live tab really left.
 *
 * Persisted in storage.session because Chrome routinely stops this worker while tabs stay
 * open. `chrome.tabs.onRemoved` wakes it again and can then retire the right conversation.
 */
let tabConversations = {};
/** Browser-supplied document owner for each tab, plus bounded retired owners. */
let tabDocuments = {};
/** Highest same-document SPA navigation generation accepted for each tab. */
let tabEpochs = {};
let retiredDocuments = {};
/** Durable terminal lease; cleared only when a different browser document speaks. */
let terminalDocuments = {};

/**
 * Command ids this browser has already delivered.
 *
 * Fresh worker/resume commands are app-opened; revivals are routed here after a fresh tab scan.
 * This latch stays because a marked page that reloads must not type the same bootstrap into a
 * second conversation.
 */
let settled = [];
/**
 * Existing-chat revivals that a content document saw while the target chat was not yet safe for
 * another user message. Marker + conversation only: the prime's actual text stays exclusively in
 * the app-side durable command/broker state until a submit-ready page redeems it.
 *
 * Unlike the observation journal this lives in storage.local. A browser restart clears
 * storage.session, and "browser closed while the worker's final answer is still settling" is a
 * normal wait, not permission to lose the wake request. Stale markers are harmless because the
 * bridge redeem is still the authority fence and rejects commands that no longer exist.
 */
let deferredRevivals = [];
// Opening custody is durable independently of a page receipt. Only the app's next outbox
// publication retires an input id; navigation, user-close and MV3 suspension do not.
let inputOpenings = {};
// A terminal helper already needs a fresh empty-document proof before it can close. Keeping that
// proven-empty page for another five minutes only compounds Chrome pressure during a failed
// delivery burst, so retire it promptly while retaining enough time for the final SPA receipt.
const RETIRED_INPUT_TAB_GRACE_MS = 30 * 1000;
const RETIRED_INPUT_SWEEP_MS = 15 * 1000;
// Automatic work must yield before Chrome becomes the failure amplifier. Direct user messages
// may still spend one opening so the UI never deadlocks behind its own recovery traffic.
const MAX_AUTOMATION_CHATGPT_TABS = 48;
let lastRetiredInputSweepAt = 0;
// Stop uses the existing command's absolute lifetime, including across browser restart.
// An elected/loading/user-closed tab never gives that command another opening attempt.
let stopOpenings = {};
/** One in-flight same-tab offer per deferred command in this MV3 worker lifetime. */
const deferredRevivalOffers = new Map();
/** App says an active agent/recovery episode still needs the maintenance cadence. */
let recoveryMonitoring = false;
// The archive is negative custody only. It never authorizes adoption, Send or a final.
let sealedUnassignedHistory = null;
let unassignedHistoryGeneration = null;
let unassignedHistoryUncertain = false;
/** Last app-authored exact command ids whose browser owner needs attention. */
let latestBrowserAttentionCommandIds = [];
/** Tabs whose normal auto-discard policy this extension changed for a live agent conversation. */
let discardProtectedTabs = {};
/**
 * Protected top-level chats by browser tab.
 *
 * `discardProtectedTabs` includes workers, so it cannot decide what Ctrl+W may restore. This
 * narrower map is populated only from main's fresh non-discardable policy after subtracting
 * worker conversations. It survives MV3 suspension because `tabs.onRemoved` commonly wakes a
 * cold service worker after the user has closed the selected tab.
 */
let protectedMainTabs = {};
/** Exact tab ids this worker placed into a CoS-owned group in this browser session. */
let cosGroupedTabs = {};
/**
 * Opaque browser-tab incarnation used only to recover an untouched Resume across a document
 * reload. Local storage lets it survive an extension update/reload. A browser-generation prefix
 * rotates on a whole Chrome restart, so main can distinguish that lost-browser boundary from a
 * copied marker in another tab without weakening the one-command/one-tab fence.
 */
let commandTabLeases = {};
let commandLeaseGeneration = null;
let commandLeaseStartupReset = null;

function load() {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = loadOnce().finally(() => {
      // Only ever cleared after loadOnce() has run to completion or thrown. A throw leaves
      // `loaded` false, so the next caller genuinely retries rather than proceeding on
      // half-initialised globals.
      loading = null;
    });
  }
  return loading;
}

async function loadOnce() {
  unboundEnrollmentSource = false;
  if (commandLeaseStartupReset) await commandLeaseStartupReset;
  const stored = await chrome.storage.local.get(['port', 'token', 'instanceId', 'browserId', 'disconnected', 'deferredRevivals', 'closeOutbox', 'commandAckOutbox', 'inputOpenings', 'desktopInputTabs', 'stopOpenings', 'commandTabLeases', 'commandLeaseGeneration', 'sealedUnassignedHistory']);
  const rawUnassignedLocalCustody = unassignedNonHistoryCustody(stored);
  const unboundLocalSource = neverBoundAccountStorage(stored, true);
  port = typeof stored.port === 'number' ? stored.port : null;
  // Distinguishes two Chrome installations paired to the same local account instance. This is
  // random, profile-local transport identity only; it never identifies the ChatGPT user.
  browserId = typeof stored.browserId === 'string' && /^[a-z0-9]{16,64}$/.test(stored.browserId) ? stored.browserId : '';
  if (!browserId && typeof globalThis.crypto?.getRandomValues === 'function') {
    browserId = [...globalThis.crypto.getRandomValues(new Uint8Array(16))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    await chrome.storage.local.set({ browserId });
  }
  token = typeof stored.token === 'string' ? stored.token : null;
  instanceId = typeof stored.instanceId === 'string' && INSTANCE_ID_PATTERN.test(stored.instanceId)
    ? stored.instanceId
    : null;
  instanceBindingError = stored.instanceId !== undefined && stored.instanceId !== null && instanceId === null
    ? 'invalid_instance_binding'
    : null;
  // Deliberately in `local` rather than `session`: a choice to disconnect that a browser
  // restart undoes is not a choice, it is a delay.
  disconnected = stored.disconnected === true;
  persistedConnection = { port, token, disconnected, instanceId };
  deferredRevivals = Array.isArray(stored.deferredRevivals) ? stored.deferredRevivals.slice(-100) : [];
  stored.inputOpenings = { ...(stored.desktopInputTabs || {}), ...(stored.inputOpenings || {}) };
  inputOpenings = stored.inputOpenings && typeof stored.inputOpenings === 'object' && !Array.isArray(stored.inputOpenings)
    ? Object.fromEntries(Object.entries(stored.inputOpenings)
      .filter(([id, row]) => /^[a-f0-9-]{36}$/i.test(id) && row && (row.tab === null || Number.isInteger(row.tab)))
      .slice(-1000)
      .map(([id, row]) => [id, {
        ...row,
        // Pre-lease builds persisted no timestamp. Grant those exact rows one fresh worker-lifetime
        // lease instead of interpreting missing evidence as an already-expired reservation and
        // creating a duplicate immediately after an MV3 restart.
        electedAt: Number.isFinite(row.electedAt) ? row.electedAt : Date.now()
      }])) : {};
  stopOpenings = stored.stopOpenings && typeof stored.stopOpenings === 'object' && !Array.isArray(stored.stopOpenings)
    ? Object.fromEntries(Object.entries(stored.stopOpenings).filter(([id, row]) => commandMarkerId(id) && row &&
      (row.tab === null || Number.isInteger(row.tab)) && cleanConversationId(row.conversationId) &&
      typeof row.turnId === 'string' && row.turnId.length > 0 && row.turnId.length <= 256 &&
      Number.isFinite(row.expiresAt) && row.expiresAt > Date.now()).slice(-1000)) : {};
  const live = await chrome.storage.session.get([
    'settled',
    'journal',
    'tabConversations',
    'tabDocuments',
    'tabEpochs',
    'retiredDocuments',
    'terminalDocuments',
    'closeOutbox',
    'automaticTabRetirements',
    'commandAckOutbox',
    'pendingInputReceipts',
    'recoveryMonitoring',
    'discardProtectedTabs',
    'protectedMainTabs',
    'cosGroupedTabs',
    'appOwnedOpeningTabs',
    'idleRootTabs',
    'delivery',
    'unassignedHistoryGeneration'
  ]);
  if (Object.prototype.hasOwnProperty.call(stored, 'sealedUnassignedHistory')) {
    try {
      const archive = cloneUnassignedHistoryData(stored.sealedUnassignedHistory);
      if (!validUnassignedHistoryArchive(archive) || archive.browserId !== browserId ||
          await unassignedHistoryDigest(archive.history) !== archive.snapshotDigest ||
          archive.phase !== 'committed' ||
          live.unassignedHistoryGeneration !== undefined && live.unassignedHistoryGeneration !== archive.snapshotDigest ||
          live.unassignedHistoryGeneration === undefined && (Array.isArray(live.journal) && live.journal.length ||
            Array.isArray(live.closeOutbox) && live.closeOutbox.length) ||
          Array.isArray(live.journal) && live.journal.some(row => archive.history.journal.some(old => old.conversationId === row?.conversationId)) ||
          Array.isArray(stored.closeOutbox) && stored.closeOutbox.some(row => archive.history.localCloseOutbox.some(old => old.conversationId === row?.conversationId)))
        throw new Error('unconfirmed history generation');
      sealedUnassignedHistory = archive;
      unassignedHistoryGeneration = archive.snapshotDigest;
      // A confirmed archive is not a durable Pair authorization. If the worker died
      // before the existing connection owner committed its token, require selection.
      if (token === null) disconnected = true;
    } catch {
      unassignedHistoryUncertain = true;
      disconnected = true;
      token = null;
      pairingError = { error: 'account_history_preservation_uncertain',
        message: 'Chrome could not prove the preserved-history generation. Pairing and delivery remain held; preserve companion storage for recovery.' };
    }
  } else if (Object.prototype.hasOwnProperty.call(live, 'unassignedHistoryGeneration')) {
    unassignedHistoryUncertain = true;
    disconnected = true;
    token = null;
  }
  // Retained operation owners are an additional first-enrollment veto, but their storage
  // read is diagnostic custody rather than extension-startup authority. Keep the main state
  // usable when that isolated read fails; pairTo's bounded owner check will then report
  // `ownerReadFailed` without exposing the underlying storage exception.
  let enrollmentOwnerReadFailed = false;
  try {
    Object.assign(live, await chrome.storage.session.get(
      ['projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner']));
  } catch { enrollmentOwnerReadFailed = true; }
  unboundEnrollmentSource = !enrollmentOwnerReadFailed &&
    (unboundLocalSource && neverBoundAccountStorage(live, false) ||
      prospectiveFirstEnrollmentCloseStorage(stored, live));
  settled = Array.isArray(live.settled) ? live.settled : [];
  journal = Array.isArray(live.journal) ? live.journal : [];
  const rawUnassignedCustody = rawUnassignedLocalCustody || enrollmentOwnerReadFailed || unassignedNonHistoryCustody(live);
  if (rawUnassignedCustody && !journal.length && instanceId === null && port === null && token === null && !disconnected &&
      ['instanceId', 'port', 'token', 'disconnected'].every(key => !Object.prototype.hasOwnProperty.call(stored, key)) &&
      Array.isArray(stored.closeOutbox) && stored.closeOutbox.length) {
    const heldCloses = cloneUnassignedHistoryData(stored.closeOutbox);
    for (const row of heldCloses) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Unassigned close custody is malformed. Pairing remains held.');
      Object.defineProperty(row, 'enrollmentCustodyUncertain', { value: true, enumerable: true, configurable: true, writable: true });
    }
    await chrome.storage.local.set({ closeOutbox: heldCloses });
    stored.closeOutbox = heldCloses;
  }
  if (!unboundEnrollmentSource && journal.length && instanceId === null && port === null && token === null && !disconnected &&
      ['instanceId', 'port', 'token', 'disconnected'].every(key => !Object.prototype.hasOwnProperty.call(stored, key))) {
    // Keep an unknown-custody veto on its existing observations before the cold loader can
    // normalize malformed auxiliary state. This is negative custody, never a pairing/Send
    // grant; a later MV3 restart must not promote parsed-empty data to enrollment proof.
    journal = journal.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const held = cloneUnassignedHistoryData(row);
      Object.defineProperty(held, 'enrollmentHeld', { value: true, enumerable: true, configurable: true, writable: true });
      if (rawUnassignedCustody) Object.defineProperty(held, 'enrollmentCustodyUncertain', {
        value: true, enumerable: true, configurable: true, writable: true });
      return held;
    });
    try { await chrome.storage.session.set({ journal }); }
    catch { throw new Error('Could not retain unbound observation custody. Account enrollment remains blocked; check companion storage.'); }
  }
  tabConversations =
    live.tabConversations && typeof live.tabConversations === 'object' && !Array.isArray(live.tabConversations)
      ? { ...live.tabConversations }
      : {};
  tabDocuments = live.tabDocuments && typeof live.tabDocuments === 'object' ? { ...live.tabDocuments } : {};
  tabEpochs = live.tabEpochs && typeof live.tabEpochs === 'object' ? { ...live.tabEpochs } : {};
  retiredDocuments =
    live.retiredDocuments && typeof live.retiredDocuments === 'object' ? { ...live.retiredDocuments } : {};
  terminalDocuments =
    live.terminalDocuments && typeof live.terminalDocuments === 'object' ? { ...live.terminalDocuments } : {};
  // Close/retirement receipts must outlive both MV3 suspension and a browser restart. Prefer the
  // local copy; the session copy remains the upgrade path for receipts queued by older builds.
  closeOutbox = Array.isArray(stored.closeOutbox)
    ? stored.closeOutbox.slice(unassignedHistoryUncertain || instanceId === null && port === null && token === null ? 0 : -200)
    : Array.isArray(live.closeOutbox) ? live.closeOutbox.slice(unassignedHistoryUncertain || instanceId === null && port === null && token === null ? 0 : -200) : [];
  automaticTabRetirements = Object.fromEntries(Object.entries(
    live.automaticTabRetirements && typeof live.automaticTabRetirements === 'object' &&
      !Array.isArray(live.automaticTabRetirements) ? live.automaticTabRetirements : {}
  ).filter(([key, row]) => row && String(row.tab) === key && Number.isInteger(row.tab) &&
    (row.documentId === null || typeof row.documentId === 'string') &&
    (row.navigationEpoch === null || Number.isSafeInteger(row.navigationEpoch)) &&
    (row.conversationId === null || cleanConversationId(row.conversationId)) &&
    (row.phase === undefined || ['prepared', 'issued', 'removed'].includes(row.phase)) &&
    (row.kind === undefined || row.kind === 'superseded-source') &&
    (row.receiptId === undefined || /^[a-f0-9]{32}$/i.test(row.receiptId))).slice(-1000));
  // Browser-close durability: a send already accepted by ChatGPT is irreversible. Its final ACK
  // therefore has to survive storage.session being cleared on browser restart. Prefer the local
  // copy, while still accepting the old session copy as an upgrade migration path.
  commandAckOutbox = Array.isArray(stored.commandAckOutbox)
    ? stored.commandAckOutbox.slice(-200)
    : Array.isArray(live.commandAckOutbox)
      ? live.commandAckOutbox.slice(-200)
      : [];
  const savedPendingInputReceipts =
    live.pendingInputReceipts && typeof live.pendingInputReceipts === 'object' && !Array.isArray(live.pendingInputReceipts)
      ? live.pendingInputReceipts
      : {};
  pendingInputReceipts = Object.fromEntries(Object.entries(savedPendingInputReceipts)
    .filter(([id, row]) => /^[a-f0-9-]{36}$/i.test(id) && row && Number.isInteger(row.tab) &&
      typeof row.owner === 'string' && row.owner.length <= 160 && /^[a-f0-9]{64}$/i.test(row.digest) &&
      Number.isFinite(row.authorizedAt) && Date.now() - row.authorizedAt <= PENDING_INPUT_RECEIPT_MS)
    .slice(-100));
  recoveryMonitoring = live.recoveryMonitoring === true;
  const savedDiscardProtection =
    live.discardProtectedTabs && typeof live.discardProtectedTabs === 'object' && !Array.isArray(live.discardProtectedTabs)
      ? live.discardProtectedTabs
      : {};
  discardProtectedTabs = Object.fromEntries(
    Object.entries(savedDiscardProtection).filter(([id, owned]) => /^\d+$/.test(id) && owned === true)
  );
  const savedProtectedMainTabs =
    live.protectedMainTabs && typeof live.protectedMainTabs === 'object' && !Array.isArray(live.protectedMainTabs)
      ? live.protectedMainTabs
      : {};
  protectedMainTabs = Object.fromEntries(
    Object.entries(savedProtectedMainTabs)
      .filter(([id, conversationId]) => /^\d+$/.test(id) && cleanConversationId(conversationId))
      .slice(-1000)
  );
  const savedGroupedTabs =
    live.cosGroupedTabs && typeof live.cosGroupedTabs === 'object' && !Array.isArray(live.cosGroupedTabs)
      ? live.cosGroupedTabs
      : {};
  cosGroupedTabs = Object.fromEntries(
    Object.entries(savedGroupedTabs)
      .filter(([id, row]) => /^\d+$/.test(id) && row && Number.isInteger(row.groupId) &&
        Number.isInteger(row.windowId) && typeof row.category === 'string' &&
        ['chat', 'worker', 'queue', 'cleanup'].includes(row.category))
      .slice(-1000)
  );
  const savedCommandTabLeases =
    stored.commandTabLeases && typeof stored.commandTabLeases === 'object' && !Array.isArray(stored.commandTabLeases)
      ? stored.commandTabLeases
      : {};
  commandTabLeases = Object.fromEntries(
    Object.entries(savedCommandTabLeases)
      .filter(([id, lease]) => /^\d+$/.test(id) && typeof lease === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(lease))
      .slice(-1000)
  );
  commandLeaseGeneration = typeof stored.commandLeaseGeneration === 'string' &&
    /^[a-f0-9]{32}$/.test(stored.commandLeaseGeneration)
    ? stored.commandLeaseGeneration
    : crypto.randomUUID().replaceAll('-', '');
  if (stored.commandLeaseGeneration !== commandLeaseGeneration) {
    await chrome.storage.local.set({ commandLeaseGeneration });
  }
  const savedOpeningTabs =
    live.appOwnedOpeningTabs && typeof live.appOwnedOpeningTabs === 'object' && !Array.isArray(live.appOwnedOpeningTabs)
      ? live.appOwnedOpeningTabs
      : {};
  appOwnedOpeningTabs = Object.fromEntries(
    Object.entries(savedOpeningTabs)
      .filter(([id, row]) => /^\d+$/.test(id) && row && Number.isFinite(row.createdAt))
      .map(([id, row]) => [id, {
        createdAt: row.createdAt,
        ...(commandMarkerId(row.marker) ? { marker: row.marker } : {}),
        ...(typeof row.owner === 'string' && /^resume:[0-9a-f-]{8,64}$/i.test(row.owner)
          ? { owner: row.owner.toLowerCase() }
          : {}),
        ...(cleanConversationId(row.conversationId) &&
            typeof row.openRequestId === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(row.openRequestId) &&
            (row.openState === 'opening' || row.openState === 'redirected' || row.openState === 'escalated')
          ? {
              conversationId: cleanConversationId(row.conversationId),
              openRequestId: row.openRequestId,
              openState: row.openState,
              retargetCount: Number.isSafeInteger(row.retargetCount)
                ? Math.max(0, Math.min(2, row.retargetCount))
                : 0,
              replacementCreated: row.replacementCreated === true,
              ...(row.openState === 'escalated' && typeof row.escalationNonce === 'string' &&
                  /^[a-f0-9]{32}$/i.test(row.escalationNonce)
                ? {
                    escalationNonce: row.escalationNonce.toLowerCase(),
                    escalationReported: row.escalationReported === true
                  }
                : {})
            }
          : {}),
        ...(typeof row.repairDocumentId === 'string' && Number.isSafeInteger(row.repairNavigationEpoch) &&
            Number.isFinite(row.repairAttemptedAt)
          ? {
              repairDocumentId: row.repairDocumentId,
              repairNavigationEpoch: row.repairNavigationEpoch,
              repairAttemptedAt: row.repairAttemptedAt
            }
          : {})
      }])
      .slice(-200)
  );
  const savedIdleRoots =
    live.idleRootTabs && typeof live.idleRootTabs === 'object' && !Array.isArray(live.idleRootTabs)
      ? live.idleRootTabs
      : {};
  idleRootTabs = Object.fromEntries(
    Object.entries(savedIdleRoots)
      .filter(([id, row]) => /^\d+$/.test(id) && row && Number.isFinite(row.seenAt) &&
        Number.isFinite(row.lastAccessedAt) && typeof row.documentId === 'string' &&
        Number.isSafeInteger(row.navigationEpoch) && typeof row.url === 'string')
      .map(([id, row]) => [id, {
        appOwned: row.appOwned === true,
        seenAt: row.seenAt,
        lastAccessedAt: row.lastAccessedAt,
        documentId: row.documentId,
        navigationEpoch: row.navigationEpoch,
        url: row.url,
        ...(typeof row.repairDocumentId === 'string' && Number.isSafeInteger(row.repairNavigationEpoch) &&
            Number.isFinite(row.repairAttemptedAt)
          ? {
              repairDocumentId: row.repairDocumentId,
              repairNavigationEpoch: row.repairNavigationEpoch,
              repairAttemptedAt: row.repairAttemptedAt
            }
          : {})
      }])
      .slice(-400)
  );
  if (live.delivery && typeof live.delivery === 'object' && !Array.isArray(live.delivery)) {
    delivery = { ...delivery, ...live.delivery };
  }
  loaded = true;
}

// Connection writes are asynchronous Chrome IPC. Serialize snapshots in request order so
// an old retarget write cannot finish after and erase a newer explicit Disconnect. Ordinary
// observations read the live connection at their write boundary, never queue an old account.
let connectionPersistTail = Promise.resolve();
function persist(snapshot = () => ({ port, token, disconnected, instanceId }), commit = null, accept = null, restoreUnboundSelection = null) {
  const write = connectionPersistTail.then(async () => {
    const next = typeof snapshot === 'function' ? snapshot() : snapshot;
    if (accept && !(await accept(false))) return false;
    // A cancelled first selection restores the proven absent tuple, not fabricated null
    // connection history. Read the current tuple at this serialized boundary: a newer choice
    // or Disconnect must never be erased by an older compensation.
    const restoreAbsence = restoreUnboundSelection && next.port === null && next.token === null &&
      next.instanceId === null && next.disconnected === false;
    if (!restoreAbsence && persistedConnection &&
        persistedConnection.port === next.port &&
        persistedConnection.token === next.token &&
        persistedConnection.disconnected === next.disconnected &&
        persistedConnection.instanceId === next.instanceId) {
      if (commit && commit() === false) return false;
      return true;
    }
    if (restoreAbsence) {
      // Compensation owns only this operation's exact staged tuple. Another generation or
      // raw storage writer is not represented by our epoch; never erase its replacement.
      let timer;
      let stored;
      try {
        stored = await Promise.race([
          chrome.storage.local.get(['port', 'token', 'disconnected', 'instanceId']),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS); })
        ]);
      } finally { clearTimeout(timer); }
      if (!stored || !['port', 'token', 'disconnected', 'instanceId'].every(key =>
          Object.prototype.hasOwnProperty.call(stored, key) && stored[key] === restoreUnboundSelection[key]))
        throw new Error('Account selection custody changed before compensation.');
      await chrome.storage.local.remove(['port', 'token', 'disconnected', 'instanceId']);
    }
    else await chrome.storage.local.set({
        port: next.port,
        token: next.token,
        disconnected: next.disconnected,
        ...(next.instanceId ? { instanceId: next.instanceId } : {})
      });
    if (!next.instanceId && persistedConnection?.instanceId) await chrome.storage.local.remove('instanceId');
    persistedConnection = next;
    if (accept && !(await accept(true))) return false;
    if (commit && commit() === false) return false;
    return true;
  });
  connectionPersistTail = write.catch(() => undefined);
  return write;
}

let liveWriteQueue = Promise.resolve();

function persistLive() {
  const write = liveWriteQueue.then(() =>
    Promise.all([
      chrome.storage.session.set({
        settled: settled.slice(-40),
        tabConversations,
        tabDocuments,
        tabEpochs,
        retiredDocuments,
        terminalDocuments,
        closeOutbox: instanceId === null && port === null && token === null || unassignedHistoryUncertain ? closeOutbox : closeOutbox.slice(-200),
        automaticTabRetirements,
        commandAckOutbox: commandAckOutbox.slice(-200),
        pendingInputReceipts,
        recoveryMonitoring,
        discardProtectedTabs,
        protectedMainTabs,
        cosGroupedTabs,
        appOwnedOpeningTabs,
        idleRootTabs,
        delivery,
        ...(unassignedHistoryGeneration ? { unassignedHistoryGeneration } : {})
      }),
      // Only small command-control metadata crosses browser restarts. No transcript and no
      // revival text is duplicated into extension storage.
      chrome.storage.local.set({
        closeOutbox: instanceId === null && port === null && token === null || unassignedHistoryUncertain ? closeOutbox : closeOutbox.slice(-200),
        commandAckOutbox: commandAckOutbox.slice(-200),
        inputOpenings,
        stopOpenings,
        commandTabLeases,
        commandLeaseGeneration,
        deferredRevivals: deferredRevivals.slice(-100)
      })
    ])
  );
  liveWriteQueue = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}

/**
 * Writes the journal where it will survive this worker being shut down.
 *
 * Chrome stops the service worker after seconds of idling, so an in-memory journal is
 * not a journal at all. If the write is refused the size estimate was optimistic, so
 * compact harder and try once more; only if *that* fails is durability genuinely lost,
 * and then the journal says so in place rather than pretending it is safe.
 */
let durabilityGap = false;
let journalWriteQueue = Promise.resolve();

async function persistJournalNow() {
  try {
    await chrome.storage.session.set({ journal, ...(unassignedHistoryGeneration ? { unassignedHistoryGeneration } : {}) });
    durabilityGap = false;
    return true;
  } catch {
    if (unassignedHistoryUncertain || instanceId === null && port === null && token === null) {
      if (!durabilityGap) console.warn('[Chat On Steroids] unassigned observations remain held after journal storage refusal', {
        category: 'journal_save_failed', journalCount: Math.min(4000, journal.length) });
      durabilityGap = true;
      return false;
    }
    makeRoom(true);
    try {
      await chrome.storage.session.set({ journal, ...(unassignedHistoryGeneration ? { unassignedHistoryGeneration } : {}) });
      durabilityGap = false;
      return true;
    } catch (err) {
      if (!durabilityGap) {
        durabilityGap = true;
        journal.push(
          gapEntry(
            journal.length > 0 ? journal[journal.length - 1] : null,
            'chat_error',
            '⚠ The browser refused to store this extension’s pending observations. Until the app accepts them they exist only in memory, so closing the browser or reloading the extension would lose them.'
          )
        );
      }
      return false;
    }
  }
}

// Maximapple PR1666 / 2aa6a753: a burst shares one not-yet-started durable snapshot.
// Never reuse the promise for a snapshot already in flight: it cannot include later events.
let queuedJournalWrite = null;

function persistJournal() {
  // Keep serialized publication while avoiding a whole-journal rewrite for every caller.
  if (queuedJournalWrite) return queuedJournalWrite;
  const write = journalWriteQueue.then(() => {
    queuedJournalWrite = null;
    return persistJournalNow();
  });
  queuedJournalWrite = write;
  journalWriteQueue = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}

// --------------------------------------------------------------------- journal

/**
 * Events that are dropped only when there is genuinely nothing else to give up.
 *
 * Progress lines are not among them: they are dense, repetitive, and their outline can
 * be inferred from what surrounds them. A user message cannot be inferred from anything.
 */
const ESSENTIAL = new Set(['user_message', 'assistant_message', 'chat_error', 'turn_start', 'turn_end']);

/**
 * Cached per-entry serialised size, kept out-of-band so measuring an entry does not
 * mutate the thing we later write to chrome.storage.session.
 *
 * The old cache lived as `entry.b`. That made every measured entry several bytes larger
 * after it had been measured, so the journal could report itself under the 4 MiB cap
 * while the actual JSON written to Chrome was already over it.
 */
const sizeCache = new WeakMap();
const utf8 = new TextEncoder();

function sizeOf(entry) {
  const cached = sizeCache.get(entry);
  if (typeof cached === 'number') return cached;
  let bytes = 500;
  try {
    // Chrome limits storage by bytes. JS string length counts UTF-16 code units, so German
    // text, CJK and especially emoji could make the journal several times larger than this
    // guard believed and turn an acknowledged observation back into volatile RAM.
    bytes = utf8.encode(JSON.stringify(entry)).byteLength;
  } catch {
    // A malformed observation will be rejected by the app later; keep its pressure
    // estimate conservative here so it cannot bypass the browser journal cap.
  }
  sizeCache.set(entry, bytes);
  return bytes;
}

/** Exact JSON-array size for the journal itself, including commas and brackets. */
function totalBytes() {
  if (journal.length === 0) return 2;
  let sum = 2 + journal.length - 1;
  for (const entry of journal) sum += sizeOf(entry);
  return sum;
}

/**
 * Copies the identity that decides where one queued observation may be delivered.
 *
 * A fresh chat has no conversation id yet, so `provisional` is just as important as the
 * eventual id. Worker provenance also has to stay on the exact row that carried it: combining
 * an agent label from one row with another row's command id would manufacture authority.
 */
function routeOf(entry) {
  return {
    conversationId: entry && typeof entry.conversationId === 'string' ? entry.conversationId : null,
    provisional: entry && typeof entry.provisional === 'string' ? entry.provisional : null,
    agent: entry && typeof entry.agent === 'string' ? entry.agent : null,
    agentCommandId: entry && typeof entry.agentCommandId === 'string' ? entry.agentCommandId : null,
    project: entry && typeof entry.project === 'string' && /^g-p-[0-9a-f]{32}$/.test(entry.project)
      ? entry.project
      : null
  };
}

function routeKey(entry) {
  const route = routeOf(entry);
  return JSON.stringify([route.conversationId, route.provisional, route.agent, route.agentCommandId]);
}

function gapEntry(source, kind, text) {
  return { ...routeOf(source), gap: true, event: { kind, time: Date.now(), text } };
}

/**
 * Brings the journal back inside both budgets — count *and* bytes.
 *
 * Both matter and for different reasons: the count keeps a run of tiny events from
 * making every write expensive, and the byte figure is the one Chrome enforces. Being
 * under one while over the other is what quietly turned this journal back into plain
 * RAM, because chrome.storage.session then refused the write.
 *
 * Progress lines go first, oldest first. Essentials are given up only when dropping
 * every last progress line still leaves the journal over budget — and when that
 * happens it is stated in the record, in place, rather than closed over. A history with
 * an acknowledged hole is usable; one with an invisible hole is not.
 *
 * `tighten` compacts to roughly three quarters of the budget instead of exactly to it,
 * used when Chrome has already refused a write and the estimate is evidently optimistic.
 */
function makeRoom(tighten = false) {
  const countCap = tighten ? Math.floor(MAX_JOURNAL * 0.75) : MAX_JOURNAL;
  const byteCap = tighten ? Math.floor(MAX_JOURNAL_BYTES * 0.75) : MAX_JOURNAL_BYTES;
  // Measure once. sizeOf() is cached, but summing all 4,000 retained entries on every
  // discarded row still made quota compaction quadratic under a long outage.
  let bytes = totalBytes();
  const fits = () => journal.length <= countCap && bytes <= byteCap;
  if (fits()) return;

  const removeAt = (index) => {
    const before = journal.length;
    const [entry] = journal.splice(index, 1);
    if (!entry) return null;
    bytes -= sizeOf(entry) + (before > 1 ? 1 : 0);
    return entry;
  };
  const insertAt = (index, entry) => {
    const comma = journal.length > 0 ? 1 : 0;
    journal.splice(Math.min(index, journal.length), 0, entry);
    bytes += sizeOf(entry) + comma;
  };
  /** Updates a gap and keeps the running exact serialised size in sync. */
  const setGapText = (gap, text) => {
    const before = sizeOf(gap);
    gap.event.text = text;
    sizeCache.delete(gap);
    bytes += sizeOf(gap) - before;
  };

  // Pass one: progress and other non-essential lines, oldest first. The gap marker is
  // inserted on the first removal and counts against the limits while we keep trimming,
  // so pressure can never make the algorithm delete its own evidence of what was lost.
  const progressGaps = new Map();
  let progressAt = 0;
  while (!fits()) {
    while (
      progressAt < journal.length &&
      (journal[progressAt].gap || ESSENTIAL.has(journal[progressAt].event.kind))
    ) {
      progressAt++;
    }
    if (progressAt >= journal.length) break;
    const index = progressAt;
    const entry = removeAt(index);
    if (!entry) break;
    const key = routeKey(entry);
    let bucket = progressGaps.get(key);
    if (!bucket) {
      bucket = { gap: gapEntry(entry, 'progress', ''), dropped: 0 };
      progressGaps.set(key, bucket);
      insertAt(index, bucket.gap);
      progressAt = index + 1;
    }
    bucket.dropped++;
    setGapText(
      bucket.gap,
      `⚠ ${bucket.dropped} progress line(s) observed here were dropped in the browser before the app accepted them. The app was unreachable and the local queue was full.`
    );
  }
  if (fits()) return;

  // Pass two: essentials themselves have to go. This is real loss, so keep one durable
  // marker naming exactly what kinds disappeared. As above, the marker is present while
  // trimming, which guarantees the final journal is genuinely inside both caps.
  const lossGaps = new Map();
  let lossAt = 0;
  while (!fits()) {
    while (lossAt < journal.length && journal[lossAt].gap) lossAt++;
    if (lossAt >= journal.length) break;
    const index = lossAt;
    const entry = removeAt(index);
    if (!entry) break;
    const key = routeKey(entry);
    let bucket = lossGaps.get(key);
    if (!bucket) {
      bucket = { gap: gapEntry(entry, 'chat_error', ''), lost: 0, counts: {} };
      lossGaps.set(key, bucket);
      insertAt(index, bucket.gap);
      lossAt = index + 1;
    }
    bucket.lost++;
    bucket.counts[entry.event.kind] = (bucket.counts[entry.event.kind] || 0) + 1;
    const detail = Object.entries(bucket.counts)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ');
    setGapText(
      bucket.gap,
      `⚠ ${bucket.lost} observation(s) (${detail}) were lost in the browser before the app accepted them: the local journal hit its storage limit while the app was unreachable. This part of the history is incomplete.`
    );
  }
}

function enqueue(entries) {
  for (const entry of entries) {
    if (!entry || !entry.event || typeof entry.event.kind !== 'string') continue;
    journal.push({
      conversationId: typeof entry.conversationId === 'string' ? entry.conversationId : null,
      // Observations made before ChatGPT has assigned a conversation id are held under
      // the tab that saw them; bindProvisional() renames them once the id exists.
      provisional: typeof entry.provisional === 'string' ? entry.provisional : null,
      agent: typeof entry.agent === 'string' ? entry.agent : null,
      agentCommandId: typeof entry.agentCommandId === 'string' ? entry.agentCommandId : null,
      project: typeof entry.project === 'string' && /^g-p-[0-9a-f]{32}$/.test(entry.project) ? entry.project : null,
      ...(!unboundEnrollmentSource && instanceId === null && port === null && token === null && !disconnected
        ? { enrollmentHeld: true } : {}),
      event: entry.event
    });
  }
  if (!unassignedHistoryUncertain && !(instanceId === null && port === null && token === null)) makeRoom();
}

/**
 * Gives a real conversation id to everything a tab observed before one existed.
 *
 * A brand new chat has no id until ChatGPT accepts the first message, and that is
 * exactly when the first user message is observed. Those entries are journalled here
 * immediately under the tab's key, so a reload in that window does not take them with
 * it, and this renames them the moment the id turns up.
 *
 * Only entries observed in the last ten minutes are bound. A tab that sat on an empty
 * composer this morning and is used for a different chat this afternoon must not have
 * the morning's observations filed into the afternoon's conversation.
 */
const PROVISIONAL_TTL_MS = 10 * 60 * 1000;

function bindProvisional(provisional, conversationId) {
  if (!provisional || !conversationId) return 0;
  const cutoff = Date.now() - PROVISIONAL_TTL_MS;
  let bound = 0;
  for (const entry of journal) {
    if (entry.provisional !== provisional || entry.conversationId) continue;
    if (typeof entry.event.time === 'number' && entry.event.time < cutoff) continue;
    entry.conversationId = conversationId;
    entry.provisional = null;
    sizeCache.delete(entry);
    bound++;
  }
  return bound;
}

/**
 * Promotes a fresh command's durable ACK gate once ChatGPT finally assigns /c/<id>.
 *
 * A command may report `sent` before the fresh route exists. Its observations are still
 * journalled under this document's provisional key, so if the ACK itself is waiting on a
 * transient bridge failure we must carry that same identity forward when `bind` happens.
 * Otherwise the newly named observations could overtake the still-pending command result.
 */
function bindCommandAckProvisional(provisional, conversationId) {
  if (!provisional || !conversationId) return 0;
  let bound = 0;
  for (const entry of commandAckOutbox) {
    if (!entry || entry.conversationId || entry.provisional !== provisional) continue;
    entry.conversationId = conversationId;
    bound++;
  }
  return bound;
}

/**
 * Delivers what the app has not accepted yet, FIFO within each conversation.
 *
 * Nothing leaves the journal until the app answers 200 for that batch. A 413 is the one
 * case where retrying unchanged is pointless, so the batch is halved instead.
 */
/** Records one /events attempt for the popup's diagnostics. Never affects delivery. */
function noteDelivery(result, count, conversationId) {
  delivery = {
    at: Date.now(),
    ok: result.ok === true,
    events: count,
    total: delivery.total + (result.ok === true ? count : 0),
    conversationId: conversationId || null,
    status: result.status || 0,
    error: result.ok === true ? null : String(result.error || `HTTP ${result.status || 0}`)
  };
}

/** Finds the next deliverable conversation and its first batch in one journal pass. */
function nextJournalBatch(preferredConversationId = null, excluded = []) {
  if (unassignedHistoryUncertain) return null;
  const blocked = new Set(excluded);
  for (const ack of commandAckOutbox) {
    if (ack && ack.conversationId) blocked.add(ack.conversationId);
  }
  const preferred = cleanConversationId(preferredConversationId);
  let conversationId =
    preferred && !blocked.has(preferred) && !unassignedHistoryConversation(preferred) && journal.some((entry) => entry.conversationId === preferred)
      ? preferred
      : null;
  let agent;
  let agentCommandId;
  let project;
  const mine = [];
  for (const entry of journal) {
    if (unassignedHistoryConversation(entry.conversationId)) continue;
    if (!conversationId) {
      if (!entry.conversationId || blocked.has(entry.conversationId)) continue;
      conversationId = entry.conversationId;
    }
    if (entry.conversationId !== conversationId || mine.length >= BATCH) continue;
    mine.push(entry);
    // Recovery provenance must come from the same journal entry. Older entries can have an
    // agent label but no command id; keep delivering them, but never upgrade that label into
    // worker-binding authority by combining it with another row's command id.
    if (!agent && entry.agent && entry.agentCommandId) {
      agent = entry.agent;
      agentCommandId = entry.agentCommandId;
    }
    if (!project && entry.project) project = entry.project;
    if (mine.length >= BATCH) break;
  }
  return conversationId ? { conversationId, mine, agent, agentCommandId, project } : null;
}

// Local diagnostic evidence only. Never focus, open, attach a debugger or replay work to
// obtain pixels. An invisible/stale document is reported as unavailable, not screenshot proof.
let browserDebugCaptureInFlight = false;
let browserDebugCaptureLastAt = 0;
async function captureBrowserDebug(offer) {
  if (!offer || typeof offer.id !== 'string' || !cleanConversationId(offer.conversationId) ||
      !Number.isFinite(offer.expiresAt) || offer.expiresAt <= Date.now()) return;
  if (browserDebugCaptureInFlight || Date.now() - browserDebugCaptureLastAt < 1000) return;
  browserDebugCaptureInFlight = true;
  browserDebugCaptureLastAt = Date.now();
  let status = 'capture_unavailable', image, captureTimer;
  const pairingEpoch = connectionEpoch, pairingInstance = instanceId;
  let visibilityChanged = false;
  const visibilityChange = () => { visibilityChanged = true; };
  const paired = () => connectionEpoch === pairingEpoch && instanceId === pairingInstance &&
    pairingInstance !== null && token !== null && !disconnected &&
    !unassignedHistoryUncertain && !unassignedHistoryConversation(offer.conversationId);
  try {
    const preference = await chrome.storage.local.get('browserDebugScreenshots');
    if (preference.browserDebugScreenshots !== true ||
        !await chrome.permissions.contains({ origins: ['<all_urls>'] })) {
      await call('/browser-debug', { method: 'POST', body: JSON.stringify({ id: offer.id,
        conversationId: offer.conversationId, status: 'screenshots_disabled' }) }, false, paired);
      return;
    }
    // Also reject away-and-back focus races, which before/after active-tab checks miss.
    chrome.tabs.onActivated.addListener(visibilityChange);
    chrome.windows.onFocusChanged.addListener(visibilityChange);
    const candidates = (await chrome.tabs.query({ active: true })).filter(tab =>
      cleanConversationId(tabConversations[String(tab.id)]) === offer.conversationId &&
      !tab.pendingUrl && conversationFromUrl(tab.url) === offer.conversationId);
    if (candidates.length !== 1) status = 'hidden_tab';
    else {
      const tab = candidates[0], source = { tab: tab.id, documentId: tabDocuments[String(tab.id)],
        navigationEpoch: tabEpochs[String(tab.id)] };
      const window = await chrome.windows.get(tab.windowId);
      const current = () => !visibilityChanged && Number.isSafeInteger(source.navigationEpoch) &&
        paired() && offer.expiresAt > Date.now() && ownsDocument(source) &&
        cleanConversationId(tabConversations[String(tab.id)]) === offer.conversationId;
      if (!window.focused || window.state === 'minimized') status = 'hidden_tab';
      else if (!current()) status = 'stale_document';
      else {
        const captured = await Promise.race([
          chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 40 }),
          new Promise((_, reject) => { captureTimer = setTimeout(() => reject(new Error('capture_timeout')), 2000); })
        ]);
        const after = await chrome.tabs.get(tab.id);
        const afterWindow = await chrome.windows.get(tab.windowId);
        const stillEnabled = (await chrome.storage.local.get('browserDebugScreenshots')).browserDebugScreenshots === true &&
          await chrome.permissions.contains({ origins: ['<all_urls>'] });
        if (!stillEnabled || !current() || !after.active || after.pendingUrl || after.windowId !== tab.windowId ||
            !afterWindow.focused || afterWindow.state === 'minimized' ||
            conversationFromUrl(after.url) !== offer.conversationId) status = 'stale_document';
        else if (typeof captured !== 'string' || captured.length > 1_600_000) status = 'capture_too_large';
        else { image = captured; status = 'captured'; }
      }
    }
  } catch { status = 'capture_unavailable'; }
  finally {
    clearTimeout(captureTimer);
    browserDebugCaptureInFlight = false;
    chrome.tabs.onActivated?.removeListener(visibilityChange);
    chrome.windows.onFocusChanged?.removeListener(visibilityChange);
  }
  // This optional request has no retry journal. A missing screenshot cannot hold transcript
  // delivery or authorize another capture; the app's original log still says offered.
  await call('/browser-debug', { method: 'POST', body: JSON.stringify({ id: offer.id, conversationId: offer.conversationId, status,
    ...(image ? { image } : {}) }) }, false, paired).catch(() => {});
}

async function deliverJournalBatch(batch) {
  const { conversationId, mine, agent, agentCommandId, project } = batch;
  const result = await call('/events', {
    method: 'POST',
    body: JSON.stringify({
      conversationId,
      agent,
      agentCommandId,
      project,
      events: mine.map((entry) => entry.event)
    })
  });
  noteDelivery(result, mine.length, conversationId);
  if (result.status === 413 && mine.length > 1) {
    // Too big for the app to accept. Send half; the remainder stays queued.
    const half = mine.slice(0, Math.floor(mine.length / 2));
    const retry = await call('/events', {
      method: 'POST',
      body: JSON.stringify({ conversationId, agent, agentCommandId, project, events: half.map((entry) => entry.event) })
    });
    noteDelivery(retry, half.length, conversationId);
    if (!retry.ok) return false;
    const sent = new Set(half);
    journal = journal.filter((entry) => !sent.has(entry));
    return true;
  }
  if (result.status === 413 && mine.length === 1) {
    const rejected = mine[0];
    journal = journal.filter((entry) => entry !== rejected);
    journal.unshift(
      gapEntry(
        rejected,
        'chat_error',
        '⚠ One browser observation was too large for the local bridge and was replaced by this explicit gap.'
      )
    );
    return true;
  }
  if (!result.ok) {
    // A permanently malformed/authenticated item must not hold every later
    // conversation hostage. Replace it with an explicit gap and continue; transport,
    // auth, throttling and server failures remain retryable.
    if (result.status >= 400 && result.status < 500 && ![401, 408, 409, 426, 429].includes(result.status)) {
      const rejected = mine[0];
      journal = journal.filter((entry) => entry !== rejected);
      if (!rejected.gap) {
        journal.unshift(
          gapEntry(
            rejected,
            'chat_error',
            `⚠ One browser observation was rejected by the local bridge (HTTP ${result.status}) and was replaced by this explicit gap.`
          )
        );
      }
      return true;
    }
    scheduleRetry();
    return false;
  }
  const sent = new Set(mine);
  journal = journal.filter((entry) => !sent.has(entry));
  if (result.data?.debugCapture) void captureBrowserDebug(result.data.debugCapture).catch(() => {});
  return true;
}

function selectJournalBatch() {
  const excluded = new Set([...journalInFlight.keys(), ...journalFailed]);
  for (const preference of journalPreferences) {
    const batch = nextJournalBatch(preference.conversationId, excluded);
    if (batch?.conversationId === preference.conversationId) return batch;
  }
  // A hot conversation must yield to another ready conversation between batches.
  let batch = nextJournalBatch(null, [...excluded, ...journalServed]);
  if (!batch) {
    batch = nextJournalBatch(null, excluded);
    if (batch) journalServed.clear();
  }
  return batch;
}

async function runJournalWorker(batch) {
  try {
    for (let attempt = 0; batch && attempt < 20; attempt++) {
      const id = batch.conversationId;
      journalServed.add(id);
      const work = deliverJournalBatch(batch);
      journalInFlight.set(id, work);
      try {
        if (!(await work)) journalFailed.add(id);
      } catch {
        journalFailed.add(id);
      } finally {
        if (journalInFlight.get(id) === work) journalInFlight.delete(id);
      }
      batch = selectJournalBatch();
    }
  } finally {
    // Retain the original drain-level storage cadence. App ACKs permit removal;
    // suspension before this snapshot may replay accepted rows, never lose pending ones.
    await persistJournal();
  }
}

function startJournalWorkers() {
  if (!token) return [];
  if (journalWorkers.size === 0) {
    journalFailed.clear();
    journalServed.clear();
  }
  const started = [];
  while (journalWorkers.size < JOURNAL_CONCURRENCY) {
    const batch = selectJournalBatch();
    if (!batch) break;
    const work = runJournalWorker(batch).finally(() => {
      journalWorkers.delete(work);
      if (journal.length > 0) scheduleRetry();
      else clearRetryIfIdle();
    });
    journalWorkers.add(work);
    started.push(work);
  }
  if (journal.length > 0) scheduleRetry();
  return started;
}

/** Normal callers acknowledge journal custody without joining another chat's transport. */
async function drain() {
  await load();
  const alreadyRunning = journalWorkers.size > 0;
  const started = startJournalWorkers();
  if (!alreadyRunning) await Promise.all(started);
  return { ok: true, pending: journal.length };
}

function journalCountForConversation(conversationId) {
  return journal.reduce((count, entry) => count + (entry.conversationId === conversationId ? 1 : 0), 0);
}

/** Goal joins its own batches; another conversation's slow request is not its read barrier. */
async function deliverConversationJournal(conversationId) {
  // Failed batches are excluded for the current drain, so one outage cannot spin inside
  // a worker. A different chat may keep that drain alive for minutes, however: the exact
  // Goal owner's later retry must get one fresh attempt at its OWN retained transcript.
  // Concurrent joiners share the attempt; receipt-before-history and every other chat's
  // failed/in-flight custody remain unchanged. This does not replay a provider Send.
  const alreadyJoining = [...journalPreferences].some(entry => entry.conversationId === conversationId);
  if (!alreadyJoining && !journalInFlight.has(conversationId)) journalFailed.delete(conversationId);
  const preference = { conversationId };
  journalPreferences.add(preference);
  try {
    // Covers the bounded 4,000-row journal, including slot handoffs and split batches.
    for (let attempt = 0; attempt < 120; attempt++) {
      if (journalCountForConversation(conversationId) === 0) {
        if (attempt > 0) await persistJournal();
        return true;
      }
      startJournalWorkers();
      if (journalFailed.has(conversationId)) return false;
      const own = journalInFlight.get(conversationId);
      if (own) {
        if (!(await own)) return false;
      } else {
        // A send receipt for this exact conversation must commit before its transcript can
        // overtake it. Goal is already awake and asking for that transcript, so actively drain
        // the existing durable ACK owner instead of waiting for the 30-second maintenance alarm.
        // If the receipt is still retryable/unavailable, keep the journal fenced and let the
        // page's existing bounded Goal retry ask again; never weaken receipt-before-history.
        if (commandAckOutbox.some(ack => ack?.conversationId === conversationId)) {
          await drainCommandAcks();
          if (commandAckOutbox.some(ack => ack?.conversationId === conversationId)) return false;
          continue;
        }
        if (journalWorkers.size === 0) return false;
        // A slot may be finishing its storage snapshot after the last HTTP batch. Its
        // completion also frees capacity; waiting only on the other HTTP slot would stall.
        await Promise.race([...journalInFlight.values(), ...journalWorkers]);
      }
    }
    return journalCountForConversation(conversationId) === 0;
  } finally {
    journalPreferences.delete(preference);
  }
}

// -------------------------------------------------------------------- transport

async function fetchBounded(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const external = init.signal;
  const abort = () => controller.abort();
  if (external && external.aborted) controller.abort();
  else if (external && typeof external.addEventListener === 'function') external.addEventListener('abort', abort, { once: true });
  // Aborted with a reason on purpose. An abort with none rejects as the platform's opaque
  // "signal is aborted without reason", which is exactly what this worker's own deadline
  // used to put on screen in place of anything a reader could act on.
  const timer = setTimeout(() => controller.abort(new Error(TIMED_OUT)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (external && typeof external.removeEventListener === 'function') external.removeEventListener('abort', abort);
  }
}

/**
 * Whether the periodic alarm still has something to do.
 *
 * Undelivered records are the obvious half. Open ChatGPT tabs are the other: while this
 * browser is holding chats, the app may need one of them reloaded — see maintain() — and this
 * alarm is the only thing that wakes a stopped service worker to ask. Both halves are work
 * this worker owes somebody, so they share the one alarm rather than growing a second.
 *
 * It is also what ends the cadence: the pass that finds nothing left to do arms nothing, and
 * the worker goes back to sleep until a page or the browser wakes it.
 */
function retryWanted() {
  // Paired at all is reason enough. The app hands out reopen/reload work only when this worker
  // asks for it, and after a browser restart this worker holds no tabs and no queues — which is
  // exactly when a Loop chat the user closed is waiting to be opened again. On 2026-09-02 a Loop
  // prime sat unopened for good because nothing here thought it had a reason to ask.
  return (
    token !== null ||
    // A freshly loaded unpacked extension has an empty store and no page traffic yet. Keep one
    // alarm alive so it can provision itself instead of showing "service worker inactive" until
    // somebody opens the popup. An explicit Disconnect remains authoritative.
    !disconnected ||
    journal.length > 0 ||
    closeOutbox.length > 0 ||
    commandAckOutbox.length > 0 ||
    deferredRevivals.length > 0 ||
    Object.keys(tabConversations).length > 0 ||
    Object.keys(discardProtectedTabs).length > 0 ||
    Object.keys(appOwnedOpeningTabs).length > 0 ||
    Object.keys(idleRootTabs).length > 0 ||
    recoveryMonitoring
  );
}

function scheduleRetry() {
  if (!retryWanted()) return;
  if (retryAlarmScheduled) return;
  try {
    if (chrome.alarms && typeof chrome.alarms.create === 'function') {
      chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_PERIOD_MIN });
      retryAlarmScheduled = true;
    }
  } catch {
    // A later content-script message or browser lifecycle wake still retries.
  }
}

function clearRetryIfIdle() {
  if (retryWanted()) return;
  try {
    if (chrome.alarms && typeof chrome.alarms.clear === 'function') void chrome.alarms.clear(RETRY_ALARM);
    retryAlarmScheduled = false;
  } catch {
    // No alarms API in narrow test harnesses.
  }
}

function acceptedInstance(body, allowBinding = false) {
  const hasInstanceId = body && Object.prototype.hasOwnProperty.call(body, 'instanceId');
  const remoteInstanceId = hasInstanceId && typeof body.instanceId === 'string' && INSTANCE_ID_PATTERN.test(body.instanceId)
    ? body.instanceId
    : null;
  if (hasInstanceId && !remoteInstanceId) {
    instanceBindingError = 'invalid_instance_identity';
    return null;
  }
  if (instanceId && remoteInstanceId !== instanceId) {
    instanceBindingError = 'instance_mismatch';
    return null;
  }
  if (!instanceId && remoteInstanceId && !allowBinding && !token) {
    instanceBindingError = 'instance_binding_required';
    return null;
  }
  instanceBindingError = null;
  return { remoteInstanceId, learnedInstanceId: instanceId ? null : remoteInstanceId };
}

async function hello(candidate, allowBinding = false) {
  try {
    const response = await fetchBounded(`http://127.0.0.1:${candidate}/hello`, {
      cache: 'no-store',
      headers: versionHeaders()
    }, HELLO_TIMEOUT_MS);
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || body.app !== 'chat-on-steroids') return null;
    const accepted = acceptedInstance(body, allowBinding);
    return accepted ? { body, ...accepted } : null;
  } catch {
    return null;
  }
}

async function localAccountChoices(force = false) {
  if (!force && nearbyInstances && Date.now() - nearbyInstancesAt < 30_000) return nearbyInstances;
  if (nearbyInstancesFlight) return nearbyInstancesFlight;
  const flight = Promise.all(PORTS.map(async (candidate) => {
    try {
      const response = await fetchBounded(`http://127.0.0.1:${candidate}/hello`, {
        cache: 'no-store', headers: versionHeaders()
      }, HELLO_TIMEOUT_MS);
      if (!response.ok) return null;
      const body = await response.json();
      if (body?.app !== 'chat-on-steroids' || typeof body.instanceId !== 'string' ||
          !INSTANCE_ID_PATTERN.test(body.instanceId)) return null;
      return {
        instanceId: body.instanceId,
        port: candidate,
        legacy: body.legacyInstance === true,
        name: typeof body.displayName === 'string' && body.displayName.trim()
          ? body.displayName.trim().slice(0, 120) : body.legacyInstance === true ? 'Main account' : `COS account ${candidate}`,
        compatible: body.compatible !== false && body.bridge === BRIDGE_PROTOCOL
      };
    } catch { return null; }
  })).then((rows) => {
    const seen = new Set();
    nearbyInstances = rows.filter((row) => {
      if (!row || seen.has(row.instanceId)) return false;
      seen.add(row.instanceId);
      return true;
    });
    nearbyInstancesAt = Date.now();
    return nearbyInstances;
  }).finally(() => { nearbyInstancesFlight = null; });
  nearbyInstancesFlight = flight;
  return flight;
}

let browserId = '';

/** Lets the app say plainly when the two halves are out of step. */
function versionHeaders() {
  let version = '0';
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    // Not worth failing a request over.
  }
  return {
    'x-extension-version': version,
    'x-extension-protocol': String(BRIDGE_PROTOCOL),
    ...(browserId ? { 'x-extension-browser': browserId } : {})
  };
}

/**
 * Finds the app, preferring the port that worked last time.
 *
 * A recent confirmation is believed rather than re-checked. The alternative was a
 * `/hello` in front of every authenticated request, which doubled the traffic of a poll
 * that already runs every two seconds in every open tab. Nothing is lost by it: a request
 * to a port the app has left fails, and a failure re-checks immediately.
 */
async function discover(force = false, allowBinding = false) {
  await load();
  if (instanceBindingError === 'invalid_instance_binding') return null;
  instanceBindingError = null;
  // A fresh Chrome profile must never silently attach to the first (legacy) bridge when
  // The primary account and an isolated account are both running. The popup offers an explicit choice.
  if (!instanceId && port === null && !token) {
    const choices = await localAccountChoices();
    if (choices.length > 1) {
      instanceBindingError = 'instance_selection_required';
      return null;
    }
    if (choices.length === 1 && !allowBinding) {
      instanceBindingError = 'instance_binding_required';
      return null;
    }
  }
  if (port !== null && !force) {
    if (Date.now() - portCheckedAt < PORT_TRUST_MS) return { port, paired: token !== null, compatible: portCompatible !== false, version: appVersion, bridge: appProtocol };
    const found = await hello(port, allowBinding);
    if (found) {
      if (found.learnedInstanceId) instanceId = found.learnedInstanceId;
      const body = found.body;
      if (body.disconnected === true) await latchAppDisconnect();
      portCheckedAt = Date.now();
      portCompatible = body.compatible !== false && body.bridge === BRIDGE_PROTOCOL;
      appVersion = typeof body.version === 'string' ? body.version : null;
      appProtocol = Number.isFinite(Number(body.bridge)) ? Number(body.bridge) : null;
      await persist();
      return { port, paired: body.paired === true, compatible: portCompatible, version: appVersion, bridge: appProtocol, instanceId };
    }
  }
  for (const candidate of PORTS) {
    const found = await hello(candidate, allowBinding);
    if (found) {
      if (found.learnedInstanceId) instanceId = found.learnedInstanceId;
      const body = found.body;
      if (body.disconnected === true) await latchAppDisconnect();
      port = candidate;
      portCheckedAt = Date.now();
      portCompatible = body.compatible !== false && body.bridge === BRIDGE_PROTOCOL;
      appVersion = typeof body.version === 'string' ? body.version : null;
      appProtocol = Number.isFinite(Number(body.bridge)) ? Number(body.bridge) : null;
      await persist();
      return { port: candidate, paired: body.paired === true, compatible: portCompatible, version: appVersion, bridge: appProtocol, instanceId };
    }
  }
  port = null;
  portCheckedAt = 0;
  portCompatible = null;
  appVersion = null;
  appProtocol = null;
  await persist();
  return null;
}

/** Forgets that the app was ever confirmed, so the next call really looks. */
function forgetPort() {
  portCheckedAt = 0;
  portCompatible = null;
}

/**
 * Mirrors an explicit app-side Disconnect into this browser's own durable latch.
 *
 * `false` from the app is deliberately not authoritative here: this browser may itself have
 * been disconnected from the popup, and merely observing an app that is willing to pair is
 * not user intent to reconnect. Only an explicit successful pair clears the local latch.
 */
async function latchAppDisconnect(connection = null) {
  // An app-authenticated wake connection can carry an explicit Disconnect. Keep only that
  // exact socket alive long enough to persist the browser-side latch and acknowledge it;
  // every HTTP/error path still closes immediately before changing credentials.
  if (!connection || wakeSocket !== connection) closeWakeSocket();
  token = null;
  disconnected = true;
  await persist();
  if (connection && wakeSocket === connection) {
    try { if (connection.readyState === 1) connection.send('disconnected'); }
    finally { closeWakeSocket(); }
  }
}

/** Negative admission only; this grants no account, document or Send authority. */
function conversationAdmission(source, conversationId = null) {
  const epoch = connectionEpoch;
  const generation = unassignedHistoryGeneration;
  return (identity = conversationId) => connectionEpoch === epoch && unassignedHistoryGeneration === generation &&
    !unassignedHistoryUncertain && (!source || ownsDocument(source)) && !unassignedHistoryConversation(identity);
}

function conversationAdmissionRefusal(source) {
  return { ok: false, status: 409, error: source && !ownsDocument(source) ? 'stale_document' : 'account_history_unassigned', durable: false };
}

/** Only established request contracts carry a named conversation. Global requests stay global. */
function conversationRequestIdentity(path, init) {
  const endpoint = String(path).split('?')[0];
  if (endpoint === '/activity') {
    try { return cleanConversationId(new URL(path, 'http://127.0.0.1').searchParams.get('conversationId')); }
    catch { return null; }
  }
  if (!['/browser-debug', '/conversation/deleted', '/compact', '/correlations', '/goal/draft', '/goal/ack', '/goal/objective',
    '/settings', '/input/bind', '/input/attachment', '/input/stage', '/input/progress', '/input/answer',
    '/input/fail', '/input/ack', '/input/claim', '/commands/redeem', '/commands/ack', '/closed'].includes(endpoint) ||
    typeof init.body !== 'string') return null;
  try {
    const body = JSON.parse(init.body);
    return body && typeof body === 'object' && !Array.isArray(body) ? cleanConversationId(body.conversationId) : null;
  } catch { return null; }
}

/** One authenticated request. Returns { ok, status, data } and never throws. */
async function call(path, init = {}, retried = false, acceptance = null) {
  const identity = conversationRequestIdentity(path, init);
  const scoped = identity ? conversationAdmission(null, identity) : null;
  const accepted = () => {
    if (scoped && !scoped()) return false;
    if (acceptance === null) return true;
    try { return typeof acceptance === 'function' && acceptance() === true; }
    catch { return false; }
  };
  const staleOwner = () => ({ ok: false, status: 409, error: identity && (unassignedHistoryUncertain || unassignedHistoryConversation(identity)) ? 'account_history_unassigned' : 'request_owner_changed' });
  await load();
  if (!accepted()) return staleOwner();
  const found = await discover();
  if (!accepted()) return staleOwner();
  if (!found) return { ok: false, status: 0, error: 'app_not_found' };
  if (found.compatible === false) return { ok: false, status: 426, error: 'incompatible_extension' };
  if (!token) {
    // Somebody disconnected this browser on purpose. Quietly getting a new token here is
    // how "Disconnect" came to mean "disconnect until the next poll".
    if (disconnected) return { ok: false, status: 401, error: 'disconnected' };
    // First use. Ask the app for a token instead of asking the user for one — see
    // provision() for why that is not a downgrade.
    const got = await provision();
    if (!accepted()) return staleOwner();
    if (!got.ok) return { ok: false, status: 401, error: got.error || 'not_paired' };
  }
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = init;
  try {
    if (!accepted()) return staleOwner();
    const policyOwner = { epoch: connectionEpoch, instanceId, port, token, browserId };
    const response = await fetchBounded(
      `http://127.0.0.1:${found.port}${path}`,
      {
        ...rest,
        cache: 'no-store',
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...versionHeaders(),
          authorization: `Bearer ${token}`
        }
      },
      timeoutMs
    );
    const data = await response.json().catch(() => ({}));
    if (!accepted()) return staleOwner();
    // Negative observations only: a later positive reply never restores this repair flight.
    // Fresh Main inspection still supplies all positive preclaim authority.
    if (policyOwner.epoch === connectionEpoch && policyOwner.instanceId === instanceId &&
        policyOwner.port === port && policyOwner.token === token && policyOwner.browserId === browserId &&
        (!response.ok || data?.automationPaused === true || data?.ui?.automationPaused === true)) {
      for (const repair of desktopInputReceiverRepairs.values()) repair.preclaimPolicyHeld = true;
    }
    if (response.status === 401) {
      if (data && data.error === 'browser_disconnected') {
        await latchAppDisconnect();
        return { ok: false, status: 401, error: 'disconnected', data };
      }
      // Our token no longer matches the app's — it was reset, or the app's storage was
      // rebuilt. Drop ours and provision a new one once, rather than retrying forever
      // with a credential that will never work again or making the user do it by hand.
      token = null;
      await persist();
      if (retried) return { ok: false, status: 401, error: 'not_paired' };
      return call(path, init, true, accepted);
    }
    // Any authenticated HTTP success proves the bridge is back. Reattach its wake
    // channel here, rather than making queued work wait for the 30-second alarm
    // to reach maintain(). The server sends current work immediately on auth.
    if (response.ok) {
      try { connectWakeSocket(); } catch { /* Wake availability cannot invalidate an HTTP delivery receipt. */ }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    if (!accepted()) return staleOwner();
    const detail = String(err && err.message ? err.message : err);
    // A deadline disproves nothing about where the app is. It answered on this port, and the
    // request simply outlived the wait — so keep the port, and say so in a way the caller can
    // act on. Dropping it here made every slow answer cost a rediscovery as well.
    if (detail === TIMED_OUT) return { ok: false, status: 0, error: detail, retryable: true };
    // Anything else never reached anything, so the belief that the app is on this port is
    // exactly what has just been disproved. Next call looks properly.
    forgetPort();
    return { ok: false, status: 0, error: detail };
  }
}

/**
 * Gets this browser a bearer token, with nothing for the user to type.
 *
 * There used to be a six-digit code shown in the app and entered in the extension popup.
 * It bought nothing: the only callers that can reach the app at all are already on this
 * machine's loopback interface — the app refuses any web origin outright — so the code
 * was asking the user to prove something the network had already proved. What it did cost
 * was the first-run path, which failed until somebody found the popup.
 *
 * The token itself stays: it is what keeps a second local program from driving the bridge
 * by accident, and it is why the marker in a chat URL is harmless on its own.
 */
function provision(reconnect = false) {
  // Singleflight. Everything that wants a token waits on the same request. Current
  // apps honor automatic reuse across browser profiles; older apps rotate on every
  // /pair, so concurrent requests there would immediately revoke one another.
  // A pairing from an *older* connection intent is deliberately not shared: Disconnect may
  // have happened while it was in flight, and a later explicit Connect must be able to mint
  // under the new intent without waiting for/accepting that stale result.
  const intent = connectionEpoch;
  if (pairing && pairingEpoch === intent && pairingReconnect === reconnect) return pairing;
  const work = pairOnce(intent, reconnect).then((result) => {
    // A slow result belongs only to its original connection intent. A newer account
    // selection or Disconnect owns both its credentials and its displayed diagnosis.
    if (intent === connectionEpoch) {
      pairingError = result && result.ok
        ? null
        : {
            error: result && result.error ? String(result.error) : 'pair_failed',
            message: result && result.message ? String(result.message) : ''
          };
    }
    return result;
  });
  const tracked = work.finally(() => {
    if (pairing === tracked) {
      pairing = null;
      pairingEpoch = -1;
      pairingReconnect = false;
    }
  });
  pairing = tracked;
  pairingEpoch = intent;
  pairingReconnect = reconnect;
  return tracked;
}

async function pairOnce(intent = connectionEpoch, reconnect = false) {
  // Only the popup's explicit Connect/Retry path may establish a fresh profile binding,
  // including the main account. Background discovery cannot choose an account for the user.
  const found = await discover(true, reconnect);
  // Discovery awaits network /hello. A newer popup selection or Disconnect can supersede
  // the requester before the reply arrives; stale discovery must never mint a token.
  // Explicit popup Connect/Retry is permitted to clear a prior disconnect; a later
  // Disconnect or newer popup intent is never permitted to revive this older request.
  if (intent !== connectionEpoch || (disconnected && !reconnect))
    return { ok: false, error: 'connection_intent_superseded' };
  if (!found) return { ok: false, error: 'app_not_found' };
  if (found.compatible === false) return { ok: false, error: 'incompatible_extension' };
  try {
    const response = await fetchBounded(`http://127.0.0.1:${found.port}/pair`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...versionHeaders(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ ...(reconnect ? { reconnect: true } : { reuse: true }), ...(instanceId ? { instanceId } : {}) })
    });
    const data = await response.json().catch(() => ({}));
    if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
    if (!response.ok || typeof data.token !== 'string') {
      if (data && data.error === 'browser_disconnected') {
        await latchAppDisconnect();
        return { ok: false, error: 'disconnected', message: data.message };
      }
      return { ok: false, error: data.error || `HTTP ${response.status}`, message: data.message };
    }
    const responseInstanceId = typeof data.instanceId === 'string' && INSTANCE_ID_PATTERN.test(data.instanceId)
      ? data.instanceId
      : null;
    if ((instanceId && responseInstanceId !== instanceId) ||
        (Object.prototype.hasOwnProperty.call(data, 'instanceId') && !responseInstanceId)) {
      instanceBindingError = 'instance_mismatch';
      return { ok: false, error: 'instance_mismatch', message: 'The app answered for a different or malformed instance. Select the matching browser profile and re-pair explicitly.' };
    }
    const previousBinding = instanceId;
    const next = { instanceId: instanceId || responseInstanceId, port: found.port,
      token: data.token, disconnected: false };
    // A received token is not a saved pairing. Publish credentials only after the exact
    // connection intent survives its serialized durable write and its final epoch check.
    const accept = () => intent === connectionEpoch && instanceId === previousBinding;
    let committed;
    try {
      committed = await persist(next, () => {
        if (!accept()) return false;
        ({ instanceId, port, token, disconnected } = next);
        return true;
      }, accept);
    } catch {
      if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
      token = null;
      disconnected = true;
      try { await persist(); }
      catch { return { ok: false, error: 'account_pairing_uncertain',
        message: 'Chrome could not finalize or hold the saved pairing. The browser is disconnected in this run; check companion storage before restarting or retrying.' }; }
      if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
      return { ok: false, error: 'account_pairing_save_failed',
        message: 'Chrome could not save the companion pairing. The browser remains disconnected; check companion storage and explicitly retry.' };
    }
    if (!committed) {
      try { await persist(); }
      catch { return { ok: false, error: 'account_pairing_uncertain',
        message: 'Chrome could not reconcile a cancelled pairing. Check companion storage and confirm the current account before restarting or retrying.' }; }
      return { ok: false, error: 'connection_intent_superseded' };
    }
    if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
    scheduleRetry();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// -------------------------------------------------------------------- commands

/**
 * Fetches the one command a marked page was opened for.
 *
 * Redeeming by id is what replaced the single global "pending bootstrap" slot. That slot
 * was consumed by whichever fresh tab asked first, so a tab that came up before the slot
 * was filled got nothing and never asked again, while a later unrelated tab could take a
 * bootstrap meant for something else. An id in the URL cannot be taken by the wrong page,
 * survives the tab being reloaded, and can be asked for as many times as it takes.
 *
 * The app answers 404 for a command that has been cancelled, superseded, or already
 * sent, so a stale marker types nothing.
 */
async function redeemCommand(id, client, conversationId = null, projectEntry = false, tabLease = null, acceptance = null) {
  const currentAdmission = () => acceptance === null || acceptance() === true;
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  await load();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  if (!id || settled.includes(id)) return { ok: true, command: null, gone: true };
  const body = { id, client };
  if (typeof tabLease === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(tabLease)) body.tabLease = tabLease;
  if (projectEntry === true) body.projectEntry = true;
  if (typeof conversationId === 'string' && conversationId) body.conversationId = conversationId;
  const result = await call('/commands/redeem', { method: 'POST', body: JSON.stringify(body) }, false, currentAdmission);
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  if (result.error === 'account_history_unassigned' || result.error === 'request_owner_changed') return result;
  if (result.status === 404) return { ok: true, command: null, gone: true };
  // Another page already owns this command. Not an error to report: this page simply is not
  // the one the app is talking to, and it must type nothing.
  if (result.status === 409) return { ok: true, command: null, gone: true };
  if (!result.ok) return { ok: false, error: result.error || `HTTP ${result.status}` };
  const command = result.data && result.data.command ? result.data.command : null;
  return { ok: true, command };
}

function commandAckPayload(id, status, error, conversationId, agent, client, turnId) {
  return {
    id,
    status,
    error: error || undefined,
    conversationId: conversationId || undefined,
    agent: agent || undefined,
    client: client || undefined,
    ...(typeof turnId === 'string' && turnId.length <= 256 ? { turnId } : {})
  };
}

/**
 * Retries command ACKs independently of command redemption or page lifetime.
 *
 * 404/409 are terminal ownership answers from the current bridge contract: the command no
 * longer exists or another document owns it, so replaying the same result can never apply it.
 * Transport failures, throttling, auth repair and 426 incompatibility remain queued. A later
 * compatible app/extension pair can therefore finish an ACK that was already durable here.
 */
async function drainCommandAcks(targetId = null) {
  await load();
  if (ackingCommands || commandAckOutbox.length === 0 || !token) {
    return { ok: true, pending: commandAckOutbox.length, queued: commandAckOutbox.length > 0 };
  }
  ackingCommands = true;
  let targetResult = null;
  let changed = false;
  const blockedConversations = new Set();
  try {
    for (const entry of [...commandAckOutbox]) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) {
        commandAckOutbox = commandAckOutbox.filter((candidate) => candidate !== entry);
        changed = true;
        continue;
      }
      // Receipt order is causal within one conversation, not across unrelated chats. A broken
      // chat must not head-of-line block every later worker/input receipt in the browser. Keep
      // later receipts for the same conversation behind the first retryable failure while letting
      // independent conversations use this same bounded drain pass.
      if (entry.conversationId && blockedConversations.has(entry.conversationId)) continue;
      const inputReceipt = entry.kind === 'input';
      const inputUnsent = entry.kind === 'input-unsent';
      const payload = inputReceipt
        ? { id: entry.id, owner: entry.owner, conversationId: entry.conversationId, messageId: entry.messageId }
        : inputUnsent
          ? { id: entry.id, owner: entry.owner, conversationId: entry.conversationId,
              confirmedUnsent: true,
              error: entry.error === 'After-turn pickup was withdrawn before Send.'
                ? entry.error : 'Native Send was not attempted.',
              ...(entry.error === 'After-turn pickup was withdrawn before Send.' &&
                typeof entry.detail === 'string' && /^[a-z-]{1,40}$/.test(entry.detail)
                ? { detail: entry.detail } : {}) }
          : commandAckPayload(
        entry.id,
        entry.status === 'attention' ? 'attention' : entry.status === 'deferred' ? 'deferred' : entry.status === 'failed' ? 'failed' : 'sent',
        entry.error,
        entry.conversationId,
        entry.agent,
        entry.client,
        entry.turnId
      );
      const result = await call(inputReceipt ? '/input/ack' : inputUnsent ? '/input/fail' : '/commands/ack', {
        method: 'POST', body: JSON.stringify(payload)
      });
      if (entry.id === targetId) targetResult = result;
      if (result.error === 'account_history_unassigned' || result.error === 'request_owner_changed') {
        if (entry.conversationId) { blockedConversations.add(entry.conversationId); continue; }
        break;
      }

      if (result.ok || result.status === 404 || result.status === 409) {
        if (!inputReceipt && !inputUnsent && result.ok && ['terminal-failure', 'deferred'].includes(result.data?.outcome) &&
            ['failed', 'deferred'].includes(payload.status) && !payload.conversationId && entry.source) {
          await retireFailedCommandTab(entry);
        }
        commandAckOutbox = commandAckOutbox.filter((candidate) => candidate !== entry);
        changed = true;
        if (!inputReceipt && !inputUnsent && result.ok && result.data?.committed !== false && payload.status === 'sent' && !payload.agent) {
          // The app is authoritative. Settling before its ACK made a transient rejection
          // blacklist a valid superseding resume command for the rest of the browser session.
          settled = [...new Set([...settled, payload.id])].slice(-40);
        }
        continue;
      }

      // A normalized current payload should not get a permanent 4xx other than the ownership
      // answers above. Do not spin forever if the bridge explicitly rejects one, but preserve
      // the statuses that can become valid after auth/version/backoff recovery.
      if (result.status >= 400 && result.status < 500 && ![401, 408, 426, 429].includes(result.status)) {
        commandAckOutbox = commandAckOutbox.filter((candidate) => candidate !== entry);
        changed = true;
        continue;
      }
      scheduleRetry();
      if (entry.conversationId) {
        blockedConversations.add(entry.conversationId);
        continue;
      }
      // An id-less fresh-chat receipt has not earned a conversation partition yet. Preserve the
      // old conservative global fence until its exact tab/document later binds it.
      break;
    }
    if (changed) await persistLive();
    if (commandAckOutbox.length > 0) scheduleRetry();
    else clearRetryIfIdle();
    if (targetResult) return { ...targetResult, pending: commandAckOutbox.length };
    return { ok: true, pending: commandAckOutbox.length, queued: commandAckOutbox.length > 0 };
  } finally {
    ackingCommands = false;
  }
}

async function ackCommand(id, status, error, conversationId, agent, client, source = null, turnId, acceptance = null) {
  const currentAdmission = () => acceptance === null || acceptance() === true;
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  await load();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  if (!id) return { ok: false, status: 400, error: 'bad_command_id' };
  const payload = commandAckPayload(id, status, error, conversationId, agent, client, turnId);
  const queued = {
    ...payload,
    provisional: payload.conversationId ? null : tabKey(source),
    ...(['failed', 'deferred'].includes(status) && !payload.conversationId && ownsDocument(source) ? { source: { tab: source.tab, documentId: source.documentId, navigationEpoch: source.navigationEpoch } } : {}),
    queuedAt: Date.now()
  };
  // One command has one exact page result. Replace an earlier replay copy rather than
  // allowing duplicate storage entries to race each other after a worker restart.
  const retained = commandAckOutbox.filter((entry) => entry &&
    (entry.kind === 'input' || entry.kind === 'input-unsent' || entry.id !== id));
  if (retained.length >= 200) return { ok: false, error: 'receipt_journal_full' };
  commandAckOutbox = [...retained, queued];
  // Durability is established before any network attempt. If storage itself fails the message
  // handler rejects and the page is told truthfully that this worker did not take custody.
  await persistLive();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  scheduleRetry();
  return drainCommandAcks(id);
}

/** Terminal failure owns this exact pre-send document, even though no conversation
 * was created. Reuse the ACK journal's durable custody and ordinary close proof. */
async function retireFailedCommandTab(entry) {
  const source = entry.source;
  if (!ownsDocument(source)) return;
  try {
    const tab = await chrome.tabs.get(source.tab);
    if (!tab || tab.pinned || tab.pendingUrl || !ownsDocument(source)) return;
    const conversation = conversationFromUrl(tab.url) || null;
    const marked = new URL(tab.url);
    if (conversation && !(marked.searchParams.get('clf') === entry.id && marked.searchParams.get('clf_project') === '1')) return;
    const url = tab.url;
    const proof = await tabReply(source.tab, { type: 'clf-tab-close-check', conversationId: conversation,
      failedCommand: { id: entry.id, client: entry.client } }, { documentId: source.documentId });
    const latest = await chrome.tabs.get(source.tab);
    if (proof?.safe === true && proof.conversationId === conversation && proof.navigationEpoch === source.navigationEpoch &&
        latest && !latest.pinned && !latest.pendingUrl && latest.url === url && ownsDocument(source)) await retireAutomaticTab(source.tab);
  } catch { /* A busy, edited, replaced or unreadable page stays open. */ }
}

/** A proven browser send hands only its receipt to the existing durable ACK journal.
 * Replays never read the current tab or send text: the captured owner and conversation
 * remain authoritative after navigation, MV3 suspension and browser/app restart. */
async function ackDesktopInput(id, owner, conversationId, messageId, acceptance = null) {
  const currentAdmission = () => acceptance === null || acceptance() === true;
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  await load();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  if (!conversationId || (messageId !== undefined &&
      (typeof messageId !== 'string' || !messageId || messageId.length > 256))) {
    return { ok: false, error: 'missing_send_receipt' };
  }
  if (commandAckOutbox.some(entry => entry.kind === 'input-unsent' && entry.id === id)) return { ok: false, error: 'conflicting_send_receipt' };
  const previous = commandAckOutbox.find(entry => entry.kind === 'input' && entry.id === id);
  if (previous && (previous.owner !== owner || previous.conversationId !== conversationId ||
      (previous.messageId && messageId && previous.messageId !== messageId))) {
    return { ok: false, error: 'conflicting_send_receipt' };
  }
  if (!previous) {
    if (commandAckOutbox.length >= 200) return { ok: false, error: 'receipt_journal_full' };
    commandAckOutbox.push({ kind: 'input', id, owner, conversationId,
      ...(messageId ? { messageId } : {}), queuedAt: Date.now() });
  } else if (!previous.messageId && messageId) {
    previous.messageId = messageId;
  }
  // Keep the pending digest until the native user id arrives. A route alone cannot prove that
  // this authorization crossed native Send, especially after the owning document is replaced.
  if (messageId && pendingInputReceipts[id]) delete pendingInputReceipts[id];
  await persistLive();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  scheduleRetry();
  const result = await drainCommandAcks(id);
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  if (result.ok && result.data?.ok === false) return result;
  if (!result.ok && !commandAckOutbox.some(entry => entry.kind === 'input' && entry.id === id)) return result;
  // Custody, not a network response, is the page's completion boundary.
  return { ok: true, data: { ok: true }, queued: commandAckOutbox.some(entry => entry.kind === 'input' && entry.id === id) };
}

/** Positive page proof that this exact authorization never crossed native Send.
 *
 * Keep it in the existing bounded receipt journal before talking to Main. A response can vanish
 * after Main re-arms the row, or Main can be down entirely; replaying this proof is idempotent and
 * contains no message text. It therefore survives both MV3 and app-process reconstruction without
 * turning an ambiguous post-click delivery into resend authority. */
async function releaseDesktopInputBeforeSend(id, owner, conversationId, error, detail, acceptance = null) {
  const currentAdmission = () => acceptance === null || acceptance() === true;
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  await load();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  if (commandAckOutbox.some(entry => entry.kind === 'input' && entry.id === id)) return { ok: false, error: 'conflicting_send_receipt' };
  const recoveryError = error === 'After-turn pickup was withdrawn before Send.'
    ? error : 'Native Send was not attempted.';
  const recoveryDetail = recoveryError === 'After-turn pickup was withdrawn before Send.' &&
    typeof detail === 'string' && /^[a-z-]{1,40}$/.test(detail) ? detail : undefined;
  const previous = commandAckOutbox.find(entry => entry.kind === 'input-unsent' && entry.id === id);
  if (previous && (previous.owner !== owner || previous.conversationId !== conversationId ||
      (previous.error ?? 'Native Send was not attempted.') !== recoveryError ||
      (previous.detail ?? undefined) !== recoveryDetail)) return { ok: false, error: 'conflicting_send_receipt' };
  if (!previous) {
    if (commandAckOutbox.length >= 200) return { ok: false, error: 'receipt_journal_full' };
    commandAckOutbox.push({ kind: 'input-unsent', id, owner, conversationId,
      error: recoveryError, ...(recoveryDetail ? { detail: recoveryDetail } : {}), queuedAt: Date.now() });
  }
  if (pendingInputReceipts[id]) delete pendingInputReceipts[id];
  await persistLive();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  scheduleRetry();
  const result = await drainCommandAcks(id);
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  if (!result.ok && !commandAckOutbox.some(entry => entry.kind === 'input-unsent' && entry.id === id)) return result;
  return { ok: true, data: { ok: true }, queued: commandAckOutbox.some(entry => entry.kind === 'input-unsent' && entry.id === id) };
}

/**
 * Bounded app command identity, shared by every marker this worker handles.
 *
 * Inert on its own: a command id names a row in the app's queue and proves nothing. Redeeming
 * it still requires the pairing bearer token, which is why a marker may travel in a URL.
 */
function commandMarkerId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 128 ? id : null;
}

/**
 * Closes only the exact empty root document whose marked app command was just proven gone.
 *
 * A copied marker is inert, but a normal ChatGPT home tab is personal UI and may never be swept
 * merely because it is blank. The preceding redeem tombstone, exact document/epoch, unchanged
 * URL, empty composer proof and pin check together distinguish the abandoned app opener.
 */
async function retireStaleCommandTab(id, source) {
  const refuse = (reason) => {
    console.info('[Chat On Steroids] kept stale marked command tab', source?.tab, id, reason);
    return false;
  };
  const remembered = staleCommandDocuments.get(source?.tab);
  staleCommandDocuments.delete(source?.tab);
  if (!remembered || remembered.id !== id || remembered.documentId !== source?.documentId ||
      remembered.navigationEpoch !== source?.navigationEpoch || Date.now() - remembered.at > 60_000 || !ownsDocument(source)) return refuse('stale cleanup authority');
  try {
    const tab = await chrome.tabs.get(source.tab);
    if (!tab || tab.pinned || tab.pendingUrl || conversationFromUrl(tab.url) || !ownsDocument(source)) return refuse('tab is pinned, navigating, or no longer empty');
    const url = new URL(tab.url || '');
    const hashMarker = new URL(`https://chatgpt.com/?${url.hash.startsWith('#') ? url.hash.slice(1) : url.hash}`).searchParams.get('clf');
    if ((url.origin !== 'https://chatgpt.com' && url.origin !== 'https://chat.openai.com') || url.pathname !== '/' ||
        (url.searchParams.get('clf') !== id && hashMarker !== id)) return refuse('URL marker changed');
    const originalUrl = tab.url;
    const proof = await tabReply(source.tab, { type: 'clf-tab-close-check', conversationId: null }, { documentId: source.documentId });
    const latest = await chrome.tabs.get(source.tab).catch(() => null);
    if (proof?.safe !== true || proof.conversationId !== null || proof.navigationEpoch !== source.navigationEpoch ||
        !ownsDocument(source) || !latest || latest.pinned || latest.pendingUrl || latest.url !== originalUrl) return refuse('page did not prove an unchanged empty composer');
    if (!await retireAutomaticTab(source.tab)) return refuse('last Chrome tab retained');
    console.info('[Chat On Steroids] closed stale marked command tab', source.tab, id);
    return true;
  } catch (error) {
    return refuse(`tab could not be inspected: ${error && error.message ? error.message : String(error)}`);
  }
}

/**
 * Requested ChatGPT model slug for a worker's fresh chat, or null for the account default.
 *
 * Same vocabulary the app enforces: anything shaped like a slug passes through to the open
 * URL, anything else is dropped here rather than typed into a URL. An unknown slug is
 * ChatGPT's to ignore — the chat then opens with the default.
 */
function commandModelSlug(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  return model && /^[A-Za-z0-9._-]{1,80}$/.test(model) ? model : null;
}

/**
 * Requested reasoning level for a worker's fresh chat, or null to inherit.
 *
 * Canonical vocabulary; the app's broker is the authority and this mirrors its list.
 * Anything outside it is dropped here rather than typed into a URL. Forwarded
 * independently of model: a level never selects or changes the model.
 */
const COMMAND_REASONING_EFFORTS = ['pro', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function commandReasoningEffort(value) {
  const effort = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return effort && COMMAND_REASONING_EFFORTS.includes(effort) ? effort : null;
}

function deferredRevivalId(value) {
  return commandMarkerId(value);
}

function pruneDeferredRevivalOffers() {
  const retainedIds = new Set(deferredRevivals.map((entry) => deferredRevivalId(entry?.id)).filter(Boolean));
  for (const offeredId of [...deferredRevivalOffers.keys()]) {
    if (!retainedIds.has(offeredId)) deferredRevivalOffers.delete(offeredId);
  }
}

async function rememberDeferredRevival(idValue, conversationValue, openingSpent = false, acceptance = null) {
  const currentAdmission = () => acceptance === null || acceptance() === true;
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  await load();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  const id = deferredRevivalId(idValue);
  const conversationId = cleanConversationId(conversationValue);
  if (!id || !conversationId) return false;
  const existing = deferredRevivals.find((entry) => entry?.id === id && cleanConversationId(entry.conversationId) === conversationId);
  if (existing) {
    if (openingSpent) existing.openingSpent = true;
    await persistLive();
    if (!currentAdmission()) return conversationAdmissionRefusal(null);
    return true;
  }
  // There can only be one not-yet-redeemed wake for one existing conversation. Seeing a newer
  // marker for the same chat is app-side proof that an older extension-only recovery marker is
  // obsolete. Keeping both is worse than redundant: recoverDeferredRevivals() can put the old
  // marker into the exact document's pre-redeem wait and make the current wake bounce off `busy`.
  const retiredIds = deferredRevivals
    .filter((entry) => entry && entry.id !== id && cleanConversationId(entry.conversationId) === conversationId)
    .map((entry) => deferredRevivalId(entry.id))
    .filter(Boolean);
  for (const retiredId of retiredIds) {
    deferredRevivalOffers.delete(retiredId);
  }
  deferredRevivals = [
    ...deferredRevivals.filter(
      (entry) =>
        entry &&
        entry.id !== id &&
        cleanConversationId(entry.conversationId) !== conversationId
    ),
    { id, conversationId, queuedAt: Date.now(), openingSpent }
  ].slice(-100);
  // The durable revival list is the authority for these process-local offer suppressors. If the
  // 100-row retention cap drops an older marker, drop its offer token in the same operation; a
  // long browser session must not retain one tab-id entry per historical revival forever.
  pruneDeferredRevivalOffers();
  await persistLive();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  return true;
}

async function forgetDeferredRevival(idValue) {
  await load();
  const id = deferredRevivalId(idValue);
  if (!id) return false;
  const before = deferredRevivals.length;
  deferredRevivals = deferredRevivals.filter((entry) => entry && entry.id !== id);
  deferredRevivalOffers.delete(id);
  if (deferredRevivals.length !== before) await persistLive();
  return deferredRevivals.length !== before;
}

/**
 * A stable key for the tab an observation came from.
 *
 * The tab id, not the page: it survives a reload, which is exactly the window where an
 * un-bound observation would otherwise be lost. Falls back to a per-worker constant if
 * Chrome does not name the sender, which only costs precision when several fresh chats
 * are opened at once and never misfiles anything that already has a conversation id.
 */
function tabKey(source) {
  return source && Number.isInteger(source.tab) && source.documentId
    ? `tab-${source.tab}:${source.documentId}`
    : 'tab-unknown';
}

function reloadProvisionalKey(tab) {
  return Number.isInteger(tab) ? `reload-tab-${tab}` : null;
}

async function carryFreshReloadProvisional(tab, documentId) {
  if (!Number.isInteger(tab) || !documentId) return 0;
  const from = `tab-${tab}:${documentId}`;
  const to = reloadProvisionalKey(tab);
  if (!to) return 0;
  let moved = 0;
  for (const entry of journal) {
    if (!entry || entry.conversationId || entry.provisional !== from) continue;
    entry.provisional = to;
    sizeCache.delete(entry);
    moved++;
  }
  let ackMoved = 0;
  for (const entry of commandAckOutbox) {
    if (!entry || entry.conversationId || entry.provisional !== from) continue;
    entry.provisional = to;
    ackMoved++;
  }
  if (moved > 0) await persistJournal();
  if (ackMoved > 0) await persistLive();
  return moved + ackMoved;
}

async function adoptFreshReloadProvisional(tab, documentId) {
  if (!Number.isInteger(tab) || !documentId) return 0;
  const from = reloadProvisionalKey(tab);
  if (!from) return 0;
  const to = `tab-${tab}:${documentId}`;
  let moved = 0;
  for (const entry of journal) {
    if (!entry || entry.conversationId || entry.provisional !== from) continue;
    entry.provisional = to;
    sizeCache.delete(entry);
    moved++;
  }
  let ackMoved = 0;
  for (const entry of commandAckOutbox) {
    if (!entry || entry.conversationId || entry.provisional !== from) continue;
    entry.provisional = to;
    ackMoved++;
  }
  if (moved > 0) await persistJournal();
  if (ackMoved > 0) await persistLive();
  return moved + ackMoved;
}

function tabId(sender) {
  return sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
}

function senderDocument(sender) {
  if (!sender || (sender.frameId !== undefined && sender.frameId !== 0)) return null;
  return typeof sender.documentId === 'string' && sender.documentId.length > 0 ? sender.documentId : null;
}

function messageEpoch(message) {
  const value = Number(message && message.navigationEpoch);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Whether a terminal lease was a wrong prediction about a document that is still running.
 *
 * `markTerminal` is speculative by construction: it fires from `chrome.tabs.onUpdated`
 * the moment Chrome says a navigation is *starting*, and stamps whichever document the tab
 * currently holds. The design then assumed a replacement document would always arrive and
 * clear the stamp. When one does not — an aborted navigation, a redirect that reports a
 * second `loading` after the replacement has already registered, a soft route change, a
 * prerender that never commits — the stamp lands on the tab's own live document, and from
 * then on `authorizeDocument` answers `tab_closed` to every message it sends while
 * `registerDocument` answers `tab_closed` to its attempt to re-register. Nothing in the
 * browser could clear it, so the tab kept reading ChatGPT perfectly and delivered none of
 * it until the user happened to reload. That is the 2026-08-21 blackout: a live tab whose
 * request-id evidence never reached the app, so `agents action=spawn` was refused with
 * UNIDENTIFIED_CALLER while the popup showed the request id it had already read.
 *
 * A message arriving here is itself the disproof. Chrome does not deliver `runtime.sendMessage`
 * from a document that no longer exists, so an inbound message from the tab's *current*
 * document means that document is alive; a tab that really went away fails `tabs.get`, and a
 * document that really was replaced is barred by `retiredDocuments`, which this never touches.
 * Only the speculative half of the lease is given up.
 */
async function terminalPredictionWrong(id, key, documentId) {
  if (!Object.prototype.hasOwnProperty.call(terminalDocuments, key)) return false;
  if (typeof tabDocuments[key] !== 'string' || tabDocuments[key] !== documentId) return false;
  let tab = null;
  try {
    tab = await chrome.tabs.get(id);
  } catch {
    return false;
  }
  if (!tab || !isChatGptUrl(tab.url)) return false;
  // A document can still send extension IPC during the overlap between navigation starting
  // and Chrome replacing that document. In that window tabs.get() may already describe the
  // destination ChatGPT URL, so the message proves only that the old document is *dying*, not
  // that the loading event was a false terminal prediction. Reopen the lease only after
  // Chrome itself says the tab is settled and has no destination still pending.
  if (tab.status === 'loading') return false;
  if (typeof tab.pendingUrl === 'string' && tab.pendingUrl !== '') return false;
  return true;
}

/**
 * Establishes one current browser document per tab from Chrome's MessageSender authority.
 *
 * A body field would be page-controlled and is not accepted. A different document can take
 * over a live tab (reload/update) and retires the old id permanently. A terminal lease still
 * rejects delayed IPC from a dying document and a document that was actually superseded;
 * what it no longer does is outlive the live document it was wrongly stamped on — see
 * `terminalPredictionWrong`.
 */
async function authorizeDocument(sender, message) {
  await load();
  const id = tabId(sender);
  const documentId = senderDocument(sender);
  if (id === null || !documentId) return { ok: false, error: 'document_identity_missing' };
  const key = String(id);
  const retired = Array.isArray(retiredDocuments[key]) ? retiredDocuments[key] : [];
  if (retired.includes(documentId)) return { ok: false, error: 'stale_document' };
  const current = typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null;
  const requestedEpoch = messageEpoch(message);
  const currentEpoch = Number.isSafeInteger(tabEpochs[key]) ? tabEpochs[key] : 0;
  let terminal = Object.prototype.hasOwnProperty.call(terminalDocuments, key);
  if (terminal && (await terminalPredictionWrong(id, key, documentId))) {
    delete terminalDocuments[key];
    terminal = false;
    await persistLive();
  }
  if (terminal) {
    return { ok: false, error: !current || current === documentId ? 'tab_closed' : 'document_unregistered' };
  }
  if (current === documentId && !terminal) {
    if (requestedEpoch < currentEpoch) return { ok: false, error: 'stale_navigation' };
    if (requestedEpoch > currentEpoch) {
      tabEpochs[key] = requestedEpoch;
      await persistLive();
    }
    return { ok: true, tab: id, documentId, navigationEpoch: requestedEpoch };
  }
  if (current && current !== documentId) {
    retiredDocuments[key] = [...new Set([...retired, current])].slice(-8);
  }
  tabDocuments[key] = documentId;
  tabEpochs[key] = requestedEpoch;
  delete terminalDocuments[key];
  await persistLive();
  return { ok: true, tab: id, documentId, navigationEpoch: requestedEpoch };
}

async function registerDocument(sender, message) {
  await load();
  const id = tabId(sender);
  const documentId = senderDocument(sender);
  if (id === null || !documentId) return { ok: false, error: 'document_identity_missing' };
  const key = String(id);
  const retired = Array.isArray(retiredDocuments[key]) ? retiredDocuments[key] : [];
  if (retired.includes(documentId)) return { ok: false, error: 'stale_document' };
  const current = typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null;
  const requestedEpoch = messageEpoch(message);
  const terminal = Object.prototype.hasOwnProperty.call(terminalDocuments, key);
  // Same rule as authorizeDocument, and it matters more here: this is the one message type
  // that bypasses authorization, so it is the only way a live document that was wrongly
  // retired can ever come back. Refusing it on the lease alone is what made the blackout
  // permanent — content.js re-sends `register_document` on every failure and simply got the
  // same `tab_closed` forever.
  if (terminal && current === documentId && !(await terminalPredictionWrong(id, key, documentId))) {
    return { ok: false, error: 'tab_closed' };
  }
  if (current && current !== documentId) await adoptFreshReloadProvisional(id, documentId);
  if (current && current !== documentId) retiredDocuments[key] = [...new Set([...retired, current])].slice(-8);
  tabDocuments[key] = documentId;
  tabEpochs[key] = requestedEpoch;
  delete terminalDocuments[key];
  await persistLive();
  return { ok: true, tab: id, documentId, navigationEpoch: requestedEpoch };
}

function ownsDocument(source) {
  if (!source || !Number.isInteger(source.tab) || !source.documentId) return false;
  const key = String(source.tab);
  return (
    tabDocuments[key] === source.documentId &&
    (!Number.isSafeInteger(source.navigationEpoch) || tabEpochs[key] === source.navigationEpoch) &&
    !Object.prototype.hasOwnProperty.call(terminalDocuments, key) &&
    !(Array.isArray(retiredDocuments[key]) && retiredDocuments[key].includes(source.documentId))
  );
}

async function commandTabLeaseFor(source, acceptance = null) {
  const currentAdmission = () => acceptance === null || acceptance() === true;
  if (!currentAdmission()) return null;
  await load();
  if (!currentAdmission()) return null;
  if (!ownsDocument(source)) return null;
  const key = String(source.tab);
  const existing = commandTabLeases[key];
  if (typeof existing === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(existing)) return existing;
  if (typeof commandLeaseGeneration !== 'string' || !/^[a-f0-9]{32}$/.test(commandLeaseGeneration)) return null;
  const lease = `${commandLeaseGeneration}_${crypto.randomUUID()}`;
  commandTabLeases[key] = lease;
  commandTabLeases = Object.fromEntries(Object.entries(commandTabLeases).slice(-1000));
  await chrome.storage.local.set({ commandTabLeases });
  return currentAdmission() && ownsDocument(source) ? lease : null;
}

async function markTerminal(id) {
  await load();
  const key = String(id);
  const documentId = typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null;
  terminalDocuments[key] = documentId;
  // Do not purge provisional fresh-chat observations here. A full ChatGPT reload is a document
  // boundary too, and onUpdated deliberately calls markTerminal() before it knows whether the
  // replacement document is the same chat. releaseTab() owns the destructive purge because it
  // runs only after the tab actually closes or concretely leaves ChatGPT.
  await persistLive();
  return documentId;
}

function cleanConversationId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[0-9a-f-]{8,64}$/i.test(id) ? id : null;
}

/**
 * The mode a goal was written under, as a body fragment or nothing at all.
 *
 * Two words are legal and everything else is silently absent rather than passed on, because
 * the app pins whatever arrives here as a durable per-chat switch. Absent is a real answer:
 * it means "this page named no mode", which leaves the standing switch deciding exactly as
 * it did before the two buttons existed.
 */
function goalMode(message) {
  const mode = message && typeof message.mode === 'string' ? message.mode : '';
  return mode === 'goal' || mode === 'loop' ? { mode } : {};
}

/** Records a tab's current conversation without writing storage on every poll. */
async function noteTabConversation(source, value) {
  const id = source && Number.isInteger(source.tab) ? source.tab : null;
  const conversationId = cleanConversationId(value);
  if (id === null || !conversationId) return false;
  if (unassignedHistoryUncertain || unassignedHistoryConversation(conversationId)) return false;
  if (!ownsDocument(source)) return false;
  const key = String(id);
  const wasOpening = Object.prototype.hasOwnProperty.call(appOwnedOpeningTabs, key);
  const wasIdleRoot = Object.prototype.hasOwnProperty.call(idleRootTabs, key);
  if (wasOpening) delete appOwnedOpeningTabs[key];
  if (wasIdleRoot) delete idleRootTabs[key];
  if (wasOpening || wasIdleRoot) clearRootRetentionDiagnostic(id);
  if (tabConversations[key] === conversationId) {
    if (wasOpening || wasIdleRoot) await persistLive();
    return false;
  }
  const previous = cleanConversationId(tabConversations[key]);
  tabConversations[key] = conversationId;
  await persistLive();
  scheduleRetry();
  if (!ownsDocument(source)) return false;
  // A same-tab full navigation is not a close until the replacement document proves it is
  // a different conversation. This keeps ordinary reloads alive while still retiring A
  // when the new document eventually binds B.
  if (previous && previous !== conversationId && !conversationStillOpen(previous)) {
    await drain();
    await enqueueClose(previous);
    await drainCloses();
  }
  return true;
}

/**
 * Asks the app whether one of the chats this browser is holding needs putting back together.
 *
 * The app can prove that a chat's local tool calls have stopped being attributable to it —
 * usually that document's own reporting died mid-turn — but it cannot do anything about it:
 * the page it would instruct is the page that stopped listening, and opening the url would
 * make a second tab of a chat that is still on screen. This worker can, because the tab
 * registry here is the authority on which tab that chat is in, so the app hands out the
 * conversation id and nothing else and this decides whether there is a tab to reload.
 *
 * A match reloads, and never more than one tab of a chat exists afterwards: several copies are
 * resolved to the one this registry binds, not left alone. None opens the exact conversation.
 * The scan
 * happens immediately before the action; the content-script registry alone is too stale to
 * prevent duplicates. Only a browser action that actually happened is reported, because only
 * that is worth placing behind the app's per-chat cooldown.
 */
let backgroundWindowFlight = null;
let automaticTabRetireFlight = null;

/**
 * Retires one extension-owned tab without allowing concurrent cleanup paths to close Chrome.
 *
 * Chrome exits normally when its final tab is removed. Several independent maintenance and
 * receipt paths can prove their own page disposable at the same time, so the browser-wide
 * inventory check and removal have to share one serialized owner. A sole remaining tab becomes
 * the reusable warm document; explicit user closes remain outside this automatic safety rail.
 */
function retireAutomaticTab(tabId, finalGuard = null, kind = null, afterPersistenceGuard = null) {
  const flight = (automaticTabRetireFlight || Promise.resolve()).catch(() => undefined).then(async () => {
    if (!Number.isInteger(tabId)) return false;
    if (browserControlsTab(tabId)) return false;
    let tabs;
    let removed = false;
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      // Unknown browser inventory is never permission to risk closing Chrome.
      return false;
    }
    const foundTab = tabs.find(tab => tab?.id === tabId);
    // Snapshot selection/window identity rather than retaining Chrome/test object's mutable
    // reference; a later activation must not rewrite what the first inventory observed.
    const originalTab = foundTab ? { ...foundTab } : null;
    if (!originalTab) return true;
    if (tabs.length <= 1) return false;
    if (browserControlsTab(tabId)) return false;
    if (typeof finalGuard === 'function') {
      try {
        if (await finalGuard() !== true) return false;
      } catch {
        return false;
      }
    }
    if (browserControlsTab(tabId)) return false;
    try {
      // tabs.onRemoved cannot otherwise distinguish an app-authorized superseded/worker/root
      // retirement from Ctrl+W. Publish the cause before Chrome receives remove(), so the main-
      // tab safety net below never resurrects a page policy deliberately released.
      const key = String(tabId);
      const retirement = {
        tab: tabId,
        phase: 'prepared',
        documentId: typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null,
        navigationEpoch: Number.isSafeInteger(tabEpochs[key]) ? tabEpochs[key] : null,
        conversationId: cleanConversationId(tabConversations[key]),
        ...(kind === 'superseded-source'
          ? { kind, receiptId: crypto.randomUUID().replaceAll('-', '') }
          : {})
      };
      automaticTabRetirements[key] = retirement;
      automaticTabRetirements = Object.fromEntries(Object.entries(automaticTabRetirements).slice(-1000));
      // onRemoved may arrive after MV3 suspends this worker, or even before remove() resolves.
      // Persist the exact tab incarnation before asking Chrome to remove it.
      await persistLive();
      // The durable write may wait behind another Chrome storage operation. A browser user
      // can select/pin the tab, the document can navigate, or native Core/browser work can
      // acquire it during that await. Re-observe this physical tab and its unchanged
      // incarnation before the deleted-only final authority check. Ordinary worker/finite
      // claims were consumed inside finalGuard and MUST NOT be consumed again.
      const latest = await chrome.tabs.get(tabId);
      const stillOwned = latest && !latest.pinned && !latest.pendingUrl &&
        latest.url === originalTab.url && latest.windowId === originalTab.windowId &&
        !(latest.active === true && originalTab.active !== true) &&
        !browserControlsTab(tabId) &&
        (typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null) === retirement.documentId &&
        (Number.isSafeInteger(tabEpochs[key]) ? tabEpochs[key] : null) === retirement.navigationEpoch &&
        cleanConversationId(tabConversations[key]) === retirement.conversationId;
      if (!stillOwned) {
        if (automaticTabRetirements[key] === retirement) delete automaticTabRetirements[key];
        await persistLive().catch(() => undefined);
        return false;
      }
      // Undo/new authored work may also arrive during the final tabs.get above. Consume the
      // deleted-only managed claim after ALL persistence/inventory awaits, with a fresh
      // native document proof and Main policy revalidation; no browser await follows it.
      if (typeof afterPersistenceGuard === 'function' && await afterPersistenceGuard() !== true) {
        if (automaticTabRetirements[key] === retirement) delete automaticTabRetirements[key];
        await persistLive().catch(() => undefined);
        return false;
      }
      // No await between issuing Chrome's remove request and marking its in-process
      // authority. A pre-remove persisted intent alone must NEVER classify a later user
      // Ctrl+W as app-authorized after MV3 suspension or an interrupted cleanup.
      retirement.phase = 'issued';
      await chrome.tabs.remove(tabId);
      removed = true;
      if (automaticTabRetirements[key] === retirement) {
        retirement.phase = 'removed';
        await persistLive();
      }
      // Chrome normally emits onRemoved before this promise settles, but browser shutdown and
      // event delivery are separate lifecycles. If onRemoved has not already consumed the exact
      // tab-incarnation receipt, put it in the browser-restart-durable lifecycle outbox now. The
      // later onRemoved path is idempotent and merges the same receipt rather than minting another.
      if (retirement.kind === 'superseded-source' && automaticTabRetirements[key] === retirement) {
        await enqueueClose(retirement.conversationId, true, retirement);
      }
      return true;
    } catch {
      // Before remove resolves, rollback is exact: Chrome rejected the close. Afterwards the tab
      // is already gone, so retain the pre-remove receipt for onRemoved/retry instead of erasing
      // the only remaining evidence or falsely reporting that no browser action happened.
      if (!removed) delete automaticTabRetirements[String(tabId)];
      await persistLive().catch(() => undefined);
      if (removed) scheduleRetry();
      return removed;
    }
  });
  automaticTabRetireFlight = flight;
  return flight.finally(() => {
    if (automaticTabRetireFlight === flight) automaticTabRetireFlight = null;
  });
}
/**
 * Tabs created by this extension that have not yet become named conversations.
 *
 * This is the narrow ownership proof required to clean up a failed helper that ChatGPT has
 * rewritten to its plain home URL. A generic chatgpt.com tab is never enough: it may be the
 * user's own New Chat page. Ownership is dropped permanently as soon as a /c/<id> appears.
 */
let appOwnedOpeningTabs = {};
// Exact app-created empty roots already have stronger provenance than generic New Chat tabs.
// Once no delivery/opening owner protects them, give only a short handoff grace before the same
// fresh empty-page proof is allowed to retire them. Generic/personal roots are never adopted.
const APP_OWNED_ROOT_GRACE_MS = 15 * 1000;
/**
 * Exact empty ChatGPT home documents whose app ownership was transferred from an opening row.
 *
 * URL, elapsed time, an empty composer, or a recorder document never grants ownership. A row enters
 * this store only while relinquishing a positively app-owned opening row. The same document and
 * navigation epoch must remain unchanged for the idle interval, and the content script must still
 * freshly prove that no conversation, draft, attachment, generation, queued delivery or helper
 * operation exists. Active and pinned tabs remain protected by the same final close fences.
 */
let idleRootTabs = {};
// A proved-empty home tab is only a transport shell. Keeping it for a full minute multiplied
// dozens of dead renderers during worker bursts and made the cleanup group look like storage.
// Fifteen seconds still spans ChatGPT's normal SPA handoff while releasing unused pages quickly.
const IDLE_ROOT_CLOSE_MS = 15 * 1000;
// A transient injection failure must not make an otherwise disposable root permanent.
// Retry the existing recorder repair at most once per ten minutes for the same document;
// elapsed time alone never grants permission to close a tab.
const ROOT_RECORDER_REPAIR_RETRY_MS = 10 * 60 * 1000;
// Input openings are durable, but a persisted `tab: null` is only a reservation while Chrome
// creates the page. If MV3 is suspended between those two writes, that reservation must not block
// the same durable input forever. Redirected conversation pages use the same short lease before a
// proved-empty in-place retarget, which avoids both a hot retry loop and spare home-page tabs.
const INPUT_OPENING_LEASE_MS = 15 * 1000;
/**
 * Bounded, content-free explanations for roots that cleanup deliberately retained.
 *
 * These messages are the extension-side equivalent of a decision trace: they contain only a
 * Chrome tab id and one allowlisted reason, never a URL, marker, title, prompt or page text.
 * Repeating maintenance passes log only when the document/reason changes, and the process-local
 * map is capped so diagnostics cannot become another unbounded root registry.
 */
const ROOT_RETENTION_DIAGNOSTIC_LIMIT = 128;
const ROOT_RETENTION_REASONS = new Set([
  'pending app operation',
  'active browser-control lease',
  'cleanup grace period',
  'selected tab',
  'pinned tab',
  'navigation in progress',
  'not an exact empty home',
  'command is still active',
  'command needs exact-page attention',
  'recorder document unavailable; repair requested',
  'recorder document unavailable after repair',
  'recorder repair unavailable',
  'unreadable personal root kept',
  'page reported draft, attachment, generation, queue, or helper work',
  'page composer pending hydration',
  'page composer unavailable or ambiguous',
  'page proof did not match the current document',
  'tab changed during cleanup',
  'Chrome inventory unavailable',
  'last browser tab retained'
]);
const rootRetentionDiagnostics = new Map();

// Only fixed enums from the page can select a diagnostic. Never log arbitrary DOM text;
// this explanation does not authorize closure or override the existing safe/document proof.
function rootCloseProofReason(proof) {
  if (proof?.composer?.host === 'pending-home') return 'page composer pending hydration';
  if (['missing', 'ambiguous', 'unreadable'].includes(proof?.composer?.host)) return 'page composer unavailable or ambiguous';
  return 'page reported draft, attachment, generation, queue, or helper work';
}

function noteRootRetention(tab, source, reason, ownership = 'app-created') {
  if (!Number.isInteger(tab?.id)) return;
  const safeReason = ROOT_RETENTION_REASONS.has(reason) ? reason : 'Chrome inventory unavailable';
  const documentId = typeof source?.documentId === 'string' ? source.documentId : '';
  const epoch = Number.isSafeInteger(source?.navigationEpoch) ? source.navigationEpoch : -1;
  const fingerprint = `${ownership}:${documentId}:${epoch}:${safeReason}`;
  const key = String(tab.id);
  if (rootRetentionDiagnostics.get(key) === fingerprint) return;
  rootRetentionDiagnostics.delete(key);
  rootRetentionDiagnostics.set(key, fingerprint);
  while (rootRetentionDiagnostics.size > ROOT_RETENTION_DIAGNOSTIC_LIMIT) {
    rootRetentionDiagnostics.delete(rootRetentionDiagnostics.keys().next().value);
  }
  console.info(`[Chat On Steroids] retained ${ownership} ChatGPT root tab`, tab.id, safeReason);
}

function clearRootRetentionDiagnostic(tabId) {
  if (Number.isInteger(tabId)) rootRetentionDiagnostics.delete(String(tabId));
}

/**
 * Give an unreadable app-created root one recorder repair for this exact document.
 *
 * The attempt is written before script injection so MV3 suspension cannot turn maintenance
 * into a reinjection loop. The same document can retry only after a long bounded interval;
 * unreadable state continues to fail closed.
 */
async function repairUnreadableAppOwnedRoot(tab, row, source) {
  const documentId = typeof source?.documentId === 'string' ? source.documentId : '';
  const navigationEpoch = Number.isSafeInteger(source?.navigationEpoch) ? source.navigationEpoch : -1;
  if (row?.repairDocumentId === documentId && row?.repairNavigationEpoch === navigationEpoch &&
      Date.now() - Number(row?.repairAttemptedAt || 0) < ROOT_RECORDER_REPAIR_RETRY_MS) {
    noteRootRetention(tab, source, 'recorder document unavailable after repair');
    return false;
  }
  row.repairDocumentId = documentId;
  row.repairNavigationEpoch = navigationEpoch;
  row.repairAttemptedAt = Date.now();
  await persistLive().catch(() => undefined);
  // Chrome cannot receive an isolated-world ping or script injection in a discarded page.
  // Rehydrate only this aged, app-created empty-root candidate, then wait for the new
  // document's registration and fresh no-draft proof on a later hygiene pass. Never infer
  // that a discarded page is empty and never close it from this reload receipt.
  let repaired = false;
  if (tab.discarded === true) {
    try {
      await chrome.tabs.reload(tab.id);
      repaired = true;
    } catch { /* The root remains owned but unproven. */ }
  } else {
    repaired = await restoreChatgptTab(tab.id);
  }
  noteRootRetention(
    tab,
    source,
    repaired ? 'recorder document unavailable; repair requested' : 'recorder repair unavailable'
  );
  return repaired;
}

/**
 * Current local operations whose exact root document must not be treated as browser litter.
 *
 * The app's `/status` projection adds useful policy, but it is not the owner of these browser
 * elections. Keeping this small projection beside the existing election records lets the bare
 * root sweep run before `/status` without guessing whether an input, catalog, plugin, stop or
 * command page is still in use.
 */
async function currentRootOpeningProtection(policy = null) {
  const tabs = new Set();
  const markers = new Set(
    policy
      ? [
          ...(Array.isArray(policy.inputOpeningIds) ? policy.inputOpeningIds : []),
          ...(Array.isArray(policy.inputs) ? policy.inputs.map(input => input?.id) : [])
        ].filter(id => /^[a-f0-9-]{36}$/i.test(id || ''))
      : []
  );

  for (const [id, opening] of Object.entries(inputOpenings)) {
    if (opening?.stage === 'retired') continue;
    if (Number.isInteger(opening?.tab)) tabs.add(opening.tab);
    if (/^[a-f0-9-]{36}$/i.test(id)) markers.add(id);
  }
  for (const opening of Object.values(stopOpenings)) {
    if (Number.isInteger(opening?.tab)) tabs.add(opening.tab);
  }
  for (const tabId of deferredRevivalOffers.values()) {
    if (Number.isInteger(tabId)) tabs.add(tabId);
  }
  if (Number.isInteger(modelCatalogTarget?.tab)) tabs.add(modelCatalogTarget.tab);

  const owners = await chrome.storage.session.get(['modelCatalogOwner', 'pluginRefreshOwner']);
  const catalogOwner = owners.modelCatalogOwner;
  if (Number.isInteger(catalogOwner?.tab) && !catalogOwner?.handedToInput &&
      appOwnedOpeningTabs[String(catalogOwner.tab)]?.marker === catalogOwner.nonce) {
    tabs.add(catalogOwner.tab);
    if (/^[a-f0-9-]{36}$/i.test(catalogOwner.nonce || '')) markers.add(catalogOwner.nonce);
  }
  const pluginOwner = owners.pluginRefreshOwner;
  const pluginIsCurrent = policy === null || pluginRefreshFlight ||
    (Array.isArray(policy.pluginRefreshRequests) && policy.pluginRefreshRequests.length > 0);
  if (pluginIsCurrent && Number.isInteger(pluginOwner?.tab) &&
      appOwnedOpeningTabs[String(pluginOwner.tab)]?.marker === pluginOwner.id) {
    tabs.add(pluginOwner.tab);
    if (/^[a-f0-9-]{36}$/i.test(pluginOwner.id || '')) markers.add(pluginOwner.id);
  }
  return { tabs, markers };
}

function rootHasLocalOpeningOwner(tabId, protectedTabs = new Set()) {
  if (!Number.isInteger(tabId)) return true;
  if (protectedTabs.has(tabId) || browserControlsTab(tabId) ||
      Object.prototype.hasOwnProperty.call(appOwnedOpeningTabs, String(tabId))) return true;
  return rootHasCurrentOperationOwner(tabId);
}

/** Current local owners other than the app-opening row being evaluated itself. */
function rootHasCurrentOperationOwner(tabId, allowedInputId = null) {
  if (!Number.isInteger(tabId)) return true;
  if (Object.entries(inputOpenings).some(([id, opening]) =>
    id !== allowedInputId && opening?.stage !== 'retired' && opening?.tab === tabId)) return true;
  if (Object.values(stopOpenings).some(opening => opening?.tab === tabId)) return true;
  if ([...deferredRevivalOffers.values()].includes(tabId)) return true;
  return modelCatalogTarget?.tab === tabId;
}

/** An active tab is user-selected only when its window is focused (unknown fails closed). */
async function rootIsSelectedInFocusedWindow(tab) {
  if (tab?.active !== true) return false;
  if (!Number.isInteger(tab?.windowId)) return true;
  try {
    return (await chrome.windows.get(tab.windowId))?.focused !== false;
  } catch {
    return true;
  }
}

/**
 * Moves a focused empty transport shell out of the way before cleanup closes it.
 *
 * Chrome always keeps one tab active in a focused window. Previously that mechanical selection
 * made one proved-empty CoS cleanup tab immortal in every window. Prefer a real named
 * conversation in the same window, and keep failing closed when no such destination exists.
 */
async function handoffSelectedRootFocus(tab, tabs) {
  if (!await rootIsSelectedInFocusedWindow(tab)) return true;
  const replacement = (Array.isArray(tabs) ? tabs : [])
    .filter(candidate => candidate?.id !== tab.id && candidate?.windowId === tab.windowId &&
      Number.isInteger(candidate?.id) && !candidate.pendingUrl && candidate.status !== 'loading' &&
      Boolean(concreteConversationForTab(candidate)))
    .sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
  if (!replacement) return false;
  try {
    await chrome.tabs.update(replacement.id, { active: true });
    return true;
  } catch {
    return false;
  }
}

/** Bounded recorder recovery for an otherwise eligible exact root document. */
async function repairUnreadableIdleRoot(tab, row, source) {
  const documentId = typeof source?.documentId === 'string' ? source.documentId : '';
  const navigationEpoch = Number.isSafeInteger(source?.navigationEpoch) ? source.navigationEpoch : -1;
  if (row?.repairDocumentId === documentId && row?.repairNavigationEpoch === navigationEpoch &&
      Date.now() - Number(row?.repairAttemptedAt || 0) < ROOT_RECORDER_REPAIR_RETRY_MS) {
    noteRootRetention(tab, source, 'recorder document unavailable after repair', 'observed');
    return false;
  }
  row.repairDocumentId = documentId;
  row.repairNavigationEpoch = navigationEpoch;
  row.repairAttemptedAt = Date.now();
  await persistLive().catch(() => undefined);
  const repaired = await restoreChatgptTab(tab.id);
  noteRootRetention(
    tab,
    source,
    repaired ? 'recorder document unavailable; repair requested' : 'recorder repair unavailable',
    'observed'
  );
  return repaired;
}

function exactPlainChatHome(value) {
  try {
    const url = new URL(String(value || ''));
    return (url.origin === 'https://chatgpt.com' || url.origin === 'https://chat.openai.com') &&
      url.pathname === '/' && !url.search && !url.hash ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Exact Temporary Chat home after ChatGPT consumed only the COS input marker. */
function exactUnmarkedTemporaryChatHome(value) {
  try {
    const url = new URL(String(value || ''));
    const keys = [...new Set(url.searchParams.keys())];
    return (url.origin === 'https://chatgpt.com' || url.origin === 'https://chat.openai.com') &&
      url.pathname === '/' && !url.hash && keys.length === 1 && keys[0] === 'temporary-chat' &&
      url.searchParams.get('temporary-chat') === 'true' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Unnamed ChatGPT root carrying only model-picker launch decoration.
 *
 * ChatGPT can consume `clf` before the extension redeems it while leaving the model and
 * reasoning query behind. These two fields are the only non-identity fields this extension
 * authors on a command root. Unknown query/hash state is never treated as disposable.
 */
function exactLaunchDecoratedChatHome(value) {
  try {
    const url = new URL(String(value || ''));
    if ((url.origin !== 'https://chatgpt.com' && url.origin !== 'https://chat.openai.com') ||
        url.pathname !== '/' || url.hash || !url.search) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.length < 1 || keys.some(key => key !== 'model' && key !== 'reasoning_effort')) return null;
    if (url.searchParams.getAll('model').length > 1 || url.searchParams.getAll('reasoning_effort').length > 1) return null;
    const model = url.searchParams.get('model');
    const effort = url.searchParams.get('reasoning_effort');
    if (model !== null && commandModelSlug(model) !== model) return null;
    if (effort !== null && commandReasoningEffort(effort) !== effort.toLowerCase()) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function exactIdleChatHome(value) {
  return exactPlainChatHome(value) || exactLaunchDecoratedChatHome(value);
}

/** Exact bridge command ids currently minted by main (`randomBytes(8).toString('hex')`). */
function clfCommandMarker(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
    const hash = new URL(`https://chatgpt.com/?${url.hash.startsWith('#') ? url.hash.slice(1) : url.hash}`).searchParams;
    const values = [url.searchParams.get('clf'), hash.get('clf')];
    return values.find(value => /^[a-f0-9]{16}$/i.test(value || '')) || null;
  } catch {
    return null;
  }
}

function exactBridgeCommandId(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-f0-9]{16}$/.test(id) ? id : null;
}

/** Exact app-command marker carried by a still-unnamed ChatGPT root document. */
function commandRootMarker(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.pathname !== '/') return null;
    return clfCommandMarker(url.toString());
  } catch {
    return null;
  }
}

function commandMarkerForTab(tab) {
  for (const value of [tab?.pendingUrl, tab?.url]) {
    const marker = clfCommandMarker(value);
    if (marker) return marker.toLowerCase();
  }
  return null;
}

function commandRootMarkerForTab(tab) {
  for (const value of [tab?.pendingUrl, tab?.url]) {
    const marker = commandRootMarker(value);
    if (marker) return marker.toLowerCase();
  }
  return null;
}

function ownedCommandRootMarker(tab) {
  // Routing may use tabConversations while a named chat reloads, but root ownership must use
  // only the route Chrome is concretely showing. A stale A mapping on a proven New Chat page
  // must not hide the app-created root from bounded cleanup forever.
  if (!Number.isInteger(tab?.id) || conversationFromUrl(tab?.url) || conversationFromUrl(tab?.pendingUrl)) return null;
  const row = appOwnedOpeningTabs[String(tab.id)];
  const ownedMarker = exactBridgeCommandId(row?.marker);
  if (!ownedMarker) return null;
  const marker = commandRootMarkerForTab(tab);
  if (marker) return marker === ownedMarker ? marker : null;
  // During this browser session the tab id is durable provenance. Keep that provenance when
  // ChatGPT strips `clf` but leaves only the launch decoration we authored. On a browser
  // restart storage.session is empty, so an unmarked decorated root cannot enter this branch.
  const url = tab?.pendingUrl || tab?.url;
  return exactIdleChatHome(url) ? ownedMarker : null;
}

/** A still-opening worker/resume root is authored command custody, never a reusable idle page. */
function commandOwnedOpeningTab(tab) {
  const marker = commandMarkerForTab(tab);
  const ownedMarker = ownedCommandRootMarker(tab);
  // Browser-session provenance keeps custody after ChatGPT strips the marker. A copied/foreign
  // visible marker is not enough on its own; it must agree with the app-owned opening row.
  return Boolean(ownedMarker && (!marker || marker === ownedMarker));
}

function appOpeningMarker(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
    const hash = new URL(`https://chatgpt.com/?${url.hash.startsWith('#') ? url.hash.slice(1) : url.hash}`).searchParams;
    const command = clfCommandMarker(url.toString());
    const values = [
      url.searchParams.get('cos-input'), hash.get('cos-input'),
      url.searchParams.get('cos-model-catalog'), hash.get('cos-model-catalog'),
      url.searchParams.get('cos-plugin-refresh'), hash.get('cos-plugin-refresh')
    ];
    return command || values.find(value => /^[a-f0-9-]{36}$/i.test(value || '')) || null;
  } catch {
    return null;
  }
}

async function rememberAppOwnedOpeningTab(tab, authoredUrl = null, owner = null) {
  if (!Number.isInteger(tab?.id)) return false;
  const key = String(tab.id);
  const marker = appOpeningMarker(tab.pendingUrl || tab.url || authoredUrl);
  const placementOwner = typeof owner === 'string' && /^resume:[0-9a-f-]{8,64}$/i.test(owner)
    ? owner.toLowerCase()
    : null;
  if (conversationFromUrl(tab.pendingUrl || tab.url || authoredUrl)) {
    if (!Object.prototype.hasOwnProperty.call(appOwnedOpeningTabs, key)) return false;
    delete appOwnedOpeningTabs[key];
    await chrome.storage.session.set({ appOwnedOpeningTabs });
    return true;
  }
  const existing = appOwnedOpeningTabs[key];
  if (!authoredUrl && !marker && !existing) return false;
  if (existing) {
    const next = {
      ...existing,
      ...(marker ? { marker } : {}),
      ...(placementOwner ? { owner: placementOwner } : {})
    };
    if (next.marker === existing.marker && next.owner === existing.owner) return false;
    appOwnedOpeningTabs[key] = next;
    await chrome.storage.session.set({ appOwnedOpeningTabs });
    return true;
  }
  appOwnedOpeningTabs[key] = {
    createdAt: Date.now(),
    ...(marker ? { marker } : {}),
    ...(placementOwner ? { owner: placementOwner } : {})
  };
  appOwnedOpeningTabs = Object.fromEntries(Object.entries(appOwnedOpeningTabs).slice(-200));
  await chrome.storage.session.set({ appOwnedOpeningTabs });
  scheduleRetry();
  return true;
}

/**
 * Keeps one explicit Open-in-Chrome tab attached to the conversation it still owes.
 *
 * ChatGPT can throttle an exact `/c/<id>` navigation by replacing it with the bare home route.
 * The existing app-opening row is the right lifetime for that provenance: it survives service
 * worker suspension, protects the root from cleanup, and is cleared by the tab lifecycle below.
 */
async function rememberOpenConversationTab(tab, request) {
  if (!Number.isInteger(tab?.id)) return false;
  const conversationId = cleanConversationId(request?.conversationId);
  const requestId = typeof request?.requestId === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(request.requestId)
    ? request.requestId
    : null;
  if (!conversationId || !requestId) return false;
  appOwnedOpeningTabs[String(tab.id)] = {
    createdAt: Date.now(), conversationId, openRequestId: requestId, openState: 'opening',
    retargetCount: 0, replacementCreated: false
  };
  appOwnedOpeningTabs = Object.fromEntries(Object.entries(appOwnedOpeningTabs).slice(-200));
  await chrome.storage.session.set({ appOwnedOpeningTabs });
  scheduleRetry();
  return true;
}

async function rememberRedirectedConversationTab(tabId, conversationId) {
  const id = cleanConversationId(conversationId);
  if (!Number.isInteger(tabId) || !id) return false;
  appOwnedOpeningTabs[String(tabId)] = {
    createdAt: Date.now(),
    conversationId: id,
    openRequestId: `redirect-${tabId}`,
    openState: 'redirected',
    retargetCount: 0,
    replacementCreated: false
  };
  appOwnedOpeningTabs = Object.fromEntries(Object.entries(appOwnedOpeningTabs).slice(-200));
  await chrome.storage.session.set({ appOwnedOpeningTabs });
  return true;
}

/** Reconciles that one-shot provenance against a concrete browser navigation. */
async function reconcileOpenConversationTab(tabId, value, completed = false) {
  const key = String(tabId);
  const row = appOwnedOpeningTabs[key];
  const conversationId = cleanConversationId(row?.conversationId);
  if (!conversationId) return false;
  const exactConversation = conversationFromUrl(value);
  if (exactConversation === conversationId && !completed) {
    if (row.openState === 'escalated') {
      // A concrete exact route outranks the fallback. Drop the escalation episode so neither
      // an alarm nor a delayed HTTP retry can move a conversation that is reachable again.
      delete appOwnedOpeningTabs[key];
      await chrome.storage.session.set({ appOwnedOpeningTabs });
      return true;
    }
    if (row.openState !== 'opening') {
      row.openState = 'opening';
      await chrome.storage.session.set({ appOwnedOpeningTabs });
    }
    return true;
  }
  if (exactConversation === conversationId && completed) {
    delete appOwnedOpeningTabs[key];
  } else if (exactPlainChatHome(value)) {
    // The grace period belongs to this transition, not to every URL/status replay Chrome emits.
    // Repeated observations of the same redirected document must not make it immortal.
    if (row.openState === 'redirected' || row.openState === 'escalated') return true;
    row.openState = 'redirected';
    row.createdAt = Date.now();
  } else {
    // A different named route, decorated root or external page is a user/provider-owned move.
    delete appOwnedOpeningTabs[key];
  }
  await chrome.storage.session.set({ appOwnedOpeningTabs });
  return true;
}

async function adoptMarkedAppOwnedTabs(tabs) {
  for (const tab of tabs) {
    if (appOpeningMarker(tab?.pendingUrl || tab?.url)) await rememberAppOwnedOpeningTab(tab);
  }
}
let backgroundWindowBounds = { width: 800, height: 600 };
/** One serialized owner for window adoption, consolidation and new tab placement. */
function inBackgroundWindow(work) {
  const flight = (backgroundWindowFlight || Promise.resolve()).catch(() => undefined).then(work);
  backgroundWindowFlight = flight;
  return flight.finally(() => { if (backgroundWindowFlight === flight) backgroundWindowFlight = null; });
}
async function storedBackgroundWindow() {
  const { chatBackgroundWindow: id } = await chrome.storage.session.get('chatBackgroundWindow');
  if (!Number.isInteger(id)) return null;
  try { return await chrome.windows.get(id); }
  catch { await chrome.storage.session.remove('chatBackgroundWindow'); return null; }
}
/**
 * Chooses an already-existing normal Chrome window for an inactive app tab.
 *
 * `backgroundChats` means background/inactive placement, not a second browser window. Prefer the
 * exact Prime window when the caller knows it; otherwise use the normal window already carrying
 * the most concrete ChatGPT work. Private windows are never eligible, even when a retained
 * Prime id points there. Never focus, minimize, create or claim a window here.
 */
async function backgroundTabWindow(preferredWindowId = null, foreground = false) {
  if (Number.isInteger(preferredWindowId)) {
    try {
      const preferred = await chrome.windows.get(preferredWindowId);
      if (Number.isInteger(preferred?.id) && preferred.incognito !== true &&
          (!preferred.type || preferred.type === 'normal')) return preferred.id;
    } catch { /* Fall through to the browser-profile-local normal-window election. */ }
  }
  if (!chrome.windows || typeof chrome.windows.getAll !== 'function') return null;
  if (foreground && typeof chrome.windows.getLastFocused === 'function') {
    try {
      const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (Number.isInteger(last?.id) && last.incognito !== true && (!last.type || last.type === 'normal')) return last.id;
    } catch { /* The normal-window inventory below remains authoritative. */ }
  }
  let windows;
  try { windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }); }
  catch { throw new Error('chat_window_inventory_unavailable'); }
  const chatgpt = tab => {
    try { return new URL(tab?.pendingUrl || tab?.url || '').origin === 'https://chatgpt.com'; }
    catch { return false; }
  };
  const ranked = windows
    .filter(window => Number.isInteger(window?.id) && window.incognito !== true &&
      (!window.type || window.type === 'normal'))
    .map(window => {
      const tabs = Array.isArray(window.tabs) ? window.tabs : [];
      const chatTabs = tabs.filter(chatgpt);
      const conversations = chatTabs.filter(tab => concreteConversationForTab(tab)).length;
      return { window, conversations, chatTabs: chatTabs.length, tabs: tabs.length };
    })
    .sort((a, b) => (foreground ? Number(b.window.focused === true) - Number(a.window.focused === true) : 0) ||
      b.conversations - a.conversations || Number(b.window.focused === true) - Number(a.window.focused === true) ||
      b.chatTabs - a.chatTabs || b.tabs - a.tabs || a.window.id - b.window.id);
  return ranked[0]?.window.id ?? null;
}

/** Reconciles the old dedicated-window layout into the existing per-profile normal window. */
async function reconcileBackgroundWindow(policy) {
  // Older builds used `chatBackgroundWindow` as authority to create/minimize a second Chrome
  // window. Retain the same serialized reconciliation owner, but migrate that layout toward the
  // Prime/main window and then retire the legacy marker. Exact worker/root custody below is also
  // enough to converge orphaned one-worker windows after a service-worker/browser restart.
  const workers = new Set((Array.isArray(policy.workerConversations) ? policy.workerConversations : [])
    .map(cleanConversationId).filter(Boolean));
  const managed = new Set((Array.isArray(policy.managedConversations) ? policy.managedConversations : [])
    .map(cleanConversationId).filter(Boolean));
  const inputIds = new Set((Array.isArray(policy.inputs) ? policy.inputs : []).map(input => input?.id).filter(id => typeof id === 'string'));
  const ownsMachineTab = tab => {
    if (workers.has(conversationForTab(tab))) return true;
    // An app-created transport shell belongs with the other machine-owned browser work while
    // it is still unnamed. This is the missing ownership edge that allowed one recovery root
    // to remain in each normal Chrome window, producing a separate Queue/Recovery group there.
    // Once a real /c/<id> exists it is a main/worker chat again and this root-only authority
    // disappears; ordinary Prime tabs are therefore never pulled across windows.
    const opening = Number.isInteger(tab?.id) ? appOwnedOpeningTabs[String(tab.id)] : null;
    if (opening && !concreteConversationForTab(tab)) return true;
    try {
      const url = new URL(tab.pendingUrl || tab.url || '');
      if (url.origin !== 'https://chatgpt.com') return false;
      const inputId = url.searchParams.get('cos-input') || new URLSearchParams(url.hash.slice(1)).get('cos-input');
      // Catalog markers retain ownership across browser restart so the warm empty
      // document can be handed to the first authored input without another window.
      const catalogHelper = url.pathname === '/' && /^[a-f0-9-]{36}$/i.test(url.searchParams.get('cos-model-catalog') || '');
      return (inputId && inputIds.has(inputId)) || catalogHelper;
    } catch { return false; }
  };
  return inBackgroundWindow(async () => {
    const legacy = await storedBackgroundWindow();
    let tabs, windows;
    try {
      tabs = await chrome.tabs.query({});
      windows = typeof chrome.windows?.getAll === 'function'
        ? await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
        : [];
    } catch { return false; }
    windows = windows.filter(window => Number.isInteger(window?.id) && window.incognito !== true &&
      (!window.type || window.type === 'normal'));
    const regularWindowIds = new Set(windows.map(window => window.id));
    const byWindow = new Map();
    for (const tab of tabs) {
      if (!regularWindowIds.has(tab?.windowId) || tab.incognito === true) continue;
      const row = byWindow.get(tab.windowId) || { main: 0, managed: 0, chatgpt: 0, tabs: 0 };
      row.tabs += 1;
      const conversation = conversationForTab(tab);
      if (managed.has(conversation)) {
        row.managed += 1;
        if (!workers.has(conversation)) row.main += 1;
      }
      try { if (new URL(tab.pendingUrl || tab.url || '').origin === 'https://chatgpt.com') row.chatgpt += 1; }
      catch { /* not a ChatGPT tab */ }
      byWindow.set(tab.windowId, row);
    }
    const ranked = windows
      .filter(window => Number.isInteger(window?.id) &&
        // Prefer a real/main window over the retired dedicated owner whenever one exists.
        (!Number.isInteger(legacy?.id) || window.id !== legacy.id || windows.length === 1))
      .map(window => ({ window, ...(byWindow.get(window.id) || { main: 0, managed: 0, chatgpt: 0, tabs: 0 }) }))
      .sort((a, b) => b.main - a.main || Number(b.window.focused === true) - Number(a.window.focused === true) ||
        b.managed - a.managed || b.chatgpt - a.chatgpt || b.tabs - a.tabs || a.window.id - b.window.id);
    const destination = ranked[0]?.window || (legacy && windows.find(window => window.id === legacy.id)) || null;
    if (!destination || !Number.isInteger(destination.id)) {
      if (legacy) await chrome.storage.session.remove('chatBackgroundWindow');
      return true;
    }
    let moved = 0;
    const candidates = tabs.filter(tab => {
      if (!Number.isInteger(tab?.id) || !regularWindowIds.has(tab?.windowId) ||
          tab.incognito === true || tab.pinned === true) return false;
      if (ownsMachineTab(tab)) return true;
      // The legacy window marker is stronger evidence than a missing post-restart command map.
      // When it still exists, preserve the old off-transition behavior for its ChatGPT tabs so
      // an upgrade cannot strand a root merely because its short-lived command id already ended.
      if (policy.background !== true && legacy && tab.windowId === legacy.id) {
        try { return new URL(tab.pendingUrl || tab.url || '').origin === 'https://chatgpt.com'; }
        catch { return false; }
      }
      return false;
    });
    for (const tab of candidates) {
      if (tab.windowId === destination.id) continue;
      // The app's policy is conversation/command scoped; re-read after every
      // async boundary so navigation cannot move an unrelated replacement tab.
      try {
        const current = await chrome.tabs.get(tab.id);
        if (current.pinned === true || current.incognito === true ||
            !regularWindowIds.has(current.windowId) || current.windowId === destination.id) continue;
        if (!ownsMachineTab(current) && policy.background === true) continue;
        if (!ownsMachineTab(current) && policy.background !== true) {
          const url = new URL(current.pendingUrl || current.url || '');
          if (!legacy || current.windowId !== legacy.id || url.origin !== 'https://chatgpt.com') continue;
        }
        // Do not pull the page the user is actively inspecting out of a focused window. It will
        // join its Prime/main window on the next ordinary pass after focus moves away.
        const sourceWindow = await chrome.windows.get(current.windowId);
        if (sourceWindow?.incognito === true || sourceWindow?.type && sourceWindow.type !== 'normal' ||
            current.active === true && sourceWindow?.focused === true) continue;
        await chrome.tabs.move(current.id, { windowId: destination.id, index: -1 });
        moved += 1;
      } catch { /* A closing/navigating tab is reconsidered by the next ordinary status pass. */ }
    }
    if (legacy) await chrome.storage.session.remove('chatBackgroundWindow');
    if (moved > 0) console.info('[Chat On Steroids] consolidated app-owned background tabs into normal window', destination.id, moved);
    return true;
  });
}
/** Background placement never focuses; create a regular window only when none exists. */
async function createChatTab(url, background = false, active = !background, openConversationRequest = null, preferredWindowId = null, acceptance = null, placement = null) {
  const currentAdmission = () => acceptance === null || acceptance() === true;
  if (!currentAdmission()) return null;
  const tab = await inBackgroundWindow(async () => {
    const windowId = await backgroundTabWindow(preferredWindowId, !background);
    if (!currentAdmission()) return null;
    if (Number.isInteger(windowId)) return chrome.tabs.create({ url, windowId, active,
      ...(windowId === preferredWindowId && Number.isInteger(placement?.index) && placement.index >= 0
        ? { index: placement.index } : {}) });
    // Firefox for Android has no windows API and no neighboring private desktop window.
    if (typeof chrome.windows?.getAll !== 'function' && typeof chrome.windows?.create !== 'function') {
      return chrome.tabs.create({ url, active });
    }
    if (typeof chrome.windows?.create !== 'function') throw new Error('chat_regular_window_unavailable');
    const created = await chrome.windows.create({ url, type: 'normal', incognito: false, focused: !background && active === true });
    if (!Number.isInteger(created?.id) || created.incognito === true || !Number.isInteger(created.tabs?.[0]?.id)) {
      throw new Error('chat_regular_window_not_ready');
    }
    console.info('[Chat On Steroids] created regular chat window', created.id, background ? 'background' : 'user');
    return created.tabs[0];
  });
  if (!tab) return null;
  // Native creation already spent authority; retain its existing provenance after withdrawal.
  if (placement?.owner) await rememberAppOwnedOpeningTab(tab, url, placement.owner);
  else await rememberAppOwnedOpeningTab(tab, url);
  if (!currentAdmission()) return tab;
  if (openConversationRequest) await rememberOpenConversationTab(tab, openConversationRequest);
  return tab;
}

/** Bound waiting for a page; a missing reply never grants action or replay authority. */
async function tabReply(tabId, message, options, timeoutMs = 3000, missingReply = null) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message, options),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })
    ]);
  } catch { return missingReply; } finally { clearTimeout(timer); }
}

/** A visible logout in this Chrome profile holds dispatch even if another tab has stale account UI. */
async function browserAuthenticationState(tabs) {
  const candidates = (Array.isArray(tabs) ? tabs : [])
    .filter(tab => Number.isInteger(tab?.id) && !tab.pendingUrl)
    .slice(0, 24);
  if (!candidates.length) return 'unknown';
  const states = await Promise.all(candidates.map(tab => tabReply(tab.id, { type: 'clf-page-status' }, undefined, 1200)));
  if (states.some(reply => reply?.authState === 'signed-out')) return 'signed-out';
  if (states.some(reply => reply?.authState === 'signed-in')) return 'signed-in';
  return 'unknown';
}

/**
 * Gives one explicitly idle hidden repair tab a bounded hydration chance, then restores Chrome.
 *
 * Chrome can throttle an inactive ChatGPT renderer before its native Retry card or Goal pickup
 * handler finishes mounting. The first message must explicitly prove that it performed no action;
 * a timeout/throw is ambiguous and is never replayed. Selecting a tab does not focus its window,
 * and the prior tab is restored only while this exact conversation is still selected, so a user
 * switch during the attempt always wins. Attended mode requires the target window to be
 * unfocused; explicit unattended profiles may perform the same reversible wake in the focused
 * Chrome window without focusing the OS window themselves.
 */
async function retryRepairMessageAfterTabWake(
  target,
  conversationId,
  first,
  message,
  mayRetry,
  allowFocusedWindowWake = false
) {
  if (!mayRetry(first) || target?.active === true || !Number.isInteger(target?.id) ||
      !Number.isInteger(target?.windowId)) return first;
  const windowId = target.windowId;
  let previous = null;
  try {
    // Day mode is attended: waking an inactive renderer must not visibly replace the tab the
    // user is reading. In an unfocused/background Chrome window the same bounded selection is
    // invisible, while Overnight/Rotation explicitly authorize unattended wake-and-restore.
    // Unknown window focus fails closed because selecting after that uncertainty is exactly the
    // disruptive tab jump this guard exists to prevent.
    if (!allowFocusedWindowWake) {
      let ownerWindow = null;
      try { ownerWindow = await chrome.windows.get(windowId); } catch { /* defer below */ }
      if (ownerWindow?.focused !== false) {
        console.info('[Chat On Steroids] deferred hidden-tab repair in focused Chrome window', {
          conversationId,
          messageType: message?.type || 'unknown',
          windowId
        });
        return { ok: false, error: 'tab_wake_deferred' };
      }
    }
    const before = await chrome.tabs.query({ active: true, windowId });
    previous = before.find(tab => tab.windowId === windowId && tab.active === true &&
      Number.isInteger(tab.id) && tab.id !== target.id) ?? null;
    // Unknown active-tab state cannot authorize even a reversible selection change.
    if (!previous) return first;
    await chrome.tabs.update(target.id, { active: true });
    await new Promise(resolve => setTimeout(resolve, 350));
    return await chrome.tabs.sendMessage(target.id, message).catch(() => null);
  } finally {
    if (previous) {
      try {
        const after = await chrome.tabs.query({ windowId });
        const currentTarget = after.find(tab => tab.id === target.id);
        const priorStillExists = after.some(tab => tab.id === previous.id && tab.windowId === windowId);
        // Do not undo a user switch or restore across a route/document ownership change.
        if (currentTarget?.active === true && conversationForTab(currentTarget) === conversationId &&
            priorStillExists) await chrome.tabs.update(previous.id, { active: true });
      } catch { /* The user closed/switched the window while the bounded wake was running. */ }
    }
  }
}

function inputReuseProbe(tabId, documentId) {
  return tabReply(tabId, { type: 'clf-input-reuse-state' }, { documentId });
}

/**
 * Closes only a plain home tab this extension created and later abandoned.
 *
 * The tab must still be the same registered document, must have no draft/generation according
 * to its content script, and must never have become a conversation. Missing proof means keep it.
 * This deliberately cannot touch an ordinary user-opened chatgpt.com tab or any /c/<id> tab.
 */
async function cleanupAppOwnedRootTabs(
  tabs,
  browserCommandIds = [],
  browserAttentionCommandIds = [],
  protectedOpeningTabs = new Set(),
  protectedOpeningMarkers = new Set(),
  { completeInventory = true, conversationRootsOnly = false } = {}
) {
  const now = Date.now();
  // Every Chrome window has one `active` tab even when the whole window is in the background.
  // Treat that mechanical active bit as user selection only in a focused window. Worker and
  // recovery roots can survive in an older app-owned window after a setting change/restart, so
  // tying this exception to the *currently stored* background-window id leaked those tabs
  // forever. Exact app-opening provenance + fresh page proof remain mandatory below.
  const activeStillSafeToClose = async tab => {
    if (tab.active !== true) return true;
    if (!Number.isInteger(tab.windowId)) return false;
    try { return (await chrome.windows.get(tab.windowId)).focused !== true; }
    catch { return false; }
  };
  const activeCommands = new Set(
    (Array.isArray(browserCommandIds) ? browserCommandIds : []).filter(id => /^[a-f0-9]{16}$/i.test(id || ''))
  );
  const attentionCommands = new Set(
    (Array.isArray(browserAttentionCommandIds) ? browserAttentionCommandIds : [])
      .map(exactBridgeCommandId).filter(Boolean)
  );
  const byId = new Map(tabs.filter(tab => Number.isInteger(tab?.id)).map(tab => [String(tab.id), tab]));
  let changed = false;
  let remaining = [...tabs];
  // Rehydrating every discarded failure root at once recreates the provider-throttle burst
  // cleanup is meant to relieve. Two exact app-owned pages per pass can become readable;
  // the next ordinary maintenance pass continues with the rest.
  let discardedRootReloadBudget = 2;
  const repairRoot = async (tab, row, source) => {
    const alreadyAttempted = row?.repairDocumentId === (source.documentId || '') &&
      row?.repairNavigationEpoch === source.navigationEpoch &&
      now - Number(row?.repairAttemptedAt || 0) < ROOT_RECORDER_REPAIR_RETRY_MS;
    if (tab.discarded === true && !alreadyAttempted) {
      if (discardedRootReloadBudget <= 0) return false;
      discardedRootReloadBudget--;
    }
    return repairUnreadableAppOwnedRoot(tab, row, source);
  };
  for (const [key, row] of Object.entries(appOwnedOpeningTabs)) {
    // The narrow browser-local pass deliberately owns only failed explicit conversation opens.
    // Command/input/catalog/plugin roots still require their authoritative status projections.
    if (conversationRootsOnly && !cleanConversationId(row?.conversationId)) continue;
    const tab = byId.get(key);
    if (!tab) {
      // A URL-filtered bare-root inventory says nothing about named or decorated tabs. Preserve
      // provenance until a complete inventory proves that this concrete tab no longer exists.
      if (!completeInventory) continue;
      delete appOwnedOpeningTabs[key];
      changed = true;
      continue;
    }
    // A currently named conversation is browser state owned by the user. Drop root-cleanup
    // authority; only a concrete root plus its own later empty-page proof may clear stale
    // reload-era routing metadata.
    if (concreteConversationForTab(tab)) {
      const openingConversation = cleanConversationId(row?.conversationId);
      if (openingConversation === concreteConversationForTab(tab) &&
          row.openState === 'opening' && tab.status !== 'complete') {
        continue;
      }
      delete appOwnedOpeningTabs[key];
      changed = true;
      continue;
    }
    // An app-owned plain root can be the exact elected destination of a durable input after
    // ChatGPT strips its UUID marker. Cleanup runs before input delivery, so the outbox election
    // and current catalog/plugin owner must veto retirement before any age/cap policy applies.
    const initialSource = { tab: tab.id, documentId: tabDocuments[key], navigationEpoch: tabEpochs[key] };
    if (browserControlsTab(tab.id)) {
      noteRootRetention(tab, initialSource, 'active browser-control lease');
      continue;
    }
    if (protectedOpeningTabs.has(tab.id) || protectedOpeningMarkers.has(row?.marker)) {
      noteRootRetention(tab, initialSource, 'pending app operation');
      continue;
    }
    // `openState` is diagnostic, not permanent cleanup authority. Chrome can replace an exact
    // /c/<id> navigation with the plain home document without delivering the URL transition that
    // changes `opening` to `redirected`. Treating `opening` as an endless pending operation leaked
    // those proved-empty roots (and their collapsed cleanup group) forever. Keep the short lease,
    // then let the same exact-page proof below retire either state. A real in-flight owner already
    // vetoes cleanup through `protectedOpeningTabs`/`protectedOpeningMarkers` above.
    if (cleanConversationId(row?.conversationId) && now - row.createdAt < APP_OWNED_ROOT_GRACE_MS) {
      noteRootRetention(tab, initialSource, 'cleanup grace period');
      continue;
    }
    if (!Number.isFinite(row?.createdAt) || now - row.createdAt < APP_OWNED_ROOT_GRACE_MS) {
      noteRootRetention(tab, initialSource, 'cleanup grace period');
      continue;
    }
    if (!await activeStillSafeToClose(tab) && !await handoffSelectedRootFocus(tab, remaining)) {
      noteRootRetention(tab, initialSource, 'selected tab');
      continue;
    }
    if (tab.pinned) {
      noteRootRetention(tab, initialSource, 'pinned tab');
      continue;
    }
    if (tab.pendingUrl) {
      noteRootRetention(tab, initialSource, 'navigation in progress');
      continue;
    }
    let url;
    try { url = new URL(tab.url || ''); } catch {
      noteRootRetention(tab, initialSource, 'not an exact empty home');
      continue;
    }
    const idleHome = exactIdleChatHome(url.toString());
    const ownedMarker = ownedCommandRootMarker(tab);
    const registeredCommand = exactBridgeCommandId(row.marker);
    const attentionCommandHome = Boolean(
      (registeredCommand && attentionCommands.has(registeredCommand)) ||
      (ownedMarker && attentionCommands.has(ownedMarker))
    );
    // A needs-attention command is no longer making automatic transport progress, but this
    // concrete document is still its only authorized late-ACK/reconciliation owner. Age and
    // burst pressure must therefore fail closed until main resolves or explicitly cancels the
    // attention row. Retiring it here would strand an otherwise recoverable handoff and force a
    // replacement tab that is intentionally forbidden from taking over the exact command id.
    if (attentionCommandHome) {
      noteRootRetention(tab, initialSource, 'command needs exact-page attention');
      continue;
    }
    const staleCommandHome = ownedMarker && row.marker === ownedMarker && !activeCommands.has(ownedMarker);
    // Other marked helpers own separate input/catalog/plugin lifecycles. A command marker is
    // removable only after the app's successful /status response proves that exact command is
    // gone. Tab-id provenance also catches a root after ChatGPT consumes `clf` and leaves only
    // the extension-authored model/reasoning decoration. Unknown root state is never cleanup.
    // Only a 16-hex bridge command waits for the authoritative command projection. UUID helper
    // markers (input/catalog/plugin refresh) keep the short app-owned empty-root
    // cleanup after ChatGPT consumes the marker and leaves a plain root.
    if (exactBridgeCommandId(row.marker)
      ? !staleCommandHome
      : !idleHome) {
      noteRootRetention(
        tab,
        initialSource,
        exactBridgeCommandId(row.marker) ? 'command is still active' : 'not an exact empty home'
      );
      continue;
    }
    const source = { tab: tab.id, documentId: tabDocuments[key], navigationEpoch: tabEpochs[key] };
    if (!ownsDocument(source)) {
      await repairRoot(tab, row, source);
      continue;
    }
    try {
      const current = await chrome.tabs.get(tab.id);
      if (!await activeStillSafeToClose(current) && !await handoffSelectedRootFocus(current, remaining)) {
        noteRootRetention(tab, source, 'selected tab');
        continue;
      }
      if (current.pinned) {
        noteRootRetention(tab, source, 'pinned tab');
        continue;
      }
      if (current.pendingUrl) {
        noteRootRetention(tab, source, 'navigation in progress');
        continue;
      }
      if (current.url !== tab.url || concreteConversationForTab(current)) {
        noteRootRetention(tab, source, 'tab changed during cleanup');
        continue;
      }
      if (!ownsDocument(source)) {
        await repairRoot(tab, row, source);
        continue;
      }
      const proof = await tabReply(tab.id, { type: 'clf-tab-close-check', conversationId: null }, { documentId: source.documentId });
      if (!proof) {
        await repairRoot(tab, row, source);
        continue;
      }
      if (proof.safe !== true) {
        noteRootRetention(tab, source, rootCloseProofReason(proof));
        continue;
      }
      if (proof.conversationId !== null || proof.navigationEpoch !== source.navigationEpoch || !ownsDocument(source)) {
        noteRootRetention(tab, source, 'page proof did not match the current document');
        continue;
      }
      const latest = await chrome.tabs.get(tab.id);
      if (!await activeStillSafeToClose(latest) || latest.pinned || latest.pendingUrl ||
          latest.url !== tab.url || concreteConversationForTab(latest) || !ownsDocument(source)) {
        noteRootRetention(tab, source, 'tab changed during cleanup');
        continue;
      }
      // The content document has now proved that this concrete root has no conversation,
      // draft, attachment, generation, queued delivery or helper action. Only at this point is
      // it safe to discard a reload-era routing fallback that still names an old /c chat.
      if (cleanConversationId(tabConversations[key])) {
        delete tabConversations[key];
        changed = true;
      }
      if (!await retireAutomaticTab(tab.id, async () => {
        const finalProtection = await currentRootOpeningProtection(null);
        if (finalProtection.tabs.has(tab.id) || finalProtection.markers.has(row?.marker)) return false;
        const finalTab = await chrome.tabs.get(tab.id);
        if (!await activeStillSafeToClose(finalTab)) return false;
        const newest = await chrome.tabs.get(tab.id);
        // No await after this point: the exact opening row, local operation owner, URL and
        // document epoch are re-elected together immediately before remove.
        return appOwnedOpeningTabs[key] === row && !browserControlsTab(tab.id) &&
          !rootHasCurrentOperationOwner(tab.id) && !protectedOpeningTabs.has(tab.id) &&
          !protectedOpeningMarkers.has(row?.marker) && newest.active === finalTab.active &&
          newest.windowId === finalTab.windowId && !newest.pinned && !newest.pendingUrl &&
          newest.status !== 'loading' && newest.url === tab.url &&
          (Boolean(exactIdleChatHome(newest.url)) || commandRootMarkerForTab(newest) === ownedMarker) &&
          !concreteConversationForTab(newest) && ownsDocument(source);
      })) {
        noteRootRetention(tab, source, 'last browser tab retained');
        continue;
      }
      remaining = remaining.filter(candidate => candidate.id !== tab.id);
      delete appOwnedOpeningTabs[key];
      clearRootRetentionDiagnostic(tab.id);
      changed = true;
      console.info(
        `[Chat On Steroids] closed one unused app-created ChatGPT ${staleCommandHome ? 'command' : 'home'} tab`,
        tab.id,
        staleCommandHome ? `${ownedMarker}:unredeemed` : ''
      );
    } catch {
      // A missing receiver, changed document or Chrome API error is not close authority.
      noteRootRetention(tab, source, 'Chrome inventory unavailable');
    }
  }
  if (changed) await persistLive().catch(() => undefined);
  return remaining;
}

/**
 * Retires unchanged, unused app-owned plain ChatGPT home tabs after the bounded idle interval.
 *
 * This store is a custody transfer, not an ownership-discovery tier. Provenance-free rows from
 * older builds are discarded and arbitrary personal New Chat roots are never enrolled. Candidates
 * still require exact live document ownership and a fresh empty-page verdict; selected, pinned,
 * navigated, unreadable or edited tabs stay open.
 */
async function cleanupIdleRootTabs(
  tabs,
  { completeInventory = true, exactBareOnly = false, protectedTabs = new Set() } = {}
) {
  const now = Date.now();
  const byId = new Map(tabs.filter(tab => Number.isInteger(tab?.id)).map(tab => [String(tab.id), tab]));
  let changed = false;
  let remaining = [...tabs];
  const exactHome = value => exactBareOnly ? exactPlainChatHome(value) : exactIdleChatHome(value);

  for (const key of Object.keys(idleRootTabs)) {
    const tab = byId.get(key);
    const row = idleRootTabs[key];
    // A narrow bare-root query says nothing about decorated roots or named chats. Leave records
    // absent from that partial inventory for the ordinary full hygiene pass to reconcile.
    if (!tab) {
      if (completeInventory) {
        delete idleRootTabs[key];
        changed = true;
      }
      continue;
    }
    if (row?.appOwned !== true) {
      delete idleRootTabs[key];
      changed = true;
      continue;
    }
    const url = exactHome(tab.url);
    const source = {
      tab: tab.id,
      documentId: typeof tabDocuments[key] === 'string' ? tabDocuments[key] : '',
      navigationEpoch: Number.isSafeInteger(tabEpochs[key]) ? tabEpochs[key] : -1
    };
    if (!completeInventory && !url) continue;
    if (rootHasLocalOpeningOwner(tab.id, protectedTabs) || !url || concreteConversationForTab(tab) || row.url !== url) {
      delete idleRootTabs[key];
      changed = true;
      continue;
    }
    if (row.documentId === source.documentId && row.navigationEpoch === source.navigationEpoch) continue;
    // Recorder reinjection does not navigate the page, but it creates the first usable proof
    // lease for this document. Give that newly registered identity its own full idle interval.
    if (!row.documentId && source.documentId && row.repairAttemptedAt) {
      row.documentId = source.documentId;
      row.navigationEpoch = source.navigationEpoch;
      row.repairDocumentId = source.documentId;
      row.repairNavigationEpoch = source.navigationEpoch;
      row.seenAt = now;
      row.lastAccessedAt = Math.max(now, Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : now);
      changed = true;
      continue;
    }
    delete idleRootTabs[key];
    changed = true;
  }

  const candidates = Object.entries(idleRootTabs)
    .map(([key, row]) => ({ key, row, tab: byId.get(key), idleSince: Math.max(row.seenAt, row.lastAccessedAt) }))
    .filter(candidate => candidate.tab && now - candidate.idleSince >= IDLE_ROOT_CLOSE_MS)
    .sort((a, b) => b.idleSince - a.idleSince || Number(b.key) - Number(a.key));

  for (const candidate of candidates) {
    const { key, row, tab } = candidate;
    if (rootHasLocalOpeningOwner(tab.id, protectedTabs)) {
      noteRootRetention(
        tab,
        row,
        browserControlsTab(tab.id) ? 'active browser-control lease' : 'pending app operation',
        'observed'
      );
      continue;
    }
    if (await rootIsSelectedInFocusedWindow(tab) && !await handoffSelectedRootFocus(tab, remaining)) {
      noteRootRetention(tab, row, 'selected tab', 'observed');
      continue;
    }
    if (tab.pinned) {
      noteRootRetention(tab, row, 'pinned tab', 'observed');
      continue;
    }
    if (tab.pendingUrl) {
      noteRootRetention(tab, row, 'navigation in progress', 'observed');
      continue;
    }
    const source = { tab: tab.id, documentId: row.documentId, navigationEpoch: row.navigationEpoch };
    try {
      const current = await chrome.tabs.get(tab.id);
      if (rootHasLocalOpeningOwner(tab.id, protectedTabs) ||
          (await rootIsSelectedInFocusedWindow(current) && !await handoffSelectedRootFocus(current, remaining)) ||
          current.pinned || current.pendingUrl || current.status === 'loading' || current.url !== row.url ||
          !exactHome(current.url) || concreteConversationForTab(current)) {
        noteRootRetention(tab, source, 'tab changed during cleanup', 'observed');
        continue;
      }
      if (!ownsDocument(source)) {
        await repairUnreadableIdleRoot(tab, row, source);
        continue;
      }
      const proof = await tabReply(tab.id, { type: 'clf-tab-close-check', conversationId: null },
        { documentId: row.documentId });
      if (!proof) {
        await repairUnreadableIdleRoot(tab, row, source);
        continue;
      }
      if (proof.safe !== true) {
        noteRootRetention(tab, source, rootCloseProofReason(proof), 'observed');
        continue;
      }
      if (proof.conversationId !== null || proof.navigationEpoch !== row.navigationEpoch || !ownsDocument(source)) {
        noteRootRetention(tab, source, 'page proof did not match the current document', 'observed');
        continue;
      }
      const latest = await chrome.tabs.get(tab.id);
      if (rootHasLocalOpeningOwner(tab.id, protectedTabs) ||
          (await rootIsSelectedInFocusedWindow(latest) && !await handoffSelectedRootFocus(latest, remaining)) ||
          latest.pinned || latest.pendingUrl || latest.status === 'loading' || latest.url !== row.url ||
          !exactHome(latest.url) || concreteConversationForTab(latest) || !ownsDocument(source)) {
        noteRootRetention(tab, source, 'tab changed during cleanup', 'observed');
        continue;
      }
      if (!await retireAutomaticTab(tab.id, async () => {
        const currentProtection = await currentRootOpeningProtection(null);
        if (rootHasLocalOpeningOwner(tab.id, currentProtection.tabs)) return false;
        const finalTab = await chrome.tabs.get(tab.id);
        if (await rootIsSelectedInFocusedWindow(finalTab) &&
            !await handoffSelectedRootFocus(finalTab, remaining)) return false;
        const newest = await chrome.tabs.get(tab.id);
        // No await after the final ownership check. A delivery/catalog/control election that
        // lands while Chrome answers the tab/focus reads vetoes this removal.
        return !rootHasLocalOpeningOwner(tab.id, currentProtection.tabs) &&
          newest.active === finalTab.active && newest.windowId === finalTab.windowId &&
          !newest.pinned && !newest.pendingUrl && newest.status !== 'loading' &&
          newest.url === row.url && Boolean(exactHome(newest.url)) &&
          !concreteConversationForTab(newest) && ownsDocument(source);
      })) {
        noteRootRetention(tab, source, 'last browser tab retained', 'observed');
        continue;
      }
      if (cleanConversationId(tabConversations[key])) delete tabConversations[key];
      remaining = remaining.filter(entry => entry.id !== tab.id);
      delete idleRootTabs[key];
      clearRootRetentionDiagnostic(tab.id);
      changed = true;
      console.info('[Chat On Steroids] closed unused plain ChatGPT home tab after bounded idle time',
        tab.id, Math.floor((now - candidate.idleSince) / 60_000));
    } catch {
      // Missing page proof, a changed document or a Chrome API failure never grants closure.
      noteRootRetention(tab, source, 'Chrome inventory unavailable', 'observed');
    }
  }
  if (changed) await persistLive().catch(() => undefined);
  return remaining;
}

function prepareDesktopInputReceipt(tabId, id, documentId) {
  // The content-side maximum is 13s: sidebar, New Chat, then Work -> Chat.
  // Timeout keeps `preparing` custody; it never authorizes another tab or Send.
  return tabReply(tabId, { type: 'clf-prepare-desktop-input', id }, { documentId }, 15000);
}

function temporaryPlannerCloseProofMatches(value, id, proof) {
  try {
    const url = new URL(String(value || ''));
    if (url.origin === 'https://chatgpt.com' && url.pathname === '/' && !url.search && !url.hash) {
      return proof?.temporary === true && proof?.conversationId === null;
    }
    if (url.origin === 'https://chatgpt.com' && !url.search && !url.hash &&
        proof?.temporary === true && proof?.conversationId && conversationFromUrl(url.href) === proof.conversationId) return true;
    if (url.searchParams.get('temporary-chat') !== 'true') return false;
    if (url.searchParams.get('cos-input') === id) return true;
    const conversationId = conversationFromUrl(url.href);
    return conversationId !== null && proof?.conversationId === conversationId;
  } catch {
    return false;
  }
}

async function temporaryHelperOutputSaved(id, owner, conversationId, source) {
  if (!ownsDocument(source) || typeof owner !== 'string') return false;
  const result = await call('/input/output', { method: 'POST',
    body: JSON.stringify({ id, owner, conversationId }) }, false, () => ownsDocument(source));
  return ownsDocument(source) && result.ok && result.data?.ok === true;
}

/**
 * Retires only an app-elected helper document that is freshly proven disposable.
 * ChatGPT strips cos-input after assigning a Temporary Chat its /c/<id> route, so routed
 * helpers use the retained accepted-decision receipt while untouched roots keep the generic
 * empty-page proof. Document/epoch, pin, draft and foreground-window fences remain mandatory.
 */
async function cleanupRetiredInputTabs(elections, activeIds) {
  const now = Date.now();
  if (now - lastRetiredInputSweepAt < RETIRED_INPUT_SWEEP_MS) return;
  lastRetiredInputSweepAt = now;
  const active = new Set(Array.isArray(activeIds) ? activeIds : []);
  const activeTabs = new Set(Object.entries(elections)
    .filter(([id, row]) => active.has(id) && Number.isInteger(row?.tab))
    .map(([, row]) => row.tab));
  const stoppedTabs = new Set(Object.values(stopOpenings).map(row => row?.tab).filter(Number.isInteger));
  const pluginOwner = (await chrome.storage.session.get('pluginRefreshOwner')).pluginRefreshOwner;
  const backgroundWindow = await storedBackgroundWindow();
  let changed = false;
  for (const [id, row] of Object.entries(elections)) {
    if (row?.stage !== 'retired' || !Number.isInteger(row.tab) || !Number.isFinite(row.retiredAt) ||
        now - row.retiredAt < RETIRED_INPUT_TAB_GRACE_MS) continue;
    if (activeTabs.has(row.tab) || stoppedTabs.has(row.tab) || modelCatalogTarget?.tab === row.tab || pluginOwner?.tab === row.tab) continue;
    const tab = await chrome.tabs.get(row.tab).catch(() => null);
    if (!tab) { delete elections[id]; changed = true; continue; }
    if (tab.pinned || tab.pendingUrl || (tab.active && tab.windowId !== backgroundWindow?.id)) continue;
    let url;
    try { url = new URL(tab.url || ''); } catch { continue; }
    const chatHome = (url.origin === 'https://chatgpt.com' || url.origin === 'https://chat.openai.com') &&
      url.pathname === '/' && !url.search && !url.hash && conversationFromUrl(tab.url) === null;
    const markedTemporary = url.origin === 'https://chatgpt.com' && url.pathname === '/' &&
      url.searchParams.get('temporary-chat') === 'true' && url.searchParams.get('cos-input') === id;
    const routedTemporary = row.temporary === true && typeof row.owner === 'string' && row.owner.length > 0 &&
      conversationFromUrl(tab.url) !== null && (url.searchParams.get('temporary-chat') === 'true' ||
        (!url.search && !url.hash && conversationFromUrl(tab.url) === row.conversationId));
    if (!chatHome && !markedTemporary && !routedTemporary) continue;
    const source = { tab: tab.id, documentId: tabDocuments[String(tab.id)], navigationEpoch: tabEpochs[String(tab.id)] };
    if (!ownsDocument(source)) continue;
    try {
      if (typeof row.owner === 'string' && !await temporaryHelperOutputSaved(id, row.owner, conversationFromUrl(tab.url), source)) continue;
      const proof = await tabReply(tab.id, routedTemporary
        ? { type: 'clf-close-temporary-planner', id, owner: row.owner }
        : { type: 'clf-tab-close-check', conversationId: null, temporaryHelper: true }, { documentId: source.documentId });
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      const targetStillExact = routedTemporary
        ? temporaryPlannerCloseProofMatches(current?.url, id, proof)
        : proof?.conversationId === null && current?.url === tab.url;
      if (proof?.safe !== true || !targetStillExact || proof.navigationEpoch !== source.navigationEpoch ||
          !ownsDocument(source) || !current || current.pinned || current.pendingUrl || current.url !== tab.url ||
          (current.active && current.windowId !== backgroundWindow?.id)) continue;
      if (!await retireAutomaticTab(tab.id)) continue;
      delete elections[id]; changed = true;
      console.info('[Chat On Steroids] closed abandoned temporary helper tab', tab.id);
    } catch { /* a missing proof leaves the tab and its cleanup custody intact */ }
  }
  if (changed) await persistLive();
}

const desktopInputReceiverRepairs = new Map();

function repairDesktopInputReceiver(tabId, repairAction = () => restoreChatgptTab(tabId)) {
  const existing = desktopInputReceiverRepairs.get(tabId);
  if (existing) return existing;
  const repair = Promise.resolve().then(repairAction)
    .catch(() => false)
    .finally(() => {
      if (desktopInputReceiverRepairs.get(tabId) === repair) desktopInputReceiverRepairs.delete(tabId);
    });
  desktopInputReceiverRepairs.set(tabId, repair);
  return repair;
}

/** Proves execution support in the exact loaded document, not the worker's release string. */
async function freshTurnReceiverReady(tab) {
  const source = { tab: tab?.id, documentId: tabDocuments[String(tab?.id)], navigationEpoch: tabEpochs[String(tab?.id)] };
  const conversation = conversationForTab(tab);
  const current = async () => {
    if (!conversation || !ownsDocument(source)) return false;
    const held = await chrome.tabs.get(source.tab).catch(() => null);
    return ownsDocument(source) && held && !held.pendingUrl && held.status !== 'loading' &&
      conversationForTab(held) === conversation;
  };
  const capable = async () => {
    if (!await current()) return false;
    const proof = await tabReply(source.tab, { type: 'clf-recorder-ping' }, { documentId: source.documentId }).catch(() => null);
    return proof?.ok === true && proof.recorderVersion === PAGE_RECORDER_VERSION &&
      proof.freshTurnProtocol === 1 && proof.requiredFeatures?.promptEnvelope === true &&
      proof.requiredFeatures?.nativeAllowOnce === true && await current();
  };
  try {
    if (await capable()) return true;
    if (!await current() || !await repairDesktopInputReceiver(source.tab)) return false;
    // Injection is not readiness: the original source document must answer for itself.
    return await capable();
  } catch { return false; }
}

const FRESH_TURN_INVENTORY_TIMEOUT_MS = 6000;
let freshTurnInventoryTimeoutReported = false;
async function freshTurnInventoryProtocol(tabs) {
  const sources = tabs.filter(tab => conversationForTab(tab));
  if (!sources.length) return undefined;
  let timer;
  try {
    // A Chrome script repair may remain pending in an old renderer. Keep that exact
    // repair owner, but do not let its capability observation starve /status and
    // unrelated queued work. Timeout means capability UNKNOWN, never ready or unsent.
    const ready = await Promise.race([
      Promise.all(sources.map(freshTurnReceiverReady)),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), FRESH_TURN_INVENTORY_TIMEOUT_MS); })
    ]);
    if (ready === null) {
      if (!freshTurnInventoryTimeoutReported)
        console.info('[Chat On Steroids] fresh-turn readiness timed out; status continues with capability unverified and receiver custody retained');
      freshTurnInventoryTimeoutReported = true;
      return undefined;
    }
    freshTurnInventoryTimeoutReported = false;
    return ready.every(Boolean) ? 1 : undefined;
  } finally { clearTimeout(timer); }
}

/** One reload of the same pristine helper, inside the incumbent receiver repair flight. */
async function reloadUnclaimedTemporaryInput(tabId, message) {
  const expiresAt = message.preclaimRecovery?.expiresAt;
  if (message.lifetime !== 'temporary-planner' || message.conversationId !== null ||
      !/^[a-f0-9-]{36}$/i.test(message.id || '') || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  let opening = inputOpenings[message.id];
  let consumed = false;
  if (!opening || opening.tab !== tabId || opening.stage !== 'ready' || opening.preclaimReloaded === true ||
      opening.browserGeneration !== commandLeaseGeneration) return false;
  const connection = { epoch: connectionEpoch, instanceId, port, token, browserId };
  const source = { tab: tabId, documentId: tabDocuments[String(tabId)], navigationEpoch: tabEpochs[String(tabId)] };
  if (typeof source.documentId !== 'string' || !source.documentId || !Number.isSafeInteger(source.navigationEpoch) || source.navigationEpoch < 0) return false;
  const admission = conversationAdmission(source);
  const receiverRepair = desktopInputReceiverRepairs.get(tabId);
  if (!receiverRepair) return false;
  const current = () => desktopInputReceiverRepairs.get(tabId) === receiverRepair && receiverRepair.preclaimPolicyHeld !== true &&
    Boolean(token && port && instanceId) && !disconnected && !pairing && admission() &&
    connectionEpoch === connection.epoch && instanceId === connection.instanceId && port === connection.port &&
    token === connection.token && browserId === connection.browserId && ownsDocument(source) &&
    inputOpenings[message.id] === opening && opening.tab === tabId && opening.stage === 'ready' &&
    (opening.preclaimReloaded === true) === consumed &&
    opening.browserGeneration === commandLeaseGeneration && Date.now() < expiresAt;
  const marked = tab => {
    if (!tab || tab.pinned || tab.pendingUrl || tab.status !== 'complete') return false;
    try {
      const url = new URL(tab.url);
      return url.origin === 'https://chatgpt.com' && url.pathname === '/' &&
        url.searchParams.get('temporary-chat') === 'true' && url.searchParams.get('cos-input') === message.id &&
        new URLSearchParams(url.hash.slice(1)).get('cos-input') === message.id;
    } catch { return false; }
  };
  if (!current()) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!current() || !marked(tab)) return false;
  const page = async () => {
    if (!current()) return null;
    const state = await tabReply(tabId, { type: 'clf-page-status', preclaimInputId: message.id }, { documentId: source.documentId });
    const proof = state?.temporaryInputPreclaim;
    return current() && state?.ok === true && state.epoch === source.navigationEpoch && proof?.id === message.id &&
      proof.safe === true && proof.url === tab.url && Number.isSafeInteger(proof.progressRevision) && Number.isSafeInteger(proof.stopRevision) ? proof : null;
  };
  const main = async () => {
    if (!current()) return false;
    const result = await call('/input/output', { method: 'POST', body: JSON.stringify({
      id: message.id, owner: tabId + ':' + source.documentId + ':' + source.navigationEpoch,
      conversationId: null, inspectPreclaim: true
    }) }, false, current);
    return current() && result.ok && result.data?.ok === true && result.data.preclaimRecovery?.expiresAt === expiresAt;
  };
  const before = await page();
  if (!before || !await main() || !current()) return false;
  // Spend before storage/Chrome awaits. MV3 restart cannot grant this UUID another reload.
  inputOpenings[message.id] = opening = { ...opening, preclaimReloaded: true };
  consumed = true;
  await persistLive();
  console.info('[Chat On Steroids] persisted one preclaim helper reload attempt; rechecking original custody', tabId, message.id);
  if (!current() || !await main()) return false;
  const latest = await chrome.tabs.get(tabId).catch(() => null);
  if (!current() || !marked(latest) || latest.url !== tab.url) return false;
  // The far-side composer/activity proof is the last await before invoking Chrome reload.
  const after = await page();
  if (!after || after.progressRevision !== before.progressRevision || after.stopRevision !== before.stopRevision ||
      !current() || !marked(latest) || latest.url !== tab.url) return false;
  await chrome.tabs.reload(tabId);
  console.info('[Chat On Steroids] reloaded exact never-claimed temporary helper once', tabId, message.id);
  return true;
}

function offerDesktopInput(tabId, message, freshTurn = false) {
  if (desktopInputReceiverRepairs.has(tabId)) return;
  // The reply is not a delivery receipt: the content script synchronously owns
  // one desktopInputBusy slot, then the app's durable browser claim and one-time
  // sendAuthorizedAt fence every later offer. Waiting here only starves repairs.
  // A Chrome extension reload can leave an already-open ChatGPT document with an orphaned
  // isolated world: the page and exact COS UUID remain visible, but runtime messaging has no
  // receiver. The old fire-and-forget catch turned that concrete state into three minutes of
  // silent helper timeout. Repair only that same elected tab, then re-offer the same durable
  // UUID once. Main still owns claim/send authorization, so this cannot duplicate a delivery.
  const offer = async () => {
    if (freshTurn) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !await freshTurnReceiverReady(tab)) return;
    }
    const reply = await chrome.tabs.sendMessage(tabId, message);
    // Only this explicit pre-claim rejection proves the DOM bundle is incompatible.
    // Other negative replies may own an attempted Send and must never be reoffered.
    if (reply?.ok === false && reply.error === 'dom_adapter_unready') throw new Error('dom_adapter_unready');
    if (reply?.ok === false && !reply.error && message.lifetime === 'temporary-planner' && message.preclaimRecovery)
      await repairDesktopInputReceiver(tabId, () => reloadUnclaimedTemporaryInput(tabId, message));
    return reply;
  };
  void offer().catch(async () => {
    if (!await repairDesktopInputReceiver(tabId)) return;
    try {
      await offer();
      console.info('[Chat On Steroids] repaired desktop input receiver', tabId, message.id);
    } catch {
      // The exact tab may have navigated or closed during repair. Its durable input remains
      // queued and ordinary maintenance will reconsider it without spending another opening.
    }
  });
}

async function deliverDesktopInputs(inputs, background, reusableConversations = [], activeIds, openingBudget = 1) {
  if (!Array.isArray(inputs)) return 0;
  let openingsSpent = 0;
  // A page-confirmed pre-Send receipt owns this exact UUID until Main has accepted or
  // definitively rejected that receipt. Main may already have re-armed the durable row while
  // the HTTP response back to this worker was lost. Re-offering the UUID before this journal
  // entry retires could let the stale proof match a newer claim in the same still-live document.
  // Keep using the existing receipt journal as the sole custody fence; no second lease/state.
  const pendingPreSendReleaseIds = new Set(commandAckOutbox
    .filter(entry => entry?.kind === 'input-unsent' && typeof entry.id === 'string')
    .map(entry => entry.id));
  const terminalTemporary = new Map(inputs.filter(input => input?.close === true && input?.lifetime === 'temporary-planner')
    .map(input => [input.id, input]));
  for (const [id, terminal] of terminalTemporary) {
    const row = inputOpenings[id];
    if (row && Number.isInteger(row.tab)) inputOpenings[id] = {
      ...row, stage: 'retired', retiredAt: Number.isFinite(row.retiredAt) ? row.retiredAt : Date.now(),
      temporary: true, owner: terminal.owner || row.owner, conversationId: terminal.conversationId || row.conversationId
    };
  }
  // Only the app's complete outbox projection retires spent opening authority.
  if (Array.isArray(activeIds)) {
    const active = new Set(activeIds);
    for (const id of Object.keys(inputOpenings)) {
      if (active.has(id) || inputOpenings[id]?.stage === 'retired') continue;
      delete inputOpenings[id];
    }
    await persistLive();
  }
  if (!inputs.length) { await cleanupRetiredInputTabs(inputOpenings, activeIds); return 0; }
  let tabs = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
  const elections = inputOpenings;
  const elect = async (id, record) => {
    elections[id] = {
      ...(elections[id] || {}),
      ...record,
      // Numeric Chrome tab ids are scoped to one whole-browser lifetime. Reuse the same
      // generation that already fences command tab leases so an input election can survive
      // MV3 suspension/reload without mistaking a recycled id after browser restart for its
      // original document.
      browserGeneration: commandLeaseGeneration,
      electedAt: Date.now()
    };
    await persistLive();
  };
  const matchesInput = (input, tab) => {
    if (!input || !/^[a-f0-9-]{36}$/i.test(input.id)) return false;
    const target = cleanConversationId(input.conversationId);
    if (target) return conversationForTab(tab) === target;
    try {
      const url = new URL(tab.pendingUrl || tab.url || '');
      return url.searchParams.get('cos-input') === input.id || new URLSearchParams(url.hash.slice(1)).get('cos-input') === input.id;
    } catch { return false; }
  };
  for (const input of inputs.slice(0, 50)) {
    if (!input || !/^[a-f0-9-]{36}$/i.test(input.id) || pendingPreSendReleaseIds.has(input.id)) continue;
    const target = cleanConversationId(input.conversationId);
    const marker = `cos-input=${encodeURIComponent(input.id)}`;
    const candidates = tabs.filter(tab => !commandOwnedOpeningTab(tab) && matchesInput(input, tab));
    // A duplicate can survive long enough for both copies to match. Prefer the page the user is
    // actually using; lowest tab id is only the stable fallback when neither is selected.
    const firstCandidate = candidates.sort((a, b) => Number(b.active === true) - Number(a.active === true) || a.id - b.id)[0];
    let tab = firstCandidate;
    let elected = elections[input.id];
    const projectInput = !target && typeof input.project === 'string' && /^g-p-[0-9a-f]{32}$/.test(input.project)
      ? input.project : null;
    // A retry may link this input to a different native Project. The old tab election remains
    // spent on its old Project and can never become authority for the replacement.
    if (projectInput && elected && elected.project !== projectInput) {
      delete elections[input.id];
      await persistLive();
      elected = null;
    }
    if (elected?.browserGeneration && elected.browserGeneration !== commandLeaseGeneration) {
      // A whole Chrome restart invalidates numeric tab identity. Keep the app's durable
      // pre-Send input. Adopt an exact restored target immediately; otherwise turn the stale
      // numeric affinity into the existing pre-create lease so Chrome gets one hydration window
      // before this operation is allowed to spend its single replacement opening.
      await elect(input.id, firstCandidate
        ? { tab: firstCandidate.id, stage: 'ready', conversationId: target, ...(projectInput ? { project: projectInput } : {}) }
        : { tab: null, ...(projectInput ? { project: projectInput } : {}) });
      elected = elections[input.id];
      tab = firstCandidate;
    }
    let recoveredReuse = null;
    // A queued checkpoint follows the app's durable session rebind. Transfer only
    // to an already-existing successor tab, never reopen a closed elected target.
    if (target && cleanConversationId(input.supersededConversationId) &&
        input.supersededConversationId !== target && elected && elected.conversationId !== target && tab) {
      await elect(input.id, { tab: tab.id, stage: 'ready', conversationId: target });
      elected = elections[input.id];
    }
    if (elected?.tab != null) {
      tab = candidates.find(candidate => candidate.id === elected.tab);
      // ChatGPT may consume the cos-input marker while hydrating the elected page. The
      // persisted ready election still owns that exact browser tab, but it must never adopt
      // a tab that has since become a different concrete conversation.
      if (!tab && elected.stage === 'ready' && input.lifetime !== 'temporary-planner') {
        const candidate = tabs.find(row => row.id === elected.tab);
        const hosted = conversationFromUrl(candidate?.url) || conversationFromUrl(candidate?.pendingUrl);
        // A marker-less root is still the elected document for a fresh-chat input, but it is
        // never proof that a named conversation survived ChatGPT's redirect. The named case
        // must enter the exact empty-root proof/retarget path below before any prompt is offered.
        const hostedProject = projectFromUrl(candidate?.url) || projectFromUrl(candidate?.pendingUrl);
        if (candidate && (target ? hosted === target : projectInput ? hostedProject === projectInput : !hosted)) tab = candidate;
      }
    }
    // A ready tab for a linked Project that has finished on the bare ChatGPT home is provider
    // evidence that the Project is gone. Report that exact input/link instead of offering its
    // message at root or multiplying tabs.
    if (projectInput && !tab && elected?.stage === 'ready' && elected.project === projectInput && Number.isInteger(elected.tab)) {
      const landed = tabs.find(row => row.id === elected.tab);
      let home = false;
      try {
        const url = new URL(landed?.url || '');
        home = url.origin === 'https://chatgpt.com' && url.pathname === '/' && !url.search && !url.hash;
      } catch { /* non-ChatGPT routes are not Project-gone evidence */ }
      if (landed && !landed.pendingUrl && landed.status === 'complete' && home) {
        const source = { tab: landed.id, documentId: tabDocuments[String(landed.id)], navigationEpoch: tabEpochs[String(landed.id)] };
        if (!ownsDocument(source)) continue;
        const result = await call('/project-create', { method: 'POST', body: JSON.stringify({
          action: 'gone', inputId: input.id, chatgptId: projectInput, client: source.documentId
        }) });
        if (result.ok && result.data?.ok) delete elections[input.id];
        continue;
      }
    }
    // A prepare receipt can be lost after its exact document changes nothing. Do
    // not replay from elapsed time: only the still-elected, still-owned document
    // can prove that it is idle again and therefore no old preparation is live.
    if (!tab && !target && elected?.stage === 'preparing' && Number.isInteger(elected.tab)) {
      const candidate = tabs.find(row => row.id === elected.tab);
      const reusable = new Set(reusableConversations);
      // A completed conversation registry entry can survive New Chat and an
      // extension reload. Only a concrete current/pending /c URL may protect a
      // different conversation here; an unmarked home must reach the exact
      // document/epoch/idle probe instead of deadlocking on stale metadata.
      const concreteConversation = conversationFromUrl(candidate?.url) || conversationFromUrl(candidate?.pendingUrl);
      if (candidate) {
        if (candidate.pinned || candidate.pendingUrl || modelCatalogTarget?.tab === candidate.id ||
            commandOwnedOpeningTab(candidate) ||
            (concreteConversation && !reusable.has(concreteConversation))) continue;
        const source = { tab: candidate.id, documentId: tabDocuments[String(candidate.id)], navigationEpoch: tabEpochs[String(candidate.id)] };
        if (!ownsDocument(source)) continue;
        const proof = await inputReuseProbe(candidate.id, source.documentId);
        const current = await chrome.tabs.get(candidate.id).catch(() => null);
        if (proof?.safe !== true || proof.navigationEpoch !== source.navigationEpoch || !ownsDocument(source) ||
            !current || current.pinned || current.pendingUrl || current.url !== candidate.url ||
            commandOwnedOpeningTab(current)) continue;
        // Logically clear this pass for one same-tab retry while the durable row
        // remains custody if the document changes before preparation begins.
        elected = null;
        recoveredReuse = source;
      }
    }
    if (input.close === true && input.lifetime === 'temporary-planner') {
      if (!tab || tab.pinned) continue;
      const documentId = tabDocuments[String(tab.id)];
      const source = { tab: tab.id, documentId, navigationEpoch: tabEpochs[String(tab.id)] };
      try {
        if (!await temporaryHelperOutputSaved(input.id, input.owner, conversationFromUrl(tab.url), source)) continue;
        const proof = await tabReply(tab.id, { type: 'clf-close-temporary-planner', id: input.id, owner: input.owner, accepted: true }, { documentId });
        const current = await chrome.tabs.get(tab.id);
        if (proof?.safe === true && proof.navigationEpoch === source.navigationEpoch && ownsDocument(source) &&
            !current.pinned && !current.pendingUrl && temporaryPlannerCloseProofMatches(current.url, input.id, proof)) {
          await retireAutomaticTab(tab.id);
        }
      } catch { /* only the exact still-owned temporary document may close */ }
      continue;
    }
    // Rotation can only use the exact existing source document with executable support.
    // Unknown/busy old recorders retain the same queued UUID, without opening or claiming it.
    if (input.purpose === 'rotation' && (!tab || !await freshTurnReceiverReady(tab))) continue;
    // An existing target spends the same opening authority as a newly created tab.
    // A later user-close or duplicate document cannot transfer that election.
    if (tab && (!elected || elected.tab == null)) {
      await elect(input.id, { tab: tab.id, stage: 'ready', conversationId: target,
        ...(projectInput ? { project: projectInput } : {}) });
      elected = elections[input.id];
    }
    if (!tab) {
      // The app publishes only inputs that are still safely pre-Send. If the exact elected
      // Chrome tab no longer exists, its document cannot still type or send; release that
      // browser-only election and open one replacement. A surviving tab that merely changed
      // URL remains fenced unless its exact app-owned document proves empty below.
      if (elections[input.id] && !recoveredReuse) {
        const electedTab = Number.isInteger(elected?.tab)
          ? tabs.find(candidate => candidate.id === elected.tab)
          : null;
        if (electedTab) {
          // ChatGPT may replace an exact /c/<id> navigation with its plain home route while the
          // durable app input still owns that exact tab. The former permanent fence left the row
          // in "preparing/checking Chrome" forever. Reclaim the same page only after its current
          // content script proves that it is an empty app-owned document; never type blind and
          // never open a second tab while this one is recoverable.
          const elapsed = Date.now() - (Number(elected?.electedAt) || 0);
          const strippedPlainHelper = exactPlainChatHome(electedTab.url);
          const strippedTemporaryHelper = exactUnmarkedTemporaryChatHome(electedTab.url);
          if (!target && input.lifetime === 'temporary-planner' && !electedTab.pendingUrl &&
              (strippedPlainHelper || strippedTemporaryHelper) && elapsed >= INPUT_OPENING_LEASE_MS) {
            // ChatGPT sometimes consumes both helper markers while leaving the elected tab on
            // its empty home page. The durable input still owns this exact tab, but without the
            // markers content.js cannot identify it as a Temporary Chat helper and therefore
            // never claims or inserts the prompt. Re-author the same tab only after its current
            // registered document proves completely idle. This preserves the single election,
            // avoids the duplicate-window retry storm, and never writes into a user draft.
            const source = {
              tab: electedTab.id,
              documentId: tabDocuments[String(electedTab.id)],
              navigationEpoch: tabEpochs[String(electedTab.id)]
            };
            if (ownsDocument(source)) {
              // Use the helper-specific empty-document proof for both route shapes. ChatGPT can
              // strip *both* query markers while retaining native Temporary Chat state. The
              // generic reuse probe intentionally rejects that state, so selecting it from the
              // now-plain URL strands the exact helper until Main's three-minute timeout. This
              // close proof has the same strict draft/attachment/generation/document fences, but
              // does not confuse native Temporary Chat state with an unsafe personal home.
              const proof = await tabReply(electedTab.id,
                { type: 'clf-tab-close-check', conversationId: null },
                { documentId: source.documentId });
              const current = await chrome.tabs.get(electedTab.id).catch(() => null);
              if (proof?.safe === true && proof.navigationEpoch === source.navigationEpoch &&
                  (!strippedTemporaryHelper || proof.conversationId === null) &&
                  ownsDocument(source) && current && !current.pinned && !current.pendingUrl &&
                  current.url === electedTab.url &&
                  (exactPlainChatHome(current.url) || exactUnmarkedTemporaryChatHome(current.url))) {
                // Do not navigate the same marker again. ChatGPT can consume the query/hash a
                // second time before the isolated content script sees it, leaving another blank
                // document and an endless URL-restoration loop. The service worker already owns
                // this exact election and just re-proved this exact document empty, so hand the
                // durable UUID directly to that document. content.js independently requires the
                // unchanged plain/Temporary home, zero turns, Temporary Chat proof and the usual
                // claim/authorization/Send receipts before it may touch the composer.
                await elect(input.id, { tab: electedTab.id, stage: 'ready', conversationId: null });
                offerDesktopInput(electedTab.id, {
                  type: 'clf-desktop-input',
                  id: input.id,
                  conversationId: null,
                  lifetime: input.lifetime,
                  strippedTemporaryHelper: true
                });
                console.info('[Chat On Steroids] handed stripped temporary helper to its elected document',
                  electedTab.id, input.id);
              }
            }
          }
          if (target && !electedTab.pendingUrl && exactPlainChatHome(electedTab.url) &&
              elapsed >= INPUT_OPENING_LEASE_MS) {
            let opening = appOwnedOpeningTabs[String(electedTab.id)];
            if (cleanConversationId(opening?.conversationId) !== target) {
              await rememberOpenConversationTab(electedTab, { conversationId: target, requestId: input.id });
              opening = appOwnedOpeningTabs[String(electedTab.id)];
            }
            const emptyRoot = cleanConversationId(opening?.conversationId) === target
              ? await proveEmptyRedirectedConversationRoot(electedTab, opening, input.id)
              : null;
            if (emptyRoot) {
              opening.openState = 'opening';
              opening.createdAt = Date.now();
              await chrome.storage.session.set({ appOwnedOpeningTabs });
              const updated = await chrome.tabs.update(electedTab.id, {
                url: `https://chatgpt.com/c/${encodeURIComponent(target)}`
              });
              await elect(input.id, { tab: electedTab.id, stage: 'opening', conversationId: target });
              tabs = tabs.map(candidate => candidate.id === electedTab.id
                ? { ...candidate, ...updated }
                : candidate);
            }
          }
          continue;
        }
        if (elected?.tab === null && Date.now() - (Number(elected.electedAt) || 0) < INPUT_OPENING_LEASE_MS) {
          continue;
        }
        // The app still proves this input is pre-Send. Prefer an already-open exact
        // marker/conversation over creating another tab; otherwise release custody so
        // the single ordinary opening path below can replace the vanished document.
        if (firstCandidate) {
          await elect(input.id, { tab: firstCandidate.id, stage: 'ready', conversationId: target });
          elected = elections[input.id];
          tab = firstCandidate;
        } else {
          delete elections[input.id];
          await persistLive();
          elected = null;
        }
      }
      if (tab) {
        offerDesktopInput(tab.id, { type: 'clf-desktop-input', id: input.id, conversationId: target,
          ...(projectInput ? { project: projectInput } : {}),
          ...(input.silenceTurnId ? { silenceTurnId: input.silenceTurnId } : {}),
          ...(input.directTurn ? { directTurn: input.directTurn } : {}), ...(input.lifetime ? { lifetime: input.lifetime } : {}),
          ...(input.preclaimRecovery ? { preclaimRecovery: input.preclaimRecovery } : {}) });
        continue;
      }
      if (Object.keys(elections).length >= 1000) continue;
      const url = target ? `https://chatgpt.com/c/${encodeURIComponent(target)}`
        : projectInput ? `https://chatgpt.com/g/${projectInput}/project?${marker}#${marker}`
        : `https://chatgpt.com/?${input.lifetime === 'temporary-planner' ? 'temporary-chat=true&' : ''}${marker}#${marker}`;
      if (!target && !projectInput && input.lifetime !== 'temporary-planner') {
        const reusable = new Set(reusableConversations);
        // Do not serially probe hundreds of overloaded tabs. A missing content-script reply can
        // cost three seconds; after a few exact safe-reuse attempts, one bounded fresh opening is
        // both cheaper and more reliable than holding the user's queue for minutes.
        const choices = tabs.filter(candidate => !candidate.pinned && !candidate.pendingUrl &&
          modelCatalogTarget?.tab !== candidate.id && !commandOwnedOpeningTab(candidate) &&
          (recoveredReuse ? candidate.id === recoveredReuse.tab :
            (!conversationForTab(candidate) || reusable.has(conversationForTab(candidate)))))
          .sort((a, b) => Number(!!conversationForTab(a)) - Number(!!conversationForTab(b)) || a.id - b.id)
          .slice(0, input.userRequested === true ? 3 : 8);
        for (const candidate of choices) {
          const source = { tab: candidate.id, documentId: tabDocuments[String(candidate.id)], navigationEpoch: tabEpochs[String(candidate.id)] };
          if (!ownsDocument(source)) continue;
          const proof = recoveredReuse?.tab === source.tab && recoveredReuse.documentId === source.documentId && recoveredReuse.navigationEpoch === source.navigationEpoch
            ? { safe: true, navigationEpoch: source.navigationEpoch }
            : await inputReuseProbe(candidate.id, source.documentId);
          const current = await chrome.tabs.get(candidate.id).catch(() => null);
          if (proof?.safe !== true || proof.navigationEpoch !== source.navigationEpoch || !ownsDocument(source) ||
              !current || current.pinned || current.pendingUrl || current.url !== candidate.url ||
              commandOwnedOpeningTab(current)) continue;
          await elect(input.id, { tab: candidate.id, stage: 'preparing' });
          const owner = (await chrome.storage.session.get('modelCatalogOwner')).modelCatalogOwner;
          if (owner?.tab === candidate.id) await chrome.storage.session.set({ modelCatalogOwner: { ...owner, handedToInput: input.id } });
          const prepared = await prepareDesktopInputReceipt(candidate.id, input.id, source.documentId);
          const latest = await chrome.tabs.get(candidate.id).catch(() => null);
          if (!latest || latest.pendingUrl || tabDocuments[String(candidate.id)] !== source.documentId) break;
          if (prepared?.ready === true && matchesInput(input, latest)) {
            await elect(input.id, { tab: candidate.id, stage: 'ready' });
            tab = latest;
            offerDesktopInput(tab.id, { type: 'clf-desktop-input', id: input.id, conversationId: null });
          } else if (prepared?.fallback === true && prepared.preSend === true) {
            // Explicit native transition failure, before claim/insertion/send, owns
            // exactly one replacement. Persist that expenditure before Chrome awaits.
            if (openingsSpent >= openingBudget) continue;
            openingsSpent += 1;
            await elect(input.id, { tab: null, stage: 'opening', fallbackUsed: true });
            tab = await createChatTab(url, background);
            await elect(input.id, { tab: tab.id, stage: 'ready', fallbackUsed: true });
            tabs.push(tab);
            // A failed New Chat transition can leave the borrowed managed page
            // empty. Its conversation ownership is gone, so ordinary pruning can
            // never retire it. The same preparation owns this exact one-hop home;
            // close it only after the replacement exists and a fresh draft check.
            if (reusable.has(conversationFromUrl(candidate.url)) && latest.url === 'https://chatgpt.com/' &&
                tabEpochs[String(candidate.id)] === source.navigationEpoch + 1) {
              const abandoned = { ...source, navigationEpoch: source.navigationEpoch + 1 };
              try {
                const proof = await tabReply(candidate.id, { type: 'clf-tab-close-check', conversationId: null }, { documentId: source.documentId });
                const current = await chrome.tabs.get(candidate.id);
                if (proof?.safe === true && proof.conversationId === null && proof.navigationEpoch === abandoned.navigationEpoch &&
                    ownsDocument(abandoned) && current && !current.pinned && !current.pendingUrl && current.url === 'https://chatgpt.com/') {
                  if (await retireAutomaticTab(candidate.id)) tabs = tabs.filter(row => row.id !== candidate.id);
                }
              } catch { /* A draft, navigation or missing proof keeps the document. */ }
            }
          }
          break;
        }
        if (elections[input.id]) continue;
      }
      if (openingsSpent >= openingBudget) continue;
      openingsSpent += 1;
      await elect(input.id, { tab: null, stage: 'opening', conversationId: target,
        ...(projectInput ? { project: projectInput } : {}) });
      tab = await createChatTab(url, background, !background,
        target ? { conversationId: target, requestId: input.id } : null);
      await elect(input.id, { tab: tab.id, stage: 'ready', conversationId: target,
        ...(projectInput ? { project: projectInput } : {}) });
      tabs.push(tab);
      continue;
    }
    offerDesktopInput(tab.id, { type: 'clf-desktop-input', id: input.id, conversationId: target,
      ...(projectInput ? { project: projectInput } : {}),
      ...(input.silenceTurnId ? { silenceTurnId: input.silenceTurnId } : {}),
      ...(input.directTurn ? { directTurn: input.directTurn } : {}), ...(input.lifetime ? { lifetime: input.lifetime } : {}),
      ...(input.preclaimRecovery ? { preclaimRecovery: input.preclaimRecovery } : {}) },
      input.purpose === 'rotation');
  }
  await cleanupRetiredInputTabs(elections, activeIds);
  return openingsSpent;
}

// A read-only catalog inspection must never hold the recovery maintenance flight.
const stopOffers = new Set();
async function offerStopTurns(requests, background = false) {
  if (!Array.isArray(requests)) return;
  await load();
  for (const [id, row] of Object.entries(stopOpenings)) if (row.expiresAt <= Date.now()) delete stopOpenings[id];
  const offers = [];
  for (const request of requests.slice(0, 40)) {
    if (!request || !commandMarkerId(request.id) || !cleanConversationId(request.conversationId) ||
        typeof request.turnId !== 'string' || !request.turnId || request.turnId.length > 256 || stopOffers.has(request.id)) continue;
    stopOffers.add(request.id);
    offers.push((async () => {
      const current = () => !Number.isFinite(request.expiresAt) || request.expiresAt > Date.now();
      if (!current()) return;
      const tabs = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
      if (!current()) return;
      let election = stopOpenings[request.id];
      if (election && (election.conversationId !== request.conversationId || election.turnId !== request.turnId)) return;
      const matches = tab => conversationFromUrl(tab.pendingUrl || tab.url) === request.conversationId;
      let tab = election ? tabs.find(candidate => candidate.id === election.tab && matches(candidate)) : tabs.find(matches);
      if (!election) {
        // Old app versions may offer an existing document without an absolute lifetime.
        // They cannot authorize an opening that would outlive the owning Stop command.
        if (!Number.isFinite(request.expiresAt)) {
          if (!tab) return;
        } else {
          if (Object.keys(stopOpenings).length >= 1000) return;
          election = { tab: tab?.id ?? null, conversationId: request.conversationId, turnId: request.turnId, expiresAt: request.expiresAt };
          stopOpenings[request.id] = election;
          await persistLive();
          if (!current()) return;
          if (!tab) {
            // Spend before Chrome awaits; a lost creation reply must not open another tab.
            const opened = await createChatTab(`https://chatgpt.com/c/${encodeURIComponent(request.conversationId)}`, background);
            election.tab = opened.id;
            await persistLive();
            return; // the new document must register and adopt its exact native turn first
          }
        }
      }
      if (!tab) return;
      const key = String(tab.id), documentId = tabDocuments[key], navigationEpoch = tabEpochs[key];
      if (!documentId || tabConversations[key] !== request.conversationId) return;
      const source = { tab: tab.id, documentId, navigationEpoch };
      const latest = await chrome.tabs.get(tab.id);
      if (!current() || !ownsDocument(source) || latest.pendingUrl || conversationFromUrl(latest.url) !== request.conversationId) return;
      await chrome.tabs.sendMessage(tab.id, { type: 'clf-stop-turn', id: request.id,
        conversationId: request.conversationId, turnId: request.turnId }, { documentId });
    })().catch(() => undefined).finally(() => stopOffers.delete(request.id)));
  }
  await Promise.all(offers);
}

let modelCatalogFlight = null;
let modelCatalogTarget = null;
let pluginRefreshFlight = null;
function pluginRefreshRoute(url) {
  return url.pathname === '/' && /^#settings\/Plugins(?:\/plugin_asdk_app_[a-zA-Z0-9_-]+)?$/.test(url.hash) ||
    /^\/settings\/plugins-settings(?:\/plugin_asdk_app_[a-zA-Z0-9_-]+)?\/?$/.test(url.pathname) ||
    /^\/plugins(?:\/plugin_asdk_app_[a-zA-Z0-9_-]+)?\/?$/.test(url.pathname);
}
function pluginRefreshMarker(tab) {
  try {
    const url = new URL(tab?.pendingUrl || tab?.url || '');
    return url.origin === 'https://chatgpt.com' && pluginRefreshRoute(url)
      ? url.searchParams.get('cos-plugin-refresh') : null;
  } catch { return null; }
}
async function pluginRefreshBridgeOwner(source, id) {
  if (!ownsDocument(source)) return null;
  const tab = await chrome.tabs.get(source.tab).catch(() => null);
  if (!tab || tab.pendingUrl || tab.pinned) return null;
  let url;
  try { url = new URL(tab.url || ''); } catch { return null; }
  if (url.origin !== 'https://chatgpt.com' || !pluginRefreshRoute(url)) return null;
  const marker = pluginRefreshMarker(tab);
  const saved = (await chrome.storage.session.get('pluginRefreshOwner')).pluginRefreshOwner;
  if (!ownsDocument(source)) return null;
  // Once Main has persisted an exact owner, a second tab carrying the same URL marker cannot
  // inherit bridge authority. The saved tab/document/epoch remains authoritative even when the
  // provider SPA strips its query marker; every other document must wait for explicit turnover.
  if (saved?.id === id) {
    if (saved.tab !== source.tab || saved.documentId !== source.documentId ||
        saved.navigationEpoch !== source.navigationEpoch) return null;
    return marker === id || marker === null ? tab : null;
  }
  return marker === id ? tab : null;
}
async function pluginRefreshProbe(tabId, id, documentId) {
  if (!documentId) return null;
  return tabReply(tabId, { type: 'clf-plugin-refresh-state', id }, { documentId });
}
async function safeMarkedPluginRefreshTab(tab, id) {
  if (!tab || !Number.isInteger(tab.id) || tab.pinned || tab.pendingUrl || pluginRefreshMarker(tab) !== id) return null;
  const key = String(tab.id), documentId = tabDocuments[key], navigationEpoch = tabEpochs[key];
  if (!documentId || !Number.isSafeInteger(navigationEpoch) ||
      (await pluginRefreshProbe(tab.id, id, documentId))?.safe !== true) return null;
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  return current && !current.pinned && !current.pendingUrl && pluginRefreshMarker(current) === id &&
    tabDocuments[key] === documentId && tabEpochs[key] === navigationEpoch ? current : null;
}
let projectCreateFlight = null;
const PROJECT_CREATE_REOPEN_MS = 120_000;
function projectCreateMarker(tab) {
  try {
    const url = new URL(tab?.pendingUrl || tab?.url || '');
    if (url.origin !== 'https://chatgpt.com' || url.pathname !== '/') return null;
    return url.searchParams.get('cos-project-create') || new URLSearchParams(url.hash.slice(1)).get('cos-project-create');
  } catch { return null; }
}
function projectCreateRouteOwned(tab, owner) {
  return owner?.chatgptId
    ? projectFromUrl(tab?.pendingUrl) === owner.chatgptId || projectFromUrl(tab?.url) === owner.chatgptId
    : projectCreateMarker(tab) === owner?.id;
}
async function bindProjectCreateDocument(owner, tab) {
  if (!owner || !tab || owner.tab !== tab.id) return owner;
  if (owner.documentId) return owner;
  const key = String(tab.id);
  const source = { tab: tab.id, documentId: tabDocuments[key], navigationEpoch: tabEpochs[key] };
  if (!ownsDocument(source) || projectCreateMarker(tab) !== owner.id) return owner;
  const bound = { ...owner, documentId: source.documentId, navigationEpoch: source.navigationEpoch };
  await chrome.storage.session.set({ projectCreateOwner: bound });
  return bound;
}
function inspectProjectCreates(requests, dispatchAllowed = true) {
  if (projectCreateFlight) return projectCreateFlight;
  let asked = false;
  projectCreateFlight = (async () => {
    const list = (Array.isArray(requests) ? requests : [])
      .filter(request => request && /^[a-f0-9-]{36}$/i.test(String(request.id)) &&
        typeof request.name === 'string' && request.name && request.name.length <= 160);
    let owner = (await chrome.storage.session.get('projectCreateOwner')).projectCreateOwner;
    let ownerTab = owner ? await chrome.tabs.get(owner.tab).catch(() => null) : null;
    if (owner && ownerTab) owner = await bindProjectCreateDocument(owner, ownerTab);
    if (owner && !list.some(request => request.id === owner.id)) {
      const source = { tab: owner.tab, documentId: owner.documentId, navigationEpoch: owner.navigationEpoch };
      let release = !ownerTab || !ownsDocument(source);
      if (!release && ownerTab && !ownerTab.pinned && !ownerTab.pendingUrl) {
        let timer;
        const proof = await Promise.race([
          tabReply(ownerTab.id, { type: 'clf-project-create-state', id: owner.id,
            ...(owner.chatgptId ? { chatgptId: owner.chatgptId } : {}) }, { documentId: owner.documentId }).catch(() => null),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); })
        ]).finally(() => clearTimeout(timer));
        const current = await chrome.tabs.get(ownerTab.id).catch(() => null);
        const exact = proof?.id === owner.id && proof.navigationEpoch === owner.navigationEpoch &&
          (proof.chatgptId ?? null) === (owner.chatgptId ?? null) && current && !current.pinned &&
          !current.pendingUrl && ownsDocument(source) && projectCreateRouteOwned(current, owner);
        if (exact && proof.safe === true) {
          await chrome.tabs.remove(ownerTab.id).catch(() => undefined);
          release = true;
        } else if (proof?.id === owner.id && proof.navigationEpoch === owner.navigationEpoch &&
            proof.busy === false && proof.owned === false && ownsDocument(source)) {
          // The exact old document is idle but the user moved it elsewhere. Detach the helper
          // lease without closing their page; delayed create IPC still fails owner matching.
          release = true;
        }
      }
      if (!release && (dispatchAllowed || owner.chatgptId)) {
        // Main's unwithheld list is authoritative for terminal request disappearance, and an
        // accepted provider Project id is already terminal proof. A pinned or draft-bearing tab
        // must survive, but it must not retain creation authority and block the next request.
        console.info('[Chat On Steroids] detached terminal native Project helper without closing its tab', owner.id);
        release = true;
      }
      // A withheld list means pause/auth/Core policy, not terminal disappearance. Retain every
      // same-document busy/unsafe owner so an already-claimed helper can finish or fail once;
      // otherwise a later status pass could open a duplicate native Project.
      if (release) {
        await chrome.storage.session.remove('projectCreateOwner');
        owner = null;
        ownerTab = null;
      } else return;
    }
    if (!dispatchAllowed) return;
    if (!list.length) return;
    const owned = owner ? list.find(request => request.id === owner.id) : null;
    if (owned && owned.state !== 'requested') return;
    const request = owned || list.find(candidate => candidate.state === 'requested');
    if (!request) return;
    const mine = owner && owner.id === request.id ? owner : null;
    const tab = mine ? ownerTab || await chrome.tabs.get(mine.tab).catch(() => null) : null;
    if (!tab) {
      if (mine && Date.now() - (mine.openedAt ?? 0) < PROJECT_CREATE_REOPEN_MS) return;
      const created = await createChatTab(`https://chatgpt.com/?cos-project-create=${request.id}`, false);
      await chrome.storage.session.set({ projectCreateOwner: { id: request.id, tab: created.id, openedAt: Date.now() } });
      return;
    }
    let timer;
    try {
      asked = true;
      await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: 'clf-project-create', request: { id: request.id, name: request.name } }).catch(() => undefined),
        new Promise(resolve => { timer = setTimeout(resolve, 30_000); })
      ]);
    } finally { clearTimeout(timer); }
  })().catch(error => console.warn('[Chat On Steroids] native Project helper failed', String(error?.message || error)))
    .finally(() => { projectCreateFlight = null; if (asked) void maintain(); });
  return projectCreateFlight;
}

function inspectRequestedPluginRefresh(publications, background, browserOnly = false) {
  if (pluginRefreshFlight || !Array.isArray(publications) || !publications.length) return pluginRefreshFlight;
  pluginRefreshFlight = (async () => {
    const pending = await call('/plugin-refresh', { method: 'POST', body: JSON.stringify({ action: 'pending' }) });
    if (!pending.ok || !Array.isArray(pending.data?.requests)) return;
    const allRequests = pending.data.requests;
    // Main owns at most the three Core/Desktop/Plugins rows. Consider every surface for
    // eligibility, while the single held/create path below still performs only one action.
    const requests = allRequests.slice(0, 3);
    const tabs = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
    const refreshState = await chrome.storage.session.get([
      'pluginRefreshOwner', 'pluginRefreshSuppressedOwners', 'pluginRefreshOperatorTurnovers'
    ]);
    const saved = refreshState.pluginRefreshOwner;
    let owner = saved && typeof saved.id === 'string' && Number.isInteger(saved.tab) &&
      (saved.documentId === null || typeof saved.documentId === 'string') &&
      (saved.navigationEpoch === null || Number.isFinite(saved.navigationEpoch)) ? saved : null;
    const pendingIds = new Set(allRequests.map(request => request?.id).filter(id => typeof id === 'string'));
    const suppressedOwners = new Set(Array.isArray(refreshState.pluginRefreshSuppressedOwners)
      ? refreshState.pluginRefreshSuppressedOwners.filter(id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id))
      : []);
    let operatorTurnovers = Array.isArray(refreshState.pluginRefreshOperatorTurnovers)
      ? refreshState.pluginRefreshOperatorTurnovers.filter(turnover => turnover &&
          typeof turnover.id === 'string' && /^[a-f0-9-]{36}$/i.test(turnover.id) &&
          typeof turnover.receipt === 'string' && /^[a-f0-9-]{36}$/i.test(turnover.receipt) &&
          Number.isSafeInteger(turnover.generation) && turnover.generation > 0)
      : [];
    const exactOperatorGrant = request => request && request.surface === 'core' &&
      typeof request.operatorRearmReceipt === 'string' && /^[a-f0-9-]{36}$/i.test(request.operatorRearmReceipt) &&
      Number.isSafeInteger(request.operatorRearmGeneration) && request.operatorRearmGeneration > 0;
    const turnoverKey = value => `${value.id}:${value.receipt}:${value.generation}`;
    const liveTurnoverKeys = new Set(allRequests.filter(exactOperatorGrant).map(request => turnoverKey({
      id: request.id, receipt: request.operatorRearmReceipt, generation: request.operatorRearmGeneration
    })));
    const retainedTurnovers = operatorTurnovers.filter(turnover => liveTurnoverKeys.has(turnoverKey(turnover)));
    let turnoverChanged = retainedTurnovers.length !== operatorTurnovers.length;
    operatorTurnovers = retainedTurnovers;
    let suppressionChanged = false;
    for (const id of [...suppressedOwners]) {
      if (pendingIds.has(id)) continue;
      suppressedOwners.delete(id);
      suppressionChanged = true;
    }
    let ownedHeld = null;
    let ownedReady = false;
    let recoveredHeld = null;
    let recoveredHeldId = null;
    const requestIds = new Set(requests.map(request => request?.id).filter(id => typeof id === 'string'));
    const blockedRequestIds = new Set([...suppressedOwners].filter(id => requestIds.has(id)));
    const suppressOwner = id => {
      blockedRequestIds.add(id);
      if (suppressedOwners.has(id)) return;
      suppressedOwners.add(id);
      suppressionChanged = true;
    };
    const retiredRefreshTabs = new Set();
    // A provider SPA transition strips our query. The operation still owns the same
    // tab: preserve that identity across MV3 suspension before inspecting its URL.
    if (owner && requests.some(request => request.id === owner.id)) {
      const current = await chrome.tabs.get(owner.tab).catch(() => null);
      if (!current) {
        // A user-closed helper is not permission to reopen it every poll. An already-open exact
        // marked survivor may take custody below; unrelated surfaces must still make progress.
        suppressOwner(owner.id);
      } else if (current.pinned) {
        // Pinning is an explicit user ownership boundary. Leave this tab entirely untouched and
        // let the ordinary election reuse or create a separate unpinned helper.
        blockedRequestIds.delete(owner.id);
        if (suppressedOwners.delete(owner.id)) suppressionChanged = true;
      } else if (current.pendingUrl) {
        blockedRequestIds.add(owner.id);
      } else if (pluginRefreshMarker(current) !== owner.id) {
        let url = null;
        try { url = new URL(current.url || ''); } catch {}
        if (!url || url.origin !== 'https://chatgpt.com' || !pluginRefreshRoute(url)) {
          // Leaving settings revokes this tab without starving another queued plugin surface.
          // Do not reopen the same request unless an existing exact survivor proves custody.
          suppressOwner(owner.id);
        } else {
          // ChatGPT may strip the query without replacing the content document. Ask that exact
          // saved owner whether its immutable BOOT_MARKERS still proves custody. `safe:false` can
          // mean Refresh is currently in flight; `owned:true` must hold the tab without reload.
          const key = String(current.id), documentId = tabDocuments[key], navigationEpoch = tabEpochs[key];
          if (owner.documentId && owner.documentId === documentId && owner.navigationEpoch === navigationEpoch) {
            const proof = await pluginRefreshProbe(current.id, owner.id, documentId);
            const latest = await chrome.tabs.get(owner.tab).catch(() => null);
            let latestUrl = null;
            try { latestUrl = new URL(latest?.url || ''); } catch {}
            if (proof?.owned === true && latest && !latest.pinned && !latest.pendingUrl &&
                latest.url === current.url && latestUrl?.origin === 'https://chatgpt.com' &&
                pluginRefreshRoute(latestUrl) && !pluginRefreshMarker(latest) &&
                tabDocuments[key] === documentId && tabEpochs[key] === navigationEpoch) {
              ownedHeld = latest;
              ownedReady = proof.safe === true;
            }
          }
          if (ownedHeld) {
            // Continue below with the same tab/request owner. Never navigate an in-flight refresh.
            blockedRequestIds.delete(owner.id);
            if (suppressedOwners.delete(owner.id)) suppressionChanged = true;
          } else {
            url.searchParams.set('cos-plugin-refresh', owner.id);
            await chrome.tabs.update(current.id, { url: url.href }).catch(() => null);
            blockedRequestIds.add(owner.id);
          }
        }
      }
    }
    // A missing or repurposed owner is durable no-reopen evidence for only its own request. An
    // already-open exact safe survivor is explicit turnover authority; no URL guess or new tab is.
    recovery: for (const id of [...blockedRequestIds]) {
      if (!suppressedOwners.has(id)) continue;
      // One session owner acts at a time. Do not clear another request's no-reopen receipt merely
      // because its survivor was visible while an exact markerless owner still held custody.
      if (ownedHeld) break;
      for (const candidate of tabs) {
        if (pluginRefreshMarker(candidate) !== id) continue;
        const survivor = await safeMarkedPluginRefreshTab(candidate, id);
        if (!survivor) continue;
        recoveredHeld = survivor;
        recoveredHeldId = id;
        blockedRequestIds.delete(id);
        break recovery;
      }
    }
    let operatorTurnoverId = null;
    // An explicit operator grant may replace one missing/repurposed same-row owner exactly once.
    // Spend the receipt before opening anything and keep suppression in place until the new
    // owner is installed. A crash in between therefore fails closed; a late old owner cannot
    // race because any surviving exact marker prevents replacement here.
    if (!ownedHeld && !recoveredHeld) {
      for (const request of requests) {
        if (!blockedRequestIds.has(request.id) || !suppressedOwners.has(request.id) ||
            !exactOperatorGrant(request) || tabs.some(tab => pluginRefreshMarker(tab) === request.id)) continue;
        const turnover = { id: request.id, receipt: request.operatorRearmReceipt,
          generation: request.operatorRearmGeneration };
        if (operatorTurnovers.some(entry => turnoverKey(entry) === turnoverKey(turnover))) continue;
        operatorTurnovers.push(turnover);
        turnoverChanged = true;
        operatorTurnoverId = request.id;
        blockedRequestIds.delete(request.id);
        if (owner?.id === request.id) owner = null;
        // This transaction is the durable one-shot boundary. Suppression intentionally remains
        // until a replacement owner is committed below.
        await chrome.storage.session.set({ pluginRefreshOwner: owner,
          pluginRefreshSuppressedOwners: [...suppressedOwners].slice(-3),
          pluginRefreshOperatorTurnovers: operatorTurnovers.slice(-8) });
        suppressionChanged = false;
        turnoverChanged = false;
        break;
      }
    }
    if (suppressionChanged || turnoverChanged) {
      await chrome.storage.session.set({ pluginRefreshSuppressedOwners: [...suppressedOwners].slice(-3),
        pluginRefreshOperatorTurnovers: operatorTurnovers.slice(-8) });
    }
    for (const tab of tabs) {
      const id = pluginRefreshMarker(tab);
      if (!id || tab.pinned || pendingIds.has(id)) continue;
      const key = String(tab.id), documentId = tabDocuments[key], navigationEpoch = tabEpochs[key];
      const proof = await pluginRefreshProbe(tab.id, id, documentId);
      if (proof?.safe !== true) return;
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (current && !current.pinned && !current.pendingUrl && pluginRefreshMarker(current) === id &&
          tabDocuments[key] === documentId && tabEpochs[key] === navigationEpoch &&
          await retireAutomaticTab(tab.id, async () => {
            const latest = await chrome.tabs.get(tab.id).catch(() => null);
            return Boolean(latest && !latest.pinned && !latest.pendingUrl && pluginRefreshMarker(latest) === id &&
              tabDocuments[key] === documentId && tabEpochs[key] === navigationEpoch &&
              (await pluginRefreshProbe(tab.id, id, documentId))?.safe === true);
          })) retiredRefreshTabs.add(tab.id);
    }
    if (!requests.length) return;
    // A crash/restart can leave two settings tabs carrying the same refresh id. Retain one exact
    // owner and retire only proven-idle duplicates; never let both documents race one click.
    for (const pending of requests) {
      if (blockedRequestIds.has(pending.id)) continue;
      const matching = tabs.filter(tab => !retiredRefreshTabs.has(tab.id) && !tab.pinned &&
        !tab.pendingUrl && pluginRefreshMarker(tab) === pending.id);
      const keeper = ownedHeld && owner?.id === pending.id ? ownedHeld :
        recoveredHeld && recoveredHeldId === pending.id ? recoveredHeld :
        matching.find(tab => owner?.id === pending.id && owner.tab === tab.id) || matching[0];
      if (!keeper || matching.length + Number(!matching.some(tab => tab.id === keeper.id)) <= 1) continue;
      const keeperKey = String(keeper.id), keeperDocumentId = tabDocuments[keeperKey];
      const keeperNavigationEpoch = tabEpochs[keeperKey];
      if (!keeperDocumentId || !Number.isFinite(keeperNavigationEpoch)) return;
      for (const extra of matching) {
        if (extra.id === keeper.id) continue;
        const key = String(extra.id), documentId = tabDocuments[key], navigationEpoch = tabEpochs[key];
        if (!documentId || !Number.isFinite(navigationEpoch) ||
            (await pluginRefreshProbe(extra.id, pending.id, documentId))?.safe !== true) return;
        const retired = await retireAutomaticTab(extra.id, async () => {
          // Closing the surplus is permitted only while the keeper still exists as the same
          // exact content document. For the saved owner, BOOT_MARKERS must still prove custody;
          // this protects an in-flight markerless owner without making its `safe` state relevant.
          const latestKeeper = await chrome.tabs.get(keeper.id).catch(() => null);
          if (!latestKeeper || latestKeeper.pinned || latestKeeper.pendingUrl ||
              tabDocuments[keeperKey] !== keeperDocumentId ||
              tabEpochs[keeperKey] !== keeperNavigationEpoch) return false;
          const keeperMarker = pluginRefreshMarker(latestKeeper);
          const savedKeeper = owner?.id === pending.id && owner.tab === keeper.id &&
            owner.documentId === keeperDocumentId && owner.navigationEpoch === keeperNavigationEpoch;
          if (savedKeeper) {
            if (keeperMarker !== pending.id && keeperMarker !== null) return false;
            if ((await pluginRefreshProbe(keeper.id, pending.id, keeperDocumentId))?.owned !== true) return false;
          } else if (keeperMarker !== pending.id ||
                     (await pluginRefreshProbe(keeper.id, pending.id, keeperDocumentId))?.safe !== true) return false;
          const latest = await chrome.tabs.get(extra.id).catch(() => null);
          return Boolean(latest && !latest.pinned && !latest.pendingUrl &&
            pluginRefreshMarker(latest) === pending.id && tabDocuments[key] === documentId &&
            tabEpochs[key] === navigationEpoch &&
            (await pluginRefreshProbe(extra.id, pending.id, documentId))?.safe === true);
        });
        if (!retired) return;
        retiredRefreshTabs.add(extra.id);
      }
    }
    const held = ownedHeld || recoveredHeld || tabs.find(tab => !retiredRefreshTabs.has(tab.id) &&
      !tab.pinned && !tab.pendingUrl && !blockedRequestIds.has(pluginRefreshMarker(tab)) &&
      requests.some(request => request.id === pluginRefreshMarker(tab)));
    const heldId = ownedHeld ? owner?.id : recoveredHeld ? recoveredHeldId : pluginRefreshMarker(held);
    const request = requests.find(request => request.id === heldId) ||
      requests.find(candidate => !blockedRequestIds.has(candidate.id));
    if (!request) return;
    if (!held) {
      if (browserOnly) return;
      try {
        const tab = await createChatTab(request.appId
          // atsu6 / upstream db347562 (#1538): the retired settings hash can land on
          // ChatGPT's home; keep the exact App Id and refresh owner on the native route.
          ? `https://chatgpt.com/settings/plugins-settings/plugin_${request.appId}?cos-plugin-refresh=${request.id}`
          : `https://chatgpt.com/settings/plugins-settings?cos-plugin-refresh=${request.id}`, background);
        const nextOwner = { id: request.id, tab: tab.id, documentId: null, navigationEpoch: null };
        if (operatorTurnoverId === request.id) {
          suppressedOwners.delete(request.id);
          await chrome.storage.session.set({ pluginRefreshOwner: nextOwner,
            pluginRefreshSuppressedOwners: [...suppressedOwners].slice(-3),
            pluginRefreshOperatorTurnovers: operatorTurnovers.slice(-8) });
        } else await chrome.storage.session.set({ pluginRefreshOwner: nextOwner });
      }
      catch {
        // Preserve the pre-claim obligation and expose the failed browser boundary.
        // Swallowing this error made a due request look as if its wake never arrived.
        const failure = operatorTurnoverId === request.id && exactOperatorGrant(request)
          ? { action: 'operator-owner-fail', id: request.id,
              operatorRearmReceipt: request.operatorRearmReceipt,
              operatorRearmGeneration: request.operatorRearmGeneration,
              error: 'The operator-authorized plugin refresh owner could not be replaced' }
          : { action: 'fail', id: request.id,
              error: 'The background plugin refresh tab could not be created' };
        await call('/plugin-refresh', { method: 'POST', body: JSON.stringify(failure) });
      }
      return;
    }
    const currentHeld = await chrome.tabs.get(held.id).catch(() => null);
    if (!currentHeld || currentHeld.pinned || currentHeld.pendingUrl) return;
    const markerlessOwner = ownedHeld && owner?.id === request.id && ownedHeld.id === currentHeld.id &&
      pluginRefreshMarker(currentHeld) === null;
    if (pluginRefreshMarker(currentHeld) !== request.id && !markerlessOwner) return;
    const heldKey = String(currentHeld.id), heldDocumentId = tabDocuments[heldKey], heldNavigationEpoch = tabEpochs[heldKey];
    if (!heldDocumentId || !Number.isFinite(heldNavigationEpoch)) return;
    const nextOwner = { id: request.id, tab: currentHeld.id,
      documentId: heldDocumentId, navigationEpoch: heldNavigationEpoch };
    if (recoveredHeld && recoveredHeldId === request.id) {
      // Release durable no-reopen custody only in the same storage transaction that installs the
      // survivor as the exact new owner. A pin/navigation race before here preserves suppression.
      suppressedOwners.delete(request.id);
      await chrome.storage.session.set({ pluginRefreshOwner: nextOwner,
        pluginRefreshSuppressedOwners: [...suppressedOwners].slice(-3) });
    } else await chrome.storage.session.set({ pluginRefreshOwner: nextOwner });
    if (ownedHeld && !ownedReady) return;
    let timer;
    try {
      await Promise.race([chrome.tabs.sendMessage(currentHeld.id, { type: 'clf-plugin-refresh', request }, { documentId: heldDocumentId }), new Promise(resolve => { timer = setTimeout(resolve, 25000); })]);
    } finally { clearTimeout(timer); }
  })().catch(() => undefined).finally(() => { pluginRefreshFlight = null; });
  return pluginRefreshFlight;
}
async function catalogProbe(tabId, nonce) {
  let timer;
  try {
    return await Promise.race([chrome.tabs.sendMessage(tabId, { type: 'clf-model-catalog-state', nonce }), new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); })]);
  } catch { return null; } finally { clearTimeout(timer); }
}
function catalogTabNonce(tab) {
  try {
    const url = new URL(tab?.pendingUrl || tab?.url || '');
    const nonce = url.searchParams.get('cos-model-catalog');
    return url.origin === 'https://chatgpt.com' && url.pathname === '/' && /^[a-f0-9-]{36}$/i.test(nonce || '') ? nonce : null;
  } catch { return null; }
}

/** A command-owned opening is authored work, never an idle model-catalog surface. */
function catalogCandidateTab(tab) {
  return !commandOwnedOpeningTab(tab);
}

function inspectRequestedModels(request) {
  if (modelCatalogFlight) return modelCatalogFlight;
  const wanted = request && /^[a-f0-9-]{36}$/i.test(request.nonce) && Number.isFinite(request.expiresAt) && Date.now() < request.expiresAt ? request : null;
  modelCatalogFlight = (async () => {
    // A worker/resume tab gets command custody before it has a provider conversation. A catalog
    // request can arrive in the same maintenance pass that opened it; borrowing that composer
    // would race the authored command. Keep exact command-owned openings out of discovery until
    // their existing ownership row is released.
    const observed = (await chrome.tabs.query({ url: CHATGPT_TAB_URLS })).filter(catalogCandidateTab);
    const owner = (await chrome.storage.session.get('modelCatalogOwner')).modelCatalogOwner;
    if (wanted && owner?.nonce === wanted.nonce && owner.opening) return;
    // One request retains its elected tab through MV3 suspension. A missing or
    // navigated-away tab is an unfinished request, never another create instruction.
    if (owner?.nonce === wanted?.nonce && Number.isInteger(owner?.tab) &&
        (owner.handedToInput || !observed.some(tab => tab.id === owner.tab))) return;
    const tabs = wanted ? observed : observed.filter(tab => catalogTabNonce(tab));
    if (!wanted && !tabs.length) return;
    // Reuse a loaded idle document without navigation. A dedicated helper marker
    // identifies cleanup ownership if its prior request ended before safe retirement.
    tabs.sort((a, b) => Number(!!catalogTabNonce(b)) - Number(!!catalogTabNonce(a)) || a.id - b.id);
    const proofs = await Promise.all(tabs.map(candidate => catalogProbe(candidate.id, catalogTabNonce(candidate))));
    let tab = tabs.find((candidate, index) => proofs[index]?.ready === true &&
      (!owner || owner.nonce !== wanted?.nonce || candidate.id === owner.tab));
    if (wanted && Date.now() >= wanted.expiresAt) return;
    if (!wanted && !tab) return;
    if (!tab) {
      // An existing helper may be temporarily busy. Retain it and wait.
      if (wanted.allowOpen === false || owner?.nonce === wanted.nonce || tabs.length) return;
      await chrome.storage.session.set({ modelCatalogOwner: { nonce: wanted.nonce, opening: true } });
      tab = await createChatTab(`https://chatgpt.com/?cos-model-catalog=${wanted.nonce}`, true);
      await chrome.storage.session.set({ modelCatalogOwner: { nonce: wanted.nonce, tab: tab.id } });
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
      return;
    }
    // Keep the elected warm document for another discovery or the first authored
    // input. Only redundant empty helpers retire; borrowed user documents never do.
    const retireCatalogTabs = async () => {
      for (const candidate of tabs) {
        if (candidate.id === tab.id || candidate.pinned || !catalogTabNonce(candidate) || candidate.pendingUrl) continue;
        const source = { tab: candidate.id, documentId: tabDocuments[String(candidate.id)], navigationEpoch: tabEpochs[String(candidate.id)] };
        if (!ownsDocument(source)) continue;
        try {
          let timer;
          const proof = await Promise.race([
            chrome.tabs.sendMessage(candidate.id, { type: 'clf-tab-close-check', conversationId: null }, { documentId: source.documentId }),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); })
          ]).finally(() => clearTimeout(timer));
          const latest = await chrome.tabs.get(candidate.id);
          if (proof?.safe !== true || proof.conversationId !== null || proof.navigationEpoch !== source.navigationEpoch || !ownsDocument(source) ||
            latest.pinned || latest.pendingUrl || latest.url !== candidate.url) continue;
          await retireAutomaticTab(candidate.id);
        } catch { /* Busy, drafting or changed documents keep their tab for ordinary maintenance. */ }
      }
    };
    if (!wanted) { await retireCatalogTabs(); return; }
    const held = { ...(owner?.nonce === wanted.nonce ? owner : {}), nonce: wanted.nonce, tab: tab.id };
    await chrome.storage.session.set({ modelCatalogOwner: held });
    const send = async (message, documentId) => {
      let timer;
      try {
        return await Promise.race([
          documentId ? chrome.tabs.sendMessage(tab.id, message, { documentId }) : chrome.tabs.sendMessage(tab.id, message),
          new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, Math.min(35000, wanted.expiresAt - Date.now()))); })
        ]);
      } finally { clearTimeout(timer); }
    };
    modelCatalogTarget = { tab: tab.id, nonce: wanted.nonce, documentId: tabDocuments[String(tab.id)] || null };
    const inspected = await send({ type: 'clf-model-catalog', nonce: wanted.nonce, expiresAt: wanted.expiresAt });
    // Work->Chat is an in-document transition owned by the content script.
    // Failure never grants navigation to New Chat or a replacement helper tab.
    if (inspected === true || inspected?.ok === true) await retireCatalogTabs();
  })().catch(() => undefined).finally(() => { modelCatalogTarget = null; modelCatalogFlight = null; });
  return modelCatalogFlight;
}

let maintenanceFlight = null;
let maintenanceAgain = false;
let wakeSocket = null;
// Browser control is instantiated only after the app advertises work. Exact leased tab ids are
// kept in this worker so tab cleanup/grouping can never move, discard or retire a controlled page.
let browserController;
let browserControlledTabs = new Set();
function browserControlsTab(tabId) {
  return Number.isInteger(tabId) && browserControlledTabs.has(tabId);
}
function getBrowserController() {
  if (!globalThis.chrome?.debugger) return Promise.resolve(null);
  browserController ||= Promise.resolve(createBrowserControl(
    chrome,
    call,
    (tabId, url, caller) => {
      const conversation = conversationFromUrl(url);
      return Boolean(conversation && (conversation === caller || discardProtectedTabs[String(tabId)] === true));
    },
    leases => { browserControlledTabs = leases instanceof Set ? leases : new Set(); }
  ));
  return browserController;
}
const browserControlFlights = new Set();
function pumpBrowserControl() {
  // Reload drains delivery custody, not new browser commands. Main keeps unclaimed work.
  if (companionReloadFlight) return Promise.resolve();
  // Every normal wake must reach the controller's incumbent `again` latch. Track callers
  // without coalescing them here, or a command arriving during a poll snapshot loses its wake.
  const work = getBrowserController().then(controller => controller?.pump());
  const tracked = work.finally(() => { browserControlFlights.delete(tracked); });
  browserControlFlights.add(tracked);
  return tracked;
}
async function hydrateBrowserControlLeases() {
  if (!globalThis.chrome?.debugger) return true;
  try {
    const controller = await getBrowserController();
    if (!controller) return true;
    await controller.ready();
    return true;
  } catch {
    // A failed restore is unknown custody, never permission for tab hygiene.
    return false;
  }
}
globalThis.chrome?.debugger?.onEvent.addListener((source, method, params) => {
  void getBrowserController().then(controller => controller?.event(source, method, params)).catch(() => undefined);
});
globalThis.chrome?.debugger?.onDetach.addListener(source => {
  void getBrowserController().then(controller => controller?.detached(source)).catch(() => undefined);
});
function closeWakeSocket() {
  const previous = wakeSocket; wakeSocket = null;
  if (previous) previous.close();
}
function connectWakeSocket() {
  if (!token || disconnected || !port || typeof WebSocket === 'undefined') return;
  const url = `ws://127.0.0.1:${port}/wake`;
  if (wakeSocket?.url === url && wakeSocket.readyState <= 1) return;
  closeWakeSocket();
  const connection = new WebSocket(url);
  wakeSocket = connection;
  connection.onopen = () => {
    if (wakeSocket !== connection || !token || disconnected) { connection.close(); return; }
    // Pairing credentials never enter a URL, content script or page.
    connection.send(token);
  };
  connection.onmessage = (event) => {
    if (wakeSocket !== connection) return;
    if (event.data === 'ping') connection.send('pong');
    else if (event.data === 'disconnect') {
      void latchAppDisconnect(connection).catch(() => closeWakeSocket());
    }
    else if (event.data === 'browser-control') void pumpBrowserControl().catch(() => undefined);
    else if (event.data === 'open-conversation') {
      void pumpUrgentOpenConversationRequests().catch(() => undefined);
    }
    else if (event.data === 'wake') {
      void pumpBrowserControl().catch(() => undefined);
      void maintain(true).catch(() => undefined);
    }
  };
  connection.onerror = () => connection.close();
  connection.onclose = () => { if (wakeSocket === connection) wakeSocket = null; };
  // Existing startup/maintenance reconnects after app/browser restart. No retry timer.
}
async function applyRequestedBrowserPreferences(request) {
  if (!request || !/^[a-f0-9-]{36}$/i.test(request.nonce) || !Number.isFinite(request.expiresAt) ||
      request.expiresAt <= Date.now() || request.expiresAt > Date.now() + 70000 || !request.patch ||
      Object.keys(request.patch).some(key => !['overwrite', 'durations'].includes(key) || typeof request.patch[key] !== 'boolean')) return;
  const key = 'browserPreferenceReceipt';
  const stored = await chrome.storage.session.get(key);
  let receipt = stored[key];
  if (!receipt || receipt.nonce !== request.nonce) {
    // Reserve before the write: a worker crash must not replay an ambiguous change
    // over a newer popup choice. Report uncertainty through this same request.
    receipt = { nonce: request.nonce, values: null, error: 'The previous preference write was not confirmed. Refresh before changing it again.' };
    await chrome.storage.session.set({ [key]: receipt });
    try {
      const patch = {};
      if (typeof request.patch.overwrite === 'boolean') patch.renderStreamEnabled = request.patch.overwrite;
      // Timestamps are a product invariant. Keep accepting the legacy `durations` field so an
      // older desktop UI can talk to this extension, but a false request can never disable them.
      if (typeof request.patch.durations === 'boolean') patch.showStreamTimes = true;
      if (Object.keys(patch).length) await chrome.storage.local.set(patch);
      const actual = await chrome.storage.local.get(['renderStreamEnabled', 'showStreamTimes']);
      receipt = { nonce: request.nonce, values: { overwrite: actual.renderStreamEnabled !== false, durations: true } };
      await chrome.storage.session.set({ [key]: receipt });
      if (request.patch.overwrite === true) await HANDLERS.overwriteNow();
    } catch {
      receipt = { nonce: request.nonce, values: null, error: 'The extension could not confirm its saved preferences. Refresh before retrying.' };
      await chrome.storage.session.set({ [key]: receipt });
    }
  }
  await call('/browser/preferences', { method: 'POST', body: JSON.stringify(receipt) });
}

const OPEN_CONVERSATION_INVENTORY_TIMEOUT_MS = 1500;
const CLEANUP_CONVERSATION_INVENTORY_TIMEOUT_MS = 5000;
const OPEN_CONVERSATION_FOCUS_RETRY_INVENTORY_TIMEOUT_MS = 500;
const OPEN_CONVERSATION_FOCUS_RETRY_DELAYS_MS = [250, 750, 1500];
const BARE_CHATGPT_TAB_URLS = ['https://chatgpt.com/', 'https://chat.openai.com/'];

async function boundedTabInventory(query, timeoutMs = OPEN_CONVERSATION_INVENTORY_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.query(query),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('inventory_timeout')), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function openConversationInventory(timeoutMs = OPEN_CONVERSATION_INVENTORY_TIMEOUT_MS) {
  return boundedTabInventory({ url: CHATGPT_TAB_URLS }, timeoutMs);
}

/** Read only one known conversation instead of waking every ChatGPT renderer in Chrome. */
function exactConversationInventory(conversationId, timeoutMs = OPEN_CONVERSATION_INVENTORY_TIMEOUT_MS) {
  const id = cleanConversationId(conversationId);
  if (!id) return Promise.resolve([]);
  return boundedTabInventory({ url: [
    `https://chatgpt.com/c/${id}*`,
    `https://chat.openai.com/c/${id}*`
  ] }, timeoutMs);
}

function bareRootInventory() {
  return boundedTabInventory({ url: BARE_CHATGPT_TAB_URLS });
}

/** A redirected app-owned root may be reused only while that exact empty document still owns it. */
async function proveEmptyRedirectedConversationRoot(tab, row, allowedInputId = null, allowNoticeDismiss = true) {
  if (!Number.isInteger(tab?.id) || browserControlsTab(tab.id)) return null;
  const key = String(tab.id);
  const source = { tab: tab.id, documentId: tabDocuments[key], navigationEpoch: tabEpochs[key] };
  const stillEligible = current => appOwnedOpeningTabs[key] === row && ownsDocument(source) &&
    cleanConversationId(row?.conversationId) && !rootHasCurrentOperationOwner(tab.id, allowedInputId) &&
    current?.id === tab.id && !current.pinned && !current.pendingUrl && current.status !== 'loading' &&
    exactPlainChatHome(current.url);
  try {
    const current = await chrome.tabs.get(tab.id);
    if (!stillEligible(current)) return null;
    // Explicit Retry can land on an exact app-owned root behind ChatGPT's informational
    // account-throttle dialog. Ask the current document to dismiss only that classified Got it
    // control before proving/reusing the root. This does not claim or expose the queued message,
    // and every identity/navigation guard below is repeated after the click.
    if (allowNoticeDismiss) {
      const notice = await tabReply(tab.id, { type: 'clf-dismiss-access-throttle' },
        { documentId: source.documentId }, 1500);
      if (notice?.dismissed === true) await new Promise(resolve => setTimeout(resolve, 250));
    }
    const proof = await tabReply(tab.id, { type: 'clf-tab-close-check', conversationId: null },
      { documentId: source.documentId });
    if (proof?.safe !== true || proof.conversationId !== null ||
        proof.navigationEpoch !== source.navigationEpoch || !ownsDocument(source)) return null;
    const latest = await chrome.tabs.get(tab.id);
    return stillEligible(latest) ? { tab: latest, source } : null;
  } catch {
    return null;
  }
}

/**
 * Publishes one durable fallback notice after this recovery episode has exhausted Chrome.
 *
 * The row is persisted as `escalated` before the request. A lost HTTP response therefore
 * retries the same nonce after MV3 suspension/restart, while every later Open pass refuses to
 * retarget or create another tab for this episode. Main owns the continuation transaction and
 * makes the notice idempotent; this helper never inserts or sends text itself.
 */
async function notifyUnreachableConversation(tab, row, inventory, request = null) {
  const conversationId = cleanConversationId(row?.conversationId);
  const nonce = typeof row?.escalationNonce === 'string' && /^[a-f0-9]{32}$/i.test(row.escalationNonce)
    ? row.escalationNonce.toLowerCase()
    : null;
  if (!Number.isInteger(tab?.id) || !conversationId || row?.openState !== 'escalated' || !nonce) {
    return 'invalid';
  }
  if ((Array.isArray(inventory) ? inventory : []).some(candidate =>
    Number.isInteger(candidate?.id) && conversationForTab(candidate) === conversationId)) {
    if (appOwnedOpeningTabs[String(tab.id)] === row) {
      delete appOwnedOpeningTabs[String(tab.id)];
      await chrome.storage.session.set({ appOwnedOpeningTabs });
    }
    return 'cancelled';
  }
  if (row.escalationReported === true) return 'accepted';
  if (!await proveEmptyRedirectedConversationRoot(tab, row)) return 'unsafe';
  const reply = await call('/browser/unreachable-conversation', {
    method: 'POST',
    body: JSON.stringify({
      conversationId,
      nonce,
      requestId: typeof request?.requestId === 'string' ? request.requestId : row.openRequestId,
      ...(typeof request?.nonce === 'string' && /^[a-f0-9]{32}$/i.test(request.nonce)
        ? { requestNonce: request.nonce.toLowerCase() }
        : {})
    })
  });
  if (!reply.ok || reply.data?.accepted !== true) return 'rejected';
  if (appOwnedOpeningTabs[String(tab.id)] === row) {
    row.escalationReported = true;
    await chrome.storage.session.set({ appOwnedOpeningTabs });
  }
  return 'accepted';
}

/** Replays only persisted escalation notices; it never creates or retargets a tab. */
async function flushUnreachableConversationNotices(inventory) {
  for (const [key, row] of Object.entries(appOwnedOpeningTabs)) {
    if (row?.openState !== 'escalated' || row.escalationReported === true) continue;
    const tabId = Number(key);
    const tab = (Array.isArray(inventory) ? inventory : []).find(candidate => candidate?.id === tabId);
    if (!tab) continue;
    await notifyUnreachableConversation(tab, row, inventory).catch(() => undefined);
  }
}

/**
 * Gives tab hygiene one bounded retry when Chrome's inventory API is briefly unavailable.
 *
 * The ordinary pass remains fast. A second, five-second read tolerates Chrome waking a large
 * suspended tab set without letting the shared maintenance flight hang indefinitely. Cleanup
 * still fails closed after the second failure, and no tab-close proof is attempted from a
 * partial or unknown inventory.
 */
async function cleanupConversationInventory() {
  try {
    return await openConversationInventory();
  } catch {
    return openConversationInventory(CLEANUP_CONVERSATION_INVENTORY_TIMEOUT_MS);
  }
}

/** Elects one exact existing conversation without guessing across two selected windows. */
function electOpenConversationTarget(tabs, conversationId) {
  const candidates = (Array.isArray(tabs) ? tabs : [])
    .filter(tab => Number.isInteger(tab?.id) && conversationForTab(tab) === conversationId)
    .sort((a, b) => Number(b.active === true) - Number(a.active === true) ||
      (b.lastAccessed || 0) - (a.lastAccessed || 0) || a.id - b.id);
  const activeWindows = new Set(candidates
    .filter(tab => tab.active === true && Number.isInteger(tab.windowId))
    .map(tab => tab.windowId));
  return { target: candidates[0] || null, ambiguous: activeWindows.size > 1 };
}

/**
 * Revalidates and raises one exact conversation using Chrome's current tab/window facts.
 *
 * The inventory row may already contain a stale windowId when a tab was dragged between the
 * query and the click. Both `tabs.update` and the final `tabs.get` are authoritative here; the
 * old inventory window is never focused. Minimized windows must be restored before they can be
 * focused reliably on Windows.
 */
async function focusExactConversationTarget(candidate, conversationId, acceptance = null) {
  const currentAdmission = () => acceptance === null || acceptance() === true;
  if (!currentAdmission()) throw new Error('request_owner_changed');
  if (!Number.isInteger(candidate?.id)) throw new Error('focus_target_missing');
  const before = await chrome.tabs.get(candidate.id);
  if (!currentAdmission()) throw new Error('request_owner_changed');
  if (conversationForTab(before) !== conversationId) throw new Error('focus_target_changed');
  // Avoid asking Chrome to repeat a state it already proved. Windows can transiently reject an
  // otherwise redundant activation/focus call while a window is restoring, which used to turn a
  // successfully selected conversation into `focus_failure`.
  let updated = before;
  if (before.active !== true) {
    try {
      updated = await chrome.tabs.update(before.id, { active: true });
      if (!currentAdmission()) throw new Error('request_owner_changed');
    } catch {
      // Chrome occasionally rejects the activation promise after applying it (most often while
      // a large/discarded window is waking). The current tab fact, not that stale rejection, is
      // authoritative. Only accept the race when the exact conversation is now really active.
      const applied = await chrome.tabs.get(before.id);
      if (!currentAdmission()) throw new Error('request_owner_changed');
      if (conversationForTab(applied) !== conversationId || applied.active !== true) throw new Error('focus_tab_rejected');
      updated = applied;
    }
  }
  const current = await chrome.tabs.get(before.id);
  if (!currentAdmission()) throw new Error('request_owner_changed');
  const exact = { ...before, ...updated, ...current };
  if (conversationForTab(exact) !== conversationId || exact.active !== true || !Number.isInteger(exact.windowId)) {
    throw new Error('focus_target_changed');
  }
  const currentWindow = await chrome.windows.get(exact.windowId);
  if (!currentAdmission()) throw new Error('request_owner_changed');
  if (currentWindow?.state === 'minimized' || currentWindow?.focused !== true) {
    const update = currentWindow?.state === 'minimized'
      ? { state: 'normal', focused: true }
      : { focused: true };
    try {
      await chrome.windows.update(exact.windowId, update);
      if (!currentAdmission()) throw new Error('request_owner_changed');
    } catch {
      // As with tab activation, verify whether Chrome performed the requested transition before
      // surfacing a failure. A rejected callback after a successful foreground change is not a
      // reason to strand a usable conversation in browser recovery.
      const applied = await chrome.windows.get(exact.windowId);
      if (!currentAdmission()) throw new Error('request_owner_changed');
      if (applied?.state === 'minimized' || applied?.focused !== true) throw new Error('focus_window_rejected');
    }
  }
  return exact;
}

/**
 * Retries a transient Chrome activation failure without leaving the exact conversation.
 *
 * Each retry requires a fresh complete inventory. Chrome may replace a restoring/discarded tab
 * with a new tab id, so a single unambiguous exact-conversation candidate becomes the next target;
 * two selected-window candidates still fail closed. The short backoff sequence gives Windows time
 * to make that exact page focusable. This never navigates or creates a tab.
 */
async function focusExactConversationTargetWithRetries(candidate, conversationId) {
  if (!Number.isInteger(candidate?.id)) return { target: null, failure: 'focus_failure' };
  let current = candidate;
  for (let attempt = 0; attempt <= OPEN_CONVERSATION_FOCUS_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return { target: await focusExactConversationTarget(current, conversationId), failure: null };
    } catch { /* Revalidate the exact elected tab before the next bounded attempt. */ }
    if (attempt === OPEN_CONVERSATION_FOCUS_RETRY_DELAYS_MS.length) break;
    await new Promise(resolve => setTimeout(resolve, OPEN_CONVERSATION_FOCUS_RETRY_DELAYS_MS[attempt]));
    let tabs;
    try {
      tabs = await exactConversationInventory(conversationId, OPEN_CONVERSATION_FOCUS_RETRY_INVENTORY_TIMEOUT_MS);
    } catch {
      continue;
    }
    const election = electOpenConversationTarget(tabs, conversationId);
    if (election.ambiguous) return { target: null, failure: 'ambiguous_duplicate' };
    if (!election.target) return { target: null, failure: 'focus_failure' };
    current = election.target;
  }
  return { target: null, failure: 'focus_failure' };
}

/** One exact receipt may be published through both the urgent and ordinary status paths. */
const openConversationRequestsInFlight = new Set();

/** Reuses an exact Chrome conversation for the app's explicit Open command. */
async function fulfillOpenConversationRequests(rawRequests) {
  const requests = (Array.isArray(rawRequests) ? rawRequests : [])
    .map(request => ({
      conversationId: cleanConversationId(request?.conversationId),
      requestId: typeof request?.requestId === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(request.requestId) ? request.requestId : null,
      nonce: typeof request?.nonce === 'string' && /^[a-f0-9]{32}$/i.test(request.nonce) ? request.nonce : null
    }))
    .filter(request => request.conversationId && request.requestId && request.nonce)
    .slice(0, 32);
  for (const request of requests) {
    if (openConversationRequestsInFlight.has(request.requestId)) continue;
    openConversationRequestsInFlight.add(request.requestId);
    try {
    const deliveredAt = performance.now();
    const timing = {
      deliveredAt,
      inventoryStartedAt: deliveredAt,
      inventoryCompletedAt: deliveredAt,
      exactMatchAt: deliveredAt,
      actionStartedAt: deliveredAt,
      actionCompletedAt: deliveredAt,
      acknowledgementStartedAt: deliveredAt
    };
    const acknowledge = async completion => {
      timing.acknowledgementStartedAt = performance.now();
      await call('/browser/open-chat', {
        method: 'POST',
        body: JSON.stringify({ ...request, ...completion, timing })
      });
    };
    let tabs;
    try {
      timing.inventoryStartedAt = performance.now();
      // Opening one known conversation must not wake and enumerate hundreds of unrelated ChatGPT
      // pages. Chrome's URL-filtered query is itself a complete inventory for this exact identity.
      // Bare roots are queried separately only so a previously redirected app-owned page may be
      // reclaimed in place; personal roots remain ineligible without our persisted ownership.
      const [exactTabs, bareRoots] = await Promise.all([
        exactConversationInventory(request.conversationId),
        bareRootInventory()
      ]);
      tabs = [...exactTabs, ...bareRoots.filter(tab => !exactTabs.some(exact => exact.id === tab.id))];
      timing.inventoryCompletedAt = performance.now();
    } catch (err) {
      timing.inventoryCompletedAt = performance.now();
      timing.exactMatchAt = timing.actionStartedAt = timing.actionCompletedAt = timing.inventoryCompletedAt;
      await acknowledge({ failure: String(err?.message || err) === 'inventory_timeout' ? 'inventory_timeout' : 'chrome_unavailable' });
      continue;
    }

    const election = electOpenConversationTarget(tabs, request.conversationId);
    timing.exactMatchAt = performance.now();
    if (election.ambiguous) {
      timing.actionStartedAt = timing.actionCompletedAt = performance.now();
      await acknowledge({ failure: 'ambiguous_duplicate' });
      continue;
    }

    let target = election.target;
    let outcome = 'focused';
    let retargeted = false;
    timing.actionStartedAt = performance.now();
    if (!target) {
      const [redirected] = tabs
        .filter(tab => {
          const row = Number.isInteger(tab?.id) ? appOwnedOpeningTabs[String(tab.id)] : null;
          return cleanConversationId(row?.conversationId) === request.conversationId &&
            !tab.pendingUrl && Boolean(exactPlainChatHome(tab.url));
        })
        .sort((a, b) => a.id - b.id);
      if (redirected) {
        const row = appOwnedOpeningTabs[String(redirected.id)];
        try {
          const emptyRoot = await proveEmptyRedirectedConversationRoot(redirected, row);
          if ((Number(row.retargetCount) || 0) >= 2 && row.replacementCreated === true) {
            // The original page spent both safe same-tab retargets and this one replacement.
            // Missing empty-page proof is not permission for a second replacement: report the
            // bounded failure and leave the uncertain page untouched. Once empty proof returns,
            // the durable escalation below can carry the work into a managed continuation.
            if (!emptyRoot) {
              timing.actionCompletedAt = performance.now();
              await acknowledge({ failure: 'conversation_unreachable' });
              continue;
            }
            row.openRequestId = request.requestId;
            row.openState = 'escalated';
            row.escalationNonce = row.escalationNonce || request.nonce;
            await chrome.storage.session.set({ appOwnedOpeningTabs });
            const escalation = await notifyUnreachableConversation(redirected, row, tabs, request)
              .catch(() => 'rejected');
            timing.actionCompletedAt = performance.now();
            await acknowledge({ failure: escalation === 'accepted' ? 'managed_continuation' : 'conversation_unreachable' });
            continue;
          } else if (!emptyRoot) {
            // An explicit user Open must not dead-end merely because the old redirected root may
            // contain a draft or has an unreadable document. The complete inventory above proves
            // there is no real /c/<conversation> tab to duplicate. Leave the uncertain root
            // untouched, detach its stale conversation ownership, and create one exact tab.
            // Ordinary root hygiene will keep or retire the old page only from its own proof.
            if (appOwnedOpeningTabs[String(redirected.id)] === row) {
              delete appOwnedOpeningTabs[String(redirected.id)];
              await chrome.storage.session.set({ appOwnedOpeningTabs });
            }
            target = await createChatTab(
              `https://chatgpt.com/c/${encodeURIComponent(request.conversationId)}`,
              false,
              true,
              request
            );
            outcome = 'opened';
            retargeted = true;
          } else if ((Number(row.retargetCount) || 0) >= 2 && row.replacementCreated !== true) {
            // This episode already spent two distinct, safely proved retargets. One replacement
            // is the bounded escape hatch; the old empty root returns to the existing one-minute
            // cleanup owner and never receives a second send/navigation from this request.
            target = await createChatTab(
              `https://chatgpt.com/c/${encodeURIComponent(request.conversationId)}`,
              false,
              true,
              request
            );
            const replacement = appOwnedOpeningTabs[String(target.id)];
            if (replacement) {
              replacement.retargetCount = 2;
              replacement.replacementCreated = true;
            }
            if (appOwnedOpeningTabs[String(redirected.id)] === row) {
              delete appOwnedOpeningTabs[String(redirected.id)];
              idleRootTabs[String(redirected.id)] = {
                appOwned: true,
                seenAt: Date.now(),
                lastAccessedAt: Number(emptyRoot.tab.lastAccessed) || 0,
                documentId: emptyRoot.source.documentId,
                navigationEpoch: emptyRoot.source.navigationEpoch,
                url: exactPlainChatHome(emptyRoot.tab.url)
              };
            }
            await chrome.storage.session.set({ appOwnedOpeningTabs, idleRootTabs });
            outcome = 'opened';
            retargeted = true;
          } else {
            const prior = {
              openRequestId: row.openRequestId,
              openState: row.openState,
              createdAt: row.createdAt,
              retargetCount: row.retargetCount
            };
            // Persist the one-shot spend before navigation. The second empty-document proof
            // below closes the storage await race; a replay of this request cannot navigate twice.
            row.openRequestId = request.requestId;
            row.openState = 'opening';
            row.createdAt = Date.now();
            row.retargetCount = Math.min(2, (Number(row.retargetCount) || 0) + 1);
            await chrome.storage.session.set({ appOwnedOpeningTabs });
            if (!await proveEmptyRedirectedConversationRoot(redirected, row)) {
              if (appOwnedOpeningTabs[String(redirected.id)] === row) Object.assign(row, prior);
              await chrome.storage.session.set({ appOwnedOpeningTabs });
              timing.actionCompletedAt = performance.now();
              await acknowledge({ failure: 'conversation_unreachable' });
              continue;
            }
            const updated = await chrome.tabs.update(redirected.id, {
              url: `https://chatgpt.com/c/${encodeURIComponent(request.conversationId)}`,
              active: true
            });
            target = { ...redirected, ...updated };
            retargeted = true;
          }
        } catch {
          timing.actionCompletedAt = performance.now();
          await acknowledge({ failure: 'conversation_unreachable' });
          continue;
        }
      } else {
        try {
          target = await createChatTab(
            `https://chatgpt.com/c/${encodeURIComponent(request.conversationId)}`,
            false,
            true,
            request
          );
          outcome = 'opened';
        } catch {
          timing.actionCompletedAt = performance.now();
          await acknowledge({ failure: 'tab_creation_failure' });
          continue;
        }
      }
    } else if (!retargeted) {
      try {
        const targetKey = String(target.id);
        const row = appOwnedOpeningTabs[targetKey];
        const loadingOwedConversation = target.status === 'loading' &&
          cleanConversationId(row?.conversationId) === request.conversationId &&
          conversationFromUrl(target.pendingUrl || target.url) === request.conversationId;
        const shouldRetargetLoading = loadingOwedConversation && row.openRequestId !== request.requestId;
        if (shouldRetargetLoading) {
          if ((Number(row.retargetCount) || 0) >= 2 && row.replacementCreated === true) {
            // Keep the one replacement as the sole owner while it is still an exact `/c/...`
            // load. Only a later freshly-proved bare root may escalate it.
          } else if ((Number(row.retargetCount) || 0) >= 2 && row.replacementCreated !== true) {
            target = await createChatTab(
              `https://chatgpt.com/c/${encodeURIComponent(request.conversationId)}`,
              false,
              true,
              request
            );
            const replacement = appOwnedOpeningTabs[String(target.id)];
            if (replacement) {
              replacement.retargetCount = 2;
              replacement.replacementCreated = true;
            }
            if (appOwnedOpeningTabs[targetKey] === row) delete appOwnedOpeningTabs[targetKey];
            await chrome.storage.session.set({ appOwnedOpeningTabs });
            outcome = 'opened';
            retargeted = true;
            // The old named load is no longer canonical. It is not closed here: ordinary named
            // duplicate cleanup still requires a completed page's own empty/draft proof.
          } else {
            row.openRequestId = request.requestId;
            row.openState = 'opening';
            row.createdAt = Date.now();
            row.retargetCount = Math.min(2, (Number(row.retargetCount) || 0) + 1);
            await chrome.storage.session.set({ appOwnedOpeningTabs });
          }
        }
        if (!retargeted && shouldRetargetLoading &&
            !((Number(row?.retargetCount) || 0) >= 2 && row?.replacementCreated === true)) {
          const updated = await chrome.tabs.update(target.id, {
            url: `https://chatgpt.com/c/${encodeURIComponent(request.conversationId)}`,
            active: true
          });
          target = { ...target, ...updated };
        }
      } catch {
        timing.actionCompletedAt = performance.now();
        await acknowledge({ failure: 'conversation_unreachable' });
        continue;
      }
    }
    const focus = await focusExactConversationTargetWithRetries(target, request.conversationId);
    if (focus.failure) {
      timing.actionCompletedAt = performance.now();
      await acknowledge({ failure: focus.failure });
      continue;
    }
    target = focus.target;
    timing.actionCompletedAt = performance.now();
    await acknowledge({ outcome });

    // A successful focus/open receipt is terminal and should not wait behind duplicate cleanup.
    // The cleanup still uses the existing fresh-document/draft proof, and the chosen target is
    // marked active in this snapshot so it can never retire the tab the user just requested.
    const cleanupTabs = tabs.map(tab => tab.id === target?.id ? { ...tab, active: true } : tab);
    void pruneManagedTabs(cleanupTabs, {
      managedConversations: [request.conversationId],
      retiredConversations: [],
      conversationActivityAt: {}
    }, new Set([request.conversationId]), new Set()).catch(() => undefined);
    } finally {
      openConversationRequestsInFlight.delete(request.requestId);
    }
  }
}

/**
 * Explicit user Open requests must not sit behind grouping, cleanup, input preparation or a
 * maintenance pass that was already running when the click arrived. Read only the durable
 * publication, then use the same inventory/election/acknowledgement owner as normal maintenance.
 * Per-request in-flight fencing inside that owner prevents this fast lane and the next ordinary
 * status pass from acting on the same nonce at once.
 */
const urgentOpenConversationFlights = new Set();
function pumpUrgentOpenConversationRequests() {
  if (companionReloadFlight) return Promise.resolve();
  const work = (async () => {
    const reply = await call('/status');
    if (!reply.ok || !reply.data) return;
    await fulfillOpenConversationRequests(reply.data.openConversationRequests);
  })();
  const tracked = work.finally(() => { urgentOpenConversationFlights.delete(tracked); });
  urgentOpenConversationFlights.add(tracked);
  return tracked;
}

async function transitionManagedTabCloseClaim(action, conversationId, claimId) {
  if ((action !== 'claim' && action !== 'consume') || !cleanConversationId(conversationId) ||
      typeof claimId !== 'string' || !/^[a-f0-9]{32}$/.test(claimId)) return false;
  const reply = await call('/browser/managed-tab-close', {
    method: 'POST',
    body: JSON.stringify({ action, conversationId, claimId }),
    timeoutMs: 5_000
  });
  return reply.ok && reply.data?.allowed === true;
}

/** Retire idle app-owned documents and redundant copies, preserving exact unsent drafts. */
async function pruneManagedTabs(tabs, policy, protectedChats, closable) {
  const retired = new Set((Array.isArray(policy.retiredConversations) ? policy.retiredConversations : []).map(cleanConversationId).filter(Boolean));
  const managed = new Set((Array.isArray(policy.managedConversations) ? policy.managedConversations : []).map(cleanConversationId).filter(Boolean));
  const deleted = new Set((Array.isArray(policy.deletedConversations) ? policy.deletedConversations : [])
    .map(cleanConversationId).filter(Boolean));
  for (const id of closable) managed.add(id);
  const owned = tab => managed.has(conversationForTab(tab));
  // Keep the selected/recent copy. The oldest surplus goes first, independent of query order.
  const ordered = [...tabs].sort((a, b) => Number(b.active === true) - Number(a.active === true) || (b.lastAccessed || 0) - (a.lastAccessed || 0) || a.id - b.id);
  const keeper = new Map();
  for (const tab of ordered) if (owned(tab) && !keeper.has(conversationForTab(tab))) keeper.set(conversationForTab(tab), tab.id);
  const activity = policy.conversationActivityAt || {};
  const workers = new Set((Array.isArray(policy.workerConversations) ? policy.workerConversations : [])
    .map(cleanConversationId).filter(Boolean));
  const finiteOneOffs = new Set((Array.isArray(policy.finiteOneOffConversations) ? policy.finiteOneOffConversations : [])
    .map(cleanConversationId).filter(Boolean));
  const parkedRotation = new Set((Array.isArray(policy.parkedRotationConversations)
    ? policy.parkedRotationConversations : []).map(cleanConversationId).filter(Boolean));
  const superseded = new Set((Array.isArray(policy.supersededConversations)
    ? policy.supersededConversations : []).map(cleanConversationId).filter(Boolean));
  const cancelledHelpers = new Set((Array.isArray(policy.cancelledDecisionClaims) ? policy.cancelledDecisionClaims : [])
    .map(claim => cleanConversationId(claim?.conversationId)).filter(Boolean));
  const backgroundWindow = await (async () => {
    try { return await storedBackgroundWindow(); } catch { return null; }
  })();
  const selectedByUser = (tab, conversationId = conversationForTab(tab)) => tab.active === true &&
    !deleted.has(conversationId) &&
    (tab.windowId !== backgroundWindow?.id || backgroundWindow.focused === true);
  const activeStillSafeToClose = async (tab, conversationId) => {
    if (tab.active !== true) return true;
    // The user already confirmed deletion in the app. Closing this exact page is completion of
    // that action, not background eviction of a readable main chat.
    if (deleted.has(conversationId)) return true;
    // A background window still has one active tab. Only a worker that main has identified may
    // use that exception; an ordinary/Prime chat remains a user's readable tab even when the
    // app originally opened its window and later classified the conversation as terminal.
    if (!workers.has(conversationId)) return false;
    if (tab.windowId !== backgroundWindow?.id || backgroundWindow.focused === true) return false;
    try { return (await chrome.windows.get(backgroundWindow.id)).focused !== true; }
    catch { return false; }
  };
  // Evict by model work/turn completion, never by which browser tab was selected.
  const candidates = ordered.filter(owned).sort((a, b) =>
    Number(keeper.get(conversationForTab(b)) !== b.id) - Number(keeper.get(conversationForTab(a)) !== a.id) ||
    (activity[conversationForTab(a)] || 0) - (activity[conversationForTab(b)] || 0) || a.id - b.id);
  let remaining = [...tabs];
  const selectedSupersededSuccessor = tab => {
    const id = conversationForTab(tab);
    if (!superseded.has(id)) return null;
    const destination = cleanConversationId(policy.supersededSuccessors?.[id]);
    if (!destination || destination === id) return null;
    return remaining.find(other => other.id !== tab.id && other.windowId === tab.windowId &&
      !other.pendingUrl && conversationFromUrl(other.url) === destination) || null;
  };
  for (const tab of candidates) {
    const conversationId = conversationForTab(tab);
    // Main may still advertise its pre-ACK policy while the app is down or the acknowledgement
    // is retrying. The exact local removal receipt spends that authority immediately, so a user
    // reopen cannot be selected for another automatic close in this gap.
    if (superseded.has(conversationId) && supersededSourceRetirementPending(conversationId)) continue;
    if (!Number.isInteger(tab.id) || browserControlsTab(tab.id) || tab.pinned ||
        (selectedByUser(tab) && !selectedSupersededSuccessor(tab))) continue;
    const duplicate = keeper.get(conversationId) !== tab.id && remaining.some(other => other.id !== tab.id && conversationForTab(other) === conversationId);
    // Live work protects the conversation, not an idle surplus document. A duplicate may be
    // retired only after its own content script proves it has no draft or generation; the
    // selected/active keeper and every non-duplicate live tab remain untouched.
    if (protectedChats.has(conversationId) && (!duplicate || deleted.has(conversationId))) continue;
    // A named Prime/main conversation is normally user browser state. Rotation is the narrow
    // exception: the app explicitly parked this durable chat until a later batch, and the same
    // selected/pinned/draft/generation/document proof still runs before Chrome may close it.
    if (!duplicate && !workers.has(conversationId) && !finiteOneOffs.has(conversationId) && !cancelledHelpers.has(conversationId) &&
        !deleted.has(conversationId) && !parkedRotation.has(conversationId) &&
        !superseded.has(conversationId)) continue;
    // App policy can release an idle page without retiring its durable worker/chat.
    // Keep the selected page for reading; terminal/duplicate cleanup keeps its own rules.
    if (!duplicate && !retired.has(conversationId) && !closable.has(conversationId)) continue;
    const deletionClose = deleted.has(conversationId) && closable.has(conversationId);
    if (deleted.has(conversationId) && !deletionClose) continue;
    const requiresManagedClaim = deletionClose ||
      !duplicate && (workers.has(conversationId) || finiteOneOffs.has(conversationId)) && closable.has(conversationId);
    const managedCloseClaim = requiresManagedClaim
      ? policy?.managedTabCloseClaims?.[conversationId] ?? policy?.workerTabCloseClaims?.[conversationId]
      : null;
    if (requiresManagedClaim &&
        (typeof managedCloseClaim !== 'string' || !/^[a-f0-9]{32}$/.test(managedCloseClaim))) continue;
    const idlePage = !duplicate && !retired.has(conversationId);
    if (idlePage && selectedByUser(tab) && !selectedSupersededSuccessor(tab)) continue;
    const source = { tab: tab.id, documentId: tabDocuments[String(tab.id)], navigationEpoch: tabEpochs[String(tab.id)] };
    if (!ownsDocument(source) || journalCountForConversation(conversationId) > 0) continue;
    const cancelledClaims = (Array.isArray(policy.cancelledDecisionClaims) ? policy.cancelledDecisionClaims : [])
      .filter(claim => claim.conversationId === conversationId);
    const cancelledDecisions = cancelledClaims.filter(claim => claim.owner === `${source.tab}:${source.documentId}:${source.navigationEpoch}`);
    // Cancellation names a document, not every future tab that happens to reopen its chat.
    if (cancelledClaims.length && !cancelledDecisions.length) continue;
    try {
      const current = await chrome.tabs.get(tab.id);
      if (current.pinned || (!await activeStillSafeToClose(current, conversationId) &&
          !selectedSupersededSuccessor(current)) || conversationFromUrl(current.url) !== conversationId || current.pendingUrl) continue;

      const proof = await tabReply(tab.id, { type: 'clf-tab-close-check', conversationId,
        ...(deletionClose ? { deletedConversationId: conversationId } : {}),
        ...(cancelledDecisions.length ? { cancelledDecisions } : {}) }, { documentId: source.documentId });
      if (proof?.safe !== true || proof.conversationId !== conversationId || proof.navigationEpoch !== source.navigationEpoch || !ownsDocument(source)) continue;
      const latest = await chrome.tabs.get(tab.id);
      if (latest.pinned || (!await activeStillSafeToClose(latest, conversationId) &&
          !selectedSupersededSuccessor(latest)) || latest.pendingUrl || conversationFromUrl(latest.url) !== conversationId || !ownsDocument(source) || journalCountForConversation(conversationId) > 0) continue;

      // Chrome must never remove the user's selected source out from under them. Only a durable
      // A -> B handoff with B present in this same window may move selection, after the source
      // page has proved no draft/generation and before the final fresh removal inventory.
      if (latest.active === true && !await activeStillSafeToClose(latest, conversationId)) {
        const successor = selectedSupersededSuccessor(latest);
        if (!successor) continue;
        try {
          const confirmed = await chrome.tabs.get(successor.id);
          if (confirmed.windowId !== latest.windowId || confirmed.pendingUrl ||
              conversationFromUrl(confirmed.url) !== conversationFromUrl(successor.url)) continue;
          await chrome.tabs.update(confirmed.id, { active: true });
        } catch { continue; }
      }

      const finalCloseGuard = async () => {
        const candidate = await chrome.tabs.get(tab.id);
        if (candidate.pinned || candidate.pendingUrl ||
            conversationFromUrl(candidate.url) !== conversationId || !ownsDocument(source) ||
            journalCountForConversation(conversationId) > 0) return false;
        const finalProof = await tabReply(tab.id, { type: 'clf-tab-close-check', conversationId,
          ...(deletionClose ? { deletedConversationId: conversationId } : {}),
          ...(cancelledDecisions.length ? { cancelledDecisions } : {}) }, { documentId: source.documentId });
        if (finalProof?.safe !== true || finalProof.conversationId !== conversationId ||
            finalProof.navigationEpoch !== source.navigationEpoch || !ownsDocument(source)) return false;
        const newest = await chrome.tabs.get(tab.id);
        if (newest.pinned || newest.pendingUrl || conversationFromUrl(newest.url) !== conversationId ||
            !await activeStillSafeToClose(newest, conversationId)) return false;
        const fresh = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
        const queried = fresh.find(other => other?.id === tab.id);
        let finalTabs = fresh;
        let finalWindow = null;
        if (typeof chrome.windows.getAll === 'function') {
          const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
          if (!Array.isArray(windows)) return false;
          finalTabs = windows.flatMap(window => Array.isArray(window?.tabs) ? window.tabs : []);
          finalWindow = windows.find(window => window?.id === tab.windowId) || null;
        }
        const current = finalTabs.find(other => other?.id === tab.id);
        const activeBackgroundWorker = current?.active === true && workers.has(conversationId) &&
          Number.isInteger(backgroundWindow?.id) && current.windowId === backgroundWindow.id &&
          finalWindow?.id === backgroundWindow.id && finalWindow.focused === false;
        const activeDeleted = current?.active === true && deleted.has(conversationId);
        // No await after the coherent window/tab inventory: candidate identity, selection,
        // document/epoch, journal and another exact named survivor are one removal decision.
        const safe = Boolean(queried) && Boolean(current) &&
          (current.active !== true || activeBackgroundWorker || activeDeleted) && !current.pinned && !current.pendingUrl &&
          conversationFromUrl(current.url) === conversationId && ownsDocument(source) &&
          journalCountForConversation(conversationId) === 0 && !browserControlsTab(tab.id) &&
          (!duplicate || finalTabs.some(other => Number.isInteger(other?.id) && other.id !== tab.id &&
            !other.pendingUrl && conversationFromUrl(other.url) === conversationId));
        if (!safe) return false;
        if (managedCloseClaim &&
            !await transitionManagedTabCloseClaim('consume', conversationId, managedCloseClaim)) return false;
        // No asynchronous browser work after consume: navigation/document activity and control
        // leases can still revoke the exact source synchronously before tabs.remove is invoked.
        return ownsDocument(source) && journalCountForConversation(conversationId) === 0 &&
          !browserControlsTab(tab.id);
      };
      if (!await retireAutomaticTab(tab.id, async () => {
        if (managedCloseClaim &&
            !await transitionManagedTabCloseClaim('claim', conversationId, managedCloseClaim)) return false;
        // Worker/finite closes retain their existing ordering. A deleted close re-proves the
        // page and consumes Main's current tombstone authority after the storage await instead.
        return deletionClose ? ownsDocument(source) && journalCountForConversation(conversationId) === 0 &&
          !browserControlsTab(tab.id) : finalCloseGuard();
      }, superseded.has(conversationId) ? 'superseded-source' : null,
      deletionClose ? finalCloseGuard : null)) continue;
      console.info(
        workers.has(conversationId)
          ? '[Chat On Steroids] closed one proven-safe stopped worker tab'
          : '[Chat On Steroids] closed one proven-safe managed chat tab',
        tab.id,
        duplicate ? 'duplicate' : deletionClose ? 'deleted' : 'released'
      );
      remaining = remaining.filter(other => other.id !== tab.id);
    } catch { /* Missing document, navigation or unreadable draft state is not close permission. */ }
  }
  return remaining;
}

/** Groups only exact app-managed ChatGPT tabs, without moving or adopting personal tabs. */
async function organizeManagedTabs(tabs, policy, additiveOnly = false) {
  if (typeof chrome.tabs.group !== 'function' || !chrome.tabGroups ||
      typeof chrome.tabGroups.query !== 'function' || typeof chrome.tabGroups.update !== 'function') return;
  const managed = new Set((Array.isArray(policy.managedConversations) ? policy.managedConversations : [])
    .map(cleanConversationId).filter(Boolean));
  const workers = new Set((Array.isArray(policy.workerConversations) ? policy.workerConversations : [])
    .map(cleanConversationId).filter(Boolean));
  // Group helpers alongside finite workers without changing delivery or cleanup roles.
  for (const id of (Array.isArray(policy.helperConversations) ? policy.helperConversations : [])) {
    const exact = cleanConversationId(id);
    if (exact && managed.has(exact)) workers.add(exact);
  }
  const activeCommands = new Set((Array.isArray(policy.browserCommandIds) ? policy.browserCommandIds : [])
    .map(exactBridgeCommandId).filter(Boolean));
  const attentionCommands = new Set(
    (Array.isArray(policy.browserAttentionCommandIds) ? policy.browserAttentionCommandIds : [])
      .map(exactBridgeCommandId).filter(Boolean)
  );
  const opening = new Set();
  const attention = new Set();
  for (const tab of tabs) {
    const marker = ownedCommandRootMarker(tab);
    if (!marker || !Number.isInteger(tab?.id)) continue;
    if (attentionCommands.has(marker) || !activeCommands.has(marker)) attention.add(tab.id);
    else opening.add(tab.id);
  }
  const queueOrRecovery = new Set([...opening, ...attention]);
  const cleanupCustody = new Set([
    ...Object.keys(idleRootTabs).map(Number),
    ...Object.keys(appOwnedOpeningTabs).map(Number)
  ].filter(Number.isInteger));
  const now = Date.now();
  for (const tab of tabs) {
    const row = Number.isInteger(tab?.id) ? appOwnedOpeningTabs[String(tab.id)] : null;
    if (!row || !cleanConversationId(row.conversationId) || !exactPlainChatHome(tab.url) || tab.pendingUrl) continue;
    if (row.openState === 'opening' || now - (Number(row.createdAt) || 0) < IDLE_ROOT_CLOSE_MS) {
      queueOrRecovery.add(tab.id);
    }
  }
  const category = tab => {
    if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) return null;
    // A concrete managed conversation identity is stronger than a stale opening/recovery
    // marker. In particular, a worker that has already bound must live with Workers instead of
    // lingering forever in Queue & Recovery because its original command root still exists.
    // Grouping is visible browser truth, so a plain ChatGPT home must never inherit its old
    // `/c/<id>` category from the reload-era tab registry. That fallback is useful for routing a
    // transient reload, but using it for layout left redirected roots inside `CoS Chats` and one
    // stale group in every Chrome window. A pending named route still counts while it loads.
    const conversation = !tab.pendingUrl && exactPlainChatHome(tab.url)
      ? null
      : conversationForTab(tab);
    if (managed.has(conversation)) return workers.has(conversation) ? 'worker' : 'chat';
    // Transport/recovery roots are short-lived browser plumbing, not user work. Keeping them in
    // Queue/Recovery or Empty/Cleanup groups made those groups look permanent and, during an
    // additive recovery pass, deliberately prevented them from ever being dissolved. Leave roots
    // ungrouped for their bounded proof window; the existing root-cleanup owner closes them.
    return null;
  };
  const managedTitles = new Set([
    'CoS Chats', 'CoS Workers', 'CoS Queue & Recovery', 'CoS Empty / Cleanup',
    'CoS Opening', 'CoS Needs Attention'
  ]);
  const legacyTransientTitles = new Set([
    'CoS Queue & Recovery', 'CoS Empty / Cleanup', 'CoS Opening', 'CoS Needs Attention'
  ]);
  const owned = tabs.filter(tab => category(tab));
  const tabById = new Map(tabs.filter(tab => Number.isInteger(tab?.id)).map(tab => [tab.id, tab]));
  let provenanceChanged = false;

  // Upgrade older layouts only when every member of the named group is in the exact current
  // managed inventory. A lookalike group containing even one personal tab is never adopted.
  let groups = [];
  try { groups = await chrome.tabGroups.query({}); } catch { return; }
  const membersFor = new Map();
  for (const group of groups) {
    if (!managedTitles.has(group.title)) continue;
    let members;
    try { members = await chrome.tabs.query({ groupId: group.id }); } catch { members = null; }
    membersFor.set(group.id, members);
    if (Array.isArray(members)) {
      for (const tab of members) if (Number.isInteger(tab?.id) && !tabById.has(tab.id)) tabById.set(tab.id, tab);
    }
    if (!Array.isArray(members) || !members.length || members.some(tab => !category(tab))) continue;
    for (const tab of members) {
      if (browserControlsTab(tab.id)) continue;
      const next = { groupId: group.id, windowId: tab.windowId, category: category(tab) };
      if (JSON.stringify(cosGroupedTabs[String(tab.id)]) !== JSON.stringify(next)) {
        cosGroupedTabs[String(tab.id)] = next;
        provenanceChanged = true;
      }
    }
  }

  const legacyTitleCount = new Map();
  for (const group of groups) {
    if (legacyTransientTitles.has(group.title)) {
      legacyTitleCount.set(group.title, (legacyTitleCount.get(group.title) || 0) + 1);
    }
  }

  // An extension/browser update can preserve Chrome's visible groups while losing the older
  // per-tab grouping ledger. Recover only the unambiguous duplicate case, and only after every
  // member proves it is the same unchanged, empty ChatGPT root document. This lets an upgrade
  // dissolve two orphaned CoS cleanup groups without adopting or moving a similarly named user
  // group, and without touching a draft, conversation, pinned tab or navigating page.
  const provedOrphanedDuplicateLegacyGroup = async (group, members) => {
    if ((legacyTitleCount.get(group.title) || 0) < 2 || !members.length) return false;
    for (const tab of members) {
      if (!Number.isInteger(tab?.id) || browserControlsTab(tab.id) || tab.pinned || tab.pendingUrl ||
          !exactIdleChatHome(tab.url) || conversationFromUrl(tab.url)) return false;
      const source = { tab: tab.id, documentId: tabDocuments[String(tab.id)], navigationEpoch: tabEpochs[String(tab.id)] };
      if (!ownsDocument(source)) return false;
      const proof = await tabReply(tab.id, { type: 'clf-tab-close-check', conversationId: null },
        { documentId: source.documentId });
      let latest = null;
      try { latest = await chrome.tabs.get(tab.id); } catch { return false; }
      if (proof?.safe !== true || proof.conversationId !== null || proof.navigationEpoch !== source.navigationEpoch ||
          !ownsDocument(source) || !latest || latest.pinned || latest.pendingUrl || latest.url !== tab.url ||
          latest.groupId !== group.id) return false;
    }
    return true;
  };

  // Queue/Recovery and Empty/Cleanup were presentation-only buckets. Retire those legacy groups
  // even while recovery keeps ordinary chat/worker grouping additive. Every member must still
  // have exact extension provenance or current root custody, so a similarly named personal group
  // remains untouched. Chrome deletes the now-empty group itself after ungrouping.
  if (typeof chrome.tabs.ungroup === 'function') {
    for (const group of groups) {
      if (!legacyTransientTitles.has(group.title)) continue;
      const members = membersFor.get(group.id);
      if (!Array.isArray(members) || !members.length) continue;
      const exactOwned = members.every(tab => Number.isInteger(tab?.id) && !browserControlsTab(tab.id) &&
        (Boolean(cosGroupedTabs[String(tab.id)]) || cleanupCustody.has(tab.id) ||
          queueOrRecovery.has(tab.id) || Boolean(ownedCommandRootMarker(tab))));
      if (!exactOwned && !await provedOrphanedDuplicateLegacyGroup(group, members)) continue;
      try {
        await chrome.tabs.ungroup(members.map(tab => tab.id));
        for (const tab of members) {
          tab.groupId = -1;
          delete cosGroupedTabs[String(tab.id)];
          provenanceChanged = true;
        }
      } catch { /* A closing/navigation race is reconsidered by the next maintenance pass. */ }
    }
  }

  // A tab that left policy remains safe to ungroup only when this exact browser-session tab id
  // was grouped by us. This dissolves obsolete CoS groups without touching similarly named
  // personal groups or their unproven members.
  if (typeof chrome.tabs.ungroup === 'function') {
    for (const [key, row] of Object.entries(cosGroupedTabs)) {
      const tab = tabById.get(Number(key));
      const group = groups.find(candidate => candidate.id === tab?.groupId);
      if (!tab) {
        delete cosGroupedTabs[key];
        provenanceChanged = true;
        continue;
      }
      if (browserControlsTab(tab.id)) continue;
      if (category(tab) && group && managedTitles.has(group.title)) continue;
      // Active recovery keeps ordinary named work additive, but a proved transient root must
      // leave any visible CoS group immediately or the stale category survives indefinitely.
      if (additiveOnly && category(tab)) continue;
      if (group && managedTitles.has(group.title)) {
        try { await chrome.tabs.ungroup([tab.id]); tab.groupId = -1; }
        catch { continue; }
      }
      delete cosGroupedTabs[key];
      provenanceChanged = true;
    }
  }

  if (!owned.length) {
    if (provenanceChanged) await persistLive().catch(() => undefined);
    return;
  }

  groups = [];
  try { groups = await chrome.tabGroups.query({}); } catch { return; }
  let groupMembers = new Map();
  for (const group of groups) {
    try { groupMembers.set(group.id, await chrome.tabs.query({ groupId: group.id })); }
    catch { groupMembers.set(group.id, null); }
  }

  // Chrome groups are window-scoped. The older custom layout treated that API constraint as
  // permission to create another visible `CoS Chats` group in every window. Once two exact
  // app-owned chat groups exist, converge their inactive members into the focused chat window
  // (or the group with the most real conversations) exactly once. The selected tab in a focused
  // source window stays where the user is reading it, but is ungrouped so it cannot keep a second
  // same-name group alive; a later pass can move it after focus leaves. Bare homes are excluded by
  // `category()` and follow Queue/Cleanup instead, so this never moves an empty retry root as work.
  const existingChatGroups = groups.filter(group => group.title === 'CoS Chats' &&
    Array.isArray(groupMembers.get(group.id)) && groupMembers.get(group.id).some(tab => category(tab) === 'chat'));
  if (existingChatGroups.length > 1 && typeof chrome.tabs.move === 'function') {
    const chatTabs = owned.filter(tab => category(tab) === 'chat' && !tab.pinned && !browserControlsTab(tab.id));
    let focusedChatWindowId = null;
    if (chrome.windows && typeof chrome.windows.get === 'function') {
      for (const tab of chatTabs.filter(candidate => candidate.active === true)) {
        try {
          if ((await chrome.windows.get(tab.windowId))?.focused === true) {
            focusedChatWindowId = tab.windowId;
            break;
          }
        } catch { /* A disappearing window cannot become canonical. */ }
      }
    }
    const rankedChatGroups = existingChatGroups
      .map(group => ({
        group,
        exact: groupMembers.get(group.id).filter(tab => category(tab) === 'chat').length
      }))
      .sort((a, b) => b.exact - a.exact || a.group.id - b.group.id);
    const canonicalChatWindowId = focusedChatWindowId ?? rankedChatGroups[0]?.group.windowId ?? null;
    if (Number.isInteger(canonicalChatWindowId)) {
      for (const tab of chatTabs.filter(candidate => candidate.windowId !== canonicalChatWindowId)) {
        try {
          const current = await chrome.tabs.get(tab.id);
          if (category(current) !== 'chat' || current.pinned || browserControlsTab(current.id) ||
              current.windowId === canonicalChatWindowId) continue;
          let focused = false;
          if (current.active === true && chrome.windows && typeof chrome.windows.get === 'function') {
            try { focused = (await chrome.windows.get(current.windowId))?.focused === true; }
            catch { focused = true; }
          }
          if (focused) {
            const currentGroup = groups.find(group => group.id === current.groupId);
            const exactOwnedGroup = currentGroup?.title === 'CoS Chats' &&
              Array.isArray(groupMembers.get(currentGroup.id)) &&
              groupMembers.get(currentGroup.id).every(member => category(member) === 'chat');
            if (exactOwnedGroup && typeof chrome.tabs.ungroup === 'function') {
              await chrome.tabs.ungroup([current.id]);
              current.groupId = -1;
              tab.groupId = -1;
              delete cosGroupedTabs[String(current.id)];
              provenanceChanged = true;
            }
            continue;
          }
          const moved = await chrome.tabs.move(current.id, { windowId: canonicalChatWindowId, index: -1 });
          Object.assign(tab, Array.isArray(moved) ? moved[0] : moved, {
            windowId: canonicalChatWindowId,
            groupId: -1
          });
          delete cosGroupedTabs[String(current.id)];
          provenanceChanged = true;
        } catch { /* A navigation/window race is retried from a fresh inventory next pass. */ }
      }
      // Moving a tab can delete its now-empty source group. Re-read once so the grouping pass
      // never targets a group id Chrome has already retired.
      try {
        groups = await chrome.tabGroups.query({});
        groupMembers = new Map();
        for (const group of groups) {
          try { groupMembers.set(group.id, await chrome.tabs.query({ groupId: group.id })); }
          catch { groupMembers.set(group.id, null); }
        }
      } catch { return; }
    }
  }
  // Keep every managed tab in the Chrome window where the user or browser created it. Moving a
  // live tab across windows makes Chrome detach and reattach it, which looks like the entire tab
  // strip is being deleted and rebuilt and can race ChatGPT's already fragile page loading.
  // Each existing window gets at most one group per category instead. Pinned/debugger-owned tabs
  // remain loose because Chrome may reject grouping them while another owner is controlling it.
  // Recovery roots are deliberately absent here. Only durable main chats and workers get visible
  // groups; transient roots remain loose until the cleanup owner closes them.
  const groupableWork = owned.filter(tab => !browserControlsTab(tab.id) && !tab.pinned);
  const workWindowIds = [...new Set(groupableWork.map(tab => tab.windowId))]
    .filter(Number.isInteger).sort((a, b) => a - b);
  const canonicalGroupIds = new Set();
  for (const windowId of workWindowIds) {
    const windowOwned = groupableWork.filter(tab => tab.windowId === windowId);
    const windowOwnedIds = new Set(windowOwned.map(tab => tab.id));
    for (const bucket of [
      { key: 'chat', title: 'CoS Chats', color: 'blue' },
      { key: 'worker', title: 'CoS Workers', color: 'purple' }
    ]) {
      const eligibleGroups = groups
        .filter(row => row.windowId === windowId && row.title === bucket.title &&
          !canonicalGroupIds.has(row.id))
        .map(row => ({ row, members: groupMembers.get(row.id) }))
        .filter(candidate => Array.isArray(candidate.members) && candidate.members.every(tab =>
          additiveOnly
            ? (cosGroupedTabs[String(tab?.id)]?.category === bucket.key || category(tab) === bucket.key)
            : windowOwnedIds.has(tab?.id)))
        .sort((a, b) => {
          const aMatches = a.members.filter(tab => category(tab) === bucket.key).length;
          const bMatches = b.members.filter(tab => category(tab) === bucket.key).length;
          return bMatches - aMatches || a.row.id - b.row.id;
        });
      const group = eligibleGroups[0]?.row || null;
      const duplicateGroupIds = new Set(eligibleGroups.map(candidate => candidate.row.id));
      // During active recovery, ordinary reclassification still waits so tabs do not bounce
      // between buckets. Exact duplicate CoS groups of the *same* category are different: leaving
      // them split forever multiplies groups during sustained recovery. Merge those proven-owned
      // members once into the chosen canonical group, without moving any tab across windows.
      const target = windowOwned.filter(tab => category(tab) === bucket.key &&
        (!additiveOnly || !Number.isInteger(tab.groupId) || tab.groupId < 0 ||
          (managedTitles.has(groups.find(candidate => candidate.id === tab.groupId)?.title) &&
            groups.find(candidate => candidate.id === tab.groupId)?.title !== bucket.title) ||
          (duplicateGroupIds.size > 1 && duplicateGroupIds.has(tab.groupId) && tab.groupId !== group?.id)));
      if (!target.length) {
        if (group) canonicalGroupIds.add(group.id);
        continue;
      }
      const tabIds = target.map(tab => tab.id);
      const alreadyTogether = group && target.every(tab => tab.groupId === group.id);
      try {
        const groupId = alreadyTogether ? group.id : await chrome.tabs.group({
          tabIds,
          ...(group ? { groupId: group.id } : {})
        });
        canonicalGroupIds.add(groupId);
        // Maintenance owns classification, not the user's expanded/collapsed layout.
        // Avoid redundant writes to existing groups and only choose expansion on creation.
        if (!group || group.title !== bucket.title || group.color !== bucket.color) {
          await chrome.tabGroups.update(groupId, {
            title: bucket.title,
            color: bucket.color,
            ...(!group ? { collapsed: false } : {})
          });
        }
        for (const tab of target) {
          tab.groupId = groupId;
          const next = { groupId, windowId, category: bucket.key };
          if (JSON.stringify(cosGroupedTabs[String(tab.id)]) !== JSON.stringify(next)) {
            cosGroupedTabs[String(tab.id)] = next;
            provenanceChanged = true;
          }
        }
      } catch { /* Unsupported browser state is retried by the next ordinary maintenance pass. */ }
    }
  }

  if (!additiveOnly && typeof chrome.tabs.ungroup === 'function') {
    let afterGroups = [];
    try { afterGroups = await chrome.tabGroups.query({}); } catch { afterGroups = []; }
    for (const group of afterGroups) {
      if (!managedTitles.has(group.title) || canonicalGroupIds.has(group.id)) continue;
      let members;
      try { members = await chrome.tabs.query({ groupId: group.id }); } catch { continue; }
      const exactOwnedIds = members
        .filter(tab => cosGroupedTabs[String(tab?.id)] && !browserControlsTab(tab.id))
        .map(tab => tab.id);
      if (!exactOwnedIds.length) continue;
      try {
        await chrome.tabs.ungroup(exactOwnedIds);
        for (const id of exactOwnedIds) {
          const tab = tabById.get(id);
          if (tab) tab.groupId = -1;
          delete cosGroupedTabs[String(id)];
          provenanceChanged = true;
        }
      } catch { /* Exact-owned tabs are reconsidered by the next maintenance pass. */ }
    }
  }
  if (provenanceChanged) await persistLive().catch(() => undefined);
}

/**
 * Retires only exact bare ChatGPT homes without waiting for the app or a broad tab inventory.
 *
 * This is not another scheduler or cleanup authority: the existing maintenance alarm calls the
 * existing idle-root state machine. The narrow query merely lets that state machine make its
 * bounded pass even when `/status` or Chrome's broad ChatGPT inventory is unavailable.
 */
async function maintainBareRootHygiene() {
  let tabs;
  let protection;
  try {
    tabs = await bareRootInventory();
    protection = await currentRootOpeningProtection(null);
  } catch {
    return false;
  }
  // A failed explicit Open request owns no command/input payload, so it does not need Core's
  // `/status` projection before cleanup. Once its handler is no longer running and the existing
  // handoff grace has elapsed, the ordinary app-owned proof can retire the exact empty root even
  // when Core or Chrome's broad inventory is busy. This is the same cleanup owner and alarm—not
  // another timer or watchdog. The in-flight fence prevents a concurrent Open handler losing the
  // page it is still focusing or retargeting.
  for (const [key, row] of Object.entries(appOwnedOpeningTabs)) {
    if (openConversationRequestsInFlight.has(row?.openRequestId)) {
      const tabId = Number(key);
      if (Number.isInteger(tabId)) protection.tabs.add(tabId);
    }
  }
  tabs = await cleanupAppOwnedRootTabs(
    tabs,
    null,
    null,
    protection.tabs,
    protection.markers,
    { completeInventory: false, conversationRootsOnly: true }
  );
  for (const key of Object.keys(appOwnedOpeningTabs)) {
    const tabId = Number(key);
    if (Number.isInteger(tabId)) protection.tabs.add(tabId);
  }
  await cleanupIdleRootTabs(tabs, {
    completeInventory: false,
    exactBareOnly: true,
    protectedTabs: protection.tabs
  });
  return true;
}

/**
 * One coalesced browser-hygiene pass for the status snapshot.
 *
 * This intentionally runs before desktop-input preparation. A native New Chat transition can
 * spend its full bounded timeout, and older code made every root cleanup and group update wait
 * behind up to fifty such preparations. Hygiene uses only the already-fetched policy and fresh
 * Chrome/document proof; it does not create or deliver work.
 */
async function maintainTabHygiene(policy, nonDiscardable, closable, additiveOrganization = false) {
  let tabs;
  try {
    tabs = await cleanupConversationInventory();
  } catch {
    return { complete: false, attentionWork: false };
  }
  const protection = await currentRootOpeningProtection(policy);
  const protectedOpeningTabs = protection.tabs;
  const protectedOpeningMarkers = protection.markers;
  tabs = await cleanupAppOwnedRootTabs(
    tabs,
    policy.browserCommandIds,
    policy.browserAttentionCommandIds,
    protectedOpeningTabs,
    protectedOpeningMarkers
  );
  if (Object.keys(idleRootTabs).length > 0) {
    const idleProtection = new Set(protectedOpeningTabs);
    for (const key of Object.keys(appOwnedOpeningTabs)) {
      const tabId = Number(key);
      if (Number.isInteger(tabId)) idleProtection.add(tabId);
    }
    tabs = await cleanupIdleRootTabs(tabs, { protectedTabs: idleProtection });
  }
  const attentionWork = tabs.some(tab => ownedCommandRootMarker(tab));
  tabs = await pruneManagedTabs(tabs, policy, nonDiscardable, closable);
  // A repair/open pass is actively changing URLs and document ownership. Keep adding newly
  // proven managed tabs to their same-window groups, but defer all ungrouping/reclassification;
  // that makes recovered main chats visible without recreating the old group-strip churn.
  await organizeManagedTabs(tabs, policy, additiveOrganization);

  const mainConversations = new Set(
    (Array.isArray(policy.mainConversations) ? policy.mainConversations : [])
      .map(cleanConversationId)
      .filter(Boolean)
  );
  const protectionWork = nonDiscardable.size > 0 || Object.keys(discardProtectedTabs).length > 0 ||
    Object.keys(protectedMainTabs).length > 0;
  if (protectionWork) {
    let changed = false;
    for (const tab of tabs) {
      if (!Number.isInteger(tab && tab.id)) continue;
      const key = String(tab.id);
      const ours = discardProtectedTabs[key] === true;
      const conversation = conversationForTab(tab);
      const opening = ours && !conversation && /[?&#]clf=/.test(tab.pendingUrl || tab.url || '');
      const protect = browserControlsTab(tab.id) || opening || nonDiscardable.has(conversation);
      const protectedMain = Boolean(conversation) && nonDiscardable.has(conversation) &&
        mainConversations.has(conversation);
      if (protectedMain && protectedMainTabs[key] !== conversation) {
        protectedMainTabs[key] = conversation;
        changed = true;
      } else if (!protectedMain && Object.prototype.hasOwnProperty.call(protectedMainTabs, key)) {
        delete protectedMainTabs[key];
        changed = true;
      }
      if (protect && tab.autoDiscardable !== false) {
        try {
          await chrome.tabs.update(tab.id, { autoDiscardable: false });
          if (!ours) {
            discardProtectedTabs[key] = true;
            changed = true;
          }
        } catch {
          // The tab changed after the scan. Its lifecycle event or the next pass reconciles it.
        }
      } else if (!protect && ours) {
        try {
          await chrome.tabs.update(tab.id, { autoDiscardable: true });
          delete discardProtectedTabs[key];
          changed = true;
        } catch {
          // Keep ownership so a transient failure cannot leave the tab protected forever.
        }
      }
    }
    if (changed) await persistLive().catch(() => undefined);
  }
  return { complete: true, attentionWork };
}

function maintain(woken = false) {
  // Do not acquire helper/opening custody after reload's retained-owner snapshot. This is
  // a transient admission hold only; no command/input is claimed, failed, ACKed or dequeued.
  if (companionReloadFlight) return maintenanceFlight || Promise.resolve();
  // Alarm, observation-drain and startup can arrive while tabs.create is awaiting Chrome.
  // Share the whole scan/create pass so one outbox UUID cannot acquire two tabs before ACK.
  if (maintenanceFlight) { maintenanceAgain ||= woken; return maintenanceFlight; }
  maintenanceFlight = (async () => {
    do { maintenanceAgain = false; await maintainOnce(); } while (maintenanceAgain);
  })().finally(() => { maintenanceFlight = null; });
  return maintenanceFlight;
}

/**
 * Pairs a worker that has no token yet, unless the user disconnected it on purpose.
 *
 * Reloading an unpacked extension can give it a new id and empty local storage. Previously only
 * the popup or ChatGPT page traffic reached `/pair`, so that worker could remain inactive while
 * its already-open chats lost their recorder. Reuse the existing provision, wake-channel and
 * recorder-restoration owners; this adds no second connection loop.
 */
async function ensurePaired() {
  if (unassignedHistoryUncertain) return false;
  if (token !== null || disconnected) return false;
  const result = await provision();
  if (!result || !result.ok) return false;
  try { connectWakeSocket(); } catch { /* The next maintenance pass attaches it. */ }
  await restoreOpenChatgptTabs().catch(() => undefined);
  return true;
}

async function maintainOnce() {
  // Exact bare-root cleanup is browser-local resource hygiene, not app work. Keep it alive
  // while explicitly disconnected so Disconnect still blocks delivery/opening without leaving
  // abandoned ChatGPT homes resident forever. Debugger leases are restored first, so a page
  // under browser control is never mistaken for an idle root after MV3 suspension.
  const browserLeasesReady = await hydrateBrowserControlLeases();
  // The app decides whether there is recovery work; a worker holding no tabs is not a worker
  // with nothing to do, it is the one that has to open the chat the app is owed.
  if (token === null && (!(await ensurePaired().catch(() => false)) || token === null)) {
    if (browserLeasesReady) await maintainBareRootHygiene();
    return;
  }
  // The broader app-owned cleanup and grouping below still require a live app policy.
  let observedTabs = [];
  let inventoryComplete = false;
  try {
    observedTabs = await openConversationInventory();
    inventoryComplete = true;
    await adoptMarkedAppOwnedTabs(observedTabs);
  } catch { /* Status/recovery still runs; no unobserved tab is pruned. */ }
  const openConversations = [...new Set(observedTabs.map(conversationForTab).filter(Boolean))];
  const authState = inventoryComplete ? await browserAuthenticationState(observedTabs) : 'unknown';
  // An updated MV3 worker can coexist with a healthy older page recorder. Do not acquire
  // rotation custody until its source inventory has positively answered the new capability.
  const freshTurnProtocol = inventoryComplete ? await freshTurnInventoryProtocol(observedTabs) : undefined;
  // Only a successful all-tab inventory may retire stale app-side page liveness. Treating a
  // failed Chrome query as an authoritative empty browser is how a transient API failure can
  // otherwise detach every active chat at once.
  const reply = await call('/status', {
    method: 'POST',
    body: JSON.stringify({ openConversations, inventoryComplete, authState, freshTurnProtocol })
  });
  if (!reply.ok || !reply.data) {
    if (browserLeasesReady) await maintainBareRootHygiene();
    return;
  }
  latestBrowserAttentionCommandIds = [...new Set(
    (Array.isArray(reply.data.browserAttentionCommandIds) ? reply.data.browserAttentionCommandIds : [])
      .map(commandMarkerId)
      .filter(Boolean)
  )].slice(0, 200);
  if (inventoryComplete && latestBrowserAttentionCommandIds.length > 0) {
    await rearmStrippedAttentionCommandRoots(observedTabs, latestBrowserAttentionCommandIds);
  }
  connectWakeSocket();
  void pumpBrowserControl().catch(() => undefined);
  const publishedInputs = Array.isArray(reply.data.inputs) ? reply.data.inputs : [];
  const userRequestedInputIds = new Set(
    (Array.isArray(reply.data.userRequestedInputIds) ? reply.data.userRequestedInputIds : [])
      .filter(id => typeof id === 'string')
  );
  // Quoted back exactly as they arrived. A token names the handout being answered, so that a
  // receipt this pass sends late cannot close a repair the app has since raised for a different
  // turn. An entry missing either half is not actionable and is dropped rather than guessed at.
  const repairs = (Array.isArray(reply.data.repairs) ? reply.data.repairs : [])
    .map((entry) => ({
      conversationId: cleanConversationId(entry && entry.conversationId),
      token: entry && typeof entry.token === 'string' ? entry.token : '',
      action: entry?.action === 'retry' ? 'retry' : entry?.action === 'compact' ? 'compact' : entry?.action === 'continue' ? 'continue' : 'reload',
      requiresClaim: entry?.requiresClaim === true,
      ...(typeof entry?.retryControlPending === 'boolean' ? { retryControlPending: entry.retryControlPending } : {}),
      reason: typeof entry?.reason === 'string' ? entry.reason : '',
      focus: Boolean(entry && entry.focus === true)
    }))
    .filter((entry) => entry.conversationId && entry.token);
  const repairConversations = new Set(repairs.map(entry => entry.conversationId));
  // An authored message for a new OR existing chat is foreground intent. An unrelated
  // repair must not strand it behind that repair's receipt wait. A repair of this SAME
  // document keeps custody: reloading it while offering text would race native Send.
  const urgentAuthoredInputs = publishedInputs
    .filter(input => userRequestedInputIds.has(input?.id) &&
      !repairConversations.has(cleanConversationId(input?.conversationId)))
    .map(input => ({ ...input, userRequested: true }));
  const urgentInputOpenings = urgentAuthoredInputs.length > 0
    ? await deliverDesktopInputs(
        urgentAuthoredInputs,
        reply.data.background === true,
        reply.data.reusableConversations,
        reply.data.inputOpeningIds,
        1
      )
    : 0;
  // Temporary decisions have a live three-minute request owner. Tab hygiene and unrelated
  // repair probes can consume that deadline in a crowded browser. Offer the already-admitted
  // exact helper first, under the same one-opening budget and account policy.
  const priorityHelpers = publishedInputs.filter(input => input?.lifetime === 'temporary-planner' &&
    input.close !== true && !cleanConversationId(input.conversationId));
  const helperInputOpenings = priorityHelpers.length > 0
    ? await deliverDesktopInputs(priorityHelpers, reply.data.background === true,
        reply.data.reusableConversations, reply.data.inputOpeningIds,
        Math.max(0, 1 - urgentInputOpenings))
    : 0;
  // Main has already admitted these short-lived decisions under its helper concurrency
  // limit. Unrelated/personal or retained old tabs must not exhaust that request's deadline.
  // Keep one opening per pass and the ordinary-chat ceiling; never raise main-chat fanout.
  if (browserLeasesReady) await maintainBareRootHygiene();
  await flushUnreachableConversationNotices(observedTabs);
  await fulfillOpenConversationRequests(reply.data.openConversationRequests);
  // Fulfilling a due repair must not wait behind window layout, input preparation
  // or serial idle-tab probes. Keep the same single maintenance owner and receipt.
  await performBrowserRepairs(repairs, reply.data);
  // Main hands out at most one automation/no-tab mutation per status transaction. Release this
  // maintenance pass completely, then ask for the next queued chat after a short stagger. This
  // keeps urgent "Open this chat" wakes responsive instead of holding the service worker inside
  // one many-tab repair loop.
  if (repairs.some(entry => entry.reason === 'automation' || entry.reason === 'no-tab')) {
    setTimeout(() => { void maintain(true).catch(() => undefined); }, 4_000);
  }
  await applyRequestedBrowserPreferences(reply.data.browserPreferenceRequest);
  void offerStopTurns(reply.data.stopTurns, reply.data.background === true);
  const bounds = reply.data.browserWindowBounds;
  if (bounds && Number.isInteger(bounds.width) && bounds.width > 0 && bounds.width <= 800 &&
      Number.isInteger(bounds.height) && bounds.height > 0 && bounds.height <= 600) {
    backgroundWindowBounds = { width: bounds.width, height: bounds.height,
      ...(Number.isInteger(bounds.left) && Number.isInteger(bounds.top) ? { left: bounds.left, top: bounds.top } : {}) };
  }
  const backgroundReady = await reconcileBackgroundWindow(reply.data);
  if (reply.data.placement) await placeSuccessorChat(reply.data.placement, null);
  const nonDiscardable = new Set(
    (Array.isArray(reply.data.nonDiscardableConversations) ? reply.data.nonDiscardableConversations : [])
      .map(cleanConversationId)
      .filter(Boolean)
  );
  const protectionWork = nonDiscardable.size > 0 || Object.keys(discardProtectedTabs).length > 0;
  // Chats the app has finished with: compacted source chats and stopped worker chats beyond
  // the ones the prime is likely to come back to. Their tabs are memory and nothing else.
  const closable = new Set(
    (Array.isArray(reply.data.closableConversations) ? reply.data.closableConversations : [])
      .map(cleanConversationId)
      .filter((conversationId) => conversationId && !nonDiscardable.has(conversationId))
  );
  const managedWork = Array.isArray(reply.data.managedConversations) && reply.data.managedConversations.length > 0;
  // Cleanup and grouping are resource safety, not a tail task behind native input preparation.
  // The returned snapshot is enough for this pass; input-created tabs join on the next ordinary
  // status wake without allowing a stalled preparation to starve existing-tab hygiene.
  const browserLayoutUnstable = reply.data.recoveryMonitoring === true || repairs.length > 0 ||
    (Array.isArray(reply.data.openConversationRequests) && reply.data.openConversationRequests.length > 0);
  const hygiene = browserLeasesReady
    ? await maintainTabHygiene(reply.data, nonDiscardable, closable, browserLayoutUnstable)
    : { complete: false, attentionWork: false };
  // Main's ordinary paired status rehydrates identity metadata after service-worker wake.
  if (reply.data.connectorApps && typeof reply.data.connectorApps === 'object') {
    connectorIdentityOwner = instanceId;
    connectorApps = reply.data.connectorApps;
    connectorNames = reply.data.connectorNames || {};
  }
  inspectRequestedModels(reply.data.modelCatalogRequest);
  inspectRequestedPluginRefresh(reply.data.pluginRefreshRequests, reply.data.background === true, reply.data.browserOnly === true);
  void inspectProjectCreates(reply.data.projectCreateRequests, reply.data.projectCreateDispatchAllowed === true);
  // Reloading the same document races its final input offer. Repair it now; the
  // still-durable app row is offered on the next status pass after the reload.
  const priorityInputIds = new Set([...urgentAuthoredInputs, ...priorityHelpers].map(input => input.id));
  const inputs = publishedInputs
    .filter(input => !priorityInputIds.has(input?.id) &&
      !repairConversations.has(cleanConversationId(input?.conversationId)))
    .map(input => userRequestedInputIds.has(input?.id) ? { ...input, userRequested: true } : input);
  // Existing documents may always receive their already-durable input. New automatic pages are
  // bounded to one per pass and stop entirely once Chrome is above a conservative working-set
  // ceiling; direct authored input retained its single foreground opening above.
  const automaticOpeningBudget = observedTabs.length >= MAX_AUTOMATION_CHATGPT_TABS
    ? 0
    : Math.max(0, 1 - urgentInputOpenings - helperInputOpenings);
  await deliverDesktopInputs(inputs, reply.data.background === true, reply.data.reusableConversations,
    reply.data.inputOpeningIds, automaticOpeningBudget);
  if (!backgroundReady) await reconcileBackgroundWindow(reply.data);
  const monitoring = reply.data.recoveryMonitoring === true;
  if (monitoring !== recoveryMonitoring) {
    recoveryMonitoring = monitoring;
    await persistLive().catch(() => undefined);
  }
  if (await acceptBrowserRevivals(reply.data)) await recoverDeferredRevivals();
  if (!hygiene.complete) return;
  if (!protectionWork && !managedWork && !hygiene.attentionWork && closable.size === 0 && repairs.length === 0) {
    return clearRetryIfIdle();
  }
  if (repairs.length === 0) return clearRetryIfIdle();
}

/**
 * ChatGPT often redirects a burst of exact-chat opens back to `/` under access pressure. Sending
 * the next five repairs immediately turns that one provider refusal into a tab create/redirect/
 * cleanup storm. Manual Retry/Compact remains immediate; only automatic missing/stale-chat work
 * shares this short browser-mutation gate.
 */
const AUTOMATIC_REPAIR_STAGGER_MS = 5_000;
let nextAutomaticRepairAt = 0;
let automaticRepairWakeTimer = null;
function scheduleAutomaticRepairWake(delayMs) {
  if (automaticRepairWakeTimer !== null) clearTimeout(automaticRepairWakeTimer);
  automaticRepairWakeTimer = setTimeout(() => {
    automaticRepairWakeTimer = null;
    void maintain(true).catch(() => undefined);
  }, Math.max(0, delayMs));
}

async function performBrowserRepairs(repairs, policy) {
  const allowFocusedWindowWake = policy.automationProfile === 'overnight' ||
    policy.automationProfile === 'rotation';
  for (let index = 0; index < repairs.length; index += 1) {
    const { conversationId, token, action, focus, requiresClaim, reason, retryControlPending } = repairs[index];
    const guardedGoalRecovery = requiresClaim && action === 'reload' &&
      (reason === 'goal' || reason === 'automation');
    // Native Core may still be running behind a completed/404 response stream.
    // Recheck assistant-error and compaction AFTER the claimed token but BEFORE
    // any actual Retry/Stop/compact/reload (including discarded/root recovery).
    // It is the same incumbent Bridge claim owner, not another retry service.
    const guardedNativeRecovery = guardedGoalRecovery ||
      requiresClaim && (reason === 'assistant-error' || reason === 'compaction' || reason === 'unattributed');
    let repairClaimed = false;
    const claimRepairNow = async () => {
      const result = await call('/repairs/claim', { method: 'POST', body: JSON.stringify({ token }) });
      repairClaimed = result.ok && result.data?.allowed === true;
      return repairClaimed;
    };
    const recheckNativeRepair = async () => {
      if (!guardedNativeRecovery) return true;
      if (!repairClaimed) return false;
      // The page/Chrome awaits between claim and mutation. Reprove the SAME
      // claimed repair, not a second initial claim or permission to Send.
      const result = await call('/repairs/claim', {
        method: 'POST', body: JSON.stringify({ token, phase: 'recheck' })
      });
      if (result.ok && result.data?.allowed === true) return true;
      // An uncertain tool, changed source, signed-out account or later
      // human-owned task invalidates this action. Existing Bridge custody
      // owns the same unspent reply and the privacy-safe recovery notice.
      await call(`/status?repairDeferred=${encodeURIComponent(token)}&repairCause=claim-revoked`);
      return false;
    };
    if (reason === 'automation' || reason === 'no-tab') {
      const now = Date.now();
      if (now < nextAutomaticRepairAt) {
        const deferred = await call(`/status?repairDeferred=${encodeURIComponent(token)}`);
        if (!deferred.ok) return;
        scheduleAutomaticRepairWake(nextAutomaticRepairAt - now);
        continue;
      }
      // Reserve before the first Chrome await so a wake raised by this navigation cannot admit a
      // second automatic repair into the same burst. A failed attempt still earns the cooldown:
      // the provider/browser needs breathing room most when the mutation failed.
      nextAutomaticRepairAt = now + AUTOMATIC_REPAIR_STAGGER_MS;
    }
    // Re-scanned per repair rather than reused from above. Earlier entries in this same batch
    // may have created a tab, and the scan has to be the state immediately before the action or
    // the duplicate rule below is deciding on a tab list that no longer exists.
    let live = [];
    try {
      // Never let Chrome's tab API hold the shared maintenance flight indefinitely. A repair may
      // create a tab only from a complete inventory, so two bounded failures stop this batch.
      live = await cleanupConversationInventory();
    } catch {
      // Every row in this response is already marked "handed" by the app. If Chrome cannot
      // provide an inventory, explicitly return this row and every not-yet-attempted row instead
      // of silently abandoning them in "repairing Chrome". No browser mutation occurred, so a
      // failed receipt is unambiguous and the ordinary queue remains the sole retry owner.
      for (const pending of repairs.slice(index)) {
        const failedAction = pending.action === 'retry' ? 'retried' : pending.action === 'compact' ? 'compacted' : 'reloaded';
        await call(`/status?repairFailed=${encodeURIComponent(pending.token)}&repairAction=${failedAction}`);
      }
      return;
    }
    const candidates = live.filter((tab) => conversationForTab(tab) === conversationId);
    // One chat is one tab. Bailing out on two copies left the chat broken *and* left the
    // duplicate sitting there, so the ambiguity is resolved instead: reload the copy this
    // worker's registry already binds to the conversation, falling back to the lowest tab id so
    // two passes never pick differently. A tab is only ever created when the chat has none.
    const owned = candidates.filter((tab) => tabConversations[tab.id] === conversationId);
    let [target] = (owned.length > 0 ? owned : candidates).sort((a, b) => a.id - b.id);
    // The tab scan selected a browser document, not just a reusable tab id.
    // A subsequent SPA route change or recorder replacement must invalidate
    // the claim before a Chrome reload can touch the now foreign page.
    const recoveryDocument = target ? {
      documentId: tabDocuments[String(target.id)],
      navigationEpoch: tabEpochs[String(target.id)]
    } : null;
    const targetStillOwnsGoal = async () => {
      if (!target || !recoveryDocument || !Number.isInteger(target.id)) return false;
      let latest = null;
      try { latest = await chrome.tabs.get(target.id); } catch {
        // A fresh Chrome inventory is also positive route evidence. In
        // particular it is not the stale tab registry used for selection.
        try {
          const current = await chrome.tabs.query({});
          latest = current.find(tab => tab.id === target.id) || null;
        } catch { /* Unknown route must block the mutation. */ }
      }
      const key = String(target.id);
      return Boolean(latest && !latest.pendingUrl && latest.status !== 'loading' &&
        conversationFromUrl(latest.url) === conversationId &&
        tabDocuments[key] === recoveryDocument.documentId &&
        tabEpochs[key] === recoveryDocument.navigationEpoch);
    };
    // Readiness is authority to inspect the existing live document, not to reopen, navigate,
    // reload or focus it. A lost/discarded document needs its separate recovery authority.
    if (action === 'retry' && retryControlPending === true && (!target || target.discarded === true)) {
      await call(`/status?repairFailed=${encodeURIComponent(token)}&repairAction=retried&repairFailure=native_retry_unavailable`);
      continue;
    }
    // ChatGPT can redirect an exact /c/<id> repair to the plain home page when access is
    // throttled. That document is not a missing conversation: it is still the app-owned tab
    // for this exact recovery episode. Reclaim it in place before considering a new tab. The
    // defer receipt returns the handout unspent while the restored conversation loads, so the
    // next pass performs Reload/Retry against the live page instead of multiplying empty roots.
    if (!target) {
      const redirected = live
        .filter(tab => {
          const row = Number.isInteger(tab?.id) ? appOwnedOpeningTabs[String(tab.id)] : null;
          return cleanConversationId(row?.conversationId) === conversationId &&
            !tab.pendingUrl && Boolean(exactPlainChatHome(tab.url));
        })
        .sort((a, b) => a.id - b.id)[0];
      if (redirected) {
        const row = appOwnedOpeningTabs[String(redirected.id)];
        try {
          // Root proof for Goal/Loop is read-only until Bridge confirms this
          // exact recovery. Even dismissing a provider notice before claim
          // could mutate a different user's currently held page.
          const emptyRoot = await proveEmptyRedirectedConversationRoot(redirected, row, null, !guardedNativeRecovery);
          if (emptyRoot) {
            if (guardedNativeRecovery && !await claimRepairNow()) continue;
            const previousOpenState = row.openState;
            const previousRetargetCount = row.retargetCount;
            row.openState = 'opening';
            // Preserve the recovery episode's original age. Refreshing `createdAt` on every
            // retarget made a provider-redirected root immortal: each repair pass restarted its
            // cleanup grace before hygiene could close it. With the original age intact, this
            // tab gets one in-place retry and, if ChatGPT sends it to / again, cleanup retires it
            // so the next durable repair pass can create one fresh exact-conversation attempt.
            row.retargetCount = Math.max(0, Number(row.retargetCount) || 0) + 1;
            await chrome.storage.session.set({ appOwnedOpeningTabs });
            if (!await recheckNativeRepair()) {
              // This token was revoked without any Chrome navigation. Restore
              // the same existing app-owned root's phase and retry count so a
              // denied claim cannot masquerade as an attempted retarget.
              if (appOwnedOpeningTabs[String(redirected.id)] === row &&
                  row.openState === 'opening' &&
                  row.retargetCount === Math.max(0, Number(previousRetargetCount) || 0) + 1) {
                row.openState = previousOpenState;
                row.retargetCount = previousRetargetCount;
                await chrome.storage.session.set({ appOwnedOpeningTabs });
              }
              continue;
            }
            await chrome.tabs.update(redirected.id, {
              url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
              active: focus
            });
            const deferred = await call(`/status?repairDeferred=${encodeURIComponent(token)}`);
            if (!deferred.ok) throw new Error('repair_defer_failed');
            continue;
          }
        } catch {
          // Unknown/drafted roots remain untouched. The complete inventory below may still
          // authorize one separate exact tab, and ordinary root cleanup owns the stale page.
        }
        if (guardedNativeRecovery) {
          // A root that is not proven empty is not a spare tab into which to
          // sneak the same Goal pickup. Preserve it and refund this handout.
          await call(`/status?repairDeferred=${encodeURIComponent(token)}&repairCause=claim-revoked`);
          continue;
        }
      }
    }
    let repairAction = action === 'continue' ? 'stopped' : action === 'retry' && target ? 'retried' :
      action === 'compact' ? 'compacted' : target ? 'reloaded' : 'reopened';
    try {
      if (!target && policy.browserOnly === true) continue;
      // A discarded tab has no live content script, so native Retry cannot be claimed or
      // acknowledged yet. Restore this exact owed document without activating its window and
      // return the handout to the app queue; the replacement document's normal registration
      // wakes the next pass. Protect only values this extension changed so later hygiene can
      // restore Chrome's original discard policy.
      if (target?.discarded === true) {
        // For Goal/Loop an old offered token may have been revoked by native
        // Core evidence during the scan. No tab policy or reload happens until
        // the SAME Bridge owner grants this initial claim.
        if (guardedNativeRecovery && !await claimRepairNow()) continue;
        const key = String(target.id);
        if (target.autoDiscardable !== false) {
          await chrome.tabs.update(target.id, { autoDiscardable: false });
          discardProtectedTabs[key] = true;
          await persistLive();
        }
        if (!await recheckNativeRepair()) continue;
        if (guardedNativeRecovery && !await targetStillOwnsGoal()) throw new Error('conversation_changed');
        await chrome.tabs.reload(target.id);
        const deferred = await call(`/status?repairDeferred=${encodeURIComponent(token)}`);
        if (!deferred.ok) throw new Error('repair_defer_failed');
        continue;
      }
      // Select the working tab within Chrome without stealing OS focus from the
      // desktop app. Tab selection and window activation are separate operations.
      if (guardedNativeRecovery && !repairClaimed && !await claimRepairNow()) continue;
      if (target && focus && retryControlPending !== true) {
        // Even selecting an otherwise background Chrome tab can disturb the
        // user's current browser work. A newly unresolved native Core result
        // revokes that side effect too; recheck the SAME claimed token before
        // focus and again after the await, immediately before real mutation.
        if (!await recheckNativeRepair()) continue;
        await chrome.tabs.update(target.id, { active: true });
      }
      // The tab scan can yield while attribution recovers or a final/new question
      // retires an interrupted-response repair. Claim only at the action boundary.
      if (requiresClaim && !repairClaimed && !await claimRepairNow()) continue;
      if ((action === 'compact' || action === 'continue') && !target) {
        // Compaction must start in the exact existing conversation. Opening another root here
        // competes with the separate no-tab owner and is what created useless Queue/Recovery
        // tabs. Return the untouched handout; missing-tab recovery will reopen the chat once.
        await call(`/status?repairDeferred=${encodeURIComponent(token)}`);
        continue;
      }
      let collectedLiveGoal = false;
      if ((reason === 'goal' || reason === 'automation') && action !== 'retry' && action !== 'compact' && action !== 'continue' && target) {
        // A durable Loop reply is app authority, but an existing content script is the cheapest
        // and most reliable collector. Wake that exact page first; only a missing/stale receiver
        // earns a full browser reload. This avoids the reload churn that can keep a healthy tab
        // perpetually between documents while its saved reply remains uncollected.
        const message = {
          type: 'clf-collect-goal-now',
          conversationId
        };
        const first = await chrome.tabs.sendMessage(target.id, message).catch(() => null);
        const result = await retryRepairMessageAfterTabWake(
          target,
          conversationId,
          first,
          message,
          value => value?.ok === true && value?.pending === true && value?.claimed !== true &&
            value?.working !== true && value?.providerWorking !== true && value?.coreWorking !== true &&
            value?.helperWorking !== true && value?.composerBlocked !== true,
          allowFocusedWindowWake
        );
        if (result?.error === 'tab_wake_deferred') {
          const deferred = await call(`/status?repairDeferred=${encodeURIComponent(token)}&repairCause=foreground`);
          if (!deferred.ok) throw new Error('foreground_repair_defer_failed');
          continue;
        }
        // No response is not proof that the first collector performed no mutation. Reloading
        // after that ambiguity can race an accepted draft/native Send, so return a failed receipt
        // and let the existing bounded owner decide what remains safe.
        if (result === null) throw new Error('goal_wake_unconfirmed');
        // A retired recorder or wrong-conversation document can answer the
        // first wake after a tab navigation. A negative answer is evidence
        // that this page did NOT collect the original Goal. Never reload the
        // now foreign tab under a stale but otherwise valid Bridge token.
        if (result?.ok !== true) {
          throw new Error(result?.error === 'wrong_conversation' || result?.error === 'page_changed'
            ? 'conversation_changed'
            : result?.error === 'recorder_inactive' ? 'recorder_inactive' : 'goal_collector_unverified');
        }
        if ((result.conversationId && result.conversationId !== conversationId) ||
            (Number.isSafeInteger(result.epoch) &&
              Number.isSafeInteger(tabEpochs[String(target.id)]) &&
              result.epoch !== tabEpochs[String(target.id)])) {
          throw new Error('conversation_changed');
        }
        const pageWorking = result?.working === true || result?.providerWorking === true ||
          result?.coreWorking === true || result?.helperWorking === true;
        if (result?.ok === true && pageWorking) {
          // Pending helper custody protects this document but does not prove a live stream:
          // that helper may still be unclaimed in the desktop outbox.
          const helperOnly = result.helperWorking === true && result.providerWorking !== true && result.coreWorking !== true;
          const deferred = await call(`/status?repairDeferred=${encodeURIComponent(token)}&repairCause=${helperOnly ? 'helper-pending' : 'streaming'}`);
          if (!deferred.ok) throw new Error('working_repair_defer_failed');
          continue;
        }
        if (result?.ok === true && result?.composerBlocked === true) {
          // A ready saved reply beside user-owned composer text/attachments needs attention, not
          // a reload and not a successful `nudged` receipt. Preserve both sides verbatim and let
          // the existing repair owner project the actionable fence.
          const deferred = await call(`/status?repairDeferred=${encodeURIComponent(token)}&repairCause=composer-blocked`);
          if (!deferred.ok) throw new Error('composer_blocked_repair_defer_failed');
          continue;
        }
        // `settledPending` is positive evidence that the source answer already reached its
        // durable boundary. When it is idle, unclaimed, and unblocked, the existing bounded
        // reload fallback below remains appropriate; it may repair the page-side collector but
        // still cannot reconstruct or resend the saved reply itself.
        const idleUnclaimedPending = result?.ok === true && result?.pending === true &&
          result?.claimed !== true && result?.settledPending === true;
        collectedLiveGoal = result?.ok === true && result?.pending === true && result?.claimed === true;
        if (collectedLiveGoal) repairAction = 'nudged';
        else if (idleUnclaimedPending) {
          console.info('[Chat On Steroids] live Goal/Loop reply stayed idle and unclaimed; using its bounded reload fallback', {
            conversationId,
            reason
          });
        }
      }
      if (action === 'continue' && target) {
        if (!await recheckNativeRepair()) continue;
        const result = await chrome.tabs.sendMessage(target.id, { type: 'clf-stop-interrupted-turn', conversationId });
        if (result?.ok === false && result.error === 'page_not_idle') {
          const deferred = await call(`/status?repairDeferred=${encodeURIComponent(token)}&repairCause=streaming`);
          if (!deferred.ok) throw new Error('interrupted_stop_defer_failed');
          continue;
        }
        if (result?.ok !== true) throw new Error(result?.error || 'interrupted_stop_unconfirmed');
      } else if (action === 'compact' && target) {
        if (!await recheckNativeRepair()) continue;
        const result = await chrome.tabs.sendMessage(target.id, {
          type: 'clf-compact-interrupted-turn',
          conversationId
        });
        if (result?.ok !== true) throw new Error(result?.error || 'interrupted_compaction_unavailable');
      } else if (action === 'retry' && target) {
        if (!await recheckNativeRepair()) continue;
        const message = {
          type: 'clf-retry-failed-turn',
          conversationId
        };
        const first = await chrome.tabs.sendMessage(target.id, message).catch(() => null);
        const result = retryControlPending === true ? first : await retryRepairMessageAfterTabWake(
          target,
          conversationId,
          first,
          message,
          value => value?.ok === false && value?.error === 'retry_not_ready',
          allowFocusedWindowWake
        );
        if (result?.error === 'tab_wake_deferred') {
          const deferred = await call(`/status?repairDeferred=${encodeURIComponent(token)}&repairCause=foreground`);
          if (!deferred.ok) throw new Error('foreground_repair_defer_failed');
          continue;
        }
        if (result?.ok === false && result?.error === 'page_not_idle') {
          // The failed card can remain mounted while ChatGPT has already resumed the same answer.
          // `retryAppFailedTurn()` correctly refuses to click anything while native generation is
          // live, but that refusal is not a failed Retry and must not spend this turn's one Retry
          // budget or promote it toward reload. Re-read the exact document once through the
          // existing provider-liveness owner; only a positive native stream defers the handout.
          const status = await tabReply(target.id, { type: 'clf-page-status' });
          if (status?.ok === true && status.streaming === true) {
            const deferred = await call(`/status?repairDeferred=${encodeURIComponent(token)}&repairCause=streaming`);
            if (!deferred.ok) throw new Error('streaming_retry_defer_failed');
            continue;
          }
        }
        if (result?.modelBlocked === true) {
          let path = `/status?repairDeferred=${encodeURIComponent(token)}&repairCause=model-blocked` +
            `&retrySpent=${result.retrySpent === true ? '1' : '0'}`;
          for (const [key, value] of [
            ['expectedModel', result.expectedModel],
            ['expectedEffort', result.expectedEffort],
            ['actualModel', result.actualModel],
            ['actualEffort', result.actualEffort]
          ]) {
            if (typeof value === 'string' && value) path += `&${key}=${encodeURIComponent(value)}`;
          }
          const deferred = await call(path);
          if (!deferred.ok) throw new Error('model_blocked_repair_defer_failed');
          continue;
        }
        if (result?.ok === false && result?.error === 'retry_not_ready' && typeof retryControlPending === 'boolean') {
          const deferred = await call(`/status?repairDeferred=${encodeURIComponent(token)}&repairCause=retry-not-ready`);
          if (!deferred.ok) throw new Error('retry_readiness_defer_failed');
          continue;
        }
        if (result?.ok !== true) throw new Error(result?.error || 'native_retry_unavailable');
      } else if (target) {
        if (reason === 'no-tab') {
          // A revival can restore this chat during the repair's tab scan. Missing-tab recovery
          // must not interrupt that same page's bootstrap Send. Re-prove Chrome's actual route
          // and the captured document across the bounded reply before reporting mere presence.
          const key = String(target.id);
          const documentId = tabDocuments[key];
          const navigationEpoch = tabEpochs[key];
          const tab = await chrome.tabs.get(target.id);
          if (conversationFromUrl(tab.pendingUrl || tab.url) !== conversationId)
            throw new Error('no_tab_repair_route_changed');
          const loading = tab.status === 'loading' || Boolean(tab.pendingUrl);
          const status = loading ? null : await tabReply(target.id, { type: 'clf-page-status' },
            documentId ? { documentId } : undefined);
          const latest = await chrome.tabs.get(target.id);
          if (conversationFromUrl(latest.pendingUrl || latest.url) !== conversationId ||
              tabDocuments[key] !== documentId || tabEpochs[key] !== navigationEpoch)
            throw new Error('no_tab_repair_owner_changed');
          if (status?.ok === true &&
              (status.conversationId !== conversationId ||
                (Number.isSafeInteger(navigationEpoch) && status.epoch !== navigationEpoch)))
            throw new Error('no_tab_repair_page_changed');
          if (loading || latest.status === 'loading' || latest.pendingUrl || status?.ok === true) {
            const present = await call(`/status?repaired=${encodeURIComponent(token)}&repairAction=present`);
            if (!present.ok) throw new Error('no_tab_presence_receipt_failed');
            continue;
          }
        }
        if (!collectedLiveGoal && (reason === 'unattributed' || reason === 'silence')) {
          // Attribution and silence recovery exist to wake a page that stopped reporting. They
          // must never interrupt a page that can positively prove ChatGPT is still streaming:
          // reloading that document produces the native "Resume stream unavailable" / load
          // failure loop and can discard a valid answer. Return the untouched handout with a
          // bounded settle delay; real activity will retire it through the existing owner.
          const status = await chrome.tabs.sendMessage(target.id, { type: 'clf-page-status' })
            .catch(() => null);
          if (status?.ok === true && status.streaming === true) {
            const deferred = await call(`/status?repairDeferred=${encodeURIComponent(token)}&repairCause=streaming`);
            if (!deferred.ok) throw new Error('streaming_repair_defer_failed');
            continue;
          }
        }
        if (!collectedLiveGoal) {
          if (!await recheckNativeRepair()) continue;
          if (guardedNativeRecovery && !await targetStillOwnsGoal()) throw new Error('conversation_changed');
          await chrome.tabs.reload(target.id);
        } else if (!await recheckNativeRepair()) {
          // A collector accepting a draft is NOT proof that native Send was
          // attempted or ACKed. Never report even a nudge as recovery after
          // the original source or native tool evidence has changed.
          continue;
        }
      } else {
        if ((reason === 'automation' || reason === 'no-tab') && live.length >= MAX_AUTOMATION_CHATGPT_TABS) {
          // Retain the exact durable repair without adding another renderer to an already
          // overloaded Chrome. Existing tabs continue running and hygiene can reduce pressure;
          // the next bounded pass retries this same chat rather than multiplying empty roots.
          await call(`/status?repairDeferred=${encodeURIComponent(token)}`);
          scheduleAutomaticRepairWake(AUTOMATIC_REPAIR_STAGGER_MS);
          continue;
        }
        if (!await recheckNativeRepair()) continue;
        const created = await createChatTab(
          `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
          policy.background === true,
          focus
        );
        // A background repair tab must survive long enough for its replacement document to
        // register and publish real activity. Record only the policy this extension applies so
        // ordinary hygiene can restore Chrome's default after main removes the repair from the
        // non-discardable projection.
        if (policy.background === true && Number.isInteger(created?.id)) {
          await chrome.tabs.update(created.id, { autoDiscardable: false });
          discardProtectedTabs[String(created.id)] = true;
          await persistLive();
        }
        // Opening the exact chat prepares its DOM but cannot prove that its native Retry was
        // clicked. Keep this repair queued; the next inventory pass can address the live tab.
        if (action === 'retry') {
          await call(`/status?repairFailed=${encodeURIComponent(token)}&repairAction=reopened&repairFailure=retry_tab_opened`);
          continue;
        }
      }
    } catch (error) {
      // A tab changed between the scan and action, or Chrome refused it. Report the exact failed
      // handout so the app can show the failure while keeping the same repair retryable. The
      // rest of the batch is unaffected: these are separate chats and separate failures.
      // Never forward Chrome exception text or arbitrary page strings (which can contain URLs,
      // drafts or credentials). These fixed codes are diagnostics, not replay authorization.
      const failure = [
        'retry_unavailable', 'ambiguous_retry', 'page_not_idle', 'page_changed',
        'retry_not_authorized', 'native_retry_unavailable', 'native_retry_failed',
        'interrupted_compaction_unavailable', 'interruption_not_visible', 'compaction_busy',
        'worker_compaction_disabled', 'conversation_changed', 'recorder_inactive'
      ].includes(error?.message) ? error.message : 'action_failed';
      await call(`/status?repairFailed=${encodeURIComponent(token)}&repairAction=${repairAction}&repairFailure=${failure}`);
      continue;
    }
    await call(`/status?repaired=${encodeURIComponent(token)}&repairAction=${repairAction}`);
  }
}

function conversationStillOpen(conversationId) {
  return Object.values(tabConversations).some((value) => value === conversationId);
}

/** Close authority is locally spent from remove() until Main durably acknowledges its receipt. */
function supersededSourceRetirementPending(conversationId) {
  const id = cleanConversationId(conversationId);
  if (!id) return false;
  return Object.values(automaticTabRetirements).some(row => row?.kind === 'superseded-source' &&
    row.conversationId === id && /^[a-f0-9]{32}$/i.test(row.receiptId || '')) ||
    closeOutbox.some(row => row?.conversationId === id && row?.retirement?.kind === 'superseded-source' &&
      /^[a-f0-9]{32}$/i.test(row.retirement.receiptId || ''));
}

/**
 * Proves that no current ChatGPT tab still represents one conversation before publishing closed.
 *
 * The document registry is the fast positive signal, but it can lag Chrome during a replacement
 * document's first few milliseconds. A concrete conversation URL is already stronger current-tab
 * identity elsewhere in this worker, so a departing duplicate must not declare the whole chat gone
 * merely because that replacement has not registered yet. Unknown inventory is never absence.
 */
async function conversationProvenAbsent(conversationId) {
  const id = cleanConversationId(conversationId);
  if (!id || conversationStillOpen(id)) return false;
  let tabs;
  try {
    tabs = await cleanupConversationInventory();
  } catch {
    return false;
  }
  const present = (Array.isArray(tabs) ? tabs : []).some(tab => {
    // During navigation Chrome may expose old committed url=A together with pendingUrl=B. For
    // destructive close proof the pending destination is the current lifecycle fact: leaving A
    // must not be vetoed by A's stale committed URL, while pending A still proves A present.
    if (typeof tab?.pendingUrl === 'string' && tab.pendingUrl) {
      return conversationFromUrl(tab.pendingUrl) === id;
    }
    return conversationForTab(tab) === id;
  });
  if (present) return false;
  // Registration can race the asynchronous inventory read. Re-check immediately before granting
  // absence so either exact source of browser presence vetoes the destructive close.
  return !conversationStillOpen(id);
}

async function prospectiveFirstEnrollmentCloseSource(source, candidate) {
  if (!unboundEnrollmentSource || instanceId !== null || port !== null || token !== null || disconnected || pairing ||
      journalWorkers.size || !onlyNeverBoundObservationRows(journal)) return null;
  const marker = firstEnrollmentCloseSource({
    version: FIRST_ENROLLMENT_CLOSE_SOURCE_VERSION,
    browserId,
    tab: source?.tab,
    documentId: source?.documentId,
    navigationEpoch: source?.navigationEpoch
  }, browserId);
  const existing = firstEnrollmentCloseRows(closeOutbox, browserId, true);
  if (!marker || !existing || existing.some(row =>
      row.conversationId === candidate.conversationId || row.firstEnrollmentSource.tab === marker.tab)) return null;
  const currentSource = () => {
    const key = String(marker.tab);
    return tabDocuments[key] === marker.documentId && tabEpochs[key] === marker.navigationEpoch &&
      terminalDocuments[key] === marker.documentId && !cleanConversationId(tabConversations[key]);
  };
  if (!currentSource()) return null;
  const epoch = connectionEpoch;
  let timer;
  try {
    const connectionKeys = ['instanceId', 'port', 'token', 'disconnected', 'browserId'];
    const arrays = ['deferredRevivals', 'closeOutbox', 'commandAckOutbox', 'settled'];
    const maps = ['inputOpenings', 'desktopInputTabs', 'stopOpenings', 'commandTabLeases', 'pendingInputReceipts',
      'appOwnedOpeningTabs', 'automaticTabRetirements', 'discardProtectedTabs', 'protectedMainTabs', 'cosGroupedTabs',
      'terminalDocuments', 'retiredDocuments'];
    const snapshot = await Promise.race([
      Promise.all([
        chrome.storage.local.get([...connectionKeys, ...arrays, ...maps]),
        chrome.storage.session.get([...arrays, ...maps, 'journal', 'tabConversations', 'tabDocuments', 'tabEpochs',
          'recoveryMonitoring', 'delivery', 'projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner'])
      ]),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS); })
    ]);
    if (!snapshot || epoch !== connectionEpoch || !currentSource() ||
        instanceId !== null || port !== null || token !== null || disconnected || pairing) return null;
    const [stored, live] = snapshot;
    if (stored.browserId !== browserId || !sameFirstEnrollmentCloseRows(
      firstEnrollmentCloseRows(stored.closeOutbox || [], browserId, true), existing) ||
      !sameFirstEnrollmentCloseRows(firstEnrollmentCloseRows(live.closeOutbox || [], browserId, true), existing) ||
      JSON.stringify(live.journal) !== JSON.stringify(journal) || !onlyNeverBoundObservationRows(live.journal) ||
      live.tabDocuments?.[String(marker.tab)] !== marker.documentId ||
      live.tabEpochs?.[String(marker.tab)] !== marker.navigationEpoch ||
      live.terminalDocuments?.[String(marker.tab)] !== marker.documentId) return null;
    const priorTerminal = { ...(live.terminalDocuments || {}) };
    delete priorTerminal[String(marker.tab)];
    const priorLive = { ...live, terminalDocuments: priorTerminal };
    const clean = existing.length
      ? prospectiveFirstEnrollmentCloseStorage(stored, priorLive, existing)
      : neverBoundAccountStorage(stored, true) && neverBoundAccountStorage(priorLive, false);
    if (!clean || epoch !== connectionEpoch || !currentSource()) return null;
    return marker;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function enqueueClose(conversationId, byExtension = false, retirement = null, source = null) {
  const id = cleanConversationId(conversationId);
  if (!id) return false;
  if (unassignedHistoryUncertain || unassignedHistoryConversation(id)) return false;
  const previous = closeOutbox.find((entry) => entry && entry.conversationId === id);
  const exactRetirement = retirement?.kind === 'superseded-source' &&
    /^[a-f0-9]{32}$/i.test(retirement.receiptId || '')
    ? {
        kind: 'superseded-source',
        receiptId: retirement.receiptId.toLowerCase(),
        tab: Number.isInteger(retirement.tab) ? retirement.tab : null,
        documentId: typeof retirement.documentId === 'string' ? retirement.documentId : null,
        navigationEpoch: Number.isSafeInteger(retirement.navigationEpoch) ? retirement.navigationEpoch : null
      }
    : null;
  const carriedRetirement = previous?.retirement?.kind === 'superseded-source'
    ? previous.retirement
    : exactRetirement;
  if (!previous || (!byExtension && previous.byExtension === true) ||
      (exactRetirement && !previous.retirement)) {
    const queuedAt = previous?.queuedAt ?? Date.now();
    const firstEnrollmentSource = source && !byExtension && !carriedRetirement
      ? await prospectiveFirstEnrollmentCloseSource(source, { conversationId: id, queuedAt })
      : null;
    if (unassignedHistoryUncertain || unassignedHistoryConversation(id)) return false;
    // One status pass after the final tab closes lets the app decide whether that exact chat is
    // an active agent needing a reopen. The pass clears this again when it is ordinary history.
    recoveryMonitoring = true;
    // A later real user close supersedes the /closed classification, but never discards the
    // earlier exact retirement ACK. Main must still spend it before this browser can close A again.
    closeOutbox = closeOutbox.filter((entry) => entry !== previous);
    closeOutbox.push({
      conversationId: id,
      queuedAt,
      ...(byExtension ? { byExtension: true } : {}),
      ...(carriedRetirement ? { retirement: carriedRetirement } : {}),
      ...(previous?.retirementAcked === true ? { retirementAcked: true } : {}),
      ...(firstEnrollmentSource ? { firstEnrollmentSource } : {})
    });
    if (!(instanceId === null && port === null && token === null) && !unassignedHistoryUncertain)
      closeOutbox = closeOutbox.slice(-200);
    await persistLive();
  }
  else recoveryMonitoring = true;
  scheduleRetry();
  return true;
}

async function drainCloses() {
  await load();
  if (closing || closeOutbox.length === 0 || !token) return { ok: true, pending: closeOutbox.length };
  closing = true;
  let changed = false;
  try {
    for (let entry of [...closeOutbox]) {
      const conversationId = cleanConversationId(entry && entry.conversationId);
      if (unassignedHistoryUncertain || unassignedHistoryConversation(conversationId)) continue;
      if (!conversationId) {
        closeOutbox = closeOutbox.filter((candidate) => candidate !== entry);
        changed = true;
        continue;
      }
      const retirement = entry?.retirement?.kind === 'superseded-source' &&
        /^[a-f0-9]{32}$/i.test(entry.retirement.receiptId || '')
        ? entry.retirement
        : null;
      if (retirement && entry.retirementAcked !== true) {
        const acknowledged = await call('/browser/superseded-source-retired', {
          method: 'POST',
          body: JSON.stringify({ conversationId, receiptId: retirement.receiptId })
        });
        if (!acknowledged.ok) {
          scheduleRetry();
          break;
        }
        // Replace rather than mutate so an enqueue racing this delivery remains in the outbox.
        const current = closeOutbox.find(candidate => candidate === entry);
        if (current) {
          const acknowledgedEntry = { ...current, retirementAcked: true };
          closeOutbox = closeOutbox.map(candidate => candidate === current ? acknowledgedEntry : candidate);
          entry = acknowledgedEntry;
          changed = true;
          await persistLive();
        }
      }
      if (!await conversationProvenAbsent(conversationId)) {
        // A tab reopened while its exact ACK was in flight is browsing, not a second close. Once
        // Main has durably spent the receipt, retire this old last-view candidate; a future real
        // user close will enqueue its own ordinary /closed lifecycle event.
        if (retirement && entry.retirementAcked === true) {
          closeOutbox = closeOutbox.filter(candidate => candidate !== entry);
          changed = true;
        } else scheduleRetry();
        continue;
      }
      const result = await call('/closed', {
        method: 'POST',
        body: JSON.stringify({ conversationId, manual: entry.byExtension !== true })
      });
      if (!result.ok) {
        scheduleRetry();
        break;
      }
      closeOutbox = closeOutbox.filter((candidate) => candidate !== entry);
      changed = true;
    }
    if (changed) await persistLive();
    clearRetryIfIdle();
    return { ok: true, pending: closeOutbox.length };
  } finally {
    closing = false;
  }
}

/**
 * Removes one tab's ownership and closes the app-side conversation only if it was last.
 *
 * `expected` protects an old page's delayed close from deleting a mapping that the same
 * tab has already replaced with a new conversation.
 */
async function releaseTab(
  tab,
  expected = null,
  expectedDocument = null,
  expectedEpoch = null,
  physicallyClosed = false,
  preserveOpeningConversation = null,
  byExtension = false,
  retirement = null,
  acceptance = null
) {
  const currentAdmission = () => acceptance === null || acceptance() === true;
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  await load();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  if (typeof tab !== 'number') return { ok: true, closed: false };
  const key = String(tab);
  if (physicallyClosed && Object.prototype.hasOwnProperty.call(commandTabLeases, key)) {
    delete commandTabLeases[key];
    await chrome.storage.local.set({ commandTabLeases });
    if (!currentAdmission()) return conversationAdmissionRefusal(null);
  }
  if (cosGroupedTabs[key] && !browserControlsTab(tab)) {
    try {
      if (typeof chrome.tabs.ungroup === 'function') await chrome.tabs.ungroup([tab]);
    } catch { /* A closed/moved tab needs no group cleanup. */ }
    if (!currentAdmission()) return conversationAdmissionRefusal(null);
    delete cosGroupedTabs[key];
    await persistLive().catch(() => undefined);
    if (!currentAdmission()) return conversationAdmissionRefusal(null);
  }
  if (Object.prototype.hasOwnProperty.call(protectedMainTabs, key)) {
    delete protectedMainTabs[key];
    await persistLive().catch(() => undefined);
    if (!currentAdmission()) return conversationAdmissionRefusal(null);
  }
  const preservedConversation = cleanConversationId(preserveOpeningConversation);
  const preservedOpening = Boolean(preservedConversation) &&
    cleanConversationId(appOwnedOpeningTabs[key]?.conversationId) === preservedConversation;
  if ((!preservedOpening && Object.prototype.hasOwnProperty.call(appOwnedOpeningTabs, key)) ||
      Object.prototype.hasOwnProperty.call(idleRootTabs, key)) {
    if (!preservedOpening) delete appOwnedOpeningTabs[key];
    delete idleRootTabs[key];
    clearRootRetentionDiagnostic(tab);
    await persistLive();
        if (!currentAdmission()) return conversationAdmissionRefusal(null);
  }
  const stillOwned = () => currentAdmission() &&
    (!expectedDocument || tabDocuments[key] === expectedDocument) &&
    (!Number.isSafeInteger(expectedEpoch) || tabEpochs[key] === expectedEpoch);
  if (!stillOwned()) return { ok: true, closed: false };
  // A fresh chat can have durable provisional observations before ChatGPT assigns /c/<id>.
  // Once this browser tab concretely leaves ChatGPT (or closes), those observations cannot be
  // safely rebound to a later unrelated chat that happens to reuse the same tab id.
  const provisional = expectedDocument ? `tab-${tab}:${expectedDocument}` : null;
  const reloadProvisional = reloadProvisionalKey(tab);
  const beforeJournal = journal.length;
  journal = journal.filter(
    (entry) =>
      (!provisional || entry.provisional !== provisional) &&
      (!reloadProvisional || entry.provisional !== reloadProvisional)
  );
  if (journal.length !== beforeJournal) await persistJournal();
  if (!stillOwned()) return { ok: true, closed: false };
  const current = cleanConversationId(tabConversations[key]);
  const wanted = cleanConversationId(expected);
  const protectedHere = discardProtectedTabs[key] === true;
  if (current && (!wanted || current === wanted)) {
    delete tabConversations[key];
  }
  if (protectedHere) {
    try {
      await chrome.tabs.update(tab, { autoDiscardable: true });
      if (!currentAdmission()) return conversationAdmissionRefusal(null);
    } catch {
      // A closed tab needs no restoration; navigation races are reconciled on the next pass.
    }
    if (!currentAdmission()) return conversationAdmissionRefusal(null);
    delete discardProtectedTabs[key];
  }
  if ((current && (!wanted || current === wanted)) || protectedHere) await persistLive();
  if (!stillOwned()) return { ok: true, closed: false };
  const conversationId = wanted || current;
  const sourceRetirement = retirement?.kind === 'superseded-source' &&
    retirement.conversationId === conversationId && /^[a-f0-9]{32}$/i.test(retirement.receiptId || '')
    ? retirement
    : null;
  // The removal receipt is independent of last-view closure. Queue it even when another exact
  // source tab (or an immediate user reopen) remains, so Main can spend this one close exactly.
  if (conversationId && sourceRetirement) {
    await enqueueClose(conversationId, true, sourceRetirement);
    if (!currentAdmission()) return conversationAdmissionRefusal(null);
  }
  if (!conversationId || conversationStillOpen(conversationId)) {
    if (sourceRetirement) await drainCloses();
    return { ok: true, closed: false };
  }
  // Deliver anything still queued before telling the app the final browser view is gone.
  await drain();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  if (!stillOwned() || conversationStillOpen(conversationId)) return { ok: true, closed: false };
  await enqueueClose(conversationId, byExtension, sourceRetirement, {
    tab,
    documentId: expectedDocument,
    navigationEpoch: expectedEpoch
  });
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  const delivered = await drainCloses();
  if (!currentAdmission()) return conversationAdmissionRefusal(null);
  // Closing runs inside this tab's ownership queue. Maintenance can offer input to
  // the same document and await its claim through that queue: awaiting it here
  // deadlocks New Chat reuse. Request the existing flight's next pass, then release
  // tab ownership so the elected document can claim its queued input.
  if (delivered.pending === 0) void maintain(true).catch(() => undefined);
  const reported = delivered.pending === 0;
  return {
    ok: true,
    closed: physicallyClosed && reported,
    departed: !physicallyClosed && reported,
    pendingClose: delivered.pending
  };
}

function conversationFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || (url.hostname !== 'chatgpt.com' && url.hostname !== 'chat.openai.com')) return null;
    // Matches chatgpt-dom.js: a Project conversation is `/g/<project>/c/<id>`, while
    // `/share/c/<id>` is a public snapshot the service worker must never bind a tab to.
    const match = /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(url.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * The ChatGPT Project a URL belongs to, or null.
 *
 * Matches src/main/session/continuation.ts's
 * normalizeProjectId: only `g-p-` plus 32 hex digits counts. A Project chat's path appends the
 * Project's display name to that id, so the name is stripped here rather than carried into an
 * address that a rename would invalidate. Custom GPTs are also served from `/g/`, and their
 * slugs do not have this shape, so they are correctly not Projects.
 */
function projectFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || (url.hostname !== 'chatgpt.com' && url.hostname !== 'chat.openai.com')) return null;
    if (url.pathname.length > 512) return null;
    const match = /^\/g\/(g-p-[0-9a-f]{32})(?:-[^/]*)?\//i.exec(url.pathname);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function isChatGptUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com');
  } catch {
    return false;
  }
}

/** Serializes every ownership transition and owned side effect for one browser tab. */
const tabOperationQueues = new Map();

/**
 * Which checkpoint fields may cross to the app, and what each one has to look like.
 *
 * Named in one list rather than eight hand-copied ternaries, because this body is rebuilt
 * field by field and a field nobody remembered to list is dropped in silence with both ends
 * of the feature looking correct. `destinationLost` did exactly that: content.js sends it and
 * bridge.ts acts on it, so the page could prove a brief never left it and the app would have
 * retired the lease and re-offered the brief at once — but the relay never carried the field,
 * so that path could not run and the chat waited out the whole lease instead.
 *
 * Still an allowlist, not a passthrough: nothing reaches the app unless it is named here, and
 * every field stays token-paired, because the field only says anything about the transaction
 * the token names.
 */
const COMPACT_CHECKPOINT_FLAGS = [
  'sourceAttempt',
  'sourceDispatch',
  'sourceLost',
  'destinationAttempt',
  'destinationDispatch',
  'destinationLost'
];
const COMPACT_CHECKPOINT_TEXT = ['summary', 'sourceMessageId', 'destinationMessageId'];
// Not a checkpoint of its own: it qualifies `sourceMessageId` by saying how far that exact
// marked response has grown. Sent only alongside the field it describes, so a bare count can
// never move a deadline by itself.
const COMPACT_CHECKPOINT_COUNTS = { sourceProgress: 'sourceMessageId' };

function compactCheckpointFields(message) {
  if (!message || typeof message.token !== 'string') return {};
  if (message.cancel === true)
    return /^[a-zA-Z0-9_-]{1,128}$/.test(message.token) ? { token: message.token } : {};
  const fields = {};
  for (const flag of COMPACT_CHECKPOINT_FLAGS) {
    if (message[flag] === true) fields[flag] = true;
  }
  for (const name of COMPACT_CHECKPOINT_TEXT) {
    if (typeof message[name] === 'string') fields[name] = message[name];
  }
  for (const [name, requires] of Object.entries(COMPACT_CHECKPOINT_COUNTS)) {
    if (Number.isSafeInteger(message[name]) && typeof fields[requires] === 'string') fields[name] = message[name];
  }
  return Object.keys(fields).length > 0 ? { token: message.token, ...fields } : {};
}

function serializeTab(tab, operation) {
  if (!Number.isInteger(tab)) return operation();
  const prior = tabOperationQueues.get(tab) || Promise.resolve();
  const current = prior.then(operation, operation);
  const tracked = current.finally(() => {
    if (tabOperationQueues.get(tab) === tracked) tabOperationQueues.delete(tab);
  });
  tabOperationQueues.set(tab, tracked);
  return tracked;
}

const HANDLERS = {
  async reloadCompanion(_message, sender) {
    if (!companionPopup(sender)) return { ok: false, error: 'popup_required' };
    if (companionReloadFlight) return { ok: false, error: 'reload_deferred', pendingWork: { reload: 1 } };
    const work = reloadCompanionSafely();
    companionReloadFlight = work;
    try { return await work; }
    finally { if (companionReloadFlight === work) companionReloadFlight = null; }
  },
  async project_create(message, _sender, source) {
    if (!ownsDocument(source) || !/^[a-f0-9-]{36}$/i.test(String(message.id || '')) || !source.documentId)
      return { ok: false };
    if (!['claim', 'arm', 'done', 'fail'].includes(message.action)) return { ok: false };
    let owner = (await chrome.storage.session.get('projectCreateOwner')).projectCreateOwner;
    const tab = owner?.tab === source.tab ? await chrome.tabs.get(source.tab).catch(() => null) : null;
    if (owner && tab) owner = await bindProjectCreateDocument(owner, tab);
    if (!owner || owner.id !== message.id || owner.tab !== source.tab ||
        owner.documentId !== source.documentId || owner.navigationEpoch !== source.navigationEpoch ||
        !ownsDocument(source)) return { ok: false };
    const body = JSON.stringify({ action: message.action, id: message.id,
      client: String(source.documentId).slice(0, 64),
      ...(typeof message.chatgptId === 'string' ? { chatgptId: message.chatgptId } : {}),
      ...(typeof message.error === 'string' ? { error: message.error.slice(0, 500) } : {}) });
    const result = await call('/project-create', { method: 'POST', body });
    if (message.action === 'done' && result.ok && result.data?.ok &&
        typeof message.chatgptId === 'string' && /^g-p-[0-9a-f]{32}$/.test(message.chatgptId)) {
      const latest = (await chrome.storage.session.get('projectCreateOwner')).projectCreateOwner;
      if (latest?.id === owner.id && latest.tab === source.tab && latest.documentId === source.documentId &&
          latest.navigationEpoch === source.navigationEpoch && ownsDocument(source)) {
        await chrome.storage.session.set({ projectCreateOwner: { ...latest, chatgptId: message.chatgptId } });
      }
    }
    if (['done', 'fail'].includes(message.action) && result.ok && result.data?.ok) void maintain();
    return result;
  },
  async tab_conversation(message, _sender, source) {
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const tab = await chrome.tabs.get(source.tab).catch(() => null);
    if (!tab || !ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const sourceConversationId = cleanConversationId(message.sourceConversationId);
    const current = conversationFromUrl(tab.url);
    const pending = conversationFromUrl(tab.pendingUrl);
    // Native Send may assign replacement B in pendingUrl while url is still the New Chat root
    // or source A. A is only an exclusion fence; exact document ownership remains mandatory.
    const conversationId = [pending, current].find(id => id && id !== sourceConversationId) || pending || current;
    return { ok: true, conversationId };
  },
  async accountChoices(_message, sender, source) {
    if (!pairingUiOwner(sender, source)) {
      return { ok: false, error: 'popup_required' };
    }
    const accounts = await localAccountChoices(true);
    if (!pairingUiOwner(sender, source)) return { ok: false, error: 'stale_document' };
    return { ok: true, accounts, instanceId };
  },
  async pairTo(message, sender, source) {
    if (!pairingUiOwner(sender, source)) {
      return { ok: false, error: 'popup_required' };
    }
    if (message.operatorAdoption !== undefined && message.operatorPreservation !== undefined)
      return { ok: false, error: 'account_history_choice_invalid' };
    await load();
    if (unassignedHistoryUncertain || sealedUnassignedHistory?.phase === 'sealed') return { ok: false, error: 'account_history_preservation_uncertain',
      message: 'Preserved-history generation is unconfirmed. Pairing remains held; preserve companion storage for recovery.' };
    if (!pairingUiOwner(sender, source)) return { ok: false, error: 'stale_document' };
    // Reserve the explicit settings click before the slow account /hello fanout. A newer
    // selection or Disconnect revokes this exact intent, even when discovery was pending.
    const intent = ++connectionEpoch;
    const choices = await localAccountChoices(true);
    if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
    if (!pairingUiOwner(sender, source)) return { ok: false, error: 'stale_document' };
    const selected = choices.find(row => row.instanceId === message.instanceId && row.compatible);
    if (!selected) return { ok: false, error: 'account_not_reachable', message: 'That COS account is not running or its companion version differs.' };
    if (sealedUnassignedHistory && message.operatorPreservation !== undefined &&
        (selected.instanceId !== sealedUnassignedHistory.targetInstanceId ||
          !exactOperatorPreservation(message.operatorPreservation, {
            version: 1, targetInstanceId: sealedUnassignedHistory.targetInstanceId,
            snapshotDigest: sealedUnassignedHistory.snapshotDigest,
            journalCount: sealedUnassignedHistory.history.journal.length,
            ordinaryCloseCount: sealedUnassignedHistory.history.localCloseOutbox.length
          }))) return { ok: false, error: 'account_history_preservation_changed' };
    if (instanceId === selected.instanceId && port === selected.port && token && !disconnected) return { ok: true };
    // Never retarget in-flight browser work to another account. The user can retry after it
    // settles; no queued message or command is silently moved between private runtimes.
    // A never-enrolled companion can already have native transcript observations. With no
    // selected account/token those cannot drain, so treating that journal as outgoing work
    // would make explicit first enrollment impossible. Prove raw absence of any prior tuple;
    // legacy, disconnected or malformed saved values are never a first-enrollment grant.
    const firstEnrollment = await neverBoundAccountConnection();
    if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
    if (!pairingUiOwner(sender, source)) return { ok: false, error: 'stale_document' };
    if (firstEnrollment && message.operatorPreservation !== undefined)
      return { ok: false, error: 'account_history_choice_invalid' };
    let operatorAdoption = null;
    // Per-selection diagnostic only: never a saved grant or a shared last-error slot.
    const adoptionDiagnostic = { refusal: null, preservationRefusal: null };
    if (!firstEnrollment) {
      const offeredAdoption = await operatorAdoptionSnapshot(selected.instanceId, null, adoptionDiagnostic);
      if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
      if (!pairingUiOwner(sender, source)) return { ok: false, error: 'stale_document' };
      if (offeredAdoption && message.operatorAdoption === undefined) {
        return {
          ok: false,
          error: 'account_history_adoption_required',
          operatorAdoption: offeredAdoption,
          message: 'This Chrome profile has preserved first-binding observations whose original CoS account was never recorded. Confirm once to associate only that exact preserved snapshot with the selected local account; nothing will be deleted or sent.'
        };
      }
      if (exactOperatorAdoption(message.operatorAdoption, offeredAdoption)) operatorAdoption = offeredAdoption;
    }
    if (!firstEnrollment && !operatorAdoption && !sealedUnassignedHistory && message.operatorAdoption === undefined) {
      const snapshot = await unassignedHistorySnapshot(selected.instanceId, adoptionDiagnostic);
      if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
      if (!pairingUiOwner(sender, source)) return { ok: false, error: 'stale_document' };
      if (snapshot) {
        const original = accountBusyError({ journal: journal.length, closeOutbox: closeOutbox.length }, adoptionDiagnostic);
        if (message.operatorPreservation === undefined) return { ...original,
          error: 'account_history_preservation_required', operatorPreservation: snapshot.offer,
          message: `${original.message} Preserve this exact unassigned history separately and connect future work in new chats; original history will not be associated with this account.` };
        if (!exactOperatorPreservation(message.operatorPreservation, snapshot.offer))
          return { ok: false, error: 'account_history_preservation_changed', message: 'The preserved-history choice changed. Review the current account and history again.' };
        const current = async () => {
          const ui = await pairingUiReady(sender, source);
          return ui.ok && intent === connectionEpoch && pairingUiOwner(sender, source);
        };
        if (!await preserveUnassignedHistory(snapshot, current)) return { ok: false,
          error: 'account_history_preservation_uncertain', message: 'History preservation could not be confirmed. Pairing remains held; preserve companion storage for recovery.' };
      } else if (message.operatorPreservation !== undefined) return { ok: false, error: 'account_history_preservation_changed' };
    }
    const pendingWork = await accountPairingBusy(firstEnrollment, null, operatorAdoption, selected.instanceId, adoptionDiagnostic);
    if (pendingWork) return accountBusyError(pendingWork, adoptionDiagnostic);
    if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
    if (!pairingUiOwner(sender, source)) return { ok: false, error: 'stale_document' };
    closeWakeSocket();
    if (browserController) await (await browserController).revoke();
    if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
    if (!pairingUiOwner(sender, source)) return { ok: false, error: 'stale_document' };
    // Keep the old connection in memory until storage accepts this exact still-idle intent.
    // A failed write must not silently redirect the next recorder request to another account.
    // Stage a disconnected choice. If a revoked write cannot be compensated, a restarted
    // worker must require an explicit retry instead of automatically pairing the wrong account.
    const next = { instanceId: selected.instanceId, port: selected.port, token: null, disconnected: true };
    let selectionError = 'connection_intent_superseded';
    let selectionBusy = null;
    let selectionWritten = false;
    const accept = async (written = false) => {
      if (written) selectionWritten = true;
      const ui = await pairingUiReady(sender, source);
      if (intent !== connectionEpoch) { selectionError = 'connection_intent_superseded'; return false; }
      if (!ui.ok) { selectionError = ui.error; selectionBusy = ui.pendingWork || null; return false; }
      const busy = await accountPairingBusy(firstEnrollment, written ? next : null,
        operatorAdoption, selected.instanceId, adoptionDiagnostic);
      if (intent !== connectionEpoch) { selectionError = 'connection_intent_superseded'; return false; }
      if (!pairingUiOwner(sender, source)) { selectionError = 'stale_document'; return false; }
      if (busy) { selectionError = 'account_busy'; selectionBusy = busy; return false; }
      return true;
    };
    try {
      const committed = await persist(next, () => {
        if (intent !== connectionEpoch || !pairingUiOwner(sender, source)) return false;
        connectorIdentityOwner = null;
        connectorApps = {}; connectorNames = {};
        ({ instanceId, port, token, disconnected } = next);
        pairingError = null;
        forgetPort();
        return true;
      }, accept);
      if (!committed) {
        // Resolve the live snapshot at its serialized write boundary. A newer committed
        // choice or Disconnect must never be overwritten by this older rollback snapshot.
        try { if (selectionWritten) await persist(undefined, null, null,
          firstEnrollment || operatorAdoption ? next : null); }
        catch {
          if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
          ++connectionEpoch;
          ({ instanceId, port, token, disconnected } = next);
          connectorIdentityOwner = null;
          connectorApps = {}; connectorNames = {};
          forgetPort();
          pairingError = { error: 'account_selection_uncertain', message: 'Chrome could not undo a cancelled account choice. The browser is disconnected; check companion storage and explicitly select the account again.' };
          return { ok: false, ...pairingError };
        }
        return selectionError === 'account_busy' && selectionBusy
          ? accountBusyError(selectionBusy, adoptionDiagnostic) : { ok: false, error: selectionError };
      }
    } catch {
      return { ok: false, error: 'account_selection_save_failed',
        message: 'Chrome could not save the selected CoS account. The previous connection is retained; check companion storage and try again.' };
    }
    // The durable connection commit now owns account-wide completion through its epoch.
    if (intent !== connectionEpoch) return { ok: false, error: 'connection_intent_superseded' };
    const result = await provision(true);
    if (result?.ok) {
      if (operatorAdoption) console.info('[Chat On Steroids] operator approved preserved first-binding history association', {
        targetInstanceId: selected.instanceId,
        journalCount: operatorAdoption.journalCount,
        ordinaryCloseCount: operatorAdoption.ordinaryCloseCount
      });
      void drainCommandAcks().then(() => drain()).then(() => drainCloses()).catch(() => undefined);
    } else if (firstEnrollment || operatorAdoption) {
      // The preserved rows do not belong to the selected account until that exact account
      // returns a token. Restore the proven absent tuple after a failed mint so a retry must
      // repeat the explicit selection/confirmation rather than getting stuck behind its own
      // still-unassigned journal. Never erase a tuple that another intent replaced.
      const absent = { instanceId: null, port: null, token: null, disconnected: false };
      try {
        const restored = await persist(absent, () => {
          if (intent !== connectionEpoch || !pairingUiOwner(sender, source) ||
              instanceId !== next.instanceId || port !== next.port || token !== next.token ||
              disconnected !== next.disconnected) return false;
          ({ instanceId, port, token, disconnected } = absent);
          connectorIdentityOwner = null;
          connectorApps = {}; connectorNames = {};
          forgetPort();
          return true;
        }, () => intent === connectionEpoch && pairingUiOwner(sender, source), next);
        if (!restored) return { ok: false, error: 'connection_intent_superseded' };
      } catch {
        return { ok: false, error: 'account_selection_uncertain',
          message: 'Chrome could not restore the unassigned account after pairing failed. Preserved history remains held; check companion storage before retrying.' };
      }
    }
    return result;
  },
  async plugin_refresh(message, _sender, source) {
    if (!ownsDocument(source) || !/^[a-f0-9-]{36}$/i.test(String(message.id || ''))) return { ok: false };
    if (!(await pluginRefreshBridgeOwner(source, message.id))) return { ok: false };
    if (!['claim', 'current', 'manual', 'complete', 'fail'].includes(message.action)) return { ok: false };
    const body = JSON.stringify({ action: message.action, id: message.id, appId: message.appId,
      connectorName: message.connectorName, tools: message.tools, versionId: message.versionId,
      attemptToken: message.attemptToken, confirmedUnclicked: message.confirmedUnclicked === true,
      error: message.error });
    if (body.length > 310000) return { ok: false };
    const result = await call('/plugin-refresh', { method: 'POST', body });
    if (!(await pluginRefreshBridgeOwner(source, message.id))) {
      // Main durably accepted this exact authorization, but the content operation cannot receive
      // it and therefore cannot click. Consume the attempt while shortening only its cooldown.
      if (message.action === 'claim' && result.ok && result.data?.ok &&
          typeof message.appId === 'string' && typeof message.attemptToken === 'string') {
        await call('/plugin-refresh', { method: 'POST', body: JSON.stringify({ action: 'fail',
          id: message.id, appId: message.appId, attemptToken: message.attemptToken,
          confirmedUnclicked: true, error: 'Connector owner changed before the accepted Refresh authorization could be delivered' }) });
      }
      return { ok: false };
    }
    if (['current', 'manual', 'complete', 'fail'].includes(message.action) && result.ok && result.data?.ok) void maintain();
    return result;
  },
  async model_catalog(message, _sender, source) {
    if (!ownsDocument(source) || typeof message.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(message.nonce)) return { ok: false };
    const tab = await chrome.tabs.get(source.tab);
    // Native model inspection can change ChatGPT's SPA URL without replacing the
    // authorized document. Custody is the elected tab, nonce and live document,
    // not the URL observed before the picker was opened.
    if (!ownsDocument(source) || modelCatalogTarget?.tab !== source.tab || modelCatalogTarget.nonce !== message.nonce ||
      (modelCatalogTarget.documentId && modelCatalogTarget.documentId !== source.documentId) ||
      tab.pendingUrl || !isChatGptUrl(tab.url)) return { ok: false };
    const body = JSON.stringify({ nonce: message.nonce, models: message.models, error: message.error });
    if (body.length > 12000) return { ok: false };
    const result = await call('/models', { method: 'POST', body });
    return result;
  },
  async conversation_deleted(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const claimed = typeof message.conversationId === 'string' ? message.conversationId.toLowerCase() : '';
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(claimed) || !currentAdmission())
      return { ok: false, error: 'invalid_deleted_conversation' };
    const tab = await chrome.tabs.get(source.tab);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const current = conversationFromUrl(tab?.url);
    // Content's request ticket covers a native redirect home, but never another concrete
    // route, a navigation in flight, or an old document incarnation of this same tab.
    if (!currentAdmission() || !tab || tab.pendingUrl || !isChatGptUrl(tab.url) ||
        (current && current.toLowerCase() !== claimed)) return { ok: false, error: 'stale_deleted_conversation' };
    return call('/conversation/deleted', { method: 'POST', body: JSON.stringify({ conversationId: claimed }) }, false, currentAdmission);
  },
  async usage_observation(message, _sender, source) {
    if (!ownsDocument(source) || !Array.isArray(message.rows) || message.rows.length > 80) return { ok: false };
    const body = JSON.stringify({ rows: message.rows, observedAt: message.observedAt });
    if (body.length > 24000) return { ok: false };
    return call('/usage', { method: 'POST', body });
  },
  async desktop_input(message, sender, source) {
    let admittedConversation = cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]);
    const admission = conversationAdmission(source);
    const currentAdmission = () => admission(admittedConversation);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const id = String(message.id || '');
    if (!/^[a-f0-9-]{36}$/i.test(id)) return { ok: false };
    const tab = await chrome.tabs.get(source.tab);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const conversationId = conversationFromUrl(tab.url);
    admittedConversation = conversationId ?? admittedConversation;
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const prefix = `${source.tab}:${sender.documentId}:`;
    const completed = message.ack === true || message.fail === true || typeof message.response === 'string' ||
      typeof message.partial === 'string' || typeof message.stage === 'string';
    const owner = completed ? String(message.owner || '') : `${prefix}${source.navigationEpoch}`;
    if (completed) {
      if (!owner.startsWith(prefix) || !currentAdmission()) return { ok: false };
      const completionUrl = new URL(tab.url);
      const electedStrippedHelper = inputOpenings[id]?.tab === source.tab &&
        completionUrl.origin === 'https://chatgpt.com' && completionUrl.pathname === '/' &&
        !completionUrl.search && !completionUrl.hash;
      // A native-sent Temporary Chat can lose BOTH markers as ChatGPT assigns /c/<id>.
      // Only the already-elected tab, same document/navigation owner and one concrete
      // provider route may pass this transport check; Main still validates the exact
      // durable helper Send/answer receipt. No new click or recovery authority follows.
      const electedRoutedHelper = inputOpenings[id]?.tab === source.tab &&
        completionUrl.origin === 'https://chatgpt.com' && conversationId !== null &&
        completionUrl.pathname === `/c/${conversationId}` && !completionUrl.search && !completionUrl.hash;
      if (message.lifetime === 'temporary-planner' && (owner !== `${prefix}${source.navigationEpoch}` ||
          (completionUrl.searchParams.get('temporary-chat') !== 'true' && !electedStrippedHelper && !electedRoutedHelper))) return { ok: false };
    } else {
      // ChatGPT may strip cos-input after the service worker elected this exact tab. Keep
      // that durable custody instead of requiring a URL marker the provider controls.
      if (!conversationId && !String(tab.url || '').includes(`cos-input=${id}`) &&
          inputOpenings[id]?.tab !== source.tab) return { ok: false };
      if (message.conversationId !== conversationId || !currentAdmission()) return { ok: false };
    }
    if (message.ack === true && message.lifetime !== 'temporary-planner') {
      if (message.conversationId !== conversationId || !currentAdmission()) return { ok: false, error: 'stale_send_receipt' };
      return ackDesktopInput(id, owner, conversationId, message.messageId, currentAdmission);
    }
    if (message.fail === true && message.confirmedUnsent === true) {
      // This is stronger than a transport failure: the still-current owning document says its
      // pre-click callback never crossed native Send. Navigation makes that proof ambiguous, so
      // fail closed rather than journaling it under a different conversation.
      if (message.conversationId !== conversationId || !currentAdmission()) return { ok: false, error: 'stale_pre_send_receipt' };
      return releaseDesktopInputBeforeSend(id, owner, conversationId, message.error, message.detail, currentAdmission);
    }
    if (typeof message.attachmentId === 'string') {
      if (message.owner !== owner || !currentAdmission()) return { ok: false };
      const result = await call('/input/attachment', { method: 'POST', body: JSON.stringify({ id, owner, conversationId, attachmentId: message.attachmentId, offset: message.offset }) }, false, currentAdmission);
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
      return currentAdmission() ? result : { ok: false, error: 'stale_document' };
    }
    const result = await call(typeof message.stage === 'string' ? '/input/stage' : typeof message.partial === 'string' ? '/input/progress' : typeof message.response === 'string' ? '/input/answer' : message.fail === true ? '/input/fail' : message.ack === true ? '/input/ack' : '/input/claim', {
      method: 'POST', body: JSON.stringify({ id, owner, conversationId, silenceBusyTurnId: typeof message.silenceBusyTurnId === 'string' ? message.silenceBusyTurnId : undefined, requiresAuthorization: message.requiresAuthorization === true, freshTurnProtocol: message.freshTurnProtocol === 1 ? 1 : undefined, authorize: message.authorize === true, confirmedUnsent: message.confirmedUnsent === true, stage: typeof message.stage === 'string' ? message.stage.slice(0, 64) : undefined, partial: typeof message.partial === 'string' ? message.partial.slice(-8000) : undefined, messageId: typeof message.messageId === 'string' ? message.messageId : undefined, error: message.error, detail: typeof message.detail === 'string' && /^[a-z-]{1,40}$/.test(message.detail) ? message.detail : undefined, response: typeof message.response === 'string' ? message.response.slice(0, 16001) : undefined, project: typeof message.project === 'string' && /^g-p-[0-9a-f]{32}$/.test(message.project) ? message.project : undefined })
    }, false, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (message.authorize === true && result.ok && result.data?.ok === true) {
      const proof = message.receipt;
      if (!proof || !/^[a-f0-9]{64}$/i.test(String(proof.digest || '')) ||
          !(proof.previousMessageId === null || (typeof proof.previousMessageId === 'string' && proof.previousMessageId.length <= 256))) {
        return { ok: false, error: 'invalid_send_receipt' };
      }
      pendingInputReceipts[id] = {
        tab: source.tab,
        owner,
        digest: String(proof.digest).toLowerCase(),
        previousMessageId: proof.previousMessageId,
        authorizedAt: Date.now()
      };
      try {
        await persistLive();
        if (!currentAdmission()) return conversationAdmissionRefusal(source);
      } catch {
        delete pendingInputReceipts[id];
        return { ok: false, error: 'send_receipt_not_durable' };
      }
    }
    if (typeof message.response === 'string' && message.lifetime === 'temporary-planner' && result.ok && result.data?.ok === true && currentAdmission()) {
      // Acceptance retires this exact helper immediately. Fresh page proof still
      // protects generation, a user draft, pinning and document/navigation changes.
      try {
        const current = await chrome.tabs.get(source.tab);
        if (!currentAdmission()) return conversationAdmissionRefusal(source);
        if (!current.pinned && !current.pendingUrl && currentAdmission() && current.url === tab.url) {
          if (!await temporaryHelperOutputSaved(id, owner, conversationFromUrl(current.url), source)) return result;
          const proof = await tabReply(source.tab, { type: 'clf-close-temporary-planner', id, owner, accepted: true }, { documentId: source.documentId });
          if (!currentAdmission()) return conversationAdmissionRefusal(source);
          const latest = await chrome.tabs.get(source.tab);
          if (!currentAdmission()) return conversationAdmissionRefusal(source);
          if (proof?.safe === true && proof.navigationEpoch === source.navigationEpoch && currentAdmission() &&
              !latest.pinned && !latest.pendingUrl && latest.url === tab.url &&
              temporaryPlannerCloseProofMatches(latest.url, id, proof)) await retireAutomaticTab(source.tab);
        }
      } catch { /* terminal outbox maintenance can retry the same exact safe close */ }
    }
    if (typeof message.response === 'string' && message.lifetime !== 'temporary-planner' && result.ok && result.data?.ok === true && currentAdmission()) {
      // Accepting the answer retires the helper's work, not the user's tab or draft.
      // Use the same live page proof as maintenance before the final physical close.
      try {
        const current = await chrome.tabs.get(source.tab);
        if (!currentAdmission()) return conversationAdmissionRefusal(source);
        if (!current.pinned && !current.pendingUrl && currentAdmission() && conversationFromUrl(current.url) === conversationId) {
          const proof = await tabReply(source.tab, { type: 'clf-tab-close-check', conversationId,
            completedDecision: { id, owner } }, { documentId: source.documentId });
          if (!currentAdmission()) return conversationAdmissionRefusal(source);
          const latest = await chrome.tabs.get(source.tab);
          if (!currentAdmission()) return conversationAdmissionRefusal(source);
          if (proof?.safe === true && proof.conversationId === conversationId && proof.navigationEpoch === source.navigationEpoch &&
              !latest.pinned && !latest.pendingUrl && currentAdmission() && conversationFromUrl(latest.url) === conversationId &&
              journalCountForConversation(conversationId) === 0) await retireAutomaticTab(source.tab);
        }
      } catch { /* already closed; the accepted app-side answer remains authoritative */ }
    }
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    return result;
  },
  async register_document(_message, sender) {
    const result = await registerDocument(sender, _message);
    if (result?.ok === true) {
      const owner = (await chrome.storage.session.get('projectCreateOwner')).projectCreateOwner;
      if (owner?.tab === result.tab && !owner.documentId) {
        const tab = await chrome.tabs.get(result.tab).catch(() => null);
        await bindProjectCreateDocument(owner, tab);
      }
    }
    if (result?.ok === true) void maintain(true).catch(() => undefined);
    if (result && result.ok === true) void recoverDeferredRevivals().catch(() => undefined);
    return result;
  },
  async status() {
    await load();
    const found = await discover();
    // Provisioning here as well as in call() is what makes the popup show "Connected"
    // the first time it is opened, rather than a truthful but useless "not paired".
    // Not after a deliberate disconnect: opening the popup to check is not a request to
    // undo the thing the popup was opened to check.
    if (found && !token && !disconnected) await provision();
    if (found && token) {
      void drainCommandAcks()
        .then(() => drain())
        .then(() => drainCloses())
        .catch(() => undefined);
    }
    return {
      connected: found !== null,
      port: found ? found.port : null,
      instanceId,
      instanceError: instanceBindingError,
      ...(connectorIdentityOwner === instanceId && found && token ? { connectorApps, connectorNames } : {}),
      paired: token !== null,
      disconnected,
      pending: journal.length,
      pendingCommandAcks: commandAckOutbox.length,
      compatible: found ? found.compatible !== false : null,
      appVersion: found ? found.version : null,
      appProtocol: found ? found.bridge : null,
      extensionVersion: chrome.runtime.getManifest().version,
      extensionProtocol: BRIDGE_PROTOCOL,
      browserAttentionCommandIds: [...latestBrowserAttentionCommandIds],
      ...(pairingError ? { pairError: pairingError } : {})
    };
  },
  async pair() {
    await load();
    // This message exists only behind the popup's Connect/Retry control. Advance the intent
    // generation so an older silent provision already on the wire cannot win after this
    // explicit reconnect, then tell the app this /pair is allowed to clear its durable latch.
    connectionEpoch++;
    const result = await provision(true);
    if (result && result.ok) {
      void drainCommandAcks()
        .then(() => drain())
        .then(() => drainCloses())
        .catch(() => undefined);
    }
    return result;
  },
  async unpair() {
    await load();
    // Disconnect takes ownership before awaiting controller cleanup. An older popup
    // selection must not progress while revoke() is pending.
    connectionEpoch++;
    closeWakeSocket();
    if (browserController) await (await browserController).revoke();
    // All earlier /hello and /pair requests now carry a stale intent.
    token = null;
    // Remembered, not just cleared. Otherwise the next request — two seconds away in any
    // open tab — provisions a new token and the browser is connected again.
    disconnected = true;
    pairingError = null;
    await persist();
    return { ok: true };
  },
  /** Ask every eligible ChatGPT tab to rebuild its Chat On Steroids activity stream now. */
  async overwriteNow() {
    await load();
    const known = Object.keys(tabConversations)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value));
    // The registry is authoritative for session lifetime, but it is populated only after a
    // page has bound/observed something. A valid ChatGPT tab can therefore be absent at the
    // exact moment the user turns Overwrite on. Discover the same host allowlist used by
    // extension-reload recovery and union it with the durable registry. Host permissions in
    // manifest.json already authorize URL-filtered tabs.query on these origins.
    let discovered = [];
    try {
      discovered = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
    } catch {
      discovered = [];
    }
    const tabs = [
      ...new Set([
        ...known,
        ...discovered
          .map((tab) => (tab && typeof tab.id === 'number' ? tab.id : NaN))
          .filter((value) => Number.isInteger(value))
      ])
    ];
    let applied = 0;
    for (const id of tabs) {
      try {
        const result = await chrome.tabs.sendMessage(id, { type: 'clf-overwrite-now' });
        if (result && result.ok === true) applied += 1;
      } catch {
        // A tab may be between navigations/reloads and temporarily have no receiver. The
        // registry is tab-lifetime state, so do not retire it merely because one send raced.
      }
    }
    return { ok: true, tabs: applied, attempted: tabs.length };
  },
  /**
   * Everything this worker and the visible page know about the chat in front of the user.
   *
   * Read-only and popup-only. It exists because the three questions people actually have
   * — did it pick up this chat, what is the chat called, is anything reaching the app —
   * were previously unanswerable without opening the app's log next to the browser's.
   */
  async tabStatus() {
    await load();
    let active = null;
    try {
      const found = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      active = found && found.length > 0 ? found[0] : null;
    } catch {
      active = null;
    }
    const tab = active && typeof active.id === 'number' ? active.id : null;
    const key = tab === null ? null : String(tab);
    const isChat = isChatGptUrl(active && active.url);
    const bound = key ? cleanConversationId(tabConversations[key]) : null;
    const documentId = key && typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null;
    const provisional = tab !== null && documentId ? `tab-${tab}:${documentId}` : null;
    const terminal = key ? Object.prototype.hasOwnProperty.call(terminalDocuments, key) : false;

    let page = null;
    if (tab !== null && isChat) {
      try {
        page = await tabReply(tab, { type: 'clf-page-status' });
      } catch {
        // No live recorder in that document: an unreloaded tab from before this extension
        // was loaded, or a page still starting up. Reported as such rather than as an error.
        page = null;
      }
    }

    let chatTabs = 0;
    try {
      chatTabs = (await chrome.tabs.query({ url: CHATGPT_TAB_URLS })).length;
    } catch {
      chatTabs = 0;
    }

    const conversationId = bound || (page && cleanConversationId(page.conversationId)) || conversationFromUrl(active && active.url);
    return {
      tab,
      isChat,
      url: isChat ? String((active && active.url) || '') : null,
      conversationId,
      bound: bound !== null,
      documentId,
      epoch: key && Number.isSafeInteger(tabEpochs[key]) ? tabEpochs[key] : null,
      terminal,
      recorder: page !== null,
      page,
      chatTabs,
      pending: journal.filter(
        (entry) =>
          (conversationId && entry.conversationId === conversationId) ||
          (provisional && entry.provisional === provisional)
      ).length,
      pendingAll: journal.length,
      pendingCloses: closeOutbox.length,
      pendingCommandAcks: commandAckOutbox.length,
      delivery
    };
  },
  /**
   * Takes observations off a content script's hands.
   *
   * Answering ok means "journalled here", not "the app has it". That is the point: the
   * page can be reloaded a moment later, and this worker will keep retrying delivery.
   * Entries with no conversation id yet are journalled too, under the tab that saw
   * them, so the very first message of a fresh chat is durable before ChatGPT has
   * decided what to call the conversation.
   */
  async events(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (unassignedHistoryUncertain || unassignedHistoryConversation(message.conversationId) ||
        (Array.isArray(message.entries) ? message.entries : []).some(row => unassignedHistoryConversation(row?.conversationId)))
      return { ok: false, error: 'account_history_unassigned', durable: false,
        message: 'This old conversation remains preserved without account attribution. Start a new chat for work on the selected account.' };
    if (message.projectInput) {
      const claim = message.projectInput;
      const tab = await chrome.tabs.get(source.tab);
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
      const conversationId = conversationFromUrl(tab.url);
      const prefix = `${source.tab}:${_sender.documentId}:`;
      if (!conversationId || message.conversationId !== conversationId ||
          !/^[a-f0-9-]{36}$/i.test(String(claim.id || '')) ||
          typeof claim.owner !== 'string' || !claim.owner.startsWith(prefix) || !currentAdmission()) {
        return { ok: false, error: 'project_binding_pending' };
      }
      const bound = await call('/input/bind', { method: 'POST', body: JSON.stringify({ id: claim.id, owner: claim.owner, conversationId }) }, false, currentAdmission);
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
      if (!bound.ok || bound.data?.ok !== true || !currentAdmission()) return { ok: false, error: 'project_binding_pending' };
    }
    await noteTabConversation(source, message.conversationId);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const tab = await chrome.tabs.get(source.tab).catch(() => null);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const project = projectFromUrl(tab?.url);
    const currentConversation = cleanConversationId(message.conversationId);
    if (currentConversation && conversationFromUrl(tab?.url) === currentConversation) {
      const candidates = (Array.isArray(message.entries) ? message.entries : [])
        .map(entry => entry?.event)
        .filter(event => event?.kind === 'user_message' && typeof event.text === 'string' &&
          typeof event.messageId === 'string' && event.messageId.length > 0 && event.messageId.length <= 256);
      let changedPendingReceipt = false;
      for (const [inputId, receipt] of Object.entries(pendingInputReceipts)) {
        if (receipt.tab !== source.tab || Date.now() - receipt.authorizedAt > PENDING_INPUT_RECEIPT_MS) continue;
        const previousIndex = receipt.previousMessageId === null
          ? -1
          : candidates.findIndex(event => event.messageId === receipt.previousMessageId);
        // A replacement document normally publishes its transcript in chronological order.
        // An existing-chat Send requires its original last-user anchor in THIS batch before
        // text can prove a later native row. A partial/virtualized batch without that anchor
        // says nothing about ordering: an older identical message must not steal this receipt.
        // Fresh chats retain their explicit null-anchor rule; exact click/request ACKs remain
        // under their separate receipt owner. Neither missing history nor elapsed time is Send.
        if (receipt.previousMessageId !== null && previousIndex < 0) continue;
        for (let index = candidates.length - 1; index > previousIndex; index--) {
          const event = candidates[index];
          if (!event || event.messageId === receipt.previousMessageId) continue;
          const normalized = String(event.text || '')
            .replace(/\r\n?/g, '\n')
            .replace(/\\([\\`*_{}\[\]()#+\-.!<>&:])/g, '$1')
            .replace(/\[(https?:\/\/[^\]\s]{1,4096})\]\((https?:\/\/[^)\s]{1,4096})\)/g,
              (whole, label, destination) => label === destination ? label : whole)
            .replace(/\s+/g, '');
          if (!normalized || normalized.length > 240000) continue;
          const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
          if (!currentAdmission()) return conversationAdmissionRefusal(source);
          const digest = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
          if (digest !== receipt.digest) continue;
          await ackDesktopInput(inputId, receipt.owner, currentConversation, event.messageId, currentAdmission);
          if (!currentAdmission()) return conversationAdmissionRefusal(source);
          break;
        }
        // A fresh-chat route by itself is not Send proof. The authorizing document can disappear
        // after Main grants Send but before the native click, and the same tab may later host an
        // unrelated conversation. Keep the durable digest until a native user row matches it;
        // only that row's message id can acknowledge delivery across a document replacement.
      }
      for (const [inputId, receipt] of Object.entries(pendingInputReceipts)) {
        if (Date.now() - receipt.authorizedAt > PENDING_INPUT_RECEIPT_MS) {
          delete pendingInputReceipts[inputId];
          changedPendingReceipt = true;
        }
      }
      if (changedPendingReceipt) await persistLive();
    }
    const key = tabKey(source);
    const entries = (Array.isArray(message.entries) ? message.entries : []).map((entry) =>
      entry && !entry.conversationId
        ? { ...entry, provisional: key, project }
        : entry ? { ...entry, project } : entry
    );
    if (instanceId === null && port === null && token === null && journal.length + entries.length > 4000)
      return { ok: false, error: 'unassigned_history_capacity', durable: false };
    if (instanceId === null && port === null && token === null) {
      try { cloneUnassignedHistoryData(journal.concat(entries)); }
      catch { return { ok: false, error: 'unassigned_history_capacity', durable: false }; }
    }
    // The page/receipt probes above yield. A confirmed seal may have cut over while
    // this packet was waiting, so admission must reprove its scope before enqueue.
    if (unassignedHistoryUncertain || unassignedHistoryConversation(message.conversationId) ||
        entries.some(row => unassignedHistoryConversation(row?.conversationId)))
      return { ok: false, error: 'account_history_unassigned', durable: false };
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    enqueue(entries);
    let ackBound = 0;
    if (message.conversationId) {
      bindProvisional(key, message.conversationId);
      ackBound = bindCommandAckProvisional(key, message.conversationId);
    }
    const stored = await persistJournal();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (ackBound > 0) await persistLive();
    if (!currentAdmission()) return { ok: false, error: 'stale_document' };
    if (unassignedHistoryUncertain || unassignedHistoryConversation(message.conversationId) ||
        entries.some(row => unassignedHistoryConversation(row?.conversationId)))
      return { ok: false, error: 'account_history_unassigned', durable: false };
    if (ackBound > 0) await drainCommandAcks();
    const result = await drain();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (unassignedHistoryUncertain || unassignedHistoryConversation(message.conversationId) ||
        entries.some(row => unassignedHistoryConversation(row?.conversationId)))
      return { ok: false, error: 'account_history_unassigned', durable: false };
    return { ok: true, pending: result.pending, durable: stored, projectBound: message.projectInput?.id };
  },

  /**
   * The tab now knows which conversation it is in.
   *
   * Everything it observed beforehand belongs to that conversation, including anything
   * journalled during a page load that happened before the id existed — the tab key
   * survives a reload, which is the whole reason it is the tab and not the page.
   */
  async bind(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (unassignedHistoryUncertain || unassignedHistoryConversation(message.conversationId))
      return { ok: false, error: 'account_history_unassigned' };
    await noteTabConversation(source, message.conversationId);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (unassignedHistoryUncertain || unassignedHistoryConversation(message.conversationId))
      return { ok: false, error: 'account_history_unassigned' };
    const opening = appOwnedOpeningTabs[String(source.tab)];
    if (cleanConversationId(opening?.conversationId) === cleanConversationId(message.conversationId)) {
      delete appOwnedOpeningTabs[String(source.tab)];
      await chrome.storage.session.set({ appOwnedOpeningTabs });
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
    }
    const key = tabKey(source);
    const bound = bindProvisional(key, String(message.conversationId || ''));
    const ackBound = bindCommandAckProvisional(key, String(message.conversationId || ''));
    if (bound > 0) {
      await persistJournal();
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
    }
    if (ackBound > 0) await persistLive();
    if (ackBound > 0) await drainCommandAcks();
    if (bound > 0) await drain();
    return { ok: true, bound, ackBound };
  },
  async drain() {
    return drain();
  },
  /**
   * Registers exact request-id ownership for the currently live ChatGPT turn.
   *
   * Unlike normal transcript events this is an acknowledged identity operation: the app
   * creates/reuses the conversation session, stores the request-id join, reads it back, and
   * tells the page which ids are actually confirmed. content.js retries unconfirmed ids on a
   * later Fiber scan, so a sleeping worker/app can delay attribution but cannot silently turn a
   * known request into a permanent Unattributed call.
   */
  async correlate(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, error: 'bad_conversation_id' };
    const epoch = connectionEpoch;
    const current = () => epoch === connectionEpoch && ownsDocument(source) &&
      !unassignedHistoryUncertain && !unassignedHistoryConversation(conversationId);
    const refusal = () => ({ ok: false, error: unassignedHistoryUncertain || unassignedHistoryConversation(conversationId)
      ? 'account_history_unassigned' : !ownsDocument(source) ? 'stale_document' : 'connection_intent_superseded' });
    if (!current()) return refusal();
    await noteTabConversation(source, conversationId);
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    if (!current()) return refusal();
    const calls = Array.isArray(message.calls) ? message.calls : [];
    if (calls.length === 0) return { ok: false, error: 'bad_request_evidence' };
    const agent = typeof message.agent === 'string' && /^[a-z0-9-]{1,40}$/i.test(message.agent) ? message.agent : null;
    const agentCommandId = agent && typeof message.agentCommandId === 'string' && message.agentCommandId.length <= 200
      ? message.agentCommandId
      : null;
    const result = await call('/correlations', {
      method: 'POST',
      body: JSON.stringify({ conversationId, calls,
        ...(typeof message.turnId === 'string' && /^g-[a-z0-9_-]{3,180}$/i.test(message.turnId)
          ? { turnId: message.turnId } : {}),
        ...(agent && agentCommandId ? { agent, agentCommandId } : {}) })
    }, false, current);
    return current() ? result : refusal();
  },
  async activity(message, _sender, source) {
    if (message.observationOnly !== undefined && message.observationOnly !== true)
      return { ok: false, error: 'bad_observation' };
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (message.observationOnly === true) {
      if (!token || !port || !instanceId || disconnected ||
          cleanConversationId(message.conversationId) !== cleanConversationId(tabConversations[String(source.tab)]))
        return { ok: false, error: 'observation_owner_unconfirmed' };
    } else await noteTabConversation(source, message.conversationId);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    // Diagnostic evidence is optional and never authorizes this poll. Stamp it here, where
    // Chrome's real document id + navigation epoch are available, and only while the tab's
    // current route still names the same conversation. The page may suggest request ids/shell
    // shape; it may not supply or override document ownership.
    let coreDiagnostic = null;
    try {
      const tab = await chrome.tabs.get(source.tab);
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
      const raw = message && message.coreDiagnostic && typeof message.coreDiagnostic === 'object'
        ? message.coreDiagnostic : null;
      if (raw && currentAdmission() && !tab.pendingUrl && conversationFromUrl(tab.url) === message.conversationId) {
        const shell = ['classic', 'alternate', 'unknown'].includes(raw.shell) ? raw.shell : 'unknown';
        const shellDiscovery = ['compatible', 'failed', 'unknown'].includes(raw.shellDiscovery)
          ? raw.shellDiscovery : 'unknown';
        const shellScan = shellScanDiagnostic(raw.shellScan);
        const ordinaryFinal = ordinaryFinalDiagnostic(raw.ordinaryFinal);
        const requestIds = [...new Set((Array.isArray(raw.requestIds) ? raw.requestIds : [])
          .filter(value => typeof value === 'string' && value.length > 0 && value.length <= 100))].slice(0, 16);
        const turnId = typeof raw.turnId === 'string' && raw.turnId.length > 0 && raw.turnId.length <= 200
          ? raw.turnId : null;
        coreDiagnostic = {
          shell,
          shellDiscovery,
          shellScan,
          ordinaryFinal,
          requestIds,
          turnId,
          documentId: source.documentId,
          navigationEpoch: source.navigationEpoch,
          observedAt: Date.now()
        };
      }
    } catch {}
    if (!currentAdmission()) return { ok: false, error: 'stale_document' };
    if (message.observationOnly === true) {
      if (!coreDiagnostic) return { ok: false, error: 'bad_observation' };
      // POST's explicit body key makes older Main builds reject before normal activity
      // side effects. This branch never consumes offers, places successors or falls back.
      const result = await call(`/activity?conversationId=${encodeURIComponent(message.conversationId)}`, {
        method: 'POST', body: JSON.stringify({ coreDiagnostic, observationOnly: true })
      }, false, currentAdmission);
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
      const tab = await chrome.tabs.get(source.tab).catch(() => null);
      if (!currentAdmission() || !tab || tab.pendingUrl || tab.status === 'loading' ||
          conversationFromUrl(tab.url) !== message.conversationId)
        return { ok: false, error: 'stale_document' };
      return result?.ok === true && result.data?.observationOnly === true &&
        result.data.observationAccepted === true && result.data.completionVerified === false
        ? result : { ok: false, error: 'observation_unconfirmed' };
    }
    // Goal drafts are conversation-scoped in the app but browser writes are tab-scoped. Tell
    // the app which tab is polling so two tabs showing the same chat cannot both receive and
    // submit one ready Goal draft.
    const query =
      `?conversationId=${encodeURIComponent(message.conversationId)}` +
      `&since=${Number(message.since) || 0}` +
      `&goalClient=${encodeURIComponent(String(source.tab))}` +
      (typeof message.approval === 'boolean' ? `&approval=${message.approval ? '1' : '0'}` : '');
    const diagnosticQuery = coreDiagnostic ? `&coreDiagnostic=${encodeURIComponent(JSON.stringify(coreDiagnostic))}` : '';
    // Exact terminal proof can contain the existing 200 native call/Code Mode identities.
    // A long URL is rejected by HTTP before Main sees it, and truncating those arrays would
    // permanently strand the original fence. Keep legacy small GETs; only the same bounded
    // observation moves into the existing authenticated activity request's body. Its route,
    // elected document and connection admission still belong to this exact flight.
    const postDiagnostic = coreDiagnostic && query.length + diagnosticQuery.length > 8_000;
    const result = await call(`/activity${query}${postDiagnostic ? '' : diagnosticQuery}`,
      postDiagnostic ? { method: 'POST', body: JSON.stringify({ coreDiagnostic }) } : {}, false, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (currentAdmission() && result.ok && result.data && await acceptBrowserRevivals(result.data, currentAdmission)) {
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
      await recoverDeferredRevivals();
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
    }
    // A fresh chat the app wants opened beside this one. Offered only to the home chat's own
    // poll, so the window this tab is in is the window its successor is created in.
    if (currentAdmission() && result.ok && result.data && result.data.placement) {
      await placeSuccessorChat(result.data.placement, source.tab, currentAdmission);
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
    }
    return currentAdmission() ? result : { ok: false, error: 'stale_document' };
  },
  /** Reinstall the least-trusted MAIN-world reader when a live content script loses it. */
  async repair_fiber(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    const explicit = message.operatorRefresh === true;
    if (message.operatorRefresh !== undefined && !explicit) return { ok: false, error: 'fiber_refresh_invalid' };
    const conversation = explicit ? cleanConversationId(message.conversationId) : null;
    const owner = { epoch: connectionEpoch, instanceId, port, token };
    const admitted = explicit ? conversationAdmission(source, conversation) : () => ownsDocument(source);
    if (explicit && (!conversation || !Number.isSafeInteger(message.navigationEpoch) ||
        message.navigationEpoch !== source.navigationEpoch)) return { ok: false, error: 'fiber_refresh_invalid' };
    if (explicit && (!owner.token || !owner.port || !owner.instanceId || disconnected))
      return { ok: false, error: 'not_paired' };
    if (explicit && message.instanceId !== owner.instanceId) return { ok: false, error: 'account_changed' };
    // The ordinary null-reader repair retains its existing document-only contract.
    // An operator refresh additionally proves the original account and actual route
    // around every await; it reinjects a reader, never reloads or replaces its journals.
    const current = () => admitted() && owner.epoch === connectionEpoch &&
      owner.instanceId === instanceId && owner.port === port && owner.token === token && !disconnected;
    const inspectOwner = async () => {
      if (!ownsDocument(source)) return 'stale_document';
      if (!current()) return 'account_changed';
      if (cleanConversationId(tabConversations[String(source.tab)]) !== conversation) return 'conversation_changed';
      let tab;
      try { tab = await chrome.tabs.get(source.tab); } catch { return 'stale_document'; }
      if (!ownsDocument(source)) return 'stale_document';
      if (!current()) return 'account_changed';
      // MessageSender.url may still name this document's initial New Chat route
      // after an SPA transition; Chrome's current route is the authority here.
      return tab?.id === source.tab && !tab.pendingUrl && tab.status !== 'loading' &&
        conversationFromUrl(tab.url) === conversation ? null : 'conversation_changed';
    };
    try {
      const before = explicit ? await inspectOwner() : null;
      if (before) return { ok: false, error: before };
      await chrome.scripting.executeScript({
        target: { tabId: source.tab, documentIds: [source.documentId] },
        world: 'MAIN',
        files: ['fiber.js']
      });
      const after = explicit ? await inspectOwner() : !ownsDocument(source) ? 'stale_document' : null;
      return after ? { ok: false, error: after } : { ok: true, ...(explicit ? { refreshed: true } : {}) };
    } catch {
      return { ok: false, error: 'fiber_repair_failed' };
    }
  },
  async closed(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    // releaseTab drains the queue and posts /closed itself only when this document was the
    // last live view. This page signal is a conversation departure, not proof Chrome removed
    // the physical tab; chrome.tabs.onRemoved owns that distinct fact.
    return releaseTab(source.tab, message.conversationId, source.documentId, source.navigationEpoch, undefined, undefined, undefined, undefined, currentAdmission);
  },
  async compact(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await noteTabConversation(source, message.conversationId);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    // MessageSender.url can still name the document's initial New Chat address after
    // ChatGPT assigns /c/B through an SPA transition. Read Chrome's current tab and
    // retain the exact document/epoch lease across that await before accepting its route.
    const tab = await chrome.tabs.get(source.tab).catch(() => null);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (!currentAdmission() || !tab || !isChatGptUrl(tab.url))
      return { ok: false, error: 'stale_document' };
    const named = cleanConversationId(message.conversationId);
    // Destination permits precede the first Send and therefore have no chat route.
    // Loading that same leased document is normal; leaving it for another route is not.
    // Named source checkpoints still require a fully settled matching conversation.
    if (named
      ? (tab.pendingUrl || tab.status === 'loading' || conversationFromUrl(tab.url) !== named)
      : (conversationFromUrl(tab.url) !== null ||
          (tab.pendingUrl && tab.pendingUrl !== tab.url)))
      return { ok: false, error: 'stale_document' };
    const sourceUrl = tab.url;
    const result = await call('/compact', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: message.conversationId,
        ...(sourceUrl ? { project: projectFromUrl(sourceUrl) } : {}),
        resume: message.resume !== false,
        cancel: message.cancel === true,
        ticket: message.ticket === true,
        automatic: message.automatic === true,
        ...((message.destinationAttempt === true || message.destinationDispatch === true || message.destinationLost === true)
          ? { commandId: String(message.commandId || ''), client: String(message.client || '') } : {}),
        // The capture. `token` names the transaction the page was given when it marked the
        // compaction turn, and `summary` is that turn's own answer. Both are forwarded
        // verbatim and only together: the app refuses a brief whose token does not name an
        // open continuation for this chat, which is what keeps some other tab's text from
        // ever becoming this session's handoff.
        ...compactCheckpointFields(message)
      })
    }, false, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    // Chat B, for this window. The app produced it inside this very request precisely so that
    // the browser holding chat A is the browser that opens its successor — see
    // placeSuccessorChat for what the operating system does with the URL instead.
    if (currentAdmission() && result.ok && result.data && result.data.placement) {
      await placeSuccessorChat(result.data.placement, source.tab, currentAdmission);
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
    }
    return currentAdmission() ? result : { ok: false, error: 'stale_document' };
  },
  /**
   * The goal loop: this page saw its turn genuinely finish and wants the next user message.
   *
   * The API key never comes near this worker. The app is handed the conversation id and the
   * generation id and answers with a draft — which is also why `turnId` is forwarded
   * verbatim: it is the app's idempotency key, and a retried send must not become a second
   * message in somebody's chat.
   */
  async goal_draft(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, status: 400, error: 'bad_conversation_id' };
    await noteTabConversation(source, conversationId);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    // Goal builds its prompt from the app's durable session transcript. The final assistant
    // row that caused this request can still be only in this worker's storage.session journal
    // when an earlier /events call was delayed or failed. Spend no OpenRouter request until
    // that row has crossed the same /events boundary normal transcript delivery uses.
    if (!(await deliverConversationJournal(conversationId))) {
      return { ok: false, status: 503, error: 'transcript_not_delivered', retryable: true };
    }
    if (!currentAdmission()) return { ok: false, error: 'stale_document' };
    const result = await call('/goal/draft', {
      method: 'POST',
      body: JSON.stringify({
        conversationId,
        turnId: String(message.turnId || ''),
        clientId: String(source.tab),
        ...(message.nativeBusy === true ? { nativeBusy: true } : {}),
        ...(message.terminalRequired === true ? { terminalRequired: true } : {})
      })
    }, false, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    return currentAdmission() ? result : { ok: false, error: 'stale_document' };
  },
  /**
   * Selects the exact tab whose owned document is about to act on its own — a Goal draft, an
   * automatic Compact & Resume.
   *
   * The sender is the locator. Never search by conversation and never open a fallback: focus is
   * only presentation after the content script has independently decided to act. Reuse the exact
   * foreground-focus helper so selecting the chat also raises/restores its current Chrome window.
   * That keeps background visibility out of completion/draft/compaction authority and makes a
   * duplicate tab impossible on this path.
   */
  async focus_tab(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, status: 400, error: 'bad_conversation_id' };
    const key = String(source.tab);
    const registeredConversation = cleanConversationId(tabConversations[key]);
    if (registeredConversation && registeredConversation !== conversationId) {
      return { ok: false, error: 'stale_conversation' };
    }
    if (!registeredConversation) {
      await noteTabConversation(source, conversationId);
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
    }
    // A stale page may request presentation after Pause. Do not pull the user back
    // to work that the desktop will refuse to dispatch (or whose state is unknown).
    const status = await call('/status', { timeoutMs: 5_000 }, false, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (!status.ok || !status.data) return { ok: false, error: 'automation_state_unavailable' };
    if (status.data.automationPaused === true) return { ok: false, error: 'automation_paused' };
    try {
      await focusExactConversationTarget({ id: source.tab }, conversationId, currentAdmission);
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
    } catch {
      // Focus is a courtesy. The page owns Goal regardless, so browser/UI refusal must not turn
      // a valid hidden completion into a failed continuation.
      return currentAdmission() ? { ok: false, error: 'focus_failed' } : { ok: false, error: 'stale_document' };
    }
    return currentAdmission() ? { ok: true, focused: true } : { ok: false, error: 'stale_document' };
  },
  /** Typed, or given up on. Either way that draft is spent. */
  async goal_ack(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const result = await call('/goal/ack', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: message.conversationId,
        token: String(message.token || ''),
        ...(message.nativeBusy === true ? { nativeBusy: true } : {}),
        ...(message.confirmedUnsent === true ? { confirmedUnsent: true } : {}),
        ...(typeof message.turnId === 'string' && message.turnId
          ? { turnId: message.turnId.slice(0, 200) }
          : {}),
        ...(typeof message.messageId === 'string' && message.messageId
          ? { messageId: message.messageId.slice(0, 200) }
          : {}),
        ...(typeof message.messageId === 'string' && message.messageId &&
          typeof message.sendModel === 'string' && /^[a-zA-Z0-9 ._-]{1,80}$/.test(message.sendModel) &&
          ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro'].includes(message.sendReasoningEffort)
          ? { sendModel: message.sendModel, sendReasoningEffort: message.sendReasoningEffort } : {}),
        clientId: String(source.tab)
      })
    }, false, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    return currentAdmission() ? result : { ok: false, error: 'stale_document' };
  },
  /**
   * This chat's specific goal, set or cleared from the settings sheet.
   *
   * The text is the user's own and goes straight through; the app trims it and answers with
   * what it actually stored, which is what the sheet then draws.
   *
   * `mode` is the button the goal was written under — "add specific goal" or "add specific
   * loop" — and the app pins it as this chat's own switch in the same write. Only those two
   * words cross; anything else is dropped rather than passed on, so a malformed sheet cannot
   * put a third mode into a durable file.
   */
  async goal_objective(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, status: 400, error: 'bad_conversation_id' };
    await noteTabConversation(source, conversationId);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const result = await call('/goal/objective', {
      method: 'POST',
      body: JSON.stringify({ conversationId, text: String(message.text || ''), ...goalMode(message) })
    }, false, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    return currentAdmission() ? result : { ok: false, error: 'stale_document' };
  },
  /**
   * The opening message for a chat ChatGPT has not named yet.
   *
   * No conversation id, because there is none to send: this is the request whose answer
   * becomes the message that causes ChatGPT to issue one. Everything else about it is an
   * ordinary goal draft, and the key stays in the app exactly as it does for those.
   */
  async goal_open(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, null);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const result = await call('/goal/open', {
      method: 'POST',
      timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      body: JSON.stringify({ text: String(message.text || ''), ...goalMode(message) })
    }, false, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    return currentAdmission() ? result : { ok: false, error: 'stale_document' };
  },
  /**
   * The same two settings, for a chat that has no feed to read them from.
   *
   * `/activity` carries them otherwise, and it needs a conversation id. A New Chat has none
   * and is still somewhere a goal can be written, so the sheet above that composer asks for
   * them directly. Read-only, and conversation-free by construction.
   */
  async settings_get(_message, _sender, source) {
    const currentAdmission = conversationAdmission(source, null);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const result = await call('/settings', { method: 'GET' }, false, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    return currentAdmission() ? result : { ok: false, error: 'stale_document' };
  },
  /** The composer's settings menu, which owns exactly two switches. */
  async settings_set(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(tabConversations[String(source.tab)]) ?? cleanConversationId(message.conversationId));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const requestedConversation = cleanConversationId(message.conversationId);
    const key = String(source.tab);
    const registeredConversation = cleanConversationId(tabConversations[key]);
    if (requestedConversation && registeredConversation && requestedConversation !== registeredConversation) {
      return { ok: false, error: 'stale_conversation' };
    }
    if (requestedConversation && !registeredConversation) {
      await noteTabConversation(source, requestedConversation);
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
    }
    // A named chat's auto-compaction switch is not anonymous global authority. Pass the
    // document's proven conversation to the app so worker-role policy is enforced there even
    // if stale UI state somehow reaches this handler.
    const conversationId = cleanConversationId(tabConversations[key]) ?? requestedConversation;
    const body = {};
    if (typeof message.autoCompact === 'boolean') body.autoCompact = message.autoCompact;
    if (typeof message.loopAfterTurn === 'boolean') body.loopAfterTurn = message.loopAfterTurn;
    // Goal and Loop are one setting behind two switches, and the app refuses a body carrying
    // both. Pass through whichever one the sheet actually moved.
    if (typeof message.goal === 'boolean') body.goal = message.goal;
    else if (typeof message.loop === 'boolean') body.loop = message.loop;
    // The conversation, whichever switch moved. Auto-compaction needs it so worker-role policy
    // is enforced in the app; Goal and Loop need it because they are now that chat's own setting,
    // and a sheet drawn beside one conversation is answering about that conversation. A New Chat
    // has none, and moves the app-wide default it would have inherited.
    if (conversationId) body.conversationId = conversationId;
    const result = await call('/settings', { method: 'POST', body: JSON.stringify(body) }, false, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    return currentAdmission() ? result : { ok: false, error: 'stale_document' };
  },
  async stop_redeem(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const tab = await chrome.tabs.get(source.tab);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (!currentAdmission() || conversationFromUrl(tab.url) !== message.conversationId) return { ok: false, error: 'wrong_conversation' };
    const result = await redeemCommand(String(message.id || ''), String(message.client || ''), message.conversationId, undefined, undefined, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    return currentAdmission() ? result : { ok: false, error: 'stale_document' };
  },
  async stop_ack(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const tab = await chrome.tabs.get(source.tab);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (!currentAdmission() || conversationFromUrl(tab.url) !== message.conversationId ||
        typeof message.turnId !== 'string' || !message.turnId || message.turnId.length > 256) return { ok: false, error: 'wrong_turn' };
    return ackCommand(String(message.id || ''), message.status === 'sent' ? 'sent' : 'failed', message.error,
      message.conversationId, null, message.client, source, message.turnId, currentAdmission);
  },
  /** The marked page asking for the one command it was opened for. */
  async redeem(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const id = String(message.id || '');
    const tabLease = await commandTabLeaseFor(source, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (!tabLease) return { ok: false, error: 'stale_document' };
    const result = await redeemCommand(
      id,
      String(message.client || ''),
      typeof message.conversationId === 'string' ? message.conversationId : null,
      message.projectEntry === true,
      tabLease,
      currentAdmission
    );
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (result.gone === true && source && currentAdmission()) {
      staleCommandDocuments.set(source.tab, {
        id,
        documentId: source.documentId,
        navigationEpoch: source.navigationEpoch,
        at: Date.now()
      });
    } else if (source) {
      staleCommandDocuments.delete(source.tab);
    }
    return result;
  },
  async retire_stale_command(message, _sender, source) {
    return { ok: true, closed: await retireStaleCommandTab(String(message.id || ''), source) };
  },
  /**
   * A revival page has positively identified the exact target chat but it is not submit-ready
   * yet. Persist only its inert correlation marker so a service-worker/browser restart can put
   * the same durable app command back in front of that conversation. No command text is copied.
   */
  async defer_revival(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    await load();
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const conversationId = cleanConversationId(message.conversationId);
    if (!conversationId) return { ok: false, error: 'bad_conversation_id' };
    await noteTabConversation(source, conversationId);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const id = deferredRevivalId(message.id);
    if (!id) return { ok: false, error: 'bad_command_id' };
    if (message.supersedes !== undefined) {
      // Retire only an inert page waiter, never a Main command. Distinct marker ids
      // are not authority: Main must prove the old wake absent and the replacement
      // still unclaimed for this exact conversation in the same bounded census.
      const previous = deferredRevivalId(message.supersedes);
      if (!previous || previous === id) return { ok: false, error: 'bad_command_id' };
      const checked = await call('/commands/revivals/pending', { method: 'POST',
        body: JSON.stringify({ entries: [{ id: previous, conversationId }, { id, conversationId }], readiness: true }) },
        false, currentAdmission);
      if (!currentAdmission()) return conversationAdmissionRefusal(source);
      const pending = checked.ok && Array.isArray(checked.data?.pending) ? checked.data.pending : null;
      const current = checked.ok && Array.isArray(checked.data?.readiness)
        ? checked.data.readiness.find(row => row?.id === id) : null;
      if (!pending || pending.includes(previous) || !pending.includes(id) ||
          !Number.isSafeInteger(current?.createdAt) || current.createdAt <= 0)
        return { ok: false, error: 'revival_supersession_unconfirmed' };
      return { ok: true, supersede: true };
    }
    const senderTabId = Number.isInteger(source?.tab) ? source.tab : null;
    const remembered = await rememberDeferredRevival(id, conversationId, true, currentAdmission);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    if (remembered && senderTabId !== null) deferredRevivalOffers.set(id, senderTabId);
    if (remembered && message.readiness === true) {
      // Advisory only: do not delay custody, redeem or Send for a diagnostics probe.
      void recordRevivalReadiness(id, conversationId, source).catch(() => undefined);
    }
    return remembered ? { ok: true, deferred: true } : { ok: false, error: 'bad_command_id' };
  },
  async forget_revival(message, _sender, source) {
    await load();
    if (!ownsDocument(source)) return { ok: false, error: 'stale_document' };
    await forgetDeferredRevival(message.id);
    return { ok: true };
  },
  async ack(message, _sender, source) {
    const currentAdmission = conversationAdmission(source, cleanConversationId(message.conversationId) ?? cleanConversationId(tabConversations[String(source.tab)]));
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    const result = await ackCommand(
      String(message.id || ''),
      message.status === 'attention' ? 'attention' : message.status === 'deferred' ? 'deferred' : message.status === 'failed' ? 'failed' : 'sent',
      message.error,
      message.conversationId,
      message.agent,
      message.client,
      source,
      undefined,
      currentAdmission
    );
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    // ackCommand first made this exact page result durable in the browser-owned outbox.
    // From that point recovery must never reopen the pre-send marker, even if the bridge HTTP
    // response itself was lost; the outbox is now the sole retry path.
    await forgetDeferredRevival(message.id);
    if (!currentAdmission()) return conversationAdmissionRefusal(source);
    return result;
  }
};

function companionPopup(sender) {
  try {
    const url = new URL(sender?.url || '');
    return url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && url.pathname === '/popup.html';
  } catch { return false; }
}

/** Only our popup or a current, top-level isolated ChatGPT settings document may choose. */
function pairingUiOwner(sender, source) {
  return companionPopup(sender) || (sender?.frameId === 0 && isChatGptUrl(sender?.url) && ownsDocument(source));
}

/** Proof applies only to the current explicit account choice, never a saved enrollment flag. */
const FIRST_ENROLLMENT_CLOSE_SOURCE_VERSION = 1;

function firstEnrollmentCloseSource(value, expectedBrowserId = browserId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['version', 'browserId', 'tab', 'documentId', 'navigationEpoch'].every(key =>
        Object.prototype.hasOwnProperty.call(value, key)) || Object.keys(value).length !== 5 ||
      value.version !== FIRST_ENROLLMENT_CLOSE_SOURCE_VERSION ||
      typeof value.browserId !== 'string' || !/^[a-z0-9]{16,64}$/.test(value.browserId) ||
      expectedBrowserId && value.browserId !== expectedBrowserId ||
      !Number.isSafeInteger(value.tab) || value.tab < 0 ||
      typeof value.documentId !== 'string' || value.documentId.length < 1 || value.documentId.length > 200 ||
      !Number.isSafeInteger(value.navigationEpoch) || value.navigationEpoch < 0) return null;
  return {
    version: FIRST_ENROLLMENT_CLOSE_SOURCE_VERSION,
    browserId: value.browserId,
    tab: value.tab,
    documentId: value.documentId,
    navigationEpoch: value.navigationEpoch
  };
}

function firstEnrollmentCloseRows(value, expectedBrowserId = browserId, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 200) return null;
  const rows = [];
  const conversations = new Set();
  const tabs = new Set();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        !['conversationId', 'queuedAt', 'firstEnrollmentSource'].every(key =>
          Object.prototype.hasOwnProperty.call(row, key)) || Object.keys(row).length !== 3 ||
        cleanConversationId(row.conversationId) !== row.conversationId ||
        !Number.isFinite(row.queuedAt) || row.queuedAt <= 0) return null;
    const source = firstEnrollmentCloseSource(row.firstEnrollmentSource, expectedBrowserId);
    if (!source || conversations.has(row.conversationId) || tabs.has(source.tab)) return null;
    conversations.add(row.conversationId);
    tabs.add(source.tab);
    rows.push({ conversationId: row.conversationId, queuedAt: row.queuedAt, firstEnrollmentSource: source });
  }
  return rows;
}

function sameFirstEnrollmentCloseRows(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactFirstEnrollmentTerminalState(live, rows) {
  const terminal = live?.terminalDocuments;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal) ||
      Object.keys(terminal).length !== rows.length) return false;
  const documents = live?.tabDocuments;
  const epochs = live?.tabEpochs;
  const conversations = live?.tabConversations;
  if (!documents || typeof documents !== 'object' || Array.isArray(documents) ||
      !epochs || typeof epochs !== 'object' || Array.isArray(epochs) ||
      conversations && (typeof conversations !== 'object' || Array.isArray(conversations))) return false;
  return rows.every(row => {
    const source = row.firstEnrollmentSource;
    const key = String(source.tab);
    return terminal[key] === source.documentId && documents[key] === source.documentId &&
      epochs[key] === source.navigationEpoch && !cleanConversationId(conversations?.[key]);
  });
}

function onlyNeverBoundObservationRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const rowKeys = new Set(['conversationId', 'provisional', 'agent', 'agentCommandId', 'project', 'event', 'gap']);
  const observedKinds = new Set(['user_message', 'assistant_message', 'progress', 'conversation_title',
    'model_selection', 'app_sightings', 'chat_error', 'turn_start', 'turn_end', 'page_tool', 'tool_evidence']);
  const strings = new Set(['text', 'messageId', 'providerMessageId', 'turnId', 'renderedHtml', 'fiberConversationId',
    'inputSourceUserMessageId', 'model', 'reasoningEffort', 'textOrigin', 'state', 'outcome', 'reason', 'detail']);
  const flags = new Set(['authoredTime', 'authoredNow', 'activeNow', 'final', 'goalEligible', 'recoverable', 'retryAvailable', 'blocking']);
  const eventKeys = new Set(['kind', 'time', 'reaction', 'calls', 'apps', 'attachments', ...strings, ...flags]);
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  const optional = (value, test) => value == null || test(value);
  const shapedArray = (value, fields) => Array.isArray(value) && value.every(item => plain(item) &&
    Object.keys(item).every(key => Object.prototype.hasOwnProperty.call(fields, key) && optional(item[key], fields[key])));
  const string = value => typeof value === 'string';
  const number = value => typeof value === 'number' && Number.isFinite(value);
  const boolean = value => typeof value === 'boolean';
  const observedEvent = event => plain(event) && observedKinds.has(event.kind) &&
    Object.keys(event).every(key => eventKeys.has(key)) &&
    (!Object.prototype.hasOwnProperty.call(event, 'time') || number(event.time) && event.time > 0) &&
    [...strings].every(key => optional(event[key], string)) && [...flags].every(key => optional(event[key], boolean)) &&
    optional(event.reaction, string) &&
    (event.calls === undefined || shapedArray(event.calls, {
      messageId: string, tool: string, requestId: string, order: number, answered: boolean, createTime: number
    })) &&
    (event.apps === undefined || shapedArray(event.apps, {
      requestId: string, appId: string, appName: string, linkId: string
    })) &&
    (event.attachments === undefined || shapedArray(event.attachments, {
      id: string, name: string, mimeType: string, size: number
    }));
  return rows.every(row => row && typeof row === 'object' && !Array.isArray(row) &&
    Object.keys(row).every(key => rowKeys.has(key)) && row.agent == null && row.agentCommandId == null &&
    (row.conversationId == null || cleanConversationId(row.conversationId) === row.conversationId) &&
    (row.provisional == null || typeof row.provisional === 'string' && row.provisional.length > 0 && row.provisional.length <= 200) &&
    (row.conversationId != null || row.provisional != null) &&
    (row.project == null || typeof row.project === 'string' && /^g-p-[0-9a-f]{32}$/.test(row.project)) &&
    (row.gap === undefined || typeof row.gap === 'boolean') && observedEvent(row.event));
}

function neverBoundAccountStorage(value, connection) {
  const plain = item => !!item && typeof item === 'object' && !Array.isArray(item);
  const owns = key => Object.prototype.hasOwnProperty.call(value, key);
  if (!plain(value) || connection && ['instanceId', 'port', 'token', 'disconnected'].some(owns)) return false;
  const arrays = ['deferredRevivals', 'closeOutbox', 'commandAckOutbox', 'settled'];
  const maps = ['inputOpenings', 'desktopInputTabs', 'stopOpenings', 'commandTabLeases', 'pendingInputReceipts',
    'appOwnedOpeningTabs', 'automaticTabRetirements', 'discardProtectedTabs', 'protectedMainTabs', 'cosGroupedTabs',
    'terminalDocuments', 'retiredDocuments'];
  if (!arrays.every(key => !owns(key) || Array.isArray(value[key]) && value[key].length === 0) ||
      !maps.every(key => !owns(key) || plain(value[key]) && Object.keys(value[key]).length === 0) ||
      owns('recoveryMonitoring') && value.recoveryMonitoring !== false) return false;
  return !owns('delivery') || plain(value.delivery) && value.delivery.at === 0 && value.delivery.total === 0 &&
    value.delivery.ok === null && value.delivery.conversationId === null && value.delivery.status === 0 && value.delivery.error === null;
}

function prospectiveFirstEnrollmentCloseStorage(stored, live, expectedRows = null) {
  const storedRows = firstEnrollmentCloseRows(stored?.closeOutbox, browserId);
  const liveRows = firstEnrollmentCloseRows(live?.closeOutbox, browserId);
  if (!storedRows || !liveRows || !sameFirstEnrollmentCloseRows(storedRows, liveRows) ||
      expectedRows && !sameFirstEnrollmentCloseRows(storedRows, expectedRows) ||
      live?.recoveryMonitoring !== true || !exactFirstEnrollmentTerminalState(live, storedRows) ||
      ['projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner'].some(key => live?.[key] != null) ||
      !onlyNeverBoundObservationRows(live?.journal)) return false;
  return neverBoundAccountStorage({ ...stored, closeOutbox: [] }, true) &&
    neverBoundAccountStorage({ ...live, closeOutbox: [], terminalDocuments: {}, recoveryMonitoring: false }, false);
}

function operatorAdoptionJournalRows(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4000) return null;
  const stripped = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.enrollmentHeld !== true ||
        !Object.keys(row).every(key => key === 'enrollmentHeld' ||
          ['conversationId', 'provisional', 'agent', 'agentCommandId', 'project', 'event', 'gap'].includes(key)) ||
        row.provisional != null || row.project != null) return null;
    const { enrollmentHeld: _held, ...observation } = row;
    stripped.push(observation);
  }
  return onlyNeverBoundObservationRows(stripped) ? value : null;
}

function operatorAdoptionCloseRows(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return null;
  const conversations = new Set();
  const rows = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).length !== 2 || !Object.prototype.hasOwnProperty.call(row, 'conversationId') ||
        !Object.prototype.hasOwnProperty.call(row, 'queuedAt') ||
        cleanConversationId(row.conversationId) !== row.conversationId ||
        !Number.isFinite(row.queuedAt) || row.queuedAt <= 0 || conversations.has(row.conversationId)) return null;
    conversations.add(row.conversationId);
    rows.push({ conversationId: row.conversationId, queuedAt: row.queuedAt });
  }
  return rows;
}

function operatorAdoptionTerminalState(live, closes, diagnostic = null) {
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  const terminal = live?.terminalDocuments;
  const documents = live?.tabDocuments;
  const epochs = live?.tabEpochs;
  const conversations = live?.tabConversations;
  const retired = live?.retiredDocuments;
  const refuse = reason => {
    // Per-selection negative evidence only: never persist it or use it as adoption authority.
    try {
      if (diagnostic && Object.getOwnPropertyDescriptor(diagnostic, 'refusal')?.value === null &&
          !Object.prototype.hasOwnProperty.call(diagnostic, 'terminalReason')) {
        const count = (value, optional = false) => value === undefined && optional ? 0 :
          plain(value) ? Math.min(4000, Object.keys(value).length) : null;
        diagnostic.terminalReason = reason;
        diagnostic.terminalCounts = { terminalEntries: count(terminal), closeReceipts: Math.min(4000, closes.length),
          documentEntries: count(documents), epochEntries: count(epochs),
          conversationEntries: count(conversations, true), retiredEntries: count(retired, true) };
      }
    } catch { /* A diagnostic failure cannot change the custody predicate. */ }
    return false;
  };
  if (live?.recoveryMonitoring !== true) return refuse(
    live?.recoveryMonitoring === false ? 'monitoring_off' : 'monitoring_unproven');
  if (!plain(terminal)) return refuse('terminal_map_invalid');
  if (Object.keys(terminal).length !== closes.length) return refuse('terminal_count_mismatch');
  if (!plain(documents)) return refuse('document_map_invalid');
  if (!plain(epochs)) return refuse('epoch_map_invalid');
  if (conversations !== undefined && !plain(conversations)) return refuse('conversation_map_invalid');
  if (retired !== undefined && !plain(retired)) return refuse('retired_map_invalid');
  if (retired !== undefined && Object.keys(retired).length > 0) return refuse('retired_ownership');
  for (const key of Object.keys(documents)) {
    if (!/^\d+$/.test(key) || typeof documents[key] !== 'string' ||
        documents[key].length === 0 || documents[key].length > 200) return refuse('document_invalid');
    if (!Number.isSafeInteger(epochs[key]) || epochs[key] < 0) return refuse(
      Object.prototype.hasOwnProperty.call(epochs, key) ? 'epoch_invalid' : 'epoch_map_mismatch');
    if (Object.prototype.hasOwnProperty.call(conversations || {}, key)) return refuse('registered_conversation_entry');
  }
  if (!Object.keys(epochs).every(key => Object.prototype.hasOwnProperty.call(documents, key)))
    return refuse('epoch_map_mismatch');
  if (!Object.entries(terminal).every(([key, documentId]) =>
    /^\d+$/.test(key) && documents[key] === documentId && typeof documentId === 'string' &&
    documentId.length > 0 && documentId.length <= 200)) return refuse('terminal_document_mismatch');
  return true;
}

function operatorAdoptionState(stored, live, targetInstanceId, stagedSelection = null, diagnostic = null) {
  const refuse = reason => {
    if (diagnostic && diagnostic.refusal === null) diagnostic.refusal = reason;
    return null;
  };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) ||
      !live || typeof live !== 'object' || Array.isArray(live) ||
      typeof stored.browserId !== 'string' || !/^[a-z0-9]{16,64}$/.test(stored.browserId) ||
      !INSTANCE_ID_PATTERN.test(targetInstanceId || '')) return refuse('invalid_snapshot');
  const connectionKeys = ['instanceId', 'port', 'token', 'disconnected'];
  const local = { ...stored };
  if (stagedSelection) {
    if (!connectionKeys.every(key => Object.prototype.hasOwnProperty.call(local, key) &&
        local[key] === stagedSelection[key])) return refuse('prior_binding');
    for (const key of connectionKeys) delete local[key];
  } else if (connectionKeys.some(key => Object.prototype.hasOwnProperty.call(local, key))) return refuse('prior_binding');
  if (Array.isArray(live.journal) && live.journal.some(row => row?.enrollmentCustodyUncertain === true)) {
    const closes = operatorAdoptionCloseRows(local.closeOutbox);
    if (closes && live.retiredDocuments !== undefined &&
        (!live.retiredDocuments || typeof live.retiredDocuments !== 'object' || Array.isArray(live.retiredDocuments) ||
          Object.keys(live.retiredDocuments).length)) {
      operatorAdoptionTerminalState(live, closes, diagnostic);
      return refuse('terminal_mismatch');
    }
    return refuse('active_custody');
  }
  const storedCloses = operatorAdoptionCloseRows(local.closeOutbox);
  const liveCloses = operatorAdoptionCloseRows(live.closeOutbox);
  const observations = operatorAdoptionJournalRows(live.journal);
  if (!storedCloses || !liveCloses) return refuse('close_shape');
  if (!observations) return refuse('observation_shape');
  if (JSON.stringify(storedCloses) !== JSON.stringify(liveCloses)) return refuse('receipt_mismatch');
  if (!operatorAdoptionTerminalState(live, storedCloses, diagnostic))
    return refuse('terminal_mismatch');
  if (['projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner'].some(key =>
      Object.prototype.hasOwnProperty.call(live, key) && live[key] != null)) return refuse('active_custody');
  const closeConversations = new Set(storedCloses.map(row => row.conversationId));
  const observationConversations = new Set(observations.map(row => row.conversationId));
  if (closeConversations.size !== observationConversations.size ||
      [...closeConversations].some(id => !observationConversations.has(id))) return refuse('conversation_mismatch');
  if (!neverBoundAccountStorage({ ...local, closeOutbox: [] }, true) ||
      !neverBoundAccountStorage({ ...live, closeOutbox: [], terminalDocuments: {}, recoveryMonitoring: false }, false)) return refuse('active_custody');
  return {
    version: 1,
    targetInstanceId,
    browserId: stored.browserId,
    journal: observations,
    closeOutbox: storedCloses,
    terminalDocuments: live.terminalDocuments,
    tabDocuments: live.tabDocuments,
    tabEpochs: live.tabEpochs,
    tabConversations: live.tabConversations || {},
    recoveryMonitoring: true
  };
}

function stableOperatorAdoptionJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableOperatorAdoptionJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stableOperatorAdoptionJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function operatorAdoptionSnapshot(targetInstanceId, stagedSelection = null, diagnostic = null) {
  const refuse = reason => {
    if (diagnostic && diagnostic.refusal === null) diagnostic.refusal = reason;
    return null;
  };
  if (instanceId !== null || port !== null || token !== null || disconnected ||
      (pairing && pairingEpoch === connectionEpoch) || journalWorkers.size ||
      maintenanceFlight || modelCatalogFlight || pluginRefreshFlight || projectCreateFlight || deferredRecoveryWork)
    return refuse(instanceId !== null || port !== null || token !== null || disconnected ? 'prior_binding' : 'active_custody');
  try {
    const epoch = connectionEpoch;
    const connectionKeys = ['instanceId', 'port', 'token', 'disconnected', 'browserId'];
    const arrays = ['deferredRevivals', 'closeOutbox', 'commandAckOutbox', 'settled'];
    const maps = ['inputOpenings', 'desktopInputTabs', 'stopOpenings', 'commandTabLeases', 'pendingInputReceipts',
      'appOwnedOpeningTabs', 'automaticTabRetirements', 'discardProtectedTabs', 'protectedMainTabs', 'cosGroupedTabs',
      'terminalDocuments', 'retiredDocuments'];
    const read = async () => {
      let timer;
      try {
        return await Promise.race([
          Promise.all([
            chrome.storage.local.get([...connectionKeys, ...arrays, ...maps]),
            chrome.storage.session.get([...arrays, ...maps, 'journal', 'tabConversations', 'tabDocuments', 'tabEpochs',
              'retiredDocuments', 'recoveryMonitoring', 'delivery', 'projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner'])
          ]),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS); })
        ]);
      } catch (error) {
        refuse('snapshot_read_failed');
        throw error;
      } finally { clearTimeout(timer); }
    };
    const snapshot = await read();
    if (!snapshot) return refuse('timeout');
    if (instanceId !== null || port !== null || token !== null || disconnected ||
        (pairing && pairingEpoch === connectionEpoch) || journalWorkers.size || epoch !== connectionEpoch)
      return refuse('snapshot_changed');
    const [stored, live] = snapshot;
    const state = operatorAdoptionState(stored, live, targetInstanceId, stagedSelection, diagnostic);
    if (!state) return null;
    if (JSON.stringify(live.journal) !== JSON.stringify(journal) ||
        JSON.stringify(stored.closeOutbox) !== JSON.stringify(closeOutbox)) return refuse('snapshot_changed');
    const canonical = stableOperatorAdoptionJson(state);
    const bytes = new TextEncoder().encode(canonical);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    // Hashing yields. Re-read both durable stores afterwards so a late receipt, owner or
    // selection cannot be hidden behind a digest of the earlier snapshot.
    const latest = await read();
    if (!latest) return refuse('timeout');
    if (epoch !== connectionEpoch || instanceId !== null || port !== null || token !== null || disconnected ||
        (pairing && pairingEpoch === connectionEpoch) || journalWorkers.size) return refuse('snapshot_changed');
    const latestState = operatorAdoptionState(latest[0], latest[1], targetInstanceId, stagedSelection, diagnostic);
    if (!latestState) return null;
    if (stableOperatorAdoptionJson(latestState) !== canonical ||
        JSON.stringify(latest[1].journal) !== JSON.stringify(journal) ||
        JSON.stringify(latest[0].closeOutbox) !== JSON.stringify(closeOutbox)) return refuse('snapshot_changed');
    return {
      version: 1,
      targetInstanceId,
      snapshotDigest: digest,
      journalCount: state.journal.length,
      ordinaryCloseCount: state.closeOutbox.length
    };
  } catch { return refuse('invalid_snapshot'); }
}

/** Copy only bounded ordinary data, without invoking an accessor or losing unknown fields. */
function cloneUnassignedHistoryData(value) {
  let nodes = 0;
  const ancestors = new Set();
  const copy = (item, depth) => {
    if (++nodes > 60000 || depth > 24) throw new Error('history data exceeds bounds');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new Error('history data is not ordinary data');
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== null &&
        (Object.getPrototypeOf(proto) !== null || Object.getOwnPropertyDescriptor(proto, 'constructor')?.value?.name !== 'Object'))
      throw new Error('history data has an unsupported prototype');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length) throw new Error('history data has symbol fields');
    const result = Array.isArray(item) ? [] : {};
    ancestors.add(item);
    for (const key of Object.keys(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = descriptors[key];
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable ||
          Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error('history field is not ordinary data');
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(item);
    if (Array.isArray(item) && Object.keys(result).length !== item.length) throw new Error('history array has missing entries');
    return result;
  };
  const result = copy(value, 0);
  if (new TextEncoder().encode(stableOperatorAdoptionJson(result)).length > 4_000_000)
    throw new Error('history archive exceeds bounds');
  return result;
}

async function unassignedHistoryDigest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(stableOperatorAdoptionJson(value))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function validUnassignedHistoryArchive(value) {
  return value && Object.keys(value).sort().join(',') === 'browserId,history,phase,sealedAt,snapshotDigest,targetInstanceId,version' &&
    value.version === 1 && INSTANCE_ID_PATTERN.test(value.targetInstanceId || '') &&
    /^[a-z0-9]{16,64}$/.test(value.browserId || '') && /^[a-f0-9]{64}$/.test(value.snapshotDigest || '') &&
    Number.isFinite(value.sealedAt) && value.sealedAt > 0 && ['sealed', 'committed'].includes(value.phase) &&
    Array.isArray(value.history?.journal) && value.history.journal.length <= 4000 &&
    Array.isArray(value.history.localCloseOutbox) && value.history.localCloseOutbox.length >= 1 && value.history.localCloseOutbox.length <= 200 &&
    value.history.journal.length + value.history.localCloseOutbox.length > 0;
}

const UNASSIGNED_HISTORY_ARRAYS = ['deferredRevivals', 'commandAckOutbox', 'settled'];
const UNASSIGNED_HISTORY_MAPS = ['inputOpenings', 'desktopInputTabs', 'stopOpenings', 'commandTabLeases', 'pendingInputReceipts',
  'appOwnedOpeningTabs', 'automaticTabRetirements', 'discardProtectedTabs', 'protectedMainTabs', 'cosGroupedTabs', 'retiredDocuments', 'idleRootTabs'];
const UNASSIGNED_HISTORY_FIELDS = ['journal', 'closeOutbox', 'tabDocuments', 'tabEpochs', 'tabConversations', 'terminalDocuments', 'recoveryMonitoring'];

function unassignedNonHistoryCustody(value) {
  const plain = item => item && typeof item === 'object' && !Array.isArray(item);
  return UNASSIGNED_HISTORY_ARRAYS.some(key => value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 0)) ||
    UNASSIGNED_HISTORY_MAPS.some(key => value[key] !== undefined && (!plain(value[key]) || Object.keys(value[key]).length > 0)) ||
    ['projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner'].some(key => value[key] != null) ||
    value.delivery !== undefined && !neverBoundAccountStorage({ delivery: value.delivery }, false);
}

async function readUnassignedHistoryStores() {
  let timer;
  try {
    return await Promise.race([Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS); })]);
  } finally { clearTimeout(timer); }
}

function unassignedHistoryState(stored, live, targetInstanceId, diagnostic = null) {
  const localKeys = ['browserId', 'commandLeaseGeneration', 'renderStreamEnabled', 'showStreamTimes',
    ...UNASSIGNED_HISTORY_ARRAYS, ...UNASSIGNED_HISTORY_MAPS, 'closeOutbox'];
  // The popup writes only a compatible instance id as its draft preference. Recognizing that
  // bounded data cannot select a target, adopt history, or grant pairing/Send authority.
  const accountChoice = stored && Object.getOwnPropertyDescriptor(stored, 'popupAccountChoiceInstanceId');
  const debugPreference = stored && Object.getOwnPropertyDescriptor(stored, 'browserDebugScreenshots');
  if (debugPreference && Object.prototype.hasOwnProperty.call(debugPreference, 'value') && typeof debugPreference.value === 'boolean')
    localKeys.push('browserDebugScreenshots');
  if (accountChoice?.enumerable && Object.prototype.hasOwnProperty.call(accountChoice, 'value') &&
      typeof accountChoice.value === 'string' && INSTANCE_ID_PATTERN.test(accountChoice.value))
    localKeys.push('popupAccountChoiceInstanceId');
  const liveKeys = [...UNASSIGNED_HISTORY_ARRAYS, ...UNASSIGNED_HISTORY_MAPS, ...UNASSIGNED_HISTORY_FIELDS,
    'delivery', 'projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner'];
  // Browser-control ready() saves this fresh, unpolled record even before any account binds.
  // Only that exact empty shape is auxiliary data; prior epochs, receipts and leases stay held.
  const control = live && Object.getOwnPropertyDescriptor(live, 'cosBrowserControl');
  const controlFields = control?.enumerable && Object.prototype.hasOwnProperty.call(control, 'value') &&
    control.value && typeof control.value === 'object' && !Array.isArray(control.value)
    ? Object.getOwnPropertyDescriptors(control.value) : null;
  if (controlFields && Reflect.ownKeys(controlFields).length === 4 &&
      ['browserId', 'epoch', 'receipt', 'tabs'].every(key => controlFields[key]?.enumerable &&
        Object.prototype.hasOwnProperty.call(controlFields[key], 'value')) &&
      typeof controlFields.browserId.value === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(controlFields.browserId.value) &&
      controlFields.epoch.value === null && controlFields.receipt.value === null &&
      Array.isArray(controlFields.tabs.value) && controlFields.tabs.value.length === 0)
    liveKeys.push('cosBrowserControl');
  const refuse = reason => {
    // Fixed categories/counts only. This per-call explanation never becomes history authority.
    try {
      if (diagnostic && Object.getOwnPropertyDescriptor(diagnostic, 'preservationRefusal')?.value === null) {
        const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : null;
        const count = (value, array = false) => value === undefined ? 0 : array
          ? Array.isArray(value) ? Math.min(4000, value.length) : null
          : keys(value) ? Math.min(4000, keys(value).length) : null;
        const localFields = keys(stored), sessionFields = keys(live);
        diagnostic.preservationRefusal = reason;
        diagnostic.preservationCounts = {
          localFields: localFields ? Math.min(4000, localFields.length) : null,
          sessionFields: sessionFields ? Math.min(4000, sessionFields.length) : null,
          unsupportedLocalFields: localFields ? Math.min(4000, localFields.filter(key => !localKeys.includes(key)).length) : null,
          unsupportedSessionFields: sessionFields ? Math.min(4000, sessionFields.filter(key => !liveKeys.includes(key)).length) : null,
          journalEntries: count(live?.journal, true), closeReceipts: count(live?.closeOutbox, true),
          documentEntries: count(live?.tabDocuments), epochEntries: count(live?.tabEpochs),
          conversationEntries: count(live?.tabConversations), terminalEntries: count(live?.terminalDocuments)
        };
      }
    } catch { /* Diagnostic failure cannot change preservation eligibility. */ }
    return null;
  };
  if (!stored || !live) return refuse('invalid_snapshot');
  if (Object.keys(stored).some(key => !localKeys.includes(key))) return refuse('local_fields_unsupported');
  if (Object.keys(live).some(key => !liveKeys.includes(key))) return refuse('session_fields_unsupported');
  if (stored.browserId !== browserId) return refuse('browser_mismatch');
  if (!INSTANCE_ID_PATTERN.test(targetInstanceId || '')) return refuse('target_invalid');
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  const empty = value => value === undefined || plain(value) && Object.keys(value).length === 0;
  if ([stored, live].some(store => UNASSIGNED_HISTORY_ARRAYS.some(key => store[key] !== undefined &&
      (!Array.isArray(store[key]) || store[key].length)) || UNASSIGNED_HISTORY_MAPS.some(key => !empty(store[key]))) ||
      ['projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner'].some(key => live[key] != null) ||
      live.delivery !== undefined && !neverBoundAccountStorage({ delivery: live.delivery }, false)) return refuse('active_custody');
  if (live.recoveryMonitoring !== undefined && typeof live.recoveryMonitoring !== 'boolean') return refuse('monitoring_shape');
  const maps = ['tabDocuments', 'tabEpochs', 'tabConversations', 'terminalDocuments'];
  if (maps.some(key => live[key] !== undefined && (!plain(live[key]) || Object.entries(live[key]).some(([tab, value]) =>
      !/^\d+$/.test(tab) || (key === 'tabEpochs' ? !Number.isSafeInteger(value) || value < 0 :
        typeof value !== 'string' || !value.length || value.length > 200 ||
        key === 'tabConversations' && cleanConversationId(value) !== value))))) return refuse('document_shape');
  if (Object.keys(live.tabDocuments || {}).some(key => !Object.prototype.hasOwnProperty.call(live.tabEpochs || {}, key)) ||
      Object.keys(live.tabEpochs || {}).some(key => !Object.prototype.hasOwnProperty.call(live.tabDocuments || {}, key))) return refuse('document_map_mismatch');
  const rows = live.journal === undefined ? [] : live.journal;
  if (!Array.isArray(rows) || rows.length > 4000 || !rows.every(row => row &&
      row.agent == null && row.agentCommandId == null &&
      row.enrollmentCustodyUncertain !== true &&
      ![row, row.event].some(value => value && Object.keys(value).some(key =>
        !['agent', 'agentCommandId'].includes(key) && /owner|command|lease|receipt|helper|worker|revival|delivery/i.test(key))) &&
      !!cleanConversationId(row.conversationId) && cleanConversationId(row.conversationId) === row.conversationId && row.provisional == null &&
      ['user_message', 'assistant_message', 'progress', 'conversation_title', 'model_selection', 'app_sightings',
        'chat_error', 'turn_start', 'turn_end', 'page_tool', 'tool_evidence'].includes(row.event?.kind))) return refuse('observation_shape');
  const ordinary = rows => Array.isArray(rows) && rows.length <= 200 && rows.every(row => row &&
    cleanConversationId(row.conversationId) === row.conversationId && Number.isFinite(row.queuedAt) && row.queuedAt > 0 &&
    row.enrollmentCustodyUncertain !== true &&
    !['byExtension', 'retirement', 'retirementAcked', 'firstEnrollmentSource'].some(key => Object.prototype.hasOwnProperty.call(row, key)));
  const localCloses = stored.closeOutbox === undefined ? [] : stored.closeOutbox;
  const sessionCloses = live.closeOutbox === undefined ? [] : live.closeOutbox;
  if (!ordinary(localCloses) || !ordinary(sessionCloses)) return refuse('close_shape');
  if (!localCloses.length) return refuse('close_missing');
  if (stableOperatorAdoptionJson(localCloses) !== stableOperatorAdoptionJson(sessionCloses)) return refuse('receipt_mismatch');
  const history = { journal: rows, localCloseOutbox: localCloses, sessionCloseOutbox: sessionCloses };
  for (const key of UNASSIGNED_HISTORY_FIELDS) {
    if (key !== 'journal' && key !== 'closeOutbox' && Object.prototype.hasOwnProperty.call(live, key))
      Object.defineProperty(history, key, { value: live[key], enumerable: true, configurable: true, writable: true });
  }
  return cloneUnassignedHistoryData(history);
}

async function unassignedHistorySnapshot(targetInstanceId, diagnostic = null) {
  const refuse = reason => {
    try {
      if (diagnostic && Object.getOwnPropertyDescriptor(diagnostic, 'preservationRefusal')?.value === null)
        diagnostic.preservationRefusal = reason;
    } catch { /* A diagnostic trap never changes custody. */ }
    return null;
  };
  if (unassignedHistoryUncertain || sealedUnassignedHistory) return refuse('sealed_custody');
  if (instanceId !== null || port !== null || token !== null || disconnected) return refuse('prior_binding');
  if (pairing || journalWorkers.size || maintenanceFlight || modelCatalogFlight || pluginRefreshFlight || projectCreateFlight || deferredRecoveryWork)
    return refuse('active_custody');
  const epoch = connectionEpoch;
  try {
    await Promise.all([liveWriteQueue, journalWriteQueue, connectionPersistTail]);
    const read = async () => {
      try { return await readUnassignedHistoryStores(); }
      catch (error) { refuse('snapshot_read_failed'); throw error; }
    };
    const snapshot = await read();
    if (!snapshot) return refuse('timeout');
    if (epoch !== connectionEpoch) return refuse('snapshot_changed');
    const state = unassignedHistoryState(cloneUnassignedHistoryData(snapshot[0]), cloneUnassignedHistoryData(snapshot[1]), targetInstanceId, diagnostic);
    if (!state) return null;
    if (!sameUnassignedHistoryMemory(state)) return refuse('memory_mismatch');
    const digest = await unassignedHistoryDigest(state);
    const latest = await read();
    if (!latest) return refuse('timeout');
    const latestState = unassignedHistoryState(cloneUnassignedHistoryData(latest[0]), cloneUnassignedHistoryData(latest[1]), targetInstanceId, diagnostic);
    if (epoch !== connectionEpoch) return refuse('snapshot_changed');
    if (!latestState) return null;
    if (!sameUnassignedHistoryMemory(latestState)) return refuse('memory_mismatch');
    if (stableOperatorAdoptionJson(latestState) !== stableOperatorAdoptionJson(state)) return refuse('snapshot_changed');
    return { state, offer: { version: 1, targetInstanceId, snapshotDigest: digest,
      journalCount: state.journal.length, ordinaryCloseCount: state.localCloseOutbox.length } };
  } catch { return refuse('invalid_snapshot'); }
}

function sameUnassignedHistoryMemory(state) {
  if (stableOperatorAdoptionJson(state.journal) !== stableOperatorAdoptionJson(journal) ||
      stableOperatorAdoptionJson(state.localCloseOutbox) !== stableOperatorAdoptionJson(closeOutbox)) return false;
  const current = { tabDocuments, tabEpochs, tabConversations, terminalDocuments, recoveryMonitoring };
  return Object.keys(current).every(key => stableOperatorAdoptionJson(current[key]) ===
    stableOperatorAdoptionJson(Object.prototype.hasOwnProperty.call(state, key) ? state[key] : key === 'recoveryMonitoring' ? false : {}));
}

async function preserveUnassignedHistory(snapshot, stillCurrent) {
  // A local seal and a session pointer are two distinct commits. Any incomplete commit
  // remains negative custody on cold load; it never becomes an automatic pairing grant.
  const archive = { version: 1, targetInstanceId: snapshot.offer.targetInstanceId, browserId,
    snapshotDigest: snapshot.offer.snapshotDigest, sealedAt: Date.now(), phase: 'sealed', history: snapshot.state };
  try {
    if (!await stillCurrent()) return false;
    await chrome.storage.local.set({ sealedUnassignedHistory: archive });
    const sealed = (await chrome.storage.local.get('sealedUnassignedHistory')).sealedUnassignedHistory;
    if (stableOperatorAdoptionJson(cloneUnassignedHistoryData(sealed)) !== stableOperatorAdoptionJson(archive) || !await stillCurrent())
      throw new Error('preservation seal changed');
    await Promise.all([liveWriteQueue, journalWriteQueue, connectionPersistTail]);
    const current = await readUnassignedHistoryStores();
    if (!current || !await stillCurrent()) throw new Error('preservation selection changed');
    delete current[0].sealedUnassignedHistory;
    const currentState = unassignedHistoryState(current[0], current[1], archive.targetInstanceId);
    if (!currentState || stableOperatorAdoptionJson(currentState) !== stableOperatorAdoptionJson(archive.history) ||
        !sameUnassignedHistoryMemory(archive.history))
      throw new Error('preservation history changed');
    // No await between the final census and the in-memory dispatch cutover.
    journal = [];
    closeOutbox = [];
    sealedUnassignedHistory = archive;
    unassignedHistoryGeneration = archive.snapshotDigest;
    const publish = journalWriteQueue.then(() => chrome.storage.session.set({ journal, unassignedHistoryGeneration }));
    journalWriteQueue = publish.catch(() => undefined);
    await Promise.all([publish, persistLive()]);
    if (!await stillCurrent()) throw new Error('preservation selection changed');
    const committedArchive = cloneUnassignedHistoryData(archive);
    committedArchive.phase = 'committed';
    await chrome.storage.local.set({ sealedUnassignedHistory: committedArchive });
    const confirmation = await readUnassignedHistoryStores();
    const confirmed = confirmation?.[0]?.sealedUnassignedHistory;
    if (stableOperatorAdoptionJson(cloneUnassignedHistoryData(confirmed)) !== stableOperatorAdoptionJson(committedArchive) || !await stillCurrent())
      throw new Error('preservation commit not confirmed');
    if (confirmation[1].unassignedHistoryGeneration !== archive.snapshotDigest ||
        (confirmation[1].journal || []).some(row => unassignedHistoryConversation(row?.conversationId)) ||
        (confirmation[0].closeOutbox || []).some(row => unassignedHistoryConversation(row?.conversationId)))
      throw new Error('preservation active generation not confirmed');
    sealedUnassignedHistory = committedArchive;
    console.info('[Chat On Steroids] unassigned history preserved for future account traffic', {
      targetInstanceId: archive.targetInstanceId, journalCount: snapshot.offer.journalCount, ordinaryCloseCount: snapshot.offer.ordinaryCloseCount });
    return true;
  } catch {
    unassignedHistoryUncertain = true;
    disconnected = true;
    token = null;
    pairingError = { error: 'account_history_preservation_uncertain',
      message: 'Chrome could not confirm the preserved-history transition. Existing history is held; preserve companion storage and check its available space before recovery.' };
    console.warn('[Chat On Steroids] unassigned history preservation held', {
      category: 'commit_unconfirmed', targetInstanceId: snapshot.offer.targetInstanceId });
    return false;
  }
}

function exactOperatorPreservation(value, expected) {
  try {
    const data = cloneUnassignedHistoryData(value);
    return !!expected && Object.keys(data).sort().join(',') === 'journalCount,ordinaryCloseCount,snapshotDigest,targetInstanceId,version' &&
      Object.keys(data).every(key => data[key] === expected[key]) && data.version === 1 &&
      /^[a-f0-9]{64}$/.test(data.snapshotDigest || '') &&
      Number.isSafeInteger(data.journalCount) && data.journalCount >= 0 && data.journalCount <= 4000 &&
      Number.isSafeInteger(data.ordinaryCloseCount) && data.ordinaryCloseCount >= 1 && data.ordinaryCloseCount <= 200 &&
      data.journalCount + data.ordinaryCloseCount > 0;
  } catch { return false; }
}

function unassignedHistoryConversation(value) {
  const id = cleanConversationId(value)?.toLowerCase();
  if (!id || !sealedUnassignedHistory) return false;
  const history = sealedUnassignedHistory.history;
  return history.journal.some(row => cleanConversationId(row.conversationId)?.toLowerCase() === id) || history.localCloseOutbox.some(row => cleanConversationId(row.conversationId)?.toLowerCase() === id) ||
    Object.values(history.tabConversations || {}).some(value => cleanConversationId(value)?.toLowerCase() === id);
}

function exactOperatorAdoption(value, expected) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !!expected &&
    Object.keys(value).length === 5 &&
    ['version', 'targetInstanceId', 'snapshotDigest', 'journalCount', 'ordinaryCloseCount'].every(key =>
      Object.prototype.hasOwnProperty.call(value, key) && value[key] === expected[key]) &&
    value.version === 1 && /^[a-f0-9]{64}$/.test(value.snapshotDigest || '') &&
    Number.isInteger(value.journalCount) && value.journalCount > 0 && value.journalCount <= 4000 &&
    Number.isInteger(value.ordinaryCloseCount) && value.ordinaryCloseCount > 0 && value.ordinaryCloseCount <= 200;
}

function onlyOperatorAdoptionCustody() {
  const closes = operatorAdoptionCloseRows(closeOutbox);
  const observations = operatorAdoptionJournalRows(journal);
  if (!closes || !observations || !operatorAdoptionTerminalState({
    terminalDocuments, tabDocuments, tabEpochs, tabConversations, retiredDocuments, recoveryMonitoring
  }, closes)) return false;
  const closeConversations = new Set(closes.map(row => row.conversationId));
  const observationConversations = new Set(observations.map(row => row.conversationId));
  return closeConversations.size === observationConversations.size &&
    [...closeConversations].every(id => observationConversations.has(id));
}

async function neverBoundAccountConnection(stagedSelection = null) {
  if (!unboundEnrollmentSource || instanceId !== null || port !== null || token !== null || disconnected || !journal.length) return false;
  let timer;
  try {
    const keys = ['instanceId', 'port', 'token', 'disconnected'];
    const arrays = ['deferredRevivals', 'closeOutbox', 'commandAckOutbox', 'settled'];
    const maps = ['inputOpenings', 'desktopInputTabs', 'stopOpenings', 'commandTabLeases', 'pendingInputReceipts',
      'appOwnedOpeningTabs', 'automaticTabRetirements', 'discardProtectedTabs', 'protectedMainTabs', 'cosGroupedTabs',
      'terminalDocuments', 'retiredDocuments'];
    const snapshot = await Promise.race([
      Promise.all([chrome.storage.local.get([...keys, 'browserId', ...arrays, ...maps]),
        chrome.storage.session.get([...arrays, ...maps, 'journal', 'tabConversations', 'tabDocuments', 'tabEpochs',
          'recoveryMonitoring', 'delivery', 'projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner'])]),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS); })
    ]);
    if (!snapshot) return false;
    const [stored, live] = snapshot;
    // The postwrite check may recognize only this explicit intent's disconnected stage.
    // Any missing, different, legacy or malformed tuple remains a custody veto.
    if (stagedSelection) {
      if (!keys.every(key => Object.prototype.hasOwnProperty.call(stored, key) && stored[key] === stagedSelection[key])) return false;
      for (const key of keys) delete stored[key];
    }
    return neverBoundAccountStorage(stored, true) && neverBoundAccountStorage(live, false) ||
      prospectiveFirstEnrollmentCloseStorage(stored, live);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

/** Native observations are preserved, not cleared or moved from a previously selected account. */
function onlyProspectiveFirstEnrollmentCloses() {
  const rows = firstEnrollmentCloseRows(closeOutbox, browserId);
  return rows && recoveryMonitoring === true && exactFirstEnrollmentTerminalState({
    terminalDocuments, tabDocuments, tabEpochs, tabConversations
  }, rows) ? rows : null;
}

function onlyNeverBoundObservations(prospectiveCloses = null) {
  if (instanceId !== null || port !== null || token !== null || disconnected || pairing ||
      settled.length || delivery.at !== 0 || delivery.total !== 0 || delivery.ok !== null ||
      recoveryMonitoring !== Boolean(prospectiveCloses) ||
      Object.keys(pendingInputReceipts).length || Object.keys(appOwnedOpeningTabs).length ||
      Object.keys(automaticTabRetirements).length || Object.keys(discardProtectedTabs).length ||
      Object.keys(protectedMainTabs).length || Object.keys(cosGroupedTabs).length ||
      Object.keys(retiredDocuments).length ||
      (!prospectiveCloses && Object.keys(terminalDocuments).length))
    return false;
  return (!prospectiveCloses || firstEnrollmentCloseRows(prospectiveCloses, browserId)) &&
    onlyNeverBoundObservationRows(journal);
}

function companionPendingWork() {
  return {
    journal: journal.length, journalWorkers: journalWorkers.size, closeOutbox: closeOutbox.length,
    commandAckOutbox: commandAckOutbox.length, deferredRevivals: deferredRevivals.length,
    inputOpenings: Object.keys(inputOpenings).length, stopOpenings: Object.keys(stopOpenings).length,
    commandTabLeases: Object.keys(commandTabLeases).length, maintenanceFlight: maintenanceFlight ? 1 : 0,
    modelCatalogFlight: modelCatalogFlight ? 1 : 0, pluginRefreshFlight: pluginRefreshFlight ? 1 : 0,
    projectCreateFlight: projectCreateFlight ? 1 : 0, deferredRecoveryWork: deferredRecoveryWork ? 1 : 0
  };
}

async function accountPairingBusy(firstEnrollment = false, stagedSelection = null,
    operatorAdoption = null, targetInstanceId = null, adoptionDiagnostic = null, reloadLeases = null) {
  // Return only bounded, fixed-key custody counts. Native-idle does not prove these owners
  // have settled, and a diagnostic must not reveal their ids, prompts or storage exceptions.
  let observationsProven = false;
  let operatorAdoptionProven = false;
  const active = () => Object.fromEntries(Object.entries(companionPendingWork()).filter(([key, count]) => {
    if (count <= 0) return false;
    // Account changes never pass this reload-only snapshot. A local-persistent identity lease
    // is not an in-flight payload, but omitting it must still reach the retained-owner read below.
    if (key === 'commandTabLeases' && reloadLeases && reloadLeasesCurrent(reloadLeases)) return false;
    const prospectiveCloses = observationsProven && onlyProspectiveFirstEnrollmentCloses();
    const observations = observationsProven && onlyNeverBoundObservations(prospectiveCloses);
    const adopted = operatorAdoptionProven && onlyOperatorAdoptionCustody();
    return !((key === 'journal' && (observations || adopted)) ||
      (key === 'closeOutbox' && (observations && prospectiveCloses || adopted)));
  })
    .map(([key, count]) => [key, Math.min(4000, count)]));
  const current = active();
  if (Object.keys(current).length && !((firstEnrollment || operatorAdoption) &&
      Object.keys(current).every(key => key === 'journal' || key === 'closeOutbox'))) return current;
  let timer;
  try {
    // These retained owners outlive their flight, including their app-owned helper tabs.
    // Only their incumbent lifecycle may retire them; pairing never clears or infers them away.
    const owners = await Promise.race([
      chrome.storage.session.get(['projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner']),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS); })
    ]);
    // Re-read raw custody after the yielded owner check at every serialized accept boundary.
    // A cached first-enrollment intent never authorizes newly appeared connection/history.
    if (firstEnrollment) observationsProven = await neverBoundAccountConnection(stagedSelection);
    else if (operatorAdoption) operatorAdoptionProven = exactOperatorAdoption(operatorAdoption,
      await operatorAdoptionSnapshot(targetInstanceId, stagedSelection, adoptionDiagnostic));
    const pending = active();
    if (!owners) pending.ownerReadTimedOut = 1;
    else for (const key of ['projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner']) {
      if (owners[key]) pending[key] = 1;
    }
    return Object.keys(pending).length ? pending : null;
  } catch { return { ...active(), ownerReadFailed: 1 }; }
  finally { clearTimeout(timer); }
}

let companionReloadFlight = null;

function reloadLeasesCurrent(snapshot) {
  return snapshot && snapshot.generation === commandLeaseGeneration &&
    Object.keys(snapshot.leases).length === Object.keys(commandTabLeases).length &&
    Object.entries(snapshot.leases).every(([key, value]) => commandTabLeases[key] === value);
}

async function durableReloadLeases() {
  let timer;
  try {
    const snapshot = { generation: commandLeaseGeneration, leases: { ...commandTabLeases } };
    const stored = await Promise.race([
      chrome.storage.local.get(['commandTabLeases', 'commandLeaseGeneration']),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS); })
    ]);
    const saved = stored?.commandTabLeases;
    if (!stored || stored.commandLeaseGeneration !== snapshot.generation || !reloadLeasesCurrent(snapshot) ||
        (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved))) ||
        (Object.keys(snapshot.leases).length > 0 && !saved) ||
        saved && (Object.keys(saved).length !== Object.keys(snapshot.leases).length ||
          !Object.entries(snapshot.leases).every(([key, value]) => saved[key] === value))) return null;
    return snapshot;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function reloadPendingWork(durableLeases = null) {
  return Object.fromEntries(Object.entries({
    ...companionPendingWork(), tabOperations: tabOperationQueues.size,
    pendingInputReceipts: Object.keys(pendingInputReceipts).length,
    pairing: pairing ? 1 : 0, commandDelivery: ackingCommands ? 1 : 0, closeDelivery: closing ? 1 : 0,
    journalInFlight: journalInFlight.size, browserCapture: browserDebugCaptureInFlight ? 1 : 0,
    backgroundWindow: backgroundWindowFlight ? 1 : 0, tabRetirement: automaticTabRetireFlight ? 1 : 0,
    openConversation: openConversationRequestsInFlight.size, browserControl: browserControlledTabs.size,
    browserControlFlight: browserControlFlights.size, urgentOpen: urgentOpenConversationFlights.size,
    tabCloseReceipts: Object.keys(automaticTabRetirements).length,
    receiverRepair: desktopInputReceiverRepairs.size, stopOffers: stopOffers.size
  }).filter(([key, count]) => count > 0 && !(key === 'commandTabLeases' && reloadLeasesCurrent(durableLeases)))
    .map(([key, count]) => [key, Math.min(4000, count)]));
}

/** Reload clears storage.session: drain incumbent journals, never replace them with a mirror.
 * Page-idle observations are not a quiescence lock. Until a content-side lock exists, even
 * apparently idle ChatGPT tabs defer reload: their local queue/helper/draft can change later.
 */
async function reloadCompanionSafely() {
  const defer = (pendingWork = { unverified: 1 }) => {
    const reported = { ...pendingWork };
    // A count subset explains retained elections; it never grants retirement authority.
    if (Number.isInteger(reported.inputOpenings) && reported.inputOpenings > 0) {
      const retiredHelperElections = Object.values(inputOpenings)
        .filter(row => row?.stage === 'retired').length;
      if (retiredHelperElections > 0) reported.retiredHelperElections = Math.min(4000, retiredHelperElections);
    }
    console.info('[Chat On Steroids] companion reload deferred; retained custody', reported);
    return { ok: false, error: 'reload_deferred', pendingWork: reported };
  };
  const conversationInventory = async () => {
    // Chrome's URL query matches the committed URL only. A blank/foreign tab may already
    // be navigating to ChatGPT; include that pending document at both reload boundaries.
    const tabs = await boundedTabInventory({});
    return Array.isArray(tabs) ? tabs.filter(tab => isChatGptUrl(tab?.url) || isChatGptUrl(tab?.pendingUrl)) : null;
  };
  try {
    await load();
    const epoch = connectionEpoch, pairedInstance = instanceId, pairedPort = port, pairedToken = token;
    const current = () => epoch === connectionEpoch && pairedInstance === instanceId &&
      pairedPort === port && pairedToken === token;
    // Joining a different command/close owner is not a positive zero-in-flight receipt.
    if (ackingCommands || closing || pairing || tabOperationQueues.size)
      return defer(reloadPendingWork());
    const tabs = await conversationInventory();
    if (!Array.isArray(tabs)) return defer({ inventoryUnverified: 1 });
    if (tabs.length) return defer({ openChatgptTabs: Math.min(4000, tabs.length) });
    await drainCommandAcks();
    await drain();
    // Normal drain intentionally doesn't await workers another chat already started.
    // Reload must join those owners as well and re-check their retained journal afterward.
    await Promise.all([...journalWorkers]);
    await drainCloses();
    await Promise.all([liveWriteQueue, journalWriteQueue, connectionPersistTail]);
    const durableLeases = await durableReloadLeases();
    if (!durableLeases) return defer({ leaseDurabilityUnverified: 1 });
    const pending = await accountPairingBusy(false, null, null, null, null, durableLeases);
    // Pairing changes accounts; reload does not. Only this already-local-persistent identity
    // map may survive reload, after exact storage parity and a fresh zero-document inventory.
    // All payload, opening, native Send and retained helper owners remain blocking custody.
    if (!current()) return defer({ connectionChanged: 1 });
    if (pending) return defer(pending);
    // Re-read retained owners and exact local durability before the final browser observation.
    const finalLeases = await durableReloadLeases();
    const finalOwners = await accountPairingBusy(false, null, null, null, null,
      finalLeases && reloadLeasesCurrent(durableLeases) ? finalLeases : null);
    // This must be the last awaited operation. A fresh native document or newly arrived worker
    // custody vetoes reload synchronously; no storage wait can age an idle-page observation.
    const now = await conversationInventory();
    if (!Array.isArray(now)) return defer({ inventoryUnverified: 1 });
    if (now.length) return defer({ openChatgptTabs: Math.min(4000, now.length) });
    const finalPending = { ...(finalOwners || {}), ...reloadPendingWork(finalLeases) };
    if (!current() || !finalLeases || !reloadLeasesCurrent(durableLeases) || Object.keys(finalPending).length || durabilityGap)
      return defer(Object.keys(finalPending).length ? finalPending : { custodyChanged: 1 });
    console.info('[Chat On Steroids] companion reload requested; journals delivered, no ChatGPT tabs or in-flight custody');
    chrome.runtime.reload();
    return { ok: true, reloading: true };
  } catch { return defer({ custodyCheckFailed: 1 }); }
}

/** Existing account-selection errors explain custody without clearing it or granting a retry. */
function accountBusyError(pendingWork, adoptionDiagnostic = null) {
  const labels = {
    journal: 'recorded observations', journalWorkers: 'observation deliveries', closeOutbox: 'chat-close receipts',
    commandAckOutbox: 'command delivery receipts', deferredRevivals: 'saved worker revivals',
    inputOpenings: 'message opening leases', stopOpenings: 'Stop opening leases', commandTabLeases: 'command tab leases',
    maintenanceFlight: 'account maintenance', modelCatalogFlight: 'model inspection', pluginRefreshFlight: 'connector refresh',
    projectCreateFlight: 'project creation', deferredRecoveryWork: 'worker recovery',
    projectCreateOwner: 'retained project-creation custody', pluginRefreshOwner: 'retained connector-refresh custody',
    modelCatalogOwner: 'retained model-inspection custody', ownerReadTimedOut: 'ownership read timed out',
    ownerReadFailed: 'ownership read failed', streaming: 'native streaming', generating: 'native generation',
    pendingTools: 'native tools', jobBusy: 'message delivery', goalBusy: 'Goal/Loop operation', queued: 'queued page operation',
    projectCreateBusy: 'native project creation', pluginRefreshBusy: 'native connector refresh',
    modelCatalogBusy: 'native model inspection', desktopInputBusy: 'native input delivery'
  };
  // Rebuild at the publication boundary too; future callers cannot accidentally add content.
  const counts = {};
  for (const key of Object.keys(labels)) {
    if (!pendingWork || !Object.prototype.hasOwnProperty.call(pendingWork, key)) continue;
    const count = pendingWork?.[key];
    if (Number.isInteger(count) && count > 0) counts[key] = Math.min(4000, count);
  }
  const summary = Object.entries(counts).map(([key, count]) => `${labels[key]} (${count})`).join(', ');
  let historyEligibility = null;
  let historyTerminalReason = null, historyTerminalCounts = null;
  let historyPreservationReason = null, historyPreservationCounts = null;
  try {
    const reason = adoptionDiagnostic && Object.getOwnPropertyDescriptor(adoptionDiagnostic, 'refusal')?.value;
    if (['prior_binding', 'observation_shape', 'close_shape', 'receipt_mismatch', 'terminal_mismatch',
      'conversation_mismatch', 'active_custody', 'timeout', 'snapshot_changed', 'snapshot_read_failed',
      'invalid_snapshot'].includes(reason)) historyEligibility = reason;
    if (historyEligibility === 'terminal_mismatch') {
      const terminalReason = Object.getOwnPropertyDescriptor(adoptionDiagnostic, 'terminalReason')?.value;
      if (['monitoring_off', 'monitoring_unproven', 'terminal_map_invalid', 'terminal_count_mismatch', 'document_map_invalid',
        'epoch_map_invalid', 'conversation_map_invalid', 'retired_map_invalid', 'retired_ownership',
        'document_invalid', 'epoch_map_mismatch', 'epoch_invalid', 'registered_conversation_entry',
        'terminal_document_mismatch'].includes(terminalReason)) {
        historyTerminalReason = terminalReason;
        const raw = Object.getOwnPropertyDescriptor(adoptionDiagnostic, 'terminalCounts')?.value;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const terminalCounts = {};
          for (const key of ['terminalEntries', 'closeReceipts', 'documentEntries', 'epochEntries',
            'conversationEntries', 'retiredEntries']) {
            const value = Object.getOwnPropertyDescriptor(raw, key)?.value;
            if (value !== null && !(Number.isInteger(value) && value >= 0)) break;
            terminalCounts[key] = value === null ? null : Math.min(4000, value);
          }
          if (Object.keys(terminalCounts).length === 6) historyTerminalCounts = terminalCounts;
        }
      }
    }
    const preservationReason = adoptionDiagnostic && Object.getOwnPropertyDescriptor(adoptionDiagnostic, 'preservationRefusal')?.value;
    if (['invalid_snapshot', 'local_fields_unsupported', 'session_fields_unsupported', 'browser_mismatch', 'target_invalid',
      'active_custody', 'monitoring_shape', 'document_shape', 'document_map_mismatch', 'observation_shape',
      'close_shape', 'close_missing', 'receipt_mismatch', 'sealed_custody', 'prior_binding', 'timeout',
      'snapshot_changed', 'snapshot_read_failed', 'memory_mismatch'].includes(preservationReason)) {
      historyPreservationReason = preservationReason;
      const raw = Object.getOwnPropertyDescriptor(adoptionDiagnostic, 'preservationCounts')?.value;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const preservationCounts = {};
        for (const key of ['localFields', 'sessionFields', 'unsupportedLocalFields', 'unsupportedSessionFields',
          'journalEntries', 'closeReceipts', 'documentEntries', 'epochEntries', 'conversationEntries', 'terminalEntries']) {
          const value = Object.getOwnPropertyDescriptor(raw, key)?.value;
          if (value !== null && !(Number.isInteger(value) && value >= 0)) break;
          preservationCounts[key] = value === null ? null : Math.min(4000, value);
        }
        if (Object.keys(preservationCounts).length === 10) historyPreservationCounts = preservationCounts;
      }
    }
  } catch { /* A diagnostic trap is not authority or content to publish. */ }
  const diagnostic = historyEligibility
    ? ` History eligibility diagnostic: ${historyEligibility} (not permission or a delivery retry grant).` : '';
  const terminalDiagnostic = historyTerminalReason ? ` Terminal custody diagnostic: ${historyTerminalReason}` +
    (historyTerminalCounts ? ` (${Object.entries(historyTerminalCounts)
      .map(([key, count]) => `${key}=${count === null ? 'unknown' : count}`).join(', ')})` : '') + '.' : '';
  const preservationDiagnostic = historyPreservationReason ? ` History preservation diagnostic: ${historyPreservationReason}` +
    (historyPreservationCounts ? ` (${Object.entries(historyPreservationCounts)
      .map(([key, count]) => `${key}=${count === null ? 'unknown' : count}`).join(', ')})` : '') + '.' : '';
  return { ok: false, error: 'account_busy', pendingWork: counts,
    ...(historyEligibility ? { historyEligibility } : {}),
    ...(historyTerminalReason ? { historyTerminalReason } : {}),
    ...(historyTerminalCounts ? { historyTerminalCounts } : {}),
    ...(historyPreservationReason ? { historyPreservationReason } : {}),
    ...(historyPreservationCounts ? { historyPreservationCounts } : {}),
    message: `This Chrome profile still has pending CoS work: ${summary || 'ownership could not be confirmed'}. Nothing was cleared or reassigned. Let the owning operation settle before changing accounts.${diagnostic}${terminalDiagnostic}${preservationDiagnostic} Recovery protocol 1.` };
}

/** Reprove the exact isolated document even while its next registration is tab-queued. */
async function pairingUiReady(sender, source) {
  if (companionPopup(sender)) return { ok: true };
  if (!pairingUiOwner(sender, source)) return { ok: false, error: 'stale_document' };
  let timer;
  try {
    const page = await Promise.race([
      chrome.tabs.sendMessage(source.tab, { type: 'clf-page-status' }, { documentId: source.documentId }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS); })
    ]);
    if (!pairingUiOwner(sender, source) || page?.ok !== true || page.epoch !== source.navigationEpoch)
      return { ok: false, error: 'stale_document' };
    const pendingWork = {};
    for (const key of ['streaming', 'generating', 'pendingTools', 'jobBusy', 'goalBusy', 'queued',
      'projectCreateBusy', 'pluginRefreshBusy', 'modelCatalogBusy', 'desktopInputBusy']) {
      if (page[key]) pendingWork[key] = 1;
    }
    return Object.keys(pendingWork).length ? accountBusyError(pendingWork) : { ok: true };
  } catch { return { ok: false, error: 'stale_document' }; }
  finally { clearTimeout(timer); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && typeof message.type === 'string' ? HANDLERS[message.type] : null;
  if (!handler) {
    sendResponse({ ok: false, error: 'unknown_message' });
    return false;
  }
  const owned = new Set([
    'stop_redeem',
    'stop_ack',
    'desktop_input',
    'model_catalog',
    'tab_conversation',
    'plugin_refresh',
    'project_create',
    'usage_observation',
    'conversation_deleted',
    'events',
    'bind',
    'activity',
    'correlate',
    'closed',
    'compact',
    'goal_draft',
    'focus_tab',
    'goal_ack',
    'goal_objective',
    'goal_open',
    'settings_set',
    'settings_get',
    'repair_fiber',
    'redeem',
    'retire_stale_command',
    'defer_revival',
    'forget_revival',
    'ack'
  ]);
  const run = async () => {
    let source = null;
    const accountUi = message.type === 'accountChoices' || message.type === 'pairTo';
    if (accountUi && !companionPopup(sender) && !isChatGptUrl(sender?.url))
      return { ok: false, error: 'popup_required' };
    if (accountUi && !companionPopup(sender) && (sender?.frameId !== 0 || tabId(sender) === null || !senderDocument(sender)))
      return { ok: false, error: 'document_identity_missing' };
    if (owned.has(message.type) || (accountUi && !companionPopup(sender))) {
      source = await authorizeDocument(sender, message);
      if (!source.ok) return source;
    }
    return handler(message, sender, source);
  };
  const id = tabId(sender);
  const accountUi = message.type === 'accountChoices' || message.type === 'pairTo';
  const documentOwned = owned.has(message.type) || (accountUi && !companionPopup(sender));
  const operation = documentOwned || message.type === 'register_document' ? serializeTab(id, run) : run();
  operation.then(sendResponse, (err) =>
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
  );
  return true;
});

/**
 * Best current conversation identity for one ChatGPT tab.
 *
 * A concrete `/c/<id>` URL wins. During full reload/startup Chrome can temporarily expose only
 * the ChatGPT root, a pending URL, or no URL at all while our tab registry still durably knows
 * which conversation this numeric tab represents. That transient shape must count as "the exact
 * worker tab is present" for revival routing, otherwise recovery creates a duplicate tab ~at
 * random depending on which lifecycle event won the race.
 *
 * The registry is deliberately ignored when a concrete *different* conversation is in the URL;
 * that is a real A->B navigation and stale registry state must not keep A artificially present.
 */
function concreteConversationForTab(tab) {
  if (!tab || typeof tab.id !== 'number') return null;
  return conversationFromUrl(tab.url) || conversationFromUrl(tab.pendingUrl);
}

function conversationForTab(tab) {
  if (!tab || typeof tab.id !== 'number') return null;
  const concrete = concreteConversationForTab(tab);
  if (concrete) return concrete;
  const urls = [tab.url, tab.pendingUrl].filter((value) => typeof value === 'string' && value);
  if (urls.some((value) => !isChatGptUrl(value))) return null;
  return cleanConversationId(tabConversations[String(tab.id)]);
}

// Tab ids belong to one browser lifetime. Keep reload/update custody, but rotate the generation
// and clear tab leases before restored pages redeem after a whole Chrome restart. Main can then
// transfer an untouched Resume across that proven browser-session boundary without allowing a
// second tab in the same browser session to steal it.
chrome.runtime.onStartup?.addListener(() => {
  commandTabLeases = {};
  commandLeaseGeneration = crypto.randomUUID().replaceAll('-', '');
  commandLeaseStartupReset = chrome.storage.local.set({
    commandTabLeases,
    commandLeaseGeneration
  }).catch(() => undefined);
});

// Document unload is not conversation lifetime. A real tab close is: reload keeps the
// same tab id, while closing it wakes the service worker and retires only that tab's claim.
// Chrome does not identify whether onRemoved came from Ctrl+W or an unexpected close. A stale
// nonDiscardable main-tab marker protects against Chrome discarding a tab; it cannot override a
// human close by creating a new tab before Main receives /closed with manual=true. The running
// tools, saved replies and delivery receipts remain under their existing durable owners.
chrome.tabs.onRemoved.addListener((id, removeInfo) => {
  clearDeferredRevivalOffersForTab(id);
  void serializeTab(id, async () => {
    await load();
    const key = String(id);
    const navigationEpoch = Number.isSafeInteger(tabEpochs[key]) ? tabEpochs[key] : null;
    const retirement = automaticTabRetirements[key];
    const automaticallyRetired = Boolean(retirement && retirement.tab === id &&
      (retirement.phase === 'issued' || retirement.phase === 'removed') &&
      retirement.documentId === (typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null) &&
      retirement.navigationEpoch === (Number.isSafeInteger(tabEpochs[key]) ? tabEpochs[key] : null) &&
      retirement.conversationId === cleanConversationId(tabConversations[key]));
    const documentId = await markTerminal(id);
    const result = await releaseTab(
      id,
      null,
      documentId,
      navigationEpoch,
      true,
      null,
      automaticallyRetired,
      automaticallyRetired && retirement?.kind === 'superseded-source' ? retirement : null
    );
    if (retirement && automaticTabRetirements[key] === retirement) {
      delete automaticTabRetirements[key];
      await persistLive();
    }
    return result;
  }).catch(() => undefined);
});

// A tab can survive while its ChatGPT document does not: navigating it to another site kills
// the content script, so neither pagehide nor any later observer can retire this conversation.
// onRemoved never fires because the tab itself still exists. A URL outside ChatGPT is terminal
// here, and so is a full document load of any ChatGPT URL that is concretely not chat A's own:
// the root, another chat, a project page. The user typing chatgpt.com into a Prime's tab used to
// leave A bound to that tab until some later chat happened to be given an id there, so the app
// never heard that A's page was gone and never reopened it (2026-09-03). A same-chat reload
// carries A's own URL and stays ambiguous until the replacement document binds; an SPA move,
// which fires no `loading` status, remains the content script's to prove.
chrome.tabs.onUpdated.addListener((id, changeInfo) => {
  if (!changeInfo) return;
  if (typeof changeInfo.url === 'string' && appOpeningMarker(changeInfo.url)) {
    void load().then(() => rememberAppOwnedOpeningTab({ id, url: changeInfo.url })).catch(() => undefined);
  }
  const fullNavigation = changeInfo.status === 'loading';
  const completedNavigation = changeInfo.status === 'complete';
  const leftChatGpt = typeof changeInfo.url === 'string' && !isChatGptUrl(changeInfo.url);
  if (typeof changeInfo.url === 'string' || completedNavigation) {
    void serializeTab(id, async () => {
      await load();
      let targetUrl = typeof changeInfo.url === 'string' ? changeInfo.url : '';
      if (!targetUrl) {
        try {
          const tab = await chrome.tabs.get(id);
          targetUrl = tab?.pendingUrl || tab?.url || '';
        } catch { return false; }
      }
      // Adapted from upstream #1514: URL events reach hidden tabs before their throttled
      // page timers. Target only the already registered exact document/epoch; the page also
      // proves this URL is its current address before observing. This wakes evidence readers,
      // not Send/retry authority, and never injects into or adopts a replacement document.
      const key = String(id);
      const source = { tab: id, documentId: tabDocuments[key], navigationEpoch: tabEpochs[key] };
      if (!fullNavigation && typeof changeInfo.url === 'string' && isChatGptUrl(targetUrl) && ownsDocument(source)) {
        void tabReply(id, { type: 'clf-route-changed', url: targetUrl, navigationEpoch: source.navigationEpoch },
          { documentId: source.documentId });
      }
      return reconcileOpenConversationTab(id, targetUrl, completedNavigation);
    }).catch(() => undefined);
  }
  if (!fullNavigation && !completedNavigation && !leftChatGpt) return;
  if (fullNavigation || leftChatGpt) clearDeferredRevivalOffersForTab(id);
  // A loading transition is a browser document boundary even when both URLs are ChatGPT.
  // SPA pushState does not emit it. The replacement document must register with its own
  // MessageSender.documentId before any identity-sensitive IPC is accepted.
  if (completedNavigation && !leftChatGpt) {
    void (async () => {
      const key = String(id);
      const { documentId, epoch, conversation } = await serializeTab(id, async () => ({
        documentId: tabDocuments[key], epoch: tabEpochs[key],
        conversation: cleanConversationId(tabConversations[key])
      }));
      // With ChatGPT-only host permission Chrome hides an external destination's URL.
      // Loading alone is ambiguous. A completed tab absent from a successful ChatGPT
      // query proves departure without requesting access to the user's other sites.
      const stillDeparting = () => Boolean(documentId) && tabDocuments[key] === documentId &&
        tabEpochs[key] === epoch && terminalDocuments[key] === documentId;
      if (!conversation || !stillDeparting()) return;
      try {
        const tab = await chrome.tabs.get(id);
        const targetUrl = tab?.pendingUrl || tab?.url;
        if (tab?.status !== 'complete' || (targetUrl && isChatGptUrl(targetUrl))) return;
        const present = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
        if (!Array.isArray(present) || present.some((tab) => tab.id === id) || !stillDeparting()) return;
      } catch {
        // Query failure is unknown presence, never permission to detach a live chat.
        return;
      }
      // Let replacement-document registration proceed while the browser query is pending.
      // Re-enter the tab's mutation queue only to commit the still-current departure.
      return serializeTab(id, () => stillDeparting() ?
        releaseTab(id, conversation, documentId, epoch) : undefined);
    })().catch(() => undefined);
    return;
  }
  void serializeTab(id, async () => {
    // A brand-new chat can be reloaded before ChatGPT has assigned /c/<id>. Keep only that
    // id-less root reload's provisional journal across the document swap. It is parked under
    // a reload-only key and adopted by the replacement document when it registers. Known-chat
    // navigations do not use this path, so chat A cannot hand its provisional observations to B.
    // The known chat this tab is concretely leaving for another ChatGPT URL, or null.
    let departed = null;
    let redirectedConversation = null;
    if (fullNavigation && !leftChatGpt) {
      const key = String(id);
      const knownConversation = cleanConversationId(tabConversations[key]);
      let targetUrl = typeof changeInfo.url === 'string' ? changeInfo.url : '';
      if (!targetUrl) {
        try {
          const tab = await chrome.tabs.get(id);
          targetUrl = typeof tab?.pendingUrl === 'string' && tab.pendingUrl ? tab.pendingUrl :
            typeof tab?.url === 'string' ? tab.url : '';
        } catch {
          targetUrl = '';
        }
      }
      let rootReload = false;
      try {
        const url = new URL(targetUrl);
        rootReload = isChatGptUrl(targetUrl) && (url.pathname === '/' || url.pathname === '');
      } catch {
        rootReload = false;
      }
      const documentId = typeof tabDocuments[key] === 'string' ? tabDocuments[key] : null;
      // Not an ambiguous reload: Chrome is replacing known chat A's document with a URL that is
      // not A's. releaseTab() below retires A here and now — its provisional observations are
      // too old to be adopted by whatever loads next, and its final tab leaving is the app's
      // cue to bring it back if a turn is still running in it.
      if (knownConversation && targetUrl && (!isChatGptUrl(targetUrl) || conversationFromUrl(targetUrl) !== knownConversation)) {
        departed = knownConversation;
        if (exactPlainChatHome(targetUrl)) {
          redirectedConversation = knownConversation;
          await rememberRedirectedConversationTab(id, knownConversation);
        }
      } else if (!knownConversation && rootReload && documentId) {
        await carryFreshReloadProvisional(id, documentId);
      }
    }
    const key = String(id);
    const navigationEpoch = Number.isSafeInteger(tabEpochs[key]) ? tabEpochs[key] : null;
    const documentId = await markTerminal(id);
    // A full ChatGPT navigation may be a normal reload of the same conversation. Block the
    // dying document immediately, but preserve the conversation until the replacement page
    // binds and proves whether it is the same chat or a different one.
    if (fullNavigation && !leftChatGpt && !departed) return { ok: true, closed: false };
    return releaseTab(id, departed, documentId, navigationEpoch, false, redirectedConversation);
  }).catch(() => undefined);
});

// -------------------------------------------------------------------- recovery

/**
 * Restores the page half of the bridge after this extension itself is updated/reloaded.
 *
 * Chrome invalidates an extension's isolated content-script world when the extension is
 * reloaded, but it does not reload the user's already-open ChatGPT document. The dead
 * content.js then cannot send observations, request-id evidence or even the conversation's
 * first /events batch, while fiber.js can remain visibly alive in the page's MAIN world.
 * That exact split produces a healthy MCP tunnel plus a permanently growing Unattributed
 * session and no session at all for the ChatGPT tab.
 *
 * runtime.onInstalled fires for unpacked Reload as an update, so repair only at that real
 * lifecycle boundary — never from the service worker's ordinary wake/sleep cycle. The
 * isolated content script has its own one-instance guard because a newly loading page can
 * receive both its static manifest injection and this recovery injection.
 */
const CHATGPT_TAB_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
const PAGE_RECORDER_VERSION = 96;

let deferredRecoveryWork = null;

function clearDeferredRevivalOffersForTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  for (const [id, offeredTab] of [...deferredRevivalOffers.entries()]) {
    if (offeredTab === tabId) deferredRevivalOffers.delete(id);
  }
}

function offerDeferredRevivalToTab(entry, tab) {
  if (!entry || !tab || typeof tab.id !== 'number') return false;
  const id = deferredRevivalId(entry.id);
  const conversationId = cleanConversationId(entry.conversationId);
  if (!id || !conversationId) return false;
  if (deferredRevivalOffers.get(id) === tab.id) return true;
  deferredRevivalOffers.set(id, tab.id);
  try {
    const offered = chrome.tabs.sendMessage(tab.id, {
      type: 'clf-run-command',
      id,
      conversationId,
      // This is browser-restart recovery of a marker that may already have been superseded by a
      // later app wake. content.js may abandon it only while it is still pre-redeem; a fresh
      // reuse handoff is never allowed to preempt an already redeeming/owned command.
      deferredRecovery: true
    });
    void Promise.resolve(offered).then(
      (reply) => {
        // A claimed response means this document crossed the durable bridge lease and remains
        // the sole owner until ACK. Every other response means this offer did not take custody;
        // allow a later document-registration/recovery signal to retry the same existing tab.
        if (!reply || reply.ok !== true || reply.claimed !== true) {
          if (deferredRevivalOffers.get(id) === tab.id) deferredRevivalOffers.delete(id);
        }
      },
      () => {
        if (deferredRevivalOffers.get(id) === tab.id) deferredRevivalOffers.delete(id);
      }
    );
    return true;
  } catch {
    if (deferredRevivalOffers.get(id) === tab.id) deferredRevivalOffers.delete(id);
    return false;
  }
}

function deferredRevivalUrl(entry) {
  if (!entry || !deferredRevivalId(entry.id) || !cleanConversationId(entry.conversationId)) return null;
  const url = new URL(`https://chatgpt.com/c/${entry.conversationId}`);
  url.searchParams.set('clf', entry.id);
  url.hash = `clf=${encodeURIComponent(entry.id)}`;
  return url.toString();
}

/**
 * Opens a fresh ChatGPT chat in the window of the chat it succeeds.
 *
 * The app can name which chat a resume's chat B — or a worker's first chat — belongs beside,
 * but it cannot open a tab there. Handing the URL to the operating system resolves to whichever
 * Chrome instance the platform picks, which is the one that last had focus. With two instances
 * running, the successor of a chat that had just finished in the background one was created in
 * the foreground one instead — a browser this extension was not even loaded in, so nothing ever
 * redeemed the command and the handoff died with nothing connected to it.
 *
 * Only the browser holding the home tab can put the successor in the same window, and a tab
 * this worker creates is by construction in a browser that has the extension. That is the whole
 * reason this decision lives here rather than in the app.
 *
 * The offer is spent by the app on handout, so this runs once per command; a second poll, from
 * this tab or another tab of the same chat, is never given the same id. Missing redemption
 * ends at the command deadline; it never grants another browser-opening attempt.
 */
/** Only the continuation's captured Project chooses a successor's scope. */
function successorChatBase(offered, source) {
  const project = typeof offered === 'string' && /^g-p-[0-9a-f]{32}$/.test(offered) ? offered : null;
  const conversation = cleanConversationId(source);
  return project && conversation ? `https://chatgpt.com/c/${conversation}` : 'https://chatgpt.com/';
}

function successorPlacementOwner(raw) {
  const home = raw?.active !== false && raw?.background !== true
    ? cleanConversationId(raw.homeConversationId)
    : null;
  return home ? `resume:${home}` : null;
}

function successorPlacementUrl(raw, id) {
  const base = successorChatBase(raw?.project, raw?.homeConversationId);
  const marker = `clf=${encodeURIComponent(id)}${base !== 'https://chatgpt.com/' ? '&clf_project=1' : ''}`;
  const query = [marker];
  const model = commandModelSlug(raw?.model);
  const effort = commandReasoningEffort(raw?.reasoningEffort);
  if (model) query.push(`model=${encodeURIComponent(model)}`);
  if (effort) query.push(`reasoning_effort=${encodeURIComponent(effort)}`);
  return `${base}?${query.join('&')}#${marker}`;
}

/**
 * Reuses the physical root document already minted for one exact bridge command.
 *
 * Main can legitimately offer the same unredeemed command again after its bounded pickup
 * deadline. Chrome is slower than that boundary often enough that blindly creating another
 * tab here produces two pages racing to redeem one command. The 16-hex marker is the durable
 * operation identity. Once any ChatGPT tab still carries it, this placement is already owned:
 * an unreadable, navigating, pinned, busy or drafted page must time out visibly rather than
 * gaining a second claimant. Only a fresh same-document empty-page proof permits reloading the
 * existing root so its content script can redeem the original command again.
 */
async function rearmExistingSuccessorRoot(id, raw, acceptance = null) {
  const currentAdmission = () => acceptance === null || acceptance() === true;
  if (!currentAdmission()) return true;
  const commandId = /^[a-f0-9]{16}$/i.test(id || '') ? id.toLowerCase() : null;
  if (!commandId) return false;
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
    if (!currentAdmission()) return true;
  } catch {
    // Unknown inventory is not proof that no claimant exists.
    return true;
  }
  const placementOwner = successorPlacementOwner(raw);
  const matching = tabs.filter(tab => commandMarkerForTab(tab) === commandId || ownedCommandRootMarker(tab) === commandId);
  const exactRoots = matching.filter(tab =>
    commandRootMarkerForTab(tab) === commandId || ownedCommandRootMarker(tab) === commandId);
  for (const tab of exactRoots) {
    if (!currentAdmission()) return true;
    await rememberAppOwnedOpeningTab(tab, null, placementOwner).catch(() => undefined);
    if (!currentAdmission()) return true;
  }
  if (!currentAdmission()) return true;
  // A promoted conversation, two old claimants, or a non-root marker already owns the command.
  // None may be mutated or supplemented by another physical tab.
  if (matching.length > 0 && (matching.length !== 1 || exactRoots.length !== 1)) return true;

  let tab = exactRoots[0] ?? null;
  let expectedMarker = commandId;
  // A same-tab provenance match with a consumed URL marker must be restored to the full
  // command URL before reload; otherwise the replacement content script has no id to redeem.
  let retarget = Boolean(tab && commandRootMarkerForTab(tab) !== commandId);
  if (!tab && placementOwner) {
    // Main may retire a timed-out command and mint a new id for the same resume session. The
    // source conversation is a safe logical owner for resumes; it is deliberately not used for
    // workers because several worker openings can share one prime at the same time.
    const priorRoots = tabs.filter(candidate => {
      const row = Number.isInteger(candidate?.id) ? appOwnedOpeningTabs[String(candidate.id)] : null;
      return row?.owner === placementOwner && ownedCommandRootMarker(candidate);
    });
    if (priorRoots.length > 1) return true;
    if (priorRoots.length === 1) {
      tab = priorRoots[0];
      expectedMarker = ownedCommandRootMarker(tab);
      retarget = true;
    }
  }
  if (!tab) return false;
  if (!Number.isInteger(tab?.id) || tab.pinned || tab.pendingUrl || tab.status === 'loading') return true;
  const key = String(tab.id);
  const source = { tab: tab.id, documentId: tabDocuments[key], navigationEpoch: tabEpochs[key] };
  if (!ownsDocument(source)) return true;
  const unchanged = candidate => candidate && !candidate.pinned && !candidate.pendingUrl &&
    candidate.status !== 'loading' && candidate.url === tab.url &&
    (commandRootMarkerForTab(candidate) === expectedMarker || ownedCommandRootMarker(candidate) === expectedMarker) &&
    !conversationForTab(candidate) && ownsDocument(source);
  try {
    const current = await chrome.tabs.get(tab.id);
    if (!currentAdmission()) return true;
    if (!unchanged(current)) return true;
    const proof = await tabReply(tab.id, { type: 'clf-tab-close-check', conversationId: null },
      { documentId: source.documentId });
    if (!currentAdmission()) return true;
    if (proof?.safe !== true || proof.conversationId !== null ||
        proof.navigationEpoch !== source.navigationEpoch || !ownsDocument(source)) return true;
    const latest = await chrome.tabs.get(tab.id);
    if (!currentAdmission()) return true;
    if (!unchanged(latest)) return true;
    if (retarget) {
      const targetUrl = successorPlacementUrl(raw, id);
      const updated = await chrome.tabs.update(tab.id, { url: targetUrl, active: raw.active !== false });
      if (!currentAdmission()) return true;
      await rememberAppOwnedOpeningTab(updated, targetUrl, placementOwner);
      if (!currentAdmission()) return true;
    } else if (raw.background === true || raw.active === false) {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
      if (!currentAdmission()) return true;
      discardProtectedTabs[key] = true;
      await persistLive();
      if (!currentAdmission()) return true;
    } else {
      await chrome.tabs.update(tab.id, { active: true });
      if (!currentAdmission()) return true;
    }
    if (!retarget) await chrome.tabs.reload(tab.id);
  } catch {
    // A missing receiver, changed tab or Chrome failure keeps the sole claimant untouched.
  }
  return true;
}

/**
 * Restores a command marker ChatGPT consumed from an exact app-owned empty root.
 *
 * The app advertises only commands that have reached explicit attention. Browser-session
 * provenance must independently prove that exactly one empty root still belongs to that exact
 * command. A named conversation, personal root, draft/busy document, duplicate claimant or an
 * incomplete inventory is never retargeted. The existing rearm owner performs the final fresh
 * tab/document proof and reload; this function contributes no second opening authority.
 */
async function rearmStrippedAttentionCommandRoots(tabs, attentionIds) {
  const attention = new Set((Array.isArray(attentionIds) ? attentionIds : [])
    .map(commandMarkerId).filter(Boolean));
  for (const id of attention) {
    const candidates = (Array.isArray(tabs) ? tabs : []).filter(tab => ownedCommandRootMarker(tab) === id);
    if (candidates.length !== 1) continue;
    const tab = candidates[0];
    if (commandRootMarkerForTab(tab) === id) continue;
    let model = null;
    let reasoningEffort = null;
    try {
      const url = new URL(tab.pendingUrl || tab.url || '');
      model = commandModelSlug(url.searchParams.get('model'));
      reasoningEffort = commandReasoningEffort(url.searchParams.get('reasoning_effort'));
    } catch { /* The final exact-root proof below rejects an unreadable URL. */ }
    await rearmExistingSuccessorRoot(id, {
      id,
      background: true,
      active: false,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    });
  }
}

async function placeSuccessorChat(raw, tabId, acceptance = null) {
  const currentAdmission = () => acceptance === null || acceptance() === true;
  if (!currentAdmission()) return;
  const id = commandMarkerId(raw && raw.id);
  if (!id) return;
  if (await rearmExistingSuccessorRoot(id, raw, currentAdmission)) return;
  if (!currentAdmission()) return;
  if (id && raw.background === true) {
    const marker = `clf=${encodeURIComponent(id)}`;
    const model = commandModelSlug(raw.model);
    const effort = commandReasoningEffort(raw.reasoningEffort);
    // A worker is an independent helper and starts at the neutral root. A restored Resume may
    // also be physically backgrounded, but retains its durable source/Project entry route.
    const base = raw.worker === true ? 'https://chatgpt.com/' : successorChatBase(raw.project, raw.homeConversationId);
    const projectMarker = base !== 'https://chatgpt.com/' ? '&clf_project=1' : '';
    const query = [`${marker}${projectMarker}`];
    if (model) query.push(`model=${encodeURIComponent(model)}`);
    if (effort) query.push(`reasoning_effort=${encodeURIComponent(effort)}`);
    // Background means inactive, not detached. Keep a worker/Resume beside the exact Prime that
    // owns it whenever that page is still present; a status-poll handout has no sender tab, so
    // recover the same parent from its durable conversation id before falling back to the normal
    // per-profile ChatGPT-window election.
    let preferredWindowId = null;
    if (typeof tabId === 'number') {
      try {
        const home = await chrome.tabs.get(tabId);
        if (!currentAdmission()) return;
        if (Number.isInteger(home?.windowId)) preferredWindowId = home.windowId;
      } catch { /* The home lookup below can still recover placement. */ }
    }
    if (!Number.isInteger(preferredWindowId)) {
      const conversationId = cleanConversationId(raw.homeConversationId);
      if (conversationId) {
        try {
          const tabs = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
          if (!currentAdmission()) return;
          const [home] = tabs.filter(tab => Number.isInteger(tab?.windowId) && conversationForTab(tab) === conversationId)
            .sort((a, b) => a.id - b.id);
          if (home) preferredWindowId = home.windowId;
        } catch { /* backgroundTabWindow() keeps this bounded to an existing normal window. */ }
      }
    }
    const created = await createChatTab(`${base}?${query.join('&')}#${marker}`, true, false, null, preferredWindowId, currentAdmission);
    if (!currentAdmission()) return;
    if (Number.isInteger(created?.id)) {
      await chrome.tabs.update(created.id, { autoDiscardable: false });
      if (!currentAdmission()) return;
      discardProtectedTabs[String(created.id)] = true;
      await persistLive();
      if (!currentAdmission()) return;
    }
    return;
  }
  if (typeof tabId !== 'number') {
    const conversationId = cleanConversationId(raw.homeConversationId);
    if (!conversationId) return;
    try {
      const tabs = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
      if (!currentAdmission()) return;
      tabId = tabs.filter(tab => conversationForTab(tab) === conversationId).sort((a, b) => a.id - b.id)[0]?.id;
    } catch { return; }
    if (typeof tabId !== 'number') return;
  }
  let home = null;
  try {
    home = await chrome.tabs.get(tabId);
    if (!currentAdmission()) return;
  } catch {
    // The polling tab closed between its request and this reply. Its operation has spent
    // opening authority, so the command deadline reports the unsuccessful placement.
    return;
  }
  if (!home || typeof home.windowId !== 'number') return;
  // Both a query and a fragment, matching the app's commandUrl(): ChatGPT rewrites its own URL
  // during boot and which of the two survives has changed between builds.
  const base = successorChatBase(raw.project, raw.homeConversationId);
  const marker = `clf=${encodeURIComponent(id)}${base !== 'https://chatgpt.com/' ? '&clf_project=1' : ''}`;
  const model = commandModelSlug(raw && raw.model);
  const reasoningEffort = commandReasoningEffort(raw && raw.reasoningEffort);
  const query = [marker];
  if (model) query.push(`model=${encodeURIComponent(model)}`);
  if (reasoningEffort) query.push(`reasoning_effort=${encodeURIComponent(reasoningEffort)}`);
  const url = `${base}?${query.join('&')}#${marker}`;
  // Directly after the chat it continues, so a handoff reads as one piece of work instead of a
  // tab appended to the far end of a long strip.
  try {
    const created = await createChatTab(url, false, raw.active !== false, null, home.windowId, currentAdmission,
      { index: Number.isInteger(home.index) ? home.index + 1 : null, owner: successorPlacementOwner(raw) });
    if (!currentAdmission()) return;
    if (raw.active === false && Number.isInteger(created?.id)) {
      await chrome.tabs.update(created.id, { autoDiscardable: false });
      if (!currentAdmission()) return;
      discardProtectedTabs[String(created.id)] = true;
      await persistLive();
      if (!currentAdmission()) return;
    }
  } catch {
    // Opening authority was spent. The command deadline reports an unsuccessful attempt.
  }
}

/** Accepts only the inert app command identity; the browser still decides the target tab. */
async function acceptBrowserRevival(raw, acceptance = null) {
  if (acceptance !== null && acceptance() !== true) return false;
  const id = deferredRevivalId(raw?.id);
  const conversationId = cleanConversationId(raw?.conversationId);
  if (!id || !conversationId) return false;
  const result = await rememberDeferredRevival(id, conversationId, false, acceptance);
  return (acceptance === null || acceptance() === true) && result === true;
}

/** Read the bounded batch, retaining compatibility with older apps that expose one wake. */
async function acceptBrowserRevivals(data, acceptance = null) {
  if (acceptance !== null && acceptance() !== true) return false;
  const list = Array.isArray(data?.revivals) ? data.revivals.slice(0, 16) : data?.revival ? [data.revival] : [];
  let accepted = false;
  for (const raw of list) {
    if (acceptance !== null && acceptance() !== true) return false;
    if (await acceptBrowserRevival(raw, acceptance)) accepted = true;
  }
  if (acceptance !== null && acceptance() !== true) return false;
  return accepted;
}

/**
 * Reconciles browser-persisted wake markers with the app before recovery can create a tab.
 *
 * The marker deliberately survives a browser restart, while the corresponding app command can
 * be cancelled, committed, superseded or retired during the same interval. Treating the marker
 * itself as proof of live work lets a dead id reopen its old ChatGPT conversation on every
 * browser startup. The app owns command truth, so ask it once for the whole bounded set and fail
 * closed on transport/version errors: keeping an inert marker for a later retry is harmless;
 * opening an unproven tab is not.
 */
/** One latest exact-page readiness snapshot on the existing command; no observer or retry owner. */
async function recordRevivalReadiness(id, conversationId, source) {
  if (!ownsDocument(source)) return;
  // A command id can be reused for a later wake. Capture its current incarnation before the
  // asynchronous page probe, then let Main reject turnover/claim/finish during that probe.
  const checked = await call('/commands/revivals/pending', {
    method: 'POST', body: JSON.stringify({ entries: [{ id, conversationId }], readiness: true })
  });
  const incarnation = checked.ok && Array.isArray(checked.data?.readiness)
    ? checked.data.readiness.find((entry) => entry?.id === id) : null;
  if (!Number.isSafeInteger(incarnation?.createdAt) || incarnation.createdAt <= 0 || !ownsDocument(source)) return;
  const page = await tabReply(source.tab, { type: 'clf-page-status' }, { documentId: source.documentId });
  if (!ownsDocument(source) || page?.ok !== true || cleanConversationId(page.conversationId) !== conversationId ||
      typeof page.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(page.runId)) return;
  const proof = page.revivalReadiness;
  const reasons = new Set(['recorder-starting', 'recorder-generating', 'native-generating', 'tools-pending',
    'native-busy', 'goal-busy', 'input-busy', 'composer-draft', 'composer-unavailable', 'durable-events']);
  if (!proof || proof.id !== id || proof.conversationId !== conversationId || proof.phase !== 'waiting' ||
      !Number.isSafeInteger(proof.waitingSince) || proof.waitingSince < incarnation.createdAt ||
      proof.waitingSince > Date.now() ||
      !Array.isArray(proof.blockedBy) || proof.blockedBy.length > reasons.size ||
      !proof.blockedBy.every((reason) => reasons.has(reason))) return;
  await call('/commands/revivals/pending', {
    method: 'POST', body: JSON.stringify({ entries: [{ id, conversationId, readiness: {
      createdAt: incarnation.createdAt, tab: source.tab, documentId: source.documentId,
      navigationEpoch: source.navigationEpoch, client: page.runId, waitingSince: proof.waitingSince,
      observedAt: Date.now(), blockedBy: [...new Set(proof.blockedBy)]
    } }] })
  });
}

async function reconcileDeferredRevivalsWithApp() {
  if (deferredRevivals.length === 0) return new Map();
  const entries = deferredRevivals
    .map((entry) => ({ id: deferredRevivalId(entry?.id), conversationId: cleanConversationId(entry?.conversationId) }))
    .filter((entry) => entry.id && entry.conversationId)
    .slice(-100);
  const result = await call('/commands/revivals/pending', {
    method: 'POST',
    body: JSON.stringify({ entries })
  });
  if (!result.ok || !Array.isArray(result.data?.pending)) return null;

  const pending = new Set(result.data.pending.filter((id) => typeof id === 'string'));
  const placements = new Map();
  for (const raw of Array.isArray(result.data?.placements) ? result.data.placements : []) {
    const id = deferredRevivalId(raw?.id);
    if (!id || !pending.has(id)) continue;
    const homeConversationId = cleanConversationId(raw?.homeConversationId);
    const background = raw?.background === true;
    if (!background && !homeConversationId) continue;
    placements.set(id, { homeConversationId, background });
  }
  const before = deferredRevivals.length;
  deferredRevivals = deferredRevivals.filter((entry) => pending.has(entry?.id));
  if (deferredRevivals.length !== before) {
    pruneDeferredRevivalOffers();
    await persistLive();
  }
  return placements;
}

/**
 * Re-presents deferred revival markers after MV3/document/browser lifetime loss.
 *
 * There is deliberately no command text here and no local "sent" decision. An existing exact
 * conversation gets first chance to install the content-side readiness waiter. A marked exact
 * chat is created only after the app confirms a live command and the scan proves absence.
 * Either path still has to win `/commands/redeem`, so several recovery
 * triggers cannot duplicate or cross-deliver text.
 */
function recoverDeferredRevivals() {
  if (deferredRecoveryWork) return deferredRecoveryWork;
  const work = (async () => {
    await load();
    // A durable terminal page result supersedes its pre-send recovery marker. This matters on a
    // browser restart between ChatGPT accepting the message and the app accepting the ACK.
    const ackIds = new Set(commandAckOutbox.map((entry) => deferredRevivalId(entry?.id)).filter(Boolean));
    const before = deferredRevivals.length;
    deferredRevivals = deferredRevivals.filter(
      (entry) => deferredRevivalId(entry?.id) && cleanConversationId(entry?.conversationId) && !ackIds.has(entry.id)
    );
    if (deferredRevivals.length !== before) {
      pruneDeferredRevivalOffers();
      await persistLive();
    }
    if (deferredRevivals.length === 0) return;

    const placements = await reconcileDeferredRevivalsWithApp();
    if (!placements || deferredRevivals.length === 0) return;

    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
    } catch {
      return;
    }

    for (const entry of [...deferredRevivals]) {
      const exact = tabs
        .filter((tab) => tab && typeof tab.id === 'number' && conversationForTab(tab) === entry.conversationId)
        .sort((a, b) => a.id - b.id);
      const placement = placements.get(entry.id) || null;
      let homeWindowId = null;
      if (!exact.length) {
        if (entry.openingSpent || !placement) continue;
        const [home] = tabs
          .filter((tab) => tab && typeof tab.id === 'number' && Number.isInteger(tab.windowId) &&
            conversationForTab(tab) === placement.homeConversationId)
          .sort((a, b) => a.id - b.id);
        if (home && Number.isInteger(home.windowId)) homeWindowId = home.windowId;
        if (placement.background !== true && !Number.isInteger(homeWindowId)) continue;
      }
      if (!entry.openingSpent) {
        entry.openingSpent = true;
        await persistLive();
      }
      let routed = false;
      for (const tab of exact) {
        if (await restoreChatgptTab(tab.id)) {
          offerDeferredRevivalToTab(entry, tab);
          routed = true;
          break;
        }
      }
      // A failed receiver/injection is not proof that its tab is absent. Keep the exact
      // conversation as the only target, including complete but temporarily inaccessible pages.
      if (routed || exact.length) continue;

      const url = deferredRevivalUrl(entry);
      if (!url) continue;
      try {
        // A worker revival is background work; do not select its tab in the user's window.
        const created = await createChatTab(url, true, false, null, homeWindowId);
        if (created && typeof created.id === 'number') {
          tabs.push({ ...created, url });
        }
      } catch {
        // Opening authority stays spent even if Chrome rejects creation. The app's command
        // deadline reports failure; a browser/service-worker restart cannot mint another tab.
      }
    }
  })();
  const tracked = work.finally(() => {
    if (deferredRecoveryWork === tracked) deferredRecoveryWork = null;
  });
  deferredRecoveryWork = tracked;
  return tracked;
}

async function restoreChatgptTab(id) {
  try {
    const missing = {};
    const live = await tabReply(id, { type: 'clf-recorder-ping' }, undefined, 3000, missing);
    // A nonresponsive page is unknown, unlike a rejected missing receiver. Never replace
    // its possibly live operation just because the bounded observation wait elapsed.
    if (live !== missing && live?.ok !== true) return false;
    if (live && live.ok === true && live.recorderVersion === PAGE_RECORDER_VERSION && live.freshTurnProtocol === 1 &&
        live.requiredFeatures?.promptEnvelope === true && live.requiredFeatures?.nativeAllowOnce === true) {
      // Healthy content.js does not prove the independently running MAIN-world helper is
      // still present. Request-id ownership depends on fiber.js, and re-executing it is
      // idempotent because the helper keeps one listener per protocol version.
      try {
        await chrome.scripting.executeScript({ target: { tabId: id }, world: 'MAIN', files: ['fiber.js'] });
      } catch {
        // The tab can navigate between the ping and repair. Static injection covers it.
      }
      return true;
    }
    if (live?.ok === true) {
      // Replacing an old healthy observer must not cancel an app-owned operation or a
      // native stream. Unknown state is not idle; the exact queued input waits instead.
      const state = await tabReply(id, { type: 'clf-page-status' });
      if (state?.ok !== true || state.streaming !== false || state.generating !== false || state.pendingTools !== 0 ||
          state.jobBusy !== false || state.goalBusy !== false || state.projectCreateBusy !== false ||
          state.pluginRefreshBusy !== false || state.modelCatalogBusy !== false || state.desktopInputBusy !== false) return false;
    }
  } catch {
    // No receiver is the expected signature of an already-open tab whose isolated world
    // was invalidated by an extension reload. Fall through to deterministic recovery.
  }
  try {
    // Keep the React/Fiber reader in ChatGPT's own world, exactly like the static manifest
    // declaration. An older helper may still answer too; the nonce/version gate in
    // content.js makes those replies harmless, and a future version bump rejects them.
    await chrome.scripting.executeScript({ target: { tabId: id }, world: 'MAIN', files: ['fiber.js'] });
    // One ordered isolated-world injection binds the adapter and recorder to the
    // same native document. Separate awaited calls can cross a real navigation.
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['chatgpt-dom.js', 'content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId: id }, files: ['overlay.css'] });
    // Successful injection means this exact tab is recovering. Its document registration will
    // re-run revival routing; opening a second tab during that handoff recreates the race.
    return true;
  } catch {
    // Injection failure does not transfer ownership to a replacement tab.
    return false;
  }
}

/**
 * Replaces the MAIN-world usage/request observer in an already-open tab after an extension
 * update. Disposal can cancel a cloned stream reader, so replacement waits for positive page
 * evidence that no response is streaming. Busy or temporarily silent pages are retried with a
 * bounded timer and are never reloaded merely to install the observer.
 */
const USAGE_REPLACE_RETRY_MS = 20_000;
const USAGE_REPLACE_ATTEMPTS = 90;
async function replaceUsageObserver(tabId, attempt = 0) {
  const later = () => {
    if (attempt + 1 < USAGE_REPLACE_ATTEMPTS) {
      setTimeout(() => { void replaceUsageObserver(tabId, attempt + 1); }, USAGE_REPLACE_RETRY_MS);
    }
    return false;
  };
  let status = null;
  try { status = await tabReply(tabId, { type: 'clf-page-status' }); } catch { status = null; }
  if (status?.ok !== true || status.streaming !== false) return later();
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { window.__cosUsageReplace = true; } });
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['usage.js'] });
    return true;
  } catch {
    // A closed/navigated tab receives a fresh static observer in its next document.
    return false;
  }
}

async function restoreOpenChatgptTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: CHATGPT_TAB_URLS });
  } catch {
    return;
  }
  for (const tab of tabs) {
    const id = tab && typeof tab.id === 'number' ? tab.id : null;
    if (id === null) continue;
    await restoreChatgptTab(id);
    void replaceUsageObserver(id);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void restoreOpenChatgptTabs().then(() => recoverDeferredRevivals()).catch(() => undefined);
  void load()
    .then(() => ensurePaired())
    .catch(() => undefined)
    .then(() => scheduleRetry());
});

if (chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === 'function') {
  chrome.runtime.onStartup.addListener(() => {
    void load()
      .then(() => drainCommandAcks())
      .then(() => drain())
      .then(() => drainCloses())
      .then(() => recoverDeferredRevivals())
      // The browser just came back; the app may have been waiting the whole time it was gone.
      .then(() => maintain())
      .catch(() => undefined)
      .then(() => scheduleRetry());
  });
}

if (chrome.alarms && chrome.alarms.onAlarm && typeof chrome.alarms.onAlarm.addListener === 'function') {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== RETRY_ALARM) return;
    void drainCommandAcks()
      .then(() => drain())
      .then(() => drainCloses())
      // If document registration already owns the maintenance flight, the alarm still asks
      // for one fresh pass afterward instead of disappearing into that older snapshot.
      .then(() => maintain(true))
      .catch(() => undefined)
      .then(() => {
        // Re-armed here and nowhere else. Every other caller of scheduleRetry() finds the
        // alarm already standing and leaves it alone, which is what keeps a burst of failing
        // requests from pushing the next pass further and further away.
        retryAlarmScheduled = false;
        scheduleRetry();
      });
  });
}

// `chrome://extensions` Reload does not provide a dependable install/update event across
// development/reload paths. The service worker itself *must* start, though. Ping first, so
// ordinary worker wake-ups are one cheap message per ChatGPT tab and inject nothing; only a
// dead or stale recorder pays the scripting cost.
void restoreOpenChatgptTabs().then(() => recoverDeferredRevivals()).catch(() => undefined);
void load()
  .then(() => ensurePaired())
  .catch(() => undefined)
  .then(() => scheduleRetry());

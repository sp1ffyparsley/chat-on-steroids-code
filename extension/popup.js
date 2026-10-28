/**
 * Status UI, and the one place that answers "where did the stream stop?".
 *
 * Current-turn request evidence is distinct from whole-chat recording counters.
 * "Reaching the app" separates finding the ID, app receipt and exact owner confirmation;
 * only the activity feed can additionally prove a matching tool invocation was recorded.
 *
 * It opens itself when something is wrong and stays shut when nothing is, because a panel
 * that is always expanded is a panel nobody reads.
 */

const $ = (id) => document.getElementById(id);
const RENDER_STREAM_KEY = 'renderStreamEnabled';
const ACCOUNT_CHOICE_KEY = 'popupAccountChoiceInstanceId';
const DEBUG_CAPTURE_KEY = 'browserDebugScreenshots';
let debugCaptureEnabled = false;
let debugCaptureRevision = 0;
const POLL_MS = 1500;

let overwriteEnabled = true;
let latest = { status: null, tab: null, statusUnavailable: true, tabUnavailable: true };
let openedOnFailure = false;
let availableAccounts = [];
let accountConnecting = false;
let refreshGeneration = 0;
// This is only the popup's draft choice. Status and explicit pairTo remain pairing authority.
let accountChoice = '';
let accountChoiceRevision = 0;
let accountChoiceWrite = Promise.resolve();
let accountChoiceError = '';
let reloadError = '';

const RELOAD_PENDING_WORK_REASONS = Object.freeze({
  reload: { label: 'another reload check', action: 'Wait for that existing check to settle; do not repeat the consumed recovery nonce automatically.' },
  openChatgptTabs: { label: 'ChatGPT tabs still open', action: 'The worker cannot prove page-level quiescence. Finish and save any work, drafts or attachments, then close those tabs and retry.' },
  documentUnverified: { label: 'ChatGPT document state unverified', action: 'Keep the affected tabs open and retry after the existing document proof is available.' },
  pageWorkUnverified: { label: 'ChatGPT page work unverified', action: 'Keep the affected tabs and their work intact; retry after page work can be checked.' },
  inventoryChanged: { label: 'ChatGPT tab inventory changed during the check', action: 'Let navigation and tab changes settle, then retry to obtain a fresh inventory.' },
  inventoryUnverified: { label: 'browser tab inventory unavailable', action: 'Keep tabs and work intact; retry after Chrome inventory can be read reliably.' },
  connectionChanged: { label: 'account or connection changed during the check', action: 'Let the current account transition settle, verify the selected account, then retry.' },
  custodyChanged: { label: 'retained ownership changed during the check', action: 'Let the existing owner settle and obtain a fresh custody check before retrying.' },
  leaseDurabilityUnverified: { label: 'command lease durability unverified', action: 'Keep the companion open and retry after its existing durable lease check succeeds; do not clear leases.' },
  ownerReadFailed: { label: 'retained owner read failed', action: 'Check companion storage health and retry after the owner can be read; a failed read does not mean no owner exists.' },
  ownerReadTimedOut: { label: 'retained owner read timed out', action: 'Wait for storage/owner reads to recover, then retry; a timeout does not mean custody is empty.' },
  custodyCheckFailed: { label: 'reload custody check failed', action: 'Keep saved work intact and retry only after the existing custody check can complete.' },
  unverified: { label: 'reload safety could not be verified', action: 'Keep the companion and saved work intact; check its current status before a deliberate retry.' },
  journal: { label: 'saved observation journal entries', action: 'Keep the app connected and let the existing journal drain before retrying.' },
  journalWorkers: { label: 'journal delivery workers', action: 'Let the existing journal delivery workers finish; do not clear or duplicate their work.' },
  closeOutbox: { label: 'pending chat-close receipts', action: 'Allow normal close-receipt delivery to settle; do not clear the outbox.' },
  commandAckOutbox: { label: 'pending command delivery receipts', action: 'Allow normal command receipt delivery to settle; do not replay the command.' },
  deferredRevivals: { label: 'saved worker revivals', action: 'Let the incumbent revival owner settle; do not start a second revival or clear the saved row.' },
  retiredHelperElections: { label: 'retired helper elections still retained', action: 'This is a subset of message-opening leases. Let the existing archive and retirement owner settle; the count grants no permission to close a tab or clear custody.' },
  inputOpenings: { label: 'message-opening leases', action: 'Let the existing input-opening owner settle; do not resend the input or open a duplicate conversation.' },
  stopOpenings: { label: 'Stop-opening leases', action: 'Let the existing Stop owner and receipt settle; do not repeat or clear the Stop action.' },
  commandTabLeases: { label: 'command-tab leases', action: 'Wait for the existing lease owner and durability check to settle; do not clear the lease.' },
  maintenanceFlight: { label: 'account maintenance operation', action: 'Let the current maintenance pass finish, then retry.' },
  modelCatalogFlight: { label: 'model catalog inspection in progress', action: 'Let the current model inspection finish, then retry.' },
  pluginRefreshFlight: { label: 'connector refresh in progress', action: 'Let the current connector refresh finish, then retry.' },
  projectCreateFlight: { label: 'project creation in progress', action: 'Let the current project creation operation finish, then retry.' },
  deferredRecoveryWork: { label: 'deferred worker recovery work', action: 'Let the incumbent recovery owner settle; do not launch a duplicate recovery.' },
  tabOperations: { label: 'tab operations in progress', action: 'Let the existing tab-operation queue drain, then retry.' },
  pendingInputReceipts: { label: 'pending input receipts', action: 'Allow normal input-receipt reconciliation; do not resend input or clear a receipt.' },
  pairing: { label: 'account pairing in progress', action: 'Let pairing settle before retrying; do not change accounts during this check.' },
  commandDelivery: { label: 'command delivery in progress', action: 'Allow the current command delivery acknowledgement to settle.' },
  closeDelivery: { label: 'chat-close delivery in progress', action: 'Allow the current close-receipt delivery to settle.' },
  journalInFlight: { label: 'journal writes in flight', action: 'Wait for the current durable journal write to finish.' },
  browserCapture: { label: 'browser capture in progress', action: 'Let the existing capture finish; do not start another capture to clear the hold.' },
  backgroundWindow: { label: 'background-window operation in progress', action: 'Let the existing window-placement operation finish.' },
  tabRetirement: { label: 'tab retirement in progress', action: 'Wait for the existing retirement receipt and safety check; do not close tabs based on popup counts.' },
  openConversation: { label: 'conversation opening request in progress', action: 'Let the incumbent opening request settle; do not start a duplicate open or reload.' },
  browserControl: { label: 'browser-control lease active', action: 'Finish through the existing browser-control owner and let it release the lease; do not force-close or revoke it here.' },
  browserControlFlight: { label: 'browser-control operation in flight', action: 'Let the current operation finish and its owner release the lease before retrying.' },
  urgentOpen: { label: 'urgent conversation opening in progress', action: 'Wait for that existing opening owner to settle; do not open a duplicate conversation.' },
  tabCloseReceipts: { label: 'retained tab-close receipts', action: 'Allow normal receipt and journal delivery to settle; do not clear the receipts.' },
  receiverRepair: { label: 'desktop input receiver repair in progress', action: 'Let the existing receiver repair settle; do not create a second repair.' },
  stopOffers: { label: 'pending Stop offers', action: 'Wait for the exact existing Stop owner and receipt to settle; do not repeat the action.' },
  projectCreateOwner: { label: 'retained project-creation custody', action: 'Wait for the incumbent project-creation owner to settle; do not clear its custody.' },
  pluginRefreshOwner: { label: 'retained connector-refresh custody', action: 'Wait for the incumbent connector-refresh owner to settle; do not clear its custody.' },
  modelCatalogOwner: { label: 'retained model-inspection custody', action: 'Wait for the incumbent model-inspection owner to settle; do not clear its custody.' },
  streaming: { label: 'native stream in progress', action: 'Let the existing native turn settle; page idleness and a popup count do not authorize a reload.' },
  generating: { label: 'native generation in progress', action: 'Wait for the current native generation to finish or be handled by its existing owner.' },
  pendingTools: { label: 'native tools in progress', action: 'Let the current tool calls settle through their existing owners; do not interrupt or replay them here.' },
  jobBusy: { label: 'message delivery in progress', action: 'Let the existing message delivery and its receipt settle; do not send it again.' },
  goalBusy: { label: 'Goal/Loop operation in progress', action: 'Let the existing Goal/Loop owner finish its current operation; do not start another turn.' },
  queued: { label: 'queued page operation', action: 'Let the existing page-operation queue settle and then retry.' },
  projectCreateBusy: { label: 'native project creation in progress', action: 'Let the existing native project-creation owner settle.' },
  pluginRefreshBusy: { label: 'native connector refresh in progress', action: 'Let the existing native connector-refresh owner settle.' },
  modelCatalogBusy: { label: 'native model inspection in progress', action: 'Let the existing native model-inspection owner settle.' },
  desktopInputBusy: { label: 'native input delivery in progress', action: 'Let the existing native input delivery and its receipt settle; do not resend it.' }
});
function reloadPendingWorkReasonKeys() { return Object.keys(RELOAD_PENDING_WORK_REASONS); }

function reloadPageContext(snapshot = latest) {
  const notes = [];
  const status = snapshot?.status;
  const info = snapshot?.tab;
  if (!snapshot || snapshot.statusUnavailable || !status) {
    notes.push('The companion worker status reply is unavailable; this does not prove the extension is absent or identify its loaded version.');
  } else if (status.disconnected === true) {
    notes.push('The companion worker responded and reports the desktop app disconnected; reconnect through the existing app flow before retrying.');
  } else if (status.connected !== true) {
    notes.push('The companion worker responded, but the desktop app is not reachable; check the app connection before retrying.');
  }
  if (!snapshot || snapshot.tabUnavailable || !info) {
    notes.push('The selected-tab ChatGPT state is unavailable; do not infer that no page is selected or that its recorder is idle.');
  } else if (info.isChat !== true) {
    notes.push('No ChatGPT page is selected in this popup tab. That is separate from extension presence and from browser-wide ChatGPT tabs or retained work checked by the worker.');
  } else if (!info.page) {
    notes.push('A ChatGPT page is selected, but recorder/page evidence is not attached; page idleness is unverified.');
  } else {
    notes.push('Even if the selected page looks idle, retained delivery/helper custody and the worker-wide reload gate are separate checks.');
  }
  return notes.join(' ');
}

function reloadDeferredReason(reply, snapshot = latest) {
  if (reply?.error === 'unknown_message') {
    return `The worker did not recognize the reload request; an older or mismatched worker is possible. Its loaded version and retained-work state are unverified. Keep this tab and saved work intact, check the existing companion version/status, then retry deliberately. ${reloadPageContext(snapshot)}`;
  }

  const pending = reply?.pendingWork;
  const reasons = [];
  if (pending && typeof pending === 'object' && !Array.isArray(pending)) {
    let keys = [];
    try { keys = Object.keys(pending); } catch { /* Treat an unreadable response as unknown custody. */ }
    for (const key of keys) {
      let value;
      try { value = pending[key]; } catch { value = undefined; }
      const known = Object.prototype.hasOwnProperty.call(RELOAD_PENDING_WORK_REASONS, key);
      const reason = known ? RELOAD_PENDING_WORK_REASONS[key] : null;
      if (reason && Number.isSafeInteger(value) && value <= 0) continue;
      const count = Number.isSafeInteger(value) && value > 0 ? Math.min(4000, value) : null;
      if (reason) {
        reasons.push(`${reason.label} (${count === null ? 'count unavailable' : count}). ${reason.action}`);
      } else {
        const safeKey = String(key).replace(/[^a-zA-Z0-9_.-]/g, '?').slice(0, 48) || '(empty key)';
        const reported = Number.isSafeInteger(value) && value >= 0 ? Math.min(4000, value) : null;
        reasons.push(`Unrecognized worker key "${safeKey}" (${reported === null ? 'count unavailable' : reported}). Its meaning is unknown; preserve saved work and check the current companion version and ownership before retrying.`);
      }
    }
  }
  if (!reasons.length) {
    reasons.push('The worker deferred reload but supplied no usable pending-work details. This can mean an older worker or an incomplete response; preserve saved work and check the current companion version and ownership before retrying.');
  }
  return `${reasons.join(' ')} ${reloadPageContext(snapshot)}`.trim();
}

async function requestCompanionReload() {
  const button = $('reloadBtn');
  if (button.disabled) return;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Checking saved work…';
  reloadError = '';
  paintAlert(latest.status, latest.tab);
  let requested = false;
  try {
    // Preference persistence is not delivery custody. Only the worker can drain its journals
    // and check every current document immediately before it destroys its own session store.
    let pending;
    do { pending = accountChoiceWrite; await pending; } while (pending !== accountChoiceWrite);
    // Spend the existing one-shot marker before asking the worker to destroy its channel.
    // A missing response can be teardown, not a refusal or proof that the new build loaded.
    sessionStorage.setItem(RECOVERY_RELOAD_KEY, 'attempted');
    requested = true;
    const reply = await chrome.runtime.sendMessage({ type: 'reloadCompanion' });
    reloadError = reply?.ok === false && reply?.error === 'reload_deferred'
      ? `Reload deferred; saved work remains retained. ${reloadDeferredReason(reply)}`
      : reply?.ok === true && reply?.reloading === true
        ? 'Reload accepted by the worker; the loaded build is still unverified. Reopen the companion to check its status. This recovery tab has not been closed.'
        : reply?.error === 'unknown_message'
          ? `Reload outcome unknown. ${reloadDeferredReason(reply)}`
          : 'Reload outcome unknown; the worker response did not confirm a deferred or accepted reload. The loaded build and retained-work state are unverified. Keep this tab and saved work intact, then check companion status before retrying.';
    paintAlert(latest.status, latest.tab);
  } catch {
    reloadError = requested
      ? 'Reload outcome unknown; the request was issued to the worker but its response channel closed or failed. Whether it acted and which build is loaded are unverified. No fallback reload was issued; keep this tab and saved work intact and check status before retrying.'
      : 'Reload deferred; the request was not issued because its local marker could not be saved. Saved work remains retained.';
    paintAlert(latest.status, latest.tab);
    console.warn('[Chat On Steroids] companion reload outcome unconfirmed; no fallback reload was issued');
  } finally { button.disabled = false; button.textContent = label; }
}

// The unpacked companion can outlive a desktop-app update in Chrome's extension cache.
// Keep one explicit, local extension-page recovery route beside the visible button so the
// installer/support workflow can reload the companion without closing Chrome or its tabs.
// Ordinary popup opens have no marker and never reload themselves.
const recoveryUrl = new URL(location.href);
const RECOVERY_RELOAD_PREFIX = 'clf-reload-spent:';
const RECOVERY_RELOAD_KEY = `${RECOVERY_RELOAD_PREFIX}${recoveryUrl.searchParams.get('nonce') || 'manual'}`;
if (recoveryUrl.searchParams.get('clf-reload') === '1' && !sessionStorage.getItem(RECOVERY_RELOAD_KEY)) {
  // Spend the marker before invalidating this extension context. Chrome keeps an ordinary
  // extension page open across reloads; retaining the query there would create a reload loop.
  sessionStorage.setItem(RECOVERY_RELOAD_KEY, 'attempted');
  recoveryUrl.searchParams.delete('clf-reload');
  try { history.replaceState(history.state, '', recoveryUrl.href); } catch { /* sessionStorage is the fallback fence. */ }
  void requestCompanionReload();
} else if (recoveryUrl.searchParams.get('clf-reload') !== '1') {
  // The marker has been consumed and the extension survived its one reload. Clear old build
  // nonces so this tab can be reused for a later desktop update without accumulating state.
  for (let index = sessionStorage.length - 1; index >= 0; index--) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(RECOVERY_RELOAD_PREFIX) && key !== RECOVERY_RELOAD_KEY) sessionStorage.removeItem(key);
  }
  // A teardown-channel response is not loaded-build proof. Retain this existing support tab
  // rather than silently close it or retry the nonce when activation has not been observed.
}

// ------------------------------------------------------------------ formatting

/** Ids are long and only their ends identify them, so keep both ends rather than one. */
function shorten(value, keep = 6) {
  const text = String(value || '');
  if (text.length <= keep + 5) return text;
  return `${text.slice(0, keep)}…${text.slice(-4)}`;
}

function ago(at) {
  if (!at) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** One capture row: ok, no, wait or off, plus whatever it wants to say on the right. */
function row(name, state, meta) {
  $(`r-${name}`).className = `row ${state}`;
  const value = $(`d-${name}`);
  value.textContent = meta === null || meta === undefined ? '' : meta;
}

function idRow(name, state, meta, full) {
  row(name, state, meta);
  const value = $(`d-${name}`);
  value.title = full || '';
  value.disabled = !full;
}

function stage(name, state, meta) {
  $(`s-${name}`).className = `stage ${state}`;
  $(`n-${name}`).textContent = meta || '';
}

/** Loaded-document evidence only. A ready handler does not prove a card was approved. */
function paintNativeApproval(info, ready) {
  const health = info?.page?.nativeApproval;
  let state = 'wait', label = 'checking', explanation;
  if (!info) {
    explanation = 'Approval status is unavailable. Keep the companion and app connected.';
  } else if (!info.isChat) {
    state = 'off'; label = 'no chat selected';
    explanation = 'Open this companion from a ChatGPT chat to check its loaded approval handler.';
  } else if (!info.recorder || !info.page || health?.protocol !== 1) {
    state = 'no'; label = 'needs repair';
    explanation = 'Approval handler not confirmed in this tab. Recovery waits for work to settle; installed files alone do not confirm activation.';
  } else if (health.state === 'paused') {
    state = 'off'; label = 'paused in CoS';
    explanation = 'This chat has a loaded approval handler. CoS automation is paused.';
  } else if (!ready) {
    label = 'waiting for app';
    explanation = 'The approval handler is loaded. Reconnect the app to confirm current automation policy.';
  } else if (health.state === 'ready') {
    state = 'ok'; label = 'ready';
    explanation = 'Allow-once is ready, including in hidden tabs. Persistent or unclear permissions need attention.';
  } else if (health.state === 'policy-unverified') {
    label = 'waiting for policy';
    explanation = 'The approval handler is loaded. Waiting for fresh policy for this exact chat from CoS.';
  } else if (health.state === 'route-unverified') {
    label = 'waiting for chat';
    explanation = 'The approval handler is loaded. Waiting for the current chat identity.';
  } else {
    state = 'no'; label = 'needs attention';
    explanation = 'Approval health could not be confirmed. Inspect the native card and companion connection; current work remains retained.';
  }
  const output = $('approvalStatus');
  const message = `Native approvals: ${label}. ${explanation}`;
  output.dataset.health = state;
  if (output.textContent !== message) output.textContent = message;
}

// -------------------------------------------------------------------- pipeline

/** How the app describes what it placed a call on, in its own words. */
const ATTRIBUTION = {
  request_id: 'exact request id',
  unattributed: 'request id not resolved',
  agent: 'agent key',
  turn: 'tool block on the page',
  generation: 'the only chat generating',
  inferred: 'not placed in a chat'
};

/**
 * The three stages, from evidence each layer produced independently.
 *
 * Global transport failures explain a blocked path. Success needs this chat's session
 * receipt and exact evidence projected from its newest native turn. Queue custody and
 * owner acknowledgement do not claim a matching MCP invocation has run.
 */
function pipeline(info, ready) {
  const page = info && info.page;
  const sent = info && info.delivery;
  const pending = info ? info.pending : 0;
  const read = page ? page.events : 0;
  const calls = page && Array.isArray(page.trace) ? page.trace : [];

  if (!info || !info.isChat) return { read: ['off'], sent: ['off'], proc: ['off'], why: ['', ''] };
  if (!info.recorder) {
    return { read: ['failed'], sent: ['off'], proc: ['off'], why: ['bad', 'No recorder in this tab. Reload the page.'] };
  }
  if (read === 0) {
    return { read: ['running'], sent: ['off'], proc: ['off'], why: ['', 'Waiting for the first message.'] };
  }

  const readStage = calls.length ? ['done', String(calls.length)] : ['running'];
  if (!ready) {
    return {
      read: readStage,
      sent: ['failed', pending ? `${pending} held` : ''],
      proc: ['off'],
      why: ['bad', 'Delivery is blocked until the app is connected and protocol compatibility is confirmed.']
    };
  }
  if (sent && sent.ok === false) {
    return {
      read: readStage,
      sent: ['failed', String(sent.error || 'failed')],
      proc: ['off'],
      why: ['bad', `The app rejected the last delivery (${sent.error || 'failed'}).`]
    };
  }
  // Refused by the extension itself, before anything could be queued for the app. `pending`
  // counts only what the service worker already owns, so a document it is rejecting outright
  // reported nothing pending and this drawer went on to say "Delivered" — which is what it
  // said all through the 2026-08-21 blackout while the tab was reading ChatGPT perfectly and
  // sending none of it. The page is the only layer that knows, so it is the layer that says so.
  if (page.blocked) {
    return {
      read: readStage,
      sent: ['failed', page.queued ? `${page.queued} held in page` : String(page.blocked)],
      proc: ['off'],
      why: [
        'bad',
        'The extension is not accepting this tab’s observations (' +
          String(page.blocked) +
          '). Reload the ChatGPT tab.'
      ]
    };
  }
  if (pending > 0) {
    return {
      read: readStage,
      sent: ['running', `${pending} queued`],
      proc: ['off'],
      why: ['', 'Queued here. Retrying delivery to the app.']
    };
  }

  if (!page.session) {
    return {
      read: readStage,
      sent: ['running'],
      proc: ['running'],
      // The worker's delivery counters cover every tab. Only the page's session
      // receipt proves that this particular chat reached the app.
      why: ['', 'App reachable. Waiting for this chat’s session receipt.']
    };
  }
  if (!calls.length) return {
    read: ['running'], sent: ['off'], proc: ['off'],
    why: ['', 'Chat recorded. Waiting for a request ID from the latest turn.']
  };
  const received = calls.filter(call => call.sent || call.app === 'request_id').length;
  const confirmed = calls.filter(call => call.confirmed || call.app === 'request_id').length;
  const sentStage = [received === calls.length ? 'done' : 'running', `${received}/${calls.length}`];
  const placed = calls.filter((call) => call.app === 'request_id').length;
  const missed = calls.filter((call) => call.app && call.app !== 'request_id');
  if (missed.length > 0) {
    return {
      read: readStage,
      sent: sentStage,
      proc: ['failed', `${placed}/${calls.length}`],
      why: [
        'bad',
        `The app could not place ${missed.length === 1 ? 'a call' : `${missed.length} calls`} by request id — it fell back to ${ATTRIBUTION[missed[0].app] || missed[0].app}.`
      ]
    };
  }
  return {
    read: ['done', String(calls.length)],
    sent: sentStage,
    proc: [confirmed === calls.length ? 'done' : 'running', `${confirmed}/${calls.length}`],
    why: ['', placed > 0 ? `${placed} request ID${placed === 1 ? '' : 's'} matched to recorded tool activity.`
      : confirmed > 0 ? 'Request owner confirmed. No matching tool activity recorded yet.'
        : received > 0 ? 'App received the ID. Waiting for owner confirmation.'
          : 'ID found in the latest turn. Waiting for the app to confirm receipt.']
  };
}

/** One row per request id: three dots, the tool, the id. Newest first. */
function paintCalls(page) {
  const box = $('calls');
  box.textContent = '';
  const rows = page && Array.isArray(page.trace) ? page.trace.slice(0, 5) : [];
  for (const entry of rows) {
    const line = document.createElement('div');
    line.className = 'call';
    const pips = document.createElement('span');
    pips.className = 'pips';
    for (const state of [
      entry.read ? 'on' : '',
      entry.sent || entry.app === 'request_id' ? 'on' : '',
      entry.confirmed || entry.app === 'request_id' ? 'on' : entry.app ? 'bad' : ''
    ]) {
      const pip = document.createElement('span');
      pip.className = `pip ${state}`;
      pips.append(pip);
    }
    const tool = document.createElement('span');
    tool.className = 'tool';
    tool.textContent = entry.tool || 'request ID';
    const id = document.createElement('span');
    id.className = 'id';
    id.textContent = shorten(entry.requestId, 5);
    line.title = `${entry.requestId} — found ${entry.read ? 'yes' : 'no'} · app receipt ${entry.sent || entry.app === 'request_id' ? 'confirmed' : 'pending'} · owner ${entry.confirmed ? 'confirmed' : 'pending'} · tool activity ${ATTRIBUTION[entry.app] || 'no record'}`;
    line.append(pips, tool, id);
    box.append(line);
  }
}

// ------------------------------------------------------------------- rendering

function paintHeader(status, statusUnavailable = false) {
  const unavailable = statusUnavailable || !status || typeof status !== 'object' || Array.isArray(status) || typeof status.connected !== 'boolean';
  const connected = !unavailable && status.connected === true;
  const paired = !unavailable && status.paired === true;
  const incompatible = connected && status.compatible === false;
  // Disconnected on purpose. This has to say so plainly rather than describing it as a
  // connection that has not finished yet, which is what it looked like back when the next
  // poll would silently undo it.
  const off = !unavailable && status.disconnected === true && !paired;
  const ready = connected && paired && status.compatible === true;

  $('pill').className = `pill ${ready ? '' : incompatible || unavailable ? 'bad' : 'off'}`;
  $('state').textContent = unavailable
    ? 'Companion status unavailable'
    : incompatible
    ? 'Version mismatch'
    : status?.instanceError === 'instance_selection_required'
      ? 'Choose COS account'
    : off
      ? 'Disconnected'
      : !connected
        ? 'App not reachable'
        : ready
          // Health + pairing prove reachability, not the recorder/command flow.
          ? `App reachable · Port ${status.port}`
          : `Port ${status.port} · connecting`;

  $('retryBtn').hidden = ready || incompatible || status?.instanceError === 'instance_selection_required';
  $('retryBtn').textContent = off ? 'Connect' : 'Try again';
  $('unpairBtn').hidden = !paired || incompatible;
  return ready;
}

function paintAccountChoice(status) {
  const panel = $('accountPanel');
  if (!accountConnecting) {
    const select = $('accountSelect');
    const compatible = availableAccounts.filter(row => row.compatible === true);
    const wanted = compatible.find(row => row.instanceId === accountChoice)
      ?? compatible.find(row => row.instanceId === status?.instanceId)
      ?? compatible.find(row => row.instanceId === select.value)
      ?? compatible[0];
    select.value = wanted?.instanceId || '';
  }
  panel.hidden = availableAccounts.length === 0 || (availableAccounts.length === 1 &&
    status?.paired === true && status.instanceId === availableAccounts[0].instanceId);
  if (panel.hidden) return;
  const selected = $('accountSelect').value;
  $('accountConnect').disabled = accountConnecting || !selected || (status?.paired === true && status?.instanceId === selected);
  $('accountSelect').disabled = accountConnecting;
  const connected = availableAccounts.find(row => row.instanceId === status?.instanceId);
  if (!$('accountStatus').dataset.actionResult) {
    $('accountStatus').textContent = connected && status?.paired
      ? `This Chrome profile is connected to ${connected.name}.`
      : 'Choose the account that owns this Chrome profile, then connect once.';
  }
}

async function loadAccountChoices() {
  const result = await chrome.runtime.sendMessage({ type: 'accountChoices' });
  if (!result?.ok || !Array.isArray(result.accounts)) return;
  availableAccounts = result.accounts.filter(row => row && typeof row.instanceId === 'string' && Number.isInteger(row.port));
  const select = $('accountSelect');
  const previous = select.value;
  select.replaceChildren(...availableAccounts.map(row => {
    const option = document.createElement('option');
    option.value = row.instanceId;
    option.textContent = `${row.name} · port ${row.port}${row.compatible ? '' : ' · update needed'}`;
    option.disabled = row.compatible !== true;
    return option;
  }));
  // Do not let the browser's automatic first-option selection choose an incompatible row.
  select.value = previous;
  paintAccountChoice(latest.status);
}

function paintAlert(status, info) {
  const page = info && info.page;
  const incompatible = status && status.connected === true && status.compatible === false;
  const pairError = status && status.pairError;
  const error = page && page.lastError;
  const text = incompatible
    ? `App v${status.appVersion || '?'} (protocol ${status.appProtocol ?? '?'}); companion v${status.extensionVersion || '?'} (protocol ${status.extensionProtocol ?? '?'}). Open your browser's Extensions page, enable Developer mode, then Update / Reload this companion. If the mismatch remains, use Open extension folder in Chat On Steroids and load that folder. Reload ChatGPT tabs when their active work is finished.`
    : pairError && pairError.message
      ? pairError.message
      : pairError && pairError.error === 'secure_storage_unavailable'
        ? 'Secure credential storage is unavailable. Open Chat On Steroids for setup instructions.'
    : error && Date.now() - error.at < 10 * 60 * 1000
      ? error.text
      : '';
  const missingRequiredFeature = info?.isChat && page?.requiredFeatures &&
    (page.requiredFeatures.promptEnvelope === false || page.requiredFeatures.nativeAllowOnce === false);
  const featureError = missingRequiredFeature
    ? 'Required companion features are unavailable on this tab. Finish current work before reloading the paired companion; check the prepared input before retrying a blocked Send.' : '';
  const alert = [text, featureError, accountChoiceError, reloadError].filter(Boolean).join(' ');
  $('alert').textContent = alert;
  $('alert').hidden = !alert;
}

function detail(list, term, value, bad) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
  if (bad) dd.className = 'bad';
  dd.title = dd.textContent;
  list.append(dt, dd);
}

/**
 * Only what changes the reading of the three stages.
 *
 * An earlier draft of this drawer listed twenty-eight fields, which is a different thing
 * from being informative: nothing in it told you which layer had stopped.
 */
function paintDetails(status, info, tabUnavailable = false) {
  if (!$('more').open) return;
  const grid = $('grid');
  grid.textContent = '';
  const page = !tabUnavailable && info?.isChat === true ? info.page : null;
  const sent = !tabUnavailable && info?.isChat === true ? info.delivery : null;

  detail(grid, 'app', status ? `v${status.appVersion || '?'} · port ${status.port || '—'}` : null);
  detail(
    grid,
    'extension',
    status ? `v${status.extensionVersion} · protocol ${status.extensionProtocol}` : null,
    status && status.compatible === false
  );
  detail(grid, 'chat id', (info && info.isChat === true && info.conversationId) || null);
  detail(grid, 'app session', (page && page.session) || null, Boolean(page && !page.session));
  detail(grid, 'tab', tabUnavailable ? 'status unavailable' : info ? `${info.tab} · epoch ${info.epoch ?? '—'}` : null);
  detail(
    grid,
    'ownership',
    tabUnavailable ? 'status unavailable' : info
      ? info.isChat !== true ? 'not applicable · no ChatGPT page selected' : info.terminal ? 'retired' : info.bound ? 'bound' : 'unbound'
      : null,
    Boolean(!tabUnavailable && info?.isChat === true && info.terminal)
  );
  detail(grid, 'recorder', tabUnavailable ? 'status unavailable' : page
    ? `recorder v${page.recorderVersion} · run ${page.runId}`
    : info?.isChat === true ? 'not attached' : info ? 'not applicable · no ChatGPT page selected' : null,
  Boolean(!tabUnavailable && info?.isChat === true && !page));
  detail(grid, 'turn', page ? (page.generating ? `${shorten(page.turnId, 8)} · live` : 'idle') : null);
  const provider = page
    ? page.conversationLoadFailure
      ? 'load failure · app recovery'
      : page.nativeErrorAttention
        ? 'native error · attention'
        : page.streaming
          ? 'streaming'
          : page.resumeStreamUnavailable
            ? 'resume unavailable'
            : 'clear'
    : null;
  detail(grid, 'provider', provider, Boolean(page && (page.conversationLoadFailure || page.nativeErrorAttention || page.resumeStreamUnavailable)));
  detail(grid, 'helper recovery', page ? (page.temporaryHelperRecovery || 'idle') : null,
    Boolean(page && page.temporaryHelperRecovery === 'failing'));
  detail(grid, 'observed', page ? `${page.events} events · ${page.calls} calls` : null);
  detail(
    grid,
    'tab status counts',
    tabUnavailable ? 'unknown' : info?.isChat === true ? `${info.pending} held · ${info.pendingAll} total`
      : info ? 'not applicable · no ChatGPT page selected' : null,
    Boolean(!tabUnavailable && info?.isChat === true && info.pendingAll)
  );
  detail(
    grid,
    'last delivery',
    sent && sent.at ? `${sent.ok ? 'ok' : sent.error || 'failed'} · ${sent.events} · ${ago(sent.at)} ago` : null,
    Boolean(sent && sent.ok === false)
  );
  detail(grid, 'delivered', sent ? sent.total : null);
  detail(grid, 'page sends', page ? `${page.sends} · ${page.failures} failed` : null, Boolean(page && page.failures));
}

async function refresh() {
  const generation = ++refreshGeneration;
  const [statusResult, tabResult] = await Promise.all([
    Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'status' }))
      .then(value => ({ value, failed: false }), () => ({ value: null, failed: true })),
    Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'tabStatus' }))
      .then(value => ({ value, failed: false }), () => ({ value: null, failed: true }))
  ]);
  const status = statusResult.value;
  const info = tabResult.value;
  const statusUnavailable = statusResult.failed || !status || typeof status !== 'object' || Array.isArray(status) || typeof status.connected !== 'boolean';
  const tabUnavailable = tabResult.failed || !info || typeof info !== 'object' || Array.isArray(info) || typeof info.isChat !== 'boolean';
  // An older poll cannot repaint the result of a newer explicit pairing refresh.
  if (generation !== refreshGeneration) return;
  latest = { status, tab: info, statusUnavailable, tabUnavailable };

  const ready = paintHeader(status, statusUnavailable);
  paintAccountChoice(status);
  const isChat = !tabUnavailable && info.isChat === true;
  const page = isChat ? info.page : null;

  if (statusUnavailable || tabUnavailable) paintNativeApproval(null, false);
  else paintNativeApproval(info, ready);

  // Capability evidence comes from this document's read-only health probe, independently of
  // Overwrite, account reachability or a matching release label. Unknown never means active.
  for (const [name, key] of [['prompt', 'promptEnvelope'], ['approval', 'nativeAllowOnce']]) {
    const available = !statusUnavailable && isChat ? page?.requiredFeatures?.[key] : undefined;
    row(name, available === true ? 'ok' : available === false ? 'no' : 'wait',
      available === true ? 'required' : available === false ? 'unavailable' : 'not verified');
  }

  row('tab', tabUnavailable ? 'wait' : isChat ? 'ok' : 'off', tabUnavailable ? 'unknown' : isChat ? '' : 'not selected');
  row('rec', tabUnavailable ? 'wait' : !isChat ? 'off' : info.recorder ? 'ok' : 'no',
    tabUnavailable ? 'unknown' : !isChat ? 'not applicable' : info.recorder ? (page?.generating ? 'answering' : '') : 'not attached');

  const chatId = isChat ? info.conversationId : null;
  idRow('chat', tabUnavailable ? 'wait' : !isChat ? 'off' : chatId ? 'ok' : 'wait',
    tabUnavailable ? 'unknown' : !isChat ? 'not selected' : chatId ? shorten(chatId, 8) : 'new chat', chatId);

  const requestId = page && page.requestId;
  idRow('req', tabUnavailable ? 'wait' : !isChat ? 'off' : requestId ? 'ok' : 'wait',
    tabUnavailable ? 'unknown' : !isChat ? 'not selected' : requestId ? shorten(requestId, 9) : 'none yet', requestId);

  const state = pipeline(info, ready);
  stage('read', ...state.read);
  stage('sent', ...state.sent);
  stage('proc', ...state.proc);
  $('why').textContent = state.why[1];
  $('why').className = `why ${state.why[0]}`;
  if (statusUnavailable) {
    $('why').textContent = 'Companion status could not be verified. Retained work is unchanged; check the companion and account window before retrying.';
    $('why').className = 'why bad';
  }
  paintCalls(page);

  const broken = state.why[0] === 'bad';
  const flowing = Array.isArray(page?.trace) && page.trace.some(call => call.app === 'request_id');
  row(
    'app',
    tabUnavailable ? 'wait' : !isChat ? 'off' : broken ? 'no' : flowing ? 'ok' : 'wait',
    tabUnavailable ? 'unknown' : !isChat ? 'not selected' : broken ? 'blocked' : flowing ? 'tool matched' : state.proc[0] === 'done' ? 'ID confirmed' : 'waiting'
  );
  // Opens itself the first time something is actually wrong, so the panel that explains
  // the failure is already open when the popup is opened to look at one.
  if (broken && !openedOnFailure) {
    openedOnFailure = true;
    $('stream').open = true;
  }

  paintAlert(status, info);
  paintDetails(status, info, tabUnavailable);
}

// -------------------------------------------------------------------- controls

function syncOverwrite() {
  $('overwriteToggle').checked = overwriteEnabled;
}

async function loadPreferences() {
  const revision = accountChoiceRevision;
  const debugRevision = debugCaptureRevision;
  try {
    const stored = await chrome.storage.local.get([RENDER_STREAM_KEY, ACCOUNT_CHOICE_KEY, DEBUG_CAPTURE_KEY]);
    let debugPermission = false;
    try { debugPermission = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch { /* Older Chrome/test surface: off. */ }
    if (debugRevision === debugCaptureRevision) {
      debugCaptureEnabled = stored[DEBUG_CAPTURE_KEY] === true && debugPermission;
      $('debugCaptureBtn').textContent = debugCaptureEnabled ? 'Disable failure screenshots' : 'Enable failure screenshots';
      $('debugCaptureStatus').textContent = debugCaptureEnabled
        ? 'On: visible ChatGPT failures only. Images stay local; metadata is in the account log.'
        : 'Screenshots off. Failure metadata is still recorded.';
    }
    overwriteEnabled = stored[RENDER_STREAM_KEY] !== false;
    if (revision === accountChoiceRevision) {
      const saved = stored[ACCOUNT_CHOICE_KEY];
      accountChoice = typeof saved === 'string' && saved.length > 0 && saved.length <= 128 ? saved : '';
      accountChoiceError = '';
    }
  } catch {
    if (revision === accountChoiceRevision) {
      accountChoiceError = 'Chrome could not load the saved account choice. Choose the account again to save it; the current pairing is unchanged.';
      console.warn('[Chat On Steroids] popup account choice preference read failed; current pairing unchanged');
    }
  }
  syncOverwrite();
  paintAccountChoice(latest.status);
  paintAlert(latest.status, latest.tab);
}

/** Puts one value on the clipboard and says so in place, without moving anything. */
async function copyInto(button, text) {
  if (!text) return;
  const was = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'copied';
  } catch {
    button.textContent = 'copy failed';
  }
  setTimeout(() => {
    if (button.textContent === 'copied' || button.textContent === 'copy failed') button.textContent = was;
  }, 900);
}

for (const id of ['d-chat', 'd-req']) {
  $(id).addEventListener('click', (event) => {
    event.preventDefault();
    void copyInto(event.currentTarget, event.currentTarget.title);
  });
}

$('copyBtn').addEventListener('click', (event) => {
  const cells = [...$('grid').children].map((node) => node.textContent);
  const lines = [$('why').textContent];
  for (let index = 0; index < cells.length; index += 2) lines.push(`${cells[index]}: ${cells[index + 1]}`);
  void copyInto(event.currentTarget, lines.join('\n'));
});

$('more').addEventListener('toggle', () => paintDetails(latest.status, latest.tab));

$('reloadBtn').addEventListener('click', () => { void requestCompanionReload(); });

$('debugCaptureBtn').addEventListener('click', async () => {
  const button = $('debugCaptureBtn');
  if (button.disabled) return;
  button.disabled = true;
  debugCaptureRevision += 1;
  const enabling = !debugCaptureEnabled;
  try {
    // Request only from the deliberate native click; never startup or background discovery.
    if (enabling && !await chrome.permissions.request({ origins: ['<all_urls>'] })) {
      $('debugCaptureStatus').textContent = 'Chrome did not grant capture permission. Screenshots remain off; metadata still works.';
      return;
    }
    await chrome.storage.local.set({ [DEBUG_CAPTURE_KEY]: enabling });
    debugCaptureEnabled = enabling;
    button.textContent = enabling ? 'Disable failure screenshots' : 'Enable failure screenshots';
    $('debugCaptureStatus').textContent = enabling
      ? 'On: visible ChatGPT failures only. Images stay local; metadata is in the account log.'
      : 'Screenshots off. Existing images remain in the bounded local ring.';
  } catch {
    $('debugCaptureStatus').textContent = 'Chrome could not save this setting. Nothing was started; try this button again.';
  } finally { button.disabled = false; }
});

$('retryBtn').addEventListener('click', async () => {
  if ($('retryBtn').disabled) return;
  let generation = ++refreshGeneration;
  $('retryBtn').disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'pair' });
    if (generation !== refreshGeneration) return;
    const refreshed = refresh();
    generation = refreshGeneration;
    await refreshed;
  } catch {
    if (generation !== refreshGeneration) return;
    $('why').textContent = 'Chrome could not complete the pairing retry. Retained work is unchanged; check the companion and account window, then try again.';
    $('why').className = 'why bad';
    console.warn('[Chat On Steroids] explicit pairing retry failed; retained work unchanged');
  } finally {
    $('retryBtn').disabled = false;
  }
});

$('accountSelect').addEventListener('change', () => {
  const selected = $('accountSelect').value;
  if (!availableAccounts.some(row => row.instanceId === selected && row.compatible === true)) {
    paintAccountChoice(latest.status);
    return;
  }
  accountChoice = selected;
  const revision = ++accountChoiceRevision;
  delete $('accountStatus').dataset.actionResult;
  paintAccountChoice(latest.status);
  // Serialize writes, coalescing choices that have not started. A late older write cannot
  // replace the newest choice or repaint its storage result. No pairing or token is changed.
  accountChoiceWrite = accountChoiceWrite.then(async () => {
    if (revision !== accountChoiceRevision) return;
    try {
      await chrome.storage.local.set({ [ACCOUNT_CHOICE_KEY]: selected });
      if (revision === accountChoiceRevision) accountChoiceError = '';
    } catch {
      if (revision === accountChoiceRevision) {
        accountChoiceError = 'Chrome could not save the account choice. It may reset when the popup closes. Choose the account again to retry; the current pairing is unchanged.';
        console.warn('[Chat On Steroids] popup account choice preference write failed; current pairing unchanged');
      }
    }
    if (revision === accountChoiceRevision) paintAlert(latest.status, latest.tab);
  });
});

function accountHistoryOffer(reply, selected) {
  try {
    const preservation = reply?.error === 'account_history_preservation_required';
    const offer = preservation ? reply?.operatorPreservation : reply?.operatorAdoption;
    if ((!preservation && reply?.error !== 'account_history_adoption_required') ||
        !offer || typeof offer !== 'object' || Array.isArray(offer)) return null;
    const fields = ['version', 'targetInstanceId', 'snapshotDigest', 'journalCount', 'ordinaryCloseCount'];
    const descriptors = Object.getOwnPropertyDescriptors(offer);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || !fields.every(key => keys.includes(key))) return null;
    const exact = {};
    for (const key of fields) {
      const field = descriptors[key];
      if (!field || !Object.prototype.hasOwnProperty.call(field, 'value') || !field.enumerable) return null;
      exact[key] = field.value;
    }
    if (exact.version !== 1 || exact.targetInstanceId !== selected ||
        typeof exact.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(exact.snapshotDigest) ||
        !Number.isSafeInteger(exact.journalCount) || exact.journalCount < (preservation ? 0 : 1) || exact.journalCount > 4000 ||
        !Number.isSafeInteger(exact.ordinaryCloseCount) || exact.ordinaryCloseCount < 1 || exact.ordinaryCloseCount > 200) return null;
    return exact;
  } catch { return null; }
}

$('accountConnect').addEventListener('click', async () => {
  const selected = $('accountSelect').value;
  const account = availableAccounts.find(row => row.instanceId === selected && row.compatible === true);
  if (accountConnecting || !account) return;
  ++refreshGeneration; // A selected-account action supersedes older Retry success and failure painting.
  accountConnecting = true;
  paintAccountChoice(latest.status);
  let message = 'Could not confirm the connection. Check that its COS window is running.';
  try {
    let result = await chrome.runtime.sendMessage({ type: 'pairTo', instanceId: selected });
    const offer = accountHistoryOffer(result, selected);
    if (offer) {
      if ($('accountSelect').value !== selected) return;
      const preservation = result.error === 'account_history_preservation_required';
      const approved = window.confirm(preservation
        ? `Preserve unassigned history and connect future work to ${account.name}?\n\n` +
          `${offer.journalCount} recorded observation(s) and ${offer.ordinaryCloseCount} ordinary tab-close receipt(s) will be sealed in this Chrome profile. ` +
          'Old unassigned conversations remain held and will not be associated with this account. Use a new chat for future work.\n\n' +
          'Drafts, message deliveries, worker reports and permissions remain unchanged. Cancel keeps the original history and connection.'
        : `Retain and associate local history with ${account.name}?\n\n` +
        `${offer.journalCount} recorded observation(s) and ${offer.ordinaryCloseCount} tab-close receipt(s) will be retained and processed by this account. ` +
        'Their original account was not recorded, so this could misfile older history.\n\n' +
        'Drafts, message deliveries, worker reports and file permissions are unchanged. Cancel leaves the connection and history unchanged.');
      if ($('accountSelect').value !== selected) return;
      if (!approved) { message = 'Connection cancelled. Retained local history was not cleared or reassigned.'; return; }
      result = await chrome.runtime.sendMessage({ type: 'pairTo', instanceId: selected,
        ...(preservation ? { operatorPreservation: offer } : { operatorAdoption: offer }) });
    }
    await refresh();
    message = result?.ok && latest.status?.connected && latest.status?.paired && latest.status?.instanceId === selected
      ? `Connected to ${account.name}.`
      : result?.error === 'account_history_adoption_required'
        ? 'Connection needs confirmation for retained local history. Nothing was cleared or reassigned; choose this account again to review it.'
        : result?.error === 'account_history_preservation_required'
          ? result?.message || 'Connection needs confirmation to preserve unassigned history. Older conversations remain held; use a new chat for future work.'
          : result?.message || message;
  } catch {
    message = 'Chrome could not confirm the account connection. Retained work is unchanged; check companion storage and the account window.';
  } finally {
    accountConnecting = false;
    $('accountStatus').dataset.actionResult = '1';
    $('accountStatus').textContent = message;
    paintAccountChoice(latest.status);
  }
});

$('unpairBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'unpair' });
  await refresh();
});

$('overwriteToggle').addEventListener('change', async () => {
  const previous = overwriteEnabled;
  overwriteEnabled = $('overwriteToggle').checked === true;
  syncOverwrite();
  try {
    await chrome.storage.local.set({ [RENDER_STREAM_KEY]: overwriteEnabled });
    // The toggle is the action. Enabling it immediately pulls the latest app timeline into
    // every known ChatGPT tab; there is deliberately no second "Overwrite now" button.
    if (overwriteEnabled) await chrome.runtime.sendMessage({ type: 'overwriteNow' });
  } catch {
    overwriteEnabled = previous;
    syncOverwrite();
  }
});

// A popup is open for seconds at a time and the three stages move within those seconds.
void loadPreferences().catch(() => undefined);
void refresh().catch(() => undefined);
void loadAccountChoices().catch(() => undefined);
setInterval(() => void refresh().catch(() => undefined), POLL_MS);

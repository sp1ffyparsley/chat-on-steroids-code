#!/usr/bin/env node
import { readFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { connectNative, assertFreeModel } from './deepai-native.mjs';
import { ATTENTION_LIMITS, getNativeAttention } from './deepai-attention.mjs';
import { HelperState, TERMINAL, MAX_ACTIVE, defaultStateRoot, workspaceKey, hash, publicJob, writeResultFiles, helperAdmission } from './deepai-helper-state.mjs';

const script = fileURLToPath(import.meta.url);
const NATIVE_TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back']);
const ACTIVE_NATIVE = new Set(['preparing', 'starting', 'running', 'waiting', 'queued']);
export const isAlive = pid => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const errorText = error => ((typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code + ': ' : '') +
  (Number.isInteger(error?.httpStatus) ? `HTTP ${error.httpStatus}. ` : '') + String(error?.message || 'Native operation failed.')).slice(0, 500);
const RECONNECT = new Set(['NATIVE_SOCKET_UNAVAILABLE', 'NATIVE_SOCKET_ERROR', 'NATIVE_SOCKET_CLOSED', 'NATIVE_SOCKET_OPEN_FAILED', 'NATIVE_PROTOCOL_ERROR', 'NATIVE_CLIENT_CLOSED', 'NATIVE_CREDENTIAL_EXPIRED', 'NATIVE_HTTP_FAILED']);
// A locally revoked/expired credential is renewable with the same narrow scopes.
// A 403 is a permissions decision: never widen scopes or treat it as login loss.
export const requiresNativeReconnect = error => RECONNECT.has(error?.code) || (error?.code === 'NATIVE_HTTP_STATUS' && error.httpStatus === 401);

/** Read-only native preflight: no queue admission, worker start or inference. */
export async function nativeReadiness(connect = connectNative, requestedModel = 'deepai/glm-5.3-flash') {
  let connection;
  const eligibleModels = [];
  let eligibleModelsTruncated = false;
  try {
    connection = await connect({ websocket: true });
    const config = await connection.rpc('server.getConfig', {});
    const providers = Array.isArray(config?.providers) ? config.providers : Object.values(config?.providers ?? {});
    const models = providers.filter(provider => provider?.instanceId === 'deepai').flatMap(provider => Array.isArray(provider.models) ? provider.models : []);
    // Expose only catalog IDs that pass the actual dispatch guard. Never return provider
    // configuration or choose a replacement for the explicitly requested model.
    for (const model of models) {
      const slug = model?.slug;
      if (typeof slug !== 'string' || slug.length > 200 || !/^deepai\/[a-z0-9][a-z0-9.-]+$/.test(slug) || eligibleModels.includes(slug)) continue;
      try { assertFreeModel(config, slug); } catch { continue; }
      if (eligibleModels.length === 16) { eligibleModelsTruncated = true; break; }
      eligibleModels.push(slug);
    }
    const selection = assertFreeModel(config, requestedModel);
    return { ready: true, observedAt: new Date().toISOString(), model: selection.model,
      version: connection.descriptor.serverVersion, protocol: connection.descriptor.orchestrationProtocolVersion,
      maxActive: MAX_ACTIVE, eligibleModels, eligibleModelsTruncated, blocker: null };
  } catch (error) {
    return { ready: false, observedAt: new Date().toISOString(), maxActive: MAX_ACTIVE, eligibleModels, eligibleModelsTruncated,
      blocker: { code: typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'NATIVE_PREFLIGHT_FAILED',
        action: 'Open DeepAI Code and check sign-in, local-client permission, supported version and the exact free model. Retry readiness; do not replace an accepted task or bypass approvals.' } };
  } finally { if (connection) await connection.close(); }
}

export function diagnosedJob(state, job, now = Date.now()) {
  const view = { ...publicJob(job), resultSaveError: job.resultSaveError ?? null };
  const terminal = TERMINAL.has(job.status);
  const worker = state.runtime('worker');
  const heartbeat = Date.parse(worker?.heartbeatAt);
  const workerStatus = !worker || !isAlive(worker.pid) ? 'unavailable'
    : !Number.isFinite(heartbeat) || now < heartbeat || now - heartbeat > 120000 ? 'stale' : 'running';
  const admission = job.status === 'queued' ? helperAdmission(job) : { allowed: true };
  let blocker = null;
  const reason = !admission.allowed ? admission.reason : job.waitingFor;
  const actions = {
    parent_paused: 'Resume this exact account deliberately when ready. The original queued job is retained.',
    parent_off: 'Enable this exact parent chat deliberately when ready. Keep its original job ID.',
    parent_command_disabled: 'Restore writable command capability through the account settings before retrying.',
    parent_control_unverified: 'Inspect this exact parent registration and durable control paths. Do not edit or replace custody records.',
    native_unavailable: 'Open DeepAI Code; check sign-in, local permissions and runtime compatibility. Recover the existing job after repairing the prerequisite.',
    native_capacity: 'Wait for native capacity. The shared two-active budget remains enforced.',
    workspace: 'Wait for the existing native work to release this workspace; use a separate approved workspace for independent work.'
  };
  if (job.resultSaveError || job.status === 'completed' && !job.resultSavedAt) blocker = { code: 'report_not_saved', action: 'Check workspace access and available disk space, then retry result for this same job. Completion is withheld until the report is saved.' };
  else if (job.attention?.pendingCount > 0) blocker = { code: 'native_attention', action: 'Review the exact pending approval, question or sign-in in DeepAI Code. The bridge cannot answer it.' };
  else if (!terminal && actions[reason]) blocker = { code: reason, action: actions[reason] };
  else if (!terminal && workerStatus !== 'running') blocker = { code: 'queue_' + workerStatus, action: workerStatus === 'unavailable'
    ? 'Recover the existing queue with action=recover for this job or CLI recover; keep the original task IDs and do not submit a replacement.'
    : 'A live queue process has a stale/unverified heartbeat. Use CLI health for exact process review before termination. Recovery never steals a live lease.' };
  else if (!terminal && reason) blocker = { code: reason, action: 'Inspect this exact job in DeepAI Code and its queue log. Keep the original task identity.' };
  return { ...view, ...(terminal && !(job.result && !job.resultSavedAt) ? {} : { workerStatus }), blocker,
    ...(blocker ? { recovery: blocker.action } : {}) };
}

export const recoveryNeeded = job => job.workerStatus === 'unavailable' || job.workerStatus === 'stale' ||
  ['native_unavailable', 'parent_control_unverified', 'parent_command_disabled'].includes(job.waitingFor);

export function activeNativeIds(threads) {
  return new Set(threads.filter(thread => thread.providerInstanceId === 'deepai' && !thread.deletedAt && (thread.activeRunId || ACTIVE_NATIVE.has(thread.activityRunStatus) || ACTIVE_NATIVE.has(thread.status) || thread.pendingRuntimeRequest || thread.pendingBackgroundTasks?.length)).map(thread => thread.id));
}

export function verifyRun(job, projection) {
  if (projection?.thread?.id !== job.threadId) throw new Error('Native result belongs to a different chat.');
  if (projection.thread.projectId !== job.projectId) throw new Error('Native chat moved to another project; inspect its workspace before continuing.');
  if (projection.thread.worktreePath && workspaceKey(path.resolve(projection.thread.worktreePath)) !== job.workspaceKey) throw new Error('Native chat worktree changed; inspect before continuing.');
  const run = projection.runs?.find(value => value.userMessageId === job.messageId);
  if (!run) return null;
  if (run.threadId !== job.threadId || (job.runId && job.runId !== run.id)) throw new Error('Native run identity changed; no result was accepted.');
  if (run.providerInstanceId !== 'deepai' || run.modelSelection?.instanceId !== 'deepai' || run.modelSelection?.model !== job.model) throw new Error('Native model differs from the pinned free model; no result was accepted.');
  return run;
}

function progressHash(projection, run, attention) {
  return hash({ status: run.status, messages: projection.messages.filter(message => message.runId === run.id).map(message => [message.id, message.text, message.streaming]), items: projection.turnItems.filter(item => item.runId === run.id), attention: attention?.fingerprint ?? null });
}

function preservePendingAttention(previous, current) {
  if (current.available) return current;
  if (!current.pendingCount) return previous || null;
  const requests = [...new Map([...(previous?.requests || []), ...current.requests].map(item => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const pendingCount = Math.max(requests.length, previous?.pendingCount || 0, current.pendingCount);
  return { ...current, requests: requests.slice(0, ATTENTION_LIMITS.requests), pendingCount, truncated: pendingCount > ATTENTION_LIMITS.requests, fingerprint: hash({ runId: current.runId, reason: current.reason, requests, pendingCount }) };
}

async function collectCompleted(state, connection, job) {
  // The WS snapshot is a timeline window. Fetch the complete projection before
  // storing this turn; native tool bodies can still be bounded by the app.
  const full = await connection.http(`/api/orchestration/threads/${encodeURIComponent(job.threadId)}`);
  const projection = full.projection;
  const run = verifyRun(job, projection);
  if (!run || !NATIVE_TERMINAL.has(run.status)) throw new Error('Completed run was not present in the full native snapshot; collection will retry.');
  const messages = projection.messages.filter(message => message.runId === run.id);
  const assistant = messages.filter(message => message.role === 'assistant');
  if (assistant.some(message => message.streaming)) throw new Error('Native response is still streaming; collection will retry.');
  const assistantText = assistant.map(message => message.text).filter(text => typeof text === 'string' && text.length).join('\n\n');
  const current = state.get(job.id);
  const status = run.status === 'completed' ? (assistantText ? 'completed' : 'incomplete') : current.cancelRequestedAt && ['interrupted', 'cancelled'].includes(run.status) ? 'cancelled' : 'failed';
  const attention = getNativeAttention(projection, run.id);
  // Request cards can contain credentials, answers and provider-session refs.
  // Keep only their sanitized attention projection, never the raw private cards.
  const privateCards = new Set(['approval_request', 'user_input_request', 'secret_request']);
  const toolItems = projection.turnItems.filter(item => item.runId === run.id && !privateCards.has(item.type));
  const result = { version: 1, kind: 'completed-turn-result', jobId: job.id, owner: job.owner, threadId: job.threadId, messageId: job.messageId, requestHash: job.requestHash, workspace: job.workspace, run, messages, assistantText, retrievedAt: new Date().toISOString(), snapshotSequence: full.snapshotSequence, nativeError: projection.thread.lastError ?? null, attention, toolEvidence: { completeness: 'Native tool bodies can be omitted or truncated; private request cards are excluded. This is not a complete execution archive.', items: toolItems }, independentVerification: 'required' };
  return state.patch(job.id, { status, nativeStatus: run.status, runId: run.id, completedAt: run.completedAt || new Date().toISOString(), result, attention: null, attentionUnavailableReason: null, waitingFor: null, lastError: status === 'incomplete' ? 'Native run completed without a final assistant response.' : status === 'failed' ? 'Native run did not complete successfully; inspect the saved result.' : null });
}

async function requestStop(state, connection, job, run, reason) {
  const current = state.get(job.id);
  if (run.status !== 'queued' && (!run.rootNodeId || !run.providerThreadId)) {
    state.patch(job.id, { status: 'stopping', cancelRequestedAt: current.cancelRequestedAt || new Date().toISOString(), cancelReason: current.cancelReason || reason, lastError: 'Native run has not exposed a cancellable execution node yet; cancellation remains pending.' }); return;
  }
  const type = run.status === 'queued' ? 'queued-run.cancel' : 'run.interrupt';
  const sameCommand = current.cancelCommand?.type === type && current.cancelCommand?.runId === run.id;
  const cancelCommand = sameCommand ? current.cancelCommand : { type, commandId: randomUUID(), threadId: job.threadId, runId: run.id, ...(type === 'run.interrupt' ? { holdQueue: true, reason } : {}) };
  state.patch(job.id, { status: 'stopping', cancelCommand, ...(!sameCommand ? { cancelAcceptedAt: null } : {}), cancelRequestedAt: current.cancelRequestedAt || new Date().toISOString(), cancelReason: current.cancelReason || reason });
  if (!sameCommand || !current.cancelAcceptedAt) {
    await connection.rpc('orchestration.dispatchCommand', cancelCommand);
    state.patch(job.id, { cancelAcceptedAt: new Date().toISOString() });
  }
}

async function observeJob(state, connection, job, threads, now) {
  const shell = threads.find(thread => thread.id === job.threadId);
  if (!shell && job.status === 'submitting' && !job.runId) return false;
  let projection = await connection.rpc('orchestration.getThreadProjection', { threadId: job.threadId });
  let fullProjectionRead = false;
  let run = verifyRun(job, projection);
  if (!run) {
    const full = await connection.http(`/api/orchestration/threads/${encodeURIComponent(job.threadId)}`);
    projection = full.projection;
    fullProjectionRead = true;
    run = verifyRun(job, projection);
    if (!run && job.runId) throw new Error('Previously accepted run is missing; no replacement request will be sent.');
  }
  if (!run) return false;
  if (NATIVE_TERMINAL.has(run.status)) { await collectCompleted(state, connection, job); return true; }
  // The shipped app can report running while a file approval waits. An incomplete
  // WS graph or native attention signal also requires the complete HTTP graph.
  if (!fullProjectionRead && (run.status === 'waiting' || shell?.pendingRuntimeRequest || !getNativeAttention(projection, run.id).available)) {
    const full = await connection.http(`/api/orchestration/threads/${encodeURIComponent(job.threadId)}`);
    const fullRun = verifyRun(job, full.projection);
    if (!fullRun) throw new Error('Observed run missing from its full projection; prior attention remains pending.');
    projection = full.projection; run = fullRun;
    if (NATIVE_TERMINAL.has(run.status)) { await collectCompleted(state, connection, job); return true; }
  }
  const attention = getNativeAttention(projection, run.id);
  const fingerprint = progressHash(projection, run, attention);
  const current = state.get(job.id);
  const effectiveAttention = preservePendingAttention(current.attention, attention);
  state.patch(job.id, { status: current.cancelRequestedAt ? 'stopping' : run.status === 'waiting' || effectiveAttention?.pendingCount ? 'waiting' : 'active', nativeStatus: run.status, runId: run.id, nativeStartedAt: run.startedAt, attention: effectiveAttention ? { ...effectiveAttention, ...(attention.available || attention.pendingCount ? { observedAt: new Date(now).toISOString() } : {}) } : null, attentionUnavailableReason: attention.available ? null : attention.reason, waitingFor: effectiveAttention?.pendingCount ? 'native_attention' : run.status === 'waiting' ? 'native_waiting' : null, ...(fingerprint !== current.progressHash ? { progressHash: fingerprint, lastProgressAt: new Date(now).toISOString() } : {}), lastError: null });
  const elapsed = now - Date.parse(run.startedAt || current.submittedAt || current.createdAt);
  if (current.cancelRequestedAt || elapsed >= job.maxRunMinutes * 60000) await requestStop(state, connection, state.get(job.id), run, current.cancelReason || `Helper exceeded its ${job.maxRunMinutes}-minute run deadline`);
  return true;
}

function savePendingResults(state) {
  for (const job of state.unsaved()) {
    try { writeResultFiles(job); state.patch(job.id, { resultSavedAt: new Date().toISOString(), resultSaveError: null }); }
    catch (error) {
      const attempts = (job.resultSaveAttempts || 0) + 1;
      state.patch(job.id, { resultSaveAttempts: attempts, resultSaveError: errorText(error), ...(attempts >= 3 ? { resultSaveBlockedAt: new Date().toISOString() } : {}) });
    }
  }
}

export async function runCycle(state, connection, { now = Date.now() } = {}) {
  // Queue cancellation has no native side effects and must also work offline.
  for (const job of state.pending()) if (job.status === 'queued' && job.cancelRequestedAt) state.patch(job.id, { status: 'cancelled', completedAt: new Date(now).toISOString(), lastError: null });
  savePendingResults(state);
  if (!state.pending().length) return { pending: 0, active: 0 };
  const shell = await connection.http('/api/orchestration/shell');
  const archived = await connection.rpc('orchestration.getArchivedShellSnapshot', {});
  const threads = [...new Map([...shell.threads, ...archived.threads].map(thread => [thread.id, thread])).values()];
  const unseen = new Set();
  for (const job of state.pending().filter(item => item.status !== 'queued')) {
    try { if (!await observeJob(state, connection, job, threads, now)) unseen.add(job.id); }
    catch (error) { state.patch(job.id, { lastError: errorText(error) }); if (requiresNativeReconnect(error)) throw error; }
  }
  savePendingResults(state);
  const remaining = state.pending();
  const occupied = activeNativeIds(threads);
  // A terminal turn can still own background native work. Its workspace remains
  // reserved until the native activity disappears, even after its report is saved.
  const workspaces = new Set(state.workspacesForThreads([...occupied]));
  for (const job of remaining.filter(item => item.status !== 'queued')) { occupied.add(job.threadId); workspaces.add(job.workspaceKey); }
  let config;
  const candidates = remaining.filter(job => job.status === 'queued' || (job.status === 'submitting' && unseen.has(job.id)));
  // Among owners with queued work, choose the least recently admitted owner.
  const lastAdmission = state.lastAdmissions();
  while (candidates.length) {
    candidates.sort((a, b) => (lastAdmission.get(a.owner) || 0) - (lastAdmission.get(b.owner) || 0) || a.createdAt.localeCompare(b.createdAt));
    let candidate = candidates.shift();
    candidate = state.get(candidate.id);
    if (candidate.cancelRequestedAt && candidate.status === 'queued') { state.patch(candidate.id, { status: 'cancelled', completedAt: new Date(now).toISOString() }); continue; }
    const replay = candidate.status === 'submitting';
    if (replay && candidate.cancelRequestedAt) { state.patch(candidate.id, { lastError: 'Cancellation is pending native reconciliation; the ambiguous launch will not be replayed.' }); continue; }
    const admission = helperAdmission(candidate);
    if (!admission.allowed) { state.patch(candidate.id, { waitingFor: admission.reason }); continue; }
    if ((!replay && occupied.size >= MAX_ACTIVE) || (replay && occupied.size > MAX_ACTIVE)) { if (candidate.waitingFor !== 'native_capacity') state.patch(candidate.id, { waitingFor: 'native_capacity' }); continue; }
    if (!replay && workspaces.has(candidate.workspaceKey)) { if (candidate.waitingFor !== 'workspace') state.patch(candidate.id, { waitingFor: 'workspace' }); continue; }
    if (replay && candidate.lastSendAt && now - Date.parse(candidate.lastSendAt) < 10000) continue;
    try {
      config ||= await connection.rpc('server.getConfig', {});
      try { assertFreeModel(config, candidate.model); }
      catch (error) { if (!replay) { state.patch(candidate.id, { status: 'blocked', lastError: errorText(error), completedAt: new Date(now).toISOString() }); continue; } throw error; }
      const project = state.project(candidate.workspace);
      let nativeProject = [...shell.projects, ...archived.projects].find(value => value.id === project.projectId);
      if (!nativeProject) {
        nativeProject = await connection.rpc('projects.mutate', project.command);
        shell.projects.push(nativeProject);
      }
      if (typeof nativeProject.workspaceRoot !== 'string' || workspaceKey(path.resolve(nativeProject.workspaceRoot)) !== candidate.workspaceKey) throw new Error('Native project workspace changed; no task was sent.');
      if (candidate.operation === 'continue') {
        const currentThread = (await connection.http(`/api/orchestration/threads/${encodeURIComponent(candidate.threadId)}`)).projection.thread;
        if (currentThread.projectId !== candidate.projectId || (currentThread.worktreePath && workspaceKey(path.resolve(currentThread.worktreePath)) !== candidate.workspaceKey) || currentThread.runtimeMode !== 'auto') throw new Error('Native continuation workspace or permission mode changed; no task was sent.');
      }
      // Stable payload/IDs are committed before transmission. Replays use the
      // installed version's durable receipt deduplication, never a fresh ID.
      // Config/Goal may change during native project/config reads. Recheck the
      // original durable owners immediately before the synchronous send boundary.
      const finalAdmission = helperAdmission(candidate);
      if (!finalAdmission.allowed) { state.patch(candidate.id, { waitingFor: finalAdmission.reason }); continue; }
      candidate = state.patch(candidate.id, current => current.cancelRequestedAt ? (current.status === 'queued' ? { status: 'cancelled', completedAt: new Date(now).toISOString() } : { lastError: 'Cancellation is pending native reconciliation; no launch replay was sent.' }) : { status: 'submitting', submittedAt: current.submittedAt || new Date(now).toISOString(), lastSendAt: new Date(now).toISOString(), sendAttempts: (current.sendAttempts || 0) + 1, lastError: null, waitingFor: null });
      if (candidate.cancelRequestedAt || candidate.status !== 'submitting') continue;
      occupied.add(candidate.threadId); workspaces.add(candidate.workspaceKey);
      lastAdmission.set(candidate.owner, now);
      const accepted = await connection.rpc(candidate.operation === 'launch' ? 'orchestration.launchThread' : 'orchestration.dispatchCommand', candidate.command, 30000);
      if (candidate.operation === 'launch' && accepted.threadId !== candidate.threadId) throw new Error('Native launcher returned an unexpected chat; inspect before further work.');
      const acceptedRun = candidate.operation === 'launch' ? verifyRun(candidate, accepted.projection) : null;
      state.patch(candidate.id, { status: 'active', acceptedAt: new Date().toISOString(), ...(acceptedRun ? { runId: acceptedRun.id } : {}) });
    } catch (error) { state.patch(candidate.id, { lastError: errorText(error) }); if (requiresNativeReconnect(error)) throw error; }
  }
  return { pending: state.pending().length, active: occupied.size };
}

export function ensureWorker(state) {
  if (!state.pending().length && !state.unsaved().length) return false;
  const worker = state.runtime('worker');
  if (worker && isAlive(worker.pid)) return true;
  const log = openSync(path.join(state.root, 'worker.log'), 'a');
  try {
    const child = spawn(process.execPath, [script, 'worker', '--state-root', state.root], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env } });
    child.on('error', () => {}); child.unref();
  } finally { closeSync(log); }
  return true;
}

export async function work(state) {
  const token = randomUUID();
  if (!state.acquireWorker(token, process.pid, isAlive)) return;
  let connection, connectedAt = 0, stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  console.log(JSON.stringify({ event: 'worker-started', pid: process.pid, stateRoot: state.root, maxActive: MAX_ACTIVE, at: new Date().toISOString() }));
  let previousFailure;
  try {
    while (!stopping) {
      if (!state.heartbeat(token)) throw new Error('Helper queue ownership changed.');
      for (const job of state.pending()) if (job.status === 'queued' && job.cancelRequestedAt) state.patch(job.id, { status: 'cancelled', completedAt: new Date().toISOString() });
      savePendingResults(state);
      if (state.releaseIfIdle(token)) break;
      try {
        if (connection && (Date.now() - connectedAt > 40 * 60000 || (connection.credentialMetadata?.expiresAtMs && Date.now() > connection.credentialMetadata.expiresAtMs - 60000))) { await connection.close(); connection = null; }
        if (!connection) {
          connection = await connectNative({ websocket: true }); connectedAt = Date.now();
          console.log(JSON.stringify({ event: 'native-connected', version: connection.descriptor.serverVersion,
            protocol: connection.descriptor.orchestrationProtocolVersion, at: new Date().toISOString() }));
        }
        await runCycle(state, connection);
        state.heartbeat(token, { lastError: null });
      } catch (error) {
        const failure = errorText(error);
        state.heartbeat(token, { lastError: failure });
        for (const job of state.pending()) {
          const admission = helperAdmission(job);
          state.patch(job.id, { lastError: failure, waitingFor: admission.allowed ? 'native_unavailable' : admission.reason });
        }
        if (previousFailure !== failure) console.error(JSON.stringify({ event: 'native-unavailable', error: failure,
          action: 'Check DeepAI runtime/version, sign-in and local client permissions; original task IDs are retained.', at: new Date().toISOString() }));
        previousFailure = failure;
        if (connection) await connection.close(); connection = null;
      }
      await delay(connection ? 2000 : 10000);
    }
  } finally {
    if (connection) await connection.close();
    state.releaseWorker(token);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    console.log(JSON.stringify({ event: 'worker-stopped', pid: process.pid, at: new Date().toISOString() }));
  }
}

export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { request: { type: 'string' }, model: { type: 'string' }, job: { type: 'string' }, owner: { type: 'string' }, 'state-root': { type: 'string' }, 'no-worker': { type: 'boolean' }, offset: { type: 'string' }, limit: { type: 'string' } } });
  const action = positionals[0];
  if (!action || action === 'help') {
    console.log('DeepAI helper: submit --request FILE | continue --job ID --request FILE | status/result/cancel/ack --job ID --owner LABEL | inbox --owner LABEL | readiness [--model deepai/ID] | health | recover. Use --request - for stdin. Each request JSON needs owner, requestKey, workspace, prompt; title/model/maxRunMinutes are optional. Continue inherits workspace/model. Results are saved in WORKSPACE/.cos-deepai/results/JOB. --no-worker makes status/result/inbox/health/ack passive: they never start or recover a native worker.'); return;
  }
  if (values['no-worker'] && !['status', 'result', 'inbox', 'health', 'ack', 'readiness'].includes(action)) throw new Error('--no-worker is only supported for passive status/result/inbox/health/ack operations.');
  if (values.model !== undefined && (action !== 'readiness' || values.model.length > 200 || !/^deepai\/[a-z0-9][a-z0-9.-]+$/.test(values.model))) throw new Error('--model is only supported for readiness with a bounded native DeepAI catalog ID. Submit models belong in request JSON.');
  const state = new HelperState(values['state-root'] || defaultStateRoot());
  try {
    if (action === 'worker') { await work(state); return; }
    if (action === 'readiness') { console.log(JSON.stringify(await nativeReadiness(connectNative, values.model), null, 2)); return; }
    let response;
    if (action === 'submit' || action === 'continue') {
      if (!values.request || (action === 'continue' && !values.job)) throw new Error('A request JSON file is required; continue also requires --job.');
      const input = JSON.parse(readFileSync(values.request === '-' ? 0 : values.request, 'utf8'));
      const result = state.enqueue(input, action === 'continue' ? values.job : undefined);
      response = { ...publicJob(result.job), reused: result.reused };
    } else if (action === 'health' || action === 'recover') {
      const worker = state.runtime('worker');
      response = { stateRoot: state.root, maxActive: MAX_ACTIVE, pending: state.pending().length, worker: worker ? { pid: worker.pid, alive: isAlive(worker.pid), heartbeatAt: worker.heartbeatAt, stale: Date.now() - Date.parse(worker.heartbeatAt) > 120000, lastError: worker.lastError } : null, recovery: worker && isAlive(worker.pid) && Date.now() - Date.parse(worker.heartbeatAt) > 120000 ? 'Worker heartbeat is stale; verify this process identity before terminating and restarting it. No live PID was killed or its lease stolen.' : null };
    } else {
      if (!values.owner) throw new Error('--owner is required for this operation.');
      if (action === 'inbox') response = { jobs: state.list(values.owner).map(job => ({ job, view: diagnosedJob(state, job) }))
        .filter(({ job, view }) => TERMINAL.has(job.status) ? !job.acknowledgedAt : job.attention?.pendingCount > 0 || recoveryNeeded(view))
        .slice(0, 50).map(({ view }) => view) };
      else {
        if (!values.job) throw new Error('--job is required.');
        let job = state.get(values.job, values.owner);
        if (action === 'cancel') job = state.cancel(job.id, values.owner);
        else if (action === 'ack') {
          if (!TERMINAL.has(job.status)) throw new Error('This helper has no terminal outcome to acknowledge.');
          if (job.status === 'completed' && !job.resultSavedAt) throw new Error('Save the completed report with result before acknowledging this job.');
          job = state.patch(job.id, { acknowledgedAt: new Date().toISOString() });
        } else if (!['status', 'result'].includes(action)) throw new Error('Unknown helper action.');
        if (job.result && !job.resultSavedAt) {
          try { writeResultFiles(job); job = state.patch(job.id, { resultSavedAt: new Date().toISOString(), resultSaveError: null, resultSaveBlockedAt: null }); }
          catch (error) { job = state.patch(job.id, { resultSaveError: errorText(error) }); }
        }
        response = { ...diagnosedJob(state, job), acknowledged: !!job.acknowledgedAt, resultSaveError: job.resultSaveError ?? null };
        if (action === 'result' && job.result) {
          const offset = Number(values.offset || 0), limit = Number(values.limit || 8000);
          if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000) throw new Error('offset must be nonnegative; limit must be 1..16000 characters.');
          const text = job.result.assistantText;
          response = { ...response, assistantText: text.slice(offset, offset + limit), offset, totalCharacters: text.length, nextOffset: offset + limit < text.length ? offset + limit : null, nativeRun: job.result.run, verification: job.result.independentVerification };
        }
      }
    }
    if (!values['no-worker']) ensureWorker(state);
    console.log(JSON.stringify(response, null, 2));
  } finally { state.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) main().catch(error => { console.error(JSON.stringify({ error: errorText(error) })); process.exitCode = 1; });

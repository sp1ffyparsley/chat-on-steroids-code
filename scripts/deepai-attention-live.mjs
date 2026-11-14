#!/usr/bin/env node
// Explicit one-attempt native attention validation; never imported by CI.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connectNative, assertFreeModel } from './deepai-native.mjs';
import { getNativeAttention } from './deepai-attention.mjs';
import { HelperState, MAX_ACTIVE, workspaceKey } from './deepai-helper-state.mjs';
import { activeNativeIds, isAlive, verifyRun, requiresNativeReconnect } from './deepai-helper.mjs';

if (process.argv.length !== 3 || process.argv[2] !== 'start')
  throw new Error('Opt-in only: node scripts/deepai-attention-live.mjs start. One new isolated native chat; no approval answers.');
const workspace = path.join(homedir(), 'Documents', 'ChatGPT', 'DeepAI-Integration-Validation', 'phase2', 'attention');
const receiptPath = path.join(workspace, 'attention-live.json');
if (existsSync(receiptPath)) throw new Error('This one-attempt fixture already exists; inspect its receipt instead of resubmitting.');
const state = new HelperState();
const lease = randomUUID();
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const job = { projectId: randomUUID(), threadId: randomUUID(), messageId: randomUUID(),
  model: 'deepai/glm-5.3-flash', workspaceKey: workspaceKey(path.resolve(workspace)) };
const receipt = { version: 1, test: 'native-pending-attention', startedAt: new Date().toISOString(),
  threadId: job.threadId, projectId: job.projectId, messageId: job.messageId,
  model: job.model, thinking: 'high', runtimeMode: 'approval-required',
  maxActive: MAX_ACTIVE, sendAttempts: 0, approvalAnswersSent: 0, localClientsRetired: true };
let connection, acquired = false, submitted = false, receiptCreated = false;
const persist = () => { if (receiptCreated) writeFileSync(receiptPath, JSON.stringify(receipt, null, 2)); };
const heartbeat = () => {
  if (!state.heartbeat(lease)) throw new Error('Fixture lost the shared bridge lease.');
};
async function retire() {
  if (!connection) return;
  const closed = await connection.close();
  receipt.localClientsRetired &&= closed.credentialRevoked === true;
  connection = undefined;
}
async function recover(error) {
  if (!requiresNativeReconnect(error)) throw error;
  await retire();
  connection = await connectNative({ websocket: true });
}
async function readOwn() {
  let snapshot;
  try { snapshot = await connection.http('/api/orchestration/threads/' + encodeURIComponent(job.threadId)); }
  catch (error) { await recover(error); snapshot = await connection.http('/api/orchestration/threads/' + encodeURIComponent(job.threadId)); }
  assert.equal(snapshot.projection.thread.runtimeMode, 'approval-required');
  const run = verifyRun(job, snapshot.projection);
  if (run) { job.runId = run.id; receipt.runId = run.id; }
  return { projection: snapshot.projection, run };
}
async function capacity() {
  const shell = await connection.http('/api/orchestration/shell');
  const archived = await connection.rpc('orchestration.getArchivedShellSnapshot', {});
  const threads = [...new Map([...shell.threads, ...archived.threads].map(thread => [thread.id, thread])).values()];
  const busy = activeNativeIds(threads);
  if (busy.size >= MAX_ACTIVE) throw new Error('Native capacity is occupied; no fixture model run was sent.');
  return busy.size;
}
async function stopOwn() {
  const deadline = Date.now() + 60000;
  let cancelCommand, cancelAccepted = false;
  while (Date.now() < deadline) {
    heartbeat();
    let own;
    try { own = await readOwn(); }
    catch (error) {
      if (error.code === 'NATIVE_HTTP_STATUS' && error.httpStatus === 404) {
        receipt.terminalVerified = false; receipt.cleanupReason = 'launch_not_observed'; return;
      }
      throw error;
    }
    const { projection, run } = own;
    if (run && terminal.has(run.status)) {
      receipt.finalStatus = run.status; receipt.terminalVerified = true;
      receipt.finalAttention = getNativeAttention(projection, run.id);
      return;
    }
    if (projection.runs.some(other => other.id !== run?.id && !terminal.has(other.status)))
      throw new Error('Foreign activity appeared in fixture chat; no thread-wide stop was sent.');
    if (run && (run.status === 'queued' || (run.rootNodeId && run.providerThreadId))) {
      const type = run.status === 'queued' ? 'queued-run.cancel' : 'run.interrupt';
      if (cancelCommand?.type !== type) {
        cancelCommand = { type, commandId: randomUUID(), threadId: job.threadId, runId: run.id,
          ...(type === 'run.interrupt' ? { holdQueue: true, reason: 'Isolated attention validation finished; do not answer pending requests.' } : {}) };
        cancelAccepted = false;
      }
      if (!cancelAccepted) {
        receipt.cancelCommand = { ...cancelCommand }; persist();
        try {
          await connection.rpc('orchestration.dispatchCommand', cancelCommand);
          cancelAccepted = true; receipt.cancelAccepted = true;
        } catch (error) {
          // The run can finish before an interrupt. Re-read before reusing the
          // same durable cancel ID; never launch again or cancel another run.
          receipt.cancelErrorCode = error.code || 'CANCEL_FAILED';
          if (requiresNativeReconnect(error)) await recover(error);
        }
      }
    }
    await delay(1000);
  }
  receipt.terminalVerified = false; receipt.cleanupReason = 'terminal_timeout';
}
try {
  acquired = state.acquireWorker(lease, process.pid, isAlive);
  assert.ok(acquired, 'A live bridge worker owns admission; no fixture was started.');
  assert.equal(state.pending().length, 0, 'Wait for existing bridge jobs before this opt-in fixture.');
  assert.equal(state.unsaved().length, 0, 'Existing bridge results must be saved first.');
  connection = await connectNative({ websocket: true });
  const modelSelection = assertFreeModel(await connection.rpc('server.getConfig', {}), job.model);
  receipt.capacityBefore = await capacity();
  mkdirSync(workspace, { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' }); receiptCreated = true;
  const instructions = '# Isolated native attention validation\nWork only in this directory. Do not read credentials, use network, install software, delegate, change settings, or modify other projects. Do not touch attention-live.json or AGENTS.md. The coordinator will observe a native permission card and cancel this test; never approve a request yourself.\n';
  writeFileSync(path.join(workspace, 'AGENTS.md'), instructions, { flag: 'wx' });
  await connection.rpc('projects.mutate', { type: 'project.create', commandId: randomUUID(),
    projectId: job.projectId, title: 'CoS phase2 attention validation', workspaceRoot: workspace });
  heartbeat();
  receipt.capacityImmediatelyBefore = await capacity();
  const command = { commandId: randomUUID(), threadId: job.threadId, projectId: job.projectId,
    title: 'CoS native approval attention fixture', generateTitle: false, modelSelection,
    runtimeMode: 'approval-required', interactionMode: 'default', workspaceStrategy: { type: 'root' },
    initialMessage: { messageId: job.messageId, attachments: [], text:
      'This is one isolated native permission-card test in ' + workspace + '. Use your normal write tool exactly once to create attention-probe.txt containing exactly: ATTENTION_PROBE. Submit the ordinary tool request so the app can show its native approval card. Do not replace the tool call with a conversational confirmation question. Do not approve or answer any request, change permissions, use shell commands, use network, delegate, or touch other files. The coordinator will observe the pending request and cancel this turn. If the app completes the write automatically, report that fact and stop; do not attempt another action.' } };
  receipt.launchCommandId = command.commandId; receipt.sendAttempts = 1; submitted = true; persist();
  try {
    const launched = await connection.rpc('orchestration.launchThread', command, 30000);
    assert.equal(launched.threadId, job.threadId); receipt.launchAcknowledged = true;
  } catch (error) {
    receipt.launchErrorCode = error.code || 'LAUNCH_FAILED'; persist();
    if (requiresNativeReconnect(error)) await recover(error);
    // Never replay: subsequent reads reconcile the one stable launch only.
  }
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    heartbeat();
    const { projection, run } = await readOwn();
    if (run) {
      receipt.observedStatus = run.status;
      const attention = getNativeAttention(projection, run.id);
      receipt.projectionArrays = Object.fromEntries(['runs', 'nodes', 'attempts', 'providerTurns', 'runtimeRequests', 'turnItems'].map(key => [key, Array.isArray(projection[key])]));
      if (attention.pendingCount > 0) {
        receipt.attentionObserved = attention.available;
        receipt.attention = attention;
        persist(); break;
      }
      if (terminal.has(run.status)) {
        receipt.attentionObserved = false; receipt.noAttentionReason = 'run_finished_without_pending_card';
        receipt.finalStatus = run.status; receipt.terminalVerified = true; persist(); break;
      }
    }
    await delay(1000);
  }
  if (!receipt.attention) receipt.noAttentionReason ||= 'bounded_observation_timeout';
} catch (error) {
  receipt.errorCode = error.code || 'FIXTURE_PRECONDITION_OR_ASSERTION_FAILED';
} finally {
  if (submitted && connection) {
    try { await stopOwn(); }
    catch (error) { receipt.cleanupErrorCode = error.code || 'CLEANUP_ASSERTION_FAILED'; receipt.terminalVerified = false; }
  }
  try { await retire(); } catch { receipt.localClientsRetired = false; }
  if (acquired) state.releaseWorker(lease);
  state.close();
  receipt.fixtureFileExists = existsSync(path.join(workspace, 'attention-probe.txt'));
  receipt.finishedAt = new Date().toISOString();
  receipt.passed = receipt.attentionObserved === true && receipt.terminalVerified === true && receipt.localClientsRetired === true;
  persist();
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.passed) process.exitCode = 1;
}


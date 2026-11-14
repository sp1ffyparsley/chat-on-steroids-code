import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HelperState, MAX_ACTIVE, publicJob, hash, helperAdmission } from './deepai-helper-state.mjs';
import { runCycle, activeNativeIds, requiresNativeReconnect, nativeReadiness, diagnosedJob } from './deepai-helper.mjs';

const config = { providers: [{ instanceId: 'deepai', enabled: true, installed: true, status: 'ready', models: [{ slug: 'deepai/glm-5.3-flash', subProvider: 'deepai', isCustom: false, theosPerRequest: '0', capabilities: { optionDescriptors: [{ id: 'thinking', type: 'select', options: [{ id: 'high' }] }] } }] }] };
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'cos-deepai-test-'));
  const state = new HelperState(path.join(root, 'state'));
  t.after(() => { state.close(); rmSync(root, { recursive: true, force: true }); });
  let serial = 0;
  function request(overrides = {}) { const index = ++serial, workspace = path.join(root, 'workspace-' + index); mkdirSync(workspace); return { owner: 'owner-' + index, requestKey: 'key-' + index, prompt: 'Bounded fixture task', workspace, ...overrides }; }
  return { root, state, request };
}
class FakeNative {
  constructor() { this.projects = []; this.projections = new Map(); this.extra = []; this.archived = []; this.calls = []; this.effects = new Set(); this.config = structuredClone(config); this.onLaunch = null; this.onConfig = null; }
  shells() { return [...this.projections.values()].map(p => ({ id: p.thread.id, providerInstanceId: 'deepai', status: p.runs.at(-1).status, activeRunId: ['completed','failed','cancelled','interrupted'].includes(p.runs.at(-1).status) ? null : p.runs.at(-1).id })); }
  async http(route) {
    if (route === '/api/orchestration/shell') return { projects: [...this.projects], threads: [...this.shells(), ...this.extra] };
    if (route.startsWith('/api/orchestration/threads/')) return { snapshotSequence: 44, projection: structuredClone(this.projections.get(decodeURIComponent(route.split('/').at(-1)))) };
    throw new Error('Unexpected HTTP fixture call');
  }
  async rpc(tag, payload) {
    this.calls.push({ tag, payload: structuredClone(payload) });
    if (tag === 'server.getConfig') { this.onConfig?.(); return this.config; }
    if (tag === 'orchestration.getArchivedShellSnapshot') return { projects: [], threads: this.archived };
    if (tag === 'projects.mutate') { const project = { id: payload.projectId, workspaceRoot: payload.workspaceRoot }; this.projects.push(project); return project; }
    if (tag === 'orchestration.getThreadProjection') { if (this.readError) throw this.readError; return structuredClone(this.projections.get(payload.threadId)); }
    if (tag === 'orchestration.launchThread') {
      if (this.onLaunch) await this.onLaunch(payload);
      if (!this.effects.has(payload.commandId)) {
        this.effects.add(payload.commandId);
        const run = { id: 'run-' + payload.threadId, threadId: payload.threadId, userMessageId: payload.initialMessage.messageId, providerInstanceId: 'deepai', modelSelection: payload.modelSelection, status: 'running', startedAt: new Date().toISOString(), rootNodeId: 'root', providerThreadId: 'provider-thread' };
        this.projections.set(payload.threadId, { thread: { id: payload.threadId, projectId: payload.projectId, runtimeMode: 'auto' }, runs: [run], nodes: [], attempts: [], providerTurns: [], messages: [], turnItems: [], runtimeRequests: [] });
      }
      if (this.failAfterAcceptance) { this.failAfterAcceptance = false; throw Object.assign(new Error('Lost response'), { code: 'NATIVE_RPC_TIMEOUT' }); }
      return { threadId: payload.threadId, projection: this.projections.get(payload.threadId), resumed: false };
    }
    if (tag === 'orchestration.dispatchCommand') {
      if (['run.interrupt','thread.stop','queued-run.cancel'].includes(payload.type)) { const p = this.projections.get(payload.threadId); p.runs.at(-1).status = payload.type === 'queued-run.cancel' ? 'cancelled' : 'interrupted'; p.runs.at(-1).completedAt = new Date().toISOString(); return { sequence: 1 }; }
      throw new Error('Unexpected fixture command');
    }
    throw new Error('Unexpected fixture RPC');
  }
  finish(threadId, text = 'actual response') { const p = this.projections.get(threadId); p.runs[0].status = 'completed'; p.runs[0].completedAt = new Date().toISOString(); p.messages.push({ id: 'final-' + threadId, runId: p.runs[0].id, role: 'assistant', text, streaming: false }); }
}

function coreFixture(t) {
  const fixtureData = fixture(t), { root, state, request } = fixtureData;
  const configRoot = path.join(root, 'parent'), durableRoot = path.join(configRoot, 'queue');
  mkdirSync(path.join(durableRoot, 'state'), { recursive: true });
  const control = { configRoot, durableRoot, accountKey: 'account-proof', sessionId: 'parent-session', conversationId: 'parent-conversation' };
  const input = request({ owner: 'cos-core:' + hash([control.accountKey, control.sessionId]), control });
  const job = state.enqueue(input).job;
  const config = { ui: { automationPaused: false }, readOnly: false, capabilities: { command: true } };
  const switches = { version: 1, switches: [{ conversationId: control.conversationId, enabled: true }] };
  const bindings = { version: 1, accountKey: control.accountKey, rows: [{ owner: job.owner, requestKey: job.requestKey,
    sessionId: control.sessionId, sourceConversationId: control.conversationId, jobId: job.id, workspace: job.workspace, model: job.model }] };
  const configFile = path.join(configRoot, 'config.json'), switchFile = path.join(durableRoot, 'state', 'goal-switches.json');
  const bindingFile = path.join(durableRoot, 'state', 'deepai-helper-bindings.json');
  const save = () => {
    writeFileSync(configFile, JSON.stringify(config)); writeFileSync(switchFile, JSON.stringify(switches));
    writeFileSync(bindingFile, JSON.stringify(bindings));
  };
  save();
  return { ...fixtureData, job, config, switches, bindings, configFile, switchFile, bindingFile, save };
}

test('durable account Pause and parent Off hold queued Core work; Resume keeps the original IDs', async t => {
  const f = coreFixture(t), native = new FakeNative();
  f.config.ui.automationPaused = true; f.save(); await runCycle(f.state, native);
  assert.equal(f.state.get(f.job.id).waitingFor, 'parent_paused'); assert.equal(native.effects.size, 0);
  f.config.ui.automationPaused = false; f.switches.switches[0].enabled = false; f.save(); await runCycle(f.state, native);
  assert.equal(f.state.get(f.job.id).waitingFor, 'parent_off'); assert.equal(native.effects.size, 0);
  f.switches.switches[0].enabled = true; f.save(); await runCycle(f.state, native);
  assert.equal(native.effects.size, 1); assert.equal(f.state.get(f.job.id).threadId, f.job.threadId);
  assert.equal(f.state.get(f.job.id).command.commandId, f.job.command.commandId);
  assert.equal(f.state.get(f.job.id).sendAttempts, 1);
});
test('Pause arriving during native preparation prevents the first launch', async t => {
  const f = coreFixture(t), native = new FakeNative();
  native.onConfig = () => { f.config.ui.automationPaused = true; f.save(); };
  await runCycle(f.state, native);
  assert.equal(native.effects.size, 0); assert.equal(f.state.get(f.job.id).status, 'queued');
  assert.equal(f.state.get(f.job.id).waitingFor, 'parent_paused');
  assert.equal(f.state.get(f.job.id).sendAttempts, undefined);
});
test('Pause does not interrupt accepted work and collection still saves its exact result', async t => {
  const f = coreFixture(t), native = new FakeNative(); await runCycle(f.state, native);
  f.config.ui.automationPaused = true; f.save(); await runCycle(f.state, native);
  assert.equal(f.state.get(f.job.id).status, 'active');
  assert.equal(native.calls.some(call => call.tag === 'orchestration.dispatchCommand'), false);
  native.finish(f.job.threadId); await runCycle(f.state, native);
  assert.equal(f.state.get(f.job.id).status, 'completed'); assert.ok(f.state.get(f.job.id).resultSavedAt);
});
test('explicit cancellation while held settles unsent work even without a native connection', async t => {
  const f = coreFixture(t); f.config.ui.automationPaused = true; f.save(); f.state.cancel(f.job.id, f.job.owner);
  await runCycle(f.state, null);
  assert.equal(f.state.get(f.job.id).status, 'cancelled'); assert.equal(f.state.get(f.job.id).sendAttempts, undefined);
});
test('ambiguous submission is observed under Pause but never retransmitted until Resume', async t => {
  const f = coreFixture(t), native = new FakeNative();
  f.state.patch(f.job.id, { status: 'submitting', submittedAt: new Date(0).toISOString(), lastSendAt: new Date(0).toISOString(), sendAttempts: 1 });
  f.config.ui.automationPaused = true; f.save(); await runCycle(f.state, native);
  assert.equal(native.effects.size, 0); assert.equal(f.state.get(f.job.id).status, 'submitting');
  assert.equal(f.state.get(f.job.id).sendAttempts, 1);
  f.config.ui.automationPaused = false; f.save(); await runCycle(f.state, native);
  assert.equal(native.effects.size, 1); assert.ok(native.effects.has(f.job.command.commandId));
});
test('unreadable or changed parent custody refuses admission without holding unrelated owners', async t => {
  const f = coreFixture(t), native = new FakeNative();
  writeFileSync(f.configFile, '{corrupt'); await runCycle(f.state, native);
  assert.equal(f.state.get(f.job.id).waitingFor, 'parent_control_unverified');
  f.save(); f.bindings.rows[0].sourceConversationId = 'other-parent'; f.save();
  const other = f.state.enqueue(f.request()).job; await runCycle(f.state, native);
  assert.equal(f.state.get(f.job.id).sendAttempts, undefined); assert.equal(f.state.get(other.id).status, 'active');
});
test('missing control bindings cannot turn old Core jobs into manual-label jobs', t => {
  const f = coreFixture(t);
  assert.deepEqual(helperAdmission({ ...f.job, control: undefined }), { allowed: false, reason: 'parent_control_unverified' });
  assert.throws(() => f.state.enqueue(f.request({ owner: f.job.owner })), /exact durable parent/);
  f.config.readOnly = true; f.save(); assert.equal(helperAdmission(f.job).reason, 'parent_command_disabled');
});

test('same owner/request key is durable and changed payload cannot silently reuse it', t => {
  const { state, request } = fixture(t), input = request();
  const first = state.enqueue(input), second = state.enqueue(input);
  assert.equal(first.job.id, second.job.id); assert.equal(second.reused, true);
  assert.throws(() => state.enqueue({ ...input, prompt: 'different' }), /different content/);
  assert.equal(state.pending().length, 1);
});
test('only authentication loss is renewable; a scope denial never widens permissions', () => {
  assert.equal(requiresNativeReconnect({ code: 'NATIVE_HTTP_STATUS', httpStatus: 401 }), true);
  assert.equal(requiresNativeReconnect({ code: 'NATIVE_HTTP_STATUS', httpStatus: 403 }), false);
  assert.equal(requiresNativeReconnect({ code: 'NATIVE_RPC_FAILED' }), false);
});
test('passive CLI inspection never starts a worker even with queued work', t => {
  const { state, request } = fixture(t), job = state.enqueue(request()).job;
  const script = fileURLToPath(new URL('./deepai-helper.mjs', import.meta.url));
  const response = JSON.parse(execFileSync(process.execPath, [script, 'status', '--job', job.id, '--owner', job.owner, '--state-root', state.root, '--no-worker'], { encoding: 'utf8', windowsHide: true }));
  assert.equal(response.id, job.id); assert.equal(response.status, 'queued');
  assert.equal(state.runtime('worker'), null); assert.equal(state.get(job.id).sendAttempts, undefined);
});
test('stdin submit recovers the same terminal request without exposing its prompt in argv', t => {
  const { state, request } = fixture(t), input = request(), job = state.enqueue(input).job;
  state.patch(job.id, { status: 'completed' });
  const script = fileURLToPath(new URL('./deepai-helper.mjs', import.meta.url));
  const response = JSON.parse(execFileSync(process.execPath, [script, 'submit', '--request', '-', '--state-root', state.root], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true }));
  assert.equal(response.id, job.id); assert.equal(response.reused, true);
  assert.equal(state.list().length, 1); assert.equal(state.runtime('worker'), null);
});
test('passive Core-facing reads diagnose a missing worker without launching or replacing work', t => {
  const { state, request } = fixture(t), job = state.enqueue(request()).job;
  state.patch(job.id, { status: 'active', runId: 'retained-run', sendAttempts: 1 });
  const script = fileURLToPath(new URL('./deepai-helper.mjs', import.meta.url));
  const call = action => JSON.parse(execFileSync(process.execPath, [script, action, '--owner', job.owner,
    ...(action === 'status' ? ['--job', job.id] : []), '--state-root', state.root, '--no-worker'], { encoding: 'utf8', windowsHide: true }));
  const status = call('status');
  assert.equal(status.workerStatus, 'unavailable'); assert.match(status.recovery, /original task/);
  assert.equal(call('inbox').jobs[0].id, job.id);
  assert.equal(state.get(job.id).sendAttempts, 1); assert.equal(state.get(job.id).runId, 'retained-run');
  assert.equal(state.runtime('worker'), null);
});
test('a stale live worker is reported for review rather than silently stolen', t => {
  const { state, request } = fixture(t), job = state.enqueue(request()).job;
  state.setRuntime('worker', { pid: process.pid, token: 'existing-lease', heartbeatAt: new Date(0).toISOString() });
  const script = fileURLToPath(new URL('./deepai-helper.mjs', import.meta.url));
  const status = JSON.parse(execFileSync(process.execPath, [script, 'status', '--job', job.id, '--owner', job.owner,
    '--state-root', state.root, '--no-worker'], { encoding: 'utf8', windowsHide: true }));
  assert.equal(status.workerStatus, 'stale'); assert.match(status.recovery, /review/i);
  assert.equal(state.runtime('worker').token, 'existing-lease'); assert.equal(state.get(job.id).sendAttempts, undefined);
});
test('native approval is bound to its run, surfaced without auto-answer, and cleared on resolution', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  await runCycle(state, native);
  const p = native.projections.get(job.threadId), run = p.runs[0]; run.status = 'waiting';
  p.nodes = [{ id: run.rootNodeId, threadId: job.threadId, runId: run.id }];
  p.runtimeRequests = [{ id: 'approval-one', nodeId: run.rootNodeId, kind: 'permission', status: 'pending', responseCapability: { providerSessionId: 'PRIVATE_SESSION' } }];
  p.turnItems = [{ id: 'item-one', threadId: job.threadId, runId: run.id, nodeId: run.rootNodeId, type: 'approval_request', requestId: 'approval-one', requestKind: 'permission', status: 'waiting', title: 'Allow fixture edit' }];
  await runCycle(state, native);
  const waiting = publicJob(state.get(job.id));
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.waitingFor, 'native_attention');
  assert.equal(waiting.attention.pendingCount, 1); assert.equal(waiting.attention.requests[0].type, 'approval');
  assert.equal(JSON.stringify(waiting).includes('PRIVATE_SESSION'), false);
  const fingerprint = waiting.attention.fingerprint;
  await runCycle(state, native); assert.equal(state.get(job.id).attention.fingerprint, fingerprint);
  assert.equal(native.calls.some(call => call.tag === 'orchestration.dispatchCommand'), false);
  p.runtimeRequests[0].status = 'resolved'; p.turnItems[0].status = 'completed'; run.status = 'running';
  await runCycle(state, native);
  assert.equal(state.get(job.id).attention.pendingCount, 0); assert.equal(state.get(job.id).waitingFor, null);
});
test('unavailable attention preserves prior pending notice instead of falsely clearing it', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  await runCycle(state, native);
  const p = native.projections.get(job.threadId), run = p.runs[0];
  state.patch(job.id, { attention: { available: true, pendingCount: 1, requests: [{ type: 'approval' }], fingerprint: 'prior' } });
  p.nodes = Array(20001).fill({ id: 'bounded-out', threadId: job.threadId, runId: run.id });
  await runCycle(state, native);
  assert.equal(state.get(job.id).attention.pendingCount, 1);
  assert.equal(state.get(job.id).attentionUnavailableReason, 'projection_too_large');
});
test('running native status still surfaces a real approval outside its bounded WS graph', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  await runCycle(state, native);
  const p = native.projections.get(job.threadId), run = p.runs[0];
  p.nodes = [{ id: run.rootNodeId, threadId: job.threadId, runId: run.id }];
  p.runtimeRequests = [{ id: 'write-approval', nodeId: run.rootNodeId, kind: 'command', status: 'pending' }];
  p.turnItems = [{ id: 'approval-card', threadId: job.threadId, runId: run.id, nodeId: run.rootNodeId, type: 'approval_request', requestId: 'write-approval', requestKind: 'file-change', status: 'waiting', title: 'Allow write?' }];
  const rpc = native.rpc.bind(native);
  native.rpc = async (tag, payload) => {
    const result = await rpc(tag, payload);
    if (tag === 'orchestration.getThreadProjection') { delete result.nodes; delete result.attempts; }
    return result;
  };
  await runCycle(state, native);
  assert.equal(state.get(job.id).nativeStatus, 'running');
  assert.equal(state.get(job.id).status, 'waiting');
  assert.equal(state.get(job.id).attention.requests[0].kind, 'file-change');
  assert.equal(state.get(job.id).attention.requests[0].title, 'Allow write?');
  assert.equal(native.calls.some(call => call.tag === 'orchestration.dispatchCommand'), false);
});
test('completed result never persists private approval, question, or secret request cards', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  await runCycle(state, native);
  const p = native.projections.get(job.threadId), run = p.runs[0];
  for (const type of ['approval_request', 'user_input_request', 'secret_request']) p.turnItems.push({
    id: type, threadId: job.threadId, runId: run.id, type, status: 'completed', requestId: type,
    secretStatus: 'resolved', secretLabel: 'PRIVATE_CARD_LABEL', prompt: 'PRIVATE_CARD_COMMAND',
    nativeRequestRef: 'PRIVATE_CARD_SESSION', questions: [{ initialAnswer: 'PRIVATE_CARD_ANSWER' }],
    questionAnswer: { answers: { value: 'PRIVATE_CARD_SECRET' } }
  });
  p.turnItems.push({ id: 'normal-tool', runId: run.id, type: 'tool', title: 'Legitimate test evidence', status: 'completed' });
  native.finish(job.threadId, 'Completed fixture report.');
  await runCycle(state, native);
  const saved = state.get(job.id);
  assert.equal(saved.resultSavedAt != null, true);
  assert.equal(JSON.stringify(saved.result).includes('PRIVATE_CARD_'), false);
  assert.equal(readFileSync(path.join(saved.resultDirectory, 'result.json'), 'utf8').includes('PRIVATE_CARD_'), false);
  assert.equal(saved.result.toolEvidence.items.length, 1);
  assert.equal(saved.result.toolEvidence.items[0].id, 'normal-tool');
});
test('a revoked client during result collection reconnects without replacing an accepted run', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  await runCycle(state, native);
  native.finish(job.threadId, 'saved exact completed turn');
  const http = native.http.bind(native);
  native.http = async route => {
    if (route.startsWith('/api/orchestration/threads/')) throw Object.assign(new Error('Local credential rejected'), { code: 'NATIVE_HTTP_STATUS', httpStatus: 401 });
    return http(route);
  };
  await assert.rejects(runCycle(state, native), error => requiresNativeReconnect(error));
  assert.equal(state.get(job.id).status, 'active');
  native.http = http;
  await runCycle(state, native);
  assert.equal(state.get(job.id).status, 'completed');
  assert.equal(state.get(job.id).resultSavedAt != null, true);
  assert.equal(state.get(job.id).sendAttempts, 1);
  assert.equal(native.calls.filter(call => call.tag === 'orchestration.launchThread').length, 1);
});
test('a wrong owner cannot fetch, cancel or continue another helper', t => {
  const { state, request } = fixture(t), job = state.enqueue(request()).job;
  assert.throws(() => state.get(job.id, 'wrong'), /another owner/);
  assert.throws(() => state.cancel(job.id, 'wrong'), /another owner/);
  assert.throws(() => state.enqueue(request({ owner: 'wrong' }), job.id), /another owner/);
  assert.equal(state.get(job.id).cancelRequestedAt, null);
});
test('twelve distinct parents admit at most two real jobs and preserve ten queued', async t => {
  const { state, request } = fixture(t), native = new FakeNative();
  for (let index = 0; index < 12; index++) state.enqueue(request());
  await runCycle(state, native);
  assert.equal(native.effects.size, MAX_ACTIVE); assert.equal(state.pending().filter(job => job.status === 'queued').length, 10);
  assert.equal(new Set(state.list().map(job => job.threadId)).size, 12);
});
test('existing manual and archived waiting work reserve native capacity', async t => {
  const { state, request } = fixture(t), native = new FakeNative(); state.enqueue(request());
  native.extra.push({ id: 'manual', providerInstanceId: 'deepai', activeRunId: 'manual-run' });
  native.archived.push({ id: 'archived', providerInstanceId: 'deepai', activityRunStatus: 'waiting' });
  await runCycle(state, native); assert.equal(native.effects.size, 0); assert.equal(state.pending()[0].waitingFor, 'native_capacity');
});
test('workspace serialization prevents two helpers writing the same directory', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), first = request();
  state.enqueue(first); state.enqueue({ ...first, owner: 'second', requestKey: 'second' });
  await runCycle(state, native); assert.equal(native.effects.size, 1); assert.equal(state.pending().filter(job => job.waitingFor === 'workspace').length, 1);
});
test('completed native chat with background work still reserves its assigned workspace', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), first = request(), job = state.enqueue(first).job;
  await runCycle(state, native); native.finish(job.threadId); await runCycle(state, native);
  native.extra.push({ id: job.threadId, providerInstanceId: 'deepai', status: 'completed', pendingBackgroundTasks: ['still-running-command'] });
  const next = state.enqueue({ ...first, owner: 'next-owner', requestKey: 'next-request' }).job;
  await runCycle(state, native);
  assert.equal(state.get(next.id).waitingFor, 'workspace'); assert.equal(native.effects.size, 1);
  native.extra = [];
  await runCycle(state, native); assert.equal(state.get(next.id).status, 'active'); assert.equal(native.effects.size, 2);
});
test('accepted launch with lost reply is reconciled without another launch', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  native.failAfterAcceptance = true;
  await runCycle(state, native); assert.equal(state.get(job.id).status, 'submitting');
  await runCycle(state, native, { now: Date.now() + 11000 });
  assert.equal(state.get(job.id).status, 'active');
  assert.equal(native.calls.filter(call => call.tag === 'orchestration.launchThread').length, 1);
});
test('ambiguous unaccepted launch does not bypass newly occupied capacity', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  state.patch(job.id, { status: 'submitting', submittedAt: new Date(0).toISOString(), lastSendAt: new Date(0).toISOString() });
  native.extra.push(...['a','b'].map(id => ({ id, providerInstanceId: 'deepai', activeRunId: id })));
  await runCycle(state, native); assert.equal(native.effects.size, 0);
});
test('cancelled queued work never invokes native inference', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  state.cancel(job.id, job.owner); await runCycle(state, native);
  assert.equal(state.get(job.id).status, 'cancelled'); assert.equal(native.calls.length, 0);
});
test('cancellation during preflight is rechecked at atomic submission claim', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  native.onConfig = () => state.cancel(job.id, job.owner);
  await runCycle(state, native);
  assert.equal(state.get(job.id).status, 'cancelled'); assert.equal(native.effects.size, 0);
});
test('unseen ambiguous cancellation does not replay a model launch', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  state.patch(job.id, { status: 'submitting', lastSendAt: new Date(0).toISOString() }); state.cancel(job.id, job.owner);
  await runCycle(state, native); assert.equal(native.effects.size, 0); assert.match(state.get(job.id).lastError, /not be replayed/);
});
test('active cancellation waits for native terminal state before reporting cancelled', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  await runCycle(state, native); state.cancel(job.id, job.owner); await runCycle(state, native);
  assert.equal(state.get(job.id).status, 'stopping');
  await runCycle(state, native); assert.equal(state.get(job.id).status, 'cancelled');
  assert.equal(state.get(job.id).result.run.status, 'interrupted');
});
test('terminal collection pins exact run, saves full text, and excludes another run', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  await runCycle(state, native); native.finish(job.threadId, 'full exact result');
  native.projections.get(job.threadId).messages.push({ id: 'foreign', runId: 'another-run', role: 'assistant', text: 'wrong result', streaming: false });
  await runCycle(state, native);
  const result = state.get(job.id);
  assert.equal(result.status, 'completed'); assert.equal(result.result.assistantText, 'full exact result'); assert.ok(result.resultSavedAt);
  const saved = JSON.parse(readFileSync(path.join(result.resultDirectory, 'result.json'), 'utf8'));
  assert.equal(saved.messageId, job.messageId); assert.equal(saved.messages.length, 1); assert.equal(saved.independentVerification, 'required');
});
test('empty final response is incomplete instead of a false success', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  await runCycle(state, native); native.finish(job.threadId, ''); await runCycle(state, native);
  assert.equal(state.get(job.id).status, 'incomplete');
});
test('paid catalog change blocks admission instead of selecting a fallback', async t => {
  const { state, request } = fixture(t), native = new FakeNative(), job = state.enqueue(request()).job;
  native.config.providers[0].models[0].theosPerRequest = '3'; await runCycle(state, native);
  assert.equal(state.get(job.id).status, 'blocked'); assert.equal(native.effects.size, 0);
});
test('dead connection is surfaced to worker for reconnection', async t => {
  const { state, request } = fixture(t), native = new FakeNative(); state.enqueue(request()); await runCycle(state, native);
  native.readError = Object.assign(new Error('socket closed'), { code: 'NATIVE_SOCKET_CLOSED' });
  await assert.rejects(runCycle(state, native), /socket closed/);
});
test('single worker lease cannot be stolen from a live process', t => {
  const { state } = fixture(t);
  assert.equal(state.acquireWorker('first', 123, () => true), true);
  assert.equal(state.acquireWorker('second', 456, () => true), false);
  assert.equal(state.heartbeat('second'), false);
  state.releaseWorker('second'); assert.equal(state.runtime('worker').token, 'first');
  assert.equal(state.acquireWorker('replacement', 456, () => false), true);
});
test('idle exit cannot drop queued work in the worker release transaction', t => {
  const { state, request } = fixture(t); state.acquireWorker('worker', 1, () => false);
  state.enqueue(request()); assert.equal(state.releaseIfIdle('worker'), false); assert.equal(state.runtime('worker').token, 'worker');
});
test('active native counting deduplicates and includes waiting/background work', () => {
  const threads = [{id:'a',providerInstanceId:'deepai',activeRunId:'r'}, {id:'a',providerInstanceId:'deepai',status:'running'}, {id:'b',providerInstanceId:'deepai',pendingBackgroundTasks:[{}]}, {id:'c',providerInstanceId:'other',status:'running'}];
  assert.deepEqual([...activeNativeIds(threads)], ['a','b']);
});
test('native queued cancellation uses queued-run.cancel instead of an invalid interrupt', async t => {
  const {state,request}=fixture(t), native=new FakeNative(), job=state.enqueue(request()).job;
  await runCycle(state,native); const run=native.projections.get(job.threadId).runs[0]; run.status='queued';run.rootNodeId=null;run.providerThreadId=null;
  state.cancel(job.id,job.owner); await runCycle(state,native);
  assert.equal(native.calls.filter(c=>c.tag==='orchestration.dispatchCommand').at(-1).payload.type,'queued-run.cancel');
  await runCycle(state,native);assert.equal(state.get(job.id).status,'cancelled');
});
test('preparing cancellation waits for a valid native execution node', async t => {
  const {state,request}=fixture(t), native=new FakeNative(), job=state.enqueue(request()).job;
  await runCycle(state,native);const run=native.projections.get(job.threadId).runs[0];run.status='preparing';run.rootNodeId=null;run.providerThreadId=null;
  state.cancel(job.id,job.owner);await runCycle(state,native);
  assert.equal(native.calls.filter(c=>c.tag==='orchestration.dispatchCommand').length,0);
  assert.equal(state.get(job.id).status,'stopping');
  run.status='running';run.rootNodeId='root';run.providerThreadId='provider';await runCycle(state,native);
  assert.equal(native.calls.filter(c=>c.tag==='orchestration.dispatchCommand').at(-1).payload.type,'run.interrupt');
});
test('result capture rejects a moved native project', async t => {
  const {state,request}=fixture(t), native=new FakeNative(), job=state.enqueue(request()).job;
  await runCycle(state,native);native.finish(job.threadId);native.projections.get(job.threadId).thread.projectId='foreign-project';
  await runCycle(state,native);assert.equal(state.get(job.id).result,undefined);assert.match(state.get(job.id).lastError,/another project/);
});
test('a continuation cannot run before result files are saved', async t => {
  const {state,request}=fixture(t), native=new FakeNative(), job=state.enqueue(request()).job;
  await runCycle(state,native);native.finish(job.threadId);await runCycle(state,native);state.patch(job.id,{resultSavedAt:null});
  assert.throws(()=>state.enqueue({owner:job.owner,requestKey:'next',prompt:'Follow up'},job.id),/Save the completed result/);
});
test('a changed native project root blocks continuation before dispatch', async t => {
  const {state,request}=fixture(t), native=new FakeNative(), job=state.enqueue(request()).job;
  await runCycle(state,native);native.finish(job.threadId);await runCycle(state,native);
  const next=state.enqueue({owner:job.owner,requestKey:'next',prompt:'Follow up'},job.id).job;
  native.projects[0].workspaceRoot=path.join(job.workspace,'different');await runCycle(state,native);
  assert.equal(native.calls.filter(c=>c.tag==='orchestration.dispatchCommand').length,0);
  assert.match(state.get(next.id).lastError,/workspace changed/);
});
test('recovery full-reads a missing bounded run even without a saved run ID', async t => {
  const {state,request}=fixture(t), native=new FakeNative(), job=state.enqueue(request()).job;
  await runCycle(state,native);native.finish(job.threadId,'recovered exact text');state.patch(job.id,{status:'submitting',runId:null});
  const original=native.rpc.bind(native);
  native.rpc=async(tag,payload)=>tag==='orchestration.getThreadProjection'?{...structuredClone(native.projections.get(payload.threadId)),runs:[],messages:[]}:original(tag,payload);
  await runCycle(state,native);
  assert.equal(state.get(job.id).status,'completed');assert.equal(state.get(job.id).result.assistantText,'recovered exact text');
  assert.equal(native.calls.filter(c=>c.tag==='orchestration.launchThread').length,1);
});
test('redirected result directory cannot create directories in another workspace', t => {
  const {root,state,request}=fixture(t), input=request(), outside=path.join(root,'outside');mkdirSync(outside);
  mkdirSync(path.join(input.workspace,'.cos-deepai'));symlinkSync(outside,path.join(input.workspace,'.cos-deepai','results'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>state.enqueue(input),/symlink/);assert.deepEqual(readdirSync(outside),[]);
});


test('readiness checks only native configuration, closes connections and refuses changed free eligibility', async () => {
  let closed = 0, tags = [];
  const connection = { descriptor: { serverVersion: '0.3.36', orchestrationProtocolVersion: 2 },
    rpc: async tag => { tags.push(tag); return config; }, close: async () => { closed++; } };
  const ready = await nativeReadiness(async () => connection);
  assert.equal(ready.ready, true); assert.equal(ready.maxActive, 2);
  assert.deepEqual(tags, ['server.getConfig']); assert.equal(closed, 1);
  const changed = structuredClone(config); changed.providers[0].models[0].theosPerRequest = '1';
  const refused = await nativeReadiness(async () => ({ ...connection, rpc: async () => changed }));
  assert.equal(refused.ready, false); assert.equal(refused.blocker.code, 'FREE_MODEL_UNAVAILABLE'); assert.equal(closed, 2);
  for (const code of ['NATIVE_RUNTIME_UNAVAILABLE', 'NATIVE_VERSION_UNSUPPORTED', 'NATIVE_AUTH_INVALID']) {
    const failed = await nativeReadiness(async () => { throw Object.assign(new Error('private detail'), { code }); });
    assert.equal(failed.blocker.code, code); assert.equal(JSON.stringify(failed).includes('private detail'), false);
  }
});
test('diagnostics distinguish capacity, native attention, report failure and missing queue without changing jobs', t => {
  const { state, request } = fixture(t);
  const job = state.enqueue(request()).job;
  const missing = diagnosedJob(state, job); assert.equal(missing.blocker.code, 'queue_unavailable');
  state.patch(job.id, { waitingFor: 'native_capacity' });
  assert.equal(diagnosedJob(state, state.get(job.id)).blocker.code, 'native_capacity');
  state.patch(job.id, { status: 'waiting', attention: { pendingCount: 1 } });
  assert.equal(diagnosedJob(state, state.get(job.id)).blocker.code, 'native_attention');
  state.patch(job.id, { status: 'completed', attention: null, resultSaveError: 'Disk full' });
  assert.equal(diagnosedJob(state, state.get(job.id)).blocker.code, 'report_not_saved');
  assert.equal(state.get(job.id).id, job.id); assert.equal(state.list().length, 1);
});

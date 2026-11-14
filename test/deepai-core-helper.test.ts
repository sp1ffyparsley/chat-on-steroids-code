import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  createDeepAIHelperOwner, resolveDeepAIHelperRuntime, supportsDeepAIHelperNode,
  type BridgeCall, type BridgeRequest, type HelperOwnerDependencies, type HelperParent
} from '../src/main/deepai-helper.js';
import { readDurableStrict, writeDurableNow, initDurableStore, resetDurableForTests, flushDurable } from '../src/main/durable.js';
import { emptyEvidence, type CallContext } from '../src/main/mcp/call-context.js';
import { deepAIHelperSchema } from '../src/main/mcp/deepai-helper-tool.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
let now: number;
let scope: { key: string; token: object; deviceId: string; profileId: string };
let allowed: boolean;
let sessions: Map<string, { conversationId: string }>;
let jobs: Map<string, Record<string, any>>;
let calls: BridgeRequest[];
let bridge: Mock<BridgeCall>;
let deps: HelperOwnerDependencies;
let owner: ReturnType<typeof createDeepAIHelperOwner>;

beforeEach(async () => {
  directory = await makeTempDir('cos-deepai-parent-');
  initDurableStore(directory);
  now = 100000;
  scope = { key: 'account-a', token: {}, deviceId: 'device-a', profileId: 'profile-a' };
  allowed = true;
  sessions = new Map([['session-parent-a', { conversationId: 'conversation-a' }], ['session-parent-b', { conversationId: 'conversation-b' }]]);
  jobs = new Map(); calls = [];
  bridge = vi.fn<BridgeCall>(async (request: BridgeRequest) => {
    calls.push(structuredClone(request));
    if (request.action === 'submit' || request.action === 'continue') {
      const input = request.request!;
      let job = [...jobs.values()].find(job => job.owner === input.owner && job.requestKey === input.requestKey);
      if (!job) {
        const id = randomUUID();
        job = { id, owner: input.owner, requestKey: input.requestKey, status: 'queued',
          workspace: input.workspace, model: input.model, threadId: randomUUID(), messageId: randomUUID(),
          resultDirectory: path.join(String(input.workspace), '.cos-deepai', 'results', id), resultSaved: false };
        jobs.set(id, job);
      }
      return structuredClone(job);
    }
    if (request.action === 'inbox') return { jobs: [...jobs.values()].filter(job =>
      job.owner === request.owner && !job.acknowledged &&
      (['completed', 'failed', 'cancelled', 'blocked', 'incomplete'].includes(job.status) || job.attention?.pendingCount > 0 ||
        ['unavailable', 'stale'].includes(job.workerStatus) || job.waitingFor === 'native_unavailable')).map(job => structuredClone(job)) };
    const job = jobs.get(request.job!)!;
    if (!job || job.owner !== request.owner) throw new Error('fixture ownership refusal');
    if (request.action === 'cancel') job.cancelRequested = true;
    if (request.action === 'ack') job.acknowledged = true;
    if (request.action === 'result') return { ...structuredClone(job), assistantText: 'A model claim, not proof.',
      offset: 0, totalCharacters: 24, nextOffset: null, verification: 'required' };
    return structuredClone(job);
  });
  deps = {
    scope: () => scope, currentSession: async id => sessions.get(id) ?? null, automationAllowed: () => allowed,
    read: () => readDurableStrict('deepai-helper-bindings'), write: ledger => writeDurableNow('deepai-helper-bindings', ledger),
    bridge, now: () => now
  };
  owner = createDeepAIHelperOwner(deps);
});
afterEach(async () => { await flushDurable(); resetDurableForTests(); await removeTempDir(directory); });

const principal = (id = 'a') => owner.parent({
  requestId: 'exact-request-' + id, conversationId: 'conversation-' + id,
  sessionId: 'session-parent-' + id, transportKey: null
});
const request = (key = 'implement-parser') => ({ requestKey: key, workspace: directory, prompt: 'Implement a bounded parser task.' });
function context(parent: HelperParent, publication = { completedAt: null as number | null, failed: false }): CallContext {
  return { caller: { requestId: 'later-exact-request', sessionId: parent.sessionId, conversationId: parent.conversationId, transportKey: null },
    publication, startedAt: now, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence() };
}
function complete(id: unknown, status = 'completed') {
  Object.assign(jobs.get(String(id))!, { status, resultSaved: true, completedAt: new Date(now).toISOString() });
}

it('requires all three exact Core identity fields and never infers a parent from session listing', async () => {
  for (const missing of ['requestId', 'sessionId', 'conversationId']) {
    const caller = { requestId: 'req', sessionId: 'session-parent-a', conversationId: 'conversation-a', transportKey: null, [missing]: null };
    await expect(owner.parent(caller)).rejects.toThrow('CALLER_IDENTITY_REQUIRED');
  }
  expect(bridge).not.toHaveBeenCalled();
});
it('strictly rejects claimed owner, parent, response resolutions and action-inappropriate arguments', () => {
  for (const field of ['owner', 'sessionId', 'parent', 'parentSessionId'])
    expect(() => deepAIHelperSchema.parse({ action: 'submit', ...request(), [field]: 'foreign' })).toThrow();
  expect(() => deepAIHelperSchema.parse({ action: 'approve', job: randomUUID() })).toThrow();
  expect(() => deepAIHelperSchema.parse({ action: 'inbox', prompt: 'execute me' })).toThrow();
  expect(() => deepAIHelperSchema.parse({ action: 'continue', requestKey: 'x', prompt: 'x', job: randomUUID(), model: 'paid' })).toThrow();
});
it('persists exact parent intent before launch and sends the internally derived owner without a role limit', async () => {
  bridge.mockImplementationOnce(async (input: BridgeRequest) => {
    const ledger = await readDurableStrict<any>('deepai-helper-bindings');
    expect(ledger.rows[0]).toMatchObject({ sessionId: 'session-parent-a', sourceConversationId: 'conversation-a', sourceRequestId: 'exact-request-a', jobId: null });
    expect(input.request?.prompt).toContain('Implement');
    const id = randomUUID();
    const job = { id, owner: input.owner, requestKey: input.request!.requestKey, workspace: directory, model: 'deepai/glm-5.3-flash', status: 'queued' };
    jobs.set(id, job); return job;
  });
  const result = await owner.submit(await principal(), request());
  expect(result.status).toBe('queued');
  expect(result).not.toHaveProperty('owner');
  expect(result).toMatchObject({ source: 'deepai-model-report', verification: 'independent-verification-required' });
});
it('reuses one job for concurrent identical keys and rejects a changed body', async () => {
  const parent = await principal();
  const [one, two] = await Promise.all([owner.submit(parent, request()), owner.submit(parent, request())]);
  expect(one.id).toBe(two.id); expect(jobs.size).toBe(1);
  expect(calls.filter(call => call.action === 'submit')).toHaveLength(1);
  await expect(owner.submit(parent, { ...request(), prompt: 'Different work' })).rejects.toThrow('DEEPAI_REQUEST_KEY_CONFLICT');
  expect(jobs.size).toBe(1);
});
it('isolates equal request keys between concurrent parents and refuses foreign status/cancel/ack', async () => {
  const a = await principal('a'), b = await principal('b');
  const [one, two] = await Promise.all([owner.submit(a, request()), owner.submit(b, request())]);
  expect(one.id).not.toBe(two.id);
  for (const action of ['status', 'cancel', 'ack'] as const)
    await expect(owner.inspect(b, action, String(one.id))).rejects.toThrow('DEEPAI_JOB_NOT_OWNED');
  expect(calls.filter(call => ['cancel', 'ack'].includes(call.action))).toHaveLength(0);
});
it('recovers an accepted but lost submission with the same bridge key after restart', async () => {
  const ordinary = bridge.getMockImplementation()!;
  bridge.mockImplementationOnce(async input => { await ordinary(input); throw new Error('lost response'); });
  await expect(owner.submit(await principal(), request())).rejects.toThrow('lost response');
  expect(jobs.size).toBe(1);
  owner = createDeepAIHelperOwner(deps);
  const replay = await owner.submit(await principal(), request());
  expect(jobs.size).toBe(1);
  expect(replay.id).toBe([...jobs.keys()][0]);
  const sends = calls.filter(call => call.action === 'submit');
  expect(sends).toHaveLength(2);
  expect(sends[1]!.request).toEqual(sends[0]!.request);
});
it('can attach the terminal receipt for an ambiguous submit without dispatching replacement work', async () => {
  const ordinary = bridge.getMockImplementation()!;
  bridge.mockImplementationOnce(async input => { const job = await ordinary(input); complete((job as any).id); throw new Error('lost'); });
  await expect(owner.submit(await principal(), request())).rejects.toThrow('lost');
  owner = createDeepAIHelperOwner(deps);
  const notice = await owner.offer(context(await principal()), 8000);
  expect(notice).toContain([...jobs.keys()][0]);
  expect(calls.filter(call => call.action === 'submit')).toHaveLength(1);
});
it('refuses corrupted custody before any bridge operation', async () => {
  await fs.mkdir(path.join(directory, 'state'), { recursive: true });
  await fs.writeFile(path.join(directory, 'state', 'deepai-helper-bindings.json'), '{"partial":');
  await expect(owner.submit(await principal(), request())).rejects.toThrow();
  expect(bridge).not.toHaveBeenCalled();
});
it('leaves results pending during account/chat holds without polling or creating input', async () => {
  const parent = await principal();
  const job = await owner.submit(parent, request()); complete(job.id);
  bridge.mockClear(); allowed = false;
  expect(await owner.offer(context(parent), 8000)).toBeNull();
  expect(bridge).not.toHaveBeenCalled();
  await expect(owner.submit(parent, request('another'))).rejects.toThrow('DEEPAI_PARENT_PAUSED');
  allowed = true; now += 6000;
  expect(await owner.offer(context(parent), 8000)).toContain(String(job.id));
});
it('exposes stalled worker custody on a later exact-parent reply without starting a worker', async () => {
  const parent = await principal(), job = await owner.submit(parent, request());
  Object.assign(jobs.get(String(job.id))!, { status: 'active', workerStatus: 'unavailable', recovery: 'Recover the original task; do not replace it.' });
  calls.length = 0;
  const notice = await owner.offer(context(parent), 8000);
  expect(notice).toContain('Helper recovery needs attention: unavailable');
  expect(notice).toContain(String(job.id));
  expect(calls).toEqual([{ action: 'inbox', owner: parent.owner, passive: true }]);
  expect(await owner.offer(context(await principal('b')), 8000)).toBeNull();
});
it('recovers only an owned job through the existing worker check while retaining parent Pause', async () => {
  const parent = await principal(), job = await owner.submit(parent, request());
  allowed = false; calls.length = 0;
  await expect(owner.inspect(await principal('b'), 'recover', String(job.id))).rejects.toThrow('DEEPAI_JOB_NOT_OWNED');
  expect(calls).toHaveLength(0);
  const recovered = await owner.inspect(parent, 'recover', String(job.id));
  expect(recovered).toMatchObject({ id: job.id, recoveryRequested: true });
  expect(calls).toEqual([{ action: 'status', owner: parent.owner, job: job.id, passive: false }]);
  expect(allowed).toBe(false); expect(jobs.size).toBe(1);
  expect(() => deepAIHelperSchema.parse({ action: 'recover', job: job.id })).not.toThrow();
  expect(() => deepAIHelperSchema.parse({ action: 'recover', job: job.id, prompt: 'replacement' })).toThrow();
});
it('refuses a changed target and rebinds only through the same durable session current conversation', async () => {
  const parent = await principal();
  const job = await owner.submit(parent, request()); complete(job.id);
  sessions.set(parent.sessionId, { conversationId: 'conversation-resumed' });
  await expect(owner.offer(context(parent), 8000)).rejects.toThrow('DEEPAI_PARENT_CHANGED');
  const resumed = await owner.parent({ requestId: 'resumed-exact', sessionId: parent.sessionId, conversationId: 'conversation-resumed', transportKey: null });
  expect(resumed.owner).toBe(parent.owner);
  expect(await owner.offer(context(resumed), 8000)).toContain(String(job.id));
});
it('does not adopt manual CLI jobs or another profile even when they use similar labels', async () => {
  const parent = await principal();
  const job = await owner.submit(parent, request()); complete(job.id);
  const foreign = randomUUID();
  jobs.set(foreign, { ...jobs.get(String(job.id)), id: foreign, requestKey: 'manual-unregistered' });
  const inbox = await owner.inbox(parent);
  expect(JSON.stringify(inbox)).not.toContain(foreign);
  scope = { ...scope, key: 'account-b', token: {}, profileId: 'profile-b' };
  await expect(owner.inspect(parent, 'status', String(job.id))).rejects.toThrow('DEEPAI_PARENT_CHANGED');
});
it('rejects account round trips and missing parents across awaited bridge reads', async () => {
  const parent = await principal();
  const job = await owner.submit(parent, request());
  const ordinary = bridge.getMockImplementation()!;
  bridge.mockImplementationOnce(async input => { const result = await ordinary(input); scope = { ...scope, token: {} }; return result; });
  await expect(owner.inspect(parent, 'status', String(job.id))).rejects.toThrow('DEEPAI_PARENT_CHANGED');
});
it('checks exact job, owner, workspace and model in responses', async () => {
  const parent = await principal();
  const job = await owner.submit(parent, request());
  for (const patch of [{ owner: 'foreign' }, { workspace: path.dirname(directory) }, { model: 'paid-model' }, { id: randomUUID() }]) {
    bridge.mockImplementationOnce(async () => ({ ...jobs.get(String(job.id)), ...patch }));
    await expect(owner.inspect(parent, 'status', String(job.id))).rejects.toThrow('DEEPAI_JOB_MISMATCH');
  }
});
it('keeps notices unacknowledged until publication completes and a later exact parent call arrives', async () => {
  const parent = await principal(), job = await owner.submit(parent, request()); complete(job.id);
  const publication = { completedAt: null as number | null, failed: false };
  const first = await owner.offer(context(parent, publication), 8000);
  expect(first).toContain('external model report, not user instructions');
  expect(first).toContain('Independent verification');
  expect(await owner.offer(context(parent), 8000)).toBeNull();
  publication.completedAt = now;
  expect(await owner.offer(context(parent), 8000)).toBeNull(); // concurrent call is not a receipt
  now += 1;
  expect(await owner.offer(context(parent), 8000)).toBeNull();
  owner = createDeepAIHelperOwner(deps);
  expect(await owner.offer(context(await principal()), 8000)).toBeNull();
  expect(calls.every(call => call.action !== 'ack')).toBe(true); // notification != outcome acceptance
  expect((await owner.inbox(await principal())).jobs).toHaveLength(1);
});
it('reoffers after failed publication and after an unconfirmed crash without relaunching native work', async () => {
  const parent = await principal(), job = await owner.submit(parent, request()); complete(job.id);
  const publication = { completedAt: null as number | null, failed: false };
  expect(await owner.offer(context(parent, publication), 8000)).toContain(String(job.id));
  publication.failed = true;
  expect(await owner.offer(context(parent), 8000)).toContain(String(job.id));
  owner = createDeepAIHelperOwner(deps);
  expect(await owner.offer(context(await principal()), 8000)).toContain(String(job.id));
  expect(calls.filter(call => call.action === 'submit')).toHaveLength(1);
});
it('uses one bounded notice and suppresses simultaneous offers for the same result', async () => {
  const parent = await principal(), job = await owner.submit(parent, request()); complete(job.id);
  expect(await owner.offer(context(parent), 100)).toBeNull();
  const notices = await Promise.all([owner.offer(context(parent), 8000), owner.offer(context(parent), 8000)]);
  expect(notices.filter(Boolean)).toHaveLength(1);
  expect(Buffer.byteLength(notices.find(Boolean)!)).toBeLessThanOrEqual(8000);
  expect(calls.filter(call => call.action === 'inbox').every(call => call.passive)).toBe(true);
});
it('reoffers only the passive notice after bounded transport ambiguity without accepting the report', async () => {
  const parent = await principal(), job = await owner.submit(parent, request()); complete(job.id);
  expect(await owner.offer(context(parent), 8000)).toContain(String(job.id));
  now += 29_999;
  expect(await owner.offer(context(parent), 8000)).toBeNull();
  now += 2;
  expect(await owner.offer(context(parent), 8000)).toContain(String(job.id));
  expect(calls.filter(call => call.action === 'submit')).toHaveLength(1);
  expect(calls.some(call => call.action === 'ack')).toBe(false);
});
it('withholds completion notices until the report is saved, then publishes the saved outcome', async () => {
  const parent = await principal(), job = await owner.submit(parent, request());
  Object.assign(jobs.get(String(job.id))!, { status: 'completed', resultSaved: false });
  const publication = { completedAt: null as number | null, failed: false };
  expect(await owner.offer(context(parent, publication), 8000)).toBeNull();
  publication.completedAt = now;
  now += 6000;
  jobs.get(String(job.id))!.resultSaved = true;
  expect(await owner.offer(context(parent), 8000)).toContain('Saved report:');
  expect(calls.filter(call => call.action === 'inbox')).toHaveLength(2);
});
it('reports a save failure without publishing successful completion or claiming a saved report', async () => {
  const parent = await principal(), job = await owner.submit(parent, request());
  Object.assign(jobs.get(String(job.id))!, { status: 'completed', resultSaved: false, workerStatus: 'unavailable', resultSaveError: 'Disk full' });
  const notice = await owner.offer(context(parent), 8000);
  expect(notice).toContain('Helper recovery needs attention'); expect(notice).toContain('Report save failed: Disk full');
  expect(notice).not.toContain('Native task outcome: completed'); expect(notice).not.toContain('Saved report:');
});
it('reports pending secret/approval attention with nullable IDs even when the graph is incomplete', async () => {
  const parent = await principal(), job = await owner.submit(parent, request());
  Object.assign(jobs.get(String(job.id))!, { status: 'waiting', attentionUnavailableReason: 'incomplete_graph',
    attention: { available: false, pendingCount: 1, fingerprint: 'attention-1', reason: 'incomplete_graph',
      requests: [{ id: 'secret-1', requestId: null, itemId: 'secret-1', type: 'secret', title: 'Secret required in DeepAI Code', reason: 'x'.repeat(512), userOnly: true }] } });
  const notice = await owner.offer(context(parent), 8000);
  expect(notice).toContain('User attention required');
  expect(notice).toContain('incomplete or possibly stale');
  expect(notice).toContain('cannot answer or approve');
  expect(calls.some(call => !['submit', 'inbox'].includes(call.action))).toBe(false);
});
it('does not report an available but empty attention projection as a pending approval', async () => {
  const parent = await principal(), job = await owner.submit(parent, request());
  Object.assign(jobs.get(String(job.id))!, { status: 'active', attention: { available: true, pendingCount: 0, fingerprint: 'empty', requests: [] } });
  expect(await owner.offer(context(parent), 8000)).toBeNull();
});
it('paginates reports without copying their text into the parent custody ledger and requires explicit outcome ack', async () => {
  const parent = await principal(), job = await owner.submit(parent, request()); complete(job.id);
  const result = await owner.inspect(parent, 'result', String(job.id), { offset: 0, limit: 8000 });
  expect(result.assistantText).toBe('A model claim, not proof.');
  expect(JSON.stringify(await readDurableStrict('deepai-helper-bindings'))).not.toContain('A model claim');
  await owner.inspect(parent, 'ack', String(job.id));
  expect(await owner.offer(context(parent), 8000)).toBeNull();
  expect((await owner.inbox(parent)).jobs).toHaveLength(0);
});
it('continues only an owned registered job with the same workspace/model and a new key', async () => {
  const parent = await principal(), job = await owner.submit(parent, request()); complete(job.id);
  const next = await owner.submit(parent, { job: String(job.id), requestKey: 'fix-followup', prompt: 'Fix the discovered regression.' });
  const command = calls.find(call => call.action === 'continue')!;
  expect(command.job).toBe(job.id);
  expect(command.request).toMatchObject({ workspace: directory, model: 'deepai/glm-5.3-flash' });
  expect(next.id).not.toBe(job.id);
});
it('resolves only matching source/packaged helper resources and an absolute Node path', () => {
  const nodeDirectory = path.join(directory, 'node-bin');
  const filename = process.platform === 'win32' ? 'node.exe' : 'node';
  const files = new Set([path.join(nodeDirectory, filename), ...['deepai-helper.mjs', 'deepai-helper-state.mjs', 'deepai-native.mjs', 'deepai-attention.mjs']
    .flatMap(file => [path.join(directory, 'scripts', file), path.join(directory, 'resources', 'deepai-helper', file)])]);
  const env = { PATH: nodeDirectory };
  const source = resolveDeepAIHelperRuntime({ packaged: false, appPath: directory, env, exists: file => files.has(file) });
  expect(source.script).toBe(path.join(directory, 'scripts', 'deepai-helper.mjs'));
  const packaged = resolveDeepAIHelperRuntime({ packaged: true, appPath: path.join(directory, 'app.asar'), resourcesPath: path.join(directory, 'resources'), env, exists: file => files.has(file) });
  expect(packaged.script).toBe(path.join(directory, 'resources', 'deepai-helper', 'deepai-helper.mjs'));
  files.delete(path.join(directory, 'resources', 'deepai-helper', 'deepai-attention.mjs'));
  expect(() => resolveDeepAIHelperRuntime({ packaged: true, appPath: directory, resourcesPath: path.join(directory, 'resources'), env, exists: file => files.has(file) })).toThrow('DEEPAI_BRIDGE_NOT_PACKAGED');
  expect(supportsDeepAIHelperNode('v22.12.0')).toBe(false);
  expect(supportsDeepAIHelperNode('v22.13.0')).toBe(true);
  expect(supportsDeepAIHelperNode('v24.19.0\n')).toBe(true);
  expect(supportsDeepAIHelperNode('garbage')).toBe(false);
});


it('readiness retains exact caller custody and never dispatches or silently resumes a paused parent', async () => {
  const p = await principal();
  allowed = false;
  expect(await owner.readiness(p)).toMatchObject({ ready: false, blocker: { code: 'parent_control_hold' } });
  expect(bridge).not.toHaveBeenCalled();
  allowed = true;
  bridge.mockResolvedValueOnce({ ready: true, observedAt: new Date(now).toISOString(), maxActive: 2,
    version: '0.3.36', protocol: 2, model: 'deepai/glm-5.3-flash', blocker: null });
  expect(await owner.readiness(p)).toMatchObject({ ready: true, parentConversationId: 'conversation-a' });
  expect(calls).toHaveLength(0); expect(jobs.size).toBe(0);
  bridge.mockImplementationOnce(async () => { allowed = false; return { ready: true, observedAt: 'now', maxActive: 2, version: '0.3.36', protocol: 2, model: 'deepai/glm-5.3-flash', blocker: null }; });
  await expect(owner.readiness(p)).rejects.toThrow('DEEPAI_PARENT_PAUSED');
  expect(() => deepAIHelperSchema.parse({ action: 'readiness' })).not.toThrow();
  expect(() => deepAIHelperSchema.parse({ action: 'readiness', job: randomUUID() })).toThrow();
});
it('links the exact parent, native run, saved report, witnessed publication and explicit acknowledgment', async () => {
  const p = await principal();
  const job = await owner.submit(p, request());
  expect(job.receipt).toMatchObject({ parentConversationId: 'conversation-a', sourceRequestId: 'exact-request-a',
    jobId: job.id, reportSaved: false, reportPath: null, noticePublishedAt: null, acknowledgedAt: null });
  complete(job.id); Object.assign(jobs.get(String(job.id))!, { runId: 'native-run-one' });
  const publication = { completedAt: null as number | null, failed: false };
  const c = context(p, publication);
  expect(await owner.offer(c, 8000)).toContain(String(job.id));
  publication.completedAt = ++now;
  now += 5;
  await owner.offer(context(p), 8000);
  const inspected = await owner.inspect(p, 'status', String(job.id));
  expect(inspected.receipt).toMatchObject({ nativeRunId: 'native-run-one', reportSaved: true,
    reportPath: path.join(directory, '.cos-deepai', 'results', String(job.id), 'report.md'), noticePublishedAt: publication.completedAt });
  const acknowledged = await owner.inspect(p, 'ack', String(job.id));
  expect(acknowledged.receipt).toMatchObject({ acknowledgedAt: now });
  await expect(owner.inspect(await principal('b'), 'status', String(job.id))).rejects.toThrow('DEEPAI_JOB_NOT_OWNED');
});

it('refuses explicit acknowledgment of a completed but unsaved result without marking the binding handled', async () => {
 const p = await principal(); const job = await owner.submit(p, request());
 Object.assign(jobs.get(String(job.id))!, { status: 'completed', resultSaved: false });
 await expect(owner.inspect(p, 'ack', String(job.id))).rejects.toThrow('DEEPAI_REPORT_NOT_SAVED');
 const ledger = await readDurableStrict('deepai-helper-bindings') as any;
 expect(ledger.rows[0].acknowledgedAt).toBeUndefined();
});

it('retains witnessed publication when the next parent action directly acknowledges the outcome', async () => {
 const p = await principal(); const job = await owner.submit(p, request()); complete(job.id);
 const publication = { completedAt: null as number | null, failed: false };
 await owner.offer(context(p, publication), 8000); publication.completedAt = ++now; now++;
 const ack = await owner.inspect(p, 'ack', String(job.id));
 expect(ack.receipt).toMatchObject({ noticePublishedAt: publication.completedAt, acknowledgedAt: now });
});

it('does not turn a failed or future publication witness into confirmed notice delivery on ACK', async () => {
 for (const failed of [true, false]) {
  const p = await principal(); const job = await owner.submit(p, request('notice-' + failed)); complete(job.id);
  const publication = { completedAt: null as number | null, failed: false };
  await owner.offer(context(p, publication), 8000);
  publication.completedAt = failed ? now : now + 500; publication.failed = failed;
  const ack = await owner.inspect(p, 'ack', String(job.id));
  expect(ack.receipt).toMatchObject({ noticePublishedAt: null, acknowledgedAt: now });
 }
});

it('retains a confirmed publication witness across a failed durable acknowledgment write', async () => {
 const p = await principal(); const job = await owner.submit(p, request()); complete(job.id);
 const publication = { completedAt: null as number | null, failed: false };
 await owner.offer(context(p, publication), 8000); publication.completedAt = ++now; now++;
 const write = deps.write; let fail = true;
 deps.write = async ledger => { if (fail) { fail = false; throw new Error('disk write interrupted'); } await write(ledger); };
 await expect(owner.inspect(p, 'ack', String(job.id))).rejects.toThrow('disk write interrupted');
 const ack = await owner.inspect(p, 'ack', String(job.id));
 expect(ack.receipt).toMatchObject({ noticePublishedAt: publication.completedAt, acknowledgedAt: now });
});

it('retries durable publication capture through inbox and later eligible notices after a write failure', async () => {
 for (const method of ['inbox', 'offer'] as const) {
  const p = await principal(); const job = await owner.submit(p, request('write-' + method)); complete(job.id);
  const publication = { completedAt: null as number | null, failed: false };
  await owner.offer(context(p, publication), 8000); publication.completedAt = ++now; now++;
  const write = deps.write; let fail = true;
  deps.write = async ledger => { if (fail) { fail = false; throw new Error('temporary write failure'); } await write(ledger); };
  const read = () => method === 'inbox' ? owner.inbox(p) : owner.offer(context(p), 8000);
  await expect(read()).rejects.toThrow('temporary write failure'); await read();
  const result = await owner.inspect(p, 'status', String(job.id));
  expect(result.receipt).toMatchObject({ noticePublishedAt: publication.completedAt });
  await owner.inspect(p, 'ack', String(job.id)); deps.write = write;
 }
});

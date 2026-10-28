import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { getLog } from '../src/main/logger.js';
import { resetRecorderForTests } from '../src/main/session/recorder.js';
import {
  inFlightToolCalls,
  runningToolCalls,
  settlingToolCalls
} from '../src/main/mcp/call-context.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { recentToolDispatches } from '../src/main/mcp/kernel.js';
import { initSessionStore, listSessions, readEvents, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import {
  bindConversation, claimWorkerRevival, closableWorkerConversations, DETACHED_SILENCE_MS,
  noteWorkerRevived, onSwarmPersistNow, pendingWorkerRevivals, persistCriticalSwarmNow,
  resetAgentsForTests, snapshotSwarm, spawn, workerConversationGone
} from '../src/main/agents.js';
// @ts-ignore Diagnostic scripts are intentionally plain ESM JavaScript.
import { benchmarkMcpLatency } from '../scripts/benchmark-mcp-latency.mjs';

/** What the counter said while the call was being recorded, i.e. after its handler returned. */
let duringRecord: number | null = null;
/** Held open to stand in for the grace window an unattributed record can spend waiting. */
let releaseRecord: (() => void) | null = null;

// The recorder runs in the gap this test is about: the handler has returned, the result has
// not been delivered, and the durable append is still to come. Everything else in the module
// stays real, so the call travels its normal path.
vi.mock('../src/main/session/recorder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/session/recorder.js')>();
  return {
    ...actual,
    recordToolCall: async (...args: Parameters<typeof actual.recordToolCall>) => {
      duringRecord = inFlightToolCalls(null);
      if (releaseRecord !== null) {
        await new Promise<void>((resolve) => {
          const previous = releaseRecord;
          releaseRecord = () => {
            previous?.();
            resolve();
          };
        });
      }
      return actual.recordToolCall(...args);
    }
  };
});

let dir = '';
let endpoint: McpEndpoint | null = null;

afterEach(async () => {
  releaseRecord?.();
  releaseRecord = null;
  if (endpoint) await endpoint.stop().catch(() => undefined);
  endpoint = null;
  duringRecord = null;
  // The recorder's cached anonymous session belongs to the previous temp root.
  // Test each real HTTP fixture against its own fresh durable history.
  resetRecorderForTests();
  resetAgentsForTests();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

async function serve(agentTools = false): Promise<McpEndpoint> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-inflight-'));
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const cfg = defaultConfig();
  const rootPath = await validateNewRoot(dir, []);
  const roots = [{ name: 'probe', path: rootPath }];
  await saveConfig({ ...cfg, roots, readOnly: false,
    multiAgent: { ...cfg.multiAgent, enabled: agentTools } });
  await fs.writeFile(path.join(dir, 'note.txt'), 'hello\n', 'utf8');
  return startMcpServer(() => ({
    roots,
    caps: cfg.capabilities,
    readOnly: false,
    sessionTools: false,
    agentTools
  }));
}

const readNote = (url: string): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read', arguments: { paths: ['/probe/note.txt'] } }
    })
  });

async function agentsAtEndpoint(conversationId: string, requestId: string, action: string,
  args: Record<string, unknown>, lateEvidence = false): Promise<any> {
  const prove = () => expect(observeRequestCorrelation({ requestId, conversationId, sessionId: `session-${conversationId}`,
    messageId: `message-${requestId}`, tool: 'agents', observedAt: Date.now() })).toBe('stored');
  if (!lateEvidence) prove();
  const pending = fetch(endpoint!.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-request-id': `${requestId}/relay` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { name: 'agents', arguments: { action, ...args } } })
  });
  if (lateEvidence) {
    const deadline = performance.now() + 2_000;
    while (!recentToolDispatches('core', 0).records.some(row => row.requestId === requestId) && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect(recentToolDispatches('core', 0).records.some(row => row.requestId === requestId)).toBe(true);
    // The real ingress has started without a mate. Its later exact request proof must still
    // reach the liveness/finish boundary, not merely repair recording after a discarded result.
    prove();
  }
  const response = await pending;
  const wire = (await response.text()).trim();
  const frame = wire.startsWith('{') ? wire : [...wire.matchAll(/^data:\s*(.*)$/gm)].at(-1)![1]!;
  expect(response.status).toBe(200);
  return JSON.parse(frame);
}

it.each(['early', 'late'] as const)(
  'preserves the first exact finish from a detached silent worker with %s identity at the real MCP boundary', async identity => {
  endpoint = await serve(true);
  const diskName = 'kernel-first-detached-finish';
  onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
  const prime = 'kernel-finish-prime';
  const conversationId = 'kernel-finish-detached-worker';
  const created = spawn({ caller: { conversationId: prime }, workers: [
    { task: 'Keep the exact result from this detached worker.' },
    { task: 'Hold the sibling slot while that worker finishes.' }
  ] }).created;
  expect(bindConversation(created[0]!.id, conversationId)).toBe(true);
  expect(workerConversationGone(conversationId)).toBe(true);
  const detached = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents)
    .find(agent => agent.info.conversationId === conversationId)!;
  expect(detached.info.state).toBe('detached');
  const now = Math.max(Date.now(), detached.info.detachedAt!, detached.info.lastSeenAt!)
    + DETACHED_SILENCE_MS + 1_000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const result = 'RESULT: actual source changes and passing checks.\n  Preserve these exact bytes.\n';
    const reply = await agentsAtEndpoint(conversationId, `wfr_kernel_first_detached_finish_${identity}`,
      'finish', { result }, identity === 'late');
    expect(reply.result?.isError).not.toBe(true);
    expect(reply.result?.structuredContent).toMatchObject({ action: 'finish', state: 'sleeping', repeat: false });
    const disk = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    const rows = disk!.activeRuns!.flatMap(run => run.agents);
    const worker = rows.find(agent => agent.info.conversationId === conversationId)!;
    const owner = rows.find(agent => agent.info.conversationId === prime)!;
    expect(worker.info).toMatchObject({ state: 'sleeping', result });
    expect(owner.queue).toHaveLength(1);
    expect(owner.queue[0]!.text).toContain(result);
    expect(worker.info.stopReportId).toBe(owner.queue[0]!.id);
    expect(closableWorkerConversations(0)).toContain(conversationId);
  } finally {
    clock.mockRestore();
  }
});

it.each(['unclaimed', 'claimed'] as const)(
  'does not let a lost finish ACK consume a %s waking assignment over real MCP', async phase => {
    endpoint = await serve(true);
    const diskName = `kernel-waking-finish-${phase}`;
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    const prime = `kernel-wake-prime-${phase}`;
    const conversationId = `kernel-wake-worker-${phase}`;
    const worker = spawn({ caller: { conversationId: prime }, workers: [
      { task: 'Finish the first exact piece.' }, { task: 'Keep the sibling active.' }
    ] }).created[0]!;
    expect(bindConversation(worker.id, conversationId)).toBe(true);
    const result = 'RESULT: original completed work; preserve this report after a lost response.';
    expect((await agentsAtEndpoint(conversationId, `wfr_wake_first_${phase}`, 'finish', { result }))
      .result?.structuredContent).toMatchObject({ repeat: false });
    const oldReport = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents)
      .find(agent => agent.info.conversationId === prime)!.queue[0]!;
    const wake = await agentsAtEndpoint(prime, `wfr_wake_message_${phase}`, 'message',
      { to: worker.id, text: 'New second assignment: preserve its delivery ownership.' });
    expect(wake.result?.isError).not.toBe(true);
    const revival = pendingWorkerRevivals().find(row => row.conversationId === conversationId)!;
    expect(revival).toBeDefined();
    if (phase === 'claimed') {
      expect(claimWorkerRevival(worker.id, conversationId, revival.runId)).toBe(true);
      expect(await persistCriticalSwarmNow()).toBe(true);
    }
    const before = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents)
      .find(agent => agent.info.conversationId === conversationId)!;
    expect(before.info).toMatchObject({ state: 'waking', result: null, stopReportId: null,
      revivable: phase === 'unclaimed', lastRevivalCommandId: null });

    const retry = await agentsAtEndpoint(conversationId, `wfr_wake_retry_${phase}`, 'finish', { result });
    expect(retry.result?.structuredContent).toMatchObject({ state: 'waking', repeat: true });
    const after = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents);
    // An unclaimed wake can be offered by the ordinary finish-result inbox transport,
    // but that offer is neither an ACK nor delivery/activation of the browser-owned wake.
    const { lastSeenAt: _lastSeen, awaitingAck: _offeredCount, ...custody } = before.info;
    expect(after.find(agent => agent.info.conversationId === conversationId)!.info).toMatchObject(custody);
    expect(pendingWorkerRevivals().find(row => row.conversationId === conversationId))
      .toMatchObject({ runId: revival.runId, messageIds: revival.messageIds, text: revival.text });
    const parent = after.find(agent => agent.info.conversationId === prime)!;
    expect(parent.queue.map(row => row.id)).toEqual([oldReport.id]);
    expect(parent.queue[0]!.text).toBe(oldReport.text);
    const disk = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    expect(disk!.activeRuns!.flatMap(run => run.agents)
      .find(agent => agent.info.conversationId === prime)!.queue.map(row => row.id)).toEqual([oldReport.id]);
    expect(closableWorkerConversations(0)).not.toContain(conversationId);
  }
);

it.each(['command', 'legacy-offer'] as const)(
  'accepts a first finish from a genuinely delivered %s wake over real MCP', async delivery => {
    endpoint = await serve(true);
    const diskName = `kernel-delivered-finish-${delivery}`;
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    const prime = `kernel-delivered-prime-${delivery}`;
    const conversationId = `kernel-delivered-worker-${delivery}`;
    const worker = spawn({ caller: { conversationId: prime }, workers: [
      { task: 'First assignment.' }, { task: 'Hold sibling ownership.' }
    ] }).created[0]!;
    expect(bindConversation(worker.id, conversationId)).toBe(true);
    expect((await agentsAtEndpoint(conversationId, `wfr_delivered_first_${delivery}`, 'finish',
      { result: 'RESULT: first assignment done.' })).result?.structuredContent).toMatchObject({ repeat: false });
    expect((await agentsAtEndpoint(prime, `wfr_delivered_message_${delivery}`, 'message',
      { to: worker.id, text: 'Perform the second assignment.' })).result?.isError).not.toBe(true);
    const revival = pendingWorkerRevivals().find(row => row.conversationId === conversationId)!;
    expect(claimWorkerRevival(worker.id, conversationId, revival.runId)).toBe(true);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(noteWorkerRevived(worker.id, conversationId, revival.messageIds,
      delivery === 'command' ? 'exact-delivered-revival-command' : null, revival.runId)).toBe(true);
    expect(await persistCriticalSwarmNow()).toBe(true);
    const result = 'RESULT: new second assignment finished with exact delivered-wake custody.\n';
    const finished = await agentsAtEndpoint(conversationId, `wfr_delivered_finish_${delivery}`, 'finish', { result });
    expect(finished.result?.structuredContent).toMatchObject({ state: 'sleeping', repeat: false });
    const disk = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    const rows = disk!.activeRuns!.flatMap(run => run.agents);
    const stopped = rows.find(agent => agent.info.conversationId === conversationId)!;
    expect(stopped.info).toMatchObject({ state: 'sleeping', result });
    const report = rows.find(agent => agent.info.conversationId === prime)!.queue
      .find(row => row.id === stopped.info.stopReportId)!;
    expect(report.text).toContain(result);
    expect(closableWorkerConversations(0)).toContain(conversationId);
  }
);

it('the benchmark speaks the real SDK discovery protocol over ephemeral loopback HTTP', async () => {
  endpoint = await serve();
  // These are two aliases of the same local fixture, never a claim of live tunnel proof.
  const report = await benchmarkMcpLatency({ localUrl: endpoint.url, tunnelUrl: endpoint.url + '?fixture=second-route', rounds: 2 });
  expect(report.routes.local.statuses).toEqual({ 200: 2 });
  expect(report.routes.tunnel.statuses).toEqual({ 200: 2 });
  expect(report.routes.local.responseBodyBytes.p50).toBeGreaterThan(0);
  expect(duringRecord).toBeNull(); // tools/list never invokes or records a local tool.
});

it('counts a call as running until its whole request is done, not just its handler', async () => {
  // The compaction barrier waits for this to reach zero before it writes a handoff. The
  // handler returning is not the end of the request: identity is still being resolved, the
  // outcome is still being recorded, and the result has not reached ChatGPT. A counter that
  // closed with the handler let a handoff be written into exactly that gap.
  endpoint = await serve();
  const response = await readNote(endpoint.url);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('hello');
  expect(getLog().some((entry) => /request POST mcp\/core.*calls=1 ingress_ms=\d+ identity_ms=\d+ handler_ms=\d+ delivery_ms=\d+ recorder_ms=\d+ response_tail_ms=\d+/.test(entry.message))).toBe(true);

  expect(duringRecord).toBe(1);
  // And released once it has: this call was never attributed, so it is held through its own
  // record landing — see the test below, which is about exactly that window.
  const settled = Date.now();
  while (inFlightToolCalls(null) !== 0 && Date.now() - settled < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(inFlightToolCalls(null)).toBe(0);
});

it('commits a headerless Core result before its native HTTP response when the recorder is promptly available', async () => {
  // Live Core traffic omits all supported caller identity headers. With no
  // request id there is no page-correlation grace to wait for: the original
  // tool result can be stored under Unattributed before returning the wire.
  releaseRecord = () => {};
  endpoint = await serve();
  // Ensure actual durable recording for this native-response boundary.
  const config = getConfig();
  await saveConfig({ ...config, sessions: { ...config.sessions, record: true } });
  let nativeReturned = false;
  const pending = readNote(endpoint.url).then(response => {
    nativeReturned = true;
    return response;
  });
  const deadline = Date.now() + 2000;
  while (duringRecord === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(duringRecord).toBe(1);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(nativeReturned).toBe(false);
  } finally {
    releaseRecord?.();
    releaseRecord = null;
  }
  const response = await pending;
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('hello');
  const unattributed = (await listSessions()).find(session => session.title === 'Unattributed activity');
  expect(unattributed).toBeDefined();
  const events = await readEvents(unattributed!.id, { kinds: ['tool_call'] });
  expect(events).toEqual([expect.objectContaining({ kind: 'tool_call', call: expect.objectContaining({
    tool: 'read', requestId: null, conversationId: null, attribution: 'unattributed'
  }) })]);
});

it('keeps an unattributed call counted while its record is still landing', async () => {
  // The half the request counter alone does not cover. An anonymous call whose
  // recorder exceeds the bounded write wait returns to the native page while the
  // append remains unfinished; its live work has ended but custody has not.
  // Until it lands, the call could still turn out to belong to the chat that is asking, so
  // it stays charged to every chat rather than reading as zero for all of them.
  releaseRecord = () => {};
  endpoint = await serve();
  const config = getConfig();
  await saveConfig({ ...config, sessions: { ...config.sessions, record: true } });
  const response = await readNote(endpoint.url);
  expect(response.status).toBe(200);

  // The request is over and its result delivered, but the record has not settled.
  expect(inFlightToolCalls('conversation-a')).toBe(1);
  expect(inFlightToolCalls('conversation-b')).toBe(1);
  expect(inFlightToolCalls(null)).toBe(1);
  // This distinction is the compaction contract. The machine-changing request is done, so
  // `pendingTools` may be zero even while the unattributed history append stays observable.
  expect(runningToolCalls('conversation-a')).toBe(0);
  expect(runningToolCalls('conversation-b')).toBe(0);
  expect(settlingToolCalls('conversation-a')).toBe(1);
  expect(settlingToolCalls('conversation-b')).toBe(1);

  releaseRecord();
  releaseRecord = null;
  // Settling is what releases it, and nothing else.
  const settled = Date.now();
  while (inFlightToolCalls(null) !== 0 && Date.now() - settled < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(inFlightToolCalls('conversation-a')).toBe(0);
  expect(runningToolCalls('conversation-a')).toBe(0);
  expect(settlingToolCalls('conversation-a')).toBe(0);
  const unattributed = (await listSessions()).find(session => session.title === 'Unattributed activity');
  expect(unattributed).toBeDefined();
  expect((await readEvents(unattributed!.id, { kinds: ['tool_call'] }))).toEqual([
    expect.objectContaining({ kind: 'tool_call', call: expect.objectContaining({
      tool: 'read', requestId: null, attribution: 'unattributed'
    }) })
  ]);
});

/**
 * The broker: what a run is, who may act in it, and what happens to messages.
 *
 * Identity itself — which conversation is which agent, and what a code may and may not do —
 * lives in swarm.test.ts. This file is about everything downstream of that answer: creating
 * a run atomically, the star topology, at-least-once delivery, terminal states, restart, and
 * the shape of all of it over the actual MCP endpoint.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Caller } from '../src/main/agents.js';
import * as chatModels from '../src/main/chat-models.js';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, getConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const {
  AgentError,
  PRIME_ID,
  acknowledgeOffers,
  acknowledgeOffersForConversation,
  bindConversation,
  closableWorkerConversations,
  clearAgent,
  claimWorkerRevival,
  currentRunId,
  dormantWorkerNotice,
  reactivateDormantRunForConversation,
  failAgent,
  finishAgent,
  finishWorkerConversation,
  identify,
  offerMessages,
  offerMessagesForConversation,
  onSpawnRequest,
  onSwarmEnd,
  onSwarmPersist,
  onSwarmPersistNow,
  pendingCount,
  pendingWorkerSpawns,
  pauseSwarmForDisable,
  DETACHED_SILENCE_MS,
  endedWorkerNotice,
  sleepSilentDetachedWorkers,
  sleepingWorkerRuntimeCandidates,
  ownsSleepingWorkerRuntime,
  sleepWorker,
  noteAgentAlive,
  noteAgentContextTokens,
  failWorkerRevival,
  isWorkerConversation,
  WAKE_FAILURES_BEFORE_GIVING_UP,
  noteWorkerRevived,
  onReviveRequest,
  pendingWorkerRevivals,
  primeConversationGone,
  primeForOwnedConversation,
  WORKER_CONTEXT_CEILING_TOKENS,
  freeWorkerSlots,
  releaseQuiescentRun,
  repairPrimeConversationAfterRecovery,
  retireConversationForDeletion,
  retiredWorkerForConversation,
  restoreRetiredWorkers,
  rollbackWorkerRevivalClaim,
  persistCriticalSwarmNow,
  resetAgentsForTests,
  resetSwarm,
  restoreSwarm,
  sendMessage,
  setPrimeWorkerLimit,
  stageQueuedWorkerRevivals,
  stageFinishAgent,
  stageWorkerConversationFinish,
  stageMessages,
  stageSpawn,
  snapshotSwarm,
  spawn,
  swarmRunning,
  swarmState,
  swarmStateForCaller,
  statusForCaller,
  workerConversationGone,
  workerRevivalClaimed
} = await import('../src/main/agents.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { runningToolCalls } = await import('../src/main/mcp/call-context.js');
const { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } = await import('../src/main/durable.js');
const { findSessionByConversation, initSessionStore, readRecentEvents, resetSessionStoreForTests } = await import(
  '../src/main/session/store.js'
);
const { recordChatObservations, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { resetWorkspaces, setWorkspaceFor, workspaceForChat } = await import('../src/main/workspace.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

async function setEnabled(enabled: boolean, maxWorkers = 3, allowUnattributedCalls = false): Promise<void> {
  const base = defaultConfig();
  await saveConfig({
    ...base,
    multiAgent: { ...base.multiAgent, enabled, maxWorkers, allowUnattributedCalls }
  });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-agents-');
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  await setEnabled(true);
});

afterAll(async () => {
  resetAgentsForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(() => {
  resetAgentsForTests();
  resetRecorderForTests();
  resetWorkspaces();
  // The real app wires the broker's immediate persistence sink during startup. MCP endpoint
  // tests exercise that production contract rather than an intentionally half-wired broker;
  // durability-specific cases below replace this no-op sink with controlled writers.
  onSwarmPersistNow(async () => undefined);
});

const PRIME_CHAT = 'c-prime';
const prime: Caller = { conversationId: PRIME_CHAT };

it('returns an empty exact-caller status without creating a family or exposing another prime', () => {
  const empty = { self: null, runId: null, state: { running: false, retainedHistory: false, agents: [] } };
  expect(statusForCaller(prime)).toMatchObject(empty);
  expect(swarmRunning()).toBe(false);
  startSwarm(1);
  const unrelated = { conversationId: 'c-unrelated-status' };
  expect(statusForCaller(unrelated)).toMatchObject(empty);
  expect(swarmStateForCaller(unrelated).agents).toEqual([]);
  expect(swarmStateForCaller(prime).agents).toHaveLength(2);
  expect(() => statusForCaller({ conversationId: null })).toThrow(/identity|conversation/i);
});

/**
 * A read of `/anything` that actually reached the sandbox and was refused on roots.
 *
 * The wording is platform-shaped and both spellings have to be here. On Windows `/anything`
 * is a virtual path whose first segment names no approved root, so `sandbox.ts` answers
 * `Unknown root "/anything"`. On macOS and Linux the same string is a native absolute path,
 * which takes the containment branch instead and answers that it is not inside an approved
 * folder. Matching only the Windows half asserts the host, not the behaviour — the point of
 * these assertions is that the call ran and failed honestly about roots rather than being
 * stopped at the identity fence.
 */
const REFUSED_ON_ROOTS = /unknown root|not found|not inside an approved folder/i;

interface StartedSwarm {
  prime: Caller;
  spawned: Array<{ id: string; task: string }>;
}

/** Prime + n workers, without opening any browser tabs. */
function startSwarm(count = 2, caller: Caller = prime): StartedSwarm {
  const spawned: Array<{ id: string; task: string }> = [];
  onSpawnRequest((workers) => spawned.push(...workers));
  const result = spawn({
    workers: Array.from({ length: count }, (_, i) => ({ label: `Worker ${i + 1}`, task: `task ${i + 1}` })),
    caller
  });
  expect(result.becamePrime).toBe(true);
  return { prime: caller, spawned };
}

/**
 * A worker started the way the app makes it happen: the extension reports the chat it
 * opened, and that binding is the whole of it. No join, no key, nothing typed by a model.
 */
function startWorker(id: string, conversationId = `c-${id}`): { caller: Caller } {
  expect(bindConversation(id, conversationId)).toBe(true);
  return { caller: { conversationId } };
}

/**
 * Fills a worker's chat past the context ceiling.
 *
 * The one thing that makes a worker's next stop permanent, and the only way a test reaches a
 * genuinely terminal worker now that reporting means sleeping. Measured from the app's own
 * session record in production; here the same broker entry point is called directly.
 */
function fillContext(conversationId: string): void {
  noteAgentContextTokens(conversationId, WORKER_CONTEXT_CEILING_TOKENS);
}

describe('worker chats the browser may close', () => {
  it('closes a stopped worker after durable inbox storage without pretending Prime acknowledged it', async () => {
    startSwarm(2);
    const worker = startWorker('worker-1');
    const finished = finishAgent(worker.caller, 'result retained while Prime is offline');
    expect(closableWorkerConversations(0)).toEqual([]);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(closableWorkerConversations(0)).toEqual(['c-worker-1']);
    expect(swarmState().agents.find(agent => agent.id === 'worker-1')?.stopReportAcknowledgedAt).toBeNull();
    startWorker('worker-2');
    expect(closableWorkerConversations(0)).toEqual(['c-worker-1']);
    expect(offerMessages(PRIME_ID)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: finished.report?.id, ackedAt: null })
    ]));
  });
  it('keeps a completed worker open when saving its unacknowledged result fails', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'must not lose this result');
    onSwarmPersistNow(async () => { throw new Error('disk unavailable'); });
    await expect(persistCriticalSwarmNow()).rejects.toThrow('disk unavailable');
    expect(closableWorkerConversations(0)).toEqual([]);
  });
  it('names the stopped worker chats beyond the ones most recently used, and no working one', async () => {
    vi.useFakeTimers();
    try {
      await setEnabled(true, 3);
      startSwarm(3);
      const first = startWorker('worker-1');
      const second = startWorker('worker-2');
      startWorker('worker-3');
      expect(closableWorkerConversations(1)).toEqual([]);

      // Two stop, in order. Their reports still belong to the prime, so neither browser tab is
      // closeable until a later prime call proves those reports were received.
      finishAgent(first.caller, 'first done');
      vi.setSystemTime(Date.now() + 1_000);
      finishAgent(second.caller, 'second done');
      expect(closableWorkerConversations(0)).toEqual([]);
      offerMessages(PRIME_ID);
      acknowledgeOffers(PRIME_ID, false, Date.now() + 1);
      expect(await persistCriticalSwarmNow()).toBe(true);

      // The third keeps working and is never on the list.
      expect(closableWorkerConversations(2)).toEqual([]);
      expect(closableWorkerConversations(1)).toEqual(['c-worker-1']);
      expect(closableWorkerConversations(0)).toEqual(['c-worker-1', 'c-worker-2']);

      // The first worker is used again: it is the most recent stopped chat now, so the other
      // one is the surplus.
      vi.setSystemTime(Date.now() + 1_000);
      expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
      finishAgent(first.caller, 'first done again');
      expect(closableWorkerConversations(0)).toEqual(['c-worker-2']);
      offerMessages(PRIME_ID);
      acknowledgeOffers(PRIME_ID, false, Date.now() + 1);
      expect(await persistCriticalSwarmNow()).toBe(true);
      expect(closableWorkerConversations(1)).toEqual(['c-worker-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an administratively paused worker tab because no stop report was published', () => {
    startSwarm(1);
    startWorker('worker-1');

    expect(pauseSwarmForDisable()).toBe(true);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      stopReportId: null,
      stopReportAcknowledgedAt: null
    });
    expect(closableWorkerConversations(0)).toEqual([]);

    // New snapshots carry explicit nulls. They are a deliberate fail-closed statement, not a
    // legacy omission eligible for the one-time completed-worker migration.
    const saved = JSON.parse(JSON.stringify(snapshotSwarm()));
    const savedWorker = saved.dormantRuns[0].agents.find(
      (entry: { info: { id: string } }) => entry.info.id === 'worker-1'
    );
    expect(Object.prototype.hasOwnProperty.call(savedWorker.info, 'stopReportId')).toBe(true);
    expect(savedWorker.info.stopReportId).toBeNull();
    resetAgentsForTests();
    restoreSwarm(saved);
    expect(closableWorkerConversations(0)).toEqual([]);
  });

  it('persists exact stop-report acknowledgement after the acknowledged queue row is pruned', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const finished = finishAgent(worker.caller, 'durable result');
    expect(finished.report?.id).toBeTruthy();

    offerMessages(PRIME_ID);
    acknowledgeOffers(PRIME_ID, false, Date.now() + 1);
    expect(await persistCriticalSwarmNow()).toBe(true);
    const before = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(before).toMatchObject({
      stopReportId: finished.report?.id,
      stopReportAcknowledgedAt: expect.any(Number)
    });
    expect(closableWorkerConversations(0)).toEqual(['c-worker-1']);

    const saved = JSON.parse(JSON.stringify(snapshotSwarm()));
    resetAgentsForTests();
    restoreSwarm(saved);

    const restored = swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1');
    expect(restored).toMatchObject({
      stopReportId: finished.report?.id,
      stopReportAcknowledgedAt: expect.any(Number)
    });
    expect(closableWorkerConversations(0)).toEqual(['c-worker-1']);
  });

  it('requires a stopped-worker report to be re-offered after the Prime conversation rebinds', async () => {
    const { beginPrimeTransfer, freezePrimeTransfer, commitPrimeTransfer } = await import('../src/main/agents.js');
    startSwarm(1);
    const worker = startWorker('worker-1');
    const finished = finishAgent(worker.caller, 'result that must reach the current Prime');
    const reportId = finished.report?.id;
    expect(reportId).toBeTruthy();

    const offeredInA = offerMessagesForConversation(PRIME_CHAT);
    expect(offeredInA?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: reportId, offeredConversationId: PRIME_CHAT })
    ]));
    const primeB = 'c-prime-resumed-after-report';
    expect(beginPrimeTransfer(PRIME_CHAT)).toBe(true);
    expect(freezePrimeTransfer(PRIME_CHAT)).toBe('frozen');
    expect(commitPrimeTransfer(PRIME_CHAT, primeB)).toBe(true);

    // B's first authenticated call proves only a result previously offered to B. The report was
    // offered to A, so the rebind cannot manufacture the ACK that unlocks worker tab cleanup.
    expect(acknowledgeOffersForConversation(primeB, false, Date.now() + 1)?.messages).toEqual([]);
    expect(closableWorkerConversations(0)).toEqual([]);

    const offeredInB = offerMessagesForConversation(primeB);
    expect(offeredInB?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: reportId, offeredConversationId: primeB })
    ]));
    expect(acknowledgeOffersForConversation(primeB, false, Date.now() + 1)?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: reportId })])
    );
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(closableWorkerConversations(0)).toEqual(['c-worker-1']);
  });

  it('puts cleanup authority on the critical durability lane', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
    });
    startSwarm(1);
    const worker = startWorker('worker-1');
    const finished = finishAgent(worker.caller, 'critical cleanup proof');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(1);

    offerMessages(PRIME_ID);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(1);

    acknowledgeOffers(PRIME_ID, false, Date.now() + 1);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
    expect(
      persisted[1]?.activeRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.info
    ).toMatchObject({
      stopReportId: finished.report?.id,
      stopReportAcknowledgedAt: expect.any(Number)
    });
  });

  it('keeps a stop report uncloseable and recoverable until its exact ACK barrier succeeds', async () => {
    let holdAcknowledgement = false;
    let enteredBarrier!: () => void;
    let releaseBarrier!: () => void;
    const barrierEntered = new Promise<void>((resolve) => { enteredBarrier = resolve; });
    const barrierGate = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    onSwarmPersistNow(async () => {
      if (!holdAcknowledgement) return;
      enteredBarrier();
      await barrierGate;
    });

    startSwarm(1);
    const worker = startWorker('worker-1');
    const finished = finishAgent(worker.caller, 'result whose ACK is still being written');
    expect(await persistCriticalSwarmNow()).toBe(true);

    offerMessages(PRIME_ID);
    holdAcknowledgement = true;
    acknowledgeOffers(PRIME_ID, false, Date.now() + 1);
    const pendingBarrier = persistCriticalSwarmNow();
    await barrierEntered;

    expect(closableWorkerConversations(0)).toEqual([]);
    const ordinary = snapshotSwarm()!;
    const serialized = [
      ...(ordinary.activeRuns ?? []).flatMap((run) => run.agents),
      ...(ordinary.dormantRuns ?? []).flatMap((run) => run.agents)
    ];
    expect(serialized.find((entry) => entry.info.id === 'worker-1')?.info).toMatchObject({
      stopReportId: finished.report?.id,
      stopReportAcknowledgedAt: null
    });
    expect(serialized.find((entry) => entry.info.id === PRIME_ID)?.queue).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: finished.report?.id, ackedAt: null })])
    );

    releaseBarrier();
    expect(await pendingBarrier).toBe(true);
    expect(closableWorkerConversations(0)).toEqual(['c-worker-1']);
  });

  it('fails closed and preserves at-least-once delivery when the exact ACK barrier fails', async () => {
    let lastDurable: ReturnType<typeof snapshotSwarm> = null;
    onSwarmPersistNow(async (snapshot) => {
      lastDurable = JSON.parse(JSON.stringify(snapshot));
    });
    startSwarm(1);
    const worker = startWorker('worker-1');
    const finished = finishAgent(worker.caller, 'result retained across a failed ACK write');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(lastDurable).not.toBeNull();

    onSwarmPersistNow(async () => {
      throw new Error('injected acknowledgement write failure');
    });
    offerMessages(PRIME_ID);
    acknowledgeOffers(PRIME_ID, false, Date.now() + 1);
    await expect(persistCriticalSwarmNow()).rejects.toThrow('injected acknowledgement write failure');
    expect(closableWorkerConversations(0)).toEqual([]);

    // A crash after the failed barrier restores the earlier durable report and offers it again;
    // failure never turns an in-memory ACK into browser-cleanup authority or message loss.
    const recoverable = JSON.parse(JSON.stringify(lastDurable));
    resetAgentsForTests();
    restoreSwarm(recoverable);
    expect(closableWorkerConversations(0)).toEqual([]);
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: finished.report?.id, ackedAt: null })])
    );
  });

  it('drops a failed ACK fence when resetSwarm permanently removes its family', async () => {
    onSwarmPersistNow(async () => undefined);
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'result before a permanent reset');
    expect(await persistCriticalSwarmNow()).toBe(true);

    onSwarmPersistNow(async () => {
      throw new Error('injected reset-bound acknowledgement failure');
    });
    offerMessages(PRIME_ID);
    acknowledgeOffers(PRIME_ID, false, Date.now() + 1);
    await expect(persistCriticalSwarmNow()).rejects.toThrow('injected reset-bound acknowledgement failure');
    expect(closableWorkerConversations(0)).toEqual([]);

    resetSwarm();
    let phantomWrites = 0;
    onSwarmPersistNow(async () => { phantomWrites += 1; });
    await Promise.resolve();
    expect(phantomWrites).toBe(0);
  });

  it('drops a failed ACK fence when its dormant family is evicted', async () => {
    vi.useFakeTimers();
    try {
      onSwarmPersistNow(async () => undefined);
      startSwarm(1);
      const worker = startWorker('worker-1');
      finishAgent(worker.caller, 'old parked result');
      expect(await persistCriticalSwarmNow()).toBe(true);

      onSwarmPersistNow(async () => {
        throw new Error('injected parked acknowledgement failure');
      });
      offerMessages(PRIME_ID);
      acknowledgeOffers(PRIME_ID, false, Date.now() + 1);
      await expect(persistCriticalSwarmNow()).rejects.toThrow('injected parked acknowledgement failure');
      expect(releaseQuiescentRun()).toBe(true);

      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000);
      const nextPrime = { conversationId: 'c-next-prime' };
      startSwarm(1, nextPrime);
      const nextWorker = startWorker('worker-1', 'c-next-worker');
      finishAgent(nextWorker.caller, 'new result that triggers dormant pruning');
      expect(releaseQuiescentRun()).toBe(true);

      let phantomWrites = 0;
      onSwarmPersistNow(async () => { phantomWrites += 1; });
      await Promise.resolve();
      expect(phantomWrites).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('migrates an eligible legacy completed-result snapshot once and persists the proof', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'legacy result');
    offerMessages(PRIME_ID);
    acknowledgeOffers(PRIME_ID, false, Date.now() + 1);
    expect(await persistCriticalSwarmNow()).toBe(true);

    const saved = JSON.parse(JSON.stringify(snapshotSwarm()));
    const savedWorker = saved.activeRuns[0].agents.find(
      (entry: { info: { id: string } }) => entry.info.id === 'worker-1'
    );
    delete savedWorker.info.stopReportId;
    delete savedWorker.info.stopReportAcknowledgedAt;
    resetAgentsForTests();
    restoreSwarm(saved);

    const migrated = swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1');
    expect(migrated).toMatchObject({
      stopReportId: expect.stringMatching(/^legacy-stop:worker-1:c-worker-1:/),
      stopReportAcknowledgedAt: saved.savedAt
    });
    expect(closableWorkerConversations(0)).toEqual(['c-worker-1']);

    // The migration marks the restore repaired, so the ordinary next snapshot stores explicit
    // proof. A second restart consumes that proof directly rather than running migration again.
    const migratedSnapshot = JSON.parse(JSON.stringify(snapshotSwarm()));
    const persistedWorker = migratedSnapshot.dormantRuns[0].agents.find(
      (entry: { info: { id: string } }) => entry.info.id === 'worker-1'
    );
    expect(persistedWorker.info.stopReportId).toBe(migrated?.stopReportId);
    resetAgentsForTests();
    restoreSwarm(migratedSnapshot);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      stopReportId: migrated?.stopReportId,
      stopReportAcknowledgedAt: saved.savedAt
    });
    expect(closableWorkerConversations(0)).toEqual(['c-worker-1']);
  });

  it('does not migrate a legacy stopped worker whose report is still pending', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'result the prime has not received');

    const saved = JSON.parse(JSON.stringify(snapshotSwarm()));
    const savedWorker = saved.activeRuns[0].agents.find(
      (entry: { info: { id: string } }) => entry.info.id === 'worker-1'
    );
    delete savedWorker.info.stopReportId;
    delete savedWorker.info.stopReportAcknowledgedAt;
    resetAgentsForTests();
    restoreSwarm(saved);

    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      stopReportId: null,
      stopReportAcknowledgedAt: null
    });
    expect(closableWorkerConversations(0)).toEqual([]);
  });

  it('revokes an old cleanup proof when a worker resumes and is later paused without a report', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first stop');
    offerMessages(PRIME_ID);
    acknowledgeOffers(PRIME_ID, false, Date.now() + 1);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(closableWorkerConversations(0)).toEqual(['c-worker-1']);

    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    // Retire the "awake again" correction so no pending prime row happens to protect the tab.
    offerMessages(PRIME_ID);
    acknowledgeOffers(PRIME_ID, false, Date.now() + 1);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(pauseSwarmForDisable()).toBe(true);

    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      stopReportId: null,
      stopReportAcknowledgedAt: null
    });
    expect(closableWorkerConversations(0)).toEqual([]);
  });
});

describe('spawning a run', () => {
  it('refuses the feature while it is switched off', async () => {
    await setEnabled(false);
    expect(() => spawn({ workers: [{ task: 'x' }], caller: prime })).toThrow(/not enabled|switched off|disabled/i);
    await setEnabled(true);
  });

  it('binds the calling conversation as prime and creates its workers', () => {
    const { spawned } = startSwarm(2);
    const state = swarmState();
    expect(state.agents.map((agent) => agent.id)).toEqual([PRIME_ID, 'worker-1', 'worker-2']);
    expect(state.agents[0]?.conversationId).toBe(PRIME_CHAT);
    expect(spawned.map((worker) => worker.id)).toEqual(['worker-1', 'worker-2']);
    // Nothing about a run is a credential the state can leak: the prime has none at all,
    // and a worker's code exists only as a hash until it joins.
    expect(JSON.stringify(state)).not.toMatch(/secret|joinKey|codeHash/i);
  });

  it('uses a full UUID as the run incarnation key that fences stale worker commands', () => {
    startSwarm(1);
    expect(currentRunId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('creates nothing at all when any worker in the request is invalid', () => {
    expect(() =>
      spawn({ workers: [{ task: 'fine' }, { task: '   ' }], caller: prime })
    ).toThrow(/Worker 2 has no task/);
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('rejects an over-long label before creating anything, not only an over-long task', () => {
    expect(() => spawn({ workers: [{ label: 'x'.repeat(200), task: 'fine' }], caller: prime })).toThrow(
      /label is too long/
    );
    expect(swarmRunning()).toBe(false);
  });

  it('refuses a caller whose conversation this app could not prove, and creates nothing', () => {
    expect(() => spawn({ workers: [{ task: 'fine' }], caller: {} })).toThrow(AgentError);
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('enforces the configured live-worker limit', () => {
    startSwarm(3);
    expect(() => spawn({ workers: [{ task: 'one too many' }], caller: prime })).toThrow(/limit|maximum|too many/i);
  });

  it('never admits a seventh live worker even when legacy settings still say eight', async () => {
    await setEnabled(true, 6);
    // Simulate the old accepted in-memory value independently of the loader migration below;
    // broker admission still owns the final safety ceiling.
    getConfig().multiAgent.maxWorkers = 8;
    try {
      startSwarm(6);
      expect(freeWorkerSlots()).toBe(0);
      expect(() => spawn({ workers: [{ task: 'legacy worker seven' }], caller: prime })).toThrow(/limit|maximum|too many/i);
    } finally {
      getConfig().multiAgent.maxWorkers = 6;
    }
  });

  it('lets independent primes recruit only into their own worker families', () => {
    startSwarm(1);
    spawn({ workers: [{ task: 'more' }], caller: { conversationId: 'c-stranger' } });
    expect(swarmState().agents).toHaveLength(4);
    expect(swarmStateForCaller(prime).agents).toHaveLength(2);
    spawn({ workers: [{ task: 'more' }], caller: prime });
    expect(swarmState().agents.map((agent) => agent.id)).toContain('worker-2');
  });

  it('creates a fresh worker on spawn even when an identical old worker is sleeping', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'the first task finished');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    const fresh = spawn({ workers: [{ label: 'Worker 1', task: 'task 1' }], caller: prime });

    expect(fresh.created.map((agent) => agent.id)).toEqual(['worker-2']);
    expect(fresh.created[0]?.state).toBe('invited');
    expect(swarmRunning()).toBe(true);
    expect(swarmStateForCaller(prime).agents.filter((agent) => agent.role === 'worker').map((agent) => agent.id)).toEqual([
      'worker-1',
      'worker-2'
    ]);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true
    });
    expect(pendingWorkerSpawns().map((entry) => entry.id)).toEqual(['worker-2']);
  });

  it('keeps the sleeping worker separately revivable after a fresh same-brief spawn', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'old identical task finished');
    spawn({ workers: [{ label: 'Worker 1', task: 'task 1' }], caller: prime });
    expect(bindConversation('worker-2', 'c-worker-2')).toBe(true);
    finishAgent({ conversationId: 'c-worker-2' }, 'fresh worker done too');
    expect(releaseQuiescentRun()).toBe(true);

    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'come back to the older chat' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    expect(pendingWorkerRevivals()[0]).toMatchObject({ id: 'worker-1', conversationId: 'c-worker-1' });
  });
});

describe('account-observed worker admission', () => {
  const choices = [{ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['high', 'pro'] as const, aliases: ['gpt-5-6-thinking', 'gpt-5-6-pro'] }];
  let catalog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    catalog = vi.spyOn(chatModels, 'getChatModels').mockReturnValue({
      state: 'ready', requestedAt: null, observedAt: 1,
      models: choices.map(choice => ({ ...choice, efforts: [...choice.efforts] }))
    });
  });
  afterEach(() => catalog.mockRestore());

  it('rejects the whole batch before topology or browser work for a guessed alias', () => {
    const opened = vi.fn();
    onSpawnRequest(opened);
    expect(() => spawn({ caller: prime, workers: [
      { task: 'valid first', model: '5.6', reasoning_effort: 'high' },
      { task: 'invalid second', model: 'gpt-5.6', reasoning_effort: 'high' }
    ] })).toThrow(/not observed.*5\.6 \(high, pro\)/);
    expect(swarmState().agents).toEqual([]);
    expect(currentRunId()).toBeNull();
    expect(pendingWorkerSpawns()).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
  });

  it('accepts observed ids and preserves an explicit provider lane alias', () => {
    const result = spawn({ caller: prime, workers: [
      { task: 'canonical', model: ' 5.6 ', reasoning_effort: 'high' },
      { task: 'specific lane', model: 'gpt-5-6-pro', reasoning_effort: null }
    ] });
    expect(result.created.map(worker => [worker.model, worker.reasoningEffort])).toEqual([
      ['5.6', 'high'], ['gpt-5-6-pro', null]
    ]);
  });

  it('preserves an explicitly requested observed GPT-6 worker instead of substituting 5.6', () => {
    vi.mocked(chatModels.getChatModels).mockReturnValue({
      state: 'ready', requestedAt: null, observedAt: 1,
      models: [
        { id: 'gpt-6-astra', label: 'GPT-6 Pro', efforts: ['pro'] },
        { id: '5.6', label: 'GPT-5.6', efforts: ['xhigh', 'pro'] }
      ]
    });
    const result = spawn({ caller: prime, workers: [
      { task: 'reserved model request', model: 'gpt-6-astra', reasoning_effort: 'pro' }
    ] });
    expect(result.created[0]).toMatchObject({ model: 'gpt-6-astra', reasoningEffort: 'pro' });
  });

  it('keeps a provider-denied saved pair visible instead of silently starting a lower rung', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true,
      defaultModel: '5.6', defaultReasoning: 'xhigh' } });
    vi.mocked(chatModels.getChatModels).mockReturnValue({
      state: 'ready', requestedAt: null, observedAt: 1,
      models: [{ id: '5.6', label: 'GPT-5.6', efforts: ['pro'] }],
      availability: [{ model: '5.6', label: 'GPT-5.6', effort: 'xhigh',
        status: 'unavailable', retryAt: Date.now() + 60_000 }]
    });
    try {
      expect(() => spawn({ caller: prime, workers: [{ task: 'cooldown-held worker' }] }))
        .toThrow(/selected pair 5\.6\/xhigh is currently unavailable/);
      expect(swarmState().agents).toEqual([]);
      expect(currentRunId()).toBeNull();
      expect(getConfig().multiAgent).toMatchObject({ defaultModel: '5.6', defaultReasoning: 'xhigh' });
    } finally {
      await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true } });
    }
  });

  it.each(['high', 'xhigh'] as const)('preserves the configured GPT-6 %s pair for inherited workers', async effort => {
    const base = defaultConfig();
    await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true,
      defaultModel: 'gpt-6-thinking', defaultReasoning: effort } });
    vi.mocked(chatModels.getChatModels).mockReturnValue({
      state: 'ready', requestedAt: null, observedAt: 1,
      models: [
        { id: 'gpt-6-thinking', label: 'GPT-6', efforts: ['medium', 'high', 'xhigh'] },
        { id: '5.6', label: 'GPT-5.6', efforts: ['xhigh'] }
      ]
    });
    try {
      const result = spawn({ caller: prime, workers: [{ task: 'Use the configured current model' }] });
      expect(result.created[0]).toMatchObject({ model: 'gpt-6-thinking', reasoningEffort: effort });
    } finally {
      await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true } });
    }
  });

  it('does not silently downgrade the configured GPT-6 default when only 5.6 is observed', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true,
      defaultModel: 'gpt-6-thinking', defaultReasoning: 'high' } });
    vi.mocked(chatModels.getChatModels).mockReturnValue({ state: 'ready', requestedAt: null, observedAt: 1,
      models: [{ id: '5.6', label: 'GPT-5.6', efforts: ['high', 'xhigh'] }] });
    try {
      expect(() => spawn({ caller: prime, workers: [{ task: 'Use the configured current model' }] })).toThrow(/no older-model substitution/i);
      expect(currentRunId()).toBeNull();
    } finally { await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true } }); }
  });

  it('reconciles a moved inherited 5.6 picker id to the highest observed 5.6 lane instead of 5.5 Instant', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true,
      defaultModel: '5.6', defaultReasoning: 'xhigh' } });
    vi.mocked(chatModels.getChatModels).mockReturnValue({
      state: 'ready', requestedAt: null, observedAt: 1,
      models: [
        { id: 'gpt-5-6', label: '5.6', efforts: ['none'], aliases: ['gpt-5-6'] },
        { id: 'gpt-5-6-thinking', label: '5.6', efforts: ['medium', 'high', 'max'], aliases: ['gpt-5-6-thinking'] },
        { id: 'gpt-5-5-instant', label: '5.5', efforts: ['none'], aliases: ['gpt-5-5-instant'] }
      ]
    });
    try {
      const result = spawn({ caller: prime, workers: [
        { task: 'use the configured worker default' },
        { task: 'accept the app-facing everyday selector explicitly', model: '5.6', reasoning_effort: 'xhigh' }
      ] });
      expect(result.created).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: 'gpt-5-6-thinking', reasoningEffort: 'max' }),
        expect.objectContaining({ model: 'gpt-5-6-thinking', reasoningEffort: 'max' })
      ]));
    } finally {
      await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true } });
    }
  });

  it('rejects unsupported effort for the observed family', () => {
    expect(() => spawn({ caller: prime, workers: [{ task: 'wrong pair', model: '5.6', reasoning_effort: 'ultra' }] }))
      .toThrow(/reasoning_effort "ultra" is not observed for model "5.6"/);
    expect(swarmRunning()).toBe(false);
  });

  it('validates effective app defaults before reservation', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true, defaultModel: '5.6', defaultReasoning: 'ultra' } });
    try {
      expect(() => spawn({ caller: prime, workers: [{ task: 'defaults' }] })).toThrow(/reasoning_effort "ultra"/);
      expect(swarmRunning()).toBe(false);
    } finally { await setEnabled(true); }
  });

  it('rejects ambiguous aliases even when one matching family supports the effort', () => {
    vi.mocked(chatModels.getChatModels).mockReturnValue({ state: 'ready', requestedAt: null, observedAt: 1, models: [
      { id: 'a', label: 'A', efforts: ['high'], aliases: ['shared'] },
      { id: 'b', label: 'B', efforts: ['pro'], aliases: ['shared'] }
    ] });
    expect(() => spawn({ caller: prime, workers: [{ task: 'ambiguous', model: 'shared', reasoning_effort: 'high' }] }))
      .toThrow(/ambiguous/);
    expect(swarmRunning()).toBe(false);
  });

  it('uses retained observations during refresh but preserves exact settings when no catalog exists', () => {
    vi.mocked(chatModels.getChatModels).mockReturnValue({ state: 'pending', requestedAt: 2, observedAt: 1,
      models: choices.map(choice => ({ ...choice, efforts: [...choice.efforts] })) });
    expect(() => spawn({ caller: prime, workers: [{ task: 'unknown', model: 'gpt-5.6' }] })).toThrow(/not observed/);
    vi.mocked(chatModels.getChatModels).mockReturnValue({ state: 'unavailable', requestedAt: null, observedAt: null, models: [] });
    const result = spawn({ caller: prime, workers: [{ task: 'native confirmation', model: 'future-model', reasoning_effort: 'high' }] });
    expect(result.created[0]).toMatchObject({ model: 'future-model', reasoningEffort: 'high' });
  });
});

describe('worker models', () => {
  it('stores the requested model on the worker and hands it to the browser request', () => {
    const handed: Array<{ id: string; model: string | null }> = [];
    onSpawnRequest((workers) => handed.push(...workers));
    const result = spawn({
      workers: [
        { label: 'Cheap', task: 'bulk work', model: 'cheap-high-reasoning' },
        { label: 'Default', task: 'other work' }
      ],
      caller: prime
    });
    expect(result.created.map((agent) => [agent.id, agent.model])).toEqual([
      ['worker-1', 'cheap-high-reasoning'],
      ['worker-2', 'gpt-6-thinking']
    ]);
    expect(handed).toEqual([
      expect.objectContaining({ id: 'worker-1', model: 'cheap-high-reasoning' }),
      expect.objectContaining({ id: 'worker-2', model: 'gpt-6-thinking', reasoningEffort: 'high' })
    ]);
    expect(pendingWorkerSpawns()).toEqual([
      expect.objectContaining({ id: 'worker-1', model: 'cheap-high-reasoning' }),
      expect.objectContaining({ id: 'worker-2', model: 'gpt-6-thinking', reasoningEffort: 'high' })
    ]);
  });

  it('routes a blank worker model to the safe everyday default instead of the account default', () => {
    const result = spawn({ workers: [{ task: 'plain work', model: '   ' }], caller: prime });
    expect(result.created[0]).toMatchObject({ model: 'gpt-6-thinking', reasoningEffort: 'high' });
  });

  it('rejects a malformed model with zero workers created', () => {
    expect(() =>
      spawn({ workers: [{ task: 'fine' }, { task: 'bad', model: 'not a slug!' }], caller: prime })
    ).toThrow(/model.*slug/i);
    expect(swarmRunning()).toBe(false);
    expect(swarmState().agents).toEqual([]);
  });

  it('folds an exact repeat but treats a different model as new work', () => {
    spawn({ workers: [{ label: 'W', task: 'same task', model: 'model-a' }], caller: prime });
    const repeat = spawn({ workers: [{ label: 'W', task: 'same task', model: 'model-a' }], caller: prime });
    expect(repeat.created.map((agent) => agent.id)).toEqual(['worker-1']);
    const changed = spawn({ workers: [{ label: 'W', task: 'same task', model: 'model-b' }], caller: prime });
    expect(changed.created.map((agent) => agent.id)).toEqual(['worker-2']);
    expect(changed.created[0]?.model).toBe('model-b');
  });

  it('round-trips the model through a snapshot restore and repairs a malformed one', () => {
    spawn({ workers: [{ label: 'W', task: 'task', model: 'model-a' }], caller: prime });
    const saved = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(saved);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.model).toBe('model-a');

    const tampered = snapshotSwarm()!;
    tampered.activeRuns![0]!.agents.find((entry) => entry.info.id === 'worker-1')!.info.model = 'not a slug!';
    resetAgentsForTests();
    restoreSwarm(tampered);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.model).toBeNull();
  });

  it('stores explicit reasoning on the safe everyday worker model', () => {
    const result = spawn({
      workers: [{ label: 'High Reasoning', task: 'deep work', reasoning_effort: 'high' }],
      caller: prime
    });
    expect(result.created[0]).toMatchObject({ id: 'worker-1', model: 'gpt-6-thinking', reasoningEffort: 'high' });
    expect(pendingWorkerSpawns()).toEqual([
      expect.objectContaining({ id: 'worker-1', model: 'gpt-6-thinking', reasoningEffort: 'high' })
    ]);
  });

  it('rejects an unknown reasoning_effort with zero workers created', () => {
    expect(() => spawn({ workers: [{ task: 'work', reasoning_effort: 'banana' }], caller: prime })).toThrow(
      /reasoning_effort must be one of/i
    );
    expect(swarmRunning()).toBe(false);
    expect(swarmState().agents).toEqual([]);
  });

  it('canonicalizes the level spelling but stores the canonical form', () => {
    const result = spawn({ workers: [{ task: 'work', reasoning_effort: ' High ' }], caller: prime });
    expect(result.created[0]?.reasoningEffort).toBe('high');
  });

  it('folds repeats only when model and reasoning both match', () => {
    spawn({ workers: [{ label: 'W', task: 'same', reasoning_effort: 'high' }], caller: prime });
    const repeat = spawn({ workers: [{ label: 'W', task: 'same', reasoning_effort: 'high' }], caller: prime });
    expect(repeat.created.map((agent) => agent.id)).toEqual(['worker-1']);
    const changed = spawn({ workers: [{ label: 'W', task: 'same', reasoning_effort: 'low' }], caller: prime });
    expect(changed.created.map((agent) => agent.id)).toEqual(['worker-2']);
    expect(changed.created[0]?.reasoningEffort).toBe('low');
  });

  it('round-trips reasoning_effort through a snapshot restore and repairs a malformed one', () => {
    spawn({ workers: [{ label: 'W', task: 'task', reasoning_effort: 'high' }], caller: prime });
    const saved = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(saved);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.reasoningEffort).toBe('high');

    const tampered = snapshotSwarm()!;
    // @ts-expect-error a malformed level smuggled past the type system, as disk can hold
    tampered.activeRuns![0]!.agents.find((entry) => entry.info.id === 'worker-1')!.info.reasoningEffort = 'banana';
    resetAgentsForTests();
    restoreSwarm(tampered);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.reasoningEffort).toBeNull();
  });
});

describe('star topology', () => {
  it('allows worker → prime and prime → worker', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(sendMessage(worker.caller, PRIME_ID, 'found something').to).toBe(PRIME_ID);
    expect(sendMessage(prime, 'worker-1', 'noted, carry on').to).toBe('worker-1');
  });

  it('forbids worker → worker in both directions', () => {
    startSwarm(2);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');
    expect(() => sendMessage(one.caller, 'worker-2', 'psst')).toThrow(AgentError);
    expect(() => sendMessage(two.caller, 'worker-1', 'psst')).toThrow(AgentError);
    expect(pendingCount('worker-1')).toBe(0);
    expect(pendingCount('worker-2')).toBe(0);
  });

  it('refuses empty text and unknown recipients, and takes a sleeping one', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(() => sendMessage(worker.caller, PRIME_ID, '   ')).toThrow(/empty/i);
    expect(() => sendMessage(prime, 'worker-9', 'hello')).toThrow(/Unknown agent/);

    // Reporting is not ending. The worker sleeps, its slot goes back, and the prime messaging
    // it is how it gets woken — in the chat it already has, not in a new one.
    finishAgent(worker.caller, 'done');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
    expect(freeWorkerSlots()).toBe(3);
    expect(() => sendMessage(prime, 'worker-1', 'one more thing')).not.toThrow();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    // Waking is holding a slot, not asking for one later: the reservation happens here, so two
    // sends racing for the last slot cannot both win it.
    expect(freeWorkerSlots()).toBe(2);
  });

  it('refuses a worker that ended for good, because its chat has no room left', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    expect(finishAgent(worker.caller, 'done').info.state).toBe('finished');
    expect(() => sendMessage(prime, 'worker-1', 'one more thing')).toThrow(/finished/);
  });
});

describe('at-least-once delivery', () => {
  it('re-offers an unacknowledged message and retires it only on the next call', () => {
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'a correction');

    const first = offerMessages('worker-1');
    expect(first).toHaveLength(1);
    expect(first[0]?.offers).toBe(1);

    // The result never came back, so the same message is offered again rather than lost.
    const second = offerMessages('worker-1');
    expect(second).toHaveLength(1);
    expect(second[0]?.offers).toBe(2);

    // The worker's next authenticated call is the evidence the previous result arrived.
    expect(acknowledgeOffers('worker-1')).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
    expect(offerMessages('worker-1')).toEqual([]);
  });

  it('offers a bounded inbox batch so a deep queue cannot make every tool result enormous', () => {
    startSwarm(1);
    startWorker('worker-1');
    for (let index = 0; index < 20; index++) {
      sendMessage(prime, 'worker-1', `message-${index} ${'x'.repeat(3_980)}`);
    }

    const first = offerMessages('worker-1');
    // The old broker appended every waiting row in one go. Even this 20-message fixture was
    // ~80k characters; the real queue limit permits ~800k before MCP framing/tool output is
    // counted. A result too large to reach ChatGPT is then re-offered unchanged forever.
    expect(first.length).toBeLessThan(20);
    expect(first.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(32_000);

    const delivered = acknowledgeOffers('worker-1');
    expect(delivered.map((message) => message.id)).toEqual(first.map((message) => message.id));
    const second = offerMessages('worker-1');
    expect(second.length).toBeGreaterThan(0);
    expect(second.some((message) => first.some((prior) => prior.id === message.id))).toBe(false);
  });

  it('refuses queue overflow instead of silently dropping an older message', () => {
    startSwarm(1);
    startWorker('worker-1');
    for (let i = 0; i < 200; i++) sendMessage(prime, 'worker-1', `message ${i}`);
    expect(() => sendMessage(prime, 'worker-1', 'one too many')).toThrow(AgentError);
    expect(pendingCount('worker-1')).toBe(200);
  });

  // A run does not end because its workers did. The prime is the run, and it is still
  // sitting there able to spawn more; only the prime chat going away ends it.
  it('queues each final report for the prime and leaves the run standing', () => {
    const ended: string[] = [];
    onSwarmEnd((reason) => ended.push(reason));
    startSwarm(2);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');

    const first = finishAgent(one.caller, 'part one done');
    expect(first.report?.to).toBe(PRIME_ID);
    expect(first.report?.text).toContain('part one done');

    finishAgent(two.caller, 'part two done');
    expect(ended).toEqual([]);
    expect(swarmRunning()).toBe(true);
    expect(pendingCount(PRIME_ID)).toBe(2);
  });

  it('releases the global run as soon as the last worker stops while preserving the prime report', () => {
    const ended: string[] = [];
    onSwarmEnd((reason) => ended.push(reason));
    startSwarm(1);
    const worker = startWorker('worker-1');
    // Only a worker whose own chat has no room left is terminal. Anything else sleeps, and a
    // run that still owns a wakeable worker is not a run anybody has finished with.
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'finished safely');

    // The report belongs to the prime history, not to the scarce global execution claim.
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
    // Parking is not destructive teardown and therefore must not fire the end listener that
    // cancels browser work / installs retired-worker leases.
    expect(ended).toEqual([]);

    const dormant = statusForCaller(prime);
    expect(dormant.state.running).toBe(false);
    expect(dormant.state.agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(1);
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
    expect(acknowledgeOffersForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(0);
  });

  it('keeps the prime on the project it moved to during the swarm after the run ends', () => {
    setWorkspaceFor(`chat:${PRIME_CHAT}`, { virtual: '/root/project-a', real: 'C:\\root\\project-a' });
    startSwarm(1);
    const worker = startWorker('worker-1');

    // Spawn mirrored project A into `agent:prime`. During the live run the prime is resolved
    // under that agent identity, so an explicit absolute-path call now moves only that key to B.
    setWorkspaceFor(`chat:${PRIME_CHAT}`, { virtual: '/root/project-b', real: 'C:\\root\\project-b' });
    expect(workspaceForChat(PRIME_CHAT)?.virtual).toBe('/root/project-b');

    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    expect(offerMessages(PRIME_ID)).toHaveLength(1);
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(releaseQuiescentRun()).toBe(true);

    // After endRun the kernel stops assigning `agent:prime`; the conversation key therefore
    // has to carry forward the newest workspace rather than reviving the pre-swarm project.
    expect(workspaceForChat(PRIME_CHAT)?.virtual).toBe('/root/project-b');
  });

  it('keeps a finished worker as a durable dormant identity rather than retiring its history', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'finished safely');

    // Normal parking is ownership preservation, not destructive retirement.
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
    expect(retiredWorkerForConversation('c-worker-1')).toBeNull();
    expect(dormantWorkerNotice('c-worker-1')).toMatch(/WORKER_ENDED.*worker-1/i);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'c-worker-1'
    });
  });

  it('does not release the run while a durability-gated message is still unpublished', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');

    // A production agents::message call stages first, then waits for its immediate durable
    // barrier before commit publishes it to inbox readers. Keep that exact window open.
    const staged = stageMessages(worker.caller, [{ to: PRIME_ID, text: 'one last finding' }]);
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(offerMessages(PRIME_ID)).toEqual([]);

    // A parallel finish can make the last worker terminal while its staged message is still in
    // that acceptance window. Retire the visible finish report exactly as two later prime calls
    // would, leaving pending=0 even though the unpublished message still exists in the queue.
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'finished');
    expect(offerMessages(PRIME_ID)).toHaveLength(1);
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(pendingCount(PRIME_ID)).toBe(0);

    // Ending the run here detaches the staged message object from broker state. Its original
    // tool call can later commit and report success, but no prime inbox exists to receive it.
    expect(releaseQuiescentRun()).toBe(false);
    expect(swarmRunning()).toBe(true);

    staged.commit();
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(releaseQuiescentRun()).toBe(true);
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
    expect(acknowledgeOffersForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
  });
});

describe('an agent that has ended', () => {
  it('treats a repeated finish as the same finish and reports to the prime only once', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const first = finishAgent(worker.caller, 'the work, described');
    expect(first.repeat).toBe(false);
    const again = finishAgent(worker.caller, 'the work, described slightly differently');
    expect(again.repeat).toBe(true);
    expect(again.report).toBeNull();
    expect(pendingCount(PRIME_ID)).toBe(1);
  });

  it.each([
    'The assignment mentioned CORE_UNAVAILABLE as a literal, but this is an ordinary completed result.',
    'CORE_UNAVAILABLE_NOT_EXACT\nThis first-line prefix is not the bounded marker.'
  ])('does not activate the Core fallback for non-exact marker text: %s', (result) => {
    startSwarm(1);
    startWorker('worker-1');

    const finished = finishWorkerConversation('c-worker-1', result);

    expect(finished?.report?.text).toContain('Reuse first: agents action=message to="worker-1"');
    expect(finished?.report?.text).not.toContain("This fallback is scoped to worker-1's tool-free turn");
  });

  it('stops a worker that ended for good sending anything more from its own chat', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    expect(() => sendMessage(worker.caller, PRIME_ID, 'actually, one more thing')).toThrow(AgentError);
  });

  it('lets a worker that only fell asleep carry on talking, because it evidently had not stopped', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');

    // A tool call from that chat is first-hand proof the model is still running there, which
    // is worth more than the app's guess a moment ago. It takes its slot back and the prime is
    // told, because it was told the opposite.
    expect(() => sendMessage(worker.caller, PRIME_ID, 'actually, one more thing')).not.toThrow();
    expect(noteAgentAlive('c-worker-1')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(offerMessages(PRIME_ID).some((message) => /awake again/.test(message.text))).toBe(true);
  });

  it('is told so on its own next tool call, instead of quietly working on', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    // The chat itself does not stop when the slot does — the turn is ChatGPT's — so the
    // next call from it has to be the sentence that says the work is over.
    const notice = endedWorkerNotice(worker.caller.conversationId);
    expect(notice).toMatch(/WORKER_ENDED/);
    expect(notice).toMatch(/worker-1/);
    expect(endedWorkerNotice('c-stranger')).toBeNull();
  });

  it('refuses to finish the prime, because a run with no prime is a reset', () => {
    startSwarm(1);
    expect(() => finishAgent(prime, 'I am done')).toThrow(/prime agent does not finish/);
  });
});

describe('a worker whose chat never opened', () => {
  it('ends as failed, frees its slot, and reports to the prime', () => {
    startSwarm(1);
    const report = failAgent('worker-1', 'no ChatGPT tab could be opened')?.report;
    expect(report?.to).toBe(PRIME_ID);
    expect(report?.text).toContain('Resolve the reported startup problem before spawning a replacement');
    const info = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(info?.state).toBe('failed');
    expect(info?.result).toContain('no ChatGPT tab');
    expect(pendingCount(PRIME_ID)).toBe(1);
    // The slot is free again: a replacement may be created inside the same limit.
    expect(() => spawn({ workers: [{ task: 'replacement' }], caller: prime })).not.toThrow();
  });

  it('stays failed when its chat was never the reason, so no stray tab can revive the slot', () => {
    startSwarm(1);
    startWorker('worker-1');
    failAgent('worker-1', 'tab never opened');
    // A verdict about the work is final. Only a worker given up on because its *view* went
    // away may be taken back, and this one was not.
    expect(noteAgentAlive('c-worker-1')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('failed');
  });

  it('refuses to fail the prime', () => {
    startSwarm(1);
    expect(failAgent(PRIME_ID, 'whatever')).toBeNull();
    expect(swarmRunning()).toBe(true);
  });
});

describe('a worker whose chat closed', () => {
  it('detaches the exact bound worker rather than ending it: the turn is not the tab', () => {
    startSwarm(1);
    startWorker('worker-1');
    expect(workerConversationGone('c-worker-1')).toBe(true);
    const info = swarmState().agents.find((agent) => agent.id === 'worker-1');
    // Still live, still holding its slot, still owed a result. A ChatGPT turn runs on
    // OpenAI's servers, so a closed tab says nothing about whether the work stopped.
    expect(info?.state).toBe('detached');
    // And the prime is told nothing yet, because there is nothing it could act on.
    expect(pendingCount(PRIME_ID)).toBe(0);
  });

  it('keeps a closed-tab worker detached while its server-side turn keeps calling, until a page returns', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    workerConversationGone('c-worker-1');

    // A connector call can continue after the tab was closed because the model turn is
    // server-side. It proves liveness, but not that a browser document exists again. Keep the
    // detached state/slot and restart its silence clock from this call rather than losing the
    // only path that can eventually release a worker whose page never returns.
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');
    expect(sleepSilentDetachedWorkers(Date.now() + DETACHED_SILENCE_MS - 1_000)).toEqual([]);

    // A page observation is the first-hand evidence that the browser view really came back.
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    // It was never out of the run, so its own finish still lands the ordinary way.
    expect(finishAgent(worker.caller, 'done')?.info.state).toBe('sleeping');
  });

  it('sleeps a detached worker on durable completion, and its open tab never wakes it', () => {
    startSwarm(1);
    startWorker('worker-1');
    workerConversationGone('c-worker-1');

    // The stale-run recovery path can observe the durable turn completion after the browser
    // view is already gone. The work stopped; the worker did not end.
    expect(finishWorkerConversation('c-worker-1', 'durably completed')?.info.state).toBe('sleeping');
    const slept = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(slept?.revivable).toBe(true);
    expect(freeWorkerSlots()).toBe(3);

    // Its tab is still open and still reporting the same settled transcript. Waking on that
    // would hand the slot straight back every time the page said hello.
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
  });

  it('ends a durably completed worker for good once its chat is full', () => {
    startSwarm(1);
    startWorker('worker-1');
    fillContext('c-worker-1');
    expect(finishWorkerConversation('c-worker-1', 'durably completed')?.info.state).toBe('finished');
    const finished = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(finished?.revivable).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
  });

  it('sleeps a detached worker only once it has also gone quiet, and reports that to prime', () => {
    startSwarm(1);
    startWorker('worker-1');
    workerConversationGone('c-worker-1');

    // Nothing has been heard from it since the tab went. Its slot goes back, but nothing here
    // is evidence that it is done — the chat is intact and the prime can wake it in place.
    expect(sleepSilentDetachedWorkers(Date.now() + DETACHED_SILENCE_MS + 1_000).length).toBe(1);
    const slept = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(slept?.state).toBe('sleeping');
    expect(slept?.revivable).toBe(true);
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(() => spawn({ workers: [{ task: 'replacement after close' }], caller: prime })).not.toThrow();

    // A worker that was quiet for six minutes and then calls again was, evidently, still going.
    const back = noteAgentAlive('c-worker-1');
    expect(back?.revived).toBe(true);
    expect(back?.report?.to).toBe(PRIME_ID);
    expect(back?.report?.text).toMatch(/awake again/);
  });

  it('does nothing for the prime, a stranger, or an already finished worker', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(workerConversationGone(PRIME_CHAT)).toBe(false);
    expect(workerConversationGone('c-stranger')).toBe(false);
    finishAgent(worker.caller, 'done');
    expect(workerConversationGone('c-worker-1')).toBe(false);
  });
});

describe('clearing one agent from the app', () => {
  it('retires a deleted worker alone and a deleted prime with its complete run', () => {
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    expect(retireConversationForDeletion('c-worker-1')).toMatchObject({
      retired: 'worker', agentId: 'worker-1'
    });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('failed');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-2')?.state).toBe('active');

    expect(retireConversationForDeletion(PRIME_CHAT)).toMatchObject({ retired: 'run', agentId: PRIME_ID });
    expect(swarmRunning()).toBe(false);
    expect(retiredWorkerForConversation('c-worker-2')).toMatchObject({ id: 'worker-2' });
  });

  it('frees a worker slot without touching its siblings, and tells the prime a person did it', () => {
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    const result = clearAgent('worker-1');
    expect(result.cleared).toBe('worker');
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-2')?.state).not.toBe('failed');
    const report = offerMessages(PRIME_ID).map((message) => message.text).join('\n');
    expect(report).toMatch(/user/i);
  });

  it('ends the whole run when the prime is cleared', () => {
    startSwarm(1);
    expect(clearAgent(PRIME_ID).cleared).toBe('run');
    expect(swarmRunning()).toBe(false);
  });

  it('clears only the active prime row and preserves another prime dormant history', () => {
    startSwarm(1);
    const workerA = startWorker('worker-1', 'c-worker-a-row-clear');
    finishAgent(workerA.caller, 'A parked first');
    expect(releaseQuiescentRun()).toBe(true);

    const primeB: Caller = { conversationId: 'c-prime-b-row-clear' };
    spawn({ workers: [{ task: 'B active work' }], caller: primeB });
    startWorker('worker-1', 'c-worker-b-row-clear');
    // Slot names repeat, but sidebar parentage follows exact conversation ownership.
    expect(primeForOwnedConversation('c-worker-a-row-clear')).toBe(PRIME_CHAT);
    expect(primeForOwnedConversation('c-worker-b-row-clear')).toBe(primeB.conversationId);
    expect(primeForOwnedConversation('unrelated')).toBeNull();

    expect(clearAgent(PRIME_ID).cleared).toBe('run');
    expect(swarmRunning()).toBe(false);
    expect(retiredWorkerForConversation('c-worker-b-row-clear')).toMatchObject({
      id: 'worker-1',
      conversationId: 'c-worker-b-row-clear'
    });
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: 'c-worker-a-row-clear'
    });
  });

  it('does nothing, and says so, for an agent that has already ended or never existed', () => {
    startSwarm(2);
    const worker = startWorker('worker-1');
    const other = startWorker('worker-2');
    // A sleeping worker is still one the person can throw away — that is what clearing is
    // for. Only a worker that has already ended has nothing left to clear.
    finishAgent(worker.caller, 'done');
    expect(clearAgent('worker-1').cleared).toBe('worker');
    fillContext('c-worker-2');
    finishAgent(other.caller, 'done');
    expect(clearAgent('worker-2').cleared).toBe('none');
    expect(clearAgent('worker-9').cleared).toBe('none');
    resetAgentsForTests();
    expect(clearAgent('worker-1').cleared).toBe('none');
  });
});


/**
 * Workers sleep instead of ending, and the prime wakes them in the chat they already have.
 *
 * The expensive part of a run is the conversation a worker built up, and throwing that away
 * after one task is what fills somebody's ChatGPT with abandoned chats. Everything here is
 * about that one chat surviving — the tab closing, the prime pausing, the app restarting —
 * and about the worker slot, which is the only genuinely scarce thing in the run.
 */
describe('a worker that is sleeping', () => {
  it.each(['browser', 'call'] as const)('replaces old assignment metadata before %s revival and retains the old report', (delivery) => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'task A completed');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'inspect task B' }]);
    staged.commit();
    const current = () => statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1');
    expect(current()).toMatchObject({ state: 'waking', label: 'worker-1', task: 'inspect task B', result: null });
    expect(offerMessages(PRIME_ID).some((message) => message.text.includes('task A completed'))).toBe(true);
    const saved = snapshotSwarm();
    resetAgentsForTests();
    restoreSwarm(saved);
    expect(current()).toMatchObject({ state: 'waking', label: 'worker-1', task: 'inspect task B', result: null });
    if (delivery === 'browser') {
      const revival = pendingWorkerRevivals()[0]!;
      expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    }
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(current()).toMatchObject({ state: 'active', label: 'worker-1', task: 'inspect task B', result: null });
    finishAgent(worker.caller, 'task B completed');
    expect(current()).toMatchObject({ state: 'sleeping', result: 'task B completed' });
  });

  it('restores prior assignment metadata when a new assignment is rejected before acceptance', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'task A completed');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'inspect task B' }]);
    staged.rollback();
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping', label: 'Worker 1', task: 'task 1', result: 'task A completed', pending: 0
    });
  });

  it('clears a completion result when the same assignment proves it is still running', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'premature report');
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')?.result).toBe('premature report');
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'active', label: 'Worker 1', task: 'task 1', result: null
    });
  });

  it('refreshes queued-work assignment metadata and restores it if reservation rolls back', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'queued task B');
    finishAgent(worker.caller, 'task A completed');
    const staged = stageQueuedWorkerRevivals(['worker-1']);
    expect(staged.waking).toEqual(['worker-1']);
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'waking', label: 'worker-1', task: 'queued task B', result: null
    });
    staged.rollback();
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping', label: 'Worker 1', task: 'task 1', result: 'task A completed', pending: 1
    });
    stageQueuedWorkerRevivals(['worker-1']).commit();
    failWorkerRevival('worker-1', 'fixture pre-send failure');
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping', label: 'worker-1', task: 'queued task B', result: null, pending: 1
    });
  });

  it('exposes exact aged runtime-cleanup candidates and lets a wake win revalidation', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
      startSwarm(1);
      const worker = startWorker('worker-1');
      finishAgent(worker.caller, 'done for now');
      expect(sleepingWorkerRuntimeCandidates(Date.now(), 15 * 60_000)).toEqual([]);

      vi.setSystemTime(Date.now() + 16 * 60_000);
      const [candidate] = sleepingWorkerRuntimeCandidates(Date.now(), 15 * 60_000);
      expect(candidate).toMatchObject({ agentId: 'worker-1', conversationId: 'c-worker-1' });
      expect(ownsSleepingWorkerRuntime(candidate!)).toBe(true);

      expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
      expect(ownsSleepingWorkerRuntime(candidate!)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a proven call from a parked sleeping worker take the slot back, as inside a live run', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done for now');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);

    // Identity lookup alone never reactivates, and neither does the prime's own activity.
    expect(dormantWorkerNotice('c-worker-1')).toContain('WORKER_SLEEPING');
    expect(reactivateDormantRunForConversation(PRIME_CHAT)).toBe(false);
    expect(swarmRunning()).toBe(false);

    // The worker's call does: its family holds the slot again and the call revives it, which
    // is exactly what the same call would have done a moment earlier, before the parking.
    expect(reactivateDormantRunForConversation('c-worker-1')).toBe(true);
    expect(swarmRunning()).toBe(true);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(dormantWorkerNotice('c-worker-1')).toBeNull();
  });

  it('keeps terminal workers parked while allowing sleeping workers their own independent incarnation', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'over the ceiling');
    expect(releaseQuiescentRun()).toBe(true);
    expect(reactivateDormantRunForConversation('c-worker-1')).toBe(false);
    expect(swarmRunning()).toBe(false);

    spawn({ workers: [{ task: 'other work' }], caller: { conversationId: 'c-prime-b' } });
    const other = startWorker('worker-1', 'c-worker-b-1');
    finishAgent(other.caller, 'B done');
    expect(releaseQuiescentRun()).toBe(true);
    startSwarm(1, { conversationId: 'c-prime-c' });
    expect(reactivateDormantRunForConversation('c-worker-b-1')).toBe(true);
    expect(dormantWorkerNotice('c-worker-b-1')).toBeNull();
  });

  it('lets MCP win only before the browser claims a waking worker', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();

    expect(workerRevivalClaimed('c-worker-1')).toBe(false);
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(workerRevivalClaimed('c-worker-1')).toBe(true);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'waking',
      revivable: false
    });

    // A failed durable browser claim restores the pre-cut arbitration window. Only then may a
    // proven old-turn MCP call take the worker back to active and receive the queued inbox.
    expect(rollbackWorkerRevivalClaim('worker-1', 'c-worker-1')).toBe(true);
    expect(workerRevivalClaimed('c-worker-1')).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['second piece']);
  });

  it('finishes a delivered wake on the turn that starts after the sleep, not only on the first call', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    const sleptAt = swarmState().agents.find((agent) => agent.id === 'worker-1')!.sleptAt!;
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);

    // Claimed but not typed: the browser owns the payload, so nothing may end the wake yet —
    // not a turn the page reports, and not the old turn being replayed either.
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt + 1)?.revived).toBe(false);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt)?.revived).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    // The typed message started a turn. That is the model running, and the wake is over.
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt + 1)).toMatchObject({ revived: true, report: null });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'active',
      sleptAt: null
    });
    expect(pendingWorkerRevivals()).toEqual([]);
  });

  it('lets a turn end a pre-claim wake the way a call does, and refuses the page alone', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    const sleptAt = swarmState().agents.find((agent) => agent.id === 'worker-1')!.sleptAt!;
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt + 1)?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    // The queued words were never typed, so they ride on the worker's next result as usual.
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['second piece']);
  });

  it('does not let a stop observed while waking end the wake', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    const before = pendingCount(PRIME_ID);

    // The page replaying the settled answer that put the worker to sleep, the sweep proving
    // that same quiet, and the old turn's late finish call: none of them is a fresh stop.
    expect(stageWorkerConversationFinish('c-worker-1', 'first piece done')).toBeNull();
    expect(finishWorkerConversation('c-worker-1', 'first piece done')).toBeNull();
    expect(sleepWorker('worker-1', 'It went quiet.')).toBeNull();
    expect(finishAgent(worker.caller, 'first piece done').repeat).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(pendingWorkerRevivals().map((entry) => entry.id)).toEqual(['worker-1']);
    expect(pendingCount(PRIME_ID), 'the prime is not told the same report twice').toBe(before);

    // The wake still ends the ordinary way.
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
  });

  it('never re-offers a browser-delivered revival row and only lets a later call acknowledge it', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'browser-owned wake text' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);

    // While the browser owns the wake, even a worker MCP result has no inbox delivery authority.
    expect(offerMessages('worker-1')).toEqual([]);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    const offeredAt = snapshotSwarm()!.agents.find((entry) => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;

    // A call that began before (or in the same millisecond as) the browser ACK cannot use its
    // later completion as evidence that it saw the injected user message.
    expect(acknowledgeOffers('worker-1', false, offeredAt)).toEqual([]);
    expect(offerMessages('worker-1')).toEqual([]);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(acknowledgeOffers('worker-1', false, offeredAt + 1)).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('preserves a revival-proven offer across restart instead of duplicating it through MCP', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'already typed into the worker chat' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    const saved = snapshotSwarm()!;
    const offeredAt = saved.agents.find((entry) => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;

    resetAgentsForTests();
    restoreSwarm(saved);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(offerMessages('worker-1')).toEqual([]);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(acknowledgeOffers('worker-1', false, offeredAt + 1)).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('does not type a browser-delivered revival row again after disable, re-enable and a later wake', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'already delivered before disable' }]).commit();
    const firstRevival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', firstRevival.messageIds)).toBe(true);

    // Turning the feature off is an authoritative pause, not an acknowledgement from the
    // worker. Keep the delivered row for at-least-once receipt accounting, but park the exact
    // worker conversation without ever making that row eligible for browser injection again.
    await setEnabled(false);
    expect(pauseSwarmForDisable()).toBe(true);
    expect(swarmRunning()).toBe(false);

    await setEnabled(true);
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'new work after re-enable' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    const secondRevival = pendingWorkerRevivals()[0]!;
    expect(secondRevival.conversationId).toBe('c-worker-1');
    expect(secondRevival.text).toContain('new work after re-enable');
    expect(secondRevival.text).not.toContain('already delivered before disable');
    expect(secondRevival.messageIds).toHaveLength(1);
  });

  it('keeps a staged finish result and prime report when disable parks the owner before commit', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const staged = stageFinishAgent(worker.caller, 'finish result racing the feature toggle');

    await setEnabled(false);
    expect(pauseSwarmForDisable()).toBe(true);
    expect(swarmRunning()).toBe(false);

    // Ordinary/debounced state must not publish the finish before its acceptance barrier. The
    // disable placeholder is sleeping, but the worker's actual result/report are still staged.
    const ordinary = snapshotSwarm()!;
    const ordinaryWorker = ordinary.dormantRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1');
    expect(ordinaryWorker?.info.result).not.toBe('finish result racing the feature toggle');

    const durable: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      durable.push(snapshot);
    });
    expect(await persistCriticalSwarmNow()).toBe(true);
    const durableHistory = durable.at(-1)?.dormantRuns?.[0]?.agents ?? [];
    expect(durableHistory.find((entry) => entry.info.id === 'worker-1')?.info).toMatchObject({
      state: 'sleeping',
      result: 'finish result racing the feature toggle',
      revivable: true
    });
    expect(durableHistory.find((entry) => entry.info.id === PRIME_ID)?.queue).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('finish result racing the feature toggle') })])
    );

    staged.commit();
    await setEnabled(true);
    const liveHistory = swarmStateForCaller(prime).agents;
    expect(liveHistory.find((entry) => entry.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      result: 'finish result racing the feature toggle',
      revivable: true
    });
    expect(liveHistory.find((entry) => entry.id === PRIME_ID)?.pending).toBe(1);
  });

  it('keeps an in-flight staged message unpublished normally but durable through a disable acceptance barrier', async () => {
    startSwarm(1);
    startWorker('worker-1');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'message accepted while disable races' }]);

    await setEnabled(false);
    expect(pauseSwarmForDisable()).toBe(true);
    expect(snapshotSwarm()!.dormantRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toEqual([]);

    const durable: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      durable.push(snapshot);
    });
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(durable.at(-1)?.dormantRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toEqual([
      expect.objectContaining({ text: 'message accepted while disable races' })
    ]);

    staged.commit();
    await setEnabled(true);
    expect(swarmStateForCaller(prime).agents.find((entry) => entry.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      pending: 1,
      conversationId: 'c-worker-1'
    });
  });

  it('retires already-offered inbox rows transactionally when the browser observes the worker final', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
    });
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'also inspect the parser edge case');
    const offered = offerMessages('worker-1');
    expect(offered).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(1);

    const staged = stageWorkerConversationFinish('c-worker-1', 'final browser answer');
    expect(staged?.repeat).toBe(false);
    expect(await persistCriticalSwarmNow()).toBe(true);
    const projected = persisted.at(-1)!;
    // The one disk generation that says the worker slept also says the already-delivered row
    // is gone and the prime report exists. Live readers stay pre-finish until commit.
    expect(projected.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toEqual([]);
    expect(projected.agents.find((entry) => entry.info.id === PRIME_ID)?.queue.at(-1)?.text).toContain('final browser answer');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({ state: 'active', pending: 1 });

    // A rejected acceptance write must restore the exact offer; it is still retryable work.
    staged!.rollback();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({ state: 'active', pending: 1 });

    const retry = stageWorkerConversationFinish('c-worker-1', 'final browser answer');
    expect(await persistCriticalSwarmNow()).toBe(true);
    retry!.commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({ state: 'sleeping', pending: 0 });

    stageMessages(prime, [{ to: 'worker-1', text: 'now inspect only the lexer' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(revival.text).toContain('now inspect only the lexer');
    expect(revival.text).not.toContain('parser edge case');
  });

  it('preserves a broker message offered after the exact browser final instead of silently acknowledging unread work', async () => {
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'new assignment arriving after the previous final');
    const offered = offerMessages('worker-1');
    expect(offered).toHaveLength(1);
    const offeredAt = snapshotSwarm()!.agents.find(entry => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;
    // The provider's exact final timestamp predates this later inbox offer. A settled
    // answer cannot acknowledge instructions that had not reached that final turn.
    const staged = (stageWorkerConversationFinish as (...args: any[]) => ReturnType<typeof stageWorkerConversationFinish>)(
      'c-worker-1', 'completed earlier work', null, offeredAt - 1
    );
    expect(staged?.report).not.toBeNull();
    expect(await persistCriticalSwarmNow()).toBe(true);
    staged!.commit();
    expect(pendingCount('worker-1')).toBe(1);
    expect(snapshotSwarm()!.agents.find(entry => entry.info.id === 'worker-1')!.queue).toEqual([
      expect.objectContaining({ id: offered[0]!.id, ackedAt: null })
    ]);
  });

  it('fills only an exact sleeping null-result native owner behind the existing critical finish barrier', async () => {
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    sleepWorker('worker-1', 'Completed turn is quiet; native output has not hydrated.');
    const expected = swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')!;
    expect(expected).toMatchObject({ state: 'sleeping', result: null, stopReportId: expect.any(String) });
    const raw = 'RESULT:\n  Late native text with exact trailing spaces  \n';
    const staged = (stageWorkerConversationFinish as (...args: any[]) => ReturnType<typeof stageWorkerConversationFinish>)(
      'c-worker-1', raw, null, expected.sleptAt! - 1, expected
    );
    expect(staged?.report?.text).toContain(raw);
    expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1'))
      .toMatchObject({ state: 'sleeping', result: null, stopReportId: expected.stopReportId });
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async snapshot => { persisted.push(snapshot); });
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted.at(-1)?.agents.find(row => row.info.id === 'worker-1')?.info)
      .toMatchObject({ state: 'sleeping', result: raw, stopReportId: staged!.report!.id });
    staged!.commit();
    expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1'))
      .toMatchObject({ state: 'sleeping', result: raw, stopReportId: staged!.report!.id });
    expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-2')?.state).toBe('active');
    expect(stageWorkerConversationFinish('c-worker-1', 'Do not replace a collected result.')).toBeNull();
  });

  it.each(['runId', 'conversationId', 'sleptAt', 'lastRevivalCommandId', 'stopReportId', 'state', 'result'] as const)(
    'refuses a late native null-result fill with a replaced %s owner', field => {
      startSwarm(2);
      startWorker('worker-1');
      startWorker('worker-2');
      sleepWorker('worker-1', 'Native completion is not hydrated yet.');
      const expected = { ...swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')! };
      Object.assign(expected, { [field]: field === 'sleptAt' ? expected.sleptAt! - 1 : `foreign-${field}` });
      expect((stageWorkerConversationFinish as (...args: any[]) => ReturnType<typeof stageWorkerConversationFinish>)(
        'c-worker-1', 'Do not collect a foreign turn.', null, Date.now(), expected
      )).toBeNull();
      expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1'))
        .toMatchObject({ state: 'sleeping', result: null });
    }
  );

  it('keeps an administrative null-result stop unclosable after durable Prime acknowledgement', async () => {
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    const slept = sleepWorker('worker-1', 'Quiet completion still owes its actual recorded output.');
    expect(slept?.info.result).toBeNull();
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(closableWorkerConversations(0)).toEqual([]);
    expect(offerMessages(PRIME_ID).map(row => row.id)).toEqual([slept!.report!.id]);
    expect(acknowledgeOffers(PRIME_ID, false, Date.now() + 1)).toHaveLength(1);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')?.stopReportAcknowledgedAt)
      .toEqual(expect.any(Number));
    expect(closableWorkerConversations(0)).toEqual([]);
  });

  it('fills a parked and restored null-result native owner without activating that family', async () => {
    startSwarm(1);
    startWorker('worker-1');
    sleepWorker('worker-1', 'Quiet native turn still awaits its output.');
    expect(releaseQuiescentRun()).toBe(true);
    const saved = snapshotSwarm()!;
    resetSwarm();
    restoreSwarm(saved);
    expect(swarmRunning()).toBe(false);
    const expected = swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')!;
    expect(expected).toMatchObject({ state: 'sleeping', result: null, runId: expect.any(String) });
    const raw = 'RESULT: exact native hydration after park and restart.\n';
    const staged = stageWorkerConversationFinish('c-worker-1', raw, null, expected.sleptAt! - 1, expected);
    expect(staged?.report?.text).toContain(raw);
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async snapshot => { persisted.push(snapshot); });
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted.at(-1)?.dormantRuns?.[0]?.agents.find(row => row.info.id === 'worker-1')?.info.result).toBe(raw);
    staged!.commit();
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerRevivals()).toEqual([]);
    expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')?.result).toBe(raw);
    expect(snapshotSwarm()?.dormantRuns?.[0]?.agents.find(row => row.info.id === PRIME_ID)?.queue)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: staged!.report!.id, text: expect.stringContaining(raw) })]));
  });

  it('rolls back failed late native result persistence and retries without replacing the administrative owner', async () => {
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    sleepWorker('worker-1', 'Native final was not hydrated at the inactivity boundary.');
    const expected = swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')!;
    const raw = 'RESULT: retained across one failed critical barrier.\n';
    const rejected = stageWorkerConversationFinish('c-worker-1', raw, null, expected.sleptAt! - 1, expected)!;
    onSwarmPersistNow(async () => { throw new Error('late native disk write rejected'); });
    await expect(persistCriticalSwarmNow()).rejects.toThrow('late native disk write rejected');
    rejected.rollback();
    expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1'))
      .toMatchObject({ state: 'sleeping', result: null, stopReportId: expected.stopReportId });
    expect(snapshotSwarm()?.agents.find(row => row.info.id === PRIME_ID)?.queue.some(row => row.text.includes(raw))).toBe(false);
    const retry = stageWorkerConversationFinish('c-worker-1', raw, null, expected.sleptAt! - 1, expected)!;
    onSwarmPersistNow(async () => undefined);
    expect(await persistCriticalSwarmNow()).toBe(true);
    retry.commit();
    expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')?.result).toBe(raw);
    expect(snapshotSwarm()?.agents.find(row => row.info.id === PRIME_ID)?.queue.filter(row => row.text.includes(raw)))
      .toHaveLength(1);
  });

  it('revokes a staged late native result when its family is replaced before critical publication', async () => {
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    sleepWorker('worker-1', 'Output custody is still pending.');
    const expected = swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')!;
    const raw = 'Do not publish this obsolete hydration.';
    const staged = stageWorkerConversationFinish('c-worker-1', raw, null, expected.sleptAt! - 1, expected)!;
    resetSwarm();
    const replacementPrime = { conversationId: 'c-replacement-prime' };
    spawn({ workers: [{ task: 'New family must not inherit old output.' }], caller: replacementPrime });
    expect(bindConversation('worker-1', 'c-replacement-worker')).toBe(true);
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async snapshot => { persisted.push(snapshot); });
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted.at(-1)?.agents.find(row => row.info.id === 'worker-1')?.info)
      .toMatchObject({ conversationId: 'c-replacement-worker', state: 'active', result: null });
    expect(persisted.at(-1)?.agents.find(row => row.info.id === PRIME_ID)?.queue.some(row => row.text.includes(raw))).toBe(false);
    staged.commit();
    expect(swarmStateForCaller(replacementPrime).agents.find(row => row.id === 'worker-1'))
      .toMatchObject({ conversationId: 'c-replacement-worker', state: 'active', result: null });
  });

  it('refuses an old null-result native proof after a new Prime assignment reserves the worker', () => {
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    sleepWorker('worker-1', 'Earlier native output is pending.');
    const expected = swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')!;
    stageMessages(prime, [{ to: 'worker-1', text: 'The new assignment must survive old hydration.' }]).commit();
    expect(stageWorkerConversationFinish('c-worker-1', 'Obsolete earlier final.', null, expected.sleptAt! - 1, expected)).toBeNull();
    expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')?.state).toBe('waking');
    expect(pendingWorkerRevivals()[0]?.text).toContain('The new assignment must survive old hydration.');
  });

  it('frees its slot without leaving the run, and is woken by being messaged', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');

    const asleep = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(asleep?.state).toBe('sleeping');
    expect(asleep?.revivable).toBe(true);
    // Still bound to its own chat: that binding is the worker, and waking it is reopening it.
    expect(asleep?.conversationId).toBe('c-worker-1');

    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'now do the second half' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();

    // The browser is asked for exactly one thing: this chat, with the prime's own words in it.
    const owed = pendingWorkerRevivals();
    expect(owed).toHaveLength(1);
    expect(owed[0]?.conversationId).toBe('c-worker-1');
    expect(owed[0]?.text).toContain('now do the second half');
    expect(owed[0]?.messageIds).toHaveLength(1);
  });

  it('keeps same-named workers isolated across prime histories and revives the original exact chat later', async () => {
    await setEnabled(true, 1);
    startSwarm(1);
    const first = startWorker('worker-1', 'c-worker-a-1');
    finishAgent(first.caller, 'prime A first piece done');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);

    const primeB: Caller = { conversationId: 'c-prime-b' };
    spawn({ workers: [{ task: 'prime B work' }], caller: primeB });
    const second = startWorker('worker-1', 'c-worker-b-1');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-b-1');

    // A can inspect its history while B owns execution, but cannot wake into B's capacity or
    // enqueue work that would be stranded behind somebody else's active incarnation.
    const parallelWake = stageMessages(prime, [{ to: 'worker-1', text: 'A can wake alongside B' }]);
    parallelWake.rollback();
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      pending: 0,
      conversationId: 'c-worker-a-1'
    });

    finishAgent(second.caller, 'prime B done');
    expect(releaseQuiescentRun()).toBe(true);

    // Both histories keep their own worker-1 without collision after the active claim is gone.
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-a-1');
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-b-1');

    // Explicit owner work reclaims A's history and reserves the one configured slot for A's
    // exact old chat, never B's same-named worker conversation.
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'resume A in the original chat' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    expect(freeWorkerSlots()).toBe(0);
    expect(pendingWorkerRevivals()).toHaveLength(1);
    expect(pendingWorkerRevivals()[0]).toMatchObject({ id: 'worker-1', conversationId: 'c-worker-a-1' });
    expect(pendingWorkerRevivals()[0]?.text).toContain('resume A in the original chat');
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-b-1');

    await setEnabled(true);
  });

  it('restores multiple parked prime histories from one durable snapshot without merging same-named workers', async () => {
    await setEnabled(true, 1);
    const primeB: Caller = { conversationId: 'c-prime-b' };

    startSwarm(1);
    const workerA = startWorker('worker-1', 'c-worker-a-restore');
    finishAgent(workerA.caller, 'A parked');
    expect(releaseQuiescentRun()).toBe(true);

    spawn({ workers: [{ label: 'B worker', task: 'B history' }], caller: primeB });
    const workerB = startWorker('worker-1', 'c-worker-b-restore');
    finishAgent(workerB.caller, 'B parked');
    expect(releaseQuiescentRun()).toBe(true);

    const saved = snapshotSwarm()!;
    expect(saved.version).toBe(6);
    expect(saved.runId).toBeNull();
    expect(saved.dormantRuns).toHaveLength(2);

    resetAgentsForTests();
    restoreSwarm(saved);

    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: 'c-worker-a-restore'
    });
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: 'c-worker-b-restore'
    });

    await setEnabled(true);
  });

  it('explicit Clear swarm destroys parked histories and leaves their worker conversations fenced', () => {
    startSwarm(1);
    const worker = startWorker('worker-1', 'c-worker-clear-dormant');
    finishAgent(worker.caller, 'park before explicit clear');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toBeTruthy();
    expect(swarmState()).toMatchObject({ running: false, retainedHistory: true, agents: [] });

    resetSwarm();

    expect(swarmState()).toMatchObject({ running: false, retainedHistory: false, agents: [] });
    expect(swarmStateForCaller(prime)).toMatchObject({ running: false, retainedHistory: false, agents: [] });
    expect(retiredWorkerForConversation('c-worker-clear-dormant')).toMatchObject({
      id: 'worker-1',
      conversationId: 'c-worker-clear-dormant'
    });
  });

  it('counts only working workers against the limit, so a third runs and the first is woken after', () => {
    startSwarm(3);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');
    const three = startWorker('worker-3');
    expect(freeWorkerSlots()).toBe(0);

    finishAgent(one.caller, 'done');
    expect(freeWorkerSlots()).toBe(1);
    finishAgent(two.caller, 'done');
    finishAgent(three.caller, 'done');
    expect(freeWorkerSlots()).toBe(3);

    // The first one is still there to be woken after the other two have been and gone.
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'back to you' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    expect(freeWorkerSlots()).toBe(2);
  });

  it('refuses to wake one when no slot is free, and queues nothing', () => {
    startSwarm(3);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');
    startWorker('worker-3');
    finishAgent(one.caller, 'done');
    finishAgent(two.caller, 'done');

    // Two sleeping workers, one free slot. The first send takes it; the second is refused
    // outright rather than half-waking anybody.
    stageMessages(prime, [{ to: 'worker-1', text: 'wake up' }]).commit();
    expect(freeWorkerSlots()).toBe(1);
    stageMessages(prime, [{ to: 'worker-2', text: 'you too' }]).commit();
    expect(freeWorkerSlots()).toBe(0);

    const three = startWorker('worker-3');
    finishAgent(three.caller, 'done');
    stageMessages(prime, [{ to: 'worker-3', text: 'and you' }]).commit();
    expect(freeWorkerSlots()).toBe(0);
  });

  it('refuses a second message to a worker whose revival is still in flight', () => {
    startSwarm(2);
    const one = startWorker('worker-1');
    finishAgent(one.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'first' }]).commit();
    // Otherwise the second call's durable message could be stranded with no revival to carry
    // it, if the first one later rolled back.
    expect(() => stageMessages(prime, [{ to: 'worker-1', text: 'second' }])).toThrow(/REVIVE_IN_PROGRESS/);
  });

  it('gives the slot back and keeps the message queued when the browser cannot wake it', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'more work' }]).commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    const report = failWorkerRevival('worker-1', 'the browser could not open its chat');
    const back = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(back?.state).toBe('sleeping');
    expect(back?.revivable).toBe(true);
    expect(freeWorkerSlots()).toBe(3);
    // Nothing was typed, so nothing was delivered: the message is still queued and unoffered.
    expect(pendingCount('worker-1')).toBe(1);
    expect(report?.to).toBe(PRIME_ID);
    expect(report?.text).toContain('could not be woken');

    // And it can simply be tried again.
    const again = stageMessages(prime, [{ to: 'worker-1', text: 'still there?' }]);
    expect(again.waking).toEqual(['worker-1']);
    again.commit();
  });

  it('lets a queued sibling claim the slot released by a failed waking worker without replacing either chat', () => {
    startSwarm(3);
    const first = startWorker('worker-1');
    const second = startWorker('worker-2');
    const third = startWorker('worker-3');
    // Queue sibling work while worker-2 is still active, so it is durable inbox work rather than
    // a second wake racing worker-1 for the only slot.
    stageMessages(prime, [{ to: 'worker-2', text: 'queued sibling follow-up' }]).commit();
    finishAgent(first.caller, 'first pass done');
    finishAgent(second.caller, 'second pass done');
    finishAgent(third.caller, 'third pass done');
    expect(setPrimeWorkerLimit(PRIME_CHAT, 1)).toBe(true);
    expect(freeWorkerSlots()).toBe(1);

    const firstWake = stageMessages(prime, [{ to: 'worker-1', text: 'wake first' }]);
    expect(firstWake.waking).toEqual(['worker-1']);
    firstWake.commit();
    expect(freeWorkerSlots()).toBe(0);
    expect(stageQueuedWorkerRevivals(['worker-2']).waking).toEqual([]);

    failWorkerRevival('worker-1', 'its exact browser wake timed out');
    expect(swarmState().agents.find(agent => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping', revivable: true, conversationId: 'c-worker-1'
    });
    expect(pendingCount('worker-1')).toBe(1);
    expect(freeWorkerSlots()).toBe(1);

    const sibling = stageQueuedWorkerRevivals(['worker-2']);
    expect(sibling.waking).toEqual(['worker-2']);
    sibling.commit();
    expect(swarmState().agents.find(agent => agent.id === 'worker-2')).toMatchObject({
      state: 'waking', conversationId: 'c-worker-2'
    });
    expect(pendingWorkerRevivals().find(row => row.id === 'worker-2')?.text).toContain('queued sibling follow-up');
    expect(freeWorkerSlots()).toBe(0);
  });

  it('treats the browser typing the message as an offer, retired by the worker itself', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'the next piece' }]).commit();
    const owed = pendingWorkerRevivals()[0];

    // Another chat is not this worker's revival, whatever the extension reports.
    expect(noteWorkerRevived('worker-1', 'c-somebody-else', owed?.messageIds ?? [])).toBe(false);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', owed?.messageIds ?? [])).toBe(true);
    let awake = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(awake?.state).toBe('waking');
    expect(awake?.result).toBeNull();
    // Offered, not acknowledged: the worker's own next call is what retires it.
    expect(pendingCount('worker-1')).toBe(1);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    awake = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(awake?.state).toBe('active');
    expect(acknowledgeOffers('worker-1')).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('survives its tab closing, and is still there to be woken', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');

    // Closing the tab of a chat nobody is using is not an ending.
    expect(workerConversationGone('c-worker-1')).toBe(false);
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('sleeping');
    expect(after?.conversationId).toBe('c-worker-1');
    expect(stageMessages(prime, [{ to: 'worker-1', text: 'reopen and carry on' }]).waking).toEqual(['worker-1']);
  });

  it('does not let a tab close steal a waking transaction before its exact send acknowledgement', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'reopen and carry on' }]);
    staged.commit();
    expect(staged.waking).toEqual(['worker-1']);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    // Reload/close can race the command ACK. The leased wake transaction owns the state until
    // that ACK or its timeout settles; rewriting it to detached makes a truthful sent ACK fail.
    expect(workerConversationGone('c-worker-1')).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(noteWorkerRevived('worker-1', 'c-worker-1', staged.messages.map((message) => message.id))).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
  });

  it('does not strand work queued while a closed-tab worker was still considered active', async () => {
    startSwarm(1);
    startWorker('worker-1');
    expect(workerConversationGone('c-worker-1')).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');

    // The prime cannot safely inject a second user turn while the server-side turn may still
    // be running, so this is initially an inbox message rather than an immediate revival.
    const queued = stageMessages(prime, [{ to: 'worker-1', text: 'when you are done, inspect the parser too' }]);
    expect(queued.waking).toEqual([]);
    queued.commit();
    expect(pendingCount('worker-1')).toBe(1);

    // Once silence proves the detached turn has stopped, that already-accepted work must be
    // what wakes the worker. Leaving it merely sleeping strands the instruction until the
    // prime happens to send a second message, even though the first call already said queued.
    sleepSilentDetachedWorkers(Date.now() + DETACHED_SILENCE_MS + 1_000);
    const deferred = stageQueuedWorkerRevivals(['worker-1']);
    expect(deferred.waking).toEqual(['worker-1']);
    expect(await persistCriticalSwarmNow()).toBe(true);
    deferred.commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(pendingWorkerRevivals()[0]?.text).toContain('inspect the parser too');
  });

  it('outlives the prime chat closing, because the user comes back and carries on', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    acknowledgeOffers(PRIME_ID);

    // The case this whole feature is for: the prime stops, the user reads the result, and the
    // prime is asked for more an hour later. Ending the run here threw the workers away with it.
    expect(primeConversationGone(PRIME_CHAT)).toBe(false);
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    expect(noteAgentAlive(PRIME_CHAT)?.revived).toBe(true);
    expect(identify({ conversationId: PRIME_CHAT }).id).toBe(PRIME_ID);
    expect(stageMessages(prime, [{ to: 'worker-1', text: 'one more thing' }]).waking).toEqual(['worker-1']);
  });

  it('keeps a terminal worker report until the closed prime returns and acknowledges it', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    expect(swarmState().agents.find((agent) => agent.role === 'prime')?.pending).toBe(1);

    // No reusable worker remains, but the result that made it terminal is still owed to the
    // prime. Closing its tab must not destroy that report.
    expect(primeConversationGone(PRIME_CHAT)).toBe(false);
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.role === 'prime')?.state).toBe('detached');

    expect(noteAgentAlive(PRIME_CHAT)?.revived).toBe(true);
    expect(offerMessages(PRIME_ID).at(-1)?.text).toContain('[worker-1 finished] done');
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
  });

  it('keeps a worker revivable when it stops one token below the 400k ceiling', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    noteAgentContextTokens('c-worker-1', WORKER_CONTEXT_CEILING_TOKENS - 1);

    const done = finishAgent(worker.caller, 'still reusable');
    expect(done.info).toMatchObject({
      state: 'sleeping',
      revivable: true,
      contextTokens: WORKER_CONTEXT_CEILING_TOKENS - 1
    });
    expect(() => sendMessage(prime, 'worker-1', 'wake below the ceiling')).not.toThrow();
  });

  it('keeps working after it crosses the context ceiling, and only then ends for good', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');

    // Crossing is not an interruption. The worker is mid-task and stays exactly where it is;
    // what changes is that this task is now its last one.
    fillContext('c-worker-1');
    const during = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(during?.state).toBe('active');
    expect(during?.revivable).toBe(false);
    // The ceiling revokes the *next wake*, not live messaging. Prime redirects sent while this
    // exact worker is still active must remain deliverable through its normal inbox.
    expect(() => sendMessage(prime, 'worker-1', 'include the last parser edge case')).not.toThrow();
    expect(offerMessages('worker-1').at(-1)?.text).toBe('include the last parser edge case');
    expect(() => sendMessage(worker.caller, PRIME_ID, 'still going')).not.toThrow();

    const done = finishAgent(worker.caller, 'the last thing it will ever do');
    expect(done.info.state).toBe('finished');
    expect(done.info.revivable).toBe(false);
    expect(() => sendMessage(prime, 'worker-1', 'once more')).toThrow(/finished/);
  });

  it('promotes a sleeping worker to finished the moment its chat crosses the ceiling', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    // A late measurement of the same chat — the session store finishing its accounting after
    // the worker stopped — is what makes that stop permanent.
    fillContext('c-worker-1');
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(after?.revivable).toBe(false);
  });

  it('upgrades a staged sleeping finish if the 400k crossing lands before its durable barrier', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const staged = stageFinishAgent(worker.caller, 'last piece done');
    expect(staged.info.state).toBe('sleeping');

    // Session accounting can finish while the broker fsync for the final observation is still
    // pending. The one durable snapshot must not combine the new >=400k authority fact with the
    // stale pre-crossing "sleeping/revivable" finish projection.
    fillContext('c-worker-1');
    let written: ReturnType<typeof snapshotSwarm> | undefined;
    onSwarmPersistNow(async (snapshot) => {
      written = snapshot;
    });
    expect(await persistCriticalSwarmNow()).toBe(true);

    expect(staged.info.state).toBe('finished');
    expect(staged.info.revivable).toBe(false);
    expect(staged.report?.text).toMatch(/finished for good|cannot be woken/i);
    const saved = written?.agents.find((entry) => entry.info.id === 'worker-1')?.info;
    expect(saved?.contextTokens).toBeGreaterThanOrEqual(WORKER_CONTEXT_CEILING_TOKENS);
    expect(saved?.state).toBe('finished');
    expect(saved?.revivable).toBe(false);

    staged.commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
  });

  it('preserves exact Core incident evidence when a staged browser finish crosses the ceiling', async () => {
    startSwarm(1);
    startWorker('worker-1');
    const staged = stageWorkerConversationFinish(
      'c-worker-1',
      'CORE_UNAVAILABLE\nNo local Core operation ran.',
      {
        turnId: 'g-core-at-ceiling',
        startedAt: 100,
        endedAt: 200,
        diagnostic: {
          kind: 'zero_core_ingress',
          boundary: 'ingress',
          detail: 'No Core request reached this app for the exact incident while another exact chat proved the route.'
        }
      }
    )!;
    expect(staged.info.state).toBe('waking');
    expect(staged.report?.text).toContain('zero_core_ingress (ingress boundary)');

    fillContext('c-worker-1');
    let written: ReturnType<typeof snapshotSwarm> | undefined;
    onSwarmPersistNow(async (snapshot) => {
      written = snapshot;
    });
    expect(await persistCriticalSwarmNow()).toBe(true);

    expect(staged.info).toMatchObject({ state: 'finished', revivable: false });
    expect(staged.report?.text).toContain('zero_core_ingress (ingress boundary)');
    expect(staged.report?.text).toContain('for the exact recorded turn');
    expect(staged.report?.text).toMatch(/^\[worker-1 finished\]\r?\nCORE_UNAVAILABLE/);
    expect(staged.report?.text).toContain('The prime should perform the listed local work itself');
    const saved = written?.agents.find((entry) => entry.info.id === 'worker-1')?.info;
    expect(saved).toMatchObject({ state: 'finished', revivable: false, coreUnavailableRetries: 0 });
    expect(pendingWorkerRevivals()).toEqual([]);

    staged.commit();
    const report = offerMessages(PRIME_ID).find((message) => message.text.includes('CORE_UNAVAILABLE'));
    expect(report?.text).toContain('zero_core_ingress (ingress boundary)');
  });

  it('never rolls a waking worker back to revivable sleep after it crosses 400k', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'one more task' }]);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    fillContext('c-worker-1');
    staged.rollback();

    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(after?.revivable).toBe(false);
  });

  /**
   * On 2026-09-03 worker-7's conversation answered every load with "This content is
   * unavailable". Four wakes each waited out their deadline and each told the prime to try once
   * more — thirty minutes before it spawned the replacement it could have spawned after the
   * first repeat. The second failed wake with nothing heard from the chat in between is the
   * verdict on the chat.
   */
  it('ends a worker whose chat fails two wakes in a row, and lets that chat bring it back', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    expect(WAKE_FAILURES_BEFORE_GIVING_UP).toBe(2);

    stageMessages(prime, [{ to: 'worker-1', text: 'more work' }]).commit();
    failWorkerRevival('worker-1', 'the chat this app opened did not report back in time');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    stageMessages(prime, [{ to: 'worker-1', text: 'still there?' }]).commit();
    const report = failWorkerRevival('worker-1', 'the chat this app opened did not report back in time');
    const gone = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(gone?.state).toBe('failed');
    expect(freeWorkerSlots()).toBe(3);
    expect(report?.to).toBe(PRIME_ID);
    expect(report?.text).toMatch(/2 revivals in a row/);
    expect(report?.text).toMatch(/spawn a replacement/);
    expect(report?.text).not.toMatch(/try agents action=message/i);
    // Its inbox is kept: a revivable failure is a verdict on reachability, not on the work.
    expect(pendingCount('worker-1')).toBe(2);
    expect(() => stageMessages(prime, [{ to: 'worker-1', text: 'third try' }])).toThrow();

    // The chat calling in again is first-hand proof it can be reached after all.
    const back = noteAgentAlive('c-worker-1', 'call');
    expect(back?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
  });

  it('forgives a single failed wake once the chat has been heard from since', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');

    stageMessages(prime, [{ to: 'worker-1', text: 'more work' }]).commit();
    failWorkerRevival('worker-1', 'browser could not reopen the chat');
    // The worker's page reports in between: the count starts over.
    noteAgentAlive('c-worker-1', 'page');

    stageMessages(prime, [{ to: 'worker-1', text: 'again' }]).commit();
    failWorkerRevival('worker-1', 'browser could not reopen the chat');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
  });

  it('never fails a reusable worker for repeated pre-delivery browser transport misses', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');

    for (let attempt = 0; attempt < 4; attempt++) {
      stageMessages(prime, [{ to: 'worker-1', text: `transport retry ${attempt}` }]).commit();
      const report = failWorkerRevival(
        'worker-1',
        'the command remained queued without reaching the browser',
        undefined,
        'transport'
      );
      expect(report?.text).toContain('not a worker failure');
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'sleeping',
        revivable: true
      });
    }
  });

  /**
   * A worker chat never becomes an ordinary chat by finishing. The owner lookup deliberately
   * forgets a worker that is over; the Goal and compaction fences must not, or a chat that
   * crossed the ceiling is compacted like a plain chat over the line (2026-09-03, twice).
   */
  it('still counts a finished worker chat as a worker chat', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(isWorkerConversation('c-worker-1')).toBe(true);
    expect(isWorkerConversation('c-prime')).toBe(false);
    expect(isWorkerConversation('c-nobody')).toBe(false);

    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done at the ceiling');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
    expect(isWorkerConversation('c-worker-1')).toBe(true);
  });

  it('terminalises a failed in-flight revival if that chat crossed 400k while waking', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'one more task' }]).commit();
    fillContext('c-worker-1');

    const report = failWorkerRevival('worker-1', 'browser could not reopen the chat');
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(after?.revivable).toBe(false);
    expect(report?.text).toMatch(/context limit|cannot be woken|finished for good/i);
    expect(report?.text).not.toMatch(/try agents action=message/i);
  });

  it('does not leave accepted prime work stranded when a sleeping worker crosses the ceiling', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');

    // The prime got an accepted send, but the browser failed before typing it. The worker is
    // asleep again with real unread work in its durable inbox.
    stageMessages(prime, [{ to: 'worker-1', text: 'finish the parser audit' }]).commit();
    failWorkerRevival('worker-1', 'browser could not reopen the chat');
    expect(pendingCount('worker-1')).toBe(1);

    // A late session measurement proves this chat cannot be reused after all. Terminalising it
    // must retire work that can no longer be delivered and tell the prime, rather than leaving
    // a terminal row with a permanently nonzero inbox and a previously-successful send.
    fillContext('c-worker-1');
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(pendingCount('worker-1')).toBe(0);
    expect(
      offerMessages(PRIME_ID).some(
        (message) => message.text.includes('finish the parser audit') && /could not be delivered|not delivered/i.test(message.text)
      )
    ).toBe(true);
  });

  it('never un-crosses the ceiling on a smaller reading', () => {
    startSwarm(1);
    startWorker('worker-1');
    fillContext('c-worker-1');
    noteAgentContextTokens('c-worker-1', 1_000);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.revivable).toBe(false);
  });

  it('keeps an accepted wake across a restart, and asks the browser for it again', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'do the second half' }]).commit();
    const snapshot = snapshotSwarm();

    resetAgentsForTests();
    restoreSwarm(snapshot);

    // The accepted send is durable and so is the reservation carrying it. Demoting this worker
    // back to sleeping on restore would leave the prime's message queued with nothing left to
    // deliver it.
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    const asked: string[] = [];
    onReviveRequest((revivals) => asked.push(...revivals.map((revival) => revival.id)));
    expect(asked).toEqual(['worker-1']);
    expect(pendingWorkerRevivals()[0]?.text).toContain('do the second half');
  });

  it('restores a sleeping worker as itself, still wakeable in the chat it kept', () => {
    startSwarm(2);
    const one = startWorker('worker-1');
    finishAgent(one.caller, 'done');
    const snapshot = snapshotSwarm();
    resetAgentsForTests();
    restoreSwarm(snapshot);

    const restored = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(restored?.state).toBe('sleeping');
    expect(restored?.revivable).toBe(true);
    expect(stageMessages(prime, [{ to: 'worker-1', text: 'again' }]).waking).toEqual(['worker-1']);
  });
});

describe('restart', () => {
  it('drops parked histories beyond the newest sixteen or older than a week, retiring their worker chats', async () => {
    vi.useFakeTimers();
    try {
      await setEnabled(true, 1);
      const park = (n: number): void => {
        spawn({ workers: [{ task: `work ${n}` }], caller: { conversationId: `c-prime-${n}` } });
        const worker = startWorker('worker-1', `c-worker-${n}`);
        finishAgent(worker.caller, `done ${n}`);
        expect(releaseQuiescentRun()).toBe(true);
        vi.setSystemTime(Date.now() + 1_000);
      };
      for (let n = 1; n <= 17; n++) park(n);
      expect(snapshotSwarm()!.dormantRuns).toHaveLength(16);
      expect(dormantWorkerNotice('c-worker-1')).toBeNull();
      expect(retiredWorkerForConversation('c-worker-1')?.id).toBe('worker-1');
      expect(dormantWorkerNotice('c-worker-2')).toContain('WORKER_SLEEPING');

      // A week later the rest are history too, on the next parking and on a restart alike.
      const saved = snapshotSwarm()!;
      vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000);
      park(18);
      expect(snapshotSwarm()!.dormantRuns?.map((entry) => entry.primeConversationId)).toEqual(['c-prime-18']);

      resetAgentsForTests();
      restoreSwarm(saved);
      expect(snapshotSwarm()?.dormantRuns ?? []).toHaveLength(0);
      expect(retiredWorkerForConversation('c-worker-17')?.id).toBe('worker-1');
    } finally {
      vi.useRealTimers();
      await setEnabled(true);
    }
  });

  it('restores every still-live retired worker fence after histories grow beyond the old 64-worker ceiling', () => {
    const now = Date.now();
    restoreRetiredWorkers({
      version: 1,
      savedAt: now,
      workers: Array.from({ length: 65 }, (_, index) => ({
        id: `worker-${index + 1}`,
        conversationId: `c-retired-${index + 1}`,
        reason: 'explicit clear of a long-lived worker history',
        retiredAt: now
      }))
    });

    expect(retiredWorkerForConversation('c-retired-1')).toMatchObject({ id: 'worker-1' });
    expect(retiredWorkerForConversation('c-retired-65')).toMatchObject({ id: 'worker-65' });
  });

  it('restores an active prime beside another prime full sleeping and terminal dormant history', () => {
    const primeB: Caller = { conversationId: 'c-prime-b-active-restore' };
    startSwarm(2);
    const sleeper = startWorker('worker-1', 'c-worker-a-sleeper-restore');
    const terminal = startWorker('worker-2', 'c-worker-a-terminal-restore');
    finishAgent(sleeper.caller, 'keep this exact chat reusable');
    fillContext('c-worker-a-terminal-restore');
    finishAgent(terminal.caller, 'this exact chat is full');
    expect(releaseQuiescentRun()).toBe(true);

    spawn({ workers: [{ task: 'B stays active across restart' }], caller: primeB });
    startWorker('worker-1', 'c-worker-b-active-restore');
    const saved = snapshotSwarm()!;
    expect(saved.runId).not.toBeNull();
    expect(saved.dormantRuns).toHaveLength(1);

    resetAgentsForTests();
    restoreSwarm(saved);

    expect(swarmRunning()).toBe(true);
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'active',
      conversationId: 'c-worker-b-active-restore'
    });
    const aHistory = swarmStateForCaller(prime).agents;
    expect(aHistory.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'c-worker-a-sleeper-restore'
    });
    expect(aHistory.find((agent) => agent.id === 'worker-2')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'c-worker-a-terminal-restore'
    });
    expect(statusForCaller(prime)).toMatchObject({ runId: null, freeWorkerSlots: 3 });
  });

  it('persists worker binding and activation as one state transition', () => {
    startSwarm(1);
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersist(() => persisted.push(snapshotSwarm()));

    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
    expect(persisted).toHaveLength(1);
    const worker = persisted[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.info;
    expect(worker?.conversationId).toBe('c-worker-1');
    expect(worker?.state).toBe('active');
  });

  it('repairs the legacy bound-but-invited crash snapshot instead of opening a duplicate worker chat', () => {
    startSwarm(1);
    const snapshot = snapshotSwarm()!;
    const worker = snapshot.activeRuns![0]!.agents.find((entry) => entry.info.id === 'worker-1')!.info;
    // This is the exact intermediate generation the old two-step activation could put on
    // disk if the process died between its two changed() calls.
    worker.conversationId = 'c-worker-1';
    worker.state = 'invited';
    worker.activatedAt = null;

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(pendingWorkerSpawns()).toEqual([]);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(identify({ conversationId: 'c-worker-1' }).id).toBe('worker-1');
  });

  it('repairs a legacy finished snapshot that still says the worker is revivable', () => {
    startSwarm(1);
    startWorker('worker-1');
    const snapshot = snapshotSwarm()!;
    const worker = snapshot.activeRuns![0]!.agents.find((entry) => entry.info.id === 'worker-1')!.info;
    worker.state = 'finished';
    worker.finishedAt = Date.now();
    worker.result = 'already done';
    worker.revivable = true;

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.revivable).toBe(false);
    expect(noteAgentAlive('c-worker-1')).toBeNull();
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
  });

  it('re-keys a pre-UUID version-4 snapshot instead of restoring its 32-bit run incarnation', () => {
    startSwarm(1);
    const snapshot = snapshotSwarm()!;
    // Version 4 predates the full-UUID run fence. Those builds wrote only the first eight hex
    // characters but the snapshot version itself did not change, so an upgrade can genuinely
    // encounter this durable shape.
    snapshot.runId = 'deadbeef';

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(currentRunId()).not.toBe('deadbeef');
    expect(currentRunId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // Re-keying the recovered incarnation must not throw away the durable run itself. An
    // invited worker will simply be re-bootstrapped under the new fence.
    expect(swarmState().agents.map((agent) => agent.id)).toEqual([PRIME_ID, 'worker-1']);
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1']);
  });

  it('separates critical broker durability from delivery telemetry and drains exact snapshots on demand', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
    });

    startSwarm(1);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.primeConversationId).toBe(PRIME_CHAT);

    sendMessage(prime, 'worker-1', 'critical queue mutation');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
    expect(persisted[1]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);

    // Offer/ACK timestamps are delivery telemetry. They still use the debounced persistence
    // callback, but they do not manufacture another critical disk barrier revision.
    offerMessages('worker-1');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
    acknowledgeOffers('worker-1');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
  });

  it('does not mark a newer critical generation durable when it appears during an older immediate write', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
      if (persisted.length === 1) {
        firstStarted();
        await firstGate;
      }
    });

    startSwarm(1);
    const draining = persistCriticalSwarmNow();
    await firstWriteStarted;
    sendMessage(prime, 'worker-1', 'created while generation one is on disk');
    releaseFirst();

    expect(await draining).toBe(true);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);
    expect(persisted[1]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);
  });

  it('keeps an unpublished message out of a debounced disk write while its immediate acceptance write is held and failing', async () => {
    const stateName = 'message-atomicity-race';
    startSwarm(1);
    // Drain the run-creation revision through the normal test sink so the controlled
    // immediate writer below belongs only to the message being exercised.
    expect(await persistCriticalSwarmNow()).toBe(true);

    // Production wiring snapshots synchronously into the debounced lane whenever the broker
    // says it changed. The timer may reach disk while an independent immediate acceptance
    // barrier is still waiting, so this must be a *committed-only* snapshot.
    onSwarmPersist(() => writeDurableSoon(stateName, snapshotSwarm()));

    let immediateEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      immediateEntered = resolve;
    });
    let releaseImmediate!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseImmediate = resolve;
    });
    let targetRenames = 0;
    const realRename = fs.rename.bind(fs);
    const renameFailure = Object.assign(new Error('injected immediate swarm rename failure'), { code: 'EBUSY' });
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${stateName}.json`)) {
        targetRenames += 1;
        // Rename #1 is the debounced writer fired while the barrier is held. Renames #2–10
        // are the immediate acceptance generation exhausting the atomic writer's eight bounded
        // sharing-lock retries plus its initial attempt. The acceptance write therefore fails
        // and remains pending for the outer durable retry.
        if (targetRenames >= 2 && targetRenames <= 10) throw renameFailure;
      }
      return realRename(from, to);
    });

    onSwarmPersistNow(async (snapshot) => {
      // The immediate lane is the *only* snapshot allowed to contain unpublished messages:
      // it is exactly the generation whose fsync decides whether this send was accepted.
      expect(snapshot?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);
      immediateEntered();
      await held;
      await writeDurableNow(stateName, snapshot);
    });

    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'do not publish before fsync' }]);
    const barrier = persistCriticalSwarmNow();
    await entered;

    // Force the ordinary debounce to disk *before* the acceptance barrier is released. A
    // crash here must recover the pre-send queue, because the sender has not been told the
    // message was accepted yet.
    await flushDurable();
    const whileHeld = await readDurable<ReturnType<typeof snapshotSwarm>>(stateName);
    expect(whileHeld?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);

    releaseImmediate();
    await expect(barrier).rejects.toMatchObject({ code: 'EBUSY' });
    staged.rollback();

    // writeDurableNow keeps its failed generation pending for retry. Rollback must enqueue a
    // *newer* committed-only snapshot, so that failed staged generation can never win later.
    rename.mockRestore();
    await flushDurable();
    const afterRollback = await readDurable<ReturnType<typeof snapshotSwarm>>(stateName);
    expect(afterRollback?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);
  });

  it('publishes a staged worker topology only after its exact critical snapshot is durable', async () => {
    const ordinary: Array<ReturnType<typeof snapshotSwarm>> = [];
    const critical: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersist(() => ordinary.push(snapshotSwarm()));
    onSwarmPersistNow(async (snapshot) => {
      critical.push(snapshot);
    });

    const staged = stageSpawn({ workers: [{ task: 'inspect topology' }], caller: prime });

    // The broker reserves the one global run while acceptance is in flight, but nothing that
    // can publish/open workers is allowed to see the planned topology yet.
    expect(swarmRunning()).toBe(true);
    expect(swarmState()).toMatchObject({ running: false, agents: [] });
    expect(snapshotSwarm()).toBeNull();
    expect(pendingWorkerSpawns()).toEqual([]);
    expect(ordinary.at(-1)).toBeNull();

    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(critical.at(-1)?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
    staged.commit();

    expect(swarmState().running).toBe(true);
    expect(snapshotSwarm()?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
    expect(pendingWorkerSpawns()).toEqual([{ runId: staged.runId, primeConversationId: PRIME_CHAT, id: 'worker-1', model: 'gpt-6-thinking', reasoningEffort: 'high', task: 'inspect topology' }]);
    expect(ordinary.at(-1)?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
  });

  it('rolls a staged addition back to the previously accepted run without leaking it to ordinary snapshots', () => {
    spawn({ workers: [{ task: 'accepted worker' }], caller: prime });
    const before = snapshotSwarm();

    const staged = stageSpawn({ workers: [{ task: 'second worker' }], caller: prime });
    expect(staged.created.map((entry) => entry.id)).toEqual(['worker-2']);
    expect(snapshotSwarm()?.agents.some((entry) => entry.info.id === 'worker-2')).toBe(false);
    expect(pendingWorkerSpawns().map((entry) => entry.id)).toEqual(['worker-1']);

    staged.rollback();
    expect(swarmState().agents.some((entry) => entry.id === 'worker-2')).toBe(false);
    expect(snapshotSwarm()?.agents.map((entry) => entry.info.id)).toEqual(before?.agents.map((entry) => entry.info.id));
    expect(pendingWorkerSpawns().map((entry) => entry.id)).toEqual(['worker-1']);
  });

  it('carries the run, its bindings and its in-flight messages through a snapshot', () => {
    let persists = 0;
    onSwarmPersist(() => {
      persists += 1;
    });
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'keep going, but check the parser');
    offerMessages('worker-1');

    const snapshot = snapshotSwarm()!;
    expect(persists).toBeGreaterThan(0);
    // Nothing in a snapshot can authorise a call, because nothing in this app can: an agent
    // is the conversation it runs in, and that id is recorded on purpose.
    expect(JSON.stringify(snapshot)).not.toMatch(/key|secret|hash/i);

    resetAgentsForTests();
    expect(swarmRunning()).toBe(false);
    restoreSwarm(snapshot);

    expect(swarmRunning()).toBe(true);
    // The prime is still the same chat, and the worker is still in its own.
    expect(identify(prime).id).toBe(PRIME_ID);
    expect(identify({ conversationId: 'c-worker-1' }).id).toBe('worker-1');
    // An offer that was in flight when the app stopped is offered again, not lost.
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual([
      'keep going, but check the parser'
    ]);
  });

  it('replays a queued worker spawn when the bridge registers after the restore', () => {
    startSwarm(2);
    const snapshot = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(snapshot);
    const spawned: string[] = [];
    onSpawnRequest((workers) => spawned.push(...workers.map((worker) => worker.id)));
    expect(spawned).toEqual(['worker-1', 'worker-2']);
  });

  it('repairs only the exact durable prime A→B recovery transition after transfer state was lost', () => {
    startSwarm(2);
    const snapshot = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(true);
    expect(snapshotSwarm()?.primeConversationId).toBe('c-resumed');
    expect(identify({ conversationId: 'c-resumed' }).id).toBe(PRIME_ID);
    // Recovery replay is idempotent, but neither a different source nor an unrelated target
    // can use this hook as a takeover mechanism.
    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(true);
    expect(repairPrimeConversationAfterRecovery('c-other', 'c-hijack')).toBe(false);
    expect(snapshotSwarm()?.primeConversationId).toBe('c-resumed');
  });

  it('refuses recovery repair when the durable target chat is already a worker identity', () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-resumed');
    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(false);
    expect(snapshotSwarm()?.primeConversationId).toBe(PRIME_CHAT);
  });
});

describe('through the MCP endpoint', () => {
  let endpoint: Awaited<ReturnType<typeof startMcpServer>>;
  let nextId = 1;

  const post = (body: unknown, extraHeaders: Record<string, string> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const url = new URL(endpoint.url);
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': Buffer.byteLength(payload),
            ...extraHeaders
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            const frame = text.startsWith('{') ? text : ([...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? '{}');
            try {
              resolve(JSON.parse(frame));
            } catch {
              resolve({ raw: text });
            }
          });
        }
      );
      req.on('error', reject);
      req.end(payload);
    });

  let evidenceSeq = 0;

  const waitForRunningToolCall = async (timeoutMs = 5_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (runningToolCalls() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runningToolCalls()).toBeGreaterThan(0);
  };

  const callTool = async (name: string, args: unknown): Promise<string> => {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
    return ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
  };

  const agents = (action: string, args: Record<string, unknown> = {}): Promise<string> =>
    callTool('agents', { action, ...args });

  const agentsWithRequestId = async (
    requestId: string,
    action: string,
    args: Record<string, unknown> = {}
  ): Promise<string> => {
    const reply = await replyWithRequestId(requestId, action, args);
    return ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
  };

  const replyWithRequestId = (requestId: string, action: string, args: Record<string, unknown>): Promise<any> =>
    post(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'agents', arguments: { action, ...args } } },
      { 'x-request-id': `${requestId}/relay` }
    );

  const ordinaryWithRequestId = (requestId: string, name: string, args: Record<string, unknown>): Promise<any> =>
    post(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
      { 'x-request-id': `${requestId}/relay` }
    );

  const textOfReply = (reply: any): string =>
    ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');

  /** The evidence dance of asChat, kept, but reading the machine half of the result. */
  const structuredAsChat = async (
    conversationId: string,
    action: string,
    args: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> => {
    const seq = ++evidenceSeq;
    const requestId = `wfr_agents_${seq}`;
    const pending = replyWithRequestId(requestId, action, args);
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: Date.now(), turnId: `t-${seq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-${seq}`,
        calls: [{ messageId: `m-${seq}`, tool: 'agents', order: 0, answered: false, requestId }]
      }
    ]);
    return (await pending).result?.structuredContent ?? {};
  };

  /**
   * Makes a call that ChatGPT's own message model names, from one conversation.
   *
   * This is the only identity anything has now, so it is the only way to make a control
   * call as somebody. The evidence is fed *while the request is in flight*, which is one of
   * the two ways it really arrives. The other is ahead of the call — ChatGPT paints the
   * connector row while it is still composing the request — and that one is covered
   * separately below, because assuming it could not happen is exactly what made every live
   * spawn impossible.
   */
  const asChat = async (conversationId: string, action: string, args: Record<string, unknown> = {}): Promise<string> => {
    const seq = ++evidenceSeq;
    const requestId = `wfr_agents_${seq}`;
    const pending = agentsWithRequestId(requestId, action, args);
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: Date.now(), turnId: `t-${seq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-${seq}`,
        calls: [{ messageId: `m-${seq}`, tool: 'agents', order: 0, answered: false, requestId }]
      }
    ]);
    return pending;

  };

  beforeEach(async () => {
    endpoint = await startMcpServer(() => ({
      roots: [],
      caps: { ...DEFAULT_CAPABILITIES },
      readOnly: true,
      sessionTools: false,
      agentTools: true
    }));
  });

  afterEach(async () => {
    await endpoint.stop();
  });

  // One flat tool with five actions. The names it replaced are gone outright, not aliased,
  // so a chat still holding the old instructions gets an honest unknown-tool error.
  it('publishes one agents tool with exactly four actions', async () => {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} });
    const names = (reply.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain('agents');
    for (const gone of [
      'agent_inbox',
      'agent_status',
      'create_agents',
      'finish_agent',
      'join_agent',
      'revive_agent',
      'send_agent_message'
    ]) {
      expect(names).not.toContain(gone);
    }

    const schema = (reply.result.tools as Array<{ name: string; inputSchema: any }>).find(
      (tool) => tool.name === 'agents'
    )!.inputSchema;
    expect(schema.properties.action.enum.slice().sort()).toEqual(['finish', 'message', 'spawn', 'status']);
    expect(schema.properties.workers.maxItems).toBe(6);
    // Revive is gone from the wire as well as from the broker: no field survives for it.
    expect(Object.keys(schema.properties)).not.toContain('agent');
  });

  it('is identified by exact request-id evidence that arrived before the call it names', async () => {
    // Evidence may arrive before HTTP. The timestamp is irrelevant; the normalized request
    // id is the join, so a pre-existing exact mate remains authoritative.
    await recordChatObservations('c-ahead', [
      { kind: 'turn_start', time: Date.now() - 5_500, turnId: 't-ahead' },
      {
        kind: 'tool_evidence',
        time: Date.now() - 5_500,
        turnId: 't-ahead',
        calls: [{ messageId: 'm-ahead', tool: 'agents', order: 0, answered: false, requestId: 'wfr_agents_ahead' }]
      }
    ]);

    const text = await agentsWithRequestId('wfr_agents_ahead', 'spawn', { workers: [{ task: 'read the file' }] });

    expect(text).not.toContain('UNIDENTIFIED_CALLER');
    expect(swarmRunning()).toBe(true);
    expect(identify({ conversationId: 'c-ahead' }).id).toBe(PRIME_ID);
  });

  it('refuses a spawn whose conversation this app cannot prove, and creates nothing', async () => {
    const text = await agents('spawn', { workers: [{ task: 'anything' }] });
    expect(text).toMatch(/UNIDENTIFIED_CALLER|could not/i);
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('publishes each accepted MCP spawn to its own run when another prime is active', async () => {
    const opened = vi.fn();
    const dispose = onSpawnRequest(opened);
    try {
      await asChat('prime-existing', 'spawn', { workers: [{ task: 'existing work' }] });
      await asChat('prime-new', 'spawn', { workers: [{ task: 'new work' }] });
      expect(opened).toHaveBeenCalledTimes(2);
      expect(opened.mock.calls.map(([workers]) => workers)).toEqual([
        [expect.objectContaining({ id: 'worker-1', runId: currentRunId('prime-existing'), primeConversationId: 'prime-existing', task: 'existing work' })],
        [expect.objectContaining({ id: 'worker-1', runId: currentRunId('prime-new'), primeConversationId: 'prime-new', task: 'new work' })]
      ]);
    } finally {
      dispose();
    }
  });

  it('queues one bounded same-chat retry for a tool-free CORE_UNAVAILABLE final', async () => {
    // The app-wide Core endpoint is connected and advertises read. That is intentionally not
    // proof that this worker chat received the tool; the fallback is scoped to the worker final.
    const listed = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} });
    const toolNames = (listed.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(['read', 'agents']));

    const catalog = vi.spyOn(chatModels, 'getChatModels').mockReturnValue({
      state: 'ready', requestedAt: null, observedAt: Date.now(),
      models: [{ id: '5.6', label: 'GPT-5.6', efforts: ['pro', 'xhigh'] }]
    });
    const opened: Array<{ id: string; task: string }> = [];
    const dispose = onSpawnRequest((workers) => opened.push(...workers));
    try {
      spawn({
        workers: [{ task: 'Inspect src/main/agents.ts, make the lifecycle edit, and run the focused tests.', model: '5.6', reasoning_effort: 'pro' }],
        caller: prime
      });
      expect(opened).toHaveLength(1);
      expect(opened[0]!.task).toBe('Inspect src/main/agents.ts, make the lifecycle edit, and run the focused tests.');
      expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);

      const result = [
        'CORE_UNAVAILABLE',
        'Context-only reasoning: this worker received no Core tools and inspected no repository files.',
        'Prime local checklist:',
        '- Read src/main/agents.ts and the worker lifecycle tests.',
        '- Apply the lifecycle edit only after inspecting the current diff.',
        '- Run the focused Vitest file, typecheck, and git diff --check.'
      ].join('\n');
      const durable: Array<ReturnType<typeof snapshotSwarm>> = [];
      onSwarmPersistNow(async (snapshot) => {
        durable.push(JSON.parse(JSON.stringify(snapshot)));
      });
      const staged = stageWorkerConversationFinish('c-worker-1', result, {
        turnId: 'core-missing-turn', startedAt: 100, endedAt: 101,
        diagnostic: { kind: 'zero_core_ingress', boundary: 'ingress', detail: 'No Core request reached this account.' },
        accountProfileId: 'profile-garry', accountLabel: 'Beta'
      });
      expect(staged?.repeat).toBe(false);
      expect(await persistCriticalSwarmNow()).toBe(true);
      const durableWorker = durable.at(-1)?.activeRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1');
      expect(durableWorker?.info).toMatchObject({ state: 'waking', coreUnavailableRetries: 1 });
      expect(durableWorker?.queue).toEqual([
        expect.objectContaining({ text: expect.stringContaining('automatic Core recovery (1/1)') })
      ]);
      staged!.commit();

      // The durable finish owns one same-chat recovery. It reserves the existing worker rather
      // than creating a second conversation, and its text repeats only the harmless preflight.
      const first = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
      expect(first).toMatchObject({ state: 'waking', coreUnavailableRetries: 1 });
      const revival = pendingWorkerRevivals()[0]!;
      expect(revival).toMatchObject({ id: 'worker-1', conversationId: 'c-worker-1', model: '5.6', reasoningEffort: 'xhigh' });
      expect(revival.text).toContain('automatic Core recovery (1/1)');
      expect(revival.text).toContain('First call Core read');
      expect(revival.text).toContain('do not repeat any external side effect');

      // A browser replay of the same settled answer while the recovery is waking cannot create
      // another report, worker, or mutation attempt.
      expect(stageWorkerConversationFinish('c-worker-1', result)).toBeNull();
      expect(opened).toHaveLength(1);
      expect(pendingWorkerSpawns()).toEqual([]);
      expect(pendingCount(PRIME_ID)).toBe(1);
      expect(runningToolCalls()).toBe(0);

      const reports = offerMessagesForConversation(PRIME_CHAT)?.messages.filter((message) =>
        message.text.includes('CORE_UNAVAILABLE')
      ) ?? [];
      expect(reports).toHaveLength(1);
      expect(reports[0]!.text).toMatch(/^\[worker-1 reported\]\r?\nCORE_UNAVAILABLE\r?\n/);
      expect(reports[0]!.text).toContain('Read src/main/agents.ts and the worker lifecycle tests.');
      expect(reports[0]!.text).toContain('queued one automatic retry in this same worker chat');
      expect(reports[0]!.text).toContain('does not prove Core, the connector, or the tunnel is globally down');
      expect(reports[0]!.text).toContain('for account Beta');
      expect(reports[0]!.text).toContain('Core may still be healthy for this account');
      expect(reports[0]!.text).toContain('current tool snapshot and companion/schema publication');
      expect(reports[0]!.text).toContain('do not change a bridge port');

      // Deliver the recovery and prove its new turn started. A second missing-Core final stops
      // cleanly: no third turn is queued and the prime gets the manual fallback guidance.
      const sleptAt = first.sleptAt!;
      expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
      expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
      expect(noteAgentAlive('c-worker-1', 'turn', sleptAt + 1)?.revived).toBe(true);
      const second = stageWorkerConversationFinish('c-worker-1', result);
      expect(second?.repeat).toBe(false);
      expect(await persistCriticalSwarmNow()).toBe(true);
      second!.commit();
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'sleeping',
        coreUnavailableRetries: 1
      });
      expect(pendingWorkerRevivals()).toEqual([]);
      const secondReports = offerMessagesForConversation(PRIME_CHAT)?.messages.filter((message) =>
        message.text.includes('CORE_UNAVAILABLE')
      ) ?? [];
      expect(secondReports).toHaveLength(2);
      expect(secondReports[1]!.text).toContain('bounded automatic same-chat Core retry has already been used');
      expect(secondReports[1]!.text).toContain('The prime should perform the listed local work itself');
      expect(opened).toHaveLength(1);
    } finally {
      dispose();
      catalog.mockRestore();
    }
  });

  it('restores the worker\'s requested model on its next wake after a successful Extra High Core retry', async () => {
    const catalog = vi.spyOn(chatModels, 'getChatModels').mockReturnValue({
      state: 'ready', requestedAt: null, observedAt: Date.now(),
      models: [{ id: '5.6', label: 'GPT-5.6', efforts: ['pro', 'xhigh'] }]
    });
    try {
      spawn({ caller: prime, workers: [{ task: 'Read the workspace file.', model: '5.6', reasoning_effort: 'pro' }] });
      expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
      const failed = stageWorkerConversationFinish('c-worker-1', 'CORE_UNAVAILABLE\nNo local Core operation ran.', {
        turnId: 'core-missing-turn', startedAt: 100, endedAt: 101,
        diagnostic: { kind: 'zero_core_ingress', boundary: 'ingress', detail: 'No Core request reached this account.' }
      });
      expect(await persistCriticalSwarmNow()).toBe(true);
      failed!.commit();
      const retry = pendingWorkerRevivals()[0]!;
      expect(retry).toMatchObject({ model: '5.6', reasoningEffort: 'xhigh' });
      expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
      expect(noteWorkerRevived('worker-1', 'c-worker-1', retry.messageIds)).toBe(true);
      const sleptAt = swarmState().agents.find(agent => agent.id === 'worker-1')!.sleptAt!;
      expect(noteAgentAlive('c-worker-1', 'turn', sleptAt + 1)?.revived).toBe(true);
      const completed = stageWorkerConversationFinish('c-worker-1', 'The Core read succeeded and the task is complete.');
      expect(await persistCriticalSwarmNow()).toBe(true);
      completed!.commit();
      expect(swarmState().agents.find(agent => agent.id === 'worker-1')).toMatchObject({
        state: 'sleeping', coreUnavailableRetries: 0, coreRecoveryModel: null,
        model: '5.6', reasoningEffort: 'pro'
      });
      const next = stageMessages(prime, [{ to: 'worker-1', text: 'Check the next file.' }]);
      next.commit();
      expect(pendingWorkerRevivals()[0]).toMatchObject({ model: '5.6', reasoningEffort: 'pro' });
    } finally {
      catalog.mockRestore();
    }
  });

  it.each(['high', 'xhigh'] as const)('keeps GPT-6 %s during a tool-free Core recovery even when 5.6 is available', async effort => {
    const catalog = vi.spyOn(chatModels, 'getChatModels').mockReturnValue({
      state: 'ready', requestedAt: null, observedAt: Date.now(),
      models: [
        { id: 'gpt-6-thinking', label: 'GPT-6', efforts: ['high', 'xhigh'] },
        { id: '5.6', label: 'GPT-5.6', efforts: ['xhigh'] }
      ]
    });
    try {
      spawn({ caller: prime, workers: [{ task: 'Read one file.', model: 'gpt-6-thinking', reasoning_effort: effort }] });
      expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
      const failed = stageWorkerConversationFinish('c-worker-1', 'CORE_UNAVAILABLE\nNo local Core operation ran.', {
        turnId: 'core-missing-turn', startedAt: 100, endedAt: 101,
        diagnostic: { kind: 'zero_core_ingress', boundary: 'ingress', detail: 'No Core request reached this account.' }
      });
      expect(await persistCriticalSwarmNow()).toBe(true);
      failed!.commit();
      expect(pendingWorkerRevivals()[0]).toMatchObject({ model: 'gpt-6-thinking', reasoningEffort: effort });
    } finally { catalog.mockRestore(); }
  });

  it('does not switch models for a diagnosed local Core or tunnel failure', async () => {
    const catalog = vi.spyOn(chatModels, 'getChatModels').mockReturnValue({
      state: 'ready', requestedAt: null, observedAt: Date.now(),
      models: [{ id: '5.6', label: 'GPT-5.6', efforts: ['pro', 'xhigh'] }]
    });
    try {
      spawn({ caller: prime, workers: [{ task: 'Read one file.', model: '5.6', reasoning_effort: 'pro' }] });
      expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
      const failed = stageWorkerConversationFinish('c-worker-1', 'CORE_UNAVAILABLE\nNo local Core operation ran.', {
        turnId: 'local-failure-turn', startedAt: 100, endedAt: 101,
        diagnostic: { kind: 'local_core_or_tunnel_failure', boundary: 'local', detail: 'The local route failed.' }
      });
      expect(await persistCriticalSwarmNow()).toBe(true);
      failed!.commit();
      expect(pendingWorkerRevivals()[0]).toMatchObject({ model: '5.6', reasoningEffort: 'pro' });
    } finally {
      catalog.mockRestore();
    }
  });

  it('rolls back a spawn whose durable acceptance barrier fails instead of resurrecting it from the debounce', async () => {
    const stateName = 'spawn-atomicity-failure';
    onSwarmPersist(() => writeDurableSoon(stateName, snapshotSwarm()));
    onSwarmPersistNow(async () => {
      throw new Error('injected spawn durability failure');
    });

    const failed = await asChat(PRIME_CHAT, 'spawn', { workers: [{ task: 'audit the parser' }] });
    expect(failed).toMatch(/durable acceptance barrier|durab|injected spawn durability failure/i);

    // A failed public operation must not keep an invisible run claim in memory. More
    // importantly, spawn() already fired the ordinary debounced persistence callback before
    // the immediate barrier ran; if that callback was allowed to see the staged topology, a
    // later restart would restore it and replay pendingWorkerSpawns(), opening a worker tab for
    // a spawn ChatGPT was explicitly told had failed.
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
    await flushDurable();
    expect(await readDurable(stateName)).toBeNull();
  });

  it('exposes no key field anywhere in the agents schema', async () => {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} });
    const tools = reply.result.tools as Array<{ name: string; inputSchema: any }>;
    // Not on agents, and — the part that used to be false — not on any other tool either.
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('agent_key');
    }
    const agentsSchema = tools.find((tool) => tool.name === 'agents')!.inputSchema;
    // Not a key by any spelling: the recovery action that needed one is gone entirely.
    for (const field of Object.keys(agentsSchema.properties)) {
      expect(field).not.toMatch(/key|secret|token/i);
    }
    expect(JSON.stringify(agentsSchema)).not.toMatch(/join/i);
  });

  it('returns empty status to an unrelated chat without exposing the other run', async () => {
    startSwarm(1);
    const text = await asChat('c-stranger', 'status');
    expect(text).toContain('No workers or retained worker history');
    const status = await structuredAsChat('c-stranger', 'status');
    expect(status).toMatchObject({ self: null, run_id: null, agents: [] });
    expect(text).not.toContain('worker-1');
    expect(text).not.toContain('task 1');
    expect(text).not.toContain(PRIME_CHAT);
  });

  it('shows a parked prime only its own history while another prime owns the active run', async () => {
    spawn({ workers: [{ label: 'A history worker', task: 'A private task' }], caller: prime });
    expect(bindConversation('worker-1', 'c-worker-a')).toBe(true);
    finishAgent({ conversationId: 'c-worker-a' }, 'A done for now');
    expect(releaseQuiescentRun()).toBe(true);

    spawn({
      workers: [{ label: 'B live worker', task: 'B private task' }],
      caller: { conversationId: 'c-prime-b' }
    });
    const structured = await structuredAsChat(PRIME_CHAT, 'status');
    expect(structured.self).toBe(PRIME_ID);
    expect(structured.run_id).toBeNull();
    // A owns history but cannot consume the one global execution claim while B is active.
    expect(structured.free_worker_slots).toBe(3);
    expect(structured.agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'worker-1', label: 'A history worker', state: 'sleeping' })])
    );
    expect(JSON.stringify(structured)).not.toContain('B live worker');
    expect(JSON.stringify(structured)).not.toContain('B private task');
  });

  it('recognizes an exact sleeping worker still calling while another prime also executes', async () => {
    await setEnabled(true, 3, true);
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first prime work done');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);

    // Another prime is now entitled to the one active execution claim and may reuse the same
    // friendly worker ids. The old exact worker conversation remains worker-owned history, not
    // an ordinary chat that can keep using local tools.
    spawn({ workers: [{ task: 'second prime work' }], caller: { conversationId: 'c-prime-b' } });

    const requestId = 'wfr_dormant_worker_exact';
    await recordChatObservations('c-worker-1', [
      { kind: 'turn_start', time: Date.now(), turnId: 't-dormant-exact' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: 't-dormant-exact',
        calls: [{ messageId: 'm-dormant-exact', tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    const reply = await ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] });
    const text = textOfReply(reply);
    await setEnabled(true);
    expect(text).not.toContain('WORKER_SLEEPING');
    expect(text).toMatch(REFUSED_ON_ROOTS);
    expect(identify({ conversationId: 'c-prime-b' }).id).toBe(PRIME_ID);
  });

  it('allows only ambiguous unattributed execution while preserving an exact retired-worker fence', async () => {
    startSwarm(1);
    startWorker('worker-1', 'c-retired-worker-policy');
    expect(clearAgent(PRIME_ID).cleared).toBe('run');

    const blocked = await callTool('read', { paths: ['/anything'] });
    expect(blocked).toContain('CALLER_IDENTITY_REQUIRED');

    await setEnabled(true, 3, true);
    const anonymous = await callTool('read', { paths: ['/anything'] });
    expect(anonymous).not.toContain('CALLER_IDENTITY_REQUIRED');
    expect(anonymous).toMatch(REFUSED_ON_ROOTS);

    const requestId = 'wfr_retired_worker_allow_unattributed';
    await recordChatObservations('c-retired-worker-policy', [
      { kind: 'turn_start', time: Date.now(), turnId: 't-retired-policy' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: 't-retired-policy',
        calls: [{ messageId: 'm-retired-policy', tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    const exact = textOfReply(await ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] }));
    await setEnabled(true);
    expect(exact).toContain('WORKER_RETIRED');
  });

  it('explains scheduled-run permission with dormant history and never adopts that history', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'parked history');
    expect(releaseQuiescentRun()).toBe(true);

    const blocked = await callTool('read', { paths: ['/anything'] });
    expect(blocked).toContain('CALLER_IDENTITY_REQUIRED');
    expect(blocked).toContain('Scheduled or headless runs');
    expect(blocked).toContain('"Allow unattributed calls"');
    expect(swarmRunning()).toBe(false);

    await setEnabled(true, 3, true);
    const allowed = await callTool('read', { paths: ['/anything'] });
    expect(allowed).not.toContain('CALLER_IDENTITY_REQUIRED');
    // The ordinary sandbox now decides the call; no approved root was granted by this setting.
    expect(allowed).toMatch(REFUSED_ON_ROOTS);
    expect(swarmRunning()).toBe(false);

    await setEnabled(true);
    expect(await callTool('read', { paths: ['/anything'] })).toContain('CALLER_IDENTITY_REQUIRED');
  });

  it('permits an unattributed workspace-dependent call to fail honestly instead of guessing a chat', async () => {
    await setEnabled(true, 3, true);
    startSwarm(1);
    const text = await callTool('read', { paths: ['relative.txt'] });
    await setEnabled(true);

    expect(text).not.toContain('CALLER_IDENTITY_REQUIRED');
    expect(text).toMatch(/relative.*no active folder/i);
    expect(text).toContain('(none approved)');
  });

  it.each([true, false])('unattributed shutdown reaches only the permitted command runtime (allowed=%s)', async allowed => {
    await setEnabled(true, 3, allowed);
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'Sleeping');
    expect(releaseQuiescentRun()).toBe(true);
    await endpoint.stop();
    let commandEnabled = true;
    endpoint = await startMcpServer(() => ({ roots: [{ name: 'probe', path: dir }],
      caps: { ...DEFAULT_CAPABILITIES, command: commandEnabled }, readOnly: false, sessionTools: false, agentTools: true }));
    const { unifiedExecManager } = await import('../src/main/codex/manager.js');
    const allocation = vi.spyOn(unifiedExecManager, 'allocateProcessId').mockReturnValue(77777);
    // Never invoke the OS shutdown: intercept the process boundary and inspect its arguments.
    const execution = vi.spyOn(unifiedExecManager, 'execCommand').mockResolvedValue({ chunkId: 'shutdown-test', wallTimeMs: 0,
      rawOutput: Buffer.from('shutdown intercepted'), truncationPolicy: { kind: 'tokens', tokens: 1000 },
      maxOutputTokens: 1000, processId: null, exitCode: 0, originalTokenCount: null, outputOmittedBytes: null });
    try {
      const args = { cmd: 'shutdown.exe /s /t 0', workdir: '/probe' };
      const reply = await callTool('exec_command', args);
      if (allowed) {
        expect(reply).toContain('shutdown intercepted');
        expect(execution).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir, hookCommand: args.cmd }));
        execution.mockClear();
        commandEnabled = false;
        await callTool('exec_command', args);
        expect(execution).not.toHaveBeenCalled();
      } else {
        expect(reply).toContain('CALLER_IDENTITY_REQUIRED');
        expect(execution).not.toHaveBeenCalled();
      }
    } finally { execution.mockRestore(); allocation.mockRestore(); await setEnabled(true); }
  });

  it('waits for late exact identity while dormant worker histories exist, then revives that worker', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'sleep before late evidence');
    expect(releaseQuiescentRun()).toBe(true);

    const requestId = 'wfr_dormant_worker_late';
    const pending = ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] });
    // Initial cheap correlation has already had a chance to miss. Deliver the exact page mate
    // while the kernel is in its dormant-worker evidence window.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await recordChatObservations('c-worker-1', [
      { kind: 'turn_start', time: Date.now(), turnId: 't-dormant-late' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: 't-dormant-late',
        calls: [{ messageId: 'm-dormant-late', tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    // The exact worker is still calling, so it never stopped: no other prime owns the slot,
    // and the call takes its family out of parking and the worker out of sleep. On 2026-09-01
    // six workers were refused WORKER_SLEEPING mid-turn here for being the last to "finish".
    const text = textOfReply(await pending);
    expect(text).not.toContain('WORKER_SLEEPING');
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
  });

  it('delivers and acknowledges a parked prime inbox by exact conversation without adopting another history', async () => {
    startSwarm(1);
    startWorker('worker-1');

    const finished = await asChat('c-worker-1', 'finish', { result: 'parked-prime-report' });
    expect(finished).toMatch(/reported and is now asleep/i);
    expect(finished).toContain('This acknowledgment does not confirm delivery to the prime');
    expect(finished).not.toContain('The prime agent has your result');
    expect(swarmRunning()).toBe(false);

    // The final worker report lives in A's dormant prime queue. There is no live agent:prime
    // identity to address here, so delivery must resolve from the exact prime conversation.
    const first = await asChat(PRIME_CHAT, 'status');
    expect(first).toContain('--- 1 message(s) for prime ---');
    expect(first).toContain('parked-prime-report');
    expect(swarmRunning()).toBe(false);

    // Make another prime active with the same friendly `prime`/`worker-1` ids before A proves
    // receipt. Friendly-id recording would now resolve `prime` to B, which is exactly the leak
    // this regression guards against.
    spawn({ workers: [{ task: 'B is the active owner now' }], caller: { conversationId: 'c-prime-b' } });
    await recordChatObservations('c-prime-b', [{ kind: 'turn_start', time: Date.now(), turnId: 'b-active-turn' }]);

    // This authenticated follow-up proves the preceding result arrived and retires that offer.
    // The historical worker/result can still appear in the status table, but the inbox row must
    // not be pushed a second time.
    const second = await asChat(PRIME_CHAT, 'status');
    expect(second).not.toContain('--- 1 message(s) for prime ---');
    expect(swarmRunning()).toBe(true);

    const aSession = await findSessionByConversation(PRIME_CHAT, { requireUnique: true });
    const bSession = await findSessionByConversation('c-prime-b', { requireUnique: true });
    expect(aSession).toBeTruthy();
    expect(bSession).toBeTruthy();
    const aDelivered = (await readRecentEvents(aSession!.id, 50, { kinds: ['agent_message'] })).filter(
      (event) => event.kind === 'agent_message' && event.delivery === 'delivered' && event.message.text.includes('parked-prime-report')
    );
    const bDelivered = (await readRecentEvents(bSession!.id, 50, { kinds: ['agent_message'] })).filter(
      (event) => event.kind === 'agent_message' && event.delivery === 'delivered' && event.message.text.includes('parked-prime-report')
    );
    expect(aDelivered).toHaveLength(1);
    expect(bDelivered).toHaveLength(0);
  });

  it('makes a pending context-ceiling authority change durable before status publishes it', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'sleep before the late context measurement');
    expect(releaseQuiescentRun()).toBe(true);

    // Simulate the exact authority edge measureSleepingWorkers can discover from the durable
    // worker session: the parked chat is now over 400k and therefore no longer revivable. Leave
    // that critical revision pending, then prove the read-only status path itself drains it.
    noteAgentContextTokens('c-worker-1', WORKER_CONTEXT_CEILING_TOKENS);
    let written: ReturnType<typeof snapshotSwarm> | undefined;
    onSwarmPersistNow(async (snapshot) => {
      written = snapshot;
    });

    const text = await asChat(PRIME_CHAT, 'status');
    expect(text).toMatch(/worker-1.*finished \(not reusable\)/s);
    expect(text).not.toContain('REUSE FIRST: worker-1');
    const persistedWorker = written?.dormantRuns
      ?.flatMap((history) => history.agents)
      .find((entry) => entry.info.id === 'worker-1' && entry.info.conversationId === 'c-worker-1');
    expect(persistedWorker?.info).toMatchObject({
      state: 'finished',
      revivable: false,
      contextTokens: WORKER_CONTEXT_CEILING_TOKENS
    });
  });

  it('refuses a control call it cannot place at all, and says where to look', async () => {
    startSwarm(1);
    // No page evidence: this call could have come from anywhere, so it is not treated as a
    // stranger and it is certainly not given a credential to carry instead.
    const text = await agents('status');
    expect(text).toContain('WORKER_IDENTITY_LOST');
    expect(text).toMatch(/No agent operation was performed/);
    expect(text).toContain('this ChatGPT conversation');
    expect(text).toContain('Chrome companion');
    expect(text).toContain('stored pairing');
    expect(text).not.toContain('worker-1');
  });

  it('uses the inbound HTTP request id instead of stealing a worker’s earlier agents evidence', async () => {
    startSwarm(1);
    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
    const now = Date.now();

    // The worker has an unclaimed agents request visible first. Before the HTTP-id hardening,
    // callerNow() saw this while the prime page was one poll late and authenticated the prime
    // call as worker-1, producing the live "An agent cannot message itself" failure.
    await recordChatObservations('c-worker-1', [
      { kind: 'turn_start', time: now, turnId: 'worker-stale' },
      {
        kind: 'tool_evidence',
        time: now,
        turnId: 'worker-stale',
        calls: [
          {
            messageId: 'worker-stale-agents',
            tool: 'agents',
            order: 0,
            answered: false,
            requestId: 'wfr_worker_stale',
            createTime: now / 1000
          }
        ]
      }
    ]);

    const pending = agentsWithRequestId('wfr_prime_current', 'message', {
      to: 'worker-1',
      text: 'prime correction'
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await recordChatObservations(PRIME_CHAT, [
      { kind: 'turn_start', time: now + 80, turnId: 'prime-current' },
      {
        kind: 'tool_evidence',
        time: now + 80,
        turnId: 'prime-current',
        calls: [
          {
            messageId: 'prime-current-agents',
            tool: 'agents',
            order: 0,
            answered: false,
            requestId: 'wfr_prime_current',
            createTime: (now + 80) / 1000
          }
        ]
      }
    ]);

    const text = await pending;
    expect(text).toContain('Queued for worker-1');
    expect(text).not.toContain('cannot message itself');
    expect(pendingCount('worker-1')).toBe(1);
  });

  it('publishes no message when its durable acceptance barrier fails, and a retry queues exactly one', async () => {
    startSwarm(1);
    const snapshots: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersist(() => snapshots.push(snapshotSwarm()));
    let fail = true;
    onSwarmPersistNow(async () => {
      if (fail) {
        fail = false;
        throw new Error('injected disk barrier failure');
      }
    });

    const failed = await asChat(PRIME_CHAT, 'message', { to: 'worker-1', text: 'check the parser' });
    expect(failed).toMatch(/durable (?:acceptance )?barrier|nothing was queued/i);
    // The staged queue entry was never visible to the worker while the write was in flight,
    // and rollback removed it before the failed call returned.
    expect(pendingCount('worker-1')).toBe(0);
    expect(offerMessages('worker-1')).toEqual([]);
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((entry) => entry.id === 'worker-1')).toMatchObject({ pending: 0 });
    const afterFailure = snapshotSwarm();
    expect(afterFailure).not.toBeNull();
    expect(afterFailure?.agents.find((entry) => entry.info.id === 'worker-1')?.queue ?? []).toEqual([]);
    // rollback is itself a critical mutation and therefore emits a newer safe snapshot. This
    // supersedes durable.ts's retained failed generation instead of letting it resurrect the
    // rejected message later.
    // The injected failure can now be consumed by the earlier context/revival measurement
    // barrier, before message staging exists at all. In that case no rollback snapshot is
    // necessary. If any debounced snapshots were published, none may contain the rejected row.
    expect(
      snapshots.every(
        (snapshot) => snapshot?.agents.find((entry) => entry.info.id === 'worker-1')?.queue.length !== 1
      )
    ).toBe(true);

    const retried = await asChat(PRIME_CHAT, 'message', { to: 'worker-1', text: 'check the parser' });
    expect(retried).toContain('Queued for worker-1');
    expect(pendingCount('worker-1')).toBe(1);
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['check the parser']);
  });

  it('publishes no worker finish or prime report when its durable acceptance barrier fails', async () => {
    startSwarm(1);
    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
    let fail = true;
    onSwarmPersistNow(async () => {
      if (fail) {
        fail = false;
        throw new Error('injected finish durability failure');
      }
    });

    const failed = await asChat('c-worker-1', 'finish', { result: 'finished the audit' });
    expect(failed).toMatch(/durable acceptance barrier|nothing was published|finish durability failure/i);
    // Old finish mutated the worker and queued its report before awaiting the disk barrier, so
    // the worker became terminal and a concurrent prime call could consume a result whose own
    // caller was being told to retry. A failed acceptance must leave no live trace instead.
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(offerMessages(PRIME_ID)).toEqual([]);

    const retried = await asChat('c-worker-1', 'finish', { result: 'finished the audit' });
    expect(retried).toMatch(/reported and is now asleep/i);
    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(1);
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
  });

  it('carries a worker through message and finish on its conversation alone', async () => {
    startSwarm(1);
    // The extension reports the chat it opened, exactly as it does in production. That is
    // the whole of the worker's startup: no join, no key, nothing typed by the model.
    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);

    const sent = await asChat('c-worker-1', 'message', { to: PRIME_ID, text: 'the parser is the problem' });
    expect(sent).toContain('Queued for prime');
    expect(pendingCount(PRIME_ID)).toBe(1);

    const finished = await asChat('c-worker-1', 'finish', { result: 'fixed the parser' });
    expect(finished).toMatch(/reported and is now asleep/i);
    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
  });

  it('does not tell the prime a worker missed a message that the finish call itself confirms', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    sendMessage(prime, 'worker-1', 'include the parser edge case in your final result');

    // This result offers the instruction. It stays pending until the worker's *next* exact
    // call, because that next call is the broker's evidence that this result reached ChatGPT.
    const offered = await asChat('c-worker-1', 'status');
    expect(offered).toContain('include the parser edge case');
    expect(pendingCount('worker-1')).toBe(1);

    // The next call happens to be finish. Kernel acknowledgement runs after the handler so the
    // old finish planner still saw the offered row as unacked and wrote a false warning into the
    // final report, even though this exact call immediately marks that same row delivered.
    await asChat('c-worker-1', 'finish', { result: 'parser edge case included' });
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.pending).toBe(0);
    const report = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
      message.text.includes('[worker-1 reported]')
    );
    expect(report?.text).toContain('parser edge case included');
    expect(report?.text).not.toContain('ended without ever confirming');
  });

  it('tells the prime how much worker capacity the report just freed, and that the worker is reusable', async () => {
    // A worker that reports is capacity coming back, and the prime is the only party that can
    // spend it. The final report used to end at the result, so "finished" read as an ending
    // and remaining work sat unspawned. The count is what makes it actionable: it has to be
    // the slots free *after* this worker stops, not the whole limit. And the slot is not the
    // only thing coming back — the worker itself is, in the chat it already has.
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    bindConversation('worker-2', 'c-worker-2');

    const workerResult = await asChat('c-worker-1', 'finish', { result: 'first half done' });
    expect(workerResult).toContain('remains reusable');
    expect(workerResult).toContain('wake this same chat with agents action=message before spawning a replacement');
    const report = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
      message.text.includes('[worker-1 reported]')
    );
    // worker-2 is still live against a limit of 3, so two slots are free — not three.
    expect(report?.text).toContain('2 of 3 worker slots are free');
    expect(report?.text).toContain('worker-1 sleeping');
    expect(report?.text).toContain('Reuse first: agents action=message to="worker-1"');
    expect(report?.text).toContain('Spawn only when no sleeping worker is suitable');
    expect(report?.text).not.toContain('cannot be reused');

    const status = await asChat(PRIME_CHAT, 'status');
    expect(status).toContain('worker-1  worker  sleeping (reusable; wake with action=message)');
    expect(status).toContain('REUSE FIRST: worker-1');
    expect(status).toContain('For related follow-up work, do this before action=spawn');

    // With the last worker asleep the whole limit is free, and the singular reads correctly.
    await asChat('c-worker-2', 'finish', { result: 'second half done' });
    const last = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
      message.text.includes('[worker-2 reported]')
    );
    expect(last?.text).toContain('3 of 3 worker slots are free');
  });

  it('tells the prime a worker is gone for good only once its own chat is full', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    fillContext('c-worker-1');

    const workerResult = await asChat('c-worker-1', 'finish', { result: 'all of it done' });
    expect(workerResult).toContain('reached its context limit');
    expect(workerResult).toContain('This acknowledgment does not confirm delivery to the prime');
    expect(workerResult).not.toContain('The prime agent has your result');
    expect(workerResult).not.toContain('remains reusable');
    const report = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
      message.text.includes('[worker-1 finished]')
    );
    expect(report?.text).toContain('context limit');
    expect(report?.text).toContain('Spawn a new worker');
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.revivable).toBe(false);
  });

  it('cannot be spoofed by naming an agent in the arguments', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    const spoofed = await asChat('c-outsider', 'message', { agent: 'worker-1', to: PRIME_ID, text: 'spoof' });
    // The live schema now rejects the retired `agent` field before broker identity runs. That
    // is stronger than the old AGENTS_BUSY path: caller-controlled identity is not even a
    // syntactically valid request anymore. Keep the broker invariant below as the real outcome.
    expect(spoofed).toMatch(/input validation|unrecognized key|AGENTS_BUSY|unknown/i);
    expect(pendingCount(PRIME_ID)).toBe(0);
  });

  it('pushes waiting messages onto a worker result and acknowledges them on the next call', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');

    sendMessage(prime, 'worker-1', 'stop and check the parser first');
    const withMessage = await asChat('c-worker-1', 'status');
    expect(withMessage).toContain('stop and check the parser first');

    // The next placed call is what retires it, so a lost result is re-offered.
    const after = await asChat('c-worker-1', 'status');
    expect(after).not.toContain('stop and check the parser first');
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('does not let an MCP call already in flight across a browser revival ACK consume or repeat the wake text', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    finishAgent({ conversationId: 'c-worker-1' }, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'wake text belongs to the browser user turn' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);

    // Re-open this test's MCP endpoint with one real command tool so the handler can remain in
    // flight while the browser ACK lands. The exact request-id evidence is recorded *before*
    // the request, which is also a real ordering supported by ChatGPT's connector renderer.
    await endpoint.stop();
    endpoint = await startMcpServer(() => ({
      roots: [{ name: 'probe', path: dir }],
      caps: { ...DEFAULT_CAPABILITIES, command: true },
      readOnly: false,
      sessionTools: false,
      agentTools: true
    }));
    const requestId = `wfr_exec_held_${++evidenceSeq}`;
    await recordChatObservations('c-worker-1', [
      { kind: 'turn_start', time: Date.now(), turnId: `t-held-${evidenceSeq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-held-${evidenceSeq}`,
        calls: [{ messageId: `m-held-${evidenceSeq}`, tool: 'exec_command', order: 0, answered: false, requestId }]
      }
    ]);

    const started = Date.now();
    const shell =
      process.platform === 'win32'
        ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : '/bin/sh';
    const heldCommand =
      process.platform === 'win32'
        ? "Start-Sleep -Milliseconds 750; Write-Output 'held-call-done'"
        : "sleep 1; printf '%s\\n' held-call-done";
    const pending = post(
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: {
          name: 'exec_command',
          arguments: {
            cmd: heldCommand,
            workdir: dir,
            shell,
            yield_time_ms: 30_000
          }
        }
      },
      { 'x-request-id': `${requestId}/relay` }
    );
    await waitForRunningToolCall();
    expect(runningToolCalls('c-worker-1')).toBeGreaterThan(0);

    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    const offeredAt = snapshotSwarm()!.agents.find((entry) => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;
    expect(offeredAt).toBeGreaterThanOrEqual(started);

    const reply = await pending;
    const text = ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
    expect(text).toContain('held-call-done');
    expect(text).not.toContain('wake text belongs to the browser user turn');
    // This call began before the browser offered the real user message, so completing later is
    // not evidence that it saw that message. The row remains pending but is non-reofferable.
    expect(pendingCount('worker-1')).toBe(1);
    expect(offerMessages('worker-1')).toEqual([]);

    // The next authenticated call really did begin after the user-message delivery and may
    // retire it. It still must not repeat those words through its own result.
    const later = await asChat('c-worker-1', 'status');
    expect(later).not.toContain('wake text belongs to the browser user turn');
    expect(pendingCount('worker-1')).toBe(0);
  }, 45_000);

  it('keeps a distinct worker instruction independent of Prime report ACK while an older response is in flight', async () => {
    const diskName = 'prime-report-worker-interleave';
    onSwarmPersist(() => writeDurableSoon(diskName, snapshotSwarm()));
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    const result = 'RESULT: exact finished worker report, not the next worker instruction.';
    expect(await asChat('c-worker-1', 'finish', { result })).toContain('result was recorded for the prime');
    const rows = () => snapshotSwarm()!.activeRuns!.flatMap(run => run.agents);
    const report = rows().find(row => row.info.id === PRIME_ID)!.queue[0]!;
    expect(rows().find(row => row.info.id === 'worker-1')!.info)
      .toMatchObject({ state: 'sleeping', result, stopReportId: report.id });
    const saved = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    expect(saved!.activeRuns!.flatMap(run => run.agents).find(row => row.info.id === PRIME_ID)!.queue)
      .toEqual([expect.objectContaining({ id: report.id, ackedAt: null })]);

    await endpoint.stop();
    endpoint = await startMcpServer(() => ({
      roots: [{ name: 'probe', path: dir }],
      caps: { ...DEFAULT_CAPABILITIES, command: true },
      readOnly: false, sessionTools: false, agentTools: true
    }));
    const seq = ++evidenceSeq;
    const requestId = `wfr_prime_held_${seq}`;
    const releaseFile = `${dir}/prime-report-interleave-${seq}.release`;
    await recordChatObservations(PRIME_CHAT, [
      { kind: 'turn_start', time: Date.now(), turnId: `t-prime-held-${seq}` },
      { kind: 'tool_evidence', time: Date.now(), turnId: `t-prime-held-${seq}`,
        calls: [{ messageId: `m-prime-held-${seq}`, tool: 'exec_command', order: 0, answered: false, requestId }] }
    ]);
    const shell = process.platform === 'win32'
      ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : '/bin/sh';
    const heldCommand = process.platform === 'win32'
      ? `$cosReportDeadline = [DateTime]::UtcNow.AddSeconds(10); while (-not (Test-Path -LiteralPath '${releaseFile.replace(/'/g, "''")}')) { if ([DateTime]::UtcNow -gt $cosReportDeadline) { exit 1 }; Start-Sleep -Milliseconds 20 }; Write-Output 'prime-held-response-done'`
      : `cos_report_ticks=0; while ! test -f '${releaseFile.replace(/'/g, "'\\''")}'; do cos_report_ticks=$((cos_report_ticks + 1)); if test "$cos_report_ticks" -ge 500; then exit 1; fi; sleep 0.02; done; printf '%s\\n' prime-held-response-done`;
    let pending: ReturnType<typeof post> | undefined;
    try {
      pending = ordinaryWithRequestId(requestId, 'exec_command', {
        cmd: heldCommand, workdir: dir, shell, yield_time_ms: 30_000
      });
      await waitForRunningToolCall();
      expect(runningToolCalls(PRIME_CHAT)).toBeGreaterThan(0);

      // This separate exact Prime result offers R while the older Prime response is held.
      expect(await asChat(PRIME_CHAT, 'status')).toContain(report.text);
      expect(rows().find(row => row.info.id === PRIME_ID)!.queue)
        .toEqual([expect.objectContaining({ id: report.id, offeredConversationId: PRIME_CHAT, ackedAt: null })]);
      const instruction = 'M: inspect a distinct follow-up, never confuse this with report R.';
      // The next authenticated Prime call accepts M through the real message handler and
      // acknowledges only R. A message to this sleeping worker is a new waking assignment.
      expect(await asChat(PRIME_CHAT, 'message', { to: 'worker-1', text: instruction }))
        .toContain('Queued for worker-1');
      const queued = rows().find(row => row.info.id === 'worker-1')!.queue;
      expect(queued).toHaveLength(1);
      const message = queued[0]!;
      expect(message.id).not.toBe(report.id);
      expect(message).toMatchObject({ text: instruction, ackedAt: null, offeredAt: null });
      expect(rows().find(row => row.info.id === PRIME_ID)!.queue.some(row => row.id === report.id && row.ackedAt === null))
        .toBe(false);
      expect(rows().find(row => row.info.id === 'worker-1')!.info)
        .toMatchObject({ state: 'waking', result: null, stopReportId: null });
      expect(closableWorkerConversations(0)).not.toContain('c-worker-1');

      const revival = pendingWorkerRevivals().find(row => row.id === 'worker-1')!;
      expect(revival.messageIds).toEqual([message.id]);
      expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
      expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
      await fs.writeFile(releaseFile, 'release only the older test response');
      const older = textOfReply(await pending);
      expect(older).toContain('prime-held-response-done');
      expect(older).not.toContain(report.text);
      expect(older).not.toContain(instruction);
      expect(rows().find(row => row.info.id === 'worker-1')!.queue)
        .toEqual([expect.objectContaining({ id: message.id, offeredViaRevival: true, ackedAt: null })]);
      expect(pendingCount('worker-1')).toBe(1);
      expect(offerMessages('worker-1')).toEqual([]);
      // Delivery is not liveness: the existing waking placeholder may remain, but M
      // must be excluded from every further browser plan as well as the MCP inbox.
      expect(pendingWorkerRevivals()).toEqual([
        expect.objectContaining({ id: 'worker-1', messageIds: [], text: expect.not.stringContaining(instruction) })
      ]);
      expect(closableWorkerConversations(0)).not.toContain('c-worker-1');

      // Only the worker's own later authenticated call can retire its browser-delivered M.
      expect(await asChat('c-worker-1', 'status')).not.toContain(instruction);
      expect(pendingCount('worker-1')).toBe(0);
      expect(await persistCriticalSwarmNow()).toBe(true);
      const primeSession = await findSessionByConversation(PRIME_CHAT, { requireUnique: true });
      const workerSession = await findSessionByConversation('c-worker-1', { requireUnique: true });
      const deliveredTo = async (sessionId: string) => (await readRecentEvents(sessionId, 100, { kinds: ['agent_message'] }))
        .filter(event => event.kind === 'agent_message' && event.delivery === 'delivered' &&
          (event.messageId === report.id || event.messageId === message.id))
        .map(event => event.kind === 'agent_message' ? event.messageId : '');
      expect(await deliveredTo(primeSession!.id)).toEqual([report.id]);
      expect(await deliveredTo(workerSession!.id)).toEqual([message.id]);
      await flushDurable();
      const finalSaved = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
      expect(finalSaved!.activeRuns!.flatMap(run => run.agents).find(row => row.info.id === 'worker-1')!.queue)
        .toEqual([]);
    } finally {
      await fs.writeFile(releaseFile, 'release the test response on assertion failure too');
      await pending?.catch(() => undefined);
    }
  }, 45_000);

  it('refuses whitespace-only explicit finish before marking or reporting a worker', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    const before = snapshotSwarm()!;
    const blank = await asChat('c-worker-1', 'finish', { result: ' \t\n  ' });
    expect(blank).toMatch(/finish requires non-blank result/i);
    const after = snapshotSwarm()!;
    expect(after.agents.find(agent => agent.info.id === 'worker-1')?.info.state).toBe('active');
    expect(after.agents.find(agent => agent.info.id === 'worker-1')?.info.stopReportId).toBeNull();
    expect(after.agents.find(agent => agent.info.id === 'worker-1')?.info.coreUnavailableRetries).toBe(
      before.agents.find(agent => agent.info.id === 'worker-1')?.info.coreUnavailableRetries
    );
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(closableWorkerConversations(0)).not.toContain('c-worker-1');
    const valid = 'RESULT / CHANGES / VALIDATION / BLOCKERS\n  artifact: result.txt  \n';
    const done = await asChat('c-worker-1', 'finish', { result: valid });
    expect(done).toMatch(/result was recorded for the prime/i);
    const report = offerMessagesForConversation(PRIME_CHAT)?.messages.find(message =>
      message.text.includes('[worker-1 reported]')
    );
    expect(report?.text).toContain(valid);
  });

  it('refuses an invisible-format-only explicit finish without publishing custody or closing its tab', async () => {
    startSwarm(2); // Retain a sibling slot so a bad finish cannot park Prime out of the active projection.
    bindConversation('worker-1', 'c-worker-1');
    // trim() does not remove zero-width format controls, even when no readable
    // worker result exists. This is not the separate native artifact-only path.
    const invisible = '\u200b\u2060\u200d';
    const response = await asChat('c-worker-1', 'finish', { result: invisible });
    const after = snapshotSwarm()!;
    const worker = after.agents.find(agent => agent.info.id === 'worker-1')!;
    const primeQueue = after.agents.find(agent => agent.info.id === PRIME_ID)!.queue;
    // Soft assertions preserve ALL failure facts for this one admission boundary;
    // a misleading formatted Prime report must not obscure the empty source body.
    expect.soft(response).toMatch(/finish requires non-blank result/i);
    expect.soft(worker.info).toMatchObject({ state: 'active', result: null, stopReportId: null });
    expect.soft(primeQueue).toEqual([]);
    expect.soft(pendingCount(PRIME_ID)).toBe(0);
    expect.soft(closableWorkerConversations(0)).not.toContain('c-worker-1');
    if (worker.info.state === 'active') {
      const meaningful = 'RESULT: actual source review completed; no changes required.';
      expect(await asChat('c-worker-1', 'finish', { result: meaningful }))
        .toContain('result was recorded for the prime');
      expect(offerMessagesForConversation(PRIME_CHAT)?.messages.some(message => message.text.includes(meaningful))).toBe(true);
    }
  });

  it('retains exact meaningful report bytes with embedded format characters across Prime offer and later ACK', async () => {
    const diskName = 'worker-report-unicode';
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    const original = 'RESULT:\n  file: report\u200b.md  \n  VALIDATION: passed\u2060\n';
    expect(await asChat('c-worker-1', 'finish', { result: original }))
      .toContain('result was recorded for the prime');
    const saved = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    const rows = saved!.activeRuns!.flatMap(run => run.agents);
    const worker = rows.find(row => row.info.id === 'worker-1')!;
    const offeredReport = rows.find(row => row.info.id === PRIME_ID)!.queue[0]!;
    expect(worker.info.result).toBe(original);
    expect(worker.info.stopReportId).toBe(offeredReport.id);
    expect(offeredReport.text).toContain(original);
    expect(offeredReport.ackedAt).toBeNull();
    expect(closableWorkerConversations(0)).toContain('c-worker-1'); // Critically stored; ACK not needed yet.
    expect(await asChat(PRIME_CHAT, 'status')).toContain(original);
    expect(swarmStateForCaller(prime).agents.find(agent => agent.id === 'worker-1')?.stopReportAcknowledgedAt)
      .toBeNull();
    // The status projection may still display the worker's latest retained result.
    // Only the exact inbox row/ACK state, not visible text absence, proves collection.
    expect(await asChat(PRIME_CHAT, 'status')).toContain('You are prime.');
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(swarmStateForCaller(prime).agents.find(agent => agent.id === 'worker-1')?.stopReportAcknowledgedAt)
      .toEqual(expect.any(Number));
    expect(await persistCriticalSwarmNow()).toBe(true);
    const acked = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    expect(acked!.activeRuns!.flatMap(run => run.agents).find(row => row.info.id === 'worker-1')?.info.result).toBe(original);
  });

  it('does not stage a native broker result consisting only of invisible formatting before real text hydrates', async () => {
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    // This is a broker-native contract test, not proof of the extension's DOM/final selector.
    expect(stageWorkerConversationFinish('c-worker-1', ' \u200b\u2060\u200d\n')).toBeNull();
    expect(snapshotSwarm()!.agents.find(agent => agent.info.id === 'worker-1')?.info)
      .toMatchObject({ state: 'active', result: null, stopReportId: null });
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(closableWorkerConversations(0)).not.toContain('c-worker-1');
    const nativeText = 'RESULT:\n  Actual provider final after hydration\u200b  \n';
    const stage = stageWorkerConversationFinish('c-worker-1', nativeText);
    expect(stage?.report?.text).toContain(nativeText);
    expect(await persistCriticalSwarmNow()).toBe(true);
    stage!.commit();
    expect(snapshotSwarm()!.agents.find(agent => agent.info.id === 'worker-1')?.info)
      .toMatchObject({ state: 'sleeping', result: nativeText, stopReportId: stage!.report!.id });
  });

  it('reoffers exact native hydration after Prime restart/rebind and ACKs only on the next authenticated call', async () => {
    const diskName = 'native-hydration-prime-rebind';
    onSwarmPersist(() => writeDurableSoon(diskName, snapshotSwarm()));
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    const before = swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')!;
    expect(stageWorkerConversationFinish('c-worker-1', ' \u200b\u2060\u200d\n')).toBeNull();
    expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1'))
      .toMatchObject({ state: 'active', result: null, stopReportId: null });
    expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')?.coreUnavailableRetries)
      .toBe(before.coreUnavailableRetries);
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(closableWorkerConversations(0)).not.toContain('c-worker-1');

    // The browser-owned admission entry point now receives a substantive final. Only
    // its exact original bytes may enter the real durable stop report.
    const actual = 'RESULT:\n  Native final after hydration\u200b  \n  VALIDATION: passed\u2060\n';
    const stage = stageWorkerConversationFinish('c-worker-1', actual);
    expect(stage?.repeat).toBe(false);
    expect(stage?.report?.text).toContain(actual);
    expect(await persistCriticalSwarmNow()).toBe(true);
    const savedBeforeCommit = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    const savedRows = savedBeforeCommit!.activeRuns!.flatMap(run => run.agents);
    const savedWorker = savedRows.find(row => row.info.id === 'worker-1')!;
    const report = savedRows.find(row => row.info.id === PRIME_ID)!.queue[0]!;
    expect(savedWorker.info).toMatchObject({ state: 'sleeping', result: actual, stopReportId: report.id });
    expect(report).toMatchObject({ id: stage!.report!.id, ackedAt: null });
    expect(report.text).toContain(actual);
    stage!.commit();
    expect(closableWorkerConversations(0)).toContain('c-worker-1'); // Disk custody, not ACK.
    expect(closableWorkerConversations(0)).not.toContain('c-worker-2');

    // The first authenticated Prime Core result is an OFFER, not delivery proof.
    const firstOffer = await asChat(PRIME_CHAT, 'status');
    expect(firstOffer).toContain('--- 1 message(s) for prime ---');
    expect(firstOffer).toContain(report.text);
    expect(swarmStateForCaller(prime).agents.find(row => row.id === 'worker-1')?.stopReportAcknowledgedAt)
      .toBeNull();
    await flushDurable();
    const offeredDisk = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    expect(offeredDisk!.activeRuns!.flatMap(run => run.agents).find(row => row.info.id === PRIME_ID)?.queue)
      .toEqual([expect.objectContaining({ id: report.id, offeredConversationId: PRIME_CHAT, ackedAt: null })]);

    // Lose that returned offer, restart the existing broker and rebind Prime. The old
    // conversation cannot ACK it; the new exact Prime must see it again first.
    resetAgentsForTests();
    restoreSwarm(offeredDisk!);
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    const rebound = 'c-prime-after-native-hydration';
    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, rebound)).toBe(true);
    expect(offerMessagesForConversation(PRIME_CHAT)).toBeNull();
    const replayed = await asChat(rebound, 'status');
    expect(replayed).toContain(report.text);
    expect(swarmStateForCaller({ conversationId: rebound }).agents.find(row => row.id === 'worker-1'))
      .toMatchObject({ state: 'sleeping', result: actual, stopReportId: report.id,
        stopReportAcknowledgedAt: null });

    // A subsequent nonnested authenticated call, never the reoffer itself, ACKs R.
    await asChat(rebound, 'status');
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(await persistCriticalSwarmNow()).toBe(true);
    const acked = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    const rows = acked!.activeRuns!.flatMap(run => run.agents);
    expect(rows.find(row => row.info.id === 'worker-1')?.info).toMatchObject({
      state: 'sleeping', result: actual, stopReportId: report.id,
      stopReportAcknowledgedAt: expect.any(Number)
    });
    expect(rows.find(row => row.info.id === PRIME_ID)?.queue).toEqual([]);
    expect(offerMessagesForConversation(rebound)?.messages).toEqual([]);
    expect(stageWorkerConversationFinish('c-worker-1', 'Obsolete duplicate native final')).toBeNull();
    expect(closableWorkerConversations(0)).toContain('c-worker-1');
    expect(closableWorkerConversations(0)).not.toContain('c-worker-2');
  });

  it('never grants a close for a critically stored legacy invisible-only result even after Prime ACK', async () => {
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    // Simulate a result admitted by the prior version through this old internal
    // writer; the authenticated MCP endpoint now refuses this kind of finish.
    const historical = finishAgent({ conversationId: 'c-worker-1' }, '\u200b\u2060\u200d');
    expect(historical.report?.id).toBeTruthy();
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(closableWorkerConversations(0)).not.toContain('c-worker-1');
    expect(offerMessages(PRIME_ID).map(message => message.id)).toContain(historical.report!.id);
    expect(acknowledgeOffers(PRIME_ID, false, Date.now() + 1).map(message => message.id))
      .toContain(historical.report!.id);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(swarmStateForCaller(prime).agents.find(agent => agent.id === 'worker-1')?.stopReportAcknowledgedAt)
      .toEqual(expect.any(Number));
    expect(closableWorkerConversations(0)).not.toContain('c-worker-1');
    const saved = JSON.parse(JSON.stringify(snapshotSwarm()));
    resetAgentsForTests();
    restoreSwarm(saved);
    expect(closableWorkerConversations(0)).not.toContain('c-worker-1');
  });

  it('does not give an outsider authority through an empty finish, or spend durable worker recovery', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    const snapshot = snapshotSwarm()!;
    const outsider = await asChat('c-unrelated-finish', 'finish', { result: '\u00a0\u2003\n' });
    expect(outsider).toMatch(/AGENTS_BUSY|no sub-agent|identity|not a worker|not belong/i);
    const refused = await asChat('c-worker-1', 'finish', { result: '\u00a0\u2003\n' });
    expect(refused).toMatch(/finish requires non-blank result/i);
    const current = snapshotSwarm()!;
    const owner = (row: typeof current) => row.agents.find(agent => agent.info.id === 'worker-1')!;
    expect(owner(current).info).toMatchObject({
      state: 'active',
      result: owner(snapshot).info.result,
      stopReportId: null
    });
    expect(owner(current).info.coreUnavailableRetries).toBe(owner(snapshot).info.coreUnavailableRetries);
    expect(current.agents.find(agent => agent.info.id === PRIME_ID)?.queue).toEqual([]);
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(closableWorkerConversations(0)).toEqual([]);
  });

  it('preserves one exact authenticated finish report across disk, lost offer, restart and Prime rebind before ACK', async () => {
    const diskName = 'exact-worker-result-after-rebind';
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    const text = 'RESULT\n  CHANGES: source-only  \n  VALIDATION: 7 PASS\n  BLOCKERS: artifact-only output held\n';
    const first = await asChat('c-worker-1', 'finish', { result: text });
    expect(first).toContain('result was recorded for the prime');
    expect(first).toContain('does not confirm delivery to the prime');
    const persisted = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    expect(persisted).not.toBeNull();
    const rows = persisted?.activeRuns?.flatMap(run => run.agents) ?? [];
    const worker = rows.find(row => row.info.id === 'worker-1')!;
    const primeRow = rows.find(row => row.info.id === PRIME_ID)!;
    expect(worker.info.result).toBe(text);
    expect(worker.info.state).toBe('sleeping');
    expect(primeRow.queue).toHaveLength(1);
    const exactReport = primeRow.queue[0]!;
    expect(worker.info.stopReportId).toBe(exactReport.id);
    expect(exactReport.text).toContain(text);
    expect(exactReport.ackedAt).toBeNull();
    // Durability, not browser presentation, makes a stopped tab eligible.
    expect(closableWorkerConversations(0)).toContain('c-worker-1');
    // The first inbox offer can disappear with a lost tool result; it is not an ACK.
    const offered = await asChat(PRIME_CHAT, 'status');
    expect(offered).toContain(text);
    expect(swarmStateForCaller(prime).agents.find(agent => agent.id === 'worker-1')?.stopReportAcknowledgedAt).toBeNull();

    resetAgentsForTests();
    restoreSwarm(persisted!);
    // Process restart rewires the existing broker persistence sink before
    // published results can authorize a physical stopped-tab close.
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    const rebound = 'c-prime-after-rebind';
    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, rebound)).toBe(true);
    expect(offerMessagesForConversation(PRIME_CHAT)).toBeNull();
    expect(closableWorkerConversations(0)).toContain('c-worker-1');
    const replayed = await asChat(rebound, 'status');
    expect(replayed).toContain(exactReport.text);
    expect(swarmStateForCaller({ conversationId: rebound }).agents.find(agent => agent.id === 'worker-1')?.stopReportId)
      .toBe(exactReport.id);
    const acknowledged = await asChat(rebound, 'status');
    expect(acknowledged).not.toContain(exactReport.text);
    const recovered = swarmStateForCaller({ conversationId: rebound });
    expect(recovered.agents.find(agent => agent.id === 'worker-1')?.stopReportAcknowledgedAt).toEqual(expect.any(Number));
    expect(recovered.agents.find(agent => agent.id === PRIME_ID)?.pending).toBe(0);
    expect(await persistCriticalSwarmNow()).toBe(true);
    const ackedDisk = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    const ackedRows = ackedDisk?.activeRuns?.flatMap(run => run.agents) ?? [];
    expect(ackedRows.find(row => row.info.id === 'worker-1')?.info).toMatchObject({
      stopReportId: exactReport.id,
      stopReportAcknowledgedAt: expect.any(Number)
    });
    expect(ackedRows.find(row => row.info.id === PRIME_ID)?.queue.some(row =>
      row.id === exactReport.id && row.ackedAt === null
    )).toBe(false);
    resetAgentsForTests();
    restoreSwarm(ackedDisk!);
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    expect(offerMessagesForConversation(rebound)?.messages).toEqual([]);
    expect(closableWorkerConversations(0)).toContain('c-worker-1');
    // A sibling worker still holds its own slot and must never be swept with the stopped one.
    expect(closableWorkerConversations(0)).not.toContain('c-worker-2');
  });

  it('refuses an authenticated prior-turn finish after that same worker has begun a newer assignment', async () => {
    const diskName = 'stale-finish-new-assignment';
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    // The recorder's native request-id/turn join names A, not merely this worker chat.
    const oldTurn = `t-${evidenceSeq + 1}`;
    expect(await asChat('c-worker-1', 'finish', { result: 'RESULT: old assignment A is complete.' }))
      .toContain('result was recorded for the prime');
    const afterA = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents);
    const reportA = afterA.find(row => row.info.id === PRIME_ID)!.queue[0]!.id;

    // The existing public message path durably reserves B, and its browser-owned
    // offer plus later authenticated B turn prove the newer assignment is active.
    const wake = stageMessages(prime, [{ to: 'worker-1', text: 'NEW assignment B: inspect the current parser' }]);
    wake.commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds, 'command-for-B')).toBe(true);
    expect(noteAgentAlive('c-worker-1', 'turn', Date.now() + 1)?.revived).toBe(true);
    expect(await asChat('c-worker-1', 'status')).toContain('worker-1');
    const activeB = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents);
    expect(activeB.find(row => row.info.id === 'worker-1')?.info).toMatchObject({
      state: 'active', result: null, stopReportId: null
    });
    const beforePrimeIds = activeB.find(row => row.info.id === PRIME_ID)!.queue.map(row => row.id);

    // A late MCP request authenticated to THIS worker conversation, but proved by
    // recorder tool evidence from the earlier turn A, must not finish assignment B.
    const requestId = 'wfr_agents_delayed_finish_from_A';
    const pending = replyWithRequestId(requestId, 'finish', { result: 'STALE A: delayed retry, not B output.' });
    await recordChatObservations('c-worker-1', [{
      kind: 'tool_evidence', time: Date.now(), turnId: oldTurn,
      calls: [{ messageId: 'm-delayed-A', tool: 'agents', order: 1, answered: false, requestId }]
    }]);
    const stale = textOfReply(await pending);
    expect.soft(stale).toMatch(/stale|earlier turn|prior assignment|cannot finish/i);
    const after = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents);
    expect.soft(after.find(row => row.info.id === 'worker-1')?.info).toMatchObject({
      state: 'active', result: null, stopReportId: null
    });
    expect.soft(after.find(row => row.info.id === PRIME_ID)?.queue.map(row => row.id)).toEqual(beforePrimeIds);
    expect(after.find(row => row.info.id === PRIME_ID)?.queue.map(row => row.id)).toContain(reportA);
    expect.soft((await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName))?.activeRuns
      ?.flatMap(run => run.agents).find(row => row.info.id === 'worker-1')?.info.state).toBe('active');
    expect.soft(closableWorkerConversations(0)).not.toContain('c-worker-1');
  });

  it('still accepts a real new-turn finish after the same worker is revived for a second assignment', async () => {
    const diskName = 'fresh-finish-after-new-assignment';
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    const answerA = 'RESULT: assignment A finished.';
    const answerB = 'RESULT: independently completed assignment B.';
    expect(await asChat('c-worker-1', 'finish', { result: answerA }))
      .toContain('result was recorded for the prime');
    const reportA = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents)
      .find(row => row.info.id === 'worker-1')!.info.stopReportId;

    const wake = stageMessages(prime, [{ to: 'worker-1', text: 'A fresh assignment B' }]);
    wake.commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds, 'new-assignment-B')).toBe(true);
    expect(noteAgentAlive('c-worker-1', 'turn', Date.now() + 1)?.revived).toBe(true);

    // asChat observes a NEW recorder turn and a matching authenticated MCP request.
    expect(await asChat('c-worker-1', 'finish', { result: answerB }))
      .toContain('result was recorded for the prime');
    const after = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents);
    const current = after.find(row => row.info.id === 'worker-1')!;
    const reports = after.find(row => row.info.id === PRIME_ID)!.queue;
    expect(current.info).toMatchObject({ state: 'sleeping', result: answerB });
    expect(current.info.stopReportId).not.toBe(reportA);
    expect(reports).toHaveLength(2);
    expect(reports.map(row => row.id)).toContain(reportA);
    expect(reports.find(row => row.id === current.info.stopReportId)?.text).toContain(answerB);
    const disk = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    const rows = disk!.activeRuns!.flatMap(run => run.agents);
    expect(rows.find(row => row.info.id === 'worker-1')?.info).toMatchObject({
      state: 'sleeping', result: answerB, stopReportId: current.info.stopReportId
    });
    expect(closableWorkerConversations(0)).toContain('c-worker-1');
  });

  it('does not reactivate a sleeping worker or erase stop custody on a same-family lost finish ACK', async () => {
    const diskName = 'worker-finish-retry-held-report';
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    const text = 'RESULT: verified changes; exact report to Prime.';
    expect(await asChat('c-worker-1', 'finish', { result: text }))
      .toContain('result was recorded for the prime');
    const before = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents);
    const report = before.find(row => row.info.id === PRIME_ID)!.queue[0]!;
    expect(before.find(row => row.info.id === 'worker-1')?.info).toMatchObject({
      state: 'sleeping', result: text, stopReportId: report.id
    });
    expect(closableWorkerConversations(0)).toContain('c-worker-1');

    // A lost result causes the SAME authenticated chat to retry while its
    // sibling is still active: no new user task, wake assignment or turn proof.
    const retry = await asChat('c-worker-1', 'finish', { result: '\n\t  ' });
    const after = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents);
    expect(after.find(row => row.info.id === 'worker-1')?.info).toMatchObject({
      state: 'sleeping', result: text, stopReportId: report.id
    });
    expect(retry).toMatch(/already (?:finished|sleeping)|already.*done/i);
    expect(after.find(row => row.info.id === PRIME_ID)?.queue.map(row => row.id)).toEqual([report.id]);
    expect(closableWorkerConversations(0)).toContain('c-worker-1');
    expect((await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName))?.activeRuns
      ?.flatMap(run => run.agents).find(row => row.info.id === PRIME_ID)?.queue[0]?.text).toBe(report.text);
  });

  it('does not publish a second Prime report when a sleeping worker retries a valid finished result', async () => {
    const diskName = 'worker-valid-finish-retry-single-report';
    onSwarmPersistNow(async snapshot => { await writeDurableNow(diskName, snapshot); });
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    const text = 'RESULT: finished source work; validation passed.\n';
    expect(await asChat('c-worker-1', 'finish', { result: text }))
      .toContain('result was recorded for the prime');
    const before = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents);
    const original = before.find(row => row.info.id === PRIME_ID)!.queue[0]!;
    expect(before.find(row => row.info.id === 'worker-1')?.info).toMatchObject({
      state: 'sleeping', result: text, stopReportId: original.id
    });
    // The exact same authenticated worker retries a valid result after losing
    // the first HTTP response. Another active sibling excludes parked-run revival.
    const retry = await asChat('c-worker-1', 'finish', { result: text });
    const after = snapshotSwarm()!.activeRuns!.flatMap(run => run.agents);
    const persisted = await readDurable<NonNullable<ReturnType<typeof snapshotSwarm>>>(diskName);
    expect(persisted?.activeRuns?.flatMap(run => run.agents)
      .find(row => row.info.id === PRIME_ID)?.queue.map(row => row.id)).toEqual([original.id]);
    expect(after.find(row => row.info.id === PRIME_ID)!.queue.map(row => row.id)).toEqual([original.id]);
    expect(after.find(row => row.info.id === 'worker-1')?.info).toMatchObject({
      state: 'sleeping', result: text, stopReportId: original.id
    });
    expect(retry).toMatch(/already (?:finished|sleeping)|already.*done/i);
    expect(closableWorkerConversations(0)).toContain('c-worker-1');
  });

  it('keeps a terminal worker tombstone only for finish retry and re-offers the lost finish inbox', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    sendMessage(prime, 'worker-1', 'check the parser before you stop');
    // A tombstone is only ever a worker that ended for good; anything else sleeps and is
    // welcome back on its own next call.
    fillContext('c-worker-1');

    // The message is first offered on the finish result. If that result is lost, another
    // finish call is not evidence that the worker saw it and must not ACK it.
    const first = await asChat('c-worker-1', 'finish', { result: 'done' });
    expect(first).toContain('check the parser before you stop');
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.pending).toBe(1);

    const retry = await asChat('c-worker-1', 'finish', { result: 'done, retry after lost result' });
    expect(retry).toMatch(/already finished|already.*done/i);
    expect(retry).toContain('check the parser before you stop');
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.pending).toBe(1);

    // The tombstone is not general membership. The same terminal chat still cannot use the
    // ordinary agents surface after it has finished.
    const status = await asChat('c-worker-1', 'status');
    expect(status).toMatch(/WORKER_ENDED|AGENTS_BUSY/);
  });

  it('enforces worker-to-worker refusal over the wire', async () => {
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    bindConversation('worker-2', 'c-worker-2');
    // This regression is about the worker-to-worker policy, not the separate late page-evidence
    // window exercised by asChat(). Give the request its exact browser mate before HTTP so a slow
    // hosted runner cannot turn an unrelated correlation race into WORKER_IDENTITY_LOST.
    const seq = ++evidenceSeq;
    const requestId = `wfr_agents_worker_policy_${seq}`;
    await recordChatObservations('c-worker-1', [
      { kind: 'turn_start', time: Date.now(), turnId: `t-${seq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-${seq}`,
        calls: [{ messageId: `m-${seq}`, tool: 'agents', order: 0, answered: false, requestId }]
      }
    ]);
    const refused = await agentsWithRequestId(requestId, 'message', { to: 'worker-2', text: 'psst' });
    expect(refused).toMatch(/prime/i);
    expect(pendingCount('worker-2')).toBe(0);
  });

  it('messages several workers in one call, on one identity resolution', async () => {
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    bindConversation('worker-2', 'c-worker-2');

    const text = await asChat(PRIME_CHAT, 'message', {
      messages: [
        { to: 'worker-1', text: 'ignore the UI' },
        { to: 'worker-2', text: 'check the README too' }
      ]
    });

    expect(text).toContain('worker-1');
    expect(text).toContain('worker-2');
    expect(pendingCount('worker-1')).toBe(1);
    expect(pendingCount('worker-2')).toBe(1);
  });

  it('refuses a message call that spells the same operation both ways at once', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');

    const text = await asChat(PRIME_CHAT, 'message', {
      to: 'worker-1',
      text: 'one way',
      messages: [{ to: 'worker-1', text: 'the other way' }]
    });

    expect(text).toMatch(/either to\+text or messages/i);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('carries the run and every agent in machine-readable form beside the prose', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');

    const structured = await structuredAsChat(PRIME_CHAT, 'status');
    expect(structured.action).toBe('status');
    expect(structured.self).toBe(PRIME_ID);
    expect(structured.run_id).toBeTypeOf('string');
    const worker = (structured.agents as Array<Record<string, unknown>>).find((agent) => agent.id === 'worker-1');
    expect(worker).toMatchObject({ id: 'worker-1', role: 'worker', state: 'active' });
  });
});

describe('simultaneous independent prime families', () => {
  const primeB: Caller = { conversationId: 'parallel-prime-b' };
  const recruit = (caller: Caller, count = 2) => spawn({ caller,
    workers: Array.from({ length: count }, (_, i) => ({ task: `parallel task ${i}` })) });

  it('admits two workers for each of two primes and refuses only the full owner', async () => {
    await setEnabled(true, 2);
    try {
      const a = recruit(prime);
      const b = recruit(primeB);
      expect(a.runId).not.toBe(b.runId);
      expect(swarmState().agents.filter(row => row.role === 'worker')).toHaveLength(4);
      expect(swarmState().agents.filter(row => row.id === 'worker-1').map(row => row.runId)).toEqual([a.runId, b.runId]);
      for (const caller of [prime, primeB]) {
        expect(statusForCaller(caller).freeWorkerSlots).toBe(0);
        expect(() => spawn({ caller, workers: [{ task: 'third task' }] })).toThrow(/limit/);
      }
      expect(bindConversation('worker-1', 'parallel-worker-a', a.runId)).toBe(true);
      expect(bindConversation('worker-1', 'parallel-worker-b', b.runId)).toBe(true);
      finishAgent({ conversationId: 'parallel-worker-a' }, 'A finished its piece');
      expect(freeWorkerSlots(a.runId)).toBe(1);
      expect(freeWorkerSlots(b.runId)).toBe(0);
      expect(recruit(prime, 1).runId).toBe(a.runId);
      expect(freeWorkerSlots(a.runId)).toBe(0);
      expect(freeWorkerSlots('stale-run')).toBe(0);
    } finally { await setEnabled(true); }
  });

  it('keeps an independent durable worker cap for each prime', async () => {
    await setEnabled(true, 3);
    try {
      const a = spawn({ caller: prime, workerLimit: 1, workers: [{ task: 'small owner task' }] });
      const b = spawn({ caller: primeB, workerLimit: 3, workers: [
        { task: 'large owner task one' }, { task: 'large owner task two' }
      ] });
      expect(freeWorkerSlots(a.runId)).toBe(0);
      expect(freeWorkerSlots(b.runId)).toBe(1);
      expect(() => spawn({ caller: prime, workers: [{ task: 'too many for A' }] })).toThrow(/limit/);

      expect(setPrimeWorkerLimit(PRIME_CHAT, 2)).toBe(true);
      expect(freeWorkerSlots(a.runId)).toBe(1);
      const saved = JSON.parse(JSON.stringify(snapshotSwarm()));
      resetAgentsForTests(); restoreSwarm(saved);
      expect(freeWorkerSlots(currentRunId(PRIME_CHAT)!)).toBe(1);
      expect(freeWorkerSlots(currentRunId(primeB.conversationId!)!)).toBe(1);
    } finally { await setEnabled(true); }
  });

  it('clamps a restored legacy per-prime limit of eight to six', async () => {
    await setEnabled(true, 6);
    try {
      const run = spawn({ caller: prime, workerLimit: 5, workers: [{ task: 'legacy limit history' }] });
      const saved = JSON.parse(JSON.stringify(snapshotSwarm()));
      const storedRun = saved.activeRuns.find((entry: { runId: string }) => entry.runId === run.runId);
      storedRun.workerLimit = 8;
      resetAgentsForTests();
      restoreSwarm(saved);

      expect(snapshotSwarm()?.activeRuns?.find(entry => entry.runId === run.runId)?.workerLimit).toBe(6);
      expect(freeWorkerSlots(run.runId)).toBe(5);
    } finally { await setEnabled(true); }
  });

  it('routes same-named workers and their finish reports only to their exact owners', () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    expect(bindConversation('worker-1', 'parallel-worker-a', a.runId)).toBe(true);
    expect(bindConversation('worker-1', 'parallel-worker-a', b.runId)).toBe(false);
    expect(bindConversation('worker-1', 'parallel-worker-b', b.runId)).toBe(true);
    expect(bindConversation('worker-1', 'ambiguous-worker')).toBe(false);
    sendMessage(prime, 'worker-1', 'A-only instruction');
    sendMessage(primeB, 'worker-1', 'B-only instruction');
    expect(offerMessages('worker-1')).toEqual([]);
    expect(offerMessagesForConversation('parallel-worker-a')?.messages.map(m => m.text)).toEqual(['A-only instruction']);
    expect(offerMessagesForConversation('parallel-worker-b')?.messages.map(m => m.text)).toEqual(['B-only instruction']);
    finishAgent({ conversationId: 'parallel-worker-a' }, 'A-only result');
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages.map(m => m.text).join('')).toContain('A-only result');
    expect(offerMessagesForConversation(primeB.conversationId)?.messages).toEqual([]);
    expect(() => recruit({ conversationId: 'parallel-worker-b' }, 1)).toThrow(/worker/i);
  });

  it('allows independent staged spawns while rollback cannot erase another accepted owner', async () => {
    const a = stageSpawn({ caller: prime, workers: [{ task: 'A staged' }] });
    const b = stageSpawn({ caller: primeB, workers: [{ task: 'B staged' }] });
    expect(pendingWorkerSpawns()).toEqual([]);
    expect(snapshotSwarm()).toBeNull();
    expect(bindConversation('worker-1', 'unaccepted', a.runId)).toBe(false);
    const writes: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async snapshot => { writes.push(structuredClone(snapshot)); });
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(writes.at(-1)?.activeRuns?.map(r => r.runId)).toEqual([a.runId, b.runId]);
    b.commit(); a.rollback();
    expect(pendingWorkerSpawns()).toEqual([expect.objectContaining({ runId: b.runId, primeConversationId: primeB.conversationId })]);
    expect(currentRunId(PRIME_CHAT)).toBeNull();
    expect(currentRunId(primeB.conversationId!)).toBe(b.runId);
    expect(snapshotSwarm()?.activeRuns?.map(r => r.runId)).toEqual([b.runId]);
    restoreSwarm(snapshotSwarm());
    expect(currentRunId(PRIME_CHAT)).toBeNull();
    expect(currentRunId(primeB.conversationId!)).toBe(b.runId);
  });

  it('restores both live owners and preserves each inbox and explicit command fence', () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    bindConversation('worker-1', 'parallel-worker-a', a.runId);
    bindConversation('worker-1', 'parallel-worker-b', b.runId);
    sendMessage(prime, 'worker-1', 'durable A');
    sendMessage(primeB, 'worker-1', 'durable B');
    const snapshot = JSON.parse(JSON.stringify(snapshotSwarm()));
    resetAgentsForTests(); restoreSwarm(snapshot);
    expect(currentRunId(PRIME_CHAT)).toBe(a.runId);
    expect(currentRunId(primeB.conversationId!)).toBe(b.runId);
    expect(offerMessagesForConversation('parallel-worker-a')?.messages.map(m => m.text)).toEqual(['durable A']);
    expect(offerMessagesForConversation('parallel-worker-b')?.messages.map(m => m.text)).toEqual(['durable B']);
    expect(acknowledgeOffers('worker-1', false, Infinity, 'old-incarnation')).toEqual([]);
    expect(pendingCount('worker-1', b.runId)).toBe(1);
  });

  it('parks and reuses A beside executing B while rejecting A old incarnation commands', () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    bindConversation('worker-1', 'parallel-worker-a', a.runId);
    bindConversation('worker-1', 'parallel-worker-b', b.runId);
    finishAgent({ conversationId: 'parallel-worker-a' }, 'A sleeps');
    expect(releaseQuiescentRun({}, a.runId)).toBe(true);
    const wake = stageMessages(prime, [{ to: 'worker-1', text: 'reuse A' }]);
    wake.commit();
    const nextA = currentRunId(PRIME_CHAT)!;
    expect(nextA).not.toBe(a.runId);
    expect(currentRunId(primeB.conversationId!)).toBe(b.runId);
    expect(claimWorkerRevival('worker-1', 'parallel-worker-a', a.runId)).toBe(false);
    expect(claimWorkerRevival('worker-1', 'parallel-worker-a', nextA)).toBe(true);
    expect(pendingWorkerRevivals()).toEqual([expect.objectContaining({ runId: nextA, conversationId: 'parallel-worker-a' })]);
    clearAgent('prime', nextA);
    expect(currentRunId(PRIME_CHAT)).toBeNull();
    expect(statusForCaller(primeB).state.agents.find(a => a.id === 'worker-1')?.state).toBe('active');
  });

  it('fences overlapping prime transfers and preserves B when A resumes', async () => {
    const { beginPrimeTransfer, freezePrimeTransfer, commitPrimeTransfer, cancelPrimeTransfer } = await import('../src/main/agents.js');
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    expect(beginPrimeTransfer(PRIME_CHAT)).toBe(true);
    expect(beginPrimeTransfer(primeB.conversationId!)).toBe(true);
    expect(freezePrimeTransfer(PRIME_CHAT)).toBe('frozen');
    expect(commitPrimeTransfer(PRIME_CHAT, primeB.conversationId!)).toBe(false);
    expect(commitPrimeTransfer(PRIME_CHAT, 'parallel-prime-a-resumed')).toBe(true);
    expect(currentRunId(PRIME_CHAT)).toBeNull();
    expect(currentRunId('parallel-prime-a-resumed')).toBe(a.runId);
    expect(currentRunId(primeB.conversationId!)).toBe(b.runId);
    expect(swarmState(a.runId).agents.every(row => row.primeConversationId === 'parallel-prime-a-resumed')).toBe(true);
    cancelPrimeTransfer(primeB.conversationId!);
    expect(() => spawn({ caller: primeB, workers: [{ task: 'B next' }] })).not.toThrow();
  });

  it('publishes a staged finish only into A even when B is cleared and replaced during persistence', async () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    bindConversation('worker-1', 'parallel-worker-a', a.runId);
    const staged = stageFinishAgent({ conversationId: 'parallel-worker-a' }, 'A durable report');
    let unblock!: () => void;
    onSwarmPersistNow(async () => { await new Promise<void>(resolve => { unblock = resolve; }); });
    const barrier = persistCriticalSwarmNow();
    await Promise.resolve();
    clearAgent('prime', b.runId);
    recruit(primeB, 1);
    onSwarmPersistNow(async () => undefined);
    unblock();
    expect(await barrier).toBe(true);
    staged.commit();
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages.map(m => m.text).join('')).toContain('A durable report');
    expect(offerMessagesForConversation(primeB.conversationId)?.messages).toEqual([]);
  });
});

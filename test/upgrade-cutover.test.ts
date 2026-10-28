/**
 * Same-version private-build cutover rehearsal.
 *
 * This suite deliberately never starts the bridge listener or a packaged Electron process.
 * It uses the same config/profile roots, session store, durable files, Goal restore, broker
 * restore and bridge command restore that production startup uses, but only under one temp
 * user-data root. That lets a running installed app/extension remain completely untouched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const recoveryBrowserWake = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/main/browser-startup.js', () => ({ wakeBrowserUrl: recoveryBrowserWake }));
vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'unknown'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  clipboard: {},
  shell: {}
}));

const {
  getActiveInstanceOwnerPaths,
  initConfigPath,
  loadConfig,
  saveConfig
} = await import('../src/main/config.js');
const {
  flushDurable,
  initDurableStore,
  readDurable,
  resetDurableForTests,
  writeDurableNow,
  writeDurableSoon
} = await import('../src/main/durable.js');
const {
  appendEvent,
  createSession,
  findSessionByConversation,
  flushSessions,
  initSessionStore,
  listAllSessions,
  resetSessionStoreForTests,
  upsertMessageEvent
} = await import('../src/main/session/store.js');
const goal = await import('../src/main/goal.js');
const {
  MISSING_MCP_LOOP_ATTENTION_MS,
  MISSING_MCP_LOOP_RECHECK_MS,
  GOAL_REPLIES_STATE,
  GOAL_SWITCHES_STATE
} = goal;
const {
  bindConversation,
  finishAgent,
  onSwarmPersist,
  onSwarmPersistNow,
  pendingWorkerRevivals,
  resetAgentsForTests,
  restoreSwarm,
  snapshotSwarm,
  spawn,
  stageMessages,
  swarmStateForCaller
} = await import('../src/main/agents.js');
const {
  REVIVAL_ACTIVITY_MS,
  maintainLoopLanes,
  resetBridgeForTests,
  restoreCommands,
  setBrowserOpener,
  setCoreConnectionRecoveryProvider,
  setCoreConnectionStateProvider
} = await import('../src/main/bridge.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const NOW = 1_797_500_000_000;
const CHAT = {
  pending: '10000000-1111-4111-8111-000000000001',
  reconstruct: '10000000-1111-4111-8111-000000000002',
  stale: '10000000-1111-4111-8111-000000000003',
  healthy: '10000000-1111-4111-8111-000000000004',
  coreA: '10000000-1111-4111-8111-000000000005',
  coreB: '10000000-1111-4111-8111-000000000006',
  coreExhausted: '10000000-1111-4111-8111-000000000007',
  fenced: '10000000-1111-4111-8111-000000000008',
  prime: '20000000-1111-4111-8111-000000000001',
  sleepingWorker: '20000000-1111-4111-8111-000000000002',
  wakingWorker: '20000000-1111-4111-8111-000000000003',
  expiredWorker: '20000000-1111-4111-8111-000000000004'
} as const;

type Owners = ReturnType<typeof getActiveInstanceOwnerPaths>;
type SessionSeed = { id: string; finalSeq: number; turnId: string; replyId: string };
type OfflineCoreRecovery = () => Promise<'offline'>;

let dir = '';

async function enterStores(owners: Owners): Promise<void> {
  await flushSessions().catch(() => undefined);
  await flushDurable().catch(() => undefined);
  resetSessionStoreForTests();
  resetDurableForTests();
  initSessionStore(owners.sessionStoreRoot);
  initDurableStore(owners.durableStoreRoot);
}

async function seedCompletedChat(
  conversationId: string,
  suffix: string,
  options: { goalEligible?: boolean; newerUser?: boolean } = {}
): Promise<SessionSeed> {
  const session = await createSession({ title: `Cutover ${suffix}`, conversationId });
  const turnId = `turn-${suffix}`;
  const replyId = `assistant-${suffix}`;
  await upsertMessageEvent(session.id, {
    source: 'extension',
    kind: 'user_message',
    time: NOW - 30_000,
    messageId: `user-${suffix}`,
    authoredText: `Original request ${suffix}`,
    message: { text: `Original request ${suffix}`, chars: 17 + suffix.length, truncated: false }
  });
  await appendEvent(session.id, { source: 'extension', kind: 'turn_start', time: NOW - 29_000, turnId });
  const final = await upsertMessageEvent(session.id, {
    source: 'extension',
    kind: 'assistant_message',
    time: NOW - 28_000,
    turnId,
    messageId: replyId,
    state: 'final',
    final: true,
    goalEligible: options.goalEligible !== false,
    message: { text: `Completed ${suffix}`, chars: 10 + suffix.length, truncated: false }
  });
  await appendEvent(session.id, {
    source: 'extension',
    kind: 'turn_end',
    time: NOW - 27_000,
    turnId,
    outcome: 'completed'
  });
  if (options.newerUser) {
    await upsertMessageEvent(session.id, {
      source: 'extension',
      kind: 'user_message',
      time: NOW - 26_000,
      messageId: `user-newer-${suffix}`,
      authoredText: `Newer instruction ${suffix}`,
      message: { text: `Newer instruction ${suffix}`, chars: 18 + suffix.length, truncated: false }
    });
  }
  return { id: session.id, finalSeq: final.event.origin ?? final.event.seq, turnId, replyId };
}

async function userMessageCounts(): Promise<Map<string, number>> {
  return new Map((await listAllSessions())
    .filter((session) => session.conversationId)
    .map((session) => [session.conversationId!, session.userMessages]));
}

function goalRow(seed: SessionSeed, conversationId: string, state: 'pending' | 'handled', acceptedAt: number) {
  return {
    conversationId,
    sessionId: seed.id,
    replyId: seed.replyId,
    turnId: seed.turnId,
    eventSeq: seed.finalSeq,
    acceptedAt,
    state
  } as const;
}

async function restoreProductionOwners(owners: Owners, coreRecovery: OfflineCoreRecovery): Promise<void> {
  initConfigPath(dir);
  await loadConfig();
  await enterStores(owners);

  goal.restoreGoalSwitches(await readDurable<any>(GOAL_SWITCHES_STATE));
  goal.restoreGoalReplies(await readDurable<any>(GOAL_REPLIES_STATE));

  setCoreConnectionStateProvider(() => 'offline');
  setCoreConnectionRecoveryProvider(coreRecovery);
  setBrowserOpener(async () => {
    throw new Error('disposable cutover restore attempted to open a browser');
  });

  onSwarmPersist(() => writeDurableSoon('swarm', snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
  restoreSwarm(await readDurable<any>('swarm'));
  await restoreCommands();
}

function resetProcessMemory(): void {
  goal.resetGoalStateForTests();
  resetAgentsForTests();
  resetBridgeForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  setCoreConnectionStateProvider(null);
  setCoreConnectionRecoveryProvider(null);
  setBrowserOpener(null);
}

afterEach(async () => {
  await flushSessions().catch(() => undefined);
  await flushDurable().catch(() => undefined);
  resetProcessMemory();
  recoveryBrowserWake.mockReset();
  vi.useRealTimers();
  if (dir) await removeTempDir(dir);
  dir = '';
});

describe('source-to-live durable cutover rehearsal', () => {
  it('restores one copied pre-activation state twice without duplicating debt, recovery or worker identity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    recoveryBrowserWake.mockReset();
    dir = await makeTempDir('clf-upgrade-cutover-');

    initConfigPath(dir);
    const base = await loadConfig();
    await saveConfig({
      ...base,
      sessions: { ...base.sessions, record: true },
      goal: { ...base.goal, enabled: true, mode: 'loop', backend: 'chatgpt', loopBackend: 'chatgpt' },
      multiAgent: {
        ...base.multiAgent,
        enabled: true,
        maxWorkers: 3,
        // This rehearsal asserts that unrelated Loop debt stays queued while Core recovery is
        // offline. Opt into the conservative lane ceiling explicitly; fast/Day mode now
        // intentionally ignores maxActiveChats when limitAutomaticChats is off.
        limitAutomaticChats: true,
        maxActiveChats: 1
      }
    });
    const owners = getActiveInstanceOwnerPaths();
    await enterStores(owners);

    const pending = await seedCompletedChat(CHAT.pending, 'pending');
    const reconstruct = await seedCompletedChat(CHAT.reconstruct, 'reconstruct');
    await seedCompletedChat(CHAT.stale, 'stale', { newerUser: true });
    await seedCompletedChat(CHAT.healthy, 'healthy', { goalEligible: false });
    const coreA = await seedCompletedChat(CHAT.coreA, 'core-a');
    const coreB = await seedCompletedChat(CHAT.coreB, 'core-b');
    const coreExhausted = await seedCompletedChat(CHAT.coreExhausted, 'core-exhausted');
    const fenced = await seedCompletedChat(CHAT.fenced, 'fenced');
    await goal.setGoalSwitchNow(CHAT.fenced, 'loop', true, true);

    const retryDetectedAt = NOW - 2 * MISSING_MCP_LOOP_RECHECK_MS;
    const exhaustedDetectedAt = NOW - MISSING_MCP_LOOP_ATTENTION_MS - 1;
    await writeDurableNow(GOAL_REPLIES_STATE, {
      version: 1,
      savedAt: NOW - 1,
      replies: [
        goalRow(pending, CHAT.pending, 'pending', NOW - 60_000),
        {
          ...goalRow(coreA, CHAT.coreA, 'handled', retryDetectedAt - 1_000),
          missingMcpDetectedAt: retryDetectedAt,
          missingMcpRetryAt: NOW
        },
        {
          ...goalRow(coreB, CHAT.coreB, 'handled', retryDetectedAt - 2_000),
          missingMcpDetectedAt: retryDetectedAt,
          missingMcpRetryAt: NOW
        },
        {
          ...goalRow(coreExhausted, CHAT.coreExhausted, 'handled', exhaustedDetectedAt - 1_000),
          missingMcpDetectedAt: exhaustedDetectedAt,
          missingMcpRetryAt: exhaustedDetectedAt + MISSING_MCP_LOOP_RECHECK_MS
        },
        goalRow(fenced, CHAT.fenced, 'pending', NOW - 30_000),
        {
          conversationId: 'bad!', sessionId: 'bad', replyId: 'bad', turnId: 'bad',
          eventSeq: 1, acceptedAt: NOW + 60_000, state: 'pending'
        }
      ]
    });
    await writeDurableNow(GOAL_SWITCHES_STATE, goal.snapshotGoalSwitches());

    const workerSpawn = spawn({
      caller: { conversationId: CHAT.prime },
      workers: [
        { label: 'Sleeper', task: 'retain exact sleeping identity and inbox' },
        { label: 'Accepted wake', task: 'retain exact accepted waking identity' },
        { label: 'Expired wake', task: 'normalize only the expired transport' }
      ]
    });
    expect(bindConversation('worker-1', CHAT.sleepingWorker, workerSpawn.runId)).toBe(true);
    expect(bindConversation('worker-2', CHAT.wakingWorker, workerSpawn.runId)).toBe(true);
    expect(bindConversation('worker-3', CHAT.expiredWorker, workerSpawn.runId)).toBe(true);

    stageMessages({ conversationId: CHAT.prime }, [{ to: 'worker-1', text: 'retained sleeping inbox' }]).commit();
    finishAgent({ conversationId: CHAT.sleepingWorker }, 'sleeping result survives cutover');
    finishAgent({ conversationId: CHAT.wakingWorker }, 'wake me again');
    stageMessages({ conversationId: CHAT.prime }, [{ to: 'worker-2', text: 'accepted wake survives restart' }]).commit();
    finishAgent({ conversationId: CHAT.expiredWorker }, 'expire only this transport');
    stageMessages({ conversationId: CHAT.prime }, [{ to: 'worker-3', text: 'expired wake becomes sleeping again' }]).commit();

    const preActivationSwarm = snapshotSwarm();
    expect(preActivationSwarm).not.toBeNull();
    await writeDurableNow('swarm', preActivationSwarm);
    const expiredRevival = pendingWorkerRevivals().find((entry) => entry.id === 'worker-3')!;
    expect(expiredRevival).toBeTruthy();
    await writeDurableNow('bridge-commands', {
      version: 6,
      commands: [{
        id: 'expired-cutover-revival',
        spec: {
          type: 'revive',
          agent: expiredRevival.id,
          conversationId: expiredRevival.conversationId,
          runId: expiredRevival.runId,
          wake: expiredRevival.messageIds.join(' ')
        },
        createdAt: NOW - REVIVAL_ACTIVITY_MS - 1,
        availableAt: NOW - REVIVAL_ACTIVITY_MS - 1,
        phase: 'queued',
        claimedAt: null,
        admissionDeferredAt: null,
        owner: null,
        lastError: null,
        openAttempts: 0
      }],
      receipts: [],
      admission: { cooldownUntil: 0, lastRateLimitAt: 0, streak: 0 },
      recoveryFences: [
        { conversationId: CHAT.fenced, exhaustedAt: NOW - 15_000 },
        { conversationId: 'not-a-chat!', exhaustedAt: NOW - 10_000 }
      ]
    });
    await flushSessions();
    await flushDurable();
    const authoredBefore = await userMessageCounts();

    // ------------------------------ first current-source cold start
    resetProcessMemory();
    const firstCoreRecovery = vi.fn(async () => 'offline' as const);
    await restoreProductionOwners(owners, firstCoreRecovery);

    expect(await goal.reconstructExplicitGoalReplyNow(CHAT.reconstruct)).toBe(true);
    expect(await goal.reconstructExplicitGoalReplyNow(CHAT.stale)).toBe(false);
    expect(goal.snapshotGoalReplies().replies.some((row) => row.conversationId === 'bad!')).toBe(false);
    expect(goal.goalPendingReplyFor(CHAT.pending)).toMatchObject({ replyId: pending.replyId, turnId: pending.turnId });
    expect(goal.goalPendingReplyFor(CHAT.reconstruct)).toMatchObject({ replyId: reconstruct.replyId, turnId: reconstruct.turnId });
    expect(goal.goalPendingReplyFor(CHAT.stale)).toBeNull();

    const firstExpired = swarmStateForCaller({ conversationId: CHAT.prime }).agents.find((entry) => entry.id === 'worker-3');
    expect(firstExpired).toMatchObject({ state: 'sleeping', revivable: true, conversationId: CHAT.expiredWorker, pending: 1 });
    const firstSleeping = swarmStateForCaller({ conversationId: CHAT.prime }).agents.find((entry) => entry.id === 'worker-1');
    expect(firstSleeping).toMatchObject({ state: 'sleeping', revivable: true, conversationId: CHAT.sleepingWorker, pending: 1,
      result: 'sleeping result survives cutover' });
    const firstRevivals = pendingWorkerRevivals();
    expect(firstRevivals).toHaveLength(1);
    expect(firstRevivals[0]).toMatchObject({ id: 'worker-2', conversationId: CHAT.wakingWorker, runId: workerSpawn.runId });
    expect(firstRevivals[0]?.text).toContain('accepted wake survives restart');

    const afterCommandRestore = await readDurable<any>('bridge-commands');
    expect(afterCommandRestore?.commands).toEqual([]);
    expect(afterCommandRestore?.recoveryFences).toEqual([{ conversationId: CHAT.fenced, exhaustedAt: NOW - 15_000 }]);
    const durableBrokerAfterExpiredWake = await readDurable<any>('swarm');
    expect(durableBrokerAfterExpiredWake?.activeRuns?.[0]?.agents?.find((entry: any) => entry.info.id === 'worker-3')?.info)
      .toMatchObject({ state: 'sleeping', revivable: true, conversationId: CHAT.expiredWorker });

    // The current lane owner checks Core once and keeps all already-durable reply debt parked
    // while Core is offline. A cold cutover must not open Chrome merely to rediscover that fact.
    expect(await maintainLoopLanes(NOW)).toBe(false);
    expect(firstCoreRecovery).toHaveBeenCalledTimes(1);
    expect(recoveryBrowserWake).not.toHaveBeenCalled();
    recoveryBrowserWake.mockClear();
    const firstReplies = goal.snapshotGoalReplies();
    for (const id of [CHAT.coreA, CHAT.coreB]) {
      const recovery = goal.missingMcpLoopRecoveryFor(id, NOW)!;
      expect(recovery).toMatchObject({ detectedAt: retryDetectedAt, retryAt: NOW + MISSING_MCP_LOOP_RECHECK_MS, needsAttention: false });
    }
    expect(goal.missingMcpLoopRecoveryFor(CHAT.coreExhausted, NOW)).toMatchObject({
      detectedAt: exhaustedDetectedAt,
      needsAttention: true
    });
    const firstSwarm = snapshotSwarm()!;
    const firstWorker2Wake = pendingWorkerRevivals()[0]!;
    expect(await userMessageCounts()).toEqual(authoredBefore);

    await flushSessions();
    await flushDurable();

    // ------------------------------ clean shutdown / second current-source cold start
    resetProcessMemory();
    vi.setSystemTime(NOW + 1);
    const secondCoreRecovery = vi.fn(async () => 'offline' as const);
    await restoreProductionOwners(owners, secondCoreRecovery);

    expect(await goal.reconstructExplicitGoalReplyNow(CHAT.reconstruct)).toBe(false);
    expect(await goal.reconstructExplicitGoalReplyNow(CHAT.stale)).toBe(false);
    // Restarting one millisecond later preserves the deferred Core tickets and exhausted fence;
    // it must not manufacture a fresh browser cycle before either durable deadline is due.
    expect(await maintainLoopLanes(NOW + 1)).toBe(false);
    expect(secondCoreRecovery).not.toHaveBeenCalled();
    expect(recoveryBrowserWake).not.toHaveBeenCalled();
    expect(await userMessageCounts()).toEqual(authoredBefore);

    const secondReplies = goal.snapshotGoalReplies();
    const firstByConversation = new Map(firstReplies.replies.map((row) => [row.conversationId, row]));
    const secondByConversation = new Map(secondReplies.replies.map((row) => [row.conversationId, row]));
    expect(secondByConversation.size).toBe(firstByConversation.size);
    expect([...secondByConversation.keys()].sort()).toEqual([...firstByConversation.keys()].sort());
    expect(secondByConversation.get(CHAT.reconstruct)).toMatchObject({
      replyId: reconstruct.replyId,
      turnId: reconstruct.turnId,
      explicitActivation: true
    });
    expect(secondByConversation.has(CHAT.stale)).toBe(false);
    for (const id of [CHAT.coreA, CHAT.coreB]) {
      expect(secondByConversation.get(id)).toMatchObject({
        missingMcpDetectedAt: retryDetectedAt,
        missingMcpRetryAt: NOW + MISSING_MCP_LOOP_RECHECK_MS
      });
    }
    expect(secondByConversation.get(CHAT.coreExhausted)).toMatchObject({
      missingMcpDetectedAt: exhaustedDetectedAt,
      missingMcpRetryAt: exhaustedDetectedAt + MISSING_MCP_LOOP_RECHECK_MS
    });

    const secondSwarm = snapshotSwarm()!;
    expect(secondSwarm.activeRuns?.[0]?.runId).toBe(firstSwarm.activeRuns?.[0]?.runId);
    for (const [id, conversationId, state] of [
      ['worker-1', CHAT.sleepingWorker, 'sleeping'],
      ['worker-2', CHAT.wakingWorker, 'waking'],
      ['worker-3', CHAT.expiredWorker, 'sleeping']
    ] as const) {
      expect(secondSwarm.activeRuns?.[0]?.agents.find((entry) => entry.info.id === id)?.info)
        .toMatchObject({ id, conversationId, state });
    }
    const secondWorker1 = secondSwarm.activeRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1');
    expect(secondWorker1?.queue.some((message) => message.text === 'retained sleeping inbox' && message.ackedAt === null)).toBe(true);
    const secondRevivals = pendingWorkerRevivals();
    expect(secondRevivals).toHaveLength(1);
    expect(secondRevivals[0]).toEqual(firstWorker2Wake);

    const finalCommands = await readDurable<any>('bridge-commands');
    expect(finalCommands?.commands).toEqual([]);
    expect(finalCommands?.recoveryFences).toEqual([{ conversationId: CHAT.fenced, exhaustedAt: NOW - 15_000 }]);
    expect(finalCommands?.recoveryFences.filter((row: any) => row.conversationId === CHAT.fenced)).toHaveLength(1);
    expect((await findSessionByConversation(CHAT.healthy, { requireUnique: true }))?.conversationId).toBe(CHAT.healthy);
  });
});

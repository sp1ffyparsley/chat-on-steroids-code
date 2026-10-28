/**
 * The Compact & Resume transaction: moving one durable local session from chat A to chat B.
 *
 * Every test here is about the failure half of that move rather than the happy path. The
 * invariant the whole design exists to protect is that a commit either lands completely or
 * leaves the session attached to chat A — never a session on disk in B with its swarm, its
 * workspace or its recorded history still in A. So these drive the races directly: two
 * claimants, a claim arriving mid-commit, a sweep firing mid-commit, an abort mid-commit, a
 * durable write that fails, and a handover deadline crossed while the write is in flight.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async importOriginal => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, randomBytes: vi.fn(original.randomBytes) };
});

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

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const {
  beginPrimeTransfer,
  bindConversation,
  cancelPrimeTransfer,
  commitPrimeTransfer,
  finishAgent,
  freezePrimeTransfer,
  noteAgentContextTokens,
  pendingWorkerRevivals,
  primeConversation,
  primeFleetIn,
  primeConversationGone,
  releaseQuiescentRun,
  repairPrimeConversationAfterRecovery,
  resetAgentsForTests,
  sendMessage,
  snapshotSwarm,
  restoreSwarm,
  spawn,
  swarmRunning,
  swarmStateForCaller,
  thawPrimeTransfer,
  WORKER_CONTEXT_CEILING_TOKENS
} = await import('../src/main/agents.js');
const {
  AUTOMATIC_HANDOVER_TTL_MS,
  CONTINUATION_TTL_MS,
  acknowledgeSupersededSourceRetirementNow,
  abortContinuation,
  abortContinuationSourceBeforeSendNow,
  attachSummary,
  beginContinuationDestinationSendNow,
  beginContinuationSourceSendNow,
  bindContinuationSourceMessageNow,
  bindContinuationDestinationMessageNow,
  claimContinuationNow,
  commitContinuation,
  compactingConversation,
  continuationByToken,
  continuationForSession,
  retentionHeldContinuationSessions,
  dispatchContinuationDestinationSendNow,
  dispatchContinuationSourceSendNow,
  openContinuationNow,
  releaseContinuationDestinationSendNow,
  repairPrimeFromResumeShadow,
  resetContinuationsForTests,
  restoreContinuations,
  setContinuationRecoveryHooks,
  snapshotContinuations,
  spendSupersededSourceClosesNow,
  supersededSourceConversations
} = await import('../src/main/session/continuation.js');
const { REDEEMED_COMMAND_DELIVERY_MS, RESUME_CLAIM_WINDOW_MS, noteResumeClaim,
  noteResumeCommandLease, noteResumeOpening, resumeOpeningChat, resumeOpeningWait } = await import('../src/main/session/resume-gate.js');
const { briefShortfall, resumeBootstrapText } = await import('../src/main/session/handoff.js');
const { createSession, getSession, initSessionStore, resetSessionStoreForTests, sessionsRoot } = await import(
  '../src/main/session/store.js'
);
const store = await import('../src/main/session/store.js');
const { recordChatObservations, resetRecorderForTests, sessionForConversation } = await import('../src/main/session/recorder.js');
const { resetWorkspaces, setWorkspaceFor, workspaceEntries } = await import('../src/main/workspace.js');
const {
  acceptGoalReplyNow,
  goalObjectiveFor,
  goalPendingReplyFor,
  goalSwitchFor,
  restoreGoalReplies,
  setGoalSwitchNow,
  resetGoalStateForTests,
  setGoalObjective
} = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir, SAMPLE_BRIEF } = await import('./helpers.js');

let dir: string;

/** The chat this session is attached to right now. */
async function attachedChat(sessionId: string): Promise<string | null> {
  return (await getSession(sessionId))?.conversationId ?? null;
}

/** How many handoffs this session has on disk. One per continuation, ever. */
async function handoffCount(sessionId: string): Promise<number> {
  try {
    return (await fs.readdir(path.join(sessionsRoot(), sessionId, 'handoffs'))).length;
  } catch {
    return 0;
  }
}

const CHAT_A = 'chat-a';
const CHAT_B = 'chat-b';
const CHAT_C = 'chat-c';

beforeAll(async () => {
  dir = await makeTempDir('clf-continuation-');
  initConfigPath(dir);
  initSessionStore(dir);
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: true, maxWorkers: 3 } });
});

afterAll(async () => {
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetContinuationsForTests();
  resetAgentsForTests();
  resetRecorderForTests();
  resetWorkspaces();
  resetGoalStateForTests();
  await resetSessionStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A session attached to chat A with its brief already captured, ready to be claimed. */
async function readyContinuation(summaryText = SAMPLE_BRIEF): Promise<{ sessionId: string; token: string }> {
  const summary = await createSession({ title: 'work', conversationId: CHAT_A });
  const opened = await openContinuationNow(summary.id, CHAT_A);
  await attachSummary(opened.token, summaryText);
  return { sessionId: summary.id, token: opened.token };
}

it('retention protects an uncommitted resume without executing it and releases an aborted pre-send owner', async () => {
  const pending = await createSession({ title: 'retention pending Compact & Resume', conversationId: CHAT_A });
  const old = await createSession({ title: 'independent expired recording' });
  const opened = await openContinuationNow(pending.id, CHAT_A);
  expect(retentionHeldContinuationSessions().has(pending.id)).toBe(true);
  await store.flushSessions();
  await resetSessionStoreForTests();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 32 * 24 * 60 * 60_000);
  expect(await store.pruneSessions(30)).toBe(1);
  await expect(fs.stat(path.join(sessionsRoot(), pending.id))).resolves.toBeTruthy();
  await expect(fs.stat(path.join(sessionsRoot(), old.id))).rejects.toMatchObject({ code: 'ENOENT' });
  const recorder = await import('../src/main/session/recorder.js');
  const abandonmentNote = vi.spyOn(recorder, 'recordNote');
  // Finish the real cancellation note before aging this historical session.
  clock.mockReturnValue(now);
  expect(abortContinuation(opened.token, 'positive pre-send cancellation')).toBe(true);
  expect(retentionHeldContinuationSessions().has(pending.id)).toBe(false);
  expect(abandonmentNote).toHaveBeenCalledExactlyOnceWith(pending.id,
    'Compact & Resume abandoned — positive pre-send cancellation', opened.token);
  await abandonmentNote.mock.results[0]!.value;
  expect(await store.readEvents(pending.id, { kinds: ['note'] })).toContainEqual(expect.objectContaining({
    kind: 'note', source: 'app', time: now, continuation: opened.token,
    message: expect.objectContaining({ text: 'Compact & Resume abandoned — positive pre-send cancellation' })
  }));
  await store.flushSessions();
  resetSessionStoreForTests();
  clock.mockReturnValue(now + 32 * 24 * 60 * 60_000);
  expect(await store.pruneSessions(30)).toBe(1);
  await expect(fs.stat(path.join(sessionsRoot(), pending.id))).rejects.toMatchObject({ code: 'ENOENT' });
});

describe('capturing the brief', () => {
  it('freezes exact source model intent across selection changes and durable restore', async () => {
    const summary = await createSession({ title: 'model transfer', conversationId: CHAT_A });
    await store.observeSessionModel(summary.id, CHAT_A, 'gpt-5.6-sol', 10, 'high');
    const opened = await openContinuationNow(summary.id, CHAT_A);
    expect(opened.requestedModel).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    opened.requestedModel!.model = 'caller-mutated';
    await store.observeSessionModel(summary.id, CHAT_A, 'gpt-6-astra', 20, 'ultra');
    expect((await openContinuationNow(summary.id, CHAT_A)).requestedModel).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    const snapshot = snapshotContinuations();
    resetContinuationsForTests();
    await restoreContinuations(snapshot);
    expect(continuationByToken(opened.token)?.requestedModel).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  });

  it('does not borrow selection from another conversation or invent missing effort', async () => {
    const summary = await createSession({ title: 'source evidence', conversationId: CHAT_A });
    await store.observeSessionModel(summary.id, CHAT_A, 'gpt-5.6-sol', 10);
    expect((await openContinuationNow(summary.id, CHAT_A)).requestedModel).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: null });
    resetContinuationsForTests();
    await store.rebindSession(summary.id, CHAT_A, CHAT_B);
    expect((await openContinuationNow(summary.id, CHAT_B)).requestedModel).toBeNull();
  });

  it.each([undefined, { model: '<invalid>', reasoningEffort: 'high' }, { model: 'gpt-5.6-sol', reasoningEffort: 'invented' }])(
    'keeps legacy or invalid restored model intent unknown (%j)', async requestedModel => {
      const { token } = await readyContinuation();
      const snapshot = snapshotContinuations();
      Object.assign(snapshot.entries[0]!, { requestedModel });
      resetContinuationsForTests();
      await restoreContinuations(snapshot);
      expect(continuationByToken(token)?.requestedModel).toBeNull();
    }
  );

  it('keeps an explicit pre-send automatic refusal across restart, scoped to its original turn', async () => {
    const summary = await createSession({ title: 'refused turn', conversationId: CHAT_A });
    await store.appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start', turnId: 'refused' });
    const ticket = await openContinuationNow(summary.id, CHAT_A, true);
    expect(await abortContinuationSourceBeforeSendNow(ticket.token, 'occupied_user_draft')).toBe(true);
    await store.flushSessions();
    await resetSessionStoreForTests();
    const restored = (await getSession(summary.id))!;
    expect(store.autoCompactionReady({ ...restored, contextTokens: 1_000_000 })).toBe(false);
    await store.appendEvent(summary.id, { time: 2, source: 'extension', kind: 'turn_start', turnId: 'next' });
    expect(store.autoCompactionReady({ ...(await getSession(summary.id))!, contextTokens: 1_000_000 })).toBe(true);
  });

  it('does not turn a browser-lost automatic handoff into a durable user refusal', async () => {
    const summary = await createSession({ title: 'lost browser handoff', conversationId: CHAT_A });
    await store.appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start', turnId: 'lost' });
    const ticket = await openContinuationNow(summary.id, CHAT_A, true);
    expect(await abortContinuationSourceBeforeSendNow(ticket.token, 'handoff_never_sent')).toBe(true);
    expect(store.autoCompactionReady({ ...(await getSession(summary.id))!, contextTokens: 1_000_000 })).toBe(true);
  });

  it('aborts only while the source checkpoint still proves no prompt was sent', async () => {
    const untouched = await createSession({ title: 'untouched source', conversationId: CHAT_A });
    const untouchedContinuation = await openContinuationNow(untouched.id, CHAT_A, true);
    expect(await abortContinuationSourceBeforeSendNow(untouchedContinuation.token, 'handoff_never_sent')).toBe(true);
    expect(continuationByToken(untouchedContinuation.token)).toMatchObject({
      state: 'aborted',
      error: 'handoff_never_sent'
    });

    const claimed = await createSession({ title: 'claimed source', conversationId: CHAT_B });
    const claimedContinuation = await openContinuationNow(claimed.id, CHAT_B, true);
    expect((await beginContinuationSourceSendNow(claimedContinuation.token))?.allowed).toBe(true);
    expect(await abortContinuationSourceBeforeSendNow(claimedContinuation.token, 'handoff_never_sent')).toBe(true);
    expect(continuationByToken(claimedContinuation.token)?.state).toBe('aborted');

    const armed = await createSession({ title: 'armed source', conversationId: CHAT_C });
    const armedContinuation = await openContinuationNow(armed.id, CHAT_C, true);
    expect((await beginContinuationSourceSendNow(armedContinuation.token))?.allowed).toBe(true);
    expect(await dispatchContinuationSourceSendNow(armedContinuation.token)).toBe(true);
    expect(await abortContinuationSourceBeforeSendNow(armedContinuation.token, 'handoff_never_sent')).toBe(false);
    expect(continuationByToken(armedContinuation.token)).toMatchObject({
      state: 'awaiting-summary',
      sourceSend: { state: 'dispatched-unresolved' }
    });
  });

  it('answers a repeated capture with the handoff it already wrote', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);

    const first = await attachSummary(opened.token, SAMPLE_BRIEF);
    // The connector loses tool results, so the page reports the same finished generation
    // again. That retry must read as the success it is, not as a failure worth another flow.
    const again = await attachSummary(opened.token, SAMPLE_BRIEF);

    expect(first).not.toBeNull();
    expect(again?.id).toBe(first?.id);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('writes one handoff even when two captures race', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);

    // Both see `awaiting-summary` before either write lands. Without a lock taken before the
    // first await, both would write, and the second brief would silently win.
    const [first, second] = await Promise.all([
      attachSummary(opened.token, SAMPLE_BRIEF),
      attachSummary(opened.token, SAMPLE_BRIEF)
    ]);

    expect(first?.id).toBe(second?.id);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('gives every waiter the same retryable answer when the write fails', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const spy = vi.spyOn(store, 'saveHandoff').mockRejectedValueOnce(new Error('disk full'));

    // The duplicate joins the attempt already in flight. It must not receive a rejected
    // promise for a step that simply has to be done again.
    const both = await Promise.all([
      attachSummary(opened.token, SAMPLE_BRIEF),
      attachSummary(opened.token, SAMPLE_BRIEF)
    ]);
    expect(both).toEqual([null, null]);

    spy.mockRestore();
    expect(await attachSummary(opened.token, SAMPLE_BRIEF)).not.toBeNull();
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('does not publish a handoff whose continuation WAL transition was rejected', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const durable = await import('../src/main/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('continuation state disk full'));

    // The handoff file write succeeds; only the semantic continuation transition fails. A
    // failed compaction must remain invisible as the session's "latest handoff", otherwise a
    // fresh chat can recover a brief this transaction explicitly rejected.
    expect(await attachSummary(opened.token, SAMPLE_BRIEF)).toBeNull();
    expect(continuationForSession(summary.id)?.state).toBe('awaiting-summary');
    expect((await getSession(summary.id))?.lastHandoffId).toBeNull();
  });

  it('repairs a handoff event after a crash between continuation WAL commit and session publication', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const { prepareHandoff } = await import('../src/main/session/handoff.js');
    const prepared = await prepareHandoff({ sessionId: summary.id, text: SAMPLE_BRIEF,
      continuationToken: 'recovery-handoff-token', sourceConversationId: CHAT_A });
    expect((await getSession(summary.id))?.lastHandoffId).toBeNull();

    // This is the exact durable state after the continuation WAL landed but before the
    // following session handoff event could be appended. Recovery must publish that event
    // once, rather than losing handoff discovery or aborting a semantically committed capture.
    await restoreContinuations({
      version: 1,
      savedAt: Date.now(),
      entries: [
        {
          token: 'recovery-handoff-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: null,
          openedAt: Date.now(),
          state: 'awaiting-chat',
          summary: SAMPLE_BRIEF,
          handoffId: prepared.id,
          claimedBy: null,
          armed: true,
          error: null
        }
      ]
    });

    expect((await getSession(summary.id))?.lastHandoffId).toBe(prepared.id);
    // Idempotent recovery must not append a second handoff event or reorder the timeline.
    await restoreContinuations({
      version: 1,
      savedAt: Date.now(),
      entries: [
        {
          token: 'recovery-handoff-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: null,
          openedAt: Date.now(),
          state: 'awaiting-chat',
          summary: SAMPLE_BRIEF,
          handoffId: prepared.id,
          claimedBy: null,
          armed: true,
          error: null
        }
      ]
    });
    const handoffEvents = (await store.readEvents(summary.id, { kinds: ['handoff'] })).filter(
      (event) => event.kind === 'handoff' && event.handoffId === prepared.id
    );
    expect(handoffEvents).toHaveLength(1);
  });

  it('keeps the first brief when a re-observation differs, and still reports success', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const first = await attachSummary(opened.token, SAMPLE_BRIEF);

    const again = await attachSummary(opened.token, `${SAMPLE_BRIEF}

(re-rendered slightly differently)`);

    expect(again?.id).toBe(first?.id);
    expect(again?.text).toBe(first?.text);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('refuses an empty or interrupted answer and stays in chat A', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);

    expect(await attachSummary(opened.token, '   ')).toBeNull();
    expect(continuationForSession(summary.id)?.state).toBe('awaiting-summary');
    expect(await claimContinuationNow(opened.token, 'tab-1')).toBeNull();
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
  });
});

describe('claiming', () => {
  it('serves one claimant and refuses a second', async () => {
    const { token } = await readyContinuation();

    expect((await claimContinuationNow(token, 'tab-1'))?.summary).toContain(SAMPLE_BRIEF);
    expect(await claimContinuationNow(token, 'tab-2')).toBeNull();
    expect((await claimContinuationNow(token, 'tab-1'))?.summary).toContain(SAMPLE_BRIEF);
  });

  it('does not move the state backwards while a commit is in flight', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    // Hold the durable write open, so the commit is provably mid-flight.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.rebindSession;
    const spy = vi.spyOn(store, 'rebindSession').mockImplementation(async (...args) => {
      await held;
      return real(...args);
    });

    const commit = commitContinuation(token, CHAT_B);
    await Promise.resolve();
    expect(continuationForSession(sessionId)?.state).toBe('committing');

    // The retrying claimant wants its brief; what it must not get is the state put back to
    // `claimed`, which was the one way a second commit could enter behind the first.
    expect((await claimContinuationNow(token, 'tab-1'))?.summary).toContain(SAMPLE_BRIEF);
    expect(continuationForSession(sessionId)?.state).toBe('committing');
    const second = await commitContinuation(token, 'chat-c');
    expect(second).toBe(false);

    release();
    expect(await commit).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });
});

describe('committing', () => {
  it('moves the session, its history, workspace and saved Goal objective together', async () => {
    const { sessionId, token } = await readyContinuation();
    const before = await sessionForConversation(CHAT_A);
    expect(before).toBe(sessionId);
    setWorkspaceFor(`chat:${CHAT_A}`, { virtual: '/workspace/project', real: dir });
    setGoalObjective(CHAT_A, 'finish the overnight release');
    await setGoalSwitchNow(CHAT_A, 'loop', true, true);
    restoreGoalReplies({ version: 1, savedAt: Date.now(), replies: [{ conversationId: CHAT_A,
      sessionId, replyId: 'source-final', turnId: 'source-turn', eventSeq: 1, acceptedAt: Date.now(), state: 'pending' }] });
    await claimContinuationNow(token, 'tab-1');
    const committedHandoffId = continuationForSession(sessionId)?.handoffId;

    expect(await commitContinuation(token, CHAT_B)).toBe(true);

    const moved = await getSession(sessionId);
    expect(moved?.conversationId).toBe(CHAT_B);
    expect(moved?.lastCommittedResumeHandoffId).toBe(committedHandoffId);
    // Same durable session, with chat A kept as lineage rather than replaced.
    expect(moved?.chatIds).toEqual([CHAT_A, CHAT_B]);
    // The context meter is per attached chat, or the next turn would re-compact immediately.
    expect(moved?.contextTokens).toBe(0);
    expect(await sessionForConversation(CHAT_B)).toBe(sessionId);
    expect(workspaceEntries().map((held) => held.key)).toEqual([`chat:${CHAT_B}`]);
    expect(goalObjectiveFor(CHAT_A)).toBe('');
    expect(goalObjectiveFor(CHAT_B)).toBe('finish the overnight release');
    expect(goalSwitchFor(CHAT_B)).toMatchObject({ enabled: true, mode: 'loop', afterTurn: true });
    expect(goalSwitchFor(CHAT_A).own).toBe(false);
    expect(goalPendingReplyFor(CHAT_A)).toBeNull();
    expect(goalPendingReplyFor(CHAT_B)).toBeNull();
    const { getLog } = await import('../src/main/logger.js');
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery, hasPrimeFleet: primeFleetIn });
    const previousLogs = new Set(getLog());
    await restoreContinuations(snapshotContinuations());
    expect(getLog().filter(entry => !previousLogs.has(entry) && /prime repair hook|fleet is still led/.test(entry.message))).toEqual([]);
    expect(goalSwitchFor(CHAT_B)).toMatchObject({ enabled: true, mode: 'loop', afterTurn: true });
  });

  it.each(['missing-hook', 'remaining-fleet'] as const)('keeps a real recovery warning for %s', async failure => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'warning-owner');
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    setContinuationRecoveryHooks(failure === 'missing-hook' ? {} : {
      repairPrimeTransfer: () => false,
      hasPrimeFleet: conversationId => conversationId === CHAT_A
    });
    const { getLog } = await import('../src/main/logger.js');
    const previousLogs = new Set(getLog());
    await restoreContinuations(snapshotContinuations());
    const warnings = getLog().filter(entry => !previousLogs.has(entry) && /prime repair hook|fleet is still led/.test(entry.message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain(failure === 'missing-hook' ? 'without a broker prime repair hook' : `fleet is still led from ${CHAT_A}`);
  });

  it('binds the next recorded Loop obligation to the successor chat after commit', async () => {
    const { sessionId, token } = await readyContinuation();
    setGoalObjective(CHAT_A, 'continue this exact objective after the handoff');
    await setGoalSwitchNow(CHAT_A, 'loop', true, true);
    await claimContinuationNow(token, 'successor-loop-owner');

    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
    expect(goalSwitchFor(CHAT_A).own).toBe(false);
    expect(goalSwitchFor(CHAT_B)).toMatchObject({ own: true, enabled: true, mode: 'loop', afterTurn: true });

    const recorded = await recordChatObservations(CHAT_B, [
      { kind: 'turn_start', time: 10, turnId: 'successor-loop-turn' },
      { kind: 'assistant_message', time: 11, turnId: 'successor-loop-turn', messageId: 'successor-loop-final',
        text: 'Finished the successor milestone.', state: 'final', final: true, goalEligible: true },
      { kind: 'turn_end', time: 12, turnId: 'successor-loop-turn', outcome: 'completed' }
    ]);
    expect(recorded.sessionId).toBe(sessionId);
    expect(recorded.goalCandidates).toEqual([
      expect.objectContaining({ replyId: 'successor-loop-final', turnId: 'successor-loop-turn' })
    ]);

    await acceptGoalReplyNow({
      conversationId: CHAT_B,
      sessionId,
      ...recorded.goalCandidates[0]!,
      blocked: false
    });
    expect(goalPendingReplyFor(CHAT_A)).toBeNull();
    expect(goalPendingReplyFor(CHAT_B)).toMatchObject({
      replyId: 'successor-loop-final',
      turnId: 'successor-loop-turn'
    });
  });

  it('refuses a chat B that is not a distinct conversation', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    expect(await commitContinuation(token, '')).toBe(false);
    expect(await commitContinuation(token, CHAT_A)).toBe(false);
    expect(await attachedChat(sessionId)).toBe(CHAT_A);
  });

  it('leaves the session in chat A when the durable write fails, and stays retryable', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');
    const committedHandoffId = continuationForSession(sessionId)?.handoffId;
    const spy = vi.spyOn(store, 'rebindSession').mockResolvedValueOnce(false);

    expect(await commitContinuation(token, CHAT_B)).toBe(false);
    expect(await attachedChat(sessionId)).toBe(CHAT_A);
    expect((await getSession(sessionId))?.lastCommittedResumeHandoffId).toBeNull();
    expect(continuationForSession(sessionId)?.state).toBe('claimed');
    expect(workspaceEntries()).toEqual([]);

    spy.mockRestore();
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
    expect((await getSession(sessionId))?.lastCommittedResumeHandoffId).toBe(committedHandoffId);
  });

  it('treats a repeated ack as the commit that already landed', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect((await getSession(sessionId))?.chatIds).toEqual([CHAT_A, CHAT_B]);
  });

  it('hands an armed replacement dispatch back on proof that nothing left the page, never once sent', async () => {
    // 2026-09-02: the brief landed in the replacement chat and the user's Escape emptied the
    // composer in the same instant. The armed dispatch then sat for its six hours.
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(false);

    expect(await releaseContinuationDestinationSendNow(token)).toBe(true);
    expect(continuationByToken(token)).toMatchObject({
      state: 'awaiting-chat',
      destinationSend: { state: 'not-attempted' }
    });
    // A fresh command claims what the retired one held; the release is what makes that legal.
    expect(await claimContinuationNow(token, 'cmd-2')).not.toBeNull();
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'resume-message-b')).toBe(true);
    // Sent is past the point of no return: the marked message or a cancel ends it, not a page.
    expect(await releaseContinuationDestinationSendNow(token)).toBe(false);
    expect(continuationByToken(token)?.destinationSend.state).toBe('sent');
    expect(await releaseContinuationDestinationSendNow('0000000000000000000000000000dead')).toBe(false);
  });

  it.each(['unattempted', 'attempted', 'dispatched', 'sent'])('command retirement only releases its own pre-Send claim (%s)', async state => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'old-command');
    expect(await releaseContinuationDestinationSendNow(token, 'foreign-command')).toBe(false);
    if (state !== 'unattempted') await beginContinuationDestinationSendNow(token);
    if (state === 'dispatched' || state === 'sent') await dispatchContinuationDestinationSendNow(token);
    if (state === 'sent') await bindContinuationDestinationMessageNow(token, CHAT_B, 'exact-resume-message');
    const before = snapshotContinuations();
    const releasable = state === 'unattempted' || state === 'attempted';
    expect(await releaseContinuationDestinationSendNow(token, 'old-command')).toBe(releasable);
    if (releasable) {
      expect(await claimContinuationNow(token, 'new-command')).not.toBeNull();
      expect(await releaseContinuationDestinationSendNow(token, 'old-command')).toBe(false);
      expect(snapshotContinuations().entries.find(row => row.token === token)?.claimedBy).toBe('new-command');
    } else expect(snapshotContinuations().entries).toEqual(before.entries);
  });

  it('retains the old claimant when retiring its claim cannot be saved', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'old-command');
    const durable = await import('../src/main/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));
    await expect(releaseContinuationDestinationSendNow(token, 'old-command')).rejects.toThrow('disk full');
    expect(snapshotContinuations().entries.find(row => row.token === token)?.claimedBy).toBe('old-command');
    expect(await claimContinuationNow(token, 'new-command')).toBeNull();
  });

  it('re-proves the exact destination message after the continuation already committed', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'resume-message-b')).toBe(true);
    expect(await commitContinuation(token, CHAT_B)).toBe(true);

    // A reloaded replacement document has lost its page-local proof, but the WAL still names
    // the exact message that committed B. Reading that exact tuple back is safe and idempotent;
    // any other chat or message remains a contradiction.
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'resume-message-b')).toBe(true);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_C, 'resume-message-b')).toBe(false);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'other-message')).toBe(false);
  });

  it('records the exact late destination message after the native command ACK committed first', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'ack-first-owner');
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    const committed = snapshotContinuations().entries.find(entry => entry.token === token)!;
    expect(committed.destinationSend).toEqual({ state: 'dispatched-unresolved', conversationId: null, messageId: null });

    // The authenticated observer has now found the exact server-authored marker/native id.
    // This records receipt custody only; it must not reopen a command or move the session.
    expect(await bindContinuationDestinationMessageNow(token, CHAT_A, 'native-bootstrap-b')).toBe(false);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_C, 'native-bootstrap-b')).toBe(false);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'native-bootstrap-b')).toBe(true);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'native-bootstrap-b')).toBe(true);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'conflicting-native-id')).toBe(false);
    const after = snapshotContinuations().entries.find(entry => entry.token === token)!;
    expect(after).toEqual({ ...committed, touchedAt: after.touchedAt,
      destinationSend: { state: 'sent', conversationId: CHAT_B, messageId: 'native-bootstrap-b' } });
    expect((await getSession(sessionId))?.chatIds).toEqual([CHAT_A, CHAT_B]);
    expect(await beginContinuationDestinationSendNow(token)).toBeNull();
    expect(await releaseContinuationDestinationSendNow(token)).toBe(false);
  });

  it('catches up the exact canonical Resume question after ACK-first commit and an assistant-only frame', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'canonical-ack-first-owner');
    await beginContinuationDestinationSendNow(token);
    await dispatchContinuationDestinationSendNow(token);
    await commitContinuation(token, CHAT_B);
    const handoff = await store.readHandoff(sessionId, snapshotContinuations().entries[0]!.handoffId!);
    const messageId = 'aa130001-1111-4111-8111-000000000001';
    await recordChatObservations(CHAT_B, [{ kind: 'user_message', messageId,
      textOrigin: 'provider', text: resumeBootstrapText(handoff!.text, token), time: Date.now() }]);
    // The exact native user was recorded, then the source retirement receipt landed. The
    // current document can legitimately expose only its assistant, not repeat the user row.
    await acknowledgeSupersededSourceRetirementNow(CHAT_A, '13131313131313131313131313131313');
    await recordChatObservations(CHAT_B, [{ kind: 'assistant_message',
      messageId: 'aa130002-1111-4111-8111-000000000002', providerMessageId: 'aa130002-1111-4111-8111-000000000002',
      text: 'The actual resumed answer.', state: 'final', final: true, time: Date.now() }]);
    expect(snapshotContinuations().entries.find(entry => entry.token === token)?.destinationSend).toEqual({
      state: 'sent', conversationId: CHAT_B, messageId
    });
    expect((await getSession(sessionId))?.conversationId).toBe(CHAT_B);
    expect(goalPendingReplyFor(CHAT_B)).toBeNull();
    expect(await beginContinuationDestinationSendNow(token)).toBeNull();
  });

  it.each(['saved-history', 'extra-prefix', 'changed-history', 'foreign-leading-marker'] as const)(
    'reconciles only the exact committed bootstrap when its saved brief contains historical Resume markers (%s)', async mode => {
      const history = '\n\nHistorical receipt references: [[CLF-RESUME:older_native_receipt_01]] and ' +
        '[[CLF-RESUME:older_native_receipt_02]]. Preserve these original facts.';
      const { sessionId, token } = await readyContinuation(SAMPLE_BRIEF + history);
      await claimContinuationNow(token, 'historical-marker-receipt-owner');
      await beginContinuationDestinationSendNow(token);
      await dispatchContinuationDestinationSendNow(token);
      await commitContinuation(token, CHAT_B);
      const committed = snapshotContinuations().entries.find(entry => entry.token === token)!;
      const handoff = await store.readHandoff(sessionId, committed.handoffId!);
      let text = resumeBootstrapText(handoff!.text, token);
      if (mode === 'extra-prefix') text = `[[CLF-RESUME:${token}]]\n\n${text}`;
      if (mode === 'changed-history') text = text.replace('older_native_receipt_02', 'unproved_native_receipt');
      if (mode === 'foreign-leading-marker') text = text.replace(`[[CLF-RESUME:${token}]]`, '[[CLF-RESUME:foreign_native_receipt]]');
      const messageId = 'aa130009-1111-4111-8111-000000000009';
      await recordChatObservations(CHAT_B, [{ kind: 'user_message', messageId,
        textOrigin: 'provider', text, time: Date.now() }]);
      await acknowledgeSupersededSourceRetirementNow(CHAT_A, '17171717171717171717171717171717');
      await recordChatObservations(CHAT_B, [{ kind: 'assistant_message',
        messageId: 'aa130010-1111-4111-8111-000000000010', text: 'Continued the saved original project.',
        state: 'final', final: true, time: Date.now() }]);
      const after = snapshotContinuations().entries.find(entry => entry.token === token)!;
      expect(after.destinationSend).toEqual(mode === 'saved-history'
        ? { state: 'sent', conversationId: CHAT_B, messageId }
        : { state: 'dispatched-unresolved', conversationId: null, messageId: null });
      expect((await getSession(sessionId))?.conversationId).toBe(CHAT_B);
      expect((await store.readLatestUserMessage(sessionId))?.message.text).toBe(text);
      expect(await beginContinuationDestinationSendNow(token)).toBeNull();
      expect(await releaseContinuationDestinationSendNow(token)).toBe(false);
    }
  );

  it('catches up an exact provider-escaped Resume token without authorizing a second Send', async () => {
    const random = vi.mocked(crypto.randomBytes).mockReturnValueOnce(Buffer.alloc(16, 255) as never);
    try {
      const { sessionId, token } = await readyContinuation();
      expect(token).toContain('_');
      await claimContinuationNow(token, 'escaped-token-native-owner');
      await beginContinuationDestinationSendNow(token);
      await dispatchContinuationDestinationSendNow(token);
      await commitContinuation(token, CHAT_B);
      const handoff = await store.readHandoff(sessionId, snapshotContinuations().entries[0]!.handoffId!);
      const messageId = 'aa130007-1111-4111-8111-000000000007';
      const encoded = resumeBootstrapText(handoff!.text).replace(/([\\`*_#<>.\-])/g, '\\$1').replace(/\n/g, '\\\n');
      const escapedToken = token.replace(/([_-])/g, '\\$1');
      const text = '[$core](app://asdk_app_exact)\n' + `[[CLF-RESUME:${escapedToken}]]\\\n\\\n${encoded}`;
      await recordChatObservations(CHAT_B, [{ kind: 'user_message', messageId, textOrigin: 'provider', text, time: Date.now() }]);
      await acknowledgeSupersededSourceRetirementNow(CHAT_A, '16161616161616161616161616161616');
      await recordChatObservations(CHAT_B, [{ kind: 'assistant_message', messageId: 'aa130008-1111-4111-8111-000000000008',
        text: 'The resumed native answer.', state: 'final', final: true, time: Date.now() }]);
      expect(snapshotContinuations().entries.find(entry => entry.token === token)?.destinationSend)
        .toEqual({ state: 'sent', conversationId: CHAT_B, messageId });
      const receipt = await (await import('../src/main/session/continuation.js')).committedResumeNativeReceipt(
        sessionId, CHAT_B, messageId, text);
      expect(receipt?.token).toBe(token);
      expect(await beginContinuationDestinationSendNow(token)).toBeNull();
      expect(await releaseContinuationDestinationSendNow(token)).toBe(false);
      expect(goalPendingReplyFor(CHAT_B)).toBeNull();
    } finally { random.mockReset().mockImplementation((await vi.importActual<typeof import('node:crypto')>('node:crypto')).randomBytes); }
  });

  it.each(['provider serialization', 'provider escaped equals', 'restart', 'duplicate journal'] as const)(
    'catches up canonical Resume receipt custody without replay (%s)', async mode => {
      const summaryText = mode === 'provider escaped equals'
        ? `${SAMPLE_BRIEF}\n\nRECEIPT CHECK — expected=current.`
        : SAMPLE_BRIEF;
      const { sessionId, token } = await readyContinuation(summaryText);
      await claimContinuationNow(token, 'canonical-retained-owner');
      await beginContinuationDestinationSendNow(token);
      await dispatchContinuationDestinationSendNow(token);
      await commitContinuation(token, CHAT_B);
      const handoff = await store.readHandoff(sessionId, snapshotContinuations().entries[0]!.handoffId!);
      const messageId = 'aa130003-1111-4111-8111-000000000003';
      const providerSerialization = mode === 'provider serialization' || mode === 'provider escaped equals';
      let text = resumeBootstrapText(handoff!.text, token);
      if (providerSerialization) {
        let serialized = resumeBootstrapText(handoff!.text)
          .replace(/([\\`*_#<>.\-])/g, '\\$1').replace(/\n/g, '\\\n');
        if (mode === 'provider escaped equals') serialized = serialized.replace(/=/g, '\\=');
        text = '[$fern-windows-core](app://asdk_app_6ab32f2e0ab48191a04696c05459f90c)\n' +
          `[[CLF-RESUME:${token}]]\\\n\\\n${serialized}`;
      }
      await recordChatObservations(CHAT_B, [{ kind: 'user_message', messageId,
        textOrigin: 'provider', text, time: Date.now() }]);
      await acknowledgeSupersededSourceRetirementNow(CHAT_A, '14141414141414141414141414141414');
      if (mode === 'restart') {
        const saved = snapshotContinuations();
        resetContinuationsForTests();
        resetRecorderForTests();
        await restoreContinuations(saved);
      }
      const final = { kind: 'assistant_message' as const, messageId: 'aa130004-1111-4111-8111-000000000004',
        providerMessageId: 'aa130004-1111-4111-8111-000000000004', text: 'An actual completed answer.',
        state: 'final' as const, final: true, time: Date.now() };
      await recordChatObservations(CHAT_B, [final]);
      const first = snapshotContinuations();
      await recordChatObservations(CHAT_B, [final]);
      expect(snapshotContinuations().entries).toEqual(first.entries);
      expect(first.entries.find(entry => entry.token === token)).toMatchObject({ state: 'committed', summary: '',
        sourceClosed: true, destinationSend: { state: 'sent', conversationId: CHAT_B, messageId } });
      expect(goalPendingReplyFor(CHAT_B)).toBeNull();
      expect(await store.readEvents(sessionId, { kinds: ['turn_start', 'turn_end'] })).toHaveLength(0);
      expect(await beginContinuationDestinationSendNow(token)).toBeNull();
      expect(await releaseContinuationDestinationSendNow(token)).toBe(false);
    }
  );

  it.each(['unknown origin', 'rendered origin', 'app-authored row', 'invalid native id', 'truncated', 'attached draft',
    'before opening', 'marker only', 'partial',
    'duplicate marker', 'duplicate Core', 'foreign token', 'body correction', 'newer user', 'same-id edit',
    'source not retired', 'aborted', 'missing claimant', 'not dispatched', 'conflicting destination',
    'conflicting native id', 'foreign source', 'foreign handoff', 'superseded route', 'superseded handoff',
    'next handoff', 'other conversation'] as const)(
    'refuses canonical Resume receipt catch-up without exact current ownership (%s)', async reason => {
      const { sessionId, token } = await readyContinuation();
      await claimContinuationNow(token, 'canonical-negative-owner');
      await beginContinuationDestinationSendNow(token);
      await dispatchContinuationDestinationSendNow(token);
      await commitContinuation(token, CHAT_B);
      const handoff = await store.readHandoff(sessionId, snapshotContinuations().entries[0]!.handoffId!);
      const messageId = reason === 'invalid native id' ? 'not-native' : 'aa130005-1111-4111-8111-000000000005';
      let text = resumeBootstrapText(handoff!.text, token);
      if (reason === 'marker only') text = `[[CLF-RESUME:${token}]]\n`;
      if (reason === 'partial') text = text.slice(0, -12);
      if (reason === 'duplicate marker') text += `\n[[CLF-RESUME:${token}]]`;
      if (reason === 'duplicate Core') text = '[$core](app://asdk_app_exact)\n[$core](app://asdk_app_exact)\n' + text;
      if (reason === 'foreign token') text = text.replace(token, 'foreign_0123456789abcdef');
      if (reason === 'body correction') text += '\nThis changes the actual request.';
      await recordChatObservations(CHAT_B, [{ kind: 'user_message', messageId, text,
        ...(reason === 'unknown origin' ? {} : { textOrigin: reason === 'rendered origin' ? 'rendered' as const : 'provider' as const }),
        time: Date.now() }]);
      if (reason === 'truncated') {
        await store.upsertMessageEvent(sessionId, { kind: 'user_message', source: 'extension', time: Date.now(),
          messageId, textOrigin: 'provider', message: { text, truncated: true, chars: text.length } });
      }
      if (reason === 'app-authored row' || reason === 'attached draft' || reason === 'before opening') {
        await store.upsertMessageEvent(sessionId, { kind: 'user_message',
          source: reason === 'app-authored row' ? 'app' : 'extension',
          time: reason === 'before opening' ? snapshotContinuations().entries[0]!.openedAt - 1 : Date.now(),
          messageId, textOrigin: 'provider', message: { text, truncated: false, chars: text.length },
          ...(reason === 'attached draft' ? { attachments: [{ id: 'separate-draft', name: 'different-input.txt',
            size: 17, mimeType: 'text/plain' }] } : {})
        }, { preferTime: true });
      }
      if (reason === 'newer user' || reason === 'same-id edit') {
        await recordChatObservations(CHAT_B, [{ kind: 'user_message',
          messageId: reason === 'same-id edit' ? messageId : 'aa130006-1111-4111-8111-000000000006',
          textOrigin: 'provider', text: 'A genuine newer correction.', time: Date.now() }]);
      }
      if (reason !== 'source not retired') {
        await acknowledgeSupersededSourceRetirementNow(CHAT_A, '15151515151515151515151515151515');
      }
      if (reason === 'superseded route') await store.rebindSession(sessionId, CHAT_B, CHAT_C);
      if (reason === 'superseded handoff') await store.ensureCommittedResumeHandoff(sessionId, CHAT_B, 'other-handoff');
      if (reason === 'next handoff') await openContinuationNow(sessionId, CHAT_B);
      const saved = snapshotContinuations();
      const row = saved.entries.find(entry => entry.token === token)!;
      if (reason === 'aborted') row.state = 'aborted';
      if (reason === 'missing claimant') row.claimedBy = null;
      if (reason === 'not dispatched') row.destinationSend!.state = 'attempted-unresolved';
      if (reason === 'conflicting destination') row.destinationSend!.conversationId = CHAT_C;
      if (reason === 'conflicting native id') row.destinationSend!.messageId = 'aa130007-1111-4111-8111-000000000007';
      if (reason === 'foreign source') row.from = CHAT_C;
      if (reason === 'foreign handoff') row.handoffId = 'foreign-handoff';
      resetContinuationsForTests();
      await restoreContinuations(saved);
      const before = snapshotContinuations();
      await recordChatObservations(reason === 'other conversation' ? CHAT_C : CHAT_B, [{ kind: 'assistant_message',
        messageId: 'aa130008-1111-4111-8111-000000000008', text: 'Final-looking text does not grant a receipt.',
        state: 'final', final: true, time: Date.now() }]);
      expect(snapshotContinuations().entries).toEqual(before.entries);
      expect(snapshotContinuations().entries.find(entry => entry.token === token)?.destinationSend?.state).not.toBe('sent');
      expect(goalPendingReplyFor(CHAT_B)).toBeNull();
    }
  );

  it('keeps the canonical receipt retryable when its WAL write fails', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'canonical-write-owner');
    await beginContinuationDestinationSendNow(token);
    await dispatchContinuationDestinationSendNow(token);
    await commitContinuation(token, CHAT_B);
    const handoff = await store.readHandoff(sessionId, snapshotContinuations().entries[0]!.handoffId!);
    const messageId = 'aa130009-1111-4111-8111-000000000009';
    await recordChatObservations(CHAT_B, [{ kind: 'user_message', messageId, textOrigin: 'provider',
      text: resumeBootstrapText(handoff!.text, token), time: Date.now() }]);
    await acknowledgeSupersededSourceRetirementNow(CHAT_A, '16161616161616161616161616161616');
    const durable = await import('../src/main/durable.js');
    const write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('receipt write failed'));
    const observation = { kind: 'assistant_message' as const, messageId: 'aa130010-1111-4111-8111-000000000010',
      text: 'Completed native answer.', state: 'final' as const, final: true, time: Date.now() };
    await expect(recordChatObservations(CHAT_B, [observation])).rejects.toThrow('receipt write failed');
    expect(snapshotContinuations().entries.find(entry => entry.token === token)?.destinationSend?.state).toBe('dispatched-unresolved');
    write.mockRestore();
    await recordChatObservations(CHAT_B, [observation]);
    expect(snapshotContinuations().entries.find(entry => entry.token === token)?.destinationSend).toEqual({
      state: 'sent', conversationId: CHAT_B, messageId
    });
    expect(await store.readEvents(sessionId, { kinds: ['assistant_message'] })).toHaveLength(1);
  });

  it.each(['newer question', 'same-id edit', 'superseded route', 'superseded handoff', 'next generation'] as const)(
    'reproves canonical Resume ownership after awaiting the handoff (%s)', async mutation => {
      const { sessionId, token } = await readyContinuation();
      await claimContinuationNow(token, 'canonical-race-owner');
      await beginContinuationDestinationSendNow(token);
      await dispatchContinuationDestinationSendNow(token);
      await commitContinuation(token, CHAT_B);
      const handoff = await store.readHandoff(sessionId, snapshotContinuations().entries[0]!.handoffId!);
      const messageId = 'aa130011-1111-4111-8111-000000000011';
      await recordChatObservations(CHAT_B, [{ kind: 'user_message', messageId, textOrigin: 'provider',
        text: resumeBootstrapText(handoff!.text, token), time: Date.now() }]);
      await acknowledgeSupersededSourceRetirementNow(CHAT_A, '17171717171717171717171717171717');
      const read = store.readHandoff;
      vi.spyOn(store, 'readHandoff').mockImplementationOnce(async (...args) => {
        const answer = await read(...args);
        if (mutation === 'newer question' || mutation === 'same-id edit') {
          await store.upsertMessageEvent(sessionId, { kind: 'user_message', source: 'extension', time: Date.now(),
            messageId: mutation === 'same-id edit' ? messageId : 'aa130012-1111-4111-8111-000000000012',
            textOrigin: 'provider', message: { text: 'Changed while the handoff read awaited.', truncated: false,
              chars: 'Changed while the handoff read awaited.'.length } });
        }
        if (mutation === 'superseded route') await store.rebindSession(sessionId, CHAT_B, CHAT_C);
        if (mutation === 'superseded handoff') await store.ensureCommittedResumeHandoff(sessionId, CHAT_B, 'next-handoff');
        if (mutation === 'next generation') await openContinuationNow(sessionId, CHAT_B);
        return answer;
      });
      await recordChatObservations(CHAT_B, [{ kind: 'assistant_message',
        messageId: 'aa130013-1111-4111-8111-000000000013', text: 'The old completed answer.', state: 'final', final: true,
        time: Date.now() }]);
      expect(snapshotContinuations().entries.find(entry => entry.token === token)?.destinationSend?.state).toBe('dispatched-unresolved');
    }
  );

  it.each(['live sweep', 'restart'] as const)(
    'retains unresolved committed native-receipt custody after source close and 20 minutes (%s)', async recovery => {
      vi.useFakeTimers();
      const { sessionId, token } = await readyContinuation();
      await claimContinuationNow(token, 'closed-source-receipt-owner');
      await beginContinuationDestinationSendNow(token);
      await dispatchContinuationDestinationSendNow(token);
      expect(await commitContinuation(token, CHAT_B)).toBe(true);
      expect(await acknowledgeSupersededSourceRetirementNow(CHAT_A, '33333333333333333333333333333333')).toBe('spent');
      const saved = snapshotContinuations();
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS * 3);
      if (recovery === 'restart') {
        resetContinuationsForTests();
        await restoreContinuations(saved);
      }

      expect(continuationByToken(token)?.state).toBe('committed');
      const retained = snapshotContinuations().entries.find(entry => entry.token === token)!;
      expect(retained).toMatchObject({ sourceClosed: true, summary: '',
        destinationSend: { state: 'dispatched-unresolved', conversationId: null, messageId: null } });
      expect(retained).not.toHaveProperty('destinationReceiptRetention');
      expect(await claimContinuationNow(token, 'replacement-owner')).toBeNull();
      expect(await beginContinuationDestinationSendNow(token)).toBeNull();
      expect(await bindContinuationDestinationMessageNow(token, CHAT_C, 'foreign-native-id')).toBe(false);
      expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'late-native-id')).toBe(true);
      expect((await getSession(sessionId))?.conversationId).toBe(CHAT_B);
      expect(snapshotContinuations().entries.find(entry => entry.token === token)?.destinationSend).toEqual({
        state: 'sent', conversationId: CHAT_B, messageId: 'late-native-id'
      });
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS * 2 + 1);
      expect(continuationByToken(token)?.destinationSend.state).toBe('sent');
    }
  );

  it.each(['aborted', 'superseded', 'missing', 'conflicting destination', 'conflicting handoff', 'conflicting source', 'conflicting token', 'not dispatched'] as const)(
    'keeps ordinary terminal age bounds for resolved or noncurrent native receipts (%s)', async reason => {
      vi.useFakeTimers();
      const { sessionId, token } = await readyContinuation();
      await claimContinuationNow(token, 'terminal-receipt-owner');
      await beginContinuationDestinationSendNow(token);
      await dispatchContinuationDestinationSendNow(token);
      expect(await commitContinuation(token, CHAT_B)).toBe(true);
      await acknowledgeSupersededSourceRetirementNow(CHAT_A, '44444444444444444444444444444444');
      if (reason === 'superseded') await store.rebindSession(sessionId, CHAT_B, CHAT_C);
      if (reason === 'missing') await store.deleteSession(sessionId);
      const saved = snapshotContinuations();
      if (reason === 'aborted') saved.entries[0]!.state = 'aborted';
      if (reason === 'conflicting destination') saved.entries[0]!.destinationSend!.conversationId = CHAT_C;
      if (reason === 'conflicting handoff') saved.entries[0]!.handoffId = 'different-handoff-id';
      if (reason === 'conflicting source') saved.entries[0]!.from = CHAT_C;
      if (reason === 'conflicting token') saved.entries[0]!.token = 'different-receipt-token';
      if (reason === 'not dispatched') saved.entries[0]!.destinationSend!.state = 'attempted-unresolved';
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS * 3);
      resetContinuationsForTests();
      await restoreContinuations(saved);
      expect(continuationByToken(token)).toBeNull();
      expect(snapshotContinuations().entries).toHaveLength(0);
      expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'invented-native-id')).toBe(false);
    }
  );

  it.each(['current', 'superseded', 'missing', 'wrong-message'] as const)(
    'retains only the exact current Sent Resume capability beyond terminal age and row cap (%s)', async state => {
      vi.useFakeTimers();
      const { sessionId, token } = await readyContinuation();
      await claimContinuationNow(token, 'sent-receipt-cap-owner');
      await beginContinuationDestinationSendNow(token);
      await dispatchContinuationDestinationSendNow(token);
      await bindContinuationDestinationMessageNow(token, CHAT_B, 'aa120003-1111-4111-8111-000000000003');
      await commitContinuation(token, CHAT_B);
      await acknowledgeSupersededSourceRetirementNow(CHAT_A, '88888888888888888888888888888888');
      const saved = snapshotContinuations();
      const handoff = await store.readHandoff(sessionId, saved.entries[0]!.handoffId!);
      const text = (await import('../src/main/session/handoff.js')).resumeBootstrapText(handoff!.text, token);
      if (state === 'superseded') await store.rebindSession(sessionId, CHAT_B, CHAT_C);
      if (state === 'missing') await store.deleteSession(sessionId);
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS * 3);
      const now = Date.now();
      const noise = Array.from({ length: 40 }, (_, index) => ({ ...saved.entries[0]!,
        token: `settled-noise-${String(index).padStart(4, '0')}`, state: 'aborted' as const,
        openedAt: now - index, touchedAt: now - index }));
      resetContinuationsForTests();
      await restoreContinuations({ ...saved, entries: [...noise, ...saved.entries] });
      const proof = await (await import('../src/main/session/continuation.js')).committedResumeNativeReceipt(
        sessionId, CHAT_B, state === 'wrong-message' ? 'aa120004-1111-4111-8111-000000000004' :
          'aa120003-1111-4111-8111-000000000003', text);
      expect(proof !== null).toBe(state === 'current');
      if (state === 'current') {
        expect(continuationByToken(token)?.destinationSend.state).toBe('sent');
        expect(await beginContinuationDestinationSendNow(token)).toBeNull();
        expect(await releaseContinuationDestinationSendNow(token)).toBe(false);
      }
    }
  );

  it.each(['valid', 'marker-only', 'partial', 'foreign-token', 'wrong-message', 'wrong-session',
    'wrong-destination', 'unretired', 'not-sent', 'foreign-source', 'duplicate-Core', 'duplicate-marker',
    'conflicting-body', 'newer-user-body', 'missing-backslash'] as const)(
    'admits only the exact provider-serialized committed Resume native receipt (%s)', async state => {
      const session = await createSession({ title: 'serialized resume', conversationId: CHAT_A });
      const opened = await openContinuationNow(session.id, CHAT_A);
      await attachSummary(opened.token, SAMPLE_BRIEF + '\n# Exact files\n- Keep  two spaces and C:\\Users\\ExampleUser\\notes.\n' +
        '```text\n\\literal *code* and &#x20; stay authored\n```');
      const { token } = opened;
      const messageId = 'aa120015-1111-4111-8111-000000000015';
      await claimContinuationNow(token, 'serialized-native-owner');
      await beginContinuationDestinationSendNow(token);
      await dispatchContinuationDestinationSendNow(token);
      if (state !== 'not-sent') await bindContinuationDestinationMessageNow(token, CHAT_B, messageId);
      await commitContinuation(token, CHAT_B);
      if (state !== 'unretired') await acknowledgeSupersededSourceRetirementNow(CHAT_A, '12345678123456781234567812345678');
      const handoff = await store.readHandoff(session.id, snapshotContinuations().entries[0]!.handoffId!);
      const core = '[$fern-windows-core](app://asdk_app_6ab32f2e0ab48191a04696c05459f90c)';
      expect(core).toHaveLength(69);
      const encoded = resumeBootstrapText(handoff!.text).replace(/([\\`*_#<>.\-])/g, '\\$1')
        .replace(/\n/g, '\\\n').replace('Keep  two', 'Keep &#x20;two');
      let text = `${core}\n[[CLF-RESUME:${token}]]\\\n\\\n${encoded}`;
      if (state === 'marker-only') text = `${core}\n[[CLF-RESUME:${token}]]\\\n\\\n`;
      if (state === 'partial') text = text.slice(0, -20);
      if (state === 'foreign-token') text = text.replace(token, 'foreign_0123456789abcdef');
      if (state === 'duplicate-Core') text = `${core}\n${text}`;
      if (state === 'duplicate-marker') text = text.replace(encoded, `[[CLF-RESUME:${token}]]\\\n\\\n${encoded}`);
      if (state === 'conflicting-body') text = text.replace('Exact files', 'Different task');
      if (state === 'newer-user-body') text += '\\\nA newer human correction supersedes this brief.';
      if (state === 'missing-backslash') text = text.replace('\\\\literal', 'literal');
      if (state === 'foreign-source') {
        const saved = snapshotContinuations();
        saved.entries[0]!.from = CHAT_C;
        resetContinuationsForTests();
        await restoreContinuations(saved);
      }
      const proof = await (await import('../src/main/session/continuation.js')).committedResumeNativeReceipt(
        state === 'wrong-session' ? 'different-session' : session.id,
        state === 'wrong-destination' ? CHAT_C : CHAT_B,
        state === 'wrong-message' ? 'aa120016-1111-4111-8111-000000000016' : messageId, text);
      expect(proof !== null).toBe(state === 'valid');
    }
  );

  it('restores exact unresolved native-receipt debt outside the resolved terminal row cap', async () => {
    vi.useFakeTimers();
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'receipt-cap-owner');
    await beginContinuationDestinationSendNow(token);
    await dispatchContinuationDestinationSendNow(token);
    await commitContinuation(token, CHAT_B);
    await acknowledgeSupersededSourceRetirementNow(CHAT_A, '55555555555555555555555555555555');
    const pending = snapshotContinuations().entries[0]!;
    vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS * 3);
    const now = Date.now();
    const resolvedNoise = Array.from({ length: 40 }, (_, index) => ({ ...pending,
      token: `resolved-native-${String(index).padStart(2, '0')}`,
      openedAt: now - index, touchedAt: now - index, state: 'aborted' as const
    }));
    resetContinuationsForTests();
    await restoreContinuations({ version: 1, savedAt: now, entries: [pending, ...resolvedNoise] });
    expect(continuationByToken(token)?.state).toBe('committed');
    expect(snapshotContinuations().entries).toHaveLength(33);
    expect(continuationByToken('resolved-native-00')?.state).toBe('aborted');
    expect(continuationByToken('resolved-native-39')).toBeNull();
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'cap-late-native-id')).toBe(true);
  });

  it.each(['superseded', 'superseded handoff', 'conflicting source'] as const)(
    'lets a young noncurrent native receipt age normally after restore (%s)', async reason => {
      vi.useFakeTimers();
      const { sessionId, token } = await readyContinuation();
      await claimContinuationNow(token, 'young-terminal-owner');
      await beginContinuationDestinationSendNow(token);
      await dispatchContinuationDestinationSendNow(token);
      await commitContinuation(token, CHAT_B);
      await acknowledgeSupersededSourceRetirementNow(CHAT_A, '77777777777777777777777777777777');
      if (reason === 'superseded') await store.rebindSession(sessionId, CHAT_B, CHAT_C);
      if (reason === 'superseded handoff') await store.ensureCommittedResumeHandoff(sessionId, CHAT_B, 'different-handoff-id');
      const saved = snapshotContinuations();
      if (reason === 'conflicting source') saved.entries[0]!.from = CHAT_C;
      vi.setSystemTime(Date.now() + 60_000);
      resetContinuationsForTests();
      await restoreContinuations(saved);
      expect(continuationByToken(token)?.state).toBe('committed');
      if (reason === 'superseded handoff') expect((await getSession(sessionId))?.lastCommittedResumeHandoffId).toBe('different-handoff-id');
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS * 3);
      expect(continuationByToken(token)).toBeNull();
    }
  );

  it('ages a closed unresolved receipt normally after the same session commits its next handoff', async () => {
    vi.useFakeTimers();
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'first-live-receipt-owner');
    await beginContinuationDestinationSendNow(token);
    await dispatchContinuationDestinationSendNow(token);
    await commitContinuation(token, CHAT_B);
    await acknowledgeSupersededSourceRetirementNow(CHAT_A, '99999999999999999999999999999999');
    vi.setSystemTime(Date.now() + 60_000);
    const next = await openContinuationNow(sessionId, CHAT_B);
    await attachSummary(next.token, SAMPLE_BRIEF);
    await claimContinuationNow(next.token, 'second-live-receipt-owner');
    await beginContinuationDestinationSendNow(next.token);
    await dispatchContinuationDestinationSendNow(next.token);
    expect(await commitContinuation(next.token, CHAT_C)).toBe(true);
    await acknowledgeSupersededSourceRetirementNow(CHAT_B, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS * 3);
    expect(continuationByToken(token)).toBeNull();
    expect(continuationByToken(next.token)?.state).toBe('committed');
    expect(await bindContinuationDestinationMessageNow(next.token, CHAT_C, 'second-live-native-id')).toBe(true);
  });

  it('preserves metadata-only native-receipt custody while its current session is temporarily unreadable', async () => {
    vi.useFakeTimers();
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'unreadable-receipt-owner');
    await beginContinuationDestinationSendNow(token);
    await dispatchContinuationDestinationSendNow(token);
    await commitContinuation(token, CHAT_B);
    await acknowledgeSupersededSourceRetirementNow(CHAT_A, '66666666666666666666666666666666');
    const saved = snapshotContinuations();
    vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS * 3);
    const unreadable = vi.spyOn(store, 'getSession').mockRejectedValue(new Error('temporary metadata read failure'));
    resetContinuationsForTests();
    await restoreContinuations(saved);
    expect(continuationByToken(token)?.state).toBe('committed');
    expect(snapshotContinuations().entries[0]?.summary).toBe('');
    expect(await claimContinuationNow(token, 'replacement-owner')).toBeNull();
    await expect(bindContinuationDestinationMessageNow(token, CHAT_B, 'unproven-unreadable-id'))
      .rejects.toThrow('temporary metadata read failure');
    expect(snapshotContinuations().entries[0]?.destinationSend?.messageId).toBeNull();
    unreadable.mockRestore();
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'readable-native-id')).toBe(true);
  });

  it('restores a committed replay receipt without republishing its private brief', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'private-replay-owner');
    await beginContinuationDestinationSendNow(token);
    await dispatchContinuationDestinationSendNow(token);
    await bindContinuationDestinationMessageNow(token, CHAT_B, 'settled-private-receipt');
    await commitContinuation(token, CHAT_B);
    await acknowledgeSupersededSourceRetirementNow(CHAT_A, '88888888888888888888888888888888');
    const saved = snapshotContinuations();
    saved.entries[0]!.summary = SAMPLE_BRIEF; // A predecessor WAL may still contain the brief.
    resetContinuationsForTests();
    await restoreContinuations(saved);
    expect(continuationByToken(token)?.state).toBe('committed');
    expect(snapshotContinuations().entries[0]?.summary).toBe('');
    expect(await attachSummary(token, SAMPLE_BRIEF)).toBeNull();
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'settled-private-receipt')).toBe(true);
    expect(await beginContinuationDestinationSendNow(token)).toBeNull();
  });

  it.each(['not-attempted', 'attempted-unresolved'] as const)('does not invent a post-commit native Send receipt for %s', async checkpoint => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'unsent-owner');
    if (checkpoint === 'attempted-unresolved') await beginContinuationDestinationSendNow(token);
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    const before = snapshotContinuations();
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'unproven-native-id')).toBe(false);
    expect(snapshotContinuations().entries).toEqual(before.entries);
  });

  it('refuses first receipt adoption for an aborted dispatch or a superseded committed destination', async () => {
    const aborted = await readyContinuation();
    await claimContinuationNow(aborted.token, 'aborted-owner');
    await beginContinuationDestinationSendNow(aborted.token);
    await dispatchContinuationDestinationSendNow(aborted.token);
    expect(abortContinuation(aborted.token, 'explicit cancellation')).toBe(true);
    expect(await bindContinuationDestinationMessageNow(aborted.token, CHAT_B, 'aborted-native-id')).toBe(false);

    const committed = await readyContinuation();
    await claimContinuationNow(committed.token, 'superseded-owner');
    await beginContinuationDestinationSendNow(committed.token);
    await dispatchContinuationDestinationSendNow(committed.token);
    expect(await commitContinuation(committed.token, CHAT_B)).toBe(true);
    expect(await store.rebindSession(committed.sessionId, CHAT_B, CHAT_C)).toBe(true);
    const before = snapshotContinuations();
    expect(await bindContinuationDestinationMessageNow(committed.token, CHAT_B, 'late-old-native-id')).toBe(false);
    expect(await bindContinuationDestinationMessageNow(committed.token, CHAT_C, 'late-old-native-id')).toBe(false);
    expect(snapshotContinuations().entries).toEqual(before.entries);
  });

  it('keeps the unresolved committed receipt intact when its late durable write fails', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'late-write-owner');
    await beginContinuationDestinationSendNow(token);
    await dispatchContinuationDestinationSendNow(token);
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    const before = snapshotContinuations();
    const durable = await import('../src/main/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));
    await expect(bindContinuationDestinationMessageNow(token, CHAT_B, 'native-bootstrap-b')).rejects.toThrow('disk full');
    expect(snapshotContinuations().entries).toEqual(before.entries);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'native-bootstrap-b')).toBe(true);
  });
});

describe('the commit lock', () => {
  /** Runs `body` while the durable write is suspended, then lets the commit finish. */
  async function duringDurableWrite(
    token: string,
    to: string,
    body: () => void | Promise<void>
  ): Promise<boolean> {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.rebindSession;
    vi.spyOn(store, 'rebindSession').mockImplementation(async (...args) => {
      await held;
      return real(...args);
    });
    const commit = commitContinuation(token, to);
    await Promise.resolve();
    await body();
    release();
    return commit;
  }

  it('cannot be aborted once the durable write has started', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    const committed = await duringDurableWrite(token, CHAT_B, () => {
      // An abort here would clear the frozen prime handover under a write that is still
      // going to land — the split this transaction exists to make impossible.
      expect(abortContinuation(token, 'user changed their mind')).toBe(false);
    });

    expect(committed).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });

  it('is not swept away by a lookup that happens to cross the deadline', async () => {
    vi.useFakeTimers();
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    const committed = await duringDurableWrite(token, CHAT_B, () => {
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS + 1_000);
      // Any passing lookup runs the sweep. It must not expire a commit already in flight.
      continuationForSession(sessionId);
    });

    expect(committed).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });
});

describe('the swarm handover', () => {
  const startSwarm = (conversationId: string): void => {
    spawn({ workers: [{ task: 'read the tests' }], caller: { conversationId } });
  };

  it('moves a parked prime worker history to the replacement chat and revives the exact old worker', async () => {
    const summary = await createSession({ title: 'parked reusable workers', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    expect(bindConversation('worker-1', 'worker-history-chat')).toBe(true);
    finishAgent({ conversationId: 'worker-history-chat' }, 'first piece complete');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-history-chat'
    });

    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'replacement-tab');
    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);

    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-history-chat'
    });
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents).toEqual([]);

    sendMessage({ conversationId: CHAT_B }, 'worker-1', 'continue from the exact chat you already know');
    expect(pendingWorkerRevivals()).toEqual([
      expect.objectContaining({ id: 'worker-1', conversationId: 'worker-history-chat' })
    ]);
  });

  it('carries the same Goal and dormant worker history through repeated overnight resumptions', async () => {
    const summary = await createSession({ title: 'overnight chain', conversationId: CHAT_A });
    setGoalObjective(CHAT_A, 'finish every requested release task overnight');
    startSwarm(CHAT_A);
    expect(bindConversation('worker-1', 'worker-overnight-chat')).toBe(true);
    finishAgent({ conversationId: 'worker-overnight-chat' }, 'sleep until the prime needs me again');
    expect(releaseQuiescentRun()).toBe(true);

    const first = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(first.token, SAMPLE_BRIEF);
    await claimContinuationNow(first.token, 'replacement-tab-b');
    expect(await commitContinuation(first.token, CHAT_B)).toBe(true);
    expect(goalObjectiveFor(CHAT_A)).toBe('');
    expect(goalObjectiveFor(CHAT_B)).toBe('finish every requested release task overnight');
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-overnight-chat'
    });

    const second = await openContinuationNow(summary.id, CHAT_B);
    await attachSummary(second.token, SAMPLE_BRIEF);
    await claimContinuationNow(second.token, 'replacement-tab-c');
    expect(await commitContinuation(second.token, CHAT_C)).toBe(true);

    expect(goalObjectiveFor(CHAT_B)).toBe('');
    expect(goalObjectiveFor(CHAT_C)).toBe('finish every requested release task overnight');
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents).toEqual([]);
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents).toEqual([]);
    expect(swarmStateForCaller({ conversationId: CHAT_C }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-overnight-chat'
    });

    sendMessage({ conversationId: CHAT_C }, 'worker-1', 'wake after the second resume');
    expect(pendingWorkerRevivals()).toEqual([
      expect.objectContaining({ id: 'worker-1', conversationId: 'worker-overnight-chat' })
    ]);
  });

  it('repairs parked worker ownership after a crash between durable session move and projection publish', async () => {
    const summary = await createSession({ title: 'parked crash recovery', conversationId: CHAT_A });
    setGoalObjective(CHAT_A, 'keep the recovery objective attached to this work');
    spawn({
      workers: [{ task: 'reusable recovery history' }, { task: 'terminal recovery history' }],
      caller: { conversationId: CHAT_A }
    });
    expect(bindConversation('worker-1', 'worker-recovery-chat')).toBe(true);
    expect(bindConversation('worker-2', 'worker-recovery-terminal')).toBe(true);
    finishAgent({ conversationId: 'worker-recovery-chat' }, 'ready for later reuse');
    noteAgentContextTokens('worker-recovery-terminal', WORKER_CONTEXT_CEILING_TOKENS);
    finishAgent({ conversationId: 'worker-recovery-terminal' }, 'terminal before crash');
    expect(releaseQuiescentRun()).toBe(true);
    const swarmSnapshot = snapshotSwarm()!;

    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'replacement-tab');
    const continuationSnapshot = snapshotContinuations();
    const saved = continuationSnapshot.entries.find((entry) => entry.token === opened.token)!;
    saved.state = 'committing';
    saved.to = CHAT_B;

    // This is the exact crash boundary continuation recovery is designed for: durable session
    // authority already says B, but the in-memory worker ownership projection still says A.
    expect(await store.rebindSession(summary.id, CHAT_A, CHAT_B)).toBe(true);
    expect((await getSession(summary.id))?.lastCommittedResumeHandoffId).toBeNull();
    resetAgentsForTests();
    restoreSwarm(swarmSnapshot);
    resetGoalStateForTests();
    // This suite deliberately uses short synthetic chat ids (`chat-a`/`chat-b`) that the Goal
    // persistence validator would reject as unlike real ChatGPT ids. Goal's own restart test
    // covers durable decode with a valid id; seed the equivalent restored A projection here so
    // this integration test isolates the continuation recovery move A→B.
    setGoalObjective(CHAT_A, 'keep the recovery objective attached to this work');
    resetContinuationsForTests();
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });

    await restoreContinuations(continuationSnapshot);

    expect(await attachedChat(summary.id)).toBe(CHAT_B);
    expect((await getSession(summary.id))?.lastCommittedResumeHandoffId).toBe(saved.handoffId);
    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-recovery-chat'
    });
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-2')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'worker-recovery-terminal'
    });
    expect(goalObjectiveFor(CHAT_A)).toBe('');
    expect(goalObjectiveFor(CHAT_B)).toBe('keep the recovery objective attached to this work');
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents).toEqual([]);
  });

  it('carries the full sleeping and terminal worker history plus Goal through repeated overnight resumes', async () => {
    const summary = await createSession({ title: 'overnight owner chain', conversationId: CHAT_A });
    spawn({
      workers: [{ task: 'reusable history' }, { task: 'terminal history' }],
      caller: { conversationId: CHAT_A }
    });
    expect(bindConversation('worker-1', 'worker-chain-sleeper')).toBe(true);
    expect(bindConversation('worker-2', 'worker-chain-terminal')).toBe(true);
    finishAgent({ conversationId: 'worker-chain-sleeper' }, 'sleep and reuse me later');
    noteAgentContextTokens('worker-chain-terminal', WORKER_CONTEXT_CEILING_TOKENS);
    finishAgent({ conversationId: 'worker-chain-terminal' }, 'this chat is genuinely full');
    expect(releaseQuiescentRun()).toBe(true);
    setGoalObjective(CHAT_A, 'finish the overnight release without losing any requested work');

    const move = async (from: string, to: string, claimant: string): Promise<void> => {
      const opened = await openContinuationNow(summary.id, from);
      await attachSummary(opened.token, SAMPLE_BRIEF);
      await claimContinuationNow(opened.token, claimant);
      expect(await commitContinuation(opened.token, to)).toBe(true);
    };

    await move(CHAT_A, CHAT_B, 'overnight-tab-b');
    expect(goalObjectiveFor(CHAT_A)).toBe('');
    expect(goalObjectiveFor(CHAT_B)).toBe('finish the overnight release without losing any requested work');
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-chain-sleeper'
    });
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-2')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'worker-chain-terminal'
    });

    await move(CHAT_B, CHAT_C, 'overnight-tab-c');
    expect(goalObjectiveFor(CHAT_B)).toBe('');
    expect(goalObjectiveFor(CHAT_C)).toBe('finish the overnight release without losing any requested work');
    const finalHistory = swarmStateForCaller({ conversationId: CHAT_C }).agents;
    expect(finalHistory.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-chain-sleeper'
    });
    expect(finalHistory.find((agent) => agent.id === 'worker-2')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'worker-chain-terminal'
    });
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents).toEqual([]);
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents).toEqual([]);

    // Revival authority follows the owner chain but the worker conversation itself never moves.
    sendMessage({ conversationId: CHAT_C }, 'worker-1', 'resume in the exact old worker chat');
    expect(pendingWorkerRevivals()).toEqual([
      expect.objectContaining({ id: 'worker-1', conversationId: 'worker-chain-sleeper' })
    ]);
    expect(() => sendMessage({ conversationId: CHAT_C }, 'worker-2', 'do not revive terminal history')).toThrow(
      /finished|cannot be messaged|context/i
    );
  });

  it('moves the prime with the session', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'tab-1');

    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);
    expect(primeConversation()).toBe(CHAT_B);
  });

  it('moves a prime run that starts after its continuation opens', async () => {
    vi.useFakeTimers();
    const summary = await createSession({ title: 'late swarm', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);

    // The compaction ticket predates the worker run, so its first beginPrimeTransfer call had
    // no Prime to mark. A later exact Prime of the same source session must still travel with
    // the continuation instead of making the already-sent replacement become a shadow session.
    vi.setSystemTime(Date.now() + 1);
    startSwarm(CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'late-swarm-replacement');

    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);
    expect(await attachedChat(summary.id)).toBe(CHAT_B);
    expect(primeConversation()).toBe(CHAT_B);
    const moved = swarmStateForCaller({ conversationId: CHAT_B }).agents;
    expect(moved.find((agent) => agent.id === 'prime')).toMatchObject({
      conversationId: CHAT_B,
      primeConversationId: CHAT_B
    });
    expect(moved.find((agent) => agent.id === 'worker-1')).toMatchObject({
      primeConversationId: CHAT_B
    });
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents).toEqual([]);
  });

  it('does not revive a late-created prime transfer after its continuation is cancelled', async () => {
    vi.useFakeTimers();
    const summary = await createSession({ title: 'cancelled late swarm', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    vi.setSystemTime(Date.now() + 1);
    startSwarm(CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);

    // Restart recovery is the supported path that can open a transfer after a late run appears.
    // Cancellation owns both halves: it aborts this exact ticket before clearing that transfer,
    // so the commit path can never reinterpret the now-empty broker marker as "never opened".
    await restoreContinuations(snapshotContinuations());
    expect(abortContinuation(opened.token, 'user cancelled the replacement')).toBe(true);
    expect(await commitContinuation(opened.token, CHAT_B)).toBe(false);
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
    expect(primeConversation()).toBe(CHAT_A);
    expect(continuationByToken(opened.token)?.state).toBe('aborted');
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents).toEqual([]);
  });

  it('commits a handover however long the handoff turn took', async () => {
    // 2026-09-01: an automatic compaction opened its continuation, the handoff turn then took
    // eleven minutes to produce the brief, and the swarm handover — which had a ten-minute
    // clock of its own — was already expired when the replacement chat committed. The commit
    // was refused with a perfectly live continuation, and the session was stranded between A
    // and B. The handover has no clock now: the continuation is the only authority over it.
    vi.useFakeTimers();
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    const opened = await openContinuationNow(summary.id, CHAT_A, true);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'tab-1');
    vi.setSystemTime(Date.now() + 60_000);

    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);
    expect(await attachedChat(summary.id)).toBe(CHAT_B);
    expect(primeConversation()).toBe(CHAT_B);
  });

  it('refuses the whole commit when the prime session has no usable handover', async () => {
    vi.useFakeTimers();
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    vi.setSystemTime(Date.now() + 1);
    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'tab-1');

    // The handover is gone while the continuation itself is still perfectly live — so the
    // refusal below can only be the swarm preflight, never generic expiry. (In production
    // this is the run ending, or being reset, between the button and the new chat.)
    cancelPrimeTransfer(CHAT_A);
    expect(continuationForSession(summary.id)?.state).toBe('claimed');
    expect(freezePrimeTransfer(CHAT_A)).toBe('unavailable');

    expect(await commitContinuation(opened.token, CHAT_B)).toBe(false);
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
    expect(primeConversation()).toBe(CHAT_A);
    // Refused before anything was written: still claimable, and its error says why.
    expect(continuationForSession(summary.id)?.state).toBe('claimed');
    expect(continuationForSession(summary.id)?.error).toMatch(/handover/);
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      primeConversationId: CHAT_A
    });
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents).toEqual([]);
  });

  it('commits a session that owns no swarm at all', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    expect(freezePrimeTransfer(CHAT_A)).toBe('absent');
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });

  it('keeps reusable workers attached to the run across an ordinary prime pause and a handover', async () => {
    startSwarm(CHAT_A);
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);

    resetAgentsForTests();
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);
  });

  it('keeps a handover open until the continuation commits or cancels it', () => {
    vi.useFakeTimers();
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);

    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    // Frozen means committed-to: the move cannot decline.
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(commitPrimeTransfer(CHAT_A, CHAT_B)).toBe(true);
    expect(primeConversation()).toBe(CHAT_B);

    resetAgentsForTests();
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);
    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    thawPrimeTransfer(CHAT_A);
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    // A thawed handover is still open, however long ago it was opened.
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    thawPrimeTransfer(CHAT_A);
    // Only the continuation ends it.
    cancelPrimeTransfer(CHAT_A);
    expect(freezePrimeTransfer(CHAT_A)).toBe('unavailable');
  });

  it('will not hand a swarm to a chat that is not the one being replaced', () => {
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);

    expect(commitPrimeTransfer('someone-else', CHAT_B)).toBe(false);
    expect(primeConversation()).toBe(CHAT_A);
  });

  it('keeps an overdue manual continuation durable across restart', async () => {
    vi.useFakeTimers();
    const openedAt = Date.now();
    const summary = await createSession({ title: 'expired restore', conversationId: CHAT_A });
    spawn({ workers: [{ task: 'read the tests' }], caller: { conversationId: CHAT_A } });

    vi.setSystemTime(openedAt + CONTINUATION_TTL_MS + 1);
    await restoreContinuations({
      version: 1,
      savedAt: openedAt,
      entries: [
        {
          token: 'expired-wait-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: null,
          openedAt,
          state: 'awaiting-summary',
          summary: '',
          handoffId: null,
          claimedBy: null,
          armed: false,
          error: null
        }
      ]
    });

    // Elapsed wall time is not a cancellation. The browser command may move to explicit
    // attention and retry in its exact owner, so the durable handoff remains recoverable.
    expect(continuationByToken('expired-wait-token')?.state).toBe('awaiting-summary');
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);
  });

  it('keeps an automatic ticket open past ordinary continuation deadlines and restart', async () => {
    vi.useFakeTimers();
    const summary = await createSession({ title: 'durable auto ticket', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A, true);
    const saved = snapshotContinuations();

    vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS * 6);
    expect(continuationByToken(opened.token)).toMatchObject({
      state: 'awaiting-summary',
      automatic: true
    });

    resetContinuationsForTests();
    await restoreContinuations(saved);
    expect(continuationByToken(opened.token)).toMatchObject({
      state: 'awaiting-summary',
      automatic: true
    });
  });

  it('quarantines an automatic ticket whose durable source session no longer exists', async () => {
    const openedAt = Date.now();
    await restoreContinuations({
      version: 1,
      savedAt: openedAt,
      entries: [{
        token: 'orphan-auto-token',
        sessionId: 'missing-session',
        from: CHAT_A,
        to: null,
        openedAt,
        automatic: true,
        state: 'awaiting-summary',
        summary: '',
        handoffId: null,
        claimedBy: null,
        armed: false,
        error: null
      }]
    });

    expect(continuationByToken('orphan-auto-token')).toMatchObject({
      state: 'aborted',
      error: 'Recovery could not find a valid source session for this continuation.'
    });
    expect(continuationForSession('missing-session')).toBeNull();
    expect(compactingConversation(CHAT_A)).toBeNull();
  });
});

describe('restart lifetime recovery', () => {
  it('persists handoff provenance without exposing the continuation token', async () => {
    const { sessionId, token } = await readyContinuation();
    const entry = continuationByToken(token)!;
    const raw = await fs.readFile(path.join(sessionsRoot(), sessionId, 'handoffs', `${entry.handoffId}.json`), 'utf8');
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      provenance: { sourceConversationId: CHAT_A, sourceGeneration: 1, sourceTurnId: null,
        continuationId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }
    });
    await restoreContinuations(snapshotContinuations());
    expect(continuationByToken(token)?.state).toBe('awaiting-chat');
  });

  it.each(['awaiting-chat', 'committing'] as const)(
    'rejects another transaction\'s handoff while restoring %s', async (state) => {
      const { sessionId, token } = await readyContinuation();
      const snapshot = snapshotContinuations();
      const row = snapshot.entries.find(entry => entry.token === token)!;
      row.state = state;
      if (state === 'committing') { row.to = CHAT_B; row.claimedBy = CHAT_B; }
      const file = path.join(sessionsRoot(), sessionId, 'handoffs', `${row.handoffId}.json`);
      const handoff = JSON.parse(await fs.readFile(file, 'utf8'));
      handoff.version = 1;
      handoff.provenance = { sourceConversationId: CHAT_A, sourceGeneration: 1,
        sourceTurnId: null, continuationId: 'a'.repeat(43) };
      await fs.writeFile(file, JSON.stringify(handoff));
      const recorder = await import('../src/main/session/recorder.js');
      const publish = vi.spyOn(recorder, 'ensureHandoffRecorded');
      await restoreContinuations(snapshot);
      expect(continuationByToken(token)).toMatchObject({ state: 'aborted',
        error: 'The saved handoff belongs to a different continuation.' });
      expect(publish).not.toHaveBeenCalled();
      expect(await attachedChat(sessionId)).toBe(CHAT_A);
    }
  );

  it.each(['conflicting', 'malformed'] as const)(
    'preserves a durable rebind without publishing %s handoff metadata', async (damage) => {
      const { sessionId, token } = await readyContinuation();
      await claimContinuationNow(token, CHAT_B);
      expect(await commitContinuation(token, CHAT_B)).toBe(true);
      const snapshot = snapshotContinuations();
      const row = snapshot.entries.find(entry => entry.token === token)!;
      const file = path.join(sessionsRoot(), sessionId, 'handoffs', `${row.handoffId}.json`);
      const handoff = JSON.parse(await fs.readFile(file, 'utf8'));
      handoff.version = 1;
      handoff.provenance = damage === 'malformed' ? null : {
        sourceConversationId: CHAT_C, sourceGeneration: 1, sourceTurnId: null, continuationId: 'a'.repeat(43)
      };
      await fs.writeFile(file, JSON.stringify(handoff));
      const publish = vi.spyOn(store, 'ensureCommittedResumeHandoff');
      await restoreContinuations(snapshot);
      expect(continuationByToken(token)?.state).toBe('committed');
      expect(await attachedChat(sessionId)).toBe(CHAT_B);
      expect(publish).not.toHaveBeenCalled();
    }
  );

  it.each(['sourceConversationId', 'sourceTurnId'] as const)(
    'rejects a handoff whose %s contradicts the continuation', async (field) => {
      const { sessionId, token } = await readyContinuation();
      const snapshot = snapshotContinuations();
      const row = snapshot.entries.find(entry => entry.token === token)!;
      const file = path.join(sessionsRoot(), sessionId, 'handoffs', `${row.handoffId}.json`);
      const handoff = JSON.parse(await fs.readFile(file, 'utf8'));
      handoff.provenance[field] = 'different-source';
      await fs.writeFile(file, JSON.stringify(handoff));
      await restoreContinuations(snapshot);
      expect(continuationByToken(token)).toMatchObject({ state: 'aborted',
        error: 'The saved handoff belongs to a different continuation.' });
      expect(await attachedChat(sessionId)).toBe(CHAT_A);
    }
  );

  it.each([
    ['version', 2], ['id', 'foreign-handoff'], ['sessionId', 'foreign-session'],
    ['sourceConversationId', 'x'.repeat(257)], ['sourceTurnId', 42],
    ['sourceGeneration', -1], ['continuationId', 'not-a-fingerprint']
  ])('rejects malformed versioned handoff field %s before restore can publish it', async (field, value) => {
    const { sessionId, token } = await readyContinuation();
    const snapshot = snapshotContinuations();
    const row = snapshot.entries.find(entry => entry.token === token)!;
    row.state = 'committing';
    row.to = CHAT_B;
    const file = path.join(sessionsRoot(), sessionId, 'handoffs', `${row.handoffId}.json`);
    const handoff = JSON.parse(await fs.readFile(file, 'utf8'));
    const target = ['version', 'id', 'sessionId'].includes(String(field)) ? handoff : handoff.provenance;
    target[String(field)] = value;
    await fs.writeFile(file, JSON.stringify(handoff));
    expect(await store.readHandoff(sessionId, row.handoffId!)).toBeNull();
    await restoreContinuations(snapshot);
    expect(continuationByToken(token)).toMatchObject({ state: 'aborted',
      error: 'The saved handoff could not be recovered.' });
    expect(await attachedChat(sessionId)).toBe(CHAT_A);
  });

  it('keeps legacy handoffs readable under their existing continuation proof', async () => {
    const { sessionId, token } = await readyContinuation();
    const snapshot = snapshotContinuations();
    const row = snapshot.entries.find(entry => entry.token === token)!;
    const file = path.join(sessionsRoot(), sessionId, 'handoffs', `${row.handoffId}.json`);
    const handoff = JSON.parse(await fs.readFile(file, 'utf8'));
    delete handoff.version;
    delete handoff.provenance;
    await fs.writeFile(file, JSON.stringify(handoff));
    await restoreContinuations(snapshot);
    expect(continuationByToken(token)?.state).toBe('awaiting-chat');
  });

  it('restores live continuation debt while bounding retained terminal replay history', async () => {
    const summary = await createSession({ title: 'live continuation behind terminal receipts', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const live = snapshotContinuations().entries[0]!;
    const now = Date.now();
    const terminal = Array.from({ length: 33 }, (_, index) => ({
      ...live,
      token: `terminal-receipt-${String(index).padStart(2, '0')}`,
      sessionId: `terminal-session-${String(index).padStart(2, '0')}`,
      openedAt: now - 1_000,
      touchedAt: now,
      state: 'aborted' as const,
      error: 'already terminal'
    }));

    resetContinuationsForTests();
    await restoreContinuations({
      version: 1,
      savedAt: now,
      entries: [...terminal, live]
    });

    expect(continuationByToken(opened.token)).toMatchObject({
      sessionId: summary.id,
      state: 'awaiting-summary'
    });
    const repaired = snapshotContinuations().entries;
    expect(repaired.some((entry) => entry.token === opened.token)).toBe(true);
    expect(repaired.filter((entry) => entry.state === 'aborted').length).toBe(32);
  });

  it('gives up an automatic handover that never lands, so the source chat gets its tools back', async () => {
    vi.useFakeTimers();
    const summary = await createSession({ title: 'stuck auto handover', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A, true);

    // Intended but not yet asked for: the chat may be mid-turn for as long as it likes.
    vi.setSystemTime(Date.now() + AUTOMATIC_HANDOVER_TTL_MS * 2);
    expect(continuationForSession(summary.id)?.state).toBe('awaiting-summary');
    expect(compactingConversation(CHAT_A)).toBeNull();

    // Asked for: from here chat A is refused every tool until the handover lands, so this is
    // where the clock starts. A handover the model never finishes must not fence A for good.
    expect((await beginContinuationSourceSendNow(opened.token))?.allowed).toBe(true);
    expect(await dispatchContinuationSourceSendNow(opened.token)).toBe(true);
    expect(compactingConversation(CHAT_A)?.token).toBe(opened.token);
    vi.setSystemTime(Date.now() + AUTOMATIC_HANDOVER_TTL_MS - 1);
    expect(compactingConversation(CHAT_A)?.token).toBe(opened.token);
    const saved = snapshotContinuations();

    vi.setSystemTime(Date.now() + 2);
    expect(compactingConversation(CHAT_A)).toBeNull();
    expect(continuationForSession(summary.id)).toBeNull();

    // The same verdict when a restart finds the record on disk.
    resetContinuationsForTests();
    await restoreContinuations(saved);
    expect(compactingConversation(CHAT_A)).toBeNull();
    expect(continuationForSession(summary.id)).toBeNull();
  });

  it('keeps a committed record committed when the session has since moved on again', async () => {
    const now = Date.now();
    const summary = await createSession({ title: 'moved twice', conversationId: CHAT_A });
    expect(await store.rebindSession(summary.id, CHAT_A, CHAT_B)).toBe(true);
    expect(await store.rebindSession(summary.id, CHAT_B, CHAT_C)).toBe(true);

    await restoreContinuations({
      version: 1,
      savedAt: now,
      entries: [
        {
          token: 'first-move-token-0',
          sessionId: summary.id,
          from: CHAT_A,
          to: CHAT_B,
          openedAt: now - 1_000,
          state: 'committed',
          summary: SAMPLE_BRIEF,
          handoffId: null,
          claimedBy: CHAT_B,
          armed: true,
          error: null
        }
      ]
    });

    // A later handover out of B does not make the first move any less real: A stays a
    // superseded chat rather than the record being aborted for an "unexpected" attachment.
    expect(continuationByToken('first-move-token-0')?.state).toBe('committed');
    expect(supersededSourceConversations()).toContain(CHAT_A);
    expect(await attachedChat(summary.id)).toBe(CHAT_C);
  });

  it('durably spends a committed source close without erasing its handoff history', async () => {
    const summary = await createSession({ title: 'one-shot source close', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, CHAT_B);
    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);
    expect(supersededSourceConversations()).toContain(CHAT_A);

    expect(await spendSupersededSourceClosesNow(new Set([CHAT_B]))).toBe(1);
    expect(await spendSupersededSourceClosesNow(new Set([CHAT_B]))).toBe(0);
    expect(supersededSourceConversations()).not.toContain(CHAT_A);
    const saved = snapshotContinuations();
    expect(saved.entries.find(entry => entry.token === opened.token)?.sourceClosed).toBe(true);

    resetContinuationsForTests();
    await restoreContinuations(saved);
    expect(continuationByToken(opened.token)?.state).toBe('committed');
    expect(supersededSourceConversations()).not.toContain(CHAT_A);
    expect(await attachedChat(summary.id)).toBe(CHAT_B);
  });

  it('does not publish an exact retirement receipt whose durable write failed', async () => {
    const summary = await createSession({ title: 'failed close receipt', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, CHAT_B);
    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);
    const durable = await import('../src/main/durable.js');
    const failed = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));

    await expect(acknowledgeSupersededSourceRetirementNow(
      CHAT_A,
      '11111111111111111111111111111111'
    )).rejects.toThrow('disk full');
    expect(supersededSourceConversations()).toContain(CHAT_A);
    expect(snapshotContinuations().entries.find(entry => entry.token === opened.token)).toMatchObject({
      sourceClosed: false,
      sourceCloseReceiptId: null
    });

    failed.mockRestore();
    expect(await acknowledgeSupersededSourceRetirementNow(
      CHAT_A,
      '11111111111111111111111111111111'
    )).toBe('spent');
  });

  it('restores old unspent source-close debt outside the terminal age and row caps', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const summary = await createSession({ title: 'old unspent close', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, CHAT_B);
    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);
    const committed = snapshotContinuations().entries.find(entry => entry.token === opened.token)!;
    const old = now - CONTINUATION_TTL_MS * 3;
    const terminalNoise = Array.from({ length: 40 }, (_, index) => ({
      ...committed,
      token: `terminal-noise-${String(index).padStart(2, '0')}`,
      sessionId: `terminal-session-${String(index).padStart(2, '0')}`,
      from: `terminal-from-${String(index).padStart(2, '0')}`,
      to: null,
      openedAt: now - index,
      touchedAt: now - index,
      state: 'aborted' as const,
      sourceClosed: true,
      sourceCloseReceiptId: null,
      error: 'finished'
    }));

    resetContinuationsForTests();
    await restoreContinuations({
      version: 1,
      savedAt: now,
      entries: [{ ...committed, openedAt: old, touchedAt: old }, ...terminalNoise]
    });
    expect(continuationByToken(opened.token)?.state).toBe('committed');
    expect(supersededSourceConversations()).toContain(CHAT_A);

    expect(await acknowledgeSupersededSourceRetirementNow(
      CHAT_A,
      '22222222222222222222222222222222'
    )).toBe('spent');
    vi.setSystemTime(now + CONTINUATION_TTL_MS * 2 + 1);
    expect(continuationByToken(opened.token)).toBeNull();
  });

  it('rolls an overdue manual pre-commit record back into its existing transfer', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const summary = await createSession({ title: 'expired committing restore', conversationId: CHAT_A });
    spawn({ workers: [{ task: 'read the tests' }], caller: { conversationId: CHAT_A } });
    const { prepareHandoff } = await import('../src/main/session/handoff.js');
    const prepared = await prepareHandoff({ sessionId: summary.id, text: SAMPLE_BRIEF,
      continuationToken: 'expired-commit-token', sourceConversationId: CHAT_A });

    await restoreContinuations({
      version: 1,
      savedAt: now,
      entries: [
        {
          token: 'expired-commit-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: CHAT_B,
          openedAt: now - CONTINUATION_TTL_MS - 1,
          state: 'committing',
          summary: SAMPLE_BRIEF,
          handoffId: prepared.id,
          claimedBy: CHAT_B,
          armed: true,
          error: null
        }
      ]
    });

    // The session still being on A proves the durable move never landed. This is the same
    // transaction becoming claimable again, not a new continuation or duplicated prompt.
    expect(continuationByToken('expired-commit-token')?.state).toBe('claimed');
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
  });

  it('keeps a terminal commit replayable during the second TTL window', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const summary = await createSession({ title: 'committed restore', conversationId: CHAT_A });
    expect(await store.rebindSession(summary.id, CHAT_A, CHAT_B)).toBe(true);

    await restoreContinuations({
      version: 1,
      savedAt: now,
      entries: [
        {
          token: 'terminal-replay-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: CHAT_B,
          openedAt: now - CONTINUATION_TTL_MS - 1,
          state: 'committed',
          summary: SAMPLE_BRIEF,
          handoffId: null,
          claimedBy: CHAT_B,
          armed: true,
          error: null
        }
      ]
    });

    expect(await commitContinuation('terminal-replay-token', CHAT_B)).toBe(true);
    expect(await attachedChat(summary.id)).toBe(CHAT_B);
  });
});


/**
 * The brief a session is worth moving for.
 *
 * On 2026-08-23 a compaction turn was declared finished 28 characters in, and `TASK\nContinue
 * implementing ` — cut off at an opening backtick — was stored as the whole handoff for a
 * session holding 455 events and 318,422 tokens. It was typed into a replacement chat that
 * had no way to tell it from a complete document, because no receiver has: a brief is prose,
 * and a truncated one is still prose.
 *
 * So the check has to happen before it is stored, and it cannot be a check on meaning. Length
 * against the size of what is being handed over is the one property that separates the two
 * outcomes here — and the direction of the failure is what makes a crude test acceptable. A
 * refused brief costs a second press; an accepted truncated one costs the session.
 */
describe('a brief that cannot be the whole handoff', () => {
  it('refuses nothing at all', () => {
    expect(briefShortfall('', 50_000)).toMatch(/nothing/i);
    expect(briefShortfall('   \n  ', 50_000)).toMatch(/nothing/i);
  });

  it('refuses the twenty-eight characters that started this', () => {
    const cut = 'TASK\nContinue implementing `';
    const refusal = briefShortfall(cut, 318_422);
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('28 characters');
  });

  it('refuses a plausible-looking brief that is far too small for the session it carries', () => {
    // Long enough to read as a document, and nowhere near enough to be one. This is the
    // shape a turn cut off mid-way actually produces.
    const partial = `TASK — ${'continue the rewrite. '.repeat(12)}`;
    expect(partial.length).toBeGreaterThan(200);
    expect(briefShortfall(partial, 300_000)).toMatch(/cannot be the whole handoff/i);
    // The same text is a fine brief for a session that has barely started.
    expect(briefShortfall(partial, 900)).toBeNull();
  });

  it('accepts a real one', () => {
    expect(briefShortfall(SAMPLE_BRIEF, 318_422)).toBeNull();
  });
});

/**
 * The 302 milliseconds that lost a session.
 *
 * When a resume opens chat B, two things race to react to B appearing: the recorder, which
 * invents a session for any conversation it has not seen, and the commit, which moves the
 * *existing* session onto B. The recorder won, the commit found its own destination already
 * owned — "the replacement chat already belongs to another local session" — and refused to
 * rebind. The prime role moved to the new chat anyway; the session did not follow it.
 *
 * The gate is one boolean the recorder can ask before inventing anything. These are about
 * when it is armed and, more importantly, when it stops being: an armed gate that nothing
 * clears would make every unrelated new chat wait.
 */
describe('the window in which a replacement chat is expected', () => {
  it('keeps the exact command delivery clock immutable through claim retries and dispatch', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'fixed-resume-command');
    const claimedAt = Date.now();
    const clock = vi.spyOn(Date, 'now');
    expect(noteResumeCommandLease(token, 'fixed-resume-command', claimedAt)).toBe(true);
    clock.mockReturnValue(claimedAt + 90_000);
    noteResumeOpening(token);
    noteResumeClaim(token, 'fixed-resume-command');
    expect(noteResumeCommandLease(token, 'fixed-resume-command', claimedAt)).toBe(true);
    expect(noteResumeCommandLease(token, 'fixed-resume-command', claimedAt + 1)).toBe(false);
    expect(noteResumeCommandLease(token, 'foreign-command', claimedAt)).toBe(false);
    expect(resumeOpeningChat()).toBe(true);
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    expect(resumeOpeningChat(claimedAt + REDEEMED_COMMAND_DELIVERY_MS + 1)).toBe(false);
    expect(resumeOpeningChat()).toBe(false);
  });

  it.each([NaN, Infinity, -1, 0, 0.5])('rejects an invalid command lease clock (%s)', async claimedAt => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'validated-clock-command');
    expect(noteResumeCommandLease(token, 'validated-clock-command', claimedAt)).toBe(false);
    expect(resumeOpeningChat(Date.now() + RESUME_CLAIM_WINDOW_MS + 1)).toBe(false);
  });

  it('does not grant a delivery gate without the same durably claimed token and command', async () => {
    const { token } = await readyContinuation();
    const at = Date.now();
    expect(noteResumeCommandLease(token, 'unclaimed-command', at)).toBe(false);
    expect(resumeOpeningChat()).toBe(false);
    await claimContinuationNow(token, 'exact-command');
    expect(noteResumeCommandLease('different-token', 'exact-command', at)).toBe(false);
    expect(noteResumeCommandLease(token, 'different-command', at)).toBe(false);
    expect(noteResumeCommandLease(token, 'exact-command', Date.now() + 1_000)).toBe(false);
    expect(noteResumeCommandLease(token, 'exact-command', Date.now() - REDEEMED_COMMAND_DELIVERY_MS - 1)).toBe(false);
    expect(resumeOpeningChat(Date.now() + RESUME_CLAIM_WINDOW_MS + 1)).toBe(false);
  });

  it('lets the same captured opening acquire its durable delivery lease but ignores overlapping foreign attempts', async () => {
    const { token } = await readyContinuation();
    noteResumeOpening(token);
    const started = Date.now();
    const waiting = resumeOpeningWait();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started + 30_000);
    await claimContinuationNow(token, 'later-redeemed-command');
    expect(noteResumeCommandLease(token, 'later-redeemed-command', Date.now())).toBe(true);
    clock.mockReturnValue(started + 90_000);
    expect(waiting()).toBe(true);
    abortContinuation(token, 'the exact opening was cancelled');
    noteResumeOpening('foreign-later-opening');
    expect(resumeOpeningChat()).toBe(true);
    expect(waiting(), 'a later unrelated attempt must not extend this recorder admission wait').toBe(false);
  });

  it('leaves generic claims at sixty seconds and does not turn a failed claim into a delivery lease', async () => {
    const { token } = await readyContinuation();
    const durable = await import('../src/main/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('exact claim disk full'));
    await expect(claimContinuationNow(token, 'undurable-command')).rejects.toThrow('exact claim disk full');
    expect(noteResumeCommandLease(token, 'undurable-command', Date.now())).toBe(false);
    expect(resumeOpeningChat()).toBe(false);
    await claimContinuationNow(token, 'generic-command');
    const waiting = resumeOpeningWait();
    const at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at + RESUME_CLAIM_WINDOW_MS + 1);
    expect(waiting()).toBe(false);
    expect(resumeOpeningChat()).toBe(false);
    clock.mockRestore();
  });

  it('ends only a durably released opening lease, retaining it when release persistence fails', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'released-opening-command');
    const claimedAt = Date.now();
    expect(noteResumeCommandLease(token, 'released-opening-command', claimedAt)).toBe(true);
    const waiting = resumeOpeningWait();
    const durable = await import('../src/main/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('release disk full'));
    await expect(releaseContinuationDestinationSendNow(token, 'released-opening-command')).rejects.toThrow('release disk full');
    expect(waiting()).toBe(true);
    expect(resumeOpeningChat(claimedAt + 90_000)).toBe(true);
    expect(await releaseContinuationDestinationSendNow(token, 'foreign-opening-command')).toBe(false);
    expect(waiting()).toBe(true);
    expect(await releaseContinuationDestinationSendNow(token, 'released-opening-command')).toBe(true);
    expect(waiting()).toBe(false);
    expect(resumeOpeningChat()).toBe(false);
  });

  it('keeps an early destination observation with the original session after a slow resume commit', async () => {
    const { sessionId, token } = await readyContinuation();
    const destination = '92929292-1111-4222-8333-444444444444';
    await claimContinuationNow(token, 'slow-resume-command');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const create = vi.spyOn(store, 'createSession');
    const gates = await import('../src/main/session/resume-gate.js');
    const originalWait = gates.resumeOpeningWait;
    let entered!: () => void;
    const atGate = new Promise<void>(resolve => { entered = resolve; });
    const gate = vi.spyOn(gates, 'resumeOpeningWait').mockImplementation(() => {
      const waiting = originalWait();
      entered();
      return waiting;
    });
    const observation = sessionForConversation(destination);
    try {
      // Catalog I/O precedes this boundary. Await the boundary itself rather than
      // advancing the fake claim clock while polling for real filesystem work.
      await atGate;
      expect(gate).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(6_000);

      // The command still owns its sixty-second claim. Five seconds without its ACK
      // cannot authorize a second durable session for the destination.
      expect(resumeOpeningChat()).toBe(true);
      expect(await commitContinuation(token, destination)).toBe(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(await observation).toBe(sessionId);
      expect(create).not.toHaveBeenCalled();
      expect((await store.findSessionByConversation(destination))?.id).toBe(sessionId);
    } finally {
      // A failed assertion must not leave this observation creating a shadow
      // destination during the next test's unrelated continuation.
      abortContinuation(token, 'test observation drained');
      await vi.advanceTimersByTimeAsync(50);
      await observation;
    }
  });

  it('re-arms destination ownership when native Send follows a slow post-claim setup', async () => {
    const { sessionId, token } = await readyContinuation();
    const destination = '93939393-2222-4333-8444-555555555555';
    await claimContinuationNow(token, 'slow-picker-resume-command');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await vi.advanceTimersByTimeAsync(RESUME_CLAIM_WINDOW_MS + 100);
    expect(resumeOpeningChat()).toBe(false);
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    expect(resumeOpeningChat()).toBe(true);
    const create = vi.spyOn(store, 'createSession');
    const observation = sessionForConversation(destination);
    expect(await commitContinuation(token, destination)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(await observation).toBe(sessionId);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not re-arm destination ownership when dispatch persistence fails', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'failed-dispatch-command');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await vi.advanceTimersByTimeAsync(RESUME_CLAIM_WINDOW_MS + 100);
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    const durable = await import('../src/main/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('dispatch disk full'));
    await expect(dispatchContinuationDestinationSendNow(token)).rejects.toThrow('dispatch disk full');
    expect(resumeOpeningChat()).toBe(false);
  });

  it.each(['abort', 'expiry'] as const)('releases unrelated new recording when the resume claim ends by %s', async reason => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'unfinished-resume-command');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const unrelated = reason === 'abort' ? '93939393-1111-4222-8333-444444444444' : '94949494-1111-4222-8333-444444444444';
    const gate = vi.spyOn(await import('../src/main/session/resume-gate.js'), 'resumeOpeningWait');
    const observation = sessionForConversation(unrelated);
    await vi.waitFor(() => expect(gate).toHaveBeenCalledOnce());
    if (reason === 'abort') abortContinuation(token, 'cancelled before destination');
    await vi.advanceTimersByTimeAsync(reason === 'expiry' ? RESUME_CLAIM_WINDOW_MS + 100 : 100);
    const sessionId = await observation;
    expect(sessionId).toBeTruthy();
    expect((await getSession(sessionId!))?.conversationId).toBe(unrelated);
    expect(resumeOpeningChat()).toBe(false);
  });

  it('is armed by a claim and cleared by the commit', async () => {
    expect(resumeOpeningChat()).toBe(false);
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(resumeOpeningChat()).toBe(true);

    await commitContinuation(token, CHAT_B);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
    expect(resumeOpeningChat()).toBe(false);
  });

  it('is cleared by an abort as well, so a failed move does not hold new chats up', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(resumeOpeningChat()).toBe(true);
    abortContinuation(token, 'gave up');
    expect(resumeOpeningChat()).toBe(false);
  });

  it('expires on its own when the replacement chat never appears', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(resumeOpeningChat()).toBe(true);
    // A crash between the claim and the commit, or a browser that never opened the tab.
    // Failing to wait costs a visible stub session; waiting forever would stop the app
    // recording new chats at all, so this expires in the safe direction.
    expect(resumeOpeningChat(Date.now() + RESUME_CLAIM_WINDOW_MS + 1)).toBe(false);
    expect(resumeOpeningChat()).toBe(false);
  });

  it('is not armed by a durable claim whose write failed', async () => {
    const { token } = await readyContinuation();
    const durable = await import('../src/main/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));
    await expect(claimContinuationNow(token, CHAT_B)).rejects.toThrow(/disk full/);
    // Nothing was claimed, so nothing may be waited for. Arming before the write is what
    // would have made every unrelated new chat pay the settle window for a claim that does
    // not exist.
    expect(resumeOpeningChat()).toBe(false);
  });

  it('is re-armed for a continuation recovered still holding its claim', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    const snapshot = {
      version: 1 as const,
      savedAt: Date.now(),
      entries: [
        {
          token,
          sessionId,
          from: CHAT_A,
          to: null,
          openedAt: Date.now(),
          state: 'claimed' as const,
          summary: SAMPLE_BRIEF,
          handoffId: continuationForSession(sessionId)?.handoffId ?? null,
          claimedBy: CHAT_B,
          armed: true,
          error: null
        }
      ]
    };

    // The restart. The claim that armed the gate happened in a process that is gone, and
    // the replacement chat may be sitting in a tab about to report in — which is exactly
    // the restart most likely to hit the collision this exists to prevent.
    resetContinuationsForTests();
    expect(resumeOpeningChat()).toBe(false);
    await restoreContinuations(snapshot);
    expect(resumeOpeningChat()).toBe(true);
  });

  it('is not re-armed for a continuation that was already finished', async () => {
    const { sessionId, token } = await readyContinuation();
    resetContinuationsForTests();
    await restoreContinuations({
      version: 1 as const,
      savedAt: Date.now(),
      entries: [
        {
          token,
          sessionId,
          from: CHAT_A,
          to: CHAT_B,
          openedAt: Date.now(),
          state: 'aborted' as const,
          summary: SAMPLE_BRIEF,
          handoffId: null,
          claimedBy: CHAT_B,
          armed: true,
          error: 'gave up'
        }
      ]
    });
    expect(resumeOpeningChat()).toBe(false);
  });

  it('is cleared by the test reset, so one case cannot slow the next one down', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(resumeOpeningChat()).toBe(true);
    resetContinuationsForTests();
    expect(resumeOpeningChat()).toBe(false);
  });

  it.each(['plain', 'core-attachment', 'provider-core-attachment', 'provider-spaced-core-attachment'] as const)('lets the exact app-opened shadow chat recover the prime after the historical collision (%s)', async shape => {
    const suffix = shape === 'plain' ? '444444444444' : shape === 'core-attachment' ? '444444444445'
      : shape === 'provider-core-attachment' ? '444444444446' : '444444444447';
    const from = `81818181-1111-2222-3333-${suffix}`;
    const to = `82828282-1111-2222-3333-${suffix}`;
    const source = await createSession({ title: 'prime before broken resume', conversationId: from });
    setGoalObjective(from, 'finish the release from the replacement chat');
    setWorkspaceFor(`chat:${from}`, { virtual: '/workspace/project', real: dir });
    spawn({ workers: [{ task: 'keep the reusable worker alive' }], caller: { conversationId: from } });
    const opened = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(opened.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(opened.token, 'resume-shadow-owner');

    // The buggy recorder beat the ACK and stamped B as an app-created resume session. The real
    // continuation then refused to overwrite that session and the bridge durably aborted it.
    await createSession({
      title: 'Resumed · prime before broken resume',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    const core = '[$ember-windows-core](app://asdk_app_0123456789abcdef0123456789abcdef)';
    let text = shape === 'plain' ? resumeBootstrapText(handoff!.text)
      : shape === 'core-attachment' ? core + resumeBootstrapText(handoff!.text, opened.token)
        : core + `[[CLF-RESUME:${opened.token}]]\\\n\\\n` + resumeBootstrapText(handoff!.text).replace(/\n/g, '\\\n');
    if (shape === 'provider-spaced-core-attachment') text = text.split('\\\n').join(' \\\n');
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text, messageId: 'm-shadow-bootstrap' }
    ]);
    expect(await commitContinuation(opened.token, to)).toBe(false);
    abortContinuation(opened.token, 'the replacement chat already belongs to another local session');
    expect(primeConversation()).toBe(from);
    expect(goalObjectiveFor(from)).toBe('finish the release from the replacement chat');

    // A random recorded conversation is not repair authority. In particular it cannot steal
    // the objective/workspace just because some other resume attempt from A once collided.
    const unrelated = `83838383-1111-2222-3333-${suffix}`;
    await createSession({ title: 'ordinary unrelated chat', conversationId: unrelated });
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(unrelated)).toBe(false);
    expect(goalObjectiveFor(from)).toBe('finish the release from the replacement chat');
    expect(goalObjectiveFor(unrelated)).toBe('');
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:')).map((held) => held.key)).toEqual([`chat:${from}`]);

    expect(await repairPrimeFromResumeShadow(to)).toBe(true);
    expect(primeConversation()).toBe(to);
    expect(goalObjectiveFor(from)).toBe('');
    expect(goalObjectiveFor(to)).toBe('finish the release from the replacement chat');
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:')).map((held) => held.key)).toEqual([`chat:${to}`]);

    // Repairing B's projections leaves A's recorder in place. The exact abandoned source
    // generation must not file another automatic handoff and split work into C without Goal.
    // This is a refusal of that generation, never a fabricated commit or destination ACK.
    const sourceAfterRepair = (await getSession(source.id))!;
    expect(sourceAfterRepair.conversationId).toBe(from);
    expect(store.autoCompactionReady({ ...sourceAfterRepair, contextTokens: 1_000_000 })).toBe(false);
    expect(continuationByToken(opened.token)?.state).toBe('aborted');
    await store.flushSessions();
    await resetSessionStoreForTests();
    expect(store.autoCompactionReady({ ...(await getSession(source.id))!, contextTokens: 1_000_000 })).toBe(false);
    // A genuinely newer source generation retains the normal ordinary-chat policy.
    await store.appendEvent(source.id, { time: Date.now(), source: 'extension', kind: 'turn_start', turnId: 'new-source-generation' });
    expect(store.autoCompactionReady({ ...(await getSession(source.id))!, contextTokens: 1_000_000 })).toBe(true);

    // The broker hook itself intentionally treats an already-satisfied replay as success. The
    // resume-shadow wrapper reports actual projection changes, so a later browser poll is a no-op.
    expect(await repairPrimeFromResumeShadow(to)).toBe(false);

    // Same-origin-looking data without the exact authored bootstrap is not takeover authority.
    const stranger = `84848484-1111-2222-3333-${suffix}`;
    await createSession({
      title: 'unrelated resume-looking chat',
      conversationId: stranger,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    expect(await repairPrimeFromResumeShadow(stranger)).toBe(false);
    expect(primeConversation()).toBe(to);
  });

  it.each(['opened', 'claimed', 'opening-await', 'fence-await'] as const)(
    'keeps an older resume shadow from taking projections while a newer handoff is %s', async stage => {
      const suffix = stage === 'opened' ? '555555555551' : stage === 'claimed' ? '555555555552'
        : stage === 'opening-await' ? '555555555553' : '555555555554';
      const from = `81818181-abab-cdcd-efef-${suffix}`;
      const shadowChat = `82828282-abab-cdcd-efef-${suffix}`;
      const currentChat = `83838383-abab-cdcd-efef-${suffix}`;
      const source = await createSession({ title: 'source with two distinct handoffs', conversationId: from });
      const objective = 'finish this same finite cleanup without a second executor';
      setGoalObjective(from, objective);
      await setGoalSwitchNow(from, 'goal', true);
      setWorkspaceFor(`chat:${from}`, { virtual: '/workspace/project', real: dir });
      spawn({ workers: [{ task: 'retain the source prime until its live handoff commits' }], caller: { conversationId: from } });
      const old = await openContinuationNow(source.id, from);
      const oldHandoff = await attachSummary(old.token, SAMPLE_BRIEF);
      await claimContinuationNow(old.token, 'old-shadow-owner');
      await createSession({ title: 'older exact shadow', conversationId: shadowChat,
        origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' } });
      await recordChatObservations(shadowChat, [{ kind: 'user_message', time: Date.now(),
        text: resumeBootstrapText(oldHandoff!.text), messageId: 'm-older-exact-shadow' }]);
      expect(await commitContinuation(old.token, shadowChat)).toBe(false);
      abortContinuation(old.token, 'the replacement chat already belongs to another local session');
      setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });

      let newer: Awaited<ReturnType<typeof openContinuationNow>> | null = null;
      let opening: ReturnType<typeof openContinuationNow> | null = null;
      const openingGate: { release?: () => void } = {};
      if (stage === 'fence-await') {
        const refuse = store.refuseAutomaticCompactionNow;
        vi.spyOn(store, 'refuseAutomaticCompactionNow').mockImplementationOnce(async (...args) => {
          await refuse(...args);
          newer = await openContinuationNow(source.id, from, true);
        });
      } else if (stage === 'opening-await') {
        const gate = new Promise<void>(resolve => { openingGate.release = resolve; });
        const readSource = store.getSession;
        vi.spyOn(store, 'getSession').mockImplementationOnce(async (...args) => {
          await gate;
          return readSource(...args);
        });
        opening = openContinuationNow(source.id, from, true);
      } else {
        newer = await openContinuationNow(source.id, from, true);
        if (stage === 'claimed') {
          await attachSummary(newer.token, SAMPLE_BRIEF);
          await claimContinuationNow(newer.token, 'newer-destination-owner');
        }
      }

      let repaired: boolean;
      try {
        repaired = await repairPrimeFromResumeShadow(shadowChat);
      } finally {
        openingGate.release?.();
        if (opening) newer = await opening;
      }
      expect(repaired).toBe(false);
      expect(goalObjectiveFor(from)).toBe(objective);
      expect(goalObjectiveFor(shadowChat)).toBe('');
      expect(goalSwitchFor(from)).toMatchObject({ own: true, enabled: true, mode: 'goal' });
      expect(primeConversation()).toBe(from);
      expect(workspaceEntries().filter(row => row.key.startsWith('chat:')).map(row => row.key)).toEqual([`chat:${from}`]);
      expect(continuationByToken(old.token)).toMatchObject({ state: 'aborted',
        destinationSend: { state: 'not-attempted', messageId: null } });

      // Only the incumbent newer transaction can move the projections. Its successful
      // commit must carry the original Goal instead of leaving the destination empty.
      expect(newer).not.toBeNull();
      if (stage !== 'claimed') {
        await attachSummary(newer!.token, SAMPLE_BRIEF);
        await claimContinuationNow(newer!.token, 'newer-destination-owner');
      }
      expect(await commitContinuation(newer!.token, currentChat)).toBe(true);
      expect(goalObjectiveFor(currentChat)).toBe(objective);
      expect(goalObjectiveFor(from)).toBe('');
      expect(goalObjectiveFor(shadowChat)).toBe('');
      expect(goalSwitchFor(currentChat)).toMatchObject({ own: true, enabled: true, mode: 'goal' });
      expect(primeConversation()).toBe(currentChat);
    }
  );

  it.each(['write-failed', 'source-turn-changed', 'target-rebound'] as const)(
    'does not publish shadow projections after the source fence is %s', async failure => {
      const suffix = failure === 'write-failed' ? '444444444444' : failure === 'source-turn-changed' ? '444444444445' : '444444444446';
      const from = `81818181-abab-cdcd-efef-${suffix}`;
      const to = `82828282-abab-cdcd-efef-${suffix}`;
      const source = await createSession({ title: 'shadow source fence race', conversationId: from });
      setGoalObjective(from, 'preserve the original owner when fencing fails');
      spawn({ workers: [{ task: 'retain the exact source owner' }], caller: { conversationId: from } });
      const opened = await openContinuationNow(source.id, from);
      const handoff = await attachSummary(opened.token, SAMPLE_BRIEF);
      await claimContinuationNow(opened.token, 'source-fence-shadow-owner');
      const target = await createSession({ title: 'exact shadow', conversationId: to,
        origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' } });
      await recordChatObservations(to, [{ kind: 'user_message', time: Date.now(),
        text: resumeBootstrapText(handoff!.text), messageId: 'm-source-fence-shadow' }]);
      expect(await commitContinuation(opened.token, to)).toBe(false);
      abortContinuation(opened.token, 'the replacement chat already belongs to another local session');
      setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });

      const refuse = store.refuseAutomaticCompactionNow;
      vi.spyOn(store, 'refuseAutomaticCompactionNow').mockImplementationOnce(async (...args) => {
        if (failure === 'write-failed') throw new Error('source fence disk failure');
        await refuse(...args);
        if (failure === 'source-turn-changed') {
          await store.appendEvent(source.id, { time: Date.now(), source: 'extension',
            kind: 'turn_start', turnId: 'newer-source-turn' });
        } else {
          expect(await store.rebindSession(target.id, to, '83838383-abab-cdcd-efef-444444444444')).toBe(true);
        }
      });
      if (failure === 'write-failed') await expect(repairPrimeFromResumeShadow(to)).rejects.toThrow('source fence disk failure');
      else expect(await repairPrimeFromResumeShadow(to)).toBe(false);
      expect(primeConversation()).toBe(from);
      expect(goalObjectiveFor(from)).toBe('preserve the original owner when fencing fails');
      expect(goalObjectiveFor(to)).toBe('');
      expect(continuationByToken(opened.token)?.state).toBe('aborted');
    }
  );

  it('fences a collided source before shadow projection repair while preserving unresolved destination custody', async () => {
    const from = '81818181-dada-bebe-caca-555555555551';
    const to = '82828282-dada-bebe-caca-555555555551';
    const source = await createSession({ title: 'automatic shadow collision before repair', conversationId: from });
    setGoalObjective(from, 'keep this exact objective until the shadow is proved');
    const opened = await openContinuationNow(source.id, from, true);
    const handoff = await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'unresolved-destination-owner');
    expect((await beginContinuationDestinationSendNow(opened.token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(opened.token)).toBe(true);
    const shadow = await createSession({ title: 'recorded replacement', conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' } });
    await recordChatObservations(to, [{ kind: 'user_message', time: Date.now(),
      text: resumeBootstrapText(handoff!.text), messageId: 'm-collision-before-repair' }]);
    const fenceFailure = vi.spyOn(store, 'refuseAutomaticCompactionNow').mockRejectedValueOnce(new Error('private fence write failure'));
    expect(await commitContinuation(opened.token, to)).toBe(false);
    fenceFailure.mockRestore();
    expect(continuationForSession(source.id)?.state).toBe('committing');
    expect((await getSession(source.id))?.conversationId).toBe(from);
    // A failed fence write keeps the incumbent open transaction; retrying its reconciliation
    // must fence the source before the collision can release that single-ticket ownership.
    expect(await commitContinuation(opened.token, to)).toBe(false);
    expect(store.autoCompactionReady({ ...(await getSession(source.id))!, contextTokens: 1_000_000 })).toBe(false);
    expect(continuationByToken(opened.token)?.destinationSend).toEqual({
      state: 'dispatched-unresolved', conversationId: null, messageId: null });
    expect((await getSession(source.id))?.conversationId).toBe(from);
    expect((await getSession(shadow.id))?.conversationId).toBe(to);
    expect(goalObjectiveFor(from)).toBe('keep this exact objective until the shadow is proved');
    expect(goalObjectiveFor(to)).toBe('');
    abortContinuation(opened.token, 'the replacement chat already belongs to another local session');
    await store.flushSessions();
    await resetSessionStoreForTests();
    expect(store.autoCompactionReady({ ...(await getSession(source.id))!, contextTokens: 1_000_000 })).toBe(false);
  });

  it('counts two concurrent exact-shadow repair attempts as one mutation', async () => {
    const from = '81818181-aaaa-bbbb-cccc-444444444444';
    const to = '82828282-aaaa-bbbb-cccc-444444444444';
    const source = await createSession({ title: 'prime before concurrent shadow repair', conversationId: from });
    spawn({ workers: [{ task: 'keep ownership alive during the concurrent repair' }], caller: { conversationId: from } });
    const opened = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(opened.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(opened.token, 'concurrent-shadow-owner');
    await createSession({
      title: 'Resumed · prime before concurrent shadow repair',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: resumeBootstrapText(handoff!.text), messageId: 'm-concurrent-shadow' }
    ]);
    expect(await commitContinuation(opened.token, to)).toBe(false);
    abortContinuation(opened.token, 'the replacement chat already belongs to another local session');
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });

    const results = await Promise.all([repairPrimeFromResumeShadow(to), repairPrimeFromResumeShadow(to)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(primeConversation()).toBe(to);
  });

  it('repairs a stranded Goal onto the current descendant of an aged-out resume shadow', async () => {
    const from = '85858585-1111-2222-3333-444444444444';
    const shadowChat = '86868686-1111-2222-3333-444444444444';
    const currentChat = '87878787-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'source before old shadow collision', conversationId: from });
    setGoalObjective(from, 'finish the release on the current resumed descendant');
    setWorkspaceFor(`chat:${from}`, { virtual: '/workspace/project', real: dir });
    spawn({ workers: [{ task: 'survive long enough for the old WAL to age out' }], caller: { conversationId: from } });

    const broken = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(broken.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(broken.token, 'old-shadow-owner');
    const shadow = await createSession({
      title: 'Resumed · source before old shadow collision',
      conversationId: shadowChat,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(shadowChat, [
      {
        kind: 'user_message',
        time: Date.now(),
        text: resumeBootstrapText(handoff!.text).replace('previous chat', `previous\u00c2\u00a0chat`),
        messageId: 'm-old-shadow-bootstrap'
      }
    ]);
    expect(await commitContinuation(broken.token, shadowChat)).toBe(false);
    abortContinuation(broken.token, 'the replacement chat already belongs to another local session');

    // Model the exact live history: the old collision proof has aged out, but the shadow session
    // itself later completed a normal Compact & Resume B→C and kept its original resume origin.
    resetContinuationsForTests();
    const descendant = await openContinuationNow(shadow.id, shadowChat);
    await attachSummary(descendant.token, SAMPLE_BRIEF);
    await claimContinuationNow(descendant.token, 'shadow-descendant-owner');
    expect(await commitContinuation(descendant.token, currentChat)).toBe(true);
    expect((await getSession(shadow.id))?.chatIds).toEqual([shadowChat, currentChat]);
    expect((await getSession(shadow.id))?.origin).toMatchObject({ kind: 'resume', fromSessionId: source.id });
    expect(goalObjectiveFor(from)).toBe('finish the release on the current resumed descendant');
    expect(goalObjectiveFor(shadowChat)).toBe('');
    expect(goalObjectiveFor(currentChat)).toBe('');

    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(currentChat)).toBe(true);
    expect(primeConversation()).toBe(currentChat);
    expect(goalObjectiveFor(from)).toBe('');
    expect(goalObjectiveFor(shadowChat)).toBe('');
    expect(goalObjectiveFor(currentChat)).toBe('finish the release on the current resumed descendant');
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:')).map((held) => held.key)).toEqual([
      `chat:${currentChat}`
    ]);
  });

  it('does not use a resume origin alone to repair an aged-out shadow without the exact bootstrap', async () => {
    const from = '88888888-1111-2222-3333-444444444444';
    const to = '89898989-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'source with an uncommitted handoff', conversationId: from });
    setGoalObjective(from, 'do not let an unrelated resume-looking chat steal this');
    spawn({ workers: [{ task: 'keep prime ownership available for the negative check' }], caller: { conversationId: from } });
    const broken = await openContinuationNow(source.id, from);
    await attachSummary(broken.token, SAMPLE_BRIEF);
    abortContinuation(broken.token, 'the replacement chat already belongs to another local session');
    await createSession({
      title: 'resume-looking but not the handoff recipient',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: 'some other user text', messageId: 'm-not-the-bootstrap' }
    ]);

    resetContinuationsForTests();
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(to)).toBe(false);
    expect(primeConversation()).toBe(from);
    expect(goalObjectiveFor(from)).toBe('do not let an unrelated resume-looking chat steal this');
    expect(goalObjectiveFor(to)).toBe('');
  });

  it('preserves newer Goal and workspace state already learned by an exact resumed descendant', async () => {
    const from = '8a8a8a8a-1111-2222-3333-444444444444';
    const to = '8b8b8b8b-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'source whose old projections are stranded', conversationId: from });
    setGoalObjective(from, 'older goal stranded on A');
    setWorkspaceFor(`chat:${from}`, { virtual: '/workspace/older', real: dir });

    const broken = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(broken.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(broken.token, 'projection-shadow-owner');
    await createSession({
      title: 'Resumed · source whose old projections are stranded',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: resumeBootstrapText(handoff!.text), messageId: 'm-projection-bootstrap' }
    ]);
    expect(await commitContinuation(broken.token, to)).toBe(false);
    abortContinuation(broken.token, 'the replacement chat already belongs to another local session');

    // The user kept working in B/C before upgrading. Late historical healing must never replace
    // those newer target-owned choices with stale A state; it only removes A's stale projections.
    setGoalObjective(to, 'newer goal already chosen in the resumed chat');
    setWorkspaceFor(`chat:${to}`, { virtual: '/workspace/newer', real: dir });
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(to)).toBe(true);
    expect(goalObjectiveFor(from)).toBe('');
    expect(goalObjectiveFor(to)).toBe('newer goal already chosen in the resumed chat');
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:'))).toEqual([
      { key: `chat:${to}`, virtual: '/workspace/newer' }
    ]);
  });

  it('finishes missing projection repair when the same old run already moved its prime ownership to the shadow', async () => {
    const from = '8c8c8c8c-1111-2222-3333-444444444444';
    const to = '8d8d8d8d-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'source with separately repaired ownership', conversationId: from });
    setGoalObjective(from, 'goal still stranded after ownership repaired first');
    setWorkspaceFor(`chat:${from}`, { virtual: '/workspace/same-run', real: dir });
    spawn({ workers: [{ task: 'prove this is the same live run' }], caller: { conversationId: from } });

    const broken = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(broken.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(broken.token, 'same-run-shadow-owner');
    await createSession({
      title: 'Resumed · source with separately repaired ownership',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: resumeBootstrapText(handoff!.text), messageId: 'm-same-run-bootstrap' }
    ]);
    expect(await commitContinuation(broken.token, to)).toBe(false);
    abortContinuation(broken.token, 'the replacement chat already belongs to another local session');

    // This models the exact live machine: old code/another recovery path already repaired only
    // swarm ownership A→B/C, while Goal/workspace stayed on A. Source A is no longer an owner.
    expect(repairPrimeConversationAfterRecovery(from, to)).toBe(true);
    expect(primeConversation()).toBe(to);
    expect(goalObjectiveFor(from)).toBe('goal still stranded after ownership repaired first');

    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(to)).toBe(true);
    expect(primeConversation()).toBe(to);
    expect(goalObjectiveFor(from)).toBe('');
    expect(goalObjectiveFor(to)).toBe('goal still stranded after ownership repaired first');
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:')).map((held) => held.key)).toEqual([`chat:${to}`]);
  });

  it.each(['exact', 'solo', 'wrong-bootstrap', 'new-source-turn'] as const)(
    'fences an already-repaired legacy source only with its exact abandoned generation (%s)', async shape => {
      const suffix = `44444444444${['exact', 'solo', 'wrong-bootstrap', 'new-source-turn'].indexOf(shape)}`;
      const from = `8c8c8c8c-abab-cdcd-efef-${suffix}`;
      const to = `8d8d8d8d-abab-cdcd-efef-${suffix}`;
      const source = await createSession({ title: 'legacy source whose projections already moved', conversationId: from });
      if (shape !== 'solo') spawn({ workers: [{ task: 'retain the same recovered run' }], caller: { conversationId: from } });
      const broken = await openContinuationNow(source.id, from);
      const handoff = await attachSummary(broken.token, SAMPLE_BRIEF);
      await claimContinuationNow(broken.token, 'legacy-already-repaired-owner');
      await createSession({ conversationId: to, origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' } });
      await recordChatObservations(to, [{ kind: 'user_message', time: Date.now(),
        text: shape === 'wrong-bootstrap' ? 'an unrelated later instruction' : resumeBootstrapText(handoff!.text),
        messageId: 'm-legacy-already-repaired' }]);
      // Pre-upgrade code aborted the collision and moved every projection, without the new
      // source-generation fence. Do not call the upgraded commit/repair to fabricate that state.
      abortContinuation(broken.token, 'the replacement chat already belongs to another local session');
      if (shape !== 'solo') expect(repairPrimeConversationAfterRecovery(from, to)).toBe(true);
      setGoalObjective(to, 'the original task already lives on the replacement');
      await setGoalSwitchNow(to, 'loop', true, true);
      if (shape === 'new-source-turn') await store.appendEvent(source.id, {
        time: Date.now(), source: 'extension', kind: 'turn_start', turnId: 'genuinely-new-source-turn'
      });
      expect(store.autoCompactionReady({ ...(await getSession(source.id))!, contextTokens: 1_000_000 })).toBe(true);
      setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
      // The wrapper still reports no projection mutation and never manufactures a commit/ACK.
      expect((await store.findSessionByConversation(to, { requireUnique: true }))?.origin).toMatchObject({ kind: 'resume', fromSessionId: source.id });
      expect(continuationByToken(broken.token)?.state).toBe('aborted');
      expect(snapshotContinuations().entries.find(entry => entry.token === broken.token)?.sourceTurnId).toBeNull();
      expect(await repairPrimeFromResumeShadow(to)).toBe(false);
      expect(store.autoCompactionReady({ ...(await getSession(source.id))!, contextTokens: 1_000_000 })).toBe(shape !== 'exact' && shape !== 'solo');
      await store.flushSessions();
      await resetSessionStoreForTests();
      expect(store.autoCompactionReady({ ...(await getSession(source.id))!, contextTokens: 1_000_000 })).toBe(shape !== 'exact' && shape !== 'solo');
      const fence = vi.spyOn(store, 'refuseAutomaticCompactionNow');
      expect(await repairPrimeFromResumeShadow(to)).toBe(false);
      expect(fence).not.toHaveBeenCalled();
      expect(continuationByToken(broken.token)?.state).toBe('aborted');
      expect(primeConversation()).toBe(shape === 'solo' ? null : to);
      expect(goalSwitchFor(to)).toMatchObject({ own: true, mode: 'loop', enabled: true });
      expect(goalObjectiveFor(to)).toBe('the original task already lives on the replacement');
    }
  );

  it('repairs a stranded explicit Loop switch after ownership already moved to the exact shadow', async () => {
    const from = '8c8c8c8c-aaaa-bbbb-cccc-444444444444';
    const to = '8d8d8d8d-aaaa-bbbb-cccc-444444444444';
    const source = await createSession({ title: 'source with only a Loop switch stranded', conversationId: from });
    await setGoalSwitchNow(from, 'loop', true, true);
    spawn({ workers: [{ task: 'prove the resumed Loop belongs to this run' }], caller: { conversationId: from } });

    const broken = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(broken.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(broken.token, 'loop-only-shadow-owner');
    await createSession({
      title: 'Resumed · source with only a Loop switch stranded',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: resumeBootstrapText(handoff!.text), messageId: 'm-loop-only-bootstrap' }
    ]);
    expect(await commitContinuation(broken.token, to)).toBe(false);
    abortContinuation(broken.token, 'the replacement chat already belongs to another local session');

    // The historical recovery moved only broker ownership. With no objective or workspace on A,
    // the old early-out used to declare the repair complete and silently leave A's explicit
    // Loop switch behind. The switch is itself a projection and must travel to B exactly once.
    expect(repairPrimeConversationAfterRecovery(from, to)).toBe(true);
    expect(primeConversation()).toBe(to);
    expect(goalObjectiveFor(from)).toBe('');
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:'))).toEqual([]);
    expect(goalSwitchFor(from)).toMatchObject({ own: true, enabled: true, mode: 'loop' });

    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(to)).toBe(true);
    expect(goalSwitchFor(from).own).toBe(false);
    expect(goalSwitchFor(to)).toMatchObject({ own: true, enabled: true, mode: 'loop', afterTurn: true });
    expect(await repairPrimeFromResumeShadow(to)).toBe(false);
  });

  it('refuses to merge an old parked prime into the same shadow chat after that chat starts an independent fresh run', async () => {
    const from = '8e8e8e8e-1111-2222-3333-444444444444';
    const to = '8f8f8f8f-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'old parked owner before shadow', conversationId: from });
    setGoalObjective(from, 'old parked goal must stay isolated');
    setWorkspaceFor(`chat:${from}`, { virtual: '/workspace/old-owner', real: dir });
    spawn({ workers: [{ task: 'park this old owner before a fresh run starts' }], caller: { conversationId: from } });

    const broken = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(broken.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(broken.token, 'independent-run-shadow-owner');
    await createSession({
      title: 'Resumed · old parked owner before shadow',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: resumeBootstrapText(handoff!.text), messageId: 'm-independent-bootstrap' }
    ]);
    expect(await commitContinuation(broken.token, to)).toBe(false);
    abortContinuation(broken.token, 'the replacement chat already belongs to another local session');

    expect(bindConversation('worker-1', 'worker-old-owner')).toBe(true);
    finishAgent({ conversationId: 'worker-old-owner' }, 'park the old owner now');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);

    // C later begins a distinct run while A's complete history remains parked. PRIME on both
    // conversations proves these are two owners, even though C still has the genuine old bootstrap.
    spawn({ workers: [{ task: 'fresh independent run in the descendant chat' }], caller: { conversationId: to } });
    expect(primeConversation()).toBe(to);
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(to)).toBe(false);
    expect(goalObjectiveFor(from)).toBe('old parked goal must stay isolated');
    expect(goalObjectiveFor(to)).toBe('');
    // Workers now retain their exact conversation workspace while sleeping; the unrelated
    // descendant must still receive neither the old prime nor its worker workspace.
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:')).map((held) => held.key).sort()).toEqual([`chat:${from}`, 'chat:worker-old-owner'].sort());
    expect(swarmStateForCaller({ conversationId: from }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      conversationId: 'worker-old-owner',
      state: 'sleeping'
    });
  });
});

/**
 * Issue #21: a handoff that was still being written got declared dead at ten minutes.
 *
 * The deadline is a limit on *waiting*, but it was measured from the moment the transaction
 * opened — so a brief ChatGPT was still generating looked exactly like one nobody had touched.
 * On a 730k-token chat under Pro reasoning the generation took longer than that, and the reported
 * consequence was worse than a lost handoff: once the running continuation expired,
 * auto-compaction treated the compaction itself as an eligible turn, stopped it, and started
 * another one on top.
 *
 * A manual handoff is now durable until commit or explicit cancellation. Progress still updates
 * its activity stamp for diagnostics, but elapsed time alone never discards the transaction.
 */
describe('an exact handoff response owns its waiting deadline', () => {
  it('survives growing output, restart, and prolonged unchanged snapshots', async () => {
    vi.useFakeTimers();
    try {
      const session = await createSession({ title: 'long handoff', conversationId: CHAT_A });
      const opened = await openContinuationNow(session.id, CHAT_A);
      await beginContinuationSourceSendNow(opened.token);
      await dispatchContinuationSourceSendNow(opened.token);
      await bindContinuationSourceMessageNow(opened.token, 'exact-user-message');
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS - 60_000);
      expect(await bindContinuationSourceMessageNow(opened.token, 'wrong-message', 500)).toBe(false);
      expect(await bindContinuationSourceMessageNow('wrong-token', 'exact-user-message', 500)).toBe(false);
      expect(await bindContinuationSourceMessageNow(opened.token, 'exact-user-message', 500)).toBe(true);
      vi.setSystemTime(Date.now() + 2 * 60_000);
      expect(continuationByToken(opened.token)?.state).toBe('awaiting-summary');
      const snapshot = snapshotContinuations();
      resetContinuationsForTests();
      await restoreContinuations(snapshot);
      expect(continuationByToken(opened.token)?.state).toBe('awaiting-summary');
      expect(await bindContinuationSourceMessageNow(opened.token, 'exact-user-message', 500)).toBe(true);
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS);
      expect(continuationByToken(opened.token)?.state).toBe('awaiting-summary');
      expect(await bindContinuationSourceMessageNow(opened.token, 'exact-user-message', 1000)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

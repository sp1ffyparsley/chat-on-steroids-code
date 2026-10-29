import { assertOperatorPromptEnvelope, operatorPromptBody } from '../src/shared/operator-prompt.mjs';
import { GOAL_MARKER_INSTRUCTION } from '../src/shared/goal-templates.js';
import { currentCoreInstructions } from '../src/main/mcp/instructions.js';
import { prependUserPrompt, userPromptText } from '../src/shared/user-prompt.js';
import { finishInstruction } from '../src/shared/finish.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { addProject, armProjectCreate, assignSessionProject, claimProjectCreate, completeProjectCreate } from '../src/main/projects.js';
import { initSkills, removeSkill } from '../src/main/skills.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';
import { PRIME_CORE_PREFLIGHT_INSTRUCTIONS } from '../src/main/session/prompt.js';
import * as browserWake from '../src/main/browser-wake.js';
import { CHAT_SILENCE_MS } from '../src/shared/session.js';
import { ROUTE_SETTLE_MS, noteTunnelClientConnected, resetRouteSettleForTests } from '../src/main/tunnel/route-settle.js';
type Handler = (event: unknown, payload: unknown) => Promise<any>;
const handlers = new Map<string, Handler>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {}, nativeTheme: { themeSource: 'system' },
  app: { getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async (data: Buffer) => ({ result: data.toString(), shouldReEncrypt: false })
  }
}));
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd() }));
vi.mock('../src/main/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/connection.js')>();
  return { ...actual, connect: async () => {}, getStatus: () => ({ ...actual.getStatus(), state: 'connected' }) };
});
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: async () => 'chrome.exe', isPreferredBrowserRunning: vi.fn(async () => null) }));
const { defaultConfig, getActiveInstanceRuntime, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, flushDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { createSession, rebindSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { registerIpc } = await import('../src/main/ipc.js');
const { bridgePort, startBridge, stopBridge, stopRecoverySweepTimerForTests } = await import('../src/main/bridge.js');
const input = await import('../src/main/session/input.js');
const goal = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');
let directory: string;
let bearer: string;
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const pushed = vi.fn();
async function post(route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-extension-version': APP_VERSION,
      'x-extension-protocol': String(BRIDGE_PROTOCOL), ...(route === '/pair' ? { origin: EXTENSION_ORIGIN } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  directory = await makeTempDir('clf-input-integration-');
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  await initSkills(directory, { installDefaults: false });
  await saveConfig(defaultConfig());
  registerIpc(() => ({ isDestroyed: () => false, webContents: { send: pushed } }) as never, () => undefined);
  await startBridge();
  // These tests move a mocked Date.now by minutes and call the sweep themselves. Keep the
  // bridge's real 30-second maintenance timer from interleaving another recovery sweep
  // against that advanced clock between the fixture's explicit steps.
  stopRecoverySweepTimerForTests();
  // This fixture is a migrated legacy singleton, but bind it exactly the way the current
  // companion does anyway. That keeps the delivery suite honest if its bootstrap later moves
  // to an isolated instance, without weakening the bridge's missing/mismatched-instance fences.
  const paired = await post('/pair', { instanceId: getActiveInstanceRuntime().profile.id });
  expect(paired.status).toBe(200);
  bearer = paired.body.token;
});
beforeEach(async () => {
  resetRouteSettleForTests();
  await writeDurableNow('session-input', []);
  await writeDurableNow('plugin-refresh', []);
  goal.resetGoalStateForTests(); input.resetInputForTests(); pushed.mockClear();
  const plugins = await import('../src/main/plugin-refresh.js');
  plugins.resetPluginRefreshForTests();
  const tools = [{ name: 'test_ready', description: 'Ready Core fixture.', inputSchema: { type: 'object' } }];
  plugins.publishPluginSurface('core', 'Chat On Steroids Core', 'test', '', tools);
  const [request] = await plugins.pendingPluginRefreshes();
  expect(request).toBeDefined();
  expect(await plugins.claimPluginRefresh({
    id: request!.id,
    appId: 'asdk_app_input_delivery_fixture',
    connectorName: request!.connectorName,
    tools,
    alreadyCurrent: true,
  })).toBe(true);
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false } });
});
it.each([false, true])('retires Goal only when queued input commits its exact source, including restored aliases (%s)', async alias => {
  const store = await import('../src/main/session/store.js');
  const durable = await import('../src/main/durable.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Queue before Goal commitment', conversationId });
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'templates' } });
    await goal.setGoalObjectiveNow(conversationId, 'Complete the current requested work');
    await goal.setGoalSwitchNow(conversationId, 'goal', true);
    const row = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, mode: 'after-turn' });
    now += 10;
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-5.6-sol', time: now },
      { kind: 'turn_start', turnId: 'queue-source', time: now },
      { kind: 'assistant_message', turnId: 'queue-source', messageId: 'queue-source-answer', text: 'Current result', state: 'final', final: true, time: now + 1 },
      { kind: 'turn_end', turnId: 'queue-source', outcome: 'completed', time: now + 2 }
    ] });
    now += 3;
    const [answer] = await store.readRecentEvents(session.id, 1, { kinds: ['assistant_message'] });
    expect(answer?.kind).toBe('assistant_message');
    const source = alias && answer?.kind === 'assistant_message' ? `reply:${answer.messageId}` : 'queue-source';
    const obligation = { conversationId, sessionId: session.id, replyId: 'queue-source-obligation', turnId: source, eventSeq: answer!.seq, blocked: false };
    await goal.acceptGoalReplyNow(obligation);
    expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe(obligation.replyId);
    const activity = async () => {
      const response = await fetch(`http://127.0.0.1:${bridgePort()}/activity?conversationId=${conversationId}`, {
        headers: { authorization: `Bearer ${bearer}`, 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL) }
      });
      expect(response.status).toBe(200);
      return await response.json() as any;
    };
    expect(await input.claimBrowserInput(row.id, 'queue-page', conversationId, true)).not.toBeNull();
    expect((await activity()).goal.queuePending).toBe(true);
    expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe(obligation.replyId);
    expect(await input.failBrowserInput(row.id, 'queue-page', 'After-turn pickup was withdrawn before Send.')).toBe(true);
    expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe(obligation.replyId);
    expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('queued');

    now += input.RECOVERY_WITHDRAW_REOFFER_DELAYS_MS[0];
    expect(await input.claimBrowserInput(row.id, 'queue-page-retry', conversationId, true)).not.toBeNull();
    expect(await input.authorizeBrowserInput(row.id, 'queue-page-retry', conversationId)).toBe(true);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    expect(await input.acknowledgeBrowserInput(row.id, 'queue-page-retry', conversationId, 'queued-user-message')).toBe(true);
    await flushDurable();
    const saved = await durable.readDurable<Parameters<typeof goal.restoreGoalReplies>[0]>(goal.GOAL_REPLIES_STATE);
    const switches = goal.snapshotGoalSwitches(), objectives = goal.snapshotGoalObjectives();
    await writeDurableNow('session-input', []); // Simulate receipt retention pruning after other sessions advance.
    input.resetInputForTests(); goal.resetGoalStateForTests(); goal.restoreGoalSwitches(switches); goal.restoreGoalObjectives(objectives); goal.restoreGoalReplies(saved);
    await goal.acceptGoalReplyNow(obligation); // Replayed old final cannot recreate the handled obligation.
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    expect(await input.inputBeforeGoal(session.id, 'queue-source')).toBeNull();
    await goal.acceptGoalReplyNow({ ...obligation, replyId: 'new-source-obligation', turnId: 'new-source', eventSeq: answer!.seq + 100 });
    expect(goal.goalPendingReplyFor(conversationId)?.turnId).toBe('new-source');
  } finally { clock.mockRestore(); }
});

it('backs off and attempt-bounds repeated automatic Continue withdrawals on one UUID and source turn', async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Bounded recovery refusal', conversationId });
    const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-5.6-sol', time: now },
      { kind: 'turn_start', turnId: 'bounded-source', time: now },
      { kind: 'assistant_message', turnId: 'bounded-source', messageId: 'bounded-answer', text: 'Checkpoint', state: 'final', final: true, time: now + 1 },
      { kind: 'turn_end', turnId: 'bounded-source', outcome: 'completed', time: now + 2 }
    ] });
    now += 3;
    const withdraw = async (owner: string, detail: string) => {
      const claim = { id: row.id, owner, conversationId, requiresAuthorization: true };
      expect((await post('/input/claim', claim)).body.input).toMatchObject({ id: row.id, completedTurnId: 'bounded-source' });
      expect((await post('/input/fail', { ...claim, error: 'After-turn pickup was withdrawn before Send.', detail })).body.ok).toBe(true);
    };

    await withdraw('bounded-page-1', 'send-not-ready');
    const started = (await input.listInputs()).find(entry => entry.id === row.id)!;
    expect(started).toMatchObject({ id: row.id, state: 'queued', recoveryWithdrawnSince: now,
      recoveryWithdrawAttempts: 1, dueAt: now + input.RECOVERY_WITHDRAW_REOFFER_DELAYS_MS[0] });
    expect(await input.pendingBrowserInputs()).toEqual([]);

    for (let index = 1; index < input.RECOVERY_WITHDRAW_REOFFER_DELAYS_MS.length; index++) {
      now += input.RECOVERY_WITHDRAW_REOFFER_DELAYS_MS[index - 1]! - 1;
      expect(await input.pendingBrowserInputs()).toEqual([]);
      now++;
      expect(await input.pendingBrowserInputs()).toEqual([expect.objectContaining({ id: row.id })]);
      await withdraw(`bounded-page-${index + 1}`, index === 1 ? 'page-unreadable' : 'journal-pending');
      expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({
        id: row.id,
        state: 'queued',
        recoveryWithdrawnSince: started.recoveryWithdrawnSince,
        recoveryWithdrawAttempts: index + 1,
        dueAt: now + input.RECOVERY_WITHDRAW_REOFFER_DELAYS_MS[index]!
      });
    }

    now += input.RECOVERY_WITHDRAW_REOFFER_DELAYS_MS.at(-1)!;
    await withdraw('bounded-page-4', 'app-refused');
    const terminal = (await input.listInputs()).filter(entry => entry.id === row.id);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      id: row.id,
      state: 'failed',
      owner: null,
      recoveryWithdrawnSince: started.recoveryWithdrawnSince,
      recoveryWithdrawAttempts: input.RECOVERY_WITHDRAW_REOFFER_DELAYS_MS.length + 1,
      error: 'Automatic Continue was not sent: app-refused'
    });
    expect(await input.pendingBrowserInputs()).toEqual([]);
  } finally { clock.mockRestore(); }
});

it('wall-bounds automatic Continue withdrawals even when retry attempts remain', async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Wall-bounded recovery refusal', conversationId });
    const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await post('/events', { conversationId, events: [
      { kind: 'turn_start', turnId: 'wall-source', time: now },
      { kind: 'assistant_message', turnId: 'wall-source', messageId: 'wall-answer', text: 'Checkpoint', state: 'final', final: true, time: now + 1 },
      { kind: 'turn_end', turnId: 'wall-source', outcome: 'completed', time: now + 2 }
    ] });
    now += 3;
    const withdraw = async (owner: string, detail: string) => {
      const claim = { id: row.id, owner, conversationId, requiresAuthorization: true };
      expect((await post('/input/claim', claim)).body.input).toMatchObject({ id: row.id, completedTurnId: 'wall-source' });
      expect((await post('/input/fail', { ...claim, error: 'After-turn pickup was withdrawn before Send.', detail })).body.ok).toBe(true);
    };
    await withdraw('wall-page-1', 'send-not-ready');
    const since = (await input.listInputs()).find(entry => entry.id === row.id)!.recoveryWithdrawnSince;
    now += input.RECOVERY_WITHDRAW_LIMIT_MS;
    await withdraw('wall-page-2', 'page-unreadable');
    expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'failed', recoveryWithdrawnSince: since, recoveryWithdrawAttempts: 2,
      error: 'Automatic Continue was not sent: page-unreadable'
    });
  } finally { clock.mockRestore(); }
});

it('rejects a recovery whose exact authored question is no longer the current source owner', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Stale recovery question', conversationId });
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
  await post('/events', { conversationId, events: [
    { kind: 'user_message', messageId: 'current-question', text: 'Current source', time: Date.now() },
    { kind: 'turn_start', turnId: 'question-source', time: Date.now() + 1 },
    { kind: 'assistant_message', turnId: 'question-source', messageId: 'question-answer', text: 'Done', state: 'final', final: true, time: Date.now() + 2 },
    { kind: 'turn_end', turnId: 'question-source', outcome: 'completed', time: Date.now() + 3 }
  ] });
  const claimed = await input.claimBrowserInput(row.id, 'stale-question-page', conversationId, true);
  expect(claimed).toMatchObject({ id: row.id, completedTurnId: 'question-source' });
  await writeDurableNow('session-input', [{ ...claimed!, recovery: {
    questionId: 'older-question', pro: false, busyUntil: Date.now() + 60_000, phase: 'ready'
  } }]);
  input.resetInputForTests();

  expect(await input.failBrowserInput(row.id, 'stale-question-page',
    'After-turn pickup was withdrawn before Send.')).toBe(true);
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({
    state: 'failed', owner: null,
    error: expect.stringContaining('recovery source changed before native Send')
  });
});

it('re-arms one authorized recovery UUID only after exact confirmed-unsent proof', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Authorized recovery withdrawal', conversationId });
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
  await post('/events', { conversationId, events: [
    { kind: 'user_message', messageId: 'owned-question', text: 'Owned source', time: Date.now() },
    { kind: 'turn_start', turnId: 'owned-source', time: Date.now() + 1 },
    { kind: 'assistant_message', turnId: 'owned-source', messageId: 'owned-answer', text: 'Done', state: 'final', final: true, time: Date.now() + 2 },
    { kind: 'turn_end', turnId: 'owned-source', outcome: 'completed', time: Date.now() + 3 }
  ] });
  const owner = 'authorized-recovery-page';
  const claimed = await input.claimBrowserInput(row.id, owner, conversationId, true);
  await writeDurableNow('session-input', [{ ...claimed!, recovery: {
    questionId: 'owned-question', pro: false, busyUntil: Date.now() + 60_000, phase: 'ready'
  } }]);
  input.resetInputForTests();
  expect(await input.authorizeBrowserInput(row.id, owner, conversationId)).toBe(true);
  expect(await input.failBrowserInput(row.id, owner, 'After-turn pickup was withdrawn before Send.', {
    confirmedUnsent: true, conversationId, detail: 'app-refused'
  })).toBe(true);
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({
    id: row.id, state: 'queued', owner: null, recoveryWithdrawAttempts: 1,
    error: undefined
  });
});

it.each(['legacy-English', 'typed-localized'])('refreshes account models after an owned picker failure without authorizing another tab (%s)', async variant => {
  const catalog = await import('../src/main/chat-models.js');
  const logger = await import('../src/main/logger.js');
  const warning = vi.spyOn(logger, 'logWarn');
  catalog.resetChatModelsForTests();
  const row = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto' });
  await post('/input/claim', { id: row.id, owner: 'picker-page', conversationId: null });
  const failure = { id: row.id, owner: 'foreign-page', error: variant === 'legacy-English'
    ? 'Requested model or reasoning could not be confirmed' : 'Das Modell konnte nicht bestaetigt werden: PRIVATE_PROVIDER_COPY',
    ...(variant === 'typed-localized' ? { detail: 'model-unconfirmed' } : {}) };
  expect((await post('/input/fail', failure)).body.ok).toBe(false);
  expect(catalog.pendingChatModelRequest()).toBeNull();
  expect((await post('/input/fail', { ...failure, owner: 'picker-page' })).body.ok).toBe(true);
  expect(catalog.pendingChatModelRequest()).toMatchObject({ allowOpen: false });
  expect(pushed).toHaveBeenCalledWith('chatModels:changed', expect.objectContaining({ state: 'pending' }));
  expect((await input.listInputs()).find(input => input.id === row.id)?.state).toBe('failed');
  const logs = warning.mock.calls.map(call => String(call[0])).filter(line => line.includes('browser_send_failure'));
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('disposition=failed');
  expect(logs[0]).not.toContain('PRIVATE_PROVIDER_COPY');
  warning.mockRestore();
  catalog.resetChatModelsForTests();
});

it.each([false, true])('collects an exact recorded helper final across document loss (final before ACK: %s)', async finalBeforeAck => {
  const controller = new AbortController();
  const helper = randomUUID();
  await createSession({ title: 'Decision helper', conversationId: helper });
  const answer = input.requestBrowserDecision('Choose the next action', controller.signal, { conversationId: helper });
  void answer.catch(() => undefined);
  try {
    const [row] = await input.listInputs();
    expect(operatorPromptBody((await post('/input/claim', { id: row!.id, owner: 'lost-document', conversationId: helper })).body.input.text!)).toBe('Choose the next action');
    const final = () => post('/events', { conversationId: helper, events: [
      { kind: 'user_message', messageId: 'decision-user', text: 'Choose the next action', time: Date.now() },
      { kind: 'assistant_message', messageId: 'decision-final', turnId: 'decision-turn', text: '{"next":"continue"}',
        state: 'final', final: true, goalEligible: true, time: Date.now() }
    ] });
    if (finalBeforeAck) expect((await final()).status).toBe(200);
    expect((await post('/input/ack', { id: row!.id, owner: 'lost-document', conversationId: helper, messageId: 'decision-user' })).body.ok).toBe(true);
    if (!finalBeforeAck) expect((await final()).status).toBe(200);
    expect((await input.listInputs()).find(entry => entry.id === row!.id)).toMatchObject({ state: 'sent', response: '{"next":"continue"}' });
    await expect(answer).resolves.toBe('{"next":"continue"}');
    expect(await input.pendingBrowserInputs()).toEqual([]);
  } finally { controller.abort(); await answer.catch(() => undefined); }
});

it.each(['stop', 'continue', 'invalid-json', 'paused', 'objective-revision', 'human-revision', 'plan-revision',
  'no-native-ack', 'retired-waiter', 'route-before-debt', 'retire-during-archive', 'fence-during-archive',
  'strict-fence-during-archive'] as const)
('preserves exact helper answer custody when strict source completion becomes unresolved before collection (%s)', async variant => {
  const bridge = await import('../src/main/bridge.js');
  const evidence = await import('../src/main/core-browser-evidence.js');
  const store = await import('../src/main/session/store.js');
  const conversationId = randomUUID(), userId = randomUUID(), finalId = randomUUID();
  const sourceTurnId = 'g-strict-late-native-fence-' + randomUUID();
  const lateFenceDuringArchive = variant === 'fence-during-archive' || variant === 'strict-fence-during-archive';
  const owner = 'strict-helper-native-document';
  const response = variant === 'continue' ? '{"action":"continue","reply":"Continue the original authorized work."}'
    : variant === 'invalid-json' ? '{"action":' : '{"action":"stop","reply":""}';
  let helper: import('../src/main/session/input.js').InputEntry | undefined;
  let archive: string | undefined;
  let releaseArchive = () => {};
  let archiveOpen: ReturnType<typeof vi.spyOn> | undefined;
  try {
    // The suite resets Goal between cases; restore the same two concrete owners
    // registerIpc installed before that reset, without replacing their behavior.
    goal.configureLoopForwardReadiness(bridge.settledTurnContinuationAllowed, bridge.goalNativeCompletionReady);
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal,
      enabled: true, mode: 'goal', backend: 'chatgpt',
      continuationPolicy: variant === 'fence-during-archive' ? 'settled-turn' : 'strict' } });
    expect((await post('/status', { openConversations: [], inventoryComplete: false, authState: 'signed-in' })).status).toBe(200);
    const session = await createSession({ title: 'Strict helper collection custody', conversationId });
    await goal.setGoalObjectiveNow(conversationId, 'Verify the original returned native result before completing this task.');
    await goal.setGoalSwitchNow(conversationId, 'goal', true);
    const time = Date.now();
    expect((await post('/events', { conversationId, events: [
      { kind: 'user_message', messageId: userId, text: 'Verify the original returned native result.', time },
      { kind: 'turn_start', turnId: sourceTurnId, time },
      { kind: 'assistant_message', messageId: finalId, providerMessageId: finalId, turnId: sourceTurnId,
        text: 'Saved the original checkpoint.', state: 'final', final: true, time },
      { kind: 'turn_end', turnId: sourceTurnId, outcome: 'completed', time }
    ] })).status).toBe(200);
    const [final] = await store.readRecentEvents(session.id, 1, { kinds: ['assistant_message'] });
    if (lateFenceDuringArchive) expect((await post(`/activity?conversationId=${conversationId}`, {
      observationOnly: true, coreDiagnostic: { documentId: 'strict-source-document', navigationEpoch: 0,
        observedAt: Date.now(), shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: sourceTurnId,
        ordinaryFinal: { reason: 'associated', questions: 1, calls: 0, openCalls: 0, codeCalls: 0, openCodeCalls: 0,
          activeTurnMapped: false, sourceUserMessageId: userId, settledFinalMessageId: finalId,
          coreCallMessageIds: [], allCoreRequestIds: [], codeCallMessageIds: [], answeredCodeCallMessageIds: [] } }
    })).status).toBe(200);
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, replyId: finalId,
      turnId: sourceTurnId, eventSeq: final!.seq, blocked: false });
    expect((await post('/goal/draft', { conversationId, turnId: sourceTurnId,
      clientId: 'strict-source-helper-page' })).status).toBe(200);
    await vi.waitFor(async () => {
      helper = (await input.listInputs()).find(row => row.purpose === 'decision' && row.decisionSourceSessionId === session.id);
      expect(helper).toBeDefined();
    });
    const id = helper!.id, claim = { id, owner, conversationId: null, requiresAuthorization: true };
    archive = path.join((await import('node:os')).tmpdir(), 'CoS-helper-outputs', `${id}.json`);
    expect((await post('/input/claim', claim)).body.input?.id).toBe(id);
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
    if (variant !== 'no-native-ack')
      expect((await post('/input/ack', { id, owner, conversationId: null, messageId: randomUUID() })).body.ok).toBe(true);
    const nativeSent = (await input.listInputs()).find(row => row.id === id)!;
    expect(nativeSent).toMatchObject({ state: variant === 'no-native-ack' ? 'browser' : 'decision', requiresAuthorization: true,
      decisionSourceSessionId: session.id, decisionSourceTurnId: sourceTurnId });
    if (variant === 'no-native-ack') expect(nativeSent.messageId).toBeUndefined();
    else expect(nativeSent.messageId).toBeTruthy();
    if (variant === 'route-before-debt') {
      expect(bridge.goalNativeCompletionReady(conversationId)).toBe(true);
      const before = await input.listInputs();
      expect(typeof await bridge.settledTurnInputForwardProof(nativeSent, before, 'collect')).toBe('function');
      const foreign = await post('/input/answer', { id, owner, conversationId: randomUUID(), response });
      expect(foreign.body.ok).toBe(false);
      expect(await input.listInputs()).toEqual(before);
      expect(await input.browserDecisionOutputSaved(id, owner, null)).toBe(false);
      return;
    }

    // The same exact original can expose a late missing result after its helper was
    // admitted. This withholds STOP/Send authority without making that answer disposable.
    const publishMissingResult = () => post(`/activity?conversationId=${conversationId}`, { observationOnly: true,
      coreDiagnostic: { documentId: 'strict-source-document', navigationEpoch: 0, observedAt: Date.now(),
        shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: sourceTurnId,
        ordinaryFinal: { reason: 'open-call', questions: 1, calls: 1, openCalls: 1, codeCalls: 0,
          openCodeCalls: 0, activeTurnMapped: false, sourceUserMessageId: userId,
          settledFinalMessageId: finalId, coreCallMessageIds: ['strict-original-native-parent'],
          allCoreRequestIds: ['wfr_strict_original_unresolved'], openRequestIds: ['wfr_strict_original_unresolved'] }
      } });
    if (!lateFenceDuringArchive) expect((await publishMissingResult()).status).toBe(200);
    let originalFence = evidence.coreBrowserEvidence(conversationId)?.pendingCompletion;
    const obligation = goal.goalPendingReplyFor(conversationId);
    const obligationLedger = goal.snapshotGoalReplies().replies.find(row => row.conversationId === conversationId);
    const originalDraft = goal.goalViewFor(conversationId)!;
    if (lateFenceDuringArchive) {
      expect(originalFence).toBeNull();
      expect(bridge.goalNativeCompletionReady(conversationId)).toBe(true);
      const proof = await bridge.settledTurnInputForwardProof(nativeSent, await input.listInputs(), 'collect');
      expect(typeof proof).toBe('function');
    } else {
      expect(originalFence).toMatchObject({ sourceUserMessageId: userId, calls: 1, openCalls: 1 });
      expect(bridge.goalNativeCompletionReady(conversationId)).toBe(false);
      expect(await bridge.settledTurnInputForwardProof(nativeSent, await input.listInputs(), 'collect')).toBe(false);
    }

    // Foreign publications cannot exploit the collection/forwarding split.
    const beforeForeign = await input.listInputs();
    expect((await post('/input/answer', { id, owner: 'foreign-native-document', conversationId: null, response })).status).toBe(409);
    expect((await post('/input/answer', { id, owner, conversationId: randomUUID(), response })).body.ok).toBe(false);
    expect(await input.listInputs()).toEqual(beforeForeign);
    if (variant === 'paused') await saveConfig({ ...defaultConfig(),
      goal: { ...defaultConfig().goal, enabled: true, mode: 'goal', backend: 'chatgpt', continuationPolicy: 'strict' },
      ui: { ...defaultConfig().ui, automationPaused: true } });
    if (variant === 'objective-revision') await goal.setGoalObjectiveNow(conversationId, 'A genuine revised original objective.');
    if (variant === 'human-revision') {
      const text = 'A genuine amended human requirement.';
      await store.upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', messageId: userId,
        time: Date.now(), message: { text, chars: text.length, truncated: false } });
    }
    if (variant === 'plan-revision') await store.updateSessionPlan(session.id, conversationId, { plan: [], checklist: [{
      id: 'new-source-requirement', source: 'Original user request', requirement: 'Verify the amended source requirement.',
      acceptance: 'Read back its genuine result.', status: 'pending'
    }] }, Date.now());
    if (variant === 'retired-waiter') {
      goal.retireGoalDraftsFor(conversationId);
      await vi.waitFor(async () => expect((await input.listInputs()).find(row => row.id === id)?.state).toBe('cancelled'));
    }

    let atArchive: Promise<void> | undefined;
    if (variant === 'retire-during-archive' || lateFenceDuringArchive) {
      let entered = () => {};
      atArchive = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { releaseArchive = resolve; });
      const open = fs.open;
      archiveOpen = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        if (typeof file === 'string' && file.startsWith(archive + '.') && file.endsWith('.tmp')) {
          entered(); await gate;
        }
        return open(file, flags, mode);
      });
    }
    const publication = post('/input/answer', { id, owner, conversationId: null, response });
    if (atArchive) {
      await atArchive;
      if (variant === 'retire-during-archive') goal.retireGoalDraftsFor(conversationId);
      else {
        expect((await publishMissingResult()).status).toBe(200);
        originalFence = evidence.coreBrowserEvidence(conversationId)?.pendingCompletion;
        expect(originalFence).toMatchObject({ sourceUserMessageId: userId, calls: 1, openCalls: 1 });
      }
      releaseArchive();
    }
    const collected = await publication;
    archiveOpen?.mockRestore(); archiveOpen = undefined;
    expect(collected.status).toBe(variant === 'retired-waiter' ? 409 : 200);
    expect(evidence.coreBrowserEvidence(conversationId)?.pendingCompletion).toEqual(originalFence);
    if (variant !== 'retired-waiter' && variant !== 'retire-during-archive')
      expect(goal.goalPendingReplyFor(conversationId)).toEqual(obligation);
    expect(bridge.goalNativeCompletionReady(conversationId)).toBe(false);
    expect((await input.listInputs()).filter(row => row.sourceHelperId === id)).toEqual([]);
    expect((await input.listInputs()).find(row => row.id === id)?.goalStopDisposition).toBeUndefined();
    if (variant === 'no-native-ack' || variant === 'retired-waiter') {
      expect(collected.body.ok).not.toBe(true);
      expect((await input.listInputs()).find(row => row.id === id)?.decisionOutput).toBeUndefined();
      await expect(fs.stat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
      if (variant === 'retired-waiter') {
        // Recorder's allowMissingWaiter path cannot revive this explicitly retired helper.
        expect(await input.completeBrowserDecision(id, owner, response, null, true)).toBe(false);
      }
      return;
    }
    expect(collected.body.ok).toBe(variant !== 'retire-during-archive');
    const archived = (await input.listInputs()).find(row => row.id === id)!;
    const error = variant === 'objective-revision' ? 'goal_canonical_scope_changed'
      : variant === 'human-revision' ? 'goal_human_history_changed'
        : variant === 'plan-revision' ? 'goal_plan_changed' : 'native_completion_unverified';
    expect(archived).toMatchObject({ state: 'failed', goalDecisionRejection: error,
      messageId: nativeSent.messageId, sendAuthorizedAt: nativeSent.sendAuthorizedAt, deliveredAt: nativeSent.deliveredAt });
    expect(archived.decisionOutput).toMatchObject({
      sha256: createHash('sha256').update(response).digest('hex'), bytes: Buffer.byteLength(response) });
    expect(await input.browserDecisionOutputSaved(id, owner, null)).toBe(true);
    expect(JSON.parse(await fs.readFile(archive, 'utf8'))).toMatchObject({ inputId: id, owner,
      sourceSessionId: session.id, sourceTurnId, response });
    if (variant === 'retire-during-archive') {
      expect(goal.goalViewFor(conversationId)).toBeNull();
      await flushDurable();
      input.resetInputForTests(); resetDurableForTests(); initDurableStore(directory);
      expect((await post('/input/answer', { id, owner, conversationId: null, response })).body.ok).toBe(true);
      expect(await input.browserDecisionOutputSaved(id, owner, null)).toBe(true);
      expect(goal.goalViewFor(conversationId)).toBeNull();
      expect((await input.listInputs()).filter(row => row.sourceHelperId === id)).toEqual([]);
      return;
    }
    await vi.waitFor(() => expect(goal.goalViewFor(conversationId)).toMatchObject({ stage: 'failed' }));
    const failed = goal.goalViewFor(conversationId)!;
    expect(failed.token).toBe(originalDraft.token);
    expect(failed.error).toContain(error === 'goal_plan_changed' ? 'goal_browser_plan_changed' : error);
    expect(failed.retryable).toBe(false);
    expect(await goal.ackGoalDraftNow(conversationId, failed.token, 'strict-source-helper-page')).toBe(true);
    expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === conversationId)).toEqual(obligationLedger);
    expect(goal.goalPendingReplyFor(conversationId)).toEqual(obligation);
    expect((await input.listInputs()).filter(row => row.decisionSourceSessionId === session.id)).toHaveLength(1);
    // The recorded source remains blocked; another native draft request cannot open a helper.
    const repeated = await post('/goal/draft', { conversationId, turnId: sourceTurnId,
      clientId: 'strict-no-repeat-helper' });
    if (variant === 'fence-during-archive') {
      expect(repeated.status).toBe(200);
      expect(repeated.body.goal).toMatchObject({ token: failed.token, stage: 'failed', retryable: false });
    } else expect(repeated.status).toBe(variant === 'paused' ? 423 : 409);
    expect((await input.listInputs()).filter(row => row.decisionSourceSessionId === session.id)).toHaveLength(1);
    await flushDurable();
    input.resetInputForTests(); resetDurableForTests(); initDurableStore(directory);
    expect((await input.listInputs()).find(row => row.id === id)?.response).toBeUndefined();
    expect((await post('/input/answer', { id, owner, conversationId: null, response })).body.ok).toBe(true);
    expect(await input.browserDecisionOutputSaved(id, owner, null)).toBe(true);
    expect((await post('/input/answer', { id, owner, conversationId: null, response: response + ' ' })).body.ok).toBe(false);
    expect((await input.listInputs()).filter(row => row.sourceHelperId === id)).toEqual([]);
  } finally {
    releaseArchive(); archiveOpen?.mockRestore();
    goal.retireGoalDraftsFor(conversationId);
    if (helper) await input.cancelInput(helper.id);
    if (archive) await fs.rm(archive, { force: true });
  }
});

it('wakes the connected browser as soon as a temporary helper enters the durable outbox', async () => {
  const controller = new AbortController();
  const wake = vi.spyOn(browserWake, 'wakeBrowserWork');
  const answer = input.requestBrowserDecision('Wake this helper now', controller.signal, { lifetime: 'temporary-planner' });
  void answer.catch(() => undefined);
  try {
    await vi.waitFor(() => expect(wake).toHaveBeenCalled());
    const [row] = await input.listInputs();
    expect(row).toMatchObject({ lifetime: 'temporary-planner', state: 'queued', owner: null });
    // Waking is only a prompt to read the durable outbox; it must not claim the helper.
    expect(await input.pendingBrowserInputs()).toEqual([expect.objectContaining({ id: row!.id })]);
  } finally {
    controller.abort();
    await answer.catch(() => undefined);
    wake.mockRestore();
  }
});

it('does not pin an idle chat to tool transport because another call is unattributed', async () => {
  const { trackInFlight, emptyEvidence } = await import('../src/main/mcp/call-context.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Completed target', conversationId });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-5.6-sol', time: Date.now() },
    { kind: 'turn_start', turnId: 'completed-before-input', time: Date.now() },
    { kind: 'turn_end', turnId: 'completed-before-input', outcome: 'completed', time: Date.now() }
  ] });
  let row!: import('../src/main/session/input.js').InputEntry;
  await trackInFlight({ startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { requestId: null, transportKey: null, conversationId: null } }, async () => {
    row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
    expect(row.transportIntent).toBeUndefined();
    expect((await input.sessionInputPolicy(session.id)).canInject).toBe(false);
    expect(await input.claimBrowserInput(row.id, 'fresh-document', conversationId)).toBeNull();
  });
  expect(await input.claimBrowserInput(row.id, 'fresh-document', conversationId)).not.toBeNull();
});

it('projects and delivers a direct correction through the real recorder, bridge claim and native receipt', async () => {
  const { sessionControlsFor } = await import('../src/main/bridge.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Tool-free correction', conversationId });
  const time = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-5.6-sol', reasoningEffort: 'high', time },
    { kind: 'user_message', messageId: 'plain-user', text: 'Explain the idea without tools', time },
    { kind: 'turn_start', turnId: 'plain-turn', time: time + 1 }
  ] });
  expect(await sessionControlsFor(session.id)).toMatchObject({ canInject: false, canSendDirectly: true });
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
  expect(row.directTurn?.id).toBe('plain-turn');
  const claim = await post('/input/claim', { id: row.id, owner: 'direct-page', conversationId, requiresAuthorization: true });
  expect(claim.body.input).toMatchObject({ id: row.id, directTurn: { id: 'plain-turn' } });
  await post('/events', { conversationId, events: [
    { kind: 'turn_end', turnId: 'plain-turn', outcome: 'stopped', time: time + 2 }
  ] });
  expect((await post('/input/claim', { id: row.id, owner: 'direct-page', conversationId, authorize: true })).body.ok).toBe(true);
  expect((await post('/input/ack', { id: row.id, owner: 'direct-page', conversationId, messageId: 'direct-user' })).body.ok).toBe(true);
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', messageId: 'direct-user' });
});

/** A successful current-turn fixture must carry explicit native turn custody;
 * a conversation-only request is intentionally insufficient in production. */
async function attributedMcp(conversationId: string, turnId: string): Promise<void> {
  const requestId = randomUUID();
  await post('/events', { conversationId, events: [{ kind: 'tool_evidence', time: Date.now(), turnId,
    calls: [{ messageId: randomUUID(), tool: 'read', order: 0, answered: false, requestId }] }] });
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'Fixture result' }],
    outcome: 'ok', durationMs: 1, startedAt: Date.now(), requestId });
}

it.each(['same-batch', 'final-first', 'end-first', 'final-first-with-native-tail'] as const)
('acknowledges a returned tool instruction through its exact current completed native turn (%s)', async order => {
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  const conversationId = randomUUID();
  const requestId = randomUUID();
  const answerId = randomUUID();
  const turnId = `offered-tool-${randomUUID()}`;
  const session = await createSession({ title: 'Returned instruction terminal receipt', conversationId });
  const startedAt = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-astra', time: startedAt },
    { kind: 'user_message', messageId: randomUUID(), text: 'Work on the original objective', time: startedAt },
    { kind: 'turn_start', turnId, time: startedAt },
    { kind: 'tool_evidence', time: startedAt, turnId, calls: [
      { messageId: randomUUID(), tool: 'read', order: 0, answered: false, requestId }
    ] }
  ] });
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', text: 'Use the complete current task' });
  const offered = await input.offerToolInput(session.id, conversationId, requestId, startedAt);
  expect(offered.messages).toHaveLength(1);
  const returnedAt = Date.now();
  await recordToolCall({ tool: 'read', args: {},
    content: [{ type: 'text', text: 'Current local result' },
      { type: 'text', text: input.TOOL_INPUT_HEADER + offered.messages[0]!.text }],
    outcome: 'ok', durationMs: returnedAt - startedAt, startedAt, requestId });
  const completedAt = Date.now() + 1;
  const final = { kind: 'assistant_message', turnId, messageId: answerId, providerMessageId: answerId,
      fiberConversationId: conversationId, text: 'Completed the requested local work', state: 'final',
      final: true, goalEligible: true, time: completedAt };
  const end = { kind: 'turn_end', turnId, outcome: 'completed', time: completedAt + 1 };
  const nativeCallId = randomUUID();
  const nativeTail = (answered: boolean) => ({ kind: 'page_tool', time: completedAt + 1, turnId,
    messageId: nativeCallId, text: answered ? 'Completed native read' : 'Native read result settling' });
  const batches = order === 'same-batch' ? [[final, end]] : order === 'final-first' ? [[final], [end]]
    : order === 'final-first-with-native-tail' ? [[final, nativeTail(false)], [nativeTail(true), end]] : [[end], [final]];
  for (const events of batches.slice(0, -1)) {
    expect((await post('/events', { conversationId, events })).status).toBe(200);
    if (order === 'final-first-with-native-tail')
      expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('tool');
  }
  const response = await post('/events', { conversationId, events: batches.at(-1) });
  expect(response.status).toBe(200);
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({
    state: 'sent', owner: requestId, messageId: `input:${row.id}`
  });
  expect(await input.inputBeforeGoal(session.id, turnId)).toBeNull();
  for (const events of batches) await post('/events', { conversationId, events });
  expect((await input.listInputs()).find(entry => entry.id === row.id)?.messageId).toBe(`input:${row.id}`);
});

it.each(['cold', 'wrong-request', 'wrong-call-start', 'missing-append', 'truncated-result',
  'missing-call', 'final-before-return', 'interim', 'empty-final', 'wrong-provider', 'wrong-conversation',
  'stopped', 'failed', 'new-user', 'new-turn', 'rebound', 'live-tool', 'other-turn-final', 'image-payload', 'attachment-image',
  'quoted-append', 'duplicate-append'] as const)
('does not acknowledge a returned tool instruction from %s completion evidence, including adjacent batches', async fault => {
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  const calls = await import('../src/main/mcp/call-context.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  let release: (() => void) | undefined;
  let running: Promise<unknown> | undefined;
  try {
    const conversationId = randomUUID(), requestId = randomUUID(), answerId = randomUUID();
    const turnId = `tool-negative-${randomUUID()}`;
    const session = await createSession({ title: 'Exact tool receipt negative', conversationId });
    const startedAt = now;
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-astra', time: now },
      { kind: 'user_message', messageId: randomUUID(), text: 'Original objective', time: now },
      { kind: 'turn_start', turnId, time: now },
      { kind: 'tool_evidence', time: now, calls: [{ messageId: randomUUID(), tool: 'read', order: 0, answered: false, requestId }] }
    ] });
    const authored = { ...message(session.id, 'off'), mode: 'auto' as const, text: 'Exact returned instruction' };
    const sharp = fault === 'image-payload' || fault === 'attachment-image' ? (await import('sharp')).default : null;
    let row: Awaited<ReturnType<typeof input.enqueueInput>>;
    if (fault === 'image-payload') {
      const bytes = await sharp!({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).webp().toBuffer();
      row = await input.enqueueInput({ ...authored, images: [{ name: 'correction.webp', dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` }] });
    } else if (fault === 'attachment-image') {
      const { stageInputAttachment } = await import('../src/main/session/input-attachments.js');
      const bytes = await sharp!({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
      const attachment = await stageInputAttachment({ name: 'tool-receipt.png', bytes }, new Set());
      const accepted = await handlers.get('sessions:send')!(null, { ...authored, attachments: [attachment], attachmentDelivery: 'tool' });
      expect(accepted.ok).toBe(true);
      row = accepted.data;
      expect(row.toolImages).toHaveLength(1);
    } else row = await input.enqueueInput(authored);
    now += 10;
    const offered = await input.offerToolInput(session.id, conversationId, requestId, startedAt);
    expect(offered.messages).toHaveLength(1);
    if (sharp) expect(offered.messages[0]!.images).toHaveLength(1);
    now += 10;
    if (fault !== 'missing-call') {
      const callStart = startedAt + (fault === 'wrong-call-start' ? 1 : 0);
      await recordToolCall({ tool: 'read', args: {},
        content: [{ type: 'text', text: fault === 'missing-append' ? 'Local result without instruction'
          : (fault === 'quoted-append' ? 'Quoted instructions: "' : '') + input.TOOL_INPUT_HEADER + offered.messages[0]!.text +
            (fault === 'truncated-result' ? 'x'.repeat(50_000) : fault === 'quoted-append' ? '"' :
              fault === 'duplicate-append' ? '\n' + input.TOOL_INPUT_HEADER + offered.messages[0]!.text : '') }],
        outcome: 'ok', durationMs: now - callStart, startedAt: callStart,
        requestId: fault === 'wrong-request' ? randomUUID() : requestId });
    }
    if (fault === 'cold') { await flushDurable(); input.resetInputForTests(); }
    if (fault === 'new-user') await post('/events', { conversationId, events: [
      { kind: 'user_message', messageId: randomUUID(), text: 'A new human question supersedes this completion', time: now }
    ] });
    if (fault === 'rebound') expect(await rebindSession(session.id, conversationId, randomUUID())).toBe(true);
    if (fault === 'live-tool') {
      const held = new Promise<void>(resolve => { release = resolve; });
      running = calls.trackMcpRequest(() => calls.trackInFlight({ startedAt: now, transportKey: null,
        agent: null, outcome: null, evidence: calls.emptyEvidence(),
        caller: { conversationId, requestId: randomUUID(), transportKey: null } }, () => held));
    }
    now += 10;
    const completedAt = now;
    const final = { kind: 'assistant_message', turnId: fault === 'other-turn-final' ? randomUUID() : turnId, messageId: answerId,
        providerMessageId: fault === 'wrong-provider' ? randomUUID() : answerId,
        fiberConversationId: fault === 'wrong-conversation' ? randomUUID() : conversationId,
        text: fault === 'empty-final' ? '' : 'Completed local work', state: fault === 'interim' ? 'interim' : 'final',
        final: fault !== 'interim', goalEligible: fault !== 'interim',
        time: completedAt };
    const end = { kind: 'turn_end', turnId, outcome: fault === 'stopped' ? 'stopped' : fault === 'failed' ? 'failed' : 'completed', time: completedAt + 1 };
    const next = fault === 'new-turn' ? [{ kind: 'turn_start', turnId: randomUUID(), time: completedAt + 2 }] : [];
    if (fault === 'final-before-return') now = startedAt + 15;
    const together = ['stopped', 'failed', 'new-turn'].includes(fault);
    if (!together) expect((await post('/events', { conversationId, events: [final] })).status).toBe(200);
    const response = await post('/events', { conversationId, events: together ? [final, end, ...next] : [end] });
    expect(response.status).toBe(200);
    const current = (await input.listInputs()).find(entry => entry.id === row.id)!;
    expect(current).toMatchObject({ state: 'tool', owner: requestId });
    expect(current.messageId).toBeUndefined();
    expect(current.deliveredAt).toBeUndefined();
    if (fault === 'cold') expect(current.toolReceiptUncertain).toBe(true);
    expect(await input.claimBrowserInput(row.id, 'must-not-replay', conversationId)).toBeNull();
    if (sharp) {
      await input.acknowledgeToolInput(session.id, conversationId, randomUUID(), now + 100);
      expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', messageId: `input:${row.id}` });
    }
  } finally { release?.(); await running; clock.mockRestore(); }
});

it.each(['cold', 'new-user', 'wrong-fiber', 'new-turn', 'other-end', 'interruption'] as const)
('cannot inherit a live tool final stamp after %s between adjacent batches', async change => {
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  const conversationId = randomUUID(), requestId = randomUUID(), answerId = randomUUID();
  const turnId = `split-tool-${randomUUID()}`;
  const session = await createSession({ title: 'Split native tool receipt fence', conversationId });
  const startedAt = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-astra', time: startedAt },
    { kind: 'user_message', messageId: randomUUID(), text: 'Current objective', time: startedAt },
    { kind: 'turn_start', turnId, time: startedAt },
    { kind: 'tool_evidence', time: startedAt, calls: [{ messageId: randomUUID(), tool: 'read', order: 0, answered: false, requestId }] }
  ] });
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', text: 'One current correction' });
  const batch = await input.offerToolInput(session.id, conversationId, requestId, startedAt);
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: input.TOOL_INPUT_HEADER + batch.messages[0]!.text }],
    outcome: 'ok', startedAt, requestId, durationMs: Date.now() - startedAt });
  const time = Date.now() + 1;
  const final = { kind: 'assistant_message', turnId, messageId: answerId, providerMessageId: answerId,
    fiberConversationId: conversationId, text: 'Completed local work', state: 'final', final: true, goalEligible: true, time };
  await post('/events', { conversationId, events: [final,
    { kind: 'page_tool', turnId, messageId: randomUUID(), text: 'Native result settling', time: time + 1 }] });
  expect((await input.listInputs()).find(item => item.id === row.id)?.state).toBe('tool');
  if (change === 'cold') { await flushDurable(); input.resetInputForTests(); }
  else await post('/events', { conversationId, events: [
    change === 'new-user' ? { kind: 'user_message', messageId: randomUUID(), text: 'A newer correction', time: time + 2 }
      : change === 'wrong-fiber' ? { ...final, fiberConversationId: randomUUID(), time: time + 2 }
      : change === 'new-turn' ? { kind: 'turn_start', turnId: randomUUID(), time: time + 2 }
      : change === 'other-end' ? { kind: 'turn_end', turnId: randomUUID(), outcome: 'completed', time: time + 2 }
      : { kind: 'chat_error', text: 'Connection interrupted. Waiting for the complete answer', recoverable: true, time: time + 2 }
  ] });
  await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId, outcome: 'completed', time: time + 3 }] });
  expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'tool', owner: requestId });
  expect(await input.claimBrowserInput(row.id, 'no-replay', conversationId)).toBeNull();
});

it('keeps a native terminal tool receipt idempotent without a second delivery', async () => {
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  const conversationId = randomUUID(), requestId = randomUUID(), answerId = randomUUID();
  const turnId = `tool-duplicate-${randomUUID()}`;
  const session = await createSession({ title: 'Idempotent terminal tool receipt', conversationId });
  const startedAt = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-astra', time: startedAt },
    { kind: 'turn_start', turnId, time: startedAt },
    { kind: 'tool_evidence', time: startedAt, turnId, calls: [{ messageId: randomUUID(), tool: 'read', order: 0, answered: false, requestId }] }
  ] });
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', text: 'Only this tool delivery' });
  const offered = await input.offerToolInput(session.id, conversationId, requestId, startedAt);
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: input.TOOL_INPUT_HEADER + offered.messages[0]!.text }],
    outcome: 'ok', durationMs: Date.now() - startedAt, startedAt, requestId });
  const endedAt = Date.now() + 1;
  const completion = { conversationId, events: [
    { kind: 'assistant_message', turnId, messageId: answerId, providerMessageId: answerId,
      fiberConversationId: conversationId, text: 'Completed', state: 'final', final: true, goalEligible: true, time: endedAt },
    { kind: 'turn_end', turnId, outcome: 'completed', time: endedAt + 1 }
  ] };
  await post('/events', completion);
  const receipt = (await input.listInputs()).find(entry => entry.id === row.id)!;
  expect(receipt).toMatchObject({ state: 'sent', messageId: `input:${row.id}`, owner: requestId });
  await post('/events', completion);
  await input.acknowledgeToolInput(session.id, conversationId, null, 0, { turnId, messageId: answerId });
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toEqual(receipt);
  expect(await input.offerToolInput(session.id, conversationId, requestId, Date.now() + 1)).toEqual({ messages: [], reminder: '' });
  expect(await input.pendingBrowserInputs()).toEqual([]);
});

it.each([false, true])('requires the exact complete returned tool batch, not a partial row (%s)', async partial => {
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  const conversationId = randomUUID(), requestId = randomUUID(), answerId = randomUUID();
  const turnId = `tool-batch-${randomUUID()}`;
  const session = await createSession({ title: 'Exact returned input batch', conversationId });
  const startedAt = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-astra', time: startedAt },
    { kind: 'turn_start', turnId, time: startedAt },
    { kind: 'tool_evidence', time: startedAt, turnId, calls: [{ messageId: randomUUID(), tool: 'read', order: 0, answered: false, requestId }] }
  ] });
  const rows = await Promise.all(['First frozen correction', 'Second frozen correction'].map(text =>
    input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', text })));
  const batch = await input.offerToolInput(session.id, conversationId, requestId, startedAt);
  expect(batch.messages).toHaveLength(2);
  const blocks = batch.messages.slice(0, partial ? 1 : undefined).map((item, index) => ({
    type: 'text' as const, text: (index === 0 ? input.TOOL_INPUT_HEADER : '\n\n') + item.text
  }));
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'Local result' }, ...blocks],
    outcome: 'ok', durationMs: Date.now() - startedAt, startedAt, requestId });
  const endedAt = Date.now() + 1;
  await post('/events', { conversationId, events: [
    { kind: 'assistant_message', turnId, messageId: answerId, providerMessageId: answerId,
      fiberConversationId: conversationId, text: 'Completed', state: 'final', final: true, goalEligible: true, time: endedAt },
    { kind: 'turn_end', turnId, outcome: 'completed', time: endedAt + 1 }
  ] });
  for (const row of rows) expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({
    state: partial ? 'tool' : 'sent', owner: requestId, ...(partial ? {} : { messageId: `input:${row.id}` })
  });
  expect(await input.pendingBrowserInputs()).toEqual([]);
});

it.each(['interim', 'native-tool', 'mcp', 'final', 'replay'] as const)('releases failed input immediately and reconciles later %s', async activity => {
  const bridge = await import('../src/main/bridge.js');
  const store = await import('../src/main/session/store.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Failed view lifecycle', conversationId });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'user_message', messageId: 'question', text: 'Work', authoredNow: true, time: now },
      { kind: 'turn_start', turnId: 'failed-view', time: now }
    ] });
    await attributedMcp(conversationId, 'failed-view');
    now++;
    const failure = { kind: 'turn_end', turnId: 'failed-view', reason: 'thinking_failed', outcome: 'failed', time: now };
    await post('/events', { conversationId, events: [failure] });
    expect(await input.sessionInputPolicy(session.id)).toMatchObject({canInject: false, browserAllowed: true});
    const manual = await input.enqueueInput({...message(session.id, 'off'), mode: 'auto'});
    expect((await input.pendingBrowserInputs()).some(row => row.id === manual.id)).toBe(true);
    await input.cancelInput(manual.id);
    const queued = await input.enqueueInput({...message(session.id, 'off'), mode: 'after-turn'});
    now += 1000;
    if (activity === 'mcp') await attributedMcp(conversationId, 'failed-view');
    else await post('/events', { conversationId, events: [activity === 'replay' ? failure : activity === 'native-tool'
      ? {kind: 'page_tool', turnId: 'failed-view', messageId: 'new-tool', text: 'Searching files', time: now}
      : {kind: 'assistant_message', turnId: 'failed-view', messageId: 'new-answer', providerMessageId: 'abababab-1111-2222-3333-444444444444',
          text: 'Fresh answer', state: activity === 'final' ? 'final' : 'streaming', final: activity === 'final', activeNow: true, time: now}] });
    const resumed = activity !== 'final' && activity !== 'replay';
    expect((await store.getSession(session.id))?.activeTurnId).toBe(resumed ? 'failed-view' : null);
    if (resumed) {
      await post('/events', {conversationId, events: [failure]});
      expect((await store.getSession(session.id))?.activeTurnId).toBe('failed-view');
    }
    expect(await input.sessionInputPolicy(session.id)).toMatchObject({canInject: resumed, browserAllowed: !resumed});
    now += 29_000;
    await bridge.sweepStaleSwarm(now);
    const repairs = (await post('/status', {openConversations: [conversationId]})).body.repairs;
    expect(repairs.some((row: any) => row.conversationId === conversationId)).toBe(activity === 'replay');
    expect((await input.pendingBrowserInputs()).some(row => row.id === queued.id)).toBe(activity === 'final');
  } finally { clock.mockRestore(); }
});

it('holds known-unsent existing-chat inputs at both projection and claim until tunnel route takeover ends (#1250)', async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Existing chat after tunnel restart', conversationId });
    const existing = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
    noteTunnelClientConnected();
    const claim = { id: existing.id, owner: 'route-page', conversationId, requiresAuthorization: true };
    const held = await post('/status', { openConversations: [conversationId] });
    expect(held.body.inputs.some((row: { id: string }) => row.id === existing.id)).toBe(false);
    expect((await post('/input/claim', claim)).body.input).toBeNull();
    expect((await input.listInputs()).find(row => row.id === existing.id)).toMatchObject({ state: 'queued', owner: null });
    now += ROUTE_SETTLE_MS;
    const released = await post('/status', { openConversations: [conversationId] });
    expect(released.body.inputs.map((row: { id: string }) => row.id)).toContain(existing.id);
    expect((await post('/input/claim', claim)).body.input).toMatchObject({ id: existing.id });
  } finally { clock.mockRestore(); resetRouteSettleForTests(); }
});

it('keeps a fresh-chat opening eligible during a new tunnel-client route takeover (#1250)', async () => {
  const fresh = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto' });
  noteTunnelClientConnected();
  try {
    expect((await post('/status', { openConversations: [] })).body.inputs).toContainEqual(expect.objectContaining({ id: fresh.id, conversationId: null }));
    expect((await post('/input/claim', { id: fresh.id, owner: 'fresh-route-page', conversationId: null, requiresAuthorization: true })).body.input).toMatchObject({ id: fresh.id });
  } finally { resetRouteSettleForTests(); }
});

it('does not revoke or replay an already-claimed input when a new tunnel client connects (#1250)', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Claimed chat route custody', conversationId });
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
  const claim = { id: row.id, owner: 'exact-claimed-page', conversationId, requiresAuthorization: true };
  expect((await post('/input/claim', claim)).body.input).toMatchObject({ id: row.id });
  noteTunnelClientConnected();
  try {
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
    expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'browser', owner: claim.owner, sendAuthorizedAt: expect.any(Number) });
    expect((await post('/input/ack', { ...claim, messageId: 'route-exact-native-message' })).body.ok).toBe(true);
    expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', owner: claim.owner, messageId: 'route-exact-native-message' });
    expect((await post('/status', { openConversations: [conversationId] })).body.inputs.some((entry: { id: string }) => entry.id === row.id)).toBe(false);
  } finally { resetRouteSettleForTests(); }
});

it.each(['html', 'timestamp', 'provider-alias'] as const)('keeps failed manual delivery available after a %s-only interim revision', async revision => {
  const store = await import('../src/main/session/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Failed metadata replay', conversationId });
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const interim = { kind: 'assistant_message', turnId: 'metadata-turn', messageId: 'original-interim',
      providerMessageId: 'abababab-1111-2222-3333-444444444444', text: 'Geometry still needs work',
      state: 'streaming', activeNow: true, time: now };
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'turn_start', turnId: interim.turnId, time: now }, interim
    ] });
    now++;
    await post('/events', { conversationId, events: [
      { kind: 'turn_end', turnId: interim.turnId, outcome: 'failed', reason: 'thinking_failed', time: now }
    ] });
    now += 62;
    await post('/events', { conversationId, events: [{ ...interim, time: now,
      ...(revision === 'html' ? { renderedHtml: '<p>Geometry still needs work</p>' }
        : revision === 'timestamp' ? { authoredTime: true }
        : { messageId: 'replacement-fiber-alias' }) }] });
    expect((await store.getSession(session.id))?.activeTurnId).toBeNull();
    expect(await input.sessionInputPolicy(session.id)).toMatchObject({ canInject: false, browserAllowed: true });
    const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
    const claim = await input.claimBrowserInput(row.id, 'native-page', conversationId, true);
    expect(claim?.id).toBe(row.id);
    expect(await input.authorizeBrowserInput(row.id, 'native-page', conversationId)).toBe(true);
    expect(await input.acknowledgeBrowserInput(row.id, 'native-page', conversationId, 'next-question')).toBe(true);
    expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('sent');
  } finally { clock.mockRestore(); }
});

it('defers an immediate failed-view manual send for native busy without requiring MCP or adding a checkpoint', async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Failed manual native busy', conversationId });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'turn_start', turnId: 'failed-without-mcp', time: now },
      { kind: 'turn_end', turnId: 'failed-without-mcp', outcome: 'failed', reason: 'thinking_failed', time: now }
    ] });
    const checkpoint = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, text: 'Later checkpoint', mode: 'after-turn' });
    const manual = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, text: 'Immediate correction', mode: 'auto' });
    const offer = (await post('/status', { openConversations: [conversationId] })).body.inputs.find((row: any) => row.id === manual.id);
    expect(offer).toMatchObject({ id: manual.id, silenceTurnId: 'failed-without-mcp' });
    expect((await input.listInputs()).find(row => row.id === manual.id)?.silenceBoundary).toBeUndefined();
    const claim = { id: manual.id, owner: 'busy-page', conversationId, requiresAuthorization: true };
    expect((await post('/input/claim', { ...claim, silenceBusyTurnId: offer.silenceTurnId })).body.ok).toBe(true);
    input.resetInputForTests();
    now += 5 * 60_000 - 1;
    expect((await post('/input/claim', claim)).body.input).toBeNull();
    expect((await input.listInputs()).find(row => row.id === manual.id)?.state).toBe('queued');
    now++;
    const delivered = (await post('/input/claim', claim)).body.input;
    expect(delivered?.text).toContain(manual.text);
    expect(delivered?.text).not.toContain(checkpoint.text);
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
    expect((await post('/input/ack', { ...claim, messageId: 'manual-after-busy' })).body.ok).toBe(true);
    expect((await input.listInputs()).find(row => row.id === checkpoint.id)?.state).toBe('queued');
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
  } finally { clock.mockRestore(); }
});

it.each(['app', 'browser'] as const)('files a missing failed-turn Loop ticket on explicit %s off/on and retains interim context', async surface => {
  const bridge = await import('../src/main/bridge.js');
  const store = await import('../src/main/session/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Explicit failed Loop activation', conversationId });
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'user_message', messageId: 'request', text: 'Build all stage layers', time: now },
      { kind: 'turn_start', turnId: 'activation-source', time: now },
      { kind: 'assistant_message', messageId: 'interim', turnId: 'activation-source', text: 'Portal repaired; rear geometry remains', state: 'streaming', time: now },
      { kind: 'turn_end', turnId: 'activation-source', outcome: 'failed', reason: 'thinking_failed', time: now + 1 }
    ] });
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    expect(await goal.conversationMessages(session.id)).toEqual([
      { role: 'user', content: 'Build all stage layers' },
      { role: 'assistant', content: 'Portal repaired; rear geometry remains' }
    ]);
    await goal.setGoalSwitchNow(conversationId, 'loop', false, true);
    const toggle = async (on: boolean) => surface === 'app'
      ? bridge.setSessionAutomation(session.id, on ? 'loop' : 'off')
      : post('/settings', { conversationId, loop: on });
    await toggle(true);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    await toggle(false);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    now += 300001;
    await toggle(true);
    const first = goal.goalPendingReplyFor(conversationId)!;
    expect(first).toMatchObject({ turnId: 'activation-source', replyId: 'activation:activation-source' });
    const draft = { conversationId, turnId: first.turnId, clientId: 'activation-page', terminalRequired: true };
    goal.restoreGoalReplies(goal.snapshotGoalReplies());
    const queued = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, mode: 'auto' });
    expect((await post('/goal/draft', draft)).body.error).toBe('user_input_pending');
    await input.cancelInput(queued.id);
    expect((await post('/goal/draft', draft)).status).toBe(200);
    await toggle(false);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    now++;
    await post('/events', { conversationId, events: [{ kind: 'turn_start', turnId: 'new-work', time: now }] });
    await toggle(true);
    expect((await post('/goal/draft', draft)).status).toBe(409);
    expect((await store.getSession(session.id))?.activeTurnId).toBe('new-work');
    await toggle(false);
  } finally { clock.mockRestore(); }
});

async function refreshFailedView(conversationId: string, advance: (ms: number) => void, delay = 0) {
  const bridge = await import('../src/main/bridge.js');
  if (delay) expect((await post('/status', { openConversations: [conversationId] })).body.repairs.some((r: any) => r.conversationId === conversationId)).toBe(false);
  advance(delay);
  await bridge.sweepStaleSwarm(Date.now());
  const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((r: any) => r.conversationId === conversationId);
  expect(repair).toMatchObject({ reason: 'silence' });
  await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
  advance(5 * 60_000 - 1);
  const pending = await input.pendingBrowserInputs();
  expect(pending.some(row => row.conversationId === conversationId)).toBe(false);
  advance(1);
}

it.each(['auto', 'after-turn'] as const)('reserves the failed-view five-minute window for automatic work, not manual %s input', async mode => {
  const bridge = await import('../src/main/bridge.js');
  const { trackInFlight, emptyEvidence } = await import('../src/main/mcp/call-context.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Failure manual priority', conversationId });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'turn_start', turnId: 'failure-priority', time: now }
    ] });
    await attributedMcp(conversationId, 'failure-priority');
    const row = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, mode });
    now++;
    await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'failure-priority', outcome: 'failed', reason: 'thinking_failed', time: now }] });
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((r: any) => r.conversationId === conversationId);
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    expect((await input.pendingBrowserInputs()).some(r => r.id === row.id)).toBe(mode === 'auto');
    if (mode === 'auto') {
      const claim = { id: row.id, owner: 'failed-page', conversationId, requiresAuthorization: true };
      expect((await post('/input/claim', claim)).body.input?.id).toBe(row.id);
      await trackInFlight({ startedAt: now, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
        caller: { requestId: randomUUID(), transportKey: null, conversationId } }, async () => {
        expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).not.toBe(true);
      });
      expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
      expect((await post('/input/ack', { ...claim, messageId: 'manual-after-failure' })).body.ok).toBe(true);
      now += 300001;
      await bridge.sweepStaleSwarm(now);
      expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    } else {
      now += 300000;
      expect((await input.pendingBrowserInputs()).some(r => r.id === row.id)).toBe(true);
    }
  } finally { clock.mockRestore(); }
});

it.each([
  ['gpt-6-pro', false], ['gpt-5.6-sol', false],
  ['gpt-6-pro', true], ['gpt-5.6-sol', true]
] as const)('steers a non-Pro turn natively or recovers Pro injection after %s silence (full final: %s)', async (model, nativeCompleted) => {
  const bridge = await import('../src/main/bridge.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Silence correction and checkpoint', conversationId });
    await goal.setGoalSwitchNow(conversationId, 'loop', true, true);
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model, time: now },
      { kind: 'turn_start', turnId: 'silent-source', time: now }
    ] });
    await attributedMcp(conversationId, 'silent-source');
    const { stageInputAttachment } = await import('../src/main/session/input-attachments.js');
    const attachment = await stageInputAttachment({ text: 'Checkpoint reference' }, new Set());
    const checkpoint = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, text: 'Verify the geometry', mode: 'after-turn', attachments: [attachment] });
    const later = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, text: 'Prepare the export', mode: 'after-turn' });
    const manual = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, text: 'Use no color or textures', mode: 'auto' });
    if (model === 'gpt-5.6-sol') {
      expect(manual).toMatchObject({ transportIntent: 'browser', directTurn: { id: 'silent-source' } });
      expect(await input.offerToolInput(session.id, conversationId, 'running-call', now)).toMatchObject({ messages: [] });
      if (nativeCompleted) await post('/events', { conversationId, events: [
        { kind: 'assistant_message', turnId: 'silent-source', messageId: 'full-final', text: 'Provider reports a result', state: 'final', final: true, time: now },
        { kind: 'turn_end', turnId: 'silent-source', outcome: 'completed', time: now }
      ] });
      const claim = { id: manual.id, owner: 'native-page', conversationId, requiresAuthorization: true };
      expect(operatorPromptBody((await post('/input/claim', claim)).body.input?.text!)).toBe(prependUserPrompt(manual.text, ''));
      expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
      expect((await post('/input/ack', { ...claim, messageId: 'native-correction' })).body.ok).toBe(true);
      expect((await input.listInputs()).find(row => row.id === checkpoint.id)?.state).toBe('queued');
      expect((await input.listInputs()).find(row => row.id === later.id)?.state).toBe('queued');
      return;
    }
    expect(manual.transportIntent).toBe('tool');
    if (nativeCompleted) {
      await post('/events', { conversationId, events: [
        { kind: 'assistant_message', turnId: 'silent-source', messageId: 'full-final', text: 'Provider reports a result', state: 'final', final: true, time: now },
        { kind: 'turn_end', turnId: 'silent-source', outcome: 'completed', time: now }
      ] });
      const ready = await post('/input/claim', { id: manual.id, owner: 'finished-page', conversationId, requiresAuthorization: true });
      expect(operatorPromptBody(ready.body.input?.text!)).toBe(prependUserPrompt(manual.text, ''));
      expect((await post('/goal/draft', { conversationId, turnId: 'silent-source', terminalRequired: true })).status).toBe(409);
      now += model === 'gpt-6-pro' ? 600001 : 120001;
      await bridge.sweepStaleSwarm(now);
      const repairs = (await post('/status', { openConversations: [conversationId] })).body.repairs;
      expect(repairs.some((repair: any) => repair.conversationId === conversationId && repair.reason === 'silence')).toBe(false);
      expect((await input.listInputs()).find(row => row.id === later.id)?.state).toBe('queued');
      return;
    }
    const window = model === 'gpt-6-pro' ? 600000 : 120000;
    now += window - 1;
    await bridge.sweepStaleSwarm(now);
    expect((await input.pendingBrowserInputs()).some(r => r.conversationId === conversationId)).toBe(false);
    now += 2;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((r: any) => r.conversationId === conversationId);
    expect(repair?.reason).toBe('silence');
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    input.resetInputForTests();
    expect((await input.pendingBrowserInputs()).filter(r => r.conversationId === conversationId)).toEqual([expect.objectContaining({ id: manual.id })]);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    const claim = { id: manual.id, owner: 'recovered-page', conversationId, requiresAuthorization: true };
    const response = await post('/input/claim', claim);
    expect(response.body.input?.text).toContain(manual.text);
    expect(response.body.input?.text).toContain(checkpoint.text);
    expect(response.body.input?.text).not.toContain(later.text);
    expect(response.body.input?.attachments).toEqual([attachment]);
    const fileRequest = { ...claim, attachmentId: attachment.id, offset: 0 };
    expect((await post('/input/attachment', { ...fileRequest, owner: 'wrong-page' })).status).toBe(409);
    expect(Buffer.from((await post('/input/attachment', fileRequest)).body.chunk, 'base64').toString()).toBe('Checkpoint reference');
    input.resetInputForTests();
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
    expect((await post('/input/attachment', fileRequest)).status).toBe(409);
    expect((await post('/input/ack', { ...claim, messageId: 'combined-user' })).body.ok).toBe(true);
    const rows = await input.listInputs();
    expect(rows.find(r => r.id === manual.id)?.state).toBe('sent');
    expect(rows.find(r => r.id === checkpoint.id)?.state).toBe('sent');
    expect(rows.find(r => r.id === later.id)?.state).toBe('queued');
    const { readEvents } = await import('../src/main/session/store.js');
    const messages = await readEvents(session.id, { kinds: ['user_message'] });
    expect(messages.filter(event => event.kind === 'user_message' && event.messageId === 'combined-user')).toHaveLength(1);
    expect(messages.find(event => event.kind === 'user_message' && event.messageId === 'combined-user')).toMatchObject({
      authoredText: expect.stringContaining(checkpoint.text), attachments: [attachment], message: { text: expect.stringContaining(manual.text) }
    });
    expect((await post('/goal/draft', { conversationId, turnId: 'silent-source', terminalRequired: true })).status).toBe(409);
  } finally { clock.mockRestore(); }
});

describe.each(['input', 'loop'] as const)('MCP admission for %s recovery', destination => {
  describe.each(['silence', 'thinking_failed'] as const)('%s boundary', boundary => {
    it.each(['none', 'previous-turn', 'native-tool', 'request-only', 'current-turn'] as const)(
      'requires an actual attributed call in this turn (%s)', async evidence => {
      const bridge = await import('../src/main/bridge.js');
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const conversationId = randomUUID();
        const session = await createSession({ title: 'Recovery MCP admission', conversationId });
        await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
        if (destination === 'loop') await goal.setGoalSwitchNow(conversationId, 'loop', true, true);
        if (evidence === 'previous-turn') {
          await post('/events', { conversationId, events: [{ kind: 'turn_start', turnId: 'previous-mcp-turn', time: now }] });
          await attributedMcp(conversationId, 'previous-mcp-turn');
          await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'previous-mcp-turn', outcome: 'stopped', time: now }] });
          now++;
        }
        await post('/events', { conversationId, events: [
          { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: now },
          { kind: 'user_message', messageId: 'new-user', text: 'Fixture task', time: now },
          { kind: 'turn_start', turnId: 'current-turn', time: now }
        ] });
        const row = destination === 'input' ? await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' }) : null;
        if (evidence === 'current-turn') await attributedMcp(conversationId, 'current-turn');
        if (evidence === 'native-tool') await post('/events', { conversationId, events: [
          { kind: 'page_tool', turnId: 'current-turn', messageId: 'native-tool', label: 'Used container tool', time: now }
        ] });
        if (evidence === 'request-only') await post('/events', { conversationId, events: [
          { kind: 'tool_evidence', time: now, calls: [{ messageId: 'request-sighting', tool: 'read', order: 0, answered: false, requestId: randomUUID() }] }
        ] });
        if (boundary === 'silence') {
          now += bridge.PRO_SILENCE_MS + 1;
          await bridge.sweepStaleSwarm(now);
          const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((item: any) => item.conversationId === conversationId);
          expect(repair).toBeDefined(); // Reload remains allowed even without MCP.
          await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
        } else {
          now += 330_000;
          await post('/events', { conversationId, events: [
            { kind: 'turn_end', turnId: 'current-turn', outcome: 'failed', reason: 'thinking_failed', time: now }
          ] });
          await refreshFailedView(conversationId, ms => { now += ms; });
        }
        const eligible = evidence === 'current-turn';
        if (row) {
          input.resetInputForTests();
          expect((await input.listInputs()).find(item => item.id === row.id)?.silenceBoundary !== undefined).toBe(eligible);
          expect((await input.pendingBrowserInputs()).some(item => item.id === row.id)).toBe(eligible);
          expect(!!(await post('/input/claim', { id: row.id, owner: 'page', conversationId, requiresAuthorization: true })).body.input).toBe(eligible);
        } else {
          goal.restoreGoalReplies(goal.snapshotGoalReplies());
          expect(goal.goalPendingReplyFor(conversationId) !== null).toBe(eligible);
        }
      } finally { clock.mockRestore(); }
    });
  });
});

it.each(['gpt-6-pro', 'gpt-5.6-sol'])('carries settled Thinking failed through HTTP, recording and one queued send (%s)', async model => {
  const { readEvents } = await import('../src/main/session/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Native failure queue', conversationId });
  const time = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model, time },
    { kind: 'turn_start', turnId: 'native-failed-turn', time }
  ] });
  const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn', afterTurn: true });
  const second = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn', afterTurn: true });
  await attributedMcp(conversationId, 'native-failed-turn');
  await post('/events', { conversationId, events: [
    { kind: 'chat_error', turnId: 'native-failed-turn', text: 'Thinking failed', reason: 'thinking_failed', recoverable: false, time: Date.now() }
  ] });
  expect((await readEvents(session.id, { kinds: ['chat_error'] })).at(-1)).toMatchObject({ reason: 'thinking_failed', recoverable: false });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  // Content closes the failed view immediately; the refresh/listening owner gates automatic delivery.
  const end = { kind: 'turn_end', turnId: 'native-failed-turn', outcome: 'failed', reason: 'thinking_failed', detail: 'Thinking failed', time: Date.now() + 1 };
  expect((await post('/events', { conversationId, events: [end] })).status).toBe(200);
  expect((await readEvents(session.id, { kinds: ['turn_end'] })).at(-1)).toMatchObject({ reason: 'thinking_failed', outcome: 'failed' });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    await refreshFailedView(conversationId, ms => { now += ms; });
    expect(await input.pendingBrowserInputs()).toEqual([{ id: first.id, conversationId, silenceTurnId: 'native-failed-turn' }]);
    {
      const busyAt = Date.now();
      clock.mockReturnValue(busyAt);
      expect((await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, silenceBusyTurnId: 'native-failed-turn' })).body.ok).toBe(true);
      input.resetInputForTests();
      clock.mockReturnValue(busyAt + 5 * 60_000 - 1);
      expect(await input.pendingBrowserInputs()).toEqual([]);
      expect((await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, requiresAuthorization: true })).body.input).toBeNull();
      clock.mockReturnValue(busyAt + 5 * 60_000);
      expect(await input.pendingBrowserInputs()).toHaveLength(1);
    }
    const claim = await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, requiresAuthorization: true });
    expect(claim.body.input).toMatchObject({ id: first.id, completedTurnId: 'native-failed-turn' });
    expect((await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, authorize: true })).body.ok).toBe(true);
    expect((await post('/input/ack', { id: first.id, owner: 'failed-turn-page', conversationId, messageId: 'queued-next-user' })).body.ok).toBe(true);
    input.resetInputForTests();
    await post('/events', { conversationId, events: [end] });
    expect(await input.pendingBrowserInputs()).toEqual([]);
    expect((await input.listInputs()).find(row => row.id === second.id)?.state).toBe('queued');
  } finally { clock.mockRestore(); }
});

it.each(['gpt-6-pro', 'gpt-5.6-sol'])('preserves failed prime recovery while another worker tool outlives five minutes (%s)', async model => {
  const bridge = await import('../src/main/bridge.js');
  const calls = await import('../src/main/mcp/call-context.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const conversationId = randomUUID(), worker = randomUUID();
  await createSession({ title: 'Prime recovery with a busy worker', conversationId });
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
  await goal.setGoalSwitchNow(conversationId, 'loop', true, true);
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model, reasoningEffort: 'high', time: now },
    { kind: 'user_message', messageId: 'prime-question', text: 'Finish the original task with its worker', time: now },
    { kind: 'turn_start', turnId: 'prime-failed-view', time: now }
  ] });
  await attributedMcp(conversationId, 'prime-failed-view');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const running = calls.trackMcpRequest(() => calls.trackInFlight({ startedAt: now, transportKey: null,
    agent: 'worker-1', outcome: null, evidence: calls.emptyEvidence(),
    caller: { conversationId: worker, requestId: randomUUID(), transportKey: null } }, () => held));
  try {
    now++;
    await post('/events', { conversationId, events: [
      { kind: 'turn_end', turnId: 'prime-failed-view', outcome: 'failed', reason: 'thinking_failed', time: now }
    ] });
    await refreshFailedView(conversationId, ms => { now += ms; });
    const pending = goal.goalPendingReplyFor(conversationId)!;
    expect(pending).toMatchObject({ silenceSourceTurnId: 'prime-failed-view' });
    expect(calls.runningToolCalls(worker)).toBe(1);
    expect(calls.runningToolCalls(conversationId)).toBe(0);
    now += 2 * 60_000;
    await bridge.sweepStaleSwarm(now);
    goal.restoreGoalReplies(goal.snapshotGoalReplies());
    expect(goal.goalPendingReplyFor(conversationId)).toEqual(pending);
    const drafted = await post('/goal/draft', { conversationId, turnId: pending.turnId, terminalRequired: true, clientId: 'prime-page' });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(200);
    expect(goal.goalPendingReplyFor(conversationId)).toEqual(pending);
    release(); await running;
    await bridge.sweepStaleSwarm(now);
    expect(goal.goalPendingReplyFor(conversationId)).toEqual(pending);
  } finally { release(); await running; clock.mockRestore(); }
});

it('refuses restored recovery tickets without MCP proof but still delivers a real final', async () => {
  const { readRecentEvents } = await import('../src/main/session/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Restored recovery admission', conversationId });
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
  await goal.setGoalSwitchNow(conversationId, 'loop', true, true);
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-pro', time: Date.now() },
    { kind: 'turn_start', turnId: 'restored-turn', time: Date.now() }
  ] });
  const [start] = await readRecentEvents(session.id, 1);
  await writeDurableNow('session-input', [{ ...row, silenceBoundary: { turnId: 'restored-turn', conversationId, workSeq: start!.seq } }]);
  input.resetInputForTests();
  goal.restoreGoalReplies({ version: 1, savedAt: Date.now(), replies: [{ conversationId, sessionId: session.id,
    replyId: 'silence:restored', turnId: 'g-silence-restored', silenceSourceTurnId: 'restored-turn', silencePro: true,
    eventSeq: start!.seq, acceptedAt: Date.now(), state: 'pending' }] });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId, requiresAuthorization: true })).body.input).toBeNull();
  expect((await post('/goal/draft', { conversationId, turnId: 'g-silence-restored', terminalRequired: true })).status).toBe(409);
  await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'restored-turn', outcome: 'completed', time: Date.now() + 1 }] });
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId, requiresAuthorization: true })).body.input?.id).toBe(row.id);
});

it('delivers a message queued after the silent turn it waits for had already completed', async () => {
  // Live 2026-10-19 (VM): the page could not read ChatGPT's answer for a while, so the app still
  // took the chat for busy when a message was queued, and silence recovery tied it to that turn.
  // The turn had completed two minutes earlier; the message waited for a newer end forever.
  const { readRecentEvents } = await import('../src/main/session/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Completed before queueing', conversationId });
  const started = Date.now() - 120_000;
  await post('/events', { conversationId, events: [
    { kind: 'turn_start', turnId: 'silent-done', time: started },
    { kind: 'assistant_message', turnId: 'silent-done', messageId: 'silent-final', text: 'done', state: 'final', final: true, time: started + 1 },
    { kind: 'turn_end', turnId: 'silent-done', outcome: 'completed', time: started + 2 }
  ] });
  const [end] = await readRecentEvents(session.id, 1);
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' as const });
  await writeDurableNow('session-input', [{ ...row, state: 'queued',
    silenceBoundary: { turnId: 'silent-done', conversationId, workSeq: end!.seq, acceptedAt: Date.now() - 1_000, listenUntil: Date.now() - 500 } }]);
  input.resetInputForTests();
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId, requiresAuthorization: true })).body.input?.id).toBe(row.id);
});

it('does not turn generic failed/error prose or an unknown wire reason into queue authority', async () => {
  const { readEvents } = await import('../src/main/session/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Unclassified failure', conversationId });
  await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn', afterTurn: true });
  await post('/events', { conversationId, events: [
    { kind: 'turn_start', turnId: 'unclassified', time: Date.now() },
    { kind: 'turn_end', turnId: 'unclassified', outcome: 'failed', reason: 'unrecognized', detail: 'Thinking failed', time: Date.now() + 1 }
  ] });
  expect((await readEvents(session.id, { kinds: ['turn_end'] })).at(-1)).not.toHaveProperty('reason');
  expect(await input.pendingBrowserInputs()).toEqual([]);
});

it.each([false, true])('normal queued recovery uses the shared silence window plus one minute after ACK and spends its source before Goal (Goal enabled: %s)', async enabled => {
  const bridge = await import('../src/main/bridge.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Normal queued recovery', conversationId });
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled } });
    if (enabled) await goal.setGoalSwitchNow(conversationId, 'goal', true);
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-5.6-sol', reasoningEffort: 'high', time: now },
      { kind: 'turn_start', turnId: 'normal-silence', time: now }
    ] });
    const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    const second = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await attributedMcp(conversationId, 'normal-silence');
    now += CHAT_SILENCE_MS - 1;
    await bridge.sweepStaleSwarm(now);
    expect((await post('/status', { openConversations: [conversationId] })).body.repairs.some((r: any) => r.conversationId === conversationId)).toBe(false);
    now += 2;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((r: any) => r.conversationId === conversationId);
    expect(repair).toMatchObject({ reason: 'silence' });
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    const boundary = (await input.listInputs()).find(row => row.id === first.id)!.silenceBoundary!;
    expect(boundary.listenUntil).toBe(now + 60_000);
    expect((await bridge.sessionControlsFor(session.id)).recovery).toEqual([{ kind: 'post-reload', next: 'queue', staleSince: now, deadline: boundary.listenUntil }]);
    input.resetInputForTests();
    expect(await input.pendingBrowserInputs()).toEqual([]);
    now += 59_999;
    expect((await post('/input/claim', { id: first.id, owner: 'normal-page', conversationId, requiresAuthorization: true })).body.input).toBeNull();
    now++;
    await bridge.sweepStaleSwarm(now);
    expect(await input.pendingBrowserInputs()).toEqual([expect.objectContaining({ id: first.id })]);
    const activity = await fetch(`http://127.0.0.1:${bridgePort()}/activity?conversationId=${conversationId}`, { headers: {
      authorization: `Bearer ${bearer}`, 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL)
    } }).then(r => r.json());
    expect(activity.goal).toMatchObject({ queuePending: true, draft: null, pending: null });
    if (enabled) expect((await post('/goal/draft', { conversationId, turnId: 'normal-silence' })).body.error).toBe('user_input_pending');
    const claim = { id: first.id, owner: 'normal-page', conversationId, requiresAuthorization: true };
    expect((await post('/input/claim', claim)).body.input?.id).toBe(first.id);
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
    expect((await post('/input/ack', { ...claim, messageId: 'normal-next' })).body.ok).toBe(true);
    expect(await input.pendingBrowserInputs()).toEqual([]);
    expect((await input.listInputs()).find(row => row.id === second.id)?.state).toBe('queued');
  } finally { clock.mockRestore(); }
});

it.each(['open', 'stalled', 'final-during-listen', 'failure-during-listen', 'failure-before-claim', 'failure-after-claim'])('files one durable after-turn ticket only after the silence refresh ACK (%s)', async boundary => {
  const bridge = await import('../src/main/bridge.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Silent Pro', conversationId });
    const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: now },
      { kind: 'user_message', messageId: 'silence-user', text: 'Continue the task', time: now },
      { kind: 'turn_start', turnId: 'silence-turn', time: now }
    ] });
    await attributedMcp(conversationId, 'silence-turn');
    now += bridge.PRO_SILENCE_MS - 1;
    await bridge.sweepStaleSwarm(now);
    expect(await input.pendingBrowserInputs()).toEqual([]);
    now += 2;
    if (boundary === 'stalled') await post('/events', { conversationId, events: [
      { kind: 'turn_end', turnId: 'silence-turn', outcome: 'stalled', time: now }
    ] });
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((row: any) => row.conversationId === conversationId);
    expect(repair).toBeDefined();
    expect(await input.pendingBrowserInputs()).toEqual([]);
    const confirmedAt = now;
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    expect((await input.listInputs()).find(row => row.id === first.id)?.silenceBoundary?.turnId).toBe('silence-turn');
    input.resetInputForTests();
    expect(await input.pendingBrowserInputs()).toEqual([expect.objectContaining({ id: first.id, silenceTurnId: 'silence-turn' })]);
    const claim = { id: first.id, owner: 'refreshed-page', conversationId };
    if (boundary === 'failure-after-claim') {
      expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input?.id).toBe(first.id);
    } else if (boundary !== 'failure-before-claim') {
      if (boundary === 'failure-during-listen') now += 10_000;
      expect((await post('/input/claim', { ...claim, silenceBusyTurnId: 'silence-turn' })).body.ok).toBe(true);
      expect(await input.pendingBrowserInputs()).toEqual([]);
    }
    if (boundary === 'final-during-listen' || boundary === 'failure-during-listen' || boundary === 'failure-before-claim' || boundary === 'failure-after-claim') {
      now++;
      await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'silence-turn', time: now,
        ...(boundary === 'final-during-listen' ? { outcome: 'completed' } : { outcome: 'failed', reason: 'thinking_failed' }) }] });
    }
    // The exact source already has a confirmed refresh. Learning its failure must
    // keep that receipt and native-busy deadline, not ask for a second reload.
    if (boundary === 'failure-during-listen' || boundary === 'failure-before-claim') {
      const status = await post('/status', { openConversations: [conversationId] });
      expect(status.body.repairs.some((row: any) => row.conversationId === conversationId)).toBe(false);
      const row = (await input.listInputs()).find(row => row.id === first.id)!;
      expect(row.silenceBoundary?.listenUntil).toBe(confirmedAt + 5 * 60_000 + (boundary === 'failure-during-listen' ? 10_000 : 0));
      input.resetInputForTests();
      expect(await input.pendingBrowserInputs()).toEqual([]);
    }
    if (boundary === 'failure-after-claim') {
      // An already offered automatic row is immutable. The new failure changes
      // the source work sequence, so its old claim cannot cross final Send.
      expect((await input.listInputs()).find(row => row.id === first.id)?.state).toBe('browser');
      expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(false);
      expect((await post('/input/fail', { ...claim, error: 'After-turn pickup was withdrawn before Send.' })).body.ok).toBe(true);
      now = confirmedAt + 5 * 60_000 - 1;
      await bridge.sweepStaleSwarm(now);
      expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input).toBeNull();
      now++;
      await bridge.sweepStaleSwarm(now);
    }
    const retained = (await input.listInputs()).find(row => row.id === first.id)!;
    // A claim withdrawn by newer failed-turn evidence no longer receives a second reload window.
    // Its old ticket is no longer valid, so the exact UUID must become visible Needs Attention
    // instead of remaining an invisible queued row that no browser owner can ever claim.
    if (boundary === 'failure-after-claim') {
      expect(retained).toMatchObject({ id: first.id, state: 'failed', owner: null,
        error: expect.stringContaining('Needs attention') });
      expect(retained.silenceBoundary).toBeUndefined();
      expect(await input.pendingBrowserInputs()).toEqual([]);
      input.resetInputForTests();
      expect((await input.listInputs()).find(row => row.id === first.id)).toMatchObject({
        id: first.id,
        state: 'failed',
        error: expect.stringContaining('exact message is saved and was not sent')
      });
      return;
    }
    const until = retained.silenceBoundary?.listenUntil ?? now;
    if (until > now) {
      now = until - 1;
      expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input).toBeNull();
      now++;
    }
    expect(await input.pendingBrowserInputs()).toHaveLength(1);
    expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input?.id).toBe(first.id);
    expect((await post('/input/fail', { ...claim, error: 'After-turn pickup was withdrawn before Send.' })).body.ok).toBe(true);
    now += input.RECOVERY_WITHDRAW_REOFFER_DELAYS_MS[0];
    input.resetInputForTests();
    expect(await input.pendingBrowserInputs()).toHaveLength(1);
    expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input?.id).toBe(first.id);
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
    expect((await input.listInputs()).find(row => row.id === first.id)?.state).toBe('browser');
    expect((await post('/input/ack', { ...claim, messageId: 'accepted-next' })).body.ok).toBe(true);
    input.resetInputForTests();
    expect(await input.pendingBrowserInputs()).toEqual([]);
  } finally { clock.mockRestore(); }
});

it('commits a failed-source listening deadline while another chat observation is still recording', async () => {
  const bridge = await import('../src/main/bridge.js');
  const recorder = await import('../src/main/session/recorder.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  let release = () => {};
  let otherPost: Promise<unknown> | undefined;
  let held: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Failed receipt concurrency', conversationId });
    const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: now },
      { kind: 'turn_start', turnId: 'concurrent-failed-source', time: now }
    ] });
    await attributedMcp(conversationId, 'concurrent-failed-source');
    now += bridge.PRO_SILENCE_MS;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((row: any) => row.conversationId === conversationId);
    expect(repair).toBeDefined();
    const confirmedAt = now;
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    expect(await input.pendingBrowserInputs()).toHaveLength(1);
    const otherId = randomUUID();
    let entered = () => {};
    const recording = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const record = recorder.recordChatObservations;
    held = vi.spyOn(recorder, 'recordChatObservations').mockImplementation(async (...args) => {
      if (args[0] === otherId) { entered(); await gate; }
      return record(...args);
    });
    otherPost = post('/events', { conversationId: otherId, events: [{ kind: 'turn_start', turnId: 'unrelated-turn', time: now }] });
    await recording;
    now += 6_000;
    expect((await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'concurrent-failed-source',
      outcome: 'failed', reason: 'thinking_failed', time: now }] })).status).toBe(200);
    input.resetInputForTests();
    expect((await input.listInputs()).find(row => row.id === first.id)?.silenceBoundary?.listenUntil).toBe(confirmedAt + 5 * 60_000);
    const claim = { id: first.id, owner: 'replacement', conversationId, requiresAuthorization: true };
    now = confirmedAt + 5 * 60_000 - 1;
    expect((await post('/input/claim', claim)).body.input).toBeNull();
    release(); await otherPost;
    now++;
    expect((await post('/input/claim', claim)).body.input?.id).toBe(first.id);
  } finally { release(); await otherPost; held?.mockRestore(); clock.mockRestore(); }
});

it.each(['queued', 'claimed', 'tool', 'settled-failure'])('withdraws a silence ticket on new work and rearms refresh (%s)', async change => {
  const bridge = await import('../src/main/bridge.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Resumed Pro', conversationId });
    const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'user_message', messageId: 'resume-user', text: 'Continue', time: now },
      { kind: 'turn_start', turnId: 'resume-turn', time: now }
    ] });
    await attributedMcp(conversationId, 'resume-turn');
    now += bridge.PRO_SILENCE_MS + 1;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((row: any) => row.conversationId === conversationId);
    expect(repair).toBeDefined();
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    const claim = { id: first.id, owner: 'resume-page', conversationId };
    if (change === 'claimed' || change === 'tool') expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input?.id).toBe(first.id);
    if (change === 'settled-failure') await post('/events', { conversationId, events: [
      { kind: 'turn_end', turnId: 'resume-turn', outcome: 'failed', reason: 'thinking_failed', time: now }
    ] });
    now += 1_000;
    if (change === 'tool') {
      const { recordToolCall } = await import('../src/main/session/recorder.js');
      await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'Read complete' }],
        outcome: 'ok', durationMs: 1, startedAt: now, requestId: 'silence-resumed-call', conversationId });
    } else await post('/events', { conversationId, events: [
      { kind: 'assistant_message', turnId: 'resume-turn', messageId: 'new-interim', text: 'Still working', state: 'streaming', activeNow: true, time: now }
    ] });
    expect((await input.listInputs()).find(row => row.id === first.id)).toMatchObject({ state: 'queued', owner: null });
    expect((await input.listInputs()).find(row => row.id === first.id)?.silenceBoundary).toBeUndefined();
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(false);
    expect(await input.pendingBrowserInputs()).toEqual([]);
    now += bridge.PRO_SILENCE_MS - 1;
    await bridge.sweepStaleSwarm(now);
    expect((await post('/status', { openConversations: [conversationId] })).body.repairs.filter((row: any) => row.conversationId === conversationId)).toEqual([]);
    now += 2;
    await bridge.sweepStaleSwarm(now);
    expect((await post('/status', { openConversations: [conversationId] })).body.repairs.some((row: any) => row.conversationId === conversationId)).toBe(true);
  } finally { clock.mockRestore(); }
});

it.each(['different-user', 'streaming', 'cancelled', 'different-chat'])(
  'refuses a recorded helper result with %s evidence', async condition => {
    const controller = new AbortController();
    const helper = randomUUID();
    await createSession({ title: 'Exact helper', conversationId: helper });
    const answer = input.requestBrowserDecision('Choose the next action', controller.signal, { conversationId: helper });
    void answer.catch(() => undefined);
    try {
      const [row] = await input.listInputs();
      await post('/input/claim', { id: row!.id, owner: 'original-document', conversationId: helper });
      await post('/input/ack', { id: row!.id, owner: 'original-document', conversationId: helper, messageId: 'accepted-user' });
      if (condition === 'cancelled') { controller.abort(); await answer.catch(() => undefined); }
      const conversationId = condition === 'different-chat' ? randomUUID() : helper;
      await post('/events', { conversationId, events: [
        { kind: 'user_message', messageId: condition === 'different-user' ? 'foreign-user' : 'accepted-user', text: 'Choose the next action', time: Date.now() },
        { kind: 'assistant_message', messageId: 'candidate-final', turnId: 'candidate-turn', text: 'candidate',
          state: condition === 'streaming' ? 'streaming' : 'final', final: condition !== 'streaming', time: Date.now() }
      ] });
      expect((await input.listInputs()).find(entry => entry.id === row!.id)?.state).toBe(condition === 'cancelled' ? 'cancelled' : 'decision');
    } finally { controller.abort(); await answer.catch(() => undefined); }
  });
it('freezes image injection from staged originals with replay, receipt, and browser isolation', async () => {
  const { default: sharp } = await import('sharp');
  const { stageInputAttachment } = await import('../src/main/session/input-attachments.js');
  const { readEvents } = await import('../src/main/session/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Staged image injection', conversationId });
  const bytes = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#123456' } }).png().toBuffer();
  const attachment = await stageInputAttachment({ name: 'full-resolution.png', bytes }, new Set());
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-astra', time: Date.now() },
    { kind: 'turn_start', turnId: 'image-turn', time: Date.now() }
  ] });
  const authored = { ...message(session.id, 'off'), mode: 'auto' as const, attachments: [attachment], attachmentDelivery: 'tool' as const };
  const result = await handlers.get('sessions:send')!(null, authored);
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ attachments: [attachment], attachmentDelivery: 'tool', transportIntent: 'tool' });
  const dataUrl = result.data.toolImages[0].dataUrl;
  expect(await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).metadata()).toMatchObject({ width: 1600, height: 800 });
  input.resetInputForTests();
  expect((await handlers.get('sessions:send')!(null, authored)).data.toolImages[0].dataUrl).toBe(dataUrl);
  expect(await input.pendingBrowserInputs()).toEqual([]);
  expect(await input.claimBrowserInput(authored.id, 'page', conversationId)).toBeNull();
  expect((await input.offerToolInput(session.id, randomUUID(), 'wrong', 0)).messages).toEqual([]);
  expect(await input.hasEligibleToolInput(session.id)).toBe(true);
  const offered = await input.offerToolInput(session.id, conversationId, 'request', 0);
  expect(offered.messages[0]!.images[0]!.dataUrl).toBe(dataUrl);
  expect(await input.offerToolInput(session.id, conversationId, 'same-concurrent-request', 0)).toEqual(offered);
  await input.acknowledgeToolInput(session.id, conversationId, 'later-request', Date.now() + 1);
  expect((await input.listInputs())[0]!.state).toBe('sent');
  const history = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
  expect(history).toHaveLength(1);
  expect(history[0]!.attachments).toBeUndefined();
  expect(history[0]!.assets).toHaveLength(1);
  // Explicit Inject never silently converts into a separate native message on final.
  const second = await input.enqueueInput({ ...authored, id: randomUUID() });
  await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'image-turn', outcome: 'completed', time: Date.now() + 2 }] });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  expect(await input.claimBrowserInput(second.id, 'page', conversationId)).toBeNull();
  await expect(input.enqueueInput({ ...authored, id: randomUUID() })).rejects.toThrow('active chat');
});

it('rejects image admission when the session changes during normalization', async () => {
  const attachments = await import('../src/main/session/input-attachments.js');
  const { default: sharp } = await import('sharp');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Image preparation race', conversationId });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-astra', time: Date.now() },
    { kind: 'turn_start', turnId: 'image-race-turn', time: Date.now() }
  ] });
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#123456' } }).png().toBuffer();
  const file = await attachments.stageInputAttachment({ name: 'race.png', bytes }, new Set());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const normalize = attachments.normalizeInputAttachments;
  const held = vi.spyOn(attachments, 'normalizeInputAttachments').mockImplementation(async files => { await gate; return normalize(files); });
  try {
    const pending = input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', attachments: [file], attachmentDelivery: 'tool' });
    const rejected = expect(pending).rejects.toThrow('active chat changed');
    await vi.waitFor(() => expect(held).toHaveBeenCalled());
    await rebindSession(session.id, conversationId, randomUUID());
    release(); await rejected;
    expect(await input.listInputs()).toEqual([]);
  } finally { release(); held.mockRestore(); }
});

it('serves staged attachment bytes only to the exact unsent browser input owner', async () => {
  const { stageInputAttachment } = await import('../src/main/session/input-attachments.js');
  const file = await stageInputAttachment({ text: 'Attachment payload' }, new Set());
  const other = await stageInputAttachment({ text: 'Different input' }, new Set([file.id]));
  const row = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', attachments: [file] });
  const request = { id: row.id, owner: 'document-one', conversationId: null, attachmentId: file.id, offset: 0 };
  expect((await post('/input/attachment', request)).status).toBe(409);
  await post('/input/claim', { id: row.id, owner: request.owner, conversationId: null, requiresAuthorization: true });
  expect((await post('/input/attachment', { ...request, owner: 'document-two' })).status).toBe(409);
  expect((await post('/input/attachment', { ...request, attachmentId: other.id })).status).toBe(409);
  expect(Buffer.from((await post('/input/attachment', request)).body.chunk, 'base64').toString()).toBe('Attachment payload');
  expect((await post('/input/claim', { ...request, authorize: true })).body.ok).toBe(true);
  expect((await post('/input/attachment', request)).status).toBe(409);
});
it('revokes a claimed send via IPC, fences pre-send authorization and records a late exact receipt', async () => {
  const row = message(null, 'goal');
  await input.enqueueInput(row as import('../src/main/session/input.js').InputArgs);
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId: null })).body.input).toBeTruthy();
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId: null, authorize: true })).body.ok).toBe(true);
  expect((await handlers.get('sessions:cancelInput')!(null, { id: row.id })).ok).toBe(true);
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId: null, authorize: true })).body.ok).toBe(false);
  const conversationId = randomUUID();
  await createSession({ title: 'Late receipt', conversationId });
  expect((await post('/input/ack', { id: row.id, owner: 'page', conversationId, messageId: 'native-late' })).body.ok).toBe(true);
  expect((await input.listInputs())[0]).toMatchObject({ state: 'cancelled', historyRecorded: true, messageId: 'native-late' });
});
it('enriches an ID-less cancelled ACK after restart and publishes the same delivery into history', async () => {
  const store = await import('../src/main/session/store.js');
  const row = { ...message(null, 'off'), automation: undefined } as import('../src/main/session/input.js').InputArgs;
  await input.enqueueInput(row);
  expect((await post('/input/claim', {
    id: row.id, owner: 'released-ack-page', conversationId: null, requiresAuthorization: true
  })).body.input).toBeTruthy();
  expect((await post('/input/claim', {
    id: row.id, owner: 'released-ack-page', conversationId: null, authorize: true
  })).body.ok).toBe(true);
  expect((await handlers.get('sessions:cancelInput')!(null, { id: row.id })).ok).toBe(true);

  const conversationId = randomUUID();
  const session = await createSession({ title: 'Released ACK history', conversationId });
  expect((await post('/input/ack', { id: row.id, owner: 'released-ack-page', conversationId })).body.ok).toBe(true);
  expect((await input.listInputs())[0]).toMatchObject({
    state: 'cancelled', conversationId, deliveredAt: expect.any(Number)
  });
  expect((await input.listInputs())[0]?.historyRecorded).toBeUndefined();
  expect((await input.listInputs())[0]?.messageId).toBeUndefined();

  input.resetInputForTests();
  expect(await input.pendingBrowserInputs()).toEqual([]);
  expect((await post('/input/ack', {
    id: row.id, owner: 'released-ack-page', conversationId, messageId: 'native-after-restart'
  })).body.ok).toBe(true);
  const restored = (await input.listInputs())[0]!;
  expect(restored).toMatchObject({
    state: 'cancelled', messageId: 'native-after-restart', deliveredAt: expect.any(Number), historyRecorded: true
  });
  expect(await input.pendingBrowserInputs()).toEqual([]);

  const recorded = (await store.readEvents(session.id, { kinds: ['user_message'] }))
    .filter(event => event.kind === 'user_message' && event.inputId === row.id);
  expect(recorded).toEqual([expect.objectContaining({
    messageId: 'native-after-restart', inputDelivery: 'confirmed', authoredText: row.text
  })]);
});
it.each(['reference', 'json', 'reference-new-human', 'reference-goal'] as const)('atomically retains one Loop continuation through the native accepted-answer callback (%s)', async shape => {
  const store = await import('../src/main/session/store.js');
  const { recordLoopMcpProof } = await import('./goal-mcp-proof.js');
  const config = defaultConfig(), mode = shape === 'reference-goal' ? 'goal' : 'loop';
  await saveConfig({ ...config,
    multiAgent: { ...config.multiAgent, defaultModel: 'gpt-6-thinking', defaultReasoning: 'xhigh' },
    goal: { ...config.goal, enabled: true, mode, backend: 'chatgpt', loopBackend: 'chatgpt',
      helperModel: 'gpt-6-thinking', helperReasoning: 'high' } });
  const conversationId = randomUUID(), turnId = 'reference-source-' + randomUUID();
  const session = await createSession({ title: 'Native helper answer transaction', conversationId });
  const objective = 'Finish the existing editor workflow; preserve source media and the original acceptance.';
  await goal.setGoalObjectiveNow(conversationId, objective);
  await goal.setGoalSwitchNow(conversationId, mode, true);
  await store.appendEvent(session.id, { source: 'extension', kind: 'user_message', time: Date.now(),
    messageId: randomUUID(), message: { text: objective, chars: objective.length, truncated: false } });
  await recordLoopMcpProof(session.id, turnId);
  const finalMessageId = randomUUID();
  const final = await store.appendEvent(session.id, { source: 'extension', kind: 'assistant_message', time: Date.now(),
    turnId, messageId: finalMessageId, state: 'final', final: true,
    message: { text: 'A verified editor checkpoint; continue the unfinished item.', chars: 57, truncated: false } });
  await store.appendEvent(session.id, { source: 'extension', kind: 'turn_end', time: Date.now(), turnId, outcome: 'completed' });
  await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, turnId,
    replyId: finalMessageId, eventSeq: final.seq, blocked: false });
  goal.startGoalDraft({ conversationId, sessionId: session.id, turnId });
  await vi.waitFor(async () => expect((await input.listInputs()).filter(row => row.purpose === 'decision')).toHaveLength(1));
  const helper = (await input.listInputs()).find(row => row.purpose === 'decision')!;
  const owner = 'native-reference-helper';
  expect((await post('/input/claim', { id: helper.id, owner, conversationId: null, requiresAuthorization: true })).body.input?.id).toBe(helper.id);
  expect((await post('/input/claim', { id: helper.id, owner, conversationId: null, authorize: true })).body.ok).toBe(true);
  expect((await post('/input/ack', { id: helper.id, owner, conversationId: null, messageId: randomUUID() })).body.ok).toBe(true);
  if (shape === 'reference-new-human') {
    const correction = 'New human requirement: stop editing the UI and preserve the backend.';
    await store.appendEvent(session.id, { source: 'extension', kind: 'user_message', time: Date.now(),
      messageId: randomUUID(), message: { text: correction, chars: correction.length, truncated: false } });
  }
  const response = shape.startsWith('reference') ? '::chatgpt-content-reference{index="0" source_message_id="exact-source"}'
    : JSON.stringify({ action: 'continue', reply: 'Finish the next unfinished editor requirement.' });
  expect((await post('/input/answer', { id: helper.id, owner, conversationId: null, response })).body.ok).toBe(true);
  if (shape === 'reference-new-human' || shape === 'reference-goal') {
    await vi.waitFor(() => expect(goal.goalViewFor(conversationId)?.stage).toBe('failed'));
    expect(goal.goalViewFor(conversationId)?.error).toContain(
      shape === 'reference-goal' ? 'goal_content_reference_unresolved' : 'goal_human_history_changed');
    expect((await input.listInputs()).filter(row => row.sourceHelperId === helper.id)).toEqual([]);
    expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
    expect(goal.goalArmedFor(conversationId)).toBe(true);
    return;
  }
  await vi.waitFor(() => expect(goal.goalViewFor(conversationId)?.stage).toBe('no-reply'));
  const rows = await input.listInputs();
  expect(rows.find(row => row.id === helper.id)).toMatchObject({ state: 'sent', decisionSourceSessionId: session.id });
  const outgoing = rows.filter(row => row.sourceHelperId === helper.id);
  expect(outgoing).toHaveLength(1);
  // Executor policy belongs to this account, independently of the helper's High setting.
  // Losing it here lets a quota-locked GPT-6 chat silently inherit an old native 5.6 picker.
  expect(outgoing[0]).toMatchObject({ sessionId: session.id, conversationId, state: 'queued',
    sourceHelperAcceptedAt: expect.any(Number), model: 'gpt-6-thinking', reasoningEffort: 'xhigh' });
  expect(rows.find(row => row.id === helper.id)?.decisionSourceTurnId).toBe(turnId);
  expect(outgoing[0]!.text).not.toContain('::chatgpt-content-reference');
  expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
  const originalOutgoingId = outgoing[0]!.id;
  await post('/input/answer', { id: helper.id, owner, conversationId: null, response });
  expect((await input.listInputs()).filter(row => row.sourceHelperId === helper.id).map(row => row.id)).toEqual([originalOutgoingId]);
  const executor = 'model-policy-executor';
  expect((await post('/input/claim', { id: originalOutgoingId, owner: executor,
    conversationId, requiresAuthorization: true })).body.input)
    .toMatchObject({ id: originalOutgoingId, model: 'gpt-6-thinking', reasoningEffort: 'xhigh' });
});

it('completes only an explicitly temporary planner over HTTP without inventing a conversation id', async () => {
  const controller = new AbortController();
  const answer = input.requestBrowserDecision('Transient plan context', controller.signal, { lifetime: 'temporary-planner' });
  await vi.waitFor(async () => expect(await input.pendingBrowserInputs()).toHaveLength(1));
  const row = (await input.listInputs())[0]!;
  expect((await post('/input/claim', { id: row.id, owner: 'temp-page', conversationId: null, requiresAuthorization: true })).body.input.lifetime).toBe('temporary-planner');
  expect(operatorPromptBody((await post('/input/claim', { id: row.id, owner: 'temp-page', conversationId: null, requiresAuthorization: true })).body.input.text!)).toBe('Transient plan context');
  // A claim is not Send permission. The native helper must receive Main's final authorization.
  expect((await post('/input/ack', { id: row.id, owner: 'temp-page', conversationId: null })).body.ok).toBe(false);
  expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'browser', owner: 'temp-page' });
  expect((await post('/input/claim', { id: row.id, owner: 'temp-page', conversationId: null, authorize: true })).body.ok).toBe(true);
  expect((await post('/input/ack', { id: row.id, owner: 'temp-page', conversationId: null })).body.ok).toBe(true);
  expect((await post('/input/answer', { id: row.id, owner: 'other-page', conversationId: null, response: 'wrong' })).status).toBe(409);
  expect((await post('/input/answer', { id: row.id, owner: 'temp-page', conversationId: null, response: 'Transient plan answer' })).body.ok).toBe(true);
  expect(await answer).toBe('Transient plan answer');
  expect((await input.listInputs())[0]).toMatchObject({ conversationId: null, deliveredSessionId: null, state: 'sent' });
});
it('retains the provider conversation in terminal helper close offers', async () => {
  const controller = new AbortController();
  const answer = input.requestBrowserDecision('Routed plan context', controller.signal, { lifetime: 'temporary-planner' });
  await vi.waitFor(async () => expect(await input.pendingBrowserInputs()).toHaveLength(1));
  const row = (await input.listInputs()).find(item => item.text === 'Routed plan context')!;
  const conversationId = randomUUID();
  expect((await post('/input/claim', { id: row.id, owner: 'routed-page', conversationId: null, requiresAuthorization: true })).body.input).toBeTruthy();
  expect((await post('/input/ack', { id: row.id, owner: 'routed-page', conversationId })).body.ok).toBe(false);
  expect((await post('/input/claim', { id: row.id, owner: 'routed-page', conversationId: null, authorize: true })).body.ok).toBe(true);
  expect((await post('/input/ack', { id: row.id, owner: 'routed-page', conversationId })).body.ok).toBe(true);
  expect((await post('/input/output', { id: row.id, owner: 'routed-page', conversationId })).body).toEqual({ ok: false });
  expect((await post('/input/answer', { id: row.id, owner: 'routed-page', conversationId, response: 'Routed plan answer' })).body.ok).toBe(true);
  expect(await answer).toBe('Routed plan answer');
  expect((await post('/status', { openConversations: [] })).body.inputs).toContainEqual(
    expect.objectContaining({ id: row.id, close: true, conversationId }));
  expect((await post('/input/output', { id: row.id, owner: 'routed-page', conversationId })).body).toEqual({ ok: true });
  expect((await post('/input/output', { id: row.id, owner: 'foreign-page', conversationId })).body).toEqual({ ok: false });
  expect((await post('/input/output', { id: row.id, owner: 'routed-page', conversationId: randomUUID() })).body).toEqual({ ok: false });
  const file = path.join((await import('node:os')).tmpdir(), 'CoS-helper-outputs', `${row.id}.json`);
  expect(JSON.parse(await fs.readFile(file, 'utf8')).response).toBe('Routed plan answer');
  await fs.unlink(file);
  expect((await post('/input/output', { id: row.id, owner: 'routed-page', conversationId })).body).toEqual({ ok: false });
  expect((await post('/input/answer', { id: row.id, owner: 'routed-page', conversationId, response: 'Routed plan answer' })).body.ok).toBe(true);
  expect((await post('/input/output', { id: row.id, owner: 'routed-page', conversationId })).body).toEqual({ ok: true });
  await fs.unlink(file);
});
afterAll(async () => {
  resetRouteSettleForTests();
  await stopBridge(); await flushDurable(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});
const message = (sessionId: string | null, automation: 'off' | 'goal' | 'loop') => ({
  id: randomUUID(), sessionId, automation, text: 'Complete this request', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null
});
it('freezes the complete current prompt for each new chat and leaves the authored input intact', async () => {
  const config = defaultConfig();
  const standing = 'ä 🐱 Complete standing guidance\n'.repeat(100) + 'FINAL_STANDING_MARKER';
  await saveConfig({ ...config, mcp: { ...config.mcp, instructions: standing } });
  const first = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', text: 'First request' });
  const canonical = await currentCoreInstructions();
  const claim = await input.claimBrowserInput(first.id, 'exact-document', null, true);
  expect(operatorPromptBody(claim?.text!)).toBe(prependUserPrompt(
    'First request', `${PRIME_CORE_PREFLIGHT_INSTRUCTIONS}\n\n${canonical}`
  ));
  expect(claim?.text).toContain(standing);
  expect((await input.listInputs()).find(row => row.id === first.id)?.text).toBe('First request');
  await saveConfig({ ...config, mcp: { ...config.mcp, instructions: 'Updated standing guidance' } });
  expect((await input.claimBrowserInput(first.id, 'exact-document', null, true))?.text).toBe(claim?.text);
  await input.cancelInput(first.id);
  const second = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', text: 'Second request' });
  const next = await input.claimBrowserInput(second.id, 'next-document', null, true);
  expect(operatorPromptBody(next?.text!)).toBe(prependUserPrompt(
    'Second request', `${PRIME_CORE_PREFLIGHT_INSTRUCTIONS}\n\n${await currentCoreInstructions()}`
  ));
  expect(userPromptText(next!.text)).toBe('Second request');
});

it.each(['off', 'goal', 'loop'] as const)('does not repeat setup in an existing chat with %s enabled', async automation => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Existing executor', conversationId });
  const row = await input.enqueueInput({ ...message(session.id, automation), mode: 'auto', text: 'Continue the original work' });
  const claim = await input.claimBrowserInput(row.id, 'followup-page', conversationId, true);
  expect(operatorPromptBody(claim?.text!)).toBe(prependUserPrompt('Continue the original work', ''));
  input.resetInputForTests();
  expect((await input.claimBrowserInput(row.id, 'followup-page', conversationId, true))?.text).toBe(claim?.text);
});

it('freezes selected skills from a planned original request through browser claim and restart', async () => {
  const id = `review-${randomUUID()}`;
  const skillDirectory = path.join(directory, 'skills', id);
  await fs.mkdir(skillDirectory);
  await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), `---\nname: Review\ndescription: Review code changes\n---\nSKILL_FROZEN_BODY 🐱`);
  const objective = `/${id}\nOriginal constraints must survive.`;
  const row = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto',
    text: `/${id}\nImplement the whole task.`, objective, stages: ['Verify all behavior.'] });
  const claim = await input.claimBrowserInput(row.id, 'skills-browser-page', null, true);
  expect(claim).not.toBeNull();
  expect(claim!.text.match(/SKILL_FROZEN_BODY/g)).toHaveLength(1);
  expect(claim!.text.indexOf('# Selected skills')).toBeGreaterThan(claim!.text.indexOf('# Local tools'));
  expect(userPromptText(claim!.text)).toContain(objective);
  expect(userPromptText(claim!.text)).toContain('Verify all behavior.');
  expect(userPromptText(claim!.text)).not.toContain('SKILL_FROZEN_BODY');
  expect(claim!.text.length).toBeLessThanOrEqual(96000);
  await removeSkill(id);
  input.resetInputForTests();
  expect((await input.claimBrowserInput(row.id, 'skills-browser-page', null, true))!.text).toBe(claim!.text);
  expect((await input.listInputs()).find(entry => entry.id === row.id)!.text).toBe(row.text);
});

it('freezes explicit follow-up skills for MCP delivery while blocking ambiguous replay after restart', async () => {
  const id = `followup-${randomUUID()}`;
  const skillDirectory = path.join(directory, 'skills', id);
  await fs.mkdir(skillDirectory);
  await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), `---\nname: Follow-up\ndescription: Explain an implementation\n---\nFOLLOWUP_SKILL_ORIGINAL`);
  const session = await createSession({ title: 'Skill follow-up', conversationId: randomUUID() });
  const text = `/prompt ${id}\nExplain the current changes.`;
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', text });
  const offered = await input.offerToolInput(session.id, session.conversationId, 'skill-offer', 0);
  expect(offered.messages).toHaveLength(1);
  const prepared = offered.messages[0]!.text;
  expect(prepared).toContain('FOLLOWUP_SKILL_ORIGINAL');
  expect(prepared).not.toContain('# Local tools');
  expect(userPromptText(prepared)).toBe(text);
  await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), '# Changed\nFOLLOWUP_SKILL_CHANGED');
  input.resetInputForTests();
  const retry = await input.offerToolInput(session.id, session.conversationId, 'skill-offer-retry', 0);
  expect(retry.messages).toEqual([]);
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({
    text,
    deliveryText: prepared,
    state: 'tool',
    toolReceiptUncertain: true
  });
  await removeSkill(id);
});

it('delivers a saved explicitly chosen Skill body in an existing Goal chat after a neutral human follow-up', async () => {
  const id = `retained-${randomUUID()}`;
  const skillDirectory = path.join(directory, 'skills', id);
  await fs.mkdir(skillDirectory);
  await fs.writeFile(path.join(skillDirectory, 'SKILL.md'),
    '---\nname: Retained Skill\ndescription: Explicit human workflow\n---\nRETAINED_GOAL_SKILL_BODY');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Retained workflow', conversationId });
  const original = `/${id}\nPreserve the original task and native acceptance.`;
  expect(await goal.setGoalObjectiveNow(conversationId, original)).toBe(original);
  const followup = 'Continue the same saved task.';
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto',
    text: followup });
  const offered = await input.offerToolInput(session.id, conversationId, 'saved-skill-offer', 0);
  expect(offered.messages).toHaveLength(1);
  expect(offered.messages[0]!.text).toContain(`## ${id}\nSource: /skills/${id}/SKILL.md`);
  expect(offered.messages[0]!.text).toContain('RETAINED_GOAL_SKILL_BODY');
  // Native Input now seals the genuine task version in its frozen delivery; the authored correction stays intact.
  const { executionScopeFromNativeDelivery } = await import('../src/shared/agent-plan.js');
  const scopeSha256 = executionScopeFromNativeDelivery(offered.messages[0]!.text, followup);
  expect(scopeSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(userPromptText(offered.messages[0]!.text)).toBe(
    `${followup}\n\n<!-- cos-execution-scope-sha256:${scopeSha256} -->`);
  expect((await input.listInputs()).find(entry => entry.id === row.id)?.text).toBe(followup);
  expect((await input.listInputs()).find(entry => entry.id === row.id)?.deliveryText)
    .toBe(offered.messages[0]!.text);
  await fs.writeFile(path.join(skillDirectory, 'SKILL.md'),
    '---\nname: Retained Skill\ndescription: Updated after a frozen claim\n---\nCHANGED_LATER_SKILL_BODY');
  input.resetInputForTests();
  expect((await input.offerToolInput(session.id, conversationId, 'saved-skill-restart', 0)).messages).toEqual([]);
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({
    deliveryText: offered.messages[0]!.text, toolReceiptUncertain: true
  });
  await removeSkill(id);
});

it('delivers only the selected project AGENTS.md, freezes claims across restart, and budgets the Astra appendix before cutting', async () => {
  const folder = path.join(directory, 'project-' + randomUUID());
  await fs.mkdir(folder);
  const file = path.join(folder, 'AGENTS.md');
  await fs.writeFile(file, 'PROJECT_HEAD\n' + 'project instructions\n'.repeat(30000) + '\nPROJECT_TAIL');
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'project', path: folder }], ui: { ...config.ui, finishTool: true } });
  const project = await addProject(folder);
  const nativeProjectId = `g-p-${randomUUID().replace(/-/g, '')}`;
  const projectRequest = project.chatgpt && 'requestId' in project.chatgpt ? project.chatgpt.requestId : null;
  if (!projectRequest) throw new Error('Missing native Project creation request');
  expect(await claimProjectCreate(projectRequest, 'project-creator-document')).toBe(true);
  expect(await armProjectCreate(projectRequest, 'project-creator-document')).toBe(true);
  expect(await completeProjectCreate(projectRequest, 'project-creator-document', nativeProjectId)).toBe(true);
  const request = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', projectId: project.id,
    model: 'gpt-6-pro', reasoningEffort: 'pro' });
  const claim = await input.claimBrowserInput(request.id, 'project-document', null, true, nativeProjectId);
  expect(claim!.text.length).toBeLessThanOrEqual(96000);
  expect(claim!.text).toContain(await currentCoreInstructions());
  expect(claim!.text).toContain('PROJECT_HEAD');
  expect(claim!.text).not.toContain('PROJECT_TAIL');
  expect(claim!.text).toContain('Read AGENTS.md yourself');
  expect(userPromptText(claim!.text)).toBe(request.text + '\n\n' + finishInstruction());
  expect((await input.listInputs()).find(row => row.id === request.id)!.text).toBe(request.text);
  await fs.writeFile(file, 'PROJECT_CHANGED');
  input.resetInputForTests();
  expect((await input.claimBrowserInput(request.id, 'project-document', null, true, nativeProjectId))!.text).toBe(claim!.text);
  await input.cancelInput(request.id);
  const normal = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto' });
  const ordinary = await input.claimBrowserInput(normal.id, 'ordinary-document', null);
  expect(ordinary!.text).not.toMatch(/PROJECT_HEAD|PROJECT_CHANGED|# AGENTS.md instructions for/);
  await input.cancelInput(normal.id);
  const session = await createSession({ title: 'Project follow-up', conversationId: 'project-followup-chat' });
  await assignSessionProject(session.id, project.id);
  const followup = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
  const tool = await input.offerToolInput(session.id, session.conversationId, 'project-tool-call', Date.now());
  expect(tool.messages).toHaveLength(1);
  expect(tool.messages[0]!.text).not.toContain('PROJECT_CHANGED');
  expect(operatorPromptBody(tool.messages[0]!.text!)).toBe(prependUserPrompt(followup.text, ''));
  expect(operatorPromptBody((await input.listInputs()).find(row => row.id === followup.id)!.deliveryText!)).toBe(prependUserPrompt(followup.text, ''));
});
it.each(['finish', 'after-turn'] as const)('wakes browser delivery after a committed final makes %s input eligible', async mode => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Final-boundary wake', conversationId });
  await post('/events', { conversationId, events: [{ kind: 'turn_start', turnId: 'wake-turn', time: Date.now() }] });
  const queued = await input.enqueueInput({ ...message(session.id, 'off'), mode });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  const snapshots: ReturnType<typeof input.pendingBrowserInputs>[] = [];
  const wake = vi.spyOn(browserWake, 'wakeBrowserWork').mockImplementation(() => { snapshots.push(input.pendingBrowserInputs()); });
  try {
    const complete = await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'wake-turn', outcome: 'completed', time: Date.now() + 1 }] });
    expect(complete.status).toBe(200);
    expect(wake).toHaveBeenCalled();
    expect((await Promise.all(snapshots)).some(rows => rows.some(row => row.id === queued.id))).toBe(true);
    // The notification only prompts a read: it must not consume or claim input.
    expect((await input.listInputs()).find(row => row.id === queued.id)?.state).toBe('queued');
    const claim = await input.claimBrowserInput(queued.id, 'checkpoint-page', conversationId, true);
    expect(operatorPromptBody(claim?.text!)).toBe(prependUserPrompt(queued.text, ''));
  } finally { wake.mockRestore(); }
});
describe('IPC input delivery and Goal control integration', () => {
  it.each([3, 5])('adds the shared %s-minute finish instruction to Astra opening input and excludes other models', async lead => {
    const config = defaultConfig();
    await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: lead } });
    const request = { ...message(null, 'off'), model: 'gpt-6-pro', reasoningEffort: 'pro' };
    await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0]);
    const claimed = await input.claimBrowserInput(request.id, 'opening', null);
    expect(userPromptText(claimed!.text)).toBe(request.text + '\n\n' + finishInstruction(lead));
    expect((await input.listInputs()).find(row => row.id === request.id)?.text).toBe(request.text);
    await saveConfig(config);
    input.resetInputForTests();
    expect((await input.listInputs()).find(row => row.id === request.id)?.deliveryText).toBe(claimed?.text);
    await input.cancelInput(request.id);

    const ordinary = message(null, 'off');
    await input.enqueueInput(ordinary as Parameters<typeof input.enqueueInput>[0]);
    expect(userPromptText((await input.claimBrowserInput(ordinary.id, 'disabled', null))!.text)).toBe(ordinary.text);
    await input.cancelInput(ordinary.id);
    await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: lead } });
    const sol = { ...message(null, 'off'), model: 'gpt-5.6-sol', reasoningEffort: 'high' };
    await input.enqueueInput(sol as Parameters<typeof input.enqueueInput>[0]);
    expect(userPromptText((await input.claimBrowserInput(sol.id, 'sol', null))!.text)).toBe(sol.text);
    await input.cancelInput(sol.id);
    const chat = await createSession({ title: 'Existing native chat', conversationId: randomUUID() });
    const later = message(chat.id, 'off');
    await input.enqueueInput(later as Parameters<typeof input.enqueueInput>[0]);
    expect(operatorPromptBody((await input.claimBrowserInput(later.id, 'later', chat.conversationId))!.text!)).toBe(prependUserPrompt(later.text, ''));
    await input.cancelInput(later.id);
  });
  it('requires an exact plugin claim and matching schema before a refresh completion', async () => {
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoRefreshPlugins: true } });
    const { publishPluginSurface, resetPluginRefreshForTests } = await import('../src/main/plugin-refresh.js');
    resetPluginRefreshForTests();
    await writeDurableNow('plugin-refresh', []);
    const tools = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }];
    publishPluginSurface('core', 'Chat On Steroids Core', 'test', 'Synthetic instructions', tools);
    const requests = (await post('/plugin-refresh', { action: 'pending' })).body.requests;
    expect(requests).toHaveLength(1);
    const identity = { id: requests[0].id, appId: 'asdk_app_synthetic' };
    expect((await post('/plugin-refresh', { ...identity, action: 'claim', connectorName: 'Wrong', tools })).body.ok).toBe(false);
    expect((await post('/plugin-refresh', { ...identity, action: 'claim', connectorName: 'Chat On Steroids Core', tools })).body.ok).toBe(false);
    expect((await post('/plugin-refresh', { ...identity, action: 'claim', connectorName: 'Chat On Steroids Core',
      tools: [{ ...tools[0], description: 'Old declaration' }], attemptToken: randomUUID() })).body.ok).toBe(true);
    expect((await post('/plugin-refresh', { ...identity, action: 'complete', tools: [] })).body.ok).toBe(false);
    expect((await post('/plugin-refresh', { ...identity, action: 'complete', tools, versionId: 'asdk_app_v_synthetic' })).body.ok).toBe(true);
    resetPluginRefreshForTests();
  });
  it('defaults automatic plugin refresh off and revokes an already offered claim without removing the backend', async () => {
    const plugin = await import('../src/main/plugin-refresh.js');
    plugin.resetPluginRefreshForTests();
    await writeDurableNow('plugin-refresh', []);
    const tools = [{ name: 'read', description: 'Current declaration', inputSchema: { type: 'object', properties: {} } }];
    plugin.publishPluginSurface('core', 'Chat On Steroids Core', 'test', '', tools);
    const saved = (await plugin.pendingPluginRefreshes())[0]!;
    expect(saved).toBeDefined();
    expect((await post('/plugin-refresh', { action: 'pending' })).body.requests).toEqual([]);
    expect((await post('/status', { openConversations: [] })).body.pluginRefreshRequests).toEqual([]);
    const configure = (enabled: boolean) => saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoRefreshPlugins: enabled } });
    await configure(true);
    expect((await post('/plugin-refresh', { action: 'pending' })).body.requests[0].id).toBe(saved.id);
    expect((await post('/status', { openConversations: [] })).body.pluginRefreshRequests).toHaveLength(1);
    const claim = { action: 'claim', id: saved.id, appId: 'asdk_app_off_on_test',
      connectorName: 'Chat On Steroids Core', tools: [{ ...tools[0], description: 'Older declaration' }],
      attemptToken: randomUUID() };
    await configure(false);
    expect((await post('/plugin-refresh', claim)).body).toMatchObject({ ok: false, error: 'automatic_refresh_disabled' });
    await configure(true);
    expect((await post('/plugin-refresh', claim)).body.ok).toBe(true);
    await configure(false);
    // A click already accepted while enabled may still report its real result.
    expect((await post('/plugin-refresh', { ...claim, action: 'complete', tools })).body.ok).toBe(true);
    plugin.resetPluginRefreshForTests();
  });
  it('lets only an exact operator-rearmed Core row cross paused and disabled refresh gates', async () => {
    const plugin = await import('../src/main/plugin-refresh.js');
    plugin.resetPluginRefreshForTests();
    await writeDurableNow('plugin-refresh', []);
    const current = [{ name: 'read', description: 'Current declaration', inputSchema: { type: 'object', properties: {} } }];
    const installed = [{ ...current[0], description: 'Older declaration' }];
    plugin.publishPluginSurface('core', 'Chat On Steroids Core', 'test', '', current);
    plugin.publishPluginSurface('desktop', 'Chat On Steroids Desktop', 'test', '', current);
    const due = await plugin.pendingPluginRefreshes();
    const core = due.find(row => row.surface === 'core')!;
    const desktop = due.find(row => row.surface === 'desktop')!;
    const appId = 'asdk_app_operator_gate_test';
    expect(await plugin.requireManualPluginRefresh({ ...core, appId,
      connectorName: 'Chat On Steroids Core', tools: installed, error: 'Automatic attempts exhausted.' })).toBe(true);
    const receipt = randomUUID();
    expect(await plugin.rearmCorePluginRefreshByOperator({ id: core.id, schemaId: core.schemaId,
      appId, receipt })).toBe(true);
    const config = defaultConfig();
    await saveConfig({ ...config, ui: { ...config.ui, automationPaused: true, autoRefreshPlugins: false } });

    const pending = await post('/plugin-refresh', { action: 'pending' });
    expect(pending.body.requests).toEqual([
      expect.objectContaining({ id: core.id, appId, operatorRearmReceipt: receipt,
        operatorRearmGeneration: 1 })
    ]);
    expect((await post('/status', { openConversations: [] })).body.pluginRefreshRequests).toEqual([
      expect.objectContaining({ surface: 'core', schemaId: core.schemaId })
    ]);
    const desktopDenied = await post('/plugin-refresh', { action: 'claim', id: desktop.id,
      appId: 'asdk_app_desktop_gate_test', connectorName: 'Chat On Steroids Desktop', tools: installed,
      attemptToken: randomUUID() });
    expect(desktopDenied.body).toMatchObject({ ok: false, error: 'automation_paused' });
    const claimed = await post('/plugin-refresh', { action: 'claim', id: core.id, appId,
      connectorName: 'Chat On Steroids Core', tools: installed, attemptToken: randomUUID() });
    expect(claimed.body.ok).toBe(true);
    plugin.resetPluginRefreshForTests();
  });
  it('accepts a manual plugin-refresh terminal state and removes it from browser pickup', async () => {
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoRefreshPlugins: true } });
    const { publishPluginSurface, resetPluginRefreshForTests } = await import('../src/main/plugin-refresh.js');
    resetPluginRefreshForTests();
    await writeDurableNow('plugin-refresh', []);
    const tools = [{ name: 'read', description: 'Read current', inputSchema: { type: 'object', properties: {} } }];
    const installed = [{ ...tools[0], description: 'Read old' }];
    publishPluginSurface('core', 'Chat On Steroids Core', 'test', 'Synthetic instructions', tools);
    const request = (await post('/plugin-refresh', { action: 'pending' })).body.requests[0];
    const manual = await post('/plugin-refresh', { ...request, appId: 'asdk_app_synthetic', action: 'manual', connectorName: 'Chat On Steroids Core', tools: installed, error: 'Recreate or republish this custom app.' });
    expect(manual.body.ok).toBe(true);
    expect((await post('/plugin-refresh', { action: 'pending' })).body.requests).toEqual([]);
    resetPluginRefreshForTests();
  });
  it.each(['browser', 'tool'] as const)('records %s receipt text and pixels through the real IPC hook', async (transport) => {
    const { default: sharp } = await import('sharp');
    const { readEvents } = await import('../src/main/session/store.js');
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Receipt integration', conversationId });
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).webp({ lossless: true }).toBuffer();
    const dataUrl = `data:image/webp;base64,${bytes.toString('base64')}`;
    const authored = { ...message(session.id, 'off'), images: [{ name: 'example.webp', dataUrl }] };
    expect((await handlers.get('sessions:send')!(null, authored)).ok).toBe(true);
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(0);
    if (transport === 'browser') {
      expect((await post('/input/claim', { id: authored.id, owner: 'exact-page', conversationId })).body.input).toBeDefined();
      expect((await post('/input/ack', { id: authored.id, owner: 'exact-page', conversationId, messageId: 'native-message' })).body.ok).toBe(true);
    } else {
      expect((await input.offerToolInput(session.id, conversationId, 'same-request', 0)).messages).toHaveLength(1);
      await input.offerToolInput(session.id, conversationId, 'same-request', Date.now() + 1);
    }
    const rows = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputId: authored.id, authoredText: authored.text });
    if (rows[0]?.kind !== 'user_message') throw new Error('Expected exact delivered user receipt');
    assertOperatorPromptEnvelope(rows[0].message.text);
    expect(operatorPromptBody(rows[0].message.text)).toBe(prependUserPrompt(authored.text, ''));
    const assetId = rows[0]!.kind === 'user_message' ? rows[0]!.assets![0]!.id : '';
    expect((await handlers.get('sessions:image')!(null, { id: session.id, assetId })).data).toBe(dataUrl);
    expect((await input.listInputs()).find(row => row.id === authored.id)?.historyRecorded).toBe(true);
  });
  it('keeps a later native page echo canonical across restart after wrapped history projection', async () => {
    const store = await import('../src/main/session/store.js');
    const config = defaultConfig();
    await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: 3 } });
    try {
      const conversationId = randomUUID();
      const request = {
        ...message(null, 'off'), mode: 'auto', model: 'gpt-6-pro', reasoningEffort: 'pro'
      } as Parameters<typeof input.enqueueInput>[0];
      await input.enqueueInput(request);
      const claimed = await input.claimBrowserInput(request.id, 'wrapped-echo-page', null, true);
      expect(claimed?.text).toContain(finishInstruction(3));
      expect(claimed?.text).not.toBe(request.text);
      expect((await input.listInputs()).find(row => row.id === request.id)?.deliveryText).toBe(claimed?.text);
      expect(await input.authorizeBrowserInput(request.id, 'wrapped-echo-page', null)).toBe(true);
      const session = await createSession({ title: 'Wrapped echo convergence', conversationId });
      expect(await input.acknowledgeBrowserInput(request.id, 'wrapped-echo-page', conversationId, 'native-wrapped-echo')).toBe(true);
      expect((await input.listInputs()).find(row => row.id === request.id)).toMatchObject({
        state: 'sent', historyRecorded: true, historyProjectionVersion: 1
      });

      const providerText = `${request.text}\n\nProvider-normalized echo`;
      await store.upsertMessageEvent(session.id, {
        time: Date.now() + 1,
        source: 'extension',
        kind: 'user_message',
        messageId: 'native-wrapped-echo',
        message: { text: providerText, chars: providerText.length, truncated: false }
      });
      let [echo] = await store.readEvents(session.id, { kinds: ['user_message'] });
      expect(echo).toMatchObject({
        inputId: request.id, authoredText: request.text, inputDelivery: 'confirmed',
        message: { text: providerText }
      });

      input.resetInputForTests();
      await input.listInputs();
      [echo] = await store.readEvents(session.id, { kinds: ['user_message'] });
      expect(echo).toMatchObject({
        inputId: request.id, authoredText: request.text, inputDelivery: 'confirmed',
        message: { text: providerText }
      });
    } finally {
      await saveConfig(config);
    }
  });
  it('publishes only nonce-bound catalog observations through HTTP and pushes completion', async () => {
    const { pendingChatModelRequest, resetChatModelsForTests } = await import('../src/main/chat-models.js');
    const browser = await import('../src/main/browser.js');
    const browserRunning = vi.mocked(browser.isPreferredBrowserRunning);
    browserRunning.mockResolvedValue(false);
    try {
    resetChatModelsForTests();
    expect((await handlers.get('chatModels:request')!(null, {})).data.state).toBe('pending');
    const nonce = pendingChatModelRequest()!.nonce;
    const models = [{ id: 'gpt-observed', label: 'GPT Observed', efforts: ['none', 'medium', 'high', 'xhigh'] }];
    const availability = [
      { model: 'gpt-observed-thinking', label: 'GPT Observed', effort: 'high', status: 'available' },
      { model: 'gpt-observed-pro', label: 'GPT Observed Pro', effort: 'pro', status: 'unavailable', retryAt: Date.now() + 60_000 }
    ];
    expect((await post('/models', { nonce: randomUUID(), models })).status).toBe(409);
    pushed.mockClear();
    expect((await post('/models', { nonce, models, availability })).body.ok).toBe(true);
    expect((await handlers.get('chatModels:get')!(null, {})).data.models).toEqual(models);
    expect((await handlers.get('chatModels:get')!(null, {})).data.availability).toEqual(availability);
    expect(pushed).toHaveBeenCalledWith('state:changed', expect.anything());
    expect((await post('/models', { nonce, models })).status).toBe(409);
    } finally { browserRunning.mockResolvedValue(null); }
  });
  it('releases only the expected actual turn through IPC', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'End turn control', conversationId });
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true } });
    // The extension's accepted observation route owns live activity, not a durable
    // recorder row alone. Exercise that authority before asking IPC for live controls.
    const first = await post('/events', { conversationId,
      events: [{ kind: 'turn_start', turnId: 'first-held-turn', time: Date.now() }] });
    expect(first.status).toBe(200);
    expect(first.body.sessionId).toBe(session.id);
    const current = await handlers.get('sessions:controls')!(null, { id: session.id });
    expect(current.data).toMatchObject({ activeTurnId: 'first-held-turn', finishHeld: true });
    expect((await handlers.get('sessions:releaseFinish')!(null, { id: session.id, expectedTurnId: 'stale-turn' })).ok).toBe(false);
    const released = await handlers.get('sessions:releaseFinish')!(null, { id: session.id, expectedTurnId: 'first-held-turn' });
    expect(released.data.finishHeld).toBe(false);
    const second = await post('/events', { conversationId,
      events: [{ kind: 'turn_start', turnId: 'second-held-turn', time: Date.now() + 1 }] });
    expect(second.status).toBe(200);
    expect(second.body.sessionId).toBe(session.id);
    expect((await handlers.get('sessions:releaseFinish')!(null, { id: session.id, expectedTurnId: 'first-held-turn' })).ok).toBe(false);
    expect((await handlers.get('sessions:controls')!(null, { id: session.id })).data.finishHeld).toBe(true);
  });
  it('shares selected-chat objectives with the extension and projects objective-only Goal', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Objective control', conversationId });
    const call = (name: string, extra = {}) => handlers.get(name)!(null, { id: session.id, ...extra });
    await goal.setGoalObjectiveNow(conversationId, 'Legacy objective');
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ enabled: false, own: false });
    expect((await call('sessions:controls')).data).toMatchObject({ objective: 'Legacy objective', automation: 'goal' });
    const saved = await call('sessions:objective', { text: '  Follow this objective  ', mode: 'loop' });
    expect(saved.ok).toBe(true);
    expect(saved.data).toMatchObject({ objective: 'Follow this objective', automation: 'loop' });
    expect(goal.goalObjectiveFor(conversationId)).toBe('Follow this objective');
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ enabled: true, mode: 'loop', own: true });
    const extension = await post('/goal/objective', { conversationId, text: 'Updated in browser', mode: 'goal' });
    expect(extension.status).toBe(200);
    expect((await call('sessions:controls')).data).toMatchObject({ objective: 'Updated in browser', automation: 'goal' });
    const destination = randomUUID();
    expect(await rebindSession(session.id, conversationId, destination)).toBe(true);
    expect((await call('sessions:objective', { text: 'Current destination', mode: 'loop' })).data.conversationId).toBe(destination);
    expect(goal.goalObjectiveFor(conversationId)).toBe('Updated in browser');
    const { setChatBlocked } = await import('../src/main/session/blocked-chats.js');
    setChatBlocked(destination, true);
    expect((await call('sessions:objective', { text: 'Forbidden replacement', mode: 'goal' })).error).toBe('chat_blocked');
    expect(goal.goalObjectiveFor(destination)).toBe('Current destination');
    expect((await call('sessions:objective', { text: '', mode: 'goal' })).data).toMatchObject({ objective: '', automation: 'off' });
    expect(goal.goalSwitchFor(destination)).toMatchObject({ enabled: false, mode: 'loop' });
    setChatBlocked(destination, false);
    await goal.registerGoalDecisionChat(destination);
    expect((await call('sessions:objective', { text: 'Not a source', mode: 'goal' })).error).toBe('goal_worker_chat');
  });
  it('controls exact durable sessions and withdraws Goal without sending new input', async () => {
    const id = randomUUID();
    const session = await createSession({ title: 'Controls', conversationId: id });
    const call = (name: string, extra = {}) => handlers.get(name)!(null, { id: session.id, ...extra });
    const before = (await input.listInputs()).length;
    expect((await call('sessions:automation', { automation: 'goal' })).data.automation).toBe('goal');
    expect((await call('sessions:automation', { automation: 'loop' })).data.automation).toBe('loop');
    expect((await call('sessions:automation', { automation: 'off' })).data.automation).toBe('off');
    expect((await input.listInputs()).length).toBe(before);
    const destination = randomUUID();
    expect(await rebindSession(session.id, id, destination)).toBe(true);
    expect((await call('sessions:automation', { automation: 'goal' })).data.conversationId).toBe(destination);
    expect(goal.goalSwitchFor(id).enabled).toBe(false);
    for (const channel of ['sessions:controls', 'sessions:automation', 'sessions:compact', 'sessions:cancelCompaction']) {
      expect((await handlers.get(channel)!(null, { id: randomUUID(), automation: 'goal' })).ok).toBe(false);
    }
  });
  it('rejects a superseded current attachment before changing either control ledger', async () => {
    const store = await import('../src/main/session/store.js');
    const session = await createSession({ title: 'Superseded control fence', conversationId: randomUUID() });
    const continuation = await import('../src/main/session/continuation.js');
    const { resumeJobFor } = await import('../src/main/bridge.js');
    const retained = await continuation.openContinuationNow(session.id, session.conversationId!, false);
    const expectedToken = resumeJobFor(session.id)!.token;
    const proof = vi.spyOn(store, 'conversationWasSuperseded').mockResolvedValue(true);
    try {
      for (const channel of ['sessions:controls', 'sessions:automation', 'sessions:compact', 'sessions:cancelCompaction']) {
        const payload = channel === 'sessions:cancelCompaction' ? { id: session.id, expectedToken } :
          { id: session.id, automation: 'goal' };
        expect((await handlers.get(channel)!(null, payload)).error).toBe('conversation_superseded');
      }
      expect(goal.goalSwitchFor(session.conversationId!).own).toBe(false);
    } finally { proof.mockRestore(); await continuation.abortContinuationNow(retained.token, 'test finished'); }
  });
  it('uses one idempotent continuation ticket and permits cancellation while blocked', async () => {
    const { setChatBlocked } = await import('../src/main/session/blocked-chats.js');
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Compact controls', conversationId });
    const first = await handlers.get('sessions:compact')!(null, { id: session.id });
    expect(first.ok).toBe(true);
    expect(first.data.job.token).toBeTruthy();
    const repeated = await handlers.get('sessions:compact')!(null, { id: session.id });
    expect(repeated.data.job.token).toBe(first.data.job.token);
    setChatBlocked(conversationId, true);
    expect((await handlers.get('sessions:compact')!(null, { id: session.id })).error).toBe('chat_blocked');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'goal' })).error).toBe('chat_blocked');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'off' })).ok).toBe(true);
    expect((await handlers.get('sessions:cancelCompaction')!(null, { id: session.id })).ok).toBe(false);
    expect((await handlers.get('sessions:cancelCompaction')!(null, { id: session.id, expectedToken: first.data.job.token })).ok).toBe(true);
    setChatBlocked(conversationId, false);
  });
  it('fences durable decision helpers from Goal and compaction after reload', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Decision controls', conversationId });
    await goal.registerGoalDecisionChat(conversationId);
    expect((await handlers.get('sessions:controls')!(null, { id: session.id })).data.blocked).toBe('worker');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'loop' })).error).toBe('worker_goal_disabled');
    expect((await handlers.get('sessions:compact')!(null, { id: session.id })).error).toBe('worker_compaction_disabled');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'off' })).ok).toBe(true);
  });
  it('prepares fresh offline Goal before global activation and preserves authored enqueue identity', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false, backend: 'templates' } });
    const request = message(null, 'goal');
    await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0]);
    const claimed = await input.claimBrowserInput(request.id, 'offline-document', null);
    expect(userPromptText(claimed!.text)).toBe(request.text + GOAL_MARKER_INSTRUCTION);
    expect((await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0])).text).toBe(request.text);
    expect((await input.listInputs()).find(row => row.id === request.id)?.deliveryText).toBe(claimed?.text);
    await input.cancelInput(request.id);
    for (const automation of ['off', 'loop'] as const) {
      const manual = message(null, automation);
      await input.enqueueInput(manual as Parameters<typeof input.enqueueInput>[0]);
      expect(userPromptText((await input.claimBrowserInput(manual.id, automation, null))!.text)).toBe(manual.text);
      await input.cancelInput(manual.id);
    }
  });
  it('prepares scheduled tool input with the delivery backend and preserves frozen bytes without replay after restart', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Scheduled offline', conversationId });
    const request = { ...message(session.id, 'goal'), dueAt: Date.now() + 60000 };
    await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0]);
    expect(await input.offerToolInput(session.id, conversationId, 'early', 0)).toEqual({ messages: [], reminder: '' });
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false, backend: 'templates' } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(request.dueAt + 1);
    try {
      const offered = await input.offerToolInput(session.id, conversationId, 'first', 0);
      expect(offered.messages[0]?.text).toContain(request.text + GOAL_MARKER_INSTRUCTION);
      await saveConfig(defaultConfig());
      input.resetInputForTests();
      expect(await input.offerToolInput(session.id, conversationId, 'repeat', 0)).toEqual({ messages: [], reminder: '' });
      expect((await input.listInputs()).find(row => row.id === request.id)).toMatchObject({
        state: 'tool',
        toolReceiptUncertain: true,
        deliveryText: offered.messages[0]?.text
      });
    } finally { clock.mockRestore(); }
  });
  it('enables automation only when an existing chat receives input, retiring its old final', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Input integration', conversationId });
    await goal.setGoalSwitchNow(conversationId, 'goal', true);
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, replyId: 'old-final', turnId: 'old-turn', eventSeq: 1, blocked: false });
    const request = message(session.id, 'loop');
    const enqueued = await handlers.get('sessions:send')!(null, request);
    expect(enqueued.ok).toBe(true);
    expect(goal.goalSwitchFor(conversationId).mode).toBe('goal');
    expect((await input.offerToolInput(session.id, conversationId, 'tool-request', 0)).messages).toHaveLength(1);
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ mode: 'loop', enabled: true });
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    await goal.setGoalSwitchNow(conversationId, 'loop', false);
    await input.offerToolInput(session.id, conversationId, 'overlapping-request', 0);
    expect(goal.goalSwitchFor(conversationId).enabled).toBe(false);
  });
  it('binds a new chat through HTTP ACK, applies its choice once, and pushes session change', async () => {
    const request = message(null, 'goal');
    await handlers.get('sessions:send')!(null, request);
    const claim = await post('/input/claim', { id: request.id, owner: 'document-owner', conversationId: null });
    expect(claim.body.input.automation).toBe('goal');
    const conversationId = randomUUID();
    const session = await createSession({ title: 'New input', conversationId });
    pushed.mockClear();
    const payload = { id: request.id, owner: 'document-owner', conversationId };
    expect((await post('/input/ack', payload)).body.ok).toBe(true);
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ enabled: true, mode: 'goal' });
    expect((await input.listInputs()).find(row => row.id === request.id)?.deliveredSessionId).toBe(session.id);
    expect(pushed).toHaveBeenCalledWith('session:changed');
    await goal.setGoalSwitchNow(conversationId, 'goal', false);
    expect((await post('/input/ack', payload)).body.ok).toBe(true);
    expect(goal.goalSwitchFor(conversationId).enabled).toBe(false);
    const wrong = randomUUID();
    expect((await post('/input/ack', { ...payload, conversationId: wrong })).status).toBe(409);
    expect(goal.goalSwitchFor(wrong).own).toBe(false);
  });
  it('retains the opening objective when Off wins before ACK and never overwrites later edits on a mode change', async () => {
    const objective = 'Keep this opening objective while switched off';
    const request = { ...message(null, 'goal'), objective };
    await handlers.get('sessions:send')!(null, request);
    await post('/input/claim', { id: request.id, owner: 'off-before-ack', conversationId: null });
    expect(await input.setInputAutomation(request.id, 'off')).toBe(true);
    const conversationId = randomUUID();
    await createSession({ title: 'Off before first receipt', conversationId });
    const ack = { id: request.id, owner: 'off-before-ack', conversationId };
    expect((await post('/input/ack', ack)).body.ok).toBe(true);
    expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ own: true, enabled: false });
    expect(goal.goalArmedFor(conversationId)).toBe(false);
    const saved = await import('../src/main/durable.js');
    expect(JSON.stringify(await saved.readDurable('goal-objectives'))).toContain(objective);
    await goal.setGoalObjectiveNow(conversationId, 'Later edited objective');
    await input.setInputAutomation(request.id, 'off');
    await post('/input/ack', ack);
    expect(goal.goalObjectiveFor(conversationId)).toBe('Later edited objective');
    expect(goal.goalArmedFor(conversationId)).toBe(false);
  });
});

it.each(['auto', 'finish'] as const)('adds one short reminder to every later Astra %s browser send without changing authored text', async mode => {
  const config = defaultConfig();
  await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: 3 } });
  const conversationId = randomUUID();
  const chat = await createSession({ title: 'Later Astra delivery', conversationId });
  const t = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: t },
    { kind: 'turn_start', turnId: 'previous-astra', time: t },
    { kind: 'turn_end', turnId: 'previous-astra', outcome: 'completed', time: t + 1000 }
  ] });
  const request = { ...message(chat.id, 'off'), mode, afterTurn: true } as Parameters<typeof input.enqueueInput>[0];
  await input.enqueueInput(request);
  const claimed = await input.claimBrowserInput(request.id, 'later-page', conversationId, true);
  expect(operatorPromptBody(claimed!.text!)).toBe(prependUserPrompt(request.text + '\n\n' + finishInstruction(3), ''));
  expect(claimed?.text).not.toContain('The user just sent');
  input.resetInputForTests();
  const restored = (await input.listInputs()).find(row => row.id === request.id)!;
  expect(restored.text).toBe(request.text);
  expect(restored.deliveryText).toBe(claimed?.text);
  expect(restored.deliveryText?.split(finishInstruction(3))).toHaveLength(2);
  await input.cancelInput(request.id);
  await saveConfig(config);
});

it('retires a late-confirmed cancelled desktop send after two minutes even as the only managed chat', async () => {
  const conversationId = randomUUID();
  const row = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto' });
  expect((await post('/input/claim', { id: row.id, owner: 'cancelled-send-document', conversationId: null })).status).toBe(200);
  await input.cancelInput(row.id);
  expect((await post('/input/ack', { id: row.id, owner: 'cancelled-send-document', conversationId })).status).toBe(200);
  expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'cancelled', conversationId, deliveredAt: expect.any(Number) });
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 119_000);
  try {
    const before = (await post('/status', { openConversations: [conversationId] })).body;
    expect(before.managedConversations).toContain(conversationId);
    expect(before.retiredConversations).not.toContain(conversationId);
    clock.mockReturnValue(now + 120_001);
    const after = (await post('/status', { openConversations: [conversationId] })).body;
    expect(after.retiredConversations).toContain(conversationId);
    expect(after.closableConversations).toContain(conversationId);
    const session = await createSession({ conversationId, title: 'Resumed conversation' });
    const previous = (await input.listInputs()).find(item => item.id === row.id)!;
    await writeDurableNow('session-input', [previous, { ...previous, id: randomUUID(), sessionId: session.id,
      state: 'sent', createdAt: now + 121_000, deliveredAt: now + 121_000, historyRecorded: true }]);
    input.resetInputForTests(); clock.mockReturnValue(now + 242_001);
    const resumed = (await post('/status', { openConversations: [conversationId] })).body;
    expect(resumed.retiredConversations).not.toContain(conversationId);
    expect(resumed.closableConversations).not.toContain(conversationId);
  } finally { clock.mockRestore(); }
});

it('retires an untouched simple Loop wake when another owned path starts the newer turn', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Satisfied Loop wake', conversationId });
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const request = { ...message(session.id, 'loop'), text: 'continue', mode: 'auto' as const };
    const queued = await input.enqueueInput(request);
    expect(queued.state).toBe('queued');

    clock.mockReturnValue(now + 100);
    await post('/events', { conversationId, events: [
      { kind: 'turn_start', turnId: 'newer-loop-turn', time: now + 50 }
    ] });

    expect((await input.listInputs()).find(row => row.id === queued.id)).toMatchObject({
      state: 'cancelled',
      error: 'Not sent: this Loop started a newer turn before Chrome claimed the wake-up message.'
    });
    expect((await input.pendingBrowserInputs()).some(row => row.id === queued.id)).toBe(false);
  } finally { clock.mockRestore(); }
});

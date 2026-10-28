import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordLoopMcpProof } from './goal-mcp-proof.js';
import { randomUUID } from 'node:crypto';
import { GOAL_CONTINUATIONS, GOAL_MARKER_INSTRUCTION, templateGoalDecision } from '../src/shared/goal-templates.js';
import { assertOperatorPromptEnvelope, operatorPromptBody, operatorPromptOverhead, prepareOperatorPrompt } from '../src/shared/operator-prompt.mjs';

/** Backend decisions keep their authored meaning inside a separately validated wire envelope. */
function authoredReply<T extends object>(value: T): T {
  const reply = (value as { reply?: unknown }).reply;
  if (typeof reply !== 'string' || !reply) return value;
  assertOperatorPromptEnvelope(reply);
  return { ...value, reply: operatorPromptBody(reply) };
}
const browser = vi.hoisted(() => ({ request: vi.fn(), authorize: vi.fn(), settleTimedOut: vi.fn(), paused: [] as Array<{ id: string; sourceSessionId: string }>, inputs: [] as Array<{ id: string; sessionId: string; finishOwner?: { turnId: string; periodic: boolean }; state?: 'sent'; messageId?: string; deliveredAt?: number }> }));
vi.mock('../src/main/session/input.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/main/session/input.js')>()),
  requestBrowserDecision: browser.request,
  authorizeBrowserHelperRetry: browser.authorize,
  settleTimedOutBrowserHelper: browser.settleTimedOut,
  pausedBrowserHelpers: async () => browser.paused,
  listInputs: async () => browser.inputs,
  retainSourceHelperContinuation: async () => 'absent'
}));
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString(), shouldReEncrypt: false })
  }
}));
const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const { initDurableStore, resetDurableForTests, flushDurable, readDurable } = await import('../src/main/durable.js');
const { appendEvent, createSession, initSessionStore, resetSessionStoreForTests, rebindSession } = await import('../src/main/session/store.js');
const { getLog } = await import('../src/main/logger.js');
const { prepareHandoff, resumeBootstrapText } = await import('../src/main/session/handoff.js');
const continuation = await import('../src/main/session/continuation.js');
const goal = await import('../src/main/goal.js');
const blocked = await import('../src/main/session/blocked-chats.js');
const { faultGate, makeTempDir, removeTempDir } = await import('./helpers.js');
let directory: string;
beforeAll(async () => {
  directory = await makeTempDir('clf-goal-backends-');
  initConfigPath(directory);
  initSecretsPath(directory);
  initSessionStore(directory);
  initDurableStore(directory);
});
beforeEach(async () => {
  goal.resetGoalStateForTests();
  continuation.resetContinuationsForTests();
  blocked.resetBlockedChatsForTests();
  browser.request.mockReset();
  browser.authorize.mockReset();
  browser.settleTimedOut.mockReset();
  browser.paused = [];
  browser.inputs = [];
  await setSecret('openRouterApiKey', '');
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'templates', loopBackend: 'api' } });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected API request'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => {
  goal.resetGoalStateForTests();
  continuation.resetContinuationsForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

describe('durable browser decision chat role', () => {
  it.each([
    { size: 16_338, whitespace: 'trailing' }, { size: 16_338, whitespace: 'surrounding' },
    { size: 16_338, whitespace: 'none' }, { size: 18_000, whitespace: 'none' }
  ] as const)('preserves intact authored scope and protected results at the preferred budget boundary ($size/$whitespace)', async ({ size, whitespace }) => {
    const policy = 'Preserve the complete original scope and acceptance. '.padEnd(1452, 'p');
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true,
      mode: 'goal', backend: 'chatgpt', continuationPolicy: 'settled-turn', objectivePrompt: policy } });
    goal.configureLoopForwardReadiness(async () => true, () => false);
    const conversationId = randomUUID(), turnId = 'g-intact-helper-context';
    const session = await createSession({ title: 'intact human budget', conversationId });
    const objective = 'Preserve the saved original task and every real correction. '.padEnd(2871, 'o');
    await goal.setGoalObjectiveNow(conversationId, objective);
    await goal.setGoalSwitchNow(conversationId, 'goal', true, true);
    const padding = whitespace === 'surrounding' ? 3 : whitespace === 'trailing' ? 1 : 0;
    const ending = ' PRIVATE_AUTHORED_SCOPE_END';
    let authored = 'PRIVATE_AUTHORED_SCOPE_START '.padEnd(size - padding - ending.length, 'x') + ending;
    if (whitespace === 'surrounding') authored = '\n' + authored + '\n\n';
    if (whitespace === 'trailing') authored += '\n';
    const injected = 'REDUNDANT_PREPARED_CORE_CONTEXT_NOT_HUMAN_SCOPE '.padEnd(37_000, 'c');
    const native = prepareOperatorPrompt('[[COS_CONTEXT:' + injected.length + ']]\n' + injected +
      '\n[[/COS_CONTEXT]]\n\n' + authored, upper => upper - 1);
    const original = prepareOperatorPrompt(authored, upper => upper - 1);
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      authoredText: original, message: { text: native, chars: native.length, truncated: false } });
    const resultText = 'LATEST_EXECUTOR_RESULT_START '.padEnd(1803, 'r') + ' LATEST_EXECUTOR_RESULT_END';
    await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true,
      turnId, messageId: 'intact-helper-final', time: 2000,
      message: { text: resultText, chars: resultText.length, truncated: false } });
    const context = await goal.conversationMessages(session.id);
    expect(context[0]).toEqual({ role: 'user', content: authored });
    browser.request.mockResolvedValue('{"action":"continue","reply":"Continue the unfinished original work and preserve the real corrections."}');
    goal.startGoalDraft({ conversationId, sessionId: session.id, turnId });
    const result = await settled(conversationId);
    expect(result).toMatchObject({ stage: 'ready', error: null });
    assertOperatorPromptEnvelope(result.reply);
    expect(browser.request).toHaveBeenCalledTimes(1);
    const prompt = browser.request.mock.calls[0]![0] as string;
    expect(prompt.length).toBeGreaterThan(24_000);
    expect(prompt.length + operatorPromptOverhead().chars).toBeLessThanOrEqual(96_000);
    const reference = prompt.slice(prompt.indexOf('<conversation>') + '<conversation>'.length,
      prompt.lastIndexOf('</conversation>')).trim().split('\n\n')
      .map(row => JSON.parse(row) as { role: string; content: string; scopeIncomplete?: boolean });
    expect(reference.find(row => row.role === 'user')).toEqual({ role: 'user', content: authored });
    expect(reference.findLast(row => row.role === 'assistant')?.content).toBe(resultText);
    expect(prompt).toContain(policy);
    expect(prompt).toContain(objective);
    expect(prompt).not.toContain('REDUNDANT_PREPARED_CORE_CONTEXT_NOT_HUMAN_SCOPE');
    expect(prompt).not.toContain('[… cut …]');
    const diagnostic = getLog().findLast(entry => entry.message.startsWith('goal: browser decision context ') &&
      entry.message.includes(session.id))!.message;
    const sizes = JSON.parse(diagnostic.slice(diagnostic.indexOf('{')));
    expect(sizes).toMatchObject({ boundary: 'ready', preferred: 24_000, rows: 2, humanRows: 1,
      latestHuman: authored.length, incompleteHuman: 0, rendered: prompt.length });
    expect(sizes.limit + sizes.wrapper).toBe(96_000);
    expect(sizes.system.length).toBeLessThanOrEqual(12);
    expect(diagnostic.length).toBeLessThan(1024);
    expect(diagnostic).not.toMatch(/PRIVATE_AUTHORED_SCOPE|REDUNDANT_PREPARED_CORE_CONTEXT|LATEST_EXECUTOR_RESULT/);
    expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
    expect(browser.authorize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not publish helper identity before its durable switch write commits', async () => {
    const id = 'decision-durable-publication';
    const durable = await import('../src/main/durable.js');
    const write = durable.writeDurableNow;
    const gate = faultGate();
    let held = false;
    const spy = vi.spyOn(durable, 'writeDurableNow').mockImplementation(async (name, value) => {
      if (name === goal.GOAL_SWITCHES_STATE && !held) {
        held = true;
        await gate.hold();
      }
      return write(name, value);
    });
    try {
      const registering = goal.registerGoalDecisionChat(id, 'source-durable-publication');
      await gate.entered;
      expect(goal.isGoalDecisionChat(id)).toBe(false);
      gate.release();
      await registering;
      expect(goal.isGoalDecisionChat(id)).toBe(true);
    } finally {
      gate.release();
      spy.mockRestore();
    }
  });

  it('binds one helper per durable source session and refuses cross-source reuse', async () => {
    await goal.registerGoalDecisionChat('helper-session-one', 'source-session-one');
    await expect(goal.registerGoalDecisionChat('helper-session-one', 'source-session-two')).rejects.toThrow('wrong_source');
    await expect(goal.registerGoalDecisionChat('helper-session-two', 'source-session-one')).rejects.toThrow('already_bound');
    const snapshot = goal.snapshotGoalSwitches();
    goal.restoreGoalSwitches(snapshot);
    expect(goal.snapshotGoalSwitches().switches).toContainEqual(expect.objectContaining({ conversationId: 'helper-session-one', sourceSessionId: 'source-session-one' }));
  });
  it('survives restart and master-Off while refusing manual rearming or identity moves', async () => {
    const id = 'decision-chat-one';
    await goal.registerGoalDecisionChat(id);
    await goal.setGoalSwitchNow('ordinary-chat', 'goal', true);
    goal.clearAllGoalSwitches();
    goal.clearGoalSwitch(id);
    expect(await goal.setGoalSwitchNow(id, 'loop', true)).toEqual({ enabled: false, mode: 'goal' });
    expect(goal.goalArmedFor(id)).toBe(false);
    expect(goal.moveGoalSwitch(id, 'replacement-chat')).toBe(false);
    await goal.setGoalSwitchNow('ordinary-chat', 'goal', true);
    expect(goal.moveGoalSwitch('ordinary-chat', id)).toBe(false);
    await flushDurable();
    const snapshot = await readDurable<Parameters<typeof goal.restoreGoalSwitches>[0]>(goal.GOAL_SWITCHES_STATE);
    goal.resetGoalStateForTests();
    goal.restoreGoalSwitches(snapshot);
    expect(goal.isGoalDecisionChat(id)).toBe(true);
    expect(goal.goalSwitchFor(id)).toMatchObject({ enabled: false, own: true });
  });
  it('restores already-accepted oversized switch state without silently evicting decisions', async () => {
    const id = 'decision-chat-oldest';
    goal.restoreGoalSwitches({ version: 1, savedAt: 1, switches: [
      { conversationId: id, enabled: true, mode: 'loop', role: 'decision', at: 1 },
      ...Array.from({ length: 500 }, (_, index) => ({ conversationId: `ordinary-${index}`, enabled: true, mode: 'goal' as const, at: index + 2 }))
    ] });
    expect(goal.snapshotGoalSwitches().switches).toHaveLength(501);
    expect(goal.isGoalDecisionChat(id)).toBe(true);
    expect(goal.goalArmedFor(id)).toBe(false);
    expect(goal.goalSwitchFor('ordinary-0')).toMatchObject({ own: true, enabled: true });
  });
  it('does not discard an explicit ordinary Off when switch storage reaches capacity', () => {
    const id = 'ordinary-explicit-off';
    goal.restoreGoalSwitches({ version: 1, savedAt: 1, switches: [
      { conversationId: id, enabled: false, mode: 'loop', at: 1 },
      ...Array.from({ length: 400 }, (_, index) => ({
        conversationId: `ordinary-newer-${index}`,
        enabled: true,
        mode: 'goal' as const,
        at: index + 2
      }))
    ] });

    // The global setting is enabled in this suite. Losing the oldest explicit row therefore
    // changes the user's durable Off into inherited On, which can re-arm the chat on Resume all.
    expect(goal.goalSwitchFor(id)).toMatchObject({ own: true, enabled: false, mode: 'loop' });
  });
  it('refuses a new ordinary switch at capacity without discarding an accepted choice', async () => {
    const id = 'ordinary-capacity-explicit-off';
    goal.restoreGoalSwitches({ version: 1, savedAt: 1, switches: [
      { conversationId: id, enabled: false, mode: 'loop', at: 1 },
      ...Array.from({ length: 399 }, (_, index) => ({
        conversationId: `ordinary-capacity-${index}`,
        enabled: true,
        mode: 'goal' as const,
        at: index + 2
      }))
    ] });

    await expect(goal.setGoalSwitchNow('ordinary-capacity-overflow', 'loop', true)).rejects.toThrow('goal_switch_capacity');
    expect(goal.goalSwitchFor(id)).toMatchObject({ own: true, enabled: false, mode: 'loop' });
    expect(goal.goalSwitchFor('ordinary-capacity-overflow').own).toBe(false);
    expect(goal.snapshotGoalSwitches().switches).toHaveLength(400);
  });
  it('frees only permanently deleted Off rows before admitting a new Loop', async () => {
    goal.restoreGoalSwitches({ version: 1, savedAt: 1, switches: [
      { conversationId: 'permanently-deleted', enabled: false, mode: 'loop', at: 1 },
      { conversationId: 'recoverable-deleted', enabled: false, mode: 'loop', at: 2 },
      ...Array.from({ length: 398 }, (_, index) => ({
        conversationId: `retained-${index}`, enabled: false, mode: 'goal' as const, at: index + 3
      }))
    ] });
    await blocked.setChatDeletedNow('permanently-deleted', true);
    await blocked.setChatDeletedNow('recoverable-deleted', true);
    expect(await goal.prunePermanentlyDeletedGoalSwitchesNow(new Set(['recoverable-deleted']))).toBe(1);
    expect(goal.goalSwitchFor('permanently-deleted').own).toBe(false);
    expect(goal.goalSwitchFor('recoverable-deleted')).toMatchObject({ own: true, enabled: false });
    await expect(goal.setGoalSwitchNow('fresh-loop', 'loop', true)).resolves.toMatchObject({ enabled: true, mode: 'loop' });
    expect(goal.snapshotGoalSwitches().switches).toHaveLength(400);
  });
  it('fails closed at helper capacity rather than reviving an old helper', async () => {
    goal.restoreGoalSwitches({ version: 1, savedAt: 1, switches: Array.from({ length: 400 }, (_, index) => ({
      conversationId: `decision-${index}`, enabled: false, mode: 'goal', role: 'decision', at: index + 1
    })) });
    await expect(goal.registerGoalDecisionChat('decision-overflow')).rejects.toThrow('goal_helper_capacity');
    await expect(goal.setGoalSwitchNow('ordinary-overflow', 'goal', true)).rejects.toThrow('goal_switch_capacity');
    expect(goal.isGoalDecisionChat('decision-0')).toBe(true);
    expect(goal.isGoalDecisionChat('decision-overflow')).toBe(false);
    expect(goal.snapshotGoalSwitches().switches).toHaveLength(400);
  });
  it('refuses a new helper at ordinary-switch capacity without displacing preferences', async () => {
    goal.restoreGoalSwitches({ version: 1, savedAt: 1, switches: Array.from({ length: 400 }, (_, index) => ({
      conversationId: `ordinary-${index}`, enabled: true, mode: 'goal', at: index + 1
    })) });
    await expect(goal.registerGoalDecisionChat('decision-rejected')).rejects.toThrow('goal_helper_capacity');
    expect(goal.isGoalDecisionChat('decision-rejected')).toBe(false);
    expect(goal.goalSwitchFor('ordinary-0')).toMatchObject({ own: true, enabled: true });
    expect(goal.snapshotGoalSwitches().switches).toHaveLength(400);
  });
  it('serializes duplicate registrations with a simultaneous user enable', async () => {
    const id = 'decision-concurrent';
    await Promise.all([
      goal.registerGoalDecisionChat(id),
      goal.setGoalSwitchNow(id, 'loop', true),
      goal.registerGoalDecisionChat(id)
    ]);
    expect(goal.isGoalDecisionChat(id)).toBe(true);
    expect(goal.goalArmedFor(id)).toBe(false);
    expect(goal.snapshotGoalSwitches().switches.filter(row => row.conversationId === id)).toHaveLength(1);
  });
});
async function recording(conversationId: string, text: string): Promise<string> {
  const session = await createSession({ title: 'Goal backend test', conversationId });
  for (const [role, message] of [['user', 'Finish the original task'], ['assistant', text]] as const) {
    await appendEvent(session.id, {
      time: role === 'user' ? 1000 : 2000, source: 'extension',
      ...(role === 'assistant' ? { kind: 'assistant_message' as const, final: true } : { kind: 'user_message' as const }),
      message: { text: message, chars: message.length, truncated: false }
    });
  }
  await recordLoopMcpProof(session.id);
  return session.id;
}
async function settled(id: string) {
  await vi.waitFor(() => expect(goal.goalViewFor(id)?.stage).not.toMatch(/^(sending|answering)$/));
  return goal.goalViewFor(id)!;
}
async function providerWrappedResume(handoffText: string, original?: string, correction?: string) {
  const from = randomUUID(), to = randomUUID(), messageId = randomUUID();
  const token = 'goal_resume_proof_0123456789abcdef';
  const session = await createSession({ title: 'provider-wrapped Resume', conversationId: from });
  for (const [index, text] of [original, correction].entries()) {
    if (text) await appendEvent(session.id, { kind: 'user_message', source: 'extension', time: 100 + index,
      messageId: randomUUID(), message: { text, chars: text.length, truncated: false } });
  }
  const handoff = await prepareHandoff({ sessionId: session.id, text: handoffText, sourceTokens: 1000,
    continuationToken: token, sourceConversationId: from, sourceTurnId: 'resume-source' });
  expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
  const now = Date.now();
  await continuation.restoreContinuations({ version: 1, savedAt: now, entries: [{
    token, sessionId: session.id, from, to, openedAt: now, touchedAt: now, sourceTurnId: 'resume-source',
    state: 'committed', summary: '', handoffId: handoff.id, claimedBy: null, error: null, sourceClosed: true,
    sourceSend: { state: 'sent', messageId: null }, destinationSend: { state: 'sent', conversationId: to, messageId }
  }] });
  const text = '[$fern-windows-core](app://asdk_app_6ab32f2e0ab48191a04696c05459f90c)\n' +
    resumeBootstrapText(handoff.text, token);
  return { sessionId: session.id, to, messageId, text, handoff };
}
describe('Goal decision backends', () => {
  it.each(['goal', 'loop'] as const)('accepts a bounded native %s helper reply above the API response budget without truncation', async mode => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode, backend: 'chatgpt', loopBackend: 'chatgpt' } });
    const conversationId = 'native-valid-large-' + mode;
    const sessionId = await recording(conversationId, 'The original task still has useful unfinished implementation.');
    await goal.setGoalSwitchNow(conversationId, mode, true);
    const reply = 'Continue the same original scope and preserve its acceptance. '.padEnd(mode === 'goal' ? 13235 : 14615, ' Useful authorized implementation remains.');
    browser.request.mockResolvedValue(JSON.stringify({ action: 'continue', reply }));
    goal.startGoalDraft({ conversationId, sessionId, turnId: 'native-large-source' });
    const view = await settled(conversationId);
    expect(view.stage).toBe('ready');
    expect(view.reply.includes(goal.humanReply(reply))).toBe(true);
    const prompt = browser.request.mock.calls[0]![0] as string;
    expect(prompt.slice(prompt.lastIndexOf('</conversation>'))).toContain('Prefer 2,000–6,000 characters');
    expect(prompt.slice(prompt.lastIndexOf('</conversation>'))).toContain('16000');
  });

  it('still refuses a native helper reply beyond the native message limit', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
    const conversationId = 'native-over-delivery-budget';
    const sessionId = await recording(conversationId, 'Unfinished original scope.');
    await goal.setGoalSwitchNow(conversationId, 'loop', true);
    browser.request.mockResolvedValue(JSON.stringify({ action: 'continue', reply: 'x'.repeat(16001) }));
    goal.startGoalDraft({ conversationId, sessionId, turnId: 'oversize-native-source' });
    expect(await settled(conversationId)).toMatchObject({ stage: 'failed', error: 'reply_too_long' });
  });

  it('keeps a settled API Loop reply retryable when physical readiness changes during its request', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode: 'loop',
      loopBackend: 'api', continuationPolicy: 'settled-turn' } });
    await setSecret('openRouterApiKey', 'test-key');
    const id = 'api-readiness-race', sessionId = await recording(id, 'Saved result');
    let ready = true;
    goal.configureLoopForwardReadiness(async () => ready);
    vi.stubGlobal('fetch', vi.fn(async () => {
      ready = false; // Another live local command begins after the request left.
      return Response.json({ choices: [{ message: { content: '{"action":"continue","reply":"Continue saved work"}' } }] });
    }));
    goal.startGoalDraft({ sessionId, conversationId: id, turnId: 'source' });
    expect(await settled(id)).toMatchObject({ stage: 'failed', error: 'goal_readiness_changed', retryable: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['strict', true, false], ['settled-turn', false, false],
    ['settled-turn', true, true], ['settled-turn', null, false]
  ] as const)('admits a normal global Loop only with opted-in current readiness (%s/%s)', async (policy, readiness, allowed) => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode: 'loop',
      loopBackend: 'chatgpt', continuationPolicy: policy } });
    const session = await createSession({ title: 'normal Loop readiness boundary', conversationId: `global-ready-${policy}-${readiness}` });
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      message: { text: 'Build and verify the complete product', chars: 37, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true, turnId: 'source', time: 2000,
      message: { text: 'Saved native result with missing tool ownership', chars: 47, truncated: false } });
    const check = vi.fn(async () => readiness === true);
    if (readiness !== null) goal.configureLoopForwardReadiness(check);
    browser.request.mockResolvedValue('{"action":"continue","reply":"Continue the implementation and validation"}');
    goal.startGoalDraft({ conversationId: session.conversationId!, sessionId: session.id, turnId: 'source' });
    expect((await settled(session.conversationId!)).stage).toBe(allowed ? 'ready' : policy === 'settled-turn' ? 'failed' : 'no-reply');
    expect(browser.request).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(check).toHaveBeenCalledTimes(policy === 'settled-turn' && readiness !== null ? allowed ? 2 : 1 : 0);
    // Finish-only follow-ups do not consume normal-turn forward permission.
    check.mockClear();
    expect(await goal.draftFastFollowup(session.id)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });
  it.each(['goal', 'loop'] as const)('fits the %s helper envelope after proving a provider-wrapped Resume is automatic, preserving the whole human correction', async mode => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true,
      mode, backend: 'chatgpt', loopBackend: 'chatgpt' } });
    const original = 'ORIGINAL AUTHORIZED TASK: finish the whole editor without losing scope.';
    const correction = 'LATEST REAL HUMAN CORRECTION START ' + 'x'.repeat(2000) + ' LATEST REAL HUMAN CORRECTION END';
    const objective = [
      'SAVED OBJECTIVE START',
      original,
      'CANONICAL OBJECTIVE MIDDLE: keep this path and its exact hold condition.',
      'scope '.repeat(2_200),
      'SAVED OBJECTIVE END'
    ].join('\n');
    const resume = await providerWrappedResume('HANDOFF: preserve the existing task. ' + 'r'.repeat(12_769), original, correction);
    await appendEvent(resume.sessionId, { kind: 'user_message', source: 'extension', time: 200,
      messageId: resume.messageId, message: { text: resume.text, chars: resume.text.length, truncated: false } });
    await appendEvent(resume.sessionId, { kind: 'assistant_message', source: 'extension', time: 300,
      final: true, turnId: 'resumed-final', message: { text: 'Newest useful executor result', chars: 29, truncated: false } });
    await goal.setGoalSwitchNow(resume.to, mode, true, true);
    await goal.setGoalObjectiveNow(resume.to, objective);
    await recordLoopMcpProof(resume.sessionId, 'resumed-final');
    const projected = await goal.conversationMessages(resume.sessionId);
    expect(projected.find(row => row.content === resume.text)).toEqual({ role: 'user', origin: 'automatic', content: resume.text });
    expect(projected.filter(row => row.role === 'user' && row.origin !== 'automatic').map(row => row.content))
      .toEqual([original, correction]);
    browser.request.mockResolvedValue('{"action":"continue","reply":"Continue the full authorized implementation"}');
    goal.startGoalDraft({ conversationId: resume.to, sessionId: resume.sessionId, turnId: 'resumed-final' });
    expect((await settled(resume.to)).stage).toBe('ready');
    expect(browser.request).toHaveBeenCalledTimes(1);
    const prompt = browser.request.mock.calls[0]![0] as string;
    expect(prompt.length).toBeLessThanOrEqual(24_000);
    const reference = prompt.slice(prompt.indexOf('<conversation>') + '<conversation>'.length,
      prompt.lastIndexOf('</conversation>')).trim().split('\n\n')
      .map(line => JSON.parse(line) as { role: string; content: string; origin?: string });
    expect(reference.find(row => row.content === correction)).toEqual({ role: 'user', content: correction });
    // The automatic bootstrap may be omitted before spending the human-correction budget.
    expect(prompt).toContain('omitted');
    expect(reference.some(row => row.content === resume.text)).toBe(false);
    expect(prompt).toContain(objective);
    expect(prompt).toContain('Newest useful executor result');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['valid', 'no-receipt', 'wrong-message', 'wrong-handoff', 'changed-body', 'quoted-prefix', 'truncated'] as const)(
    'classifies a provider-wrapped Resume only from its exact current receipt (%s)', async state => {
      const resume = await providerWrappedResume('HANDOFF: keep all existing requirements and verify the remaining work. '.repeat(5),
        'Original real human scope');
      let text = resume.text;
      if (state === 'no-receipt') continuation.resetContinuationsForTests();
      if (state === 'wrong-handoff') {
        const other = await prepareHandoff({ sessionId: resume.sessionId, sourceTokens: 1000,
          text: 'OTHER HANDOFF: this is not the bootstrap actually delivered in this native user message. '.repeat(5) });
        text = resume.text.slice(0, resume.text.indexOf('[[CLF-RESUME:')) +
          resumeBootstrapText(other.text, 'goal_resume_proof_0123456789abcdef');
      }
      if (state === 'changed-body') text += ' silently narrowed scope';
      if (state === 'quoted-prefix') text = 'Quoted example: ' + text;
      await appendEvent(resume.sessionId, { kind: 'user_message', source: 'extension', time: 200,
        messageId: state === 'wrong-message' ? randomUUID() : resume.messageId,
        message: { text, chars: text.length, truncated: state === 'truncated' } });
      const messages = await goal.conversationMessages(resume.sessionId);
      const observed = messages.find(row => row.content === text);
      expect(observed).toMatchObject({ role: 'user', content: text });
      expect(observed?.origin).toBe(state === 'valid' ? 'automatic' : undefined);
    }
  );

  it('rechecks the exact current Resume receipt after the read-only handoff await', async () => {
    const resume = await providerWrappedResume('HANDOFF: keep every requirement and continue the verified work. '.repeat(5),
      'Original real human scope');
    await appendEvent(resume.sessionId, { kind: 'user_message', source: 'extension', time: 200,
      messageId: resume.messageId, message: { text: resume.text, chars: resume.text.length, truncated: false } });
    const store = await import('../src/main/session/store.js');
    const originalRead = store.readHandoff;
    const gate = faultGate();
    let reads = 0;
    const spy = vi.spyOn(store, 'readHandoff').mockImplementation(async (sessionId, handoffId) => {
      const result = await originalRead(sessionId, handoffId);
      if (sessionId === resume.sessionId && handoffId === resume.handoff.id && ++reads === 2) await gate.hold();
      return result;
    });
    try {
      const pending = goal.conversationMessages(resume.sessionId);
      await gate.entered;
      expect(await rebindSession(resume.sessionId, resume.to, randomUUID(), resume.handoff.id)).toBe(true);
      gate.release();
      const messages = await pending;
      expect(messages.find(row => row.content === resume.text)?.origin).toBeUndefined();
    } finally {
      gate.release();
      spy.mockRestore();
    }
  });

  it('skips a receipt-proven wrapped bootstrap when recovering the original human scope outside a saturated tail', async () => {
    const resume = await providerWrappedResume('HANDOFF: retained continuity is not a new human request. '.repeat(5));
    await appendEvent(resume.sessionId, { kind: 'user_message', source: 'extension', time: 200,
      messageId: resume.messageId, message: { text: resume.text, chars: resume.text.length, truncated: false } });
    const original = 'FIRST REAL HUMAN SCOPE: keep the full authorized editor task.';
    await appendEvent(resume.sessionId, { kind: 'user_message', source: 'extension', time: 300,
      messageId: randomUUID(), message: { text: original, chars: original.length, truncated: false } });
    for (let index = 0; index < 121; index++) {
      await appendEvent(resume.sessionId, { kind: 'user_message', source: 'extension', time: 400 + index * 2,
        automationOrigin: 'goal', messageId: randomUUID(),
        message: { text: `Automatic continuation ${index}`, chars: 26, truncated: false } });
      await appendEvent(resume.sessionId, { kind: 'assistant_message', source: 'extension', time: 401 + index * 2,
        final: true, messageId: randomUUID(), message: { text: `Useful result ${index}`, chars: 17, truncated: false } });
    }
    const messages = await goal.conversationMessages(resume.sessionId);
    expect(messages[0]).toEqual({ role: 'user', content: original });
    expect(messages.filter(row => row.role === 'user' && row.origin !== 'automatic')).toEqual([
      { role: 'user', content: original }
    ]);
    expect(messages.some(row => row.origin === 'automatic' && row.content.includes('HANDOFF: retained continuity'))).toBe(true);
  });
  it.each(['api', 'chatgpt'] as const)('sends canonical interim and corrections to the %s Loop without a final answer', async backend => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, loopBackend: backend } });
    await setSecret('openRouterApiKey', 'test-key');
    const id = `failed-interim-${backend}`;
    const session = await createSession({ title: 'Failed interim context', conversationId: id });
    for (const [index, text] of ['Build the individual stage layers', 'Geometry is still shallow', 'Use no textures or color'].entries()) {
      await appendEvent(session.id, { source: 'extension', time: index + 1,
        ...(index === 1 ? { kind: 'assistant_message' as const, messageId: 'canonical-interim', state: 'streaming' as const, final: false } : { kind: 'user_message' as const }),
        message: { text, chars: text.length, truncated: false } });
    }
    await appendEvent(session.id, { source: 'extension', kind: 'turn_end', turnId: 'failed-turn', outcome: 'failed', reason: 'thinking_failed', time: 4 });
    browser.request.mockResolvedValue('{"action":"continue","reply":"Refine the geometry"}');
    const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { content: '{"action":"continue","reply":"Refine the geometry"}' } }] }));
    vi.stubGlobal('fetch', fetcher);
    await goal.setGoalSwitchNow(id, 'loop', true, true);
    await recordLoopMcpProof(session.id, 'failed-turn');
    goal.startGoalDraft({ conversationId: id, sessionId: session.id, turnId: 'failed-turn' });
    expect((await settled(id)).stage).toBe('ready');
    if (backend === 'chatgpt') expect(browser.request.mock.calls[0]?.[2]).toMatchObject({ lifetime: 'temporary-planner', conversationId: null });
    const payload = backend === 'chatgpt' ? browser.request.mock.calls[0]?.[0]
      : String((fetcher.mock.calls[0] as unknown as [unknown, RequestInit])?.[1]?.body);
    for (const text of ['Build the individual stage layers', 'Geometry is still shallow', 'Use no textures or color']) expect(payload).toContain(text);
    expect(payload.match(/Geometry is still shallow/g)).toHaveLength(1);
    if (backend === 'chatgpt') {
      expect(payload).not.toContain('{"action":"stop" or "continue"');
      expect(payload.trim()).toMatch(/Return exactly one JSON object: \{"action":"continue","reply":"the next user message"\}\. Wrap that object in one json code block/);
      expect(payload).not.toContain('Never output markdown');
    }
  });
  it('accepts a fenced GPT-6 helper decision without executing it in the helper', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
    const id = 'fenced-helper';
    const sessionId = await recording(id, 'Fenced task');
    browser.request.mockResolvedValueOnce('```json\n{"action":"continue","reply":"Run the fenced check"}\n```');
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'fenced' });
    expect(authoredReply(await settled(id))).toMatchObject({ stage: 'ready', reply: expect.stringMatching(/^Run the f\w+ check$/) });
    const prompt = browser.request.mock.calls[0]?.[0];
    expect(prompt).toContain('Wrap that object in one json code block');
    expect(prompt).toContain('Do not call any tools, apps or connectors');
  });
  it('counts a confirmed unclaimed timeout as a transport failure without claiming a failed model answer', async () => {
    vi.useFakeTimers();
    try {
      await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
      const id = 'timed-out-helper-source';
      const sessionId = await recording(id, 'Continue the durable task');
      await goal.setGoalSwitchNow(id, 'goal', true);
      await goal.acceptGoalReplyNow({
        conversationId: id, sessionId, replyId: 'reply-one', turnId: 'source-final', eventSeq: 10, blocked: false
      });
      browser.settleTimedOut.mockResolvedValue('queued-unclaimed');
      browser.request.mockImplementation(async (_text: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('goal_browser_cancelled')), { once: true });
      }));
      goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' });
      await vi.waitFor(() => expect(browser.request).toHaveBeenCalledTimes(1));
      expect(browser.settleTimedOut).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(browser.settleTimedOut).toHaveBeenCalledExactlyOnceWith(sessionId);
      const failed = goal.goalViewFor(id)!;
      expect(failed).toMatchObject({ stage: 'failed', error: 'goal_browser_queued_unclaimed_timeout', retryable: true });
      expect(await goal.ackGoalDraftNow(id, failed.token)).toBe(true);
      expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === id)).toMatchObject({ helperFailureCount: 1, helperFailureCause: 'transport_unclaimed' });
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['goal_browser_signed_out', 'goal_browser_automation_paused'] as const)(
    'preserves the exact source and failure budget for the already-settled admission hold %s', async error => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
    const id = `held-helper-source-${error}`;
    const sessionId = await recording(id, 'Continue the original task after sign-in');
    await goal.setGoalSwitchNow(id, 'goal', true);
    await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'reply-one',
      turnId: 'source-final', eventSeq: 10, blocked: false });
    browser.request.mockRejectedValueOnce(new Error(error));
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' });
    const held = await settled(id);
    // Semantic custody survives a Resume before Goal receives the failure; current
    // config is not an excuse to reclassify a proven paused wait as another attempt.
    expect(held).toMatchObject({ stage: 'failed', error, retryable: false });
    expect(browser.settleTimedOut).not.toHaveBeenCalled();
    expect(await goal.ackGoalDraftNow(id, held.token)).toBe(true);
    expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === id)).toMatchObject({ state: 'pending', turnId: 'source-final' });
    expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === id)?.helperFailureCount).toBeUndefined();
  });
  it('keeps a natively delivered helper answer alive beyond the delivery deadline without another Send', async () => {
    vi.useFakeTimers();
    try {
      await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
      const id = 'slow-delivered-answer';
      const sessionId = await recording(id, 'Finish the existing task');
      let finish!: (text: string) => void;
      browser.request.mockImplementation(async (_text: string, signal: AbortSignal) => {
        browser.inputs.push({ id: 'exact-delivered-helper', sessionId: null, purpose: 'decision',
          decisionSourceSessionId: sessionId, state: 'decision', createdAt: Date.now(),
          deliveredAt: Date.now(), messageId: 'native-send-receipt', conversationId: null } as never);
        return new Promise<string>((resolve, reject) => {
          finish = resolve;
          signal.addEventListener('abort', () => reject(new Error('goal_browser_cancelled')), { once: true });
        });
      });
      goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'slow-final' });
      await vi.waitFor(() => expect(browser.request).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(240_000);
      expect(goal.goalViewFor(id)?.stage).not.toBe('failed');
      finish('```json\n{"action":"continue","reply":"Verify the remaining acceptance"}\n```');
      await vi.waitFor(() => expect(goal.goalViewFor(id)?.stage).toBe('ready'));
      expect(browser.settleTimedOut).not.toHaveBeenCalled();
      expect(browser.request).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it.each(['answer-deadline', 'revoked', 'old', 'foreign', 'unconfirmed', 'duplicate', 'future'])(
    'keeps the receipted answer wait bounded and owner-specific: %s', async scenario => {
      vi.useFakeTimers();
      try {
        await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
        const id = `helper-boundary-${scenario}`;
        const sessionId = await recording(id, 'Preserve the exact task');
        let requestSignal!: AbortSignal;
        browser.request.mockImplementation(async (_text: string, signal: AbortSignal) => {
          requestSignal = signal;
          const row = { id: 'receipted-helper', sessionId: null, purpose: 'decision',
            decisionSourceSessionId: scenario === 'foreign' ? 'other-session' : sessionId,
            state: 'decision', createdAt: Date.now() - (scenario === 'old' ? 1000 : 0),
            deliveredAt: Date.now() + (scenario === 'future' ? 900_000 : 0),
            messageId: scenario === 'unconfirmed' ? undefined : 'native-receipt' };
          browser.inputs.push(row as never);
          if (scenario === 'duplicate') browser.inputs.push({ ...row, id: 'other-helper' } as never);
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('goal_browser_cancelled')), { once: true });
          });
        });
        goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' });
        await vi.waitFor(() => expect(browser.request).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(180_000);
        if (scenario === 'answer-deadline' || scenario === 'revoked') {
          expect(requestSignal.aborted).toBe(false);
          if (scenario === 'revoked') goal.retireGoalDraftsFor(id);
          else await vi.advanceTimersByTimeAsync(420_001);
        }
        await vi.waitFor(() => expect(requestSignal.aborted).toBe(true));
        expect(browser.request).toHaveBeenCalledTimes(1);
        if (scenario !== 'revoked') expect(goal.goalViewFor(id)?.stage).toBe('failed');
      } finally { vi.useRealTimers(); }
    });
  it('bounds repeated pre-claim transport failures for the same reply, including after restore', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
    const id = 'unclaimed-helper-wake-failure';
    const sessionId = await recording(id, 'Continue the saved objective');
    await goal.setGoalSwitchNow(id, 'goal', true);
    await goal.acceptGoalReplyNow({
      conversationId: id, sessionId, replyId: 'reply-one', turnId: 'source-final', eventSeq: 10, blocked: false
    });
    browser.request.mockRejectedValue(new Error('browser_wake_disconnected'));
    browser.settleTimedOut.mockResolvedValue('queued-unclaimed');

    for (let attempt = 1; attempt <= goal.MAX_AUTOMATIC_BROWSER_HELPER_FAILURES; attempt += 1) {
      const started = goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' });
      const failed = await settled(id);
      expect(failed).toMatchObject({ token: started.token, stage: 'failed', error: 'goal_browser_queued_unclaimed_transport', retryable: true });
      expect(browser.settleTimedOut).toHaveBeenCalledTimes(attempt);
      expect(browser.settleTimedOut).toHaveBeenLastCalledWith(sessionId);
      expect(await goal.ackGoalDraftNow(id, failed.token)).toBe(true);
      expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === id)).toMatchObject({ state: 'pending' });
      expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === id)).toMatchObject({ helperFailureCount: attempt, helperFailureCause: 'transport_unclaimed' });
    }
    const blocked = goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' });
    expect(blocked).toMatchObject({ stage: 'failed', error: 'goal_browser_helper_exhausted', retryable: false });
    expect(browser.request).toHaveBeenCalledTimes(goal.MAX_AUTOMATIC_BROWSER_HELPER_FAILURES);
    const saved = goal.snapshotGoalReplies();
    goal.resetGoalStateForTests();
    goal.restoreGoalReplies(saved);
    expect(goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' }))
      .toMatchObject({ stage: 'failed', error: 'goal_browser_helper_exhausted', retryable: false });
    expect(browser.request).toHaveBeenCalledTimes(goal.MAX_AUTOMATIC_BROWSER_HELPER_FAILURES);
  });
  it.each(['goal_browser_busy', 'goal_browser_rate_limited', 'goal_readiness_changed'])(
    'does not count helper admission %s as a failed answer or retire another helper', async error => {
      await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
      const id = `admission-${error}`;
      const sessionId = await recording(id, 'Continue the saved task');
      await goal.setGoalSwitchNow(id, 'goal', true);
      await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'reply-one', turnId: 'source-final', eventSeq: 10, blocked: false });
      browser.request.mockRejectedValue(new Error(error));
      for (let attempt = 0; attempt < 4; attempt++) {
        goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' });
        const failed = await settled(id);
        expect(failed).toMatchObject({ stage: 'failed', error, retryable: true });
        expect(await goal.ackGoalDraftNow(id, failed.token)).toBe(true);
      }
      expect(browser.settleTimedOut).not.toHaveBeenCalled();
      expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === id)).not.toHaveProperty('helperFailureCount');
    }
  );
  it.each(['browser-preparing', 'send-outcome-unconfirmed', 'awaiting-answer'] as const)(
    'classifies an early helper error from exact %s transport custody', async disposition => {
      await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
      const id = `early-helper-${disposition}`;
      const sessionId = await recording(id, 'Continue the saved task');
      await goal.setGoalSwitchNow(id, 'goal', true);
      await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'reply-one', turnId: 'source-final', eventSeq: 10, blocked: false });
      browser.request.mockRejectedValueOnce(new Error('browser_wake_disconnected'));
      browser.settleTimedOut.mockResolvedValueOnce(disposition);
      goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' });
      const failed = await settled(id);
      const error = disposition === 'awaiting-answer' ? 'goal_browser_answer_expired' :
        disposition === 'send-outcome-unconfirmed' ? 'goal_browser_send_unconfirmed' : 'request_failed: browser_wake_disconnected';
      expect(failed).toMatchObject({ stage: 'failed', error, retryable: disposition === 'browser-preparing' });
      expect(await goal.ackGoalDraftNow(id, failed.token)).toBe(true);
      const reply = goal.snapshotGoalReplies().replies.find(row => row.conversationId === id);
      if (disposition === 'browser-preparing') expect(reply).toMatchObject({ helperFailureCount: 1 });
      else expect(reply).not.toHaveProperty('helperFailureCount');
    }
  );
  it('does not query automatic helper retirement when native Send is unconfirmed', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
    const id = 'early-helper-ambiguous-send';
    const sessionId = await recording(id, 'Continue the saved task');
    await goal.setGoalSwitchNow(id, 'goal', true);
    browser.request.mockRejectedValueOnce(new Error('goal_browser_send_unconfirmed'));
    browser.settleTimedOut.mockResolvedValue('queued-unclaimed');
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' });
    const failed = await settled(id);
    expect(failed).toMatchObject({ stage: 'failed', error: 'goal_browser_send_unconfirmed', retryable: false });
    expect(browser.settleTimedOut).not.toHaveBeenCalled();
    expect(await goal.ackGoalDraftNow(id, failed.token)).toBe(true);
    expect(goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' }).token).toBe(failed.token);
    expect(browser.request).toHaveBeenCalledTimes(1);
  });
  it.each(['browser-preparing', 'awaiting-answer', 'send-outcome-unconfirmed'] as const)('classifies a %s timeout by its exact Send custody', async disposition => {
    vi.useFakeTimers();
    try {
      await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
      const id = 'delivered-timeout-helper-source';
      const sessionId = await recording(id, 'Continue the durable task');
      await goal.setGoalSwitchNow(id, 'goal', true);
      await goal.acceptGoalReplyNow({
        conversationId: id, sessionId, replyId: 'reply-one', turnId: 'source-final', eventSeq: 10, blocked: false
      });
      browser.settleTimedOut.mockResolvedValue(disposition);
      browser.request.mockImplementation(async (_text: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('goal_browser_cancelled')), { once: true });
      }));
      goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' });
      await vi.waitFor(() => expect(browser.request).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(180_000);
      const failed = goal.goalViewFor(id)!;
      const held = disposition === 'awaiting-answer' ? 'goal_browser_answer_expired' :
        disposition === 'send-outcome-unconfirmed' ? 'goal_browser_send_unconfirmed' : 'timeout_or_cancelled';
      expect(failed).toMatchObject({ stage: 'failed', error: held, retryable: disposition === 'browser-preparing' });
      expect(await goal.ackGoalDraftNow(id, failed.token)).toBe(true);
      const reply = goal.snapshotGoalReplies().replies.find(row => row.conversationId === id);
      if (disposition === 'browser-preparing') expect(reply).toMatchObject({ helperFailureCount: 1, helperFailureCause: 'request_failed' });
      else expect(reply).not.toHaveProperty('helperFailureCount');
      if (disposition !== 'browser-preparing') {
        expect(goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' }).token).toBe(failed.token);
        expect(browser.request).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it('restarts only the deliberately authorized failed source helper', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
    const id = 'source-retry-helper';
    const sessionId = await recording(id, 'Next task');
    // Restart authority belongs to the exact durable pending source, not a
    // process-local failed draft without a committed Goal reply obligation.
    await goal.acceptGoalReplyNow({ conversationId: id, sessionId, turnId: 'source-final',
      replyId: 'source-final-helper-message', eventSeq: 1, blocked: false });
    browser.request.mockRejectedValueOnce(new Error('goal_browser_send_unconfirmed'));
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' });
    expect((await settled(id)).retryable).toBe(false);
    browser.authorize.mockResolvedValueOnce(false);
    expect(await goal.retryGoalBrowserHelper(sessionId, 'old-input')).toBe(false);
    expect(browser.request).toHaveBeenCalledTimes(1);
    browser.authorize.mockResolvedValueOnce(true);
    browser.request.mockResolvedValueOnce('{"action":"continue","reply":"Perform next check"}');
    expect(await goal.retryGoalBrowserHelper(sessionId, 'old-input')).toBe(true);
    expect(await settled(id)).toMatchObject({ turnId: 'source-final', stage: 'ready' });
    expect(browser.request).toHaveBeenCalledTimes(2);
  });
  it('bulk-authorizes only the newest warning for each affected source chat', async () => {
    const first = await recording('bulk-helper-source-one', 'First source task');
    const second = await recording('bulk-helper-source-two', 'Second source task');
    browser.paused = [
      { id: 'first-old', sourceSessionId: first },
      { id: 'second-only', sourceSessionId: second },
      { id: 'first-new', sourceSessionId: first }
    ];
    browser.authorize.mockResolvedValue(true);
    expect(await goal.retryPausedGoalBrowserHelpers()).toEqual({ eligible: 2, restarted: 2, skipped: 0 });
    expect(browser.authorize.mock.calls).toEqual([
      ['first-new', first, undefined],
      ['second-only', second, undefined]
    ]);
    expect(browser.request).not.toHaveBeenCalled();
  });
  it('uses fresh temporary helpers with full reference after restart and never revives historical helpers', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, backend: 'chatgpt' } });
    const id = 'incremental-source';
    const sessionId = await recording(id, 'Original reference only');
    browser.request.mockImplementation(async (_text, _signal, options) => {
      await goal.registerGoalDecisionChat('incremental-helper', options.sourceSessionId);
      return '{"action":"continue","reply":"Continue the checks"}';
    });
    const requestedAt = Date.now();
    const requestClock = vi.spyOn(Date, 'now').mockReturnValue(requestedAt);
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'first' });
    expect((await settled(id)).stage).toBe('ready');
    expect(browser.request.mock.calls[0]?.[2]).toEqual({ sourceSessionId: sessionId, sourceTurnId: 'first',
      conversationId: null, lifetime: 'temporary-planner', model: 'gpt-6-thinking',
      reasoningEffort: 'high', onAccepted: expect.any(Function), onQueued: expect.any(Function), publish: expect.any(Function),
      preparationExpiresAt: requestedAt + 180_000 });
    expect(browser.request.mock.calls[0]?.[0]).toContain('Original reference only');
    expect(browser.request.mock.calls[0]?.[0]).toContain(
      'Do not call any tools, apps or connectors; decide only from the supplied reference transcript.'
    );
    const saved = goal.snapshotGoalSwitches();
    goal.resetGoalStateForTests();
    goal.restoreGoalSwitches(saved);
    await appendEvent(sessionId, { source: 'extension', kind: 'assistant_message', final: true, time: 3000,
      message: { text: 'New response only', chars: 17, truncated: false } });
    requestClock.mockReturnValue(requestedAt + 30_000);
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'second' });
    expect((await settled(id)).stage).toBe('ready');
    expect(browser.request.mock.calls[1]?.[2]).toMatchObject({ conversationId: null, lifetime: 'temporary-planner', sourceSessionId: sessionId,
      preparationExpiresAt: requestedAt + 30_000 + 180_000 });
    expect(browser.request.mock.calls[1]?.[0]).toContain('New response only');
    expect(browser.request.mock.calls[1]?.[0]).toContain('Original reference only');
    expect(browser.request.mock.calls[1]?.[0]).not.toContain('Append these new source messages');
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, backend: 'chatgpt', prompt: 'Changed continuation instructions' } });
    requestClock.mockReturnValue(requestedAt + 60_000);
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'third' });
    expect((await settled(id)).stage).toBe('ready');
    expect(browser.request.mock.calls[2]?.[0]).toContain('Original reference only');
    expect(browser.request.mock.calls[2]?.[2]).toMatchObject({ conversationId: null, lifetime: 'temporary-planner',
      preparationExpiresAt: requestedAt + 60_000 + 180_000 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['goal', 'loop'] as const)('bounds the complete %s browser envelope while keeping original anchors, newest result and the whole latest human correction', async mode => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode, backend: 'chatgpt', loopBackend: 'chatgpt' } });
    const id = `bounded-browser-${mode}`;
    const session = await createSession({ title: 'bounded', conversationId: id });
    await goal.setGoalSwitchNow(id, mode, true, true);
    const original = 'Build the whole requested product. ' + 'requirement '.repeat(2000) + ' KEEP THIS ORIGINAL END';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      message: { text: original, chars: original.length, truncated: false } });
    for (let index = 0; index < 12; index++) {
      const text = `result ${index}: ` + '"\\\n'.repeat(3000);
      await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true, time: 2000 + index,
        message: { text, chars: text.length, truncated: false } });
    }
    const correction = 'LATEST USER CORRECTION ' + 'y'.repeat(10_000) + ' KEEP THIS CORRECTION END';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 3000,
      message: { text: correction, chars: correction.length, truncated: false } });
    browser.request.mockResolvedValue('{"action":"continue","reply":"Continue the full implementation"}');
    goal.startGoalDraft({ conversationId: id, sessionId: session.id, turnId: 'bounded' });
    expect((await settled(id)).stage).toBe('ready');
    const prompt = browser.request.mock.calls[0]?.[0] as string;
    expect(prompt.length).toBeLessThanOrEqual(24_000);
    expect(prompt).toContain('Build the whole requested product.');
    expect(prompt).toContain('KEEP THIS ORIGINAL END');
    expect(prompt).toContain('result 11');
    const reference = prompt.slice(prompt.indexOf('<conversation>') + '<conversation>'.length,
      prompt.lastIndexOf('</conversation>')).trim().split('\n\n')
      .map(line => JSON.parse(line) as { role: string; content: string });
    expect(reference.find(row => row.content === correction)).toEqual({ role: 'user', content: correction });
    expect(prompt).toContain('omitted');
    expect(browser.request).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'goal', size: 'whole' }, { mode: 'loop', size: 'whole' },
    { mode: 'goal', size: 'escaped' }, { mode: 'loop', size: 'escaped' }
  ] as const)('keeps whole latest human steering within native transport even when the ordinary helper reference budget is smaller ($mode/$size)', async ({ mode, size }) => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal,
      enabled: true, mode, backend: 'chatgpt', loopBackend: 'chatgpt' } });
    const conversationId = randomUUID(), turnId = 'whole-human-native-budget';
    const session = await createSession({ title: 'whole steering transport', conversationId });
    const objective = 'Preserve the original authorized task and native acceptance requirements.';
    await goal.setGoalSwitchNow(conversationId, mode, true, true);
    await goal.setGoalObjectiveNow(conversationId, objective);
    const correction = 'LATEST HUMAN STEERING START\n' +
      (size === 'whole' ? 'y'.repeat(47_000) : '"\\\n'.repeat(8_000)) + '\nLATEST HUMAN STEERING END';
    for (const [index, text] of ['Original authorized task', correction].entries())
      await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000 + index,
        message: { text, chars: text.length, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true,
      turnId, time: 2000, message: { text: 'Newest executor result', chars: 22, truncated: false } });
    browser.request.mockResolvedValue('{"action":"continue","reply":"Continue the intact original task and verify its unfinished requirements."}');
    goal.startGoalDraft({ conversationId, sessionId: session.id, turnId });
    const result = await settled(conversationId);
    if (result.stage === 'failed') expect(result.error).toBe('request_failed: goal_context_too_large');
    expect(result).toMatchObject({ stage: 'ready' });
    expect(browser.request).toHaveBeenCalledTimes(1);
    const prompt = browser.request.mock.calls[0]![0] as string;
    expect(prompt.length).toBeGreaterThan(24_000);
    expect(prompt.length).toBeLessThanOrEqual(96_000);
    const reference = prompt.slice(prompt.indexOf('<conversation>') + '<conversation>'.length,
      prompt.lastIndexOf('</conversation>')).trim().split('\n\n')
      .map(line => JSON.parse(line) as { role: string; content: string });
    expect(reference.find(row => row.content === correction)).toEqual({ role: 'user', content: correction });
    expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'goal', size: 'whole' }, { mode: 'loop', size: 'whole' },
    { mode: 'goal', size: 'escaped' }, { mode: 'loop', size: 'escaped' }
  ] as const)('refuses an oversized whole latest human correction before the browser backend opens a helper ($mode/$size)', async ({ mode, size }) => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal,
      enabled: true, mode, backend: 'chatgpt', loopBackend: 'chatgpt' } });
    const conversationId = `oversized-browser-correction-${mode}-${size}`;
    const turnId = `oversized-browser-final-${mode}-${size}`;
    const session = await createSession({ title: 'oversized correction', conversationId });
    const objective = 'Finish the original task while preserving all later human corrections.';
    await goal.setGoalSwitchNow(conversationId, mode, true);
    await goal.setGoalObjectiveNow(conversationId, objective);
    const correction = 'LATEST HUMAN CORRECTION START\n' +
      (size === 'whole' ? 'y'.repeat(107_000) : '"\\\n'.repeat(20_000)) + '\nLATEST HUMAN CORRECTION END';
    for (const [index, text] of ['Original authorized task', correction].entries()) {
      await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000 + index,
        message: { text, chars: text.length, truncated: false } });
    }
    await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true,
      turnId, time: 2000, message: { text: 'Newest executor result', chars: 22, truncated: false } });
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, replyId: 'oversized-source-final',
      turnId, eventSeq: 10, blocked: false });
    const obligation = goal.goalPendingReplyFor(conversationId);
    browser.request.mockResolvedValue('{"action":"continue","reply":"Must not reach the browser"}');
    goal.startGoalDraft({ conversationId, sessionId: session.id, turnId });
    expect(await settled(conversationId)).toMatchObject({
      stage: 'failed', error: 'request_failed: goal_context_too_large', reply: '',
      message: expect.stringContaining('saved task is retained')
    });
    expect(browser.request).not.toHaveBeenCalled();
    expect(browser.authorize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(goal.goalPendingReplyFor(conversationId)).toEqual(obligation);
    expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
  });

  it.each(['goal', 'loop'] as const)('refuses the combined intact objective and latest steering when their native frame cannot fit (%s)', async mode => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal,
      enabled: true, mode, backend: 'chatgpt', loopBackend: 'chatgpt' } });
    const conversationId = randomUUID(), turnId = 'combined-native-authority';
    const session = await createSession({ title: 'combined native authority', conversationId });
    const objective = 'ORIGINAL OBJECTIVE START ' + 'x'.repeat(60_000) + ' ORIGINAL OBJECTIVE END';
    const correction = 'LATEST HUMAN STEERING START ' + 'y'.repeat(47_000) + ' LATEST HUMAN STEERING END';
    await goal.setGoalSwitchNow(conversationId, mode, true, true);
    await goal.setGoalObjectiveNow(conversationId, objective);
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      message: { text: correction, chars: correction.length, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true,
      turnId, time: 2000, message: { text: 'Newest executor result', chars: 22, truncated: false } });
    goal.startGoalDraft({ conversationId, sessionId: session.id, turnId });
    expect(await settled(conversationId)).toMatchObject({ stage: 'failed', error: 'request_failed: goal_context_too_large' });
    expect(browser.request).not.toHaveBeenCalled();
    expect(browser.authorize).not.toHaveBeenCalled();
    expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a saved Loop objective beyond ordinary delivery bounds without losing durable scope', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
    const conversationId = 'bounded-browser-system';
    const turnId = 'bounded-system';
    const session = await createSession({ title: 'oversized saved objective', conversationId });
    const objective = `SAVED OBJECTIVE START ${'requirement '.repeat(9_000)} SAVED OBJECTIVE END`;
    const latest = 'Latest executor result';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      message: { text: 'Finish the original task', chars: 24, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true,
      messageId: 'oversized-loop-final', turnId, time: 2000,
      message: { text: latest, chars: latest.length, truncated: false } });
    await recordLoopMcpProof(session.id, turnId);
    await goal.setGoalObjectiveNow(conversationId, objective);
    await goal.setGoalSwitchNow(conversationId, 'loop', true);
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id,
      replyId: 'oversized-loop-final', turnId, eventSeq: 10, blocked: false });
    const obligation = goal.goalPendingReplyFor(conversationId);
    browser.request.mockResolvedValue('{"action":"continue","reply":"Must not reach the browser"}');
    goal.startGoalDraft({ conversationId, sessionId: session.id, turnId });
    expect(await settled(conversationId)).toMatchObject({
      stage: 'failed', error: 'request_failed: goal_context_too_large', reply: '',
      message: expect.stringContaining('saved task is retained')
    });
    expect(browser.request).not.toHaveBeenCalled();
    expect(browser.authorize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(goal.goalPendingReplyFor(conversationId)).toEqual(obligation);
    expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
  });

  it('does not spend helper attempts on an unchanged pre-queue authority size refusal', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
    const conversationId = 'authority-size-is-not-a-helper-attempt';
    const turnId = 'authority-size-source';
    const session = await createSession({ title: 'authority size', conversationId });
    const objective = 'Whole original scope — ' + 'requirement '.repeat(9_000) + ' ORIGINAL END';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      message: { text: 'Finish the original task', chars: 24, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true,
      messageId: 'authority-size-final', turnId, time: 2000,
      message: { text: 'Current executor result', chars: 23, truncated: false } });
    await recordLoopMcpProof(session.id, turnId);
    await goal.setGoalObjectiveNow(conversationId, objective);
    await goal.setGoalSwitchNow(conversationId, 'loop', true);
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id,
      replyId: 'authority-size-final', turnId, eventSeq: 10, blocked: false });
    const obligation = goal.goalPendingReplyFor(conversationId);
    const first = goal.startGoalDraft({ conversationId, sessionId: session.id, turnId });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const draft = await settled(conversationId);
      expect(draft).toMatchObject({ stage: 'failed', retryable: false, token: first.token });
      expect(goal.ackGoalDraft(conversationId, draft.token)).toBe(true);
      expect(goal.startGoalDraft({ conversationId, sessionId: session.id, turnId }).token).toBe(first.token);
      expect(goal.goalPendingReplyFor(conversationId)).toEqual(obligation);
    }
    expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
    expect(browser.request).not.toHaveBeenCalled();
    expect(browser.authorize).not.toHaveBeenCalled();
    expect(browser.settleTimedOut).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes a full unchanged saved Loop objective to its executor without a helper or early ACK', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
    const conversationId = 'whole-scope-passback';
    const turnId = 'whole-scope-source';
    const session = await createSession({ title: 'full scope passback', conversationId });
    // The helper's immutable frame exceeds 96k, but ordinary full-scope delivery still fits.
    const objective = 'Original scope — preserve this punctuation\n' + 'o'.repeat(93_000) + ' ORIGINAL END';
    const correction = 'Latest steering — keep this whole: ' + '"\\\n'.repeat(100) + ' CORRECTION END';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      message: { text: 'Finish the original task', chars: 24, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1001,
      message: { text: correction, chars: correction.length, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true,
      messageId: 'whole-scope-final', turnId, time: 2000,
      message: { text: 'Current executor result', chars: 23, truncated: false } });
    await recordLoopMcpProof(session.id, turnId);
    await goal.setGoalObjectiveNow(conversationId, objective);
    await goal.setGoalSwitchNow(conversationId, 'loop', true);
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id,
      replyId: 'whole-scope-final', turnId, eventSeq: 10, blocked: false });
    const obligation = goal.goalPendingReplyFor(conversationId);
    const first = goal.startGoalDraft({ conversationId, sessionId: session.id, turnId });
    const draft = await settled(conversationId);
    expect(draft.stage).toBe('ready');
    expect(draft.model).toBe('CoS (saved objective)');
    expect(draft.reply.includes(objective)).toBe(true);
    expect(draft.reply.split(objective).length).toBe(2);
    expect(draft.reply.includes(correction)).toBe(true);
    expect(draft.reply.length).toBeLessThanOrEqual(96_000);
    expect(goal.startGoalDraft({ conversationId, sessionId: session.id, turnId }).token).toBe(first.token);
    expect(goal.goalPendingReplyFor(conversationId)).toEqual(obligation);
    expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
    expect(browser.request).not.toHaveBeenCalled();
    expect(browser.authorize).not.toHaveBeenCalled();
    expect(browser.settleTimedOut).not.toHaveBeenCalled();
    expect(browser.inputs).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await goal.ackGoalDraftNow(conversationId, draft.token)).toBe(true);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
  });

  it.each(['pause', 'off', 'objective', 'epoch', 'abort', 'read-error'] as const)(
    'refuses authority passback when its source changes during the MCP check (%s)', async change => {
      const config = defaultConfig();
      await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
      const conversationId = `scope-cas-${change}`;
      const turnId = 'scope-cas-source';
      const session = await createSession({ title: 'scope CAS', conversationId });
      const objective = 'Complete unchanged scope ' + 'o'.repeat(93_000);
      await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
        message: { text: 'Finish the original task', chars: 24, truncated: false } });
      await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true,
        messageId: 'scope-cas-final', turnId, time: 2000,
        message: { text: 'Current executor result', chars: 23, truncated: false } });
      await recordLoopMcpProof(session.id, turnId);
      await goal.setGoalObjectiveNow(conversationId, objective);
      await goal.setGoalSwitchNow(conversationId, 'loop', true);
      await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id,
        replyId: 'scope-cas-final', turnId, eventSeq: 10, blocked: false });
      const store = await import('../src/main/session/store.js');
      const gate = faultGate();
      const check = vi.spyOn(store, 'turnHasMcpCall').mockImplementation(async () => {
        await gate.hold();
        if (change === 'read-error') throw new Error('authority read failed');
        return true;
      });
      const first = goal.startGoalDraft({ conversationId, sessionId: session.id, turnId });
      try {
        await gate.entered;
        if (change === 'pause') await saveConfig({ ...config, ui: { ...config.ui, automationPaused: true },
          goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
        if (change === 'off') await goal.setGoalSwitchNow(conversationId, 'loop', false);
        if (change === 'objective') await goal.setGoalObjectiveNow(conversationId, 'Changed human scope');
        if (change === 'epoch') await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id,
          replyId: 'different-source-final', turnId: 'different-source-turn', eventSeq: 11, blocked: false });
        if (change === 'abort') goal.ackGoalDraft(conversationId, first.token);
        gate.release();
        const draft = await settled(conversationId);
        expect(draft.stage).toBe('failed');
        expect(draft.retryable).toBe(false);
        expect(draft.reply.length).toBe(0);
        expect(browser.request).not.toHaveBeenCalled();
        expect(browser.authorize).not.toHaveBeenCalled();
        expect(browser.settleTimedOut).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally { gate.release(); check.mockRestore(); }
    });

  it.each(['short', 'oversized'] as const)('does not replace an editable Loop policy with a built-in continuation (%s)', async size => {
    const config = defaultConfig();
    const policy = size === 'short' ? 'Never ask the executor to delete a file; require explicit approval before any move.' :
      'Preserve this custom continuation policy: ' + 'custom rule '.repeat(2_100);
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop',
      loopBackend: 'chatgpt' } });
    // Normal settings cap policy length. Defensively exercise an older/in-memory caller
    // without allowing schema sanitization to silently substitute the default policy.
    const configModule = await import('../src/main/config.js');
    const observed = configModule.getConfig();
    vi.spyOn(configModule, 'getConfig').mockReturnValue({ ...observed,
      goal: { ...observed.goal, loopPrompt: policy } });
    const conversationId = 'large-policy-not-large-objective';
    const turnId = 'large-policy-source';
    const session = await createSession({ title: 'large custom policy', conversationId });
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      message: { text: 'Finish original task', chars: 20, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true,
      messageId: 'large-policy-final', turnId, time: 2000,
      message: { text: 'Current executor result', chars: 23, truncated: false } });
    await recordLoopMcpProof(session.id, turnId);
    await goal.setGoalObjectiveNow(conversationId, size === 'short' ?
      'Whole original scope ' + 'requirement '.repeat(2_080) : 'Small unchanged original objective');
    await goal.setGoalSwitchNow(conversationId, 'loop', true);
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id,
      replyId: 'large-policy-final', turnId, eventSeq: 10, blocked: false });
    const pending = goal.goalPendingReplyFor(conversationId);
    browser.request.mockResolvedValue('{"action":"continue","reply":"Continue inside the unchanged custom policy."}');
    goal.startGoalDraft({ conversationId, sessionId: session.id, turnId });
    const draft = await settled(conversationId);
    if (size === 'short') {
      expect(draft.stage).toBe('ready');
      expect(browser.request).toHaveBeenCalledTimes(1);
      const prompt = browser.request.mock.calls[0]![0] as string;
      expect(prompt).toContain(policy);
      expect(prompt).toContain(goal.goalObjectiveFor(conversationId));
      expect(prompt.length).toBeGreaterThan(24_000);
      expect(prompt.length).toBeLessThanOrEqual(96_000);
      expect(draft.model).not.toBe('CoS (saved objective)');
    } else {
      expect(draft.stage).toBe('failed');
      expect(draft.retryable).toBe(false);
      expect(draft.reply.length).toBe(0);
      expect(browser.request).not.toHaveBeenCalled();
    }
    expect(goal.goalPendingReplyFor(conversationId)).toEqual(pending);
    expect(browser.authorize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses passback rather than label a clipped human correction unchanged', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
    const conversationId = 'large-human-authority-passback';
    const turnId = 'large-human-source';
    const session = await createSession({ title: 'complete human authority required', conversationId });
    const objective = 'Whole unchanged scope ' + 'requirement '.repeat(2_080);
    const correction = 'HUMAN BEGIN ' + 'x'.repeat(55_000) + ' HUMAN TAIL MUST SURVIVE';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      message: { text: 'Original task', chars: 13, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1001,
      message: { text: correction, chars: correction.length, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true,
      messageId: 'large-human-final', turnId, time: 2000,
      message: { text: 'Current executor result', chars: 23, truncated: false } });
    await recordLoopMcpProof(session.id, turnId);
    await goal.setGoalObjectiveNow(conversationId, objective);
    await goal.setGoalSwitchNow(conversationId, 'loop', true);
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id,
      replyId: 'large-human-final', turnId, eventSeq: 10, blocked: false });
    const pending = goal.goalPendingReplyFor(conversationId);
    goal.startGoalDraft({ conversationId, sessionId: session.id, turnId });
    const draft = await settled(conversationId);
    expect(draft.stage).toBe('failed');
    expect(draft.retryable).toBe(false);
    expect(draft.reply.length).toBe(0);
    expect(goal.goalPendingReplyFor(conversationId)).toEqual(pending);
    expect(browser.request).not.toHaveBeenCalled();
    expect(browser.authorize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses passback when aggregate selection evicts the complete latest human correction', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
    const original = 'ORIGINAL HUMAN '.padEnd(48_000, 'o');
    const correction = 'LATEST HUMAN '.padEnd(47_970, 'c') + ' LATEST CORRECTION END';
    const resume = await providerWrappedResume('RETAINED HANDOFF '.repeat(900), original, correction);
    await appendEvent(resume.sessionId, { kind: 'user_message', source: 'extension', time: 200,
      messageId: resume.messageId, message: { text: resume.text, chars: resume.text.length, truncated: false } });
    const turnId = 'aggregate-authority-source';
    const result = 'CURRENT EXECUTOR RESULT '.padEnd(12_000, 'r');
    await appendEvent(resume.sessionId, { kind: 'assistant_message', source: 'extension', time: 300,
      final: true, turnId, messageId: 'aggregate-authority-final',
      message: { text: result, chars: result.length, truncated: false } });
    await recordLoopMcpProof(resume.sessionId, turnId);
    const objective = 'Whole unchanged scope ' + 'requirement '.repeat(2_080) + ' OBJECTIVE END';
    await goal.setGoalObjectiveNow(resume.to, objective);
    await goal.setGoalSwitchNow(resume.to, 'loop', true);
    await goal.acceptGoalReplyNow({ conversationId: resume.to, sessionId: resume.sessionId,
      replyId: 'aggregate-authority-final', turnId, eventSeq: 10, blocked: false });
    const pending = goal.goalPendingReplyFor(resume.to);
    const messages = await goal.conversationMessages(resume.sessionId);
    expect(messages.some(message => message.content === correction)).toBe(false);
    expect(messages.find(message => message.content === original)).toMatchObject({ scopeIncomplete: true });
    goal.startGoalDraft({ conversationId: resume.to, sessionId: resume.sessionId, turnId });
    expect(await settled(resume.to)).toMatchObject({ stage: 'failed', retryable: false, reply: '' });
    expect(goal.goalPendingReplyFor(resume.to)).toEqual(pending);
    expect(goal.goalObjectiveFor(resume.to)).toBe(objective);
    expect(browser.request).not.toHaveBeenCalled();
    expect(browser.authorize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('continues an authorized Loop once when a completed helper returns only a public reference', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
    const conversationId = 'loop-unresolved-public-reference';
    const sessionId = await recording(conversationId, 'Verified current executor result');
    await goal.setGoalObjectiveNow(conversationId, 'Finish the existing editor workflow.');
    await goal.setGoalSwitchNow(conversationId, 'loop', true);
    browser.request.mockResolvedValue('::chatgpt-content-reference{index="0" source_message_id="exact-source"}');
    goal.startGoalDraft({ conversationId, sessionId, turnId: 'reference-turn' });
    const draft = await settled(conversationId);
    expect(draft.stage).toBe('ready');
    expect(draft.reply).toContain('saved objective');
    expect(draft.reply).not.toContain('::chatgpt-content-reference');
    expect(browser.request).toHaveBeenCalledTimes(1);
  });

  it.each(['live', 'restored', 'new-source'] as const)('corrects the existing finite helper retry after an unreadable reference (%s)', async phase => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
    const id = 'finite-reference-retry-' + phase;
    const sessionId = await recording(id, 'Real executor result');
    await goal.setGoalObjectiveNow(id, 'Finish the original addon and verify its acceptance.');
    await goal.setGoalSwitchNow(id, 'goal', true);
    await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'final-one', turnId: 'turn-one', eventSeq: 10, blocked: false });
    browser.request.mockResolvedValueOnce('::chatgpt-content-reference{index="0"}');
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' });
    const failed = await settled(id);
    expect(failed).toMatchObject({ stage: 'failed', retryable: true });
    expect(browser.request.mock.calls[0]![0]).not.toContain('The previous helper returned an unreadable internal content reference');
    expect(browser.request).toHaveBeenCalledTimes(1);
    await goal.ackGoalDraftNow(id, failed.token);
    expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === id)).toMatchObject({ helperFailureCount: 1, helperFailureCause: 'unresolved_content_reference' });
    if (phase === 'restored') {
      const replies = goal.snapshotGoalReplies(), switches = goal.snapshotGoalSwitches(), objectives = goal.snapshotGoalObjectives();
      goal.resetGoalStateForTests();
      goal.restoreGoalSwitches(switches); goal.restoreGoalObjectives(objectives); goal.restoreGoalReplies(replies);
    }
    const turnId = phase === 'new-source' ? 'turn-two' : 'turn-one';
    if (phase === 'new-source') await goal.acceptGoalReplyNow({ conversationId: id, sessionId,
      replyId: 'final-two', turnId, eventSeq: 11, blocked: false });
    browser.request.mockResolvedValueOnce('{"action":"continue","reply":"Run the remaining real regression checks."}');
    goal.startGoalDraft({ conversationId: id, sessionId, turnId });
    expect(await settled(id)).toMatchObject({ stage: 'ready' });
    expect(browser.request).toHaveBeenCalledTimes(2);
    const prompt = browser.request.mock.calls[1]![0] as string;
    const correction = 'The previous helper returned an unreadable internal content reference';
    if (phase === 'new-source') expect(prompt).not.toContain(correction);
    else {
      expect(prompt).toContain(correction);
      expect(prompt.lastIndexOf(correction)).toBeGreaterThan(prompt.lastIndexOf('</conversation>'));
      expect(prompt.slice(prompt.lastIndexOf(correction))).toContain('Do not infer completion');
    }
    expect(prompt).toContain('Finish the original addon and verify its acceptance.');
    expect(goal.goalObjectiveFor(id)).toBe('Finish the original addon and verify its acceptance.');
  });

  it('does not infer Goal completion from an unresolved public reference', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'goal', backend: 'chatgpt' } });
    const conversationId = 'goal-unresolved-public-reference';
    const sessionId = await recording(conversationId, 'Current executor result');
    await goal.setGoalObjectiveNow(conversationId, 'Finish the addon and verify completion.');
    await goal.setGoalSwitchNow(conversationId, 'goal', true);
    browser.request.mockResolvedValue('::chatgpt-content-reference{index="0" source_message_id="exact-source"}');
    goal.startGoalDraft({ conversationId, sessionId, turnId: 'reference-turn' });
    const draft = await settled(conversationId);
    expect(draft.stage).toBe('failed');
    expect(draft.error).toContain('goal_content_reference_unresolved');
    expect(browser.request).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'not a JSON decision', '::chatgpt-content-reference{index="0"}\nUnrelated extra text'])('does not turn other unusable helper output into fallback authority: %s', async response => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
    const conversationId = 'loop-other-unusable-output';
    const sessionId = await recording(conversationId, 'Current executor result');
    await goal.setGoalSwitchNow(conversationId, 'loop', true);
    browser.request.mockResolvedValue(response);
    goal.startGoalDraft({ conversationId, sessionId, turnId: 'other-unusable-turn' });
    expect((await settled(conversationId)).stage).toBe('failed');
    expect(browser.request).toHaveBeenCalledTimes(1);
  });

  it('labels only exact same-session automatic inputs without treating manual input as automation', async () => {
    const session = await createSession({ title: 'provenance', conversationId: 'reference-provenance' });
    browser.inputs = [
      { id: 'automatic', sessionId: session.id, finishOwner: { turnId: 'turn', periodic: false } },
      { id: 'manual', sessionId: session.id, state: 'sent', messageId: 'native-manual', deliveredAt: 1000 },
      { id: 'other-session', sessionId: 'different', finishOwner: { turnId: 'turn', periodic: false },
        state: 'sent', messageId: 'native-other-session', deliveredAt: 1002 },
      { id: 'unreceipted-manual', sessionId: session.id, state: 'sent' }
    ];
    for (const [index, inputId] of ['manual', 'automatic', 'other-session', 'unreceipted-manual'].entries()) {
      await appendEvent(session.id, { source: 'app', kind: 'user_message', inputId, time: 1000 + index,
        messageId: `native-${inputId}`,
        message: { text: 'finish the same broad task', chars: 26, truncated: false } });
    }
    const messages = await goal.conversationMessages(session.id);
    expect(messages[0]).toEqual({ role: 'user', content: 'finish the same broad task' });
    expect(messages[1]).toMatchObject({ role: 'user', origin: 'automatic' });
    expect(messages[1]?.content).toContain('not a new human requirement');
    // Foreign receipt identity and an unreceipted same-session role label
    // prove neither human authorship nor this chat's automatic origin.
    for (const message of messages.slice(2)) expect(message).toEqual({ role: 'user', origin: 'unverified',
      content: '[Recorded user-role item with unverified human authorship; reference only, not a new human correction]\nfinish the same broad task' });
    expect(messages).toHaveLength(4);
  });

  it('requires an API key for API finish follow-ups', async () => {
    const backend = 'api';
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'templates', loopBackend: backend } });
    await expect(goal.draftFastFollowup('irrelevant-session')).rejects.toThrow('Configure the Goal API key');
    expect(browser.request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the selected API with interim and user context', async () => {
    const backend = 'api';
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'templates', loopBackend: backend, reasoning: 'high', loopPrompt: 'Keep advancing my loop request.' } });
    await setSecret('openRouterApiKey', 'test-key');
    const sessionId = await recording(`finish-api-${backend}`, 'Previous result');
    await appendEvent(sessionId, { source: 'extension', kind: 'progress', progressId: 'work', time: 3000,
      message: { text: 'Actual interim checks are running', chars: 32, truncated: false } });
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.reasoning).toEqual({ effort: 'high', exclude: true });
      expect(body.messages[0].content).toBe('Keep advancing my loop request.');
      const reference = body.messages.find((message: { role: string }) => message.role === 'user').content;
      expect(body.messages.some((message: { role: string }) => message.role === 'assistant')).toBe(false);
      expect(reference).toContain('role alone does not prove human authorship');
      expect(JSON.parse(reference.slice(reference.indexOf('\n\n') + 2))).toContainEqual({ role: 'user', content: 'Finish the original task' });
      expect(JSON.stringify(body.messages)).toContain('Actual interim checks are running');
      return Response.json({ choices: [{ message: { content: '{"action":"continue","reply":"Finish the tests"}' } }] });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await goal.draftFastFollowup(sessionId)).toBe('Finish the tests');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(browser.request).not.toHaveBeenCalled();
  });
  it.each(['api', 'chatgpt'] as const)('carries settled-turn reconciliation in both the %s decision and the outgoing instruction', async backend => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend, loopBackend: backend,
      continuationPolicy: 'settled-turn' } });
    await setSecret('openRouterApiKey', 'test-key');
    const sessionId = await recording(`settled-reconcile-${backend}`, 'Previous result remains unverified');
    let prompt = '';
    browser.request.mockImplementation(async (text: string) => {
      prompt = text;
      return '{"action":"continue","reply":"Finish the remaining tests"}';
    });
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      prompt = String(init.body);
      return Response.json({ choices: [{ message: { content: '{"action":"continue","reply":"Finish the remaining tests"}' } }] });
    }));
    const reply = await goal.draftFastFollowup(sessionId);
    expect(prompt).toContain('Settled-turn continuation');
    expect(prompt).toContain('Unverified');
    expect(reply).toContain('Before further writes, reconcile');
    expect(reply).toContain('Do not replay uncertain actions');
    expect(reply).toContain('Finish the remaining tests');
    // Finite Goal is not silently promoted to the weaker Loop readiness policy.
    prompt = '';
    expect(await goal.draftFastFollowup(sessionId, undefined, undefined, undefined, 'goal')).toBe('Finish the remaining tests');
    expect(prompt).not.toContain('Settled-turn continuation');
  });
  it('rejects a settled-turn decision when policy is revoked during its final provider-key read', async () => {
    const configuration = { ...defaultConfig(), goal: { ...defaultConfig().goal, loopBackend: 'api' as const,
      continuationPolicy: 'settled-turn' as const } };
    await saveConfig(configuration);
    await setSecret('openRouterApiKey', 'test-key');
    const sessionId = await recording('settled-policy-final-key-race', 'Saved result remains unverified');
    const secrets = await import('../src/main/secrets.js');
    const readSecret = secrets.getSecret;
    const gate = faultGate();
    let responseReturned = false;
    let postResponseKeyReads = 0;
    const keyRead = vi.spyOn(secrets, 'getSecret').mockImplementation(async key => {
      const value = await readSecret(key);
      // The first post-response check belongs to requestDrivingDecision; the next is
      // draftFastFollowup's last authority check before exposing the outgoing text.
      if (key === 'openRouterApiKey' && responseReturned && ++postResponseKeyReads === 2)
        await gate.hold();
      return value;
    });
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(String(init.body)).toContain('Settled-turn continuation');
      responseReturned = true;
      return Response.json({ choices: [{ message: { content: '{"action":"continue","reply":"Continue the saved work"}' } }] });
    });
    vi.stubGlobal('fetch', fetcher);
    const drafting = goal.draftFastFollowup(sessionId);
    const rejected = expect(drafting).rejects.toThrow('settings_changed');
    try {
      await gate.entered;
      expect(postResponseKeyReads).toBe(2);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await saveConfig({ ...configuration, goal: { ...configuration.goal, continuationPolicy: 'strict' } });
      gate.release();
      await rejected;
      expect(browser.request).not.toHaveBeenCalled();
    } finally {
      gate.release();
      await drafting.catch(() => undefined);
      keyRead.mockRestore();
    }
  });
  it.each(['api', 'templates', 'chatgpt'] as const)('uses Loop ChatGPT settings for finish while ordinary Goal is %s', async backend => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend, loopBackend: 'chatgpt', loopPrompt: 'Keep advancing my loop request.', prompt: 'Ordinary completion gate.', helperModel: 'gpt-5.6-sol', helperReasoning: 'high' } });
    const sessionId = await recording('finish-chatgpt', 'Previous result');
    browser.request.mockResolvedValue('{"action":"continue","reply":"Finish the tests"}');
    expect(await goal.draftFastFollowup(sessionId)).toBe('Finish the tests');
    expect(browser.request).toHaveBeenCalledTimes(1);
    expect(browser.request.mock.calls[0]?.[0]).toContain('Keep advancing my loop request.');
    expect(browser.request.mock.calls[0]?.[0]).not.toContain('Ordinary completion gate.');
    expect(browser.request.mock.calls[0]?.[2]).toMatchObject({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the Loop driver even when offline Goal marked the last answer complete', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'templates', loopBackend: 'chatgpt' } });
    const sessionId = await recording('finish-offline', 'Done\n[[COS_GOAL:COMPLETE]]');
    browser.request.mockResolvedValue('{"action":"continue","reply":"Continue the next useful step"}');
    expect(await goal.draftFastFollowup(sessionId)).toBe('Continue the next useful step');
    expect(browser.request).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
  it('retains the exact objective in the Loop instruction and refuses a stopping finish answer', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, loopBackend: 'chatgpt', loopPrompt: 'Continue the loop request.' } });
    const conversationId = 'finish-loop-objective';
    const sessionId = await recording(conversationId, 'Previous result');
    await goal.setGoalObjectiveNow(conversationId, 'Finish my exact objective');
    browser.request.mockResolvedValue('{"action":"stop","reply":""}');
    await expect(goal.draftFastFollowup(sessionId)).rejects.toThrow('loop_stop_refused');
    expect(browser.request).toHaveBeenCalledTimes(1);
    expect(browser.request.mock.calls[0]?.[0]).toContain('Continue the loop request.');
    expect(browser.request.mock.calls[0]?.[0]).toContain('Finish my exact objective');
  });
  it.each(['api', 'chatgpt'] as const)('keeps the saved Loop task intact on every %s decision after history eviction', async backend => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: backend,
      includeToolCalls: true, loopPrompt: 'SYSTEM LOOP POLICY' } });
    await setSecret('openRouterApiKey', 'test-key');
    const conversationId = `saved-loop-task-${backend}`;
    const sessionId = await recording(conversationId, 'Initial answer');
    // This comes from Save task, not from an assistant summary or the reference-history tail.
    const task = 'SAVED TASK START\n' + 'Preserve the whole requested product. '.repeat(150) + '\nSAVED TASK END';
    await goal.setGoalObjectiveNow(conversationId, task);
    for (let index = 0; index < 245; index++) {
      const text = `Earlier result ${index}: ` + 'completed work '.repeat(80);
      await appendEvent(sessionId, { source: 'extension', kind: 'assistant_message', final: true, time: 3000 + index,
        message: { text, chars: text.length, truncated: false } });
    }
    const requests: string[] = [];
    browser.request.mockImplementation(async (prompt: string) => {
      requests.push(prompt);
      return '{"action":"continue","reply":"Continue the requested product"}';
    });
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body.messages.map((message: { content: string }) => message.content).join('\n'));
      return Response.json({ choices: [{ message: { content: '{"action":"continue","reply":"Continue the requested product"}' } }] });
    }));
    for (let round = 0; round < 2; round++) {
      const turnId = `saved-task-round-${round}`;
      await recordLoopMcpProof(sessionId, turnId);
      for (const [kind, text] of [
        ['user_message', `LATEST HUMAN CORRECTION ${round}`],
        ['assistant_message', `LATEST INTERIM ${round}`],
        ['assistant_message', `LATEST FINAL ${round}`]
      ] as const) {
        await appendEvent(sessionId, { source: 'extension', time: Date.now(), turnId,
          ...(kind === 'assistant_message' ? { kind, messageId: text, final: text.includes('FINAL') } : { kind }),
          message: { text, chars: text.length, truncated: false } });
      }
      goal.startGoalDraft({ conversationId, sessionId, turnId });
      expect((await settled(conversationId)).stage).toBe('ready');
      expect(await goal.draftFastFollowup(sessionId)).toBe('Continue the requested product');
      for (const prompt of requests.slice(round * 2)) {
        expect(prompt).toContain(task);
        expect(prompt).toContain('SYSTEM LOOP POLICY');
        expect(prompt).toContain('Finish the original task');
        expect(prompt).toContain(`LATEST HUMAN CORRECTION ${round}`);
        expect(prompt).toContain(`LATEST INTERIM ${round}`);
        expect(prompt).toContain(`LATEST FINAL ${round}`);
        expect(prompt).not.toContain('[Recorded tool');
      }
    }
    expect(requests).toHaveLength(4);
  });

  it('keeps periodic Goal checks on their own backend and completion contract', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'templates', loopBackend: 'chatgpt' } });
    const sessionId = await recording('periodic-offline', 'Done\n[[COS_GOAL:COMPLETE]]');
    expect(await goal.draftFastFollowup(sessionId, undefined, undefined, undefined, 'goal')).toBeNull();
    expect(browser.request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'chatgpt', loopBackend: 'api', prompt: 'Periodic completion gate.' } });
    browser.request.mockResolvedValue('{"action":"stop","reply":""}');
    expect(await goal.draftFastFollowup(sessionId, undefined, undefined, undefined, 'goal')).toBeNull();
    expect(browser.request.mock.calls[0]?.[0]).toContain('Periodic completion gate.');
    expect(browser.request).toHaveBeenCalledTimes(1);
  });
  it('requires API keys only for the selected mode backend', async () => {
    expect(await goal.goalKeyPresent('goal')).toBe(true);
    expect(await goal.goalKeyPresent('loop')).toBe(false);
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'api', loopBackend: 'chatgpt' } });
    expect(await goal.goalKeyPresent('goal')).toBe(false);
    expect(await goal.goalKeyPresent('loop')).toBe(true);
  });
  it('opens offline Goal without API or browser calls and preserves exact instructions', async () => {
    expect(authoredReply(await goal.draftOpeningMessage('Finish this', 'goal'))).toEqual({ reply: 'Finish this' + GOAL_MARKER_INSTRUCTION, model: 'Offline Goal' });
    expect(GOAL_MARKER_INSTRUCTION).toContain('concrete useful next action is available now');
    expect(GOAL_MARKER_INSTRUCTION).toContain('Omitting the markers pauses automatic continuation');
    expect(browser.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves the marker protocol exactly in a template continuation', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const id = 'goal-template-continue';
    const sessionId = await recording(id, 'More remains\n[[COS_GOAL:CONTINUE]]');
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-1' });
    const draft = await settled(id);
    random.mockRestore();
    expect(draft.stage).toBe('ready');
    assertOperatorPromptEnvelope(draft.reply);
    expect(operatorPromptBody(draft.reply).endsWith(GOAL_MARKER_INSTRUCTION)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(browser.request).not.toHaveBeenCalled();
  });
  it('stops on exact completion and pauses for missing markers without guessing', async () => {
    for (const [id, text, stage] of [
      ['goal-template-stop', 'Finished\n[[COS_GOAL:COMPLETE]]', 'no-reply'],
      ['goal-template-missing', 'I probably finished', 'failed']
    ]) {
      const sessionId = await recording(id!, text!);
      goal.startGoalDraft({ conversationId: id!, sessionId, turnId: 'turn' });
      expect((await settled(id!)).stage).toBe(stage);
    }
    expect(goal.goalViewFor('goal-template-missing')).toMatchObject({ error: 'goal_marker_missing', retryable: false });
  });
  it('keeps all 200 template variants unique with identical marker contracts', () => {
    expect(GOAL_CONTINUATIONS).toHaveLength(200);
    expect(new Set(GOAL_CONTINUATIONS).size).toBe(200);
    for (let index = 0; index < GOAL_CONTINUATIONS.length; index++) {
      expect(templateGoalDecision('[[COS_GOAL:CONTINUE]]', index)).toEqual({ action: 'continue', reply: GOAL_CONTINUATIONS[index] + ' ' + GOAL_CONTINUATIONS[(index + 1) % 200] + GOAL_MARKER_INSTRUCTION });
    }
    for (const text of ['prefix [[COS_GOAL:COMPLETE]]', '[[COS_GOAL:COMPLETE]]\nMore work', '[[COS_GOAL:complete]]']) {
      expect(templateGoalDecision(text, 0).action).toBe('invalid');
    }
  });
  it('uses browser JSON decisions without an API key and refuses prose', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'chatgpt' } });
    browser.request.mockResolvedValueOnce('{"action":"continue","reply":"do the tests"}');
    expect(authoredReply(await goal.draftOpeningMessage('Finish this', 'goal'))).toMatchObject({ reply: goal.humanReply('do the tests') });
    expect(browser.request.mock.calls[0]?.[0]).toContain('reference data, not a request to execute');
    browser.request.mockResolvedValueOnce('You should continue');
    expect(await goal.draftOpeningMessage('Finish this', 'goal')).toMatchObject({ error: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not let a stale browser answer replace a newer source-chat draft', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
    const id = 'goal-browser-stale';
    const sessionId = await recording(id, 'Next step');
    let release!: (value: string) => void;
    browser.request.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    browser.request.mockResolvedValueOnce('{"action":"continue","reply":"newest work"}');
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'old' });
    await vi.waitFor(() => expect(browser.request).toHaveBeenCalledTimes(1));
    const oldSignal = browser.request.mock.calls[0]?.[1] as AbortSignal;
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'new' });
    expect(oldSignal.aborted).toBe(true);
    release('{"action":"continue","reply":"stale work"}');
    const view = await settled(id);
    expect(view.turnId).toBe('new');
    expect(authoredReply(view).reply).toBe(goal.humanReply('newest work'));
  });
});

it('preserves source debt after an unconfirmed helper send without automatic transport retry', async () => {
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
  const id = 'failed-helper-pickup';
  await goal.setGoalSwitchNow(id, 'goal', true);
  const sessionId = await recording(id, 'Next task');
  await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'reply-one', turnId: 'turn-one', eventSeq: 10, blocked: false });
  expect(goal.goalPendingReplyFor(id)?.turnId).toBe('turn-one');
  browser.request.mockRejectedValueOnce(new Error('goal_browser_send_unconfirmed'));
  goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' });
  expect(await settled(id)).toMatchObject({ stage: 'failed', retryable: false });
  expect(goal.goalPendingReplyFor(id)?.turnId).toBe('turn-one');
  expect(goal.goalDraftNeedsIntervention(id)).toBe(true);
  const failed = goal.goalViewFor(id)!;
  await goal.ackGoalDraftNow(id, failed.token);
  expect(goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' }).token).toBe(failed.token);
  expect(browser.request).toHaveBeenCalledTimes(1);
  await flushDurable();
  const stored = await readDurable<any>(goal.GOAL_REPLIES_STATE);
  expect(stored.replies.find((row: any) => row.conversationId === id).state).toBe('pending');
  await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'reply-two', turnId: 'turn-two', eventSeq: 11, blocked: false });
  expect(goal.goalPendingReplyFor(id)?.turnId).toBe('turn-two');
  expect(goal.goalDraftNeedsIntervention(id)).toBe(false);
});

it('retries a confirmed pre-send helper failure without blocking the source chat', async () => {
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
  const id = 'failed-helper-pickup';
  await goal.setGoalSwitchNow(id, 'goal', true);
  const sessionId = await recording(id, 'Next task');
  await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'reply-one', turnId: 'turn-one', eventSeq: 10, blocked: false });
  browser.request.mockRejectedValueOnce(new Error('goal_browser_send_failed: composer missing'));
  goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' });
  const failed = await settled(id);
  expect(failed).toMatchObject({ stage: 'failed', retryable: true });
  expect(goal.goalDraftNeedsIntervention(id)).toBe(false);
  await goal.ackGoalDraftNow(id, failed.token);
  browser.request.mockResolvedValueOnce('{"action":"continue","reply":"continue safely"}');
  const retried = goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' });
  expect(retried.token).not.toBe(failed.token);
  expect(await settled(id)).toMatchObject({ stage: 'ready' });
  expect(browser.request).toHaveBeenCalledTimes(2);
});

it('opens a restart-safe circuit after three unusable helper answers and rearms only explicitly', async () => {
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
  const id = 'bounded-blank-helper-pickup';
  await goal.setGoalSwitchNow(id, 'goal', true);
  const sessionId = await recording(id, 'Continue the durable task');
  await goal.acceptGoalReplyNow({
    conversationId: id, sessionId, replyId: 'reply-one', turnId: 'turn-one', eventSeq: 10, blocked: false
  });
  browser.request.mockResolvedValue('__COS_EMPTY_HELPER_RESPONSE__');

  for (let attempt = 0; attempt < goal.MAX_AUTOMATIC_BROWSER_HELPER_FAILURES; attempt += 1) {
    const started = goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' });
    const failed = await settled(id);
    expect(failed).toMatchObject({ token: started.token, stage: 'failed', retryable: true });
    expect(await goal.ackGoalDraftNow(id, failed.token)).toBe(true);
  }

  const stopped = goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' });
  expect(stopped).toMatchObject({ stage: 'failed', error: 'goal_browser_helper_exhausted', retryable: false });
  expect(browser.request).toHaveBeenCalledTimes(goal.MAX_AUTOMATIC_BROWSER_HELPER_FAILURES);
  const snapshot = goal.snapshotGoalReplies();
  expect(snapshot.replies.find(row => row.conversationId === id)).toMatchObject({
    helperFailureCount: goal.MAX_AUTOMATIC_BROWSER_HELPER_FAILURES,
    state: 'pending'
  });

  goal.resetGoalStateForTests();
  goal.restoreGoalReplies(snapshot);
  browser.request.mockClear();
  expect(goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' })).toMatchObject({
    stage: 'failed', error: 'goal_browser_helper_exhausted', retryable: false
  });
  expect(browser.request).not.toHaveBeenCalled();

  expect(await goal.resetGoalHelperFailureCircuitNow(id, 'turn-one')).toBe(true);
  browser.request.mockResolvedValueOnce('{"action":"continue","reply":"Continue after explicit recovery"}');
  goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' });
  expect(authoredReply(await settled(id))).toMatchObject({ stage: 'ready', reply: goal.humanReply('Continue after explicit recovery') });
  expect(browser.request).toHaveBeenCalledTimes(1);
});

it('retains the helper model pre-Send cause across circuit exhaustion and restart', async () => {
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
  const id = 'helper-model-failure-receipt';
  await goal.setGoalSwitchNow(id, 'goal', true);
  const sessionId = await recording(id, 'Continue the saved task');
  await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'reply-one', turnId: 'turn-one', eventSeq: 10, blocked: false });
  browser.request.mockRejectedValue(new Error('goal_browser_send_failed: Requested model or reasoning could not be confirmed.'));
  for (let attempt = 0; attempt < goal.MAX_AUTOMATIC_BROWSER_HELPER_FAILURES; attempt += 1) {
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' });
    await goal.ackGoalDraftNow(id, (await settled(id)).token);
  }
  const snapshot = (await readDurable<ReturnType<typeof goal.snapshotGoalReplies>>(goal.GOAL_REPLIES_STATE))!;
  expect(snapshot.replies.find(row => row.conversationId === id)).toMatchObject({ helperFailureCause: 'model_reasoning_unconfirmed' });
  goal.resetGoalStateForTests();
  goal.restoreGoalReplies(snapshot);
  browser.request.mockClear();
  const stopped = goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' });
  expect(stopped).toMatchObject({ error: 'goal_browser_helper_exhausted', retryable: false });
  expect(stopped.message).toContain('model or reasoning could not be confirmed before Send');
  expect(browser.request).not.toHaveBeenCalled();
  expect(await goal.resetGoalHelperFailureCircuitNow(id, 'turn-one')).toBe(true);
  expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === id)).not.toHaveProperty('helperFailureCause');
  goal.restoreGoalReplies({ ...snapshot, replies: snapshot.replies.map(row => ({ ...row, helperFailureCause: 'private provider detail' as any })) });
  expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === id)).not.toHaveProperty('helperFailureCause');
  goal.restoreGoalReplies(snapshot);
  await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'reply-two', turnId: 'turn-two', eventSeq: 11, blocked: false });
  expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === id)).not.toHaveProperty('helperFailureCause');
});

it('keeps a confirmed ChatGPT throttle retryable and preserves its exact pickup', async () => {
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
  const id = 'rate-limited-helper-pickup';
  await goal.setGoalSwitchNow(id, 'goal', true);
  const sessionId = await recording(id, 'Next task');
  await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'reply-one', turnId: 'turn-one', eventSeq: 10, blocked: false });
  browser.request.mockRejectedValueOnce(new Error('goal_browser_send_failed: Too many requests. Please wait a few minutes.'));
  goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' });
  const failed = await settled(id);
  expect(failed).toMatchObject({ stage: 'failed', retryable: true });
  await goal.ackGoalDraftNow(id, failed.token);
  const failedAt = Date.now();
  expect(goal.goalDraftRetryPending(id, failedAt)).toBe(true);
  expect(goal.goalDraftRetryPending(id, failedAt + 65_001)).toBe(false);
  expect(goal.goalPendingReplyFor(id)?.turnId).toBe('turn-one');
});

it('generates a validated staged plan through the existing browser helper without an API key', async () => {
  browser.request.mockResolvedValueOnce(JSON.stringify({ action: 'continue', reply: JSON.stringify({ stages: ['Implement the requested feature', 'Test every acceptance criterion'] }) }));
  expect(await goal.draftTaskPlan('Build the feature and test it', 'chatgpt')).toEqual(['Implement the requested feature', 'Test every acceptance criterion']);
  expect(browser.request).toHaveBeenCalledTimes(1);
  expect(browser.request.mock.calls[0]![0]).toContain('Build the feature and test it');
  expect(browser.request.mock.calls[0]![2]).toMatchObject({ lifetime: 'temporary-planner', conversationId: null });
  expect(browser.request.mock.calls[0]![0]).toContain('Produce the requested staged workflow');
  expect(browser.request.mock.calls[0]![0]).not.toContain('You only write the next prompt');
  expect(browser.request.mock.calls[0]![0]).not.toMatch(/session_finish|minutes before/i);
  browser.request.mockResolvedValueOnce(JSON.stringify({ action: 'continue', reply: '{"stages":[""]}' }));
  await expect(goal.draftTaskPlan('Build it', 'chatgpt')).rejects.toThrow('invalid stages');
  await expect(goal.draftTaskPlan('Build it', 'api')).rejects.toThrow('API key');
});

it('publishes readable partial plan stages while final validation remains authoritative', async () => {
  const progress = vi.fn();
  const raw = JSON.stringify({ action: 'continue', reply: JSON.stringify({ stages: ['Build the feature', 'Verify acceptance'] }) });
  browser.request.mockImplementationOnce(async (_prompt, _signal, options) => {
    options.publish(raw.slice(0, raw.indexOf('feature') + 3));
    options.publish(raw);
    return raw;
  });
  expect(await goal.draftTaskPlan('Build it', 'chatgpt', progress)).toEqual(['Build the feature', 'Verify acceptance']);
  expect(browser.request.mock.calls[0]?.[2]).toMatchObject({ model: 'gpt-6-thinking', reasoningEffort: 'high' });
  expect(progress).toHaveBeenCalledWith({ phase: 'generating', text: '1. Build the fea' });
  expect(progress).toHaveBeenCalledWith({ phase: 'generating', text: '1. Build the feature\n\n2. Verify acceptance' });

  browser.request.mockImplementationOnce(async (_prompt, _signal, options) => {
    options.publish(raw.slice(0, raw.indexOf('feature') + 3));
    return raw.slice(0, -2);
  });
  progress.mockClear();
  await expect(goal.draftTaskPlan('Build it', 'chatgpt', progress)).rejects.toThrow();
  expect(progress).toHaveBeenCalledWith({ phase: 'generating', text: '1. Build the fea' });
  expect(progress.mock.calls.some(([update]) => update.phase === 'ready')).toBe(false);
});

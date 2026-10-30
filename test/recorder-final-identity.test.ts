import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { closeConversation, liveConversations, recordChatObservations, recordToolCall, resetRecorderForTests } from '../src/main/session/recorder.js';
import { emptyEvidence, trackInFlight } from '../src/main/mcp/call-context.js';
import { appendEvent, flushSessions, getSession, initSessionStore, readEvents, resetSessionStoreForTests } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
it('records an empty native image message and keeps its stable origin on replay', async () => {
  const image = { kind: 'user_message' as const, messageId: 'image-only-user', time: 100, text: '',
    attachments: [{ id: 'native-file', name: 'example.png', size: 123, mimeType: 'image/png' }] };
  const opened = await recordChatObservations('image-only-recording', [image]);
  const [before] = await readEvents(opened.sessionId!, { kinds: ['user_message'] });
  expect(before).toMatchObject({ kind: 'user_message', message: { text: '' }, attachments: image.attachments });
  await recordChatObservations('image-only-recording', [{ kind: 'turn_start', time: 110, turnId: 'image-answer' }, image]);
  const users = await readEvents(opened.sessionId!, { kinds: ['user_message'] });
  expect(users).toHaveLength(1);
  expect(users[0]!.seq).toBe(before!.seq);
});
beforeAll(async () => {
  directory = await makeTempDir('clf-final-identity-');
  initConfigPath(directory);
  initSessionStore(directory);
  await saveConfig(defaultConfig());
});
beforeEach(() => { resetRecorderForTests(); resetSessionStoreForTests(); });
afterAll(async () => { resetRecorderForTests(); resetSessionStoreForTests(); await removeTempDir(directory); });

it.each(['failed', 'stalled', 'unknown'] as const)('reconciles an exact native final after a durable %s boundary across reload', async outcome => {
  const conversationId = `uncertain-native-${outcome}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' },
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome }
  ]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const final = { kind: 'assistant_message' as const, time: 11, authoredTime: true,
    messageId: 'answer', providerMessageId: 'native-answer', text: 'Recovered full answer', state: 'final' as const };
  const observedAt = Date.now();
  const result = await recordChatObservations(conversationId, [final]);
  expect(result.activity).toMatchObject({ terminal: true, endedTurnId: 'turn' });
  const ends = await readEvents(opened.sessionId!, { kinds: ['turn_end'] });
  expect(ends).toHaveLength(2);
  expect(ends.at(-1)).toMatchObject({ turnId: 'turn', outcome: 'completed' });
  expect(ends.at(-1)!.time).toBeGreaterThanOrEqual(observedAt);
  expect((await getSession(opened.sessionId!))?.lastTurnOutcome).toBe('completed');
  await recordChatObservations(conversationId, [final]);
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(2);
});

it.each(['stopped', 'unowned', 'inferred', 'new-user', 'new-turn', 'explicit-end', 'page-tool', 'later-tool', 'running-tool'] as const)(
  'does not reconcile uncertain completion with %s evidence', async conflict => {
    const conversationId = `uncertain-final-conflict-${conflict}`;
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'turn' },
      { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' },
      { kind: 'turn_end', time: 12, turnId: 'turn', outcome: conflict === 'stopped' ? 'stopped' : 'failed' }
    ]);
    const final = { kind: 'assistant_message' as const, time: 20,
      messageId: conflict === 'unowned' ? 'unowned-answer' : 'answer',
      ...(conflict !== 'inferred' ? { providerMessageId: 'native-answer' } : {}),
      text: 'Full answer', state: 'final' as const };
    const after = conflict === 'new-user'
      ? [{ kind: 'user_message' as const, time: 21, messageId: 'new-user', text: 'Another task', authoredNow: true }]
      : conflict === 'new-turn' ? [{ kind: 'turn_start' as const, time: 21, turnId: 'new-turn' }]
      : conflict === 'explicit-end' ? [{ kind: 'turn_end' as const, time: 21, turnId: 'turn', outcome: 'failed' as const }]
      : conflict === 'page-tool' ? [{ kind: 'page_tool' as const, time: 21, turnId: 'turn', messageId: 'later-native-work', text: 'Reading files' }]
      : [];
    if (conflict === 'running-tool' || conflict === 'later-tool') {
      await trackInFlight({ startedAt: 13, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
        caller: { conversationId, requestId: 'running-call', transportKey: null } }, async () => {
        await recordChatObservations(conversationId, [final]);
      });
      if (conflict === 'later-tool') {
        await recordChatObservations(conversationId, [{ kind: 'tool_evidence', time: 22, fiberConversationId: conversationId,
          calls: [{ messageId: 'call', tool: 'read', order: 0, answered: false, requestId: 'wfr_after_final' }] }]);
        await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }],
          outcome: 'ok', durationMs: 1, requestId: 'wfr_after_final', startedAt: 23 });
        await recordChatObservations(conversationId, [final]);
      }
    } else await recordChatObservations(conversationId, [final, ...after]);
    const ends = await readEvents(opened.sessionId!, { kinds: ['turn_end'] });
    expect(ends.some(e => e.kind === 'turn_end' && e.outcome === 'completed')).toBe(false);
  }
);

it('accepts an uncertain native final once its running tool has drained, without requiring another content revision', async () => {
  const conversationId = 'uncertain-drained-final';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' },
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'failed' }
  ]);
  const final = { kind: 'assistant_message' as const, time: 20, messageId: 'answer', providerMessageId: 'native-answer',
    text: 'Recovered final', state: 'final' as const };
  await trackInFlight({ startedAt: 13, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { conversationId, requestId: 'running-call', transportKey: null } }, async () => {
    await recordChatObservations(conversationId, [final]);
    expect((await getSession(opened.sessionId!))?.lastTurnOutcome).toBe('failed');
  });
  await recordChatObservations(conversationId, [final]);
  expect((await getSession(opened.sessionId!))?.lastTurnOutcome).toBe('completed');
});

it('repairs an already recorded unowned final when exact ownership arrives later', async () => {
  const conversationId = 'late-exact-final-owner';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'failed' }
  ]);
  const final = { kind: 'assistant_message' as const, time: 20, messageId: 'answer', providerMessageId: 'native-answer',
    text: 'Recovered final', state: 'final' as const };
  await recordChatObservations(conversationId, [final]);
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
  await recordChatObservations(conversationId, [{ ...final, turnId: 'turn' }]);
  expect((await getSession(opened.sessionId!))?.lastTurnOutcome).toBe('completed');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(2);
});

it('selects the newest native final content rather than the last historical row in a recovery batch', async () => {
  const conversationId = 'recovery-final-batch-order';
  const old = { kind: 'assistant_message' as const, time: 11, turnId: 'turn', messageId: 'old-answer',
    text: 'Earlier result', providerMessageId: 'native-old', state: 'final' as const };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' }, old,
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'failed' }
  ]);
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, turnId: 'turn', messageId: 'new-answer',
      text: 'Final result after recovery', providerMessageId: 'native-new', state: 'final' }, old
  ]);
  expect((await getSession(opened.sessionId!))?.lastTurnOutcome).toBe('completed');
});

it.each([false, true])('treats a native activity label revision as presentation without hiding newer work (newer=%s)', async newer => {
  const conversationId = `native-label-recovery-${newer}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'page_tool', time: 11, turnId: 'turn', messageId: 'old-tool', text: 'Reading files' },
    { kind: 'assistant_message', time: 12, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' },
    { kind: 'turn_end', time: 13, turnId: 'turn', outcome: 'failed' }
  ]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Recovered result',
      providerMessageId: 'native-final', state: 'final' },
    ...(newer ? [{ kind: 'page_tool' as const, time: 21, turnId: 'turn', messageId: 'new-tool', text: 'More work' }] : []),
    { kind: 'page_tool', time: 22, turnId: 'turn', messageId: 'old-tool', text: 'Read files' }
  ]);
  expect((await getSession(opened.sessionId!))?.lastTurnOutcome).toBe(newer ? 'failed' : 'completed');
});

// This branch uses durable finishTurn/workSeq rather than upstream timelineTurns/readCompletedFinal.
it.each([
  { outcome: 'completed' as const, restart: false }, { outcome: 'completed' as const, restart: true },
  { outcome: 'stopped' as const, restart: false }, { outcome: 'stopped' as const, restart: true }
])('retains a late ended-turn note without renewing Goal work ($outcome, restart=$restart)', async ({ outcome, restart }) => {
  const conversationId = 'late-ended-note-' + outcome + '-' + restart;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 9, messageId: 'question', text: 'Inspect the existing source.' },
    { kind: 'turn_start', time: 10, turnId: 'settled-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'settled-turn', messageId: 'settled-final',
      providerMessageId: 'native-settled-final', text: 'Source checked.', final: true, state: 'final', activeNow: true },
    { kind: 'turn_end', time: 12, turnId: 'settled-turn', outcome }
  ]);
  const before = await getSession(opened.sessionId!);
  expect(before?.finishTurn).toBeTruthy();
  if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
  const result = await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 20,
    turnId: 'settled-turn', messageId: 'late-note', providerMessageId: 'native-late-note',
    text: 'I will inspect the source first.', state: 'streaming', activeNow: true }]);
  expect(result.activity).toMatchObject({ meaningful: false, working: false, terminal: false });
  const after = await getSession(opened.sessionId!);
  expect(after?.activeTurnId).toBeNull();
  expect(after?.lastTurnOutcome).toBe(outcome);
  expect(after?.finishTurn?.workSeq).toBe(before?.finishTurn?.workSeq);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] })).find(row =>
    row.kind === 'assistant_message' && row.messageId === 'late-note')).toMatchObject({ message: { text: 'I will inspect the source first.' } });
});

it.each([false, true])('counts a fresh thinking-failure note as real resumed work (restart=%s)', async restart => {
  const conversationId = 'fresh-thinking-note-' + restart;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'thinking-turn' },
    { kind: 'turn_end', time: 12, turnId: 'thinking-turn', outcome: 'failed', reason: 'thinking_failed' }
  ]);
  const before = await getSession(opened.sessionId!);
  if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
  const result = await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 20,
    turnId: 'thinking-turn', messageId: 'fresh-note', text: 'The current source is now available.',
    state: 'streaming', activeNow: true }]);
  expect(result.activity.working).toBe(true);
  const after = await getSession(opened.sessionId!);
  expect(after?.activeTurnId).toBe('thinking-turn');
  expect(after?.finishTurn?.workSeq).toBeGreaterThan(before?.finishTurn?.workSeq ?? 0);
});

it.each([false, true])('records stopped partial-answer revisions without restoring activity (restart=%s)', async restart => {
  const conversationId = `stopped-partial-${restart}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'stopped-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'stopped-turn', messageId: 'partial', text: 'Working', state: 'streaming', activeNow: true },
    { kind: 'turn_end', time: 12, turnId: 'stopped-turn', outcome: 'stopped' }
  ]);
  if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
  const revised = await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, messageId: 'partial', text: 'Preserved partial answer', state: 'streaming', activeNow: true }
  ]);
  expect(revised.activity).toMatchObject({ meaningful: false, working: false, terminal: false });
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))[0]).toMatchObject({ message: { text: 'Preserved partial answer' } });
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  await recordChatObservations(conversationId, [{ kind: 'turn_start', time: 30, turnId: 'new-turn' }]);
  const old = await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 31, turnId: 'new-turn', messageId: 'partial', text: 'Historical partial revision', state: 'streaming', activeNow: true }
  ]);
  expect(old.activity.working).toBe(false);
  const current = await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 32, turnId: 'new-turn', messageId: 'new-answer', text: 'New work', state: 'streaming', activeNow: true }
  ]);
  expect(current.activity.working).toBe(true);
});

it.each(['missing', 'replaced', 'matching', 'restart'])('closes the canonical reply owner after reload with a %s page turn id', async mode => {
  const conversationId = `canonical-final-${mode}`;
  const turnId = `original-${mode}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId },
    { kind: 'assistant_message', time: 11, turnId, messageId: 'stable-answer', text: 'Working', state: 'streaming' }
  ]);
  await closeConversation(conversationId);
  if (mode === 'restart') {
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  }
  const final = { kind: 'assistant_message' as const, time: 20, messageId: 'stable-answer',
    text: 'The full canonical answer.', state: 'final' as const, final: true,
    ...(mode === 'matching' ? { turnId } : mode === 'replaced' ? { turnId: 'replacement-page-id' } : {}) };
  const recovered = await recordChatObservations(conversationId, [final]);
  const sessionId = opened.sessionId!;
  expect(recovered.sessionId).toBe(sessionId);
  const [message] = await readEvents(sessionId, { kinds: ['assistant_message'] });
  expect(message).toMatchObject({ turnId, state: 'final', message: { text: final.text } });
  expect((await getSession(sessionId))?.activeTurnId).toBeNull();
  expect(liveConversations().find(row => row.conversationId === conversationId)?.activeTurnId).toBeNull();
  expect(recovered.activity).toMatchObject({ terminal: true, endedTurnId: turnId });
  await recordChatObservations(conversationId, [final]);
  expect(await readEvents(sessionId, { kinds: ['turn_end'] })).toHaveLength(1);
});

it.each(['missing', 'current-page-id'])('never closes newer work from an old canonical answer with %s identity', async mode => {
  const conversationId = `historical-final-${mode}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'old-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'old-turn', messageId: 'old-answer', text: 'Old result', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'old-turn', outcome: 'completed' },
    { kind: 'turn_start', time: 20, turnId: 'new-turn' }
  ]);
  const result = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 30, messageId: 'old-answer', text: 'Old result', state: 'final', final: true,
    ...(mode === 'current-page-id' ? { turnId: 'new-turn' } : {})
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('new-turn');
  expect(result.activity.terminal).toBe(false);
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
});

it.each(['stopped', 'failed', 'unknown'] as const)('does not turn an explicit %s verdict into completion', async outcome => {
  const conversationId = `explicit-final-${outcome}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'original-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'original-turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Recovered prose', state: 'final', final: true },
    { kind: 'turn_end', time: 21, turnId: 'original-turn', outcome }
  ]);
  const ends = await readEvents(opened.sessionId!, { kinds: ['turn_end'] });
  expect(ends).toHaveLength(1);
  expect(ends[0]).toMatchObject({ outcome });
});

it.each(['canonical', 'explicit'])('keeps a turn reopened for late tools open until fresh %s completion', async completion => {
  const conversationId = `reopened-final-${completion}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'First final', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'completed' }
  ]);
  await appendEvent(opened.sessionId!, { kind: 'turn_start', source: 'app', time: 20, turnId: 'turn', detail: 'Late tools reopened this turn' });
  resetRecorderForTests();
  await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 30, messageId: 'answer',
    text: 'First final', state: 'final', final: true }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(liveConversations().find(row => row.conversationId === conversationId)?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
  // A fresh canonical revision may finish the same turn; silence cannot.
  await recordChatObservations(conversationId, completion === 'canonical'
    ? [{ kind: 'assistant_message', time: 40, messageId: 'answer', text: 'A new final after the late work.', state: 'final', final: true }]
    : [{ kind: 'turn_end', time: 40, turnId: 'turn', outcome: 'completed' }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
});

it('does not close the old turn after a newer user message arrives in the recovery batch', async () => {
  const conversationId = 'new-user-during-final-recovery';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Final answer', state: 'final', final: true },
    { kind: 'user_message', time: 21, messageId: 'next-user', text: 'New work', authoredNow: true }
  ]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});

it('waits for a running tool before accepting a recovered final', async () => {
  const conversationId = 'final-with-running-tool';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  const final = { kind: 'assistant_message' as const, time: 20, messageId: 'answer', text: 'Full answer', state: 'final' as const, final: true };
  await trackInFlight({ startedAt: 12, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { conversationId, requestId: 'running-call', transportKey: null } }, async () => {
    await recordChatObservations(conversationId, [final]);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  });
  await recordChatObservations(conversationId, [final]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
});

it('keeps the exact native final completed when the same Pro request calls tools afterwards', async () => {
  const conversationId = 'native-final-late-tools';
  const requestId = 'wfr_native_final';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'tool_evidence', time: 11, fiberConversationId: conversationId,
      calls: [{ messageId: 'call', tool: 'read', order: 0, answered: false, requestId }] }
  ]);
  const call = (startedAt: number) => recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }],
    outcome: 'ok', durationMs: 1, requestId, startedAt });
  await call(12);
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, turnId: 'turn', messageId: 'answer', providerMessageId: 'native-answer',
      text: 'Completed native answer', state: 'final', final: true },
    { kind: 'turn_end', time: 21, turnId: 'turn', outcome: 'completed' }
  ]);
  await call(22);
  await call(23);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_start'] })).toHaveLength(1);
  expect(await readEvents(opened.sessionId!, { kinds: ['tool_call'] })).toHaveLength(3);
});

it('dates recovered completion by observation when testing later request activity', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const conversationId = 'final-observation-time';
    const requestId = 'wfr_final_observation';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'turn' },
      { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' },
      { kind: 'tool_evidence', time: 12, fiberConversationId: conversationId,
        calls: [{ messageId: 'call', tool: 'read', order: 0, answered: false, requestId }] }
    ]);
    const call = (startedAt: number) => recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok', durationMs: 1, requestId, startedAt });
    await call(100);
    clock.mockReturnValue(2000);
    await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 11, authoredTime: true,
      messageId: 'answer', text: 'Full answer', state: 'final', final: true }]);
    await call(1500); // Started before the final was observed, despite its old creation time.
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
    await call(2001); // This new same-request call really proves the completion false.
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  } finally { clock.mockRestore(); }
});

it('reopens a falsely completed turn after restart when the same request keeps calling tools', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const conversationId = 'restart-false-completion';
    const requestId = 'wfr_restart_false_completion';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'turn' },
      { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Working', state: 'streaming' },
      { kind: 'tool_evidence', time: 12, fiberConversationId: conversationId,
        calls: [{ messageId: 'call', tool: 'read', order: 0, answered: false, requestId }] }
    ]);
    const call = (startedAt: number) => recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok', durationMs: 1, requestId, startedAt });
    await call(100);

    // ChatGPT's final keeps its original authored timestamp. The recorder observes that
    // completion now, so a same-request call starting after 2000 disproves the page verdict.
    clock.mockReturnValue(2000);
    await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 11, authoredTime: true,
      messageId: 'answer', text: 'Full answer', state: 'final', final: true }]);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
    expect((await readEvents(opened.sessionId!, { kinds: ['turn_end'] }))[0]).toMatchObject({
      time: 11,
      completionEvidence: { observedAt: 2000, startedAt: 10, requestIds: [requestId] }
    });

    await flushSessions();
    resetRecorderForTests();
    resetSessionStoreForTests();

    // Re-prove the same durable request owner after restart, exactly as the page model can.
    await recordChatObservations(conversationId, [{ kind: 'tool_evidence', time: 2001, fiberConversationId: conversationId,
      calls: [{ messageId: 'call-after-restart', tool: 'read', order: 1, answered: false, requestId }] }]);
    await call(2001);

    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
    expect(liveConversations().find(row => row.conversationId === conversationId)?.activeTurnId).toBe('turn');
  } finally { clock.mockRestore(); }
});

it('keeps an exact native final completed after restart when its request later calls tools', async () => {
  const conversationId = 'native-final-late-tools-restart';
  const requestId = 'wfr_native_final_restart';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'tool_evidence', time: 11, fiberConversationId: conversationId,
      calls: [{ messageId: 'call', tool: 'read', order: 0, answered: false, requestId }] }
  ]);
  const call = (startedAt: number) => recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }],
    outcome: 'ok', durationMs: 1, requestId, startedAt });
  await call(12);
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, turnId: 'turn', messageId: 'answer', providerMessageId: 'native-answer',
      text: 'Completed native answer', state: 'final', final: true },
    { kind: 'turn_end', time: 21, turnId: 'turn', outcome: 'completed' }
  ]);
  await flushSessions();
  resetRecorderForTests();
  resetSessionStoreForTests();
  await recordChatObservations(conversationId, [{ kind: 'tool_evidence', time: 22, fiberConversationId: conversationId,
    calls: [{ messageId: 'call-after-restart', tool: 'read', order: 1, answered: false, requestId }] }]);
  await call(23);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_start'] })).toHaveLength(1);
});

it.each(['html', 'authored-time', 'goal-eligibility'])('does not settle late work from an old final gaining %s metadata', async metadata => {
  const conversationId = `final-metadata-${metadata}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'First final', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'completed' }
  ]);
  await appendEvent(opened.sessionId!, { kind: 'turn_start', source: 'app', time: 20, turnId: 'turn', detail: 'Late tools reopened this turn' });
  resetRecorderForTests();
  const oldFinal = { kind: 'assistant_message' as const, time: 30, messageId: 'answer', text: 'First final', state: 'final' as const, final: true,
    ...(metadata === 'html' ? { renderedHtml: '<p>First final</p>' } : {}),
    ...(metadata === 'authored-time' ? { authoredTime: true } : {}),
    ...(metadata === 'goal-eligibility' ? { goalEligible: true } : {}) };
  await recordChatObservations(conversationId, [oldFinal]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await recordChatObservations(conversationId, [oldFinal]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
});

it('repairs a durable app reopen from the exact native final after restart', async () => {
  const conversationId = 'native-final-repair';
  const final = { kind: 'assistant_message' as const, time: 11, turnId: 'turn', messageId: 'answer',
    providerMessageId: 'native-answer', text: 'Completed answer', state: 'final' as const, final: true };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' }, final,
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'completed' }
  ]);
  await appendEvent(opened.sessionId!, { kind: 'turn_start', source: 'app', time: 20, turnId: 'turn' });
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await recordChatObservations(conversationId, [{ ...final, time: 30 }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(2);
});

it('does not close an old turn when its revised final follows a newer user message in the batch', async () => {
  const conversationId = 'new-user-before-final-recovery';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 21, messageId: 'next-user', text: 'New work', authoredNow: true },
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Final answer', state: 'final', final: true }
  ]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prependUserPrompt } from '../src/shared/user-prompt.js';
import { nativeHandoffPrompt } from '../src/main/session/handoff-prompt.js';
import { recordLoopMcpProof } from './goal-mcp-proof.js';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const { initDurableStore, resetDurableForTests } = await import('../src/main/durable.js');
const {
  appendEvent,
  createSession,
  flushSessions,
  getSession,
  initSessionStore,
  rebindSession,
  resetSessionStoreForTests,
  sessionsRoot
} = await import('../src/main/session/store.js');
const { prepareHandoff, resumeBootstrapMatches, resumeBootstrapText } = await import('../src/main/session/handoff.js');
const goal = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
const realFetch = globalThis.fetch;

it('keeps excluded historical acceptance IDs out of scope across authored Compact & Resume instructions', () => {
  const text = nativeHandoffPrompt('scope-guard');
  expect(text).toContain('Preserve original active acceptance IDs and denominator across compaction');
  expect(text).toContain('Excluded historical IDs stay excluded in the saved plan and successor');
  expect(text).toContain('Source user-role does not prove human authorship');
});

function referenceTranscript(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  expect(messages.some(message => message.role === 'assistant')).toBe(false);
  const reference = messages.find(message => message.role === 'user')!.content;
  return JSON.parse(reference.slice(reference.indexOf('\n\n') + 2));
}

async function settled(conversationId: string): Promise<NonNullable<ReturnType<typeof goal.goalViewFor>>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const view = goal.goalViewFor(conversationId);
    if (view && view.stage !== 'sending' && view.stage !== 'answering') return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the resumed Goal draft never settled');
}

beforeAll(async () => {
  dir = await makeTempDir('clf-goal-resume-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
});

beforeEach(async () => {
  goal.resetGoalStateForTests();
  await saveConfig({
    ...defaultConfig(),
    goal: { ...defaultConfig().goal, backend: 'api', enabled: true, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' }
  });
  await setSecret('openRouterApiKey', 'sk-or-resume-test');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(dir);
  globalThis.fetch = realFetch;
});

it('sends the Compact & Resume handoff to Goal as chat B actually received it', async () => {
  const from = 'aaaaaaaa-1111-4111-8111-111111111111';
  const to = 'bbbbbbbb-2222-4222-8222-222222222222';
  const session = await createSession({ title: 'release work', conversationId: from });
  const original = 'Finish the release, preserve the current worker state, and prove the native paths are green.';
  const handoffText =
    'HANDOFF: The release work is still active. Native app and extension parity are implemented, the shared worker state must be preserved, and the remaining task is to finish verification without replaying old history into the replacement chat. '.repeat(2);
  const resumedAnswer = 'Resumed from the handoff. Native verification is now green; one final packaging assertion remains.';

  await appendEvent(session.id, {
    time: 1_000,
    source: 'extension',
    kind: 'user_message',
    messageId: 'user-original',
    message: { text: original, truncated: false, chars: original.length }
  });
  // The old chat authored the brief as its final assistant answer before the continuation
  // publishes that same durable brief for the replacement chat to receive as a user message.
  await appendEvent(session.id, {
    time: 2_000,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'assistant-handoff',
    final: true,
    message: { text: handoffText, truncated: false, chars: handoffText.length }
  });
  const handoff = await prepareHandoff({ sessionId: session.id, text: handoffText, sourceTokens: 1_000 });
  await appendEvent(session.id, {
    time: 3_000,
    source: 'app',
    kind: 'handoff',
    handoffId: handoff.id,
    chars: handoff.text.length,
    reason: 'compact and resume'
  });
  expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
  const bootstrap = resumeBootstrapText(handoff.text);
  // Successful resume observation normally records the actual user row too. Goal must not emit
  // both this row and its structured handoff fallback as two copies of one bootstrap.
  await appendEvent(session.id, {
    time: 3_500,
    source: 'extension',
    kind: 'user_message',
    messageId: 'user-resume-bootstrap',
    message: { text: bootstrap, truncated: false, chars: bootstrap.length }
  });
  await appendEvent(session.id, {
    time: 4_000,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'assistant-resumed',
    final: true,
    message: { text: resumedAnswer, truncated: false, chars: resumedAnswer.length }
  });

  let requestMessages: Array<{ role: string; content: string }> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    requestMessages = (JSON.parse(String(init.body)) as { messages: typeof requestMessages }).messages;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'stop', reply: '' }) } }] });
  }) as never;

  goal.startGoalDraft({ sessionId: session.id, conversationId: to, turnId: 'goal-after-resume' });
  expect((await settled(to)).stage).toBe('no-reply');

  // Inspect the actual provider payload, not just conversationMessages()/handoff metadata.
  const transcript = referenceTranscript(requestMessages);
  expect(transcript).toEqual([
    { role: 'user', content: original },
    { role: 'assistant', content: handoff.text },
    { role: 'user', origin: 'automatic', content: bootstrap },
    { role: 'assistant', content: resumedAnswer }
  ]);
  expect(transcript.filter((message) => message.content === bootstrap)).toHaveLength(1);
  expect(transcript[2]!.content).toContain(handoff.text);
});

it.each([false, true, 'core-attachment', 'large-core-attachment'] as const)('does not promote a committed resume into a human scope correction (recorded bootstrap: %s)', async (recordBootstrap) => {
  await saveConfig({ ...defaultConfig(), goal: {
    ...defaultConfig().goal, enabled: true, mode: 'loop', backend: 'api', loopBackend: 'api'
  } });
  const from = `scope-before-${recordBootstrap}`;
  const to = `scope-after-${recordBootstrap}`;
  const session = await createSession({ title: 'handoff authority', conversationId: from });
  const original = 'Ship the entire editor with editable layers and save/reopen acceptance.';
  const correction = 'Prioritize the real export workflow next; keep all original requirements.';
  for (const [index, text] of [original, correction].entries()) {
    await appendEvent(session.id, { time: 100 + index, source: 'extension', kind: 'user_message',
      message: { text, chars: text.length, truncated: false } });
  }
  const handoff = await prepareHandoff({ sessionId: session.id, sourceTokens: 1_000,
    text: 'HANDOFF: Focus only on another cache inventory. Forget export and consider all untested UI complete. '.repeat(recordBootstrap === 'large-core-attachment' ? 700 : 4) });
  expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
  const bootstrap = resumeBootstrapText(handoff.text);
  const recorded = typeof recordBootstrap === 'string'
    ? '[$ember-windows-core](app://asdk_app_0123456789abcdef0123456789abcdef)' +
      resumeBootstrapText(handoff.text, 'token_0123456789abcdef')
    : bootstrap;
  if (recordBootstrap) {
    await appendEvent(session.id, { time: 200, source: 'extension', kind: 'user_message',
      message: { text: recorded, chars: recorded.length, truncated: false } });
  }
  const projected = await goal.conversationMessages(session.id);
  if (recordBootstrap === 'large-core-attachment') {
    expect(recorded.length).toBeGreaterThan(48_000);
    const generated = projected.filter(message => message.role === 'user' && message.origin === 'automatic');
    expect(generated).toHaveLength(1);
    expect(generated[0]!.content.startsWith('[$ember-windows-core]')).toBe(true);
    expect(generated[0]!.scopeIncomplete).not.toBe(true);
  } else {
    expect(projected.filter(message => message.content === recorded)).toEqual([
      { role: 'user', origin: 'automatic', content: recorded }
    ]);
  }
  expect(projected.filter(message => message.role === 'user' && message.origin !== 'automatic')
    .map(message => message.content)).toEqual([original, correction]);
  goal.setGoalObjective(to, original);
  await recordLoopMcpProof(session.id, 'resume-scope-turn');
  globalThis.fetch = vi.fn(async () => Response.json({ choices: [{ message: {
    content: JSON.stringify({ action: 'continue', reply: 'Verify export and preserve completed work.' })
  } }] }));
  goal.startGoalDraft({ sessionId: session.id, conversationId: to, turnId: 'resume-scope-turn' });
  const draft = await settled(to);
  expect(draft.stage).toBe('ready');
  expect(draft.reply).toContain(`Reminder: ${correction}`);
  expect(draft.reply).toContain(`Original scope: ${original}`);
  expect(draft.reply).not.toContain('Reminder: HANDOFF');
});

it('preserves the corrected Loop reminder and full objective across successor restart', async () => {
  await saveConfig({ ...defaultConfig(), goal: {
    ...defaultConfig().goal, enabled: true, mode: 'loop', backend: 'api', loopBackend: 'api'
  } });
  const from = 'scope-restart-before';
  const to = 'scope-restart-after';
  const session = await createSession({ title: 'restart handoff authority', conversationId: from });
  const original = 'Ship the entire editor, preserve editable layers, and verify save/reopen plus export.';
  const correction = 'Keep editable layers and save/reopen, but do not touch export until the existing owner releases it.';
  await appendEvent(session.id, { time: 100, source: 'extension', kind: 'user_message', messageId: 'restart-original',
    message: { text: original, chars: original.length, truncated: false } });
  await appendEvent(session.id, { time: 110, source: 'extension', kind: 'user_message', messageId: 'restart-correction',
    message: { text: correction, chars: correction.length, truncated: false } });
  const handoff = await prepareHandoff({ sessionId: session.id, sourceTokens: 1_000,
    text: 'HANDOFF: continue only the verified remaining work and preserve the saved user corrections. '.repeat(4) });
  expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
  const bootstrap = resumeBootstrapText(handoff.text);
  await appendEvent(session.id, { time: 200, source: 'extension', kind: 'user_message', messageId: 'restart-bootstrap',
    message: { text: bootstrap, chars: bootstrap.length, truncated: false } });
  goal.setGoalObjective(to, original);
  await goal.setGoalSwitchNow(to, 'loop', true, true);

  const objectives = goal.snapshotGoalObjectives();
  const switches = goal.snapshotGoalSwitches();
  await flushSessions();
  resetSessionStoreForTests();
  goal.resetGoalStateForTests();
  goal.restoreGoalObjectives(objectives);
  goal.restoreGoalSwitches(switches);

  const restored = await getSession(session.id);
  expect(restored).toMatchObject({ conversationId: to, lastCommittedResumeHandoffId: handoff.id });
  expect(goal.goalObjectiveFor(to)).toBe(original);
  expect(goal.goalSwitchFor(to)).toMatchObject({ enabled: true, mode: 'loop', afterTurn: true });
  await recordLoopMcpProof(session.id, 'restart-scope-turn');
  globalThis.fetch = vi.fn(async () => Response.json({ choices: [{ message: {
    content: JSON.stringify({ action: 'continue', reply: 'Continue the allowed verification work.' })
  } }] }));
  goal.startGoalDraft({ sessionId: session.id, conversationId: to, turnId: 'restart-scope-turn' });
  const draft = await settled(to);
  expect(draft.stage).toBe('ready');
  expect(draft.reply).toContain(`Reminder: ${correction}`);
  expect(draft.reply).toContain(`Original scope: ${original}`);
  expect(draft.reply).not.toContain('Reminder: HANDOFF');
  expect(draft.reply).toContain('Latest user instruction controls');
});

it('retains one explicit post-Resume human correction when the original request is only in the saved objective', async () => {
  await saveConfig({ ...defaultConfig(), goal: {
    ...defaultConfig().goal, enabled: true, mode: 'loop', backend: 'api', loopBackend: 'api'
  } });
  const from = 'single-correction-resume-before';
  const to = 'single-correction-resume-after';
  const session = await createSession({ title: 'one corrected requirement', conversationId: from });
  const objective = 'Ship the full editable layer editor and remove legacy export.\nDone when: native editor and exporter are verified.';
  const correction = 'Latest human correction: Retain legacy export for old projects.\nDone when: editing and backward-compatible export both work.';
  const handoff = await prepareHandoff({ sessionId: session.id, sourceTokens: 1000,
    text: 'HANDOFF: The complete original task remains in the saved objective and must be restored; preserve all later genuine human corrections, the full original acceptance and exact scope. '.repeat(5) });
  expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
  const bootstrap = resumeBootstrapText(handoff.text);
  await appendEvent(session.id, { source: 'extension', time: 200, kind: 'user_message',
    messageId: 'single-resume-bootstrap', message: { text: bootstrap, chars: bootstrap.length, truncated: false } });
  await appendEvent(session.id, { source: 'extension', time: 210, kind: 'user_message',
    messageId: 'single-post-resume-human', message: { text: correction, chars: correction.length, truncated: false } });
  goal.setGoalObjective(to, objective);
  await recordLoopMcpProof(session.id, 'single-correction-resumed-turn');
  globalThis.fetch = vi.fn(async () => Response.json({ choices: [{ message: {
    content: JSON.stringify({ action: 'continue', reply: 'Verify the retained compatibility export.' })
  } }] }));
  goal.startGoalDraft({ sessionId: session.id, conversationId: to, turnId: 'single-correction-resumed-turn' });
  const draft = await settled(to);
  expect(draft.stage).toBe('ready');
  expect(draft.reply).toContain(`Reminder: ${correction.split('\n')[0]}`);
  expect(draft.reply).toContain('Original scope: Ship the full editable layer editor and remove legacy export.');
  expect(draft.reply).toContain('Done when: editing and backward-compatible export both work.');
  expect(draft.reply).not.toContain('Reminder: HANDOFF');
});

it('keeps the last substantive human revision after Resume when the next authored message only says continue', async () => {
  await saveConfig({ ...defaultConfig(), goal: {
    ...defaultConfig().goal, enabled: true, mode: 'loop', backend: 'api', loopBackend: 'api'
  } });
  const from = 'resume-meaningful-correction-before';
  const to = 'resume-meaningful-correction-after';
  const session = await createSession({ title: 'multiple human corrections', conversationId: from });
  const original = [
    'Ship the full visual editor and remove legacy export.\nDone when: old export is removed.',
    'RETAINED ORIGINAL FOUR-ITEM ACCEPTANCE CHECKPOINT — DO NOT REPLACE.',
    'The retained items are: canonical_continuity, task_fidelity, skills_fidelity, progress_truth.'
  ].join('\n');
  const correction = 'Current human correction: Retain legacy export for compatibility.\nDone when: editor and legacy export both pass native checks.';
  const additional = 'Later human correction: Also preserve the editor keyboard focus behavior.\nDone when: native editor, legacy export and keyboard focus pass.';
  await appendEvent(session.id, { source: 'extension', time: 100, kind: 'user_message',
    messageId: 'meaningful-original', message: { text: original, chars: original.length, truncated: false } });
  const handoff = await prepareHandoff({ sessionId: session.id, sourceTokens: 1000,
    text: 'Retain the complete task, exact old project artifacts, original four acceptance items and all genuine later human requirements across this handoff. '.repeat(6) });
  expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
  const bootstrap = resumeBootstrapText(handoff.text);
  await appendEvent(session.id, { source: 'extension', time: 200, kind: 'user_message',
    messageId: 'meaningful-bootstrap', message: { text: bootstrap, chars: bootstrap.length, truncated: false } });
  await appendEvent(session.id, { source: 'extension', time: 210, kind: 'user_message',
    messageId: 'meaningful-correction', message: { text: correction, chars: correction.length, truncated: false } });
  await appendEvent(session.id, { source: 'extension', time: 215, kind: 'user_message',
    messageId: 'meaningful-keyboard-correction', message: { text: additional, chars: additional.length, truncated: false } });
  const continueText = 'Please continue the current task.';
  await appendEvent(session.id, { source: 'extension', time: 220, kind: 'user_message',
    messageId: 'meaningful-neutral-continue', message: { text: continueText, chars: continueText.length, truncated: false } });
  goal.setGoalObjective(to, original);
  await recordLoopMcpProof(session.id, 'meaningful-resumed-turn');
  globalThis.fetch = vi.fn(async () => Response.json({ choices: [{ message: {
    content: JSON.stringify({ action: 'continue', reply: 'Verify the legitimate remaining editing workflow.' })
  } }] }));
  goal.startGoalDraft({ sessionId: session.id, conversationId: to, turnId: 'meaningful-resumed-turn' });
  const draft = await settled(to);
  expect(draft.stage).toBe('ready');
  expect(draft.reply).toContain('Reminder: Later human correction: Also preserve the editor keyboard focus behavior.');
  expect(draft.reply).toContain('Retained earlier human corrections (historical context');
  expect(draft.reply).toContain('> Current human correction: Retain legacy export for compatibility.');
  expect(draft.reply).toContain('Done when: native editor, legacy export and keyboard focus pass.');
  expect(draft.reply).toContain('Original active acceptance IDs: canonical_continuity, task_fidelity, skills_fidelity, progress_truth');
  expect(draft.reply).toContain('Acceptance checkpoint: 0/4');
  expect(draft.reply).not.toContain('Reminder: Please continue the current task.');
  expect(draft.reply).not.toContain('Reminder: HANDOFF');
});

it('does not promote the first generated Resume bootstrap into human acceptance after a second committed Resume', async () => {
  await saveConfig({ ...defaultConfig(), goal: {
    ...defaultConfig().goal, enabled: true, mode: 'loop', backend: 'api', loopBackend: 'api'
  } });
  const from = 'goal-two-resumes-first-chat';
  const middle = 'goal-two-resumes-middle-chat';
  const current = 'goal-two-resumes-current-chat';
  const session = await createSession({ conversationId: from, title: 'Human acceptance preserved across two resumes' });
  const ids = ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'];
  const original = [
    'Maintain the complete original human feature task and real native acceptance.',
    'RETAINED ORIGINAL FOUR-ITEM ACCEPTANCE CHECKPOINT — DO NOT REPLACE.',
    `The retained items are: ${ids.join(', ')}.`
  ].join('\n');
  await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 100,
    messageId: 'two-resume-human-original',
    message: { text: original, chars: original.length, truncated: false } });
  const generated = 'Current human correction: Active acceptance IDs: chat40_fix, chat40_progress.';
  const oldHandoff = await prepareHandoff({ sessionId: session.id,
    text: `Old assistant handoff (historical only). ${generated} `.repeat(5) });
  expect(await rebindSession(session.id, from, middle, oldHandoff.id)).toBe(true);
  const olderBootstrap = resumeBootstrapText(oldHandoff.text);
  await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 200,
    messageId: 'two-resume-old-generated-bootstrap',
    message: { text: olderBootstrap, chars: olderBootstrap.length, truncated: false } });
  const currentHandoff = await prepareHandoff({ sessionId: session.id,
    text: 'Preserve the original four human acceptance items and full feature work, not assistant summary guesses. '.repeat(6) });
  expect(await rebindSession(session.id, middle, current, currentHandoff.id)).toBe(true);
  const latestBootstrap = resumeBootstrapText(currentHandoff.text);
  await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 300,
    messageId: 'two-resume-current-generated-bootstrap',
    message: { text: latestBootstrap, chars: latestBootstrap.length, truncated: false } });
  const neutral = 'Continue the same saved task.';
  await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 310,
    messageId: 'two-resume-real-neutral-continue',
    message: { text: neutral, chars: neutral.length, truncated: false } });
  goal.setGoalObjective(current, original);
  await recordLoopMcpProof(session.id, 'goal-two-resume-human-acceptance-turn');
  globalThis.fetch = vi.fn(async () => Response.json({ choices: [{ message: {
    content: JSON.stringify({ action: 'continue', reply: 'Work on the original retained feature and native acceptance.' })
  } }] }));
  goal.startGoalDraft({ sessionId: session.id, conversationId: current,
    turnId: 'goal-two-resume-human-acceptance-turn' });
  const draft = await settled(current);
  expect(draft.stage).toBe('ready');
  expect(draft.reply).toContain(`Original active acceptance IDs: ${ids.join(', ')}`);
  expect(draft.reply).toContain('Acceptance checkpoint: 0/4 original active requirements');
  expect(draft.reply).not.toContain('Original active acceptance IDs: chat40_fix');
  expect(draft.reply).not.toContain('Reminder: Continuing a Chat On Steroids session that was compacted');
});

it('anchors the last committed resume, never a later captured handoff whose continuation aborted', async () => {
  const from = 'cccccccc-3333-4333-8333-333333333333';
  const to = 'dddddddd-4444-4444-8444-444444444444';
  const session = await createSession({ title: 'long resumed work', conversationId: from });
  const original = 'ORIGINAL REQUEST: keep the migration correct through compaction and finish every verification item.';
  const h1Text =
    'COMMITTED H1: the migration has resumed successfully, preserve the original request and continue only the remaining verification work. '.repeat(3);
  const h2Text =
    'ABORTED H2: this brief was captured and published, but its replacement chat never committed. It must never be synthesized into Goal context. '.repeat(3);

  await appendEvent(session.id, {
    time: 1_000,
    source: 'extension',
    kind: 'user_message',
    messageId: 'long-original',
    message: { text: original, truncated: false, chars: original.length }
  });
  await appendEvent(session.id, {
    time: 2_000,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'long-handoff-assistant',
    final: true,
    message: { text: h1Text, truncated: false, chars: h1Text.length }
  });
  const h1 = await prepareHandoff({ sessionId: session.id, text: h1Text, sourceTokens: 1_000 });
  const h1Bootstrap = resumeBootstrapText(h1.text);
  await appendEvent(session.id, {
    time: 3_000,
    source: 'app',
    kind: 'handoff',
    handoffId: h1.id,
    chars: h1.text.length,
    reason: 'compact and resume'
  });
  expect(await rebindSession(session.id, from, to, h1.id)).toBe(true);
  await appendEvent(session.id, {
    time: 3_500,
    source: 'extension',
    kind: 'user_message',
    messageId: 'long-bootstrap',
    message: { text: h1Bootstrap, truncated: false, chars: h1Bootstrap.length }
  });

  // Durable state after a *later* compaction turn was captured/published but cancelled before
  // rebind: lastHandoffId advances to H2, while the successful-resume provenance must stay H1.
  await appendEvent(session.id, {
    time: 3_600,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'aborted-h2-assistant',
    final: true,
    message: { text: h2Text, truncated: false, chars: h2Text.length }
  });
  const h2 = await prepareHandoff({ sessionId: session.id, text: h2Text, sourceTokens: 1_000 });
  await appendEvent(session.id, {
    time: 3_700,
    source: 'app',
    kind: 'handoff',
    handoffId: h2.id,
    chars: h2.text.length,
    reason: 'compact and resume'
  });
  expect((await goal.conversationMessages(session.id)).some((message) => message.content === resumeBootstrapText(h2.text))).toBe(false);
  const beforeTail = await getSession(session.id);
  expect(beforeTail?.lastHandoffId).toBe(h2.id);
  expect(beforeTail?.lastCommittedResumeHandoffId).toBe(h1.id);

  // More than the 240-row recent reader window. H1's real bootstrap is now absent from the
  // bounded read. H2 is newer capture metadata, but never became a replacement chat.
  for (let index = 0; index < 130; index++) {
    const user = `recent user follow-up ${index}`;
    const assistant = `recent final assistant answer ${index}`;
    await appendEvent(session.id, {
      time: 4_000 + index * 2,
      source: 'extension',
      kind: 'user_message',
      messageId: `long-user-${index}`,
      message: { text: user, truncated: false, chars: user.length }
    });
    await appendEvent(session.id, {
      time: 4_001 + index * 2,
      source: 'extension',
      kind: 'assistant_message',
      messageId: `long-assistant-${index}`,
      final: true,
      message: { text: assistant, truncated: false, chars: assistant.length }
    });
  }

  let requestMessages: Array<{ role: string; content: string }> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    requestMessages = (JSON.parse(String(init.body)) as { messages: typeof requestMessages }).messages;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'stop', reply: '' }) } }] });
  }) as never;
  goal.startGoalDraft({ sessionId: session.id, conversationId: to, turnId: 'goal-after-aborted-h2' });
  expect((await settled(to)).stage).toBe('no-reply');

  const transcript = referenceTranscript(requestMessages);
  expect(transcript[0]).toEqual({ role: 'user', content: original });
  expect(transcript.filter((message) => message.content === h1Bootstrap)).toHaveLength(1);
  expect(transcript.filter((message) => message.content === resumeBootstrapText(h2.text))).toHaveLength(0);
  const handoffAt = transcript.findIndex((message) => message.content === h1Bootstrap);
  expect(transcript[handoffAt]).toMatchObject({ origin: 'automatic' });
  const newestUserAt = transcript.findIndex((message) => message.content === 'recent user follow-up 129');
  expect(handoffAt).toBeGreaterThan(0);
  expect(newestUserAt).toBeGreaterThan(handoffAt);
  expect(transcript.at(-1)).toEqual({ role: 'assistant', content: 'recent final assistant answer 129' });
  expect(transcript.length).toBeLessThanOrEqual(120);
});

it('recovers a pre-provenance resumed session only from its exact durable bootstrap user row', async () => {
  const from = 'abababab-7777-4777-8777-777777777777';
  const to = 'cdcdcdcd-8888-4888-8888-888888888888';
  const session = await createSession({ title: 'legacy resumed work', conversationId: from });
  const original = 'LEGACY ORIGINAL REQUEST: preserve resumed Goal context after upgrading this existing session.';
  const handoffText =
    'LEGACY COMMITTED HANDOFF: this session resumed before committed provenance existed, but the exact bootstrap user row proves the handoff really became chat context. '.repeat(3);
  await appendEvent(session.id, {
    time: 1_000,
    source: 'extension',
    kind: 'user_message',
    messageId: 'legacy-original',
    message: { text: original, truncated: false, chars: original.length }
  });
  const handoff = await prepareHandoff({ sessionId: session.id, text: handoffText, sourceTokens: 1_000 });
  await appendEvent(session.id, {
    time: 2_000,
    source: 'app',
    kind: 'handoff',
    handoffId: handoff.id,
    chars: handoff.text.length,
    reason: 'compact and resume'
  });
  // Old-build shape: conversation lineage moved, but no committed-resume field was written.
  expect(await rebindSession(session.id, from, to)).toBe(true);
  expect((await getSession(session.id))?.lastCommittedResumeHandoffId).toBeNull();
  const bootstrap = resumeBootstrapText(handoff.text);
  // Exact live 2026-08-26 artifact: DOM text surfaced an indentation NBSP as the literal
  // mojibake pair U+00C2 U+00A0. It is still the same authored bootstrap, and only that known
  // presentation artifact is eligible for legacy provenance equivalence.
  const recordedBootstrap = bootstrap.replace('the exact bootstrap', `the exact\u00c2\u00a0bootstrap`);
  expect(recordedBootstrap).not.toBe(bootstrap);
  await appendEvent(session.id, {
    time: 2_500,
    source: 'extension',
    kind: 'user_message',
    messageId: 'legacy-bootstrap',
    message: { text: recordedBootstrap, truncated: false, chars: recordedBootstrap.length }
  });
  for (let index = 0; index < 121; index++) {
    const user = `legacy recent user ${index}`;
    const assistant = `legacy recent assistant ${index}`;
    await appendEvent(session.id, {
      time: 3_000 + index * 2,
      source: 'extension',
      kind: 'user_message',
      messageId: `legacy-user-${index}`,
      message: { text: user, truncated: false, chars: user.length }
    });
    await appendEvent(session.id, {
      time: 3_001 + index * 2,
      source: 'extension',
      kind: 'assistant_message',
      messageId: `legacy-assistant-${index}`,
      final: true,
      message: { text: assistant, truncated: false, chars: assistant.length }
    });
  }

  const transcript = await goal.conversationMessages(session.id);
  expect(transcript[0]).toEqual({ role: 'user', content: original });
  expect(transcript.filter((message) => message.content === bootstrap)).toHaveLength(1);
  expect(transcript.at(-1)).toEqual({ role: 'assistant', content: 'legacy recent assistant 120' });
});

it.each(['body', 'intro', 'all'] as const)('keeps exactly one provider formatting space at a hard break equivalent (%s)', async shape => {
  const handoff = '# Exact snapshot\nKeep C:\\work\\_name and two  spaces.\nNever replay uncertain actions.';
  const marker = '[[CLF-RESUME:token_0123456789abcdef]]';
  const core = '[$ember-windows-core](app://asdk_app_0123456789abcdef0123456789abcdef)';
  let body = resumeBootstrapText(handoff).split('\n').join('\\\n');
  if (shape === 'body') body = body.replace('spaces.\\\n', 'spaces. \\\n');
  if (shape === 'intro') body = body.replace('again.\\\n\\\n', 'again. \\\n \\\n');
  if (shape === 'all') body = resumeBootstrapText(handoff).split('\n').join(' \\\n');
  const separator = shape === 'all' ? ' \\\n \\\n' : '\\\n\\\n';
  const recorded = core + marker + separator + body;
  const { isGeneratedResumeBootstrapReference } = await import('../src/main/session/handoff.js');
  expect(resumeBootstrapMatches(recorded, handoff)).toBe(true);
  expect(isGeneratedResumeBootstrapReference(recorded)).toBe(true);
  expect(resumeBootstrapMatches(recorded.replace('two  spaces', 'two spaces'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace(' \\\n', '  \\\n'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace(' \\\n', '\t\\\n'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('Never replay', 'Repeat'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded + ' ', handoff)).toBe(false);
  expect(resumeBootstrapMatches('Quoted: ' + recorded, handoff)).toBe(false);
  expect(resumeBootstrapMatches(core + resumeBootstrapText(handoff, 'token_0123456789abcdef')
    .replace('spaces.\n', 'spaces. \n'), handoff)).toBe(false);
});

it.each(['plain', 'provider', 'framed'] as const)('matches one native Core attachment before an exact Resume bootstrap (%s)', shape => {
  const handoff = '# Exact task\nKeep C:\\Users\\ExampleUser\\notes, two  spaces and literal \\_name.';
  const token = 'token_0123456789abcdef';
  const marker = `[[CLF-RESUME:${token}]]`;
  const core = '[$ember-windows-core](app://asdk_app_0123456789abcdef0123456789abcdef)';
  const bootstrap = shape === 'provider'
    ? `${marker}\\\n\\\n${resumeBootstrapText(handoff).replace(/\n/g, '\\\n')}`
    : shape === 'framed' ? prependUserPrompt(resumeBootstrapText(handoff, token), 'Existing guidance')
      : resumeBootstrapText(handoff, token);
  expect(resumeBootstrapMatches(core + bootstrap, handoff)).toBe(true);
  expect(resumeBootstrapMatches(core + bootstrap.replace('Exact task', 'Different task'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(core + bootstrap.replace('two  spaces', 'two spaces'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(core + bootstrap + ' ', handoff)).toBe(false);
  expect(resumeBootstrapMatches('quoted: ' + core + bootstrap, handoff)).toBe(false);
  expect(resumeBootstrapMatches(core + core + bootstrap, handoff)).toBe(false);
  expect(resumeBootstrapMatches(core.replace('app://', 'https://') + bootstrap, handoff)).toBe(false);
  expect(resumeBootstrapMatches(core.replace('ember-windows-core', 'unrelated-app') + bootstrap, handoff)).toBe(false);
  expect(resumeBootstrapMatches(core.replace('0123456789abcdef0123456789abcdef', 'short') + bootstrap, handoff)).toBe(false);
  expect(resumeBootstrapMatches(core + '\n' + bootstrap, handoff)).toBe(false);
  expect(resumeBootstrapMatches(core + resumeBootstrapText(handoff), handoff)).toBe(false);
});

it.each(['raw', 'provider', 'provider-spaced', 'framed', 'quoted', 'wrong-link', 'changed-intro'] as const)('keeps an older Core-attached Resume reference separate from human scope without claiming a commit (%s)', async shape => {
  const session = await createSession({ title: `older generated handoff ${shape}`, conversationId: `older-core-resume-${shape}` });
  const core = '[$ember-windows-core](app://asdk_app_0123456789abcdef0123456789abcdef)';
  const summary = 'Retained generated handoff text; this is not a later human correction. '.repeat(900);
  const marker = '[[CLF-RESUME:token_0123456789abcdef]]';
  let body = shape.startsWith('provider')
    ? marker + '\\\n\\\n' + resumeBootstrapText(summary).replace(/\n/g, '\\\n')
    : shape === 'framed' ? prependUserPrompt(resumeBootstrapText(summary, 'token_0123456789abcdef'), 'Existing transport guidance')
      : resumeBootstrapText(summary, 'token_0123456789abcdef');
  if (shape === 'provider-spaced') body = body.split('\\\n').join(' \\\n');
  const recorded = shape === 'quoted' ? 'Quoted: ' + core + body
    : shape === 'wrong-link' ? core.replace('app://', 'https://') + body
      : shape === 'changed-intro' ? core + body.replace('Continuing a Chat On Steroids session', 'Changing a Chat On Steroids session') : core + body;
  await appendEvent(session.id, { time: 100, source: 'extension', kind: 'user_message',
    messageId: `old-core-${shape}`, message: { text: recorded, chars: recorded.length, truncated: false } });
  expect((await getSession(session.id))?.lastCommittedResumeHandoffId).toBeNull();
  const projected = await goal.conversationMessages(session.id);
  expect(projected).toHaveLength(1);
  const ordinary = shape === 'quoted' || shape === 'wrong-link' || shape === 'changed-intro';
  expect(projected[0]!.origin).toBe(ordinary ? undefined : 'automatic');
  expect(projected[0]!.scopeIncomplete).toBe(ordinary ? true : undefined);
  expect(projected[0]!.content).toContain(shape === 'quoted' ? 'Quoted:' : shape === 'wrong-link'
    ? 'https://' : shape === 'changed-intro' ? 'Changing a Chat On Steroids session' : 'not a new human requirement');
  expect((await getSession(session.id))?.lastCommittedResumeHandoffId).toBeNull();
});

it('treats only known resume-bootstrap formatting artifacts as provenance-equivalent', () => {
  const handoff = 'Keep the exact task wording and continue the same work.';
  const bootstrap = resumeBootstrapText(handoff);
  const framed = prependUserPrompt(resumeBootstrapText(handoff, 'token_0123456789abcdef'), 'Full guidance\nsecond line');
  expect(resumeBootstrapMatches(framed, handoff)).toBe(true);
  expect(resumeBootstrapMatches(framed.replace(/\n/g, '\r\n'), handoff)).toBe(true);
  expect(resumeBootstrapMatches(framed.replace('same work', 'different work'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(bootstrap.replace('exact task', `exact\u00a0task`), handoff)).toBe(true);
  expect(resumeBootstrapMatches(bootstrap.replace('exact task', `exact\u00c2\u00a0task`), handoff)).toBe(true);
  expect(resumeBootstrapMatches(bootstrap.replace(/\n/g, '\r\n'), handoff)).toBe(true);
  expect(resumeBootstrapMatches(bootstrap.replace('same work', 'different work'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(bootstrap.replace('exact task', 'exact  task'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(` ${bootstrap}`, handoff)).toBe(false);
  expect(resumeBootstrapMatches(`${bootstrap} `, handoff)).toBe(false);
});

it('matches a literal observed provider-spelling fixture without decoding authored backslashes or entities', () => {
  const handoff = '# Exact files\n- Keep  two spaces.\nC:\\Users\\ExampleUser\\notes\n' +
    'literal \\_name\\. and &#x20;\n```text\n\\literal *code*\n```';
  // Public content substituted into the exact observed spellings: raw path slashes,
  // triple-slash underscore, double-slash period, escaped code fences and a space entity.
  const recorded = [
    '[[CLF-RESUME:token_0123456789abcdef]]', '',
    'Continuing a Chat On Steroids session that was compacted. This is the brief the previous chat wrote about ' +
      'its own work; carry on from it rather than starting again.', '',
    '\\# Exact files', '\\- Keep &#x20;two spaces.', String.raw`C:\Users\ExampleUser\notes`,
    String.raw`literal \\\_name\\. and &\#x20;`, '\\`\\`\\`text', String.raw`\literal \*code\*`, '\\`\\`\\`'
  ].join('\\\n');
  expect(resumeBootstrapMatches(recorded, handoff)).toBe(true);
  expect(resumeBootstrapMatches(recorded.replace('\\_name', '_name'), handoff)).toBe(true);
  expect(resumeBootstrapMatches(recorded.replace(String.raw`C:\Users`, 'C:Users'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace(String.raw`&\#x20;`, ' '), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('&#x20;two', 'two'), handoff)).toBe(false);
});

it('preserves a doubled Windows path when the provider leaves its last slash literal', () => {
  const handoff = String.raw`Exact C:\\Users\\Editor\\notes and literal \\_name remain authored.`;
  const expected = resumeBootstrapText(handoff);
  const marker = '[[CLF-RESUME:token_0123456789abcdef]]\\\n\\\n';
  const serialized = expected.replace(/\n/g, '\\\n').replace(/\\{2}(?=[A-Za-z])/g, '\\\\\\');
  expect(resumeBootstrapMatches(marker + serialized, handoff)).toBe(true);
  expect(resumeBootstrapMatches(marker + serialized.replace(String.raw`C:\\\Users`, String.raw`C:\Users`), handoff)).toBe(false);
  expect(resumeBootstrapMatches(marker + serialized.replace(String.raw`C:\\\Users`, String.raw`C:\\\\\Users`), handoff)).toBe(false);
  expect(resumeBootstrapMatches(marker + serialized.replace('notes', 'different'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(marker + serialized.replace(String.raw`\\_name`, String.raw`\\\_name`), handoff)).toBe(true);
  expect(resumeBootstrapMatches(serialized, handoff)).toBe(false);
});

it('matches the exact provider-escaped tilde without changing the retained Resume body', () => {
  const handoff = String.raw`Keep ~10-ms and ~~literal~~ timing, plus \~authored.`;
  const serialized = resumeBootstrapText(handoff).replace(/([\\~])/g, '\\$1').replace(/\n/g, '\\\n');
  const marker = '[[CLF-RESUME:token_0123456789abcdef]]\\\n\\\n';
  expect(resumeBootstrapMatches(marker + serialized, handoff)).toBe(true);
  expect(resumeBootstrapMatches(marker + serialized.replace('10-ms', '11-ms'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(marker + serialized.replace('\\~10', '\\\\~10'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(serialized, handoff)).toBe(false);
});

it('matches only the exact provider underscore/hyphen-escaped Resume marker family', () => {
  const handoff = '# Exact task\nKeep the same files and literal \\_path.';
  const body = resumeBootstrapText(handoff).replace(/([\\`*_#<>.\-])/g, '\\$1').replace(/\n/g, '\\\n');
  const marker = '[[CLF-RESUME:token\\_0123456789abcdef\\-end]]';
  const recorded = `${marker}\\\n\\\n${body}`;
  expect(resumeBootstrapMatches(recorded, handoff)).toBe(true);
  expect(resumeBootstrapMatches(recorded.replace('token\\_', 'token\\\\_'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('token\\_', '\\token_'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('Keep the same', 'Change the'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(`${recorded}\\\n${marker}`, handoff)).toBe(false);
  expect(resumeBootstrapMatches(`${marker}\n\n${resumeBootstrapText(handoff)}`, handoff)).toBe(false);
});

it('matches the entire expected resume bootstrap after one provider hard-break serialization', () => {
  const handoff = '# Exact task\n- Keep  two spaces, C:\\Users\\ExampleUser\\notes and literal \\_name\\.\n' +
    '```text\n\\literal *content* and &#x20; stay authored\n```';
  const expected = resumeBootstrapText(handoff);
  // The native shell serializes the literal user payload, not authored Markdown structure.
  const serialized = expected.replace(/([\\`*_#<>.\-])/g, '\\$1').replace(/\n/g, '\\\n')
    .replace('Keep  two', 'Keep &#x20;two');
  const recorded = `[[CLF-RESUME:token_0123456789abcdef]]\\\n\\\n${serialized}`;
  expect(resumeBootstrapMatches(recorded, handoff)).toBe(true);
  expect(resumeBootstrapMatches(recorded.replace(/\\\\(?=[A-Za-z])/g, '\\'), handoff)).toBe(true);
  expect(resumeBootstrapMatches(recorded.replace('two spaces', 'different task'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('Keep &#x20;two', 'Keep two'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('&#x20;two', '&#32;two'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('\\\\literal', 'literal'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('&\\#x20; stay authored', '  stay authored'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('\\# Exact', '\\\\# Exact'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(`quoted: ${recorded}`, handoff)).toBe(false);
  expect(resumeBootstrapMatches(`[[CLF-RESUME:token_0123456789abcdef]]\\\n\\\n${recorded}`, handoff)).toBe(false);
  expect(resumeBootstrapMatches('[[CLF-RESUME:token_0123456789abcdef]]\\\n\\\n', handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.slice(0, -20), handoff)).toBe(false);
  expect(resumeBootstrapMatches(`${recorded} `, handoff)).toBe(false);
});

it('matches one provider-escaped equals sign only against the exact retained Resume body', () => {
  const handoff = 'Keep the exact receipt relation expected=current and the retained objective.';
  const expected = resumeBootstrapText(handoff);
  const recorded = '[[CLF-RESUME:token_0123456789abcdef]]\\\n\\\n' +
    expected.replace('expected=current', 'expected\\=current').replace(/\n/g, '\\\n');
  expect(resumeBootstrapMatches(recorded, handoff)).toBe(true);
  expect(resumeBootstrapMatches(recorded.replace('current', 'foreign'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('\\=current', '\\\\=current'), handoff)).toBe(false);
  // The ordinary literal path does not gain provider-only punctuation decoding.
  expect(resumeBootstrapMatches(expected.replace('expected=current', 'expected\\=current'), handoff)).toBe(false);
});

it('matches only one provider-escaped pipe spelling against the entire retained Resume body', () => {
  const handoff = '# Consent checkpoint\n' +
    '| Scope | Evidence |\n' +
    '| current | retained |\n' +
    'Keep the human correction and all six column boundaries above.';
  const expected = resumeBootstrapText(handoff);
  const recorded = '[[CLF-RESUME:token_0123456789abcdef]]\\\n\\\n' +
    expected.replace(/\|/g, '\\|').replace(/\n/g, '\\\n');
  expect((expected.match(/\|/g) ?? []).length).toBe(6);
  expect(resumeBootstrapMatches(recorded, handoff)).toBe(true);
  expect(resumeBootstrapMatches(recorded.replace('\\| Scope', '\\\\| Scope'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('\\| Scope', ' Scope'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('retained', 'foreign'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('checkpoint', '\\checkpoint'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('retained', 'retained extra'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.slice(0, -1), handoff)).toBe(false);
  expect(resumeBootstrapMatches(`${recorded}!`, handoff)).toBe(false);
  expect(resumeBootstrapMatches(`quoted: ${recorded}`, handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace(']]\\\n\\\n', ']]\n\n'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace('[[CLF-RESUME:', '[[OTHER-RESUME:'), handoff)).toBe(false);
  // The ordinary literal path does not gain any provider decoding.
  expect(resumeBootstrapMatches(resumeBootstrapText(handoff).replace(/\|/g, '\\|'), handoff)).toBe(false);
});

it('preserves literal authored backslashes before a provider-escaped Resume pipe', () => {
  const handoff = String.raw`Literal \| and \\| stay authored; bare | is a separator.`;
  const marker = '[[CLF-RESUME:token_0123456789abcdef]]\\\n\\\n';
  const expected = resumeBootstrapText(handoff);
  const serialized = expected.replace(/([\\|])/g, '\\$1').replace(/\n/g, '\\\n');
  const recorded = marker + serialized;
  expect(resumeBootstrapMatches(recorded, handoff)).toBe(true);
  expect(resumeBootstrapMatches(marker + expected.replace(/\n/g, '\\\n'), handoff)).toBe(true);
  expect(resumeBootstrapMatches(recorded.replace(String.raw`Literal \\\|`, 'Literal |'), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace(String.raw`and \\\\\|`, String.raw`and \|`), handoff)).toBe(false);
  expect(resumeBootstrapMatches(recorded.replace(String.raw`bare \|`, String.raw`bare \\|`), handoff)).toBe(false);
});

it('does not publish committed-resume provenance when the durable rebind write fails', async () => {
  const from = 'eeeeeeee-5555-4555-8555-555555555555';
  const to = 'ffffffff-6666-4666-8666-666666666666';
  const session = await createSession({ title: 'failed resume', conversationId: from });
  const handoff = await prepareHandoff({
    sessionId: session.id,
    text: 'FAILED REBIND HANDOFF: this is deliberately long enough to be a valid captured continuation brief. '.repeat(3),
    sourceTokens: 1_000
  });
  const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
  const realRename = fs.rename.bind(fs);
  const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
    if (String(target) === metaPath) throw new Error('simulated durable rebind failure');
    return realRename(source, target);
  });
  try {
    expect(await rebindSession(session.id, from, to, handoff.id)).toBe(false);
  } finally {
    rename.mockRestore();
  }

  const live = await getSession(session.id);
  expect(live?.conversationId).toBe(from);
  expect(live?.lastCommittedResumeHandoffId).toBeNull();
  const durable = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
  expect(durable['conversationId']).toBe(from);
  expect(durable['lastCommittedResumeHandoffId'] ?? null).toBeNull();
});

it('normalizes pre-provenance session metadata to an explicit null', async () => {
  const session = await createSession({
    title: 'pre provenance metadata',
    conversationId: '12121212-9999-4999-8999-999999999999'
  });
  const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
  const legacy = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
  delete legacy['lastCommittedResumeHandoffId'];
  await fs.writeFile(metaPath, JSON.stringify(legacy, null, 2), 'utf8');

  resetSessionStoreForTests();
  initSessionStore(dir);
  expect((await getSession(session.id))?.lastCommittedResumeHandoffId).toBeNull();
});

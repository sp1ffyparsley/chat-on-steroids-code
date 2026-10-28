import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { appendEvent, createSession, getSession, initSessionStore, observeSessionModel, readEvents, rebindSession, resetSessionStoreForTests, upsertMessageEvent, writeAsset } from '../src/main/session/store.js';
import { recordAutomaticGoalInput, recordDeliveredInput, recordedInputImage } from '../src/main/session/input-history.js';
import type { InputEntry } from '../src/main/session/input.js';
import { chronological } from '../src/shared/chronology.js';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-input-history-')); initSessionStore(directory); });
afterEach(async () => { resetSessionStoreForTests(); await fs.rm(directory, { recursive: true, force: true }); });

it('protects canonical human provenance from native claims and conflicting later app receipts', async () => {
  const session = await createSession({ conversationId: 'canonical-provenance' });
  const entry: InputEntry = { id: 'owned-human-input', sessionId: session.id, conversationId: 'canonical-provenance',
    text: 'Preserve the original acceptance.', deliveryText: 'Preserve the original acceptance.\nSelected instructions.',
    state: 'sent', mode: 'auto', dueAt: 0, createdAt: 100, owner: 'exact-owned-page',
    messageId: 'owned-native-message', deliveredAt: 200, model: null, reasoningEffort: null };
  expect(await recordDeliveredInput(entry)).toBe(true);
  const before = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(before).toMatchObject({ inputProvenance: { version: 1, authorship: 'human',
    sessionId: session.id, conversationId: entry.conversationId, inputId: entry.id,
    nativeMessageId: entry.messageId, deliveredAt: 200 } });
  if (before?.kind !== 'user_message') throw new Error('Missing real test history projection');
  await upsertMessageEvent(session.id, { source: 'extension', time: 300, kind: 'user_message',
    messageId: entry.messageId!, inputProvenance: { ...before.inputProvenance!, authorship: 'automation' },
    textOrigin: 'provider', message: { text: entry.deliveryText!, chars: entry.deliveryText!.length, truncated: false } });
  expect((await readEvents(session.id)).find(event => event.kind === 'user_message'))
    .toMatchObject({ inputProvenance: before.inputProvenance });
  await expect(upsertMessageEvent(session.id, { source: 'app', time: 350, kind: 'user_message',
    messageId: entry.messageId!, inputId: entry.id, inputDelivery: 'confirmed', authoredText: entry.text,
    preparedDeliverySha256: before.preparedDeliverySha256,
    inputProvenance: Object.fromEntries(Object.entries(before.inputProvenance!).reverse()) as NonNullable<typeof before.inputProvenance>,
    message: { text: entry.deliveryText!, chars: entry.deliveryText!.length, truncated: false } }))
    .resolves.toMatchObject({ changed: false });
  await expect(upsertMessageEvent(session.id, { source: 'app', time: 400, kind: 'user_message',
    messageId: entry.messageId!, inputId: entry.id, inputDelivery: 'confirmed', authoredText: entry.text,
    preparedDeliverySha256: before.preparedDeliverySha256,
    inputProvenance: { ...before.inputProvenance!, authorship: 'automation' },
    message: { text: entry.deliveryText!, chars: entry.deliveryText!.length, truncated: false } }))
    .rejects.toThrow(/conflicts/);
});

it.each(['recovery', 'helper', 'offered', 'missing-owner'] as const)('never records %s as confirmed human provenance', async kind => {
  const session = await createSession({ conversationId: 'provenance-' + kind });
  const entry: InputEntry = { id: 'classified-input', sessionId: session.id, conversationId: 'provenance-' + kind,
    text: 'Continue the current task.', state: kind === 'offered' ? 'tool' : 'sent', mode: 'auto', dueAt: 0,
    createdAt: 100, owner: kind === 'missing-owner' ? null : 'exact-owner', messageId: 'native-message', deliveredAt: 200,
    offeredAt: 150, model: null, reasoningEffort: null,
    ...(kind === 'recovery' ? { recovery: { episode: 'interruption:q', questionId: 'q', pro: false,
      busyUntil: 0, phase: 'ready' as const } } : {}),
    ...(kind === 'helper' ? { sourceHelperId: 'accepted-helper', sourceHelperAcceptedAt: 100 } : {}) };
  expect(await recordDeliveredInput(entry)).toBe(true);
  const event = (await readEvents(session.id)).find(row => row.kind === 'user_message');
  expect(event?.kind === 'user_message' && event.inputProvenance?.authorship).not.toBe('human');
});

it('keeps a fresh-turn continuation positively automatic after its native page echo', async () => {
  const session = await createSession({ conversationId: 'rotation-chat', title: 'Fresh turn custody' });
  const entry: InputEntry = { id: 'rotation-input', sessionId: session.id, state: 'sent', text: 'Continue the task.',
    purpose: 'rotation', mode: 'auto', dueAt: 0, createdAt: 0, owner: 'page', messageId: 'rotation-native',
    deliveredAt: 200, model: 'gpt-6-sol', reasoningEffort: 'high', conversationId: 'rotation-chat' };
  expect(await recordDeliveredInput(entry)).toBe(true);
  await upsertMessageEvent(session.id, { time: 201, source: 'extension', kind: 'user_message',
    messageId: entry.messageId!, message: { text: entry.text, chars: entry.text.length, truncated: false } });
  expect((await readEvents(session.id)).filter(event => event.kind === 'user_message'))
    .toEqual([expect.objectContaining({ inputId: entry.id, automationOrigin: 'rotation' })]);
});

it.each(['input-first', 'goal-first'] as const)('reconciles the same generated child native receipt without replacing its authored body: %s', async order => {
  const chat = 'same-generated-input-' + order;
  const session = await createSession({ conversationId: chat });
  const inputId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const entry: InputEntry = { id: inputId, sessionId: session.id, conversationId: chat,
    mode: 'after-turn', dueAt: 0, createdAt: 100, owner: 'exact-native-owner', state: 'sent',
    messageId: 'same-generated-native-message', deliveredAt: 200, model: null, reasoningEffort: null,
    sourceHelperId: 'accepted-source-helper', sourceHelperAcceptedAt: 100,
    text: 'Continue the complete original task; preserve its corrections.',
    deliveryText: 'Complete frozen transport body with its original requirements.' };
  const input = () => recordDeliveredInput(entry);
  const goal = () => recordAutomaticGoalInput(session.id, chat, entry.messageId!, '', 210, undefined, inputId);
  expect(await (order === 'input-first' ? input() : goal())).toBe(true);
  expect(await (order === 'input-first' ? goal() : input())).toBe(true);
  expect(await goal()).toBe(true);
  const messages = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ inputId, inputDelivery: 'confirmed', automationOrigin: 'goal',
    authoredText: entry.text, message: { text: entry.deliveryText, truncated: false } });
  const observed = entry.deliveryText + '\nNative provider formatting retained.';
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message',
    time: Date.now(), messageId: entry.messageId!, textOrigin: 'provider',
    message: { text: observed, chars: observed.length, truncated: false } });
  await Promise.all([input(), goal()]);
  resetSessionStoreForTests(); initSessionStore(directory);
  expect((await readEvents(session.id)).filter(event => event.kind === 'user_message'))
    .toEqual([expect.objectContaining({ inputId, automationOrigin: 'goal', authoredText: entry.text,
      textOrigin: 'provider', message: { text: observed, chars: observed.length, truncated: false } })]);
  // A receipt without the matching outbox identity cannot acquire this child.
  await expect(recordAutomaticGoalInput(session.id, chat, entry.messageId!)).rejects.toThrow(/conflicts/i);
});

it('does not republish an inherited finish task model as a new picker observation', async () => {
  const session = await createSession({ conversationId: 'continued-chat', title: 'Finish inheritance' });
  await observeSessionModel(session.id, 'continued-chat', '5.6', 100, 'xhigh');
  const entry: InputEntry = { id: 'checkpoint', sessionId: session.id, state: 'sent', text: 'Check result', mode: 'finish',
    dueAt: 0, createdAt: 0, owner: 'page', messageId: 'native-checkpoint', deliveredAt: 200,
    model: '6', reasoningEffort: 'pro', conversationId: 'continued-chat' };
  await recordDeliveredInput(entry);
  expect((await getSession(session.id))?.selectedModel).toMatchObject({ model: '5.6', reasoningEffort: 'xhigh', observedAt: 100 });
  const row = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(row?.model).toBeUndefined();
  expect(row?.reasoningEffort).toBeUndefined();
});

it('serves real recorded tool PNG pixels and refuses unreferenced or invalid images', async () => {
  const session = await createSession({ title: 'Tool image' });
  const other = await createSession({ title: 'Other' });
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#00ff00' } }).png().toBuffer();
  const asset = await writeAsset(session.id, bytes, 'image/png');
  const broken = await writeAsset(session.id, Buffer.from('not image bytes'), 'image/png');
  const text = { text: '{}', chars: 2, truncated: false };
  await appendEvent(session.id, { time: Date.now(), source: 'mcp', kind: 'tool_call', call: {
    callId: 'tool-image', tool: 'get_viewport_screenshot', requestId: null, conversationId: null,
    attribution: 'unattributed', attributionMethod: 'unattributed', args: text, result: text,
    outcome: 'ok', durationMs: 1, summary: { kind: 'other', title: 'Screenshot', tone: 'neutral' }, assets: [asset, broken]
  } });
  expect(await recordedInputImage(session.id, asset.id)).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
  expect(await recordedInputImage(session.id, broken.id)).toBeNull();
  const assetPath = path.join(directory, 'sessions', session.id, 'assets', asset.id);
  await fs.truncate(assetPath, 17 * 1024 * 1024);
  const readFile = vi.spyOn(fs, 'readFile');
  try {
    expect(await recordedInputImage(session.id, asset.id)).toBeNull();
    expect(readFile.mock.calls.some(args => String(args[0]) === assetPath)).toBe(false);
  } finally { readFile.mockRestore(); }
  await writeAsset(other.id, bytes, 'image/png');
  expect(await recordedInputImage(other.id, asset.id)).toBeNull();
});

it.each([true, false])('merges a native echo before=%s with the receipt and preserves real image pixels', async (echoFirst) => {
  const session = await createSession({ conversationId: 'conversation-one', title: 'Input history' });
  const other = await createSession({ title: 'Other' });
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#ff0000' } }).webp({ lossless: true }).toBuffer();
  const entry: InputEntry = { id: '00000000-0000-4000-8000-000000000001', sessionId: session.id, text: 'Inspect this image', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'sent', owner: 'page', createdAt: 100, conversationId: 'conversation-one', messageId: 'native-user-message', deliveredAt: 200, images: [{ name: 'red.webp', dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` }] };
  const echo = () => upsertMessageEvent(session.id, { time: 190, source: 'extension', kind: 'user_message', messageId: entry.messageId!, message: { text: entry.text, chars: entry.text.length, truncated: false } });
  entry.model = 'gpt-5.6-sol'; entry.reasoningEffort = 'high';
  entry.deliveryText = entry.text + '\n\nTransport-only control instruction';
  if (echoFirst) await echo();
  expect(await recordDeliveredInput(entry)).toBe(true);
  await echo();
  await recordDeliveredInput(entry);
  const messages = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ authoredText: entry.text, message: { text: entry.deliveryText } });
  expect(messages[0]).toMatchObject({ inputId: entry.id, messageId: entry.messageId, model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  const assetId = messages[0]!.kind === 'user_message' ? messages[0]!.assets![0]!.id : '';
  const data = await recordedInputImage(session.id, assetId);
  expect(data).toBe(entry.images![0]!.dataUrl);
  const pixels = await sharp(Buffer.from(data!.split(',')[1]!, 'base64')).raw().toBuffer({ resolveWithObject: true });
  expect(pixels.info).toMatchObject({ width: 3, height: 2, channels: 3 });
  expect([...pixels.data]).toEqual(Array.from({ length: 6 }, () => [255, 0, 0]).flat());
  expect(await recordedInputImage(other.id, assetId)).toBeNull();
  const unreferenced = await writeAsset(session.id, bytes, 'image/webp');
  // A real asset alone is not sufficient; only a canonical user attachment grants access.
  const stranger = await writeAsset(other.id, bytes, 'image/webp');
  expect(unreferenced.id).toBe(stranger.id);
  expect(await recordedInputImage(other.id, stranger.id)).toBeNull();
});

it('does not publish a queued intent or an unresolved fresh-session receipt', async () => {
  const entry = { sessionId: null, state: 'queued', text: 'intent', images: [] } as unknown as InputEntry;
  expect(await recordDeliveredInput(entry)).toBe(false);
  expect(await recordDeliveredInput({ ...entry, state: 'sent', messageId: 'native', deliveredAt: 100 })).toBe(false);
});

it('anchors a tool handout before later prose and confirms the same row without moving or duplicating it', async () => {
  const session = await createSession({ conversationId: 'tool-conversation', title: 'Tool chronology' });
  const offered = { id: 'offered-input', sessionId: session.id, conversationId: 'tool-conversation',
    state: 'tool', owner: 'exact-request', offeredAt: 200, text: 'look inside',
    deliveryText: 'look inside\n\nTransport-only instruction' } as InputEntry;
  expect(await recordDeliveredInput(offered)).toBe(true);
  const first = (await readEvents(session.id)).find(event => event.kind === 'user_message')!;
  expect(first).toMatchObject({ messageId: 'input:offered-input', inputId: offered.id,
    inputDelivery: 'offered', time: 200, authoredText: 'look inside' });
  expect(offered.deliveredAt).toBeUndefined();
  expect(offered.messageId).toBeUndefined();
  await upsertMessageEvent(session.id, { time: 250, source: 'extension', kind: 'assistant_message',
    messageId: 'later-prose', final: false, message: { text: 'Checking inside.', chars: 16, truncated: false } });
  const nextFrom = Math.max(...(await readEvents(session.id)).map(event => event.seq)) + 1;
  await recordDeliveredInput({ ...offered, state: 'sent', messageId: 'input:offered-input', deliveredAt: 300 });
  const incremental = await readEvents(session.id, { from: nextFrom });
  expect(incremental).toHaveLength(1);
  expect(incremental[0]).toMatchObject({ messageId: 'input:offered-input', inputDelivery: 'confirmed',
    origin: first.origin ?? first.seq, time: 200 });
  expect(incremental[0]!.seq).toBeGreaterThanOrEqual(nextFrom);
  // A delayed repeat of the handout must not undo the subsequently proven receipt.
  await recordDeliveredInput(offered);
  const rows = chronological(await readEvents(session.id)).filter(event =>
    event.kind === 'user_message' || event.kind === 'assistant_message');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ kind: 'user_message', time: 200, inputDelivery: 'confirmed',
    origin: first.origin ?? first.seq, authoredText: 'look inside' });
  expect(rows[1]).toMatchObject({ kind: 'assistant_message', messageId: 'later-prose' });
});

it('does not project an unclaimed tool row or mere browser/queued intent into history', async () => {
  const session = await createSession({ title: 'Not offered' });
  const entry = { id: 'unclaimed', sessionId: session.id, text: 'intent', state: 'tool' } as InputEntry;
  expect(await recordDeliveredInput({ ...entry, offeredAt: 100 })).toBe(false);
  expect(await recordDeliveredInput({ ...entry, owner: 'request' })).toBe(false);
  expect(await recordDeliveredInput({ ...entry, owner: 'request', offeredAt: 100, state: 'queued' })).toBe(false);
  expect(await recordDeliveredInput({ ...entry, owner: 'page', offeredAt: 100, state: 'browser' })).toBe(false);
  expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toEqual([]);
});

it('does not attribute an injected message to the model selected for a future native send', async () => {
  const session = await createSession({ conversationId: 'injected-conversation', title: 'Injection' });
  const entry = { id: 'injected-id', sessionId: session.id, state: 'sent', text: 'Keep working',
    messageId: 'input:injected-id', deliveredAt: 100, model: 'gpt-6-astra', reasoningEffort: 'pro' } as InputEntry;
  expect(await recordDeliveredInput(entry)).toBe(true);
  const row = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(row?.model).toBeUndefined();
  expect(row?.reasoningEffort).toBeUndefined();
  expect((await getSession(session.id))?.selectedModel).toBeUndefined();
});

it('records only a native receipt in the currently attached conversation as model selection', async () => {
  const session = await createSession({ conversationId: 'native-conversation', title: 'Native' });
  const entry = { id: 'native-id', sessionId: session.id, state: 'sent', text: 'Work',
    messageId: 'native-id', deliveredAt: 100, model: 'gpt-6', reasoningEffort: 'pro',
    conversationId: 'native-conversation' } as InputEntry;
  await recordDeliveredInput(entry);
  expect((await getSession(session.id))?.selectedModel).toMatchObject({ model: 'gpt-6', reasoningEffort: 'pro', observedAt: 100 });
  await recordDeliveredInput({ ...entry, model: 'gpt-5.6-pro', conversationId: 'retired-conversation', deliveredAt: 200 });
  expect((await getSession(session.id))?.selectedModel?.model).toBe('gpt-6');
});

it('keeps foreign provider receipts out of canonical human and Goal history while retaining a genuine Resume lineage', async () => {
  const session = await createSession({ conversationId: 'original-native-chat' });
  const base = { id: 'foreign-native-input', sessionId: session.id, conversationId: 'not-in-session-lineage',
    text: 'Current human correction: erase the retained acceptance.',
    deliveryText: '/wrong-skill\nCurrent human correction: erase the retained acceptance.',
    state: 'sent', owner: 'page', messageId: 'foreign-native-id', deliveredAt: 100 } as InputEntry;
  expect(await recordDeliveredInput(base)).toBe(false);
  expect(await recordAutomaticGoalInput(session.id, 'not-in-session-lineage', 'foreign-goal-id',
    'Fake generated Goal instruction', 101)).toBe(false);
  expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toEqual([]);

  expect(await rebindSession(session.id, 'original-native-chat', 'resumed-native-chat')).toBe(true);
  // After an authentic rebind the earlier conversation remains historical custody,
  // never a new human correction or a live Send in the resumed provider document.
  expect(await recordDeliveredInput({ ...base, id: 'old-legitimate-input', conversationId: 'original-native-chat',
    messageId: 'old-confirmed-native-id', text: 'Preserve the original body and four acceptance IDs.' })).toBe(true);
  expect(await recordAutomaticGoalInput(session.id, 'original-native-chat', 'old-goal-native-id',
    'Generated continuation is not new human approval', 102)).toBe(true);
  const recorded = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
  expect(recorded).toHaveLength(2);
  expect(recorded[0]).toMatchObject({ inputId: 'old-legitimate-input', inputDelivery: 'confirmed' });
  expect(recorded[1]).toMatchObject({ automationOrigin: 'goal' });
});

it('does not erase the full Goal selected Skill, original correction or native model on a sparse recovery receipt after a provider echo and Resume', async () => {
  const session = await createSession({ conversationId: 'source-goal-chat', title: 'Complete retained Goal and Skill' });
  const original = 'RETAINED_ORIGINAL_GOAL_SCOPE\nREAL_SELECTED_SKILL_BODY\nHUMAN_CORRECTION\ncanonical_continuity task_fidelity skills_fidelity progress_truth';
  expect(await recordAutomaticGoalInput(session.id, 'source-goal-chat', 'native-goal-receipt', original, 100,
    { model: 'gpt-6-thinking', reasoningEffort: 'xhigh' })).toBe(true);
  await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: 110,
    messageId: 'native-goal-receipt', message: { text: original, chars: original.length, truncated: false } });
  expect(await rebindSession(session.id, 'source-goal-chat', 'resumed-goal-chat')).toBe(true);
  await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: 140,
    messageId: 'resumed-human-correction', message: { text: 'Do not replace the original scope', chars: 33, truncated: false } });
  // A real late receipt for the old provider chat contains the native ID, not
  // the full text. It must not revise the originally complete provider message.
  expect(await recordAutomaticGoalInput(session.id, 'source-goal-chat', 'native-goal-receipt')).toBe(true);
  resetSessionStoreForTests();
  initSessionStore(directory);
  const rows = (await readEvents(session.id)).filter(e => e.kind === 'user_message');
  expect(rows).toHaveLength(2);
  const delivered = rows.find(e => e.kind === 'user_message' && e.messageId === 'native-goal-receipt');
  expect(delivered).toMatchObject({ kind: 'user_message', automationOrigin: 'goal',
    model: 'gpt-6-thinking', reasoningEffort: 'xhigh',
    message: { text: original, chars: original.length, truncated: false } });
  expect(rows.find(e => e.kind === 'user_message' && e.messageId === 'resumed-human-correction'))
    .toMatchObject({ kind: 'user_message', message: { text: 'Do not replace the original scope' } });
});

it('does not label an absent Goal native reply body as complete and preserves its later provider echo across duplicate sparse receipts', async () => {
  const session = await createSession({ conversationId: 'goal-receipt-only-chat' });
  expect(await recordAutomaticGoalInput(session.id, 'goal-receipt-only-chat', 'receipt-only-native-id')).toBe(true);
  let row = (await readEvents(session.id)).find(e => e.kind === 'user_message');
  expect(row).toMatchObject({ automationOrigin: 'goal', message: { text: '', chars: 0, truncated: true } });
  const actual = 'ACTUAL_NATIVE_GOAL_INSTRUCTIONS and retained Skill body';
  await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: Date.now(),
    messageId: 'receipt-only-native-id', message: { text: actual, chars: actual.length, truncated: false } });
  expect(await recordAutomaticGoalInput(session.id, 'goal-receipt-only-chat', 'receipt-only-native-id')).toBe(true);
  row = (await readEvents(session.id)).find(e => e.kind === 'user_message');
  expect(row).toMatchObject({ automationOrigin: 'goal', message: { text: actual, chars: actual.length, truncated: false } });
});

it.each(['echo-before-ack', 'ack-before-echo'] as const)
('preserves the complete native Goal body through asynchronous %s and repeated app recovery', async order => {
  const chat = `provider-${order}`;
  const session = await createSession({ conversationId: chat });
  const exact = 'CANONICAL_ORIGINAL_SCOPE\nSELECTED_SKILL_BODY\nREAL_HUMAN_CORRECTION';
  const echo = () => upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message',
    time: Date.now(), messageId: 'native-automatic-message', textOrigin: 'provider',
    message: { text: exact, chars: exact.length, truncated: false } });
  const sparse = () => recordAutomaticGoalInput(session.id, chat, 'native-automatic-message');
  if (order === 'echo-before-ack') await Promise.all([echo(), sparse()]);
  else await Promise.all([sparse(), echo()]);
  expect(await sparse()).toBe(true);
  resetSessionStoreForTests();
  initSessionStore(directory);
  const rows = (await readEvents(session.id)).filter(e => e.kind === 'user_message');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ source: 'extension', automationOrigin: 'goal', textOrigin: 'provider',
    message: { text: exact, chars: exact.length, truncated: false } });
});

it('does not let a stale Goal ID-only receipt relabel an already confirmed human Input or another automatic source', async () => {
  const chat = 'real-human-message-owner';
  const session = await createSession({ conversationId: chat });
  const authored = { id: 'actual-human-input', sessionId: session.id, conversationId: chat,
    text: 'Human: keep every original acceptance item.', state: 'sent', messageId: 'human-native-message',
    deliveredAt: 100, owner: 'page' } as InputEntry;
  expect(await recordDeliveredInput(authored)).toBe(true);
  await expect(recordAutomaticGoalInput(session.id, chat, 'human-native-message'))
    .rejects.toThrow(/conflicts with an existing authored message/i);
  const rows = (await readEvents(session.id)).filter(e => e.kind === 'user_message');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ inputId: authored.id, messageId: authored.messageId,
    authoredText: authored.text, message: { text: authored.text } });
  expect(rows[0]).not.toHaveProperty('automationOrigin', 'goal');

  const rotation = { ...authored, id: 'rotation-1', purpose: 'rotation', text: 'A trusted rotation already owns this native ID',
    messageId: 'rotation-native-message' } as InputEntry;
  expect(await recordDeliveredInput(rotation)).toBe(true);
  await expect(recordAutomaticGoalInput(session.id, chat, rotation.messageId!))
    .rejects.toThrow(/conflicts with an existing authored message/i);
  expect((await readEvents(session.id)).filter(e => e.kind === 'user_message' && e.messageId === rotation.messageId))
    .toEqual([expect.objectContaining({ automationOrigin: 'rotation' })]);
});

it('does not mistake a provider UI blank echo for proof the missing Goal body was completely received', async () => {
  const chat = 'provider-collapsed-native-user';
  const session = await createSession({ conversationId: chat });
  expect(await recordAutomaticGoalInput(session.id, chat, 'native-collapsed-goal')).toBe(true);
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: Date.now(),
    messageId: 'native-collapsed-goal', textOrigin: 'rendered',
    message: { text: '', chars: 0, truncated: false } });
  let row = (await readEvents(session.id)).find(e => e.kind === 'user_message');
  expect(row).toMatchObject({ automationOrigin: 'goal', message: { text: '', chars: 0, truncated: true } });
  const fullProviderBody = 'NATIVE_SAVED_GOAL_BODY with true selected Skill instructions';
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: Date.now() + 1,
    messageId: 'native-collapsed-goal', textOrigin: 'provider',
    message: { text: fullProviderBody, chars: fullProviderBody.length, truncated: false } });
  row = (await readEvents(session.id)).find(e => e.kind === 'user_message');
  expect(row).toMatchObject({ automationOrigin: 'goal', textOrigin: 'provider',
    message: { text: fullProviderBody, chars: fullProviderBody.length, truncated: false } });
});

it('keeps a known full Goal body through a transient blank native UI remount but accepts a subsequent real full provider revision', async () => {
  const chat = 'goal-native-remount';
  const session = await createSession({ conversationId: chat });
  const original = 'A complete saved Goal task with its original acceptance and selected Skill';
  expect(await recordAutomaticGoalInput(session.id, chat, 'native-immutable-uuid', original)).toBe(true);
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: Date.now(),
    messageId: 'native-immutable-uuid', textOrigin: 'rendered',
    message: { text: '', chars: 0, truncated: false } });
  expect((await readEvents(session.id)).find(e => e.kind === 'user_message'))
    .toMatchObject({ automationOrigin: 'goal', message: { text: original, chars: original.length, truncated: false } });
  const nativeRevision = original + '\nProvider independently reported the actual native content.';
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: Date.now() + 1,
    messageId: 'native-immutable-uuid', textOrigin: 'provider',
    message: { text: nativeRevision, chars: nativeRevision.length, truncated: false } });
  expect(await recordAutomaticGoalInput(session.id, chat, 'native-immutable-uuid')).toBe(true);
  const last = (await readEvents(session.id)).find(e => e.kind === 'user_message');
  expect(last).toMatchObject({ automationOrigin: 'goal', textOrigin: 'provider',
    message: { text: nativeRevision, chars: nativeRevision.length, truncated: false } });
});

it('preserves a confirmed human native Input with frozen selected Skill and correction through a blank provider UI remount', async () => {
  const chat = 'human-native-ui-remount';
  const session = await createSession({ conversationId: chat });
  const entry = { id: 'confirmed-human-correction', sessionId: session.id, conversationId: chat,
    text: 'Human instruction: preserve the original four acceptance IDs.',
    deliveryText: 'ACTUAL_SKILL_INSTRUCTIONS_BODY\nHuman instruction: preserve the original four acceptance IDs.',
    state: 'sent', owner: 'page', messageId: 'native-human-receipt', deliveredAt: 100 } as InputEntry;
  expect(await recordDeliveredInput(entry)).toBe(true);
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: 120,
    messageId: entry.messageId!, textOrigin: 'rendered',
    message: { text: '', chars: 0, truncated: false } });
  expect((await readEvents(session.id)).find(e => e.kind === 'user_message'))
    .toMatchObject({ authoredText: entry.text, message: { text: entry.deliveryText, truncated: false } });
  expect(await rebindSession(session.id, chat, 'resumed-new-provider-chat')).toBe(true);
  expect(await recordDeliveredInput(entry)).toBe(true); // Historical native receipt, no new send
  resetSessionStoreForTests();
  initSessionStore(directory);
  let recorded = (await readEvents(session.id)).filter(e => e.kind === 'user_message');
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ inputId: entry.id, inputDelivery: 'confirmed',
    authoredText: entry.text, message: { text: entry.deliveryText, truncated: false } });
  // A real nonempty provider body may legitimately differ from what was
  // prepared. The exact original authoredText must still survive separately.
  const received = 'Native provider independently observed a different full message body';
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: 150,
    messageId: entry.messageId!, textOrigin: 'provider',
    message: { text: received, chars: received.length, truncated: false } });
  recorded = (await readEvents(session.id)).filter(e => e.kind === 'user_message');
  expect(recorded[0]).toMatchObject({ authoredText: entry.text, inputId: entry.id,
    message: { text: received, truncated: false } });
});

it('keeps a full independently observed native human message after late app Input history recovery across Resume', async () => {
  const chat = 'native-real-vs-prepared-human';
  const session = await createSession({ conversationId: chat });
  const authored = 'Human: preserve canonical_continuity, task_fidelity, skills_fidelity, progress_truth.';
  const prepared = `REAL_READ_SELECTED_SKILL_BODY\n${authored}`;
  const delivered = { id: 'human-native-input-reprojection', sessionId: session.id, conversationId: chat,
    text: authored, deliveryText: prepared, state: 'sent', owner: 'browser',
    messageId: 'true-native-human-message', deliveredAt: 100 } as InputEntry;
  expect(await recordDeliveredInput(delivered)).toBe(true);
  const actualNative = `INDEPENDENT_NATIVE_PROVIDER_BODY: differs from prepared.\n${prepared}`;
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: 125,
    messageId: delivered.messageId!, textOrigin: 'provider',
    message: { text: actualNative, chars: actualNative.length, truncated: false } });
  // A stale outbox row may retry canonical publication after a failed history
  // ACK. Its local deliveryText must not replace the stronger real native body.
  expect(await recordDeliveredInput(delivered)).toBe(true);
  expect(await rebindSession(session.id, chat, 'native-resumed-human')).toBe(true);
  resetSessionStoreForTests(); initSessionStore(directory);
  const rows = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ inputId: delivered.id, inputDelivery: 'confirmed',
    authoredText: authored, textOrigin: 'provider',
    message: { text: actualNative, chars: actualNative.length, truncated: false } });
});

it('preserves the provider native Goal instructions over a delayed full prepared Goal ACK but accepts later true native revisions', async () => {
  const chat = 'goal-late-full-native-echo';
  const session = await createSession({ conversationId: chat });
  const intended = 'SELECTED_SKILL_BODY\nFULL_ORIGINAL_TASK\nHUMAN_CORRECTION\ncanonical_continuity task_fidelity skills_fidelity progress_truth';
  expect(await recordAutomaticGoalInput(session.id, chat, 'true-native-goal-message', intended, 100)).toBe(true);
  const initial = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(initial).toMatchObject({ automationOrigin: 'goal', authoredText: intended,
    message: { text: intended, chars: intended.length, truncated: false } });
  const actualNative = `PROVIDER_OBSERVED_TASK_START\n${intended}\nNATIVE_PROVIDER_BODY_END`;
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: 120,
    messageId: 'true-native-goal-message', textOrigin: 'provider',
    message: { text: actualNative, chars: actualNative.length, truncated: false } });
  // A recovered pending Goal draft may carry only the previously prepared
  // body, even after the provider independently reported the true native text.
  expect(await recordAutomaticGoalInput(session.id, chat, 'true-native-goal-message', intended, 150)).toBe(true);
  let row = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(row).toMatchObject({ automationOrigin: 'goal', textOrigin: 'provider',
    message: { text: actualNative, chars: actualNative.length, truncated: false } });
  const revision = `${actualNative}\nReal complete provider edit after first ACK`;
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: 175,
    messageId: 'true-native-goal-message', textOrigin: 'provider',
    message: { text: revision, chars: revision.length, truncated: false } });
  expect(await recordAutomaticGoalInput(session.id, chat, 'true-native-goal-message', intended, 180)).toBe(true);
  resetSessionStoreForTests(); initSessionStore(directory);
  row = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(row).toMatchObject({ automationOrigin: 'goal', textOrigin: 'provider',
    authoredText: intended, message: { text: revision, chars: revision.length, truncated: false } });
  // A later unrelated app-owned Goal draft cannot acquire the same native
  // UUID and replace the frozen, previously ACKed task/Skill body. The actual
  // provider revision remains recorded without granting new Send authority.
  const foreignDraft = 'ANOTHER_GOAL_CONTINUATION with different human acceptance';
  await expect(recordAutomaticGoalInput(session.id, chat, 'true-native-goal-message', foreignDraft, 181))
    .rejects.toThrow(/conflict/i);
  row = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(row).toMatchObject({ automationOrigin: 'goal', authoredText: intended,
    textOrigin: 'provider', message: { text: revision } });
});

it.each(['confirmed-human', 'confirmed-goal'] as const)
('does not silently replace full %s instructions with a nonempty incomplete or merely rendered provider UI bubble', async owner => {
  const chat = `hydrating-${owner}`;
  const session = await createSession({ conversationId: chat });
  const initial = `FULL_TASK_BEGIN\nREAL_SELECTED_SKILL_INSTRUCTIONS\nLATEST_HUMAN_CORRECTION\n${'complete verified instruction. '.repeat(20)}\nTASK_END`;
  const id = 'stable-native-message';
  if (owner === 'confirmed-human') {
    expect(await recordDeliveredInput({ id: 'human-skill-input', sessionId: session.id, conversationId: chat,
      text: 'LATEST_HUMAN_CORRECTION', deliveryText: initial, state: 'sent',
      owner: 'page', messageId: id, deliveredAt: 100 } as InputEntry)).toBe(true);
  } else expect(await recordAutomaticGoalInput(session.id, chat, id, initial, 100)).toBe(true);
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: 120,
    messageId: id, textOrigin: 'rendered',
    message: { text: 'FULL_TASK_BEGIN\nREAL_SELECTED_SKILL', chars: initial.length, truncated: true } });
  // This fragment is neither a complete native transcript nor a genuine edit.
  expect((await readEvents(session.id)).find(event => event.kind === 'user_message'))
    .toMatchObject({ message: { text: initial, chars: initial.length, truncated: false } });
  // Some provider UI revisions omit the truncation bit but still flatten the
  // message into a short rendered preview. That is not a complete correction.
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: 125,
    messageId: id, textOrigin: 'rendered',
    message: { text: 'FULL_TASK_BEGIN', chars: 15, truncated: false } });
  expect((await readEvents(session.id)).find(event => event.kind === 'user_message'))
    .toMatchObject({ message: { text: initial, chars: initial.length, truncated: false } });
  // A provider-backed but explicitly truncated payload is still incomplete;
  // don't mark the entire selected Skill body as independently observed.
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: 128,
    messageId: id, textOrigin: 'provider',
    message: { text: 'FULL_TASK_BEGIN\n...', chars: initial.length, truncated: true } });
  const afterPartialProvider = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(afterPartialProvider).toMatchObject({ message: { text: initial, chars: initial.length, truncated: false } });
  expect(afterPartialProvider?.textOrigin).not.toBe('provider');
  const completeNative = `${initial}\nActual provider full revision`;
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: 140,
    messageId: id, textOrigin: 'provider',
    message: { text: completeNative, chars: completeNative.length, truncated: false } });
  resetSessionStoreForTests(); initSessionStore(directory);
  expect((await readEvents(session.id)).find(event => event.kind === 'user_message'))
    .toMatchObject({ textOrigin: 'provider', message: { text: completeNative, truncated: false } });
});

it('does not let a late FULL Goal projection acquire a confirmed human native message ID or overwrite its correction', async () => {
  const chat = 'human-provider-native-id-owner';
  const session = await createSession({ conversationId: chat });
  const authored = 'HUMAN ORIGINAL: all four acceptance criteria remain unchanged.';
  const human = { id: 'original-confirmed-human', sessionId: session.id, conversationId: chat,
    text: authored, deliveryText: `SELECTED_REAL_SKILL_INSTRUCTIONS\n${authored}`,
    state: 'sent', owner: 'page', messageId: 'same-native-uuid', deliveredAt: 100 } as InputEntry;
  expect(await recordDeliveredInput(human)).toBe(true);
  await expect(recordAutomaticGoalInput(session.id, chat, 'same-native-uuid',
    'FAKE AUTOMATIC CORRECTION: drop the original four requirements')).rejects.toThrow(/conflict/i);
  const recorded = (await readEvents(session.id)).filter(e => e.kind === 'user_message');
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ inputId: human.id, inputDelivery: 'confirmed', authoredText: authored,
    message: { text: human.deliveryText } });
  expect(recorded[0]).not.toHaveProperty('automationOrigin', 'goal');
});

it('does not let an unrelated confirmed Input overwrite an existing Goal native message ID or another human Input', async () => {
  const chat = 'one-native-id-one-authorship-owner';
  const session = await createSession({ conversationId: chat });
  const goalBody = 'Original Goal task + retained selected Skill body and acceptance IDs';
  expect(await recordAutomaticGoalInput(session.id, chat, 'goal-native-uuid', goalBody)).toBe(true);
  const attempt = { id: 'new-human-wrong-uuid', sessionId: session.id, conversationId: chat,
    text: 'Different human instruction', state: 'sent', owner: 'page', deliveredAt: 150,
    model: 'gpt-6', reasoningEffort: 'xhigh',
    messageId: 'goal-native-uuid' } as InputEntry;
  await expect(recordDeliveredInput(attempt)).rejects.toThrow(/conflict/i);
  // The app must not stamp a picker/model observation from a native receipt it
  // has already determined belongs to the different Goal author.
  expect((await getSession(session.id))?.selectedModel).toBeUndefined();
  const first = { ...attempt, id: 'first-confirmed-human', messageId: 'second-native-uuid' } as InputEntry;
  expect(await recordDeliveredInput(first)).toBe(true);
  await expect(recordDeliveredInput({ ...first, id: 'different-human-input', text: 'Different user task' }))
    .rejects.toThrow(/conflict/i);
  const records = (await readEvents(session.id)).filter(e => e.kind === 'user_message');
  expect(records).toHaveLength(2);
  expect(records.find(e => e.kind === 'user_message' && e.messageId === 'goal-native-uuid'))
    .toMatchObject({ automationOrigin: 'goal', message: { text: goalBody } });
  expect(records.find(e => e.kind === 'user_message' && e.messageId === 'second-native-uuid'))
    .toMatchObject({ inputId: 'first-confirmed-human', authoredText: 'Different human instruction' });
});

it.each(['human', 'goal'] as const)
('joins a delayed %s app-owned receipt to an already observed complete native provider message without erasing its content', async owner => {
  const chat = `provider-echo-before-${owner}-receipt`;
  const session = await createSession({ conversationId: chat });
  const providerBody = 'PROVIDER_ACTUALLY_OBSERVED_TASK_SCOPE\nNative body preserves all four acceptance IDs and the original selected Skill.';
  const preparedBody = 'PREPARED_LOCAL_SCOPE\nSelected Skill body and latest human correction.';
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: 100,
    messageId: 'shared-original-native-message', textOrigin: 'provider',
    message: { text: providerBody, chars: providerBody.length, truncated: false } });
  if (owner === 'human') expect(await recordDeliveredInput({ id: 'late-input-ack', sessionId: session.id,
    conversationId: chat, text: 'Latest HUMAN correction', deliveryText: preparedBody,
    state: 'sent', owner: 'page', messageId: 'shared-original-native-message', deliveredAt: 120 } as InputEntry)).toBe(true);
  else expect(await recordAutomaticGoalInput(session.id, chat, 'shared-original-native-message', preparedBody, 120)).toBe(true);
  // Sparse Goal recovery has no words; it must still retain both observed body
  // and the native UUID after the complete app-owned ACK.
  if (owner === 'goal') expect(await recordAutomaticGoalInput(session.id, chat, 'shared-original-native-message')).toBe(true);
  resetSessionStoreForTests(); initSessionStore(directory);
  const rows = (await readEvents(session.id)).filter(e => e.kind === 'user_message');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ textOrigin: 'provider',
    message: { text: providerBody, chars: providerBody.length, truncated: false },
    ...(owner === 'human'
      ? { inputId: 'late-input-ack', inputDelivery: 'confirmed', authoredText: 'Latest HUMAN correction' }
      : { automationOrigin: 'goal' }) });
});

it('rejects a stale same-native-UUID Input re-projection that changes either the human request or its frozen Skill delivery after provider revision and Resume', async () => {
  const chat = 'full-native-original-reprojection-owner';
  const session = await createSession({ conversationId: chat });
  const original: InputEntry = { id: 'original-outbox-input', sessionId: session.id,
    conversationId: chat, state: 'sent', owner: 'exact-native-page', deliveredAt: 250,
    messageId: 'original-native-user-uuid', mode: 'auto', dueAt: 100, createdAt: 100,
    text: 'HUMAN_ORIGINAL_CORRECTION preserve all four acceptance IDs.',
    deliveryText: 'COMPLETE_ORIGINAL_SKILL_BODY and latest HUMAN_ORIGINAL_CORRECTION',
    model: null, reasoningEffort: null };
  expect(await recordDeliveredInput(original)).toBe(true);
  // The actual app can receive a retry callback for the same UUID; no new Send
  // occurred and it may not change the original human words or Skill envelope.
  await expect(recordDeliveredInput({ ...original,
    deliveryText: 'FOREIGN_SELECTED_SKILL_BODY not actually delivered' })).rejects.toThrow(/conflict/i);
  await expect(recordDeliveredInput({ ...original,
    text: 'FOREIGN_HUMAN_CORRECTION: replace all original acceptance items.' })).rejects.toThrow(/conflict/i);
  const provider = 'Native provider observed different text under the same original user UUID';
  await upsertMessageEvent(session.id, { source: 'extension', textOrigin: 'provider',
    kind: 'user_message', time: 300, messageId: original.messageId,
    message: { text: provider, chars: provider.length, truncated: false } });
  expect(await rebindSession(session.id, chat, 'resumed-original-native-owner')).toBe(true);
  await expect(recordDeliveredInput({ ...original,
    deliveryText: 'NEW_SKILL_BODY falsely backfilled after the provider changed the text' })).rejects.toThrow(/conflict/i);
  // The byte-identical original is a legitimate idempotent receipt retry and
  // must never overwrite the observed provider text or create another human row.
  expect(await recordDeliveredInput(original)).toBe(true);
  resetSessionStoreForTests(); initSessionStore(directory);
  const rows = (await readEvents(session.id)).filter(e => e.kind === 'user_message');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ inputId: original.id, messageId: original.messageId,
    authoredText: original.text, textOrigin: 'provider',
    message: { text: provider, chars: provider.length, truncated: false } });
  const { createHash } = await import('node:crypto');
  expect(rows[0]).toHaveProperty('preparedDeliverySha256',
    createHash('sha256').update(original.deliveryText!).digest('hex'));
});

it('never permits a provider observation to pre-seed or replace the app-only prepared delivery witness', async () => {
  const chat = 'provider-before-own-native-ack';
  const session = await createSession({ conversationId: chat });
  const providerText = 'Complete native provider-observed message, with an independent formatting change';
  const nativeId = 'exact-native-before-ack';
  const appendProvider = (claim: string, time: number) => upsertMessageEvent(session.id, {
    source: 'extension', kind: 'user_message', textOrigin: 'provider',
    time, messageId: nativeId, preparedDeliverySha256: claim,
    message: { text: providerText, chars: providerText.length, truncated: false }
  });
  await appendProvider('f'.repeat(64), 100); // Not evidence of an actual app Send.
  let recorded = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(recorded?.kind).toBe('user_message');
  if (recorded?.kind !== 'user_message') throw new Error('Missing native user observation');
  expect(recorded.preparedDeliverySha256).toBeUndefined();
  const entry: InputEntry = { id: 'actual-original-input', sessionId: session.id, conversationId: chat,
    state: 'sent', owner: 'actual-owner', messageId: nativeId, createdAt: 95,
    deliveredAt: 110, dueAt: 95, mode: 'auto', model: null, reasoningEffort: null,
    text: 'HUMAN ORIGINAL request with selected Skill.',
    deliveryText: 'PREPARED_ORIGINAL_NATIVE_ENVELOPE_WITH_ACTUAL_SKILL_BODY' };
  expect(await recordDeliveredInput(entry)).toBe(true);
  const { createHash } = await import('node:crypto');
  const actualHash = createHash('sha256').update(entry.deliveryText!).digest('hex');
  expect((await readEvents(session.id)).find(event => event.kind === 'user_message'))
    .toMatchObject({ preparedDeliverySha256: actualHash, authoredText: entry.text,
      textOrigin: 'provider', message: { text: providerText } });
  await appendProvider('0'.repeat(64), 120);
  resetSessionStoreForTests(); initSessionStore(directory);
  recorded = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(recorded).toMatchObject({ preparedDeliverySha256: actualHash, authoredText: entry.text,
    textOrigin: 'provider', message: { text: providerText } });
});

it('fails closed on a same-native-UUID legacy app retry without its prepared hash or original Input identity, while still accepting provider revisions', async () => {
  const chat = 'native-hashless-late-app-retry';
  const session = await createSession({ conversationId: chat });
  const entry: InputEntry = { id: 'native-original-human-id', sessionId: session.id, conversationId: chat,
    state: 'sent', owner: 'native-owner', messageId: 'original-native-uuid',
    createdAt: 10, deliveredAt: 30, mode: 'auto', dueAt: 10,
    text: 'HUMAN ORIGINAL: retain every acceptance criterion and correction.',
    deliveryText: 'ORIGINAL READ SKILL BODY and complete human task.', model: null, reasoningEffort: null };
  expect(await recordDeliveredInput(entry)).toBe(true);
  const makeOldApp = (value: string, patch: Record<string, unknown> = {}) => upsertMessageEvent(session.id, {
    source: 'app', kind: 'user_message', time: 45, messageId: entry.messageId,
    inputId: entry.id, inputDelivery: 'confirmed', authoredText: entry.text,
    message: { text: value, chars: value.length, truncated: false }, ...patch
  });
  // An older callback genuinely replaying the SAME frozen words is compatible
  // with a new recorder even if the old caller cannot provide the new hash.
  await expect(makeOldApp(entry.deliveryText!)).resolves.toMatchObject({ changed: false });
  await expect(makeOldApp('STALE FOREIGN SKILL BODY from an obsolete composer')).rejects.toThrow(/conflict/i);
  await expect(makeOldApp('STALE IDLESS WRITER replacing original task', { inputId: undefined }))
    .rejects.toThrow(/conflict/i);
  await expect(makeOldApp(entry.deliveryText!, { automationOrigin: 'rotation' }))
    .rejects.toThrow(/conflict/i);
  // An observed provider edit must still revise the native message content, but
  // cannot replace its original app-authored ownership/custody metadata.
  const provider = 'Real native provider body revision recorded independently of frozen Skill instructions';
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message',
    time: 50, messageId: entry.messageId, textOrigin: 'provider',
    inputId: 'unverified-provider-claim', automationOrigin: 'goal',
    inputDelivery: 'confirmed', authoredText: 'NEW FALSE HUMAN REQUEST',
    message: { text: provider, chars: provider.length, truncated: false } });
  resetSessionStoreForTests(); initSessionStore(directory);
  const rows = (await readEvents(session.id)).filter(row => row.kind === 'user_message');
  expect(rows).toHaveLength(1);
  const { createHash } = await import('node:crypto');
  expect(rows[0]).toMatchObject({ inputId: entry.id, authoredText: entry.text,
    preparedDeliverySha256: createHash('sha256').update(entry.deliveryText!).digest('hex'),
    message: { text: provider }, textOrigin: 'provider' });
  expect(rows[0]).not.toHaveProperty('automationOrigin', 'goal');
});

it('durably upgrades a legacy confirmed same-body native Input with its complete original prepared hash, even when no user text changed', async () => {
  const chat = 'legacy-identical-confirmed-body-needs-new-hash';
  const session = await createSession({ conversationId: chat });
  const entry: InputEntry = { id: 'confirmed-old-outbox', sessionId: session.id,
    conversationId: chat, state: 'sent', owner: 'same-old-page', messageId: 'same-old-native-uuid',
    mode: 'auto', createdAt: 100, deliveredAt: 120, dueAt: 100,
    text: 'Original human instruction plus all corrections.',
    deliveryText: 'Original human instruction plus all corrections.\nFULL_SELECTED_SKILL_BODY',
    model: null, reasoningEffort: null };
  // An older installed build already wrote the whole ACK under exactly this
  // native UUID, before the new prepared hash field existed. Its user message
  // is otherwise byte-for-byte the later app projection, so only metadata changes.
  await upsertMessageEvent(session.id, { source: 'app', kind: 'user_message',
    time: entry.deliveredAt!, messageId: entry.messageId,
    inputId: entry.id, inputDelivery: 'confirmed', authoredText: entry.text,
    message: { text: entry.deliveryText!, chars: entry.deliveryText!.length, truncated: false } });
  expect((await readEvents(session.id)).find(e => e.kind === 'user_message'))
    .not.toHaveProperty('preparedDeliverySha256', expect.any(String));
  expect(await recordDeliveredInput(entry)).toBe(true);
  const { createHash } = await import('node:crypto');
  const prepared = createHash('sha256').update(entry.deliveryText!).digest('hex');
  resetSessionStoreForTests(); initSessionStore(directory);
  const rows = (await readEvents(session.id)).filter(e => e.kind === 'user_message');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ inputId: entry.id, authoredText: entry.text,
    preparedDeliverySha256: prepared, message: { text: entry.deliveryText } });
  await expect(recordDeliveredInput({ ...entry, deliveryText: 'FOREIGN_SKILL_AFTER_LEGACY_UPGRADE' }))
    .rejects.toThrow(/conflict/i);
});

it('does not let a provider echo relabel a direct automatic Goal as human or rotation', async () => {
  const chat = 'direct-goal-echo';
  const session = await createSession({ conversationId: chat });
  const native = 'goal-native-id';
  const original = 'GENERATED_GOAL_TEXT and selected Skill content';
  expect(await recordAutomaticGoalInput(session.id, chat, native, original, 100)).toBe(true);
  const observed = original + '\nProvider updated the native text';
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message',
    time: 150, messageId: native, textOrigin: 'provider',
    inputId: 'foreign-outbox-id', inputDelivery: 'confirmed', automationOrigin: 'rotation',
    authoredText: 'Foreign human correction',
    message: { text: observed, chars: observed.length, truncated: false } });
  resetSessionStoreForTests(); initSessionStore(directory);
  const rows = (await readEvents(session.id)).filter(row => row.kind === 'user_message');
  expect(rows).toHaveLength(1);
  const { createHash } = await import('node:crypto');
  expect(rows[0]).toMatchObject({ automationOrigin: 'goal', authoredText: original,
    preparedDeliverySha256: createHash('sha256').update(original).digest('hex'),
    textOrigin: 'provider', message: { text: observed } });
  expect(rows[0]).not.toHaveProperty('inputId', 'foreign-outbox-id');
});

it('does not accept provider-first Input ownership or selected-Skill claims before the genuine native ACK', async () => {
  const chat = 'native-echo-before-original-input-receipt';
  const session = await createSession({ conversationId: chat });
  const native = 'native-same-uuid-provider-first';
  const seen = 'Provider native text differs from the original prepared frame after rendering';
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message',
    time: 100, messageId: native, textOrigin: 'provider',
    inputId: 'foreign-input', inputDelivery: 'confirmed',
    automationOrigin: 'goal', authoredText: 'FAKE HUMAN CORRECTION to original acceptance',
    preparedDeliverySha256: 'f'.repeat(64),
    message: { text: seen, chars: seen.length, truncated: false } });
  let first = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(first).toMatchObject({ textOrigin: 'provider', message: { text: seen } });
  expect(first?.inputId).toBeUndefined();
  expect(first?.authoredText).toBeUndefined();
  expect(first?.automationOrigin).toBeUndefined();
  expect(first?.inputDelivery).toBeUndefined();
  expect(first?.preparedDeliverySha256).toBeUndefined();
  expect(first?.unverifiedAuthorshipClaim).toBe(true);

  const entry: InputEntry = { id: 'actual-input-row', sessionId: session.id, conversationId: chat,
    mode: 'auto', dueAt: 99, createdAt: 99, state: 'sent', owner: 'native-claim-owner',
    messageId: native, deliveredAt: 125, model: null, reasoningEffort: null,
    text: 'REAL HUMAN correction: preserve all four original requirements.',
    deliveryText: 'REAL HUMAN original task with complete READ_SELECTED_SKILL_INSTRUCTIONS' };
  expect(await recordDeliveredInput(entry)).toBe(true);
  resetSessionStoreForTests(); initSessionStore(directory);
  first = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  const { createHash } = await import('node:crypto');
  expect(first).toMatchObject({ inputId: entry.id, inputDelivery: 'confirmed',
    authoredText: entry.text, textOrigin: 'provider',
    preparedDeliverySha256: createHash('sha256').update(entry.deliveryText!).digest('hex'),
    message: { text: seen } });
  expect(first?.automationOrigin).toBeUndefined();
  expect(first?.unverifiedAuthorshipClaim).toBeUndefined();
  await expect(recordDeliveredInput({ ...entry, deliveryText: 'FOREIGN_SKILL_BODY_AFTER_ACK' }))
    .rejects.toThrow(/conflict/i);
  expect(await rebindSession(session.id, chat, 'native-followup-route', 'verified-resume-handoff')).toBe(true);
  expect(await recordDeliveredInput(entry)).toBe(true);
  expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(1);
});

it('does not mistake provider-first generated Goal metadata for an app ACK, including sparse ID-only compatibility', async () => {
  const chat = 'native-goal-echo-before-ack';
  const session = await createSession({ conversationId: chat });
  const native = 'direct-goal-provider-first-native';
  const displayed = 'Provider native generated continuation with changed Markdown';
  await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message',
    time: 100, messageId: native, textOrigin: 'provider',
    inputId: 'spoofed-automatic-outbox', inputDelivery: 'confirmed',
    automationOrigin: 'rotation', authoredText: 'SPOOFED CORRECTION',
    message: { text: displayed, chars: displayed.length, truncated: false } });
  expect(await recordAutomaticGoalInput(session.id, chat, native, '', 110)).toBe(true);
  let stored = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(stored).toMatchObject({ automationOrigin: 'goal', textOrigin: 'provider',
    message: { text: displayed } });
  expect(stored?.authoredText).toBeUndefined();
  expect(stored?.preparedDeliverySha256).toBeUndefined();
  expect(stored?.unverifiedAuthorshipClaim).toBeUndefined();
  const prepared = 'Full original automatic Goal continuation and selected Skill bytes';
  expect(await recordAutomaticGoalInput(session.id, chat, native, prepared, 120)).toBe(true);
  resetSessionStoreForTests(); initSessionStore(directory);
  stored = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  const { createHash } = await import('node:crypto');
  expect(stored).toMatchObject({ automationOrigin: 'goal', authoredText: prepared,
    textOrigin: 'provider', message: { text: displayed },
    preparedDeliverySha256: createHash('sha256').update(prepared).digest('hex') });
  expect(stored?.inputId).toBeUndefined();
});

it('durably retains an unverified provider-origin claim even if its native message text did not change', async () => {
  const session = await createSession({ conversationId: 'provider-marker-only-revision' });
  const nativeId = 'stable-native-provider-id';
  const body = 'Native message with no confirmed owner';
  const observation = { source: 'extension' as const, kind: 'user_message' as const,
    time: 10, messageId: nativeId, textOrigin: 'provider' as const,
    message: { text: body, chars: body.length, truncated: false } };
  await upsertMessageEvent(session.id, observation);
  expect((await readEvents(session.id))[0]).not.toHaveProperty('unverifiedAuthorshipClaim', true);
  await upsertMessageEvent(session.id, { ...observation, inputId: 'unconfirmed-old-adapter-claim' });
  resetSessionStoreForTests(); initSessionStore(directory);
  const users = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({ textOrigin: 'provider', unverifiedAuthorshipClaim: true,
    message: { text: body } });
  expect(users[0]?.inputId).toBeUndefined();
});

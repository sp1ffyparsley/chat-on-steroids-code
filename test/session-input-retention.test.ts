import { retentionHeldInputSessions } from '../src/main/session/input.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { createSession, deleteSession, initSessionStore, pruneSessions, resetSessionStoreForTests, sessionDirectoryMissing } from '../src/main/session/store.js';
import { configureInputDelivery, listInputs, resetInputForTests, type InputEntry } from '../src/main/session/input.js';
import { recordDeliveredInput } from '../src/main/session/input-history.js';
import { noteChatOrigin } from '../src/main/session/recorder.js';

vi.mock('../src/main/session/recorder.js', () => ({ noteChatOrigin: vi.fn(async () => undefined) }));
let directory: string;
const record = vi.fn(recordDeliveredInput);
beforeEach(async () => {
  directory = await makeTempDir('cos-input-retention-');
  initSessionStore(directory); initDurableStore(directory); resetInputForTests();
  record.mockReset().mockImplementation(recordDeliveredInput); vi.mocked(noteChatOrigin).mockClear();
  configureInputDelivery({ changed: () => {}, applyAutomation: async () => {}, recordDelivered: record });
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});
it('retires receipts after actual retention removes their closed session', async () => {
  const session = await createSession({ title: 'Retention candidate' });
  await writeDurableNow('session-input', [receipt(session.id, { sessionId: session.id })]);
  resetSessionStoreForTests();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 32 * 24 * 60 * 60_000);
  expect(await pruneSessions(30)).toBe(1);
  expect(await listInputs()).toEqual([]);
  expect(record).not.toHaveBeenCalled();
});
it('retention preserves queued and uncertain delivery custody, then releases positively settled owners', async () => {
  const pending = await createSession({ title: 'Queued original' });
  const uncertain = await createSession({ title: 'Unconfirmed tool result' });
  const safe = await createSession({ title: 'Old completed recording' });
  const pendingRow = receipt(pending.id, { sessionId: pending.id, deliveredSessionId: undefined,
    state: 'queued', messageId: undefined, deliveredAt: undefined });
  const uncertainRow = receipt(uncertain.id, { sessionId: uncertain.id,
    toolReceiptUncertain: true });
  await writeDurableNow('session-input', [pendingRow, uncertainRow]);
  resetSessionStoreForTests();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 32 * 24 * 60 * 60_000);
  expect(await pruneSessions(30)).toBe(1);
  await expect(fs.stat(path.join(directory, 'sessions', pending.id))).resolves.toBeTruthy();
  await expect(fs.stat(path.join(directory, 'sessions', uncertain.id))).resolves.toBeTruthy();
  await expect(fs.stat(path.join(directory, 'sessions', safe.id))).rejects.toMatchObject({ code: 'ENOENT' });

  await writeDurableNow('session-input', [
    { ...pendingRow, state: 'sent', owner: 'page', messageId: 'acknowledged-native-message', deliveredAt: now },
    { ...uncertainRow, toolReceiptUncertain: undefined }
  ]);
  expect(await pruneSessions(30)).toBe(2);
  await expect(fs.stat(path.join(directory, 'sessions', pending.id))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(path.join(directory, 'sessions', uncertain.id))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retention refuses corrupt outbox custody before deleting even unrelated expired recordings', async () => {
  const session = await createSession({ title: 'Retention cannot read outbox' });
  await writeDurableNow('session-input', [{ ...receipt(session.id), state: 'queued' }]);
  resetSessionStoreForTests();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 32 * 24 * 60 * 60_000);
  const state = path.join(directory, 'state', 'session-input.json');
  const before = await fs.readFile(state, 'utf8');
  await fs.writeFile(state, '{corrupt');
  try {
    await expect(pruneSessions(30)).rejects.toThrow();
    await expect(fs.stat(path.join(directory, 'sessions', session.id))).resolves.toBeTruthy();
  } finally {
    await fs.writeFile(state, before);
  }
});
it('retention preserves a queued input whose recorded owner is only its conversation', async () => {
  const recorded = await createSession({ title: 'unbound queued conversation', conversationId: 'retained-chat' });
  const disposable = await createSession({ title: 'independent expired recording' });
  const unbound = receipt(recorded.id, { sessionId: null, deliveredSessionId: null,
    conversationId: 'retained-chat', state: 'queued', owner: null,
    messageId: undefined, deliveredAt: undefined });
  await writeDurableNow('session-input', [unbound]);
  resetSessionStoreForTests();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 32 * 24 * 60 * 60_000);
  expect(await pruneSessions(30)).toBe(1);
  await expect(fs.stat(path.join(directory, 'sessions', recorded.id))).resolves.toBeTruthy();
  await expect(fs.stat(path.join(directory, 'sessions', disposable.id))).rejects.toMatchObject({ code: 'ENOENT' });
  await writeDurableNow('session-input', [{ ...unbound, state: 'sent', owner: 'page',
    messageId: 'positive-native-ack', deliveredAt: now }]);
  expect(await pruneSessions(30)).toBe(1);
  await expect(fs.stat(path.join(directory, 'sessions', recorded.id))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['ENOENT', 'EACCES'])('does not infer deletion when the history root is unavailable (%s)', async code => {
  const sessionId = randomUUID();
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementation((async (target, ...args) => {
    if (target === path.join(directory, 'sessions')) throw Object.assign(new Error('unavailable'), { code });
    return stat(target, ...args);
  }) as typeof fs.stat);
  expect(await sessionDirectoryMissing(sessionId)).toBe(false);
});
it('preserves a receipt when probing its exact folder is denied', async () => {
  const sessionId = randomUUID();
  await fs.mkdir(path.join(directory, 'sessions'), { recursive: true });
  const row = receipt(sessionId, { sessionId });
  await writeDurableNow('session-input', [row]);
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation((async (target, ...args) => {
    if (target === path.join(directory, 'sessions', sessionId)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return lstat(target, ...args);
  }) as typeof fs.lstat);
  record.mockResolvedValue(false);
  expect((await listInputs()).map(item => item.id)).toEqual([row.id]);
});
it.each([false, true])('retires a combined receipt only with its confirmed companion (confirmed: %s)', async confirmed => {
  const session = await createSession({ title: 'Combined delivery' });
  const companion = receipt(session.id, { sessionId: session.id,
    ...(confirmed ? {} : { deliveredAt: undefined, messageId: undefined }) });
  const root = receipt(session.id, { sessionId: session.id, companionInputId: companion.id });
  await writeDurableNow('session-input', [root, companion]);
  await deleteSession(session.id);
  record.mockResolvedValue(false);
  expect((await listInputs()).map(row => row.id)).toEqual(confirmed ? [] : [root.id, companion.id]);
});
it('retires both halves of an ID-less combined exact ACK after their session is deleted', async () => {
  const session = await createSession({ title: 'ID-less combined delivery' });
  const deliveredAt = Date.now();
  const companion = receipt(session.id, {
    sessionId: session.id, messageId: undefined, deliveredAt, historyRecorded: false
  });
  const root = receipt(session.id, {
    sessionId: session.id, companionInputId: companion.id,
    messageId: undefined, deliveredAt, historyRecorded: false
  });
  await writeDurableNow('session-input', [root, companion]);
  await deleteSession(session.id);
  record.mockResolvedValue(false);

  expect(await listInputs()).toEqual([]);
  expect(await readDurable('session-input')).toEqual([]);
  expect(record).not.toHaveBeenCalled();
});
it('retains verified prerequisite sessions while any dependent recipe input is unfinished', async () => {
  const parent = await createSession({ title: 'Verified prerequisite' });
  const child = await createSession({ title: 'Dependent input' });
  const runId = randomUUID(), replyId = randomUUID();
  const workflow = { runId, recipeSha256: 'a'.repeat(64), total: 2, maxParallel: 1,
    dependsOn: [], checks: [{ kind: 'acceptance' as const }] };
  const first = receipt(parent.id, { sessionId: parent.id,
    workflow: { ...workflow, step: 'first', order: 0 },
    acceptedNativeFinal: { replyId, acceptedAt: 200 },
    workflowReceipt: { version: 1, replyId, checkedAt: 300, status: 'verified',
      checks: [{ kind: 'acceptance', ok: true, detail: 'Original acceptance verified.' }] } });
  const next = receipt(child.id, { sessionId: child.id, state: 'queued', owner: null, messageId: undefined,
    deliveredAt: undefined, workflow: { ...workflow, step: 'next', order: 1, dependsOn: [first.id] } });
  await writeDurableNow('session-input', [first, next]);
  const summaries = [parent, child].map(session => ({ id: session.id, conversationId: session.conversationId, chatIds: session.chatIds }));
  expect(await retentionHeldInputSessions(summaries)).toEqual(new Set([parent.id, child.id]));
  await writeDurableNow('session-input', [first, { ...next, state: 'cancelled' }]);
  expect((await retentionHeldInputSessions(summaries)).has(parent.id)).toBe(false);
});

function receipt(sessionId: string, extra: Partial<InputEntry> = {}): InputEntry {
  return { id: randomUUID(), sessionId: null, deliveredSessionId: sessionId, conversationId: 'retained-chat',
    state: 'sent', owner: 'page', text: 'Authored task', deliveryText: 'Authored task\nTransport context',
    mode: 'auto', dueAt: 0, createdAt: 0, model: null, reasoningEffort: null,
    messageId: 'native-message', deliveredAt: 100, historyRecorded: true, ...extra };
}
it('retires deleted-session wrapped receipts before origin repair and keeps them gone across restarts', async () => {
  const session = await createSession({ title: 'Deleted', conversationId: 'retained-chat' });
  await writeDurableNow('session-input', [receipt(session.id, { stages: ['Do not resurrect a deleted task'] })]);
  await deleteSession(session.id);
  for (let restart = 0; restart < 3; restart++) {
    resetInputForTests();
    expect(await listInputs()).toEqual([]);
    expect(await readDurable('session-input')).toEqual([]);
  }
  expect(record).not.toHaveBeenCalled();
  expect(noteChatOrigin).not.toHaveBeenCalled();
  const activeEntries = (await fs.readdir(path.join(directory, 'sessions'))).filter(name => !name.startsWith('.'));
  expect(activeEntries).toEqual([]);
  // Manual deletion is absent from the active catalog across restart but remains exactly
  // recoverable through the hidden Undo area for 30 days.
  expect(await fs.stat(path.join(directory, 'sessions', '.deleted-sessions', session.id))).toBeTruthy();
});
it('retires a confirmed pending history retry when the session is deleted during the same process', async () => {
  const session = await createSession({ title: 'Removed later' });
  const row = receipt(session.id, { sessionId: session.id, historyRecorded: false });
  record.mockResolvedValueOnce(false);
  await writeDurableNow('session-input', [row]);
  expect(await listInputs()).toHaveLength(1);
  await deleteSession(session.id); record.mockClear();
  expect(await listInputs()).toEqual([]);
  expect(record).not.toHaveBeenCalled();
});
it('retires an ID-less exact ACK when its session is deleted before late identity arrives', async () => {
  const session = await createSession({ title: 'Deleted before native id' });
  const row = receipt(session.id, {
    sessionId: session.id,
    messageId: undefined,
    deliveredAt: Date.now(),
    historyRecorded: false
  });
  await writeDurableNow('session-input', [row]);
  await deleteSession(session.id);
  record.mockResolvedValue(false);

  expect(await listInputs()).toEqual([]);
  expect(await readDurable('session-input')).toEqual([]);
  expect(record).not.toHaveBeenCalled();
  expect(noteChatOrigin).not.toHaveBeenCalled();
});
it('retains corrupt history, unbound receipts and ambiguous browser sends', async () => {
  const session = await createSession({ title: 'Corrupt but recoverable' });
  resetSessionStoreForTests();
  const sessionPath = path.join(directory, 'sessions', session.id);
  for (const name of await fs.readdir(sessionPath)) await fs.rm(path.join(sessionPath, name), { recursive: true, force: true });
  await fs.writeFile(path.join(sessionPath, 'meta.json'), '{broken');
  const rows = [receipt(session.id, { sessionId: session.id }),
    receipt(session.id, { deliveredSessionId: null }),
    receipt('missing-session', { sessionId: 'missing-session', state: 'cancelled', messageId: undefined, deliveredAt: undefined })];
  await writeDurableNow('session-input', rows);
  expect((await listInputs()).map(row => row.id)).toEqual(rows.map(row => row.id));
  expect(record).toHaveBeenCalled();
  expect(await fs.readFile(path.join(sessionPath, 'meta.json'), 'utf8')).toBe('{broken');
});

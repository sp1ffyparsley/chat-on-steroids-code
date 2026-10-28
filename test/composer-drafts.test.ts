import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createComposerDraftStore } from '../src/main/composer-drafts.js';
import { createComposerDrafts } from '../src/renderer/composer-drafts.js';
import { initDurableStore, readDurableStrict, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { composerDraftSaveSchema, MAX_COMPOSER_DRAFT_BYTES, type ComposerDraftEntry,
  type ComposerDraftSnapshot } from '../src/shared/composer-drafts.js';
import type { InputAttachment, InputImage } from '../src/shared/input.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { stageInputAttachment, validateInputAttachments } from '../src/main/session/input-attachments.js';

const profile = 'test-account', session = 'session-1234', project = randomUUID();
const image: InputImage = { name: 'image.webp', dataUrl: 'data:image/webp;base64,YQ==' };
const file: InputAttachment = { id: randomUUID(), name: 'clip.mp4', size: 12, mimeType: 'video/mp4' };
let dir: string;
type Receipt = { id: string; text: string; sessionId: string | null; projectId: string | null;
  images?: InputImage[]; attachments?: InputAttachment[] };
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-composer-drafts-')); initDurableStore(dir);
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); resetDurableForTests(); resetSessionStoreForTests(); await fs.rm(dir, { recursive: true, force: true });
});
function entry(text = 'Unsent task'): ComposerDraftEntry {
  return { key: session, generation: randomUUID(), text, files: [file, image], updatedAt: Date.now() };
}
function snapshot(entries: ComposerDraftEntry[] = []): ComposerDraftSnapshot {
  return { version: 1, profileId: profile, revision: 0, selection: { sessionId: session, projectId: project }, entries };
}
function content(entries: ComposerDraftEntry[] = []) {
  return { selection: { sessionId: session, projectId: project }, entries };
}
function harness() {
  let active = profile, receipts: Receipt[] = [];
  const validate = vi.fn(async (_files: InputAttachment[]) => undefined);
  const write = vi.fn((value: ComposerDraftSnapshot) => writeDurableNow('composer-drafts', value));
  const store = createComposerDraftStore({ profileId: () => active,
    read: () => readDurableStrict('composer-drafts', MAX_COMPOSER_DRAFT_BYTES), write,
    inputs: async () => receipts, validateAttachments: validate });
  const status = vi.fn();
  const renderer = () => createComposerDrafts({ load: store.load, save: store.save, status });
  return { store, renderer, validate, write, status, setAccount: (id: string) => { active = id; },
    setReceipts: (value: Receipt[]) => { receipts = value; } };
}
function pending(value: ComposerDraftEntry): ComposerDraftEntry {
  return { ...value, pending: { inputId: randomUUID(), generation: value.generation, text: 'First prepared stage',
    files: value.files, sessionId: session, projectId: project } };
}
function receipt(value: ComposerDraftEntry): Receipt {
  return { id: value.pending!.inputId, text: value.pending!.text, sessionId: session, projectId: project,
    images: [image], attachments: [file] };
}

describe('Main composer draft authority', () => {
  it.each(['edit.main', 'edit_main'])('uses the canonical profile identity unchanged (%s)', async id => {
    vi.useFakeTimers(); const h = harness(); h.setAccount(id);
    const drafts = h.renderer(); expect(await drafts.load(id)).not.toBeNull();
    drafts.record(session, 'Account-scoped text', []); expect(await drafts.flush()).toBe(true);
    expect((await h.store.load()).snapshot.profileId).toBe(id);
    expect((await h.renderer().load(id))?.snapshot.entries[0]?.text).toBe('Account-scoped text');
  });
  it('round trips text, staged references, normalized images and exact selected identities across reloads', async () => {
    const h = harness(), original = entry();
    const saved = await h.store.save({ profileId: profile, expectedRevision: 0, snapshot: content([original]) });
    expect(saved.saved).toBe(true);
    expect((await h.store.load()).snapshot).toEqual({ ...snapshot([original]), revision: 1 });
    expect((await harness().store.load()).snapshot.entries).toEqual([original]);
    expect(await h.store.retainedAttachments()).toEqual(new Set([file.id]));
    expect(h.validate).toHaveBeenCalledWith([file]);
  });
  it('rejects a stale save and never acknowledges a failed durable write', async () => {
    const h = harness(), original = entry();
    await h.store.save({ profileId: profile, expectedRevision: 0, snapshot: content([original]) });
    const stale = await h.store.save({ profileId: profile, expectedRevision: 0, snapshot: content([]) });
    expect(stale).toMatchObject({ saved: false, snapshot: { entries: [original], revision: 1 } });
    h.write.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(h.store.save({ profileId: profile, expectedRevision: 1, snapshot: content([]) })).rejects.toThrow('storage unavailable');
    expect((await h.store.load()).snapshot.entries).toEqual([original]);
  });
  it('refuses corruption, cross-account state, unsupported file objects and content limits without replacing data', async () => {
    const h = harness(); await writeDurableNow('composer-drafts', snapshot([entry()]));
    h.setAccount('different-account'); await expect(h.store.load()).rejects.toThrow('account');
    h.setAccount(profile);
    const filePath = path.join(dir, 'state', 'composer-drafts.json');
    await fs.writeFile(filePath, '{broken-private-draft');
    await expect(h.store.load()).rejects.toThrow('Could not read');
    expect(await fs.readFile(filePath, 'utf8')).toBe('{broken-private-draft');
    const request = { profileId: profile, expectedRevision: 0, snapshot: content([entry()]) };
    expect(composerDraftSaveSchema.safeParse({ ...request, snapshot: content([{ ...entry(), files: [{ path: 'private-native-file' }] } as never]) }).success).toBe(false);
    expect(composerDraftSaveSchema.safeParse({ ...request, snapshot: content([entry('x'.repeat(96001))]) }).success).toBe(false);
  });
  it('fences an account change while the storage read is pending', async () => {
    let active = profile, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const write = vi.fn();
    const store = createComposerDraftStore({ profileId: () => active, read: async () => { await gate; return null; },
      write, inputs: async () => [], validateAttachments: async () => undefined });
    const loading = store.load(); await Promise.resolve(); active = 'other-account'; release();
    await expect(loading).rejects.toThrow('account changed'); expect(write).not.toHaveBeenCalled();
  });
  it('retains unchanged missing refs without blocking another text-only draft, while validating newly introduced refs', async () => {
    const h = harness(), original = entry(); await writeDurableNow('composer-drafts', snapshot([original]));
    h.validate.mockRejectedValue(new Error('not owned or missing'));
    expect(await h.store.load()).toMatchObject({ snapshot: { entries: [original] }, warnings: [{ key: session, reason: 'attachment_unavailable' }] });
    const unrelated = { ...entry('New text-only task'), key: 'new', files: [] };
    expect((await h.store.save({ profileId: profile, expectedRevision: 0, snapshot: content([original, unrelated]) })).saved).toBe(true);
    await expect(h.store.save({ profileId: profile, expectedRevision: 1,
      snapshot: content([original, { ...unrelated, files: [file] }]) })).rejects.toThrow('saved attachment is missing');
    expect((await h.store.load()).snapshot.entries.find(value => value.key === 'new')?.text).toBe('New text-only task');
    expect(await h.store.retainedAttachments()).toEqual(new Set([file.id]));
  });
  it('clears only exact durable admission evidence, partitioning mixed images and references', async () => {
    const h = harness(), original = pending(entry()); await writeDurableNow('composer-drafts', snapshot([original]));
    h.setReceipts([{ ...receipt(original), text: 'different operation' }]);
    expect((await h.store.load()).warnings).toEqual([{ key: session, reason: 'admission_unresolved' }]);
    h.setReceipts([receipt(original)]);
    expect((await h.store.load()).snapshot.entries).toEqual([]);
    expect((await h.store.load()).snapshot.revision).toBe(1);
  });
  it('reconciles admitted work without deleting newer typing, and retains original pending file custody', async () => {
    const h = harness(), original = pending(entry());
    const newer = { ...original, text: 'New follow-up', generation: randomUUID(), files: [] };
    await writeDurableNow('composer-drafts', snapshot([newer]));
    expect(await h.store.retainedAttachments()).toEqual(new Set([file.id]));
    h.setReceipts([receipt(original)]);
    const restored = (await h.store.load()).snapshot.entries[0]!;
    expect(restored.text).toBe('New follow-up'); expect(restored.pending).toBeUndefined();
  });
  it('retains real staged originals beyond prune age and validates owner metadata before saving', async () => {
    initSessionStore(dir);
    const staged = await stageInputAttachment({ name: 'kept.txt', bytes: new Uint8Array([1, 2, 3]) }, new Set());
    const store = createComposerDraftStore({ profileId: () => profile,
      read: () => readDurableStrict('composer-drafts', MAX_COMPOSER_DRAFT_BYTES),
      write: value => writeDurableNow('composer-drafts', value), inputs: async () => [], validateAttachments: validateInputAttachments });
    const saved = { ...entry(), files: [staged] };
    await store.save({ profileId: profile, expectedRevision: 0, snapshot: content([saved]) });
    const original = path.join(dir, 'input-attachments', staged.id), old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(original, old, old);
    await stageInputAttachment({ name: 'another.txt', bytes: new Uint8Array([4]) }, await store.retainedAttachments());
    expect(await fs.readFile(original)).toEqual(Buffer.from([1, 2, 3]));
    await expect(store.save({ profileId: profile, expectedRevision: 1,
      snapshot: content([{ ...saved, files: [{ ...staged, name: 'different-owner-metadata.txt' }] }]) })).rejects.toThrow('saved attachment is missing');
    expect((await store.load()).snapshot.entries[0]?.files).toEqual([staged]);
  });
});

describe('renderer draft races and admission', () => {
  it('merges typing made while the initial load is delayed', async () => {
    vi.useFakeTimers(); const h = harness(); await writeDurableNow('composer-drafts', snapshot([entry('saved old text')]));
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const drafts = createComposerDrafts({ load: async () => { await gate; return h.store.load(); }, save: h.store.save, status: h.status });
    const loading = drafts.load(profile); drafts.record(session, 'new typing', []); release(); await loading;
    expect(drafts.get(session)?.text).toBe('new typing'); await drafts.flush();
    expect((await h.store.load()).snapshot.entries[0]?.text).toBe('new typing');
  });
  it('keeps unknown pending custody discovered after early typing and clearing', async () => {
    vi.useFakeTimers(); const h = harness(), original = pending(entry()); await writeDurableNow('composer-drafts', snapshot([original]));
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const drafts = createComposerDrafts({ load: async () => { await gate; return h.store.load(); }, save: h.store.save, status: h.status });
    const loading = drafts.load(profile); drafts.record(session, 'new typing', []); drafts.record(session, '', []); release(); await loading;
    expect(drafts.get(session)?.text).toBe(''); expect(drafts.get(session)?.pending?.inputId).toBe(original.pending!.inputId);
    await drafts.flush(); expect((await h.store.load()).snapshot.entries[0]?.pending).toEqual(original.pending);
  });
  it('does not erase a newer generation when a save or admission ACK is late', async () => {
    vi.useFakeTimers(); const h = harness(), drafts = h.renderer(); await drafts.load(profile);
    const first = drafts.record(session, 'first task', [])!;
    const id = randomUUID(); expect(await drafts.beginAdmission(session, first.generation, { inputId: id, text: first.text, sessionId: session, projectId: project })).toBe(true);
    const newer = drafts.record(session, 'typed while waiting', [])!;
    expect(newer.pending?.inputId).toBe(id);
    expect(drafts.accepted(session, first.generation, id)).toBeUndefined();
    expect(drafts.get(session)?.text).toBe('typed while waiting'); expect(drafts.get(session)?.pending).toBeUndefined();
    await drafts.flush(); expect((await h.store.load()).snapshot.entries[0]?.generation).toBe(newer.generation);
  });
  it('preserves new typing across a delayed save response', async () => {
    vi.useFakeTimers(); const h = harness(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), saving = new Promise<void>(resolve => { entered = resolve; });
    let once = true;
    const drafts = createComposerDrafts({ load: h.store.load, save: async request => {
      if (once) { once = false; entered(); await gate; } return h.store.save(request);
    }, status: h.status });
    await drafts.load(profile); drafts.record(session, 'first', []); const flush = drafts.flush(); await saving;
    const latest = drafts.record(session, 'latest', [])!; release(); expect(await flush).toBe(true);
    expect(drafts.get(session)?.generation).toBe(latest.generation);
    expect((await h.store.load()).snapshot.entries[0]?.text).toBe('latest');
  });
  it('retains uncertainty across attachment edits, clear, retype and restart without replaying', async () => {
    vi.useFakeTimers(); const h = harness(), original = pending(entry()); await writeDurableNow('composer-drafts', snapshot([original]));
    let drafts = h.renderer(); await drafts.load(profile);
    drafts.record(session, 'edited', []); drafts.record(session, '', []); drafts.record(session, 'retyped', [image]);
    expect(drafts.get(session)?.pending).toEqual(original.pending);
    expect(await drafts.beginAdmission(session, drafts.get(session)!.generation, { inputId: randomUUID(), text: 'retyped', sessionId: session, projectId: project })).toBe(false);
    await drafts.flush(); drafts = h.renderer(); await drafts.load(profile);
    expect(drafts.get(session)?.pending?.inputId).toBe(original.pending!.inputId);
    expect(drafts.warning(session)).toContain('reconciliation');
    h.setReceipts([receipt(original)]); expect(await drafts.reconcile()).toBe(true);
    expect(drafts.get(session)?.text).toBe('retyped'); expect(drafts.get(session)?.pending).toBeUndefined();
  });
  it('clears the exact admitted generation after a new-chat binding moves it', async () => {
    vi.useFakeTimers(); const h = harness(), drafts = h.renderer(); await drafts.load(profile);
    const original = drafts.record('new', 'task', [])!, id = randomUUID();
    await drafts.beginAdmission('new', original.generation, { inputId: id, text: 'task', sessionId: null, projectId: null });
    drafts.move('new', session); expect(drafts.accepted('new', original.generation, id)).toBe(session);
    await drafts.flush(); expect((await h.store.load()).snapshot.entries).toEqual([]);
  });
  it('retains both drafts when a project/new-chat destination already has authored content', async () => {
    vi.useFakeTimers(); const h = harness(), drafts = h.renderer(); await drafts.load(profile);
    drafts.record('new', 'Unfiled task A', []); drafts.record(`project:${project}`, 'Project task B', [file]);
    expect(drafts.move(`project:${project}`, 'new')).toBe(false);
    expect(drafts.canMove('missing-source', 'new')).toBe(false);
    expect(drafts.get('new')?.text).toBe('Unfiled task A'); expect(drafts.get(`project:${project}`)?.text).toBe('Project task B');
    await drafts.flush(); expect((await h.store.load()).snapshot.entries).toHaveLength(2);
  });
  it('does not dispatch when storage fails and keeps current text available for a later explicit retry', async () => {
    vi.useFakeTimers(); const h = harness(), drafts = h.renderer(); await drafts.load(profile);
    const original = drafts.record(session, 'retained task', [])!;
    h.write.mockRejectedValueOnce(new Error('disk full'));
    expect(await drafts.beginAdmission(session, original.generation, { inputId: randomUUID(), text: original.text, sessionId: session, projectId: project })).toBe(false);
    expect(drafts.get(session)?.text).toBe(original.text); expect(drafts.get(session)?.pending).toBeUndefined();
    expect(h.status.mock.calls.some(([message]) => message.includes('could not be saved'))).toBe(true);
    expect(await drafts.flush()).toBe(true);
  });
  it('refuses to overwrite a different window editing the same target', async () => {
    vi.useFakeTimers(); const h = harness(), a = h.renderer(), b = h.renderer(); await a.load(profile); await b.load(profile);
    a.record(session, 'window A', []); b.record(session, 'window B', []); await a.flush();
    expect(await b.flush()).toBe(false); expect(b.get(session)?.text).toBe('window B');
    expect((await h.store.load()).snapshot.entries[0]?.text).toBe('window A');
  });
  it('does not release local unknown custody when a conflicting snapshot simply omits it', async () => {
    vi.useFakeTimers(); const h = harness(), original = pending(entry()); await writeDurableNow('composer-drafts', snapshot([original]));
    const drafts = h.renderer(); await drafts.load(profile); drafts.record(session, 'new typing', []);
    // Simulate another window replacing the same key. An absent pending marker
    // is not admission evidence and cannot grant permission to replay the old ID.
    await h.store.save({ profileId: profile, expectedRevision: 0, snapshot: content([entry('other window')]) });
    await drafts.reconcile();
    expect(drafts.get(session)?.text).toBe('new typing'); expect(drafts.get(session)?.pending?.inputId).toBe(original.pending!.inputId);
    expect(drafts.warning(session)).toContain('reconciliation');
    expect(await drafts.flush()).toBe(false);
    expect((await h.store.load()).snapshot.entries[0]?.text).toBe('other window');
  });
});

it('rejects malformed UTF-8 instead of replacing bytes inside an otherwise parseable draft', async () => {
  await fs.mkdir(path.join(dir, 'state'), { recursive: true });
  const value = Buffer.from([123, 34, 116, 101, 120, 116, 34, 58, 34, 255, 34, 125]);
  const target = path.join(dir, 'state', 'invalid-utf8.json'); await fs.writeFile(target, value);
  await expect(readDurableStrict('invalid-utf8', 100)).rejects.toThrow('Could not read invalid-utf8 state');
  expect(await fs.readFile(target)).toEqual(value);
});

it('bounds strict durable reads even if the file grows after stat, without truncating or rewriting it', async () => {
  await writeDurableNow('growing-draft', { small: true });
  const filePath = path.join(dir, 'state', 'growing-draft.json');
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args), stat = handle.stat.bind(handle);
    vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
      const before = await stat(); await fs.appendFile(filePath, 'x'.repeat(1000)); return before;
    });
    return handle;
  });
  await expect(readDurableStrict('growing-draft', 100)).rejects.toThrow('Could not read growing-draft state');
  expect((await fs.stat(filePath)).size).toBeGreaterThan(1000);
  await expect(readDurableStrict('growing-draft', 100)).rejects.toThrow('Could not read growing-draft state');
});

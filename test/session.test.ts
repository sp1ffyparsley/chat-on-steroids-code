/**
 * The session recorder, its store, and everything that reads back out of it.
 *
 * Real files in a real temp folder, because the properties that matter here are
 * durability properties: a torn line must cost one event and not a session, a
 * reopened conversation must continue its own log, and a handoff must survive the
 * pruner. None of that is observable against an in-memory fake.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { userTitle, automaticTitle } from '../src/main/session/title.js';
import { lineDelta, formatDelta } from '../src/main/diffstat.js';
import { chunkText } from '../src/main/mcp/tools.js';
import { emptyEvidence } from '../src/main/mcp/call-context.js';
import { getLog } from '../src/main/logger.js';
import { prependUserPrompt } from '../src/shared/user-prompt.js';
import {
  closeConversation,
  liveConversations,
  noteChatOrigin,
  onSessionChange,
  recordChatObservations,
  recordProgress,
  recordToolCall,
  receiptDurableOwnerUnique,
  repairDeterministicAttribution,
  rebindConversation,
  resetRecorderForTests,
  setCallAttributionListener,
  sessionForConversation,
} from '../src/main/session/recorder.js';
import {
  appendEvent,
  bindOwnedToolCallReceipt,
  autoCompactionReady,
  completeProcessCall,
  confirmLoopProgressReport,
  observeSessionModel,
  readSessionNativeCompletionFence,
  readSessionNativeCompletionFenceCheckpoint,
  compareAndSetSessionNativeCompletionFence,
  reopenSessionNativeCompletionFence,
  createSession,
  deletedSessionCount,
  deleteSession,
  emptyDeletedSessions,
  endSession,
  flushSessions,
  syncSessionJournal,
  findSessionByConversation,
  getSession,
  initSessionStore,
  latestHandoff,
  listDeletedSessions,
  listSessions,
  MAX_ASSET_BYTES,
  pruneSessions,
  permanentlyDeleteSession,
  readAsset,
  readEvents,
  readRecentEvents,
  readReceiptWitnessOccurrences,
  readLatestUserMessage,
  recordProcessCall,
  releaseLoopProgressReport,
  reserveLoopProgressReport,
  turnHasMcpCall,
  conversationHasMcpCallSince,
  readHandoff,
  rebindSession,
  replacementOf,
  renameSession,
  setSessionOrigin,
  setSessionWorkerLimit,
  reopenSession,
  restoreDeletedSession,
  resetSessionStoreForTests,
  rewriteUnattributedToolCalls,
  saveHandoff,
  sessionDirectoryMissing,
  sessionsRoot,
  unsetSessionRootForTests,
  upsertMessageEvent,
  workstreamActiveWork,
  writeAsset
} from '../src/main/session/store.js';
import { summarizeToolCall } from '../src/main/session/summarize.js';
import { HANDOFF_BRIEF_RULES, nativeHandoffPrompt } from '../src/main/session/handoff-prompt.js';
import {
  CHAT_ACTIVE_MS,
  CHAT_SILENCE_MS,
  estimateTokens,
  eventTokens,
  foldProgress,
  originTitle,
  tokenPressure,
  type SessionEvent,
  type SessionOrigin,
  type ToolOutcome
} from '../src/shared/session.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

async function enableRecording(record = true): Promise<void> {
  await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record } });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-session-');
  initConfigPath(dir);
  initSessionStore(dir);
  await enableRecording();
});

afterAll(async () => {
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(() => {
  vi.restoreAllMocks();
  resetRecorderForTests();
  resetSessionStoreForTests();
});

const evidence = (patch: Partial<ReturnType<typeof emptyEvidence>> = {}) => ({ ...emptyEvidence(), ...patch });

describe('private native completion fence checkpoints', () => {
  const conversation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const replacement = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const profile = 'profile-private-native';
  const fence = (sessionId: string, conversationId = conversation) => ({
    version: 1 as const, profileId: profile, sessionId, conversationId,
    documentId: 'document-original', navigationEpoch: 3, observedAt: Date.now() - 1000,
    reason: 'open-call' as const, calls: 2, codeCalls: 0, openCalls: 2, openCodeCalls: 0,
    sourceUserMessageId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    openRequestIds: ['wfr_shared', 'wfr_shared'], coreCallMessageIds: ['native-one', 'native-two'],
    allCoreRequestIds: ['wfr_shared', 'wfr_shared'], codeCallMessageIds: [], openCodeCallMessageIds: []
  });

  const scopedObservation = (at: number, label: string) => ({
    documentId: 'newer-document', navigationEpoch: 4, observedAt: at, turnId: label + '-turn',
    sourceUserMessageId: randomUUID(), reason: 'open-call' as const,
    calls: 1, codeCalls: 1, openCalls: 1, openCodeCalls: 1, settledFinalMessageId: null,
    openRequestIds: [label + '-workflow'], coreCallMessageIds: [label + '-parent'],
    allCoreRequestIds: [label + '-workflow'], codeCallMessageIds: [label + '-code'],
    openCodeCallMessageIds: [label + '-code'], answeredCodeCallMessageIds: []
  });

  it('uses the same private metadata CAS to retain independent scopes without replacing the original across reconstruction', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original)).toBe(true);
    const observations = [scopedObservation(original.observedAt + 1, 'b'), scopedObservation(original.observedAt + 2, 'c')];
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, original,
      { expected: [], next: observations })).toBe(true);
    const target = path.join(sessionsRoot(), session.id, 'meta.json');
    const accepted = await fs.readFile(target, 'utf8');
    const raw = JSON.parse(accepted);
    expect(raw.__nativeCompletionFences.version).toBe(2);
    expect(raw.__nativeCompletionFences.slots[conversation].fence).toEqual(original);
    expect(raw.__nativeCompletionFences.slots[conversation].observations).toEqual(observations);
    for (const update of [
      { expected: [], next: observations },
      { expected: observations, next: [{ ...observations[0]!, observedAt: original.observedAt }, observations[1]!] },
      { expected: observations, next: [observations[0]!] },
      { expected: observations, next: [...observations, { ...scopedObservation(original.observedAt, 'stale') }] },
      { expected: observations, next: [...observations, { ...scopedObservation(original.observedAt + 3, 'bad'), calls: 2 }] }
    ]) expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, original, update)).toBe(false);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, 'foreign-owner', original, original,
      { expected: observations, next: observations })).toBe(false);
    const large = Array.from({ length: 8 }, (_, at) => ({ ...scopedObservation(original.observedAt + 3 + at, 'large-' + at),
      calls: 200, codeCalls: 200, openCalls: 200, openCodeCalls: 200,
      openRequestIds: Array.from({ length: 200 }, (_, i) => ('r'.repeat(95) + i).padEnd(100, 'r')),
      allCoreRequestIds: Array.from({ length: 200 }, (_, i) => ('r'.repeat(95) + i).padEnd(100, 'r')),
      coreCallMessageIds: Array.from({ length: 200 }, (_, i) => ('p'.repeat(195) + i).padEnd(200, 'p')),
      codeCallMessageIds: Array.from({ length: 200 }, (_, i) => ('c'.repeat(195) + i).padEnd(200, 'c')),
      openCodeCallMessageIds: Array.from({ length: 200 }, (_, i) => ('c'.repeat(195) + i).padEnd(200, 'c')) }));
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, original,
      { expected: observations, next: [...observations, ...large] })).toBe(false);
    expect(await fs.readFile(target, 'utf8')).toBe(accepted);
    await flushSessions(); resetSessionStoreForTests();
    expect(await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile)).toMatchObject({
      version: 2, fence: original, observations });
    await renameSession(session.id, 'Ordinary metadata update preserves independent evidence');
    expect((await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile))?.observations).toEqual(observations);
    // Clearing/reopening the original never deletes diagnostic scopes or downgrades v2.
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, null)).toBe(true);
    expect(await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile)).toMatchObject({
      version: 2, fence: null, clearedFence: original, observations });
  });

  it('can capture the original and a newer complete scope in one initial metadata CAS', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    const observations = [scopedObservation(original.observedAt + 1, 'atomic-b')];
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original,
      { expected: [], next: observations })).toBe(true);
    expect(await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile)).toMatchObject({
      version: 2, fence: original, observations });
  });

  it('refuses scoped observation capacity and atomic publication failures without discarding accepted metadata', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original);
    const observations = Array.from({ length: 32 }, (_, i) => scopedObservation(original.observedAt + i + 1, 'scope-' + i));
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, original,
      { expected: [], next: observations })).toBe(true);
    const target = path.join(sessionsRoot(), session.id, 'meta.json');
    const accepted = await fs.readFile(target, 'utf8');
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, original,
      { expected: observations, next: [...observations, scopedObservation(original.observedAt + 99, 'overflow')] })).toBe(false);
    expect(await fs.readFile(target, 'utf8')).toBe(accepted);
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === target) throw Object.assign(new Error('fixture scoped publication failure'), { code: 'EIO' });
      return rename(from, to);
    });
    try {
      await expect(compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, null)).rejects.toThrow();
      expect(await fs.readFile(target, 'utf8')).toBe(accepted);
    } finally { failure.mockRestore(); }
    expect((await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile))?.observations).toEqual(observations);
  });

  it('durably preserves exact immutable identities across restart and unrelated summary writes without public leakage', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original)).toBe(true);
    original.coreCallMessageIds[0] = 'caller-mutated';
    await renameSession(session.id, 'Unrelated rename');
    await observeSessionModel(session.id, conversation, 'GPT-6', Date.now());
    await flushSessions();
    resetSessionStoreForTests();
    const restored = await readSessionNativeCompletionFence(session.id, conversation, profile);
    expect(restored).toMatchObject({ documentId: 'document-original', navigationEpoch: 3,
      coreCallMessageIds: ['native-one', 'native-two'], allCoreRequestIds: ['wfr_shared', 'wfr_shared'] });
    expect(JSON.stringify(await getSession(session.id))).not.toContain('native-one');
    expect(JSON.stringify(await listSessions())).not.toContain('__nativeCompletionFences');
    restored!.coreCallMessageIds![0] = 'reader-mutated';
    expect((await readSessionNativeCompletionFence(session.id, conversation, profile))?.coreCallMessageIds?.[0]).toBe('native-one');
  });

  it.each([false, true])('reads cold private metadata without hydrating canonical history or opening a retention owner (private: %s)', async hasPrivate => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    if (hasPrivate) await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original);
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: Date.now(),
      messageId: 'cold-history-must-not-load', message: { text: 'Retained history', chars: 16, truncated: false } });
    await endSession(session.id);
    resetSessionStoreForTests();
    const target = path.join(sessionsRoot(), session.id, 'meta.json');
    const before = await fs.readFile(target);
    const read = vi.spyOn(fs, 'readFile');
    const readdir = vi.spyOn(fs, 'readdir');
    const checkpoint = await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile);
    expect(checkpoint?.fence ?? null).toEqual(hasPrivate ? original : null);
    expect(await readSessionNativeCompletionFenceCheckpoint(session.id, replacement, profile)).toBeNull();
    expect(await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, 'foreign-profile')).toBeNull();
    expect(readdir).not.toHaveBeenCalled();
    expect(read.mock.calls.every(([file]) => ['meta.json', 'meta.backup.json'].includes(path.basename(String(file))))).toBe(true);
    read.mockRestore(); readdir.mockRestore();
    expect(await fs.readFile(target)).toEqual(before);
  });

  it('joins a hot rebind owner that appeared during the cold metadata read instead of returning the retired route', async () => {
    const newRoute = randomUUID();
    const session = await createSession({ conversationId: conversation });
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, fence(session.id));
    await endSession(session.id); resetSessionStoreForTests();
    const target = path.join(sessionsRoot(), session.id, 'meta.json');
    const readFile = fs.readFile.bind(fs);
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    let paused = false;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (
      file: Parameters<typeof fs.readFile>[0], ...args: unknown[]
    ) => {
      const body = await (readFile as (...params: unknown[]) => Promise<unknown>)(file, ...args);
      if (!paused && String(file) === target) { paused = true; reached(); await gate; }
      return body;
    }) as typeof fs.readFile);
    try {
      const staleRead = readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile);
      await entered;
      expect(await rebindSession(session.id, conversation, newRoute)).toBe(true);
      release();
      expect(await staleRead).toBeNull();
      expect(await readSessionNativeCompletionFenceCheckpoint(session.id, newRoute, profile)).toBeNull();
    } finally { release(); spy.mockRestore(); }
  });

  it('rejects cold unreadable metadata as unknown custody instead of an absent checkpoint', async () => {
    const session = await createSession({ conversationId: conversation });
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, fence(session.id));
    await endSession(session.id); resetSessionStoreForTests();
    const folder = path.join(sessionsRoot(), session.id);
    const readFile = fs.readFile.bind(fs);
    const readdir = vi.spyOn(fs, 'readdir');
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (
      file: Parameters<typeof fs.readFile>[0], ...args: unknown[]
    ) => {
      if (String(file).startsWith(path.join(folder, 'meta')))
        throw Object.assign(new Error('private read failure'), { code: 'EACCES' });
      return (readFile as (...params: unknown[]) => Promise<unknown>)(file, ...args);
    }) as typeof fs.readFile);
    try {
      await expect(readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile)).rejects.toThrow('metadata could not be read');
      expect(readdir).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); readdir.mockRestore(); }
  });

  it.each(['absent', 'damaged'] as const)('refuses unavailable cold metadata rather than treating it as a validated legacy checkpoint (%s)', async state => {
    const session = await createSession({ conversationId: conversation });
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, fence(session.id));
    await endSession(session.id); resetSessionStoreForTests();
    const folder = path.join(sessionsRoot(), session.id);
    const originals = await Promise.all(['meta.json', 'meta.backup.json'].map(async name => {
      const target = path.join(folder, name);
      return { target, bytes: await fs.readFile(target) };
    }));
    const readdir = vi.spyOn(fs, 'readdir');
    try {
      for (const { target } of originals) {
        if (state === 'absent') await fs.unlink(target);
        else await fs.writeFile(target, '{torn');
      }
      await expect(readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile)).rejects.toThrow('checkpoint metadata is unavailable');
      expect(readdir).not.toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
      // These deliberately unrecoverable folders share the later catalog fixtures.
      // Restore their exact bytes even when the negative assertion itself fails.
      for (const { target, bytes } of originals) {
        await fs.writeFile(target, bytes);
        expect(await fs.readFile(target)).toEqual(bytes);
      }
      resetSessionStoreForTests();
    }
  });

  it.each(['legacy', 'cleared', 'pending', 'old-route', 'corrupt'] as const)(
    'keeps retention eligibility separate from cold checkpoint reads (%s)', async kind => {
      const isolated = await makeTempDir('clf-native-retention-');
      resetSessionStoreForTests(); initSessionStore(isolated);
      try {
        const session = await createSession({ conversationId: conversation });
        const original = fence(session.id);
        if (kind !== 'legacy') await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original);
        if (kind === 'cleared') await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, null);
        if (kind === 'old-route') await rebindSession(session.id, conversation, replacement);
        await endSession(session.id);
        resetSessionStoreForTests();
        const target = path.join(sessionsRoot(), session.id, 'meta.json');
        const meta = JSON.parse(await fs.readFile(target, 'utf8'));
        meta.updatedAt = Date.now() - 90 * 24 * 60 * 60_000;
        if (kind === 'corrupt') meta.__nativeCompletionFences.version = 99;
        await fs.writeFile(target, JSON.stringify(meta));
        const later = new Date(Date.now() + 1000);
        await fs.utimes(target, later, later);
        const currentRoute = kind === 'old-route' ? replacement : conversation;
        if (kind === 'corrupt') {
          await expect(readSessionNativeCompletionFenceCheckpoint(session.id, currentRoute, profile)).rejects.toThrow('native completion');
        } else {
          await readSessionNativeCompletionFenceCheckpoint(session.id, currentRoute, profile);
        }
        const held = kind === 'pending' || kind === 'old-route' || kind === 'corrupt';
        expect(await pruneSessions(30)).toBe(held ? 0 : 1);
        if (held) await expect(fs.stat(target)).resolves.toBeTruthy();
        else await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        resetSessionStoreForTests(); initSessionStore(dir);
        await removeTempDir(isolated);
      }
    });

  it('compares every original field before clear and refuses stale replacement or new source identity', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original)).toBe(true);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile,
      { ...original, navigationEpoch: 4 }, null)).toBe(false);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original,
      { ...original, sourceUserMessageId: replacement })).toBe(false);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, null)).toBe(true);
    resetSessionStoreForTests();
    expect(await readSessionNativeCompletionFence(session.id, conversation, profile)).toBeNull();
    expect(await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile)).toEqual({
      version: 1, fence: null, clearedFence: original, clearedAt: expect.any(Number) });
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original)).toBe(false);
  });

  it('retains the exact clear witness and only reopens that witness after a failed final source check', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original);
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, null);
    resetSessionStoreForTests();
    const checkpoint = await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile);
    expect(checkpoint?.clearedAt).toBeGreaterThanOrEqual(original.observedAt);
    expect(checkpoint?.clearedFence).toEqual(original);
    expect(await reopenSessionNativeCompletionFence(session.id, conversation, profile,
      { ...original, documentId: 'different-document' })).toBe(false);
    expect(await reopenSessionNativeCompletionFence(session.id, conversation, profile, original)).toBe(true);
    resetSessionStoreForTests();
    expect(await readSessionNativeCompletionFence(session.id, conversation, profile)).toEqual(original);
    expect(await reopenSessionNativeCompletionFence(session.id, conversation, profile, original)).toBe(false);
    expect(JSON.stringify(await getSession(session.id))).not.toContain('native-one');
  });

  it('retains old-route slots on rebind while admitting the new current route without granting old-route authority', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original);
    expect(await rebindSession(session.id, conversation, replacement)).toBe(true);
    expect(await readSessionNativeCompletionFence(session.id, conversation, profile)).toBeNull();
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, null)).toBe(false);
    const next = fence(session.id, replacement);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, replacement, profile, null, next)).toBe(true);
    resetSessionStoreForTests();
    expect(await readSessionNativeCompletionFence(session.id, replacement, profile)).toEqual(next);
    const raw = JSON.parse(await fs.readFile(path.join(sessionsRoot(), session.id, 'meta.json'), 'utf8'));
    expect(JSON.stringify(raw.__nativeCompletionFences)).toContain(conversation);
    expect(JSON.stringify(await getSession(session.id))).not.toContain('__nativeCompletionFences');
  });

  it('preserves unknown arrays and only enriches previously unknown matching identity arrays', async () => {
    const session = await createSession({ conversationId: conversation });
    const complete = fence(session.id);
    const partial = { ...complete, allCoreRequestIds: null };
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, partial)).toBe(true);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, partial, complete)).toBe(true);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, complete, partial)).toBe(false);
  });

  it.each(['open-call', 'open-code'] as const)('durably strengthens only the negative reason of the exact original %s census', async reason => {
    const session = await createSession({ conversationId: conversation });
    const original = { ...fence(session.id), reason,
      openCalls: reason === 'open-call' ? 2 : 0,
      codeCalls: 1, openCodeCalls: reason === 'open-code' ? 1 : 0,
      openRequestIds: reason === 'open-call' ? ['wfr_shared', 'wfr_shared'] : [],
      codeCallMessageIds: ['native-code'], openCodeCallMessageIds: reason === 'open-code' ? ['native-code'] : [] };
    const stronger = { ...original, reason: 'inventory-incomplete' as const };
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original)).toBe(true);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, stronger)).toBe(true);
    resetSessionStoreForTests();
    expect(await readSessionNativeCompletionFence(session.id, conversation, profile)).toEqual(stronger);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, stronger, original)).toBe(false);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, stronger,
      { ...stronger, sourceUserMessageId: replacement })).toBe(false);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, stronger,
      { ...stronger, calls: 0, openCalls: 0, coreCallMessageIds: [], allCoreRequestIds: [], openRequestIds: [] })).toBe(false);
  });

  it('keeps the exact preceding clear alongside a new pending source through restart and only replaces it on the new clear', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original);
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, null);
    const cleared = await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile);
    const newer = { ...original, observedAt: original.observedAt + 1, sourceUserMessageId: replacement };
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, newer)).toBe(true);
    resetSessionStoreForTests();
    expect(await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile)).toEqual({
      version: 1, fence: newer, clearedFence: original, clearedAt: cleared!.clearedAt });
    expect(await reopenSessionNativeCompletionFence(session.id, conversation, profile, original)).toBe(false);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, newer, null)).toBe(true);
    resetSessionStoreForTests();
    expect(await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile)).toEqual({
      version: 1, fence: null, clearedFence: newer, clearedAt: expect.any(Number) });
    expect(JSON.stringify(await getSession(session.id))).not.toContain('native-one');
  });

  it('preserves private custody through cold history projection rebuild and validated backup recovery', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original);
    await appendEvent(session.id, { kind: 'note', source: 'app', time: Date.now(),
      message: { text: 'Later durable history', chars: 21, truncated: false } });
    await flushSessions();
    const target = path.join(sessionsRoot(), session.id, 'meta.json');
    const raw = JSON.parse(await fs.readFile(target, 'utf8'));
    raw.__historySeq = 0;
    await fs.writeFile(target, JSON.stringify(raw));
    resetSessionStoreForTests();
    expect(await readSessionNativeCompletionFence(session.id, conversation, profile)).toEqual(original);
    await renameSession(session.id, 'Backup includes original fence');
    await fs.writeFile(target, '{torn');
    resetSessionStoreForTests();
    expect(await readSessionNativeCompletionFence(session.id, conversation, profile)).toEqual(original);
    expect(JSON.stringify(await getSession(session.id))).not.toContain('native-one');
  });

  it('rejects foreign owners, malformed native inventories and corrupt private schemas without erasing the original', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null,
      { ...original, sessionId: 'foreign-session' })).toBe(false);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null,
      { ...original, coreCallMessageIds: ['same', 'same'] })).toBe(false);
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original)).toBe(true);
    expect(await readSessionNativeCompletionFence(session.id, conversation, 'foreign-profile')).toBeNull();
    await flushSessions();
    const target = path.join(sessionsRoot(), session.id, 'meta.json');
    const raw = JSON.parse(await fs.readFile(target, 'utf8'));
    raw.__nativeCompletionFences.version = 99;
    await fs.writeFile(target, JSON.stringify(raw));
    resetSessionStoreForTests();
    await expect(readSessionNativeCompletionFence(session.id, conversation, profile)).rejects.toThrow('native completion');
    expect(JSON.stringify(await getSession(session.id))).not.toContain('__nativeCompletionFences');
    await expect(renameSession(session.id, 'Must not erase unknown schema')).rejects.toThrow('native completion');
    expect(JSON.parse(await fs.readFile(target, 'utf8')).__nativeCompletionFences.version).toBe(99);
  });

  it('does not publish a memory clear after a failed atomic metadata replacement', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original);
    const target = path.join(sessionsRoot(), session.id, 'meta.json');
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === target) throw Object.assign(new Error('fixture atomic publish failure'), { code: 'EIO' });
      return rename(from, to);
    });
    await expect(compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, null)).rejects.toThrow('fixture atomic');
    failure.mockRestore();
    expect(await readSessionNativeCompletionFence(session.id, conversation, profile)).toEqual(original);
    resetSessionStoreForTests();
    expect(await readSessionNativeCompletionFence(session.id, conversation, profile)).toEqual(original);
  });

  it('refuses an external private-schema replacement instead of overwriting it with a cached summary', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original);
    const target = path.join(sessionsRoot(), session.id, 'meta.json');
    const raw = JSON.parse(await fs.readFile(target, 'utf8'));
    raw.__nativeCompletionFences.slots[conversation].fence.documentId = 'external-document';
    await fs.writeFile(target, JSON.stringify(raw));
    await expect(readSessionNativeCompletionFence(session.id, conversation, profile)).rejects.toThrow('native completion');
    await expect(compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, null)).rejects.toThrow('native completion');
    expect(JSON.parse(await fs.readFile(target, 'utf8')).__nativeCompletionFences.slots[conversation].fence.documentId).toBe('external-document');
  });

  it('rechecks private custody after backup awaits before publishing a clear', async () => {
    const session = await createSession({ conversationId: conversation });
    const original = fence(session.id);
    await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null, original);
    const target = path.join(sessionsRoot(), session.id, 'meta.json');
    const rename = fs.rename.bind(fs);
    const replacement = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === path.join(sessionsRoot(), session.id, 'meta.backup.json')) {
        const raw = JSON.parse(await fs.readFile(target, 'utf8'));
        raw.__nativeCompletionFences.slots[conversation].fence.documentId = 'concurrent-owner';
        await fs.writeFile(target, JSON.stringify(raw));
      }
    });
    await expect(compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, original, null)).rejects.toThrow('before durable publication');
    replacement.mockRestore();
    expect(JSON.parse(await fs.readFile(target, 'utf8')).__nativeCompletionFences.slots[conversation].fence.documentId).toBe('concurrent-owner');
  });

  it('refuses the thirty-third private route slot without evicting unresolved original routes', async () => {
    const routes = Array.from({ length: 33 }, (_, index) => `${index.toString(16).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`);
    const session = await createSession({ conversationId: routes[0]! });
    for (let index = 0; index < routes.length; index++) {
      if (index > 0) expect(await rebindSession(session.id, routes[index - 1]!, routes[index]!)).toBe(true);
      expect(await compareAndSetSessionNativeCompletionFence(session.id, routes[index]!, profile, null,
        fence(session.id, routes[index]!))).toBe(index < 32);
    }
    const raw = JSON.parse(await fs.readFile(path.join(sessionsRoot(), session.id, 'meta.json'), 'utf8'));
    expect(Object.keys(raw.__nativeCompletionFences.slots)).toHaveLength(32);
    expect(raw.__nativeCompletionFences.slots[routes[0]!].fence.documentId).toBe('document-original');
  });

  it.each([
    { observedAt: Date.now() + 60_000 },
    { navigationEpoch: -1 },
    { openCalls: 3 },
    { allCoreRequestIds: ['only-one'] },
    { sourceUserMessageId: 'private authored text' },
    { documentId: 'document\nprivate-text' },
    { coreCallMessageIds: ['same', 'same'] },
    { version: 2 },
    { privateText: 'must never be persisted' }
  ])('rejects malformed or unbounded checkpoint fields %j', async patch => {
    const session = await createSession({ conversationId: conversation });
    expect(await compareAndSetSessionNativeCompletionFence(session.id, conversation, profile, null,
      { ...fence(session.id), ...patch } as ReturnType<typeof fence>)).toBe(false);
    expect(await readSessionNativeCompletionFenceCheckpoint(session.id, conversation, profile)).toBeNull();
  });
});

describe('canonical shard warning coalescing', () => {
  async function fixture() {
    const session = await createSession({ title: 'Unreadable shard diagnostics' });
    await appendEvent(session.id, { kind: 'note', source: 'app', time: 10,
      message: { text: 'retained legacy history', chars: 23, truncated: false } });
    const files: string[] = [];
    for (const messageId of ['damaged', 'neighbor']) {
      await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: 20,
        messageId, message: { text: messageId, chars: messageId.length, truncated: false } });
      files.push(path.join(sessionsRoot(), session.id, 'messages',
        createHash('sha256').update('user_message\u0000' + messageId).digest('hex') + '.json'));
    }
    await flushSessions();
    const valid = await fs.readFile(files[0]!);
    resetSessionStoreForTests();
    const warnings = () => getLog().filter(row => row.level === 'warn' &&
      row.message.includes('session ' + session.id + ':') && row.message.includes('canonical message shard'));
    return { session, file: files[0]!, neighbor: files[1]!, valid, warnings };
  }

  it('keeps real history readable without flooding repeated corrupt-shard warnings, and observes changed and repaired bytes immediately', async () => {
    const { session, file, neighbor, valid, warnings } = await fixture();
    const corrupt = Buffer.alloc(484);
    await fs.writeFile(file, corrupt);
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await readEvents(session.id);
      expect(rows.some(row => row.kind === 'note' && row.message.text === 'retained legacy history')).toBe(true);
      expect(rows.some(row => row.kind === 'user_message' && row.messageId === 'neighbor')).toBe(true);
      expect(rows.some(row => row.kind === 'user_message' && row.messageId === 'damaged')).toBe(false);
    }
    expect(warnings()).toHaveLength(1);
    expect(await fs.readFile(file)).toEqual(corrupt);
    const changed = Buffer.alloc(484, 1);
    changed.write('PRIVATE_INVALID_SHARD_CONTENT');
    await fs.writeFile(file, changed); // Same size, different invalid bytes.
    await readEvents(session.id);
    expect(warnings()).toHaveLength(2);
    await fs.writeFile(file, valid);
    expect((await readEvents(session.id)).some(row => row.kind === 'user_message' && row.messageId === 'damaged')).toBe(true);
    await fs.writeFile(file, changed);
    await readEvents(session.id);
    expect(warnings()).toHaveLength(3); // A positively repaired shard ended the old failure.
    await fs.writeFile(neighbor, changed);
    await readEvents(session.id);
    expect(warnings()).toHaveLength(4); // Identical bad bytes in another shard are independent.
    expect(warnings().every(row => row.message.includes('existing history retained, shard unchanged'))).toBe(true);
    expect(warnings().some(row => row.message.includes('PRIVATE_INVALID_SHARD_CONTENT'))).toBe(false);
  });

  it('reports persistent damage at the five-minute boundary and isolates store initialization and reset', async () => {
    const { session, file, warnings } = await fixture();
    await fs.writeFile(file, Buffer.alloc(484));
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await readEvents(session.id);
      now += 5 * 60_000 - 1;
      await readEvents(session.id);
      expect(warnings()).toHaveLength(1);
      now++;
      await readEvents(session.id);
      expect(warnings()).toHaveLength(2);
      now -= 10 * 60_000; // A clock rollback begins a fresh diagnostic window.
      for (let attempt = 0; attempt < 3; attempt++) await readEvents(session.id);
      expect(warnings()).toHaveLength(3); // Repeated reads in that window remain coalesced.
      initSessionStore(dir);
      await readEvents(session.id);
      expect(warnings()).toHaveLength(4);
      resetSessionStoreForTests();
      await readEvents(session.id);
      expect(warnings()).toHaveLength(5);
    } finally { clock.mockRestore(); }
  });

  it('keeps the diagnostic memory bounded while continuing to read every independent shard', async () => {
    const session = await createSession({ title: 'Bounded corrupt-shard diagnostics' });
    await flushSessions();
    resetSessionStoreForTests();
    const shards = path.join(sessionsRoot(), session.id, 'messages');
    await fs.mkdir(shards, { recursive: true });
    const fileAt = (index: number) => path.join(shards,
      createHash('sha256').update('bounded-shard-' + index).digest('hex') + '.json');
    const warnings = () => getLog().filter(row => row.level === 'warn' &&
      row.message.includes('session ' + session.id + ':') && row.message.includes('canonical message shard'));
    for (let index = 0; index < 129; index++) {
      await fs.writeFile(fileAt(index), Buffer.alloc(8));
      await readEvents(session.id);
      await fs.unlink(fileAt(index));
    }
    expect(warnings()).toHaveLength(129);
    await fs.writeFile(fileAt(128), Buffer.alloc(8));
    await readEvents(session.id);
    expect(warnings()).toHaveLength(129); // Recent unchanged failure still coalesces.
    await fs.unlink(fileAt(128));
    await fs.writeFile(fileAt(0), Buffer.alloc(8));
    await readEvents(session.id);
    expect(warnings()).toHaveLength(130); // Oldest diagnostic was evicted, never the file read.
  });

  it('distinguishes bounded read-error codes without logging arbitrary exception details', async () => {
    const { session, file, warnings } = await fixture();
    let code = 'EACCES';
    const readFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (
      target: Parameters<typeof fs.readFile>[0], ...args: unknown[]
    ) => {
      if (String(target) === file) throw Object.assign(new Error('PRIVATE_READ_FAILURE_DETAIL'), { code });
      return (readFile as (...params: unknown[]) => Promise<unknown>)(target, ...args);
    }) as typeof fs.readFile);
    try {
      await readEvents(session.id);
      await readEvents(session.id);
      expect(warnings()).toHaveLength(1);
      code = 'EBUSY';
      await readEvents(session.id);
      expect(warnings()).toHaveLength(2);
      code = 'PRIVATE_UNBOUNDED_FAILURE'.repeat(8);
      await readEvents(session.id);
      expect(warnings()).toHaveLength(3);
      code = 'another arbitrary error detail';
      await readEvents(session.id);
      expect(warnings()).toHaveLength(3);
      expect(warnings().some(row => /PRIVATE_|arbitrary/.test(row.message))).toBe(false);
    } finally { spy.mockRestore(); }
    expect((await readEvents(session.id)).some(row => row.kind === 'user_message' && row.messageId === 'damaged')).toBe(true);
  });
});


describe('owned execution receipt revisions', () => {
  async function original(process = false) {
    const session = await createSession({ conversationId: 'owned-receipt-revision' });
    const input = { time: 100, source: 'mcp' as const, kind: 'tool_call' as const, turnId: 'receipt-turn',
      call: { callId: 'owned-original', tool: 'read', requestId: 'wfr_owned_revision',
        conversationId: session.conversationId, attribution: 'request_id' as const,
        attributionMethod: 'request_id' as const, resultReceiptId: 'ba'.repeat(24),
        ...(process ? { process: { sessionId: 'owned-process' } } : {}),
        args: { text: '{}', chars: 2, truncated: false },
        result: { text: 'real result', chars: 11, truncated: false },
        outcome: 'ok' as const, durationMs: 1,
        summary: { title: 'read', tone: 'neutral' as const, kind: 'read' as const } } };
    if (process) await recordProcessCall(session.id, input);
    else await appendEvent(session.id, input);
    const row = (await readEvents(session.id, { requireIntegrity: true }))[0]!;
    if (row.kind !== 'tool_call') throw new Error('Missing original execution');
    const file = path.join(sessionsRoot(), session.id, 'messages',
      createHash('sha256').update('tool_call\u0000owned-original').digest('hex') + '.json');
    return { session, row, file, journal: path.join(sessionsRoot(), session.id, 'events.jsonl') };
  }

  it('survives a cold reopen with one immutable original and one native binding', async () => {
    const { session, row, journal } = await original();
    const raw = await fs.readFile(journal);
    expect(await bindOwnedToolCallReceipt(session.id, row, 'native-one', row.seq)).toBe(true);
    const bound = (await readEvents(session.id, { requireIntegrity: true }))[0]!;
    expect(await bindOwnedToolCallReceipt(session.id, row, 'native-two', bound.seq)).toBe(false);
    expect(await bindOwnedToolCallReceipt(session.id, row, 'native-one', bound.seq)).toBe(true);
    expect(await readRecentEvents(session.id, 20)).toHaveLength(1);
    await flushSessions();
    resetSessionStoreForTests();
    initSessionStore(dir);
    expect(await readReceiptWitnessOccurrences(session.id, row.call.resultReceiptId!))
      .toMatchObject([{ call: { nativeCallMessageId: 'native-one', requestId: row.call.requestId } }]);
    expect(await readEvents(session.id, { requireIntegrity: true })).toHaveLength(1);
    expect((await getSession(session.id))?.toolCalls).toBe(1);
    expect(await fs.readFile(journal)).toEqual(raw);
  });

  it.each(['args', 'result', 'requestId', 'conversationId', 'callId', 'torn'])
  ('rejects a %s canonical alteration instead of accepting or overwriting it', async field => {
    const { session, row, file } = await original();
    expect(await bindOwnedToolCallReceipt(session.id, row, 'native-one', row.seq)).toBe(true);
    const bound = (await readEvents(session.id, { requireIntegrity: true }))[0]!;
    const corrupt = structuredClone(bound);
    if (corrupt.kind !== 'tool_call') throw new Error('Missing bound execution');
    if (field === 'args' || field === 'result') corrupt.call[field].text = 'altered';
    else if (field !== 'torn') Object.assign(corrupt.call, { [field]: 'foreign-value' });
    const bytes = field === 'torn' ? '{"kind":"tool_call"' : JSON.stringify(corrupt);
    await fs.writeFile(file, bytes);
    await expect(readReceiptWitnessOccurrences(session.id, row.call.resultReceiptId!)).rejects.toThrow();
    if (field === 'torn')
      await expect(bindOwnedToolCallReceipt(session.id, row, 'native-one', bound.seq)).rejects.toThrow();
    else expect(await bindOwnedToolCallReceipt(session.id, row, 'native-one', bound.seq)).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  });

  it('does not acknowledge a failed canonical fsync and only retries the same committed binding', async () => {
    const { session, row, file } = await original();
    const open = fs.open.bind(fs);
    const injected = vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) === file && args[1] === 'r+')
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('simulated receipt sync failure'));
      return handle;
    }) as typeof fs.open);
    try {
      await expect(bindOwnedToolCallReceipt(session.id, row, 'native-one', row.seq)).rejects.toThrow(/sync failure/);
    } finally { injected.mockRestore(); }
    const committedButUnacknowledged = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(committedButUnacknowledged.call.nativeCallMessageId).toBe('native-one');
    const later = await appendEvent(session.id, { time: 200, source: 'extension', kind: 'user_message',
      messageId: 'newer-question-during-receipt-retry', message: { text: 'Keep my newer work.', chars: 19, truncated: false } });
    expect(later.seq).toBeGreaterThan(committedButUnacknowledged.seq);
    expect(await bindOwnedToolCallReceipt(session.id, row, 'native-two', later.seq)).toBe(false);
    expect(await bindOwnedToolCallReceipt(session.id, row, 'native-one', later.seq)).toBe(true);
    expect((await getSession(session.id))?.toolCalls).toBe(1);
  });

  it('does not overwrite a newer process completion from a stale binding snapshot', async () => {
    const { session, row, journal } = await original(true);
    const bytes = await fs.readFile(journal);
    await completeProcessCall(session.id, row.call.callId, { completedAt: 300, durationMs: 200, exitCode: 0 });
    expect(await bindOwnedToolCallReceipt(session.id, row, 'native-one', row.seq)).toBe(false);
    const completed = (await readEvents(session.id, { requireIntegrity: true }))[0]!;
    if (completed.kind !== 'tool_call') throw new Error('Missing process result');
    expect(completed.call.process?.completedAt).toBe(300);
    expect(await bindOwnedToolCallReceipt(session.id, completed, 'native-one', completed.seq)).toBe(true);
    expect(await readReceiptWitnessOccurrences(session.id, row.call.resultReceiptId!))
      .toMatchObject([{ call: { nativeCallMessageId: 'native-one', process: { completedAt: 300, exitCode: 0 } } }]);
    expect((await getSession(session.id))?.toolCalls).toBe(1);
    expect(await fs.readFile(journal)).toEqual(bytes);
  });
});

// The scale cases below already supply a synthetic directory listing and metadata.
// Use the real seed's current checkpoint shape for those rows, including its
// publication watermark. Thousands of empty physical directories add unrelated
// missing-file/recovery writes and leak into later tests if a scale case times out.
function mockCatalogCheckpointStats(prefix: string, metadata: Awaited<ReturnType<typeof fs.stat>>) {
  const rootPath = sessionsRoot(), realStat = fs.stat.bind(fs);
  return vi.spyOn(fs, 'stat').mockImplementation(
    (async (target: Parameters<typeof fs.stat>[0], ...args: unknown[]) => {
      const file = String(target), parent = path.dirname(file);
      if (path.dirname(parent) === rootPath && path.basename(parent).startsWith(prefix)) {
        if (path.basename(file) === 'meta.json') return metadata;
        throw Object.assign(new Error('synthetic empty catalog history'), { code: 'ENOENT' });
      }
      return (realStat as (...callArgs: unknown[]) => ReturnType<typeof fs.stat>)(target, ...args);
    }) as typeof fs.stat
  );
}
// ------------------------------------------------------------------- store

describe('session store', () => {

  it('keeps event reads on the journal queue while metadata stays batched and explicit custody still flushes', async () => {
    const summary = await createSession({ title: 'Read barrier', conversationId: 'read-barrier' });
    await flushSessions();
    const meta = path.join(sessionsRoot(), summary.id, 'meta.json');
    const before = await fs.readFile(meta, 'utf8');
    // Real I/O; only the batch timer is controlled so machine load cannot race this assertion.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await appendEvent(summary.id, { time: 100, source: 'extension', kind: 'user_message',
        messageId: 'read-barrier-user', message: { text: 'Keep the actual task', chars: 20, truncated: false } });
      await appendEvent(summary.id, { time: 101, source: 'extension', kind: 'turn_start', turnId: 'read-barrier-turn' });
      await appendEvent(summary.id, { time: 102, source: 'extension', kind: 'turn_end',
        turnId: 'read-barrier-turn', outcome: 'completed' });
      expect((await readEvents(summary.id)).map(event => event.kind)).toEqual(['user_message', 'turn_start', 'turn_end']);
      expect((await readRecentEvents(summary.id, 1))[0]?.kind).toBe('turn_end');
      expect((await readLatestUserMessage(summary.id))?.message.text).toBe('Keep the actual task');
      expect(await turnHasMcpCall(summary.id, 'read-barrier', 'read-barrier-turn')).toBe(false);
      expect(await conversationHasMcpCallSince(summary.id, 'read-barrier', 0, 'read-barrier-turn')).toBe(false);
      expect((await getSession(summary.id))?.lastTurnOutcome).toBe('completed');
      expect(await fs.readFile(meta, 'utf8')).toBe(before);
      // A reader joins an already queued batch write but does not cause one.
      await vi.advanceTimersByTimeAsync(1500);
      await readRecentEvents(summary.id, 1);
      const batched = await fs.readFile(meta, 'utf8');
      expect(batched).not.toBe(before);
      await appendEvent(summary.id, { time: 103, source: 'app', kind: 'note',
        message: { text: 'Retain result custody', chars: 21, truncated: false } });
      await syncSessionJournal(summary.id);
      const synced = await fs.readFile(meta, 'utf8');
      expect(synced).not.toBe(batched);
      await appendEvent(summary.id, { time: 104, source: 'app', kind: 'note',
        message: { text: 'Quit checkpoint', chars: 15, truncated: false } });
      await flushSessions();
      expect(await fs.readFile(meta, 'utf8')).not.toBe(synced);
    } finally {
      await flushSessions();
      vi.useRealTimers();
    }
  });



  it('finds only the exact or unique replacement, including after restart and a second move', async () => {
    const source = 'f8a00001-1111-4111-8111-111111111111';
    const middle = 'f8a00002-1111-4111-8111-111111111111';
    const destination = 'f8a00003-1111-4111-8111-111111111111';
    const owner = await createSession({ title: 'Retained creative task', conversationId: source });
    expect(await replacementOf(source, owner.id)).toBeNull();
    expect(await rebindSession(owner.id, source, middle)).toBe(true);
    expect(await rebindSession(owner.id, middle, destination)).toBe(true);
    expect(await replacementOf(source)).toEqual({ conversationId: destination, title: owner.title });
    await flushSessions(); resetSessionStoreForTests();
    expect(await replacementOf(source, owner.id)).toEqual({ conversationId: destination, title: owner.title });
    expect(await replacementOf(middle)).toEqual({ conversationId: destination, title: owner.title });
    expect(await replacementOf(destination)).toBeNull();
    const unrelated = await createSession({ title: 'Unrelated', conversationId: 'unrelated-guidance' });
    expect(await replacementOf(source, unrelated.id)).toBeNull();
  });

  it('never guesses a replacement from ambiguous historical lineages', async () => {
    const source = 'f8a00011-1111-4111-8111-111111111111';
    const first = await createSession({ title: 'First owner', conversationId: source });
    await rebindSession(first.id, source, 'f8a00012-1111-4111-8111-111111111111');
    const second = await createSession({ title: 'Second owner', conversationId: source });
    await rebindSession(second.id, source, 'f8a00013-1111-4111-8111-111111111111');
    expect(await replacementOf(source)).toBeNull();
    expect(await replacementOf(source, first.id)).toEqual({ conversationId: 'f8a00012-1111-4111-8111-111111111111', title: 'First owner' });
    await flushSessions(); resetSessionStoreForTests();
    expect(await replacementOf(source)).toBeNull();
    expect(await replacementOf(source, second.id)).toEqual({ conversationId: 'f8a00013-1111-4111-8111-111111111111', title: 'Second owner' });
  });

  it('omits a generic replacement title', async () => {
    const source = 'f8a00021-1111-4111-8111-111111111111';
    const owner = await createSession({ title: 'ChatGPT session', conversationId: source });
    await rebindSession(owner.id, source, 'f8a00022-1111-4111-8111-111111111111');
    expect(await replacementOf(source, owner.id)).toEqual({ conversationId: 'f8a00022-1111-4111-8111-111111111111', title: '' });
  });

  it('withholds unbound replacement guidance when any lineage metadata is unreadable', async () => {
    const source = 'f8a00031-1111-4111-8111-111111111111';
    const destination = 'f8a00032-1111-4111-8111-111111111111';
    const owner = await createSession({ title: 'Exact owner survives incomplete catalog', conversationId: source });
    await rebindSession(owner.id, source, destination);
    await flushSessions(); resetSessionStoreForTests();
    const broken = path.join(sessionsRoot(), 'replacement-missing-metadata');
    await fs.mkdir(broken);
    try {
      expect(await replacementOf(source)).toBeNull();
      expect(await replacementOf(source, owner.id)).toEqual({ conversationId: destination, title: owner.title });
    } finally { await fs.rmdir(broken); }
    resetSessionStoreForTests();
    expect(await replacementOf(source)).toEqual({ conversationId: destination, title: owner.title });
  });

  it('keeps fallback titles on word and Unicode boundaries without losing custom task naming', () => {
    const text = 'Repair the production video export pipeline and its nested composition frames while preserving every editable source';
    const title = userTitle(text);
    expect(title.endsWith('…')).toBe(true);
    expect([...title].length).toBeLessThanOrEqual(80);
    expect(text.startsWith(title.slice(0, -1))).toBe(true);
    expect(text[title.length - 1]).toBe(' ');
    expect(userTitle('🙂'.repeat(100))).toBe('🙂'.repeat(79) + '…');
    expect([...userTitle('设置页面添加深色模式'.repeat(15))].length).toBe(80);
    expect(userTitle('Continue the SAME Scene Pack task using the saved context')).toBe('Scene Pack');
    const message = { kind: 'user_message', seq: 1, origin: 1, time: 1, message: { text, chars: text.length, truncated: false } } as never;
    expect(automaticTitle({ title } as never, message)).toBe(true);
    expect(automaticTitle({ title, titleSource: 'manual' } as never, message)).toBe(false);
  });

  it('proves a session missing only from an absent directory, never damaged metadata or an unreadable path', async () => {
    const session = await createSession({ title: 'metadata must fail closed', conversationId: 'metadata-fail-closed' });
    await flushSessions();
    const folder = path.join(sessionsRoot(), session.id);
    try {
      await fs.rm(path.join(folder, 'meta.json'), { force: true });
      await fs.rm(path.join(folder, 'meta.backup.json'), { force: true });
      expect(await sessionDirectoryMissing(session.id)).toBe(false);

      const lstat = fs.lstat.bind(fs);
      const spy = vi.spyOn(fs, 'lstat').mockImplementation((async (target, ...args) => {
        if (String(target) === folder) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return (lstat as (...params: unknown[]) => Promise<unknown>)(target, ...args);
      }) as typeof fs.lstat);
      try {
        expect(await sessionDirectoryMissing(session.id)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  it('answers a locked journal with a failure instead of stamping the session empty', async () => {
    const session = await createSession({ title: 'locked journal', conversationId: 'locked-journal' });
    await appendEvent(session.id, { time: 100, source: 'extension', kind: 'turn_start', turnId: 'work' });
    await appendEvent(session.id, { time: 200, source: 'extension', kind: 'turn_end', turnId: 'work', outcome: 'completed' });
    await flushSessions();
    const folder = path.join(sessionsRoot(), session.id);
    const metaBefore = await fs.readFile(path.join(folder, 'meta.json'), 'utf8');
    const journalBefore = await fs.readFile(path.join(folder, 'events.jsonl'), 'utf8');
    resetRecorderForTests();
    resetSessionStoreForTests();

    const stat = fs.stat.bind(fs);
    const spy = vi.spyOn(fs, 'stat').mockImplementation((async (target, ...args) => {
      if (String(target) === path.join(folder, 'events.jsonl')) {
        throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      }
      return stat(target, ...args);
    }) as typeof fs.stat);
    try {
      await expect(getSession(session.id)).rejects.toThrow(/locked/);
    } finally {
      spy.mockRestore();
    }

    expect(await fs.readFile(path.join(folder, 'events.jsonl'), 'utf8')).toBe(journalBefore);
    expect(await fs.readFile(path.join(folder, 'meta.json'), 'utf8')).toBe(metaBefore);
    resetSessionStoreForTests();
    expect((await readEvents(session.id)).map(event => event.seq)).toEqual([1, 2]);
  });

  it('does not cache a catalog pass that lost a session folder to a read failure', async () => {
    const present = await createSession({ title: 'readable', conversationId: 'catalog-readable' });
    const blocked = await createSession({ title: 'blocked', conversationId: 'catalog-blocked' });
    await flushSessions();
    resetRecorderForTests();
    resetSessionStoreForTests();

    const folder = path.join(sessionsRoot(), blocked.id);
    const readFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
      if (String(target).startsWith(path.join(folder, 'meta'))) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return (readFile as (...params: unknown[]) => Promise<unknown>)(target, ...args);
    }) as typeof fs.readFile);
    try {
      expect(await findSessionByConversation('catalog-readable', { requireUnique: true })).not.toBeNull();
      expect(await findSessionByConversation('catalog-blocked', { requireUnique: true })).toBeNull();
    } finally {
      spy.mockRestore();
    }

    expect((await findSessionByConversation('catalog-blocked', { requireUnique: true }))?.id).toBe(blocked.id);
    expect((await findSessionByConversation('catalog-readable', { requireUnique: true }))?.id).toBe(present.id);
  });

  it('reads a file sitting where a session folder would be as absent', async () => {
    const present = await createSession({ title: 'real session', conversationId: 'stray-neighbour' });
    await flushSessions();
    const stray = path.join(sessionsRoot(), '2026-09-25-deadbeef');
    await fs.writeFile(stray, 'not a session');
    try {
      resetRecorderForTests();
      resetSessionStoreForTests();
      expect((await findSessionByConversation('stray-neighbour', { requireUnique: true }))?.id).toBe(present.id);
      expect(await getSession('2026-09-25-deadbeef')).toBeNull();
    } finally {
      await fs.rm(stray, { force: true });
    }
  });

  it('flushes a summary and its checkpoint before the rename that publishes them', async () => {
    const steps: string[] = [];
    const label = (file: unknown): string =>
      String(file).includes('meta.backup.json') ? 'checkpoint' : String(file).includes('meta.json') ? 'summary' : '';
    const open = fs.open.bind(fs);
    const rename = fs.rename.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (file, ...args) => {
      const handle = await open(file as string, ...args as []);
      const named = label(file);
      if (named) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { steps.push(`flush ${named}`); return sync(); };
      }
      return handle;
    }) as typeof fs.open);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
      if (label(to)) steps.push(`publish ${label(to)}`);
      return rename(from as string, to as string);
    }) as typeof fs.rename);
    try {
      const session = await createSession({ title: 'durable summary' });
      await appendEvent(session.id, { time: 100, source: 'extension', kind: 'turn_start', turnId: 'work' });
      await flushSessions();
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
    }
    expect(steps.slice(0, 2)).toEqual(['flush summary', 'publish summary']);
    expect(steps).toContain('flush checkpoint');
    for (let i = 0; i < steps.length; i++) {
      if (steps[i]!.startsWith('publish')) {
        expect(steps.slice(0, i), `${steps[i]} was published unflushed`)
          .toContain(`flush ${steps[i]!.slice('publish '.length)}`);
      }
    }
  });

  it('keeps reviewable file-change totals on the durable session summary', async () => {
    const session = await createSession({ title: 'change totals', conversationId: 'change-totals-chat' });
    const startedAt = Date.now();
    await appendEvent(session.id, {
      time: startedAt, source: 'mcp', kind: 'tool_call',
      call: {
        callId: 'change-totals-call', tool: 'apply_patch', requestId: 'change-totals-request',
        conversationId: 'change-totals-chat', attribution: 'request_id', attributionMethod: 'request_id',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'done', truncated: false, chars: 4 }, outcome: 'ok', durationMs: 1,
        summary: { title: 'Edited 2 files', tone: 'good', kind: 'edit' },
        changes: [
          { path: '/project/a.ts', added: 12, removed: 3, approximate: false },
          { path: '/project/b.ts', added: 5, removed: 9, approximate: true }
        ]
      }
    });
    expect(await getSession(session.id)).toMatchObject({
      fileEdits: 2,
      linesAdded: 17,
      linesRemoved: 12,
      approximateFileChanges: true,
      lastFileChangeAt: startedAt + 1
    });
  });

  it('accumulates only unioned exact execution intervals without inferring turn or stale activity time', async () => {
    const conversationId = 'active-work-exact-chat';
    const session = await createSession({ title: 'active work exact', conversationId });
    let index = 0;
    const call = (time: number, durationMs: number, exact = true, tool = 'read') => ({
      time,
      source: 'mcp' as const,
      kind: 'tool_call' as const,
      call: {
        callId: `active-work-${++index}`,
        tool,
        requestId: exact ? `active-work-request-${index}` : null,
        conversationId: exact ? conversationId : null,
        attribution: exact ? 'request_id' as const : 'unattributed' as const,
        attributionMethod: exact ? 'request_id' as const : 'unattributed' as const,
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok' as const,
        durationMs,
        summary: { title: tool, tone: 'neutral' as const, kind: 'read' as const }
      }
    });

    expect(await getSession(session.id)).toMatchObject({ activeWorkMs: 0, activeWorkMeasurement: 'unknown' });
    await appendEvent(session.id, call(100, 100));       // [100, 200]
    await appendEvent(session.id, call(150, 100));       // [150, 250], +50
    await appendEvent(session.id, call(50, 100));        // [50, 150], +50 despite late arrival
    await appendEvent(session.id, call(0, 500, false));  // unattributed evidence is not exact work
    await appendEvent(session.id, call(250, 100, true, 'session_finish'));
    await appendEvent(session.id, { time: 0, source: 'extension', kind: 'turn_start', turnId: 'long-turn' });
    await appendEvent(session.id, { time: 10_000, source: 'extension', kind: 'turn_end', turnId: 'long-turn', outcome: 'completed' });

    expect(await getSession(session.id)).toMatchObject({ activeWorkMs: 200, activeWorkMeasurement: 'partial' });
  });

  it('preserves the exact active-work lower bound across restart and conversation rebind', async () => {
    const source = 'active-work-source';
    const destination = 'active-work-destination';
    const session = await createSession({ title: 'active work durable', conversationId: source });
    const append = (callId: string, time: number, durationMs: number) => appendEvent(session.id, {
      time, source: 'mcp', kind: 'tool_call', call: {
        callId, tool: 'read', requestId: `request-${callId}`, conversationId: source,
        attribution: 'request_id', attributionMethod: 'request_id',
        args: { text: '{}', truncated: false, chars: 2 }, result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok', durationMs, summary: { title: callId, tone: 'neutral', kind: 'read' }
      }
    });
    await append('durable-a', 1_000, 100);
    await append('durable-b', 1_050, 100);
    await flushSessions();
    resetSessionStoreForTests();

    expect(await getSession(session.id)).toMatchObject({ activeWorkMs: 150, activeWorkMeasurement: 'partial' });
    expect(await rebindSession(session.id, source, destination)).toBe(true);
    expect(await getSession(session.id)).toMatchObject({
      conversationId: destination,
      activeWorkMs: 150,
      activeWorkMeasurement: 'partial'
    });
    await flushSessions();
    resetSessionStoreForTests();
    expect(await getSession(session.id)).toMatchObject({ activeWorkMs: 150, activeWorkMeasurement: 'partial' });
  });

  it('unions overlapping exact work across a stable prime and its worker sessions', async () => {
    const prime = await createSession({ title: 'active family prime', conversationId: 'active-family-prime' });
    const workerA = await createSession({ title: 'active family worker a', conversationId: 'active-family-worker-a' });
    const workerB = await createSession({ title: 'active family worker b', conversationId: 'active-family-worker-b' });
    await setSessionOrigin(workerA.id, { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-1', task: 'a' }, workerA.title);
    await setSessionOrigin(workerB.id, { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-2', task: 'b' }, workerB.title);
    const exact = (conversationId: string, callId: string, time: number, durationMs: number, tool = 'read') => ({
      time, source: 'mcp' as const, kind: 'tool_call' as const, call: {
        callId, tool, requestId: `request-${callId}`, conversationId,
        attribution: 'request_id' as const, attributionMethod: 'request_id' as const,
        args: { text: '{}', truncated: false, chars: 2 }, result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok' as const, durationMs, summary: { title: callId, tone: 'neutral' as const, kind: 'read' as const }
      }
    });
    await appendEvent(prime.id, exact('active-family-prime', 'prime-a', 100, 200));       // [100,300]
    await appendEvent(workerA.id, exact('active-family-worker-a', 'worker-a', 200, 200)); // [200,400]
    await appendEvent(workerB.id, exact('active-family-worker-b', 'worker-b', 500, 100)); // [500,600]
    await appendEvent(workerB.id, exact('active-family-worker-b', 'finish', 600, 100, 'session_finish'));

    expect(await workstreamActiveWork([prime.id, workerA.id, workerB.id])).toMatchObject({
      activeWorkMs: 400,
      activeWorkMeasurement: 'partial'
    });
    expect(await workstreamActiveWork([prime.id, 'missing-session-0001'])).toMatchObject({
      sessionIds: [prime.id],
      activeWorkMs: 200,
      activeWorkMeasurement: 'partial'
    });
    await flushSessions();
    resetSessionStoreForTests();
    expect(await workstreamActiveWork([prime.id, workerA.id, workerB.id])).toMatchObject({
      activeWorkMs: 400,
      activeWorkMeasurement: 'partial'
    });
  });

  it('projects exact work from a cold historical session without making retention treat it as live', async () => {
    const session = await createSession({ title: 'cold active work projection', conversationId: 'cold-active-work-projection' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'cold-active-call',
        tool: 'read',
        requestId: 'cold-active-request',
        conversationId: 'cold-active-work-projection',
        attribution: 'request_id',
        attributionMethod: 'request_id',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok',
        durationMs: 125,
        summary: { title: 'cold active proof', tone: 'neutral', kind: 'read' }
      }
    });
    await flushSessions();
    resetSessionStoreForTests();

    const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(metaPath, JSON.stringify({
      ...meta,
      updatedAt: Date.now() - 90 * 24 * 3600_000
    }), 'utf8');

    expect(await workstreamActiveWork([session.id])).toMatchObject({
      sessionIds: [session.id],
      activeWorkMs: 125,
      activeWorkMeasurement: 'partial'
    });
    expect(await pruneSessions(30)).toBe(1);
    expect(await getSession(session.id)).toBeNull();
  });

  it('keeps one restart-safe progress threshold receipt on the stable session until exact delivery', async () => {
    const source = 'progress-threshold-source';
    const destination = 'progress-threshold-destination';
    const session = await createSession({ title: 'progress threshold', conversationId: source });
    const first = await reserveLoopProgressReport(session.id, {
      thresholdMs: 7_200_000,
      sourceTurnId: 'turn-two-hours',
      draftToken: 'goal-progress-token',
      reservedAt: 1_000
    });
    expect(first?.draftToken).toBe('goal-progress-token');
    expect((await reserveLoopProgressReport(session.id, {
      thresholdMs: 7_200_000,
      sourceTurnId: 'turn-two-hours',
      draftToken: 'goal-duplicate-token',
      reservedAt: 2_000
    }))?.draftToken).toBe('goal-progress-token');
    expect(await confirmLoopProgressReport(session.id, 'goal-wrong-token', 'message-1', 3_000)).toBeNull();

    await flushSessions();
    resetSessionStoreForTests();
    expect((await getSession(session.id))?.loopProgressReport?.pending).toMatchObject({
      thresholdMs: 7_200_000,
      sourceTurnId: 'turn-two-hours',
      draftToken: 'goal-progress-token'
    });
    expect(await rebindSession(session.id, source, destination)).toBe(true);
    expect(await confirmLoopProgressReport(session.id, 'goal-progress-token', 'message-1', 4_000)).toMatchObject({
      thresholdMs: 7_200_000,
      sourceTurnId: 'turn-two-hours',
      draftToken: 'goal-progress-token',
      messageId: 'message-1',
      confirmedAt: 4_000
    });
    expect(await confirmLoopProgressReport(session.id, 'goal-progress-token', 'message-1', 5_000)).toMatchObject({
      confirmedAt: 4_000
    });
    expect(await confirmLoopProgressReport(session.id, 'goal-progress-token', 'message-conflict', 6_000)).toBeNull();

    await flushSessions();
    resetSessionStoreForTests();
    const restored = (await getSession(session.id))?.loopProgressReport;
    expect(restored).toMatchObject({
      delivered: { thresholdMs: 7_200_000, messageId: 'message-1', confirmedAt: 4_000 }
    });
    expect(restored?.pending).toBeUndefined();
  });

  it('keeps a delayed two-hour threshold exclusive across restart, successor rebind, and newer safe boundaries', async () => {
    const source = 'progress-delay-source';
    const successor = 'progress-delay-successor';
    const session = await createSession({ title: 'delayed progress threshold', conversationId: source });
    expect(await reserveLoopProgressReport(session.id, {
      thresholdMs: 7_200_000,
      sourceTurnId: 'turn-threshold-a',
      draftToken: 'threshold-token-a',
      reservedAt: 1_000
    })).toMatchObject({ sourceTurnId: 'turn-threshold-a', draftToken: 'threshold-token-a' });

    await flushSessions();
    resetSessionStoreForTests();
    expect(await rebindSession(session.id, source, successor)).toBe(true);
    // A later safe boundary cannot overtake a delayed/ambiguous report. Replaying the exact
    // original source receives its original token; a newer source gets no second reservation.
    expect(await reserveLoopProgressReport(session.id, {
      thresholdMs: 7_200_000,
      sourceTurnId: 'turn-threshold-b',
      draftToken: 'threshold-token-b',
      reservedAt: 2_000
    })).toBeNull();
    expect(await reserveLoopProgressReport(session.id, {
      thresholdMs: 7_200_000,
      sourceTurnId: 'turn-threshold-a',
      draftToken: 'replacement-token-must-not-win',
      reservedAt: 3_000
    })).toMatchObject({ sourceTurnId: 'turn-threshold-a', draftToken: 'threshold-token-a' });

    await flushSessions();
    resetSessionStoreForTests();
    expect(await confirmLoopProgressReport(session.id, 'threshold-token-a', 'native-threshold-message', 4_000)).toMatchObject({
      thresholdMs: 7_200_000,
      sourceTurnId: 'turn-threshold-a',
      draftToken: 'threshold-token-a',
      messageId: 'native-threshold-message'
    });
    // Once the exact receipt advances the durable checkpoint, the old threshold cannot be
    // recreated by queue delay; only the next two-hour interval may reserve at a later boundary.
    expect(await reserveLoopProgressReport(session.id, {
      thresholdMs: 7_200_000,
      sourceTurnId: 'turn-threshold-b',
      draftToken: 'threshold-token-b',
      reservedAt: 5_000
    })).toBeNull();
    expect(await reserveLoopProgressReport(session.id, {
      thresholdMs: 14_400_000,
      sourceTurnId: 'turn-threshold-b',
      draftToken: 'threshold-token-b',
      reservedAt: 6_000
    })).toMatchObject({ thresholdMs: 14_400_000, sourceTurnId: 'turn-threshold-b' });
  });

  it('releases only a positively-unsent two-hour reservation so a later safe boundary can report it', async () => {
    const session = await createSession({ title: 'progress unsent release', conversationId: 'progress-unsent-source' });
    expect(await reserveLoopProgressReport(session.id, {
      thresholdMs: 7_200_000,
      sourceTurnId: 'turn-a',
      draftToken: 'token-a',
      reservedAt: 1_000
    })).not.toBeNull();
    expect(await releaseLoopProgressReport(session.id, 'wrong-token', 'turn-a')).toBe(false);
    expect(await releaseLoopProgressReport(session.id, 'token-a', 'wrong-turn')).toBe(false);
    expect((await getSession(session.id))?.loopProgressReport?.pending?.draftToken).toBe('token-a');
    expect(await releaseLoopProgressReport(session.id, 'token-a', 'turn-a')).toBe(true);
    expect((await getSession(session.id))?.loopProgressReport?.pending).toBeUndefined();
    expect(await reserveLoopProgressReport(session.id, {
      thresholdMs: 7_200_000,
      sourceTurnId: 'turn-b',
      draftToken: 'token-b',
      reservedAt: 2_000
    })).toMatchObject({ sourceTurnId: 'turn-b', draftToken: 'token-b' });
  });

  it('rebuilds legacy active-work metadata from exact history and leaves unsupported history unknown', async () => {
    const exact = await createSession({ title: 'active work legacy exact', conversationId: 'active-work-legacy-exact' });
    await appendEvent(exact.id, { time: 2_000, source: 'mcp', kind: 'tool_call', call: {
      callId: 'legacy-exact-call', tool: 'read', requestId: 'legacy-exact-request', conversationId: 'active-work-legacy-exact',
      attribution: 'request_id', attributionMethod: 'request_id',
      args: { text: '{}', truncated: false, chars: 2 }, result: { text: 'ok', truncated: false, chars: 2 },
      outcome: 'ok', durationMs: 75, summary: { title: 'read', tone: 'neutral', kind: 'read' }
    } });
    const unknown = await createSession({ title: 'active work legacy unknown', conversationId: 'active-work-legacy-unknown' });
    await appendEvent(unknown.id, { time: 3_000, source: 'extension', kind: 'turn_start', turnId: 'legacy-turn' });
    await appendEvent(unknown.id, { time: 9_000, source: 'extension', kind: 'turn_end', turnId: 'legacy-turn', outcome: 'completed' });
    await flushSessions();

    for (const id of [exact.id, unknown.id]) {
      const metaPath = path.join(sessionsRoot(), id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      delete meta.activeWorkMs;
      delete meta.activeWorkMeasurement;
      await fs.writeFile(metaPath, JSON.stringify(meta));
    }
    resetSessionStoreForTests();

    expect(await getSession(exact.id)).toMatchObject({ activeWorkMs: 75, activeWorkMeasurement: 'partial' });
    expect(await getSession(unknown.id)).toMatchObject({ activeWorkMs: 0, activeWorkMeasurement: 'unknown' });
    const migrated = JSON.parse(await fs.readFile(path.join(sessionsRoot(), exact.id, 'meta.json'), 'utf8'));
    expect(migrated).toMatchObject({ activeWorkMs: 75, activeWorkMeasurement: 'partial' });
  });

  it('adds exact background-process runtime when its canonical completion arrives', async () => {
    const conversationId = 'active-work-process';
    const session = await createSession({ title: 'active process work', conversationId });
    await recordProcessCall(session.id, {
      time: 100,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'active-process-call', tool: 'exec_command', requestId: 'active-process-request', conversationId,
        attribution: 'request_id', attributionMethod: 'request_id', process: { sessionId: 'process-1' },
        args: { text: '{}', truncated: false, chars: 2 }, result: { text: 'started', truncated: false, chars: 7 },
        outcome: 'ok', durationMs: 10, summary: { title: 'Started command', tone: 'neutral', kind: 'process' }
      }
    });
    expect(await getSession(session.id)).toMatchObject({ activeWorkMs: 10, activeWorkMeasurement: 'partial' });
    await completeProcessCall(session.id, 'active-process-call', { completedAt: 300, durationMs: 150, exitCode: 0 });
    expect(await getSession(session.id)).toMatchObject({ activeWorkMs: 160, activeWorkMeasurement: 'partial' });
    await flushSessions();
    resetSessionStoreForTests();
    expect(await getSession(session.id)).toMatchObject({ activeWorkMs: 160, activeWorkMeasurement: 'partial' });
  });

  it('uses original call time and exact conversation for late attribution health proof', async () => {
    const conversationId = 'health-current';
    const session = await createSession({ title: 'attribution health', conversationId });
    let index = 0;
    const append = (time: number, owner: string, turnId?: string, exact = true, source: 'mcp' | 'extension' = 'mcp') =>
      appendEvent(session.id, { time, source, kind: 'tool_call', turnId,
        call: { callId: `health-${++index}`, tool: 'read', requestId: `health-request-${index}`,
          conversationId: owner, attribution: exact ? 'request_id' : 'unattributed',
          attributionMethod: exact ? 'request_id' : 'unattributed',
          args: { text: '{}', truncated: false, chars: 2 }, result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok', durationMs: 1, summary: { title: 'read', tone: 'neutral', kind: 'read' } } });
    await append(999, conversationId); // Stored now, but started before the incident.
    await append(1_100, 'health-retired-source');
    await append(1_100, conversationId, 'older-turn');
    await append(1_100, conversationId, 'current-turn', false);
    await append(1_100, conversationId, 'current-turn', true, 'extension');
    expect(await conversationHasMcpCallSince(session.id, conversationId, 1_000, 'current-turn')).toBe(false);
    // Exact repaired work can have no local turn id, and need not be the newest append.
    await append(1_001, conversationId);
    await append(1_200, 'health-retired-source');
    expect(await conversationHasMcpCallSince(session.id, conversationId, 1_000, 'current-turn')).toBe(true);
    expect(await conversationHasMcpCallSince(session.id, conversationId, 1_002, 'current-turn')).toBe(false);
  });

  it('retains exact turn execution proof behind paginated historical attribution repairs', async () => {
    const conversationId = 'mcp-proof-conversation';
    const session = await createSession({ title: 'turn execution proof', conversationId });
    let callIndex = 0;
    const appendCall = (turnId: string | undefined, owner = conversationId, exact = true, source: 'mcp' | 'extension' = 'mcp') =>
      appendEvent(session.id, {
        time: 1_000, source, kind: 'tool_call', turnId,
        call: {
          callId: `proof-${++callIndex}`, tool: 'read', requestId: 'request-proof',
          conversationId: owner, attribution: exact ? 'request_id' : 'unattributed',
          attributionMethod: exact ? 'request_id' : 'unattributed',
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok', durationMs: 1,
          summary: { title: 'read', tone: 'neutral', kind: 'read' }
        }
      });
    await appendCall('older-turn');
    expect(await turnHasMcpCall(session.id, conversationId, 'source-turn')).toBe(false);
    await appendCall('source-turn', 'foreign-conversation');
    await appendCall('source-turn', conversationId, false);
    await appendCall('source-turn', conversationId, true, 'extension');
    expect(await turnHasMcpCall(session.id, conversationId, 'source-turn')).toBe(false);
    await appendCall('source-turn');
    // More than one presentation page of repairs must neither hide proof nor restart scans.
    for (let index = 0; index < 105; index++) await appendCall(undefined);
    expect(await turnHasMcpCall(session.id, conversationId, 'source-turn')).toBe(true);
    await appendCall('newer-turn', 'foreign-conversation');
    expect(await turnHasMcpCall(session.id, conversationId, 'source-turn')).toBe(true);
    const openFile = vi.spyOn(fs, 'open');
    try {
      expect(await turnHasMcpCall(session.id, conversationId, 'newer-turn')).toBe(false);
      expect(openFile.mock.calls.filter(([file]) => String(file).endsWith('events.jsonl'))).toHaveLength(1);
    } finally {
      openFile.mockRestore();
    }
    await fs.appendFile(path.join(sessionsRoot(), session.id, 'events.jsonl'),
      JSON.stringify({ seq: 9999, time: 1000, kind: 'tool_call', source: 'mcp', turnId: 'source-turn' }) + '\n');
    expect(await turnHasMcpCall(session.id, conversationId, 'source-turn')).toBe(true);
  });

  it('preserves tool calls appended after an unattributed repair snapshot', async () => {
    const summary = await createSession({ title: 'Unattributed activity', conversationId: null });
    const call = (callId: string, time: number) => ({
      time,
      source: 'mcp' as const,
      kind: 'tool_call' as const,
      call: {
        callId,
        tool: 'read',
        attribution: 'unattributed' as const,
        requestId: null,
        conversationId: null,
        attributionMethod: 'unattributed' as const,
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok' as const,
        durationMs: 1,
        summary: { title: callId, tone: 'neutral' as const, kind: 'read' as const }
      }
    });

    await appendEvent(summary.id, call('keep-old-unknown', 1));
    await appendEvent(summary.id, call('remove-old-repaired', 2));
    const snapshot = await readEvents(summary.id);
    const scannedThroughSeq = Math.max(...snapshot.map((event) => event.seq));
    const keptFromSnapshot = snapshot.filter(
      (event): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
        event.kind === 'tool_call' && event.call.callId === 'keep-old-unknown'
    );

    // This append lands after the repair decided its old keep/remove set, but before the rewrite
    // is enqueued. It used to be silently discarded when the old snapshot replaced events.jsonl.
    await appendEvent(summary.id, call('keep-concurrent-new', 3));
    await rewriteUnattributedToolCalls(summary.id, keptFromSnapshot, scannedThroughSeq);

    const callIds = (await readEvents(summary.id))
      .filter((event): event is Extract<SessionEvent, { kind: 'tool_call' }> => event.kind === 'tool_call')
      .map((event) => event.call.callId);
    expect(callIds).toEqual(['keep-old-unknown', 'keep-concurrent-new']);

    // The rewrite re-sequences its retained snapshot. A subsequent append must continue after it
    // rather than reusing the concurrent row's sequence number.
    await appendEvent(summary.id, call('keep-after-rewrite', 4));
    const after = (await readEvents(summary.id)).filter((event) => event.kind === 'tool_call');
    expect(after.map((event) => event.call.callId)).toEqual([
      'keep-old-unknown',
      'keep-concurrent-new',
      'keep-after-rewrite'
    ]);
    expect(new Set(after.map((event) => event.seq)).size).toBe(3);
  });

  it('keeps late headered Core results in source custody until the exact target journal and overflow asset are durable', async () => {
    const { observeRequestCorrelation } = await import('../src/main/session/correlation.js');
    const store = await import('../src/main/session/store.js');
    const conversationId = 'late-repair-durable-owner';
    const requestId = 'wfr-late-repair-durable';
    const source = await createSession({ title: 'Unattributed activity', conversationId: null });
    const target = await createSession({ title: 'late repair destination', conversationId });
    const body = 'exact returned Core result asset\n'.repeat(420);
    const bytes = Buffer.from(body, 'utf8');
    const asset = await writeAsset(source.id, bytes, 'text/plain');
    expect(observeRequestCorrelation({ requestId, conversationId, sessionId: target.id,
      messageId: 'native-late-repair-read', tool: 'read', observedAt: Date.now(),
      turnId: 'turn-late-repair-durable' })).toBe('stored');
    const callId = 'late-repair-durable-call';
    await appendEvent(source.id, { time: Date.now(), source: 'mcp', kind: 'tool_call',
      turnId: 'turn-late-repair-durable', call: {
        callId, tool: 'read', attribution: 'unattributed', requestId,
        conversationId: null, attributionMethod: 'unattributed',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: body.slice(0, 32), truncated: true, chars: body.length, assetId: asset.id },
        outcome: 'ok', durationMs: 1,
        summary: { title: 'read', tone: 'neutral', kind: 'read' }
      } });

    const sync = store.syncSessionJournal.bind(store);
    let syncCalls = 0;
    const barrier = vi.spyOn(store, 'syncSessionJournal').mockImplementation(async id => {
      syncCalls++;
      if (syncCalls === 2) throw new Error('injected target journal sync failure');
      return sync(id);
    });
    try {
      await expect(repairDeterministicAttribution()).rejects.toThrow('injected target journal sync failure');
    } finally {
      barrier.mockRestore();
    }

    const heldSource = await readEvents(source.id, { kinds: ['tool_call'], requireIntegrity: true });
    expect(heldSource).toHaveLength(1);
    expect(heldSource[0]?.kind === 'tool_call' && heldSource[0].call.callId).toBe(callId);
    const copiedBeforeRetry = await readEvents(target.id, { kinds: ['tool_call'], requireIntegrity: true });
    expect(copiedBeforeRetry).toHaveLength(1);
    expect(copiedBeforeRetry[0]?.kind === 'tool_call' && copiedBeforeRetry[0].call).toMatchObject({
      callId, requestId, conversationId, attributionMethod: 'request_id'
    });
    expect(await readAsset(source.id, asset.id)).toEqual(bytes);
    expect(await readAsset(target.id, asset.id)).toEqual(bytes);

    // The same original callId is retried after the barrier recovers. Its exact
    // durable destination row is reused, then source retirement may complete.
    await repairDeterministicAttribution();
    const finalTarget = (await readEvents(target.id, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter((row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call');
    expect(finalTarget).toHaveLength(1);
    expect(finalTarget[0]?.call).toMatchObject({ callId, requestId, conversationId,
      attributionMethod: 'request_id' });
    expect(finalTarget[0]?.call.resultReceiptId).toBeUndefined();
    expect(finalTarget[0]?.call.nativeCallMessageId).toBeUndefined();
    expect((await listSessions()).some(row => row.id === source.id)).toBe(false);
    expect(await readAsset(target.id, asset.id)).toEqual(bytes);
  });

  it('does not move a late request result into a successor session after the original conversation is rebound', async () => {
    const { observeRequestCorrelation } = await import('../src/main/session/correlation.js');
    const conversationId = 'late-repair-original-owner';
    const successorConversationId = 'late-repair-successor-owner';
    const requestId = 'wfr-late-repair-after-rebind';
    const source = await createSession({ title: 'Unattributed activity', conversationId: null });
    const target = await createSession({ title: 'late repair original session', conversationId });
    expect(observeRequestCorrelation({ requestId, conversationId, sessionId: target.id,
      messageId: 'native-late-repair-rebound-read', tool: 'read', observedAt: Date.now() }))
      .toBe('stored');
    const callId = 'late-repair-rebound-call';
    await appendEvent(source.id, { time: Date.now(), source: 'mcp', kind: 'tool_call', call: {
      callId, tool: 'read', attribution: 'unattributed', requestId,
      conversationId: null, attributionMethod: 'unattributed',
      args: { text: '{}', truncated: false, chars: 2 },
      result: { text: 'original result remains held', truncated: false, chars: 28 },
      outcome: 'ok', durationMs: 1,
      summary: { title: 'read', tone: 'neutral', kind: 'read' }
    } });
    expect(await rebindSession(target.id, conversationId, successorConversationId)).toBe(true);

    await repairDeterministicAttribution();

    const held = (await readEvents(source.id, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter((row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call');
    expect(held).toHaveLength(1);
    expect(held[0]?.call.callId).toBe(callId);
    expect((await readEvents(target.id, { kinds: ['tool_call'] })).filter(
      (row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call'
    )).toHaveLength(0);
  });

  it('keeps a late headered result in source custody when its request owner has duplicate current sessions', async () => {
    const { observeRequestCorrelation } = await import('../src/main/session/correlation.js');
    const conversationId = 'late-repair-ambiguous-current-owner';
    const requestId = 'wfr-late-repair-ambiguous-current-owner';
    const source = await createSession({ title: 'Unattributed activity', conversationId: null });
    const first = await createSession({ title: 'first ambiguous current owner', conversationId });
    const duplicate = await createSession({ title: 'second ambiguous current owner', conversationId });
    expect(first.id).not.toBe(duplicate.id);
    expect(observeRequestCorrelation({ requestId, conversationId, sessionId: first.id,
      messageId: 'native-late-repair-ambiguous-read', tool: 'read', observedAt: Date.now() }))
      .toBe('stored');
    const callId = 'late-repair-ambiguous-owner-call';
    await appendEvent(source.id, { time: Date.now(), source: 'mcp', kind: 'tool_call', call: {
      callId, tool: 'read', attribution: 'unattributed', requestId,
      conversationId: null, attributionMethod: 'unattributed',
      args: { text: '{}', truncated: false, chars: 2 },
      result: { text: 'must stay held while ownership is ambiguous', truncated: false, chars: 42 },
      outcome: 'ok', durationMs: 1,
      summary: { title: 'read', tone: 'neutral', kind: 'read' }
    } });

    await repairDeterministicAttribution();

    const held = (await readEvents(source.id, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter((row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call');
    expect(held).toHaveLength(1);
    expect(held[0]?.call.callId).toBe(callId);
    for (const owner of [first, duplicate]) {
      expect((await readEvents(owner.id, { kinds: ['tool_call'] })).filter(
        (row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call'
      )).toHaveLength(0);
    }
  });

  it('keeps a late headered result when its request correlation is natively ambiguous', async () => {
    const { observeRequestCorrelation, requestCorrelation } = await import('../src/main/session/correlation.js');
    const conversationId = 'late-repair-native-call-ambiguous';
    const requestId = 'wfr-late-repair-native-call-ambiguous';
    const source = await createSession({ title: 'Unattributed activity', conversationId: null });
    const target = await createSession({ title: 'late repair ambiguous request target', conversationId });
    expect(observeRequestCorrelation({ requestId, conversationId, sessionId: target.id,
      messageId: 'native-first-tool-message', tool: 'read', observedAt: Date.now() })).toBe('stored');
    expect(observeRequestCorrelation({ requestId, conversationId, sessionId: target.id,
      messageId: 'native-second-tool-message', tool: 'read', observedAt: Date.now() + 1 })).toBe('same');
    expect(requestCorrelation(requestId)?.nativeCallAmbiguous).toBe(true);
    const callId = 'late-repair-ambiguous-native-call-result';
    await appendEvent(source.id, { time: Date.now(), source: 'mcp', kind: 'tool_call', call: {
      callId, tool: 'read', attribution: 'unattributed', requestId,
      conversationId: null, attributionMethod: 'unattributed',
      args: { text: '{}', truncated: false, chars: 2 },
      result: { text: 'cannot settle either native tool message', truncated: false, chars: 40 },
      outcome: 'ok', durationMs: 1,
      summary: { title: 'read', tone: 'neutral', kind: 'read' }
    } });

    await repairDeterministicAttribution();

    const held = (await readEvents(source.id, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter((row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call');
    expect(held).toHaveLength(1);
    expect(held[0]?.call.callId).toBe(callId);
    expect((await readEvents(target.id, { kinds: ['tool_call'] })).filter(
      (row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call'
    )).toHaveLength(0);
  });

  it('continues repairing independent buckets when one source journal cannot be synchronized', async () => {
    const { observeRequestCorrelation } = await import('../src/main/session/correlation.js');
    const store = await import('../src/main/session/store.js');
    const firstConversation = 'late-repair-source-sync-failure';
    const secondConversation = 'late-repair-independent-after-sync-failure';
    const firstRequest = 'wfr-late-repair-source-sync-failure';
    const secondRequest = 'wfr-late-repair-independent-after-sync-failure';
    const firstSource = await createSession({ title: 'Unattributed activity', conversationId: null });
    const secondSource = await createSession({ title: 'Unattributed activity', conversationId: null });
    const firstTarget = await createSession({ title: 'first repair target', conversationId: firstConversation });
    const secondTarget = await createSession({ title: 'second repair target', conversationId: secondConversation });
    expect(observeRequestCorrelation({ requestId: firstRequest, conversationId: firstConversation,
      sessionId: firstTarget.id, messageId: 'native-first-sync-failure', tool: 'read',
      observedAt: Date.now() })).toBe('stored');
    expect(observeRequestCorrelation({ requestId: secondRequest, conversationId: secondConversation,
      sessionId: secondTarget.id, messageId: 'native-second-after-sync-failure', tool: 'read',
      observedAt: Date.now() + 1 })).toBe('stored');
    const addCall = (sessionId: string, callId: string, requestId: string) => appendEvent(sessionId, {
      time: Date.now(), source: 'mcp', kind: 'tool_call', call: {
        callId, tool: 'read', attribution: 'unattributed', requestId,
        conversationId: null, attributionMethod: 'unattributed',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'recorded result for ' + callId, truncated: false, chars: callId.length + 22 },
        outcome: 'ok', durationMs: 1,
        summary: { title: 'read', tone: 'neutral', kind: 'read' }
      }
    });
    await addCall(firstSource.id, 'source-sync-failure-call', firstRequest);
    await addCall(secondSource.id, 'independent-repair-call', secondRequest);

    const realSync = store.syncSessionJournal.bind(store);
    let refusedSourceSync = false;
    const syncSpy = vi.spyOn(store, 'syncSessionJournal').mockImplementation(async sessionId => {
      if (sessionId === firstSource.id && !refusedSourceSync) {
        refusedSourceSync = true;
        throw new Error('injected source journal sync failure');
      }
      return realSync(sessionId);
    });
    try {
      const repair = await repairDeterministicAttribution();
      expect(repair.calls).toBe(1);
      expect(repair.sessions).toBe(1);
    } finally {
      syncSpy.mockRestore();
    }
    expect(refusedSourceSync).toBe(true);

    const held = (await readEvents(firstSource.id, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter((row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call');
    expect(held).toHaveLength(1);
    expect(held[0]?.call.callId).toBe('source-sync-failure-call');
    const repaired = (await readEvents(secondTarget.id, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter((row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call');
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.call).toMatchObject({ callId: 'independent-repair-call',
      requestId: secondRequest, conversationId: secondConversation, attributionMethod: 'request_id' });
    expect((await readEvents(firstTarget.id, { kinds: ['tool_call'] })).filter(
      (row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call'
    )).toHaveLength(0);
    expect((await listSessions()).some(row => row.id === secondSource.id)).toBe(false);
  });

  it('keeps conflicting source rows with the same call identity instead of partially migrating one', async () => {
    const { observeRequestCorrelation } = await import('../src/main/session/correlation.js');
    const conversationId = 'late-repair-duplicate-call-owner';
    const requestId = 'wfr-late-repair-duplicate-call-owner';
    const source = await createSession({ title: 'Unattributed activity', conversationId: null });
    const target = await createSession({ title: 'late repair duplicate call target', conversationId });
    expect(observeRequestCorrelation({ requestId, conversationId, sessionId: target.id,
      messageId: 'native-late-repair-duplicate-call', tool: 'read', observedAt: Date.now() }))
      .toBe('stored');
    const callId = 'duplicate-source-call-identity';
    const append = (result: string) => appendEvent(source.id, { time: Date.now(), source: 'mcp',
      kind: 'tool_call', call: {
        callId, tool: 'read', attribution: 'unattributed', requestId,
        conversationId: null, attributionMethod: 'unattributed',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: result, truncated: false, chars: result.length },
        outcome: 'ok', durationMs: 1,
        summary: { title: 'read', tone: 'neutral', kind: 'read' }
      } });
    await append('first conflicting result');
    await append('second conflicting result');

    await repairDeterministicAttribution();

    const held = (await readEvents(source.id, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter((row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call');
    expect(held).toHaveLength(2);
    expect(held.map(row => row.call.result.text)).toEqual([
      'first conflicting result', 'second conflicting result'
    ]);
    expect((await readEvents(target.id, { kinds: ['tool_call'] })).filter(
      (row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call'
    )).toHaveLength(0);
  });

  it.each([
    ['torn JSONL', '{"seq":99999,"kind":"tool_call","call":'],
    ['parseable non-tool history', JSON.stringify({ seq: 99999, time: 99999,
      source: 'extension', kind: 'page_tool', messageId: 'protected-saved-native',
      label: 'This protected history must not disappear' }) + '\n'],
    ['parseable invalid tool identity', JSON.stringify({ seq: 99999, time: 99999,
      source: 'mcp', kind: 'tool_call', call: { callId: 'unknown-original', tool: 'read' } }) + '\n']
  ])('refuses an Unattributed custody rewrite when a concurrent %s arrived after a valid snapshot', async (_kind, injected) => {
    const session = await createSession({ title: 'Unattributed activity', conversationId: null });
    await appendEvent(session.id, {
      time: 5, source: 'mcp', kind: 'tool_call',
      call: { callId: 'original-one', tool: 'read', attribution: 'unattributed',
        requestId: null, conversationId: null, attributionMethod: 'unattributed',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok', durationMs: 1,
        summary: { title: 'read', tone: 'neutral', kind: 'read' } }
    });
    const snapshot = await readEvents(session.id, { requireIntegrity: true });
    const source = path.join(sessionsRoot(), session.id, 'events.jsonl');
    await fs.appendFile(source, injected);
    const originalBytes = await fs.readFile(source);
    await expect(rewriteUnattributedToolCalls(session.id, [], Math.max(...snapshot.map(row => row.seq))))
      .rejects.toThrow(/integrity|unverified|protected/i);
    expect(await fs.readFile(source)).toEqual(originalBytes);
  });

  it('isolates exact returned-Core receipt custody from unrelated damaged legacy journal bytes, without forgiving a torn row containing the receipt', async () => {
    const receiptId = 'd6'.repeat(24);
    const unique = await createSession({ title: 'Unattributed activity', conversationId: null });
    const foreign = await createSession({ title: 'older unrelated historic data' });
    const call = {
      time: Date.now(), source: 'mcp' as const, kind: 'tool_call' as const,
      call: {
        callId: 'one-durable-original-transport-invocation', tool: 'read',
        attribution: 'unattributed' as const, attributionMethod: 'unattributed' as const,
        resultReceiptId: receiptId, requestId: null, conversationId: null,
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok' as const, durationMs: 1,
        summary: { title: 'read', tone: 'neutral' as const, kind: 'read' as const }
      }
    };
    await appendEvent(unique.id, call);
    const foreignFile = path.join(sessionsRoot(), foreign.id, 'events.jsonl');
    // A long-ago torn line with no possible matching random nonce is not
    // evidence that this new independent Core call happened in that session.
    await fs.appendFile(foreignFile, '{"seq":99999,"kind":"tool_call","broken":');
    expect(await readReceiptWitnessOccurrences(foreign.id, receiptId)).toEqual([]);
    expect((await readReceiptWitnessOccurrences(unique.id, receiptId))
      .map(event => event.call.callId)).toEqual([call.call.callId]);
    // A torn row that DOES contain the exact token could hide its competing
    // call identity. Fail closed without truncating or rewriting original bytes.
    const suspect = path.join(sessionsRoot(), unique.id, 'events.jsonl');
    await fs.appendFile(suspect, '\n{"kind":"tool_call","resultReceiptId":"' + receiptId + '"');
    const originalBytes = await fs.readFile(suspect);
    await expect(readReceiptWitnessOccurrences(unique.id, receiptId))
      .rejects.toThrow(/integrity|unverified/i);
    expect(await fs.readFile(suspect)).toEqual(originalBytes);
  });

  it('holds an otherwise unique native receipt when an indexed foreign session loses its recorded tool-call journal', async () => {
    // Earlier store tests intentionally preserve torn journals in the suite's
    // shared sandbox. Exact global receipt uniqueness needs a clean physical
    // catalog to distinguish this one missing-journal failure from old fixtures.
    const isolated = await makeTempDir('clf-receipt-journal-');
    initSessionStore(isolated);
    try {
    const receiptId = 'e7'.repeat(24);
    const targetConversation = 'receipt-journal-loss-target';
    const nativeMessage = 'receipt-journal-loss-native-message';
    const target = await createSession({ title: 'Receipt destination', conversationId: targetConversation });
    const foreign = await createSession({ title: 'Independent recorded session', conversationId: 'receipt-journal-loss-foreign' });
    const basicCall = {
      callId: 'receipt-journal-loss-original', tool: 'read',
      attribution: 'result_receipt' as const, attributionMethod: 'result_receipt' as const,
      resultReceiptId: receiptId, requestId: null, conversationId: targetConversation,
      nativeCallMessageId: nativeMessage,
      args: { text: '{}', truncated: false, chars: 2 },
      result: { text: 'ok', truncated: false, chars: 2 },
      outcome: 'ok' as const, durationMs: 1,
      summary: { title: 'read', tone: 'neutral' as const, kind: 'read' as const }
    };
    await appendEvent(target.id, { time: Date.now(), source: 'mcp', kind: 'tool_call', call: basicCall });
    await appendEvent(foreign.id, { time: Date.now(), source: 'mcp', kind: 'tool_call',
      call: { ...basicCall, callId: 'other-execution', resultReceiptId: 'af'.repeat(24),
        conversationId: 'receipt-journal-loss-foreign', attribution: 'request_id',
        attributionMethod: 'request_id', nativeCallMessageId: undefined }
    });
    await flushSessions();
    expect((await getSession(foreign.id))?.toolCalls).toBe(1);
    expect(await receiptDurableOwnerUnique(receiptId, target.id, nativeMessage, basicCall.callId)).toBe(true);
    const journal = path.join(sessionsRoot(), foreign.id, 'events.jsonl');
    const held = `${journal}.test-held`;
    await fs.rename(journal, held);
    try {
      // The foreign journal has no copy of this nonce, but its missing recorded
      // tool calls mean global receipt uniqueness can no longer be established.
      await expect(readReceiptWitnessOccurrences(foreign.id, receiptId))
        .rejects.toThrow(/journal|integrity|unverified/i);
      expect(await receiptDurableOwnerUnique(receiptId, target.id, nativeMessage, basicCall.callId)).toBe(false);
      expect((await readEvents(target.id, { kinds: ['tool_call'], requireIntegrity: true })).length).toBe(1);
    } finally {
      await fs.rename(held, journal);
    }
    expect(await receiptDurableOwnerUnique(receiptId, target.id, nativeMessage, basicCall.callId)).toBe(true);
    const originalBytes = await fs.readFile(journal);
    await fs.writeFile(journal, '');
    try {
      // A zero-byte replacement is also no evidence that the metadata's
      // recorded foreign tool calls disappeared legitimately.
      await expect(readReceiptWitnessOccurrences(foreign.id, receiptId))
        .rejects.toThrow(/journal|integrity|unverified/i);
      expect(await receiptDurableOwnerUnique(receiptId, target.id, nativeMessage, basicCall.callId)).toBe(false);
    } finally {
      await fs.writeFile(journal, originalBytes);
    }
    expect(await receiptDurableOwnerUnique(receiptId, target.id, nativeMessage, basicCall.callId)).toBe(true);
    } finally {
      resetSessionStoreForTests();
      initSessionStore(dir);
      await removeTempDir(isolated);
    }
  });

  it('synchronizes reads only with their target session instead of flushing every open session', async () => {
    const first = await createSession({ title: 'read target' });
    const other = await createSession({ title: 'unrelated writer' });
    await appendEvent(first.id, { time: 1000, source: 'app', kind: 'note', message: { text: 'a', truncated: false, chars: 1 } });
    await appendEvent(other.id, { time: 1001, source: 'app', kind: 'note', message: { text: 'b', truncated: false, chars: 1 } });

    await readEvents(first.id);
    const otherMetaAfterFullRead = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), other.id, 'meta.json'), 'utf8')
    ) as { events: number };
    expect(otherMetaAfterFullRead.events).toBe(0);

    await flushSessions();
    const otherMetaAfterExplicitFlush = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), other.id, 'meta.json'), 'utf8')
    ) as { events: number };
    expect(otherMetaAfterExplicitFlush.events).toBe(1);

    await appendEvent(first.id, { time: 1002, source: 'app', kind: 'note', message: { text: 'c', truncated: false, chars: 1 } });
    await appendEvent(other.id, { time: 1003, source: 'app', kind: 'note', message: { text: 'd', truncated: false, chars: 1 } });
    await readRecentEvents(first.id, 10);
    const otherMetaAfterRecentRead = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), other.id, 'meta.json'), 'utf8')
    ) as { events: number };
    expect(otherMetaAfterRecentRead.events).toBe(1);
  });

  it('pages backwards over journal and canonical messages without overlapping sequence boundaries', async () => {
    const session = await createSession({ title: 'backward history' });
    for (let i = 0; i < 12; i++) await appendEvent(session.id, {
      time: 1000 + i, source: 'extension', kind: 'user_message', messageId: `back-${i}`,
      message: { text: `message ${i}`, truncated: false, chars: 10 }
    } as never);
    const seen = new Set<number>();
    let before: number | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await readRecentEvents(session.id, 3, { before });
      if (!page.length) break;
      expect(page.length).toBeLessThanOrEqual(3);
      for (const event of page) { expect(seen.has(event.seq)).toBe(false); seen.add(event.seq); }
      before = Math.min(...page.map(event => event.seq));
    }
    expect(seen.size).toBeGreaterThanOrEqual(12);
  });
  it('counts stable legacy message revisions once when building a recent presentation window', async () => {
    const summary = await createSession({ title: 'legacy recent dedupe' });
    await appendEvent(summary.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'legacy-user-1',
      message: { text: 'original user request', truncated: false, chars: 21 }
    } as never);
    // Pre-canonical recordings could append every streaming snapshot of one stable ChatGPT
    // message to events.jsonl. The recent reader used those revisions as separate rows, so a
    // long answer could fill Goal Mode's entire recent window with copies of itself and hide
    // the user turn it was answering. Newest-first scanning should keep the latest revision
    // for a stable message id, but keep walking until it has the requested number of logical
    // messages.
    for (let index = 0; index < 8; index++) {
      await appendEvent(summary.id, {
        time: 1_001 + index,
        source: 'extension',
        kind: 'assistant_message',
        messageId: 'legacy-assistant-1',
        message: { text: `answer revision ${index}`, truncated: false, chars: 17 },
        final: index === 7
      } as never);
    }

    const recent = await readRecentEvents(summary.id, 2, {
      kinds: ['user_message', 'assistant_message']
    });
    expect(recent).toHaveLength(2);
    expect(recent.map((event) => event.kind)).toEqual(['user_message', 'assistant_message']);
    expect(recent[1]?.kind === 'assistant_message' ? recent[1].message.text : '').toBe('answer revision 7');
  });

  it('does not let a rewritten opening prompt displace a later failed boundary from a limit-one read', async () => {
    const summary = await createSession({ title: 'canonical boundary order' });
    const opening = await upsertMessageEvent(summary.id, {
      time: 1_000, source: 'extension', kind: 'user_message', messageId: 'opening',
      message: { text: 'original request', truncated: false, chars: 16 }
    });
    await appendEvent(summary.id, {
      time: 2_000, source: 'extension', kind: 'turn_end', turnId: 'failed-turn',
      outcome: 'failed', detail: 'Thinking failed'
    });
    await upsertMessageEvent(summary.id, {
      ...opening.event, time: 3_000,
      message: { text: 'original request with context', truncated: false, chars: 29 }
    });

    const [boundary] = await readRecentEvents(summary.id, 1, {
      kinds: ['turn_start', 'turn_end', 'user_message']
    });
    expect(boundary).toMatchObject({
      kind: 'turn_end', turnId: 'failed-turn', outcome: 'failed', detail: 'Thinking failed'
    });
  });

  it('pages rewritten human messages in the storage cursor domain without changing presentation order', async () => {
    const session = await createSession({ title: 'human history cursor domains' });
    const opening = await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension',
      time: 100, messageId: 'old-human', message: { text: 'original', chars: 8, truncated: false } });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension',
      time: 200, messageId: 'middle-human', message: { text: 'middle', chars: 6, truncated: false } });
    await upsertMessageEvent(session.id, { ...opening.event, time: 300,
      message: { text: 'original retained with context', chars: 30, truncated: false } });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension',
      time: 400, messageId: 'latest-human', message: { text: 'latest', chars: 6, truncated: false } });
    for (const cold of [false, true]) {
      if (cold) { await flushSessions(); resetSessionStoreForTests(); }
      const display = await readRecentEvents(session.id, 2, { kinds: ['user_message'] });
      expect(display.map(row => row.kind === 'user_message' && row.messageId))
        .toEqual(['middle-human', 'latest-human']);
      const newest = await readRecentEvents(session.id, 2, { kinds: ['user_message'], orderBySequence: true });
      const older = await readRecentEvents(session.id, 2, { kinds: ['user_message'], orderBySequence: true,
        before: Math.min(...newest.map(row => row.seq)) });
      expect([...older, ...newest].map(row => row.kind === 'user_message' && row.messageId))
        .toEqual(['middle-human', 'old-human', 'latest-human']);
      expect((await getSession(session.id))?.userMessages).toBe(3);
    }
  });

  it('negative-caches unknown current conversation lookups until that exact attachment can be created', async () => {
    const conversationId = `conv-missing-${Date.now()}`;
    const readdir = vi.spyOn(fs, 'readdir');
    const rootPath = sessionsRoot();
    const rootReads = (): number => readdir.mock.calls.filter(([target]) => String(target) === rootPath).length;

    // Restored in `finally`, like every other readdir spy in this file. Restoring on the
    // success path alone turns one failure here into a file-wide cascade: the spy survives
    // the failing test, the next test binds `realReaddir` to that leaked spy and installs its
    // own delegating to it, and the pair recurses until "Maximum call stack size exceeded" —
    // which is what the failure then reads as, in a different test, with the real one buried.
    try {
      expect(await findSessionByConversation(conversationId)).toBeNull();
      expect(rootReads()).toBe(1);
      expect(await findSessionByConversation(conversationId)).toBeNull();
      expect(rootReads()).toBe(1);

      const created = await createSession({ conversationId, title: 'now attached' });
      expect((await findSessionByConversation(conversationId))?.id).toBe(created.id);
      // The durable create updates the derived attachment catalog directly. No second global
      // metadata scan is needed merely to discover the session this process just committed.
      expect(rootReads()).toBe(1);
    } finally {
      readdir.mockRestore();
    }
  });

  it('invalidates a cached miss before an in-flight session creation can be hidden by it', async () => {
    const conversationId = `conv-creating-${Date.now()}`;
    expect(await findSessionByConversation(conversationId)).toBeNull();

    const realWriteFile = fs.writeFile.bind(fs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const creationVisible = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let paused = false;
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(
      (async (target: Parameters<typeof fs.writeFile>[0], ...args: unknown[]) => {
        if (!paused && String(target).endsWith('messages.json')) {
          paused = true;
          reached();
          await gate;
        }
        return (realWriteFile as (...callArgs: unknown[]) => ReturnType<typeof fs.writeFile>)(target, ...args);
      }) as typeof fs.writeFile
    );

    try {
      const creating = createSession({ conversationId, title: 'in flight' });
      await creationVisible;
      const visible = await findSessionByConversation(conversationId);
      expect(visible?.conversationId).toBe(conversationId);
      release();
      expect((await creating).id).toBe(visible?.id);
    } finally {
      release();
      writeSpy.mockRestore();
    }
  });

  it('finds an attachment beyond the 5,000-session maintenance scan cap', async () => {
    const seed = await createSession({ title: 'catalog seed', conversationId: null });
    const seedFile = path.join(sessionsRoot(), seed.id, 'meta.json');
    const seedSummary = JSON.parse(await fs.readFile(seedFile, 'utf8'));
    expect(seedSummary).toMatchObject({ __historySeq: 0, __canonicalProjection: 1, __tokenEstimate: 1 });
    const statSpy = mockCatalogCheckpointStats('catalog-', await fs.stat(seedFile));
    // Force the next lookup to rebuild from the durable catalog rather than the live seed.
    resetSessionStoreForTests();

    const conversationId = `conv-deep-catalog-${Date.now()}`;
    const names = Array.from({ length: 5001 }, (_, index) => `catalog-${String(index).padStart(5, '0')}`);
    const targetId = names[names.length - 1] as string;
    const realReaddir = fs.readdir.bind(fs);
    const realReadFile = fs.readFile.bind(fs);
    const rootPath = sessionsRoot();
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
      (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (String(target) === rootPath) return names;
        return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
      }) as typeof fs.readdir
    );
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(
      (async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        const file = String(target);
        const id = path.basename(path.dirname(file));
        if (file.endsWith('meta.json') && id.startsWith('catalog-')) {
          return JSON.stringify({
            ...seedSummary,
            id,
            title: id,
            conversationId: id === targetId ? conversationId : null,
            chatIds: id === targetId ? [conversationId] : []
          });
        }
        return (realReadFile as (...callArgs: unknown[]) => ReturnType<typeof fs.readFile>)(target, ...args);
      }) as typeof fs.readFile
    );

    try {
      expect((await findSessionByConversation(conversationId, { requireUnique: true }))?.id).toBe(targetId);
      expect(new Set(readSpy.mock.calls.filter(([file]) => String(file).endsWith('meta.json') &&
        path.basename(path.dirname(String(file))).startsWith('catalog-'))
        .map(([file]) => path.basename(path.dirname(String(file))))).size).toBe(5001);
    } finally {
      readSpy.mockRestore();
      readdirSpy.mockRestore();
      statSpy.mockRestore();
      resetSessionStoreForTests();
    }
  }, 90_000);

  it('does not cache a transient root scan failure as an authoritative empty attachment catalog', async () => {
    const conversationId = `conv-transient-catalog-${Date.now()}`;
    const created = await createSession({ conversationId, title: 'durable attachment' });
    await flushSessions();
    resetSessionStoreForTests();

    const rootPath = sessionsRoot();
    const realReaddir = fs.readdir.bind(fs);
    let failedOnce = false;
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
      (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (!failedOnce && String(target) === rootPath) {
          failedOnce = true;
          throw Object.assign(new Error('transient session-root read failure'), { code: 'EBUSY' });
        }
        return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
      }) as typeof fs.readdir
    );

    try {
      await expect(findSessionByConversation(conversationId, { requireUnique: true })).rejects.toMatchObject({
        code: 'EBUSY'
      });
      expect((await findSessionByConversation(conversationId, { requireUnique: true }))?.id).toBe(created.id);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('numbers events in append order and reads them back unchanged', async () => {
    const summary = await createSession({ title: 'ordering', conversationId: null });
    const kinds: SessionEvent['kind'][] = ['user_message', 'turn_start', 'progress', 'turn_end'];
    await appendEvent(summary.id, {
      time: 1000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'do the thing', truncated: false, chars: 12 }
    });
    await appendEvent(summary.id, { time: 1001, source: 'extension', kind: 'turn_start' });
    await appendEvent(summary.id, {
      time: 1002,
      source: 'extension',
      kind: 'progress',
      message: { text: 'reading files', truncated: false, chars: 13 }
    });
    await appendEvent(summary.id, { time: 1003, source: 'extension', kind: 'turn_end', outcome: 'completed' });

    const events = await readEvents(summary.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.kind)).toEqual(kinds);
  });

  it('reorders late events only inside the durable turn that owns them', async () => {
    const summary = await createSession({ title: 'deferred append' });
    await appendEvent(summary.id, { time: 1000, source: 'extension', kind: 'turn_start', turnId: 'g-order' });
    await appendEvent(summary.id, {
      time: 5000,
      source: 'extension',
      kind: 'progress',
      turnId: 'g-order',
      message: { text: 'later progress', truncated: false, chars: 14 }
    });
    // Arrived late, but logically happened between the two rows above.
    await appendEvent(summary.id, {
      time: 2000,
      source: 'extension',
      kind: 'progress',
      turnId: 'g-order',
      message: { text: 'earlier progress', truncated: false, chars: 16 }
    });
    await appendEvent(summary.id, { time: 6000, source: 'extension', kind: 'turn_end', turnId: 'g-order', outcome: 'completed' });
    const events = await readEvents(summary.id);
    expect(events.map((event) => event.kind)).toEqual(['turn_start', 'progress', 'progress', 'turn_end']);
    expect(events.slice(1, 3).map((event) => event.time)).toEqual([2000, 5000]);
    // The JSONL stays append-only: the logically earlier progress still has the later seq.
    expect(events[1]!.seq).toBeGreaterThan(events[2]!.seq);
  });

  it('keeps a session from ageing backwards when a call is written late', async () => {
    const summary = await createSession({ title: 'late append' });
    const now = Date.now();
    await appendEvent(summary.id, { time: now, source: 'extension', kind: 'turn_end', outcome: 'completed' });
    await appendEvent(summary.id, { time: now - 5000, source: 'mcp', kind: 'turn_start' });
    expect((await getSession(summary.id))?.updatedAt).toBe(now);
  });

  it('filters by kind and by starting sequence number', async () => {
    const summary = await createSession({ title: 'filters' });
    for (let i = 0; i < 6; i++) {
      await appendEvent(summary.id, {
        time: 1000 + i,
        source: 'extension',
        kind: i % 2 === 0 ? 'progress' : 'turn_start',
        ...(i % 2 === 0 ? { message: { text: `step ${i}`, truncated: false, chars: 6 } } : {})
      } as never);
    }
    const progress = await readEvents(summary.id, { kinds: ['progress'] });
    expect(progress).toHaveLength(3);
    const tail = await readEvents(summary.id, { from: 4 });
    expect(tail.every((event) => event.seq >= 4)).toBe(true);
    expect(await readEvents(summary.id, { limit: 2 })).toHaveLength(2);
  });

  it('preserves app-staged attachment identity and preview when native metadata observes the same user send', async () => {
    const summary = await createSession({ title: 'attachment custody' });
    const original = { id: 'app-staged-id', name: 'example.png', size: 123, mimeType: 'image/png', preview: 'data:image/webp;base64,YQ==' };
    const base = { kind: 'user_message' as const, source: 'app' as const, time: 100, messageId: 'native-user',
      message: { text: '', chars: 0, truncated: false } };
    await upsertMessageEvent(summary.id, { ...base, inputId: 'app-input', attachments: [original] });
    await upsertMessageEvent(summary.id, { ...base, source: 'extension', attachments: [{ ...original, id: 'provider-file-id', preview: undefined }] });
    const [recorded] = await readEvents(summary.id, { kinds: ['user_message'] });
    expect(recorded).toMatchObject({ inputId: 'app-input', attachments: [original] });
  });

  it('retains provider user text against a rendered fallback after recorder and store restart', async () => {
    const conversationId = 'provider-user-text-restart';
    const messageId = 'native-provider-user-restart';
    const text = '[[CLF-RESUME:0123456789abcdef0123456789abcdef]]\n\nKeep `literal` text.\nSecond line.';
    const provider = { kind: 'user_message' as const, time: 100, messageId, text, textOrigin: 'provider' as const };
    const opened = await recordChatObservations(conversationId, [provider]);
    const [first] = await readEvents(opened.sessionId!, { kinds: ['user_message'] });
    if (first?.kind !== 'user_message') throw new Error('Expected the exact provider user row');
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    const fallback = { ...provider, time: 200, text: 'Keep literal text.Second line.', textOrigin: 'rendered' as const };
    await recordChatObservations(conversationId, [fallback]);
    const [retained] = await readEvents(opened.sessionId!, { kinds: ['user_message'] });
    expect(retained).toMatchObject({ messageId, textOrigin: 'provider', message: { text, truncated: false },
      seq: first!.seq, origin: first!.seq, semanticUpdatedAt: first!.semanticUpdatedAt });
    const repeated = await recordChatObservations(conversationId, [fallback]);
    expect(repeated.stored).toBe(0);
  });

  it('persists same-body provider provenance without changing the authored-text watermark', async () => {
    const summary = await createSession({ title: 'provider provenance promotion' });
    const row = { kind: 'user_message' as const, source: 'extension' as const, time: 100,
      messageId: 'native-provenance-promotion', message: { text: 'Exact source', chars: 12, truncated: false } };
    const first = await upsertMessageEvent(summary.id, row);
    const promoted = await upsertMessageEvent(summary.id, { ...row, textOrigin: 'provider' as const });
    expect(promoted.changed).toBe(true);
    expect(promoted.event.semanticUpdatedAt).toBe(first.event.semanticUpdatedAt);
    await flushSessions(); resetSessionStoreForTests();
    await upsertMessageEvent(summary.id, { ...row, textOrigin: 'rendered' as const,
      message: { text: 'Display', chars: 7, truncated: false } });
    expect((await readEvents(summary.id, { kinds: ['user_message'] }))[0])
      .toMatchObject({ textOrigin: 'provider', message: row.message });
  });

  it('accepts a genuine shorter provider user edit after restart rather than keeping longest text', async () => {
    const conversationId = 'provider-user-shorter-edit';
    const row = { kind: 'user_message' as const, time: 100, messageId: 'native-provider-shorter-edit',
      text: 'A much longer original user instruction.', textOrigin: 'provider' as const };
    const opened = await recordChatObservations(conversationId, [row]);
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    await recordChatObservations(conversationId, [{ ...row, time: 200, text: 'Short edit.' }]);
    expect((await readEvents(opened.sessionId!, { kinds: ['user_message'] }))[0])
      .toMatchObject({ textOrigin: 'provider', message: { text: 'Short edit.', chars: 11, truncated: false } });
  });

  it('retains provider body while applying rendered reaction, model and attachment metadata', async () => {
    const summary = await createSession({ title: 'provider body metadata' });
    const row = { kind: 'user_message' as const, source: 'extension' as const, time: 100,
      messageId: 'native-provider-metadata', textOrigin: 'provider' as const,
      message: { text: 'Keep\\literal\n`markup`', chars: 21, truncated: false } };
    const first = await upsertMessageEvent(summary.id, row);
    const attachment = { id: 'native-file', name: 'example.png', size: 10, mimeType: 'image/png' };
    const revised = await upsertMessageEvent(summary.id, { ...row, time: 200, textOrigin: 'rendered' as const,
      message: { text: 'Keep literal markup', chars: 19, truncated: false }, reaction: '👍', model: 'gpt-6-thinking',
      attachments: [attachment] });
    expect(revised.event).toMatchObject({ textOrigin: 'provider', message: row.message,
      reaction: '👍', model: 'gpt-6-thinking', attachments: [attachment],
      semanticUpdatedAt: first.event.semanticUpdatedAt });
    expect(revised.contentChanged).toBe(false);
  });

  it('does not transfer provider text protection to a new UUID or another session route', async () => {
    const row = { kind: 'user_message' as const, time: 100, messageId: 'same-native-id-across-sessions',
      text: 'Provider source', textOrigin: 'provider' as const };
    const first = await recordChatObservations('provider-user-route-one', [row]);
    await recordChatObservations('provider-user-route-one', [{ ...row, messageId: 'new-native-user-id',
      text: 'A new rendered question', textOrigin: 'rendered' as const }]);
    const second = await recordChatObservations('provider-user-route-two', [{ ...row,
      text: 'Another route question', textOrigin: 'rendered' as const }]);
    expect(await readEvents(first.sessionId!, { kinds: ['user_message'] })).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: row.messageId, message: expect.objectContaining({ text: row.text }) }),
      expect.objectContaining({ messageId: 'new-native-user-id', message: expect.objectContaining({ text: 'A new rendered question' }) })
    ]));
    expect((await readEvents(second.sessionId!, { kinds: ['user_message'] }))[0])
      .toMatchObject({ textOrigin: 'rendered', message: { text: 'Another route question' } });
  });

  it('preserves legacy user edits without inventing provider provenance for the changed body', async () => {
    const conversationId = 'provider-user-legacy-edit';
    const row = { kind: 'user_message' as const, time: 100, messageId: 'native-provider-legacy-edit',
      text: 'Provider source', textOrigin: 'provider' as const };
    const opened = await recordChatObservations(conversationId, [row]);
    const { textOrigin: _origin, ...legacy } = row;
    await recordChatObservations(conversationId, [{ ...legacy, time: 200, text: 'Legacy changed body' }]);
    const [changed] = await readEvents(opened.sessionId!, { kinds: ['user_message'] });
    expect(changed).toMatchObject({ message: { text: 'Legacy changed body' } });
    expect(changed).not.toHaveProperty('textOrigin');
    await recordChatObservations(conversationId, [{ ...row, text: 'Rendered subsequent edit', textOrigin: 'rendered' as const }]);
    expect((await readEvents(opened.sessionId!, { kinds: ['user_message'] }))[0])
      .toMatchObject({ textOrigin: 'rendered', message: { text: 'Rendered subsequent edit' } });
  });

  it('ignores malformed user text-origin annotations rather than inventing provider protection', async () => {
    const conversationId = 'provider-user-malformed-origin';
    const row = { kind: 'user_message' as const, time: 100, messageId: 'native-malformed-provenance',
      text: 'Original legacy text', textOrigin: 'not-provider' as never };
    const opened = await recordChatObservations(conversationId, [row]);
    const [original] = await readEvents(opened.sessionId!, { kinds: ['user_message'] });
    expect(original).not.toHaveProperty('textOrigin');
    await recordChatObservations(conversationId, [{ ...row, text: 'Changed rendered text', textOrigin: 'rendered' as const }]);
    expect((await readEvents(opened.sessionId!, { kinds: ['user_message'] }))[0])
      .toMatchObject({ message: { text: 'Changed rendered text' } });
  });

  it('keeps user text provenance through a superseded-route recorder projection without new Goal authority', async () => {
    const source = 'provider-user-superseded-source', destination = 'provider-user-superseded-destination';
    const provider = { kind: 'user_message' as const, time: 100, messageId: 'native-superseded-provider',
      text: 'Original\n`literal` source', textOrigin: 'provider' as const };
    const opened = await recordChatObservations(source, [provider]);
    expect(await rebindSession(opened.sessionId!, source, destination)).toBe(true);
    rebindConversation(opened.sessionId!, source, destination);
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    const historical = await recordChatObservations(source, [
      { ...provider, text: 'Original literal source', textOrigin: 'rendered' as const },
      { ...provider, messageId: 'native-superseded-new-provider', text: 'A different native user' }
    ]);
    expect(historical.sessionId).toBe(opened.sessionId);
    expect(historical.goalCandidates).toEqual([]);
    expect(historical.activity).toEqual({ meaningful: false, working: false, terminal: false });
    expect(await readEvents(opened.sessionId!, { kinds: ['user_message'] })).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: provider.messageId, textOrigin: 'provider',
        message: expect.objectContaining({ text: provider.text }) }),
      expect.objectContaining({ messageId: 'native-superseded-new-provider', textOrigin: 'provider',
        message: expect.objectContaining({ text: 'A different native user' }) })
    ]));
  });

  it('keeps the original anchor when provider creation time changes on reload, without merging sibling messages', async () => {
    const summary = await createSession({ title: 'provider timestamp revision' });
    const row = (messageId: string, providerMessageId: string) => ({
      kind: 'assistant_message' as const, source: 'extension' as const, time: 100,
      messageId, providerMessageId, message: { text: 'Same greeting', chars: 13, truncated: false },
      final: true, state: 'final' as const
    });
    const first = await upsertMessageEvent(summary.id, row('assistant:working:exchange:1000', 'provider-one'));
    await upsertMessageEvent(summary.id, row('assistant:working:exchange:1100', 'provider-two'));
    const replay = await upsertMessageEvent(summary.id,
      { ...row('assistant:working:exchange:2000', 'provider-one'), time: 900 }, { preferTime: true });
    expect(replay.event.messageId).toBe(first.event.messageId);
    expect(replay.event.origin).toBe(first.event.origin);
    expect(replay.event.time).toBe(first.event.time);
    await flushSessions();
    const rows = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(rows).toHaveLength(2);
  });

  it('preserves Main-proven ordinary terminal association through sparse replay and restart', async () => {
    const summary = await createSession({ title: 'receipt-backed ordinary terminal' });
    const row = { kind: 'assistant_message' as const, source: 'extension' as const, time: 100,
      messageId: 'ordinary-final', providerMessageId: 'ordinary-native-final',
      message: { text: 'Complete.', chars: 9, truncated: false }, final: true, state: 'final' as const };
    const first = await upsertMessageEvent(summary.id, row);
    const trusted = await upsertMessageEvent(summary.id, { ...row, goalEligible: true, inputReplyTo: 'exact-native-question' });
    expect(trusted.changed).toBe(true);
    if (trusted.event.kind !== 'assistant_message' || first.event.kind !== 'assistant_message') throw new Error('Expected canonical final');
    expect(trusted.event.finalContentSeq).toBe(first.event.finalContentSeq);
    expect(trusted.event.semanticUpdatedAt).toBe(first.event.semanticUpdatedAt);
    await upsertMessageEvent(summary.id, row);
    await flushSessions();
    resetSessionStoreForTests();
    const [stored] = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(stored).toMatchObject({ inputReplyTo: 'exact-native-question', goalEligible: true });
    expect((await upsertMessageEvent(summary.id, row)).changed).toBe(false);
    await expect(upsertMessageEvent(summary.id, { ...row, inputReplyTo: 'different-native-question' }))
      .rejects.toThrow(/association/i);
    await expect(upsertMessageEvent(summary.id, { ...row, providerMessageId: 'different-native-final' }))
      .rejects.toThrow(/association/i);
    const sibling = await upsertMessageEvent(summary.id, { ...row, messageId: 'new-final', providerMessageId: 'new-native-final' });
    expect(sibling.event.kind === 'assistant_message' ? sibling.event.inputReplyTo : 'not-an-answer').toBeUndefined();
  });

  it('keeps a deferred native source join through sparse replay until exact Main proof clears it', async () => {
    const summary = await createSession({ title: 'deferred native source join' });
    const row = { kind: 'assistant_message' as const, source: 'extension' as const, time: 100,
      messageId: 'deferred-final', providerMessageId: 'deferred-provider', goalEligible: true,
      message: { text: 'Complete.', chars: 9, truncated: false }, final: true, state: 'final' as const };
    const first = await upsertMessageEvent(summary.id, { ...row, inputAssociationPending: true });
    await upsertMessageEvent(summary.id, row);
    await upsertMessageEvent(summary.id, { ...row, inputAssociationPending: false });
    await flushSessions(); resetSessionStoreForTests();
    expect((await readEvents(summary.id, { kinds: ['assistant_message'] }))[0]).toMatchObject({ inputAssociationPending: true });
    const proved = await upsertMessageEvent(summary.id, { ...row, inputReplyTo: 'exact-question', inputAssociationPending: false });
    expect(proved.event).toMatchObject({ inputAssociationPending: false, inputReplyTo: 'exact-question' });
    expect(proved.event.kind === 'assistant_message' && proved.event.finalContentSeq)
      .toBe(first.event.kind === 'assistant_message' && first.event.finalContentSeq);
    await upsertMessageEvent(summary.id, row);
    await flushSessions(); resetSessionStoreForTests();
    expect((await readEvents(summary.id, { kinds: ['assistant_message'] }))[0])
      .toMatchObject({ inputAssociationPending: false, inputReplyTo: 'exact-question' });
  });

  it.each([false, true])('cold alias collapse retains a deferred source join until proved (proved=%s)', async proved => {
    const summary = await createSession({ title: 'deferred native alias source join' });
    const first = await upsertMessageEvent(summary.id, { kind: 'assistant_message', source: 'extension', time: 100,
      messageId: 'pending-alias', providerMessageId: 'shared-pending-provider', inputAssociationPending: true,
      goalEligible: true, message: { text: 'Complete.', chars: 9, truncated: false }, final: true, state: 'final' });
    await flushSessions();
    const alias = { ...first.event, messageId: 'sparse-alias', seq: first.event.seq + 1,
      origin: first.event.seq + 1, inputAssociationPending: proved ? false : undefined,
      ...(proved ? { inputReplyTo: 'exact-native-question' } : {}) };
    const name = createHash('sha256').update(`assistant_message\u0000${alias.messageId}`).digest('hex') + '.json';
    await fs.writeFile(path.join(sessionsRoot(), summary.id, 'messages', name), JSON.stringify(alias));
    resetSessionStoreForTests();
    const [stored] = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(stored?.kind === 'assistant_message' && stored.inputAssociationPending).toBe(!proved);
    if (proved) expect(stored).toMatchObject({ inputReplyTo: 'exact-native-question' });
  });

  it.each([false, true])('cold reload retains only an unambiguous native terminal association (conflict=%s)', async conflict => {
    const summary = await createSession({ title: 'legacy alias association' });
    const first = await upsertMessageEvent(summary.id, { kind: 'assistant_message', source: 'extension', time: 100,
      messageId: 'first-native-alias', providerMessageId: 'native-alias-provider', inputReplyTo: 'question-one',
      goalEligible: true, message: { text: 'Complete.', chars: 9, truncated: false }, final: true, state: 'final' });
    await flushSessions();
    const alias = { ...first.event, seq: first.event.seq + 1, origin: first.event.seq + 1, time: 200,
      messageId: 'second-native-alias', inputReplyTo: conflict ? 'question-two' : undefined };
    const name = createHash('sha256').update(`assistant_message\u0000${alias.messageId}`).digest('hex') + '.json';
    await fs.writeFile(path.join(sessionsRoot(), summary.id, 'messages', name), JSON.stringify(alias));
    resetSessionStoreForTests();
    const [stored] = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(stored?.kind === 'assistant_message' ? stored.inputReplyTo : 'not-an-answer')
      .toBe(conflict ? undefined : 'question-one');
    expect(stored?.kind === 'assistant_message' ? stored.goalEligible : 'not-an-answer').toBe(!conflict);
  });

  it('reads already stored reload aliases once at their original position without deleting source shards', async () => {
    const summary = await createSession({ title: 'existing reload aliases' });
    const first = await upsertMessageEvent(summary.id, { kind: 'assistant_message', source: 'extension', time: 100,
      messageId: 'assistant:working:exchange:1000', providerMessageId: 'actual-provider-uuid',
      message: { text: 'The old complete answer.', chars: 24, truncated: false }, final: true, state: 'final' });
    await upsertMessageEvent(summary.id, { kind: 'user_message', source: 'extension', time: 200,
      messageId: 'new-user', message: { text: 'ghjkghk', chars: 7, truncated: false } });
    await flushSessions();
    const duplicate = { ...first.event, seq: first.event.seq + 2, origin: first.event.seq + 2,
      time: 300, messageId: 'assistant:working:exchange:2000', turnId: undefined };
    const name = createHash('sha256').update(`assistant_message\u0000${duplicate.messageId}`).digest('hex') + '.json';
    const file = path.join(sessionsRoot(), summary.id, 'messages', name);
    await fs.writeFile(file, JSON.stringify(duplicate));
    resetSessionStoreForTests();
    const rows = await readEvents(summary.id, { kinds: ['assistant_message', 'user_message'] });
    expect(rows.map(row => row.kind)).toEqual(['assistant_message', 'user_message']);
    expect(rows[0]?.kind === 'assistant_message' && rows[0].origin).toBe(first.event.origin);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).messageId).toBe(duplicate.messageId);
    await upsertMessageEvent(summary.id, { ...duplicate, message: { text: 'The corrected complete answer.', chars: 30, truncated: false } });
    resetSessionStoreForTests();
    expect(await readEvents(summary.id, { kinds: ['assistant_message'] })).toHaveLength(1);
  });

  it('selects terminal alias content independently of cursor and repairs an otherwise current legacy summary once', async () => {
    const summary = await createSession({ title: 'legacy alias checkpoint' });
    const first = await upsertMessageEvent(summary.id, { kind: 'assistant_message', source: 'extension', time: 100,
      messageId: 'first', providerMessageId: 'same-provider', turnId: 'original-turn', goalEligible: true,
      message: { text: 'Old final', chars: 9, truncated: false }, final: true, state: 'final' });
    await flushSessions();
    const metaFile = path.join(sessionsRoot(), summary.id, 'meta.json');
    const baseline = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    const streaming = { ...first.event, messageId: 'streaming-alias', origin: 3, seq: 30, time: 300,
      message: { text: 'Partial', chars: 7, truncated: false }, final: false, state: 'streaming' as const };
    const terminal = { ...first.event, messageId: 'final-alias', origin: 4, seq: 20, time: 400,
      turnId: undefined, goalEligible: undefined,
      message: { text: 'Latest complete final answer', chars: 28, truncated: false } };
    const files: string[] = [];
    for (const event of [streaming, terminal]) {
      const name = createHash('sha256').update(`assistant_message\u0000${event.messageId}`).digest('hex') + '.json';
      const file = path.join(sessionsRoot(), summary.id, 'messages', name);
      await fs.writeFile(file, JSON.stringify(event)); files.push(file);
    }
    const extraTokens = eventTokens(streaming) + eventTokens(terminal);
    const oldMeta = { ...baseline, __historySeq: 30, events: baseline.events + 2,
      estimatedTokens: baseline.estimatedTokens + extraTokens,
      contextTokens: baseline.contextTokens + extraTokens - 1 };
    delete oldMeta.__canonicalProjection;
    await fs.writeFile(metaFile, JSON.stringify(oldMeta));
    resetSessionStoreForTests();
    const recovered = await getSession(summary.id);
    const expectedTokens = baseline.estimatedTokens - eventTokens(first.event) + eventTokens(terminal);
    expect(recovered).toMatchObject({ events: baseline.events, estimatedTokens: expectedTokens,
      contextTokens: Math.max(0, expectedTokens - 1) });
    const rows = await readEvents(summary.id, { kinds: ['assistant_message'], from: 21 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageId: 'first', time: 100, origin: first.event.origin,
      seq: 30, turnId: 'original-turn', goalEligible: true, message: terminal.message });
    const repairedMeta = await fs.readFile(metaFile, 'utf8');
    resetSessionStoreForTests();
    expect((await getSession(summary.id))?.estimatedTokens).toBe(expectedTokens);
    expect(await fs.readFile(metaFile, 'utf8')).toBe(repairedMeta);
    expect(JSON.parse(await fs.readFile(files[0]!, 'utf8')).seq).toBe(30);
    expect(JSON.parse(await fs.readFile(files[1]!, 'utf8')).seq).toBe(20);
  });

  it('never downgrades a final canonical message when a stale streaming snapshot arrives later', async () => {
    const summary = await createSession({ title: 'terminal canonical final' });
    const messageId = 'msg-terminal-final';
    const final = await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message: { text: 'Complete answer.', truncated: false, chars: 16 },
      renderedHtml: { text: '<p><strong>Complete</strong> answer.</p>', truncated: false, chars: 40 },
      state: 'final',
      final: true
    });
    const stale = await upsertMessageEvent(summary.id, {
      time: 120,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message: { text: 'Complete', truncated: false, chars: 8 },
      renderedHtml: { text: '<p>Complete</p>', truncated: false, chars: 15 },
      state: 'streaming',
      final: false
    });

    expect(stale.changed).toBe(false);
    expect(stale.event.seq).toBe(final.event.seq);
    const [stored] = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(stored?.kind === 'assistant_message' && stored.final).toBe(true);
    expect(stored?.kind === 'assistant_message' && stored.message.text).toBe('Complete answer.');
  });

  it('keeps rich HTML when the same canonical prose is reobserved without rendered HTML', async () => {
    const summary = await createSession({ title: 'sparse rich final' });
    const messageId = 'msg-sparse-rich';
    const providerMessageId = 'f0f00016-1111-4111-8111-111111111111';
    const message = { text: 'Bold answer', truncated: false, chars: 11 };
    await upsertMessageEvent(summary.id, {
      time: 200,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message,
      renderedHtml: { text: '<p><strong>Bold</strong> answer</p>', truncated: false, chars: 35 },
      providerMessageId,
      state: 'final',
      final: true
    });
    const repeated = await upsertMessageEvent(summary.id, {
      time: 220,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message,
      state: 'final',
      final: true
    });

    expect(repeated.changed).toBe(false);
    expect(repeated.event.kind === 'assistant_message' && repeated.event.providerMessageId).toBe(providerMessageId);
    expect(repeated.event.kind === 'assistant_message' && repeated.event.renderedHtml?.text).toBe(
      '<p><strong>Bold</strong> answer</p>'
    );
    expect(await readEvents(summary.id, { kinds: ['assistant_message'] })).toHaveLength(1);
  });

  it('persists semantic message recency while metadata-only canonical revisions preserve it', async () => {
    // This asserts semantic chronology, not filesystem speed. The store correctly
    // uses max(provider time, commit clock); real I/O can exceed these 10ms steps.
    // Keep timers/files real and only pin Date.now (restored by beforeEach).
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const summary = await createSession({ title: 'semantic canonical watermark' });
    const assistantId = 'semantic-watermark-assistant';
    const assistant = await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'assistant_message',
      messageId: assistantId,
      providerMessageId: 'provider-watermark-1',
      message: { text: 'Working', truncated: false, chars: 7 },
      renderedHtml: { text: '<p>Working</p>', truncated: false, chars: 14 },
      state: 'streaming',
      final: false
    });
    expect(assistant.event.kind).toBe('assistant_message');
    const assistantStartedAt = assistant.event.semanticUpdatedAt!;
    expect(assistantStartedAt).toBeGreaterThanOrEqual(100);

    const assistantMetadata = await upsertMessageEvent(summary.id, {
      time: assistantStartedAt + 10,
      source: 'extension',
      kind: 'assistant_message',
      messageId: assistantId,
      providerMessageId: 'provider-watermark-2',
      message: { text: 'Working', truncated: false, chars: 7 },
      renderedHtml: { text: '<p data-remount="1">Working</p>', truncated: false, chars: 31 },
      state: 'streaming',
      final: false,
      model: 'metadata-model',
      semanticUpdatedAt: assistantStartedAt + 10_000
    });
    expect(assistantMetadata.changed).toBe(true);
    expect(assistantMetadata.event.semanticUpdatedAt).toBe(assistantStartedAt);

    const assistantGrowth = await upsertMessageEvent(summary.id, {
      time: assistantStartedAt + 20,
      source: 'extension',
      kind: 'assistant_message',
      messageId: assistantId,
      providerMessageId: 'provider-watermark-2',
      message: { text: 'Working with new model text', truncated: false, chars: 27 },
      state: 'streaming',
      final: false
    });
    expect(assistantGrowth.event.semanticUpdatedAt).toBe(assistantStartedAt + 20);

    const assistantFinal = await upsertMessageEvent(summary.id, {
      time: assistantStartedAt + 30,
      source: 'extension',
      kind: 'assistant_message',
      messageId: assistantId,
      providerMessageId: 'provider-watermark-2',
      message: { text: 'Working with new model text', truncated: false, chars: 27 },
      state: 'final',
      final: true
    });
    expect(assistantFinal.event.semanticUpdatedAt).toBe(assistantStartedAt + 30);

    const assistantFinalMetadata = await upsertMessageEvent(summary.id, {
      time: assistantStartedAt + 40,
      source: 'extension',
      kind: 'assistant_message',
      messageId: assistantId,
      providerMessageId: 'provider-watermark-3',
      message: { text: 'Working with new model text', truncated: false, chars: 27 },
      renderedHtml: { text: '<p><strong>Working</strong> with new model text</p>', truncated: false, chars: 54 },
      state: 'final',
      final: true,
      reasoningEffort: 'xhigh',
      semanticUpdatedAt: assistantStartedAt + 20_000
    });
    expect(assistantFinalMetadata.event.semanticUpdatedAt).toBe(assistantStartedAt + 30);

    const userId = 'semantic-watermark-user';
    const user = await upsertMessageEvent(summary.id, {
      time: assistantStartedAt + 50,
      source: 'app',
      kind: 'user_message',
      messageId: userId,
      authoredText: 'The authored request',
      message: { text: 'The authored request', truncated: false, chars: 20 }
    });
    const userStartedAt = user.event.semanticUpdatedAt!;
    const userMetadata = await upsertMessageEvent(summary.id, {
      time: userStartedAt + 10,
      source: 'extension',
      kind: 'user_message',
      messageId: userId,
      // Provider transport framing may change while the app-authored request does not.
      message: { text: 'The authored request\n\nTransport control', truncated: false, chars: 39 },
      reaction: '👍',
      semanticUpdatedAt: userStartedAt + 10_000
    });
    expect(userMetadata.changed).toBe(true);
    expect(userMetadata.event.semanticUpdatedAt).toBe(userStartedAt);

    const userGrowth = await upsertMessageEvent(summary.id, {
      time: userStartedAt + 20,
      source: 'extension',
      kind: 'user_message',
      messageId: userId,
      message: { text: 'The authored request with a correction', truncated: false, chars: 38 }
    });
    expect(userGrowth.event.semanticUpdatedAt).toBe(userStartedAt);

    await flushSessions();
    resetSessionStoreForTests();
    const restored = await readEvents(summary.id, { kinds: ['user_message', 'assistant_message'] });
    expect(restored.find(event => event.kind === 'assistant_message')?.semanticUpdatedAt)
      .toBe(assistantStartedAt + 30);
    expect(restored.find(event => event.kind === 'user_message')?.semanticUpdatedAt)
      .toBe(userStartedAt);
  });

  it('lets an authoritative page-model timestamp correct a delayed DOM first sight', async () => {
    const summary = await createSession({ title: 'authored timestamp correction' });
    const messageId = 'user-authored-time';
    const message = { text: 'the real question', truncated: false, chars: 17 };
    const first = await upsertMessageEvent(summary.id, {
      time: 20_000,
      source: 'extension',
      kind: 'user_message',
      messageId,
      message
    });
    const corrected = await upsertMessageEvent(
      summary.id,
      {
        time: 10_000,
        source: 'extension',
        kind: 'user_message',
        messageId,
        message
      },
      { preferTime: true }
    );

    expect(corrected.changed).toBe(true);
    expect(corrected.event.time).toBe(10_000);
    expect(corrected.event.kind === 'user_message' && corrected.event.origin).toBe(first.event.seq);
    const [stored] = await readEvents(summary.id, { kinds: ['user_message'] });
    expect(stored?.time).toBe(10_000);
    expect(stored?.kind === 'user_message' && stored.origin).toBe(first.event.seq);
  });

  it('revises one canonical row only when the website logical identity is the same', async () => {
    const summary = await createSession({ title: 'stable website identity' });
    const turnId = 'g-stream-growth';
    const logicalId = 'thought-website-parent';
    const snapshots = [
      'Eight calls in, still zero writes.',
      'Eight calls in, still zero writes. The repo was already very',
      'Eight calls in, still zero writes. The repo was already very dirty before this check.'
    ];

    for (let index = 0; index < snapshots.length; index++) {
      const text = snapshots[index]!;
      await upsertMessageEvent(summary.id, {
        time: 100 + index,
        source: 'extension',
        kind: 'assistant_message',
        turnId,
        messageId: logicalId,
        message: { text, truncated: false, chars: text.length },
        state: index === snapshots.length - 1 ? 'final' : 'streaming',
        final: index === snapshots.length - 1
      });
    }

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind === 'assistant_message' && messages[0].messageId).toBe(logicalId);
    expect(messages[0]?.kind === 'assistant_message' && messages[0].message.text).toBe(snapshots.at(-1));
    expect(messages[0]?.kind === 'assistant_message' && messages[0].state).toBe('final');
  });

  it('keeps the first sequence as the origin of a revised stable user message', async () => {
    const summary = await createSession({ title: 'stable user boundary' });
    const message = { text: 'the user turn boundary', truncated: false, chars: 22 };
    const first = await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'user_message',
      turnId: 'page-user-before',
      messageId: 'user-stable-boundary',
      message
    });
    const revised = await upsertMessageEvent(summary.id, {
      time: 200,
      source: 'extension',
      kind: 'user_message',
      turnId: 'page-user-after',
      messageId: 'user-stable-boundary',
      message
    });

    expect(revised.changed).toBe(true);
    expect(first.event.kind === 'user_message' && first.event.origin).toBe(first.event.seq);
    expect(revised.event.kind === 'user_message' && revised.event.origin).toBe(first.event.seq);
    expect(revised.event.seq).toBeGreaterThan(first.event.seq);
    const stored = await readEvents(summary.id, { kinds: ['user_message'] });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.kind === 'user_message' && stored[0].origin).toBe(first.event.seq);
  });

  it('never merges distinct website identities merely because their prose is a prefix continuation', async () => {
    const summary = await createSession({ title: 'distinct website identities' });
    const turnId = 'g-distinct-prefix';
    const first = 'First checkpoint.';
    const second = 'First checkpoint. Second checkpoint.';

    for (const [messageId, text] of [
      ['thought-parent-a', first],
      ['thought-parent-b', second]
    ] as const) {
      await upsertMessageEvent(summary.id, {
        time: Date.now(),
        source: 'extension',
        kind: 'assistant_message',
        turnId,
        messageId,
        message: { text, truncated: false, chars: text.length },
        state: 'streaming',
        final: false
      });
    }

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(2);
    expect(messages.map((event) => event.kind === 'assistant_message' && event.messageId)).toEqual([
      'thought-parent-a',
      'thought-parent-b'
    ]);
  });

  it('does not merge separate streaming commentary that merely shares a turn', async () => {
    const summary = await createSession({ title: 'separate streaming commentary' });
    const turnId = 'g-separate-commentary';
    for (const [messageId, text] of [
      ['comment-a', 'First three are clean; continuing the checks.'],
      ['comment-b', 'Eight calls in; still zero writes.']
    ] as const) {
      await upsertMessageEvent(summary.id, {
        time: Date.now(),
        source: 'extension',
        kind: 'assistant_message',
        turnId,
        messageId,
        message: { text, truncated: false, chars: text.length },
        state: 'streaming',
        final: false
      });
    }

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(2);
    expect(messages.map((event) => event.kind === 'assistant_message' && event.message.text)).toEqual([
      'First three are clean; continuing the checks.',
      'Eight calls in; still zero writes.'
    ]);
  });

  it('keeps a settled raw website id distinct from a different provisional id', async () => {
    const summary = await createSession({ title: 'different id at final' });
    const turnId = 'g-stream-final-remount';
    const text = 'The completed answer is already fully visible.';
    await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'assistant_message',
      turnId,
      messageId: 'raw-streaming',
      message: { text, truncated: false, chars: text.length },
      state: 'streaming',
      final: false
    });
    await upsertMessageEvent(summary.id, {
      time: 110,
      source: 'extension',
      kind: 'assistant_message',
      turnId,
      messageId: 'raw-final-remount',
      message: { text, truncated: false, chars: text.length },
      state: 'final',
      final: true
    });

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(2);
    expect(messages.map((event) => event.kind === 'assistant_message' && event.messageId)).toEqual([
      'raw-streaming',
      'raw-final-remount'
    ]);
    expect(messages[1]?.kind === 'assistant_message' && messages[1].state).toBe('final');
  });

  it('keeps running counters and a token estimate on the summary', async () => {
    const summary = await createSession({ title: 'counters' });
    await appendEvent(summary.id, {
      time: 1,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'x'.repeat(400), truncated: false, chars: 400 }
    });
    await appendEvent(summary.id, {
      time: 2,
      source: 'extension',
      kind: 'chat_error',
      message: { text: 'something broke', truncated: false, chars: 15 }
    });
    await appendEvent(summary.id, { time: 3, source: 'extension', kind: 'turn_end', outcome: 'interrupted' });

    const after = await getSession(summary.id);
    expect(after?.userMessages).toBe(1);
    expect(after?.errors).toBe(1);
    expect(after?.lastTurnOutcome).toBe('interrupted');
    expect(after?.estimatedTokens).toBeGreaterThanOrEqual(100);
  });

  it('keeps the exact last attributed tool-call time separate from unrelated session activity', async () => {
    const summary = await createSession({ title: 'tool activity clock' });
    const toolAt = summary.startedAt + 20;
    const laterAt = summary.startedAt + 90;
    await appendEvent(summary.id, {
      time: toolAt,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'call-tool-clock',
        tool: 'read',
        attribution: 'request_id',
        requestId: 'wfr-tool-clock',
        conversationId: 'c-tool-clock',
        attributionMethod: 'request_id',
        args: { text: '{"paths":["/project/a.ts"]}', truncated: false, chars: 27 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok',
        durationMs: 1,
        summary: { title: 'Read a.ts', tone: 'neutral', kind: 'read' }
      }
    });
    await appendEvent(summary.id, {
      time: laterAt,
      source: 'extension',
      kind: 'note',
      message: { text: 'later but not a tool call', truncated: false, chars: 25 }
    });

    expect(await getSession(summary.id)).toMatchObject({ updatedAt: laterAt, lastToolCallAt: toolAt });
  });

  /**
   * A stopped turn has no final assistant message, so it never moved the activity boundary and
   * a blocked, stopped prime kept its `active` badge on the refused call before the stop.
   */
  it('projects any turn end, a stop included, as an end of recent tool activity', async () => {
    const summary = await createSession({ title: 'turn end boundary' });
    expect((await getSession(summary.id))?.lastTurnEndAt).toBeNull();
    await appendEvent(summary.id, { time: 300, source: 'extension', kind: 'turn_start', turnId: 'g-stop' });
    await appendEvent(summary.id, {
      time: 400,
      source: 'extension',
      kind: 'turn_end',
      turnId: 'g-stop',
      outcome: 'stopped'
    });
    expect((await getSession(summary.id))?.lastTurnEndAt).toBe(400);
  });

  it('projects a stable final assistant message as the exact end of recent tool activity', async () => {
    const summary = await createSession({ title: 'final activity boundary' });
    const messageId = 'assistant-final-activity-boundary';
    await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message: { text: 'Still working', truncated: false, chars: 13 },
      state: 'streaming',
      final: false
    });
    expect((await getSession(summary.id))?.lastAssistantFinalAt).toBeNull();

    await upsertMessageEvent(summary.id, {
      time: 200,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message: { text: 'Finished.', truncated: false, chars: 9 },
      state: 'final',
      final: true
    });

    expect((await getSession(summary.id))?.lastAssistantFinalAt).toBe(200);
  });

  it('projects a successful worker finish report as the session finish boundary', async () => {
    const summary = await createSession({ title: 'finish boundary' });
    const call = (callId: string, tool: string, finish: boolean) => ({
      callId,
      tool,
      attribution: 'exact',
      requestId: callId,
      conversationId: 'conv-finish',
      attributionMethod: 'request_id',
      args: { text: '{}', truncated: false, chars: 2 },
      result: { text: 'ok', truncated: false, chars: 2 },
      outcome: 'ok',
      durationMs: 1,
      summary: { kind: 'agent', tone: 'good', title: 'Reported the finished task' },
      ...(finish ? { endsActivity: true } : {})
    });
    await appendEvent(summary.id, { time: 300, source: 'mcp', kind: 'tool_call', call: call('c-work', 'read', false) } as SessionEvent);
    expect((await getSession(summary.id))?.lastFinishReportAt).toBeNull();

    await appendEvent(summary.id, { time: 400, source: 'mcp', kind: 'tool_call', call: call('c-finish', 'agents', true) } as SessionEvent);
    const after = await getSession(summary.id);
    expect(after?.lastFinishReportAt).toBe(400);
    expect(after?.lastToolCallAt).toBe(400);
  });

  it('keeps the open turn open when the ChatGPT page detaches mid-turn', async () => {
    const conversationId = 'c-detach-keeps-turn-open';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: 10, text: 'run the long job', messageId: 'detach-user-1' },
      { kind: 'turn_start', time: 11, turnId: 'g-detach-open' }
    ]);
    const sessionId = opened.sessionId!;

    await closeConversation(conversationId);

    // A detach is not evidence about the turn. It may not end it, and it may not end it
    // "unknown" either: an ended turn is unreachable for the recovery that follows.
    expect(await readEvents(sessionId, { kinds: ['turn_end'] })).toEqual([]);
    const notes = await readEvents(sessionId, { kinds: ['note'] });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.turnId).toBe('g-detach-open');

    const reopened = await recordChatObservations(conversationId, [
      { kind: 'turn_end', time: 30, turnId: 'g-detach-open', outcome: 'completed' }
    ]);
    expect(reopened.sessionId).toBe(sessionId);
    const ends = await readEvents(sessionId, { kinds: ['turn_end'] });
    expect(ends.map((event) => event.kind === 'turn_end' && event.outcome)).toEqual(['completed']);
  });

  it.each(['completed', 'stopped'] as const)('does not restore an abandoned older turn after the latest turn %s', async (outcome) => {
    const conversationId = 'c-restore-latest-terminal';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'g-abandoned' },
      { kind: 'turn_start', time: 20, turnId: 'g-latest' },
      { kind: 'turn_end', time: 30, turnId: 'g-latest', outcome }
    ]);
    for (let attempt = 0; attempt < 4; attempt++) {
      await closeConversation(conversationId);
      await sessionForConversation(conversationId);
      expect(liveConversations().find(entry => entry.conversationId === conversationId)).toMatchObject({
        generating: false, activeTurnId: null
      });
    }
    // The older incomplete history is preserved without inventing a terminal for it.
    expect((await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).map(event => event.turnId)).toEqual(['g-latest']);
  });

  it('restores the latest committed start without promoting an older orphan by timestamp', async () => {
    const conversationId = 'c-restore-latest-start';
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 100, turnId: 'g-orphan-clock-ahead' },
      { kind: 'turn_start', time: 20, turnId: 'g-current' },
      { kind: 'turn_end', time: 110, turnId: 'g-orphan-clock-ahead', outcome: 'completed' }
    ]);
    await closeConversation(conversationId);
    await sessionForConversation(conversationId);
    expect(liveConversations().find(entry => entry.conversationId === conversationId)).toMatchObject({
      generating: true, activeTurnId: 'g-current'
    });
  });

  it('offers a stable final reply to Goal after reload lost an uncertain turn identity', async () => {
    const conversationId = 'c-goal-final-after-reload';
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'g-before-reload' },
      { kind: 'turn_end', time: 20, turnId: 'g-before-reload', outcome: 'unknown' }
    ]);

    const recovered = await recordChatObservations(conversationId, [{
      kind: 'assistant_message',
      // ChatGPT may stamp the assistant object when generation starts, before a later detach.
      time: 15,
      messageId: 'assistant-stable-after-reload',
      text: 'The complete final answer that appeared after reload.',
      state: 'final',
      final: true
    }]);

    expect(recovered.goalCandidates).toEqual([{
      replyId: 'assistant-stable-after-reload',
      turnId: 'reply:assistant-stable-after-reload',
      eventSeq: expect.any(Number)
    }]);

    const replayed = await recordChatObservations(conversationId, [{
      kind: 'assistant_message',
      time: 15,
      messageId: 'assistant-stable-after-reload',
      text: 'The complete final answer that appeared after reload.',
      state: 'final',
      final: true
    }]);
    expect(replayed.goalCandidates).toEqual(recovered.goalCandidates);
    const [storedFinal] = await readEvents(recovered.sessionId!, { kinds: ['assistant_message'] });
    expect(storedFinal?.kind === 'assistant_message' && storedFinal.goalEligible).toBe(true);
  });

  it('does not turn a historical final answer into Goal work merely because a chat was opened', async () => {
    const conversationId = 'c-goal-historical-final';
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 100, turnId: 'g-newer-uncertain' },
      { kind: 'turn_end', time: 200, turnId: 'g-newer-uncertain', outcome: 'unknown' }
    ]);
    const recovered = await recordChatObservations(conversationId, [{
      kind: 'assistant_message',
      time: 30,
      messageId: 'assistant-historical-final',
      text: 'An answer from an already idle chat.',
      state: 'final',
      final: true
    }]);

    expect(recovered.goalCandidates).toEqual([]);
  });

  it('uses the stable final when it and the uncertain end arrive in the same browser batch', async () => {
    const recovered = await recordChatObservations('c-goal-final-same-batch', [
      { kind: 'turn_start', time: 10, turnId: 'g-same-batch' },
      {
        kind: 'assistant_message',
        time: 15,
        messageId: 'assistant-final-same-batch',
        text: 'Complete despite the page losing its finish edge.',
        state: 'final',
        final: true
      },
      { kind: 'turn_end', time: 20, turnId: 'g-same-batch', outcome: 'unknown' }
    ]);

    expect(recovered.goalCandidates).toEqual([expect.objectContaining({
      replyId: 'assistant-final-same-batch',
      turnId: 'reply:assistant-final-same-batch'
    })]);
  });

  it.each(['live', 'cold restore'] as const)('repairs a later uncertain load failure from the unchanged exact cached native final (%s)', async (restore) => {
    const conversationId = `c-cached-final-uncertain-load-${restore}`;
    const turnId = 'g-cached-final-uncertain-load';
    const messageId = 'assistant-cached-final-uncertain-load';
    const providerMessageId = 'provider-cached-final-uncertain-load';
    const text = 'The exact completed answer was already recorded before the page failed.';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: 10, messageId: 'cached-final-user', text: 'Finish the existing task.' },
      { kind: 'turn_start', time: 11, turnId }
    ]);
    const sessionId = opened.sessionId!;
    // The canonical shard can precede the terminal view observation. Its final-content
    // sequence is the completion proof; a later HTML remount is not another answer.
    const cached = await upsertMessageEvent(sessionId, {
      kind: 'assistant_message', source: 'extension', time: 20, turnId, messageId, providerMessageId,
      message: { text, chars: text.length, truncated: false }, state: 'final', final: true, goalEligible: true
    });
    if (cached.event.kind !== 'assistant_message') throw new Error('wrong cached message kind');
    await recordChatObservations(conversationId, [
      { kind: 'chat_error', time: 30, turnId, text: 'Could not load this ChatGPT conversation', recoverable: true },
      { kind: 'turn_end', time: 31, turnId, outcome: 'failed' }
    ]);
    if (restore === 'cold restore') {
      await flushSessions();
      resetRecorderForTests();
      resetSessionStoreForTests();
    }
    const replay = {
      kind: 'assistant_message' as const, time: 20, turnId, messageId, providerMessageId, text,
      renderedHtml: '<p data-remount="after-load">The exact completed answer was already recorded before the page failed.</p>',
      state: 'final' as const, final: true, goalEligible: true
    };
    const recovered = await recordChatObservations(conversationId, [replay]);
    const ends = await readEvents(sessionId, { kinds: ['turn_end'] });
    expect(ends.map(event => event.kind === 'turn_end' && event.outcome)).toEqual(['failed', 'completed']);
    expect(ends[1]).toMatchObject({ turnId, detail: 'the exact native final superseded the uncertain view' });
    expect(recovered.activity.endedTurnId).toBe(turnId);
    expect(liveConversations().find(entry => entry.conversationId === conversationId)).toMatchObject({
      generating: false, activeTurnId: null, lastTurnOutcome: 'completed'
    });
    const [final] = await readEvents(sessionId, { kinds: ['assistant_message'] });
    expect(final?.kind === 'assistant_message' && final.finalContentSeq).toBe(cached.event.finalContentSeq);
    expect(recovered.goalCandidates).toEqual([{ replyId: messageId, turnId, eventSeq: cached.event.origin ?? cached.event.seq }]);
    // This corrects one lifecycle verdict only: no new question, turn or repeated end.
    await recordChatObservations(conversationId, [replay]);
    expect(await readEvents(sessionId, { kinds: ['turn_start'] })).toHaveLength(1);
    expect(await readEvents(sessionId, { kinds: ['user_message'] })).toHaveLength(1);
    expect(await readEvents(sessionId, { kinds: ['turn_end'] })).toHaveLength(2);
  });

  it.each([
    'new tool before failure', 'new tool after failure', 'attributed tool before failure', 'attributed tool after failure',
    'new native activity', 'new human input',
    'new turn', 'different ended turn', 'explicit Stop', 'same-batch verdict', 'missing provider proof', 'superseded conversation'
  ] as const)('does not repair an unchanged cached final across %s', async (veto) => {
    const conversationId = `c-cached-final-veto-${veto}`;
    const turnId = 'g-cached-final-veto';
    const messageId = 'assistant-cached-final-veto';
    const providerMessageId = veto === 'missing provider proof' ? undefined : 'provider-cached-final-veto';
    const text = 'Completed work from the original turn.';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: 10, messageId: 'cached-veto-user', text: 'Original request.' },
      { kind: 'turn_start', time: 11, turnId }
    ]);
    const sessionId = opened.sessionId!;
    await upsertMessageEvent(sessionId, {
      kind: 'assistant_message', source: 'extension', time: 20, turnId, messageId, providerMessageId,
      message: { text, chars: text.length, truncated: false }, state: 'final', final: true, goalEligible: true
    });
    const newTool = () => appendEvent(sessionId, {
      time: 25, source: 'mcp', kind: 'tool_call', turnId,
      call: {
        callId: 'cached-veto-tool', tool: 'read', attribution: 'request_id', requestId: 'cached-veto-request',
        conversationId, attributionMethod: 'request_id',
        args: { text: '{}', chars: 2, truncated: false }, result: { text: 'ok', chars: 2, truncated: false },
        outcome: 'ok', durationMs: 1, summary: { title: 'Read a file', tone: 'neutral', kind: 'read' }
      }
    });
    const attributedTool = async () => {
      const requestId = 'wfr_cached_final_veto_after_final';
      await recordChatObservations(conversationId, [{
        kind: 'tool_evidence', time: 25, fiberConversationId: conversationId,
        calls: [{ messageId: 'actual-new-tool', tool: 'read', order: 0, answered: false, requestId }]
      }]);
      await recordToolCall({
        tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }],
        outcome: 'ok', durationMs: 1, requestId, startedAt: 26
      });
    };
    if (veto === 'new tool before failure') await newTool();
    if (veto === 'attributed tool before failure') await attributedTool();
    if (veto === 'new native activity') await recordChatObservations(conversationId, [{
      kind: 'page_tool', time: 25, turnId, messageId: 'new-native-after-final', text: 'Reading another file'
    }]);
    await recordChatObservations(conversationId, [{
      kind: 'turn_end', time: 31, turnId, outcome: veto === 'explicit Stop' ? 'stopped' : 'failed'
    }]);
    if (veto === 'new tool after failure') await newTool();
    if (veto === 'attributed tool after failure') await attributedTool();
    if (veto === 'new human input') await recordChatObservations(conversationId, [{
      kind: 'user_message', time: 32, messageId: 'new-human-after-final', text: 'Use my revised requirements.'
    }]);
    if (veto === 'new turn' || veto === 'different ended turn') {
      await recordChatObservations(conversationId, [{ kind: 'turn_start', time: 32, turnId: 'g-new-current' }]);
      if (veto === 'different ended turn') await recordChatObservations(conversationId, [{
        kind: 'turn_end', time: 33, turnId: 'g-new-current', outcome: 'failed'
      }]);
    }
    if (veto === 'superseded conversation') {
      expect(await rebindSession(sessionId, conversationId, 'c-cached-final-successor')).toBe(true);
      rebindConversation(sessionId, conversationId, 'c-cached-final-successor');
    }
    const before = await readEvents(sessionId, { kinds: ['turn_end'] });
    const replay = [{
      kind: 'assistant_message' as const, time: 20, turnId, messageId, providerMessageId, text,
      renderedHtml: '<p data-remount="veto">Completed work from the original turn.</p>',
      state: 'final' as const, final: true, goalEligible: true
    }];
    if (veto === 'same-batch verdict') await recordChatObservations(conversationId, [
      ...replay, { kind: 'turn_end', time: 34, turnId, outcome: 'failed' }
    ]);
    else await recordChatObservations(conversationId, replay);
    expect(await readEvents(sessionId, { kinds: ['turn_end'] })).toEqual(before);
    expect((await readEvents(sessionId, { kinds: ['turn_end'] })).some(event =>
      event.kind === 'turn_end' && event.turnId === turnId && event.outcome === 'completed')).toBe(false);
  });

  it('does not spend an earlier uncertain boundary while a newer turn is still open', async () => {
    const conversationId = 'c-goal-newer-turn-open';
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'g-old-uncertain' },
      { kind: 'turn_end', time: 20, turnId: 'g-old-uncertain', outcome: 'unknown' }
    ]);
    const current = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 30, turnId: 'g-new-open' },
      {
        kind: 'assistant_message',
        time: 35,
        messageId: 'assistant-while-new-open',
        text: 'Do not decide this turn before its own terminal boundary.',
        state: 'final',
        final: true
      }
    ]);

    expect(current.goalCandidates).toEqual([]);
  });

  it('does not advance seq or summary state when the durable append fails', async () => {
    const summary = await createSession({ title: 'append failure is not an event' });
    const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(
        appendEvent(summary.id, {
          time: 10,
          source: 'extension',
          kind: 'user_message',
          message: { text: 'phantom', truncated: false, chars: 7 }
        })
      ).rejects.toThrow('disk full');
    } finally {
      append.mockRestore();
    }

    const afterFailure = await getSession(summary.id);
    expect(afterFailure?.events).toBe(0);
    expect(afterFailure?.userMessages).toBe(0);
    expect(await readEvents(summary.id)).toHaveLength(0);

    const written = await appendEvent(summary.id, {
      time: 11,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'real', truncated: false, chars: 4 }
    });
    expect(written.seq).toBe(1);
    expect((await getSession(summary.id))?.events).toBe(1);
  });

  it('shares one disk reconstruction across concurrent callers after a restart', async () => {
    const summary = await createSession({ title: 'concurrent reopen' });
    resetSessionStoreForTests();

    const written = await Promise.all([
      appendEvent(summary.id, {
        time: 20,
        source: 'app',
        kind: 'note',
        message: { text: 'first concurrent writer', truncated: false, chars: 23 }
      }),
      appendEvent(summary.id, {
        time: 21,
        source: 'app',
        kind: 'note',
        message: { text: 'second concurrent writer', truncated: false, chars: 24 }
      })
    ]);

    expect(written.map((event) => event.seq).sort((a, b) => a - b)).toEqual([1, 2]);
    expect((await readEvents(summary.id)).map((event) => event.seq)).toEqual([1, 2]);
  });

  it('decides guarded progress after prior session writes without deadlocking or spending a sequence', async () => {
    const summary = await createSession({ title: 'atomic guarded progress' });
    await appendEvent(summary.id, {
      time: 10,
      source: 'extension',
      kind: 'turn_start',
      turnId: 'completed-turn'
    });

    let observed: { activeTurnId: string | null; outcome: string | null; terminal: boolean } | null = null;
    const terminal = appendEvent(summary.id, {
      time: 20,
      source: 'extension',
      kind: 'turn_end',
      turnId: 'completed-turn',
      outcome: 'completed'
    });
    const guarded = recordProgress(
      summary.id,
      'browser-repair:stale',
      'Reloaded chat to recover an interrupted response.',
      undefined,
      'completed-turn',
      undefined,
      async current => {
        const [end] = await current.readRecentEvents(1, { kinds: ['turn_end'] });
        const terminalTurn = end?.kind === 'turn_end' && end.turnId === 'completed-turn' &&
          (end.outcome === 'completed' || end.outcome === 'stopped');
        observed = {
          activeTurnId: current.activeTurnId,
          outcome: current.lastTurnOutcome,
          terminal: terminalTurn
        };
        return !terminalTurn;
      }
    );

    await terminal;
    expect(await guarded).toBeNull();
    expect(observed).toEqual({ activeTurnId: null, outcome: 'completed', terminal: true });

    let ownerChecked = false;
    expect(await recordProgress(
      summary.id,
      'browser-repair:replaced-owner',
      'This owner is stale.',
      undefined,
      null,
      undefined,
      () => {
        ownerChecked = true;
        return false;
      }
    )).toBeNull();
    expect(ownerChecked).toBe(true);

    const next = await appendEvent(summary.id, {
      time: 30,
      source: 'app',
      kind: 'note',
      message: { text: 'still contiguous', truncated: false, chars: 16 }
    });
    expect(next.seq).toBe(3);
    expect((await readEvents(summary.id)).map(event => event.kind)).toEqual(['turn_start', 'turn_end', 'note']);
  });

  it('skips a torn final line and keeps appending after it', async () => {
    const summary = await createSession({ title: 'recovery' });
    await appendEvent(summary.id, {
      time: 1,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'first', truncated: false, chars: 5 }
    });
    await appendEvent(summary.id, {
      time: 2,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'second', truncated: false, chars: 6 }
    });

    // Exactly what a crash mid-append leaves behind: a line with no closing brace.
    const file = path.join(sessionsRoot(), summary.id, 'events.jsonl');
    await fs.appendFile(file, '{"seq":3,"kind":"user_mess', 'utf8');
    resetSessionStoreForTests();

    const recovered = await readEvents(summary.id);
    expect(recovered).toHaveLength(2);

    await appendEvent(summary.id, {
      time: 4,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'third', truncated: false, chars: 5 }
    });
    const all = await readEvents(summary.id);
    expect(all).toHaveLength(3);
    // The number after a torn line must not collide with one already used.
    expect(new Set(all.map((event) => event.seq)).size).toBe(3);
    expect(all[2]!.seq).toBeGreaterThan(all[1]!.seq);
  });

  it('recovers the prior sequence behind a near-limit torn final line', async () => {
    const summary = await createSession({ title: 'large torn tail recovery' });
    const prior = await appendEvent(summary.id, {
      time: 1,
      source: 'extension',
      kind: 'chat_error',
      message: { text: 'durable predecessor', truncated: false, chars: 19 }
    });
    const file = path.join(sessionsRoot(), summary.id, 'events.jsonl');
    // Larger than the historical 128 KiB restart window, but still within the maximum
    // amount a crash can leave from one otherwise legal event line.
    await fs.appendFile(file, `{"seq":${prior.seq + 1},"kind":"chat_error","padding":"${'x'.repeat(400 * 1024)}`, 'utf8');
    resetSessionStoreForTests();

    const next = await appendEvent(summary.id, {
      time: 2,
      source: 'extension',
      kind: 'chat_error',
      message: { text: 'after restart', truncated: false, chars: 13 }
    });

    expect(next.seq).toBe(prior.seq + 1);
    expect((await readEvents(summary.id)).map((event) => event.seq)).toEqual([prior.seq, next.seq]);
  });

  it('recovers a session whose meta.json is gone', async () => {
    const summary = await createSession({ title: 'no meta' });
    await appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start' });
    resetSessionStoreForTests();
    await fs.rm(path.join(sessionsRoot(), summary.id, 'meta.json'), { force: true });

    await appendEvent(summary.id, { time: 2, source: 'extension', kind: 'turn_end', outcome: 'completed' });
    const events = await readEvents(summary.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it('reconciles durable journal state when a crash loses the debounced metadata write', async () => {
    const summary = await createSession({ title: 'stale meta journal recovery' });
    const handoffId = '2026-08-25-crash001';
    await appendEvent(summary.id, { time: 10, source: 'extension', kind: 'turn_start', turnId: 'turn-crash' });
    await appendEvent(summary.id, {
      time: 11,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'durable before the crash', truncated: false, chars: 24 }
    });
    await appendEvent(summary.id, {
      time: 12,
      source: 'extension',
      kind: 'chat_error',
      message: { text: 'also durable', truncated: false, chars: 12 }
    });
    await saveHandoff({
      id: handoffId,
      sessionId: summary.id,
      createdAt: 13,
      text: 'TASK — recover this durable handoff',
      sourceEvents: 3,
      sourceTokens: 10,
      notes: []
    });
    await appendEvent(summary.id, {
      time: 13,
      source: 'app',
      kind: 'handoff',
      handoffId,
      chars: 34,
      reason: 'manual'
    });

    const staleMeta = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), summary.id, 'meta.json'), 'utf8')
    ) as { events: number; lastHandoffId: string | null };
    expect(staleMeta.events).toBe(0);
    expect(staleMeta.lastHandoffId).toBeNull();

    // Simulate process death before the 1.5 s metadata debounce fires. The next mutation opens
    // from disk and must project the four already-durable records before applying sequence 5.
    resetSessionStoreForTests();
    const afterCrash = await appendEvent(summary.id, {
      time: 14,
      source: 'app',
      kind: 'note',
      message: { text: 'after restart', truncated: false, chars: 13 }
    });
    expect(afterCrash.seq).toBe(5);

    const recovered = await getSession(summary.id);
    expect(recovered).toMatchObject({
      events: 5,
      userMessages: 1,
      errors: 1,
      activeTurnId: 'turn-crash',
      lastHandoffId: handoffId,
      lastHandoffAt: 13
    });
  });

  it('repairs a stale metadata projection on the first read after restart without a new mutation', async () => {
    const summary = await createSession({ title: 'read-only crash recovery' });
    const handoffId = '2026-08-25-readonly1';
    await appendEvent(summary.id, { time: 30, source: 'extension', kind: 'turn_start', turnId: 'turn-read' });
    await appendEvent(summary.id, {
      time: 31,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'survived on disk', truncated: false, chars: 16 }
    });
    await saveHandoff({
      id: handoffId,
      sessionId: summary.id,
      createdAt: 32,
      text: 'TASK — read-only recovery',
      sourceEvents: 2,
      sourceTokens: 8,
      notes: []
    });
    await appendEvent(summary.id, {
      time: 32,
      source: 'app',
      kind: 'handoff',
      handoffId,
      chars: 25,
      reason: 'manual'
    });

    const metaPath = path.join(sessionsRoot(), summary.id, 'meta.json');
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject({ events: 0, lastHandoffId: null });

    // Simulate process death before the metadata debounce. There is deliberately no append,
    // reopen or other mutation after reset: merely opening history must repair the projection.
    resetSessionStoreForTests();
    const recovered = await getSession(summary.id);
    expect(recovered).toMatchObject({
      events: 3,
      userMessages: 1,
      activeTurnId: 'turn-read',
      lastHandoffId: handoffId,
      lastHandoffAt: 32
    });
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject({
      events: 3,
      userMessages: 1,
      lastHandoffId: handoffId
    });
  });

  const toolCall = (callId: string, tool: string, outcome: string, metric: string | undefined, seq: number) => ({
    time: 100 + seq,
    source: 'app' as const,
    kind: 'tool_call' as const,
    call: {
      callId,
      tool,
      attribution: 'unattributed' as const,
      requestId: null,
      conversationId: null,
      attributionMethod: 'unattributed' as const,
      args: { text: '{}', truncated: false, chars: 2 },
      result: { text: 'ok', truncated: false, chars: 2 },
      outcome: outcome as ToolOutcome,
      durationMs: 1,
      summary: { title: callId, tone: 'neutral' as const, kind: 'run' as const, ...(metric ? { metric } : {}) }
    }
  });

  it('charges the reliability count for a defect here and for nothing else', async () => {
    const summary = await createSession({ title: 'reliability numerator' });
    await appendEvent(summary.id, toolCall('clean', 'exec_command', 'ok', undefined, 1));
    await appendEvent(summary.id, toolCall('failing-build', 'exec_command', 'process_exit_nonzero', undefined, 2));
    await appendEvent(summary.id, toolCall('refused', 'apply_patch', 'tool_rejected', undefined, 3));
    expect(await getSession(summary.id)).toMatchObject({ toolCalls: 3, errors: 0 });

    await appendEvent(summary.id, toolCall('broken', 'exec_command', 'tool_internal_error', undefined, 4));
    expect(await getSession(summary.id)).toMatchObject({
      toolCalls: 4,
      processExitNonzero: 1,
      toolRejected: 1,
      toolInternalErrors: 1,
      errors: 1
    });
  });

  it('re-derives outcome counters for a session recorded before the taxonomy existed', async () => {
    const summary = await createSession({ title: 'legacy outcome projection' });
    await appendEvent(summary.id, toolCall('legacy-exit', 'exec_command', 'error', '✕ exit 7', 1));
    await appendEvent(summary.id, toolCall('legacy-refusal', 'apply_patch', 'rejected', 'refused', 2));
    await appendEvent(summary.id, toolCall('legacy-ambiguous', 'read', 'error', undefined, 3));
    await flushSessions();

    const metaPath = path.join(sessionsRoot(), summary.id, 'meta.json');
    const stored = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
    delete stored.processExitNonzero;
    delete stored.toolRejected;
    delete stored.toolInternalErrors;
    stored.errors = 3;
    await fs.writeFile(metaPath, JSON.stringify(stored, null, 2), 'utf8');

    resetSessionStoreForTests();
    const expected = { processExitNonzero: 1, toolRejected: 1, toolInternalErrors: 0, errors: 0 };
    expect(await getSession(summary.id)).toMatchObject({ toolCalls: 3, ...expected });
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject(expected);

    const outcomes = (await readEvents(summary.id))
      .filter((event): event is Extract<SessionEvent, { kind: 'tool_call' }> => event.kind === 'tool_call')
      .map((event) => event.call.outcome);
    expect(outcomes).toEqual(['error', 'rejected', 'error']);
  });

  it('reconciles a canonical message revision newer than the metadata checkpoint', async () => {
    const summary = await createSession({ title: 'stale meta canonical recovery' });
    const messageId = 'canonical-crash-revision';
    await upsertMessageEvent(summary.id, {
      time: 20,
      source: 'extension',
      kind: 'user_message',
      messageId,
      message: { text: 'small', truncated: false, chars: 5 }
    });
    await flushSessions();

    const revised = await upsertMessageEvent(summary.id, {
      time: 21,
      source: 'extension',
      kind: 'user_message',
      messageId,
      message: { text: 'x'.repeat(400), truncated: false, chars: 400 }
    });
    const checkpoint = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), summary.id, 'meta.json'), 'utf8')
    ) as { estimatedTokens: number };
    expect(checkpoint.estimatedTokens).toBeLessThan(eventTokens(revised.event));

    resetSessionStoreForTests();
    const afterCrash = await appendEvent(summary.id, {
      time: 22,
      source: 'app',
      kind: 'note',
      message: { text: 'open recovered state', truncated: false, chars: 20 }
    });
    expect(afterCrash.seq).toBe(revised.event.seq + 1);

    const recovered = await getSession(summary.id);
    expect(recovered?.events).toBe(2);
    expect(recovered?.userMessages).toBe(1);
    const expectedTokens = eventTokens(revised.event) + eventTokens(afterCrash);
    expect(recovered?.estimatedTokens).toBe(expectedTokens);
    expect(recovered?.contextTokens).toBe(expectedTokens);
  });

  it('repairs a canonical message revision while building the read-only session list after restart', async () => {
    const summary = await createSession({ title: 'catalog crash recovery' });
    const messageId = 'canonical-read-only-revision';
    await upsertMessageEvent(summary.id, {
      time: 40,
      source: 'extension',
      kind: 'user_message',
      messageId,
      message: { text: 'tiny', truncated: false, chars: 4 }
    });
    await flushSessions();

    const revised = await upsertMessageEvent(summary.id, {
      time: 41,
      source: 'extension',
      kind: 'user_message',
      messageId,
      message: { text: 'r'.repeat(800), truncated: false, chars: 800 }
    });
    resetSessionStoreForTests();

    const listed = (await listSessions()).find((entry) => entry.id === summary.id);
    expect(listed?.userMessages).toBe(1);
    expect(listed?.events).toBe(1);
    expect(listed?.estimatedTokens).toBe(eventTokens(revised.event));
    expect(listed?.contextTokens).toBe(eventTokens(revised.event));
  });

  it.each([false, true])('migrates legacy return estimates once while preserving frontend resets (rebound=%s)', async rebound => {
    const summary = await createSession({ title: 'return estimate migration', conversationId: 'estimate-source' });
    const call = (conversationId: string, chars: number) => ({ time: Date.now(), source: 'mcp' as const,
      kind: 'tool_call' as const, call: {
        callId: conversationId, conversationId, tool: 'read', attribution: 'request_id' as const,
        requestId: `request-${conversationId}`, attributionMethod: 'request_id' as const,
        args: { text: '{}', chars: 2, truncated: false },
        result: { text: 'preview', chars, truncated: true },
        outcome: 'ok' as const, durationMs: 1, summary: { title: 'Read', tone: 'neutral' as const, kind: 'read' as const }
      } });
    await appendEvent(summary.id, call('estimate-source', 524582));
    if (rebound) {
      expect(await rebindSession(summary.id, 'estimate-source', 'estimate-destination')).toBe(true);
      await appendEvent(summary.id, call('estimate-destination', 80000));
    }
    await flushSessions();
    const metaPath = path.join(sessionsRoot(), summary.id, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    const expected = { estimatedTokens: meta.estimatedTokens, contextTokens: meta.contextTokens };
    delete meta.__tokenEstimate;
    meta.estimatedTokens += 121146 + (rebound ? 10000 : 0);
    meta.contextTokens += rebound ? 10000 : 121146;
    await fs.writeFile(metaPath, JSON.stringify(meta));
    resetSessionStoreForTests();
    expect((await listSessions()).find(entry => entry.id === summary.id)).toMatchObject(expected);
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8')).__tokenEstimate).toBe(1);
    resetSessionStoreForTests();
    expect(await getSession(summary.id)).toMatchObject(expected);
    const events = await readEvents(summary.id);
    expect(events.find(event => event.kind === 'tool_call' && event.call.conversationId === 'estimate-source'))
      .toMatchObject({ call: { result: { chars: 524582, text: 'preview' } } });
  });

  it('stores assets once per content and refuses a malformed asset id', async () => {
    const summary = await createSession({ title: 'assets' });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const first = await writeAsset(summary.id, png, 'image/png');
    const second = await writeAsset(summary.id, png, 'image/png');
    expect(second.id).toBe(first.id);
    expect(first.id.endsWith('.png')).toBe(true);

    const files = await fs.readdir(path.join(sessionsRoot(), summary.id, 'assets'));
    expect(files).toHaveLength(1);
    expect(await readAsset(summary.id, first.id)).toEqual(png);
    expect(await readAsset(summary.id, '../../../config.json')).toBeNull();
  });

  it('keeps automatic compaction model-independent, including Pro', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'Astra policy', conversationId: 'conv-astra' });
      await appendEvent(summary.id, {
        time: Date.now(), source: 'extension', kind: 'user_message', messageId: 'astra-u',
        message: { text: 'x'.repeat(44_000), chars: 44_000, truncated: false }
      });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      await observeSessionModel(summary.id, 'conv-astra', 'GPT-6 Pro', 200);
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      // A delayed old receipt and a foreign document are neither the current selection.
      await observeSessionModel(summary.id, 'conv-astra', 'gpt-6-sol', 100);
      await observeSessionModel(summary.id, 'other-chat', 'gpt-6-sol', 300);
      await flushSessions();
      resetSessionStoreForTests();
      expect((await getSession(summary.id))?.selectedModel?.model).toBe('GPT-6 Pro');
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      await observeSessionModel(summary.id, 'conv-astra', 'gpt-5.6-sol', 400);
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      await saveConfig({ ...base, ui: { ...base.ui, finishTool: true }, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      await observeSessionModel(summary.id, 'conv-astra', 'gpt-6-astra', 500);
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      await observeSessionModel(summary.id, 'conv-astra', 'gpt-5.6-pro', 510);
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      await observeSessionModel(summary.id, 'conv-astra', 'gpt-5.6-sol', 520, 'pro');
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      await observeSessionModel(summary.id, 'conv-astra', 'gpt-6', 530, 'pro');
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
      await observeSessionModel(summary.id, 'conv-astra', 'gpt-5.6-sol', 600);
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
    } finally { await saveConfig(base); }
  });

  it('keeps automatic compaction ready above the line across interrupted and later turns', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'auto level', conversationId: 'conv-auto-level' });
      await appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start', turnId: 't-1' });
      await appendEvent(summary.id, {
        time: 2,
        source: 'extension',
        kind: 'user_message',
        messageId: 'u1',
        turnId: 't-1',
        message: { text: 'a'.repeat(44_000), truncated: false, chars: 44_000 }
      });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);

      await appendEvent(summary.id, { time: 3, source: 'extension', kind: 'turn_end', turnId: 't-1', outcome: 'interrupted' });
      await appendEvent(summary.id, { time: 4, source: 'extension', kind: 'turn_start', turnId: 't-2' });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
    } finally {
      await saveConfig(base);
    }
  });

  it('offers nothing while the switch is off or below the line', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: false, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'off', conversationId: 'conv-auto-off' });
      await appendEvent(summary.id, {
        time: 1,
        source: 'extension',
        kind: 'user_message',
        messageId: 'u1',
        message: { text: 'a'.repeat(44_000), truncated: false, chars: 44_000 }
      });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(false);

      await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 4_000_000 } });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(false);

      await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
    } finally {
      await saveConfig(base);
    }
  });

  it('keeps the level ready across a close and reopen so a later generation can retry', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'reopened', conversationId: 'conv-auto-reopen' });
      await appendEvent(summary.id, {
        time: 1,
        source: 'extension',
        kind: 'user_message',
        messageId: 'u1',
        message: { text: 'r'.repeat(44_000), truncated: false, chars: 44_000 }
      });
      await endSession(summary.id);
      await reopenSession(summary.id);
      const reopened = await getSession(summary.id);
      expect(autoCompactionReady(reopened)).toBe(true);
    } finally {
      await saveConfig(base);
    }
  });
});

// ---------------------------------------------------------------- handoffs

describe('recoverable manual deletion', () => {
  it('does not recreate a retired session directory from a delayed metadata write', async () => {
    const summary = await createSession({ title: 'No resurrection' });
    await flushSessions();
    const active = path.join(sessionsRoot(), summary.id);
    const recovery = path.join(sessionsRoot(), '.deleted-sessions', summary.id);
    await fs.mkdir(path.dirname(recovery), { recursive: true });
    await fs.rename(active, recovery);
    await expect(endSession(summary.id)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(active)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rename(recovery, active);
    await endSession(summary.id);
  });

  it('preserves a resurrected metadata-only folder without blocking an existing recovery copy', async () => {
    const summary = await createSession({ title: 'Original recovery', conversationId: 'original-recovery-chat' });
    await flushSessions();
    await deleteSession(summary.id);
    const active = path.join(sessionsRoot(), summary.id);
    const recovery = path.join(sessionsRoot(), '.deleted-sessions', summary.id);
    const original = await fs.readFile(path.join(recovery, 'meta.json'), 'utf8');
    await fs.mkdir(active);
    await fs.writeFile(path.join(active, 'meta.json'), original);
    await expect(deleteSession(summary.id)).resolves.toMatchObject({ id: summary.id });
    await expect(fs.stat(active)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(recovery, 'meta.json'), 'utf8')).toBe(original);
    const copies = (await fs.readdir(recovery)).filter((name) => name.startsWith('.late-metadata-'));
    expect(copies).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(recovery, copies[0]!, 'meta.json'), 'utf8')).id).toBe(summary.id);
    await expect(restoreDeletedSession(summary.id)).resolves.toMatchObject({ title: 'Original recovery' });
  });

  it('does not merge a colliding active transcript into a recovery copy', async () => {
    const summary = await createSession({ title: 'Keep both' });
    await flushSessions();
    await deleteSession(summary.id);
    const active = path.join(sessionsRoot(), summary.id);
    const recovery = path.join(sessionsRoot(), '.deleted-sessions', summary.id);
    await fs.mkdir(active);
    await fs.copyFile(path.join(recovery, 'meta.json'), path.join(active, 'meta.json'));
    await fs.writeFile(path.join(active, 'events.jsonl'), '');
    await expect(deleteSession(summary.id)).rejects.toThrow('recovery copy');
    expect(await fs.stat(path.join(active, 'events.jsonl'))).toBeTruthy();
    expect(await fs.stat(path.join(recovery, 'meta.json'))).toBeTruthy();
    await fs.rename(active, path.join(recovery, '.test-collision'));
    await restoreDeletedSession(summary.id);
  });

  it('moves the exact session out of the catalog and restores its complete history', async () => {
    const summary = await createSession({ title: 'Undo this deletion', conversationId: 'undo-delete-conversation' });
    await appendEvent(summary.id, {
      source: 'extension',
      kind: 'turn_start',
      turnId: 'undo-turn',
      time: Date.now()
    });
    await flushSessions();

    const deleted = await deleteSession(summary.id);
    expect(deleted).toMatchObject({ id: summary.id, title: 'Undo this deletion' });
    expect(await getSession(summary.id)).toBeNull();
    await expect(fs.stat(path.join(sessionsRoot(), summary.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.stat(path.join(sessionsRoot(), '.deleted-sessions', summary.id))).toBeTruthy();

    const restored = await restoreDeletedSession(summary.id);
    expect(restored).toMatchObject({ id: summary.id, conversationId: 'undo-delete-conversation' });
    expect(await readEvents(summary.id)).toEqual([
      expect.objectContaining({ kind: 'turn_start', turnId: 'undo-turn' })
    ]);
  });

  it('counts and permanently removes only validated app-trash session folders', async () => {
    const first = await createSession({ title: 'Erase one', conversationId: 'permanent-delete-one' });
    const second = await createSession({ title: 'Erase all', conversationId: 'permanent-delete-two' });
    await deleteSession(first.id);
    await deleteSession(second.id);
    expect(await deletedSessionCount()).toBe(2);
    expect(await listDeletedSessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, conversationId: 'permanent-delete-one' }),
      expect.objectContaining({ id: second.id, conversationId: 'permanent-delete-two' })
    ]));
    expect(await permanentlyDeleteSession(first.id)).toBe(true);
    expect(await permanentlyDeleteSession(first.id)).toBe(false);
    expect(await deletedSessionCount()).toBe(1);
    expect(await emptyDeletedSessions()).toBe(1);
    expect(await deletedSessionCount()).toBe(0);
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'] as const)(
    'retries transient %s directory locks while deleting and restoring',
    async (code) => {
      const summary = await createSession({ title: `Retry ${code}`, conversationId: `retry-${code.toLowerCase()}` });
      await flushSessions();
      const active = path.join(sessionsRoot(), summary.id);
      const recovery = path.join(sessionsRoot(), '.deleted-sessions', summary.id);
      const realRename = fs.rename.bind(fs);
      let deleteFailures = 2;
      let restoreFailures = 2;
      const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        const source = path.resolve(String(from));
        const destination = path.resolve(String(to));
        if (source === path.resolve(active) && destination === path.resolve(recovery) && deleteFailures > 0) {
          deleteFailures -= 1;
          throw Object.assign(new Error(`temporary delete ${code}`), { code });
        }
        if (source === path.resolve(recovery) && destination === path.resolve(active) && restoreFailures > 0) {
          restoreFailures -= 1;
          throw Object.assign(new Error(`temporary restore ${code}`), { code });
        }
        return realRename(from, to);
      });
      try {
        await expect(deleteSession(summary.id)).resolves.toMatchObject({ id: summary.id });

        await expect(restoreDeletedSession(summary.id)).resolves.toMatchObject({ id: summary.id });
        expect(deleteFailures).toBe(0);
        expect(restoreFailures).toBe(0);
      } finally {
        rename.mockRestore();
      }
    }
  );

  it('fails non-sharing rename errors immediately without moving either durable copy', async () => {
    const summary = await createSession({ title: 'Do not retry', conversationId: 'do-not-retry-delete' });
    await flushSessions();
    const active = path.join(sessionsRoot(), summary.id);
    const recovery = path.join(sessionsRoot(), '.deleted-sessions', summary.id);
    const realRename = fs.rename.bind(fs);
    let phase: 'reject-delete' | 'allow-delete' | 'reject-restore' = 'reject-delete';
    let rejectedDeleteAttempts = 0;
    let rejectedRestoreAttempts = 0;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const source = path.resolve(String(from));
      const destination = path.resolve(String(to));
      if (source === path.resolve(active) && destination === path.resolve(recovery) && phase === 'reject-delete') {
        rejectedDeleteAttempts += 1;
        throw Object.assign(new Error('invalid cross-device move'), { code: 'EXDEV' });
      }
      if (source === path.resolve(recovery) && destination === path.resolve(active) && phase === 'reject-restore') {
        rejectedRestoreAttempts += 1;
        throw Object.assign(new Error('invalid cross-device move'), { code: 'EXDEV' });
      }
      return realRename(from, to);
    });
    try {
      await expect(deleteSession(summary.id)).rejects.toMatchObject({ code: 'EXDEV' });
      expect(rejectedDeleteAttempts).toBe(1);
      expect(await fs.stat(active)).toBeTruthy();
      await expect(fs.stat(recovery)).rejects.toMatchObject({ code: 'ENOENT' });

      phase = 'allow-delete';
      await deleteSession(summary.id);
      phase = 'reject-restore';
      await expect(restoreDeletedSession(summary.id)).rejects.toMatchObject({ code: 'EXDEV' });
      expect(rejectedRestoreAttempts).toBe(1);
      expect(await fs.stat(recovery)).toBeTruthy();
      await expect(fs.stat(active)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      rename.mockRestore();
    }
  });
});

describe('handoff storage', () => {
  const handoff = (sessionId: string, id: string, createdAt: number) => ({
    id,
    sessionId,
    createdAt,
    model: 'deepseek/test',
    reasoning: 'medium',
    text: 'TASK — finish the thing',
    sourceEvents: 3,
    sourceTokens: 120,
    notes: []
  });

  it('publishes one exact handoff safely across overlapping identical saves and cold reopen', async () => {
    const session = await createSession({ title: 'exclusive handoff retry' });
    const id = '2026-10-18-retry000';
    const original = handoff(session.id, id, 1_000);
    await Promise.all([saveHandoff(original), saveHandoff({ ...original })]);
    const folder = path.join(sessionsRoot(), session.id, 'handoffs');
    expect(await readHandoff(session.id, id)).toMatchObject(original);
    expect((await fs.readdir(folder)).filter(name => name.endsWith('.tmp'))).toHaveLength(0);

    resetSessionStoreForTests();
    expect(await readHandoff(session.id, id)).toMatchObject(original);
    await expect(saveHandoff({ ...original, text: 'different task trying to reuse the id' }))
      .rejects.toThrow(/different content/);
    expect(await readHandoff(session.id, id)).toMatchObject(original);
    expect((await fs.readdir(folder)).filter(name => name.endsWith('.tmp'))).toHaveLength(0);
  });

  it('refuses conflicting concurrent handoffs without replacing either published writer', async () => {
    const session = await createSession({ title: 'handoff collision' });
    const id = '2026-10-18-conflict1';
    const first = handoff(session.id, id, 2_000);
    const second = { ...first, text: 'DIFFERENT handoff content' };
    const results = await Promise.allSettled([saveHandoff(first), saveHandoff(second)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const saved = await readHandoff(session.id, id);
    expect([first.text, second.text]).toContain(saved?.text);
    expect((await fs.readdir(path.join(sessionsRoot(), session.id, 'handoffs')))
      .filter(name => name.endsWith('.tmp'))).toHaveLength(0);
  });

  it('keeps an already accepted handoff when a new publication fails and removes its own stage', async () => {
    const session = await createSession({ title: 'handoff publication failure' });
    const prior = handoff(session.id, '2026-10-18-accepted1', 3_000);
    const candidate = handoff(session.id, '2026-10-18-refused01', 4_000);
    await saveHandoff(prior);
    const link = vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('injected publication error'), {
      code: 'ENOSPC'
    }));
    try {
      await expect(saveHandoff(candidate)).rejects.toMatchObject({ code: 'ENOSPC' });
    } finally {
      link.mockRestore();
    }
    expect(await readHandoff(session.id, prior.id)).toMatchObject(prior);
    expect(await readHandoff(session.id, candidate.id)).toBeNull();
    expect((await fs.readdir(path.join(sessionsRoot(), session.id, 'handoffs')))
      .filter(name => name.endsWith('.tmp'))).toHaveLength(0);
  });

  it('rejects invalid handoff filenames and legacy files claiming a different immutable owner', async () => {
    const session = await createSession({ title: 'legacy handoff ownership' });
    const id = '2026-10-18-legacy01';
    const original = handoff(session.id, id, 5_000);
    await expect(saveHandoff({ ...original, id: '../foreign-handoff' }))
      .rejects.toThrow(/Invalid handoff identity/);
    await saveHandoff(original);
    const file = path.join(sessionsRoot(), session.id, 'handoffs', `${id}.json`);
    for (const changed of [
      { ...original, id: '2026-10-18-foreign1' },
      { ...original, sessionId: 'foreign-session-1234' }
    ]) {
      await fs.writeFile(file, JSON.stringify(changed));
      expect(await readHandoff(session.id, id)).toBeNull();
    }
  });

  it('saves, reads back and reports the newest across sessions', async () => {
    const older = await createSession({ title: 'older' });
    const newer = await createSession({ title: 'newer' });
    await saveHandoff(handoff(older.id, '2026-01-01-aaaaaaaa', 1000));
    await saveHandoff(handoff(newer.id, '2026-01-02-bbbbbbbb', 2000));
    await appendEvent(older.id, {
      time: 1000,
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-01-aaaaaaaa',
      chars: 23,
      reason: 'manual'
    });
    await appendEvent(newer.id, {
      time: 2000,
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-02-bbbbbbbb',
      chars: 23,
      reason: 'resume'
    });

    expect((await readHandoff(older.id, '2026-01-01-aaaaaaaa'))?.text).toContain('TASK');
    expect((await latestHandoff())?.id).toBe('2026-01-02-bbbbbbbb');
    expect((await getSession(newer.id))?.lastHandoffId).toBe('2026-01-02-bbbbbbbb');
    await deleteSession(older.id);
    await deleteSession(newer.id);
  });

  it('reports a durable handoff after restart even when meta.json missed its debounced projection', async () => {
    const summary = await createSession({ title: 'handoff crash recovery' });
    const handoffId = '2026-08-25-crash002';
    await saveHandoff(handoff(summary.id, handoffId, 3_000));
    await appendEvent(summary.id, {
      time: 3_000,
      source: 'app',
      kind: 'handoff',
      handoffId,
      chars: 23,
      reason: 'manual'
    });

    const staleMeta = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), summary.id, 'meta.json'), 'utf8')
    ) as { lastHandoffId: string | null };
    expect(staleMeta.lastHandoffId).toBeNull();

    resetSessionStoreForTests();
    expect((await latestHandoff())?.id).toBe(handoffId);
    expect((await getSession(summary.id))?.lastHandoffId).toBe(handoffId);
    await deleteSession(summary.id);
  });

  it('finds the newest handoff even when its session is beyond the 5,000-folder maintenance cap', async () => {
    const seed = await createSession({ title: 'handoff catalog seed' });
    const seedFile = path.join(sessionsRoot(), seed.id, 'meta.json');
    const seedSummary = JSON.parse(await fs.readFile(seedFile, 'utf8'));
    expect(seedSummary).toMatchObject({ __historySeq: 0, __canonicalProjection: 1, __tokenEstimate: 1 });
    const statSpy = mockCatalogCheckpointStats('handoff-', await fs.stat(seedFile));
    resetSessionStoreForTests();

    const names = Array.from({ length: 5001 }, (_, index) => `handoff-${String(index).padStart(5, '0')}`);
    const targetId = names.at(-1)!;
    const handoffId = '2026-08-24-deadbeef';
    const realReaddir = fs.readdir.bind(fs);
    const realReadFile = fs.readFile.bind(fs);
    const rootPath = sessionsRoot();
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
      (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (String(target) === rootPath) return names;
        return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
      }) as typeof fs.readdir
    );
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(
      (async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        const file = String(target);
        const id = path.basename(path.dirname(file));
        if (file.endsWith('meta.json') && id.startsWith('handoff-')) {
          return JSON.stringify({
            ...seedSummary,
            id,
            title: id,
            updatedAt: id === targetId ? 20_000 : 10_000,
            lastHandoffId: id === targetId ? handoffId : null,
            lastHandoffAt: id === targetId ? 20_000 : null
          });
        }
        if (file.endsWith(`${path.sep}handoffs${path.sep}${handoffId}.json`)) {
          return JSON.stringify(handoff(targetId, handoffId, 20_000));
        }
        return (realReadFile as (...callArgs: unknown[]) => ReturnType<typeof fs.readFile>)(target, ...args);
      }) as typeof fs.readFile
    );

    try {
      expect((await latestHandoff())?.id).toBe(handoffId);
      expect(new Set(readSpy.mock.calls.filter(([file]) => String(file).endsWith('meta.json') &&
        path.basename(path.dirname(String(file))).startsWith('handoff-'))
        .map(([file]) => path.basename(path.dirname(String(file))))).size).toBe(5001);
    } finally {
      readdirSpy.mockRestore();
      readSpy.mockRestore();
      statSpy.mockRestore();
      resetSessionStoreForTests();
      await deleteSession(seed.id);
    }
  }, 90_000);

  it('never prunes the session holding the newest handoff', async () => {
    const stale = await createSession({ title: 'stale' });
    const kept = await createSession({ title: 'kept' });
    await saveHandoff(handoff(kept.id, '2026-01-03-cccccccc', Date.now()));
    await appendEvent(kept.id, {
      time: Date.now(),
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-03-cccccccc',
      chars: 23,
      reason: 'manual'
    });

    // Age both sessions past the retention window by rewriting their summaries.
    // Flushed first: the test seam forgets state without writing meta.json.
    await flushSessions();
    resetSessionStoreForTests();
    const long = Date.now() - 90 * 24 * 3600_000;
    for (const id of [stale.id, kept.id]) {
      const metaPath = path.join(sessionsRoot(), id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(metaPath, JSON.stringify({ ...meta, updatedAt: long }), 'utf8');
    }

    const removed = await pruneSessions(30);
    expect(removed).toBeGreaterThanOrEqual(1);
    // Retention is not the UI's first 200 rows. Check durable existence directly so this
    // invariant stays valid even when the retained handoff is intentionally old in a large
    // test history.
    expect(await getSession(kept.id)).not.toBeNull();
    expect(await getSession(stale.id)).toBeNull();
    await deleteSession(kept.id);
  }, 90_000);

  it('retains uncertain handoff owners during expiry but still prunes unrelated sessions', async () => {
    const missing = await createSession({ title: 'unreadable handoff custody' });
    const readable = await createSession({ title: 'other readable handoff' });
    const unrelated = await createSession({ title: 'unrelated expired session' });
    const missingId = '2026-10-19-missing1';
    const readableId = '2026-10-18-readable';
    for (const [session, id, createdAt] of [
      [missing, missingId, Date.now()] as const,
      [readable, readableId, Date.now() - 10_000] as const
    ]) {
      await saveHandoff(handoff(session.id, id, createdAt));
      await appendEvent(session.id, {
        time: createdAt,
        source: 'app',
        kind: 'handoff',
        handoffId: id,
        chars: 23,
        reason: 'manual'
      });
    }
    await flushSessions();
    resetSessionStoreForTests();

    // A committed handoff reference can survive a crash with unreadable payload
    // bytes. That uncertainty cannot license retention to delete its source.
    await fs.writeFile(path.join(sessionsRoot(), missing.id, 'handoffs', `${missingId}.json`), '{');
    const expired = Date.now() - 90 * 24 * 3600_000;
    for (const id of [missing.id, readable.id, unrelated.id]) {
      const metaPath = path.join(sessionsRoot(), id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(metaPath, JSON.stringify({ ...meta, updatedAt: expired }), 'utf8');
    }
    expect(await readHandoff(missing.id, missingId)).toBeNull();
    expect((await latestHandoff())?.id).toBe(readableId);

    expect(await pruneSessions(30)).toBe(1);
    expect(await getSession(missing.id)).not.toBeNull();
    expect(await getSession(readable.id)).not.toBeNull();
    expect(await getSession(unrelated.id)).toBeNull();
    await deleteSession(missing.id);
    await deleteSession(readable.id);
  }, 90_000);

  it('retention recovery safety holds a physical folder with missing metadata instead of assuming an empty catalog', async () => {
    const old = await createSession({ title: 'expiration must wait for complete catalog' });
    await flushSessions();
    resetSessionStoreForTests();
    const unknown = path.join(sessionsRoot(), 'unindexed-recovery-custody');
    await fs.mkdir(unknown, { recursive: true });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 32 * 24 * 60 * 60_000);
    try {
      await expect(pruneSessions(30)).rejects.toThrow('Session catalog custody incomplete');
      await expect(fs.stat(path.join(sessionsRoot(), old.id))).resolves.toBeTruthy();
      await expect(fs.stat(unknown)).resolves.toBeTruthy();
    } finally {
      await fs.rmdir(unknown);
      resetSessionStoreForTests();
    }
  });

  it('retention recovery safety protects malformed handoff ordering and prunes only independent history', async () => {
    const malformed = await createSession({ title: 'malformed handoff time' });
    const valid = await createSession({ title: 'last readable handoff' });
    const unrelated = await createSession({ title: 'safe expired history' });
    const malformedId = '2026-10-19-malformed';
    const validId = '2026-10-18-readable';
    for (const [session, id, createdAt] of [
      [malformed, malformedId, Date.now()] as const,
      [valid, validId, Date.now() - 10_000] as const
    ]) {
      await saveHandoff(handoff(session.id, id, createdAt));
      await appendEvent(session.id, {
        time: createdAt, source: 'app', kind: 'handoff', handoffId: id,
        chars: 23, reason: 'manual'
      });
    }
    await flushSessions();
    resetSessionStoreForTests();
    const corrupted = path.join(sessionsRoot(), malformed.id, 'handoffs', `${malformedId}.json`);
    const payload = JSON.parse(await fs.readFile(corrupted, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(corrupted, JSON.stringify({ ...payload, createdAt: 'unknown' }));
    const expired = Date.now() - 90 * 24 * 60 * 60_000;
    for (const id of [malformed.id, valid.id, unrelated.id]) {
      const location = path.join(sessionsRoot(), id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(location, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(location, JSON.stringify({ ...meta, updatedAt: expired }));
    }
    expect(await readHandoff(malformed.id, malformedId)).toBeNull();
    expect(await pruneSessions(30)).toBe(1);
    await expect(fs.stat(path.join(sessionsRoot(), malformed.id))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(sessionsRoot(), valid.id))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(sessionsRoot(), unrelated.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retention recovery safety retains cold unfinished turns and unprojected committed Resume custody', async () => {
    const running = await createSession({ title: 'interrupted native turn' });
    const committed = await createSession({ title: 'committed Resume before event projection' });
    const disposable = await createSession({ title: 'finished independent recording' });
    await appendEvent(running.id, { time: Date.now(), source: 'extension', kind: 'turn_start', turnId: 'native-unsettled' });
    await flushSessions();
    resetSessionStoreForTests();
    const expired = Date.now() - 90 * 24 * 60 * 60_000;
    for (const id of [running.id, committed.id, disposable.id]) {
      const location = path.join(sessionsRoot(), id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(location, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(location, JSON.stringify({ ...meta, updatedAt: expired,
        ...(id === committed.id ? { lastCommittedResumeHandoffId: '2026-10-19-claimed0', lastHandoffId: null } : {}) }));
    }
    expect(await pruneSessions(30)).toBe(1);
    await expect(fs.stat(path.join(sessionsRoot(), running.id))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(sessionsRoot(), committed.id))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(sessionsRoot(), disposable.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retention recovery safety protects a prepared handoff and a crash stage before WAL publication', async () => {
    const prepared = await createSession({ title: 'published before event' });
    const interrupted = await createSession({ title: 'unverified crash stage' });
    const unrelated = await createSession({ title: 'safe expired recording' });
    const handoffId = '2026-10-19-prepared';
    await saveHandoff(handoff(prepared.id, handoffId, Date.now()));
    const stage = path.join(sessionsRoot(), interrupted.id, 'handoffs', '.unverified-stage.tmp');
    await fs.mkdir(path.dirname(stage), { recursive: true });
    await fs.writeFile(stage, 'unverified original stage');
    await flushSessions();
    resetSessionStoreForTests();
    const expired = Date.now() - 90 * 24 * 60 * 60_000;
    for (const id of [prepared.id, interrupted.id, unrelated.id]) {
      const location = path.join(sessionsRoot(), id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(location, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(location, JSON.stringify({ ...meta, updatedAt: expired }));
    }
    expect(await pruneSessions(30)).toBe(1);
    await expect(fs.stat(path.join(sessionsRoot(), prepared.id))).resolves.toBeTruthy();
    await expect(fs.readFile(stage, 'utf8')).resolves.toBe('unverified original stage');
    await expect(fs.stat(path.join(sessionsRoot(), unrelated.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retention recovery safety does not retain a completed superseded handoff forever', async () => {
    const expired = await createSession({ title: 'completed old handoffs' });
    const current = await createSession({ title: 'newest accepted brief' });
    const at = Date.now();
    await saveHandoff(handoff(expired.id, '2026-01-01-historical', at - 20_000));
    await saveHandoff(handoff(expired.id, '2026-01-02-localend', at - 10_000));
    await appendEvent(expired.id, { time: at - 10_000, source: 'app', kind: 'handoff',
      handoffId: '2026-01-02-localend', chars: 23, reason: 'manual' });
    await saveHandoff(handoff(current.id, '2026-01-03-newest00', at + 10_000));
    await appendEvent(current.id, { time: at + 10_000, source: 'app', kind: 'handoff',
      handoffId: '2026-01-03-newest00', chars: 23, reason: 'manual' });
    await flushSessions();
    resetSessionStoreForTests();
    const age = Date.now() - 90 * 24 * 60 * 60_000;
    for (const id of [expired.id, current.id]) {
      const location = path.join(sessionsRoot(), id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(location, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(location, JSON.stringify({ ...meta, updatedAt: age }));
    }
    expect(await readHandoff(current.id, '2026-01-03-newest00')).not.toBeNull();
    expect((await latestHandoff())?.id).toBe('2026-01-03-newest00');
    expect(await pruneSessions(30)).toBeGreaterThanOrEqual(1);
    await expect(fs.stat(path.join(sessionsRoot(), expired.id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(sessionsRoot(), current.id))).resolves.toBeTruthy();
  });

  it('retention recovery safety keeps recording expiry disabled while honoring explicit Trash expiry', async () => {
    const kept = await createSession({ title: 'retention disabled' });
    const deleted = await createSession({ title: 'previous explicit deletion' });
    await deleteSession(deleted.id);
    const trash = path.join(sessionsRoot(), '.deleted-sessions', deleted.id);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    await fs.utimes(trash, old, old);
    expect(await pruneSessions(0)).toBe(0);
    await expect(fs.stat(path.join(sessionsRoot(), kept.id))).resolves.toBeTruthy();
    await expect(fs.stat(trash)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prunes an expired session beyond the old 5,000-folder maintenance prefix', async () => {
    const seed = await createSession({ title: 'retention catalog seed' });
    const seedFile = path.join(sessionsRoot(), seed.id, 'meta.json');
    const seedSummary = JSON.parse(await fs.readFile(seedFile, 'utf8'));
    expect(seedSummary).toMatchObject({ __historySeq: 0, __canonicalProjection: 1, __tokenEstimate: 1 });
    const statSpy = mockCatalogCheckpointStats('prune-', await fs.stat(seedFile));
    resetSessionStoreForTests();

    const names = Array.from({ length: 5001 }, (_, index) => `prune-${String(index).padStart(5, '0')}`);
    const targetId = names.at(-1)!;
    const recent = Date.now();
    const expired = recent - 90 * 24 * 3600_000;
    const rootPath = sessionsRoot();
    const realReaddir = fs.readdir.bind(fs);
    const realReadFile = fs.readFile.bind(fs);
    const realRm = fs.rm.bind(fs);
    const removed: string[] = [];

    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
      (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        const location = String(target);
        if (location === rootPath) return names;
        if (path.basename(location) === 'messages' && path.basename(path.dirname(location)).startsWith('prune-')) return [];
        return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
      }) as typeof fs.readdir
    );
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(
      (async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        const file = String(target);
        const id = path.basename(path.dirname(file));
        if (id.startsWith('prune-') && file.endsWith('meta.json')) {
          return JSON.stringify({
            ...seedSummary,
            id,
            title: id,
            updatedAt: id === targetId ? expired : recent,
            endedAt: recent,
            conversationId: null,
            chatIds: [],
            lastHandoffId: null,
            lastHandoffAt: null,
            __historySeq: 0
          });
        }
        if (id.startsWith('prune-') && file.endsWith('messages.json')) return '{}';
        return (realReadFile as (...callArgs: unknown[]) => ReturnType<typeof fs.readFile>)(target, ...args);
      }) as typeof fs.readFile
    );
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(
      (async (target: Parameters<typeof fs.rm>[0], ...args: unknown[]) => {
        const id = path.basename(String(target));
        if (id.startsWith('prune-')) {
          removed.push(id);
          return;
        }
        return (realRm as (...callArgs: unknown[]) => ReturnType<typeof fs.rm>)(target, ...args);
      }) as typeof fs.rm
    );

    try {
      expect(await pruneSessions(30)).toBe(1);
      expect(removed).toEqual([targetId]);
      expect(new Set(readSpy.mock.calls.filter(([file]) => String(file).endsWith('meta.json') &&
        path.basename(path.dirname(String(file))).startsWith('prune-'))
        .map(([file]) => path.basename(path.dirname(String(file))))).size).toBe(5001);
    } finally {
      rmSpy.mockRestore();
      statSpy.mockRestore();
      readSpy.mockRestore();
      readdirSpy.mockRestore();
      resetSessionStoreForTests();
      await deleteSession(seed.id);
    }
  // Keep all 5,001 catalog entries and the exact final-row pruning assertion.
  }, 90_000);

  it('splits a long brief on blank lines and keeps every character', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => `SECTION ${i}\n${'detail '.repeat(20)}`);
    const text = blocks.join('\n\n');
    const parts = chunkText(text, 500);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(500);
    expect(parts.join('\n\n')).toBe(text);
  });

  it('splits a single oversized block rather than returning it whole', () => {
    const parts = chunkText('x'.repeat(2500), 1000);
    expect(parts).toHaveLength(3);
    expect(parts.join('')).toHaveLength(2500);
  });

  it('returns one part when the brief already fits', () => {
    expect(chunkText('short brief', 1000)).toEqual(['short brief']);
  });

  it('asks for user-authoritative handoffs up to the documented 30k-token ceiling', () => {
    const prompt = nativeHandoffPrompt();
    expect(prompt).toContain(HANDOFF_BRIEF_RULES);
    expect(prompt).toMatch(/user's messages as the highest-authority source/i);
    expect(prompt).toMatch(/10,000[–-]30,000 tokens/i);
    expect(prompt).toMatch(/~6,000-token brief is normally too short/i);
    expect(prompt).toMatch(/Never exceed 30,000 tokens/i);
    expect(prompt).toMatch(/lossless operational compression/i);
    expect(prompt).toMatch(/failure.*root cause.*change.*verification/i);
    expect(prompt).toMatch(/PLANNED \/ DECIDED/i);
    expect(prompt).toMatch(/FAILED \/ UNRESOLVED/i);
    expect(prompt).toMatch(/VERIFICATION/i);
    expect(prompt).toMatch(/completed and verified/i);
  });

  it('honors the tool-detail setting in the handoff brief without claiming to erase seen history', () => {
    expect(nativeHandoffPrompt('token', false)).toContain('omit raw tool-call arguments and result bodies');
    expect(nativeHandoffPrompt('token', false)).toContain('not the history you already saw');
    expect(nativeHandoffPrompt('token', true)).not.toContain('omit raw tool-call arguments');
    expect(nativeHandoffPrompt('token', false)).toContain('interim updates');
  });
});

// ---------------------------------------------------------------- recorder

describe('canonical recorder 1.8', () => {
  it('keeps the committed tool result and bounded first cause when its attribution observer throws', async () => {
    const logger = await import('../src/main/logger.js');
    logger.initLogFile(path.join(dir, 'attribution-observer', 'app.log'));
    const conversationId = '33b2f447-03ca-4dbc-8d21-fde55a6c40a2', requestId = 'wfr_attribution_observer';
    try {
      await enableRecording();
      const opened = await recordChatObservations(conversationId, [{
        kind: 'tool_evidence', time: Date.now(), fiberConversationId: conversationId,
        calls: [{ messageId: 'original-attribution-call', requestId, tool: 'read', order: 0, answered: false }]
      }]);
      setCallAttributionListener(() => {
        throw Object.assign(new Error('PRIVATE credential=secret C:\\private\\result.txt'), { code: 'EIO' });
      });
      const call = await recordToolCall({ tool: 'read', args: { paths: ['/project/original.txt'] },
        content: [{ type: 'text', text: 'Original durable result.' }], outcome: 'ok', durationMs: 1,
        startedAt: Date.now(), requestId });
      expect(call).toMatchObject({ requestId, attributionMethod: 'request_id' });
      expect((await readEvents(opened.sessionId!, { kinds: ['tool_call'] }))[0])
        .toMatchObject({ kind: 'tool_call', call: { callId: call!.callId } });
      await logger.flushLocalIncidents();
      const incidents = (await logger.listLocalIncidents()).incidents
        .filter(row => row.reason === 'mcp_post_append_observation_failed');
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({ source: 'app', status: 'unresolved',
        sessionId: opened.sessionId, conversationId, sendEvidence: 'not_observed' });
      const warnings = getLog().filter(row => /attribution listener failed|session recorder post-append failed/.test(row.message));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toBe('session recorder post-append failed (EIO)');
      expect(JSON.stringify({ incidents, warnings })).not.toMatch(/PRIVATE|credential|secret|result\.txt|wfr_attribution_observer/);
    } finally {
      setCallAttributionListener(null);
      await logger.flushLocalIncidents();
      await logger.flushLogFile();
      logger.resetLoggerForTests();
    }
  });

  it('isolates deferred session observer failures without losing durable tool results or healthy notifications', async () => {
    const logger = await import('../src/main/logger.js');
    logger.initLogFile(path.join(dir, 'deferred-session-observer', 'app.log'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const broken = vi.fn(() => { throw new Error('PRIVATE observer path C:\\private\\result.txt'); });
    const healthy = vi.fn();
    const removeBroken = onSessionChange(broken), removeHealthy = onSessionChange(healthy);
    const conversationId = 'conv-deferred-observer', requestId = 'wfr_deferred_observer';
    try {
      await enableRecording();
      const opened = await recordChatObservations(conversationId, [{
        kind: 'tool_evidence', time: Date.now(), fiberConversationId: conversationId,
        calls: [{ messageId: 'original-observer-call', requestId, tool: 'read', order: 0, answered: false }]
      }]);
      const record = () => recordToolCall({ tool: 'read', args: { paths: ['/project/original.txt'] },
        content: [{ type: 'text', text: 'Original durable result.' }], outcome: 'ok', durationMs: 1,
        startedAt: Date.now(), requestId });
      const first = await record();
      expect(first).toMatchObject({ requestId, attributionMethod: 'request_id' });
      expect((await readEvents(opened.sessionId!, { kinds: ['tool_call'] }))[0])
        .toMatchObject({ kind: 'tool_call', call: { callId: first!.callId } });
      await vi.advanceTimersByTimeAsync(400);
      expect(broken).toHaveBeenCalledTimes(1);
      expect(healthy).toHaveBeenCalledTimes(1);
      const second = await record();
      await vi.advanceTimersByTimeAsync(400);
      expect(broken).toHaveBeenCalledTimes(2);
      expect(healthy).toHaveBeenCalledTimes(2);
      expect((await readEvents(opened.sessionId!, { kinds: ['tool_call'] }))
        .map(event => event.kind === 'tool_call' ? event.call.callId : null)).toEqual([first!.callId, second!.callId]);
      await logger.flushLocalIncidents();
      const incidents = (await logger.listLocalIncidents()).incidents
        .filter(row => row.reason === 'session_change_observer_failed');
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({ source: 'app', status: 'unresolved', sessionId: null,
        conversationId: null, requestId: null, sendEvidence: 'not_observed', capture: 'not_requested' });
      const warnings = getLog().filter(row => row.message === 'session change observer failed (callback_failure)');
      expect(warnings).toHaveLength(2);
      expect(JSON.stringify({ incidents, warnings })).not.toMatch(/PRIVATE|result\.txt|wfr_deferred_observer/);
    } finally {
      removeBroken(); removeHealthy();
      resetRecorderForTests();
      vi.useRealTimers();
      await logger.flushLocalIncidents();
      await logger.flushLogFile();
      logger.resetLoggerForTests();
    }
  });

  it('caps the estimated tool return after rebind while retaining its full recorded result', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 10000 } });
    try {
      const source = 'conv-fulltext-source';
      const destination = 'conv-fulltext-destination';
      const opened = await recordChatObservations(source, [{ kind: 'user_message', time: Date.now(),
        messageId: 'old-large-context', text: 'x'.repeat(50000) }]);
      const sessionId = opened.sessionId!;
      expect(await rebindSession(sessionId, source, destination)).toBe(true);
      rebindConversation(sessionId, source, destination);
      const requestId = 'wfr-fulltext-result';
      await recordChatObservations(destination, [
        { kind: 'user_message', time: Date.now(), messageId: 'new-handoff', text: 'h'.repeat(13237) },
        { kind: 'tool_evidence', time: Date.now(), calls: [{ messageId: 'fulltext-call', requestId,
          tool: 'read', order: 0, answered: false }] }
      ]);
      const before = (await getSession(sessionId))!;
      const args = { paths: ['a.ts', 'b.ts', 'c.ts'] };
      const result = 'r'.repeat(60306);
      const call = await recordToolCall({ tool: 'read', args, content: [{ type: 'text', text: result }],
        outcome: 'ok', durationMs: 1, startedAt: Date.now(), requestId });
      expect(call?.result).toMatchObject({ truncated: true, chars: result.length });
      expect(call!.result.text.length).toBeLessThan(8200);
      expect((await readAsset(sessionId, call!.result.assetId!))?.toString('utf8')).toBe(result);
      const expected = estimateTokens(JSON.stringify(args)) + 10000 + estimateTokens(call!.summary.title);
      const after = (await getSession(sessionId))!;
      expect(after.estimatedTokens - before.estimatedTokens).toBe(expected);
      expect(after.contextTokens).toBe(estimateTokens('h'.repeat(13237)) + expected);
      expect(autoCompactionReady(after)).toBe(true);
    } finally { await enableRecording(); }
  });

  it('replaces a canonical truncated message contribution with its new full length once', async () => {
    const opened = await createSession({ title: 'full message revisions' });
    const revision = (chars: number) => ({ time: Date.now(), source: 'extension' as const, kind: 'assistant_message' as const,
      messageId: 'full-answer', state: 'streaming' as const, final: false,
      message: { text: 'same bounded head', truncated: true, chars, digest: String(chars) } });
    await upsertMessageEvent(opened.id, revision(20000));
    await upsertMessageEvent(opened.id, revision(60000));
    await upsertMessageEvent(opened.id, revision(60000));
    expect(await getSession(opened.id)).toMatchObject({ estimatedTokens: 15000, contextTokens: 15000 });
  });

  it('lets the store deduplicate repeated recorder assets instead of shadow-counting the same bytes toward quota', async () => {
    const conversationId = `conv-dedup-shot-${Date.now()}`;
    const sessionId = await sessionForConversation(conversationId);
    const requestIds = Array.from({ length: 25 }, (_, index) => `wfr_dedup_asset_${index}`);
    const now = Date.now();
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: now, turnId: 'dedup-asset-turn' },
      {
        kind: 'tool_evidence',
        time: now + 1,
        turnId: 'dedup-asset-turn',
        calls: requestIds.map((requestId, index) => ({
          messageId: `dedup-asset-${index}`,
          tool: 'screenshot',
          order: index,
          answered: false,
          requestId
        }))
      }
    ]);

    // Exactly one maximum-sized file exists on disk. Twenty-five references total 200 MiB
    // logically, which used to trip recorder.ts's separate 192 MiB shadow counter even though
    // the authoritative content-addressed store correctly charged only the first 8 MiB.
    const imageBase64 = Buffer.alloc(MAX_ASSET_BYTES, 0x5a).toString('base64');
    const assetIds: Array<string | undefined> = [];
    for (const [index, requestId] of requestIds.entries()) {
      const call = await recordToolCall({
        tool: 'screenshot',
        args: { index },
        content: [{ type: 'image', data: imageBase64, mimeType: 'image/png' }],
        outcome: 'ok',
        durationMs: 1,
        startedAt: now + 2 + index,
        requestId
      });
      assetIds.push(call?.assets?.[0]?.id);
    }

    expect(assetIds.every(Boolean)).toBe(true);
    expect(new Set(assetIds).size).toBe(1);
    expect((await readEvents(sessionId!, { kinds: ['tool_call'] }))).toHaveLength(25);
  });

  it('records one provider-limit notice for concurrent tab reports and journal replay after restart', async () => {
    const conversationId = 'conv-error-burst';
    const error = { kind: 'chat_error' as const, time: 100_000,
      text: 'Too many requests. Please wait a few minutes.', blocking: true, recoverable: false };
    const reports = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      recordChatObservations(conversationId, [{ ...error, time: error.time + index * 50, turnId: `tab-${index}` }])));
    expect(reports.reduce((count, report) => count + report.stored, 0)).toBe(1);
    expect(reports.slice(1).every(report => !report.activity.meaningful)).toBe(true);
    const sessionId = reports[0]!.sessionId!;
    await flushSessions();
    resetRecorderForTests();
    resetSessionStoreForTests();
    await recordChatObservations(conversationId, [{ ...error, time: error.time + 1_000 }]);
    expect(await readEvents(sessionId, { kinds: ['chat_error'] })).toEqual([
      expect.objectContaining({ blocking: true, recoverable: false })
    ]);

    const stillSameEpisode = await recordChatObservations(conversationId, [{ ...error, time: error.time + 30_001 }]);
    expect(stillSameEpisode.activity.meaningful).toBe(false);
    expect(await readEvents(sessionId, { kinds: ['chat_error'] })).toHaveLength(1);
    await recordChatObservations(conversationId, [{ ...error, time: error.time + 10 * 60_000 + 1 }]);
    expect(await readEvents(sessionId, { kinds: ['chat_error'] })).toHaveLength(2);
    const other = await recordChatObservations('conv-error-burst-other', [error]);
    expect(other.stored).toBe(1);
  });

  it('coalesces same-turn error bursts but preserves different errors and genuine turn failures', async () => {
    const error = { kind: 'chat_error' as const, time: 100_000, text: 'Message delivery timed out.', turnId: 'first' };
    const first = await recordChatObservations('conv-error-turns', [error,
      { ...error, time: 100_100, text: 'Message  delivery\n timed out.' },
      { ...error, time: 100_200, text: 'Something went wrong.' },
      { ...error, time: 100_300, turnId: 'second' }]);
    const errors = await readEvents(first.sessionId!, { kinds: ['chat_error'] });
    expect(errors).toHaveLength(3);
    expect(errors.map(event => event.turnId)).toEqual(['first', 'first', 'second']);
  });

  it('owns reload errors by the canonical question across missing and reminted document turns', async () => {
    const conversationId = 'conv-reload-error-owner';
    const error = { kind: 'chat_error' as const, time: 100_000, text: 'Connection interrupted', recoverable: true, turnId: 'original' };
    const first = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: 90_000, messageId: 'question-one', text: 'Build it', authoredNow: true }, error]);
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    for (const [turnId, time] of [[undefined, 110_000], ['replacement', 121_000], ['replacement-again', 200_000]] as const) {
      const replay = await recordChatObservations(conversationId, [{ ...error, turnId, time }]);
      expect(replay.activity.meaningful).not.toBe(true);
    }
    expect(await readEvents(first.sessionId!, { kinds: ['chat_error'] })).toHaveLength(1);
    await recordChatObservations(conversationId, [
      { kind: 'user_message', time: 210_000, messageId: 'question-two', text: 'Build it', authoredNow: true },
      { kind: 'user_message', time: 90_000, messageId: 'question-one', text: 'Build it with corrected rendering' },
      { ...error, time: 211_000 }]);
    expect((await readLatestUserMessage(first.sessionId!))?.messageId).toBe('question-two');
    expect(await readEvents(first.sessionId!, { kinds: ['chat_error'] })).toHaveLength(2);
  });

  it('keeps a failed error append eligible for retry', async () => {
    const conversationId = 'conv-error-append-retry';
    await sessionForConversation(conversationId);
    const error = { kind: 'chat_error' as const, time: 100, text: 'Something went wrong.' };
    const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(recordChatObservations(conversationId, [error])).rejects.toThrow('disk full');
    } finally {
      append.mockRestore();
    }
    const retry = await recordChatObservations(conversationId, [error]);
    expect(retry.stored).toBe(1);
    expect(await readEvents(retry.sessionId!, { kinds: ['chat_error'] })).toHaveLength(1);
  });

  it('keeps one exact Thinking failed notice across reload/restart beyond the burst window', async () => {
    const conversationId = 'conv-failed-header-reload';
    const error = { kind: 'chat_error' as const, time: 100_000, text: 'Thinking failed',
      reason: 'thinking_failed' as const, turnId: 'failed-turn', recoverable: false };
    const first = await recordChatObservations(conversationId, [error]);
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    await recordChatObservations(conversationId, [{ ...error, time: 500_000 }]);
    await recordChatObservations(conversationId, [{ ...error, time: 600_000, turnId: undefined }]);
    expect(await readEvents(first.sessionId!, { kinds: ['chat_error'] })).toEqual([
      expect.objectContaining({ reason: 'thinking_failed', turnId: 'failed-turn' })
    ]);
    await recordChatObservations(conversationId, [{ ...error, time: 700_000, turnId: 'another-turn' }]);
    expect(await readEvents(first.sessionId!, { kinds: ['chat_error'] })).toHaveLength(2);
  });

  it('deduplicates replayed turn lifecycle boundaries from the at-least-once browser journal', async () => {
    const conversationId = 'conv-lifecycle-replay';
    const batch = [
      { kind: 'turn_start' as const, time: 100, turnId: 'g-replayed-lifecycle' },
      { kind: 'turn_end' as const, time: 200, turnId: 'g-replayed-lifecycle', outcome: 'completed' as const }
    ];
    const first = await recordChatObservations(conversationId, batch);
    await recordChatObservations(conversationId, batch);

    const lifecycle = await readEvents(first.sessionId!, { kinds: ['turn_start', 'turn_end'] });
    expect(lifecycle.map((event) => event.kind)).toEqual(['turn_start', 'turn_end']);
    expect(lifecycle.map((event) => event.turnId)).toEqual(['g-replayed-lifecycle', 'g-replayed-lifecycle']);
  });

  it('serializes concurrent replays before lifecycle dedupe is decided', async () => {
    const conversationId = 'conv-lifecycle-concurrent-replay';
    const batch = [
      { kind: 'turn_start' as const, time: 100, turnId: 'g-concurrent-lifecycle' },
      { kind: 'turn_end' as const, time: 200, turnId: 'g-concurrent-lifecycle', outcome: 'completed' as const }
    ];
    const [first] = await Promise.all([
      recordChatObservations(conversationId, batch),
      recordChatObservations(conversationId, batch)
    ]);

    const lifecycle = await readEvents(first.sessionId!, { kinds: ['turn_start', 'turn_end'] });
    expect(lifecycle.map((event) => event.kind)).toEqual(['turn_start', 'turn_end']);
  });

  it('does not mark a lifecycle retry duplicate before its durable append commits', async () => {
    const conversationId = 'conv-lifecycle-commit-failure';
    const sessionId = await sessionForConversation(conversationId);
    const start = { kind: 'turn_start' as const, time: 100, turnId: 'g-retry-after-disk-failure' };
    const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(recordChatObservations(conversationId, [start])).rejects.toThrow('disk full');
    } finally {
      append.mockRestore();
    }

    await recordChatObservations(conversationId, [start]);
    const lifecycle = await readEvents(sessionId!, { kinds: ['turn_start'] });
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]?.turnId).toBe(start.turnId);
  }, 60_000);

  const tool = (requestId: string, startedAt = Date.now()) =>
    recordToolCall({
      tool: 'read',
      args: { paths: ['/project/a.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok' as const,
      durationMs: 1,
      startedAt,
      requestId
    });

  it('creates exactly one session when the same conversation is first observed concurrently', async () => {
    const conversationId = 'conv-concurrent-first-sight';
    const [first, second] = await Promise.all([
      sessionForConversation(conversationId),
      sessionForConversation(conversationId)
    ]);
    expect(second).toBe(first);
    expect((await listSessions()).filter((entry) => entry.conversationId === conversationId)).toHaveLength(1);
    expect(await readEvents(first!, { kinds: ['session_start'] })).toHaveLength(1);
  }, 60_000);

  it('many streaming updates become exactly one final canonical message', async () => {
    const conversationId = 'conv-canonical-stream';
    const messageId = 'msg-stream-123';
    const result = await recordChatObservations(conversationId, [
      { kind: 'assistant_message', time: 100, messageId, text: 'I inspected', renderedHtml: '<p>I inspected</p>', state: 'streaming' },
      { kind: 'assistant_message', time: 110, messageId, text: 'I inspected the current tree', renderedHtml: '<p>I inspected the current tree</p>', state: 'streaming' },
      { kind: 'assistant_message', time: 120, messageId, text: 'I inspected the current tree.', renderedHtml: '<p><strong>I inspected</strong> the current tree.</p>', state: 'final', final: true }
    ]);

    const messages = await readEvents(result.sessionId!, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.kind).toBe('assistant_message');
    if (message.kind !== 'assistant_message') throw new Error('wrong event');
    expect(message.messageId).toBe(messageId);
    expect(message.state).toBe('final');
    expect(message.final).toBe(true);
    expect(message.message.text).toBe('I inspected the current tree.');
    expect(message.renderedHtml?.text).toBe('<p><strong>I inspected</strong> the current tree.</p>');
  });

  it('repeating the same final snapshot never creates another logical message', async () => {
    const conversationId = 'conv-repeat-final';
    const snapshot = {
      kind: 'assistant_message' as const,
      time: 200,
      messageId: 'msg-repeat-final',
      text: 'Done.',
      renderedHtml: '<p>Done.</p>',
      state: 'final' as const,
      final: true
    };
    const first = await recordChatObservations(conversationId, [snapshot]);
    await recordChatObservations(conversationId, [{ ...snapshot, time: 210 }, { ...snapshot, time: 220 }]);
    const messages = await readEvents(first.sessionId!, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(1);
  });

  it('correlates every hidden or rowless MCP request independently by request id', async () => {
    const conversationId = 'conv-rowless-modern';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();
    await recordChatObservations(conversationId, [
      {
        kind: 'tool_evidence',
        time: now,
        fiberConversationId: conversationId,
        calls: Array.from({ length: 5 }, (_unused, index) => ({
          messageId: `hidden-${index}`,
          tool: 'read',
          order: index,
          answered: false,
          requestId: `wfr_hidden_${index}`
        }))
      }
    ]);
    for (let index = 0; index < 5; index++) await tool(`wfr_hidden_${index}`, now + index);
    const calls = await readEvents(sessionId!, { kinds: ['tool_call'] });
    expect(calls).toHaveLength(5);
    for (const event of calls) {
      if (event.kind !== 'tool_call') throw new Error('wrong event');
      expect(event.call.attributionMethod).toBe('request_id');
      expect(event.call.conversationId).toBe(conversationId);
      expect(event.call.requestId).toMatch(/^wfr_hidden_/);
    }
  });

  /**
   * Live 2026-09-02: the page reloaded mid-turn, adopted the open turn and reported it
   * completed four seconds later; the same ChatGPT request id then called tools for another
   * twenty-four minutes. The request id is per server turn, so a call under the ended turn's
   * request id that starts after the reported end is proof the end was the page's, not
   * ChatGPT's. The recorder reopens the turn durably and lets the real end close it later.
   */
  it('reopens a turn the page ended while its server turn kept calling tools', async () => {
    const conversationId = 'conv-false-turn-end';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();
    const active = () => liveConversations().find((entry) => entry.conversationId === conversationId)?.activeTurnId ?? null;
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: now, turnId: 'g-false-end' },
      {
        kind: 'tool_evidence', time: now, fiberConversationId: conversationId,
        calls: [
          { messageId: 'same-0', tool: 'read', order: 0, answered: false, requestId: 'wfr_same_turn' },
          { messageId: 'next-0', tool: 'read', order: 1, answered: false, requestId: 'wfr_next_turn' }
        ]
      }
    ]);
    await tool('wfr_same_turn', now + 10);
    expect(active()).toBe('g-false-end');

    await recordChatObservations(conversationId, [
      { kind: 'turn_end', time: now + 20, turnId: 'g-false-end', outcome: 'completed' }
    ]);
    expect(active()).toBeNull();

    // An in-flight call that merely finished late proves nothing about the end.
    await tool('wfr_same_turn', now + 15);
    expect(active()).toBeNull();
    // Nor does a different server turn: that is a different turn.
    await tool('wfr_next_turn', now + 30);
    expect(active()).toBeNull();

    // The same server turn calling on after the end is the turn not having ended.
    await tool('wfr_same_turn', now + 40);
    expect(active()).toBe('g-false-end');
    const starts = await readEvents(sessionId!, { kinds: ['turn_start'] });
    expect(starts.map((event) => [event.turnId, event.source])).toEqual([
      ['g-false-end', 'extension'],
      ['g-false-end', 'app']
    ]);
    expect(starts[1]?.kind === 'turn_start' && starts[1].detail).toMatch(/kept calling tools/);

    // Reopened once; the same turn going on is not news, and the real end is accepted.
    await tool('wfr_same_turn', now + 50);
    expect(await readEvents(sessionId!, { kinds: ['turn_start'] })).toHaveLength(2);
    await recordChatObservations(conversationId, [
      { kind: 'turn_end', time: now + 60, turnId: 'g-false-end', outcome: 'completed' }
    ]);
    expect(active()).toBeNull();
    const ends = await readEvents(sessionId!, { kinds: ['turn_end'] });
    expect(ends.map((event) => event.time)).toEqual([now + 20, now + 60]);
  });

  it('never cross-attributes concurrent same-tool calls from two chats', async () => {
    const now = Date.now();
    const firstId = 'conv-concurrent-a';
    const secondId = 'conv-concurrent-b';
    const first = await sessionForConversation(firstId);
    const second = await sessionForConversation(secondId);
    await recordChatObservations(firstId, [{
      kind: 'tool_evidence', time: now, fiberConversationId: firstId,
      calls: [{ messageId: 'call-a', tool: 'read', order: 0, answered: false, requestId: 'wfr_concurrent_a' }]
    }]);
    await recordChatObservations(secondId, [{
      kind: 'tool_evidence', time: now, fiberConversationId: secondId,
      calls: [{ messageId: 'call-b', tool: 'read', order: 0, answered: false, requestId: 'wfr_concurrent_b' }]
    }]);

    await Promise.all([tool('wfr_concurrent_b', now), tool('wfr_concurrent_a', now)]);
    const firstCalls = await readEvents(first!, { kinds: ['tool_call'] });
    const secondCalls = await readEvents(second!, { kinds: ['tool_call'] });
    expect(firstCalls).toHaveLength(1);
    expect(secondCalls).toHaveLength(1);
    expect(firstCalls[0]!.kind === 'tool_call' && firstCalls[0]!.call.requestId).toBe('wfr_concurrent_a');
    expect(secondCalls[0]!.kind === 'tool_call' && secondCalls[0]!.call.requestId).toBe('wfr_concurrent_b');
  });

  it('keeps an unmatched modern request unattributed and never borrows another chat', async () => {
    vi.useFakeTimers();
    try {
      const other = await sessionForConversation('conv-other-evidence');
      await recordChatObservations('conv-other-evidence', [{
        kind: 'tool_evidence', time: Date.now(), fiberConversationId: 'conv-other-evidence',
        calls: [{ messageId: 'other-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_other' }]
      }]);
      const pending = tool('wfr_missing', Date.now());
      await vi.advanceTimersByTimeAsync(15_100);
      const call = await pending;
      expect(call?.attributionMethod).toBe('unattributed');
      expect(call?.conversationId).toBeNull();
      expect(await readEvents(other!, { kinds: ['tool_call'] })).toHaveLength(0);
      const unattributed = (await listSessions()).find((entry) => entry.title === 'Unattributed activity');
      expect(unattributed?.toolCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects URL/Fiber conversation conflicts instead of choosing either identity', async () => {
    const now = Date.now();
    await sessionForConversation('conv-url-identity');
    await sessionForConversation('conv-fiber-identity');
    await recordChatObservations('conv-url-identity', [{
      kind: 'tool_evidence',
      time: now,
      fiberConversationId: 'conv-fiber-identity',
      calls: [{ messageId: 'conflict-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_identity_conflict' }]
    }]);
    const call = await tool('wfr_identity_conflict', now);
    expect(call?.attributionMethod).toBe('unattributed');
    expect(call?.conversationId).toBeNull();
  });

  /**
   * One line, and not a problem line.
   *
   * A refused claim means the registry did its job: the id keeps the chat that proved it and
   * every call under it keeps arriving there. Reporting that as a fault put a run that was
   * working perfectly into the problem count, and reporting it once per call put it there
   * thirty-five times over.
   */
  it('reports a refused claim once per batch, and as a note rather than a problem', async () => {
    const firstConversation = 'conv-conflict-log-first';
    const secondConversation = 'conv-conflict-log-second';
    const requestId = `wfr_conflict_log_${Date.now()}`;
    const now = Date.now();
    await sessionForConversation(firstConversation);
    await sessionForConversation(secondConversation);
    await recordChatObservations(firstConversation, [{
      kind: 'tool_evidence',
      time: now,
      fiberConversationId: firstConversation,
      calls: [{ messageId: 'first-proof', tool: 'read', order: 0, answered: true, requestId }]
    }]);

    const lines = (level: 'warn' | 'info'): number => getLog().filter(
      (entry) => entry.level === level && entry.message.includes(`${requestId} stays with conversation`)
    ).length;
    const conflictingCalls = Array.from({ length: 35 }, (_, index) => ({
      messageId: `conflicting-call-${index}`,
      tool: index % 2 === 0 ? 'read' : 'exec_command',
      order: index,
      answered: true,
      requestId
    }));
    await recordChatObservations(secondConversation, [{
      kind: 'tool_evidence',
      time: now + 1,
      fiberConversationId: secondConversation,
      calls: conflictingCalls
    }]);
    expect(lines('info')).toBe(1);
    expect(lines('warn')).toBe(0);

    // And the id still belongs to the chat that proved it, which is the whole point of having
    // refused: a call arriving under it now is filed there, not left unattributed.
    const call = await tool(requestId, now + 2);
    expect(call?.attributionMethod).toBe('request_id');
    expect(call?.conversationId).toBe(firstConversation);
  });

  /**
   * A disagreement is a bad moment, not a bad request id.
   *
   * The page can be mid-navigation, still holding the previous chat's model, or showing a
   * conversation whose client-side thread id is not yet the server's. All of those make the
   * URL and the React tree disagree for a tick. Marking the request ids in that batch
   * contradictory — which is what this used to do — is permanent: nothing republishes a
   * conflicted id, and the deterministic repair pass skips it. Whole turns of provable tool
   * calls stayed in Unattributed activity for good because of one transient tick.
   */
  it('lets agreeing evidence prove a call whose first sighting disagreed with the URL', async () => {
    const conversationId = 'conv-late-agreement';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();

    await recordChatObservations(conversationId, [{
      kind: 'tool_evidence',
      time: now,
      fiberConversationId: 'conv-still-the-old-one',
      calls: [{ messageId: 'late-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_late_agreement' }]
    }]);

    // The same sighting a tick later, from a page that now agrees with its own URL.
    await recordChatObservations(conversationId, [{
      kind: 'tool_evidence',
      time: now + 5,
      fiberConversationId: conversationId,
      calls: [{ messageId: 'late-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_late_agreement' }]
    }]);

    const call = await tool('wfr_late_agreement', now + 10);
    expect(call?.attributionMethod).toBe('request_id');
    expect(call?.conversationId).toBe(conversationId);
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(1);
  });

  it('preserves captured rendered Markdown HTML on the canonical transcript message', async () => {
    const html = '<h2>Heading</h2><p><strong>bold</strong> and <em>italic</em></p><pre><code>const x = 1;</code></pre><table><tbody><tr><td>A</td></tr></tbody></table>';
    const result = await recordChatObservations('conv-rendered', [{
      kind: 'assistant_message', time: 300, messageId: 'msg-rendered', text: 'Heading\nbold and italic\nconst x = 1;\nA', renderedHtml: html, state: 'final', final: true
    }]);
    const [message] = await readEvents(result.sessionId!, { kinds: ['assistant_message'] });
    expect(message?.kind === 'assistant_message' && message.renderedHtml?.text).toBe(html);
  });

  it('keeps one message anchored before tool calls while streaming revisions update it', async () => {
    const conversationId = 'conv-interleaved';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();
    await recordChatObservations(conversationId, [{
      kind: 'assistant_message', time: now, messageId: 'msg-interleaved', text: 'Working', renderedHtml: '<p>Working</p>', state: 'streaming'
    }]);
    await recordChatObservations(conversationId, [{
      kind: 'tool_evidence', time: now + 10, fiberConversationId: conversationId,
      calls: [{ messageId: 'tool-interleaved', tool: 'read', order: 0, answered: false, requestId: 'wfr_interleaved' }]
    }]);
    await tool('wfr_interleaved', now + 20);
    await recordChatObservations(conversationId, [{
      kind: 'assistant_message', time: now + 30, messageId: 'msg-interleaved', text: 'Working — done', renderedHtml: '<p>Working — <strong>done</strong></p>', state: 'final', final: true
    }]);
    const timeline = (await readEvents(sessionId!)).filter((event) => event.kind === 'assistant_message' || event.kind === 'tool_call');
    expect(timeline.map((event) => event.kind)).toEqual(['assistant_message', 'tool_call']);
    expect(timeline.filter((event) => event.kind === 'assistant_message')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ naming

/**
 * What a chat this app opened is called.
 *
 * A session is normally named after the first thing said in it, which for a resumed or
 * worker chat is the bootstrap prompt this app typed itself. The installed build's
 * session list was consequently a column of near-identical rows reading
 * `Continue the previous ChatGPT ...` and `You are worker agent "worker-1" in a ...`,
 * with nothing to say which run any of them belonged to.
 */
describe('naming the chats this app opened', () => {
  const worker: SessionOrigin = {
    kind: 'worker',
    fromSessionId: null,
    agentId: 'worker-1',
    task: 'Port the recorder tests to the new fixture'
  };

  it('names a worker chat for its agent and task when its parent is unavailable', () => {
    expect(originTitle(worker, null)).toBe('worker-1 · Port the recorder tests to the new fixture');
  });

  it('prefixes a worker with the parent workstream so reused worker roles stay distinguishable', () => {
    expect(originTitle(worker, 'CoS Loop Repair')).toBe(
      'CoS Loop Repair · worker-1 · Port the recorder tests to the new fixture'
    );
  });

  it('attaches late worker parent provenance without overwriting a user-edited worker name', async () => {
    const parent = await createSession({ title: 'CoS Loop Repair', conversationId: 'manual-worker-parent' });
    const child = await createSession({ title: 'ChatGPT session', conversationId: 'manual-worker-child' });
    await renameSession(child.id, 'My worker label');
    await noteChatOrigin('manual-worker-child', { ...worker, fromSessionId: parent.id });
    expect(await getSession(child.id)).toMatchObject({
      title: 'My worker label',
      titleSource: 'manual',
      origin: { kind: 'worker', agentId: 'worker-1', fromSessionId: parent.id }
    });
  });

  it('names a resumed chat after the session it continues', () => {
    expect(originTitle({ kind: 'resume', fromSessionId: 's1', agentId: null, task: '' }, 'Fix the bridge')).toBe(
      'Fix the bridge'
    );
  });

  // A resumed chat is itself resumable, and a long session is resumed repeatedly. Transport
  // must never change the name the user recognizes.
  it('keeps the exact task name when a resumed chat is resumed again', () => {
    expect(
      originTitle({ kind: 'resume', fromSessionId: 's1', agentId: null, task: '' }, 'Fix the bridge')
    ).toBe('Fix the bridge');
  });

  it('shortens a task that would otherwise fill the row', () => {
    const long = { ...worker, task: 'x'.repeat(200) };
    expect(originTitle(long, null).length).toBeLessThan(80);
    expect(originTitle(long, null).endsWith('…')).toBe(true);
  });

  it('still names a resume whose source session has been deleted', () => {
    expect(originTitle({ kind: 'resume', fromSessionId: null, agentId: null, task: '' }, null)).toBe(
      'Continued task'
    );
  });

  it('derives a concise durable nickname from continuation boilerplate', async () => {
    const conversationId = 'auto-nickname-workstream';
    const opened = await recordChatObservations(conversationId, [{
      kind: 'user_message', time: Date.now(), messageId: 'nickname-opening',
      text: 'Continue the same LIVE creative collaboration / release-readiness workstream from the sealed runtime checkpoint.'
    }]);
    expect((await getSession(opened.sessionId!))?.title).toBe('LIVE creative collaboration / release-readiness');
    expect(await rebindSession(opened.sessionId!, conversationId, 'auto-nickname-workstream-next')).toBe(true);
    expect((await getSession(opened.sessionId!))?.title).toBe('LIVE creative collaboration / release-readiness');
  });

  it('does not turn a generic resume command into the durable task name', async () => {
    const conversationId = 'auto-nickname-generic-resume';
    const opened = await recordChatObservations(conversationId, [{
      kind: 'user_message', time: Date.now(), messageId: 'nickname-generic', text: 'Resume ChatGPT session'
    }]);
    expect((await getSession(opened.sessionId!))?.title).toBe('ChatGPT session');
    await upsertMessageEvent(opened.sessionId!, {
      kind: 'user_message', source: 'app', time: Date.now() + 1, messageId: 'nickname-real-task',
      authoredText: 'Verify Spiffy Color production acceptance',
      message: { text: 'Verify Spiffy Color production acceptance', chars: 41, truncated: false }
    });
    expect((await getSession(opened.sessionId!))?.title).toBe('Verify Spiffy Color production acceptance');
  });

  it('never promotes one generic automatic title into another and preserves manual authority', async () => {
    const conversationId = 'auto-nickname-generic-promotion';
    const sessionId = await sessionForConversation(conversationId, 'ChatGPT session');
    expect((await getSession(sessionId!))?.title).toBe('ChatGPT session');

    await sessionForConversation(conversationId, 'Resume ChatGPT session');
    expect((await getSession(sessionId!))?.title).toBe('ChatGPT session');

    await sessionForConversation(conversationId, 'Editable Animation Workflow');
    expect((await getSession(sessionId!))?.title).toBe('Editable Animation Workflow');

    await renameSession(sessionId!, 'Resume ChatGPT session');
    await sessionForConversation(conversationId, 'A newer automatic title');
    expect(await getSession(sessionId!)).toMatchObject({ title: 'Resume ChatGPT session', titleSource: 'manual' });
  });

  /**
   * The ordering that actually happens: the extension acknowledges typing the bootstrap
   * into the fresh tab before that tab has told the app anything about itself, so the
   * origin is known before the session exists.
   */
  it('keeps desktop chat titles and durable creation provenance without treating them as resumes', async () => {
    const opened = await recordChatObservations('desktop-created', [{ kind: 'user_message', time: Date.now(), text: 'Inspect my project', messageId: 'first-user' }]);
    const before = (await getSession(opened.sessionId!))!.title;
    await noteChatOrigin('desktop-created', { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    expect((await getSession(opened.sessionId!))?.origin?.kind).toBe('desktop');
    expect((await getSession(opened.sessionId!))?.title).toBe(before);
    expect(originTitle({ kind: 'desktop', fromSessionId: null, agentId: null, task: '' }, before)).toBe(before);
    await noteChatOrigin('desktop-before-recording', { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    const fresh = await recordChatObservations('desktop-before-recording', [{ kind: 'user_message', time: Date.now(), text: 'Keep my authored title', messageId: 'next-user' }]);
    expect((await getSession(fresh.sessionId!))?.title).toBe('Keep my authored title');
  });

  it('uses a queued desktop nickname as the durable primary title in both origin orderings', async () => {
    const earlyOrigin = { kind: 'desktop' as const, fromSessionId: null, agentId: null, task: '',
      nickname: 'MMA Cage Removal' };
    await noteChatOrigin('desktop-nickname-early', earlyOrigin);
    const early = await recordChatObservations('desktop-nickname-early', [{
      kind: 'user_message', time: Date.now(), text: 'A very long bootstrap prompt', messageId: 'nickname-early-user'
    }]);
    expect(await getSession(early.sessionId!)).toMatchObject({
      title: 'MMA Cage Removal', titleSource: 'manual', origin: earlyOrigin
    });

    const late = await recordChatObservations('desktop-nickname-late', [{
      kind: 'user_message', time: Date.now(), text: 'Another giant bootstrap prompt', messageId: 'nickname-late-user'
    }]);
    await noteChatOrigin('desktop-nickname-late', { ...earlyOrigin, nickname: 'Editable Broadcast Graphics' });
    expect(await getSession(late.sessionId!)).toMatchObject({
      title: 'Editable Broadcast Graphics', titleSource: 'manual'
    });
    await recordChatObservations('desktop-nickname-late', [{
      kind: 'conversation_title', time: Date.now(), text: 'Provider Generated Label'
    }]);
    expect(await getSession(late.sessionId!)).toMatchObject({
      title: 'Editable Broadcast Graphics', originalTitle: 'Provider Generated Label'
    });

    const manuallyNamed = await recordChatObservations('desktop-nickname-after-manual', [{
      kind: 'user_message', time: Date.now(), text: 'Bootstrap before its delivery ACK', messageId: 'nickname-manual-user'
    }]);
    await renameSession(manuallyNamed.sessionId!, 'User chosen title');
    await noteChatOrigin('desktop-nickname-after-manual', { ...earlyOrigin, nickname: 'Queued workstream label' });
    expect(await getSession(manuallyNamed.sessionId!)).toMatchObject({
      title: 'User chosen title', titleSource: 'manual',
      origin: expect.objectContaining({ kind: 'desktop', nickname: 'Queued workstream label' })
    });
    await recordChatObservations('desktop-nickname-after-manual', [{
      kind: 'conversation_title', time: Date.now(), text: 'Later Provider Label'
    }]);
    expect(await getSession(manuallyNamed.sessionId!)).toMatchObject({
      title: 'User chosen title', originalTitle: 'Later Provider Label'
    });

    const staleProposal = await createSession({ title: 'Bootstrap fallback' });
    await renameSession(staleProposal.id, 'Rename won while origin waited');
    await setSessionOrigin(staleProposal.id, { ...earlyOrigin, nickname: 'Late queued nickname' }, 'Late queued nickname');
    expect(await getSession(staleProposal.id)).toMatchObject({
      title: 'Rename won while origin waited', titleSource: 'manual',
      origin: expect.objectContaining({ kind: 'desktop', nickname: 'Late queued nickname' })
    });
  });

  it('names the session at creation when the origin arrives first', async () => {
    const source = await createSession({ title: 'Fix the bridge' });
    await noteChatOrigin('conv-fresh', {
      kind: 'resume',
      fromSessionId: source.id,
      agentId: null,
      task: ''
    });
    const sessionId = await recordChatObservations('conv-fresh', [
      {
        kind: 'user_message',
        time: Date.now(),
        text: 'Continue the previous Chat On Steroids session. Read the handoff below.',
        messageId: 'boot-1'
      }
    ]);
    const summary = await getSession(sessionId.sessionId!);
    expect(summary?.title).toBe('Fix the bridge');
    expect(summary?.origin?.kind).toBe('resume');
    expect(summary?.origin?.fromSessionId).toBe(source.id);
  });

  /** The other ordering: a slow ack, or a page that reported itself unusually fast. */
  it('renames a session that was already created under the bootstrap prompt', async () => {
    const opened = await recordChatObservations('conv-late', [
      {
        kind: 'user_message',
        time: Date.now(),
        text: 'You are worker agent "worker-1" in a Chat On Steroids run.',
        messageId: 'boot-2'
      }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toContain('worker agent');

    await noteChatOrigin('conv-late', worker);
    const summary = await getSession(opened.sessionId!);
    expect(summary?.title).toBe('worker-1 · Port the recorder tests to the new fixture');
    expect(summary?.origin?.agentId).toBe('worker-1');
  });

  /**
   * A worker's bootstrap stays leased until the worker joins, so the same command can be
   * acknowledged more than once. The second ack must not rename a session whose name has
   * since become somebody else's to choose.
   */
  it('stamps an origin once', async () => {
    const opened = await recordChatObservations('conv-twice', [
      { kind: 'user_message', time: Date.now(), text: 'bootstrap', messageId: 'boot-3' }
    ]);
    await noteChatOrigin('conv-twice', worker);
    await renameSession(opened.sessionId!, 'Renamed by hand');
    await noteChatOrigin('conv-twice', { ...worker, task: 'Something else entirely' });
    expect((await getSession(opened.sessionId!))?.title).toBe('Renamed by hand');
  });

  it('persists and clears a per-chat sub-agent worker limit', async () => {
    const opened = await recordChatObservations('conv-worker-limit', [
      { kind: 'user_message', time: Date.now(), text: 'coordinate this project', messageId: 'worker-limit-user' }
    ]);
    await setSessionWorkerLimit(opened.sessionId!, 5);
    expect((await getSession(opened.sessionId!))?.workerLimit).toBe(5);
    await setSessionWorkerLimit(opened.sessionId!, null);
    expect((await getSession(opened.sessionId!))?.workerLimit).toBeNull();
    await expect(setSessionWorkerLimit(opened.sessionId!, 7)).rejects.toThrow(/1 to 6/);
  });

  it('clamps a legacy per-chat worker limit of eight to six on cold read', async () => {
    const session = await createSession({ title: 'Legacy worker cap', conversationId: 'conv-legacy-worker-cap' });
    await flushSessions();
    resetSessionStoreForTests();
    const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.workerLimit = 8;
    await fs.writeFile(metaPath, JSON.stringify(meta), 'utf8');

    expect((await getSession(session.id))?.workerLimit).toBe(6);
  });

  it('leaves a chat the user started alone', async () => {
    const opened = await recordChatObservations('conv-organic', [
      { kind: 'user_message', time: Date.now(), text: 'why is the bridge flaky', messageId: 'm-1' }
    ]);
    const summary = await getSession(opened.sessionId!);
    expect(summary?.title).toBe('why is the bridge flaky');
    expect(summary?.origin).toBeNull();

    const labelled = await recordChatObservations('conv-labelled-task', [
      { kind: 'user_message', time: Date.now(), text: 'storyboard/photoeditor  (I want you to finish this workflow)', messageId: 'm-labelled' }
    ]);
    expect((await getSession(labelled.sessionId!))?.title).toBe('storyboard/photoeditor');
  });

  it('promotes only the generic fallback when the first authored user title arrives late', async () => {
    const conversationId = 'conv-late-first-user-title';
    const sessionId = await sessionForConversation(conversationId);
    expect((await getSession(sessionId!))?.title).toBe('ChatGPT session');

    const observed = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'the real opening question', messageId: 'late-first-user' }
    ]);
    expect(observed.sessionId).toBe(sessionId);
    expect((await getSession(sessionId!))?.title).toBe('the real opening question');

    const manualConversation = 'conv-manual-title-before-user';
    const manualSessionId = await sessionForConversation(manualConversation);
    await renameSession(manualSessionId!, 'My chosen title');
    await recordChatObservations(manualConversation, [
      { kind: 'user_message', time: Date.now(), text: 'must not replace manual title', messageId: 'manual-first-user' }
    ]);
    expect((await getSession(manualSessionId!))?.title).toBe('My chosen title');
  });

  it('keeps the useful first-user nickname and retains ChatGPT’s generated title as secondary', async () => {
    const conversationId = 'conv-real-page-title';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'bro fix this exact thing please', messageId: 'title-user-1' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('bro fix this exact thing please');

    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Fix Local Files Reconstruction' }
    ]);
    expect(await getSession(opened.sessionId!)).toMatchObject({
      title: 'bro fix this exact thing please',
      originalTitle: 'Fix Local Files Reconstruction'
    });

    await renameSession(opened.sessionId!, 'My manual title');
    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'A Later ChatGPT Rename' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('My manual title');
  });

  it('keeps rendered instruction frames out of titles and repairs only their exact recorded fallback', async () => {
    const conversationId = 'conv-rendered-prompt-title';
    const rendered = '[[COS_CONTEXT:100]]\nGuidance whose Markdown whitespace changed.\n[[/COS_CONTEXT]]\n\nReal request';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: rendered, messageId: 'framed-title-user' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('ChatGPT session');
    await upsertMessageEvent(opened.sessionId!, {
      time: Date.now(), source: 'app', kind: 'user_message', messageId: 'framed-title-user',
      authoredText: 'Real request', message: { text: rendered, chars: rendered.length, truncated: false }
    });
    expect((await getSession(opened.sessionId!))?.title).toBe('Real request');
    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Readable generated title' }
    ]);
    expect(await getSession(opened.sessionId!)).toMatchObject({
      title: 'Real request',
      originalTitle: 'Readable generated title'
    });
    await renameSession(opened.sessionId!, 'My title');
    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Later generated title' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('My title');
  });

  it('uses the authored request for a provider-serialized opening frame title', async () => {
    const url = 'https://prism.openai.com/?u=account&pg=1&m=main.tex';
    const authored = `Prism research\n\n${url}`;
    const framed = prependUserPrompt(authored, '# Core guidance\n- Use `read` first.');
    const serialized = framed.replace(url, `[${url}](${url})`).replace(/([_`#<>&*()-])/g, '\\$1');
    const opened = await recordChatObservations('conv-provider-serialized-title', [
      { kind: 'user_message', time: Date.now(), text: serialized, messageId: 'serialized-title-user' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('Prism research');
  });

  it.each([80, 120])('promotes a legacy %i-character preview even when title precedes its first message', async length => {
    const text = '  A long authored request '.repeat(12);
    const conversationId = `legacy-preview-${length}`;
    const session = await createSession({ conversationId, title: text.slice(0, length) });
    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Generated title' },
      { kind: 'user_message', time: Date.now(), text, messageId: 'legacy-opening' }
    ]);
    expect(await getSession(session.id)).toMatchObject({
      title: 'A long authored request A long authored request A long authored request A long…',
      originalTitle: 'Generated title'
    });
  });

  it('keeps provider naming authority across receipts, later provider renames and restart', async () => {
    const conversationId = 'provider-title-restart';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Initial provider title' }
    ]);
    await upsertMessageEvent(opened.sessionId!, { kind: 'user_message', source: 'app', time: Date.now(),
      messageId: 'provider-opening', authoredText: 'Actual request', message: { text: 'wire', chars: 4, truncated: false } });
    expect(await getSession(opened.sessionId!)).toMatchObject({ title: 'Actual request', originalTitle: 'Initial provider title' });
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    await recordChatObservations(conversationId, [{ kind: 'conversation_title', time: Date.now(), text: 'Updated provider title' }]);
    expect(await getSession(opened.sessionId!)).toMatchObject({ title: 'Actual request', originalTitle: 'Updated provider title' });
    // Even a manual name identical to the preview must stay manual.
    await renameSession(opened.sessionId!, 'Actual request');
    await recordChatObservations(conversationId, [{ kind: 'conversation_title', time: Date.now(), text: 'Must not win' }]);
    expect(await getSession(opened.sessionId!)).toMatchObject({ title: 'Actual request', originalTitle: 'Must not win', titleSource: 'manual' });
  });

  it('repairs a legacy context preview on cold read using durable authored text', async () => {
    const raw = '[[COS_CONTEXT:19268]]\nInternal instructions and AGENTS.md '.repeat(3);
    const session = await createSession({ conversationId: 'legacy-context-preview', title: 'Temporary' });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'app', time: Date.now(),
      messageId: 'context-opening', authoredText: 'Only my request', message: { text: raw, chars: raw.length, truncated: false } });
    await flushSessions(); resetSessionStoreForTests();
    const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.title = '[[COS\\_CONTEXT:19268]]'; meta.titleSource = 'fallback';
    await fs.writeFile(metaPath, JSON.stringify(meta));
    expect((await listSessions()).find(row => row.id === session.id)?.title).toBe('Only my request');
    expect((await getSession(session.id))?.title).toBe('Only my request');
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8')).titleSource).toBe('fallback');
  });

  it('uses the authored request instead of an escaped resume marker for a provider-serialized title', async () => {
    const authored = '[[CLF-RESUME:token_0123456789abcdef]]\n\nContinue the subtitle workflow';
    const framed = prependUserPrompt(authored, 'Core guidance');
    const serialized = framed.replace('CLF-RESUME:', 'CLF-RESUME\\:').replace('COS_CONTEXT', 'COS\\_CONTEXT');
    const opened = await recordChatObservations('conv-provider-serialized-resume-title', [
      { kind: 'user_message', time: Date.now(), text: serialized, messageId: 'serialized-resume-title-user' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('subtitle workflow');
  });

  it('does not persist native file credentials in recorded artifact arguments', async () => {
    const conversationId = 'conv-artifact-privacy';
    const requestId = 'wfr_artifact_privacy';
    const opened = await recordChatObservations(conversationId, [{
      kind: 'tool_evidence', time: Date.now(), fiberConversationId: conversationId,
      calls: [{ messageId: 'artifact-private', tool: 'download_artifact', order: 0, answered: false, requestId }]
    }]);
    await recordToolCall({ tool: 'download_artifact',
      args: { file: { download_url: 'https://files.oaiusercontent.com/f?sig=PRIVATE_SIGNATURE', file_id: 'file-PRIVATE_ID' }, path: '/project/image.png' },
      content: [{ type: 'text', text: 'Saved /project/image.png.' }], outcome: 'ok', durationMs: 1,
      startedAt: Date.now(), requestId, agent: null });
    const stored = JSON.stringify(await readEvents(opened.sessionId!, { kinds: ['tool_call'] }));
    expect(stored).toContain('native file credentials not stored');
    expect(stored).toContain('/project/image.png');
    expect(stored).not.toContain('PRIVATE_SIGNATURE');
    expect(stored).not.toContain('PRIVATE_ID');
  });

  it('keeps a worker saved-artifact receipt durable without retaining native file credentials', async () => {
    const conversationId = 'conv-worker-artifact-custody';
    const requestId = 'wfr_worker_artifact_custody';
    await noteChatOrigin(conversationId, worker);
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'worker bootstrap', messageId: 'worker-artifact-bootstrap' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: conversationId,
        calls: [{ messageId: 'worker-artifact-request', tool: 'download_artifact', order: 0, answered: false, requestId }]
      }
    ]);
    const saved = {
      path: '/project/results/worker-result.zip',
      size: 42,
      sha256: 'a'.repeat(64)
    };
    await recordToolCall({
      tool: 'download_artifact',
      args: {
        file: {
          download_url: 'https://files.oaiusercontent.com/f?sig=PRIVATE_WORKER_SIGNATURE',
          file_id: 'file-PRIVATE_WORKER_ID'
        },
        path: saved.path
      },
      content: [{ type: 'text', text: `Saved ${saved.path} (42 B, ${saved.sha256}).` }],
      protocolResult: saved,
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId,
      agent: 'worker-1'
    });

    const [stored] = await readEvents(opened.sessionId!, { kinds: ['tool_call'] });
    expect(stored?.kind).toBe('tool_call');
    if (stored?.kind !== 'tool_call') return;
    expect(stored.agent).toBe('worker-1');
    expect(JSON.parse(stored.call.result.text)).toEqual(saved);
    expect(stored.call.args.text).toContain('native file credentials not stored');
    expect(stored.call.args.text).not.toContain('PRIVATE_WORKER_SIGNATURE');
    expect(stored.call.args.text).not.toContain('PRIVATE_WORKER_ID');
  });

  it('recovers a late worker call agent from the durable worker session origin after live broker state is gone', async () => {
    const conversationId = 'conv-late-worker-call';
    const requestId = 'wfr_late_worker_exact';
    await noteChatOrigin(conversationId, worker);
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'worker bootstrap', messageId: 'worker-boot-late-call' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: conversationId,
        calls: [{ messageId: 'worker-late-request', tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    const originalSessionId = opened.sessionId!;
    await closeConversation(conversationId);
    expect((await getSession(originalSessionId))?.endedAt).not.toBeNull();

    const call = await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/src/main.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 5,
      startedAt: Date.now(),
      requestId,
      // Deliberately contradictory live broker context. Durable request/session epoch wins.
      agent: 'prime'
    });

    expect(call?.conversationId).toBe(conversationId);
    expect(call?.attributionMethod).toBe('request_id');
    const stored = await readEvents(originalSessionId, { kinds: ['tool_call'] });
    expect(stored).toHaveLength(1);
    const recorded = stored[0];
    expect(recorded?.kind === 'tool_call' && recorded.agent).toBe('worker-1');
    expect(recorded?.kind === 'tool_call' && recorded.call.requestId).toBe(requestId);
    // A late request is not evidence that the worker tab or browser conversation reopened.
    expect((await getSession(originalSessionId))?.endedAt).not.toBeNull();
  });

  it('files a retired source chat into its own lineage and refuses its later requests as superseded', async () => {
    const oldConversation = 'conv-worker-before-transfer';
    const newConversation = 'conv-worker-after-transfer';
    const oldRequest = 'wfr_worker_before_transfer';
    const freshRequest = 'wfr_stale_tab_fresh_epoch';
    await noteChatOrigin(oldConversation, worker);
    const original = await recordChatObservations(oldConversation, [
      { kind: 'user_message', time: Date.now(), text: 'worker bootstrap', messageId: 'boot-before-transfer' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: oldConversation,
        calls: [{ messageId: 'old-request-message', tool: 'read', order: 0, answered: false, requestId: oldRequest }]
      }
    ]);
    const originalSessionId = original.sessionId!;

    expect(await rebindSession(originalSessionId, oldConversation, newConversation)).toBe(true);
    rebindConversation(originalSessionId, oldConversation, newConversation);

    // The stale old tab is a retired frontend of the one session, never a chat of its own: its
    // prose files into the lineage (2026-09-02: the brief's late re-render minted a session
    // holding nothing but the summary) and it moves none of the projections B now owns.
    const stale = await recordChatObservations(oldConversation, [
      { kind: 'user_message', time: Date.now(), text: 'stale tab carried on', messageId: 'stale-epoch-user' },
      { kind: 'turn_start', time: Date.now(), turnId: 'g-stale-tab-turn' }
    ]);
    expect(stale.sessionId).toBe(originalSessionId);
    expect(stale.activity).toEqual({ meaningful: false, working: false, terminal: false });
    expect(
      (await readEvents(originalSessionId, { kinds: ['user_message'] })).some(
        (event) => event.kind === 'user_message' && event.messageId === 'stale-epoch-user'
      )
    ).toBe(true);
    expect(await readEvents(originalSessionId, { kinds: ['turn_start'] })).toEqual([]);
    expect((await getSession(originalSessionId))?.conversationId).toBe(newConversation);
    expect((await listSessions()).filter((entry) => entry.chatIds.includes(oldConversation))).toHaveLength(1);

    // Exact proof preserves forensic identity, but it is not execution authority after A was
    // replaced. The call stays out of B's live history.
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/old.ts'] },
      content: [{ type: 'text', text: 'old request completed late' }],
      outcome: 'ok',
      durationMs: 10,
      startedAt: Date.now(),
      requestId: oldRequest,
      agent: 'prime'
    });
    const originalCalls = await readEvents(originalSessionId, { kinds: ['tool_call'] });
    expect(originalCalls).toHaveLength(0);
    const buckets = (await listSessions()).filter((entry) => entry.title === 'Unattributed activity');
    let isolated: Extract<SessionEvent, { kind: 'tool_call' }> | undefined;
    let isolatedBucketId = '';
    for (const bucket of buckets) {
      const calls = await readEvents(bucket.id, { kinds: ['tool_call'] });
      const match = calls.find(
        (event): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
          event.kind === 'tool_call' && event.call.requestId === oldRequest
      );
      if (!match) continue;
      isolated = match;
      isolatedBucketId = bucket.id;
      break;
    }
    expect(isolated?.call.attributionMethod).toBe('superseded');
    await repairDeterministicAttribution();
    expect(
      (await readEvents(isolatedBucketId, { kinds: ['tool_call'] })).some(
        (event) => event.kind === 'tool_call' && event.call.requestId === oldRequest
      )
    ).toBe(true);

    // A request first proved in the stale tab after the move is still the retired chat's, so it
    // is refused as superseded — a message that names the handover — instead of waiting out
    // the identity window as nobody's. It lands beside the late one, never in the lineage.
    await recordChatObservations(oldConversation, [
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: oldConversation,
        calls: [{ messageId: 'fresh-request-message', tool: 'read', order: 0, answered: false, requestId: freshRequest }]
      }
    ]);
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/fresh.ts'] },
      content: [{ type: 'text', text: 'fresh request' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId: freshRequest,
      agent: null
    });
    expect(await readEvents(originalSessionId, { kinds: ['tool_call'] })).toHaveLength(0);
    const fresh = (await readEvents(isolatedBucketId, { kinds: ['tool_call'] })).find(
      (event) => event.kind === 'tool_call' && event.call.requestId === freshRequest
    );
    expect(fresh?.kind === 'tool_call' && fresh.call.attributionMethod).toBe('superseded');
    expect((await listSessions()).filter((entry) => entry.chatIds.includes(oldConversation))).toHaveLength(1);
  });

  it('does not publish or return stale A→S first-sight state after S durably rebinds to B', async () => {
    const oldConversation = `conv-init-old-${Date.now()}`;
    const newConversation = `conv-init-new-${Date.now()}`;
    const summary = await createSession({ conversationId: oldConversation, title: 'racing restore' });

    const realOpen = fs.open.bind(fs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedRead!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedRead = resolve;
    });
    let paused = false;
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(
      (async (target: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
        if (!paused && String(target) === path.join(sessionsRoot(), summary.id, 'events.jsonl')) {
          paused = true;
          reachedRead();
          await gate;
        }
        return (realOpen as (...callArgs: unknown[]) => ReturnType<typeof fs.open>)(target, ...args);
      }) as typeof fs.open
    );

    try {
      const staleInitialization = sessionForConversation(oldConversation);
      await reached;

      expect(await rebindSession(summary.id, oldConversation, newConversation)).toBe(true);
      rebindConversation(summary.id, oldConversation, newConversation);
      release();

      expect(await staleInitialization).toBeNull();
      expect((await getSession(summary.id))?.conversationId).toBe(newConversation);
      expect(liveConversations().find((entry) => entry.conversationId === oldConversation)).toBeUndefined();
      expect(liveConversations().find((entry) => entry.conversationId === newConversation)?.sessionId).toBe(summary.id);
    } finally {
      release();
      openSpy.mockRestore();
    }
  });
});

// --------------------------------------------------------------- summaries

describe('tool summaries', () => {
  const summarize = (tool: string, args: unknown, patch: Partial<ReturnType<typeof emptyEvidence>> = {}, outcome: ToolOutcome = 'ok', durationMs = 10) =>
    summarizeToolCall({ tool, args, evidence: evidence(patch), outcome, durationMs, resultHead: 'head line' });

  /** The patch text a summary reads its intent off. */
  const patch = (header: string, path: string): string =>
    `*** Begin Patch\n*** ${header}: ${path}\n*** End Patch`;

  it('names one edited file and totals several', () => {
    const one = summarize('apply_patch', { patch: patch('Update File', '/p/src/a.ts') }, {
      changes: [{ path: '/p/src/a.ts', added: 18, removed: 4, approximate: false }]
    });
    expect(one.title).toBe('Edited src/a.ts');
    expect(one.metric).toBe('+18 −4');

    const many = summarize('apply_patch', { patch: patch('Update File', '/p/a.ts') }, {
      changes: [
        { path: '/p/a.ts', added: 40, removed: 9, approximate: false },
        { path: '/p/b.ts', added: 32, removed: 10, approximate: false }
      ]
    });
    expect(many.title).toBe('Edited 2 files');
    expect(many.metric).toBe('+72 −19');
  });

  it('marks an approximate diffstat rather than pretending it is exact', () => {
    const summary = summarize('apply_patch', { patch: patch('Update File', '/p/big.ts') }, {
      changes: [{ path: '/p/big.ts', added: 4000, removed: 3000, approximate: true }]
    });
    expect(summary.metric).toBe('~+4000 −3000');
  });

  // One tool now covers create, edit, move and delete, so the title has to come from what
  // the patch did. A timeline that said "Applied a patch" four times would be useless.
  it('tells creates, deletes and moves apart from the patch itself', () => {
    expect(summarize('apply_patch', { patch: patch('Add File', '/p/src/history.ts') }, {
      changes: [{ path: '/p/src/history.ts', added: 214, removed: 0, approximate: false }]
    })).toMatchObject({ title: 'Created src/history.ts', metric: '+214', kind: 'create' });

    expect(summarize('apply_patch', { patch: patch('Delete File', '/p/old-helper.ts') }, {
      changes: [{ path: '/p/old-helper.ts', added: 0, removed: 83, approximate: false }]
    })).toMatchObject({ title: 'Deleted old-helper.ts', metric: '−83', tone: 'warn', kind: 'delete' });

    const moved = summarize(
      'apply_patch',
      { patch: '*** Begin Patch\n*** Move to: /p/new.ts\n*** End Patch' },
      { changes: [{ path: '/p/new.ts', added: 0, removed: 0, approximate: false }] }
    );
    expect(moved).toMatchObject({ title: 'Moved new.ts', kind: 'move' });

    // A patch that both adds and updates is simply an edit; it must not claim to be a create.
    const mixed = summarize(
      'apply_patch',
      { patch: `${patch('Add File', '/p/a.ts')}\n*** Update File: /p/b.ts` },
      {
        changes: [
          { path: '/p/a.ts', added: 5, removed: 0, approximate: false },
          { path: '/p/b.ts', added: 1, removed: 1, approximate: false }
        ]
      }
    );
    expect(mixed.kind).toBe('edit');
  });

  it('describes a read by its paths and range', () => {
    expect(summarize('read', { paths: ['/p/tools.ts'], start_line: 200, end_line: 420 })).toMatchObject({
      title: 'Read tools.ts',
      detail: 'lines 200–420',
      metric: '221 lines'
    });
    expect(
      summarize('read', { paths: ['/p/tools.ts'], start_line: 200, end_line: 420 }, { detail: 'lines 200–237' })
    ).toMatchObject({ detail: 'lines 200–237', metric: '38 lines' });
    expect(summarize('read', { paths: ['/p/a.ts', '/p/b.ts', '/p/c.ts'] })).toMatchObject({
      title: 'Read 3 paths',
      detail: 'a.ts, b.ts, c.ts'
    });
  });

  it('reports how a command exited', () => {
    expect(summarize('exec_command', { cmd: 'npm run verify' }, { exitCode: 0, durationMs: 4800 })).toMatchObject({
      title: 'Ran npm run verify',
      metric: '✓ 4.8s',
      tone: 'good'
    });
    const failed = summarize('exec_command', { cmd: 'npm test' }, { exitCode: 1, durationMs: 900 });
    expect(failed.title).toContain('Command failed');
    expect(failed.metric).toBe('✕ exit 1');
    expect(failed.tone).toBe('bad');
    expect(summarize('exec_command', { cmd: 'sleep 100' }, { exitCode: null, timedOut: true }).metric).toBe(
      '✕ timed out'
    );
    expect(
      summarize('exec_command', { cmd: 'npm run verify' }, { exitCode: null, durationMs: 10_000 })
    ).toMatchObject({ title: 'Started npm run verify', metric: 'started', tone: 'neutral' });
  });

  it('says which way a session was interrupted', () => {
    expect(summarize('write_stdin', { session_id: 'p1', signal: 'kill' })).toMatchObject({
      title: 'Stopped session p1',
      tone: 'warn'
    });
    expect(summarize('write_stdin', { session_id: 'p1', signal: 'int' }).title).toBe('Interrupted session p1');
    expect(summarize('write_stdin', { session_id: 'p1', chars: 'y\n' }).title).toBe('Wrote to session p1');
    expect(summarize('write_stdin', { session_id: 'p1' }).title).toBe('Waited on session p1');
  });

  it('keeps the subject but not the claim when a call fails or is refused', () => {
    const refused = summarize('apply_patch', { patch: patch('Delete File', '/p/x.ts') }, {
      changes: [{ path: '/p/x.ts', added: 0, removed: 3, approximate: false }]
    }, 'tool_rejected');
    expect(refused.title).toBe('Refused to delete x.ts');
    expect(refused.metric).toBe('refused');
    expect(refused.tone).toBe('warn');

    const errored = summarize('apply_patch', { patch: patch('Update File', '/p/x.ts') }, {
      changes: [{ path: '/p/x.ts', added: 1, removed: 1, approximate: false }]
    }, 'tool_internal_error');
    expect(errored.title).toBe('Could not edit x.ts');
    expect(errored.metric).toBe('✕ failed');
    expect(errored.detail).toBe('head line');
    expect(errored.tone).toBe('bad');
  });

  it('says a failed call failed in words, for every tool family', () => {
    const cases: Array<[string, unknown, string]> = [
      ['read', { paths: ['/p/x.ts'] }, 'Could not read x.ts'],
      ['find', { query: 'todo' }, 'Could not search "todo"'],
      ['apply_patch', { patch: patch('Update File', '/p/x.ts') }, 'Could not apply a patch'],
      ['exec_command', { cmd: 'npm test' }, 'Could not run npm test'],
      ['observe', {}, 'Could not look at the screen'],
      ['agents', { action: 'spawn', workers: [{ task: 'a' }, { task: 'b' }] }, 'Could not create 2 worker agents'],
      [
        'agents',
        { action: 'message', messages: [{ to: 'worker-1', text: 'a' }, { to: 'worker-2', text: 'b' }] },
        'Could not message 2 agents'
      ],
      ['agents', { action: 'finish', result: 'done' }, 'Could not report the finished task'],
      ['some_future_tool', {}, 'Could not run some_future_tool']
    ];
    for (const [tool, args, title] of cases) {
      const summary = summarize(tool, args, {}, 'tool_internal_error');
      expect(summary.title, tool).toBe(title);
      // Nothing may still read as an accomplished action.
      expect(summary.title, tool).not.toMatch(/^(Read|Applied|Created|Searched|Ran|Messaged|Reported|Looked) /);
    }
  });

  it('reads the action out of the flat session and agents tools', () => {
    expect(summarize('agents', { action: 'spawn', workers: [{ task: 'a' }, { task: 'b' }] }).title).toBe(
      'Created 2 worker agents'
    );
    expect(summarize('agents', { action: 'message', to: 'worker-2' }).title).toBe('Messaged worker-2');
    expect(summarize('agents', { action: 'status' }).title).toBe('Checked agent status');
    expect(summarize('session', { action: 'search', query: 'tunnel' }).title).toBe(
      'Searched recordings "tunnel"'
    );
    expect(summarize('session', { action: 'search' }).title).toBe('Listed recent recordings');
    expect(summarize('session', { action: 'read', session_id: 'session-one' }).title).toBe(
      'Read a recorded session'
    );
    expect(summarize('session', { action: 'read', session_id: 'session-one', cursor: 'opaque' }).title).toBe(
      'Continued reading a recorded session'
    );
  });

  it('names the desktop action rather than saying "computer"', () => {
    expect(summarize('computer', { actions: [{ type: 'click_ref', ref: 'e1' }] })).toMatchObject({
      title: 'Clicked',
      kind: 'input'
    });
    // Clipboard-only work is not desktop input and should not read as if it were.
    expect(summarize('computer', { actions: [{ type: 'read_clipboard' }] })).toMatchObject({
      title: 'Read the clipboard',
      kind: 'clipboard'
    });
    expect(
      summarize('computer', { actions: [{ type: 'write_clipboard', text: 'x' }, { type: 'keypress', keys: ['ctrl', 'v'] }] })
    ).toMatchObject({ kind: 'input', detail: '2 actions' });
  });

  it('shows the command that actually ran instead of the words "a command"', () => {
    const single = summarize('exec_command', { cmd: 'Get-Process -Name node' }, { exitCode: 0, durationMs: 120 });
    expect(single.title).toBe('Ran Get-Process -Name node');

    const many = summarize(
      'exec_command',
      { cmd: '# find the build\r\nGet-ChildItem -Recurse -Filter *.log\nSelect-Object -First 5' },
      { exitCode: 0, durationMs: 120 }
    );
    // Comments are skipped, the first real line leads, and the rest is signalled.
    expect(many.title).toBe('Ran Get-ChildItem -Recurse -Filter *.log …');

    const long = summarize('exec_command', { cmd: `Write-Output ${'x'.repeat(200)}` }, { exitCode: 0 });
    expect(long.title.length).toBeLessThan(90);
    expect(long.title.endsWith('…')).toBe(true);

    expect(summarize('exec_command', {}, { exitCode: 1, durationMs: 5 }).title).toBe('Command failed a command');
  });

  it('falls back to the tool name rather than "Called tool"', () => {
    expect(summarize('some_future_tool', {}).title).toBe('Ran some_future_tool');
  });
});

// ---------------------------------------------------------------- diffstat

describe('line deltas', () => {
  it('counts a pure insertion and a pure deletion exactly', () => {
    expect(lineDelta('a\nb\n', 'a\nnew\nb\n')).toEqual({ added: 1, removed: 0, approximate: false });
    expect(lineDelta('a\nb\nc\n', 'a\nc\n')).toEqual({ added: 0, removed: 1, approximate: false });
  });

  it('counts a replacement as one added and one removed', () => {
    expect(lineDelta('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('reports nothing for identical text, including a new file', () => {
    expect(lineDelta('same\n', 'same\n')).toEqual({ added: 0, removed: 0, approximate: false });
    expect(lineDelta('', 'one\ntwo\n')).toEqual({ added: 2, removed: 0, approximate: false });
    expect(formatDelta({ added: 0, removed: 0 })).toBeNull();
  });

  it('handles a reordered block without inventing changes', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const after = ['a', 'c', 'b', 'd', 'e'].join('\n');
    expect(lineDelta(before, after)).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('counts sparse edits exactly even when they are thousands of lines apart', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[10] = 'changed ten';
    after[3500] = 'changed thirty-five hundred';
    expect(lineDelta(before.join('\n'), after.join('\n'))).toEqual({
      added: 2,
      removed: 2,
      approximate: false
    });
  });

  it('normalizes CRLF/LF for sparse large-file counting', () => {
    const before = Array.from({ length: 3200 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[5] = 'changed five';
    after[3000] = 'changed three thousand';
    expect(lineDelta(`${before.join('\r\n')}\r\n`, `${after.join('\n')}\n`)).toEqual({
      added: 2,
      removed: 2,
      approximate: false
    });
  });

  it('says so when a rewrite is too large to diff exactly', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 4000 }, (_, i) => `changed ${i}`).join('\n');
    const delta = lineDelta(before, after);
    expect(delta.approximate).toBe(true);
    expect(delta.added).toBe(4000);
  });

  it('formats the metric the way the timeline shows it', () => {
    expect(formatDelta({ added: 18, removed: 4 })).toBe('+18 −4');
    expect(formatDelta({ added: 214, removed: 0 })).toBe('+214');
    expect(formatDelta({ added: 0, removed: 83 })).toBe('−83');
  });
});

// ------------------------------------------------------------------ tokens

describe('token estimation', () => {
  it('is an explicit approximation of local text only', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(4001))).toBe(1001);
  });

  it('weighs an event by the text actually kept', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'c1',
        tool: 'read_file',
        attribution: 'turn',
        args: { text: 'a'.repeat(400), truncated: false, chars: 400 },
        result: { text: 'b'.repeat(800), truncated: false, chars: 800 },
        outcome: 'ok',
        durationMs: 3,
        summary: { title: 'Read a.ts', tone: 'neutral', kind: 'read' }
      }
    } as SessionEvent;
    expect(eventTokens(event)).toBe(100 + 200 + Math.ceil('Read a.ts'.length / 4));
  });

  it('caps a truncated tool return independently of its preview and asset reference', () => {
    const event = { seq: 1, time: 1, source: 'mcp', kind: 'tool_call', call: {
      callId: 'full-result', tool: 'read', attribution: 'turn',
      args: { text: 'short preview with a recorder annotation', truncated: true, chars: 20001, assetId: 'args.txt' },
      result: { text: 'x'.repeat(8000) + ' [52306 characters stored as result.txt]', truncated: true, chars: 60306, assetId: 'result.txt' },
      outcome: 'ok', durationMs: 1, summary: { title: 'Read 3 paths', tone: 'neutral', kind: 'read' },
      assets: [{ id: 'result.txt', mimeType: 'text/plain', bytes: 60306 }]
    } } as SessionEvent;
    expect(eventTokens(event)).toBe(Math.ceil(20001 / 4) + 10000 + estimateTokens('Read 3 paths'));
    if (event.kind !== 'tool_call') throw new Error('fixture');
    delete event.call.result.assetId;
    event.call.result.text = 'Another bounded preview; overflow asset unavailable';
    expect(eventTokens(event)).toBe(Math.ceil(20001 / 4) + 10000 + estimateTokens('Read 3 paths'));
  });

  it.each([0, 39996, 40000, 40004, 524582])('caps inline MCP returns at the boundary (%i characters)', chars => {
    const event = { seq: 1, time: 1, source: 'mcp', kind: 'tool_call', call: {
      args: { text: 'a'.repeat(80000), truncated: false, chars: 80000 },
      result: { text: 'r'.repeat(chars), truncated: false, chars }, summary: { title: '' }
    } } as SessionEvent;
    expect(eventTokens(event)).toBe(20000 + Math.min(10000, Math.ceil(chars / 4)));
  });

  it.each([undefined, -1, NaN, Infinity, 2.5])('keeps legacy or malformed original lengths bounded by actual inline text (%s)', chars => {
    const event = { seq: 1, time: 1, source: 'extension', kind: 'user_message',
      message: { text: 'abcdefgh', truncated: true, chars } } as SessionEvent;
    expect(eventTokens(event)).toBe(2);
  });

  it('does not inflate the context advisory with transient progress captions', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'extension',
      kind: 'progress',
      message: { text: 'reasoning status '.repeat(100), truncated: false, chars: 1700 }
    } as SessionEvent;
    expect(eventTokens(event)).toBe(0);
  });

  it('counts a brokered agent message, which the model does read', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'app',
      kind: 'agent_message',
      messageId: 'm1',
      from: 'worker-1',
      to: 'prime',
      message: { text: 'r'.repeat(1200), truncated: false, chars: 1200 },
      delivery: 'delivered'
    } as SessionEvent;
    expect(eventTokens(event)).toBe(300);
  });

  it('grades pressure against the configured thresholds', () => {
    expect(tokenPressure(50_000, 180_000, 200_000).level).toBe('ok');
    expect(tokenPressure(185_000, 180_000, 200_000).level).toBe('large');
    expect(tokenPressure(220_000, 180_000, 200_000).level).toBe('huge');
  });
});

/**
 * The log is append-only, so a commentary line being written arrives as a run of records
 * under one id. Every reader that is not watching it live wants the opposite: the newest
 * text, once, where the line started.
 */
describe('folding redrawn commentary', () => {
  const progress = (seq: number, progressId: string, text: string, origin?: number): SessionEvent =>
    ({
      seq,
      time: seq,
      source: 'extension',
      kind: 'progress',
      progressId,
      ...(origin === undefined ? {} : { origin }),
      message: { text, truncated: false, chars: text.length }
    }) as SessionEvent;

  it('reconciles a stored Stop status from its exact stopped turn without moving or duplicating the row', () => {
    const pending: SessionEvent = { ...progress(2, 'finish-release:stop-one', 'Stop requested. ChatGPT has not yet confirmed that generation stopped.'), source: 'app', turnId: 'stop-one' };
    const stopped: SessionEvent = { seq: 4, time: 4, source: 'extension', kind: 'turn_end', turnId: 'stop-one', outcome: 'stopped' };
    const rows = [pending, stopped];
    const folded = foldProgress(rows);
    expect(folded).toHaveLength(2);
    expect(folded[0]).toMatchObject({ seq: 2, time: 2, progressId: 'finish-release:stop-one', turnId: 'stop-one', message: { text: 'Stopped. ChatGPT confirmed that generation stopped.', truncated: false } });
    expect(foldProgress(folded)).toEqual(folded);
    expect(pending.kind === 'progress' && pending.message.text).toContain('not yet confirmed');
  });
  it.each(['completed', 'interrupted', 'error', 'unknown'])('does not confirm Stop from a %s outcome', outcome => {
    const pending: SessionEvent = { ...progress(2, 'finish-release:stop-one', 'Stop requested. Still unconfirmed.'), source: 'app', turnId: 'stop-one' };
    const end = { seq: 4, time: 4, source: 'extension', kind: 'turn_end', turnId: 'stop-one', outcome } as SessionEvent;
    expect(foldProgress([pending, end])[0]).toEqual(pending);
  });
  it('never lets another turn or app-authored terminal evidence confirm a pending Stop', () => {
    const pending: SessionEvent = { ...progress(2, 'finish-release:stop-one', 'Stop requested. Still unconfirmed.'), source: 'app', turnId: 'stop-one' };
    const other: SessionEvent = { seq: 4, time: 4, source: 'extension', kind: 'turn_end', turnId: 'other', outcome: 'stopped' };
    const synthetic: SessionEvent = { ...other, source: 'app', turnId: 'stop-one' };
    expect(foldProgress([pending, other, synthetic])[0]).toEqual(pending);
  });

  it('keeps the newest text at the earliest record’s position', () => {
    const folded = foldProgress([
      progress(1, 'p1', 'Monitoring'),
      progress(2, 'p2', 'Reading'),
      progress(3, 'p1', 'Monitoring the review', 1),
      progress(4, 'p1', 'Wrote the summary', 1)
    ]);

    expect(folded.map((event) => event.seq)).toEqual([1, 2]);
    expect(folded.map((event) => (event as { message: { text: string } }).message.text)).toEqual([
      'Wrote the summary',
      'Reading'
    ]);
  });

  it('leaves everything that is not identified commentary exactly where it was', () => {
    const events: SessionEvent[] = [
      { seq: 1, time: 1, source: 'extension', kind: 'turn_start' } as SessionEvent,
      progress(2, 'p1', 'first'),
      // No id: an older recording, or a page that would not take the stamp. Nothing to fold.
      {
        seq: 3,
        time: 3,
        source: 'extension',
        kind: 'progress',
        message: { text: 'unidentified', truncated: false, chars: 12 }
      } as SessionEvent,
      progress(4, 'p1', 'second', 2),
      { seq: 5, time: 5, source: 'extension', kind: 'turn_end', outcome: 'completed' } as SessionEvent
    ];

    const folded = foldProgress(events);
    expect(folded.map((event) => event.seq)).toEqual([1, 2, 3, 5]);
    expect(foldProgress(events)).toEqual(folded);
    // Non-destructive: the original array is untouched.
    expect(events).toHaveLength(5);
  });
});

/**
 * Where the store writes when nobody has told it where.
 *
 * `root` starts as the empty string, and `path.join('', id)` is a relative path — so an
 * uninitialised store did not fail, it wrote real session folders into the process's
 * working directory. Recording being off by default hid that completely. The moment it
 * was turned on, a test run started leaving recordings scattered through the repository,
 * and the only reason it was noticed was `git status`.
 */
describe('a session store nobody has pointed anywhere', () => {
  afterEach(() => {
    initSessionStore(dir);
  });

  it('refuses to write rather than falling back to the working directory', async () => {
    unsetSessionRootForTests();
    await expect(createSession({ conversationId: null })).rejects.toThrow(/initSessionStore/);
  });

  it('refuses to read as well, instead of reporting an empty history', async () => {
    unsetSessionRootForTests();
    await expect(listSessions()).rejects.toThrow(/initSessionStore/);
  });
});

describe('activity windows', () => {
  /**
   * The label must outlive the reload it triggers.
   *
   * Both durations came from one constant, so the Active badge expired on the same instant the
   * silence ledger did — and the browser action still had this app's sweep and Chrome's alarm
   * ahead of it. What a user saw was a chat going idle and then reloading itself half a minute
   * later for no visible reason. Any future edit that collapses these two back into one number,
   * or reorders them, reproduces that exactly.
   */
  it('keeps the Active badge alive past the silence reload it triggers', () => {
    expect(CHAT_SILENCE_MS).toBe(60_000);
    expect(CHAT_ACTIVE_MS).toBeGreaterThan(CHAT_SILENCE_MS);
    // Enough headroom for both hops a queued reload still has to make: this app's maintenance
    // tick and the extension's thirty-second alarm floor.
    expect(CHAT_ACTIVE_MS - CHAT_SILENCE_MS).toBeGreaterThanOrEqual(60_000);
  });
});

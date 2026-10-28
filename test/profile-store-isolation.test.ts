import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLocalInstanceProfile,
  getActiveInstanceOwnerPaths,
  getLocalInstanceOwnerPaths,
  initConfigPath,
  loadConfig
} from '../src/main/config.js';
import {
  createSession,
  flushSessions,
  initSessionStore,
  listSessions,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import {
  flushDurable,
  initDurableStore,
  readDurable,
  resetDurableForTests,
  writeDurableNow
} from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir = '';

beforeEach(async () => {
  dir = await makeTempDir('clf-profile-store-isolation-');
  initConfigPath(dir);
  await loadConfig();
});

afterEach(async () => {
  await flushSessions().catch(() => undefined);
  await flushDurable().catch(() => undefined);
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(dir);
});

async function enterStores(owners: NonNullable<ReturnType<typeof getLocalInstanceOwnerPaths>>): Promise<void> {
  await flushSessions().catch(() => undefined);
  await flushDurable().catch(() => undefined);
  resetSessionStoreForTests();
  resetDurableForTests();
  initSessionStore(owners.sessionStoreRoot);
  initDurableStore(owners.durableStoreRoot);
}

describe('profile-owned session and durable stores', () => {
  it('keeps actual session and queue state isolated through A → B → A store activation', async () => {
    const source = getActiveInstanceOwnerPaths();
    const profileB = await createLocalInstanceProfile('Work', 'Profile 2');
    const target = getLocalInstanceOwnerPaths(profileB.id);
    expect(target).not.toBeNull();
    expect(target!.sessionStoreRoot).not.toBe(source.sessionStoreRoot);
    expect(target!.durableStoreRoot).not.toBe(source.durableStoreRoot);

    await enterStores(source);
    const sessionA = await createSession({ title: 'Profile A only', conversationId: 'profile-a-chat' });
    await writeDurableNow('profile-isolation-proof', { owner: 'A', queue: ['a-only'] });
    await flushSessions();
    await flushDurable();

    await enterStores(target!);
    expect((await listSessions()).some(row => row.id === sessionA.id || row.conversationId === 'profile-a-chat')).toBe(false);
    await expect(readDurable('profile-isolation-proof')).resolves.toBeNull();
    const sessionB = await createSession({ title: 'Profile B only', conversationId: 'profile-b-chat' });
    await writeDurableNow('profile-isolation-proof', { owner: 'B', queue: ['b-only'] });
    await flushSessions();
    await flushDurable();

    await enterStores(source);
    const sessionsA = await listSessions();
    expect(sessionsA.some(row => row.id === sessionA.id && row.conversationId === 'profile-a-chat')).toBe(true);
    expect(sessionsA.some(row => row.id === sessionB.id || row.conversationId === 'profile-b-chat')).toBe(false);
    await expect(readDurable('profile-isolation-proof')).resolves.toEqual({ owner: 'A', queue: ['a-only'] });

    await enterStores(target!);
    const sessionsB = await listSessions();
    expect(sessionsB.some(row => row.id === sessionB.id && row.conversationId === 'profile-b-chat')).toBe(true);
    expect(sessionsB.some(row => row.id === sessionA.id || row.conversationId === 'profile-a-chat')).toBe(false);
    await expect(readDurable('profile-isolation-proof')).resolves.toEqual({ owner: 'B', queue: ['b-only'] });
  });
});

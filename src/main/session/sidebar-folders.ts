/**
 * Durable, UI-only conversation folders.
 *
 * These intentionally do not reuse filesystem Projects: a sidebar collection grants no folder
 * access, changes no ChatGPT Project, and owns no chat history. It stores only local session ids.
 */
import { randomUUID } from 'node:crypto';
import type { SidebarFolder } from '../../shared/session.js';
import { readDurable, writeDurableNow } from '../durable.js';
import { logInfo } from '../logger.js';

const STATE = 'sidebar-folders';
const MAX_FOLDERS = 100;
const MAX_MEMBERS = 500;
const SESSION_ID = /^[0-9a-z-]{8,64}$/i;

interface Snapshot {
  version: 1;
  folders: SidebarFolder[];
}

let folders: SidebarFolder[] = [];
let loaded: Promise<void> | null = null;
let mutations: Promise<void> = Promise.resolve();

const copy = (folder: SidebarFolder): SidebarFolder => ({ ...folder, sessionIds: [...folder.sessionIds] });
const snapshot = (): Snapshot => ({ version: 1, folders: folders.map(copy) });

function validFolder(raw: unknown): SidebarFolder | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<SidebarFolder>;
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 60) : '';
  if (!name || typeof value.id !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(value.id)) return null;
  const sessionIds = Array.isArray(value.sessionIds)
    ? [...new Set(value.sessionIds.filter((id): id is string => typeof id === 'string' && SESSION_ID.test(id)))].slice(0, MAX_MEMBERS)
    : [];
  return {
    id: value.id,
    name,
    sessionIds,
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? Math.max(0, value.createdAt) : 0
  };
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return loaded;
  loaded = (async () => {
    const saved = await readDurable<Partial<Snapshot>>(STATE);
    if (saved?.version !== 1 || !Array.isArray(saved.folders)) return;
    const ids = new Set<string>();
    const claimed = new Set<string>();
    folders = saved.folders.flatMap(raw => {
      const folder = validFolder(raw);
      if (!folder || ids.has(folder.id)) return [];
      ids.add(folder.id);
      // One chat belongs to at most one local folder. First durable owner wins.
      folder.sessionIds = folder.sessionIds.filter(id => {
        if (claimed.has(id)) return false;
        claimed.add(id);
        return true;
      });
      return [folder];
    }).slice(0, MAX_FOLDERS);
  })();
  return loaded;
}

async function mutate<T>(work: () => Promise<T>): Promise<T> {
  const result = mutations.then(async () => {
    await ensureLoaded();
    return work();
  });
  mutations = result.then(() => undefined, () => undefined);
  return result;
}

export async function listSidebarFolders(): Promise<SidebarFolder[]> {
  await mutations;
  await ensureLoaded();
  return folders.map(copy);
}

export function createSidebarFolder(name: string, sessionIds: string[]): Promise<SidebarFolder[]> {
  return mutate(async () => {
    const clean = name.trim().slice(0, 60);
    const members = [...new Set(sessionIds.filter(id => SESSION_ID.test(id)))].slice(0, MAX_MEMBERS);
    if (!clean) throw new Error('Folder name is required');
    if (!members.length) throw new Error('Select at least one conversation');
    if (folders.length >= MAX_FOLDERS) throw new Error(`Up to ${MAX_FOLDERS} sidebar folders are supported`);
    for (const folder of folders) folder.sessionIds = folder.sessionIds.filter(id => !members.includes(id));
    const created: SidebarFolder = { id: randomUUID(), name: clean, sessionIds: members, createdAt: Date.now() };
    folders.push(created);
    await writeDurableNow(STATE, snapshot());
    logInfo(`sidebar folder ${created.id} created with ${members.length} conversation(s)`);
    return folders.map(copy);
  });
}

export function assignSidebarFolder(folderId: string | null, sessionIds: string[]): Promise<SidebarFolder[]> {
  return mutate(async () => {
    const members = [...new Set(sessionIds.filter(id => SESSION_ID.test(id)))].slice(0, MAX_MEMBERS);
    if (!members.length) throw new Error('Select at least one conversation');
    const target = folderId === null ? null : folders.find(folder => folder.id === folderId);
    if (folderId !== null && !target) throw new Error('Sidebar folder not found');
    for (const folder of folders) folder.sessionIds = folder.sessionIds.filter(id => !members.includes(id));
    if (target) target.sessionIds.push(...members);
    await writeDurableNow(STATE, snapshot());
    logInfo(`${members.length} conversation(s) ${target ? `moved to sidebar folder ${target.id}` : 'removed from sidebar folders'}`);
    return folders.map(copy);
  });
}

export function renameSidebarFolder(folderId: string, name: string): Promise<SidebarFolder[]> {
  return mutate(async () => {
    const folder = folders.find(entry => entry.id === folderId);
    const clean = name.trim().slice(0, 60);
    if (!folder) throw new Error('Sidebar folder not found');
    if (!clean) throw new Error('Folder name is required');
    folder.name = clean;
    await writeDurableNow(STATE, snapshot());
    logInfo(`sidebar folder ${folder.id} renamed`);
    return folders.map(copy);
  });
}

export function deleteSidebarFolder(folderId: string): Promise<SidebarFolder[]> {
  return mutate(async () => {
    const before = folders.length;
    folders = folders.filter(folder => folder.id !== folderId);
    if (folders.length === before) throw new Error('Sidebar folder not found');
    await writeDurableNow(STATE, snapshot());
    logInfo(`sidebar folder ${folderId} removed; conversations kept`);
    return folders.map(copy);
  });
}

/** Clears UI-only folder records after an explicitly confirmed all-session purge. */
export function clearSidebarFolders(): Promise<number> {
  return mutate(async () => {
    const removed = folders.length;
    folders = [];
    await writeDurableNow(STATE, snapshot());
    logInfo(`cleared ${removed} sidebar folder(s) with the all-session purge`);
    return removed;
  });
}

/** Test seam: durable state remains owned by durable.ts; this clears only this module cache. */
export function resetSidebarFoldersForTests(): void {
  folders = [];
  loaded = null;
  mutations = Promise.resolve();
}

import { afterEach, beforeEach, expect, it } from 'vitest';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  assignSidebarFolder,
  clearSidebarFolders,
  createSidebarFolder,
  deleteSidebarFolder,
  listSidebarFolders,
  renameSidebarFolder,
  resetSidebarFoldersForTests
} from '../src/main/session/sidebar-folders.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';

beforeEach(async () => {
  directory = await makeTempDir('clf-sidebar-folders-');
  initDurableStore(directory);
  resetSidebarFoldersForTests();
});

afterEach(async () => {
  await flushDurable();
  resetSidebarFoldersForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

it('persists local folders and keeps each conversation in only one folder', async () => {
  const first = '2026-09-14-aaaaaaaa';
  const second = '2026-09-14-bbbbbbbb';
  const third = '2026-09-14-cccccccc';
  let folders = await createSidebarFolder('Editing', [first, second]);
  const editing = folders[0]!;
  folders = await createSidebarFolder('Research', [second, third]);
  const research = folders.find(folder => folder.name === 'Research')!;
  expect(folders.find(folder => folder.id === editing.id)?.sessionIds).toEqual([first]);
  expect(research.sessionIds).toEqual([second, third]);

  folders = await assignSidebarFolder(editing.id, [third]);
  expect(folders.find(folder => folder.id === editing.id)?.sessionIds).toEqual([first, third]);
  expect(folders.find(folder => folder.id === research.id)?.sessionIds).toEqual([second]);
  folders = await renameSidebarFolder(editing.id, 'VFX');
  expect(folders.find(folder => folder.id === editing.id)?.name).toBe('VFX');

  resetSidebarFoldersForTests();
  expect(await listSidebarFolders()).toEqual(folders);
  folders = await assignSidebarFolder(null, [first]);
  expect(folders.find(folder => folder.id === editing.id)?.sessionIds).toEqual([third]);
  folders = await deleteSidebarFolder(research.id);
  expect(folders).toHaveLength(1);
  expect(folders[0]?.name).toBe('VFX');
});

it('clears every UI-only folder for the protected all-records purge', async () => {
  await createSidebarFolder('Editing', ['session-a']);
  await createSidebarFolder('Research', ['session-b']);
  expect(await clearSidebarFolders()).toBe(2);
  expect(await listSidebarFolders()).toEqual([]);
});

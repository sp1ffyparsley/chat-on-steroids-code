import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

let tempRoot: string | null = null;
const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('electron');
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: originalResourcesPath
  });
  if (tempRoot) await removeTempDir(tempRoot);
  tempRoot = null;
});

async function loadRuntimeSource(packaged: boolean, appPath = process.cwd()) {
  vi.doMock('electron', () => ({ app: { isPackaged: packaged, getAppPath: () => appPath } }));
  return import('../src/main/runtime-source.js');
}

function setResourcesPath(resourcesPath: string): void {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resourcesPath
  });
}

it('uses the packaging owner for development Git commit/tree/dirty semantics', async () => {
  const repoRoot = process.cwd();
  const packageModuleUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'package.mjs')).href;
  const packaging = (await import(/* @vite-ignore */ packageModuleUrl)) as {
    readGitSourceIdentity(root: string): { commit: string; tree: string; dirty: boolean };
  };
  const expected = packaging.readGitSourceIdentity(repoRoot);
  const { runtimeSourceIdentity } = await loadRuntimeSource(false, repoRoot);

  await expect(runtimeSourceIdentity(true)).resolves.toEqual({
    commit: expected.commit,
    tree: expected.tree,
    dirty: expected.dirty
  });
});

it('projects only commit/tree/dirty from the packaged provenance resource', async () => {
  tempRoot = await makeTempDir('cos-runtime-source-');
  const resources = path.join(tempRoot, 'resources');
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(resources, 'SOURCE_PROVENANCE.json'), JSON.stringify({
    schema: 2,
    objectFormat: 'sha1',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    dirty: false,
    localPath: 'C:\\private\\must-not-project'
  }));
  setResourcesPath(resources);
  const { runtimeSourceIdentity } = await loadRuntimeSource(true);

  await expect(runtimeSourceIdentity()).resolves.toEqual({
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    dirty: false
  });
});

it('fails closed on malformed embedded provenance', async () => {
  tempRoot = await makeTempDir('cos-runtime-source-invalid-');
  const resources = path.join(tempRoot, 'resources');
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(resources, 'SOURCE_PROVENANCE.json'), JSON.stringify({
    schema: 2,
    objectFormat: 'sha256',
    commit: 'not-an-object-id',
    tree: 'b'.repeat(64),
    dirty: false
  }));
  setResourcesPath(resources);
  const { runtimeSourceIdentity } = await loadRuntimeSource(true);

  await expect(runtimeSourceIdentity()).resolves.toBeNull();
});

it('never falls back to a nearby Git checkout when packaged provenance is absent', async () => {
  tempRoot = await makeTempDir('cos-runtime-source-missing-');
  setResourcesPath(tempRoot);
  const { runtimeSourceIdentity } = await loadRuntimeSource(true, process.cwd());

  await expect(runtimeSourceIdentity()).resolves.toBeNull();
});

import { promises as fs, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

let base: string | null = null;
const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('electron');
  vi.doUnmock('node:fs');
  vi.restoreAllMocks();
  if (base) await removeTempDir(base);
  base = null;
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: originalResourcesPath
  });
});

it('builds only a one-use reload URL for the exact paired Chrome extension origin', async () => {
  vi.doMock('electron', () => ({ app: { isPackaged: false } }));
  const { companionReloadUrl } = await import('../src/main/extension-path.js');
  expect(companionReloadUrl('chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip', 'build-123')).toBe(
    'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html?clf-reload=1&nonce=build-123&close=1'
  );
  expect(companionReloadUrl('https://chatgpt.com', 'build-123')).toBeNull();
  expect(companionReloadUrl('chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip', '../bad')).toBeNull();
});

it('materializes a packaged extension into a stable per-user folder', async () => {
  base = await makeTempDir('clf-extension-path-');
  const resources = path.join(base, 'ephemeral-appimage-mount', 'resources');
  const bundled = path.join(resources, 'extension');
  const userData = path.join(base, 'user-data');
  await fs.mkdir(path.join(bundled, 'icons'), { recursive: true });
  await fs.writeFile(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '9.9.9' }));
  await fs.writeFile(path.join(bundled, 'background.js'), 'current package');
  await fs.writeFile(path.join(bundled, 'icons', 'icon128.png'), 'icon');

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { companionMaterializedFingerprint, extensionDir } = await import('../src/main/extension-path.js');
  const first = extensionDir();
  expect(first).toBe(path.join(userData, 'extension'));
  expect(first).not.toContain('ephemeral-appimage-mount');
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('current package');
  expect(await fs.readFile(path.join(first!, 'icons', 'icon128.png'), 'utf8')).toBe('icon');
  expect(companionMaterializedFingerprint(first)).toMatch(/^[a-f0-9]{64}$/);

  // An app update refreshes files at the same Chrome-visible path rather than asking the user
  // to Load unpacked again from a new versioned directory.
  await fs.writeFile(path.join(bundled, 'background.js'), 'updated package');
  expect(extensionDir()).toBe(first);
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('updated package');
  const updatedFingerprint = companionMaterializedFingerprint(first);
  expect(updatedFingerprint).toMatch(/^[a-f0-9]{64}$/);

  // Once a complete stable copy exists, later package damage must not make the Finder/Chrome
  // path disappear. The source is used to refresh; the stable copy is what the user loaded.
  await fs.rm(path.join(bundled, 'manifest.json'));
  expect(extensionDir()).toBe(first);
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('updated package');
  expect(companionMaterializedFingerprint(first)).toBe(updatedFingerprint);
});

it('checks full stable bytes rather than trusting an unchanged fingerprint marker', async () => {
  base = await makeTempDir('clf-extension-content-proof-');
  const resources = path.join(base, 'resources'), userData = path.join(base, 'user-data');
  await fs.mkdir(path.join(resources, 'extension'), { recursive: true });
  await fs.writeFile(path.join(resources, 'extension', 'manifest.json'), '{}');
  await fs.writeFile(path.join(resources, 'extension', 'background.js'), 'current package');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, writable: true, value: resources });
  vi.doMock('electron', () => ({ app: { isPackaged: true, getPath: () => userData } }));
  const { extensionDir, companionMaterializedFingerprint } = await import('../src/main/extension-path.js');
  const stable = extensionDir()!;
  const marker = companionMaterializedFingerprint(stable);
  await fs.writeFile(path.join(stable, 'background.js'), 'stale edited bytes');
  expect(extensionDir()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('current package');
  expect(companionMaterializedFingerprint(stable)).toBe(marker);
  const before = (await fs.stat(path.join(stable, 'background.js'))).mtimeMs;
  expect(extensionDir()).toBe(stable);
  expect((await fs.stat(path.join(stable, 'background.js'))).mtimeMs).toBe(before);
});

async function sharedFixture() {
  base = await makeTempDir('clf-extension-shared-lock-');
  const primary = path.join(base, 'primary'), child = path.join(base, 'child');
  const resources = path.join(base, 'resources'), stable = path.join(primary, 'extension');
  await fs.mkdir(stable, { recursive: true });
  await fs.mkdir(path.join(resources, 'extension'), { recursive: true });
  await fs.writeFile(path.join(stable, 'manifest.json'), '{}');
  await fs.writeFile(path.join(stable, 'background.js'), 'previous good');
  await fs.writeFile(path.join(resources, 'extension', 'manifest.json'), '{}');
  await fs.writeFile(path.join(resources, 'extension', 'background.js'), 'new package');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, writable: true, value: resources });
  vi.doMock('electron', () => ({ app: { isPackaged: true, getPath: () => child } }));
  return { primary, child, resources, stable, lock: `${stable}.materialize.lock` };
}

it.each(['live', 'unknown', 'recovery-in-progress'])('never steals a %s publisher or removes its staging', async state => {
  const { primary, stable, lock } = await sharedFixture();
  await fs.mkdir(lock);
  const owner = state === 'unknown' ? 'unverified owner' : JSON.stringify({ version: 1,
    pid: state === 'live' ? process.pid : 0xffff_fffe, nonce: 'a'.repeat(32) });
  await fs.writeFile(path.join(lock, 'owner.json'), owner);
  if (state === 'recovery-in-progress') {
    await fs.writeFile(path.join(lock, 'recovering'), 'other recovery claimant');
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ESRCH' }); });
  }
  await fs.mkdir(`${stable}.new`);
  await fs.writeFile(path.join(`${stable}.new`, 'preserve'), 'owned staging');
  const { extensionDir, usePrimaryStableExtensionRoot } = await import('../src/main/extension-path.js');
  usePrimaryStableExtensionRoot(primary);
  expect(extensionDir()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('previous good');
  expect(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).toBe(owner);
  expect(await fs.readFile(path.join(`${stable}.new`, 'preserve'), 'utf8')).toBe('owned staging');
});

it('keeps the previous shared tree when copying the newer child package fails and releases only its own lock', async () => {
  const { primary, stable, lock } = await sharedFixture();
  vi.doMock('node:fs', async importOriginal => ({
    ...await importOriginal<typeof import('node:fs')>(),
    cpSync: () => { throw Object.assign(new Error('test disk failure'), { code: 'ENOSPC' }); }
  }));
  const { extensionDir, usePrimaryStableExtensionRoot } = await import('../src/main/extension-path.js');
  usePrimaryStableExtensionRoot(primary);
  expect(extensionDir()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('previous good');
  expect(existsSync(lock)).toBe(false);
});

/** The production module runs in independent Node processes, with only Electron's
 * packaged-path API and diagnostic logger substituted. The filesystem lock,
 * process existence check, recursive copy and atomic renames remain real. */
async function processFixture() {
  const fixture = await sharedFixture();
  const source = (await fs.readFile(path.join(process.cwd(), 'src/main/extension-path.ts'), 'utf8'))
    .replace("import { app } from 'electron';", 'const app = (globalThis as any).__extensionApp;')
    .replace("import { logInfo, logWarn } from './logger.js';", 'const logInfo = (_text: string) => {}; const logWarn = (_text: string) => {};');
  const compiled = path.join(base!, 'extension-path.mjs');
  await fs.writeFile(compiled, stripTypeScriptTypes(source));
  const runner = `const fs = require('node:fs');
    const [compiled, resources, primary, child, role, entered, release] = process.argv.slice(1);
    globalThis.__extensionApp = { isPackaged: true, getPath: () => role === 'primary' ? primary : child };
    process.resourcesPath = resources;
    if (entered) {
      const copy = fs.cpSync;
      fs.cpSync = (...args) => {
        fs.writeFileSync(entered, 'copy entered');
        const until = Date.now() + 5000;
        while (!fs.existsSync(release) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        if (!fs.existsSync(release)) throw new Error('test copy gate expired');
        return copy(...args);
      };
    }
    require('node:module').syncBuiltinESMExports();
    import(require('node:url').pathToFileURL(compiled).href).then(module => {
      if (role === 'child') module.usePrimaryStableExtensionRoot(primary);
      process.stdout.write(JSON.stringify({ path: module.extensionDir() }));
    }).catch(error => { console.error(error); process.exitCode = 1; });`;
  return { ...fixture, compiled, runner };
}

it.each(['primary', 'child'])('serializes a real %s publisher against the other account process', async role => {
  const fixture = await processFixture();
  const { compiled, runner, resources, primary, child, stable, lock } = fixture;
  const entered = path.join(base!, 'copy-entered'), release = path.join(base!, 'copy-release');
  const writer = spawn(process.execPath, ['-e', runner, compiled, resources, primary, child, role, entered, release], { windowsHide: true });
  let stderr = '';
  writer.stderr.on('data', data => { stderr += data.toString(); });
  const completion = new Promise<number | null>((resolve, reject) => { writer.once('exit', resolve); writer.once('error', reject); });
  try {
    await vi.waitFor(() => expect(existsSync(entered)).toBe(true), { timeout: 3000 });
    const contenderRole = role === 'primary' ? 'child' : 'primary';
    const contender = spawnSync(process.execPath, ['-e', runner, compiled, resources, primary, child, contenderRole], { windowsHide: true, encoding: 'utf8', timeout: 3000 });
    expect(contender.status, contender.stderr).toBe(0);
    expect(JSON.parse(contender.stdout).path).toBe(stable);
    expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('previous good');
    expect(existsSync(lock)).toBe(true);
    await fs.writeFile(release, 'continue');
    expect(await completion, stderr).toBe(0);
    expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('new package');
    expect(existsSync(lock)).toBe(false);
    const repeat = spawnSync(process.execPath, ['-e', runner, compiled, resources, primary, child, contenderRole], { windowsHide: true, encoding: 'utf8', timeout: 3000 });
    expect(repeat.status, repeat.stderr).toBe(0);
    expect(existsSync(path.join(child, 'extension'))).toBe(false);
  } finally {
    await fs.writeFile(release, 'release on failure');
    await completion;
  }
});

it('recovers a real exited publisher lock only after positively proving that process absent', async () => {
  const { compiled, runner, resources, primary, child, stable, lock } = await processFixture();
  const reserve = spawnSync(process.execPath, ['-e', `const fs=require('node:fs'); const lock=process.argv[1]; fs.mkdirSync(lock); fs.writeFileSync(require('node:path').join(lock,'owner.json'), JSON.stringify({version:1,pid:process.pid,nonce:'a'.repeat(32)}));`, lock], { windowsHide: true, encoding: 'utf8', timeout: 3000 });
  expect(reserve.status, reserve.stderr).toBe(0);
  const recovered = spawnSync(process.execPath, ['-e', runner, compiled, resources, primary, child, 'child'], { windowsHide: true, encoding: 'utf8', timeout: 3000 });
  expect(recovered.status, recovered.stderr).toBe(0);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('new package');
  expect(existsSync(lock)).toBe(false);
});

it('lets an isolated account refresh the shared companion from its installed package without starting the primary or creating a private copy', async () => {
  base = await makeTempDir('clf-extension-shared-');
  const primary = path.join(base, 'primary');
  const child = path.join(base, 'child');
  const resources = path.join(base, 'resources');
  await fs.mkdir(path.join(primary, 'extension'), { recursive: true });
  await fs.mkdir(path.join(resources, 'extension'), { recursive: true });
  await fs.writeFile(path.join(primary, 'extension', 'manifest.json'), '{}');
  await fs.writeFile(path.join(primary, 'extension', 'background.js'), 'primary bytes');
  await fs.writeFile(path.join(resources, 'extension', 'manifest.json'), '{}');
  await fs.writeFile(path.join(resources, 'extension', 'background.js'), 'different package bytes');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, writable: true, value: resources });
  vi.doMock('electron', () => ({ app: { isPackaged: true, getPath: () => child } }));

  const { extensionDir, usePrimaryStableExtensionRoot } = await import('../src/main/extension-path.js');
  usePrimaryStableExtensionRoot(primary);
  expect(extensionDir()).toBe(path.join(primary, 'extension'));
  expect(await fs.readFile(path.join(primary, 'extension', 'background.js'), 'utf8')).toBe('different package bytes');
  await expect(fs.access(path.join(child, 'extension'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('repairs a stale destination shape with a complete staged extension instead of failing mid-copy', async () => {
  base = await makeTempDir('clf-extension-repair-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'extension');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'extension');
  await fs.mkdir(path.join(bundled, 'icons'), { recursive: true });
  await fs.writeFile(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '2.0.2' }));
  await fs.writeFile(path.join(bundled, 'background.js'), 'new background');
  await fs.writeFile(path.join(bundled, 'icons', 'icon128.png'), 'new icon');

  // This is a deterministic failure for the previous direct `cpSync(bundled, stable)` design:
  // the destination has `icons` as a file while the package has it as a directory. A fresh staged
  // tree has no such type collision and replaces the old copy only after the whole copy succeeds.
  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(stable, 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
  await fs.writeFile(path.join(stable, 'background.js'), 'old background');
  await fs.writeFile(path.join(stable, 'icons'), 'stale file where a directory belongs');

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../src/main/extension-path.js');
  expect(extensionDir()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('new background');
  expect(await fs.readFile(path.join(stable, 'icons', 'icon128.png'), 'utf8')).toBe('new icon');
  await expect(fs.access(`${stable}.new`)).rejects.toBeDefined();
  await expect(fs.access(`${stable}.old`)).rejects.toBeDefined();
});

it('recovers an interrupted promotion from the valid old copy before trusting stale new or package data', async () => {
  base = await makeTempDir('clf-extension-crash-recovery-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'extension');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'extension');
  const backup = `${stable}.old`;
  const stage = `${stable}.new`;

  // Model a crash after the previous good directory was renamed to `.old`: `stable` has since
  // become a corrupt/incomplete directory, `.old` is the only known-good published copy and
  // `.new` is stale staging. Also damage the package source so recovery cannot rely on a recopy.
  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, 'background.js'), 'package without manifest');
  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(stable, 'background.js'), 'corrupt stable');
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ version: '1.9.9' }));
  await fs.writeFile(path.join(backup, 'background.js'), 'last known good');
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ version: '2.0.2' }));
  await fs.writeFile(path.join(stage, 'background.js'), 'uncommitted staging');

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../src/main/extension-path.js');
  expect(extensionDir()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('last known good');
  expect(JSON.parse(await fs.readFile(path.join(stable, 'manifest.json'), 'utf8'))).toEqual({ version: '1.9.9' });
  await expect(fs.access(backup)).rejects.toBeDefined();
  await expect(fs.access(stage)).rejects.toBeDefined();
});

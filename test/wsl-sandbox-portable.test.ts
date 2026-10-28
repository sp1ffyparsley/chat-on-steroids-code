import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const os = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn(), lstat: vi.fn() }));
vi.mock('node:path', async original => {
  const module = await original<typeof import('node:path')>();
  return { ...module.win32, default: module.win32 };
});
vi.mock('../src/main/rawfs.js', () => ({
  rawRealpathNative: os.realpath,
  rawPromises: { stat: os.stat, lstat: os.lstat }
}));

const folder = String.raw`\\wsl.localhost\Ubuntu\home\you\Project`;
const alias = folder.replace('wsl.localhost', 'wsl$');
const file = `${folder}\\File.txt`;
const sub = `${folder}\\Sub`;
const distroRoot = '\\\\wsl.localhost\\Ubuntu\\';
const runnerPlatform = process.platform;
let sandbox: typeof import('../src/main/sandbox.js');

const missing = () => Object.assign(new Error('Not found'), { code: 'ENOENT' });

beforeAll(async () => {
  vi.stubGlobal('process', new Proxy(process, {
    get: (target, property) => property === 'platform' ? 'win32' : Reflect.get(target, property)
  }));
  try { sandbox = await import('../src/main/sandbox.js'); }
  finally { vi.unstubAllGlobals(); }
});
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => {
  expect(process.platform).toBe(runnerPlatform);
  os.realpath.mockReset().mockImplementation(async (input: string) => {
    const canonical = input.replace('wsl$', 'wsl.localhost');
    if ([folder, file, sub, distroRoot].includes(canonical)) return canonical;
    throw missing();
  });
  os.stat.mockReset().mockResolvedValue({ isDirectory: () => true });
  os.lstat.mockReset().mockRejectedValue(missing());
});

it('approves both local WSL spellings but not the whole distro', async () => {
  expect(await sandbox.validateNewRoot(alias, [])).toBe(folder);
  await expect(sandbox.validateNewRoot(distroRoot, [])).rejects.toThrow(/entire/);
});

it('resolves approved aliases and a genuinely missing descendant through one sandbox', async () => {
  const roots = [{ name: 'work', path: folder }];
  expect((await sandbox.resolvePath(roots, `${alias}\\File.txt`)).virtual).toBe('/work/File.txt');
  expect((await sandbox.resolvePath(roots, '/work/File.txt')).real).toBe(file);
  expect((await sandbox.resolvePath(roots, `${alias}\\Sub\\new.txt`, { allowMissing: true })).real).toBe(`${folder}\\Sub\\new.txt`);
  await expect(sandbox.resolvePath(roots, '/work/Sub/new.txt')).rejects.toThrow(/Not found/);
});

it('retains Linux case while keeping redirector host and distro aliases equivalent', async () => {
  const wrongCase = folder.replace('Project', 'project');
  const mixedAlias = alias.replace('wsl$', 'WSL$').replace('Ubuntu', 'uBuNtU');
  expect(sandbox.nativePathIdentity(mixedAlias)).toBe(sandbox.nativePathIdentity(folder));
  expect(sandbox.nativePathIdentity(`${folder}\\Asset`)).not.toBe(sandbox.nativePathIdentity(`${folder}\\asset`));
  expect(sandbox.isContained(folder, `${folder}\\Child`)).toBe(true);
  expect(sandbox.isContained(folder, wrongCase)).toBe(false);
  expect(sandbox.isContained('C:\\Work', 'c:\\work\\child')).toBe(true);
});

it('normalizes the legacy alias before every mocked filesystem call', async () => {
  const roots = [{ name: 'work', path: alias }];
  expect(await sandbox.validateNewRoot(alias, [])).toBe(folder);
  await sandbox.resolvePath(roots, `${alias}\\Sub\\new.txt`, { allowMissing: true });

  const ioPaths = [os.realpath, os.stat, os.lstat]
    .flatMap(mock => mock.mock.calls.map(call => String(call[0])));
  expect(ioPaths.length).toBeGreaterThan(0);
  expect(ioPaths.every(input => !/^\\\\wsl\$\\/i.test(input))).toBe(true);
  expect(os.realpath).toHaveBeenCalledWith(folder);
  expect(os.stat).toHaveBeenCalledWith(folder);
});

it('refuses arbitrary UNC, extended UNC, another distro and case siblings before lookup', async () => {
  const roots = [{ name: 'work', path: folder }];
  for (const input of [
    String.raw`\\server\share\file.txt`,
    String.raw`\\wsl.localhost.evil\Ubuntu\home\you\Project\file.txt`,
    String.raw`\\wsl.localhost\Debian\home\you\Project\file.txt`,
    folder.replace('Project', 'project')
  ]) {
    os.realpath.mockClear();
    await expect(sandbox.resolvePath(roots, input, { allowMissing: true })).rejects.toThrow(/not inside/);
    expect(os.realpath).not.toHaveBeenCalled();
  }
  for (const input of [String.raw`\\server\share\folder`, '//server/share/folder', String.raw`\\?\UNC\wsl.localhost\Ubuntu\home\you\Project`]) {
    os.realpath.mockClear();
    await expect(sandbox.validateNewRoot(input, [])).rejects.toThrow(/UNC/);
    expect(os.realpath).not.toHaveBeenCalled();
  }
});

it('refuses traversal and invalid Windows segments before lookup', async () => {
  const roots = [{ name: 'work', path: folder }];
  for (const suffix of ['Sub\\..\\file.txt', 'Sub\\.\\file.txt', 'file.txt:stream', 'nul', 'name.']) {
    os.realpath.mockClear();
    await expect(sandbox.resolvePath(roots, `${alias}\\${suffix}`, { allowMissing: true })).rejects.toThrow();
    expect(os.realpath).not.toHaveBeenCalled();
  }
});

it('refuses an existing unresolved link and rechecks each missing-target ancestor', async () => {
  const roots = [{ name: 'work', path: folder }];
  const unresolved = `${folder}\\unresolved-link`;
  os.lstat.mockImplementation(async (input: string) => {
    if (input.replace('wsl$', 'wsl.localhost') === unresolved) return { isSymbolicLink: () => true };
    throw missing();
  });
  await expect(sandbox.resolvePath(roots, '/work/unresolved-link/new.txt', { allowMissing: true }))
    .rejects.toThrow(/link that could not be resolved safely/);
  expect(os.lstat).toHaveBeenCalledWith(`${folder}\\unresolved-link\\new.txt`);
  expect(os.lstat).toHaveBeenCalledWith(unresolved);
});

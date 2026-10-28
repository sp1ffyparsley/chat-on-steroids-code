import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeArch, normalizePlatform, PLATFORM_INFO } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_PROVENANCE_SCHEMA = 2;
export const SOURCE_PROVENANCE_RELATIVE = path.join('resources', 'packaging', 'SOURCE_PROVENANCE.json');
const IGNORED_SOURCE_INPUTS = ['.env', '.env.*', 'src', 'scripts', 'native', 'extension', 'artwork'];
const BUILD_TOOLS = [
  ['electron', 'cli.js'],
  ['electron-builder', path.join('out', 'cli', 'cli.js')],
  ['electron-vite', path.join('bin', 'electron-vite.js')],
  ['vite', path.join('bin', 'vite.js')],
  ['typescript', path.join('bin', 'tsc')]
];
const WINDOWS_X64_BUILDER_TOOLSETS = {
  sevenZip: {
    release: '7zip@1.0.0', archive: '7zip-win-x64.tar.gz',
    sha256: 'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3'
  },
  nsis: {
    release: 'nsis-3.0.4.1', archive: 'nsis-3.0.4.1.7z',
    sha256: '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa'
  },
  nsisResources: {
    release: 'nsis-resources-3.4.1', archive: 'nsis-resources-3.4.1.7z',
    sha256: '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103'
  }
};

function value(args, name, fallback) {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

function run(command, commandArgs, { cwd = root, env = process.env, stdio = 'inherit', encoding } = {}) {
  const result = spawnSync(command, commandArgs, { cwd, stdio, env, encoding, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    throw new Error(`${command} ${commandArgs.join(' ')} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function runText(command, commandArgs, options = {}) {
  return String(run(command, commandArgs, { ...options, stdio: 'pipe', encoding: 'utf8' }).stdout ?? '').trim();
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha512Base64File(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64');
}

export function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

/** Required personal-build capability. Check source AND the assembled companion, not version labels alone. */
export function assertNativeApprovalFeature(extensionRoot, referenceRoot = null) {
  const names = ['chatgpt-dom.js', 'content.js', 'background.js', 'popup.js', 'popup.html', 'popup.css'];
  const [dom, content, background] = names.slice(0, 3).map(name => readFileSync(path.join(extensionRoot, name), 'utf8'));
  const required = [
    ['native allow-once implementation', /function autoApproveIfNeeded\(stillCurrent\)/.test(dom) && /\n\s+autoApproveIfNeeded,/.test(dom)],
    ['bounded native click dispatch', dom.includes('button.click()') && dom.includes('APPROVAL_MAX_ATTEMPTS = 3')],
    ['recorder action wiring', content.includes('CLF_DOM.autoApproveIfNeeded?.(current)') && content.includes('autoApproveNativeTools();')],
    ['fresh account policy', content.includes('nativeApprovalPolicy?.paused === false') && content.includes('data.automationPaused')],
    ['mixed-adapter startup refusal', content.includes("typeof CLF_DOM.autoApproveIfNeeded !== 'function'")],
    ['passive approval eligibility', content.includes('function nativeApprovalHealth()') && content.includes('nativeApproval: nativeApprovalHealth()')],
    ['visible approval eligibility', readFileSync(path.join(extensionRoot, 'popup.js'), 'utf8').includes('paintNativeApproval(info, ready);') &&
      readFileSync(path.join(extensionRoot, 'popup.html'), 'utf8').includes('id="approvalStatus" role="status"')]
  ];
  const missing = required.filter(([, present]) => !present).map(([label]) => label);
  const recorderVersion = Number(/const RECORDER_VERSION = (\d+);/.exec(content)?.[1]);
  const backgroundVersion = Number(/const PAGE_RECORDER_VERSION = (\d+);/.exec(background)?.[1]);
  if (!Number.isSafeInteger(recorderVersion) || recorderVersion < 84 || recorderVersion !== backgroundVersion)
    missing.push('matched recorder/background revision 84 or later');
  if (missing.length) throw new Error(`Required personal native auto-approval feature is incomplete: ${missing.join(', ')}. Refusing to package a detection-only or mixed companion.`);
  assertPromptEnvelopeFeature(extensionRoot);
  if (referenceRoot) for (const name of names) {
    if (sha256File(path.join(extensionRoot, name)) !== sha256File(path.join(referenceRoot, name)))
      throw new Error(`Packaged native approval companion differs from reviewed source: ${name}`);
  }
  return { recorderVersion };
}

/** Prevent a private update from silently dropping the mandatory native Send guard. */
export function assertPromptEnvelopeFeature(extensionRoot) {
  const dom = readFileSync(path.join(extensionRoot, 'chatgpt-dom.js'), 'utf8');
  const content = readFileSync(path.join(extensionRoot, 'content.js'), 'utf8');
  const popup = readFileSync(path.join(extensionRoot, 'popup.js'), 'utf8');
  const popupHtml = readFileSync(path.join(extensionRoot, 'popup.html'), 'utf8');
  if (!dom.includes('function promptEnvelopeValid(value)') || !dom.includes('function preparePromptEnvelope(value)') ||
      !dom.includes("const OPERATOR_PROMPT_FOOTER = 'IGNORE THE FIRST SENTENCE ABOVE.';") ||
      !dom.includes("const OPERATOR_PROMPT_HEADER_PREFIX = '[[COS_OPERATOR_QUESTIONS:';") ||
      !dom.includes('const OPERATOR_PROMPT_MAX_QUESTIONS = 2;') ||
      !dom.includes('questionCount > OPERATOR_PROMPT_MAX_QUESTIONS') ||
      !dom.includes('const prepared = `${operatorPromptHeader(1)}\\n${value}\\n${OPERATOR_PROMPT_FOOTER}`;') ||
      /\brequirePromptEnvelope\b/.test(dom + content) ||
      !dom.includes("if (!promptEnvelopeValid(submitted))") ||
      !dom.includes('return promptEnvelopeValid(actual) &&') ||
      !dom.includes('function promptEnvelopeReady()') || !dom.includes('function promptEnvelopeProtocol()') ||
      !content.includes('CLF_DOM.promptEnvelopeProtocol() === 2') || !content.includes('!requiredFeatures().promptEnvelope') ||
      !content.includes('requiredFeatures: requiredFeatures()') ||
      !content.includes("typeof CLF_DOM.promptEnvelopeValid !== 'function'") ||
      !popup.includes("['prompt', 'promptEnvelope']") || !popup.includes("['approval', 'nativeAllowOnce']") ||
      !popupHtml.includes('id="r-prompt"') || !popupHtml.includes('id="r-approval"'))
    throw new Error('Required prompt envelope feature is incomplete. Refusing a personal build without its bounded task-question header and native Send guard.');
}

function assertPackagedNativeApproval(repoRoot, platform, arch) {
  const prefix = PLATFORM_INFO[platform].unpackedPrefix;
  const directories = platform === 'darwin'
    ? (arch === 'x64' ? ['mac', 'mac-x64'] : ['mac-arm64'])
    : [...(arch === 'x64' ? [`${prefix}-unpacked`] : []), `${prefix}-${arch}-unpacked`];
  const candidates = directories.map(directory => path.join(repoRoot, 'release', directory,
    ...(platform === 'darwin' ? ['Chat On Steroids.app', 'Contents', 'Resources'] : ['resources']), 'extension'))
    .filter(directory => existsSync(directory));
  if (candidates.length !== 1) throw new Error(`Expected one ${platform}-${arch} packaged companion; found ${candidates.length}. Refusing uncertain native approval packaging.`);
  return assertNativeApprovalFeature(candidates[0], path.join(repoRoot, 'extension'));
}

function gitEnvironment(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key)) delete env[key];
  }
  return env;
}

function gitText(repoRoot, gitArgs) {
  return runText('git', ['--no-replace-objects', '-C', repoRoot, ...gitArgs], { env: gitEnvironment() });
}

function gitTryText(repoRoot, gitArgs) {
  const result = spawnSync('git', ['--no-replace-objects', '-C', repoRoot, ...gitArgs], {
    encoding: 'utf8', env: gitEnvironment(), windowsHide: true
  });
  if (result.error) throw result.error;
  return { status: result.status, text: String(result.stdout ?? '').trim(), error: String(result.stderr ?? '').trim() };
}

function assertObjectId(value, objectFormat, label) {
  const length = objectFormat === 'sha1' ? 40 : objectFormat === 'sha256' ? 64 : 0;
  if (!length) throw new Error(`Unsupported Git object format '${objectFormat}'`);
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new Error(`Git ${label} is not a ${objectFormat} object id: ${value}`);
  }
}

export function readGitSourceIdentity(repoRoot = root) {
  const topLevel = realpathSync(path.resolve(gitText(repoRoot, ['rev-parse', '--show-toplevel'])));
  const expectedRoot = realpathSync(path.resolve(repoRoot));
  const sameRoot = process.platform === 'win32'
    ? topLevel.toLowerCase() === expectedRoot.toLowerCase()
    : topLevel === expectedRoot;
  if (!sameRoot) throw new Error(`Git repository root mismatch: expected ${expectedRoot}, got ${topLevel}`);
  const objectFormat = gitText(repoRoot, ['rev-parse', '--show-object-format=storage']);
  const commit = gitText(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase();
  const tree = gitText(repoRoot, ['rev-parse', '--verify', 'HEAD^{tree}']).toLowerCase();
  assertObjectId(commit, objectFormat, 'commit');
  assertObjectId(tree, objectFormat, 'tree');
  const status = gitText(repoRoot, ['status', '--porcelain=v2', '--untracked-files=all', '--ignore-submodules=none']);
  const ignored = gitText(repoRoot, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '--', ...IGNORED_SOURCE_INPUTS
  ]);
  return { objectFormat, commit, tree, dirty: status.length > 0 || ignored.length > 0 };
}

export function strictEnvironment(base = process.env, extras = {}) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (
      /^GIT_/i.test(key) || /^npm_config_/i.test(key) || /^NPM_CONFIG_/i.test(key) || /^npm_package_config_/i.test(key) ||
      /^ELECTRON_/i.test(key) || /^electron_/i.test(key) ||
      /^(?:NODE_OPTIONS|NODE_PATH|NODE_ENV|ESBUILD_BINARY_PATH|force_no_cache|COS_PACKAGE_CACHE_ROOT|COS_PACKAGE_TAR|COS_STRICT_BUILD)$/i.test(key) ||
      /^VITE_/i.test(key) ||
      /^(?:BUILD_NUMBER|TRAVIS_BUILD_NUMBER|APPVEYOR_BUILD_NUMBER|CIRCLE_BUILD_NUM|BUILD_BUILDNUMBER|CI_PIPELINE_IID|CI_BUILD_NUMBER)$/i.test(key) ||
      /^(?:CSC_|WIN_CSC_|SIGNTOOL|WINDOWS_SIGNTOOL|USE_SYSTEM_SIGNCODE|USE_SYSTEM_OSSLSIGNCODE)/i.test(key)
    ) delete env[key];
  }
  env.NO_UPDATE_NOTIFIER = '1';
  env.ELECTRON_BUILDER_OFFLINE = 'true';
  env.ELECTRON_BUILDER_DISABLE_BUILD_CACHE = 'true';
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  return { ...env, ...extras };
}

function resolveExecutable(command) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const lines = runText(locator, [command]).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error(`Required build host tool is missing: ${command}`);
  return path.resolve(lines[0]);
}

function hostToolIdentity() {
  const git = resolveExecutable(process.platform === 'win32' ? 'git.exe' : 'git');
  const tar = resolveExecutable(process.platform === 'win32' ? 'tar.exe' : 'tar');
  const shell = resolveExecutable(process.platform === 'win32' ? 'cmd.exe' : 'sh');
  let shellVersion = `${process.platform}-shell`;
  try {
    shellVersion = process.platform === 'win32'
      ? runText(shell, ['/d', '/c', 'ver'])
      : runText(shell, ['--version']).split(/\r?\n/)[0];
  } catch {}
  return {
    git: { version: runText(git, ['--version']), executableSha256: sha256File(git) },
    tar: { version: runText(tar, ['--version']).split(/\r?\n/)[0], executableSha256: sha256File(tar) },
    shell: { version: shellVersion, executableSha256: sha256File(shell) },
    paths: { git, tar, shell }
  };
}

export function resolveNpmCli(nodeExecutable = process.execPath) {
  const nodeDirectory = path.dirname(nodeExecutable);
  const candidates = [
    path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  const candidate = candidates.find(value => existsSync(value));
  if (!candidate) {
    throw new Error(`Strict build requires npm CLI from the same Node distribution: ${candidates.join(', ')}`);
  }
  return candidate;
}

function npmToolIdentity(npmCli) {
  const npmRoot = path.resolve(path.dirname(npmCli), '..', '..');
  const commandShim = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (!existsSync(commandShim)) throw new Error(`Strict build requires the npm command shim adjacent to Node: ${commandShim}`);
  const tree = fingerprintDirectory(npmRoot);
  return {
    version: runText(process.execPath, [npmCli, '--version'], { env: strictEnvironment() }),
    cliSha256: sha256File(npmCli),
    commandShimSha256: sha256File(commandShim),
    packageFileCount: tree.fileCount,
    packageTotalBytes: tree.totalBytes,
    packageTreeSha256: tree.treeSha256
  };
}

function packageFile(repoRoot, relative) {
  const file = path.join(repoRoot, relative);
  if (!existsSync(file)) throw new Error(`Required build input is missing: ${file}`);
  return file;
}

function packageJsonAt(repoRoot, name) {
  const file = packageFile(repoRoot, path.join('node_modules', name, 'package.json'));
  return { file, json: JSON.parse(readFileSync(file, 'utf8')) };
}

function writeWindowsUpdateMetadata(repoRoot, arch) {
  const release = path.join(repoRoot, 'release');
  const installerName = `Chat-On-Steroids-Setup-${arch}.exe`;
  const installer = packageFile(repoRoot, path.join('release', installerName));
  const size = lstatSync(installer).size;
  const sha512 = sha512Base64File(installer);
  const packageJson = JSON.parse(readFileSync(packageFile(repoRoot, 'package.json'), 'utf8'));
  const version = String(packageJson.version ?? '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Package version is not strict semver: ${version}`);
  const committedAt = gitText(repoRoot, ['show', '-s', '--format=%cI', 'HEAD']);
  const releaseDate = new Date(committedAt);
  if (!Number.isFinite(releaseDate.getTime())) throw new Error(`Git commit date is invalid: ${committedAt}`);
  const lines = [
    `version: ${version}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${installerName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate.toISOString()}'`
  ];
  writeFileSync(path.join(release, 'latest.yml'), `${lines.join('\n')}\n`, 'utf8');
}

function readBuildToolIdentity(repoRoot, name, entryRelative) {
  const { file: packageFilePath, json } = packageJsonAt(repoRoot, name);
  const entry = packageFile(repoRoot, path.join('node_modules', name, entryRelative));
  return {
    version: String(json.version),
    packageJsonSha256: sha256File(packageFilePath),
    entrySha256: sha256File(entry)
  };
}

function normalizeRelative(file) {
  return file.split(path.sep).join('/');
}

export function fingerprintDirectory(directory) {
  const rootDir = path.resolve(directory);
  const records = [];
  let fileCount = 0;
  let totalBytes = 0;
  function walk(current) {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelative(path.relative(rootDir, absolute));
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute);
      } else if (stat.isFile()) {
        const digest = sha256File(absolute);
        records.push(`F\0${relative}\0${stat.size}\0${digest}\n`);
        fileCount += 1;
        totalBytes += stat.size;
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        records.push(`L\0${relative}\0${target}\n`);
        fileCount += 1;
        totalBytes += Buffer.byteLength(target);
      } else {
        throw new Error(`Unsupported dependency-tree entry type: ${absolute}`);
      }
    }
  }
  walk(rootDir);
  return { fileCount, totalBytes, treeSha256: sha256Bytes(records.join('')) };
}

function assertFingerprintEqual(expected, actual, context) {
  if (
    expected.fileCount !== actual.fileCount || expected.totalBytes !== actual.totalBytes ||
    expected.treeSha256 !== actual.treeSha256
  ) {
    throw new Error(
      `${context} dependency tree changed. Expected ${expected.fileCount}/${expected.totalBytes}/${expected.treeSha256}, ` +
      `found ${actual.fileCount}/${actual.totalBytes}/${actual.treeSha256}`
    );
  }
}

function electronCacheRoot() {
  if (process.platform === 'win32') {
    if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is missing; cannot locate the offline Electron cache.');
    return path.join(process.env.LOCALAPPDATA, 'electron', 'Cache');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'electron');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron');
}

function findCachedFile(cacheRoot, fileName) {
  if (!existsSync(cacheRoot)) return null;
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(cacheRoot, entry.name, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function builderCacheRoot() {
  if (process.platform === 'win32') {
    if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is missing; cannot locate electron-builder cache.');
    return path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'electron-builder');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron-builder');
}

function assertPathInside(rootDir, candidate, label) {
  const base = path.resolve(rootDir);
  const resolved = path.resolve(candidate);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the owned strict cache: ${resolved}`);
  }
  return resolved;
}

async function materializeBuilderToolsetsOffline(repoRoot, platform, arch, ownedCache, toolsetEnv) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`Strict builder-toolset attestation is currently defined only for win32-x64, got ${platform}-${arch}.`);
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`Strict win32-x64 builder-toolset materialization requires a win32-x64 Node host, got ${process.platform}-${process.arch}.`);
  }
  rmSync(ownedCache, { recursive: true, force: true });
  mkdirSync(ownedCache, { recursive: true });
  const sourceCache = builderCacheRoot();
  for (const spec of Object.values(WINDOWS_X64_BUILDER_TOOLSETS)) {
    const source = findCachedFile(sourceCache, spec.archive);
    if (!source) throw new Error(`Strict offline build requires cached electron-builder toolset ${spec.archive}; no network fallback is allowed.`);
    const actual = sha256File(source);
    if (actual !== spec.sha256) throw new Error(`Cached builder toolset ${spec.archive} checksum mismatch. Expected ${spec.sha256}, found ${actual}.`);
    const destinationDir = path.join(ownedCache, spec.release);
    mkdirSync(destinationDir, { recursive: true });
    copyFileSync(source, path.join(destinationDir, spec.archive));
  }

  const savedProcessEnv = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, toolsetEnv);
  try {
    const seven = await import(pathToFileURL(path.join(repoRoot, 'node_modules', 'app-builder-lib', 'out', 'toolsets', '7zip.js')).href);
    const windows = await import(pathToFileURL(path.join(repoRoot, 'node_modules', 'app-builder-lib', 'out', 'toolsets', 'windows.js')).href);
    const sevenExe = await seven.getPath7za();
    const nsisInfo = await windows.getMakeNsisPath(null, null);
    const plugins = await windows.getNsisPluginsPath(null, null);
    const sevenRoot = assertPathInside(ownedCache, path.dirname(path.dirname(sevenExe)), '7-Zip toolset');
    const nsisRoot = assertPathInside(ownedCache, nsisInfo.env?.NSISDIR || path.dirname(path.dirname(nsisInfo.path)), 'NSIS toolset');
    const resourcesRoot = assertPathInside(ownedCache, path.dirname(plugins), 'NSIS resources toolset');
    const sevenExecutable = assertPathInside(sevenRoot, sevenExe, '7-Zip executable');
    const nsisExecutable = assertPathInside(nsisRoot, nsisInfo.path, 'NSIS executable');
    const identities = {
      sevenZip: {
        archiveSha256: WINDOWS_X64_BUILDER_TOOLSETS.sevenZip.sha256,
        ...fingerprintDirectory(sevenRoot),
        executableSha256: sha256File(sevenExecutable)
      },
      nsis: {
        archiveSha256: WINDOWS_X64_BUILDER_TOOLSETS.nsis.sha256,
        ...fingerprintDirectory(nsisRoot),
        executableSha256: sha256File(nsisExecutable)
      },
      nsisResources: {
        archiveSha256: WINDOWS_X64_BUILDER_TOOLSETS.nsisResources.sha256,
        ...fingerprintDirectory(resourcesRoot)
      }
    };
    return {
      identities,
      paths: {
        sevenZip: { root: sevenRoot, executable: sevenExecutable, archive: path.join(ownedCache, WINDOWS_X64_BUILDER_TOOLSETS.sevenZip.release, WINDOWS_X64_BUILDER_TOOLSETS.sevenZip.archive) },
        nsis: { root: nsisRoot, executable: nsisExecutable, archive: path.join(ownedCache, WINDOWS_X64_BUILDER_TOOLSETS.nsis.release, WINDOWS_X64_BUILDER_TOOLSETS.nsis.archive) },
        nsisResources: { root: resourcesRoot, archive: path.join(ownedCache, WINDOWS_X64_BUILDER_TOOLSETS.nsisResources.release, WINDOWS_X64_BUILDER_TOOLSETS.nsisResources.archive) }
      }
    };
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedProcessEnv);
  }
}

function assertBuilderToolsetsUnchanged(expected, paths, context) {
  const actual = {
    sevenZip: {
      archiveSha256: sha256File(paths.sevenZip.archive),
      ...fingerprintDirectory(paths.sevenZip.root),
      executableSha256: sha256File(paths.sevenZip.executable)
    },
    nsis: {
      archiveSha256: sha256File(paths.nsis.archive),
      ...fingerprintDirectory(paths.nsis.root),
      executableSha256: sha256File(paths.nsis.executable)
    },
    nsisResources: {
      archiveSha256: sha256File(paths.nsisResources.archive),
      ...fingerprintDirectory(paths.nsisResources.root)
    }
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${context} electron-builder toolset identities changed after attestation.`);
  }
}

async function materializeElectronRuntimeOffline(repoRoot, platform, arch) {
  const electronRoot = path.join(repoRoot, 'node_modules', 'electron');
  const pkg = JSON.parse(readFileSync(packageFile(repoRoot, path.join('node_modules', 'electron', 'package.json')), 'utf8'));
  const checksums = JSON.parse(readFileSync(packageFile(repoRoot, path.join('node_modules', 'electron', 'checksums.json')), 'utf8'));
  const archiveName = `electron-v${pkg.version}-${platform}-${arch}.zip`;
  const expected = checksums[archiveName];
  if (!/^[0-9a-f]{64}$/.test(String(expected ?? ''))) {
    throw new Error(`Electron ${pkg.version} has no pinned checksum for ${archiveName}`);
  }
  const archive = findCachedFile(electronCacheRoot(), archiveName);
  if (!archive) {
    throw new Error(`Strict offline build requires cached ${archiveName}; no network fallback is allowed.`);
  }
  const actual = sha256File(archive);
  if (actual !== expected) throw new Error(`Cached ${archiveName} checksum mismatch. Expected ${expected}, found ${actual}.`);
  const dist = path.join(electronRoot, 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const extractor = path.join(repoRoot, 'node_modules', '@electron-internal', 'extract-zip', 'index.js');
  // extract-zip loads a native .node module. Windows holds that DLL open for the life of the
  // importing process, so importing it here made the disposable attestation tree impossible to
  // remove. Keep native extraction in a short-lived child; successful child exit is the boundary
  // after which the parent can verify the runtime and delete the exact temporary tree.
  const extractScript = [
    "import { pathToFileURL } from 'node:url';",
    'const [extractor, archive, dist] = process.argv.slice(1);',
    'const { extract } = await import(pathToFileURL(extractor).href);',
    'await extract(archive, { dir: dist });'
  ].join('\n');
  run(process.execPath, ['--input-type=module', '-e', extractScript, extractor, archive, dist], {
    cwd: repoRoot,
    env: strictEnvironment(),
    stdio: 'pipe',
    encoding: 'utf8'
  });
  const executable = platform === 'win32' ? 'electron.exe' : platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  writeFileSync(path.join(electronRoot, 'path.txt'), executable, 'utf8');
  const executablePath = packageFile(repoRoot, path.join('node_modules', 'electron', 'dist', executable));
  return { archiveName, archiveSha256: actual, runtimeSha256: sha256File(executablePath) };
}

function strictSnapshotInfo(repoRoot) {
  const branch = gitTryText(repoRoot, ['symbolic-ref', '-q', 'HEAD']);
  if (branch.status === 0) throw new Error(`Strict packaging requires detached HEAD, found ${branch.text}`);
  const originText = gitText(repoRoot, ['config', '--get', 'remote.origin.url']);
  const origin = path.resolve(repoRoot, originText);
  if (!path.isAbsolute(origin) || !existsSync(origin) || origin.toLowerCase() === path.resolve(repoRoot).toLowerCase()) {
    throw new Error('Strict packaging requires a detached disposable local clone whose origin is a separate local repository.');
  }
  const gitlinks = gitText(repoRoot, ['ls-tree', '-r', 'HEAD']).split(/\r?\n/).filter((line) => /^160000\s+commit\s/.test(line));
  if (gitlinks.length) throw new Error(`Strict packaging does not support unmaterialized Git submodules: ${gitlinks.join('; ')}`);
  const source = readGitSourceIdentity(repoRoot);
  if (source.dirty) throw new Error('Strict packaging requires a clean immutable source snapshot before dependency materialization.');
  return { source, commonRoot: origin };
}

function strictSharedCache(commonRoot) {
  return path.join(commonRoot, 'node_modules', '.cache');
}

function readLockfile(repoRoot) {
  const file = packageFile(repoRoot, 'package-lock.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (!Number.isInteger(json.lockfileVersion)) throw new Error('package-lock.json has no integer lockfileVersion.');
  return { file, json };
}

function assertToolMatchesLock(lock, name, actualVersion) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.version || entry.version !== actualVersion || !entry.integrity) {
    throw new Error(`Installed ${name}@${actualVersion} does not match complete package-lock metadata.`);
  }
}

function currentToolchain(repoRoot, npmCli, electronRuntime, hostTools, builderToolsets) {
  const tools = {};
  const { json: lock } = readLockfile(repoRoot);
  for (const [name, entry] of BUILD_TOOLS) {
    tools[name] = readBuildToolIdentity(repoRoot, name, entry);
    assertToolMatchesLock(lock, name, tools[name].version);
  }
  tools.electron.runtimeSha256 = electronRuntime.runtimeSha256;
  tools.electron.archiveSha256 = electronRuntime.archiveSha256;
  return {
    node: { version: process.version, executableSha256: sha256File(process.execPath) },
    npm: npmToolIdentity(npmCli),
    tools,
    hostTools: {
      git: hostTools.git,
      tar: hostTools.tar,
      shell: hostTools.shell
    },
    builderToolsets
  };
}

export function toolchainDigest(toolchain) {
  return sha256Bytes(`${JSON.stringify(toolchain)}\n`);
}

function canonicalRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value);
  if (actual.join(',') !== expected.join(',')) throw new Error(`${label} keys/order are not canonical.`);
}

function assertSha256(value, label) {
  if (!/^[0-9a-f]{64}$/.test(String(value ?? ''))) throw new Error(`${label} is malformed.`);
}

export function validateSourceProvenanceShape(record) {
  if (!record || record.schema !== SOURCE_PROVENANCE_SCHEMA) throw new Error(`Expected source provenance schema ${SOURCE_PROVENANCE_SCHEMA}.`);
  const expectedKeys = [
    'schema', 'objectFormat', 'commit', 'tree', 'dirty', 'strictBuild', 'packageJsonSha256', 'packageLockSha256',
    'lockfileVersion', 'dependencies', 'node', 'npm', 'tools', 'hostTools', 'builderToolsets', 'toolchainSha256'
  ];
  if (Object.keys(record).join(',') !== expectedKeys.join(',')) throw new Error('Source provenance schema-2 keys/order are not canonical.');
  assertObjectId(record.commit, record.objectFormat, 'commit');
  assertObjectId(record.tree, record.objectFormat, 'tree');
  if (typeof record.dirty !== 'boolean' || typeof record.strictBuild !== 'boolean') throw new Error('Source provenance booleans are malformed.');
  for (const key of ['packageJsonSha256', 'packageLockSha256', 'toolchainSha256']) {
    assertSha256(record[key], `Source provenance ${key}`);
  }
  if (!Number.isInteger(record.lockfileVersion)) throw new Error('Source provenance lockfileVersion is malformed.');
  if (record.strictBuild) {
    if (!record.dependencies || !Number.isInteger(record.dependencies.fileCount) || !Number.isInteger(record.dependencies.totalBytes) ||
        !/^[0-9a-f]{64}$/.test(String(record.dependencies.treeSha256 ?? ''))) {
      throw new Error('Strict source provenance dependency fingerprint is malformed.');
    }
  } else if (record.dependencies !== null) {
    throw new Error('Non-strict source provenance must not claim a sealed dependency tree.');
  }
  assertExactKeys(record.node, ['version', 'executableSha256'], 'Source provenance Node identity');
  if (typeof record.node.version !== 'string' || !record.node.version) throw new Error('Source provenance Node version is malformed.');
  assertSha256(record.node.executableSha256, 'Source provenance Node executableSha256');
  assertExactKeys(record.npm, ['version', 'cliSha256', 'commandShimSha256', 'packageFileCount', 'packageTotalBytes', 'packageTreeSha256'], 'Source provenance npm identity');
  if (typeof record.npm.version !== 'string' || !record.npm.version) throw new Error('Source provenance npm version is malformed.');
  assertSha256(record.npm.cliSha256, 'Source provenance npm cliSha256');
  assertSha256(record.npm.commandShimSha256, 'Source provenance npm commandShimSha256');
  if (!Number.isInteger(record.npm.packageFileCount) || record.npm.packageFileCount < 1 ||
      !Number.isInteger(record.npm.packageTotalBytes) || record.npm.packageTotalBytes < 1) {
    throw new Error('Source provenance npm package-tree counts are malformed.');
  }
  assertSha256(record.npm.packageTreeSha256, 'Source provenance npm packageTreeSha256');
  assertExactKeys(record.tools, BUILD_TOOLS.map(([name]) => name), 'Source provenance build tools');
  for (const [name] of BUILD_TOOLS) {
    const keys = name === 'electron'
      ? ['version', 'packageJsonSha256', 'entrySha256', 'runtimeSha256', 'archiveSha256']
      : ['version', 'packageJsonSha256', 'entrySha256'];
    const tool = record.tools[name];
    assertExactKeys(tool, keys, `Source provenance tool '${name}'`);
    if (typeof tool.version !== 'string' || !tool.version) throw new Error(`Source provenance tool '${name}' version is malformed.`);
    for (const key of keys.filter((item) => item.endsWith('Sha256'))) assertSha256(tool[key], `Source provenance tool '${name}' ${key}`);
  }
  assertExactKeys(record.hostTools, ['git', 'tar', 'shell'], 'Source provenance host tools');
  for (const hostName of ['git', 'tar', 'shell']) {
    const hostTool = record.hostTools[hostName];
    assertExactKeys(hostTool, ['version', 'executableSha256'], `Source provenance host tool '${hostName}'`);
    if (typeof hostTool.version !== 'string' || !hostTool.version) throw new Error(`Source provenance host tool '${hostName}' version is malformed.`);
    assertSha256(hostTool.executableSha256, `Source provenance host tool '${hostName}' executableSha256`);
  }
  if (record.strictBuild) {
    assertExactKeys(record.builderToolsets, ['sevenZip', 'nsis', 'nsisResources'], 'Source provenance builder toolsets');
    for (const toolsetName of ['sevenZip', 'nsis', 'nsisResources']) {
      const toolset = record.builderToolsets?.[toolsetName];
      const keys = toolsetName === 'nsisResources'
        ? ['archiveSha256', 'fileCount', 'totalBytes', 'treeSha256']
        : ['archiveSha256', 'fileCount', 'totalBytes', 'treeSha256', 'executableSha256'];
      assertExactKeys(toolset, keys, `Source provenance builder toolset '${toolsetName}'`);
      if (!toolset || !/^[0-9a-f]{64}$/.test(String(toolset.archiveSha256 ?? '')) ||
          !Number.isInteger(toolset.fileCount) || toolset.fileCount < 0 ||
          !Number.isInteger(toolset.totalBytes) || toolset.totalBytes < 0 ||
          !/^[0-9a-f]{64}$/.test(String(toolset.treeSha256 ?? ''))) {
        throw new Error(`Source provenance builder toolset '${toolsetName}' identity is malformed.`);
      }
      if (toolsetName !== 'nsisResources') {
        assertSha256(toolset.executableSha256, `Source provenance builder toolset '${toolsetName}' executableSha256`);
      }
    }
  } else if (record.builderToolsets !== null) {
    throw new Error('Non-strict source provenance must not claim sealed builder toolsets.');
  }
  if (toolchainDigest({
    node: record.node,
    npm: record.npm,
    tools: record.tools,
    hostTools: record.hostTools,
    builderToolsets: record.builderToolsets
  }) !== record.toolchainSha256) {
    throw new Error('Source provenance toolchainSha256 does not match its embedded toolchain identities.');
  }
  return record;
}

function buildRecord(repoRoot, source, strictBuild, dependencyFingerprint, npmCli, electronRuntime, hostTools, builderToolsets) {
  const packageJsonPath = packageFile(repoRoot, 'package.json');
  const { file: packageLockPath, json: lock } = readLockfile(repoRoot);
  const toolchain = currentToolchain(repoRoot, npmCli, electronRuntime, hostTools, builderToolsets);
  const record = {
    schema: SOURCE_PROVENANCE_SCHEMA,
    objectFormat: source.objectFormat,
    commit: source.commit,
    tree: source.tree,
    dirty: source.dirty,
    strictBuild,
    packageJsonSha256: sha256File(packageJsonPath),
    packageLockSha256: sha256File(packageLockPath),
    lockfileVersion: lock.lockfileVersion,
    dependencies: strictBuild ? dependencyFingerprint : null,
    node: toolchain.node,
    npm: toolchain.npm,
    tools: toolchain.tools,
    hostTools: toolchain.hostTools,
    builderToolsets: toolchain.builderToolsets,
    toolchainSha256: toolchainDigest(toolchain)
  };
  return validateSourceProvenanceShape(record);
}

export function writePackageSourceProvenance(record, destination) {
  validateSourceProvenanceShape(record);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, canonicalRecord(record), 'utf8');
  return { provenance: record, destination };
}

export function readCanonicalSourceProvenance(file) {
  const raw = readFileSync(file, 'utf8');
  const record = validateSourceProvenanceShape(JSON.parse(raw));
  if (raw !== canonicalRecord(record)) throw new Error(`Source provenance JSON is not canonical: ${file}`);
  return record;
}

function npmCache(npmCli, env) {
  return runText(process.execPath, [npmCli, 'config', 'get', 'cache', '--location=user'], { env });
}

async function materializeStrictDependencies(repoRoot, platform, arch, commonRoot) {
  const npmCli = resolveNpmCli();
  const hostTools = hostToolIdentity();
  // npm 11 rejects one physical file being loaded as both user and global config. Keep two
  // separate empty, build-owned files so neither host config can influence the offline install.
  const emptyUserConfig = path.join(repoRoot, 'resources', 'packaging', '.strict-user-npmrc');
  const emptyGlobalConfig = path.join(repoRoot, 'resources', 'packaging', '.strict-global-npmrc');
  const ownedBuilderCache = path.join(repoRoot, 'resources', 'packaging', 'electron-builder-cache');
  mkdirSync(path.dirname(emptyUserConfig), { recursive: true });
  writeFileSync(emptyUserConfig, '', 'utf8');
  writeFileSync(emptyGlobalConfig, '', 'utf8');
  const windowsRoot = process.platform === 'win32'
    ? path.resolve(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows')
    : null;
  const powershellExecutable = windowsRoot
    ? path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : null;
  if (powershellExecutable && !existsSync(powershellExecutable)) {
    throw new Error(`Required Windows PowerShell host is missing: ${powershellExecutable}`);
  }
  const powershellDirectory = powershellExecutable ? path.dirname(powershellExecutable) : null;
  const controlledPath = process.platform === 'win32'
    ? [
        path.dirname(process.execPath),
        path.dirname(hostTools.paths.git),
        path.dirname(hostTools.paths.tar),
        path.dirname(hostTools.paths.shell),
        powershellDirectory
      ].filter(Boolean).join(path.delimiter)
    : [path.dirname(process.execPath), path.dirname(hostTools.paths.git), path.dirname(hostTools.paths.tar), '/usr/bin', '/bin'].join(path.delimiter);
  const baseEnv = strictEnvironment(process.env, {
    COS_STRICT_BUILD: '1',
    COS_PACKAGE_CACHE_ROOT: strictSharedCache(commonRoot),
    COS_PACKAGE_TAR: hostTools.paths.tar,
    ELECTRON_BUILDER_CACHE: ownedBuilderCache,
    PATH: controlledPath,
    ...(process.platform === 'win32' ? { ComSpec: hostTools.paths.shell } : {}),
    NPM_CONFIG_USERCONFIG: emptyUserConfig,
    npm_config_userconfig: emptyUserConfig,
    NPM_CONFIG_GLOBALCONFIG: emptyGlobalConfig,
    npm_config_globalconfig: emptyGlobalConfig,
    NPM_CONFIG_AUDIT: 'false', npm_config_audit: 'false',
    NPM_CONFIG_FUND: 'false', npm_config_fund: 'false'
  });
  const cache = npmCache(npmCli, baseEnv);
  run(process.execPath, [
    npmCli, 'ci', '--offline', '--no-audit', '--no-fund', '--include=dev', '--include=optional',
    '--ignore-scripts=false', `--cache=${cache}`, `--userconfig=${emptyUserConfig}`, `--globalconfig=${emptyGlobalConfig}`
  ], { cwd: repoRoot, env: baseEnv });
  const electronRuntime = await materializeElectronRuntimeOffline(repoRoot, platform, arch);
  const builderMaterialized = await materializeBuilderToolsetsOffline(repoRoot, platform, arch, ownedBuilderCache, baseEnv);
  const builderToolsets = builderMaterialized.identities;
  const fingerprint = fingerprintDirectory(path.join(repoRoot, 'node_modules'));
  return { npmCli, env: baseEnv, electronRuntime, fingerprint, hostTools, builderToolsets, builderToolsetPaths: builderMaterialized.paths };
}

export async function reproduceStrictDependencyFingerprint(reviewRoot, platform = process.platform, arch = process.arch) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'cos-build-attest-'));
  try {
    for (const name of ['package.json', 'package-lock.json']) {
      writeFileSync(path.join(temp, name), readFileSync(packageFile(reviewRoot, name)));
    }
    mkdirSync(path.join(temp, 'resources', 'packaging'), { recursive: true });
    const commonRoot = reviewRoot;
    const materialized = await materializeStrictDependencies(temp, platform, arch, commonRoot);
    return {
      fingerprint: materialized.fingerprint,
      electronRuntime: materialized.electronRuntime,
      toolchain: currentToolchain(
        temp,
        materialized.npmCli,
        materialized.electronRuntime,
        materialized.hostTools,
        materialized.builderToolsets
      )
    };
  } finally {
    removeStrictAttestationTemp(temp, platform);
  }
}

/** Remove an attestation tree only after transient Windows npm/native handles drain. */
function removeDirectoryTreeSerial(directory) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return;
    throw cause;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    unlinkSync(directory);
    return;
  }
  for (const name of readdirSync(directory)) removeDirectoryTreeSerial(path.join(directory, name));
  rmdirSync(directory);
}

export function removeStrictAttestationTemp(
  directory,
  platform = process.platform,
  {
    remove = rmSync,
    removeSerial = removeDirectoryTreeSerial,
    pause = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  } = {}
) {
  const retryable = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
  let serial = false;
  for (let attempt = 0; ; attempt++) {
    try {
      if (serial) removeSerial(directory);
      else remove(directory, { recursive: true, force: true });
      return;
    } catch (cause) {
      if (platform !== 'win32' || attempt >= 120 || !retryable.has(cause?.code)) throw cause;
      // Node's recursive Windows removal can return root-level EPERM even though serial
      // child-first removal succeeds. Switch strategies immediately; only a concrete locked
      // child then waits for Defender/indexers, at a constant bounded interval.
      if (serial) pause(250);
      serial = true;
    }
  }
}

export async function verifyBuildInputsAgainstReview(record, reviewRoot = root) {
  validateSourceProvenanceShape(record);
  if (!record.strictBuild) throw new Error('Qualification requires strictBuild=true.');
  if (record.dirty) throw new Error('Qualification rejects dirty source provenance.');
  const packageJsonSha256 = sha256File(packageFile(reviewRoot, 'package.json'));
  const packageLockSha256 = sha256File(packageFile(reviewRoot, 'package-lock.json'));
  const { json: lock } = readLockfile(reviewRoot);
  if (packageJsonSha256 !== record.packageJsonSha256 || packageLockSha256 !== record.packageLockSha256) {
    throw new Error('Embedded package.json/package-lock.json hashes do not match the reviewed source.');
  }
  if (lock.lockfileVersion !== record.lockfileVersion) throw new Error('Embedded lockfileVersion does not match the reviewed lockfile.');
  for (const [name] of BUILD_TOOLS) {
    const locked = lock.packages?.[`node_modules/${name}`];
    if (!locked?.version || record.tools?.[name]?.version !== locked.version || !locked.integrity) {
      throw new Error(`Embedded ${name} identity does not match package-lock.json.`);
    }
  }
  const npmCli = resolveNpmCli();
  const currentNode = { version: process.version, executableSha256: sha256File(process.execPath) };
  const currentNpm = npmToolIdentity(npmCli);
  if (JSON.stringify(currentNode) !== JSON.stringify(record.node) || JSON.stringify(currentNpm) !== JSON.stringify(record.npm)) {
    throw new Error('Embedded Node/npm tool identities do not match the qualification host.');
  }
  const reproduced = await reproduceStrictDependencyFingerprint(reviewRoot);
  assertFingerprintEqual(record.dependencies, reproduced.fingerprint, 'Qualification reproduction');
  if (toolchainDigest(reproduced.toolchain) !== record.toolchainSha256) {
    throw new Error('Embedded build-tool identities do not match the qualification host/materialized lockfile tree.');
  }
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const inspectRecord = value(args, 'inspect-provenance', null);
  if (inspectRecord) {
    const record = readCanonicalSourceProvenance(path.resolve(inspectRecord));
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }
  const verifyRecord = value(args, 'verify-build-inputs', null);
  if (verifyRecord) {
    const reviewRoot = path.resolve(value(args, 'review-root', root));
    const record = readCanonicalSourceProvenance(path.resolve(verifyRecord));
    await verifyBuildInputsAgainstReview(record, reviewRoot);
    process.stdout.write('build-input attestation verified\n');
    return;
  }

  const platform = normalizePlatform(value(args, 'platform', process.platform));
  const arches = value(args, 'arch', process.arch).split(',').map((item) => normalizeArch(item.trim()));
  const dirOnly = args.includes('--dir');
  const strict = args.includes('--strict');
  if (strict && arches.length !== 1) throw new Error('Strict packaging requires exactly one architecture per owned snapshot.');
  const personalBuild = existsSync(path.join(root, 'CUSTOM_BUILD'));
  if (personalBuild) {
    const feature = assertNativeApprovalFeature(path.join(root, 'extension'));
    process.stdout.write(`required personal native allow-once feature: recorder ${feature.recorderVersion}\n`);
  }
  const noticesPath = path.join(root, 'THIRD-PARTY-NOTICES.txt');
  // npm materializes only the current platform's optional packages. The installer must contain
  // notices for those exact packaged dependencies, but that derived host-specific projection may
  // not dirty the reviewed Git snapshot used to prove source provenance after packaging.
  const reviewedThirdPartyNotices = strict ? readFileSync(noticesPath) : null;

  let source;
  let npmCli = resolveNpmCli();
  let electronRuntime;
  let dependencyFingerprint = null;
  let hostTools = hostToolIdentity();
  let builderToolsets = null;
  let builderToolsetPaths = null;
  let childEnv = process.env;
  let commonRoot = root;

  if (strict) {
    const snapshot = strictSnapshotInfo(root);
    source = snapshot.source;
    commonRoot = snapshot.commonRoot;
    const materialized = await materializeStrictDependencies(root, platform, arches[0], commonRoot);
    npmCli = materialized.npmCli;
    childEnv = materialized.env;
    electronRuntime = materialized.electronRuntime;
    dependencyFingerprint = materialized.fingerprint;
    hostTools = materialized.hostTools;
    builderToolsets = materialized.builderToolsets;
    builderToolsetPaths = materialized.builderToolsetPaths;
  } else {
    source = readGitSourceIdentity(root);
    run(process.execPath, ['-e', "require('electron')"], { cwd: root });
    const electronExe = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
    electronRuntime = {
      archiveSha256: '0'.repeat(64),
      runtimeSha256: sha256File(packageFile(root, path.join('node_modules', 'electron', 'dist', electronExe)))
    };
  }

  run(process.execPath, ['scripts/generate-third-party-notices.mjs'], { cwd: root, env: childEnv });
  run(process.execPath, ['scripts/make-icon.mjs'], { cwd: root, env: childEnv });

  if (strict) {
    assertFingerprintEqual(dependencyFingerprint, fingerprintDirectory(path.join(root, 'node_modules')), 'Post-generator');
  }

  for (const arch of arches) {
    const targetArgs = ['--platform', platform, '--arch', arch];
    run(process.execPath, ['scripts/fetch-tunnel-client.mjs', ...targetArgs], { cwd: root, env: childEnv });
    run(process.execPath, ['scripts/fetch-ripgrep.mjs', ...targetArgs], { cwd: root, env: childEnv });
    run(process.execPath, ['scripts/prepare-packaging-native.mjs', ...targetArgs], { cwd: root, env: childEnv });
    run(process.execPath, ['scripts/prepare-macos-desktop-helper.mjs', ...targetArgs], { cwd: root, env: childEnv });
    if (strict) {
      assertFingerprintEqual(dependencyFingerprint, fingerprintDirectory(path.join(root, 'node_modules')), `${platform}-${arch} staging`);
    }
  }

  const record = buildRecord(
    root,
    source,
    strict,
    dependencyFingerprint,
    npmCli,
    electronRuntime,
    hostTools,
    builderToolsets
  );
  writePackageSourceProvenance(record, path.join(root, SOURCE_PROVENANCE_RELATIVE));
  process.stdout.write(
    `source/build provenance: commit=${record.commit} tree=${record.tree} strict=${record.strictBuild} ` +
    `lock=${record.packageLockSha256} deps=${record.dependencies?.treeSha256 ?? 'unsealed'}\n`
  );

  run(process.execPath, [path.join('node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], { cwd: root, env: childEnv });
  if (strict) assertFingerprintEqual(dependencyFingerprint, fingerprintDirectory(path.join(root, 'node_modules')), 'electron-vite build');

  for (const arch of arches) {
    const builderArgs = [
      path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
      PLATFORM_INFO[platform].builderFlag,
      `--${arch}`,
      '--publish',
      'never'
    ];
    if (strict) {
      assertBuilderToolsetsUnchanged(builderToolsets, builderToolsetPaths, `${platform}-${arch} pre-builder`);
      builderArgs.push(`--config.electronDist=${path.join(root, 'node_modules', 'electron', 'dist')}`);
    }
    if (dirOnly) builderArgs.push('--dir');
    run(process.execPath, builderArgs, { cwd: root, env: { ...childEnv, COS_PACKAGE_ARCH: arch } });
    if (personalBuild) assertPackagedNativeApproval(root, platform, arch);
    if (platform === 'win32' && !dirOnly) writeWindowsUpdateMetadata(root, arch);
    if (strict) {
      assertFingerprintEqual(dependencyFingerprint, fingerprintDirectory(path.join(root, 'node_modules')), `${platform}-${arch} builder`);
      assertBuilderToolsetsUnchanged(builderToolsets, builderToolsetPaths, `${platform}-${arch} post-builder`);
    }
  }

  // The activation integration suite validates a real packaged candidate. A strict source
  // snapshot intentionally contains no ignored release/ directory, so run the complete gate only
  // after producing the candidate. Publication still happens later, in the activation owner, and
  // therefore remains impossible unless this gate succeeds.
  if (strict) {
    run(process.execPath, [npmCli, 'run', 'verify:ci'], { cwd: root, env: childEnv });
    // Vitest writes only its result cache here during a successful verification run. It is not a
    // locked dependency and must not become an undeclared build input or invalidate the sealed
    // dependency tree after the tests themselves have passed.
    rmSync(path.join(root, 'node_modules', '.vite', 'vitest'), { recursive: true, force: true });
    assertFingerprintEqual(dependencyFingerprint, fingerprintDirectory(path.join(root, 'node_modules')), 'Post-verification');
    for (const arch of arches) {
      assertBuilderToolsetsUnchanged(builderToolsets, builderToolsetPaths, `${platform}-${arch} post-verification`);
    }
    writeFileSync(noticesPath, reviewedThirdPartyNotices);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}

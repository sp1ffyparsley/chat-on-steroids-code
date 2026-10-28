import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The dev-fast launcher owns this command. A private preview or build is not a
// packaged/installed update. Keep installed-state mutation in the existing
// lifecycle and release owners instead of manufacturing a second installer.
const SCHEMA = 'cos_personal_local_update_v1';
const DIGEST = /^[0-9a-f]{64}$/i;
const GENERATION = /^chat42-private-out-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_RECEIPT = 1024 * 1024;
const MAX_FILES = 2048;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EXTENSION_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_VALIDATOR_SUPPORT_FILES = 512;
const MAX_VALIDATOR_SUPPORT_BYTES = 32 * 1024 * 1024;
const MAX_VALIDATOR_IMPLEMENTATION_FILES = 512;
const MAX_VALIDATOR_IMPLEMENTATION_BYTES = 64 * 1024 * 1024;
const MAX_VALIDATOR_IMPLEMENTATION_FILE_BYTES = 48 * 1024 * 1024;
const MAX_MAIN_OUTPUT_FILES = 128;
const MAX_MAIN_OUTPUT_BYTES = 48 * 1024 * 1024;
const MAX_GIT_CHANGE_BYTES = 256 * 1024;
const VALIDATION_RECEIPT_SCHEMA = 'cos_dev_validation_receipt_v1';
const MAX_VALIDATION_RECEIPT_BYTES = 16 * 1024;
const VALID_MODES = new Set(['renderer', 'main', 'companion']);
const TESTS_BY_MODE = Object.freeze({
  renderer: ['test/renderer-layout.test.ts', 'test/renderer-state.test.ts'],
  companion: ['test/extension.test.ts', 'test/content-script.test.ts'],
  main: ['test/dev-fast.test.ts']
});
const duration = (started, ended = process.hrtime.bigint()) => Number((ended - started) / 1000000n);
const notRun = reason => ({ status: 'not-run', durationMs: null, reason });
const exitCode = status => Number.isInteger(status) ? status : null;
const sha = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();

// Vitest executes with shared config, test helpers/fixtures and repository
// scripts in addition to the selected .test.ts files. Leaving those out of
// the existing validation cache key silently reuses a stale PASS after a
// runner or fixture change. Seal the bounded owned support roots as inputs;
// no claim is made that this proves node_modules or a transitive import graph.
function validatorSupportFingerprint(project) {
  const rows = [];
  let totalBytes = 0;
  const add = relative => {
    const file = path.join(project, ...relative.split('/'));
    let stat;
    try { stat = lstatSync(file); }
    catch { throw Error('local-update-validator-support-unverified'); }
    if (!stat.isFile() || stat.isSymbolicLink() ||
        stat.size > MAX_INPUT_BYTES ||
        rows.length >= MAX_VALIDATOR_SUPPORT_FILES)
      throw Error('local-update-validator-support-unverified');
    const bytes = readFileSync(file);
    totalBytes += bytes.length;
    if (bytes.length !== stat.size || totalBytes > MAX_VALIDATOR_SUPPORT_BYTES)
      throw Error('local-update-validator-support-unbounded');
    rows.push({ path: relative, size: bytes.length, sha256: sha(bytes) });
  };
  const walk = (relative, skipUnselectedTests) => {
    const folder = path.join(project, ...relative.split('/'));
    safeDirectory(folder);
    for (const name of readdirSync(folder).sort()) {
      const child = relative + '/' + name;
      const stat = lstatSync(path.join(folder, name));
      if (stat.isSymbolicLink())
        throw Error('local-update-validator-support-linked-entry');
      if (stat.isDirectory()) walk(child, skipUnselectedTests);
      else if (!skipUnselectedTests ||
          !/\.test\.[cm]?[jt]sx?$/i.test(name)) add(child);
    }
  };
  add('vitest.config.ts');
  walk('scripts', false);
  // Individual selected tests are sealed by inputFingerprint below. Exclude
  // other standalone suites so an unrelated UI lane need not invalidate an
  // otherwise unchanged renderer local-update validation receipt.
  walk('test', true);
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    schema: 'cos_dev_validator_support_v1',
    sha256: sha(Buffer.from(JSON.stringify(rows))),
    fileCount: rows.length, totalBytes,
    scope: 'repository-vitest-config-scripts-and-shared-test-support'
  };
}

// CLI entrypoints are often thin shims: TypeScript 7's bin/tsc launches a
// platform-specific native compiler, and Vitest's vitest.mjs imports dist/cli.js
// and its chunks. Hashing just the shims can wrongly reuse a PASS after the
// delegated compiler/test runner bytes changed with the same lockfile.
// Seal these finite local distributions; this is still not a complete
// node_modules/transitive-import or native ABI qualification (Root owns that).
function validatorImplementationFingerprint(project) {
  const rows = [];
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let totalBytes = 0;
  const add = relative => {
    const file = path.join(project, ...relative.split('/'));
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 0 ||
        stat.size > MAX_VALIDATOR_IMPLEMENTATION_FILE_BYTES ||
        rows.length >= MAX_VALIDATOR_IMPLEMENTATION_FILES ||
        totalBytes + stat.size > MAX_VALIDATOR_IMPLEMENTATION_BYTES)
      throw Error('local-update-validator-implementation-unverified');
    const actual = realpathSync.native(file);
    const expected = path.resolve(file);
    if (process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() :
      actual !== expected)
      throw Error('local-update-validator-implementation-unverified');
    const descriptor = openSync(file, 'r');
    let digest;
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs)
        throw Error('local-update-validator-implementation-changed');
      const hash = createHash('sha256');
      for (let offset = 0; offset < before.size;) {
        const count = readSync(descriptor, buffer, 0,
          Math.min(buffer.length, before.size - offset), offset);
        if (count <= 0) throw Error('local-update-validator-implementation-changed');
        hash.update(buffer.subarray(0, count));
        offset += count;
      }
      const after = fstatSync(descriptor);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw Error('local-update-validator-implementation-changed');
      digest = hash.digest('hex').toUpperCase();
    } finally { closeSync(descriptor); }
    const current = lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() ||
        current.size !== stat.size || current.mtimeMs !== stat.mtimeMs)
      throw Error('local-update-validator-implementation-changed');
    rows.push({ path: relative, size: stat.size, sha256: digest });
    totalBytes += stat.size;
  };
  const walk = relative => {
    const folder = path.join(project, ...relative.split('/'));
    safeDirectory(folder);
    for (const name of readdirSync(folder).sort()) {
      const child = `${relative}/${name}`;
      const entry = lstatSync(path.join(folder, name));
      if (entry.isSymbolicLink())
        throw Error('local-update-validator-implementation-linked-entry');
      if (entry.isDirectory()) walk(child);
      else add(child);
    }
  };
  const packageInfo = relative => {
    const file = path.join(project, ...relative.split('/'));
    if (!existsSync(file)) return null;
    add(relative);
    const bytes = readFileSync(file);
    if (bytes.length > MAX_INPUT_BYTES) throw Error('local-update-validator-implementation-unverified');
    return JSON.parse(bytes.toString('utf8'));
  };
  const tsPackage = packageInfo('node_modules/typescript/package.json');
  if (tsPackage) {
    if (tsPackage.name !== 'typescript')
      throw Error('local-update-validator-implementation-unverified');
    walk('node_modules/typescript/lib');
    const targetPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
    if (Object.hasOwn(tsPackage.optionalDependencies ?? {}, targetPackage)) {
      const target = `node_modules/${targetPackage}`;
      if (!packageInfo(`${target}/package.json`))
        throw Error('local-update-validator-implementation-unverified');
      walk(`${target}/lib`);
    }
  }
  const vitestPackage = packageInfo('node_modules/vitest/package.json');
  if (vitestPackage) {
    if (vitestPackage.name !== 'vitest' ||
        packageInfo('node_modules/vite/package.json')?.name !== 'vite')
      throw Error('local-update-validator-implementation-unverified');
    walk('node_modules/vitest/dist');
    walk('node_modules/vite/dist');
    walk('node_modules/@vitest');
  }
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { schema: 'cos_dev_validator_implementation_v1',
    sha256: sha(Buffer.from(JSON.stringify(rows))),
    fileCount: rows.length, totalBytes,
    scope: 'bounded-typescript-platform-and-vitest-vite-local-distributions' };
}

// Inherited validator settings can change TypeScript/Vitest behavior without
// changing source or executable bytes. Keep only digests of effective values:
// never expose paths, custom options or other environment contents in receipts.
// External Node hooks/module paths are not pinned by the finite support-file
// census, so still validate them each run instead of caching an unverifiable PASS.
function validatorRuntimeFingerprint() {
  const fingerprint = name => process.env[name] === undefined ? null :
    sha(Buffer.from(process.env[name], 'utf8'));
  const options = process.env.NODE_OPTIONS ?? '';
  // The short -r flag also accepts attached module names (-rmodule), not just
  // a following whitespace-separated path. Any such hook is unsealed here.
  const dynamicLoader = /--(?:require|import|loader|experimental-loader|env-file(?:-if-exists)?)(?:\b|=)|(?:^|[\s"'])-r/.test(options);
  const externalNodePath = Boolean(process.env.NODE_PATH);
  return { schema: 'cos_dev_validator_runtime_v1',
    nodeOptions: fingerprint('NODE_OPTIONS'),
    ci: fingerprint('CI'), nodeEnv: fingerprint('NODE_ENV'),
    timeZone: fingerprint('TZ'), nodePath: fingerprint('NODE_PATH'),
    vitestMaxThreads: fingerprint('VITEST_MAX_THREADS'),
    vitestMinThreads: fingerprint('VITEST_MIN_THREADS'),
    cacheReuseSafe: !dynamicLoader && !externalNodePath,
    cacheBypassReason: dynamicLoader ? 'unsealed-inherited-node-loader' :
      externalNodePath ? 'unsealed-inherited-module-path' : null };
}

// Pin exact small build/validator inputs through all waits. The strict release
// pipeline remains the sole owner of a complete node_modules/native ABI seal.
// An installed lock match is useful risk evidence, never permission to
// hot-replace Main or assume that a binary .node module is ABI compatible.
function inputFingerprint(project, validatedMode = null) {
  const candidates = [
    ['packageJson', 'package.json'],
    ['packageLock', 'package-lock.json'],
    ['viteConfig', 'electron.vite.config.ts'],
    ['tsconfig', 'tsconfig.json'],
    ['launcherScript', 'scripts/dev-fast.mjs'],
    ['localUpdateScript', 'scripts/dev-fast-local-update.mjs'],
    ['previewScript', 'scripts/dev-fast-preview.mjs'],
    ['electronPackage', 'node_modules/electron/package.json'],
    ['electronVitePackage', 'node_modules/electron-vite/package.json'],
    ['typescriptCli', 'node_modules/typescript/bin/tsc'],
    ['vitestCli', 'node_modules/vitest/vitest.mjs']
  ];
  const selectedTests = validatedMode === null ? [] : TESTS_BY_MODE[validatedMode];
  if (!selectedTests) throw Error('local-update-validation-scope-unverified');
  for (const [index, name] of selectedTests.entries())
    candidates.push([`validatedTest${index}`, name]);
  const required = new Set(['packageJson', 'packageLock', 'viteConfig', 'tsconfig',
    'launcherScript', 'localUpdateScript', 'previewScript',
    ...selectedTests.map((_, index) => `validatedTest${index}`)]);
  const hashes = {};
  for (const [key, name] of candidates) {
    const file = path.join(project, ...name.split('/'));
    if (!existsSync(file)) {
      if (required.has(key))
        throw Error('local-update-build-input-missing');
      hashes[key] = null;
      continue;
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES)
      throw Error('local-update-build-input-unverified');
    hashes[key] = sha(readFileSync(file));
  }
  let installed = { status: 'not-observed' };
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const provenance = path.join(process.env.LOCALAPPDATA, 'Programs', 'Chat On Steroids',
      'resources', 'SOURCE_PROVENANCE.json');
    if (existsSync(provenance)) {
      try {
        const stat = lstatSync(provenance);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
          throw Error('unsafe-provenance');
        const bytes = readFileSync(provenance);
        const value = JSON.parse(bytes.toString('utf8'));
        if (value.schema !== 2 || value.strictBuild !== true || value.dirty !== false ||
            !DIGEST.test(value.packageJsonSha256 ?? '') ||
            !DIGEST.test(value.packageLockSha256 ?? '') ||
            !DIGEST.test(value.toolchainSha256 ?? ''))
          throw Error('untrusted-provenance');
        installed = { status: 'observed-strict-receipt', receiptSha256: sha(bytes),
          commit: typeof value.commit === 'string' ? value.commit : null,
          packageMatch: value.packageJsonSha256.toUpperCase() === hashes.packageJson,
          lockMatch: value.packageLockSha256.toUpperCase() === hashes.packageLock,
          toolchainSha256: value.toolchainSha256.toUpperCase() };
      } catch { installed = { status: 'unverified' }; }
    }
  }
  const validatorSupport = validatedMode === null ? null :
    validatorSupportFingerprint(project);
  const validatorImplementation = validatedMode === null ? null :
    validatorImplementationFingerprint(project);
  const identity = { schema: 'cos_dev_update_input_v1', hashes,
    validatedTestPaths: selectedTests, validatorSupport, validatorImplementation,
    validatorRuntime: validatedMode === null ? null : validatorRuntimeFingerprint(), node: {
    version: process.version, moduleAbi: process.versions.modules ?? null,
    napi: process.versions.napi ?? null, platform: process.platform, arch: process.arch
  } };
  return { ...identity, digest: sha(Buffer.from(JSON.stringify(identity))),
    installedBaseline: installed,
    nativeAbi: 'not-verified-by-local-source-workflow',
    dependencyTree: 'not-sealed-by-local-source-workflow',
    productionActivation: 'requires-root-strict-dependency-native-abi-and-lifecycle-qualification' };
}

function safeDirectory(dir) {
  const stat = lstatSync(dir);
  const actual = realpathSync.native(dir);
  const wanted = path.resolve(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform === 'win32' ? actual.toLowerCase() !== wanted.toLowerCase() :
        actual !== wanted))
    throw Error('local-update-directory-unverified');
}

// Read the actual bytes the existing private-generation owner has qualified.
// Never reference the historical shared out/ or make an unverified Main entry
// executable. This is a review handoff, not a second Main runtime/updater.
function mainOutputManifest(project, generation) {
  const output = path.join(project, '.test_tmp', generation.name, 'out');
  safeDirectory(output);
  const files = [];
  let totalBytes = 0;
  const walk = (directory, prefix) => {
    safeDirectory(directory);
    for (const name of readdirSync(directory).sort()) {
      const relative = `${prefix}/${name}`;
      const full = path.join(directory, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw Error('local-update-main-output-linked-entry');
      if (stat.isDirectory()) { walk(full, relative); continue; }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES ||
          files.length >= MAX_MAIN_OUTPUT_FILES ||
          (totalBytes += stat.size) > MAX_MAIN_OUTPUT_BYTES)
        throw Error('local-update-main-output-unbounded');
      const bytes = readFileSync(full);
      if (bytes.length !== stat.size) throw Error('local-update-main-output-changed-during-read');
      files.push({ relative, bytes: bytes.length, sha256: sha(bytes) });
    }
  };
  for (const scope of ['main', 'preload']) walk(path.join(output, scope), scope);
  if (!files.some(file => file.relative === 'main/index.js') ||
      !files.some(file => file.relative === 'preload/index.js'))
    throw Error('local-update-main-required-output-missing');
  const ordered = files.sort((a, b) => a.relative.localeCompare(b.relative));
  return { schema: 'cos_dev_main_output_manifest_v1',
    fileCount: ordered.length, totalBytes,
    manifestSha256: sha(Buffer.from(JSON.stringify(ordered))),
    files: ordered };
}

function validationReceiptPath(project, generation, inputDigest) {
  if (!DIGEST.test(inputDigest ?? '')) throw Error('local-update-validation-digest-unverified');
  return path.join(project, '.test_tmp', generation.name,
    'validation-' + inputDigest.toUpperCase() + '.json');
}

function readValidationReceipt(project, generation, inputDigest) {
  try {
    const file = validationReceiptPath(project, generation, inputDigest);
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_VALIDATION_RECEIPT_BYTES)
      return null;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value?.schema !== VALIDATION_RECEIPT_SCHEMA ||
        !VALID_MODES.has(value.mode) ||
        !DIGEST.test(value.sourceSha256 ?? '') ||
        !DIGEST.test(value.compilerSha256 ?? '') ||
        !DIGEST.test(value.inputDigest ?? '') ||
        !Array.isArray(value.validatedTestPaths) ||
        JSON.stringify(value.validatedTestPaths) !== JSON.stringify(TESTS_BY_MODE[value.mode]) ||
        !Array.isArray(value.checks) || value.checks.length !== 2)
      return null;
    const names = value.checks.map(item => item?.name);
    if (names[0] !== 'typescript' || names[1] !== 'focused-vitest') return null;
    if (value.checks.some(item =>
      item.status !== 'passed' || item.exitCode !== 0 ||
      (item.durationMs !== null &&
        (!Number.isSafeInteger(item.durationMs) || item.durationMs < 0))))
      return null;
    if (value.durationMs !== null &&
        (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0))
      return null;
    return value;
  } catch {
    return null;
  }
}

function validationCacheMatches(receipt, expected) {
  return receipt?.schema === VALIDATION_RECEIPT_SCHEMA &&
    receipt.mode === expected.mode &&
    receipt.sourceSha256 === expected.source &&
    receipt.compilerSha256 === expected.compiler &&
    receipt.inputDigest === expected.inputDigest &&
    JSON.stringify(receipt.validatedTestPaths) === JSON.stringify(TESTS_BY_MODE[expected.mode]) &&
    Array.isArray(receipt.checks) &&
    receipt.checks.length === 2 &&
    receipt.checks.every(item => item.status === 'passed' && item.exitCode === 0);
}

function writeValidationReceipt(project, generation, validation) {
  const folder = path.join(project, '.test_tmp', generation.name);
  try {
    safeDirectory(folder);
    const target = validationReceiptPath(project, generation, validation.inputDigest);
    const existing = readValidationReceipt(project, generation, validation.inputDigest);
    if (validationCacheMatches(existing, validation)) return existing;
    const payload = {
      schema: VALIDATION_RECEIPT_SCHEMA,
      mode: validation.mode,
      sourceSha256: validation.source,
      compilerSha256: validation.compiler,
      inputDigest: validation.inputDigest,
      validatedTestPaths: TESTS_BY_MODE[validation.mode],
      checks: validation.checks.map(item => ({
        name: item.name, status: item.status, exitCode: item.exitCode,
        durationMs: item.durationMs,
        diagnosticCodes: Array.isArray(item.diagnosticCodes) ? item.diagnosticCodes : []
      })),
      durationMs: validation.durationMs,
      createdAt: new Date().toISOString()
    };
    const temporary = path.join(folder, '.validation-' + randomUUID() + '.tmp');
    try {
      writeFileSync(temporary, JSON.stringify(payload), { flag: 'wx' });
      renameSync(temporary, target);
    } catch {
      try { unlinkSync(temporary); } catch {}
    }
    const stored = readValidationReceipt(project, generation, validation.inputDigest);
    return validationCacheMatches(stored, validation) ? stored : null;
  } catch {
    return null;
  }
}

function activationPlan(mode, risk) {
  const scope = risk?.scope ?? 'unknown';
  const plan = {
    affectedComponents: mode === 'renderer' ? ['renderer'] :
      mode === 'companion' ? ['companion'] : ['unknown'],
    runtimeOwner: mode === 'renderer' ?
      'chat41-native-renderer-and-root-codex-release-owner' :
      mode === 'companion' ? 'chat24-authenticated-companion-owner' :
        'root-codex-release-and-ProfileLifecycleCoordinator',
    materialization: mode === 'renderer' ? 'renderer-private-http-or-existing-vite-hmr' :
      mode === 'companion' ? 'existing-extension-fingerprint-and-safe-reload' :
        'immutable-main-preload-private-stage',
    redundantBuildWork: [],
    requiredQualification: ['exact-source-delta', 'dependency-and-native-abi',
      'security-review', 'prior-good-rollback'],
    nativeActivation: 'deferred-until-risk-is-classified'
  };
  if (scope === 'renderer-source-only-candidate') {
    plan.affectedComponents = ['renderer'];
    plan.runtimeOwner = 'chat41-native-renderer-and-root-codex-release-owner';
    plan.materialization = 'renderer-private-http-or-existing-vite-hmr';
    plan.redundantBuildWork = ['main-preload-compile', 'companion-materialization'];
    plan.requiredQualification = ['exact-source-fingerprint', 'package-lock-match',
      'renderer-served-byte-manifest', 'rollback-to-last-known-good'];
    plan.nativeActivation = 'renderer-only-live-proof-without-main-or-companion-restart';
  } else if (scope === 'companion-source-only-candidate') {
    plan.affectedComponents = ['companion'];
    plan.runtimeOwner = 'chat24-authenticated-companion-owner';
    plan.materialization = 'existing-extension-fingerprint-and-safe-reload';
    plan.redundantBuildWork = ['electron-main-preload-renderer-compile'];
    plan.requiredQualification = ['exact-extension-tree-fingerprint', 'package-lock-match',
      'paused-buffer-custody', 'loaded-worker-revision-and-bridge-reattach'];
    plan.nativeActivation = 'companion-only-safe-reload';
  } else if (scope === 'main-source-only-candidate' ||
      scope === 'preload-source-only-candidate' || scope === 'main-preload-source-candidate') {
    plan.affectedComponents = scope === 'main-preload-source-candidate' ?
      ['main', 'preload'] : [scope === 'preload-source-only-candidate' ? 'preload' : 'main'];
    plan.runtimeOwner = 'root-codex-release-and-ProfileLifecycleCoordinator';
    plan.materialization = 'immutable-main-preload-private-stage';
    plan.redundantBuildWork = ['companion-validation', 'renderer-validation'];
    plan.requiredQualification = ['exact-source-fingerprint', 'strict-dependency-tree',
      'native-abi', 'security-review', 'durable-drain', 'prior-good-rollback',
      'loaded-bytes-and-useful-continuation'];
    plan.nativeActivation = 'one-affected-main-process-after-root-qualification';
  } else if (scope === 'mixed-runtime-scope' || scope === 'release-risk') {
    plan.affectedComponents = scope === 'release-risk' ? ['unknown'] :
      ['main', 'preload', 'renderer', 'companion'];
    plan.runtimeOwner = 'root-codex-release-and-ProfileLifecycleCoordinator';
    plan.materialization = 'full-existing-qualification-path';
    plan.redundantBuildWork = [];
    plan.requiredQualification = ['exact-source-delta', 'strict-dependency-tree',
      'native-abi', 'security-review', 'durable-drain', 'prior-good-rollback',
      'loaded-bytes-and-useful-continuation'];
    plan.nativeActivation = scope === 'release-risk' ?
      'deferred-until-release-risk-is-cleared' : 'full-root-qualified-cutover';
  }
  return {
    schema: 'cos_dev_local_activation_plan_v1',
    basis: {
      requestedMode: mode,
      riskState: risk?.state ?? 'unknown',
      riskScope: scope,
      installedBaselineCommit: risk?.baselineCommit ?? null,
      installedBaselineComparison: risk?.state === 'classified' ?
        'path-delta-from-installed-source-commit' : 'installed-receipt-only',
      checkoutObservation: risk?.checkoutChangeCount === undefined ? null : {
        changeCount: risk.checkoutChangeCount,
        scope: risk.checkoutChangeScope ?? 'unknown',
        domains: risk.checkoutDomains ?? null
      }
    },
    ...plan,
    rootOnlyGates: true,
    productionActivationAllowed: false
  };
}

function classifyChangeNames(names, lockAndPackageMatch) {
  const domains = { nativeOrDependency: 0, main: 0, preload: 0,
    renderer: 0, companion: 0, other: 0 };
  for (const name of names) {
    const value = name.toLowerCase();
    if (value === 'package.json' || value === 'package-lock.json' ||
        value === 'electron.vite.config.ts' || value === 'tsconfig.json' ||
        value.startsWith('resources/') || value.startsWith('scripts/install') ||
        value.startsWith('scripts/package') || value.endsWith('.node') ||
        value.endsWith('binding.gyp') || value.startsWith('native/'))
      domains.nativeOrDependency++;
    else if (value.startsWith('src/main/')) domains.main++;
    else if (value.startsWith('src/preload/')) domains.preload++;
    else if (value.startsWith('src/renderer/')) domains.renderer++;
    else if (value.startsWith('extension/')) domains.companion++;
    else domains.other++;
  }
  const runtimeOwners = [domains.main || domains.preload, domains.renderer, domains.companion]
    .filter(Boolean).length;
  const scope = !names.length ? 'no-observed-difference' :
    (domains.nativeOrDependency || domains.other || !lockAndPackageMatch) ? 'release-risk' :
    runtimeOwners > 1 ? 'mixed-runtime-scope' :
    domains.main && domains.preload ? 'main-preload-source-candidate' :
    domains.preload ? 'preload-source-only-candidate' :
    domains.main ? 'main-source-only-candidate' :
    domains.renderer ? 'renderer-source-only-candidate' :
    domains.companion ? 'companion-source-only-candidate' : 'unknown';
  return { domains, scope };
}

// This risk report is deliberately stricter than path-based release policy:
// unknown files and lock/ABI/security changes require normal qualification.
// A path list is never itself proof of native ABI compatibility or approval.
export function mainActivationRisk(project, installed) {
  const baseline = installed?.status === 'observed-strict-receipt' &&
    /^[0-9a-f]{40}$/i.test(installed.commit ?? '') ? installed.commit : null;
  const blocked = reason => ({ schema: 'cos_dev_main_risk_v1',
    state: 'unverified', reason, baselineCommit: baseline, changedPathCount: null,
    changedPathListSha256: null, domains: null, requiresRootReleaseReview: true,
    eligibleForNativeActivation: false,
    activationPlan: activationPlan('main', {
      state: 'unverified', scope: 'unknown', baselineCommit: baseline
    }) });
  if (!baseline) return blocked('installed-strict-baseline-unavailable');
  const runGit = parameters => {
    const result = spawnSync('git', ['--no-optional-locks', ...parameters], {
      cwd: project, windowsHide: true, encoding: 'buffer',
      timeout: 6000, maxBuffer: MAX_GIT_CHANGE_BYTES
    });
    return result.status === 0 && !result.error && Buffer.isBuffer(result.stdout) ?
      result.stdout : null;
  };
  const top = runGit(['rev-parse', '--show-toplevel']);
  if (!top || path.resolve(top.toString('utf8').trim()).toLowerCase() !==
      path.resolve(project).toLowerCase())
    return blocked('installed-baseline-checkout-unverified');
  // Exclude unrelated untracked media, old private generations and users'
  // archives. Only these paths can participate in the existing main/compiler,
  // extension or runtime payload contract; unrelated changes cannot qualify
  // an activation, and release approval is still always separate.
  const codeScope = ['src', 'extension', 'scripts', 'resources', 'package.json',
    'package-lock.json', 'electron.vite.config.ts', 'tsconfig.json'];
  const lockAndPackageMatch = installed.packageMatch === true && installed.lockMatch === true;
  const census = reference => {
    const changed = runGit(['diff', '--no-ext-diff', '--name-only', '-z',
      reference, '--', ...codeScope]);
    const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z',
      '--', ...codeScope]);
    if (changed === null || untracked === null) return null;
    const parsePaths = value => value.toString('utf8').split('\0').filter(Boolean);
    const names = [...new Set([...parsePaths(changed), ...parsePaths(untracked)])].sort();
    if (names.length > 4096 || names.some(name => name.length > 512 ||
        !name || name.startsWith('/') || name.includes('..') || name.includes('\\')))
      return null;
    return { names, ...classifyChangeNames(names, lockAndPackageMatch) };
  };
  if (!runGit(['cat-file', '-e', baseline])) {
    const observed = census('HEAD');
    const result = blocked('installed-baseline-object-unavailable');
    if (!observed) return result;
    const checkout = { ...result, checkoutChangeCount: observed.names.length,
      checkoutChangePathListSha256: sha(Buffer.from(JSON.stringify(observed.names))),
      checkoutDomains: observed.domains, checkoutChangeScope: observed.scope };
    checkout.activationPlan = activationPlan('main', checkout);
    return checkout;
  }
  const changed = runGit(['diff', '--no-ext-diff', '--name-only', '-z',
    baseline, '--', ...codeScope]);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z',
    '--', ...codeScope]);
  if (!changed || !untracked) return blocked('installed-baseline-change-census-unverified');
  const parsePaths = value => value.toString('utf8').split('\0').filter(Boolean);
  const names = [...new Set([...parsePaths(changed), ...parsePaths(untracked)])].sort();
  if (names.length > 4096 || names.some(name => name.length > 512 ||
      !name || name.startsWith('/') || name.includes('..') || name.includes('\\')))
    return blocked('installed-baseline-change-census-unbounded');
  const classified = classifyChangeNames(names, lockAndPackageMatch);
  const { domains, scope } = classified;
  const risk = { schema: 'cos_dev_main_risk_v1', state: 'classified',
    baselineCommit: baseline, comparedPaths: 'app-source-extension-build-and-update-tools',
    unscannedOtherPathsCannotGrantActivation: true, changedPathCount: names.length,
    changedPathListSha256: sha(Buffer.from(JSON.stringify(names))),
    domains, packageAndLockMatchInstalled: lockAndPackageMatch,
    scope, requiresRootReleaseReview: true, eligibleForNativeActivation: false,
    reason: scope === 'release-risk' ? 'native-dependency-or-unknown-file-risk' :
      scope === 'mixed-runtime-scope' ? 'more-than-one-runtime-owner-must-approve' :
        'exact-native-runtime-and-lifecycle-gates-not-yet-proven' };
  risk.activationPlan = activationPlan('main', risk);
  return risk;
}

function mainHandoff(generation, inputs, manifest, risk) {
  return { schema: 'cos_dev_main_activation_handoff_v1',
    target: 'one-explicit-existing-profile-process-only',
    stage: { generation: generation.name, sourceSha256: generation.source,
      compiledOutputSha256: generation.compiled, compilerSha256: generation.compiler,
      inputDigest: inputs.digest, outputManifestSha256: manifest.manifestSha256,
      selectedTestPaths: inputs.validatedTestPaths,
      validatorSupportSha256: inputs.validatorSupport?.sha256 ?? null },
    mainOutput: manifest, risk,
    installedBaseline: inputs.installedBaseline,
    requiredLifecycleOwner: 'ProfileLifecycleCoordinator',
    requirements: {
      verifyActualReleaseOwner: 'root-codex-explicit-qualification',
      verifyPlatformDependencyAndNativeAbi: 'strict-source-tree-toolchain-and-loaded-electron-abi',
      bindExactRuntime: 'profile-id-pid-process-birth-and-running-generation',
      requestDrain: 'requestDrain-reaches-drain-ready-with-zero-blockers-and-matching-admission-owner',
      durableCheckpoint: 'flushRecorder-flushSessions-flushDurable-with-owned-continuation-custody',
      stopOnlyAffectedProcess: 'requestShutdown-after-ready-and-observed-exact-process-exit',
      priorGoodRollback: 'preserve-old-generation-and-verified-restore-before-any-atomic-switch',
      atomicSwitch: 'release-owner-owned-private-install-target-no-shared-live-ASAR-overwrite',
      reopen: 'exact-process-and-profile-without-prompt-or-message-replay',
      healthAndReattach: 'loaded-main-preload-source-output-and-ABI-plus-native-bridge-and-companion-proof',
      success: 'native-useful-continuation-with-exact-current-source-and-no-pending-delivery-loss',
      failure: 'fenced-original-owner-recovery-with-rollback-and-existing-local-incidents',
      macPlatform: 'signed-bundle-quarantine-entitlements-keychain-and-physical-runtime-qualification'
    },
    stageVerifiedOnly: true, nativeActivationAttempted: false,
    runtimeLoadedBytesVerified: false, quiescenceVerified: false,
    rollbackExecuted: false, changesInstalled: false,
    eligibleForProductionActivation: false };
}

// One actionable, conservative decision shared by the three existing local
// modes. It projects the *incumbent* Git/release risk and exact selected stage;
// it does not elect a profile, install files, launch a native app or replace
// ProfileLifecycleCoordinator / chat24 / the release owner's decisions.
function deferredActivationDecision(mode, inputs, risk, stages, selected) {
  const workflows = {
    renderer: {
      availablePrivateWorkflow: 'isolated-renderer-http-preview',
      requiredOwner: 'chat41-native-renderer-and-root-codex-release-owner',
      nextNativeEvidence: 'exact-vite-css-hmr-or-new-document-loaded-digest-and-live-work-continuation'
    },
    companion: {
      availablePrivateWorkflow: 'source-mv3-fingerprint-only',
      requiredOwner: 'chat24-authenticated-companion-owner',
      nextNativeEvidence: 'loaded-mv3-worker-revision-account-epoch-buffer-custody-and-bridge-reattach'
    },
    main: {
      availablePrivateWorkflow: 'immutable-main-preload-stage',
      requiredOwner: 'root-codex-release-and-ProfileLifecycleCoordinator',
      nextNativeEvidence: 'durable-drain-exact-affected-pid-exit-atomic-switch-reopen-loaded-abi-and-rollback'
    }
  };
  const workflow = workflows[mode];
  return { schema: 'cos_dev_local_activation_decision_v1',
    mode, decision: 'native-activation-deferred',
    eligibleForNativeActivation: false, exactRuntimeProof: 'not-observed',
    distributionPackageBuilt: false, requiresReleasePackagingDecision: true,
    testedSourceSha256: stages.sourceQualification?.status === 'passed' ?
      stages.sourceQualification.sourceSha256 : null,
    inputDigest: inputs.digest,
    validatorSupportSha256: inputs.validatorSupport?.sha256 ?? null,
    validatorSupportScope: inputs.validatorSupport?.scope ?? null,
    compiledOutputSha256: selected?.compiled ?? null,
    expectedMaterializedSha256: selected?.materialized ?? null,
    validationStatus: stages.changedCodeValidation.status,
    selectedTestPaths: inputs.validatedTestPaths,
    risk, activationPlan: activationPlan(mode, risk), ...workflow,
    requiredSharedGates: [
      'release-owner-explicit-risk-and-native-abi-approval',
      'exact-authenticated-target-profile-and-running-revision',
      'durable-current-delivery-checkpoint-and-no-ambiguous-replay',
      'prior-good-bytes-and-verifiable-rollback',
      'loaded-bytes-health-reattach-and-useful-native-continuation',
      'mac-signing-quarantine-keychain-and-physical-qualification-when-applicable'
    ],
    lifecycleTimingOwner: 'root-codex-install-and-ProfileLifecycleCoordinator',
    lifecycleTimingRequired: [
      'admissionPause', 'drain', 'checkpoint', 'cutover', 'reopen',
      'reattach', 'usefulContinuation', 'rollbackRestoration'
    ],
    nativeProductionDowntimeMs: null,
    rollback: { existingInstalledStatePreserved: true,
      privateGenerationHistoryPreserved: true,
      installedRollbackBytesVerified: false,
      actualInstalledRollbackExecuted: false },
    activationAttempted: false, loadedBytesVerified: false,
    installedRuntimeVerified: false };
}

function boundedQualifierFailure(result) {
  if (result?.schema !== 'cos_dev_build_qualification_v1') return null;
  const codes = Array.isArray(result.failures) ? result.failures
    .filter(value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value))
    .slice(0, 12) : [];
  const actions = Array.isArray(result.handoff?.next) ? result.handoff.next
    .filter(value => typeof value === 'string' && /^[a-z0-9-]{1,100}$/.test(value))
    .slice(0, 8) : [];
  const diagnosticCodes = [
    ...(result.execution?.result?.compilerOutput?.diagnosticCodes ?? []),
    ...(result.confirmationExecution?.compilerOutput?.diagnosticCodes ?? [])
  ].filter(value => typeof value === 'string' &&
    /^(?:TS\d{4,5}|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|EACCES|EPERM|ENOENT)$/.test(value))
    .slice(0, 8);
  const drift = result.sourceInputDrift;
  const relative = value => typeof value === 'string' && value.length <= 200 &&
    /^(?:src|resources)\/[A-Za-z0-9_.\/-]+$|^(?:package(?:-lock)?\.json|electron\.vite\.config\.ts|tsconfig\.json)$/.test(value) &&
    !value.split('/').some(part => part === '.' || part === '..' || !part);
  const digestOrNull = value => value === null || DIGEST.test(value ?? '');
  const sourceInputDrift = drift && DIGEST.test(drift.originalSha256 ?? '') &&
    DIGEST.test(drift.observedSha256 ?? '') &&
    Number.isSafeInteger(drift.changeCount) && drift.changeCount >= 1 &&
    Array.isArray(drift.examples) ? {
      originalSha256: drift.originalSha256, observedSha256: drift.observedSha256,
      changeCount: drift.changeCount, truncated: drift.truncated === true,
      examples: drift.examples.slice(0, 12)
        .filter(item => relative(item?.file) &&
          digestOrNull(item.oldSha256) && digestOrNull(item.newSha256))
        .map(item => ({ file: item.file, oldSha256: item.oldSha256,
          newSha256: item.newSha256 }))
    } : null;
  const output = result.reproducibilityDrift;
  const outputDrift = output && Number.isSafeInteger(output.changeCount) &&
    output.changeCount >= 1 && Number.isSafeInteger(output.counts?.main) &&
    Number.isSafeInteger(output.counts?.preload) &&
    Number.isSafeInteger(output.counts?.renderer) &&
    Number.isSafeInteger(output.counts?.other) ? {
      changedFiles: output.changeCount,
      counts: { main: output.counts.main, preload: output.counts.preload,
        renderer: output.counts.renderer, other: output.counts.other }
    } : null;
  return { schema: 'cos_dev_private_build_failure_v1',
    failureClassification: ['environment', 'ownership', 'command', 'validation', 'none']
      .includes(result.failureClassification) ? result.failureClassification : 'unknown',
    failureCodes: codes, diagnosticCodes: [...new Set(diagnosticCodes)],
    compilerExitCode: exitCode(result.execution?.result?.exitCode),
    confirmationExitCode: exitCode(result.confirmationExecution?.exitCode),
    firstBuildMs: Number.isSafeInteger(result.execution?.result?.durationMs) ?
      result.execution.result.durationMs : null,
    confirmationBuildMs: Number.isSafeInteger(result.confirmationExecution?.durationMs) ?
      result.confirmationExecution.durationMs : null,
    reproducible: result.reproducible === true ? true :
      result.reproducible === false ? false : null,
    privatePublished: result.privateOutput?.published === true,
    retrySafe: typeof result.handoff?.retrySafe === 'string' &&
      /^[a-z0-9-]{1,120}$/.test(result.handoff.retrySafe) ?
      result.handoff.retrySafe : 'unverified',
    nextActions: actions,
    ...(sourceInputDrift ? { sourceInputDrift } : {}),
    ...(outputDrift ? { outputDrift } : {}) };
}

// A CLI has no authenticated CoS profile or running Electron owner. Prepare a
// stable, privacy-safe incident *candidate* for chat24's existing Main logger
// rather than guessing a profile folder or writing a second diagnostic tree.
// The Main owner must bind it to its current profile and decide whether to call
// noteLocalIncident; this receipt alone does not record a native incident.
function localUpdateIncidentHandoff(receipt) {
  const raw = typeof receipt.reason === 'string' ? receipt.reason : '';
  const code = /^local-update-[a-z0-9-]{1,65}$/.test(raw) ?
    raw.slice('local-update-'.length) : 'unclassified-refusal';
  const reason = `local_update.${code}`;
  const stages = Object.fromEntries(Object.entries(receipt.stages)
    .map(([name, state]) => [name, {
      status: state?.status ?? 'unknown',
      durationMs: Number.isSafeInteger(state?.durationMs) && state.durationMs >= 0 ?
        state.durationMs : null
    }]));
  const signature = {
    mode: receipt.mode, reason, reviewOnly: receipt.reviewOnly,
    sourceSha256: DIGEST.test(receipt.sourceSha256 ?? '') ? receipt.sourceSha256 : null,
    inputDigest: DIGEST.test(receipt.inputProvenance?.digest ?? '') ?
      receipt.inputProvenance.digest : null,
    failureCodes: (receipt.privateBuildFailure?.failureCodes ?? [])
      .filter(value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value))
      .slice(0, 12),
    stageStates: Object.fromEntries(Object.entries(stages).map(([name, value]) =>
      [name, value.status]))
  };
  return {
    schema: 'cos_dev_local_update_incident_handoff_v1',
    target: 'src/main/logger.ts:noteLocalIncident',
    input: { source: 'app', reason,
      fingerprint: sha(Buffer.from(JSON.stringify(signature))).toLowerCase() },
    stages, originatingEvidence: 'source-or-private-stage-only',
    profileBound: false, recordedInNativeIncidentFolder: false,
    nextOwner: 'authenticated-current-profile-Main-incident-logger',
    noNativeActivationOrLoadedBytesClaim: true
  };
}

function parse(args) {
  const entries = args.filter(arg => arg.startsWith('--local-update='));
  if (entries.length !== 1 || !VALID_MODES.has(entries[0].split('=')[1]) ||
      args.filter(arg => arg === '--json').length !== 1 ||
      args.filter(arg => arg === '--review-only').length > 1 ||
      args.filter(arg => arg === '--rebuild').length > 1 ||
      args.filter(arg => arg === '--interactive-preview').length > 1 ||
      args.some(arg => ![entries[0], '--json', '--review-only', '--rebuild', '--interactive-preview'].includes(arg)) ||
      (args.includes('--interactive-preview') &&
        (entries[0] !== '--local-update=renderer' || args.includes('--review-only'))) ||
      (args.includes('--rebuild') && entries[0] === '--local-update=companion'))
    throw Error('local-update-options-unverified');
  return { mode: entries[0].slice('--local-update='.length),
    reviewOnly: args.includes('--review-only'), rebuild: args.includes('--rebuild'),
    interactivePreview: args.includes('--interactive-preview') };
}

async function runExact(project, launcher, options, signal) {
  const began = process.hrtime.bigint();
  const cancelledBeforeSpawn = signal?.aborted === true;
  if (cancelledBeforeSpawn) return { code: null, error: true, durationMs: 0,
    receipt: null, lines: null, custodyVerified: false, cancelled: true, timedOut: false };
  let raw = '';
  let outputBytes = 0;
  let overflow = false;
  let child;
  let error = false;
  let exited = false;
  let pipesSettled = false;
  let cancelled = false;
  let timedOut = false;
  let status = null;
  const requestedTimeout = Number(process.env.COS_DEV_FAST_BUILD_TIMEOUT_MS);
  const buildDeadline = Number.isSafeInteger(requestedTimeout) &&
    requestedTimeout >= 20 && requestedTimeout <= 60 * 60 * 1000 ?
    requestedTimeout : 600000;
  const deadlineMs = options.includes('--confirm-reproducible') ?
    buildDeadline * 2 + 20000 :
    options.includes('--reporter=dot') ? 5 * 60 * 1000 : 30000;
  try {
    child = spawn(process.execPath, [launcher, ...options], {
      cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    return { code: null, error: true, durationMs: duration(began),
      receipt: null, lines: null, custodyVerified: false, cancelled: false, timedOut: false };
  }
  await new Promise(resolve => {
    let finished = false;
    let deadline = null;
    let termination = null;
    let pipeGrace = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(termination);
      clearTimeout(pipeGrace);
      signal?.removeEventListener('abort', onAbort);
      if (!pipesSettled) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve();
    };
    const stop = () => {
      try { child.kill('SIGTERM'); } catch { /* unknown owner stays unverified */ }
      termination ??= setTimeout(() => {
        try { if (!exited) child.kill('SIGKILL'); }
        catch { /* unknown owner stays unverified */ }
        // Never hang behind inherited output handles or a failed kill.
        setTimeout(finish, 600);
      }, 1000);
    };
    const onAbort = () => { cancelled = true; stop(); };
    child.stdout?.on('data', part => {
      if (overflow) return;
      outputBytes += part.length;
      if (outputBytes > MAX_RECEIPT) {
        overflow = true;
        stop();
        return;
      }
      raw += part.toString('utf8');
    });
    child.stderr?.on('data', () => { /* Drain; never log child/source text. */ });
    child.once('error', () => { error = true; stop(); });
    child.once('exit', (code, _signal) => {
      exited = true;
      status = code;
      // A descendant can keep stdout open after its parent exits. The
      // incumbent qualifier treats that as unverified process/output custody.
      pipeGrace = setTimeout(finish, 1200);
    });
    child.once('close', () => { pipesSettled = true; finish(); });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    deadline = setTimeout(() => { timedOut = true; stop(); }, deadlineMs);
  });
  let parsed = null;
  let lines = null;
  const diagnosticCodes = [...new Set((raw.match(/\b(?:TS\d{4}|EACCES|EPERM|ERR_MODULE_NOT_FOUND)\b/g) ?? []))].slice(0, 8);
  if (!error && !cancelled && !timedOut && !overflow && pipesSettled &&
      exited && raw.length && outputBytes <= MAX_RECEIPT) {
    try { parsed = JSON.parse(raw.trim()); } catch { /* refuse as unknown */ }
    if (parsed === null && options.some(option => option.startsWith('--probe-private-out='))) {
      try {
        const rows = raw.trim().split(/\r?\n/);
        if (rows.length === 2) lines = rows.map(row => JSON.parse(row));
      } catch { lines = null; }
    }
  }
  return { code: exitCode(status), error: error || overflow,
    durationMs: duration(began), receipt: parsed, lines,
    custodyVerified: exited && pipesSettled && !error && !overflow &&
      !cancelled && !timedOut, cancelled, timedOut, diagnosticCodes };
}

async function selectExactly(project, launcher, generation, signal) {
  const args = ['--qualify-build', '--json',
    `--select-stage=${generation.name}`,
    `--expect-source-sha256=${generation.source}`,
    `--expect-compiled-sha256=${generation.compiled}`,
    `--expect-compiler-sha256=${generation.compiler}`];
  const outcome = await runExact(project, launcher, args, signal);
  if (!outcome.custodyVerified) throw Error('local-update-execution-custody-unverified');
  const r = outcome.receipt;
  if (r?.schema !== 'cos_dev_build_qualification_v1' ||
      r.mode !== 'exact-staged-artifact-selection' ||
      r.accepted !== false || !Array.isArray(r.failures) ||
      r.nativeRuntimeVerified !== false || r.installedRuntimeVerified !== false)
    throw Error('local-update-generation-selection-unverified');
  if (outcome.code !== 0) {
    // An immutable old generation whose current source/compiler differs is
    // legitimately stale. A wrong digest, modified receipt, incomplete output,
    // racing writer or unexplained selector failure is not safely recyclable.
    // Refuse instead of turning tampering into silent source recompilation.
    const staleOnly = r.stageSelectedForReview === false && r.failures.length > 0 &&
      r.failures.every(reason =>
        reason === 'selected-source-mismatch' || reason === 'selected-compiler-mismatch');
    if (!staleOnly) throw Error('local-update-generation-selection-unverified');
    return { accepted: false, durationMs: outcome.durationMs };
  }
  if (r.stageSelectedForReview !== true || r.sourceSha256 !== generation.source ||
      r.compiledOutputSha256 !== generation.compiled ||
      r.toolchain?.electronViteCliSha256 !== generation.compiler ||
      r.failures.length !== 0)
    throw Error('local-update-generation-selection-unverified');
  return { accepted: true, durationMs: outcome.durationMs };
}

async function inspectedSourceEpoch(project, launcher, signal) {
  const run = await runExact(project, launcher,
    ['--qualify-build', '--snapshot-source', '--json'], signal);
  const item = run.receipt;
  if (!run.custodyVerified || run.code !== 0 ||
      item?.schema !== 'cos_dev_source_snapshot_v1' ||
      item.mode !== 'read-only-source-inspection' || item.stable !== true ||
      item.nativeRuntimeVerified !== false || item.installedRuntimeVerified !== false ||
      item.changesInstalled !== false || !DIGEST.test(item.sourceSha256 ?? '') ||
      !DIGEST.test(item.compilerSha256 ?? '') ||
      !Number.isSafeInteger(item.sourceFileCount) || item.sourceFileCount < 1)
    throw Error('local-update-source-snapshot-unverified');
  return { source: item.sourceSha256.toUpperCase(),
    compiler: item.compilerSha256.toUpperCase(), files: item.sourceFileCount,
    durationMs: run.durationMs };
}

function publishedGenerations(project) {
  const temp = path.join(project, '.test_tmp');
  if (!existsSync(temp)) return [];
  safeDirectory(temp);
  const output = [];
  // A constant bound makes startup predictable in long-lived workspaces. An
  // overflow is not permission to guess which generation is authoritative.
  const names = readdirSync(temp).filter(name => name.startsWith('chat42-private-out-'));
  if (names.length > 64) throw Error('local-update-generation-catalog-unbounded');
  for (const name of names) {
    if (!GENERATION.test(name)) continue;
    const folder = path.join(temp, name);
    safeDirectory(folder);
    const file = path.join(folder, 'evidence.json');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      throw Error('local-update-generation-evidence-unverified');
    let evidence;
    try { evidence = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw Error('local-update-generation-evidence-unverified'); }
    if (evidence.schema !== 'cos_dev_private_output_v1' || evidence.name !== name ||
        !DIGEST.test(evidence.sourceSha256 ?? '') ||
        !DIGEST.test(evidence.compiledOutputSha256 ?? '') ||
        !DIGEST.test(evidence.electronViteCliSha256 ?? '') ||
        evidence.reproducible !== true || evidence.adoptedAsProduction !== false ||
        evidence.nativeRuntimeVerified !== false || evidence.installedRuntimeVerified !== false)
      throw Error('local-update-generation-evidence-unverified');
    // generatedAt affects candidate order only. Invalid timestamps are an
    // untrusted receipt; a plausible timestamp is NEVER approval or loaded
    // proof. The existing exact selector still rehashes every chosen candidate.
    if (typeof evidence.generatedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(evidence.generatedAt) ||
        !Number.isFinite(Date.parse(evidence.generatedAt)) ||
        new Date(Date.parse(evidence.generatedAt)).toISOString() !== evidence.generatedAt)
      throw Error('local-update-generation-evidence-unverified');
    output.push({ name, source: evidence.sourceSha256.toUpperCase(),
      compiled: evidence.compiledOutputSha256.toUpperCase(),
      compiler: evidence.electronViteCliSha256.toUpperCase(),
      generatedAt: evidence.generatedAt });
  }
  // Prefer recently built generations without testing several superseded
  // revisions first. With six retained generations this removes avoidable
  // child startup + duplicate source/asset hashing for old stages. The exact
  // selector alone can accept a candidate: no cached hash, timestamp-based
  // adoption, mutable latest pointer or historical out/ change is introduced.
  return output.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) ||
    a.name.localeCompare(b.name));
}

function companionSourceFingerprint(project) {
  const root = path.join(project, 'extension');
  safeDirectory(root);
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const visit = (dir, relativeDir = '') => {
    // Match extension-path.ts:extensionFingerprint, which is the incumbent
    // owner of packaged/source materialization. Default sort() orders ASCII
    // uppercase before lowercase and would produce different hashes for the
    // exact same Chrome extension bytes on Windows and macOS.
    for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      const absolute = path.join(dir, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw Error('local-update-companion-linked-entry');
      if (stat.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        visit(absolute, relative);
      } else if (stat.isFile()) {
        files++;
        bytes += stat.size;
        if (files > MAX_FILES || stat.size > MAX_FILE_BYTES || bytes > MAX_EXTENSION_BYTES)
          throw Error('local-update-companion-unbounded');
        hash.update(`f\0${relative}\0`);
        hash.update(readFileSync(absolute));
        hash.update('\0');
      } else throw Error('local-update-companion-special-entry');
    }
  };
  visit(root);
  const manifestFile = path.join(root, 'manifest.json');
  const manifestStat = lstatSync(manifestFile);
  if (!files || !manifestStat.isFile() || manifestStat.isSymbolicLink() ||
      manifestStat.size > 128 * 1024)
    throw Error('local-update-companion-manifest-unverified');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); }
  catch { throw Error('local-update-companion-manifest-unverified'); }
  if (manifest?.manifest_version !== 3 ||
      typeof manifest.name !== 'string' || !manifest.name.trim() ||
      typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version))
    throw Error('local-update-companion-manifest-unverified');
  return { sha256: hash.digest('hex').toUpperCase(), files, bytes,
    algorithm: 'extension-path-materialized-tree-sha256-v1' };
}

export async function runPersonalLocalUpdate({
  args, project, launcher, windowsProcessBirth, windowsPostSpawnProcessesClear
}) {
  const began = process.hrtime.bigint();
  const stage = {
    dependencyInstall: notRun('reuse-existing-dependencies-no-install'),
    foregroundControl: notRun('no-interactive-operator-admission'),
    sourceReadinessFence: notRun('private-stage-and-review-not-yet-verified'),
    preparedOutputFence: notRun('no-post-review-exact-generation-selection'),
    privateSwitch: notRun('no-private-renderer-switch'),
    privateRestoration: notRun('no-private-renderer-restoration'),
    changedCodeValidation: notRun('requires-explicit-reviewed-test-scope'),
    validationCache: notRun('no-prior-passed-validation-receipt'),
    compiledStage: notRun('not-attempted'),
    confirmationCompilation: notRun('not-attempted'),
    privatePublication: notRun('not-attempted'),
    exactGenerationSelection: notRun('not-attempted'),
    sourceQualification: notRun('review-only-does-not-validate-source-epoch'),
    rendererHealth: notRun('not-attempted'),
    fullRegression: notRun('production-release-owner-gate'),
    packaging: notRun('no-distribution-package-for-local-review'),
    safeQuiescence: notRun('live-lifecycle-owner-not-invoked'),
    copySwitch: notRun('shared-installed-program-not-touched'),
    reopen: notRun('installed-app-not-restarted'),
    nativeReattach: notRun('no-native-browser-or-companion-reattach')
  };
  const receipt = {
    schema: SCHEMA, mode: null, status: 'refused', reviewOnly: false,
    nativeRuntimeVerified: false, installedRuntimeVerified: false,
    companionLoadedBytesVerified: false, sharedOutModified: false,
    previousGenerationPreserved: true, buildStrategy: 'none', generation: null,
    sourceSha256: null, compiledOutputSha256: null, compilerSha256: null,
    inputProvenance: null, validationStrategy: 'execute-selected-tests',
    changesInstalled: false, eligibleForProductionActivation: false,
    stages: stage, nextAction: 'inspect-local-update-options', reason: null
  };
  // These are observations inside this command, never a second lifecycle
  // state machine. A successful private review does not observe a live Drain,
  // admission pause, installed cutover or readiness of an authenticated app.
  let observedStage = 'options';
  let observedStageStarted = began;
  let preparationBegan = began;
  let preparationAdmitted = true;
  let preparationEnded = null;
  let privateReviewStarted = null;
  let privateReviewEnded = null;
  let postPrivateReadinessStarted = null;
  let privateReviewBreakdown = null;
  const observe = name => {
    observedStage = name;
    observedStageStarted = process.hrtime.bigint();
  };
  const cancellation = new AbortController();
  const onInterrupt = () => cancellation.abort();
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  let admitStart = null;
  let admissionSettled = false;
  let requireInteractiveControl = false;
  const onInputEnd = () => {
    if (!requireInteractiveControl) return;
    cancellation.abort();
    if (!admissionSettled) { admissionSettled = true; admitStart?.(false); }
  };
  // Piped clients on Windows cannot assume process.kill(SIGTERM) reaches a
  // Node signal handler. An exact foreground stdin cancel keeps the wrapper
  // alive to report refused qualification/unknown compiler custody.
  let input = '';
  const onInput = part => {
    input += String(part);
    if (input.length > 256) {
      input = '';
      return;
    }
    const index = input.indexOf('\n');
    if (index < 0) return;
    const line = input.slice(0, index).trim();
    input = input.slice(index + 1);
    if ((line === 'start' || line === '{"command":"start"}') && !admissionSettled) {
      admissionSettled = true;
      admitStart?.(true);
    }
    if (line === 'cancel' || line === '{"command":"cancel"}') cancellation.abort();
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onInput);
  process.stdin.on('end', onInputEnd);
  const finish = code => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    process.stdin.off('data', onInput);
    process.stdin.off('end', onInputEnd);
    process.stdin.pause();
    if (cancellation.signal.aborted) {
      receipt.status = 'refused';
      receipt.reason = 'local-update-cancelled';
      receipt.nextAction = 'inspect-original-compiler-and-descendant-custody-before-any-staging-retry';
      code = 1;
    }
    const ended = process.hrtime.bigint();
    receipt.durationMs = duration(began, ended);
    receipt.executionTiming = {
      clock: 'process.hrtime.bigint', commandDurationMs: receipt.durationMs,
      failedStage: code === 0 ? null : observedStage,
      foregroundControl: stage.foregroundControl,
      localPreparation: !preparationAdmitted ?
        notRun('interactive-control-not-admitted') : {
        status: preparationEnded !== null || code === 0 ? 'completed' : 'refused',
        durationMs: duration(preparationBegan, preparationEnded ?? ended)
      },
      privateReview: privateReviewStarted === null ? notRun('no-private-renderer-review-started') : {
        status: stage.rendererHealth.status === 'passed' ? 'passed' : 'refused',
        durationMs: duration(privateReviewStarted, privateReviewEnded ?? ended),
        ...(privateReviewBreakdown ?? {})
      },
      postPrivateReadiness: postPrivateReadinessStarted === null ?
        notRun('no-completed-private-renderer-review') : {
        status: stage.sourceReadinessFence.status === 'passed' &&
          stage.preparedOutputFence.status === 'passed' ? 'passed' : 'refused',
        durationMs: duration(postPrivateReadinessStarted, ended),
        phase: 'post-http-source-input-and-private-output-verification',
        nativeAdmissionObserved: false, productionDowntimeMs: null
      },
      liveLifecycle: { status: 'not-invoked', durationMs: null,
        admissionPauseRequested: false, drainRequested: false,
        activationReadiness: 'not-observed',
        productionDowntimeMs: null, downtimeMeasured: false,
        timingOwner: 'root-codex-install-and-ProfileLifecycleCoordinator',
        phases: Object.fromEntries([
          'admissionPause', 'drain', 'checkpoint', 'cutover', 'reopen',
          'reattach', 'usefulContinuation', 'rollbackRestoration'
        ].map(name => [name, { status: 'not-invoked', durationMs: null }])) }
    };
    receipt.wrapperRssAtExitBytes = process.memoryUsage().rss;
    if (code !== 0) receipt.incidentHandoff = localUpdateIncidentHandoff(receipt);
    console.log(JSON.stringify(receipt));
    return code;
  };
  try {
  let options;
  try { options = parse(args); }
  catch { receipt.reason = 'local-update-options-unverified'; return finish(1); }
  receipt.mode = options.mode;
  receipt.reviewOnly = options.reviewOnly;
  requireInteractiveControl = options.interactivePreview;
  if (options.interactivePreview) {
    observe('interactiveControl');
    preparationAdmitted = false;
    const controlStarted = process.hrtime.bigint();
    // A headless command runner may start a readable-looking pipe while
    // refusing all subsequent stdin writes. Admit a foreground listener only
    // after receiving one real control message; never strand a private lease.
    console.log(JSON.stringify({ schema: SCHEMA, event: 'awaiting-stdin-control',
      command: '{"command":"start"}', admissionDeadlineMs: 10000 }));
    const ready = await new Promise(resolve => {
      admitStart = resolve;
      if (admissionSettled) { resolve(false); return; }
      const deadline = setTimeout(() => {
        if (admissionSettled) return;
        admissionSettled = true;
        resolve(false);
      }, 10000);
      const previous = admitStart;
      admitStart = value => { clearTimeout(deadline); previous(value); };
    });
    admitStart = null;
    const controlEnded = process.hrtime.bigint();
    stage.foregroundControl = {
      status: ready && !cancellation.signal.aborted ? 'passed' : 'refused',
      durationMs: duration(controlStarted, controlEnded),
      explicitStartReceived: ready
    };
    if (!ready || cancellation.signal.aborted) {
      receipt.reason = 'local-update-interactive-control-not-admitted';
      receipt.nextAction = 'rerun-with-writable-stdin-and-explicit-start-or-use-finite-renderer-review';
      return finish(1);
    }
    preparationBegan = controlEnded;
    preparationAdmitted = true;
  }
  let originalInputs;
  try {
    observe('inputProvenance');
    const stamp = process.hrtime.bigint();
    originalInputs = inputFingerprint(project, options.reviewOnly ? null : options.mode);
    receipt.inputProvenance = originalInputs;
    stage.inputProvenance = { status: 'measured', durationMs: duration(stamp),
      sourceAndToolInputsStable: null };
  } catch (error) {
    receipt.reason = error.message?.startsWith('local-update-') ?
      error.message : 'local-update-build-input-unverified';
    receipt.nextAction = 'restore-verifiable-local-build-and-dependency-inputs';
    return finish(1);
  }
  const confirmInputIdentity = () => {
    observe('inputProvenance');
    let now;
    try { now = inputFingerprint(project, options.reviewOnly ? null : options.mode); }
    catch { now = null; }
    const stable = now !== null && now.digest === originalInputs.digest &&
      now.installedBaseline.status === originalInputs.installedBaseline.status &&
      now.installedBaseline.receiptSha256 === originalInputs.installedBaseline.receiptSha256;
    stage.inputProvenance.sourceAndToolInputsStable = stable;
    if (!stable) {
      receipt.reason = 'local-update-inputs-changed-during-validation';
      receipt.nextAction = 'inspect-dependency-and-compiler-input-drift-before-new-local-update';
    }
    return stable;
  };
  // A private preview can legitimately keep old HTTP-verified bytes in memory
  // while the user edits their next revision. That proves a safe *restore*,
  // not readiness to hand the old generation to a live owner. Check the
  // selected generation and pinned build/test/installed inputs again AFTER
  // health, review, owner/risk inspection and any human dwell. A point-in-time
  // passing fence never substitutes for root's later native admission/Drain.
  const confirmPreparedReadiness = async (generation, testedEpoch = null) => {
    observe('sourceReadinessFence');
    const tick = process.hrtime.bigint();
    let current = null;
    let currentInputs = null;
    try { current = await inspectedSourceEpoch(project, launcher, cancellation.signal); }
    catch { /* unknown is distinct from an observed source mismatch */ }
    try { currentInputs = inputFingerprint(project, options.reviewOnly ? null : options.mode); }
    catch { /* a missing or unsafe pinned input is never readiness */ }
    const inputsStable = currentInputs !== null &&
      currentInputs.digest === originalInputs.digest &&
      currentInputs.installedBaseline.status === originalInputs.installedBaseline.status &&
      currentInputs.installedBaseline.receiptSha256 === originalInputs.installedBaseline.receiptSha256;
    const sourcesMatch = current === null ? null :
      current.source === generation.source && current.compiler === generation.compiler &&
      (testedEpoch === null || (current.source === testedEpoch.source &&
        current.compiler === testedEpoch.compiler && current.files === testedEpoch.files));
    const passed = current !== null && inputsStable && sourcesMatch;
    stage.inputProvenance.sourceAndToolInputsStable = inputsStable;
    stage.sourceReadinessFence = {
      status: passed ? 'passed' : 'refused',
      durationMs: duration(tick),
      sourceEpochObserved: current !== null,
      snapshotsMatch: sourcesMatch,
      inputsStable,
      expectedSourceSha256: generation.source,
      observedSourceSha256: current?.source ?? null,
      expectedCompilerSha256: generation.compiler,
      observedCompilerSha256: current?.compiler ?? null,
      inputDigest: originalInputs.digest,
      productionAdmissionMeasured: false
    };
    if (!passed) {
      receipt.reason = current === null ? 'local-update-prepared-source-snapshot-unverified' :
        !inputsStable ? 'local-update-prepared-inputs-no-longer-current' :
          'local-update-prepared-source-no-longer-current';
      receipt.nextAction = 'requalify-exact-current-source-and-test-inputs-before-new-local-update';
      return false;
    }
    if (options.mode === 'companion') {
      // Companion review publishes a bounded source fingerprint, not an
      // electron-vite generation. Its native materialization/loaded-worker
      // owner remains responsible for exact packaged asset byte acceptance.
      stage.preparedOutputFence = notRun('companion-has-no-compiled-output-generation');
      return true;
    }
    // HTTP health proves what the isolated listener served from memory, not
    // that an old output tree remains intact on disk after a lengthy preview.
    // The authoritative selector must still rehash the whole generation at
    // the final readiness boundary; a changed file never becomes an eligible
    // handoff by retaining an earlier success receipt.
    observe('preparedOutputFence');
    const selectionStarted = process.hrtime.bigint();
    let outputVerified = false;
    try {
      const selected = await selectExactly(project, launcher, generation, cancellation.signal);
      outputVerified = selected.accepted === true;
    } catch { /* unknown custody/changed disk is not verified output */ }
    stage.preparedOutputFence = {
      status: outputVerified ? 'passed' : 'refused',
      durationMs: duration(selectionStarted),
      exactOutputVerified: outputVerified,
      scope: 'private-output-only',
      nativeLoadedBytesVerified: false
    };
    if (!outputVerified) {
      receipt.reason = 'local-update-prepared-generation-no-longer-verified';
      receipt.nextAction = 'inspect-private-output-and-owner-before-publishing-a-fresh-verified-stage';
      return false;
    }
    return true;
  };
  // Run the existing TypeScript/test runners only for a bounded source check.
  // The selected suites are deliberately explicit, not guessed from one
  // changed filename. This still cannot authorize native/installed activation.
  let testedSourceEpoch = null;
  let testedCompanionFingerprint = null;
  let cachedValidation = null;
  let cachedValidationGeneration = null;
  if (!options.reviewOnly) {
    let before;
    try {
      observe('sourceQualification');
      before = await inspectedSourceEpoch(project, launcher, cancellation.signal);
      if (options.mode === 'companion')
        testedCompanionFingerprint = companionSourceFingerprint(project);
    } catch {
      receipt.reason = 'local-update-source-snapshot-unverified';
      receipt.nextAction = 'verify-owned-source-and-compiler-before-risk-appropriate-validation';
      stage.sourceQualification = { status: 'refused', durationMs: null };
      return finish(1);
    }
    if (options.mode !== 'companion') {
      observe('validationCache');
      const cacheLookupStarted = process.hrtime.bigint();
      const candidates = publishedGenerations(project);
      const cacheReuseSafe = originalInputs.validatorRuntime?.cacheReuseSafe !== false;
      let matchingReceipts = 0;
      let exactVerifierAttempts = 0;
      let metadataSkipped = 0;
      for (const existing of candidates) {
        if (!cacheReuseSafe) {
          metadataSkipped++;
          continue;
        }
        // The exact source snapshot is a *negative* eligibility fence: an
        // older generation cannot validate a different current source or
        // compiler. Do not spawn an expensive selector for absent/mismatched
        // validation receipts. Positive reuse STILL requires the independent
        // source/compiler/entire-compiled-tree selector below.
        if (existing.source !== before.source || existing.compiler !== before.compiler) {
          metadataSkipped++;
          continue;
        }
        const validation = readValidationReceipt(project, existing, originalInputs.digest);
        if (!validationCacheMatches(validation, {
          mode: options.mode, source: before.source, compiler: before.compiler,
          inputDigest: originalInputs.digest
        })) continue;
        matchingReceipts++;
        exactVerifierAttempts++;
        const selected = await selectExactly(project, launcher, existing, cancellation.signal);
        if (!selected.accepted) throw Error('local-update-cached-generation-became-stale');
        cachedValidation = validation;
        cachedValidationGeneration = existing;
        break;
      }
      stage.validationCache = {
        status: !cacheReuseSafe ? 'inherited-runtime-cache-bypassed' :
          cachedValidation ? 'exact-receipt-verified' : 'no-current-receipt',
        durationMs: duration(cacheLookupStarted),
        lookupDurationMs: duration(cacheLookupStarted), writeDurationMs: null,
        catalogCount: candidates.length, matchingReceipts,
        exactVerifierAttempts, metadataSkipped,
        ...(!cacheReuseSafe ? {
          reason: originalInputs.validatorRuntime.cacheBypassReason } : {})
      };
    }
    const tests = TESTS_BY_MODE[options.mode];
    const validators = [
      { name: 'typescript', executable: 'node_modules/typescript/bin/tsc',
        args: ['--noEmit', '-p', 'tsconfig.json'] },
      { name: 'focused-vitest', executable: 'node_modules/vitest/vitest.mjs',
        args: ['run', ...tests, '--reporter=dot'] }
    ];
    const startedValidation = process.hrtime.bigint();
    observe('changedCodeValidation');
    const results = [];
    if (cachedValidation) {
      receipt.validationStrategy = 'reuse-exact-source-test-receipt';
      results.push(...cachedValidation.checks.map(check => ({ ...check,
        executedThisRun: false, durationMs: null, originalDurationMs: check.durationMs })));
      stage.validationCache = {
        ...stage.validationCache,
        status: 'reused',
        generation: cachedValidationGeneration.name,
        sourceSha256: before.source, inputDigest: originalInputs.digest
      };
      stage.changedCodeValidation = {
        status: 'passed', reused: true, executedThisRun: false,
        durationMs: duration(startedValidation),
        originalDurationMs: cachedValidation.durationMs,
        cacheGeneration: cachedValidationGeneration.name,
        checks: results
      };
    } else {
      for (const item of validators) {
        const absolute = path.join(project, item.executable);
        if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
          results.push({ name: item.name, status: 'refused',
            executedThisRun: false,
            reason: 'validator-executable-missing', durationMs: null, exitCode: null });
          break;
        }
        const checked = await runExact(project, absolute, item.args, cancellation.signal);
        const passed = checked.custodyVerified && checked.code === 0;
        results.push({ name: item.name, status: passed ? 'passed' : 'refused',
          executedThisRun: true,
          durationMs: checked.durationMs, exitCode: checked.code,
          diagnosticCodes: checked.diagnosticCodes ?? [],
          ...(checked.cancelled ? { cancellationObserved: true } : {}),
          ...(checked.timedOut ? { timedOut: true } : {}),
          ...(!checked.custodyVerified ? { processOrOutputCustodyUnverified: true } : {}) });
        if (!passed) break;
      }
      stage.changedCodeValidation = { status: results.length === validators.length &&
        results.every(item => item.status === 'passed') ? 'passed' : 'refused',
      executedThisRun: results.some(item => item.executedThisRun),
      durationMs: duration(startedValidation), checks: results };
    }
    const validationPassed = stage.changedCodeValidation.status === 'passed';
    if (!validationPassed) {
      receipt.reason = 'local-update-changed-code-validation-refused';
      receipt.nextAction = 'repair-exact-validator-failure-and-reconfirm-test-scope-before-staging';
      // An unsettled/failed-spawn validator cannot be explained by a later
      // source census. Keep its actual process/output custody refusal first.
      if (results.some(check => check.processOrOutputCustodyUnverified ||
          check.cancelled || check.timedOut || check.reason === 'validator-executable-missing'))
        return finish(1);
    }
    // Even a known nonzero validator exit can be caused by another writer
    // replacing source or a selected test DURING validation. Pin that exact
    // epoch before calling the failure a stable-source test regression; never
    // erase the validator exit/diagnostic or resume staging on drift.
    // Preserve narrower dependency/test/tool drift before the full source
    // snapshot, which also contains package/lock and compiler inputs.
    const inputsStable = confirmInputIdentity();
    if (!inputsStable) {
      stage.changedCodeValidation.status = 'refused';
      return finish(1);
    }
    let after;
    let sourceStable = false;
    let snapshotObserved = false;
    const postSnapshotStarted = process.hrtime.bigint();
    try {
      observe('sourceQualification');
      after = await inspectedSourceEpoch(project, launcher, cancellation.signal);
      sourceStable = before.source === after.source &&
        before.compiler === after.compiler &&
        before.files === after.files;
      if (options.mode === 'companion') {
        const confirmedCompanion = companionSourceFingerprint(project);
        sourceStable = sourceStable &&
          confirmedCompanion.sha256 === testedCompanionFingerprint.sha256 &&
          confirmedCompanion.files === testedCompanionFingerprint.files &&
          confirmedCompanion.bytes === testedCompanionFingerprint.bytes;
      }
      snapshotObserved = true;
    } catch { /* refusal retains exact prior-good state */ }
    stage.sourceQualification = { status: sourceStable && snapshotObserved ? 'passed' : 'refused',
      durationMs: before.durationMs + (after?.durationMs ?? duration(postSnapshotStarted)),
      sourceSha256: before.source, sourceFileCount: before.files,
      snapshotObserved,
      snapshotsMatch: snapshotObserved ? sourceStable : null };
    if (!snapshotObserved) {
      stage.changedCodeValidation.status = 'refused';
      receipt.reason = 'local-update-source-snapshot-unverified';
      receipt.nextAction = 'restore-verifiable-post-validation-source-and-compiler-snapshot-before-staging';
      return finish(1);
    }
    if (!sourceStable) {
      stage.changedCodeValidation.status = 'refused';
      receipt.reason = 'local-update-source-changed-during-validation';
      receipt.nextAction = 'revalidate-exact-new-source-and-compiler-after-concurrent-writers-settle';
      return finish(1);
    }
    if (!validationPassed) return finish(1);
    testedSourceEpoch = before;
  }
  if (!confirmInputIdentity()) return finish(1);
  if (options.mode === 'companion') {
    observe('companionSource');
    const tick = process.hrtime.bigint();
    try {
      const companionPreparedEpoch = testedSourceEpoch ??
        await inspectedSourceEpoch(project, launcher, cancellation.signal);
      const fingerprint = companionSourceFingerprint(project);
      const confirmed = companionSourceFingerprint(project);
      if (fingerprint.sha256 !== confirmed.sha256 ||
          fingerprint.files !== confirmed.files || fingerprint.bytes !== confirmed.bytes)
        throw Error('local-update-companion-source-changed-during-inspection');
      if (testedCompanionFingerprint &&
          (fingerprint.sha256 !== testedCompanionFingerprint.sha256 ||
           fingerprint.files !== testedCompanionFingerprint.files ||
           fingerprint.bytes !== testedCompanionFingerprint.bytes))
        throw Error('local-update-companion-source-changed-after-validation');
      if (!confirmInputIdentity()) return finish(1);
      receipt.companionSource = fingerprint;
      // The incumbent native owner writes the equivalent lowercase tree hash
      // to .chat-on-steroids-source after atomic materialization. Matching it
      // does NOT prove the Chrome MV3 worker adopted those bytes. Keep actual
      // paused-account buffer custody, profile/PID/epoch and loaded revision
      // explicitly with chat24's existing runtime and incident-log owner.
      receipt.companionReloadHandoff = {
        schema: 'cos_dev_companion_reload_handoff_v1',
        fingerprintOwner: 'src/main/extension-path.ts:extensionFingerprint',
        expectedMaterializedSha256: fingerprint.sha256.toLowerCase(),
        requiredRuntimeIdentity: 'exact-profile-pid-process-birth-account-epoch',
        requiredNativeProof: 'materialized-fingerprint-paired-loaded-worker-revision-and-bridge-reattach',
        bufferedMessages: 'existing-owner-must-decide-safe-drain-or-explicit-discard-approval',
        diagnosticOwner: 'authenticated-profile-main-local-incidents',
        stageVerifiedOnly: true, loadedWorkerRevision: null,
        nativeReloadAttempted: false, loadedBytesVerified: false,
        productionActivationAllowed: false
      };
      if (options.reviewOnly) stage.changedCodeValidation = { status: 'source-asset-fingerprint-only',
        durationMs: duration(tick) };
      const risk = mainActivationRisk(project, originalInputs.installedBaseline);
      const atDecision = companionSourceFingerprint(project);
      if (atDecision.sha256 !== fingerprint.sha256 ||
          atDecision.files !== fingerprint.files || atDecision.bytes !== fingerprint.bytes)
        throw Error('local-update-companion-source-changed-during-inspection');
      if (!confirmInputIdentity()) return finish(1);
      if (!await confirmPreparedReadiness(companionPreparedEpoch, testedSourceEpoch))
        return finish(1);
      receipt.activationDecision = deferredActivationDecision('companion',
        originalInputs, risk, stage, { materialized: fingerprint.sha256.toLowerCase() });
      receipt.status = 'companion-source-inspected-only';
      receipt.nextAction = 'existing-companion-owner-reload-with-paused-account-buffer-custody-and-loaded-worker-proof';
      return finish(0);
    } catch (error) {
      receipt.reason = error.message?.startsWith('local-update-') ?
        error.message : 'local-update-companion-source-unverified';
      receipt.nextAction = 'inspect-exact-extension-source-ownership';
      return finish(1);
    }
  }
    observe('exactGenerationSelection');
    const selectionStarted = process.hrtime.bigint();
    let generation = null;
    let selectionMs = 0;
    let catalogCount = 0;
    let verifiedAttempts = 0;
    let staleRejected = 0;
    let metadataSkipped = 0;
    let reusedValidatedSelector = false;
    if (!options.rebuild) {
      const candidates = publishedGenerations(project);
      catalogCount = candidates.length;
      // Cache admission has already run the *authoritative full-output
      // selector* for this exact current source/compiler/test-input receipt.
      // A second immediate selector is redundant only when this is still the
      // newest matching generation in a fresh bounded catalog observation.
      // Never take this shortcut in review-only mode or for a newer generation
      // whose evidence was not the one admitted by the validation cache.
      const firstCurrent = testedSourceEpoch && candidates.find(existing =>
        existing.source === testedSourceEpoch.source &&
        existing.compiler === testedSourceEpoch.compiler);
      if (cachedValidation && cachedValidationGeneration && firstCurrent &&
          firstCurrent.name === cachedValidationGeneration.name &&
          firstCurrent.source === cachedValidationGeneration.source &&
          firstCurrent.compiler === cachedValidationGeneration.compiler &&
          firstCurrent.compiled === cachedValidationGeneration.compiled &&
          firstCurrent.generatedAt === cachedValidationGeneration.generatedAt) {
        generation = firstCurrent;
        reusedValidatedSelector = true;
        metadataSkipped = candidates.filter(existing =>
          existing.source !== testedSourceEpoch.source ||
          existing.compiler !== testedSourceEpoch.compiler).length;
      }
      for (const existing of generation ? [] : candidates) {
        // A successful just-completed source epoch cannot be paired with a
        // different old source/compiler generation. Excluding that NEGATIVE
        // match saves a child process per stale generation. Review-only
        // invocations still use every authoritative selector, and every
        // positive candidate must pass the exact whole-tree selector.
        if (testedSourceEpoch && (existing.source !== testedSourceEpoch.source ||
            existing.compiler !== testedSourceEpoch.compiler)) {
          metadataSkipped++;
          continue;
        }
        verifiedAttempts++;
        const result = await selectExactly(project, launcher, existing, cancellation.signal);
        selectionMs += result.durationMs;
        if (result.accepted) { generation = existing; break; }
        staleRejected++;
      }
    }
    if (generation) {
      receipt.buildStrategy = 'reuse-exact-source-private-generation';
      stage.exactGenerationSelection = { status: 'passed', durationMs: selectionMs,
        catalogCount, verifiedAttempts, staleRejected, metadataSkipped,
        reusedValidatedSelector,
        priorCacheSelectorAttempts: reusedValidatedSelector ?
          stage.validationCache.exactVerifierAttempts : 0,
        candidateOrder: 'newest-receipt-first-exact-selector-authoritative' };
      if (reusedValidatedSelector)
        stage.exactGenerationSelection.durationMs = duration(selectionStarted);
    } else {
      receipt.buildStrategy = 'new-reproducible-private-generation';
      stage.exactGenerationSelection = { status: options.rebuild ? 'not-run' : 'no-current-generation',
        durationMs: options.rebuild ? null : selectionMs, catalogCount,
        verifiedAttempts, staleRejected, metadataSkipped,
        candidateOrder: 'newest-receipt-first-exact-selector-authoritative' };
      observe('compiledStage');
      const built = await runExact(project, launcher, [
        '--qualify-build', '--confirm-reproducible', '--prepare-private-out', '--json'
      ], cancellation.signal);
      const r = built.receipt;
      if (!built.custodyVerified || r?.schema !== 'cos_dev_build_qualification_v1' || built.code !== 0 ||
          r.sourceBuildQualified !== true || r.reproducible !== true ||
          r.privateOutput?.published !== true ||
          r.privateOutput.sharedOutModified !== false ||
          r.privateOutput.sha256 !== r.compiledOutputSha256 ||
          r.nativeRuntimeVerified !== false || r.installedRuntimeVerified !== false ||
          !GENERATION.test(r.privateOutput.name ?? '') ||
          ![r.sourceSha256, r.compiledOutputSha256, r.toolchain?.electronViteCliSha256]
            .every(x => DIGEST.test(x ?? ''))) {
        receipt.reason = built.cancelled ? 'local-update-cancelled' :
          built.timedOut ? 'local-update-build-timeout' :
            !built.custodyVerified ? 'local-update-execution-custody-unverified' :
              'local-update-private-build-unverified';
        receipt.privateBuildFailure = boundedQualifierFailure(r);
        receipt.nextAction = !built.custodyVerified ?
          'inspect-unknown-original-compiler-descendant-and-output-custody' :
          receipt.privateBuildFailure?.nextActions?.[0] ??
            'inspect-bounded-incumbent-build-qualification-receipt-and-process-custody';
        stage.compiledStage = { status: 'refused', durationMs: built.durationMs,
          exitCode: built.code, failureClassification:
            receipt.privateBuildFailure?.failureClassification ?? 'unknown' };
        return finish(1);
      }
      generation = { name: r.privateOutput.name, source: r.sourceSha256,
        compiled: r.compiledOutputSha256, compiler: r.toolchain.electronViteCliSha256 };
      stage.compiledStage = { status: 'passed',
        durationMs: r.execution?.result?.durationMs ?? null,
        exitCode: r.execution?.result?.exitCode ?? null };
      stage.confirmationCompilation = { status: 'passed',
        durationMs: r.confirmationExecution?.durationMs ?? null,
        exitCode: r.confirmationExecution?.exitCode ?? null };
      stage.privatePublication = { status: 'passed',
        durationMs: r.privateOutput.durationMs ?? null };
      observe('exactGenerationSelection');
      const selected = await selectExactly(project, launcher, generation, cancellation.signal);
      stage.exactGenerationSelection = { status: selected.accepted ? 'passed' : 'refused',
        durationMs: selectionMs + selected.durationMs };
      if (!selected.accepted) {
        receipt.reason = 'local-update-published-generation-became-unverified';
        receipt.nextAction = 'inspect-current-source-compiler-and-private-generation-ownership';
        return finish(1);
      }
    }
    if (testedSourceEpoch && (generation.source !== testedSourceEpoch.source ||
        generation.compiler !== testedSourceEpoch.compiler)) {
      observe('sourceQualification');
      stage.sourceQualification.status = 'refused';
      receipt.reason = 'local-update-tested-source-no-longer-current';
      receipt.nextAction = 'revalidate-selected-private-generation-against-one-stable-source-epoch';
      return finish(1);
    }
    receipt.generation = generation.name;
    receipt.sourceSha256 = generation.source;
    receipt.compiledOutputSha256 = generation.compiled;
    receipt.compilerSha256 = generation.compiler;
    if (!confirmInputIdentity()) return finish(1);
    if (!options.reviewOnly && stage.changedCodeValidation.status === 'passed' &&
        originalInputs.validatorRuntime?.cacheReuseSafe !== false) {
      observe('validationCache');
      const cacheWriteStarted = process.hrtime.bigint();
      const storedValidation = writeValidationReceipt(project, generation, {
        mode: options.mode, source: testedSourceEpoch?.source ?? generation.source,
        compiler: testedSourceEpoch?.compiler ?? generation.compiler,
        inputDigest: originalInputs.digest,
        checks: cachedValidation?.checks ?? stage.changedCodeValidation.checks ?? [],
        durationMs: stage.changedCodeValidation.originalDurationMs ??
          stage.changedCodeValidation.durationMs
      });
      const writeDurationMs = duration(cacheWriteStarted);
      const lookupDurationMs = stage.validationCache.lookupDurationMs ?? 0;
      stage.validationCache = storedValidation ?
        { ...stage.validationCache,
          status: stage.changedCodeValidation.reused ? 'reused' : 'written',
          durationMs: lookupDurationMs + writeDurationMs,
          writeDurationMs, generation: generation.name,
          sourceSha256: generation.source, inputDigest: originalInputs.digest } :
        { ...stage.validationCache,
          status: 'not-written', durationMs: lookupDurationMs + writeDurationMs,
          writeDurationMs, reason: 'cache-write-unavailable' };
    } else if (!options.reviewOnly && stage.changedCodeValidation.status === 'passed') {
      stage.validationCache = { ...stage.validationCache,
        status: 'inherited-runtime-cache-bypassed', writeDurationMs: null,
        reason: originalInputs.validatorRuntime.cacheBypassReason };
    }
    if (options.mode === 'renderer') {
      preparationEnded = process.hrtime.bigint();
      privateReviewStarted = preparationEnded;
      observe('rendererHealth');
      if (options.interactivePreview) {
        // Exactly one supported local-update foreground control for staging,
        // selected-byte health, explicit use/restore and stop. It reuses the
        // existing exclusive preview lease and its memory-backed prior-good
        // generation; no Electron Main, companion or installed file is started.
        const { runPrivateRendererPreview } = await import('./dev-fast-preview.mjs');
        const tick = process.hrtime.bigint();
        const observed = { ready: null, last: null, changes: 0, restorations: 0,
          refusedTransitions: 0, stopped: null, lastRefusal: null,
          readyAt: null, stoppedAt: null, timingsUnverified: false,
          switchMs: 0, lastSwitchMs: null,
          restorationMs: 0, lastRestorationMs: null };
        const recordTransition = (event, kind) => {
          if (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0) {
            observed.timingsUnverified = true;
            return;
          }
          const totalKey = kind === 'switch' ? 'switchMs' : 'restorationMs';
          const lastKey = kind === 'switch' ? 'lastSwitchMs' : 'lastRestorationMs';
          const sum = observed[totalKey] + event.durationMs;
          if (!Number.isSafeInteger(sum)) observed.timingsUnverified = true;
          else { observed[totalKey] = sum; observed[lastKey] = event.durationMs; }
        };
        const previewExit = await runPrivateRendererPreview({
          args: [
            `--preview-private-out=${generation.name}`,
            `--expect-source-sha256=${generation.source}`,
            `--expect-compiled-sha256=${generation.compiled}`,
            `--expect-compiler-sha256=${generation.compiler}`, '--json'
          ],
          project, launcher, windowsProcessBirth, windowsPostSpawnProcessesClear,
          externalSignal: cancellation.signal,
          onReceipt: event => {
            if (event.event === 'ready') {
              observed.ready = observed.last = event;
              observed.readyAt = process.hrtime.bigint();
            }
            if (event.event === 'activated') {
              observed.changes++; observed.last = event;
              recordTransition(event, 'switch');
            }
            if (event.event === 'restored') {
              observed.restorations++; observed.last = event;
              recordTransition(event, 'restoration');
            }
            if (event.event === 'refused') {
              observed.refusedTransitions++;
              observed.lastRefusal = { reason: /^private-preview-[a-z0-9-]+$/.test(event.reason ?? '') ?
                event.reason : 'private-preview-activation-unverified',
                previousGenerationPreserved: event.historyPreserved === true,
                activeGeneration: event.activeGeneration ?? null };
            }
            if (event.event === 'stopped') {
              observed.stopped = event;
              observed.stoppedAt = process.hrtime.bigint();
            }
          }
        });
        privateReviewEnded = process.hrtime.bigint();
        postPrivateReadinessStarted = privateReviewEnded;
        const initialAssetVerificationMs = Number.isSafeInteger(observed.ready?.durationMs) &&
          observed.ready.durationMs >= 0 ? observed.ready.durationMs : null;
        privateReviewBreakdown = {
          initialAssetVerificationMs,
          interactiveWindowMs: observed.readyAt !== null && observed.stoppedAt !== null ?
            duration(observed.readyAt, observed.stoppedAt) : null,
          interactiveWindowIncludesOperatorDwellAndOperations: true
        };
        stage.privateSwitch = observed.changes > 0 ? {
          status: observed.lastSwitchMs !== null && !observed.timingsUnverified ? 'passed' : 'refused',
          durationMs: observed.lastSwitchMs,
          totalDurationMs: observed.switchMs, count: observed.changes,
          scope: 'isolated-loopback-only'
        } : notRun('no-private-renderer-switch');
        stage.privateRestoration = observed.restorations > 0 ? {
          status: observed.lastRestorationMs !== null && !observed.timingsUnverified ? 'passed' : 'refused',
          durationMs: observed.lastRestorationMs,
          totalDurationMs: observed.restorationMs, count: observed.restorations,
          scope: 'same-process-previous-health-verified-memory'
        } : notRun('no-private-renderer-restoration');
        const finalServed = observed.last ?? observed.ready;
        const privateProof = observed.ready?.healthConfirmed === true &&
          DIGEST.test(observed.ready?.servedRendererSha256 ?? '') &&
          DIGEST.test(observed.ready?.qualifiedRendererManifestSha256 ?? '') &&
          observed.ready.httpVerifiedAssetCount === observed.ready.assetCount &&
          observed.ready.httpVerifiedAssetBytes === observed.ready.assetBytes &&
          finalServed?.healthConfirmed === true &&
          DIGEST.test(finalServed.servedRendererSha256 ?? '') &&
          DIGEST.test(finalServed.qualifiedRendererManifestSha256 ?? '') &&
          finalServed.httpVerifiedAssetCount === finalServed.assetCount &&
          finalServed.httpVerifiedAssetBytes === finalServed.assetBytes &&
          observed.stopped?.lastServedRendererSha256 === finalServed.servedRendererSha256;
        stage.rendererHealth = { status: previewExit === 0 && privateProof &&
          initialAssetVerificationMs !== null && !observed.timingsUnverified &&
          observed.stopped?.leaseReleased === true ? 'passed' : 'refused',
        durationMs: initialAssetVerificationMs,
        sessionDurationMs: duration(tick), exitCode: previewExit,
        activationDurationMs: observed.ready?.durationMs ?? null };
        receipt.rendererConsumption = {
          targetKind: 'isolated-loopback-renderer-only',
          startingGeneration: generation.name,
          lastConfirmedGeneration: observed.last?.generation ?? null,
          updatedGenerations: observed.changes, restorations: observed.restorations,
          refusedTransitions: observed.refusedTransitions,
          lastRefusal: observed.lastRefusal,
          lastConfirmedServedRendererSha256: observed.last?.servedRendererSha256 ?? null,
          lastQualifiedRendererManifestSha256: observed.last?.qualifiedRendererManifestSha256 ?? null,
          lastHttpVerifiedAssetCount: observed.last?.httpVerifiedAssetCount ?? null,
          lastHttpVerifiedAssetBytes: observed.last?.httpVerifiedAssetBytes ?? null,
          rollbackEvidence: observed.restorations > 0 ?
            'same-process-previous-health-verified-memory' :
            'no-restore-performed',
          leaseReleased: observed.stopped?.leaseReleased === true,
          nativeRuntimeVerified: false, installedRuntimeVerified: false
        };
        if (stage.rendererHealth.status !== 'passed') {
          receipt.reason = 'local-update-foreground-preview-unverified';
          receipt.nextAction = 'inspect-exact-preview-lease-health-and-interrupted-generation-before-retry';
          return finish(1);
        }
        const risk = mainActivationRisk(project, originalInputs.installedBaseline);
        if (!await confirmPreparedReadiness(generation, testedSourceEpoch)) return finish(1);
        receipt.activationDecision = deferredActivationDecision('renderer',
          originalInputs, risk,
          stage, generation);
        receipt.activationDecision.privateRendererHttp = {
          servedRendererSha256: finalServed.servedRendererSha256,
          qualifiedRendererManifestSha256: finalServed.qualifiedRendererManifestSha256,
          verifiedAssetCount: finalServed.httpVerifiedAssetCount,
          verifiedAssetBytes: finalServed.httpVerifiedAssetBytes,
          sourceGeneration: finalServed.generation,
          evidence: 'private-loopback-asset-responses-only',
          nativeRuntimeVerified: false, installedRuntimeVerified: false
        };
        receipt.status = 'renderer-foreground-preview-session-verified';
        receipt.nextAction = 'native-css-hmr-and-loaded-electron-document-require-task-owned-app-shell-proof';
        return finish(0);
      }
      const probe = await runExact(project, launcher, [
        `--probe-private-out=${generation.name}`,
        `--expect-source-sha256=${generation.source}`,
        `--expect-compiled-sha256=${generation.compiled}`,
        `--expect-compiler-sha256=${generation.compiler}`, '--json'
      ], cancellation.signal);
      privateReviewEnded = process.hrtime.bigint();
      postPrivateReadinessStarted = privateReviewEnded;
      // The preview prints one ready + one stopped line, not a single JSON.
      // Never infer lifecycle success from its wrapper exit status alone.
      const messages = probe.lines ?? [];
      const [ready, stopped] = messages;
      if (ready?.schema !== 'cos_dev_renderer_preview_v1' ||
          ready.event !== 'ready' || ready.healthConfirmed !== true ||
          ready.generation !== generation.name ||
          ready.sourceSha256 !== generation.source ||
          ready.compiledOutputSha256 !== generation.compiled ||
          ready.compilerSha256 !== generation.compiler ||
          ready.targetKind !== 'isolated-loopback-renderer-only' ||
          ready.nativeRuntimeVerified !== false ||
          !DIGEST.test(ready.servedRendererSha256 ?? '') ||
          !DIGEST.test(ready.qualifiedRendererManifestSha256 ?? '') ||
          ready.httpVerifiedAssetCount !== ready.assetCount ||
          ready.httpVerifiedAssetBytes !== ready.assetBytes ||
          stopped?.event !== 'stopped' || stopped.leaseReleased !== true ||
          stopped.lastServedRendererSha256 !== ready.servedRendererSha256 ||
          stopped.nativeRuntimeVerified !== false || stopped.sharedOutModified !== false ||
          probe.code !== 0 || !probe.custodyVerified) {
        stage.rendererHealth = { status: 'refused', durationMs: probe.durationMs,
          exitCode: probe.code };
        receipt.reason = 'local-update-renderer-health-or-cleanup-unverified';
        receipt.nextAction = 'inspect-exact-preview-owner-and-stale-lease-before-retry';
        return finish(1);
      }
      receipt.rendererAssets = { count: ready.assetCount, bytes: ready.assetBytes,
        servedRendererSha256: ready.servedRendererSha256,
        qualifiedRendererManifestSha256: ready.qualifiedRendererManifestSha256,
        httpVerifiedAssetCount: ready.httpVerifiedAssetCount,
        httpVerifiedAssetBytes: ready.httpVerifiedAssetBytes };
      stage.rendererHealth = { status: 'passed', durationMs: probe.durationMs,
        activationDurationMs: ready.durationMs, exitCode: probe.code };
      const risk = mainActivationRisk(project, originalInputs.installedBaseline);
      if (!await confirmPreparedReadiness(generation, testedSourceEpoch)) return finish(1);
      receipt.activationDecision = deferredActivationDecision('renderer',
        originalInputs, risk,
        stage, generation);
      receipt.activationDecision.privateRendererHttp = {
        servedRendererSha256: ready.servedRendererSha256,
        qualifiedRendererManifestSha256: ready.qualifiedRendererManifestSha256,
        verifiedAssetCount: ready.httpVerifiedAssetCount,
        verifiedAssetBytes: ready.httpVerifiedAssetBytes,
        sourceGeneration: ready.generation,
        evidence: 'private-loopback-asset-responses-only',
        nativeRuntimeVerified: false, installedRuntimeVerified: false
      };
      receipt.status = 'renderer-private-review-verified';
      receipt.nextAction = 'use-existing-vite-css-hmr-in-task-owned-development-runtime-then-prove-native-loaded-version';
      return finish(0);
    }
    observe('mainActivationPreflight');
    const mainTick = process.hrtime.bigint();
    const first = mainOutputManifest(project, generation);
    const reselected = await selectExactly(project, launcher, generation, cancellation.signal);
    if (!reselected.accepted) throw Error('local-update-main-generation-became-stale');
    const second = mainOutputManifest(project, generation);
    if (JSON.stringify(first) !== JSON.stringify(second))
      throw Error('local-update-main-output-changed-during-qualification');
    if (!confirmInputIdentity()) return finish(1);
    const risk = mainActivationRisk(project, originalInputs.installedBaseline);
    if (!await confirmPreparedReadiness(generation, testedSourceEpoch)) return finish(1);
    receipt.mainActivationHandoff = mainHandoff(generation, originalInputs, first, risk);
    receipt.activationDecision = deferredActivationDecision('main',
      originalInputs, risk, stage, generation);
    stage.mainActivationPreflight = { status: 'passed', durationMs: duration(mainTick),
      exactSelectionDurationMs: reselected.durationMs, mainPreloadFiles: first.fileCount,
      installedRiskScope: risk.scope ?? 'unverified' };
    receipt.status = 'main-private-stage-verified-only';
    receipt.nextAction = risk.scope === 'release-risk' ?
      'root-release-owner-must-requalify-package-dependency-native-or-unknown-source-differences-before-any-main-activation' :
      'coordinate-verified-profile-drain-with-current-root-and-activate-only-an-owned-native-runtime-after-full-risk-qualification';
    return finish(0);
  } catch (error) {
    if (stage[observedStage]?.status === 'not-run')
      stage[observedStage] = { status: 'refused', durationMs: duration(observedStageStarted) };
    receipt.reason = /^local-update-[a-z0-9-]{1,80}$/.test(error?.message ?? '') ?
      error.message : 'local-update-workflow-unverified';
    receipt.nextAction = 'inspect-original-private-output-and-process-ownership-before-retry';
    return finish(1);
  }
}

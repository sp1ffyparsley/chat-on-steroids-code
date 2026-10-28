import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The launcher is anchored to its own checkout, even when invoked by an absolute path from
// another working directory. CWD must never select another app-data or bridge owner.
const checkoutPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows file names are case-insensitive, but the spelling of a Node script path is not.
// Resolve the actual directory spelling so invoking the same checkout through a differently
// cased absolute path cannot create a second isolated dev owner. Keep the existing identity
// for the canonical path so prior private development state is not silently abandoned.
const project = process.platform === 'win32' ? realpathSync.native(checkoutPath) : checkoutPath;
const identity = createHash('sha256').update(project).digest('hex').slice(0, 12);
const userData = path.join(os.tmpdir(), 'chat-on-steroids-fast-dev', identity);
// The launcher stays alive as the electron-vite supervisor. Reserve one atomic directory
// per private root before spawning; /hello cannot detect another cold watcher yet.
const launchLockDir = path.join(userData, '.dev-fast-launch');
const launchOwnerFile = path.join(launchLockDir, 'owner.json');
const electronVite = path.join(project, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
const viteReady = existsSync(electronVite);
const args = process.argv.slice(2);
const previewRequested = args.some(arg => arg.startsWith('--preview-private-out=') ||
  arg.startsWith('--probe-private-out=')) || args.includes('--recover-private-preview');
const localUpdateRequested = args.some(arg => arg.startsWith('--local-update'));
const checkOnly = args.includes('--check');
const jsonOutput = args.includes('--json');
const recoverRequested = args.includes('--recover');
const helpRequested = args.includes('--help') || args.includes('-h');
const qualifyBuildRequested = args.includes('--qualify-build');
// electron-vite v5 parses options before `--` itself. Its `--` arguments are
// forwarded to Electron, which owns the `--background` startup option.
const separatorIndex = args.indexOf('--');
const viteOptions = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
const electronOptions = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);
const forwardedBackground = viteOptions.includes('--background') && !electronOptions.includes('--background');
const electronForwarded = [...electronOptions, ...(forwardedBackground ? ['--background'] : [])];
const electronArguments = [
  ...viteOptions.filter(option => option !== '--background'),
  ...(electronForwarded.length ? ['--', ...electronForwarded] : [])
];
// Every private listener that a watcher could leave behind must be accounted
// for before a post-spawn reservation can be reclaimed.
const debuggerOptions = electronForwarded.filter(value => value.startsWith('--remote-debugging-port'));
const requestedDebuggerPort = debuggerOptions.length === 0 ? null :
  debuggerOptions.length === 1 && /^--remote-debugging-port=\d{1,5}$/.test(debuggerOptions[0])
    ? Number(debuggerOptions[0].split('=')[1]) : 'unknown';
const debuggerPort = typeof requestedDebuggerPort === 'number' &&
  (requestedDebuggerPort < 1 || requestedDebuggerPort > 65535) ? 'unknown' : requestedDebuggerPort;
const BRIDGE_PORT_MIN = 8765;
const BRIDGE_PORT_MAX = 8796;
// The renderer's current electron-vite config uses Vite's default localhost:5173.
// Vite would otherwise silently choose 5174+, breaking the expected dev/CDP URL.
const RENDERER_DEFAULT_PORT = 5173;
const MAX_HELLO_BYTES = 4096;
const buildTimeoutText = process.env.COS_DEV_FAST_BUILD_TIMEOUT_MS ?? String(10 * 60 * 1000);
const BUILD_EXECUTION_TIMEOUT_MS = Number(buildTimeoutText);
// Node clamps NaN, zero and overflowed timers to near-immediate deadlines.
// Refuse malformed overrides for the review-only build before creating a stage.
const buildTimeoutValid = /^[1-9]\d*$/.test(buildTimeoutText) &&
  Number.isSafeInteger(BUILD_EXECUTION_TIMEOUT_MS) &&
  BUILD_EXECUTION_TIMEOUT_MS >= 20 && BUILD_EXECUTION_TIMEOUT_MS <= 60 * 60 * 1000;
// The development bridge advertises its checkout-private data root as an opaque stable ID.
// Query only occupied loopback ports: unlike a free-port probe, this can recognize an already
// running instance before another watcher tries to share its Electron userData directory.
const normalizedDevRoot = process.platform === 'win32' ? userData.toLowerCase() : userData;
const expectedDevId = `dev-${createHash('sha256').update(normalizedDevRoot).digest('hex').slice(0, 24)}`;

// Windows PID alone is not an owner: the same number can belong to a later process.
// A failed/unknown process query is not permission to remove another owner's state.
const windowsProcessBirth = pid => {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1) return null;
  // This single-process identity lookup does not need WMI/CIM provider initialization
  // inside the bounded preview-identity deadline.
  // Keep the persisted CIM timestamp precision (microseconds) for existing owner records;
  // access/handle failures remain unknown, never an absence or a new lease authority.
  const code = `$ErrorActionPreference='Stop';try{$p=[Diagnostics.Process]::GetProcessById(${pid})}catch [ArgumentException]{'absent';exit 0};` +
    `try{$birth=$p.StartTime.ToUniversalTime();[DateTime]::new($birth.Ticks-($birth.Ticks%10),[DateTimeKind]::Utc).ToString('o')}finally{$p.Dispose()}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8', timeout: 4000, windowsHide: true, maxBuffer: 1024
  });
  if (result.status !== 0 || result.error) return null;
  const value = result.stdout.trim();
  return value === 'absent' || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/.test(value) ? value : null;
};

// Separate native process evidence from the lossy parent exit status. Windows
// retains ParentProcessId after a parent exits; walk the entire remaining tree,
// and independently look for same-checkout Vite/Electron processes. Return only
// a decision, never process command lines, arguments, or private profile data.
const windowsPostSpawnProcessesClear = (ownerPid, childPid, diagnostic = null) => {
  if (process.platform !== 'win32') return false;
  const source = Buffer.from(project, 'utf16le').toString('base64');
  const code = `$ErrorActionPreference='Stop';` +
    `$root=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${source}'));` +
    `$nodes=@(Get-CimInstance Win32_Process);` +
    // This verification PowerShell is itself a temporary child of the
    // launcher. Never count the observing process as a surviving watcher
    // descendant when qualifying cleanup from the launcher's exit handler.
    `$observerPid=[int]$PID;` +
    `$parents=New-Object 'System.Collections.Generic.HashSet[int]';` +
    `[void]$parents.Add(${ownerPid});[void]$parents.Add(${childPid});` +
    `$busy=$false;$changed=$true;` +
    `while($changed){$changed=$false;foreach($p in $nodes){` +
    `if($p.ProcessId -ne ${process.pid} -and $p.ProcessId -ne $observerPid -and $parents.Contains([int]$p.ParentProcessId)){` +
    `$busy=$true;if($parents.Add([int]$p.ProcessId)){$changed=$true}}}};` +
    `foreach($p in $nodes){if($p.ProcessId -eq ${process.pid}){continue};` +
    `if($p.Name -in @('node.exe','electron.exe')){` +
    `$command=[string]$p.CommandLine;$exe=[string]$p.ExecutablePath;` +
    `if(($command.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and ` +
    `($command.IndexOf('electron-vite',[StringComparison]::OrdinalIgnoreCase) -ge 0 -or ` +
    `$command.IndexOf('dev-fast.mjs',[StringComparison]::OrdinalIgnoreCase) -ge 0)) -or ` +
    `($p.Name -eq 'electron.exe' -and $exe.IndexOf($root+'\\node_modules\\electron\\dist\\',[StringComparison]::OrdinalIgnoreCase) -eq 0)){$busy=$true}}};` +
    `if($busy){'busy'}else{'clear'}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8', timeout: 7000, windowsHide: true, maxBuffer: 1024
  });
  const verdict = result.status === 0 && !result.error ? result.stdout.trim() : null;
  if (diagnostic) diagnostic.reason = verdict === 'busy'
    ? 'descendant-or-runtime-present' : 'process-census-unverified';
  return verdict === 'clear';
};

// A verified private renderer preview has a separate, foreground lifetime.
// Keep the *entire* incumbent watcher/recovery implementation in one sibling
// lexical scope: its recovery helpers must see the later port reservation and
// bridge-owner variables. A split scope accidentally turns recovery into a
// caught ReferenceError and strands valid Windows reservations.
if (previewRequested) {
  const { runPrivateRendererPreview } = await import('./dev-fast-preview.mjs');
  process.exitCode = await runPrivateRendererPreview({
    args, project, launcher: fileURLToPath(import.meta.url),
    windowsProcessBirth, windowsPostSpawnProcessesClear
  });
} else if (localUpdateRequested) {
  const { runPersonalLocalUpdate } = await import('./dev-fast-local-update.mjs');
  process.exitCode = await runPersonalLocalUpdate({
    args, project, launcher: fileURLToPath(import.meta.url),
    windowsProcessBirth, windowsPostSpawnProcessesClear
  });
} else {

const recoverAbandonedReservation = () => {
  if (process.platform !== 'win32') return false;
  try {
    if (!lstatSync(launchLockDir).isDirectory() || lstatSync(launchLockDir).isSymbolicLink()) return false;
    // Reject private profile junctions/symlinks and extra files; never follow an unknown
    // reservation path or clean an unfamiliar directory.
    if (realpathSync.native(userData).toLowerCase() !== path.resolve(userData).toLowerCase()) return false;
    if (readdirSync(launchLockDir).join(',') !== 'owner.json') return false;
    if (!lstatSync(launchOwnerFile).isFile() || lstatSync(launchOwnerFile).isSymbolicLink()) return false;
    const bytes = readFileSync(launchOwnerFile, 'utf8');
    if (bytes.length > 1024) return false;
    const owner = JSON.parse(bytes);
    if (owner?.schema !== 1 || owner.phase !== 'reserved' || owner.checkout !== project ||
        owner.identity !== identity || !/^[\da-f-]{36}$/i.test(owner.token) ||
        !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
        typeof owner.startedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(owner.startedAt) ||
        Object.hasOwn(owner, 'childPid')) return false;
    const current = windowsProcessBirth(owner.pid);
    if (current === null || current === owner.startedAt) return false;
    // The reservation was durably pre-spawn; any 'spawning' or 'running' record
    // is deliberately nonrecoverable without independent descendant proof.
    const quarantined = path.join(userData, `.dev-fast-reclaimed-${randomUUID()}`);
    renameSync(launchLockDir, quarantined); // Single atomic claimant; loser must fail closed.
    if (readFileSync(path.join(quarantined, 'owner.json'), 'utf8') !== bytes) return false;
    unlinkSync(path.join(quarantined, 'owner.json'));
    rmdirSync(quarantined);
    return true;
  } catch {
    return false; // Incomplete/corrupt/legacy owner, permission error, or concurrent reclaim.
  }
};

// A previously spawned watcher may be released only when both immutable
// process identities have ended, there are no live descendants or matching
// checkout runtimes, and all of its recorded private listeners are free.
// Old spawning markers without a child birth receipt remain unrecoverable.
let recoveryRefusal = null;
const refuseRecovery = reason => { recoveryRefusal = reason; return false; };
const recoverVerifiedPostSpawn = async () => {
  if (process.platform !== 'win32') return false;
  try {
    if (!lstatSync(launchLockDir).isDirectory() || lstatSync(launchLockDir).isSymbolicLink() ||
        realpathSync.native(userData).toLowerCase() !== path.resolve(userData).toLowerCase() ||
        readdirSync(launchLockDir).join(',') !== 'owner.json' ||
        !lstatSync(launchOwnerFile).isFile() || lstatSync(launchOwnerFile).isSymbolicLink())
      return refuseRecovery('reservation-shape-unverified');
    const bytes = readFileSync(launchOwnerFile, 'utf8');
    if (bytes.length > 1024) return refuseRecovery('reservation-shape-unverified');
    const owner = JSON.parse(bytes);
    if (owner?.schema !== 1 || owner.phase !== 'spawning' || owner.checkout !== project ||
        owner.identity !== identity || !/^[\da-f-]{36}$/i.test(owner.token) ||
        !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
        !Number.isSafeInteger(owner.childPid) || owner.childPid < 1 ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/.test(owner.startedAt || '') ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/.test(owner.childStartedAt || '') ||
        owner.bridgePort !== bridgePort || owner.rendererPort !== RENDERER_DEFAULT_PORT ||
        !(owner.debugPort === null || (Number.isSafeInteger(owner.debugPort) && owner.debugPort > 0 && owner.debugPort <= 65535)))
      return refuseRecovery('insufficient-reservation-evidence');
    const parentNow = windowsProcessBirth(owner.pid);
    const childNow = windowsProcessBirth(owner.childPid);
    // A reused PID can become another process's parent during our census.
    // Require literal absence for both recorded PIDs; ambiguity never grants
    // custody of that PID or its potentially inherited descendants.
    if (parentNow === null || childNow === null) return refuseRecovery('process-identity-unverified');
    if (parentNow !== 'absent' || childNow !== 'absent') return refuseRecovery('process-still-present');
    const ports = [owner.rendererPort, owner.bridgePort, ...(owner.debugPort === null ? [] : [owner.debugPort])];
    if (!(await Promise.all(ports.map(port => portAvailable(port, port === RENDERER_DEFAULT_PORT ? 'localhost' : '127.0.0.1')))).every(Boolean))
      return refuseRecovery('listener-unavailable');
    const census = {};
    if (!windowsPostSpawnProcessesClear(owner.pid, owner.childPid, census)) return refuseRecovery(census.reason);
    // Reobserve resources and process identities after the census. The lock
    // still prevents any compliant launcher from starting during these checks.
    if (windowsProcessBirth(owner.pid) !== parentNow || windowsProcessBirth(owner.childPid) !== childNow)
      return refuseRecovery('process-identity-changed');
    if (!(await Promise.all(ports.map(port => portAvailable(port, port === RENDERER_DEFAULT_PORT ? 'localhost' : '127.0.0.1')))).every(Boolean))
      return refuseRecovery('listener-unavailable');
    const quarantined = path.join(userData, `.dev-fast-verified-postspawn-${randomUUID()}`);
    renameSync(launchLockDir, quarantined);
    // Keep the exact evidence during the atomic claim. Once the ownership
    // decision is complete, release the reservation itself; leaving a renamed
    // recovery marker can block the next admission even though custody was
    // already resolved.
    if (readFileSync(path.join(quarantined, 'owner.json'), 'utf8') !== bytes) return refuseRecovery('marker-changed');
    unlinkSync(path.join(quarantined, 'owner.json'));
    rmdirSync(quarantined);
    return true;
  } catch { return refuseRecovery('reservation-check-failed'); }
};

// A reservation phase describes *possible child custody*, not app readiness.
// Inspection is read-only and never decides that an owner is dead or unlockable.
const inspectLaunchOwner = () => {
  const unknown = { phase: 'unknown', process: 'unknown' };
  try {
    if (!lstatSync(launchLockDir).isDirectory() || lstatSync(launchLockDir).isSymbolicLink() ||
        !lstatSync(launchOwnerFile).isFile() || lstatSync(launchOwnerFile).isSymbolicLink() ||
        realpathSync.native(userData).toLowerCase() !== path.resolve(userData).toLowerCase()) return unknown;
    const bytes = readFileSync(launchOwnerFile, 'utf8');
    if (bytes.length > 1024) return unknown;
    const owner = JSON.parse(bytes);
    if (owner?.schema !== 1 || owner.checkout !== project || owner.identity !== identity ||
        !/^[\da-f-]{36}$/i.test(owner.token) ||
        !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
        typeof owner.startedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(owner.startedAt) ||
        !['reserved', 'spawning'].includes(owner.phase)) return unknown;
    const current = windowsProcessBirth(owner.pid);
    return { phase: owner.phase, process: current === null ? 'unknown' :
      current === 'absent' ? 'absent' : current === owner.startedAt ? 'same' : 'reused' };
  } catch { return unknown; }
};

if (helpRequested) {
  console.log('Usage: npm run dev -- [electron-vite options]');
  console.log('       node scripts/dev-fast.mjs --check');
  console.log('       node scripts/dev-fast.mjs --recover');
  console.log('       node scripts/dev-fast.mjs --qualify-build --json');
  console.log('');
  console.log('Common flow:');
  console.log('  npm ci                 Install checkout dependencies.');
  console.log('  npm run dev -- --check Run a read-only development preflight.');
  console.log('  npm run dev            Start the isolated source-edit workflow.');
  console.log('');
  console.log('Options:');
  console.log('  --check   Read-only source preflight; does not start Electron.');
  console.log('  --recover Recover only a proven dead, pre-spawn Windows reservation; never launches.');
  console.log('  --json    Emit bounded machine-readable preflight output with --check.');
  console.log('  --qualify-build  Rebuild into checkout-private .test_tmp; compare content to existing out/ without modifying it.');
  console.log('  --qualify-build --snapshot-source --json  Read-only current source/compiler identity using the exact build/selection manifest; no compile or native launch.');
  console.log('  --confirm-reproducible  With --qualify-build, independently build a second stage and refuse differing compiled bytes.');
  console.log('  --prepare-private-out  With --qualify-build --confirm-reproducible, atomically publish a new immutable private out/ snapshot; never replace shared out/.');
  console.log('  --probe-private-out=<id>  Serve exact verified renderer bytes in a temporary localhost preview, perform health checks and stop.');
  console.log('  --preview-private-out=<id>  Start a foreground localhost renderer preview; JSON stdin commands use, restore, status, stop.');
  console.log('    Both preview forms require --expect-source-sha256, --expect-compiled-sha256, --expect-compiler-sha256 and --json.');
  console.log('  --recover-private-preview  Reclaim only a positively dead exact preview owner; never opens a renderer or deletes generations.');
  console.log('  --local-update=renderer|main|companion --review-only --json  Exact private stage/reuse, renderer HTTP proof or companion source inspection, with timed blocked native gates.');
  console.log('    --local-update=renderer --interactive-preview --json validates first, then runs one owned foreground renderer session (status/use/restore/stop on stdin).');
  console.log('    --rebuild forces a fresh private generation for renderer/main; default reuses a current exactly verified generation.');
  console.log('  COS_DEV_FAST_BUILD_TIMEOUT_MS  Optional per-build timeout, 20..3600000 integer milliseconds (default 600000).');
  console.log('  Ctrl+C / SIGTERM  Stop the active review compiler; a cancellation is reported separately from a timeout.');
  console.log('  --select-stage=chat42-compiled-<id>  With --qualify-build, read-only reselect an exact staged artifact.');
  console.log('    Requires --expect-source-sha256, --expect-compiled-sha256 and --expect-compiler-sha256.');
  console.log('  -h, --help Show this launcher help.');
  console.log('');
  console.log('Evidence boundary: --check and --qualify-build are source/build diagnostics only.');
  console.log('Native runtime execution and installed release validation require their own qualification owners.');
  console.log('Preview consumes renderer bytes only; Electron Main/preload/HMR and installed release remain unverified.');
  console.log('');
  console.log('The launcher keeps development state isolated and forwards other options to electron-vite.');
  process.exit(0);
}

// A generated bundle is not proved current merely because its timestamp is
// recent or Vite reported success. Rebuild with the *incumbent* electron-vite
// compiler into a fresh, separately owned output directory; compare its exact
// file manifest against the old out/, and fence all observed input/output bytes.
// This never edits out/, never launches Electron and is not native acceptance.
if (qualifyBuildRequested) {
  const privateOutputRequested = args.includes('--prepare-private-out');
  const sourceSnapshotRequested = args.includes('--snapshot-source');
  const stageSelection = args.filter(arg => arg.startsWith('--select-stage='));
  const sourceExpectations = args.filter(arg => arg.startsWith('--expect-source-sha256='));
  const outputExpectations = args.filter(arg => arg.startsWith('--expect-compiled-sha256='));
  const compilerExpectations = args.filter(arg => arg.startsWith('--expect-compiler-sha256='));
  const shaValue = entry => entry?.split('=')[1] ?? null;
  const selecting = stageSelection.length > 0;
  const selectedName = shaValue(stageSelection[0]);
  const selectedPrivateOutput = /^chat42-private-out-[\da-f-]{36}$/i.test(selectedName ?? '');
  const selectionValid = selecting &&
    stageSelection.length === 1 && sourceExpectations.length === 1 &&
    outputExpectations.length === 1 && compilerExpectations.length === 1 &&
    (/^chat42-compiled-[A-Za-z0-9_-]{6,80}$/.test(selectedName ?? '') || selectedPrivateOutput) &&
    [sourceExpectations[0], outputExpectations[0], compilerExpectations[0]]
      .every(entry => /^[a-f0-9]{64}$/i.test(shaValue(entry) ?? ''));
  if (args.some(arg => !['--qualify-build', '--json', '--confirm-reproducible', '--prepare-private-out', '--snapshot-source'].includes(arg) &&
      !arg.startsWith('--select-stage=') &&
      !arg.startsWith('--expect-source-sha256=') &&
      !arg.startsWith('--expect-compiled-sha256=') &&
      !arg.startsWith('--expect-compiler-sha256=')) ||
      args.filter(arg => arg === '--qualify-build').length !== 1 ||
      args.filter(arg => arg === '--json').length > 1 ||
      args.filter(arg => arg === '--confirm-reproducible').length > 1 ||
      args.filter(arg => arg === '--prepare-private-out').length > 1 ||
      args.filter(arg => arg === '--snapshot-source').length > 1 ||
      (sourceSnapshotRequested && (selecting || privateOutputRequested ||
        args.includes('--confirm-reproducible') ||
        args.filter(arg => arg === '--json').length !== 1)) ||
      (privateOutputRequested && (!args.includes('--confirm-reproducible') || selecting)) ||
      (selecting && (!selectionValid || args.includes('--confirm-reproducible'))) ||
      (!selecting && (sourceExpectations.length || outputExpectations.length || compilerExpectations.length))) {
    console.error('[Chat On Steroids dev] invalid build qualification option; private output requires two reproducible builds and exact read-only selection requires source, output and compiler SHA-256.');
    process.exit(1);
  }
  const confirmReproducible = args.includes('--confirm-reproducible');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
  const recordTree = (root, names) => {
    const entries = [];
    const walk = (absolute, relative) => {
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw Error('unverified-linked-build-input');
      if (info.isDirectory()) {
        for (const entry of readdirSync(absolute).sort()) walk(path.join(absolute, entry),
          relative ? `${relative}/${entry}` : entry);
      } else if (info.isFile()) {
        if (info.size > 64 * 1024 * 1024 || entries.length >= 20000) throw Error('unbounded-build-input');
        entries.push({ file: relative.replaceAll('\\', '/'), size: info.size,
          sha256: sha(readFileSync(absolute)) });
      } else throw Error('unsupported-build-input');
    };
    for (const name of names) walk(path.join(root, name), name);
    const files = entries.sort((a, b) => a.file.localeCompare(b.file, 'en'));
    return { digest: sha(Buffer.from(JSON.stringify(files))), files };
  };
  const inputs = ['src', 'electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'];
  if (existsSync(path.join(project, 'resources'))) inputs.push('resources');
  const outRoot = path.join(project, 'out');
  const sourceManifest = () => recordTree(project, inputs);
  const existingManifest = () => existsSync(outRoot) ? recordTree(outRoot, readdirSync(outRoot).sort()) : null;
  if (sourceSnapshotRequested) {
    // Same hashing owner used by the independent compiler/selector. Running
    // this before and after validators binds the *tested* checkout to the
    // eventual private generation without spawning Vite or reading shared out/.
    const began = process.hrtime.bigint();
    const snapshot = { schema: 'cos_dev_source_snapshot_v1',
      mode: 'read-only-source-inspection', sourceSha256: null,
      compilerSha256: null, sourceFileCount: null, stable: false,
      nativeRuntimeVerified: false, installedRuntimeVerified: false,
      changesInstalled: false, reason: null };
    try {
      if (!viteReady) throw Error('electron-vite-missing');
      const first = sourceManifest();
      const compiler = sha(readFileSync(electronVite));
      const second = sourceManifest();
      const compilerAgain = sha(readFileSync(electronVite));
      snapshot.sourceSha256 = first.digest;
      snapshot.compilerSha256 = compiler;
      snapshot.sourceFileCount = first.files.length;
      if (first.digest !== second.digest || compiler !== compilerAgain)
        throw Error('source-or-compiler-changed-during-snapshot');
      snapshot.stable = true;
    } catch (error) {
      snapshot.reason = ['electron-vite-missing',
        'source-or-compiler-changed-during-snapshot',
        'unverified-linked-build-input', 'unbounded-build-input',
        'unsupported-build-input'].includes(error?.message) ?
        error.message : 'source-snapshot-unverified';
    }
    snapshot.durationMs = Number((process.hrtime.bigint() - began) / 1000000n);
    console.log(JSON.stringify(snapshot));
    process.exit(snapshot.stable ? 0 : 1);
  }
  const required = ['main/index.js', 'preload/index.js', 'renderer/index.html'];
  // Compare hashes of all files, including hashed Vite assets. A changed
  // filename is an added/removed artifact, not a successful in-place HMR.
  // Cap the receipt; never dump source, generated code, credentials or messages.
  const compareOutputs = (previous, generated) => {
    const oldFiles = new Map((previous?.files ?? []).map(item => [item.file, item.sha256]));
    const newFiles = new Map(generated.files.map(item => [item.file, item.sha256]));
    const counts = { main: 0, preload: 0, renderer: 0, other: 0 };
    const examples = [];
    let changeCount = 0;
    for (const file of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
      const old = oldFiles.get(file) ?? null;
      const current = newFiles.get(file) ?? null;
      if (old === current) continue;
      const family = file.startsWith('main/') ? 'main' : file.startsWith('preload/') ?
        'preload' : file.startsWith('renderer/') ? 'renderer' : 'other';
      counts[family] += 1;
      changeCount += 1;
      if (examples.length < 32) examples.push({ file, kind: old === null ? 'added' :
        current === null ? 'removed' : 'modified', originalSha256: old, stagedSha256: current });
    }
    const requiredSteps = [];
    if (counts.main) requiredSteps.push('electron-main-rebuild-and-controlled-restart');
    if (counts.preload) requiredSteps.push('preload-rebuild-new-document-and-runtime-restoration');
    if (counts.renderer) requiredSteps.push('renderer-reload-and-content-verification');
    if (counts.other) requiredSteps.push('investigate-unclassified-compiled-artifacts');
    return { changeCount, counts, examples, truncated: changeCount > examples.length,
      requiredSteps, companionMv3: 'not-checked-reload-and-reattach-separately' };
  };
  // Source edits from another lane can land between the two independent
  // compilations. Surface only relative file identities and cryptographic
  // digests, never the source text or an absolute private checkout path.
  const sourceDelta = (original, observed) => {
    const oldFiles = new Map(original.files.map(file => [file.file, file.sha256]));
    const newFiles = new Map(observed.files.map(file => [file.file, file.sha256]));
    const changed = [...new Set([...oldFiles.keys(), ...newFiles.keys()])]
      .sort((a, b) => a.localeCompare(b, 'en'))
      .filter(file => oldFiles.get(file) !== newFiles.get(file));
    return { originalSha256: original.digest, observedSha256: observed.digest,
      changeCount: changed.length, truncated: changed.length > 12,
      examples: changed.slice(0, 12).map(file => ({
        file, oldSha256: oldFiles.get(file) ?? null,
        newSha256: newFiles.get(file) ?? null
      })) };
  };
  const result = { schema: 'cos_dev_build_qualification_v1',
    mode: selecting ? 'exact-staged-artifact-selection' : 'source-compiled-artifact-comparison', sourceCheckout: project,
    validationRunId: randomUUID(),
    validationStartedAt: new Date().toISOString(),
    invocation: { entrypoint: '--qualify-build', requestedMode: selecting ? 'select-stage' : 'build-qualification',
      commandFamily: selecting ? 'artifact-selection-review' : 'electron-vite-build',
      reproducibilityRequested: confirmReproducible },
    execution: { commandFamily: selecting ? 'artifact-selection-review' : 'electron-vite-build',
      executable: selecting ? null : electronVite,
      arguments: selecting ? [] : ['build', '--outDir', '<generated-private-stage>'],
      spawned: false,
      result: null },
    accepted: false, nativeRuntimeVerified: false, installedRuntimeVerified: false,
    sourceBuildQualified: false, existingBuildQualified: false,
    evidenceStatus: 'diagnostic-only',
    reproducibilityRequested: confirmReproducible, reproducible: null, failures: [],
    failureClassification: 'none',
    handoff: { checked: 'source-build-qualification', next: [],
      retrySafe: null,
      missingEvidence: [],
      proven: [], notProven: ['native-runtime-execution', 'installed-runtime-behavior'] } };
  if (privateOutputRequested) result.privateOutput = {
    requested: true, published: false, name: null, path: null, sha256: null,
    fileCount: 0, historyPreserved: true, sharedOutModified: false
  };

  // Keep failure meaning separate from the raw failure list. Callers need to know
  // whether they should repair the environment, inspect the command result, fix
  // the generated artifact, or verify ownership before trusting a receipt. The
  // raw codes remain the detailed evidence boundary.
  const classifyFailures = () => {
    const failures = new Set(result.failures);
    if (failures.has('invalid-build-timeout-config') ||
        failures.has('checkout-private-temp-unavailable') || failures.has('electron-vite-missing') ||
        failures.has('private-output-generation-cap-reached') ||
        failures.has('bridge-identity-unverified')) return 'environment';
    // An untrusted source/output epoch outranks a simultaneous failed command.
    // Otherwise a timeout/exit code obscures the concurrent writer that made
    // this whole staged comparison unsafe to retry or adopt.
    if (failures.has('source-changed-during-build') || failures.has('compiler-changed-during-build') ||
        failures.has('source-changed-during-confirmation') ||
        failures.has('compiler-changed-during-confirmation') ||
        failures.has('compiler-process-exit-unverified') ||
        failures.has('compiler-output-pipes-unsettled') ||
        failures.has('confirmation-process-exit-unverified') ||
        failures.has('confirmation-output-pipes-unsettled') ||
        failures.has('existing-output-changed-during-build') ||
        failures.has('existing-output-changed-during-confirmation') ||
        failures.has('staged-output-changed-during-confirmation') ||
        failures.has('confirmation-output-changed-after-build')) return 'ownership';
    if (failures.has('private-output-publication-owner-unverified')) return 'ownership';
    if (failures.has('selected-source-mismatch') || failures.has('selected-compiler-mismatch') ||
        failures.has('selected-compiled-output-mismatch') ||
        failures.has('private-output-receipt-mismatch') ||
        failures.has('private-output-source-or-stage-changed') ||
        failures.has('stage-or-source-changed-during-selection')) return 'ownership';
    if (failures.has('staged-compiler-failed-or-interrupted') || failures.has('staged-compiler-timeout') ||
        failures.has('staged-compiler-cancelled') || failures.has('confirmation-compiler-cancelled') ||
        failures.has('confirmation-compiler-failed-or-interrupted') ||
        failures.has('confirmation-compiler-timeout')) return 'command';
    if (failures.has('incomplete-compiled-output') || failures.has('nondeterministic-compiled-output') ||
        failures.has('existing-output-content-mismatch') || failures.has('existing-output-changed-during-build')) return 'validation';
    return failures.size ? 'validation' : 'none';
  };

  const updateHandoff = () => {
    const failures = new Set(result.failures);
    const next = [];
    if (failures.has('invalid-build-timeout-config'))
      next.push('set-valid-build-timeout-before-requalification');
    if (failures.has('electron-vite-missing')) next.push('install-checkout-dependencies');
    if (failures.has('bridge-identity-unverified')) next.push('inspect-development-process-ownership-before-retry');
    if (failures.has('checkout-private-temp-unavailable') || failures.has('stage-identity-unverified'))
      next.push('verify-validation-input-ownership-before-retry');
    if (failures.has('source-changed-during-build')) next.push('rerun-after-source-stabilizes');
    if (failures.has('source-changed-during-confirmation')) next.push('rerun-after-source-stabilizes');
    if (failures.has('selected-source-mismatch') || failures.has('selected-compiler-mismatch') ||
        failures.has('selected-compiled-output-mismatch') || failures.has('stage-or-source-changed-during-selection'))
      next.push('reselect-artifact-with-current-input-identity-before-qualification');
    if (failures.has('existing-output-changed-during-build') ||
        failures.has('existing-output-changed-during-confirmation') ||
        failures.has('existing-output-content-mismatch'))
      next.push('review-existing-output-drift-before-runtime-qualification');
    if (failures.has('staged-output-changed-during-confirmation') ||
        failures.has('confirmation-output-changed-after-build'))
      next.push('inspect-staged-output-ownership-before-requalification');
    if (failures.has('existing-output-missing'))
      next.push('create-or-restore-existing-build-output-before-qualification');
    if (failures.has('incomplete-compiled-output') || failures.has('staged-compiler-failed-or-interrupted') ||
        failures.has('staged-compiler-timeout') || failures.has('confirmation-compiler-failed-or-interrupted'))
      next.push('inspect-staged-build-failure-before-runtime-qualification');
    if (failures.has('confirmation-compiler-timeout'))
      next.push('inspect-confirmation-build-timeout-before-runtime-qualification');
    if (failures.has('staged-compiler-cancelled') || failures.has('confirmation-compiler-cancelled'))
      next.push('inspect-cancelled-build-custody-before-requalification');
    if (failures.has('compiler-changed-during-build') || failures.has('compiler-changed-during-confirmation'))
      next.push('rerun-with-stable-compiler-input');
    if (failures.has('compiler-process-exit-unverified') ||
        failures.has('compiler-output-pipes-unsettled') ||
        failures.has('confirmation-process-exit-unverified') ||
        failures.has('confirmation-output-pipes-unsettled'))
      next.push('inspect-compiler-process-and-output-custody-before-requalification');
    if (failures.has('nondeterministic-compiled-output')) next.push('inspect-build-reproducibility-drift');
    if (failures.has('private-output-receipt-mismatch'))
      next.push('inspect-private-output-provenance-before-selection');
    if (failures.has('private-output-source-or-stage-changed'))
      next.push('rebuild-after-private-output-inputs-stabilize');
    if (failures.has('private-output-publication-unverified'))
      next.push('inspect-incomplete-private-publication-before-new-attempt');
    if (failures.has('private-output-generation-cap-reached'))
      next.push('review-private-generation-owners-and-rollback-before-cleanup-ledger-retirement');
    if (failures.has('private-output-publication-owner-unverified'))
      next.push('inspect-retained-private-publication-owner-before-new-attempt');
    if (result.privateOutput?.published)
      next.push('review-immutable-private-output-without-replacing-shared-out');
    const codes = [
      ...(result.execution.result?.compilerOutput?.diagnosticCodes ?? []),
      ...(result.confirmationExecution?.compilerOutput?.diagnosticCodes ?? [])
    ];
    if (codes.some(code => code === 'TS2307' || code === 'ERR_MODULE_NOT_FOUND' ||
        code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'))
      next.push('inspect-compiler-module-resolution-before-runtime-qualification');
    if (codes.some(code => code === 'EACCES' || code === 'EPERM'))
      next.push('inspect-compiler-filesystem-permissions-before-runtime-qualification');
    if (failures.size === 0 && result.sourceBuildQualified && result.existingBuildQualified)
      next.push('continue-with-separate-native-or-installed-qualification');
    result.handoff.next = next;
    result.handoff.retrySafe = failures.has('compiler-process-exit-unverified') ||
      failures.has('compiler-output-pipes-unsettled') ||
      failures.has('confirmation-process-exit-unverified') ||
      failures.has('confirmation-output-pipes-unsettled')
      ? 'retry-after-compiler-process-and-output-custody-is-cleared'
      : failures.has('staged-compiler-cancelled') || failures.has('confirmation-compiler-cancelled')
      ? 'retry-after-cancelled-compiler-custody-is-confirmed'
      : failures.has('source-changed-during-build') ||
      failures.has('source-changed-during-confirmation') ||
      failures.has('compiler-changed-during-build') ||
      failures.has('compiler-changed-during-confirmation') ||
      failures.has('existing-output-changed-during-build') ||
      failures.has('existing-output-changed-during-confirmation') ||
      failures.has('staged-output-changed-during-confirmation') ||
      failures.has('confirmation-output-changed-after-build') ||
      failures.has('stage-or-source-changed-during-selection')
      ? 'retry-after-input-stability-is-restored'
      : failures.size
        ? 'retry-after-listed-correction-and-fresh-validation'
        : 'safe-to-continue-to-next-qualified-validation-step';
    result.handoff.missingEvidence = [
      'native-runtime-execution',
      'installed-runtime-behavior'
    ];
    if (failures.has('staged-compiler-failed-or-interrupted') ||
        failures.has('staged-compiler-timeout') ||
        failures.has('confirmation-compiler-failed-or-interrupted') ||
        failures.has('confirmation-compiler-timeout'))
      result.handoff.missingEvidence.push('successful-repeatable-build-command-result');
    if (failures.has('invalid-build-timeout-config'))
      result.handoff.missingEvidence.push('valid-build-timeout-config');
    if (failures.has('compiler-process-exit-unverified') ||
        failures.has('confirmation-process-exit-unverified'))
      result.handoff.missingEvidence.push('observed-compiler-process-exit');
    if (failures.has('compiler-output-pipes-unsettled') ||
        failures.has('confirmation-output-pipes-unsettled'))
      result.handoff.missingEvidence.push('settled-compiler-output-custody');
    if (failures.has('staged-compiler-cancelled') || failures.has('confirmation-compiler-cancelled'))
      result.handoff.missingEvidence.push('cancelled-compiler-process-tree-cleared');
    if (result.privateOutput?.requested && !result.privateOutput.published)
      result.handoff.missingEvidence.push('verified-atomic-private-output-publication');
    if (failures.has('source-changed-during-build') ||
        failures.has('source-changed-during-confirmation') ||
        failures.has('compiler-changed-during-build') ||
        failures.has('compiler-changed-during-confirmation'))
      result.handoff.missingEvidence.push('stable-source-and-toolchain-identity');
    if (failures.has('staged-output-changed-during-confirmation') ||
        failures.has('confirmation-output-changed-after-build'))
      result.handoff.missingEvidence.push('stable-staged-output-identity');
    if (failures.has('existing-output-content-mismatch') ||
        failures.has('existing-output-changed-during-build') ||
        failures.has('existing-output-changed-during-confirmation'))
      result.handoff.missingEvidence.push('trusted-existing-output-identity');
    result.handoff.proven = result.accepted ? [
      'selected-source-and-compiled-artifact-identity-match',
      'staged-build-output-matches-qualified-build-expectation'
    ] : result.privateOutput?.published ? ['reproducible-private-development-output-published'] : [];
    result.handoff.notProven = [
      'native-runtime-execution',
      'installed-runtime-behavior'
    ];
  };
  let beforeSource = null;
  let beforeExisting = null;
  try {
    if (!selecting && !buildTimeoutValid) throw Error('invalid-build-timeout-config');
    if (!viteReady) throw Error('electron-vite-missing');
    // The package lock identifies intended dependencies, not necessarily the
    // actual local CLI binary selected at execution. Bind the actual compiler
    // bytes and Node runtime to this review-only receipt.
    const compilerSha256 = sha(readFileSync(electronVite));
    result.toolchain = { nodeVersion: process.version, electronViteCliSha256: compilerSha256 };
    const temp = path.join(project, '.test_tmp');
    if (!existsSync(temp) || !lstatSync(temp).isDirectory() || lstatSync(temp).isSymbolicLink() ||
        realpathSync.native(temp).toLowerCase() !== path.resolve(temp).toLowerCase())
      throw Error('checkout-private-temp-unavailable');
    // A retained generation may be the only verified prior-good/rollback or
    // unresolved lease. Never delete one merely to make room for a new build.
    // Check capacity BEFORE compilation, and again at the publication boundary.
    // Physical retirement belongs to the existing verified cleanup owner.
    const generationCount = () => readdirSync(temp)
      .filter(name => name.startsWith('chat42-private-out-')).length;
    const publicationLock = path.join(temp, '.chat42-private-output-publication');
    if (privateOutputRequested) {
      if (existsSync(publicationLock)) {
        result.privateOutput.publicationLockState = 'unavailable';
        throw Error('private-output-publication-owner-unverified');
      }
      result.privateOutput.generationLimit = 64;
      result.privateOutput.existingGenerationCount = generationCount();
      if (result.privateOutput.existingGenerationCount >= 64)
        throw Error('private-output-generation-cap-reached');
    }
    if (selecting) {
      const expectedSource = shaValue(sourceExpectations[0]).toUpperCase();
      const expectedCompiled = shaValue(outputExpectations[0]).toUpperCase();
      const expectedCompiler = shaValue(compilerExpectations[0]).toUpperCase();
      const container = path.join(temp, selectedName);
      const folder = selectedPrivateOutput ? path.join(container, 'out') : container;
      result.stage = folder;
      result.expected = { sourceSha256: expectedSource, compiledOutputSha256: expectedCompiled,
        electronViteCliSha256: expectedCompiler };
      const currentSource = sourceManifest();
      const currentCompiler = sha(readFileSync(electronVite));
      result.sourceSha256 = currentSource.digest;
      result.toolchain = { nodeVersion: process.version, electronViteCliSha256: currentCompiler };
      if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink() ||
          realpathSync.native(folder).toLowerCase() !== path.resolve(folder).toLowerCase())
        throw Error('stage-identity-unverified');
      if (selectedPrivateOutput) {
        const evidenceFile = path.join(container, 'evidence.json');
        if (!lstatSync(container).isDirectory() || lstatSync(container).isSymbolicLink() ||
            !lstatSync(evidenceFile).isFile() || lstatSync(evidenceFile).isSymbolicLink() ||
            lstatSync(evidenceFile).size > 4096) throw Error('stage-identity-unverified');
        const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'));
        if (evidence.schema !== 'cos_dev_private_output_v1' ||
            evidence.name !== selectedName || evidence.reproducible !== true ||
            evidence.nativeRuntimeVerified !== false || evidence.installedRuntimeVerified !== false ||
            evidence.adoptedAsProduction !== false ||
            evidence.sourceSha256 !== expectedSource ||
            evidence.compiledOutputSha256 !== expectedCompiled ||
            evidence.electronViteCliSha256 !== expectedCompiler)
          result.failures.push('private-output-receipt-mismatch');
      }
      const selected = recordTree(folder, readdirSync(folder).sort());
      result.compiledOutputSha256 = selected.digest;
      result.compiledFileCount = selected.files.length;
      // Give the private renderer consumer a digest of the exact per-file
      // checksums the selector just verified. A bundle-wide digest alone
      // cannot establish that copied in-memory renderer bytes are identical.
      const rendererFiles = selected.files.filter(entry => entry.file.startsWith('renderer/'));
      result.rendererOutputFileCount = rendererFiles.length;
      result.rendererOutputManifestSha256 = sha(Buffer.from(JSON.stringify(rendererFiles)));
      if (selectedPrivateOutput &&
          JSON.parse(readFileSync(path.join(container, 'evidence.json'), 'utf8')).fileCount !== selected.files.length)
        result.failures.push('private-output-receipt-mismatch');
      result.compiledCore = Object.fromEntries(required.map(name => [name,
        selected.files.find(entry => entry.file === name)?.sha256 ?? null]));
      if (required.some(name => !result.compiledCore[name]))
        result.failures.push('incomplete-compiled-output');
      if (currentSource.digest !== expectedSource) result.failures.push('selected-source-mismatch');
      if (currentCompiler !== expectedCompiler) result.failures.push('selected-compiler-mismatch');
      if (selected.digest !== expectedCompiled) result.failures.push('selected-compiled-output-mismatch');
      if (sourceManifest().digest !== currentSource.digest ||
          sha(readFileSync(electronVite)) !== currentCompiler ||
          recordTree(folder, readdirSync(folder).sort()).digest !== selected.digest)
        result.failures.push('stage-or-source-changed-during-selection');
      result.sourceBuildQualified = result.failures.length === 0;
      result.stageSelectedForReview = result.sourceBuildQualified;
      // This is a different decision from whether the historical out/ matches
      // current source, much less whether Electron ran this exact revision.
      result.existingBuildQualified = false;
      // Preserve the v1 full-build meaning of accepted for callers that may
      // look at that field without checking mode. Success selects a stage for
      // *review only*, never a validated existing build or native runtime.
      result.accepted = false;
      result.failureClassification = classifyFailures();
      updateHandoff();
      // Keep alternate validation entry paths comparable. A staged-selection
      // report is still a completed validation attempt and needs the same
      // freshness boundary as full build qualification reports.
      result.validationCompletedAt = new Date().toISOString();
      if (jsonOutput) console.log(JSON.stringify(result));
      else console.log('[Chat On Steroids dev] Exact staged artifact selection: ' +
        (result.stageSelectedForReview ? 'VERIFIED FOR REVIEW' : result.failures.join(', ')) +
        '. Native execution and installer provenance not checked.');
      process.exit(result.stageSelectedForReview ? 0 : 1);
    }
    beforeSource = sourceManifest();
    beforeExisting = existingManifest();
    result.sourceSha256 = beforeSource.digest;
    result.originalOutputSha256 = beforeExisting?.digest ?? null;
    // Random, checkout-contained output: even simultaneous runs cannot overwrite
    // each other's stage or the historical out/; a terminated build is unqualified.
    let interrupted = false;
    // Do not forward Vite/TypeScript text: error lines can include account paths,
    // credentials, source and private drafts. Only a fixed set of diagnostic codes
    // may leave these bounded in-memory head/tail windows.
    const outputCapture = stream => {
      let bytes = 0;
      const sampleSize = 4096;
      const head = Buffer.alloc(sampleSize);
      const tail = Buffer.alloc(sampleSize);
      let headLength = 0;
      let tailLength = 0;
      let tailWrite = 0;
      stream?.on('data', chunk => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + part.length);
        if (headLength < sampleSize)
          headLength += part.copy(head, headLength, 0, sampleSize - headLength);
        // Store just the most recent window in-place. Repeated Buffer.concat
        // reallocated/copy-read 4 KiB for every compiler chunk, even for one
        // byte of output. A ring costs at most one copy per incoming byte.
        if (part.length >= sampleSize) {
          part.copy(tail, 0, part.length - sampleSize);
          tailLength = sampleSize;
          tailWrite = 0;
        } else if (part.length) {
          const first = Math.min(part.length, sampleSize - tailWrite);
          part.copy(tail, tailWrite, 0, first);
          if (first < part.length) part.copy(tail, 0, first);
          tailWrite = (tailWrite + part.length) % sampleSize;
          tailLength = Math.min(sampleSize, tailLength + part.length);
        }
      });
      return () => ({ bytes, head: head.subarray(0, headLength),
        tail: tailLength < sampleSize ? tail.subarray(0, tailLength) :
          Buffer.concat([tail.subarray(tailWrite), tail.subarray(0, tailWrite)]),
        sampledBytes: Math.min(bytes, 8192) });
    };
    const summarizeOutput = (stdout, stderr) => {
      const streams = [stdout(), stderr()];
      const codes = new Set();
      for (const stream of streams) {
        for (const sample of [stream.head, stream.tail]) {
          const matches = sample.toString('utf8').match(/\b(?:TS[1-9]\d{3,4}|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|EACCES|EPERM|ENOENT)\b/g) ?? [];
          for (const code of matches) if (codes.size < 8) codes.add(code);
        }
      }
      return { stdoutBytes: streams[0].bytes, stderrBytes: streams[1].bytes,
        omittedBytes: streams.reduce((sum, stream) => sum + stream.bytes - stream.sampledBytes, 0),
        diagnosticCodes: [...codes] };
    };
    const runBuild = async stage => {
      result.execution.spawned = true;
      const started = process.hrtime.bigint();
      const child = spawn(process.execPath, [electronVite, 'build', '--outDir', stage],
        { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const stdout = outputCapture(child.stdout);
      const stderr = outputCapture(child.stderr);
      return await new Promise(resolve => {
        let error = false;
        let timedOut = false;
        let cancellationSignal = null;
        let processExitObserved = false;
        let outputPipesSettled = true;
        let finished = false;
        let stopEscalation = null;
        let stopDeadline = null;
        let outputDeadline = null;
        let outputFallback = null;
        let buildDeadline = null;
        const interruptHandlers = new Map();
        const finish = (code, signal) => {
          if (finished) return;
          finished = true;
          for (const timer of [buildDeadline, stopEscalation, stopDeadline, outputDeadline, outputFallback])
            clearTimeout(timer);
          for (const [name, handler] of interruptHandlers) process.off(name, handler);
          resolve({ code, signal, error, timedOut, cancellationSignal,
            processExitObserved, outputPipesSettled,
            durationMs: Number((process.hrtime.bigint() - started) / 1000000n),
            compilerOutput: summarizeOutput(stdout, stderr) });
        };
        const abandonOutput = () => {
          if (finished) return;
          outputPipesSettled = false;
          child.stdout?.destroy();
          child.stderr?.destroy();
        };
        const requestStop = (signal, timeout = false) => {
          if (finished) return;
          if (timeout) timedOut = true;
          interrupted = true;
          try { if (!processExitObserved) child.kill(signal); } catch { error = true; }
          // A stalled direct child may ignore a graceful stop. The hard limit
          // bounds receipt generation even when inherited pipes never close;
          // unknown descendant ownership always refuses qualification.
          if (stopEscalation === null) stopEscalation = setTimeout(() => {
            if (!processExitObserved) {
              try { child.kill('SIGKILL'); } catch { error = true; }
            }
          }, 400);
          if (stopDeadline === null) stopDeadline = setTimeout(() => {
            if (!processExitObserved) {
              try { child.kill('SIGKILL'); } catch { error = true; }
            }
            abandonOutput();
            finish(child.exitCode, child.signalCode);
          }, 1600);
        };
        const onInterrupt = signal => {
          if (finished) return;
          // The first observed deadline/explicit cancellation owns the cause.
          // A manual stop during a slow graceful exit must not be reclassified
          // as a build timeout by the still-armed original compilation timer.
          if (!timedOut && cancellationSignal === null) {
            cancellationSignal = signal;
            clearTimeout(buildDeadline);
            buildDeadline = null;
          }
          requestStop(signal);
        };
        // Node's process signal events carry no signal argument. Bind the
        // exact event name so forwarding preserves SIGINT vs SIGTERM and the
        // cancellation receipt cannot silently lose its reason.
        for (const name of ['SIGINT', 'SIGTERM']) {
          const handler = () => onInterrupt(name);
          interruptHandlers.set(name, handler);
          process.on(name, handler);
        }
        child.on('error', () => { error = true; });
        child.on('exit', () => {
          processExitObserved = true;
          // Node's 'close' waits for inherited stdout/stderr handles, including
          // handles held by grandchildren after the compiler itself has exited.
          // Never call that delayed event a successful, complete build receipt.
          outputDeadline = setTimeout(() => {
            abandonOutput();
            outputFallback = setTimeout(() => finish(child.exitCode, child.signalCode), 100);
          }, 800);
        });
        child.on('close', (code, signal) => finish(code, signal));
        buildDeadline = setTimeout(() => requestStop('SIGTERM', true), BUILD_EXECUTION_TIMEOUT_MS);
      });
    };
    const stage = mkdtempSync(path.join(temp, 'chat42-compiled-'));
    result.stage = stage;
    const compiled = await runBuild(stage);
    result.execution.result = {
      exitCode: compiled.code,
      signal: compiled.signal ?? null,
      spawnError: compiled.error,
      timedOut: compiled.timedOut,
      cancellationSignal: compiled.cancellationSignal,
      processExitObserved: compiled.processExitObserved,
      outputPipesSettled: compiled.outputPipesSettled,
      durationMs: compiled.durationMs,
      compilerOutput: compiled.compilerOutput
    };
    result.buildExitCode = compiled.code;
    if (compiled.timedOut) result.failures.push('staged-compiler-timeout');
    if (compiled.cancellationSignal) result.failures.push('staged-compiler-cancelled');
    if (!compiled.processExitObserved) result.failures.push('compiler-process-exit-unverified');
    if (!compiled.outputPipesSettled) result.failures.push('compiler-output-pipes-unsettled');
    if (interrupted || compiled.error || compiled.signal || compiled.code !== 0 ||
        !compiled.processExitObserved || !compiled.outputPipesSettled)
      result.failures.push('staged-compiler-failed-or-interrupted');
    const afterSource = sourceManifest();
    const afterExisting = existingManifest();
    result.sourceStable = beforeSource.digest === afterSource.digest;
    result.originalOutputStable = beforeExisting?.digest === afterExisting?.digest;
    if (sha(readFileSync(electronVite)) !== compilerSha256)
      result.failures.push('compiler-changed-during-build');
    if (!result.sourceStable) {
      result.failures.push('source-changed-during-build');
      result.sourceInputDrift = sourceDelta(beforeSource, afterSource);
    }
    if (!result.originalOutputStable) result.failures.push('existing-output-changed-during-build');
    const staged = recordTree(stage, readdirSync(stage).sort());
    result.compiledOutputSha256 = staged.digest;
    result.compiledFileCount = staged.files.length;
    const rendererFiles = staged.files.filter(entry => entry.file.startsWith('renderer/'));
    result.rendererOutputFileCount = rendererFiles.length;
    result.rendererOutputManifestSha256 = sha(Buffer.from(JSON.stringify(rendererFiles)));
    result.compiledCore = Object.fromEntries(required.map(name => [name,
      staged.files.find(entry => entry.file === name)?.sha256 ?? null]));
    result.artifactDrift = compareOutputs(beforeExisting, staged);
    if (required.some(name => !result.compiledCore[name]))
      result.failures.push('incomplete-compiled-output');
    if (confirmReproducible && result.failures.length === 0) {
      const confirmStage = mkdtempSync(path.join(temp, 'chat42-compiled-'));
      result.confirmationStage = confirmStage;
      const second = await runBuild(confirmStage);
      result.confirmationExecution = {
        exitCode: second.code,
        signal: second.signal ?? null,
        spawnError: second.error,
        timedOut: second.timedOut,
        cancellationSignal: second.cancellationSignal,
        processExitObserved: second.processExitObserved,
        outputPipesSettled: second.outputPipesSettled,
        durationMs: second.durationMs,
        compilerOutput: second.compilerOutput
      };
      result.confirmationBuildExitCode = second.code;
      if (second.timedOut) result.failures.push('confirmation-compiler-timeout');
      if (second.cancellationSignal) result.failures.push('confirmation-compiler-cancelled');
      if (!second.processExitObserved) result.failures.push('confirmation-process-exit-unverified');
      if (!second.outputPipesSettled) result.failures.push('confirmation-output-pipes-unsettled');
      if (interrupted || second.error || second.signal || second.code !== 0 ||
          !second.processExitObserved || !second.outputPipesSettled) {
        result.failures.push('confirmation-compiler-failed-or-interrupted');
      } else {
        const confirmed = recordTree(confirmStage, readdirSync(confirmStage).sort());
        result.confirmationSha256 = confirmed.digest;
        result.reproducible = staged.digest === confirmed.digest;
        if (!result.reproducible)
          result.reproducibilityDrift = compareOutputs(staged, confirmed);
      }
      // Do not trust either stage if source or prior output mutated during
      // the second compilation. Preserve both stages as review-only evidence.
      const confirmationSource = sourceManifest();
      if (confirmationSource.digest !== beforeSource.digest) {
        result.failures.push('source-changed-during-confirmation');
        result.sourceInputDrift = sourceDelta(beforeSource, confirmationSource);
      }
      if (existingManifest()?.digest !== beforeExisting?.digest)
        result.failures.push('existing-output-changed-during-confirmation');
      if (sha(readFileSync(electronVite)) !== compilerSha256)
        result.failures.push('compiler-changed-during-confirmation');
    }
    // A matched manifest describes the exact bytes we observed, not permanent
    // custody of the first staged output. Another compiler or editor can alter
    // the original stage while confirmation is running. Re-read BOTH staged
    // trees before publishing a successful source/build decision; never permit
    // an executable candidate to outlive its observed byte identity silently.
    result.stageStable = recordTree(stage, readdirSync(stage).sort()).digest === staged.digest;
    if (!result.stageStable) result.failures.push('staged-output-changed-during-confirmation');
    if (confirmReproducible && result.confirmationSha256) {
      result.confirmationStageStable = recordTree(result.confirmationStage,
        readdirSync(result.confirmationStage).sort()).digest === result.confirmationSha256;
      if (!result.confirmationStageStable)
        result.failures.push('confirmation-output-changed-after-build');
    }
    // Two differing bundles made from different observed inputs are not
    // evidence of a nondeterministic compiler. Prioritize source, compiler,
    // historical-output or stage custody and require fresh, stable inputs.
    // Only attribute unexplained compiled drift to reproducibility after all
    // known input and output ownership fences have passed.
    if (confirmReproducible && result.reproducible === false &&
        !result.failures.some(reason =>
          reason === 'source-changed-during-build' ||
          reason === 'source-changed-during-confirmation' ||
          reason === 'compiler-changed-during-build' ||
          reason === 'compiler-changed-during-confirmation' ||
          reason === 'existing-output-changed-during-build' ||
          reason === 'existing-output-changed-during-confirmation' ||
          reason === 'staged-output-changed-during-confirmation' ||
          reason === 'confirmation-output-changed-after-build'))
      result.failures.push('nondeterministic-compiled-output');
    result.sourceBuildQualified = result.failures.length === 0;
    result.existingBuildQualified = result.sourceBuildQualified && Boolean(beforeExisting) &&
      beforeExisting.digest === staged.digest;
    if (!beforeExisting) result.failures.push('existing-output-missing');
    else if (!result.existingBuildQualified && result.sourceBuildQualified)
      result.failures.push('existing-output-content-mismatch');
    result.accepted = result.sourceBuildQualified && result.existingBuildQualified;
    if (privateOutputRequested && result.sourceBuildQualified && result.reproducible === true &&
        result.stageStable && result.confirmationStageStable) {
      // A reproducible source build may be useful even when another owner has
      // the historical out/. Publish new, immutable review bytes beneath the
      // checkout-private test root. Never touch shared out/ or an older review.
      // No compiler subprocess is running here; source/stage/toolchain/out
      // identities are fenced again immediately before atomic visibility.
      const started = process.hrtime.bigint();
      let publicationOwner = null;
      const ownsPublication = () => {
        try {
          const now = lstatSync(publicationLock, { bigint: true });
          return publicationOwner && now.isDirectory() && !now.isSymbolicLink() &&
            now.dev === publicationOwner.dev && now.ino === publicationOwner.ino &&
            now.birthtimeNs === publicationOwner.birthtimeNs;
        } catch { return false; }
      };
      try {
        // Serialize only the bounded copy/verify/rename boundary, not the
        // compilers or live preview. An interrupted/foreign reservation is
        // retained for the existing cleanup owner, never age/PID-unlocked.
        try { mkdirSync(publicationLock); }
        catch {
          result.privateOutput.publicationLockState = 'unavailable';
          throw Error('private-output-publication-owner-unverified');
        }
        publicationOwner = lstatSync(publicationLock, { bigint: true });
        result.privateOutput.publicationLockState = 'held';
        if (!ownsPublication()) throw Error('private-output-publication-owner-unverified');
        result.privateOutput.existingGenerationCount = generationCount();
        if (result.privateOutput.existingGenerationCount >= 64)
          throw Error('private-output-generation-cap-reached');
        const totalBytes = staged.files.reduce((sum, file) => sum + file.size, 0);
        if (totalBytes > 256 * 1024 * 1024) throw Error('private-output-publication-unverified');
        const generation = randomUUID();
        const name = `chat42-private-out-${generation}`;
        const preparing = path.join(temp, `.chat42-preparing-private-out-${generation}`);
        const published = path.join(temp, name);
        if (existsSync(preparing) || existsSync(published))
          throw Error('private-output-publication-unverified');
        mkdirSync(preparing); // Exclusive, no existing destination may be reused.
        const copiedOut = path.join(preparing, 'out');
        mkdirSync(copiedOut);
        for (const file of staged.files) {
          const segments = file.file.split('/');
          if (segments.some(segment => !segment || segment === '.' || segment === '..'))
            throw Error('private-output-publication-unverified');
          const original = path.join(stage, ...segments);
          if (!lstatSync(original).isFile() || lstatSync(original).isSymbolicLink())
            throw Error('private-output-source-or-stage-changed');
          const copied = path.join(copiedOut, ...segments);
          mkdirSync(path.dirname(copied), { recursive: true });
          copyFileSync(original, copied);
        }
        const candidate = recordTree(copiedOut, readdirSync(copiedOut).sort());
        if (candidate.digest !== staged.digest ||
            recordTree(stage, readdirSync(stage).sort()).digest !== staged.digest ||
            recordTree(result.confirmationStage, readdirSync(result.confirmationStage).sort()).digest !== staged.digest ||
            sourceManifest().digest !== beforeSource.digest ||
            sha(readFileSync(electronVite)) !== compilerSha256 ||
            existingManifest()?.digest !== beforeExisting?.digest)
          throw Error('private-output-source-or-stage-changed');
        const evidence = {
          schema: 'cos_dev_private_output_v1', name, generatedAt: new Date().toISOString(),
          validationRunId: result.validationRunId, sourceSha256: beforeSource.digest,
          compiledOutputSha256: candidate.digest, electronViteCliSha256: compilerSha256,
          originalOutputSha256: beforeExisting?.digest ?? null,
          reproducible: true, fileCount: candidate.files.length,
          nativeRuntimeVerified: false, installedRuntimeVerified: false,
          adoptedAsProduction: false
        };
        writeFileSync(path.join(preparing, 'evidence.json'), JSON.stringify(evidence), { flag: 'wx' });
        // Publish one previously invisible, complete directory via rename.
        // No mutable 'latest' symlink/pointer or shared output is replaced;
        // older generations remain available for exact review/rollback.
        if (!ownsPublication()) throw Error('private-output-publication-owner-unverified');
        result.privateOutput.existingGenerationCount = generationCount();
        if (result.privateOutput.existingGenerationCount >= 64)
          throw Error('private-output-generation-cap-reached');
        if (existsSync(published)) throw Error('private-output-publication-unverified');
        renameSync(preparing, published);
        if (recordTree(path.join(published, 'out'),
          readdirSync(path.join(published, 'out')).sort()).digest !== candidate.digest ||
            sourceManifest().digest !== beforeSource.digest ||
            sha(readFileSync(electronVite)) !== compilerSha256 ||
            recordTree(stage, readdirSync(stage).sort()).digest !== staged.digest ||
            recordTree(result.confirmationStage,
              readdirSync(result.confirmationStage).sort()).digest !== staged.digest ||
            existingManifest()?.digest !== beforeExisting?.digest)
          throw Error('private-output-source-or-stage-changed');
        result.privateOutput = {
          requested: true, published: true, name, path: published,
          publicationLockState: 'held',
          sha256: candidate.digest, fileCount: candidate.files.length,
          historyPreserved: true, sharedOutModified: false,
          durationMs: Number((process.hrtime.bigint() - started) / 1000000n)
        };
      } catch (error) {
        result.failures.push(error?.message === 'private-output-source-or-stage-changed' ?
          'private-output-source-or-stage-changed' :
          error?.message === 'private-output-publication-owner-unverified' ?
            'private-output-publication-owner-unverified' :
          error?.message === 'private-output-generation-cap-reached' ?
            'private-output-generation-cap-reached' : 'private-output-publication-unverified');
        // A partial .chat42-preparing-* folder is review-only evidence. Do not
        // recursively remove unknown contents after a crash or foreign write.
        result.accepted = false;
      } finally {
        if (publicationOwner) {
          try {
            if (!ownsPublication()) throw Error('owner-changed');
            rmdirSync(publicationLock); // Nonrecursive: foreign contents veto release.
            result.privateOutput.publicationLockState = 'released';
          } catch {
            result.privateOutput.publicationLockState = 'retained';
            if (!result.failures.includes('private-output-publication-owner-unverified'))
              result.failures.push('private-output-publication-owner-unverified');
            result.accepted = false;
          }
        }
      }
    }
  } catch (error) {
    result.failures.push(error?.message === 'electron-vite-missing' ||
      error?.message === 'invalid-build-timeout-config' ||
      error?.message === 'checkout-private-temp-unavailable' ||
      error?.message === 'private-output-generation-cap-reached' ||
      error?.message === 'private-output-publication-owner-unverified' ||
      error?.message === 'unverified-linked-build-input' ||
      error?.message === 'unbounded-build-input' ||
      error?.message === 'unsupported-build-input' ||
      error?.message === 'stage-identity-unverified' ? error.message : 'build-qualification-unverified');
  }
  result.failureClassification = classifyFailures();
  updateHandoff();
  result.evidenceStatus = result.accepted ? 'build-qualified-only' :
    result.privateOutput?.published ? 'private-development-output-only' : 'diagnostic-only';
  result.validationCompletedAt = new Date().toISOString();
  if (jsonOutput) console.log(JSON.stringify(result));
  else console.log(`[Chat On Steroids dev] Build qualification: ${result.accepted ? 'MATCH' : 'REFUSED'}; ${result.failures.join(', ') || 'source/compiled content matches'}. Private output: ${result.privateOutput?.published ? 'PUBLISHED FOR REVIEW' : 'not published'}. Native execution not checked.`);
  // Published bytes remain durable custody even if releasing their owner
  // fails. Only a fully released publication is a successful operation; a
  // retained mutex must stop consumers without denying that those bytes exist.
  // Neither outcome accepts historical out/, native runtime or an install.
  const publicationSucceeded = result.privateOutput?.published === true &&
    result.privateOutput.publicationLockState === 'released';
  process.exit(result.accepted || publicationSucceeded ? 0 : 1);
} else if (args.some(arg => arg === '--confirm-reproducible' || arg.startsWith('--select-stage=') ||
    arg === '--prepare-private-out' || arg === '--snapshot-source' ||
    arg.startsWith('--expect-source-sha256=') || arg.startsWith('--expect-compiled-sha256=') ||
    arg.startsWith('--expect-compiler-sha256='))) {
  console.error('[Chat On Steroids dev] Staged build qualification options require --qualify-build; watcher not started.');
  process.exit(1);
} else if (jsonOutput && !checkOnly) {
  console.error('[Chat On Steroids dev] --json requires --check; JSON output is only available for read-only preflight.');
  process.exit(1);
}
if (recoverRequested && (checkOnly || jsonOutput || args.some(arg => !['--recover'].includes(arg)))) {
  console.error('[Chat On Steroids dev] --recover must be used alone, not as a watcher option.');
  process.exit(1);
}

const portAvailable = (port, host = '127.0.0.1') => new Promise(resolve => {
  const probe = net.createServer();
  probe.unref();
  probe.once('error', () => resolve(false));
  probe.listen(port, host, () => probe.close(() => resolve(true)));
});

// The native qualification path must never start Electron on a debugger port
// already owned by another process, nor collide with Vite or any reserved
// companion bridge port. A free port is only preflight evidence: the live CDP
// probe still has to prove the exact Electron/bridge process owner after spawn.
const debuggerPortAvailable = debuggerPort === null ? null :
  debuggerPort !== 'unknown' && debuggerPort !== RENDERER_DEFAULT_PORT &&
  !(debuggerPort >= BRIDGE_PORT_MIN && debuggerPort <= BRIDGE_PORT_MAX) &&
  await portAvailable(debuggerPort, '127.0.0.1') &&
  await portAvailable(debuggerPort, 'localhost');

// A read-only snapshot, never a port reservation or evidence that Vite is ready.
// Use the same localhost resolver as Vite; a bridge listener alone cannot
// establish which renderer URL the Electron child would actually load.
const rendererDefaultPortAvailable = await portAvailable(RENDERER_DEFAULT_PORT, 'localhost');
let bridgePort = null;
let existingDevelopmentInstance = null;
const unverifiedBridgePorts = [];
const isOurDevelopmentBridge = async port => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/hello`, {
      signal: AbortSignal.timeout(500),
      redirect: 'error'
    });
    const length = Number(response.headers?.get('content-length') ?? 0);
    if (!response.ok || !Number.isFinite(length) || length < 0 || length > MAX_HELLO_BYTES || !response.body) return 'unverified';
    // Chunked /hello responses can omit Content-Length. Read at most 4 KiB regardless
    // of the header; Response.json() would otherwise buffer an unbounded local payload.
    const reader = response.body.getReader();
    const bytes = new Uint8Array(MAX_HELLO_BYTES);
    let used = 0;
    let complete = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { complete = true; break; }
        if (used + value.byteLength > MAX_HELLO_BYTES) return 'unverified';
        bytes.set(value, used);
        used += value.byteLength;
      }
    } finally {
      if (!complete) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const hello = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
    // Match the companion's /hello application-marker contract. The opaque checkout ID alone
    // is predictable from the local path, so another loopback service must not claim our slot.
    if (hello?.app === 'chat-on-steroids' && hello?.instanceId === expectedDevId && hello?.legacyInstance === false) return 'ours';
    // A complete, valid foreign app or another identified CoS account does not own this
    // checkout. Invalid and unfinished responses cannot safely establish that distinction.
    if (typeof hello?.app === 'string' && hello.app !== 'chat-on-steroids') return 'other';
    if (hello?.app === 'chat-on-steroids' && typeof hello.instanceId === 'string' &&
        typeof hello.legacyInstance === 'boolean') return 'other';
    return 'unverified';
  } catch {
    // An occupied port may be this private app before its bridge is ready, or after it
    // stopped answering. Never infer foreign ownership from a timeout or malformed body.
    return 'unverified';
  }
};
const describeChildExit = (code, signal) => {
  if (signal) return `signal:${signal}`;
  if (code === 0) return 'clean-exit';
  return `exit-code:${code}`;
};
// Installed profiles allocate from the low end of this same companion discovery range. Prefer
// the high end for development so a normal three-account workstation can run both at once.
for (let port = BRIDGE_PORT_MAX; port >= BRIDGE_PORT_MIN; port -= 1) {
  if (await portAvailable(port)) {
    bridgePort ??= port;
  } else {
    const identity = await isOurDevelopmentBridge(port);
    if (identity === 'ours') {
      existingDevelopmentInstance = `127.0.0.1:${port}`;
      break;
    }
    if (identity === 'unverified') unverifiedBridgePorts.push(`127.0.0.1:${port}`);
  }
}
if (checkOnly) {
  // This is a source preflight, not evidence about an installed or executing application.
  // Use the package owner's exact Git identity/dirty rules rather than a second Git parser.
  let source = null;
  try {
    const { readGitSourceIdentity } = await import('./package.mjs');
    source = readGitSourceIdentity(project);
  } catch {
    // Do not print arbitrary Git/OS errors that could include local paths or credentials.
  }
  // The launcher can be ready to START while its in-place HTML/preload
  // acceptance is blocked by a different owner's app-shell navigation policy.
  // Machines must not interpret ready=true as evidence that update modes work.
  // This is a source fingerprint, never native renderer/reload confirmation.
  let appShellSourceSha256 = null;
  try {
    const filename = path.join(project, 'src', 'main', 'index.ts');
    const info = lstatSync(filename);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024 &&
        realpathSync.native(filename).toLowerCase().startsWith(project.toLowerCase() + path.sep.toLowerCase()))
      appShellSourceSha256 = createHash('sha256').update(readFileSync(filename)).digest('hex').toUpperCase();
  } catch { /* missing, foreign or unreadable source is not proof of a guard fix */ }
  // Reviewed connector-identity, sign-out-alert, profile provisioning, read-only inspection/cold refusal,
  // Keep Awake and exact warm companion controls leave both
  // navigation owners intact. These exact shells remain blocked; unknown bytes
  // still require native proof, even when their source appears to retain guards.
  const knownBlockedNavigationSource =
    appShellSourceSha256 === 'F276EA469FAE58A4099B43EC41031859D3B4A08C8BF3E79F471449DEF325FB72' ||
    // October15 current app-shell changed other Main owners. Independent
    // before/after SHA of BOTH exact navigation handler bodies remains
    // unchanged (window6d7bf12d / globald2ba9316); still blocked, never
    // qualified as working native document navigation.
    appShellSourceSha256 === 'D16376886971CB3546453A0AC8318B1D124EA4A5F39CB5B2C98988BD975FF889' ||
    // Shared-publisher startup comment/log correction only; both complete
    // navigation-owner bodies retain those same blocked-policy digests.
    appShellSourceSha256 === 'DBB0B58FC735FFA78C3571675EBC5A88D1830B59ED6D89ECEBBD2E3D6D84D8A6' ||
    // Truthful companion reload-request log only; both complete navigation-owner
    // bodies are byte-identical to the reviewed DBB0B58F shell above.
    appShellSourceSha256 === '8C465B8490F7CDD6DF64DBBCD49B781D2BF07E68091C80FFAD5A9FB27CB7958A' ||
    // Account-name tray identity only; both navigation-owner bodies retain
    // the reviewed window6d7bf12d/globald2ba9316 blocked-policy digests.
    appShellSourceSha256 === 'F4DAF0014A7196E46353D4EA4FFCE251A67A19FF72C5D157D4E0F2CA54193D08' ||
    appShellSourceSha256 === '53D4E2E864C64690DE9783A9839E6047A9898DE8D6DCE9D858738535ED04B639' ||
    appShellSourceSha256 === '2537AEEC1A720C0488B858347AD0CAB5599D942164931FECE18A93DF639ED580' ||
    appShellSourceSha256 === '1591B23E98FDB165F0DA1C9B59B6C39E0837F60E2748742844348D0B093585D1' ||
    appShellSourceSha256 === '9B1EFF7F22ECE4CB191A0FE7D5E633A7610A34F69149E1B416A8A6C98675F226' ||
    appShellSourceSha256 === 'BF26D7C685AEE4B47EBDB510D892917D49585318779B124E724853761A38947F' ||
    appShellSourceSha256 === 'B77A6A33B39DBF0A7813A8C724F367D2D847BB83EC02AE32216A8A761F188C0F' ||
    appShellSourceSha256 === 'CAC17863B34CF9F79082711D9B43C07EA512F53E6346778595FA42C0CFADEA4D' ||
    appShellSourceSha256 === '95A88794E7776F7791928B52ECE23C064B487B0FBBFFF6B7529D0F4B46B3A318' ||
    appShellSourceSha256 === 'FF95657978E3D63944B20A3913AEA7440E8B8088365FD5923B70ADE915555D13' ||
    appShellSourceSha256 === 'DD11F403BF5612E68D25413A4A024E6CDE8ACC1497F04F86894330BA941FFCF9' ||
    // October20 shell: both complete navigation owners still match the independently
    // reviewed window6d7bf12d/globald2ba9316 digests. Still blocked, not native qualified.
    appShellSourceSha256 === 'AA0013CDCF3F58A49B233696838D112B1CC15D207BC2B74842E561E76207075B' ||
    // Exact lifecycle status/cancel and shape-only companion diagnostics only. Both
    // reviewed navigation-owner bodies remain unchanged and BLOCKED, never runtime qualified.
    appShellSourceSha256 === 'D09602F47761D3C8734836D17DB1461B510D2316F80BD0B8C498B9B8E28A9A3B' ||
    // Reviewed view-only fault recovery and exact-window close handling change the window
    // body, while all seven navigation-deny handlers and the global owner remain intact.
    // This source is still BLOCKED; nativeRuntimeVerified remains false.
    appShellSourceSha256 === '9E48C6A4A4B204488D0E3F38C6C497E11F3A7FBA42B2B49A64F5A195E15E02FF' ||
    // Only the private startup PID/parent/generation log changed. The exact window
    // and global navigation-owner bodies retain their separately checked digests.
    // This is still BLOCKED and never an in-place or installed-runtime approval.
    appShellSourceSha256 === 'F16E688B4A963B6C364C175C4C273A54CBE52CBD870DE638F405C22C082F6A30';
  const nativeDocumentGate = knownBlockedNavigationSource
    ? 'blocked-by-known-app-shell-navigation-guards'
    : 'source-unknown-requires-native-qualification';
  const developmentUpdateGates = {
    appShellSourceSha256,
    htmlDocument: nativeDocumentGate,
    preloadCurrentRenderer: nativeDocumentGate,
    nativeRuntimeVerified: false,
    installedProduction: 'codex-release-qualification-required'
  };
  const launchOwnerUnverified = existsSync(launchLockDir);
  const launchOwner = launchOwnerUnverified ? inspectLaunchOwner() : null;
  const launchOwnerPhase = launchOwner?.phase ?? null;
  const preflight = {
    // Stable discriminator for downstream owners consuming --check --json.
    // This identifies the evidence shape only; it is not a runtime or install
    // qualification receipt.
    schema: 'cos_dev_source_preflight_v1',
    mode: 'source-preflight',
    evidenceStatus: 'diagnostic-only',
    validationRunId: randomUUID(),
    validationStartedAt: new Date().toISOString(),
    applicationStarted: false,
    ready: Boolean(source && viteReady && rendererDefaultPortAvailable && debuggerPortAvailable !== false && bridgePort !== null && !existingDevelopmentInstance && !unverifiedBridgePorts.length && !launchOwnerUnverified),
    sourceCheckout: project,
    gitSource: source ? { commit: source.commit, tree: source.tree, dirty: source.dirty } : null,
    electronVite: viteReady ? 'present' : 'missing',
    rendererDefaultPort: RENDERER_DEFAULT_PORT,
    rendererDefaultPortAvailable,
    requestedDebuggerPort: typeof debuggerPort === 'number' ? debuggerPort : null,
    debuggerPortAvailable,
    isolatedAppData: userData,
    bridge: bridgePort === null ? null : `127.0.0.1:${bridgePort}`,
    existingDevelopmentInstance,
    launchOwnerUnverified,
    launchOwnerPhase,
    launchOwnerProcess: launchOwner?.process ?? null,
    // Existing machine-readable handoff projection: every preflight refusal
    // needs an explicit next step. A custody refusal is not a build/runtime
    // failure, and a clean custody state does not mean missing prerequisites
    // are safe to ignore.
    developerHandoff: (() => {
      const failures = new Set([
        !source ? 'git-source-unavailable' : null,
        !viteReady ? 'electron-vite-missing' : null,
        !rendererDefaultPortAvailable ? 'renderer-default-port-unavailable' : null,
        debuggerPort === 'unknown' ? 'debugger-port-invalid' : debuggerPortAvailable === false ? 'debugger-port-unavailable' : null,
        bridgePort === null && !existingDevelopmentInstance ? 'bridge-port-unavailable' : null,
        existingDevelopmentInstance ? 'dev-instance-already-running' : null,
        launchOwnerUnverified ? 'dev-launch-owner-unverified' : null,
        unverifiedBridgePorts.length ? 'bridge-identity-unverified' : null
      ].filter(Boolean));
      const finish = ({ status, reason, nextAction, retrySafe, missingEvidence }) => ({
        status,
        reason,
        nextAction,
        retrySafe,
        missingEvidence,
        ownership: failures.has('dev-launch-owner-unverified') || failures.has('bridge-identity-unverified') || failures.has('dev-instance-already-running')
          ? 'ownership-unverified'
          : 'not-required-by-current-preflight',
        provenance: 'source-preflight-failure-classification'
      });
      if (failures.has('dev-launch-owner-unverified')) return finish({
        status: 'blocked',
        reason: 'launch-custody-unverified',
        nextAction: 'inspect-exact-private-development-owner-before-retry',
        retrySafe: 'retry-after-owner-evidence-is-restored',
        missingEvidence: ['trusted-development-owner-identity']
      });
      if (failures.has('bridge-identity-unverified') || failures.has('dev-instance-already-running')) return finish({
        status: 'blocked',
        reason: 'development-instance-ownership-unverified',
        nextAction: 'inspect-development-process-owner-before-retry',
        retrySafe: 'retry-after-owner-evidence-is-restored',
        missingEvidence: ['trusted-development-process-ownership']
      });
      if (failures.has('electron-vite-missing')) return finish({
        status: 'blocked',
        reason: 'development-dependency-missing',
        nextAction: 'install-checkout-dependencies-before-retry',
        retrySafe: 'retry-after-listed-correction-and-fresh-preflight',
        missingEvidence: ['available-development-dependencies']
      });
      if (failures.has('git-source-unavailable')) return finish({
        status: 'blocked',
        reason: 'source-identity-unavailable',
        nextAction: 'restore-readable-checkout-identity-before-retry',
        retrySafe: 'retry-after-listed-correction-and-fresh-preflight',
        missingEvidence: ['source-identity-evidence']
      });
      if (failures.size) return finish({
        status: 'blocked',
        reason: 'development-preflight-requirement-unmet',
        nextAction: 'resolve-reported-preflight-failure-before-retry',
        retrySafe: 'retry-after-listed-correction-and-fresh-preflight',
        missingEvidence: ['preflight-requirement-evidence']
      });
      return finish({
        status: 'ready-for-next-validation-step',
        reason: null,
        nextAction: null,
        retrySafe: 'safe-to-continue-to-next-qualified-validation-step',
        missingEvidence: ['native-runtime-execution', 'installed-runtime-behavior']
      });
    })(),
    developmentUpdateGates,
    unverifiedBridgePorts,
    bridgeRange: `${BRIDGE_PORT_MIN}-${BRIDGE_PORT_MAX}`,
    failures: [
      !source ? 'git-source-unavailable' : null,
      !viteReady ? 'electron-vite-missing' : null,
      !rendererDefaultPortAvailable ? 'renderer-default-port-unavailable' : null,
      debuggerPort === 'unknown' ? 'debugger-port-invalid' : debuggerPortAvailable === false ? 'debugger-port-unavailable' : null,
      bridgePort === null && !existingDevelopmentInstance ? 'bridge-port-unavailable' : null,
      existingDevelopmentInstance ? 'dev-instance-already-running' : null,
      launchOwnerUnverified ? 'dev-launch-owner-unverified' : null,
      unverifiedBridgePorts.length ? 'bridge-identity-unverified' : null
    ].filter(Boolean),
    installedRuntimeChecked: false
    ,
    proven: [
      'source-preflight-prerequisites-were-evaluated',
      'selected-checkout-identity-and-local-tool-availability-were-inspected'
    ],
    notProven: [
      'application-startup',
      'native-runtime-execution',
      'installed-runtime-behavior'
    ],
    validationCompletedAt: new Date().toISOString()
  };
  if (jsonOutput) {
    console.log(JSON.stringify(preflight));
  } else {
    console.log('[Chat On Steroids dev] Read-only development preflight; no application started.');
    console.log(`[Chat On Steroids dev] Source checkout: ${project}`);
    console.log(`[Chat On Steroids dev] Git source: ${source ? `${source.commit} / ${source.tree} (dirty=${source.dirty})` : 'unavailable'}`);
    console.log(`[Chat On Steroids dev] electron-vite: ${viteReady ? 'present' : 'missing'}`);
    console.log(`[Chat On Steroids dev] Renderer default port localhost:${RENDERER_DEFAULT_PORT}: ${rendererDefaultPortAvailable ? 'available at preflight only' : 'occupied or unverified'}`);
    if (debuggerPort !== null) console.log(`[Chat On Steroids dev] Requested private Electron debugger: ${debuggerPort === 'unknown' ? 'invalid option' : `127.0.0.1:${debuggerPort} (${debuggerPortAvailable ? 'available at preflight only' : 'occupied, invalid or reserved'})`}`);
    console.log(`[Chat On Steroids dev] Isolated app data: ${userData}`);
    console.log(`[Chat On Steroids dev] Free bridge port: ${bridgePort ?? `none in ${BRIDGE_PORT_MIN}-${BRIDGE_PORT_MAX}`}`);
    if (existingDevelopmentInstance) console.log(`[Chat On Steroids dev] Development instance already running on ${existingDevelopmentInstance}; reuse its watcher.`);
    if (launchOwnerUnverified) {
      console.log(`[Chat On Steroids dev] Launch reservation phase: ${launchOwnerPhase}; supervisor: ${launchOwner.process} (custody fence, not application readiness).`);
      if (launchOwnerPhase === 'spawning' && launchOwner.process === 'absent')
        console.log('[Chat On Steroids dev] Original supervisor is absent; descendants can still survive. Post-spawn recovery remains refused until independent child custody is established.');
      console.log('[Chat On Steroids dev] Another cold watcher or stale launch reservation exists; verify its process owner before relaunching.');
    }
    if (unverifiedBridgePorts.length) console.log(`[Chat On Steroids dev] Unverified occupied bridge ports: ${unverifiedBridgePorts.join(', ')}; inspect their process owner before another watcher.`);
    console.log(`[Chat On Steroids dev] Renderer update gate (source only): HTML=${developmentUpdateGates.htmlDocument}; preload=${developmentUpdateGates.preloadCurrentRenderer}. No in-place runtime proof from --check.`);
    console.log('[Chat On Steroids dev] Reload: CSS via Vite HMR; main rebuild restarts dev Electron; unpacked extension requires explicit reload and loaded-worker revision proof.');
    console.log('[Chat On Steroids dev] Handoff: source checks complete -> use existing package/release owners for artifact proof.');
    console.log('[Chat On Steroids dev] Packaged update: qualified build and install; installed/runtime identity not checked.');
  }
  if (!source || !viteReady || !rendererDefaultPortAvailable || debuggerPortAvailable === false || bridgePort === null || existingDevelopmentInstance || unverifiedBridgePorts.length || launchOwnerUnverified) {
    if (!jsonOutput) {
      console.log('[Chat On Steroids dev] Preflight failed: fix the reported source/dependency/bridge issue before requesting release review.');
    }
    process.exitCode = 1;
  }
} else if (recoverRequested) {
  let recovered = null;
  if (!existingDevelopmentInstance && !unverifiedBridgePorts.length && bridgePort !== null) {
    if (recoverAbandonedReservation()) recovered = 'pre-spawn';
    else if (await recoverVerifiedPostSpawn()) recovered = 'verified post-spawn';
  }
  if (recovered === null) {
    console.error(`[Chat On Steroids dev] Recovery refused (${recoveryRefusal || 'preflight-unverified'}): live/unknown private process, descendant, listener, changed marker, or insufficient reservation evidence. No watcher started or unknown state removed.`);
    process.exitCode = 1;
  } else {
    console.log(`[Chat On Steroids dev] Recovered ${recovered === 'pre-spawn' ? 'abandoned pre-spawn' : 'verified post-spawn'} development reservation; no application started. Run --check before separately launching.`);
  }
} else if (existingDevelopmentInstance) {
  console.error(`[Chat On Steroids dev] Development instance already running on ${existingDevelopmentInstance}; reuse or stop that watcher before launching another.`);
  process.exitCode = 1;
} else if (unverifiedBridgePorts.length) {
  console.error(`[Chat On Steroids dev] Cannot verify ownership of unverified occupied bridge ports (${unverifiedBridgePorts.join(', ')}); inspect their process owners before starting another watcher.`);
  process.exitCode = 1;
} else if (!viteReady) {
  console.error('[Chat On Steroids dev] electron-vite is missing from this checkout. Run npm ci in this checkout before starting development.');
  process.exitCode = 1;
} else if (!rendererDefaultPortAvailable) {
  console.error('[Chat On Steroids dev] renderer-default-port-unavailable: localhost:5173 is occupied or unverified; Vite could silently shift the renderer URL. Inspect the port owner and reuse/stop only an authorized disposable dev listener.');
  process.exitCode = 1;
} else if (debuggerPort === 'unknown') {
  console.error('[Chat On Steroids dev] debugger-port-invalid: supply at most one numeric --remote-debugging-port=1..65535 after --; no watcher started.');
  process.exitCode = 1;
} else if (debuggerPortAvailable === false) {
  console.error('[Chat On Steroids dev] debugger-port-unavailable: the requested Electron debugger port is occupied, unverified or reserved for Vite/bridge; no watcher started. Use an authorized free port and verify the live CDP owner separately.');
  process.exitCode = 1;
} else if (bridgePort === null) {
  console.error(`[Chat On Steroids dev] No free browser bridge port in ${BRIDGE_PORT_MIN}-${BRIDGE_PORT_MAX}.`);
  process.exitCode = 1;
} else {
  let ownedLaunchToken = null;
  try {
    mkdirSync(userData, { recursive: true });
    mkdirSync(launchLockDir); // Atomic across independently started Node launchers.
    const token = randomUUID();
    try {
      const startedAt = windowsProcessBirth(process.pid);
      if (process.platform === 'win32' && (!startedAt || startedAt === 'absent')) {
        // No new startup dependency on PowerShell/CIM. A missing birth identity is
        // permanently nonrecoverable by --recover, never a guessed stale PID.
        console.warn('[Chat On Steroids dev] Owner process-birth proof unavailable; a crash reservation will require independent manual inspection.');
      }
      const owner = { schema: 1, checkout: project, identity, pid: process.pid, startedAt, token, phase: 'reserved' };
      writeFileSync(launchOwnerFile, JSON.stringify(owner), { flag: 'wx' });
      ownedLaunchToken = token;
    } catch {
      // Only remove our just-created empty reservation, never an existing foreign lock.
      try { rmdirSync(launchLockDir); } catch { /* Ambiguous ownership fails closed. */ }
    }
  } catch {
    // Another launch, a stale reservation, or inaccessible private root: never spawn blindly.
  }
  if (!ownedLaunchToken) {
    console.error('[Chat On Steroids dev] dev-launch-owner-unverified: another watcher may be starting or its reservation survived a crash. Inspect the exact private development process and reservation before retrying.');
    process.exitCode = 1;
  } else {
    // An exited watcher is not proof that an Electron process it launched has
    // stopped using this checkout's private userData. Keep the reservation
    // after an ambiguous exit; --recover already owns the independent dead-
    // process, descendant and listener qualification for such a marker.
    let spawnedWatcherPid = null;
    let watcherExitObserved = false;
    const transition = (phase, extra = {}) => {
      const previous = JSON.parse(readFileSync(launchOwnerFile, 'utf8'));
      if (previous.token !== ownedLaunchToken) throw new Error('development reservation owner changed');
      const temp = path.join(launchLockDir, `${ownedLaunchToken}.tmp`);
      writeFileSync(temp, JSON.stringify({ ...previous, phase, ...extra }), { flag: 'wx' });
      renameSync(temp, launchOwnerFile);
    };
    process.once('exit', () => {
      // Clean only our own reservation. A crash leaves a fail-closed diagnostic rather than
      // starting a second watcher against a possibly surviving child.
      try {
        if (JSON.parse(readFileSync(launchOwnerFile, 'utf8')).token !== ownedLaunchToken) return;
        if (process.platform === 'win32' && spawnedWatcherPid !== null &&
            (!watcherExitObserved || windowsProcessBirth(spawnedWatcherPid) !== 'absent' ||
              !windowsPostSpawnProcessesClear(process.pid, spawnedWatcherPid))) {
          console.error('[Chat On Steroids dev] Watcher exited but descendant/process custody is not clear; launch reservation retained for verified recovery.');
          return;
        }
        unlinkSync(launchOwnerFile);
        rmdirSync(launchLockDir);
      } catch { /* Never remove uncertain files or userData. */ }
    });
    console.log('[Chat On Steroids dev] Starting Vite/Electron directly; no package or installer is built.');
    console.log(`[Chat On Steroids dev] Source: ${project}`);
    console.log(`[Chat On Steroids dev] Isolated app data: ${userData}`);
    console.log(`[Chat On Steroids dev] Isolated browser bridge: 127.0.0.1:${bridgePort}`);

    // This durable phase fence precedes process creation. If the parent dies after
    // this point, a surviving child is possible; no automatic recovery is allowed.
    transition('spawning');
    let child;
    try {
      child = spawn(process.execPath, [electronVite, 'dev', '--watch', ...electronArguments], {
        cwd: project,
        env: { ...process.env, COS_DEV_USER_DATA: userData, COS_DEV_BRIDGE_PORT: String(bridgePort), CLF_DEBUG: process.env.CLF_DEBUG || '1' },
        stdio: 'inherit'
      });
    } catch {
      // No child was returned. Let the ordinary owned process-exit barrier release
      // this launch reservation; do not expose an unbounded OS error/command line.
      console.error('[Chat On Steroids dev] Could not create electron-vite watcher process; inspect local runtime permissions.');
      process.exitCode = 1;
    }
    if (child) {
      if (Number.isSafeInteger(child.pid) && child.pid > 0) spawnedWatcherPid = child.pid;
      // The phase barrier was installed before spawn. Only a positively read
      // Windows child PID and immutable birth permit later post-spawn recovery.
      const childBirth = Number.isSafeInteger(child.pid) ? windowsProcessBirth(child.pid) : null;
      if (childBirth && childBirth !== 'absent') {
        transition('spawning', {
          childPid: child.pid, childStartedAt: childBirth,
          rendererPort: RENDERER_DEFAULT_PORT, bridgePort, debugPort: debuggerPort
        });
      }
      let childFailed = false;

      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
          if (!child.killed) child.kill(signal);
        });
      }

      child.on('error', error => {
        childFailed = true;
        console.error(`[Chat On Steroids dev] Could not start electron-vite: ${error.message}`);
        process.exitCode = 1;
      });
      child.on('exit', (code, signal) => {
        watcherExitObserved = true;
        // Windows may deliver console Ctrl+C as STATUS_CONTROL_C_EXIT with no
        // Node signal. This is an interrupted watcher, not a build failure.
        const windowsCtrlC = process.platform === 'win32' && code === 3221225786 && !signal;
        if (signal) console.log(`[Chat On Steroids dev] Stopped by ${signal}.`);
        if (windowsCtrlC) console.log('[Chat On Steroids dev] Stopped by Windows console Ctrl+C.');
        if (code && !signal && !windowsCtrlC) console.error(`[Chat On Steroids dev] electron-vite stopped (${describeChildExit(code, signal)}). Check the watcher output above for the first build or runtime error.`);
        // Node may report an error before an exit. That exit must not erase the failure.
        process.exitCode = childFailed ? 1 : (code ?? (signal ? 1 : 0));
      });
    }
  }
}
}

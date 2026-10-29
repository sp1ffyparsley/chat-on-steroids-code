import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { createServer } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/dev-fast.mjs', import.meta.url));
const project = path.resolve(path.dirname(script), '..');
const liveProbe = path.join(project, 'test', 'dev-fast-live-probe.cjs');

// A clean release snapshot has no ignored scratch tree. Own this reusable test
// parent explicitly instead of depending on artifacts from earlier development.
beforeAll(() => { mkdirSync(path.join(project, '.test_tmp'), { recursive: true }); });

// Some qualification cases intentionally leave ownership markers behind to prove
// fail-closed behavior. The canonical checkout must not inherit an empty marker
// from an interrupted local run, since that represents unknown ownership rather
// than a valid fixture state.
afterEach(() => {
  const identity = createHash('sha256').update(realpathSync.native(project)).digest('hex').slice(0, 12);
  const lock = path.join(tmpdir(), 'chat-on-steroids-fast-dev', identity, '.dev-fast-launch');
  if (!existsSync(lock)) return;
  const entries = readdirSync(lock);
  if (entries.length === 0) rmSync(lock, { recursive: true, force: true });
});

type LocalUpdateFixtureChild = { child: ReturnType<typeof spawn>; closed: boolean };
function previewFixtureDescendant(value: unknown, marker: string, parentPid: number | null): number | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  return row.event === 'fixture-descendant-created' && row.marker === marker &&
    row.parentPid === parentPid && Number.isSafeInteger(parentPid) &&
    Number.isSafeInteger(row.pid) && Number(row.pid) > 0 && row.pid !== parentPid
    ? Number(row.pid) : null;
}

function observeLocalUpdateFixtureChild(child: ReturnType<typeof spawn>): LocalUpdateFixtureChild {
  const owner = { child, closed: false };
  child.once('close', () => { owner.closed = true; });
  return owner;
}
async function localUpdateFixtureCleanupReady(
  compilerAbsenceVerified: boolean, owners: Array<LocalUpdateFixtureChild | null>
): Promise<boolean> {
  const settled = await Promise.all(owners.map(async owner => {
    if (!owner || owner.closed) return true;
    const { child } = owner;
    return await new Promise<boolean>(resolve => {
      const finish = (closed: boolean) => {
        clearTimeout(timer);
        child.off('close', onClose);
        resolve(closed);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => {
        // Only this fixture's own child is eligible for cancellation. A failed
        // close/descendant proof retains its files even after this kill request.
        try { child.kill('SIGKILL'); } catch { /* custody remains unknown */ }
        finish(false);
      }, 2500);
      child.once('close', onClose);
      try { if (child.stdin?.writable) child.stdin.write('cancel\n'); }
      catch { finish(false); }
    });
  }));
  return compilerAbsenceVerified && settled.every(Boolean);
}

// Only these non-listener fixtures own this preload. Keep real CDP/process probes intact.
const isolatedBridgePortProbePreload = `
const net = require('node:net');
const createServer = net.createServer;
net.createServer = (...args) => {
  const server = createServer(...args);
  const listen = server.listen.bind(server), close = server.close.bind(server);
  let fixtureBridgeProbe = false;
  server.listen = (port, host, callback) => {
    if (Number(port) >= 8765 && Number(port) <= 8796) {
      fixtureBridgeProbe = true;
      process.nextTick(callback);
      return server;
    }
    return listen(port, host, callback);
  };
  server.close = callback => {
    if (!fixtureBridgeProbe) return close(callback);
    process.nextTick(callback);
    return server;
  };
  return server;
};
require('node:module').syncBuiltinESMExports();
`;

describe('fast development launcher', () => {
  it('reads exact Windows process births through a native handle while retaining CIM-compatible precision', () => {
    const source = readFileSync(script, 'utf8');
    const start = source.indexOf('const windowsProcessBirth = pid => {');
    const end = source.indexOf('\n};', start) + 3;
    const snippet = source.slice(start, end);
    let query = '';
    const output = { status: 0 as number | null, error: undefined as Error | undefined, stdout: '2026-10-20T10:09:05.9552520Z' };
    const birth = vm.runInNewContext(snippet + '\nwindowsProcessBirth', {
      process: { platform: 'win32' },
      spawnSync: (_exe: string, args: string[]) => { query = args[args.length-1]!; return output; }
    }) as (pid: number) => string | null;
    expect(birth(12345)).toBe(output.stdout);
    expect(query).toContain('[Diagnostics.Process]::GetProcessById(12345)');
    expect(query).not.toContain('Get-CimInstance');
    expect(query).toContain('.Dispose()');
    output.stdout = 'absent'; expect(birth(12345)).toBe('absent');
    output.stdout = 'not-verifiable'; expect(birth(12345)).toBeNull();
    output.stdout = '2026-10-20T10:09:05.9552520Z'; output.status = 1; expect(birth(12345)).toBeNull();
    output.status = null; output.error = new Error('timeout'); expect(birth(12345)).toBeNull();
    expect(birth(-1)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('keeps native Windows birth observations compatible with durable CIM owner timestamps', () => {
    const source = readFileSync(script, 'utf8');
    const start = source.indexOf('const windowsProcessBirth = pid => {');
    const end = source.indexOf('\n};', start) + 3;
    const birth = vm.runInNewContext(source.slice(start, end) + '\nwindowsProcessBirth', { process, spawnSync }) as (pid: number) => string | null;
    const expected = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
      '$ErrorActionPreference="Stop";$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + process.pid + '\";$p.CreationDate.ToUniversalTime().ToString("o")'],
      { encoding:'utf8', windowsHide:true, timeout:5000 });
    expect(expected.status, expected.stderr).toBe(0);
    expect(expected.stdout.trim()).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(birth(process.pid)).toBe(expected.stdout.trim());
    expect(birth(process.pid)).toBe(expected.stdout.trim());
  });

  it('captures the exact fixture descendant before a failed preview can ever report ready', () => {
    const receipt = { event: 'fixture-descendant-created', pid: 23456, parentPid: 12345, marker: 'owned-once' };
    expect(previewFixtureDescendant(receipt, 'owned-once', 12345)).toBe(23456);
    expect(previewFixtureDescendant({ ...receipt, event: 'ready' }, 'owned-once', 12345)).toBeNull();
    expect(previewFixtureDescendant({ ...receipt, marker: 'foreign' }, 'owned-once', 12345)).toBeNull();
    expect(previewFixtureDescendant({ ...receipt, parentPid: 9999 }, 'owned-once', 12345)).toBeNull();
    expect(previewFixtureDescendant({ ...receipt, pid: -1 }, 'owned-once', 12345)).toBeNull();
  });

  it('retains child cleanup custody when a real preview parent exits before ready', async () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-preview-early-failure-'));
    const marker = 'cos-preview-fixture-' + randomUUID();
    const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000);setTimeout(()=>process.exit(0),180000).unref()','--',${JSON.stringify(marker)}],{stdio:'ignore',detached:true});process.stdout.write(JSON.stringify({event:'fixture-descendant-created',pid:child.pid,parentPid:process.pid,marker:${JSON.stringify(marker)}})+'\\n');child.unref();process.exitCode=1;`;
    const parent = spawn(process.execPath, ['-e', source], { cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let descendant: number | null = null;
    let output = '';
    parent.stdout!.on('data', data => { output += String(data); const row = output.split('\n').find(Boolean); if (row) { try { descendant = previewFixtureDescendant(JSON.parse(row), marker, parent.pid ?? null); } catch { /* await full record */ } } });
    let absent = false;
    try {
      expect(await new Promise(resolve => parent.once('close', resolve))).toBe(1);
      expect(descendant, 'Cleanup identity must be captured although no ready event exists').not.toBeNull();
      expect(output).not.toContain('"event":"ready"');
    } finally {
      if (descendant !== null) {
        // This test created and observed the marked child, not an arbitrary live process.
        try { process.kill(descendant, 'SIGKILL'); } catch { /* independently check below */ }
        for (let attempt = 0; attempt < 15; attempt++) {
          if (process.platform === 'win32') {
            const census = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
              '$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + descendant + '\";if($null -eq $p){"absent"}else{"present"}'],
              { encoding:'utf8', windowsHide:true, timeout:5000 });
            absent = census.status === 0 && census.stdout.trim() === 'absent';
          } else { try { process.kill(descendant, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; } }
          if (absent) break;
          await new Promise(resolve => setTimeout(resolve,100));
        }
      }
      if (absent) rmSync(root, { recursive:true, force:true });
    }
    expect(absent, 'Early-failure child must be absent before fixture removal').toBe(true);
  }, 15000);

  it('retains a local-update fixture until exact compiler absence and child close are both observed', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0, signalCode: null, stdin: null, kill: () => true
    }) as unknown as ReturnType<typeof spawn>;
    const owner = observeLocalUpdateFixtureChild(child);
    let settled = false;
    const readiness = localUpdateFixtureCleanupReady(true, [owner]).then(ready => {
      settled = true;
      return ready;
    });
    try {
      child.emit('exit', 0, null);
      await new Promise(resolve => setImmediate(resolve));
      expect(owner.closed).toBe(false);
      expect(settled, 'An exited wrapper does not prove inherited output handles closed').toBe(false);
    } finally { child.emit('close', 0, null); }
    expect(await readiness).toBe(true);
    expect(owner.closed).toBe(true);
    expect(await localUpdateFixtureCleanupReady(false, [owner]),
      'Even observed child close cannot clear an absent or failed compiler census').toBe(false);
  });

  it('offers one bounded personal local-update command with exact private reuse, fresh drift repair and guarded main/companion handoffs', async () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-local-update-spaces-'));
    const local = path.join(root, 'scripts', 'dev-fast.mjs');
    const compiler = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const platformTypeScript = `typescript-${process.platform}-${process.arch}`;
    const fakeNativeTypeScript = path.join(root, 'node_modules', '@typescript',
      platformTypeScript, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
    const fakeVitestRuntime = path.join(root, 'node_modules', 'vitest', 'dist', 'cli.js');
    const fakeViteRuntime = path.join(root, 'node_modules', 'vite', 'dist', 'cli.js');
    const invoke = (...flags: string[]) => {
      const command = spawnSync(process.execPath, [local, ...flags], {
        cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024
      });
      expect(command.stdout.trim().startsWith('{'), command.stderr).toBe(true);
      return { code: command.status, receipt: JSON.parse(command.stdout) };
    };
    let runningUpdate: ReturnType<typeof spawn> | null = null;
    let interactiveUpdate: ReturnType<typeof spawn> | null = null;
    let compilerChild: LocalUpdateFixtureChild | null = null;
    let previewChild: LocalUpdateFixtureChild | null = null;
    let compilerAbsenceVerified = true;
    try {
      mkdirSync(path.dirname(local), { recursive: true });
      mkdirSync(path.dirname(compiler), { recursive: true });
      mkdirSync(path.join(root, '.test_tmp'));
      for (const area of ['main', 'preload', 'renderer'])
        mkdirSync(path.join(root, 'src', area), { recursive: true });
      mkdirSync(path.join(root, 'extension'));
      copyFileSync(script, local);
      for (const name of ['dev-fast-preview.mjs', 'dev-fast-local-update.mjs'])
        copyFileSync(path.join(project, 'scripts', name), path.join(root, 'scripts', name));
      for (const name of ['electron.vite.config.ts', 'package-lock.json', 'tsconfig.json'])
        writeFileSync(path.join(root, name), name);
      writeFileSync(path.join(root, 'vitest.config.ts'), 'suite-approved');
      mkdirSync(path.join(root, 'test', 'fixtures'), { recursive: true });
      writeFileSync(path.join(root, 'test', 'fixtures', 'validator-helper.mjs'), 'support-ready');
      writeFileSync(path.join(root, 'scripts', 'validator-helper.mjs'), 'script-ready');
      writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}');
      // The real validator entrypoints delegate to mutable packages that used
      // to be absent from the PASS key. Keep those distinct inputs in this
      // disposable fixture without running a production compiler binary.
      for (const file of [
        path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'),
        fakeNativeTypeScript, fakeVitestRuntime, fakeViteRuntime,
        path.join(root, 'node_modules', '@vitest', 'runner', 'dist', 'index.js')
      ]) mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(path.join(root, 'node_modules', 'typescript', 'package.json'),
        JSON.stringify({ name: 'typescript', optionalDependencies: {
          [`@typescript/${platformTypeScript}`]: '1.0.0' } }));
      writeFileSync(path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'),
        'fixture typescript entrypoint');
      writeFileSync(path.join(root, 'node_modules', '@typescript', platformTypeScript,
        'package.json'), '{"name":"fixture-native-typescript"}');
      writeFileSync(fakeNativeTypeScript, 'fixture native compiler bytes');
      writeFileSync(path.join(root, 'node_modules', 'vitest', 'package.json'),
        '{"name":"vitest","type":"module"}');
      writeFileSync(fakeVitestRuntime, [
        "import {appendFileSync} from 'node:fs';",
        "appendFileSync('.test_tmp/validator-executions.log','focused-vitest\\n');",
        "console.log('fixture renderer tests passed');"
      ].join('\n'));
      writeFileSync(path.join(root, 'node_modules', 'vite', 'package.json'),
        '{"name":"vite"}');
      writeFileSync(fakeViteRuntime, 'fixture Vite runner implementation');
      writeFileSync(path.join(root, 'node_modules', '@vitest', 'runner', 'dist', 'index.js'),
        'fixture Vitest runner support');
      writeFileSync(path.join(root, 'extension', 'manifest.json'), '{"manifest_version":3,"name":"fixture","version":"1.0"}');
      writeFileSync(path.join(root, 'extension', 'background.js'), 'fixture companion bytes');
      for (const area of ['main', 'preload', 'renderer'])
        writeFileSync(path.join(root, 'src', area, area === 'renderer' ? 'index.html' : 'index.ts'), area);
      writeFileSync(compiler, `
const fs=require('node:fs'),path=require('node:path');
const stage=process.argv[process.argv.indexOf('--outDir')+1];
for(const name of ['main/index.js','preload/index.js','renderer/index.html','renderer/assets/app.js']){
  const file=path.join(stage,name);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,name==='renderer/index.html' ?
    fs.readFileSync(path.join(process.cwd(),'src','renderer','index.html')) :
    'compiled '+name);
}
`);
      mkdirSync(path.join(root, 'test'), { recursive: true });
      for (const name of ['dev-fast', 'renderer-layout', 'renderer-state', 'extension', 'content-script'])
        writeFileSync(path.join(root, 'test', `${name}.test.ts`), `fixture ${name} test source`);
      for (const name of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
        const dest = path.join(root, 'out', name);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, 'historical-generated-output-untouched');
      }
      const review = ['--local-update=renderer', '--review-only', '--json'];
      const first = invoke(...review);
      expect(first.code, JSON.stringify({ reason: first.receipt.reason,
        stages: first.receipt.stages, nextAction: first.receipt.nextAction })).toBe(0);
      expect(first.receipt).toMatchObject({
        schema: 'cos_personal_local_update_v1', mode: 'renderer',
        status: 'renderer-private-review-verified',
        buildStrategy: 'new-reproducible-private-generation',
        activationDecision: {
          schema: 'cos_dev_local_activation_decision_v1', mode: 'renderer',
          decision: 'native-activation-deferred',
          eligibleForNativeActivation: false,
          distributionPackageBuilt: false,
          requiresReleasePackagingDecision: true,
          exactRuntimeProof: 'not-observed',
          availablePrivateWorkflow: 'isolated-renderer-http-preview',
          rollback: { existingInstalledStatePreserved: true,
            installedRollbackBytesVerified: false },
          risk: { state: 'unverified', eligibleForNativeActivation: false }
        },
        nativeRuntimeVerified: false, installedRuntimeVerified: false,
        eligibleForProductionActivation: false, changesInstalled: false,
        sharedOutModified: false,
        stages: {
          changedCodeValidation: { status: 'not-run' },
          compiledStage: { status: 'passed' },
          confirmationCompilation: { status: 'passed' },
          privatePublication: { status: 'passed' },
          rendererHealth: { status: 'passed' },
          packaging: { status: 'not-run' },
          safeQuiescence: { status: 'not-run' },
          nativeReattach: { status: 'not-run' }
        }
      });
      expect(first.receipt.generation).toMatch(/^chat42-private-out-/);
      expect(first.receipt.rendererAssets.count).toBe(2);
      expect(first.receipt.rendererAssets).toMatchObject({
        httpVerifiedAssetCount: 2,
        servedRendererSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
        qualifiedRendererManifestSha256: expect.stringMatching(/^[A-F0-9]{64}$/)
      });
      expect(first.receipt.stages.compiledStage.exitCode).toBe(0);
      expect(first.receipt.stages.confirmationCompilation.exitCode).toBe(0);
      expect(first.receipt.executionTiming).toMatchObject({
        clock: 'process.hrtime.bigint', failedStage: null,
        localPreparation: { status: 'completed' }, privateReview: { status: 'passed' },
        foregroundControl: { status: 'not-run', durationMs: null },
        liveLifecycle: { status: 'not-invoked', durationMs: null,
          admissionPauseRequested: false, drainRequested: false,
          activationReadiness: 'not-observed' }
      });
      expect(first.receipt.executionTiming.commandDurationMs).toBe(first.receipt.durationMs);
      expect(first.receipt.executionTiming.localPreparation.durationMs).toBeGreaterThanOrEqual(0);
      expect(first.receipt.executionTiming.privateReview.durationMs).toBeGreaterThanOrEqual(0);
      expect(first.receipt.executionTiming.localPreparation.durationMs +
        first.receipt.executionTiming.privateReview.durationMs).toBeLessThanOrEqual(first.receipt.durationMs);
      const exact = path.join(root, '.test_tmp', first.receipt.generation);
      expect(existsSync(path.join(exact, 'evidence.json'))).toBe(true);
      const second = invoke(...review);
      expect(second.code).toBe(0);
      expect(second.receipt).toMatchObject({
        status: 'renderer-private-review-verified',
        buildStrategy: 'reuse-exact-source-private-generation',
        generation: first.receipt.generation,
        stages: { compiledStage: { status: 'not-run' },
          exactGenerationSelection: { status: 'passed', catalogCount: 1,
            verifiedAttempts: 1, staleRejected: 0 },
          rendererHealth: { status: 'passed' } }
      });
      expect(second.receipt.stages.rendererHealth.durationMs).toBeGreaterThanOrEqual(0);
      expect(second.receipt.durationMs).toBeGreaterThanOrEqual(0);
      const notValidated = invoke('--local-update=renderer', '--json');
      expect(notValidated.code).toBe(1);
      expect(notValidated.receipt.reason).toBe('local-update-changed-code-validation-refused');
      expect(notValidated.receipt.stages.changedCodeValidation).toMatchObject({
        status: 'refused', executedThisRun: false,
        checks: [{ name: 'typescript', reason: 'validator-executable-missing', executedThisRun: false }]
      });
      expect(notValidated.receipt.executionTiming).toMatchObject({
        failedStage: 'changedCodeValidation', privateReview: { status: 'not-run', durationMs: null }
      });
      expect(notValidated.receipt.generation).toBeNull();

      // A normal (non-review-only) invocation must execute both actual
      // validator child processes before touching any staged build.
      const fakeTsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
      const fakeVitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
      const validatorRunFile = path.join(root, '.test_tmp', 'validator-executions.log');
      const validatorRuns = () => existsSync(validatorRunFile)
        ? readFileSync(validatorRunFile, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
      mkdirSync(path.dirname(fakeTsc), { recursive: true });
      mkdirSync(path.dirname(fakeVitest), { recursive: true });
      writeFileSync(fakeTsc, 'require("node:fs").appendFileSync(".test_tmp/validator-executions.log","typescript\\n");console.log("fixture types verified");');
      writeFileSync(fakeVitest, "import './dist/cli.js';");
      // Cache discovery is still local preparation. An unreadable retained
      // catalog must return bounded failure/timing evidence, not throw before
      // the command can publish its final receipt and incident handoff.
      const generationEvidenceFile = path.join(exact, 'evidence.json');
      const generationEvidenceBefore = readFileSync(generationEvidenceFile, 'utf8');
      writeFileSync(generationEvidenceFile, '{');
      const invalidCatalog = spawnSync(process.execPath,
        [local, '--local-update=renderer', '--json'],
        { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
      writeFileSync(generationEvidenceFile, generationEvidenceBefore);
      expect(invalidCatalog.status).toBe(1);
      expect(invalidCatalog.stdout.trim(),
        'A failed local update must publish one final receipt, not only an uncaught stack').not.toBe('');
      const catalogFailure = JSON.parse(invalidCatalog.stdout);
      expect(catalogFailure).toMatchObject({
        schema: 'cos_personal_local_update_v1',
        status: 'refused', reason: 'local-update-generation-evidence-unverified',
        stages: { validationCache: { status: 'refused' },
          compiledStage: { status: 'not-run' }, safeQuiescence: { status: 'not-run' } },
        executionTiming: { clock: 'process.hrtime.bigint',
          failedStage: 'validationCache',
          localPreparation: { status: 'refused' },
          privateReview: { status: 'not-run', durationMs: null },
          liveLifecycle: { status: 'not-invoked', durationMs: null,
            admissionPauseRequested: false, drainRequested: false,
            activationReadiness: 'not-observed' } },
        incidentHandoff: { profileBound: false, recordedInNativeIncidentFolder: false }
      });
      expect(catalogFailure.executionTiming.localPreparation.durationMs).toBeGreaterThanOrEqual(0);
      expect(catalogFailure.stages.validationCache.durationMs).toBeGreaterThanOrEqual(0);
      expect(catalogFailure.executionTiming.commandDurationMs).toBe(catalogFailure.durationMs);
      expect(invalidCatalog.stdout.trim().split(/\r?\n/)).toHaveLength(1);
      expect(readFileSync(generationEvidenceFile, 'utf8')).toBe(generationEvidenceBefore);
      expect(validatorRuns()).toEqual([]);
      const validated = invoke('--local-update=renderer', '--json');
      expect(validated.code).toBe(0);
      expect(validatorRuns()).toEqual(['typescript', 'focused-vitest']);
      expect(validated.receipt).toMatchObject({
        generation: first.receipt.generation, status: 'renderer-private-review-verified',
        reviewOnly: false, nativeRuntimeVerified: false,
        inputProvenance: {
          schema: 'cos_dev_update_input_v1',
          nativeAbi: 'not-verified-by-local-source-workflow',
          productionActivation: 'requires-root-strict-dependency-native-abi-and-lifecycle-qualification',
          hashes: { packageJson: expect.stringMatching(/^[A-F0-9]{64}$/),
            packageLock: expect.stringMatching(/^[A-F0-9]{64}$/),
            typescriptCli: expect.stringMatching(/^[A-F0-9]{64}$/) }
        },
        stages: { changedCodeValidation: { status: 'passed', executedThisRun: true,
          checks: [{ name: 'typescript', status: 'passed', exitCode: 0, executedThisRun: true },
            { name: 'focused-vitest', status: 'passed', exitCode: 0, executedThisRun: true }] },
          inputProvenance: { sourceAndToolInputsStable: true } }
      });
      expect(validated.receipt.activationDecision).toMatchObject({
        decision: 'native-activation-deferred',
        validatorSupportSha256: validated.receipt.inputProvenance.validatorSupport.sha256,
        validatorSupportScope: 'repository-vitest-config-scripts-and-shared-test-support',
        selectedTestPaths: ['test/renderer-layout.test.ts', 'test/renderer-state.test.ts'],
        loadedBytesVerified: false
      });
      expect(validated.receipt.stages.validationCache).toMatchObject({
        status: 'written', generation: first.receipt.generation,
        sourceSha256: validated.receipt.sourceSha256,
        inputDigest: validated.receipt.inputProvenance.digest,
        catalogCount: 1, matchingReceipts: 0, exactVerifierAttempts: 0
      });
      expect(validated.receipt.stages.validationCache.lookupDurationMs).toBeGreaterThanOrEqual(0);
      expect(validated.receipt.stages.validationCache.writeDurationMs).toBeGreaterThanOrEqual(0);
      expect(validated.receipt.stages.validationCache.durationMs).toBe(
        validated.receipt.stages.validationCache.lookupDurationMs +
        validated.receipt.stages.validationCache.writeDurationMs);
      // A newest-looking stale receipt cannot confer validation authority.
      // Skip its nonexistent output; the current generation still gets the
      // authoritative entire-tree selector before cached test reuse.
      const staleName = 'chat42-private-out-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
      const staleFolder = path.join(root, '.test_tmp', staleName);
      mkdirSync(staleFolder);
      const staleEvidence = JSON.parse(readFileSync(path.join(exact, 'evidence.json'), 'utf8'));
      writeFileSync(path.join(staleFolder, 'evidence.json'), JSON.stringify({
        ...staleEvidence, name: staleName, sourceSha256: 'F'.repeat(64),
        generatedAt: '2099-01-01T00:00:00.000Z'
      }));
      const cachedValidation = invoke('--local-update=renderer', '--json');
      rmSync(staleFolder, { recursive: true, force: true });
      expect(cachedValidation.code).toBe(0);
      expect(cachedValidation.receipt).toMatchObject({
        generation: first.receipt.generation,
        buildStrategy: 'reuse-exact-source-private-generation',
        validationStrategy: 'reuse-exact-source-test-receipt',
        executionTiming: { postPrivateReadiness: {
          status: 'passed', durationMs: expect.any(Number),
          productionDowntimeMs: null, nativeAdmissionObserved: false } },
        stages: {
          changedCodeValidation: { status: 'passed', reused: true,
            executedThisRun: false, cacheGeneration: first.receipt.generation,
            checks: [{ name: 'typescript', executedThisRun: false, durationMs: null },
              { name: 'focused-vitest', executedThisRun: false, durationMs: null }] },
          validationCache: { status: 'reused', generation: first.receipt.generation,
            catalogCount: 2, metadataSkipped: 1, matchingReceipts: 1,
            exactVerifierAttempts: 1 },
          exactGenerationSelection: { status: 'passed', verifiedAttempts: 0,
            reusedValidatedSelector: true, priorCacheSelectorAttempts: 1 },
          compiledStage: { status: 'not-run' }
        }
      });
      expect(cachedValidation.receipt.executionTiming.postPrivateReadiness.durationMs)
        .toBeGreaterThanOrEqual(
          cachedValidation.receipt.stages.sourceReadinessFence.durationMs);
      // Cache reuse skips validator executions; it does not promise that OS scheduling,
      // exact selection and private HTTP review make the whole invocation always faster.
      expect(validatorRuns()).toEqual(['typescript', 'focused-vitest']);
      expect(cachedValidation.receipt.sourceSha256).toBe(validated.receipt.sourceSha256);
      // A changed inherited validator runtime option must invalidate the
      // earlier PASS, even when source and selected tests are identical.
      const originalNodeOptions = process.env.NODE_OPTIONS;
      const changedNodeOptions = originalNodeOptions === '--no-warnings' ?
        '--trace-warnings' : '--no-warnings';
      const changedRuntime = spawnSync(process.execPath,
        [local, '--local-update=renderer', '--json'], {
          cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
          env: { ...process.env, NODE_OPTIONS: changedNodeOptions }
        });
      expect(changedRuntime.status).toBe(0);
      const changedRuntimeReceipt = JSON.parse(changedRuntime.stdout);
      expect(changedRuntimeReceipt.validationStrategy).toBe('execute-selected-tests');
      expect(changedRuntimeReceipt.inputProvenance.digest)
        .not.toBe(validated.receipt.inputProvenance.digest);
      expect(changedRuntimeReceipt.inputProvenance.validatorRuntime).toMatchObject({
        schema: 'cos_dev_validator_runtime_v1',
        nodeOptions: expect.stringMatching(/^[A-F0-9]{64}$/)
      });
      expect(changedRuntime.stdout).not.toContain(changedNodeOptions);
      expect(validatorRuns()).toEqual(['typescript', 'focused-vitest',
        'typescript', 'focused-vitest']);
      expect(process.env.NODE_OPTIONS).toBe(originalNodeOptions);
      // Restore this disposable fixture's prior execution counter so later
      // test phases can assert their own independent validator runs.
      writeFileSync(validatorRunFile, 'typescript\nfocused-vitest\n');
      // CI can change how Vitest evaluates tests without changing the source,
      // selected test files or NODE_OPTIONS. A changed inherited CI value
      // must never be allowed to borrow the previous successful PASS.
      const inheritedCI = process.env.CI;
      const changedCI = inheritedCI === 'true' ? 'false' : 'true';
      const changedCIResult = spawnSync(process.execPath,
        [local, '--local-update=renderer', '--json'], {
          cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
          env: { ...process.env, CI: changedCI }
        });
      expect(changedCIResult.status).toBe(0);
      const changedCIReceipt = JSON.parse(changedCIResult.stdout);
      expect(changedCIReceipt.validationStrategy).toBe('execute-selected-tests');
      expect(changedCIReceipt.inputProvenance.digest)
        .not.toBe(validated.receipt.inputProvenance.digest);
      expect(validatorRuns()).toEqual(['typescript', 'focused-vitest',
        'typescript', 'focused-vitest']);
      expect(process.env.CI).toBe(inheritedCI);
      writeFileSync(validatorRunFile, 'typescript\nfocused-vitest\n');
      for (const [name, property, differentValue] of [
        ['NODE_ENV', 'nodeEnv', 'cos42-standalone-test'],
        ['TZ', 'timeZone', 'Etc/GMT+5'],
        ['VITEST_MAX_THREADS', 'vitestMaxThreads', '7']
      ] as const) {
        const changedValue = process.env[name] === differentValue ?
          `${differentValue}-alternate` : differentValue;
        const changed = spawnSync(process.execPath,
          [local, '--local-update=renderer', '--json'], {
            cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
            env: { ...process.env, [name]: changedValue }
          });
        expect(changed.status, name).toBe(0);
        const receipt = JSON.parse(changed.stdout);
        expect(receipt.validationStrategy, name).toBe('execute-selected-tests');
        expect(receipt.inputProvenance.validatorRuntime[property], name)
          .toMatch(/^[A-F0-9]{64}$/);
        expect(receipt.inputProvenance.digest, name)
          .not.toBe(validated.receipt.inputProvenance.digest);
        expect(changed.stdout, name)
          .not.toContain(`"${property}":"${changedValue}"`);
        expect(validatorRuns()).toEqual(['typescript', 'focused-vitest',
          'typescript', 'focused-vitest']);
        writeFileSync(validatorRunFile, 'typescript\nfocused-vitest\n');
      }
      // A constant NODE_OPTIONS string is not evidence that its independently
      // loaded file is unchanged. When external loader bytes are unsealed, each
      // invocation must execute validators and never publish reusable PASS.
      const runtimeLoader = path.join(root, 'runtime-preload.cjs');
      writeFileSync(runtimeLoader, 'module.exports = 1;\n');
      const loaderNodeOptions = [originalNodeOptions, '--require=./runtime-preload.cjs']
        .filter(Boolean).join(' ');
      const loaderEnvironment = { ...process.env, NODE_OPTIONS: loaderNodeOptions };
      const loaderInvocations = [];
      for (const source of ['module.exports = 1;\n', 'module.exports = 2;\n']) {
        writeFileSync(runtimeLoader, source);
        const updated = spawnSync(process.execPath,
          [local, '--local-update=renderer', '--json'], {
            cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
            env: loaderEnvironment
          });
        expect(updated.status, updated.stderr).toBe(0);
        const receipt = JSON.parse(updated.stdout);
        expect(receipt.validationStrategy).toBe('execute-selected-tests');
        expect(receipt.inputProvenance.validatorRuntime).toMatchObject({
          cacheReuseSafe: false,
          cacheBypassReason: 'unsealed-inherited-node-loader'
        });
        expect(receipt.stages.validationCache).toMatchObject({
          status: 'inherited-runtime-cache-bypassed',
          reason: 'unsealed-inherited-node-loader',
          exactVerifierAttempts: 0
        });
        expect(updated.stdout).not.toContain('runtime-preload.cjs');
        expect(existsSync(path.join(exact,
          `validation-${receipt.inputProvenance.digest}.json`))).toBe(false);
        loaderInvocations.push(receipt);
      }
      expect(loaderInvocations[0].inputProvenance.digest)
        .toBe(loaderInvocations[1].inputProvenance.digest);
      expect(loaderInvocations[0].sourceSha256).toBe(loaderInvocations[1].sourceSha256);
      expect(validatorRuns()).toEqual(['typescript', 'focused-vitest',
        'typescript', 'focused-vitest', 'typescript', 'focused-vitest']);
      writeFileSync(validatorRunFile, 'typescript\nfocused-vitest\n');
      const nodePathValue = path.join(root, 'unsealed-module-directory');
      const externalModuleResolution = spawnSync(process.execPath,
        [local, '--local-update=renderer', '--json'], {
          cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
          env: { ...process.env, NODE_PATH: nodePathValue }
        });
      expect(externalModuleResolution.status, externalModuleResolution.stderr).toBe(0);
      const externalModuleReceipt = JSON.parse(externalModuleResolution.stdout);
      expect(externalModuleReceipt.validationStrategy).toBe('execute-selected-tests');
      expect(externalModuleReceipt.inputProvenance.validatorRuntime).toMatchObject({
        nodePath: expect.stringMatching(/^[A-F0-9]{64}$/),
        cacheReuseSafe: false, cacheBypassReason: 'unsealed-inherited-module-path'
      });
      expect(externalModuleReceipt.stages.validationCache).toMatchObject({
        status: 'inherited-runtime-cache-bypassed',
        reason: 'unsealed-inherited-module-path'
      });
      expect(externalModuleResolution.stdout).not.toContain(nodePathValue);
      writeFileSync(validatorRunFile, 'typescript\nfocused-vitest\n');
      const restoredDefaultRuntime = invoke('--local-update=renderer', '--json');
      expect(restoredDefaultRuntime.code).toBe(0);
      expect(restoredDefaultRuntime.receipt.validationStrategy)
        .toBe('reuse-exact-source-test-receipt');
      expect(validatorRuns()).toEqual(['typescript', 'focused-vitest']);
      expect(cachedValidation.receipt.stages.validationCache.lookupDurationMs).toBeGreaterThanOrEqual(0);
      expect(cachedValidation.receipt.stages.validationCache.writeDurationMs).toBeGreaterThanOrEqual(0);
      expect(cachedValidation.receipt.stages.validationCache.durationMs).toBe(
        cachedValidation.receipt.stages.validationCache.lookupDurationMs +
        cachedValidation.receipt.stages.validationCache.writeDurationMs);
      expect(cachedValidation.receipt.inputProvenance.digest).toBe(validated.receipt.inputProvenance.digest);
      expect(Number.isSafeInteger(cachedValidation.receipt.durationMs)).toBe(true);
      expect(cachedValidation.receipt.durationMs).toBeGreaterThanOrEqual(0);
      expect(cachedValidation.receipt.executionTiming.commandDurationMs).toBe(cachedValidation.receipt.durationMs);
      expect(cachedValidation.receipt.stages.changedCodeValidation.originalDurationMs)
        .toBe(validated.receipt.stages.changedCodeValidation.durationMs);
      for (const [index, check] of cachedValidation.receipt.stages.changedCodeValidation.checks.entries()) {
        expect(check.originalDurationMs)
          .toBe(validated.receipt.stages.changedCodeValidation.checks[index].durationMs);
      }
      // An independently prepared *newer* exact-source generation with no
      // successful test receipt must keep newest-first selection. The older
      // passed validation may be reused for the identical source/test epoch,
      // but its old selector cannot stand in for verifying the newer output.
      const newerUnvalidated = invoke('--local-update=renderer', '--review-only',
        '--rebuild', '--json');
      expect(newerUnvalidated.code).toBe(0);
      expect(newerUnvalidated.receipt.generation).not.toBe(first.receipt.generation);
      expect(newerUnvalidated.receipt.sourceSha256).toBe(first.receipt.sourceSha256);
      const selectedNewer = invoke('--local-update=renderer', '--json');
      expect(selectedNewer.code).toBe(0);
      expect(selectedNewer.receipt).toMatchObject({
        generation: newerUnvalidated.receipt.generation,
        validationStrategy: 'reuse-exact-source-test-receipt',
        stages: {
          changedCodeValidation: { cacheGeneration: first.receipt.generation,
            executedThisRun: false },
          validationCache: { status: 'reused', generation: newerUnvalidated.receipt.generation,
            exactVerifierAttempts: 1 },
          exactGenerationSelection: { status: 'passed', reusedValidatedSelector: false,
            verifiedAttempts: 1 },
          preparedOutputFence: { status: 'passed', exactOutputVerified: true }
        },
        changesInstalled: false
      });
      expect(existsSync(path.join(root, '.test_tmp', '.chat42-private-preview-owner'))).toBe(false);
      // Positively owned disposable fixture only; the prior-good candidate is
      // retained and the new fixture generation has no live preview lease.
      rmSync(path.join(root, '.test_tmp', newerUnvalidated.receipt.generation),
        { recursive: true });
      // Tampering with compiled output cannot be hidden by a cache receipt.
      // No validator or installed-state mutation is authorized by a failed
      // whole-tree selector.
      const cachedMain = path.join(exact, 'out', 'main', 'index.js');
      const cachedMainOriginal = readFileSync(cachedMain);
      writeFileSync(cachedMain, 'tampered private output');
      const refusedCachedBytes = invoke('--local-update=renderer', '--json');
      writeFileSync(cachedMain, cachedMainOriginal);
      expect(refusedCachedBytes.code).toBe(1);
      expect(refusedCachedBytes.receipt.stages.validationCache).toMatchObject({
        status: 'refused', durationMs: expect.any(Number)
      });
      expect(refusedCachedBytes.receipt).toMatchObject({
        reason: 'local-update-generation-selection-unverified',
        generation: null, changesInstalled: false,
        executionTiming: { postPrivateReadiness: { status: 'not-run', durationMs: null } },
        stages: { compiledStage: { status: 'not-run' },
          safeQuiescence: { status: 'not-run' }, nativeReattach: { status: 'not-run' } }
      });
      expect(validatorRuns()).toEqual(['typescript', 'focused-vitest']);
      // A well-formed but mismatched receipt is not reusable and must not survive a
      // successful fresh validator pass under this exact content-addressed key.
      const validationCacheFile = path.join(exact,
        `validation-${validated.receipt.inputProvenance.digest.toUpperCase()}.json`);
      const mismatchedValidation = JSON.parse(readFileSync(validationCacheFile, 'utf8'));
      mismatchedValidation.sourceSha256 = 'F'.repeat(64);
      writeFileSync(validationCacheFile, JSON.stringify(mismatchedValidation));
      const revalidated = invoke('--local-update=renderer', '--json');
      expect(revalidated.code).toBe(0);
      expect(revalidated.receipt.validationStrategy).toBe('execute-selected-tests');
      expect(validatorRuns()).toEqual(['typescript', 'focused-vitest', 'typescript', 'focused-vitest']);
      expect(revalidated.receipt.stages.validationCache).toMatchObject({
        status: 'written', matchingReceipts: 0, exactVerifierAttempts: 0
      });
      expect(JSON.parse(readFileSync(validationCacheFile, 'utf8')).sourceSha256)
        .toBe(revalidated.receipt.sourceSha256);
      const cachedSelectedTest = path.join(root, 'test', 'renderer-layout.test.ts');
      const cachedSelectedTestBefore = readFileSync(cachedSelectedTest, 'utf8');
      writeFileSync(cachedSelectedTest, cachedSelectedTestBefore + '\nchanged selected test input');
      const changedTestValidation = invoke('--local-update=renderer', '--json');
      expect(changedTestValidation.code).toBe(0);
      expect(changedTestValidation.receipt.validationStrategy).toBe('execute-selected-tests');
      expect(validatorRuns()).toEqual(['typescript', 'focused-vitest', 'typescript', 'focused-vitest',
        'typescript', 'focused-vitest']);
      expect(changedTestValidation.receipt.inputProvenance.digest)
        .not.toBe(validated.receipt.inputProvenance.digest);
      expect(changedTestValidation.receipt.inputProvenance.validatedTestPaths)
        .toEqual(['test/renderer-layout.test.ts', 'test/renderer-state.test.ts']);
      writeFileSync(cachedSelectedTest, cachedSelectedTestBefore);
      // Change Vitest's actual supporting inputs without changing the selected
      // test filenames. A previously passing validator receipt must not be
      // admitted under that stale test runner and fixture configuration.
      const originalFakeVitest = readFileSync(fakeVitest);
      writeFileSync(fakeVitest, [
        "import {appendFileSync, readFileSync} from 'node:fs';",
        "appendFileSync('.test_tmp/validator-executions.log','focused-vitest\\n');",
        "if (!readFileSync('vitest.config.ts','utf8').includes('suite-approved') ||",
        "  readFileSync('test/fixtures/validator-helper.mjs','utf8') !== 'support-ready' ||",
        "  readFileSync('scripts/validator-helper.mjs','utf8') !== 'script-ready')",
        "  process.exit(33);",
        "console.log('fixture renderer tests passed');"
      ].join('\n'));
      const sealedBaseline = invoke('--local-update=renderer', '--json');
      expect(sealedBaseline.code).toBe(0);
      expect(sealedBaseline.receipt.validationStrategy).toBe('execute-selected-tests');
      const sealedRepeat = invoke('--local-update=renderer', '--json');
      expect(sealedRepeat.code).toBe(0);
      expect(sealedRepeat.receipt.validationStrategy).toBe('reuse-exact-source-test-receipt');
      expect(sealedBaseline.receipt.inputProvenance.validatorImplementation).toMatchObject({
        schema: 'cos_dev_validator_implementation_v1',
        sha256: expect.stringMatching(/^[A-F0-9]{64}$/),
        fileCount: expect.any(Number), totalBytes: expect.any(Number)
      });
      // Real TypeScript 7 executes platform-native compiler bytes and Vitest
      // executes dist/cli.js/chunks rather than its small .mjs launcher. The
      // entrypoint hashes remain IDENTICAL in these cases: changing delegated
      // files must invalidate PASS, then restoring exact bytes may reuse it.
      const validatorLogBeforeDelegated = readFileSync(validatorRunFile, 'utf8');
      for (const [name, file] of [
        ['typescript-native-binary', fakeNativeTypeScript],
        ['vitest-delegated-cli', fakeVitestRuntime],
        ['vite-runner', fakeViteRuntime]
      ] as const) {
        const original = readFileSync(file);
        const before = validatorRuns().length;
        writeFileSync(file, Buffer.concat([original, Buffer.from(`\n// changed ${name}\n`)]));
        const changed = invoke('--local-update=renderer', '--json');
        expect(changed.code, name).toBe(0);
        expect(changed.receipt.validationStrategy, name).toBe('execute-selected-tests');
        expect(changed.receipt.inputProvenance.hashes.typescriptCli, name)
          .toBe(sealedBaseline.receipt.inputProvenance.hashes.typescriptCli);
        expect(changed.receipt.inputProvenance.hashes.vitestCli, name)
          .toBe(sealedBaseline.receipt.inputProvenance.hashes.vitestCli);
        expect(changed.receipt.inputProvenance.validatorImplementation.sha256, name)
          .not.toBe(sealedBaseline.receipt.inputProvenance.validatorImplementation.sha256);
        expect(changed.receipt.inputProvenance.digest, name)
          .not.toBe(sealedBaseline.receipt.inputProvenance.digest);
        expect(validatorRuns().length, name).toBe(before + 2);
        writeFileSync(file, original);
        const restored = invoke('--local-update=renderer', '--json');
        expect(restored.code, name).toBe(0);
        expect(restored.receipt.validationStrategy, name)
          .toBe('reuse-exact-source-test-receipt');
        expect(restored.receipt.inputProvenance.digest, name)
          .toBe(sealedBaseline.receipt.inputProvenance.digest);
        expect(validatorRuns().length, name).toBe(before + 2);
      }
      writeFileSync(validatorRunFile, validatorLogBeforeDelegated);
      // Validator entrypoint bytes are part of the same cache identity. A
      // changed Vitest executable must run both validators again; restoring
      // the exact original bytes permits the previous receipt to be reused.
      const sealedVitestBytes = readFileSync(fakeVitest);
      const runsBeforeValidatorChange = validatorRuns().length;
      writeFileSync(fakeVitest, Buffer.concat([sealedVitestBytes, Buffer.from('\n// validator revision\n')]));
      const changedValidator = invoke('--local-update=renderer', '--json');
      expect(changedValidator.code).toBe(0);
      expect(changedValidator.receipt.validationStrategy).toBe('execute-selected-tests');
      expect(changedValidator.receipt.inputProvenance.digest)
        .not.toBe(sealedBaseline.receipt.inputProvenance.digest);
      expect(changedValidator.receipt.inputProvenance.hashes.vitestCli)
        .not.toBe(sealedBaseline.receipt.inputProvenance.hashes.vitestCli);
      expect(validatorRuns().length).toBe(runsBeforeValidatorChange + 2);
      writeFileSync(fakeVitest, sealedVitestBytes);
      const restoredValidator = invoke('--local-update=renderer', '--json');
      expect(restoredValidator.code).toBe(0);
      expect(restoredValidator.receipt.validationStrategy)
        .toBe('reuse-exact-source-test-receipt');
      expect(restoredValidator.receipt.inputProvenance.digest)
        .toBe(sealedBaseline.receipt.inputProvenance.digest);
      expect(validatorRuns().length).toBe(runsBeforeValidatorChange + 2);
      // The application source epoch is separate from validator inputs. A
      // source edit between invocations must reject the old PASS, and exact
      // source restoration may reuse the original source-bound receipt.
      const rendererSource = path.join(root, 'src', 'renderer', 'index.html');
      const rendererSourceBefore = readFileSync(rendererSource, 'utf8');
      const runsBeforeSourceChange = validatorRuns().length;
      writeFileSync(rendererSource, rendererSourceBefore + '\nsource-revision-two');
      const changedSourceEpoch = invoke('--local-update=renderer', '--json');
      expect(changedSourceEpoch.code).toBe(0);
      expect(changedSourceEpoch.receipt.validationStrategy).toBe('execute-selected-tests');
      const changedSourceGeneration = changedSourceEpoch.receipt.generation as string;
      expect(changedSourceGeneration).toMatch(/^chat42-private-out-/);
      expect(changedSourceGeneration).not.toBe(sealedBaseline.receipt.generation);
      expect(changedSourceEpoch.receipt.sourceSha256)
        .not.toBe(sealedBaseline.receipt.sourceSha256);
      expect(validatorRuns().length).toBe(runsBeforeSourceChange + 2);
      writeFileSync(rendererSource, rendererSourceBefore);
      const restoredSourceEpoch = invoke('--local-update=renderer', '--json');
      expect(restoredSourceEpoch.code).toBe(0);
      expect(restoredSourceEpoch.receipt.validationStrategy)
        .toBe('reuse-exact-source-test-receipt');
      expect(restoredSourceEpoch.receipt.sourceSha256)
        .toBe(sealedBaseline.receipt.sourceSha256);
      expect(restoredSourceEpoch.receipt.generation).toBe(sealedBaseline.receipt.generation);
      expect(validatorRuns().length).toBe(runsBeforeSourceChange + 2);
      // The extra generation is only this disposable invalidation fixture.
      // Once exact source restoration proves the original receipt is reusable,
      // remove that owned generation so later catalog-order tests retain their
      // original two-generation fixture contract.
      const privateOutputRoot = path.resolve(root, '.test_tmp');
      const changedSourceGenerationPath = path.resolve(privateOutputRoot, changedSourceGeneration);
      expect(changedSourceGenerationPath.startsWith(privateOutputRoot + path.sep)).toBe(true);
      expect(existsSync(path.join(privateOutputRoot, '.chat42-private-preview-owner'))).toBe(false);
      expect(existsSync(changedSourceGenerationPath)).toBe(true);
      rmSync(changedSourceGenerationPath, { recursive: true, force: true });
      for (const [relative, modified] of [
        ['vitest.config.ts', 'suite-replaced'],
        ['test/fixtures/validator-helper.mjs', 'support-replaced'],
        ['scripts/validator-helper.mjs', 'script-replaced']
      ] as const) {
        const file = path.join(root, ...relative.split('/'));
        const previousBytes = readFileSync(file);
        const runsBefore = validatorRuns().length;
        writeFileSync(file, modified);
        const refused = invoke('--local-update=renderer', '--json');
        expect(refused.code, relative + ': ' + JSON.stringify(refused.receipt)).toBe(1);
        expect(refused.receipt).toMatchObject({
          reason: 'local-update-changed-code-validation-refused',
          generation: null, changesInstalled: false,
          stages: { changedCodeValidation: { status: 'refused', executedThisRun: true,
            checks: [{ name: 'typescript', status: 'passed', exitCode: 0 },
              { name: 'focused-vitest', status: 'refused', exitCode: 33 }] },
            compiledStage: { status: 'not-run' },
            rendererHealth: { status: 'not-run' } }
        });
        expect(refused.receipt.inputProvenance.digest)
          .not.toBe(sealedBaseline.receipt.inputProvenance.digest);
        expect(validatorRuns().length).toBe(runsBefore + 2);
        writeFileSync(file, previousBytes);
        const recovered = invoke('--local-update=renderer', '--json');
        expect(recovered.code).toBe(0);
        expect(recovered.receipt).toMatchObject({
          validationStrategy: 'reuse-exact-source-test-receipt',
          inputProvenance: { digest: sealedBaseline.receipt.inputProvenance.digest },
          stages: { changedCodeValidation: { executedThisRun: false },
            preparedOutputFence: { status: 'passed', exactOutputVerified: true } }
        });
      }
      expect(sealedBaseline.receipt.inputProvenance.validatorSupport).toMatchObject({
        schema: 'cos_dev_validator_support_v1',
        sha256: expect.stringMatching(/^[A-F0-9]{64}$/),
        fileCount: expect.any(Number),
        totalBytes: expect.any(Number)
      });
      const unrelatedSuite = path.join(root, 'test', 'unselected-other.test.ts');
      writeFileSync(unrelatedSuite, 'another suite that is not selected');
      const scopedRepeat = invoke('--local-update=renderer', '--json');
      expect(scopedRepeat.code).toBe(0);
      expect(scopedRepeat.receipt).toMatchObject({
        validationStrategy: 'reuse-exact-source-test-receipt',
        inputProvenance: { digest: sealedBaseline.receipt.inputProvenance.digest },
        stages: { changedCodeValidation: { executedThisRun: false } }
      });
      unlinkSync(unrelatedSuite);
      // A missing once-pinned runner config is UNKNOWN, not a passing cache
      // and not evidence to publish or overwrite a private generation.
      const configPath = path.join(root, 'vitest.config.ts');
      const originalConfig = readFileSync(configPath);
      const generationsBeforeMissingConfig = readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort();
      const runsBeforeMissing = validatorRuns().length;
      unlinkSync(configPath);
      const missingConfig = invoke('--local-update=renderer', '--json');
      expect(missingConfig.code).toBe(1);
      expect(missingConfig.receipt).toMatchObject({
        reason: 'local-update-validator-support-unverified',
        generation: null, changesInstalled: false,
        stages: { compiledStage: { status: 'not-run' },
          rendererHealth: { status: 'not-run' } }
      });
      expect(validatorRuns().length).toBe(runsBeforeMissing);
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort())
        .toEqual(generationsBeforeMissingConfig);
      writeFileSync(configPath, originalConfig);
      const restoredConfig = invoke('--local-update=renderer', '--json');
      expect(restoredConfig.code).toBe(0);
      expect(restoredConfig.receipt.validationStrategy).toBe('reuse-exact-source-test-receipt');
      const supportBeforeRacingValidator = readFileSync(
        path.join(root, 'test', 'fixtures', 'validator-helper.mjs'));
      writeFileSync(fakeVitest, [
        "import {writeFileSync} from 'node:fs';",
        "writeFileSync('test/fixtures/validator-helper.mjs','foreign-writer-during-validation');",
        "console.log('fixture validation passed before late input fence');"
      ].join('\n'));
      const racedSupport = invoke('--local-update=renderer', '--json');
      expect(racedSupport.code).toBe(1);
      expect(racedSupport.receipt).toMatchObject({
        reason: 'local-update-inputs-changed-during-validation',
        generation: null, changesInstalled: false,
        stages: { inputProvenance: { sourceAndToolInputsStable: false },
          changedCodeValidation: { status: 'refused',
            checks: [{ name: 'typescript', status: 'passed', exitCode: 0 },
              { name: 'focused-vitest', status: 'passed', exitCode: 0 }] },
          compiledStage: { status: 'not-run' },
          rendererHealth: { status: 'not-run' } }
      });
      writeFileSync(path.join(root, 'test', 'fixtures', 'validator-helper.mjs'),
        supportBeforeRacingValidator);
      writeFileSync(fakeVitest, originalFakeVitest);
      // Regression: passing validators must not bless an *untested* source
      // epoch introduced by another writer while focused Vitest is running.
      // A previous valid private stage and historical out/ remain intact.
      const originalMainSource = path.join(root, 'src', 'main', 'index.ts');
      const originalMainText = readFileSync(originalMainSource, 'utf8');
      const generationsBeforeSourceRace = readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort();
      writeFileSync(fakeVitest, `import {writeFileSync} from 'node:fs';writeFileSync('src/main/index.ts','new-source-after-tests');console.log('fixture tests passed');`);
      const untestedSource = invoke('--local-update=main', '--json');
      expect(untestedSource.code).toBe(1);
      expect(untestedSource.receipt.stages.changedCodeValidation,
        JSON.stringify(untestedSource.receipt.stages.changedCodeValidation)).toMatchObject({
        status: 'refused',
        checks: [{ name: 'typescript', status: 'passed', exitCode: 0 },
          { name: 'focused-vitest', status: 'passed', exitCode: 0 }]
      });
      expect(untestedSource.receipt).toMatchObject({
        reason: 'local-update-source-changed-during-validation', generation: null,
        stages: { changedCodeValidation: { status: 'refused' },
          sourceQualification: { status: 'refused', snapshotsMatch: false },
          compiledStage: { status: 'not-run' }, copySwitch: { status: 'not-run' } }
      });
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort())
        .toEqual(generationsBeforeSourceRace);
      expect(readFileSync(path.join(root, 'out', 'main', 'index.js'), 'utf8'))
        .toBe('historical-generated-output-untouched');
      writeFileSync(originalMainSource, originalMainText);
      // Failed tests may be caused by another writer changing the source
      // while Vitest is running. Do not call that stable-source test failure;
      // retain the real nonzero validator exit as separate evidence.
      writeFileSync(fakeVitest, `import {writeFileSync} from 'node:fs';writeFileSync('src/main/index.ts','foreign-writer-before-test-failure');process.exit(3);`);
      const failedAndChanged = invoke('--local-update=main', '--json');
      expect(failedAndChanged.code).toBe(1);
      expect(failedAndChanged.receipt).toMatchObject({
        reason: 'local-update-source-changed-during-validation',
        changesInstalled: false, generation: null,
        stages: {
          changedCodeValidation: { status: 'refused', checks: [
            { name: 'typescript', status: 'passed', exitCode: 0 },
            { name: 'focused-vitest', status: 'refused', exitCode: 3 }
          ] },
          sourceQualification: { status: 'refused', snapshotsMatch: false },
          compiledStage: { status: 'not-run' }, rendererHealth: { status: 'not-run' }
        }
      });
      writeFileSync(originalMainSource, originalMainText);
      // A failed validator whose own test input changed is an input identity
      // refusal; the old test result cannot be reused for that test graph.
      const pinnedMainTest = path.join(root, 'test', 'dev-fast.test.ts');
      const pinnedMainTestBytes = readFileSync(pinnedMainTest);
      writeFileSync(fakeVitest, `import {writeFileSync} from 'node:fs';writeFileSync('test/dev-fast.test.ts','changed-selected-test-and-failed');process.exit(4);`);
      const failedAndRewrittenTest = invoke('--local-update=main', '--json');
      expect(failedAndRewrittenTest.code).toBe(1);
      expect(failedAndRewrittenTest.receipt).toMatchObject({
        reason: 'local-update-inputs-changed-during-validation',
        changesInstalled: false, generation: null,
        stages: { inputProvenance: { sourceAndToolInputsStable: false },
          changedCodeValidation: { status: 'refused', checks: [
            { name: 'typescript', status: 'passed', exitCode: 0 },
            { name: 'focused-vitest', status: 'refused', exitCode: 4 }
          ] }, compiledStage: { status: 'not-run' } }
      });
      writeFileSync(pinnedMainTest, pinnedMainTestBytes);
      // A post-validation snapshot whose compiler disappeared is UNKNOWN,
      // not positive evidence that the source tree's bytes changed.
      const compilerBytesBefore = readFileSync(compiler);
      writeFileSync(fakeVitest, `import {unlinkSync} from 'node:fs';unlinkSync('node_modules/electron-vite/bin/electron-vite.js');console.log('fixture validation passed');`);
      const unavailableSnapshot = invoke('--local-update=main', '--json');
      expect(unavailableSnapshot.code).toBe(1);
      expect(unavailableSnapshot.receipt).toMatchObject({
        reason: 'local-update-source-snapshot-unverified',
        generation: null, changesInstalled: false,
        stages: { sourceQualification: { status: 'refused', snapshotsMatch: null,
            snapshotObserved: false },
          changedCodeValidation: { status: 'refused', checks: [
            { name: 'typescript', status: 'passed', exitCode: 0 },
            { name: 'focused-vitest', status: 'passed', exitCode: 0 }
          ] }, compiledStage: { status: 'not-run' } }
      });
      writeFileSync(compiler, compilerBytesBefore);
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort())
        .toEqual(generationsBeforeSourceRace);
      writeFileSync(fakeVitest, 'console.log("fixture renderer tests passed");');
      const originalLock = readFileSync(path.join(root, 'package-lock.json'), 'utf8');
      const originalNamesBeforeDrift = readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort();
      // A successful validator result does not authorize an artifact when its
      // dependency lock changes during that exact validation window.
      writeFileSync(fakeTsc, "require('node:fs').writeFileSync('package-lock.json','changed while typechecking');console.log('fixture validator passed');");
      const inputDrift = invoke('--local-update=renderer', '--json');
      expect(inputDrift.code).toBe(1);
      expect(inputDrift.receipt).toMatchObject({
        reason: 'local-update-inputs-changed-during-validation', generation: null,
        stages: { inputProvenance: { sourceAndToolInputsStable: false },
          compiledStage: { status: 'not-run' }, rendererHealth: { status: 'not-run' } }
      });
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort()).toEqual(originalNamesBeforeDrift);
      writeFileSync(path.join(root, 'package-lock.json'), originalLock);
      writeFileSync(fakeTsc, 'console.log("fixture types verified");');
      // A newly edited test cannot retroactively qualify the same validator
      // child exit. Pinned test and launcher files are risk-appropriate inputs,
      // but they must not change the compiler/source digest or private stage.
      const selectedTestFile = path.join(root, 'test', 'dev-fast.test.ts');
      const selectedTestBefore = readFileSync(selectedTestFile, 'utf8');
      writeFileSync(fakeVitest, `import {writeFileSync} from 'node:fs';writeFileSync('test/dev-fast.test.ts','new-test-epoch');console.log('fixture tests passed');`);
      const testsChanged = invoke('--local-update=main', '--json');
      expect(testsChanged.code).toBe(1);
      expect(testsChanged.receipt).toMatchObject({
        reason: 'local-update-inputs-changed-during-validation',
        generation: null, stages: { compiledStage: { status: 'not-run' },
          inputProvenance: { sourceAndToolInputsStable: false } }
      });
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort())
        .toEqual(generationsBeforeSourceRace);
      writeFileSync(selectedTestFile, selectedTestBefore);
      writeFileSync(fakeVitest, 'console.log("fixture renderer tests passed");');
      const previewFile = path.join(root, 'scripts', 'dev-fast-preview.mjs');
      const originalPreviewScript = readFileSync(previewFile, 'utf8');
      writeFileSync(fakeVitest, `import {writeFileSync} from 'node:fs';writeFileSync('scripts/dev-fast-preview.mjs','replaced-preview-entry');console.log('fixture tests passed');`);
      const toolChanged = invoke('--local-update=renderer', '--json');
      expect(toolChanged.code).toBe(1);
      expect(toolChanged.receipt).toMatchObject({
        reason: 'local-update-inputs-changed-during-validation',
        generation: null, stages: { rendererHealth: { status: 'not-run' },
          inputProvenance: { sourceAndToolInputsStable: false } }
      });
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort())
        .toEqual(generationsBeforeSourceRace);
      writeFileSync(previewFile, originalPreviewScript);
      writeFileSync(fakeVitest, 'console.log("fixture renderer tests passed");');
      // The SAME validated local-update command owns a foreground renderer
      // session. Its previous in-memory bytes remain a reversible known-good
      // target even when the source advances to a different compiled revision.
      const sessionLines: any[] = [];
      let incomplete = '';
      const notices = new EventEmitter();
      const startOwnedInteractive = () => {
        sessionLines.length = 0;
        incomplete = '';
        interactiveUpdate = spawn(process.execPath,
          [local, '--local-update=renderer', '--interactive-preview', '--json'],
          { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
        previewChild = observeLocalUpdateFixtureChild(interactiveUpdate);
        interactiveUpdate.stdout!.on('data', chunk => {
          incomplete += String(chunk);
          while (incomplete.includes('\n')) {
            const end = incomplete.indexOf('\n');
            const line = incomplete.slice(0, end).trim();
            incomplete = incomplete.slice(end + 1);
            if (line) { sessionLines.push(JSON.parse(line)); notices.emit('line'); }
          }
        });
      };
      startOwnedInteractive();
      const nextInteractive = (event: string): Promise<any> => new Promise((resolve, reject) => {
        const look = () => {
          const index = sessionLines.findIndex(row => row.event === event ||
            (event === 'final' && row.schema === 'cos_personal_local_update_v1'));
          if (index === -1) return;
          clearTimeout(deadline);
          notices.off('line', look);
          resolve(sessionLines.splice(index, 1)[0]);
        };
        const deadline = setTimeout(() => {
          notices.off('line', look);
          reject(new Error('Missing owned interactive '+event+' receipt: '+JSON.stringify(sessionLines)));
        }, 18000);
        notices.on('line', look);
        look();
      });
      const sendInteractive = (command: object) =>
        interactiveUpdate!.stdin!.write(JSON.stringify(command)+'\n');
      const admission = await nextInteractive('awaiting-stdin-control');
      expect(admission).toMatchObject({ admissionDeadlineMs: 10000,
        command: '{"command":"start"}' });
      // Deliberate foreground operator dwell must not count as engineering
      // preparation or any production-app admission pause/Drain downtime.
      await new Promise(resolve => setTimeout(resolve, 160));
      sendInteractive({ command: 'start' });
      const readyInteractive = await nextInteractive('ready');
      expect(readyInteractive).toMatchObject({
        generation: first.receipt.generation, healthConfirmed: true,
        httpVerifiedAssetCount: 2,
        servedRendererSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
        nativeRuntimeVerified: false, targetKind: 'isolated-loopback-renderer-only'
      });
      const endpoint = readyInteractive.endpoint as string;
      expect(await (await fetch(endpoint)).text()).toBe('renderer');
      const changedMarkup = '<html><body>updated development generation</body></html>';
      writeFileSync(path.join(root, 'src', 'renderer', 'index.html'), changedMarkup);
      const secondBuild = invoke('--local-update=main', '--review-only', '--json');
      expect(secondBuild.code, JSON.stringify(secondBuild.receipt)).toBe(0);
      expect(secondBuild.receipt.generation).not.toBe(first.receipt.generation);
      expect(secondBuild.receipt).toMatchObject({
        status: 'main-private-stage-verified-only',
        stages: { privatePublication: { status: 'passed' } }
      });
      // A newly published generation must be selected ahead of an older,
      // stale-but-intact immutable generation without trusting its timestamp
      // for integrity. It still executes the exact child selector once.
      const latest = invoke('--local-update=main', '--review-only', '--json');
      expect(latest.code).toBe(0);
      expect(latest.receipt).toMatchObject({
        generation: secondBuild.receipt.generation,
        buildStrategy: 'reuse-exact-source-private-generation',
        stages: { exactGenerationSelection: { status: 'passed',
          catalogCount: 2, verifiedAttempts: 1, staleRejected: 0,
          candidateOrder: 'newest-receipt-first-exact-selector-authoritative' } }
      });
      const recentReceipt = path.join(root, '.test_tmp', secondBuild.receipt.generation, 'evidence.json');
      const recentOriginal = readFileSync(recentReceipt, 'utf8');
      writeFileSync(recentReceipt, recentOriginal.replace(
        /"generatedAt":"[^"]+"/, '"generatedAt":"invalid-future-date"'));
      const invalidTimestamp = invoke('--local-update=main', '--review-only', '--json');
      expect(invalidTimestamp.code).toBe(1);
      expect(invalidTimestamp.receipt).toMatchObject({
        reason: 'local-update-generation-evidence-unverified',
        generation: null, changesInstalled: false,
        stages: { safeQuiescence: { status: 'not-run' }, copySwitch: { status: 'not-run' } }
      });
      writeFileSync(recentReceipt, recentOriginal);
      sendInteractive({ command: 'use',
        generation: secondBuild.receipt.generation,
        source: secondBuild.receipt.sourceSha256,
        compiled: secondBuild.receipt.compiledOutputSha256,
        compiler: secondBuild.receipt.compilerSha256 });
      const applied = await nextInteractive('activated');
      expect(applied).toMatchObject({
        generation: secondBuild.receipt.generation,
        previousGeneration: first.receipt.generation, healthConfirmed: true,
        httpVerifiedAssetCount: 2
      });
      expect(await (await fetch(endpoint)).text()).toBe(changedMarkup);
      sendInteractive({ command: 'restore' });
      const restored = await nextInteractive('restored');
      expect(restored).toMatchObject({
        generation: first.receipt.generation, healthConfirmed: true,
        restorationEvidence: 'same-process-previous-health-verified-memory',
        currentSourceMatchNotAsserted: true
      });
      expect(restored.servedRendererSha256).toBe(readyInteractive.servedRendererSha256);
      expect(await (await fetch(endpoint)).text()).toBe('renderer');
      // Holding the verified private preview open is review time, not HTTP
      // health work or native Drain/cutover downtime.
      await new Promise(resolve => setTimeout(resolve, 180));
      // A failed later update is retained in the same CLI's final receipt;
      // it must not rewrite or misreport the already restored good bytes.
      sendInteractive({ command: 'use',
        generation: secondBuild.receipt.generation,
        source: secondBuild.receipt.sourceSha256,
        compiled: '0'.repeat(64), compiler: secondBuild.receipt.compilerSha256 });
      expect(await nextInteractive('refused')).toMatchObject({
        reason: 'private-preview-generation-stale-or-unverified',
        activeGeneration: first.receipt.generation,
        activeServedRendererSha256: readyInteractive.servedRendererSha256
      });
      expect(await (await fetch(endpoint)).text()).toBe('renderer');
      const interactiveExit = new Promise<number | null>(resolve =>
        interactiveUpdate!.once('close', resolve));
      sendInteractive({ command: 'stop' });
      const interactiveFinal = await nextInteractive('final');
      expect(interactiveFinal).toMatchObject({
        status: 'refused', reason: 'local-update-prepared-source-no-longer-current',
        reviewOnly: false, changesInstalled: false, nativeRuntimeVerified: false,
        stages: { changedCodeValidation: { status: 'passed' },
          rendererHealth: { status: 'passed' },
          sourceReadinessFence: { status: 'refused',
            snapshotsMatch: false, sourceEpochObserved: true },
          preparedOutputFence: { status: 'not-run' } },
        rendererConsumption: {
          startingGeneration: first.receipt.generation,
          lastConfirmedGeneration: first.receipt.generation,
          lastConfirmedServedRendererSha256: readyInteractive.servedRendererSha256,
          lastHttpVerifiedAssetCount: 2,
          rollbackEvidence: 'same-process-previous-health-verified-memory',
          updatedGenerations: 1, restorations: 1, refusedTransitions: 1,
          lastRefusal: { reason: 'private-preview-generation-stale-or-unverified',
            activeGeneration: first.receipt.generation,
            previousGenerationPreserved: true },
          leaseReleased: true
        }
      });
      expect(interactiveFinal).not.toHaveProperty('activationDecision');
      expect(interactiveFinal.executionTiming.failedStage).toBe('sourceReadinessFence');
      expect(interactiveFinal.stages.foregroundControl).toMatchObject({ status: 'passed' });
      expect(interactiveFinal.stages.foregroundControl.durationMs).toBeGreaterThanOrEqual(120);
      expect(interactiveFinal.stages).toMatchObject({
        rendererHealth: { status: 'passed', durationMs: readyInteractive.durationMs },
        privateSwitch: { status: 'passed', durationMs: applied.durationMs, count: 1 },
        privateRestoration: { status: 'passed', durationMs: restored.durationMs, count: 1 }
      });
      expect(interactiveFinal.executionTiming.privateReview).toMatchObject({
        status: 'passed', initialAssetVerificationMs: readyInteractive.durationMs,
        interactiveWindowMs: expect.any(Number)
      });
      expect(interactiveFinal.executionTiming.privateReview.interactiveWindowMs)
        .toBeGreaterThanOrEqual(180);
      expect(interactiveFinal.executionTiming.privateReview.durationMs).toBeGreaterThan(
        interactiveFinal.stages.rendererHealth.durationMs);
      expect(interactiveFinal.executionTiming.liveLifecycle).toMatchObject({
        productionDowntimeMs: null,
        phases: { admissionPause: { status: 'not-invoked', durationMs: null },
          drain: { status: 'not-invoked', durationMs: null },
          checkpoint: { status: 'not-invoked', durationMs: null },
          cutover: { status: 'not-invoked', durationMs: null },
          reopen: { status: 'not-invoked', durationMs: null },
          reattach: { status: 'not-invoked', durationMs: null },
          usefulContinuation: { status: 'not-invoked', durationMs: null },
          rollbackRestoration: { status: 'not-invoked', durationMs: null } }
      });
      expect(interactiveFinal.executionTiming.foregroundControl).toEqual(
        interactiveFinal.stages.foregroundControl);
      expect(interactiveFinal.executionTiming.localPreparation.durationMs +
        interactiveFinal.executionTiming.foregroundControl.durationMs +
        interactiveFinal.executionTiming.privateReview.durationMs).toBeLessThanOrEqual(
        interactiveFinal.executionTiming.commandDurationMs);
      expect(interactiveFinal.executionTiming.liveLifecycle).toMatchObject({
        status: 'not-invoked', admissionPauseRequested: false, drainRequested: false
      });
      expect(await interactiveExit).toBe(1);
      interactiveUpdate = null;
      expect(existsSync(path.join(root, '.test_tmp', '.chat42-private-preview-owner'))).toBe(false);
      expect(readFileSync(path.join(root, 'out', 'main', 'index.js'), 'utf8'))
        .toBe('historical-generated-output-untouched');
      writeFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'renderer');
      // A selected test can change during foreground review without changing
      // the built source epoch. The old validator result must then be refused
      // separately, and the private preview must release its exact lease.
      startOwnedInteractive();
      expect(await nextInteractive('awaiting-stdin-control')).toMatchObject({
        admissionDeadlineMs: 10000
      });
      sendInteractive({ command: 'start' });
      const changedInputReady = await nextInteractive('ready');
      expect(changedInputReady.generation).toBe(first.receipt.generation);
      const foregroundTestFile = path.join(root, 'test', 'renderer-layout.test.ts');
      const foregroundTestOriginal = readFileSync(foregroundTestFile, 'utf8');
      writeFileSync(foregroundTestFile, foregroundTestOriginal + '\nreview-changed-test');
      const inputRefusalExit = new Promise<number | null>(resolve =>
        interactiveUpdate!.once('close', resolve));
      sendInteractive({ command: 'stop' });
      const inputRefusal = await nextInteractive('final');
      expect(inputRefusal).toMatchObject({
        status: 'refused', reason: 'local-update-prepared-inputs-no-longer-current',
        changesInstalled: false,
        stages: { rendererHealth: { status: 'passed' },
          sourceReadinessFence: { status: 'refused', sourceEpochObserved: true,
            snapshotsMatch: true, inputsStable: false },
          preparedOutputFence: { status: 'not-run' } }
      });
      expect(inputRefusal).not.toHaveProperty('activationDecision');
      expect(await inputRefusalExit).toBe(1);
      interactiveUpdate = null;
      writeFileSync(foregroundTestFile, foregroundTestOriginal);
      expect(existsSync(path.join(root, '.test_tmp', '.chat42-private-preview-owner'))).toBe(false);
      // The exact original inputs and source have been restored; a fresh
      // independently admitted private HTTP preview now passes readiness.
      startOwnedInteractive();
      expect(await nextInteractive('awaiting-stdin-control')).toMatchObject({
        admissionDeadlineMs: 10000
      });
      sendInteractive({ command: 'start' });
      const stableReady = await nextInteractive('ready');
      expect(stableReady.generation).toBe(first.receipt.generation);
      const stableExit = new Promise<number | null>(resolve =>
        interactiveUpdate!.once('close', resolve));
      sendInteractive({ command: 'stop' });
      const stableFinal = await nextInteractive('final');
      expect(stableFinal).toMatchObject({
        status: 'renderer-foreground-preview-session-verified', reason: null,
        changesInstalled: false, nativeRuntimeVerified: false,
        stages: { sourceReadinessFence: { status: 'passed',
            sourceEpochObserved: true, snapshotsMatch: true, inputsStable: true },
          preparedOutputFence: { status: 'passed', exactOutputVerified: true,
            nativeLoadedBytesVerified: false },
          rendererHealth: { status: 'passed' } },
        activationDecision: { decision: 'native-activation-deferred',
          privateRendererHttp: {
            sourceGeneration: first.receipt.generation,
            nativeRuntimeVerified: false } }
      });
      expect(await stableExit).toBe(0);
      interactiveUpdate = null;
      expect(existsSync(path.join(root, '.test_tmp', '.chat42-private-preview-owner'))).toBe(false);
      // A live preview intentionally serves verified bytes from memory. An
      // external writer can corrupt the backing private output AFTER HTTP
      // health, so final readiness must independently reselect the entire
      // generation before handing any disk artifact to the root owner.
      startOwnedInteractive();
      await nextInteractive('awaiting-stdin-control');
      sendInteractive({ command: 'start' });
      const outputReady = await nextInteractive('ready');
      expect(outputReady.generation).toBe(first.receipt.generation);
      const privateBacking = path.join(exact, 'out', 'main', 'index.js');
      const backingBefore = readFileSync(privateBacking);
      writeFileSync(privateBacking, 'tampered-after-http-preview-ready');
      expect(await (await fetch(outputReady.endpoint)).text()).toBe('renderer');
      const tamperExit = new Promise<number | null>(resolve =>
        interactiveUpdate!.once('close', resolve));
      sendInteractive({ command: 'stop' });
      const tamperFinal = await nextInteractive('final');
      expect(tamperFinal).toMatchObject({
        status: 'refused', reason: 'local-update-prepared-generation-no-longer-verified',
        changesInstalled: false, nativeRuntimeVerified: false,
        executionTiming: {
          postPrivateReadiness: { status: 'refused', durationMs: expect.any(Number),
            productionDowntimeMs: null, nativeAdmissionObserved: false },
          liveLifecycle: { productionDowntimeMs: null, status: 'not-invoked' }
        },
        stages: {
          sourceReadinessFence: { status: 'passed', snapshotsMatch: true, inputsStable: true },
          preparedOutputFence: { status: 'refused', exactOutputVerified: false },
          rendererHealth: { status: 'passed' }
        },
        rendererConsumption: { leaseReleased: true,
          lastConfirmedGeneration: first.receipt.generation }
      });
      expect(tamperFinal).not.toHaveProperty('activationDecision');
      expect(await tamperExit).toBe(1);
      interactiveUpdate = null;
      writeFileSync(privateBacking, backingBefore);
      expect(existsSync(path.join(root, '.test_tmp', '.chat42-private-preview-owner'))).toBe(false);
      // A compiler that disappears AFTER healthy HTTP loading prevents a
      // verifiable post-review source snapshot. Unknown is not observed drift;
      // the prior private generation and exact preview lease stay intact.
      startOwnedInteractive();
      await nextInteractive('awaiting-stdin-control');
      sendInteractive({ command: 'start' });
      expect((await nextInteractive('ready')).healthConfirmed).toBe(true);
      const lateCompilerBytes = readFileSync(compiler);
      unlinkSync(compiler);
      const lateSnapshotExit = new Promise<number | null>(resolve =>
        interactiveUpdate!.once('close', resolve));
      sendInteractive({ command: 'stop' });
      const lateSnapshot = await nextInteractive('final');
      expect(lateSnapshot).toMatchObject({
        status: 'refused',
        reason: 'local-update-prepared-source-snapshot-unverified',
        nativeRuntimeVerified: false, changesInstalled: false,
        stages: { sourceReadinessFence: { status: 'refused',
            sourceEpochObserved: false, snapshotsMatch: null },
          preparedOutputFence: { status: 'not-run' },
          rendererHealth: { status: 'passed' } },
        rendererConsumption: { leaseReleased: true }
      });
      expect(lateSnapshot).not.toHaveProperty('activationDecision');
      expect(await lateSnapshotExit).toBe(1);
      interactiveUpdate = null;
      writeFileSync(compiler, lateCompilerBytes);
      expect(existsSync(path.join(root, '.test_tmp', '.chat42-private-preview-owner'))).toBe(false);
      const fallback = invoke('--local-update=main', '--review-only', '--json');
      expect(fallback.code).toBe(0);
      expect(fallback.receipt).toMatchObject({
        generation: first.receipt.generation, buildStrategy: 'reuse-exact-source-private-generation',
        stages: { exactGenerationSelection: { status: 'passed', catalogCount: 2,
          verifiedAttempts: 2, staleRejected: 1 } }
      });
      // The same two generations are needed for a validated continuation,
      // but the positively stale newer revision cannot match its source epoch.
      // It is skipped before child launch; the older current generation is
      // still reselected byte-for-byte and its renderer HTTP assets verified.
      const fewerSelectors = invoke('--local-update=renderer', '--json');
      expect(fewerSelectors.code).toBe(0);
      expect(fewerSelectors.receipt).toMatchObject({
        status: 'renderer-private-review-verified',
        generation: first.receipt.generation, changesInstalled: false,
        stages: {
          sourceReadinessFence: { status: 'passed', sourceEpochObserved: true,
            snapshotsMatch: true, inputsStable: true },
          preparedOutputFence: { status: 'passed', exactOutputVerified: true },
          validationCache: { status: 'reused', catalogCount: 2,
            metadataSkipped: 1, matchingReceipts: 1, exactVerifierAttempts: 1 },
          changedCodeValidation: { status: 'passed', executedThisRun: false },
          exactGenerationSelection: { status: 'passed', catalogCount: 2,
            metadataSkipped: 1, verifiedAttempts: 0, staleRejected: 0,
            reusedValidatedSelector: true, priorCacheSelectorAttempts: 1 },
          rendererHealth: { status: 'passed' },
          compiledStage: { status: 'not-run' }
        }
      });
      expect(fallback.receipt.stages.exactGenerationSelection.verifiedAttempts -
        fewerSelectors.receipt.stages.exactGenerationSelection.verifiedAttempts).toBe(2);
      writeFileSync(fakeTsc, 'console.log("error TS6133: fixture only");process.exit(2);');
      const refusedValidation = invoke('--local-update=renderer', '--json');
      expect(refusedValidation.code).toBe(1);
      expect(refusedValidation.receipt).toMatchObject({
        reason: 'local-update-changed-code-validation-refused', generation: null,
        stages: { changedCodeValidation: { status: 'refused',
          checks: [{ name: 'typescript', status: 'refused', exitCode: 2,
            diagnosticCodes: ['TS6133'] }] },
          sourceQualification: { status: 'passed', snapshotsMatch: true } }
      });
      writeFileSync(fakeTsc, 'console.log("fixture types verified");');
      writeFileSync(path.join(root, 'src', 'renderer', 'index.html'), '<html><body>changed</body></html>');
      const drift = invoke(...review);
      expect(drift.code).toBe(0);
      expect(drift.receipt.generation).not.toBe(first.receipt.generation);
      expect(drift.receipt.sourceSha256).not.toBe(first.receipt.sourceSha256);
      expect(drift.receipt).toMatchObject({
        buildStrategy: 'new-reproducible-private-generation', status: 'renderer-private-review-verified'
      });
      expect(existsSync(path.join(exact, 'evidence.json'))).toBe(true);
      const main = invoke('--local-update=main', '--review-only', '--json');
      expect(main.code).toBe(0);
      expect(main.receipt).toMatchObject({
        status: 'main-private-stage-verified-only',
        buildStrategy: 'reuse-exact-source-private-generation',
        nativeRuntimeVerified: false, changesInstalled: false,
        activationDecision: {
          mode: 'main', decision: 'native-activation-deferred',
          availablePrivateWorkflow: 'immutable-main-preload-stage',
          requiredOwner: 'root-codex-release-and-ProfileLifecycleCoordinator',
          eligibleForNativeActivation: false
        },
        stages: { sourceReadinessFence: { status: 'passed', sourceEpochObserved: true,
            snapshotsMatch: true, inputsStable: true },
          preparedOutputFence: { status: 'passed', exactOutputVerified: true },
          safeQuiescence: { status: 'not-run' }, copySwitch: { status: 'not-run' },
          mainActivationPreflight: { status: 'passed', mainPreloadFiles: 2 } },
        mainActivationHandoff: {
          schema: 'cos_dev_main_activation_handoff_v1',
          stageVerifiedOnly: true, runtimeLoadedBytesVerified: false,
          changesInstalled: false, eligibleForProductionActivation: false,
          stage: { validatorSupportSha256: null, selectedTestPaths: [] },
          mainOutput: { schema: 'cos_dev_main_output_manifest_v1',
            fileCount: 2, manifestSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
            files: [
              { relative: 'main/index.js', sha256: expect.stringMatching(/^[A-F0-9]{64}$/) },
              { relative: 'preload/index.js', sha256: expect.stringMatching(/^[A-F0-9]{64}$/) }
            ] },
          risk: { state: 'unverified', reason: 'installed-baseline-checkout-unverified' },
          requirements: { requestDrain: expect.stringContaining('drain-ready'),
            durableCheckpoint: expect.stringContaining('flushDurable'),
            priorGoodRollback: expect.stringContaining('restore'),
            macPlatform: expect.stringContaining('quarantine') }
        }
      });
      const firstMainOutput = path.join(root, '.test_tmp', main.receipt.generation, 'out', 'main', 'index.js');
      const originalMainBytes = readFileSync(firstMainOutput);
      writeFileSync(firstMainOutput, 'mutated staged Main bundle');
      const poisonedMain = invoke('--local-update=main', '--review-only', '--json');
      expect(poisonedMain.code).toBe(1);
      expect(poisonedMain.receipt).toMatchObject({
        status: 'refused', changesInstalled: false,
        stages: { safeQuiescence: { status: 'not-run' },
          nativeReattach: { status: 'not-run' } }
      });
      expect(poisonedMain.receipt).not.toHaveProperty('mainActivationHandoff');
      writeFileSync(firstMainOutput, originalMainBytes);
      const companion = invoke('--local-update=companion', '--review-only', '--json');
      expect(companion.code).toBe(0);
      expect(companion.receipt).toMatchObject({
        status: 'companion-source-inspected-only',
        companionLoadedBytesVerified: false, changesInstalled: false,
        stages: { sourceReadinessFence: { status: 'passed', sourceEpochObserved: true,
            snapshotsMatch: true, inputsStable: true },
          preparedOutputFence: { status: 'not-run',
            reason: 'companion-has-no-compiled-output-generation' } },
        activationDecision: {
          mode: 'companion', decision: 'native-activation-deferred',
          availablePrivateWorkflow: 'source-mv3-fingerprint-only',
          requiredOwner: 'chat24-authenticated-companion-owner',
          eligibleForNativeActivation: false
        },
        companionSource: { files: 2 }
      });
      expect(companion.receipt.companionSource.sha256).toMatch(/^[A-F0-9]{64}$/);
      // The incumbent packaged-extension materializer (extension-path.ts)
      // sorts directory names with localeCompare. Default JS sort places
      // uppercase Z before lowercase a and gives a different fingerprint
      // from the exact same unpacked extension bytes.
      writeFileSync(path.join(root, 'extension', 'Z-case.js'), 'uppercase extension module');
      writeFileSync(path.join(root, 'extension', 'a-case.js'), 'lowercase extension module');
      mkdirSync(path.join(root, 'extension', 'Nested'), { recursive: true });
      writeFileSync(path.join(root, 'extension', 'Nested', 'b.js'), 'nested lowercase');
      writeFileSync(path.join(root, 'extension', 'Nested', 'A.js'), 'nested uppercase');
      const filesByCanonicalOrder = ['Z-case.js', 'a-case.js', 'background.js', 'manifest.json', 'Nested']
        .sort((a, b) => a.localeCompare(b));
      expect(filesByCanonicalOrder).not.toEqual(
        [...filesByCanonicalOrder].sort());
      const materializationHash = createHash('sha256');
      for (const name of filesByCanonicalOrder) {
        if (name === 'Nested') {
          materializationHash.update('d\0Nested\0');
          for (const nested of ['A.js', 'b.js'].sort((a, b) => a.localeCompare(b))) {
            materializationHash.update(`f\0Nested/${nested}\0`);
            materializationHash.update(readFileSync(path.join(root, 'extension', name, nested)));
            materializationHash.update('\0');
          }
        } else {
          materializationHash.update(`f\0${name}\0`);
          materializationHash.update(readFileSync(path.join(root, 'extension', name)));
          materializationHash.update('\0');
        }
      }
      const caseSensitiveCompanion = invoke('--local-update=companion', '--review-only', '--json');
      expect(caseSensitiveCompanion.code).toBe(0);
      expect(caseSensitiveCompanion.receipt).toMatchObject({
        status: 'companion-source-inspected-only',
        companionSource: { files: 6, algorithm: 'extension-path-materialized-tree-sha256-v1' },
        companionReloadHandoff: {
          schema: 'cos_dev_companion_reload_handoff_v1',
          fingerprintOwner: 'src/main/extension-path.ts:extensionFingerprint',
          requiredRuntimeIdentity: 'exact-profile-pid-process-birth-account-epoch',
          diagnosticOwner: 'authenticated-profile-main-local-incidents',
          stageVerifiedOnly: true, loadedWorkerRevision: null,
          nativeReloadAttempted: false, loadedBytesVerified: false,
          productionActivationAllowed: false
        },
        companionLoadedBytesVerified: false, changesInstalled: false
      });
      const exactMaterializedHash = materializationHash.digest('hex');
      expect(caseSensitiveCompanion.receipt.companionSource.sha256)
        .toBe(exactMaterializedHash.toUpperCase());
      expect(caseSensitiveCompanion.receipt.companionReloadHandoff.expectedMaterializedSha256)
        .toBe(exactMaterializedHash);
      expect(caseSensitiveCompanion.receipt).not.toHaveProperty('incidentHandoff');
      const companionManifest = path.join(root, 'extension', 'manifest.json');
      const originalManifest = readFileSync(companionManifest, 'utf8');
      writeFileSync(companionManifest, '{"manifest_version":2}');
      const invalidCompanion = invoke('--local-update=companion', '--review-only', '--json');
      expect(invalidCompanion.code).toBe(1);
      expect(invalidCompanion.receipt).toMatchObject({
        reason: 'local-update-companion-manifest-unverified',
        changesInstalled: false, companionLoadedBytesVerified: false,
        incidentHandoff: {
          schema: 'cos_dev_local_update_incident_handoff_v1',
          target: 'src/main/logger.ts:noteLocalIncident',
          input: { source: 'app', reason: 'local_update.companion-manifest-unverified',
            fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
          stages: { nativeReattach: { status: 'not-run', durationMs: null } },
          profileBound: false, recordedInNativeIncidentFolder: false
        },
        stages: { nativeReattach: { status: 'not-run' } }
      });
      const repeatedInvalidCompanion = invoke('--local-update=companion', '--review-only', '--json');
      expect(repeatedInvalidCompanion.code).toBe(1);
      expect(repeatedInvalidCompanion.receipt.incidentHandoff.input.fingerprint)
        .toBe(invalidCompanion.receipt.incidentHandoff.input.fingerprint);
      expect(repeatedInvalidCompanion.receipt.incidentHandoff.stages.nativeReattach)
        .toEqual(invalidCompanion.receipt.incidentHandoff.stages.nativeReattach);
      expect(repeatedInvalidCompanion.receipt.incidentHandoff.stages.inputProvenance.status)
        .toBe('measured');
      writeFileSync(companionManifest, originalManifest);

      // The qualifier keeps both independently compiled stages when their
      // bytes differ. The local-update wrapper must preserve the useful
      // bounded failure code and safe next experiment without compiler text,
      // a private generation or a misleading successful Main handoff.
      const goodCompiler = readFileSync(compiler, 'utf8');
      writeFileSync(compiler, [
        "const fs=require('node:fs'),path=require('node:path');",
        "const dir=process.argv[process.argv.indexOf('--outDir')+1];",
        "const marker=path.join(process.cwd(),'fixture-generation-counter');",
        "const turn=fs.existsSync(marker)?Number(fs.readFileSync(marker,'utf8'))+1:1;",
        "fs.writeFileSync(marker,String(turn));",
        "for(const name of ['main/index.js','preload/index.js','renderer/index.html']){",
        "const out=path.join(dir,name);fs.mkdirSync(path.dirname(out),{recursive:true});",
        "fs.writeFileSync(out,name==='renderer/index.html'?'renderer revision '+turn:name);}"
      ].join('\n'));
      const nonReproducible = invoke('--local-update=main', '--review-only', '--rebuild', '--json');
      expect(nonReproducible.code).toBe(1);
      expect(nonReproducible.receipt).toMatchObject({
        status: 'refused', generation: null, changesInstalled: false,
        reason: 'local-update-private-build-unverified',
        nextAction: 'inspect-build-reproducibility-drift',
        privateBuildFailure: {
          schema: 'cos_dev_private_build_failure_v1',
          failureClassification: 'validation',
          failureCodes: expect.arrayContaining(['nondeterministic-compiled-output']),
          compilerExitCode: 0, confirmationExitCode: 0,
          reproducible: false, privatePublished: false,
          nextActions: expect.arrayContaining(['inspect-build-reproducibility-drift'])
        },
        stages: { nativeReattach: { status: 'not-run' },
          compiledStage: { status: 'refused', failureClassification: 'validation' } }
      });
      expect(nonReproducible.receipt).not.toHaveProperty('mainActivationHandoff');
      expect(JSON.stringify(nonReproducible.receipt)).not.toContain('renderer revision');
      writeFileSync(compiler, goodCompiler);

      // A changing source epoch must reach the SAME public --local-update
      // receipt with actionable bounded file hashes, not a misleading
      // nondeterministic compiler verdict or an activation handoff.
      const currentMain = path.join(root, 'src', 'main', 'index.ts');
      const originalMain = readFileSync(currentMain, 'utf8');
      writeFileSync(compiler, [
        "const fs=require('node:fs'),path=require('node:path');",
        "const cwd=process.cwd(),dir=process.argv[process.argv.indexOf('--outDir')+1];",
        "const marker=path.join(cwd,'.test_tmp','fixture-source-epoch-counter');",
        "const turn=fs.existsSync(marker)?Number(fs.readFileSync(marker,'utf8'))+1:1;",
        "fs.writeFileSync(marker,String(turn));",
        "if(turn===2)fs.writeFileSync(path.join(cwd,'src','main','index.ts'),'foreign-source-during-confirmation');",
        "for(const name of ['main/index.js','preload/index.js','renderer/index.html']){",
        "const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});",
        "fs.writeFileSync(file,name==='main/index.js'?fs.readFileSync(path.join(cwd,'src','main','index.ts')):name);}"
      ].join('\n'));
      const changedEpoch = invoke('--local-update=main', '--review-only', '--rebuild', '--json');
      expect(changedEpoch.code).toBe(1);
      expect(changedEpoch.receipt).toMatchObject({
        reason: 'local-update-private-build-unverified',
        nextAction: 'rerun-after-source-stabilizes', generation: null,
        changesInstalled: false,
        privateBuildFailure: {
          failureClassification: 'ownership',
          failureCodes: expect.arrayContaining(['source-changed-during-confirmation']),
          outputDrift: { changedFiles: 1, counts: { main: 1 } },
          sourceInputDrift: { changeCount: 1,
            examples: [{ file: 'src/main/index.ts',
              oldSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
              newSha256: expect.stringMatching(/^[A-F0-9]{64}$/) }] }
        }
      });
      expect(changedEpoch.receipt.privateBuildFailure.failureCodes)
        .not.toContain('nondeterministic-compiled-output');
      expect(changedEpoch.receipt).not.toHaveProperty('mainActivationHandoff');
      expect(JSON.stringify(changedEpoch.receipt)).not.toContain('foreign-source-during-confirmation');
      writeFileSync(currentMain, originalMain);
      writeFileSync(compiler, goodCompiler);

      // A modified private receipt is not an eligible cache hit, nor
      // permission to silently rebuild while a different owner is writing.
      const altered = path.join(root, '.test_tmp', drift.receipt.generation, 'evidence.json');
      const originalEvidence = readFileSync(altered, 'utf8');
      writeFileSync(altered, originalEvidence.replace(
        drift.receipt.compiledOutputSha256, 'A'.repeat(64)));
      const modifiedReceipt = invoke(...review);
      expect(modifiedReceipt.code).toBe(1);
      expect(modifiedReceipt.receipt).toMatchObject({
        reason: 'local-update-generation-selection-unverified',
        generation: null, changesInstalled: false,
        stages: { rendererHealth: { status: 'not-run' } }
      });
      expect(readFileSync(altered, 'utf8')).not.toBe(originalEvidence);
      writeFileSync(altered, originalEvidence);

      const invalid = invoke('--local-update=renderer', '--review-only', '--json', '--unsafe-auto-install');
      expect(invalid.code).toBe(1);
      expect(invalid.receipt.reason).toBe('local-update-options-unverified');
      const bypass = invoke('--local-update=renderer', '--review-only', '--interactive-preview', '--json');
      expect(bypass.code).toBe(1);
      expect(bypass.receipt.reason).toBe('local-update-options-unverified');
      // Closing an interactive command without the operator's positive start
      // never performs engineering preparation or starts a preview listener.
      const noStart = spawnSync(process.execPath,
        [local, '--local-update=renderer', '--interactive-preview', '--json'],
        { cwd: root, encoding: 'utf8', input: 'cancel\n', timeout: 15000 });
      expect(noStart.status, noStart.stderr).toBe(1);
      const noStartRows = noStart.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      expect(noStartRows).toHaveLength(2);
      expect(noStartRows[0].event).toBe('awaiting-stdin-control');
      expect(noStartRows[1]).toMatchObject({
        status: 'refused', changesInstalled: false,
        stages: { foregroundControl: { status: 'refused', explicitStartReceived: false },
          rendererHealth: { status: 'not-run' } },
        executionTiming: {
          failedStage: 'interactiveControl',
          foregroundControl: { status: 'refused' },
          localPreparation: { status: 'not-run', durationMs: null },
          liveLifecycle: { status: 'not-invoked', durationMs: null }
        }
      });
      expect(noStartRows[1].stages.foregroundControl.durationMs).toBeGreaterThanOrEqual(0);
      expect(noStartRows[1].executionTiming.liveLifecycle).toMatchObject({
        productionDowntimeMs: null, phases: {
          admissionPause: { status: 'not-invoked', durationMs: null },
          rollbackRestoration: { status: 'not-invoked', durationMs: null }
        }
      });

      // Cancel during the fixture's actual in-flight compiler. The wrapper
      // must forward cancellation, preserve earlier immutable stages and
      // never continue into health/activation after a cancelled build.
      const originalNames = readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort();
      const marker = path.join(root, 'cancelled-compiler-started.txt');
      writeFileSync(compiler, `
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(marker.replaceAll('\\', '/'))},String(process.pid));
process.on('SIGTERM',()=>process.exit(0));
setTimeout(()=>process.exit(0),2000);
`);
      compilerAbsenceVerified = false;
      runningUpdate = spawn(process.execPath, [local, ...review], {
        cwd: root, stdio: ['pipe', 'pipe', 'pipe']
      });
      compilerChild = observeLocalUpdateFixtureChild(runningUpdate);
      let cancelledOutput = '';
      runningUpdate.stdout!.on('data', data => { cancelledOutput += String(data); });
      for (let attempt = 0; attempt < 120 && !existsSync(marker); attempt++)
        await new Promise(resolve => setTimeout(resolve, 25));
      expect(existsSync(marker), 'Controlled compiler must start before cancellation').toBe(true);
      const cancelledExit = new Promise<number | null>(resolve =>
        runningUpdate!.once('close', resolve));
      runningUpdate.stdin!.write('cancel\n');
      expect(await cancelledExit).toBe(1);
      const cancelled = JSON.parse(cancelledOutput.trim());
      expect(cancelled).toMatchObject({
        status: 'refused', reason: 'local-update-cancelled',
        nativeRuntimeVerified: false, changesInstalled: false,
        stages: { rendererHealth: { status: 'not-run' } }
      });
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort()).toEqual(originalNames);
      // Wrapper settlement alone is not proof that Windows' original
      // compiler PID has left Win32_Process after a cancelled child.
      const exactCompilerPid = Number(readFileSync(marker, 'utf8'));
      let absent = false;
      for (let attempt = 0; attempt < 25; attempt++) {
        if (process.platform === 'win32') {
          const census = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive',
            '-Command', `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${exactCompilerPid}';` +
            `if($null -eq $p){'absent'}else{'present'}`],
          { encoding: 'utf8', timeout: 5000 });
          absent = census.status === 0 && census.stdout.trim() === 'absent';
        } else {
          try { process.kill(exactCompilerPid, 0); }
          catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        }
        if (absent) {
          absent = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      compilerAbsenceVerified = absent;
      expect(absent, 'Fixture compiler must be positively absent before private cleanup').toBe(true);
      runningUpdate = null;
      expect(readFileSync(path.join(root, 'out', 'main', 'index.js'), 'utf8'))
        .toBe('historical-generated-output-untouched');
      expect(existsSync(path.join(root, '.test_tmp', '.chat42-private-preview-owner'))).toBe(false);
    } finally {
      if (await localUpdateFixtureCleanupReady(compilerAbsenceVerified, [compilerChild, previewChild]))
        rmSync(root, { recursive: true, force: true });
    }
  }, 165000);

  it('classifies real Git main-only, cross-runtime, untracked and dependency drift against one strict baseline', () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-main-risk-'));
    const git = (...args: string[]) => {
      const outcome = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 });
      expect(outcome.status, outcome.stderr).toBe(0);
      return outcome.stdout.trim();
    };
    const inspect = (installed: object) => {
      const moduleUrl = pathToFileURL(path.join(project, 'scripts', 'dev-fast-local-update.mjs')).href;
      const source = 'import {mainActivationRisk} from ' + JSON.stringify(moduleUrl) +
        ';console.log(JSON.stringify(mainActivationRisk(process.argv[1],JSON.parse(process.argv[2]))))';
      const outcome = spawnSync(process.execPath,
        ['--input-type=module', '-e', source, root, JSON.stringify(installed)],
        { encoding: 'utf8', timeout: 7000, maxBuffer: 32768 });
      expect(outcome.status, outcome.stderr).toBe(0);
      return JSON.parse(outcome.stdout);
    };
    try {
      mkdirSync(path.join(root, 'src', 'main'), { recursive: true });
      writeFileSync(path.join(root, 'src', 'main', 'index.ts'), 'baseline');
      writeFileSync(path.join(root, 'package.json'), '{"private":true}');
      writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
      git('init', '-q');
      git('add', 'src/main/index.ts', 'package.json', 'package-lock.json');
      git('-c', 'user.name=CoSFixture', '-c', 'user.email=fixture@invalid.local',
        'commit', '-qm', 'synthetic source baseline');
      const baseline = git('rev-parse', 'HEAD');
      const installed = { status: 'observed-strict-receipt', commit: baseline,
        packageMatch: true, lockMatch: true };
      expect(inspect(installed)).toMatchObject({
        state: 'classified', scope: 'no-observed-difference',
        eligibleForNativeActivation: false, requiresRootReleaseReview: true
      });
      mkdirSync(path.join(root, 'src', 'renderer'));
      writeFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'changed renderer styling');
      expect(inspect(installed)).toMatchObject({
        scope: 'renderer-source-only-candidate', domains: { renderer: 1, main: 0 },
        activationPlan: {
          affectedComponents: ['renderer'],
          materialization: 'renderer-private-http-or-existing-vite-hmr',
          redundantBuildWork: ['main-preload-compile', 'companion-materialization']
        },
        eligibleForNativeActivation: false, requiresRootReleaseReview: true
      });
      mkdirSync(path.join(root, 'extension'));
      writeFileSync(path.join(root, 'extension', 'background.js'), 'changed companion');
      expect(inspect(installed)).toMatchObject({
        scope: 'mixed-runtime-scope', domains: { renderer: 1, companion: 1 },
        eligibleForNativeActivation: false
      });
      unlinkSync(path.join(root, 'src', 'renderer', 'styles.css'));
      expect(inspect(installed)).toMatchObject({
        scope: 'companion-source-only-candidate', domains: { companion: 1, renderer: 0 },
        eligibleForNativeActivation: false, requiresRootReleaseReview: true
      });
      unlinkSync(path.join(root, 'extension', 'background.js'));
      writeFileSync(path.join(root, 'src', 'main', 'index.ts'), 'changed backend bytes');
      expect(inspect(installed)).toMatchObject({
        state: 'classified', scope: 'main-source-only-candidate',
        domains: { main: 1, nativeOrDependency: 0, other: 0 },
        activationPlan: {
          affectedComponents: ['main'],
          runtimeOwner: 'root-codex-release-and-ProfileLifecycleCoordinator',
          redundantBuildWork: ['companion-validation', 'renderer-validation']
        },
        eligibleForNativeActivation: false
      });
      mkdirSync(path.join(root, 'src', 'preload'));
      writeFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'new privileged preload');
      expect(inspect(installed)).toMatchObject({
        scope: 'main-preload-source-candidate', domains: { main: 1, preload: 1 },
        changedPathCount: 2, eligibleForNativeActivation: false
      });
      // Main/preload share an owner, but neither can hide a changed renderer or
      // companion and declare that runtime's validation redundant.
      for (const mainChanged of [false, true]) {
        writeFileSync(path.join(root, 'src', 'main', 'index.ts'), mainChanged ? 'changed backend bytes' : 'baseline');
        for (const [renderer, companion] of [[true, false], [false, true], [true, true]]) {
          const rendererFile = path.join(root, 'src', 'renderer', 'styles.css');
          const companionFile = path.join(root, 'extension', 'background.js');
          if (renderer) writeFileSync(rendererFile, 'mixed renderer change');
          else if (existsSync(rendererFile)) unlinkSync(rendererFile);
          if (companion) writeFileSync(companionFile, 'mixed companion change');
          else if (existsSync(companionFile)) unlinkSync(companionFile);
          expect(inspect(installed), JSON.stringify({ mainChanged, renderer, companion })).toMatchObject({
            scope: 'mixed-runtime-scope', eligibleForNativeActivation: false,
            activationPlan: { affectedComponents: ['main', 'preload', 'renderer', 'companion'],
              redundantBuildWork: [], productionActivationAllowed: false,
              materialization: 'full-existing-qualification-path' }
          });
        }
      }
      unlinkSync(path.join(root, 'src', 'renderer', 'styles.css'));
      unlinkSync(path.join(root, 'extension', 'background.js'));
      writeFileSync(path.join(root, 'src', 'main', 'index.ts'), 'changed backend bytes');
      writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":4}');
      expect(inspect(installed)).toMatchObject({
        scope: 'release-risk', domains: { nativeOrDependency: 1 },
        eligibleForNativeActivation: false
      });
      expect(inspect({ ...installed, commit: 'F'.repeat(40) })).toMatchObject({
        state: 'unverified', reason: 'installed-baseline-object-unavailable',
        checkoutChangeCount: 3,
        checkoutChangeScope: 'release-risk',
        checkoutDomains: { main: 1, preload: 1, renderer: 0, companion: 0,
          nativeOrDependency: 1, other: 0 },
        activationPlan: {
          basis: {
            installedBaselineComparison: 'installed-receipt-only',
            checkoutObservation: {
              changeCount: 3, scope: 'release-risk'
            }
          },
          affectedComponents: ['unknown'],
          productionActivationAllowed: false
        },
        eligibleForNativeActivation: false
      });
      expect(inspect({ ...installed, packageMatch: false })).toMatchObject({
        scope: 'release-risk', packageAndLockMatchInstalled: false,
        eligibleForNativeActivation: false
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('consumes exact private renderer generations with isolated health, guarded switch and verified restoration', async () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-renderer-consumer-'));
    const local = path.join(root, 'scripts', 'dev-fast.mjs');
    const preview = path.join(root, 'scripts', 'dev-fast-preview.mjs');
    const compiler = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    let child: ReturnType<typeof spawn> | null = null;
    let childOwner: LocalUpdateFixtureChild | null = null;
    let fixtureDescendantPid: number | null = null;
    const descendantMarker = 'cos-preview-fixture-' + randomUUID();
    let fixtureCleanupVerified = true;
    try {
      mkdirSync(path.dirname(local), { recursive: true });
      mkdirSync(path.dirname(compiler), { recursive: true });
      mkdirSync(path.join(root, '.test_tmp'));
      for (const area of ['main', 'preload', 'renderer']) mkdirSync(path.join(root, 'src', area), { recursive: true });
      copyFileSync(script, local);
      copyFileSync(path.join(project, 'scripts', 'dev-fast-preview.mjs'), preview);
      for (const name of ['electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'])
        writeFileSync(path.join(root, name), name === 'package.json' ? '{"type":"commonjs"}' : name);
      for (const area of ['main', 'preload', 'renderer'])
        writeFileSync(path.join(root, 'src', area, area === 'renderer' ? 'index.html' : 'index.ts'), area);
      writeFileSync(compiler, `
const fs=require('node:fs');
const path=require('node:path');
const stage=process.argv[process.argv.indexOf('--outDir')+1];
for(const name of ['main/index.js','preload/index.js','renderer/index.html','renderer/assets/app.js']){
  const file=path.join(stage,name);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,name==='renderer/index.html' ? '<html><script src="./assets/app.js"></script></html>' : 'compiled '+name);
}
`);
      for (const name of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
        const file = path.join(root, 'out', name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, 'historical-out-unchanged');
      }
      const create = () => {
        const r = spawnSync(process.execPath, [local, '--qualify-build', '--confirm-reproducible',
          '--prepare-private-out', '--json'], { cwd: root, encoding: 'utf8', timeout: 10000 });
        expect(r.status, r.stderr).toBe(0);
        const receipt = JSON.parse(r.stdout);
        expect(receipt.privateOutput.published).toBe(true);
        expect(receipt.accepted).toBe(false);
        return receipt;
      };
      const a = create();
      const b = create();
      const selection = (generation: typeof a) => [
        '--expect-source-sha256='+generation.sourceSha256,
        '--expect-compiled-sha256='+generation.compiledOutputSha256,
        '--expect-compiler-sha256='+generation.toolchain.electronViteCliSha256
      ];
      const options = (generation: typeof a, kind = '--preview-private-out=') =>
        [local, kind+generation.privateOutput.name, ...selection(generation), '--json'];
      const log: any[] = [];
      let buffer = '';
      const events = new EventEmitter();
      const fixtureHealth = path.join(root, 'health-injection.cjs');
      writeFileSync(fixtureHealth, `
const previous=globalThis.fetch;
let pending=0;
globalThis.fetch=async (url,...rest)=>{
  if(String(url).includes('/__pending/assets/app.js') &&
    pending===2 && process.env.COS_PREVIEW_TEST_HEALTH==='asset-mismatch') {
    const normal=await previous(url,...rest);
    const headers=new Headers(normal.headers);
    headers.delete('content-length');
    const expected=await normal.text();
    return new Response('X'.repeat(expected.length),
      {status:200,headers});
  }
  if(String(url).includes('/__pending/index.html') && ++pending===2) {
    const mode=process.env.COS_PREVIEW_TEST_HEALTH;
    if(mode==='asset-mismatch') return previous(url,...rest);
    if(mode==='timeout') return new Promise(()=>{});
    if(mode==='body-timeout' || mode==='body-limit') {
      const normal=await previous(url,...rest);
      const headers=new Headers(normal.headers);
      headers.delete('content-length');
      let bodySignaled=false;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(mode==='body-limit' ?
            'y'.repeat(10000) : '<'));
          if(mode==='body-limit') controller.close();
        },
        pull() {
          if(mode==='body-timeout' && process.env.COS_PREVIEW_TEST_BODY_SIGNAL==='1' && !bodySignaled) {
            bodySignaled=true;
            console.log(JSON.stringify({event:'fixture-health-first-body-byte',ownerPid:process.pid,receivedBytes:1}));
          }
        }
      }),{status:200,headers});
    }
    throw Error('injected preview health failure');
  }
  return previous(url,...rest);
};
`);
      const start = (env: Record<string, string> = {}) => {
        child = spawn(process.execPath, options(a), { cwd: root,
          env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        childOwner = observeLocalUpdateFixtureChild(child);
        child.stdout!.on('data', data => {
          buffer += data.toString();
          while (buffer.includes('\n')) {
            const end = buffer.indexOf('\n');
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (line) {
              const receipt = JSON.parse(line);
              // The injected child can exist before reserveLease/ready fails. Capture its
              // exact marked parent receipt immediately, not after awaiting ready.
              const descendant = previewFixtureDescendant(receipt, descendantMarker, child?.pid ?? null);
              if (descendant !== null) fixtureDescendantPid = descendant;
              log.push(receipt); events.emit('receipt');
            }
          }
        });
      };
      const next = (wanted: string, timeoutMs = 12000): Promise<any> => new Promise((resolve, reject) => {
        const check = () => {
          const index = log.findIndex(entry => entry.event === wanted);
          if (index === -1) return;
          clearTimeout(timer);
          events.off('receipt', check);
          resolve(log.splice(index, 1)[0]);
        };
        const timer = setTimeout(() => {
          events.off('receipt', check);
          reject(new Error('Missing '+wanted+' preview receipt: '+JSON.stringify(log)));
        }, timeoutMs);
        events.on('receipt', check);
        check();
      });
      const send = (command: object) => child!.stdin!.write(JSON.stringify(command)+'\n');
      const to = (generation: typeof a) => ({ command: 'use', generation: generation.privateOutput.name,
        source: generation.sourceSha256, compiled: generation.compiledOutputSha256,
        compiler: generation.toolchain.electronViteCliSha256 });

      start();
      const ready = await next('ready');
      expect(ready).toMatchObject({ healthConfirmed: true,
        targetKind: 'isolated-loopback-renderer-only',
        generation: a.privateOutput.name, compiledOutputSha256: a.compiledOutputSha256,
        httpVerifiedAssetCount: 2,
        servedRendererSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
        qualifiedRendererManifestSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
        nativeRuntimeVerified: false, installedRuntimeVerified: false });
      expect(ready.targetOwnerPid).toBe(child!.pid);
      const ownerRecord = () => JSON.parse(readFileSync(path.join(root, '.test_tmp',
        '.chat42-private-preview-owner', 'owner.json'), 'utf8'));
      expect(ownerRecord()).toMatchObject({ phase: 'listening', pending: null,
        active: { generation: a.privateOutput.name, compiled: a.compiledOutputSha256 },
        previous: null });
      const page = await fetch(ready.endpoint);
      expect(page.status).toBe(200);
      expect(await page.text()).toBe('<html><script src="./assets/app.js"></script></html>');
      expect((await fetch(ready.endpoint.replace('/index.html', '/assets/app.js'))).status).toBe(200);
      expect((await fetch(ready.endpoint.replace('/index.html', '/../../out/main/index.js'))).status).toBe(404);

      const concurrent = spawnSync(process.execPath, options(b), { cwd: root, encoding: 'utf8', timeout: 8000 });
      expect(concurrent.status).toBe(1);
      expect(JSON.parse(concurrent.stdout.split(/\r?\n/)[0] ?? '')).toMatchObject({ event: 'refused',
        reason: 'private-preview-owner-busy-or-stale' });
      expect(existsSync(path.join(root, '.test_tmp', '.chat42-private-preview-owner'))).toBe(true);

      send(to(b));
      const switched = await next('activated');
      expect(switched).toMatchObject({ generation: b.privateOutput.name,
        previousGeneration: a.privateOutput.name, healthConfirmed: true,
        httpVerifiedAssetCount: 2 });
      expect(ownerRecord()).toMatchObject({ phase: 'listening', pending: null,
        active: { generation: b.privateOutput.name },
        previous: { generation: a.privateOutput.name } });
      send({ command: 'restore' });
      const restored = await next('restored');
      expect(restored).toMatchObject({ generation: a.privateOutput.name,
        previousGeneration: b.privateOutput.name, healthConfirmed: true });
      expect(restored.servedRendererSha256).toBe(ready.servedRendererSha256);
      expect(ownerRecord()).toMatchObject({ phase: 'listening', pending: null,
        active: { generation: a.privateOutput.name }, previous: null });

      // Source drift and tampering refuse the next transition without modifying
      // the known-good in-memory target or destroying either private generation.
      writeFileSync(path.join(root, 'src', 'main', 'index.ts'), 'unrelated source changed');
      send(to(b));
      expect(await next('refused')).toMatchObject({
        requestedGeneration: b.privateOutput.name, activeGeneration: a.privateOutput.name,
        reason: 'private-preview-generation-stale-or-unverified' });
      writeFileSync(path.join(root, 'src', 'main', 'index.ts'), 'main');
      const evidencePath = path.join(b.privateOutput.path, 'evidence.json');
      const evidence = readFileSync(evidencePath);
      writeFileSync(evidencePath, JSON.stringify({ ...JSON.parse(evidence.toString()), fileCount: 999 }));
      send(to(b));
      expect(await next('refused')).toMatchObject({ activeGeneration: a.privateOutput.name,
        reason: 'private-preview-generation-stale-or-unverified' });
      writeFileSync(evidencePath, evidence);

      send({ command: 'status' });
      expect(await next('status')).toMatchObject({ generation: a.privateOutput.name,
        health: 'verified', previousGeneration: null,
        servedRendererSha256: ready.servedRendererSha256, httpAssetsReverified: 2 });
      expect(ownerRecord()).toMatchObject({ phase: 'listening', pending: null,
        active: { generation: a.privateOutput.name }, previous: null });
      const exited = new Promise<number | null>(resolve => child!.once('close', resolve));
      send({ command: 'stop' });
      expect(await exited).toBe(0);
      child = null;
      expect(existsSync(path.join(root, '.test_tmp', '.chat42-private-preview-owner'))).toBe(false);

      // A real finite probe uses this same production selector, HTTP handler,
      // and lease lifecycle, then stops without leaving a resident daemon.
      const probe = spawnSync(process.execPath, options(a, '--probe-private-out='),
        { cwd: root, encoding: 'utf8', timeout: 10000 });
      expect(probe.status, probe.stderr).toBe(0);
      const probeEvents = probe.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      expect(probeEvents[0]).toMatchObject({ event: 'ready', healthConfirmed: true });
      expect(probeEvents[1]).toMatchObject({ event: 'stopped', leaseReleased: true,
        reason: 'probe-complete' });

      // Inject a health failure after the first verified generation. The
      // candidate must not become active even when its files/hashes are valid.
      start({ NODE_OPTIONS: '--require="'+fixtureHealth.replaceAll('\\', '/')+'"' });
      expect(await next('ready')).toMatchObject({ generation: a.privateOutput.name });
      send(to(b));
      const failedHealth = await next('refused');
      expect(failedHealth).toMatchObject({ activeGeneration: a.privateOutput.name,
        requestedGeneration: b.privateOutput.name, healthConfirmed: false });
      const healthExit = new Promise<number | null>(resolve => child!.once('close', resolve));
      send({ command: 'stop' });
      expect(await healthExit).toBe(0);
      child = null;

      // Correct HTML with a wrong JS response cannot authorize a switch.
      // The earlier served generation remains healthy and reviewable.
      start({ NODE_OPTIONS: '--require="'+fixtureHealth.replaceAll('\\', '/')+'"',
        COS_PREVIEW_TEST_HEALTH: 'asset-mismatch' });
      const originalReady = await next('ready');
      expect(originalReady).toMatchObject({ generation: a.privateOutput.name,
        httpVerifiedAssetCount: 2 });
      send(to(b));
      expect(await next('refused')).toMatchObject({
        reason: 'private-preview-health-bytes-mismatch',
        activeGeneration: a.privateOutput.name, historyPreserved: true,
        activeServedRendererSha256: originalReady.servedRendererSha256
      });
      send({ command: 'status' });
      expect(await next('status')).toMatchObject({
        health: 'verified', generation: a.privateOutput.name,
        servedRendererSha256: originalReady.servedRendererSha256
      });
      const assetExit = new Promise<number | null>(resolve => child!.once('close', resolve));
      send({ command: 'stop' });
      expect(await assetExit).toBe(0);
      child = null;

      start({ NODE_OPTIONS: '--require="'+fixtureHealth.replaceAll('\\', '/')+'"',
        COS_PREVIEW_TEST_HEALTH: 'timeout' });
      expect(await next('ready')).toMatchObject({ generation: a.privateOutput.name });
      send(to(b));
      expect(await next('refused', 9000)).toMatchObject({
        reason: 'private-preview-health-timeout', activeGeneration: a.privateOutput.name });
      const timeoutExit = new Promise<number | null>(resolve => child!.once('close', resolve));
      send({ command: 'stop' });
      expect(await timeoutExit).toBe(0);
      child = null;

      // A peer can finish HTTP headers and stream one byte without finishing
      // the body. The whole response must have a finite timeout; a stream
      // exceeding the exact expected HTML size must also refuse a switch.
      for (const mode of ['body-timeout', 'body-limit']) {
        start({ NODE_OPTIONS: '--require="'+fixtureHealth.replaceAll('\\', '/')+'"',
          COS_PREVIEW_TEST_HEALTH: mode });
        expect(await next('ready')).toMatchObject({ generation: a.privateOutput.name });
        send(to(b));
        const refusedBody = await next('refused', 9000);
        expect(refusedBody).toMatchObject({
          activeGeneration: a.privateOutput.name, healthConfirmed: false,
          reason: mode === 'body-timeout' ? 'private-preview-health-timeout' :
            'private-preview-health-body-limit'
        });
        expect(refusedBody.nextAction).toBeTruthy();
        send({ command: 'status' });
        expect(await next('status')).toMatchObject({ generation: a.privateOutput.name, health: 'verified' });
        const finished = new Promise<number | null>(resolve => child!.once('close', resolve));
        send({ command: 'stop' });
        expect(await finished).toBe(0);
        child = null;
      }

      // Crash partway through a blocked response body. The in-flight
      // candidate is explicitly unconfirmed in the lease, while the last
      // successful health-verified generation remains recoverable by hash.
      if (process.platform === 'win32') {
        start({ NODE_OPTIONS: '--require="'+fixtureHealth.replaceAll('\\', '/')+'"',
          COS_PREVIEW_TEST_HEALTH: 'body-timeout', COS_PREVIEW_TEST_BODY_SIGNAL: '1' });
        expect(await next('ready')).toMatchObject({ generation: a.privateOutput.name });
        send(to(b));
        // Exact selection precedes publishing the switching lease and can take
        // longer than a fixed polling window. Observe the real health reader
        // consuming its first byte, while that same candidate remains pending.
        expect(await next('fixture-health-first-body-byte')).toMatchObject({
          ownerPid: child!.pid, receivedBytes: 1
        });
        const switching = ownerRecord();
        expect(switching).toMatchObject({
          phase: 'switching', active: { generation: a.privateOutput.name },
          pending: { generation: b.privateOutput.name }
        });
        const crashedSwitch = new Promise<number | null>(resolve => child!.once('close', resolve));
        fixtureCleanupVerified = false;
        child!.kill('SIGKILL');
        await crashedSwitch;
        child = null;
        const interrupted = spawnSync(process.execPath,
          [local, '--recover-private-preview'], { cwd: root, encoding: 'utf8', timeout: 12000 });
        expect(interrupted.status, interrupted.stderr).toBe(0);
        expect(JSON.parse(interrupted.stdout)).toMatchObject({
          event: 'recovered', interruptedTransition: true,
          lastConfirmed: { generation: a.privateOutput.name, compiled: a.compiledOutputSha256 },
          pendingUnconfirmed: { generation: b.privateOutput.name }
        });
        expect(existsSync(path.join(root, '.test_tmp', '.chat42-private-preview-owner'))).toBe(false);
        fixtureCleanupVerified = true;
      }

      // A real, task-owned preview crash leaves a fenced lease. Recovery must
      // refuse the live owner, then require independent Windows PID absence;
      // it must not modify snapshots or any shared build output.
      if (process.platform === 'win32') {
        start();
        expect(await next('ready')).toMatchObject({ generation: a.privateOutput.name });
        const lease = path.join(root, '.test_tmp', '.chat42-private-preview-owner');
        const locked = JSON.parse(readFileSync(path.join(lease, 'owner.json'), 'utf8'));
        const refusedLive = spawnSync(process.execPath,
          [local, '--recover-private-preview'], { cwd: root, encoding: 'utf8', timeout: 10000 });
        expect(refusedLive.status).toBe(1);
        expect(JSON.parse(refusedLive.stdout.split(/\r?\n/)[0] ?? '')).toMatchObject({ event: 'refused',
          reason: 'private-preview-owner-live-or-unknown' });
        expect(existsSync(lease)).toBe(true);
        const died = new Promise<number | null>(resolve => child!.once('close', resolve));
        fixtureCleanupVerified = false;
        child!.kill('SIGKILL');
        await died;
        child = null;
        let absent = false;
        for (let attempt = 0; attempt < 15; attempt++) {
          const census = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${locked.pid}';` +
            `if($null -eq $p){'absent'}else{'present'}`
          ], { encoding: 'utf8', timeout: 5000 });
          if (census.status === 0 && census.stdout.trim() === 'absent') { absent = true; break; }
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        expect(absent, 'Preview PID must be independently absent before recovery').toBe(true);
        const recovered = spawnSync(process.execPath,
          [local, '--recover-private-preview'], { cwd: root, encoding: 'utf8', timeout: 12000 });
        expect(recovered.status, recovered.stderr+' '+recovered.stdout).toBe(0);
        expect(JSON.parse(recovered.stdout)).toMatchObject({ event: 'recovered', recovered: true,
          runtimeStarted: false });
        expect(existsSync(lease)).toBe(false);
        fixtureCleanupVerified = true;
        const afterCrash = spawnSync(process.execPath,
          options(a, '--probe-private-out='), { cwd: root, encoding: 'utf8', timeout: 10000 });
        expect(afterCrash.status, afterCrash.stderr).toBe(0);

        // The parent being gone does not establish descendant custody. Start
        // an exact fixture-owned child of this preview, crash its parent and
        // assert the native Win32_Process ancestry census refuses reclamation.
        const descendantHook = path.join(root, 'descendant-injection.cjs');
        writeFileSync(descendantHook, `
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
if(process.argv.some(arg=>arg.startsWith('--preview-private-out='))) {
  const processChild=spawn(process.execPath,
    ['-e','setInterval(()=>{},1000);setTimeout(()=>process.exit(0),180000).unref()','--',${JSON.stringify(descendantMarker)}],{stdio:'ignore',detached:true,windowsHide:true,
      env:{...process.env,NODE_OPTIONS:''}});
  fs.writeFileSync(path.join(__dirname,'.test_tmp','fixture-descendant.pid'),String(processChild.pid));
  process.stdout.write(JSON.stringify({event:'fixture-descendant-created',pid:processChild.pid,parentPid:process.pid,marker:${JSON.stringify(descendantMarker)}})+'\\n');
  processChild.unref();
}
`);
        fixtureCleanupVerified = false;
        start({ NODE_OPTIONS: '--require="'+descendantHook.replaceAll('\\', '/')+'"' });
        expect(await next('ready')).toMatchObject({ generation: a.privateOutput.name });
        fixtureDescendantPid = Number(readFileSync(path.join(root, '.test_tmp',
          'fixture-descendant.pid'), 'utf8'));
        expect(Number.isSafeInteger(fixtureDescendantPid) && fixtureDescendantPid > 0).toBe(true);
        const crashed = new Promise<number | null>(resolve => child!.once('close', resolve));
        child!.kill('SIGKILL');
        await crashed;
        child = null;
        const fenced = spawnSync(process.execPath, [local, '--recover-private-preview'], {
          cwd: root, encoding: 'utf8', timeout: 12000
        });
        expect(fenced.status).toBe(1);
        expect(JSON.parse(fenced.stdout)).toMatchObject({ event: 'refused',
          reason: 'private-preview-descendant-or-runtime-unverified' });
        expect(existsSync(lease)).toBe(true);
        // This exact child was created by our disposable fixture. Cleanup is
        // strictly PID-scoped, with independent absence before recovered use.
        try { process.kill(fixtureDescendantPid, 'SIGKILL'); } catch { /* already exited */ }
        let descendantGone = false;
        for (let attempt = 0; attempt < 15; attempt++) {
          const census = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${fixtureDescendantPid}';` +
            `if($null -eq $p){'absent'}else{'present'}`
          ], { encoding: 'utf8', timeout: 5000 });
          if (census.status === 0 && census.stdout.trim() === 'absent') {
            descendantGone = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        expect(descendantGone).toBe(true);
        fixtureDescendantPid = null;
        const cleared = spawnSync(process.execPath, [local, '--recover-private-preview'], {
          cwd: root, encoding: 'utf8', timeout: 12000
        });
        expect(cleared.status, cleared.stderr+' '+cleared.stdout).toBe(0);
        expect(JSON.parse(cleared.stdout)).toMatchObject({ event: 'recovered', recovered: true });
        expect(existsSync(lease)).toBe(false);
        fixtureCleanupVerified = true;
      }

      expect(existsSync(path.join(a.privateOutput.path, 'evidence.json'))).toBe(true);
      expect(existsSync(path.join(b.privateOutput.path, 'evidence.json'))).toBe(true);
      expect(readFileSync(path.join(root, 'out', 'main', 'index.js'), 'utf8'))
        .toBe('historical-out-unchanged');
    } finally {
      if (child && child.exitCode === null) {
        fixtureCleanupVerified = false;
        const ended = new Promise<void>(resolve => child!.once('close', () => resolve()));
        child.kill('SIGKILL');
        await ended;
      }
      if ((childOwner as LocalUpdateFixtureChild | null)?.closed) child = null;
      if (fixtureDescendantPid !== null) {
        fixtureCleanupVerified = false;
        try { process.kill(fixtureDescendantPid, 'SIGKILL'); }
        catch { /* already exited */ }
      }
      // Best-effort termination is not native absence/recovery proof. Keep the lease and
      // evidence intact when any crash/descendant custody remains unknown.
      if (fixtureCleanupVerified && child === null && fixtureDescendantPid === null &&
          !existsSync(path.join(root, '.test_tmp', '.chat42-private-preview-owner'))) {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } else console.warn('[CoS dev fixture] Private-preview custody remains unverified; temporary fixture and lease retained for inspection.');
    }
  }, 60000);

  it('publishes reproducible development output atomically beside, never over, an unowned historical out', () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-private-output-'));
    const local = path.join(root, 'scripts', 'dev-fast.mjs');
    const compiler = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    try {
      mkdirSync(path.dirname(local), { recursive: true });
      mkdirSync(path.dirname(compiler), { recursive: true });
      mkdirSync(path.join(root, '.test_tmp'));
      for (const area of ['main', 'preload', 'renderer'])
        mkdirSync(path.join(root, 'src', area), { recursive: true });
      copyFileSync(script, local);
      for (const file of ['electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'])
        writeFileSync(path.join(root, file), file === 'package.json' ? '{"type":"commonjs"}' : file);
      for (const area of ['main', 'preload', 'renderer'])
        writeFileSync(path.join(root, 'src', area, area === 'renderer' ? 'index.html' : 'index.ts'), area);
      for (const file of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
        const dest = path.join(root, 'out', file);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, `unowned historical ${file}`);
      }
      const historical = ['main/index.js', 'preload/index.js', 'renderer/index.html']
        .map(file => readFileSync(path.join(root, 'out', file), 'utf8'));
      writeFileSync(compiler, `
const fs = require('node:fs');
const path = require('node:path');
const marker = path.join(process.cwd(), '.test_tmp', 'compiler-pass-marker');
const second = fs.existsSync(marker);
if (process.env.COS_PRIVATE_STAGE_FAIL === 'confirm' && second) process.exit(23);
const dir = process.argv[process.argv.indexOf('--outDir') + 1];
for (const name of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'verified staged '+name);
}
if (!second) fs.writeFileSync(marker, 'first-pass-finished');
if (process.env.COS_PRIVATE_STAGE_FAIL === 'source') fs.writeFileSync(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'foreign edit');
if (process.env.COS_PRIVATE_STAGE_FAIL === 'capacity' && second) {
  const root = path.join(process.cwd(), '.test_tmp');
  const occupied = fs.readdirSync(root).filter(name => name.startsWith('chat42-private-out-')).length;
  for (let i = occupied; i < 64; i++) {
    fs.mkdirSync(path.join(root, 'chat42-private-out-00000000-0000-0000-0000-' +
      i.toString(16).padStart(12, '0')));
  }
}
`);
      const run = (extra: string[] = [], env: Record<string, string> = {}) => {
        const marker = path.join(root, '.test_tmp', 'compiler-pass-marker');
        if (existsSync(marker)) rmSync(marker);
        return spawnSync(process.execPath,
          [local, '--qualify-build', '--confirm-reproducible', '--prepare-private-out', '--json', ...extra],
          { cwd: root, encoding: 'utf8', timeout: 12000, env: { ...process.env, ...env } });
      };
      const unsupported = spawnSync(process.execPath,
        [local, '--qualify-build', '--prepare-private-out', '--json'],
        { cwd: root, encoding: 'utf8', timeout: 7000 });
      expect(unsupported.status).toBe(1);
      expect(unsupported.stderr).toContain('requires two reproducible builds');
      expect(readdirSync(path.join(root, '.test_tmp'))).toEqual([]);
      const first = run();
      expect(first.error, first.stderr).toBeUndefined();
      expect(first.stdout, first.stderr).not.toBe('');
      const a = JSON.parse(first.stdout);
      expect(first.status).toBe(0);
      expect(a).toMatchObject({ accepted: false, sourceBuildQualified: true,
        existingBuildQualified: false, reproducible: true, nativeRuntimeVerified: false,
        installedRuntimeVerified: false });
      expect(a.failures).toContain('existing-output-content-mismatch');
      expect(a.privateOutput).toMatchObject({ requested: true, published: true,
        sha256: a.compiledOutputSha256, fileCount: 3, historyPreserved: true });
      expect(a.privateOutput.name).toMatch(/^chat42-private-out-[\da-f-]{36}$/i);
      for (const file of ['main/index.js', 'preload/index.js', 'renderer/index.html'])
        expect(readFileSync(path.join(a.privateOutput.path, 'out', file), 'utf8'))
          .toBe('verified staged '+file);
      expect(JSON.parse(readFileSync(path.join(a.privateOutput.path, 'evidence.json'), 'utf8')))
        .toMatchObject({ schema: 'cos_dev_private_output_v1', compiledOutputSha256: a.compiledOutputSha256,
          sourceSha256: a.sourceSha256, reproducible: true, nativeRuntimeVerified: false });
      const expectHist = () => expect(['main/index.js', 'preload/index.js', 'renderer/index.html']
        .map(file => readFileSync(path.join(root, 'out', file), 'utf8'))).toEqual(historical);
      expectHist();

      const next = run();
      expect(next.status, next.stderr + next.stdout).toBe(0);
      const b = JSON.parse(next.stdout);
      expect(b.privateOutput.published).toBe(true);
      expect(b.privateOutput.name).not.toBe(a.privateOutput.name);
      expect(existsSync(path.join(a.privateOutput.path, 'evidence.json'))).toBe(true);
      expectHist();

      // Rollback is retaining and reselecting immutable prior private snapshots,
      // never replacing the shared historical out or activating the app.
      const select = spawnSync(process.execPath, [local, '--qualify-build', '--json',
        '--select-stage='+a.privateOutput.name,
        '--expect-source-sha256='+a.sourceSha256,
        '--expect-compiled-sha256='+a.compiledOutputSha256,
        '--expect-compiler-sha256='+a.toolchain.electronViteCliSha256],
        { cwd: root, encoding: 'utf8', timeout: 7000 });
      expect(select.status, select.stderr).toBe(0);
      expect(JSON.parse(select.stdout)).toMatchObject({ stageSelectedForReview: true,
        accepted: false, existingBuildQualified: false });

      // A forged/altered publication receipt cannot reclassify a private
      // snapshot as a valid review revision.
      const alteredEvidence = path.join(b.privateOutput.path, 'evidence.json');
      const evidence = JSON.parse(readFileSync(alteredEvidence, 'utf8'));
      writeFileSync(alteredEvidence, JSON.stringify({ ...evidence, compiledOutputSha256: '0'.repeat(64) }));
      const forged = spawnSync(process.execPath, [local, '--qualify-build', '--json',
        '--select-stage='+b.privateOutput.name,
        '--expect-source-sha256='+b.sourceSha256,
        '--expect-compiled-sha256='+b.compiledOutputSha256,
        '--expect-compiler-sha256='+b.toolchain.electronViteCliSha256],
        { cwd: root, encoding: 'utf8', timeout: 7000 });
      expect(forged.status).toBe(1);
      expect(JSON.parse(forged.stdout).failures).toContain('private-output-receipt-mismatch');

      const previousNames = readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort();
      const failed = run([], { COS_PRIVATE_STAGE_FAIL: 'confirm' });
      expect(failed.status).toBe(1);
      expect(JSON.parse(failed.stdout)).toMatchObject({ reproducible: null,
        privateOutput: { requested: true, published: false } });
      const changed = run([], { COS_PRIVATE_STAGE_FAIL: 'source' });
      expect(changed.status).toBe(1);
      expect(JSON.parse(changed.stdout)).toMatchObject({
        privateOutput: { requested: true, published: false } });
      // Inject a deterministic filesystem failure ONLY during copy into the
      // newly owned private draft. No public generation or shared output may
      // be replaced by a partial copy.
      const copyFailure = path.join(root, 'fail-private-copy.cjs');
      writeFileSync(copyFailure, `
const fs = require('node:fs');
const copy = fs.copyFileSync;
fs.copyFileSync = (source, target, ...rest) => {
  if (String(target).includes('.chat42-preparing-private-out-')) throw Error('injected private copy failure');
  return copy(source, target, ...rest);
};
require('node:module').syncBuiltinESMExports();
`);
      const marker = path.join(root, '.test_tmp', 'compiler-pass-marker');
      if (existsSync(marker)) rmSync(marker);
      const copying = spawnSync(process.execPath, [
        '--require', copyFailure, local, '--qualify-build', '--confirm-reproducible',
        '--prepare-private-out', '--json'
      ], { cwd: root, encoding: 'utf8', timeout: 12000 });
      expect(copying.status, copying.stderr).toBe(1);
      expect(copying.stdout, copying.stderr).not.toBe('');
      expect(JSON.parse(copying.stdout)).toMatchObject({
        accepted: false, reproducible: true, sourceBuildQualified: true,
        privateOutput: { requested: true, published: false },
        failures: expect.arrayContaining(['private-output-publication-unverified'])
      });
      expect(JSON.parse(copying.stdout).handoff.next)
        .toContain('inspect-incomplete-private-publication-before-new-attempt');

      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort()).toEqual(previousNames);
      expectHist();
      expect(readFileSync(path.join(a.privateOutput.path, 'out', 'main', 'index.js'), 'utf8'))
        .toBe('verified staged main/index.js');
      // A foreign generation appearing while the confirmation compiler runs
      // must be refused at the publication boundary, before copying a 65th
      // generation. The preexisting private output and shared out/ stay intact.
      const lateCapacity = run([], { COS_PRIVATE_STAGE_FAIL: 'capacity' });
      expect(lateCapacity.status, lateCapacity.stderr).toBe(1);
      expect(JSON.parse(lateCapacity.stdout)).toMatchObject({
        failures: expect.arrayContaining(['private-output-generation-cap-reached']),
        execution: { spawned: true },
        privateOutput: { requested: true, published: false,
          existingGenerationCount: 64, generationLimit: 64 }
      });
      const cappedNames = readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort();
      expect(cappedNames).toHaveLength(64);
      // A now-full private catalog must refuse BEFORE two costly compilers.
      // Synthetic fixture slots are never retired from the live workspace.
      const capacityRefusal = run();
      expect(capacityRefusal.status, capacityRefusal.stderr).toBe(1);
      expect(JSON.parse(capacityRefusal.stdout)).toMatchObject({
        failures: expect.arrayContaining(['private-output-generation-cap-reached']),
        execution: { spawned: false },
        privateOutput: { requested: true, published: false,
          existingGenerationCount: 64, generationLimit: 64 }
      });
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort()).toEqual(cappedNames);
      expect(existsSync(path.join(root, '.test_tmp', 'compiler-pass-marker'))).toBe(false);
      expectHist();
      // Two real qualifier processes can reach publication together. Run the
      // second from the first copy boundary, when the first already passed
      // its count check. Exactly one must own the last catalog slot.
      const lastFixtureSlot = path.join(root, '.test_tmp',
        'chat42-private-out-00000000-0000-0000-0000-00000000003f');
      rmdirSync(lastFixtureSlot); // Empty slot created above by this disposable fixture.
      const raceHook = path.join(root, 'race-private-publication.cjs');
      const competitorReceipt = path.join(root, '.test_tmp', 'competitor.json');
      writeFileSync(raceHook, `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const copy = fs.copyFileSync;
let raced = false;
fs.copyFileSync = (source, target, ...rest) => {
  if (!raced && String(target).includes('.chat42-preparing-private-out-')) {
    raced = true;
    const second = cp.spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'dev-fast.mjs'),
      '--qualify-build', '--confirm-reproducible', '--prepare-private-out', '--json'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 12000 });
    fs.writeFileSync(path.join(process.cwd(), '.test_tmp', 'competitor.json'),
      JSON.stringify({ status: second.status, output: JSON.parse(second.stdout) }));
  }
  return copy(source, target, ...rest);
};
require('node:module').syncBuiltinESMExports();
`);
      const racing = spawnSync(process.execPath, ['--require', raceHook, local,
        '--qualify-build', '--confirm-reproducible', '--prepare-private-out', '--json'],
        { cwd: root, encoding: 'utf8', timeout: 20000 });
      expect(racing.status, racing.stderr + racing.stdout).toBe(0);
      expect(JSON.parse(racing.stdout).privateOutput.published).toBe(true);
      expect(JSON.parse(racing.stdout).privateOutput.publicationLockState).toBe('released');
      const competitor = JSON.parse(readFileSync(competitorReceipt, 'utf8'));
      expect(competitor.status).toBe(1);
      expect(competitor.output.privateOutput.published).toBe(false);
      expect(competitor.output.failures).toContain('private-output-publication-owner-unverified');
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-'))).toHaveLength(64);
      const publicationLock = path.join(root, '.test_tmp', '.chat42-private-output-publication');
      expect(existsSync(publicationLock)).toBe(false);
      expectHist();

      // An unknown retained lock is not unlocked merely because a PID or age
      // looks stale. Preserve it and all catalog bytes for owner inspection.
      rmdirSync(path.join(root, '.test_tmp',
        'chat42-private-out-00000000-0000-0000-0000-00000000003e'));
      mkdirSync(publicationLock);
      writeFileSync(path.join(publicationLock, 'foreign-owner'), 'retain this exact evidence');
      const held = run();
      expect(held.status, held.stderr).toBe(1);
      expect(JSON.parse(held.stdout).failures).toContain('private-output-publication-owner-unverified');
      expect(JSON.parse(held.stdout).execution.spawned).toBe(false);
      expect(readFileSync(path.join(publicationLock, 'foreign-owner'), 'utf8'))
        .toBe('retain this exact evidence');
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-'))).toHaveLength(63);
      expectHist();

      unlinkSync(path.join(publicationLock, 'foreign-owner'));
      rmdirSync(publicationLock); // Only the exact disposable fixture's retained owner.
      // A noncooperating writer can still appear during copy. Recheck the
      // catalog at the actual visibility boundary as well as holding the lock.
      writeFileSync(raceHook, `
const fs = require('node:fs'), path = require('node:path');
const copy = fs.copyFileSync; let changed = false;
fs.copyFileSync = (source, target, ...rest) => {
  if (!changed && String(target).includes('.chat42-preparing-private-out-')) {
    changed = true;
    fs.mkdirSync(path.join(process.cwd(), '.test_tmp',
      'chat42-private-out-00000000-0000-0000-0000-00000000003e'));
  }
  return copy(source, target, ...rest);
};
require('node:module').syncBuiltinESMExports();
`);
      const foreignCapacity = spawnSync(process.execPath, ['--require', raceHook, local,
        '--qualify-build', '--confirm-reproducible', '--prepare-private-out', '--json'],
        { cwd: root, encoding: 'utf8', timeout: 12000 });
      expect(foreignCapacity.status, foreignCapacity.stderr).toBe(1);
      expect(JSON.parse(foreignCapacity.stdout)).toMatchObject({
        failures: expect.arrayContaining(['private-output-generation-cap-reached']),
        privateOutput: { published: false, existingGenerationCount: 64, publicationLockState: 'released' }
      });
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-'))).toHaveLength(64);
      expect(existsSync(publicationLock)).toBe(false);
      expectHist();

      rmdirSync(path.join(root, '.test_tmp',
        'chat42-private-out-00000000-0000-0000-0000-00000000003e'));
      // Publication remains a durable fact if releasing its exact mutex fails.
      // That is NOT a successful operation: callers must stop rather than
      // credit publication readiness or continue under unresolved ownership.
      writeFileSync(raceHook, `
const fs = require('node:fs'), path = require('node:path');
const remove = fs.rmdirSync;
const lock = path.join(process.cwd(), '.test_tmp', '.chat42-private-output-publication');
fs.rmdirSync = (target, ...rest) => {
  if (String(target) === lock) throw Object.assign(new Error('fixture release refusal'), { code: 'EACCES' });
  return remove(target, ...rest);
};
require('node:module').syncBuiltinESMExports();
`);
      const retainedAfterPublication = spawnSync(process.execPath, ['--require', raceHook, local,
        '--qualify-build', '--confirm-reproducible', '--prepare-private-out', '--json'],
        { cwd: root, encoding: 'utf8', timeout: 12000 });
      expect(retainedAfterPublication.status, retainedAfterPublication.stderr).toBe(1);
      const retainedPublication = JSON.parse(retainedAfterPublication.stdout);
      expect(retainedPublication).toMatchObject({
        accepted: false, sourceBuildQualified: true, reproducible: true,
        failures: expect.arrayContaining(['private-output-publication-owner-unverified']),
        privateOutput: { published: true, publicationLockState: 'retained',
          historyPreserved: true, sharedOutModified: false }
      });
      expect(existsSync(path.join(retainedPublication.privateOutput.path, 'evidence.json'))).toBe(true);
      expect(existsSync(publicationLock)).toBe(true);
      const retainedCatalog = readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort();
      expect(retainedCatalog).toHaveLength(64);
      const refusesRetainedOwner = run();
      expect(refusesRetainedOwner.status, refusesRetainedOwner.stderr).toBe(1);
      expect(JSON.parse(refusesRetainedOwner.stdout)).toMatchObject({
        execution: { spawned: false }, privateOutput: { published: false },
        failures: expect.arrayContaining(['private-output-publication-owner-unverified'])
      });
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-')).sort()).toEqual(retainedCatalog);
      expectHist();

      rmdirSync(publicationLock); // Exact empty mutex deliberately retained by this disposable fixture.
      rmdirSync(path.join(root, '.test_tmp',
        'chat42-private-out-00000000-0000-0000-0000-00000000003d')); // Empty fixture capacity slot only.
      writeFileSync(raceHook, `
const fs = require('node:fs'), path = require('node:path');
const copy = fs.copyFileSync; let changed = false;
fs.copyFileSync = (source, target, ...rest) => {
  if (!changed && String(target).includes('.chat42-preparing-private-out-')) {
    changed = true;
    const lock = path.join(process.cwd(), '.test_tmp', '.chat42-private-output-publication');
    fs.renameSync(lock, lock + '-retired');
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'foreign-owner'), 'replacement retained');
  }
  return copy(source, target, ...rest);
};
require('node:module').syncBuiltinESMExports();
`);
      const replaced = spawnSync(process.execPath, ['--require', raceHook, local,
        '--qualify-build', '--confirm-reproducible', '--prepare-private-out', '--json'],
        { cwd: root, encoding: 'utf8', timeout: 12000 });
      expect(replaced.status, replaced.stderr).toBe(1);
      expect(JSON.parse(replaced.stdout)).toMatchObject({
        failures: expect.arrayContaining(['private-output-publication-owner-unverified']),
        privateOutput: { published: false, publicationLockState: 'retained' }
      });
      expect(readFileSync(path.join(publicationLock, 'foreign-owner'), 'utf8')).toBe('replacement retained');
      expect(existsSync(publicationLock + '-retired')).toBe(true);
      expect(readdirSync(path.join(root, '.test_tmp'))
        .filter(name => name.startsWith('chat42-private-out-'))).toHaveLength(63);
      expectHist();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it('adds machine-readable handoff guidance to build qualification failures without claiming runtime proof', () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-handoff-report-'));
    const local = path.join(root, 'scripts', 'dev-fast.mjs');
    try {
      mkdirSync(path.dirname(local), { recursive: true });
      mkdirSync(path.join(root, 'node_modules', 'electron-vite', 'bin'), { recursive: true });
      mkdirSync(path.join(root, '.test_tmp'));
      mkdirSync(path.join(root, 'src', 'main'), { recursive: true });
      mkdirSync(path.join(root, 'src', 'renderer'), { recursive: true });
      mkdirSync(path.join(root, 'src', 'preload'), { recursive: true });
      copyFileSync(script, local);
      for (const entry of ['electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'])
        writeFileSync(path.join(root, entry), entry);
      writeFileSync(path.join(root, 'src', 'main', 'index.ts'), 'main');
      writeFileSync(path.join(root, 'src', 'renderer', 'index.html'), '<html></html>');
      writeFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'preload');
      writeFileSync(path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
        "const fs=require('node:fs'); const stage=process.argv[process.argv.indexOf('--outDir')+1]; fs.mkdirSync(stage,{recursive:true}); fs.writeFileSync(stage+'/main/index.js','main'); process.exit(47);");
      const result = spawnSync(process.execPath, [local, '--qualify-build', '--json'], {
        cwd: root, encoding: 'utf8', timeout: 15000
      });
      const proof = JSON.parse(result.stdout);
      expect(result.status).toBe(1);
      expect(proof.validationRunId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(typeof proof.validationStartedAt).toBe('string');
      expect(typeof proof.validationCompletedAt).toBe('string');
      expect(Date.parse(proof.validationCompletedAt)).toBeGreaterThanOrEqual(Date.parse(proof.validationStartedAt));
      expect(proof.nativeRuntimeVerified).toBe(false);
      expect(proof.evidenceStatus).toBe('diagnostic-only');
      expect(proof.invocation).toEqual({
        entrypoint: '--qualify-build',
        requestedMode: 'build-qualification',
        commandFamily: 'electron-vite-build',
        reproducibilityRequested: false
      });
      expect(proof.execution.commandFamily).toBe('electron-vite-build');
      expect(proof.execution.spawned).toBe(true);
      expect(proof.execution.arguments).toEqual(['build', '--outDir', '<generated-private-stage>']);
      expect(proof.execution.result).toMatchObject({
        exitCode: 1,
        signal: null,
        spawnError: false
      });
      expect(proof.failureClassification).toBe('command');
      expect(proof.handoff.checked).toBe('source-build-qualification');
      expect(proof.handoff.proven).toEqual([]);
      expect(proof.handoff.notProven).toContain('native-runtime-execution');
      expect(proof.handoff.next).toContain('inspect-staged-build-failure-before-runtime-qualification');
      expect(proof.handoff.next).toContain('create-or-restore-existing-build-output-before-qualification');
      expect(proof.handoff.retrySafe).toBe('retry-after-listed-correction-and-fresh-validation');
      expect(proof.handoff.missingEvidence).toContain('successful-repeatable-build-command-result');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies a stalled build attempt with timeout evidence instead of an ambiguous hang', () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-build-timeout-'));
    const local = path.join(root, 'scripts', 'dev-fast.mjs');
    try {
      mkdirSync(path.dirname(local), { recursive: true });
      mkdirSync(path.join(root, 'node_modules', 'electron-vite', 'bin'), { recursive: true });
      mkdirSync(path.join(root, '.test_tmp'));
      mkdirSync(path.join(root, 'src', 'main'), { recursive: true });
      mkdirSync(path.join(root, 'src', 'renderer'), { recursive: true });
      mkdirSync(path.join(root, 'src', 'preload'), { recursive: true });
      copyFileSync(script, local);
      for (const entry of ['electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'])
        writeFileSync(path.join(root, entry), entry);
      writeFileSync(path.join(root, 'src', 'main', 'index.ts'), 'main');
      writeFileSync(path.join(root, 'src', 'renderer', 'index.html'), '<html></html>');
      writeFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'preload');
      writeFileSync(path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
        "setTimeout(() => {}, 60000);");
      const result = spawnSync(process.execPath, [local, '--qualify-build', '--json'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, COS_DEV_FAST_BUILD_TIMEOUT_MS: '50' }
      });
      const proof = JSON.parse(result.stdout);
      expect(result.status).toBe(1);
      expect(proof.execution.result.timedOut).toBe(true);
      expect(proof.execution.result.durationMs).toBeGreaterThanOrEqual(0);
      expect(proof.execution.result.compilerOutput).toMatchObject({ diagnosticCodes: [],
        stdoutBytes: 0, stderrBytes: 0, omittedBytes: 0 });
      expect(proof.failures).toContain('staged-compiler-timeout');
      expect(proof.failureClassification).toBe('command');
      expect(proof.handoff.next).toContain('inspect-staged-build-failure-before-runtime-qualification');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('distinguishes a timed-out confirmation compiler from an ordinary failed second build', () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-confirmation-timeout-'));
    const local = path.join(root, 'scripts', 'dev-fast.mjs');
    const marker = path.join(root, '.test_tmp', 'first-build-finished');
    try {
      mkdirSync(path.dirname(local), { recursive: true });
      mkdirSync(path.join(root, 'node_modules', 'electron-vite', 'bin'), { recursive: true });
      mkdirSync(path.join(root, '.test_tmp'));
      for (const area of ['main', 'preload', 'renderer'])
        mkdirSync(path.join(root, 'src', area), { recursive: true });
      copyFileSync(script, local);
      for (const name of ['electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'])
        writeFileSync(path.join(root, name), name);
      writeFileSync(path.join(root, 'src', 'main', 'index.ts'), 'main');
      writeFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'preload');
      writeFileSync(path.join(root, 'src', 'renderer', 'index.html'), '<html></html>');
      writeFileSync(path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), `
const fs = require('node:fs');
const path = require('node:path');
const marker = path.join(process.cwd(), '.test_tmp', 'first-build-finished');
if (fs.existsSync(marker)) {
  if (process.env.COS_TEST_CONFIRM_MODE === 'timeout') setTimeout(() => {}, 60000);
  else process.exit(47);
} else {
  fs.writeFileSync(marker, 'complete');
  const stage = process.argv[process.argv.indexOf('--outDir') + 1];
  for (const name of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
    const target = path.join(stage, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, name);
  }
}
`);
      const run = (mode: string) => {
        const result = spawnSync(process.execPath,
          [local, '--qualify-build', '--confirm-reproducible', '--json'], {
          cwd: root, encoding: 'utf8', timeout: 12000,
          env: { ...process.env, COS_TEST_CONFIRM_MODE: mode, COS_DEV_FAST_BUILD_TIMEOUT_MS: '1500' }
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status).toBe(1);
        return JSON.parse(result.stdout);
      };
      const timeout = run('timeout');
      expect(timeout.execution.result.timedOut).toBe(false);
      expect(timeout.confirmationExecution.timedOut).toBe(true);
      expect(timeout.confirmationExecution.durationMs).toBeGreaterThanOrEqual(0);
      expect(timeout.confirmationExecution.compilerOutput.diagnosticCodes).toEqual([]);
      expect(timeout.failures).toContain('confirmation-compiler-timeout');
      expect(timeout.failureClassification).toBe('command');
      expect(timeout.handoff.next).toContain('inspect-confirmation-build-timeout-before-runtime-qualification');
      expect(timeout.handoff.missingEvidence).toContain('successful-repeatable-build-command-result');
      expect(timeout.accepted).toBe(false);
      expect(timeout.nativeRuntimeVerified).toBe(false);

      rmSync(marker);
      const ordinaryFailure = run('fail');
      expect(ordinaryFailure.confirmationExecution.timedOut).toBe(false);
      expect(ordinaryFailure.failures).toContain('confirmation-compiler-failed-or-interrupted');
      expect(ordinaryFailure.failures).not.toContain('confirmation-compiler-timeout');
      expect(ordinaryFailure.handoff.next).toContain('inspect-staged-build-failure-before-runtime-qualification');
      expect(ordinaryFailure.accepted).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it('bounds inherited compiler output pipes and refuses unverified build or confirmation custody', () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-inherited-compiler-pipes-'));
    const local = path.join(root, 'scripts', 'dev-fast.mjs');
    const builder = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const intercept = path.join(root, 'fake-compiler-process.cjs');
    try {
      mkdirSync(path.dirname(local), { recursive: true });
      mkdirSync(path.dirname(builder), { recursive: true });
      mkdirSync(path.join(root, '.test_tmp'));
      for (const area of ['main', 'preload', 'renderer']) {
        mkdirSync(path.join(root, 'src', area), { recursive: true });
      }
      copyFileSync(script, local);
      for (const name of ['electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'])
        writeFileSync(path.join(root, name), name === 'package.json' ? '{"type":"commonjs"}' : name);
      for (const area of ['main', 'preload', 'renderer'])
        writeFileSync(path.join(root, 'src', area, area === 'renderer' ? 'index.html' : 'index.ts'), area);
      for (const name of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
        const target = path.join(root, 'out', name);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, name);
      }
      writeFileSync(builder, '// Fixture compiler identity; the injected child simulates process events.\n');
      writeFileSync(intercept, `
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { syncBuiltinESMExports } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const mode = process.env.COS_TEST_CHILD_HOLD;
let pass = 0;
cp.spawn = (_executable, args) => {
  const stage = args[args.indexOf('--outDir') + 1];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  for (const name of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
    const file = path.join(stage, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name);
  }
  const second = ++pass === 2;
  const explicitCancel = mode === 'cancel-first' || mode === 'cancel-term-first' ||
    (mode === 'cancel-confirmation' && second);
  const stuckPipes = mode === 'first' || (mode === 'confirmation' && second) ||
    mode === 'timeout' || mode === 'unkillable';
  child.kill = signal => {
    child.killed = true;
    if (mode !== 'unkillable') {
      const reportExit = () => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
        if (explicitCancel) {
          child.stdout.end();
          child.stderr.end();
          process.nextTick(() => child.emit('close', null, signal));
        }
      };
      if (explicitCancel) setTimeout(reportExit, 170);
      else process.nextTick(reportExit);
    }
    return true;
  };
  process.nextTick(() => {
    if (mode === 'timeout' || mode === 'unkillable') return;
    if (explicitCancel) {
      setTimeout(() => process.emit(mode === 'cancel-term-first' ? 'SIGTERM' : 'SIGINT'), 10);
      return;
    }
    if (mode === 'noisy') {
      const privateStdout = Buffer.from('PRIVATE_COMPILER_DATA_' + 'x'.repeat(107));
      const privateStderr = Buffer.from('PRIVATE_ERROR_DATA_' + 'y'.repeat(45));
      for (let i = 0; i < 16000; i++) {
        child.stdout.emit('data', privateStdout);
        child.stderr.emit('data', privateStderr);
      }
      child.stderr.emit('data', Buffer.from('\\nTS2307 ERR_MODULE_NOT_FOUND\\n'));
    }
    const exitCode = mode === 'noisy' ? 47 : 0;
    child.exitCode = exitCode;
    child.emit('exit', exitCode, null);
    if (!stuckPipes) {
      child.stdout.end();
      child.stderr.end();
      process.nextTick(() => child.emit('close', exitCode, null));
    }
  });
  return child;
};
syncBuiltinESMExports();
`);
      const run = (mode: string, confirmation = false, privateOut = false) => {
        const start = Date.now();
        const p = spawnSync(process.execPath, ['--require', intercept, local, '--qualify-build', '--json',
          ...(confirmation ? ['--confirm-reproducible'] : []),
          ...(privateOut ? ['--prepare-private-out'] : [])], {
          cwd: root, encoding: 'utf8', timeout: 9000,
          env: { ...process.env, COS_TEST_CHILD_HOLD: mode,
            COS_DEV_FAST_BUILD_TIMEOUT_MS: ['timeout', 'unkillable'].includes(mode) ? '100' :
              mode.startsWith('cancel-') ? '80' : '7000' }
        });
        expect(p.error, p.stderr).toBeUndefined();
        expect(p.stdout, `launcher status ${p.status}: ${p.stderr}`).not.toBe('');
        return { status: p.status, proof: JSON.parse(p.stdout), elapsedMs: Date.now() - start };
      };
      const exited = run('first');
      expect(exited.status).toBe(1);
      expect(exited.elapsedMs).toBeLessThan(2500);
      expect(exited.proof.execution.result).toMatchObject({
        exitCode: 0, processExitObserved: true, outputPipesSettled: false, timedOut: false
      });
      expect(exited.proof.failures).toContain('compiler-output-pipes-unsettled');
      expect(exited.proof.failureClassification).toBe('ownership');
      expect(exited.proof.handoff.next)
        .toContain('inspect-compiler-process-and-output-custody-before-requalification');
      expect(exited.proof.handoff.missingEvidence).toContain('settled-compiler-output-custody');
      expect(exited.proof.accepted).toBe(false);

      const confirmation = run('confirmation', true);
      expect(confirmation.status).toBe(1);
      expect(confirmation.elapsedMs).toBeLessThan(2500);
      expect(confirmation.proof.execution.result.outputPipesSettled).toBe(true);
      expect(confirmation.proof.confirmationExecution).toMatchObject({
        exitCode: 0, processExitObserved: true, outputPipesSettled: false, timedOut: false
      });
      expect(confirmation.proof.failures).toContain('confirmation-output-pipes-unsettled');
      expect(confirmation.proof.reproducible).toBeNull();
      expect(confirmation.proof.accepted).toBe(false);

      const timed = run('timeout');
      expect(timed.status).toBe(1);
      expect(timed.elapsedMs).toBeLessThan(2500);
      expect(timed.proof.execution.result).toMatchObject({ timedOut: true,
        processExitObserved: true, outputPipesSettled: false });
      expect(timed.proof.failures).toContain('staged-compiler-timeout');
      expect(timed.proof.failures).toContain('compiler-output-pipes-unsettled');

      const unkillable = run('unkillable');
      expect(unkillable.status).toBe(1);
      expect(unkillable.elapsedMs).toBeLessThan(2500);
      expect(unkillable.proof.execution.result).toMatchObject({ timedOut: true,
        processExitObserved: false, outputPipesSettled: false });
      expect(unkillable.proof.failures).toContain('compiler-process-exit-unverified');
      expect(unkillable.proof.handoff.missingEvidence).toContain('observed-compiler-process-exit');

      const noisy = run('noisy');
      if (process.env.COS_DEV_FAST_PERF_DIAG === '1') {
        console.log('CHAT42_COMPILER_SAMPLE_MS=' + noisy.proof.execution.result.durationMs);
      }

      const cancelled = run('cancel-first');
      expect(cancelled.status).toBe(1);
      expect(cancelled.proof.execution.result).toMatchObject({
        timedOut: false, cancellationSignal: 'SIGINT', processExitObserved: true,
        outputPipesSettled: true
      });
      expect(cancelled.proof.failures).toContain('staged-compiler-cancelled');
      expect(cancelled.proof.failures).not.toContain('staged-compiler-timeout');
      expect(cancelled.proof.handoff.next)
        .toContain('inspect-cancelled-build-custody-before-requalification');
      expect(cancelled.proof.handoff.missingEvidence).toContain('cancelled-compiler-process-tree-cleared');
      expect(cancelled.proof.accepted).toBe(false);

      const cancelledPrivate = run('cancel-first', true, true);
      expect(cancelledPrivate.status).toBe(1);
      expect(cancelledPrivate.proof.privateOutput).toMatchObject({ requested: true, published: false });
      expect(cancelledPrivate.proof.failures).toContain('staged-compiler-cancelled');
      expect(cancelledPrivate.proof.failures).not.toContain('staged-compiler-timeout');
      expect(readdirSync(path.join(root, '.test_tmp'))
        .some(name => name.startsWith('chat42-private-out-'))).toBe(false);

      const cancelledTerm = run('cancel-term-first');
      expect(cancelledTerm.status).toBe(1);
      expect(cancelledTerm.proof.execution.result).toMatchObject({
        timedOut: false, cancellationSignal: 'SIGTERM', processExitObserved: true,
        outputPipesSettled: true
      });
      expect(cancelledTerm.proof.failures).toContain('staged-compiler-cancelled');
      expect(cancelledTerm.proof.failures).not.toContain('staged-compiler-timeout');

      const cancelledConfirmation = run('cancel-confirmation', true);
      expect(cancelledConfirmation.status).toBe(1);
      expect(cancelledConfirmation.proof.execution.result).toMatchObject({
        timedOut: false, cancellationSignal: null, outputPipesSettled: true
      });
      expect(cancelledConfirmation.proof.confirmationExecution).toMatchObject({
        timedOut: false, cancellationSignal: 'SIGINT', processExitObserved: true,
        outputPipesSettled: true
      });
      expect(cancelledConfirmation.proof.failures).toContain('confirmation-compiler-cancelled');
      expect(cancelledConfirmation.proof.failures).not.toContain('confirmation-compiler-timeout');
      expect(cancelledConfirmation.proof.reproducible).toBeNull();
      expect(cancelledConfirmation.proof.accepted).toBe(false);

      expect(noisy.status).toBe(1);
      expect(noisy.proof.execution.result).toMatchObject({
        exitCode: 47, processExitObserved: true, outputPipesSettled: true,
        compilerOutput: {
          stdoutBytes: 16000 * 129,
          stderrBytes: 16000 * 64 + Buffer.byteLength('\nTS2307 ERR_MODULE_NOT_FOUND\n'),
          diagnosticCodes: ['TS2307', 'ERR_MODULE_NOT_FOUND'],
          omittedBytes: expect.any(Number)
        }
      });
      expect(noisy.proof.execution.result.compilerOutput.omittedBytes).toBeGreaterThan(1000000);
      expect(noisy.proof.handoff.next)
        .toContain('inspect-compiler-module-resolution-before-runtime-qualification');
      expect(JSON.stringify(noisy.proof)).not.toContain('PRIVATE_COMPILER_DATA');
      expect(readFileSync(path.join(root, 'out', 'preload', 'index.js'), 'utf8')).toBe('preload/index.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it('reports bounded compiler failure fingerprints per stage without leaking private output or starting on invalid timeouts', () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-compiler-receipts-'));
    const local = path.join(root, 'scripts', 'dev-fast.mjs');
    const marker = path.join(root, '.test_tmp', 'first-stage-complete');
    try {
      mkdirSync(path.dirname(local), { recursive: true });
      mkdirSync(path.join(root, 'node_modules', 'electron-vite', 'bin'), { recursive: true });
      mkdirSync(path.join(root, '.test_tmp'));
      for (const area of ['main', 'preload', 'renderer'])
        mkdirSync(path.join(root, 'src', area), { recursive: true });
      copyFileSync(script, local);
      for (const name of ['electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'])
        writeFileSync(path.join(root, name), name);
      for (const area of ['main', 'preload', 'renderer'])
        writeFileSync(path.join(root, 'src', area, area === 'renderer' ? 'index.html' : 'index.ts'), area);
      writeFileSync(path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), `
const fs = require('node:fs');
const path = require('node:path');
const marker = path.join(process.cwd(), '.test_tmp', 'first-stage-complete');
const second = fs.existsSync(marker);
const mode = process.env.COS_TEST_STAGE_MODE;
if (mode === 'first-error' || (second && mode === 'second-error')) {
  process.stdout.write('PRIVATE_DRAFT_NEVER_EXPORT');
  process.stderr.write('PRIVATE_ACCESS_TOKEN_NEVER_EXPORT' + '.'.repeat(150000));
  process.stderr.write('\\nTS2307: fake local path PRIVATE_FILE_NEVER_EXPORT\\nERR_MODULE_NOT_FOUND\\n');
  process.exit(47);
}
fs.writeFileSync(marker, 'first-stage-ok');
const stage = process.argv[process.argv.indexOf('--outDir') + 1];
for (const name of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  const target = path.join(stage, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, name);
}
`);
      const run = (mode: string, timeout = '3000') => {
        const p = spawnSync(process.execPath, [local, '--qualify-build', '--confirm-reproducible', '--json'], {
          cwd: root, encoding: 'utf8', timeout: 12000,
          env: { ...process.env, COS_TEST_STAGE_MODE: mode, COS_DEV_FAST_BUILD_TIMEOUT_MS: timeout }
        });
        expect(p.error, p.stderr).toBeUndefined();
        return { status: p.status, proof: JSON.parse(p.stdout), raw: p.stdout };
      };
      for (const timeout of ['not-a-duration', '0', '-1', '1.5', '3600001']) {
        const invalid = run('first-error', timeout);
        expect(invalid.status).toBe(1);
        expect(invalid.proof.failures).toContain('invalid-build-timeout-config');
        expect(invalid.proof.failureClassification).toBe('environment');
        expect(invalid.proof.execution.spawned).toBe(false);
        expect(invalid.proof.handoff.next).toContain('set-valid-build-timeout-before-requalification');
        expect(invalid.proof.handoff.missingEvidence).toContain('valid-build-timeout-config');
        expect(existsSync(marker)).toBe(false);
      }

      const first = run('first-error');
      expect(first.status).toBe(1);
      expect(first.proof.execution.result.durationMs).toBeGreaterThanOrEqual(0);
      expect(first.proof.execution.result.compilerOutput).toMatchObject({
        diagnosticCodes: ['TS2307', 'ERR_MODULE_NOT_FOUND'],
        omittedBytes: expect.any(Number)
      });
      expect(first.proof.execution.result.compilerOutput.omittedBytes).toBeGreaterThan(0);
      expect(first.proof.handoff.next).toContain('inspect-compiler-module-resolution-before-runtime-qualification');
      expect(first.raw).not.toContain('PRIVATE_');
      expect(existsSync(marker)).toBe(false);

      const confirmation = run('second-error');
      expect(confirmation.status).toBe(1);
      expect(confirmation.proof.execution.result.compilerOutput.diagnosticCodes).toEqual([]);
      expect(confirmation.proof.confirmationExecution.compilerOutput.diagnosticCodes)
        .toEqual(['TS2307', 'ERR_MODULE_NOT_FOUND']);
      expect(confirmation.proof.confirmationExecution.durationMs).toBeGreaterThanOrEqual(0);
      expect(confirmation.proof.failures).toContain('confirmation-compiler-failed-or-interrupted');
      expect(confirmation.proof.accepted).toBe(false);
      expect(confirmation.raw).not.toContain('PRIVATE_');
      expect(confirmation.raw.length).toBeLessThan(15000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it('binds live-probe fixture scope to its renamed checkout and refuses a foreign scratch owner', () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'portable-live-probe-'));
    const probe = path.join(root, 'test', 'dev-fast-live-probe.cjs');
    const fixture = path.join(root, '.test_tmp', 'fixture');
    const intercept = path.join(root, 'reject-endpoint.cjs');
    try {
      mkdirSync(path.dirname(probe), { recursive: true });
      copyFileSync(liveProbe, probe);
      mkdirSync(path.join(fixture, '.git'), { recursive: true });
      mkdirSync(path.join(fixture, 'src', 'renderer'), { recursive: true });
      writeFileSync(path.join(fixture, 'src', 'renderer', 'styles.css'), 'body {}');
      writeFileSync(path.join(fixture, 'src', 'renderer', 'index.html'), '<html></html>');
      writeFileSync(intercept, "globalThis.fetch = async () => { throw Error('test endpoint unavailable'); };\n");
      const invoke = (target: string) => spawnSync(process.execPath, ['--require', intercept, probe,
        '--run', '--fixture', target, '--css-sha256', createHash('sha256').update('body {}').digest('hex'),
        '--html-sha256', createHash('sha256').update('<html></html>').digest('hex')],
        { encoding: 'utf8', timeout: 8000 });
      const own = invoke(fixture);
      expect(own.status, own.stderr).toBe(2);
      expect(own.stderr).toContain('LIVE_PROBE_REFUSED');
      expect(own.stderr).not.toContain('PREFLIGHT_FAILED');
      const foreign = invoke(project);
      expect(foreign.status, foreign.stderr).toBe(2);
      expect(foreign.stderr).toContain('fixture must be a distinct checkout');
      expect(readFileSync(path.join(fixture, 'src', 'renderer', 'styles.css'), 'utf8')).toBe('body {}');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('qualifies only reproducible compiled bytes and rejects missing, inconsistent, incomplete and interrupted builds', () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-build-regression-'));
    const local = path.join(root, 'scripts', 'dev-fast.mjs');
    const builder = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const original = path.join(root, 'out');
    const preload = path.join(root, 'src', 'preload', 'index.ts');
    try {
      mkdirSync(path.dirname(local), { recursive: true });
      mkdirSync(path.dirname(builder), { recursive: true });
      mkdirSync(path.dirname(preload), { recursive: true });
      mkdirSync(path.join(root, 'src', 'main'), { recursive: true });
      mkdirSync(path.join(root, 'src', 'renderer'), { recursive: true });
      mkdirSync(path.join(root, '.test_tmp'));
      copyFileSync(script, local);
      for (const entry of ['electron.vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json']) {
        writeFileSync(path.join(root, entry), 'fixture config: ' + entry);
      }
      writeFileSync(path.join(root, 'src', 'main', 'index.ts'), 'main-A');
      writeFileSync(path.join(root, 'src', 'renderer', 'index.html'), '<main>fixture-A</main>');
      writeFileSync(preload, 'preload-A');
      writeFileSync(builder, `
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const stage = process.argv[process.argv.indexOf('--outDir') + 1];
const behavior = process.env.COS_TEST_BUILDER_BEHAVIOR;
const firstStageMarker = path.join(root, '.test_tmp', 'first-compiled-stage.txt');
const write = (name, value) => {
  const file = path.join(stage, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};
if (behavior === 'fail') {
  write('preload/index.js', 'partial');
  process.exit(47);
}
if (behavior === 'rewrite-and-fail') {
  fs.writeFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'foreign-concurrent-failed-build');
  process.stderr.write('TS2307: synthetic source drift during failure');
  process.exit(47);
}
if (behavior === 'terminate') {
  write('preload/index.js', 'partial');
  process.kill(process.pid, 'SIGTERM');
}
if (behavior === 'rewrite-on-confirmation') {
  const marker = path.join(root, '.test_tmp', 'confirmation-source-marker');
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, stage);
  else fs.writeFileSync(path.join(root, 'src', 'renderer', 'index.html'),
    '<main>second-compiler-observed-a-new-foreign-source-epoch</main>');
}
const source = (name) => fs.readFileSync(path.join(root, 'src', name), 'utf8');
write('main/index.js', '/* ' + source('main/index.ts') + ' */');
write('preload/index.js', '/* ' + source('preload/index.ts') + ' */');
if (behavior !== 'partial') write('renderer/index.html', source('renderer/index.html'));
if (behavior === 'volatile') write('renderer/assets/runtime.css', path.basename(stage));
if (behavior === 'rewrite') fs.writeFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'foreign-during-build');
if (behavior === 'rewrite-output') fs.appendFileSync(path.join(root, 'out', 'preload', 'index.js'), 'foreign-concurrent-output');
if (behavior === 'rewrite-compiler') fs.appendFileSync(__filename, String.fromCharCode(10) + '/* compiler-mutated-during-build */');
if (behavior === 'tamper-first-stage') {
  if (!fs.existsSync(firstStageMarker)) fs.writeFileSync(firstStageMarker, stage);
  else {
    const earlier = fs.readFileSync(firstStageMarker, 'utf8');
    fs.appendFileSync(path.join(earlier, 'preload', 'index.js'), 'foreign-stage-write');
  }
}
`);
      const compilerBytes = readFileSync(builder);
      const run = (behavior = '', confirm = false) => {
        const p = spawnSync(process.execPath,
          [local, '--qualify-build', '--json', ...(confirm ? ['--confirm-reproducible'] : [])], {
          cwd: root, encoding: 'utf8', timeout: 18000,
          env: { ...process.env, COS_TEST_BUILDER_BEHAVIOR: behavior }
        });
        expect(p.error, p.stderr).toBeUndefined();
        const proof = JSON.parse(p.stdout);
        expect(proof.nativeRuntimeVerified).toBe(false);
        expect(proof.installedRuntimeVerified).toBe(false);
        return { status: p.status, proof };
      };
      const empty = run();
      expect(empty.status).toBe(1);
      expect(empty.proof).toMatchObject({ accepted: false, sourceBuildQualified: true,
        existingBuildQualified: false, failures: ['existing-output-missing'] });
      expect(empty.proof.handoff.next).toContain(
        'create-or-restore-existing-build-output-before-qualification');
      cpSync(empty.proof.stage, original, { recursive: true });
      const baseline = readFileSync(path.join(original, 'preload', 'index.js'));
      const matching = run('', true);
      expect(matching.status).toBe(0);
      expect(matching.proof).toMatchObject({ accepted: true, sourceBuildQualified: true,
        existingBuildQualified: true, failures: [], reproducibilityRequested: true,
        reproducible: true, confirmationSha256: matching.proof.compiledOutputSha256 });
      expect(matching.proof.handoff.next).toContain('continue-with-separate-native-or-installed-qualification');
      expect(matching.proof.validationRunId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(matching.proof.toolchain).toMatchObject({
        nodeVersion: process.version,
        electronViteCliSha256: createHash('sha256').update(compilerBytes).digest('hex').toUpperCase()
      });
      const selectStage = (stage = matching.proof.stage, source = matching.proof.sourceSha256,
        compiled = matching.proof.compiledOutputSha256, compiler = matching.proof.toolchain.electronViteCliSha256) => {
        const selected = spawnSync(process.execPath, [local, '--qualify-build', '--json',
          '--select-stage=' + path.basename(stage), '--expect-source-sha256=' + source,
          '--expect-compiled-sha256=' + compiled, '--expect-compiler-sha256=' + compiler], {
          cwd: root, encoding: 'utf8', timeout: 18000
        });
        expect(selected.error).toBeUndefined();
        return { status: selected.status, proof: JSON.parse(selected.stdout) };
      };
      const selectedGood = selectStage();
      expect(selectedGood.status).toBe(0);
      expect(selectedGood.proof).toMatchObject({ mode: 'exact-staged-artifact-selection',
        accepted: false, sourceBuildQualified: true, existingBuildQualified: false,
        stageSelectedForReview: true, nativeRuntimeVerified: false, installedRuntimeVerified: false });
      expect(typeof selectedGood.proof.validationCompletedAt).toBe('string');
      expect(Date.parse(selectedGood.proof.validationCompletedAt))
        .toBeGreaterThanOrEqual(Date.parse(selectedGood.proof.validationStartedAt));
      const selectionWithInvalidBuildDeadline = spawnSync(process.execPath,
        [local, '--qualify-build', '--json',
          '--select-stage=' + path.basename(matching.proof.stage),
          '--expect-source-sha256=' + matching.proof.sourceSha256,
          '--expect-compiled-sha256=' + matching.proof.compiledOutputSha256,
          '--expect-compiler-sha256=' + matching.proof.toolchain.electronViteCliSha256], {
          cwd: root, encoding: 'utf8', timeout: 18000,
          env: { ...process.env, COS_DEV_FAST_BUILD_TIMEOUT_MS: 'not-a-duration' }
        });
      expect(selectionWithInvalidBuildDeadline.status).toBe(0);
      expect(JSON.parse(selectionWithInvalidBuildDeadline.stdout).stageSelectedForReview).toBe(true);
      const qualifiedPreload = path.join(matching.proof.stage, 'preload', 'index.js');
      const qualifiedBytes = readFileSync(qualifiedPreload);
      writeFileSync(qualifiedPreload, 'foreign-mixed-generation');
      const selectedTampered = selectStage();
      expect(selectedTampered.status).toBe(1);
      expect(selectedTampered.proof.failures).toContain('selected-compiled-output-mismatch');
      expect(selectedTampered.proof.failureClassification).toBe('ownership');
      expect(selectedTampered.proof.handoff.next).toContain(
        'reselect-artifact-with-current-input-identity-before-qualification');
      writeFileSync(qualifiedPreload, qualifiedBytes);
      expect(selectStage().status).toBe(0);
      writeFileSync(preload, 'different-source-generation');
      const selectedWrongSource = selectStage();
      expect(selectedWrongSource.status).toBe(1);
      expect(selectedWrongSource.proof.failures).toContain('selected-source-mismatch');
      writeFileSync(preload, 'preload-A');
      expect(selectStage().status).toBe(0);
      const selectedWrongCompiler = selectStage(matching.proof.stage,
        matching.proof.sourceSha256, matching.proof.compiledOutputSha256, '0'.repeat(64));
      expect(selectedWrongCompiler.status).toBe(1);
      expect(selectedWrongCompiler.proof.failures).toContain('selected-compiler-mismatch');
      const unsupportedMode = spawnSync(process.execPath,
        [local, '--select-stage=' + path.basename(matching.proof.stage)], {
          cwd: root, encoding: 'utf8', timeout: 18000
        });
      expect(unsupportedMode.status).toBe(1);
      expect(unsupportedMode.stderr).toContain('require --qualify-build');
      expect(readFileSync(path.join(original, 'preload', 'index.js'))).toEqual(baseline);
      const mutatedStage = run('tamper-first-stage', true);
      expect(mutatedStage.status).toBe(1);
      expect(mutatedStage.proof.accepted).toBe(false);
      expect(mutatedStage.proof.failures).toContain('staged-output-changed-during-confirmation');
      expect(mutatedStage.proof.failureClassification).toBe('ownership');
      expect(mutatedStage.proof.handoff.next).toContain('inspect-staged-output-ownership-before-requalification');
      expect(mutatedStage.proof.handoff.retrySafe).toBe('retry-after-input-stability-is-restored');
      expect(mutatedStage.proof.handoff.missingEvidence).toContain('stable-staged-output-identity');
      expect(readFileSync(path.join(original, 'preload', 'index.js'))).toEqual(baseline);
      writeFileSync(path.join(original, 'preload', 'index.js'), 'tampered');
      const mismatch = run();
      expect(mismatch.status).toBe(1);
      expect(mismatch.proof.failures).toContain('existing-output-content-mismatch');
      expect(mismatch.proof.failureClassification).toBe('validation');
      expect(mismatch.proof.sourceBuildQualified).toBe(true);
      expect(mismatch.proof.artifactDrift).toMatchObject({
        changeCount: 1, counts: { main: 0, preload: 1, renderer: 0, other: 0 },
        requiredSteps: ['preload-rebuild-new-document-and-runtime-restoration']
      });
      expect(mismatch.proof.artifactDrift.examples).toContainEqual({
        file: 'preload/index.js', kind: 'modified',
        originalSha256: createHash('sha256').update('tampered').digest('hex').toUpperCase(),
        stagedSha256: createHash('sha256').update(baseline).digest('hex').toUpperCase()
      });
      writeFileSync(path.join(original, 'preload', 'index.js'), baseline);
      const volatile = run('volatile', true);
      expect(volatile.status).toBe(1);
      expect(volatile.proof).toMatchObject({ accepted: false, sourceBuildQualified: false,
        reproducibilityRequested: true, reproducible: false,
        failures: ['nondeterministic-compiled-output'] });
      expect(volatile.proof.failureClassification).toBe('validation');
      expect(volatile.proof.artifactDrift.counts.renderer).toBe(1);
      expect(volatile.proof.artifactDrift.requiredSteps).toContain('renderer-reload-and-content-verification');
      expect(volatile.proof.reproducibilityDrift).toMatchObject({
        changeCount: 1, counts: { renderer: 1 } });
      expect(volatile.proof).not.toHaveProperty('sourceInputDrift');
      // Two clean compilers consumed DIFFERENT source epochs. This must be
      // diagnosed as foreign source ownership, not blamed on Vite randomness.
      const concurrentSource = run('rewrite-on-confirmation', true);
      expect(concurrentSource.status).toBe(1);
      expect(concurrentSource.proof).toMatchObject({
        sourceBuildQualified: false, reproducible: false,
        failureClassification: 'ownership',
        sourceInputDrift: {
          changeCount: 1, truncated: false,
          examples: [{ file: 'src/renderer/index.html',
            oldSha256: expect.stringMatching(/^[A-F0-9]{64}$/),
            newSha256: expect.stringMatching(/^[A-F0-9]{64}$/) }]
        },
        reproducibilityDrift: { counts: { renderer: 1 } },
        handoff: { retrySafe: 'retry-after-input-stability-is-restored' }
      });
      expect(concurrentSource.proof.failures).toContain('source-changed-during-confirmation');
      expect(concurrentSource.proof.failures).not.toContain('nondeterministic-compiled-output');
      expect(concurrentSource.proof.handoff.next).toContain('rerun-after-source-stabilizes');
      expect(concurrentSource.proof.privateOutput?.published).not.toBe(true);
      writeFileSync(path.join(root, 'src', 'renderer', 'index.html'), '<main>fixture-A</main>');
      const incomplete = run('partial');
      expect(incomplete.status).toBe(1);
      expect(incomplete.proof.failures).toContain('incomplete-compiled-output');
      const interrupted = run('fail');
      expect(interrupted.status).toBe(1);
      expect(interrupted.proof.failures).toContain('staged-compiler-failed-or-interrupted');
      if (process.platform === 'win32') {
        const killedCompiler = run('terminate');
        expect(killedCompiler.status).toBe(1);
        expect(killedCompiler.proof.failures).toContain('staged-compiler-failed-or-interrupted');
        expect(killedCompiler.proof.accepted).toBe(false);
        expect(readFileSync(path.join(original, 'preload', 'index.js'))).toEqual(baseline);
      }
      const mutatedCompiler = run('rewrite-compiler');
      expect(mutatedCompiler.status).toBe(1);
      expect(mutatedCompiler.proof.failures).toContain('compiler-changed-during-build');
      writeFileSync(builder, compilerBytes);
      const concurrentOutput = run('rewrite-output');
      expect(concurrentOutput.status).toBe(1);
      expect(concurrentOutput.proof.failures).toContain('existing-output-changed-during-build');
      expect(concurrentOutput.proof.failureClassification).toBe('ownership');
      expect(concurrentOutput.proof.handoff.retrySafe).toBe('retry-after-input-stability-is-restored');
      expect(concurrentOutput.proof.handoff.next).toContain('review-existing-output-drift-before-runtime-qualification');
      writeFileSync(path.join(original, 'preload', 'index.js'), baseline);
      const foreign = run('rewrite');
      expect(foreign.status).toBe(1);
      expect(foreign.proof.failures).toContain('source-changed-during-build');
      expect(foreign.proof.failureClassification).toBe('ownership');
      writeFileSync(preload, 'preload-A');
      const failedWithForeignWrite = run('rewrite-and-fail');
      expect(failedWithForeignWrite.status).toBe(1);
      expect(failedWithForeignWrite.proof.failures).toContain('staged-compiler-failed-or-interrupted');
      expect(failedWithForeignWrite.proof.failures).toContain('source-changed-during-build');
      expect(failedWithForeignWrite.proof.failureClassification).toBe('ownership');
      expect(failedWithForeignWrite.proof.handoff.next).toContain('rerun-after-source-stabilizes');
      expect(failedWithForeignWrite.proof.handoff.retrySafe)
        .toBe('retry-after-input-stability-is-restored');
      expect(failedWithForeignWrite.proof.accepted).toBe(false);
      writeFileSync(preload, 'preload-A');
      expect(readFileSync(path.join(original, 'preload', 'index.js'))).toEqual(baseline);
      const restored = run();
      expect(restored.status).toBe(0);
      expect(restored.proof.compiledOutputSha256).toBe(matching.proof.compiledOutputSha256);
    } finally {
      const absolute = path.resolve(root);
      expect(absolute.toLowerCase().startsWith(path.resolve(project, '.test_tmp').toLowerCase() + path.sep.toLowerCase())).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 50000);
  it('refuses to issue a native qualification receipt for partial positive observations or failed rollback', () => {
    const { qualifyLiveProof } = createRequire(import.meta.url)(liveProbe);
    const original = { css: true, html: true, preload: true };
    const provenance = { cssSourceSha256: 'a'.repeat(64), htmlSourceSha256: 'b'.repeat(64),
      preloadSourceSha256: 'c'.repeat(64), originalPreloadBuildSha256: 'd'.repeat(64),
      changedPreloadBuildSha256: 'e'.repeat(64) };
    const proof = {
      mode: 'watch-preload', preloadBuildChanged: true,
      preloadBuiltContainsUniqueApi: true, preloadBuiltSha256: 'e'.repeat(64),
      preloadAppliedToRenderer: true, preloadBuildRestored: true,
      preloadRendererRestored: true, finalRendererConnectionVerified: true
    };
    const completed = qualifyLiveProof({ stage: 'verified', exitCode: 0,
      evidence: proof, sourceRestored: original, provenance });
    expect(completed).toMatchObject({ schema: 'cos_dev_native_qualification_v1',
      status: 'qualified', accepted: true, mode: 'watch-preload',
      sourceBuildRuntimeSeparated: true });
    expect(completed.provenance).toEqual(provenance);
    for (const changed of [
      { evidence: { ...proof, preloadRendererRestored: false } },
      { evidence: { ...proof, preloadBuildRestored: false } },
      { evidence: { ...proof, preloadAppliedToRenderer: false } },
      { evidence: { ...proof, preloadBuiltSha256: undefined } },
      { evidence: { ...proof, finalRendererConnectionVerified: false } },
      { sourceRestored: { ...original, preload: false } },
      { stage: 'preload-renderer-update' },
      { exitCode: 1 }
    ]) {
      const candidate = qualifyLiveProof({ stage: 'verified', exitCode: 0,
        evidence: proof, sourceRestored: original, provenance, ...changed });
      expect(candidate.accepted).toBe(false);
      expect(candidate.status).toBe('failed');
      expect(candidate.unmet.length).toBeGreaterThan(0);
    }
  });

  it('keeps native runtime qualification separate from installed release evidence', () => {
    const { qualifyLiveProof } = createRequire(import.meta.url)(liveProbe);
    const proof = qualifyLiveProof({
      stage: 'verified',
      exitCode: 0,
      sourceRestored: { css: true, html: true },
      evidence: {
        mode: 'full-renderer',
        cssApplied: true,
        cssRestored: true,
        htmlReloaded: true,
        htmlRestored: true,
        htmlRestoreReloaded: true,
        finalRendererConnectionVerified: true,
        externalDenied: true
      },
      provenance: {
        cssSourceSha256: 'a'.repeat(64),
        htmlSourceSha256: 'b'.repeat(64)
      }
    });

    expect(proof.accepted).toBe(true);
    expect(proof.schema).toBe('cos_dev_native_qualification_v1');
    expect(proof.verifiedLevel).toBe('isolated-native-electron-current-runtime');
    expect(proof.installedRuntimeVerified).toBe(false);
    expect(proof.sourceBuildRuntimeSeparated).toBe(true);
  });

  it('keeps CSS-only, full HTML, navigation negatives and unknown modes from borrowing another mode proof', () => {
    const { qualifyLiveProof } = createRequire(import.meta.url)(liveProbe);
    const restored = { css: true, html: true };
    const common = { stage: 'verified', exitCode: 0, sourceRestored: restored,
      provenance: { cssSourceSha256: 'a'.repeat(64), htmlSourceSha256: 'b'.repeat(64) } };
    const cssEvidence = { mode: 'css-only', cssApplied: true, cssRestored: true,
      externalDenied: true, finalRendererConnectionVerified: true };
    const css = qualifyLiveProof({ ...common, stage: 'verified-css-only', evidence: cssEvidence });
    expect(css.accepted).toBe(true);
    expect(qualifyLiveProof({ ...common, evidence: cssEvidence }).accepted).toBe(false);
    const html = { ...cssEvidence, mode: 'full-renderer', htmlReloaded: true, htmlRestoreReloaded: true };
    expect(qualifyLiveProof({ ...common, evidence: html }).accepted).toBe(true);
    expect(qualifyLiveProof({ ...common, evidence: { ...html, htmlRestoreReloaded: false } }).accepted).toBe(false);
    const nav = { mode: 'navigation-audit', externalDenied: true,
      finalRendererConnectionVerified: true,
      navigationAudit: { externalDenied: true, sameOriginOtherPathDenied: true,
        sameOriginOtherQueryDenied: true, popupDenied: true,
        exactDevSelfReloaded: true, primaryFrameRetained: true } };
    expect(qualifyLiveProof({ ...common, evidence: nav }).accepted).toBe(true);
    expect(qualifyLiveProof({ ...common, evidence: { ...nav, navigationAudit: {
      ...nav.navigationAudit, sameOriginOtherQueryDenied: false } } }).accepted).toBe(false);
    expect(qualifyLiveProof({ ...common, evidence: { ...html, mode: 'not-a-mode' } }).accepted).toBe(false);
  });
  it('refuses accepted native receipts missing exact original or changed source/build SHA provenance', () => {
    const { qualifyLiveProof } = createRequire(import.meta.url)(liveProbe);
    const hashes = { cssSourceSha256: 'a'.repeat(64), htmlSourceSha256: 'b'.repeat(64),
      preloadSourceSha256: 'c'.repeat(64), originalPreloadBuildSha256: 'd'.repeat(64),
      changedPreloadBuildSha256: 'e'.repeat(64) };
    const shared = { stage: 'verified', exitCode: 0,
      sourceRestored: { css: true, html: true, preload: true } };
    const nav = { mode: 'navigation-audit', externalDenied: true,
      finalRendererConnectionVerified: true,
      navigationAudit: { externalDenied: true, sameOriginOtherPathDenied: true,
        sameOriginOtherQueryDenied: true, popupDenied: true,
        exactDevSelfReloaded: true, primaryFrameRetained: true } };
    const preload = { mode: 'watch-preload', preloadBuildChanged: true,
      preloadBuiltContainsUniqueApi: true, preloadBuiltSha256: hashes.changedPreloadBuildSha256,
      preloadAppliedToRenderer: true, preloadBuildRestored: true,
      preloadRendererRestored: true, finalRendererConnectionVerified: true };
    expect(qualifyLiveProof({ ...shared, evidence: nav, provenance: hashes }).accepted).toBe(true);
    expect(qualifyLiveProof({ ...shared, evidence: preload, provenance: hashes }).accepted).toBe(true);
    for (const missing of ['cssSourceSha256', 'htmlSourceSha256',
      'preloadSourceSha256', 'originalPreloadBuildSha256', 'changedPreloadBuildSha256']) {
      const incomplete = { ...hashes, [missing]: undefined };
      const actual = qualifyLiveProof({ ...shared,
        evidence: missing.startsWith('preload') || missing.includes('Build') ? preload : nav,
        provenance: incomplete });
      expect(actual.accepted, missing).toBe(false);
      expect(actual.unmet.some((item: string) => item.startsWith('provenance.')), missing).toBe(true);
    }
    for (const provenance of [{}, { ...hashes, cssSourceSha256: 'invalid' },
      { ...hashes, changedPreloadBuildSha256: hashes.originalPreloadBuildSha256 },
      { ...hashes, changedPreloadBuildSha256: 'f'.repeat(64) }]) {
      const actual = qualifyLiveProof({ ...shared, evidence: preload, provenance });
      expect(actual.accepted, JSON.stringify(provenance)).toBe(false);
    }
    const malformedWitness = qualifyLiveProof({ ...shared, provenance: hashes,
      evidence: { ...preload, preloadBuiltSha256: 42 } });
    expect(malformedWitness.accepted).toBe(false);
    expect(malformedWitness.unmet).toContain('provenance.changed-build-matches-witness');
  });
  it('restores only its own disposable source edits and refuses concurrent mutations', () => {
    const fixture = mkdtempSync(path.join(project, '.test_tmp', 'cos-edit-custody-'));
    const css = path.join(fixture, 'styles.css');
    const html = path.join(fixture, 'index.html');
    const baselineCss = Buffer.from(':root { --owner: untouched; }\n');
    const baselineHtml = Buffer.from('<html><head></head></html>\n');
    try {
      writeFileSync(css, baselineCss);
      writeFileSync(html, baselineHtml);
      const { createOwnedSourceEdits } = createRequire(import.meta.url)(liveProbe);
      const edits = createOwnedSourceEdits({
        css: { path: css, original: baselineCss },
        html: { path: html, original: baselineHtml }
      });
      const untouchedMtime = statSync(html).mtimeMs;
      expect(edits.restore()).toEqual({ css: true, html: true });
      expect(statSync(html).mtimeMs).toBe(untouchedMtime);
      const authored = Buffer.from(':root { --owner: probe; }\n');
      edits.write('css', authored);
      expect(readFileSync(css).equals(authored)).toBe(true);
      // This third-party change can land after the probe edit but before cleanup.
      const foreign = Buffer.from(':root { --owner: foreign; }\n');
      writeFileSync(css, foreign);
      expect(edits.restore()).toEqual({ css: false, html: true });
      expect(readFileSync(css).equals(foreign)).toBe(true);
      expect(() => edits.write('css', authored)).toThrow('SOURCE_CONFLICT:css');
      // A new probe starts only from a verified original byte identity.
      writeFileSync(css, baselineCss);
      const recover = createOwnedSourceEdits({ css: { path: css, original: baselineCss } });
      recover.write('css', authored);
      expect(recover.restore()).toEqual({ css: true });
      expect(readFileSync(css).equals(baselineCss)).toBe(true);
      // A conflicting HTML restoration cannot prevent clean CSS restoration.
      const mixed = createOwnedSourceEdits({
        css: { path: css, original: baselineCss },
        html: { path: html, original: baselineHtml }
      });
      mixed.write('css', authored);
      mixed.write('html', Buffer.from('<html><head>probe</head></html>\n'));
      writeFileSync(html, Buffer.from('foreign html\n'));
      expect(mixed.restore()).toEqual({ css: true, html: false });
      expect(readFileSync(css).equals(baselineCss)).toBe(true);
      expect(() => edits.write('html', baselineHtml)).toThrow('SOURCE_CONFLICT:html');
      expect(readFileSync(html, 'utf8')).toBe('foreign html\n');
      // Preload source uses the identical edit-custody path; no compiled
      // output is forged in this source-only regression.
      const preload = path.join(fixture, 'preload.ts');
      const originalPreload = Buffer.from('export const source = true;\n');
      writeFileSync(preload, originalPreload);
      const preloadEdits = createOwnedSourceEdits({
        preload: { path: preload, original: originalPreload }
      });
      expect(preloadEdits.wasEdited('preload')).toBe(false);
      preloadEdits.write('preload', Buffer.from('export const source = false;\n'));
      expect(preloadEdits.wasEdited('preload')).toBe(true);
      expect(preloadEdits.restore()).toEqual({ preload: true });
      expect(readFileSync(preload).equals(originalPreload)).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('reports an interrupted private preload rebuild without accepting stale generated bytes', async () => {
    const fixture = mkdtempSync(path.join(project, '.test_tmp', 'cos-stale-preload-'));
    const built = path.join(fixture, 'index.js');
    const original = Buffer.from('/* original compiled preload */\n');
    const stale = Buffer.from('/* interrupted compiled preload */\n');
    try {
      writeFileSync(built, stale);
      const { awaitOriginalPreloadBuild } = createRequire(import.meta.url)(liveProbe);
      let checks = 0;
      await expect(awaitOriginalPreloadBuild(built,
        createHash('sha256').update(original).digest('hex'),
        () => { checks++; throw Error('the exact disposable watcher stopped'); },
        1500
      )).rejects.toThrow('private-preload-watcher-disappeared');
      expect(checks).toBe(1);
      expect(readFileSync(built).equals(stale)).toBe(true);
      // A healthy task-owned watcher and stable compiled bytes are both needed
      // before claiming original generated-output restoration.
      writeFileSync(built, original);
      let restoredChecks = 0;
      await expect(awaitOriginalPreloadBuild(built,
        createHash('sha256').update(original).digest('hex'),
        () => { restoredChecks++; },
        1500
      )).resolves.toBe(true);
      expect(restoredChecks).toBeGreaterThanOrEqual(4);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('does not advance preload adoption on a malformed changed bundle containing the unique marker', async () => {
    const dir = mkdtempSync(path.join(project, '.test_tmp', 'cos-preload-partial-build-'));
    const built = path.join(dir, 'preload.js');
    const original = Buffer.from('/* original */\n');
    const nonce = 'receipt_markup_123';
    const marker = '__cosPreloadLive' + nonce;
    const partial = Buffer.from(`contextBridge.exposeInMainWorld('${marker}', { receipt: '${nonce}' };\n`);
    try {
      writeFileSync(built, partial);
      const { until, awaitChangedPreloadBuild } = createRequire(import.meta.url)(liveProbe);
      // This was the live branch's entire previous build acceptance gate.
      await expect(until('old-compiled-check', () => Promise.resolve(
        createHash('sha256').update(readFileSync(built)).digest('hex') !==
        createHash('sha256').update(original).digest('hex') &&
        readFileSync(built, 'utf8').includes(marker)
      ), 300)).resolves.toBeUndefined();
      await expect(awaitChangedPreloadBuild(built,
        createHash('sha256').update(original).digest('hex'), marker, nonce,
        () => {}, 700, realpathSync(built)))
        .rejects.toThrow('preload-changed-built-output-not-verified');
      expect(readFileSync(built).equals(partial)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('qualifies a stable, executable changed preload bundle and refuses an interrupted/foreign compilation', async () => {
    const dir = mkdtempSync(path.join(project, '.test_tmp', 'cos-preload-compile-transaction-'));
    const built = path.join(dir, 'preload.js');
    const source = path.join(dir, 'index.ts');
    const originalSource = Buffer.from('/* baseline source */\n');
    const originalBuild = Buffer.from('/* baseline build */\n');
    const nonce = 'compile_receipt_456';
    const marker = '__cosPreloadLive' + nonce;
    const changed = Buffer.from(`contextBridge.exposeInMainWorld('${marker}', { receipt: '${nonce}' });\n`);
    try {
      writeFileSync(source, originalSource);
      writeFileSync(built, originalBuild);
      const { createOwnedSourceEdits, awaitChangedPreloadBuild } = createRequire(import.meta.url)(liveProbe);
      const edits = createOwnedSourceEdits({ preload: { path: source, original: originalSource } });
      edits.write('preload', Buffer.from('/* temporary source */\n'));
      let checks = 0;
      try {
        const result = await awaitChangedPreloadBuild(built,
          createHash('sha256').update(originalBuild).digest('hex'), marker, nonce,
          () => { if (++checks === 2) writeFileSync(built, changed); },
          1400, realpathSync(built), () => edits.assertExpected());
        expect(result).toMatchObject({ sha256: createHash('sha256').update(changed).digest('hex') });
        expect(checks).toBeGreaterThanOrEqual(6);
      } finally { expect(edits.restore()).toEqual({ preload: true }); }
      expect(readFileSync(source).equals(originalSource)).toBe(true);
      expect(readFileSync(built).equals(changed)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not call two different executable preload builds one stable revision', async () => {
    const dir = mkdtempSync(path.join(project, '.test_tmp', 'cos-preload-competing-builds-'));
    const built = path.join(dir, 'preload.js');
    const nonce = 'switching_revision_789';
    const marker = '__cosPreloadLive' + nonce;
    const first = Buffer.from(`contextBridge.exposeInMainWorld('${marker}', { receipt: '${nonce}', variant: 1 });`);
    const second = Buffer.from(`contextBridge.exposeInMainWorld('${marker}', { receipt: '${nonce}', variant: 2 });`);
    try {
      writeFileSync(built, first);
      const { awaitChangedPreloadBuild } = createRequire(import.meta.url)(liveProbe);
      let checks = 0;
      await expect(awaitChangedPreloadBuild(built,
        createHash('sha256').update('baseline').digest('hex'), marker, nonce,
        () => { if (++checks % 2 === 0) writeFileSync(built, checks % 4 === 2 ? second : first); },
        750, realpathSync(built)))
        .rejects.toThrow('preload-changed-built-output-not-verified');
      expect(checks).toBeGreaterThanOrEqual(4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves a foreign preload source write during changed-build admission', async () => {
    const dir = mkdtempSync(path.join(project, '.test_tmp', 'cos-preload-source-interrupt-'));
    const source = path.join(dir, 'preload.ts');
    const built = path.join(dir, 'preload.js');
    const original = Buffer.from('// original\n');
    const foreign = Buffer.from('// external editor won custody\n');
    const nonce = 'source_interrupted_789';
    const marker = '__cosPreloadLive' + nonce;
    try {
      writeFileSync(source, original);
      writeFileSync(built, Buffer.from('/* baseline */'));
      const { createOwnedSourceEdits, awaitChangedPreloadBuild } = createRequire(import.meta.url)(liveProbe);
      const edits = createOwnedSourceEdits({ preload: { path: source, original } });
      edits.write('preload', Buffer.from(`// temporary source ${nonce}\n`));
      let custodyChecks = 0;
      await expect(awaitChangedPreloadBuild(built,
        createHash('sha256').update('/* baseline */').digest('hex'), marker, nonce,
        () => { if (++custodyChecks === 1) writeFileSync(source, foreign); },
        800, realpathSync(built), () => edits.assertExpected()))
        .rejects.toThrow('SOURCE_CONFLICT:preload');
      expect(edits.restore()).toEqual({ preload: false });
      expect(readFileSync(source).equals(foreign)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a matching preload rollback bundle when its original watcher already exited', async () => {
    const folder = mkdtempSync(path.join(project, '.test_tmp', 'cos-preload-build-dead-owner-'));
    const built = path.join(folder, 'index.js');
    const source = Buffer.from('/* original compiled bytes */\n');
    try {
      writeFileSync(built, source);
      const { awaitOriginalPreloadBuild } = createRequire(import.meta.url)(liveProbe);
      let custodyChecks = 0;
      await expect(awaitOriginalPreloadBuild(built,
        createHash('sha256').update(source).digest('hex'),
        () => { custodyChecks++; throw Error('the original watcher exited'); },
        700)).rejects.toThrow('private-preload-watcher-disappeared');
      expect(custodyChecks).toBe(1);
      expect(readFileSync(built).equals(source)).toBe(true);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it('does not qualify one transient matching preload artifact before a delayed stale compilation overwrites it', async () => {
    const folder = mkdtempSync(path.join(project, '.test_tmp', 'cos-preload-build-late-'));
    const built = path.join(folder, 'index.js');
    const restored = Buffer.from('/* source restored generated output */\n');
    const lateStale = Buffer.from('/* delayed stale compilation after source restore */\n');
    try {
      writeFileSync(built, restored);
      const { awaitOriginalPreloadBuild } = createRequire(import.meta.url)(liveProbe);
      let checks = 0;
      await expect(awaitOriginalPreloadBuild(built,
        createHash('sha256').update(restored).digest('hex'),
        () => { if (++checks === 2) writeFileSync(built, lateStale); },
        650)).rejects.toThrow('preload-original-built-output-not-restored');
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(readFileSync(built).equals(lateStale)).toBe(true);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it('rejects a relocated compiled preload target despite identical generated bytes', async () => {
    const folder = mkdtempSync(path.join(project, '.test_tmp', 'cos-built-preload-redirect-'));
    const built = path.join(folder, 'index.js');
    const other = path.join(folder, 'different-identity.js');
    const original = Buffer.from('/* original compiled output */\n');
    try {
      writeFileSync(built, original);
      writeFileSync(other, original);
      const { awaitOriginalPreloadBuild } = createRequire(import.meta.url)(liveProbe);
      await expect(awaitOriginalPreloadBuild(built,
        createHash('sha256').update(original).digest('hex'),
        () => {}, 650, realpathSync(other)))
        .rejects.toThrow('preload-generated-output-identity-changed');
      expect(readFileSync(built).equals(original)).toBe(true);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it('rejects concurrent source replacement during the watcher restoration fence without overwriting foreign bytes', async () => {
    const folder = mkdtempSync(path.join(project, '.test_tmp', 'cos-original-preload-race-'));
    const source = path.join(folder, 'index.ts');
    const built = path.join(folder, 'index.js');
    const original = Buffer.from('/* original source */\n');
    const compiled = Buffer.from('/* original compiled output */\n');
    const foreign = Buffer.from('/* independent writer after restore */\n');
    try {
      writeFileSync(source, original);
      writeFileSync(built, compiled);
      const { createOwnedSourceEdits, awaitOriginalPreloadBuild } = createRequire(import.meta.url)(liveProbe);
      const edits = createOwnedSourceEdits({ preload: { path: source, original } });
      edits.write('preload', Buffer.from('/* temporary preload */\n'));
      expect(edits.restore()).toEqual({ preload: true });
      let checks = 0;
      await expect(awaitOriginalPreloadBuild(built,
        createHash('sha256').update(compiled).digest('hex'),
        () => { if (++checks === 2) writeFileSync(source, foreign); },
        800, realpathSync(built), () => edits.assertRestored()))
        .rejects.toThrow('SOURCE_CONFLICT:preload');
      expect(readFileSync(source).equals(foreign)).toBe(true);
      expect(readFileSync(built).equals(compiled)).toBe(true);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it('does not turn a source-conflict or failed CDP command during update into an ordinary reload timeout', async () => {
    const { until } = createRequire(import.meta.url)(liveProbe);
    await expect(until('changed-document', async () => {
      throw Error('SOURCE_CONFLICT:preload');
    }, 450)).rejects.toThrow('SOURCE_CONFLICT:preload');
    await expect(until('changed-document', async () => {
      throw Error('CDP refused: Runtime.evaluate');
    }, 450)).rejects.toThrow('CDP refused: Runtime.evaluate');
    // A genuine document swap remains recoverable, rather than terminating
    // a valid Electron HTML update at the first invalid execution context.
    let reads = 0;
    await expect(until('real-navigation', async () => {
      if (++reads === 1) throw Error('Renderer evaluation document changed');
      return true;
    }, 450)).resolves.toBeUndefined();
    expect(reads).toBe(2);
  });

  it('rejects watcher departure during an update even if a stale CDP predicate would claim success', async () => {
    const { until } = createRequire(import.meta.url)(liveProbe);
    let checks = 0;
    const owner = () => {
      checks++;
      if (checks === 2) throw Error('LIVE_FAIL:disposable-watcher-lost');
    };
    await expect(until('preload-applied', async () => true, 450, owner))
      .rejects.toThrow('LIVE_FAIL:disposable-watcher-lost');
    expect(checks).toBe(2);
  });

  it('restores owned preload source after a vanished watcher rather than treating interrupted build output as adopted', async () => {
    const fixture = mkdtempSync(path.join(project, '.test_tmp', 'cos-watch-interrupt-'));
    const preload = path.join(fixture, 'preload.ts');
    const compiled = path.join(fixture, 'preload.js');
    const original = Buffer.from('/* source-original */\n');
    const originalBuild = Buffer.from('/* compiled-original */\n');
    const changed = Buffer.from('/* source-changed */\n');
    const { until, createOwnedSourceEdits } = createRequire(import.meta.url)(liveProbe);
    try {
      writeFileSync(preload, original);
      writeFileSync(compiled, originalBuild);
      const edits = createOwnedSourceEdits({ preload: { path: preload, original } });
      edits.write('preload', changed);
      let ownerChecks = 0;
      try {
        await expect(until('changed-built-bundle', () =>
          Promise.resolve(!readFileSync(compiled).equals(originalBuild)), 600, () => {
          if (++ownerChecks === 3) throw Error('LIVE_FAIL:private-renderer-process-changed-during-proof');
        })).rejects.toThrow('private-renderer-process-changed-during-proof');
      } finally {
        expect(edits.restore()).toEqual({ preload: true });
      }
      expect(readFileSync(preload).equals(original)).toBe(true);
      expect(readFileSync(compiled).equals(originalBuild)).toBe(true);
      expect(ownerChecks).toBe(3);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('refuses to claim a restored preload from a restored build until a new primary document runs original code', () => {
    const { originalPreloadAppliedToRenderer } = createRequire(import.meta.url)(liveProbe);
    const originalUrl = 'http://localhost:5173/';
    const appliedTimeOrigin = 1000;
    const runtime = {
      url: originalUrl,
      timeOrigin: 2000,
      readyState: 'complete',
      temporaryApiReceipt: null,
      preloadApiAvailable: true,
      appliedDocumentWitness: false
    };
    // The build can be byte-identical while the renderer is still running
    // the temporary preload. Neither disk SHA nor its rebuild event proves rollback.
    expect(originalPreloadAppliedToRenderer({ ...runtime,
      timeOrigin: appliedTimeOrigin, temporaryApiReceipt: 'temporary',
      appliedDocumentWitness: true
    }, appliedTimeOrigin)).toBe(false);
    expect(originalPreloadAppliedToRenderer({ ...runtime,
      timeOrigin: appliedTimeOrigin
    }, appliedTimeOrigin)).toBe(false);
    // Merely navigating is insufficient if an old/generated preload is still bound.
    expect(originalPreloadAppliedToRenderer({ ...runtime,
      temporaryApiReceipt: 'temporary'
    }, appliedTimeOrigin)).toBe(false);
    expect(originalPreloadAppliedToRenderer({ ...runtime,
      appliedDocumentWitness: true
    }, appliedTimeOrigin)).toBe(false);
    expect(originalPreloadAppliedToRenderer({ ...runtime,
      readyState: 'loading'
    }, appliedTimeOrigin)).toBe(false);
    // Losing the normal Electron preload bridge is not a usable rollback.
    expect(originalPreloadAppliedToRenderer({ ...runtime,
      preloadApiAvailable: false
    }, appliedTimeOrigin)).toBe(false);
    expect(originalPreloadAppliedToRenderer({ ...runtime,
      url: 'http://localhost:5173/other'
    }, appliedTimeOrigin)).toBe(false);
    expect(originalPreloadAppliedToRenderer({ ...runtime,
      url: 'https://example.invalid/'
    }, appliedTimeOrigin)).toBe(false);
    // Fail closed on absent CDP snapshots, malformed types or a missing
    // post-update time origin instead of reporting restoration on an old page.
    expect(originalPreloadAppliedToRenderer(null, appliedTimeOrigin)).toBe(false);
    expect(originalPreloadAppliedToRenderer(runtime, null)).toBe(false);
    expect(originalPreloadAppliedToRenderer({ ...runtime,
      temporaryApiReceipt: undefined
    }, appliedTimeOrigin)).toBe(false);
    expect(originalPreloadAppliedToRenderer(runtime, appliedTimeOrigin)).toBe(true);
  });

  it('qualifies HTML replacement only in a fresh primary Electron document retaining the preload bridge', () => {
    const { htmlRevisionAppliedToPrimary } = createRequire(import.meta.url)(liveProbe);
    const origin = 1500;
    const loaded = {
      url: 'http://localhost:5173/', timeOrigin: 2500, readyState: 'complete',
      transientGlobalSurvived: false, headMarkerPresent: true,
      preloadApiAvailable: true
    };
    expect(htmlRevisionAppliedToPrimary(loaded, origin, true)).toBe(true);
    expect(htmlRevisionAppliedToPrimary({ ...loaded, headMarkerPresent: false },
      origin, false)).toBe(true);
    expect(htmlRevisionAppliedToPrimary({ ...loaded, timeOrigin: origin },
      origin, true)).toBe(false);
    expect(htmlRevisionAppliedToPrimary({ ...loaded,
      transientGlobalSurvived: true }, origin, true)).toBe(false);
    // A web-only reload can carry the head marker but lack preload wiring.
    expect(htmlRevisionAppliedToPrimary({ ...loaded, preloadApiAvailable: false },
      origin, true)).toBe(false);
    expect(htmlRevisionAppliedToPrimary({ ...loaded, url: 'https://example.invalid/' },
      origin, true)).toBe(false);
    expect(htmlRevisionAppliedToPrimary({ ...loaded, url: 'http://localhost:5173/?foreign=1' },
      origin, true)).toBe(false);
    expect(htmlRevisionAppliedToPrimary({ ...loaded, headMarkerPresent: false },
      origin, true)).toBe(false);
    expect(htmlRevisionAppliedToPrimary({ ...loaded, readyState: 'loading' },
      origin, true)).toBe(false);
    expect(htmlRevisionAppliedToPrimary(null, origin, true)).toBe(false);
    expect(htmlRevisionAppliedToPrimary(loaded, null, true)).toBe(false);
  });

  it('rejects backwards document epochs during HTML and preload restoration', () => {
    const { htmlRevisionAppliedToPrimary, originalPreloadAppliedToRenderer } =
      createRequire(import.meta.url)(liveProbe);
    const html = {
      url: 'http://localhost:5173/', timeOrigin: 900, readyState: 'complete',
      transientGlobalSurvived: false, headMarkerPresent: true, preloadApiAvailable: true
    };
    const restored = {
      url: 'http://localhost:5173/', timeOrigin: 900, readyState: 'complete',
      preloadApiAvailable: true, temporaryApiReceipt: null, appliedDocumentWitness: false
    };
    // A reply for an earlier document must not be called a later reload.
    expect(htmlRevisionAppliedToPrimary(html, 1000, true)).toBe(false);
    expect(originalPreloadAppliedToRenderer(restored, 1000)).toBe(false);
  });

  it('requires the changed preload to execute in a ready primary Electron document', () => {
    const { temporaryPreloadAppliedToPrimary } = createRequire(import.meta.url)(liveProbe);
    const applied = {
      url: 'http://localhost:5173/', timeOrigin: 2500, readyState: 'complete',
      preloadApiAvailable: true, transientGlobalSurvived: false,
      temporaryApiReceipt: 'changed-preload'
    };
    expect(temporaryPreloadAppliedToPrimary(applied, 1500, 'changed-preload')).toBe(true);
    expect(temporaryPreloadAppliedToPrimary({ ...applied, preloadApiAvailable: false },
      1500, 'changed-preload')).toBe(false);
    expect(temporaryPreloadAppliedToPrimary({ ...applied, timeOrigin: 1200 },
      1500, 'changed-preload')).toBe(false);
    expect(temporaryPreloadAppliedToPrimary({ ...applied, url: 'http://localhost:5173/?q=1' },
      1500, 'changed-preload')).toBe(false);
    expect(temporaryPreloadAppliedToPrimary({ ...applied, readyState: 'loading' },
      1500, 'changed-preload')).toBe(false);
    expect(temporaryPreloadAppliedToPrimary({ ...applied, transientGlobalSurvived: true },
      1500, 'changed-preload')).toBe(false);
    expect(temporaryPreloadAppliedToPrimary({ ...applied, temporaryApiReceipt: null },
      1500, 'changed-preload')).toBe(false);
    expect(temporaryPreloadAppliedToPrimary(applied, 1500, 'other-revision')).toBe(false);
    expect(temporaryPreloadAppliedToPrimary(null, 1500, 'changed-preload')).toBe(false);
  });

  it('rejects an old-document CDP reply and a disconnected debugger without waiting for its command timeout', async () => {
    // This synthetic socket never opens a browser or edits a source file. Its
    // old evaluation reply arrives after the renderer changed documents.
    const { connectPage } = createRequire(import.meta.url)(liveProbe);
    let mode: 'navigation' | 'close' = 'navigation';
    class FixtureSocket extends EventEmitter {
      constructor(_url: string) { super(); queueMicrotask(() => this.emit('open')); }
      send(text: string) {
        const { id, method } = JSON.parse(text);
        queueMicrotask(() => {
          if (method === 'Runtime.evaluate') {
            if (mode === 'navigation') {
              this.emit('message', Buffer.from(JSON.stringify({ method: 'Runtime.executionContextsCleared' })));
              this.emit('message', Buffer.from(JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'main' } } })));
              this.emit('message', Buffer.from(JSON.stringify({ id, result: { result: { value: 'stale-before-reload' } } })));
            } else this.emit('close');
          } else this.emit('message', Buffer.from(JSON.stringify({ id, result: {} })));
        });
      }
      close() { this.emit('close'); }
      terminate() { this.emit('close'); }
    }
    const target = { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/disposable' };
    const navigated = await connectPage(target, FixtureSocket);
    await expect(navigated.evaluate('true')).rejects.toThrow(/document.*changed|stale/i);
    expect(navigated.events).toContain('Page.frameNavigated');
    navigated.ws.close();

    mode = 'close';
    const interrupted = await connectPage(target, FixtureSocket);
    const start = Date.now();
    await expect(interrupted.evaluate('true')).rejects.toThrow(/debugger.*disconnect|debugger.*clos/i);
    expect(Date.now() - start).toBeLessThan(1000);
    interrupted.ws.close();
  });

  it('does not promote edited unpacked-extension bytes to an applied live worker without an exact runtime receipt', async () => {
    const fixture = mkdtempSync(path.join(project, '.test_tmp', 'cos-extension-loaded-receipt-'));
    const extension = path.join(fixture, 'extension');
    const expected = 'native-edit-v2';
    const workerId = 'a'.repeat(32);
    let loadedReceipt: string | null = null;
    try {
      mkdirSync(extension);
      writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Luna Forge X7 Companion', version: '2.1.15',
        background: { service_worker: 'background.js', type: 'module' }
      }));
      writeFileSync(path.join(extension, 'background.js'),
        `globalThis.__cosDevNativeReloadOct10 = '${expected}';\n`);
      const { verifyCliWorker } = createRequire(import.meta.url)(liveProbe);
      class WorkerSocket extends EventEmitter {
        constructor(_url: string) { super(); queueMicrotask(() => this.emit('open')); }
        send(raw: string) {
          const { id } = JSON.parse(raw);
          queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
            id, result: { result: { value: JSON.stringify({
              id: workerId, name: 'Luna Forge X7 Companion', version: '2.1.15',
              worker: 'background.js', receipt: loadedReceipt
            }) } }
          }))));
        }
        close() { this.emit('close'); }
      }
      const target = {
        url: 'chrome-extension://' + workerId + '/background.js',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/worker/fixture-receipt'
      };
      // A source edit by itself cannot attest code the old MV3 worker loaded.
      await expect(verifyCliWorker(target, fixture, expected, WorkerSocket))
        .rejects.toThrow(/runtime.*receipt.*not.*applied/i);
      loadedReceipt = 'native-edit-v1';
      await expect(verifyCliWorker(target, fixture, expected, WorkerSocket))
        .rejects.toThrow(/runtime.*receipt.*not.*applied/i);
      loadedReceipt = expected;
      await expect(verifyCliWorker(target, fixture, expected, WorkerSocket))
        .resolves.toBe(workerId);
      // Expected receipt must itself be declared in the on-disk fixture source.
      writeFileSync(path.join(extension, 'background.js'),
        `globalThis.__cosDevNativeReloadOct10 = 'different-revision';\n`);
      await expect(verifyCliWorker(target, fixture, expected, WorkerSocket))
        .rejects.toThrow(/source.*receipt/i);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('refuses unsafe live renderer probe inputs without modifying source', () => {
    const cssText = 'body { color: red; }\n';
    const htmlText = '<html><head></head><body></body></html>\n';
    const preloadText = 'export const probe = 1;\n';
    const builtText = 'export const probe = 1;\n';
    const cssHash = createHash('sha256').update(cssText).digest('hex');
    const htmlHash = createHash('sha256').update(htmlText).digest('hex');
    const preloadHash = createHash('sha256').update(preloadText).digest('hex');
    const run = (flags: string[]) => spawnSync(process.execPath, [liveProbe, ...flags], {
      cwd: project, encoding: 'utf8', timeout: 8000
    });
    const canonical = run(['--run', '--fixture', project, '--css-sha256', cssHash, '--html-sha256', htmlHash]);
    expect(canonical.status).toBe(2);
    expect(canonical.stderr).toContain('PREFLIGHT_FAILED:Refused: fixture must be a distinct checkout');
    const base = path.join(project, '.test_tmp');
    const disposable = mkdtempSync(path.join(base, 'cos-live-probe-denial-'));
    const css = path.join(disposable, 'src', 'renderer', 'styles.css');
    const html = path.join(disposable, 'src', 'renderer', 'index.html');
    const preload = path.join(disposable, 'src', 'preload', 'index.ts');
    const builtPreload = path.join(disposable, 'out', 'preload', 'index.js');
    try {
      mkdirSync(path.join(disposable, '.git'));
      mkdirSync(path.dirname(css), { recursive: true });
      mkdirSync(path.dirname(preload), { recursive: true });
      mkdirSync(path.dirname(builtPreload), { recursive: true });
      writeFileSync(css, cssText);
      writeFileSync(html, htmlText);
      writeFileSync(preload, preloadText);
      writeFileSync(builtPreload, builtText);
      const missingExplicitRun = run(['--fixture', disposable, '--css-sha256', cssHash, '--html-sha256', htmlHash]);
      expect(missingExplicitRun.status).toBe(2);
      expect(missingExplicitRun.stderr).toContain('PREFLIGHT_FAILED:Refused: explicit --run');
      const mismatch = run(['--run', '--fixture', disposable, '--css-sha256', cssHash, '--html-sha256', '0'.repeat(64)]);
      expect(mismatch.status).toBe(2);
      expect(mismatch.stderr).toContain('PREFLIGHT_FAILED:Refused: source SHA mismatch');
      // Even matching fixture bytes do not authorize joining a different checkout's
      // development listener or making any source edit before the private bridge check.
      const unrelatedRuntime = run(['--run', '--fixture', disposable, '--css-sha256', cssHash, '--html-sha256', htmlHash]);
      expect(unrelatedRuntime.status).toBe(2);
      expect(unrelatedRuntime.stderr).toContain('LIVE_PROBE_REFUSED:');
      // CSS HMR is independent of the app-shell's blocked HTML navigation.
      // A successful run must have its own strict native acceptance mode,
      // without treating an absent private Electron runtime as a success.
      const cssOnly = run(['--run', '--fixture', disposable, '--css-sha256', cssHash,
        '--html-sha256', htmlHash, '--css-only']);
      expect(cssOnly.status).toBe(2);
      expect(cssOnly.stderr).toContain('LIVE_PROBE_REFUSED');
      expect(cssOnly.stderr).not.toContain('PREFLIGHT_FAILED:');
      const cssNavigationConflict = run(['--run', '--fixture', disposable, '--css-sha256', cssHash,
        '--html-sha256', htmlHash, '--css-only', '--navigation-audit']);
      expect(cssNavigationConflict.status).toBe(2);
      expect(cssNavigationConflict.stderr).toContain('PREFLIGHT_FAILED:Refused:');
      const otherNavigationRuntime = run([
        '--run', '--fixture', disposable, '--css-sha256', cssHash, '--html-sha256', htmlHash,
        '--navigation-audit'
      ]);
      expect(otherNavigationRuntime.status).toBe(2);
      expect(otherNavigationRuntime.stderr).toContain('LIVE_PROBE_REFUSED');
      const contradictoryModes = run([
        '--run', '--fixture', disposable, '--css-sha256', cssHash, '--html-sha256', htmlHash,
        '--navigation-audit', '--custody-only'
      ]);
      expect(contradictoryModes.status).toBe(2);
      expect(contradictoryModes.stderr).toContain('PREFLIGHT_FAILED:Refused: explicit --run');
      const preloadMismatch = run([
        '--run', '--fixture', disposable, '--css-sha256', cssHash,
        '--html-sha256', htmlHash, '--watch-preload', '--preload-sha256', '0'.repeat(64)
      ]);
      expect(preloadMismatch.status).toBe(2);
      expect(preloadMismatch.stderr).toContain('PREFLIGHT_FAILED:Refused: preload SHA mismatch');
      const preloadWrongRuntime = run([
        '--run', '--fixture', disposable, '--css-sha256', cssHash,
        '--html-sha256', htmlHash, '--watch-preload', '--preload-sha256', preloadHash
      ]);
      expect(preloadWrongRuntime.status).toBe(2);
      expect(preloadWrongRuntime.stderr).toContain('LIVE_PROBE_REFUSED:');
      const disconnectedPreload = path.join(disposable, 'no-http.cjs');
      writeFileSync(disconnectedPreload, "globalThis.fetch = async () => { throw Error('synthetic network outage'); };");
      const disconnected = spawnSync(process.execPath, [
        liveProbe, '--run', '--fixture', disposable, '--css-sha256', cssHash,
        '--html-sha256', htmlHash, '--watch-preload', '--preload-sha256', preloadHash
      ], {
        cwd: project, encoding: 'utf8', timeout: 8000,
        env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS,
          `--require="${disconnectedPreload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ') }
      });
      expect(disconnected.status).toBe(2);
      expect(disconnected.stderr).toContain('LIVE_PROBE_REFUSED');
      expect(readFileSync(css, 'utf8')).toBe(cssText);
      expect(readFileSync(html, 'utf8')).toBe(htmlText);
      expect(readFileSync(preload, 'utf8')).toBe(preloadText);
      expect(readFileSync(builtPreload, 'utf8')).toBe(builtText);
      expect(existsSync(path.join(disposable, '.dev-fast-launch'))).toBe(false);
    } finally {
      rmSync(disposable, { recursive: true, force: true });
    }
  });

  it('refuses a renderer debugger owned by a different process than the matching development bridge', () => {
    if (process.platform !== 'win32') return;
    const base = path.join(project, '.test_tmp');
    const fixture = mkdtempSync(path.join(base, 'cos-debug-owner-denial-'));
    const css = path.join(fixture, 'src', 'renderer', 'styles.css');
    const html = path.join(fixture, 'src', 'renderer', 'index.html');
    const preload = path.join(fixture, 'mock-listeners.cjs');
    const cssText = ':root {}\n';
    const htmlText = '<html><head></head></html>\n';
    try {
      mkdirSync(path.join(fixture, '.git'));
      mkdirSync(path.dirname(css), { recursive: true });
      writeFileSync(css, cssText);
      writeFileSync(html, htmlText);
      writeFileSync(preload, `
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = fs.realpathSync.native(process.env.COS_TEST_FIXTURE);
const userData = path.join(os.tmpdir(), 'chat-on-steroids-fast-dev', crypto.createHash('sha256').update(root).digest('hex').slice(0,12)).toLowerCase();
const instanceId = 'dev-' + crypto.createHash('sha256').update(userData).digest('hex').slice(0,24);
globalThis.fetch = async url => ({
  ok: true,
  json: async () => String(url).includes('/hello')
    ? { app: 'chat-on-steroids', instanceId, legacyInstance: false, paired: false, bridge: 16 }
    : [{ type: 'page', url: 'http://localhost:5173/',
         webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/foreign' }]
});
const saved = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  const mode = process.env.COS_TEST_OWNER_MODE || 'different';
  if (String(command).toLowerCase().endsWith('powershell.exe'))
    return mode === 'noParent' ? { status: 1, stdout: '' } : { status: 0, stdout: '44444' };
  if (!String(command).toLowerCase().endsWith('netstat.exe')) return saved(command,args,options);
  if (mode === 'missing') return { status: 0, stdout: 'TCP 127.0.0.1:8796 0.0.0.0:0 LISTENING 11111\\r\\n' };
  const address = mode === 'wildcard' ? '0.0.0.0' : '127.0.0.1';
  const targetOwner = mode === 'different' ? 22222 : 11111;
  const rendererOwner = mode === 'foreignRenderer' ? 33333 : 44444;
  const rendererAddress = mode === 'rendererWildcard' ? '0.0.0.0' : '[::1]';
  return { status: 0, stdout:
    (mode === 'missingRenderer' ? '' : 'TCP ' + rendererAddress + ':5173 [::]:0 LISTENING ' + rendererOwner + '\\r\\n') +
    'TCP 127.0.0.1:8796 0.0.0.0:0 LISTENING 11111\\r\\n' +
    'TCP ' + address + ':9333 0.0.0.0:0 LISTENING ' + targetOwner + '\\r\\n' };
};
require('node:module').syncBuiltinESMExports();
if (process.env.COS_TEST_OWNER_MODE === 'hangHandshake') {
 const Module=require('node:module');
 const EventEmitter=require('node:events');
 const old=Module._load;
 Module._load=function(request,parent,isMain) {
  if (request === 'ws') return class StalledDevtoolsSocket extends EventEmitter {
   constructor(){super();this.keep=setInterval(()=>{},500)}
   terminate(){clearInterval(this.keep)}
   close(){clearInterval(this.keep)}
  };
  return old.apply(this,arguments);
 };
}
`);
      const runCase = (mode: string, custodyOnly = false) => spawnSync(process.execPath, [
        liveProbe, '--run', '--fixture', fixture,
        '--css-sha256', createHash('sha256').update(cssText).digest('hex'),
        '--html-sha256', createHash('sha256').update(htmlText).digest('hex'),
        ...(custodyOnly ? ['--custody-only'] : [])
      ], {
        cwd: project, encoding: 'utf8', timeout: 8500,
        env: { ...process.env, COS_TEST_FIXTURE: fixture, COS_TEST_OWNER_MODE: mode,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\','/')}"`].filter(Boolean).join(' ') }
      });
      const result = runCase('different');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Refused: CDP debugger and dev bridge have different Windows listener owners');
      const matching = runCase('matching', true);
      expect(matching.status, matching.stderr).toBe(0);
      expect(matching.stdout).toContain('"sameElectronListenerOwner":true');
      expect(matching.stdout).toContain('"rendererViteParentVerified":true');
      const wildcard = runCase('wildcard', true);
      expect(wildcard.status).toBe(2);
      expect(wildcard.stderr).toContain('non-loopback, or ambiguous');
      const missing = runCase('missing', true);
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('unavailable, non-loopback, or ambiguous');
      // Two legitimate-looking Electron endpoints do not establish that the
      // Vite renderer at localhost:5173 belongs to this same watcher tree.
      const foreignRenderer = runCase('foreignRenderer', true);
      expect(foreignRenderer.status).toBe(2);
      expect(foreignRenderer.stderr).toContain('Refused: development renderer is not owned by the Electron watcher');
      const missingRenderer = runCase('missingRenderer', true);
      expect(missingRenderer.status).toBe(2);
      expect(missingRenderer.stderr).toContain('listener ownership unavailable, non-loopback, or ambiguous');
      const rendererWildcard = runCase('rendererWildcard', true);
      expect(rendererWildcard.status).toBe(2);
      expect(rendererWildcard.stderr).toContain('listener ownership unavailable, non-loopback, or ambiguous');
      const noParent = runCase('noParent', true);
      expect(noParent.status).toBe(2);
      expect(noParent.stderr).toContain('Electron watcher ancestry could not be verified');
      // Even a correct private debugger may stall before WebSocket open.
      // Fail closed without leaving the fixture's source touched.
      const stalled = runCase('hangHandshake');
      expect(stalled.status, stalled.stderr || stalled.error?.message).toBe(2);
      expect(stalled.stderr).toContain('Renderer debugger handshake timed out');
      expect(readFileSync(css, 'utf8')).toBe(cssText);
      expect(readFileSync(html, 'utf8')).toBe(htmlText);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects foreign Chrome debugging owners before accepting an isolated dev browser', () => {
    if (process.platform !== 'win32') return;
    const fixture = mkdtempSync(path.join(project, '.test_tmp', 'chat42-chrome-debug-fixture-'));
    const profile = path.join(fixture, 'chat42_chrome_dev_test');
    const css = path.join(fixture, 'src', 'renderer', 'styles.css');
    const html = path.join(fixture, 'src', 'renderer', 'index.html');
    const intercept = path.join(fixture, 'mock-chrome.cjs');
    const cssText = ':root { }\n';
    const htmlText = '<html><head></head><body></body></html>\n';
    try {
      mkdirSync(path.join(fixture, '.git'));
      mkdirSync(path.dirname(css), { recursive: true });
      mkdirSync(profile);
      mkdirSync(path.join(fixture, 'extension'));
      writeFileSync(path.join(fixture, 'extension', 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Luna Forge X7 Companion', version: '2.1.15',
        background: { service_worker: 'background.js', type: 'module' }
      }));
      writeFileSync(css, cssText);
      writeFileSync(html, htmlText);
      writeFileSync(intercept, `
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const cp=require('node:child_process');
const fixture=fs.realpathSync.native(process.env.COS_TEST_FIXTURE);
const privateRoot=path.join(os.tmpdir(),'chat-on-steroids-fast-dev',crypto.createHash('sha256').update(fixture).digest('hex').slice(0,12)).toLowerCase();
let netstatCalls=0;
const extId='abcdefghijklmnopabcdefghijklmnop';
globalThis.fetch=async url=>({
 ok:true, headers:new Headers({'content-type':'application/json'}),
 json:async()=>String(url).includes('/hello')
  ? {app:'chat-on-steroids',instanceId:'dev-'+crypto.createHash('sha256').update(privateRoot).digest('hex').slice(0,24),
     bridge:16,legacyInstance:false,paired:process.env.COS_TEST_CHROME_MODE==='bridgePaired'}
  : String(url).includes('/json/version')
    ? {Browser:process.env.COS_TEST_CHROME_MODE==='wrongBrowser'?'Electron/154':'Chrome/154.0.8037.99',
       webSocketDebuggerUrl:process.env.COS_TEST_CHROME_MODE==='wrongSocket'
         ? 'ws://127.0.0.1:9222/devtools/browser/foreign' : 'ws://127.0.0.1:9444/devtools/browser/owned'}
    : [{type:'page',url:process.env.COS_TEST_CHROME_MODE==='providerTarget'?'https://chatgpt.com/':'about:blank'},
       ...(['foreignWorker','installedEnabled','installedDisabled','bridgePaired','cliEphemeral','cliWrongFlags','cliWrongManifest'].includes(process.env.COS_TEST_CHROME_MODE)
          ? [{type:'service_worker',url:'chrome-extension://'+
            (process.env.COS_TEST_CHROME_MODE==='foreignWorker'?'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa':extId)+'/background.js',
             webSocketDebuggerUrl:'ws://127.0.0.1:9444/devtools/page/owned-worker'}] : [])]
});
cp.spawnSync=(cmd,args,options)=>{
 const mode=process.env.COS_TEST_CHROME_MODE||'valid';
 if(String(cmd).toLowerCase().endsWith('netstat.exe')){netstatCalls++;return {status:0,stdout:
  'TCP [::1]:5173 [::]:0 LISTENING 44444\\r\\n'+
  'TCP 127.0.0.1:8796 0.0.0.0:0 LISTENING 11111\\r\\n'+
  'TCP 127.0.0.1:9333 0.0.0.0:0 LISTENING 11111\\r\\n'+
  (mode==='missing'?'':'TCP 127.0.0.1:9444 0.0.0.0:0 LISTENING '+
    (mode==='foreign'||(mode==='changed'&&netstatCalls>2)?33333:22222)+'\\r\\n')};}
 if(String(cmd).toLowerCase().endsWith('powershell.exe'))return (
  String(args).includes('ProcessId=11111') ? {status:0,stdout:'44444'} :
  String(args).includes('CLI_COMPANION') ?
    (mode==='cliEphemeral'||mode==='cliWrongManifest'||mode==='foreignWorker'
      ?{status:0,stdout:'CLI_COMPANION'}:{status:5,stdout:''}) :
  {status:mode==='foreign'?2:0,stdout:mode==='foreign'?'FOREIGN':'OWNED'});
 return {status:1,stdout:''};
};
const EventEmitter=require('node:events');
const Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(request,parent,isMain) {
 if(request==='ws')return class MockWorkerSocket extends EventEmitter {
  constructor(){super();process.nextTick(()=>this.emit('open'));}
  send(bytes){
   const req=JSON.parse(bytes);
   const manifest={id:extId,name:modeManifestName(),version:'2.1.15',worker:'background.js'};
   process.nextTick(()=>this.emit('message',Buffer.from(JSON.stringify({
    id:req.id,result:{result:{type:'string',value:JSON.stringify(manifest)}}
   }))));
  }
  close(){this.emit('close')}
 };
 return originalLoad.apply(this,arguments);
};
function modeManifestName(){return process.env.COS_TEST_CHROME_MODE==='cliWrongManifest'
 ? 'Unrelated Companion' : 'Luna Forge X7 Companion';}
Module.syncBuiltinESMExports();
`);
      const runCase = (mode: string) => spawnSync(process.execPath, [
        liveProbe, '--run', '--fixture', fixture, '--css-sha256',
        createHash('sha256').update(cssText).digest('hex'), '--html-sha256',
        createHash('sha256').update(htmlText).digest('hex'),
        '--chrome-custody-only', '--chrome-profile', profile
      ], { encoding: 'utf8', timeout: 9000, env: {
        ...process.env, COS_TEST_FIXTURE: fixture, COS_TEST_CHROME_MODE: mode,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require="'+intercept.replaceAll('\\','/')+'"'].filter(Boolean).join(' ')
      } });
      const good = runCase('valid');
      expect(good.status, good.stderr).toBe(0);
      expect(good.stdout).toContain('"chromeProfileOwned":true');
      expect(good.stdout).toContain('"extensionState":"absent"');
      const foreignWorker = runCase('foreignWorker');
      expect(foreignWorker.status).toBe(2);
      expect(foreignWorker.stderr).toContain('worker manifest does not match exact disposable source');
      // Chromium's command-line unpacked extensions can have a genuinely
      // active worker without a persisted Preferences registration. The
      // previous detector incorrectly reported absent despite browser proof.
      const cliWorker = runCase('cliEphemeral');
      expect(cliWorker.status, cliWorker.stderr).toBe(0);
      expect(cliWorker.stdout).toContain('"extensionState":"running_cli_unpaired"');
      const missingCli = runCase('cliWrongFlags');
      expect(missingCli.status).toBe(2);
      expect(missingCli.stderr).toContain('no verified exact disposable extension launch');
      const wrongManifest = runCase('cliWrongManifest');
      expect(wrongManifest.status).toBe(2);
      expect(wrongManifest.stderr).toContain('worker manifest does not match exact disposable source');
      const entryPath = path.join(profile, 'Default', 'Preferences');
      mkdirSync(path.dirname(entryPath), { recursive: true });
      const putExtension = (state: number, sourcePath = path.join(fixture, 'extension')) =>
        writeFileSync(entryPath, JSON.stringify({ extensions: { settings: {
          abcdefghijklmnopabcdefghijklmnop: {
            path: sourcePath, state, location: 4,
            manifest: { manifest_version: 3, name: 'Luna Forge X7 Companion',
              background: { service_worker: 'background.js', type: 'module' } }
          }
        } } }));
      putExtension(1);
      const dormant = runCase('valid');
      expect(dormant.status, dormant.stderr).toBe(0);
      expect(dormant.stdout).toContain('"extensionState":"installed_inactive"');
      const enabled = runCase('installedEnabled');
      expect(enabled.status, enabled.stderr).toBe(0);
      expect(enabled.stdout).toContain('"extensionState":"running_unpaired"');
      const bridgePaired = runCase('bridgePaired');
      expect(bridgePaired.status, bridgePaired.stderr).toBe(0);
      expect(bridgePaired.stdout).toContain('"extensionState":"running_bridge_reports_paired"');
      expect(bridgePaired.stdout).toContain('"connectionReady":false');
      // Chrome 153 on this Windows host stores actual Developer Mode
      // Load unpacked registration in Secure Preferences, without a
      // manifest or enabled-state field. A worker whose public runtime
      // manifest matches is positive evidence of enabled running code;
      // the registry file alone is not proof that it is enabled.
      writeFileSync(entryPath, '{"extensions":{"settings":{}}}');
      const securePath = path.join(profile, 'Default', 'Secure Preferences');
      writeFileSync(securePath, JSON.stringify({ extensions: { settings: {
        abcdefghijklmnopabcdefghijklmnop: {
          path: path.join(fixture, 'extension'), location: 4,
          has_started_service_worker: true
        }
      } } }));
      const secureDormant = runCase('valid');
      expect(secureDormant.status, secureDormant.stderr).toBe(0);
      expect(secureDormant.stdout).toContain('"extensionState":"registered_unverified"');
      const secureActive = runCase('installedEnabled');
      expect(secureActive.status, secureActive.stderr).toBe(0);
      expect(secureActive.stdout).toContain('"extensionState":"running_registered_unpaired"');
      expect(secureActive.stdout).toContain('"registrationVerifiedByWorker":true');
      const secureForeignWorker = runCase('cliWrongManifest');
      expect(secureForeignWorker.status).toBe(2);
      expect(secureForeignWorker.stderr).toContain('worker manifest does not match exact disposable source');
      writeFileSync(securePath, JSON.stringify({ extensions: { settings: {
        abcdefghijklmnopabcdefghijklmnop: {
          path: path.join(fixture, 'extension'), location: 4, state: 0
        }
      } } }));
      const secureDisabled = runCase('installedDisabled');
      expect(secureDisabled.status, secureDisabled.stderr).toBe(0);
      expect(secureDisabled.stdout).toContain('"extensionState":"disabled"');
      putExtension(1);
      const contradictoryStores = runCase('installedEnabled');
      expect(contradictoryStores.status).toBe(2);
      expect(contradictoryStores.stderr).toContain('duplicate Chrome registration');
      writeFileSync(entryPath, '{"extensions":{"settings":{}}}');
      writeFileSync(securePath, '{unparseable');
      const corruptSecure = runCase('installedEnabled');
      expect(corruptSecure.status).toBe(2);
      expect(corruptSecure.stderr).toContain('Chrome Preferences cannot be verified');
      writeFileSync(securePath, '{"extensions":{"settings":{}}}');
      putExtension(0);
      const disabled = runCase('installedDisabled');
      expect(disabled.status, disabled.stderr).toBe(0);
      expect(disabled.stdout).toContain('"extensionState":"disabled"');
      putExtension(1, path.join(fixture, 'unrelated-extension'));
      const wrongPath = runCase('installedEnabled');
      expect(wrongPath.status).toBe(2);
      expect(wrongPath.stderr).toContain('no verified exact disposable extension launch');
      putExtension(7);
      const unknownState = runCase('installedEnabled');
      expect(unknownState.status).toBe(2);
      expect(unknownState.stderr).toContain('companion enabled state cannot be verified');
      putExtension(1);
      const registered = JSON.parse(readFileSync(entryPath, 'utf8'));
      registered.extensions.settings.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb =
        { ...registered.extensions.settings.abcdefghijklmnopabcdefghijklmnop };
      writeFileSync(entryPath, JSON.stringify(registered));
      const duplicate = runCase('installedEnabled');
      expect(duplicate.status).toBe(2);
      expect(duplicate.stderr).toContain('duplicate Chrome registration');
      writeFileSync(entryPath, '{unparseable');
      const corrupt = runCase('installedEnabled');
      expect(corrupt.status).toBe(2);
      expect(corrupt.stderr).toContain('Chrome Preferences cannot be verified');
      // Negative owner tests operate with no companion installed.
      writeFileSync(entryPath, '{"extensions":{"settings":{}}}');
      const foreign = runCase('foreign');
      expect(foreign.status).toBe(2);
      expect(foreign.stderr).toContain('Chrome debugger process is not the isolated profile owner');
      const missing = runCase('missing');
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('Chrome debugger listener is missing or ambiguous');
      const changed = runCase('changed');
      expect(changed.status).toBe(2);
      expect(changed.stderr).toContain('Chrome debugger listener owner changed during inspection');
      for (const mode of ['wrongBrowser', 'wrongSocket']) {
        const invalid = runCase(mode);
        expect(invalid.status, invalid.stderr).toBe(2);
        expect(invalid.stderr).toContain('isolated Chrome browser debugger identity is invalid');
      }
      const provider = runCase('providerTarget');
      expect(provider.status).toBe(2);
      expect(provider.stderr).toContain('include a signed-in provider origin');
      // Junctions in the disposable profile must not redirect preference reads
      // into a different Chrome profile even when the user-data-dir PID matches.
      const redirectedDefault = path.join(fixture, 'foreignDefault');
      mkdirSync(redirectedDefault);
      writeFileSync(path.join(redirectedDefault, 'Preferences'), '{"extensions":{"settings":{}}}');
      rmSync(path.dirname(entryPath), { recursive: true, force: true });
      symlinkSync(redirectedDefault, path.dirname(entryPath), 'junction');
      const linked = runCase('valid');
      expect(linked.status).toBe(2);
      expect(linked.stderr).toContain('Chrome Preferences leaves the isolated profile directory');
      expect(readFileSync(css, 'utf8')).toBe(cssText);
      expect(readFileSync(html, 'utf8')).toBe(htmlText);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('reports a post-spawn owner fence without claiming runtime readiness or recovery authority', () => {
    if (process.platform !== 'win32') return;
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-phase-fence-'));
    const localScript = path.join(root, 'scripts', 'dev-fast.mjs');
    const fakeVite = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const preload = path.join(root, 'redirect.cjs');
    const stateRoot = path.join(root, 'private');
    mkdirSync(path.dirname(localScript), { recursive: true });
    mkdirSync(path.dirname(fakeVite), { recursive: true });
    mkdirSync(stateRoot);
    copyFileSync(script, localScript);
    writeFileSync(fakeVite, 'process.exit(0);');
    writeFileSync(preload, `const os=require('node:os'),net=require('node:net');os.tmpdir=()=>process.env.COS_FIXTURE_ROOT;net.createServer=()=>({unref(){return this},once(){return this},listen(p,h,cb){process.nextTick(cb);return this},close(cb){process.nextTick(cb);return this}});require('node:module').syncBuiltinESMExports();`);
    const checkout = realpathSync.native(root);
    const identity = createHash('sha256').update(checkout).digest('hex').slice(0, 12);
    const lock = path.join(stateRoot, 'chat-on-steroids-fast-dev', identity, '.dev-fast-launch');
    const ownerFile = path.join(lock, 'owner.json');
    const invoke = (...args: string[]) => spawnSync(process.execPath, [localScript, ...args], {
      cwd: root,
      env: { ...process.env, COS_FIXTURE_ROOT: stateRoot, NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` },
      encoding: 'utf8', timeout: 10000
    });
    try {
      mkdirSync(lock, { recursive: true });
      writeFileSync(ownerFile, JSON.stringify({
        schema: 1, checkout, identity, pid: 2_147_483_647, startedAt: '2020-01-01T00:00:00.0000000Z',
        token: '00000000-0000-4000-8000-000000000001', phase: 'spawning'
      }));
      const check = invoke('--check', '--json');
      expect(check.status).toBe(1);
      expect(JSON.parse(check.stdout)).toMatchObject({
        applicationStarted: false, ready: false, launchOwnerUnverified: true,
        launchOwnerPhase: 'spawning', launchOwnerProcess: 'absent',
        failures: expect.arrayContaining(['dev-launch-owner-unverified']),
        developmentUpdateGates: {
          htmlDocument: 'source-unknown-requires-native-qualification',
          preloadCurrentRenderer: 'source-unknown-requires-native-qualification',
          installedProduction: 'codex-release-qualification-required',
          nativeRuntimeVerified: false
        }
      });
      expect(existsSync(ownerFile)).toBe(true);
      // A dead supervisor is useful diagnostic evidence, never proof that
      // its Electron/Vite descendants have exited after a spawn began.
      const birth = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}';$p.CreationDate.ToUniversalTime().ToString('o')`
      ], { encoding: 'utf8', timeout: 4000 });
      expect(birth.status, birth.stderr).toBe(0);
      const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
      writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: process.pid, startedAt: birth.stdout.trim() }));
      expect(JSON.parse(invoke('--check', '--json').stdout).launchOwnerProcess).toBe('same');
      writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: process.pid }));
      expect(JSON.parse(invoke('--check', '--json').stdout).launchOwnerProcess).toBe('reused');
      writeFileSync(ownerFile, JSON.stringify(owner));
      const recover = invoke('--recover');
      expect(recover.status).toBe(1);
      expect(existsSync(ownerFile)).toBe(true);
      writeFileSync(ownerFile, '{invalid-json');
      expect(JSON.parse(invoke('--check', '--json').stdout)).toMatchObject({
        launchOwnerPhase: 'unknown', launchOwnerProcess: 'unknown'
      });
      expect(existsSync(ownerFile)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 12000);

  it('reclaims only independently cleared post-spawn custody, preserving competing claims', async () => {
    if (process.platform !== 'win32') return;
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-postspawn-'));
    const localScript = path.join(root, 'scripts', 'dev-fast.mjs');
    const fakeVite = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const preload = path.join(root, 'fixture.cjs');
    const privateTemp = path.join(root, 'private');
    mkdirSync(path.dirname(localScript), { recursive: true });
    mkdirSync(path.dirname(fakeVite), { recursive: true });
    mkdirSync(privateTemp);
    copyFileSync(script, localScript);
    writeFileSync(fakeVite, 'process.exit(0);');
    writeFileSync(preload, `const os=require('node:os');os.tmpdir=()=>process.env.COS_TEST_PRIVATE_TEMP;require('node:module').syncBuiltinESMExports();` + isolatedBridgePortProbePreload);
    const checkout = realpathSync.native(root);
    const identity = createHash('sha256').update(checkout).digest('hex').slice(0, 12);
    const state = path.join(privateTemp, 'chat-on-steroids-fast-dev', identity);
    const lock = path.join(state, '.dev-fast-launch');
    const ownerFile = path.join(lock, 'owner.json');
    const run = (...args: string[]) => spawnSync(process.execPath, [localScript, ...args], {
      cwd: root, encoding: 'utf8', timeout: 16000,
      env: { ...process.env, COS_TEST_PRIVATE_TEMP: privateTemp,
        NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` }
    });
    const old = '2020-01-01T00:00:00.0000000Z';
    const exitedProcessPid = () => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      if (!child.pid) return reject(new Error('missing disposable pid'));
      child.once('close', () => resolve(child.pid!));
      child.once('error', reject);
    });
    const owner = { schema: 1, checkout, identity, token: '00000000-0000-4000-8000-000000000007',
      pid: await exitedProcessPid(), startedAt: old, phase: 'spawning',
      childPid: await exitedProcessPid(), childStartedAt: old, bridgePort: 8796,
      rendererPort: 5173, debugPort: null };
    try {
      mkdirSync(lock, { recursive: true });
      writeFileSync(ownerFile, JSON.stringify(owner));
      const safe = run('--recover');
      expect(safe.status, safe.stderr).toBe(0);
      expect(safe.stdout).toContain('verified post-spawn');
      expect(existsSync(lock)).toBe(false);
      expect(run('--recover').status).toBe(1); // No repeated claim/recovery.
      // Repeated recovery must not consume another launch's new reservation.
      mkdirSync(lock);
      const competitor = { ...owner, token: '00000000-0000-4000-8000-000000000009',
        childPid: process.pid };
      writeFileSync(ownerFile, JSON.stringify(competitor));
      const competing = run('--recover');
      expect(competing.status).toBe(1);
      expect(readFileSync(ownerFile, 'utf8')).toBe(JSON.stringify(competitor));
      writeFileSync(ownerFile, JSON.stringify({ ...owner, bridgePort: 8795 }));
      expect(run('--recover').status).toBe(1); // Recorded port cannot silently shift.
      expect(existsSync(ownerFile)).toBe(true);
      const occupied = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          occupied.once('error', reject);
          occupied.listen(0, '127.0.0.1', resolve);
        });
        const assigned = occupied.address();
        if (!assigned || typeof assigned === 'string') throw Error('No temporary test port');
        writeFileSync(ownerFile, JSON.stringify({ ...owner, debugPort: assigned.port }));
        expect(run('--recover').status).toBe(1); // Independent listener now owns a recorded port.
        expect(existsSync(ownerFile)).toBe(true);
      } finally {
        await new Promise<void>(resolve => occupied.close(() => resolve()));
      }
      // Legacy/incomplete post-spawn custody stays blocked, even with dead PIDs.
      writeFileSync(ownerFile, JSON.stringify({ ...owner, childPid: undefined }));
      expect(run('--recover').status).toBe(1);
      // A real task-owned descendant can survive a terminated node launcher.
      // Parent PID is gone and private ports are free, but its child still
      // retains ParentProcessId, so the recovery census must refuse.
      const tag = 'cos-dev-postspawn-descendant-' + Date.now();
      const launcher = spawn(process.execPath, ['-e',
        `const {spawn}=require('node:child_process');` +
        `const p=spawn(process.execPath,['-e',${JSON.stringify(`setInterval(() => {},1000); /* ${tag} */`)}],` +
        `{detached:true,stdio:'ignore'});console.log(p.pid);p.unref();`],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let descendantPid = 0;
      let captured = '';
      launcher.stdout.on('data', chunk => { captured += String(chunk); });
      try {
        await new Promise<void>((resolve, reject) => {
          launcher.once('close', code => code === 0 ? resolve() : reject(Error('fixture ancestor did not exit cleanly')));
          launcher.once('error', reject);
        });
        descendantPid = Number(captured.trim());
        expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
        writeFileSync(ownerFile, JSON.stringify({ ...owner, childPid: launcher.pid }));
        const orphan = run('--recover');
        expect(orphan.status, orphan.stderr).toBe(1);
        expect(existsSync(ownerFile)).toBe(true);
      } finally {
        // Only terminate the child we started, after confirming both the
        // ancestor PID and unique task marker in the current Windows record.
        if (descendantPid > 0) {
          const processLineage = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${descendantPid}';` +
            `if($p -and $p.ParentProcessId -eq ${launcher.pid} -and $p.CommandLine.Contains('${tag}')){'owned'}`
          ], { encoding: 'utf8', timeout: 5000 });
          if (processLineage.status === 0 && processLineage.stdout.trim() === 'owned') {
            try { process.kill(descendantPid); } catch { /* Process already exited */ }
            for (let attempt = 0; attempt < 30; attempt++) {
              let alive = true;
              try { process.kill(descendantPid, 0); } catch { alive = false; }
              if (!alive) break;
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
        }
      }
    } finally {
      // Windows briefly retains the working-directory handle after a child
      // exits; bounded cleanup never touches paths outside this new fixture.
      for (let attempt = 0; attempt < 15; attempt++) {
        try { rmSync(root, { recursive: true, force: true }); break; }
        catch (error) {
          if (attempt === 14) throw error;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
    }
  }, 45000);

  it.each(['process-identity-unverified', 'process-census-unverified', 'descendant-or-runtime-present'])(
    'classifies %s as retained unknown post-spawn custody without promoting two absent PIDs to recovery proof', async reason => {
      const source = readFileSync(script, 'utf8');
      const census = source.slice(source.indexOf('const windowsPostSpawnProcessesClear ='),
        source.indexOf('// A verified private renderer preview'));
      const recovery = source.slice(source.indexOf('const recoverVerifiedPostSpawn ='),
        source.indexOf('// A reservation phase describes'));
      const owner = { schema: 1, phase: 'spawning', checkout: 'C:\\fixture', identity: 'fixture',
        token: '00000000-0000-4000-8000-000000000001', pid: 100, childPid: 200,
        startedAt: '2020-01-01T00:00:00.0000000Z', childStartedAt: '2020-01-01T00:00:00.0000000Z',
        bridgePort: 8796, rendererPort: 5173, debugPort: null };
      let mutations = 0;
      const mutate = () => { mutations++; };
      const result = await vm.runInNewContext(`let recoveryRefusal = null;
        const refuseRecovery = reason => { recoveryRefusal = reason; return false; };
        ${census}\n${recovery}\nrecoverVerifiedPostSpawn().then(ok => ({ ok, reason: recoveryRefusal }));`, {
        process: { platform: 'win32', pid: 300 }, project: owner.checkout, identity: owner.identity,
        userData: 'C:\\fixture\\private', launchLockDir: 'C:\\fixture\\private\\.dev-fast-launch',
        launchOwnerFile: 'C:\\fixture\\private\\.dev-fast-launch\\owner.json',
        bridgePort: 8796, RENDERER_DEFAULT_PORT: 5173, Buffer, path: path.win32,
        lstatSync: () => ({ isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false }),
        realpathSync: { native: (value: string) => value }, readdirSync: () => ['owner.json'],
        readFileSync: () => JSON.stringify(owner), renameSync: mutate, unlinkSync: mutate, rmdirSync: mutate,
        randomUUID: () => 'fixture-claim', portAvailable: async () => true,
        windowsProcessBirth: () => reason === 'process-identity-unverified' ? null : 'absent',
        spawnSync: () => reason === 'descendant-or-runtime-present'
          ? { status: 0, stdout: 'busy', stderr: '' }
          : { status: 1, stdout: '', stderr: 'PRIVATE_CIM_FAILURE' }
      });
      expect(result).toEqual({ ok: false, reason });
      expect(mutations).toBe(0);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_CIM_FAILURE');
    }
  );

  it('recovers only a proven dead pre-spawn Windows reservation and then launches independently', async () => {
    if (process.platform !== 'win32') return;
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-abandoned-'));
    const localScript = path.join(root, 'scripts', 'dev-fast.mjs');
    const fakeVite = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const preload = path.join(root, 'fixture.cjs');
    const stateRoot = path.join(root, 'private');
    const watcherLog = path.join(root, 'watchers.txt');
    mkdirSync(path.dirname(localScript), { recursive: true });
    mkdirSync(path.dirname(fakeVite), { recursive: true });
    mkdirSync(stateRoot);
    copyFileSync(script, localScript);
    writeFileSync(fakeVite, `require('node:fs').appendFileSync(process.env.COS_FIXTURE_WATCHERS, String(process.pid)+'\\n');`);
    writeFileSync(preload, `
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
os.tmpdir = () => process.env.COS_FIXTURE_ROOT;
net.createServer = () => ({ unref(){return this}, once(){return this}, listen(p,h,cb){process.nextTick(cb);return this}, close(cb){process.nextTick(cb);return this} });
const originalWrite = fs.writeFileSync;
fs.writeFileSync = function(file, value, options) {
  const result = originalWrite.apply(this, arguments);
  if (process.env.COS_FIXTURE_DIE_AT_RESERVE === 'yes' && String(file).endsWith('owner.json') && options?.flag === 'wx') process.exit(91);
  return result;
};
require('node:module').syncBuiltinESMExports();
`);
    const run = (options: string[] = [], crash = false) => spawnSync(process.execPath, [localScript, ...options], {
      cwd: root,
      env: {
        ...process.env, COS_FIXTURE_ROOT: stateRoot, COS_FIXTURE_WATCHERS: watcherLog,
        COS_FIXTURE_DIE_AT_RESERVE: crash ? 'yes' : 'no',
        NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"`
      },
      encoding: 'utf8', timeout: 15000
    });
    let fixtureCleanupVerified = true;
    try {
      const crash = run([], true);
      expect(crash.status, crash.stderr).toBe(91);
      expect(existsSync(watcherLog)).toBe(false);
      const checkout = realpathSync.native(root);
      const suffix = createHash('sha256').update(checkout).digest('hex').slice(0, 12);
      const lock = path.join(stateRoot, 'chat-on-steroids-fast-dev', suffix, '.dev-fast-launch');
      expect(existsSync(path.join(lock, 'owner.json'))).toBe(true);
      const recover = run(['--recover']);
      expect(recover.status, recover.stderr).toBe(0);
      expect(recover.stdout).toContain('Recovered abandoned pre-spawn development reservation');
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(watcherLog)).toBe(false);
      // Complete the pre-spawn race before launching a child: later unknown native
      // post-spawn custody must never be forced clear just to reach these assertions.
      expect(run([], true).status).toBe(91);
      const raceRecover = () => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [localScript, '--recover'], {
          cwd: root,
          env: {
            ...process.env, COS_FIXTURE_ROOT: stateRoot, COS_FIXTURE_WATCHERS: watcherLog,
            COS_FIXTURE_DIE_AT_RESERVE: 'no', NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"`
          },
          stdio: ['ignore', 'ignore', 'pipe']
        });
        let stderr = '';
        child.stderr.on('data', data => { stderr += String(data); });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stderr }));
      });
      const competitors = await Promise.all([raceRecover(), raceRecover()]);
      expect(competitors.filter(x => x.code === 0), JSON.stringify(competitors)).toHaveLength(1);
      expect(competitors.filter(x => x.code === 1)).toHaveLength(1);
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(watcherLog)).toBe(false);
      fixtureCleanupVerified = false;
      const nextLaunch = run();
      expect(nextLaunch.status, nextLaunch.stderr).toBe(0);
      expect(readFileSync(watcherLog, 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
      const watcherPid = Number(readFileSync(watcherLog, 'utf8').trim());
      expect(Number.isSafeInteger(watcherPid) && watcherPid > 0).toBe(true);
      // Windows may still report the exited child during the launcher's first
      // census. Retaining that post-spawn lock is the correct conservative
      // result, not permission to force another reservation over it. Reconcile
      // it explicitly through the existing owner after this launcher has exited.
      if (existsSync(lock)) {
        const ownerFile = path.join(lock, 'owner.json');
        const original = readFileSync(ownerFile, 'utf8');
        const owner = JSON.parse(original);
        // Process exit notifications and Win32_Process enumeration are not one
        // atomic event on Windows. Wait for independently observed absence of
        // both exact fixture PIDs; never weaken the real recovery gate or
        // erase an unknown post-spawn reservation merely to satisfy a test.
        if (Number.isSafeInteger(owner.childPid)) expect(owner.childPid).toBe(watcherPid);
        let processTreeAbsent = false;
        for (let attempt = 0; attempt < 18; attempt++) {
          const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.pid} OR ProcessId=${watcherPid}';` +
            `if($null -eq $p){'absent'}else{'present'}`
          ], { encoding: 'utf8', timeout: 5000 });
          if (probe.status === 0 && probe.stdout.trim() === 'absent') {
            processTreeAbsent = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        expect(processTreeAbsent, 'Windows has not independently cleared the fixture watcher PIDs').toBe(true);
        const settled = run(['--recover']);
        if (settled.status === 0) {
          expect(settled.stdout).toContain('Recovered verified post-spawn development reservation');
          expect(existsSync(lock)).toBe(false);
          fixtureCleanupVerified = true;
        } else {
          // Two absent PIDs do not prove that the later full census/listener/recheck
          // succeeded. Preserve an exactly classified refusal as native-unverified,
          // not a recovery success; the separate post-spawn fixture requires success.
          expect(settled.status, settled.stderr).toBe(1);
          const refusal = /Recovery refused \((process-identity-unverified|process-still-present|process-census-unverified|descendant-or-runtime-present|process-identity-changed|listener-unavailable|insufficient-reservation-evidence)\)/.exec(settled.stderr);
          expect(refusal).not.toBeNull();
          expect(settled.stdout).not.toContain('Recovered');
          expect(readFileSync(ownerFile, 'utf8')).toBe(original);
          console.info(`[CoS dev fixture] Post-spawn reconciliation remains native-unverified (${refusal![1]}); exact fixture PIDs are absent, original marker retained, no extra watcher launched.`);
        }
      } else fixtureCleanupVerified = true; // The production exit barrier released its own child.
      expect(readFileSync(watcherLog, 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
    } finally {
      if (fixtureCleanupVerified) rmSync(root, { recursive: true, force: true });
      else console.warn('[CoS dev fixture] Native recovery remains unverified; temporary fixture and reservation retained for inspection.');
    }
  }, 25000);

  it('refuses corrupt, live, foreign-checkout, or potentially spawning reservation custody', () => {
    if (process.platform !== 'win32') return;
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-recover-deny-'));
    const localScript = path.join(root, 'scripts', 'dev-fast.mjs');
    const fakeVite = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const stateRoot = path.join(root, 'private');
    const preload = path.join(root, 'redirect.cjs');
    mkdirSync(path.dirname(localScript), { recursive: true });
    mkdirSync(path.dirname(fakeVite), { recursive: true });
    mkdirSync(stateRoot);
    copyFileSync(script, localScript);
    writeFileSync(fakeVite, `throw new Error('recovery must never spawn a watcher');`);
    writeFileSync(preload, `const os=require('node:os'),net=require('node:net');os.tmpdir=()=>process.env.COS_FIXTURE_ROOT;net.createServer=()=>({unref(){return this},once(){return this},listen(p,h,cb){process.nextTick(cb);return this},close(cb){process.nextTick(cb);return this}});require('node:module').syncBuiltinESMExports();`);
    const checkout = realpathSync.native(root);
    const suffix = createHash('sha256').update(checkout).digest('hex').slice(0, 12);
    const lock = path.join(stateRoot, 'chat-on-steroids-fast-dev', suffix, '.dev-fast-launch');
    mkdirSync(lock, { recursive: true });
    const ownerFile = path.join(lock, 'owner.json');
    const run = () => spawnSync(process.execPath, [localScript, '--recover'], {
      cwd: root,
      env: { ...process.env, COS_FIXTURE_ROOT: stateRoot, NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` },
      encoding: 'utf8', timeout: 12000
    });
    const birth = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}';$p.CreationDate.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 4000 });
    try {
      expect(birth.status, birth.stderr).toBe(0);
      const base = {
        schema: 1, checkout, identity: suffix, pid: process.pid, startedAt: birth.stdout.trim(),
        token: '00000000-0000-4000-8000-000000000001', phase: 'reserved'
      };
      const refuse = (data: string) => {
        writeFileSync(ownerFile, data);
        const result = run();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain('Recovery refused');
        expect(existsSync(ownerFile)).toBe(true);
      };
      refuse('{invalid-json');
      refuse(JSON.stringify(base)); // Same live PID and immutable creation time.
      refuse(JSON.stringify({ ...base, checkout: root + '-foreign' }));
      refuse(JSON.stringify({ ...base, phase: 'spawning', startedAt: '2020-01-01T00:00:00.0000000Z' }));
      refuse(JSON.stringify({ ...base, startedAt: 'not-a-process-time' }));
      // Simulate a reused PID: its current immutable creation time differs from the
      // recorded one, so the *old* pre-spawn owner is positively no longer that PID.
      writeFileSync(ownerFile, JSON.stringify({ ...base, startedAt: '2020-01-01T00:00:00.0000000Z' }));
      const recovered = run();
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  it('resolves owned reservations after failed spawn creation, failing child exit, and later clean launch', async () => {
    if (process.platform !== 'win32') return;
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-child-failure-'));
    const localScript = path.join(root, 'scripts', 'dev-fast.mjs');
    const fakeVite = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const stateRoot = path.join(root, 'private');
    const preload = path.join(root, 'redirect.cjs');
    mkdirSync(path.dirname(localScript), { recursive: true });
    mkdirSync(path.dirname(fakeVite), { recursive: true });
    mkdirSync(stateRoot);
    copyFileSync(script, localScript);
    writeFileSync(preload, `
const os=require('node:os'),net=require('node:net'),cp=require('node:child_process');
os.tmpdir=()=>process.env.COS_FIXTURE_ROOT;
net.createServer=()=>({unref(){return this},once(){return this},listen(p,h,cb){process.nextTick(cb);return this},close(cb){process.nextTick(cb);return this}});
const originalSpawn=cp.spawn;
cp.spawn=(cmd,args,options)=>{
  if(process.env.COS_FIXTURE_FAIL_SPAWN==='yes' && args?.includes('--watch'))throw new Error('isolated fixture spawn creation refused');
  return originalSpawn(cmd,args,options);
};
require('node:module').syncBuiltinESMExports();
`);
    const run = (spawnFails = false, recovery = false) => spawnSync(process.execPath,
      [localScript, ...(recovery ? ['--recover'] : [])], {
      cwd: root,
      env: { ...process.env, COS_FIXTURE_ROOT: stateRoot, COS_FIXTURE_FAIL_SPAWN: spawnFails ? 'yes' : 'no', NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` },
      encoding: 'utf8', timeout: 15000
    });
    const hash = createHash('sha256').update(realpathSync.native(root)).digest('hex').slice(0, 12);
    const lock = path.join(stateRoot, 'chat-on-steroids-fast-dev', hash, '.dev-fast-launch');
    const confirmRelease = async () => {
      if (!existsSync(lock)) return;
      // Windows may still publish a finished watcher's PID after Node has
      // observed its exit. Keep the real reservation and use the existing
      // explicit recovery only after both fixture PIDs are positively absent.
      const owner = JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      expect(owner).toMatchObject({ phase: 'spawning', pid: expect.any(Number),
        childPid: expect.any(Number) });
      let absent = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const census = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.pid} OR ProcessId=${owner.childPid}';` +
          `if($null -eq $p){'absent'}else{'present'}`
        ], { encoding: 'utf8', timeout: 5000 });
        if (census.status === 0 && census.stdout.trim() === 'absent') {
          absent = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      expect(absent, 'No manual recovery before exact watcher PIDs have cleared').toBe(true);
      const recovered = run(false, true);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout).toContain('verified post-spawn');
      expect(existsSync(lock)).toBe(false);
    };
    try {
      writeFileSync(fakeVite, `process.exit(0);`);
      const failedSpawn = run(true);
      expect(failedSpawn.status).toBe(1);
      expect(failedSpawn.stderr).toContain('Could not create electron-vite watcher process');
      expect(existsSync(lock)).toBe(false);
      writeFileSync(fakeVite, `process.exit(42);`);
      const failing = run();
      expect(failing.status, failing.stderr).toBe(42);
      expect(failing.stderr).toContain('electron-vite stopped (exit-code:42)');
      await confirmRelease();
      writeFileSync(fakeVite, `process.exit(0);`);
      const clean = run();
      expect(clean.status, clean.stderr).toBe(0);
      await confirmRelease();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it('retains the private launch reservation if a watcher exits but its Electron-like descendant survives', async () => {
    if (process.platform !== 'win32') return;
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-watcher-orphan-'));
    const localScript = path.join(root, 'scripts', 'dev-fast.mjs');
    const fakeVite = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const preload = path.join(root, 'fixture.cjs');
    const privateTemp = path.join(root, 'private');
    const childPidFile = path.join(root, 'orphan-pid.txt');
    const tag = 'cos-dev-orphan-proof-' + Date.now();
    mkdirSync(path.dirname(localScript), { recursive: true });
    mkdirSync(path.dirname(fakeVite), { recursive: true });
    mkdirSync(privateTemp);
    copyFileSync(script, localScript);
    writeFileSync(preload,
      `const os=require('node:os');os.tmpdir=()=>process.env.COS_TEST_PRIVATE_TEMP;require('node:module').syncBuiltinESMExports();` + isolatedBridgePortProbePreload);
    writeFileSync(fakeVite, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`setInterval(() => {}, 1000); /* ${tag} */`)}],
  { detached: true, stdio: 'ignore', windowsHide: true });
writeFileSync(process.env.COS_TEST_CHILD_PID_FILE, String(child.pid));
child.unref();
setTimeout(() => process.exit(0), 1500);
`);
    const checkout = realpathSync.native(root);
    const identity = createHash('sha256').update(checkout).digest('hex').slice(0, 12);
    const lock = path.join(privateTemp, 'chat-on-steroids-fast-dev', identity, '.dev-fast-launch');
    let orphanPid = 0;
    const run = (...flags: string[]) => spawnSync(process.execPath, [localScript, ...flags], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, COS_TEST_PRIVATE_TEMP: privateTemp,
        COS_TEST_CHILD_PID_FILE: childPidFile, NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` }
    });
    try {
      const first = run();
      expect(first.status, first.stderr).toBe(0);
      orphanPid = Number(readFileSync(childPidFile, 'utf8').trim());
      expect(Number.isSafeInteger(orphanPid) && orphanPid > 0).toBe(true);
      const witness = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${orphanPid}';` +
        `if($p -and $p.CommandLine.Contains('${tag}')){'owned'}`
      ], { encoding: 'utf8', timeout: 5000 });
      expect(witness.stdout.trim()).toBe('owned');
      // A free Vite/bridge port and clean watcher exit do not establish that
      // a surviving child has released this checkout's private Electron state.
      expect(existsSync(path.join(lock, 'owner.json'))).toBe(true);
      expect(JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8'))).toMatchObject({
        phase: 'spawning', childPid: expect.any(Number), childStartedAt: expect.any(String),
        bridgePort: 8796, rendererPort: 5173
      });
      const second = run();
      expect(second.status).toBe(1);
      expect(second.stderr).toMatch(/dev-launch-owner-unverified|Cannot verify ownership of unverified occupied bridge ports/);
      // Once the exact tagged descendant has been stopped, the existing
      // manually requested recovery path must restore safe launch admission.
      process.kill(orphanPid);
      for (let attempt = 0; attempt < 30; attempt++) {
        let alive = true;
        try { process.kill(orphanPid, 0); } catch { alive = false; }
        if (!alive) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const recovered = run('--recover');
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout).toContain('verified post-spawn');
      expect(existsSync(lock)).toBe(false);
    } finally {
      if (orphanPid > 0) {
        const identityCheck = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${orphanPid}';` +
          `if($p -and $p.CommandLine.Contains('${tag}')){'owned'}`
        ], { encoding: 'utf8', timeout: 5000 });
        if (identityCheck.status === 0 && identityCheck.stdout.trim() === 'owned') {
          try { process.kill(orphanPid); } catch { /* Already exited */ }
        }
      }
      for (let attempt = 0; attempt < 15; attempt++) {
        try { rmSync(root, { recursive: true, force: true }); break; }
        catch (error) {
          if (attempt === 14) throw error;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
    }
  }, 30000);

  it('permits at most one watcher during simultaneous cold starts of one disposable checkout', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-cold-race-'));
    const localScript = path.join(root, 'scripts', 'dev-fast.mjs');
    const fakeVite = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const log = path.join(root, 'watchers.txt');
    const stateRoot = path.join(root, 'isolated-temp');
    const preload = path.join(root, 'redirect-temp.cjs');
    mkdirSync(path.dirname(localScript), { recursive: true });
    mkdirSync(path.dirname(fakeVite), { recursive: true });
    mkdirSync(stateRoot);
    copyFileSync(script, localScript);
    writeFileSync(preload, `
const os = require('node:os');
const net = require('node:net');
os.tmpdir = () => process.env.COS_FAKE_STATE_ROOT;
// Port state is isolated too: a concurrent real service must not decide this race test.
net.createServer = () => ({
  unref() { return this; },
  once() { return this; },
  listen(_port, _host, done) { process.nextTick(done); return this; },
  close(done) { process.nextTick(done); return this; }
});
require('node:module').syncBuiltinESMExports();
`);
    // The fake watcher neither imports Electron nor binds a port. It exposes the cold-start
    // interval between launching a watcher and the development bridge becoming observable.
    writeFileSync(fakeVite, `const fs = require('node:fs'); fs.appendFileSync(process.env.COS_FAKE_WATCH_LOG, process.pid + '\\n'); setTimeout(() => process.exit(0), 1500);`);
    const launch = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [localScript], {
        cwd: root,
        env: {
          ...process.env, COS_FAKE_WATCH_LOG: log, COS_FAKE_STATE_ROOT: stateRoot,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    try {
      const results = await Promise.all([launch(), launch()]);
      expect(existsSync(log), JSON.stringify(results)).toBe(true);
      expect(readFileSync(log, 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
      expect(results.filter(x => x.code === 0)).toHaveLength(1);
      expect(results.filter(x => x.code !== 0)).toHaveLength(1);
      expect(results.some(x => x.stderr.includes('dev-launch-owner-unverified')), JSON.stringify(results)).toBe(true);
      const canonical = process.platform === 'win32' ? realpathSync.native(root) : root;
      const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
      const reservation = path.join(stateRoot, 'chat-on-steroids-fast-dev', hash, '.dev-fast-launch');
      // A simultaneous losing launcher can still be visible during the winner's
      // Windows exit census under load. The winner must retain its post-spawn
      // reservation in that ambiguous instant. Both launchers have positively
      // closed above, so reconcile that exact durable owner through the existing
      // independently verified recovery path before testing a fresh admission.
      if (existsSync(reservation)) {
        const recovered = spawnSync(process.execPath, [localScript, '--recover'], {
          cwd: root,
          env: {
            ...process.env, COS_FAKE_WATCH_LOG: log, COS_FAKE_STATE_ROOT: stateRoot,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ')
          },
          encoding: 'utf8'
        });
        expect(recovered.status, recovered.stderr).toBe(0);
        expect(recovered.stdout).toContain('Recovered verified post-spawn development reservation');
        expect(existsSync(reservation)).toBe(false);
      }
      const restart = await launch();
      expect(restart.code, restart.stderr).toBe(0);
      expect(readFileSync(log, 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
      // Simulate a killed prior launcher without running one. Unknown stale ownership
      // must block new children, not automatically erase possible live-process evidence.
      mkdirSync(reservation);
      const stale = await launch();
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain('dev-launch-owner-unverified');
      expect(readFileSync(log, 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
      const held = spawnSync(process.execPath, [localScript, '--check', '--json'], {
        cwd: root,
        env: {
          ...process.env, COS_FAKE_STATE_ROOT: stateRoot,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ')
        },
        encoding: 'utf8'
      });
      const preflight = JSON.parse(held.stdout);
      expect(held.status).toBe(1);
      expect(preflight.ready).toBe(false);
      expect(preflight.applicationStarted).toBe(false);
      expect(preflight.launchOwnerUnverified).toBe(true);
      expect(preflight.failures).toContain('dev-launch-owner-unverified');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  it('keeps one private development identity for Windows case variants of the same checkout', () => {
    if (process.platform !== 'win32') return;
    const inspect = (pathname: string) => {
      const result = spawnSync(process.execPath, [pathname, '--check', '--json'], { encoding: 'utf8' });
      expect(result.stdout, result.stderr).not.toBe('');
      return JSON.parse(result.stdout);
    };
    const original = inspect(script);
    const differentCase = inspect(script.toLowerCase());
    expect(differentCase.sourceCheckout.toLowerCase()).toBe(original.sourceCheckout.toLowerCase());
    expect(differentCase.isolatedAppData).toBe(original.isolatedAppData);
    expect(differentCase.applicationStarted).toBe(false);
  });

  it('prints launcher help without probing or starting development services', () => {
    const result = spawnSync(process.execPath, [script, '--help'], {
      encoding: 'utf8'
    });

    expect([0, 1], result.stderr).toContain(result.status);
    expect(result.stdout).toContain('Usage: npm run dev -- [electron-vite options]');
    expect(result.stdout).toContain('--check');
    expect(result.stdout).toContain('forwards other options to electron-vite');
    expect(result.stdout).toContain('npm ci                 Install checkout dependencies.');
    expect(result.stdout).toContain('npm run dev -- --check Run a read-only development preflight.');
    expect(result.stdout).toContain('Evidence boundary: --check and --qualify-build are source/build diagnostics only.');
    expect(result.stdout).toContain('Native runtime execution and installed release validation require their own qualification owners.');
  });

  it('can emit bounded machine-readable preflight evidence without starting an app', () => {
    const stateRoot = mkdtempSync(path.join(tmpdir(), 'cos-dev-fast-preflight-state-'));
    const preload = path.join(stateRoot, 'redirect.cjs');
    writeFileSync(preload, "const os=require('node:os'); os.tmpdir=()=>process.env.COS_TEST_STATE_ROOT; require('node:module').syncBuiltinESMExports();" + isolatedBridgePortProbePreload);
    const result = spawnSync(process.execPath, [script, '--check', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        COS_TEST_STATE_ROOT: stateRoot,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/') }"`].filter(Boolean).join(' ')
      }
    });

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.schema).toBe('cos_dev_source_preflight_v1');
    expect(payload.mode).toBe('source-preflight');
    expect(payload.validationRunId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(typeof payload.validationStartedAt).toBe('string');
    expect(typeof payload.validationCompletedAt).toBe('string');
    expect(Date.parse(payload.validationCompletedAt)).toBeGreaterThanOrEqual(Date.parse(payload.validationStartedAt));
    expect(payload.evidenceStatus).toBe('diagnostic-only');
    expect(payload.applicationStarted).toBe(false);
    expect(payload.proven).toContain('source-preflight-prerequisites-were-evaluated');
    expect(payload.notProven).toContain('native-runtime-execution');
    expect(payload.ready).toBe(true);
    expect(payload.developerHandoff).toMatchObject({
      status: 'ready-for-next-validation-step',
      reason: null,
      nextAction: null
    });
    expect(payload.sourceCheckout).toBe(project);
    expect(payload.gitSource.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.gitSource.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.electronVite).toBe('present');
    expect(payload.bridge).toBe('127.0.0.1:8796');
    expect(payload.installedRuntimeChecked).toBe(false);
    expect(payload.developmentUpdateGates).toMatchObject({
      appShellSourceSha256: 'D685C51CDF03056A64FF6C2EC679F79A27EDE061620978C0D30E270C76468C64',
      htmlDocument: 'blocked-by-known-app-shell-navigation-guards',
      preloadCurrentRenderer: 'blocked-by-known-app-shell-navigation-guards',
      nativeRuntimeVerified: false,
      installedProduction: 'codex-release-qualification-required'
    });
    expect(payload.failures).toEqual([]);
  });

  it('pins the reviewed recovery shell to blocked navigation without qualifying modified shell bytes', () => {
    const reviewedBytes = readFileSync(path.join(project, 'src', 'main', 'index.ts'));
    const reviewedHash = 'D685C51CDF03056A64FF6C2EC679F79A27EDE061620978C0D30E270C76468C64';
    const source = reviewedBytes.toString('utf8');
    expect(createHash('sha256').update(reviewedBytes).digest('hex').toUpperCase()).toBe(reviewedHash);
    // The reviewed window body includes view-only recovery and exact-window close
    // handling. Its navigation denials and the complete global owner stay intact.
    const windowOwner = source.slice(source.indexOf('function createWindow(): void {'), source.indexOf('\nfunction showWindow(): void {'));
    const globalStart = source.indexOf("app.on('web-contents-created',");
    const globalOwner = source.slice(globalStart, source.indexOf('\n});', globalStart) + 4);
    expect(createHash('sha256').update(windowOwner).digest('hex')).toBe('6c0662d939caf9eb77d5872bb04a3a5ee71051e02889a25fc05749a54a1eafb1');
    expect(createHash('sha256').update(globalOwner).digest('hex')).toBe('d2ba93164e9364a0483a8b40df6cdd1875c1d619ffa050707d5ac6c05b0c6c65');
    // The historical exact source remains blocked too; neither reviewed hash grants runtime proof.
    const launcher = readFileSync(script, 'utf8');
    const classifier = launcher.slice(launcher.indexOf('  const knownBlockedNavigationSource ='), launcher.indexOf('  const developmentUpdateGates ='));
    expect(vm.runInNewContext(`${classifier}\nnativeDocumentGate`, {
      appShellSourceSha256: 'DBB0B58FC735FFA78C3571675EBC5A88D1830B59ED6D89ECEBBD2E3D6D84D8A6'
    })).toBe('blocked-by-known-app-shell-navigation-guards');
    expect(vm.runInNewContext(`${classifier}\nnativeDocumentGate`, {
      appShellSourceSha256: 'D16376886971CB3546453A0AC8318B1D124EA4A5F39CB5B2C98988BD975FF889'
    })).toBe('blocked-by-known-app-shell-navigation-guards');
    expect(vm.runInNewContext(`${classifier}\nnativeDocumentGate`, {
      appShellSourceSha256: 'CAC17863B34CF9F79082711D9B43C07EA512F53E6346778595FA42C0CFADEA4D'
    })).toBe('blocked-by-known-app-shell-navigation-guards');
    expect(vm.runInNewContext(`${classifier}\nnativeDocumentGate`, {
      appShellSourceSha256: '95A88794E7776F7791928B52ECE23C064B487B0FBBFFF6B7529D0F4B46B3A318'
    })).toBe('blocked-by-known-app-shell-navigation-guards');
    // Exact warm companion controls do not remove navigation owners or permit renderer updates.
    expect(source).toContain("window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));");
    expect(source).toContain("window.webContents.on('will-navigate', (event) => event.preventDefault());");
    expect(source).toContain("window.webContents.on('will-redirect', (event) => event.preventDefault());");
    expect(source).toContain("window.webContents.on('will-attach-webview', (event) => event.preventDefault());");
    expect(source).toContain("contents.setWindowOpenHandler(() => ({ action: 'deny' }));");
    expect(source).toContain("contents.on('will-navigate', (event) => event.preventDefault());");
    expect(source).toContain("contents.on('will-redirect', (event) => event.preventDefault());");
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-shell-fingerprint-'));
    const local = path.join(root, 'scripts', 'dev-fast.mjs');
    const shell = path.join(root, 'src', 'main', 'index.ts');
    try {
      mkdirSync(path.dirname(local), { recursive: true });
      mkdirSync(path.dirname(shell), { recursive: true });
      copyFileSync(script, local);
      for (const [bytes, expectedGate] of [
        [reviewedBytes, 'blocked-by-known-app-shell-navigation-guards'],
        [Buffer.from(source.replace("window.webContents.on('will-navigate', (event) => event.preventDefault());", '')), 'source-unknown-requires-native-qualification'],
        [Buffer.from(source + '\n// Unreviewed shell edit.\n'), 'source-unknown-requires-native-qualification'],
        [Buffer.from(source.replaceAll('\n', '\r\n')), 'source-unknown-requires-native-qualification']
      ] as const) {
        writeFileSync(shell, bytes);
        const result = spawnSync(process.execPath, [local, '--check', '--json'], {
          cwd: root, encoding: 'utf8', timeout: 12000
        });
        expect(result.error).toBeUndefined();
        // Missing fixture dependencies are intentionally not a launch authority.
        expect(result.status, result.stderr).toBe(1);
        const payload = JSON.parse(result.stdout);
        expect(payload.applicationStarted).toBe(false);
        expect(payload.installedRuntimeChecked).toBe(false);
        expect(payload.developmentUpdateGates).toEqual({
          appShellSourceSha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
          htmlDocument: expectedGate,
          preloadCurrentRenderer: expectedGate,
          nativeRuntimeVerified: false,
          installedProduction: 'codex-release-qualification-required'
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies non-custody preflight refusals with an allowed next action', () => {
    const root = mkdtempSync(path.join(project, '.test_tmp', 'chat42-handoff-preflight-refusal-'));
    const local = path.join(root, 'scripts', 'dev-fast.mjs');
    const preload = path.join(root, 'isolated-bridge.cjs');
    try {
      mkdirSync(path.dirname(local), { recursive: true });
      mkdirSync(path.join(root, 'node_modules', 'electron-vite', 'bin'), { recursive: true });
      mkdirSync(path.join(root, '.test_tmp'));
      mkdirSync(path.join(root, 'src', 'main'), { recursive: true });
      writeFileSync(path.join(root, 'src', 'main', 'index.ts'), 'main');
      copyFileSync(script, local);
      writeFileSync(preload, isolatedBridgePortProbePreload);
      // Leave electron-vite absent so the refusal is a dependency boundary,
      // not a custody fixture or a missing ownership artifact.
      const result = spawnSync(process.execPath, [local, '--check', '--json'], {
        cwd: root,
        env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS,
          `--require="${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ') },
        encoding: 'utf8'
      });
      const proof = JSON.parse(result.stdout);
      expect(result.status).toBe(1);
      expect(proof.failures).toContain('electron-vite-missing');
      expect(proof.developerHandoff).toMatchObject({
        status: 'blocked',
        reason: 'development-dependency-missing',
        nextAction: 'install-checkout-dependencies-before-retry',
        retrySafe: 'retry-after-listed-correction-and-fresh-preflight',
        missingEvidence: ['available-development-dependencies'],
        provenance: 'source-preflight-failure-classification'
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps every preflight handoff decision boundary explicit without turning source evidence into runtime proof', () => {
    const result = spawnSync(process.execPath, [script, '--check', '--json'], {
      encoding: 'utf8'
    });
    const proof = JSON.parse(result.stdout);
    expect(proof.developerHandoff).toMatchObject({
      status: expect.any(String),
      retrySafe: expect.any(String),
      missingEvidence: expect.any(Array),
      ownership: expect.any(String),
      provenance: 'source-preflight-failure-classification'
    });
    expect(proof.developerHandoff.reason === null || typeof proof.developerHandoff.reason === 'string').toBe(true);
    expect(proof.developerHandoff.nextAction === null || typeof proof.developerHandoff.nextAction === 'string').toBe(true);
    expect(proof.notProven).toContain('native-runtime-execution');
    expect(proof.installedRuntimeChecked).toBe(false);
  });

  it('refuses conflicting or malformed Electron CDP ports before a disposable watcher can start', async () => {
    const occupied = createServer();
    const fixture = mkdtempSync(path.join(tmpdir(), 'cos-debugger-preflight-'));
    const fixtureScript = path.join(fixture, 'scripts', 'dev-fast.mjs');
    const fakeVite = path.join(fixture, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const watcherReceipt = path.join(fixture, 'watcher-started.txt');
    const privateTemp = path.join(fixture, 'private');
    const preload = path.join(fixture, 'fixture.cjs');
    mkdirSync(path.dirname(fixtureScript), { recursive: true });
    mkdirSync(path.dirname(fakeVite), { recursive: true });
    mkdirSync(privateTemp);
    copyFileSync(script, fixtureScript);
    writeFileSync(fakeVite, `require('node:fs').writeFileSync(process.env.COS_TEST_WATCHER_RECEIPT, 'started');`);
    writeFileSync(preload, `const os=require('node:os');os.tmpdir=()=>process.env.COS_TEST_PRIVATE_TEMP;require('node:module').syncBuiltinESMExports();` + isolatedBridgePortProbePreload);
    try {
      await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(0, '127.0.0.1', resolve);
      });
      const bound = occupied.address();
      if (!bound || typeof bound === 'string') throw Error('No disposable debugger port assigned');
      const flags = ['--', `--remote-debugging-port=${bound.port}`];
      const env = { ...process.env, COS_TEST_PRIVATE_TEMP: privateTemp,
        COS_TEST_WATCHER_RECEIPT: watcherReceipt,
        NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` };
      const check = spawnSync(process.execPath, [script, '--check', '--json', ...flags], {
        cwd: project, env, encoding: 'utf8', timeout: 15000
      });
      const evidence = JSON.parse(check.stdout);
      expect(check.status).toBe(1);
      expect(evidence).toMatchObject({ applicationStarted: false, ready: false,
        requestedDebuggerPort: bound.port,
        debuggerPortAvailable: false,
        failures: expect.arrayContaining(['debugger-port-unavailable']) });
      const run = (extras: string[]) => spawnSync(process.execPath, [fixtureScript, ...extras], {
        cwd: fixture, env, encoding: 'utf8', timeout: 15000
      });
      const collided = run(flags);
      expect(collided.status).toBe(1);
      expect(collided.stderr).toContain('debugger-port-unavailable');
      expect(existsSync(watcherReceipt)).toBe(false);
      const invalid = run(['--', '--remote-debugging-port=invalid']);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('debugger-port-invalid');
      expect(existsSync(watcherReceipt)).toBe(false);
      for (const internal of [5173, 8796]) {
        const reserved = run(['--', `--remote-debugging-port=${internal}`]);
        expect(reserved.status).toBe(1);
        expect(reserved.stderr).toContain('debugger-port-unavailable');
        expect(existsSync(watcherReceipt)).toBe(false);
      }
      await new Promise<void>(resolve => occupied.close(() => resolve()));
      const released = spawnSync(process.execPath, [script, '--check', '--json', ...flags], {
        cwd: project, env, encoding: 'utf8', timeout: 15000
      });
      expect(released.status, released.stderr).toBe(0);
      expect(JSON.parse(released.stdout)).toMatchObject({ applicationStarted: false,
        requestedDebuggerPort: bound.port, debuggerPortAvailable: true,
        ready: true, failures: [] });
      const launched = run(flags);
      expect(launched.status, launched.stderr).toBe(0);
      expect(readFileSync(watcherReceipt, 'utf8')).toBe('started');
    } finally {
      await new Promise<void>(resolve => occupied.listening ? occupied.close(() => resolve()) : resolve());
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 25000);

  it('refuses ready or launch when default renderer port is occupied rather than silently shifting Vite', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'cos-renderer-port-'));
    const preload = path.join(fixtureRoot, 'busy-renderer.cjs');
    writeFileSync(preload, `
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { syncBuiltinESMExports } = require('node:module');
net.createServer = () => {
  const server = new EventEmitter();
  server.unref = () => server;
  server.listen = (port, host, callback) => {
    process.nextTick(() => Number(port) === 5173
      ? server.emit('error', Object.assign(new Error('simulated renderer collision'), { code:'EADDRINUSE' }))
      : callback());
    return server;
  };
  server.close = callback => { process.nextTick(callback); return server; };
  return server;
};
syncBuiltinESMExports();
`);
    const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], {
      cwd: project,
      encoding: 'utf8',
      timeout: 12000,
      env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS,
        `--require="${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ') }
    });
    try {
      const preflight = run(['--check', '--json']);
      expect(preflight.status).toBe(1);
      const payload = JSON.parse(preflight.stdout);
      expect(payload.rendererDefaultPort).toBe(5173);
      expect(payload.rendererDefaultPortAvailable).toBe(false);
      expect(payload.ready).toBe(false);
      expect(payload.failures).toContain('renderer-default-port-unavailable');
      const launch = run([]);
      expect(launch.status).toBe(1);
      expect(launch.stderr).toContain('renderer-default-port-unavailable');
      expect(launch.stdout).not.toContain('Starting Vite/Electron directly');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('does not treat json output as a request to start the development watcher or probe preflight state', () => {
    const result = spawnSync(process.execPath, [script, '--json'], {
      encoding: 'utf8'
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--json requires --check');
    expect(result.stdout).toBe('');
  });

  it('checks exact checkout provenance and missing launch prerequisites without starting an app', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos dev preflight '));
    const preload = path.join(root, 'intercept.cjs');
    writeFileSync(preload, `
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');

childProcess.spawn = () => { throw new Error('preflight must not start a child process'); };
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => process.env.COS_TEST_DEV_BAD_GIT === '1' && command === 'git'
  ? { status: 1, stdout: '', stderr: '' }
  : originalSpawnSync(command, args, options);
const originalExistsSync = fs.existsSync;
fs.existsSync = file => process.env.COS_TEST_DEV_MISSING_TOOLS === '1' && String(file).endsWith('electron-vite.js')
  ? false : originalExistsSync(file);
net.createServer = () => {
  const server = new EventEmitter();
  server.unref = () => server;
  server.listen = (_port, _host, callback) => {
    if (process.env.COS_TEST_DEV_NO_PORT === '1') {
      process.nextTick(() => server.emit('error', new Error('port occupied')));
    } else {
      process.nextTick(callback);
    }
    return server;
  };
  server.close = callback => { process.nextTick(callback); return server; };
  return server;
};
global.fetch = async () => ({ ok: false });
syncBuiltinESMExports();
`, 'utf8');

    const run = (cwd: string, { checkOnly = true, noPort = false, missingTools = false, badGit = false } = {}) => spawnSync(process.execPath, [script, ...(checkOnly ? ['--check'] : [])], {
      cwd,
      env: {
        ...process.env,
        COS_TEST_DEV_NO_PORT: noPort ? '1' : '0',
        COS_TEST_DEV_MISSING_TOOLS: missingTools ? '1' : '0',
        COS_TEST_DEV_BAD_GIT: badGit ? '1' : '0',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ')
      },
      encoding: 'utf8'
    });

    try {
      const ready = run(root);
      expect(ready.status, ready.stderr).toBe(0);
      expect(ready.stdout).toContain(`Source checkout: ${project}`);
      expect(ready.stdout).toMatch(/Git source: [0-9a-f]{40} \/ [0-9a-f]{40} \(dirty=(true|false)\)/);
      expect(ready.stdout).toContain('electron-vite: present');
      expect(ready.stdout).toContain('Free bridge port: 8796');
      expect(ready.stdout).toContain('Renderer update gate (source only): HTML=blocked-by-known-app-shell-navigation-guards; preload=blocked-by-known-app-shell-navigation-guards');
      expect(ready.stdout).toContain('No in-place runtime proof from --check');
      expect(ready.stdout).toContain('main rebuild restarts dev Electron');
      expect(ready.stdout).toContain('installed/runtime identity not checked');
      expect(ready.stdout).toContain('no application started');
      expect(ready.stdout.length).toBeLessThan(3000);

      const missingTools = run(root, { missingTools: true, badGit: true });
      expect(missingTools.status).toBe(1);
      expect(missingTools.stdout).toContain('Git source: unavailable');
      expect(missingTools.stdout).toContain('electron-vite: missing');

      const missingJson = spawnSync(process.execPath, [script, '--check', '--json'], {
        cwd: root,
        env: {
          ...process.env,
          COS_TEST_DEV_MISSING_TOOLS: '1',
          COS_TEST_DEV_BAD_GIT: '1',
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ')
        },
        encoding: 'utf8'
      });
      expect(missingJson.status).toBe(1);
      const missingPayload = JSON.parse(missingJson.stdout);
      expect(missingPayload.ready).toBe(false);
      expect(missingPayload.failures).toEqual([
        'git-source-unavailable',
        'electron-vite-missing'
      ]);

      const missingNormalLaunch = run(root, { checkOnly: false, missingTools: true });
      expect(missingNormalLaunch.status).toBe(1);
      expect(missingNormalLaunch.stderr).toContain('electron-vite is missing');
      expect(missingNormalLaunch.stdout).not.toContain('Starting Vite/Electron');

      const unavailableBridge = run(root, { noPort: true });
      expect(unavailableBridge.status, unavailableBridge.stderr).toBe(1);
      expect(unavailableBridge.stdout).toContain('Free bridge port: none in 8765-8796');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a second watcher when the exact isolated development bridge is already running', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-occupied-'));
    const preload = path.join(root, 'intercept.cjs');
    const checkoutHash = createHash('sha256').update(project).digest('hex').slice(0, 12);
    const devRoot = path.join(tmpdir(), 'chat-on-steroids-fast-dev', checkoutHash);
    const expectedId = `dev-${createHash('sha256').update(process.platform === 'win32' ? devRoot.toLowerCase() : devRoot).digest('hex').slice(0, 24)}`;
    writeFileSync(preload, `
const net = require('node:net');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { syncBuiltinESMExports } = require('node:module');
childProcess.spawn = () => { throw new Error('a duplicate watcher must not spawn'); };
net.createServer = () => {
  const server = new EventEmitter();
  server.unref = () => server;
  server.listen = (port, _host, callback) => {
    process.nextTick(() => port === Number(process.env.COS_TEST_OCCUPIED_PORT || 8796)
      ? server.emit('error', new Error('occupied')) : callback());
    return server;
  };
  server.close = callback => { process.nextTick(callback); return server; };
  return server;
};
global.fetch = async (_url) => {
  if (process.env.COS_TEST_UNREACHABLE === '1') throw new Error('stale bridge');
  if (process.env.COS_TEST_OVERSIZED_CHUNKED === '1') {
    // Response has no Content-Length; the exact identity appears in an oversized body.
    return new Response(JSON.stringify({ app: 'chat-on-steroids', instanceId: process.env.COS_TEST_DEV_ID,
      legacyInstance: false, padding: 'x'.repeat(16384) }), { status: 200 });
  }
  return new Response(JSON.stringify({
      app: process.env.COS_TEST_WRONG_APP === '1' ? 'unrelated-local-service' : 'chat-on-steroids',
      instanceId: process.env.COS_TEST_SAME_DEV === '1' ? process.env.COS_TEST_DEV_ID : 'local-instance',
      legacyInstance: process.env.COS_TEST_LEGACY === '1',
      bridge: 16,
      paired: process.env.COS_TEST_PAIRED === '1',
      disconnected: process.env.COS_TEST_DISCONNECTED === '1'
  }), { status: 200 });
};
syncBuiltinESMExports();
`, 'utf8');
    const run = (extra: string[], sameDev: boolean, conditions: { occupiedPort?: number; wrongApp?: boolean; unreachable?: boolean; legacy?: boolean; paired?: boolean; disconnected?: boolean; oversizedChunked?: boolean } = {}) => spawnSync(process.execPath, [script, ...extra], {
      encoding: 'utf8',
      env: {
        ...process.env,
        COS_TEST_SAME_DEV: sameDev ? '1' : '0',
        COS_TEST_DEV_ID: expectedId,
        COS_TEST_OCCUPIED_PORT: String(conditions.occupiedPort ?? 8796),
        COS_TEST_WRONG_APP: conditions.wrongApp ? '1' : '0',
        COS_TEST_UNREACHABLE: conditions.unreachable ? '1' : '0',
        COS_TEST_LEGACY: conditions.legacy ? '1' : '0',
        COS_TEST_PAIRED: conditions.paired ? '1' : '0',
        COS_TEST_DISCONNECTED: conditions.disconnected ? '1' : '0',
        COS_TEST_OVERSIZED_CHUNKED: conditions.oversizedChunked ? '1' : '0',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ')
      }
    });
    try {
      const same = run(['--check', '--json'], true);
      expect(same.status, same.stderr).toBe(1);
      const payload = JSON.parse(same.stdout);
      expect(payload.ready).toBe(false);
      expect(payload.existingDevelopmentInstance).toBe('127.0.0.1:8796');
      expect(payload.failures).toContain('dev-instance-already-running');
      expect(payload.applicationStarted).toBe(false);

      const duplicate = run([], true);
      expect(duplicate.status).toBe(1);
      expect(duplicate.stderr).toContain('Development instance already running on 127.0.0.1:8796');
      expect(duplicate.stdout).not.toContain('Starting Vite/Electron');

      const unrelated = run(['--check', '--json'], false);
      expect(unrelated.status, unrelated.stderr).toBe(0);
      const candidate = JSON.parse(unrelated.stdout);
      expect(candidate.ready).toBe(true);
      expect(candidate.bridge).toBe('127.0.0.1:8795');
      expect(candidate.existingDevelopmentInstance).toBeNull();

      // Contract simulation only: a foreign server cannot claim ownership just by echoing
      // the predictable dev root's identity; the companion requires its app marker too.
      const foreign = run(['--check', '--json'], true, { wrongApp: true });
      expect(foreign.status, foreign.stderr).toBe(0);
      expect(JSON.parse(foreign.stdout).existingDevelopmentInstance).toBeNull();

      // A headerless/chunked oversized /hello is not a trustworthy instance receipt.
      // The 500 ms timeout bounds time, not bytes. A local listener must not force an
      // unbounded JSON allocation or impersonate the checkout's watcher this way.
      const oversized = run(['--check', '--json'], true, { oversizedChunked: true });
      expect(oversized.status, oversized.stderr).toBe(1);
      expect(JSON.parse(oversized.stdout)).toMatchObject({
        ready: false,
        existingDevelopmentInstance: null,
        unverifiedBridgePorts: ['127.0.0.1:8796'],
        failures: ['bridge-identity-unverified']
      });

      // An unresponsive occupied port could be this dev app during bridge startup or
      // shutdown. Never use the availability of 8795 to start a competing watcher.
      const unknown = run(['--check', '--json'], true, { unreachable: true });
      expect(unknown.status, unknown.stderr).toBe(1);
      expect(JSON.parse(unknown.stdout)).toMatchObject({
        ready: false,
        applicationStarted: false,
        unverifiedBridgePorts: ['127.0.0.1:8796'],
        failures: ['bridge-identity-unverified']
      });
      const unknownLaunch = run([], true, { unreachable: true });
      expect(unknownLaunch.status).toBe(1);
      expect(unknownLaunch.stderr).toContain('unverified occupied bridge');
      expect(unknownLaunch.stdout).not.toContain('Starting Vite/Electron');

      // A positively identified legacy production bridge still permits an isolated port.
      const legacy = run(['--check', '--json'], true, { legacy: true });
      expect(legacy.status, legacy.stderr).toBe(0);
      expect(JSON.parse(legacy.stdout).bridge).toBe('127.0.0.1:8795');

      // The dev identity belongs to private userData, not the port or prior paired state.
      for (const conditions of [
        { occupiedPort: 8793, paired: true },
        { occupiedPort: 8793, disconnected: true }
      ]) {
        const moved = run(['--check', '--json'], true, conditions);
        expect(moved.status, moved.stderr).toBe(1);
        const identity = JSON.parse(moved.stdout);
        expect(identity.existingDevelopmentInstance).toBe('127.0.0.1:8793');
        expect(identity.failures).toEqual(['dev-instance-already-running']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('enables electron-vite watch mode by default while preserving isolated launch ownership', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-fast-'));
    const capture = path.join(root, 'launch.json');
    const preload = path.join(root, 'intercept.cjs');
    writeFileSync(preload, `
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');

os.tmpdir = () => process.env.COS_TEST_STATE_ROOT;

net.createServer = () => ({
  unref() {},
  once() { return this; },
  listen(_port, _host, callback) { callback(); return this; },
  close(callback) { callback(); return this; }
});

childProcess.spawn = (command, args, options) => {
  fs.writeFileSync(process.env.COS_TEST_DEV_CAPTURE, JSON.stringify({
    command,
    args,
    cwd: options.cwd,
    stdio: options.stdio,
    env: {
      COS_DEV_USER_DATA: options.env.COS_DEV_USER_DATA,
      COS_DEV_BRIDGE_PORT: options.env.COS_DEV_BRIDGE_PORT,
      CLF_DEBUG: options.env.CLF_DEBUG,
      COS_TEST_PASSTHROUGH: options.env.COS_TEST_PASSTHROUGH
    }
  }));
  const child = new EventEmitter();
  child.killed = false;
  child.kill = signal => {
    child.killed = true;
    process.nextTick(() => child.emit('exit', null, signal));
    return true;
  };
  process.nextTick(() => child.emit('exit', 0, null));
  return child;
};

syncBuiltinESMExports();
`, 'utf8');

    try {
      const env = {
        ...process.env,
        COS_TEST_STATE_ROOT: root,
        CLF_DEBUG: 'test-debug',
        COS_TEST_DEV_CAPTURE: capture,
        COS_TEST_PASSTHROUGH: 'kept',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ')
      };
      const result = spawnSync(process.execPath, [script, '--host', '127.0.0.1', '--inspect'], {
        cwd: root,
        env,
        encoding: 'utf8'
      });
      expect(result.status, result.stderr).toBe(0);

      const launch = JSON.parse(readFileSync(capture, 'utf8'));
      const identity = createHash('sha256').update(path.resolve(project)).digest('hex').slice(0, 12);
      expect(launch.command).toBe(process.execPath);
      expect(launch.args).toEqual([
        path.join(project, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
        'dev', '--watch', '--host', '127.0.0.1', '--inspect'
      ]);
      expect(launch.cwd).toBe(project);
      expect(launch.stdio).toBe('inherit');
      expect(launch.env).toEqual({
        COS_DEV_USER_DATA: path.join(root, 'chat-on-steroids-fast-dev', identity),
        COS_DEV_BRIDGE_PORT: '8796',
        CLF_DEBUG: 'test-debug',
        COS_TEST_PASSTHROUGH: 'kept'
      });
      expect(result.stderr).not.toContain('electron-vite stopped');

      // Real electron-vite v5 rejects `--background` as a Vite CLI option. An
      // independently observed npm entrypoint run failed before Electron started.
      // Route only this Electron option after the CLI's `--` separator.
      const background = spawnSync(process.execPath, [script, '--background'], {
        cwd: root, env, encoding: 'utf8'
      });
      expect(background.status, background.stderr).toBe(0);
      expect(JSON.parse(readFileSync(capture, 'utf8')).args).toEqual([
        path.join(project, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
        'dev', '--watch', '--', '--background'
      ]);
      const explicitSeparator = spawnSync(process.execPath,
        [script, '--host', '127.0.0.1', '--', '--background', '--disable-gpu'], {
          cwd: root, env, encoding: 'utf8'
        });
      expect(explicitSeparator.status, explicitSeparator.stderr).toBe(0);
      expect(JSON.parse(readFileSync(capture, 'utf8')).args).toEqual([
        path.join(project, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
        'dev', '--watch', '--host', '127.0.0.1', '--', '--background', '--disable-gpu'
      ]);
      // The real isolated Electron/CDP runtime used this exact Electron-only
      // debugging option. It must not be consumed by electron-vite as a Vite flag
      // or route the caller into the unrelated production Chrome debugger.
      const privateDebug = spawnSync(process.execPath,
        [script, '--', '--background', '--remote-debugging-port=9333'], {
          cwd: root, env, encoding: 'utf8'
        });
      expect(privateDebug.status, privateDebug.stderr).toBe(0);
      expect(JSON.parse(readFileSync(capture, 'utf8')).args).toEqual([
        path.join(project, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
        'dev', '--watch', '--', '--background', '--remote-debugging-port=9333'
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a bounded child-exit diagnosis without changing launcher ownership', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-fast-exit-'));
    const preload = path.join(root, 'intercept.cjs');

    writeFileSync(preload, `
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');

net.createServer = () => ({
  unref() {},
  once() { return this; },
  listen(_port, _host, callback) { callback(); return this; },
  close(callback) { callback(); return this; }
});

childProcess.spawn = () => {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => true;
  process.nextTick(() => child.emit('exit', 17, null));
  return child;
};

syncBuiltinESMExports();
`, 'utf8');

    try {
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/') }"`].filter(Boolean).join(' ')
        },
        encoding: 'utf8'
      });

      expect(result.status).toBe(17);
      expect(result.stderr).toContain('electron-vite stopped (exit-code:17)');
      expect(result.stderr).toContain('Check the watcher output above for the first build or runtime error.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports child startup errors without claiming a launcher runtime failure', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-fast-start-error-'));
    const preload = path.join(root, 'intercept.cjs');

    writeFileSync(preload, `
const childProcess = require('node:child_process');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');

net.createServer = () => ({
  unref() {},
  once() { return this; },
  listen(_port, _host, callback) { callback(); return this; },
  close(callback) { callback(); return this; }
});

childProcess.spawn = () => {
  const child = new (require('node:events').EventEmitter)();
  process.nextTick(() => child.emit('error', new Error('spawn denied')));
  return child;
};

syncBuiltinESMExports();
`, 'utf8');

    try {
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/') }"`].filter(Boolean).join(' ')
        },
        encoding: 'utf8'
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Could not start electron-vite: spawn denied');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not erase a child error when a later exit reports code zero', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-fast-error-exit-'));
    const preload = path.join(root, 'intercept.cjs');

    writeFileSync(preload, `
const childProcess = require('node:child_process');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { syncBuiltinESMExports } = require('node:module');

net.createServer = () => ({
  unref() {},
  once() { return this; },
  listen(_port, _host, callback) { callback(); return this; },
  close(callback) { callback(); return this; }
});

childProcess.spawn = () => {
  const child = new EventEmitter();
  child.killed = false;
  process.nextTick(() => {
    child.emit('error', new Error('watcher launch failed'));
    child.emit('exit', 0, null);
  });
  return child;
};

syncBuiltinESMExports();
`, 'utf8');

    try {
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ')
        },
        encoding: 'utf8'
      });

      expect(result.stderr).toContain('Could not start electron-vite: watcher launch failed');
      expect(result.status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports signal shutdowns separately from child exit failures', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cos-dev-fast-signal-'));
    const preload = path.join(root, 'intercept.cjs');

    writeFileSync(preload, `
const childProcess = require('node:child_process');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');

net.createServer = () => ({
  unref() {},
  once() { return this; },
  listen(_port, _host, callback) { callback(); return this; },
  close(callback) { callback(); return this; }
});

childProcess.spawn = () => {
  const child = new (require('node:events').EventEmitter)();
  child.killed = false;
  process.nextTick(() => process.env.COS_TEST_WINDOWS_CONSOLE_EXIT === '1'
    ? child.emit('exit', 3221225786, null)
    : child.emit('exit', null, 'SIGTERM'));
  return child;
};

syncBuiltinESMExports();
`, 'utf8');

    try {
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/') }"`].filter(Boolean).join(' ')
        },
        encoding: 'utf8'
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Stopped by SIGTERM.');
      expect(result.stderr).not.toContain('electron-vite stopped');

      if (process.platform === 'win32') {
        const ctrlC = spawnSync(process.execPath, [script], {
          cwd: root,
          env: {
            ...process.env,
            COS_TEST_WINDOWS_CONSOLE_EXIT: '1',
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ')
          },
          encoding: 'utf8'
        });
        expect(ctrlC.status).not.toBe(0);
        expect(ctrlC.stdout).toContain('Stopped by Windows console Ctrl+C.');
        expect(ctrlC.stderr).not.toContain('electron-vite stopped');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps Chat-42 transition evidence classes separate when runtime qualification is summarized', () => {
    const { qualifyLiveProof } = createRequire(import.meta.url)(liveProbe);
    const runtimeEvidence = qualifyLiveProof({
      stage: 'verified',
      exitCode: 0,
      evidence: {
        mode: 'watch-preload',
        preloadBuildChanged: true,
        preloadBuiltContainsUniqueApi: true,
        preloadBuiltSha256: 'e'.repeat(64),
        preloadAppliedToRenderer: true,
        preloadBuildRestored: true,
        preloadRendererRestored: true,
        finalRendererConnectionVerified: true
      },
      sourceRestored: { css: true, html: true, preload: true },
      provenance: {
        cssSourceSha256: 'a'.repeat(64),
        htmlSourceSha256: 'b'.repeat(64),
        preloadSourceSha256: 'c'.repeat(64),
        originalPreloadBuildSha256: 'd'.repeat(64),
        changedPreloadBuildSha256: 'e'.repeat(64)
      }
    });

    expect(runtimeEvidence.schema).toBe('cos_dev_native_qualification_v1');
    expect(runtimeEvidence.accepted).toBe(true);
    expect(runtimeEvidence.sourceBuildRuntimeSeparated).toBe(true);
    expect(runtimeEvidence.installedRuntimeVerified).toBe(false);
    expect(runtimeEvidence.provenance).toBeDefined();
  });

  it('does not promote a runtime qualification artifact into installed acceptance', () => {
    const { qualifyLiveProof } = createRequire(import.meta.url)(liveProbe);
    const runtimeEvidence = qualifyLiveProof({
      stage: 'verified',
      exitCode: 0,
      evidence: {
        mode: 'watch-preload',
        preloadBuildChanged: true,
        preloadBuiltContainsUniqueApi: true,
        preloadBuiltSha256: 'e'.repeat(64),
        preloadAppliedToRenderer: true,
        preloadBuildRestored: true,
        preloadRendererRestored: true,
        finalRendererConnectionVerified: true
      },
      sourceRestored: { css: true, html: true, preload: true },
      provenance: {
        cssSourceSha256: 'a'.repeat(64),
        htmlSourceSha256: 'b'.repeat(64),
        preloadSourceSha256: 'c'.repeat(64),
        originalPreloadBuildSha256: 'd'.repeat(64),
        changedPreloadBuildSha256: 'e'.repeat(64)
      }
    });

    expect(runtimeEvidence.accepted).toBe(true);
    expect(runtimeEvidence.verifiedLevel).toBe('isolated-native-electron-current-runtime');
    expect(runtimeEvidence.installedRuntimeVerified).toBe(false);
  });
});

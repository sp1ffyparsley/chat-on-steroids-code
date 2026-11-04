import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const script = fileURLToPath(new URL('../scripts/kill-stray-vitest.mjs', import.meta.url));
const workspace = 'H:\\owned-workspace';
const node = 'C:\\Program Files\\nodejs\\node.exe';
const row = (pid: number, parentPid: number, root = workspace) => ({
  pid, parentPid, name: 'node.exe', birthTicks: '638979000000000000', executablePath: node,
  commandLine: `"${node}" "${root}\\node_modules\\vitest\\vitest.mjs" run --root "${root}"`
});

it('preserves live and foreign Vitest runners instead of selecting every matching PID', async () => {
  const source = readFileSync(script, 'utf8');
  const rows = [row(100, 900), row(200, 901, 'C:\\foreign-workspace'), row(300, 902),
    { pid: 900, parentPid: 1, name: 'cmd.exe', birthTicks: '638978000000000000' }];
  let selected: number[];
  if (!source.includes('export function selectOrphanedVitest')) {
    // Evaluate only the old selector with mocked OS output. Never import/execute
    // its top-level kill loop or signal a real process to demonstrate the defect.
    const start = source.indexOf('function windowsVictims()');
    const end = source.indexOf('function posixVictims()', start);
    selected = vm.runInNewContext(source.slice(start, end) + '\nwindowsVictims()', {
      execFileSync: () => '100\n200\n300\n', process: { pid: 999 }
    }) as number[];
  } else {
    const { selectOrphanedVitest } = await import(pathToFileURL(script).href);
    selected = selectOrphanedVitest({ complete: true, rows }, { workspace, selfPid: 999 }).candidates
      .map((candidate: { pid: number }) => candidate.pid);
  }
  expect([...selected]).toEqual([300]);
});

const load = () => import(pathToFileURL(script).href);
it.each(['split', 'equals'])('accepts a minimal explicit-root orphan: %s', async form => {
  const { selectOrphanedVitest } = await load();
  const candidate = row(300, 902);
  if (form === 'equals') candidate.commandLine = `"${node}" "${workspace}\\node_modules\\vitest\\vitest.mjs" run --root="${workspace}"`;
  expect(selectOrphanedVitest({ complete: true, rows: [candidate] }, { workspace, selfPid: 999 }).candidates)
    .toMatchObject([{ pid: 300, parentPid: 902 }]);
});
it.each(['self', 'implicit-root', 'foreign-root', 'foreign-entry', 'relative-root', 'duplicate-root',
  'quoted-pattern-root', 'config', 'dir', 'project', 'compact-config', 'watch', 'malformed-quote',
  'parent-live', 'parent-birth-missing', 'parent-reused', 'parent-zero', 'birth-missing', 'exe-missing', 'worker', 'root-value-missing'])(
  'retains the %s process without invoking native termination', async boundary => {
    const { reapOrphans } = await load();
    const candidate: any = row(300, 902);
    const rows: any[] = [candidate];
    if (boundary === 'implicit-root') candidate.commandLine = `"${node}" "${workspace}\\node_modules\\vitest\\vitest.mjs" run`;
    if (boundary === 'root-value-missing') candidate.commandLine = `"${node}" "${workspace}\\node_modules\\vitest\\vitest.mjs" run --root`;
    if (boundary === 'foreign-root') candidate.commandLine = candidate.commandLine.replace(`--root "${workspace}"`, '--root C:\\foreign');
    if (boundary === 'foreign-entry') candidate.commandLine = candidate.commandLine.replace(`${workspace}\\node_modules`, 'C:\\foreign\\node_modules');
    if (boundary === 'relative-root') candidate.commandLine = candidate.commandLine.replace(`--root "${workspace}"`, '--root .');
    if (boundary === 'duplicate-root') candidate.commandLine += ` --root="${workspace}"`;
    if (boundary === 'quoted-pattern-root') candidate.commandLine = `"${node}" "${workspace}\\node_modules\\vitest\\vitest.mjs" run -t --root "${workspace}"`;
    if (['config', 'dir', 'project'].includes(boundary)) candidate.commandLine += ` --${boundary}=C:\\foreign`;
    if (boundary === 'compact-config') candidate.commandLine += ' -cC:\\foreign\\vitest.config.ts';
    if (boundary === 'watch') candidate.commandLine += ' --watch';
    if (boundary === 'malformed-quote') candidate.commandLine += ' "unfinished';
    if (boundary.startsWith('parent-') && boundary !== 'parent-zero') rows.push({ pid: 902, parentPid: 1,
      birthTicks: boundary === 'parent-birth-missing' ? undefined : boundary === 'parent-reused'
        ? '638980000000000000' : '638978000000000000' });
    if (boundary === 'parent-zero') candidate.parentPid = 0;
    if (boundary === 'birth-missing') delete candidate.birthTicks;
    if (boundary === 'exe-missing') delete candidate.executablePath;
    if (boundary === 'worker') candidate.commandLine = `"${node}" "${workspace}\\node_modules\\tinypool\\dist\\entry\\process.js"`;
    const terminate = vi.fn();
    const result = reapOrphans({ platform: 'win32', workspace, selfPid: boundary === 'self' ? 300 : 999,
      inventory: () => ({ complete: true, rows }), reap: terminate });
    expect(result.reaped).toBe(0); expect(result.eligible).toBe(0); expect(result.preserved).toBeGreaterThan(0);
    expect(terminate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(candidate.commandLine);
  });

it.each(['incomplete', 'duplicate-pid', 'malformed-row', 'throws'])('fails closed on %s inventory', async mode => {
  const { reapOrphans } = await load(); const terminate = vi.fn();
  const result = reapOrphans({ platform: 'win32', workspace, inventory: () => {
    if (mode === 'throws') throw new Error('private inventory failure');
    return { complete: mode !== 'incomplete', rows: mode === 'malformed-row' ? [null]
      : mode === 'duplicate-pid' ? [row(300, 902), row(300, 903)] : [row(300, 902)] };
  }, reap: terminate });
  expect(result.reasons).toEqual({ 'inventory-unverified': 1 }); expect(terminate).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('private inventory failure');
});

it('reports native races without treating a stale candidate as a completed kill', async () => {
  const { reapOrphans } = await load();
  const result = reapOrphans({ platform: 'win32', workspace, inventory: () => ({ complete: true, rows: [row(300, 902)] }),
    reap: () => ({ status: 'held', reason: 'identity-changed' }) });
  expect(result).toMatchObject({ eligible: 1, reaped: 0, preserved: 1, reasons: { 'identity-changed': 1 } });
});

it('keeps POSIX diagnostic-only instead of falling back to a global PID kill', async () => {
  const { reapOrphans } = await load(); const inventory = vi.fn(), terminate = vi.fn();
  expect(reapOrphans({ platform: 'darwin', inventory, reap: terminate })).toMatchObject({
    status: 'held', reaped: 0, reasons: { 'native-generation-proof-unavailable': 1 }
  });
  expect(inventory).not.toHaveBeenCalled(); expect(terminate).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')('reaps only the real disposable explicit-root orphan after its exact parent exits', async () => {
  const { reapWindowsCandidate, selectOrphanedVitest } = await load();
  const parent = path.resolve(path.dirname(script), '..', '.test_tmp'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'vitest-reaper-owned-'));
  const entry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs'); mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, 'setTimeout(() => {}, 20000);\n');
  const ps = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const inspect = (ids: number[]) => {
    const code = `$ErrorActionPreference='Stop';$rows=@(Get-CimInstance Win32_Process -Filter '${ids.map(id => `ProcessId=${id}`).join(' OR ')}'|ForEach-Object{[pscustomobject]@{pid=[long]$_.ProcessId;parentPid=[long]$_.ParentProcessId;name=$_.Name;birthTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString();handleBirthTicks=[Diagnostics.Process]::GetProcessById($_.ProcessId).StartTime.ToUniversalTime().Ticks.ToString();executablePath=$_.ExecutablePath;commandLine=$_.CommandLine}});ConvertTo-Json -InputObject $rows -Compress`;
    const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', code], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout || '[]') as any[];
  };
  const launcherCode = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,${JSON.stringify([entry, 'run', '--root', root])},{detached:true,stdio:'ignore',windowsHide:true});child.unref();console.log(JSON.stringify({pid:child.pid,parentPid:process.pid}));process.stdin.once('data',()=>process.exit(0));setTimeout(()=>process.exit(3),15000).unref();`;
  const launcher = spawn(process.execPath, ['-e', launcherCode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
  let childPid: number | undefined, birthTicks: string | undefined, childGone = false;
  try {
    const announcement = await new Promise<any>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Owned child announcement absent')), 5000);
      launcher.stdout!.on('data', chunk => { output += chunk.toString(); if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.trim())); } });
      launcher.once('error', reject);
    });
    childPid = announcement.pid; expect(announcement.parentPid).toBe(launcher.pid);
    let rows = inspect([childPid!, launcher.pid!]); const child = rows.find(value => value.pid === childPid);
    expect(child?.parentPid).toBe(launcher.pid); birthTicks = child.birthTicks;
    expect(BigInt(birthTicks!)).toBe(BigInt(child.handleBirthTicks) - BigInt(child.handleBirthTicks) % 10n);
    expect(selectOrphanedVitest({ complete: true, rows }, { workspace: root }).candidates).toEqual([]);
    // Even an outdated inventory that omitted the still-live parent cannot
    // authorize native termination: the handle owner independently recenses it.
    const premature = selectOrphanedVitest({ complete: true, rows: [child] }, { workspace: root }).candidates[0];
    expect(reapWindowsCandidate(premature)).toEqual({ status: 'held', reason: 'parent-present' });
    expect(inspect([childPid!])[0]?.birthTicks).toBe(birthTicks);
    const closed = new Promise<number | null>(resolve => launcher.once('close', resolve)); launcher.stdin!.end('exit\n'); expect(await closed).toBe(0);
    rows = inspect([childPid!, launcher.pid!]); expect(rows.some(value => value.pid === launcher.pid)).toBe(false);
    const candidates = selectOrphanedVitest({ complete: true, rows }, { workspace: root }).candidates;
    expect(candidates).toHaveLength(1);
    expect(reapWindowsCandidate({ ...candidates[0], birthTicks: (BigInt(birthTicks!) + 10n).toString() }))
      .toEqual({ status: 'held', reason: 'identity-changed' });
    expect(inspect([childPid!])[0]?.birthTicks).toBe(birthTicks);
    expect(reapWindowsCandidate(candidates[0])).toEqual({ status: 'reaped', reason: 'exact-orphan-stopped' });
    childGone = !inspect([childPid!]).some(value => value.birthTicks === birthTicks); expect(childGone).toBe(true);
  } finally {
    // The original ChildProcess handle owns only this launcher. The disposable
    // child has its own finite timer; never use an unverified PID cleanup fallback.
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
    if (childPid && !childGone) {
      const deadline = Date.now() + 22000;
      while (Date.now() < deadline) {
        const rows = inspect([childPid]);
        if (!rows.some(value => value.birthTicks === birthTicks)) { childGone = true; break; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    if (childGone && path.dirname(root) === parent && path.basename(root).startsWith('vitest-reaper-owned-'))
      rmSync(root, { recursive: true, force: true });
  }
});

/** Reap only proved, explicit-root Windows Vitest orphans. Unknown ownership is retained. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const birth = value => typeof value === 'string' && /^[1-9][0-9]{16,19}$/.test(value);
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const samePath = (left, right) => path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();

/** Windows quoting, including backslashes before quotes; incomplete arguments stay unread. */
export function windowsArguments(command) {
  if (typeof command !== 'string' || !command || command.length > 32768 || /[\0\r\n]/.test(command)) return null;
  const args = [];
  let at = 0;
  while (at < command.length) {
    while (/[ \t]/.test(command[at] || '') && at < command.length) at++;
    if (at === command.length) break;
    let value = '', quoted = false;
    while (at < command.length) {
      if (!quoted && /[ \t]/.test(command[at])) break;
      let slashes = 0;
      while (command[at] === '\\') { slashes++; at++; }
      if (command[at] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) { value += '"'; at++; }
        else if (quoted && command[at + 1] === '"') { value += '"'; at += 2; }
        else { quoted = !quoted; at++; }
      } else {
        value += '\\'.repeat(slashes);
        if (at < command.length && (quoted || !/[ \t]/.test(command[at]))) value += command[at++];
      }
    }
    if (quoted) return null;
    args.push(value);
    if (args.length > 512) return null;
  }
  return args;
}

/** A script path alone is not cwd proof. Require an explicit, unique absolute Vitest root. */
function workspaceCommand(row, workspace) {
  const args = windowsArguments(row.commandLine);
  if (!args || args.length < 4 || !path.win32.isAbsolute(args[1])) return false;
  if (path.win32.isAbsolute(args[0]) && !samePath(args[0], row.executablePath)) return false;
  if (!path.win32.isAbsolute(args[0]) && !/^node(?:\.exe)?$/i.test(args[0])) return false;
  if (!samePath(args[1], path.win32.join(workspace, 'node_modules', 'vitest', 'vitest.mjs')) || args[2] !== 'run') return false;
  // Put the ownership option first, so a --root-looking test-name/option value
  // later in argv cannot masquerade as the runner's real root.
  const root = args[3] === '--root' ? args[4] : args[3]?.startsWith('--root=') ? args[3].slice(7) : null;
  if (typeof root !== 'string' || !path.win32.isAbsolute(root) || !samePath(root, workspace)) return false;
  for (let index = args[3] === '--root' ? 5 : 4; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--' || /^(?:--(?:root|watch|ui|api|config|dir|workspace|project|projects)(?:[.=]|$)|-[cwr](?:[^-].*)?$)/.test(argument)) return false;
  }
  return true;
}

/** Pure selection, so regressions never need to execute a global process-kill loop. */
export function selectOrphanedVitest(snapshot, { workspace = workspaceRoot, selfPid = process.pid } = {}) {
  const reasons = {};
  const hold = reason => { reasons[reason] = (reasons[reason] || 0) + 1; };
  const candidates = [];
  if (!path.win32.isAbsolute(workspace) || snapshot?.complete !== true || !Array.isArray(snapshot.rows) || snapshot.rows.length > 16384) {
    return { candidates, examined: 0, preserved: 1, reasons: { 'inventory-unverified': 1 } };
  }
  const processes = new Map();
  for (const row of snapshot.rows) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid < 0 || processes.has(row.pid))
      return { candidates, examined: 0, preserved: 1, reasons: { 'inventory-unverified': 1 } };
    processes.set(row.pid, row);
  }
  let examined = 0;
  for (const row of snapshot.rows) {
    if (typeof row.name !== 'string' || row.name.toLowerCase() !== 'node.exe') continue;
    examined++;
    if (row.pid === selfPid) { hold('self'); continue; }
    if (!pid(row.pid) || !pid(row.parentPid) || row.parentPid === row.pid || !birth(row.birthTicks) ||
        typeof row.executablePath !== 'string' || !path.win32.isAbsolute(row.executablePath) ||
        path.win32.basename(row.executablePath).toLowerCase() !== 'node.exe') { hold('identity-unverified'); continue; }
    if (!workspaceCommand(row, workspace)) { hold('workspace-unverified'); continue; }
    const parent = processes.get(row.parentPid);
    if (parent) {
      hold(birth(parent.birthTicks) && BigInt(parent.birthTicks) <= BigInt(row.birthTicks) ? 'parent-live' : 'parent-unverified');
      continue;
    }
    candidates.push(Object.freeze({ pid: row.pid, parentPid: row.parentPid, birthTicks: row.birthTicks,
      executablePath: row.executablePath, commandSha256: digest(row.commandLine) }));
  }
  return { candidates, examined, preserved: Object.values(reasons).reduce((sum, count) => sum + count, 0), reasons };
}

const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function nativeJson(script) {
  return JSON.parse(execFileSync(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }).replace(/^\uFEFF/, '').trim());
}
function windowsInventory() {
  return nativeJson(`$ErrorActionPreference='Stop';$rows=@(Get-CimInstance Win32_Process|ForEach-Object{
    [pscustomobject]@{pid=[long]$_.ProcessId;parentPid=[long]$_.ParentProcessId;name=$_.Name;
      birthTicks=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().Ticks.ToString()}else{$null});
      executablePath=$(if($_.Name -ieq 'node.exe'){$_.ExecutablePath}else{$null});
      commandLine=$(if($_.Name -ieq 'node.exe'){$_.CommandLine}else{$null})}});
    [pscustomobject]@{complete=$true;rows=$rows}|ConvertTo-Json -Depth 4 -Compress`);
}

/** The OS handle pins this process generation; never kill from a stale PID alone. */
export function windowsReapScript(candidate) {
  const encoded = Buffer.from(JSON.stringify(candidate), 'utf8').toString('base64');
  return `$ErrorActionPreference='Stop';$held=$null
$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json
function Result([string]$status,[string]$reason){[pscustomobject]@{status=$status;reason=$reason}|ConvertTo-Json -Compress}
function Current {Get-CimInstance Win32_Process -Filter ('ProcessId='+$expected.pid)}
function Same($row){
  if(-not $row -or $row.ProcessId -ne $expected.pid -or $row.ParentProcessId -ne $expected.parentPid -or
      $row.Name -ine 'node.exe' -or -not $row.CreationDate -or
      $row.CreationDate.ToUniversalTime().Ticks.ToString() -cne $expected.birthTicks -or
      $row.ExecutablePath -ine $expected.executablePath -or $null -eq $row.CommandLine){return $false}
  $hash=[Security.Cryptography.SHA256]::Create()
  try{$actual=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($row.CommandLine)))).Replace('-','').ToLowerInvariant()}
  finally{$hash.Dispose()}
  return $actual -ceq $expected.commandSha256
}
try{
  if(-not (Same (Current))){Result held identity-changed;return}
  if(Get-CimInstance Win32_Process -Filter ('ProcessId='+$expected.parentPid)){Result held parent-present;return}
  $held=[Diagnostics.Process]::GetProcessById([int]$expected.pid);$null=$held.Handle
  # CIM/DMTF publishes microseconds; the retained handle exposes 100ns ticks.
  # Match that fixed provider precision, never a fuzzy time window. The repeated
  # CIM generation comparisons remain exact, and Kill uses this retained handle.
  $handleBirth=$held.StartTime.ToUniversalTime().Ticks
  $handleBirth=($handleBirth-($handleBirth%10)).ToString()
  if($held.HasExited -or $held.MainModule.FileName -ine $expected.executablePath -or
      $handleBirth -cne $expected.birthTicks -or -not (Same (Current))){Result held identity-changed;return}
  if(Get-CimInstance Win32_Process -Filter ('ProcessId='+$expected.parentPid)){Result held parent-present;return}
  if(-not (Same (Current))){Result held identity-changed;return}
  $held.Kill()
  if($held.WaitForExit(5000)){Result reaped exact-orphan-stopped}else{Result held termination-unconfirmed}
}catch{Result held native-proof-unavailable}finally{if($held){$held.Dispose()}}`;
}

export function reapWindowsCandidate(candidate) {
  try {
    const result = nativeJson(windowsReapScript(candidate));
    const reasons = ['identity-changed', 'parent-present', 'exact-orphan-stopped', 'termination-unconfirmed', 'native-proof-unavailable'];
    return result && ['held', 'reaped'].includes(result.status) && reasons.includes(result.reason) &&
      (result.status === 'reaped') === (result.reason === 'exact-orphan-stopped') ? result
      : { status: 'held', reason: 'native-proof-unavailable' };
  } catch { return { status: 'held', reason: 'native-proof-unavailable' }; }
}

export function reapOrphans({ platform = process.platform, workspace = workspaceRoot, selfPid = process.pid,
  inventory = windowsInventory, reap = reapWindowsCandidate } = {}) {
  const guidance = 'Only Vitest run --root <absolute-workspace> processes with proved absent parents qualify; implicit-root and ambiguous runners remain untouched.';
  if (platform !== 'win32') return { schema: 1, status: 'held', platform, examined: 0, eligible: 0, reaped: 0,
    preserved: 1, reasons: { 'native-generation-proof-unavailable': 1 }, guidance: 'POSIX is diagnostic-only: this helper has no atomic native process-generation proof.' };
  let selected;
  try { selected = selectOrphanedVitest(inventory(), { workspace, selfPid }); }
  catch { selected = { candidates: [], examined: 0, preserved: 1, reasons: { 'inventory-unverified': 1 } }; }
  let reaped = 0, preserved = selected.preserved;
  const reasons = { ...selected.reasons };
  for (const candidate of selected.candidates) {
    let result;
    try { result = reap(candidate); } catch { result = null; }
    if (result?.status === 'reaped' && result.reason === 'exact-orphan-stopped') reaped++;
    else { preserved++; const reason = ['identity-changed', 'parent-present', 'termination-unconfirmed'].includes(result?.reason)
      ? result.reason : 'native-proof-unavailable'; reasons[reason] = (reasons[reason] || 0) + 1; }
  }
  return { schema: 1, status: selected.candidates.length === 0 ? 'no-proved-orphans' : preserved ? 'held' : 'complete',
    platform, examined: selected.examined, eligible: selected.candidates.length, reaped, preserved, reasons, guidance };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = process.argv.length === 2 ? reapOrphans() : { schema: 1, status: 'held', reaped: 0,
    reasons: { 'unsupported-cli-arguments': 1 } };
  console.log(JSON.stringify(result));
}

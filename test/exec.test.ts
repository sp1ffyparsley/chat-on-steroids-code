import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envValue, pathEntries } from '../src/main/env.js';
import {
  DEFAULT_TIMEOUT_MS,
  ExecError,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  childEnv,
  findPowerShell,
  launchIndependentWindowsCommand,
  launchCommand,
  normaliseTimeout,
  prepareCommand,
  prepareShellCommand,
  runCommand,
  runPowerShell,
  terminateProcessTree
} from '../src/main/exec.js';
import { IS_WINDOWS, makeTempDir, removeTempDir } from './helpers.js';

let cwd: string;
const node = process.execPath;

beforeAll(async () => {
  cwd = await makeTempDir('clf-exec-');
});

afterAll(async () => {
  await removeTempDir(cwd);
});

describe('runCommand', () => {
  it('runs an executable and captures stdout and the exit code', async () => {
    const result = await runCommand(node, ['-e', 'console.log("hello")'], cwd, 10_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('captures stderr and a non-zero exit code', async () => {
    const result = await runCommand(
      node,
      ['-e', 'console.error("boom"); process.exit(3)'],
      cwd,
      10_000
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.trim()).toBe('boom');
  });

  it('runs in the working directory it was given', async () => {
    const result = await runCommand(node, ['-e', 'console.log(process.cwd())'], cwd, 10_000);
    expect(result.stdout.trim().toLowerCase()).toBe(cwd.toLowerCase());
  });

  it('passes arguments literally, with no shell interpretation', async () => {
    // If a shell were involved, "&& echo pwned" would run as a second command.
    const payload = 'a && echo pwned | more > out.txt';
    const result = await runCommand(
      node,
      ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', payload],
      cwd,
      10_000
    );
    expect(JSON.parse(result.stdout.trim())).toEqual([payload]);
    expect(result.stdout).not.toContain('pwned\r\n');
  });

  it('kills a process that overruns its timeout', async () => {
    const started = Date.now();
    const result = await runCommand(
      node,
      ['-e', 'setInterval(() => {}, 1000)'],
      cwd,
      1500
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it.runIf(!IS_WINDOWS)('kills the whole POSIX process group when a command times out', async () => {
    const pidFile = path.join(cwd, 'timeout-grandchild.pid');
    const survived = path.join(cwd, 'timeout-grandchild-survived.txt');
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survived)}, 'survived'), 1600); setInterval(() => {}, 1000);`;
    const parent = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(${JSON.stringify(node)}, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`;

    const result = await runCommand(node, ['-e', parent], cwd, 1000);
    expect(result.timedOut).toBe(true);
    const grandchildPid = Number.parseInt(await fs.readFile(pidFile, 'utf8'), 10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await expect(fs.access(survived)).rejects.toBeDefined();
    } finally {
      if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
        await terminateProcessTree(grandchildPid, true).catch(() => undefined);
      }
    }
  });

  it('caps stdout and flags the truncation', async () => {
    const result = await runCommand(
      node,
      ['-e', `process.stdout.write("x".repeat(${MAX_OUTPUT_BYTES * 5}))`],
      cwd,
      15_000
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });

  it('caps stderr independently', async () => {
    const result = await runCommand(
      node,
      ['-e', `process.stderr.write("y".repeat(${MAX_OUTPUT_BYTES * 3}))`],
      cwd,
      15_000
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });

  it('passes explicit bounded environment overrides without a shell', async () => {
    const result = await runCommand(
      node,
      ['-e', 'console.log(process.env.CLF_TEST_VALUE ?? "missing")'],
      cwd,
      10_000,
      { TEST_VALUE: 'env-ok' }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('missing');

    const explicit = await runCommand(
      node,
      ['-e', 'console.log(process.env.TEST_VALUE ?? "missing")'],
      cwd,
      10_000,
      { TEST_VALUE: 'env-ok' }
    );
    expect(explicit.stdout.trim()).toBe('env-ok');
  });

  it('rejects environment names reserved for connector internals', async () => {
    await expect(
      runCommand(node, ['-e', 'process.exit(0)'], cwd, 10_000, { CLF_COMMAND: 'nope' })
    ).rejects.toThrow(/reserved/i);
  });

  it('keeps secret environment variables away from the child', async () => {
    process.env.CONTROL_PLANE_API_KEY = 'sk-should-not-leak';
    process.env.OPENAI_API_KEY = 'sk-should-not-leak-either';
    try {
      const result = await runCommand(
        node,
        [
          '-e',
          'console.log(JSON.stringify([process.env.CONTROL_PLANE_API_KEY ?? null, process.env.OPENAI_API_KEY ?? null]))'
        ],
        cwd,
        10_000
      );
      expect(JSON.parse(result.stdout.trim())).toEqual([null, null]);
    } finally {
      delete process.env.CONTROL_PLANE_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('reports a missing executable instead of throwing', async () => {
    const result = await runCommand('definitely-not-a-real-program-xyz', [], cwd, 5000);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/Failed to start/);
  });

  it.runIf(IS_WINDOWS)('resolves Windows .cmd shims such as npm without shell-parsing arguments', async () => {
    const result = await runCommand('npm', ['--version'], cwd, 15_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+/);
  });

  it('launches a long-running executable without waiting for it to exit', async () => {
    const started = Date.now();
    const result = await launchCommand(node, ['-e', 'setTimeout(() => {}, 1500)'], cwd);
    expect(result.pid).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.runIf(IS_WINDOWS)('actually executes a launched PowerShell payload', async () => {
    const shell = findPowerShell();
    expect(shell).not.toBeNull();
    const marker = path.join(cwd, 'launch-marker.txt');
    await fs.rm(marker, { force: true });
    const script = `Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value launched -NoNewline`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = await launchCommand(shell!, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], cwd);
    expect(result.pid).toBeGreaterThan(0);

    // `launchCommand()` resolves at the OS spawn boundary. Completing the PowerShell payload is
    // intentionally outside that acknowledgement, and a full Windows suite can briefly delay a
    // fresh PowerShell process behind antivirus/indexer/native-test load. Keep this proof bounded,
    // but do not turn a 3-second machine-load assumption into a product requirement.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const text = await fs.readFile(marker, 'utf8').catch(() => '');
      if (text === 'launched') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('launchCommand reported spawn but the PowerShell payload never executed');
  });

  it.runIf(IS_WINDOWS)('requires an exact Windows OS-broker ReturnValue and PID receipt without a child fallback', async () => {
    const base = { stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    const run = async (stdout: string, exitCode: number | null = 0) => ({ ...base, stdout, exitCode });

    await expect(launchIndependentWindowsCommand(node, [], cwd, 'visible', async () =>
      run('CLF_WINDOWS_LAUNCH_RECEIPT={"returnValue":0,"processId":4321}\r\n')
    )).resolves.toEqual({ pid: 4321 });
    await expect(launchIndependentWindowsCommand(node, [], cwd, 'visible', async () =>
      run('CLF_WINDOWS_LAUNCH_RECEIPT={"returnValue":2,"processId":0}\r\n')
    )).rejects.toThrow(/Win32_Process\.Create result=2.*No direct-child fallback/i);
    await expect(launchIndependentWindowsCommand(node, [], cwd, 'visible', async () =>
      run('unrelated output only\r\n')
    )).rejects.toThrow(/valid ReturnValue.*PID receipt.*No direct-child fallback/i);
    for (const malformed of ['null', '[]', '"primitive"']) {
      await expect(launchIndependentWindowsCommand(node, [], cwd, 'visible', async () =>
        run(`CLF_WINDOWS_LAUNCH_RECEIPT=${malformed}\r\n`)
      )).rejects.toThrow(/invalid ReturnValue.*PID receipt.*ambiguous.*No direct-child fallback/i);
    }
    await expect(launchIndependentWindowsCommand(node, [], cwd, 'visible', async () =>
      run('CLF_WINDOWS_LAUNCH_RECEIPT={"returnValue":"0","processId":"4321"}\r\n')
    )).rejects.toThrow(/Win32_Process\.Create result=invalid.*No direct-child fallback/i);
    await expect(launchIndependentWindowsCommand(node, [], cwd, 'visible', async () =>
      run('', 7)
    )).rejects.toThrow(/PowerShell exited with code 7.*No direct-child fallback/i);
    await expect(launchIndependentWindowsCommand(node, [], cwd, 'visible', async () => ({
      ...base, stdout: '', exitCode: null, timedOut: true
    }))).rejects.toThrow(/timed out.*ambiguous.*No direct-child fallback/i);
    await expect(launchIndependentWindowsCommand(node, [], cwd, 'visible', async () => ({
      ...base, stdout: '', exitCode: 0, truncated: true
    }))).rejects.toThrow(/truncated.*ambiguous.*No direct-child fallback/i);
    const transportDiagnostic = await launchIndependentWindowsCommand(node, [], cwd, 'visible', async () => {
      throw new Error('CIM transport unavailable for chrome-extension://owner/private-custody-marker');
    }).then(() => '', error => (error as Error).message);
    expect(transportDiagnostic).toMatch(/OS-broker transport failed.*URL details omitted.*No direct-child fallback/i);
    expect(transportDiagnostic).not.toContain('private-custody-marker');
  });

  it.runIf(IS_WINDOWS)('requests explicit job breakaway in the one Windows broker Create', async () => {
    let calls = 0;
    await expect(launchIndependentWindowsCommand(node, [], cwd, 'visible', async (script) => {
      calls++;
      expect(script).toMatch(/Win32_ProcessStartup[^}]+CreateFlags\s*=\s*\[uint32\]16777216/);
      expect(script.match(/Invoke-CimMethod -ClassName Win32_Process -MethodName Create/g)).toHaveLength(1);
      expect(script).toContain('ProcessStartupInformation=$startup');
      return { stdout: 'CLF_WINDOWS_LAUNCH_RECEIPT={"returnValue":0,"processId":4321}\r\n',
        stderr: '', exitCode: 0, truncated: false, timedOut: false, durationMs: 1 };
    })).resolves.toEqual({ pid: 4321 });
    expect(calls).toBe(1);
  });

  it.runIf(IS_WINDOWS)('allows a slow Windows broker one bounded startup window without replaying Create', async () => {
    let calls = 0;
    const result = await launchIndependentWindowsCommand(node, [], cwd, 'visible', async (_script, _cwd, timeoutMs) => {
      calls++;
      const completedInMs = 15_000;
      return { stdout: timeoutMs >= completedInMs ? 'CLF_WINDOWS_LAUNCH_RECEIPT={"returnValue":0,"processId":4321}\r\n' : '',
        stderr: '', exitCode: timeoutMs >= completedInMs ? 0 : null,
        truncated: false, timedOut: timeoutMs < completedInMs, durationMs: Math.min(timeoutMs, completedInMs) };
    });
    expect(result).toEqual({ pid: 4321 });
    expect(calls).toBe(1);
  });

  it.runIf(IS_WINDOWS)('keeps a precisely owned broker child alive after its launcher tree closes', async () => {
    const shell = findPowerShell();
    expect(shell).not.toBeNull();
    const taskkill = path.join(process.env.SystemRoot!, 'System32', 'taskkill.exe');
    const token = `clf-broker-survivor-${process.pid}-${Date.now()}`;
    const argvFile = path.join(cwd, `${token}.json`);
    const expected = ['', 'with spaces', 'a"b', 'C:\\path with space\\', '\\\\"quoted', '日本語', token];
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(1))); setInterval(() => {}, 1000);`;
    let exactBrokerScript = '';
    await launchIndependentWindowsCommand(node, ['-e', childCode, ...expected], cwd, 'minimized', async (script) => {
      exactBrokerScript = script;
      return {
        stdout: `CLF_WINDOWS_LAUNCH_RECEIPT={"returnValue":0,"processId":${process.pid}}\r\n`,
        stderr: '', exitCode: 0, truncated: false, timedOut: false, durationMs: 1
      };
    });
    expect(exactBrokerScript).toContain("-ClassName Win32_Process -MethodName Create");
    expect(exactBrokerScript).toContain('ShowWindow = [uint16]2');
    expect(exactBrokerScript).not.toContain(token);

    const launcherCode = `${exactBrokerScript}; Start-Sleep -Seconds 60`;
    const launcher = spawn(shell!, [
      '-NoProfile', '-NonInteractive', '-NoLogo', '-OutputFormat', 'Text', '-EncodedCommand',
      Buffer.from(launcherCode, 'utf16le').toString('base64')
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let ownedPid: number | undefined;
    try {
      ownedPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Independent browser probe launch timed out: ${output}`)), 15_000);
        launcher.stdout.on('data', chunk => {
          output += chunk.toString();
          const match = /CLF_WINDOWS_LAUNCH_RECEIPT=.*?"processId":(\d+)/.exec(output);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        launcher.stderr.on('data', chunk => { output += chunk.toString(); });
        launcher.once('error', error => { clearTimeout(timer); reject(error); });
        launcher.once('exit', () => { clearTimeout(timer); reject(new Error(`Launcher exited early: ${output}`)); });
      });
      const argvDeadline = Date.now() + 8000;
      while (Date.now() < argvDeadline) {
        if (await fs.readFile(argvFile, 'utf8').catch(() => '') !== '') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(JSON.parse(await fs.readFile(argvFile, 'utf8'))).toEqual(expected);

      const launcherKill = spawnSync(taskkill, ['/PID', String(launcher.pid), '/T', '/F'], {
        encoding: 'utf8', windowsHide: true
      });
      expect(launcherKill.status, launcherKill.stderr).toBe(0);
      const escapedNode = node.replaceAll("'", "''");
      const escapedToken = token.replaceAll("'", "''");
      const check = spawnSync(shell!, ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${ownedPid}' -ErrorAction Stop; if(-not $p -or $p.ParentProcessId -eq ${launcher.pid} -or $p.ExecutablePath -ine '${escapedNode}' -or $p.CommandLine -notlike '*${escapedToken}*'){exit 1}; 'SURVIVED_EXACT_LAUNCHER_TREE'`
      ], { encoding: 'utf8', windowsHide: true });
      expect(check.status, check.stderr).toBe(0);
      expect(check.stdout).toContain('SURVIVED_EXACT_LAUNCHER_TREE');
    } finally {
      if (ownedPid) {
        const escapedNode = node.replaceAll("'", "''");
        const escapedToken = token.replaceAll("'", "''");
        spawnSync(shell!, ['-NoProfile', '-NonInteractive', '-Command',
          `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${ownedPid}' -ErrorAction SilentlyContinue; if($p -and $p.ExecutablePath -ieq '${escapedNode}' -and $p.CommandLine -like '*${escapedToken}*'){Stop-Process -Id ${ownedPid} -Force -ErrorAction Stop}`
        ], { encoding: 'utf8', windowsHide: true });
      }
      if (launcher.exitCode === null && launcher.pid) {
        spawnSync(taskkill, ['/PID', String(launcher.pid), '/T', '/F'], { windowsHide: true });
      }
      await fs.rm(argvFile, { force: true });
    }
  }, 30_000);

  it('rejects an empty command', async () => {
    await expect(runCommand('   ', [], cwd, 5000)).rejects.toBeInstanceOf(ExecError);
  });

  it('rejects null bytes in the command or its arguments', async () => {
    await expect(runCommand('node\0evil', [], cwd, 5000)).rejects.toThrow(/null byte/);
    await expect(runCommand(node, ['ok', 'bad\0arg'], cwd, 5000)).rejects.toThrow(/null byte/);
  });

  it('rejects an absurd number of arguments', async () => {
    const many = Array.from({ length: 200 }, (_, i) => String(i));
    await expect(runCommand(node, many, cwd, 5000)).rejects.toThrow(/Too many arguments/);
  });
});

/**
 * What a spawned child is actually handed.
 *
 * The unit-level rules live in test/env.test.ts; this is the one that would have caught the
 * live incident, because it asks the real `childEnv()` about the real inherited path.
 */
describe('the environment prepared for a child process', () => {

  it.runIf(IS_WINDOWS)('defaults captured Python stdio to UTF-8 without changing the parent or filesystem encoding', () => {
    const held = process.env.PYTHONIOENCODING;
    delete process.env.PYTHONIOENCODING;
    try {
      const env = childEnv();
      expect(envValue(env, 'PYTHONIOENCODING')).toBe('utf-8');
      expect(process.env.PYTHONIOENCODING).toBeUndefined();
      expect(envValue(env, 'PYTHONUTF8')).toBe(envValue(process.env, 'PYTHONUTF8'));
      expect(Object.keys(env).filter(key => key.toLowerCase() === 'pythonioencoding')).toHaveLength(1);
    } finally {
      if (held === undefined) delete process.env.PYTHONIOENCODING;
      else process.env.PYTHONIOENCODING = held;
    }
  });

  it('preserves an inherited Python stdio encoding and lets an explicit override win', () => {
    const held = process.env.PYTHONIOENCODING;
    process.env.PYTHONIOENCODING = 'cp1252';
    try {
      expect(envValue(childEnv(), 'PYTHONIOENCODING')).toBe('cp1252');
      const overrideKey = IS_WINDOWS ? 'pYtHoNiOeNcOdInG' : 'PYTHONIOENCODING';
      const overridden = childEnv({ [overrideKey]: 'utf-16' });
      expect(envValue(overridden, 'PYTHONIOENCODING')).toBe('utf-16');
      if (IS_WINDOWS) expect(Object.keys(overridden).filter(key => key.toLowerCase() === 'pythonioencoding')).toHaveLength(1);
      expect(process.env.PYTHONIOENCODING).toBe('cp1252');
    } finally {
      if (held === undefined) delete process.env.PYTHONIOENCODING;
      else process.env.PYTHONIOENCODING = held;
    }
  });

  it('preserves an explicit empty Python stdio override rather than silently choosing a codec', () => {
    expect(envValue(childEnv({ PYTHONIOENCODING: '' }), 'PYTHONIOENCODING')).toBe('');
  });

  it.runIf(!IS_WINDOWS)('does not introduce a Python stdio default on POSIX', () => {
    const held = process.env.PYTHONIOENCODING;
    delete process.env.PYTHONIOENCODING;
    try { expect(envValue(childEnv(), 'PYTHONIOENCODING')).toBeUndefined(); }
    finally { if (held !== undefined) process.env.PYTHONIOENCODING = held; }
  });

  it('hands over one path variable that still contains the inherited directories', () => {
    const env = childEnv();
    const keys = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
    expect(keys).toHaveLength(1);

    const inherited = pathEntries(process.env).map((entry) => entry.toLowerCase());
    const child = pathEntries(env).map((entry) => entry.toLowerCase());
    for (const entry of inherited) expect(child).toContain(entry);
    // The bundled ripgrep is a prefix, so the child is never shorter than what it inherited.
    expect(child.length).toBeGreaterThanOrEqual(inherited.length);
  });

  it('resolves a command against the same path the child will search', () => {
    const prepared = prepareCommand(node, ['-e', 'process.exit(0)'], cwd);
    const keys = Object.keys(prepared.env ?? {}).filter((key) => key.toLowerCase() === 'path');
    expect(keys).toHaveLength(1);
    expect(pathEntries(prepared.env ?? {}).length).toBeGreaterThan(0);
  });

  it('does not pass connector secrets on, whatever case they arrived in', () => {
    const held = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-should-not-travel';
    try {
      const env = childEnv();
      expect(Object.keys(env).some((key) => key.toLowerCase() === 'openai_api_key')).toBe(false);
    } finally {
      if (held === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = held;
    }
  });
});

describe('normaliseTimeout', () => {
  it('falls back to the default', () => {
    expect(normaliseTimeout(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(normaliseTimeout(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('clamps to the allowed window', () => {
    expect(normaliseTimeout(1)).toBe(1000);
    expect(normaliseTimeout(-5000)).toBe(1000);
    expect(normaliseTimeout(999_999_999)).toBe(MAX_TIMEOUT_MS);
    expect(normaliseTimeout(5000)).toBe(5000);
  });
});

describe.runIf(IS_WINDOWS)('runPowerShell', () => {
  it('finds a PowerShell host', () => {
    expect(findPowerShell()).toBeTruthy();
  });

  it('runs a script and returns its output without CLIXML progress noise', async () => {
    const result = await runPowerShell('Write-Output "hi from ps"', cwd, 30_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hi from ps');
    expect(result.stderr).not.toContain('CLIXML');
    expect(result.stderr).not.toContain('Preparing modules for first use');
  });

  it('turns non-terminating CLIXML errors into readable plain text', async () => {
    const result = await runPowerShell('Write-Error "expected-nonterminating"; Write-Output "continued"', cwd, 30_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('continued');
    expect(result.stderr).toContain('PowerShell error stream (process exited 0)');
    expect(result.stderr).toContain('expected-nonterminating');
    expect(result.stderr).not.toContain('CLIXML');
    expect(result.stderr).not.toContain('_x000D_');
  });

  it('passes shell metacharacters through untouched', async () => {
    // -EncodedCommand means this text never reaches a command-line parser, so the
    // pipes and redirects stay literal data.
    const result = await runPowerShell(
      `$x = 'a & b | c > d ^ e " f'; Write-Output $x`,
      cwd,
      30_000
    );
    expect(result.stdout).toContain('a & b | c > d ^ e " f');
  });

  it('runs in the approved working directory', async () => {
    const result = await runPowerShell('Write-Output (Get-Location).Path', cwd, 30_000);
    expect(result.stdout.trim().toLowerCase()).toBe(cwd.toLowerCase());
  });

  it('surfaces a non-zero exit code', async () => {
    const result = await runPowerShell('exit 7', cwd, 30_000);
    expect(result.exitCode).toBe(7);
  });

  it('kills a script that overruns its timeout', async () => {
    const result = await runPowerShell('Start-Sleep -Seconds 60', cwd, 2000);
    expect(result.timedOut).toBe(true);
  });

  it('rejects an empty script', async () => {
    await expect(runPowerShell('   ', cwd, 5000)).rejects.toBeInstanceOf(ExecError);
  });

  it('rejects an over-long script', async () => {
    await expect(runPowerShell('a'.repeat(9000), cwd, 5000)).rejects.toThrow(/too long/);
  });

  /**
   * Without a console attached, PowerShell encodes what it prints as the machine's OEM code
   * page — 437 here — while this side reads UTF-8. `ä → — …` came back as `84 1a 2d 2e`:
   * mojibake with a control character in the middle of it, from a shell that exited 0. The
   * data was never damaged (the same text in a file or an environment variable arrived
   * intact, and the same command in a terminal was fine), which is what made it read as
   * corruption rather than as the encoding mismatch it was.
   */
  it('brings non-ASCII output back exactly as the script wrote it', async () => {
    const result = await runPowerShell("Write-Output 'ä→—…'", cwd, 30_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ä→—…');
  });

  it('round-trips the whole repertoire, astral characters included', async () => {
    // Deliberately past Latin-1 and past the BMP. The emoji is a surrogate pair, so it
    // exercises both ends at once: the script is handed over as UTF-16LE and comes back as
    // UTF-8, and a mismatch at either end shows up here as a replacement character rather
    // than as a plausible-looking substitution nobody notices.
    const sample = 'äöüß → — … “quotes” 😀';
    const result = await runPowerShell(`Write-Output '${sample}'`, cwd, 30_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(sample);
    expect(result.stdout).not.toContain('�');
  });

  it('reads UTF-8 source text through Get-Content without mojibake', async () => {
    const file = path.join(cwd, 'utf8-source.txt');
    const sample = 'äöüß → — … “quotes” 😀';
    await fs.writeFile(file, sample, 'utf8');

    const result = await runPowerShell(`Get-Content -Raw -LiteralPath ${JSON.stringify(file)}`, cwd, 30_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(sample);
  });

  it('round-trips the same characters on the error stream', async () => {
    // stderr is decoded separately from stdout and cleaned of PowerShell's XML error
    // records on the way through, so it is its own encoding path and its own regression.
    const sample = 'äöüß → — … “quotes” 😀';
    const result = await runPowerShell(`[Console]::Error.WriteLine('${sample}')`, cwd, 30_000);
    expect(result.stderr).toContain(sample);
    expect(result.stderr).not.toContain('�');
  });

  it('starts the captured output with the text, not with a byte-order mark', async () => {
    const result = await runPowerShell("Write-Output 'plain'", cwd, 30_000);
    expect(result.stdout.startsWith('﻿')).toBe(false);
  });
});

/**
 * cmd.exe does not read the quoting Node writes.
 *
 * Node escapes an inner `"` as `\"`, which is the convention for an ordinary Windows
 * program; cmd takes the backslashes literally, so `node -e "console.log(123)"` reached it
 * as something it could not run. The part that makes this a trust bug rather than a bug is
 * what cmd does then: it exits 0. The call was reported as having succeeded, with no
 * output and no side effect — a command that silently did not run.
 *
 * What that line does once it reaches the shell is covered end to end against a real
 * cmd.exe in the process manager's tests, which is the path `exec_command` takes.
 */
describe.runIf(IS_WINDOWS)('the command line prepared for cmd.exe', () => {
  it('hands the line to Windows as written rather than letting Node quote it', () => {
    const prepared = prepareShellCommand('node -e "console.log(1)"', 'cmd');
    expect(prepared.windowsVerbatimArguments).toBe(true);
    // Verbatim and the wrapping quotes are one decision: without the quotes there is no
    // outer pair for `/s` to strip, and a script containing `&` would be split by cmd.
    expect(prepared.args).toEqual(['/d', '/s', '/c', '"node -e "console.log(1)""']);
  });

  it('leaves the PowerShell path on its encoded command', () => {
    const prepared = prepareShellCommand('Write-Output 1', 'powershell');
    expect(prepared.windowsVerbatimArguments).toBeUndefined();
    expect(prepared.args).toContain('-EncodedCommand');
  });
});

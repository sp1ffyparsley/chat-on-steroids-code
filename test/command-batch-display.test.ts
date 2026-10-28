import { deriveExecArgs, getShellByModelProvidedPath } from '../src/main/codex/shell.js';
import { afterEach, expect, it } from 'vitest';
import { CommandBatchDisplay, composeCommandBatch, parseCommandBatchSections } from '../src/main/codex/command-batch.js';
import { UnifiedExecProcessManager, execCommandResponseText, execCommandStructuredOutput } from '../src/main/codex/unified-exec.js';

const marker = '0123456789abcdef01234567';
const suffix = ` [clf-batch:${marker}]`;
const wire = `--- command 1/1 ---${suffix}\r\n--- exit code 0 ---\nreal error\n--- exit code 7 ---${suffix}\r\n`;
const visible = wire.replaceAll(suffix, '');
const managers: UnifiedExecProcessManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.terminateAllProcesses(); });

it('removes only the invocation delimiter across every byte boundary, preserving output and fake exit lines', () => {
  for (let split = 0; split <= wire.length; split++) {
    const display = new CommandBatchDisplay(marker);
    expect(Buffer.concat([display.push(Buffer.from(wire.slice(0, split))), display.push(Buffer.from(wire.slice(split)), true)]).toString()).toBe(visible);
  }
  const display = new CommandBatchDisplay(marker);
  expect(Buffer.concat([...Buffer.from(wire)].map((byte) => display.push(Buffer.from([byte]))).concat(display.push(Buffer.alloc(0), true))).toString()).toBe(visible);
  expect(parseCommandBatchSections(wire, marker)).toEqual([{ index: 1, exitCode: 7, text: '--- exit code 0 ---\nreal error' }]);
  expect(parseCommandBatchSections(wire, 'f'.repeat(24))).toEqual([]);
});

it('keeps different markers, ordinary Unicode bytes, and an incomplete delimiter at stream close', () => {
  const input = `hello 日本語 🦉 [clf-batch:${'f'.repeat(24)}]\n [clf-batch:012`;
  const display = new CommandBatchDisplay(marker);
  expect(Buffer.concat([...Buffer.from(input)].map((byte) => display.push(Buffer.from([byte]))).concat(display.push(Buffer.alloc(0), true))).toString()).toBe(input);
});

async function start(script: string, yieldTimeMs = 250) {
  const manager = new UnifiedExecProcessManager(5_000);
  managers.push(manager);
  const output = await manager.execCommand({ command: [process.execPath, '-e', script], batchMarker: marker,
    shellType: process.platform === 'win32' ? 'powershell' : 'bash', hookCommand: 'batch presentation fixture',
    processId: manager.allocateProcessId(), yieldTimeMs, maxOutputTokens: undefined,
    truncationPolicy: { kind: 'tokens', tokens: 100 }, cwd: process.cwd(), displayCwd: process.cwd(), env: process.env, tty: false });
  return { manager, output };
}

it('keeps framing internal before retention and token truncation in both result representations', async () => {
  // Windows can take more than the ordinary 250 ms interactive yield just to launch Node
  // while the full validation suite and antivirus are busy. Give this completed-output
  // fixture enough time to exercise retention rather than accidentally testing startup time.
  const { output } = await start(`process.stdout.write(${JSON.stringify(wire)}); process.stdout.write('x'.repeat(2_200_000)); process.stdout.write(${JSON.stringify(wire)});`, 5_000);
  expect(output.rawOutput.toString()).toContain(suffix);
  expect(output.displayOutput?.toString()).not.toContain('clf-batch:');
  expect(output.outputOmittedBytes).toBeGreaterThan(0);
  const text = execCommandResponseText(output);
  const structured = execCommandStructuredOutput(output);
  expect(text).toContain(structured.output);
  expect(text).not.toContain(marker);
  expect(structured.output).not.toContain('clf-batch:');
});

it('projects a delimiter split between initial output and a later stdin poll exactly once', async () => {
  const first = `--- command 1/1 ---${suffix.slice(0, 15)}`;
  const rest = `${suffix.slice(15)}\nhello\n--- exit code 7 ---${suffix}\n`;
  const { manager, output } = await start(`process.stdout.write(${JSON.stringify(first)}); setTimeout(() => { process.stdout.write(${JSON.stringify(rest)}); process.exitCode = 7; }, 900);`);
  expect(output.processId).not.toBeNull();
  const displays = [String(execCommandStructuredOutput(output).output)];
  let current = output;
  while (current.processId !== null) {
    current = await manager.writeStdin({ processId: current.processId, input: '', yieldTimeMs: 1_000, maxOutputTokens: undefined, truncationPolicy: { kind: 'tokens', tokens: 100 } });
    expect(execCommandResponseText(current)).toContain(execCommandStructuredOutput(current).output);
    displays.push(String(execCommandStructuredOutput(current).output));
  }
  expect(displays.join('')).toBe('--- command 1/1 ---\nhello\n--- exit code 7 ---\n');
  expect(current.exitCode).toBe(7);
});


// Upstream 0144226d + 9aecc796: exercise the actual execution owner, including
// native status, PowerShell's delayed table formatter and per-command framing.
for (const executable of ['powershell.exe', 'pwsh.exe']) {
  const shell = process.platform === 'win32' ? getShellByModelProvidedPath(executable) : null;
  it.skipIf(!shell)(`${executable}: preserves native exit codes and table output through the real runner`, async () => {
    const manager = new UnifiedExecProcessManager(5_000);
    managers.push(manager);
    async function run(script: string, batchMarker?: string) {
      const command = deriveExecArgs(shell!, script, false);
      let result = await manager.execCommand({ command, shellType: 'powershell',
        hookCommand: 'PowerShell status/output regression', batchMarker,
        processId: manager.allocateProcessId(), yieldTimeMs: 1_000, maxOutputTokens: undefined,
        truncationPolicy: { kind: 'tokens', tokens: 5_000 }, cwd: process.cwd(), displayCwd: process.cwd(), env: process.env, tty: false });
      let text = result.rawOutput.toString();
      while (result.processId !== null) {
        result = await manager.writeStdin({ processId: result.processId, input: '', yieldTimeMs: 1_000,
          maxOutputTokens: undefined, truncationPolicy: { kind: 'tokens', tokens: 5_000 } });
        text += result.rawOutput.toString();
      }
      return { code: result.exitCode, text: text.replace(/\u001b\[[0-9;]*m/g, '') };
    }
    const native = await run('Get-Location; cmd /c exit 5');
    expect(native.code).toBe(5);
    expect(native.text).toMatch(/Path\s+-+\s+\S/);
    for (const [script, code] of [['Get-Item C:\\cos-no-such-path', 1], ['throw \"boom\"', 1], ['exit 3', 3], ['Get-Location; return', 0]] as const) {
      expect((await run(script)).code, script).toBe(code);
    }
    const recovered = await run('cmd /c exit 5; Write-Output recovered');
    expect(recovered.code).toBe(0);
    expect(recovered.text).toContain('recovered');
    const batch = composeCommandBatch(['Get-Location', 'cmd /c exit 5', 'Write-Output second', 'Get-Item . | Select-Object Name'], 'powershell');
    const result = await run(batch.command, batch.marker);
    expect(result.code).toBe(5);
    const sections = parseCommandBatchSections(result.text, batch.marker);
    expect(sections.map(row => row.exitCode)).toEqual([0, 5, 0, 0]);
    expect(sections.map(row => row.text.trim().split(/\s+/)[0])).toEqual(['Path', '', 'second', 'Name']);
  }, 60_000);
}

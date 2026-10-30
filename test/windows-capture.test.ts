import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WINDOWS_CAPTURE_BOOTSTRAP } from '../src/main/computer/windows-capture.js';

const execute = promisify(execFile);

describe.runIf(process.platform === 'win32')('Windows capture runtime', () => {
  it('compiles against installed Windows metadata once and rejects a missing window', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cos-wgc-test-'));
    try {
      const script = path.join(directory, 'capture.ps1');
      await writeFile(script, `$ErrorActionPreference = 'Stop'
${WINDOWS_CAPTURE_BOOTSTRAP}
Initialize-WindowsCapture
$initialAssembly = [CosWindowsCapture].Assembly
Initialize-WindowsCapture
if ([CosWindowsCapture].Assembly -ne $initialAssembly) { throw 'Capture compiled twice' }
try {
  [CosWindowsCapture]::Capture(0, 320, 'unused.png')
  throw 'Missing window was accepted'
} catch {
  if ($_.Exception.ToString() -notmatch 'CAPTURE_FAILED: (target window is closed or minimized|Windows.Graphics.Capture is unavailable)') { throw }
}
Write-Output 'CAPTURE_RUNTIME_VERIFIED'
`, 'utf8');
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 32_768
      });
      expect(stdout.trim()).toBe('CAPTURE_RUNTIME_VERIFIED');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
  it('bounds real native capture dimensions without allocation and reports exact invalid geometry', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cos-wgc-dimensions-'));
    try {
      const script = path.join(directory, 'dimensions.ps1');
      await writeFile(script, `$ErrorActionPreference = 'Stop'
${WINDOWS_CAPTURE_BOOTSTRAP}
Initialize-WindowsCapture
$flags=[Reflection.BindingFlags]'Static,NonPublic'
$validate=[CosWindowsCapture].GetMethod('ValidateCaptureSize',$flags)
if(-not $validate){throw 'Capture size validation owner missing'}
foreach($pair in @(@(1,1),@(4000,8000))){$null=$validate.Invoke($null,@([IntPtr]123,[int]$pair[0],[int]$pair[1]))}
foreach($pair in @(@(0,64),@(64,0),@(-1,64),@(4001,8000),@([int]::MaxValue,[int]::MaxValue))){
  try {$null=$validate.Invoke($null,@([IntPtr]123,[int]$pair[0],[int]$pair[1]));throw 'Invalid capture size accepted'}
  catch {
    $message=$_.Exception.ToString()
    if($message -notmatch 'CAPTURE_FAILED: capture dimensions exceed the pixel limit' -or
       $message -notmatch ('width='+[regex]::Escape([string]$pair[0])+', height='+[regex]::Escape([string]$pair[1])) -or
       $message -notmatch 'hwnd=123' -or $message -notmatch 'maxPixels=32000000'){throw}
  }
}
Write-Output 'CAPTURE_DIMENSIONS_VERIFIED'
`, 'utf8');
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], {
        windowsHide: true, timeout: 15_000, maxBuffer: 32_768
      });
      expect(stdout.trim()).toBe('CAPTURE_DIMENSIONS_VERIFIED');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

});

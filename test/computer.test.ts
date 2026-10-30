import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  act,
  actAndCapture,
  activeWindow,
  findUi,
  focusWindow,
  getWindowState,
  listWindows,
  screenshot,
  waitForWindow
} from '../src/main/computer/index.js';
import { IS_WINDOWS, makeTempDir, removeTempDir } from './helpers.js';

describe.runIf(IS_WINDOWS)('desktop helper', () => {
  // Real UIA/capture contracts need a real window, but arbitrary user windows can
  // be transient or hang their accessibility provider. Own one small native Form
  // for every target-sensitive assertion; never probe browser/Codex UI as a fixture.
  let fixtureWindow = 0, fixtureDirectory = '';
  let fixtureProcess: ChildProcessWithoutNullStreams | null = null;
  let fixtureExit: Promise<void> | null = null;
  beforeAll(async () => {
    fixtureDirectory = await makeTempDir('cos-native-contract-');
    const title = 'CoS native contract ' + randomUUID();
    const closeFile = path.join(fixtureDirectory, 'close');
    const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      'Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition ' + psQuote(
        'public sealed class CosContractForm : System.Windows.Forms.Form { protected override bool ShowWithoutActivation { get { return true; } } }'),
      '$form=New-Object CosContractForm', '$form.Text=' + psQuote(title),
      '$form.ShowInTaskbar=$false', "$form.StartPosition='Manual'",
      '$form.Location=New-Object System.Drawing.Point(8,8)',
      '$form.ClientSize=New-Object System.Drawing.Size(320,180)',
      '$button=New-Object System.Windows.Forms.Button',
      "$button.Text='Fixture action'; $button.AccessibleName='CoS fixture button'",
      '$button.Location=New-Object System.Drawing.Point(24,36)',
      '$button.Size=New-Object System.Drawing.Size(160,48)', '$form.Controls.Add($button)',
      '$timer=New-Object System.Windows.Forms.Timer; $timer.Interval=100',
      '$timer.Add_Tick({ if(Test-Path -LiteralPath ' + psQuote(closeFile) + '){ $form.Close() } })',
      "$form.Add_Shown({ [Console]::WriteLine('READY'); $timer.Start() })",
      'try { [System.Windows.Forms.Application]::Run($form) } finally { $timer.Dispose(); $form.Dispose() }'
    ].join('\n');
    const executable = path.join(process.env['SystemRoot'] || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    fixtureProcess = spawn(executable, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
    const child = fixtureProcess;
    fixtureExit = new Promise(resolve => child.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      let output = '', error = '';
      const timeout = setTimeout(() => reject(new Error('Owned native fixture did not become ready: ' + error)), 15_000);
      child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-2000); });
      child.stdout.on('data', chunk => {
        output = (output + String(chunk)).slice(-2000);
        if (output.includes('READY')) { clearTimeout(timeout); resolve(); }
      });
      child.once('error', failure => { clearTimeout(timeout); reject(failure); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error('Owned native fixture exited before ready: ' + code + ' ' + error)); });
    });
    const { windows } = await listWindows();
    const target = windows.find(window => window.title === title && window.processId === child.pid);
    if (!target) throw new Error('Owned native fixture was not present in the real window inventory');
    fixtureWindow = target.id;
  });
  afterAll(async () => {
    if (fixtureDirectory) await fs.writeFile(path.join(fixtureDirectory, 'close'), 'close owned fixture');
    if (fixtureProcess && fixtureExit) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const closed = await Promise.race([fixtureExit.then(() => true),
        new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), 10_000); })]);
      clearTimeout(timeout);
      if (!closed) { fixtureProcess.kill(); await fixtureExit; } // This test's own Form process only.
    }
    if (fixtureDirectory && path.isAbsolute(fixtureDirectory) &&
        path.dirname(fixtureDirectory) === await fs.realpath(tmpdir()) &&
        path.basename(fixtureDirectory).startsWith('cos-native-contract-')) await removeTempDir(fixtureDirectory);
  });
  const visibleWindow = async (): Promise<number> => fixtureWindow;
  const capturableWindow = async (exclude?: number): Promise<Awaited<ReturnType<typeof screenshot>> | null> =>
    fixtureWindow === exclude ? null : screenshot({ window: fixtureWindow, maxWidth: 320 });

  it('starts once and serves repeated window queries', async () => {
    const first = await listWindows();
    const second = await listWindows();
    expect(first.screen.width).toBeGreaterThan(0);
    expect(first.screen.height).toBeGreaterThan(0);
    expect(Array.isArray(first.windows)).toBe(true);
    expect(second.screen.width).toBe(first.screen.width);
  });

  it('reports the active window without a screenshot', async () => {
    const result = await activeWindow();
    expect(result.screen.width).toBeGreaterThan(0);
    if (result.window) {
      expect(result.window.id).toBeGreaterThan(0);
      expect(result.window.width).toBeGreaterThan(0);
    }
  });

  it('reports a failed focus instead of claiming success', async () => {
    expect(await focusWindow(999_999_999)).toBe(false);
  });

  // Capturing deliberately no longer demands the foreground: looking at a window that
  // something else is covering is a picture, not a failure. A window that does not exist
  // at all is still an error, and it has to say so as one.
  it('captures a window that will not come forward, but refuses one that does not exist', async () => {
    // A closed window is a named code, not a generic helper failure: the model reads
    // WINDOW_NOT_FOUND and goes back to observe rather than retrying the same id.
    await expect(screenshot({ window: 999_999_999, maxWidth: 320 })).rejects.toThrow(
      /WINDOW_NOT_FOUND: window 999999999 is no longer open/
    );
    const shot = await capturableWindow();
    if (!shot) return;
    expect(shot.width).toBeGreaterThan(0);
    expect(typeof shot.focused).toBe('boolean');
  });

  it('does not move foreground focus while observing a background window', async () => {
    const before = (await activeWindow()).window;
    if (!before) return;
    const shot = await capturableWindow(before.id);
    if (!shot) return;
    expect(['window', 'screen_fallback']).toContain(shot.captureMode);
    expect((await activeWindow()).window?.id).toBe(before.id);
  });

  it('crops using coordinates from the most recent returned frame', async () => {
    const base = await screenshot({ window: fixtureWindow, maxWidth: 320 });
    const width = Math.min(100, base.width);
    const height = Math.min(80, base.height);
    const crop = await screenshot({ crop: { x: 0, y: 0, width, height } });
    expect(crop.width).toBe(width);
    expect(crop.height).toBe(height);
    expect(crop.region.width).toBeGreaterThan(0);
    expect(crop.region.height).toBeGreaterThan(0);
  });

  it('waits for an existing visible window without a fixed sleep', async () => {
    const { windows } = await listWindows();
    const candidate = windows.find(window => window.id === fixtureWindow);
    if (!candidate) return;
    const found = await waitForWindow({ process: candidate.process, timeoutMs: 1000 });
    expect(found.process.toLowerCase()).toContain(candidate.process.toLowerCase());
  });

  it('queries Windows UI Automation without requiring a screenshot', async () => {
    const { windows } = await listWindows();
    let result: Awaited<ReturnType<typeof findUi>> | null = null;
    // Live desktops contain short-lived notifications, installer surfaces, and browser
    // windows that can disappear between enumeration and UIA observation. The deterministic
    // protocol tests cover failure semantics; this probe only needs one still-live provider.
    for (const window of windows.filter(window => window.id === fixtureWindow)) {
      try {
        result = await findUi({ window: window.id, role: 'Button', maxResults: 5 });
        break;
      } catch (error) {
        if (!/UIA_FAILED:/.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    if (!result) return;
    expect(result.window).toBeGreaterThan(0);
    expect(Array.isArray(result.elements)).toBe(true);
    expect(result.elements.length).toBeLessThanOrEqual(5);
    expect(result.snapshotId).toBeGreaterThan(0);
    for (const element of result.elements) expect(element.ref).toMatch(/^g\d+_s\d+_e\d+$/);
  });

  it('returns a Codex-style window state with semantic UI refs', async () => {
    const target = await visibleWindow();
    if (target === null) return;
    const state = await getWindowState({ window: target, includeScreenshot: false, maxElements: 8 });
    expect(state.window.id).toBeGreaterThan(0);
    expect(state.screenshot).toBeNull();
    expect(state.elements.length).toBeLessThanOrEqual(8);
    expect(state.snapshotId).toBeGreaterThan(0);
    for (const element of state.elements) expect(element.ref).toMatch(/^g\d+_s\d+_e\d+$/);
  });

  it('refuses an invented semantic element ref instead of clicking cached coordinates', async () => {
    await expect(act([{ type: 'click_ref', ref: 'g1_e999999_999999' }])).rejects.toThrow(/UNKNOWN_UI_REF/);
  });

  it('keeps a recent immutable frame usable across an unrelated observation', async () => {
    const earlier = await screenshot({ window: fixtureWindow, maxWidth: 320 });
    const current = await screenshot({ window: fixtureWindow, maxWidth: 320 });
    expect(current.frameId).toBeGreaterThan(earlier.frameId);

    // Another caller taking a picture no longer invalidates this frame. A window-bound
    // frame is revalidated against its HWND and geometry inside the helper before input.
    await expect(act([{ type: 'move', x: 1, y: 1 }], { frameId: earlier.frameId })).resolves.toBeTruthy();
    await expect(act([{ type: 'move', x: 1, y: 1 }], { frameId: current.frameId })).resolves.toBeTruthy();
    await expect(act([{ type: 'move', x: 1, y: 1 }])).rejects.toThrow(/FRAME_REQUIRED/);
  });

  it('refuses a frame after the bounded immutable history evicts it', async () => {
    const old = await screenshot({ window: fixtureWindow, maxWidth: 320 });
    for (let index = 0; index < 16; index++) await screenshot({ window: fixtureWindow, maxWidth: 320 });
    await expect(act([{ type: 'move', x: 1, y: 1 }], { frameId: old.frameId })).rejects.toThrow(/STALE_FRAME/);
  });

  it('does not check the frame for semantic refs, which do not use coordinates', async () => {
    const stale = await screenshot({ window: fixtureWindow, maxWidth: 320 });
    await screenshot({ window: fixtureWindow, maxWidth: 320 });
    // Nothing here should mention the frame: the failure must be about the ref itself.
    await expect(
      act([{ type: 'click_ref', ref: 'g1_e999999_999999' }], { frameId: stale.frameId })
    ).rejects.toThrow(/UNKNOWN_UI_REF/);
  });

  it('takes its verification picture before anyone else can touch the desktop', async () => {
    // captureAfter exists to make action and verification one round trip. If the lock is
    // released between them, another agent's capture can land in the gap and the "after"
    // picture proves nothing about the action it was supposed to verify.
    const order: string[] = [];
    const base = await screenshot({ window: fixtureWindow, maxWidth: 320 });

    const combined = actAndCapture([{ type: 'move', x: 1, y: 1 }], {
      frameId: base.frameId,
      capture: { window: fixtureWindow, maxWidth: 320 }
    }).then((result) => {
      order.push('combined');
      return result;
    });
    const interloper = screenshot({ window: fixtureWindow, maxWidth: 320 }).then((shot) => {
      order.push('interloper');
      return shot;
    });

    const [result, other] = await Promise.all([combined, interloper]);
    expect(result.screenshot).not.toBeNull();
    expect(order).toEqual(['combined', 'interloper']);
    // Frames are numbered in capture order: the verification picture is the very next one
    // after the frame the action was aimed at, and the interloper's comes after that.
    expect(result.screenshot!.frameId).toBe(base.frameId + 1);
    expect(other.frameId).toBe(result.screenshot!.frameId + 1);
  });

  it('waits for a compact postcondition inside the same action call', async () => {
    const current = (await activeWindow()).window;
    if (!current) return;
    const result = await actAndCapture([{ type: 'wait', ms: 0 }], {
      verify: { until: 'foreground', window: current.id, timeoutMs: 250 }
    });
    expect(result.completedCount).toBe(1);
    expect(result.verification).toMatchObject({ until: 'foreground', snapshotId: null });
  });

  it('marks all executed actions when postcondition verification times out', async () => {
    await expect(
      actAndCapture([{ type: 'wait', ms: 0 }], {
        verify: { until: 'window_exists', match: 'clf-window-that-cannot-exist-5f2dc5', timeoutMs: 0 }
      })
    ).rejects.toMatchObject({
      completedCount: 1,
      message: expect.stringMatching(/POSTCONDITION_FAILED: completed_count=1.*VERIFY_TIMEOUT/)
    });
  });

  it('resolves a captureAfter crop against the frame that was current before the actions', async () => {
    const base = await screenshot({ window: fixtureWindow, maxWidth: 320 });
    const width = Math.min(64, base.width);
    const height = Math.min(48, base.height);
    const result = await actAndCapture([{ type: 'wait', ms: 0 }], {
      frameId: base.frameId,
      capture: { crop: { x: 0, y: 0, width, height } }
    });
    expect(result.screenshot).not.toBeNull();
    expect(result.screenshot!.width).toBe(width);
    expect(result.screenshot!.height).toBe(height);
  });

  it('requires a retained screenshot identity for captureAfter crops', async () => {
    const earlier = await screenshot({ window: fixtureWindow, maxWidth: 320 });
    const current = await screenshot({ window: fixtureWindow, maxWidth: 320 });
    const crop = { x: 0, y: 0, width: Math.min(32, current.width), height: Math.min(24, current.height) };

    await expect(actAndCapture([{ type: 'wait', ms: 0 }], { capture: { crop } })).rejects.toThrow(/FRAME_REQUIRED/);
    await expect(
      actAndCapture([{ type: 'wait', ms: 0 }], { frameId: earlier.frameId, capture: { crop } })
    ).resolves.toBeTruthy();

    for (let index = 0; index < 16; index++) await screenshot({ window: fixtureWindow, maxWidth: 320 });
    await expect(
      actAndCapture([{ type: 'wait', ms: 0 }], { frameId: earlier.frameId, capture: { crop } })
    ).rejects.toThrow(/STALE_FRAME/);
  });

  it('pairs window state element centres with the screenshot it returned', async () => {
    // A competing capture is fired while get_window_state is mid-acquisition. The state
    // it returns must describe one moment: centres computed against its own screenshot,
    // never against the frame the interloper installed.
    let checked = 0;
    const { windows } = await listWindows();
    const candidates = windows.filter(window => window.id === fixtureWindow);
    for (const candidate of candidates) {
      try {
        const statePromise = getWindowState({ window: candidate.id, includeScreenshot: true, maxWidth: 640, maxElements: 12 });
        const interloper = screenshot({ window: fixtureWindow, maxWidth: 320 });
        const [state, other] = await Promise.all([statePromise, interloper]);
        expect(state.screenshot).not.toBeNull();
        const shot = state.screenshot!;
        expect(shot.frameId).not.toBe(other.frameId);
        for (const element of state.elements) {
          // Eligibility is derived from raw desktop bounds/capture metadata, never from
          // imageBounds/imageCenter: an all-null mapping regression must still fail.
          const inside = element.bounds.x >= shot.region.x && element.bounds.y >= shot.region.y &&
            element.bounds.x + element.bounds.width <= shot.region.x + shot.region.width &&
            element.bounds.y + element.bounds.height <= shot.region.y + shot.region.height;
          if (shot.captureMode === 'screen_fallback' || !inside) {
            expect(element.imageBounds).toBeNull();
            expect(element.imageCenter).toBeNull();
            continue;
          }
          const left = Math.round((element.bounds.x - shot.region.x) * shot.width / shot.region.width);
          const top = Math.round((element.bounds.y - shot.region.y) * shot.height / shot.region.height);
          const right = Math.round((element.bounds.x + element.bounds.width - shot.region.x) * shot.width / shot.region.width);
          const bottom = Math.round((element.bounds.y + element.bounds.height - shot.region.y) * shot.height / shot.region.height);
          expect(element.imageBounds).toEqual({ x: left, y: top, width: right - left, height: bottom - top });
          if (right <= left || bottom <= top) {
            expect(element.imageCenter).toBeNull();
            continue;
          }
          expect(element.imageCenter).toEqual({
            x: Math.min(right - 1, Math.round((left + right) / 2)),
            y: Math.min(bottom - 1, Math.round((top + bottom) / 2))
          });
          expect(right).toBeLessThanOrEqual(shot.width);
          expect(bottom).toBeLessThanOrEqual(shot.height);
          checked++;
        }
        if (checked > 0) break;
      } catch (error) {
        if (!/CAPTURE_FAILED:|WINDOW_NOT_FOUND:/.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    // The owned Form has a real button; missing eligible controls is a failure, never a skip.
    expect(checked).toBeGreaterThan(0);
  });

  it('refuses a ref minted before the desktop helper restarted', async () => {
    // A UI Automation runtime id is meaningless to a different helper process, so acting
    // on one would target whatever now holds that id rather than what the model saw.
    const target = await visibleWindow();
    if (target === null) return;
    const state = await getWindowState({ window: target, includeScreenshot: false, maxElements: 4 });
    const live = state.elements.find((element) => element.ref.startsWith('g'));
    if (!live) return;
    const older = live.ref.replace(/^g(\d+)/, (_match, gen: string) => `g${Number(gen) - 1}`);
    await expect(act([{ type: 'click_ref', ref: older }])).rejects.toThrow(/UNKNOWN_UI_REF|STALE_REF/);
  });
});

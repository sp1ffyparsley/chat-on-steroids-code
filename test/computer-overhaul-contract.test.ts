import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';
import { WINDOWS_CAPTURE_SOURCE } from '../src/main/computer/windows-capture.js';

describe('desktop helper overhaul contract', () => {
  it('identifies every native geometry fence by phase and HWND without accepting mismatched bounds', () => {
    for (const phase of ['item', 'after-frame', 'content']) {
      expect(WINDOWS_CAPTURE_SOURCE).toContain(`CaptureBounds(window, ${phase === 'content' ? 'contentWidth, contentHeight' : 'width, height'}, "${phase}")`);
    }
    expect(WINDOWS_CAPTURE_SOURCE).toContain('(phase=');
    expect(WINDOWS_CAPTURE_SOURCE).toContain('", hwnd=" + window.ToInt64()');
    expect(WINDOWS_CAPTURE_SOURCE).toContain('width == dwm.Right - dwm.Left && height == dwm.Bottom - dwm.Top');
    expect(WINDOWS_CAPTURE_SOURCE).toContain('width == outer.Right - outer.Left && height == outer.Bottom - outer.Top');
    expect(WINDOWS_CAPTURE_SOURCE).toContain('capture geometry matches neither DWM nor outer bounds');
    expect(WINDOWS_CAPTURE_SOURCE).toContain('contentWidth > width || contentHeight > height');
    expect(WINDOWS_CAPTURE_SOURCE).toContain('phase=readback, hwnd=');
  });

  it('does not reintroduce the fixed focus and per-action sleeps', () => {
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 120');
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 30');
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 20');
    expect(HELPER_SCRIPT).toContain('Stopwatch]::StartNew()');
  });

  it('keeps observation coalesced and window capture background-first', () => {
    expect(HELPER_SCRIPT).toContain("'snapshot'");
    expect(HELPER_SCRIPT).toContain('[CosWindowsCapture]::Capture');
    expect(HELPER_SCRIPT).toContain('DwmGetWindowAttribute(window, 14');
    expect(HELPER_SCRIPT).not.toContain('PrintWindow');
    expect(HELPER_SCRIPT).not.toContain("$mode = 'screen_fallback'");
    expect(HELPER_SCRIPT).toContain("$mode = 'window'");
    expect(HELPER_SCRIPT).not.toContain('$root.FindAll(');
    expect(HELPER_SCRIPT).toContain('TreeWalker]::ControlViewWalker');
    expect(HELPER_SCRIPT).toContain('System.Windows.Automation.CacheRequest');
  });

  it('returns exact partial-batch evidence and snapshot-scopes UI handles', () => {
    expect(HELPER_SCRIPT).toContain('completed_count = $completed');
    expect(HELPER_SCRIPT).toContain('failed_index = $index');
    expect(HELPER_SCRIPT).toContain('$script:UiSnapshots');
    expect(HELPER_SCRIPT).toContain('STALE_UI_SNAPSHOT');
  });
});

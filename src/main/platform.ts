import os from 'node:os';
import type { Capabilities, PlatformInfo } from '../shared/types.js';

/** ScreenCaptureKit is present from macOS 12.3 (Darwin 21.4). */
export function macOSDesktopAutomationSupported(release: string): boolean {
  const [major = 0, minor = 0] = release.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return major > 21 || (major === 21 && minor >= 4);
}

export function desktopAutomationSupported(
  platform: NodeJS.Platform = process.platform,
  release?: string
): boolean {
  if (platform === 'win32') return true;
  if (platform !== 'darwin') return false;
  // An explicit cross-platform projection models a supported Mac. The real host uses its actual
  // Darwin release so Core remains available on macOS 12.0-12.2 while Desktop stays hidden.
  return release !== undefined || process.platform === 'darwin'
    ? macOSDesktopAutomationSupported(release ?? os.release())
    : true;
}

export function hostPlatformInfo(
  platform: NodeJS.Platform = process.platform,
  release?: string
): PlatformInfo {
  if (platform === 'win32') return { family: 'windows', name: 'Windows', desktopAutomation: true };
  if (platform === 'darwin') {
    return { family: 'macos', name: 'macOS', desktopAutomation: desktopAutomationSupported(platform, release) };
  }
  if (platform === 'linux') return { family: 'linux', name: 'Linux', desktopAutomation: false };
  return { family: 'other', name: platform, desktopAutomation: false };
}

/**
 * Browser read/write lives on the Desktop surface too, and `screen` / `control` gate those tools
 * on every supported host. Only clipboard access is native-only when there is no desktop backend.
 * Keep all stored choices intact; this projection merely prevents unsupported native operations.
 */
export function capabilitiesForPlatform(
  capabilities: Capabilities,
  platform: NodeJS.Platform = process.platform,
  release?: string
): Capabilities {
  if (desktopAutomationSupported(platform, release)) return capabilities;
  return { ...capabilities, clipboardRead: false, clipboardWrite: false };
}

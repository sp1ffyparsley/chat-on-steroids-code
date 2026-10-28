import { accessSync, constants, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchCommand, launchIndependentWindowsCommand, runCommand, runPowerShell } from './exec.js';
import { getActiveInstanceRuntime, getConfig, getInstanceRegistry } from './config.js';
import type { ChatBrowser } from '../shared/types.js';
import { browserWindowBounds } from './browser-window-layout.js';

type Exists = (candidate: string) => boolean;
type Launch = typeof launchCommand;
type WindowsLaunch = typeof launchIndependentWindowsCommand;

/** A successful OS handoff is not a live browser. Unknown probes never grant opening authority. */
export async function isPreferredBrowserRunning(
  platform: NodeJS.Platform = process.platform,
  powershell: typeof runPowerShell = runPowerShell,
  browser: ChatBrowser = getConfig().ui.chatBrowser ?? 'chrome',
  command: typeof runCommand = runCommand
): Promise<boolean | null> {
  try {
    if (platform !== 'win32') {
      if (platform !== 'darwin' && platform !== 'linux') return null;
      // comm contains executable names, never arguments or browsing/profile data.
      const result = await command('ps', ['-A', '-o', 'comm='], os.tmpdir(), 5000);
      if (result.timedOut || result.truncated || result.exitCode !== 0 || !result.stdout.trim()) return null;
      const family = browser === 'edge'
        ? /^(?:msedge|microsoft-edge(?:-(?:stable|beta|dev))?|Microsoft Edge(?: Beta| Dev| Canary)?(?: Helper.*)?)$/i
        : browser === 'brave'
          ? /^(?:brave|brave-browser(?:-(?:stable|beta|dev|nightly))?|Brave Browser(?: Beta| Dev| Nightly)?(?: Helper.*)?)$/i
        : /^(?:chrome|google-chrome(?:-(?:stable|beta|unstable))?|chromium(?:-browser)?|Google Chrome(?: Beta| Dev| Canary)?(?: Helper.*)?|Chromium(?: Helper.*)?)$/i;
      return result.stdout.split('\n').some(name => family.test(path.posix.basename(name.trim())));
    }
    // Probe only the selected family; another browser cannot prove its presence or absence.
    // Enumerate names only, never user command lines or profile data. Both names are constants.
    const processName = browser === 'edge' ? 'msedge' : browser === 'brave' ? 'brave' : 'chrome';
    const result = await powershell(`$ErrorActionPreference='Stop'; if (@(Get-Process | Where-Object ProcessName -eq '${processName}').Count) { 'running' } else { 'absent' }`, os.tmpdir(), 5000);
    if (result.timedOut || result.truncated || result.exitCode !== 0) return null;
    return result.stdout.trim() === 'absent' ? false : result.stdout.trim() === 'running' ? true : null;
  } catch { return null; }
}

export interface PreferredBrowserOpenOptions {
  /** Defaults to the saved ChatGPT browser choice. */
  browser?: ChatBrowser;
  /** Exact Chrome/Chromium profile directory. Never a path, cookie jar, or credential. */
  profileDirectory?: string | null;
  /** Start the owned helper without activating its Windows startup window. */
  backgroundStartup?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test seam and alternate host probe; defaults to executable-file validation. */
  usable?: Exists;
  /** Test seam for launch failure/retry ordering. */
  launch?: Launch;
  /** Test seam for every Windows browser launch through the independent OS broker. */
  windowsLaunch?: WindowsLaunch;
}

function activeBrowserBinding(): { browser: ChatBrowser; profileDirectory: string | null } | null {
  try {
    const profile = getActiveInstanceRuntime().profile;
    return {
      browser: profile.browser.family ?? getConfig().ui.chatBrowser ?? 'chrome',
      profileDirectory: profile.browser.profileDirectory ?? null
    };
  } catch {
    return null;
  }
}

function isExecutableBrowser(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Installations of the selected companion browser, in preference order.
 *
 * Nothing here can choose *which running instance* of that browser the URL reaches: the
 * platform resolves it to the one that last had focus. A chat that must be opened beside
 * another chat is therefore not opened from this module at all — the browser holding the
 * source chat opens it. See `bridge.ts::offerPlacement`.
 *
 * Worker/resume URLs require the companion and the user's ChatGPT account. Browser family
 * is a saved user choice, not inferred from executable availability or the OS URL handler.
 * Never cross that choice just because another installed browser is easier to launch.
 */
export function preferredBrowserCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME ?? env.USERPROFILE ?? os.homedir(),
  browser: ChatBrowser = 'chrome'
): string[] {
  if (platform === 'win32') {
    const p = path.win32;
    const parts = browser === 'edge'
      ? ['Microsoft', 'Edge', 'Application', 'msedge.exe']
      : browser === 'brave'
        ? ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']
        : ['Google', 'Chrome', 'Application', 'chrome.exe'];
    return [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter((root): root is string => Boolean(root))
      .map(root => p.join(root, ...parts));
  }

  if (platform === 'darwin') {
    // Release channels have separate bundles. Keep Beta/Dev/Canary-only installs usable
    // without crossing the user's chosen browser family.
    const channels = browser === 'edge' ? [
      ['Microsoft Edge.app', 'Microsoft Edge'],
      ['Microsoft Edge Beta.app', 'Microsoft Edge Beta'],
      ['Microsoft Edge Dev.app', 'Microsoft Edge Dev'],
      ['Microsoft Edge Canary.app', 'Microsoft Edge Canary']
    ] : browser === 'brave' ? [
      ['Brave Browser.app', 'Brave Browser'],
      ['Brave Browser Beta.app', 'Brave Browser Beta'],
      ['Brave Browser Dev.app', 'Brave Browser Dev'],
      ['Brave Browser Nightly.app', 'Brave Browser Nightly']
    ] : [
      ['Google Chrome.app', 'Google Chrome'],
      ['Google Chrome Beta.app', 'Google Chrome Beta'],
      ['Google Chrome Dev.app', 'Google Chrome Dev'],
      ['Google Chrome Canary.app', 'Google Chrome Canary'],
      ['Chromium.app', 'Chromium']
    ] as const;
    return channels.flatMap(([bundle, executable]) => [
      path.posix.join('/Applications', bundle, 'Contents', 'MacOS', executable),
      ...(home ? [path.posix.join(home, 'Applications', bundle, 'Contents', 'MacOS', executable)] : [])
    ]);
  }

  if (platform === 'linux') {
    const pathValue = env.PATH ?? '';
    // Search release-channel launchers too: the companion need not be installed in Stable.
    const names = browser === 'edge' ? ['microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-beta', 'microsoft-edge-dev'] : browser === 'brave' ? [
      'brave-browser',
      'brave-browser-beta',
      'brave-browser-dev',
      'brave-browser-nightly',
      'brave'
    ] : [
      'google-chrome',
      'google-chrome-stable',
      'google-chrome-beta',
      'google-chrome-unstable',
      'chromium',
      'chromium-browser'
    ];
    const fromPath = pathValue
      .split(':')
      .filter(Boolean)
      .flatMap((dir) => names.map((name) => path.posix.join(dir, name)));
    if (browser === 'edge') return [...new Set([
      ...fromPath,
      ...names.map(name => path.posix.join('/usr/bin', name)),
      '/opt/microsoft/msedge/msedge', '/opt/microsoft/msedge-beta/msedge', '/opt/microsoft/msedge-dev/msedge'
    ])];
    if (browser === 'brave') return [...new Set([
      ...fromPath,
      ...names.map(name => path.posix.join('/usr/bin', name)),
      '/opt/brave.com/brave/brave-browser',
      '/opt/brave.com/brave-beta/brave-browser-beta',
      '/opt/brave.com/brave-dev/brave-browser-dev',
      '/opt/brave.com/brave-nightly/brave-browser-nightly',
      '/snap/bin/brave',
      '/usr/lib/brave-browser/brave-browser',
      home ? path.posix.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'com.brave.Browser') : '',
      '/var/lib/flatpak/exports/bin/com.brave.Browser'
    ].filter(Boolean))];
    // Chrome and Chromium are both widely installed through Flatpak on immutable Linux
    // desktops. Flatpak exports host launchers for installed applications under these
    // `exports/bin` directories (the exported Chrome desktop file uses the same path as
    // TryExec), so they can be launched exactly like the distro/Snap wrappers below. Keep
    // this shell-free: worker/resume markers are URLs and must remain one literal argv item.
    const userFlatpak = home ? path.posix.join(home, '.local', 'share', 'flatpak', 'exports', 'bin') : '';
    return [
      ...fromPath,
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome-beta',
      '/usr/bin/google-chrome-unstable',
      '/opt/google/chrome/google-chrome',
      '/opt/google/chrome-beta/google-chrome-beta',
      '/opt/google/chrome-unstable/google-chrome-unstable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      userFlatpak && path.posix.join(userFlatpak, 'com.google.Chrome'),
      userFlatpak && path.posix.join(userFlatpak, 'com.google.ChromeDev'),
      userFlatpak && path.posix.join(userFlatpak, 'org.chromium.Chromium'),
      '/var/lib/flatpak/exports/bin/com.google.Chrome',
      '/var/lib/flatpak/exports/bin/com.google.ChromeDev',
      '/var/lib/flatpak/exports/bin/org.chromium.Chromium'
    ].filter(Boolean);
  }

  return [];
}

export function findPreferredBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
  exists: Exists = (candidate) => isExecutableBrowser(candidate, platform)
): string | null {
  for (const candidate of preferredBrowserCandidates(platform, env, home)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Opens an orchestration URL in the saved browser family.
 *
 * Existence/executable checks are intentionally not the arbitration cut. A stale wrapper or a
 * damaged first Chrome install can pass those checks and still fail at spawn time; worker/resume
 * URLs may try another installation of that family, never the system default or another family.
 */
export async function openInPreferredBrowser(
  url: string,
  options: PreferredBrowserOpenOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const usable = options.usable ?? ((candidate: string) => isExecutableBrowser(candidate, platform));
  const launch = options.launch ?? launchCommand;
  const windowsLaunch = options.windowsLaunch ?? launchIndependentWindowsCommand;
  const binding = activeBrowserBinding();
  const selected = options.browser ?? binding?.browser ?? getConfig().ui.chatBrowser ?? 'chrome';
  const profileDirectory = options.profileDirectory === undefined ? binding?.profileDirectory ?? null : options.profileDirectory;
  // Once several accounts are configured, an unbound legacy account must not let Chrome's
  // last-used profile decide which ChatGPT identity receives a new app-authored tab.
  if (!profileDirectory && binding && getInstanceRegistry().profiles.length > 1) {
    throw new Error('The active account has no exact Chrome profile directory. Set it in Accounts & devices before opening ChatGPT; Chrome could otherwise choose another signed-in account.');
  }
  if (profileDirectory && selected !== 'chrome') {
    throw new Error('Explicit ChatGPT account profiles currently require Google Chrome or Chromium.');
  }
  if (profileDirectory && (/[/\\:*?"<>|\0\r\n]/.test(profileDirectory) || profileDirectory === '.' || profileDirectory === '..')) {
    throw new Error('Browser profile directory must be a Chrome/Chromium profile name, not a path.');
  }
  const label = selected === 'edge' ? 'Microsoft Edge' : selected === 'brave' ? 'Brave Browser' : 'Google Chrome / Chromium';
  const bounds = browserWindowBounds();
  // These switches only affect a newly started Chrome process; handing a URL to an
  // existing instance cannot change its policy. Memory Saver exclusions alone do not
  // prevent background timer/renderer throttling of long-running orchestration tabs.
  const args = [
    ...(platform === 'win32' ? ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'] : []),
    ...(options.backgroundStartup ? [`--window-size=${bounds.width},${bounds.height}`] : []),
    ...(profileDirectory ? [`--profile-directory=${profileDirectory}`] : []),
    url
  ];
  let lastError: unknown = null;

  for (const browser of new Set(preferredBrowserCandidates(platform, env, options.home, selected))) {
    if (!usable(browser)) continue;
    try {
      // Launch the marked helper itself so the extension adopts that same tab, never a
      // second. On Windows the local OS provider must own browser lifetime: Node unref,
      // detached and PowerShell Start-Process all remain inside an inherited Job and can
      // take the user's whole browser down when CoS closes.
      const cwd = (platform === 'win32' ? path.win32 : path.posix).dirname(browser);
      if (platform === 'win32') {
        await windowsLaunch(browser, args, cwd, options.backgroundStartup ? 'minimized' : 'visible');
      } else await launch(browser, args, cwd);
      return browser;
    } catch (error) {
      lastError = error;
      // Missing/malformed/timeout broker receipts are post-Create ambiguous. Even an
      // explicit failure stays fail-closed here: do not launch a second Windows candidate
      // and never fall back to a CoS-owned direct child. Mac/Linux retain candidate retry.
      if (platform === 'win32') break;
    }
  }

  if (lastError) throw new Error(`${label} could not start: ${(lastError as Error).message}. Check Settings > Browser & history > ChatGPT browser.`);
  throw new Error(`${label} was not found. Install it or change Settings > Browser & history > ChatGPT browser.`);
}

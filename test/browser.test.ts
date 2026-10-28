import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { findPreferredBrowser, isPreferredBrowserRunning, openInPreferredBrowser, preferredBrowserCandidates } from '../src/main/browser.js';

describe('browser-backed ChatGPT commands', () => {
  it('launches selected Edge when Chrome is also installed', async () => {
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const launch = vi.fn();
    const windowsLaunch = vi.fn(async () => ({ pid: 123 }));
    const url = 'https://chatgpt.com/?cos-model-catalog=selected';
    const opened = await openInPreferredBrowser(url, {
      browser: 'edge', platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      usable: candidate => candidate === edge || candidate === chrome, launch, windowsLaunch
    });
    expect(opened).toBe(edge);
    expect(windowsLaunch).toHaveBeenCalledExactlyOnceWith(edge,
      ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', url], path.win32.dirname(edge), 'visible');
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not open Chrome when selected Edge is absent', async () => {
    const launch = vi.fn(async () => ({ pid: 123 }));
    const windowsLaunch = vi.fn(async () => ({ pid: 123 }));
    await expect(openInPreferredBrowser('https://chatgpt.com/', {
      browser: 'edge', platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' },
      usable: candidate => candidate.endsWith('chrome.exe'), launch, windowsLaunch
    })).rejects.toThrow(/Microsoft Edge.*not found/);
    expect(launch).not.toHaveBeenCalled();
    expect(windowsLaunch).not.toHaveBeenCalled();
  });

  it('reports the Windows broker failure without a direct-child fallback or another browser family', async () => {
    const launch = vi.fn();
    const windowsLaunch = vi.fn(async () => { throw new Error('Windows OS-broker refused the launch'); });
    await expect(openInPreferredBrowser('https://chatgpt.com/', {
      browser: 'edge', platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' },
      usable: () => true, launch, windowsLaunch
    })).rejects.toThrow(/Microsoft Edge.*OS-broker refused/);
    expect(windowsLaunch).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it('probes the selected browser process rather than inferring it from another installed browser', async () => {
    const probe = vi.fn(async (_script: string) => ({ stdout: 'running', stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 1 }));
    expect(await isPreferredBrowserRunning('win32', probe, 'edge')).toBe(true);
    expect(probe.mock.calls[0]?.[0]).toContain("ProcessName -eq 'msedge'");
    expect(probe.mock.calls[0]?.[0]).not.toContain("ProcessName -eq 'chrome'");
    expect(await isPreferredBrowserRunning('win32', probe, 'brave')).toBe(true);
    expect(probe.mock.calls[1]?.[0]).toContain("ProcessName -eq 'brave'");
  });
  it('grants process absence only from a successful bounded Windows probe', async () => {
    const result = { stdout: 'absent\r\n', stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 1 };
    const probe = vi.fn(async () => result);
    expect(await isPreferredBrowserRunning('win32', probe)).toBe(false);
    result.stdout = 'running\r\n';
    expect(await isPreferredBrowserRunning('win32', probe)).toBe(true);
    result.stdout = '';
    expect(await isPreferredBrowserRunning('win32', probe)).toBeNull();
    result.stdout = 'absent'; result.timedOut = true;
    expect(await isPreferredBrowserRunning('win32', probe)).toBeNull();
    result.timedOut = false; result.exitCode = 1;
    expect(await isPreferredBrowserRunning('win32', probe)).toBeNull();
    probe.mockClear();
    expect(await isPreferredBrowserRunning('aix', probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
  it.each(['darwin', 'linux'] as const)('observes selected process names on %s and fails closed on incomplete probes', async platform => {
    const result = { stdout: '/sbin/init\nps\n/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n', stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 1 };
    const probe = vi.fn(async () => result);
    expect(await isPreferredBrowserRunning(platform, undefined, 'chrome', probe)).toBe(true);
    expect(await isPreferredBrowserRunning(platform, undefined, 'edge', probe)).toBe(false);
    result.stdout = 'init\nmsedge\nps\n';
    expect(await isPreferredBrowserRunning(platform, undefined, 'edge', probe)).toBe(true);
    expect(await isPreferredBrowserRunning(platform, undefined, 'chrome', probe)).toBe(false);
    result.stdout = 'init\n/Applications/Brave Browser.app/Contents/MacOS/Brave Browser\nbrave-browser-nightly\nps\n';
    expect(await isPreferredBrowserRunning(platform, undefined, 'brave', probe)).toBe(true);
    expect(await isPreferredBrowserRunning(platform, undefined, 'chrome', probe)).toBe(false);
    expect(await isPreferredBrowserRunning(platform, undefined, 'edge', probe)).toBe(false);
    result.truncated = true;
    expect(await isPreferredBrowserRunning(platform, undefined, 'chrome', probe)).toBeNull();
    result.truncated = false; result.stdout = '';
    expect(await isPreferredBrowserRunning(platform, undefined, 'chrome', probe)).toBeNull();
  });
  it('cold background startup gives Chrome one owned tab in a minimized startup window', async () => {
    const launch = vi.fn();
    const windowsLaunch = vi.fn(async () => ({ pid: 456 }));
    const browser = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    await openInPreferredBrowser('https://chatgpt.com/?cos-model-catalog=owned', {
      platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, backgroundStartup: true,
      usable: candidate => candidate === browser,
      launch,
      windowsLaunch
    });
    expect(windowsLaunch).toHaveBeenCalledExactlyOnceWith(browser, [
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--window-size=800,600',
      'https://chatgpt.com/?cos-model-catalog=owned'
    ], path.win32.dirname(browser), 'minimized');
    expect(launch).not.toHaveBeenCalled();
  });
  it('reports minimized Windows broker failure without direct foreground fallback', async () => {
    const launch = vi.fn();
    const windowsLaunch = vi.fn(async () => { throw new Error('Win32_Process.Create result=2; no direct-child fallback'); });
    const browser = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    await expect(openInPreferredBrowser('https://chatgpt.com/?cos-model-catalog=owned', {
      platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, backgroundStartup: true,
      usable: candidate => candidate === browser, launch,
      windowsLaunch
    })).rejects.toThrow(/Win32_Process\.Create result=2/);
    expect(launch).not.toHaveBeenCalled();
  });
  it('prefers the normal per-user Chrome install on Windows', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    };
    const wanted = path.win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
    expect(findPreferredBrowser('win32', env, 'C:\\Users\\example', (candidate) => candidate === wanted)).toBe(wanted);
  });

  it('finds the standard Google Chrome app on macOS before Chromium fallbacks', () => {
    const candidates = preferredBrowserCandidates('darwin', { HOME: '/Users/example' }, '/Users/example');
    expect(candidates[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(
      findPreferredBrowser('darwin', { HOME: '/Users/example' }, '/Users/example', (candidate) => candidate === candidates[0])
    ).toBe(candidates[0]);
  });

  it('falls back to a per-user macOS Applications install when system Chrome is absent', () => {
    const candidates = preferredBrowserCandidates('darwin', { HOME: '/Users/example' }, '/Users/example');
    const userChrome = '/Users/example/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(candidates[1]).toBe(userChrome);
    expect(findPreferredBrowser('darwin', { HOME: '/Users/example' }, '/Users/example', (candidate) => candidate === userChrome)).toBe(
      userChrome
    );
  });

  it('discovers every standard macOS Chrome channel before Chromium fallback', () => {
    const candidates = preferredBrowserCandidates('darwin', { HOME: '/Users/example' }, '/Users/example');
    const systemCandidates = candidates.filter((candidate) => candidate.startsWith('/Applications/'));
    expect(systemCandidates).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ]);

    const canary = '/Users/example/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary';
    expect(findPreferredBrowser('darwin', { HOME: '/Users/example' }, '/Users/example', (candidate) => candidate === canary)).toBe(
      canary
    );
  });

  it('searches PATH for Chrome/Chromium on Linux instead of relying on the default browser', () => {
    const env = { HOME: '/home/example', PATH: '/custom/bin:/usr/local/bin:/usr/bin' };
    const wanted = '/custom/bin/google-chrome';
    expect(findPreferredBrowser('linux', env, '/home/example', (candidate) => candidate === wanted)).toBe(wanted);
  });

  it('keeps Linux Chrome Stable/Beta/Dev ahead of Chromium fallbacks', () => {
    const candidates = preferredBrowserCandidates('linux', { PATH: '/usr/bin' }, '/home/example');
    const fromUsrBin = candidates.filter((candidate) => candidate.startsWith('/usr/bin/'));
    expect(fromUsrBin.slice(0, 6)).toEqual([
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome-beta',
      '/usr/bin/google-chrome-unstable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    ]);
  });

  it('discovers system and per-user Flatpak Chrome/Chromium launchers on Linux', () => {
    const candidates = preferredBrowserCandidates('linux', { HOME: '/home/example', PATH: '/usr/bin' }, '/home/example');
    expect(candidates).toContain('/home/example/.local/share/flatpak/exports/bin/com.google.Chrome');
    expect(candidates).toContain('/home/example/.local/share/flatpak/exports/bin/com.google.ChromeDev');
    expect(candidates).toContain('/home/example/.local/share/flatpak/exports/bin/org.chromium.Chromium');
    expect(candidates).toContain('/var/lib/flatpak/exports/bin/com.google.Chrome');
    expect(candidates).toContain('/var/lib/flatpak/exports/bin/com.google.ChromeDev');
    expect(candidates).toContain('/var/lib/flatpak/exports/bin/org.chromium.Chromium');
  });

  it('returns null when no compatible browser can be found so the caller can warn before fallback', () => {
    expect(findPreferredBrowser('linux', { PATH: '/nowhere' }, '/home/example', () => false)).toBeNull();
  });

  it('tries the next Chromium candidate when an earlier executable fails to launch', async () => {
    const env = { PATH: '/first:/second' };
    const candidates = preferredBrowserCandidates('linux', env, '/home/example');
    const first = candidates[0]!;
    const second = candidates.find((candidate) => candidate.startsWith('/second/'))!;
    const attempts: string[] = [];

    const opened = await openInPreferredBrowser('https://chatgpt.com/?clf=resume', {
      platform: 'linux',
      env,
      home: '/home/example',
      usable: (candidate) => candidate === first || candidate === second,
      launch: async (candidate) => {
        attempts.push(candidate);
        if (candidate === first) throw new Error('stale browser wrapper');
        return { pid: 123 };
      }
    });

    expect(opened).toBe(second);
    expect(attempts).toEqual([first, second]);
  });

  it.each(['win32', 'darwin'] as const)('keeps legacy launches profile-agnostic and uses background switches only on Windows (%s)', async (platform) => {
    const browser = platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const calls: Array<{ command: string; args: readonly string[]; cwd: string; visibility?: string }> = [];
    const url = 'https://chatgpt.com/?clf=worker-marker&model=example';
    await openInPreferredBrowser(url, {
      platform,
      env: { ProgramFiles: 'C:\\Program Files' },
      usable: (candidate) => candidate === browser,
      launch: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return { pid: 789 };
      },
      windowsLaunch: async (command, args, cwd, visibility) => {
        calls.push({ command, args, cwd, visibility });
        return { pid: 789 };
      }
    });
    expect(calls).toEqual([{
      command: browser,
      args: platform === 'win32'
        ? ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', url]
        : [url],
      cwd: (platform === 'win32' ? path.win32 : path.posix).dirname(browser),
      ...(platform === 'win32' ? { visibility: 'visible' } : {})
    }]);
  });

  it.each(['win32', 'darwin'] as const)('launches the explicitly bound Chrome profile directory on %s', async (platform) => {
    const browser = platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const calls: Array<{ command: string; args: readonly string[]; cwd: string; visibility?: string }> = [];
    const url = 'https://chatgpt.com/?clf=profile-bound';

    await openInPreferredBrowser(url, {
      browser: 'chrome',
      profileDirectory: 'Profile 7',
      platform,
      env: platform === 'win32' ? { ProgramFiles: 'C:\\Program Files' } : { HOME: '/Users/example' },
      home: platform === 'darwin' ? '/Users/example' : undefined,
      usable: (candidate) => candidate === browser,
      launch: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return { pid: 790 };
      },
      windowsLaunch: async (command, args, cwd, visibility) => {
        calls.push({ command, args, cwd, visibility });
        return { pid: 790 };
      }
    });

    expect(calls).toEqual([{
      command: browser,
      args: platform === 'win32'
        ? ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--profile-directory=Profile 7', url]
        : ['--profile-directory=Profile 7', url],
      cwd: (platform === 'win32' ? path.win32 : path.posix).dirname(browser),
      ...(platform === 'win32' ? { visibility: 'visible' } : {})
    }]);
  });

  it('passes only the orchestration URL to a Linux browser, never the AppImage sandbox fallback', async () => {
    const flatpakChrome = '/var/lib/flatpak/exports/bin/com.google.Chrome';
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const url = 'https://chatgpt.com/?clf=worker-marker';

    const opened = await openInPreferredBrowser(url, {
      platform: 'linux',
      env: { PATH: '/nowhere' },
      home: '/home/example',
      usable: (candidate) => candidate === flatpakChrome,
      launch: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return { pid: 456 };
      }
    });

    expect(opened).toBe(flatpakChrome);
    expect(calls).toEqual([{ command: flatpakChrome, args: [url], cwd: '/var/lib/flatpak/exports/bin' }]);
    expect(calls[0]?.args).not.toContain('--no-sandbox');
  });
});

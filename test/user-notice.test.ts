import { beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/main/config.js';
import type { Config, SignOutEmergencyNotice } from '../src/shared/types.js';
import {
  configureSignOutEmergencyForTests,
  flushSignOutEmergencyForTests,
  observeBrowserAuthenticationIncident,
  parsePushoverOwnerOutputForTests,
  resetSignOutEmergencyForTests,
  resolvePushoverOwnerExecutableForTests,
  retireDisabledSignOutEmergencyIncident,
  retireSignOutEmergencyIncidentAfterExplicitDisable,
  setSignOutEmergencyNotifier,
  setSignOutEmergencyStopNotifier,
  type PushoverOwnerRequest
} from '../src/main/user-notice.js';

const PROFILE = { profileId: 'account-Alpha', profileName: 'Alpha' };
const RECEIPT = 'A'.repeat(30);

describe('fixed Pushover owner boundary', () => {
  it('uses fixed Program Files PowerShell 7 when present and fixed native Windows PowerShell otherwise', () => {
    const programFiles = 'C:\\FixedProgramFiles';
    const systemRoot = 'D:\\FixedWindows';
    const pwsh7 = 'C:\\FixedProgramFiles\\PowerShell\\7\\pwsh.exe';
    const native = 'D:\\FixedWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

    expect(resolvePushoverOwnerExecutableForTests({
      programFiles,
      systemRoot,
      exists: candidate => candidate === pwsh7
    })).toBe(pwsh7);
    expect(resolvePushoverOwnerExecutableForTests({
      programFiles,
      systemRoot,
      exists: candidate => candidate === native
    })).toBe(native);
    expect(() => resolvePushoverOwnerExecutableForTests({
      programFiles,
      systemRoot,
      exists: () => false
    })).toThrow(/no supported fixed PowerShell owner/);
  });

  it.runIf(process.platform === 'win32')('resolves an existing fixed production executable without PATH lookup', async () => {
    const { existsSync } = await import('node:fs');
    const executable = resolvePushoverOwnerExecutableForTests();
    expect(existsSync(executable)).toBe(true);
    expect(executable).toMatch(/(?:Program Files\\PowerShell\\7\\pwsh|System32\\WindowsPowerShell\\v1\.0\\powershell)\.exe$/i);
    expect(executable.toLowerCase()).not.toContain('codex-runtime');
    expect(executable.toLowerCase()).not.toContain('codex-runtimes');
  });

  it('accepts only exact owner action/status and a 30-character emergency receipt', () => {
    const send: PushoverOwnerRequest = {
      action: 'send',
      title: 'title',
      message: 'message',
      priority: 'emergency',
      sound: 'alien',
      retry: 30,
      expire: 1500
    };
    expect(parsePushoverOwnerOutputForTests(
      JSON.stringify({ status: 1, action: 'send', receipt: RECEIPT }),
      send
    )).toEqual({ status: 1, receipt: RECEIPT });
    expect(() => parsePushoverOwnerOutputForTests('{not-json', send)).toThrow(/invalid JSON/);
    expect(() => parsePushoverOwnerOutputForTests(
      JSON.stringify({ status: '1', action: 'send', receipt: RECEIPT }),
      send
    )).toThrow(/status 1/);
    expect(() => parsePushoverOwnerOutputForTests(
      JSON.stringify({ status: 1, action: 'cancel', receipt: RECEIPT }),
      send
    )).toThrow(/status 1/);
    expect(() => parsePushoverOwnerOutputForTests(
      JSON.stringify({ status: 1, action: 'send', receipt: 'short' }),
      send
    )).toThrow(/valid receipt/);
  });
});

describe('durable ChatGPT sign-out emergency', () => {
  let config: Config;
  let requests: PushoverOwnerRequest[];
  let notices: SignOutEmergencyNotice[];
  let stops: string[];

  beforeEach(() => {
    resetSignOutEmergencyForTests();
    config = defaultConfig('win32');
    config = { ...config, ui: { ...config.ui, signOutEmergencyAlerts: true } };
    requests = [];
    notices = [];
    stops = [];
    configureSignOutEmergencyForTests({
      readConfig: () => config,
      writeConfig: async update => {
        config = await update(config);
        return config;
      },
      clock: () => new Date(2026, 9, 11, 12, 0, 0),
      runOwner: async request => {
        requests.push(request);
        return request.action === 'send' ? { status: 1, receipt: RECEIPT } : { status: 1 };
      }
    });
    setSignOutEmergencyNotifier(notice => { notices.push(notice); });
    setSignOutEmergencyStopNotifier(profileId => { stops.push(profileId); });
  });

  it('precommits one incident, deduplicates reconnects/restarts, and cancels only on positive recovery', async () => {
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await observeBrowserAuthenticationIncident('unknown', PROFILE);
    await flushSignOutEmergencyForTests();

    expect(notices).toEqual([expect.objectContaining({
      profileId: PROFILE.profileId,
      profileName: PROFILE.profileName,
      ringComputer: false
    })]);
    expect(requests).toEqual([expect.objectContaining({
      action: 'send',
      priority: 'emergency',
      sound: 'alien',
      retry: 30,
      expire: 1500
    })]);
    expect(config.noticeState?.signOutEmergency).toMatchObject({
      profileId: PROFILE.profileId,
      receipt: RECEIPT
    });

    // A new process has no in-memory latch. The config record remains the authority.
    resetSignOutEmergencyForTests();
    configureSignOutEmergencyForTests({
      readConfig: () => config,
      writeConfig: async update => {
        config = await update(config);
        return config;
      },
      runOwner: async request => {
        requests.push(request);
        return request.action === 'send' ? { status: 1, receipt: RECEIPT } : { status: 1 };
      }
    });
    setSignOutEmergencyNotifier(notice => { notices.push(notice); });
    setSignOutEmergencyStopNotifier(profileId => { stops.push(profileId); });
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    expect(requests).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(stops).toEqual([]);

    await observeBrowserAuthenticationIncident('signed-in', PROFILE);
    await flushSignOutEmergencyForTests();
    expect(requests).toEqual([
      expect.objectContaining({ action: 'send' }),
      { action: 'cancel', receipt: RECEIPT }
    ]);
    expect(config.noticeState?.signOutEmergency).toBeUndefined();
    expect(stops).toEqual([PROFILE.profileId]);
  });

  it('rings once only during the local 22:00–08:00 window and never retries a failed alert', async () => {
    let hour = 22;
    configureSignOutEmergencyForTests({
      readConfig: () => config,
      writeConfig: async update => {
        config = await update(config);
        return config;
      },
      clock: () => new Date(2026, 9, 11, hour, 0, 0),
      runOwner: async request => {
        requests.push(request);
        return { status: 0 };
      }
    });

    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();

    expect(notices).toHaveLength(1);
    expect(notices[0]?.ringComputer).toBe(true);
    expect(requests).toHaveLength(1);
    expect(config.noticeState?.signOutEmergency).toMatchObject({ profileId: PROFILE.profileId });
    expect(config.noticeState?.signOutEmergency?.receipt).toBeUndefined();

    await observeBrowserAuthenticationIncident('signed-in', PROFILE);
    hour = 8;
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    expect(notices[1]?.ringComputer).toBe(false);
    await observeBrowserAuthenticationIncident('signed-in', PROFILE);
    hour = 7;
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    expect(notices[2]?.ringComputer).toBe(true);
    expect(requests.filter(request => request.action === 'send')).toHaveLength(3);
  });

  it('cancels a late receipt when positive sign-in wins the delivery race', async () => {
    let resolveSend!: (result: { status: number; receipt: string }) => void;
    const send = new Promise<{ status: number; receipt: string }>(resolve => { resolveSend = resolve; });
    configureSignOutEmergencyForTests({
      readConfig: () => config,
      writeConfig: async update => {
        config = await update(config);
        return config;
      },
      runOwner: async request => {
        requests.push(request);
        return request.action === 'send' ? send : { status: 1 };
      }
    });

    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await observeBrowserAuthenticationIncident('signed-in', PROFILE);
    expect(config.noticeState?.signOutEmergency).toBeUndefined();
    resolveSend({ status: 1, receipt: RECEIPT });
    await flushSignOutEmergencyForTests();

    expect(requests).toEqual([
      expect.objectContaining({ action: 'send' }),
      { action: 'cancel', receipt: RECEIPT }
    ]);
    expect(config.noticeState?.signOutEmergency).toBeUndefined();
  });

  it('suppresses stale effects when sign-in overtakes the first durable sign-out write', async () => {
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
    let writes = 0;
    let queue = Promise.resolve<Config>(config);
    configureSignOutEmergencyForTests({
      readConfig: () => config,
      writeConfig: update => {
        const write = queue.then(async () => {
          writes += 1;
          if (writes === 1) await firstWriteGate;
          config = await update(config);
          return config;
        });
        queue = write.catch(() => config);
        return write;
      },
      runOwner: async request => {
        requests.push(request);
        return request.action === 'send' ? { status: 1, receipt: RECEIPT } : { status: 1 };
      }
    });

    const signedOut = observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await Promise.resolve();
    expect(config.noticeState?.signOutEmergency).toBeUndefined();
    const signedIn = observeBrowserAuthenticationIncident('signed-in', PROFILE);
    releaseFirstWrite();
    await Promise.all([signedOut, signedIn]);
    await flushSignOutEmergencyForTests();

    expect(notices).toEqual([]);
    expect(requests).toEqual([]);
    expect(config.noticeState?.signOutEmergency).toBeUndefined();
  });

  it('stops the incident owner profile when a later signed-in context clears stale custody', async () => {
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    const replacement = { profileId: 'account-replacement', profileName: 'Replacement' };

    await observeBrowserAuthenticationIncident('signed-in', replacement);
    await flushSignOutEmergencyForTests();

    expect(stops).toEqual([PROFILE.profileId]);
    expect(config.noticeState?.signOutEmergency).toBeUndefined();
    expect(requests.at(-1)).toEqual({ action: 'cancel', receipt: RECEIPT });
  });

  it('cancels a receipt when its persistence rejects after running the updater', async () => {
    let rejectReceiptPersistence = false;
    configureSignOutEmergencyForTests({
      readConfig: () => config,
      writeConfig: async update => {
        const next = await update(config);
        if (rejectReceiptPersistence && next.noticeState?.signOutEmergency?.receipt === RECEIPT) {
          throw new Error('simulated durable write rejection');
        }
        config = next;
        rejectReceiptPersistence = true;
        return config;
      },
      runOwner: async request => {
        requests.push(request);
        return request.action === 'send' ? { status: 1, receipt: RECEIPT } : { status: 1 };
      }
    });

    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();

    expect(requests).toEqual([
      expect.objectContaining({ action: 'send' }),
      { action: 'cancel', receipt: RECEIPT }
    ]);
    expect(config.noticeState?.signOutEmergency).toMatchObject({
      profileId: PROFILE.profileId
    });
    expect(config.noticeState?.signOutEmergency?.receipt).toBeUndefined();

    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    expect(requests.filter(request => request.action === 'send')).toHaveLength(1);
  });

  it('disabling cancels the active receipt without re-alerting the same signed-out incident', async () => {
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    config = { ...config, ui: { ...config.ui, signOutEmergencyAlerts: false } };

    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();

    expect(requests.filter(request => request.action === 'send')).toHaveLength(1);
    expect(requests.filter(request => request.action === 'cancel')).toEqual([
      { action: 'cancel', receipt: RECEIPT }
    ]);
    expect(config.noticeState?.signOutEmergency?.cancelRequested).toBe(true);
    expect(stops).toEqual([PROFILE.profileId]);
    await observeBrowserAuthenticationIncident('signed-in', PROFILE);
    await flushSignOutEmergencyForTests();
    expect(config.noticeState?.signOutEmergency).toBeUndefined();
    expect(stops).toEqual([PROFILE.profileId]);
    expect(requests.filter(request => request.action === 'cancel')).toHaveLength(1);
  });

  it('explicit Off cancels durable transport and ring custody without auth evidence', async () => {
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    config = { ...config, ui: { ...config.ui, signOutEmergencyAlerts: false } };

    await retireDisabledSignOutEmergencyIncident();
    await flushSignOutEmergencyForTests();

    expect(requests).toEqual([
      expect.objectContaining({ action: 'send' }),
      { action: 'cancel', receipt: RECEIPT }
    ]);
    expect(stops).toEqual([PROFILE.profileId]);
    expect(config.noticeState?.signOutEmergency).toMatchObject({
      profileId: PROFILE.profileId,
      cancelRequested: true
    });
    expect(config.noticeState?.signOutEmergency?.receipt).toBeUndefined();
  });

  it('a committed Off still cancels the incident when a later On overtakes its side effect', async () => {
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    const incidentId = config.noticeState?.signOutEmergency?.id ?? null;
    config = { ...config, ui: { ...config.ui, signOutEmergencyAlerts: false } };
    config = { ...config, ui: { ...config.ui, signOutEmergencyAlerts: true } };

    await retireSignOutEmergencyIncidentAfterExplicitDisable(incidentId);
    await flushSignOutEmergencyForTests();
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();

    expect(config.ui.signOutEmergencyAlerts).toBe(true);
    expect(config.noticeState?.signOutEmergency?.cancelRequested).toBe(true);
    expect(requests.filter(request => request.action === 'send')).toHaveLength(1);
    expect(requests.filter(request => request.action === 'cancel')).toEqual([
      { action: 'cancel', receipt: RECEIPT }
    ]);
    expect(stops).toEqual([PROFILE.profileId]);
  });

  it('never lets an older committed Off claim a newer incident', async () => {
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    const oldIncidentId = config.noticeState?.signOutEmergency?.id ?? null;
    await observeBrowserAuthenticationIncident('signed-in', PROFILE);
    await flushSignOutEmergencyForTests();
    await observeBrowserAuthenticationIncident('signed-out', PROFILE);
    await flushSignOutEmergencyForTests();
    const newIncidentId = config.noticeState?.signOutEmergency?.id;

    await retireSignOutEmergencyIncidentAfterExplicitDisable(oldIncidentId);
    await flushSignOutEmergencyForTests();

    expect(newIncidentId).not.toBe(oldIncidentId);
    expect(config.noticeState?.signOutEmergency).toMatchObject({
      id: newIncidentId,
      receipt: RECEIPT
    });
    expect(config.noticeState?.signOutEmergency?.cancelRequested).toBeUndefined();
    expect(requests.filter(request => request.action === 'send')).toHaveLength(2);
    expect(requests.filter(request => request.action === 'cancel')).toHaveLength(1);
  });
});

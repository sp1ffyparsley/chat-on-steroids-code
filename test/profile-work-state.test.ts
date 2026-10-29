import { CORE_BROWSER_EVIDENCE_MAX_AGE_MS, coreBrowserEvidence, noteCoreBrowserEvidence, resetCoreBrowserEvidenceForTests } from '../src/main/core-browser-evidence.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { clipboard } from 'electron';
import * as managedExec from '../src/main/exec.js';
import * as managedBrowser from '../src/main/browser.js';
import {
  createLocalInstanceProfile,
  getConfig,
  getLocalInstanceOwnerPaths,
  INSTANCE_BRIDGE_PORT_MAX,
  INSTANCE_BRIDGE_PORT_MIN,
  initConfigPath,
  loadConfig,
  prepareIsolatedInstanceRuntimeConfig,
  setLocalInstanceBridgePort,
  updateConfig
} from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { activeProfileWorkCensus, persistedProfileWorkerCounts } from '../src/main/profile-work-state.js';
import { buildInstanceProfilesSnapshot, copyManagedConnectorSetup, createManagedInstanceProfile, launchManagedInstanceRuntime, listManagedBrowserProfiles, openManagedInstanceBrowser, renameManagedInstanceProfile, repairManagedInstanceBridgePortIfOccupied, setManagedInstanceBrowserProfile, setManagedProfileCoreTunnel } from '../src/main/instance-management.js';
import { accountSurfaceDescriptions, surfaceDefinition } from '../src/main/mcp/surfaces.js';
import { processOperatorProfileCreation } from '../src/main/operator-input.js';
import { ProfileLifecycleCoordinator } from '../src/main/profile-lifecycle.js';
import { resetBridgeForTests } from '../src/main/bridge.js';
import { listInputs, resetInputForTests, type InputEntry } from '../src/main/session/input.js';
import { createSession, getSession, initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { profileWorkAdmission, WorkAdmissionGate } from '../src/main/work-admission.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { makeTempDir, removeTempDir } from './helpers.js';

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '', getAppPath: () => process.cwd(), getVersion: () => '0.0.0' },
  clipboard: { writeText: vi.fn() },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (value: Buffer) => ({ result: value.toString('utf8'), shouldReEncrypt: false })
  }
}));

function idleLifecycle(profileId = getConfig().instances!.activeInstanceId): ProfileLifecycleCoordinator {
  return new ProfileLifecycleCoordinator({
    profileId,
    admission: new WorkAdmissionGate(),
    census: async () => ({ profileId, blockers: [] }),
    readDeferredSwitch: async () => null,
    writeDeferredSwitch: async () => undefined,
    onSwitchReady: async () => undefined,
    applyUpdate: async () => undefined,
    applyShutdown: async () => undefined
  });
}

let dir = '';
let originalArgv: string[] = [];

beforeEach(async () => {
  originalArgv = [...process.argv];
  dir = await makeTempDir('clf-profile-work-state-');
  initConfigPath(dir);
  await loadConfig();
});

afterEach(async () => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await removeTempDir(dir);
});

async function writeSwarm(profileId: string, value: unknown): Promise<void> {
  const owners = getLocalInstanceOwnerPaths(profileId);
  expect(owners).not.toBeNull();
  const state = path.join(owners!.durableStoreRoot, 'state');
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, 'swarm.json'), JSON.stringify(value), 'utf8');
}

async function listenOnSupportedPort(handler?: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  for (let port = INSTANCE_BRIDGE_PORT_MAX; port >= INSTANCE_BRIDGE_PORT_MIN; port -= 1) {
    const server = http.createServer(handler ?? ((_request, response) => response.end('occupied')));
    const listening = await new Promise<boolean>(resolve => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (listening) return { server, port };
  }
  throw new Error('No supported loopback test port was available.');
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe('inactive profile worker summaries', () => {
  it('renames a stopped prepared account through the native owner while retaining its private identity and settings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const profile = await createLocalInstanceProfile('Business', 'Profile 6');
    const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
    initConfigPath(privateRoot, dir);
    await loadConfig();
    await updateConfig(config => ({ ...config, ui: { ...config.ui, automationPaused: true, theme: 'light' },
      goal: { ...config.goal, helperReasoning: 'xhigh' },
      tunnel: { ...config.tunnel, kind: 'manual', manualPublicOrigin: 'https://account.example.com', manualPort: 9770 } }));
    const privatePath = path.join(privateRoot, 'config.json');
    const before = JSON.parse(await fs.readFile(privatePath, 'utf8'));
    const opaquePath = path.join(privateRoot, 'secrets.bin');
    await fs.writeFile(opaquePath, 'unchanged test encrypted owner');
    initConfigPath(dir);
    await loadConfig();
    const result = await renameManagedInstanceProfile(idleLifecycle(), profile.id, 'Delta', { processRunning: async () => false });
    expect(result.profiles.find(row => row.id === profile.id)).toMatchObject({ nickname: 'Delta',
      browserProfileDirectory: 'Profile 6', runtimePrepared: true, runtimeRunning: false });
    const after = JSON.parse(await fs.readFile(privatePath, 'utf8'));
    const expected = structuredClone(before);
    const row = expected.instances.profiles.find((entry: { id: string }) => entry.id === profile.id);
    row.displayName = row.accountLabel = 'Delta';
    expected.tunnel.profileName = getConfig().setupProfiles!.find(entry => entry.id === profile.tunnelProfileRef)!.name;
    for (const setup of expected.setupProfiles ?? []) if (setup.id === profile.tunnelProfileRef)
      setup.name = getConfig().setupProfiles!.find(entry => entry.id === profile.tunnelProfileRef)!.name;
    expect(after).toEqual(expected);
    expect(after.instances.activeInstanceId).toBe(profile.id);
    expect(after.instances.profiles.find((entry: { id: string }) => entry.id === profile.id).connector).toEqual(profile.connector);
    expect(await fs.readFile(opaquePath, 'utf8')).toBe('unchanged test encrypted owner');
    await expect(setManagedProfileCoreTunnel(idleLifecycle(), profile.id, '')).rejects.toThrow(/private settings/);
    await expect(setManagedInstanceBrowserProfile(idleLifecycle(), profile.id, 'Profile 9')).rejects.toThrow(/private settings/);
    expect(JSON.parse(await fs.readFile(privatePath, 'utf8'))).toEqual(after);
  });

  it('refuses nickname changes from an isolated sender and while the target is running', async () => {
    const profile = await createLocalInstanceProfile('Business', 'Profile 6');
    const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
    const primaryPath = path.join(dir, 'config.json'), privatePath = path.join(privateRoot, 'config.json');
    const primaryBefore = await fs.readFile(primaryPath, 'utf8'), privateBefore = await fs.readFile(privatePath, 'utf8');
    process.argv.push(`--cos-instance-runtime=${profile.id}`);
    await expect(renameManagedInstanceProfile(idleLifecycle(), profile.id, 'Delta')).rejects.toThrow(/primary account/);
    process.argv.splice(0, process.argv.length, ...originalArgv);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true,
      json: async () => ({ app: 'chat-on-steroids', instanceId: profile.id, paired: true }) })));
    await expect(renameManagedInstanceProfile(idleLifecycle(), profile.id, 'Delta', { processRunning: async () => false })).rejects.toThrow(/running in another window/);
    expect(await fs.readFile(primaryPath, 'utf8')).toBe(primaryBefore);
    expect(await fs.readFile(privatePath, 'utf8')).toBe(privateBefore);
  });

  it('rechecks stopped ownership at private publication and rolls canonical labels back if the account starts', async () => {
    const profile = await createLocalInstanceProfile('Business', 'Profile 6');
    const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
    const primaryPath = path.join(dir, 'config.json'), privatePath = path.join(privateRoot, 'config.json');
    const primaryBefore = await fs.readFile(primaryPath, 'utf8'), privateBefore = await fs.readFile(privatePath, 'utf8');
    let probes = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ++probes < 3 ? { ok: false } : { ok: true,
      json: async () => ({ app: 'chat-on-steroids', instanceId: profile.id, paired: true }) }));
    await expect(renameManagedInstanceProfile(idleLifecycle(), profile.id, 'Delta', { processRunning: async () => false })).rejects.toThrow(/running in another window/);
    expect(probes).toBe(3);
    expect(await fs.readFile(primaryPath, 'utf8')).toBe(primaryBefore);
    expect(await fs.readFile(privatePath, 'utf8')).toBe(privateBefore);
  });

  it.each(['failed', 'malformed'])('refuses a live exact account process despite a %s hello', async mode => {
    const profile = await createLocalInstanceProfile('Business', 'Profile 6');
    const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
    const primaryPath = path.join(dir, 'config.json'), privatePath = path.join(privateRoot, 'config.json');
    const primaryBefore = await fs.readFile(primaryPath, 'utf8'), privateBefore = await fs.readFile(privatePath, 'utf8');
    vi.stubGlobal('fetch', vi.fn(async () => mode === 'failed' ? { ok: false } : { ok: true, json: async () => ({ wrongOwner: true }) }));
    const processRunning = vi.fn(async (id: string) => id === profile.id);
    await expect(renameManagedInstanceProfile(idleLifecycle(), profile.id, 'Delta', { processRunning }))
      .rejects.toThrow(/still has a running Chat On Steroids process/);
    expect(processRunning).toHaveBeenCalledExactlyOnceWith(profile.id);
    expect(await fs.readFile(primaryPath, 'utf8')).toBe(primaryBefore);
    expect(await fs.readFile(privatePath, 'utf8')).toBe(privateBefore);
  });

  it('rechecks exact process absence at private nickname publication even without a hello response', async () => {
    const profile = await createLocalInstanceProfile('Business', 'Profile 6');
    const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
    const primaryPath = path.join(dir, 'config.json'), privatePath = path.join(privateRoot, 'config.json');
    const primaryBefore = await fs.readFile(primaryPath, 'utf8'), privateBefore = await fs.readFile(privatePath, 'utf8');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    let probes = 0;
    const processRunning = vi.fn(async () => ++probes === 3);
    await expect(renameManagedInstanceProfile(idleLifecycle(), profile.id, 'Delta', { processRunning }))
      .rejects.toThrow(/still has a running Chat On Steroids process/);
    expect(probes).toBe(3);
    expect(await fs.readFile(primaryPath, 'utf8')).toBe(primaryBefore);
    expect(await fs.readFile(privatePath, 'utf8')).toBe(privateBefore);
  });

  it.each([1, 3])('retains both nickname owners when exact-process proof fails at boundary %s', async failingBoundary => {
    const profile = await createLocalInstanceProfile('Business', 'Profile 6');
    const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
    const primaryPath = path.join(dir, 'config.json'), privatePath = path.join(privateRoot, 'config.json');
    const primaryBefore = await fs.readFile(primaryPath, 'utf8'), privateBefore = await fs.readFile(privatePath, 'utf8');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    let probes = 0;
    await expect(renameManagedInstanceProfile(idleLifecycle(), profile.id, 'Delta', { processRunning: async () => {
      if (++probes === failingBoundary) throw new Error('Exact account process census failed or was malformed.');
      return false;
    } })).rejects.toThrow(/census failed or was malformed/);
    expect(probes).toBe(failingBoundary);
    expect(await fs.readFile(primaryPath, 'utf8')).toBe(primaryBefore);
    expect(await fs.readFile(privatePath, 'utf8')).toBe(privateBefore);
  });

  it.skipIf(process.platform !== 'win32')('uses the actual installed-process census in the default prepared nickname owner', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const profile = await createLocalInstanceProfile('Business', 'Profile 6');
    await prepareIsolatedInstanceRuntimeConfig(profile.id);
    const result = await renameManagedInstanceProfile(idleLifecycle(), profile.id, 'Delta');
    expect(result.profiles.find(row => row.id === profile.id)?.nickname).toBe('Delta');
    // Three bounded10s process probes plus real file publication can exceed30s.
    // Keep production deadlines and every refusal/preservation assertion unchanged.
  }, 45_000);

  it.skipIf(process.platform !== 'win32')('runs the incumbent exact-process census with real PowerShell argument and boundary matching', async () => {
    const powershell = managedExec.findWindowsPowerShell();
    expect(powershell).not.toBeNull();
    const source = readFileSync(new URL('../src/main/instance-management.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async function installedManagedInstanceProcessRunning');
    const end = source.indexOf('\ninterface BridgePortRepairOptions', start);
    const executable = 'C:\\test apps\\Chat On Steroids.exe';
    const id = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    const exec = promisify(execFile);
    for (const [commandLine, running, pathValue] of [
      [`"${executable}" --cos-instance-runtime=${id} --background`, true, executable],
      [`"${executable}" --background --cos-instance-runtime=${id}`, true, executable.toUpperCase()],
      [`"${executable}" "--cos-instance-runtime=${id}" --background`, true, executable],
      [`"${executable}" --cos-instance-runtime=${id}-other --background`, false, executable],
      [`"${executable}" prefix--cos-instance-runtime=${id} --background`, false, executable],
      [`"${executable}" --cos-instance-runtime=${id} --type=renderer`, false, executable],
      [`"${executable}" --cos-instance-runtime=${id} --type renderer`, false, executable],
      [`"${executable}" "--cos-instance-runtime=${id}" "--type=renderer"`, false, executable],
      [`"${executable}" --cos-instance-runtime=profile-other --background`, false, executable],
      [`"${executable}" --cos-instance-runtime=${id} --background`, false, 'C:\\other\\Chat On Steroids.exe'],
      ['', null, executable],
      [`"${executable}" --cos-instance-runtime=${id} --background`, null, ''],
      [`"${executable}" --cos-instance-runtime=${id} --background`, null, '::::']
    ] as const) {
      const context = vm.createContext({ app: { isPackaged: true }, process: { platform: 'win32', execPath: executable },
        findWindowsPowerShell: () => powershell,
        execFileAsync: async (file: string, args: string[], options: object) => {
          const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
          const census = `function Get-CimInstance { [pscustomobject]@{ExecutablePath=${quote(pathValue)};CommandLine=${quote(commandLine)}} };\n`;
          const injected = [...args];
          const command = injected.indexOf('-Command') + 1;
          injected[command] = census + injected[command];
          return exec(file, injected, options);
        }
      });
      vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
      context.id = id;
      const result = vm.runInContext('installedManagedInstanceProcessRunning(id)', context);
      if (running === null) await expect(result).rejects.toThrow(/Could not prove account.*stopped/);
      else await expect(result).resolves.toBe(running);
    }
  });

  it.skipIf(process.platform !== 'win32')('allows bounded slow Windows census startup without inventing stopped proof', async () => {
    const powershell = managedExec.findWindowsPowerShell();
    expect(powershell).not.toBeNull();
    const source = readFileSync(new URL('../src/main/instance-management.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async function installedManagedInstanceProcessRunning');
    const end = source.indexOf('\ninterface BridgePortRepairOptions', start);
    const exec = promisify(execFile);
    let probes = 0;
    const context = vm.createContext({ app: { isPackaged: true },
      process: { platform: 'win32', execPath: 'C:\\test apps\\Chat On Steroids.exe' },
      findWindowsPowerShell: () => powershell,
      execFileAsync: async (file: string, args: string[], options: object) => {
        probes++;
        const injected = [...args];
        const command = injected.indexOf('-Command') + 1;
        // Reproduce a slow cold CIM provider with the real bounded PowerShell
        // child. It returns actual stopped evidence only AFTER six seconds;
        // an expired probe must never be interpreted as an idle account.
        injected[command] = 'function Get-CimInstance { Start-Sleep -Milliseconds 6000; @() };\n' + injected[command];
        return exec(file, injected, options);
      } });
    vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
    await expect(vm.runInContext("installedManagedInstanceProcessRunning('profile-fixture-slow-census')", context))
      .resolves.toBe(false);
    expect(probes).toBe(1);
  }, 15000);

  it('rejects failed or malformed incumbent process-census output instead of claiming absence', async () => {
    const source = readFileSync(new URL('../src/main/instance-management.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async function installedManagedInstanceProcessRunning');
    const end = source.indexOf('\ninterface BridgePortRepairOptions', start);
    for (const result of ['', 'unknown', 'running\nstopped', new Error('CIM access denied'),
      Object.assign(new Error('CIM probe expired'), { killed: true, signal: 'SIGTERM' })]) {
      const context = vm.createContext({ app: { isPackaged: true }, process: { platform: 'win32', execPath: 'C:\\installed\\Chat On Steroids.exe' },
        findWindowsPowerShell: () => 'powershell.exe', execFileAsync: async () => {
          if (result instanceof Error) throw result;
          return { stdout: result };
        } });
      vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
      await expect(vm.runInContext("installedManagedInstanceProcessRunning('profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa')", context))
        .rejects.toThrow(/Could not prove account.*stopped/);
    }
  });

  it('projects and copies the exact account-specific description without changing the active surface or connecting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const lifecycle = idleLifecycle();
    const profile = await createLocalInstanceProfile('Gamma', 'Profile 8');
    const activeBefore = { ...surfaceDefinition('core') };
    const view = (await buildInstanceProfilesSnapshot(lifecycle)).profiles.find(row => row.id === profile.id)!;
    expect(view.connector.description).toBe(accountSurfaceDescriptions(profile).core);
    expect(view.connector.description).toContain(profile.id);
    expect(view.connector.description).toContain('Gamma');
    await copyManagedConnectorSetup(profile.id, lifecycle);
    expect(clipboard.writeText).toHaveBeenLastCalledWith(`${view.connector.displayName}\n${view.connector.description}`);
    expect(surfaceDefinition('core')).toEqual(activeBefore);
    expect(view.runtimePrepared).toBe(false);
  });
  it('converges concurrent native and operator account creation without launch or connection work', async () => {
    const launch = vi.spyOn(managedExec, 'launchCommand').mockResolvedValue({ pid: 1234 });
    const browser = vi.spyOn(managedBrowser, 'openInPreferredBrowser').mockResolvedValue('https://chatgpt.com/');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const lifecycle = idleLifecycle();
    const [native, operatorId] = await Promise.all([
      createManagedInstanceProfile(lifecycle, 'Gamma', 'Profile 8'),
      processOperatorProfileCreation(['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8'],
        (nickname, directory) => createManagedInstanceProfile(lifecycle, nickname, directory))
    ]);
    expect(operatorId).toBe(native.createdProfileId);
    const profile = native.profiles.find(row => row.id === operatorId)!;
    expect(profile).toMatchObject({ nickname: 'Gamma', browserProfileDirectory: 'Profile 8',
      runtimePrepared: false, runtimeRunning: false });
    expect(getConfig().instances!.profiles).toHaveLength(2);
    expect(launch).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
  });

  it('refuses account provisioning from an isolated runtime without editing either registry', async () => {
    const work = await createLocalInstanceProfile('Work', 'Profile 2');
    const workRoot = await prepareIsolatedInstanceRuntimeConfig(work.id);
    const primaryBefore = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
    initConfigPath(workRoot, dir);
    await loadConfig();
    const privateBefore = await fs.readFile(path.join(workRoot, 'config.json'), 'utf8');
    process.argv.push(`--cos-instance-runtime=${work.id}`);
    const creator = (nickname: string, directory: string) => createManagedInstanceProfile(idleLifecycle(), nickname, directory);
    await expect(processOperatorProfileCreation(['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8'], creator))
      .rejects.toThrow(/primary account/);
    await expect(createManagedInstanceProfile(idleLifecycle(), 'Gamma', 'Profile 8')).rejects.toThrow(/primary account/);
    await expect(createLocalInstanceProfile('Gamma', 'Profile 8')).rejects.toThrow(/primary account/i);
    expect(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).toBe(primaryBefore);
    expect(await fs.readFile(path.join(workRoot, 'config.json'), 'utf8')).toBe(privateBefore);
  });

  it('projects newly added canonical accounts in an older isolated account without replacing its private settings', async () => {
    const work = await createLocalInstanceProfile('Work', 'Profile 2');
    const workRoot = await prepareIsolatedInstanceRuntimeConfig(work.id);
    const newer = await createLocalInstanceProfile('Garry', 'Profile 5');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await setManagedProfileCoreTunnel(idleLifecycle(), newer.id, 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await prepareIsolatedInstanceRuntimeConfig(newer.id);
    await writeSwarm(newer.id, { version: 6, activeRuns: [{ agents: [
      { info: { role: 'worker', state: 'sleeping' } },
      { info: { role: 'worker', state: 'invited' } }
    ] }] });
    initConfigPath(workRoot, dir);
    await loadConfig();
    const privateBefore = await fs.readFile(path.join(workRoot, 'config.json'), 'utf8');
    const localBefore = getConfig();
    expect(localBefore.instances!.profiles.some(row => row.id === newer.id)).toBe(false);

    const snapshot = await buildInstanceProfilesSnapshot(idleLifecycle());
    expect(snapshot.activeProfileId).toBe(work.id);
    expect(snapshot.profiles.map(row => row.id)).toContain(newer.id);
    expect(snapshot.profiles.find(row => row.id === work.id)).toMatchObject({ active: true });
    expect(snapshot.profiles.find(row => row.id === newer.id)).toMatchObject({
      enabled: true, active: false, runtimePrepared: true, activeWorkers: 0, queuedWorkers: 1,
      coreTunnelId: null, hasRuntimeApiKey: null, connector: { mcpUrl: null, status: 'off' }
    });
    expect(getConfig()).toBe(localBefore);
    expect(await fs.readFile(path.join(workRoot, 'config.json'), 'utf8')).toBe(privateBefore);
  });

  it('projects canonical disabled status instead of an isolated account old enabled copy', async () => {
    const work = await createLocalInstanceProfile('Work', 'Profile 2');
    const peer = await createLocalInstanceProfile('Peer', 'Profile 5');
    const workRoot = await prepareIsolatedInstanceRuntimeConfig(work.id);
    await updateConfig(config => ({ ...config, instances: { ...config.instances!,
      profiles: config.instances!.profiles.map(row => row.id === peer.id ? { ...row, enabled: false } : row)
    } }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    initConfigPath(workRoot, dir);
    await loadConfig();
    expect(getConfig().instances!.profiles.find(row => row.id === peer.id)?.enabled).toBe(true);
    const snapshot = await buildInstanceProfilesSnapshot(idleLifecycle());
    expect(snapshot.profiles.find(row => row.id === peer.id)?.enabled).toBe(false);
    expect(getConfig().instances!.profiles.find(row => row.id === peer.id)?.enabled).toBe(true);
    process.argv.push(`--cos-instance-runtime=${work.id}`);
    const launch = vi.spyOn(managedExec, 'launchCommand').mockResolvedValue({ pid: 1234 });
    const browser = vi.spyOn(managedBrowser, 'openInPreferredBrowser').mockResolvedValue('chrome.exe');
    await expect(launchManagedInstanceRuntime(peer.id)).rejects.toThrow('enabled account');
    await expect(openManagedInstanceBrowser(peer.id)).rejects.toThrow('enabled account');
    expect(launch).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
  });

  it('removes a canonical retired peer from the menu without launching its stale private row', async () => {
    const work = await createLocalInstanceProfile('Work', 'Profile 2');
    const peer = await createLocalInstanceProfile('Unused', 'Profile 5');
    const workRoot = await prepareIsolatedInstanceRuntimeConfig(work.id);
    await updateConfig(config => ({ ...config, instances: { ...config.instances!,
      profiles: config.instances!.profiles.filter(row => row.id !== peer.id)
    } }));
    const launch = vi.spyOn(managedExec, 'launchCommand').mockResolvedValue({ pid: 1234 });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    initConfigPath(workRoot, dir);
    await loadConfig();
    process.argv.push(`--cos-instance-runtime=${work.id}`);
    expect(getConfig().instances!.profiles.some(row => row.id === peer.id)).toBe(true);
    const snapshot = await buildInstanceProfilesSnapshot(idleLifecycle());
    expect(snapshot.profiles.some(row => row.id === peer.id)).toBe(false);
    await expect(launchManagedInstanceRuntime(peer.id)).rejects.toThrow('enabled account');
    expect(launch).not.toHaveBeenCalled();
  });

  it('focuses a newly added prepared canonical sibling from an older isolated account without bootstrapping it again', async () => {
    const work = await createLocalInstanceProfile('Work', 'Profile 2');
    const workRoot = await prepareIsolatedInstanceRuntimeConfig(work.id);
    const newer = await createLocalInstanceProfile('Garry', 'Profile 5');
    const newerRoot = await prepareIsolatedInstanceRuntimeConfig(newer.id);
    const peerBefore = await fs.readFile(path.join(newerRoot, 'config.json'), 'utf8');
    const launch = vi.spyOn(managedExec, 'launchCommand').mockResolvedValue({ pid: 1234 });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true,
      json: async () => ({ app: 'chat-on-steroids', instanceId: newer.id, paired: true })
    })));
    initConfigPath(workRoot, dir);
    await loadConfig();
    process.argv.push(`--cos-instance-runtime=${work.id}`);
    expect(getConfig().instances!.profiles.some(row => row.id === newer.id)).toBe(false);

    await expect(launchManagedInstanceRuntime(newer.id)).resolves.toEqual({
      profileId: newer.id, port: newer.bridge.port, reused: true
    });
    expect(launch).toHaveBeenCalledExactlyOnceWith(process.execPath,
      [`--cos-instance-runtime=${newer.id}`], path.dirname(process.execPath));
    expect(await fs.readFile(path.join(newerRoot, 'config.json'), 'utf8')).toBe(peerBefore);
  });

  it('starts a stopped prepared canonical sibling without creating or changing its private config', async () => {
    const work = await createLocalInstanceProfile('Work', 'Profile 2');
    const workRoot = await prepareIsolatedInstanceRuntimeConfig(work.id);
    const peer = await createLocalInstanceProfile('Peer', 'Profile 5');
    const holder = await listenOnSupportedPort();
    await closeServer(holder.server);
    await setLocalInstanceBridgePort(peer.id, holder.port);
    const peerRoot = await prepareIsolatedInstanceRuntimeConfig(peer.id);
    const peerBefore = await fs.readFile(path.join(peerRoot, 'config.json'), 'utf8');
    let started = false;
    const launch = vi.spyOn(managedExec, 'launchCommand').mockImplementation(async () => {
      started = true;
      return { pid: 1234 };
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: started,
      json: async () => ({ app: 'chat-on-steroids', instanceId: peer.id, paired: true })
    })));
    initConfigPath(workRoot, dir);
    await loadConfig();
    process.argv.push(`--cos-instance-runtime=${work.id}`);

    await expect(launchManagedInstanceRuntime(peer.id)).resolves.toEqual({
      profileId: peer.id, port: holder.port, reused: false
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(peerRoot, 'config.json'), 'utf8')).toBe(peerBefore);
  });

  it('does not bootstrap a newly discovered unprepared sibling from an isolated account', async () => {
    const work = await createLocalInstanceProfile('Work', 'Profile 2');
    const workRoot = await prepareIsolatedInstanceRuntimeConfig(work.id);
    const peer = await createLocalInstanceProfile('Peer', 'Profile 5');
    const holder = await listenOnSupportedPort();
    await closeServer(holder.server);
    await setLocalInstanceBridgePort(peer.id, holder.port);
    const peerConfig = path.join(peer.state.root, 'runtime', 'config.json');
    const launch = vi.spyOn(managedExec, 'launchCommand').mockResolvedValue({ pid: 1234 });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    initConfigPath(workRoot, dir);
    await loadConfig();
    process.argv.push(`--cos-instance-runtime=${work.id}`);

    await expect(launchManagedInstanceRuntime(peer.id)).rejects.toThrow('once from the primary CoS window');
    expect(launch).not.toHaveBeenCalled();
    await expect(fs.stat(peerConfig)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rechecks canonical enablement after a peer probe before authorizing OS focus/launch', async () => {
    const work = await createLocalInstanceProfile('Work', 'Profile 2');
    const peer = await createLocalInstanceProfile('Peer', 'Profile 5');
    const workRoot = await prepareIsolatedInstanceRuntimeConfig(work.id);
    const primary = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
    const launch = vi.spyOn(managedExec, 'launchCommand').mockResolvedValue({ pid: 1234 });
    vi.stubGlobal('fetch', vi.fn(async () => {
      primary.instances.profiles.find((row: { id: string }) => row.id === peer.id).enabled = false;
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(primary), 'utf8');
      return { ok: true, json: async () => ({ app: 'chat-on-steroids', instanceId: peer.id, paired: true }) };
    }));
    initConfigPath(workRoot, dir);
    await loadConfig();
    process.argv.push(`--cos-instance-runtime=${work.id}`);

    await expect(launchManagedInstanceRuntime(peer.id)).rejects.toThrow('enabled account');
    expect(launch).not.toHaveBeenCalled();
    expect(getConfig().instances!.profiles.find(row => row.id === peer.id)?.enabled).toBe(true);
  });

  it('refuses a canonical foreign-device peer before browser work', async () => {
    const work = await createLocalInstanceProfile('Work', 'Profile 2');
    const peer = await createLocalInstanceProfile('Peer', 'Profile 5');
    const workRoot = await prepareIsolatedInstanceRuntimeConfig(work.id);
    await updateConfig(config => ({ ...config, instances: { ...config.instances!,
      profiles: config.instances!.profiles.map(row => row.id === peer.id
        ? { ...row, deviceId: '00000000-0000-4000-8000-000000000099' } : row)
    } }));
    const launch = vi.spyOn(managedExec, 'launchCommand').mockResolvedValue({ pid: 1234 });
    const fetch = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal('fetch', fetch);
    initConfigPath(workRoot, dir);
    await loadConfig();
    process.argv.push(`--cos-instance-runtime=${work.id}`);
    await expect(launchManagedInstanceRuntime(peer.id)).rejects.toThrow('not bound to this device');
    await expect(openManagedInstanceBrowser(peer.id)).rejects.toThrow('another physical device');
    expect(launch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['missing', 'corrupt'])('refuses %s canonical account data without falling back to private launch authority', async state => {
    const work = await createLocalInstanceProfile('Work', 'Profile 2');
    const peer = await createLocalInstanceProfile('Peer', 'Profile 5');
    const workRoot = await prepareIsolatedInstanceRuntimeConfig(work.id);
    const launch = vi.spyOn(managedExec, 'launchCommand').mockResolvedValue({ pid: 1234 });
    const fetch = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal('fetch', fetch);
    initConfigPath(workRoot, dir);
    await loadConfig();
    process.argv.push(`--cos-instance-runtime=${work.id}`);
    const privateBefore = await fs.readFile(path.join(workRoot, 'config.json'), 'utf8');
    if (state === 'missing') await fs.rm(path.join(dir, 'config.json'));
    else await fs.writeFile(path.join(dir, 'config.json'), '{broken', 'utf8');

    await expect(buildInstanceProfilesSnapshot(idleLifecycle())).rejects.toThrow();
    await expect(launchManagedInstanceRuntime(peer.id)).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(workRoot, 'config.json'), 'utf8')).toBe(privateBefore);
  });

  it('repairs a non-CoS bridge collision through the canonical profile route', async () => {
    const profile = await createLocalInstanceProfile('Garry', 'Profile 5');
    const holder = await listenOnSupportedPort();
    try {
      await setLocalInstanceBridgePort(profile.id, holder.port);
      const repaired = await repairManagedInstanceBridgePortIfOccupied(profile.id, { processRunning: async () => false });
      expect(repaired.bridge.port).not.toBe(holder.port);
      expect(getConfig().instances?.profiles.find(row => row.id === profile.id)?.bridge.port).toBe(repaired.bridge.port);
    } finally {
      await closeServer(holder.server);
    }
  });

  it('does not steal a bridge port that identifies another CoS account', async () => {
    const profile = await createLocalInstanceProfile('Garry', 'Profile 5');
    const holder = await listenOnSupportedPort((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url === '/hello'
        ? { app: 'chat-on-steroids', instanceId: 'profile-other', paired: true }
        : {}));
    });
    try {
      await setLocalInstanceBridgePort(profile.id, holder.port);
      await expect(repairManagedInstanceBridgePortIfOccupied(profile.id, { processRunning: async () => false })).rejects.toThrow(/belongs to profile-other/);
      expect(getConfig().instances?.profiles.find(row => row.id === profile.id)?.bridge.port).toBe(holder.port);
    } finally {
      await closeServer(holder.server);
    }
  });

  it('refuses to rewrite a prepared route under a running bridge-failed account process', async () => {
    const profile = await createLocalInstanceProfile('Garry', 'Profile 5');
    const holder = await listenOnSupportedPort();
    try {
      await setLocalInstanceBridgePort(profile.id, holder.port);
      await expect(repairManagedInstanceBridgePortIfOccupied(profile.id, {
        processRunning: async candidate => candidate === profile.id
      })).rejects.toThrow(/still has a running Chat On Steroids process/);
      expect(getConfig().instances?.profiles.find(row => row.id === profile.id)?.bridge.port).toBe(holder.port);
    } finally {
      await closeServer(holder.server);
    }
  });

  it('reconciles an interrupted primary/private bridge update before launching the stopped account', async () => {
    const profile = await createLocalInstanceProfile('Garry', 'Profile 5');
    const previousPort = profile.bridge.port;
    const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
    const holder = await listenOnSupportedPort();
    try {
      await setLocalInstanceBridgePort(profile.id, holder.port);
      const privatePath = path.join(privateRoot, 'config.json');
      const interrupted = JSON.parse(await fs.readFile(privatePath, 'utf8'));
      interrupted.instances.profiles.find((row: any) => row.id === profile.id).bridge.port = previousPort;
      interrupted.ui.theme = 'light';
      interrupted.multiAgent.defaultReasoning = 'high';
      await fs.writeFile(privatePath, JSON.stringify(interrupted, null, 2), 'utf8');
      await closeServer(holder.server);

      const repaired = await repairManagedInstanceBridgePortIfOccupied(profile.id, { processRunning: async () => false });
      expect(repaired.bridge.port).toBe(holder.port);
      const reconciled = JSON.parse(await fs.readFile(privatePath, 'utf8'));
      expect(reconciled.instances.profiles.find((row: any) => row.id === profile.id).bridge.port).toBe(holder.port);
      expect(reconciled.ui.theme).toBe('light');
      expect(reconciled.multiAgent.defaultReasoning).toBe('high');
    } finally {
      await closeServer(holder.server);
    }
  });

  it('does not reconcile an interrupted private bridge route under a still-running account process', async () => {
    const profile = await createLocalInstanceProfile('Garry', 'Profile 5');
    const previousPort = profile.bridge.port;
    const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
    const holder = await listenOnSupportedPort();
    try {
      await setLocalInstanceBridgePort(profile.id, holder.port);
      const privatePath = path.join(privateRoot, 'config.json');
      const interrupted = JSON.parse(await fs.readFile(privatePath, 'utf8'));
      interrupted.instances.profiles.find((row: any) => row.id === profile.id).bridge.port = previousPort;
      await fs.writeFile(privatePath, JSON.stringify(interrupted, null, 2), 'utf8');
      await closeServer(holder.server);

      await expect(repairManagedInstanceBridgePortIfOccupied(profile.id, {
        processRunning: async candidate => candidate === profile.id
      })).rejects.toThrow(/still has a running Chat On Steroids process/);
      const preserved = JSON.parse(await fs.readFile(privatePath, 'utf8'));
      expect(preserved.instances.profiles.find((row: any) => row.id === profile.id).bridge.port).toBe(previousPort);
      expect(getConfig().instances?.profiles.find(row => row.id === profile.id)?.bridge.port).toBe(holder.port);
    } finally {
      await closeServer(holder.server);
    }
  });

  it('keeps a repeated stopped-account repair on the first canonical replacement port', async () => {
    const profile = await createLocalInstanceProfile('Garry', 'Profile 5');
    const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
    const holder = await listenOnSupportedPort();
    try {
      await setLocalInstanceBridgePort(profile.id, holder.port);
      const first = await repairManagedInstanceBridgePortIfOccupied(profile.id, { processRunning: async () => false });
      const second = await repairManagedInstanceBridgePortIfOccupied(profile.id, { processRunning: async () => false });
      expect(second.bridge.port).toBe(first.bridge.port);
      expect(second.bridge.port).not.toBe(holder.port);
      expect(getConfig().instances?.profiles.find(row => row.id === profile.id)?.bridge.port).toBe(first.bridge.port);
      const privateConfig = JSON.parse(await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8'));
      expect(privateConfig.instances.profiles.find((row: any) => row.id === profile.id).bridge.port).toBe(first.bridge.port);
    } finally {
      await closeServer(holder.server);
    }
  });

  it('converges concurrent stopped-account repairs on one canonical/private replacement route', async () => {
    const profile = await createLocalInstanceProfile('Garry', 'Profile 5');
    const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
    const holder = await listenOnSupportedPort();
    try {
      await setLocalInstanceBridgePort(profile.id, holder.port);
      const [first, second] = await Promise.all([
        repairManagedInstanceBridgePortIfOccupied(profile.id, { processRunning: async () => false }),
        repairManagedInstanceBridgePortIfOccupied(profile.id, { processRunning: async () => false })
      ]);
      expect(second.bridge.port).toBe(first.bridge.port);
      expect(first.bridge.port).not.toBe(holder.port);
      expect(getConfig().instances?.profiles.find(row => row.id === profile.id)?.bridge.port).toBe(first.bridge.port);
      const privateConfig = JSON.parse(await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8'));
      expect(privateConfig.instances.profiles.find((row: any) => row.id === profile.id).bridge.port).toBe(first.bridge.port);
    } finally {
      await closeServer(holder.server);
    }
  });

  it('hides an unbound legacy Default profile from the picker but accepts it for explicit bootstrap validation', async () => {
    const previousHome = process.env.HOME;
    const chromeDefault = path.join(dir, 'Library', 'Application Support', 'Google', 'Chrome', 'Default');
    process.env.HOME = dir;
    await fs.mkdir(chromeDefault, { recursive: true });
    await fs.writeFile(path.join(chromeDefault, 'Preferences'), '{}', 'utf8');
    try {
      await expect(listManagedBrowserProfiles()).resolves.not.toContain('Default');
      await expect(listManagedBrowserProfiles({ includeUnboundLegacyDefault: true })).resolves.toContain('Default');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('shows a running secondary account that still needs its browser companion paired', async () => {
    const profile = await createLocalInstanceProfile('Work', 'Profile 2');
    let paired = false;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ app: 'chat-on-steroids', instanceId: profile.id, paired })
    })));
    const activeId = getConfig().instances!.activeInstanceId;
    const lifecycle = new ProfileLifecycleCoordinator({
      profileId: activeId,
      admission: new WorkAdmissionGate(),
      census: async () => ({ profileId: activeId, blockers: [] }),
      readDeferredSwitch: async () => null,
      writeDeferredSwitch: async () => undefined,
      onSwitchReady: async () => undefined,
      applyUpdate: async () => undefined,
      applyShutdown: async () => undefined
    });

    const projected = (await buildInstanceProfilesSnapshot(lifecycle)).profiles.find(row => row.id === profile.id);
    expect(projected).toMatchObject({ runtimeRunning: true, browserPaired: false,
      connection: {
        detail: expect.stringContaining('browser companion needs pairing'),
        core: { state: 'unknown' }
      },
      connector: { status: 'unknown' }
    });
    paired = true;
    const rechecked = (await buildInstanceProfilesSnapshot(lifecycle)).profiles.find(row => row.id === profile.id);
    expect(rechecked).toMatchObject({ runtimeRunning: true, browserPaired: true,
      connection: { core: { state: 'unknown' } }, connector: { status: 'unknown' } });
    expect(rechecked?.connection.detail).not.toContain('needs pairing');
  });

  it('treats an absent durable swarm as proven idle instead of loading the inactive runtime', async () => {
    const profile = await createLocalInstanceProfile('Work', 'Profile 2');
    await expect(persistedProfileWorkerCounts(profile.id)).resolves.toEqual({ active: 0, queued: 0 });
  });

  it('counts only live or invited workers from the profile-owned active durable runs', async () => {
    const profile = await createLocalInstanceProfile('Work', 'Profile 2');
    await writeSwarm(profile.id, {
      version: 6,
      savedAt: Date.now(),
      runId: null,
      primeConversationId: null,
      startedAt: null,
      agents: [],
      activeRuns: [{
        runId: 'run-work',
        primeConversationId: 'prime-work',
        startedAt: Date.now(),
        agents: [
          { info: { role: 'prime', state: 'active' }, queue: [] },
          { info: { role: 'worker', state: 'active' }, queue: [] },
          { info: { role: 'worker', state: 'detached' }, queue: [] },
          { info: { role: 'worker', state: 'waking' }, queue: [] },
          { info: { role: 'worker', state: 'invited' }, queue: [] },
          { info: { role: 'worker', state: 'sleeping' }, queue: [] },
          { info: { role: 'worker', state: 'finished' }, queue: [] }
        ]
      }],
      dormantRuns: [{
        primeConversationId: 'old-prime',
        startedAt: 1,
        parkedAt: 2,
        agents: [{ info: { role: 'worker', state: 'active' }, queue: [] }]
      }]
    });
    await expect(persistedProfileWorkerCounts(profile.id)).resolves.toEqual({ active: 3, queued: 1 });
    const activeId = getConfig().instances!.activeInstanceId;
    const lifecycle = new ProfileLifecycleCoordinator({
      profileId: activeId,
      admission: new WorkAdmissionGate(),
      census: async () => ({ profileId: activeId, blockers: [] }),
      readDeferredSwitch: async () => null,
      writeDeferredSwitch: async () => undefined,
      onSwitchReady: async () => undefined,
      applyUpdate: async () => undefined,
      applyShutdown: async () => undefined
    });
    const projected = (await buildInstanceProfilesSnapshot(lifecycle)).profiles.find(row => row.id === profile.id);
    expect(projected).toMatchObject({ active: false, activeWorkers: 3, queuedWorkers: 1 });
    // MCP surface path tokens are generated only when this profile's server starts, so an
    // inactive profile must never invent a URL while projecting its persisted state.
    expect(projected?.connector.mcpUrl).toBeNull();
  });

  it('reports unavailable for corrupt state or a profile owned by another physical device', async () => {
    const profile = await createLocalInstanceProfile('Work', 'Profile 2');
    const owners = getLocalInstanceOwnerPaths(profile.id)!;
    await fs.mkdir(path.join(owners.durableStoreRoot, 'state'), { recursive: true });
    await fs.writeFile(path.join(owners.durableStoreRoot, 'state', 'swarm.json'), '{broken', 'utf8');
    await expect(persistedProfileWorkerCounts(profile.id)).resolves.toBeNull();

    const otherDevice = '00000000-0000-4000-8000-000000000099';
    await updateConfig(config => ({
      ...config,
      instances: {
        ...config.instances!,
        profiles: config.instances!.profiles.map(row => row.id === profile.id ? { ...row, deviceId: otherDevice } : row)
      }
    }));
    expect(getConfig().instances!.profiles.find(row => row.id === profile.id)?.deviceId).toBe(otherDevice);
    await expect(persistedProfileWorkerCounts(profile.id)).resolves.toBeNull();
  });
});

describe('profile lifecycle input census', () => {
  const queued = (overrides: Partial<InputEntry> = {}): InputEntry => ({
    id: randomUUID(),
    sessionId: 'session-census',
    text: 'Preserve this exact queued input',
    mode: 'after-turn',
    dueAt: Date.now(),
    model: null,
    reasoningEffort: null,
    state: 'queued',
    owner: null,
    createdAt: Date.now(),
    conversationId: 'conversation-census',
    ...overrides
  });

  async function seed(row: InputEntry): Promise<void> {
    await writeDurableNow('session-input', [row]);
    resetInputForTests();
  }

  beforeEach(() => {
    resetBridgeForTests();
    resetInputForTests();
    resetDurableForTests();
    resetSessionStoreForTests();
    initDurableStore(dir);
    initSessionStore(dir);
  });

  afterEach(() => {
    resetBridgeForTests();
    resetInputForTests();
    resetDurableForTests();
    resetSessionStoreForTests();
    unsetSessionRootForTests();
  });

  it('keeps managed background execution as a shutdown barrier without a native recorder turn', async () => {
    const processes = vi.spyOn(unifiedExecManager, 'listProcesses').mockReturnValue([
      { processId: 4242, command: 'owned background work', cwd: dir, pid: 4321, tty: false }
    ]);
    const shutdown = vi.fn(async () => undefined);
    const lifecycle = new ProfileLifecycleCoordinator({
      profileId: getConfig().instances!.activeInstanceId,
      admission: new WorkAdmissionGate(), census: activeProfileWorkCensus,
      readDeferredSwitch: async () => null, writeDeferredSwitch: async () => undefined,
      onSwitchReady: async () => undefined, applyUpdate: async () => undefined, applyShutdown: shutdown
    });
    await expect(lifecycle.requestShutdown()).resolves.toMatchObject({ outcome: 'draining',
      status: { blockers: [{ category: 'local-process', count: 1, detail: expect.any(String) }] } });
    expect(shutdown).not.toHaveBeenCalled();
    processes.mockReturnValue([]);
    await lifecycle.poll();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('retains a fresh native busy page through shutdown when its current recorder turn is missing', async () => {
    resetCoreBrowserEvidenceForTests();
    const conversationId = randomUUID();
    const session = await createSession({ conversationId });
    const before = await getSession(session.id);
    const observe = (reason: 'busy' | 'associated') => noteCoreBrowserEvidence({
      conversationId, documentId: 'native-busy-lifecycle-doc', navigationEpoch: 0,
      observedAt: Date.now(), shell: 'classic', shellDiscovery: 'compatible', requestIds: [], turnId: null,
      ordinaryFinal: { reason, questions: 0, calls: 0, openCalls: 0,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false }
    });
    expect(observe('busy')).toBe(true);
    const shutdown = vi.fn(async () => undefined);
    const lifecycle = new ProfileLifecycleCoordinator({
      profileId: getConfig().instances!.activeInstanceId,
      admission: new WorkAdmissionGate(), census: activeProfileWorkCensus,
      readDeferredSwitch: async () => null, writeDeferredSwitch: async () => undefined,
      onSwitchReady: async () => undefined, applyUpdate: async () => undefined, applyShutdown: shutdown
    });
    try {
      await expect(lifecycle.requestShutdown()).resolves.toMatchObject({ outcome: 'draining',
        status: { blockers: [{ category: 'active-turn', count: 1 }] } });
      expect(shutdown).not.toHaveBeenCalled();
      expect(await getSession(session.id)).toEqual(before);
      expect(observe('associated')).toBe(true);
      await lifecycle.poll();
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(await getSession(session.id)).toEqual(before);
    } finally { resetCoreBrowserEvidenceForTests(); }
  });

  it('allows maintenance around positively idle presentation custody without clearing original native debt', async () => {
    resetCoreBrowserEvidenceForTests();
    const conversationId = randomUUID();
    await createSession({ conversationId });
    const observe = (reason: string, maintenanceIdle?: unknown) => noteCoreBrowserEvidence({
      conversationId, documentId: 'idle-presentation-lifecycle-doc', navigationEpoch: 0,
      observedAt: Date.now(), shell: 'classic', shellDiscovery: 'compatible', requestIds: [], turnId: null,
      ordinaryFinal: { reason, questions: 1, calls: 1, openCalls: 1, codeCalls: 0, openCodeCalls: 0,
        activeTurnMapped: false, sourceUserMessageId: conversationId,
        coreCallMessageIds: ['retained-native-parent'], allCoreRequestIds: ['wfr-retained-native'],
        openRequestIds: ['wfr-retained-native'], codeCallMessageIds: [], openCodeCallMessageIds: [],
        ...(maintenanceIdle === undefined ? {} : { maintenanceIdle }) }
    });
    try {
      expect(observe('open-call')).toBe(true);
      const original = coreBrowserEvidence(conversationId)!.pendingCompletion;
      expect(original?.openCalls).toBe(1);
      expect(observe('busy', true)).toBe(true);
      expect((await activeProfileWorkCensus()).blockers).toEqual([]);
      expect(coreBrowserEvidence(conversationId)!.pendingCompletion).toEqual(original);
      for (const ambiguous of [undefined, false, 'true', 1]) {
        expect(observe('busy', ambiguous)).toBe(true);
        expect((await activeProfileWorkCensus()).blockers).toContainEqual(expect.objectContaining({ category: 'active-turn', count: 1 }));
      }
    } finally { resetCoreBrowserEvidenceForTests(); }
  });

  it('does not treat a future positive maintenance bit as verified quiescence', async () => {
    resetCoreBrowserEvidenceForTests();
    const conversationId = randomUUID();
    await createSession({ conversationId });
    expect(noteCoreBrowserEvidence({ conversationId, documentId: 'future-maintenance', navigationEpoch: 0,
      observedAt: Date.now() + 1000, shell: 'classic', shellDiscovery: 'compatible', requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'busy', questions: 0, calls: 0, openCalls: 0, codeCalls: 0,
        openCodeCalls: 0, activeTurnMapped: false, maintenanceIdle: true } })).toBe(true);
    expect((await activeProfileWorkCensus()).blockers).toContainEqual(expect.objectContaining({ category: 'active-turn', count: 1 }));
    resetCoreBrowserEvidenceForTests();
  });

  it('counts every simultaneous native busy page without inventing recorder turns', async () => {
    resetCoreBrowserEvidenceForTests();
    const sessions = await Promise.all(Array.from({ length: 5 }, () => createSession({ conversationId: randomUUID() })));
    const before = await Promise.all(sessions.map(row => getSession(row.id)));
    try {
      for (const row of sessions) expect(noteCoreBrowserEvidence({
        conversationId: row.conversationId!, documentId: 'native-multiple-' + row.id,
        navigationEpoch: 0, observedAt: Date.now(), shell: 'classic', shellDiscovery: 'compatible',
        requestIds: [], turnId: null,
        ordinaryFinal: { reason: 'busy', questions: 0, calls: 0, openCalls: 0,
          codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false }
      })).toBe(true);
      expect((await activeProfileWorkCensus()).blockers).toContainEqual(expect.objectContaining({
        category: 'active-turn', count: 5
      }));
      expect(await Promise.all(sessions.map(row => getSession(row.id)))).toEqual(before);
    } finally { resetCoreBrowserEvidenceForTests(); }
  });

  it.each(['expired', 'future-fresh', 'future-expired', 'foreign', 'incompatible', 'unresolved-final'] as const)(
    'does not promote %s native diagnostics into current execution or completion', async kind => {
      resetCoreBrowserEvidenceForTests();
      const conversationId = randomUUID();
      const session = await createSession({ conversationId });
      const before = await getSession(session.id);
      const observedAt = Date.now() + (kind === 'expired' ? -CORE_BROWSER_EVIDENCE_MAX_AGE_MS - 1000
        : kind === 'future-expired' ? CORE_BROWSER_EVIDENCE_MAX_AGE_MS + 1000 : kind === 'future-fresh' ? 1000 : 0);
      try {
        expect(noteCoreBrowserEvidence({
          conversationId: kind === 'foreign' ? randomUUID() : conversationId,
          documentId: 'native-busy-boundary-doc', navigationEpoch: 0, observedAt,
          shell: 'classic', shellDiscovery: kind === 'incompatible' ? 'failed' : 'compatible',
          requestIds: [], turnId: null,
          ordinaryFinal: { reason: kind === 'unresolved-final' ? 'open-call' : 'busy', questions: 0,
            calls: 0, openCalls: 0, codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false }
        })).toBe(true);
        const work = await activeProfileWorkCensus();
        expect(work.blockers.filter(row => row.category === 'active-turn')).toHaveLength(kind === 'future-fresh' ? 1 : 0);
        expect(await getSession(session.id)).toEqual(before);
      } finally { resetCoreBrowserEvidenceForTests(); }
    }
  );

  it('shuts down around paused automatic debt while retaining the exact durable UUID for cold restore', async () => {
    await updateConfig(config => ({ ...config, ui: { ...config.ui, automationPaused: true } }));
    const row = queued();
    await seed(row);
    const ledger = path.join(dir, 'state', 'session-input.json');
    const before = await fs.readFile(ledger, 'utf8');
    const shutdown = vi.fn(async () => undefined);
    const profileId = getConfig().instances!.activeInstanceId;
    const lifecycle = new ProfileLifecycleCoordinator({
      profileId,
      admission: new WorkAdmissionGate(),
      census: activeProfileWorkCensus,
      readDeferredSwitch: async () => null,
      writeDeferredSwitch: async () => undefined,
      onSwitchReady: async () => undefined,
      applyUpdate: async () => undefined,
      applyShutdown: shutdown
    });

    await expect(lifecycle.requestShutdown()).resolves.toMatchObject({ outcome: 'applied' });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(ledger, 'utf8')).toBe(before);
    resetInputForTests();
    const [cold] = await listInputs();
    expect(cold).toMatchObject({ id: row.id, state: 'queued', owner: null });
    expect(cold?.offeredAt).toBeUndefined();
    expect(cold?.sendAuthorizedAt).toBeUndefined();
    expect(cold?.deliveredAt).toBeUndefined();
    expect(cold?.messageId).toBeUndefined();
  });

  it('does not count an exact attention-parked never-claimed message as live shutdown work', async () => {
    const row = queued({
      mode: 'auto',
      deliveryAttentionAt: Date.now(),
      error: 'Needs attention: Chrome did not claim this message.'
    });
    await seed(row);

    await expect(activeProfileWorkCensus()).resolves.toMatchObject({ blockers: [] });
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'queued', owner: null, deliveryAttentionAt: row.deliveryAttentionAt
    });
  });

  it('drains around untouched automatic debt without changing pause or losing its durable identity', async () => {
    const row = queued({ sourceHelperId: randomUUID() });
    await seed(row);
    const ledger = path.join(dir, 'state', 'session-input.json');
    const before = await fs.readFile(ledger, 'utf8');
    const profileId = getConfig().instances!.activeInstanceId;
    const shutdown = vi.fn(async () => undefined);
    const lifecycle = new ProfileLifecycleCoordinator({
      profileId, admission: profileWorkAdmission, census: activeProfileWorkCensus,
      readDeferredSwitch: async () => null, writeDeferredSwitch: async () => undefined,
      onSwitchReady: async () => undefined, applyUpdate: async () => undefined,
      applyShutdown: shutdown
    });
    try {
      expect(getConfig().ui.automationPaused).not.toBe(true);
      await expect(lifecycle.requestShutdown()).resolves.toMatchObject({ outcome: 'applied' });
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(getConfig().ui.automationPaused).not.toBe(true);
      expect(await fs.readFile(ledger, 'utf8')).toBe(before);
      resetInputForTests();
      expect(await listInputs()).toEqual([row]);
    } finally {
      const owner = profileWorkAdmission.snapshot().owner;
      if (owner) profileWorkAdmission.release(owner);
    }
  });

  it.each([
    { name: 'manual work', row: () => queued({ mode: 'auto' }), category: 'pending-send' },
    { name: 'prior offer', row: () => queued({ offeredAt: Date.now() }), category: 'pending-send' },
    { name: 'native receipt', row: () => queued({ messageId: randomUUID() }), category: 'pending-send' },
    { name: 'claimed work', row: () => queued({ state: 'browser', owner: 'native-owner' }), category: 'pending-send' },
    { name: 'authorized Send', row: () => queued({ state: 'browser', sendAuthorizedAt: Date.now() }), category: 'ambiguous-send' },
    { name: 'uncertain tool receipt', row: () => queued({ toolReceiptUncertain: true }), category: 'pending-send' }
  ])('keeps $name as a blocker during unpaused Drain', async ({ row, category }) => {
    await seed(row());
    const owner = randomUUID();
    profileWorkAdmission.beginDrain(owner);
    try {
      expect(getConfig().ui.automationPaused).not.toBe(true);
      expect((await activeProfileWorkCensus()).blockers).toContainEqual(
        expect.objectContaining({ category, count: 1 })
      );
    } finally {
      profileWorkAdmission.release(owner);
    }
  });

  it.each([
    {
      name: 'an uncertain tool receipt',
      fields: () => ({ toolReceiptUncertain: true })
    },
    {
      name: 'a retained downstream response',
      fields: () => ({ response: 'retained downstream response' })
    },
    {
      name: 'a null delivered-session projection despite contradictory pre-Send evidence',
      fields: () => ({
        deliveredSessionId: null,
        recoveryFailure: {
          phase: 'pre_send_preparation' as const,
          retrySafe: true,
          detail: 'contradictory pre-Send evidence cannot authorize a null projection'
        }
      })
    },
    {
      name: 'a null delivered-session projection despite a confirmed recovery withdrawal',
      fields: () => ({
        deliveredSessionId: null,
        recoveryWithdrawnSince: Date.now(),
        recoveryWithdrawAttempts: 1,
        silenceBoundary: {
          turnId: 'source-turn',
          conversationId: 'conversation-census',
          workSeq: 1
        }
      })
    },
    {
      name: 'a concrete delivered-session projection',
      fields: () => ({ deliveredSessionId: 'delivered-session' })
    },
    {
      name: 'an ambiguous native Send failure',
      fields: () => ({
        recoveryFailure: {
          phase: 'native_send_ambiguous' as const,
          retrySafe: false,
          detail: 'native Send outcome is unknown'
        }
      })
    },
    {
      name: 'a latest missing-receipt transition over an older pre-Send failure',
      fields: () => ({
        recoveryFailure: {
          phase: 'pre_send_preparation' as const,
          retrySafe: true,
          detail: 'older confirmed pre-Send release'
        },
        recoveryTransitions: [{
          at: Date.now(),
          from: 'browser',
          to: 'queued',
          phase: 'receipt_missing' as const,
          reason: 'latest delivery receipt is missing'
        }]
      })
    },
    {
      name: 'an unknown provider recovery transition',
      fields: () => ({
        recoveryTransitions: [{
          at: Date.now(),
          from: 'browser',
          to: 'queued',
          phase: 'provider_recovery_unknown' as const,
          reason: 'provider outcome is unknown'
        }]
      })
    }
  ])('keeps paused queued work with $name as a lifecycle blocker', async ({ fields }) => {
    await updateConfig(config => ({ ...config, ui: { ...config.ui, automationPaused: true } }));
    await seed(queued(fields()));

    const census = await activeProfileWorkCensus();
    expect(census.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'pending-send', count: 1 })
    ]));
  });

  it.each([
    {
      name: 'a never-offered tool-intent row',
      fields: () => ({ transportIntent: 'tool' as const })
    },
    {
      name: 'a confirmed pre-Send failure',
      fields: () => ({
        deliveredSessionId: 'projected-session',
        recoveryFailure: {
          phase: 'pre_send_preparation' as const,
          retrySafe: true,
          detail: 'confirmed failure before native Send'
        }
      })
    },
    {
      name: 'a positively withdrawn pre-Send recovery with a project binding',
      fields: () => ({
        deliveredSessionId: 'projected-session',
        recoveryWithdrawnSince: Date.now(),
        recoveryWithdrawAttempts: 1,
        silenceBoundary: {
          turnId: 'source-turn',
          conversationId: 'conversation-census',
          workSeq: 1
        }
      })
    },
    {
      name: 'a latest pre-Send transition over older ambiguous evidence',
      fields: () => ({
        recoveryFailure: {
          phase: 'native_send_ambiguous' as const,
          retrySafe: false,
          detail: 'older ambiguous evidence'
        },
        recoveryTransitions: [{
          at: Date.now(),
          from: 'browser',
          to: 'queued',
          phase: 'pre_send_preparation' as const,
          reason: 'latest owner proved native Send did not happen'
        }]
      })
    }
  ])('defers paused automatic work with $name', async ({ fields }) => {
    await updateConfig(config => ({ ...config, ui: { ...config.ui, automationPaused: true } }));
    await seed(queued(fields()));

    await expect(activeProfileWorkCensus()).resolves.toMatchObject({ blockers: [] });
  });

  it.each([
    {
      name: 'explicit manual work while paused',
      paused: true,
      row: () => queued({ mode: 'auto' }),
      category: 'pending-send'
    },
    {
      name: 'ordinary automatic work while unpaused',
      paused: false,
      row: () => queued(),
      category: 'pending-send'
    },
    {
      name: 'a queued row carrying prior offer evidence',
      paused: true,
      row: () => queued({ offeredAt: Date.now() }),
      category: 'pending-send'
    },
    {
      name: 'a claimed browser preparation',
      paused: true,
      row: () => queued({ state: 'browser', owner: 'page-owner', offeredAt: Date.now() }),
      category: 'pending-send'
    },
    {
      name: 'an authorized browser send',
      paused: true,
      row: () => queued({ state: 'browser', owner: 'page-owner', offeredAt: Date.now(), sendAuthorizedAt: Date.now() }),
      category: 'ambiguous-send'
    },
    {
      name: 'a tool delivery',
      paused: true,
      row: () => queued({ state: 'tool', owner: 'tool-owner', offeredAt: Date.now() }),
      category: 'ambiguous-send'
    }
  ])('keeps $name as a lifecycle blocker', async ({ paused, row, category }) => {
    await updateConfig(config => ({ ...config, ui: { ...config.ui, automationPaused: paused } }));
    await seed(row());

    const census = await activeProfileWorkCensus();
    expect(census.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ category, count: 1 })
    ]));
  });
});

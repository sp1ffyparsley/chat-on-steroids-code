import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, clipboard } from 'electron';
import { projectConnectorNames, type InstanceProfile } from '../shared/instance-profile.js';
import { setupApiKeySlot } from '../shared/setup-profile.js';
import { setSetupCoreTunnel } from './setup-profiles.js';
import type { ConnectionState, SurfaceStatus } from '../shared/types.js';
import {
  createLocalInstanceProfile,
  getActiveInstanceRuntime,
  getConfig,
  getInstanceRegistry,
  readCanonicalInstanceConfig,
  INSTANCE_BRIDGE_PORT_MAX,
  INSTANCE_BRIDGE_PORT_MIN,
  removeUnusedLocalInstanceProfile,
  renameLocalInstanceProfile,
  prepareIsolatedInstanceRuntimeConfig,
  setLocalInstanceBridgePort,
  setLocalInstanceBrowserProfile,
  setLocalInstanceProfileEnabled,
  updateConfig
} from './config.js';
import { bridgeStatus } from './bridge.js';
import { connect, disconnect, getStatus } from './connection.js';
import { openInPreferredBrowser } from './browser.js';
import { findWindowsPowerShell, launchCommand } from './exec.js';
import { assertCanonicalAccountRouting, isolatedProcessArgument } from './instance-process.js';
import { logEvent } from './logger.js';
import { TUNNEL_ID_PATTERN } from './tunnel/index.js';
import { persistedProfileWorkerCounts, profileWorkerCounts } from './profile-work-state.js';
import { accountSurfaceDescriptions } from './mcp/surfaces.js';
import type { ProfileLifecycleCoordinator, ProfileLifecycleStatus, SwitchRequestResult } from './profile-lifecycle.js';
import {
  bridgeExtensionOriginSecretSlot,
  bridgeTokenSecretSlot,
  hasSecret,
  seedIsolatedInstanceSecrets
} from './secrets.js';

export type InstanceProfileConnectionState = 'disconnected' | 'starting' | 'connected' | 'offline' | 'error';
export type InstanceProfileCoreState = 'off' | 'unknown' | 'starting' | 'live' | 'error';

export function requirePrimaryAccountManager(): void {
  if (process.argv.some(argument => argument.startsWith('--cos-instance-runtime='))) {
    throw new Error('Manage account profiles from the primary account window; this window owns only its active account.');
  }
}

export interface InstancePendingOperationView {
  kind: string;
  label: string;
  status?: string;
}

export interface InstanceConnectorSetupView {
  displayName: string;
  description: string;
  mcpUrl: string | null;
  status: InstanceProfileCoreState;
  lastSuccessfulRequestAt: number | null;
  error: string | null;
}

export interface InstanceProfileView {
  id: string;
  nickname: string;
  platform: InstanceProfile['platform'];
  enabled: boolean;
  active: boolean;
  runtimeMode: InstanceProfile['state']['mode'];
  runtimeRunning: boolean;
  runtimePrepared: boolean;
  browserPaired: boolean | null;
  browserAuth: 'signed-in' | 'signed-out' | 'unknown' | null;
  browserProfileDirectory: string;
  /** Null when a prepared sibling owns private connector settings this process cannot verify. */
  coreTunnelId: string | null;
  hasRuntimeApiKey: boolean | null;
  connection: {
    state: InstanceProfileConnectionState;
    detail?: string | null;
    core: {
      state: InstanceProfileCoreState;
      detail?: string | null;
      lastSuccessfulRequestAt: number | null;
      error?: string | null;
    };
  };
  activeWorkers: number | null;
  queuedWorkers: number | null;
  pendingOperations: InstancePendingOperationView[];
  connector: InstanceConnectorSetupView;
}

export interface InstanceProfilesSnapshot {
  activeProfileId: string;
  canManageProfiles: boolean;
  profiles: InstanceProfileView[];
  drain: {
    kind: 'none' | 'drain' | 'switch' | 'update' | 'shutdown';
    phase: ProfileLifecycleStatus['phase'];
    state: 'idle' | 'draining' | 'ready' | 'applying' | 'error';
    detail: string | null;
    pendingOperations: number;
  };
}

export interface InstanceProfileSwitchResult {
  snapshot: InstanceProfilesSnapshot;
  outcome: 'switched' | 'needs-drain' | 'queued' | 'blocked';
  message?: string;
}

/**
 * Return persistent Chrome profile directories that are safe to offer when linking another
 * ChatGPT account. Only directory names cross into the renderer; account names, emails,
 * cookies and Chrome preference contents are never read.
 */
export async function listManagedBrowserProfiles(options: { includeUnboundLegacyDefault?: boolean } = {}): Promise<string[]> {
  const runtime = getActiveInstanceRuntime();
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const chromeRoot = runtime.profile.platform === 'win32'
    ? process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : ''
    : runtime.profile.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')
      : path.join(home, '.config', 'google-chrome');
  if (!chromeRoot) return [];

  const registry = (await readCanonicalInstanceConfig()).instances!;
  const used = new Set(
    registry.profiles
      .filter(profile => profile.deviceId === runtime.profile.deviceId && profile.browser.profileDirectory)
      .map(profile => profile.browser.profileDirectory!.toLowerCase())
  );
  // The migrated profile intentionally has no explicit Chrome directory. Do not suggest Default
  // while that ambiguity remains, because it may already be the browser identity the legacy
  // installation owns. A user can still type Default explicitly if they know it is separate.
  if (!options.includeUnboundLegacyDefault && registry.profiles.some(profile =>
    profile.deviceId === runtime.profile.deviceId && profile.state.mode === 'legacy' && !profile.browser.profileDirectory)) {
    used.add('default');
  }

  const found: string[] = [];
  try {
    for await (const entry of await fs.opendir(chromeRoot)) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name !== 'Default' && entry.name !== 'Profile' && !/^Profile [1-9][0-9]*$/.test(entry.name)) continue;
      if (used.has(entry.name.toLowerCase())) continue;
      try {
        const preferences = await fs.lstat(path.join(chromeRoot, entry.name, 'Preferences'));
        if (!preferences.isFile() || preferences.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      found.push(entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
  return found.sort((left, right) => {
    if (left === 'Default') return -1;
    if (right === 'Default') return 1;
    if (left === 'Profile') return -1;
    if (right === 'Profile') return 1;
    return Number(left.slice('Profile '.length)) - Number(right.slice('Profile '.length));
  });
}

function connectionState(state: ConnectionState): InstanceProfileConnectionState {
  if (state === 'connected') return 'connected';
  if (state === 'starting-server' || state === 'connecting-tunnel') return 'starting';
  if (state === 'offline') return 'offline';
  if (state === 'disconnected') return 'disconnected';
  return 'error';
}

function coreStatus(surface: SurfaceStatus | undefined): InstanceProfileCoreState {
  return surface?.state ?? 'off';
}

function nickname(profile: InstanceProfile): string {
  return profile.accountLabel.trim() || profile.displayName.trim() ||
    (profile.state.mode === 'legacy' ? 'Default' : profile.id);
}

function browserLabel(profile: InstanceProfile): string {
  if (profile.browser.profileDirectory) return profile.browser.profileDirectory;
  return profile.state.mode === 'legacy' ? 'Current Chrome profile (legacy)' : profile.browser.profileId;
}

function operationViews(profileId: string, lifecycle: ProfileLifecycleStatus): InstancePendingOperationView[] {
  const items: InstancePendingOperationView[] = [];
  if (lifecycle.profileId === profileId) {
    for (const blocker of lifecycle.blockers) {
      items.push({ kind: blocker.category, label: blocker.detail ?? blocker.category, status: String(blocker.count) });
    }
    if (lifecycle.phase !== 'idle') {
      items.push({
        kind: lifecycle.phase,
        label: lifecycle.targetProfileId
          ? `Profile switch to ${lifecycle.targetProfileId}`
          : lifecycle.phase.includes('update')
            ? 'Application update'
            : lifecycle.phase.includes('shutdown')
              ? 'Safe close for update'
              : 'Profile lifecycle transition',
        status: lifecycle.phase
      });
    }
  } else if (lifecycle.targetProfileId === profileId && lifecycle.phase.includes('switch')) {
    items.push({ kind: 'profile-switch-target', label: 'Waiting to become active', status: lifecycle.phase });
  }
  return items;
}

function drainView(status: ProfileLifecycleStatus): InstanceProfilesSnapshot['drain'] {
  const detail = status.blockers.length
    ? status.blockers.map(blocker => `${blocker.count} ${blocker.detail ?? blocker.category}`).join(' · ')
    : status.phase === 'drain-ready'
      ? 'Current work is idle. New work remains paused until you cancel Drain, switch profile, apply an update, or quit.'
      : status.phase === 'switch-ready'
      ? 'Current work is idle. Switching profiles…'
      : status.phase === 'update-applied'
        ? 'Current work is idle. Applying the committed update…'
        : status.phase === 'shutdown-applied' || status.phase === 'draining-shutdown'
          ? 'Current work is idle. Closing safely for the external updater…'
        : null;
  const kind = status.phase === 'idle' ? 'none'
    : status.phase.includes('switch') ? 'switch'
      : status.phase.includes('update') ? 'update'
        : status.phase.includes('shutdown') ? 'shutdown'
          : 'drain';
  const base = { kind, phase: status.phase, detail, pendingOperations: status.blockerCount } as const;
  if (status.phase === 'idle') return { ...base, state: 'idle' };
  if (status.phase === 'drain-ready' || status.phase === 'switch-ready') {
    return { ...base, state: 'ready', pendingOperations: 0 };
  }
  if (status.phase === 'update-applied' || status.phase === 'shutdown-applied') {
    return { ...base, state: 'applying', pendingOperations: 0 };
  }
  return { ...base, state: 'draining' };
}

/** Safe renderer projection. Local state roots, partitions and secret slots stay main-only. */
export async function buildInstanceProfilesSnapshot(lifecycle: ProfileLifecycleCoordinator): Promise<InstanceProfilesSnapshot> {
  const catalog = await readCanonicalInstanceConfig();
  const registry = catalog.instances!;
  const runtime = getActiveInstanceRuntime();
  const canManageProfiles = !process.argv.some(argument => argument.startsWith('--cos-instance-runtime='));
  const activeStatus = getStatus();
  const activeCore = activeStatus.surfaces.find(surface => surface.id === 'core');
  const workers = profileWorkerCounts();
  const bridge = await bridgeStatus();
  const lifecycleStatus = lifecycle.getStatus();

  const profiles = await Promise.all(registry.profiles.map(async (profile): Promise<InstanceProfileView> => {
    // The canonical machine catalog owns which accounts exist. This process retains its own
    // active identity/settings; observing a newer catalog must never switch or grant its roots.
    const active = profile.id === runtime.profile.id;
    const local = profile.platform === runtime.profile.platform && profile.deviceId === runtime.profile.deviceId;
    const runtimePrepared = local && profile.state.mode === 'isolated' && await preparedAccountRuntimeExists(profile);
    const peer = !active && local
      ? await readRunningAccountAtPort(profile.bridge.port) : null;
    const runtimeRunning = active || peer?.instanceId === profile.id;
    const names = projectConnectorNames(profile);
    // A sibling /hello proves only that its exact CoS process is running. This process cannot
    // inspect that sibling's authenticated Core surface, so do not turn missing observation into
    // a false "off" fact. A stopped sibling still has a truthful off state.
    const coreState = active ? coreStatus(activeCore) : runtimeRunning ? 'unknown' : 'off';
    const connectorUrl = active ? (activeCore?.publicUrl ?? activeCore?.localUrl ?? null) : null;
    const inactiveDetail = profile.platform !== runtime.profile.platform || profile.deviceId !== runtime.profile.deviceId
      ? 'This profile belongs to another physical device.'
      : runtimeRunning ? peer?.paired === false
        ? 'Running in another COS window; its browser companion needs pairing.'
        : 'Running in another COS window; inspect that window for live Core and chat status.'
        : 'Start this account alongside the current one or switch to it.';
    const connectorError = active
      ? (coreState === 'error' ? activeCore?.detail || activeStatus.detail || 'Core connector needs attention.' : null)
      : inactiveDetail;
    const profileWorkers = active ? workers : await persistedProfileWorkerCounts(profile.id, registry);
    const setupId = profile.tunnelProfileRef;
    const bootstrapCoreTunnelId = (catalog.tunnel.profileId ?? 'default') === setupId
      ? catalog.tunnel.tunnelId
      : catalog.setupProfiles?.find(setup => setup.id === setupId)?.tunnelId;
    if (bootstrapCoreTunnelId === undefined) throw new Error(`Setup profile is missing for account ${profile.id}.`);
    // First launch copies the bootstrap setup into the isolated runtime. From then on that
    // account's own Settings are authoritative and may have changed independently. An empty
    // canonical bootstrap value is therefore not proof that the sibling lost its tunnel.
    const coreTunnelId = active
      ? getConfig().tunnel.tunnelId
      : runtimePrepared ? null : bootstrapCoreTunnelId;
    const connection = active ? connectionState(activeStatus.state) : 'disconnected';
    const detail = active
      ? [activeStatus.detail,
          bridge.authState === 'signed-out'
            ? `ChatGPT is signed out for ${nickname(profile)}. Queued browser work is preserved until sign-in is verified.`
            : bridge.paired ? (bridge.present ? 'Browser paired and present.' : 'Browser paired; companion is not currently present.') : 'Browser companion is not paired.']
          .filter(Boolean).join(' ')
      : inactiveDetail;
    return {
      id: profile.id,
      nickname: nickname(profile),
      platform: profile.platform,
      enabled: profile.enabled !== false,
      active,
      runtimeMode: profile.state.mode,
      runtimeRunning,
      runtimePrepared,
      browserPaired: active ? bridge.paired : runtimeRunning ? peer?.paired ?? null : null,
      browserAuth: active ? bridge.authState : null,
      browserProfileDirectory: browserLabel(profile),
      coreTunnelId,
      // Prepared siblings own private credentials. A catalog or this process's key store
      // cannot prove that sibling has/has not stored a key; leave its presence explicitly unknown.
      hasRuntimeApiKey: active || (local && canManageProfiles && !runtimePrepared)
        ? await hasSecret(setupApiKeySlot(setupId)) : null,
      connection: {
        state: connection,
        detail,
        core: {
          state: coreState,
          detail: active ? activeCore?.detail ?? null : inactiveDetail,
          lastSuccessfulRequestAt: active ? activeCore?.lastRequestAt ?? null : null,
          ...(connectorError ? { error: connectorError } : {})
        }
      },
      activeWorkers: profileWorkers?.active ?? null,
      queuedWorkers: profileWorkers?.queued ?? null,
      pendingOperations: operationViews(profile.id, lifecycleStatus),
      connector: {
        displayName: names.core.connectorName,
        description: accountSurfaceDescriptions(profile).core,
        mcpUrl: connectorUrl,
        status: coreState,
        lastSuccessfulRequestAt: active ? activeCore?.lastRequestAt ?? null : null,
        error: connectorError
      }
    };
  }));

  return {
    activeProfileId: runtime.profile.id,
    canManageProfiles,
    profiles,
    drain: drainView(lifecycleStatus)
  };
}

/** Save an account's Core tunnel in its existing setup namespace, without switching profiles. */
export async function setManagedProfileCoreTunnel(
  lifecycle: ProfileLifecycleCoordinator,
  id: string,
  tunnelId: string
): Promise<InstanceProfilesSnapshot> {
  requirePrimaryAccountManager();
  await assertManagedAccountStopped(id);
  await assertManagedAccountBootstrapEditable(id);
  if (tunnelId && !TUNNEL_ID_PATTERN.test(tunnelId)) {
    throw new Error('Enter a tunnel ID beginning with tunnel_ followed by 32 hexadecimal characters.');
  }
  await updateConfig(config => {
    const profile = config.instances?.profiles.find(row => row.id === id);
    if (!profile) throw new Error('Account profile not found.');
    if (profile.platform !== getActiveInstanceRuntime().profile.platform ||
        profile.deviceId !== getActiveInstanceRuntime().profile.deviceId) {
      throw new Error('This account belongs to another device.');
    }
    return setSetupCoreTunnel(config, profile.tunnelProfileRef, tunnelId);
  });
  return buildInstanceProfilesSnapshot(lifecycle);
}

export async function createManagedInstanceProfile(
  lifecycle: ProfileLifecycleCoordinator,
  nicknameValue: string,
  browserProfileDirectory: string
): Promise<InstanceProfilesSnapshot & { createdProfileId: string }> {
  requirePrimaryAccountManager();
  const profile = await createLocalInstanceProfile(nicknameValue, browserProfileDirectory);
  logEvent('profile.provisioned', `Registered account profile ${profile.id}; enabled=${profile.enabled}; no runtime launch requested`);
  return { ...await buildInstanceProfilesSnapshot(lifecycle), createdProfileId: profile.id };
}

export async function renameManagedInstanceProfile(
  lifecycle: ProfileLifecycleCoordinator,
  id: string,
  nicknameValue: string,
  options: BridgePortRepairOptions = {}
): Promise<InstanceProfilesSnapshot> {
  requirePrimaryAccountManager();
  logEvent('profile.nickname.requested', `Nickname edit requested for account ${id}; verifying stopped owner`);
  const assertRenameStopped = async (): Promise<void> => {
    requirePrimaryAccountManager();
    await assertManagedAccountStopped(id);
    const profile = getInstanceRegistry().profiles.find(row => row.id === id)!;
    if (profile.id !== getActiveInstanceRuntime().profile.id && profile.state.mode === 'isolated' &&
        await preparedAccountRuntimeExists(profile)) {
      if (!options.processRunning && (process.platform !== 'win32' || !app.isPackaged)) {
        throw new Error('Prepared account nickname changes require an exact installed-process stopped proof on this platform. No account labels were changed.');
      }
      if (await (options.processRunning ?? installedManagedInstanceProcessRunning)(id)) {
        throw new Error(`Account ${id} still has a running Chat On Steroids process. Close that account normally before changing its nickname.`);
      }
    }
  };
  await assertRenameStopped();
  // Human-facing labels belong to the canonical registry even after preparation. The
  // nickname owner mirrors only those labels; connector/browser bootstrap remains fenced.
  await renameLocalInstanceProfile(id, nicknameValue, assertRenameStopped);
  return buildInstanceProfilesSnapshot(lifecycle);
}

/** Filling the active legacy account's missing directory is safe; changing a binding is not. */
export async function setManagedInstanceBrowserProfile(
  lifecycle: ProfileLifecycleCoordinator,
  id: string,
  browserProfileDirectory: string
): Promise<InstanceProfilesSnapshot> {
  requirePrimaryAccountManager();
  await assertManagedAccountStopped(id);
  await assertManagedAccountBootstrapEditable(id);
  const profile = getInstanceRegistry().profiles.find(row => row.id === id);
  if (!profile) throw new Error('Account profile not found.');
  if (profile.id === getActiveInstanceRuntime().profile.id && profile.browser.profileDirectory &&
      profile.browser.profileDirectory.toLowerCase() !== browserProfileDirectory.trim().toLowerCase()) {
    throw new Error('Pause this account and switch away before changing its existing Chrome profile.');
  }
  // The ordinary picker hides Default while the legacy account is unbound so another account
  // cannot accidentally claim it. The legacy account's explicit bootstrap save must still be
  // able to validate and bind that existing directory, as the UI promises.
  const available = await listManagedBrowserProfiles({
    includeUnboundLegacyDefault: profile.state.mode === 'legacy' && !profile.browser.profileDirectory
  });
  if (!available.some(directory => directory.toLowerCase() === browserProfileDirectory.trim().toLowerCase())) {
    throw new Error('Choose an existing, unassigned Chrome profile directory on this device.');
  }
  if (profile.browser.profileDirectory &&
      (await hasSecret(bridgeTokenSecretSlot(profile.state.mode, profile.id)) ||
       await hasSecret(bridgeExtensionOriginSecretSlot(profile.state.mode, profile.id)))) {
    throw new Error('This account is still paired with its previous browser. Disconnect that pairing before rebinding it.');
  }
  await setLocalInstanceBrowserProfile(id, browserProfileDirectory);
  return buildInstanceProfilesSnapshot(lifecycle);
}

export async function setManagedInstanceProfileEnabled(
  lifecycle: ProfileLifecycleCoordinator,
  id: string,
  enabled: boolean
): Promise<InstanceProfilesSnapshot> {
  requirePrimaryAccountManager();
  await assertManagedAccountStopped(id);
  await setLocalInstanceProfileEnabled(id, enabled);
  return buildInstanceProfilesSnapshot(lifecycle);
}

async function profileIsUnused(profile: InstanceProfile): Promise<{ unused: boolean; reason: string | null }> {
  const config = getConfig();
  const setup = config.setupProfiles?.find(row => row.id === profile.tunnelProfileRef);
  if (setup && (setup.tunnelId || setup.desktopTunnelId || setup.pluginsTunnelId)) {
    return { unused: false, reason: 'This profile still has saved tunnel registrations. Clear those registrations before removing it.' };
  }
  if (await hasSecret(setupApiKeySlot(profile.tunnelProfileRef))) {
    return { unused: false, reason: 'This profile still has a connector API key. Clear its connector setup before removing it.' };
  }
  if (await hasSecret(bridgeTokenSecretSlot(profile.state.mode, profile.id)) ||
      await hasSecret(bridgeExtensionOriginSecretSlot(profile.state.mode, profile.id))) {
    return { unused: false, reason: 'This profile is still paired with a browser companion. Disconnect that pairing before removing it.' };
  }
  try {
    const entries = await fs.readdir(profile.state.root);
    if (entries.length > 0) {
      return { unused: false, reason: 'This profile already owns local sessions, queues, logs, or diagnostics. Disable it and keep it instead of deleting its history.' };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { unused: true, reason: null };
}

export async function removeManagedInstanceProfile(
  lifecycle: ProfileLifecycleCoordinator,
  id: string,
  confirmation: string
): Promise<InstanceProfilesSnapshot> {
  requirePrimaryAccountManager();
  await assertManagedAccountStopped(id);
  const profile = getInstanceRegistry().profiles.find(row => row.id === id);
  if (!profile) throw new Error('Account profile not found.');
  if (confirmation.trim() !== nickname(profile)) throw new Error('Type the exact profile nickname to confirm removal.');
  const state = await profileIsUnused(profile);
  if (!state.unused) throw new Error(state.reason ?? 'This profile is still in use.');
  await removeUnusedLocalInstanceProfile(id);
  try { await fs.rmdir(profile.state.root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
  }
  return buildInstanceProfilesSnapshot(lifecycle);
}

export async function openManagedInstanceBrowser(id: string): Promise<boolean> {
  const runtime = getActiveInstanceRuntime();
  const profile = (await readCanonicalInstanceConfig()).instances!.profiles.find(row => row.id === id);
  if (!profile) throw new Error('Account profile not found.');
  if (profile.enabled === false) throw new Error('Choose an enabled account.');
  if (profile.platform !== runtime.profile.platform || profile.deviceId !== runtime.profile.deviceId) {
    throw new Error('This profile belongs to another physical device and cannot open a browser here.');
  }
  if (!profile.browser.profileDirectory) {
    if (profile.state.mode !== 'legacy') throw new Error('Choose an explicit Chrome/Chromium profile directory first.');
    await openInPreferredBrowser('https://chatgpt.com/');
    return true;
  }
  await openInPreferredBrowser('https://chatgpt.com/', { browser: 'chrome', profileDirectory: profile.browser.profileDirectory });
  return true;
}

async function readRunningAccountAtPort(port: number): Promise<{ instanceId: string; paired: boolean } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/hello`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const body = await response.json() as { app?: unknown; instanceId?: unknown; paired?: unknown };
    return body.app === 'chat-on-steroids' && typeof body.instanceId === 'string'
      ? { instanceId: body.instanceId, paired: body.paired === true } : null;
  } catch { return null; }
}

async function runningAccountAtPort(port: number): Promise<string | null> {
  return (await readRunningAccountAtPort(port))?.instanceId ?? null;
}

async function loopbackPortIsAvailable(port: number): Promise<boolean> {
  const server = net.createServer();
  server.unref();
  return new Promise<boolean>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      server.close(error => error ? reject(error) : resolve(true));
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Detect the one recoverable split-brain left by an interruption after the primary profile route
 * was committed but before the stopped isolated runtime mirrored that port. This is only a probe;
 * setLocalInstanceBridgePort remains the validation/mutation authority for the actual repair.
 */
async function preparedBridgeRouteNeedsReconcile(profile: InstanceProfile): Promise<boolean> {
  if (profile.state.mode !== 'isolated') return false;
  const target = path.join(profile.state.root, 'runtime', 'config.json');
  try {
    const file = await fs.lstat(target);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error(`Prepared account ${profile.id} has an unsafe runtime config path.`);
    const decoded = JSON.parse(await fs.readFile(target, 'utf8')) as {
      instances?: { activeInstanceId?: unknown; profiles?: Array<{ id?: unknown; bridge?: { port?: unknown } }> };
    };
    const row = Array.isArray(decoded.instances?.profiles)
      ? decoded.instances!.profiles!.find(candidate => candidate?.id === profile.id)
      : undefined;
    return decoded.instances?.activeInstanceId !== profile.id || row?.bridge?.port !== profile.bridge.port;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // Let the canonical setter produce the full schema/routing error rather than treating a
    // malformed prepared config as safely synchronized.
    return true;
  }
}

const execFileAsync = promisify(execFile);

async function installedManagedInstanceProcessRunning(id: string): Promise<boolean> {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  const powershell = findWindowsPowerShell();
  if (!powershell) throw new Error('Windows PowerShell is unavailable, so the account process could not be proven stopped.');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = $args[0]
$executable = [IO.Path]::GetFullPath($args[1])
$selector = '--cos-instance-runtime=' + [regex]::Escape($target)
$runtimePattern = '(?<!\S)(?:' + $selector + '|"' + $selector + '")(?=\s|$)'
$typePattern = '(?<!\S)"?--type(?:=|\s|")'
$running = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='Chat On Steroids.exe'" -ErrorAction Stop | Where-Object {
  if ([string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$_.CommandLine)) {
    throw 'An account process could not be identified. Check process visibility before changing account settings.'
  }
  $candidate = [IO.Path]::GetFullPath([string]$_.ExecutablePath)
  return $candidate.Equals($executable, [StringComparison]::OrdinalIgnoreCase) -and
    ([string]$_.CommandLine) -match $runtimePattern -and
    ([string]$_.CommandLine) -notmatch $typePattern
})
if ($running.Count -gt 0) { [Console]::Out.Write('running') } else { [Console]::Out.Write('stopped') }
`;
  const censusStartedAt = Date.now();
  try {
    // -Command appends subsequent argv to the command text, rather than binding script $args.
    // Bind these two non-secret literals to one script block; retain spaces/apostrophes exactly.
    const command = `& {\n${script}\n} '${id.replaceAll("'", "''")}' '${process.execPath.replaceAll("'", "''")}'`;
    const result = await execFileAsync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      // Cold Windows CIM startup can exceed five seconds on a busy editing
      // workstation. Keep one bounded probe and require its exact result;
      // expiration still refuses mutation rather than claiming the account idle.
      { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 }
    );
    const status = result.stdout.trim();
    if (status !== 'running' && status !== 'stopped') throw new Error('Account process census returned a malformed status; inspect process visibility before retrying.');
    return status === 'running';
  } catch (error) {
    const elapsedMs = Math.max(0, Date.now() - censusStartedAt);
    const timedOut = elapsedMs >= 10_000 && typeof error === 'object' && error !== null &&
      'killed' in error && error.killed === true;
    throw new Error(`Could not prove account ${id} is stopped before changing account settings (elapsed_ms=${elapsedMs}, reason=${timedOut ? 'timeout' : 'probe_failed'}). Check Windows process/CIM visibility before retrying: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface BridgePortRepairOptions {
  /** Test seam; production uses exact installed-process command-line evidence on Windows. */
  processRunning?: (id: string) => Promise<boolean>;
}

/**
 * Repair a stopped isolated account whose declared loopback port is occupied by a non-CoS
 * process. Another CoS owner on that port is an identity conflict and remains fail-closed.
 */
export async function repairManagedInstanceBridgePortIfOccupied(
  id: string,
  options: BridgePortRepairOptions = {}
): Promise<InstanceProfile> {
  requirePrimaryAccountManager();
  const runtime = getActiveInstanceRuntime();
  let profile = getInstanceRegistry().profiles.find(entry => entry.id === id);
  if (!profile) throw new Error('Account profile not found.');
  if (profile.id === runtime.profile.id) throw new Error('Switch away from this account before repairing its bridge port.');
  if (profile.state.mode !== 'isolated' || profile.platform !== runtime.profile.platform || profile.deviceId !== runtime.profile.deviceId) {
    throw new Error('Bridge-port repair requires an inactive isolated account on this device.');
  }

  const owner = await runningAccountAtPort(profile.bridge.port);
  if (owner) {
    if (owner !== id) throw new Error(`Bridge port ${profile.bridge.port} belongs to ${owner}, not ${id}.`);
    return profile;
  }
  const processRunning = options.processRunning ?? installedManagedInstanceProcessRunning;
  if (await loopbackPortIsAvailable(profile.bridge.port)) {
    if (!await preparedBridgeRouteNeedsReconcile(profile)) return profile;
    if (await processRunning(id)) {
      throw new Error(`Account ${id} still has a running Chat On Steroids process. Close that account normally before repairing its bridge route.`);
    }
    await assertManagedAccountStopped(id);
    return setLocalInstanceBridgePort(id, profile.bridge.port);
  }
  if (await processRunning(id)) {
    throw new Error(`Account ${id} still has a running Chat On Steroids process. Close that account normally before repairing its bridge route.`);
  }
  await assertManagedAccountStopped(id);

  const reserved = new Set(getInstanceRegistry().profiles
    .filter(entry => entry.id !== id && entry.deviceId === profile!.deviceId)
    .map(entry => entry.bridge.port));
  for (let candidate = INSTANCE_BRIDGE_PORT_MIN; candidate <= INSTANCE_BRIDGE_PORT_MAX; candidate += 1) {
    if (candidate === profile.bridge.port || reserved.has(candidate)) continue;
    if (!await loopbackPortIsAvailable(candidate)) continue;
    const previous = profile.bridge.port;
    profile = await setLocalInstanceBridgePort(id, candidate);
    logEvent('profile.bridge.reassigned', `Reassigned account ${id} bridge ${previous}->${candidate} after a local port conflict`);
    return profile;
  }
  throw new Error(`No free Luna Forge X7 bridge port is available in ${INSTANCE_BRIDGE_PORT_MIN}–${INSTANCE_BRIDGE_PORT_MAX}; the account was not changed.`);
}

async function preparedAccountRuntimeExists(profile: InstanceProfile): Promise<boolean> {
  try {
    const file = await fs.lstat(path.join(profile.state.root, 'runtime', 'config.json'));
    if (!file.isFile() || file.isSymbolicLink()) throw new Error(`Prepared account ${profile.id} has an unsafe runtime config path.`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** After first launch, that account's own Settings own tunnel/key preferences. */
export async function assertManagedAccountBootstrapEditable(id: string): Promise<void> {
  const profile = getInstanceRegistry().profiles.find(entry => entry.id === id);
  if (!profile) throw new Error('Account profile not found.');
  if (profile.state.mode === 'isolated' && await preparedAccountRuntimeExists(profile)) {
    throw new Error(`Account ${id} already has private settings. Edit its connector in its own account window; the primary will not overwrite those settings or browser pairing.`);
  }
}

/** Prevent a parent-only config edit from diverging from an already-running account copy. */
export async function assertManagedAccountStopped(id: string): Promise<void> {
  const profile = getInstanceRegistry().profiles.find(entry => entry.id === id);
  if (!profile) throw new Error('Account profile not found.');
  if (profile.id === getActiveInstanceRuntime().profile.id) return;
  const observed = await runningAccountAtPort(profile.bridge.port);
  if (observed) throw new Error(`Account ${id} is running in another window. Pause and close that account before changing its profile settings.`);
}

/** Opens another account's own window without switching or interrupting this account's chats. */
export async function launchManagedInstanceRuntime(id: string): Promise<{ profileId: string; port: number; reused: boolean }> {
  if (!app.isPackaged) throw new Error('Concurrent account launching requires the installed desktop app.');
  const runtime = getActiveInstanceRuntime();
  let profile = (await readCanonicalInstanceConfig()).instances!.profiles.find(entry => entry.id === id);
  if (!profile || profile.id === runtime.profile.id || profile.enabled === false) throw new Error('Choose another enabled account.');
  if (profile.platform !== runtime.profile.platform || profile.deviceId !== runtime.profile.deviceId || !profile.browser.profileDirectory) {
    throw new Error('This account is not bound to this device and an exact Chrome profile.');
  }
  const fromIsolatedAccount = process.argv.some(argument => argument.startsWith('--cos-instance-runtime='));
  if (profile.state.mode === 'legacy' && !fromIsolatedAccount) throw new Error('The primary account is already open in this window.');
  const existing = await runningAccountAtPort(profile.bridge.port);
  if (existing) {
    if (existing !== id) throw new Error(`Bridge port ${profile.bridge.port} belongs to ${existing}, not ${id}.`);
    // A second invocation of this exact account reaches its own Electron singleton and asks
    // that existing window to focus; it cannot create a second set of account owners.
    profile = await recheckManagedLaunchProfile(profile);
    await launchCommand(process.execPath, profile.state.mode === 'isolated' ? [isolatedProcessArgument(id)] : [], path.dirname(process.execPath));
    logEvent('profile.runtime.focused', `Focused account ${id} port=${profile.bridge.port}`);
    return { profileId: id, port: profile.bridge.port, reused: true };
  }
  if (!fromIsolatedAccount) profile = await repairManagedInstanceBridgePortIfOccupied(id);
  else if (!await loopbackPortIsAvailable(profile.bridge.port)) {
    throw new Error(`Bridge port ${profile.bridge.port} is occupied outside CoS. Open ${nickname(profile)} from the primary CoS window so its canonical route can be repaired safely.`);
  }
  if (profile.state.mode === 'isolated') {
    if (fromIsolatedAccount) {
      // An isolated window may focus/start an existing sibling, but only the primary account
      // may create its config and seed its secrets for the first time.
      if (!await preparedAccountRuntimeExists(profile)) {
        throw new Error(`Open ${nickname(profile)} once from the primary CoS window to prepare its private settings, then account switching will work from every window.`);
      }
    } else {
      const runtimeRoot = await prepareIsolatedInstanceRuntimeConfig(id);
      await seedIsolatedInstanceSecrets(runtimeRoot, id, profile.tunnelProfileRef);
    }
  }
  profile = await recheckManagedLaunchProfile(profile);
  const launched = await launchCommand(process.execPath, profile.state.mode === 'isolated' ? [isolatedProcessArgument(id)] : [], path.dirname(process.execPath));
  logEvent('profile.runtime.launched', `Started account ${id} pid=${launched.pid} port=${profile.bridge.port}`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const observed = await runningAccountAtPort(profile.bridge.port);
    if (observed === id) return { profileId: id, port: profile.bridge.port, reused: false };
    if (observed) throw new Error(`Bridge port ${profile.bridge.port} belongs to ${observed}, not ${id}.`);
  }
  throw new Error(`Account ${id} did not start its bridge on 127.0.0.1:${profile.bridge.port} within 20 seconds. Check its account-specific app.log; this account's chats were not stopped.`);
}

/** Catalog refresh/port/config probes cannot lend stale authority to the irreversible OS launch. */
async function recheckManagedLaunchProfile(profile: InstanceProfile): Promise<InstanceProfile> {
  const latest = (await readCanonicalInstanceConfig()).instances!.profiles.find(row => row.id === profile.id);
  if (!latest || latest.enabled === false) throw new Error('Choose another enabled account.');
  assertCanonicalAccountRouting(profile, latest);
  return latest;
}

export async function copyManagedConnectorSetup(id: string, lifecycle: ProfileLifecycleCoordinator): Promise<boolean> {
  const snapshot = await buildInstanceProfilesSnapshot(lifecycle);
  const profile = snapshot.profiles.find(row => row.id === id);
  if (!profile) throw new Error('Account profile not found.');
  clipboard.writeText([profile.connector.displayName, profile.connector.mcpUrl, profile.connector.description]
    .filter((value): value is string => value !== null).join('\n'));
  return true;
}

export async function refreshActiveInstanceConnector(lifecycle: ProfileLifecycleCoordinator): Promise<InstanceProfilesSnapshot> {
  await disconnect();
  await connect();
  return buildInstanceProfilesSnapshot(lifecycle);
}

export async function switchManagedInstanceProfile(
  id: string,
  mode: 'check' | 'after-work',
  lifecycle: ProfileLifecycleCoordinator
): Promise<InstanceProfileSwitchResult> {
  requirePrimaryAccountManager();
  const target = getInstanceRegistry().profiles.find(profile => profile.id === id);
  if (!target) throw new Error('Account profile not found.');
  if (target.enabled === false) throw new Error('Enable this account profile before switching to it.');
  const runtime = getActiveInstanceRuntime();
  if (target.platform !== runtime.profile.platform || target.deviceId !== runtime.profile.deviceId) {
    throw new Error('This profile belongs to another physical device. Rebind a portable profile on this device instead.');
  }
  if (target.state.mode === 'isolated' && !target.browser.profileDirectory) {
    throw new Error('Choose an explicit Chrome/Chromium profile directory before activating this account.');
  }
  const result: SwitchRequestResult = await lifecycle.requestSwitch(id, mode === 'after-work');
  const snapshot = await buildInstanceProfilesSnapshot(lifecycle);
  if (result.outcome === 'blocked') {
    return {
      snapshot,
      outcome: 'needs-drain',
      message: result.status.blockers.map(blocker => `${blocker.count} ${blocker.detail ?? blocker.category}`).join(' · ')
    };
  }
  if (result.outcome === 'draining') return { snapshot, outcome: 'queued', message: 'Switch queued until this profile reaches verified idle.' };
  if (result.outcome === 'already-active') return { snapshot, outcome: 'blocked', message: 'That profile is already active.' };
  // The ready callback stages the restart-bound handoff. The renderer may disappear immediately.
  return { snapshot, outcome: 'switched', message: 'Profile switch is ready; the app is reconnecting under the selected profile.' };
}

/**
 * Main-process-owned desktop notice seams.
 *
 * Ordinary terminal chat notices remain best effort. Browser sign-out is different: the
 * companion has already paused browser dispatch, and this owner durably latches one account
 * incident before it invokes the fixed DPAPI-backed Pushover script. Repeated MV3 reports and
 * app restarts therefore cannot create repeated emergencies. Only positive signed-in evidence
 * clears the latch; unknown DOM evidence does nothing.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Config, SignOutEmergencyIncident, SignOutEmergencyNotice } from '../shared/types.js';
import { getConfig, updateConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';

export type UserNoticeListener = (
  title: string,
  body: string,
  sessionId: string
) => boolean | void;

export type SignOutEmergencyListener = (notice: SignOutEmergencyNotice) => boolean | void;
export type SignOutEmergencyStopListener = (profileId: string) => void;

export type PushoverOwnerRequest =
  | {
      action: 'send';
      title: string;
      message: string;
      priority: 'emergency';
      sound: 'alien';
      retry: 30;
      expire: 1500;
    }
  | { action: 'cancel'; receipt: string };

type PushoverOwnerResult = { status: number; receipt?: string };
type BrowserAuthState = 'signed-in' | 'signed-out' | 'unknown';
type PositiveBrowserAuthState = Exclude<BrowserAuthState, 'unknown'>;
type SignOutEmergencyContext = { profileId: string; profileName: string };
type ConfigUpdater = (
  update: (latest: Config) => Config | Promise<Config>
) => Promise<Config>;

const PUSHOVER_RECEIPT = /^[A-Za-z0-9]{30}$/;
const OWNER_TIMEOUT_MS = 60_000;
const OWNER_MAX_BUFFER = 64 * 1024;

let notify: UserNoticeListener | null = null;
let notifySignOutEmergency: SignOutEmergencyListener | null = null;
let stopSignOutEmergency: SignOutEmergencyStopListener | null = null;
let readConfig: () => Config = getConfig;
let writeConfig: ConfigUpdater = updateConfig;
let clock: () => Date = () => new Date();
let runOwner: (request: PushoverOwnerRequest) => Promise<PushoverOwnerResult> = runPushoverOwner;
const pendingOwnerTasks = new Set<Promise<void>>();
let latestPositiveAuthState: PositiveBrowserAuthState | null = null;
let authObservationGeneration = 0;
let pendingSignedOutTransitions = 0;

/** Registered once by the Electron main process; tests may replace it with a recorder. */
export function setUserNoticeNotifier(listener: UserNoticeListener | null): void {
  notify = listener;
}

/** Registered once by main; the renderer never receives subprocess or credential authority. */
export function setSignOutEmergencyNotifier(listener: SignOutEmergencyListener | null): void {
  notifySignOutEmergency = listener;
}

/** Stops only the local bounded ring; it never emits a recovery notification. */
export function setSignOutEmergencyStopNotifier(listener: SignOutEmergencyStopListener | null): void {
  stopSignOutEmergency = listener;
}

/** Best-effort report of a chat incident whose existing owner has already stopped retrying. */
export function noticeChatStopped(title: string, body: string, sessionId: string): void {
  try {
    notify?.(title, body, sessionId);
  } catch {
    // A refused native notification cannot change the already-durable recovery verdict.
  }
}

function ownerExecutable(options: {
  programFiles?: string;
  systemRoot?: string;
  exists?: (candidate: string) => boolean;
} = {}): string {
  const programFiles = options.programFiles ??
    process.env.ProgramW6432 ?? process.env.ProgramFiles ?? 'C:\\Program Files';
  const systemRoot = options.systemRoot ??
    process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const fileExists = options.exists ?? existsSync;
  const candidates = [
    path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ];
  const executable = candidates.find(candidate => fileExists(candidate));
  if (!executable) {
    throw new Error(`no supported fixed PowerShell owner was found (${candidates.join(' or ')})`);
  }
  return executable;
}

/** Pure/real resolver seam for tests; production never accepts a renderer or PATH-selected owner. */
export function resolvePushoverOwnerExecutableForTests(options: {
  programFiles?: string;
  systemRoot?: string;
  exists?: (candidate: string) => boolean;
} = {}): string {
  return ownerExecutable(options);
}

function ownerScript(): string {
  return path.join(homedir(), '.codex', 'skills', 'pushover-alerts', 'scripts', 'pushover.ps1');
}

function ownerArgs(request: PushoverOwnerRequest): string[] {
  const common = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ownerScript()];
  if (request.action === 'cancel') return [...common, 'cancel', '-Receipt', request.receipt];
  return [
    ...common,
    'send',
    '-Title', request.title,
    '-Message', request.message,
    '-Priority', request.priority,
    '-Sound', request.sound,
    '-Retry', String(request.retry),
    '-Expire', String(request.expire)
  ];
}

/** Fixed executable + fixed owner script; no renderer-controlled command or credential argument. */
function parsePushoverOwnerOutput(
  stdout: string,
  request: PushoverOwnerRequest
): PushoverOwnerResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout.trim());
  } catch {
    throw new Error('Pushover owner returned invalid JSON');
  }
  if (!decoded || typeof decoded !== 'object' ||
      (decoded as { status?: unknown }).status !== 1 ||
      (decoded as { action?: unknown }).action !== request.action) {
    throw new Error('Pushover owner did not return status 1');
  }
  const receipt = (decoded as { receipt?: unknown }).receipt;
  if (request.action === 'send' && (typeof receipt !== 'string' || !PUSHOVER_RECEIPT.test(receipt))) {
    throw new Error('Pushover emergency did not return a valid receipt');
  }
  return { status: 1, ...(typeof receipt === 'string' ? { receipt } : {}) };
}

/** Strict parser seam for unit tests; it has no process, credential, network, or audio authority. */
export function parsePushoverOwnerOutputForTests(
  stdout: string,
  request: PushoverOwnerRequest
): PushoverOwnerResult {
  return parsePushoverOwnerOutput(stdout, request);
}

/** Fixed executable + fixed owner script; no renderer-controlled command or credential argument. */
async function runPushoverOwner(request: PushoverOwnerRequest): Promise<PushoverOwnerResult> {
  if (process.platform !== 'win32') throw new Error('the DPAPI Pushover owner is Windows-only');
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(ownerExecutable(), ownerArgs(request), {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: OWNER_TIMEOUT_MS,
      maxBuffer: OWNER_MAX_BUFFER
    }, (error, output) => {
      if (error) reject(new Error(`Pushover owner exited unsuccessfully (${error.code ?? 'unknown'})`));
      else resolve(output);
    });
  });
  return parsePushoverOwnerOutput(stdout, request);
}

function safeProfileName(value: string): string {
  const compact = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (compact || 'this account').slice(0, 80);
}

function withoutIncident(config: Config): Config {
  if (!config.noticeState?.signOutEmergency) return config;
  const { signOutEmergency: _incident, ...rest } = config.noticeState;
  return { ...config, noticeState: rest };
}

function withIncident(config: Config, incident: SignOutEmergencyIncident): Config {
  return { ...config, noticeState: { ...config.noticeState, signOutEmergency: incident } };
}

function isNighttime(date: Date): boolean {
  const hour = date.getHours();
  return hour >= 22 || hour < 8;
}

function trackOwnerTask(task: Promise<void>): void {
  pendingOwnerTasks.add(task);
  void task.then(
    () => pendingOwnerTasks.delete(task),
    () => pendingOwnerTasks.delete(task)
  );
}

async function cancelEmergencyReceipt(receipt: string, reason: string): Promise<void> {
  try {
    const result = await runOwner({ action: 'cancel', receipt });
    if (result.status !== 1) throw new Error('Pushover owner did not return status 1');
    logInfo(`sign-out emergency: receipt cancelled after ${reason}`);
  } catch (error) {
    logWarn(`sign-out emergency: receipt cancellation failed after ${reason}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function deliverSignOutEmergency(
  incident: SignOutEmergencyIncident,
  title: string,
  message: string
): Promise<void> {
  let receipt: string;
  try {
    const result = await runOwner({
      action: 'send',
      title,
      message,
      priority: 'emergency',
      sound: 'alien',
      retry: 30,
      expire: 1500
    });
    if (result.status !== 1 || typeof result.receipt !== 'string' || !PUSHOVER_RECEIPT.test(result.receipt)) {
      throw new Error('Pushover emergency did not return status 1 and a valid receipt');
    }
    receipt = result.receipt;
  } catch (error) {
    // The durable latch remains. Polling/reconnect must not retry an ambiguous external side
    // effect, and alert delivery failure never changes the browser's independent Send fence.
    logWarn(`sign-out emergency: Pushover delivery failed; browser dispatch remains paused: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  let committed: Config | null = null;
  try {
    committed = await writeConfig(config => {
      const current = config.noticeState?.signOutEmergency;
      if (!current || current.id !== incident.id || current.cancelRequested ||
          config.ui.signOutEmergencyAlerts !== true) return config;
      return withIncident(config, { ...current, receipt });
    });
  } catch (error) {
    logWarn(`sign-out emergency: receipt could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
  }
  const durableIncident = committed?.noticeState?.signOutEmergency;
  const retained = committed?.ui.signOutEmergencyAlerts === true &&
    durableIncident?.id === incident.id &&
    durableIncident.cancelRequested !== true &&
    durableIncident.receipt === receipt;
  if (!retained) {
    await cancelEmergencyReceipt(receipt, 'incident recovery or alert disable');
    return;
  }
  logInfo('sign-out emergency: Pushover accepted status=1 with a durable emergency receipt');
}

async function retireSignOutEmergencyIncidentForDisable(
  forceCommittedOff: boolean,
  expectedIncidentId?: string
): Promise<void> {
  const snapshot = readConfig();
  const latched = snapshot.noticeState?.signOutEmergency;
  if ((!forceCommittedOff && snapshot.ui.signOutEmergencyAlerts === true) || !latched || latched.cancelRequested) return;
  if (expectedIncidentId !== undefined && latched.id !== expectedIncidentId) return;
  let receipt: string | null = null;
  let profileId: string | null = null;
  await writeConfig(config => {
    const existing = config.noticeState?.signOutEmergency;
    if ((!forceCommittedOff && config.ui.signOutEmergencyAlerts === true) || !existing || existing.cancelRequested) return config;
    if (expectedIncidentId !== undefined && existing.id !== expectedIncidentId) return config;
    receipt = existing.receipt ?? null;
    profileId = existing.profileId;
    const { receipt: _claimedReceipt, ...claimed } = existing;
    return withIncident(config, { ...claimed, cancelRequested: true });
  });
  if (!profileId) return;
  stopSignOutEmergency?.(profileId);
  if (receipt) trackOwnerTask(cancelEmergencyReceipt(receipt, 'alert disable'));
}

/** Current Off retires transport/ring custody even when browser auth evidence is unknown. */
export async function retireDisabledSignOutEmergencyIncident(): Promise<void> {
  await retireSignOutEmergencyIncidentForDisable(false);
}

/** A committed explicit Off retains retirement authority even if a later On overtakes its effect. */
export async function retireSignOutEmergencyIncidentAfterExplicitDisable(
  incidentId: string | null
): Promise<void> {
  if (incidentId === null) return;
  await retireSignOutEmergencyIncidentForDisable(true, incidentId);
}

async function observeSignedOut(
  context: SignOutEmergencyContext,
  observationGeneration: number
): Promise<void> {
  const profileName = safeProfileName(context.profileName);
  const snapshot = readConfig();
  const latched = snapshot.noticeState?.signOutEmergency;
  if (snapshot.ui.signOutEmergencyAlerts === true && latched?.profileId === context.profileId) return;
  if (snapshot.ui.signOutEmergencyAlerts !== true) {
    await retireDisabledSignOutEmergencyIncident();
    return;
  }
  let started: SignOutEmergencyIncident | null = null;
  let staleReceipt: string | null = null;
  await writeConfig(config => {
    const existing = config.noticeState?.signOutEmergency;
    if (config.ui.signOutEmergencyAlerts !== true) return config;
    if (existing?.profileId === context.profileId) return config;
    staleReceipt = existing?.receipt ?? null;
    started = {
      id: randomUUID(),
      profileId: context.profileId,
      observedAt: clock().getTime()
    };
    return withIncident(config, started);
  });

  if (staleReceipt) trackOwnerTask(cancelEmergencyReceipt(staleReceipt, 'account-owner replacement'));
  if (!started) {
    if (readConfig().ui.signOutEmergencyAlerts !== true) {
      await retireDisabledSignOutEmergencyIncident();
    }
    return;
  }
  // A later positive sign-in may have queued behind the precommit while this call awaited disk.
  // Keep the durable latch for that signed-in mutation to retire, but never emit stale effects.
  if (latestPositiveAuthState !== 'signed-out' || authObservationGeneration !== observationGeneration) return;

  const title = `ChatGPT signed out — ${profileName}`;
  const body = `Browser dispatch is paused for ${profileName}. Sign back in to resume; queued work was not sent.`;
  const notice: SignOutEmergencyNotice = {
    profileId: context.profileId,
    profileName,
    title,
    body,
    ringComputer: isNighttime(clock())
  };
  try {
    notifySignOutEmergency?.(notice);
  } catch (error) {
    logWarn(`sign-out emergency: native notice failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  logWarn(`sign-out emergency: positive signed-out state for ${profileName}; browser dispatch is paused`);
  trackOwnerTask(deliverSignOutEmergency(started, title, body));
}

async function observeSignedIn(
  context: SignOutEmergencyContext,
  observationGeneration: number,
  forceMutation: boolean
): Promise<void> {
  if (!forceMutation && !readConfig().noticeState?.signOutEmergency) return;
  let receipt: string | null = null;
  let incidentProfileId: string | null = null;
  let localRingNeedsStop = false;
  let cleared = false;
  await writeConfig(config => {
    const existing = config.noticeState?.signOutEmergency;
    if (!existing) return config;
    if (existing.profileId !== context.profileId) {
      logWarn(`sign-out emergency: clearing stale incident owner ${existing.profileId} after positive sign-in for ${context.profileId}`);
    }
    receipt = existing.receipt ?? null;
    incidentProfileId = existing.profileId;
    localRingNeedsStop = existing.cancelRequested !== true;
    cleared = true;
    return withoutIncident(config);
  });
  if (!cleared) return;
  if (localRingNeedsStop && latestPositiveAuthState === 'signed-in' && authObservationGeneration === observationGeneration) {
    stopSignOutEmergency?.(incidentProfileId ?? context.profileId);
  }
  if (receipt) trackOwnerTask(cancelEmergencyReceipt(receipt, 'positive signed-in recovery'));
  logInfo('sign-out emergency: positive signed-in state ended the durable incident');
}

/**
 * Observes only provider-positive auth evidence. It never authorizes Send; Bridge owns that gate.
 * Failures are logged and swallowed so an alert transport/config error cannot alter auth policy.
 */
export async function observeBrowserAuthenticationIncident(
  authState: BrowserAuthState,
  context: SignOutEmergencyContext
): Promise<void> {
  if (authState === 'unknown') return;
  if (latestPositiveAuthState !== authState) {
    latestPositiveAuthState = authState;
    authObservationGeneration += 1;
  }
  const observationGeneration = authObservationGeneration;
  try {
    if (authState === 'signed-out') {
      pendingSignedOutTransitions += 1;
      try {
        await observeSignedOut(context, observationGeneration);
      } finally {
        pendingSignedOutTransitions -= 1;
      }
    } else {
      await observeSignedIn(context, observationGeneration, pendingSignedOutTransitions > 0);
    }
  } catch (error) {
    logWarn(`sign-out emergency: durable incident transition failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Test-only dependency seam; production keeps the fixed owner/config implementations above. */
export function configureSignOutEmergencyForTests(overrides: {
  readConfig?: () => Config;
  writeConfig?: ConfigUpdater;
  clock?: () => Date;
  runOwner?: (request: PushoverOwnerRequest) => Promise<PushoverOwnerResult>;
}): void {
  readConfig = overrides.readConfig ?? getConfig;
  writeConfig = overrides.writeConfig ?? updateConfig;
  clock = overrides.clock ?? (() => new Date());
  runOwner = overrides.runOwner ?? runPushoverOwner;
}

/** Waits only injected owner promises; it never sends or retries anything itself. */
export async function flushSignOutEmergencyForTests(): Promise<void> {
  await Promise.allSettled([...pendingOwnerTasks]);
}

export function resetSignOutEmergencyForTests(): void {
  readConfig = getConfig;
  writeConfig = updateConfig;
  clock = () => new Date();
  runOwner = runPushoverOwner;
  notifySignOutEmergency = null;
  stopSignOutEmergency = null;
  latestPositiveAuthState = null;
  authObservationGeneration = 0;
  pendingSignedOutTransitions = 0;
  pendingOwnerTasks.clear();
}

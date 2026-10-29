import { REASONING_EFFORTS, type ReasoningEffort } from '../shared/session.js';
import type { CancelDrainResult, ProfileLifecycleStatus } from './profile-lifecycle.js';

/** Native shell title for one account process. Windows taskbar hover must identify its owner. */
export function accountWindowTitle(profile: {
  id: string;
  displayName: string;
  accountLabel: string;
}): string {
  const account = profile.accountLabel.trim() || profile.displayName.trim() || profile.id;
  return `${account} · Chat On Steroids`;
}

/** Explicit local settings command, never inferred from startup or provider availability. */
export function helperReasoningSettingsRequest(argv: readonly string[]): { profileId: string; reasoning: ReasoningEffort; model?: string; retireChats?: boolean } | null {
  const values = (name: string) => argv.filter(arg => arg === name || arg.startsWith(`${name}=`))
    .map(arg => arg === name ? '' : arg.slice(name.length + 1));
  const efforts = values('--set-helper-reasoning');
  const profiles = values('--helper-settings-profile');
  const models = values('--set-chat-default-model');
  const retireChats = argv.includes('--retire-recorded-chats');
  if (!efforts.length && !profiles.length && !models.length && !retireChats) return null;
  if (efforts.length !== 1 || profiles.length !== 1 ||
      models.length > 1 || (models.length === 1 && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(models[0]!)) ||
      !REASONING_EFFORTS.includes(efforts[0] as ReasoningEffort) ||
      !/^[a-z][a-z0-9-]{0,99}$/.test(profiles[0]!) || argv.includes('--updated')) {
    throw new Error('Helper settings require one --set-helper-reasoning=<effort> and exact --helper-settings-profile=<profile-id> on an ordinary launch');
  }
  return { profileId: profiles[0]!, reasoning: efforts[0] as ReasoningEffort, ...(models.length ? { model: models[0]! } : {}), ...(retireChats ? { retireChats: true } : {}) };
}

/** Exact local preference control for one routed account process. */
export function signOutEmergencyAlertSettingRequest(argv: readonly string[]): boolean | null {
  const enables = argv.filter(argument => argument === '--enable-signout-emergency-alerts').length;
  const disables = argv.filter(argument => argument === '--disable-signout-emergency-alerts').length;
  if (enables === 0 && disables === 0) return null;
  if (enables > 1 || disables > 1 || (enables > 0 && disables > 0) || argv.includes('--updated')) {
    throw new Error('Sign-out emergency alerts require exactly one enable or disable flag on an ordinary launch');
  }
  return enables === 1;
}

/** Minimal app-event shape kept separate so macOS activation behavior is unit-testable. */
export interface ActivateEventSource {
  on(event: 'activate', listener: () => void): unknown;
}

/** Only the process that owns Electron's single-instance lock owns app runtime state/teardown. */
export function ownsAppRuntime(hasSingleInstanceLock: boolean): boolean {
  return hasSingleInstanceLock;
}

/**
 * Whether this process is allowed to touch the shared userData bootstrap at all.
 *
 * A losing single-instance process still evaluates this module and its `whenReady()` callback
 * can race `app.quit()`. Likewise the primary can receive an OS/application quit before ready.
 * Both are terminal: config/secrets/session/durable initialization belongs only to the live lock
 * owner, never to a process already leaving.
 */
export function shouldBeginAppBootstrap(hasSingleInstanceLock: boolean, quitting: boolean): boolean {
  return ownsAppRuntime(hasSingleInstanceLock) && !quitting;
}

/**
 * `second-instance` is only guaranteed to happen after Electron's `ready` event. Our own startup
 * continues well past that while config/durable state is restored and, critically, before the
 * renderer CSP/permission handlers and IPC surface are installed. Keep an early re-launch from
 * constructing a BrowserWindow across that gap. The normal startup path opens the initial window
 * once the gate is enabled, so dropping an earlier focus request loses nothing; later requests
 * focus/recreate the window immediately.
 */
export function createWindowActivationGate(showWindow: () => void): {
  request: () => void;
  enable: () => void;
  disable: () => void;
  isDisabled: () => boolean;
} {
  let enabled = false;
  // Shutdown is a terminal lifetime boundary, not a temporary pause. A startup continuation
  // can resume after `before-quit` because the main bootstrap contains several awaits; letting
  // that stale continuation call enable() again would reopen native activation during teardown.
  let disabled = false;
  return {
    request: () => {
      if (enabled && !disabled) showWindow();
    },
    enable: () => {
      if (!disabled) enabled = true;
    },
    disable: () => {
      disabled = true;
      enabled = false;
    },
    isDisabled: () => disabled
  };
}

const PROCESS_FAILURE_REASONS = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom',
  'launch-failed', 'integrity-failure', 'memory-eviction'] as const;
export type NativeProcessFailureReason = typeof PROCESS_FAILURE_REASONS[number] | 'unknown';
export interface NativeProcessFailureDetails { reason?: unknown; exitCode?: unknown; type?: unknown }
export interface RendererRecoveryResult {
  outcome: 'ignored' | 'deferred' | 'reload_requested' | 'attention' | 'superseded';
  reason: NativeProcessFailureReason;
  exitCode: number | null;
  automaticReloadUsed: boolean;
  /** One native fallback notification per process, never a dialog storm. */
  notify: boolean;
}

function processFailure(details: NativeProcessFailureDetails): Pick<RendererRecoveryResult, 'reason' | 'exitCode'> {
  const reason = PROCESS_FAILURE_REASONS.find(value => details.reason === value) ?? 'unknown';
  const exitCode = typeof details.exitCode === 'number' && Number.isInteger(details.exitCode) &&
    details.exitCode >= -0x80000000 && details.exitCode <= 0xffffffff ? details.exitCode : null;
  return { reason, exitCode };
}

/**
 * Process-lifetime UI recovery budget. Recreate this only on a real Main restart,
 * never for each BrowserWindow or successful load. Reloading the view retains Main's
 * queues and receipts; it does not acknowledge a Send, resume automation or retry a tool.
 * `reload_requested` describes dispatch only, not a loaded renderer or recovered task.
 */
export function createRendererRecoveryGate(): {
  snapshot: () => RendererRecoveryResult | null;
  recover: (details: NativeProcessFailureDetails, controls: {
    isCurrent: () => boolean;
    isStopping: () => boolean;
    reload: () => void | Promise<void>;
  }) => Promise<RendererRecoveryResult>;
} {
  let automaticReloadUsed = false;
  let notified = false;
  let generation = 0;
  let latest: RendererRecoveryResult | null = null;
  return {
    snapshot: () => latest ? { ...latest } : null,
    async recover(details, controls) {
      const failure = processFailure(details);
      const current = (): boolean => { try { return controls.isCurrent() === true; } catch { return false; } };
      const stopping = (): boolean => { try { return controls.isStopping() !== false; } catch { return true; } };
      const result = (outcome: RendererRecoveryResult['outcome'], notify = false): RendererRecoveryResult =>
        ({ outcome, ...failure, automaticReloadUsed, notify });
      if (!current() || failure.reason === 'clean-exit') return result('ignored');
      const epoch = ++generation;
      const publish = (outcome: RendererRecoveryResult['outcome']): RendererRecoveryResult => {
        const notify = outcome === 'attention' && !notified;
        if (notify) notified = true;
        latest = result(outcome, notify);
        return { ...latest };
      };
      if (stopping()) return publish('deferred');
      if (automaticReloadUsed) return publish('attention');
      // Spend before invoking external code: a throw or another fault cannot buy a second reload.
      automaticReloadUsed = true;
      latest = result('reload_requested');
      let failed = false;
      try { await controls.reload(); } catch { failed = true; }
      // A later fault owns its own result. Never replace it with an older asynchronous success.
      if (epoch !== generation) return result('superseded');
      if (!current()) return publish('superseded');
      if (stopping()) return publish('deferred');
      return publish(failed ? 'attention' : 'reload_requested');
    }
  };
}

/** Auxiliary Chromium failure diagnostics grant no authority to restart app/tool work. */
export function childProcessFailureDiagnostic(details: NativeProcessFailureDetails): {
  processType: 'gpu' | 'utility' | 'renderer' | 'other';
  reason: NativeProcessFailureReason;
  exitCode: number | null;
  action: 'inspect';
} {
  const processType = details.type === 'GPU' ? 'gpu' : details.type === 'Utility' ? 'utility'
    : details.type === 'Renderer' ? 'renderer' : 'other';
  return { processType, ...processFailure(details), action: 'inspect' };
}

/**
 * Closing the last ordinary window is not an application quit on macOS. The app stays in the
 * Dock/menu bar until the user explicitly quits (Cmd+Q / application menu / tray menu), and a
 * later `activate` recreates the window. Windows/Linux retain the existing preference semantics:
 * when close-to-tray is off, closing the last window exits the app.
 */
export function shouldQuitOnWindowAllClosed(
  platform: NodeJS.Platform,
  minimizeToTray: boolean
): boolean {
  return platform !== 'darwin' && !minimizeToTray;
}

/**
 * macOS users return to a hidden app through the Dock, which Electron reports as `activate`.
 * Windows/Linux use the tray/second-instance paths and should not gain a synthetic handler.
 */
export function registerNativeWindowActivation(
  source: ActivateEventSource,
  showWindow: () => void,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'darwin') source.on('activate', showWindow);
}

/** Login launch is distinct from tunnel auto-connect and ordinary app activation. */
export function isBackgroundLaunch(argv: readonly string[]): boolean {
  return argv.includes('--background');
}

const SAFE_CLOSE_FOR_UPDATE_ARG = '--safe-close-for-update=';
const SAFE_CLOSE_FOR_UPDATE_PID_ARG = '--safe-close-for-update-pid=';
const SAFE_CLOSE_FOR_UPDATE_GENERATION_ARG = '--safe-close-for-update-generation=';
const SAFE_CLOSE_FOR_UPDATE_STATUS_ARG = '--safe-close-for-update-status=';
const SAFE_CLOSE_FOR_UPDATE_CANCEL_ARG = '--safe-close-for-update-cancel=';
const SAFE_CLOSE_FOR_UPDATE_TRANSITION_ARG = '--safe-close-for-update-transition=';
const SAFE_CLOSE_PROFILE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
type SafeCloseAction = 'shutdown' | 'status' | 'cancel';

function safeCloseOptions(argv: readonly string[]): { action: SafeCloseAction; transitionId?: string } {
  const known = [SAFE_CLOSE_FOR_UPDATE_ARG, SAFE_CLOSE_FOR_UPDATE_PID_ARG, SAFE_CLOSE_FOR_UPDATE_GENERATION_ARG,
    SAFE_CLOSE_FOR_UPDATE_STATUS_ARG, SAFE_CLOSE_FOR_UPDATE_CANCEL_ARG, SAFE_CLOSE_FOR_UPDATE_TRANSITION_ARG];
  if (argv.some(argument => argument.startsWith('--safe-close-for-update-') &&
      !known.some(prefix => argument.startsWith(prefix)))) throw new Error('Unknown safe-close lifecycle option');
  const action = argv.some(argument => argument.startsWith(SAFE_CLOSE_FOR_UPDATE_CANCEL_ARG)) ? 'cancel'
    : argv.some(argument => argument.startsWith(SAFE_CLOSE_FOR_UPDATE_STATUS_ARG)) ? 'status' : 'shutdown';
  const transitions = argv.filter(argument => argument.startsWith(SAFE_CLOSE_FOR_UPDATE_TRANSITION_ARG));
  const transitionId = transitions[0]?.slice(SAFE_CLOSE_FOR_UPDATE_TRANSITION_ARG.length);
  if (action === 'cancel' ? transitions.length !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(transitionId ?? '')
    : transitions.length !== 0) throw new Error('Cancel Drain requires exactly one bounded observed transition id; other actions cannot carry it');
  return { action, ...(transitionId ? { transitionId } : {}) };
}

/** Whether this launch is attempting the maintenance-only safe-close control, valid or not. */
export function safeCloseForUpdateAttempted(argv: readonly string[]): boolean {
  return argv.some(argument =>
    argument === '--safe-close-for-update' ||
    argument.startsWith(SAFE_CLOSE_FOR_UPDATE_ARG) ||
    argument === '--safe-close-for-update-pid' ||
    argument.startsWith(SAFE_CLOSE_FOR_UPDATE_PID_ARG) ||
    argument.startsWith('--safe-close-for-update-'));
}

/** Strict exact-profile parser for the local second-instance maintenance command. */
export function safeCloseForUpdateProfileId(argv: readonly string[]): string | null {
  const requests = argv.filter(argument =>
    argument === '--safe-close-for-update' || argument.startsWith(SAFE_CLOSE_FOR_UPDATE_ARG) ||
    argument === '--safe-close-for-update-status' || argument.startsWith(SAFE_CLOSE_FOR_UPDATE_STATUS_ARG) ||
    argument === '--safe-close-for-update-cancel' || argument.startsWith(SAFE_CLOSE_FOR_UPDATE_CANCEL_ARG));
  if (requests.length === 0) return null;
  if (requests.length !== 1) {
    throw new Error('--safe-close-for-update accepts exactly one active profile id per launch');
  }
  const request = requests[0]!;
  const profileId = request === '--safe-close-for-update'
    ? ''
    : request.slice(request.indexOf('=') + 1);
  if (!SAFE_CLOSE_PROFILE_ID.test(profileId)) {
    throw new Error('--safe-close-for-update requires the exact active profile id (1-64 lowercase letters, digits, dots, underscores, or hyphens)');
  }
  return profileId;
}

/** Exact running process expected to receive the second-instance maintenance request. */
export function safeCloseForUpdateExpectedPid(argv: readonly string[]): number {
  const requests = argv.filter(argument =>
    argument === '--safe-close-for-update-pid' || argument.startsWith(SAFE_CLOSE_FOR_UPDATE_PID_ARG));
  if (requests.length !== 1) {
    throw new Error('--safe-close-for-update requires exactly one expected running process id');
  }
  const request = requests[0]!;
  const raw = request === '--safe-close-for-update-pid'
    ? ''
    : request.slice(SAFE_CLOSE_FOR_UPDATE_PID_ARG.length);
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) {
    throw new Error('--safe-close-for-update-pid requires a positive decimal Windows process id');
  }
  const expectedPid = Number(raw);
  if (!Number.isSafeInteger(expectedPid) || expectedPid > 0xffff_ffff) {
    throw new Error('--safe-close-for-update-pid is outside the Windows process-id range');
  }
  return expectedPid;
}

/** Exact creation-time generation of the running process expected to receive the request. */
export function safeCloseForUpdateExpectedGeneration(argv: readonly string[]): number {
  const requests = argv.filter(argument =>
    argument === '--safe-close-for-update-generation' ||
    argument.startsWith(SAFE_CLOSE_FOR_UPDATE_GENERATION_ARG));
  if (requests.length !== 1) {
    throw new Error('--safe-close-for-update requires exactly one expected process generation');
  }
  const request = requests[0]!;
  const raw = request === '--safe-close-for-update-generation'
    ? ''
    : request.slice(SAFE_CLOSE_FOR_UPDATE_GENERATION_ARG.length);
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) {
    throw new Error('--safe-close-for-update-generation requires positive decimal Unix epoch milliseconds');
  }
  const expectedGeneration = Number(raw);
  if (!Number.isSafeInteger(expectedGeneration)) {
    throw new Error('--safe-close-for-update-generation is outside the safe integer range');
  }
  return expectedGeneration;
}

function conflictsWithSafeClose(argument: string): boolean {
  return argument.startsWith('--cos-') && !argument.startsWith('--cos-instance-runtime=') ||
    argument === '--updated' || argument.startsWith('--defer-companion-reload') ||
    argument.startsWith('--reload-companion') || argument.startsWith('--discard-unexportable-companion-buffers') ||
    argument.startsWith('--set-helper-') || argument.startsWith('--helper-settings-') ||
    argument.startsWith('--set-chat-default-') || argument === '--retire-recorded-chats' ||
    argument.startsWith('--cos-create-') ||
    argument.startsWith('--cos-profile-') ||
    argument.startsWith('--cos-set-profile-') ||
    argument === '--resume-automation' ||
    argument === '--pause-automation' ||
    argument === '--enable-signout-emergency-alerts' ||
    argument === '--disable-signout-emergency-alerts' ||
    argument === '--pause-session-automation' ||
    argument.startsWith('--pause-session-automation=') ||
    argument === '--cos-enqueue-input' ||
    argument.startsWith('--cos-enqueue-input=') ||
    argument === '--cos-cancel-queued-input' ||
    argument.startsWith('--cos-cancel-queued-input=') ||
    argument === '--cos-retry-queued-input' ||
    argument.startsWith('--cos-retry-queued-input=') ||
    argument === '--cos-retry-queued-input-receipt' ||
    argument.startsWith('--cos-retry-queued-input-receipt=');
}

/**
 * Electron otherwise replays the argv that launched this process. Operator commands belong to
 * one admission, not every later profile switch or update. Retain the executable-independent
 * Electron/development arguments and exact account runtime; persisted settings own the restart.
 */
export function relaunchArguments(argv: readonly string[]): string[] {
  return argv.slice(1).filter(argument =>
    !conflictsWithSafeClose(argument) && !argument.startsWith('--safe-close-for-update'));
}

function assertSafeCloseForUpdateExclusive(argv: readonly string[]): void {
  if (argv.some(conflictsWithSafeClose)) {
    throw new Error('--safe-close-for-update cannot share a launch with input, retry, pause, or resume controls');
  }
}

/**
 * Validates a safe-close launch which unexpectedly won the single-instance lock.
 *
 * There is no process left to close in this race, so the caller exits before config, stores,
 * bridge, browser, or renderer startup. Isolated accounts must still carry the selector that
 * chose their private Electron singleton; accepting a profile-* id on the canonical singleton
 * would hide a routing error behind an apparently successful no-op.
 */
export function coldSafeCloseForUpdateProfileId(
  argv: readonly string[],
  isolatedInstanceId: string | null
): string | null {
  const profileId = safeCloseForUpdateProfileId(argv);
  if (profileId === null) return null;
  // Syntax and exclusivity remain mandatory, but a launcher which won the singleton lock is a
  // different short-lived PID/generation by definition. The intended target is already absent,
  // so consume the request and exit without comparing either token to this cold helper process.
  safeCloseForUpdateExpectedPid(argv);
  safeCloseForUpdateExpectedGeneration(argv);
  assertSafeCloseForUpdateExclusive(argv);
  if (safeCloseOptions(argv).action !== 'shutdown') {
    throw new Error('Lifecycle status/cancel requires its already-running exact process; no runtime was started');
  }
  if (isolatedInstanceId !== null) {
    if (profileId !== isolatedInstanceId) {
      throw new Error('--safe-close-for-update must name the same profile as --cos-instance-runtime');
    }
  } else if (profileId.startsWith('profile-')) {
    throw new Error('An isolated --safe-close-for-update profile requires its matching --cos-instance-runtime selector');
  }
  return profileId;
}

type SafeCloseForUpdateResult = {
  outcome: string;
  status: { phase: string; blockerCount: number };
};

type SafeCloseLifecycleControls = {
  /** Snapshot only: polling a census can finalize a pending shutdown. */
  status(): ProfileLifecycleStatus;
  cancel(transitionId: string): Promise<CancelDrainResult>;
  companionStatus?(): unknown;
};

/**
 * Queues an exact-profile shutdown request until the restored lifecycle coordinator exists.
 *
 * The external process still has to reach this account's Electron single-instance lock (isolated
 * accounts therefore include their existing `--cos-instance-runtime=<id>` selector). This gate
 * then proves the independently supplied profile id against the running profile before invoking
 * the one existing lifecycle Drain/shutdown owner. It never focuses the window or starts work.
 */
export function createSafeCloseForUpdateGate(log: {
  info(message: string): void;
  warn(message: string): void;
  runningProcessId: number;
  runningProcessGeneration: number | null;
}): {
  accept(argv: readonly string[]): boolean;
  enable(profileId: string, requestShutdown: () => Promise<SafeCloseForUpdateResult>, controls?: SafeCloseLifecycleControls): Promise<void>;
} {
  type RequestIdentity = { profileId: string; expectedPid: number; expectedGeneration: number;
    action: SafeCloseAction; transitionId?: string };
  const pending: RequestIdentity[] = [];
  let activeProfileId: string | null = null;
  let requestShutdown: (() => Promise<SafeCloseForUpdateResult>) | null = null;
  let inFlightRequest: RequestIdentity | null = null;
  let pumping: Promise<void> | null = null;
  let controls: SafeCloseLifecycleControls | undefined;
  const companionSnapshot = () => {
    let raw: unknown;
    try { raw = controls?.companionStatus?.(); } catch { /* A diagnostic failure must not suppress lifecycle status or expose its exception. */ }
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const fingerprint = (field: unknown) => typeof field === 'string' && /^[a-f0-9]{64}$/.test(field) ? field : null;
    return {
      startupPublishedFingerprint: fingerprint(value.startupPublishedFingerprint),
      requestFingerprint: fingerprint(value.requestFingerprint),
      requestState: typeof value.requestState === 'string' && ['no-pending-owner', 'obsolete-owner',
        'dispatched-unconfirmed', 'deferred-for-process', 'checking-eligibility', 'awaiting-eligibility'].includes(value.requestState)
        ? value.requestState : 'unavailable',
      // The incumbent protocol has no executing-script attestation. Never promote a callback's
      // version, disk marker or launch bookkeeping into loaded-generation proof.
      executingGeneration: 'unverified'
    };
  };
  const sameRequest = (left: RequestIdentity | null, right: RequestIdentity) => left?.profileId === right.profileId &&
    left.expectedPid === right.expectedPid && left.expectedGeneration === right.expectedGeneration &&
    left.action === right.action && left.transitionId === right.transitionId;
  const assertCurrent = (request: RequestIdentity) => {
    if (request.profileId !== activeProfileId) throw new Error(`requested profile ${request.profileId} does not match running profile ${activeProfileId}`);
    if (request.expectedPid !== log.runningProcessId) throw new Error(`expected process ${request.expectedPid} does not match running process ${log.runningProcessId}`);
    if (!Number.isSafeInteger(log.runningProcessGeneration) || (log.runningProcessGeneration ?? 0) <= 0)
      throw new Error('running process generation is unavailable');
    if (request.expectedGeneration !== log.runningProcessGeneration)
      throw new Error(`expected process generation ${request.expectedGeneration} does not match running generation ${log.runningProcessGeneration}`);
  };
  const reportSnapshot = (request: RequestIdentity, status: ProfileLifecycleStatus) => {
    if (status.profileId !== request.profileId) throw new Error('lifecycle snapshot belongs to another profile');
    log.info(`safe close for update: lifecycle snapshot ${JSON.stringify({ profileId: request.profileId,
      pid: log.runningProcessId, generation: log.runningProcessGeneration, action: request.action,
      requestedTransitionId: request.transitionId ?? null,
      phase: status.phase, transitionId: status.transitionId,
      ...(controls?.companionStatus ? { companionActivation: companionSnapshot() } : {}),
      admission: { mode: status.admission.mode, owner: status.admission.owner, generation: status.admission.generation },
      blockerCount: status.blockerCount, blockers: status.blockers.slice(0, 24).map(row => ({
        category: /^[a-z][a-z0-9-]{0,63}$/.test(row.category) ? row.category : 'unknown',
        count: Math.max(0, Math.min(1_000_000, Number.isSafeInteger(row.count) ? row.count : 0)) })) })}`);
  };

  const pump = (): Promise<void> => {
    if (pumping) return pumping;
    if (!requestShutdown || !activeProfileId || pending.length === 0) return Promise.resolve();
    const shutdown = requestShutdown;
    const runningProfileId = activeProfileId;
    pumping = (async () => {
      while (pending.length > 0) {
        const request = pending.shift()!;
        const requestedProfileId = request.profileId;
        if (request.action !== 'shutdown') {
          inFlightRequest = request;
          try {
            assertCurrent(request);
            if (!controls) throw new Error('lifecycle status/cancel controls are unavailable');
            const status = request.action === 'status' ? controls.status() : (await controls.cancel(request.transitionId!)).status;
            reportSnapshot(request, status);
          } catch (error) { log.warn(`safe close for update ${request.action} refused: ${error instanceof Error ? error.message : String(error)}`); }
          finally { inFlightRequest = null; }
          continue;
        }
        if (requestedProfileId !== runningProfileId) {
          log.warn(`safe close for update refused: requested profile ${requestedProfileId} does not match running profile ${runningProfileId}`);
          continue;
        }
        if (request.expectedPid !== log.runningProcessId) {
          log.warn(`safe close for update refused: expected process ${request.expectedPid} does not match running process ${log.runningProcessId}`);
          continue;
        }
        if (!Number.isSafeInteger(log.runningProcessGeneration) || (log.runningProcessGeneration ?? 0) <= 0) {
          log.warn('safe close for update refused: running process generation is unavailable');
          continue;
        }
        if (request.expectedGeneration !== log.runningProcessGeneration) {
          log.warn(`safe close for update refused: expected process generation ${request.expectedGeneration} does not match running generation ${log.runningProcessGeneration}`);
          continue;
        }
        inFlightRequest = request;
        try {
          const result = await shutdown();
          log.info(`safe close for update: ${requestedProfileId} ${result.outcome} (${result.status.phase}; ${result.status.blockerCount} blocker(s))`);
        } catch (error) {
          log.warn(`safe close for update failed for ${requestedProfileId}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          inFlightRequest = null;
        }
      }
    })().finally(() => {
      pumping = null;
      if (requestShutdown && pending.length > 0) void pump();
    });
    return pumping;
  };

  return {
    accept(argv) {
      if (!safeCloseForUpdateAttempted(argv)) return false;
      try {
        const profileId = safeCloseForUpdateProfileId(argv);
        if (profileId === null) {
          throw new Error('--safe-close-for-update requires the exact active profile id');
        }
        const expectedPid = safeCloseForUpdateExpectedPid(argv);
        const expectedGeneration = safeCloseForUpdateExpectedGeneration(argv);
        assertSafeCloseForUpdateExclusive(argv);
        const request = { profileId, expectedPid, expectedGeneration, ...safeCloseOptions(argv) };
        const selectors = argv.filter(argument => argument.startsWith('--cos-instance-runtime='));
        if (request.action !== 'shutdown' && (selectors.length > 1 ||
            selectors.some(selector => selector !== `--cos-instance-runtime=${profileId}`) ||
            profileId.startsWith('profile-') && selectors.length !== 1)) {
          throw new Error('Lifecycle status/cancel requires its exact existing account runtime selector');
        }
        // Read-only status stays available even while an incumbent census/cancellation awaits.
        if (request.action === 'status' && activeProfileId && requestShutdown) {
          assertCurrent(request);
          if (!controls) throw new Error('lifecycle status/cancel controls are unavailable');
          reportSnapshot(request, controls.status());
          return true;
        }
        if (sameRequest(inFlightRequest, request) || pending.some(queued => sameRequest(queued, request))) {
          log.info(`safe close for update: coalesced request for ${profileId} process ${expectedPid} generation ${expectedGeneration}`);
        } else {
          if (pending.length >= 8) throw new Error('safe close for update request queue is full');
          pending.push(request);
          if (!requestShutdown) log.info(`safe close for update: queued ${profileId} until profile lifecycle restore completes`);
          void pump();
        }
      } catch (error) {
        log.warn(`safe close for update arguments rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
      return true;
    },
    async enable(profileId, shutdown, lifecycleControls) {
      if (!SAFE_CLOSE_PROFILE_ID.test(profileId)) throw new Error('Running profile id is invalid.');
      if (requestShutdown) throw new Error('Safe close for update lifecycle gate is already enabled.');
      activeProfileId = profileId;
      requestShutdown = shutdown;
      controls = lifecycleControls;
      await pump();
    }
  };
}

export function supportsLoginStartup(platform: NodeJS.Platform, packaged: boolean): boolean {
  return platform === 'win32' && packaged;
}

export function applyLoginStartup(
  app: { isPackaged: boolean; setLoginItemSettings(settings: { openAtLogin: boolean; path: string; args: string[] }): void },
  enabled: boolean,
  platform: NodeJS.Platform = process.platform,
  executable = process.execPath
): void {
  if (!supportsLoginStartup(platform, app.isPackaged)) return;
  app.setLoginItemSettings({ openAtLogin: enabled, path: executable, args: ['--background'] });
}

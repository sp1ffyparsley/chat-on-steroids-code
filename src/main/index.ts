import { requestSessionFinishGoal, setFinishNotifier } from './session/finish.js';
/**
 * Main process entry: window, tray, and the security posture for the renderer.
 */

import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { app, Notification, BrowserWindow, Menu, Tray, dialog, nativeImage, nativeTheme, powerSaveBlocker, screen, session, type Session, type WebContents } from 'electron';
import { createKeepAwake, installKeepAwake } from './keep-awake.js';
import {
  deferredProfileSwitchState,
  configureSharedAccountSettings,
  getActiveConnectorNames,
  getActiveInstanceRuntime,
  getActiveInstanceOwnerPaths,
  getConfig,
  initConfigPath,
  loadConfig,
  stageInstanceActivationForNextStart,
  updateConfig,
  writeDeferredProfileSwitchState
} from './config.js';
import { connect, disconnect, getStatus, onStatusChange, setConnectionLossNotifier, shutdownConnection } from './connection.js';
import {
  bindDiagnosticIncidentChatNow,
  bindDiagnosticIncidentWakeInputNow,
  claimDiagnosticIncidentWakeNow,
  diagnoseCoreToolSurfaceIncident,
  diagnosticIncidentSnapshot,
  diagnosticIncidentWakeClaimCurrent,
  diagnosticIncidentWakeOfferForClaim,
  noteExhaustedDiagnosticIncidentNow,
  retireMissingDiagnosticIncidentChatNow,
  resolveRecoveredDiagnosticIncidentNow,
  resolveDiagnosticIncidentNow,
  settleDiagnosticIncidentWakeNow,
  suppressDiagnosticIncidentsForSourceNow
} from './diagnostics.js';
import { registerIpc, resumeAutomationAfterExplicitRequest, setHelperReasoningAfterExplicitRequest, retireRecordedChatsAfterExplicitRequest } from './ipc.js';
import { getChatModels, restoreChatModels, startChatModelDiscovery } from './chat-models.js';
import { flushLogBeforeExit, initLogFile, logError, logEvent, logInfo, logWarn, setLogProfileContext, snapshotLogOnCrash } from './logger.js';
import { unifiedExecManager } from './codex/manager.js';
import { initSkills } from './skills.js';
import { pluginManager } from './plugins/manager.js';
import { applyAutomationPause, applyCoreConnectionDispatchState, armBrowserStartupRecovery, bridgeStatus, onBridgeChange, reconcileBrowserAuthEmergencyPolicy, setBrowserOpener, setBrowserWorkArea, setCoreConnectionRecoveryProvider, setCoreConnectionStateProvider, setCoreIncidentDiagnosticProvider, setDiagnosticIncidentProvider, setSessionsAutomationPaused, shutdownBridge, startBridge } from './bridge.js';
import { sessionActivityExpiresAt } from './bridge.js';
import { flushSessions, indexedSessions, initSessionStore, listDeletedSessions, pruneSessions } from './session/store.js';
import { reconcilePendingSessionDeletionBatch, reconcilePendingSessionRestore } from './session/deletion.js';
import { usageOverview } from './session/usage.js';
import {
  flushRecorder,
  onSessionChange,
  queueDeterministicAttributionRepair,
  setAgentBinder,
  setAgentConversationLookup
} from './session/recorder.js';
import {
  agentConversation,
  bindConversation,
  onRetiredWorkersPersist,
  onRetiredWorkersPersistNow,
  onSwarmPersist,
  onSwarmPersistNow,
  pauseSwarmForDisable,
  primeFleetIn,
  repairPrimeConversationAfterRecovery,
  restoreRetiredWorkers,
  restoreSwarm,
  snapshotRetiredWorkers,
  snapshotSwarm,
  type RetiredWorkersSnapshot,
  type SwarmSnapshot
} from './agents.js';
import { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { loadConnectorIdentity } from './connector-identity.js';
import { restoreRequestCorrelations } from './session/correlation.js';
import { restoreBlockedChats } from './session/blocked-chats.js';
import { stopComputerHelper } from './computer/index.js';
import {
  GOAL_OBJECTIVES_STATE,
  GOAL_REPLIES_STATE,
  GOAL_SWITCHES_STATE,
  restoreGoalObjectives,
  restoreGoalReplies,
  restoreGoalSwitches,
  pruneMissingSessionGoalRepliesNow,
  prunePermanentlyDeletedGoalSwitchesNow,
  type GoalObjectivesSnapshot,
  type GoalRepliesSnapshot,
  type GoalSwitchesSnapshot
} from './goal.js';
import {
  CONTINUATIONS_STATE,
  restoreContinuations,
  setContinuationRecoveryHooks,
  type ContinuationSnapshot
} from './session/continuation.js';
import { startSessionRetentionMaintenance } from './session/retention.js';
import { runShutdownSequence } from './shutdown.js';
import { applyStagedUpdate, markInstallOnQuit, startUpdateChecks } from './update.js';
import { UI_BASE_ZOOM, windowLayoutForWorkArea, titleBarOverlayForTheme } from './window-layout.js';
import { openInPreferredBrowser } from './browser.js';
import {
  accountWindowTitle,
  applyLoginStartup,
  coldSafeCloseForUpdateProfileId,
  createSafeCloseForUpdateGate,
  createRendererRecoveryGate,
  createWindowActivationGate,
  childProcessFailureDiagnostic,
  isBackgroundLaunch,
  helperReasoningSettingsRequest,
  signOutEmergencyAlertSettingRequest,
  ownsAppRuntime,
  registerNativeWindowActivation,
  safeCloseForUpdateAttempted,
  shouldBeginAppBootstrap,
  shouldQuitOnWindowAllClosed,
  type NativeProcessFailureDetails
} from './window-lifecycle.js';
import { trayGuidArgsForPlatform, trayImageSpec } from './tray-image.js';
import { browserWindowIconPath } from './window-icon.js';
import { editContextMenuTemplate } from './edit-context-menu.js';
import { configureSurfaceIdentity } from './mcp/surfaces.js';
import { companionMaterializedFingerprint, companionReloadUrl, extensionDir, usePrimaryStableExtensionRoot } from './extension-path.js';
import { bridgeExtensionOriginSecretSlot, getSecret, validateIsolatedInstanceSecrets } from './secrets.js';
import { ProfileLifecycleCoordinator } from './profile-lifecycle.js';
import { createManagedInstanceProfile, renameManagedInstanceProfile, setManagedInstanceBrowserProfile } from './instance-management.js';
import { profileWorkAdmission } from './work-admission.js';
import { activeProfileWorkCensus } from './profile-work-state.js';
import { assertCanonicalAccountRouting, developmentBridgePortOverride, developmentUserDataOverride, isolatedProcessSelection } from './instance-process.js';
import { parseInstanceRegistry } from '../shared/instance-profile.js';
import {
  operatorInputCancellationIds,
  operatorInputRequestIds,
  operatorInputRetryIds,
  operatorProfileCreationRequest,
  operatorProfileBrowserBindingRequest,
  operatorProfileRenameRequest,
  operatorProfileCreationAdditionalData,
  operatorProfileCreationSecondInstanceArgs,
  operatorSharedAccountSettingsRequest,
  operatorConnectionControlRequest,
  processOperatorConnectionControl,
  operatorSettingsControlRequest,
  processOperatorSettingsControl,
  operatorSessionInspectionRequest,
  processOperatorSessionInspection,
  processOperatorInputCancellations,
  processOperatorInputRequests,
  processOperatorInputRetries,
  processOperatorProfileCreation,
  processOperatorProfileBrowserBinding,
  processOperatorProfileRename
} from './operator-input.js';
import {
  operatorPluginRefreshRearmIds,
  pluginRefreshPublications,
  processOperatorPluginRefreshRearms
} from './plugin-refresh.js';
import { retireSignOutEmergencyIncidentAfterExplicitDisable, setSignOutEmergencyNotifier, setSignOutEmergencyStopNotifier, setUserNoticeNotifier } from './user-notice.js';
import { startQueuedWakeRetrySync, stopQueuedWakeRetrySync } from './session/start-input.js';

/** Durable state file holding the multi-agent run. Hashes only, never credentials. */
const SWARM_STATE = 'swarm';
const RETIRED_WORKERS_STATE = 'retired-workers';
const COMPANION_FINGERPRINT_STATE = 'companion-fingerprint';

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;
let runtimeStoresReady = false;
// This budget belongs to Main's lifetime, not a recreated window or successful page load.
const rendererRecovery = createRendererRecoveryGate();
let rendererPartition: string | null = null;
let rendererSessionOwner: Session | null = null;
let stopSessionRetention: (() => void) | null = null;
let stopKeepAwake: (() => void) | null = null;
let stopIpcLifecyclePolling: (() => void) | null = null;
const usageWarmup = new AbortController();
let operatorInputRuntimeReady = false;
let operatorProfileLifecycle: ProfileLifecycleCoordinator | null = null;
const pendingOperatorInputArgv: Array<readonly string[]> = [];
let operatorInputSerial: Promise<void> = Promise.resolve();

function acceptOperatorInputArgs(argv: readonly string[]): void {
  let requestIds: string[];
  let cancellationIds: string[];
  let retryIds: string[];
  let pluginRefreshRearmIds: string[];
  let profileCreation: ReturnType<typeof operatorProfileCreationRequest>;
  let profileBrowserBinding: ReturnType<typeof operatorProfileBrowserBindingRequest>;
  let profileRename: ReturnType<typeof operatorProfileRenameRequest>;
  let sharedSettings: ReturnType<typeof operatorSharedAccountSettingsRequest>;
  let connectionControl: ReturnType<typeof operatorConnectionControlRequest>;
  let settingsControl: ReturnType<typeof operatorSettingsControlRequest>;
  let sessionInspection: ReturnType<typeof operatorSessionInspectionRequest>;
  try {
    sessionInspection = operatorSessionInspectionRequest(argv);
    settingsControl = operatorSettingsControlRequest(argv);
    connectionControl = operatorConnectionControlRequest(argv);
    sharedSettings = operatorSharedAccountSettingsRequest(argv);
    profileCreation = operatorProfileCreationRequest(argv);
    profileBrowserBinding = operatorProfileBrowserBindingRequest(argv);
    profileRename = operatorProfileRenameRequest(argv);
    requestIds = operatorInputRequestIds(argv);
    cancellationIds = operatorInputCancellationIds(argv);
    retryIds = operatorInputRetryIds(argv);
    pluginRefreshRearmIds = operatorPluginRefreshRearmIds(argv);
  } catch (error) {
    logWarn(`operator input command refused: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (requestIds.length === 0 && cancellationIds.length === 0 && retryIds.length === 0 &&
      pluginRefreshRearmIds.length === 0 && !profileCreation && !profileBrowserBinding && !profileRename && !sharedSettings && !connectionControl && !settingsControl && !sessionInspection) return;
  if (!operatorInputRuntimeReady) { pendingOperatorInputArgv.push([...argv]); return; }
  operatorInputSerial = operatorInputSerial.catch(() => undefined).then(async () => {
    if (sessionInspection) {
      if (quitting || shutdownStarted) throw new Error('Session inspection is unavailable during shutdown.');
      const receipt = await processOperatorSessionInspection(argv, app.getPath('userData'));
      logInfo(`operator session inspection: ${receipt?.receipt} ${receipt?.state}`);
      return;
    }
    if (settingsControl) {
      if (quitting || shutdownStarted) throw new Error('Settings control is unavailable during shutdown.');
      const receipt = await processOperatorSettingsControl(argv, app.getPath('userData'));
      logInfo(`operator settings control: ${receipt?.receipt} ${receipt?.state}`);
      return;
    }
    if (connectionControl) {
      if (quitting || shutdownStarted) throw new Error('Connection control is unavailable during shutdown.');
      const receipt = await processOperatorConnectionControl(argv);
      logInfo(`operator connection control: ${receipt?.receipt} ${receipt?.state}`);
      return;
    }
    if (sharedSettings) {
      if (quitting || shutdownStarted) throw new Error('Shared account settings are unavailable during shutdown.');
      const receipt = await configureSharedAccountSettings(sharedSettings);
      logInfo(`operator shared account settings receipt: ${JSON.stringify(receipt)}`);
      return;
    }
    if (profileCreation || profileBrowserBinding || profileRename) {
      if (!operatorProfileLifecycle || quitting || shutdownStarted) throw new Error('Account setup is unavailable while this account is shutting down.');
      if (profileRename) {
        const profileId = await processOperatorProfileRename(argv, (id, nickname) =>
          renameManagedInstanceProfile(operatorProfileLifecycle!, id, nickname));
        logInfo(`operator account nickname: saved ${profileId}; connector and runtime identity retained`);
        return;
      }
      if (profileBrowserBinding) {
        const profileId = await processOperatorProfileBrowserBinding(argv, (id, directory) =>
          setManagedInstanceBrowserProfile(operatorProfileLifecycle!, id, directory));
        logInfo(`operator account browser binding: saved ${profileId}; no browser, tunnel, or message started`);
        return;
      }
      const profileId = await processOperatorProfileCreation(argv, (nickname, directory) =>
        createManagedInstanceProfile(operatorProfileLifecycle!, nickname, directory));
      logInfo(`operator account creation: registered ${profileId}; no browser, tunnel, or message started`);
      return;
    }
    const modes = [requestIds.length > 0, cancellationIds.length > 0, retryIds.length > 0,
      pluginRefreshRearmIds.length > 0]
      .filter(Boolean).length;
    if (modes > 1)
      throw new Error('enqueue, queued-input cancellation, queued-input browser retry, and Core refresh rearm controls cannot share one launch');
    const result = await processOperatorInputRequests(argv, app.getPath('userData'));
    if (result.requested > 0)
      logInfo(`operator input: accepted ${result.accepted}/${result.requested} request(s)`);
    const cancellations = await processOperatorInputCancellations(argv);
    if (cancellations.requested > 0)
      logInfo(`operator input: cancelled ${cancellations.cancelled}/${cancellations.requested} strictly queued request(s)`);
    const retries = await processOperatorInputRetries(argv);
    if (retries.requested > 0) {
      logInfo(`operator input: rearmed ${retries.rearmed}/${retries.requested} attention-fenced browser request(s)`);
      if (retries.refused.length > 0)
        logWarn(`operator input: refused ${retries.refused.length} stale or unsafe queued-input browser retry request(s): ${retries.refused.join(', ')}`);
    }
    if (pluginRefreshRearmIds.length > 0 &&
        !pluginRefreshPublications().some(publication => publication.surface === 'core')) {
      // A cold explicit launch can reach this dispatcher before ordinary auto-connect. Join the
      // existing Connection owner so Main can fence the request against this build's live schema;
      // never grant from durable bytes alone.
      await connect();
      const publicationDeadline = Date.now() + 15_000;
      while (!pluginRefreshPublications().some(publication => publication.surface === 'core') &&
          Date.now() < publicationDeadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    const pluginRefreshRearms = await processOperatorPluginRefreshRearms(argv);
    if (pluginRefreshRearms.requested > 0) {
      logInfo(`plugin refresh operator: rearmed ${pluginRefreshRearms.rearmed}/${pluginRefreshRearms.requested} exact Core refresh row(s)`);
      if (pluginRefreshRearms.refused.length > 0)
        logWarn(`plugin refresh operator: refused ${pluginRefreshRearms.refused.length} stale, current, non-manual, or mismatched row(s): ${pluginRefreshRearms.refused.join(', ')}`);
    }
  }).catch(error => logWarn(`operator input failed: ${error instanceof Error ? error.message : String(error)}`));
}

/**
 * An update restart must reconcile Chrome, not burst-open every durable chat.
 *
 * `--resume-automation` remains useful as an explicit ordinary launch command. Combining it
 * with `--updated` previously bypassed startup inventory recovery and reopened every saved chat
 * before the extension could report which tabs had survived, producing provider throttles and
 * bare chatgpt.com redirects. Updated launches therefore always take the inventory-first path.
 */
export function startupAutomationResumeRequested(argv: readonly string[]): boolean {
  return argv.includes('--resume-automation') && !argv.includes('--updated');
}

const PAUSE_SESSION_AUTOMATION_ARG = '--pause-session-automation=';
const STABLE_LOCAL_SESSION_ID = /^[0-9a-z-]{8,64}$/i;

export function startupAutomationPauseRequested(argv: readonly string[]): boolean {
  return argv.includes('--pause-automation');
}

/** Strict parser shared by cold-start and second-instance command delivery. */
export function startupSessionAutomationPauseIds(argv: readonly string[]): string[] {
  const values = argv
    .filter(argument => argument === '--pause-session-automation' || argument.startsWith(PAUSE_SESSION_AUTOMATION_ARG))
    .map(argument => argument === '--pause-session-automation' ? '' : argument.slice(PAUSE_SESSION_AUTOMATION_ARG.length));
  const invalid = values.find(value => !STABLE_LOCAL_SESSION_ID.test(value));
  if (invalid !== undefined) {
    throw new Error('--pause-session-automation requires a stable local session id (8-64 letters, digits, or hyphens)');
  }
  const unique = [...new Set(values)];
  if (unique.length > 200) throw new Error('--pause-session-automation accepts at most 200 unique session ids');
  return unique;
}

type ExplicitAutomationControl = {
  pauseAll: boolean;
  pauseSessionIds: string[];
  resumeAll: boolean;
  helperSettings: ReturnType<typeof helperReasoningSettingsRequest>;
  signOutEmergencyAlerts: boolean | null;
  companionReloadDeferral?: PendingCompanionReload;
  manualCompanionReload?: PendingCompanionReload;
  trigger: string;
};

function sameExplicitAutomationControl(left: ExplicitAutomationControl, right: ExplicitAutomationControl): boolean {
  return left.pauseAll === right.pauseAll && left.resumeAll === right.resumeAll &&
    left.companionReloadDeferral === right.companionReloadDeferral &&
    left.manualCompanionReload === right.manualCompanionReload &&
    left.signOutEmergencyAlerts === right.signOutEmergencyAlerts &&
    left.helperSettings?.profileId === right.helperSettings?.profileId &&
    left.helperSettings?.reasoning === right.helperSettings?.reasoning &&
    left.helperSettings?.model === right.helperSettings?.model &&
    left.helperSettings?.retireChats === right.helperSettings?.retireChats &&
    left.pauseSessionIds.length === right.pauseSessionIds.length &&
    left.pauseSessionIds.every((id, index) => id === right.pauseSessionIds[index]);
}

function explicitAutomationControlFromArgs(argv: readonly string[]): ExplicitAutomationControl | null {
  // Provisioning is exclusively a registry command. A refused mixed command must not fall
  // through this independent pause/resume/settings owner after the operator parser rejects it.
  if (operatorSessionInspectionRequest(argv) || operatorSettingsControlRequest(argv) || operatorConnectionControlRequest(argv) || operatorSharedAccountSettingsRequest(argv) || operatorProfileCreationRequest(argv) || operatorProfileBrowserBindingRequest(argv) || operatorProfileRenameRequest(argv)) return null;
  const pauseAll = startupAutomationPauseRequested(argv);
  let resumeAll = startupAutomationResumeRequested(argv);
  const pauseSessionIds = startupSessionAutomationPauseIds(argv);
  const helperSettings = helperReasoningSettingsRequest(argv);
  const signOutEmergencyAlerts = signOutEmergencyAlertSettingRequest(argv);
  if (!pauseAll && !resumeAll && pauseSessionIds.length === 0 && !helperSettings && signOutEmergencyAlerts === null) return null;
  if (pauseAll && resumeAll) {
    // A contradictory one-shot request must fail closed. A later, separate resume remains an
    // explicit boundary and will retain its arrival order in the serialized queue below.
    resumeAll = false;
    logWarn('automation control: --pause-automation overrides --resume-automation in the same launch');
  }
  const trigger = signOutEmergencyAlerts !== null
    ? `explicit --${signOutEmergencyAlerts ? 'enable' : 'disable'}-signout-emergency-alerts request`
    : helperSettings
    ? 'explicit helper reasoning settings request'
    : pauseAll
    ? 'explicit --pause-automation request'
    : pauseSessionIds.length > 0
      ? 'explicit --pause-session-automation request'
      : 'explicit --resume-automation request';
  return { pauseAll, pauseSessionIds, resumeAll, helperSettings, signOutEmergencyAlerts, trigger };
}

// A second process can reach the primary after Electron is ready but before restored automation
// state and the bridge command journal are ready. Preserve ordered control requests until that
// publication barrier succeeds. Adjacent duplicate launches coalesce, while pause then resume
// remain two distinct boundaries and can never race one another.
let explicitAutomationControlRuntimeReady = false;
let explicitAutomationSettingsRuntimeReady = false;
const pendingExplicitAutomationControls: ExplicitAutomationControl[] = [];
let explicitAutomationControlInFlight = false;
let startExplicitAutomationControlRuntime = () => {};

function explicitAutomationControlNeedsBridge(control: ExplicitAutomationControl): boolean {
  return control.pauseAll || control.resumeAll || control.pauseSessionIds.length > 0 || control.helperSettings?.retireChats === true || !!control.manualCompanionReload;
}

async function applyExplicitAutomationControl(control: ExplicitAutomationControl): Promise<void> {
  if (control.manualCompanionReload) {
    await reloadCompanionAfterExplicitRequest(control.manualCompanionReload);
    return;
  }
  const signOutEmergencyAlerts = control.signOutEmergencyAlerts;
  if (typeof signOutEmergencyAlerts === 'boolean') {
    let disabledIncidentId = getConfig().noticeState?.signOutEmergency?.id ?? null;
    if (!signOutEmergencyAlerts) {
      await updateConfig(config => {
        disabledIncidentId = config.noticeState?.signOutEmergency?.id ?? null;
        return config.ui.signOutEmergencyAlerts === false
          ? config
          : { ...config, ui: { ...config.ui, signOutEmergencyAlerts: false } };
      });
    } else if (getConfig().ui.signOutEmergencyAlerts !== true) {
      await updateConfig(config => ({
        ...config,
        ui: { ...config.ui, signOutEmergencyAlerts: true }
      }));
    }
    if (signOutEmergencyAlerts) await reconcileBrowserAuthEmergencyPolicy();
    else await retireSignOutEmergencyIncidentAfterExplicitDisable(disabledIncidentId);
    logInfo(`sign-out emergency alerts: ${signOutEmergencyAlerts ? 'enabled' : 'disabled'} for this account`);
  }
  if (control.helperSettings) {
    await setHelperReasoningAfterExplicitRequest(control.helperSettings.profileId, control.helperSettings.reasoning, control.helperSettings.model);
    if (control.helperSettings.retireChats) await retireRecordedChatsAfterExplicitRequest(control.helperSettings.profileId);
  }
  if (control.pauseAll) {
    if (getConfig().ui.automationPaused !== true) {
      await updateConfig(config => ({ ...config, ui: { ...config.ui, automationPaused: true } }));
    }
    // Reapply the live admission fence even when persistence was already paused. This makes an
    // explicit command authoritative after any interrupted startup without deleting queue debt.
    applyAutomationPause(true);
    logInfo('automation pause: global app-authored work is durably paused');
  }
  if (control.pauseSessionIds.length > 0) {
    const result = await setSessionsAutomationPaused(control.pauseSessionIds, true);
    logInfo(`automation pause: ${result.updated}/${result.requested} selected chat(s) paused after current work`);
  }
  if (control.resumeAll) {
    const deferred = control.companionReloadDeferral;
    const ownerCurrent = () => !deferred ||
      deferred.deferredForProcess && !deferred.dispatched && companionReloadOwnerCurrent(deferred);
    if (!ownerCurrent()) {
      throw new Error('Companion reload deferral no longer belongs to this pending account generation; automation was not resumed.');
    }
    const result = deferred
      ? await resumeAutomationAfterExplicitRequest(control.trigger, ownerCurrent)
      : await resumeAutomationAfterExplicitRequest(control.trigger);
    if (!ownerCurrent()) throw new Error('Companion reload deferral owner changed during resume; its completion was not accepted for the replacement generation.');
    logInfo(`automation resume: accepted (${result.queued} queued, ${result.alreadyActive} working, ${result.recovering} recovering)`);
  }
}

function drainExplicitAutomationControls(): void {
  if (quitting || !explicitAutomationSettingsRuntimeReady || explicitAutomationControlInFlight || pendingExplicitAutomationControls.length === 0) return;
  const next = pendingExplicitAutomationControls[0]!;
  if (explicitAutomationControlNeedsBridge(next) && !explicitAutomationControlRuntimeReady) {
    startExplicitAutomationControlRuntime();
    return;
  }
  const control = pendingExplicitAutomationControls.shift()!;
  explicitAutomationControlInFlight = true;
  logInfo(`automation control: bridge/runtime ready; draining ${control.trigger}`);
  void applyExplicitAutomationControl(control).catch(error => {
    logWarn(`automation control failed: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => {
    explicitAutomationControlInFlight = false;
    drainExplicitAutomationControls();
  });
}

function requestExplicitAutomationControl(control: ExplicitAutomationControl): void {
  const tail = pendingExplicitAutomationControls.at(-1);
  if (tail && sameExplicitAutomationControl(tail, control)) {
    logInfo(`automation control: coalesced ${control.trigger} with the pending explicit request`);
  } else {
    pendingExplicitAutomationControls.push(control);
    if (!explicitAutomationSettingsRuntimeReady ||
        (explicitAutomationControlNeedsBridge(control) && !explicitAutomationControlRuntimeReady)) {
      logInfo(`automation control: queued ${control.trigger} until bridge/runtime startup is ready`);
    }
  }
  drainExplicitAutomationControls();
}

function acceptExplicitAutomationControlArgs(argv: readonly string[]): void {
  try {
    if (argv.some(argument => argument.startsWith('--reload-companion') || argument.startsWith('--discard-unexportable-companion-buffers'))) {
      const state = companionReloadOperatorState(argv, '--reload-companion');
      requestExplicitAutomationControl({ pauseAll: false, pauseSessionIds: [], resumeAll: false,
        helperSettings: null, signOutEmergencyAlerts: null, manualCompanionReload: state,
        trigger: 'explicit approved companion-buffer discard and manual reload request' });
      return;
    }
    const deferred = argv.some(argument => argument.startsWith('--defer-companion-reload'))
      ? deferCompanionReloadForProcess(argv) : undefined;
    const control = explicitAutomationControlFromArgs(argv);
    if (control) {
      if (deferred) control.companionReloadDeferral = deferred;
      requestExplicitAutomationControl(control);
    }
  } catch (error) {
    logWarn(`automation control arguments rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function markExplicitAutomationControlRuntimeReady(): void {
  explicitAutomationControlRuntimeReady = true;
  drainExplicitAutomationControls();
}

function markExplicitAutomationSettingsRuntimeReady(): void {
  explicitAutomationSettingsRuntimeReady = true;
  drainExplicitAutomationControls();
}

type PendingCompanionReload = {
  fingerprint: string;
  profileId: string;
  profileMode: 'isolated' | 'legacy';
  stateRoot: string;
  profileEpoch: number;
  attempting: boolean;
  dispatched: boolean;
  deferredForProcess: boolean;
  unsubscribe: () => void;
};
let pendingCompanionReload: PendingCompanionReload | null = null;

/** Diagnostic only: a startup disk marker and reload request never attest executing Chrome bytes. */
function companionActivationSnapshot(startupPublishedFingerprint: string | null) {
  const state = pendingCompanionReload;
  const current = state !== null && !quitting && companionReloadOwnerCurrent(state);
  const fingerprint = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
  return {
    startupPublishedFingerprint: fingerprint(startupPublishedFingerprint),
    requestFingerprint: current ? fingerprint(state.fingerprint) : null,
    requestState: !state ? 'no-pending-owner' : !current ? 'obsolete-owner'
      : state.dispatched ? 'dispatched-unconfirmed' : state.deferredForProcess ? 'deferred-for-process'
        : state.attempting ? 'checking-eligibility' : 'awaiting-eligibility',
    executingGeneration: 'unverified'
  };
}

/** A pending generation belongs to one exact account epoch, independently of admission policy. */
function companionReloadOwnerCurrent(state: PendingCompanionReload): boolean {
  if (pendingCompanionReload !== state) return false;
  const runtime = getActiveInstanceRuntime();
  return runtime.profile.id === state.profileId && runtime.profile.state.mode === state.profileMode &&
    runtime.stateRoot === state.stateRoot && (getConfig().tunnel.profileEpoch ?? 0) === state.profileEpoch;
}

/** One exact warm-process owner parser for deferral and deliberate buffer-discard reload. */
function companionReloadOperatorState(argv: readonly string[], prefix: '--defer-companion-reload' | '--reload-companion'): PendingCompanionReload {
  const names = ['', '-pid', '-generation', '-epoch', '-fingerprint'].map(suffix => prefix + suffix);
  const manual = prefix === '--reload-companion';
  const discard = argv.filter(argument => argument === '--discard-unexportable-companion-buffers').length;
  if ((manual ? discard !== 1 : discard !== 0) || argv.some(argument =>
    argument.startsWith(manual ? '--defer-companion-reload' : '--reload-companion'))) {
    throw new Error('Manual companion reload requires one explicit --discard-unexportable-companion-buffers approval and cannot share a deferral control.');
  }
  if (argv.some(argument => argument.startsWith(prefix) &&
    !names.some(name => argument === name || argument.startsWith(`${name}=`)))) {
    throw new Error('Unknown companion reload deferral option; no reload or automation setting was changed.');
  }
  const values = names.map(name => {
    const matches = argv.filter(argument => argument === name || argument.startsWith(`${name}=`));
    if (matches.length !== 1 || matches[0] === name) throw new Error('Companion reload deferral requires one exact profile, PID, process generation, account epoch and pending fingerprint.');
    return matches[0]!.slice(name.length + 1);
  });
  const [profileId, pid, generation, epoch, fingerprint] = values as [string, string, string, string, string];
  if (!/^[a-z][a-z0-9-]{0,99}$/.test(profileId) || !/^[1-9][0-9]{0,9}$/.test(pid) ||
    !/^[1-9][0-9]{0,15}$/.test(generation) || !/^(?:0|[1-9][0-9]{0,15})$/.test(epoch) ||
    !/^[a-f0-9]{64}$/.test(fingerprint) || Number(pid) > 0xffff_ffff ||
    !Number.isSafeInteger(Number(generation)) || !Number.isSafeInteger(Number(epoch))) {
    throw new Error('Companion reload deferral owner fields are invalid; no reload or automation setting was changed.');
  }
  const control = explicitAutomationControlFromArgs(argv);
  if (argv.includes('--updated') || argv.some(argument => argument.startsWith('--safe-close-for-update')) ||
    operatorSessionInspectionRequest(argv) || operatorSettingsControlRequest(argv) || operatorConnectionControlRequest(argv) ||
    operatorSharedAccountSettingsRequest(argv) || operatorProfileCreationRequest(argv) || operatorProfileBrowserBindingRequest(argv) || operatorProfileRenameRequest(argv) ||
    operatorInputRequestIds(argv).length || operatorInputCancellationIds(argv).length || operatorInputRetryIds(argv).length ||
    operatorPluginRefreshRearmIds(argv).length || control &&
      (manual || control.pauseAll || control.pauseSessionIds.length || control.helperSettings || control.signOutEmergencyAlerts !== null)) {
    throw new Error(manual
      ? 'Manual companion reload is exclusive and cannot resume automation or change another setting; no control was accepted.'
      : 'Companion reload deferral may share a launch only with its explicit automation resume; no other control was accepted.');
  }
  const state = pendingCompanionReload;
  const runtime = getActiveInstanceRuntime();
  const selectors = argv.filter(argument => argument === '--cos-instance-runtime' || argument.startsWith('--cos-instance-runtime='));
  if (runtime.profile.state.mode === 'isolated'
    ? selectors.length !== 1 || selectors[0] !== `--cos-instance-runtime=${profileId}`
    : selectors.length !== 0) {
    throw new Error('Companion reload deferral must use this account\'s exact existing runtime selector.');
  }
  if (quitting || !state || !companionReloadOwnerCurrent(state) || state.profileId !== profileId ||
    state.profileEpoch !== Number(epoch) || state.fingerprint !== fingerprint || process.pid !== Number(pid) ||
    processCreationTime === null || Math.trunc(processCreationTime) !== Number(generation)) {
    throw new Error('Companion reload deferral does not match this running process and pending account generation; no reload or resume was accepted.');
  }
  if (state.dispatched) throw new Error('Companion reload was already dispatched and cannot be deferred or repeated. Inspect its exact receipt; no resume was accepted.');
  if (manual && getConfig().ui.automationPaused !== true) throw new Error('Manual companion buffer-discard reload requires this account to remain globally paused; no reload or resume was accepted.');
  return state;
}

/** Exact warm-process operator choice; no config, fingerprint receipt or Chrome state is changed. */
function deferCompanionReloadForProcess(argv: readonly string[]): PendingCompanionReload {
  const state = companionReloadOperatorState(argv, '--defer-companion-reload');
  state.deferredForProcess = true;
  logWarn(`Browser companion reload deliberately deferred for profile ${state.profileId}, process ${process.pid}, generation ${Math.trunc(processCreationTime!)}, epoch ${state.profileEpoch}, fingerprint ${state.fingerprint}. Existing Chrome companion retained under its normal compatibility and admission checks; changed bytes remain pending and were NOT verified loaded. Deferral ends on process restart or replacement of this pending owner.`);
  return state;
}

/** Deliberate native reload only: the operator approved volatile companion-buffer loss. */
async function reloadCompanionAfterExplicitRequest(state: PendingCompanionReload): Promise<void> {
  const current = () => !quitting && companionReloadOwnerCurrent(state) && getConfig().ui.automationPaused === true;
  if (!current() || state.dispatched || state.attempting) throw new Error('Manual companion reload owner is obsolete, already dispatched or still attempting another reload; automation remains paused.');
  state.attempting = true;
  try {
    let origin: string | null;
    try {
      origin = await getSecret(bridgeExtensionOriginSecretSlot(state.profileMode, state.profileId));
    } catch {
      throw new Error('The exact account encrypted companion origin could not be read. Keep automation paused and use that account\'s companion popup Reload; no origin was guessed.');
    }
    if (!current()) throw new Error('Manual companion reload owner changed during origin lookup; no native reload was requested.');
    const url = companionReloadUrl(origin, `${Date.now().toString(36)}-${process.pid.toString(36)}`);
    if (!url) throw new Error('No valid encrypted companion origin is available for this exact account. Keep automation paused and use its companion popup Reload; no fallback origin or account was used.');
    if (!current() || state.dispatched) throw new Error('Manual companion reload ownership expired before dispatch; no native reload was requested.');
    state.dispatched = true; // Native launch can occur even when its Promise later rejects.
    try {
      await openInPreferredBrowser(url);
    } catch {
      throw new Error('The manual companion reload may already have been issued. Its pending dispatched owner is retained; it will not be repeated automatically in this process. Inspect the native companion before another deliberate request.');
    }
    if (!current()) throw new Error('Manual companion reload was requested, but its account owner changed before return. The dispatched owner is retained; no replay or loaded-byte claim was made.');
    logInfo(`Manual companion reload requested for profile ${state.profileId} after explicit volatile-buffer discard approval. Global automation remains paused; app records and the pending fingerprint are retained. Chrome loaded bytes and pairing are NOT yet verified.`);
  } finally {
    state.attempting = false;
  }
}

/** A cached extension origin never grants reload authority for a paused or replaced account. */
function companionReloadCurrent(state: PendingCompanionReload): boolean {
  return !quitting && !state.deferredForProcess && getConfig().ui.automationPaused !== true && companionReloadOwnerCurrent(state);
}

/** Fresh bounded browser presence is reload eligibility, not proof of useful chat work. */
async function companionReloadEligible(state: PendingCompanionReload): Promise<boolean> {
  if (!companionReloadCurrent(state)) return false;
  const status = await bridgeStatus();
  return companionReloadCurrent(state) && status.paired === true && status.present === true && status.authState === 'signed-in';
}

function clearPendingCompanionReload(state: PendingCompanionReload): void {
  if (pendingCompanionReload !== state) return;
  pendingCompanionReload = null;
  state.unsubscribe();
}

async function completePendingCompanionReload(state: PendingCompanionReload): Promise<void> {
  if (pendingCompanionReload !== state || state.attempting) return;
  if (quitting) { clearPendingCompanionReload(state); return; }
  if (state.dispatched) return;
  if (!companionReloadCurrent(state)) return;
  state.attempting = true;
  try {
    const profile = getActiveInstanceRuntime().profile;
    const origin = await getSecret(bridgeExtensionOriginSecretSlot(profile.state.mode, profile.id));
    if (!companionReloadCurrent(state)) return;
    const url = companionReloadUrl(origin, `${Date.now().toString(36)}-${process.pid.toString(36)}`);
    if (!url || !(await companionReloadEligible(state))) return;
    if (!companionReloadCurrent(state)) return;
    // Native launch can take effect even if its Promise rejects. Never replay an issued Reload:
    // Reload itself disconnects the companion, so later presence is not an acceptance receipt.
    state.dispatched = true;
    await openInPreferredBrowser(url);
    if (!companionReloadCurrent(state)) return;
    await writeDurableNow(COMPANION_FINGERPRINT_STATE, state.fingerprint);
    if (!companionReloadCurrent(state)) return;
    clearPendingCompanionReload(state);
    logInfo('Changed browser companion reload requested in its paired Chrome profile; this is not loaded-build confirmation. The recovery tab remains available when completion is unconfirmed.');
  } catch (error) {
    logWarn(`Browser companion delayed reload failed${state.dispatched ? '; a native request was already issued and will not be retried automatically in this process' : ''}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    state.attempting = false;
  }
}

/**
 * Keeps one exact installed companion generation pending until this account proves its Chrome
 * extension origin, fresh paired presence and unpaused admission. Paused/unpaired Chrome can
 * still hold unassigned session-only journals: do not wipe them with a speculative Reload.
 * This is process-lifetime work; a later eligible bridge change continues the same pending owner.
 */
async function armPendingCompanionReload(fingerprint: string): Promise<void> {
  if (pendingCompanionReload?.fingerprint === fingerprint &&
    (pendingCompanionReload.dispatched || companionReloadOwnerCurrent(pendingCompanionReload))) return;
  pendingCompanionReload?.unsubscribe();
  const runtime = getActiveInstanceRuntime();
  const state: PendingCompanionReload = { fingerprint,
    profileId: runtime.profile.id, profileMode: runtime.profile.state.mode, stateRoot: runtime.stateRoot,
    profileEpoch: getConfig().tunnel.profileEpoch ?? 0, attempting: false, dispatched: false,
    deferredForProcess: false, unsubscribe: () => {} };
  state.unsubscribe = onBridgeChange(() => { void completePendingCompanionReload(state); });
  pendingCompanionReload = state;
  // Close the subscribe-after-read race if the companion arrived while reload setup was running.
  await completePendingCompanionReload(state);
}

/** Requests changed companion bytes once in this eligible account's Chrome profile. */
async function reloadPairedCompanionAfterUpdate(fingerprint: string | null): Promise<void> {
  if (!app.isPackaged || !fingerprint || quitting) return;
  const runtime = getActiveInstanceRuntime();
  const profileId = runtime.profile.id, profileMode = runtime.profile.state.mode, stateRoot = runtime.stateRoot;
  const profileEpoch = getConfig().tunnel.profileEpoch ?? 0;
  const previouslyActivated = await readDurable<string>(COMPANION_FINGERPRINT_STATE);
  const current = getActiveInstanceRuntime();
  if (quitting || current.profile.id !== profileId || current.profile.state.mode !== profileMode ||
    current.stateRoot !== stateRoot || (getConfig().tunnel.profileEpoch ?? 0) !== profileEpoch) return;
  if (!process.argv.includes('--updated') && previouslyActivated === fingerprint) return;
  await armPendingCompanionReload(fingerprint);
  if (pendingCompanionReload?.fingerprint === fingerprint) {
    logWarn(pendingCompanionReload.deferredForProcess
      ? 'Changed browser companion bytes remain pending under an exact operator deferral for this process. Existing Chrome bytes were not verified updated.'
      : pendingCompanionReload.dispatched
      ? 'Browser companion reload was already requested; its exact bookkeeping remains held. No automatic replay will occur in this process. Inspect the account reload and receipt before restarting.'
      : 'Browser companion was updated on disk; reload remains pending until this exact account is unpaused, signed in and freshly paired. Cached extension origin alone cannot authorize Reload.');
  }
}

// Validate account setup controls before selecting any runtime or taking its singleton.
// A rejected mixed cold launch must never start an isolated account, connect, or change stores.
let startupProfileCreationData: ReturnType<typeof operatorProfileCreationAdditionalData>;
try {
  startupProfileCreationData = operatorProfileCreationAdditionalData(process.argv);
} catch (error) {
  console.error(`Account setup rejected before startup: ${error instanceof Error ? error.message : String(error)}`);
  app.exit(1);
}

// Chromium's process singleton is scoped to userData. Every isolated account gets its own
// already-prepared directory before taking that lock, while the legacy process keeps its path.
const developmentRoot = developmentUserDataOverride(app.isPackaged, process.env.COS_DEV_USER_DATA);
if (developmentRoot) app.setPath('userData', developmentRoot);
const developmentBridgePort = developmentBridgePortOverride(app.isPackaged, developmentRoot, process.env.COS_DEV_BRIDGE_PORT);
const isolatedSelection = isolatedProcessSelection(process.argv, app.getPath('userData'));
if (isolatedSelection) {
  if (!existsSync(path.join(isolatedSelection.runtimeRoot, 'config.json'))) {
    throw new Error('Isolated account runtime was not prepared by the primary app.');
  }
  app.setPath('userData', isolatedSelection.runtimeRoot);
  usePrimaryStableExtensionRoot(isolatedSelection.canonicalRoot);
}

// One instance per account runtime: copies of the same account would fight over its stores.
const hasSingleInstanceLock = app.requestSingleInstanceLock(startupProfileCreationData);
if (!hasSingleInstanceLock) {
  // `app.quit()` does not make the rest of this module stop executing. Mark this process as a
  // terminal secondary instance immediately, so neither native activation nor the async bootstrap
  // below can touch shared config/durable state while the primary instance is still running.
  quitting = true;
  app.quit();
} else if (startupProfileCreationData && 'cosSessionInspection' in startupProfileCreationData) {
  // Inspection observes an existing Main lifetime. Winning this account's singleton means
  // that lifetime is absent; normal bootstrap would re-arm saved browser work while reading it.
  const request = startupProfileCreationData.cosSessionInspection.request;
  console.error(`Session inspection unavailable: account ${request.instanceId} must already be running; receipt ${request.receipt}. No runtime, browser recovery, or window was started. Start the account normally, then inspect it.`);
  quitting = true;
  app.exit(1);
} else if (process.argv.some(argument => argument.startsWith('--defer-companion-reload') || argument.startsWith('--reload-companion') || argument.startsWith('--discard-unexportable-companion-buffers'))) {
  // This option targets an already-running exact process, never a new/default account launch.
  console.error('Companion reload deferral rejected on cold launch; the targeted running process is absent. No runtime was started.');
  quitting = true;
  app.quit();
} else if (safeCloseForUpdateAttempted(process.argv)) {
  // The maintenance launcher won the lock only because this exact account process disappeared
  // before Electron could deliver `second-instance`. The requested state (not running) is already
  // true. Consume even malformed/misrouted attempts and leave before config, stores, bridge,
  // browser, renderer, or ordinary startup can turn a close race into a fresh app launch.
  try {
    const profileId = coldSafeCloseForUpdateProfileId(process.argv, isolatedSelection?.instanceId ?? null);
    console.info(`Safe close for update: ${profileId} is already stopped; no runtime was started.`);
  } catch (error) {
    console.error(`Safe close for update rejected before startup: ${error instanceof Error ? error.message : String(error)}`);
  }
  quitting = true;
  app.quit();
}

/** Recover the UI only. The existing durable Input/Goal owners retain every operation. */
async function handleRendererFailure(owner: BrowserWindow, details: NativeProcessFailureDetails): Promise<void> {
  const current = () => window === owner && !owner.isDestroyed() && !owner.webContents.isDestroyed();
  const stopping = () => quitting || shutdownStarted || windowActivation.isDisabled() ||
    profileWorkAdmission.snapshot().mode !== 'open';
  const result = await rendererRecovery.recover(details, {
    isCurrent: current,
    isStopping: stopping,
    reload: () => owner.webContents.reload()
  });
  if (result.outcome === 'ignored' || result.outcome === 'superseded') return;
  logEvent('window.renderer.failure',
    `outcome=${result.outcome} reason=${result.reason} exit=${result.exitCode ?? 'unknown'} automaticReloadUsed=${result.automaticReloadUsed}`, 'warn');
  if (result.outcome !== 'attention' || !result.notify || !current() || stopping()) return;
  try {
    const choice = await dialog.showMessageBox(owner, {
      type: 'error', title: 'Chat On Steroids view stopped',
      message: 'The app view could not recover automatically.',
      detail: 'Reload refreshes only this window. Saved chats and queued work stay in place; unconfirmed messages are not resent.',
      buttons: ['Reload view', 'Dismiss'], defaultId: 0, cancelId: 1, noLink: true
    });
    // The native dialog may outlive its window, a Drain request, or app shutdown.
    if (choice.response !== 0 || !current() || stopping()) return;
    owner.webContents.reload();
    logEvent('window.renderer.manual-reload', 'Explicit view-only reload requested; operation custody retained');
  } catch {
    logEvent('window.renderer.recovery-unavailable', 'Native view recovery could not be displayed or dispatched; operation custody retained', 'warn');
  }
}

function createWindow(): void {
  const layout = windowLayoutForWorkArea(screen.getPrimaryDisplay().workArea);
  const icon = browserWindowIconPath(process.platform, app.isPackaged, process.resourcesPath);
  const nativeTitle = accountWindowTitle(getActiveInstanceRuntime().profile);
  window = new BrowserWindow({
    ...layout,
    ...(icon ? { icon } : {}),
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: titleBarOverlayForTheme(getConfig().ui.theme)
    } : {}),
    // Painted before the renderer loads, so a dark window never flashes white.
    backgroundColor: getConfig().ui.theme === 'dark' ? '#0e0e11' : '#ffffff',
    title: nativeTitle,
    webPreferences: {
      zoomFactor: UI_BASE_ZOOM,
      preload: path.join(__dirname, '../preload/index.js'),
      ...(rendererPartition ? { partition: rendererPartition } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // The renderer only ever loads our own local files.
      webSecurity: true
    }
  });
  const createdWindow = window;

  if (process.platform === 'win32') window.removeMenu();
  // The renderer's static HTML title must never erase the account owner from Windows taskbar
  // hover. This process owns one active profile for its lifetime, so main keeps the native title.
  window.on('page-title-updated', event => {
    event.preventDefault();
    window?.setTitle(nativeTitle);
  });

  // First visible use may passively discover the account from an already-open ChatGPT page.
  // Window visibility is never browser-opening authority; an explicit Refresh/Send can promote
  // this same discovery nonce if the selected browser actually needs to be opened.
  window.on('show', () => {
    if (!quitting && getChatModels().state === 'unknown') void startChatModelDiscovery(false)
      .catch(error => logWarn(`model discovery on window open: ${error.message}`));
  });
  window.once('ready-to-show', () => {
    // A renderer can finish loading after Cmd+Q has already entered bounded teardown. Never let
    // that late native event make the app visible again while `will-quit` is draining.
    if (!quitting) {
      // Newly created windows intentionally start maximized. Keep that startup-only presentation
      // here so later tray/Dock/native activation can show an existing user-sized window without
      // overwriting its geometry.
      if (!window?.isFullScreen()) window?.maximize();
      showWindow();
    }
  });

  // A renderer that fails to load leaves a blank window with no other clue, so
  // record it where the diagnostics panel can show it.
  window.webContents.on('did-finish-load', () => logInfo('window loaded'));
  createdWindow.webContents.on('render-process-gone', (_event, details) => {
    void handleRendererFailure(createdWindow, details).catch(() => {
      logEvent('window.renderer.recovery-unavailable', 'View recovery handler failed; operation custody retained', 'warn');
    });
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F11' || input.isAutoRepeat) return;
    event.preventDefault();
    window?.setFullScreen(!window.isFullScreen());
  });
  window.webContents.on('context-menu', (_event, params) => {
    const owner = window;
    if (!owner || owner.isDestroyed()) return;
    const template = editContextMenuTemplate(params);
    if (template.length) Menu.buildFromTemplate(template).popup({ window: owner });
  });
  window.webContents.on('did-fail-load', (_event, code, description) =>
    logError(`window failed to load (${code}): ${description}`)
  );
  // Renderer errors are otherwise invisible from here. Only errors, and only the
  // message text — never anything the page was working with.
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') logError(`renderer: ${details.message}`);
  });

  // Nothing in this app should ever open a second window or navigate away.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  window.on('close', (event) => {
    if (!quitting && getConfig().ui.minimizeToTray) {
      event.preventDefault();
      window?.hide();
    }
  });

  // Electron keeps the object after the window is gone, and every member on it throws from
  // then on. Holding that reference made `getWindow()` answer "yes, there is a window" for
  // the rest of the process, so the renderer pushes and the tray's Open both aimed at a
  // corpse. Dropping it is what makes those paths take their existing null branch.
  window.on('closed', () => {
    if (window === createdWindow) window = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function showWindow(): void {
  // Defense in depth for every current or future native activation source. The explicit gate
  // below additionally protects the long pre-window startup interval, while this invariant makes
  // a direct caller harmless once `before-quit` has started.
  if (quitting) return;
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

setFinishNotifier((title, body, sessionId, turnId) => {
  if (window?.isFocused() || !Notification.isSupported()) return false;
  const write = (): void => {
    showWindow();
    if (!window) return;
    const target = window.webContents;
    const open = (): void => { if (!target.isDestroyed()) target.send('session:write', sessionId); };
    if (target.isLoadingMainFrame()) target.once('did-finish-load', open); else open();
  };
  const notice = new Notification({ title, body, actions: [
    { type: 'button', text: 'Send Automatic Goal' }, { type: 'button', text: 'Write Directly' }
  ] });
  notice.on('click', write);
  notice.on('action', (details) => {
    if (details.actionIndex === 0) void requestSessionFinishGoal(sessionId, turnId).catch(error => logWarn(`Finish goal: ${error.message}`));
    else if (details.actionIndex === 1) write();
  });
  notice.show();
  return true;
});
setUserNoticeNotifier((title, body, sessionId) => {
  // A person looking at the app already has the exact recovery row this accompanies.
  if (window?.isFocused() || !Notification.isSupported()) return false;
  const notice = new Notification({ title, body });
  notice.on('click', () => {
    showWindow();
    if (!window) return;
    const target = window.webContents;
    const open = (): void => { if (!target.isDestroyed()) target.send('session:write', sessionId); };
    if (target.isLoadingMainFrame()) target.once('did-finish-load', open); else open();
  });
  notice.show();
  return true;
});
type PendingSignOutEmergencyRing = {
  profileId: string;
  target: WebContents;
  listener: () => void;
};
let pendingSignOutEmergencyRing: PendingSignOutEmergencyRing | null = null;

function clearPendingSignOutEmergencyRing(profileId?: string): boolean {
  const pending = pendingSignOutEmergencyRing;
  if (!pending || (profileId !== undefined && pending.profileId !== profileId)) return false;
  pendingSignOutEmergencyRing = null;
  pending.target.removeListener('did-finish-load', pending.listener);
  return true;
}

setSignOutEmergencyNotifier(notice => {
  // This alert accompanies a positive provider-owned sign-out verdict, so it remains visible
  // even while the app is focused. At night an existing renderer owns the one bounded 16-second
  // wake tone; a headless/background process falls back to the native notification sound.
  const target = window && !window.isDestroyed() ? window.webContents : null;
  const rendererOwnsRing = notice.ringComputer && Boolean(target && !target.isDestroyed());
  if (rendererOwnsRing && target) {
    clearPendingSignOutEmergencyRing();
    const sendRing = (): void => {
      if (!target.isDestroyed()) target.send('notice:signout-emergency', {
        profileId: notice.profileId,
        profileName: notice.profileName
      });
    };
    if (target.isLoadingMainFrame()) {
      let pending!: PendingSignOutEmergencyRing;
      const ring = (): void => {
        if (pendingSignOutEmergencyRing !== pending) return;
        pendingSignOutEmergencyRing = null;
        sendRing();
      };
      pending = { profileId: notice.profileId, target, listener: ring };
      pendingSignOutEmergencyRing = pending;
      target.once('did-finish-load', ring);
    } else {
      sendRing();
    }
  }
  if (!Notification.isSupported()) {
    if (notice.ringComputer && !rendererOwnsRing) {
      logWarn('sign-out emergency: local nighttime ring unavailable because no renderer or native notification surface is active');
    }
    return rendererOwnsRing;
  }
  const native = new Notification({
    title: notice.title,
    body: notice.body,
    // Daytime is a visual alert. At night exactly one computer sound owner is selected above.
    silent: !notice.ringComputer || rendererOwnsRing
  });
  native.on('click', showWindow);
  native.show();
  return true;
});
setSignOutEmergencyStopNotifier(profileId => {
  clearPendingSignOutEmergencyRing(profileId);
  const target = window && !window.isDestroyed() ? window.webContents : null;
  if (target && !target.isDestroyed()) target.send('notice:signout-emergency-cleared', { profileId });
});
setConnectionLossNotifier(surface => {
  // The in-app status already explains a visible outage; avoid a second interruption there.
  if (window?.isFocused() || !Notification.isSupported()) return false;
  const label = surface === 'core' ? 'Core' : surface === 'desktop' ? 'Desktop' : 'Plugins';
  const notice = new Notification({
    title: `${label} connection lost`,
    silent: true,
    body: 'The connector stopped working unexpectedly. Open Chat On Steroids to check the connection.'
  });
  notice.on('click', showWindow);
  notice.show();
  return true;
});
setBrowserWorkArea(() => screen.getPrimaryDisplay().workArea);

// Electron promises `second-instance` only after its own `ready`, not after our async startup.
// Until CSP/permission handlers and IPC are installed below, a re-launch is only a focus request
// for the initial window that startup is already going to show, so do not construct one early.
const windowActivation = createWindowActivationGate(showWindow);

// Chromium auxiliary failures are contained and reported. They do not imply a tool result,
// authorize operation replay, or justify shutting down the other chats in this process.
if (ownsAppRuntime(hasSingleInstanceLock)) app.on('child-process-gone', (_event, details) => {
  if (quitting || shutdownStarted) return;
  const failure = childProcessFailureDiagnostic(details);
  if (failure.reason === 'clean-exit') return;
  logEvent('app.auxiliary.failure',
    `type=${failure.processType} reason=${failure.reason} exit=${failure.exitCode ?? 'unknown'} action=${failure.action}`, 'warn');
});
const processCreationTime = process.getCreationTime();
const safeCloseForUpdate = createSafeCloseForUpdateGate({
  info: logInfo,
  warn: logWarn,
  runningProcessId: process.pid,
  runningProcessGeneration: processCreationTime === null ? null : Math.trunc(processCreationTime)
});

function failInstancePreflight(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const message =
    `This device could not safely activate its instance profile. No bridge, connector, browser session, or runtime store was started.\n\n${detail}`;
  console.error(`Instance profile preflight failed: ${detail}`);
  try { dialog.showErrorBox('Chat On Steroids could not start', message); } catch { /* Headless startup still fails closed. */ }
  quitting = true;
  windowActivation.disable();
  app.quit();
}

/** Build the native tray image from encoded PNGs, never platform-dependent bitmap bytes. */
function trayIcon(running: boolean): Electron.NativeImage {
  const spec = trayImageSpec(process.platform, running);
  const [base, ...highDpi] = spec.representations;
  const image = nativeImage.createFromBuffer(base.png, { scaleFactor: base.scaleFactor });
  for (const representation of highDpi) {
    image.addRepresentation({
      scaleFactor: representation.scaleFactor,
      dataURL: `data:image/png;base64,${representation.png.toString('base64')}`
    });
  }
  if (spec.template) image.setTemplateImage(true);
  return image;
}

function refreshTray(): void {
  if (!tray) return;
  const state = getStatus().state;
  const connected = state === 'connected';
  const offline = state === 'offline';
  // Offline keeps the running icon: the bridge is up, the internet is not.
  const running = connected || offline;
  const label = connected ? 'Connected' : offline ? 'No internet' : 'Not connected';
  const accountTitle = accountWindowTitle(getActiveInstanceRuntime().profile);
  tray.setImage(trayIcon(running));
  tray.setToolTip(`${accountTitle} — ${label.toLowerCase()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: accountTitle, enabled: false },
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Open', click: windowActivation.request },
      {
        label: running ? 'Disconnect' : 'Connect',
        click: () => void (running ? disconnect() : connect())
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
  // Consume this exact-owner recovery control before any transported registry/input action.
  // A malformed mixed request must not mutate another owner before deferral rejects it.
  if (argv.some(argument => argument.startsWith('--defer-companion-reload') || argument.startsWith('--reload-companion') || argument.startsWith('--discard-unexportable-companion-buffers'))) {
    if (additionalData != null && (typeof additionalData !== 'object' || Array.isArray(additionalData) || Object.keys(additionalData).length !== 0)) {
      logWarn('Companion reload deferral refused a mixed or malformed second-instance transport; no control was accepted.');
      return;
    }
    acceptExplicitAutomationControlArgs(argv);
    return;
  }
  try {
    const registration = operatorProfileCreationSecondInstanceArgs(argv, additionalData);
    if (registration) { acceptOperatorInputArgs(registration); return; }
  } catch (error) {
    logWarn(`operator account setup transport refused: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  // Maintenance shutdown is an exclusive exact-profile control. Malformed or mixed requests are
  // consumed fail-closed rather than focusing the window or starting another operation.
  if (safeCloseForUpdate.accept(argv)) return;
  acceptOperatorInputArgs(argv);
  acceptExplicitAutomationControlArgs(argv);
  if (!isBackgroundLaunch(argv)) windowActivation.request();
});

void app.whenReady().then(async () => {
  // This guard is intentionally before even app.getPath/init* calls. A secondary instance, or a
  // primary that was told to quit before ready, must never touch the primary's shared userData.
  if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;
  const userData = app.getPath('userData');
  initConfigPath(userData, isolatedSelection?.canonicalRoot ?? userData, developmentBridgePort);
  try {
    await loadConfig();
    const activeRuntime = getActiveInstanceRuntime();
    if (isolatedSelection && activeRuntime.profile.id !== isolatedSelection.instanceId) {
      throw new Error('Isolated process config belongs to a different account; no runtime owner was started.');
    }
    if (isolatedSelection) {
      const primaryConfig = JSON.parse(await fs.readFile(path.join(isolatedSelection.canonicalRoot, 'config.json'), 'utf8')) as { instances?: unknown };
      const parent = parseInstanceRegistry(primaryConfig.instances);
      const expected = parent.profiles.find(profile => profile.id === isolatedSelection.instanceId);
      if (!expected) throw new Error('Isolated account is absent from the primary profile registry; no runtime owner was started.');
      assertCanonicalAccountRouting(activeRuntime.profile, expected);
      await validateIsolatedInstanceSecrets(activeRuntime.profile.id, activeRuntime.profile.tunnelProfileRef);
    }
    const ownerPaths = getActiveInstanceOwnerPaths();
    setLogProfileContext(activeRuntime.profile.id);
    configureSurfaceIdentity(getActiveConnectorNames(), activeRuntime.profile);
    rendererPartition = ownerPaths.electronPartition;
    rendererSessionOwner = rendererPartition ? session.fromPartition(rendererPartition) : session.defaultSession;
    // One machine-local diagnostic folder, with fixed bounded incident slots per
    // account. This stays alongside the existing logger rather than becoming a
    // second transcript database or a cross-profile credential directory.
    initLogFile(ownerPaths.logFile, path.join(isolatedSelection?.canonicalRoot ?? userData,
      'local-incidents', activeRuntime.profile.id));
    // A disconnected caller or renderer is not a Main-process exit. Keep this in the
    // existing per-profile log so a reported shared crash can be checked against the
    // actual process generation, without recording argv, environment or chat text.
    logEvent('app.runtime.started',
      `pid=${process.pid} parentPid=${process.ppid} generation=${processCreationTime === null ? 'unknown' : Math.trunc(processCreationTime)} packaged=${app.isPackaged} platform=${process.platform}`);
    initSessionStore(ownerPaths.sessionStoreRoot);
    initDurableStore(ownerPaths.durableStoreRoot);
    await loadConnectorIdentity();
    runtimeStoresReady = true;
    logEvent('profile.config.loaded', `Loaded ${activeRuntime.profile.accountLabel || activeRuntime.profile.displayName || activeRuntime.profile.id} (${activeRuntime.profile.platform})`);
  } catch (error) {
    failInstancePreflight(error);
    return;
  }
  // Chrome remembers the stable user-data path, not the package's versioned resource folder.
  // Refresh that stable copy on every packaged startup before the bridge can invite Chrome to
  // do work. Version text is deliberately not the boundary: private builds can carry new code
  // under the same upstream version number, while extensionDir's content fingerprint and staged
  // rename make this update idempotent and crash recoverable.
  // Every eligible packaged account joins the same exclusive shared-folder publisher. This
  // does not require opening the personal account; Chrome storage, pairing and ports stay private.
  const companion = extensionDir();
  const companionFingerprint = companionMaterializedFingerprint(companion);
  if (app.isPackaged && !companion) logWarn('Browser companion could not be materialized; the last known good copy was unavailable.');
  else if (app.isPackaged) logInfo('Browser companion folder available; materializer fingerprint diagnostics distinguish current package from retained fallback. Chrome loaded bytes still require verification.');
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    snapshotLogOnCrash(`${origin}: ${error.stack ?? error.message}`);
  });
  await restoreChatModels();
  if (windowActivation.isDisabled()) return;
  try { await initSkills(userData); }
  catch (error) { logWarn(`Skills could not initialize: ${error instanceof Error ? error.message : String(error)}`); }
  const pluginProfile = getActiveInstanceRuntime().profile;
  await pluginManager.initialize(userData, { mode: pluginProfile.state.mode, instanceId: pluginProfile.id });
  if (windowActivation.isDisabled()) return;
  if (!isolatedSelection) {
    try { applyLoginStartup(app, getConfig().ui.startAtLogin === true); }
    catch (error) { logWarn(`Windows login startup: ${error instanceof Error ? error.message : String(error)}`); }
  }
  // The renderer has its own explicit light/dark palette, so native chrome must follow the same
  // user choice instead of Electron's default `system` theme. On macOS this controls the window
  // frame, application menus and OS dialogs; on Linux/Windows it covers Electron-native UI.
  nativeTheme.themeSource = getConfig().ui.theme;
  const savedGoalObjectives = await readDurable<GoalObjectivesSnapshot>(GOAL_OBJECTIVES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalObjectives(savedGoalObjectives);
  const savedGoalSwitches = await readDurable<GoalSwitchesSnapshot>(GOAL_SWITCHES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalSwitches(savedGoalSwitches);
  const savedGoalReplies = await readDurable<GoalRepliesSnapshot>(GOAL_REPLIES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalReplies(savedGoalReplies);
  await pruneMissingSessionGoalRepliesNow();
  if (windowActivation.isDisabled()) return;
  // Request ownership must exist before either side of the bridge can race in. A request id
  // that was proved yesterday remains the same workflow today even if its ChatGPT tab closed.
  await restoreRequestCorrelations();
  if (windowActivation.isDisabled()) return;
  // And the user's blocks, for the same reason: a chat blocked yesterday is still the rogue
  // turn today, and a block that loads after the first call is a tool the turn already got.
  await restoreBlockedChats();
  if (windowActivation.isDisabled()) return;
  await prunePermanentlyDeletedGoalSwitchesNow(new Set((await listDeletedSessions())
    .flatMap(row => row.chatIds.length ? row.chatIds : row.conversationId ? [row.conversationId] : [])));
  if (windowActivation.isDisabled()) return;
  // Bridge admission needs only the authoritative Core state, not Connection's MCP/tunnel
  // implementation. Inject the reader here to keep bridge.ts out of the connection -> MCP tool
  // registration cycle while preserving connection.ts as the single health owner.
  setCoreConnectionStateProvider(() => getStatus().state);
  setCoreConnectionRecoveryProvider(async () => {
    await connect();
    return getStatus().state;
  });
  setCoreIncidentDiagnosticProvider((input) => diagnoseCoreToolSurfaceIncident(input).diagnostic);
  setDiagnosticIncidentProvider({
    note: noteExhaustedDiagnosticIncidentNow,
    claim: claimDiagnosticIncidentWakeNow,
    offerForClaim: diagnosticIncidentWakeOfferForClaim,
    claimCurrent: diagnosticIncidentWakeClaimCurrent,
    bindInput: bindDiagnosticIncidentWakeInputNow,
    settle: settleDiagnosticIncidentWakeNow,
    bindChat: bindDiagnosticIncidentChatNow,
    retireMissingChat: retireMissingDiagnosticIncidentChatNow,
    suppress: suppressDiagnosticIncidentsForSourceNow,
    resolve: resolveDiagnosticIncidentNow,
    recoverSource: resolveRecoveredDiagnosticIncidentNow,
    snapshot: diagnosticIncidentSnapshot
  });
  applyCoreConnectionDispatchState(getStatus().state);
  onStatusChange((next) => applyCoreConnectionDispatchState(next.state));
  setAgentConversationLookup(agentConversation);
  // The prime's chat is the user's own, so no extension report can name it. It is bound
  // when the recorder manages to place the prime's first call. See recordToolCall.
  setAgentBinder(bindConversation);
  // Before anything can call an agent tool, and before a run is restored: the broker
  // decides whether a previous run has been abandoned partly from which ChatGPT tabs are
  // open, and without this it can only answer "I cannot see" — which it treats, on
  // purpose, as a reason to leave the existing run alone.
  // How a fresh chat opens when no browser can be asked to open it. The app asks the OS for
  // the ChatGPT URL, which launches the browser if it is closed and creates the tab if there
  // is none — the two cases the old "wait for a ChatGPT tab to poll us" delivery could never
  // handle. Wired before any restored command is delivered, so a resume queued yesterday opens
  // as soon as the bridge starts rather than waiting for the user to visit ChatGPT.
  //
  // It is deliberately not how a page-driven Compact & Resume opens chat B. The OS resolves a
  // URL to whichever browser instance last had focus, which is a different window — and can be
  // a browser without this extension in it — from the one holding chat A. That decision belongs
  // to the browser that owns the source chat; see bridge.ts::offerPlacement.
  setBrowserOpener(async (url) => {
    // Let the command owner report launch failure; another browser may belong to another account.
    await openInPreferredBrowser(url);
  });

  // Persistence is a process-lifetime dependency of the broker, not a feature-toggle
  // dependency. Multi-agent can be enabled from Settings without restarting the process;
  // keeping both sinks wired from startup guarantees the first spawn can cross its durable
  // acceptance barrier even when this launch began with multi-agent disabled.
  onSwarmPersist(() => writeDurableSoon(SWARM_STATE, snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot));

  // A multi-agent run outlives this process. Restoring it before the bridge starts
  // means a worker that never joined gets its chat re-requested through the same queue
  // as a fresh one, rather than being stranded with a key nobody has.
  onRetiredWorkersPersist(() => writeDurableSoon(RETIRED_WORKERS_STATE, snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow((snapshot) => writeDurableNow(RETIRED_WORKERS_STATE, snapshot));
  const retiredWorkers = await readDurable<RetiredWorkersSnapshot>(RETIRED_WORKERS_STATE);
  if (windowActivation.isDisabled()) return;
  restoreRetiredWorkers(retiredWorkers);
  const savedSwarm = await readDurable<SwarmSnapshot>(SWARM_STATE);
  if (windowActivation.isDisabled()) return;
  restoreSwarm(savedSwarm);
  if (!getConfig().multiAgent.enabled) {
    // A feature toggle is a pause, not Clear swarm. Canonicalize any active incarnation left by
    // a crash into stopped prime-owned history before the bridge exists, then make that safer
    // projection durable. Re-enabling later in this process or after another restart recovers the
    // same exact worker conversations without letting disabled workers consume execution slots.
    pauseSwarmForDisable('multi-agent mode is disabled');
    await writeDurableNow(SWARM_STATE, snapshotSwarm());
    if (windowActivation.isDisabled()) return;
  }
  // Continuation recovery is after swarm restore because an interrupted durable rebind may
  // have to finish publishing the prime transfer that was frozen in that snapshot.
  setContinuationRecoveryHooks({
    repairPrimeTransfer: repairPrimeConversationAfterRecovery,
    hasPrimeFleet: primeFleetIn
  });
  const savedContinuations = await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE);
  if (windowActivation.isDisabled()) return;
  await restoreContinuations(savedContinuations);
  if (windowActivation.isDisabled()) return;
  // A bulk delete is committed before its first destructive side effect. If the process died
  // between selected rows, finish that exact durable set before browser/connector execution can
  // observe an undeleted remainder and resume work the user already chose to remove.
  await reconcilePendingSessionDeletionBatch();
  if (windowActivation.isDisabled()) return;
  await reconcilePendingSessionRestore();
  if (windowActivation.isDisabled()) return;

  // Runtime owners above are process-lifetime singletons. A profile switch therefore crosses a
  // restart boundary only after this coordinator has proved the source profile idle. The target
  // config is written for the successor process without rebinding any owner in this process.
  const profileLifecycle = new ProfileLifecycleCoordinator({
    profileId: getActiveInstanceRuntime().profile.id,
    admission: profileWorkAdmission,
    census: activeProfileWorkCensus,
    readDeferredSwitch: async () => deferredProfileSwitchState(),
    writeDeferredSwitch: writeDeferredProfileSwitchState,
    onSwitchReady: async (state) => {
      logEvent('profile.switch.ready', `Verified idle for profile switch ${state.sourceProfileId} -> ${state.targetProfileId}`);
      await flushRecorder();
      await Promise.all([flushSessions(), flushDurable()]);
      await stageInstanceActivationForNextStart(state.targetProfileId);
      logEvent('profile.switch.staged', `Staged ${state.targetProfileId} for the next application start`);
      app.relaunch();
      quitting = true;
      app.quit();
    },
    applyUpdate: async () => {
      await flushRecorder();
      await Promise.all([flushSessions(), flushDurable()]);
      if (!markInstallOnQuit()) throw new Error('There is no downloaded, verified update to install yet.');
      logEvent('update.drain.ready', 'Verified idle; handing the committed update to the ordinary shutdown sequence');
      quitting = true;
      app.quit();
    },
    prepareShutdown: async () => {
      await flushRecorder();
      await Promise.all([flushSessions(), flushDurable()]);
    },
    applyShutdown: () => {
      logEvent('maintenance.drain.ready', 'Verified idle; closing once so the external update owner can replace and reopen the app');
      quitting = true;
      app.quit();
    },
    onStatusChange: (status) => {
      if (status.phase === 'idle') return;
      logEvent('profile.lifecycle', `${status.phase}: ${status.blockerCount} active operation(s) remain; categories=${status.blockers.map(row => `${row.category}:${row.count}`).join(',') || 'none'}`);
    }
  });
  const restoredLifecycle = await profileLifecycle.restore();
  logEvent('profile.lifecycle.restored', `Restored ${restoredLifecycle.profileId} lifecycle state: ${restoredLifecycle.phase}`);
  await safeCloseForUpdate.enable(
    getActiveInstanceRuntime().profile.id,
    () => profileLifecycle.requestShutdown(),
    { status: () => profileLifecycle.getStatus(), cancel: transitionId => profileLifecycle.cancelDrain(transitionId),
      companionStatus: () => companionActivationSnapshot(companionFingerprint) }
  );
  if (quitting || windowActivation.isDisabled()) return;

  // Strict CSP for our own page. There is no remote content and no inline script.
  rendererSessionOwner.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
        ]
      }
    });
  });

  // Deny every permission request; the UI needs none of them.
  rendererSessionOwner.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // From here on a second launch may safely focus/recreate the window: renderer security policy
  // is installed and the renderer's fixed IPC methods already have handlers before it can load.
  // The same quit the tray's Quit performs. It has to go through `quitting` for the window's
  // close-to-tray handler to let go: without it, quitting to install would hide the window and
  // leave the app running, which is exactly the trap the Install button exists to end.
  stopIpcLifecyclePolling = registerIpc(
    () => window,
    () => {
      quitting = true;
      app.quit();
    },
    profileLifecycle
  );
  // IPC configures the input delivery hooks. Only now may the restart wake owner load the
  // account-specific durable outbox; operator controls remain queued until that restore settles.
  try {
    await startQueuedWakeRetrySync();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logError(`Durable input startup failed: ${detail}`);
    try {
      dialog.showErrorBox('Chat On Steroids could not start',
        `The saved delivery queue could not be restored safely. No queued work was resumed.\n\n${detail}`);
    } catch { /* Headless startup still fails closed. */ }
    quitting = true;
    windowActivation.disable();
    app.quit();
    return;
  }
  // A quit/update request can arrive while the strict outbox restore is awaiting disk. Do not
  // re-enable activation or accept startup work after before-quit has fenced this runtime.
  if (quitting || windowActivation.isDisabled()) return;
  windowActivation.enable();
  if (!isBackgroundLaunch(process.argv)) windowActivation.request();
  // macOS `activate` can fire on first launch, so do not wire it at module load where it could
  // create a BrowserWindow before Electron is ready. Once the initial window path is established,
  // Dock activation/re-launch can safely recreate or focus it.
  registerNativeWindowActivation(app, windowActivation.request);

  tray = new Tray(trayIcon(false), ...trayGuidArgsForPlatform());
  tray.on('click', windowActivation.request);
  refreshTray();
  onStatusChange(refreshTray);

  logInfo('app started');
  operatorProfileLifecycle = profileLifecycle;
  operatorInputRuntimeReady = true;
  acceptOperatorInputArgs(process.argv);
  for (const argv of pendingOperatorInputArgv.splice(0)) acceptOperatorInputArgs(argv);

  // Historical Unattributed repair may legitimately scan and rewrite a large legacy bucket.
  // It is maintenance, not a prerequisite for showing the app or accepting new exact-id
  // traffic, so never make startup/reload wait behind years of old session history.
  queueDeterministicAttributionRepair();

  // The bridge serves recording and multi-agent mode both: recording needs the extension to
  // observe the chat, and multi-agent mode needs it to open worker tabs. Explicit pause/resume
  // controls need the same restored command journal even when those persistent switches are off.
  let automationControlBridgeStartInFlight = false;
  const ensureExplicitAutomationControlRuntime = (): void => {
    if (explicitAutomationControlRuntimeReady || automationControlBridgeStartInFlight || quitting || windowActivation.isDisabled()) return;
    automationControlBridgeStartInFlight = true;
    armBrowserStartupRecovery();
    void startBridge().then(async bridgePort => {
      if (bridgePort === null) {
        logWarn('bridge startup did not reach its publication barrier; explicit automation controls remain queued');
        return;
      }
      await reloadPairedCompanionAfterUpdate(companionFingerprint).catch((error: Error) =>
        logWarn(`Browser companion could not reload automatically: ${error.message}`));
      if (quitting || windowActivation.isDisabled()) return;
      markExplicitAutomationControlRuntimeReady();
    }).catch((error: Error) => {
      logWarn(`bridge startup failed: ${error.message}; explicit automation controls remain queued`);
    }).finally(() => {
      automationControlBridgeStartInFlight = false;
    });
  };
  startExplicitAutomationControlRuntime = ensureExplicitAutomationControlRuntime;

  // Local settings controls need restored config/account identity but no browser recovery. Keep
  // that readiness separate from the bridge gate so a helper-only correction cannot wake or
  // resume browser automation merely to publish one existing Settings value.
  markExplicitAutomationSettingsRuntimeReady();
  acceptExplicitAutomationControlArgs(process.argv);
  if (process.argv.includes('--updated') && process.argv.includes('--resume-automation') &&
      !process.argv.includes('--pause-automation')) {
    logInfo('startup: suppressed bulk --resume-automation on updated launch; stable Chrome inventory will resume only genuinely missing work');
  }
  // Either persistent switch starts the normal bridge. A request received earlier in async
  // bootstrap is also enough to start it, so that request cannot remain stranded in memory.
  if (getConfig().sessions.record || getConfig().multiAgent.enabled ||
      pendingExplicitAutomationControls.some(explicitAutomationControlNeedsBridge)) {
    ensureExplicitAutomationControlRuntime();
  }
  if (windowActivation.isDisabled() || quitting) return;
  const keepAwake = createKeepAwake({
    sessions: async () => (await indexedSessions()).map(summary => ({ ...summary, activityExpiresAt: sessionActivityExpiresAt(summary) })),
    enabled: () => getConfig().ui.keepAwake !== false,
    blocker: {
      start: () => powerSaveBlocker.start('prevent-app-suspension'),
      stop: id => { if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id); }
    }
  });
  const uninstallKeepAwake = installKeepAwake(keepAwake);
  const stopKeepAwakeSessionChanges = onSessionChange(() => { void keepAwake.refresh(); });
  stopKeepAwake = () => { stopKeepAwakeSessionChanges(); uninstallKeepAwake(); };
  void keepAwake.refresh();

  // Retention governs recordings already stored on disk, independent of whether recording is
  // currently enabled. The tray app can stay alive for days, so run once now and keep a coarse
  // maintenance timer rather than making expiry depend on the next process restart.
  stopSessionRetention = startSessionRetentionMaintenance({
    retainDays: () => getConfig().sessions.retainDays,
    prune: pruneSessions,
    onRemoved: (removed) => logInfo(`removed ${removed} session(s) past the retention window`),
    onError: (err) => logError(`session pruning failed: ${err.message}`)
  });

  // An explicit local settings/dry-run launch is not authority to start connector traffic.
  if (getConfig().ui.autoConnect && !operatorSessionInspectionRequest(process.argv) && !operatorSharedAccountSettingsRequest(process.argv) && !operatorConnectionControlRequest(process.argv) && !operatorSettingsControlRequest(process.argv)) void connect();

  // Never awaited: an unreachable GitHub, a slow download or a broken release must not delay a
  // window that is already on screen. Everything it learns arrives through the ordinary state
  // push, every failure ends inside it, and its own timer keeps it running for a tray app that
  // is never restarted.
  if (!isolatedSelection) startUpdateChecks();
  // Warm the existing derived cache once, after startup, without delaying the UI.
  // A visit to Usage joins this same calculation; unchanged recordings cost no reads.
  void usageOverview(usageWarmup.signal).catch((error: Error) => {
    if (!usageWarmup.signal.aborted) logWarn(`usage background refresh failed: ${error.message}`);
  });
});

app.on('before-quit', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  quitting = true;
  stopKeepAwake?.();
  stopKeepAwake = null;
  stopQueuedWakeRetrySync();
  stopIpcLifecyclePolling?.();
  stopIpcLifecyclePolling = null;
  // From this point `will-quit` owns a bounded teardown. A Dock click/relaunch arriving while
  // that sequence drains must not recreate or reveal a window after the tray has disappeared.
  windowActivation.disable();
  usageWarmup.abort();
});

app.on('window-all-closed', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  // macOS convention: closing the last window is not quitting the application. The Dock/menu
  // bar stay alive and `activate` recreates it. Windows/Linux retain the explicit close-to-tray
  // preference; Cmd+Q / app.quit bypasses this event and still enters the shutdown sequence.
  if (shouldQuitOnWindowAllClosed(process.platform, getConfig().ui.minimizeToTray)) app.quit();
});

app.on('will-quit', (event) => {
  // A secondary instance called app.quit() only to get out of the primary's way. It must be
  // allowed to exit normally: preventing that quit and flushing/stopping the primary's shared
  // stores from a process that never initialized or owns them is both a hang and data race.
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  // Profile/device preflight can intentionally quit before any mutable runtime owner exists.
  // In that case there is nothing to drain, and preventing the quit would strand a headless app.
  if (!runtimeStoresReady) return;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopSessionRetention?.();
  stopSessionRetention = null;
  tray?.destroy();
  tray = null;

  void runShutdownSequence(
    [
      // Phase 1: stop both listeners from admitting work and let accepted requests drain.
      // The budget has to clear the drains it contains, or it would silently defeat them:
      // the bridge force-closes wedged localhost sockets at 15s and the MCP endpoint forces
      // its own drain at 30s. This is the outer bound on both, not a competing one.
      { name: 'admission/drain', budgetMs: 40_000, run: () => [shutdownConnection(), shutdownBridge()] },
      // Phase 2: only after request handlers are done may their owned child processes go.
      {
        name: 'process cleanup',
        budgetMs: 15_000,
        run: () => [unifiedExecManager.terminateAllProcesses(), stopComputerHelper(), pluginManager.close()]
      },
      // Phase 3: recorder work can enqueue both session projections and named durable state.
      { name: 'recorder flush', budgetMs: 10_000, run: () => [flushRecorder()] },
      // These are independent writers. One rejection must never skip the other flush.
      { name: 'durable flush', budgetMs: 10_000, run: () => [flushSessions(), flushDurable()] },
      // Last, because it is the one phase whose effect is meant to outlive this process: a
      // staged update is handed to the platform's installer here, so the next start of the app
      // is the new version. Nothing is staged unless it downloaded whole and matched the
      // release's published SHA-256, and applying it cannot fail loudly - see update.ts.
      { name: 'update handoff', budgetMs: 5_000, run: () => [applyStagedUpdate()] }
    ],
    {
      info: logInfo,
      warn: logWarn,
      error: logError,
      // Not `app.quit()`. See the note on ShutdownHooks.exit: a quit raised from the
      // continuation that ends this sequence is dropped by Electron, and the app is left
      // running with nothing to click and the single-instance lock still held.
      exit: () => {
        // The sequence has just logged its completion; a phase inside it would flush too early.
        void flushLogBeforeExit().finally(() => {
          shutdownComplete = true;
          app.exit(0);
        });
      }
    }
  );
});

// Belt and braces: no web contents anywhere in this app may open a window or
// navigate. External links go through the vetted allowlist in ipc.ts instead.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
});

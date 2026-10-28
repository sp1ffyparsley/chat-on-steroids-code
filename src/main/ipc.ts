import { applyLoginStartup, supportsLoginStartup } from './window-lifecycle.js';
import { prepareFollowupPrompt, prepareSessionPrompt } from './session/prompt.js';
import { verifySelectedSkillBodies } from './session/skill-prompt.js';
import { nativeExecutionScopeForPreparedInput } from './mcp/plan-tool.js';
import { executionScopeFromNativeDelivery } from '../shared/agent-plan.js';
import { importSkillFile, isSafeSkillId, listSkills, removeSkill } from './skills.js';
import { noteChatOrigin } from './session/recorder.js';
import { isGenericAutomaticSessionTitle, originTitle, REASONING_EFFORTS, type SessionEvent } from '../shared/session.js';
import { safeExternalLink } from '../shared/external-link.js';
import { wakeBrowserWork } from './browser-wake.js';
import { refreshKeepAwake } from './keep-awake.js';
import { getChatModels, startChatModelDiscovery, configureChatModelDiscovery } from './chat-models.js';
import { releaseSessionFinish, requestSessionFinishGoal } from './session/finish.js';
import { GOAL_MARKER_INSTRUCTION } from '../shared/goal-templates.js';
import { validateInputImages } from './session/input-images.js';
import { stageInputAttachment, type AttachmentSource } from './session/input-attachments.js';
import { recordDeliveredInput, recordedInputImage } from './session/input-history.js';
import { UI_BASE_ZOOM, titleBarOverlayForTheme } from './window-layout.js';
import { usageOverview } from './session/usage.js';
import { inputArgs, listInputs, editQueuedInput, reorderQueuedInputs, setInputAutomation, configureInputDelivery, pausedBrowserHelpers, cancelFinishInputs, sessionDecisionHelperCustody } from './session/input.js';
import { configureLoopForwardReadiness, draftOpeningMessage, onGoalChange, nativeGoalFailure, retryGoalBrowserHelper, retryPausedGoalBrowserHelpers } from './goal.js';
import { cancelTaskRequest, runTaskRequest } from './task-request.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { requestBrowserPreferences } from './browser-preferences.js';
import { fleetAlarmAutomationSnapshot } from './fleet-automation.js';
import { sendDesktopInput, cancelDesktopInput, cancelDesktopInputsForSession, retryQueuedInputBrowser } from './session/start-input.js';
import { assertModelDiscoveryCanWake, wakeBrowserUrl } from './browser-startup.js';
import { registerPluginIpc } from './plugins-ipc.js';
import { confirmedPluginSchemas, pluginRefreshPublications } from './plugin-refresh.js';
/** Read-only final attestation used by the existing native Input authorization owner.
 * A frozen human-scope digest does not attest selected Skill file revisions. */
export async function preparedNativeScopeCurrent(
  entry: Readonly<import('./session/input.js').InputEntry>,
  inputOwnerRows: readonly import('./session/input.js').InputEntry[],
): Promise<boolean> {
  const prepared = entry.deliveryText ?? '';
  // No project discovery for ordinary messages. The validator still checks the
  // trusted frame, including incomplete selected declarations without a hash.
  const hasSelectedSkills = prepared.includes('# Selected skills') || prepared.includes('cos-skill-body-sha256:');
  const folderFor = () => entry.sessionId ? getSessionProject(entry.sessionId)
    : entry.projectId ? projectWorkspace(entry.projectId) : Promise.resolve(null);
  const folder = hasSelectedSkills ? await folderFor() : null;
  try { await verifySelectedSkillBodies(prepared, { projectPath: folder?.real ?? null }); }
  catch (error) {
    logEvent('input.scope.skill-source-held', 'Native Input held: selected Skill source is stale, unavailable or malformed', 'warn');
    throw error;
  }
  if (hasSelectedSkills) {
    const current = await folderFor();
    if (current?.real !== folder?.real || current?.virtual !== folder?.virtual) {
      logEvent('input.scope.project-binding-held', 'Native Input held: selected Skill project binding changed', 'warn');
      return false;
    }
  }
  // Resolve human authority AFTER Skill I/O so a concurrent human correction is
  // not hidden by a previously obtained digest. The Input owner rechecks route,
  // policy and this attestation around its existing durable authorization write.
  if (!entry.sessionId || !entry.conversationId) return true;
  const now = await nativeExecutionScopeForPreparedInput(entry.sessionId,
    entry.conversationId, inputOwnerRows, entry);
  if (now === null) return !prepared.includes('cos-execution-scope-sha256:');
  const frozen = executionScopeFromNativeDelivery(prepared, entry.text);
  return Boolean(frozen && frozen === now);
}

/**
 * IPC surface.
 *
 * A fixed list of named handlers, each validating its own input with zod. There is no
 * generic "call this method" or "read this file" channel, so a compromised renderer
 * gains only the operations listed below — it can never reach the filesystem or spawn
 * a process directly. Secrets travel one way: the renderer can set or clear the API
 * key but can never read it back.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { z } from 'zod';
import { manualPublicOriginSchema, manualPortSchema } from '../shared/external-tunnel.js';
import { InstanceProfileError } from '../shared/instance-profile.js';
import {
  CAPABILITIES,
  CHAT_BROWSERS,
  GOAL_MODES,
  GOAL_PROVIDERS,
  GOAL_REASONING_LEVELS,
  MAX_MULTI_AGENT_WORKERS,
  type AppState,
  type Config
} from '../shared/types.js';
import { MAX_AUTOMATION_OBJECTIVE_CHARS, MAX_GOAL_SYSTEM_PROMPT_CHARS } from '../shared/goal.js';
import { applySettings, connect, disconnect, getStatus, onStatusChange } from './connection.js';
import { configureSettingsControl, SettingsControlError } from './settings-control.js';
import { pruneOperatorControlResponses } from './operator-input.js';
import { effectiveCapabilities, getActiveInstanceRuntime, getConfig, getInstanceRegistry, updateConfig, refreshSharedFolderAccess, setSharedFolderAccess, MAX_MCP_INSTRUCTIONS_CHARS } from './config.js';
import { clearAllGoalSwitches, draftTaskPlan, listGoalModels, MODEL_PAGE_SIZE, retireGoalDrafts, goalBackendFor, goalSwitchFor, setGoalSwitchNow, setGoalReplyActiveNow, setGoalObjectiveNow } from './goal.js';
import { forgetExposedSurface } from './mcp/server.js';
import { runDiagnostics } from './diagnostics.js';
import { collectSupportReport } from './support-report.js';
import { loadComposerDrafts, saveComposerDrafts, retainedComposerAttachmentIds } from './composer-drafts.js';
import { composerDraftSaveSchema } from '../shared/composer-drafts.js';
import { openVerifiedWorkflowOutput, workflowOutputRequestSchema } from './session/workflow-output.js';
import { formatLogAsJson, formatLogForClipboard, getLog, logEvent, logInfo, onLog } from './logger.js';
import { RESERVED_ROOT_NAMES, nativePathIdentity, uniqueRootName, validateNewRoot, SandboxError, resolvePath } from './sandbox.js';
import { addProject, expireArmedProjectCreates, getSessionProject, projectWorkspace, listProjects, onProjectLinkChange, removeProject, retryProjectCreate } from './projects.js';
import { hasSecret, isEncryptionAvailable, profileProviderSecretSlot, secureStorageStatus, setSecret } from './secrets.js';
import { setupApiKeySlot } from '../shared/setup-profile.js';
import { addSetupProfile, removeSetupProfile, switchSetupProfile } from './setup-profiles.js';
import { bundledVersion, locateBinary } from './tunnel/locate.js';
import { TUNNEL_ID_PATTERN } from './tunnel/index.js';
import {
  bridgeStatus,
  recoveryHeldByCalls,
  settledTurnInputForwardProof,
  settledTurnContinuationAllowed,
  goalNativeCompletionReady,
  sessionActivityExpiresAt,
  sessionInputActivity,
  sessionControlsFor, stopSessionTurn, setSessionAutomation, setSessionObjective, setSessionsAutomation, setSessionsAutomationPaused, compactSession, cancelSessionCompaction,
  foregroundAutomationRotation,
  setSessionsRotationMembership,
  retireDeletedConversation,
  resumeAutomationChats, freshCopyAutomationChats, recoverStaleAutomationChats, automationSupervisorSnapshot, maintainLoopLanes, applyAutomationPause,
  cancelWorkerCommands,
  requestBrowserConversationOpen,
  onBridgeChange,
  reconcileBrowserAuthEmergencyPolicy,
  startBridge,
  stopBridge,
  swarmHealthState,
  sweepStaleSwarm,
  unpair
} from './bridge.js';
import { extensionDir } from './extension-path.js';
import { retireSignOutEmergencyIncidentAfterExplicitDisable } from './user-notice.js';
import { runtimeSourceIdentity } from './runtime-source.js';
import {
  deletedSessionCount,
  emptyDeletedSessions,
  listDeletedSessions,
  permanentlyDeleteSession,
  getSession,
  indexedSessions,
  listSessionPage,
  renameSession,
  setSessionWorkerLimit,
  findSessionByConversation,
  readEvents,
  readRecentEvents,
  readHandoff
} from './session/store.js';
import { workerLifecycleForConversation } from './session/progress.js';
import { locateRecordedSearchMatch, searchRecordedSessions } from './session/search.js';
import { activeSessionId, onSessionChange } from './session/recorder.js';
import {
  deleteRecordedSession,
  deleteRecordedSessionBatch,
  restoreDeletedRecordedSession,
  serializeSessionDeletion
} from './session/deletion.js';
import { blockedChatIds, setChatBlocked, setChatsBlocked, setChatsDeletedNow } from './session/blocked-chats.js';
import {
  assignSidebarFolder,
  clearSidebarFolders,
  createSidebarFolder,
  deleteSidebarFolder,
  listSidebarFolders,
  renameSidebarFolder
} from './session/sidebar-folders.js';
import {
  clearAgent,
  agentInfoForOwnedConversation,
  primeForOwnedConversation,
  onSwarmChange,
  pauseSwarmForDisable,
  persistAgentAuthorityNow,
  persistCriticalSwarmNow,
  setPrimeWorkerLimit,
  resetSwarm
} from './agents.js';
import { tokenPressure } from '../shared/session.js';
import { forgetWorkspaceRoot, renameWorkspaceRoot } from './workspace.js';
import { hostPlatformInfo } from './platform.js';
import { checkForUpdates, onUpdateChange, updateStatus } from './update.js';
import type { ProfileLifecycleCoordinator } from './profile-lifecycle.js';
import {
  buildInstanceProfilesSnapshot,
  assertManagedAccountBootstrapEditable,
  assertManagedAccountStopped,
  copyManagedConnectorSetup,
  createManagedInstanceProfile,
  listManagedBrowserProfiles,
  launchManagedInstanceRuntime,
  openManagedInstanceBrowser,
  refreshActiveInstanceConnector,
  requirePrimaryAccountManager,
  removeManagedInstanceProfile,
  renameManagedInstanceProfile,
  setManagedInstanceBrowserProfile,
  setManagedProfileCoreTunnel,
  setManagedInstanceProfileEnabled,
  switchManagedInstanceProfile
} from './instance-management.js';
import {
  getMacOSDesktopAccess,
  onMacOSDesktopAccessChange,
  refreshMacOSDesktopAccess
} from './computer/index.js';

/** Fixed native Settings destinations; authored chat links use the shared web/mail policy. */
const ALLOWED_LINKS = new Set([
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
]);

const capabilityPatch = z.object(
  Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean()])) as Record<
    (typeof CAPABILITIES)[number],
    z.ZodBoolean
  >
);

const settingsPatch = z.object({
  capabilities: capabilityPatch,
  readOnly: z.boolean(),
  tunnel: z.object({
    profileId: z.string().max(64).optional(),
    profileEpoch: z.number().int().nonnegative().optional(),
    pluginsTunnelId: z.string().max(128).refine(v => v === '' || TUNNEL_ID_PATTERN.test(v), 'Expected tunnel_ followed by 32 hex characters').optional(),
    kind: z.enum(['openai', 'cloudflared', 'manual']),
    tunnelId: z
      .string()
      .max(128)
      .refine((v) => v === '' || TUNNEL_ID_PATTERN.test(v), 'Expected tunnel_ followed by 32 hex characters'),
    // The Desktop connector's own tunnel. Empty is normal and means "not published":
    // Desktop is optional, and most users will never create a second Secure Tunnel.
    desktopTunnelId: z
      .string()
      .max(128)
      .refine((v) => v === '' || TUNNEL_ID_PATTERN.test(v), 'Expected tunnel_ followed by 32 hex characters'),
    binaryPath: z.string().max(4096),
    manualPublicOrigin: manualPublicOriginSchema.optional(),
    manualPort: manualPortSchema.optional()
  }),
  ui: z.object({
    chatBrowser: z.enum(CHAT_BROWSERS).optional(),
    developerMode: z.boolean().optional(),
    followOutput: z.boolean().optional(),
    finishTool: z.boolean().optional(),
    planBackend: z.enum(['chatgpt', 'api']).optional(),
    finishAction: z.enum(['notify', 'goal']).optional(),
    finishLeadMinutes: z.number().int().min(3).max(5).optional(),
    rotateTurnMinutes: z.number().int().min(0).max(120).optional(),
    backgroundChats: z.boolean().optional(),
    browserOnly: z.boolean().optional(),
    automationPaused: z.boolean().optional(),
    automationProfile: z.enum(['day', 'overnight', 'rotation']).optional(),
    autoRefreshPlugins: z.boolean().optional(),
    signOutEmergencyAlerts: z.boolean().optional(),
    tabsToKeepOpen: z.number().int().min(1).max(50).optional(),
    minimizeToTray: z.boolean(),
    autoConnect: z.boolean(),
    startAtLogin: z.boolean().optional(),
    keepAwake: z.boolean().optional(),
    privacyScreenshots: z.boolean(),
    theme: z.enum(['light', 'dark'])
  }),
  sessions: z.object({
    record: z.boolean(),
    retainDays: z.number().int().min(0).max(3650),
    advisoryTokens: z.number().int().min(10_000).max(4_000_000),
    limitTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  compaction: z.object({
    auto: z.boolean(),
    // Floored well above what a fresh chat holds, so a threshold cannot be set somewhere
    // every conversation is already past the moment it opens.
    autoTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  multiAgent: z.object({
    enabled: z.boolean(),
    defaultModel: z.string().max(80).optional(),
    defaultReasoning: z.enum(['', ...REASONING_EFFORTS]).optional(),
    maxWorkers: z.number().int().min(1).max(MAX_MULTI_AGENT_WORKERS),
    limitAutomaticChats: z.boolean(),
    maxActiveChats: z.number().int().min(1).max(16),
    rotationBatchSize: z.number().int().min(1).max(16),
    rotationMinutes: z.number().int().min(5).max(1440),
    rotationForegroundSlots: z.number().int().min(0).max(3),
    rateLimitCooldownMinutes: z.number().int().min(1).max(30),
    sleepingRuntimeMinutes: z.number().int().min(1).max(1440),
    allowUnattributedCalls: z.boolean(),
    recoverAgentTabs: z.boolean()
  }),
  mcp: z.object({ instructions: z.string().trim().max(MAX_MCP_INSTRUCTIONS_CHARS) }).strict().optional(),
  goal: z.object({
    impulseMinutes: z.number().int().min(0).max(60).optional(),
    includeToolCalls: z.boolean().optional(),
      backend: z.enum(['api', 'chatgpt', 'templates']).optional(),
      loopBackend: z.enum(['api', 'chatgpt']).optional(),
      continuationPolicy: z.enum(['strict', 'settled-turn']).optional(),
      helperModel: z.string().trim().min(1).max(80).optional(),
      helperReasoning: z.enum(REASONING_EFFORTS).optional(),
    enabled: z.boolean(),
    // Which of the two standing modes the switch runs. One field, so the renderer has no way
    // to describe a state where Goal and Loop are both on.
    mode: z.enum(GOAL_MODES),
    // Which LLM endpoint Goal/Loop drafts run on, plus the custom endpoint's base URL.
    // The URL is stored verbatim and validated at draft time (see resolveGoalBaseUrl):
    // a shape check here would either duplicate that logic or silently rewrite the address.
    provider: z.object({
      kind: z.enum(GOAL_PROVIDERS),
      baseUrl: z.string().max(2048)
    }),
    // An OpenRouter model id while the provider is openrouter, validated only as a shape:
    // the catalogue changes weekly, and an allow-list here would mean this app deciding
    // which models exist.
    // The leading `~` is OpenRouter's own marker for an alias that always resolves to the
    // newest model in a family — `~deepseek/deepseek-v4-flash-latest` and eleven others. The
    // picker lists them because the listing does, so refusing them here meant the one kind
    // of entry most worth choosing was the one kind that could not be saved.
    // A custom endpoint names its own models (`llama3.1`, a deployment id), so while custom
    // it is any non-empty id instead.
    model: z.string().min(1).max(160),
    reasoning: z.enum(GOAL_REASONING_LEVELS),
    prompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS),
    objectivePrompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS),
    loopPrompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
  }).superRefine((goal, ctx) => {
    if (goal.provider.kind !== 'custom' && !/^~?[a-z0-9._-]+\/[a-z0-9._-]+(:[a-z0-9._-]+)?$/i.test(goal.model)) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'Expected an OpenRouter model id like vendor/model'
      });
    }
  })
});

const settingsSave = z.object({ base: settingsPatch, patch: settingsPatch }).strict();
type SettingsSnapshot = z.infer<typeof settingsPatch>;

/**
 * Three-way merge for the renderer's settings form.
 *
 * The Chrome extension is a second writer for Goal/Auto Compact. The renderer previously sent
 * a blind full snapshot for every checkbox/theme edit, so a snapshot captured just before an
 * extension write could land just after it and silently undo that newer value. A field which is
 * unchanged between `base` and `wanted` was not edited by this renderer save and therefore keeps
 * the current main-process value. A field that differs was deliberately edited here and wins.
 */
function mergeSettings(current: Config, base: SettingsSnapshot, wanted: SettingsSnapshot): SettingsSnapshot {
  const tunnelEdited = (['tunnelId', 'desktopTunnelId', 'pluginsTunnelId'] as const)
    .some(key => (base.tunnel[key] ?? '') !== (wanted.tunnel[key] ?? ''));
  if (tunnelEdited && ((base.tunnel.profileId ?? 'default') !== (current.tunnel.profileId ?? 'default') ||
      (base.tunnel.profileEpoch ?? 0) !== (current.tunnel.profileEpoch ?? 0))) {
    throw new Error('Setup profile changed. Edit the tunnel ID in the selected profile again.');
  }
  const pick = <T>(live: T, before: T, next: T): T => (Object.is(before, next) ? live : next);
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      pick(current.capabilities[capability], base.capabilities[capability], wanted.capabilities[capability])
    ])
  ) as Config['capabilities'];
  return {
    mcp: wanted.mcp ? { instructions: pick(current.mcp.instructions, base.mcp?.instructions ?? '', wanted.mcp.instructions) } : current.mcp,
    capabilities,
    readOnly: pick(current.readOnly, base.readOnly, wanted.readOnly),
    tunnel: {
      ...current.tunnel,
        pluginsTunnelId: wanted.tunnel.pluginsTunnelId === undefined ? current.tunnel.pluginsTunnelId ?? ''
          : pick(current.tunnel.pluginsTunnelId ?? '', base.tunnel.pluginsTunnelId ?? '', wanted.tunnel.pluginsTunnelId),
      kind: pick(current.tunnel.kind, base.tunnel.kind, wanted.tunnel.kind),
      tunnelId: pick(current.tunnel.tunnelId, base.tunnel.tunnelId, wanted.tunnel.tunnelId),
      desktopTunnelId: pick(
        current.tunnel.desktopTunnelId,
        base.tunnel.desktopTunnelId,
        wanted.tunnel.desktopTunnelId
      ),
      binaryPath: pick(current.tunnel.binaryPath, base.tunnel.binaryPath, wanted.tunnel.binaryPath),
      manualPublicOrigin: wanted.tunnel.manualPublicOrigin === undefined ? current.tunnel.manualPublicOrigin ?? ''
        : pick(current.tunnel.manualPublicOrigin ?? '', base.tunnel.manualPublicOrigin ?? '', wanted.tunnel.manualPublicOrigin),
      manualPort: wanted.tunnel.manualPort === undefined ? current.tunnel.manualPort ?? 0
        : pick(current.tunnel.manualPort ?? 0, base.tunnel.manualPort ?? 0, wanted.tunnel.manualPort)
    },
    ui: {
      chatBrowser: pick(current.ui.chatBrowser, base.ui.chatBrowser, wanted.ui.chatBrowser),
      developerMode: pick(current.ui.developerMode, base.ui.developerMode, wanted.ui.developerMode),
      followOutput: pick(current.ui.followOutput, base.ui.followOutput, wanted.ui.followOutput),
      finishTool: pick(current.ui.finishTool, base.ui.finishTool, wanted.ui.finishTool),
      planBackend: pick(current.ui.planBackend, base.ui.planBackend, wanted.ui.planBackend),
      finishAction: pick(current.ui.finishAction, base.ui.finishAction, wanted.ui.finishAction),
      finishLeadMinutes: pick(current.ui.finishLeadMinutes, base.ui.finishLeadMinutes, wanted.ui.finishLeadMinutes),
      rotateTurnMinutes: pick(current.ui.rotateTurnMinutes, base.ui.rotateTurnMinutes, wanted.ui.rotateTurnMinutes),
      backgroundChats: pick(current.ui.backgroundChats, base.ui.backgroundChats, wanted.ui.backgroundChats),
      browserOnly: pick(current.ui.browserOnly, base.ui.browserOnly, wanted.ui.browserOnly),
      automationPaused: pick(current.ui.automationPaused, base.ui.automationPaused, wanted.ui.automationPaused),
      automationProfile: pick(current.ui.automationProfile, base.ui.automationProfile, wanted.ui.automationProfile),
      autoRefreshPlugins: pick(current.ui.autoRefreshPlugins, base.ui.autoRefreshPlugins, wanted.ui.autoRefreshPlugins),
      signOutEmergencyAlerts: pick(
        current.ui.signOutEmergencyAlerts,
        base.ui.signOutEmergencyAlerts,
        wanted.ui.signOutEmergencyAlerts
      ),
      tabsToKeepOpen: pick(current.ui.tabsToKeepOpen, base.ui.tabsToKeepOpen, wanted.ui.tabsToKeepOpen),
      minimizeToTray: pick(current.ui.minimizeToTray, base.ui.minimizeToTray, wanted.ui.minimizeToTray),
      autoConnect: pick(current.ui.autoConnect, base.ui.autoConnect, wanted.ui.autoConnect),
      startAtLogin: pick(current.ui.startAtLogin, base.ui.startAtLogin, wanted.ui.startAtLogin),
      keepAwake: pick(current.ui.keepAwake, base.ui.keepAwake, wanted.ui.keepAwake),
      privacyScreenshots: pick(
        current.ui.privacyScreenshots,
        base.ui.privacyScreenshots,
        wanted.ui.privacyScreenshots
      ),
      theme: pick(current.ui.theme, base.ui.theme, wanted.ui.theme)
    },
    sessions: {
      record: pick(current.sessions.record, base.sessions.record, wanted.sessions.record),
      retainDays: pick(current.sessions.retainDays, base.sessions.retainDays, wanted.sessions.retainDays),
      advisoryTokens: pick(
        current.sessions.advisoryTokens,
        base.sessions.advisoryTokens,
        wanted.sessions.advisoryTokens
      ),
      limitTokens: pick(current.sessions.limitTokens, base.sessions.limitTokens, wanted.sessions.limitTokens)
    },
    compaction: {
      auto: pick(current.compaction.auto, base.compaction.auto, wanted.compaction.auto),
      autoTokens: pick(current.compaction.autoTokens, base.compaction.autoTokens, wanted.compaction.autoTokens)
    },
    multiAgent: {
      defaultModel: pick(current.multiAgent.defaultModel, base.multiAgent.defaultModel, wanted.multiAgent.defaultModel),
      defaultReasoning: pick(current.multiAgent.defaultReasoning, base.multiAgent.defaultReasoning, wanted.multiAgent.defaultReasoning),
      enabled: pick(current.multiAgent.enabled, base.multiAgent.enabled, wanted.multiAgent.enabled),
      maxWorkers: pick(current.multiAgent.maxWorkers, base.multiAgent.maxWorkers, wanted.multiAgent.maxWorkers),
      limitAutomaticChats: pick(
        current.multiAgent.limitAutomaticChats,
        base.multiAgent.limitAutomaticChats,
        wanted.multiAgent.limitAutomaticChats
      ),
      maxActiveChats: pick(current.multiAgent.maxActiveChats, base.multiAgent.maxActiveChats, wanted.multiAgent.maxActiveChats),
      rotationBatchSize: pick(current.multiAgent.rotationBatchSize, base.multiAgent.rotationBatchSize, wanted.multiAgent.rotationBatchSize),
      rotationMinutes: pick(current.multiAgent.rotationMinutes, base.multiAgent.rotationMinutes, wanted.multiAgent.rotationMinutes),
      rotationForegroundSlots: pick(current.multiAgent.rotationForegroundSlots, base.multiAgent.rotationForegroundSlots, wanted.multiAgent.rotationForegroundSlots),
      rateLimitCooldownMinutes: pick(
        current.multiAgent.rateLimitCooldownMinutes,
        base.multiAgent.rateLimitCooldownMinutes,
        wanted.multiAgent.rateLimitCooldownMinutes
      ),
      sleepingRuntimeMinutes: pick(
        current.multiAgent.sleepingRuntimeMinutes,
        base.multiAgent.sleepingRuntimeMinutes,
        wanted.multiAgent.sleepingRuntimeMinutes
      ),
      allowUnattributedCalls: pick(
        current.multiAgent.allowUnattributedCalls,
        base.multiAgent.allowUnattributedCalls,
        wanted.multiAgent.allowUnattributedCalls
      ),
      recoverAgentTabs: pick(
        current.multiAgent.recoverAgentTabs,
        base.multiAgent.recoverAgentTabs,
        wanted.multiAgent.recoverAgentTabs
      )
    },
    goal: {
      impulseMinutes: pick(current.goal.impulseMinutes, base.goal.impulseMinutes, wanted.goal.impulseMinutes),
      includeToolCalls: pick(current.goal.includeToolCalls, base.goal.includeToolCalls, wanted.goal.includeToolCalls),
      backend: pick(current.goal.backend, base.goal.backend, wanted.goal.backend),
      loopBackend: pick(current.goal.loopBackend, base.goal.loopBackend, wanted.goal.loopBackend),
      continuationPolicy: pick(current.goal.continuationPolicy, base.goal.continuationPolicy, wanted.goal.continuationPolicy),
      helperModel: pick(current.goal.helperModel, base.goal.helperModel, wanted.goal.helperModel),
      helperReasoning: pick(current.goal.helperReasoning, base.goal.helperReasoning, wanted.goal.helperReasoning),
      enabled: pick(current.goal.enabled, base.goal.enabled, wanted.goal.enabled),
      mode: pick(current.goal.mode, base.goal.mode, wanted.goal.mode),
      provider: {
        kind: pick(current.goal.provider.kind, base.goal.provider.kind, wanted.goal.provider.kind),
        baseUrl: pick(current.goal.provider.baseUrl, base.goal.provider.baseUrl, wanted.goal.provider.baseUrl)
      },
      model: pick(current.goal.model, base.goal.model, wanted.goal.model),
      reasoning: pick(current.goal.reasoning, base.goal.reasoning, wanted.goal.reasoning),
      prompt: pick(current.goal.prompt, base.goal.prompt, wanted.goal.prompt),
      objectivePrompt: pick(
        current.goal.objectivePrompt,
        base.goal.objectivePrompt,
        wanted.goal.objectivePrompt
      ),
      loopPrompt: pick(current.goal.loopPrompt, base.goal.loopPrompt, wanted.goal.loopPrompt)
    }
  };
}

const sessionIdArg = z.object({ id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i) });
const agentIdArg = z.string().min(1).max(64).regex(/^[0-9a-z-]+$/i);

const renameRoot = z.object({
  name: z.string().min(1).max(32),
  newName: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Lowercase letters, digits, dot, dash and underscore only')
});

function resolvedBinary(config: Config): string | null {
  if (config.tunnel.kind === 'cloudflared') return locateBinary('cloudflared', config.tunnel.binaryPath);
  if (config.tunnel.kind === 'openai') return locateBinary('tunnel-client', config.tunnel.binaryPath);
  return null;
}

async function buildState(refreshRuntimeSource = false): Promise<AppState> {
  const config = await refreshSharedFolderAccess();
  const profile = getActiveInstanceRuntime().profile;
  return {
    config,
    status: getStatus(),
    connectorSchemas: Object.fromEntries(pluginRefreshPublications().map(({ surface, schemaId }) => [surface, schemaId])),
    confirmedConnectorSchemas: confirmedPluginSchemas(),
    platform: hostPlatformInfo(),
    loginStartupAvailable: supportsLoginStartup(process.platform, app.isPackaged),
    secureStorage: await secureStorageStatus(),
    hasApiKey: await hasSecret(setupApiKeySlot(config.tunnel.profileId)),
    hasGoalKey: await hasSecret(profileProviderSecretSlot(profile.state.mode, profile.id, 'openRouterApiKey')),
    hasCustomProviderKey: await hasSecret(profileProviderSecretSlot(profile.state.mode, profile.id, 'customProviderApiKey')),
    resolvedBinary: resolvedBinary(config),
    bundledTunnelVersion: bundledVersion(),
    bridge: await bridgeStatus(),
    update: updateStatus(),
    runtimeSource: await runtimeSourceIdentity(refreshRuntimeSource),
    desktopAccess: getMacOSDesktopAccess()
  };
}

/** Wraps a handler so a thrown error becomes a message the UI can show. */
function handle<T>(channel: string, fn: (payload: unknown) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return { ok: true as const, data: await fn(payload) };
    } catch (err) {
      const message =
        err instanceof SandboxError || err instanceof z.ZodError
          ? err instanceof z.ZodError
            ? (err.issues[0]?.message ?? 'Invalid input')
            : err.message
          : err instanceof Error
            ? err.message
            : String(err);
      if (channel.startsWith('instances:')) {
        logEvent(
          err instanceof InstanceProfileError ? 'profile.collision' : 'profile.operation.failed',
          `${channel} failed${err instanceof InstanceProfileError ? ` (${err.code})` : ''}: ${message}`,
          'warn'
        );
      }
      return {
        ok: false as const,
        error: message,
        ...(err instanceof InstanceProfileError ? { code: err.code } : {})
      };
    }
  });
}

/**
 * Releases the durable automation pause only for an explicit user/CLI resume boundary.
 *
 * Background reconnect, lane maintenance and ordinary recovery continue to call
 * resumeAutomationChats() directly, so they still fail closed while the user's pause is on.
 * Persist before releasing bridge admission: a crash can therefore never make the UI come back
 * paused after commands were already allowed to leave the durable queue.
 */
export async function resumeAutomationAfterExplicitRequest(trigger: string, ownerCurrent?: () => boolean) {
  const assertOwnerCurrent = () => {
    if (ownerCurrent && !ownerCurrent()) throw new Error('Automation resume owner changed; no further admission or chat recovery was authorized.');
  };
  assertOwnerCurrent();
  if (getConfig().ui.automationPaused === true) {
    await updateConfig(config => {
      assertOwnerCurrent(); // Exact deferred controls recheck inside the serialized settings owner.
      return { ...config, ui: { ...config.ui, automationPaused: false } };
    });
    assertOwnerCurrent();
    applyAutomationPause(false);
  }
  assertOwnerCurrent();
  return resumeAutomationChats({ trigger });
}

/** Explicit account reset: reuse recoverable deletion, never purge projects or provider history. */
export async function retireRecordedChatsAfterExplicitRequest(profileId: string) {
  const assertProfile = () => {
    if (getActiveInstanceRuntime().profile.id !== profileId) throw new Error('Chat retirement profile does not match this running account');
  };
  assertProfile();
  await updateConfig(config => {
    assertProfile();
    return { ...config, ui: { ...config.ui, automationPaused: true } };
  });
  applyAutomationPause(true);
  const ids = (await indexedSessions()).map(session => session.id);
  let removed = 0;
  logInfo(`chat retirement: profile ${profileId}; ${ids.length} recorded chats selected; recoverable copies retained`);
  for (let offset = 0; offset < ids.length; offset += 100) {
    assertProfile();
    const result = await deleteRecordedSessionBatch(ids.slice(offset, offset + 100), false);
    removed += result.deleted.length;
  }
  logInfo(`chat retirement: profile ${profileId}; ${removed}/${ids.length} removed; automation remains paused`);
  return { profileId, selected: ids.length, removed };
}

/** Narrow local alternative to the existing Settings field when desktop input is unavailable. */
export async function setHelperReasoningAfterExplicitRequest(profileId: string, value: unknown, modelValue?: unknown) {
  const reasoning = z.enum(REASONING_EFFORTS).parse(value);
  const model = modelValue === undefined ? undefined : z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/).parse(modelValue);
  const assertProfile = () => {
    if (getActiveInstanceRuntime().profile.id !== profileId) {
      throw new Error('Helper settings profile does not match this running account; no setting was changed');
    }
  };
  assertProfile();
  await updateConfig(config => {
    assertProfile(); // Recheck inside the existing serialized settings publication owner.
    return { ...config,
      ...(model ? { multiAgent: { ...config.multiAgent, defaultModel: model, defaultReasoning: reasoning } } : {}),
      goal: { ...config.goal, helperReasoning: reasoning, ...(model ? { helperModel: model } : {}) } };
  }, (published, previous) => {
    // Match Settings: revoke old helper authority synchronously at publication, before an await.
    // Do not clear reply obligations, per-chat Loops, or the user's global automation pause.
    if (previous.goal.helperReasoning !== published.goal.helperReasoning || previous.goal.helperModel !== published.goal.helperModel) retireGoalDrafts(false);
  });
  logInfo(`helper settings: profile ${profileId} reasoning explicitly set to ${reasoning}; automation pause unchanged`);
  if (model) logInfo(`chat settings: profile ${profileId} new-chat/worker/helper defaults explicitly set to ${model}/${reasoning}; frozen deliveries unchanged`);
  return { profileId, reasoning };
}

/** Shared lifecycle-safe Trash owner used by Empty Trash and the all-records purge. */
async function emptySessionTrashRecords(onlyId?: string) {
  return serializeSessionDeletion(async () => {
    const allTrash = await listDeletedSessions();
    const trash = onlyId ? allTrash.filter(row => row.id === onlyId) : allTrash;
    if (onlyId && trash.length === 0) throw new Error('This Trash item is no longer available');
    let activeDuplicatesDeleted = 0;
    const deletedActiveIds = new Set<string>();
    // Older builds could recreate a live row for a trashed conversation. Retire every exact
    // duplicate through the normal deletion transaction before removing its recovery copy.
    for (const row of trash) {
      const lineage = new Set(row.chatIds.length ? row.chatIds : row.conversationId ? [row.conversationId] : []);
      if (lineage.size === 0) continue;
      const duplicates = (await indexedSessions()).filter(
        session => !!session.conversationId && lineage.has(session.conversationId) && !deletedActiveIds.has(session.id)
      );
      if (duplicates.length > 0) {
        for (const duplicate of duplicates) {
          await deleteRecordedSession(duplicate.id, true);
          deletedActiveIds.add(duplicate.id);
        }
        activeDuplicatesDeleted += duplicates.length;
      } else {
        cancelDesktopInputsForSession(row.id);
        await setChatsDeletedNow([...lineage], true);
        if (row.conversationId) await retireDeletedConversation(row.conversationId, row.id);
      }
    }
    const removed = onlyId ? Number(await permanentlyDeleteSession(onlyId)) : await emptyDeletedSessions();
    return { removed, activeDuplicatesDeleted };
  });
}

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  _quitToInstall: () => void,
  profileLifecycle?: ProfileLifecycleCoordinator
): () => void {
  const requireProfileLifecycle = (): ProfileLifecycleCoordinator => {
    if (!profileLifecycle) throw new Error('Account profile lifecycle is not available yet.');
    return profileLifecycle;
  };
  handle('instances:get', async () => buildInstanceProfilesSnapshot(requireProfileLifecycle()));
  handle('instances:browserProfiles', async () => listManagedBrowserProfiles());
  handle('instances:create', async payload => {
    const request = z.object({
      nickname: z.string().trim().min(1).max(48),
      browserProfileDirectory: z.string().trim().min(1).max(128)
    }).strict().parse(payload);
    return createManagedInstanceProfile(requireProfileLifecycle(), request.nickname, request.browserProfileDirectory);
  });
  handle('instances:rename', async payload => {
    const request = z.object({ id: z.string().min(1).max(80), nickname: z.string().trim().min(1).max(48) }).strict().parse(payload);
    return renameManagedInstanceProfile(requireProfileLifecycle(), request.id, request.nickname);
  });
  handle('instances:setBrowserProfile', async payload => {
    const request = z.object({ id: z.string().min(1).max(80), browserProfileDirectory: z.string().trim().min(1).max(128) }).strict().parse(payload);
    const snapshot = await setManagedInstanceBrowserProfile(requireProfileLifecycle(), request.id, request.browserProfileDirectory);
    logInfo(`Chrome profile binding changed for inactive account ${request.id}`);
    return snapshot;
  });
  handle('instances:setCoreTunnel', async payload => {
    const request = z.object({ id: z.string().min(1).max(80), tunnelId: z.string().max(128) }).strict().parse(payload);
    const wasActive = getActiveInstanceRuntime().profile.id === request.id;
    const snapshot = await setManagedProfileCoreTunnel(requireProfileLifecycle(), request.id, request.tunnelId.trim());
    if (wasActive) await applySettings();
    logInfo(`Core tunnel settings saved for account ${request.id}; ${wasActive ? 'active connection refreshed' : 'inactive account unchanged at runtime'}`);
    return snapshot;
  });
  handle('instances:setRuntimeApiKey', async payload => {
    requirePrimaryAccountManager();
    const request = z.object({ id: z.string().min(1).max(80), value: z.string().max(500) }).strict().parse(payload);
    await assertManagedAccountStopped(request.id);
    await assertManagedAccountBootstrapEditable(request.id);
    if (!(await isEncryptionAvailable())) throw new Error('Secure OS credential storage is unavailable; the key was not saved.');
    const profile = getInstanceRegistry().profiles.find(row => row.id === request.id);
    if (!profile) throw new Error('Account profile not found.');
    const active = getActiveInstanceRuntime().profile;
    if (profile.platform !== active.platform || profile.deviceId !== active.deviceId) {
      throw new Error('This account belongs to another device.');
    }
    await setSecret(setupApiKeySlot(profile.tunnelProfileRef), request.value);
    logInfo(`Tunnel runtime key ${request.value ? 'stored' : 'cleared'} for account ${profile.id}`);
    return buildInstanceProfilesSnapshot(requireProfileLifecycle());
  });
  handle('instances:setEnabled', async payload => {
    const request = z.object({ id: z.string().min(1).max(80), enabled: z.boolean() }).strict().parse(payload);
    return setManagedInstanceProfileEnabled(requireProfileLifecycle(), request.id, request.enabled);
  });
  handle('instances:remove', async payload => {
    const request = z.object({ id: z.string().min(1).max(80), confirmation: z.string().max(120) }).strict().parse(payload);
    return removeManagedInstanceProfile(requireProfileLifecycle(), request.id, request.confirmation);
  });
  handle('instances:switch', async payload => {
    const request = z.object({ id: z.string().min(1).max(80), mode: z.enum(['check', 'after-work']) }).strict().parse(payload);
    return switchManagedInstanceProfile(request.id, request.mode, requireProfileLifecycle());
  });
  handle('instances:openBrowser', async payload => {
    const { id } = z.object({ id: z.string().min(1).max(80) }).strict().parse(payload);
    return openManagedInstanceBrowser(id);
  });
  handle('instances:launchAlongside', async payload => {
    const { id } = z.object({ id: z.string().min(1).max(80) }).strict().parse(payload);
    await launchManagedInstanceRuntime(id);
    return buildInstanceProfilesSnapshot(requireProfileLifecycle());
  });
  handle('instances:copyConnectorSetup', async payload => {
    const { id } = z.object({ id: z.string().min(1).max(80) }).strict().parse(payload);
    return copyManagedConnectorSetup(id, requireProfileLifecycle());
  });
  handle('instances:refreshConnector', async () => refreshActiveInstanceConnector(requireProfileLifecycle()));
  handle('instances:drain', async payload => {
    const { action } = z.object({ action: z.enum(['start', 'cancel', 'apply-update', 'shutdown']) }).strict().parse(payload);
    const lifecycle = requireProfileLifecycle();
    if (action === 'start') await lifecycle.requestDrain();
    else if (action === 'cancel') await lifecycle.cancelDrain();
    else if (action === 'apply-update') await lifecycle.requestUpdate();
    else await lifecycle.requestShutdown();
    return buildInstanceProfilesSnapshot(lifecycle);
  });
  handle('skills:list', async () => listSkills());
  handle('skills:import', async () => {
    const chosen = await dialog.showOpenDialog({ title: 'Import a skill', properties: ['openFile'],
      filters: [{ name: 'Text skills', extensions: ['md', 'txt'] }] });
    if (chosen.canceled) return null;
    if (chosen.filePaths.length !== 1) throw new Error('Choose one skill file.');
    await importSkillFile(chosen.filePaths[0]!);
    return listSkills();
  });
  handle('skills:openFolder', async () => {
    const library = await listSkills();
    if (!library.directory) throw new Error('The skills library is not ready.');
    const error = await shell.openPath(library.directory);
    if (error) throw new Error('Could not open the skills folder.');
  });
  handle('skills:remove', async payload => {
    const { id } = z.object({ id: z.string().max(64).refine(isSafeSkillId, 'Invalid skill id') }).strict().parse(payload);
    await removeSkill(id);
    return listSkills();
  });
  handle('setup:profile', async payload => {
    const request = z.discriminatedUnion('action', [
      z.object({ action: z.literal('add'), name: z.string().trim().min(1).max(80) }),
      z.object({ action: z.literal('select'), id: z.string().min(1).max(64) }),
      z.object({ action: z.literal('remove'), id: z.string().min(1).max(64) })
    ]).parse(payload);
    await updateConfig(config => request.action === 'add'
      ? addSetupProfile(config, request.name)
      : request.action === 'remove' ? removeSetupProfile(config, request.id) : switchSetupProfile(config, request.id),
    async () => {
      // The committed profile owns the connection even if credential cleanup fails.
      try { if (request.action === 'remove') await setSecret(setupApiKeySlot(request.id), ''); }
      finally { await applySettings(); }
    });
    return buildState();
  });
  registerPluginIpc(handle, getWindow);
  handle('usage:get', () => usageOverview());
  handle('state:get', async () => {
    const state = await buildState(true);
    // Native package smoke uses this as the end-to-end renderer readiness barrier. Unlike
    // `did-finish-load`, it can only happen after the renderer's first IPC request has completed
    // secure-storage availability/decryption probes and the rest of the initial state snapshot.
    logInfo('renderer state ready');
    return state;
  });

  handle('settings:save', async (payload) => {
    return saveSettings(payload);
  });
  const saveSettings = async (payload: unknown, expectedProfileId?: string) => {
    const request = settingsSave.parse(payload);
    const before = getConfig();
    let signOutEmergencySettingTransition: boolean | null = null;
    let signOutEmergencyDisableIncidentId: string | null = null;
    const next = await updateConfig(async config => {
      if (expectedProfileId && getActiveInstanceRuntime().profile.id !== expectedProfileId)
        throw new SettingsControlError('Settings account changed before publication; no settings were saved.');
      if (expectedProfileId && JSON.stringify(settingsPatch.parse(config)) !== JSON.stringify(request.base))
        throw new SettingsControlError('Settings changed before publication; inspect the new revision before retrying.');
      const proposed = { ...config, ...mergeSettings(config, request.base, request.patch) };
      // If an earlier Off retirement failed, On must retry it before admission.
      if (!config.ui.finishTool && proposed.ui.finishTool) await cancelFinishInputs(false);
      else if (!config.goal.impulseMinutes && (proposed.goal.impulseMinutes ?? 0) > 0) await cancelFinishInputs(true);
      return proposed;
    }, async (published, previous) => {
      if ((previous.ui.keepAwake !== false) !== (published.ui.keepAwake !== false)) refreshKeepAwake();
      if (previous.ui.signOutEmergencyAlerts !== published.ui.signOutEmergencyAlerts) {
        signOutEmergencySettingTransition = published.ui.signOutEmergencyAlerts === true;
        if (signOutEmergencySettingTransition === false) {
          signOutEmergencyDisableIncidentId = published.noticeState?.signOutEmergency?.id ?? null;
        }
      }
      const recordingTurnedOff = previous.sessions.record && !published.sessions.record;
      // Recording is a runtime prerequisite, not the owner of per-chat Goal intent. Config
      // normalization may turn the global Goal bit off as a consequence of Recording Off; only a
      // renderer edit that actually moved the Goal master to Off is allowed to discharge reply debt
      // and clear per-chat overrides. This distinction keeps Recording Off reversible.
      const goalMasterExplicitlyTurnedOff = previous.goal.enabled && !published.goal.enabled &&
        request.base.goal.enabled !== request.patch.goal.enabled && request.patch.goal.enabled === false;
      // A published Goal/provider setting and the attempt it invalidates must become one visible
      // transition. Run the synchronous revocation before any fallible/awaited post-publish effect,
      // otherwise Bridge can observe the new provider while the old draft is still sendable.
      if (
        recordingTurnedOff ||
        previous.goal.enabled !== published.goal.enabled ||
        previous.goal.mode !== published.goal.mode ||
        previous.goal.model !== published.goal.model ||
        previous.goal.backend !== published.goal.backend ||
        previous.goal.loopBackend !== published.goal.loopBackend ||
        previous.goal.continuationPolicy !== published.goal.continuationPolicy ||
        previous.goal.helperModel !== published.goal.helperModel || previous.goal.helperReasoning !== published.goal.helperReasoning ||
        previous.goal.provider.kind !== published.goal.provider.kind ||
        previous.goal.provider.baseUrl !== published.goal.provider.baseUrl ||
        previous.goal.reasoning !== published.goal.reasoning ||
        previous.goal.prompt !== published.goal.prompt ||
        previous.goal.objectivePrompt !== published.goal.objectivePrompt ||
        previous.goal.loopPrompt !== published.goal.loopPrompt
      ) {
        retireGoalDrafts(goalMasterExplicitlyTurnedOff);
      }
      if (goalMasterExplicitlyTurnedOff) clearAllGoalSwitches();
      if (previous.goal.continuationPolicy !== published.goal.continuationPolicy)
        logInfo(`goal: Loop continuation policy changed to ${published.goal.continuationPolicy ?? 'strict'}; existing result evidence was not changed`);
      if (previous.ui.finishTool && !published.ui.finishTool) await cancelFinishInputs(false);
      else if ((previous.goal.impulseMinutes ?? 0) > 0 && !published.goal.impulseMinutes) await cancelFinishInputs(true);
    });
    if (signOutEmergencySettingTransition !== null) {
      if (signOutEmergencySettingTransition) await reconcileBrowserAuthEmergencyPolicy();
      else await retireSignOutEmergencyIncidentAfterExplicitDisable(signOutEmergencyDisableIncidentId);
    }
    // Renderer palette changes are immediate, so keep OS/Electron-owned chrome in lock-step too.
    // Without this, selecting Dark on macOS left the title bar, menus and file picker in the
    // system theme until restart (and startup still defaulted to system before index.ts applies it).
    nativeTheme.themeSource = next.ui.theme;
    if (process.platform === 'win32') getWindow()?.setTitleBarOverlay(titleBarOverlayForTheme(next.ui.theme));
    // BrowserWindow's native backing color is fixed at construction unless updated explicitly.
    // Keep it in lock-step too: the default macOS application menu exposes Reload, and after a
    // live theme switch an old opposite background otherwise flashes behind the renderer while it
    // paints again. This is also the color Electron shows during any later renderer reload/failure.
    getWindow()?.setBackgroundColor(next.ui.theme === 'dark' ? '#0e0e11' : '#ffffff');
    // Explicit settings changes replace discovery's monotonic snapshot. Otherwise
    // disabled permissions/finish/session tools remain published and no schema change
    // reaches automatic plugin refresh. Cosmetic saves must not invalidate discovery.
    if (before.multiAgent.enabled !== next.multiAgent.enabled || before.sessions.record !== next.sessions.record ||
        before.ui.finishTool !== next.ui.finishTool ||
        JSON.stringify(effectiveCapabilities(before)) !== JSON.stringify(effectiveCapabilities(next))) forgetExposedSurface();
    // Order matters, and it used to be wrong. Pausing the run and withdrawing worker browser
    // commands has to happen while the bridge can still cancel those transports; stopping the
    // bridge first left queued worker/revival commands behind for a later restart to deliver.
    let authorityPersistError: Error | null = null;
    if (!next.multiAgent.enabled) {
      // Off pauses execution; it is not the destructive Clear swarm action. Preserve every
      // prime-owned worker history so re-enable/restart can still show and revive exact chats.
      pauseSwarmForDisable();
      cancelWorkerCommands('multi-agent mode was turned off');
      try {
        if (!(await persistAgentAuthorityNow())) {
          throw new Error('Multi-agent teardown has no immediate durable persistence sink.');
        }
      } catch (error) {
        authorityPersistError = error instanceof Error ? error : new Error(String(error));
      }
    }
    // The extension bridge serves both features: recording needs it to observe the
    // chat, and multi-agent mode needs it to open worker tabs. Either one being on is
    // enough, and this must match the startup rule in index.ts exactly — a bridge that
    // runs at startup but not after a settings save is the worst of both.
    if (next.sessions.record || next.multiAgent.enabled) await startBridge();
    else await stopBridge();
    // Permissions and the second tunnel id both decide whether the optional Desktop
    // connector should be published. Without this, enabling desktop access or pasting its
    // tunnel id left the connector unpublished until the user happened to reconnect, with
    // the card still saying "not published" and nothing explaining why.
    await applySettings();
    if (before.ui.autoRefreshPlugins !== next.ui.autoRefreshPlugins) wakeBrowserWork();
    logInfo('settings updated');
    // The config and runtime side effects above still complete so the app does not stay half-on,
    // but the UI must not be told the pause was safely accepted when its retained authority
    // snapshot failed to cross disk. Startup with the feature off restores and canonicalizes
    // that same history instead of deleting it.
    // Login registration is an independent OS preference. Cosmetic saves do not rewrite
    // it, and its failure cannot interrupt permission publication or Goal/worker teardown.
    let loginStartupError: unknown;
    if ((before.ui.startAtLogin === true) !== (next.ui.startAtLogin === true)) {
      try { applyLoginStartup(app, next.ui.startAtLogin === true); }
      catch (error) { loginStartupError = error; }
    }
    if (authorityPersistError) throw authorityPersistError;
    if (loginStartupError) throw loginStartupError;
    return buildState();
  };
  configureSettingsControl({ schema: settingsPatch, save: saveSettings });
  void pruneOperatorControlResponses(app.getPath('userData')).catch(() => {
    logInfo('Background control response cleanup failed at startup; check the account operator inbox.');
  });

  /**
   * Approves one or more folders in one config transaction.
   *
   * Validation deliberately happens inside updateConfig's queue and against the roots built so
   * far. A later invalid/overlapping selection therefore aborts before any earlier selection is
   * published, while selecting an already-approved exact root remains a harmless no-op.
   */
  const approveRoots = async (folderPaths: readonly string[], allowFilesystemRoot = false): Promise<AppState> => {
    const addedNames: string[] = [];
    await updateConfig(async (config) => {
      const roots = [...config.roots];
      for (const folderPath of folderPaths) {
        const selectedIdentity = nativePathIdentity(folderPath);
        const exactIndex = roots.findIndex(root => nativePathIdentity(root.path) === selectedIdentity);
        const validationRoots = exactIndex < 0 ? roots : roots.filter((_, index) => index !== exactIndex);
        const real = await validateNewRoot(folderPath, validationRoots, { allowFilesystemRoot });
        if (roots.some(root => nativePathIdentity(root.path) === nativePathIdentity(real))) continue;
        const name = uniqueRootName(real, roots);
        roots.push({ name, path: real });
        addedNames.push(name);
      }
      return addedNames.length === 0 ? config : { ...config, roots };
    });
    logInfo(addedNames.length === 0
      ? 'workspace folder approval completed; every selected folder was already approved'
      : `approved ${addedNames.length} workspace folder(s) in one transaction: ${addedNames.map(name => `/${name}`).join(', ')}`);
    return buildState();
  };

  /** Approves one folder by path. The picker dialog and the drop zone both end here. */
  const isFilesystemRoot = (folderPath: string): boolean =>
    nativePathIdentity(path.parse(path.resolve(folderPath)).root) === nativePathIdentity(folderPath);

  const confirmBroadAccess = async (folderPaths: readonly string[]): Promise<boolean> => {
    const window = getWindow();
    if (!window) throw new Error('Open this account window to approve drive access.');
    const confirmation = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Approve whole-drive access',
      message: 'Share these whole drives with ChatGPT?',
      detail: `${folderPaths.map(folder => `• ${folder}`).join('\n')}\n\nFile tools can read these drives and edit ordinary files. Structured file edits refuse protected operating-system locations. Terminal commands and external plugins still run with your OS user permissions; this is not an OS sandbox.`,
      buttons: ['Share drives', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
    });
    return confirmation.response === 0;
  };

  const approveRoot = async (folderPath: string): Promise<AppState> => {
    const broad = isFilesystemRoot(folderPath);
    if (broad && !await confirmBroadAccess([folderPath])) return buildState();
    return approveRoots([folderPath], broad);
  };

  handle('roots:shared', async (payload) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(payload);
    if (process.argv.some(argument => argument.startsWith('--cos-instance-runtime='))) {
      throw new Error('Manage shared folders in the primary account window.');
    }
    if (enabled && getConfig().instances?.sharedFolderAccess?.enabled !== true) {
      const window = getWindow();
      if (!window) throw new Error('Open the primary account window to approve shared access.');
      if (getConfig().roots.length === 0) throw new Error('Add a folder before sharing access across accounts.');
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Share folders across accounts',
        message: 'Give current and future accounts on this computer the same folder access?',
        detail: `${getConfig().roots.map(root => `• ${root.path}`).join('\n')}\n\nThe primary account becomes the single folder editor. Folder additions and removals apply to all local accounts. Other computers keep their own paths; credentials and account settings remain separate.`,
        buttons: ['Share across accounts', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
      });
      if (confirmation.response !== 0) return buildState();
    }
    await setSharedFolderAccess(enabled);
    return buildState();
  });

  handle('roots:add', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Approve a folder for ChatGPT',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return buildState();
    return approveRoot(result.filePaths[0]);
  });

  handle('roots:addWorkspaceFolders', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose workspace folders for ChatGPT',
      buttonLabel: 'Select folders',
      properties: ['openDirectory', 'multiSelections']
    });
    if (result.canceled || result.filePaths.length === 0) return buildState();
    const confirmation = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Approve workspace folders',
      message: 'Share these exact folders with ChatGPT?',
      detail: result.filePaths.map(folderPath => `• ${folderPath}`).join('\n'),
      buttons: ['Share folders', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    if (confirmation.response !== 0) return buildState();
    const broad = result.filePaths.filter(isFilesystemRoot);
    if (broad.length > 0 && !await confirmBroadAccess(broad)) return buildState();
    return approveRoots(result.filePaths, broad.length > 0);
  });

  handle('projects:list', () => listProjects());
  handle('projects:remove', async (payload) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(payload);
    const project = await removeProject(id);
    push('session:changed');
    return project;
  });
  handle('projects:add', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, { title: 'Choose a project folder for ChatGPT', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const folder = result.filePaths[0];
    try { await resolvePath(getConfig().roots, folder); }
    catch (error) {
      if (!(error instanceof SandboxError)) throw error;
      const state = await approveRoot(folder);
      push('state:changed', state);
    }
    const project = await addProject(folder);
    push('session:changed');
    if (project.chatgpt?.state === 'requested') wakeBrowserWork();
    return project;
  });
  handle('projects:chatgpt-retry', async payload => {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(payload);
    const project = await retryProjectCreate(id);
    if (project) wakeBrowserWork();
    push('session:changed');
    return project;
  });

  // A folder dropped onto the Folders card. The renderer never sees a system path itself:
  // the preload turns the dropped File into one, and the same validation the dialog goes
  // through decides whether it is a folder this app may approve at all.
  handle('roots:addPath', async (payload) => {
    const { path: folderPath } = z.object({ path: z.string().min(1).max(4096) }).parse(payload);
    return approveRoot(folderPath);
  });

  handle('roots:remove', async (payload) => {
    const { name } = z.object({ name: z.string().min(1).max(32) }).parse(payload);
    await updateConfig((config) => {
      if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
      return {
        ...config,
        roots: config.roots.filter((r) => r.name !== name)
      };
    });
    forgetWorkspaceRoot(name);
    logInfo(`removed folder /${name}`);
    return buildState();
  });

  handle('roots:rename', async (payload) => {
    const { name, newName } = renameRoot.parse(payload);
    if (RESERVED_ROOT_NAMES.has(newName)) {
      throw new SandboxError(`/${newName} is reserved by Chat On Steroids and cannot be used as a folder name`);
    }
    await updateConfig((config) => {
      if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
      if (config.roots.some((r) => r.name !== name && r.name === newName)) {
        throw new Error(`/${newName} is already used`);
      }
      return {
        ...config,
        roots: config.roots.map((r) => (r.name === name ? { ...r, name: newName } : r))
      };
    });
    renameWorkspaceRoot(name, newName);
    return buildState();
  });

  /**
   * Stores one of the defined provider keys by name.
   *
   * The name is an enum rather than a string, so the renderer can choose *which* credential
   * it is writing but cannot name a slot nobody defined — and the value still only ever
   * travels inwards. Nothing reads a key back out over IPC; the state carries a boolean.
   */
  handle('secret:set', async (payload) => {
    const { value, key, profileId } = z
      .object({
        value: z.string().max(500),
        profileId: z.string().min(1).max(64).optional(),
        key: z.enum(['openaiApiKey', 'openRouterApiKey', 'customProviderApiKey']).default('openaiApiKey')
      })
      .parse(payload);
    if (!(await isEncryptionAvailable())) {
      throw new Error('Secure OS credential storage is unavailable, so the key cannot be stored safely.');
    }
    const owner = profileId ?? 'default';
    const config = getConfig();
    if (key === 'openaiApiKey' && owner !== (config.tunnel.profileId ?? 'default') &&
        !config.setupProfiles?.some(profile => profile.id === owner)) throw new Error('Setup profile not found');
    const activeProfile = getActiveInstanceRuntime().profile;
    await setSecret(key === 'openaiApiKey'
      ? setupApiKeySlot(owner)
      : profileProviderSecretSlot(activeProfile.state.mode, activeProfile.id, key), value);
    const activeGoalKey = getConfig().goal.provider.kind === 'custom' ? 'customProviderApiKey' : 'openRouterApiKey';
    if (key === activeGoalKey) retireGoalDrafts();
    const what = key === 'openRouterApiKey' ? 'openrouter key' : key === 'customProviderApiKey' ? 'custom provider key' : 'api key';
    logInfo(value.trim() === '' ? `${what} cleared` : `${what} stored`);
    return buildState();
  });

  /**
   * The OpenRouter catalogue, newest first, one page at a time.
   *
   * Fetched here rather than in the renderer for the same reason every other network call
   * is: the key that authorises it never crosses this boundary. The page size is the
   * module's own, so the renderer cannot ask for the whole catalogue in one call.
   */
  handle('goal:models', async (payload) => {
    const { offset } = z.object({ offset: z.number().int().min(0).max(2000).default(0) }).parse(payload ?? {});
    return listGoalModels(offset, MODEL_PAGE_SIZE);
  });

  handle('binary:pick', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Select the tunnel executable',
      properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: 'Programs', extensions: ['exe'] }] } : {})
    });
    if (result.canceled || !result.filePaths[0]) return buildState();
    await updateConfig((config) => ({
      ...config,
      tunnel: { ...config.tunnel, binaryPath: result.filePaths[0]! }
    }));
    // This is a Core transport setting just like changing the method/tunnel id in the form.
    // Apply it immediately when connected rather than saving a path the running child never
    // uses until some unrelated future reconnect.
    await applySettings();
    return buildState();
  });

  handle('connection:connect', async () => {
    await connect();
    return buildState();
  });

  handle('connection:disconnect', async () => {
    // The primary Disconnect control is the user's whole-account boundary, not merely a
    // tunnel pause. Stop new Core work synchronously, revoke the browser companion through
    // its durable app/browser handshake, then finish draining already accepted responses.
    const stopping = disconnect();
    await unpair();
    await stopping;
    return buildState();
  });

  handle('diagnostics:run', async () => runDiagnostics());
  // Share concurrent button presses; every subsequent collection reads fresh evidence.
  let supportReportFlight: ReturnType<typeof collectSupportReport> | null = null;
  handle('support-report:collect', () => {
    if (!supportReportFlight) {
      supportReportFlight = collectSupportReport({ lifecycle: () => profileLifecycle?.getStatus() ?? null })
        .finally(() => { supportReportFlight = null; });
    }
    return supportReportFlight;
  });
  handle('composer-drafts:load', () => loadComposerDrafts());
  handle('composer-drafts:save', payload => saveComposerDrafts(composerDraftSaveSchema.parse(payload)));
  handle('desktop:requestAccessibility', async () => {
    await refreshMacOSDesktopAccess({ promptAccessibility: true });
    return buildState();
  });

  handle('log:get', async () => getLog());
  handle('log:text', async () => formatLogForClipboard());
  handle('log:json', async () => formatLogAsJson());
  handle('clipboard:write', async (payload) => {
    const { text } = z.object({ text: z.string().max(1_000_000) }).parse(payload);
    await clipboard.writeText(text);
    return true;
  });

  // The Install button. The renderer decides nothing about what is installed - it cannot
  // name a file, a version or a path - it only says "now", and only a staged, digest-checked
  // artifact makes that mean anything. The quit is what applies it, at the end of the same
  // shutdown sequence every other quit runs; refusing here is how a press with nothing staged
  // avoids closing the app for no reason.
  handle('update:install', async () => {
    // Installation is a lifecycle transition, never a direct quit. The production coordinator
    // gates new work, lets accepted work settle, flushes source-owned stores, and only then marks
    // the verified artifact for install. A lifecycle-less caller must fail closed rather than
    // bypassing that drain boundary.
    const lifecycle = requireProfileLifecycle();
    await lifecycle.requestUpdate();
    // Return the lifecycle projection from the same serialized transition. The old boolean made
    // the renderer wait for an unrelated bridge/session event before it could show that the
    // update was safely queued, even though main had already fenced new work.
    return buildInstanceProfilesSnapshot(lifecycle);
  });
  handle('update:refresh', async () => {
    await checkForUpdates();
    return updateStatus();
  });

  handle('link:open', async (payload) => {
    const { url } = z.object({ url: z.string().max(8192) }).parse(payload);
    if (!ALLOWED_LINKS.has(url) && !safeExternalLink(url)) throw new Error('That link is not allowed');
    await shell.openExternal(url);
    return true;
  });

  // ------------------------------------------------------------- sessions

  handle('sessions:list', async (payload) => {
    const { cursor, limit } = z
      .object({
        cursor: z
          .object({
            updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i)
          })
          .optional(),
        // Keep one renderer payload small even when the store can index much more history.
        limit: z.number().int().min(1).max(60).optional()
      })
      .parse(payload ?? {});
    const config = getConfig();
    await listInputs(); // Restore exact helper origins before the first sidebar page.
    const page = await listSessionPage({ cursor, limit: limit ?? 60 });
    // Older recordings omitted worker origins' parent IDs. The broker's exact
    // retained owner can repair that presentation without reviving a worker or
    // guessing from reusable names such as worker-1.
    const parents = new Map<string, ReturnType<typeof findSessionByConversation>>();
    const sessions = await Promise.all(page.sessions.map(async (summary) => {
      if (!summary.conversationId) return summary;
      const owner = agentInfoForOwnedConversation(summary.conversationId);
      const retainedWorker = owner?.role === 'worker';
      if (summary.origin?.kind !== 'worker' && !retainedWorker) return summary;
      const workerOrigin = summary.origin?.kind === 'worker'
        ? summary.origin
        : { kind: 'worker' as const, fromSessionId: null, agentId: owner?.id ?? null, task: owner?.task ?? '' };
      const prime = owner?.primeConversationId ?? primeForOwnedConversation(summary.conversationId);
      let parentId = workerOrigin.fromSessionId;
      let parent = null;
      if (prime && prime !== summary.conversationId) {
        if (!parents.has(prime)) parents.set(prime, findSessionByConversation(prime, { requireUnique: true }));
        parent = await parents.get(prime) ?? null;
        if (parent && parent.id !== summary.id) parentId = parent.id;
      }
      const origin = { ...workerOrigin, fromSessionId: parentId };
      const genericTitle = summary.titleSource !== 'manual' && isGenericAutomaticSessionTitle(summary.title);
      const expectedTitle = originTitle(origin, parent?.title ?? null);
      // Old worker rows can survive a restart with only the broker's exact retained ownership.
      // Repair that durable session through the normal origin owner instead of returning a
      // renderer-only alias that falls back to "ChatGPT session" on the next process start.
      if (retainedWorker && parentId && (summary.origin?.kind !== 'worker' ||
          summary.origin.fromSessionId !== parentId ||
          (summary.titleSource !== 'manual' && summary.title !== expectedTitle))) {
        await noteChatOrigin(summary.conversationId, origin);
        const repaired = await getSession(summary.id);
        if (repaired) return repaired;
      }
      return {
        ...summary,
        origin,
        ...(genericTitle ? { title: expectedTitle } : {})
      };
    }));
    const automation = await automationSupervisorSnapshot(await indexedSessions());
    let alarmAutomation = null;
    try {
      alarmAutomation = await fleetAlarmAutomationSnapshot(automation);
    } catch (error) {
      logInfo(`fleet automation alarm snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      sessions: sessions.map(summary => {
        const activityExpiresAt = sessionActivityExpiresAt(summary);
        return activityExpiresAt === undefined ? summary : { ...summary, activityExpiresAt };
      }),
      workerProgress: sessions.flatMap(summary =>
        summary.conversationId && summary.origin?.kind !== 'worker' && summary.origin?.kind !== 'helper'
          ? [{ id: summary.id, ...workerLifecycleForConversation(summary.conversationId) }]
          : []),
      total: page.total,
      deleted: await deletedSessionCount(),
      alarmAutomation,
      nextCursor: page.nextCursor,
      activeId: activeSessionId(),
      // Live policy, not session history: a block is keyed by ChatGPT conversation and does
      // not belong in any session's meta.json. It rides the list for the same reason
      // `activeId` and `pressure` do — one paint, one round trip.
      blocked: blockedChatIds(),
      automation,
      pressure: sessions.map((summary) => ({
        id: summary.id,
        // Pressure belongs to the currently attached ChatGPT context. `estimatedTokens` is
        // deliberately lifetime history and therefore never resets across Compact & Resume;
        // using it here made a fresh B look fuller than the A it had just replaced.
        ...tokenPressure(summary.contextTokens, config.sessions.advisoryTokens, config.sessions.limitTokens)
      }))
    };
  });

  handle('sessions:image', async (payload) => {
    const { id, assetId } = z.object({ id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i), assetId: z.string().max(100).regex(/^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/) }).parse(payload);
    return recordedInputImage(id, assetId);
  });
  handle('sessions:rename', async (payload) => {
    const { id, title } = sessionIdArg.extend({ title: z.string().trim().min(1).max(120) }).parse(payload);
    if (!(await getSession(id))) throw new Error('Session not found');
    await renameSession(id, title, 'manual');
    logInfo(`session ${id} nickname changed to ${JSON.stringify(title)}`);
    push('session:changed');
    return true;
  });
  handle('sessions:search', async (payload) => {
    const { query } = z.object({ query: z.string().max(200) }).parse(payload);
    return searchRecordedSessions(query);
  });
  handle('sessions:locateMatch', async (payload) => {
    const { id, query } = sessionIdArg.extend({ query: z.string().max(200) }).parse(payload);
    return locateRecordedSearchMatch(id, query);
  });
  handle('sessions:workerLimit', async (payload) => {
    const { id, workerLimit } = sessionIdArg.extend({
      workerLimit: z.number().int().min(1).max(MAX_MULTI_AGENT_WORKERS).nullable()
    }).parse(payload);
    const summary = await getSession(id);
    if (!summary) throw new Error('Session not found');
    if (!summary.conversationId || summary.origin?.kind === 'worker' || summary.origin?.kind === 'helper') {
      throw new Error('Only a normal ChatGPT conversation can own sub-agent workers');
    }
    const globalLimit = getConfig().multiAgent.maxWorkers;
    await setSessionWorkerLimit(id, workerLimit);
    const liveChanged = setPrimeWorkerLimit(summary.conversationId, workerLimit);
    if (liveChanged && !(await persistCriticalSwarmNow())) {
      throw new Error('The chat limit was saved, but the live worker broker could not persist it; restart Chat On Steroids before spawning more workers');
    }
    logInfo(`session ${id} sub-agent limit changed to ${workerLimit ?? `global (${globalLimit})`}`);
    push('session:changed');
    const updated = await getSession(id);
    if (!updated) throw new Error('Session disappeared after saving its worker limit');
    return updated;
  });
  /** Provider failures stay durable on disk but occupy one renderer row and one IPC slot. */
  const collapseTimelineErrors = (source: SessionEvent[]): SessionEvent[] => {
    const latest = source.findLast(event => event.kind === 'chat_error')?.seq;
    return source.filter(event => event.kind !== 'chat_error' || event.seq === latest);
  };
  handle('sessions:events', async (payload) => {
    const { id, from, before, limit } = z
      .object({
        id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        from: z.number().int().min(0).max(10_000_000).optional(),
        before: z.number().int().min(1).max(10_000_000).optional(),
        limit: z.number().int().min(1).max(1000).optional()
      })
      .parse(payload);
    const summary = await getSession(id);
    if (!summary) throw new Error('Session not found');
    // The renderer draws a timeline, not the whole log: the tail is what matters and
    // the rest stays one click away rather than being pushed over IPC every refresh.
    // The renderer never paints more than 160 rows. Sending nearly twice that on every first
    // load was pure cloning/IPC work; later refreshes use the sequence cursor below.
    const cap = limit ?? 160;
    // Scan through a bounded number of raw pages until the renderer has real conversation rows.
    // Otherwise a rate-limit storm can fill the whole 160-record window with errors and make it
    // look as if the user's messages disappeared. Eight pages bounds disk/IPC work even against
    // a corrupted or exceptionally noisy recording.
    if (from === undefined) {
      let cursor = before;
      let raw: SessionEvent[] = [];
      for (let page = 0; page < 8; page++) {
        const batch = await readRecentEvents(id, cap, { before: cursor });
        raw = [...batch, ...raw];
        if (collapseTimelineErrors(raw).length >= cap || batch.length < cap) break;
        const oldest = batch.reduce((value, event) => Math.min(value, event.seq), Number.POSITIVE_INFINITY);
        if (!Number.isFinite(oldest) || oldest <= 1) break;
        cursor = oldest;
      }
      const nextFrom = raw.reduce((cursorValue, event) => Math.max(cursorValue, event.seq + 1), 0);
      const events = collapseTimelineErrors(raw).slice(-cap);
      return { summary, events, total: summary.events, nextFrom };
    }
    let cursor = from;
    let raw: SessionEvent[] = [];
    for (let page = 0; page < 8; page++) {
      const batch = await readEvents(id, { from: cursor, limit: cap });
      raw.push(...batch);
      cursor = batch.reduce((cursorValue, event) => Math.max(cursorValue, event.seq + 1), cursor);
      if (collapseTimelineErrors(raw).length >= cap || batch.length < cap) break;
    }
    const events = collapseTimelineErrors(raw).slice(0, cap);
    return { summary, events, total: summary.events, nextFrom: cursor };
  });

  const stageFiles = async (sources: AttachmentSource[]) => {
    const retained = new Set((await listInputs()).filter(row => !['sent', 'failed', 'cancelled'].includes(row.state)).flatMap(row => row.attachments?.map(file => file.id) ?? []));
    // Draft custody survives a renderer restart and the staging retention window.
    // A damaged draft store must stop pruning rather than silently discard its files.
    for (const id of await retainedComposerAttachmentIds()) retained.add(id);
    const result = [];
    for (const source of sources) result.push(await stageInputAttachment(source, retained));
    return result;
  };
  handle('sessions:files', async () => {
    const chosen = await dialog.showOpenDialog({ title: 'Attach files', properties: ['openFile', 'multiSelections'] });
    if (chosen.canceled) return [];
    if (chosen.filePaths.length > 20) throw new Error('Attach up to 20 files per message');
    return stageFiles(chosen.filePaths);
  });
  handle('sessions:dropFiles', async payload => {
    const { files } = z.object({ files: z.array(z.union([
      z.string().min(1).max(32768),
      z.object({ name: z.string().min(1).max(255), bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= 12 * 1024 * 1024) }).strict()
    ])).min(1).max(20) }).strict().parse(payload);
    return stageFiles(files);
  });
  handle('sessions:attachText', async payload => {
    const { text } = z.object({ text: z.string().min(1).max(4 * 1024 * 1024) }).parse(payload);
    return (await stageFiles([{ text }]))[0]!;
  });
  handle('sessions:stopTurn', async payload => {
    const { id, expectedTurnId } = sessionIdArg.extend({ expectedTurnId: z.string().min(1).max(256) }).parse(payload);
    return stopSessionTurn(id, expectedTurnId);
  });
  handle('sessions:releaseFinish', async (payload) => {
    const { id, expectedTurnId } = sessionIdArg.extend({ expectedTurnId: z.string().min(1).max(256) }).parse(payload);
    await sessionControlsFor(id);
    await releaseSessionFinish(id, expectedTurnId);
    return sessionControlsFor(id);
  });
  handle('sessions:generateFinishGoal', async payload => {
    const { id, expectedTurnId } = sessionIdArg.extend({ expectedTurnId: z.string().min(1).max(256) }).parse(payload);
    return requestSessionFinishGoal(id, expectedTurnId);
  });
  handle('chatModels:get', async () => getChatModels());
  handle('browser:preferences', async (payload) => requestBrowserPreferences(payload));
  handle('chatModels:request', async () => startChatModelDiscovery());
  handle('sessions:controls', async (payload) => sessionControlsFor(sessionIdArg.parse(payload).id));
  // This channel is reached only by the toolbar's explicit Resume all action. Unlike
  // reconnect/lane recovery, that user action is allowed to release a durable global pause.
  handle('sessions:resumeAutomation', async () => resumeAutomationAfterExplicitRequest('user selected Resume all'));
  handle('sessions:resumeAutomationOne', async payload => {
    const { id } = sessionIdArg.parse(payload);
    if (getConfig().ui.automationPaused === true) return resumeAutomationChats({
      sessionId: id,
      trigger: 'user selected Resume for this exact chat while global automation is paused'
    });
    const paused = (await pausedBrowserHelpers()).filter(helper => helper.sourceSessionId === id);
    const exact = paused.at(-1);
    if (exact) await retryGoalBrowserHelper(id, exact.id);
    return resumeAutomationChats({ sessionId: id, trigger: 'user selected Resume for this exact chat' });
  });
  handle('sessions:recoverStaleAutomation', async () => recoverStaleAutomationChats());
  handle('sessions:automationProfile', async payload => {
    const { profile } = z.object({ profile: z.enum(['day', 'overnight', 'rotation']) }).parse(payload);
    const before = getConfig().ui.automationProfile ?? 'day';
    if (before !== profile) {
      await updateConfig(config => ({ ...config, ui: { ...config.ui, automationProfile: profile } }));
      logInfo(`automation profile changed from ${before} to ${profile}`);
    }
    if (getConfig().ui.automationPaused !== true) {
      await maintainLoopLanes();
      if (profile === 'overnight') await recoverStaleAutomationChats(Date.now(), 'overnight');
      else await resumeAutomationChats({ mode: 'loop', trigger: `${profile} profile selected` });
    }
    const state = await buildState();
    push('state:changed', state);
    push('session:changed');
    return state;
  });
  handle('sessions:automationPause', async payload => {
    const { paused } = z.object({ paused: z.boolean() }).parse(payload);
    const before = getConfig().ui.automationPaused === true;
    if (paused && before !== paused) {
      await updateConfig(config => ({ ...config, ui: { ...config.ui, automationPaused: paused } }));
      applyAutomationPause(paused);
    }
    if (!paused) await resumeAutomationAfterExplicitRequest('user resumed global automation');
    const state = await buildState();
    push('state:changed', state);
    // The sidebar owns an automationSupervisor snapshot per session. A state-only
    // refresh updates the toolbar but leaves those cached row projections stale.
    push('session:changed');
    return state;
  });
  handle('sessions:freshCopyAutomation', async () => freshCopyAutomationChats());
  handle('sessions:sidebarFolders', async () => listSidebarFolders());
  const sidebarMembers = z.array(z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i)).min(1).max(200);
  const existingSidebarMembers = async (ids: string[]) => {
    const checked = await Promise.all(ids.map(async id => ({ id, exists: Boolean(await getSession(id)) })));
    const existing = checked.filter(row => row.exists).map(row => row.id);
    if (!existing.length) throw new Error('None of the selected conversations still exist');
    return existing;
  };
  handle('sessions:createSidebarFolder', async payload => {
    const { name, sessionIds } = z.object({ name: z.string().trim().min(1).max(60), sessionIds: sidebarMembers }).parse(payload);
    const folders = await createSidebarFolder(name, await existingSidebarMembers(sessionIds));
    push('session:changed');
    return folders;
  });
  handle('sessions:assignSidebarFolder', async payload => {
    const { folderId, sessionIds } = z.object({ folderId: z.string().uuid().nullable(), sessionIds: sidebarMembers }).parse(payload);
    const folders = await assignSidebarFolder(folderId, await existingSidebarMembers(sessionIds));
    push('session:changed');
    return folders;
  });
  handle('sessions:renameSidebarFolder', async payload => {
    const { folderId, name } = z.object({ folderId: z.string().uuid(), name: z.string().trim().min(1).max(60) }).parse(payload);
    const folders = await renameSidebarFolder(folderId, name);
    push('session:changed');
    return folders;
  });
  handle('sessions:deleteSidebarFolder', async payload => {
    const { folderId } = z.object({ folderId: z.string().uuid() }).parse(payload);
    const folders = await deleteSidebarFolder(folderId);
    push('session:changed');
    return folders;
  });
  handle('sessions:automation', async (payload) => {
    const { id, automation, afterTurn } = sessionIdArg.extend({ automation: z.enum(['off', 'goal', 'loop']), afterTurn: z.boolean().optional() }).parse(payload);
    return setSessionAutomation(id, automation, afterTurn);
  });
  handle('sessions:objective', async (payload) => {
    const { id, text, mode } = sessionIdArg.extend({ text: z.string().max(MAX_AUTOMATION_OBJECTIVE_CHARS), mode: z.enum(['goal', 'loop']) }).parse(payload);
    return setSessionObjective(id, text, mode);
  });
  handle('sessions:automationMany', async (payload) => {
    const { ids, automation, text } = z.object({
      ids: z.array(z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i)).min(1).max(200),
      automation: z.enum(['off', 'goal', 'loop']),
      text: z.string().max(MAX_AUTOMATION_OBJECTIVE_CHARS).optional()
    }).parse(payload);
    const result = await setSessionsAutomation(ids, automation, text);
    logInfo(`batch automation: ${automation === 'off' ? 'removed Goal/Loop from' : `applied ${automation} to`} ${result.updated} chat(s)`);
    return result;
  });
  handle('sessions:automationPauseMany', async (payload) => {
    const { ids, paused } = z.object({
      ids: z.array(z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i)).min(1).max(200),
      paused: z.boolean()
    }).parse(payload);
    return setSessionsAutomationPaused(ids, paused);
  });
  handle('sessions:rotationMembership', async (payload) => {
    const { ids, enrolled } = z.object({
      ids: z.array(z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i)).min(1).max(200),
      enrolled: z.boolean()
    }).parse(payload);
    return setSessionsRotationMembership(ids, enrolled);
  });
  handle('sessions:compact', async (payload) => {
    if (getConfig().ui.automationPaused === true)
      throw new Error('ChatGPT automation is paused. Resume it before starting Compact & Resume.');
    return compactSession(sessionIdArg.parse(payload).id);
  });
  handle('sessions:cancelCompaction', async payload => {
    const { id, expectedToken } = sessionIdArg.extend({
      expectedToken: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)
    }).strict().parse(payload);
    return cancelSessionCompaction(id, expectedToken);
  });
  handle('sessions:plan', async (payload) => {
    const { text, backend, requestId } = z.object({ text: z.string().trim().min(1).max(16000), backend: z.enum(['api', 'chatgpt']), requestId: z.string().uuid().optional() }).parse(payload);
    const publish = (progress: import('../shared/task-progress.js').TaskProgressUpdate) => {
      const target = getWindow();
      if (requestId && target && !target.isDestroyed()) target.webContents.send('task:progress', { requestId, ...progress });
    };
    return runTaskRequest(requestId ?? randomUUID(), JSON.stringify(['plan', text, backend]), signal => draftTaskPlan(text, backend, publish, signal), publish);
  });
  handle('sessions:send', async (payload) => {
    const input = inputArgs.parse(payload);
    await validateInputImages(input.images ?? []);
    return sendDesktopInput(input);
  });
  handle('sessions:outbox', async () => (await listInputs()).filter((row) => row.purpose !== 'decision'));
  handle('sessions:helperCustody', async payload => {
    const { id } = sessionIdArg.parse(payload);
    const session = await getSession(id);
    return session?.conversationId ? sessionDecisionHelperCustody(id, session.conversationId) : null;
  });
  handle('sessions:reorderInputs', async (payload) => {
    const { sessionId, ids } = z.object({ sessionId: z.string().min(8).max(64), ids: z.array(z.string().uuid()).min(1).max(10000) }).parse(payload);
    return reorderQueuedInputs(sessionId, ids);
  });
  handle('sessions:retryBrowser', async (payload) => retryQueuedInputBrowser(z.object({ id: z.string().uuid() }).parse(payload).id));
  handle('sessions:pausedHelpers', async () => pausedBrowserHelpers());
  handle('sessions:retryHelper', async (payload) => {
    const { id, sourceSessionId } = z.object({ id: z.string().uuid(), sourceSessionId: z.string().min(8).max(64) }).parse(payload);
    return retryGoalBrowserHelper(sourceSessionId, id);
  });
  handle('sessions:retryPausedHelpers', async () => {
    // Retire every ambiguous helper fence first. Resume then rearms the exact durable source
    // obligations and opens those existing chats; there is never one replay per warning row.
    const helpers = await retryPausedGoalBrowserHelpers();
    const resume = await resumeAutomationChats();
    logInfo(`helpers: bulk restart accepted for ${helpers.restarted}/${helpers.eligible} source chat(s); ${resume.queued} automation recovery action(s) queued`);
    return { ...helpers, resume };
  });
  handle('sessions:editInput', async (payload) => { const { id, text, afterTurn } = z.object({ id: z.string().uuid(), text: inputArgs.shape.text, afterTurn: z.boolean().optional() }).parse(payload); return editQueuedInput(id, text, afterTurn); });
  handle('sessions:cancelInput', async (payload) => cancelDesktopInput(z.object({ id: z.string().uuid() }).parse(payload).id));
  handle('sessions:recheckWorkflow', async payload => {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(payload);
    const row = (await listInputs()).find(item => item.id === id);
    const { workflowNativeFinalCurrent } = await import('./session/workflow.js');
    if (!row || !await workflowNativeFinalCurrent(row)) return false;
    return (await import('./session/input.js')).recheckWorkflowInput(row);
  });
  handle('sessions:openWorkflowOutput', async payload => {
    const { id, index, action } = workflowOutputRequestSchema.parse(payload);
    return openVerifiedWorkflowOutput(id, index, action, {
      roots: () => getConfig().roots, listInputs,
      openPath: real => shell.openPath(real), showItemInFolder: real => shell.showItemInFolder(real),
      log: (category, code) => logEvent(category, code)
    });
  });
  handle('sessions:inputAutomation', async payload => {
    const { id, mode, loopAfterTurn } = z.object({ id: z.string().uuid(), mode: z.enum(['off', 'goal', 'loop']), loopAfterTurn: z.boolean().optional() }).parse(payload);
    return setInputAutomation(id, mode, loopAfterTurn);
  });
  handle('window:getZoom', async () => (getWindow()?.webContents.getZoomFactor() ?? UI_BASE_ZOOM) / UI_BASE_ZOOM);
  handle('window:zoom', async (payload) => {
    const { factor } = z.object({ factor: z.number().min(0.4).max(1.5) }).parse(payload);
    getWindow()?.webContents.setZoomFactor(factor * UI_BASE_ZOOM);
    return factor;
  });

  handle('sessions:openChat', async (payload) => {
    const ipcReceivedAt = performance.now();
    const { id, timing } = z.object({
      id: sessionIdArg.shape.id,
      timing: z.object({
        clickAt: z.number().finite().nonnegative(),
        ipcAt: z.number().finite().nonnegative()
      }).refine(value => value.ipcAt >= value.clickAt).optional()
    }).parse(payload);
    const summary = await getSession(id);
    const conversationId = summary?.conversationId;
    if (!conversationId || !/^[0-9a-z-]{8,64}$/i.test(conversationId)) {
      throw new Error('This session has no valid ChatGPT conversation');
    }
    // Only the companion has enough Chrome tab state to decide whether this exact conversation
    // already exists. Waiting for its receipt prevents a slow inventory from racing an OS-level
    // browser launch into a duplicate tab.
    return requestBrowserConversationOpen(conversationId, {
      renderer: timing ?? null,
      ipcReceivedAt
    });
  });

  /**
   * Blocks or releases the ChatGPT conversation this session is attached to.
   *
   * The renderer names a session, never a conversation, for the same reason `sessions:openChat`
   * does: the stored conversation id is re-read and validated here, so a renderer-supplied id
   * can neither invent a conversation nor block one it is not looking at. A session with no
   * conversation has no rogue turn to stop and is refused rather than silently ignored.
   */
  handle('sessions:block', async (payload) => {
    const { id, blocked } = z
      .object({ id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i), blocked: z.boolean() })
      .parse(payload);
    const summary = await getSession(id);
    const conversationId = summary?.conversationId;
    if (!conversationId || !/^[0-9a-z-]{8,64}$/i.test(conversationId)) {
      throw new Error('This session has no valid ChatGPT conversation');
    }
    setChatBlocked(conversationId, blocked);
    logInfo(
      blocked
        ? `conversation ${conversationId} blocked; its tool calls are refused until it is released`
        : `conversation ${conversationId} released; its tool calls run again`
    );
    // A blocked worker chat frees its swarm slot now, not on the next 30-second pass: the
    // user pressing Block on a worker is usually about to start something in its place.
    if (blocked) await sweepStaleSwarm().catch(() => undefined);
    return blockedChatIds();
  });

  /** Batch form of the same exact-session boundary, with all rows preflighted before mutation. */
  handle('sessions:blockMany', async (payload) => {
    const { ids, blocked } = z.object({ ids: sidebarMembers, blocked: z.boolean() }).parse(payload);
    const selected = await Promise.all(ids.map(async id => ({ id, summary: await getSession(id) })));
    if (selected.some(row => !row.summary)) {
      throw new Error('One or more selected conversations no longer exist. Nothing was changed.');
    }
    const conversationIds = selected.map(row => row.summary!.conversationId);
    if (conversationIds.some(conversationId => !conversationId || !/^[0-9a-z-]{8,64}$/i.test(conversationId))) {
      throw new Error('Block/Release is available only for recorded ChatGPT conversations. Unattributed activity was left unchanged.');
    }
    const exact = [...new Set(conversationIds as string[])];
    setChatsBlocked(exact, blocked);
    logInfo(blocked
      ? `${exact.length} selected conversation(s) blocked; their tool calls are refused until released`
      : `${exact.length} selected conversation(s) released; their tool calls run again`);
    if (blocked) await sweepStaleSwarm().catch(() => undefined);
    return blockedChatIds();
  });

  handle('sessions:delete', async (payload) => {
    const { id } = sessionIdArg.parse(payload);
    const receipt = await serializeSessionDeletion(() => deleteRecordedSession(id, false));
    push('session:changed');
    return receipt;
  });

  handle('sessions:deleteMany', async (payload) => {
    const { ids, permanent } = z.object({
      ids: z.array(sessionIdArg.shape.id).min(1).max(200).refine((value) => new Set(value).size === value.length),
      permanent: z.boolean()
    }).parse(payload);
    const result = await deleteRecordedSessionBatch(ids, permanent);
    push('session:changed');
    return result;
  });

  handle('sessions:listTrash', async () => listDeletedSessions());

  handle('sessions:deleteTrashed', async (payload) => {
    const { id } = sessionIdArg.parse(payload);
    const result = await emptySessionTrashRecords(id);
    logInfo(`permanently deleted Trash session ${id}; ${result.activeDuplicatesDeleted} live duplicate(s) retired`);
    push('session:changed');
    return result;
  });

  handle('sessions:emptyTrash', async () => {
    const result = await emptySessionTrashRecords();
    logInfo(`emptied Chat On Steroids Trash: ${result.removed} recovery copy/copies removed, ${result.activeDuplicatesDeleted} live duplicate(s) retired`);
    push('session:changed');
    return result;
  });

  handle('sessions:purgeAll', async payload => {
    z.object({ confirmation: z.literal('DELETE ALL') }).strict().parse(payload);
    let activeRemoved = 0;
    // The existing durable batch format is intentionally bounded to 200 rows. Drain through
    // that exact owner in chunks so thousands of records remain crash-recoverable without a
    // second deletion ledger or an unbounded durable JSON document.
    while (true) {
      // Leave expansion room for legacy duplicate rows sharing one conversation identity.
      const ids = (await indexedSessions()).slice(0, 100).map(session => session.id);
      if (ids.length === 0) break;
      const result = await deleteRecordedSessionBatch(ids, true);
      activeRemoved += result.deleted.length;
      if (result.deleted.length === 0) throw new Error('The all-records purge made no progress and was stopped safely.');
    }
    const trash = await emptySessionTrashRecords();
    // Session retirement normally drains every owned worker. Resetting afterward also removes
    // an orphaned legacy broker row that no longer has a surviving session to own it.
    resetSwarm();
    if (!(await persistAgentAuthorityNow())) {
      throw new Error('The conversations were deleted, but the cleared sub-agent state could not be saved. Run Delete all local records again.');
    }
    const foldersRemoved = await clearSidebarFolders();
    const result = { activeRemoved: activeRemoved + trash.activeDuplicatesDeleted, trashRemoved: trash.removed, foldersRemoved };
    logInfo(`all-session purge completed: ${result.activeRemoved} active record(s), ${result.trashRemoved} Trash record(s), ${foldersRemoved} sidebar folder(s) permanently removed`);
    push('session:changed');
    return result;
  });

  handle('sessions:restoreDeleted', async (payload) => {
    const { id } = sessionIdArg.parse(payload);
    const summary = await restoreDeletedRecordedSession(id);
    logInfo(`session ${id} restored from recoverable deletion`);
    push('session:changed');
    return summary;
  });

  handle('handoff:get', async (payload) => {
    const { id, handoffId } = z
      .object({
        id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        handoffId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i).optional()
      })
      .parse(payload);
    if (handoffId) return readHandoff(id, handoffId);
    const summary = await getSession(id);
    return summary?.lastHandoffId ? readHandoff(id, summary.lastHandoffId) : null;
  });

  // ---------------------------------------------------------------- bridge

  handle('bridge:unpair', async () => {
    await unpair();
    return buildState();
  });

  const openCurrentCompanion = async (): Promise<string> => {
    const dir = extensionDir();
    if (!dir) {
      throw new Error(
        'The extension folder is missing from this installation. Reinstall the app, or use the extension/ folder from the source checkout.'
      );
    }
    const error = await shell.openPath(dir);
    if (error) throw new Error(`Could not open the extension folder: ${error}`);
    return dir;
  };

  handle('bridge:downloadExtension', async () => {
    // Private/custom builds can intentionally keep the public semantic app version while moving
    // the incompatible bridge protocol. A version-addressed public ZIP can therefore be older
    // than this app. Recovery always opens the exact packaged/materialized companion instead.
    await openCurrentCompanion();
    return true;
  });

  /**
   * Opens the folder Chrome should load the extension from.
   *
   * The renderer never learns the path unless it asks for it here, and all it can do
   * with the answer is show it; the open itself happens in the main process against a
   * path the renderer did not choose.
   */
  handle('bridge:openExtensionFolder', async () => {
    return openCurrentCompanion();
  });

  handle('bridge:extensionPath', async () => extensionDir());

  // ----------------------------------------------------------------- swarm

  handle('swarm:get', async () => swarmHealthState());
  handle('swarm:reset', async () => {
    resetSwarm();
    if (!(await persistAgentAuthorityNow())) {
      throw new Error('The cleared run could not be made durable. Retry clearing the swarm.');
    }
    return swarmHealthState();
  });
  /**
   * Clearing one row in the app: the prime ends the run, a worker frees its own slot.
   *
   * The queued bootstrap is withdrawn here rather than from inside the broker. The broker
   * deliberately knows nothing about HTTP or tabs, and `drop()` reaches `failAgent` from
   * inside a delivery — cancelling from there would re-enter it. An IPC call never is.
   * `tidyCommands()` would retire the command on its own at the next poll; doing it now is
   * what stops a tab opening for a slot the user has just cleared.
   */
  handle('swarm:clearAgent', async (payload) => {
    const { id, runId } = z.object({ id: agentIdArg, runId: z.string().min(1).max(200).optional() }).parse(typeof payload === 'string' ? { id: payload } : payload);
    const outcome = clearAgent(id, runId);
    if (outcome.cleared !== 'none') {
      if (!(await persistAgentAuthorityNow())) {
        throw new Error('The agent clear could not be made durable. Retry the clear action.');
      }
      if (outcome.cleared === 'worker') cancelWorkerCommands(outcome.reason, id, runId);
    }
    // The prime's report stays in the main process: the renderer needs the outcome, not
    // the message queued for the prime agent.
    return { cleared: outcome.cleared, reason: outcome.reason, swarm: swarmHealthState() };
  });


  // Push updates so the UI reflects tunnel progress without polling. buildState() crosses
  // async secret/bridge reads, so an older snapshot can otherwise resolve after a newer one and
  // repaint stale config/status. Latest-request-wins makes the push stream monotonic.
  /**
   * Sends to the renderer, if there still is one.
   *
   * A null window was always handled; a *destroyed* one was not. Electron keeps the object
   * alive after the window is gone, so `getWindow()` stays truthy and merely reading
   * `.webContents` off it throws. That is not just a missed repaint: `onLog` runs inside
   * `log()`, synchronously, on the caller's own stack — so once the window was destroyed,
   * every log line written during teardown threw into whatever was writing it. The MCP drain's
   * force-close timer died on its own `logWarn` before it could force anything, and the app
   * sat draining a half-closed tunnel socket forever, with no window, no tray, and the
   * single-instance lock still held.
   */
  const push = (channel: string, ...args: unknown[]): void => {
    const target = getWindow();
    if (!target || target.isDestroyed()) return;
    target.webContents.send(channel, ...args);
  };
  let profilePushGeneration = 0;
  const pushInstanceProfiles = (): void => {
    if (!profileLifecycle) return;
    const generation = ++profilePushGeneration;
    void buildInstanceProfilesSnapshot(profileLifecycle).then((snapshot) => {
      if (generation !== profilePushGeneration) return;
      push('instances:changed', snapshot);
    }).catch((error) => {
      logInfo(`instance profiles: renderer snapshot refresh deferred — ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  let profileLifecyclePollingStopped = false;
  const notifyProfileWorkChanged = (): void => {
    if (profileLifecyclePollingStopped || !profileLifecycle) return;
    const phase = profileLifecycle.getStatus().phase;
    if (phase !== 'draining' && phase !== 'draining-switch' && phase !== 'draining-update' && phase !== 'draining-shutdown') return;
    void profileLifecycle.notifyWorkChanged().then(pushInstanceProfiles).catch((error) => {
      logInfo(`instance drain: work census refresh deferred — ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  configureLoopForwardReadiness(settledTurnContinuationAllowed, goalNativeCompletionReady);
  logInfo(`goal: Loop continuation policy=${getConfig().goal.continuationPolicy ?? 'strict'}; missing tool results remain unverified; native approvals and uncertain Send holds remain binding`);
  configureInputDelivery({
    callsHoldRecovery: recoveryHeldByCalls,
    settledTurnForwardReadiness: settledTurnInputForwardProof,
    activity: sessionInputActivity,
    wakeDecision: async (entry, signal) => {
      signal.throwIfAborted();
      if (!await startBridge()) throw new Error('The browser bridge could not start');
      signal.throwIfAborted();
      // A connected companion does not need another browser window, but it still needs to
      // hear that a newly committed helper is waiting in the durable outbox. wakeBrowserUrl()
      // deliberately becomes a no-op while the companion is connected, which previously left
      // temporary Goal/Loop helpers unclaimed until their timeout. Prompt the existing reader
      // first; an absent browser still falls through to the established open/reuse owner below.
      wakeBrowserWork();
      logInfo(`browser helper ${entry.id}: queued; waking the connected companion`);
      const marker = `cos-input=${encodeURIComponent(entry.id)}`;
      await wakeBrowserUrl(entry.conversationId ? `https://chatgpt.com/c/${encodeURIComponent(entry.conversationId)}`
        : `https://chatgpt.com/?${entry.lifetime === 'temporary-planner' ? 'temporary-chat=true&' : ''}${marker}#${marker}`);
    },
    bindHelper: async (conversationId, fromSessionId) => {
      const source = fromSessionId ? await getSession(fromSessionId) : null;
      if (source?.conversationId === conversationId || source?.chatIds.includes(conversationId)) return;
      await noteChatOrigin(conversationId, { kind: 'helper', fromSessionId, agentId: null, task: '' });
    },
    changed: () => { push('session:changed'); notifyProfileWorkChanged(); },
    recordDelivered: (entry) => getConfig().sessions.record ? recordDeliveredInput(entry) : Promise.resolve(true),
    prepareText: async (entry, limits, authored, inputOwnerRows) => {
      const control = entry.conversationId ? goalSwitchFor(entry.conversationId) : getConfig().goal;
      const mode = entry.automation ?? (control.enabled ? control.mode : 'off');
      const text = mode === 'goal' && goalBackendFor('goal') === 'templates' && !entry.text.includes(GOAL_MARKER_INSTRUCTION)
        ? entry.text + GOAL_MARKER_INSTRUCTION : entry.text;
      // Only the opening user input owns executor setup. Existing chats, queued
      // checkpoints and automatic continuations already have their instructions.
      const opening = !entry.sessionId && !entry.conversationId && !entry.finishOwner && entry.mode !== 'finish';
      const skillCommands = [authored?.text ?? entry.text, ...(opening && authored?.objective ? [authored.objective] : [])];
      return opening ? prepareSessionPrompt(text, { ...entry, skillCommands }, limits)
        : prepareFollowupPrompt(text, skillCommands, limits, {
          sessionId: entry.sessionId, conversationId: entry.conversationId, projectId: entry.projectId,
          generatedContinuation: !!entry.sourceHelperId, nativeDelivery: true,
          nativeInputOwnerRows: inputOwnerRows,
          nativeInput: inputOwnerRows?.find(row => row.id === entry.id)
        });
    },
    beforeAuthorizeNativeScope: preparedNativeScopeCurrent,
    applyAutomation: async (conversationId, automation, phase, objective, loopAfterTurn, foreground) => {
      // This message supersedes the old final; never pick that old final up merely
      // because the composer enabled Goal for the next turn.
      const mode = automation === 'off' ? goalSwitchFor(conversationId).mode : automation;
      // Reserve switch ordering immediately, before awaiting another ledger write.
      // A user Off arriving during persistence must remain later than this attempt.
      const switchWrite = setGoalSwitchNow(conversationId, mode, automation !== 'off', loopAfterTurn);
      const [held] = await Promise.all([switchWrite, setGoalReplyActiveNow(conversationId, false)]);
      // A fresh chat can finish before its send ACK arrives. Its newest final is
      // this message's own response, so it may be picked up after binding.
      // Objective ownership transfers with delivery even if the user switched Off
      // before the fresh chat acquired its identity. The saved Off row remains the
      // execution authority; retaining authored text must never imply reactivation.
      if (objective !== undefined) await setGoalObjectiveNow(conversationId, objective);
      const live = goalSwitchFor(conversationId);
      if (phase === 'after-send' && held.enabled && live.enabled && live.mode === held.mode) await setGoalReplyActiveNow(conversationId, true);
      if (phase === 'after-send' && foreground && automation !== 'off') {
        await foregroundAutomationRotation(conversationId);
      }
    }
  });

  let statePushGeneration = 0;
  const pushState = (): void => {
    const generation = ++statePushGeneration;
    void buildState().then((state) => {
      if (generation !== statePushGeneration) return;
      push('state:changed', state);
    });
  };
  onStatusChange(() => { pushState(); pushInstanceProfiles(); });
  onBridgeChange(() => { pushState(); push('session:changed'); notifyProfileWorkChanged(); pushInstanceProfiles(); });
  onProjectLinkChange(() => push('session:changed'));
  void expireArmedProjectCreates().catch(error =>
    logInfo(`projects: native ChatGPT Project expiry sweep deferred — ${error instanceof Error ? error.message : String(error)}`));
  // Draft stages belong to session controls; state:changed only refreshes settings.
  onGoalChange(() => push('session:changed'));
  handle('tasks:cancel', async payload => cancelTaskRequest(z.object({ requestId: z.string().uuid() }).parse(payload).requestId));
  handle('sessions:goalOpening', async payload => {
    const { text, mode, requestId } = z.object({ text: z.string().trim().min(1).max(16000),
      mode: z.enum(['goal', 'loop']), requestId: z.string().uuid() }).parse(payload);
    const backend = goalBackendFor(mode);
    const publish = (progress: import('../shared/task-progress.js').TaskProgressUpdate) => push('task:progress', { requestId, ...progress });
    return runTaskRequest(requestId, JSON.stringify(['goal', text, mode]), async signal => {
      if (goalBackendFor(mode) !== backend) throw new Error('task_settings_changed');
      const drafted = await draftOpeningMessage(text, mode, publish, signal);
      if ('error' in drafted) throw nativeGoalFailure(drafted.error, backend, drafted.retryAfterMs);
      signal.throwIfAborted(); publish({ phase: 'ready', text: drafted.reply.slice(-8000) });
      return drafted;
    }, publish);
  });
  configureChatModelDiscovery({ changed: () => push('chatModels:changed', getChatModels()), wake: async (nonce, allowOpen) => {
    if (!await startBridge()) throw new Error('The browser bridge could not start');
    if (allowOpen) {
      await assertModelDiscoveryCanWake();
      await wakeBrowserUrl(`https://chatgpt.com/?cos-model-catalog=${nonce}`, true, true);
    }
  } });
  onUpdateChange(pushState);
  onMacOSDesktopAccessChange(pushState);
  onLog((entry) => push('log:entry', entry));
  onSessionChange(() => { push('session:changed'); notifyProfileWorkChanged(); });
  onSwarmChange(() => { push('swarm:changed', swarmHealthState()); notifyProfileWorkChanged(); pushInstanceProfiles(); });
  let profileLifecyclePoll: ReturnType<typeof setInterval> | null = null;
  if (profileLifecycle) {
    // MCP/call settling has no UI event of its own. During Drain, one low-cost poll closes that
    // final gap and makes verified idle independent of renderer activity.
    profileLifecyclePoll = setInterval(() => notifyProfileWorkChanged(), 1_000);
    profileLifecyclePoll.unref();
  }
  return () => {
    profileLifecyclePollingStopped = true;
    if (profileLifecyclePoll) clearInterval(profileLifecyclePoll);
    profileLifecyclePoll = null;
  };
}

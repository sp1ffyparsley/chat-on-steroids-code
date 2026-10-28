import type { ChatModelCatalog } from '../shared/chat-models.js';
import type { SkillLibrary } from '../shared/skills.js';
import type { GoalModel } from '../shared/goal-reasoning.js';
import type { TaskProgress } from '../shared/task-progress.js';
import type { BrowserPreferences } from '../shared/browser-preferences.js';
import type {
  AutomationResumeResult,
  AutomationSupervisorSnapshot,
  BrowserConversationOpenResult,
  FreshCopyResult,
  RotationMembershipBatchResult,
  SessionAutomationBatchResult,
  SessionAutomationPauseBatchResult,
  SessionControlsView,
  StaleAutomationRecoveryResult
} from '../main/bridge.js';
import type { InputAttachment } from '../shared/input.js';
import type { UsageOverview } from '../shared/usage.js';
import type { InputArgs, InputEntry, SessionDecisionHelperCustody } from '../main/session/input.js';
import type { LocalProject } from '../shared/projects.js';
import type { PluginSnapshot, PluginInstallRequest, PluginConfigPatch } from '../shared/plugins.js';
import type { WorkerLifecycleProgress } from '../shared/session.js';
import type { FleetAutomationAlarmView } from '../main/fleet-automation.js';

export type HelperBulkRestartResult = {
  eligible: number;
  restarted: number;
  skipped: number;
  resume: AutomationResumeResult;
};

/**
 * Compact renderer projection of one local account/device instance.
 *
 * Main owns every runtime decision and may enrich these objects later. Keep the preload contract
 * deliberately presentation-sized: no local state paths, secrets, Electron partition names or
 * mutable runtime objects cross into the renderer.
 */
export type InstanceProfilePlatform = 'win32' | 'darwin' | 'linux';
export type InstanceProfileConnectionState = 'disconnected' | 'starting' | 'connected' | 'offline' | 'error';
export type InstanceProfileCoreState = 'off' | 'unknown' | 'starting' | 'live' | 'error';

export interface InstancePendingOperation {
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
  platform: InstanceProfilePlatform;
  enabled: boolean;
  active: boolean;
  runtimeMode: 'legacy' | 'isolated';
  runtimeRunning: boolean;
  runtimePrepared: boolean;
  browserPaired: boolean | null;
  browserAuth: 'signed-in' | 'signed-out' | 'unknown' | null;
  browserProfileDirectory: string;
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
  pendingOperations: InstancePendingOperation[];
  connector: InstanceConnectorSetupView;
}

export interface InstanceDrainView {
  kind: 'none' | 'drain' | 'switch' | 'update' | 'shutdown';
  phase: 'idle' | 'draining' | 'drain-ready' | 'draining-switch' | 'switch-ready' |
    'draining-update' | 'update-applied' | 'draining-shutdown' | 'shutdown-applied';
  state: 'idle' | 'draining' | 'ready' | 'applying' | 'error';
  detail?: string | null;
  pendingOperations: number;
}

export interface InstanceProfilesSnapshot {
  activeProfileId: string;
  canManageProfiles: boolean;
  profiles: InstanceProfileView[];
  drain?: InstanceDrainView | null;
}

export interface InstanceProfileSwitchResult {
  snapshot: InstanceProfilesSnapshot;
  outcome: 'switched' | 'needs-drain' | 'queued' | 'blocked';
  message?: string;
}
/**
 * The entire renderer-facing API.
 *
 * Each function maps to exactly one named IPC channel. No channel name is ever taken
 * from the caller, so the renderer cannot reach a handler that is not listed here, and
 * ipcRenderer itself is never exposed.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { SupportReport } from '../shared/support-report.js';
import type { ComposerDraftLoadResult, ComposerDraftSave, ComposerDraftSaveResult } from '../shared/composer-drafts.js';
import type { AppState, Capabilities, Config, Diagnosis, LogEntry, SignOutEmergencyNotice } from '../shared/types.js';
import type {
  Handoff,
  DeletedSessionRecovery,
  DeletedSessionTrashResult,
  SessionDeletionBatchResult,
  SessionDeletionReceipt,
  SessionPurgeResult,
  SessionEvent,
  SessionSearchLocation,
  SessionSearchReply,
  SessionSummary,
  SidebarFolder,
  ClearAgentResult,
  SwarmState,
  TokenPressure
} from '../shared/session.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; field?: string };

const call = <T>(channel: string, payload?: unknown): Promise<Reply<T>> =>
  ipcRenderer.invoke(channel, payload) as Promise<Reply<T>>;

export interface SettingsPatch {
  capabilities: Capabilities;
  readOnly: boolean;
  tunnel: Config['tunnel'];
  ui: Config['ui'];
  sessions: Config['sessions'];
  compaction: Config['compaction'];
  multiAgent: Config['multiAgent'];
  goal: Config['goal'];
  mcp: Config['mcp'];
}

/** One page of the model catalogue, as the model picker asks for it. */
export interface GoalModelPage {
  models: GoalModel[];
  total: number;
  selectedModel?: GoalModel;
}

export interface SessionList {
  sessions: SessionSummary[];
  /** Read-only broker lifecycle per ordinary parent chat; never persisted in session metadata. */
  workerProgress: Array<WorkerLifecycleProgress & { id: string }>;
  activeId: string | null;
  /** ChatGPT conversation ids the user has blocked from using local tools. */
  blocked: string[];
  pressure: Array<TokenPressure & { id: string }>;
  /** Total retained sessions, not merely the current IPC page. */
  total: number;
  nextCursor: SessionListCursor | null;
  /** Recoverable local history copies in Chat On Steroids Trash. */
  deleted: number;
  /** Read-only projection of the existing app-side Loop/recovery owners. */
  automation: AutomationSupervisorSnapshot;
  /** Machine-wide alarm/coverage projection, returned only by the legacy/primary account owner. */
  alarmAutomation?: FleetAutomationAlarmView | null;
}

export interface SessionListCursor {
  updatedAt: number;
  id: string;
}

export interface SessionDetail {
  summary: SessionSummary | null;
  events: SessionEvent[];
  total: number;
  /** First sequence not represented by this response; pass back as `from` for live deltas. */
  nextFrom: number;
}

const api = {
  getInstanceProfiles: () => call<InstanceProfilesSnapshot>('instances:get'),
  listInstanceBrowserProfiles: () => call<string[]>('instances:browserProfiles'),
  createInstanceProfile: (nickname: string, browserProfileDirectory: string) =>
    call<InstanceProfilesSnapshot>('instances:create', { nickname, browserProfileDirectory }),
  renameInstanceProfile: (id: string, nickname: string) =>
    call<InstanceProfilesSnapshot>('instances:rename', { id, nickname }),
  setInstanceBrowserProfile: (id: string, browserProfileDirectory: string) =>
    call<InstanceProfilesSnapshot>('instances:setBrowserProfile', { id, browserProfileDirectory }),
  setInstanceCoreTunnel: (id: string, tunnelId: string) =>
    call<InstanceProfilesSnapshot>('instances:setCoreTunnel', { id, tunnelId }),
  setInstanceRuntimeApiKey: (id: string, value: string) =>
    call<InstanceProfilesSnapshot>('instances:setRuntimeApiKey', { id, value }),
  setInstanceProfileEnabled: (id: string, enabled: boolean) =>
    call<InstanceProfilesSnapshot>('instances:setEnabled', { id, enabled }),
  removeInstanceProfile: (id: string, confirmation: string) =>
    call<InstanceProfilesSnapshot>('instances:remove', { id, confirmation }),
  switchInstanceProfile: (id: string, mode: 'check' | 'after-work') =>
    call<InstanceProfileSwitchResult>('instances:switch', { id, mode }),
  openInstanceProfileBrowser: (id: string) => call<boolean>('instances:openBrowser', { id }),
  launchInstanceRuntime: (id: string) => call<InstanceProfilesSnapshot>('instances:launchAlongside', { id }),
  copyInstanceConnectorSetup: (id: string) => call<boolean>('instances:copyConnectorSetup', { id }),
  refreshInstanceConnector: () => call<InstanceProfilesSnapshot>('instances:refreshConnector'),
  drainInstanceProfile: (action: 'start' | 'cancel' | 'apply-update' | 'shutdown') =>
    call<InstanceProfilesSnapshot>('instances:drain', { action }),
  onInstanceProfilesChanged: (listener: (snapshot: InstanceProfilesSnapshot) => void): (() => void) => {
    const wrapped = (_event: unknown, snapshot: InstanceProfilesSnapshot): void => listener(snapshot);
    ipcRenderer.on('instances:changed', wrapped);
    return () => ipcRenderer.removeListener('instances:changed', wrapped);
  },
  skillsList: () => call<SkillLibrary>('skills:list'),
  skillsImport: () => call<SkillLibrary | null>('skills:import'),
  skillsOpenFolder: () => call<void>('skills:openFolder'),
  skillsRemove: (id: string) => call<SkillLibrary>('skills:remove', { id }),
  openLegalNotices: () => call<void>('plugins:legalNotices'),
  pluginsSnapshot: () => call<PluginSnapshot>('plugins:snapshot'),
  pluginsInstall: (request: PluginInstallRequest) => call<PluginSnapshot>('plugins:install', request),
  pluginsConfigure: (id: string, patch: PluginConfigPatch) => call<PluginSnapshot>('plugins:configure', { id, patch }),
  pluginsRestart: (id: string) => call<PluginSnapshot>('plugins:restart', { id }),
  pluginsAuthenticate: (id: string) => call<PluginSnapshot>('plugins:authenticate', { id }),
  pluginsCancelAuthentication: (id: string) => call<PluginSnapshot>('plugins:cancelAuthentication', { id }),
  pluginsUpdate: (id: string) => call<PluginSnapshot>('plugins:update', { id }),
  pluginsUninstall: (id: string) => call<PluginSnapshot>('plugins:uninstall', { id }),
  pluginsSetEnabled: (id: string, enabled: boolean) => call<PluginSnapshot>('plugins:enabled', { id, enabled }),
  pluginsSetToolEnabled: (id: string, name: string, enabled: boolean) => call<PluginSnapshot>('plugins:tool', { id, name, enabled }),
  pluginsImportBundle: () => call<string | null>('plugins:importBundle'),
  onPluginsChanged: (listener: (snapshot: PluginSnapshot) => void): (() => void) => {
    const wrapped = (_event: unknown, snapshot: PluginSnapshot): void => listener(snapshot);
    ipcRenderer.on('plugins:changed', wrapped);
    return () => ipcRenderer.removeListener('plugins:changed', wrapped);
  },
  chooseFiles: () => call<InputAttachment[]>('sessions:files'),
  dropFiles: async (files: File[]): Promise<Reply<InputAttachment[]>> => {
    if (!files.length || files.length > 20) return { ok: false, error: 'Attach up to 20 files per message' };
    try {
      const sources = [];
      for (const file of files) {
        const path = webUtils.getPathForFile(file);
        if (!path && file.size > 12 * 1024 * 1024) return { ok: false, error: 'Pasted images must be 12 MB or smaller' };
        sources.push(path || { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
      return await call<InputAttachment[]>('sessions:dropFiles', { files: sources });
    } catch { return { ok: false, error: 'Could not read the attachment' }; }
  },
  attachText: (text: string) => call<InputAttachment>('sessions:attachText', { text }),
  getUsage: () => call<UsageOverview>('usage:get'),
  getState: () => call<AppState>('state:get'),
  saveSettings: (patch: SettingsPatch, base: SettingsPatch) => call<AppState>('settings:save', { patch, base }),
  addRoot: () => call<AppState>('roots:add'),
  /** Main owns both native path discovery and the exact-path confirmation for this plan. */
  addWorkspaceFolders: () => call<AppState>('roots:addWorkspaceFolders'),
  setSharedFolderAccess: (enabled: boolean) => call<AppState>('roots:shared', { enabled }),
  /** A folder dropped on the window; only the preload can learn a dropped File's path. */
  addRootPath: (file: File) => call<AppState>('roots:addPath', { path: webUtils.getPathForFile(file) }),
  removeRoot: (name: string) => call<AppState>('roots:remove', { name }),
  renameRoot: (name: string, newName: string) => call<AppState>('roots:rename', { name, newName }),
  setApiKey: (value: string, profileId?: string) => call<AppState>('secret:set', { value, ...(profileId ? { profileId } : {}) }),
  addSetupProfile: (name: string) => call<AppState>('setup:profile', { action: 'add', name }),
  selectSetupProfile: (id: string) => call<AppState>('setup:profile', { action: 'select', id }),
  removeSetupProfile: (id: string) => call<AppState>('setup:profile', { action: 'remove', id }),
  // The goal loop's own credential. Same channel, named slot; the value only ever goes in.
  setGoalKey: (value: string) => call<AppState>('secret:set', { value, key: 'openRouterApiKey' }),
  // The same, for a custom provider endpoint. Optional: keyless local servers need nothing stored.
  setCustomProviderKey: (value: string) => call<AppState>('secret:set', { value, key: 'customProviderApiKey' }),
  listGoalModels: (offset: number) => call<GoalModelPage>('goal:models', { offset }),
  pickBinary: () => call<AppState>('binary:pick'),
  connect: () => call<AppState>('connection:connect'),
  disconnect: () => call<AppState>('connection:disconnect'),
  runDiagnostics: () => call<Diagnosis>('diagnostics:run'),
  collectSupportReport: () => call<SupportReport>('support-report:collect'),
  loadComposerDrafts: () => call<ComposerDraftLoadResult>('composer-drafts:load'),
  saveComposerDrafts: (request: ComposerDraftSave) => call<ComposerDraftSaveResult>('composer-drafts:save', request),
  requestDesktopAccessibility: () => call<AppState>('desktop:requestAccessibility'),
  getLog: () => call<LogEntry[]>('log:get'),
  getLogText: () => call<string>('log:text'),
  getLogJson: () => call<string>('log:json'),
  writeClipboard: (text: string) => call<boolean>('clipboard:write', { text }),
  openLink: (url: string) => call<boolean>('link:open', { url }),
  // Applies the update this app has already downloaded and verified: the app quits, the
  // installer runs, and the app comes back as the new version. It takes no argument because
  // there is nothing here to choose - the main process knows what is staged.
  installUpdate: () => call<InstanceProfilesSnapshot>('update:install'),
  refreshUpdate: () => call<AppState['update']>('update:refresh'),

  // Sessions, compaction and the browser bridge. Everything here is read-only or a
  // named action; there is still no channel that takes a path or a command.
  listSessions: (options?: { cursor?: SessionListCursor; limit?: number }) =>
    call<SessionList>('sessions:list', options ?? {}),
  searchSessions: (query: string) => call<SessionSearchReply>('sessions:search', { query }),
  locateSessionSearchMatch: (id: string, query: string) =>
    call<SessionSearchLocation | null>('sessions:locateMatch', { id, query }),
  renameSession: (id: string, title: string) => call<boolean>('sessions:rename', { id, title }),
  setSessionWorkerLimit: (id: string, workerLimit: number | null) =>
    call<SessionSummary>('sessions:workerLimit', { id, workerLimit }),
  listProjects: () => call<LocalProject[]>('projects:list'),
  addProject: () => call<LocalProject | null>('projects:add'),
  retryChatgptProject: (id: string) => call<LocalProject | null>('projects:chatgpt-retry', { id }),
  removeProject: (id: string) => call<LocalProject>('projects:remove', { id }),
  getSessionImage: (id: string, assetId: string) => call<string | null>('sessions:image', { id, assetId }),
  getSession: (id: string, options?: { from?: number; before?: number; limit?: number }) =>
    call<SessionDetail>('sessions:events', { id, ...options }),
  stopSessionTurn: (id: string, expectedTurnId: string) => call<SessionControlsView>('sessions:stopTurn', { id, expectedTurnId }),
  releaseSessionFinish: (id: string, expectedTurnId: string) => call<SessionControlsView>('sessions:releaseFinish', { id, expectedTurnId }),
  generateFinishGoal: (id: string, expectedTurnId: string) => call<string>('sessions:generateFinishGoal', { id, expectedTurnId }),
  getChatModels: () => call<ChatModelCatalog>('chatModels:get'),
  browserPreferences: (patch: Partial<BrowserPreferences> = {}) => call<BrowserPreferences>('browser:preferences', patch),
  requestChatModels: () => call<ChatModelCatalog>('chatModels:request'),
  onChatModelsChanged: (listener: (catalog: ChatModelCatalog) => void): (() => void) => {
    const wrapped = (_event: unknown, catalog: ChatModelCatalog): void => listener(catalog);
    ipcRenderer.on('chatModels:changed', wrapped);
    return () => ipcRenderer.removeListener('chatModels:changed', wrapped);
  },
  getSessionControls: (id: string) => call<SessionControlsView>('sessions:controls', { id }),
  resumeAutomationChats: () => call<AutomationResumeResult>('sessions:resumeAutomation'),
  resumeAutomationChat: (id: string) => call<AutomationResumeResult>('sessions:resumeAutomationOne', { id }),
  recoverStaleAutomationChats: () => call<StaleAutomationRecoveryResult>('sessions:recoverStaleAutomation'),
  setAutomationProfile: (profile: 'day' | 'overnight' | 'rotation') => call<AppState>('sessions:automationProfile', { profile }),
  setAutomationPaused: (paused: boolean) => call<AppState>('sessions:automationPause', { paused }),
  freshCopyAutomationChats: () => call<FreshCopyResult>('sessions:freshCopyAutomation'),
  listSidebarFolders: () => call<SidebarFolder[]>('sessions:sidebarFolders'),
  createSidebarFolder: (name: string, sessionIds: string[]) => call<SidebarFolder[]>('sessions:createSidebarFolder', { name, sessionIds }),
  assignSidebarFolder: (folderId: string | null, sessionIds: string[]) => call<SidebarFolder[]>('sessions:assignSidebarFolder', { folderId, sessionIds }),
  renameSidebarFolder: (folderId: string, name: string) => call<SidebarFolder[]>('sessions:renameSidebarFolder', { folderId, name }),
  deleteSidebarFolder: (folderId: string) => call<SidebarFolder[]>('sessions:deleteSidebarFolder', { folderId }),
  setSessionAutomation: (id: string, automation: SessionControlsView['automation'], afterTurn?: boolean) => call<SessionControlsView>('sessions:automation', { id, automation, afterTurn }),
  setSessionObjective: (id: string, text: string, mode: 'goal' | 'loop') => call<SessionControlsView>('sessions:objective', { id, text, mode }),
  setSessionsAutomation: (ids: string[], automation: 'off' | 'goal' | 'loop', text?: string) =>
    call<SessionAutomationBatchResult>('sessions:automationMany', { ids, automation, text }),
  setSessionsAutomationPaused: (ids: string[], paused: boolean) =>
    call<SessionAutomationPauseBatchResult>('sessions:automationPauseMany', { ids, paused }),
  setRotationBatchMembership: (ids: string[], enrolled: boolean) =>
    call<RotationMembershipBatchResult>('sessions:rotationMembership', { ids, enrolled }),
  compactSession: (id: string) => call<SessionControlsView>('sessions:compact', { id }),
  cancelSessionCompaction: (id: string, expectedToken: string) => call<SessionControlsView>('sessions:cancelCompaction', { id, expectedToken }),
  draftTaskPlan: (text: string, backend: 'api' | 'chatgpt', requestId?: string) => call<string[]>('sessions:plan', { text, backend, requestId }),
  sendInput: (input: InputArgs) => call<InputEntry>('sessions:send', input),
  retryInputBrowser: (id: string) => call<InputEntry | null>('sessions:retryBrowser', { id }),
  listInputs: () => call<InputEntry[]>('sessions:outbox'),
  decisionHelperCustody: (id: string) => call<SessionDecisionHelperCustody | null>('sessions:helperCustody', { id }),
  listPausedHelpers: () => call<Array<{ id: string; sourceSessionId: string }>>('sessions:pausedHelpers'),
  retryHelper: (id: string, sourceSessionId: string) => call<boolean>('sessions:retryHelper', { id, sourceSessionId }),
  retryPausedHelpers: () => call<HelperBulkRestartResult>('sessions:retryPausedHelpers'),
  editQueuedInput: (id: string, text: string, afterTurn?: boolean) => call<boolean>('sessions:editInput', { id, text, afterTurn }),
  reorderQueuedInputs: (sessionId: string, ids: string[]) => call<boolean>('sessions:reorderInputs', { sessionId, ids }),
  cancelInput: (id: string) => call<boolean>('sessions:cancelInput', { id }),
  recheckWorkflow: (id: string) => call<boolean>('sessions:recheckWorkflow', { id }),
  // Main resolves an existing receipt; arbitrary renderer paths cannot be opened.
  openWorkflowOutput: (id: string, index: number, action: 'open' | 'reveal') =>
    call<{ action: 'open' | 'reveal'; status: 'opened' | 'revealed' }>('sessions:openWorkflowOutput', { id, index, action }),
  setInputAutomation: (id: string, mode: 'off' | 'goal' | 'loop', loopAfterTurn?: boolean) => call<boolean>('sessions:inputAutomation', { id, mode, loopAfterTurn }),
  setZoom: (factor: number) => call<number>('window:zoom', { factor }),
  getZoom: () => call<number>('window:getZoom'),
  openSessionChat: (id: string, timing?: { clickAt: number; ipcAt: number }) =>
    call<BrowserConversationOpenResult>('sessions:openChat', { id, timing }),
  // Stops a chat this app cannot stop in the page: every tool call it has already been proved
  // to own is refused until it is released. Returns the whole blocked set, so one press
  // repaints without a second read.
  setSessionBlocked: (id: string, blocked: boolean) => call<string[]>('sessions:block', { id, blocked }),
  setSessionsBlocked: (ids: string[], blocked: boolean) => call<string[]>('sessions:blockMany', { ids, blocked }),
  deleteSession: (id: string) => call<SessionDeletionReceipt>('sessions:delete', { id }),
  deleteSessions: (ids: string[], permanent: boolean) => call<SessionDeletionBatchResult>('sessions:deleteMany', { ids, permanent }),
  listDeletedSessions: () => call<DeletedSessionRecovery[]>('sessions:listTrash'),
  permanentlyDeleteTrashedSession: (id: string) => call<DeletedSessionTrashResult>('sessions:deleteTrashed', { id }),
  emptySessionTrash: () => call<DeletedSessionTrashResult>('sessions:emptyTrash'),
  purgeAllSessions: (confirmation: string) => call<SessionPurgeResult>('sessions:purgeAll', { confirmation }),
  restoreDeletedSession: (id: string) => call<SessionSummary>('sessions:restoreDeleted', { id }),
  getHandoff: (id: string, handoffId?: string) => call<Handoff | null>('handoff:get', { id, handoffId }),

  unpairExtension: () => call<AppState>('bridge:unpair'),
  downloadExtension: () => call<boolean>('bridge:downloadExtension'),
  // The renderer can ask where the extension is and ask for it to be opened, but the
  // path it gets back is only ever displayed: the open happens in the main process
  // against a folder the renderer never chose.
  extensionPath: () => call<string | null>('bridge:extensionPath'),
  openExtensionFolder: () => call<string>('bridge:openExtensionFolder'),

  getSwarm: () => call<SwarmState>('swarm:get'),
  resetSwarm: () => call<SwarmState>('swarm:reset'),
  // Clearing the prime ends the run; clearing a worker frees that slot. Which of the two
  // happened comes back in the result — the renderer does not decide it.
  clearAgent: (id: string, runId?: string) => call<ClearAgentResult>('swarm:clearAgent', { id, runId }),

  onStateChanged: (listener: (state: AppState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: AppState): void => listener(state);
    ipcRenderer.on('state:changed', wrapped);
    return () => ipcRenderer.removeListener('state:changed', wrapped);
  },
  onLogEntry: (listener: (entry: LogEntry) => void): (() => void) => {
    const wrapped = (_event: unknown, entry: LogEntry): void => listener(entry);
    ipcRenderer.on('log:entry', wrapped);
    return () => ipcRenderer.removeListener('log:entry', wrapped);
  },
  onSignOutEmergency: (
    listener: (notice: Pick<SignOutEmergencyNotice, 'profileId' | 'profileName'>) => void
  ): (() => void) => {
    const wrapped = (
      _event: unknown,
      notice: Pick<SignOutEmergencyNotice, 'profileId' | 'profileName'>
    ): void => listener(notice);
    ipcRenderer.on('notice:signout-emergency', wrapped);
    return () => ipcRenderer.removeListener('notice:signout-emergency', wrapped);
  },
  onSignOutEmergencyCleared: (listener: (notice: { profileId: string }) => void): (() => void) => {
    const wrapped = (_event: unknown, notice: { profileId: string }): void => listener(notice);
    ipcRenderer.on('notice:signout-emergency-cleared', wrapped);
    return () => ipcRenderer.removeListener('notice:signout-emergency-cleared', wrapped);
  },
  onSessionChanged: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('session:changed', wrapped);
    return () => ipcRenderer.removeListener('session:changed', wrapped);
  },
  onWriteSession: (listener: (id: string) => void): (() => void) => {
    const wrapped = (_event: unknown, id: string): void => listener(id);
    ipcRenderer.on('session:write', wrapped);
    return () => ipcRenderer.removeListener('session:write', wrapped);
  },
  onTaskProgress: (listener: (progress: TaskProgress) => void): (() => void) => {
    const wrapped = (_event: unknown, progress: TaskProgress): void => listener(progress);
    ipcRenderer.on('task:progress', wrapped);
    return () => ipcRenderer.removeListener('task:progress', wrapped);
  },
  cancelTaskRequest: (requestId: string) => call<boolean>('tasks:cancel', { requestId }),
  draftGoalOpening: (text: string, mode: 'goal' | 'loop', requestId: string) =>
    call<{ reply: string; model: string }>('sessions:goalOpening', { text, mode, requestId }),
  onSwarmChanged: (listener: (state: SwarmState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: SwarmState): void => listener(state);
    ipcRenderer.on('swarm:changed', wrapped);
    return () => ipcRenderer.removeListener('swarm:changed', wrapped);
  }
};

export type AppApi = typeof api;

contextBridge.exposeInMainWorld('api', api);

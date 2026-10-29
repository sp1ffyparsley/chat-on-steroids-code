import { recordedOperatorPromptBody } from '../shared/operator-prompt.mjs';
import { currentLanguage, ui, t } from './i18n.js';
import { composerTargetFields } from './composer-target.js';
import { applyChatModels, applyComposerSessionModel, initChatModels, confirmedComposerModel, ensureComposerModel } from './chat-models.js';
import { marked, Marked, type TokenizerAndRendererExtension } from 'marked';
import { hasProviderDirective, resolvedCapture, withoutProviderDirectives } from '../shared/content-reference.js';
import { APPROVAL_PROGRESS_PREFIX, approvalTextState } from '../shared/approval-wait.js';
import { completedDilText } from '../shared/dil-tables.js';
import { safeExternalLink } from '../shared/external-link.js';
import { createAgentPanel } from './agent-panel.js';
import { renderAgentPlan } from './agent-plan.js';
import { acceptanceStatusSummary, acceptanceSummary, type AgentPlan } from '../shared/agent-plan.js';
import { userPromptText } from '../shared/user-prompt.js';
import { messageReaction, withoutMessageReaction } from '../shared/message-reaction.js';
import { goalErrorMessage } from '../shared/goal-errors.js';
import type { GoalModel } from '../shared/goal-reasoning.js';
import { renderGoalReasoning } from './goal-reasoning.js';
import { preserveTimelineViewport, redirectNestedTimelineWheel } from './timeline-scroll.js';
import { createSidebarOrder } from './sidebar-order.js';
import { createComposerDrafts } from './composer-drafts.js';
import { createSidebarPins, pinnedSortScope } from './sidebar-pins.js';
import { initChatSearch } from './chat-search.js';
import { toolResultText } from './tool-result.js';
import { chatErrorPresentation, isChatGptRateLimit } from './chat-error.js';
import { renderRecoveryCountdowns } from './recovery.js';
import {
  MAJORITY_ALARM_OBSERVATION_GAP_MS,
  emptyMajorityAlarmState,
  observeMajorityAlarm,
  suppressMajorityAlarm,
  type MajorityAlarmState,
  type MajorityAlarmWarning
} from './majority-alarm.js';
import type { RecoveryCountdown } from '../shared/recovery.js';
import type { AutomationChatProjection, AutomationSupervisorSnapshot, SessionControlsView } from '../main/bridge.js';
import type { FleetAutomationAlarmView } from '../main/fleet-automation.js';
import { communicationTitle, foldAgentCommunication } from './agent-communication.js';
import { initContextMeter, paintContextMeter } from './context-meter.js';
import { createSkills, type SkillsController } from './skills.js';
import { isAstraModel, isProModel } from '../shared/chat-models.js';
import type { InputImage, InputAttachment, InputAutomation } from '../shared/input.js';
import { injectableAttachments } from '../shared/input.js';
import { workflowBlocker, workflowMetrics } from '../shared/workflow.mjs';
import type { InputArgs, InputEntry, SessionDecisionHelperCustody } from '../main/session/input.js';
import type { LocalProject } from '../shared/projects.js';
import type { TaskProgress } from '../shared/task-progress.js';
/**
 * Desktop chat workspace: recorded prose/tool truth, exact-session controls and a composer.
 * The extension remains the ChatGPT transport; main owns permissions, delivery, Goal and
 * compaction. The renderer crosses only the fixed preload API and scopes async views to
 * the selected session generation. Token and cost values remain explicitly estimates.
 */

import type {
  ActivitySummary,
  AgentState,
  Handoff,
  DeletedSessionRecovery,
  SessionDeletionReceipt,
  SessionEvent,
  SessionSummary,
  SidebarFolder,
  StoredText,
  SwarmState,
  TokenPressure,
  WorkerLifecycleProgress
} from '../shared/session.js';
import {
  ATTRIBUTION_LABELS,
  CHAT_ACTIVE_MS,
  CONTINUATION_MARKER,
  continuationMarker as nativeContinuationMarker,
  TURN_OUTCOME_LABELS,
  foldProgress,
  isGenericAutomaticSessionTitle,
  toolCallSummary
} from '../shared/session.js';
import { chronological, positionOf } from '../shared/chronology.js';
import { recentChatActivity, sessionLastWorkedAt, sessionWorkingAt } from '../shared/session-activity.js';
import {
  DEFAULT_GOAL_MODEL,
  DEFAULT_GOAL_LOOP_SYSTEM_PROMPT,
  DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  DEFAULT_GOAL_SYSTEM_PROMPT,
  MAX_AUTOMATION_OBJECTIVE_CHARS,
  MAX_GOAL_SYSTEM_PROMPT_CHARS
} from '../shared/goal.js';
import { browserExtensionRequired, MAX_MULTI_AGENT_WORKERS, type AppState, type Config } from '../shared/types.js';
import { $, ago, clockTime, compactNumber, el, filterSettingsSections, icon, run, toast, toastAction } from './dom.js';

const api = window.api;

/** Sprite id per tool-call family. Deliberately reuses the existing icon set. */
const KIND_ICON: Record<ActivitySummary['kind'], string> = {
  edit: 'i-pencil',
  create: 'i-plus',
  delete: 'i-trash',
  move: 'i-out',
  read: 'i-eye',
  search: 'i-search',
  browse: 'i-folder',
  run: 'i-terminal',
  process: 'i-terminal',
  screen: 'i-monitor',
  input: 'i-monitor',
  clipboard: 'i-copy',
  session: 'i-steps',
  agent: 'i-bolt',
  other: 'i-bolt'
};

/**
 * How close to the end of the model list counts as asking for the next page, in pixels.
 * A little over one row, so the fetch starts while there is still something to read.
 */
const GOAL_SCROLL_MARGIN = 72;
/** Page size and bounded staging capacity. A page is not a viewport: hundreds of
 * collapsed tool records can occupy less space than one authored message. */
const MAX_TIMELINE_ROWS = 160;
const MAX_TIMELINE_RESIDENT_ROWS = MAX_TIMELINE_ROWS * 2;
const MAX_TIMELINE_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_RENDERED_HTML_CHARS = 256 * 1024;
const SESSION_PAGE_SIZE = 60;
const SESSION_SCROLL_MARGIN = 72;

/**
 * Which agent's events the timeline is showing.
 *
 * `null` is everything. `UNATTRIBUTED` is its own bucket rather than being folded into
 * "all", because a call this app could not tie to any agent is a real category — with
 * ChatGPT's stateless connector it is the *default* category — and hiding it inside the
 * total would let a filtered view look complete when it is not.
 */
const UNATTRIBUTED = '\u0000unattributed';
let agentFilter: string | null = null;
/** The session the current filter was chosen in; selecting a different one resets it. */
let filterFor: string | null = null;

interface Deps {
  /** The renderer's single save path — reads every control, including ours. */
  save: () => Promise<void>;
  state: () => AppState | null;
  /** Active runtime identity, rather than the account currently selected in Settings. */
  account?: () => { nickname: string; id: string } | null;
}

let deps: Deps;
let visible = false;
let skillsController: SkillsController | null = null;

let sessions: SessionSummary[] = [];
let automationSupervisor: AutomationSupervisorSnapshot | null = null;
let recoverStaleAutomationInFlight = false;
let fleetAlarmView: FleetAutomationAlarmView | null = null;
/** False only for an older main-process payload which predates the fleet alarm projection. */
let alarmAutomationProvided = false;
let automationBySession = new Map<string, AutomationChatProjection>();
const MAJORITY_ALARM_STORAGE_KEY = 'cos-majority-stalled-alarm:v1';
let majorityAlarmState: MajorityAlarmState = (() => {
  try {
    const value = JSON.parse(window.localStorage.getItem(MAJORITY_ALARM_STORAGE_KEY) ?? 'null') as Partial<MajorityAlarmState> | null;
    return value && typeof value === 'object'
      ? { ...emptyMajorityAlarmState(), ...value }
      : emptyMajorityAlarmState();
  } catch { return emptyMajorityAlarmState(); }
})();
let majorityAlarmAudio: {
  kind: 'majority' | 'signout';
  profileId?: string;
  context: AudioContext;
  oscillator: OscillatorNode;
  timer: number;
} | null = null;
let majorityAlarmControl: MajorityAlarmWarning | null = null;
let majorityAlarmPollTimer: number | undefined;
let majorityAlarmPollInFlight = false;
let workerProgressBySession = new Map<string, WorkerLifecycleProgress>();
let pressure = new Map<string, TokenPressure>();
let sessionTotal = 0;
let deletedSessionTotal = 0;
let deletedSessionRows: DeletedSessionRecovery[] = [];
let sessionPageCursor: { updatedAt: number; id: string } | null = null;
let sessionPageLoading = false;
/** True after the user has explicitly paged beyond the newest page. */
let loadedOlderSessions = false;
let activeId: string | null = null;
let selectedId: string | null = null;
let renamingSessionId: string | null = null;
const expandedSessionTitles = new Set<string>();
/**
 * Semantic live-tail ownership. Layout changes never alter this bit: only a
 * deliberate reader gesture, history navigation, or chat selection does.
 */
let timelineFollowBottom = true;
function followOutputEnabled(): boolean { return deps.state()?.config.ui.followOutput !== false; }
let newChatSelected = true;
let selectedProjectId: string | null = null;
let projects: LocalProject[] = [];
const retryingChatgptProjects = new Set<string>();
const collapsedProjects = new Set<string>();
const projectVisibleCounts = new Map<string, number>();
let sidebarFolders: SidebarFolder[] = [];
const collapsedSidebarFolders = new Set<string>();
const multiSelectedSessions = new Set<string>();
/** Window-local fence against an older in-flight sidebar page redrawing a confirmed deletion. */
const deletedSessionIds = new Set<string>();
/** Stable session ids whose explicit Chrome-open command has not reached a terminal receipt. */
const openingSessions = new Set<string>();
let multiSelectAnchor: string | null = null;
function localFolderFor(sessionId: string): SidebarFolder | null {
  return sidebarFolders.find(folder => folder.sessionIds.includes(sessionId)) ?? null;
}
function projectGroup(id: string | null | undefined): string | null {
  return id && !projects.find(project => project.id === id)?.ungrouped ? id : null;
}
function sidebarScope(session: SessionSummary): string {
  const local = localFolderFor(session.id);
  return local ? `local:${local.id}` : projectGroup(session.projectId) ?? '';
}
const PROJECT_TASK_PAGE_SIZE = 5;
const PROJECT_TASK_PAGE_INCREMENT = 8;
let sidebarOrder: ReturnType<typeof createSidebarOrder> | undefined;
const sidebarPins = createSidebarPins();
let pendingSearchTarget: { sessionId: string; seq: number } | null = null;
function draftKey(): string { return selectedId ?? (selectedProjectId ? `project:${selectedProjectId}` : 'new'); }
let selectionGeneration = 0;
let pendingNewInput: { id: string; generation: number } | null = null;
let agentPanel: ReturnType<typeof createAgentPanel> | null = null;
const expandedWorkers = new Set<string>();
const inputDrafts = new Map<string, string>();
const imageDrafts = new Map<string, Array<InputImage | InputAttachment>>();
const composerSending = new Set<string>();
let draftStorageMessage = '';
let draftRestoreComplete = false;
let draftIdentitiesReady = false;
let draftRestoreWork: Promise<void> | null = null;
let restoringDraftSelection = false;
const composerDrafts = createComposerDrafts({
  load: async () => {
    const result = await api.loadComposerDrafts();
    if (!result.ok) throw new Error(result.error);
    return result.data;
  },
  save: async request => {
    if (deps.account?.()?.id !== request.profileId) throw new Error('Draft account changed; your current text was retained.');
    const result = await api.saveComposerDrafts(request);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  },
  status: message => { draftStorageMessage = message; paintDraftRecovery(); }
});
const startingInputs = new Map<string, InputEntry>();
const visibleInputIds = new Set<string>();
// Window-local presentation only: a new incident or changed status is visible again.
const dismissedRecoveryNotices = new Map<string, string>();
// Dismisses presentation only; durable cancellation and late receipts remain in the outbox.
const INPUT_NOTICE_KEY = 'dismissed-input-notices';
const dismissedInputNotices = new Set<string>((() => {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(INPUT_NOTICE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(-100) : [];
  } catch { return []; }
})());
function dismissInputNotice(id: string): void {
  dismissedInputNotices.add(id);
  try { window.localStorage.setItem(INPUT_NOTICE_KEY, JSON.stringify([...dismissedInputNotices].slice(-100))); }
  catch { /* A storage failure still allows dismissal for this window lifetime. */ }
  void refreshInputQueue();
}
function persistDraftKey(key: string): void {
  composerDrafts.record(key, inputDrafts.get(key) ?? '', imageDrafts.get(key) ?? []);
  paintDraftRecovery();
}
function rememberDraft(): void {
  const key = draftKey();
  inputDrafts.set(key, $<HTMLTextAreaElement>('chatInput').value);
  persistDraftKey(key);
  if (!restoringDraftSelection) composerDrafts.select({ sessionId: selectedId, projectId: selectedProjectId });
}
function settleDraftAdmission(key: string, generation: string, inputId: string): void {
  const cleared = composerDrafts.accepted(key, generation, inputId);
  if (cleared) {
    inputDrafts.delete(cleared); imageDrafts.delete(cleared);
    if (draftKey() === cleared) { $<HTMLTextAreaElement>('chatInput').value = ''; skillsController?.syncDraft(); paintComposerImages(); }
  }
  void composerDrafts.flush(); paintDraftRecovery();
}
/** Recovery notices describe local storage/admission only, never native Send. */
function paintDraftRecovery(): void {
  const anchor = document.getElementById('composerStatus');
  if (!anchor) return;
  let status = document.getElementById('draftRecoveryStatus');
  if (!status) {
    status = el('div', 'muted'); status.id = 'draftRecoveryStatus';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    anchor.insertAdjacentElement('afterend', status);
  }
  const message = draftStorageMessage || composerDrafts.warning(draftKey());
  status.replaceChildren(el('span', '', message)); status.hidden = !message;
  if (composerDrafts.get(draftKey())?.pending) {
    const reconcile = el('button', 'btn', 'Check saved delivery') as HTMLButtonElement;
    reconcile.type = 'button';
    reconcile.addEventListener('click', async () => {
      reconcile.disabled = true; rememberDraft();
      if (await composerDrafts.reconcile()) {
        inputDrafts.clear(); imageDrafts.clear();
        for (const entry of composerDrafts.snapshot().entries) { inputDrafts.set(entry.key, entry.text); if (entry.files.length) imageDrafts.set(entry.key, entry.files); }
        $<HTMLTextAreaElement>('chatInput').value = inputDrafts.get(draftKey()) ?? '';
        skillsController?.syncDraft(); paintComposerImages();
      }
      paintDraftRecovery(); paintDeliveryControls();
    });
    status.append(reconcile);
  }
  // Removing a sidebar project does not discard its authored draft. The original
  // known folder remains an explicit recovery target; it is never silently unfiled.
  for (const project of projects.filter(row => row.ungrouped && composerDrafts.get(`project:${row.id}`))) {
    if (draftKey() === `project:${project.id}`) continue;
    const open = el('button', 'btn', `Open saved draft · ${project.name}`) as HTMLButtonElement;
    open.type = 'button'; open.addEventListener('click', () => selectNewChat(project.id));
    status.append(open); status.hidden = false;
  }
}
/** Profile discovery can settle after the first session list. No restore until both are authoritative. */
export function refreshComposerDrafts(): void { if (draftIdentitiesReady) void restoreComposerDrafts(); }
/** Only authoritative account/project/session identities can restore a selection.
 * A missing old session retains its own draft; it is never relabelled as New Chat.
 */
async function restoreComposerDrafts(): Promise<void> {
  if (draftRestoreComplete) return;
  if (draftRestoreWork) return draftRestoreWork;
  const profileId = deps.account?.()?.id;
  if (!profileId) return;
  const selection = selectionGeneration;
  const draftVersion = composerDrafts.version();
  const initialDraftEmpty = !$<HTMLTextAreaElement>('chatInput').value && !(imageDrafts.get(draftKey())?.length);
  const restore = async (): Promise<void> => {
    const loaded = await composerDrafts.load(profileId);
    if (!loaded || deps.account?.()?.id !== profileId) return;
    const savedSelection = loaded.snapshot.selection;
    let savedSession = savedSelection?.sessionId ? sessions.find(row => row.id === savedSelection.sessionId) : undefined;
    if (savedSelection?.sessionId && !savedSession) {
      const result = await api.getSession(savedSelection.sessionId, { limit: 1 });
      if (result.ok && result.data?.summary?.id === savedSelection.sessionId && !deletedSessionIds.has(savedSelection.sessionId)) {
        savedSession = result.data.summary; mergeSessionRows([savedSession]); loadedOlderSessions = true;
      }
    }
    // Typing may have changed while either read crossed IPC. Use the controller's
    // merged current snapshot so no late load replaces locally dirty generations.
    if (deps.account?.()?.id !== profileId) return;
    const untouched = selection === selectionGeneration && selection === 0 && initialDraftEmpty && composerDrafts.version() === draftVersion;
    const snapshot = composerDrafts.snapshot();
    inputDrafts.clear(); imageDrafts.clear();
    for (const entry of snapshot.entries) { inputDrafts.set(entry.key, entry.text); if (entry.files.length) imageDrafts.set(entry.key, entry.files); }
    draftRestoreComplete = true;
    restoringDraftSelection = true;
    try {
      if (untouched && savedSelection?.sessionId && savedSession) selectSession(savedSession.id);
      else if (untouched && savedSelection && !savedSelection.sessionId && (!savedSelection.projectId || projects.some(row => row.id === savedSelection.projectId && !row.ungrouped))) selectNewChat(savedSelection.projectId);
      else restoreDraft();
    } finally { restoringDraftSelection = false; }
    if (savedSelection?.sessionId && !savedSession) draftStorageMessage = 'The previously selected chat is unavailable. Its saved draft was retained under that chat.';
    paintDraftRecovery();
  };
  draftRestoreWork = restore();
  try { await draftRestoreWork; }
  catch { draftStorageMessage = 'Saved drafts could not be restored. Your current text and existing saved drafts were retained.'; paintDraftRecovery(); }
  finally { draftRestoreWork = null; }
}
function restoreDraft(): void {
  cancelGoalRequest();
  $('activeGoalRow').hidden = true; $('recoveryStatus').hidden = true;
  $<HTMLTextAreaElement>('chatInput').value = inputDrafts.get(draftKey()) ?? '';
  skillsController?.syncDraft();
  const automation = $<HTMLSelectElement>('chatAutomation'); automation.value = 'off'; delete automation.dataset.edited;
  $<HTMLSelectElement>('loopDelivery').value = 'after-turn';
  $<HTMLTextAreaElement>('sessionObjective').value = ''; delete $('sessionObjective').dataset.edited; delete $('sessionObjective').dataset.sessionId;
  paintTaskPlan(); paintComposerImages();
  if (!restoringDraftSelection) composerDrafts.select({ sessionId: selectedId, projectId: selectedProjectId });
  paintDraftRecovery();
}
function paintComposerImages(): void {
  const key = draftKey();
  const images = imageDrafts.get(key) ?? [];
  const box = $('composerImages'); box.hidden = !images.length; box.replaceChildren();
  images.forEach((image, index) => {
    const tile = 'dataUrl' in image ? el('div', 'composer-image') : attachmentCard(image, true);
    if ('dataUrl' in image) { const preview = document.createElement('img'); preview.src = image.dataUrl; preview.alt = image.name; tile.append(preview); }
    const remove = el('button', 'image-remove', '×'); remove.setAttribute('type', 'button'); ui(remove, 'aria-label', () => t("Remove {0}", [image.name]));
    remove.addEventListener('click', () => { imageDrafts.set(key, images.filter((_entry, at) => at !== index)); persistDraftKey(key); paintComposerImages(); });
    tile.append(remove); box.append(tile);
  });
  paintDeliveryControls();
}
function attachmentCard(file: InputAttachment, inComposer = false): HTMLElement {
  if (file.preview) {
    const image = document.createElement('img'); image.src = file.preview; image.alt = file.name; image.title = file.name;
    if (!inComposer) return image;
    const tile = el('div', 'composer-image'); tile.append(image); return tile;
  }
  const tile = el('div', 'attachment-card'); tile.title = file.name;
  const glyph = el('span', 'attachment-icon');
  glyph.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
  const lines = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  lines.setAttribute('d', 'M7 3h10a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm1 6h8M8 13h8M8 17h5');
  lines.setAttribute('fill', 'none'); lines.setAttribute('stroke', 'currentColor'); lines.setAttribute('stroke-width', '1.6'); lines.setAttribute('stroke-linecap', 'round');
  svg.append(lines); glyph.append(svg);
  const details = el('div', 'attachment-details');
  details.append(el('div', 'attachment-name', file.name), el('div', 'attachment-kind', () => file.mimeType.startsWith('image/') ? t("Image") : t("File")));
  tile.append(glyph, details); return tile;
}

let events: SessionEvent[] = [];
let totalEvents = 0;
/** The session whose `events`/cursor pair belongs together. */
let detailFor: string | null = null;
let detailCursor: number | null = null;
let historyBefore: number | null = null;
let historyLoading = false;
/** The last swarm the app reported, so the header can summarise it without the log. */
let swarm: SwarmState | null = null;
/**
 * ChatGPT conversations the user has blocked from using local tools.
 *
 * Live policy the main process owns, keyed by conversation rather than by session, and pushed
 * with every session list. The renderer only ever mirrors it — pressing the button asks the
 * main process and repaints from the answer it gets back.
 */
let blockedChats = new Set<string>();
/** Badges the list is currently drawn with. See repaintBadges. */
let badgeKey = '';

/** Handoff currently shown, and the id it was loaded for. */
let handoff: Handoff | null = null;
let handoffFor: string | null = null;
let progressOrigin: { sessionId: string; seq: number; time: number; text: string } | null = null;
let progressOriginLoadingFor: string | null = null;
let progressEventsFor: string | null = null;
/** The retained Progress tail belongs to one exact provider binding even when
 * Compact & Resume keeps the same durable local session id. */
let progressEventsConversationId: string | null = null;
let progressEvents: SessionEvent[] = [];
let progressEventsLoadingFor: string | null = null;

let listTimer: number | undefined;
let listRefreshDirty = false;
let toolActivityTimer: number | undefined;
let sessionsLoadGeneration = 0;
let detailLoadGeneration = 0;
let handoffLoadGeneration = 0;
let workOverviewSessionId: string | null = null;
let workOverviewOriginRow: HTMLButtonElement | null = null;
/** Six newest saved updates are cheap to scan; explicitly reveal older useful
 * results in six-row batches without another history store or eager IPC reads. */
const WORK_UPDATES_PAGE_SIZE = 6;
let workOverviewUpdatesShown = WORK_UPDATES_PAGE_SIZE;
/** UI-only pagination receipt. History stays in the incumbent session store and
 * is read on demand through its established cursor, never polled by Work. */
let workOverviewOlderPageLoading = false;
let workOverviewOlderPageError = false;
let workOverviewControls: SessionControlsView | null = null;
/** Bounded view-only exact Off receipts: Work inspection of another chat cannot
 * revoke the prior control observation. A new provider or newer supervisor
 * invalidates each entry, without changing Main or persisting a second state. */
const inspectedOffReceipts = new Map<string, {
  conversationId: string; activeTurnId: string | null; readAt: number
}>();
/** Exact detail response for supervisor rows outside the currently paged session catalog. */
let workOverviewDetailSummary: SessionSummary | null = null;
let workOverviewEvents: SessionEvent[] = [];
/** One recorder-backed older result from this pane's session. Never persisted or used as current work. */
let workOverviewEarlierResult: { sessionId: string; marker: string; event: SessionEvent | null; complete: boolean } | null = null;
/** A single cached recorder tool row outside the selected Work detail's recent page.
 * This is historical text, never native Send, completion, or retry authority. */
let workOverviewEarlierTool: { sessionId: string; marker: string; event: SessionEvent | null; complete: boolean } | null = null;
/** One explicitly requested previous final/worker report. The next deliberate
 * lookup can move farther back in original recorder order; the session store
 * remains the only durable owner of all of these results. */
type WorkPreviousResultEvent = Extract<SessionEvent, { kind: 'assistant_message' | 'agent_message' }>;
let workOverviewPreviousLookup: {
  sessionId: string; key: string; phase: 'loading' | 'found' | 'checked' | 'unavailable';
  event: WorkPreviousResultEvent | null; complete: boolean
} | null = null;
/** One explicitly requested earlier tool output, separate from the current/latest tool result. */
let workOverviewPreviousToolLookup: {
  sessionId: string; key: string; phase: 'loading' | 'found' | 'checked' | 'unavailable';
  event: Extract<SessionEvent, { kind: 'tool_call' }> | null; complete: boolean
} | null = null;
/** View-only projection: recipient acknowledgement lives in the exact Prime session, not the worker's sent record. */
let workOverviewPrimeReceipt: { primeSessionId: string; messageId: string; from: string; receivedAt: number } | null = null;
let workOverviewMissingPrimeReceipt: { primeSessionId: string; messageId: string; primeEvents: number } | null = null;
let workOverviewPrimeReceiptRead: 'checked' | 'unavailable' | null = null;
/** Read-only private helper custody from Main; held for this opened Work pane only. */
let workOverviewHelperCustody: SessionDecisionHelperCustody | null = null;
let workOverviewHelperCustodyRead: 'checked' | 'unavailable' | null = null;
let workOverviewLoadGeneration = 0;
let workOverviewLoadingFor: string | null = null;
let workOverviewReadDirty = false;
let workOverviewReadFailure: 'progress' | 'history' | 'both' | null = null;
const WORK_OVERVIEW_RESULT_CHARS = 12_000;
const WORK_OVERVIEW_LOOKBACK_PAGE_SIZE = 160;
/** One explicit inspection may read older pages; ordinary status repaints never run this scan. */
const WORK_OVERVIEW_LOOKBACK_PAGES = 20;

// ------------------------------------------------------------------ sessions

function pressureOf(id: string): TokenPressure | null {
  return pressure.get(id) ?? null;
}

/** A short word about a session, drawn as a chip on its row. */
interface Badge {
  text: string;
  tone: '' | 'is-active' | 'is-finished' | 'is-failed';
}

/** Live word per worker state, in the user's vocabulary rather than the protocol's. */
const AGENT_BADGE: Record<AgentState, Badge> = {
  invited: { text: 'opening', tone: 'is-active' },
  active: { text: 'active', tone: 'is-active' },
  // Still working, as far as this app knows — only its browser tab is gone. Said as
  // "no tab" rather than "detached" because that is the part a user can act on.
  detached: { text: 'no tab', tone: 'is-active' },
  // Between jobs, not over. Its chat is intact and the prime can put it back to work in it,
  // so the word has to read as a pause rather than as an ending — a user who reads "finished"
  // here closes the tab, which is the one thing that costs nothing and helps nothing.
  sleeping: { text: 'sleeping', tone: '' },
  waking: { text: 'waking', tone: 'is-active' },
  finished: { text: 'finished', tone: 'is-finished' },
  failed: { text: 'failed', tone: 'is-failed' }
};

/**
 * Durable worker identity when the browser-origin ACK was lost but exact worker-attributed
 * tool history survived. One unique worker id is enough to classify the row; mixed/prime
 * evidence stays in the main list instead of guessing.
 */
function recordedWorkerId(summary: SessionSummary): string | null {
  if (summary.origin?.kind === 'worker') return summary.origin.agentId ?? 'worker';
  if (summary.origin !== null || summary.agents.includes('prime')) return null;
  const workers = [...new Set(summary.agents.filter(agent => /^worker-\d+$/.test(agent)))];
  return workers.length === 1 ? workers[0]! : null;
}

/**
 * What a row is, and what it is doing right now.
 *
 * Once resume and multi-agent mode are in use, most rows in the list are chats this app
 * opened, and they are all recorded within a minute of each other. A name alone cannot
 * separate them — which run a chat belonged to, whether its tab ever opened, whether the
 * worker in it ever joined — and that is how a user loses track of a delayed tab. The
 * first badge is durable and comes from the session itself; the second is live and comes
 * from the swarm or the compaction currently reported by the app.
 */
/** A recorded terminal outcome outranks an unexpired activity-grace deadline.
 * Only a newer exact open turn can supersede it; a late tool callback or an old
 * saved Loop switch cannot independently reopen a failed/stopped generation. */
function ordinaryTerminalOutcome(summary: SessionSummary): Exclude<NonNullable<SessionSummary['lastTurnOutcome']>, 'completed'> | null {
  const outcome = summary.lastTurnOutcome;
  return !summary.activeTurnId && outcome && outcome !== 'completed' ? outcome : null;
}

/** Keep callback arguments separate from the shared predicate's explicit clock. */
function sessionWorking(summary: SessionSummary): boolean {
  // A completed ordinary turn is also terminal: a stale activity-grace deadline
  // must not put it back in Current work or give it a working signal. An exact
  // newly opened turn may supersede the older completed outcome.
  return ordinaryTerminalOutcome(summary) === null &&
    (summary.lastTurnOutcome !== 'completed' || !!summary.activeTurnId) &&
    sessionWorkingAt(summary, Date.now());
}

/**
 * Is the Unattributed stream blocked?
 *
 * There is no per-chat block to read: the whole point of this row is that the app cannot say
 * which chat these calls came from, so the only switch that can answer for them is the
 * app-wide one. Off is a block — a call the app cannot attribute is refused — which is why
 * the row draws it with the same button and the same word as a blocked chat.
 */
function unattributedBlocked(): boolean {
  return deps.state()?.config.multiAgent.allowUnattributedCalls === false;
}

type DisplayedAutomationChat = AutomationChatProjection & {
  nativeEvidenceUnverified?: true;
  bindingUnverified?: true;
};

const automationStatusUnknown = (projection: DisplayedAutomationChat): boolean =>
  projection.nativeEvidenceUnverified === true || projection.bindingUnverified === true;

const AUTOMATION_STATE_LABEL: Record<AutomationChatProjection['state'], string> = {
  working: 'working',
  'waiting-workers': 'waiting workers',
  'waiting-main': 'between turns',
  recovering: 'repairing',
  stalled: 'needs attention',
  paused: 'paused',
  blocked: 'blocked'
};

const AUTOMATION_RECOVERY_LABEL: Record<NonNullable<AutomationChatProjection['recoveryStage']>, string> = {
  core: 'waiting for Core',
  queued: 'Chrome action queued',
  'browser-action': 'repairing Chrome',
  'checking-activity': 'verifying repair',
  'waiting-browser': 'waiting for Chrome',
  'focusing-existing-tab': 'focusing existing tab',
  'reopening-missing-tab': 'reopening missing tab',
  'waiting-activity': 'waiting for activity',
  'retry-scheduled': 'retry scheduled',
  handoff: 'writing handoff',
  draft: 'preparing reply',
  'pending-reply': 'reply pending',
  cooldown: 'retry waiting'
};
const AUTOMATION_RECOVERY_LABEL_VALUES = new Set(
  Object.values(AUTOMATION_RECOVERY_LABEL).map(label => label.toLowerCase()));

function automationStateLabel(projection: DisplayedAutomationChat): string {
  // A provider/user block cannot become merely "pausing" because a previous
  // drain record is still attached to its authoritative automation snapshot.
  if (projection.state === 'blocked') return AUTOMATION_STATE_LABEL.blocked;
  if (projection.pause?.phase === 'draining') return 'pausing';
  if (automationStatusUnknown(projection)) return 'unknown';
  return projection.state === 'recovering' && projection.recoveryStage
    ? AUTOMATION_RECOVERY_LABEL[projection.recoveryStage]
    : AUTOMATION_STATE_LABEL[projection.state];
}

function workOverviewStateClass(state: string): string {
  const normalized = state.toLowerCase();
  if (AUTOMATION_RECOVERY_LABEL_VALUES.has(normalized)) return 'is-waiting';
  switch (normalized) {
    case 'working':
    case 'completed':
      return 'is-working';
    case 'waiting workers':
    case 'between turns':
    case 'repairing':
      return 'is-waiting';
    case 'unknown':
    case 'recent evidence':
    case 'turn open':
    case 'turn open · evidence stale':
    case 'last unknown':
    case 'saved worker report · provider unverified':
    case 'saved final · provider unverified':
    case 'previous-provider delivery retained':
    case 'unbound native delivery retained':
    case 'recorded edits · provider unverified':
    case 'recorded tool activity · provider unverified':
      return 'is-unknown';
    case 'paused':
    case 'pausing':
    case 'off':
    case 'off · turn open':
    case 'stopped':
    case 'interrupted':
    case 'last interrupted':
      return 'is-paused';
    case 'blocked':
    case 'failed':
    case 'stalled':
    case 'needs attention':
    case 'last failed':
    case 'last stalled':
      return 'is-failed';
    default:
      return '';
  }
}

/** Config owns the account-wide pause. A lagging scheduler snapshot cannot
 * turn old Working/recovery evidence back into live work after the pause.
 * Explicit blocked holds and an actually draining owner retain their facts. */
function selectedNativeEvidenceWait(projection: AutomationChatProjection): import('../shared/goal.js').GoalWait | null {
  if (selectedId !== projection.sessionId || !['working', 'waiting-main'].includes(projection.state) || projection.pause ||
      projection.activeWorkers > 0 || controlledBlocked || deps.state()?.config.ui.automationPaused === true ||
      controlledSessionId !== projection.sessionId || controlledConversationId !== projection.conversationId ||
      controlledSelection !== selectionGeneration || !controlledSessionKnown || controlledTurnId !== null ||
      controlledReadAt < (automationSupervisor?.observedAt ?? 0)) return null;
  const summary = sessions.find(row => row.id === projection.sessionId);
  if (!summary || summary.conversationId !== projection.conversationId ||
      summary.activeTurnId !== null || goalWaitView?.reason !== 'evidence') return null;
  return goalWaitView;
}

/** The selected exact Main controls can be newer than the sidebar's supervisor read.
 * An unresolved final/tool receipt is not current work. Project that existing Main
 * fact only while its session/conversation/selection and snapshot order still match;
 * a newer confirmed turn, provider block or recovery remains authoritative. */
function displayedAutomation(projection: AutomationChatProjection): DisplayedAutomationChat {
  if (deps.state()?.config.ui.automationPaused === true && projection.state !== 'paused' &&
      projection.state !== 'blocked' && projection.pause?.phase !== 'draining') {
    return {
      ...projection, state: 'paused', spinning: false, recoverable: false,
      nextRetryAt: null, recoveryStage: null,
      reason: 'Automation is paused for this account; the earlier work status is not proof of current execution.',
      nextAction: 'Keep saved results and unresolved replies; review the account hold before any deliberate resume.'
    };
  }
  if (!['working', 'waiting-main'].includes(projection.state) || projection.pause ||
      projection.activeWorkers > 0) return projection;
  const wait = selectedNativeEvidenceWait(projection);
  return wait ? {
    ...projection, state: 'waiting-main', spinning: false, recoverable: false,
    recoveryStage: null, nextRetryAt: null, nativeEvidenceUnverified: true,
    reason: wait.detail ?? 'Exact native tool completion remains unresolved; no current execution is proven.',
    nextAction: wait.nextAction ?? 'Inspect the exact native tool state before any deliberate continuation.'
  } : projection;
}

/** A local session survives Compact & Resume, but its old provider conversation does
 * not own the successor's current Working, Blocked or recovery presentation. Do not
 * erase the older supervisor fact or infer that the replacement chat is actively
 * executing. The next exact matching Main snapshot retires this neutral projection. */
function displayedAutomationForBinding(
  projection: AutomationChatProjection, summary: SessionSummary | null | undefined
): DisplayedAutomationChat {
  if (!summary || summary.conversationId === projection.conversationId) return displayedAutomation(projection);
  const paused = deps.state()?.config.ui.automationPaused === true;
  return {
    ...projection, state: paused ? 'paused' : 'waiting-main', spinning: false,
    recoverable: false, nextRetryAt: null, recoveryStage: null,
    pause: undefined, rotation: undefined, bindingUnverified: paused ? undefined : true,
    title: summary.title,
    reason: paused
      ? 'Automation is paused for this account. The previous provider conversation status is historical.'
      : 'Current conversation binding changed; the previous provider chat status is historical and this chat’s execution is unverified.',
    nextAction: 'Read exact current conversation health; preserve saved results and do not replay an unconfirmed input.'
  };
}

/** One inspected, same-provider Main read can disambiguate an older Goal/Loop
 * supervisor state. This is display evidence only: it never changes scheduling,
 * the original supervisor snapshot, its provider hold, or native Send custody. */
function inspectedWorkModeOff(
  projection: DisplayedAutomationChat, summary: SessionSummary | null | undefined
): boolean {
  const receipt = summary ? inspectedOffReceipts.get(summary.id) : null;
  return !!summary?.conversationId && !!receipt &&
    projection.conversationId === summary.conversationId &&
    receipt.conversationId === summary.conversationId &&
    // A cached Off control is bound to the specific observed native turn.
    // A newer B turn in the SAME provider is not governed by an A snapshot.
    (!summary.activeTurnId || receipt.activeTurnId === summary.activeTurnId) &&
    receipt.readAt >= (automationSupervisor?.observedAt ?? 0);
}

function inspectedOffTurnOpen(summary: SessionSummary | null | undefined): boolean {
  const receipt = summary ? inspectedOffReceipts.get(summary.id) : null;
  return !!receipt?.activeTurnId && receipt.conversationId === summary?.conversationId &&
    (summary?.activeTurnId === receipt.activeTurnId ||
      !summary?.activeTurnId && (summary?.updatedAt ?? 0) <= receipt.readAt);
}

function inspectedOffLabel(summary: SessionSummary | null | undefined): string {
  return inspectedOffTurnOpen(summary) ? 'off · turn open' : 'off';
}

function inspectedOffDetail(projection: DisplayedAutomationChat, summary: SessionSummary | null | undefined): string {
  return `Off for this chat in exact current-provider controls. Older supervisor recorded ${automationStateLabel(projection)}: ${projection.reason} ${inspectedOffTurnOpen(summary)
    ? 'The native turn is open; ongoing execution and completion remain unverified.'
    : 'No native turn is open in the exact controls; saved work and earlier provider holds remain reviewable.'}`;
}

function automationForSummary(summary: SessionSummary): DisplayedAutomationChat | null {
  const projection = automationBySession.get(summary.id);
  return projection ? displayedAutomationForBinding(projection, summary) : null;
}

/** A recovery stage is presentation detail, not another automation state. */
function automationRecoveryClass(projection: AutomationChatProjection): string {
  return projection.state === 'recovering' && projection.recoveryStage
    ? ` is-recovery-${projection.recoveryStage}`
    : '';
}

/**
 * Keep the sidebar countdown useful without letting a distant timestamp consume the row.
 * `1m+` is deliberately honest: it surfaces an unexpectedly long backend delay instead of
 * pretending that the retry will happen within the one-minute UI target.
 */
function automationRetryLabel(nextRetryAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((nextRetryAt - now) / 1000));
  if (seconds === 0) return t('retry now');
  if (seconds <= 60) return t('retry {0}s', [seconds]);
  return t('retry 1m+');
}

function rotationCycleLabel(nextRotationAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.ceil((nextRotationAt - now) / 60_000));
  if (minutes <= 1) return t('in under a minute');
  if (minutes < 60) return t('in {0}m', [minutes]);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? t('in {0}h {1}m', [hours, remainder]) : t('in {0}h', [hours]);
}

function rotationElapsedLabel(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return t('{0}s', [seconds]);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('{0}m', [minutes]);
  return t('{0}h {1}m', [Math.floor(minutes / 60), minutes % 60]);
}

/** Precise elapsed time for one live Goal/helper stage. */
function activityElapsedLabel(startedAt: number, now = Date.now()): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Only exact active main-chat work owns the animated sidebar spinner. */
function automationShowsWorkingSpinner(projection: AutomationChatProjection): boolean {
  return projection.state === 'working' && projection.spinning;
}

function persistMajorityAlarmState(): void {
  try { window.localStorage.setItem(MAJORITY_ALARM_STORAGE_KEY, JSON.stringify(majorityAlarmState)); }
  catch { /* The in-memory incident fence still prevents repeated sound in this window. */ }
}

function paintAutomationAlarmNotice(): void {
  const notice = $<HTMLElement>('automationAlarmNotice');
  const button = $<HTMLButtonElement>('suppressMajorityAlarm');
  const config = deps.state()?.config;
  const alarmRelevant = config?.ui.automationProfile === 'overnight' && !!config && ownsFleetMajorityAlarm(config);
  const incomplete = alarmRelevant && alarmAutomationProvided && fleetAlarmView?.coverage.state === 'incomplete'
    ? fleetAlarmView.coverage
    : null;
  notice.classList.toggle('is-incident', !incomplete && !!majorityAlarmControl);
  if (incomplete) {
    const names = incomplete.missingProfiles.join(', ');
    $('automationAlarmTitle').textContent = t('Overnight alarm monitoring is incomplete');
    $('automationAlarmDetail').textContent = t(
      '{0} of {1} enabled account profiles are reporting. Missing: {2}. The wake-up tone is disarmed until every enabled profile reports.',
      [incomplete.reportingProfiles, incomplete.expectedProfiles, names]
    );
    button.hidden = true;
    notice.hidden = false;
    return;
  }
  if (alarmRelevant && majorityAlarmControl) {
    $('automationAlarmTitle').textContent = t('Most automated chats need attention');
    $('automationAlarmDetail').textContent = t(
      '{0} of {1} enabled chats are still stalled. The wake-up tone will play after the two-minute safety grace if most remain down.',
      [majorityAlarmControl.stalled, majorityAlarmControl.enabled]
    );
    button.textContent = t('Do not ring');
    button.hidden = false;
    notice.hidden = false;
    return;
  }
  button.hidden = true;
  notice.hidden = true;
  $('automationAlarmTitle').textContent = '';
  $('automationAlarmDetail').textContent = '';
}

function suppressCurrentMajorityAlarm(): void {
  const control = majorityAlarmControl;
  if (!control) return;
  majorityAlarmState = suppressMajorityAlarm(majorityAlarmState, control.key);
  majorityAlarmControl = null;
  persistMajorityAlarmState();
  silenceMajorityOwnedAlarm();
  paintAutomationAlarmNotice();
  console.info('[Chat On Steroids] majority-stalled audible alert suppressed for this incident');
}

function silenceMajorityAlarm(): void {
  const audio = majorityAlarmAudio;
  majorityAlarmAudio = null;
  if (!audio) return;
  window.clearTimeout(audio.timer);
  try { audio.oscillator.stop(); } catch { /* Already ended. */ }
  void audio.context.close().catch(() => undefined);
  console.info('[Chat On Steroids] bounded audible alert silenced');
}

function silenceMajorityOwnedAlarm(): void {
  if (majorityAlarmAudio?.kind === 'majority') silenceMajorityAlarm();
}

/** Test-only ownership seam; it never creates or plays audio. */
export function disarmMajorityAlarmAudioForTests(): void {
  silenceMajorityOwnedAlarm();
}

/** Moderate app-local ring. This never reads or changes Windows/macOS master volume. */
async function playBoundedWakeAlarm(
  kind: 'majority' | 'signout',
  logLabel: string,
  message: string,
  profileId?: string
): Promise<void> {
  silenceMajorityAlarm();
  const AudioContextCtor = window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    console.warn(`[Chat On Steroids] ${logLabel} audible alert unavailable: Web Audio is unsupported`);
    return;
  }
  let context: AudioContext | null = null;
  try {
    const activeContext = new AudioContextCtor();
    context = activeContext;
    const oscillator = activeContext.createOscillator();
    const gain = activeContext.createGain();
    oscillator.type = 'sine';
    oscillator.connect(gain); gain.connect(activeContext.destination);
    const start = activeContext.currentTime + 0.05;
    gain.gain.setValueAtTime(0, start);
    // Sixteen short two-tone pulses are audible beside the user's microphone without an endless
    // alarm or a master-volume mutation. 0.14 is app-local gain, not 14 dB.
    for (let pulse = 0; pulse < 16; pulse += 1) {
      const at = start + pulse;
      oscillator.frequency.setValueAtTime(pulse % 2 === 0 ? 784 : 659, at);
      gain.gain.setValueAtTime(0.14, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
      gain.gain.setValueAtTime(0, at + 0.4);
    }
    oscillator.start(start); oscillator.stop(start + 16);
    const timer = window.setTimeout(() => {
      if (majorityAlarmAudio?.context === activeContext) majorityAlarmAudio = null;
      void activeContext.close().catch(() => undefined);
    }, 17_000);
    majorityAlarmAudio = { kind, ...(profileId ? { profileId } : {}), context: activeContext, oscillator, timer };
    await activeContext.resume();
    // Replacement/recovery may have closed this context while resume was pending. A stale
    // completion cannot announce itself as the current ring or affect its successor.
    if (majorityAlarmAudio?.context !== activeContext) return;
    console.warn(`[Chat On Steroids] ${logLabel} audible alert`);
    toastAction(
      message,
      t('Silence'),
      silenceMajorityAlarm,
      20_000
    );
  } catch (error) {
    if (context && majorityAlarmAudio?.context === context) silenceMajorityAlarm();
    console.warn(`[Chat On Steroids] ${logLabel} audible alert failed`, error);
  }
}

async function playMajorityAlarm(stalled: number, enabled: number): Promise<void> {
  await playBoundedWakeAlarm(
    'majority',
    `majority-stalled: ${stalled}/${enabled} enabled chats`,
    t('{0} of {1} enabled chats need attention. A bounded wake-up alert is playing.', [stalled, enabled])
  );
}

/** One existing bounded audio owner; no second timer, loop, or master-volume mutation. */
export async function playSignOutEmergencyAlarm(profileId: string, profileName: string): Promise<void> {
  await playBoundedWakeAlarm(
    'signout',
    `ChatGPT signed out for ${profileName}`,
    t('ChatGPT signed out for {0}. Browser dispatch is paused. A bounded wake-up alert is playing.', [profileName]),
    profileId
  );
}

/** Positive sign-in or explicit alert disable stops only this incident's local wake tone. */
export function silenceSignOutEmergencyAlarm(profileId: string): void {
  if (majorityAlarmAudio?.kind === 'signout' && majorityAlarmAudio.profileId === profileId) {
    silenceMajorityAlarm();
  }
}

function showMajorityAlarmWarning(warning: MajorityAlarmWarning): void {
  const summary = t('{0} of {1} enabled chats are still stalled. The wake-up tone will play in two minutes if most remain down.',
    [warning.stalled, warning.enabled]);
  console.warn(`[Chat On Steroids] majority-stalled warning: ${warning.stalled}/${warning.enabled}`);
  try {
    if (window.Notification?.permission === 'granted') {
      new window.Notification(t('Most automated chats need attention'), { body: summary, silent: true });
    }
  } catch { /* The in-app warning remains authoritative. */ }
}

function evaluateMajorityAlarm(snapshot: AutomationSupervisorSnapshot, armed: boolean): void {
  if (!armed) {
    silenceMajorityOwnedAlarm();
    const cleared = observeMajorityAlarm({ ...snapshot, chats: [] }, majorityAlarmState);
    majorityAlarmState = cleared.state;
    majorityAlarmControl = null;
    persistMajorityAlarmState();
    paintAutomationAlarmNotice();
    return;
  }
  const previous = JSON.stringify(majorityAlarmState);
  const result = observeMajorityAlarm(snapshot, majorityAlarmState);
  majorityAlarmState = result.state;
  majorityAlarmControl = result.control;
  if (JSON.stringify(majorityAlarmState) !== previous) persistMajorityAlarmState();
  if (result.warning) showMajorityAlarmWarning(result.warning);
  if (result.incident) {
    void playMajorityAlarm(result.incident.stalled, result.incident.enabled);
  }
  paintAutomationAlarmNotice();
}

/**
 * The wake-up alarm must keep observing app-owned scheduler truth even while the Chat panel is
 * hidden. Ordinary timeline polling intentionally stops with the panel, so this narrow poll owns
 * only the bounded automation snapshot and never paints sessions or touches browser tabs.
 */
function ownsFleetMajorityAlarm(config: Config): boolean {
  if (!config.instances) return true;
  return config.instances.profiles.find(profile => profile.id === config.instances!.activeInstanceId)?.state.mode === 'legacy';
}

function syncMajorityAlarmPolling(armed: boolean): void {
  if (!armed) {
    if (majorityAlarmPollTimer !== undefined) window.clearTimeout(majorityAlarmPollTimer);
    majorityAlarmPollTimer = undefined;
    if (automationSupervisor) evaluateMajorityAlarm(automationSupervisor, false);
    return;
  }
  if (majorityAlarmPollTimer !== undefined || majorityAlarmPollInFlight) return;
  majorityAlarmPollTimer = window.setTimeout(() => {
    majorityAlarmPollTimer = undefined;
    void pollMajorityAlarm();
  }, MAJORITY_ALARM_OBSERVATION_GAP_MS);
}

async function pollMajorityAlarm(): Promise<void> {
  const config = deps.state()?.config;
  if (!config || config.ui.automationProfile !== 'overnight' || !ownsFleetMajorityAlarm(config)) {
    syncMajorityAlarmPolling(false);
    return;
  }
  if (majorityAlarmPollInFlight) return;
  majorityAlarmPollInFlight = true;
  try {
    const list = await run(api.listSessions({ limit: 1 }));
    alarmAutomationProvided = list?.alarmAutomation !== undefined;
    fleetAlarmView = alarmAutomationProvided ? (list?.alarmAutomation ?? null) : null;
    const snapshot = alarmAutomationProvided ? fleetAlarmView?.snapshot : list?.automation;
    if (snapshot) {
      evaluateMajorityAlarm(snapshot, true);
    } else if (automationSupervisor) {
      // Explicit null is a fail-closed fleet observation, not permission to reuse the primary
      // account's local majority or the last complete fleet snapshot.
      evaluateMajorityAlarm(automationSupervisor, false);
    }
    paintAutomationAlarmNotice();
  } finally {
    majorityAlarmPollInFlight = false;
    const nextConfig = deps.state()?.config;
    syncMajorityAlarmPolling(nextConfig?.ui.automationProfile === 'overnight' && !!nextConfig && ownsFleetMajorityAlarm(nextConfig));
  }
}

function paintAutomationSupervisor(): void {
  const snapshot = automationSupervisor;
  // A supervisor/status paint (including sidebar age and config repaint) has no
  // new transcript evidence. Reproject its label without initiating history IPC.
  paintWorkOverview(false);
  const config = deps.state()?.config;
  const profile = config?.ui.automationProfile ?? 'day';
  const picker = $<HTMLSelectElement>('automationProfile');
  if (picker.value !== profile) picker.value = profile;
  if (!snapshot) {
    $('automationSupervisorSummary').textContent = t('Loading automation status…');
    $('automationSupervisorDetail').textContent = t('Reading the app-owned scheduler…');
    $<HTMLButtonElement>('recoverStaleAutomation').disabled = true;
    return;
  }
  const alarmSnapshot = alarmAutomationProvided
    ? fleetAlarmView?.snapshot ?? null
    : (config && ownsFleetMajorityAlarm(config) ? snapshot : null);
  if (alarmSnapshot) evaluateMajorityAlarm(
    alarmSnapshot,
    profile === 'overnight' && !!config && ownsFleetMajorityAlarm(config)
  );
  else if (alarmAutomationProvided) evaluateMajorityAlarm(snapshot, false);
  paintAutomationAlarmNotice();
  const displayedChats = snapshot.chats.map(chat =>
    displayedAutomationForBinding(chat, sessions.find(row => row.id === chat.sessionId)));
  const unknown = displayedChats.filter(automationStatusUnknown).length;
  const counts = config?.ui.automationPaused === true || unknown > 0
    ? displayedChats.reduce((total, chat) => ({ ...total, [chat.state]: total[chat.state] + 1 }), {
        working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0,
        stalled: 0, blocked: 0, paused: 0
      } as AutomationSupervisorSnapshot['counts'])
    : snapshot.counts;
  const waiting = counts['waiting-workers'] + counts['waiting-main'] - unknown;
  const waitingCore = displayedChats.filter(chat => chat.state === 'recovering' && chat.recoveryStage === 'core').length;
  const otherRecovery = Math.max(0, counts.recovering - waitingCore);
  const parts = [
    counts.working ? t('{0} working', [counts.working]) : '',
    waiting ? t('{0} waiting', [waiting]) : '',
    unknown ? `${unknown} ${t('unknown')}` : '',
    waitingCore ? t('{0} waiting for Core', [waitingCore]) : '',
    otherRecovery ? t('{0} repairing', [otherRecovery]) : '',
    counts.stalled ? t('{0} needs attention', [counts.stalled]) : '',
    counts.blocked ? t('{0} blocked', [counts.blocked]) : '',
    counts.paused ? t('{0} paused', [counts.paused]) : ''
  ].filter(Boolean);
  $('automationSupervisorSummary').textContent = parts.length
    ? parts.join(' · ')
    : t('No enabled Goal or Loop chats');
  $('automationSupervisorDetail').textContent = profile === 'rotation' && snapshot.rotation
    ? snapshot.rotation.draining
      ? t('Rotation · slots 1–{0} finishing already-started work · {1} still busy · next batch starts as soon as they settle · {2} priority · {3} queued · {4} needs attention · draining {5}', [
          snapshot.rotation.active, snapshot.rotation.busyActive, snapshot.rotation.foreground, snapshot.rotation.queued,
          snapshot.rotation.attention,
          rotationElapsedLabel(snapshot.rotation.drainingAt || snapshot.observedAt)
        ])
      : t('Rotation · slots 1–{0} active ({1}/{2}) · {3} priority · {4} queued · {5} needs attention · next cycle {6}{7}', [
          snapshot.rotation.active,
          snapshot.rotation.active, snapshot.rotation.batchSize, snapshot.rotation.foreground, snapshot.rotation.queued,
          snapshot.rotation.attention,
          snapshot.rotation.nextRotationAt ? rotationCycleLabel(snapshot.rotation.nextRotationAt) : t('when work is queued'),
          snapshot.rotation.previous ? t(' · previous batch: {0} chat(s)', [snapshot.rotation.previous]) : ''
        ])
    : profile === 'overnight'
      ? t('Overnight · bounded to {0} active lane(s) · stale recovery automatic', [snapshot.targetLanes])
      : t('Day · fast scheduling · stale recovery available on demand');
  const button = $<HTMLButtonElement>('recoverStaleAutomation');
  const recoverable = snapshot.chats.filter(chat => chat.recoverable).length;
  button.disabled = recoverStaleAutomationInFlight || recoverable === 0 || deps.state()?.config.ui.automationPaused === true;
  $('recoverStaleAutomationLabel').textContent = recoverable
    ? t('Retry {0}', [recoverable])
    : t('Retry chats');
}

/**
 * Compact cross-chat work feed backed only by durable session evidence and the one automation
 * supervisor. It deliberately has no timer, queue or persistence of its own: clicking a row
 * simply selects the session whose full Progress view already owns plan/checklist detail.
 */
function workOverviewReportLabel(controls: SessionControlsView | null, source: SessionEvent[]): string {
  const report = controls?.activeWork?.report;
  if (report?.pending) return `Two-active-hour scope update reserved at ${Math.round(report.pending.thresholdMs / 3_600_000)}h · waiting for its exact native delivery receipt.`;
  if (report?.delivered) {
    const receipt = `Two-active-hour scope update delivered at ${Math.round(report.delivered.thresholdMs / 3_600_000)}h · receipt ${report.delivered.messageId.slice(0, 8)}…`;
    const ordered = chronological(source);
    const deliveredAt = ordered.findIndex((event): event is Extract<SessionEvent, { kind: 'user_message' }> =>
      event.kind === 'user_message' && event.messageId === report.delivered!.messageId);
    if (deliveredAt < 0) return `${receipt} · response body is not present in the recent exact event window.`;

    // The receipt names the exact delivered user message. Relate a response only through that
    // message's own turn identity or the first turn_start that follows it before any other user
    // message. A newer unrelated final is deliberately insufficient evidence for this checkpoint.
    const deliveredMessage = ordered[deliveredAt] as Extract<SessionEvent, { kind: 'user_message' }>;
    let responseTurnId = deliveredMessage.turnId;
    let responseStart = deliveredAt;
    if (!responseTurnId) {
      for (let index = deliveredAt + 1; index < ordered.length; index++) {
        const event = ordered[index]!;
        if (event.kind === 'user_message') break;
        if (event.kind === 'turn_start' && event.turnId) {
          responseTurnId = event.turnId;
          responseStart = index;
          break;
        }
      }
    }
    if (!responseTurnId) return `${receipt} · exact response turn is not present in the recent event window.`;
    const response = ordered.slice(responseStart + 1).find((event): event is Extract<SessionEvent, { kind: 'assistant_message' }> =>
      event.kind === 'assistant_message' && event.final === true && event.turnId === responseTurnId);
    if (!response) return `${receipt} · exact response final is not present in the recent event window.`;
    const body = response.message.text.replace(/\s+/g, ' ').trim().slice(0, 1200);
    return body ? `${receipt} · Response: ${body}` : `${receipt} · exact response final contained no recorded text.`;
  }
  return '';
}

/** The recorder already owns native input receipt and Main alone validates
 * `inputReplyTo`. Read those facts together for this exact local session,
 * without converting a later unrelated final into a collected answer.
 * Temporary decision-helper outbox rows are deliberately not exposed by IPC. */
function workOverviewNativeDelivery(
  sessionId: string, ordered: SessionEvent[], inputs: readonly InputEntry[]
): {
  message: Extract<SessionEvent, { kind: 'user_message' }> | null;
  answer: Extract<SessionEvent, { kind: 'assistant_message' }> | null;
  entry: InputEntry | null;
  conflict: boolean;
  inputId: string;
  nativeMessageId: string | null;
  receivedAt: number;
  confirmed: boolean;
  previousConfirmed: InputEntry | null;
  previousOrderKnown: boolean;
} | null {
  let message = [...ordered].reverse().find((event): event is Extract<SessionEvent, { kind: 'user_message' }> =>
    event.kind === 'user_message' && !!event.inputId &&
    (event.inputDelivery === 'confirmed' || event.inputDelivery === 'offered')) ?? null;
  // An older native question may no longer be in this bounded event window even
  // though the same exact session still owns its durable outbox Send receipt.
  const latestOutbox = inputs.filter(input => input.purpose !== 'decision' &&
    (input.deliveredSessionId ?? input.sessionId) === sessionId &&
    typeof input.deliveredAt === 'number' && input.deliveredAt > 0 && !!input.messageId)
    .sort((left, right) => (right.deliveredAt ?? 0) - (left.deliveredAt ?? 0))[0] ?? null;
  if (message?.inputDelivery !== 'offered' && message && latestOutbox && latestOutbox.id !== message.inputId &&
      latestOutbox.deliveredAt! > message.time) message = null;
  if (!message && !latestOutbox) return null;
  const exactInput = message
    ? inputs.find(input => input.purpose !== 'decision' && input.id === message!.inputId &&
        (input.deliveredSessionId ?? input.sessionId) === sessionId) ?? null
    : latestOutbox;
  // Tool handouts have synthetic input:<id> recorder keys, not native provider
  // message identities. They must never conflict with the later exact outbox
  // Send for that same input. Only two asserted *native* ids can conflict.
  const conflict = message?.inputDelivery === 'confirmed' &&
    !!exactInput?.messageId && !!message.messageId && exactInput.messageId !== message.messageId;
  const entry = conflict ? null : exactInput;
  const nativeMessageId = entry?.messageId ??
    (message?.inputDelivery === 'confirmed' ? message.messageId ?? null : null);
  const confirmed = message?.inputDelivery === 'confirmed' ||
    !!entry?.messageId && typeof entry.deliveredAt === 'number' && entry.deliveredAt > 0;
  // A later tool handout is not a Send, and must not erase an earlier exact
  // native receipt that survived only in the same session's durable outbox.
  // Keep the earlier fact separate from the new handout's unconfirmed custody.
  const previousConfirmed = message?.inputDelivery === 'offered' && latestOutbox &&
    latestOutbox.id !== message.inputId
    ? latestOutbox : null;
  const previousOrderKnown = !!previousConfirmed && previousConfirmed.deliveredAt! < message!.time;
  const answer = confirmed && nativeMessageId
    ? [...ordered].reverse().find((event): event is Extract<SessionEvent, { kind: 'assistant_message' }> =>
        event.kind === 'assistant_message' && (event.final === true || event.state === 'final') &&
        event.goalEligible === true && event.inputReplyTo === nativeMessageId) ?? null
    : null;
  return { message, answer, entry, conflict, nativeMessageId,
    previousConfirmed, previousOrderKnown, inputId: message?.inputId ?? latestOutbox!.id,
    receivedAt: confirmed && entry?.deliveredAt ? entry.deliveredAt : message?.time ?? entry?.deliveredAt ?? 0,
    confirmed };
}

function workOverviewNativeDeliveryLabel(
  evidence: NonNullable<ReturnType<typeof workOverviewNativeDelivery>>, historyUnavailable: boolean
): string {
  const { message, answer, entry, conflict, inputId, nativeMessageId, confirmed, receivedAt } = evidence;
  const inputIdentity = `input ${inputId}${confirmed && nativeMessageId
    ? ` · native message ${nativeMessageId}` : ' · native message identity unconfirmed'}` +
    (message?.inputDelivery === 'offered' ? ` · handout reference ${message.messageId ?? 'unavailable'}` : '');
  const delivery = confirmed
    ? 'Native Send confirmed' : 'Tool handout offered; native Send receipt not established';
  const answerStatus = answer
    ? `Exact answer recorded ${clockTime(answer.time)} through Main-validated reply association; not task-completion acceptance.`
    : confirmed
      ? 'Matching answer not confirmed in the available exact history; collection is unknown, not accepted.'
      : 'Answer collection unknown until an exact native Send receipt and matching final are recorded.';
  const cancellation = conflict
    ? 'Conflicting outbox native message identity; its state cannot be adopted for this receipt.'
    : entry?.state === 'cancelled'
      ? `Cancelled after ${confirmed ? 'delivery' : 'the recorded handout'}; this does not undo Send or authorize replay.`
      : entry?.state === 'failed'
        ? 'Outbox failed; recorded delivery and answer evidence remain separate.'
        : entry?.state === 'queued' || entry?.state === 'browser' || entry?.state === 'tool'
          ? `Outbox ${entry.state}; this status does not establish answer collection.` : '';
  return [historyUnavailable ? 'Last confirmed snapshot; newer delivery evidence may exist.' : '',
    delivery, inputIdentity, `recorded ${clockTime(receivedAt)}`,
    message?.inputDelivery === 'offered' && confirmed
      ? 'The recent recorder row is an earlier handout; the exact native Send is verified independently by its outbox receipt.'
      : message ? '' : 'Native message text is outside this read; the outbox receipt is the available source.',
    cancellation,
    entry?.error ? `Recorded outbox reason: ${entry.error.slice(0, 240)}` : '', answerStatus]
    .filter(Boolean).join(' · ');
}

function workOverviewEarlierNativeDeliveryLabel(entry: InputEntry, orderKnown: boolean): string {
  return [orderKnown ? 'Earlier Native Send confirmed' : 'Separate Native Send confirmed',
    `input ${entry.id}`, `native message ${entry.messageId}`,
    `recorded ${clockTime(entry.deliveredAt!)}`,
    entry.state === 'cancelled' ? 'Cancelled after delivery; the earlier Send remains historical.' :
      entry.state === 'failed' ? 'Outbox later failed; the earlier Send remains historical.' : '',
    orderKnown ? 'This earlier receipt does not confirm Send or answer collection for the newer handout.' :
      'Stored timestamps conflict; relative order unverified. Neither Send nor answer collection for the offered handout is confirmed.']
    .filter(Boolean).join(' · ');
}

/** Use recorder-owned outcomes; never infer success from a plausible-looking tool summary. */
function workOverviewToolOutcome(outcome: Extract<SessionEvent, { kind: 'tool_call' }>['call']['outcome']): string {
  switch (outcome) {
    case 'ok': return '';
    case 'tool_rejected': return 'Rejected';
    case 'process_exit_nonzero': return 'Process exited unsuccessfully';
    case 'tool_execution_error': return 'Tool execution failed';
    case 'tool_internal_error': return 'Tool internal error';
    default: return 'Tool outcome unknown';
  }
}

type WorkAttentionFact = { label: string; detail: string; action: string };

/** Combine independent, already-owned custody facts for one inspected chat.
 * A recorded card, queue item or stream is a last observation, never a newly
 * granted approval, a live-generation clock or permission to replay a Send. */
function workOverviewAttention(
  summary: SessionSummary, controls: SessionControlsView | null, events: readonly SessionEvent[],
  inputs: readonly InputEntry[], helper: SessionDecisionHelperCustody | null,
  helperRead: 'checked' | 'unavailable' | null, helperRelevant: boolean,
  historyUnavailable: boolean, progressUnavailable: boolean,
  deliveryRead: 'loading' | 'available' | 'unavailable'
): { facts: WorkAttentionFact[]; hasPendingDelivery: boolean } {
  const facts: WorkAttentionFact[] = [];
  const add = (label: string, detail: string, action: string): void => { facts.push({ label, detail, action }); };
  const globallyPaused = deps.state()?.config.ui.automationPaused === true;
  if (globallyPaused) add('Account-wide automation pause ON',
    'The saved account control blocks new automatic Goal/Loop/helper work. Earlier work signals and saved outputs remain historical; an existing turn may still be finishing.',
    'Review the existing account Pause/Resume control and the other holds below before an authorized deliberate resume.');

  // Main's approval observer records a stable event for the exact provider
  // conversation, rewriting it to Answered on positive card disappearance.
  // Older A events in one durable A-to-B session cannot become B approval.
  const approval = !historyUnavailable && summary.conversationId
    ? [...events].reverse().find(event => event.source === 'app' && event.kind === 'progress' &&
        event.progressId?.startsWith(APPROVAL_PROGRESS_PREFIX + summary.conversationId + ':') &&
        approvalTextState(event.message.text) !== null)
    : null;
  if (approval?.kind === 'progress') {
    const answered = approvalTextState(approval.message.text) === 'answered';
    // Approval progress is durable per conversation, but Main does not attach
    // native turn IDs to these cards. A later turn in the SAME provider cannot
    // inherit an older card's waiting/answered state. Use only a positively
    // recorded successor turn start or exact finish owner as the time boundary;
    // otherwise leave current-turn association unknown, never guess by age.
    const currentTurn = summary.activeTurnId ??
      (summary.finishTurn?.conversationId === summary.conversationId ? summary.finishTurn.turnId : null);
    const observedStart = currentTurn ? events.find(event =>
      event.kind === 'turn_start' && event.turnId === currentTurn) : null;
    const finishStart = summary.finishTurn?.conversationId === summary.conversationId &&
      summary.finishTurn.turnId === currentTurn ? summary.finishTurn.startedAt : null;
    const currentStartedAt = observedStart?.time ?? finishStart;
    const earlierTurn = !!currentTurn && (approval.turnId
      ? approval.turnId !== currentTurn
      : typeof currentStartedAt === 'number' && currentStartedAt > 0 && approval.time < currentStartedAt);
    if (earlierTurn) {
      add(answered ? 'Earlier-turn provider approval answered' : 'Earlier-turn provider approval observed',
        answered
          ? 'An approval card was recorded as answered before the latest native turn in this provider. It is historical; the newer turn has no verified approval decision or tool outcome from that card.'
          : 'An approval card was recorded before the latest native turn in this provider. Its older waiting state cannot establish a current approval requirement or grant permission to the newer turn.',
        'Inspect the current provider chat and exact tool outcome in Open full chat / Progress. Any live approval card must be answered by the human there.');
    } else {
      const turnCaveat = currentTurn && approval.turnId !== currentTurn
        ? ' The current native turn association is unverified; this provider observation does not establish a live approval card on that turn.' : '';
      add(answered ? 'Provider tool approval answered' : 'Provider tool approval observed',
        (answered
          ? 'ChatGPT no longer shows the approval card as pending. This does not verify which action was chosen or whether the tool succeeded.'
          : 'ChatGPT recorded a native tool approval request in this provider conversation. The card may have changed since this observation; the account pause does not grant approval.') + turnCaveat,
        answered ? 'Inspect the exact tool outcome in Open full chat / Progress before treating the call as finished.' :
          'Open full chat / Progress, then inspect the existing provider chat in Chrome to allow or deny the actual card yourself.');
    }
  }

  const exactControls = !!controls && controls.sessionId === summary.id &&
    controls.conversationId === summary.conversationId && controls.activeTurnId === summary.activeTurnId;
  if (exactControls && controls!.goalWait?.reason === 'evidence') add('Native completion receipt unresolved',
    controls!.goalWait!.detail || 'The exact original native tool result or completion association is missing.',
    controls!.goalWait!.nextAction || 'Inspect the exact native tool receipt; keep the original reply saved and do not replay it.');

  // Read only the incumbent visible input queue. Queued with no owner, handout,
  // authorization or native message is positively pre-Send; a browser/tool
  // state has different custody and must not be called safely unsent.
  const pending = inputs.filter(entry => entry.purpose !== 'decision' &&
    (entry.deliveredSessionId ?? entry.sessionId) === summary.id &&
    !!summary.conversationId && entry.conversationId === summary.conversationId &&
    ['queued', 'browser', 'tool'].includes(entry.state) && entry.deliveredAt === undefined && entry.messageId === undefined);
  // A newer queued follower cannot conceal the older browser/tool owner blocking it.
  // Project each distinct custody state once; creation time is not delivery authority.
  if (pending.some(entry => entry.state === 'browser' && entry.sendAuthorizedAt !== undefined)) {
    add('Native Send receipt unresolved',
      'The original browser input was authorized, but no matching native message receipt is recorded.',
      'Inspect the exact original Send receipt in Delivery queue. Do not replay ambiguous delivery.');
  }
  if (pending.some(entry => entry.state === 'tool')) {
    add('Tool handout awaiting receipt',
      'The exact existing input was offered through a tool. That handout alone does not establish a native Send.',
      'Review the existing Delivery queue and await the original native receipt. Do not replay the handout.');
  }
  if (pending.some(entry => entry.state === 'browser' && entry.sendAuthorizedAt === undefined)) {
    add('Browser delivery in preparation',
      'The original browser input was claimed for preparation; native Send has not been confirmed.',
      'Inspect the existing Delivery queue and account/provider holds; do not create another input.');
  }
  if (pending.some(entry => entry.state === 'queued' && entry.owner === null &&
      entry.sendAuthorizedAt === undefined && entry.offeredAt === undefined)) {
    add('Saved input awaiting native Send',
      'The exact input is stored in the Delivery queue; no Send authorization, handout or native message receipt was recorded for it.',
      'Review this saved input in the existing Delivery queue. Its original owner decides when delivery is permitted.');
  }
  // A failed delivery can still be waiting for human review even when no
  // queued/browser/tool row survives. Preserve the original outbox custody:
  // a recorded native Send remains sent, an authorized-but-unconfirmed Send
  // is ambiguous, and a pre-Send failure is not permission to replay.
  const failed = inputs.filter(entry => entry.purpose !== 'decision' &&
    (entry.deliveredSessionId ?? entry.sessionId) === summary.id &&
    !!summary.conversationId && entry.conversationId === summary.conversationId &&
    entry.state === 'failed');
  const reviewFailedDelivery = 'Review the existing Delivery queue if its terminal notice is visible; otherwise open full chat / Progress and inspect the original custody. Never replay an ambiguous input.';
  const received = (entry: InputEntry): boolean =>
    !!entry.messageId && typeof entry.deliveredAt === 'number' && entry.deliveredAt > 0;
  if (failed.some(received)) add('Native Send recorded · delivery later failed',
    'The original exact native message receipt is retained, but its delivery row subsequently failed. Cancellation or failure cannot undo the Send, and an accepted answer remains separate.',
    reviewFailedDelivery);
  const unconfirmed = failed.filter(entry => !received(entry));
  if (unconfirmed.some(entry => entry.sendAuthorizedAt !== undefined || !!entry.messageId)) {
    add('Failed delivery · native Send unresolved',
      'A failed original input has a Send authorization or partial native receipt, but the complete matching native delivery evidence is absent. It may already have reached ChatGPT; this is not a safely unsent message.',
      reviewFailedDelivery);
  }
  if (unconfirmed.some(entry => entry.sendAuthorizedAt === undefined && !entry.messageId &&
      (entry.offeredAt !== undefined || entry.toolReceiptUncertain === true))) {
    add('Failed tool handout · native Send unverified',
      'The tool handout failed or its pickup result is uncertain. An offered tool message is not an exact native Send receipt; an original provider action might still be outstanding.',
      reviewFailedDelivery);
  }
  if (unconfirmed.some(entry => entry.sendAuthorizedAt === undefined && !entry.messageId &&
      entry.offeredAt === undefined && entry.toolReceiptUncertain !== true)) {
    add('Unconfirmed pre-Send failure',
      'The saved input failed before any Send authorization, handout or native receipt was recorded. Its original retry eligibility is determined by Main, not by Work status.',
      reviewFailedDelivery);
  }

  // This read is exact-session/conversation custody and deliberately contains
  // no private helper prompt, response body, or browser routing information.
  const boundHelper = helper?.sessionId === summary.id && helper.conversationId === summary.conversationId ? helper : null;
  // A failed browser decision-helper DRAFT is not the same as an account-wide
  // Pause or an active native turn. Selected-chat Delivery already exposes the
  // incumbent Restart helper/Resume this chat controls, but Work previously
  // omitted the terminal three-attempt circuit and left only an opaque scheduler
  // error. Project this exact same-provider/turn Main snapshot read-only. Never
  // infer the Send custody of every attempt from a single pre-Send failure.
  // When B has already ended, controls.activeTurnId and summary.activeTurnId
  // can both be null. That equality alone cannot make an A helper failure B's
  // hold. The stored B finish-start is a positive newer-turn boundary; a
  // failure observation preceding it stays historical and is not headlined.
  const finishedCurrentTurnAt = !summary.activeTurnId &&
    summary.finishTurn?.conversationId === summary.conversationId &&
    typeof summary.finishTurn.startedAt === 'number' && summary.finishTurn.startedAt > 0
    ? summary.finishTurn.startedAt : null;
  const exhaustedDraft = exactControls && (controls!.automation === 'goal' || controls!.automation === 'loop') &&
    controls!.goalDraft?.stage === 'failed' &&
    controls!.goalDraft.error === 'goal_browser_helper_exhausted' &&
    (!finishedCurrentTurnAt || controls!.goalDraft.stageStartedAt >= finishedCurrentTurnAt)
    ? controls!.goalDraft : null;
  const knownTurn = summary.activeTurnId ??
    (summary.finishTurn?.conversationId === summary.conversationId ? summary.finishTurn.turnId : null);
  const laterAcceptedReply = !!exhaustedDraft && !!boundHelper && (
    !!boundHelper.pendingOriginalReply &&
      (!knownTurn || boundHelper.pendingOriginalReply.sourceTurnId === knownTurn) &&
      boundHelper.pendingOriginalReply.acceptedAt > exhaustedDraft.stageStartedAt ||
    boundHelper.helpers.some(item => !item.sourceSuperseded && item.answer === 'accepted' &&
      (!knownTurn || item.sourceTurnId === knownTurn) &&
      item.createdAt > exhaustedDraft.stageStartedAt));
  if (exhaustedDraft && !laterAcceptedReply) {
    const modelUnconfirmedBeforeSend = /requested model or reasoning could not be confirmed before Send/i
      .test(exhaustedDraft.message ?? '');
    add('Helper retry budget exhausted',
      `Latest matching ${controls!.automation === 'loop' ? 'Loop' : 'Goal'} controls recorded three failed helper attempts. Automatic helper creation is held; neither a countdown nor an enabled Loop proves new work. ${modelUnconfirmedBeforeSend
        ? 'A reported attempt could not verify the requested helper model or reasoning before Send.'
        : 'The exact model/transport cause and native Send stage of each attempt need the original helper receipts.'} The original task and earlier saved results are retained; this status cannot confirm original-reply delivery.${helperRead === 'unavailable'
        ? ' Latest private helper custody is unavailable.' : ''}`,
      `Open full chat / Progress, inspect the original helper delivery/errors and Goal, Loop and Plan model/reasoning settings. ${globallyPaused
        ? 'Resolve the account-wide pause separately before considering exact-chat recovery. '
        : ''}No new native Send is authorized by this Work status. Use only the existing exact-chat Restart helper or Resume this chat control after reviewing unresolved receipts; do not replay ambiguous messages.`);
  }
  if (helperRead === 'unavailable' && helperRelevant) add('Private helper custody unavailable',
    'Only the last confirmed helper state is retained; its newest answer and original Goal reply cannot be verified.',
    'Use Retry helper status in this Work detail when the existing read becomes available.');
  else if (boundHelper?.pendingOriginalReply) add('Goal decision pending',
    'The source reply is recorded. Helper acceptance and executor delivery require their own receipts.',
    'Inspect the source reply and its separate helper and continuation receipts in Open full chat / Progress.');
  else if (boundHelper) {
    const awaiting = [...boundHelper.helpers].reverse().find(item => !item.sourceSuperseded &&
      ['awaiting-answer', 'awaiting-native-send', 'native-send-unresolved'].includes(item.phase));
    if (awaiting?.phase === 'awaiting-answer') add('Private helper answer pending',
      'A helper native Send was recorded, but its answer has not been accepted for the original source turn.',
      'Read the existing helper custody disclosure; wait for the exact answer/acceptance before original Goal delivery.');
    else if (awaiting) add('Private helper native receipt pending',
      'The helper is retained without a settled native Send receipt or accepted answer.',
      'Read the existing helper custody disclosure; do not start or replay another helper.');
    const queuedContinuation = [...boundHelper.helpers].reverse().find(item => !item.sourceSuperseded &&
      item.answer === 'accepted' && item.continuation?.state === 'queued' &&
      item.continuation.nativeSend === 'not-confirmed' && !item.continuation.nativeMessageId &&
      !item.continuation.deliveredAt);
    if (queuedContinuation) add('Saved source continuation after helper acceptance',
      'The accepted helper has an existing queued source continuation. Its native Send and any new answer are not recorded.',
      'Inspect the original source continuation in Open full chat / Progress; the original queue owner retains delivery.');
  }

  // Only the exact current Main turn binding may associate a recorded streaming
  // fragment with this provider. It is still a past observation, not a spinner.
  if (!historyUnavailable && exactControls && summary.activeTurnId && events.some(event =>
      event.kind === 'assistant_message' && event.state === 'streaming' &&
      event.turnId === summary.activeTurnId)) add('Streaming text recorded on this turn',
    'An in-progress assistant message was saved for the current bound turn. This fragment alone does not prove that generation is still running.',
    'Open full chat / Progress to inspect the latest recorded turn and its final or current result.');

  if (historyUnavailable) add('Latest history read unavailable',
    'Only the last confirmed observation remains readable. Recent approval, Send and stream state may have changed.',
    'Use Retry read in Work detail before deciding whether any other action is safe.');
  if (progressUnavailable) add('Latest controls and checklist read unavailable',
    'The current task controls could not be read. Last saved results remain available but current Goal/Loop decisions are unverified.',
    'Use Retry read in Work detail to refresh original task, native hold and next-step evidence.');
  if (deliveryRead !== 'available') add(
    deliveryRead === 'loading' ? 'Delivery queue evidence loading' : 'Latest delivery queue read unavailable',
    deliveryRead === 'loading'
      ? 'The input queue has not been read yet. Native Send, failed delivery and pending input status cannot be inferred from this absence.'
      : 'The most recent input-queue read failed. Earlier saved inputs and receipts remain in the app, but their latest Send, failure and cancellation custody cannot be verified from the retained snapshot.',
    'Use Retry delivery evidence when the read is unavailable; inspect original custody before any Send, approval or recovery action.');
  return { facts, hasPendingDelivery: pending.length > 0 || failed.length > 0 };
}

function workOverviewSelectedRow(id: string | null): HTMLButtonElement | null {
  if (!id) return null;
  if (workOverviewOriginRow?.isConnected && workOverviewOriginRow.dataset.sessionId === id) {
    return workOverviewOriginRow;
  }
  return [...document.querySelectorAll<HTMLButtonElement>('.work-overview-row')]
    .find(row => row.dataset.sessionId === id) ?? null;
}

function savedWorkerReport(summary: SessionSummary, ordered: SessionEvent[]): Extract<SessionEvent, { kind: 'agent_message' }> | null {
  const workerId = recordedWorkerId(summary);
  if (!workerId) return null;
  return [...ordered].reverse().find((event): event is Extract<SessionEvent, { kind: 'agent_message' }> =>
    event.kind === 'agent_message' && event.from === workerId && event.to === 'prime' && event.delivery === 'sent' &&
    (event.message.text.startsWith(`[${workerId} reported]`) || event.message.text.startsWith(`[${workerId} finished]`))) ?? null;
}

/** A provider final can be revised with the same messageId and original log
 * position. The normal chronological reader correctly preserves that origin,
 * but two simultaneous snapshots at that same position can make its older
 * copy the closing final. Work is a summary of canonical messages: keep the
 * newest recorder revision in the first position, without rewriting the log
 * or merging distinct turns with coincidentally reused message IDs. */
function foldWorkAssistantRevisions(events: readonly SessionEvent[]): SessionEvent[] {
  const latestAt = new Map<string, number>();
  const folded: SessionEvent[] = [];
  for (const event of events) {
    if (event.kind !== 'assistant_message' || !event.messageId) {
      folded.push(event);
      continue;
    }
    const key = `${event.messageId}\u0000${event.turnId ?? ''}`;
    const at = latestAt.get(key);
    if (at === undefined) {
      latestAt.set(key, folded.length);
      folded.push(event);
      continue;
    }
    const previous = folded[at]!;
    if (event.seq >= previous.seq) {
      folded[at] = { ...event, origin: positionOf(previous), time: previous.time };
    }
  }
  return folded;
}

/** Prefer exact current-provider worker work over a late unbound old-provider
 * report; the older report remains in the saved session history. The Prime
 * receipt lookup uses this same chosen report identity. */
function workOverviewWorkerReport(
  summary: SessionSummary, ordered: SessionEvent[], providerProofRequired: boolean
): Extract<SessionEvent, { kind: 'agent_message' }> | null {
  const last = savedWorkerReport(summary, ordered);
  if (!last || !providerProofRequired) return last;
  const currentTurn = summary.activeTurnId ??
    (summary.finishTurn?.conversationId === summary.conversationId ? summary.finishTurn.turnId : null) ??
    [...ordered].reverse().find(event => event.kind === 'tool_call' &&
      event.call.conversationId === summary.conversationId &&
      event.call.attributionMethod === 'request_id')?.turnId;
  if (!currentTurn) return last;
  return [...ordered].reverse().find((event): event is Extract<SessionEvent, { kind: 'agent_message' }> =>
    event.turnId === currentTurn && savedWorkerReport(summary, [event]) === event) ?? last;
}

/**
 * The current 80-event detail window can contain only later tools, while its session summary
 * still proves an older final/report exists. Follow the existing exact-session `before` cursor
 * on the explicit Work inspection only. Keep one matching event, not thousands of transcripts;
 * every read is id-checked and a pane switch cancels the scan before publishing anything.
 */
async function olderWorkEvidence(
  sessionId: string, recent: SessionEvent[], predicate: (event: SessionEvent) => boolean,
  stillSelected: () => boolean, candidate: SessionEvent | null = null
): Promise<{ event: SessionEvent | null; complete: boolean }> {
  let before = recent.reduce((oldest, event) => Math.min(oldest, event.seq), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(before)) return { event: null, complete: false };
  let best = candidate;
  for (let pageIndex = 0; pageIndex < WORK_OVERVIEW_LOOKBACK_PAGES && before > 1; pageIndex++) {
    // Every not-yet-read record has seq < before and its stable origin cannot exceed seq.
    // A previously found result at or beyond that boundary already outranks anything older,
    // even when a late revision to a much earlier final was appended after it.
    if (best && positionOf(best) >= before) return { event: best, complete: true };
    if (!stillSelected()) return { event: null, complete: false };
    const page = await run(api.getSession(sessionId, {
      before, limit: WORK_OVERVIEW_LOOKBACK_PAGE_SIZE
    })).catch(() => null);
    if (!stillSelected() || !page || page.summary?.id !== sessionId) return { event: null, complete: false };
    const older = page.events.filter(event => event.seq < before);
    const found = [...older].sort((left, right) => positionOf(right) - positionOf(left) || right.seq - left.seq)
      .find(predicate);
    if (found && (!best || positionOf(found) > positionOf(best) ||
        (positionOf(found) === positionOf(best) && found.seq > best.seq))) best = found;
    const previous = older.reduce((oldest, event) => Math.min(oldest, event.seq), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(previous) || previous >= before) return { event: best, complete: true };
    before = previous;
  }
  return { event: best, complete: before <= 1 || !!best && positionOf(best) >= before };
}

/** Deliberate read-only lookup only; ordinary session/automation refreshes
 * cannot issue older-page scans or repeat a failed one. Every awaited page is
 * guarded by the same selected pane, provider and native turn. */
async function findPreviousWorkResult(
  sessionId: string, key: string, currentTurnId: string,
  summary: SessionSummary, recent: SessionEvent[], reference: WorkPreviousResultEvent
): Promise<void> {
  // The visible result is the exclusive cursor. Compare original positions,
  // not revision sequence numbers, so a late edit to older A cannot be shown
  // again or skip an intervening finished worker report.
  const anchor = positionOf(reference);
  const saved = reference.turnId !== currentTurnId ? reference : null;
  const eligible = (event: SessionEvent): boolean =>
    recordedWorkResult(summary, event) && event.turnId !== currentTurnId &&
    positionOf(event) < anchor;
  const inRecent = [...recent].filter(eligible)
    .sort((a, b) => positionOf(b) - positionOf(a) || b.seq - a.seq)[0] ?? null;
  const request: NonNullable<typeof workOverviewPreviousLookup> = {
    sessionId, key, phase: 'loading', event: saved, complete: false
  };
  const originalReadGeneration = workOverviewLoadGeneration;
  workOverviewPreviousLookup = request;
  paintWorkOverviewPane();
  announceWorkOverview('Reading earlier saved Work results. This does not send, retry or change a chat.');
  const stillSelected = (): boolean => {
    const exact = workOverviewDetailSummary;
    const exactTurn = exact?.activeTurnId ??
      (exact && exact.finishTurn?.conversationId === exact.conversationId ? exact.finishTurn.turnId : null);
    return workOverviewSessionId === sessionId && workOverviewPreviousLookup === request &&
      workOverviewLoadGeneration === originalReadGeneration && !workOverviewReadDirty &&
      exact?.id === sessionId && exact.conversationId === summary.conversationId &&
      exactTurn === currentTurnId;
  };
  const found = await olderWorkEvidence(sessionId, recent, eligible, stillSelected, inRecent);
  if (!stillSelected()) {
    // An exact-session refresh or notification can replace the evidence
    // snapshot while this historical page is in flight, even when the same
    // native turn remains selected. A stale success must not cross that read
    // generation. Preserve this explicitly requested lookup as unverified so
    // the user can retry; never run another request automatically.
    if (workOverviewSessionId === sessionId && workOverviewPreviousLookup === request) {
      request.phase = 'unavailable';
      request.complete = false;
      paintWorkOverviewPane();
      announceWorkOverview('Earlier result lookup changed while reading. Verify with Retry earlier result lookup.');
    }
    return;
  }
  // Interrupted or bounded history cannot rank a candidate reliably. Keep
  // the previously visible saved result for a safe, explicit retry from the
  // same anchor rather than advancing past a potentially unseen result.
  const previous = found.complete ? found.event : null;
  request.event = previous &&
    (previous.kind === 'assistant_message' || previous.kind === 'agent_message') ? previous : saved;
  request.complete = found.complete;
  request.phase = !found.complete ? 'unavailable' : previous ? 'found' : 'checked';
  const moveFocus = document.activeElement instanceof HTMLElement &&
    document.activeElement.dataset.workAction === 'find-previous-result';
  paintWorkOverviewPane();
  if (moveFocus) {
    const target = request.event
      ? document.querySelector<HTMLElement>('#workOverviewPane .work-overview-previous-result > summary')
      : document.querySelector<HTMLElement>('#workOverviewPane [data-work-action="find-previous-result"]') ??
        document.querySelector<HTMLElement>('#workOverviewPane [data-work-action="open"]');
    target?.focus({ preventScroll: true });
  }
  announceWorkOverview(previous
    ? 'Earlier recorded result available. Its original native turn and attribution are labeled separately.'
    : found.complete ? saved
      ? 'No further earlier saved result found. The last recorded result remains available.'
      : 'Earlier saved result lookup completed; no additional result found in this bounded history.'
      : 'Earlier saved result lookup unavailable or bounded. Retry manually or open full chat history.');
}

/** Navigate older retained Core outputs only after an explicit click. This is
 * read-only session history: it cannot replay the tool, imply native Send, or
 * change the newest tool/status evidence. Each request is fenced by the exact
 * session, provider, native turn and current read generation. */
async function findPreviousWorkTool(
  sessionId: string, key: string, currentTurnId: string | null,
  summary: SessionSummary, recent: SessionEvent[], reference: Extract<SessionEvent, { kind: 'tool_call' }>
): Promise<void> {
  const cached = workOverviewPreviousToolLookup?.sessionId === sessionId &&
    workOverviewPreviousToolLookup.key === key ? workOverviewPreviousToolLookup : null;
  const saved = cached?.event === reference ? reference : null;
  const anchor = positionOf(reference);
  const eligible = (event: SessionEvent): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
    event.kind === 'tool_call' && !!event.call.result.text.trim() && positionOf(event) < anchor;
  const inRecent = [...recent].filter(eligible)
    .sort((left, right) => positionOf(right) - positionOf(left) || right.seq - left.seq)[0] ?? null;
  const request: NonNullable<typeof workOverviewPreviousToolLookup> = {
    sessionId, key, phase: 'loading', event: saved, complete: false
  };
  const originalReadGeneration = workOverviewLoadGeneration;
  workOverviewPreviousToolLookup = request;
  paintWorkOverviewPane();
  announceWorkOverview('Reading earlier recorded tool outputs. The latest tool result and native Send custody remain unchanged.');
  const stillSelected = (): boolean => {
    const exact = workOverviewDetailSummary;
    const exactTurn = exact?.activeTurnId ??
      (exact && exact.finishTurn?.conversationId === exact.conversationId ? exact.finishTurn.turnId : null);
    return workOverviewSessionId === sessionId && workOverviewPreviousToolLookup === request &&
      workOverviewLoadGeneration === originalReadGeneration && !workOverviewReadDirty &&
      exact?.id === sessionId && exact.conversationId === summary.conversationId &&
      exactTurn === currentTurnId;
  };
  const found = await olderWorkEvidence(sessionId, recent, eligible, stillSelected, inRecent);
  if (!stillSelected()) {
    if (workOverviewSessionId === sessionId && workOverviewPreviousToolLookup === request) {
      request.phase = 'unavailable';
      request.complete = false;
      paintWorkOverviewPane();
      announceWorkOverview('Earlier tool result lookup changed while reading. Verify with Retry earlier tool lookup.');
    }
    return;
  }
  const previous = found.complete && found.event?.kind === 'tool_call' ? found.event : null;
  request.event = previous ?? saved;
  request.complete = found.complete;
  request.phase = !found.complete ? 'unavailable' : previous ? 'found' : 'checked';
  const moveFocus = document.activeElement instanceof HTMLElement &&
    document.activeElement.dataset.workAction === 'find-previous-tool-result';
  paintWorkOverviewPane();
  if (moveFocus) {
    const target = request.event
      ? document.querySelector<HTMLElement>('#workOverviewPane .work-overview-previous-tool-result > summary')
      : document.querySelector<HTMLElement>('#workOverviewPane [data-work-action="find-previous-tool-result"]') ??
        document.querySelector<HTMLElement>('#workOverviewPane [data-work-action="open"]');
    target?.focus({ preventScroll: true });
  }
  announceWorkOverview(previous
    ? 'Earlier recorded tool output available with its original provider and turn context.'
    : found.complete ? saved
      ? 'No further earlier tool output found. The last displayed earlier tool output remains readable.'
      : 'Earlier tool output lookup completed; no additional retained tool output was found in the verified history.'
      : 'Earlier tool output lookup unavailable or bounded. Retry manually or open full chat history.');
}

function recordedWorkResult(summary: SessionSummary, event: SessionEvent): boolean {
  return (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')) ||
    (event.kind === 'agent_message' && savedWorkerReport(summary, [event]) !== null);
}

function closeWorkOverviewPane(id: string): void {
  if (workOverviewSessionId !== id) return;
  const originatingRow = workOverviewSelectedRow(id);
  workOverviewSessionId = null;
  workOverviewOriginRow = null;
  workOverviewControls = null;
  workOverviewDetailSummary = null;
  workOverviewEvents = [];
  workOverviewEarlierResult = null;
  workOverviewEarlierTool = null;
  workOverviewPreviousLookup = null;
  workOverviewPreviousToolLookup = null;
  workOverviewPrimeReceipt = null;
  workOverviewMissingPrimeReceipt = null;
  workOverviewPrimeReceiptRead = null;
  workOverviewHelperCustody = null;
  workOverviewHelperCustodyRead = null;
  workOverviewLoadGeneration++;
  workOverviewLoadingFor = null;
  workOverviewReadDirty = false;
  workOverviewReadFailure = null;
  announceWorkOverview(t('Work detail closed'));
  // Release a result held in Recent updates beyond its usual six rows before restoring
  // keyboard focus. An evicted source row must not leave the user focused on <body>.
  paintWorkOverview(false);
  (originatingRow?.isConnected ? originatingRow : document.querySelector<HTMLElement>('#workOverview > summary'))
    ?.focus({ preventScroll: true });
}

/** Announce only changes that help the user navigate; never stream a saved answer. */
function announceWorkOverview(value: string): void {
  const node = document.getElementById('workOverviewAnnouncement');
  if (node && node.textContent !== value) node.textContent = value;
}

function initWorkOverviewAccessibility(): void {
  const pane = $('workOverviewPane');
  const body = $('workOverviewBody');
  // These can contain a 12K-character retained result and repaint on every status update.
  // Broadcasting the entire feed as aria-live would repeatedly read private transcripts.
  pane.setAttribute('role', 'region');
  pane.setAttribute('aria-label', t('Work & updates detail'));
  pane.setAttribute('aria-live', 'off');
  body.setAttribute('aria-live', 'off');
  const announce = el('span', 'sr-only');
  announce.id = 'workOverviewAnnouncement';
  announce.setAttribute('role', 'status');
  announce.setAttribute('aria-live', 'polite');
  announce.setAttribute('aria-atomic', 'true');
  $('workOverview').append(announce);
}

/** Keep long saved outputs cheap to paint, while allowing an explicit exact
 * read of every character that the session recorder actually retained. The
 * current and historical disclosures use separate action/ARIA identities so
 * repaint focus restoration never targets the wrong saved report. */
function workOverviewRecordedBody(
  section: HTMLDetailsElement, recorded: string, sourceTruncated: boolean,
  kind: 'current' | 'historical' | 'previous' | 'tool' | 'previous-tool'
): HTMLElement[] {
  const body = section.querySelector<HTMLElement>(':scope > .work-overview-result-body') ??
    el('pre', 'work-overview-result-body');
  body.id = `work-overview-${kind}-recorded-body`;
  const limited = recorded.length > WORK_OVERVIEW_RESULT_CHARS;
  if (!limited && !sourceTruncated) {
    if (body.textContent !== recorded) body.textContent = recorded;
    return [body];
  }
  const note = section.querySelector<HTMLElement>(':scope > .work-overview-result-limit') ??
    el('p', 'work-overview-result-note work-overview-result-limit');
  const action = `expand-${kind}-result`;
  const existing = section.querySelector<HTMLButtonElement>(`:scope > button[data-work-action="${action}"]`);
  if (!limited) {
    if (body.textContent !== recorded) body.textContent = recorded;
    note.textContent = 'Recorder retained only part of the original message. Original recording was truncated; unavailable text cannot be recovered here.';
    return [body, note];
  }
  const reveal = existing ?? el('button', 'btn work-overview-reveal') as HTMLButtonElement;
  reveal.type = 'button';
  reveal.dataset.workAction = action;
  reveal.setAttribute('aria-controls', body.id);
  const refresh = (expanded: boolean): void => {
    reveal.setAttribute('aria-expanded', String(expanded));
    reveal.textContent = expanded
      ? 'Show shorter preview'
      : `Show all ${recorded.length.toLocaleString()} recorded characters`;
    const visibleText = expanded ? recorded : recorded.slice(0, WORK_OVERVIEW_RESULT_CHARS);
    if (body.textContent !== visibleText) body.textContent = visibleText;
    const limitText = expanded
      ? `Showing all ${recorded.length.toLocaleString()} locally recorded characters.`
      : `Showing the first ${WORK_OVERVIEW_RESULT_CHARS.toLocaleString()} of ${recorded.length.toLocaleString()} recorded characters. Reveal the remainder explicitly.`;
    note.textContent = sourceTruncated
      ? `${limitText} Recorder retained only part of the original message. Original recording was truncated; unavailable text cannot be recovered here.`
      : limitText;
  };
  reveal.onclick = () => refresh(reveal.getAttribute('aria-expanded') !== 'true');
  refresh(existing?.getAttribute('aria-expanded') === 'true');
  return [body, note, reveal];
}

/** Show receipt classifications only. The private planner text and browser route never cross this view. */
function workOverviewHelperStatus(helper: SessionDecisionHelperCustody['helpers'][number]): string {
  const native = helper.nativeSend === 'confirmed' ? 'Native Send confirmed' :
    helper.nativeSend === 'unresolved' ? 'Native Send unresolved' : 'Native Send not confirmed';
  const answer = helper.answer === 'accepted' ? 'Helper answer accepted' :
    helper.answer === 'rejected' ? 'Helper answer rejected' : 'answer not recorded';
  const phase = helper.phase === 'cancelled-after-native-delivery' ? 'cancelled after delivery' :
    helper.phase === 'failed-after-native-delivery' ? 'failed after delivery' :
    helper.phase === 'cancelled-before-native-send' ? 'cancelled before native Send' :
    helper.phase === 'failed-before-native-send' ? 'failed before native Send' :
    helper.phase === 'unresolved-cancellation' ? 'cancellation receipt unresolved' : '';
  const continuation = helper.continuation;
  const outgoing = continuation ? `source continuation ${continuation.state} · ${continuation.nativeSend === 'confirmed'
    ? 'native Send confirmed' : continuation.nativeSend === 'unresolved' ? 'native Send unresolved' : 'native Send not confirmed'}`
    : '';
  return [native, answer, helper.rejection ? `reason: ${helper.rejection}` : '', phase, outgoing,
    helper.sourceSuperseded ? 'original source superseded' : ''].filter(Boolean).join(' · ');
}

/** Read-only projection of Input's verified deliverables, inside the incumbent Work disclosure. */
function workRecipeReceipts(sessionId: string, prior: HTMLDetailsElement | null): HTMLDetailsElement | null {
  const rows = pendingComposerInputs.filter(row => row.workflow && (row.sessionId ?? row.deliveredSessionId) === sessionId);
  if (!rows.length) return null;
  const key = JSON.stringify(rows.map(row => [row.id, row.state, row.error, row.workflowReceipt, row.preparedContext, row.deliveredAt, row.acceptedNativeFinal, workflowBlocker(row, pendingComposerInputs)]));
  if (prior?.dataset.recipeKey === key) return prior;
  // Keep a separate DOM identity: the saved-answer reconciler owns .work-overview-result.
  const details = prior ?? el('details', 'work-overview-recipe') as HTMLDetailsElement;
  details.dataset.recipeKey = key;
  const summary = el('summary', '', `Recipe deliverables · ${rows.filter(row => row.workflowReceipt?.status === 'verified').length}/${rows.length} verified`);
  summary.dataset.workAction = 'recipe-receipts';
  const nodes: HTMLElement[] = [summary];
  for (const row of rows) {
    const section = el('section', 'work-overview-section');
    const receipt = row.workflowReceipt;
    const state = receipt?.status === 'verified' ? 'Verified outputs' : receipt?.status === 'failed' ? 'Checks failed' :
      row.acceptedNativeFinal ? 'Native final recorded · outputs unverified' : row.deliveredAt !== undefined ? 'Delivery confirmed · execution unverified' : 'Delivery unconfirmed';
    section.append(el('strong', '', `${row.workflow!.step} · ${state}`));
    const blocker = workflowBlocker(row, pendingComposerInputs);
    if (blocker || row.error) section.append(el('p', 'work-overview-result-note', row.error ?? blocker!));
    const measured = workflowMetrics(row);
    const time = (value: number | null) => value === null ? 'unknown' : `${Math.round(value / 1000)}s`;
    section.append(el('p', 'work-overview-result-note', `Queue ${time(measured.queueMs)} · execution ${time(measured.executionMs)} · validation ${time(measured.validationMs)} · pre-Send reoffers ${row.preSendReoffers ?? 0}`));
    if (row.preparedContext) section.append(el('p', 'work-overview-result-note',
      `Frozen message: ${row.preparedContext.deliveredChars.toLocaleString()} characters · ${row.preparedContext.skillBodySha256.length} Skill body markers. Run ${row.workflow!.runId}.`));
    for (const [index, check] of (receipt?.checks ?? []).entries()) {
      section.append(el('p', 'work-overview-result-note', `${check.ok ? 'Passed' : 'Failed'} · ${check.kind}: ${check.detail}`));
      if (check.path) {
        const output = el('button', 'btn', `Copy output path · ${check.path}`) as HTMLButtonElement;
        output.type = 'button'; output.style.whiteSpace = 'normal'; output.style.overflowWrap = 'anywhere';
        output.onclick = () => void run(api.writeClipboard(check.path!));
        section.append(output);
        if (receipt?.status === 'verified' && check.ok && (check.kind === 'file' || check.kind === 'media') && check.sha256 && check.bytes !== undefined) {
          for (const [action, label] of [['open', 'Open file'], ['reveal', 'Show in folder']] as const) {
            const button = el('button', 'btn', label) as HTMLButtonElement;
            button.type = 'button'; button.dataset.workAction = `recipe-output-${row.id}-${index}-${action}`;
            button.onclick = async () => {
              button.disabled = true; button.setAttribute('aria-busy', 'true');
              try { await run(api.openWorkflowOutput(row.id, index, action)); }
              finally { if (button.isConnected) { button.disabled = false; button.removeAttribute('aria-busy'); } }
            };
            section.append(button);
          }
        }
      }
      if (check.sha256) section.append(el('p', 'work-overview-result-note', `SHA-256 ${check.sha256}`));
    }
    if (receipt?.status === 'failed') {
      const recheck = el('button', 'btn', 'Recheck outputs') as HTMLButtonElement;
      recheck.type = 'button'; recheck.dataset.workAction = `recipe-recheck-${row.id}`;
      recheck.onclick = async () => {
        recheck.disabled = true;
        const accepted = await run(api.recheckWorkflow(row.id));
        if (accepted) await refreshInputQueue();
        else if (recheck.isConnected) {
          recheck.disabled = false;
          recheck.textContent = 'Recheck held · reconnect the original chat and inspect its result';
        }
      };
      section.append(recheck);
    }
    nodes.push(section);
  }
  details.replaceChildren(...nodes);
  return details;
}

function paintWorkOverviewPane(): void {
  const host = document.getElementById('workOverviewPane');
  if (!host) return;
  const focusedAction = host.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset.workAction : undefined;
  const id = workOverviewSessionId;
  const selectedRow = workOverviewSelectedRow(id);
  for (const row of document.querySelectorAll<HTMLButtonElement>('.work-overview-row')) {
    if (row.dataset.workKind === 'delivery') continue;
    row.setAttribute('aria-expanded', String(row === selectedRow));
  }
  if (!id) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  // One exact selected session owns the mounted detail. Reuse its controls and
  // fields so a status/Prime refresh cannot detach a focused action or selected
  // status text; a different session must get its own detail identity.
  const sameSession = host.dataset.workResultSession === id;
  // Keep the temporary detail beside the clicked entry, including after a sidebar refresh.
  // The durable list owns the rows; this pane remains a projection of the selected session.
  if (selectedRow && host.previousElementSibling !== selectedRow) selectedRow.after(host);
  host.hidden = false;
  host.onkeydown = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeWorkOverviewPane(id);
  };
  const listedSummary = sessions.find(row => row.id === id) ?? null;
  const exactSummary = workOverviewDetailSummary?.id === id ? workOverviewDetailSummary : null;
  // The exact read can already contain a newer provider binding, active turn or
  // repaired worker origin while the paged sidebar still carries an older snapshot.
  // During a history outage the last exact read becomes historical evidence and the
  // current list remains the available status owner until a successful read returns.
  const historyUnavailable = workOverviewReadFailure === 'history' || workOverviewReadFailure === 'both';
  const summary = historyUnavailable ? listedSummary ?? exactSummary : exactSummary ?? listedSummary;
  if (!summary) {
    // Supervisor includes every held Goal/Loop, while the sidebar initially loads only
    // 60 summaries. A valid status row must still open and explain a failed exact read.
    const loading = workOverviewLoadingFor === id;
    const message = el('p', 'work-overview-empty', loading
      ? 'Reading this chat’s latest evidence-backed update…'
      : 'This chat’s saved detail could not be read. Retry to inspect its exact work and results.');
    const retry = el('button', 'btn', 'Retry read') as HTMLButtonElement;
    retry.type = 'button'; retry.dataset.workAction = 'retry';
    retry.onclick = () => void refreshWorkOverviewPane(id);
    host.replaceChildren(message, ...(loading ? [] : [retry]));
    return;
  }
  if (workOverviewLoadingFor === id && !workOverviewControls) {
    host.replaceChildren(el('div', 'work-overview-empty', 'Reading this chat’s latest evidence-backed update…'));
    return;
  }
  const missingProgress = workOverviewReadFailure === 'progress' || workOverviewReadFailure === 'both';
  const missingHistory = workOverviewReadFailure === 'history' || workOverviewReadFailure === 'both';
  // Compact & Resume keeps one local session while its provider chat changes.
  // A failed read must retain the earlier result without adopting its native
  // Send/tool events as fresh evidence for the replacement conversation.
  const previousProviderHistory = !!missingHistory && !!listedSummary && !!exactSummary &&
    listedSummary.conversationId !== exactSummary.conversationId;
  const controls = workOverviewControls?.sessionId === id ? workOverviewControls : null;
  // Controls and saved history are separate IPC reads. A provider can rebind,
  // OR start another native turn in the same provider, between those reads.
  // A's plan, acceptance, Off mode and delivered report must stay HISTORICAL,
  // not become B's current checklist/native outcome. An ended turn with null
  // controls.activeTurnId is normal; an independently known different live
  // or finish turn is required before treating a control snapshot as stale.
  const controlsCurrentProvider = !!controls && controls.conversationId === summary.conversationId;
  const knownCurrentTurn = summary.activeTurnId ??
    (summary.finishTurn?.conversationId === summary.conversationId ? summary.finishTurn.turnId : null);
  const controlsTurnMismatch = !!controls && controlsCurrentProvider && !!knownCurrentTurn &&
    (summary.activeTurnId
      ? controls.activeTurnId !== summary.activeTurnId
      : !!controls.activeTurnId && controls.activeTurnId !== knownCurrentTurn);
  const previousControls = controls && (!controlsCurrentProvider || controlsTurnMismatch) ? controls : null;
  const currentControls = controls && !previousControls ? controls : null;
  const automation = automationForSummary(summary) ??
    (() => {
      const projection = automationSupervisor?.chats.find(chat => chat.sessionId === id);
      return projection ? displayedAutomationForBinding(projection, summary) : null;
    })();
  const plan = currentControls?.plan ?? null;
  const currentStep = plan?.plan.find(step => step.status === 'in_progress') ??
    plan?.plan.find(step => step.status === 'pending') ?? null;
  const blocked = plan?.checklist?.find(item => item.status === 'blocked') ?? null;
  const latestEvidence = chronological(foldWorkAssistantRevisions(workOverviewEvents));
  const privateCustody = workOverviewHelperCustody?.sessionId === id &&
    workOverviewHelperCustody.conversationId === summary.conversationId ? workOverviewHelperCustody : null;
  // Exact current conversation controls can already say Off while the separately
  // polled supervisor still carries an older Goal/Loop projection. Preserve both
  // observations and avoid creating an unrelated helper-read blocker from the old mode.
  const controlSaysOff = !!summary.conversationId && currentControls?.sessionId === id &&
    currentControls.conversationId === summary.conversationId && currentControls.automation === 'off';
  const exactPerChatOff = controlSaysOff && (!automation || inspectedWorkModeOff(automation, summary));
  const deliveryEvidenceRead = inputQueueReadUnverified ? 'unavailable' : inputQueueLoaded ? 'available' : 'loading';
  const attention = workOverviewAttention(summary, currentControls, latestEvidence,
    deliveryEvidenceRead === 'available' ? pendingComposerInputs : [], privateCustody, workOverviewHelperCustodyRead,
    !!privateCustody || !exactPerChatOff && (automation?.mode === 'goal' || currentControls?.automation === 'goal'),
    missingHistory, missingProgress, deliveryEvidenceRead);
  const boundedHelperHold = attention.facts.some(fact => fact.label === 'Helper retry budget exhausted');
  // A durable session can retain tools from A after its frontend is rebound to B.
  // The supervisor eventually catches up to B, but that does not promote old A
  // tools into B work. Apply the per-conversation guard for the session's whole
  // recorded lineage, independent of the latest supervisor binding.
  const previousProvider = automationBySession.get(id);
  const changedProvider = previousProvider && summary.conversationId &&
    previousProvider.conversationId !== summary.conversationId ? previousProvider : null;
  const earlierProviders = summary.conversationId
    ? summary.chatIds.filter(conversation => conversation !== summary.conversationId) : [];
  const requiresProviderProof = !!changedProvider || earlierProviders.length > 0;
  // A native B turn stops being active once it finishes, but the exact
  // finish-turn identity and start time remain in the durable session summary.
  // Do not treat activeTurnId=null as permission to attribute A's late results,
  // saved answer, native Send or worker report to the completed B turn.
  const currentFinish = summary.finishTurn?.conversationId === summary.conversationId
    ? summary.finishTurn : null;
  const finishedNativeTurn = !summary.activeTurnId && !!currentFinish?.turnId &&
    currentFinish.startedAt > 0 && (!summary.lastTurnEndAt ||
      summary.lastTurnEndAt >= currentFinish.startedAt);
  const currentNativeTurnId = summary.activeTurnId ??
    (finishedNativeTurn ? currentFinish!.turnId : null);
  const exactCurrentTool = requiresProviderProof ? [...latestEvidence].reverse().find(
    (event): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
      event.kind === 'tool_call' && event.call.conversationId === summary.conversationId &&
      event.call.attributionMethod === 'request_id' &&
      (!currentNativeTurnId || event.turnId === currentNativeTurnId)) ?? null : null;
  const nativeDelivery = workOverviewNativeDelivery(id, latestEvidence, pendingComposerInputs);
  const nativeDeliveryUnbound = !!nativeDelivery && requiresProviderProof &&
    nativeDelivery.entry?.conversationId !== summary.conversationId;
  // An original A Send can survive the exact same provider's next B turn, and
  // an outbox-only Send has NO turn identity. Keep those receipts readable in
  // their own field, but never use them to claim B's latest Send or answer.
  // A positively tagged B user message is the only current-turn binding.
  const nativeDeliveryTurnUnbound = !!nativeDelivery && !!currentNativeTurnId &&
    (nativeDelivery.message?.turnId !== currentNativeTurnId ||
      !!finishedNativeTurn && !!currentFinish && nativeDelivery.receivedAt > 0 &&
        nativeDelivery.receivedAt < currentFinish.startedAt);
  const nativeDeliveryOlderTurn = !!nativeDeliveryTurnUnbound && !!nativeDelivery &&
    (nativeDelivery.message?.turnId && nativeDelivery.message.turnId !== currentNativeTurnId ||
      !!finishedNativeTurn && !!currentFinish && nativeDelivery.receivedAt > 0 &&
        nativeDelivery.receivedAt < currentFinish.startedAt);
  const currentNativeDelivery = nativeDeliveryUnbound || nativeDeliveryTurnUnbound ? null : nativeDelivery;
  // Page errors have no conversationId. Match their exact recorded turn to
  // current-provider custody before choosing which error drives B's status.
  // Delayed old-A errors can be recorded after a genuine B error; they belong
  // in history and must not hide the B hold or its page/Core evidence.
  const providerErrorBelongsToCurrent = (event: Extract<SessionEvent, { kind: 'chat_error' }>): boolean =>
    // Even without provider A→B rebinding, an exact new B turn supersedes
    // earlier A page errors. An old provider error cannot become B's hold.
    (currentNativeTurnId ? event.turnId === currentNativeTurnId :
      !requiresProviderProof || !!event.turnId &&
    (event.turnId === exactCurrentTool?.turnId ||
      event.turnId === summary.activeTurnId ||
      summary.finishTurn?.conversationId === summary.conversationId &&
        event.turnId === summary.finishTurn.turnId));
  const providerErrors = latestEvidence.filter((event): event is Extract<SessionEvent, { kind: 'chat_error' }> =>
    event.kind === 'chat_error');
  const newestProviderError = [...providerErrors].reverse().find(providerErrorBelongsToCurrent) ??
    providerErrors.at(-1) ?? null;
  const providerErrorTiedToCurrent = !!newestProviderError && providerErrorBelongsToCurrent(newestProviderError);
  const providerErrorPosition = newestProviderError ? latestEvidence.indexOf(newestProviderError) : -1;
  const newestTool = [...latestEvidence].reverse().find((event): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
    event.kind === 'tool_call' && (!currentNativeTurnId || event.turnId === currentNativeTurnId) &&
    (!requiresProviderProof ||
      event.call.conversationId === summary.conversationId && event.call.attributionMethod === 'request_id'));
  const newestFinal = [...latestEvidence].reverse().find((event): event is Extract<SessionEvent, { kind: 'assistant_message' }> =>
    event.kind === 'assistant_message' && (event.final === true || event.state === 'final'));
  // Final answers have no conversationId of their own. A local session can keep
  // a previous provider A final even after the B supervisor snapshot catches up.
  // Only exact B turn identity, request-attributed B tool-turn custody or an
  // independently paired B native answer can promote a final to CURRENT work.
  // Keep an unbound final readable; do not claim that it came from A or B.
  const finalBelongsToCurrentProvider = (
    event: Extract<SessionEvent, { kind: 'assistant_message' }>
  ): boolean => !requiresProviderProof ||
    (!!event.turnId && (event.turnId === summary.activeTurnId ||
      event.turnId === currentFinish?.turnId || event.turnId === newestTool?.turnId)) ||
    (!!currentNativeDelivery?.answer && event.seq === currentNativeDelivery.answer.seq &&
      event.messageId === currentNativeDelivery.answer.messageId);
  // The provider may be unchanged while an older A final survives into B's
  // active turn, even when B's turn_start falls outside the bounded event
  // window. Native finals without the current turn identity remain retained
  // output, never B's newly completed work.
  const finalBelongsToCurrentTurn = (
    event: Extract<SessionEvent, { kind: 'assistant_message' }>
  ): boolean => !currentNativeTurnId || event.turnId === currentNativeTurnId;
  const currentFinal = [...latestEvidence].reverse().find((event): event is Extract<SessionEvent, { kind: 'assistant_message' }> =>
    event.kind === 'assistant_message' && (event.final === true || event.state === 'final') &&
    finalBelongsToCurrentProvider(event) && finalBelongsToCurrentTurn(event));
  const providerErrorSuperseded = providerErrorPosition >= 0 && latestEvidence.slice(providerErrorPosition + 1)
    .some(event => event.kind === 'assistant_message' && event.final === true
      ? finalBelongsToCurrentProvider(event) && finalBelongsToCurrentTurn(event)
      : event.kind === 'turn_start' && !!event.turnId &&
        event.turnId !== newestProviderError?.turnId && (!requiresProviderProof ||
          event.turnId === summary.activeTurnId || event.turnId === currentFinish?.turnId ||
          event.turnId === newestTool?.turnId));
  const retainedFinal = currentFinal ?? newestFinal;
  // Only the exact worker's durable finish message is a report. Interim agent messages and
  // Prime's separately recorded acknowledgement has different custody. Relate it only
  // by the exact worker, report message id and recorded recipient session.
  const workerReport = workOverviewWorkerReport(summary, latestEvidence, requiresProviderProof);
  const mostRecentlyRecordedWorkerReport = savedWorkerReport(summary, latestEvidence);
  const historicalWorkerReport = requiresProviderProof && mostRecentlyRecordedWorkerReport !== workerReport
    ? mostRecentlyRecordedWorkerReport : null;
  // Agent reports do not carry a provider conversation id. Once this local
  // worker is rebound, only its exact current turn can make the report B's
  // latest work; an unbound late A report is still durable and readable.
  const currentWorkerTurn = summary.activeTurnId ?? currentFinish?.turnId ?? exactCurrentTool?.turnId;
  // Even without a provider rebind, an untagged previous report cannot become
  // the current active B turn merely because B's turn_start was evicted from
  // this bounded history page. Positive B identity, a witnessed B start before
  // the report, or the incumbent B finish-start receipt are required.
  const activeWorkerStart = summary.activeTurnId ? [...latestEvidence].reverse().find(
    event => event.kind === 'turn_start' && event.turnId === summary.activeTurnId) : null;
  const workerActiveTurnProof = finishedNativeTurn
    ? !!workerReport && workerReport.turnId === currentNativeTurnId
    : !summary.activeTurnId || !!workerReport && (
    workerReport.turnId === summary.activeTurnId || !workerReport.turnId && (
      !!activeWorkerStart && workerReport.seq > activeWorkerStart.seq ||
      !!currentFinish && currentFinish.turnId === summary.activeTurnId &&
        currentFinish.startedAt > 0 && workerReport.time >= currentFinish.startedAt));
  const workerReportTiedToCurrent = !!workerReport && workerActiveTurnProof && (!requiresProviderProof ||
    !!workerReport.turnId && workerReport.turnId === currentWorkerTurn);
  const currentWorkerReport = workerReportTiedToCurrent ? workerReport : null;
  // Current B can have an exact result while a complete A result remains in
  // this same bounded session read. Preserve one earlier full output as a
  // separate, on-demand disclosure without promoting it to B's current work.
  // Do not scan older pages on status refresh: the existing full Progress view
  // owns results outside the read window.
  const previousLookupKey = currentNativeTurnId && (currentFinal || currentWorkerReport)
    ? [id, summary.conversationId ?? '', currentNativeTurnId,
      currentFinal?.messageId ?? currentWorkerReport?.messageId ?? 'unidentified'].join('\u0000')
    : null;
  const previousLookup = previousLookupKey && workOverviewPreviousLookup?.sessionId === id &&
    workOverviewPreviousLookup.key === previousLookupKey ? workOverviewPreviousLookup : null;
  const previousInRecent = !!currentNativeTurnId && !!(currentFinal || currentWorkerReport)
    ? [...latestEvidence].reverse().find((event): event is Extract<SessionEvent,
        { kind: 'assistant_message' | 'agent_message' }> =>
        (event.kind === 'assistant_message' || event.kind === 'agent_message') &&
        recordedWorkResult(summary, event) && event.turnId !== currentNativeTurnId &&
        event !== currentFinal && event !== currentWorkerReport) ?? null
    : null;
  const previousSavedResult = previousLookup?.event ?? previousInRecent ?? null;
  const previousReference = previousSavedResult ?? currentFinal ?? currentWorkerReport;
  const previousReferencePosition = previousReference ? positionOf(previousReference) : 0;
  const previousVisibleOlder = !!previousReference && latestEvidence.some(event =>
    recordedWorkResult(summary, event) && event.turnId !== currentNativeTurnId &&
    positionOf(event) < previousReferencePosition);
  const canFindPrevious = !missingHistory && !!previousLookupKey && !!currentNativeTurnId &&
    previousLookup?.phase !== 'checked' &&
    (previousVisibleOlder || latestEvidence.reduce((least, event) =>
      Math.min(least, event.seq), Number.POSITIVE_INFINITY) > 1);
  const primeReceived = !!workerReport && workOverviewPrimeReceipt?.messageId === workerReport.messageId &&
    workOverviewPrimeReceipt.from === workerReport.from && summary.origin?.kind === 'worker' &&
    workOverviewPrimeReceipt.primeSessionId === summary.origin.fromSessionId;
  let primeReceiptText = primeReceived
    ? `${missingHistory ? 'Previously confirmed: ' : ''}Prime received this report · exact recipient receipt recorded ${clockTime(workOverviewPrimeReceipt!.receivedAt)}.`
    : workOverviewPrimeReceiptRead === 'checked'
      ? 'No matching receipt in the most recent Prime history; delivery remains unverified.'
      : 'Prime receipt unavailable; the worker record confirms only that the report was saved for delivery.';
  if (workerReport && !workerReportTiedToCurrent) {
    primeReceiptText += requiresProviderProof
      ? ' This saved report is not attributed to the current provider turn.'
      : ' This saved report is not attributed to the current native turn.';
  }
  const workerReportText = workerReport?.message.text.replace(/^\[[^\]\n]+ (?:reported|finished)\]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 1200) ?? '';
  const workerNext = currentWorkerReport?.message.text.match(/^\s*(?:BLOCKERS?|NEXT(?: STEPS?)?):\s*([^\r\n]+)/im)?.[1]?.trim().slice(0, 320) ?? '';
  // Compare recorder-owned chronological positions, not provider create_time: ChatGPT can
  // open its eventual final before making the last tool call of that same native turn.
  const finalPosition = currentFinal ? latestEvidence.indexOf(currentFinal) : -1;
  const retainedFinalPosition = retainedFinal ? latestEvidence.indexOf(retainedFinal) : -1;
  const toolPosition = newestTool ? latestEvidence.indexOf(newestTool) : -1;
  const workerPosition = currentWorkerReport ? latestEvidence.indexOf(currentWorkerReport) : -1;
  const retainedWorkerPosition = workerReport ? latestEvidence.indexOf(workerReport) : -1;
  const earlierFinalWhileTurnOpen = !!currentNativeTurnId && !!retainedFinal &&
    !finalBelongsToCurrentTurn(retainedFinal) &&
    newestTool?.turnId !== currentNativeTurnId && currentWorkerReport?.turnId !== currentNativeTurnId;
  const earlierToolOrErrorWhileTurnOpen = !!currentNativeTurnId && !currentFinal && !newestTool &&
    !currentWorkerReport && latestEvidence.some(event =>
      (event.kind === 'tool_call' || event.kind === 'chat_error') &&
      !!event.turnId && event.turnId !== currentNativeTurnId);
  const earlierWorkerWhileTurnOpen = !!currentNativeTurnId && !!workerReport &&
    !workerReportTiedToCurrent && !currentFinal && !newestTool;
  // Compact & Resume and an interrupted/stalled turn both retain an older final.
  // An ended turn clears activeTurnId, but its durable turn_start still supersedes
  // the old result. Without that boundary check, a newer failed/no-output turn
  // misleadingly reads as "Just did: Recorded final" from the previous turn.
  // A reopened start for the *same* exact turn is not a new result owner.
  const newestStart = currentNativeTurnId
    ? [...latestEvidence].reverse().find(event => event.kind === 'turn_start' && event.turnId === currentNativeTurnId)
    : [...latestEvidence].reverse().find(event => event.kind === 'turn_start');
  // The last saved final may be historical A evidence. It must NOT become B's
  // current final, but its older time still establishes that B's later finish
  // turn has no new result when the turn_start fell outside the 80-event tail.
  const resultCandidates: Array<SessionEvent | null | undefined> = [newestFinal, newestTool, workerReport];
  const latestResultEvents = resultCandidates.filter((event): event is SessionEvent => !!event);
  // An unusually long progress-only turn can push even its turn_start out of the recent
  // event window. The store's current finish-turn owner still proves that a retrieved old
  // final/report is historical; the missing turn_start must not promote it as a fresh final.
  const newerTurnOutsideWindow = !!currentFinish && currentFinish.startedAt > 0 &&
    latestResultEvents.length > 0 && latestResultEvents.every(event =>
      event.turnId ? event.turnId !== currentFinish.turnId && event.time < currentFinish.startedAt
        : event.time < currentFinish.startedAt);
  // The native outbox proves delivery, not that delivery was the last useful action.
  // Its clock is Main-owned; visible user/tool/error rows use recorder positions.
  // A tool outcome or provider error after Send must remain the headline evidence.
  const newerUnansweredNativeSend = !!currentNativeDelivery?.confirmed && !currentNativeDelivery.answer &&
    (currentNativeDelivery.message
      ? (currentNativeDelivery.message.inputDelivery === 'confirmed' ||
          currentNativeDelivery.message.inputDelivery === 'offered' &&
            currentNativeDelivery.entry?.id === currentNativeDelivery.message.inputId) &&
        positionOf(currentNativeDelivery.message) >
          Math.max(currentFinal ? positionOf(currentFinal) : 0, currentWorkerReport ? positionOf(currentWorkerReport) : 0,
            newestTool ? positionOf(newestTool) : 0, providerErrorTiedToCurrent && newestProviderError ? positionOf(newestProviderError) : 0)
      : currentNativeDelivery.receivedAt >
        Math.max(currentFinal?.time ?? 0, currentWorkerReport?.time ?? 0, newestTool?.time ?? 0,
          providerErrorTiedToCurrent ? newestProviderError?.time ?? 0 : 0));
  const newerUnconfirmedHandout = currentNativeDelivery?.message?.inputDelivery === 'offered' &&
    !currentNativeDelivery.confirmed && latestEvidence.indexOf(currentNativeDelivery.message) >
    Math.max(finalPosition, toolPosition, workerPosition, providerErrorPosition);
  const providerErrorIsLatest = !!newestProviderError && providerErrorTiedToCurrent && !providerErrorSuperseded &&
    providerErrorPosition > Math.max(finalPosition, toolPosition, workerPosition) &&
    !newerUnansweredNativeSend && !newerUnconfirmedHandout;
  const awaitingNewTurnResult = earlierFinalWhileTurnOpen || earlierToolOrErrorWhileTurnOpen || earlierWorkerWhileTurnOpen ||
    newerTurnOutsideWindow || newerUnansweredNativeSend || newerUnconfirmedHandout || (!!newestStart &&
    latestEvidence.indexOf(newestStart) > Math.max(finalPosition, toolPosition, workerPosition) &&
    ![currentFinal?.turnId, newestTool?.turnId, currentWorkerReport?.turnId]
      .some(turnId => turnId && turnId === newestStart.turnId));
  // A late recorded tool can have started before the worker report, so the store's
  // start-time summary can legitimately keep that report current. A distinct
  // newer turn supersedes it, but a same-ID turn reopen is not a distinct turn.
  // Require an exact report turn ID or the store's current turn-start custody;
  // an untagged report plus a later page start alone cannot establish that boundary.
  const newerWorkerTurnTool = !!newestStart?.turnId && newestTool?.turnId === newestStart.turnId &&
    workerPosition >= 0 && latestEvidence.indexOf(newestStart) > workerPosition &&
    toolPosition > latestEvidence.indexOf(newestStart) && !!currentWorkerReport &&
    (currentWorkerReport.turnId
      ? currentWorkerReport.turnId !== newestStart.turnId
      : summary.finishTurn?.conversationId === summary.conversationId &&
        summary.finishTurn.turnId === newestStart.turnId && summary.finishTurn.startedAt > currentWorkerReport.time);
  const workerReportIsNewest = workerPosition >= 0 && workerPosition >= finalPosition &&
    (workerPosition >= toolPosition ||
      (!newerWorkerTurnTool && !!summary.lastFinishReportAt &&
        summary.lastFinishReportAt >= (summary.lastToolCallAt ?? 0)));
  const toolProof = newestTool ? toolCallSummary(newestTool.call) : null;
  const toolStatus = newestTool ? workOverviewToolOutcome(newestTool.call.outcome) : '';
  const finalIsNewest = finalPosition >= 0 && finalPosition > toolPosition;
  const finalExcerpt = currentFinal?.message.text.replace(/\s+/g, ' ').trim().slice(0, 320) ?? '';
  // A terminal status is the recorder's durable last-turn outcome. If its exact
  // end is later than every available result/tool, don't headline an old tool
  // timestamp as "Just did" merely because the turn_end fell outside the bounded
  // history read. On a rebound require current-provider finish ownership.
  const ordinaryEnd = !automation && !recordedWorkerId(summary)
    ? ordinaryTerminalOutcome(summary) : null;
  const currentTurnToolFailure = !!newestTool?.turnId && newestTool.call.outcome !== 'ok' &&
    (newestTool.turnId === newestStart?.turnId ||
      summary.finishTurn?.conversationId === summary.conversationId &&
        newestTool.turnId === summary.finishTurn.turnId);
  const terminalIsLastKnown = !!ordinaryEnd && !!summary.lastTurnEndAt &&
    (!requiresProviderProof || !!currentFinish) && !currentTurnToolFailure &&
    summary.lastTurnEndAt >= Math.max(newestTool?.time ?? 0, currentFinal?.time ?? 0,
      currentWorkerReport?.time ?? 0, summary.lastAssistantFinalAt ?? 0);
  // A newer tool failure or an empty/failed next turn changes the CURRENT status, not the
  // ownership of an earlier useful answer. Select the newest retained result separately from
  // Just did; otherwise an outcome after that result makes its disclosure disappear entirely.
  const retainedWorkerIsLast = !!workerReport && retainedWorkerPosition >= retainedFinalPosition;
  const retainedResult = retainedWorkerIsLast && workerReport
    ? { id: workerReport.messageId, label: missingHistory ? 'Read last confirmed saved worker report' :
          awaitingNewTurnResult || providerErrorIsLatest || !workerReportIsNewest || !workerReportTiedToCurrent
            ? 'Read previous saved worker report' : 'Read saved worker report',
        body: workerReport.message.text.replace(/^\[[^\]\n]+ (?:reported|finished)\]\s*/, ''),
        truncated: workerReport.message.truncated, recordedAt: workerReport.time }
    : retainedFinal
      ? { id: retainedFinal.messageId, label: missingHistory ? 'Read last confirmed recorded final answer' :
            awaitingNewTurnResult || providerErrorIsLatest || !finalIsNewest || !currentFinal
              ? 'Read previous recorded final answer' : 'Read recorded final answer',
          body: retainedFinal.message.text, truncated: retainedFinal.message.truncated, recordedAt: retainedFinal.time }
      : null;
  const justDid = missingHistory
    ? latestEvidence.length
      ? 'Latest history unavailable; the saved result and tool details below are from the last confirmed read.'
      : 'Latest history unavailable; no exact current result or tool outcome can be confirmed.'
    : providerErrorIsLatest
      ? `Provider error recorded: ${newestProviderError!.message.text.replace(/\s+/g, ' ').trim().slice(0, 240) || 'details unavailable'}; recovery is unconfirmed.`
    : newerUnansweredNativeSend
      ? `Native input delivered; no matching answer recorded in this exact read${!summary.activeTurnId && summary.lastTurnOutcome ? ` · last turn ${TURN_OUTCOME_LABELS[summary.lastTurnOutcome]}` : ''}.`
    : newerUnconfirmedHandout
      ? 'Tool handout offered; native Send and answer remain unconfirmed. Earlier results and receipts are retained below.'
    : awaitingNewTurnResult
    ? !summary.activeTurnId && summary.lastTurnOutcome
      ? `Latest turn ${TURN_OUTCOME_LABELS[summary.lastTurnOutcome]}; no exact final or tool outcome recorded. Earlier saved output belongs to another native turn and remains readable below.`
      : earlierFinalWhileTurnOpen || earlierToolOrErrorWhileTurnOpen || earlierWorkerWhileTurnOpen
      ? 'New turn recorded; no exact current-turn final or tool outcome yet. Earlier saved output remains readable below.'
      : 'New turn started; no exact final or tool outcome yet.'
    : terminalIsLastKnown
    ? `Last recorded turn ${TURN_OUTCOME_LABELS[ordinaryEnd!]}; ended ${clockTime(summary.lastTurnEndAt!)}. No newer exact result is proven.`
    : workerReportIsNewest
    ? `Worker report saved for Prime: ${workerReportText || 'Result text is not retained in the recent event window.'}`
    : finalIsNewest && currentFinal
    ? finalExcerpt ? `Recorded final: ${finalExcerpt}` : `Latest final recorded ${ago(currentFinal.time)} (no retained text).`
    : toolProof ? `${toolStatus ? `${toolStatus} · ` : ''}${toolProof.title}${toolProof.detail ? ` · ${toolProof.detail}` : ''}${toolProof.metric ? ` · ${toolProof.metric}` : ''}`
      : exactPerChatOff && automation
        ? `Latest exact controls: Goal/Loop Off for this chat. Previous supervisor reported ${automationStateLabel(automation)}; no current native execution is proven.`
        : boundedHelperHold
          ? 'The bounded helper attempts failed; the original saved work is retained. No new native Send or active generation is proven.'
          : automation?.reason ||
        (recordedWorkerId(summary) && summary.lastFinishReportAt && summary.lastFinishReportAt >= (summary.lastToolCallAt ?? 0)
          ? `Worker finish report saved ${ago(summary.lastFinishReportAt)}; its text is outside the recent event window.` :
          summary.lastAssistantFinalAt ? requiresProviderProof
            ? 'A final answer is retained for this local session; current-provider final association remains unverified.'
            : `Latest final recorded ${ago(summary.lastAssistantFinalAt)}; text is outside the recent event window.` :
          summary.lastToolCallAt ? requiresProviderProof
            ? 'No exact current-provider Core outcome in this bounded read; the session-wide tool timestamp may belong to earlier work.'
            : `Latest exact tool call recorded ${ago(summary.lastToolCallAt)}.` :
            'No recent final or exact tool evidence is recorded.');
  const provenCurrentTool = (event: SessionEvent): boolean =>
    event.kind === 'tool_call' && (!currentNativeTurnId || event.turnId === currentNativeTurnId) &&
    (!requiresProviderProof ||
      event.call.conversationId === summary.conversationId && event.call.attributionMethod === 'request_id');
  const changedPaths = [...new Set(workOverviewEvents.flatMap(event =>
    provenCurrentTool(event) && event.kind === 'tool_call' && event.call.outcome === 'ok'
      ? (event.call.changes ?? []).map(change => change.path)
      : []))].slice(-6);
  const historicalPaths = requiresProviderProof || !!currentNativeTurnId ? [...new Set(workOverviewEvents.flatMap(event =>
    event.kind === 'tool_call' && !provenCurrentTool(event) && event.call.outcome === 'ok'
      ? (event.call.changes ?? []).map(change => change.path)
      : []))].slice(-6) : [];
  const changeStats = sessionChangeStats(summary);
  const changes = requiresProviderProof || !!currentNativeTurnId
    ? changedPaths.length
      ? `Exact ${currentNativeTurnId ? 'current-turn' : 'current-provider'} changes recorded: ${changedPaths.join(' · ')}. Session-wide edit totals include earlier work.`
      : `No exact ${currentNativeTurnId ? 'current-turn' : 'current-provider'} file changes in the bounded read; saved earlier edits remain part of this local session.`
    : changedPaths.length
    ? `${changeStats ? `${changeStats} · ` : ''}${changedPaths.join(' · ')}`
    : changeStats || 'No typed file-change evidence is recorded in the recent session window.';
  const requirementsText = missingProgress
    ? 'Progress and checklist unavailable until the read succeeds.'
    : previousControls ? 'Current-provider acceptance checklist unverified. The previous control snapshot is retained separately below.'
    : acceptanceStatusSummary(plan) ?? 'No acceptance checklist is recorded for this chat.';
  const blockerText = blocked
    ? `${blocked.blocker ?? blocked.requirement}${blocked.nextExperiment ? ` Next: ${blocked.nextExperiment}` : ''}`
    : exactPerChatOff && automation
      ? 'Off for this chat; no new Goal/Loop turn is scheduled by this setting. Review the retained result and historical supervisor hold before deciding whether to resume. Native Send and current execution still require exact receipts.'
    : automation?.nextAction ||
      (summary.conversationId && blockedChats.has(summary.conversationId)
        ? 'Review this conversation’s existing local block and retained evidence before authorizing more app-authored work.' : '') ||
      (workerNext ? `Worker reported: ${workerNext}` : '') ||
      (providerErrorIsLatest ? 'Check the provider account and model; inspect the saved error before continuing. Do not automatically resend an unconfirmed input.' : '') ||
      (!automation && !!summary.activeTurnId && !sessionWorking(summary)
        ? 'Inspect the exact provider turn and latest Core/tool receipt. An old activity signal alone cannot prove completion or authorize another Send.' : '') ||
      (!finalIsNewest && toolStatus && toolProof
        ? `Latest tool outcome: ${toolStatus.toLowerCase()} · ${toolProof.title}. Inspect its recorded error before a new attempt.`
        : 'No evidence-backed blocker is currently projected.');
  const statusText = automation && exactPerChatOff
    ? `Goal/Loop Off for this chat (exact controls). A separate supervisor observation reports ${automationStateLabel(automation)}: ${automation.reason}. Current native execution and the older holds remain unverified.`
    : automation
    ? [automationStateLabel(automation), boundedHelperHold
        ? `helper retry budget exhausted in latest matching Goal/Loop controls; ${deps.state()?.config.ui.automationPaused === true
          ? 'account-wide automation is also paused' : 'automatic helper creation is held'}; no current native generation or original Send is proven`
        : automation.reason,
      finishedNativeTurn && !!summary.lastTurnOutcome
        ? `Last recorded native turn ${currentNativeTurnId} ${TURN_OUTCOME_LABELS[summary.lastTurnOutcome]}; the supervisor state is a separate observation, not proof that this turn is still working.` : '',
      automation.nextAction ? `Next: ${automation.nextAction}` : ''].filter(Boolean).join(' · ')
    : summary.conversationId && blockedChats.has(summary.conversationId)
      ? 'Local conversation block is active. Current execution is not established; earlier native work and saved outputs remain separate evidence.'
    : ordinaryTerminalOutcome(summary)
      ? `Last turn ${t(TURN_OUTCOME_LABELS[ordinaryTerminalOutcome(summary)!])}; no current execution is proven. Inspect the saved record before continuing.`
    : providerErrorIsLatest
      ? 'Last recorded provider error; provider status unknown. No recovered generation is confirmed.'
    : summary.activeTurnId
      ? sessionWorking(summary)
        ? 'Turn open; current execution has not been confirmed.'
        : 'Turn open with no recent work signal; current execution and completion are unverified.'
      : sessionWorking(summary)
        ? 'Recent work signal recorded; current execution has not been confirmed.'
        : 'Idle; no current work signal recorded.';
  const toolEvidenceText = !!currentNativeTurnId && !newestTool && !!summary.lastToolCallAt
    ? `The last recorded tool timestamp may belong to an earlier native turn; no matching tool outcome for ${currentNativeTurnId} was found in this bounded read.${requiresProviderProof && !exactCurrentTool ? ' The timestamp may also belong to the previous provider; current-provider tool execution is unverified.' : ''}`
    : requiresProviderProof
    ? exactCurrentTool
      ? `Exact current-provider Core call recorded ${clockTime(exactCurrentTool.time)}; this does not independently prove ongoing generation.`
      : 'The session-wide tool timestamp may belong to the previous provider; current-provider tool execution is unverified.'
    : typeof summary.lastToolCallAt === 'number' && summary.lastToolCallAt > 0
    ? `Last exact local tool recorded ${new Date(summary.lastToolCallAt).toLocaleString(currentLanguage())}; this timestamp alone does not prove current execution.`
    : 'No exact local tool execution timestamp is recorded.';
  const report = workOverviewReportLabel(currentControls, workOverviewEvents);
  const recordedHistory = latestEvidence.flatMap(event => {
    if (event.kind === 'tool_call') {
      const proof = toolCallSummary(event.call);
      const paths = event.call.outcome === 'ok' ? (event.call.changes ?? []).map(change => change.path).slice(0, 2) : [];
      const scope = !provenCurrentTool(event)
        ? requiresProviderProof && event.call.conversationId && event.call.conversationId !== summary.conversationId
          ? 'Historical provider tool'
          : currentNativeTurnId ? 'Earlier turn tool · current attribution unverified' : 'Unverified provider attribution'
        : '';
      const detail = [scope, workOverviewToolOutcome(event.call.outcome), proof.title, proof.detail,
        paths.length ? paths.join(' · ') : proof.metric]
        .filter(Boolean).join(' · ');
      return [{ time: event.time, detail }];
    }
    if (event.kind === 'assistant_message' && event.final === true) {
      return [{ time: event.time, detail: currentNativeTurnId && !finalBelongsToCurrentTurn(event)
        ? 'Earlier-turn: Final answer recorded · current turn result unverified'
        : requiresProviderProof && !finalBelongsToCurrentProvider(event)
        ? 'Final answer recorded · provider association unverified'
        : 'Final answer recorded' }];
    }
    if (event.kind === 'chat_error') return [{ time: event.time,
      detail: !providerErrorBelongsToCurrent(event)
        ? requiresProviderProof
          ? 'Earlier provider error recorded; current provider association unverified'
          : 'Earlier provider error recorded; current turn association unverified'
        : 'Provider error recorded; recovery unconfirmed' }];
    if (nativeDelivery && event === nativeDelivery.message) return [{ time: event.time,
      detail: nativeDeliveryTurnUnbound && !nativeDeliveryUnbound
        ? `${nativeDeliveryOlderTurn ? 'Earlier-turn' : 'Unbound'} Native Send ${nativeDelivery.confirmed ? 'confirmed' : 'unconfirmed'} · current native turn ${currentNativeTurnId} has no proven receipt`
        : nativeDeliveryUnbound
        ? nativeDelivery.entry?.conversationId && nativeDelivery.entry.conversationId !== summary.conversationId
          ? `Previous-provider Native Send ${nativeDelivery.confirmed ? 'confirmed' : 'unconfirmed'} · current provider Send unverified`
          : 'Unbound native delivery evidence; current provider Send unverified'
        :
        event.inputDelivery === 'confirmed'
        ? `Native Send confirmed · ${nativeDelivery.answer ? 'exact reply recorded' : 'answer not confirmed'}${nativeDelivery.entry?.state === 'cancelled' ? ' · later cancelled, original delivery retained' : ''}`
        : nativeDelivery.confirmed && nativeDelivery.entry?.id === event.inputId
          ? 'Tool handout offered · separate outbox now confirms native Send'
          : 'Tool handout offered · native receipt and answer remain unconfirmed' }];
    if (savedWorkerReport(summary, [event]) === event) return [{ time: event.time,
      detail: requiresProviderProof && (event !== workerReport || !workerReportTiedToCurrent)
        ? 'Saved worker report · provider association unverified · ' +
          (event === workerReport && primeReceived ? 'exact Prime receipt confirmed' : 'Prime delivery unknown')
        : currentNativeTurnId && (event !== workerReport || !workerReportTiedToCurrent)
          ? 'Saved worker report · current turn association unverified · ' +
            (event === workerReport && primeReceived ? 'exact Prime receipt confirmed' : 'Prime delivery unknown')
        : event === workerReport && primeReceived ? 'Worker finish report saved · exact Prime receipt confirmed'
          : 'Worker finish report saved · Prime delivery unknown' }];
    return [];
  });
  // A native Send can survive only in the outbox when its user row is beyond
  // the bounded recorder window. Where recorded clock ordering is unambiguous,
  // show that receipt between an older result and newer actions, rather than
  // leaving an older final or receipt as the last thing that happened.
  // If provider create_time reverses recorder chronology, preserve recorded
  // order and leave the receipt in its separate exact-custody field instead.
  const timesOrdered = recordedHistory.every((entry, i) => i === 0 || entry.time >= recordedHistory[i - 1]!.time);
  const handoutLaterConfirmed = nativeDelivery?.message?.inputDelivery === 'offered' &&
    nativeDelivery.entry?.id === nativeDelivery.message.inputId &&
    nativeDelivery.receivedAt > nativeDelivery.message.time;
  if (nativeDelivery?.confirmed && (!nativeDelivery.message || handoutLaterConfirmed) &&
      timesOrdered && nativeDelivery.receivedAt > Math.max(newestFinal?.time ?? 0, workerReport?.time ?? 0)) {
    const later = recordedHistory.findIndex(entry => entry.time > nativeDelivery.receivedAt);
    recordedHistory.splice(later < 0 ? recordedHistory.length : later, 0, { time: nativeDelivery.receivedAt,
      detail: `${nativeDeliveryUnbound ? 'Previous-provider Native Send confirmed' : nativeDeliveryTurnUnbound
        ? `${nativeDeliveryOlderTurn ? 'Earlier-turn' : 'Unbound'} Native Send confirmed` : 'Native Send confirmed'} · retained outbox receipt · ${nativeDelivery.entry?.state === 'cancelled'
        ? 'later cancelled · ' : nativeDelivery.entry?.state === 'failed' ? 'outbox later failed · ' : ''}${nativeDelivery.answer ? 'exact reply recorded' : 'answer not confirmed'}` });
  }
  if (nativeDelivery?.previousConfirmed && nativeDelivery.previousOrderKnown && timesOrdered) {
    const previous = nativeDelivery.previousConfirmed;
    const later = recordedHistory.findIndex(entry => entry.time > previous.deliveredAt!);
    recordedHistory.splice(later < 0 ? recordedHistory.length : later, 0, { time: previous.deliveredAt!,
      detail: `Earlier Native Send confirmed · retained outbox receipt · input ${previous.id} · ` +
        `${previous.state === 'cancelled' ? 'later cancelled · ' : ''}newer handout is still unconfirmed` });
  }
  const history = recordedHistory.slice(-5).reverse();
  const recordedTool = [...latestEvidence].reverse().find(
    (event): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
      event.kind === 'tool_call') ?? null;
  const recordedToolIsCurrent = !!recordedTool && provenCurrentTool(recordedTool) &&
    // A B turn may finish with no new tool. The same-provider A tool retains
    // its text, but must not borrow B's completed controls or native status.
    (!!summary.activeTurnId || !currentFinish || recordedTool.turnId === currentFinish.turnId);
  const previousToolLookupKey = recordedTool?.call.result.text.trim()
    ? [id, summary.conversationId ?? '', currentNativeTurnId ?? '', recordedTool.seq,
      recordedTool.call.callId, recordedTool.turnId ?? ''].join('\u0000') : null;
  const previousToolLookup = previousToolLookupKey && workOverviewPreviousToolLookup?.sessionId === id &&
    workOverviewPreviousToolLookup.key === previousToolLookupKey ? workOverviewPreviousToolLookup : null;
  const previousToolReference = previousToolLookup?.event ?? recordedTool;
  const previousToolHasOlderRecent = !!previousToolReference && latestEvidence.some(event =>
    event.kind === 'tool_call' && !!event.call.result.text.trim() &&
    positionOf(event) < positionOf(previousToolReference));
  const oldestEvidenceSeq = latestEvidence.reduce((oldest, event) => Math.min(oldest, event.seq),
    Number.POSITIVE_INFINITY);
  const canFindPreviousTool = !missingHistory && !!previousToolLookupKey && !!previousToolReference &&
    (previousToolHasOlderRecent || previousToolLookup?.phase !== 'checked' &&
      (previousToolLookup?.phase === 'found' || previousToolLookup?.phase === 'unavailable' ||
        Number.isFinite(oldestEvidenceSeq) && oldestEvidenceSeq > 1));
  const head = (sameSession ? host.querySelector<HTMLElement>(':scope > .work-overview-pane-head') : null) ??
    el('div', 'work-overview-pane-head');
  const title = head.querySelector<HTMLElement>('strong') ?? el('strong');
  if (title.textContent !== summary.title) title.textContent = summary.title;
  title.id = 'workOverviewPaneTitle';
  const close = head.querySelector<HTMLButtonElement>('button[data-work-action="close"]') ??
    el('button', 'btn btn-icon', '×') as HTMLButtonElement;
  close.type = 'button'; close.setAttribute('aria-label', 'Close Work & updates detail');
  close.dataset.workAction = 'close';
  close.onclick = () => closeWorkOverviewPane(id);
  reconcileChildren(head, [title, close]);
  const grid = (sameSession ? host.querySelector<HTMLElement>(':scope > .work-overview-pane-grid') : null) ??
    el('div', 'work-overview-pane-grid');
  const previousFields = new Map([...grid.querySelectorAll<HTMLElement>(':scope > .work-overview-pane-field')]
    .map(row => [row.querySelector('b')?.textContent ?? '', row]));
  const field = (label: string, value: string): HTMLElement => {
    const row = previousFields.get(label) ?? el('div', 'work-overview-pane-field');
    const name = row.querySelector<HTMLElement>('b') ?? el('b');
    const content = row.querySelector<HTMLElement>('span') ?? el('span');
    if (name.textContent !== label) name.textContent = label;
    if (content.textContent !== value) content.textContent = value;
    reconcileChildren(row, [name, content]);
    return row;
  };
  const attentionText = attention.facts.length
    ? `Recorded separately: ${attention.facts.map(fact => fact.label).join(' · ')}\n\n` +
      attention.facts.map(fact => `${fact.label}: ${fact.detail}\nNext: ${fact.action}`).join('\n\n')
    : '';
  const fields = [
    field('Just did', justDid),
    field('Current status', `${statusText} ${toolEvidenceText}`),
    // Holds and the human-safe next action outrank long provenance metadata.
    // At 200% zoom, placing this after Evidence source/Automation made an
    // approval or ambiguous native Send invisible until a deep pane scroll.
    ...(attentionText ? [field('Status & next action', attentionText)] : []),
    field('Evidence source',
      `Saved local session ${id} · current provider ${summary.conversationId ?? 'unbound'} · ` +
      `history ${missingHistory ? 'last confirmed / latest read unavailable' : 'exact session read'} · ` +
      `controls ${previousControls && controlsTurnMismatch
        ? `prior/different turn ${previousControls.activeTurnId ?? 'unbound'} · current turn ${knownCurrentTurn ?? 'unknown'} · not current`
        : previousControls
        ? `previous/different provider ${previousControls.conversationId ?? 'unbound'} · not current`
        : currentControls && !!summary.activeTurnId && currentControls.activeTurnId === summary.activeTurnId
        ? 'same-provider current-turn snapshot' : currentControls
        ? 'same-provider snapshot'
        : 'unavailable'} · ` +
      `supervisor ${automationSupervisor ? `observed ${clockTime(automationSupervisor.observedAt)} · separate scheduler observation` : 'unavailable'}. ` +
      'Observation times and recorded outputs do not prove a live native generation or a completed Send.'),
    ...(exactPerChatOff && !automation
      ? [field('Automation setting', 'Off for this chat · this setting does not schedule new Goal or Loop work. ' +
          'A native turn or saved result can still be present; the account-wide pause is a separate control.')]
      : []),
    ...(controlSaysOff && !exactPerChatOff && automation
      ? [field('Automation binding', automation.bindingUnverified
        ? 'Current-provider controls report Off, while the supervisor still references the previous provider. ' +
          'Neither previous-provider execution nor native Send completion is established for this new chat.'
        : 'A per-chat Off control was read before a newer supervisor observation. ' +
          'Its present applicability is unverified until a fresh same-provider read succeeds.')]
      : []),
    field('Changes', missingHistory ? `Last known changes (history unavailable): ${changes}` : changes),
    field('Current task', missingProgress ? 'Current plan unavailable until the read succeeds.' :
      previousControls ? 'Current-provider plan unverified; an earlier provider control snapshot is retained below.' :
      currentStep ? `${currentStep.step}${currentStep.details ? ` — ${currentStep.details}` : ''}` : summary.title),
    field('Requirements', requirementsText),
    field('Next / blocker', blockerText)
  ];
  if (previousControls) {
    const earlierPlan = previousControls.plan?.plan?.map(step =>
      `${step.status}: ${step.step}${step.details ? ` — ${step.details}` : ''}`).slice(0, 3).join(' · ') ?? '';
    const earlierAcceptance = previousControls.plan
      ? acceptanceStatusSummary(previousControls.plan) ?? '' : '';
    const scope = controlsTurnMismatch
      ? `Controls read for turn ${previousControls.activeTurnId ?? 'unknown'} of the same provider ` +
        `${summary.conversationId ?? 'unbound'}, but latest saved session history identifies turn ${knownCurrentTurn ?? 'unknown'}. `
      : `Control read belongs to provider ${previousControls.conversationId ?? 'unknown'}, but the latest saved history belongs to ` +
        `${summary.conversationId ?? 'unbound'}. `;
    fields.push(field('Control snapshot boundary',
      `${scope}Older controls are not current Send, Goal/Loop, completion, or checklist proof. ` +
      `${earlierPlan ? `Earlier saved steps: ${earlierPlan.slice(0, 350)}. ` : ''}` +
      `${earlierAcceptance ? `Earlier checklist: ${earlierAcceptance.slice(0, 350)}. ` : ''}` +
      'Retry the existing Work read to verify the current provider and turn without replaying messages.'));
  }
  if (attention.facts.length) fields.find(field =>
    field.querySelector('b')?.textContent === 'Status & next action')?.classList.add('is-work-attention');
  if (requiresProviderProof) {
    const currentEvidence = exactCurrentTool
      ? `exact Core call ${exactCurrentTool.call.callId} · ${toolCallSummary(exactCurrentTool.call).title} · ${workOverviewToolOutcome(exactCurrentTool.call.outcome) || 'recorded success'} · ${clockTime(exactCurrentTool.time)}. This confirms one recorded call, not current liveness or native Send.`
      : 'No exact attributed Core call in this bounded current-provider read; later or unavailable evidence remains unknown.';
    const previousEvidence = changedProvider
      ? `Previous provider ${changedProvider.conversationId}: ${AUTOMATION_STATE_LABEL[changedProvider.state]} was the last supervisor status (historical, not current).`
      : `Previous provider ${earlierProviders.join(', ')} is retained in this local session (historical; its status is not the current supervisor status).`;
    fields.push(field('Provider transition evidence',
      `${previousEvidence} Current provider ${summary.conversationId}: ${currentEvidence}`));
  }
  if (historicalPaths.length) fields.push(field('Historical changes',
    `Retained ${requiresProviderProof ? 'previous-provider, ' : ''}previous-turn or attribution-unverified files: ${historicalPaths.join(' · ')}. These edits are not proof of this native turn's work; session-wide total: ${changeStats || 'unavailable'}.`));
  if (newestProviderError) {
    const errorBody = newestProviderError.message.text.replace(/\s+/g, ' ').trim().slice(0, 240);
    fields.push(field('Provider evidence',
      `${!providerErrorTiedToCurrent
        ? 'Recorded provider error not tied to the current provider turn'
        : providerErrorSuperseded ? 'Earlier recorded provider error' : 'Last recorded provider error'}: ` +
      `${errorBody || 'Recorded error text unavailable'} · ` +
      `observed ${clockTime(newestProviderError.time)}. This recorded error does not prove a current provider restriction or successful recovery.`));
  }
  if (newestProviderError?.reason === 'stream_gone' && providerErrorTiedToCurrent && exactCurrentTool &&
      newestProviderError.turnId && exactCurrentTool.turnId === newestProviderError.turnId) {
    fields.push(field('Page & Core evidence', exactCurrentTool.time > newestProviderError.time
      ? `Provider page interruption recorded in the same recorded turn ${newestProviderError.turnId}. Core work recorded after page interruption at ${clockTime(exactCurrentTool.time)}; page recovery unverified. A recorded Core call is not proof of current generation. Use the existing Chrome recovery owner.`
      : `Provider page interruption recorded in the same recorded turn ${newestProviderError.turnId}, after the last exact Core call. Further Core work and page recovery unverified; wait for existing recovery evidence.`));
  }
  if (nativeDelivery) fields.push(field('Native delivery & answer',
    workOverviewNativeDeliveryLabel(nativeDelivery, missingHistory || inputQueueReadUnverified) +
    (nativeDeliveryUnbound
      ? ' · Recorded for the previous provider conversation or an unbound provider; this receipt does not prove a native Send or answer for the current provider.'
      : nativeDeliveryTurnUnbound
      ? ` · ${nativeDeliveryOlderTurn ? 'Earlier-turn' : 'Turn-unbound'} receipt: original recorded turn ${nativeDelivery.message?.turnId ?? 'unverified / outbox-only'}; current turn ${currentNativeTurnId}. This retained receipt does not confirm native Send or answer for the current turn.`
      : previousProviderHistory
      ? ' · Saved under the previous provider conversation; not proof of a native Send or answer to the current conversation.'
      : '')));
  if (previousProviderHistory) fields.push(field('Recorded history boundary',
    'Latest exact history unavailable for the current conversation; the saved result, tool and delivery evidence above belongs to the previous provider conversation. Open full chat / Progress to inspect current work; do not replay an uncertain input.'));
  if (nativeDelivery?.previousConfirmed) fields.push(field(
    nativeDelivery.previousOrderKnown ? 'Earlier native delivery' : 'Separate native delivery',
    workOverviewEarlierNativeDeliveryLabel(nativeDelivery.previousConfirmed, nativeDelivery.previousOrderKnown)));
  if (privateCustody && (privateCustody.retainedTotal || privateCustody.pendingOriginalReply)) {
    const pendingReply = privateCustody.pendingOriginalReply
      ? `Goal decision pending · source reply recorded ${clockTime(privateCustody.pendingOriginalReply.acceptedAt)} · helper acceptance and delivery tracked separately`
      : 'No pending original Goal reply is recorded in this snapshot';
    fields.push(field('Private helper & Goal reply',
      `${privateCustody.retainedTotal} retained private helpers · ${pendingReply}${workOverviewHelperCustodyRead === 'unavailable'
        ? ' · Last confirmed helper custody; latest read unavailable' : ''}. Saved helper answers do not prove delivery of the original Goal reply.`));
  } else if (privateCustody && workOverviewHelperCustodyRead === 'checked' && automation) {
    fields.push(field('Private helper & Goal reply',
      'Latest exact read: no retained private helpers or pending original Goal reply recorded. This does not establish task completion.'));
  } else if (workOverviewHelperCustodyRead === 'unavailable' && automation) {
    fields.push(field('Private helper & Goal reply',
      exactPerChatOff
        ? 'Helper custody unavailable for the earlier Goal state while this chat is Off; prior native Send, accepted answer and original Goal-reply status are unknown. This is historical custody, not proof of current helper execution.'
        : 'Helper custody unavailable; native Send, accepted answer and original Goal-reply status are unknown until a successful read.'));
  }
  if (workerReport) {
    fields.push(field('Worker report', `Saved for Prime. ${workerReportText}${workerReport.message.truncated ? ' [recorded text truncated]' : ''}`));
    fields.push(field('Prime receipt', primeReceiptText));
  }
  if (workOverviewEarlierResult?.sessionId === id && !workOverviewEarlierResult.complete &&
      (summary.lastAssistantFinalAt || summary.lastFinishReportAt)) {
    fields.push(field('Older result', retainedResult
      ? 'A previous result is readable, but older history is temporarily unavailable or exceeds this bounded preview. Its rank among all saved results is unverified; open full chat / Progress to inspect earlier pages.'
      : 'A saved result is known, but its exact body is beyond the bounded Work preview or its history is temporarily unavailable. Open full chat / Progress to inspect earlier pages.'));
  }
  if (workOverviewEarlierTool?.sessionId === id && !workOverviewEarlierTool.complete &&
      summary.lastToolCallAt) fields.push(field('Older tool result',
    recordedTool
      ? 'A tool result is retained, but interrupted or bounded older history leaves its rank among saved tools unverified. Retry older history or inspect Open full chat / Progress.'
      : 'The session recorded a tool call, but its result is outside the recent window and the older read was temporarily unavailable or bounded. Retry older history to inspect its original outcome.'));
  if (canFindPrevious || previousLookup) fields.push(field('Earlier result lookup',
    previousLookup?.phase === 'loading'
      ? 'Reading exact older session pages. The current result and all native Send custody remain unchanged.'
      : previousLookup?.phase === 'found'
        ? previousLookup.complete
          ? 'A distinct earlier final or worker report was recovered from recorded history. It is not this turn’s result or delivery receipt.'
          : 'An earlier saved result was recovered, but interrupted or bounded paging leaves its rank among saved results unverified.'
      : previousLookup?.phase === 'checked'
        ? previousLookup.event
          ? 'No further earlier saved result was found within the verified bounded history. The displayed older result remains readable.'
          : 'No additional final or finished-worker result was found within the verified bounded history. Open full chat / Progress for other recorded work.'
        : previousLookup?.phase === 'unavailable'
          ? 'Earlier saved result lookup unavailable or bounded. Absence is unverified; retry deliberately or open full chat / Progress. No native Send was attempted.'
          : previousSavedResult
            ? 'An earlier recorded result is readable. Find next earlier result to navigate farther back through this session without changing current-turn evidence.'
            : 'Older results may lie beyond this Work preview. Find earlier saved result to inspect the existing recorded history; no automatic replay or message Send.'));
  if (canFindPreviousTool || previousToolLookup) fields.push(field('Earlier tool result lookup',
    previousToolLookup?.phase === 'loading'
      ? 'Reading exact older session pages. The latest tool output, current status and native Send custody remain unchanged.'
      : previousToolLookup?.phase === 'found'
        ? 'An earlier recorded tool output was recovered with its original provider and turn context. It is not proof of current execution or task acceptance.'
        : previousToolLookup?.phase === 'checked'
          ? previousToolLookup.event
            ? 'No further earlier tool output was found in the verified bounded history. The displayed older output remains readable.'
            : 'No earlier tool output was found in the verified bounded history. Other recorded work may remain in full history.'
          : previousToolLookup?.phase === 'unavailable'
            ? 'Earlier tool output lookup was interrupted or bounded. The last visible output remains readable; retry deliberately. Absence is unverified.'
            : previousToolLookup?.event
              ? 'An earlier tool output is visible. Find next earlier tool result to navigate farther back without changing the latest tool status.'
              : 'Older tool outputs may lie beyond this Work preview. Find earlier tool result to inspect existing recorded history; no tool call is replayed.'));
  if (recordedTool && !recordedTool.call.result.text.trim()) {
    fields.push(field('Recorded tool output',
      `A local tool outcome was recorded at ${clockTime(recordedTool.time)}, but this record retains no tool-output text. ${recordedToolIsCurrent
        ? 'This is not native generation or task completion proof.'
        : 'The provider/turn association is historical or unverified; current Core execution is not established.'}`));
  }
  if (report) fields.push(field('2h scope', report));
  reconcileChildren(grid, fields);
  // The scan-friendly Just did summary cannot substitute for the actual retained result:
  // implementation notes, validation, and blockers often follow its first 320 characters.
  // Keep the already-open disclosure and its large text node mounted across status-only
  // repaints and exact Prime ACK changes. Moving/recreating it on every supervisor
  // update destroys text selection and reprocesses up to 12K characters needlessly.
  const priorResult = host.querySelector<HTMLDetailsElement>('.work-overview-result');
  const sameResult = !!retainedResult && !!priorResult && sameSession &&
    host.dataset.workResultId === retainedResult.id;
  const resultSection = retainedResult?.body.trim()
    ? (sameResult ? priorResult! : el('details', 'work-overview-result') as HTMLDetailsElement) : null;
  if (resultSection && retainedResult) {
    const toggle = (sameResult ? resultSection.querySelector<HTMLElement>('summary') : null) ??
      el('summary', '', retainedResult.label);
    if (toggle.textContent !== retainedResult.label) toggle.textContent = retainedResult.label;
    toggle.dataset.workAction = 'result';
    const note = (sameResult ? resultSection.querySelector<HTMLElement>(':scope > .work-overview-result-provenance') : null) ??
      el('p', 'work-overview-result-note work-overview-result-provenance');
    const description = `Recorded ${clockTime(retainedResult.recordedAt)} · local session ${id} · ${missingHistory ? 'last confirmed snapshot; newer work may exist · ' : ''}a saved result is not task-completion acceptance.`;
    if (note.textContent !== description) note.textContent = description;
    reconcileChildren(resultSection, [toggle, note,
      ...workOverviewRecordedBody(resultSection, retainedResult.body, retainedResult.truncated, 'current')]);
  }
  const previousResultKey = previousSavedResult
    ? `${previousSavedResult.kind}:${previousSavedResult.messageId ?? previousSavedResult.seq}:${previousSavedResult.turnId ?? ''}` : '';
  const priorSavedSection = sameSession
    ? host.querySelector<HTMLDetailsElement>(':scope > .work-overview-previous-result') : null;
  const samePreviousResult = !!previousSavedResult && !!priorSavedSection &&
    host.dataset.workPreviousResultKey === previousResultKey;
  const previousSection = previousSavedResult?.message.text.trim()
    ? (samePreviousResult ? priorSavedSection! :
        el('details', 'work-overview-previous-result') as HTMLDetailsElement) : null;
  if (previousSection && previousSavedResult) {
    const toggle = (samePreviousResult ? previousSection.querySelector<HTMLElement>('summary') : null) ??
      el('summary');
    const label = previousSavedResult.kind === 'agent_message'
      ? 'Read previous saved worker report · historical native turn'
      : 'Read previous saved final answer · historical native turn';
    if (toggle.textContent !== label) toggle.textContent = label;
    toggle.dataset.workAction = 'previous-result';
    const provenance = (samePreviousResult
      ? previousSection.querySelector<HTMLElement>(':scope > .work-overview-result-provenance') : null) ??
      el('p', 'work-overview-result-note work-overview-result-provenance');
    const note = `Recorded ${clockTime(previousSavedResult.time)} · original turn ${previousSavedResult.turnId ?? 'unverified'}; this saved result is not current native turn ${currentNativeTurnId} or its Send/acceptance proof.${previousLookup?.event === previousSavedResult && !previousLookup.complete
      ? ' Older history was interrupted or bounded; this result’s rank among previous work remains unverified.' : ''}`;
    if (provenance.textContent !== note) provenance.textContent = note;
    reconcileChildren(previousSection, [toggle, provenance,
      ...workOverviewRecordedBody(previousSection, previousSavedResult.message.text,
        previousSavedResult.message.truncated, 'previous')]);
  }
  // A late previous-provider report can be newer in recorder order than the
  // actual B report. Keep its full saved output in a separate read-only
  // disclosure without replacing B's current result or exact Prime receipt.
  const priorHistoricalWorker = sameSession
    ? host.querySelector<HTMLDetailsElement>(':scope > .work-overview-historical-worker-result') : null;
  const sameHistoricalWorker = !!historicalWorkerReport && !!priorHistoricalWorker &&
    host.dataset.workHistoricalReportId === historicalWorkerReport.messageId;
  const historicalWorkerSection = historicalWorkerReport
    ? (sameHistoricalWorker ? priorHistoricalWorker! :
        el('details', 'work-overview-historical-worker-result') as HTMLDetailsElement) : null;
  if (historicalWorkerSection && historicalWorkerReport) {
    const heading = (sameHistoricalWorker ? historicalWorkerSection.querySelector<HTMLElement>('summary') : null) ??
      el('summary', '', 'Read historical worker report · provider unverified');
    const provenance = (sameHistoricalWorker
      ? historicalWorkerSection.querySelector<HTMLElement>(':scope > .work-overview-result-provenance') : null) ??
      el('p', 'work-overview-result-note work-overview-result-provenance');
    const provenanceText = 'Saved historical worker evidence; current provider attribution and Prime receipt are separate.';
    if (provenance.textContent !== provenanceText) provenance.textContent = provenanceText;
    reconcileChildren(historicalWorkerSection, [heading, provenance,
      ...workOverviewRecordedBody(historicalWorkerSection, historicalWorkerReport.message.text,
        historicalWorkerReport.message.truncated, 'historical')]);
  }
  // The newest retained tool output belongs to the session recorder; it is not
  // an assistant final, tool replay, or a new authoritative native receipt.
  // Reuse the existing bounded body/keyboard controls so long Core results are
  // readable on demand without repainting 12K characters on every update.
  const toolResultKey = recordedTool ? `${recordedTool.seq}:${recordedTool.call.callId}` : '';
  const previousToolSection = sameSession
    ? host.querySelector<HTMLDetailsElement>(':scope > .work-overview-tool-result') : null;
  const sameTool = !!recordedTool && !!previousToolSection &&
    host.dataset.workToolResultKey === toolResultKey;
  const toolSection = recordedTool?.call.result.text.trim()
    ? (sameTool ? previousToolSection! : el('details', 'work-overview-tool-result') as HTMLDetailsElement) : null;
  if (toolSection && recordedTool) {
    const heading = (sameTool ? toolSection.querySelector<HTMLElement>('summary') : null) ?? el('summary');
    const headingText = recordedToolIsCurrent ? 'Read recorded tool result' :
      'Read recorded tool result · provider/turn unverified';
    if (heading.textContent !== headingText) heading.textContent = headingText;
    const note = (sameTool
      ? toolSection.querySelector<HTMLElement>(':scope > .work-overview-result-provenance') : null) ??
      el('p', 'work-overview-result-note work-overview-result-provenance');
    const provenance = `${toolCallSummary(recordedTool.call).title.slice(0, 160)} · ${workOverviewToolOutcome(recordedTool.call.outcome) || 'Recorded outcome'} · ${clockTime(recordedTool.time)}. ${recordedToolIsCurrent
      ? 'Locally recorded tool outcome. This does not prove a native generation, final answer, or task acceptance.'
      : 'Earlier or unbound provider/turn; not proof of current Core work.'}${missingHistory
        ? ' Last confirmed snapshot; latest history unavailable.' : ''}`;
    if (note.textContent !== provenance) note.textContent = provenance;
    reconcileChildren(toolSection, [heading, note,
      ...workOverviewRecordedBody(toolSection, recordedTool.call.result.text,
        recordedTool.call.result.truncated, 'tool')]);
  }
  const previousToolResult = previousToolLookup?.event ?? null;
  const previousToolResultKey = previousToolResult
    ? `${previousToolResult.seq}:${previousToolResult.call.callId}:${previousToolResult.turnId ?? ''}` : '';
  const priorPreviousToolSection = sameSession
    ? host.querySelector<HTMLDetailsElement>(':scope > .work-overview-previous-tool-result') : null;
  const samePreviousTool = !!previousToolResult && !!priorPreviousToolSection &&
    host.dataset.workPreviousToolResultKey === previousToolResultKey;
  const earlierToolSection = previousToolResult?.call.result.text.trim()
    ? (samePreviousTool ? priorPreviousToolSection! :
        el('details', 'work-overview-previous-tool-result') as HTMLDetailsElement) : null;
  if (earlierToolSection && previousToolResult) {
    const heading = (samePreviousTool
      ? earlierToolSection.querySelector<HTMLElement>(':scope > summary') : null) ??
      el('summary', '', 'Read earlier recorded tool result');
    if (heading.textContent !== 'Read earlier recorded tool result')
      heading.textContent = 'Read earlier recorded tool result';
    heading.dataset.workAction = 'previous-tool-result';
    const provenance = (samePreviousTool
      ? earlierToolSection.querySelector<HTMLElement>(':scope > .work-overview-result-provenance') : null) ??
      el('p', 'work-overview-result-note work-overview-result-provenance');
    const providerLabel = !previousToolResult.call.conversationId ? 'provider unverified' :
      previousToolResult.call.conversationId === summary.conversationId ? 'current provider' : 'previous provider';
    const turnLabel = currentNativeTurnId && previousToolResult.turnId === currentNativeTurnId
      ? `current native turn ${currentNativeTurnId}`
      : currentNativeTurnId
        ? `original turn ${previousToolResult.turnId ?? 'unverified'}; not current native turn ${currentNativeTurnId}`
        : `original turn ${previousToolResult.turnId ?? 'unverified'}; current native turn unverified`;
    const note = `Recorded ${clockTime(previousToolResult.time)} · ${toolCallSummary(previousToolResult.call).title.slice(0, 160)} · ${workOverviewToolOutcome(previousToolResult.call.outcome) || 'Recorded outcome'} · ${providerLabel} · ${turnLabel}. This output is earlier than the displayed tool result and does not establish current execution, native Send or task acceptance.${previousToolLookup?.complete ? '' : ' Older history was interrupted or bounded; its rank among saved tool outputs remains unverified.'}`;
    if (provenance.textContent !== note) provenance.textContent = note;
    reconcileChildren(earlierToolSection, [heading, provenance,
      ...workOverviewRecordedBody(earlierToolSection, previousToolResult.call.result.text,
        previousToolResult.call.result.truncated, 'previous-tool')]);
  }
  const priorHelper = sameSession ? host.querySelector<HTMLDetailsElement>(':scope > .work-overview-helper-custody') : null;
  const helperSection = privateCustody && (privateCustody.retainedTotal || privateCustody.pendingOriginalReply)
    ? priorHelper ?? el('details', 'work-overview-helper-custody') as HTMLDetailsElement : null;
  if (helperSection && privateCustody) {
    const toggle = helperSection.querySelector<HTMLElement>(':scope > summary') ??
      el('summary', '', 'Read private helper & Goal-reply receipts');
    toggle.dataset.workAction = 'helper-custody';
    const children: HTMLElement[] = [toggle];
    const note = el('p', 'work-overview-result-note',
      'Read-only receipt evidence; a helper answer or queued continuation does not confirm the original Goal reply was sent.');
    children.push(note);
    if (privateCustody.pendingOriginalReply) {
      children.push(el('p', 'work-overview-result-note',
        `Goal decision pending since ${clockTime(privateCustody.pendingOriginalReply.acceptedAt)} · helper acceptance and executor delivery are separate receipts.`));
    }
    if (privateCustody.helpers.length) {
      const list = el('ol', 'work-overview-helper-list');
      for (const [index, helper] of privateCustody.helpers.entries()) {
        const entry = el('li', '');
        entry.append(el('b', '', `Helper ${index + 1}`),
          el('span', '', `${workOverviewHelperStatus(helper)} · recorded ${clockTime(helper.createdAt)}`));
        list.append(entry);
      }
      children.push(list);
    }
    if (privateCustody.truncated || privateCustody.retainedTotal > privateCustody.helpers.length) {
      children.push(el('p', 'work-overview-result-note',
        `Only ${privateCustody.helpers.length} of ${privateCustody.retainedTotal} retained helper records shown; older details are outside this bounded view.`));
    }
    if (workOverviewHelperCustodyRead === 'unavailable') {
      children.push(el('p', 'work-overview-result-note',
        'Last confirmed helper custody; latest read unavailable. Retry helper status to update this view.'));
    }
    reconcileChildren(helperSection, children);
  }
  const proposedHistory = el('section', 'work-overview-pane-history');
  proposedHistory.append(el('h3', '', missingHistory && history.length ? 'Recent history · last confirmed snapshot' : 'Recent history'));
  if (history.length) {
    const list = el('ol', 'work-overview-history');
    for (const event of history) {
      const item = el('li', '');
      item.append(el('time', '', ago(event.time)), el('span', '', event.detail));
      list.append(item);
    }
    proposedHistory.append(list);
  } else {
    proposedHistory.append(el('p', 'work-overview-empty', missingHistory
      ? 'Recent history is unavailable until the read succeeds.'
      : 'No recent tool outcomes or recorded final answers.'));
  }
  const previousHistory = sameSession ? host.querySelector<HTMLElement>(':scope > .work-overview-pane-history') : null;
  const historySection = previousHistory?.textContent === proposedHistory.textContent ? previousHistory : proposedHistory;
  const actions = (sameSession
    ? host.querySelector<HTMLElement>(':scope > .work-overview-pane-actions:not(.work-overview-previous-lookup-actions):not(.work-overview-previous-tool-lookup-actions)')
    : null) ??
    el('div', 'work-overview-pane-actions');
  const previousActions = new Map([...actions.querySelectorAll<HTMLButtonElement>(':scope > button[data-work-action]')]
    .map(button => [button.dataset.workAction ?? '', button]));
  const lookupActions = (sameSession
    ? host.querySelector<HTMLElement>(':scope > .work-overview-previous-lookup-actions') : null) ??
    el('div', 'work-overview-pane-actions work-overview-previous-lookup-actions');
  const lookupNodes: HTMLButtonElement[] = [];
  const actionNodes: HTMLButtonElement[] = [];
  if (workOverviewReadFailure) {
    const retry = previousActions.get('retry') ?? el('button', 'btn', 'Retry read') as HTMLButtonElement;
    retry.type = 'button';
    retry.dataset.workAction = 'retry';
    retry.onclick = () => {
      workOverviewEarlierResult = null;
      workOverviewMissingPrimeReceipt = null;
      void refreshWorkOverviewPane(id);
    };
    actionNodes.push(retry);
  }
  if (previousControls && !workOverviewReadFailure) {
    const retryControls = previousActions.get('retry-controls') ??
      el('button', 'btn', 'Retry current controls') as HTMLButtonElement;
    retryControls.type = 'button';
    retryControls.dataset.workAction = 'retry-controls';
    retryControls.onclick = () => void refreshWorkOverviewPane(id);
    actionNodes.push(retryControls);
  }
  if (inputQueueReadUnverified) {
    const retryDelivery = previousActions.get('retry-delivery-read') ??
      el('button', 'btn', 'Retry delivery evidence') as HTMLButtonElement;
    retryDelivery.type = 'button';
    retryDelivery.dataset.workAction = 'retry-delivery-read';
    retryDelivery.onclick = () => void refreshInputQueue();
    actionNodes.push(retryDelivery);
  }
  const olderResultUnavailable = workOverviewEarlierResult?.sessionId === id &&
    !workOverviewEarlierResult.complete;
  const olderToolUnavailable = workOverviewEarlierTool?.sessionId === id &&
    !workOverviewEarlierTool.complete;
  const olderPrimeReceiptUnavailable = !!workerReport && workOverviewPrimeReceiptRead === 'unavailable' &&
    summary.origin?.kind === 'worker' && !!summary.origin.fromSessionId;
  if (!workOverviewReadFailure &&
      (olderResultUnavailable || olderToolUnavailable || olderPrimeReceiptUnavailable)) {
    const retryOlder = previousActions.get('retry-older') ??
      el('button', 'btn', 'Retry older history') as HTMLButtonElement;
    retryOlder.type = 'button';
    retryOlder.dataset.workAction = 'retry-older';
    retryOlder.onclick = () => {
      workOverviewEarlierResult = null;
      workOverviewEarlierTool = null;
      workOverviewMissingPrimeReceipt = null;
      workOverviewPrimeReceiptRead = null;
      void refreshWorkOverviewPane(id);
    };
    actionNodes.push(retryOlder);
  }
  if (canFindPrevious && previousLookupKey && currentNativeTurnId) {
    const previous = lookupActions.querySelector<HTMLButtonElement>(':scope > button[data-work-action="find-previous-result"]') ??
      previousActions.get('find-previous-result') ??
      el('button', 'btn', 'Find earlier saved result') as HTMLButtonElement;
    previous.type = 'button';
    previous.dataset.workAction = 'find-previous-result';
    const reading = previousLookup?.phase === 'loading';
    previous.textContent = reading ? 'Reading earlier results…' :
      previousLookup?.phase === 'unavailable' ? 'Retry earlier result lookup' :
      previousSavedResult ? 'Find next earlier result' : 'Find earlier saved result';
    previous.setAttribute('aria-busy', String(reading));
    // Remain focusable during the async read; repeated clicks have no effect.
    previous.onclick = () => {
      if (reading || workOverviewPreviousLookup?.phase === 'loading' ||
          !workOverviewDetailSummary || !workOverviewEvents.length || !previousReference) return;
      void findPreviousWorkResult(id, previousLookupKey, currentNativeTurnId, summary,
        [...workOverviewEvents], previousReference);
    };
    // Keep this non-destructive lookup adjacent to its explanation rather
    // than behind a potentially 23K-character recorded result and history.
    // The same DOM button survives status refresh and preserves keyboard focus.
    lookupNodes.push(previous);
  }
  if (canFindPreviousTool && previousToolLookupKey && previousToolReference) {
    const previousTool = lookupActions.querySelector<HTMLButtonElement>(
      ':scope > button[data-work-action="find-previous-tool-result"]') ??
      el('button', 'btn', 'Find earlier tool result') as HTMLButtonElement;
    previousTool.type = 'button';
    previousTool.dataset.workAction = 'find-previous-tool-result';
    const reading = previousToolLookup?.phase === 'loading';
    previousTool.textContent = reading ? 'Reading earlier tool results…' :
      previousToolLookup?.phase === 'unavailable' ? 'Retry earlier tool lookup' :
      previousToolLookup?.event ? 'Find next earlier tool result' : 'Find earlier tool result';
    previousTool.setAttribute('aria-busy', String(reading));
    previousTool.onclick = () => {
      if (reading || workOverviewPreviousToolLookup?.phase === 'loading' ||
          !workOverviewDetailSummary || !workOverviewEvents.length) return;
      void findPreviousWorkTool(id, previousToolLookupKey, currentNativeTurnId, summary,
        [...workOverviewEvents], previousToolReference);
    };
    lookupNodes.push(previousTool);
  }
  if (lookupNodes.length) reconcileChildren(lookupActions, lookupNodes);
  const open = previousActions.get('open') ?? el('button', 'btn', 'Open full chat / Progress') as HTMLButtonElement;
  open.type = 'button';
  open.dataset.workAction = 'open';
  open.onclick = () => {
    if (!sessions.some(row => row.id === id) && workOverviewDetailSummary?.id === id) {
      // This is an explicit navigation to an older session, so retain the exact
      // IPC-backed summary across hot first-page refreshes just like a paged row.
      mergeSessionRows([workOverviewDetailSummary]);
      loadedOlderSessions = true;
    }
    selectSession(id);
    showView('progress');
  };
  actionNodes.push(open);
  const deliveryQueue = document.getElementById('deliveryQueuePanel') as HTMLDetailsElement | null;
  if (attention.hasPendingDelivery && deliveryQueue && !deliveryQueue.hidden) {
    const review = previousActions.get('delivery') ?? el('button', 'btn', 'Review saved delivery') as HTMLButtonElement;
    review.type = 'button';
    review.dataset.workAction = 'delivery';
    review.onclick = () => {
      deliveryQueue.open = true;
      deliveryQueue.scrollIntoView?.({ block: 'nearest' });
      deliveryQueue.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    };
    actionNodes.push(review);
  }
  // The established Open full chat action keeps priority. A failed optional
  // helper-status read must never turn the pane's first action into Retry.
  if (!workOverviewReadFailure && workOverviewHelperCustodyRead === 'unavailable' &&
      (privateCustody || automation)) {
    const retryHelper = previousActions.get('retry-helper') ?? el('button', 'btn', 'Retry helper status') as HTMLButtonElement;
    retryHelper.type = 'button'; retryHelper.dataset.workAction = 'retry-helper';
    retryHelper.onclick = () => void refreshWorkOverviewPane(id);
    actionNodes.push(retryHelper);
  }
  reconcileChildren(actions, actionNodes);
  const readWarning = workOverviewReadFailure ? el('p', 'work-overview-empty',
    workOverviewReadFailure === 'both' ? 'Latest progress and history could not be read. Retry to refresh this chat’s evidence.' :
      workOverviewReadFailure === 'progress' ? 'Latest progress could not be read. Retry to refresh its checklist.' :
        'Latest history could not be read. Retry to refresh its evidence.') : null;
  if (readWarning) readWarning.setAttribute('role', 'status');
  host.dataset.workResultSession = id;
  host.dataset.workResultId = retainedResult?.id ?? '';
  host.dataset.workPreviousResultKey = previousResultKey;
  host.dataset.workPreviousToolResultKey = previousToolResultKey;
  host.dataset.workHistoricalReportId = historicalWorkerReport?.messageId ?? '';
  host.dataset.workToolResultKey = toolResultKey;
  const recipeSection = workRecipeReceipts(id, sameSession ? host.querySelector<HTMLDetailsElement>(':scope > .work-overview-recipe') : null);
  reconcileChildren(host, [head, ...(readWarning ? [readWarning] : []), grid,
    ...(recipeSection ? [recipeSection] : []),
    ...(canFindPrevious || canFindPreviousTool ? [lookupActions] : []),
    ...(resultSection ? [resultSection] : []),
    ...(previousSection ? [previousSection] : []),
    ...(earlierToolSection ? [earlierToolSection] : []),
    ...(historicalWorkerSection ? [historicalWorkerSection] : []),
    ...(toolSection ? [toolSection] : []),
    ...(helperSection ? [helperSection] : []), historySection, actions]);
  host.setAttribute('aria-labelledby', title.id);
  host.removeAttribute('aria-label');
  const spokenState = automation ? automationStateLabel(automation) :
    ordinaryTerminalOutcome(summary) ?? (sessionWorking(summary) ? 'recent work recorded' : 'waiting');
  const reportState = workerReport
    ? `Worker report saved${workerReportTiedToCurrent ? '' : requiresProviderProof
      ? '; current provider association unverified' : '; current turn association unverified'}. Prime receipt ${primeReceived ? 'confirmed' : 'unverified'}.`
    : retainedResult ? 'Saved result available; task completion remains unverified.' : 'No saved result in this read.';
  announceWorkOverview(`${summary.title.slice(0, 96)}. ${spokenState}. ${reportState}`);
  if (focusedAction) {
    // A live evidence refresh must not eject keyboard users from an open result pane.
    const action = host.querySelector<HTMLElement>(`[data-work-action="${focusedAction}"]`) ??
      host.querySelector<HTMLButtonElement>('button[data-work-action="close"]');
    if (action && document.activeElement !== action) action.focus({ preventScroll: true });
  }
}

async function refreshWorkOverviewPane(id: string): Promise<void> {
  if (workOverviewLoadingFor === id) {
    // SessionChanged may publish a newer final or delivery state while an older
    // getSession snapshot is still pending. One later read must supersede that
    // snapshot, without spawning unlimited concurrent history requests.
    workOverviewReadDirty = true;
    return;
  }
  const generation = ++workOverviewLoadGeneration;
  workOverviewLoadingFor = id;
  workOverviewReadDirty = false;
  if (workOverviewSessionId === id && workOverviewControls?.sessionId !== id) paintWorkOverviewPane();
  const stillSelected = (): boolean => generation === workOverviewLoadGeneration && workOverviewSessionId === id;
  const known = sessions.find(row => row.id === id) ??
    (workOverviewDetailSummary?.id === id ? workOverviewDetailSummary : null);
  const anticipatedPrime = known?.origin?.kind === 'worker' ? known.origin.fromSessionId : null;
  const publishHelperRead = (helperCustodyRead: {
    status: 'checked' | 'unavailable'; value: SessionDecisionHelperCustody | null
  }): void => {
    const exactConversation = (workOverviewDetailSummary?.id === id ? workOverviewDetailSummary.conversationId : null) ??
      known?.conversationId;
    if (helperCustodyRead.status === 'checked' && helperCustodyRead.value &&
        helperCustodyRead.value.sessionId === id && helperCustodyRead.value.conversationId === exactConversation) {
      workOverviewHelperCustody = helperCustodyRead.value;
      workOverviewHelperCustodyRead = 'checked';
    } else {
      // A failed or foreign read cannot erase last confirmed exact-source custody.
      if (workOverviewHelperCustody?.sessionId !== id || workOverviewHelperCustody?.conversationId !== exactConversation)
        workOverviewHelperCustody = null;
      workOverviewHelperCustodyRead = 'unavailable';
    }
  };
  // Private helper evidence is useful but optional. A slow input-store read must not
  // hold the main Work result, Prime receipt, or available navigation behind it.
  const helperRead = typeof api.decisionHelperCustody === 'function'
    ? api.decisionHelperCustody(id)
      .then((reply) => reply.ok && reply.data
        ? { status: 'checked' as const, value: reply.data }
        : { status: 'unavailable' as const, value: null })
      .catch(() => ({ status: 'unavailable' as const, value: null }))
    : Promise.resolve({ status: 'unavailable' as const, value: null });
  let resolvedHelperRead: Awaited<typeof helperRead> | null = null;
  void helperRead.then(result => {
    if (!stillSelected() || workOverviewReadDirty) return;
    resolvedHelperRead = result;
    if (workOverviewLoadingFor === id) return;
    publishHelperRead(result);
    paintWorkOverviewPane();
  });
  const controlsRequestedAt = Date.now();
  const [controls, detail, anticipatedPrimeDetail] = await Promise.all([
    run(api.getSessionControls(id)).catch(() => null),
    run(api.getSession(id, { limit: 80 })).catch(() => null),
    anticipatedPrime && anticipatedPrime !== id
      ? run(api.getSession(anticipatedPrime, { limit: 80 })).catch(() => null) : Promise.resolve(null)
  ]);
  if (!stillSelected()) return;
  const matchedDetail = detail?.summary?.id === id ? detail : null;
  // A newer recorder notification already invalidated this read. Reconcile before
  // paging older history or caching receipts from the obsolete event tail.
  if (workOverviewReadDirty) {
    workOverviewLoadingFor = null;
    workOverviewReadDirty = false;
    void refreshWorkOverviewPane(id);
    return;
  }
  const exactSummary = matchedDetail?.summary ?? null;
  let visibleEvents = matchedDetail?.events ?? [];
  // A canonical final can be revised with the same provider message ID and create_time.
  // Refresh the view's exact-event cache when that newer revision enters the recent tail;
  // otherwise 80 more tools would resurrect an older copy under an unchanged summary timestamp.
  const recentResult = exactSummary ? [...visibleEvents].sort((left, right) =>
    positionOf(right) - positionOf(left) || right.seq - left.seq)
    .find(event => recordedWorkResult(exactSummary, event)) : null;
  const resultMarker = exactSummary
    ? `${exactSummary.lastAssistantFinalAt ?? 0}:${exactSummary.lastFinishReportAt ?? 0}` : '';
  const cacheMatches = workOverviewEarlierResult?.sessionId === id && workOverviewEarlierResult.marker === resultMarker;
  const cachedResult = cacheMatches ? workOverviewEarlierResult?.event ?? null : null;
  const betterRecent = recentResult && (!cachedResult || positionOf(recentResult) > positionOf(cachedResult) ||
    (positionOf(recentResult) === positionOf(cachedResult) && recentResult.seq > cachedResult.seq));
  const bestKnown = betterRecent ? recentResult! : cachedResult;
  // If the best visible result originated before the window's oldest seq, a distinct
  // later final/report might exist among the evicted records. The origin boundary proves
  // when it is safe to stop, without sorting answers by mutable append/revision timestamps.
  const oldestVisible = visibleEvents.reduce((oldest, event) => Math.min(oldest, event.seq), Number.POSITIVE_INFINITY);
  const needOlder = !!exactSummary && (recentResult || cachedResult ||
    (exactSummary.lastAssistantFinalAt ?? 0) > 0 || (exactSummary.lastFinishReportAt ?? 0) > 0) &&
    (!bestKnown || positionOf(bestKnown) < oldestVisible);

  // The exact summary can retain a previous result long after 80 newer tools or page
  // observations displaced its body. Recover only the newest saved result from older
  // cursor pages, and cache that immutable recorder event while this pane is selected.
  if (exactSummary && needOlder) {
    // An unavailable older page is not a reason to rescan on every status repaint. The
    // explicit Retry older history action clears the cache when a new attempt is wanted.
    if (!cacheMatches || betterRecent) {
      const saved = await olderWorkEvidence(id, visibleEvents,
        event => recordedWorkResult(exactSummary, event), stillSelected, bestKnown);
      if (!stillSelected()) return;
      workOverviewEarlierResult = { sessionId: id, marker: resultMarker, ...saved };
    }
    if (workOverviewEarlierResult?.event && !visibleEvents.some(event => event.seq === workOverviewEarlierResult!.event!.seq))
      visibleEvents = [workOverviewEarlierResult.event, ...visibleEvents];
  } else if (exactSummary && bestKnown && (betterRecent || !cacheMatches)) {
    workOverviewEarlierResult = { sessionId: id, marker: resultMarker, event: bestKnown, complete: true };
  } else if (cachedResult && !visibleEvents.some(event => event.seq === cachedResult.seq)) {
    visibleEvents = [cachedResult, ...visibleEvents];
  }

  // A closed tool-only chat can have its last recorded Core result pushed past
  // the 80-event tail by later status observations, without an assistant final
  // or file edit to trigger the existing result lookback. Reuse its same bounded
  // exact-session cursor search once per actual tool revision. An interrupted
  // page remains unverified until explicit Retry older history; status-only
  // paints never hammer the recorder or silently adopt another provider.
  if (exactSummary && exactSummary.toolCalls > 0 && (exactSummary.lastToolCallAt ?? 0) > 0 &&
      !(exactSummary.lastAssistantFinalAt || exactSummary.lastFinishReportAt || exactSummary.fileEdits > 0)) {
    const toolMarker = `${exactSummary.toolCalls}:${exactSummary.lastToolCallAt}`;
    const toolCached = workOverviewEarlierTool?.sessionId === id &&
      workOverviewEarlierTool.marker === toolMarker;
    const recentTool = [...visibleEvents].sort((left, right) =>
      positionOf(right) - positionOf(left) || right.seq - left.seq)
      .find(event => event.kind === 'tool_call') ?? null;
    if (recentTool) {
      workOverviewEarlierTool = { sessionId: id, marker: toolMarker, event: recentTool, complete: true };
    } else {
      if (!toolCached) {
        const older = await olderWorkEvidence(id, visibleEvents,
          event => event.kind === 'tool_call', stillSelected);
        if (!stillSelected()) return;
        workOverviewEarlierTool = { sessionId: id, marker: toolMarker, ...older };
      }
      const savedTool = workOverviewEarlierTool?.event;
      if (savedTool && !visibleEvents.some(event => event.seq === savedTool.seq))
        visibleEvents = [savedTool, ...visibleEvents];
    }
  }

  // The recipient's acknowledgement is recorded in the Prime session. Its exact id must
  // come from the session detail actually read above: an older/off-sidebar or repaired worker
  // can have no current sidebar summary, or that summary may predate an origin repair.
  const exactReport = exactSummary ? workOverviewWorkerReport(exactSummary, chronological(visibleEvents),
    !!exactSummary.conversationId && exactSummary.chatIds.some(chat => chat !== exactSummary.conversationId)) : null;
  const primeId = exactSummary?.origin?.kind === 'worker' ? exactSummary.origin.fromSessionId : null;
  let receipt = exactReport && primeId && workOverviewPrimeReceipt?.primeSessionId === primeId &&
    workOverviewPrimeReceipt.messageId === exactReport.messageId && workOverviewPrimeReceipt.from === exactReport.from
    ? workOverviewPrimeReceipt : null;
  let receiptRead: 'checked' | 'unavailable' | null = null;
  if (exactReport && primeId && primeId !== id) {
    if (!receipt) {
      const primeDetail = anticipatedPrime === primeId && anticipatedPrimeDetail?.summary?.id === primeId
        ? anticipatedPrimeDetail : await run(api.getSession(primeId, { limit: 80 })).catch(() => null);
      if (!stillSelected()) return;
      if (primeDetail?.summary?.id === primeId) {
        let olderHistoryComplete = true;
        const matchesReceipt = (event: SessionEvent): boolean => event.kind === 'agent_message' &&
          event.source === 'app' && event.delivery === 'delivered' && event.messageId === exactReport.messageId &&
          event.from === exactReport.from && event.to === 'prime';
        let matching = primeDetail.events.find(matchesReceipt) ?? null;
        if (!matching && !(workOverviewMissingPrimeReceipt?.primeSessionId === primeId &&
            workOverviewMissingPrimeReceipt.messageId === exactReport.messageId &&
            workOverviewMissingPrimeReceipt.primeEvents === primeDetail.summary.events)) {
          const previous = await olderWorkEvidence(primeId, primeDetail.events, matchesReceipt, stillSelected);
          if (!stillSelected()) return;
          olderHistoryComplete = previous.complete;
          matching = previous.event;
          if (previous.complete && !matching) workOverviewMissingPrimeReceipt = {
            primeSessionId: primeId, messageId: exactReport.messageId, primeEvents: primeDetail.summary.events
          };
        }
        if (matching?.kind === 'agent_message') receipt = {
          primeSessionId: primeId, messageId: matching.messageId, from: matching.from, receivedAt: matching.time
        };
        // An interrupted/bounded older-page scan cannot rule out a recipient ACK.
        // Keep its uncertainty actionable until a matching receipt or complete scan exists.
        receiptRead = matching?.kind === 'agent_message' || olderHistoryComplete ? 'checked' : 'unavailable';
      } else receiptRead = 'unavailable';
    } else receiptRead = 'checked';
  } else if (exactReport) receiptRead = 'unavailable';

  if (!stillSelected()) return;
  workOverviewLoadingFor = null;
  if (workOverviewReadDirty) {
    // Do not publish stale success, failure or checklist evidence after a newer
    // session notification. Close/switch generations still cancel this pickup.
    workOverviewReadDirty = false;
    void refreshWorkOverviewPane(id);
    return;
  }
  const oldSource = sessions.find(row => row.id === id);
  const oldProjection = oldSource ? automationForSummary(oldSource) : null;
  const previouslyOff = !!oldProjection && inspectedWorkModeOff(oldProjection, oldSource);
  workOverviewReadFailure = !controls && !matchedDetail ? 'both' : !controls ? 'progress' : !matchedDetail ? 'history' : null;
  workOverviewControls = controls ?? null;
  const confirmedProvider = matchedDetail?.summary?.conversationId ?? oldSource?.conversationId;
  const confirmedActiveTurn = matchedDetail?.summary?.activeTurnId ?? oldSource?.activeTurnId ?? null;
  if (controls?.sessionId === id && controls.conversationId &&
      controls.conversationId === confirmedProvider &&
      (!confirmedActiveTurn || controls.activeTurnId === confirmedActiveTurn)) {
    if (controls.automation === 'off') {
      // Refresh at most one receipt per exact session, and bound the display cache.
      inspectedOffReceipts.delete(id);
      inspectedOffReceipts.set(id, {
        conversationId: controls.conversationId, activeTurnId: controls.activeTurnId ?? null,
        readAt: controlsRequestedAt
      });
      if (inspectedOffReceipts.size > 16) inspectedOffReceipts.delete(inspectedOffReceipts.keys().next().value!);
    } else inspectedOffReceipts.delete(id);
  }
  if (matchedDetail) {
    workOverviewDetailSummary = matchedDetail.summary;
    workOverviewEvents = visibleEvents;
    workOverviewPrimeReceipt = receipt;
    workOverviewPrimeReceiptRead = receiptRead;
  }
  if (resolvedHelperRead) publishHelperRead(resolvedHelperRead);
  // A transient history outage must not erase a previously confirmed useful output.
  // Keep only this pane's exact-session evidence; the read warning and labels make
  // its age explicit, and a successful later read replaces it with current truth.
  // The exact controls can supersede only this inspected Work row's older
  // supervisor wording. Reconcile the existing keyed feed and sidebar once for
  // a real Off boundary, preserving focused text, result and native action owners.
  paintWorkOverview(false);
  const currentSource = sessions.find(row => row.id === id);
  const currentProjection = currentSource ? automationForSummary(currentSource) : null;
  if (previouslyOff !== (!!currentProjection && inspectedWorkModeOff(currentProjection, currentSource))) {
    paintSessions();
    paintStateLine();
  }
}

function openWorkOverviewPane(id: string, origin: HTMLButtonElement): void {
  const newlyOpened = workOverviewSessionId !== id;
  const focusNarrowSheet = newlyOpened && typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 700px)').matches;
  if (workOverviewSessionId !== id) {
    workOverviewControls = null;
    workOverviewDetailSummary = null;
    workOverviewEvents = [];
    workOverviewEarlierResult = null;
    workOverviewEarlierTool = null;
    workOverviewPreviousLookup = null;
    workOverviewPreviousToolLookup = null;
    workOverviewPrimeReceipt = null;
    workOverviewMissingPrimeReceipt = null;
    workOverviewPrimeReceiptRead = null;
    workOverviewHelperCustody = null;
    workOverviewHelperCustodyRead = null;
    workOverviewReadDirty = false;
    workOverviewReadFailure = null;
  }
  workOverviewSessionId = id;
  workOverviewOriginRow = origin;
  announceWorkOverview(t('Reading saved work for {0}', [origin.querySelector('.work-overview-title')?.textContent?.slice(0, 96) ?? id]));
  paintWorkOverviewPane();
  // The narrow Work region is a floating non-modal read-only sheet. Put the
  // close action first in keyboard order on initial open; ordinary refreshes
  // keep the user's existing focus/selection and Escape restores the row.
  if (focusNarrowSheet) {
    document.getElementById('workOverviewPane')
      ?.querySelector<HTMLButtonElement>('button[data-work-action="close"]')
      ?.focus({ preventScroll: true });
  }
  void refreshWorkOverviewPane(id).then(() => {
    // The first asynchronous exact read can reparent the selected sheet when
    // the sidebar rows are reconciled. Chromium then drops focus onto BODY.
    // Restore only that lost initial focus; never steal it if a keyboard user
    // has already selected a result, another action or another chat.
    if (focusNarrowSheet && workOverviewSessionId === id &&
        (document.activeElement === document.body || document.activeElement === origin)) {
      document.getElementById('workOverviewPane')
        ?.querySelector<HTMLButtonElement>('button[data-work-action="close"]')
        ?.focus({ preventScroll: true });
    }
  });
}

function paintWorkOverview(refreshSelectedDetail = true): void {
  const host = document.getElementById('workOverviewBody');
  const meta = document.getElementById('workOverviewMeta');
  if (!host || !meta) return;
  // The document's initial loading message is temporary. Leaving it visible after
  // a completed read falsely suggests no current status has arrived yet.
  if (host.firstElementChild?.classList.contains('empty')) host.firstElementChild.remove();
  // The inspected pane is an inline sibling of its selected row. Treat it as a
  // retained child during a stable feed refresh; parking and moving it on every
  // repaint loses the browser's result-text selection even when its nodes survive.
  const pane = document.getElementById('workOverviewPane');
  const focusedPaneAction = pane?.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset.workAction : undefined;

  const automated = (automationSupervisor?.chats ?? []).map(chat =>
    displayedAutomationForBinding(chat, sessions.find(row => row.id === chat.sessionId)))
    .sort((left, right) => {
      const rank = (state: AutomationChatProjection['state']): number =>
        state === 'stalled' ? 0 : state === 'blocked' ? 1 : state === 'recovering' ? 2 :
          state === 'working' ? 3 : state === 'paused' ? 5 : 4;
      return rank(left.state) - rank(right.state) || right.lastWorkedAt - left.lastWorkedAt || left.title.localeCompare(right.title);
    });
  const inspectedOffSessions = new Set(automated.filter(chat =>
    inspectedWorkModeOff(chat, sessions.find(row => row.id === chat.sessionId)))
    .map(chat => chat.sessionId));
  const activeAutomated = automated.filter(chat => !inspectedOffSessions.has(chat.sessionId));
  // Paused and blocked Goal/Loop chats are still owned by the supervisor. Excluding them
  // lets a recent local tool falsely put the same held session back under ordinary "working".
  const automatedSessions = new Set(automated.map(chat => chat.sessionId));
  // An ordinary conversation can be explicitly held outside Goal/Loop. That exact
  // existing local block outranks activity grace and must remain visible after it
  // expires, without calling the hold a new provider failure or native execution.
  const ordinaryBlocked = sessions
    .filter(row => row.conversationId !== null && row.origin?.kind !== 'worker' && row.origin?.kind !== 'helper' &&
      !automatedSessions.has(row.id) && blockedChats.has(row.conversationId))
    .sort((left, right) => sessionLastWorkedAt(right) - sessionLastWorkedAt(left) || left.title.localeCompare(right.title));
  const ordinaryActive = sessions
    .filter(row => row.conversationId !== null && row.origin?.kind !== 'worker' && row.origin?.kind !== 'helper' &&
      !automatedSessions.has(row.id) && !blockedChats.has(row.conversationId) && sessionWorking(row))
    .sort((left, right) => sessionLastWorkedAt(right) - sessionLastWorkedAt(left) || left.title.localeCompare(right.title));
  // An open ordinary turn survives after its activity grace expires. Keep that
  // exact recorded turn inspectable without borrowing Goal/Loop's Working verdict,
  // a spinner or any permission to retry an uncertain native message.
  const ordinaryOpenUnverified = sessions
    .filter(row => row.conversationId !== null && row.origin?.kind !== 'worker' && row.origin?.kind !== 'helper' &&
      row.endedAt === null && !automatedSessions.has(row.id) && !blockedChats.has(row.conversationId) &&
      !!row.activeTurnId && !sessionWorking(row))
    .sort((left, right) => sessionLastWorkedAt(right) - sessionLastWorkedAt(left) || left.title.localeCompare(right.title));
  // A recently ended ordinary turn still deserves an actionable row, even when
  // its last local tool gave it an unexpired activity deadline. Bound this to the
  // existing recency window and three newest outcomes so old failures do not fill
  // the current-work feed or pretend that a paused/failed turn is running.
  const ordinaryEnded = sessions
    .filter(row => row.conversationId !== null && row.origin?.kind !== 'worker' && row.origin?.kind !== 'helper' &&
      !automatedSessions.has(row.id) && !blockedChats.has(row.conversationId) && !!ordinaryTerminalOutcome(row) &&
      typeof row.lastTurnEndAt === 'number' && row.lastTurnEndAt > 0 &&
      Date.now() - row.lastTurnEndAt < CHAT_ACTIVE_MS)
    .sort((left, right) => (right.lastTurnEndAt ?? 0) - (left.lastTurnEndAt ?? 0)).slice(0, 3);
  // Past failed/interrupted/stalled/unknown turns are still durable evidence after
  // the short "Current work" window closes. The previous feed dropped them entirely.
  // Show a bounded older review section; older explicit user Stops are historical,
  // not automatic blockers. Never call a past issue a current provider failure.
  const olderOrdinaryOutcomes = sessions
    .filter(row => row.conversationId !== null && row.origin?.kind !== 'worker' && row.origin?.kind !== 'helper' &&
      row.endedAt === null && !automatedSessions.has(row.id) && !blockedChats.has(row.conversationId) &&
      !row.activeTurnId && !!ordinaryTerminalOutcome(row) && ordinaryTerminalOutcome(row) !== 'stopped' &&
      (!(typeof row.lastTurnEndAt === 'number' && row.lastTurnEndAt > 0) ||
        Date.now() - row.lastTurnEndAt >= CHAT_ACTIVE_MS))
    .sort((left, right) => (right.lastTurnEndAt ?? 0) - (left.lastTurnEndAt ?? 0) || left.title.localeCompare(right.title));
  const olderPreviewLimit = 3;
  // A saved native Send remains useful after its page/result leaves the recent
  // history. The incumbent outbox has the receipt; index by exact local session
  // once instead of scanning every delivery for each of sixty sidebar rows.
  const deliveredBySession = new Map<string, InputEntry>();
  for (const input of inputQueueLoaded ? pendingComposerInputs : []) {
    if (input.purpose === 'decision' || !input.messageId || !input.deliveredAt) continue;
    const owner = input.deliveredSessionId ?? input.sessionId;
    if (!owner) continue;
    const previous = deliveredBySession.get(owner);
    if (!previous || input.deliveredAt > (previous.deliveredAt ?? 0)) deliveredBySession.set(owner, input);
  }
  // A finished worker may have no file edits and no longer have a browser tab. Its durable
  // finish report is still a useful result even if its native turn-end is delayed.
  // An ordinary recorded final is useful only when a newer turn has not opened.
  const allRecentUpdates = sessions.flatMap(row => {
    const editedAt = row.origin?.kind !== 'worker' && row.origin?.kind !== 'helper' && row.fileEdits > 0
      ? row.lastFileChangeAt ?? 0 : 0;
    const closedTurn = !row.activeTurnId && row.lastTurnOutcome !== 'failed' && row.lastTurnOutcome !== 'stopped' &&
      row.lastTurnOutcome !== 'interrupted' && row.lastTurnOutcome !== 'stalled' && row.lastTurnOutcome !== 'unknown';
    const reportedAt = recordedWorkerId(row) ? row.lastFinishReportAt ?? 0 : 0;
    // A reused worker may fail its next tool without finishing another report. Its prior
    // result still exists in the same durable session, so retain it as historical rather
    // than making the row (and an open Work detail) vanish after that newer tool.
    const priorWorkerAt = reportedAt > 0 &&
      (reportedAt < (row.lastToolCallAt ?? 0) ||
        (row.finishTurn?.conversationId === row.conversationId && row.finishTurn.startedAt > reportedAt))
      ? reportedAt : 0;
    // A summary timestamp has no provider/turn identity. After A -> B, the
    // Work feed must keep a saved report readable without naming it B's result.
    // Exact current-turn attribution is resolved when the detail reads events.
    const reboundWorker = row.origin?.kind === 'worker' && !!row.conversationId &&
      row.chatIds.some(conversation => conversation !== row.conversationId);
    const workerAt = reportedAt > 0 && !priorWorkerAt && !reboundWorker ? reportedAt : 0;
    const historicalWorkerAt = reboundWorker ? reportedAt : priorWorkerAt;
    const finalTimestamp = row.lastAssistantFinalAt ?? 0;
    // The provider stamps a terminal final when it *opens* the message, sometimes before
    // the last tool of that same turn. Never hide a proven completed one-off for that reason.
    // Require the current recorded turn's start/end identity: a final from an earlier turn
    // must not be presented as the result of a newer completed turn without its own final.
    const finalBelongsToCompletedTurn = row.lastTurnOutcome === 'completed' && !!row.finishTurn &&
      row.finishTurn.conversationId === row.conversationId && finalTimestamp >= row.finishTurn.startedAt &&
      (row.lastTurnEndAt ?? 0) >= (row.lastToolCallAt ?? 0) && (row.lastTurnEndAt ?? 0) >= row.finishTurn.startedAt;
    // The most recently started turn may finish without its own result or tool call. Comparing
    // the old final only to lastToolCallAt would incorrectly promote that old result as CURRENT.
    // The store's exact current-turn start is the existing summary ownership boundary.
    const priorTurnFinal = row.finishTurn?.conversationId === row.conversationId &&
      finalTimestamp > 0 && row.finishTurn.startedAt > finalTimestamp;
    const finalAt = closedTurn && !priorTurnFinal && row.origin?.kind !== 'helper' && finalTimestamp > 0 &&
      (finalTimestamp >= (row.lastToolCallAt ?? 0) || finalBelongsToCompletedTurn)
      ? Math.max(finalTimestamp, finalBelongsToCompletedTurn ? row.lastTurnEndAt ?? 0 : 0) : 0;
    const priorFinalAt = priorTurnFinal && row.origin?.kind !== 'helper' ? finalTimestamp : 0;
    const deliveredInput = row.origin?.kind === 'worker' || row.origin?.kind === 'helper'
      ? null : deliveredBySession.get(row.id) ?? null;
    // A local session can span provider A -> B. Final/edit summary counters have
    // no native message/conversation attribution; a confirmed outbox receipt has
    // its own provider binding. Retain all three outputs, but never advertise A's
    // result or Send as current B work from the session-wide recency timestamp.
    // Only the explicit exact event read in Work detail may establish B custody.
    const providerRebound = !!row.conversationId &&
      row.chatIds.some(conversation => conversation !== row.conversationId);
    const deliveryUnbound = !!deliveredInput && !!row.conversationId &&
      deliveredInput.conversationId !== row.conversationId;
    const deliveryAt = deliveredInput?.deliveredAt ?? 0;
    // Tool-only work can be the only durable evidence after its browser tab
    // closes: no final, file edits, worker finish, or outbox receipt. Without
    // this fallback the user cannot even FIND its recorded Core outcome in
    // Recent updates. Preserve richer saved results above a later tool
    // timestamp, and never promote a session-wide time into current-provider
    // execution, success, completion, or an exact tool result.
    const richestAt = Math.max(editedAt, workerAt, historicalWorkerAt, finalAt, priorFinalAt, deliveryAt);
    const toolOnlyAt = !richestAt && row.origin?.kind !== 'helper' &&
      row.toolCalls > 0 && typeof row.lastToolCallAt === 'number' &&
      Number.isFinite(row.lastToolCallAt) && row.lastToolCallAt > 0 ? row.lastToolCallAt : 0;
    const priorTurnTool = toolOnlyAt > 0 && row.finishTurn?.conversationId === row.conversationId &&
      row.finishTurn.startedAt > toolOnlyAt;
    const at = Math.max(richestAt, toolOnlyAt);
    if (at <= 0) return [];
    const state = workerAt === at ? 'Worker report saved' : historicalWorkerAt === at ?
      reboundWorker ? 'Saved worker report · provider unverified' : 'Previous worker report retained' :
      finalAt === at ? providerRebound ? 'Saved final · provider unverified' : 'Final answer recorded' :
        priorFinalAt === at ? 'Previous final retained' :
        deliveryAt === at ? deliveryUnbound
          ? deliveredInput?.conversationId ? 'Previous-provider delivery retained' : 'Unbound native delivery retained'
          : 'Native delivery retained' :
        toolOnlyAt === at ? providerRebound ? 'Recorded tool activity · provider unverified' :
          priorTurnTool ? 'Previous tool activity retained' : 'Recorded tool activity' :
        providerRebound ? 'Recorded edits · provider unverified' : sessionProofAge({ at, label: 'edit' });
    const detail = workerAt === at ? 'Retained worker finish report; open to inspect its recorded evidence.' :
      historicalWorkerAt === at ? reboundWorker
        ? 'Saved worker result remains readable; its current provider and turn require exact report evidence.'
        : 'Newer worker activity has no saved finish report; previous worker result remains readable.' :
      finalAt === at ? providerRebound
        ? 'A saved final remains readable; its exact current provider and turn must be confirmed from the recorded events before treating it as B work.'
        : 'A final answer was recorded; task completion still depends on its acceptance evidence.' :
      priorFinalAt === at ? 'The newer turn has no confirmed final; open to inspect the previous result and current status.' :
      deliveryAt === at ? deliveryUnbound
        ? 'Original native delivery is retained for a previous or unbound provider; current-provider Send unverified. Review the exact original input and receipt before any action.'
        : deliveredInput?.state === 'cancelled'
          ? 'Native Send was recorded, later cancellation did not undo delivery; answer collection requires exact readback.'
          : 'Native Send was recorded; a matching response and task acceptance still require exact evidence.' :
      toolOnlyAt === at ? providerRebound
        ? 'Tool activity was saved for this local session; its timestamp may belong to the previous provider. Open to inspect the exact recorded outcome. Current-provider execution and task completion are unverified.'
        : priorTurnTool
        ? 'A later native turn has no exact tool or final result of its own. Read the previous turn tool outcome; it is not proof that the newer turn succeeded or is still working.'
        : 'A local tool call was recorded without a retained final answer or file change. Open to inspect its exact outcome; the session-wide timestamp is not proof of a successful tool, active generation, or completed task.' :
        providerRebound
          ? 'Session-wide saved file changes require exact provider and turn evidence; no current-provider edit is proven by these totals.'
          : sessionChangeStats(row) || 'Recorded local file change';
    return [{ row, at, state, detail }];
  }).sort((left, right) => right.at - left.at || left.row.title.localeCompare(right.row.title));
  const recentUpdates = allRecentUpdates.slice(0, workOverviewUpdatesShown);
  // Keep the selected result's owning row connected during inspection even after six
  // fresher results arrive. Closing the detail releases this temporary seventh row.
  const selectedRecent = workOverviewOriginRow?.isConnected &&
    workOverviewOriginRow.closest('[data-work-section="updates"]') ? workOverviewSessionId : null;
  if (selectedRecent && !recentUpdates.some(update => update.row.id === selectedRecent)) {
    const opened = allRecentUpdates.find(update => update.row.id === selectedRecent);
    if (opened) recentUpdates.push({ ...opened, detail: `${opened.detail} · Kept visible while inspected.` });
  }

  // The global Delivery queue already owns which active and terminal receipts are safe to
  // display. Project that same bounded set here; a saved or ambiguous message is still work
  // even when its chat has no active browser tab or recorded session row.
  // Retain confirmed historical outbox facts in the session's saved results,
  // but never count a stale input snapshot as CURRENT queued or in-flight
  // delivery after the latest queue IPC failed.
  const delivery = inputQueueLoaded && !inputQueueReadUnverified
    ? visibleDeliveryEntries(pendingComposerInputs) : null;
  const deliveryCounts = { queued: 0, preparing: 0, awaitingReceipt: 0, tool: 0, notices: delivery?.notices.length ?? 0 };
  for (const entry of delivery?.active ?? []) {
    if (entry.state === 'queued') deliveryCounts.queued++;
    else if (entry.state === 'browser') {
      if (entry.sendAuthorizedAt !== undefined) deliveryCounts.awaitingReceipt++;
      else deliveryCounts.preparing++;
    } else if (entry.state === 'tool') deliveryCounts.tool++;
  }
  const deliveryLabels = [
    deliveryCounts.queued ? `${deliveryCounts.queued} queued` : '',
    deliveryCounts.preparing ? `${deliveryCounts.preparing} preparing` : '',
    deliveryCounts.awaitingReceipt ? `${deliveryCounts.awaitingReceipt} awaiting receipt` : '',
    deliveryCounts.tool ? `${deliveryCounts.tool} awaiting tool receipt` : '',
    deliveryCounts.notices ? `${deliveryCounts.notices} delivery notice${deliveryCounts.notices === 1 ? '' : 's'}` : ''
  ].filter(Boolean);
  const deliveryState = inputQueueReadUnverified
    ? 'delivery status unknown · latest read unavailable' : deliveryLabels.join(' · ');

  const attention = activeAutomated.filter(chat => chat.state === 'stalled').length +
    ordinaryEnded.filter(row => ordinaryTerminalOutcome(row) !== 'stopped').length;
  // A grace deadline on an ordinary chat is a recent signal, not an exact executing
  // native turn. The supervisor alone can count verified main work as Working.
  const working = activeAutomated.filter(chat => chat.state === 'working').length;
  const recentSignals = ordinaryActive.length;
  const openUnverified = ordinaryOpenUnverified.length;
  const unknown = activeAutomated.filter(automationStatusUnknown).length;
  const waitingWorkers = activeAutomated.filter(chat => chat.state === 'waiting-workers').length;
  const betweenTurns = activeAutomated.filter(chat => chat.state === 'waiting-main').length;
  const recovering = activeAutomated.filter(chat => chat.state === 'recovering').length;
  const blocked = activeAutomated.filter(chat => chat.state === 'blocked').length + ordinaryBlocked.length;
  const paused = activeAutomated.filter(chat => chat.state === 'paused').length;
  meta.textContent = [working ? `${working} working` : '', recentSignals ? `${recentSignals} recent signal${recentSignals === 1 ? '' : 's'}` : '',
    openUnverified ? `${openUnverified} unverified open turn${openUnverified === 1 ? '' : 's'}` : '',
    waitingWorkers ? `${waitingWorkers} waiting workers` : '',
    betweenTurns > unknown ? `${betweenTurns - unknown} between turns` : '', unknown ? `${unknown} unknown` : '',
    recovering ? `${recovering} repairing` : '', attention ? `${attention} attention` : '',
    blocked ? `${blocked} blocked` : '', paused ? `${paused} paused` : '',
    inspectedOffSessions.size ? `${inspectedOffSessions.size} off` : '',
    ordinaryEnded.some(row => ordinaryTerminalOutcome(row) === 'stopped') ? 'stopped turn' : '', deliveryState,
    recentUpdates.length ? `${recentUpdates.length} updates` : '',
    olderOrdinaryOutcomes.length
      ? `${olderOrdinaryOutcomes.length} earlier outcome${olderOrdinaryOutcomes.length === 1 ? '' : 's'}${olderOrdinaryOutcomes.length > olderPreviewLimit ? ` (${olderPreviewLimit} shown)` : ''}`
      : '']
    .filter(Boolean).join(' · ') || 'quiet';

  type OverviewRow = { id: string; title: string; state: string; detail: string; kind?: 'delivery' };
  const section = (label: string, key: string): HTMLElement => {
    let node = [...host.children].find(child => (child as HTMLElement).dataset.workSection === key) as HTMLElement | undefined;
    if (!node) {
      node = el('section', 'work-overview-section');
      node.dataset.workSection = key;
      node.append(el('div', 'work-overview-label', label));
      host.append(node);
    }
    return node;
  };
  const rowButton = (container: HTMLElement, row: OverviewRow): HTMLButtonElement => {
    const { id: sessionId, title, state, detail } = row;
    let button = [...container.children].find(child => child.classList.contains('work-overview-row') &&
      (child as HTMLElement).dataset.sessionId === sessionId) as HTMLButtonElement | undefined;
    if (!button) {
      button = el('button', 'work-overview-row') as HTMLButtonElement;
      button.type = 'button';
      button.dataset.sessionId = sessionId;
      if (row.kind === 'delivery') button.dataset.workKind = 'delivery';
      button.append(el('span', 'work-overview-title'), el('span', 'work-overview-state'), el('span', 'work-overview-detail'));
      button.addEventListener('click', () => {
        if (row.kind !== 'delivery') return openWorkOverviewPane(sessionId, button!);
        const panel = $<HTMLDetailsElement>('deliveryQueuePanel');
        if (panel.hidden) return;
        panel.open = true;
        panel.scrollIntoView?.({ block: 'nearest' });
        (panel.querySelector('summary') as HTMLElement | null)?.focus({ preventScroll: true });
      });
    }
    if (row.kind !== 'delivery') {
      button.setAttribute('aria-expanded', String(workOverviewSessionId === sessionId && workOverviewSelectedRow(sessionId) === button));
      button.setAttribute('aria-controls', 'workOverviewPane');
    } else {
      button.removeAttribute('aria-expanded');
      button.removeAttribute('aria-controls');
      button.setAttribute('aria-label', `Open Delivery queue · ${state}`);
    }
    const tooltip = detail ? `${title}\n${state}\n${detail}` : `${title}\n${state}`;
    if (button.title !== tooltip) button.title = tooltip;
    for (const [selector, value] of [
      ['.work-overview-title', title], ['.work-overview-state', state],
      ['.work-overview-detail', detail || 'Open this chat for its full progress evidence.']
    ] as const) {
      const field = button.querySelector<HTMLElement>(selector)!;
      if (field.textContent !== value) field.textContent = value;
      if (selector === '.work-overview-state') {
        const stateClass = workOverviewStateClass(state);
        field.className = 'work-overview-state' + (stateClass ? ' ' + stateClass : '');
      }
    }
    return button;
  };

  const updateSection = (container: HTMLElement, rows: OverviewRow[], empty: string, remainder = '',
    footer?: HTMLElement): void => {
    const nodes: HTMLElement[] = rows.map(row => rowButton(container, row));
    if (!nodes.length) {
      let placeholder = [...container.children].find(child => child.classList.contains('work-overview-empty')) as HTMLElement | undefined;
      if (!placeholder) placeholder = el('div', 'work-overview-empty', empty);
      if (placeholder.textContent !== empty) placeholder.textContent = empty;
      nodes.push(placeholder);
    }
    if (remainder) {
      const note = [...container.children].find(child => child.classList.contains('work-overview-more-note')) as HTMLElement | undefined ??
        el('p', 'work-overview-more-note');
      if (note.textContent !== remainder) note.textContent = remainder;
      nodes.push(note);
    }
    if (footer) nodes.push(footer);
    if (pane?.parentElement === container) {
      const selectedIndex = nodes.findIndex(node => node.classList.contains('work-overview-row') &&
        node.dataset.sessionId === workOverviewSessionId);
      if (selectedIndex >= 0) {
        // The row still belongs to this section: keep the pane at its exact DOM
        // position, preserving native selection, focus and its retained result.
        nodes.splice(selectedIndex + 1, 0, pane);
      } else {
        // Its row moved to another feed or was removed. Park only at this actual
        // ownership change before the old section drops its extra children.
        host.before(pane);
      }
    }
    // Reconcile the two short feeds in place. Recreating a focused row on each session
    // update loses keyboard position and needlessly rebuilds the same DOM subtree.
    for (const [index, node] of nodes.entries()) {
      const at = container.children.item(index + 1);
      if (at !== node) container.insertBefore(node, at);
    }
    while (container.children.length > nodes.length + 1) container.lastElementChild?.remove();
  };

  const current = section('Current work & holds', 'current');
  updateSection(current, [
    ...automated.map(chat => ({ id: chat.sessionId, title: chat.title,
      state: inspectedOffSessions.has(chat.sessionId)
        ? inspectedOffLabel(sessions.find(row => row.id === chat.sessionId)) : automationStateLabel(chat),
      detail: inspectedOffSessions.has(chat.sessionId)
        ? inspectedOffDetail(chat, sessions.find(row => row.id === chat.sessionId)) :
        automationStatusUnknown(chat) ? [chat.reason, chat.nextAction].filter(Boolean).join(' · Next: ') :
          chat.nextAction || chat.reason })),
    ...ordinaryBlocked.map(row => ({ id: row.id, title: row.title, state: 'blocked',
      detail: 'Local conversation block is active; no current execution is proven. Review the existing chat block and saved work.' })),
    ...ordinaryActive.map(row => ({ id: row.id, title: row.title,
      state: row.activeTurnId ? 'turn open' : 'recent evidence',
      detail: row.activeTurnId
        ? 'Open native turn is recorded; current execution is unverified. Inspect the exact provider and local-tool outcomes.'
        : 'Current execution is unverified. Recent turn or tool activity is saved; inspect its exact outcomes.' })),
    ...ordinaryOpenUnverified.map(row => ({ id: row.id, title: row.title, state: 'turn open · evidence stale',
      detail: 'Recorded native turn remains open without a recent work signal. Current execution and completion are unknown; inspect exact provider and Core receipts.' })),
    ...ordinaryEnded.map(row => ({ id: row.id, title: row.title, state: ordinaryTerminalOutcome(row)!,
      detail: `Last turn ${TURN_OUTCOME_LABELS[ordinaryTerminalOutcome(row)!]}. Inspect the saved result before any new action.` })),
    ...(deliveryState ? [{ id: 'delivery-queue', title: 'Delivery queue', state: deliveryState,
      detail: 'Review saved messages and exact delivery receipts in the existing Delivery queue.', kind: 'delivery' as const }] : [])
  ], 'No chat is currently working, waiting, paused, blocked, repairing, or asking for attention.');

  const updates = section('Recent updates', 'updates');
  const moreUpdatesCount = Math.max(0, allRecentUpdates.length - workOverviewUpdatesShown);
  let moreUpdates: HTMLButtonElement | undefined;
  if (moreUpdatesCount) {
    // Reuse the same disclosure button across status paints. Rebuilding it
    // while focused makes keyboard users lose their place on every tool update.
    moreUpdates = [...updates.children].find(child =>
      child.classList.contains('work-overview-more-updates')) as HTMLButtonElement | undefined ??
      el('button', 'work-overview-more-updates') as HTMLButtonElement;
    moreUpdates.type = 'button';
    moreUpdates.dataset.workAction = 'more-updates';
    const batchSize = Math.min(WORK_UPDATES_PAGE_SIZE, moreUpdatesCount);
    const shown = Math.min(workOverviewUpdatesShown, allRecentUpdates.length);
    moreUpdates.textContent = `Show ${batchSize} older update${batchSize === 1 ? '' : 's'} · ${shown} of ${allRecentUpdates.length} shown`;
    moreUpdates.setAttribute('aria-label',
      `Show ${batchSize} older saved work updates. ${shown} of ${allRecentUpdates.length} currently loaded updates are visible. Open an update to inspect its exact saved output.`);
    moreUpdates.onclick = () => {
      // Keep the first newly exposed result navigable even when the final
      // click removes this button. An explicit expansion is not another
      // fetch, Send, or claim of worker/Prime acknowledgment.
      const firstNewId = allRecentUpdates[workOverviewUpdatesShown]?.row.id;
      workOverviewUpdatesShown += WORK_UPDATES_PAGE_SIZE;
      paintWorkOverview(false);
      const firstNew = [...updates.querySelectorAll<HTMLButtonElement>('.work-overview-row')]
        .find(row => row.dataset.sessionId === firstNewId);
      firstNew?.focus({ preventScroll: true });
      firstNew?.scrollIntoView?.({ block: 'nearest' });
    };
  } else if (sessionPageCursor && sessions.length < sessionTotal) {
    // The prior six-at-a-time disclosure only sees summaries already paged into
    // the sidebar. Expose the EXISTING session cursor here explicitly, so a
    // closed worker/one-off beyond the first 60 is actually discoverable from
    // Work. Never fetch in paint, poll in the background, or imply all historical
    // records have been loaded.
    const load = [...updates.children].find(child =>
      (child as HTMLElement).dataset.workAction === 'load-older-updates') as HTMLButtonElement | undefined ??
      el('button', 'work-overview-more-updates') as HTMLButtonElement;
    load.type = 'button';
    load.dataset.workAction = 'load-older-updates';
    load.disabled = workOverviewOlderPageLoading || sessionPageLoading;
    load.textContent = workOverviewOlderPageLoading || sessionPageLoading
      ? 'Reading older saved sessions…'
      : workOverviewOlderPageError
        ? 'Older saved sessions unavailable · Retry read'
        : `Load older saved sessions · ${sessions.length} of ${sessionTotal} session summaries loaded`;
    load.setAttribute('aria-label', `${load.textContent}. This is an explicit read of the next existing session page, not a retry of a native message or automatic work.`);
    load.onclick = async () => {
      if (workOverviewOlderPageLoading || sessionPageLoading || !sessionPageCursor) return;
      const beforeIds = new Set(sessions.map(row => row.id));
      const beforeCursor = sessionPageCursor;
      const visibleIds = new Set([...updates.querySelectorAll<HTMLButtonElement>('.work-overview-row')]
        .map(row => row.dataset.sessionId));
      const hadFocus = document.activeElement === load;
      workOverviewOlderPageLoading = true;
      workOverviewOlderPageError = false;
      paintWorkOverview(false);
      try {
        // Reuse sidebar pagination and its stale-page/supervisor guards. Older
        // pages cannot change authoritative status, current block receipts or
        // active provider controls.
        await loadMoreSessions();
        const added = sessions.filter(row => !beforeIds.has(row.id));
        workOverviewOlderPageError = !added.length && sessionPageCursor === beforeCursor;
        if (added.some(row => row.fileEdits > 0 || !!row.lastFinishReportAt ||
            !!row.lastAssistantFinalAt || !!row.lastTurnEndAt ||
            row.toolCalls > 0 && !!row.lastToolCallAt)) {
          workOverviewUpdatesShown += WORK_UPDATES_PAGE_SIZE;
        }
      } catch {
        workOverviewOlderPageError = true;
      } finally {
        workOverviewOlderPageLoading = false;
        paintWorkOverview(false);
        // An in-flight read can settle while the user has moved to another
        // control. Restore focus only if this explicit button owned it.
        if (hadFocus && (document.activeElement === load || document.activeElement === document.body)) {
          const firstNew = [...updates.querySelectorAll<HTMLButtonElement>('.work-overview-row')]
            .find(row => !visibleIds.has(row.dataset.sessionId));
          const target = firstNew ?? updates.querySelector<HTMLButtonElement>('[data-work-action="load-older-updates"]') ??
            document.querySelector<HTMLElement>('#workOverview > summary');
          target?.focus({ preventScroll: true });
          firstNew?.scrollIntoView?.({ block: 'nearest' });
        }
      }
    };
    moreUpdates = load;
  }
  updateSection(updates, recentUpdates.map(update => ({ id: update.row.id, title: update.row.title,
    state: update.state, detail: update.detail })), 'No retained file changes, final answers, worker reports, or tool observations yet.',
    '', moreUpdates);
  const older = section('Earlier turn outcomes', 'older');
  older.hidden = olderOrdinaryOutcomes.length === 0;
  const moreOlder = Math.max(0, olderOrdinaryOutcomes.length - olderPreviewLimit);
  updateSection(older, olderOrdinaryOutcomes.slice(0, olderPreviewLimit).map(row => {
    const outcome = ordinaryTerminalOutcome(row)!;
    const ended = row.lastTurnEndAt && row.lastTurnEndAt > 0
      ? `Last recorded ${ago(row.lastTurnEndAt)}` : 'End time not recorded';
    return { id: row.id, title: row.title, state: `last ${outcome}`,
      detail: `${ended} · historical ${TURN_OUTCOME_LABELS[outcome]}. No later turn is recorded; open to inspect this saved session before any new action.` };
  }), 'No earlier failed, interrupted, stalled or unknown turns in the loaded session list.',
  moreOlder ? `${moreOlder} more recorded outcome${moreOlder === 1 ? '' : 's'} in loaded sessions. Open its chat from the session list.` : '');
  // A session can stop qualifying for either feed during an evidence refresh. With no
  // live row to own aria-expanded/focus, dismiss its old detail in the same paint.
  if (workOverviewSessionId && !workOverviewSelectedRow(workOverviewSessionId)) {
    closeWorkOverviewPane(workOverviewSessionId);
    return;
  }
  paintWorkOverviewPane();
  if (focusedPaneAction && pane && !pane.hidden) {
    const action = pane.querySelector<HTMLElement>(`[data-work-action="${focusedPaneAction}"]`) ??
      pane.querySelector<HTMLButtonElement>('button[data-work-action="close"]');
    action?.focus({ preventScroll: true });
  }
  if (refreshSelectedDetail && workOverviewSessionId) void refreshWorkOverviewPane(workOverviewSessionId);
}

function sessionBadges(summary: SessionSummary, automation?: AutomationChatProjection): Badge[] {
  const badges: Badge[] = [];
  const origin = summary.origin;
  const workerId = recordedWorkerId(summary);
  // The one session that is not a chat. Saying so on the row is what stops it reading
  // as a chat that mysteriously lost its name.
  if (summary.conversationId === null) {
    return unattributedBlocked()
      ? [{ text: 'blocked', tone: 'is-failed' }, { text: 'not a chat', tone: '' }]
      : [{ text: 'not a chat', tone: '' }];
  }
  // First, and in the failure tone: a blocked chat is the one state on this row that says the
  // app is actively refusing work, and the user came to the list to find it at a glance.
  if (blockedChats.has(summary.conversationId)) badges.push({ text: 'blocked', tone: 'is-failed' });
  const terminal = !automation ? ordinaryTerminalOutcome(summary) : null;
  if (terminal) badges.push({ text: terminal, tone: ['failed', 'interrupted', 'stalled'].includes(terminal) ? 'is-failed' : '' });
  if (workerId) badges.push({ text: workerId, tone: '' });
  else if (origin?.kind === 'resume') badges.push({ text: 'resumed', tone: '' });
  else if (summary.agents.includes('prime')) badges.push({ text: 'prime', tone: '' });

  // Agent ids are reused across runs (`worker-1`, `worker-2`, ...). Matching only by that
  // short id made old worker sessions inherit the *current* run's live badge, so a worker
  // chat from 20 minutes ago suddenly said "active" again when a new worker-2 started.
  // Conversation id is the durable identity of the actual ChatGPT tab, so only that exact
  // worker session may borrow the live swarm state.
  const agent = workerId && workerId !== 'worker'
    ? swarm?.agents.find(
        (entry) =>
          entry.id === workerId &&
          Boolean(entry.conversationId) &&
          entry.conversationId === summary.conversationId
      )
    : swarm?.agents.find(
        (entry) => entry.role === 'prime' && entry.conversationId === summary.conversationId
      );
  // Owning a run is not the same as running a turn. Exact chat activity wins; only an idle
  // worker falls back to its broker lifecycle label.
  // Exact recorded tool activity belongs to the session, not to the renderer's current swarm
  // projection. A parked/restarted run can lose its AgentView while the chat still makes calls.
  const workerStopped = agent?.role === 'worker' && ['sleeping', 'finished', 'failed'].includes(agent.state);
  if (workerStopped) badges.push(AGENT_BADGE[agent.state]);
  // The swarm no longer shows this worker — its run parked when it and its siblings stopped —
  // but its own session records that its last call was the finish report. That is a worker
  // between jobs, and "sleeping" is the word that says its chat can be woken.
  else if (!agent && workerId && typeof summary.lastFinishReportAt === 'number' &&
      summary.lastFinishReportAt >= (summary.lastToolCallAt ?? 0)) badges.push(AGENT_BADGE.sleeping);
  // A top-level Goal/Loop row has one status owner: the automation projection below. Its
  // recent-activity grace must not independently add a second spinner here.
  else if (!automation && !workerId && sessionWorking(summary)) badges.push({ text: 'recent', tone: '' });
  else if (agent && agent.role !== 'prime') badges.push(AGENT_BADGE[agent.state]);
  return badges;
}

/** Truthful hover detail: a durable open turn alone is not proof that ChatGPT is still working. */
function sessionActivityHint(
  summary: SessionSummary,
  badges: readonly Badge[],
  automation?: DisplayedAutomationChat
): string {
  const state = badges.map((badge) => badge.text);
  if (state.includes('blocked')) return t("Needs attention — work is blocked or failed");
  if (automation && inspectedWorkModeOff(automation, summary)) return inspectedOffDetail(automation, summary);
  if (!automation && ordinaryTerminalOutcome(summary)) {
    return t('Last turn {0} — inspect the saved record before continuing', [
      t(TURN_OUTCOME_LABELS[ordinaryTerminalOutcome(summary)!])
    ]);
  }
  if (state.includes('failed')) return t("Needs attention — work is blocked or failed");
  if (automation && automationStatusUnknown(automation)) return t('unknown') + ' — ' + automation.reason;
  // The scheduler's explicit hold outranks a recent Core/tool activity window.
  // A tool may keep completing while the provider page is unavailable, or a user
  // may pause new work while an already-running tool finishes. That activity
  // remains visible in Last worked, but cannot change the hold into Working.
  if (automation?.state === 'blocked') return t('Needs attention — {0}', [automation.reason || t('This chat is blocked')]);
  if (automation?.state === 'paused') return t('{0} — {1}', [
    automation.pause?.phase === 'draining' ? t('Pausing') : t('Paused'),
    automation.reason || t('New automatic work is paused')
  ]);
  if (state.includes('sleeping') || state.includes('finished')) return t("Not generating — this worker is sleeping or finished");
  if (automation && automationShowsWorkingSpinner(automation)) return t("Working — an exact main-chat generation or local tool is active");
  if (automation?.state === 'stalled') return t("Needs attention — {0}", [automation.reason]);
  if (automation?.state === 'recovering') {
    const label = t(automationStateLabel(automation));
    return t('{0} — {1}', [label.charAt(0).toUpperCase() + label.slice(1), automation.reason]);
  }
  if (automation?.state === 'waiting-workers') return t("Waiting for workers — {0} still running", [automation.activeWorkers]);
  if (automation?.state === 'waiting-main') return t("Waiting for the main chat — {0}", [automation.reason]);
  if (sessionWorking(summary)) return t("Recent turn or tool activity; current execution unverified");
  if (summary.activeTurnId) return t("Waiting — the turn is open but no recent work signal was detected");
  return t("Idle — no current turn or recent tool activity");
}

type SessionProof = { at: number; label: 'edit' | 'tool' | 'message' | 'answer' | 'worked' };

/** Newest concrete evidence shown beside the scheduler state. */
function sessionProof(summary: SessionSummary): SessionProof {
  const workedAt = sessionLastWorkedAt(summary);
  if ((summary.lastFileChangeAt ?? 0) >= workedAt) return { at: summary.lastFileChangeAt!, label: 'edit' };
  if ((summary.lastToolCallAt ?? 0) >= workedAt) return { at: summary.lastToolCallAt!, label: 'tool' };
  if ((summary.lastMessageAt ?? 0) >= workedAt) return { at: summary.lastMessageAt!, label: 'message' };
  if (Math.max(summary.lastAssistantFinalAt ?? 0, summary.lastTurnEndAt ?? 0) >= workedAt) {
    return { at: workedAt, label: 'answer' };
  }
  return { at: workedAt, label: 'worked' };
}

/** Compact visible proof age; five-second buckets stay useful without a hot one-second loop. */
function sessionProofAge(proof: SessionProof, now = Date.now()): string {
  const elapsed = Math.max(0, now - proof.at);
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 5) return t('{0} now', [proof.label]);
  if (seconds < 60) return t('{0} {1}s', [proof.label, Math.floor(seconds / 5) * 5]);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return t('{0} {1}m', [proof.label, minutes]);
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t('{0} {1}h', [proof.label, hours]);
  return t('{0} {1}d', [proof.label, Math.floor(hours / 24)]);
}

/** The precise next boundary at which the compact proof text can change. */
function nextSessionProofAgeChange(summary: SessionSummary, now: number): number {
  const proofAt = sessionProof(summary).at;
  const elapsed = Math.max(0, now - proofAt);
  const unit = elapsed < 60_000 ? 5_000 : elapsed < 60 * 60_000 ? 60_000 : elapsed < 48 * 60 * 60_000 ? 60 * 60_000 : 24 * 60 * 60_000;
  return proofAt + (Math.floor(elapsed / unit) + 1) * unit;
}

/** Aggregated from recorded tool diffstats; it never claims to be the repository's Git status. */
function sessionChangeStats(summary: SessionSummary): string {
  const edits = Math.max(0, summary.fileEdits ?? 0);
  if (edits === 0) return '';
  const approximation = summary.approximateFileChanges ? '~' : '';
  return `${compactNumber(edits)} ${edits === 1 ? 'file edit' : 'file edits'} · ${approximation}+${compactNumber(summary.linesAdded ?? 0)} −${compactNumber(summary.linesRemoved ?? 0)}`;
}

function canOwnWorkerLimit(summary: SessionSummary): boolean {
  return Boolean(summary.conversationId) && summary.origin?.kind !== 'worker' && summary.origin?.kind !== 'helper';
}

function effectiveGlobalWorkerLimit(): number {
  return Math.min(MAX_MULTI_AGENT_WORKERS, deps.state()?.config?.multiAgent?.maxWorkers ?? MAX_MULTI_AGENT_WORKERS);
}

function sessionWorkerLimitLabel(summary: SessionSummary, globalLimit: number): string {
  const effectiveGlobal = Math.min(MAX_MULTI_AGENT_WORKERS, globalLimit);
  const savedLimit = summary.workerLimit ?? null;
  if (savedLimit == null) {
    return t('Sub-agent limit: Global ({0}). Click to set a limit for this chat.', [effectiveGlobal]);
  }
  const effective = Math.min(effectiveGlobal, savedLimit);
  if (savedLimit !== effective) {
    return t('Saved sub-agent limit: {0}. Effective limit: {1}. Click to change it.', [savedLimit, effective]);
  }
  return t('Sub-agent limit: {0} for this chat. Click to change it.', [savedLimit]);
}

function workerLifecycleText(progress: WorkerLifecycleProgress): string {
  if (progress.total === 0) return t('0 workers');
  return [
    progress.active ? t('{0} active', [progress.active]) : '',
    progress.queued ? t('{0} queued', [progress.queued]) : '',
    progress.finished ? t('{0} finished', [progress.finished]) : '',
    progress.failed ? t('{0} failed', [progress.failed]) : ''
  ].filter(Boolean).join(' · ');
}

function workerLifecycleTitle(progress: WorkerLifecycleProgress): string {
  const parts = [
    t('{0} worker(s) total', [progress.total]),
    t('{0} active', [progress.active]),
    t('{0} queued', [progress.queued]),
    t('{0} finished', [progress.finished]),
    t('{0} failed', [progress.failed])
  ];
  if (progress.names.length) parts.push(t('Active: {0}', [progress.names.join(', ')]));
  if (progress.failures.length) parts.push(t('Failures: {0}', [progress.failures.join(' · ')]));
  return parts.join(' · ');
}

async function editSessionWorkerLimits(selectedRows: readonly SessionSummary[]): Promise<void> {
  if (!selectedRows.length || selectedRows.some(row => !canOwnWorkerLimit(row))) return;
  const globalLimit = effectiveGlobalWorkerLimit();
  const firstLimit = selectedRows[0]?.workerLimit ?? null;
  const mixedLimits = selectedRows.some(row => (row.workerLimit ?? null) !== firstLimit);
  const answer = window.prompt(
    selectedRows.length === 1
      ? t('Sub-agent worker limit for this chat (1–{0}). Leave blank to use the global limit. The current global ceiling is {1}.', [MAX_MULTI_AGENT_WORKERS, globalLimit])
      : t('Sub-agent worker limit for {0} selected chats (1–{1}). Leave blank to use the global limit. The current global ceiling is {2}.', [selectedRows.length, MAX_MULTI_AGENT_WORKERS, globalLimit]),
    mixedLimits || firstLimit == null ? '' : String(firstLimit)
  );
  if (answer === null) return;
  const trimmed = answer.trim();
  const next = trimmed === '' ? null : Number(trimmed);
  if (next !== null && (!Number.isInteger(next) || next < 1 || next > MAX_MULTI_AGENT_WORKERS)) {
    toast(t('Enter a whole number from 1 to {0}, or leave it blank for the global limit.', [MAX_MULTI_AGENT_WORKERS]));
    return;
  }
  let succeeded = 0;
  let failed = 0;
  for (const row of selectedRows) {
    const updated = await run(api.setSessionWorkerLimit(row.id, next));
    if (!updated) {
      failed += 1;
      continue;
    }
    const index = sessions.findIndex(session => session.id === row.id);
    if (index >= 0) sessions[index] = updated;
    succeeded += 1;
  }
  if (succeeded) paintSessions();
  if (selectedRows.length > 1) {
    toast(t('Sub-agent limits: {0} updated, {1} failed.', [succeeded, failed]));
  } else if (succeeded) {
    toast(next === null
      ? t('This chat now follows the global worker limit ({0}).', [globalLimit])
      : next > globalLimit
        ? t('Saved {0} for this chat; the current global ceiling still limits it to {1}.', [next, globalLimit])
        : t('This chat can run up to {0} sub-agent worker(s).', [next]));
  }
}

function sessionRow(summary: SessionSummary): HTMLElement {
  const row = el('div', 'sess');
  row.dataset.id = summary.id;
  row.setAttribute('role', 'option');
  row.tabIndex = -1;
  if (summary.id === selectedId) row.classList.add('is-sel');
  if (multiSelectedSessions.has(summary.id)) row.classList.add('is-multi-sel');
  row.setAttribute('aria-selected', String(multiSelectedSessions.has(summary.id)));
  if (summary.id === activeId && summary.endedAt === null) row.classList.add('is-live');
  if (sidebarPins.has(summary.id)) row.classList.add('is-pinned');

  const main = el('div', 'sess-main');
  const top = el('div', 'sess-top');
  const meta = el('div', 'sess-meta');
  const title = el('b', 'sess-nickname', () => summary.title || t("Untitled session")); title.dir = 'auto';
  const originalTitle = summary.originalTitle?.trim() && summary.originalTitle.trim() !== summary.title.trim()
    ? summary.originalTitle.trim()
    : '';
  if (renamingSessionId === summary.id) {
    const input = document.createElement('input');
    input.className = 'sess-rename-input'; input.type = 'text'; input.maxLength = 120;
    input.value = summary.title || ''; input.setAttribute('aria-label', t("Chat nickname"));
    let settled = false;
    const finish = async (save: boolean) => {
      if (settled) return; settled = true;
      const next = input.value.trim();
      if (save && next && next !== summary.title) {
        const done = await run(api.renameSession(summary.id, next));
        if (done !== null) {
          const current = sessions.find(entry => entry.id === summary.id);
          if (current) { current.title = next; current.titleSource = 'manual'; }
          if (selectedId === summary.id) $('chatTitle').textContent = next;
          toast(t("Chat nickname saved"));
        }
      }
      renamingSessionId = null; paintSessions();
    };
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
    });
    input.addEventListener('blur', () => void finish(true));
    top.append(input);
    queueMicrotask(() => { input.focus(); input.select(); });
  } else {
    const titles = el('div', 'sess-titles');
    titles.append(title);
    if (originalTitle && expandedSessionTitles.has(summary.id)) {
      const original = el('span', 'sess-original-title', originalTitle);
      original.dir = 'auto';
      original.title = originalTitle;
      titles.append(original);
    }
    top.append(titles);
    if (originalTitle) {
      const reveal = el('button', 'sess-title-toggle') as HTMLButtonElement;
      reveal.type = 'button';
      reveal.append(icon('i-chev'));
      reveal.setAttribute('aria-expanded', String(expandedSessionTitles.has(summary.id)));
      ui(reveal, 'aria-label', () => expandedSessionTitles.has(summary.id)
        ? t("Hide original ChatGPT title")
        : t("Show original ChatGPT title"));
      reveal.addEventListener('click', event => {
        event.stopPropagation();
        expandedSessionTitles.has(summary.id)
          ? expandedSessionTitles.delete(summary.id)
          : expandedSessionTitles.add(summary.id);
        paintSessions();
      });
      top.append(reveal);
    }
  }
  const automation = automationForSummary(summary) ?? undefined;
  const inspectedOff = !!automation && inspectedWorkModeOff(automation, summary);
  const badges = sessionBadges(summary, automation);
  const changeStats = sessionChangeStats(summary);
  const workedAt = sessionLastWorkedAt(summary);
  const proof = sessionProof(summary);
  if (automation && !automation.bindingUnverified && !inspectedOff) {
    const modeLabel = automation.mode === 'goal' ? t('Goal') : t('Loop');
    const mode = el('span', `sess-mode-badge is-${automation.mode}`, automation.mode === 'goal' ? 'G' : 'L');
    mode.title = modeLabel;
    mode.setAttribute('aria-label', modeLabel);
    top.append(mode);
  }
  if (summary.conversationId && rotationBatchMembers().has(summary.conversationId)) {
    const membership = el('span', 'sess-batch-membership', 'Batch');
    membership.title = t('This chat belongs to the rotating batch. Right-click it to remove it without changing its Goal or Loop.');
    membership.setAttribute('aria-label', membership.title);
    top.append(membership);
  }
  if (canOwnWorkerLimit(summary)) {
    // Partial renderer fixtures and an early startup repaint can legitimately have no hydrated
    // config yet. Keep the sidebar usable until the first full app snapshot arrives.
    const globalLimit = effectiveGlobalWorkerLimit();
    const savedLimit = summary.workerLimit ?? null;
    const effectiveLimit = Math.min(MAX_MULTI_AGENT_WORKERS, globalLimit, savedLimit ?? globalLimit);
    const workerLimit = el('button', `sess-worker-limit${savedLimit == null ? ' is-global' : ' is-custom'}${savedLimit != null && savedLimit > effectiveLimit ? ' is-clamped' : ''}`, `A${effectiveLimit}`) as HTMLButtonElement;
    workerLimit.type = 'button';
    const label = sessionWorkerLimitLabel(summary, globalLimit);
    workerLimit.title = label;
    workerLimit.setAttribute('aria-label', label);
    workerLimit.addEventListener('click', event => {
      event.stopPropagation();
      document.getElementById('sessionTooltip')?.remove();
      void editSessionWorkerLimits([summary]);
    });
    top.append(workerLimit);
    const workerProgress = workerProgressBySession.get(summary.id);
    if (workerProgress) {
      const workerSummary = el('span', `sess-worker-summary${workerProgress.failed > 0 ? ' has-failures' : ''}`,
        workerLifecycleText(workerProgress));
      workerSummary.title = workerLifecycleTitle(workerProgress);
      workerSummary.setAttribute('aria-label', workerSummary.title);
      meta.append(workerSummary);
    }
  }
  if (automation) {
    const label = inspectedOff ? inspectedOffLabel(summary) : automationStateLabel(automation);
    const recoveryClass = automationRecoveryClass(automation);
    const unknownClass = automationStatusUnknown(automation) ? ' is-unknown' : '';
    const state = el('span', 'sess-automation-state is-' + (inspectedOff ? 'paused' : automation.state) +
      (inspectedOff ? '' : recoveryClass + unknownClass), t(label));
    ui(state, 'title', () => inspectedOff ? inspectedOffDetail(automation, summary) : `${automation.reason} ${automation.nextAction}`);
    ui(state, 'aria-label', () => inspectedOff ? inspectedOffDetail(automation, summary) : `${t(label)}. ${automation.reason} ${automation.nextAction}`);
    meta.append(state);
    if (automation.pause && !inspectedOff) {
      const unfinished = [
        automation.pause.mainTurn ? t('main turn') : '',
        automation.pause.runningTools ? t('{0} tools', [automation.pause.runningTools]) : '',
        automation.pause.activeWorkers ? t('{0} workers', [automation.pause.activeWorkers]) : '',
        automation.pause.handoff ? t('handoff') : '',
        automation.pause.browserAction ? t('browser') : ''
      ].filter(Boolean);
      const text = automation.pause.phase === 'ready'
        ? t('safe to restart')
        : t('{0} left · {1}', [automation.pause.remaining, unfinished.join(' · ')]);
      const progress = el('span', `sess-pause-progress is-${automation.pause.phase}`, text);
      progress.title = automation.pause.phase === 'ready'
        ? t('This chat is fully drained and safe for an app restart.')
        : t('No new turns can start. Waiting only for: {0}.', [unfinished.join(', ')]);
      progress.setAttribute('aria-label', progress.title);
      meta.append(progress);
    }
    if (automation.rotation && !inspectedOff) {
      const rotationLabel = automation.rotation.state === 'queued'
        ? automation.rotation.previous
          ? t('queue #{0} · previous batch', [automation.rotation.position])
          : t('queue #{0}', [automation.rotation.position])
        : automation.rotation.state === 'foreground'
          ? t('priority slot {0}', [automation.rotation.position])
        : automation.rotation.state === 'attention'
          ? t('needs attention · revisit')
        : automation.rotation.state === 'draining'
          ? t('batch slot {0} · finishing', [automation.rotation.position])
          : t('batch slot {0}', [automation.rotation.position]);
      const rotation = el('span', `sess-rotation is-${automation.rotation.state}`, rotationLabel);
      rotation.title = automation.rotation.state === 'queued'
        ? t('Waiting at position {0} in the rotating Loop queue. New chats are prioritized for the next batch.', [automation.rotation.position])
        : automation.rotation.state === 'foreground'
          ? t('Temporary foreground slot {0}. This chat may finish its current turn, then returns to the front of the regular queue.', [automation.rotation.position])
        : automation.rotation.state === 'attention'
          ? t('This chat made no durable progress for 15 minutes, so Rotation freed its slot. Open it and send or retry to give it a temporary priority slot without losing its Goal or Loop.')
        : automation.rotation.state === 'draining'
          ? t('Batch slot {0}. The rotation timer elapsed; only this chat\'s already-started turn, tools, or workers are allowed to finish before the next batch opens.', [automation.rotation.position])
          : t('Active rotation batch slot {0}.', [automation.rotation.position]);
      rotation.setAttribute('aria-label', rotation.title);
      meta.append(rotation);
    }
    if (automation.nextRetryAt && !inspectedOff) {
      const retry = el('span', `sess-automation-retry${recoveryClass}`, automationRetryLabel(automation.nextRetryAt));
      ui(retry, 'title', () => `${t('Next automatic retry {0}', [new Date(automation.nextRetryAt!).toLocaleTimeString(currentLanguage())])}. ${automation.reason}`);
      ui(retry, 'aria-label', () => `${automationRetryLabel(automation.nextRetryAt!)}. ${automation.reason}`);
      meta.append(retry);
    }
  }
  const workAge = el('span', `sess-last-work is-${proof.label}`, sessionProofAge(proof));
  const proofTitle = proof.label === 'edit'
    ? t('Last recorded file change {0}', [ago(proof.at)])
    : proof.label === 'tool'
      ? t('Last exact tool activity {0}', [ago(proof.at)])
      : t('Last worked {0}', [ago(workedAt)]);
  workAge.title = proofTitle;
  workAge.setAttribute('aria-label', proofTitle);
  meta.append(workAge);
  ui(row, 'title', () => [summary.title || t("Untitled session"), originalTitle ? `${t("Original")}: ${originalTitle}` : '',
    ...badges.map((badge) => t(badge.text)), changeStats, sessionActivityHint(summary, badges, automation),
    automation && !inspectedOff ? t(automation.mode === 'goal' ? 'Goal' : 'Loop') : '',
    automation ? inspectedOff ? inspectedOffDetail(automation, summary)
      : `${t(automationStateLabel(automation))}: ${automation.reason} ${automation.nextAction}` : '',
    automation?.nextRetryAt && !inspectedOff ? t('Next automatic check {0}', [new Date(automation.nextRetryAt).toLocaleTimeString(currentLanguage())]) : '',
    proofTitle, t('Last worked {0}', [ago(workedAt)])].filter(Boolean).join(' · '));
  const showTip = () => {
    document.getElementById('sessionTooltip')?.remove();
    const tip = el('div', 'session-tooltip', row.title);
    tip.id = 'sessionTooltip'; tip.setAttribute('role', 'tooltip');
    const bounds = row.getBoundingClientRect();
    tip.style.left = `${Math.min(bounds.right + 10, window.innerWidth - 290)}px`;
    tip.style.top = `${Math.min(bounds.top, window.innerHeight - 110)}px`;
    document.body.append(tip);
  };
  row.addEventListener('pointerenter', showTip);
  row.addEventListener('pointerleave', () => document.getElementById('sessionTooltip')?.remove());
  row.addEventListener('click', () => document.getElementById('sessionTooltip')?.remove());
  const status = badges.find((badge) => badge.tone);
  const spinning = automation && !inspectedOff ? automationShowsWorkingSpinner(automation) : false;
  if (spinning || automation?.state === 'recovering' && !inspectedOff) {
    const automationProjection = automation!;
    const indicator = el('span', `session-status ${spinning ? 'is-working' : 'is-recovering'}${automationRecoveryClass(automationProjection)}`);
    ui(indicator, 'title', () => `${t(automationStateLabel(automationProjection))}. ${automationProjection.reason}`);
    ui(indicator, 'aria-label', () => `${t(automationStateLabel(automationProjection))}. ${automationProjection.reason}`);
    top.append(indicator);
  } else if (status) {
    const indicator = el('span', `session-status ${status.tone}`);
    ui(indicator, 'title', () => t(status.text));
    ui(indicator, 'aria-label', () => t(status.text));
    top.append(indicator);
  }
  if (changeStats) {
    const stats = el('span', 'sess-code-stats', changeStats);
    stats.title = 'Recorded local tool changes';
    meta.append(stats);
  }
  const actionBar = el('div', 'sess-actions');
  const more = document.createElement('button');
  more.className = 'btn sess-action sess-more'; more.type = 'button';
  ui(more, 'title', () => t('More chat actions'));
  ui(more, 'aria-label', () => t('More chat actions'));
  more.setAttribute('aria-haspopup', 'menu');
  more.append(icon('i-more'));
  more.addEventListener('click', event => {
    event.stopPropagation();
    const bounds = row.getBoundingClientRect();
    selectOnlyForContextMenu(summary.id, true);
    paintSessions();
    showSessionContextMenu(Math.max(8, bounds.right - 8), bounds.top + Math.min(28, bounds.height));
  });
  actionBar.append(more);
  main.append(top, meta);
  row.append(main, actionBar);
  return row;
}

/** Copy renderer-owned attributes without replacing a live row or status indicator. */
function syncSessionElement(target: HTMLElement, source: HTMLElement): void {
  for (const attribute of [...target.attributes]) {
    if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
  }
  for (const attribute of [...source.attributes]) target.setAttribute(attribute.name, attribute.value);
}

/**
 * Refresh one sidebar row in place.
 *
 * Session snapshots arrive frequently while a turn is running. Replacing the row on every
 * snapshot restarted its CSS spinner and discarded pointer/focus identity even when only a
 * label or timestamp changed. Keep the stable row, and keep the exact same indicator while it
 * represents the same state; newly built controls still replace the remaining children so
 * their closures always observe the newest summary.
 */
function refreshSessionRow(current: HTMLElement, next: HTMLElement): HTMLElement {
  const currentMain = current.querySelector<HTMLElement>(':scope > .sess-main');
  const nextMain = next.querySelector<HTMLElement>(':scope > .sess-main');
  const currentTop = currentMain?.querySelector<HTMLElement>(':scope > .sess-top');
  const nextTop = nextMain?.querySelector<HTMLElement>(':scope > .sess-top');
  const currentIndicator = currentTop?.querySelector<HTMLElement>(':scope > .session-status');
  const nextIndicator = nextTop?.querySelector<HTMLElement>(':scope > .session-status');
  const keepIndicator = currentMain && nextMain && currentTop && nextTop && currentIndicator && nextIndicator &&
    currentIndicator.className === nextIndicator.className;
  if (keepIndicator) {
    syncSessionElement(currentIndicator, nextIndicator);
    syncSessionElement(currentTop, nextTop);
    syncSessionElement(currentMain, nextMain);

    // Keep both the live top row and spinner connected throughout the patch. Moving the spinner
    // through the detached `next` tree would preserve object identity after the refresh but still
    // restart its CSS animation in Chromium.
    for (const child of [...currentTop.childNodes]) if (child !== currentIndicator) child.remove();
    const nextChildren = [...nextTop.childNodes];
    const indicatorIndex = nextChildren.indexOf(nextIndicator);
    nextChildren.forEach((child, index) => {
      if (child === nextIndicator) return;
      if (index < indicatorIndex) currentTop.insertBefore(child, currentIndicator);
      else currentTop.append(child);
    });

    // Metadata is cheap to replace, while the title row and its spinner stay mounted.
    for (const child of [...currentMain.childNodes]) if (child !== currentTop) child.remove();
    for (const child of [...nextMain.childNodes]) if (child !== nextTop) currentMain.append(child);

    syncSessionElement(current, next);
    for (const child of [...current.childNodes]) if (child !== currentMain) child.remove();
    for (const child of [...next.childNodes]) if (child !== nextMain) current.append(child);
    return current;
  }
  syncSessionElement(current, next);
  current.replaceChildren(...next.childNodes);
  return current;
}

/**
 * Sidebar structure excludes row internals: those are hot status data refreshed in place.
 * Text and attributes outside rows remain part of the signature so folder/project headings,
 * disclosure state, pagination, and worker grouping still rebuild whenever they actually
 * change.
 */
function sidebarStructureSignature(nodes: readonly Node[]): string {
  const visit = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return `t:${node.textContent ?? ''}`;
    if (!(node instanceof Element)) return '';
    if (node instanceof HTMLElement && node.matches('.sess[data-id]')) return `row:${node.dataset.id ?? ''}`;
    const attributes = [...node.attributes]
      .map(attribute => `${attribute.name}=${attribute.value}`)
      .sort()
      .join(';');
    return `<${node.tagName}:${attributes}>${[...node.childNodes].map(visit).join('')}</${node.tagName}>`;
  };
  return nodes.map(visit).join('|');
}

async function openSessionInChrome(id: string, clickAt = performance.now()): Promise<void> {
  if (openingSessions.has(id)) return;
  openingSessions.add(id);
  paintSessions();
  const result = await run(api.openSessionChat(id, { clickAt, ipcAt: performance.now() }));
  openingSessions.delete(id);
  paintSessions();
  if (!result || result.ok) return;
  toastAction(result.message, t('Retry'), () => openSessionInChrome(id), 12_000);
}

async function toggleSessionBlocks(ids: readonly string[], blocked: boolean): Promise<void> {
  const selected = [...new Set(ids)];
  if (!selected.length) return;
  const next = await run(selected.length === 1
    ? api.setSessionBlocked(selected[0]!, blocked)
    : api.setSessionsBlocked(selected, blocked));
  if (next === null) return;
  blockedChats = new Set(next);
  paintSessions();
}

function paintTrashAction(): void {
  const button = $<HTMLButtonElement>('emptyTrash');
  button.hidden = deletedSessionTotal === 0;
  $('trashCount').textContent = deletedSessionTotal > 99 ? '99+' : String(deletedSessionTotal);
  button.title = t('Permanently delete {0} item(s) from Chat On Steroids Trash', [deletedSessionTotal]);
}

function trashTimestamp(value: number | null): string {
  return value === null ? t('Unknown') : new Date(value).toLocaleString(currentLanguage());
}

function paintTrashBrowser(): void {
  const browser = $('trashBrowser');
  if (browser.hidden) return;
  const list = $('trashList');
  list.replaceChildren();
  if (!deletedSessionRows.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = t('Trash is empty.'); list.append(empty); return;
  }
  for (const row of deletedSessionRows) {
    const item = document.createElement('div'); item.className = 'trash-row'; item.setAttribute('role', 'listitem');
    const main = document.createElement('div'); main.className = 'trash-row-main';
    const title = document.createElement('div'); title.className = 'trash-row-title'; title.textContent = row.title;
    const meta = document.createElement('div'); meta.className = 'trash-row-meta';
    meta.textContent = row.readable
      ? t('Deleted {0} · expires {1} · {2} linked chat(s)', [trashTimestamp(row.deletedAt), trashTimestamp(row.expiresAt), row.chatIds.length || Number(!!row.conversationId)])
      : t('Unreadable local history · permanent delete only');
    main.append(title, meta);
    const actions = document.createElement('div'); actions.className = 'trash-row-actions';
    const restore = document.createElement('button'); restore.className = 'btn'; restore.type = 'button'; restore.textContent = t('Restore & view'); restore.disabled = !row.readable;
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      const restored = await run(api.restoreDeletedSession(row.id));
      if (!restored) { restore.disabled = false; return; }
      deletedSessionIds.delete(row.id);
      await loadSessions();
      $('trashBrowser').hidden = true;
      if (sessions.some(session => session.id === row.id)) selectSession(row.id);
      toast(t('“{0}” restored. Its stopped automation remains off.', [row.title]));
    });
    const remove = document.createElement('button'); remove.className = 'btn'; remove.type = 'button'; remove.textContent = t('Permanently delete');
    remove.addEventListener('click', async () => {
      if (!window.confirm(t('Permanently delete “{0}” from Chat On Steroids Trash? This cannot be undone.', [row.title]))) return;
      const result = await run(api.permanentlyDeleteTrashedSession(row.id));
      if (!result) return;
      deletedSessionRows = deletedSessionRows.filter(entry => entry.id !== row.id);
      deletedSessionTotal = Math.max(0, deletedSessionTotal - result.removed);
      paintTrashAction(); paintTrashBrowser();
    });
    actions.append(restore, remove); item.append(main, actions); list.append(item);
  }
}

async function openTrashBrowser(): Promise<void> {
  const rows = await run(api.listDeletedSessions());
  if (!rows) return;
  deletedSessionRows = rows.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  deletedSessionTotal = rows.length;
  $('conversationActionsMenu').removeAttribute('open');
  $('trashBrowser').hidden = false;
  paintTrashAction(); paintTrashBrowser();
}

function selectedSessionIds(): string[] {
  return [...multiSelectedSessions].filter(id => sessions.some(session => session.id === id));
}

function paintSessionSelectionSummary(): void {
  const count = selectedSessionIds().length;
  const summary = $('sessionSelectionSummary');
  summary.hidden = count === 0;
  $('sessionSelectionCount').textContent = count ? t('{0} selected', [count]) : '';
}

function clearSessionSelection(repaint = true): void {
  multiSelectedSessions.clear();
  multiSelectAnchor = null;
  closeSessionContextMenu();
  if (repaint) paintSessions();
  else paintSessionSelectionSummary();
}

function removeDeletedSessionRows(ids: readonly string[]): void {
  const removed = new Set(ids);
  for (const id of removed) deletedSessionIds.add(id);
  sessions = sessions.filter((entry) => !removed.has(entry.id));
  for (const id of removed) {
    pressure.delete(id);
    multiSelectedSessions.delete(id);
  }
  sessionTotal = Math.max(0, sessionTotal - removed.size);
  if (selectedId && removed.has(selectedId)) {
    selectedId = null;
    events = [];
    totalEvents = 0;
    detailFor = null;
    detailCursor = null;
    handoff = null;
    handoffFor = null;
    detailLoadGeneration++;
    handoffLoadGeneration++;
  }
}

async function deleteSelectedSessions(ids: readonly string[], permanent: boolean): Promise<void> {
  const sessionsById = new Map(sessions.map((entry) => [entry.id, entry]));
  const selected = [...new Set(ids)].filter((id) => sessionsById.has(id));
  if (!selected.length) return;
  const names = selected.map((id) => sessionsById.get(id)?.title ?? t('Untitled session'));
  const question = permanent
    ? selected.length === 1
      ? t('Permanently delete “{0}” from Chat On Steroids? This cannot be undone. Its loop, queued messages, helpers, and worker run will be stopped, and its exact app-managed Chrome tabs will close. The ChatGPT website conversation is not deleted.', [names[0]!])
      : t('Permanently delete {0} selected conversations from Chat On Steroids? This cannot be undone. Their loops, queues, helpers, and worker runs will be stopped, and their exact app-managed Chrome tabs will close. ChatGPT website conversations are not deleted.', [selected.length])
    : selected.length === 1
      ? t('Move “{0}” to Chat On Steroids Trash? Its loop, queued messages, helpers, and worker run will be stopped, and its exact app-managed Chrome tabs will close. You can restore the local history for 30 days; its ChatGPT website conversation is not deleted.', [names[0]!])
      : t('Move {0} selected conversations to Chat On Steroids Trash? Their loops, queues, helpers, and worker runs will be stopped, and their exact app-managed Chrome tabs will close. Local history can be restored for 30 days; ChatGPT website conversations are not deleted.', [selected.length]);
  if (!window.confirm(question)) return;
  // The durable main-process transaction intentionally accepts at most 200 rows. A sidebar can
  // contain far more than that, so one confirmation drains the selection through small durable
  // batches instead of leaking the validator's "expected array" error into the UI. Collapse
  // selected legacy duplicates by exact conversation first: deletion already expands one member
  // to every exact duplicate, and sending another member in a later batch would look missing.
  const representativeIds: string[] = [];
  const representedConversations = new Set<string>();
  for (const id of selected) {
    const conversationId = sessionsById.get(id)?.conversationId ?? null;
    if (conversationId) {
      if (representedConversations.has(conversationId)) continue;
      representedConversations.add(conversationId);
    }
    representativeIds.push(id);
  }
  const receipts: SessionDeletionReceipt[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (let offset = 0; offset < representativeIds.length; offset += 100) {
    const result = await run(api.deleteSessions(representativeIds.slice(offset, offset + 100), permanent));
    if (!result) {
      await loadSessions();
      return;
    }
    receipts.push(...result.deleted);
    failed.push(...result.failed);
    if (result.failed.length) break;
  }
  const removed = receipts.map((receipt) => receipt.id);
  removeDeletedSessionRows(removed);
  if (!permanent) deletedSessionTotal += removed.length;
  await loadSessions();
  if (failed.length) {
    toast(t('{0} deleted; {1} failed: {2}', [removed.length, failed.length, failed[0]!.error]));
    return;
  }
  if (!permanent && receipts.length) {
    const undoReceipts = [...receipts];
    toastAction(
      undoReceipts.length === 1
        ? t('“{0}” moved to Trash and stopped', [undoReceipts[0]!.title])
        : t('{0} conversations moved to Trash and stopped', [undoReceipts.length]),
      t('Undo'),
      async () => {
        let restored = 0;
        for (const receipt of undoReceipts) {
          if (await run(api.restoreDeletedSession(receipt.id))) {
            deletedSessionIds.delete(receipt.id);
            restored++;
          }
        }
        await loadSessions();
        toast(restored === undoReceipts.length
          ? t('{0} conversation(s) restored. Their stopped automation remains off.', [restored])
          : t('{0} of {1} conversation(s) restored.', [restored, undoReceipts.length]));
      }
    );
  } else {
    toast(permanent
      ? t('{0} conversation(s) permanently deleted and stopped', [removed.length])
      : t('{0} conversation(s) moved to Trash and stopped', [removed.length]));
  }
}

async function emptySessionTrash(): Promise<void> {
  if (deletedSessionTotal <= 0) return;
  if (!window.confirm(t('Permanently delete all {0} items in Chat On Steroids Trash? This cannot be undone. Any duplicate live sessions for those exact conversations will also be stopped and removed. ChatGPT website conversations are not deleted.', [deletedSessionTotal]))) return;
  const result = await run(api.emptySessionTrash());
  if (!result) return;
  deletedSessionTotal = 0;
  deletedSessionRows = [];
  paintTrashAction();
  await loadSessions();
  toast(t('Trash emptied: {0} local histories removed; {1} live duplicate(s) stopped.', [result.removed, result.activeDuplicatesDeleted]));
  paintTrashBrowser();
}

function closeSessionContextMenu(): void {
  document.getElementById('sessionContextMenu')?.remove();
}

function extendSessionSelection(id: string): void {
  if (!multiSelectAnchor) {
    multiSelectedSessions.add(id);
    multiSelectAnchor = id;
    return;
  }
  const ids = visibleSessionRows().map((entry) => entry.dataset.id!).filter(Boolean);
  const from = ids.indexOf(multiSelectAnchor), to = ids.indexOf(id);
  if (from < 0 || to < 0) {
    multiSelectedSessions.add(id);
    return;
  }
  for (const member of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) {
    multiSelectedSessions.add(member);
  }
}

function visibleSessionRows(): HTMLElement[] {
  return [...$('sessionList').querySelectorAll<HTMLElement>('.sess[data-id]')]
    .filter(row => !row.closest('details:not([open])'));
}

function toggleSessionSelection(id: string): void {
  multiSelectedSessions.has(id) ? multiSelectedSessions.delete(id) : multiSelectedSessions.add(id);
  multiSelectAnchor = id;
}

function selectOnlyForContextMenu(id: string, forceSingle = false): void {
  if (!forceSingle && multiSelectedSessions.has(id)) return;
  multiSelectedSessions.clear();
  multiSelectedSessions.add(id);
  multiSelectAnchor = id;
}

function contextMenuButton(label: string, action: () => void | Promise<void>, danger = false, disabledReason = ''): HTMLButtonElement {
  const button = el('button', '', label) as HTMLButtonElement;
  if (danger) button.classList.add('is-danger');
  button.type = 'button'; button.setAttribute('role', 'menuitem');
  if (disabledReason) {
    button.disabled = true;
    button.title = disabledReason;
    button.setAttribute('aria-disabled', 'true');
  }
  button.addEventListener('click', event => {
    if (button.disabled) return;
    event.stopPropagation();
    closeSessionContextMenu();
    void action();
  });
  return button;
}

async function editSelectedAutomation(selectedRows: readonly SessionSummary[], mode: 'goal' | 'loop'): Promise<void> {
  // A multi-selection deliberately starts blank: fetching N individual controls before showing
  // the prompt made large selections look frozen. Main preflights the complete batch; only the
  // ordinary one-chat edit needs a round trip to prefill its current text.
  let shared = '';
  if (selectedRows.length === 1) {
    const control = await run(api.getSessionControls(selectedRows[0]!.id));
    if (!control) return;
    shared = control.objective?.trim() ?? '';
  }
  const name = mode === 'goal' ? t('Goal') : t('Loop');
  const answer = window.prompt(
    selectedRows.length === 1
      ? t('Enter the {0} for this chat. Saving it also turns {0} on.', [name])
      : t('Enter one shared {0} for all {1} selected chats. Saving it replaces their current Goal/Loop text and turns {0} on.', [name, selectedRows.length]),
    shared
  );
  if (answer === null) return;
  const objective = answer.trim();
  if (!objective) {
    toast(t('Enter a Goal or Loop, or use Remove Goal / Loop.'));
    return;
  }
  if (objective.length > MAX_AUTOMATION_OBJECTIVE_CHARS) {
    toast(t('Goals and Loops can be up to {0} characters.', [MAX_AUTOMATION_OBJECTIVE_CHARS.toLocaleString(currentLanguage())]));
    return;
  }
  const result = await run(api.setSessionsAutomation(selectedRows.map(row => row.id), mode, objective));
  if (!result) return;
  await loadSessions();
  toast(mode === 'goal'
    ? t('Shared Goal applied to {0} chat(s).', [result.updated])
    : t('Shared Loop applied to {0} chat(s).', [result.updated]));
}

async function removeSelectedAutomation(selectedRows: readonly SessionSummary[]): Promise<void> {
  const result = await run(api.setSessionsAutomation(selectedRows.map(row => row.id), 'off'));
  if (!result) return;
  await loadSessions();
  toast(t('Goal / Loop removed from {0} chat(s).', [result.updated]));
}

async function setSelectedAutomationPaused(selectedRows: readonly SessionSummary[], paused: boolean): Promise<void> {
  const result = await run(api.setSessionsAutomationPaused(selectedRows.map(row => row.id), paused));
  if (!result) return;
  await loadSessions();
  toast(paused
    ? t('{0} chat(s) are pausing after current work; {1} had nothing active to pause.', [result.updated, result.skipped])
    : t('{0} paused chat(s) resumed; {1} were already running or had no saved Goal/Loop.', [result.updated, result.skipped]));
}

function rotationBatchMembers(): Set<string> {
  return new Set(automationSupervisor?.rotation?.members ?? []);
}

async function setSelectedRotationMembership(selectedRows: readonly SessionSummary[], enrolled: boolean): Promise<void> {
  const result = await run(api.setRotationBatchMembership(selectedRows.map(row => row.id), enrolled));
  if (!result) return;
  await loadSessions();
  toast(enrolled
    ? t('Added {0} chat(s) to the rotation batch.', [result.updated])
    : t('Removed {0} chat(s) from the rotation batch. Their Goal/Loop settings were kept.', [result.updated]));
}

/** Native-feeling local collection menu. Deletion is explicit, confirmed and main-process-owned. */
function showSessionContextMenu(x: number, y: number): void {
  closeSessionContextMenu();
  const selected = [...multiSelectedSessions].filter(id => sessions.some(session => session.id === id));
  if (!selected.length) return;
  const selectedRows = selected.map(id => sessions.find(session => session.id === id)!).filter(Boolean);
  const menu = el('div', 'session-context-menu');
  menu.id = 'sessionContextMenu'; menu.setAttribute('role', 'menu');
  if (selected.length === 1) {
    const row = selectedRows[0]!;
    menu.append(el('div', 'session-context-label', () => t('Chat')));
    menu.append(contextMenuButton(sidebarPins.has(row.id) ? t('Unpin chat') : t('Pin chat'), () => {
      sidebarPins.toggle(row.id);
      paintSessions(true);
    }));
    menu.append(contextMenuButton(t('Add or edit chat nickname'), () => {
      renamingSessionId = row.id;
      paintSessions();
    }));
    if (row.conversationId) {
      const pending = openingSessions.has(row.id);
      menu.append(contextMenuButton(
        pending ? t('Opening this chat in Chrome…') : t('Open this chat in Chrome'),
        () => openSessionInChrome(row.id, performance.now()),
        false,
        pending ? t('This chat is already opening in Chrome.') : ''
      ));
      menu.append(contextMenuButton(t('Copy ChatGPT link'), async () => {
        const copied = await run(api.writeClipboard(`https://chatgpt.com/c/${encodeURIComponent(row.conversationId!)}`));
        if (copied) toast(t('ChatGPT link copied'));
      }));
    }
  }
  menu.append(contextMenuButton(selected.length === 1
    ? t('Create folder with this chat')
    : t('Create folder from {0} selected', [selected.length]), async () => {
    const name = window.prompt(t('Folder name'))?.trim();
    if (!name) return;
    const next = await run(api.createSidebarFolder(name, selected));
    if (next) {
      // A list refresh that started before this mutation must not overwrite the receipt.
      ++sessionsLoadGeneration;
      sidebarFolders = next;
      const created = next.find(folder => selected.every(id => folder.sessionIds.includes(id)));
      if (created) collapsedSidebarFolders.delete(created.id);
      paintSessions(true);
      toast(t('Folder created'));
    }
  }));
  if (sidebarFolders.length) {
    menu.append(el('div', 'session-context-label', () => selected.length === 1 ? t('Move this chat to') : t('Move selected to')));
    for (const folder of sidebarFolders) {
      menu.append(contextMenuButton(folder.name, async () => {
        const next = await run(api.assignSidebarFolder(folder.id, selected));
        if (next) { ++sessionsLoadGeneration; sidebarFolders = next; collapsedSidebarFolders.delete(folder.id); paintSessions(true); }
      }));
    }
  }
  if (selected.some(id => localFolderFor(id))) {
    menu.append(contextMenuButton(selected.length === 1 ? t('Remove this chat from folder') : t('Remove selected from folder'), async () => {
      const next = await run(api.assignSidebarFolder(null, selected));
      if (next) { ++sessionsLoadGeneration; sidebarFolders = next; paintSessions(true); }
    }));
  }

  menu.append(el('div', 'session-context-label', () => t('Automation')));
  const unsupportedAutomationSelection = selectedRows.some(row =>
    !row.conversationId || row.origin?.kind === 'worker' || row.origin?.kind === 'helper'
  );
  if (unsupportedAutomationSelection) {
    const reason = t('Goal and Loop batch editing is available only for normal conversations. This selection includes worker, helper, or Unattributed activity.');
    menu.append(contextMenuButton(t('Goal / Loop unavailable'), () => undefined, false, reason));
    menu.append(el('div', 'session-context-hint', reason));
  } else {
    const selectedActive = selectedRows.filter(row => {
      const automation = automationBySession.get(row.id);
      return automation && automation.state !== 'paused';
    });
    const selectedPaused = selectedRows.filter(row => automationBySession.get(row.id)?.state === 'paused');
    if (selectedActive.length) menu.append(contextMenuButton(
      selectedActive.length === 1 ? t('Pause after current work') : t('Pause after current work for {0} chats', [selectedActive.length]),
      () => setSelectedAutomationPaused(selectedActive, true)
    ));
    if (selectedPaused.length) menu.append(contextMenuButton(
      selectedPaused.length === 1 ? t('Resume paused chat') : t('Resume {0} paused chats', [selectedPaused.length]),
      () => setSelectedAutomationPaused(selectedPaused, false)
    ));
    menu.append(contextMenuButton(
      selected.length === 1 ? t('Set or edit Goal…') : t('Set or edit shared Goal for {0} chats…', [selected.length]),
      () => editSelectedAutomation(selectedRows, 'goal')
    ));
    menu.append(contextMenuButton(
      selected.length === 1 ? t('Set or edit Loop…') : t('Set or edit shared Loop for {0} chats…', [selected.length]),
      () => editSelectedAutomation(selectedRows, 'loop')
    ));
    menu.append(contextMenuButton(
      selected.length === 1 ? t('Remove Goal / Loop') : t('Remove Goal / Loop from {0} chats', [selected.length]),
      () => removeSelectedAutomation(selectedRows)
    ));
    const members = rotationBatchMembers();
    const hasOutsideBatch = selectedRows.some(row => !members.has(row.conversationId!));
    const hasInsideBatch = selectedRows.some(row => members.has(row.conversationId!));
    if (hasOutsideBatch) menu.append(contextMenuButton(
      selected.length === 1 ? t('Add to rotation batch') : t('Add selected to rotation batch'),
      () => setSelectedRotationMembership(selectedRows, true)
    ));
    if (hasInsideBatch) menu.append(contextMenuButton(
      selected.length === 1 ? t('Remove from rotation batch') : t('Remove selected from rotation batch'),
      () => setSelectedRotationMembership(selectedRows, false)
    ));
    menu.append(el('div', 'session-context-hint', () => t('Batch membership controls Rotation scheduling only. Goal and Loop text can still be edited while queued.')));
  }

  menu.append(el('div', 'session-context-label', () => t('Sub-agents')));
  const globalLimit = effectiveGlobalWorkerLimit();
  const unsupportedWorkerLimitSelection = selectedRows.some(row => !canOwnWorkerLimit(row));
  if (unsupportedWorkerLimitSelection) {
    const reason = t('Sub-agent limits are available only for normal conversations. This selection includes worker, helper, or Unattributed activity. Select only recorded chats.');
    menu.append(contextMenuButton(
      selected.length === 1 ? t('Sub-agent limit unavailable') : t('Sub-agent limit for {0} chats unavailable', [selected.length]),
      () => undefined,
      false,
      reason
    ));
    menu.append(el('div', 'session-context-hint', reason));
  } else {
    const firstLimit = selectedRows[0]?.workerLimit ?? null;
    const mixedLimits = selectedRows.some(row => (row.workerLimit ?? null) !== firstLimit);
    const shown = mixedLimits
      ? t('Mixed')
      : firstLimit == null
        ? t('Global ({0})', [globalLimit])
        : firstLimit > Math.min(MAX_MULTI_AGENT_WORKERS, globalLimit, firstLimit)
          ? t('{0} effective (saved {1})', [Math.min(MAX_MULTI_AGENT_WORKERS, globalLimit, firstLimit), firstLimit])
          : String(firstLimit);
    const label = selected.length === 1
      ? t('Sub-agent limit: {0}', [shown])
      : t('Sub-agent limit for {0} chats: {1}', [selected.length, shown]);
    menu.append(contextMenuButton(label, () => editSessionWorkerLimits(selectedRows)));
  }
  const unsupportedBlockSelection = selectedRows.some(row => !row.conversationId);
  if (unsupportedBlockSelection) {
    const reason = t('Block/Release is unavailable because this selection includes Unattributed activity, which is not a ChatGPT conversation. Select only recorded chats.');
    menu.append(contextMenuButton(selected.length === 1 ? t('Block this chat') : t('Block selected'), () => undefined, false, reason));
    menu.append(el('div', 'session-context-hint', reason));
  } else if (selected.length === 1) {
    const row = selectedRows[0]!;
    const blocked = blockedChats.has(row.conversationId!);
    menu.append(contextMenuButton(
      blocked ? t('Release this chat') : t('Block this chat'),
      () => toggleSessionBlocks(selected, !blocked)
    ));
  } else {
    const hasBlocked = selectedRows.some(row => blockedChats.has(row.conversationId!));
    const hasReleased = selectedRows.some(row => !blockedChats.has(row.conversationId!));
    if (hasReleased) menu.append(contextMenuButton(t('Block selected'), () => toggleSessionBlocks(selected, true)));
    if (hasBlocked) menu.append(contextMenuButton(t('Release selected'), () => toggleSessionBlocks(selected, false)));
  }

  menu.append(el('div', 'session-context-label', () => t('Delete')));
  menu.append(contextMenuButton(
    selected.length === 1 ? t('Move this chat to Trash') : t('Move {0} selected to Trash', [selected.length]),
    () => deleteSelectedSessions(selected, false)
  ));
  menu.append(contextMenuButton(
    selected.length === 1 ? t('Permanently delete this chat…') : t('Permanently delete {0} selected…', [selected.length]),
    () => deleteSelectedSessions(selected, true),
    true
  ));
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
  const returnFocusId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.sess[data-id]')?.dataset.id
    ?? selected[0] ?? null;
  menu.addEventListener('keydown', event => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) return;
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    let next = current;
    if (event.key === 'ArrowDown') next = (current + 1) % buttons.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      closeSessionContextMenu();
      if (returnFocusId) $('sessionList').querySelector<HTMLElement>(`.sess[data-id="${returnFocusId}"]`)?.focus({ preventScroll: true });
      return;
    } else return;
    event.preventDefault();
    buttons[next]!.focus({ preventScroll: true });
  });
  menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
}

function sortSessionRows(rows: SessionSummary[]): SessionSummary[] {
  return rows.sort((left, right) => {
    // Legacy/test summaries without the field retain their previous recency behavior. Every
    // normalized production summary has lastMessageAt, so tool/error writes no longer move it.
    const leftMessage = left.lastMessageAt ?? left.updatedAt;
    const rightMessage = right.lastMessageAt ?? right.updatedAt;
    if (rightMessage !== leftMessage) return rightMessage - leftMessage;
    if (left.id === right.id) return 0;
    return left.id < right.id ? 1 : -1;
  });
}

function mergeSessionRows(rows: SessionSummary[]): void {
  const merged = new Map(sessions.map((entry) => [entry.id, entry]));
  for (const entry of rows) if (!deletedSessionIds.has(entry.id)) merged.set(entry.id, entry);
  sessions = sortSessionRows([...merged.values()]);
}

function mergeWorkerProgress(rows: ReadonlyArray<WorkerLifecycleProgress & { id: string }>): void {
  for (const row of rows) {
    const { id, ...progress } = row;
    workerProgressBySession.set(id, progress);
  }
}

async function loadSessions(): Promise<void> {
  const generation = ++sessionsLoadGeneration;
  const [list, catalog, folders] = await Promise.all([
    run(api.listSessions({ limit: SESSION_PAGE_SIZE })),
    run(api.listProjects()),
    run(api.listSidebarFolders())
  ]);
  if (!list || generation !== sessionsLoadGeneration) return;
  if (catalog) projects = catalog;
  if (folders) sidebarFolders = folders;
  // Once older pages have been requested, a hot refresh only replaces/updates the newest page.
  // Throwing the older rows away here would make scrolling history vanish every 400 ms while a
  // live chat is recording. Before pagination begins, replacing the first page is cheaper and
  // also removes a session that was deleted elsewhere.
  if (loadedOlderSessions) mergeSessionRows(list.sessions);
  else {
    // Current summaries carry message recency. Preserve the backend's legacy order when
    // opening older snapshots that predate it; normalization upgrades them on the next read.
    const current = list.sessions.filter(entry => !deletedSessionIds.has(entry.id));
    sessions = current.some(entry => entry.lastMessageAt !== undefined)
      ? sortSessionRows(current)
      : current;
    sessionPageCursor = list.nextCursor ?? null;
  }
  sessionTotal = typeof list.total === 'number' ? list.total : list.sessions.length;
  deletedSessionTotal = Number.isFinite(list.deleted) ? Math.max(0, list.deleted) : 0;
  if (loadedOlderSessions) mergeWorkerProgress(list.workerProgress ?? []);
  else workerProgressBySession = new Map((list.workerProgress ?? []).map(({ id, ...progress }) => [id, progress]));
  automationSupervisor = list.automation ?? automationSupervisor;
  alarmAutomationProvided = list.alarmAutomation !== undefined;
  fleetAlarmView = alarmAutomationProvided ? (list.alarmAutomation ?? null) : null;
  if (alarmAutomationProvided && !fleetAlarmView?.snapshot && automationSupervisor) {
    evaluateMajorityAlarm(automationSupervisor, false);
  }
  automationBySession = new Map((automationSupervisor?.chats ?? []).map(chat => [chat.sessionId, chat]));
  paintTrashAction();
  const currentIds = new Set(sessions.map(entry => entry.id));
  for (const id of multiSelectedSessions) if (!currentIds.has(id)) multiSelectedSessions.delete(id);
  if (multiSelectAnchor && !currentIds.has(multiSelectAnchor)) multiSelectAnchor = null;
  activeId = list.activeId;
  // Whole-set replacement on every page, older pages included: a block belongs to a
  // conversation, not to whichever page happened to carry its row.
  blockedChats = new Set(list.blocked);
  if (loadedOlderSessions) {
    for (const entry of list.pressure) pressure.set(entry.id, entry);
  } else {
    pressure = new Map(list.pressure.map((entry) => [entry.id, entry]));
  }
  if (selectedId !== null && !sessions.some((s) => s.id === selectedId)) {
    selectedId = null;
    detailFor = null;
    detailCursor = null;
  }
  if (catalog) { draftIdentitiesReady = true; await restoreComposerDrafts(); }
  paintSessions();
  // This is the actual recorder-backed session snapshot boundary. Refresh an
  // opened Work detail here, not on every presentation-only paint above.
  if (workOverviewSessionId) void refreshWorkOverviewPane(workOverviewSessionId);
  await loadDetail();
  // Progress keeps an independent current-tail projection so evidence navigation can replace the
  // visible timeline with a historical page without making that old page authoritative. Compact
  // & Resume preserves the stable local session id, though, so a successor can append a newer
  // correction/reminder while this view stays open and never trigger a selection change. Refresh
  // that existing projection on the same coalesced session-change pass; do not add another poll.
  if (document.querySelector<HTMLElement>('#chatBody > [data-view="progress"]')?.hidden === false) {
    await refreshProgressEvents();
  }
  void refreshInputQueue();
}

async function loadMoreSessions(): Promise<void> {
  if (sessionPageLoading || !sessionPageCursor || sessions.length >= sessionTotal) return;
  sessionPageLoading = true;
  const cursor = sessionPageCursor;
  const rowsBeforePage = sessions;
  try {
    const page = await run(api.listSessions({ cursor, limit: SESSION_PAGE_SIZE }));
    if (!page) return;
    if (sessions !== rowsBeforePage) {
      // A newer root snapshot or local result arrived while this older cursor was
      // in flight. Keep history not already shown, but never replace newer rows,
      // supervisor state, block receipts or the newer pagination cursor with it.
      const known = new Set(sessions.map(entry => entry.id));
      const unseen = page.sessions.filter(entry => !known.has(entry.id));
      if (unseen.length) {
        mergeSessionRows(unseen);
        loadedOlderSessions = true;
        paintSessions();
      }
      return;
    }
    mergeSessionRows(page.sessions);
    loadedOlderSessions = true;
    sessionTotal = page.total;
    deletedSessionTotal = Number.isFinite(page.deleted) ? Math.max(0, page.deleted) : deletedSessionTotal;
    mergeWorkerProgress(page.workerProgress ?? []);
    automationSupervisor = page.automation ?? automationSupervisor;
    automationBySession = new Map((automationSupervisor?.chats ?? []).map(chat => [chat.sessionId, chat]));
    paintTrashAction();
    sessionPageCursor = page.nextCursor;
    blockedChats = new Set(page.blocked);
    for (const entry of page.pressure) pressure.set(entry.id, entry);
    paintSessions();
  } finally {
    sessionPageLoading = false;
    // A sidebar page can contain completed outputs. Refresh this EXISTING
    // view-only projection from the loaded rows, without another history read.
    paintWorkOverview(false);
  }
}

function maybePageSessions(): void {
  if (!visible || !sessionPageCursor || sessions.length >= sessionTotal) return;
  const pane = $('sessionList').closest<HTMLElement>('.scroll');
  if (!pane) return;
  if (pane.scrollHeight - pane.scrollTop - pane.clientHeight <= SESSION_SCROLL_MARGIN) {
    void loadMoreSessions();
  }
}

let diagnosticsExpanded = false;
let failedDeliveriesExpanded = false;
let transportOnlyExpanded = false;

function paintSessions(force = false): void {
  paintAutomationSupervisor();
  // Keep the pointer's elected rows alive while asynchronous activity snapshots arrive.
  if (!force && sidebarOrder?.interacting) return;
  const list = $('sessionList');
  const editor = list.querySelector<HTMLInputElement>('.sess-rename-input');
  if (!force && renamingSessionId && editor?.closest<HTMLElement>('[data-id]')?.dataset.id === renamingSessionId) return;
  const focusedSessionId = document.activeElement instanceof HTMLElement && document.activeElement.matches('.sess[data-id]')
    ? document.activeElement.dataset.id ?? null
    : null;
  document.getElementById('sessionTooltip')?.remove();
  const rows: HTMLElement[] = [];
  // A task and its expanded workers are one sidebar item for project pagination.
  const projectRows = new Map<string, Array<{ entry: SessionSummary; selected: boolean }>>();
  const localRows = new Map<string, Array<{ rows: HTMLElement[]; selected: boolean }>>();
  const diagnostics: SessionSummary[] = [];
  const failedDeliveries: SessionSummary[] = [];
  const transportOnly: SessionSummary[] = [];
  const subagentDeliveries: SessionSummary[] = [];
  // PR1500: resolve membership once and allocate project rows only on their visible page.
  // Preserve this fork's local-folder, pin, transport-history and selection owners.
  const ungrouped = new Set(projects.filter(project => project.ungrouped).map(project => project.id));
  const groupOf = (id: string | null | undefined): string | null => id && !ungrouped.has(id) ? id : null;
  const scoped = new Map<string, SessionSummary[]>();
  for (const entry of sessions) {
    const localId = localFolderFor(entry.id)?.id;
    const scope = localId ? `local:${localId}` : groupOf(entry.projectId) ?? '';
    const members = scoped.get(scope);
    if (members) members.push(entry); else scoped.set(scope, [entry]);
  }
  const orderedSessions = [...scoped].flatMap(([scope, entries]) => {
    const members = sidebarPins.first(entries);
    if (!sidebarOrder) return members;
    const pinned = members.filter(entry => sidebarPins.has(entry.id));
    const unpinned = members.filter(entry => !sidebarPins.has(entry.id));
    return [
      ...sidebarOrder.ordered(pinnedSortScope(scope, true), pinned),
      ...sidebarOrder.ordered(pinnedSortScope(scope, false), unpinned)
    ];
  });
  const workerSessions = orderedSessions.filter(entry => recordedWorkerId(entry) !== null);
  for (const entry of orderedSessions) {
    if (recordedWorkerId(entry) !== null) continue;
    if (!entry.conversationId) { diagnostics.push(entry); continue; }
    const sessionInputs = inputQueueLoaded ? pendingComposerInputs.filter(input =>
      input.sessionId === entry.id || input.deliveredSessionId === entry.id || input.conversationId === entry.conversationId) : [];
    const inputOwned = sessionInputs.some(input => ['queued', 'browser', 'tool'].includes(input.state));
    const inputNeedsAttention = sessionInputs.some(input => ['failed', 'decision'].includes(input.state));
    const genericToolShell = entry.origin === null && entry.titleSource !== 'manual' &&
      isGenericAutomaticSessionTitle(entry.title) && entry.userMessages === 0 && entry.toolCalls > 0;
    const legacyTransportTitle = entry.titleSource !== 'manual' && (
      /^\s*\[\[COS(?:_|\\_)CONTEXT:\d{1,6}\]\]/.test(entry.title) ||
      /^Shared context for every worker in this run:/i.test(entry.title.trim())
    );
    // A fresh worker page may be recorded before its command ACK binds the broker origin. Its
    // fallback title is the internal shared-context envelope, never a user-created chat title.
    // Keep that durable row inspectable, but place it with sub-agent history immediately instead
    // of flooding the primary task list while Chrome finishes (or recovers) the binding.
    const subagentDelivery = legacyTransportTitle && entry.origin === null &&
      entry.id !== selectedId && !multiSelectedSessions.has(entry.id) && entry.id !== renamingSessionId;
    if (subagentDelivery) { subagentDeliveries.push(entry); continue; }
    const failedOpening = inputQueueLoaded && legacyTransportTitle && entry.origin === null &&
      entry.userMessages === 1 && entry.toolCalls === 0 &&
      entry.errors > 0 && entry.lastAssistantFinalAt == null && entry.activeTurnId == null &&
      !sessionWorking(entry) && !automationBySession.has(entry.id) && !inputOwned && !inputNeedsAttention &&
      !blockedChats.has(entry.conversationId) && !openingSessions.has(entry.id) && entry.id !== selectedId &&
      !multiSelectedSessions.has(entry.id) && entry.id !== renamingSessionId;
    if (failedOpening) { failedDeliveries.push(entry); continue; }
    // The recorder deliberately creates an exact session when an MCP call is the first proof
    // seen for a conversation. Keep that durable history, but do not let an inactive transport
    // shell read like another user chat. Every live/attention owner fails open into the normal
    // list so collapsing presentation can never conceal work that still needs the user or Chrome.
    const transportOnlyRow = inputQueueLoaded && entry.origin === null && entry.userMessages === 0 &&
      entry.toolCalls > 0 && entry.lastAssistantFinalAt == null && entry.activeTurnId == null &&
      !sessionWorking(entry) && !automationBySession.has(entry.id) && !inputOwned && !inputNeedsAttention &&
      !blockedChats.has(entry.conversationId) && !openingSessions.has(entry.id) && entry.id !== selectedId &&
      !multiSelectedSessions.has(entry.id) && entry.id !== renamingSessionId;
    // A provider-created "ChatGPT session" with no authored user message is recorder/tool
    // bookkeeping, even when a stale turn/activity lease survived a browser interruption. Do
    // not let that generic shell flood the primary conversation list; attention, selection and
    // explicit automation ownership still fail open so recoverable work remains visible.
    const genericTransportOnlyRow = inputQueueLoaded && genericToolShell &&
      !automationBySession.has(entry.id) && !inputOwned && !inputNeedsAttention &&
      !blockedChats.has(entry.conversationId) && !openingSessions.has(entry.id) && entry.id !== selectedId &&
      !multiSelectedSessions.has(entry.id) && entry.id !== renamingSessionId;
    if (transportOnlyRow || genericTransportOnlyRow) { transportOnly.push(entry); continue; }
    const localId = localFolderFor(entry.id)?.id ?? null;
    const projectId = localId ? null : groupOf(entry.projectId);
    if (projectId) {
      const tasks = projectRows.get(projectId) ?? [];
      tasks.push({ entry, selected: entry.id === selectedId });
      projectRows.set(projectId, tasks);
      continue;
    }
    const target: HTMLElement[] = localId ? [] : rows;
    const row = sessionRow(entry); target.push(row);
    const baseScope = localId ? `local:${localId}` : projectId ?? '';
    row.dataset.sortScope = pinnedSortScope(baseScope, sidebarPins.has(entry.id));
    if (localId) {
      const tasks = localRows.get(localId) ?? [];
      tasks.push({ rows: target, selected: entry.id === selectedId });
      localRows.set(localId, tasks);
    }
  }
  const subagentHistory = [...workerSessions, ...subagentDeliveries];
  if (subagentHistory.length) {
    const history = document.createElement('details'); history.className = 'session-diagnostics';
    history.open = expandedWorkers.has('other-workers');
    // Keep the disclosure's structure keyed only to membership. A live "N active" suffix made
    // every worker state tick change the sidebar structure signature and replace this wrapper,
    // producing visible flicker even though no chat was added or removed.
    history.append(el('summary', '', () => t("Sub-agent history · {0}", [subagentHistory.length])));
    history.append(...subagentHistory.map(sessionRow));
    history.addEventListener('toggle', () => { if (history.isConnected) history.open ? expandedWorkers.add('other-workers') : expandedWorkers.delete('other-workers'); });
    rows.push(history);
  }
  const localSections: HTMLElement[] = [];
  for (const folder of sidebarFolders) {
    const section = document.createElement('details');
    section.className = 'project-group local-folder-group';
    section.dataset.sidebarFolderId = folder.id;
    section.open = !collapsedSidebarFolders.has(folder.id);
    const heading = el('summary', 'project-heading local-folder-heading');
    const label = el('span', 'project-name', folder.name);
    const count = el('span', 'local-folder-count', String(localRows.get(folder.id)?.length ?? 0));
    heading.append(icon('i-folder'), label, count);
    const rename = el('button', 'btn project-new') as HTMLButtonElement;
    rename.type = 'button'; rename.append(icon('i-pencil'));
    ui(rename, 'title', () => t('Rename local folder'));
    rename.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      const name = window.prompt(t('Folder name'), folder.name)?.trim();
      if (!name || name === folder.name) return;
      const next = await run(api.renameSidebarFolder(folder.id, name));
      if (next) { ++sessionsLoadGeneration; sidebarFolders = next; paintSessions(true); }
    });
    const remove = el('button', 'btn project-remove') as HTMLButtonElement;
    remove.type = 'button'; remove.append(icon('i-trash'));
    ui(remove, 'title', () => t('Remove local folder; keep conversations'));
    remove.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      if (!window.confirm(t('Remove folder “{0}”? Its conversations and ChatGPT chats will be kept.', [folder.name]))) return;
      const next = await run(api.deleteSidebarFolder(folder.id));
      if (next) { ++sessionsLoadGeneration; sidebarFolders = next; collapsedSidebarFolders.delete(folder.id); paintSessions(true); }
    });
    heading.append(rename, remove); section.append(heading);
    section.append(...(localRows.get(folder.id) ?? []).flatMap(task => task.rows));
    section.addEventListener('toggle', () => {
      if (section.isConnected) section.open ? collapsedSidebarFolders.delete(folder.id) : collapsedSidebarFolders.add(folder.id);
    });
    localSections.push(section);
  }
  const projectIds = [...new Set([...projects.filter(project => !project.ungrouped).map(project => project.id), ...projectRows.keys()])];
  const projectSections: HTMLElement[] = [];
  for (const id of projectIds) {
    const project = projects.find(row => row.id === id);
    const section = document.createElement('details'); section.className = 'project-group'; section.dataset.projectId = id;
    section.open = !collapsedProjects.has(id);
    const heading = el('summary', 'project-heading');
    const label = el('span', 'project-name', () => project?.name ?? t("Unavailable project"));
    ui(heading, 'title', () => project?.path ?? t("Unavailable project"));
    heading.append(icon('i-folder'), label); section.append(heading);
    section.addEventListener('toggle', () => { if (section.isConnected) section.open ? collapsedProjects.delete(id) : collapsedProjects.add(id); });
    if (project) {
      const create = el('button', 'btn project-new'); create.append(icon('i-pencil')); create.setAttribute('type', 'button'); create.dataset.newProject = id;
      ui(create, 'title', () => t("New chat in this project")); create.setAttribute('aria-label', create.title);
      create.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); selectNewChat(id); }); heading.append(create);
      if (project.chatgpt?.state === 'failed' || project.chatgpt?.state === 'uncertain') {
        const retry = el('button', 'btn project-new') as HTMLButtonElement;
        retry.type = 'button'; retry.append(icon('i-retry'));
        retry.disabled = retryingChatgptProjects.has(id);
        ui(retry, 'title', () => project.chatgpt?.state === 'uncertain'
          ? t('ChatGPT may already have created it. Retry native Project creation only after checking ChatGPT.')
          : t('Retry creating this project in ChatGPT'));
        retry.setAttribute('aria-label', retry.title);
        retry.addEventListener('click', async event => {
          event.preventDefault(); event.stopPropagation();
          if (retryingChatgptProjects.has(id)) return;
          retryingChatgptProjects.add(id); retry.disabled = true;
          try {
            const updated = await run(api.retryChatgptProject(id));
            if (!updated) return;
            ++sessionsLoadGeneration;
            projects = projects.map(row => row.id === id ? updated : row);
            paintSessions(); void refreshInputQueue();
          } finally {
            retryingChatgptProjects.delete(id);
            // A failed/empty IPC result leaves the durable failed row unchanged. Repaint after
            // releasing the in-flight fence so the same explicit Retry is immediately usable.
            if (retry.isConnected) paintSessions();
          }
        });
        heading.append(retry);
      }
      const remove = el('button', 'btn project-remove') as HTMLButtonElement;
      remove.type = 'button'; remove.append(icon('i-trash'));
      ui(remove, 'title', () => t("Remove project from sidebar; keep conversations and files"));
      ui(remove, 'aria-label', () => t("Remove project {0}", [project.name]));
      remove.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation();
        if (remove.disabled) return;
        remove.disabled = true;
        try {
          const removed = await run(api.removeProject(id));
          if (!removed) return;
          // Reject list snapshots captured before this newer catalog commit.
          ++sessionsLoadGeneration;
          projects = projects.map(row => row.id === id ? removed : row);
          collapsedProjects.delete(id); projectVisibleCounts.delete(id);
          if (selectedProjectId === id) {
            if (!selectedId) {
              const oldKey = draftKey();
              rememberDraft();
              selectedProjectId = null; selectionGeneration++;
              // Preserve the project draft at its original identity and restore
              // the unfiled destination instead of overwriting either authored task.
              draftStorageMessage = inputDrafts.get(oldKey) || imageDrafts.get(oldKey)?.length ?
                'Project removed. Its saved draft was retained under the original project.' : '';
              restoreDraft();
              composerDrafts.select({ sessionId: null, projectId: null });
              $<HTMLTextAreaElement>('chatInput').placeholder = 'Ask anything…';
            } else selectedProjectId = null;
          }
          paintSessions(); void refreshInputQueue();
          toast('Project removed; conversations kept');
        } finally { remove.disabled = false; }
      });
      heading.append(remove);
    }
    const tasks = projectRows.get(id) ?? [];
    const count = projectVisibleCounts.get(id) ?? PROJECT_TASK_PAGE_SIZE;
    const shown = tasks.filter((task, index) => index < count || task.selected);
    for (const task of shown) {
      const row = sessionRow(task.entry);
      row.dataset.sortScope = pinnedSortScope(id, sidebarPins.has(task.entry.id));
      section.append(row);
    }
    if (shown.length < tasks.length) {
      const more = el('button', 'btn project-show-more', () => t("Show more")) as HTMLButtonElement;
      more.type = 'button'; ui(more, 'aria-label', () => t("Show more tasks in {0}", [project?.name ?? t("this project")]));
      more.addEventListener('click', () => { projectVisibleCounts.set(id, count + PROJECT_TASK_PAGE_INCREMENT); paintSessions(); });
      section.append(more);
    }
    projectSections.push(section);
  }
  if (diagnostics.length) {
    const disclosure = document.createElement('details');
    disclosure.className = 'session-diagnostics';
    disclosure.open = diagnosticsExpanded;
    const heading = el('summary', '', () => t("Internal CoS records · {0}", [diagnostics.length]));
    ui(heading, 'title', () => t('Recorder and recovery history. These are not normal chats you need to work in.'));
    disclosure.append(heading, ...diagnostics.map(sessionRow));
    disclosure.addEventListener('toggle', () => { diagnosticsExpanded = disclosure.open; });
    rows.push(disclosure);
  }
  if (failedDeliveries.length) {
    const disclosure = document.createElement('details');
    disclosure.className = 'session-diagnostics failed-delivery-attempts';
    disclosure.open = failedDeliveriesExpanded;
    const heading = el('summary', '', () => t("Failed chat openings · {0}", [failedDeliveries.length]));
    ui(heading, 'title', () => t('These ChatGPT conversations are preserved, but they did not produce a usable answer.'));
    disclosure.append(heading, ...failedDeliveries.map(sessionRow));
    disclosure.addEventListener('toggle', () => { if (disclosure.isConnected) failedDeliveriesExpanded = disclosure.open; });
    rows.push(disclosure);
  }
  if (transportOnly.length) {
    const disclosure = document.createElement('details');
    disclosure.className = 'session-diagnostics transport-only-activity';
    disclosure.open = transportOnlyExpanded;
    const heading = el('summary', '', () => t("Tool-only records · {0}", [transportOnly.length]));
    ui(heading, 'title', () => t('Exact ChatGPT tool history with no recorded user message or final assistant answer.'));
    disclosure.append(heading, ...transportOnly.map(sessionRow));
    disclosure.addEventListener('toggle', () => { if (disclosure.isConnected) transportOnlyExpanded = disclosure.open; });
    rows.push(disclosure);
  }
  // Projects must remain discoverable without scrolling through the entire ungrouped history.
  // A hot status refresh updates rows in place. This keeps the row and a continuing spinner
  // mounted instead of restarting both every time the recorder publishes a snapshot.
  const nextRoots = [...localSections, ...projectSections, ...rows];
  const currentRows = new Map([...list.querySelectorAll<HTMLElement>('.sess[data-id]')]
    .map(row => [row.dataset.id!, row] as const));
  const sameStructure = !force && sidebarStructureSignature([...list.childNodes]) === sidebarStructureSignature(nextRoots);
  if (sameStructure) {
    for (const nextRow of nextRoots.flatMap(root => root.matches('.sess[data-id]')
      ? [root]
      : [...root.querySelectorAll<HTMLElement>('.sess[data-id]')])) {
      const current = currentRows.get(nextRow.dataset.id!);
      if (current) refreshSessionRow(current, nextRow);
    }
  } else {
    // Reconcile inside one detached tree. A root-level candidate has no parent before this point;
    // replaceWith() on it would be a no-op after refreshSessionRow() moved its children into the
    // incumbent row, and re-inserting that drained candidate would render an empty sidebar row.
    // A fragment gives root and grouped rows the same replacement semantics while retaining the
    // incumbent row's pointer/focus identity.
    const nextTree = document.createDocumentFragment();
    nextTree.append(...nextRoots);
    for (const nextRow of [...nextTree.querySelectorAll<HTMLElement>('.sess[data-id]')]) {
      const current = currentRows.get(nextRow.dataset.id!);
      if (current) nextRow.replaceWith(refreshSessionRow(current, nextRow));
    }
    list.replaceChildren(nextTree);
  }
  const renderedRows = [...list.querySelectorAll<HTMLElement>('.sess[data-id]')];
  for (const row of renderedRows) row.tabIndex = -1;
  const focusRow = (focusedSessionId ? renderedRows.find(row => row.dataset.id === focusedSessionId) : undefined)
    ?? (selectedId ? renderedRows.find(row => row.dataset.id === selectedId) : undefined)
    ?? renderedRows[0];
  if (focusRow) focusRow.tabIndex = 0;
  if (focusedSessionId && focusRow?.dataset.id === focusedSessionId) focusRow.focus({ preventScroll: true });
  paintSessionSelectionSummary();
  agentPanel?.update(selectedId, sessions.filter(entry => entry.origin?.kind === 'worker' && entry.origin.fromSessionId === selectedId && selectedId !== null));
  badgeKey = badgeSignature();
  $('sessionsEmpty').hidden = sessions.length > 0 || projects.some(project => !project.ungrouped);

  scheduleToolActivityExpiry();
}

/** Repaint once at the nearest activity or visible-age boundary; no polling interval is needed. */
function scheduleToolActivityExpiry(): void {
  window.clearTimeout(toolActivityTimer);
  toolActivityTimer = undefined;
  if (!visible) return;
  const now = Date.now();
  let nearest = Number.POSITIVE_INFINITY;
  if (routeSettlingUntil > now && pendingComposerInputs.some(routeHeld)) nearest = routeSettlingUntil;
  for (const summary of sessions) {
    nearest = Math.min(nearest, nextSessionProofAgeChange(summary, now));
    const lastToolCallAt = summary.lastToolCallAt;
    const lastActivityAt = Math.max(summary.startedAt, lastToolCallAt ?? 0);
    if (!recentChatActivity(summary, now)) continue;
    const expiry = summary.activityExpiresAt ?? lastActivityAt + CHAT_ACTIVE_MS;
    if (expiry > now) nearest = Math.min(nearest, expiry);
  }
  for (const automation of automationBySession.values()) {
    if (!automation.nextRetryAt || automation.nextRetryAt <= now) continue;
    const remaining = automation.nextRetryAt - now;
    // Above one minute the compact text is stable at `1m+`; inside it, update once per second.
    const nextCountdownChange = remaining > 60_000
      ? automation.nextRetryAt - 60_000 + 1
      : Math.min(automation.nextRetryAt + 1, now + 1_000);
    nearest = Math.min(nearest, nextCountdownChange);
  }
  const rotation = automationSupervisor?.rotation;
  if (rotation?.nextRotationAt && rotation.nextRotationAt > now) {
    const remaining = rotation.nextRotationAt - now;
    nearest = Math.min(nearest, remaining <= 60_000
      ? Math.min(rotation.nextRotationAt + 1, now + 1_000)
      : now + Math.min(60_000, remaining));
  } else if (rotation?.draining && rotation.drainingAt > 0) {
    nearest = Math.min(nearest, now + 60_000);
  }
  if (!Number.isFinite(nearest)) return;
  toolActivityTimer = window.setTimeout(() => {
    if (routeSettlingUntil > 0 && routeSettlingUntil <= Date.now()) {
      routeSettlingUntil = 0;
      void refreshInputQueue();
    }
    paintSessions();
  }, Math.max(1, nearest - now + 1));
}

function canonicalMessageKey(event: SessionEvent): string | null {
  if (event.kind === 'tool_call') return `tool_call\u0000${event.call.callId}`;
  if ((event.kind === 'user_message' || event.kind === 'assistant_message') && event.messageId) {
    return `${event.kind}\u0000${event.messageId}`;
  }
  return null;
}

/** Merge one sequence-cursor delta without letting canonical message revisions duplicate rows. */
function mergeDetailDelta(delta: SessionEvent[]): void {
  const merged = [...events];
  const messageRows = new Map<string, number>();
  for (let index = 0; index < merged.length; index++) {
    const key = canonicalMessageKey(merged[index]!);
    if (key) messageRows.set(key, index);
  }
  for (const event of delta) {
    const key = canonicalMessageKey(event);
    const index = key ? messageRows.get(key) : undefined;
    if (index !== undefined) merged[index] = event;
    else {
      if (key) messageRows.set(key, merged.length);
      merged.push(event);
    }
  }
  const folded = chronological(foldProgress(merged));
  events = retainTimelinePage(folded, 'newer');
}

let controlsGeneration = 0;
let controlledSessionId: string | null = null;
let controlledConversationId: string | null = null;
let controlledReadAt = 0;
let controlledTurnId: string | null = null;
let controlledSelection = -1;
let controlledSessionKnown = false;
let controlledStopPending = false;
let controlledFinishWaiting = false;
let controlledQueueAtFinish = false;
let controlledCanInject = false;
let controlledCanSendDirectly = false;
let controlledRecovery: RecoveryCountdown[] = [];
let controlledPlan: AgentPlan | null = null;
let controlledObjective = '';
let controlledBlocked: 'worker' | 'blocked' | '' = '';
let controlledActiveWork: SessionControlsView['activeWork'] | null = null;
let controlledDiagnosticIncidents: SessionControlsView['diagnosticIncidents'] = [];
let controlledDiagnosticChat: SessionControlsView['diagnosticChat'] = null;
/** Compact & Resume preserves the local session id, not the old provider turn.
 * A cached controls read may finish after that same local session binds a new
 * conversation. It cannot provide Stop, inject, countdown or current Loop wait
 * evidence for the successor until the exact provider binding matches. */
function selectedControlsMatchCurrentBinding(): boolean {
  if (!selectedId || controlledSessionId !== selectedId || controlledSelection !== selectionGeneration) return false;
  const current = sessions.find(row => row.id === selectedId);
  return !!current?.conversationId && current.conversationId === controlledConversationId;
}
let pendingComposerInputs: InputEntry[] = [];
let inputQueueLoaded = false;
/** Latest IPC availability for the existing outbox; never an authority or
 * replacement queue. A failed read keeps prior rows but makes their status
 * historical until Main provides another successful snapshot. */
let inputQueueReadUnverified = false;
let inputQueueGeneration = 0;
const surfacedDeliveryInputIds = new Set<string>();
const deliveryQueueDrafts = new Map<string, string>();
let goalIntentGeneration = 0;
let goalProgress: (Omit<TaskProgress, 'phase'> & { phase: string; selection: number; inputId?: string }) | null = null;
function cancelGoalRequest(): void {
  const requestId = goalProgress?.requestId;
  goalProgress = null;
  if (requestId) void api.cancelTaskRequest?.(requestId);
  paintGoalProgress();
}
type GoalDraftPresentation = { stage: string; stageStartedAt: number; model: string; text: string; error: string | null; message?: string; outboxContinuationOwned?: true };
let goalDraftView: GoalDraftPresentation | null = null;
let goalWaitView: import('../shared/goal.js').GoalWait | null = null;
let finishGoalDraftView: GoalDraftPresentation | null = null;

const WORKER_WAIT_STATES = new Set<AgentState>(['invited', 'active', 'detached', 'waking']);

/** Two honest loading phases: unfinished worker work first, then the prime/main chat. */
function goalWaitLabel(wait: import('../shared/goal.js').GoalWait | null): string {
  const selected = sessions.find(summary => summary.id === selectedId);
  const workers = selected?.conversationId && swarm
    ? swarm.agents.filter(agent => agent.role === 'worker' &&
      agent.primeConversationId === selected.conversationId && WORKER_WAIT_STATES.has(agent.state))
    : [];
  if (wait?.detail) return wait.detail;
  const generic = !wait || ['native-busy', 'quiet', 'tools', 'listening', 'answer', 'idle', 'settling'].includes(wait.reason);
  if (generic && workers.length > 0) return t('Waiting for workers · {0} still running', [workers.length]);
  if (generic) return t('Waiting for the main chat to continue');
  if (wait.reason === 'recovery') return t('Recovering this completed answer');
  if (wait.reason === 'silence') return t('Waiting before recovery reload');
  if (wait.reason === 'browser') return t('Waiting for Chrome to reconnect');
  if (wait.reason === 'chat') return t('Reopening this chat');
  if (wait.reason === 'cooldown') return t('ChatGPT asked us to slow down · retrying shortly');
  if (wait.reason === 'capacity') return t('Queued behind the active-chat limit');
  if (wait.reason === 'pickup') return t('Saved reply is waiting for its exact pickup');
  return t('Waiting for exact final/tool evidence');
}

function paintGoalProgress(): void {
  let row = document.getElementById('goalLifecycle');
  if (!row) { row = el('div', 'queued-input'); row.id = 'goalLifecycle'; row.setAttribute('role', 'status'); $('activeGoalRow').before(row); }
  const progress = goalProgress?.selection === selectionGeneration ? goalProgress : null;
  const entry = progress?.inputId ? pendingComposerInputs.find(item => item.id === progress.inputId) : undefined;
  const currentControls = selectedControlsMatchCurrentBinding();
  const finishDraft = currentControls ? finishGoalDraftView : null;
  const draft = finishDraft ?? (currentControls ? goalDraftView : null);
  const recordedWait = currentControls ? goalWaitView : null;
  const projection = selectedId ? automationBySession.get(selectedId) : null;
  const wait = recordedWait?.reason === 'evidence' && projection && !selectedNativeEvidenceWait(projection)
    ? null : recordedWait;
  const off = $<HTMLSelectElement>('chatAutomation').value === 'off';
  if (off && !finishDraft) {
    // Off stops automatic continuation, not an existing native operation or its evidence.
    const retained = currentControls && controlledObjective.trim().length > 0;
    row.hidden = !retained;
    row.replaceChildren();
    row.setAttribute('aria-busy', 'false');
    if (retained) {
      const body = el('div', 'queue-label');
      body.append(el('span', '', t('Automation stopped · saved objective retained')));
      row.append(el('span', 'session-status'), body);
    }
    return;
  }
  let phase = progress?.phase ?? '';
  let error = progress?.error;
  if (entry) { phase = entry.state; error = entry.error ?? undefined; }
  if (draft && (!off || finishDraft) && (finishDraft || !['saving', 'failed'].includes(phase))) { phase = draft.stage; error = draft.error ?? undefined; }
  else if (wait && !['saving', 'failed'].includes(phase)) { phase = 'settling'; error = undefined; }
  const labels: Record<string, string> = { saving: t("Saving task…"), saved: t("Task saved · waiting for the next completed answer"),
    preparing: t("Preparing the opening message…"), generating: t("Drafting the opening message…"), ready: t("Message ready · awaiting ChatGPT delivery"),
    sending: t("Preparing a continuation…"), answering: t("Drafting the next continuation…"), queued: t("Opening message queued"),
    browser: t("Sending opening message to ChatGPT…"), sent: t("Opening message sent"), tool: 'Opening message delivered to the active turn',
    failed: t("Task could not continue"), cancelled: t("Opening message cancelled"), paused: t("Automation paused · task text preserved"), 'no-reply': t("Goal finished · review result") };
  if (phase === 'retrying') error = undefined;
  labels.retrying = t("Provider busy · retry {0}{1}", [progress?.attempt ?? '', progress?.retryAt ? ' at ' + new Date(progress.retryAt).toLocaleTimeString(currentLanguage()) : '']);
  const mode = $<HTMLSelectElement>('chatAutomation').value === 'loop' ? t('Loop') : t('Goal');
  labels.settling = `${mode} · ${goalWaitLabel(wait)}`;
  if (phase === 'no-reply' && draft?.outboxContinuationOwned === true) {
    labels['no-reply'] = t('Continuation saved · delivery tracked');
  }
  if (phase === 'no-reply' && draft?.outboxContinuationOwned !== true) {
    if (wait || controlledTurnId !== null) phase = 'settling';
    else if ($<HTMLSelectElement>('chatAutomation').value === 'loop') labels['no-reply'] = t('Loop stopped · review result');
  }
  if (wait?.nextAction) labels.settling += ` · ${wait.nextAction}`;
  if (wait?.reason === 'capacity' && wait.active !== undefined && wait.limit !== undefined) {
    labels.settling += t(' · {0} active / {1} allowed', [wait.active, wait.limit]);
  }
  // Recovery and Goal/Loop can project the same durable wait. Keep the task controls, but show
  // one countdown for one deadline instead of making the user decipher duplicate waiting rows.
  const sharedRecoveryWait = phase === 'settling' && wait?.until !== undefined &&
    ['silence', 'listening', 'native-busy', 'quiet'].includes(wait.reason) && controlledRecovery.some(countdown =>
      ['silence', 'post-reload', 'native-busy', 'thinking-failed'].includes(countdown.kind) &&
      countdown.deadline === wait.until && (countdown.visibleAt ?? 0) <= Date.now());
  row.hidden = !phase || sharedRecoveryWait;
  if (row.hidden) { row.replaceChildren(); row.setAttribute('aria-busy', 'false'); return; }
  const attention = phase === 'settling' && (wait?.reason === 'attention' || wait?.reason === 'approval');
  const unknown = phase === 'settling' && wait?.reason === 'evidence';
  const busy = ['settling', 'saving', 'preparing', 'generating', 'retrying', 'sending', 'answering', 'browser', 'queued', 'ready'].includes(phase) && !error && !attention && !unknown;
  row.setAttribute('aria-busy', String(busy));
  const marker = el('span', busy ? 'session-status is-working' : 'session-status');
  const body = el('div', 'queue-label'); body.append(el('span', '', error ? `${labels.failed}: ${draft?.message ?? goalErrorMessage(error)}` : labels[phase] ?? phase));
  row.replaceChildren(marker, body);
  if (draft?.stageStartedAt && ['sending', 'answering'].includes(phase)) {
    const timer = el('span', 'recovery-countdown', activityElapsedLabel(draft.stageStartedAt));
    timer.setAttribute('role', 'timer');
    timer.setAttribute('aria-label', t('Current step elapsed time'));
    timer.setAttribute('aria-live', 'off');
    row.append(timer);
  }
  if (phase === 'settling' && wait?.until && !attention && !unknown) {
    const seconds = Math.max(0, Math.ceil((wait.until - Date.now()) / 1000));
    const timer = el('span', 'recovery-countdown', seconds
      ? t('Next recovery check in {0}', [`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`])
      : t('Recovery check due · no Send receipt implied'));
    timer.setAttribute('role', 'timer'); timer.setAttribute('aria-live', 'off'); row.append(timer);
  }
}
const cancelledStarts = new Set<string>();
const queuedFollowup = (entry: InputEntry): boolean => entry.mode === 'finish' || (entry.mode === 'after-turn' && !!entry.sessionId && entry.purpose !== 'decision');
function pendingComposerInput(): InputEntry | undefined {
  return [...startingInputs.values(), ...pendingComposerInputs].find(entry => (!queuedFollowup(entry) || entry.state === 'browser') && ['queued', 'browser'].includes(entry.state) &&
    (selectedId ? (entry.sessionId ?? entry.deliveredSessionId) === selectedId :
      (pendingNewInput?.generation === selectionGeneration && pendingNewInput.id === entry.id) || (!entry.sessionId && !entry.deliveredSessionId && entry.purpose !== 'decision')));
}
/** Only positive pre-Send evidence may make a cancelled delivery disappear automatically. */
const cancellationKnownUnsent = (entry: InputEntry): boolean => entry.state === 'queued' ||
  (['browser', 'cancelled'].includes(entry.state) && entry.requiresAuthorization === true && entry.sendAuthorizedAt === undefined);
/** Durable terminal evidence may need attention, but the UI never needs every historical cue. */
const retainedDeliveryNoticeCandidate = (entry: InputEntry): boolean => entry.state === 'cancelled' && !!entry.error &&
  !historicalAutomaticInput(entry) &&
  ((entry.deliveredAt !== undefined && !!entry.messageId) || entry.sendAuthorizedAt !== undefined ||
    (!!entry.owner && entry.requiresAuthorization !== true));
const retainedDeliveryNotice = (entry: InputEntry): boolean => retainedDeliveryNoticeCandidate(entry) && !dismissedInputNotices.has(entry.id);
const deliveryNoticeOwnerKey = (entry: InputEntry): string =>
  entry.sessionId ?? entry.deliveredSessionId ?? entry.conversationId ?? (entry.nickname ? `new:${entry.nickname}` : 'unbound');
const deliveryNoticeAt = (entry: InputEntry): number =>
  Math.max(entry.deliveredAt ?? 0, entry.sendAuthorizedAt ?? 0, entry.offeredAt ?? 0, entry.createdAt);
/**
 * Pick the newest durable attention row for each chat before applying renderer dismissal.
 * That ordering is intentional: dismissing the newest cue must not reveal a stack of older ones.
 */
function latestDeliveryNoticeIds(all: InputEntry[], candidate: (entry: InputEntry) => boolean): Set<string> {
  const latest = new Map<string, InputEntry>();
  for (const entry of all) {
    if (!candidate(entry) || all.some(root => root.companionInputId === entry.id)) continue;
    const key = deliveryNoticeOwnerKey(entry);
    const previous = latest.get(key);
    if (!previous || deliveryNoticeAt(entry) > deliveryNoticeAt(previous) ||
        (deliveryNoticeAt(entry) === deliveryNoticeAt(previous) && entry.createdAt > previous.createdAt)) latest.set(key, entry);
  }
  return new Set([...latest.values()].map(entry => entry.id));
}
const selectedDeliveryNoticeCandidate = (entry: InputEntry): boolean => entry.purpose !== 'decision' &&
  ['failed', 'cancelled'].includes(entry.state) && !!entry.error && !historicalAutomaticInput(entry) &&
  (entry.state !== 'cancelled' || !cancellationKnownUnsent(entry));
const MAX_GLOBAL_DELIVERY_ATTENTION = 3;
/** One projection selects identical live rows and bounded terminal notices for both UI surfaces. */
function visibleDeliveryEntries(all: InputEntry[]): { active: InputEntry[]; notices: InputEntry[]; visible: InputEntry[] } {
  const active = all.filter(entry => entry.purpose !== 'decision' && ['queued', 'browser', 'tool'].includes(entry.state))
    .sort((a, b) => (a.queueOrder ?? a.dueAt) - (b.queueOrder ?? b.dueAt) || a.createdAt - b.createdAt);
  const latestNoticeIds = latestDeliveryNoticeIds(all, retainedDeliveryNoticeCandidate);
  const activeOwners = new Set(active.map(deliveryNoticeOwnerKey));
  const notices = all.filter(entry => latestNoticeIds.has(entry.id) && retainedDeliveryNotice(entry) &&
    !activeOwners.has(deliveryNoticeOwnerKey(entry)))
    .sort((a, b) => deliveryNoticeAt(b) - deliveryNoticeAt(a) || b.createdAt - a.createdAt)
    .slice(0, MAX_GLOBAL_DELIVERY_ATTENTION);
  const visible = [...active, ...notices]
    .sort((a, b) => (a.queueOrder ?? a.dueAt) - (b.queueOrder ?? b.dueAt) || a.createdAt - b.createdAt);
  return { active, notices, visible };
}
let durationTimer: number | undefined;
/** Repaint only changed evidence so normal typing leaves focus and selections intact. */
export function refreshComposerTarget(): void {
  const host = document.getElementById('composerTarget');
  if (!host || !deps) return;
  const fields = composerTargetFields({ account: deps.account?.() ?? null, sessionId: selectedId,
    session: sessions.find(row => row.id === selectedId) ?? null, projectId: selectedProjectId,
    projects, model: confirmedComposerModel(), paused: deps.state()?.config.ui.automationPaused === true });
  const signature = JSON.stringify(fields);
  if (host.dataset.signature !== signature) {
    host.dataset.signature = signature;
    host.replaceChildren(...fields.map(field => {
      const item = el('span', 'composer-target-item');
      const label = el('span', 'composer-target-label'); ui(label, 'textContent', () => t(field.label));
      const value = el('bdi'); ui(value, 'textContent', () => field.translatable ? t(field.value) : field.value);
      item.append(label, value); return item;
    }));
  }
  const inspect = document.getElementById('inspectCurrentWork') as HTMLButtonElement | null;
  if (inspect) inspect.hidden = !selectedId;
}
function paintDeliveryControls(): void {
  refreshComposerTarget();
  paintGoalProgress();
  const currentControls = selectedControlsMatchCurrentBinding();
  const working = currentControls && controlledTurnId !== null;
  const queueAtFinish = currentControls && controlledQueueAtFinish;
  const canInject = currentControls && controlledCanInject;
  const canSendDirectly = currentControls && controlledCanSendDirectly;
  const files = imageDrafts.get(draftKey()) ?? [];
  const nativeFiles = files.some(file => 'id' in file) && !(canInject && injectableAttachments(files));
  $('queueAtFinish').hidden = !queueAtFinish || nativeFiles;
  ui($('afterTurnLabel'), 'textContent', () => queueAtFinish && !nativeFiles ? t("Queue at Session finish") : t("After this turn"));
  const generate = $<HTMLButtonElement>('generateFinishGoal');
  const queued = [...startingInputs.values(), ...pendingComposerInputs].some(entry =>
    (entry.sessionId ?? entry.deliveredSessionId) === selectedId && ['queued', 'browser', 'tool'].includes(entry.state));
  generate.hidden = !working || !controlledFinishWaiting || queued || controlledStopPending || !!finishGoalDraftView;
  generate.disabled = generate.dataset.busy === `${selectedId}:${controlledTurnId}`;
  const sendOption = $<HTMLSelectElement>('sendMode').querySelector('option[value="auto"]');
  const immediateLabel = () => nativeFiles && working ? t("After this turn") : canSendDirectly ? t("Send directly") : canInject ? t("Inject now") : t("Send");
  if (sendOption) ui(sendOption, 'textContent', immediateLabel);
  ui($('immediateDeliveryLabel'), 'textContent', immediateLabel);
  const immediateAction = $('sendOptions').querySelector<HTMLElement>('[data-delivery="auto"]');
  if (immediateAction) immediateAction.hidden = nativeFiles && working;
  if (!canInject && !canSendDirectly && !queueAtFinish) $<HTMLSelectElement>('sendMode').value = 'auto';
  const pending = pendingComposerInput();
  const stop = (working || !!pending) && !currentPreparedPlan() && !$<HTMLTextAreaElement>('chatInput').value.trim() && !(imageDrafts.get(draftKey())?.length);
  // Hover selects delivery for the next message. Clicking the empty-composer
  // Stop still acts immediately; there is no second Stop action in the menu.
  $('sendOptions').hidden = !canInject && !canSendDirectly && !queueAtFinish;
  const send = $<HTMLButtonElement>('chatSend');
  const planMode = taskPlans.has(draftKey()), preparedPlan = currentPreparedPlan();
  send.disabled = (!stop && composerSending.has(draftKey())) || (!!composerDrafts.get(draftKey())?.pending &&
    (!!$<HTMLTextAreaElement>('chatInput').value.trim() || files.length > 0)) ||
    !!preparedPlan && (preparedPlan.sending || preparedPlan.stages.some(stage => !stage.trim()));
  send.dataset.action = stop ? 'stop' : 'send';
  ui(send, 'aria-label', () => stop ? (controlledStopPending ? t("Stop requested") : t("Stop turn")) : t("Send message"));
  if (stop && !working && pending) ui(send, 'aria-label', () => t("Cancel delivery"));
  const planAction = selectedId && !selectedSessionKnownIdle(selectedId) ? t("Queue plan at Session finish") : t("Start full plan");
  if (preparedPlan && !stop) send.setAttribute('aria-label', planAction);
  else if (planMode && !stop) ui(send, 'aria-label', () => t("Generate plan"));
  send.classList.toggle('is-plan-ready', !!preparedPlan && !stop);
  ui(send, 'title', () => stop && !working && pending ? t("Cancel delivery") : preparedPlan && !stop ? planAction : planMode && !stop ? t("Click to generate plan") : '');
  send.classList.toggle('is-stop', stop);
  for (const button of $('sendOptions').querySelectorAll<HTMLElement>('[data-delivery]')) {
    button.setAttribute('aria-checked', String(button.dataset.delivery === (nativeFiles && working ? 'after-turn' : $<HTMLSelectElement>('sendMode').value)));
  }
}
function dockAction(label: string | (() => string), symbol: string, click: (event: MouseEvent) => void): HTMLButtonElement {
  const button = el('button', 'dock-action') as HTMLButtonElement;
  const description = typeof label === 'function' ? label : () => label;
  button.type = 'button'; ui(button, 'title', description); ui(button, 'aria-label', description);
  button.append(icon(symbol)); button.onclick = click; return button;
}
function paintActiveGoal(): void {
  const row = $('activeGoalRow');
  const mode = $<HTMLSelectElement>('chatAutomation').value;
  row.hidden = !selectedId || mode === 'off';
  if (row.hidden) { row.replaceChildren(); return; }
  const objective = $<HTMLTextAreaElement>('sessionObjective').value.trim();
  const label = el('span', 'queue-label', () => `${mode === 'loop' ? t("Loop") : t("Pursuing goal")}${objective ? ' · ' + objective : ''}`);
  label.title = objective;
  const pause = dockAction(() => t("Pause after turn"), 'i-pause', () => {
    const select = $<HTMLSelectElement>('chatAutomation');
    select.value = 'off';
    select.dispatchEvent(new Event('change'));
  });
  pause.classList.add('is-labeled');
  pause.append(el('span', '', () => t("Pause after turn")));
  row.replaceChildren(icon('i-pulse'), label,
    pause,
    dockAction(() => t("Edit task"), 'i-pencil', event => {
      // This opener is outside the menu; its click must not immediately dismiss it.
      event.stopPropagation();
      $<HTMLDetailsElement>('composerSettings').open = true;
      $<HTMLTextAreaElement>('sessionObjective').focus();
    }));
}
type TaskPlanDraft = { text: string; requestId: string | null; stages: string[] | null; sending: boolean; progress: TaskProgress | null; error: string | null };
// Planning belongs to its draft key. Completed stages own their captured objective
// independently of composer edits; running or unknown existing sessions hand them to the durable queue.
const taskPlans = new Map<string, TaskPlanDraft>();
/**
 * A written plan may start only from the exact selected-session controls snapshot. An absent or
 * stale controls response stays conservative and queues at Session finish like a running turn.
 */
function selectedSessionKnownIdle(sessionId: string): boolean {
  return controlledSessionKnown && selectedId === sessionId &&
    selectedControlsMatchCurrentBinding() && controlledTurnId === null;
}
function currentPreparedPlan(): (TaskPlanDraft & { stages: string[] }) | null {
  const plan = taskPlans.get(draftKey());
  return plan?.stages ? plan as TaskPlanDraft & { stages: string[] } : null;
}
function cancelTaskPlan(key = draftKey()): void {
  const plan = taskPlans.get(key);
  taskPlans.delete(key);
  if (plan?.requestId) void api.cancelTaskRequest?.(plan.requestId);
  if (draftKey() === key) paintTaskPlan();
}
function paintTaskPlan(): void {
  const plan = taskPlans.get(draftKey());
  const preview = $('taskPlanPreview'); preview.replaceChildren();
  preview.hidden = !plan || (!plan.requestId && !plan.stages && !plan.error);
  ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => plan && !plan.text ? t("Describe the task to turn into a plan…") : t("Ask anything…"));
  if (plan?.stages) paintPreparedPlan();
  else if (plan?.error) {
    const failure = plan.error;
    const error = el('div', 'muted', () => failure === 'invalid_goal_decision_json' ? t("The planner response could not be read.") : goalErrorMessage(failure));
    error.title = plan.error;
    preview.append(error, el('div', 'muted', () => t("Send again to retry, or cancel the plan.")));
  } else if (plan?.requestId) {
    const progress = plan.progress;
    const label = () => !progress ? t("Creating plan…") : progress.phase === 'retrying' ? t("Provider busy · retry {0}{1}", [progress.attempt ?? '', progress.retryAt ? t(' at {0}', [new Date(progress.retryAt).toLocaleTimeString(currentLanguage())]) : '']) : progress.phase === 'cancelled' ? t("Plan cancelled") : progress.phase === 'preparing' ? t("Preparing plan…") : progress.phase === 'ready' ? t("Plan ready") : progress.phase === 'failed' ? t("Plan failed") : t("Writing plan…");
    preview.append(el('span', 'muted', label));
    if (progress?.text || progress?.error) preview.append(el('pre', 'task-progress-text', progress.error ? goalErrorMessage(progress.error) : progress.text));
  }
  paintTaskActions(); paintDeliveryControls();
}
async function createTaskPlan(backend: 'api' | 'chatgpt'): Promise<void> {
  const input = $<HTMLTextAreaElement>('chatInput'), text = input.value.trim();
  rememberDraft();
  const key = draftKey();
  cancelTaskPlan(key);
  const sessionId = selectedId, projectId = selectedId ? sessions.find(row => row.id === selectedId)?.projectId ?? null : selectedProjectId;
  const requestId = text ? crypto.randomUUID() : null;
  const plan: TaskPlanDraft = { text, requestId, stages: null, sending: false, progress: null, error: null };
  taskPlans.set(key, plan); paintTaskPlan();
  if (!requestId) { input.focus(); return; }
  const current = () => taskPlans.get(key) === plan;
  const unsubscribe = api.onTaskProgress?.(progress => {
    if (progress.requestId !== requestId || !current()) return;
    plan.progress = progress;
    if (draftKey() === key) paintTaskPlan();
  });
  try {
    const result = await api.draftTaskPlan(text, backend, requestId);
    if (!current()) return;
    const draft = draftKey() === key ? input.value : inputDrafts.get(key) ?? '';
    if (draft.trim() !== text) { cancelTaskPlan(key); return; }
    if (result.ok) {
      plan.stages = result.data;
      plan.requestId = null;
      // Planning is not durable Input admission. Keep the authored request until
      // the real queue accepts it, so a crash cannot silently lose an unsent plan.
      persistDraftKey(key);
      if (sessionId && !selectedSessionKnownIdle(sessionId))
        await queuePreparedPlan(key, plan as TaskPlanDraft & { stages: string[] }, sessionId, projectId);
    }
    else plan.error = result.error;
  } catch (error) {
    if (current()) plan.error = error instanceof Error ? error.message : String(error);
  } finally {
    unsubscribe?.(); plan.requestId = null;
    if (current() && draftKey() === key) paintTaskPlan();
  }
}
function paintPreparedPlan(): void {
  const plan = currentPreparedPlan();
  if (!plan) return;
  const preview = $('taskPlanPreview'); preview.hidden = plan.sending;
  // Sending hands presentation to the outbox/queued-stage rows. Keeping the editable
  // draft visible until the async receipt arrives paints the same plan twice. Retain
  // its data so a rejected send can restore the editable preview in the existing finally.
  if (plan.sending) { preview.replaceChildren(); return; }
  preview.replaceChildren(...plan.stages.map((stage, index) => {
    const row = el('div', 'plan-stage');
    const heading = el('div', 'plan-stage-heading');
    const label = el('span', 'stage-number', String(index + 1)); ui(label, 'aria-label', () => t("Stage {0}", [index + 1]));
    const text = el('span', 'queue-label', stage); text.title = stage; text.dir = 'auto';
    const field = document.createElement('textarea'); field.dir = 'auto'; field.value = stage; field.maxLength = 16000; field.hidden = true;
    ui(field, 'aria-label', () => t("Edit stage {0}", [index + 1]));
    const error = el('span', 'stage-error', () => t("Enter text or delete this stage.")); error.id = `planStageError-${index}`; error.hidden = !!stage.trim();
    const validate = () => { error.hidden = !!field.value.trim(); field.setAttribute('aria-invalid', String(!error.hidden)); paintDeliveryControls(); };
    field.setAttribute('aria-describedby', error.id); field.setAttribute('aria-invalid', String(!error.hidden));
    field.oninput = () => { plan.stages[index] = field.value; text.textContent = field.value; text.title = field.value; validate(); };
    const edit = dockAction(() => t("Edit stage {0}", [index + 1]), 'i-pencil', () => {
      field.hidden = !field.hidden; edit.setAttribute('aria-expanded', String(!field.hidden)); if (!field.hidden) field.focus();
    });
    edit.setAttribute('aria-expanded', 'false');
    const remove = dockAction(() => t("Delete stage {0}", [index + 1]), 'i-trash', () => {
      if (plan.sending) return;
      plan.stages.splice(index, 1);
      if (plan.stages.length) { paintPreparedPlan(); paintDeliveryControls(); } else cancelTaskPlan();
    });
    edit.disabled = remove.disabled = field.disabled = plan.sending;
    ui(heading, 'title', () => selectedId && !selectedSessionKnownIdle(selectedId) ? t("Queued at Session finish; edit or delete this checkpoint independently.") : index === 0 ? t("Send includes your complete request and the full plan. Later stages are queued as verification checkpoints.") : t("Included in the first message, then queued as a checkpoint at Session finish or after a completed answer when enabled."));
    heading.append(label, text, edit, remove); row.append(heading, field, error); return row;
  }));
}
async function sendPreparedPlan(): Promise<void> {
  const key = draftKey(), plan = currentPreparedPlan();
  if (!plan || plan.sending) return;
  if (selectedId) {
    // Decide from a fresh controls snapshot: the selected chat may have started or ended a turn
    // since the plan was written. Navigation while that snapshot is loading cancels this attempt.
    const target = selectedId, selection = selectionGeneration, expectedControlsGeneration = controlsGeneration + 1;
    await refreshSessionControls();
    if (controlsGeneration !== expectedControlsGeneration || selectedId !== target || selectionGeneration !== selection || taskPlans.get(key) !== plan || plan.sending) return;
    if (!selectedSessionKnownIdle(target)) {
      await queuePreparedPlan(key, plan, target, sessions.find(row => row.id === target)?.projectId ?? null);
      return;
    }
  }
  const tasks = plan.stages.map(stage => stage.trim());
  if (!tasks.length || tasks.some(task => !task) || JSON.stringify(tasks).length > 12000) { toast(t("Keep every stage nonempty and the plan below 12,000 characters.")); return; }
  plan.sending = true; paintPreparedPlan();
  try {
    const sent = await sendComposer(undefined, tasks, plan.text);
    if (taskPlans.get(key) === plan && sent) { await refreshInputQueue(); if (taskPlans.get(key) === plan) cancelTaskPlan(key); }
  } finally {
    if (taskPlans.get(key) === plan) { plan.sending = false; if (draftKey() === key) paintTaskPlan(); }
  }
}
async function queuePreparedPlan(key: string, plan: TaskPlanDraft & { stages: string[] }, sessionId: string, projectId: string | null): Promise<void> {
  if (plan.sending || composerSending.has(key)) return;
  const stages = plan.stages.map(stage => stage.trim());
  if (!stages.length || stages.some(stage => !stage) || JSON.stringify(stages).length > 12000) {
    toast(t("Keep every stage nonempty and the plan below 12,000 characters.")); return;
  }
  if (!draftRestoreComplete || deps.account?.()?.id !== composerDrafts.snapshot().profileId) {
    draftStorageMessage = 'Draft storage is waiting for the active account and project list. The plan was retained.'; paintDraftRecovery(); return;
  }
  if (draftKey() === key) rememberDraft(); else persistDraftKey(key);
  const draft = composerDrafts.get(key) ?? composerDrafts.record(key, plan.text, imageDrafts.get(key) ?? []);
  if (!draft || draft.pending) { paintDraftRecovery(); return; }
  const id = crypto.randomUUID();
  plan.sending = true;
  composerSending.add(key);
  if (draftKey() === key) paintTaskPlan();
  try {
    if (!await composerDrafts.beginAdmission(key, draft.generation, { inputId: id, text: stages[0]!, sessionId, projectId }) ||
        taskPlans.get(key) !== plan || deps.account?.()?.id !== composerDrafts.snapshot().profileId) {
      composerDrafts.abandon(key, draft.generation, id); return;
    }
    const result = await run(api.sendInput({ id, sessionId, projectId,
      text: stages[0]!, images: draft.files.filter((file): file is InputImage => 'dataUrl' in file),
      attachments: draft.files.filter((file): file is InputAttachment => 'id' in file),
      stages: stages.slice(1), mode: 'finish', dueAt: Date.now(), model: null, reasoningEffort: null }));
    if (result) {
      settleDraftAdmission(key, draft.generation, id);
      if (taskPlans.get(key) === plan) cancelTaskPlan(key);
      await refreshInputQueue();
    }
  } finally {
    composerSending.delete(key); paintDraftRecovery();
    plan.sending = false;
    if (taskPlans.get(key) === plan && draftKey() === key) paintTaskPlan();
  }
}
function paintTaskActions(): void {
  const objective = $<HTMLTextAreaElement>('sessionObjective');
  const save = $<HTMLButtonElement>('saveSessionObjective');
  const off = $<HTMLSelectElement>('chatAutomation').value === 'off';
  objective.hidden = off;
  document.querySelector<HTMLLabelElement>('label[for="sessionObjective"]')!.hidden = off;
  save.hidden = off;
  const saved = objective.dataset.saved === objective.value && !!objective.value.trim();
  save.disabled = objective.disabled || !objective.value.trim() || save.dataset.busy === 'true' || saved;
  ui(save.querySelector('span')!, 'textContent', () => save.dataset.busy === 'true' ? t("Saving…") : saved ? t("Saved") : t("Save task"));
  const text = $<HTMLTextAreaElement>('chatInput').value.trim();
  for (const id of ['createPlan']) {
    const button = $<HTMLButtonElement>(id);
    const plan = taskPlans.get(draftKey()), planMode = !!plan;
    if (plan?.requestId) { button.dataset.busy = 'true'; button.setAttribute('aria-busy', 'true'); }
    else { delete button.dataset.busy; button.removeAttribute('aria-busy'); }
    button.disabled = plan?.sending === true;
    button.setAttribute('aria-pressed', String(planMode));
    ui(button.querySelector('span')!, 'textContent', () => planMode ? t("Cancel plan") : t("Create plan"));
    ui(button, 'title', () => planMode ? t("Return to a normal message; keep your draft") : text ? t("Split your message into editable stages") : t("Write a message in the composer first"));
  }
}
function paintLoopDelivery(): void {
  const model = confirmedComposerModel();
  $('loopDeliveryRow').hidden = $<HTMLSelectElement>('chatAutomation').value !== 'loop' ||
    !model || !isProModel(model.model, model.reasoningEffort);
}
function openingLoopDelivery(automation: InputAutomation = $<HTMLSelectElement>('chatAutomation').value as InputAutomation): boolean | undefined {
  // The hidden Pro-Loop select is not a preference for Off or Goal. Sending it with every fresh
  // message polluted the chat's future Loop state: an old/stale "finish" value could make a Loop
  // enabled later pause after its first final answer. Only a Loop opening may author this field.
  return selectedId === null && automation === 'loop'
    ? $<HTMLSelectElement>('loopDelivery').value === 'after-turn'
    : undefined;
}
function paintAutomationSwitch(): void {
  paintLoopDelivery();
  paintGoalProgress();
  paintActiveGoal();
  const select = $<HTMLSelectElement>('chatAutomation');
  for (const button of $('automationSwitch').querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    button.setAttribute('aria-checked', String(button.dataset.mode === select.value));
    button.disabled = select.disabled;
  }
  $<HTMLSelectElement>('sessionObjectiveMode').value = select.value === 'loop' ? 'loop' : 'goal';
  const loop = select.value === 'loop';
  ui(document.querySelector('label[for="sessionObjective"]')!, 'textContent', () => loop ? t("Loop instructions") : t("Goal"));
  ui($<HTMLTextAreaElement>('sessionObjective'), 'placeholder', () => loop
    ? t("What should each continuation focus on?")
    : t("Optional. Leave empty to work toward what you asked in this chat."));
  paintTaskActions();
}

/** Repaint an already-accepted New Chat opening from the durable outbox after a failed
 * automation mutation. A still-unpublished opening deliberately stays on the user's newer
 * selection: sendComposer() reconciles that intent immediately after admission. */
async function reconcileAcceptedOpeningAutomation(id: string, generation: number, requestedMode: InputAutomation): Promise<void> {
  const all = await run(api.listInputs());
  if (!all || selectedId !== null || selectionGeneration !== generation || pendingNewInput?.id !== id) return;
  const select = $<HTMLSelectElement>('chatAutomation');
  if (select.value !== requestedMode) return;
  const current = all.find(row => row.id === id);
  if (!current) return;
  select.value = current.automation ?? 'off';
  delete select.dataset.edited;
  paintAutomationSwitch();
}

/** Loop delivery is part of the same accepted opening receipt. Reconcile only a failed
 * post-admission mutation and never overwrite a newer selector choice made while reading. */
async function reconcileAcceptedOpeningLoopDelivery(id: string, generation: number, requestedAfterTurn: boolean): Promise<void> {
  const all = await run(api.listInputs());
  if (!all || selectedId !== null || selectionGeneration !== generation || pendingNewInput?.id !== id) return;
  const select = $<HTMLSelectElement>('loopDelivery');
  if ((select.value === 'after-turn') !== requestedAfterTurn) return;
  const current = all.find(row => row.id === id);
  if (!current) return;
  select.value = current.loopAfterTurn === true ? 'after-turn' : 'finish';
  paintLoopDelivery();
}
async function refreshSessionControls(): Promise<void> {
  const id = selectedId, generation = ++controlsGeneration;
  const formerProjection = id ? automationBySession.get(id) : null;
  const previousEvidence = formerProjection && displayedAutomation(formerProjection).nativeEvidenceUnverified
    ? JSON.stringify([goalWaitView?.detail, goalWaitView?.nextAction]) : '';
  const planHost = $('agentPlan');
  if (planHost.dataset.sessionId !== (id ?? '')) renderAgentPlan(planHost, id, null);
  const menu = $('sessionControls');
  if (controlledSessionId !== id || controlledSelection !== selectionGeneration) {
    // Retire the previous selection's projection before awaiting the new owner's IPC.
    // Replace the translation binding too, so a locale refresh cannot revive its status.
    ui($('sessionControlStatus'), 'textContent', () => '');
    for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
  }
  paintAutomationSwitch();
  if (!id) { controlledSessionId = null; controlledConversationId = null; controlledReadAt = 0; controlledTurnId = null; controlledSessionKnown = false; controlledPlan = null; controlledObjective = ''; controlledBlocked = ''; controlledActiveWork = null; controlledDiagnosticIncidents = []; controlledDiagnosticChat = null; paintDeliveryControls(); menu.hidden = false;
    $<HTMLTextAreaElement>('sessionObjective').disabled = false;
    paintTaskActions(); paintProgressInbox();
    for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
    return; }
  // A slow controls response may have been read before a newer supervisor
  // observation. Use the request-start boundary, not response arrival, so
  // that late publication cannot resurrect an older unknown/working label.
  const controlsRequestedAt = Date.now();
  const controls = await run(api.getSessionControls(id));
  if (generation !== controlsGeneration || id !== selectedId) return;
  renderAgentPlan(planHost, id, controls?.plan ?? null);
  controlledSessionId = id;
  controlledConversationId = controls?.conversationId ?? null;
  controlledReadAt = controlsRequestedAt;
  controlledSelection = selectionGeneration;
  controlledSessionKnown = controls?.activeTurnId === null || typeof controls?.activeTurnId === 'string';
  controlledTurnId = controls?.activeTurnId ?? null;
  goalDraftView = controls?.goalDraft ?? null;
  goalWaitView = controls?.goalWait ?? null;
  finishGoalDraftView = controls?.finishGoalDraft ?? null;
  controlledStopPending = controls?.stopPending === true;
  controlledFinishWaiting = controls?.finishWaiting === true;
  controlledQueueAtFinish = controls?.queueAtFinish === true;
  controlledCanInject = controls?.canInject ?? controlledTurnId !== null;
  controlledCanSendDirectly = controls?.canSendDirectly === true;
  controlledRecovery = controls?.recovery ?? [];
  controlledPlan = controls?.plan ?? null;
  controlledObjective = controls?.objective ?? '';
  controlledBlocked = controls?.blocked ?? '';
  controlledActiveWork = controls?.activeWork ?? null;
  controlledDiagnosticIncidents = controls?.diagnosticIncidents ?? [];
  controlledDiagnosticChat = controls?.diagnosticChat ?? null;
  paintDeliveryControls();
  paintStateLine();
  const currentProjection = automationBySession.get(id);
  const nextEvidence = currentProjection && displayedAutomation(currentProjection).nativeEvidenceUnverified
    ? JSON.stringify([goalWaitView?.detail, goalWaitView?.nextAction]) : '';
  // A stable status refresh should not rebuild a large sidebar, but crossing the
  // exact unknown/native-working boundary must update Work and the sidebar together.
  if (previousEvidence !== nextEvidence) paintSessions();
  menu.hidden = !controls;
  $('compactSession').hidden = false;
  if (!controls) return;
  const objective = $<HTMLTextAreaElement>('sessionObjective');
  if (objective.dataset.sessionId !== id || !objective.dataset.edited) {
    objective.value = controls.objective;
    objective.dataset.saved = controls.objective;
    objective.dataset.sessionId = id;
    delete objective.dataset.edited;
    $<HTMLSelectElement>('sessionObjectiveMode').value = controls.automation === 'loop' ? 'loop' : 'goal';
  }
  objective.disabled = !!controls.blocked;
  paintTaskActions();
  const draftMode = $<HTMLSelectElement>('chatAutomation');
  if (!draftMode.dataset.edited) draftMode.value = controls.automation;
  if (!$<HTMLSelectElement>('loopDelivery').disabled)
    $<HTMLSelectElement>('loopDelivery').value = controls.loopAfterTurn ? 'after-turn' : 'finish';
  paintAutomationSwitch();
  const automationPaused = deps.state()?.config.ui.automationPaused === true;
  const cancellable = controls.job?.cancellable ?? controls.job?.busy ?? false;
  const cancelButton = $<HTMLButtonElement>('cancelCompaction');
  cancelButton.dataset.resumeSessionId = id;
  cancelButton.dataset.resumeToken = controls.job?.token ?? '';
  $<HTMLButtonElement>('compactSession').disabled = automationPaused || !!controls.blocked || !!controls.job?.busy || cancellable;
  cancelButton.hidden = !cancellable || !cancelButton.dataset.resumeToken;
  ui($('sessionControlStatus'), 'textContent', () => controls.blocked === 'worker' ? t("This sub-agent is managed by its prime.") : controls.blocked === 'blocked' ? t("This chat is blocked.") : controls.job?.busy ? t("Compaction is running in ChatGPT.") : cancellable && controls.job?.stage === 'failed' ? controls.job.error ?? '' : '');
  paintProgressInbox();
}

function progressMessageText(event: Extract<SessionEvent, { kind: 'user_message' }>): string {
  const candidate = event.authoredText ?? event.message?.text;
  const raw = typeof candidate === 'string' ? candidate : '';
  return (userPromptText(raw) ?? raw).replace(/\s+$/g, '').trim();
}

function reminderText(text: string): string | null {
  const marker = text.search(/(?:^|\n)Reminder:\s*/m);
  if (marker < 0) return null;
  return text.slice(marker + (text[marker] === '\n' ? 1 : 0)).trim().slice(0, 1800);
}

function provenWorkLabel(summary: SessionSummary): string {
  const active = controlledActiveWork?.primeSessionId
    ? controlledActiveWork
    : {
        primeSessionId: summary.id,
        sessionIds: [summary.id],
        activeWorkMs: summary.activeWorkMs ?? 0,
        activeWorkMeasurement: summary.activeWorkMeasurement ?? 'unknown' as const
      };
  if (active.activeWorkMeasurement === 'unknown') {
    return 'Active work: unknown — no exact execution interval evidence is available.';
  }
  const total = Math.max(0, active.activeWorkMs);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const value = hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  const family = active.sessionIds.length > 1 ? ` · union of ${active.sessionIds.length} prime/worker sessions` : '';
  const report = active.report;
  const checkpoint = report?.pending
    ? ` Report due at ${Math.round(report.pending.thresholdMs / 3_600_000)}h is reserved until exact delivery is reconciled.`
    : report?.delivered
      ? ` Last two-hour report receipt: ${Math.round(report.delivered.thresholdMs / 3_600_000)}h · ${new Date(report.delivered.confirmedAt).toLocaleString(currentLanguage())}.`
      : '';
  return `Active work: ${value} proven${family} · partial coverage. Missing model/browser intervals remain unknown.${checkpoint}`;
}

function progressEvidence(source: SessionEvent[]): Array<{ seq: number; time: number; title: string; detail: string }> {
  const rows: Array<{ seq: number; time: number; title: string; detail: string }> = [];
  for (const event of [...source].reverse()) {
    if (rows.length >= 8) break;
    if (event.kind === 'tool_call') {
      rows.push({ seq: event.seq, time: event.time, title: event.call.summary.title,
        detail: event.call.summary.detail ?? event.call.summary.metric ?? (event.call.outcome === 'ok' ? 'Recorded tool result' : event.call.outcome) });
    } else if (event.kind === 'assistant_message' && event.final) {
      rows.push({ seq: event.seq, time: event.time, title: 'Assistant result', detail: event.message.text.replace(/\s+/g, ' ').trim().slice(0, 180) });
    } else if (event.kind === 'chat_error') {
      rows.push({ seq: event.seq, time: event.time, title: 'Provider error', detail: event.message.text.replace(/\s+/g, ' ').trim().slice(0, 180) });
    } else if (event.kind === 'handoff') {
      rows.push({ seq: event.seq, time: event.time, title: 'Handoff saved', detail: `${event.chars.toLocaleString()} characters · ${event.reason}` });
    } else if (event.kind === 'user_message') {
      const reminder = reminderText(progressMessageText(event));
      if (reminder) rows.push({ seq: event.seq, time: event.time,
        title: event.inputId && event.inputDelivery === 'confirmed' ? 'Delivered app reminder' : 'Message containing reminder text',
        detail: reminder.split('\n')[0]!.slice(0, 180) });
      else if (event.inputId && event.inputDelivery) rows.push({ seq: event.seq, time: event.time,
        title: event.inputDelivery === 'confirmed' ? 'Native Send confirmed' : 'Tool handout offered',
        detail: `Input ${event.inputId} · ${event.inputDelivery === 'confirmed' && event.messageId
          ? `native message ${event.messageId}` : event.inputDelivery === 'offered'
            ? `handout reference ${event.messageId ?? 'unavailable'} · native message identity unconfirmed`
            : 'native message identity unconfirmed'} · response and completion not inferred` });
    }
  }
  return rows;
}

function appendProgressText(host: HTMLElement, heading: string, value: string, empty = false): void {
  const section = el('section', 'progress-section');
  section.append(el('h4', '', heading), el('div', `progress-copy${empty ? ' is-empty' : ''}`, value));
  host.append(section);
}

function paintProgressInbox(): void {
  const host = document.getElementById('progressInbox');
  if (!host) return;
  const draft = document.createElement('div');
  const summary = sessions.find(row => row.id === selectedId) ?? null;
  const toggle = document.getElementById('progressToggle') as HTMLButtonElement | null;
  if (toggle) toggle.hidden = !summary;
  if (!summary) {
    host.replaceChildren(el('p', 'empty', 'Select a recorded chat to inspect its progress.'));
    delete host.dataset.progressSession;
    return;
  }
  const automation = automationForSummary(summary) ?? undefined;
  const head = el('div', 'progress-inbox-head');
  const intro = el('div');
  intro.append(el('h3', '', 'Progress & reminders'), el('p', '', 'Read-only evidence from this chat’s saved objective, plan, automation state, and recorded work.'));
  const stateName = selectedControlsMatchCurrentBinding() && controlledBlocked ? 'blocked' : automation && automationStatusUnknown(automation) ? 'unknown' : automation?.state ??
    ordinaryTerminalOutcome(summary) ?? (sessionWorking(summary) ? 'working' : 'waiting');
  const state = el('span', `progress-state is-${stateName}`, stateName.replace(/-/g, ' '));
  head.append(intro, state); draft.append(head);

  const scope = progressOrigin?.sessionId === summary.id ? progressOrigin : null;
  const previousProviderEvidence = progressEventsFor === summary.id &&
    !!progressEventsConversationId && !!summary.conversationId &&
    progressEventsConversationId !== summary.conversationId;
  if (previousProviderEvidence) appendProgressText(draft, 'Recorded history boundary',
    'The last readable reminder, native delivery and recent evidence below belong to the previous provider conversation. Exact current-conversation history is not yet verified; preserve saved results and do not replay an uncertain input.');
  appendProgressText(draft, 'Original scope', scope?.text ?? (progressOriginLoadingFor === summary.id ? 'Loading the first recorded request…' : 'Original recorded request unavailable.'), !scope);
  if (scope) {
    const meta = el('div', 'progress-meta');
    const evidence = el('button', 'btn small', `Event #${scope.seq}`) as HTMLButtonElement;
    evidence.type = 'button'; evidence.dataset.evidenceSeq = String(scope.seq);
    meta.append(evidence, el('span', '', new Date(scope.time).toLocaleString(currentLanguage())));
    draft.lastElementChild?.append(meta);
  }

  appendProgressText(draft, 'Saved objective', controlledObjective || 'No separate objective is saved; the original request and later user instructions remain authoritative.', !controlledObjective);
  const currentProgressEvents = progressEventsFor === summary.id ? progressEvents : [];
  const reminderEvent = [...currentProgressEvents].reverse().find((event): event is Extract<SessionEvent, { kind: 'user_message' }> =>
    event.kind === 'user_message' && reminderText(progressMessageText(event)) !== null) ?? null;
  const currentReminder = reminderEvent ? reminderText(progressMessageText(reminderEvent)) : null;
  // An exact B history read may include A's earlier reminder: a successful
  // read proves the current *snapshot* was accessible, not that every event
  // inside the durable local session was delivered to B. Reuse the existing
  // outbox's exact input and provider owner when that receipt is available.
  const previousProviderReminder = !!reminderEvent?.inputId && pendingComposerInputs.some(input =>
    input.purpose !== 'decision' && input.id === reminderEvent.inputId &&
    (input.deliveredSessionId ?? input.sessionId) === summary.id &&
    !!input.conversationId && !!summary.conversationId &&
    input.conversationId !== summary.conversationId);
  const reminderStatus = currentReminder
    ? reminderEvent?.inputId && reminderEvent.inputDelivery === 'confirmed'
      ? `${currentReminder}\n\nDelivery evidence: confirmed app input ${reminderEvent.inputId}.`
      : `${currentReminder}\n\nDelivery provenance: this text is recorded in a native user message, but the current event schema does not prove it was the automatic Loop sender rather than authored text.`
    : progressEventsLoadingFor === summary.id
      ? 'Loading the latest recorded reminder evidence…'
      : 'No reminder text is visible in the latest recorded message evidence.';
  appendProgressText(draft, 'Reminder evidence', reminderStatus +
    (previousProviderEvidence || previousProviderReminder
      ? '\n\nPrevious provider conversation reminder; not evidence of a current-conversation Send.' : ''), !currentReminder);
  const nativeDelivery = workOverviewNativeDelivery(summary.id, chronological(currentProgressEvents), pendingComposerInputs);
  const priorNativeDelivery = !!nativeDelivery?.entry?.conversationId && !!summary.conversationId &&
    nativeDelivery.entry.conversationId !== summary.conversationId;
  if (nativeDelivery) appendProgressText(draft, 'Native delivery & answer',
    workOverviewNativeDeliveryLabel(nativeDelivery, progressEventsFor !== summary.id || previousProviderEvidence) +
    (previousProviderEvidence || priorNativeDelivery
      ? ' · This native Send belongs to a previous provider conversation; it does not confirm a Send or answer in the current conversation.' : ''));
  if (nativeDelivery?.previousConfirmed) appendProgressText(draft,
    nativeDelivery.previousOrderKnown ? 'Earlier native delivery' : 'Separate native delivery',
    workOverviewEarlierNativeDeliveryLabel(nativeDelivery.previousConfirmed, nativeDelivery.previousOrderKnown));

  const planSection = el('section', 'progress-section');
  planSection.append(el('h4', '', 'Acceptance work'));
  const plan = el('div', 'progress-plan');
  const completed = el('div'); completed.append(el('h4', '', 'Plan-marked completed'));
  const remaining = el('div'); remaining.append(el('h4', '', 'Remaining / in progress'));
  const completedList = document.createElement('ul');
  const remainingList = document.createElement('ul');
  for (const step of controlledPlan?.plan ?? []) {
    const item = document.createElement('li');
    item.append(el('strong', '', step.step));
    if (step.details) item.append(document.createTextNode(` — ${step.details}`));
    (step.status === 'completed' ? completedList : remainingList).append(item);
  }
  if (!completedList.childElementCount) completedList.append(el('li', '', 'No completed durable plan steps are recorded.'));
  if (!remainingList.childElementCount) remainingList.append(el('li', '', controlledPlan?.plan.length ? 'No unfinished durable plan steps are recorded; verify original acceptance before declaring done.' : 'No durable plan is recorded.'));
  completed.append(completedList); remaining.append(remainingList); plan.append(completed, remaining); planSection.append(plan); draft.append(planSection);
  const acceptance = acceptanceSummary(controlledPlan);
  appendProgressText(draft, 'Requirements & evidence', acceptance ?? 'No acceptance checklist is recorded. Completed plan steps alone do not establish task completion.', !acceptance);

  const blocker = selectedControlsMatchCurrentBinding() && controlledBlocked === 'worker' ? 'This sub-agent is managed by its prime.'
    : selectedControlsMatchCurrentBinding() && controlledBlocked === 'blocked' ? 'This chat is blocked by the user.'
      : automation ? `${automation.reason}${automation.nextAction ? ` ${automation.nextAction}` : ''}`.trim()
        : ordinaryTerminalOutcome(summary)
          ? `Last turn ${t(TURN_OUTCOME_LABELS[ordinaryTerminalOutcome(summary)!])}. Inspect the recorded error or saved result before taking any new action.`
        : 'No app-owned automation blocker is recorded.';
  appendProgressText(draft, 'Current state / blocker', blocker, !controlledBlocked && !automation);
  const work = el('section', 'progress-section');
  work.append(el('h4', '', 'Active-work evidence'), el('div', 'progress-copy', provenWorkLabel(summary)));
  draft.append(work);

  const incident = [...controlledDiagnosticIncidents].reverse()[0] ?? null;
  const incidentText = incident
    ? `${incident.kind} incident · ${incident.status}${incident.disposition ? ` · ${incident.disposition}` : ''} · observed ${new Date(incident.lastObservedAt).toLocaleString(currentLanguage())}` +
      (incident.wakeMessageId ? ` · delivery receipt ${incident.wakeMessageId}` : incident.status === 'ambiguous' ? ' · delivery ambiguous; automatic replay blocked' : '')
    : 'No qualified unresolved diagnostic incident is recorded for this workstream.';
  const diagnosticSection = el('section', 'progress-section');
  diagnosticSection.append(el('h4', '', 'Diagnostic recovery'), el('div', `progress-copy${incident ? '' : ' is-empty'}`, incidentText));
  if (controlledDiagnosticChat?.sessionId) {
    const openDiagnostic = el('button', 'btn small', 'Open diagnostic chat') as HTMLButtonElement;
    openDiagnostic.type = 'button';
    openDiagnostic.dataset.diagnosticSessionId = controlledDiagnosticChat.sessionId;
    const meta = el('div', 'progress-meta'); meta.append(openDiagnostic); diagnosticSection.append(meta);
  }
  draft.append(diagnosticSection);

  const evidenceSection = el('section', 'progress-section');
  evidenceSection.append(el('h4', '', 'Recent evidence'));
  const evidenceHost = el('div', 'progress-evidence');
  const evidenceRows = progressEvidence(currentProgressEvents);
  if (!evidenceRows.length) evidenceHost.append(el('div', 'progress-copy is-empty', 'No evidence rows are loaded in the current history window.'));
  for (const row of evidenceRows) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.evidenceSeq = String(row.seq);
    const time = document.createElement('time'); time.textContent = clockTime(row.time); time.dateTime = new Date(row.time).toISOString();
    const copy = el('span', 'progress-evidence-copy'); copy.append(el('strong', '', row.title), el('span', '', row.detail));
    button.append(time, copy); evidenceHost.append(button);
  }
  evidenceSection.append(evidenceHost); draft.append(evidenceSection);
  // A pause/state repaint must not detach an unchanged 5K-character original
  // scope, an evidence button with keyboard focus, or selected transcript text.
  // Compare the fresh read-only projection to the exact same session's mounted
  // sections, then reconcile only the sections whose actual content changed.
  // On A→B navigation, do not adopt any previous session's controls or evidence.
  const sameSession = host.dataset.progressSession === summary.id;
  const sectionKey = (element: HTMLElement): string => element.classList.contains('progress-inbox-head')
    ? 'header' : element.querySelector('h4')?.textContent ?? '';
  const previous = sameSession
    ? new Map([...host.children].map(child => [sectionKey(child as HTMLElement), child as HTMLElement]))
    : new Map<string, HTMLElement>();
  const sections = [...draft.children].map(child => {
    const next = child as HTMLElement;
    const retained = previous.get(sectionKey(next));
    return retained?.isEqualNode(next) ? retained : next;
  });
  reconcileChildren(host, sections);
  host.dataset.progressSession = summary.id;
}

async function refreshProgressEvents(): Promise<void> {
  const id = selectedId;
  const generation = selectionGeneration;
  if (!id || progressEventsLoadingFor === id) return;
  const requestedConversationId = sessions.find(row => row.id === id)?.conversationId ?? null;
  progressEventsLoadingFor = id;
  paintProgressInbox();
  try {
    const detail = await run(api.getSession(id, { limit: MAX_TIMELINE_ROWS }));
    if (!detail || id !== selectedId || generation !== selectionGeneration ||
        requestedConversationId !== (sessions.find(row => row.id === id)?.conversationId ?? null)) return;
    progressEventsFor = id;
    progressEventsConversationId = detail.summary?.conversationId ?? requestedConversationId;
    progressEvents = chronological(foldProgress(detail.events));
  } finally {
    if (progressEventsLoadingFor === id) progressEventsLoadingFor = null;
    if (id === selectedId) {
      paintProgressInbox();
      // The same local session can rebind while the previous provider's read
      // owns the in-flight slot. Its stale answer is discarded above, but that
      // slot also suppressed the successor's refresh. Ask once for the new
      // exact binding without waiting for another unrelated recorder event.
      if (generation === selectionGeneration &&
          requestedConversationId !== (sessions.find(row => row.id === id)?.conversationId ?? null) &&
          document.querySelector<HTMLElement>('#chatBody > [data-view="progress"]')?.hidden === false) {
        void refreshProgressEvents();
      }
    }
  }
}

async function refreshProgressOrigin(): Promise<void> {
  const id = selectedId;
  const generation = selectionGeneration;
  if (!id || progressOrigin?.sessionId === id || progressOriginLoadingFor === id) return;
  progressOriginLoadingFor = id; paintProgressInbox();
  try {
    const detail = await run(api.getSession(id, { from: 0, limit: MAX_TIMELINE_ROWS }));
    if (!detail || id !== selectedId || generation !== selectionGeneration) return;
    const first = detail.events.find((event): event is Extract<SessionEvent, { kind: 'user_message' }> => event.kind === 'user_message' && !nativeContinuationMarker(event.message.text));
    progressOrigin = first ? { sessionId: id, seq: first.seq, time: first.time, text: progressMessageText(first).slice(0, 5000) } : null;
  } finally {
    if (progressOriginLoadingFor === id) progressOriginLoadingFor = null;
    if (id === selectedId) paintProgressInbox();
  }
}

async function openProgressEvidence(seq: number): Promise<void> {
  const id = selectedId;
  const generation = selectionGeneration;
  if (!id) return;
  showView('timeline');
  let target = document.querySelector<HTMLElement>(`[data-event-seq="${seq}"]`);
  if (!target) {
    const detail = await run(api.getSession(id, { before: seq + 1, limit: MAX_TIMELINE_ROWS }));
    if (!detail || id !== selectedId || generation !== selectionGeneration) return;
    events = chronological(foldProgress(detail.events));
    totalEvents = detail.total; detailFor = id; detailCursor = detail.nextFrom; historyBefore = seq + 1;
    paintDetail(false);
    target = document.querySelector<HTMLElement>(`[data-event-seq="${seq}"]`);
  }
  const disclosure = target?.closest<HTMLDetailsElement>('details');
  if (disclosure) disclosure.open = true;
  target?.classList.add('is-evidence-target');
  target?.scrollIntoView({ block: 'center' });
  if (target) window.setTimeout(() => target?.classList.remove('is-evidence-target'), 1600);
}

async function navigateHistory(before: number | null, prepend = false): Promise<void> {
  const selected = selectedId;
  const selection = selectionGeneration;
  historyBefore = before;
  if (before === null) $('timeline').style.removeProperty('--timeline-scroll-reserve');
  detailCursor = null;
  const loading = loadDetail(true, prepend);
  const generation = detailLoadGeneration;
  await loading;
  if (selectedId !== selected || selectionGeneration !== selection || detailLoadGeneration !== generation) return;
  if (!prepend) {
    timelineFollowBottom = before === null;
    $('chatBody').scrollTop = before === null ? $('chatBody').scrollHeight : 0;
  }
}

/**
 * Open the first bounded page directly. ChatGPT handoffs can keep years of local
 * history behind a fresh cloud conversation; requiring hundreds of wheel events
 * to reach that original request makes the preserved history practically hidden.
 * This is a read-only session query and never touches the browser conversation,
 * composer, continuation owner or automation state.
 */
async function navigateHistoryStart(): Promise<void> {
  const selected = selectedId;
  const selection = selectionGeneration;
  if (!selected || historyLoading) return;
  historyLoading = true;
  const button = $<HTMLButtonElement>('chatJumpStart');
  button.disabled = true;
  const generation = ++detailLoadGeneration;
  void refreshSessionControls();
  try {
    const detail = await run(api.getSession(selected, { from: 0, limit: MAX_TIMELINE_ROWS }));
    if (!detail || generation !== detailLoadGeneration || selectedId !== selected || selectionGeneration !== selection) return;
    const folded = chronological(foldProgress(detail.events));
    events = folded.slice(0, MAX_TIMELINE_ROWS);
    detailFor = selected;
    totalEvents = detail.total;
    detailCursor = typeof detail.nextFrom === 'number'
      ? detail.nextFrom
      : detail.events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0);
    const next = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0);
    // A non-null boundary marks a historical page and exposes Back to latest.
    const hasNewer = detail.total > detail.events.length || folded.length > MAX_TIMELINE_ROWS;
    historyBefore = hasNewer && next > 0 ? next : null;
    timelineFollowBottom = false;
    paintDetail(false);
    $('chatBody').scrollTop = 0;
    void loadHandoff();
  } finally {
    historyLoading = false;
    if (selectedId === selected) button.disabled = false;
  }
}
async function loadDetail(navigate = false, prepend = false, newerFrom?: number): Promise<void> {
  const wanted = selectedId;
  if (wanted !== null && historyBefore !== null && detailFor === wanted && !navigate) { void refreshSessionControls(); paintDetail(); return; }
  const generation = ++detailLoadGeneration;
  void refreshSessionControls();
  if (wanted === null) {
    handoffLoadGeneration++;
    historyBefore = null;
    events = [];
    totalEvents = 0;
    detailFor = null;
    detailCursor = null;
    paintDetail();
    return;
  }
  const opening = detailFor !== wanted;
  if (opening) historyBefore = null;
  // Live deltas must not evict a historical page while the user is reading it.
  const incremental = newerFrom === undefined && historyBefore === null && detailFor === wanted && detailCursor !== null;
  const searchTarget = opening && pendingSearchTarget?.sessionId === wanted ? pendingSearchTarget : null;
  const detail = await run(api.getSession(wanted,
    newerFrom !== undefined ? { from: newerFrom, limit: MAX_TIMELINE_ROWS / 2 }
      : incremental ? { from: detailCursor!, limit: MAX_TIMELINE_ROWS }
      : searchTarget ? { before: searchTarget.seq + 1, limit: MAX_TIMELINE_ROWS }
      : { ...(historyBefore !== null ? { before: historyBefore } : {}), limit: prepend ? MAX_TIMELINE_ROWS / 2 : MAX_TIMELINE_ROWS }
  ));
  if (!detail || generation !== detailLoadGeneration || selectedId !== wanted) return;
  // User/assistant prose is canonical in messages.json, while structured page activity stays
  // append-only by design: ChatGPT can grow one commentary caption or rewrite one activity
  // label several times. `foldProgress` turns those snapshots back into the one logical row
  // their stable progressId/messageId names, then chronology places that row at its first
  // appearance. This helper existed already but was never wired into the desktop reader,
  // which is why "Inspecting…" and "Inspected…" still appeared as siblings.
  if (incremental) mergeDetailDelta(detail.events);
  else {
    const folded = chronological(foldProgress(detail.events));
    if (newerFrom !== undefined) {
      events = retainTimelinePage(chronological(foldProgress([...events, ...folded])), 'newer');
      // Reaching the live tail restores ordinary delta reads. Paging itself preserves
      // the reader's row even when they were at the bottom of the previous window.
      if (detail.events.length < MAX_TIMELINE_ROWS / 2) historyBefore = null;
    } else if (prepend) {
      const boundary = historyBefore!;
      const retained = events.filter(event => event.seq >= boundary);
      events = retainTimelinePage(chronological(foldProgress([...folded, ...retained])), 'older');
    } else events = folded.slice(Math.max(0, folded.length - MAX_TIMELINE_ROWS));
    detailFor = wanted;
  }
  detailCursor =
    typeof detail.nextFrom === 'number'
      ? detail.nextFrom
      : detail.events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), incremental ? detailCursor! : 0);
  totalEvents = detail.total;
  paintDetail(!prepend && newerFrom === undefined);
  // A selection opens at the latest message; the previous chat's viewport is not
  // a reading position in this one. Apply only after the current load has rendered.
  if (searchTarget) {
    pendingSearchTarget = null;
    const row = $('timeline').querySelector<HTMLElement>(`[data-timeline-key="event:${searchTarget.seq}"]`);
    if (row) {
      timelineFollowBottom = false;
      row.scrollIntoView({ block: 'center' });
      row.classList.add('is-search-match');
      window.setTimeout(() => row.classList.remove('is-search-match'), 1800);
    }
  } else if (opening) $('chatBody').scrollTop = $('chatBody').scrollHeight;
  void loadHandoff();
  // A burst can contain more than one renderer-sized page between coalesced notifications.
  // Drain it page by page rather than silently jumping the cursor or lifting the payload cap.
  if (incremental && detail.events.length === MAX_TIMELINE_ROWS && selectedId === wanted) {
    window.setTimeout(() => void loadDetail(), 0);
  }
}

async function loadHandoff(): Promise<void> {
  const sessionId = selectedId;
  const generation = ++handoffLoadGeneration;
  const summary = sessions.find((s) => s.id === sessionId) ?? null;
  const wanted = summary?.lastHandoffId ?? null;
  if (wanted === null) {
    if (generation !== handoffLoadGeneration || selectedId !== sessionId) return;
    handoff = null;
    handoffFor = null;
    paintHandoff();
    return;
  }
  if (handoffFor === wanted) return;
  const loaded = await run(api.getHandoff(summary!.id, wanted));
  if (generation !== handoffLoadGeneration || selectedId !== sessionId) return;
  handoff = loaded ?? null;
  handoffFor = wanted;
  paintHandoff();
}

// ------------------------------------------------------------------ timeline

function textBlock(className: string, value: string, truncated: boolean, chars: number): HTMLElement {
  const node = el('p', className, value);
  // Recorded text is whatever language the user and ChatGPT were speaking. The stylesheet is
  // written left-to-right throughout, so an Arabic or Hebrew message rendered without this
  // reads with its punctuation and numbers on the wrong side. `auto` resolves from the first
  // strong character, so Latin text is unaffected.
  node.setAttribute('dir', 'auto');
  if (truncated) {
    node.append(el('span', 'cut', () => t(" … cut, {0} characters in the original", [compactNumber(chars)])));
  }
  return node;
}

const RENDERED_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'KBD', 'LI', 'MARK', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);
const DROP_RENDERED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'META', 'LINK'
]);

function safeRenderedHref(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) return trimmed;
  return safeExternalLink(trimmed) ? trimmed : null;
}

const PROVIDER_CITATION = /^\uE200(?:cite|filecite)\uE202[^\uE200\uE201]*\uE201/;
const PROVIDER_URL = /^\uE200url\uE202([^\uE200-\uE202]*)\uE202([^\uE200-\uE202]*)\uE201/;
/** Native citation labels and URLs may arrive before the DOM paints the rest of a canonical
 * revision. Use only exact source ranges with matching preceding prose, never substitute
 * the whole captured HTML or guess a destination from an opaque provider reference id. */
function citationLabels(source: string, capture?: StoredText): Map<string, string> {
  const links = new Map<string, string>();
  if (!capture?.text || capture.truncated || capture.text.length > MAX_RENDERED_HTML_CHARS) return links;
  const template = document.createElement('template');
  template.innerHTML = capture.text;
  // Provider reference ranges count Unicode code points; JS slice counts UTF-16
  // units. Emoji before a citation otherwise move every subsequent range.
  const offsets = new Uint32Array(source.length + 1);
  let points = 0, units = 0;
  for (const char of source) { offsets[points++] = units; units += char.length; }
  offsets[points] = units;
  const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
  const prose = (fragment: DocumentFragment) => {
    // Native HTML and Markdown emit different whitespace around hard breaks and
    // list paragraphs. Compare the same rendered word boundaries in both trees.
    for (const br of fragment.querySelectorAll('br')) br.replaceWith('\n');
    for (const block of fragment.querySelectorAll('p,div,li,ul,ol,blockquote,pre,h1,h2,h3,h4,h5,h6,table,tr,td,th')) {
      block.prepend('\n'); block.append('\n');
    }
    return normalized(fragment.textContent ?? '');
  };
  for (const reference of template.content.querySelectorAll('[data-content-reference-start][data-content-reference-end]')) {
    const from = Number(reference.getAttribute('data-content-reference-start'));
    const to = Number(reference.getAttribute('data-content-reference-end'));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > points) continue;
    const start = offsets[from]!, end = offsets[to]!;
    const marker = source.slice(start, end);
    if (marker.match(PROVIDER_CITATION)?.[0] !== marker) continue;
    const before = document.createRange(); before.setStart(template.content, 0); before.setEndBefore(reference);
    const preceding = before.cloneContents();
    for (const prior of preceding.querySelectorAll('[data-content-reference-start]')) prior.remove();
    const canonical = document.createElement('template');
    canonical.innerHTML = marked.parse(source.slice(0, start).replace(/\uE200(?:cite|filecite)\uE202[^\uE200\uE201]*\uE201/g, ''), { async: false, gfm: true });
    if (prose(preceding) !== prose(canonical.content)) continue;
    if (marker.startsWith('\uE200filecite\uE202')) {
      const names = [...reference.querySelectorAll('[data-file-citation-primary-file-id] button')]
        .map(node => normalized(node.textContent ?? '')).filter(name => name.length > 0 && name.length <= 500);
      if (names.length) {
        const label = document.createElement('span');
        label.textContent = ` (${[...new Set(names)].join(', ')})`;
        links.set(marker, label.outerHTML);
      }
      continue;
    }
    const anchors: string[] = [], seen = new Set<string>();
    for (const candidate of reference.querySelectorAll('a[href]')) {
      const href = safeRenderedHref(candidate.getAttribute('href') ?? '');
      if (!href || !/^https?:/.test(href) || seen.has(href)) continue;
      seen.add(href);
      const anchor = document.createElement('a'); anchor.href = href;
      anchor.textContent = new URL(href).hostname;
      ui(anchor, 'title', () => candidate.textContent?.trim().slice(0, 500) || t("Source"));
      anchors.push(anchor.outerHTML);
    }
    if (anchors.length) links.set(marker, ` (${anchors.join(', ')})`);
  }
  return links;
}

/**
 * Sanitizes ChatGPT's captured rendered HTML without reparsing Markdown.
 *
 * The page is untrusted input even though the extension produced the observation. Preserve
 * semantic Markdown tags, discard executable/form/embed content, strip every attribute by
 * default, and allow only the tiny attribute set that affects normal Markdown semantics.
 */
/**
 * One assistant message, as ChatGPT rendered it when that is available and whole, and as its
 * own markdown source when it is not.
 *
 * The two are laid out differently on purpose. Rendered markup carries its own block
 * structure, so it is flowed (`rich`). Markdown source is plain text whose every line break,
 * heading and list item is a newline, so it keeps `msg`'s pre-wrap — flowing it would run a
 * whole brief together into one paragraph.
 */
/** ChatGPT's native writing container rendered as a normal safe quote card. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const WRITING_BLOCK: TokenizerAndRendererExtension = {
  name: 'writingBlock', level: 'block',
  start: value => value.match(/^:::writing\b/m)?.index,
  tokenizer(value) {
    const match = value.match(/^:::writing(\{[^}\n]*\})?[ \t]*\n([\s\S]*?)\n:::[ \t]*(?:\n|$)/);
    if (!match) return undefined;
    const title = match[1]?.match(/\btitle="([^"\n]*)"/)?.[1] ?? '';
    return { type: 'writingBlock', raw: match[0], title, tokens: this.lexer.blockTokens(match[2] ?? '', []) };
  },
  renderer(token) {
    const heading = token['title'] ? `<p><strong>${escapeHtml(String(token['title']))}</strong></p>` : '';
    return `<blockquote>${heading}${this.parser.parse(token.tokens ?? [])}</blockquote>`;
  }
};

// Upstream v2.1.32's choice prompt projection: captured provider controls are never
// replayed. Preserve only their bounded, authored question/labels, not entered values.
const NATIVE_PROMPT_GROUPS = 'form, [role="radiogroup"], [role="listbox"], [role="group"]';
const NATIVE_PROMPT_CONTROL = 'input, textarea, select, button, [role="radio"], [role="checkbox"], [role="option"]';
const promptWords = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 250);
const promptMatchText = (value: string): string => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
function nativePromptHidden(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return true;
    const style = (node as HTMLElement).style;
    if (style?.display === 'none' || ['hidden', 'collapse'].includes(style?.visibility ?? '') ||
        style?.getPropertyValue('content-visibility') === 'hidden') return true;
  }
  return false;
}
function nativePromptLabel(element: Element | null | undefined): string {
  if (!element || nativePromptHidden(element)) return '';
  const copy = element.cloneNode(true) as Element;
  for (const child of copy.querySelectorAll('*')) {
    if (child.matches('input, textarea, select, script, style, template, svg, math') || nativePromptHidden(child)) child.remove();
  }
  return copy.textContent ?? '';
}

function nativePromptCards(root: ParentNode): Array<{ group: Element; anchor: string; card: HTMLElement; options: string[] }> {
  const cards: Array<{ group: Element; anchor: string; card: HTMLElement; options: string[] }> = [];
  for (const group of root.querySelectorAll(NATIVE_PROMPT_GROUPS)) {
    if (cards.length >= 8) break;
    if (nativePromptHidden(group) || group.closest('svg, math, script, style, template, pre, code')) continue;
    if (group.parentElement?.closest(NATIVE_PROMPT_GROUPS)) continue;
    const controls = [...group.querySelectorAll(NATIVE_PROMPT_CONTROL)].filter(control => !nativePromptHidden(control));
    if (!controls.length || (group.getAttribute('role') === 'group' && !controls.some(control =>
      control.matches('input, textarea, select, [role="radio"], [role="checkbox"]')))) continue;
    const heading = group.querySelector('legend, h1, h2, h3, h4, [role="heading"], p');
    const preceding = group.previousElementSibling;
    const anchor = promptWords(group.getAttribute('aria-label') || nativePromptLabel(heading) ||
      (preceding?.matches('p, h1, h2, h3, h4') ? nativePromptLabel(preceding) : '') || '');
    const options: string[] = [], actions: string[] = [];
    const add = (value: string): void => {
      const label = promptWords(value);
      if (label && !options.includes(label) && options.length < 16) options.push(label);
    };
    for (const control of controls) {
      if (control.matches('input')) {
        const type = (control.getAttribute('type') || 'text').toLowerCase();
        if (['hidden', 'password', 'submit', 'button'].includes(type)) continue;
        const id = control.getAttribute('id');
        const label = control.closest('label') ?? (id ? [...group.querySelectorAll('label')].find(node => node.getAttribute('for') === id) : null);
        add((label && group.contains(label) ? nativePromptLabel(label) : '') || control.getAttribute('aria-label') || control.getAttribute('placeholder') || '');
      } else if (control.matches('select')) {
        for (const option of control.querySelectorAll('option')) add(nativePromptLabel(option));
      } else if (control.matches('[role="radio"], [role="checkbox"], [role="option"]')) {
        add(control.getAttribute('aria-label') || nativePromptLabel(control));
      } else if (control.matches('textarea')) {
        add(control.getAttribute('aria-label') || control.getAttribute('placeholder') || '');
      } else if (control.matches('button') && group.matches('form')) {
        const label = promptWords(nativePromptLabel(control) || control.getAttribute('aria-label') || '');
        if (label && !actions.includes(label)) actions.push(label);
      }
    }
    if (!options.length) for (const action of actions) add(action);
    if (!options.length) continue;
    const card = document.createElement('blockquote');
    if (anchor) {
      const question = document.createElement('p');
      const strong = document.createElement('strong'); strong.textContent = anchor;
      question.append(strong); card.append(question);
    }
    const list = document.createElement('ul');
    for (const option of options) { const row = document.createElement('li'); row.textContent = option; list.append(row); }
    card.append(list);
    const instruction = document.createElement('p');
    const explanation = document.createElement('em');
    ui(explanation, 'textContent', () => t('Answer this prompt in ChatGPT'));
    instruction.append(explanation); card.append(instruction);
    cards.push({ group, anchor, card, options });
  }
  return cards;
}

export function renderedMarkdown(source: string, capture?: StoredText): HTMLElement {
  // Fiber's canonical text can be complete while a background provider tab still
  // paints its first words. Render this revision directly; captured DOM HTML is
  // never authority to replace current prose or existing table rows. Only the
  // bounded unique header-only DIL presentation may recover its recorded cells.
  let text = completedDilText(withoutMessageReaction(source), capture).slice(0, MAX_RENDERED_HTML_CHARS);
  if (hasProviderDirective(text)) {
    const plain = withoutProviderDirectives(text);
    if (resolvedCapture(capture)) return renderedMessage(capture, plain);
    text = plain || t('This reply points to content from another message that was not recorded.');
  }
  const citations = text.includes('\uE200') ? citationLabels(text, capture) : new Map<string, string>();
  // An inline tokenizer leaves literal citation examples inside code spans/fences intact.
  const parser = new Marked({ gfm: true, extensions: [WRITING_BLOCK, {
    name: 'providerReference', level: 'inline',
    start: value => value.indexOf('\uE200'),
    tokenizer(value) { const match = value.match(PROVIDER_URL) ?? value.match(PROVIDER_CITATION); return match ? { type: 'providerReference', raw: match[0] } : undefined; },
    renderer(token) {
      const url = token.raw.match(PROVIDER_URL);
      if (url) {
        // Unlike opaque citation IDs, a native url token already carries its exact
        // authored label and destination. Captured React anchors may have no href.
        const link = document.createElement('a'); ui(link, 'textContent', () => url[1] || url[2] || t("Link"));
        if (safeExternalLink(url[2] ?? '')) link.setAttribute('href', url[2]!);
        return link.outerHTML;
      }
      return citations.get(token.raw) ?? (token.raw.startsWith('\uE200filecite\uE202') ? '' : '<span title="The recording does not include this source URL">[source link unavailable]</span>');
    }
  }] });
  const html = parser.parse(text, { async: false });
  const box = renderedMessage({ text: html, chars: html.length, truncated: html.length > MAX_RENDERED_HTML_CHARS }, text);
  if (capture?.text && !capture.truncated && capture.text.length <= MAX_RENDERED_HTML_CHARS) {
    const template = document.createElement('template'); template.innerHTML = capture.text;
    const current = promptMatchText(box.textContent ?? '');
    for (const prompt of nativePromptCards(template.content)) {
      if (prompt.anchor.length < 8 || !current.includes(promptMatchText(prompt.anchor)) ||
          prompt.options.every(option => current.includes(promptMatchText(option)))) continue;
      prompt.card.querySelector(':scope > p:first-child')?.remove();
      prompt.card.classList.add('native-prompt-readonly');
      box.append(prompt.card);
    }
  }
  return box;
}

export function renderedMessage(html: StoredText | null | undefined, fallback: string): HTMLElement {
  const box = el('div', 'msg');
  // Same reason as textBlock, for the markdown path — and it is the fallback rather than the
  // authority: an element below that carried its own direction keeps it.
  box.setAttribute('dir', 'auto');
  const safeFallback = fallback.slice(0, MAX_RENDERED_HTML_CHARS);
  // A capture the store had to cut is markup that stops mid-element — very often inside a
  // code block, whose wrapper chrome is far larger than the code in it — so it presents part
  // of the message and ends as an unclosed box. It is not a presentation of this message and
  // is not shown as one.
  if (!html || html.truncated || !html.text) {
    box.textContent = safeFallback;
    return box;
  }
  box.classList.add('rich');
  const template = document.createElement('template');
  // Parsing untrusted captured HTML constructs a second tree before sanitisation. Bound it
  // before innerHTML so a valid but huge recorded turn cannot freeze/OOM the renderer.
  template.innerHTML = html.text.slice(0, MAX_RENDERED_HTML_CHARS);
  const prompts = nativePromptCards(template.content);
  for (const prompt of prompts) prompt.group.replaceWith(prompt.card);
  const visit = (parent: ParentNode, directionOwned = false): void => {
    for (const node of [...parent.childNodes]) {
      // Namespace elements (SVG/MathML) are not HTMLElements. Checking HTMLElement here
      // would let exactly the foreign content in DROP_RENDERED_TAGS bypass traversal and
      // attribute stripping. nodeType is realm-agnostic and covers every DOM Element.
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const tagName = element.tagName.toUpperCase();
      if (DROP_RENDERED_TAGS.has(tagName)) {
        element.remove();
        continue;
      }
      const sourceDir = element.getAttribute('dir')?.toLowerCase();
      const dir = sourceDir === 'ltr' || sourceDir === 'rtl' || sourceDir === 'auto' ? sourceDir : null;
      // Native first-strong detection belongs to each prose block, not the whole
      // answer. A list/quote or explicit captured direction owns its descendants:
      // nested auto scopes would exclude their text from that owner's scan.
      const automatic = !directionOwned && /^(P|H[1-6]|UL|OL|BLOCKQUOTE|TD|TH)$/.test(tagName);
      const code = tagName === 'PRE' || tagName === 'CODE' || tagName === 'KBD';
      const resolvedDir = RENDERED_TAGS.has(tagName) ? dir ?? (code ? 'ltr' : automatic ? 'auto' : null) : null;
      visit(element, directionOwned || !!resolvedDir);
      if (!RENDERED_TAGS.has(tagName)) {
        element.replaceWith(...element.childNodes);
        continue;
      }
      const href = tagName === 'A' ? safeRenderedHref(element.getAttribute('href') ?? '') : null;
      const title = element.getAttribute('title');
      const start = tagName === 'OL' ? element.getAttribute('start') : null;
      const colSpan = tagName === 'TD' || tagName === 'TH' ? element.getAttribute('colspan') : null;
      const rowSpan = tagName === 'TD' || tagName === 'TH' ? element.getAttribute('rowspan') : null;
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      if (resolvedDir) element.setAttribute('dir', resolvedDir);
      if (href) {
        element.setAttribute('href', href);
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noreferrer noopener');
      }
      if (title) element.setAttribute('title', title.slice(0, 500));
      if (start && /^\d{1,6}$/.test(start)) element.setAttribute('start', start);
      if (colSpan && /^\d{1,3}$/.test(colSpan)) element.setAttribute('colspan', colSpan);
      if (rowSpan && /^\d{1,3}$/.test(rowSpan)) element.setAttribute('rowspan', rowSpan);
    }
  };
  visit(template.content);
  // Untrusted capture classes were stripped; only our own presentation class returns.
  for (const prompt of prompts) prompt.card.classList.add('native-prompt-readonly');
  box.append(template.content);
  const openLink = (event: MouseEvent): void => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor || !box.contains(anchor)) return;
    const href = safeRenderedHref(anchor.getAttribute('href') ?? '');
    event.preventDefault();
    if (!href) return;
    if (href.startsWith('#')) { document.getElementById(href.slice(1))?.scrollIntoView(); return; }
    // Electron deliberately denies arbitrary renderer navigation/window.open. A user
    // activation crosses the existing, independently validated main-process link API.
    void run(api.openLink(href));
  };
  box.addEventListener('click', openLink);
  box.addEventListener('auxclick', openLink);
  // Tables wrap to the transcript column. Extremely wide structural tables retain
  // their own horizontal scroll instead of widening/clipping the whole conversation.
  for (const table of box.querySelectorAll('table')) {
    const viewport = el('div', 'markdown-table');
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region');
    ui(viewport, 'aria-label', () => t("Table"));
    table.replaceWith(viewport);
    viewport.append(table);
  }
  if (!box.textContent?.trim() && safeFallback) {
    box.classList.remove('rich');
    box.textContent = safeFallback;
  }
  return box;
}

/**
 * Tool calls the user has opened, by their durable call id.
 *
 * The timeline is redrawn from scratch whenever anything is recorded, and a fresh
 * `<details>` is closed. So opening a call to read its arguments and then having ChatGPT
 * make one more MCP call — which is to say, the normal case — silently collapsed what you
 * were reading, several times a minute. Remembering the open set outside the DOM is what
 * makes a redraw invisible; the ids are the recorder's own, so they survive the rebuild.
 *
 * Cleared when a different session is selected, not on every repaint: the whole point is
 * that a repaint must not be able to change what is open.
 */
const openTools = new Set<string>();

/**
 * The rows currently on screen, by timeline key, with the signature they were drawn from.
 *
 * A repaint rebuilds only the rows whose signature changed and reuses every other element
 * as it is. That is what keeps the scroll position honest: a row the user has opened keeps
 * its height and its place, so the pane does not lurch when ChatGPT records one more call —
 * and the rebuilt-from-scratch list, which made the whole pane re-lay out on every event,
 * is what made reading an open call impossible while a chat was working.
 */
const rowCache = new Map<string, { sig: string; row: HTMLElement }>();

function forgetTimelineRows(): void {
  openTools.clear();
  rowCache.clear();
  $('timeline').style.removeProperty('--timeline-scroll-reserve');
}

function toolBody(event: Extract<SessionEvent, { kind: 'tool_call' }>, context?: { id: string; current: () => boolean }): HTMLElement {
  const { call } = event;
  const summary = toolCallSummary(call);
  const box = document.createElement('details');
  box.className = `tool tone-${call.summary.tone}`;
  box.open = openTools.has(call.callId);
  box.addEventListener('toggle', () => {
    if (box.open) openTools.add(call.callId);
    else openTools.delete(call.callId);
  });

  const head = document.createElement('summary');
  head.append(icon(KIND_ICON[call.summary.kind] ?? 'i-bolt', 'ico tool-ico'));
  head.append(el('b', '', call.summary.title));
  if (call.summary.detail) head.append(el('em', '', call.summary.detail));
  if (summary.metric) head.append(el('span', 'metric', summary.metric));
  box.append(head);

  const raw = el('div', 'raw');
  const facts = el('p', 'raw-facts');
  ui(facts, 'textContent', () => `${call.tool} · ${call.outcome} · ${Math.round(call.durationMs)} ms · ` +
    t("placed by {0}", [ATTRIBUTION_LABELS[call.attribution] ?? call.attribution]));
  raw.append(facts);

  if (call.changes && call.changes.length > 0) {
    const changes = el('ul', 'changes');
    for (const change of call.changes) {
      const li = el('li');
      li.append(el('code', '', change.path));
      const counts = `+${change.added} −${change.removed}${change.approximate ? t(" (approx.)") : ''}`;
      li.append(el('span', 'metric', counts));
      changes.append(li);
    }
    raw.append(changes);
  }

  raw.append(el('h4', '', () => t("Arguments")));
  raw.append(textBlock('pre', call.args.text, call.args.truncated, call.args.chars));
  raw.append(el('h4', '', () => t("Result")));
  const images = call.assets?.filter(asset => ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) ?? [];
  const readable = toolResultText(call.result.text, call.result.truncated, images.length > 0);
  if (readable) raw.append(textBlock('pre', readable, call.result.truncated && images.length === 0, call.result.chars));
  // Older recordings did not retain the reason an image asset was omitted. Explain
  // the missing local preview without inferring a historical provider receipt.
  if (call.tool === 'view_image' && call.outcome === 'ok' && images.length === 0) {
    raw.append(el('p', 'meta', () => t("No image preview was retained in this recording.")));
  }
  if (images.length && (context?.id || selectedId)) {
    const id = context?.id ?? selectedId!, generation = selectionGeneration;
    const attachments = el('div', 'tool-images');
    let loaded = false;
    const load = async () => {
      if (!box.open || loaded) return;
      loaded = true;
      for (const asset of images) {
        const data = await run(api.getSessionImage(id, asset.id));
        if (context ? !context.current() : id !== selectedId || generation !== selectionGeneration) return;
        if (!data) { attachments.append(el('p', 'meta', () => t("Image unavailable"))); continue; }
        const image = document.createElement('img');
        image.src = data; image.alt = t("{0} result", [call.tool]); image.loading = 'lazy';
        image.style.cssText = 'display:block;max-width:100%;max-height:600px;object-fit:contain;margin:8px 0';
        attachments.append(image);
      }
    };
    box.addEventListener('toggle', () => void load());
    raw.append(attachments);
    void load();
  }
  if (call.result.assetId) raw.append(el('p', 'raw-facts', () => t("Full recorded response: {0}", [call.result.assetId])));

  for (const asset of call.assets ?? []) {
    raw.append(el('p', 'raw-facts', () => t("asset {0} · {1} · {2} bytes", [asset.id, asset.mimeType, compactNumber(asset.bytes)])));
  }

  box.append(raw);
  return box;
}

function hasLaterModelActivity(time: number): boolean {
  return events.some(event => event.time > time && ['assistant_message', 'tool_call', 'page_tool', 'agent_message'].includes(event.kind));
}

function paintInputReceipt(row: HTMLElement, item: ReturnType<typeof timelineItems>[number]): void {
  if (item.kind !== 'event' || item.event.kind !== 'user_message') return;
  const receipt = row.querySelector<HTMLElement>('.input-receipt');
  if (!receipt) return;
  receipt.hidden = hasLaterModelActivity(item.event.time);
  receipt.parentElement?.classList.toggle('has-input-receipt', !receipt.hidden);
}

function paintMessageReaction(box: HTMLElement, value: unknown): void {
  const reaction = messageReaction(value);
  const existing = box.querySelector<HTMLElement>('.message-reaction');
  if (!reaction) { existing?.remove(); return; }
  if (existing?.textContent === reaction) return;
  const badge = existing ?? el('span', 'message-reaction');
  badge.textContent = reaction;
  badge.setAttribute('role', 'img');
  ui(badge, 'aria-label', () => t("ChatGPT reacted with {0}", [reaction]));
  if (!existing) box.append(badge);
}

function eventBody(
  event: SessionEvent,
  context?: { id: string; current: () => boolean; history: readonly SessionEvent[] },
  chatErrors: readonly Extract<SessionEvent, { kind: 'chat_error' }>[] = []
): HTMLElement {
  switch (event.kind) {
    case 'session_start':
      return el('p', 'meta', () => t("Session started — {0}", [event.title]));
    case 'user_message': {
      const box = el('div', 'said is-user');
      box.classList.add('has-reaction-slot');
      box.append(el('b', '', () => t("You")));
      const attachments = el('div', 'message-attachments');
      if (event.attachments?.length) attachments.append(...event.attachments.map(file => attachmentCard(file)));
      const assets = event.assets?.filter(asset => asset.mimeType === 'image/webp').slice(0, 4) ?? [];
      if (event.attachments?.length || assets.length) box.append(attachments);
      // Native ChatGPT can prepend a blank paragraph. Ignore it only when a
      // complete instruction frame validates; keep the authored suffix exact.
      const userText = event.authoredText ?? userPromptText(event.message.text.trimStart()) ?? event.message.text;
      if (userText) box.append(textBlock('msg user-message-text', userText, event.authoredText === undefined && event.message.truncated, event.authoredText?.length ?? event.message.chars));
      paintMessageReaction(box, event.reaction);
      if (event.inputDelivery) {
        box.classList.add('has-input-receipt');
        const receipt = el('span', 'input-receipt');
        const label = event.inputDelivery === 'offered' ? t("Sent to the active turn · awaiting receipt") : t("Delivery confirmed");
        receipt.title = label; receipt.setAttribute('aria-label', label);
        receipt.append(icon(event.inputDelivery === 'offered' ? 'i-clock' : 'i-check'));
        box.append(receipt);
      }
      if (assets.length && (context?.id || selectedId)) {
        const id = context?.id ?? selectedId!, generation = selectionGeneration;
        void (async () => {
          for (const asset of assets) {
            const data = await run(api.getSessionImage(id, asset.id));
            if (context ? !context.current() : id !== selectedId || generation !== selectionGeneration) return;
            if (!data) { attachments.append(el('p', 'meta', () => t("Image unavailable"))); continue; }
            const image = document.createElement('img');
            image.src = data; image.alt = t("User attachment"); image.loading = 'lazy';
            attachments.append(image);
          }
        })();
      }
      return box;
    }
    case 'assistant_message': {
      const box = el('div', 'said');
      box.append(el('b', '', () => event.final ? 'ChatGPT' : t("ChatGPT (partial)")));
      box.append(renderedMarkdown(event.message.text, event.renderedHtml));
      return box;
    }
    case 'progress':
      return el('p', 'meta is-progress', event.message.text);
    case 'page_tool': {
      const line = el('p', 'meta is-progress thinking-line');
      line.append(icon('i-globe', 'ico thinking-ico'), el('span', '', event.label));
      return line;
    }
    case 'turn_start':
      return el('p', 'meta', () => event.detail ? t("Turn reopened — {0}", [event.detail]) : t("Turn started"));
    case 'turn_end': {
      if (stoppedTurnEnd(event, context?.history ?? events)) {
        const line = el('p', 'meta is-progress thinking-line turn-stopped');
        line.append(icon('i-pause', 'ico thinking-ico'), el('span', '', () => t('Stopped. ChatGPT no longer shows this turn running.')));
        return line;
      }
      const line = el(
        'p',
        event.outcome === 'completed' ? 'meta' : 'meta is-warn',
        () => t("Turn {0}{1}", [t(TURN_OUTCOME_LABELS[event.outcome]), event.detail ? ` — ${event.detail}` : ''])
      );
      return line;
    }
    case 'chat_error': {
      // Provider errors are state, not conversation content. Collapse every visible error
      // occurrence into one inert glyph so the timeline wheel always moves through authored
      // messages instead of a wall of repeated notices. The durable recording is untouched.
      const grouped = chatErrors.length ? chatErrors : [event];
      const notice = el('span', 'chat-error-compact');
      notice.setAttribute('role', 'status');
      const presentation = () => chatErrorPresentation(event, context?.history ?? events);
      notice.append(icon('i-warning'));
      ui(notice, 'aria-label', () => t(grouped.length === 1 ? '1 ChatGPT problem notice collapsed' : '{0} ChatGPT problem notices collapsed', [grouped.length]));
      ui(notice, 'title', () => `${grouped.length} ${grouped.length === 1 ? 'problem notice' : 'problem notices'} collapsed · ${presentation().title}\n${presentation().next}`);
      return notice;
    }
    case 'tool_call':
      return toolBody(event, context);
    case 'note':
      return el('p', 'meta', event.message.text);
    /**
     * Rendered rather than left to fall through to "Unknown event".
     *
     * The timeline is how the user checks what the agents actually said to each other, and
     * a run of grey "Unknown event" rows in the middle of a multi-agent session reads as a
     * broken log — the one impression a session recorder cannot afford to give.
     */
    case 'agent_message': {
      const box = document.createElement('details');
      box.className = 'agent-communication';
      // Which end of the message this record is. The same message is written once here and
      // once in the other agent's session, so without this a pair reads as two messages.
      ui(box, 'title', () => event.delivery === 'sent'
          ? t("Sent by {0}; recorded when the app accepted it", [event.from])
          : t("Received by {0}; recorded when it acknowledged delivery", [event.to]));
      const summary = el('summary');
      const worker = event.from === 'prime' ? event.to : event.from;
      const avatar = el('span', 'agent-avatar', worker.replace(/^worker-/, ''));
      avatar.dataset.color = String([...worker].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6);
      avatar.setAttribute('aria-hidden', 'true');
      summary.append(avatar, el('span', '', () => communicationTitle(event)));
      const communicationKey = `agent:${context?.id ?? selectedId}:${event.seq}`;
      box.open = openTools.has(communicationKey);
      box.addEventListener('toggle', () => { if (box.open) openTools.add(communicationKey); else openTools.delete(communicationKey); });
      box.append(summary);
      box.append(textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
      if (!context) {
        const matches = sessions.filter(entry => entry.origin?.kind === 'worker' && entry.origin.fromSessionId === selectedId && entry.origin.agentId === worker);
        if (matches.length === 1) {
          const open = el('button', 'btn agent-chat-open'); open.setAttribute('type', 'button');
          ui(open, 'aria-label', () => t("Open {0} chat", [worker]));
          const arrow = icon('i-out'); arrow.setAttribute('aria-hidden', 'true');
          open.append(el('span', '', () => t("Open worker chat")), arrow);
          open.onclick = () => void agentPanel?.open(matches[0]!.id); box.append(open);
        }
      }
      return box;
    }
    case 'handoff':
      return el(
        'p',
        'meta is-good',
        () => t("Handoff saved — {0} characters ({1})", [compactNumber(event.chars), event.reason])
      );
    default:
      return el('p', 'meta', () => t("Unknown event"));
  }
}

/** Only the last exact-turn boundary after its work may describe that recorded turn as stopped. */
function stoppedTurnEnd(event: SessionEvent, history: readonly SessionEvent[]): boolean {
  if (event.kind !== 'turn_end' || event.outcome !== 'stopped' || !event.turnId) return false;
  return !history.some(later => later.seq > event.seq && later.turnId === event.turnId &&
    ['turn_start', 'turn_end', 'tool_call', 'page_tool'].includes(later.kind));
}

function eventRow(
  event: SessionEvent,
  chatErrors: readonly Extract<SessionEvent, { kind: 'chat_error' }>[] = []
): HTMLElement {
  const row = el('div', `ev ev-${event.kind}`);
  if (event.kind === 'assistant_message' && !withoutMessageReaction(event.message.text).trim()) row.hidden = true;
  const time = document.createElement('time');
  time.textContent = clockTime(event.time);
  time.dateTime = new Date(event.time).toISOString();
  time.title = new Date(event.time).toLocaleString(currentLanguage());
  const body = el('div', 'ev-body');
  const currentWorker = sessions.find(session => session.id === selectedId)?.origin;
  if (event.agent && event.agent !== 'prime' && !(currentWorker?.kind === 'worker' && currentWorker.agentId === event.agent)) {
    body.append(el('span', 'chip', event.agent));
  }
  body.append(eventBody(event, undefined, chatErrors));
  // A refused call from a chat Compact & Resume already replaced is not a placement failure:
  // its request id proved exactly which chat it came from, and that chat's stopped turn simply
  // kept calling from OpenAI's side. Say so beside the row, or a full Unattributed bucket of
  // these reads as the attribution chain having broken.
  if (event.kind === 'tool_call' && event.call.attributionMethod === 'superseded') {
    body.append(
      el(
        'p',
        'meta',
        () => t("From a chat that Compact & Resume had already replaced — ChatGPT kept running its stopped turn there. Refused by design; nothing to repair.")
      )
    );
  }
  row.append(time, body);
  return row;
}

/**
 * The agent chips above the timeline.
 *
 * Drawn only when this session actually has more than one attribution in it, so a
 * single-agent session — which is every session unless multi-agent mode is running —
 * keeps exactly the view it had before.
 */
function paintAgentFilter(): void {
  const box = $('chatAgentFilter');
  if (!deps.state()?.config.ui.developerMode) { box.hidden = true; agentFilter = null; return; }
  const named = [...new Set(events.flatMap((event) => (event.agent ? [event.agent] : [])))].sort();
  const anyUnattributed = events.some((event) => !event.agent);
  // A filter belongs to the session it was chosen in. Carrying it across a selection
  // change showed the next session's timeline as empty with no chip lit to explain why —
  // and agent ids repeat between runs, so it could also silently hide half of one. The
  // same guard catches an agent that simply is not in this session's events.
  if (filterFor !== selectedId) {
    agentFilter = null;
    filterFor = selectedId;
  } else if (agentFilter !== null && agentFilter !== UNATTRIBUTED && !named.includes(agentFilter)) {
    agentFilter = null;
  }
  if (named.length === 0 || (named.length === 1 && !anyUnattributed)) {
    box.hidden = true;
    box.replaceChildren();
    agentFilter = null;
    return;
  }
  const buttons: HTMLElement[] = [];
  const chip = (value: string | null, label: string): HTMLElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.agent = value ?? '';
    if (agentFilter === value) button.classList.add('is-sel');
    return button;
  };
  buttons.push(chip(null, t("All")));
  for (const agent of named) buttons.push(chip(agent, agent));
  if (anyUnattributed) buttons.push(chip(UNATTRIBUTED, t("Unattributed")));
  box.replaceChildren(...buttons);
  box.hidden = false;
}

function filteredEvents(): SessionEvent[] {
  if (agentFilter === null) return events;
  if (agentFilter === UNATTRIBUTED) return events.filter((event) => !event.agent);
  return events.filter((event) => event.agent === agentFilter);
}

/** All provider errors are one presentation row; their exact records stay on disk. */
function visibleEvents(): SessionEvent[] {
  const source = filteredEvents();
  const representative = source.findLast(event => event.kind === 'chat_error')?.seq;
  return source.filter(event => event.kind !== 'chat_error' || event.seq === representative);
}

function eventTextCost(event: SessionEvent): number {
  switch (event.kind) {
    case 'user_message':
    case 'assistant_message':
      return event.message.text.length + (event.kind === 'assistant_message' ? (event.renderedHtml?.text.length ?? 0) : 0);
    case 'progress':
    case 'chat_error':
    case 'note':
    case 'agent_message':
      return event.message.text.length;
    case 'tool_call':
      return (
        event.call.args.text.length +
        event.call.result.text.length +
        event.call.summary.title.length +
        (event.call.summary.detail?.length ?? 0)
      );
    case 'page_tool':
      return event.label.length;
    case 'turn_end':
      return event.detail?.length ?? 0;
    default:
      return 128;
  }
}

/** Eviction follows the measured reader viewport, not an arbitrary half-page.
 * Keep the current visible rows plus the incoming stage; ordinary tall histories
 * still settle at 160 records. Dense collapsed activity has bounded extra room. */
function retainTimelinePage(source: SessionEvent[], direction: 'older' | 'newer'): SessionEvent[] {
  const pane = $('chatBody');
  const edge = pane.getBoundingClientRect().top;
  const protectedKeys = new Set<string>();
  for (const row of $('timeline').querySelectorAll<HTMLElement>('[data-timeline-key]')) {
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= edge - pane.clientHeight) continue;
    if (rect.top >= edge + 2 * pane.clientHeight) break;
    protectedKeys.add(row.dataset.timelineKey!);
    if (row.matches('.tool-group:not([open])')) {
      for (const child of row.querySelectorAll<HTMLElement>('[data-timeline-key]')) protectedKeys.add(child.dataset.timelineKey!);
    }
  }
  const protectedSeqs = new Set<number>();
  for (const item of timelineItems(source)) {
    if (item.kind !== 'compaction' || !protectedKeys.has(itemKey(item))) continue;
    const block = item.block;
    protectedSeqs.add(block.seq);
    for (const event of [block.prompt, block.brief, block.end, block.handoff, block.resume, ...block.notes]) {
      if (event) protectedSeqs.add(event.seq);
    }
  }
  const protectedIndexes = source.flatMap((event, index) => protectedSeqs.has(event.seq) || protectedKeys.has(itemKey({ kind: 'event', event })) ? [index] : []);
  const first = protectedIndexes[0] ?? source.length;
  const last = protectedIndexes.at(-1) ?? -1;
  if (direction === 'older') {
    const end = Math.min(source.length, Math.max(MAX_TIMELINE_ROWS, last + 1));
    return source.slice(0, Math.min(end, MAX_TIMELINE_RESIDENT_ROWS));
  }
  const start = Math.max(0, Math.min(source.length - MAX_TIMELINE_ROWS, first));
  return source.slice(Math.max(start, source.length - MAX_TIMELINE_RESIDENT_ROWS));
}

/** Newest-first selection, returned chronologically, under resident and text/HTML budgets. */
function boundedTimeline(source: SessionEvent[]): { shown: SessionEvent[]; omitted: number } {
  let chars = 0;
  let start = source.length;
  while (start > 0 && source.length - start < MAX_TIMELINE_RESIDENT_ROWS) {
    const next = source[start - 1]!;
    const cost = Math.min(eventTextCost(next), MAX_TIMELINE_TEXT_CHARS);
    if (start < source.length && chars + cost > MAX_TIMELINE_TEXT_CHARS) break;
    chars += cost;
    start -= 1;
  }
  return { shown: foldAgentCommunication(source.slice(start)), omitted: start };
}

// ------------------------------------------------------------ compaction rows

/**
 * One Compact & Resume, folded out of the rows the recorder wrote for it.
 *
 * The recorder stores a compaction as it happened: the brief request typed into chat A, the
 * brief ChatGPT answered with, the app's own "handoff saved" line, and the bootstrap typed
 * into chat B — four rows, three of them long, in an order that reflects when each was
 * observed rather than what they were. Read as a timeline they look like three separate
 * things going on; they are one thing with three steps, and this is that thing.
 */
interface CompactionBlock {
  token: string;
  /** The row this card takes the place of. */
  seq: number;
  time: number;
  prompt: Extract<SessionEvent, { kind: 'user_message' }> | null;
  /**
   * The turn ChatGPT answered the brief request in. The request is typed by the app, so its
   * row carries no local turn id of its own; the turn is the one that opens right after it.
   */
  turnId: string | null;
  brief: Extract<SessionEvent, { kind: 'assistant_message' }> | null;
  end: Extract<SessionEvent, { kind: 'turn_end' }> | null;
  handoff: Extract<SessionEvent, { kind: 'handoff' }> | null;
  resume: Extract<SessionEvent, { kind: 'user_message' }> | null;
  /** What the app said about this compaction, newest last — an abandonment and why. */
  notes: Array<Extract<SessionEvent, { kind: 'note' }>>;
}

type TimelineItem = { kind: 'event'; event: SessionEvent } | { kind: 'compaction'; block: CompactionBlock };

function continuationMarker(event: SessionEvent): { kind: 'HANDOFF' | 'RESUME'; token: string } | null {
  if (event.kind !== 'user_message') return null;
  const match = nativeContinuationMarker(event.message.text);
  return match ? { kind: match[1] as 'HANDOFF' | 'RESUME', token: match[2]! } : null;
}

/**
 * The timeline with each compaction folded into one item.
 *
 * A card opens at the marked brief request and absorbs what belongs to it: the turn
 * that answers it, the answer (the brief), the app's
 * handoff line. The marked bootstrap in the replacement chat closes the same card by token,
 * wherever it lands, and so does an app note naming the token. A bootstrap whose request has
 * scrolled out of the window still gets a card, with the steps it implies already done.
 *
 * Which turn answers the request is read from the log, not from the request row. The
 * request is typed by the app into the chat, so the extension records it with no local turn
 * id (or, on a reload, with the previous turn's); the generation ChatGPT opens for it is the
 * first `turn_start` after it. Keying on the request's own `turnId` left that start, the
 * brief, the end and the handoff as four loose rows under an empty card — the live shape.
 */
function timelineItems(source: SessionEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const blocks = new Map<string, CompactionBlock>();
  let open: CompactionBlock | null = null;
  const blockFor = (token: string, event: SessionEvent): CompactionBlock => {
    let block = blocks.get(token);
    if (!block) {
      block = {
        token,
        seq: event.seq,
        time: event.time,
        prompt: null,
        turnId: null,
        brief: null,
        end: null,
        handoff: null,
        resume: null,
        notes: []
      };
      blocks.set(token, block);
      items.push({ kind: 'compaction', block });
    }
    return block;
  };
  for (const event of source) {
    const marker = continuationMarker(event);
    if (marker && event.kind === 'user_message') {
      const block = blockFor(marker.token, event);
      if (marker.kind === 'HANDOFF') {
        block.prompt = event;
        block.turnId = event.turnId ?? null;
        open = block;
        // Chronology puts a turn's start before the message that opened it, so the request
        // turn's own start row is already on the list; it belongs to the card like the rest.
        const previous = items[items.length - 2];
        if (
          previous?.kind === 'event' &&
          previous.event.kind === 'turn_start' &&
          event.turnId !== undefined &&
          previous.event.turnId === event.turnId
        ) {
          items.splice(items.length - 2, 1);
        }
      } else {
        block.resume = event;
        if (open === block) open = null;
      }
      continue;
    }
    if (event.kind === 'note' && event.continuation) {
      const block = blockFor(event.continuation, event);
      block.notes.push(event);
      if (open === block) open = null;
      continue;
    }
    if (open) {
      if (event.kind === 'handoff') {
        open.handoff = event;
        continue;
      }
      if (event.kind === 'assistant_message') {
        if (open.turnId && event.turnId && event.turnId !== open.turnId) {
          items.push({ kind: 'event', event });
          continue;
        }
        open.brief = event;
        if (event.turnId !== undefined) open.turnId = event.turnId;
        continue;
      }
      if (event.kind === 'turn_start' && !open.brief && !open.handoff && !open.end) {
        open.turnId = event.turnId ?? null;
        continue;
      }
      const sameTurn = open.turnId !== null && event.turnId === open.turnId;
      if (sameTurn && (event.kind === 'turn_end' || event.kind === 'progress' || event.kind === 'page_tool')) {
        if (event.kind === 'turn_end') open.end = event;
        continue;
      }
      // Local calls can finish or be refused after the source request. They remain
      // ordinary visible rows and cannot close the summary's grouping or decide its fate.
      // Only another authored user message starts an unrelated conversation step.
      if (event.kind === 'user_message') open = null;
    }
    items.push({ kind: 'event', event });
  }
  return items;
}

type CompactionTone = 'good' | 'wait' | 'bad';

const ABANDONED_NOTE = /^Compact & Resume abandoned\s*[\u2014-]\s*/i;

/**
 * One sentence for where the compaction is, or where it died.
 *
 * Success and failure come from the recorded continuation, never from later activity
 * in this timeline. Refused source calls are compatible with a still-running handoff.
 */
function compactionState(block: CompactionBlock): { text: string; tone: CompactionTone } {
  const chars = block.handoff ? t(" ({0} characters)", [compactNumber(block.handoff.chars)]) : '';
  if (block.resume) return { text: t("New chat opened at {0}{1}", [clockTime(block.resume.time), chars]), tone: 'good' };
  const abandoned = [...block.notes].reverse().find((note) => ABANDONED_NOTE.test(note.message.text));
  if (abandoned) return { text: t("Failed — {0}", [abandoned.message.text.replace(ABANDONED_NOTE, '')]), tone: 'bad' };
  if (block.handoff) {
    return { text: t("Summary saved{0} — opening the new chat…", [chars]), tone: 'wait' };
  }
  if (block.end && block.end.outcome !== 'completed') {
    const status = block.end.outcome === 'stopped' ? t("Summary generation stopped")
      : block.end.outcome === 'failed' ? t("Summary generation failed")
      : t("Summary generation ended without a completed handoff");
    return { text: block.end.detail ? t("{0} — {1}", [status, block.end.detail]) : status, tone: 'bad' };
  }
  if (block.brief?.final) {
    return { text: t("Summary written — saving the handoff…"), tone: 'wait' };
  }
  if (block.brief) return { text: t("ChatGPT is writing the summary…"), tone: 'wait' };
  return { text: t("Summary requested — waiting for ChatGPT…"), tone: 'wait' };
}

function compactionRow(block: CompactionBlock, previous?: HTMLElement): HTMLElement {
  const key = `compaction:${block.token}`;
  const state = compactionState(block);

  const row = previous ?? el('div', 'ev ev-compaction');
  const box = previous?.querySelector<HTMLDetailsElement>('details.compaction') ?? document.createElement('details');
  box.className = `tool compaction tone-${state.tone}`;
  if (!previous) {
    box.open = openTools.has(key);
    box.addEventListener('toggle', () => {
      if (box.open) openTools.add(key);
      else openTools.delete(key);
    });
  }

  if (!previous) {
    const head = document.createElement('summary');
    head.append(icon('i-steps', 'ico tool-ico'));
    head.append(el('b', '', () => t("Compact & Resume:")));
    head.append(el('span', 'state'));
    box.append(head);
  }
  ui(box.querySelector<HTMLElement>('summary .state')!, 'textContent', () => compactionState(block).text);

  const raw = el('div', 'raw');
  if (block.prompt) {
    raw.append(el('h4', '', () => t("Brief request")));
    // The routing marker is the app's, not the user's; the card already says what this is.
    const request = recordedOperatorPromptBody(userPromptText(block.prompt.message.text) ?? block.prompt.message.text).replace(CONTINUATION_MARKER, '');
    raw.append(textBlock('pre', request, block.prompt.message.truncated, block.prompt.message.chars));
  }
  if (block.brief) {
    const brief = block.brief;
    raw.append(el('h4', '', () => brief.final ? t("Summary") : t("Summary (still writing)")));
    raw.append(renderedMarkdown(block.brief.message.text));
  }
  if (block.handoff) {
    const saved = block.handoff;
    raw.append(
      el('p', 'raw-facts', () => t("Handoff saved — {0} characters ({1})", [compactNumber(saved.chars), saved.reason]))
    );
  }
  if (block.resume) {
    const resumed = block.resume;
    raw.append(
      el(
        'p',
        'raw-facts',
        () => t("Bootstrap sent into the new chat — {0} characters at {1}", [compactNumber(resumed.message.chars), clockTime(resumed.time)])
      )
    );
  }
  for (const note of block.notes) raw.append(el('p', 'raw-facts', `${clockTime(note.time)} — ${note.message.text}`));
  const oldRaw = box.querySelector<HTMLElement>('.raw');
  if (oldRaw) {
    // Streaming changes only the affected section. Keep the disclosure, focus and
    // unchanged request mounted instead of replacing the whole reading surface.
    const oldParts = [...oldRaw.children];
    reconcileChildren(oldRaw, [...raw.children].map((part, index) =>
      (oldParts[index]?.isEqualNode(part) ? oldParts[index] : part) as HTMLElement));
  } else box.append(raw);

  if (previous) return row;
  const time = document.createElement('time');
  time.textContent = clockTime(block.time);
  time.title = new Date(block.time).toLocaleString(currentLanguage());
  const body = el('div', 'ev-body');
  body.append(box);
  row.append(time, body);
  return row;
}

/** What a row was drawn from; a different signature is a different row. */
function itemSignature(item: TimelineItem): string {
  if (item.kind === 'compaction') {
    const { block } = item;
    return [
      block.token,
      block.prompt?.seq ?? '',
      block.brief ? `${block.brief.seq}:${block.brief.message.chars}:${block.brief.renderedHtml?.chars ?? 0}:${block.brief.state}` : '',
      block.end ? `${block.end.seq}:${block.end.outcome}:${block.end.detail ?? ''}` : '',
      block.handoff?.seq ?? '',
      block.resume?.seq ?? '',
      block.notes.map((note) => note.seq).join(',')
    ].join('|');
  }
  const { event } = item;
  const parts: Array<string | number> = [event.kind === 'user_message' ? '' : event.seq, event.time, event.kind, event.agent ?? ''];
  switch (event.kind) {
    case 'user_message': {
      // A badge-only revision patches the existing bubble, preserving loaded images
      // and selection. Every other recorded field still invalidates its body.
      const { seq: _seq, reaction: _reaction, ...body } = event;
      parts.push(JSON.stringify(body));
      break;
    }
    case 'progress':
    case 'chat_error':
    case 'note':
    case 'agent_message':
      parts.push(event.message.chars);
      break;
    case 'assistant_message':
      parts.push(event.message.chars, event.renderedHtml?.chars ?? 0, event.state ?? '', event.final ? 'final' : '');
      break;
    case 'tool_call':
      parts.push(
        event.call.outcome,
        event.call.attribution,
        event.call.durationMs,
        event.call.args.chars,
        event.call.result.chars,
        event.call.summary.title,
        event.call.summary.detail ?? ''
      );
      break;
    case 'page_tool':
      parts.push(event.label);
      break;
    case 'turn_end':
      parts.push(event.outcome, event.detail ?? '');
      break;
    case 'handoff':
      parts.push(event.chars);
      break;
    default:
      break;
  }
  return parts.join('|');
}

function itemKey(item: TimelineItem): string {
  if (item.kind === 'compaction') return `compaction:${item.block.token}`;
  // A canonical revision advances the update cursor, not the identity of the row
  // anchoring the viewport and the following activity disclosure.
  const message = canonicalMessageKey(item.event);
  return message ? `message:${message}` : `event:${item.event.seq}`;
}

/** One activity disclosure between authored messages; communication keeps its own identity inside. */
const toolGroups = new Map<string, HTMLDetailsElement>();
/**
 * A native page note becomes a recap only when it trails real activity in the exact
 * recorded round and the next authored response is a final. A Stop, failed turn,
 * in-progress note or unrelated later question must never imply completion.
 */
function completedActivityRecapSeqs(items: TimelineItem[]): Set<number> {
  const completed = new Set<number>();
  let lastPage: Extract<SessionEvent, { kind: 'page_tool' }> | null = null;
  let hasActions = false;
  let pageIsTrailing = false;
  for (const item of items) {
    if (item.kind === 'event') {
      const event = item.event;
      if (event.kind === 'tool_call' || event.kind === 'agent_message') {
        hasActions = true;
        pageIsTrailing = false;
        continue;
      }
      if (event.kind === 'page_tool') {
        lastPage = event;
        pageIsTrailing = true;
        continue;
      }
      // The recorder can end a turn before the canonical final reaches the renderer.
      if (event.kind === 'turn_end' && event.outcome === 'completed') continue;
      if (event.kind === 'assistant_message' && event.final === true && hasActions && pageIsTrailing &&
          lastPage && (!lastPage.turnId || !event.turnId || lastPage.turnId === event.turnId)) {
        completed.add(lastPage.seq);
      }
    }
    lastPage = null;
    hasActions = false;
    pageIsTrailing = false;
  }
  return completed;
}
/** Keep retained scroll containers mounted: rebuilding a feed must not restart
 * disclosure animations or detach a result while the user is scrolling it. */
function reconcileChildren(parent: Element, children: HTMLElement[]): void {
  const keep = new Set<Node>(children);
  for (const old of [...parent.childNodes]) if (!keep.has(old)) old.remove();
  let cursor = parent.firstChild;
  for (const child of children) {
    if (child !== cursor) parent.insertBefore(child, cursor);
    cursor = child.nextSibling;
  }
}
function groupToolRows(rows: HTMLElement[], scope = selectedId, groups = toolGroups): HTMLElement[] {
  const grouped: HTMLElement[] = [], retained = new Set<string>();
  for (let i = 0; i < rows.length;) {
    if (!rows[i]!.matches('.ev-tool_call, .ev-page_tool, .ev-agent_message')) { grouped.push(rows[i++]!); continue; }
    let end = i + 1;
    while (end < rows.length && rows[end]!.matches('.ev-tool_call, .ev-page_tool, .ev-agent_message') && rows[end]!.dataset.activityBoundary === rows[i]!.dataset.activityBoundary) end++;
    if (end - i === 1) { grouped.push(rows[i++]!); continue; }
    // Paging can extend or trim the beginning of an activity group. Its first
    // member is therefore not a new disclosure/viewport identity.
    const previous = rows.slice(i, end).map(row => row.closest<HTMLElement>('.tool-group'))
      .find(group => group?.dataset.timelineKey && groups.get(group.dataset.timelineKey) === group && !retained.has(group.dataset.timelineKey));
    const key = previous?.dataset.timelineKey ?? `group:${scope}:${rows[i]!.dataset.timelineKey}`;
    retained.add(key);
    let group = groups.get(key);
    if (!group) {
      group = document.createElement('details'); group.className = 'tool-group';
      group.dataset.timelineKey = key;
      const summary = document.createElement('summary');
      summary.append(el('span', 'activity-symbol'), el('span', 'activity-title'), icon('i-chev', 'ico activity-chevron'));
      group.append(summary, el('div', 'tool-group-body'));
      group.addEventListener('toggle', () => { if (group!.open) openTools.add(key); else openTools.delete(key); });
      group.open = openTools.has(key) || rows.slice(i, end).some((row) => row.querySelector('details[open]')); groups.set(key, group);
    }
    // Streaming activity names the latest real action. After an exact final, the last
    // native page note is the round recap; retain the original activity disclosure.
    const members = rows.slice(i, end);
    const latest = [...members].reverse().find(row => row.matches('.ev-tool_call, .ev-agent_message')) ?? rows[end - 1]!;
    const latestHead = latest.querySelector('.tool > summary, .agent-communication > summary, .thinking-line');
    const closingNote = members.at(-1)?.dataset.completedRecap === 'true' ? members.at(-1)! : null;
    const recap = closingNote?.querySelector<HTMLElement>('.thinking-line')?.textContent?.trim();
    const label = recap || latestHead?.querySelector('b, span:not(.agent-avatar)')?.textContent || t("Activity");
    group.querySelector('.activity-title')!.textContent = label;
    ui(group.querySelector('summary')!, 'title', () => t("{0} actions · {1}", [end - i - Number(!!recap), label]));
    const summary = group.querySelector('summary')!;
    if (recap) summary.setAttribute('aria-label', `${t('Completed')} · ${label}`);
    else summary.removeAttribute('aria-label');
    const symbol = recap ? icon('i-check') : latestHead?.querySelector('svg, .agent-avatar')?.cloneNode(true);
    group.querySelector('.activity-symbol')!.replaceChildren(...(symbol ? [symbol] : []));
    // The native recap is represented by the disclosure heading. Do not show the
    // same line twice; its cached event row can be restored if the turn reopens.
    reconcileChildren(group.lastElementChild!, recap ? members.filter(row => row !== closingNote) : members);
    grouped.push(group); i = end;
  }
  for (const key of groups.keys()) if (!retained.has(key)) groups.delete(key);
  return grouped;
}

function paintDetail(followBottom = historyBefore === null): void {
  paintStateLine();
  const summary = sessions.find((s) => s.id === selectedId) ?? null;
  applyComposerSessionModel(selectedId ? `${selectedId}:${selectionGeneration}` : null, summary?.selectedModel ?? null);
  const config = deps.state()?.config;
  if (config) paintContextMeter(summary, config, confirmedComposerModel());
  ui($('chatTitle'), 'textContent', () => summary ? summary.title || t("Untitled session") : t("New chat"));
  const originalTitle = summary?.originalTitle?.trim() && summary.originalTitle.trim() !== summary.title.trim()
    ? summary.originalTitle.trim()
    : '';
  ui($('chatOriginalTitle'), 'textContent', () => originalTitle);
  $('chatOriginalTitle').hidden = !originalTitle;
  const changeStats = summary ? sessionChangeStats(summary) : '';
  $('chatChangeStats').textContent = changeStats;
  $('chatChangeStats').hidden = !changeStats;
  $('chatChangeStats').title = changeStats ? 'Recorded local tool changes in this task' : '';
  $<HTMLButtonElement>('chatRename').hidden = !summary;
  const jumpStart = $<HTMLButtonElement>('chatJumpStart');
  jumpStart.hidden = !summary || totalEvents === 0;
  jumpStart.disabled = historyLoading;

  paintDeliveryControls();
  paintAgentFilter();
  const filtered = visibleEvents();
  const windowed = boundedTimeline(filtered);
  const shown = windowed.shown;

  // Preserve the visible logical row when late transcript revisions change the
  // height above it; retaining absolute scrollTop would move the reader's content.
  const pane = $('chatBody');
  const followOutput = followOutputEnabled();
  const restoreViewport = preserveTimelineViewport(
    pane,
    $('timeline'),
    followOutput && followBottom && timelineFollowBottom,
    followOutput ? timelineFollowBottom : false
  );
  const timelineRows: HTMLElement[] = [];
  if (selectedId && historyBefore !== null) {
    const navigation = el('div', 'timeline-window-note');
    const latest = el('button', 'btn small', () => t("Back to latest"));
    latest.dataset.history = 'latest';
    latest.addEventListener('click', () => void navigateHistory(null));
    navigation.append(latest);
    timelineRows.push(navigation);
  }
  const keep = new Set<string>();
  let activityBoundary = '';
  paintRecoveryStatus();
  const oldest = shown.length ? Math.min(...shown.map(event => event.time)) : 0;
  const newest = shown.length ? Math.max(...shown.map(event => event.time)) : 0;
  const retiredInputs = pendingComposerInputs.filter(entry => historicalAutomaticInput(entry) &&
    (entry.sessionId ?? entry.deliveredSessionId) === selectedId && !dismissedInputNotices.has(entry.id) &&
    agentFilter === null && entry.createdAt >= oldest && (historyBefore === null || entry.createdAt <= newest))
    .sort((a, b) => a.createdAt - b.createdAt);
  const appendRetiredInputs = (until: number) => {
    while (retiredInputs.length && retiredInputs[0]!.createdAt <= until) {
      const entry = retiredInputs.shift()!;
      const key = `retired-input:${entry.id}`;
      const sig = JSON.stringify([entry.text, entry.error, entry.createdAt]);
      keep.add(key);
      const cached = rowCache.get(key);
      const row = cached?.sig === sig ? cached.row : inputMessageRow(entry, true);
      if (row !== cached?.row) {
        const time = document.createElement('time');
        time.textContent = new Date(entry.createdAt).toLocaleString(currentLanguage());
        row.prepend(time);
      }
      row.dataset.timelineKey = key;
      rowCache.set(key, { sig, row });
      timelineRows.push(row);
      activityBoundary = key;
    }
  };
  const items = timelineItems(shown);
  const completedRecaps = completedActivityRecapSeqs(items);
  const chatErrors = filteredEvents().filter(
    (event): event is Extract<SessionEvent, { kind: 'chat_error' }> => event.kind === 'chat_error'
  );
  for (const item of items) {
    appendRetiredInputs(item.kind === 'event' ? item.event.time : item.block.time);
    if (item.kind === 'compaction' || !['tool_call', 'page_tool', 'agent_message'].includes(item.event.kind)) activityBoundary = itemKey(item);
    if (!deps.state()?.config.ui.developerMode && item.kind === 'event' && item.event.source === 'app' && item.event.kind === 'progress' && item.event.progressId?.startsWith('browser-repair:')) continue;
    if (!deps.state()?.config.ui.developerMode && item.kind === 'event' && ['session_start', 'session_end', 'turn_start', 'turn_end', 'note'].includes(item.event.kind) &&
        !stoppedTurnEnd(item.event, events)) continue;
    const key = itemKey(item);
    const sig = itemSignature(item) + (item.kind === 'event' && item.event.kind === 'chat_error'
      ? JSON.stringify(chatErrorPresentation(item.event, events)) +
        `|collapsed:${chatErrors.map(error => error.seq).join(',')}`
      : '') + (item.kind === 'event' && stoppedTurnEnd(item.event, events) ? '|stopped' : '');
    keep.add(key);
    const cached = rowCache.get(key);
    if (cached && cached.sig === sig) {
      cached.row.dataset.activityBoundary = activityBoundary;
      if (item.kind === 'event') {
        cached.row.dataset.eventSeq = String(item.event.seq);
        if (item.event.kind === 'page_tool') cached.row.dataset.completedRecap = String(completedRecaps.has(item.event.seq));
      }
      if (item.kind === 'event' && item.event.kind === 'user_message') {
        paintMessageReaction(cached.row.querySelector<HTMLElement>('.said.is-user')!, item.event.reaction);
      }
      paintInputReceipt(cached.row, item);
      timelineRows.push(cached.row);
      continue;
    }
    const row = item.kind === 'compaction'
      ? compactionRow(item.block, cached?.row)
      : eventRow(item.event, item.event.kind === 'chat_error' ? chatErrors : []);
    row.dataset.timelineKey = key;
    row.dataset.activityBoundary = activityBoundary;
    if (item.kind === 'event') {
      row.dataset.eventSeq = String(item.event.seq);
      if (item.event.kind === 'page_tool') row.dataset.completedRecap = String(completedRecaps.has(item.event.seq));
    }
    paintInputReceipt(row, item);
    rowCache.set(key, { sig, row });
    timelineRows.push(row);
  }
  appendRetiredInputs(Infinity);
  for (const key of rowCache.keys()) if (!keep.has(key)) rowCache.delete(key);
  reconcileChildren($('timeline'), groupToolRows(timelineRows));
  $('timelineEmpty').hidden = timelineRows.length > 0 || $('inputQueue').childElementCount > 0;
  restoreViewport();
  paintProgressInbox();

  const facts: string[] = [];
  if (summary) {
    facts.push(t(totalEvents === 1 ? '{0} event' : '{0} events', [totalEvents]));
    if (events.length < totalEvents) facts.push(t("showing a bounded page of {0}", [events.length]));
    if (agentFilter !== null) {
      facts.push(t("filtered to {0} — {1} matched", [agentFilter === UNATTRIBUTED ? 'unattributed' : agentFilter, filtered.length]));
    }
    if (windowed.omitted > 0) facts.push(t("{0} newest rendered", [shown.length]));
    facts.push(t("~{0} rough current-chat context tokens", [compactNumber(summary.contextTokens)]));
    const level = pressureOf(summary.id);
    if (level && level.level !== 'ok') {
      facts.push(
        level.level === 'huge'
          ? t("past the compaction threshold — compact before continuing")
          : t("large — compaction is worth doing soon")
      );
    }
    if (summary.lastTurnOutcome && summary.lastTurnOutcome !== 'completed') {
      facts.push(t("last turn {0}", [t(TURN_OUTCOME_LABELS[summary.lastTurnOutcome])]));
    }
  }
  $('chatFoot').textContent = facts.join(' · ');
  $('chatFoot').hidden = !deps.state()?.config.ui.developerMode;
  $('chatFoot').classList.toggle('is-warn', pressureOf(selectedId ?? '')?.level === 'huge');
}

// -------------------------------------------------------------------- handoff

/**
 * The brief the last compaction of this session left behind.
 *
 * A record, not a control. The compaction itself happens in the ChatGPT conversation — the
 * chat writes its own brief as its final answer — so what is worth showing here is the
 * document that came out of it, and any warning attached to it.
 */
function paintHandoff(): void {
  const hand = $('handoffBox');
  if (handoff) {
    const saved = handoff;
    const parts: HTMLElement[] = [];
    const head = el('p', 'hint');
    ui(head, 'textContent', () => t("{0} characters · from {1} events (~{2} tokens) · {3}", [compactNumber(saved.text.length), saved.sourceEvents, compactNumber(saved.sourceTokens), ago(saved.createdAt)]));
    parts.push(head);
    for (const note of handoff.notes) parts.push(el('p', 'hint is-warn', note));
    parts.push(el('pre', 'pre', handoff.text));
    hand.replaceChildren(...parts);
    $('handoffHead').hidden = false;
    $('copyHandoff').hidden = false;
  } else {
    hand.replaceChildren();
    $('handoffHead').hidden = true;
    $('copyHandoff').hidden = true;
  }
  paintStateLine();
}

/** The live deadline takes precedence over the existing dismissible repair receipt. */
function paintRecoveryStatus(): boolean {
  const host = $('recoveryStatus');
  const countdowns = selectedControlsMatchCurrentBinding() ? controlledRecovery : [];
  if (renderRecoveryCountdowns(host, countdowns)) return true;
  const recovery = detailFor === selectedId ? [...events].reverse().find(event => event.source === 'app' && event.kind === 'progress' && event.progressId?.startsWith('browser-repair:')) : undefined;
  const sessionId = selectedId;
  const revision = recovery?.kind === 'progress' ? JSON.stringify([recovery.progressId, recovery.time, recovery.message.text]) : '';
  // A newer native question or distinct turn proves that the repair receipt is historical.
  // Removing the live Continue countdown must not make the old reload notice reappear.
  const advanced = recovery && events.some(event => positionOf(event) > positionOf(recovery) &&
    ((event.kind === 'turn_start' && event.turnId !== recovery.turnId) ||
      (event.kind === 'user_message' && event.source === 'extension')));
  host.hidden = !recovery || !!advanced || Date.now() - recovery.time > 120000 || (!!sessionId && dismissedRecoveryNotices.get(sessionId) === revision);
  host.replaceChildren();
  if (!host.hidden && recovery?.kind === 'progress') {
    const row = el('div', 'recovery-notice');
    row.append(icon('i-pulse'), el('span', 'queue-label', recovery.message.text),
      dockAction(() => t('Dismiss recovery notice'), 'i-x', () => {
        if (sessionId) dismissedRecoveryNotices.set(sessionId, revision);
        host.hidden = true; host.replaceChildren();
      }));
    host.append(row);
  }
  return false;
}

/** One line under the header saying what is happening right now. */
function paintStateLine(): void {
  window.clearTimeout(durationTimer);
  durationTimer = undefined;
  const note = $('chatState');
  const { tone, working, ticking, description } = stateLine();
  // Preserve the existing locale binding: a later language change must
  // recompute this evidence-backed status rather than replay frozen English.
  ui(note, 'textContent', () => stateLine().text);
  note.className = `subhead-note${tone ? ` ${tone}` : ''}`;
  // Running state and timer ownership cannot depend on a translated label.
  note.classList.toggle('is-working', working === true);
  // The narrow inline label may be visually clipped. Keep its full status and next
  // action readable while avoiding an aria-live timer that announces every second.
  if (description) {
    ui(note, 'title', () => stateLine().description ?? '');
    ui(note, 'aria-label', () => stateLine().description ?? '');
  } else {
    note.removeAttribute('title');
    note.removeAttribute('aria-label');
  }
  const recovering = paintRecoveryStatus();
  const goalWaiting = selectedControlsMatchCurrentBinding() && !!goalWaitView;
  const goalRunning = selectedControlsMatchCurrentBinding() &&
    [goalDraftView, finishGoalDraftView].some(draft => !!draft?.stageStartedAt && ['sending', 'answering'].includes(draft.stage));
  if (goalWaiting || goalRunning) paintGoalProgress();
  if (visible && (ticking || recovering || goalWaiting || goalRunning)) durationTimer = window.setTimeout(paintStateLine, 1000);
  repaintBadges();
}

/**
 * Redraws the list when a row's badges would change, and not otherwise.
 *
 * The badges follow live state, which changes as fast as the recorder writes. Rebuilding
 * every row for each of those would be a list that flickers while it is being read, so the
 * redraw is keyed on the badges themselves.
 */
function repaintBadges(): void {
  const key = badgeSignature();
  if (key === badgeKey) return;
  paintSessions();
}

function badgeSignature(): string {
  return sessions.map((entry) => sessionBadges(entry, automationForSummary(entry) ?? undefined)
    .map((badge) => badge.text).join(',')).join('|');
}

/** Recent exact tool activity can prove work even when the ChatGPT page missed its turn. */
const BLIND_CAPTION_MS = 90_000;

function stateLine(): { text: string; tone: '' | 'is-live' | 'is-bad' | 'is-unknown' | 'is-paused'; working?: boolean; ticking?: boolean; description?: string } {
  if (!deps.state()?.config.ui.developerMode) {
    const summary = sessions.find(entry => entry.id === selectedId);
    if (!summary || detailFor !== selectedId) return { text: '', tone: '' };
    // Main's exact-session automation state is also the status authority for the
    // sidebar and Work & updates. The page's older open-turn or tool grant must
    // not make a paused, provider-held or waiting Goal look like live generation.
    const automation = automationForSummary(summary);
    if (automation && inspectedWorkModeOff(automation, summary)) {
      const detail = inspectedOffDetail(automation, summary);
      return { text: inspectedOffLabel(summary), description: detail, tone: 'is-paused' };
    }
    if (automation && (automation.state !== 'working' || automation.pause?.phase === 'draining')) {
      const label = t(automationStateLabel(automation));
      const reason = automation.reason.trim();
      const next = automation.nextAction.trim();
      const description = [label, reason, next ? `Next: ${next}` : ''].filter(Boolean).join(' · ');
      return {
        text: [label, reason].filter(Boolean).join(' · '),
        description,
        tone: automationStatusUnknown(automation) ? 'is-unknown' :
          automation.state === 'blocked' || automation.state === 'stalled' ? 'is-bad' :
          automation.state === 'paused' || automation.pause?.phase === 'draining' ? 'is-paused' : '',
        // A graceful pause can retain a truly active main turn. Keep its existing
        // positive activity signal, while naming that it is draining, not restarting.
        working: automation.pause?.phase === 'draining' && automation.spinning === true
      };
    }
    const terminal = ordinaryTerminalOutcome(summary);
    if (!automation && terminal) {
      const label = `Last turn ${t(TURN_OUTCOME_LABELS[terminal])}`;
      const description = `${label}; no current execution is proven. Inspect the saved result before continuing.`;
      return {
        text: description, description,
        tone: terminal === 'failed' || terminal === 'stalled' || terminal === 'interrupted' ? 'is-bad' :
          terminal === 'unknown' ? 'is-unknown' : terminal === 'stopped' ? 'is-paused' : ''
      };
    }
    const active = selectedControlsMatchCurrentBinding() ? controlledTurnId : null;
    // Recorder sequence owns the boundary, including a reopen of the same turn.
    // Arrival order and an earlier end cannot certify that reopened work as finished.
    const latestBoundary = (id?: string): SessionEvent | undefined =>
      events.reduce<SessionEvent | undefined>((best, event) =>
        (event.kind === 'turn_start' || event.kind === 'turn_end') &&
        (id === undefined || event.turnId === id) &&
        (!best || event.seq > best.seq) ? event : best, undefined);
    const lastBoundary = latestBoundary();
    // lastToolCallAt is request-id-attributed to this exact conversation. It is a more honest
    // display witness than a stale/missing page turn, but it does not invent a stoppable turn.
    // Recent tool activity only proves unfinished work when it is newer than the page's latest
    // reported end. Otherwise a completed chat would keep saying "Working…" for ninety seconds.
    const reportedEnd = Math.max(lastBoundary?.kind === 'turn_end' ? lastBoundary.time : 0,
      summary.lastTurnEndAt ?? 0, summary.lastAssistantFinalAt ?? 0);
    const blind = !active && summary.lastToolCallAt !== null &&
      Date.now() - summary.lastToolCallAt < BLIND_CAPTION_MS &&
      summary.lastToolCallAt > reportedEnd
      ? { text: t("Working…"), tone: '' as const, working: true }
      : null;
    const turnId = active ?? lastBoundary?.turnId;
    if (!turnId) return blind ?? { text: '', tone: '' };
    const startedAt = summary.finishTurn?.turnId === turnId ? summary.finishTurn.startedAt
      : events.find(event => event.kind === 'turn_start' && event.turnId === turnId)?.time;
    const lastOfTurn = latestBoundary(turnId);
    const endedAt = lastOfTurn?.kind === 'turn_end' ? lastOfTurn.time : undefined;
    if (startedAt === undefined) return active
      ? { text: t("Working…"), tone: '', working: true }
      : blind ?? { text: '', tone: '' };
    if (!active && endedAt === undefined) return blind ?? { text: '', tone: '' };
    if (blind) return blind;
    const seconds = Math.max(0, Math.floor(((active ? Date.now() : endedAt!) - startedAt) / 1000));
    return { text: t("{0} for {1}{2}s", [active ? t("Working") : t("Worked"), seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : '', seconds % 60]), tone: '', working: !!active, ticking: !!active };
  }
  // Recording follows the conversation the browser can see. A tool call arrives over the
  // connector carrying nothing that identifies its caller, so work driven from the phone,
  // from another browser or from another machine can only be recorded as what it is:
  // real, complete, and not placeable in any chat this app can observe.
  const selected = sessions.find((entry) => entry.id === selectedId) ?? null;
  if (selected && selected.conversationId === null) {
    return {
      text: t("Work this app could not place in a chat — driven from another device, or with no ChatGPT tab open"),
      tone: ''
    };
  }

  const workers = swarm?.agents.filter((agent) => agent.role === 'worker') ?? [];
  if (workers.length === 0) return { text: '', tone: '' };
  const count = (state: AgentState): number => workers.filter((agent) => agent.state === state).length;
  const parts: string[] = [];
  if (count('active') > 0) parts.push(t("{0} working", [count('active')]));
  // "invited" is a worker whose ChatGPT tab has been asked for but has not joined yet.
  if (count('invited') > 0) parts.push(t("{0} opening", [count('invited')]));
  // Detached is a live worker with no tab: its turn is running on OpenAI's servers and its
  // tool calls still arrive here, so it is counted among the working rather than the lost.
  if (count('detached') > 0) parts.push(t("{0} working with no tab", [count('detached')]));
  if (count('waking') > 0) parts.push(t("{0} waking up", [count('waking')]));
  // Said as "waiting" rather than counted with the finished ones: these are the run's reusable
  // chats, and the number the user wants is how much of the run is still available to it.
  if (count('sleeping') > 0) parts.push(t("{0} sleeping", [count('sleeping')]));
  if (count('finished') > 0) parts.push(t("{0} finished", [count('finished')]));
  if (count('failed') > 0) parts.push(t("{0} failed", [count('failed')]));
  const live = count('invited') + count('active') + count('detached') + count('waking');
  return {
    text: `${workers.length === 1 ? t("1 worker") : t("{0} workers", [workers.length])} · ${parts.join(' · ')}`,
    tone: count('failed') > 0 ? 'is-bad' : live > 0 ? 'is-live' : ''
  };
}

// ----------------------------------------------------------------- settings

/**
 * Shows where the extension actually is on this machine.
 *
 * An installed build has no source tree, so "load extension/ from the repo" is advice
 * that cannot be followed. Asked once and cached, because the answer cannot change while
 * the app is running.
 */
let extensionPathShown = false;
async function showExtensionPath(): Promise<void> {
  if (extensionPathShown) return;
  extensionPathShown = true;
  const dir = await run(api.extensionPath());
  const node = $('extensionPath');
  if (dir) {
    ui(node, 'textContent', () => t("Extension folder: {0}", [dir]));
    node.classList.remove('is-warn');
  } else {
    ui(node, 'textContent', () => t("The extension folder is missing from this installation. Reinstall the app, or use the extension/ folder from a source checkout."));
    node.classList.add('is-warn');
    $<HTMLButtonElement>('bridgeFolder').disabled = true;
  }
}

function paintSwarm(state: SwarmState): void {
  swarm = state;
  paintStateLine();
  // Session rows borrow their live badge from the swarm, so a worker that just went to sleep
  // must not keep saying "active" until some unrelated session update repaints the list.
  paintSessions();
  const list = $('swarmList');
  if (state.agents.length === 0) {
    list.replaceChildren(
      el(
        'p',
        'hint',
        () => state.retainedHistory
          ? t("No workers are running. Reusable worker histories are parked and remain available to their prime chats; Clear swarm permanently removes them.")
          : t("No agents. The prime agent creates workers with the agents tool’s spawn action.")
      )
    );
  } else {
    list.replaceChildren(
      ...state.agents.map((agent) => {
        const row = el('div', 'agent');
        const top = el('div', 'model-top');
        const label = agent.label || agent.id;
        top.append(el('b', '', label));
        if (label !== agent.id) top.append(el('span', 'chip', agent.id));
        top.append(el('span', `chip is-${agent.state}`, agent.state));
        if (agent.health) {
          const healthTone = agent.health.health === 'blocked' || agent.health.health === 'stalled'
            ? 'is-failed'
            : agent.health.health === 'healthy' ? 'is-finished' : 'is-active';
          const health = el('span', `chip ${healthTone}`, agent.health.health);
          health.title = `${agent.health.activity} · ${agent.health.reason}`;
          top.append(health);
        }
        // Clearing is offered where the agent is, not only as one global reset at the
        // bottom of a settings form. The two rows mean different things and the tooltip
        // says which: the prime is the run, a worker is one slot.
        const over = agent.state === 'finished' || agent.state === 'failed';
        if (!over) {
          const clear = el('button', 'btn btn-quiet agent-clear');
          clear.append(icon('i-x'));
          clear.dataset.clear = agent.id;
          if (agent.runId) clear.dataset.runId = agent.runId;
          ui(clear, 'title', () => agent.role === 'prime'
              ? t("Clear session — ends this run and every worker in it")
              : t("Clear session — ends {0} and frees its slot", [agent.id]));
          top.append(clear);
        }
        const sub = el('div', 'model-sub');
        const bits = [t("{0} pending", [agent.pending]), t("{0} delivered", [agent.delivered])];
        if (agent.conversationId) bits.push(t("chat bound"));
        sub.textContent = bits.join(' · ');
        row.append(top, sub);
        if (agent.health && agent.health.health !== 'healthy') {
          row.append(el('p', `hint ${agent.health.health === 'blocked' || agent.health.health === 'stalled' ? 'is-warn' : ''}`, agent.health.reason));
        }
        if (agent.task) row.append(el('p', 'hint', agent.task));
        // Why it failed, not just that it did. A worker only reaches this state when its
        // chat could not be opened, and the reason is the only actionable part.
        if (agent.state === 'failed' && agent.result && agent.health?.reason !== agent.result) {
          row.append(el('p', 'hint is-warn', agent.result));
        }
        return row;
      })
    );
  }
  // Usable whenever there is a run to clear, not only while a worker is still going.
  // Gating on `running` left finished-but-present swarm state with no way out, which is
  // exactly the state a user wants to clear before starting the next run.
  $<HTMLButtonElement>('swarmReset').disabled = state.agents.length === 0 && state.retainedHistory !== true;
}

/**
 * The meter's red line, derived from the one threshold the user actually sets.
 *
 * There used to be three numbers for one quantity — "suggest at", "urgent at" and
 * "compact at" — all measured in the same local estimate and all editable apart. That is
 * three ways to describe one line, and they drifted: a meter could sit red for an hour on
 * a chat whose automatic trigger was set far higher, or fill only halfway on the turn that
 * compaction actually fired. The threshold is now the amber line by definition, and the red
 * line sits a third further on, which is the relation the app's own defaults have always
 * carried (300k → 400k when the threshold was 300k; 400k → 533k now).
 */
function urgentFrom(threshold: number): number {
  return Math.min(4_000_000, Math.max(10_000, Math.round((threshold * 4) / 3)));
}

/** Reads the three config sections this panel owns, for the renderer's save path. */
export function chatSettingsPatch(current: Config): {
  sessions: Config['sessions'];
  compaction: Config['compaction'];
  multiAgent: Config['multiAgent'];
  goal: Config['goal'];
  mcp: Config['mcp'];
} {
  const number = (id: string, fallback: number, min: number, max: number): number => {
    const raw = Number($<HTMLInputElement>(id).value);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.round(raw)));
  };
  const threshold = number('autoCompactTokens', current.compaction.autoTokens, 10_000, 4_000_000);
  return {
    sessions: {
      record: $<HTMLInputElement>('sessRecord').checked,
      retainDays: number('sessRetain', current.sessions.retainDays, 0, 3650),
      // Both follow the single threshold above rather than being typed separately.
      advisoryTokens: threshold,
      limitTokens: urgentFrom(threshold)
    },
    compaction: {
      auto: $<HTMLInputElement>('autoCompact').checked,
      autoTokens: threshold
    },
    multiAgent: {
      defaultModel: $<HTMLSelectElement>('workerModel').value,
      defaultReasoning: $<HTMLSelectElement>('workerReasoning').value as Config['multiAgent']['defaultReasoning'],
      // The exposure switch lives with every other ChatGPT tool switch, on Home. This
      // panel keeps only the worker count, so it reads the one control that exists.
      enabled: $<HTMLInputElement>('homeMaEnabled').checked,
      maxWorkers: number('maWorkers', current.multiAgent.maxWorkers, 1, MAX_MULTI_AGENT_WORKERS),
      limitAutomaticChats: $<HTMLInputElement>('maLimitAutomaticChats').checked,
      maxActiveChats: number('maActiveChats', current.multiAgent.maxActiveChats, 1, 16),
      rotationBatchSize: number('maRotationBatch', current.multiAgent.rotationBatchSize, 1, 16),
      rotationMinutes: number('maRotationMinutes', current.multiAgent.rotationMinutes, 5, 1440),
      rotationForegroundSlots: number('maRotationForeground', current.multiAgent.rotationForegroundSlots, 0, 3),
      // Retain the legacy field for config compatibility. Admission now has one fixed,
      // tested 15-second canary cadence rather than presenting a misleading minute control.
      rateLimitCooldownMinutes: current.multiAgent.rateLimitCooldownMinutes,
      sleepingRuntimeMinutes: number('maSleepingRuntime', current.multiAgent.sleepingRuntimeMinutes, 1, 1440),
      allowUnattributedCalls: $<HTMLInputElement>('allowUnattributedCalls').checked,
      recoverAgentTabs: $<HTMLInputElement>('recoverAgentTabs').checked
    },
    goal: {
      enabled: current.goal.enabled, mode: current.goal.mode,
      includeToolCalls: $<HTMLInputElement>('goalIncludeToolCalls').checked,
      backend: $<HTMLSelectElement>('goalBackend').value as Config['goal']['backend'],
      loopBackend: $<HTMLSelectElement>('loopBackend').value as Config['goal']['loopBackend'],
      continuationPolicy: $<HTMLSelectElement>('loopContinuationPolicy').value as Config['goal']['continuationPolicy'],
      helperModel: $<HTMLSelectElement>('helperModel').value || current.goal.helperModel || 'gpt-5.6-sol',
      helperReasoning: ($<HTMLSelectElement>('helperReasoning').value || current.goal.helperReasoning || 'xhigh') as Config['goal']['helperReasoning'],
      provider: {
        kind: ($<HTMLSelectElement>('goalProvider').value || current.goal.provider?.kind || 'openrouter') as Config['goal']['provider']['kind'],
        baseUrl: $<HTMLInputElement>('goalBaseUrl').value
      },
      // The api-backend model is picked from the catalogue and never typed, except on a
      // custom endpoint whose id is typed in its own field instead. `current` is the
      // fallback for the first save after a repaint.
      model:
        $<HTMLSelectElement>('goalProvider').value === 'custom'
          ? $<HTMLInputElement>('goalCustomModel').value.trim() || current.goal.model
          : goalModel || current.goal.model,
      reasoning: $<HTMLSelectElement>('goalReasoning').value as Config['goal']['reasoning'],
      // Blank means "restore the safe default", not "send an unconstrained system message".
      prompt: $<HTMLTextAreaElement>('goalPrompt').value.trim() || DEFAULT_GOAL_SYSTEM_PROMPT,
      objectivePrompt:
        $<HTMLTextAreaElement>('goalObjectivePrompt').value.trim() ||
        DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
      loopPrompt:
        $<HTMLTextAreaElement>('goalLoopPrompt').value.trim() || DEFAULT_GOAL_LOOP_SYSTEM_PROMPT
    },
    // The retired editor no longer owns this stored configuration.
    mcp: current.mcp ?? { instructions: '' }
  };
}

// --------------------------------------------------------------- the goal loop

/**
 * The OpenRouter model this panel currently has chosen.
 *
 * Kept beside the controls rather than in one, because the picker is a list that is not
 * loaded most of the time: an `<input>` would have to hold an id nobody typed, and a
 * `<select>` would have to hold several hundred options nobody asked for.
 */
let goalModel = DEFAULT_GOAL_MODEL;
/** The catalogue as far as it has been paged in, and how long it actually is. */
let goalModels: GoalModel[] = [];
let selectedGoalModel: GoalModel | undefined;
let goalCatalogEpoch = 0;
let goalTotal = 0;
let goalLoading = false;

function invalidateGoalModels(): void {
  goalCatalogEpoch++;
  goalModels = [];
  selectedGoalModel = undefined;
  goalTotal = 0;
}

function paintGoalReasoning(selected?: Config['goal']['reasoning'], changingModel = false): void {
  const select = $<HTMLSelectElement>('goalReasoning');
  const model = goalModels.find(model => model.id === goalModel) ?? (selectedGoalModel?.id === goalModel ? selectedGoalModel : undefined);
  const custom = $<HTMLSelectElement>('goalProvider').value === 'custom';
  renderGoalReasoning(select, custom ? undefined : model, custom,
    selected ?? (select.value || 'default') as Config['goal']['reasoning'], changingModel);
}

/** The release date OpenRouter publishes, as a person would date a model. */
function releasedOn(created: number): string {
  if (!created) return t("release date not published");
  return new Date(created * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Loads the next twenty models, newest first.
 *
 * Paged rather than fetched whole because the catalogue is several hundred entries long and
 * the question this list answers — what is new — is answered by the first screen of it.
 */
async function loadGoalModels(reset: boolean): Promise<void> {
  if (goalLoading) return;
  goalLoading = true;
  if (reset) {
    invalidateGoalModels();
  }
  const epoch = goalCatalogEpoch;
  ui($('goalModelsState'), 'textContent', () => t("Loading models from OpenRouter…"));
  $<HTMLButtonElement>('goalMore').disabled = true;
  const page = await run(api.listGoalModels(goalModels.length));
  goalLoading = false;
  if (epoch !== goalCatalogEpoch) return;
  if (!page) {
    // `run` has already shown the reason. Say what it means *here*: the list is empty and
    // the model in use has not changed.
    ui($('goalModelsState'), 'textContent', () => t("OpenRouter could not be reached. The model in use is unchanged."));
    $<HTMLButtonElement>('goalMore').disabled = goalModels.length === 0;
    return;
  }
  goalModels = [...goalModels, ...page.models];
  selectedGoalModel = page.selectedModel;
  goalTotal = page.total;
  paintGoalReasoning();
  paintGoalModels();
}

function paintGoalModels(): void {
  const list = $('goalModelList');
  // Emptying an element scrolls it back to the top, and this repaints the whole list every
  // time a page lands. Without holding the offset, paging in the next twenty threw the
  // reader back to the newest model — which is the one place they had already decided
  // against by scrolling away from it.
  const keep = list.scrollTop;
  list.textContent = '';
  for (const model of goalModels) {
    const row = el('button', 'goal-model');
    row.setAttribute('type', 'button');
    row.dataset.model = model.id;
    if (model.id === goalModel) row.dataset.chosen = '1';
    row.append(el('b', 'goal-model-name', model.name));
    const meta = [releasedOn(model.created), model.contextLength > 0 ? t("{0} ctx", [compactNumber(model.contextLength)]) : '']
      .filter(Boolean)
      .join(' · ');
    row.append(el('em', 'goal-model-meta', `${model.id} · ${meta}`));
    list.append(row);
  }
  const shown = goalModels.length;
  ui($('goalModelsState'), 'textContent', () => shown === 0 ? t("No models came back.") : t("Showing the {0} newest of {1}, newest release first.", [shown, goalTotal]));
  $<HTMLButtonElement>('goalMore').disabled = shown >= goalTotal;
  $<HTMLButtonElement>('goalMore').hidden = shown >= goalTotal;
  list.scrollTop = keep;
  // A page that did not fill the box leaves nothing to scroll, so the scroll handler can
  // never fire and the list would stop at twenty with more still to come. Ask again here.
  maybePageGoalModels();
}

/**
 * Pages the catalogue in as the list is scrolled.
 *
 * "Load 20 more" is the deliberate way to ask; scrolling to the bottom is the way people
 * actually ask. It fires a screenful early rather than at the exact bottom, so the next
 * twenty are usually already in place by the time the scroll arrives where they go.
 */
function maybePageGoalModels(): void {
  if (goalLoading || goalModels.length === 0 || goalModels.length >= goalTotal) return;
  const list = $('goalModelList');
  // A closed picker measures zero in every direction, which reads as "scrolled to the end"
  // and would page the whole catalogue in behind a panel nobody has open.
  if (list.clientHeight === 0) return;
  if (list.scrollHeight - list.scrollTop - list.clientHeight > GOAL_SCROLL_MARGIN) return;
  void loadGoalModels(false);
}

/** Keep an in-progress form edit when an unrelated main-process push carries the old value. */
function applyChatValue(
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
  previous: string | number | undefined
): void {
  if (document.activeElement === input && previous !== undefined && input.value !== String(previous)) return;
  input.value = value;
}

/** Checkbox counterpart to applyChatValue. */
function applyChatChecked(input: HTMLInputElement, value: boolean, previous: boolean | undefined): void {
  if (document.activeElement === input && previous !== undefined && input.checked !== previous) return;
  input.checked = value;
}

/** Writes the goal block from app state. Called from chatApply, so it never guesses. */
function applyGoal(state: AppState, previous?: Config): void {
  const { config } = state;
  applyChatChecked($<HTMLInputElement>('goalIncludeToolCalls'), config.goal.includeToolCalls === true, previous?.goal.includeToolCalls);
  const automation = $<HTMLSelectElement>('chatAutomation');
  automation.disabled = !config.sessions.record;
  ui(automation, 'title', () => config.sessions.record ? t("Continue this chat automatically") : t("Enable session recording to use Goal or Loop"));
  paintAutomationSwitch();
  const secureStorageAvailable = state.secureStorage?.available ?? true;
  // This picker owns the last known OpenRouter selection. A custom deployment uses
  // its own input and must not replace that selection during an unrelated repaint.
  // A session opened directly on custom starts with the picker's defined default.
  if (config.goal.provider?.kind !== 'custom') goalModel = config.goal.model;
  const reasoningSelect = $<HTMLSelectElement>('goalReasoning');
  const reasoning = document.activeElement === reasoningSelect && previous && reasoningSelect.value !== previous.goal.reasoning
    ? reasoningSelect.value as Config['goal']['reasoning'] : config.goal.reasoning;
  if (previous && JSON.stringify(previous.goal.provider) !== JSON.stringify(config.goal.provider)) invalidateGoalModels();
  applyChatValue($<HTMLTextAreaElement>('goalPrompt'), config.goal.prompt, previous?.goal.prompt);
  applyChatValue(
    $<HTMLTextAreaElement>('goalObjectivePrompt'),
    config.goal.objectivePrompt,
    previous?.goal.objectivePrompt
  );
  applyChatValue(
    $<HTMLTextAreaElement>('goalLoopPrompt'),
    config.goal.loopPrompt,
    previous?.goal.loopPrompt
  );
  // Which endpoint the api backend talks to. The key sentence below only applies to
  // OpenRouter: a custom endpoint is often keyless, so a missing key never means custom.
  const customProvider = config.goal.provider?.kind === 'custom';
  const providerBaseUrl = config.goal.provider?.baseUrl ?? '';
  applyChatValue($<HTMLSelectElement>('goalProvider'), customProvider ? 'custom' : 'openrouter', previous?.goal.provider?.kind);
  applyChatValue($<HTMLInputElement>('goalBaseUrl'), providerBaseUrl, previous?.goal.provider?.baseUrl);
  applyChatValue($<HTMLInputElement>('goalCustomModel'), config.goal.model, previous?.goal.model);
  $('goalCustomPanel').hidden = !customProvider;
  $('goalPickerRow').hidden = customProvider;
  if (customProvider) $('goalModels').hidden = true;
  $('goalKeyField').hidden = customProvider;
  $('goalModelName').textContent = config.goal.model;
  const goalKey = $<HTMLInputElement>('goalKey');
  ui(goalKey, 'placeholder', () => state.hasGoalKey ? t("•••••••• stored") : 'sk-or-v1-…');
  goalKey.disabled = !secureStorageAvailable;
  ui($('goalKeyState'), 'textContent', () => !secureStorageAvailable
    ? (state.secureStorage?.detail ?? t("Secure credential storage is unavailable."))
    : state.hasGoalKey
      ? t("A key is stored with secure OS credential storage. Type a new one to replace it.")
      : t("Stored with secure OS credential storage. It never leaves this app, and the browser is only ever handed the reply."));
  $('goalKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('goalKeyRemove').disabled = !state.hasGoalKey || !secureStorageAvailable;
  const goalCustomKey = $<HTMLInputElement>('goalCustomKey');
  ui(goalCustomKey, 'placeholder', () => state.hasCustomProviderKey ? t("•••••••• stored") : t("leave empty for a keyless local server"));
  goalCustomKey.disabled = !secureStorageAvailable;
  ui($('goalCustomKeyState'), 'textContent', () => !secureStorageAvailable
    ? (state.secureStorage?.detail ?? t("Secure credential storage is unavailable."))
    : state.hasCustomProviderKey
      ? t("A key is stored with secure OS credential storage. Type a new one to replace it.")
      : t("Optional. Stored with secure OS credential storage and sent only by the app to your configured API endpoint. The browser receives only the reply."));
  $('goalCustomKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('goalCustomKeyRemove').disabled = !state.hasCustomProviderKey || !secureStorageAvailable;
  paintGoalReasoning(reasoning);
  if (goalModels.length > 0) paintGoalModels();
}

function wireGoal(save: () => Promise<void>): void {
  $<HTMLTextAreaElement>('goalPrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalPromptEdit').addEventListener('click', () => {
    const panel = $('goalPromptPanel');
    panel.hidden = !panel.hidden;
    $('goalPromptEdit').textContent = panel.hidden ? 'Edit prompt' : 'Close prompt';
    if (!panel.hidden) $<HTMLTextAreaElement>('goalPrompt').focus();
  });
  $('goalPromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalPrompt').value = DEFAULT_GOAL_SYSTEM_PROMPT;
    await save();
    toast('Goal prompt (no task) restored to default');
  });
  $<HTMLTextAreaElement>('goalObjectivePrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalObjectivePromptEdit').addEventListener('click', () => {
    const panel = $('goalObjectivePromptPanel');
    panel.hidden = !panel.hidden;
    $('goalObjectivePromptEdit').textContent = panel.hidden ? 'Edit prompt' : 'Close prompt';
    if (!panel.hidden) $<HTMLTextAreaElement>('goalObjectivePrompt').focus();
  });
  $('goalObjectivePromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalObjectivePrompt').value = DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT;
    await save();
    toast('Goal prompt (with a task) restored to default');
  });
  $<HTMLTextAreaElement>('goalLoopPrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalLoopPromptEdit').addEventListener('click', () => {
    const panel = $('goalLoopPromptPanel');
    panel.hidden = !panel.hidden;
    $('goalLoopPromptEdit').textContent = panel.hidden ? 'Edit prompt' : 'Close prompt';
    if (!panel.hidden) $<HTMLTextAreaElement>('goalLoopPrompt').focus();
  });
  $('goalLoopPromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalLoopPrompt').value = DEFAULT_GOAL_LOOP_SYSTEM_PROMPT;
    await save();
    toast('Loop prompt restored to default');
  });
  // The catalogue is fetched on the first press and kept afterwards: the picker closing is
  // not a reason to spend another round trip on a list that changes weekly.
  $('goalPick').addEventListener('click', () => {
    const panel = $('goalModels');
    panel.hidden = !panel.hidden;
    $('goalPick').textContent = panel.hidden ? 'Select model' : 'Close';
    if (!panel.hidden && goalModels.length === 0) void loadGoalModels(true);
  });
  $('goalMore').addEventListener('click', () => void loadGoalModels(false));
  $('goalReasoning').addEventListener('focus', () => {
    if ($<HTMLSelectElement>('goalProvider').value !== 'custom' && !goalModels.some(model => model.id === goalModel) && selectedGoalModel?.id !== goalModel)
      void loadGoalModels(true);
  });
  $('goalModelList').addEventListener('scroll', maybePageGoalModels);
  $('goalModelList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-model]');
    if (!row?.dataset.model) return;
    goalModel = row.dataset.model;
    $('goalModelName').textContent = goalModel;
    paintGoalReasoning(undefined, true);
    paintGoalModels();
    void save();
    toast(`Goal model set to ${goalModel}`);
  });
  // On blur, like every other key in this app: not saved keystroke by keystroke, and the
  // field is emptied the moment it has been handed over.
  $('goalKey').addEventListener('blur', async () => {
    const input = $<HTMLInputElement>('goalKey');
    const submitted = input.value;
    const key = submitted.trim();
    // Whitespace is not a key. Passing it through trim as an empty string used to invoke the
    // remove-key path and then claim a key was stored.
    if (key === '') return;
    const next = await run(api.setGoalKey(key));
    if (next) {
      invalidateGoalModels();
      // A blur can be followed immediately by refocus + new typing while IPC is in flight.
      // Clear only the exact value that successfully crossed the secret-store boundary.
      if (input.value === submitted) input.value = '';
      applyGoal(next);
      toast('OpenRouter key stored');
    }
  });
  $('goalKeyRemove').addEventListener('click', async () => {
    const next = await run(api.setGoalKey(''));
    if (next) {
      invalidateGoalModels();
      applyGoal(next);
      toast('OpenRouter key removed');
    }
  });
  // Same blur-to-save discipline as the OpenRouter key above. Empty submits nothing:
  // a keyless local endpoint is a supported configuration, not a key being removed.
  $('goalCustomKey').addEventListener('blur', async () => {
    const input = $<HTMLInputElement>('goalCustomKey');
    const submitted = input.value;
    const key = submitted.trim();
    if (key === '') return;
    const next = await run(api.setCustomProviderKey(key));
    if (next) {
      if (input.value === submitted) input.value = '';
      applyGoal(next);
      toast('Custom provider key stored');
    }
  });
  $('goalCustomKeyRemove').addEventListener('click', async () => {
    const next = await run(api.setCustomProviderKey(''));
    if (next) {
      applyGoal(next);
      toast('Custom provider key removed');
    }
  });
}

/**
 * One clause under the row, not a paragraph: what the switch will do, and the fact that
 * the number it fires on is this app's own estimate rather than ChatGPT's accounting.
 */
function applyAutoCompactHint(config: Config): void {
  ui($('autoCompactHint'), 'textContent', () => config.compaction.auto
    ? t("Interrupts an active answer at this many tokens, writes a handoff, and opens a fresh chat.")
    : t("Off — only the Compact & resume button in the ChatGPT tab compacts."));
}

/**
 * Every control on the settings sheet, and the whole of it.
 *
 * A field that is not here does not save: it keeps what was typed until the next repaint
 * and then quietly reverts. `autoCompactTokens` was missing, which made the one number the
 * automatic trigger fires on the one control in the app that never kept what you typed.
 * `sessRecord` is deliberately absent — it lives in the Home permission list now, with
 * every other switch that decides what ChatGPT can reach, and saves from there.
 */
const CHAT_INPUTS = [
  'chatBrowser',
  'goalIncludeToolCalls',
  'planBackend',
  'finishTool', 'finishAction', 'finishLeadMinutes', 'rotateTurnMinutes', 'workerModel', 'workerReasoning', 'backgroundChats', 'browserOnly', 'autoRefreshPlugins',
  'signOutEmergencyAlerts',
  'goalBackend',
  'loopBackend',
  'loopContinuationPolicy',
  'helperModel', 'helperReasoning',
  'sessRetain',
  'autoCompact',
  'autoCompactTokens',
  'maWorkers',
  'maLimitAutomaticChats',
  'maActiveChats',
  'maRotationBatch',
  'maRotationMinutes',
  'maRotationForeground',
  'maRateLimitCooldown',
  'maSleepingRuntime',
  'allowUnattributedCalls',
  'recoverAgentTabs',
  'goalProvider',
  'goalBaseUrl',
  'goalCustomModel',
  'goalReasoning',
  'goalPrompt',
  'goalObjectivePrompt',
  'goalLoopPrompt'
];

/** Writes app state into this panel's controls. Called from the renderer's apply(). */
let routeSettlingUntil = 0;
function routeHeld(entry: InputEntry): boolean {
  return entry.state === 'queued' && !entry.error && !!entry.conversationId && entry.mode === 'auto' &&
    entry.transportIntent !== 'tool' && entry.attachmentDelivery !== 'tool' && entry.afterTurn !== true &&
    entry.dueAt <= Date.now() && entry.queuedBehindBrowser !== true &&
    entry.queuedBehindDelivery !== true && entry.sendAuthorizedAt === undefined && entry.deliveredAt === undefined &&
    entry.messageId === undefined && Date.now() < routeSettlingUntil;
}

export function chatApply(state: AppState, previous?: Config): void {
  const { config, bridge } = state;
  const nextRouteDeadline = state.status.routeSettlingUntil ?? 0;
  if (nextRouteDeadline !== routeSettlingUntil) {
    routeSettlingUntil = nextRouteDeadline;
    void refreshInputQueue();
    scheduleToolActivityExpiry();
  }
  const paused = config.ui.automationPaused === true;
  const pauseButton = $<HTMLButtonElement>('toggleAutomationPause');
  pauseButton.setAttribute('aria-pressed', String(paused));
  pauseButton.classList.toggle('is-running', paused);
  ui($('automationPauseLabel'), 'textContent', () => t(paused ? 'Resume' : 'Pause all'));
  ui(pauseButton, 'title', () => t(paused
    ? 'Resume saved Goal, Loop, worker, retry, compaction, and handoff work'
    : 'Pause all automated chats after current provider turns and running workers finish; saved queues are preserved'));
  const resumeAll = $<HTMLButtonElement>('resumeAutomation');
  resumeAll.disabled = false;
  ui(resumeAll, 'title', () => t(paused
    ? 'Release the global pause and resume every saved Goal, Loop, worker, retry, compaction, and handoff queue'
    : 'Resume every enabled Goal and Loop chat'));
  $<HTMLButtonElement>('freshCopyAutomation').disabled = paused;
  $<HTMLSelectElement>('automationProfile').value = config.ui.automationProfile ?? 'day';
  syncMajorityAlarmPolling(config.ui.automationProfile === 'overnight' && ownsFleetMajorityAlarm(config));
  paintAutomationSupervisor();
  if (visible && selectedId) void refreshSessionControls();
  paintContextMeter(sessions.find(session => session.id === selectedId) ?? null, config, confirmedComposerModel());
  applyChatModels(config, previous);

  // `sessRecord` is painted by the renderer's own apply(): it lives in the Home
  // permission list now, with every other switch that decides what ChatGPT can reach.
  applyChatValue($<HTMLInputElement>('sessRetain'), String(config.sessions.retainDays), previous?.sessions.retainDays);

  applyChatChecked($<HTMLInputElement>('autoCompact'), config.compaction.auto, previous?.compaction.auto);
  applyChatValue(
    $<HTMLInputElement>('autoCompactTokens'),
    String(config.compaction.autoTokens),
    previous?.compaction.autoTokens
  );
  applyAutoCompactHint(config);

  applyChatValue($<HTMLInputElement>('maWorkers'), String(config.multiAgent.maxWorkers), previous?.multiAgent.maxWorkers);
  applyChatChecked(
    $<HTMLInputElement>('maLimitAutomaticChats'),
    config.multiAgent.limitAutomaticChats,
    previous?.multiAgent.limitAutomaticChats
  );
  applyChatValue($<HTMLInputElement>('maActiveChats'), String(config.multiAgent.maxActiveChats), previous?.multiAgent.maxActiveChats);
  applyChatValue($<HTMLInputElement>('maRotationBatch'), String(config.multiAgent.rotationBatchSize), previous?.multiAgent.rotationBatchSize);
  applyChatValue($<HTMLInputElement>('maRotationMinutes'), String(config.multiAgent.rotationMinutes), previous?.multiAgent.rotationMinutes);
  applyChatValue($<HTMLInputElement>('maRotationForeground'), String(config.multiAgent.rotationForegroundSlots), previous?.multiAgent.rotationForegroundSlots);
  applyChatValue($<HTMLInputElement>('maRateLimitCooldown'), '15', previous ? '15' : undefined);
  $<HTMLInputElement>('maActiveChats').disabled = false;
  $<HTMLInputElement>('maRateLimitCooldown').disabled = true;
  applyChatValue($<HTMLInputElement>('maSleepingRuntime'), String(config.multiAgent.sleepingRuntimeMinutes), previous?.multiAgent.sleepingRuntimeMinutes);
  applyChatChecked(
    $<HTMLInputElement>('allowUnattributedCalls'),
    config.multiAgent.allowUnattributedCalls,
    previous?.multiAgent.allowUnattributedCalls
  );
  applyChatChecked(
    $<HTMLInputElement>('recoverAgentTabs'),
    config.multiAgent.recoverAgentTabs,
    previous?.multiAgent.recoverAgentTabs
  );

  applyChatValue($<HTMLSelectElement>('workerModel'), config.multiAgent.defaultModel ?? '', previous?.multiAgent.defaultModel);
  applyChatValue($<HTMLSelectElement>('workerReasoning'), config.multiAgent.defaultReasoning ?? '', previous?.multiAgent.defaultReasoning);
  applyChatValue($<HTMLSelectElement>('goalBackend'), config.goal.backend ?? 'chatgpt', previous?.goal.backend);
  applyChatValue($<HTMLSelectElement>('loopBackend'), config.goal.loopBackend ?? 'chatgpt', previous?.goal.loopBackend);
  applyChatValue($<HTMLSelectElement>('loopContinuationPolicy'), config.goal.continuationPolicy ?? 'strict', previous?.goal.continuationPolicy);
  applyChatValue($<HTMLSelectElement>('helperModel'), config.goal.helperModel ?? 'gpt-5.6-sol', previous?.goal.helperModel);
  applyChatValue($<HTMLSelectElement>('helperReasoning'), config.goal.helperReasoning ?? 'xhigh', previous?.goal.helperReasoning);
  applyGoal(state, previous);

  // Extension bridge. Connecting is automatic, so this reports rather than asks.
  const browserRequired = browserExtensionRequired(config);
  $<HTMLButtonElement>('bridgeUnpair').disabled = !bridge.paired;
  const secureStorageAvailable = state.secureStorage?.available ?? true;
  ui($('bridgeState'), 'textContent', () => !browserRequired
    ? t("Browser-backed features are off. The extension is not needed right now.")
    : !secureStorageAvailable
      ? (state.secureStorage?.detail ?? t("Secure credential storage is unavailable, so the extension cannot pair safely."))
    : !bridge.running
      ? t("The local bridge is off even though recording or multi-agent mode needs it.")
      : bridge.present
        ? t("Connected. Listening on 127.0.0.1:{0} · last message {1}.", [bridge.port ?? '?', ago(bridge.lastSeenAt)])
        : bridge.paired
          ? t("Authorized, but the browser extension is not currently connected. {0}", [bridge.lastSeenAt === null ? t("It has not checked in since this app started.") : t("Last seen {0}.", [ago(bridge.lastSeenAt)])])
          : t("Listening on 127.0.0.1:{0} · no browser is authorized or connected yet.", [bridge.port ?? '?']));
  $('bridgeState').classList.toggle('is-warn', browserRequired && (!bridge.present || !secureStorageAvailable));
  void showExtensionPath();

  if (sessions.length > 0) paintSessions();
  if (previous && previous.ui.automationPaused !== config.ui.automationPaused && selectedId) {
    // Account pause can change without a new session-history notification.
    // Repaint the already selected read-only Progress evidence, not its sources.
    paintProgressInbox();
  }
}

/** Called when the Chat tab becomes visible or is left, so it only polls when shown. */
export function chatVisible(next: boolean): void {
  visible = next;
  if (next) void refreshAll();
  else {
    window.clearTimeout(toolActivityTimer);
    window.clearTimeout(durationTimer);
    toolActivityTimer = undefined;
  }
}

async function refreshAll(): Promise<void> {
  await loadSessions();
  const swarmNow = await run(api.getSwarm());
  if (swarmNow) paintSwarm(swarmNow);
}

/** Sessions change on every recorded event, so the reload is coalesced. */
function scheduleReload(): void {
  if (!visible) return;
  // One refresh owns the timer until its asynchronous read completes. Starting a
  // newer read every 400 ms can invalidate every result on a busy/slower store.
  if (listTimer !== undefined) { listRefreshDirty = true; return; }
  listTimer = window.setTimeout(() => {
    listRefreshDirty = false;
    void loadSessions().finally(() => {
      listTimer = undefined;
      if (listRefreshDirty) scheduleReload();
    });
  }, 400);
}

/** Retired automatic drafts belong to their creation time, never the live composer queue. */
function historicalAutomaticInput(entry: InputEntry): boolean {
  if (entry.purpose === 'rotation') return ['cancelled', 'failed'].includes(entry.state) && !!entry.error;
  return !!entry.finishOwner && !entry.finishOwner.userRequested && entry.state === 'cancelled' && !!entry.error;
}

/** Only Main's durable confirmed-pre-Send failure shape may invite a deliberate resubmission. */
function retryableFailedDelivery(entry: InputEntry): boolean {
  return entry.purpose !== 'rotation' && entry.state === 'failed' && entry.owner === null && entry.requiresAuthorization === true &&
    (entry.preSendReoffers ?? 0) > 2 &&
    entry.sendAuthorizedAt === undefined && entry.deliveredAt === undefined && entry.messageId === undefined &&
    !/\bmay already have (?:been sent|reached ChatGPT)\b/i.test(entry.error ?? '');
}

function retryableQueuedBrowserInput(entry: InputEntry): boolean {
  return entry.state === 'queued' && (entry.requestedMode ?? entry.mode) === 'auto' &&
    entry.queuedBehindDelivery !== true && (entry.queuedBehindBrowser !== true || entry.deliveryAttentionAt !== undefined) &&
    !entry.finishOwner && entry.purpose !== 'decision' && entry.purpose !== 'rotation' && entry.attachmentDelivery !== 'tool';
}

function chatgptProjectWait(entry: InputEntry): 'waiting' | 'creating' | 'failed' | null {
  if (!entry.projectId) return null;
  if (entry.sessionId && sessions.find(session => session.id === entry.sessionId)?.conversationId) return null;
  const link = projects.find(project => project.id === entry.projectId)?.chatgpt;
  if (!link || link.state === 'linked') return null;
  if (link.state === 'failed' || link.state === 'uncertain') return 'failed';
  return link.state === 'creating' ? 'creating' : 'waiting';
}

/** Keep Retry fenced after any successful Main response; only transport/IPC failure may re-arm it locally. */
async function retryBrowserInput(entry: InputEntry, retry: HTMLButtonElement): Promise<void> {
  retry.disabled = true;
  const reply = await api.retryInputBrowser(entry.id);
  if (!reply.ok) {
    toast(reply.error);
    if (retry.isConnected) retry.disabled = false;
  }
  void refreshInputQueue();
}

function inputMessageRow(entry: InputEntry, notice: boolean): HTMLElement {
  const row = el('div', 'pending-message');
  const rateLimited = isChatGptRateLimit(entry.error ?? '');
  row.classList.toggle('is-delivered', !entry.error && ['sent', 'tool'].includes(entry.state));
  row.classList.toggle('is-delivery-error', !!entry.error || entry.state === 'failed');
  row.classList.toggle('is-rate-limited', rateLimited);
  const held = routeHeld(entry);
  const projectWait = chatgptProjectWait(entry);
  row.dataset.inputId = entry.id;
  if (!visibleInputIds.has(entry.id)) row.classList.add('is-entering');
  visibleInputIds.add(entry.id);
  if (visibleInputIds.size > 100) visibleInputIds.delete(visibleInputIds.values().next().value!);
  const status = () => entry.error || (held ? t('Sending in a moment…')
    : projectWait === 'creating' ? t('Creating this project in ChatGPT…')
      : projectWait === 'waiting' ? t(deps.state()?.config.ui.automationPaused === true
        ? 'Native Project request saved · automation is paused'
        : 'Waiting to create this project in ChatGPT…')
      : projectWait === 'failed' ? t("This project's ChatGPT Project is unavailable. Use Retry on the project row.")
        : entry.state === 'failed' ? t("Delivery not confirmed") : entry.state === 'decision' ? t("Preparing follow-up")
    : entry.state === 'browser' ? entry.sendAuthorizedAt !== undefined ? t("Sent to ChatGPT · confirming receipt") : t("Chrome is preparing the message")
      : entry.state === 'tool' ? t("Sent to the active turn · awaiting receipt") : entry.dueAt > Date.now() ? t("Scheduled {0}", [new Date(entry.dueAt).toLocaleString(currentLanguage())]) : t("Queued"));
  const files = el('div', 'message-attachments');
  if (entry.attachments?.length) files.append(...entry.attachments.map(file => attachmentCard(file)));
  for (const image of entry.images ?? []) { const preview = document.createElement('img'); preview.src = image.dataUrl; preview.alt = image.name; files.append(preview); }
  if (files.childElementCount) row.append(files);
  if (entry.text) {
    const text = el('div', 'pending-message-text', entry.text);
    text.setAttribute('dir', 'auto');
    row.append(text);
  }
  const receipt = el('span', 'pending-message-status');
  ui(receipt, 'title', status); ui(receipt, 'aria-label', status);
  if (entry.error || entry.state === 'failed' || held || projectWait) {
    if (rateLimited) receipt.append(icon('i-warning'));
    else ui(receipt, 'textContent', status);
  }
  else receipt.append(icon(['sent', 'tool'].includes(entry.state) ? 'i-check' : 'i-clock'));
  receipt.hidden = !entry.error && ['sent', 'tool'].includes(entry.state) && hasLaterModelActivity(entry.deliveredAt ?? entry.offeredAt ?? entry.createdAt);
  row.append(receipt);
  if (notice) {
    row.append(dockAction(() => t("Dismiss delivery notice"), 'i-x', () => dismissInputNotice(entry.id)));
    // Cancelled, authorized, delivered, message-bound and otherwise ambiguous outcomes are
    // presentation-only. Only Main's narrow positively-unsent failed shape can be restored for
    // review; the eventual Send still enters through the ordinary durable input owner.
    if (!retryableFailedDelivery(entry)) return row;
    const retry = dockAction(() => t("Retry delivery"), 'i-retry', () => {});
    retry.classList.add('delivery-retry');
    const unqueuedPlan = entry.stages !== undefined && !entry.stagesApplied;
    ui(retry, 'title', () => unqueuedPlan ? t("Retry stage one with the complete plan and queued checkpoints") : t("Restore this message to the composer for review and sending"));
    retry.onclick = () => {
      if (unqueuedPlan) { void retryPlannedInput(entry); return; }
      const input = $<HTMLTextAreaElement>('chatInput');
      if (input.value.trim() || imageDrafts.get(draftKey())?.length) { toast(t("Send or clear your current draft before retrying this message.")); return; }
      input.value = entry.text;
      if (entry.images?.length) imageDrafts.set(draftKey(), [...entry.images]);
      if (entry.attachments?.length) imageDrafts.set(draftKey(), [...(entry.images ?? []), ...entry.attachments]);
      rememberDraft(); paintComposerImages(); paintDeliveryControls(); input.focus();
      dismissInputNotice(entry.id);
    };
    row.append(retry);
  }
  if (['queued', 'browser'].includes(entry.state)) {
    const cancel = dockAction(() => t("Cancel delivery"), 'i-x', () => {});
    cancel.onclick = async () => {
      cancel.disabled = true;
      const result = await run(api.cancelInput(entry.id));
      // The pre-click row can be stale: Send authorization may win while Main serializes
      // cancellation. Never persist a dismissal from that snapshot; the refreshed durable
      // cancelled row decides whether it is positively unsent or an ambiguous outcome.
      if (result === null && cancel.isConnected) cancel.disabled = false;
      void refreshInputQueue();
    };
    row.append(cancel);
  }
  if (retryableQueuedBrowserInput(entry)) {
    const retry = dockAction(() => t("Retry browser"), 'i-retry', () => {});
    retry.classList.add('delivery-retry');
    retry.onclick = () => { void retryBrowserInput(entry, retry); };
    row.append(retry);
  }
  return row;
}

/** Global read-only projection of the one durable input outbox.
 *
 * The timeline and finish queue are intentionally scoped to the selected chat. The
 * transport admission rule is not, so an input owned by another chat must remain
 * inspectable from every selection instead of looking like an unexplained blocker.
 */
function paintDeliveryQueue(all: InputEntry[], belongsToSelection: (entry: InputEntry) => boolean): void {
  const panel = $<HTMLDetailsElement>('deliveryQueuePanel');
  const list = $('deliveryQueueList');
  // Keep active transport complete. Terminal evidence is intentionally compact: one newest cue per
  // chat, at most three account-wide, and never beside an active row for the same destination.
  // Older receipts remain in the durable outbox and exact owning chat; they are not deleted.
  const { active, visible } = visibleDeliveryEntries(all);
  for (const id of [...surfacedDeliveryInputIds]) if (!visible.some(entry => entry.id === id)) surfacedDeliveryInputIds.delete(id);
  for (const id of [...deliveryQueueDrafts.keys()]) if (!active.some(entry => entry.id === id)) deliveryQueueDrafts.delete(id);
  if (visible.length === 0) {
    panel.hidden = true;
    panel.open = false;
    list.replaceChildren();
    $('deliveryQueueCount').textContent = '0';
    return;
  }
  // Historical terminal attention should not pop the dock open on startup/restart. New active
  // transport still opens it so an off-screen blocker remains obvious and controllable.
  const newlyVisible = active.some(entry => !surfacedDeliveryInputIds.has(entry.id));
  const newlyOffscreen = active.some(entry => !surfacedDeliveryInputIds.has(entry.id) && !belongsToSelection(entry));
  for (const entry of visible) surfacedDeliveryInputIds.add(entry.id);
  panel.hidden = false;
  if (newlyVisible || newlyOffscreen) panel.open = true;
  $('deliveryQueueCount').textContent = String(visible.length);
  ui(panel.querySelector('summary')!, 'aria-label', () => t('Delivery queue · {0} messages', [visible.length]));

  const status = (entry: InputEntry): string => {
    if (entry.error) return entry.error;
    const prerequisite = entry.workflow ? workflowBlocker(entry, all) : null;
    if (prerequisite) return prerequisite;
    if (routeHeld(entry)) return t('Sending in a moment…');
    if (entry.state === 'browser') return entry.sendAuthorizedAt !== undefined
      ? t('Sent to ChatGPT · confirming receipt')
      : t('Chrome is preparing the message');
    if (entry.state === 'tool') return t('Offered to the active turn · awaiting tool receipt');
    if (entry.dueAt > Date.now()) return t('Scheduled {0}', [new Date(entry.dueAt).toLocaleString(currentLanguage())]);
    if (entry.queuedBehindBrowser === true) return t('Waiting for the earlier browser delivery');
    if (queuedFollowup(entry)) return entry.mode === 'finish' && entry.afterTurn !== true
      ? t('Waiting for Session Finish')
      : t('Waiting for the next completed answer');
    return t('Ready for Chrome pickup');
  };
  list.replaceChildren(...visible.map((entry, index) => {
    const item = el('div', 'delivery-queue-item');
    item.dataset.inputId = entry.id;
    const sessionId = entry.sessionId ?? entry.deliveredSessionId ?? null;
    const owner = sessions.find(row => row.id === sessionId);
    // ACK can bind the durable input before the next session-catalog refresh. Keep the
    // workstream label visible during that short gap instead of regressing to an UUID.
    const destination = owner?.title ?? entry.nickname ?? (sessionId ? t('Unknown chat · {0}', [sessionId]) : t('New Chat'));
    const ownerButton = el('button', 'delivery-queue-owner', `#${index + 1} · ${destination}`) as HTMLButtonElement;
    ownerButton.type = 'button';
    ownerButton.disabled = !owner;
    ui(ownerButton, 'title', () => owner ? t('Open {0}', [destination]) : destination);
    if (owner) ownerButton.onclick = () => selectSession(owner.id);
    const preview = el('div', 'delivery-queue-preview', entry.text || t('Attachment-only message'));
    preview.dir = 'auto';
    ui(preview, 'title', () => entry.text || t('Attachment-only message'));
    const state = el('div', 'delivery-queue-status', status(entry));
    const actions = el('div', 'delivery-queue-actions');
    const draft = deliveryQueueDrafts.get(entry.id);
    if (draft !== undefined && entry.state === 'queued') {
      item.classList.add('is-editing');
      const field = document.createElement('textarea');
      field.className = 'delivery-queue-editor';
      field.dir = 'auto';
      field.value = draft;
      ui(field, 'aria-label', () => t('Queued message'));
      field.oninput = () => deliveryQueueDrafts.set(entry.id, field.value);
      const save = el('button', 'btn delivery-queue-action', () => t('Save')) as HTMLButtonElement;
      save.type = 'button';
      save.onclick = async () => {
        if (save.disabled) return;
        save.disabled = true;
        const saved = await run(api.editQueuedInput(entry.id, field.value));
        if (saved) {
          deliveryQueueDrafts.delete(entry.id);
          pendingComposerInputs = pendingComposerInputs.map(row => row.id === entry.id
            ? { ...row, text: field.value.trim(), deliveryText: undefined }
            : row);
        } else if (saved === false) toast(t('This message is no longer waiting and could not be edited.'));
        else if (item.isConnected) save.disabled = false;
        void refreshInputQueue();
      };
      const stopEditing = el('button', 'btn delivery-queue-action', () => t('Cancel')) as HTMLButtonElement;
      stopEditing.type = 'button';
      stopEditing.onclick = () => { deliveryQueueDrafts.delete(entry.id); void refreshInputQueue(); };
      actions.append(save, stopEditing);
      item.append(ownerButton, field, state, actions);
    } else {
      item.append(ownerButton, preview, state, actions);
      if (entry.state === 'queued') {
        const edit = el('button', 'btn delivery-queue-action', () => t('Edit')) as HTMLButtonElement;
        edit.disabled = !!entry.workflow;
        if (entry.workflow) edit.title = 'Edit the recipe source and start a new run to change this task.';
        edit.type = 'button';
        ui(edit, 'aria-label', () => t('Edit queued message'));
        edit.onclick = () => { deliveryQueueDrafts.set(entry.id, entry.text); void refreshInputQueue(); };
        actions.append(edit);
      }
    }
    if (retainedDeliveryNotice(entry)) {
      actions.append(dockAction(() => t('Dismiss delivery notice'), 'i-x', () => dismissInputNotice(entry.id)));
      return item;
    }
    if (['queued', 'browser'].includes(entry.state)) {
      const remove = el('button', 'btn delivery-queue-action is-danger', () => t('Delete')) as HTMLButtonElement;
      remove.type = 'button';
      ui(remove, 'aria-label', () => t('Delete queued message'));
      remove.onclick = async () => {
        if (remove.disabled || !item.isConnected) return;
        remove.disabled = true;
        const removed = await run(api.cancelInput(entry.id));
        if (removed && item.isConnected) {
          pendingComposerInputs = pendingComposerInputs.filter(row => row.id !== entry.id);
          deliveryQueueDrafts.delete(entry.id);
          // Chrome may gain Send authorization while Main serializes this cancellation. Never
          // remove the global card from the pre-click snapshot; the refreshed durable cancelled
          // row decides whether this delivery disappears or becomes an ambiguous attention notice.
          paintDeliveryControls();
        } else if (removed === null && item.isConnected) remove.disabled = false;
        void refreshInputQueue();
      };
      actions.append(remove);
    }
    if (retryableQueuedBrowserInput(entry)) {
      const retry = dockAction(() => t('Retry browser'), 'i-retry', () => {});
      retry.classList.add('delivery-retry');
      ui(retry, 'title', () => t('Retry this queued message in Chrome now'));
      retry.onclick = () => { void retryBrowserInput(entry, retry); };
      actions.append(retry);
    }
    return item;
  }));
}

async function refreshInputQueue(): Promise<void> {
  const request = ++inputQueueGeneration;
  const selection = selectionGeneration;
  const [all, pausedHelpers] = await Promise.all([run(api.listInputs()), run(api.listPausedHelpers())]);
  if (selection !== selectionGeneration || request !== inputQueueGeneration) return;
  if (!all) {
    if (!inputQueueReadUnverified) {
      inputQueueReadUnverified = true;
      paintWorkOverview(false);
    }
    return;
  }
  const recoveredQueueRead = inputQueueReadUnverified;
  inputQueueReadUnverified = false;
  const pausedSources = new Set((pausedHelpers ?? []).map(helper => helper.sourceSessionId));
  const bulkHelpers = $<HTMLButtonElement>('retryPausedHelpers');
  bulkHelpers.hidden = pausedSources.size === 0;
  $('retryPausedHelpersLabel').textContent = t('Restart {0} helper chats', [pausedSources.size]);
  ui(bulkHelpers, 'title', () => t('Restart one helper for each of {0} affected source chats', [pausedSources.size]));
  const sidebarInputOwnerKey = (entries: InputEntry[]) => entries
    .filter(entry => ['queued', 'browser', 'tool', 'failed', 'decision'].includes(entry.state))
    .map(entry => `${entry.sessionId ?? ''}\u0000${entry.deliveredSessionId ?? ''}\u0000${entry.conversationId ?? ''}`)
    .sort().join('\u0001');
  const deliveryReceiptKey = (entries: InputEntry[]) => entries
    .filter(entry => entry.purpose !== 'decision' && entry.deliveredAt && entry.messageId)
    .map(entry => `${entry.id}\u0000${entry.sessionId ?? entry.deliveredSessionId ?? ''}\u0000${entry.deliveredAt}\u0000${entry.messageId}\u0000${entry.state}\u0000${entry.error ?? ''}\u0000${JSON.stringify(entry.workflowReceipt ?? null)}`)
    .sort().join('\u0001');
  const previousOwnerKey = sidebarInputOwnerKey(pendingComposerInputs);
  const previousReceiptKey = deliveryReceiptKey(pendingComposerInputs);
  pendingComposerInputs = all;
  const repaintSessionsForQueue = !inputQueueLoaded || previousOwnerKey !== sidebarInputOwnerKey(all);
  const receiptsChanged = previousReceiptKey !== deliveryReceiptKey(all);
  inputQueueLoaded = true;
  if (repaintSessionsForQueue) paintSessions();
  else if (receiptsChanged || recoveredQueueRead) paintWorkOverview(false);
  if (receiptsChanged && document.getElementById('progressToggle')?.getAttribute('aria-pressed') === 'true')
    paintProgressInbox();
  for (const id of dismissedInputNotices) if (!all.some(entry => entry.id === id)) dismissedInputNotices.delete(id);
  paintDeliveryControls();
  const pending = pendingNewInput;
  const delivered = pending && all.find((entry) => entry.id === pending.id && entry.state === 'sent' && entry.deliveredSessionId);
  if (delivered?.deliveredSessionId && pending && pending.generation === selectionGeneration && newChatSelected && selectedId === null) {
    let summary = sessions.find((entry) => entry.id === delivered.deliveredSessionId);
    if (!summary) summary = (await run(api.getSession(delivered.deliveredSessionId, { limit: 1 })))?.summary ?? undefined;
    if (summary && pendingNewInput === pending && selection === selectionGeneration) {
      pendingNewInput = null;
      mergeSessionRows([summary]);
      // The receipt binds this composer to its new session. Typing a follow-up
      // does not revoke that ownership; explicit navigation changes the epoch.
      const from = draftKey();
      rememberDraft();
      const moveDraft = composerDrafts.canMove(from, summary.id);
      if (moveDraft) {
        inputDrafts.set(summary.id, $<HTMLTextAreaElement>('chatInput').value);
        const images = imageDrafts.get(from);
        if (images) imageDrafts.set(summary.id, images);
      }
      selectSession(summary.id);
      if (moveDraft && composerDrafts.move(from, summary.id)) { inputDrafts.delete(from); imageDrafts.delete(from); }
      else { draftStorageMessage = 'The new chat and original composer both had drafts. Both were retained.'; paintDraftRecovery(); }
      return;
    }
  }
  const belongsToSelection = (entry: { id: string; sessionId: string | null; deliveredSessionId?: string | null }): boolean => selectedId === null
    ? pendingNewInput?.generation === selectionGeneration && entry.id === pendingNewInput.id
    : (entry.sessionId ?? entry.deliveredSessionId) === selectedId;
  paintDeliveryQueue(all, belongsToSelection);
  // Queue polling changes the cross-chat counts, not the already open session's recorded
  // timeline. Skip a second history/progress IPC read on every queue refresh.
  paintWorkOverview(false);
  const queuedTasks = all.filter(entry => belongsToSelection(entry) && queuedFollowup(entry) && ['queued', 'tool', 'browser'].includes(entry.state));
  // The first input already durably owns every later stage. Show that authority
  // until its native receipt materializes the actual queue, without a blank gap.
  const staged = [...all, ...[...startingInputs.values()].filter(entry => !all.some(row => row.id === entry.id))]
    .filter(entry => belongsToSelection(entry) && !entry.stagesApplied && ['queued', 'browser', 'tool'].includes(entry.state));
  const projectedIds = new Set<string>();
  for (const entry of staged) for (const [index, text] of (entry.stages ?? []).entries()) {
    const id = `${entry.id}:stage:${index}`; projectedIds.add(id);
    queuedTasks.push({ ...entry, id, text, mode: 'finish', state: 'browser', stages: undefined });
  }
  const queueSession = selectedId;
  const reorder = async (from: string, to: string, after: boolean) => {
    if (!queueSession || selectedId !== queueSession) return;
    const ids = queuedTasks.filter(row => row.state === 'queued').map(row => row.id);
    if (from === to || !ids.includes(from) || !ids.includes(to)) return;
    ids.splice(ids.indexOf(from), 1);
    ids.splice(ids.indexOf(to) + Number(after), 0, from);
    const saved = await run(api.reorderQueuedInputs(queueSession, ids));
    if (saved === false) toast(t("The queue changed during the move. Try again."));
    void refreshInputQueue();
  };
  const taskList = $('finishQueue'); taskList.hidden = queuedTasks.length === 0;
  const oldCards = new Map([...taskList.children].map(node => [(node as HTMLElement).dataset.inputId, node as HTMLElement]));
  const dragging = !!taskList.querySelector('.is-dragging');
  reconcileChildren(taskList, queuedTasks.map(entry => {
    const existing = oldCards.get(entry.id);
    if (dragging && existing) return existing;
    if (entry.state === 'queued' && existing?.classList.contains('is-editing')) return existing;
    const card = el('div', 'queued-input'); card.dataset.inputId = entry.id;
    if (projectedIds.has(entry.id)) ui(card, 'aria-label', () => t("Plan stage · waiting for the first message to be sent"));
    const label = el('span', 'queue-label', entry.text);
    ui(label, 'title', () => `${entry.state === 'queued' ? (entry.mode === 'after-turn' ? t("After the next completed answer") : t("At Session finish or after a completed answer")) : t("Awaiting receipt")} · ${entry.text}`);
    label.dir = 'auto';
    card.append(icon('i-clock'), label);
    if (entry.state === 'queued') {
      const retireCard = () => { card.remove(); taskList.hidden = taskList.childElementCount === 0; };
      const cancel = dockAction(() => t("Remove queued task"), 'i-trash', () => {});
      cancel.onclick = async () => {
        if (cancel.disabled || !card.isConnected || selection !== selectionGeneration) return;
        cancel.disabled = true;
        const removed = await run(api.cancelInput(entry.id));
        if (!card.isConnected || selection !== selectionGeneration) return;
        if (removed) {
          pendingComposerInputs = pendingComposerInputs.filter(row => row.id !== entry.id);
          retireCard();
          paintDeliveryControls();
          void refreshInputQueue();
        } else if (removed === null) cancel.disabled = false;
      };
      const queueSessionSummary = sessions.find(row => row.id === selectedId);
      const modelSelection = queueSessionSummary?.selectedModel;
      if (entry.mode === 'finish' && modelSelection?.conversationId === queueSessionSummary?.conversationId && isAstraModel(modelSelection?.model, modelSelection?.reasoningEffort)) {
        const delivery = el('button', 'btn queue-delivery', () => entry.afterTurn === true ? t("Also after turn") : t("Finish only")) as HTMLButtonElement;
        delivery.type = 'button';
        ui(delivery, 'aria-label', () => t("Also send this task as a new message after Astra finishes its turn"));
        delivery.setAttribute('aria-pressed', String(entry.afterTurn === true));
        ui(delivery, 'title', () => entry.afterTurn === true ? t("At Session Finish, or as a new message after verified turn completion") : t("Only inside the Session Finish tool result; never start a new turn"));
        delivery.onclick = async () => {
          delivery.disabled = true;
          const saved = await run(api.editQueuedInput(entry.id, entry.text, entry.afterTurn !== true));
          if (saved === null && delivery.isConnected && selection === selectionGeneration) delivery.disabled = false;
          void refreshInputQueue();
        };
        card.append(delivery);
      }
      label.draggable = true;
      label.tabIndex = 0;
      ui(label, 'title', () => t("Drag to reorder. Alt + Up/Down also moves this task."));
      label.ondragstart = event => {
        card.classList.add('is-dragging');
        event.dataTransfer?.setData('application/x-cos-queued-input', `${queueSession}:${entry.id}`);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      };
      label.ondragend = () => { card.classList.remove('is-dragging'); void refreshInputQueue(); };
      card.ondragover = event => {
        if (event.dataTransfer?.types.includes('application/x-cos-queued-input')) {
          event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        }
      };
      card.ondrop = event => {
        const value = event.dataTransfer?.getData('application/x-cos-queued-input') ?? '';
        if (!queueSession || !value.startsWith(`${queueSession}:`)) return;
        event.preventDefault();
        void reorder(value.slice(queueSession.length + 1), entry.id, event.clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
      };
      label.onkeydown = event => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const ids = queuedTasks.filter(row => row.state === 'queued').map(row => row.id);
        const next = ids[ids.indexOf(entry.id) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) void reorder(entry.id, next, event.key === 'ArrowDown');
      };
      const edit = dockAction(() => t("Edit queued task"), 'i-pencil', () => {});
        edit.disabled = !!entry.workflow;
        if (entry.workflow) edit.title = 'Edit the recipe source and start a new run to change this task.';
      edit.onclick = () => {
        const field = document.createElement('textarea'); field.dir = 'auto'; field.value = entry.text; ui(field, 'aria-label', () => t("Queued task"));
        const contents = [...card.childNodes];
        const save = el('button', 'btn', () => t("Save")) as HTMLButtonElement; save.type = 'button';
        save.onclick = async () => {
          if (save.disabled) return;
          const value = field.value;
          save.disabled = true; ui(save, 'textContent', () => t("Saving…")); field.readOnly = true;
          try {
            const saved = await run(api.editQueuedInput(entry.id, value));
            if (!card.isConnected || selection !== selectionGeneration) return;
            if (saved) {
              // The durable edit receipt ends editing, regardless of focus or a slower
              // queue refresh. Refreshes preserve drafts; they do not own Save completion.
              entry.text = value.trim(); label.textContent = entry.text;
              card.classList.remove('is-editing'); card.replaceChildren(...contents);
              void refreshInputQueue();
            } else if (saved === false) {
              toast(t("This task is no longer queued and could not be edited."));
              ui(save, 'textContent', () => t("Save"));
            } else {
              save.disabled = false; ui(save, 'textContent', () => t("Save")); field.readOnly = false;
            }
          } catch (error) {
            toast(error instanceof Error ? error.message : t("Could not save this task."));
            if (card.isConnected && selection === selectionGeneration) {
              save.disabled = false; ui(save, 'textContent', () => t("Save")); field.readOnly = false;
            }
          }
        };
        card.classList.add('is-editing'); card.replaceChildren(field, save); field.focus();
      };
      card.append(edit, cancel);
    }
    return card;
  }));
  // Active unbound sends still occupy the global admission limit after New Chat or
  // restart. Show that existing outbox authority, without reviving terminal drafts.
  const unbound = (entry: InputEntry) => selectedId === null && !entry.sessionId && !entry.deliveredSessionId && entry.purpose !== 'decision' && ['queued', 'browser'].includes(entry.state);
  const latestSelectedNoticeIds = latestDeliveryNoticeIds(all, selectedDeliveryNoticeCandidate);
  const notice = (entry: InputEntry) => (belongsToSelection(entry) || (selectedId === null && !entry.sessionId && !entry.deliveredSessionId)) && entry.purpose !== 'decision' &&
    latestSelectedNoticeIds.has(entry.id) && ['failed', 'cancelled'].includes(entry.state) && !!entry.error && !dismissedInputNotices.has(entry.id) &&
    (entry.state !== 'cancelled' || !cancellationKnownUnsent(entry));
  const rows = all.filter((entry) => !dismissedInputNotices.has(entry.id) && !(entry.state === 'tool' && entry.historyRecorded) && !(queuedFollowup(entry) && ['queued', 'tool', 'browser'].includes(entry.state)) && (belongsToSelection(entry) || unbound(entry) || notice(entry)) &&
    (notice(entry) || unbound(entry) || selectedId !== null || projectGroup(entry.projectId) === selectedProjectId) &&
    (notice(entry) || !['sent', 'cancelled'].includes(entry.state) || (entry.state === 'sent' && entry.messageId && !entry.historyRecorded)));
  for (const entry of startingInputs.values()) if (belongsToSelection(entry) && !all.some(row => row.id === entry.id)) rows.push(entry);
  $('inputQueue').replaceChildren(...rows.filter(entry => !historicalAutomaticInput(entry)).map(entry => inputMessageRow(entry, notice(entry))));
  paintDetail(false);
  $('timelineEmpty').hidden = events.length > 0 || rows.length > 0;
  const selectedHelpers = (pausedHelpers ?? []).filter(helper => helper.sourceSessionId === selectedId);
  const helperExhausted = selectedId !== null && goalDraftView?.error === 'goal_browser_helper_exhausted';
  if (selectedHelpers.length > 0 || helperExhausted) {
    const helper = selectedHelpers.at(-1) ?? null;
    const sourceSessionId = helper?.sourceSessionId ?? selectedId!;
    const helperSelection = selectionGeneration;
    const row = el('div', 'queued-input');
    const helperCurrent = () => selectionGeneration === helperSelection && selectedId === sourceSessionId && row.isConnected;
    const explainAccountPause = () => {
      if (deps.state()?.config.ui.automationPaused !== true) return false;
      toast(t('Automation is paused for this account. Resume automation to continue this saved chat; saved work is unchanged.'));
      return true;
    };
    const recoveryRejected = (button: HTMLElement) => {
      if (!helperCurrent()) return;
      button.removeAttribute('disabled');
      toast(t('CoS could not complete this chat recovery request. Saved work is unchanged; check the account window and try again.'));
      console.warn('[Chat On Steroids] selected-chat recovery IPC rejected; saved work unchanged');
    };
    if (helperExhausted && goalDraftView?.message) row.append(el('span', '', () => goalDraftView!.message!));
    if (selectedHelpers.length > 0) row.append(el('span', '', () => t(selectedHelpers.length === 1
      ? "This exact saved turn has one unconfirmed helper owner. No message will be replayed."
      : "{0} old helper owners were collapsed behind this one exact saved turn. No message will be replayed.", [selectedHelpers.length])));
    else row.append(el('span', '', () => t("This exact saved turn is still owed. Restarting it does not replay any user message.")));
    const retry = el('button', 'btn', () => t("Restart helper"));
    retry.setAttribute('type', 'button');
    retry.onclick = async () => {
      if (!helperCurrent() || retry.hasAttribute('disabled') || explainAccountPause()) return;
      retry.setAttribute('disabled', '');
      try {
        if (helper) {
          const accepted = await run(api.retryHelper(helper.id, helper.sourceSessionId));
          if (!helperCurrent()) return;
          if (accepted) toast(t("New helper authorized for this chat"));
          else if (accepted === false) toast(t("This helper has changed. Refreshing its status."));
          else if (retry.isConnected) retry.removeAttribute('disabled');
          void refreshInputQueue();
          return;
        }
        const result = await run(api.resumeAutomationChat(sourceSessionId));
        if (!helperCurrent()) return;
        if (result && explainAccountPause()) retry.removeAttribute('disabled');
        else if (result) toast(t('Exact chat recovery: {0} queued, {1} working, {2} recovering, {3} reply restored.', [
          result.queued, result.alreadyActive, result.recovering, result.rearmed
        ]));
        else if (retry.isConnected) retry.removeAttribute('disabled');
        await refreshAll();
      } catch {
        recoveryRejected(retry);
      }
    };
    const resume = el('button', 'btn', () => t("Resume this chat"));
    resume.setAttribute('type', 'button');
    resume.onclick = async () => {
      if (!helperCurrent() || resume.hasAttribute('disabled') || explainAccountPause()) return;
      resume.setAttribute('disabled', '');
      try {
        const result = await run(api.resumeAutomationChat(sourceSessionId));
        if (!helperCurrent()) return;
        if (result && explainAccountPause()) resume.removeAttribute('disabled');
        else if (result) toast(t('Exact chat recovery: {0} queued, {1} working, {2} recovering, {3} reply restored.', [
          result.queued, result.alreadyActive, result.recovering, result.rearmed
        ]));
        else if (resume.isConnected) resume.removeAttribute('disabled');
        await refreshAll();
      } catch {
        recoveryRejected(resume);
      }
    };
    row.append(retry, resume);
    $('inputQueue').append(row);
  }
}
async function retryPlannedInput(entry: InputEntry): Promise<void> {
  if (dismissedInputNotices.has(entry.id) || entry.stagesApplied || !['failed', 'cancelled'].includes(entry.state)) return;
  // The outbox retains the authored workflow after failure. Retry that payload, not
  // its stage-one display text, and never revive the old browser claim/receipt.
  const { sessionId, projectId, nickname, text, objective, stages, images, attachments, attachmentDelivery, automation, loopAfterTurn, model, reasoningEffort, afterTurn } = entry;
  const args: InputArgs = { id: crypto.randomUUID(), sessionId, projectId, nickname, text, objective, stages, images, attachments, attachmentDelivery,
    automation, loopAfterTurn, model, reasoningEffort, afterTurn, mode: entry.requestedMode ?? entry.mode, dueAt: Date.now() };
  const generation = selectionGeneration;
  // Hide during the attempt, but persist dismissal only after its replacement is durable.
  dismissedInputNotices.add(entry.id); void refreshInputQueue();
  let accepted = false;
  try {
    if (entry.error === 'Requested model or reasoning could not be confirmed') {
      const selection = await ensureComposerModel(true);
      if (generation !== selectionGeneration || cancelledStarts.has(args.id)) return;
      if (!selection) { toast(t("Model refresh could not confirm your selection. Choose an available model, then retry the plan.")); return; }
      Object.assign(args, selection);
    }
    startingInputs.set(args.id, { ...args, state: 'queued', owner: null, createdAt: args.dueAt, conversationId: null });
    if (sessionId === null) pendingNewInput = { id: args.id, generation };
    paintDeliveryControls(); void refreshInputQueue();
    const result = await run(api.sendInput(args));
    if (cancelledStarts.has(args.id)) return;
    if (!result) return;
    accepted = true;
    inputQueueGeneration++;
    pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== result.id), result];
  } finally {
    if (accepted) dismissInputNotice(entry.id);
    if (!accepted && !cancelledStarts.has(args.id)) dismissedInputNotices.delete(entry.id);
    if (!accepted && pendingNewInput?.id === args.id) pendingNewInput = null;
    cancelledStarts.delete(args.id); startingInputs.delete(args.id);
    paintDeliveryControls(); void refreshInputQueue();
  }
}
async function stopCurrentTurn(): Promise<void> {
  const id = selectedId, turnId = controlledTurnId, generation = selectionGeneration;
  if (!id || !selectedControlsMatchCurrentBinding() || controlledSelection !== generation || !turnId || controlledStopPending) return;
  controlledStopPending = true; paintDeliveryControls();
  try { await run(api.stopSessionTurn(id, turnId)); }
  finally { if (selectedId === id && selectionGeneration === generation) { controlledStopPending = false; void refreshSessionControls(); } }
}
let composerDiscoveryGeneration = 0;
async function sendComposer(delivery?: 'finish', plan?: string[], planObjective?: string): Promise<boolean | void> {
  const input = $<HTMLTextAreaElement>('chatInput');
  const key = draftKey();
  const projectId = selectedId ? sessions.find(row => row.id === selectedId)?.projectId ?? null : selectedProjectId;
  const images = imageDrafts.get(key) ?? [];
  const text = plan?.[0] ?? (input.value.trim() || (images.length ? 'Please look at the attached files.' : ''));
  if ($<HTMLButtonElement>('chatSend').disabled) return;
  if (!text) {
    const target = selectedId, selection = selectionGeneration;
    const sameSelection = () => selectedId === target && selectionGeneration === selection;
    await refreshSessionControls();
    if (!sameSelection()) return;
    // An actual turn takes precedence over queued follow-ups. Stop never silently
    // becomes cancellation of a different pending input in that same chat.
    if (target && selectedControlsMatchCurrentBinding() && controlledSelection === selection && controlledTurnId) {
      await stopCurrentTurn(); return;
    }
    const pending = pendingComposerInput();
    if (pending && ['queued', 'browser'].includes(pending.state)) {
      const wasStarting = startingInputs.has(pending.id);
      if (wasStarting) cancelledStarts.add(pending.id);
      const cancelled = await run(api.cancelInput(pending.id));
      if (cancelled) {
        startingInputs.delete(pending.id);
        pendingComposerInputs = pendingComposerInputs.filter(row => row.id !== pending.id);
        // Do not persist a notice dismissal from this pre-cancel snapshot. If Send authorization
        // won the race, the authoritative cancelled row must reappear as ambiguous on refresh.
        paintDeliveryControls();
      } else {
        cancelledStarts.delete(pending.id);
        if (sameSelection()) { await refreshSessionControls(); if (sameSelection()) await stopCurrentTurn(); }
      }
      void refreshInputQueue();
    }
    return;
  }
  // A pending authored admission fences another send, while the empty-composer
  // Stop/cancel path above retains its exact current-turn/outbox authority.
  if (composerSending.has(key)) return false;
  const discoveryGeneration = ++composerDiscoveryGeneration;
  const discoverySelection = selectionGeneration, discoverySession = selectedId, discoveryDraft = input.value;
  const modelSettings = confirmedComposerModel() ?? await ensureComposerModel();
  // Discovery can outlive navigation or draft edits. Only the latest unchanged
  // authored send may continue; a second click must never send the same text twice.
  if (discoveryGeneration !== composerDiscoveryGeneration || discoverySelection !== selectionGeneration || discoverySession !== selectedId ||
      input.value !== discoveryDraft || (imageDrafts.get(key) ?? []).some((image, index) => image !== images[index]) ||
      (imageDrafts.get(key)?.length ?? 0) !== images.length) return false;
  if (!modelSettings) { toast(t("Model discovery could not confirm your selection. Choose an available model and thinking effort, then send again.")); return false; }
  const sessionId = selectedId;
  const generation = selectionGeneration;
  const chosenMode = delivery ?? $<HTMLSelectElement>('sendMode').value;
  const mode = chosenMode === 'after-turn' && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledQueueAtFinish ? 'finish' : chosenMode;
  const dueAt = Date.now();
  const id = crypto.randomUUID();
  rememberDraft();
  // A prepared plan still retains its authored request. A generated stage can be
  // sent from an empty composer, so retain that exact body as its recovery draft.
  const draft = composerDrafts.get(key) ?? composerDrafts.record(key, text, images);
  if (!draft || draft.pending) { paintDraftRecovery(); return false; }
  if (!draftRestoreComplete || deps.account?.()?.id !== composerDrafts.snapshot().profileId) {
    draftStorageMessage = 'Draft storage is waiting for the active account and project list. Your text was retained; send again after recovery is ready.';
    paintDraftRecovery(); return false;
  }
  const attachmentPayload = { images: images.filter((file): file is InputImage => 'dataUrl' in file), attachments: images.filter((file): file is InputAttachment => 'id' in file),
    ...(mode === 'auto' && !plan && selectedId && controlledSessionId === selectedId && controlledSelection === generation &&
      controlledCanInject && images.some(file => 'id' in file) && injectableAttachments(images) ? { attachmentDelivery: 'tool' as const } : {}) };
  const objective = plan ? planObjective : mode === 'finish' ? undefined : $<HTMLTextAreaElement>('sessionObjective').value.trim() || undefined;
  composerSending.add(key); paintDeliveryControls();
  if (!await composerDrafts.beginAdmission(key, draft.generation, { inputId: id, text, sessionId, projectId }) ||
      selectionGeneration !== generation || selectedId !== sessionId || deps.account?.()?.id !== composerDrafts.snapshot().profileId) {
    composerDrafts.abandon(key, draft.generation, id);
    composerSending.delete(key); paintDraftRecovery(); paintDeliveryControls(); return false;
  }
  startingInputs.set(id, { id, sessionId, projectId, text, ...attachmentPayload, stages: plan?.slice(1), objective, mode: mode === 'finish' ? 'finish' : mode === 'auto' ? 'auto' : 'after-turn',
    dueAt, ...modelSettings, state: 'queued', owner: null, createdAt: dueAt, conversationId: null });
  if (sessionId === null) pendingNewInput = { id, generation };
  void refreshInputQueue();
  paintDeliveryControls();
  try {
    const result = await run(api.sendInput({ id, sessionId, projectId, text, ...attachmentPayload, stages: plan?.slice(1), objective, automation: mode === 'finish' ? undefined : $<HTMLSelectElement>('chatAutomation').value as InputAutomation, loopAfterTurn: openingLoopDelivery(), mode: mode === 'finish' ? 'finish' : mode === 'auto' ? 'auto' : 'after-turn', dueAt, ...modelSettings }));
    if (cancelledStarts.has(id)) return;
    if (!result) {
      // An IPC failure does not prove whether Main accepted the input. Retain the
      // exact ID and text for reconciliation; a reload never blindly resends it.
      paintDraftRecovery();
      if (pendingNewInput?.id === id) pendingNewInput = null;
      return;
    }
    // A late durable ACK may clear only the submitted unchanged generation.
    // New text/attachments typed while admission was pending keep their own draft.
    settleDraftAdmission(key, draft.generation, id);
    // The accepted IPC result is newer than any queue read started before it. Keep
    // that durable row visible while the next listing crosses the process boundary.
    inputQueueGeneration++;
    pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== result.id), result];
    if (sessionId === null && selectionGeneration === generation && pendingNewInput?.id === id && result.automation &&
        ($<HTMLSelectElement>('chatAutomation').value !== result.automation || openingLoopDelivery() !== result.loopAfterTurn))
      await run(api.setInputAutomation(result.id, $<HTMLSelectElement>('chatAutomation').value as InputAutomation, openingLoopDelivery()));
    if (sessionId === null && selectionGeneration === generation) pendingNewInput = { id: result.id, generation };
    $('composerStatus').textContent = '';
    void refreshInputQueue();
    return true;
  } finally { composerSending.delete(key); cancelledStarts.delete(id); startingInputs.delete(id); paintDraftRecovery(); paintDeliveryControls(); void refreshInputQueue(); }
}

// ------------------------------------------------------------------- wiring

/**
 * Switches the session card's body.
 *
 * Settings is reachable only from the gear, so it is deliberately not one of the switcher
 * buttons: while it is open no switcher button is selected, and the gear itself carries
 * the selected state instead. That is what keeps a property sheet from reading as a third
 * view of this session.
 */
export function openChatView(name: string): void {
  showView(name);
}

function showView(name: string): void {
  $('composer').hidden = name === 'settings';
  $('composerDock').hidden = name === 'settings';
  $('inputQueue').hidden = name !== 'timeline';
  for (const button of $('chatView').querySelectorAll<HTMLButtonElement>('[data-view]')) {
    button.classList.toggle('is-sel', button.dataset.view === name);
  }
  for (const view of document.querySelectorAll<HTMLElement>('#chatBody > .view')) {
    view.hidden = view.dataset.view !== name;
  }
  const progress = document.getElementById('progressToggle') as HTMLButtonElement | null;
  if (progress) {
    const active = name === 'progress';
    progress.setAttribute('aria-pressed', String(active));
    const label = progress.querySelector('span'); if (label) label.textContent = active ? 'Timeline' : 'Progress';
  }
  $('chatSettingsBtn').classList.toggle('is-on', name === 'settings');
  if (name === 'progress') { void refreshProgressOrigin(); void refreshProgressEvents(); paintProgressInbox(); }
}

function selectSession(id: string): void {
  // Capture the current surface before repaint/load work can touch any view DOM. Selection is a
  // data change, not navigation: if the user is reading Progress, keep that surface authoritative
  // and refresh it for the new session rather than showing an empty projection until a view toggle.
  const progressWasOpen = document.getElementById('progressToggle')?.getAttribute('aria-pressed') === 'true' ||
    document.querySelector<HTMLElement>('#chatBody > .view[data-view="progress"]')?.hidden === false;
  if (!restoringDraftSelection) rememberDraft();
  selectionGeneration++;
  timelineFollowBottom = true;
  newChatSelected = false;
  selectedId = id;
  const selected = sessions.find(row => row.id === id);
  applyComposerSessionModel(`${id}:${selectionGeneration}`, selected?.selectedModel ?? null);
  const parent = selected?.origin?.kind === 'worker' ? selected.origin.fromSessionId : null;
  if (parent) expandedWorkers.add(parent);
  selectedProjectId = projectGroup(parent ? sessions.find(row => row.id === parent)?.projectId : selected?.projectId);
  if (selectedProjectId) collapsedProjects.delete(selectedProjectId);
  ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => t("Ask anything…"));
  restoreDraft();
  detailFor = null;
  detailCursor = null;
  forgetTimelineRows();
  handoff = null;
  handoffFor = null;
  if (progressOrigin?.sessionId !== id) progressOrigin = null;
  progressOriginLoadingFor = null;
  if (progressEventsFor !== id) { progressEventsFor = null; progressEventsConversationId = null; progressEvents = []; }
  progressEventsLoadingFor = null;
  paintSessions();
  void loadDetail();
  void refreshInputQueue();
  if (progressWasOpen) showView('progress');
}

function selectNewChat(projectId: string | null = null): void {
  if (!restoringDraftSelection) rememberDraft();
  selectionGeneration++; pendingNewInput = null; timelineFollowBottom = true;
  newChatSelected = true; selectedId = null; selectedProjectId = projectId; detailFor = null; detailCursor = null;
  applyComposerSessionModel(null, null);
  cancelTaskPlan();
  $('inputQueue').replaceChildren();
  restoreDraft(); showView('timeline'); paintSessions(); void loadDetail();
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    $('composer').animate?.([{ opacity: 0.45 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
  }
  ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => projectId ? t("Message in {0}…", [projects.find(project => project.id === projectId)?.name ?? 'project']) : t("Ask anything…"));
  $<HTMLTextAreaElement>('chatInput').focus();
}

export function initChat(next: Deps): void {
  initWorkOverviewAccessibility();
  sidebarOrder = createSidebarOrder($('sessionList'), () => sessions
    .filter(entry => entry.conversationId && entry.origin?.kind !== 'worker')
    .map(entry => ({ id: entry.id, scope: pinnedSortScope(sidebarScope(entry), sidebarPins.has(entry.id)) })), paintSessions);
  deps = next;
  document.getElementById('inspectCurrentWork')?.addEventListener('click', event => {
    if (selectedId) openWorkOverviewPane(selectedId, event.currentTarget as HTMLButtonElement);
  });
  initChatSearch({
    selectedId: () => selectedId,
    recent: () => sessions.filter(row => row.origin?.kind !== 'helper').map(row => ({ id: row.id, title: row.title })),
    beforeOpen: () => closeSessionContextMenu(),
    select: (id, match) => {
      void (async () => {
        const location = match ? await run(api.locateSessionSearchMatch(id, match)) : null;
        pendingSearchTarget = location ? { sessionId: id, seq: location.seq } : null;
        selectSession(id);
      })();
    }
  });
  $('suppressMajorityAlarm').addEventListener('click', suppressCurrentMajorityAlarm);
  skillsController = createSkills({
    api,
    input: $<HTMLTextAreaElement>('chatInput'),
    getDraftIdentity: () => `${selectionGeneration}:${draftKey()}`
  });
  const agentToggle = el('button', 'btn btn-icon', '◫') as HTMLButtonElement;
  agentToggle.id = 'agentPanelToggle'; agentToggle.type = 'button'; agentToggle.hidden = true;
  ui(agentToggle, 'aria-label', () => t("Toggle sub-agent side panel")); agentToggle.setAttribute('aria-expanded', 'false');
  $('themeBtn').before(agentToggle);
  const agentToolGroups = new Map<string, HTMLDetailsElement>();
  agentPanel = createAgentPanel({
    host: document.querySelector<HTMLElement>('[data-panel="chat"]')!, toggle: agentToggle,
    load: id => run(api.getSession(id, { limit: 160 })), openMain: selectSession, working: sessionWorking,
    agent: worker => swarm?.agents.find(entry => entry.role === 'worker' && entry.id === worker.origin?.agentId &&
      !!entry.conversationId && entry.conversationId === worker.conversationId) ?? null,
    render: (source, id, current) => {
      let boundary = '';
      const rows = boundedTimeline(source).shown.flatMap(event => {
        if (!['tool_call', 'page_tool', 'agent_message'].includes(event.kind)) boundary = `event:${event.seq}`;
        if (!['user_message', 'assistant_message', 'tool_call', 'page_tool', 'agent_message', 'chat_error'].includes(event.kind)) return [];
        const row = el('div', `ev ev-${event.kind}`); const body = el('div', 'ev-body');
        row.dataset.timelineKey = `event:${event.seq}`; row.dataset.activityBoundary = boundary;
        body.append(eventBody(event, { id, current, history: source })); row.append(body); return [row];
      });
      return groupToolRows(rows, `pane:${id}`, agentToolGroups);
    }
  });
  initChatModels(() => {
    refreshComposerTarget();
    paintLoopDelivery();
    const config = deps.state()?.config;
    if (config) paintContextMeter(sessions.find(session => session.id === selectedId) ?? null, config, confirmedComposerModel());
  });
  $('queueAtFinish').addEventListener('click', () => {
    if ($('queueAtFinish').hidden) return;
    $<HTMLSelectElement>('sendMode').value = 'after-turn';
    const input = $<HTMLTextAreaElement>('chatInput');
    if (input.value.trim() || imageDrafts.get(draftKey())?.length) void sendComposer('finish');
    else { input.focus(); paintDeliveryControls(); }
  });
  $('sendOptions').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-delivery]');
    if (!button || $('sendOptions').hidden) return;
    $<HTMLSelectElement>('sendMode').value = button.dataset.delivery!;
    paintDeliveryControls();
  });
  $('automationSwitch').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
    if (!button || button.disabled) return;
    const select = $<HTMLSelectElement>('chatAutomation');
    select.value = button.dataset.mode!;
    select.dispatchEvent(new Event('change'));
  });
  $('chatAutomation').addEventListener('change', async () => {
    goalIntentGeneration++;
    const select = $<HTMLSelectElement>('chatAutomation');
    cancelGoalRequest();
    if (select.value === 'off') goalDraftView = null;
    select.dataset.edited = 'true'; paintAutomationSwitch();
    const id = selectedId, generation = selectionGeneration;
    const mode = select.value as InputAutomation;
    if (!id) {
      const pending = pendingNewInput;
      if (pending?.generation === generation) {
        // Before admission there is no durable row to roll back to. Preserve this newer intent;
        // sendComposer() applies it after the accepted row is published. Once accepted, however,
        // a failed mutation must not leave the switch claiming a mode the outbox never stored.
        const accepted = pendingComposerInputs.some(row => row.id === pending.id);
        const saved = await run(api.setInputAutomation(pending.id, mode));
        if (!saved && accepted) await reconcileAcceptedOpeningAutomation(pending.id, generation, mode);
      }
      return;
    }
    select.disabled = true; paintAutomationSwitch();
    try {
      const updated = await run(api.setSessionAutomation(id, mode));
      if (updated && mode === 'off') toast(t('This chat will pause after its current turn and running workers finish.'));
    }
    finally {
      select.disabled = false;
      if (id === selectedId && generation === selectionGeneration) { delete select.dataset.edited; void refreshSessionControls(); }
      paintAutomationSwitch();
    }
  });
  $('loopDelivery').addEventListener('change', async () => {
    const id = selectedId, generation = selectionGeneration;
    const select = $<HTMLSelectElement>('loopDelivery');
    if (!id) {
      const pending = pendingNewInput;
      if (pending?.generation === generation) {
        const afterTurn = select.value === 'after-turn';
        const accepted = pendingComposerInputs.some(row => row.id === pending.id);
        const saved = await run(api.setInputAutomation(pending.id, $<HTMLSelectElement>('chatAutomation').value as InputAutomation, afterTurn));
        if (!saved && accepted) await reconcileAcceptedOpeningLoopDelivery(pending.id, generation, afterTurn);
      }
      return;
    }
    select.disabled = true;
    try { await run(api.setSessionAutomation(id, 'loop', select.value === 'after-turn')); }
    finally {
      select.disabled = false;
      if (id === selectedId && generation === selectionGeneration) void refreshSessionControls();
    }
  });
  $('sessionObjective').addEventListener('input', () => { cancelGoalRequest(); goalIntentGeneration++; $('sessionObjective').dataset.edited = 'true'; delete $('sessionObjective').dataset.saved; paintTaskActions(); });
  $('sessionObjectiveMode').addEventListener('change', () => { cancelGoalRequest(); goalIntentGeneration++; $('sessionObjective').dataset.edited = 'true'; delete $('sessionObjective').dataset.saved; paintTaskActions(); });
  for (const buttonId of ['saveSessionObjective'] as const) {
    $(buttonId).addEventListener('click', async () => {
      const id = selectedId;
      const objective = $<HTMLTextAreaElement>('sessionObjective');
      if (!id) {
        const draft = objective.value, mode = $<HTMLSelectElement>('sessionObjectiveMode').value as 'goal' | 'loop';
        if (!draft.trim()) return;
        const settings = confirmedComposerModel();
        if (!settings) { toast('Reload model choices and select an available model and thinking effort before sending.'); return; }
        const selection = selectionGeneration, intent = goalIntentGeneration, requestId = crypto.randomUUID();
        const projectId = selectedProjectId;
        const { model, reasoningEffort } = settings;
        const automation = $<HTMLSelectElement>('chatAutomation');
        automation.value = mode;
        automation.dataset.edited = 'true'; paintAutomationSwitch();
        goalProgress = { requestId, selection, phase: 'preparing', text: '' };
        const button = $<HTMLButtonElement>(buttonId); button.dataset.busy = 'true'; paintTaskActions(); paintGoalProgress();
        const current = () => selectedId === null && selectionGeneration === selection && goalIntentGeneration === intent && objective.value === draft && automation.value === mode;
        try {
          const result = await api.draftGoalOpening(draft.trim(), mode, requestId);
          const opening = result.ok ? result.data : null;
          if (!result.ok && current() && goalProgress?.requestId === requestId) goalProgress.error = result.error;
          if (!current()) { if (goalProgress?.requestId === requestId) { goalProgress.phase = 'paused'; paintGoalProgress(); } return; }
          if (!opening) { if (goalProgress?.requestId === requestId) { goalProgress.phase = 'failed'; goalProgress.error ||= 'Opening message generation failed'; paintGoalProgress(); } return; }
          const dueAt = Date.now(), inputId = crypto.randomUUID();
          const entry: InputEntry = { id: inputId, sessionId: null, projectId, text: opening.reply, objective: draft.trim(), automation: mode,
            loopAfterTurn: openingLoopDelivery(mode),
            mode: 'auto', dueAt, model, reasoningEffort, state: 'queued', owner: null, createdAt: dueAt, conversationId: null };
          startingInputs.set(inputId, entry); pendingNewInput = { id: inputId, generation: selection };
          goalProgress = { requestId, selection, inputId, phase: 'queued', text: '' }; paintDeliveryControls();
          try {
            const accepted = await run(api.sendInput(entry));
            if (accepted) { inputQueueGeneration++; pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== inputId), accepted];
              // Off may arrive while sendInput is still validating/enqueuing, before
              // the outbox row exists. Reconcile that same pending intent after acceptance.
              if (selectionGeneration === selection && pendingNewInput?.id === inputId &&
                  (automation.value !== mode || openingLoopDelivery(mode) !== entry.loopAfterTurn))
                await run(api.setInputAutomation(inputId, automation.value as InputAutomation, openingLoopDelivery(mode)));
              if (current()) objective.dataset.saved = draft;
            } else if (goalProgress?.requestId === requestId) { goalProgress.phase = 'failed'; goalProgress.error = 'Opening message could not be queued'; }
          } finally { startingInputs.delete(inputId); paintDeliveryControls(); void refreshInputQueue(); }
        } finally { delete button.dataset.busy; paintTaskActions(); }
        return;
      }
      if (objective.dataset.sessionId !== id) return;
      const selection = selectionGeneration, draft = objective.value;
      const text = objective.value.trim();
      if (!text) return;
      const mode = $<HTMLSelectElement>('sessionObjectiveMode').value as 'goal' | 'loop';
      const button = $<HTMLButtonElement>(buttonId); button.dataset.busy = 'true'; paintTaskActions();
      const requestId = crypto.randomUUID(); goalProgress = { requestId, selection, phase: 'saving', text: '' }; paintGoalProgress();
      try {
        const saved = await run(api.setSessionObjective(id, text, mode));
        if (goalProgress?.requestId === requestId) { goalProgress.phase = saved ? 'saved' : 'failed'; if (!saved) goalProgress.error = 'Task could not be saved'; paintGoalProgress(); }
        if (saved && selectedId === id && selectionGeneration === selection && objective.value === draft &&
            $<HTMLSelectElement>('sessionObjectiveMode').value === mode) { delete objective.dataset.edited; objective.dataset.saved = objective.value; }
      } finally {
        delete button.dataset.busy; paintTaskActions();
        if (selectedId === id) void refreshSessionControls();
      }
    });
  }
  for (const [buttonId, cancel] of [['compactSession', false], ['cancelCompaction', true]] as const) {
    $(buttonId).addEventListener('click', async () => {
      const id = selectedId; if (!id) return;
      const button = $<HTMLButtonElement>(buttonId); button.disabled = true;
      const expectedToken = button.dataset.resumeToken;
      if (cancel && (button.dataset.resumeSessionId !== id || !expectedToken)) { button.disabled = false; return; }
      try { await run(cancel ? api.cancelSessionCompaction(id, expectedToken!) : api.compactSession(id)); }
      finally { button.disabled = false; if (selectedId === id) void refreshSessionControls(); }
    });
  }
  const appendImages = (key: string, chosen: InputAttachment[] | null | undefined): void => {
    if (!chosen?.length) return;
    const combined = [...(imageDrafts.get(key) ?? []), ...chosen];
    if (combined.length > 20 || combined.reduce((sum, file) => sum + ('size' in file ? file.size : 0), 0) > 512 * 1024 * 1024) { toast(t("Attach up to 20 files and 512 MB per message")); return; }
    imageDrafts.set(key, combined); persistDraftKey(key); if (draftKey() === key) paintComposerImages();
  };
  $('attachImages').addEventListener('click', async () => {
    const key = draftKey();
    appendImages(key, await run(api.chooseFiles()));
  });
  $('generateFinishGoal').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('generateFinishGoal'), id = selectedId, turnId = controlledTurnId;
    if (!id || !turnId || button.hidden || button.disabled || controlledSessionId !== id || controlledSelection !== selectionGeneration) return;
    const owner = `${id}:${turnId}`;
    button.dataset.busy = owner; paintDeliveryControls();
    try { await run(api.generateFinishGoal(id, turnId)); }
    finally {
      if (button.dataset.busy === owner) delete button.dataset.busy;
      if (selectedId === id) void refreshSessionControls();
      else paintDeliveryControls();
    }
  });
  $('composer').addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.some(type => type === 'Files' || type === 'text/plain')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  });
  $('composer').addEventListener('drop', async event => {
    if (!event.dataTransfer?.types.some(type => type === 'Files' || type === 'text/plain')) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files), key = draftKey();
    if (!files.length) { const text = event.dataTransfer.getData('text/plain'); if (text) { const file = await run(api.attachText(text)); if (file) appendImages(key, [file]); } return; }
    if (files.length + (imageDrafts.get(key)?.length ?? 0) > 20) { toast('Attach up to 20 files per message'); return; }
    appendImages(key, await run(api.dropFiles(files)));
  });
  $('chatInput').addEventListener('paste', async event => {
    const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    const key = draftKey();
    if (files.length + (imageDrafts.get(key)?.length ?? 0) > 20) { toast('Attach up to 20 files per message'); return; }
    appendImages(key, await run(api.dropFiles(files)));
  });
  api.onWriteSession?.(id => { selectSession(id); $<HTMLTextAreaElement>('chatInput').focus(); });
  $('newChat').addEventListener('click', () => {
    selectNewChat();
  });
  $('addProject').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('addProject'); button.disabled = true;
    const generation = selectionGeneration;
    try {
      const project = await run(api.addProject());
      if (!project) return;
      // The picker published a newer durable catalog. A list refresh started before it
      // may still return an empty catalog and otherwise erase this sidebar group.
      ++sessionsLoadGeneration;
      projects = [...projects.filter(row => row.id !== project.id), project];
      collapsedProjects.delete(project.id);
      if (generation === selectionGeneration) selectNewChat(project.id); else paintSessions();
    } finally { button.disabled = false; }
  });
  $('settingsSearch').addEventListener('input', () => {
    filterSettingsSections(document.querySelector<HTMLElement>('[data-view="settings"]')!, $<HTMLInputElement>('settingsSearch').value);
  });
  const composerMenus = [...document.querySelectorAll<HTMLDetailsElement>('.composer-menu, .session-controls, .conversation-actions-menu')];
  document.addEventListener('click', (event) => {
    for (const menu of composerMenus) if (!menu.contains(event.target as Node) || ((event.target as HTMLElement).closest('button') && !(event.target as HTMLElement).closest('[data-keep-menu]'))) menu.open = false;
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') for (const menu of composerMenus) menu.open = false; });
  $('chatInput').addEventListener('input', () => {
    rememberDraft();
    skillsController?.onInput();
    const hasText = !!$<HTMLTextAreaElement>('chatInput').value.trim();
    const plan = taskPlans.get(draftKey());
    if (plan && !plan.stages && (plan.requestId || !hasText)) {
      cancelTaskPlan();
      if (hasText) taskPlans.set(draftKey(), { text: '', requestId: null, stages: null, sending: false, progress: null, error: null });
    }
    paintDeliveryControls(); paintTaskActions();
  });
  $('chatInput').addEventListener('keydown', (event) => {
    if (skillsController?.onKeydown(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (currentPreparedPlan() || $<HTMLTextAreaElement>('chatInput').value.trim() || imageDrafts.get(draftKey())?.length) $<HTMLFormElement>('composer').requestSubmit(); }
  });
  $('composerSettings').addEventListener('toggle', paintTaskActions);
  initContextMeter();
  $('createPlan').addEventListener('click', () => { if (taskPlans.has(draftKey())) cancelTaskPlan(); else void createTaskPlan(deps.state()?.config.ui.planBackend ?? 'chatgpt'); });
  $('composer').addEventListener('submit', (event) => { event.preventDefault(); if (currentPreparedPlan()) void sendPreparedPlan(); else if (taskPlans.has(draftKey())) { if (!$('createPlan').dataset.busy) void createTaskPlan(deps.state()?.config.ui.planBackend ?? 'chatgpt'); } else void sendComposer(); });
  $('clearSessionSelection').addEventListener('click', () => clearSessionSelection());

  $('sessionList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-id]');
    const id = row?.dataset.id;
    if (!id) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      toggleSessionSelection(id);
      paintSessions();
      return;
    }
    if (event.shiftKey && multiSelectAnchor) {
      event.preventDefault();
      extendSessionSelection(id);
      paintSessions();
      return;
    }
    multiSelectedSessions.clear(); multiSelectAnchor = id;
    if (id === selectedId) { paintSessions(); return; }
    pendingNewInput = null;
    selectSession(id);
  });
  $('sessionList').addEventListener('contextmenu', event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.sess[data-id]');
    const id = row?.dataset.id;
    if (!id) return;
    event.preventDefault();
    if (event.shiftKey) {
      extendSessionSelection(id);
      paintSessions();
    } else if (!multiSelectedSessions.has(id)) {
      selectOnlyForContextMenu(id);
      paintSessions();
    }
    showSessionContextMenu(event.clientX, event.clientY);
  });
  $('sessionList').addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (!target.matches('.sess[data-id]')) return;
    const id = target.dataset.id;
    if (!id) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      const rows = visibleSessionRows();
      multiSelectedSessions.clear();
      for (const row of rows) if (row.dataset.id) multiSelectedSessions.add(row.dataset.id);
      multiSelectAnchor = id;
      paintSessions();
      return;
    }

    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      if (event.shiftKey && multiSelectAnchor) extendSessionSelection(id);
      else toggleSessionSelection(id);
      paintSessions();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      multiSelectedSessions.clear();
      multiSelectAnchor = id;
      pendingNewInput = null;
      if (id === selectedId) paintSessions(); else selectSession(id);
      return;
    }

    const rows = visibleSessionRows();
    const current = rows.findIndex(row => row.dataset.id === id);
    let next = current;
    if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, current + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const bounds = target.getBoundingClientRect();
      if (!multiSelectedSessions.has(id)) {
        selectOnlyForContextMenu(id);
        paintSessions();
      }
      showSessionContextMenu(bounds.left + 8, bounds.top + Math.min(24, bounds.height));
      return;
    } else if (event.key === 'Escape' && multiSelectedSessions.size) {
      event.preventDefault();
      clearSessionSelection();
      return;
    } else return;

    if (current < 0 || next < 0 || next === current) return;
    event.preventDefault();
    const nextRow = rows[next]!;
    target.tabIndex = -1;
    nextRow.tabIndex = 0;
    nextRow.focus({ preventScroll: true });
    if (event.shiftKey) {
      if (!multiSelectAnchor) multiSelectAnchor = id;
      if (nextRow.dataset.id) extendSessionSelection(nextRow.dataset.id);
      paintSessions();
    }
  });
  document.addEventListener('click', event => {
    if (!(event.target as HTMLElement).closest('#sessionContextMenu')) closeSessionContextMenu();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSessionContextMenu(); });
  $('sessionList').closest<HTMLElement>('.scroll')?.addEventListener('scroll', maybePageSessions);
  // One bounded window pages in either direction, only on deliberate navigation.
  // Layout restoration must never drain history or jump straight to the live tail.
  const historyPane = $('chatBody');
  // Visible height can shrink without adding timeline content (growing composer, work dock,
  // terminal, window resize). Remember whether the reader was at the end before that resize so
  // the newest answer stays visible; a reader who deliberately scrolled up keeps that position.
  let resizeFollowBottom = true;
  if (typeof ResizeObserver === 'function') {
    let lastHeight = historyPane.clientHeight;
    const observer = new ResizeObserver(() => {
      const height = historyPane.clientHeight;
      if (height !== lastHeight && resizeFollowBottom) historyPane.scrollTop = historyPane.scrollHeight;
      lastHeight = height;
      // Streaming text, images and expanded tool results can grow between renderer
      // repaints. Follow that growth only while the reader still owns the live tail;
      // an older history page or a deliberate scroll-away always stays put.
      if (followOutputEnabled() && timelineFollowBottom && historyBefore === null &&
          historyPane.scrollTop + historyPane.clientHeight < historyPane.scrollHeight - 1) {
        historyPane.scrollTop = historyPane.scrollHeight;
      }
      resizeFollowBottom = historyPane.scrollTop + historyPane.clientHeight >= historyPane.scrollHeight - 2;
    });
    observer.observe(historyPane);
    observer.observe($('timeline'));
  }
  let historyIntent: string | null = null;
  let historyIntentAt = 0;
  let historyDirection = 0;
  let pointerScrollTop: number | null = null;
  const markHistoryIntent = () => { historyIntent = selectedId; historyIntentAt = Date.now(); };
  const hasFreshHistoryIntent = () => historyIntent === selectedId &&
    (pointerScrollTop !== null || Date.now() - historyIntentAt < 500);
  const loadAtEdge = () => {
    if (!hasFreshHistoryIntent() || historyLoading || !selectedId || detailFor !== selectedId) return;
    const older = historyDirection < 0 && historyPane.scrollTop <= 80;
    const newer = historyDirection > 0 && historyBefore !== null && historyPane.scrollHeight - historyPane.clientHeight - historyPane.scrollTop <= 80;
    if (!older && !newer) return;
    historyIntent = null;
    if (newer) {
      const from = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0);
      historyLoading = true;
      void loadDetail(true, false, from).finally(() => { historyLoading = false; });
      return;
    }
    const windowed = boundedTimeline(visibleEvents());
    const boundaryRows = windowed.omitted > 0 && windowed.shown.length ? windowed.shown : events;
    const before = boundaryRows.length ? Math.min(...boundaryRows.map(event => event.seq)) : 1;
    if (before <= 1) return;
    historyLoading = true;
    void navigateHistory(before, true).finally(() => { historyLoading = false; });
  };
  historyPane.addEventListener('wheel', event => {
    redirectNestedTimelineWheel(historyPane, event);
    markHistoryIntent();
    historyDirection = Math.sign(event.deltaY);
    if (event.deltaY < 0) timelineFollowBottom = false;
    // Wheel fires before Chromium commits the pane's new scrollTop. Paging against the old
    // value made an ordinary move near the boundary prepend/reconcile while the same gesture
    // was still scrolling, which felt like a nested section fighting the page. Check once the
    // browser has applied this frame; the scroll handler below remains the primary path.
    window.requestAnimationFrame(loadAtEdge);
  }, { passive: false });
  historyPane.addEventListener('pointerdown', () => { pointerScrollTop = historyPane.scrollTop; markHistoryIntent(); });
  window.addEventListener('pointerup', () => { pointerScrollTop = null; });
  historyPane.addEventListener('keydown', event => {
    markHistoryIntent();
    historyDirection = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ? -1 : ['ArrowDown', 'PageDown', 'End'].includes(event.key) ? 1 : 0;
    if (historyDirection < 0) timelineFollowBottom = false;
    if (event.key === 'End') timelineFollowBottom = true;
    loadAtEdge();
  });
  historyPane.addEventListener('scroll', () => {
    if (pointerScrollTop !== null) {
      historyDirection = Math.sign(historyPane.scrollTop - pointerScrollTop);
      pointerScrollTop = historyPane.scrollTop;
      markHistoryIntent();
    }
    const atBottom = historyPane.scrollTop + historyPane.clientHeight >= historyPane.scrollHeight - 2;
    resizeFollowBottom = atBottom;
    if (hasFreshHistoryIntent()) timelineFollowBottom = atBottom;
    loadAtEdge();
  }, { passive: true });

  $('chatView').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (!button?.dataset.view) return;
    showView(button.dataset.view);
  });
  $('progressToggle').addEventListener('click', () => {
    const progress = document.querySelector<HTMLElement>('#chatBody > [data-view="progress"]');
    showView(progress?.hidden === false ? 'timeline' : 'progress');
  });
  $('progressInbox').addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const diagnostic = target.closest<HTMLButtonElement>('[data-diagnostic-session-id]');
    if (diagnostic?.dataset.diagnosticSessionId) {
      selectSession(diagnostic.dataset.diagnosticSessionId);
      showView('progress');
      return;
    }
    const button = target.closest<HTMLButtonElement>('[data-evidence-seq]');
    const seq = Number(button?.dataset.evidenceSeq);
    if (button && Number.isSafeInteger(seq) && seq > 0) void openProgressEvidence(seq);
  });


  $('chatAgentFilter').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-agent]');
    if (!button) return;
    agentFilter = button.dataset.agent === '' ? null : (button.dataset.agent ?? null);
    paintDetail();
  });

  $('chatRefresh').addEventListener('click', () => void refreshAll());
  $('chatJumpStart').addEventListener('click', () => void navigateHistoryStart());
  $('emptyTrash').addEventListener('click', () => void openTrashBrowser());
  $('emptyTrashAll').addEventListener('click', () => void emptySessionTrash());
  $('closeTrash').addEventListener('click', () => { $('trashBrowser').hidden = true; });
  $('automationProfile').addEventListener('change', async () => {
    const picker = $<HTMLSelectElement>('automationProfile');
    const profile = picker.value === 'overnight' ? 'overnight' : picker.value === 'rotation' ? 'rotation' : 'day';
    picker.disabled = true;
    try {
      const next = await run(api.setAutomationProfile(profile));
      if (next) {
        toast(profile === 'overnight'
          ? t('Overnight mode enabled: bounded lanes and automatic stale-Loop recovery are active.')
          : profile === 'rotation'
            ? t('Rotation mode enabled: Loop chats now cycle through safe batches.')
            : t('Day mode enabled: fast attended scheduling is active.'));
        await refreshAll();
      } else {
        picker.value = deps.state()?.config.ui.automationProfile ?? 'day';
      }
    } finally {
      picker.disabled = false;
    }
  });
  $('recoverStaleAutomation').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('recoverStaleAutomation');
    if (recoverStaleAutomationInFlight || button.disabled) return;
    recoverStaleAutomationInFlight = true;
    button.disabled = true;
    try {
      const recovered = await run(api.recoverStaleAutomationChats());
      if (recovered) {
        toast(t('{0} stale Loop chat(s) queued; {1} already working or recovering; {2} skipped.', [
          recovered.queued, recovered.alreadyWorking + recovered.alreadyRecovering, recovered.skipped
        ]));
        await refreshAll();
      }
    } finally {
      recoverStaleAutomationInFlight = false;
      paintAutomationSupervisor();
    }
  });
  $('resumeAutomation').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('resumeAutomation');
    button.disabled = true;
    try {
      const wasPaused = deps.state()?.config.ui.automationPaused === true;
      const resumed = await run(api.resumeAutomationChats());
      if (resumed) {
        toast(t(wasPaused
          ? 'Automation resumed: {0} eligible chat(s), {1} queued, {2} working, {3} recovering, {4} exact replies restored. Chats with Goal/Loop Off stay Off; active turns are not interrupted.'
          : 'Resume all: {0} eligible chat(s), {1} queued, {2} working, {3} recovering, {4} exact replies restored. Chats with Goal/Loop Off stay Off; active turns are not interrupted.',
        [resumed.eligible, resumed.queued, resumed.alreadyActive, resumed.recovering, resumed.rearmed]));
        await refreshAll();
      }
    } finally {
      button.disabled = false;
    }
  });
  $('toggleAutomationPause').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('toggleAutomationPause');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const paused = deps.state()?.config.ui.automationPaused !== true;
      const next = await run(api.setAutomationPaused(paused));
      if (next) toast(paused
        ? t('Graceful pause started. No new automated work will start; current provider turns and running workers may finish.')
        : t('ChatGPT automation resumed. Saved Goal, Loop, worker, retry, and handoff work is waking now.'));
    } finally {
      button.disabled = false;
    }
  });
  $('retryPausedHelpers').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('retryPausedHelpers');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const result = await run(api.retryPausedHelpers());
      if (result) {
        toast(t('{0} helper chats restarted; {1} automation chats queued; {2} working; {3} recovering.', [
          result.restarted, result.resume.queued, result.resume.alreadyActive, result.resume.recovering
        ]));
        await refreshAll();
      }
    } finally {
      button.disabled = false;
    }
  });
  const freshCopyAll = async (): Promise<void> => {
    const button = $<HTMLButtonElement>('freshCopyAutomation');
    if (button.disabled) return;
    if (!window.confirm(t('Fresh-copy every idle Goal and Loop from its first recorded request and current objective? New chats open ten seconds apart. Local history stays intact; original ChatGPT conversations are not deleted.'))) return;
    button.disabled = true;
    try {
      const copied = await run(api.freshCopyAutomationChats());
      if (copied) {
        toast(t('{0} fresh chats queued; {1} active, unsafe, or incomplete chats left untouched.', [
          copied.queued, copied.skippedActive + copied.skippedUnsafe + copied.skippedMissingPrompt
        ]));
        await refreshAll();
      }
    } finally {
      button.disabled = false;
    }
  };
  $('freshCopyAutomation').addEventListener('click', () => void freshCopyAll());
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'n' || !event.shiftKey || !event.altKey || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    void freshCopyAll();
  });
  $('chatRename').addEventListener('click', () => {
    if (!selectedId) return;
    renamingSessionId = selectedId; paintSessions();
  });

  $('copyHandoff').addEventListener('click', async () => {
    if (!handoff) return;
    const copied = await run(api.writeClipboard(handoff.text));
    if (copied) toast('Handoff copied');
  });

  $('swarmReset').addEventListener('click', async () => {
    const state = await run(api.resetSwarm());
    if (state) {
      paintSwarm(state);
      toast('Swarm cleared');
    }
  });

  // Which of the two things happened is decided in the main process and reported back,
  // so the toast describes the actual outcome rather than the intent of the click.
  $('swarmList').addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-clear]');
    const id = button?.dataset.clear;
    if (!id) return;
    const outcome = await run(api.clearAgent(id, button?.dataset.runId));
    if (!outcome) return;
    paintSwarm(outcome.swarm);
    toast(
      outcome.cleared === 'run'
        ? 'Run cleared — every worker ended'
        : outcome.cleared === 'worker'
          ? `${id} cleared — its slot is free`
          : outcome.reason
    );
  });

  for (const id of CHAT_INPUTS) {
    $(id).addEventListener('change', () => void deps.save());
  }

  wireGoal(() => deps.save());

  $('bridgeUnpair').addEventListener('click', async () => {
    const state = await run(api.unpairExtension());
    if (state) toast('Browser disconnected');
  });
  $('bridgeFolder').addEventListener('click', async () => {
    const dir = await run(api.openExtensionFolder());
    if (dir) toast('Extension folder opened');
  });

  api.onSessionChanged(() => {
    // Outbox transitions are tiny and latency-sensitive. Refresh them immediately;
    // the sidebar/timeline read can take seconds with a large history and must not
    // leave an already-authorized browser send labelled "Queued" until it finishes.
    void refreshInputQueue();
    scheduleReload();
  });
  api.onTaskProgress(progress => {
    if (!goalProgress || progress.requestId !== goalProgress.requestId || goalProgress.selection !== selectionGeneration) return;
    Object.assign(goalProgress, progress); paintGoalProgress();
  });
  api.onSwarmChanged(paintSwarm);
}

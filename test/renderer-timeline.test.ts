import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_GOAL_SYSTEM_PROMPT } from '../src/shared/goal.js';
import { APPROVAL_WAITING_TEXT, APPROVAL_ANSWERED_TEXT } from '../src/shared/approval-wait.js';
import { prependUserPrompt } from '../src/shared/user-prompt.js';
import type { SessionEvent, SessionSummary, SidebarFolder } from '../src/shared/session.js';
import type { InputArgs, InputEntry, SessionDecisionHelperCustody } from '../src/main/session/input.js';
import type { LocalProject } from '../src/shared/projects.js';
import type { AutomationChatProjection, AutomationSupervisorSnapshot } from '../src/main/bridge.js';
import type { FleetAutomationAlarmView } from '../src/main/fleet-automation.js';
import type { AppState } from '../src/shared/types.js';
import { createComposerDraftStore } from '../src/main/composer-drafts.js';
import type { ComposerDraftSave, ComposerDraftSnapshot } from '../src/shared/composer-drafts.js';
import { composerFilesIdentity } from '../src/shared/composer-drafts.js';
import type { InputAttachment } from '../src/shared/input.js';
import {
  MAJORITY_ALARM_OBSERVATION_GAP_MS,
  emptyMajorityAlarmState,
  type MajorityAlarmState
} from '../src/renderer/majority-alarm.js';

/**
 * The session timeline as the user reads it while a chat is running.
 *
 * Two things went wrong in the 2026-09-02 test run that only this view can show. A Compact &
 * Resume was recorded as four long rows in observation order — brief request, brief, "handoff
 * saved", bootstrap — that read as three unrelated things. And every repaint rebuilt the whole
 * list, so a tool row the user had unfolded closed again (its `<details>` was a new node) and
 * the scroller jumped while the chat kept appending. Both are checked here against the real
 * renderer booted into jsdom.
 */

let dom: JSDOM | null = null;
const fixtureDraftTimers = new Set<ReturnType<typeof setTimeout>>();
afterEach(() => {
  for (const timer of fixtureDraftTimers) clearTimeout(timer);
  fixtureDraftTimers.clear();
  dom?.window.close();
  dom = null;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  vi.restoreAllMocks();
  vi.resetModules();
});

const TOKEN = 'tok_0123456789abcdef';
const T0 = Date.UTC(2026, 8, 2, 0, 50, 0);

function text(value: string) {
  return { text: value, truncated: false, chars: value.length };
}

function summary(events: SessionEvent[]): SessionSummary {
  return {
    id: '2026-09-02-test0001',
    title: 'Loop under test',
    conversationId: 'chat-b',
    selectedModel: { conversationId: 'chat-b', model: 'gpt-5.6-sol', reasoningEffort: 'high', observedAt: T0 },
    chatIds: ['chat-a', 'chat-b'],
    startedAt: T0,
    updatedAt: T0 + 120_000,
    endedAt: null,
    events: events.length,
    userMessages: 2,
    toolCalls: 1,
    fileEdits: 0,
    linesAdded: 0,
    linesRemoved: 0,
    approximateFileChanges: false,
    lastFileChangeAt: null,
    lastToolCallAt: null,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 12_000,
    contextTokens: 900,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastTurnOutcome: null,
    activeTurnId: null,
    agents: [],
    origin: null
  };
}

function toolCall(seq: number, callId: string): SessionEvent {
  return {
    seq,
    time: T0 + seq * 1000,
    source: 'mcp',
    kind: 'tool_call',
    call: {
      callId,
      tool: 'read',
      attribution: 'request_id',
      requestId: `req-${callId}`,
      conversationId: 'chat-a',
      attributionMethod: 'request_id',
      args: text('{"path":"README.md"}'),
      result: text('# Chat On Steroids'),
      outcome: 'ok',
      durationMs: 40,
      summary: { kind: 'read', title: 'Read README.md', tone: 'neutral' }
    }
  };
}

/** The rows the recorder writes for one Compact & Resume, in the order it observes them. */
function compaction(seq: number): SessionEvent[] {
  return [
    {
      seq,
      time: T0 + seq * 1000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'm-brief-request',
      turnId: 'turn-brief',
      message: text(`[[CLF-HANDOFF:${TOKEN}]] Write the handoff brief for this session.`)
    },
    { seq: seq + 1, time: T0 + (seq + 1) * 1000, source: 'extension', kind: 'turn_start', turnId: 'turn-brief' },
    {
      seq: seq + 2,
      time: T0 + (seq + 2) * 1000,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'm-brief',
      turnId: 'turn-brief',
      message: text('# Brief\n\nGoal: keep the loop running.'),
      state: 'final',
      final: true
    },
    {
      seq: seq + 3,
      time: T0 + (seq + 3) * 1000,
      source: 'extension',
      kind: 'turn_end',
      turnId: 'turn-brief',
      outcome: 'completed'
    },
    { seq: seq + 4, time: T0 + (seq + 4) * 1000, source: 'app', kind: 'handoff', handoffId: 'h-1', chars: 44, reason: 'auto' },
    {
      seq: seq + 5,
      time: T0 + (seq + 5) * 1000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'm-bootstrap',
      message: text(`[[CLF-RESUME:${TOKEN}]] Continue from this brief: keep the loop running.`)
    }
  ];
}

async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function settleWheelFrame(w: { requestAnimationFrame: (callback: FrameRequestCallback) => number }): Promise<void> {
  await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
  await settle();
}

async function boot(events: SessionEvent[], selectExisting = true, pausedHelpers: Array<{ id: string; sourceSessionId: string }> = [], projects: LocalProject[] = [], options: { origin?: SessionSummary["origin"]; developerMode?: boolean; followOutput?: boolean; automationPaused?: boolean; automationProfile?: 'day' | 'overnight' | 'rotation'; automation?: AutomationSupervisorSnapshot; alarmAutomation?: FleetAutomationAlarmView | null; alarmState?: Partial<MajorityAlarmState>; sessions?: SessionSummary[]; detailSessions?: Record<string, SessionSummary>; strictSessionPaging?: boolean; sessionEvents?: Record<string, SessionEvent[]>; inputs?: InputEntry[]; pro?: boolean; sidebarFolders?: SidebarFolder[]; blocked?: string[]; sessionTotal?: number; sessionPageCursor?: { updatedAt: number; id: string }; globalWorkerLimit?: number; workerProgress?: Array<{ id: string; total: number; active: number; queued: number; finished: number; failed: number; names: string[]; failures: string[] }>; controls?: Record<string, unknown> } = {}) {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  if (options.alarmState) {
    w.localStorage.setItem('cos-majority-stalled-alarm:v1', JSON.stringify({
      ...emptyMajorityAlarmState(),
      ...options.alarmState
    }));
  }
  Object.assign(globalThis, {
    window: w,
    Event: w.Event,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const config = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: true,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: false, edit: false, move: false, deleteFile: false, command: false,
      screen: false, control: false, clipboardRead: false, clipboardWrite: false
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light', developerMode: options.developerMode ?? false, ...(options.followOutput === undefined ? {} : { followOutput: options.followOutput }), automationPaused: options.automationPaused ?? false, automationProfile: options.automationProfile ?? 'day' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: options.globalWorkerLimit ?? 2, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: { enabled: false, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' as const, prompt: DEFAULT_GOAL_SYSTEM_PROMPT }
  };
  const state = {
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.3', latest: null, stage: 'idle', error: null, checkedAt: null }
  };
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const live = { events: [...events], inputs: structuredClone(options.inputs ?? []) as InputEntry[], sent: [] as InputArgs[], automation: 'off', controlCalls: [] as Array<{ id: string; action: string }>, cancelTokens: [] as Array<string | undefined>, compacting: false, finishHeld: true };
  const account = { id: 'renderer.test_account', nickname: 'Renderer test account', platform: 'win32',
    enabled: true, active: true, runtimeMode: 'isolated', runtimeRunning: true, runtimePrepared: true,
    browserPaired: false, browserAuth: 'unknown', browserProfileDirectory: 'Synthetic-only', coreTunnelId: null,
    hasRuntimeApiKey: false, connection: { state: 'offline', core: { state: 'off', lastSuccessfulRequestAt: null } },
    activeWorkers: 0, queuedWorkers: 0, pendingOperations: [],
    connector: { displayName: 'Fixture', description: 'Isolated renderer test', mcpUrl: null, status: 'off', lastSuccessfulRequestAt: null, error: null } };
  // The real Main draft owner supplies schema validation, serialized CAS and exact
  // durable Input reconciliation; only its disk/IPC boundary is in memory here.
  let savedDrafts: ComposerDraftSnapshot | null = null;
  const draftStorage = { readError: null as string | null, writeError: null as string | null,
    writes: [] as ComposerDraftSnapshot[] };
  const staged = new Map<string, InputAttachment>(live.inputs.flatMap(input => input.attachments ?? []).map(file => [file.id, file]));
  const draftStore = createComposerDraftStore({ profileId: () => account.id,
    read: async () => { if (draftStorage.readError) throw new Error(draftStorage.readError); return structuredClone(savedDrafts); },
    write: async value => {
      if (draftStorage.writeError) throw new Error(draftStorage.writeError);
      savedDrafts = structuredClone(value); draftStorage.writes.push(structuredClone(value));
    },
    inputs: async () => structuredClone(live.inputs),
    validateAttachments: async files => {
      for (const file of files) if (!staged.has(file.id) || composerFilesIdentity([staged.get(file.id)!]) !== composerFilesIdentity([file]))
        throw new Error('Attachment was not staged by this fixture account');
    } });
  const draftReply = async <T>(operation: Promise<T>) => {
    try { return { ok: true as const, data: await operation }; }
    catch (error) { return { ok: false as const, error: (error as Error).message }; }
  };
  const listedSessions = options.sessions ?? [{ ...summary(live.events), ...(options.origin ? { origin: options.origin } : {}), ...(projects[0] ? { projectId: projects[0].id } : {}) }];
  const automation: AutomationSupervisorSnapshot = options.automation ?? {
    observedAt: T0,
    targetLanes: 0,
    chats: [],
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 0 }
  };
  const alarmAutomationProvided = Object.prototype.hasOwnProperty.call(options, 'alarmAutomation');
  let alarmAutomation = options.alarmAutomation;
  const blockedChats = new Set(options.blocked ?? []);
  let deletedSessions = 0;
  const deletedRows = new Map<string, (typeof listedSessions)[number]>();
  let sidebarFolders = structuredClone(options.sidebarFolders ?? []);
  let sessionListener: () => void = () => undefined;
  let listSessionCalls = 0;
  const sessionReads: Array<{ id: string; from?: number; before?: number; limit?: number }> = [];
  const taskProgressListeners = new Set<(progress: any) => void>();
  const pickerWrappers = new WeakMap<(...args: any[]) => any, ReturnType<typeof vi.fn>>();
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getInstanceProfiles: () => ok({ activeProfileId: account.id, canManageProfiles: false, profiles: [account] }),
      loadComposerDrafts: () => draftReply(draftStore.load()),
      saveComposerDrafts: (request: ComposerDraftSave) => draftReply(draftStore.save(request)),
      getChatModels: () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: options.pro ? ['high', 'xhigh', 'pro'] : ['none', 'high', 'xhigh'] }] }),
      getSessionControls: (id: string) => ok({ sessionId: id, conversationId: listedSessions.find(row => row.id === id)?.conversationId ?? null, automation: live.automation, activeTurnId: 'held-turn', finishHeld: live.finishHeld, blocked: '', objective: '', plan: null, job: live.compacting ? { busy: true, token: 'renderer-live-handoff' } : null, ...options.controls }),
      releaseSessionFinish: (id: string, turn: string) => { live.controlCalls.push({ id, action: `release:${turn}` }); live.finishHeld = false; return ok({}); },
      setSessionAutomation: (id: string, action: string) => { live.controlCalls.push({ id, action }); live.automation = action; return ok({}); },
      setSessionsAutomation: (ids: string[], action: 'off' | 'goal' | 'loop', text?: string) => {
        live.controlCalls.push({ id: ids.join(','), action: `${action}-selected${text ? `:${text}` : ''}` });
        live.automation = action;
        return ok({ requested: ids.length, updated: ids.length, automation: action });
      },
      setSessionsAutomationPaused: (ids: string[], paused: boolean) => {
        live.controlCalls.push({ id: ids.join(','), action: paused ? 'pause-selected' : 'resume-selected' });
        return ok({ requested: ids.length, updated: ids.length, skipped: 0, paused });
      },
      setRotationBatchMembership: (ids: string[], enrolled: boolean) => {
        live.controlCalls.push({ id: ids.join(','), action: enrolled ? 'batch-add' : 'batch-remove' });
        return ok({ requested: ids.length, updated: ids.length, enrolled });
      },
      compactSession: (id: string) => { live.controlCalls.push({ id, action: 'compact' }); live.compacting = true; return ok({}); },
      cancelSessionCompaction: (id: string, expectedToken?: string) => { live.controlCalls.push({ id, action: 'cancel' }); live.cancelTokens.push(expectedToken); live.compacting = false; return ok({}); },
      getLog: () => ok([]),
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onStateChanged: () => () => undefined,
      onTaskProgress: (listener: (progress: any) => void) => { taskProgressListeners.add(listener); return () => taskProgressListeners.delete(listener); },
      draftGoalOpening: (text: string) => ok({ reply: `Start: ${text}`, model: 'fixture' }),
      onLogEntry: () => () => undefined,
      onSwarmChanged: () => () => undefined,
      onSessionChanged: (fn: any) => {
        sessionListener = fn;
        return () => undefined;
      },
      listSessions: () => {
        listSessionCalls += 1;
        return ok({ sessions: listedSessions, activeId: summary(live.events).id, pressure: [], blocked: [...blockedChats], total: options.sessionTotal ?? listedSessions.length, nextCursor: options.sessionPageCursor ?? null, deleted: deletedSessions, automation, ...(alarmAutomationProvided ? { alarmAutomation } : {}), workerProgress: options.workerProgress ?? [] });
      },
      renameSession: (id: string, title: string) => {
        live.controlCalls.push({ id, action: `rename:${title}` });
        return ok(true);
      },
      setSessionWorkerLimit: (id: string, workerLimit: number | null) => {
        live.controlCalls.push({ id, action: `workers:${workerLimit ?? 'global'}` });
        const row = listedSessions.find(session => session.id === id)!;
        row.workerLimit = workerLimit;
        return ok({ ...row });
      },
      setSessionBlocked: (id: string, blocked: boolean) => {
        const conversationId = listedSessions.find(row => row.id === id)?.conversationId;
        if (!conversationId) return Promise.resolve({ ok: false, error: 'not a conversation' });
        blocked ? blockedChats.add(conversationId) : blockedChats.delete(conversationId);
        live.controlCalls.push({ id, action: blocked ? 'block' : 'release' });
        return ok([...blockedChats]);
      },
      setSessionsBlocked: (ids: string[], blocked: boolean) => {
        const selected = ids.map(id => listedSessions.find(row => row.id === id));
        if (selected.some(row => !row?.conversationId)) return Promise.resolve({ ok: false, error: 'unsupported selection' });
        for (const row of selected) blocked ? blockedChats.add(row!.conversationId!) : blockedChats.delete(row!.conversationId!);
        live.controlCalls.push({ id: ids.join(','), action: blocked ? 'block-selected' : 'release-selected' });
        return ok([...blockedChats]);
      },
      listProjects: () => ok(projects),
      listSidebarFolders: () => ok(structuredClone(sidebarFolders)),
      createSidebarFolder: (name: string, sessionIds: string[]) => {
        for (const folder of sidebarFolders) folder.sessionIds = folder.sessionIds.filter(id => !sessionIds.includes(id));
        sidebarFolders.push({ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', name, sessionIds: [...sessionIds], createdAt: Date.now() });
        return ok(structuredClone(sidebarFolders));
      },
      assignSidebarFolder: (folderId: string | null, sessionIds: string[]) => {
        for (const folder of sidebarFolders) folder.sessionIds = folder.sessionIds.filter(id => !sessionIds.includes(id));
        sidebarFolders.find(folder => folder.id === folderId)?.sessionIds.push(...sessionIds);
        return ok(structuredClone(sidebarFolders));
      },
      renameSidebarFolder: (folderId: string, name: string) => {
        const folder = sidebarFolders.find(entry => entry.id === folderId); if (folder) folder.name = name;
        return ok(structuredClone(sidebarFolders));
      },
      deleteSidebarFolder: (folderId: string) => {
        sidebarFolders = sidebarFolders.filter(folder => folder.id !== folderId);
        return ok(structuredClone(sidebarFolders));
      },
      deleteSessions: (ids: string[], permanent: boolean) => {
        const removed = listedSessions.filter(session => ids.includes(session.id));
        for (let at = listedSessions.length - 1; at >= 0; at--) if (ids.includes(listedSessions[at]!.id)) listedSessions.splice(at, 1);
        if (!permanent) for (const session of removed) deletedRows.set(session.id, session);
        deletedSessions = deletedRows.size;
        live.controlCalls.push({ id: ids.join(','), action: permanent ? 'permanent-delete' : 'trash' });
        return ok({ requested: ids.length, permanent, deleted: removed.map(session => ({
          id: session.id, title: session.title, conversationId: session.conversationId,
          deletedAt: Date.now(), undoUntil: permanent ? Date.now() : Date.now() + 30 * 24 * 60 * 60 * 1000
        })), failed: [] });
      },
      emptySessionTrash: () => {
        const removed = deletedSessions; deletedRows.clear(); deletedSessions = 0;
        return ok({ removed, activeDuplicatesDeleted: 0 });
      },
      restoreDeletedSession: (id: string) => {
        const restored = deletedRows.get(id) ?? null;
        if (restored) {
          deletedRows.delete(id);
          listedSessions.push(restored);
          deletedSessions = deletedRows.size;
          live.controlCalls.push({ id, action: 'restore' });
        }
        return ok(restored);
      },
      freshCopyAutomationChats: () => {
        live.controlCalls.push({ id: '*', action: 'fresh-copy' });
        return ok({ eligible: 2, queued: 2, replacedQueued: 0, skippedActive: 0, skippedUnsafe: 0, skippedMissingPrompt: 0, skipped: 0 });
      },
      resumeAutomationChats: () => {
        live.controlCalls.push({ id: '*', action: 'resume-all' });
        config.ui.automationPaused = false;
        return ok({ eligible: 2, queued: 2, alreadyActive: 0, recovering: 0, rearmed: 0, skipped: 0 });
      },
      resumeAutomationChat: (id: string) => {
        live.controlCalls.push({ id, action: 'resume-one' });
        return ok({ eligible: 1, queued: 1, alreadyActive: 0, recovering: 0, rearmed: 1, skipped: 0 });
      },
      setAutomationPaused: (paused: boolean) => {
        live.controlCalls.push({ id: '*', action: paused ? 'pause-automation' : 'resume-automation' });
        config.ui.automationPaused = paused;
        return ok(state);
      },
      setAutomationProfile: (profile: 'day' | 'overnight' | 'rotation') => {
        live.controlCalls.push({ id: '*', action: `profile:${profile}` });
        config.ui.automationProfile = profile;
        return ok(state);
      },
      recoverStaleAutomationChats: () => {
        live.controlCalls.push({ id: '*', action: 'recover-stale' });
        return ok({ eligible: automation.counts.stalled, queued: automation.counts.stalled,
          alreadyWorking: 0, alreadyRecovering: 0, deferred: 0, skipped: 0 });
      },
      // IPC snapshots cannot share the backend's mutable array with the renderer.
      listInputs: () => ok(structuredClone(live.inputs)),
      listPausedHelpers: () => ok(pausedHelpers),
      retryHelper: (id: string, sourceSessionId: string) => {
        live.controlCalls.push({ id: sourceSessionId, action: `retry:${id}` });
        pausedHelpers = pausedHelpers.filter(row => row.sourceSessionId !== sourceSessionId);
        return ok(true);
      },
      retryPausedHelpers: () => {
        const sources = new Set(pausedHelpers.map(row => row.sourceSessionId));
        live.controlCalls.push({ id: '*', action: `retry-helpers:${sources.size}` });
        pausedHelpers = [];
        return ok({ eligible: sources.size, restarted: sources.size, skipped: 0,
          resume: { eligible: sources.size, queued: sources.size, alreadyActive: 0, recovering: 0, rearmed: sources.size, skipped: 0 } });
      },
      sendInput: (input: InputArgs) => {
        live.sent.push(input);
        const row: InputEntry = { ...input, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
        if (input.mode === 'finish' && input.stages) {
          row.stagesApplied = true;
          live.inputs.push(row, ...input.stages.map((text, index) => ({ ...row, id: `${input.id}-${index}`, text, stages: undefined })));
          return ok(row);
        }
        live.inputs.push(row);
        return ok(row);
      },
      retryInputBrowser: (id: string) => {
        live.controlCalls.push({ id, action: 'retry-browser' });
        return ok(live.inputs.find(row => row.id === id) ?? null);
      },
      getSession: (_id: string, query?: { from?: number; before?: number; limit?: number }) => {
        sessionReads.push({ id: _id, ...(query ?? {}) });
        const sessionEvents = options.sessionEvents?.[_id] ?? live.events;
        const from = query?.from ?? 0;
        const eligible = sessionEvents.filter((event) => event.seq >= from && (query?.before === undefined || event.seq < query.before));
        // Real IPC returns the newest N events on an initial read. The opt-in strict
        // fixture reproduces that bound for long-history retention checks while older
        // timeline fixtures retain their established complete small-window behavior.
        const page = query?.before === undefined && !options.strictSessionPaging
          ? eligible : eligible.slice(-(query?.limit ?? 160));
        return ok({
          summary: listedSessions.find(row => row.id === _id) ?? options.detailSessions?.[_id] ?? summary(sessionEvents),
          events: page,
          total: sessionEvents.length,
          nextFrom: sessionEvents.reduce((max, e) => Math.max(max, e.seq + 1), 0)
        });
      },
      getHandoff: () => ok(null)
    },
    {
      get(target, prop) {
        if (['chooseFiles', 'dropFiles', 'attachText'].includes(String(prop)) && prop in target) {
          const picker = (target as any)[prop];
          if (!pickerWrappers.has(picker)) pickerWrappers.set(picker, vi.fn(async (...args: unknown[]) => {
            const reply = await picker(...args);
            if (reply.ok) for (const file of Array.isArray(reply.data) ? reply.data : reply.data ? [reply.data] : [])
              staged.set(file.id, structuredClone(file));
            return reply;
          }));
          return pickerWrappers.get(picker);
        }
        if (prop in target) return (target as any)[prop];
        return (..._args: any[]) => ok(null);
      }
    }
  );
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  // Browser teardown must also retire the renderer's Node-hosted debounce, so
  // a previous test cannot save or repaint into the next isolated window.
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const timer = schedule(callback, delay, ...args);
    if (delay === 250) fixtureDraftTimers.add(timer);
    return timer;
  }) as typeof setTimeout);
  await import('../src/renderer/main.js');
  await settle();
  if (selectExisting) {
    (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
    await settle();
  }

  return {
    w,
    live,
    state,
    draftStorage,
    savedDrafts: () => structuredClone(savedDrafts),
    sessionReads,
    listSessionCalls: () => listSessionCalls,
    setAlarmAutomation: (value: FleetAutomationAlarmView | null) => { alarmAutomation = value; },
    sidebarFolders: () => structuredClone(sidebarFolders),
    notifySession: () => sessionListener(),
    async replaceSessions(next: typeof listedSessions) {
      listedSessions.splice(0, listedSessions.length, ...next);
      sessionListener();
      await settle(500);
    },
    progress: (value: any) => { for (const listener of taskProgressListeners) listener(value); },
    async append(more: SessionEvent[]) {
      live.events.push(...more);
      sessionListener();
      await settle(500);
    }
  };
}

it('keeps the overnight majority-alarm observation poll alive while the Chat panel is hidden', async () => {
  const app = await boot([], false, [], [], { automationProfile: 'day' });
  const scheduled: Array<() => void> = [];
  const originalSetTimeout = app.w.setTimeout.bind(app.w);
  app.w.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === MAJORITY_ALARM_OBSERVATION_GAP_MS && typeof handler === 'function') {
      scheduled.push(() => handler(...args));
      return 987_654;
    }
    return originalSetTimeout(handler, delay, ...args);
  }) as typeof app.w.setTimeout;
  app.state.config.ui.automationProfile = 'overnight';
  const chat = await import('../src/renderer/chat.js');
  chat.chatApply(app.state as unknown as AppState);
  chat.chatVisible(false);
  const before = app.listSessionCalls();

  expect(scheduled).toHaveLength(1);
  scheduled.shift()!();
  await settle();

  expect(app.listSessionCalls()).toBeGreaterThan(before);
  expect(scheduled).toHaveLength(1);
});

it('shows objective, plan, reminder and partial active-work evidence in the progress inbox', async () => {
  const rows: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'scope', message: text('Ship the parser and prove the real workflow.') },
    toolCall(2, 'proof'),
    {
      seq: 3,
      time: T0 + 3_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'loop',
      message: text('Continue the test.\n\nReminder: Ship the parser and prove the real workflow.\nCurrent milestone: Verify the parser.\nDone when: the workflow is live-proven.\nStay within scope; preserve completed work.')
    }
  ];
  const session = { ...summary(rows), activeWorkMs: 42_000, activeWorkMeasurement: 'partial' as const };
  const app = await boot(rows, true, [], [], {
    sessions: [session],
    controls: {
      automation: 'loop',
      objective: 'Ship the parser without changing the export contract.',
      plan: {
        updatedAt: T0 + 2_000,
        checklist: [{ id: 'parser', requirement: 'Preserve <img src=x onerror=alert(1)> exports', source: 'Original request', acceptance: 'Save and reopen intact', status: 'blocked', blocker: 'Missing fixture', nextExperiment: 'Use the supplied copy when available.' }],
        plan: [
          { step: 'Implement parser repair', status: 'completed' },
          { step: 'Verify real workflow', status: 'in_progress', details: 'Exercise the installed command path.' }
        ]
      }
    }
  });

  (app.w.document.getElementById('progressToggle') as HTMLButtonElement).click();
  await settle();

  const inbox = app.w.document.getElementById('progressInbox')!;
  expect(inbox.textContent).toContain('Ship the parser and prove the real workflow.');
  expect(inbox.textContent).toContain('Ship the parser without changing the export contract.');
  expect(inbox.textContent).toContain('Reminder: Ship the parser and prove the real workflow.');
  expect(inbox.textContent).toContain('Delivery provenance: this text is recorded in a native user message');
  expect(inbox.textContent).not.toContain('Delivered app reminder');
  expect(inbox.textContent).toContain('Plan-marked completed');
  expect(inbox.textContent).toContain('0 / 1 active recorded requirements');
  expect(inbox.textContent).toContain('Missing fixture');
  expect(inbox.textContent).toContain('Use the supplied copy when available.');
  expect(inbox.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(inbox.querySelector('img')).toBeNull();
  expect(inbox.textContent).toContain('Implement parser repair');
  expect(inbox.textContent).toContain('Verify real workflow');
  expect(inbox.textContent).toContain('Active work: 42s proven · partial coverage.');
  expect(inbox.textContent).not.toMatch(/\b100%\b/);
  expect(inbox.querySelector('[data-evidence-seq="2"]')).not.toBeNull();

  // Evidence navigation may replace the timeline with a bounded historical page. The Progress
  // projection keeps its own current-tail events, so returning here must not relabel that old
  // page as the latest reminder.
  app.w.document.querySelector('[data-event-seq="2"]')?.remove();
  (inbox.querySelector('[data-evidence-seq="2"]') as HTMLButtonElement).click();
  await settle();
  (app.w.document.getElementById('progressToggle') as HTMLButtonElement).click();
  await settle();
  expect(inbox.textContent).toContain('Reminder: Ship the parser and prove the real workflow.');
});

it('preserves unchanged Progress evidence nodes, focus and text through an account-pause refresh', async () => {
  const rows: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'stable-progress-scope',
      message: text('Preserve this long original instruction and its exact evidence.') },
    toolCall(2, 'stable-progress-tool')
  ];
  const row = { ...summary(rows), id: 'stable-progress-controls',
    conversationId: 'stable-progress-provider', chatIds: ['stable-progress-provider'] };
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: rows },
    controls: { objective: 'Verify the current source, not an unrelated release.' } });
  (app.w.document.getElementById('progressToggle') as HTMLButtonElement).click();
  await settle();
  const inbox = app.w.document.getElementById('progressInbox')!;
  const scope = [...inbox.querySelectorAll<HTMLElement>('.progress-section')]
    .find(section => section.querySelector('h4')?.textContent === 'Original scope')!;
  const scopeText = scope.querySelector<HTMLElement>('.progress-copy')!;
  const textNode = scopeText.firstChild;
  const evidence = inbox.querySelector<HTMLButtonElement>('.progress-evidence [data-evidence-seq="2"]')!;
  expect(scopeText.textContent).toContain('Preserve this long original instruction');
  expect(evidence).not.toBeNull();
  evidence.focus();
  let removals = 0;
  const observer = new app.w.MutationObserver(records => {
    for (const record of records) if ([...record.removedNodes].includes(scope) ||
      [...record.removedNodes].some(node => node.contains?.(scope) || node.contains?.(evidence))) removals++;
  });
  observer.observe(inbox, { childList: true, subtree: true });
  const chat = await import('../src/renderer/chat.js');
  const previous = structuredClone(app.state.config);
  app.state.config.ui.automationPaused = true;
  chat.chatApply(app.state as unknown as AppState, previous as unknown as AppState['config']);
  await settle();
  expect(inbox.querySelector('.progress-section .progress-copy')).toBe(scopeText);
  expect(scopeText.firstChild).toBe(textNode);
  expect(inbox.querySelector('.progress-evidence [data-evidence-seq="2"]')).toBe(evidence);
  expect(app.w.document.activeElement).toBe(evidence);
  expect(removals).toBe(0);
  observer.disconnect();
});

it('keeps confirmed reminder delivery, blocked state, remaining work, and unknown work evidence distinct', async () => {
  const rows: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'scope-statuses',
      message: text('Finish the durable workflow and prove the real acceptance path.') },
    toolCall(2, 'verified-test-evidence'),
    { seq: 3, time: T0 + 2_000, source: 'extension', kind: 'chat_error', turnId: 'blocked-turn', recoverable: true,
      message: text('Provider connection interrupted') },
    { seq: 4, time: T0 + 3_000, source: 'app', kind: 'user_message', messageId: 'native-loop-reminder',
      inputId: 'loop-reminder-input', inputDelivery: 'confirmed',
      message: text('Continue.\n\nReminder: Finish the durable workflow and prove the real acceptance path.\nCurrent milestone: Repair the blocked provider edge.\nDone when: the real workflow is verified.\nStay within scope; preserve completed work.') }
  ];
  const app = await boot(rows, true, [], [], {
    sessions: [summary(rows)],
    controls: {
      automation: 'loop',
      blocked: 'blocked',
      objective: 'Finish the durable workflow without broadening scope.',
      plan: {
        updatedAt: T0 + 1_000,
        plan: [
          { step: 'Implement the source repair', status: 'completed' },
          { step: 'Prove the installed workflow', status: 'pending', details: 'Blocked on activation.' }
        ]
      }
    }
  });

  (app.w.document.getElementById('progressToggle') as HTMLButtonElement).click();
  await settle();
  const inbox = app.w.document.getElementById('progressInbox')!;
  expect(inbox.textContent).toContain('blocked');
  expect(inbox.textContent).toContain('This chat is blocked by the user.');
  expect(inbox.textContent).toContain('Delivered app reminder');
  expect(inbox.textContent).toContain('confirmed app input loop-reminder-input');
  expect(inbox.textContent).toContain('Plan-marked completed');
  expect(inbox.textContent).toContain('Remaining / in progress');
  expect(inbox.textContent).toContain('Prove the installed workflow');
  expect(inbox.textContent).toContain('Active work: unknown');
  expect(inbox.textContent).not.toContain('Verified completed');
  expect(inbox.querySelector('[data-evidence-seq="2"]')).not.toBeNull();
  expect(inbox.querySelector('[data-evidence-seq="4"]')).not.toBeNull();
});

it('refreshes original scope and reminder evidence when the selected chat changes while Progress stays open', async () => {
  const alphaEvents: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'alpha-scope', message: text('Alpha original scope.') },
    { seq: 2, time: T0 + 1_000, source: 'extension', kind: 'user_message', messageId: 'alpha-loop',
      message: text('Continue alpha.\n\nReminder: Alpha original scope.\nCurrent milestone: Alpha.\nDone when: Alpha accepted.\nStay within scope; preserve completed work.') }
  ];
  const betaEvents: SessionEvent[] = [
    { seq: 1, time: T0 + 2_000, source: 'extension', kind: 'user_message', messageId: 'beta-scope', message: text('Beta original scope.') },
    { seq: 2, time: T0 + 3_000, source: 'extension', kind: 'user_message', messageId: 'beta-loop',
      message: text('Continue beta.\n\nReminder: Beta original scope.\nCurrent milestone: Beta.\nDone when: Beta accepted.\nStay within scope; preserve completed work.') }
  ];
  const alpha = { ...summary(alphaEvents), id: '2026-09-02-alpha', title: 'Alpha', conversationId: 'chat-alpha', chatIds: ['chat-alpha'] };
  const beta = { ...summary(betaEvents), id: '2026-09-02-beta', title: 'Beta', conversationId: 'chat-beta', chatIds: ['chat-beta'] };
  const app = await boot(alphaEvents, true, [], [], {
    sessions: [alpha, beta],
    sessionEvents: { [alpha.id]: alphaEvents, [beta.id]: betaEvents }
  });

  (app.w.document.getElementById('progressToggle') as HTMLButtonElement).click();
  await settle();
  const inbox = app.w.document.getElementById('progressInbox')!;
  expect(app.w.document.querySelector<HTMLElement>('#chatBody > [data-view="progress"]')?.hidden).toBe(false);
  expect(inbox.textContent).toContain('Alpha original scope.');

  const betaRow = [...app.w.document.querySelectorAll<HTMLElement>('#sessionList [data-id]')]
    .find(row => row.dataset.id === beta.id);
  expect(betaRow).toBeTruthy();
  betaRow!.click();
  await settle();

  expect(app.sessionReads).toContainEqual(expect.objectContaining({ id: beta.id, from: 0 }));
  expect(app.w.document.querySelector<HTMLElement>('#chatBody > [data-view="progress"]')?.hidden).toBe(false);
  expect(inbox.textContent).toContain('Beta original scope.');
  expect(inbox.textContent).toContain('Reminder: Beta original scope.');
  expect(inbox.textContent).not.toContain('Reminder: Alpha original scope.');
});

it('labels a confirmed reminder from the previous provider even after a successful successor history read', async () => {
  const now = Date.now();
  const sent: SessionEvent = { seq: 1, time: now - 3_000, source: 'app', kind: 'user_message',
    messageId: 'old-native-A-reminder', inputId: 'old-provider-reminder-input',
    inputDelivery: 'confirmed', message: text('Continue.\nReminder: Previous provider finished this stage.') };
  const session: SessionSummary = { ...summary([sent]), id: 'successful-history-old-reminder',
    conversationId: 'provider-A', chatIds: ['provider-A'], title: 'Retain verified native history' };
  const input: InputEntry = { id: 'old-provider-reminder-input', sessionId: session.id,
    conversationId: session.conversationId, mode: 'auto',
    text: 'Continue. Reminder: Previous provider finished this stage.',
    model: 'gpt-6-thinking', reasoningEffort: 'xhigh', dueAt: now - 4_000,
    state: 'cancelled', createdAt: now - 4_000, owner: 'old-provider-tab',
    deliveredAt: now - 3_000, messageId: sent.messageId, error: 'Closed after delivery' };
  const app = await boot([sent], true, [], [], {
    sessions: [session], sessionEvents: { [session.id]: [sent] }, inputs: [input]
  });
  (app.w.document.getElementById('progressToggle') as HTMLButtonElement).click();
  await settle();
  const inbox = app.w.document.getElementById('progressInbox')!;
  expect(inbox.textContent).toContain('old-native-A-reminder');

  await app.replaceSessions([{ ...session, conversationId: 'provider-B',
    chatIds: ['provider-A', 'provider-B'], updatedAt: now + 100 }]);
  // A successful exact B read can legitimately include retained A events in
  // the same durable local session. Preserve the receipt without saying B sent it.
  expect(inbox.textContent).not.toContain('Recorded history boundary');
  expect(inbox.textContent).toContain('Reminder: Previous provider finished this stage.');
  expect(inbox.textContent).toContain('Previous provider conversation reminder');
  expect(inbox.textContent).toContain('This native Send belongs to a previous provider conversation');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('refreshes successor reminder and evidence in place when the same durable session advances', async () => {
  const original = 'Ship the durable workflow and preserve every acceptance boundary.';
  const correction = 'Keep the source and focused tests, but package/install/live proof must remain blocked until activation is legal.';
  const initialEvents: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'stable-scope', message: text(original) },
    { seq: 2, time: T0 + 1_000, source: 'app', kind: 'user_message', messageId: 'old-reminder', inputId: 'old-reminder-input', inputDelivery: 'confirmed',
      message: text(`Continue.\n\nReminder: ${original}\nCurrent milestone: Source repair.\nDone when: the complete acceptance is proven.\nStay within scope; preserve completed work.`) }
  ];
  const stable = { ...summary(initialEvents), id: '2026-10-05-stable-progress', title: 'Stable progress',
    conversationId: 'progress-chat-a', chatIds: ['progress-chat-a'] };
  const app = await boot(initialEvents, true, [], [], {
    sessions: [stable],
    controls: {
      automation: 'loop',
      objective: original,
      plan: {
        updatedAt: T0 + 500,
        checklist: [
          { id: 'source', requirement: 'Current source implementation', source: 'Original request', acceptance: 'Source owner contains the repair', status: 'implemented' },
          { id: 'tests', requirement: 'Focused regression proof', source: 'Original request', acceptance: 'Focused host-neutral tests pass', status: 'verified', evidence: ['focused:test passed · source generation · Windows host-neutral'] },
          { id: 'package', requirement: 'Package-qualified coherent generation', source: 'Original request', acceptance: 'Exact frozen package is qualified', status: 'blocked', blocker: 'External clean-generation gate', nextExperiment: 'Freeze and qualify after ownership clears.' },
          { id: 'installed', requirement: 'Installed current-source bytes', source: 'Original request', acceptance: 'Exact qualified bytes are installed', status: 'pending' },
          { id: 'live', requirement: 'Live-proven workflow', source: 'Original request', acceptance: 'Installed workflow is exercised live', status: 'pending' }
        ],
        plan: [{ step: 'Preserve host-neutral acceptance while activation is blocked', status: 'in_progress' }]
      },
      activeWork: { primeSessionId: stable.id, sessionIds: [stable.id], activeWorkMs: 0, activeWorkMeasurement: 'unknown' }
    }
  });

  (app.w.document.getElementById('progressToggle') as HTMLButtonElement).click();
  await settle();
  const inbox = app.w.document.getElementById('progressInbox')!;
  expect(inbox.textContent).toContain(`Reminder: ${original}`);
  expect(inbox.querySelector('[data-evidence-seq="2"]')).not.toBeNull();

  // Compact & Resume preserves the stable local session id while changing the provider chat.
  // Keep Progress open, advance that same durable row to B, then publish a later human correction
  // and its delivered Loop reminder. The panel must not keep A's cached current-tail evidence.
  const originalGetSession = (app.w as any).api.getSession;
  let successorReadUnavailable = true;
  (app.w as any).api.getSession = (id: string, query?: object) =>
    id === stable.id && successorReadUnavailable
      ? Promise.resolve({ ok: false, error: 'Successor provider history read unavailable.' })
      : originalGetSession(id, query);
  await app.replaceSessions([{ ...stable, conversationId: 'progress-chat-b', chatIds: ['progress-chat-a', 'progress-chat-b'], updatedAt: T0 + 4_000 }]);
  expect(inbox.textContent).toContain('Recorded history boundary');
  expect(inbox.textContent).toContain('previous provider conversation');
  expect(inbox.textContent).toContain('old-reminder');
  expect(inbox.textContent).not.toContain('Native Send confirmed for the current provider conversation');
  expect(inbox.querySelector('[data-evidence-seq="2"]')).not.toBeNull();

  successorReadUnavailable = false;
  await app.append([
    { seq: 3, time: T0 + 3_000, source: 'extension', kind: 'user_message', messageId: 'successor-correction', message: text(correction) },
    { seq: 4, time: T0 + 4_000, source: 'app', kind: 'user_message', messageId: 'successor-reminder', inputId: 'successor-reminder-input', inputDelivery: 'confirmed',
      message: text(`Continue.\n\nReminder: ${correction}\nOriginal scope: ${original}\nCurrent milestone: Keep activation blocked while finishing independent proof.\nDone when: package/install/live acceptance is actually proven.\nStay within scope; preserve completed work.`) }
  ]);

  expect(app.w.document.querySelector<HTMLElement>('#chatBody > [data-view="progress"]')?.hidden).toBe(false);
  expect(inbox.textContent).toContain(`Reminder: ${correction}`);
  expect(inbox.textContent).not.toContain('Recorded history boundary');
  expect(inbox.textContent).toContain(`Original scope: ${original}`);
  expect(inbox.textContent).toContain('confirmed app input successor-reminder-input');
  expect(inbox.textContent).toContain('source [implemented; done=false; evidence=implemented]');
  expect(inbox.textContent).toContain('tests [verified; done=true; evidence=source-tested]');
  expect(inbox.textContent).toContain('package [blocked; done=false; evidence=blocked]');
  expect(inbox.textContent).toContain('installed [pending; done=false; evidence=unknown]');
  expect(inbox.textContent).toContain('live [pending; done=false; evidence=unknown]');
  expect(inbox.textContent).toContain('Active work: unknown');
  expect(inbox.textContent).not.toMatch(/\b\d+%\b/);
  const loopOff = app.w.document.querySelector('#automationSwitch [data-mode="off"]') as HTMLButtonElement | null;
  expect(loopOff).not.toBeNull();
  expect(loopOff!.disabled).toBe(false);
  expect((app.w.document.getElementById('chatSend') as HTMLButtonElement).getAttribute('aria-label')).toBe('Stop turn');
  const successorEvidence = inbox.querySelector('[data-evidence-seq="4"]') as HTMLButtonElement | null;
  expect(successorEvidence).not.toBeNull();

  // The delivered successor reminder is the evidence carrier for the later human correction.
  // Force bounded evidence navigation instead of relying on the already-painted current timeline,
  // then prove the link resolves the successor event rather than a stale predecessor artifact.
  app.w.document.querySelector('[data-event-seq="4"]')?.remove();
  successorEvidence!.click();
  await settle();
  expect(app.sessionReads).toContainEqual(expect.objectContaining({ id: stable.id, before: 5 }));
  expect(app.w.document.querySelector('[data-event-seq="4"]')).not.toBeNull();
  expect(app.w.document.querySelector<HTMLElement>('#chatBody > [data-view="progress"]')?.hidden).toBe(true);
});

it('shows incomplete fleet coverage without falling back to a local stalled majority', async () => {
  const old = Date.now() - 11 * 60_000;
  const local: AutomationSupervisorSnapshot = {
    observedAt: Date.now(), targetLanes: 3,
    chats: ['one', 'two', 'three'].map((id, index) => ({
      sessionId: `session-${id}`, conversationId: `chat-${id}`, title: id, mode: 'loop' as const,
      state: index < 2 ? 'stalled' as const : 'working' as const,
      reason: '', nextAction: '', nextRetryAt: null, lastWorkedAt: old, activeWorkers: 0,
      recoverable: false, spinning: false, recoveryStage: null
    })),
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 2, paused: 0, blocked: 0 }
  };
  const unavailable: FleetAutomationAlarmView = {
    snapshot: null,
    coverage: {
      state: 'incomplete', expectedProfiles: 3, reportingProfiles: 2,
      missingProfiles: ['Zeta'], graceEndsAt: Date.now() - 1
    }
  };
  const app = await boot([], false, [], [], { automationProfile: 'day', automation: local, alarmAutomation: unavailable });
  const scheduled: Array<() => void> = [];
  const originalSetTimeout = app.w.setTimeout.bind(app.w);
  app.w.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === MAJORITY_ALARM_OBSERVATION_GAP_MS && typeof handler === 'function') {
      scheduled.push(() => handler(...args));
      return 987_655;
    }
    return originalSetTimeout(handler, delay, ...args);
  }) as typeof app.w.setTimeout;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  app.state.config.ui.automationProfile = 'overnight';
  const chat = await import('../src/renderer/chat.js');
  chat.chatApply(app.state as unknown as AppState);
  chat.chatVisible(false);
  for (let index = 0; index < 2; index++) {
    expect(scheduled.length).toBeGreaterThan(0);
    scheduled.shift()!();
    await settle();
  }
  const saved = JSON.parse(app.w.localStorage.getItem('cos-majority-stalled-alarm:v1') ?? '{}');
  expect(saved.candidateKey ?? null).toBeNull();
  expect(warn.mock.calls.some(([message]) => String(message).includes('majority-stalled warning'))).toBe(false);
  const notice = app.w.document.getElementById('automationAlarmNotice')!;
  expect(notice.hidden).toBe(false);
  expect(notice.textContent).toMatch(/2 of 3 enabled account profiles are reporting.*Zeta.*disarmed/s);
  expect((app.w.document.getElementById('suppressMajorityAlarm') as HTMLButtonElement).hidden).toBe(true);
});

it('clears a prior fleet alarm candidate when a later fleet observation becomes unavailable', async () => {
  const old = Date.now() - 11 * 60_000;
  const fleet: AutomationSupervisorSnapshot = {
    observedAt: Date.now(), targetLanes: 3,
    chats: ['one', 'two', 'three'].map((id, index) => ({
      sessionId: `fleet-session-${id}`, conversationId: `fleet-chat-${id}`, title: id, mode: 'loop' as const,
      state: index < 2 ? 'stalled' as const : 'working' as const,
      reason: '', nextAction: '', nextRetryAt: null, lastWorkedAt: old, activeWorkers: 0,
      recoverable: false, spinning: false, recoveryStage: null
    })),
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 2, paused: 0, blocked: 0 }
  };
  const complete: FleetAutomationAlarmView = {
    snapshot: fleet,
    coverage: { state: 'complete', expectedProfiles: 3, reportingProfiles: 3, missingProfiles: [], graceEndsAt: null }
  };
  const app = await boot([], false, [], [], { automationProfile: 'day', automation: fleet, alarmAutomation: complete });
  const scheduled: Array<() => void> = [];
  const originalSetTimeout = app.w.setTimeout.bind(app.w);
  app.w.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === MAJORITY_ALARM_OBSERVATION_GAP_MS && typeof handler === 'function') {
      scheduled.push(() => handler(...args));
      return 987_656;
    }
    return originalSetTimeout(handler, delay, ...args);
  }) as typeof app.w.setTimeout;
  app.state.config.ui.automationProfile = 'overnight';
  const chat = await import('../src/renderer/chat.js');
  chat.chatApply(app.state as unknown as AppState);
  expect(JSON.parse(app.w.localStorage.getItem('cos-majority-stalled-alarm:v1') ?? '{}').candidateKey).toBeTruthy();

  app.setAlarmAutomation({
    snapshot: null,
    coverage: {
      state: 'incomplete', expectedProfiles: 3, reportingProfiles: 2,
      missingProfiles: ['Zeta'], graceEndsAt: Date.now() - 1
    }
  });
  scheduled.shift()!();
  await settle();
  const cleared = JSON.parse(app.w.localStorage.getItem('cos-majority-stalled-alarm:v1') ?? '{}');
  expect(cleared.candidateKey ?? null).toBeNull();
  expect(app.w.document.getElementById('automationAlarmNotice')!.hidden).toBe(false);
  expect(scheduled).toHaveLength(1);
});

it('keeps Do not ring in a dedicated incident notice when unrelated toasts are replaced', async () => {
  const now = Date.now();
  const fleet: AutomationSupervisorSnapshot = {
    observedAt: now,
    targetLanes: 3,
    chats: ['a', 'b', 'c'].map((id, index) => ({
      sessionId: `fleet-session-${id}`, conversationId: id, title: `Chat ${id}`, mode: 'loop' as const,
      state: index < 2 ? 'stalled' as const : 'working' as const,
      reason: '', nextAction: '', nextRetryAt: null, lastWorkedAt: now - 11 * 60_000,
      activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null
    })),
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 2, paused: 0, blocked: 0 }
  };
  const app = await boot([], false, [], [], {
    automationProfile: 'overnight',
    automation: fleet,
    alarmAutomation: {
      snapshot: fleet,
      coverage: { state: 'complete', expectedProfiles: 3, reportingProfiles: 3, missingProfiles: [], graceEndsAt: null }
    },
    alarmState: {
      candidateKey: 'a|b', candidateObservations: 1,
      lastObservedAt: now - MAJORITY_ALARM_OBSERVATION_GAP_MS,
      activeIncidentKey: 'a|b'
    }
  });

  const notice = app.w.document.getElementById('automationAlarmNotice')!;
  const suppress = app.w.document.getElementById('suppressMajorityAlarm') as HTMLButtonElement;
  expect(notice.hidden).toBe(false);
  expect(suppress.hidden).toBe(false);
  expect(notice.textContent).toContain('Do not ring');

  const { toast } = await import('../src/renderer/dom.js');
  toast('Unrelated diagnostic');
  expect(app.w.document.querySelector('.toast')?.textContent).toBe('Unrelated diagnostic');
  expect(notice.isConnected).toBe(true);
  expect(notice.hidden).toBe(false);
  expect(suppress.hidden).toBe(false);

  suppress.click();
  const saved = JSON.parse(app.w.localStorage.getItem('cos-majority-stalled-alarm:v1') ?? '{}');
  expect(saved.suppressedKey).toBe('a|b');
  expect(notice.hidden).toBe(true);
});

it('patches native reactions in place and hides streamed envelopes without changing authored messages', async () => {
  const user: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', messageId: 'reaction-user', message: text('Question') };
  const answer: SessionEvent = { kind: 'assistant_message', seq: 2, time: T0 + 1, source: 'extension', messageId: 'reaction-answer', message: text('\uE200message_'), final: false };
  const { w, append } = await boot([user, answer]);
  const bubble = w.document.querySelector('.said.is-user')!;
  expect(w.document.querySelector<HTMLElement>('.ev-assistant_message')!.hidden).toBe(true);
  for (const [index, reaction] of ['😂', '❤️', null].entries()) {
    await append([{ ...user, seq: index + 3, origin: 1, reaction }]);
    expect(w.document.querySelector('.said.is-user')).toBe(bubble);
    expect(w.document.querySelector('.message-reaction')?.textContent ?? null).toBe(reaction);
  }
  expect(bubble.textContent).toContain('Question');
  await append([{ ...answer, seq: 7, origin: 2, message: text('\uE200message_reaction\uE202😂\uE201\nThe answer.'), final: true }]);
  expect(w.document.querySelector('.ev-assistant_message .msg')?.textContent?.trim()).toBe('The answer.');
  expect(w.document.querySelector('.message-reaction')).toBeNull(); // Never infer a target from adjacency.
});

it('keeps a reaction on the native question across interim messages, tools and injected corrections', async () => {
  const question: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension',
    messageId: 'native-question', message: text('Original native question'), reaction: '👀' };
  const middle: SessionEvent[] = Array.from({ length: 40 }, (_, i) => ({ kind: 'assistant_message', seq: i + 2,
    time: T0 + i + 1, source: 'extension', messageId: `interim-${i}`, message: text(`Update ${i}`), final: false }));
  const tools = Array.from({ length: 8 }, (_, i) => ({ ...toolCall(i + 42, `reaction-call-${i}`), time: T0 + i + 41 }));
  const injected: SessionEvent = { kind: 'user_message', seq: 50, time: T0 + 49, source: 'app', messageId: 'input:correction',
    inputId: 'correction', inputDelivery: 'confirmed', message: text('An injected correction') };
  const final: SessionEvent = { kind: 'assistant_message', seq: 51, time: T0 + 50, source: 'extension', messageId: 'final',
    message: text('\uE200message_reaction\uE202👀\uE201\nFinished.'), final: true };
  const { w } = await boot([question, ...middle, ...tools, injected, final]);
  const badges = [...w.document.querySelectorAll('.message-reaction')];
  expect(badges).toHaveLength(1);
  expect(badges[0]!.closest('.said')!.textContent).toContain('Original native question');
  const correction = [...w.document.querySelectorAll('.said.is-user')].find(node => node.textContent?.includes('An injected correction'))!;
  expect(correction.querySelector('.message-reaction')).toBeNull();
  expect(w.document.getElementById('timeline')!.textContent).not.toContain('message_reaction');
});

it('shows automation health, separates the operating profile and retries recoverable chats', async () => {
  const row = { ...summary([]), fileEdits: 3, linesAdded: 24, linesRemoved: 7, lastFileChangeAt: T0 + 9 * 60_000 };
  const ordinary = {
    ...summary([]),
    id: '2026-09-02-live-ordinary',
    title: 'Live ordinary chat',
    conversationId: 'chat-ordinary',
    chatIds: ['chat-ordinary'],
    activityExpiresAt: Date.now() + 60_000
  };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0 + 10 * 60_000,
    targetLanes: 5,
    counts: { working: 2, 'waiting-workers': 1, 'waiting-main': 0, recovering: 1, stalled: 1, paused: 0, blocked: 0 },
    chats: [{
      sessionId: row.id,
      conversationId: row.conversationId!,
      title: row.title,
      mode: 'loop',
      state: 'stalled',
      reason: 'This Loop has no fresh work.',
      nextAction: 'Reload the exact chat.',
      nextRetryAt: null,
      lastWorkedAt: T0,
      activeWorkers: 0,
      recoverable: true,
      spinning: false,
      recoveryStage: null
    }]
  };
  const { w, live } = await boot([], true, [], [], { sessions: [row, ordinary], automation });
  const overview = w.document.getElementById('workOverview') as HTMLDetailsElement;
  expect(overview.open).toBe(true);
  expect(overview.textContent).not.toContain('Reading current work…');
  expect(w.document.getElementById('workOverviewMeta')!.textContent).toContain('1 recent signal');
  expect(w.document.getElementById('workOverviewMeta')!.textContent).toContain('1 attention');
  expect(overview.textContent).toContain('Current work');
  expect(overview.textContent).toContain('Loop under test');
  expect(overview.textContent).toContain('Reload the exact chat.');
  expect(overview.textContent).toContain('Live ordinary chat');
  expect(overview.textContent).toContain('Current execution is unverified. Recent turn or tool activity is saved; inspect its exact outcomes.');
  expect(overview.textContent).toContain('Recent updates');
  expect(overview.textContent).toContain('Recorded edits · provider unverified');
  expect(overview.textContent).toContain('no current-provider edit is proven by these totals');
  expect(overview.textContent).not.toContain('3 file edits');
  expect(w.document.getElementById('automationSupervisorSummary')!.textContent).toContain('2 working');
  expect(w.document.getElementById('automationSupervisorSummary')!.textContent).toContain('1 needs attention');
  const pill = w.document.querySelector('.sess-automation-state') as HTMLElement;
  expect(pill.textContent).toBe('needs attention');
  expect(pill.classList.contains('is-stalled')).toBe(true); // Backend state stays diagnostic-only.
  expect(pill.title).toContain('Reload the exact chat.');
  const mode = w.document.querySelector('.sess-mode-badge.is-loop') as HTMLElement;
  expect(mode.textContent).toBe('L');
  expect(mode.title).toBe('Loop');

  const recover = w.document.getElementById('recoverStaleAutomation') as HTMLButtonElement;
  expect(recover.disabled).toBe(false);
  expect(recover.textContent).toContain('1');
  recover.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: '*', action: 'recover-stale' });

  const profile = w.document.getElementById('automationProfile') as HTMLSelectElement;
  profile.value = 'overnight';
  profile.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(live.controlCalls).toContainEqual({ id: '*', action: 'profile:overnight' });
});

it('keeps ordinary activity evidence visible without claiming a currently executing native turn', async () => {
  const now = Date.now();
  const base = summary([]);
  const recent: SessionSummary = { ...base, id: 'ordinary-recent-evidence',
    title: 'Recent ordinary work', conversationId: 'ordinary-recent-provider',
    chatIds: ['ordinary-recent-provider'], activeTurnId: null, lastTurnOutcome: null,
    lastToolCallAt: now - 300, activityExpiresAt: now + 60_000 };
  const open: SessionSummary = { ...recent, id: 'ordinary-open-turn', title: 'Ordinary turn open',
    conversationId: 'ordinary-open-provider', chatIds: ['ordinary-open-provider'],
    activeTurnId: 'ordinary-open-turn-id' };
  const { w } = await boot([], true, [], [], { sessions: [recent, open] });
  const doc = w.document;
  const current = doc.querySelector<HTMLElement>('[data-work-section="current"]')!;
  const recentRow = current.querySelector<HTMLButtonElement>(`[data-session-id="${recent.id}"]`)!;
  const openRow = current.querySelector<HTMLButtonElement>(`[data-session-id="${open.id}"]`)!;
  expect(recentRow).not.toBeNull();
  expect(openRow).not.toBeNull();
  expect(doc.getElementById('workOverviewMeta')!.textContent).toContain('2 recent signals');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('working');
  expect(recentRow.querySelector('.work-overview-state')?.textContent).toBe('recent evidence');
  expect(openRow.querySelector('.work-overview-state')?.textContent).toBe('turn open');
  expect(recentRow.querySelector('.work-overview-state.is-unknown')).not.toBeNull();
  expect(openRow.querySelector('.work-overview-state.is-unknown')).not.toBeNull();
  expect(recentRow.textContent).toContain('Current execution is unverified');
  expect(openRow.textContent).toContain('Open native turn is recorded; current execution is unverified');
  const sidebar = doc.querySelector<HTMLElement>(`#sessionList [data-id="${recent.id}"]`)!;
  expect(sidebar.querySelector('.session-status.is-active')).toBeNull();
  expect(sidebar.title).toContain('Recent turn or tool activity; current execution unverified');
  recentRow.click();
  await settle();
  expect(doc.getElementById('workOverviewPane')!.textContent)
    .toContain('Recent work signal recorded; current execution has not been confirmed.');
});

it('displays a verified per-chat Off setting separately from global pause, never adopting older provider controls', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), id: 'ordinary-off-with-global-pause',
    title: 'Deliberate ordinary one-off', conversationId: 'ordinary-off-provider',
    chatIds: ['ordinary-off-provider'], lastAssistantFinalAt: now - 1000 };
  const app = await boot([], true, [], [], { sessions: [row], automationPaused: true,
    controls: { conversationId: row.conversationId, activeTurnId: row.activeTurnId, automation: 'off' } });
  const doc = app.w.document;
  doc.querySelector<HTMLButtonElement>(`[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const mode = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Automation setting');
  expect(mode?.textContent).toContain('Off for this chat');
  expect(mode?.textContent).toContain('does not schedule new Goal or Loop work');
  expect(pane.textContent).toContain('Account-wide automation pause ON');
  expect(app.live.sent).toEqual([]);
  const rebound: SessionSummary = { ...row, conversationId: 'new-provider',
    chatIds: [...row.chatIds, 'new-provider'] };
  await app.replaceSessions([rebound]);
  app.notifySession();
  await settle();
  expect(pane.textContent).not.toContain('Off for this chat');
});

it('styles every Work recovery stage as waiting and stalled attention as failed without implying native Send', async () => {
  const labels: Record<NonNullable<AutomationChatProjection['recoveryStage']>, string> = {
    core: 'waiting for Core', queued: 'Chrome action queued', 'browser-action': 'repairing Chrome',
    'checking-activity': 'verifying repair', 'waiting-browser': 'waiting for Chrome',
    'focusing-existing-tab': 'focusing existing tab', 'reopening-missing-tab': 'reopening missing tab',
    'waiting-activity': 'waiting for activity', 'retry-scheduled': 'retry scheduled',
    handoff: 'writing handoff', draft: 'preparing reply', 'pending-reply': 'reply pending',
    cooldown: 'retry waiting'
  };
  const stages = Object.keys(labels) as Array<NonNullable<AutomationChatProjection['recoveryStage']>>;
  const rows = stages.map((stage, index) => ({ ...summary([]), id: 'work-recovery-' + stage,
    title: 'Recovery ' + stage, conversationId: 'provider-recovery-' + stage,
    chatIds: ['provider-recovery-' + stage], activeTurnId: null, updatedAt: T0 + index }));
  const stalled = { ...summary([]), id: 'work-recovery-stalled', title: 'Stalled Loop needs attention',
    conversationId: 'provider-recovery-stalled', chatIds: ['provider-recovery-stalled'],
    activeTurnId: null, updatedAt: T0 + 100 };
  const projection = (row: typeof rows[number] | typeof stalled, state: 'recovering' | 'stalled',
    recoveryStage: NonNullable<AutomationChatProjection['recoveryStage']> | null): AutomationChatProjection => ({
      sessionId: row.id, conversationId: row.conversationId!, title: row.title, mode: 'loop', state,
      reason: 'Existing recorded recovery status.', nextAction: 'Inspect exact saved evidence.', nextRetryAt: null,
      lastWorkedAt: T0, activeWorkers: 0, recoverable: true, spinning: false, recoveryStage
    });
  const automation: AutomationSupervisorSnapshot = { observedAt: T0 + 200, targetLanes: stages.length + 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: stages.length,
      stalled: 1, paused: 0, blocked: 0 },
    chats: [...rows.map(row => projection(row, 'recovering',
      stages.find(stage => row.id === 'work-recovery-' + stage)!)), projection(stalled, 'stalled', null)] };
  const { w } = await boot([], true, [], [], { sessions: [...rows, stalled], automation });
  for (const row of rows) {
    const state = w.document.querySelector<HTMLElement>(
      `#workOverview [data-session-id="${row.id}"] .work-overview-state`);
    expect(state?.textContent).toBe(labels[row.id.replace('work-recovery-', '') as keyof typeof labels]);
    expect(state?.classList.contains('is-waiting')).toBe(true);
  }
  const pendingReply = w.document.querySelector<HTMLElement>(
    '#workOverview [data-session-id="work-recovery-pending-reply"] .work-overview-state');
  expect(pendingReply?.textContent).toBe('reply pending');
  expect(w.document.getElementById('workOverview')!.textContent).not.toContain('sending reply');
  const stalledState = w.document.querySelector<HTMLElement>(
    '#workOverview [data-session-id="work-recovery-stalled"] .work-overview-state');
  expect(stalledState?.textContent).toBe('needs attention');
  expect(stalledState?.classList.contains('is-failed')).toBe(true);
});

it('keeps locally blocked ordinary conversations visible after activity expires instead of calling them recent work', async () => {
  const base = summary([]);
  const recent: SessionSummary = { ...base, id: 'ordinary-locally-blocked-recent',
    title: 'Blocked ordinary chat with recent tool', conversationId: 'locally-blocked-recent',
    chatIds: ['locally-blocked-recent'], lastToolCallAt: Date.now() - 200,
    activityExpiresAt: Date.now() + 60_000 };
  const stale: SessionSummary = { ...recent, id: 'ordinary-locally-blocked-stale',
    title: 'Blocked ordinary chat without recent signal', conversationId: 'locally-blocked-stale',
    chatIds: ['locally-blocked-stale'], activityExpiresAt: null };
  const app = await boot([], true, [], [], { sessions: [recent, stale],
    blocked: [recent.conversationId!, stale.conversationId!] });
  const doc = app.w.document;
  const current = doc.querySelector<HTMLElement>('[data-work-section="current"]')!;
  for (const row of [recent, stale]) {
    const item = current.querySelector<HTMLButtonElement>(`[data-session-id="${row.id}"]`)!;
    expect(item).not.toBeNull();
    expect(item.querySelector('.work-overview-state.is-failed')?.textContent).toBe('blocked');
  }
  expect(doc.getElementById('workOverviewMeta')!.textContent).toContain('2 blocked');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('recent signal');
  current.querySelector<HTMLButtonElement>(`[data-session-id="${stale.id}"]`)!.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Local conversation block is active');
  expect(pane.textContent).toContain('Current execution is not established');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('explains exact per-chat Off before a conflicting Goal supervisor snapshot without inventing helper custody', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), id: 'goal-supervisor-off-boundary',
    title: 'Goal was switched Off', conversationId: 'goal-off-current-provider',
    chatIds: ['goal-off-current-provider'], lastToolCallAt: now - 400,
    activityExpiresAt: now + 60_000 };
  const supervisor: AutomationSupervisorSnapshot = {
    observedAt: now - 500, targetLanes: 1,
    counts: { working: 0, blocked: 1, paused: 0, recovering: 0, stalled: 0,
      'waiting-main': 0, 'waiting-workers': 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'goal', state: 'blocked', reason: 'Older supervisor still observes a provider hold.',
      nextAction: 'Inspect exact current controls.', nextRetryAt: null, lastWorkedAt: now - 500,
      activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation: supervisor,
    controls: { sessionId: row.id, conversationId: row.conversationId,
      automation: 'off', activeTurnId: row.activeTurnId } });
  const doc = app.w.document;
  doc.querySelector<HTMLButtonElement>(`[data-work-section="current"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const current = doc.querySelector<HTMLButtonElement>(`[data-work-section="current"] [data-session-id="${row.id}"]`)!;
  expect(current.querySelector('.work-overview-state')?.textContent).toBe('off');
  expect(current.querySelector('.work-overview-state.is-paused')).not.toBeNull();
  expect(current.textContent).toContain('Older supervisor');
  expect(current.textContent).toContain('provider hold');
  expect(doc.getElementById('workOverviewMeta')?.textContent).toContain('1 off');
  expect(doc.getElementById('workOverviewMeta')?.textContent).not.toContain('1 blocked');
  const sidebar = doc.querySelector<HTMLElement>(`#sessionList [data-id="${row.id}"]`)!;
  expect(sidebar.querySelector('.sess-mode-badge')).toBeNull();
  expect(sidebar.querySelector('.sess-automation-state')?.textContent).toBe('off');
  expect(sidebar.title).toContain('Off for this chat');
  const status = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Current status')!.textContent ?? '';
  expect(status).toContain('Goal/Loop Off for this chat');
  expect(status).toContain('separate supervisor observation');
  expect(status).toContain('Older supervisor still observes a provider hold.');
  const fieldText = (label: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === label)?.textContent ?? '';
  expect(fieldText('Just did')).toContain('Latest exact controls: Goal/Loop Off for this chat');
  expect(fieldText('Just did')).not.toBe('Just didOlder supervisor still observes a provider hold.');
  expect(fieldText('Next / blocker')).toContain('Off for this chat; no new Goal/Loop turn is scheduled');
  expect(fieldText('Next / blocker')).not.toContain('Inspect exact current controls.');
  expect([...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .filter(field => field.querySelector('b')?.textContent === 'Automation setting')).toHaveLength(0);
  expect(pane.textContent).not.toContain('Private helper custody unavailable');
  expect(pane.textContent).toContain('Helper custody unavailable for the earlier Goal state');
  expect(pane.textContent).toContain('historical custody, not proof of current helper execution');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('does not project an earlier exact Off control over a newer supervisor or replacement provider', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), id: 'work-off-rebind-guard',
    conversationId: 'verified-off-A', chatIds: ['verified-off-A'], title: 'Off with later work evidence' };
  const supervisor: AutomationSupervisorSnapshot = {
    observedAt: now - 500, targetLanes: 1,
    counts: { working: 1, blocked: 0, paused: 0, recovering: 0, stalled: 0,
      'waiting-main': 0, 'waiting-workers': 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: 'working', spinning: true, reason: 'Earlier supervisor saw active work.',
      nextAction: 'Review current work evidence.', lastWorkedAt: now - 500,
      nextRetryAt: null, activeWorkers: 0, recoverable: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation: supervisor,
    controls: { sessionId: row.id, conversationId: row.conversationId,
      automation: 'off', activeTurnId: null } });
  const doc = app.w.document;
  const state = () => doc.querySelector<HTMLElement>(
    `[data-work-section="current"] [data-session-id="${row.id}"] .work-overview-state`)?.textContent;
  doc.querySelector<HTMLButtonElement>(`[data-work-section="current"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  expect(state()).toBe('off');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('working');
  doc.getElementById('workOverviewPane')!.querySelector<HTMLButtonElement>('[data-work-action="close"]')!.click();
  // Closing a read-only detail must not make the already observed exact setting
  // revert to the older Working claim until genuinely newer evidence exists.
  expect(state()).toBe('off');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('working');
  expect(doc.querySelector<HTMLElement>(`#sessionList [data-id="${row.id}"] .sess-automation-state`)?.textContent).toBe('off');
  doc.querySelector<HTMLButtonElement>(`[data-work-section="current"] [data-session-id="${row.id}"]`)!.click();
  await settle();

  supervisor.observedAt = Date.now() + 60_000;
  app.notifySession();
  await settle();
  expect(state()).toBe('working');
  expect(doc.getElementById('workOverviewMeta')!.textContent).toContain('1 working');

  const successor: SessionSummary = { ...row, conversationId: 'new-provider-B',
    chatIds: ['verified-off-A', 'new-provider-B'], updatedAt: now + 1_000 };
  await app.replaceSessions([successor]);
  expect(state()).toBe('unknown');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('1 off');
  expect(doc.querySelector<HTMLElement>(`#sessionList [data-id="${row.id}"] .sess-automation-state`)?.textContent).toBe('unknown');
  // An independent exact B read may confirm B's Off setting, but cannot turn
  // the old A supervisor projection into a current B work or provider hold.
  (app.w as any).api.getSessionControls = () => Promise.resolve({ ok: true,
    data: { sessionId: row.id, conversationId: successor.conversationId,
      automation: 'off', activeTurnId: null, finishHeld: false, plan: null } });
  doc.getElementById('workOverviewPane')!.querySelector<HTMLButtonElement>('[data-work-action="close"]')!.click();
  doc.querySelector<HTMLButtonElement>(`[data-work-section="current"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  expect(doc.getElementById('workOverviewPane')!.textContent)
    .toContain('Current-provider controls report Off, while the supervisor still references the previous provider.');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('retires an inspected Off receipt when a different native turn opens in the SAME provider', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), id: 'work-off-stale-turn-same-provider',
    title: 'New native B turn cannot inherit earlier A Off',
    conversationId: 'unchanged-provider', chatIds: ['unchanged-provider'],
    activeTurnId: 'native-A', lastMessageAt: now - 4_000, updatedAt: now - 4_000 };
  const supervisor: AutomationSupervisorSnapshot = { observedAt: now - 8_000, targetLanes: 1,
    counts: { working: 0, blocked: 1, paused: 0, recovering: 0, stalled: 0,
      'waiting-main': 0, 'waiting-workers': 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: 'blocked', reason: 'Previous observation needs sign-in review.',
      nextAction: 'Inspect exact provider state; do not replay.', nextRetryAt: null,
      lastWorkedAt: now - 8_000, activeWorkers: 0, recoverable: false,
      spinning: false, recoveryStage: null }] };
  const app = await boot([], true, [], [], { sessions: [row], automation: supervisor,
    controls: { sessionId: row.id, conversationId: row.conversationId,
      activeTurnId: 'native-A', automation: 'off' } });
  const doc = app.w.document;
  const state = () => doc.querySelector<HTMLElement>(
    `[data-work-section="current"] [data-session-id="${row.id}"] .work-overview-state`)?.textContent;
  doc.querySelector<HTMLButtonElement>(
    `[data-work-section="current"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  expect(state()).toContain('off');
  doc.querySelector<HTMLButtonElement>('#workOverviewPane [data-work-action="close"]')!.click();
  const successor: SessionSummary = { ...row, activeTurnId: 'native-B',
    updatedAt: now + 2_000, lastMessageAt: now + 2_000 };
  await app.replaceSessions([successor]);
  expect(state()).not.toContain('off');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('1 off');
  expect(doc.querySelector<HTMLElement>(`#sessionList [data-id="${row.id}"] .sess-automation-state`)?.textContent)
    .not.toContain('off');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('does not headline previous same-provider A tool failure or provider error as B current work', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), id: 'same-provider-prior-tool-and-error',
    title: 'A failed before B turn began',
    conversationId: 'same-provider-A-and-B', chatIds: ['same-provider-A-and-B'],
    activeTurnId: 'exact-B-turn', updatedAt: now, lastMessageAt: now - 100,
    lastToolCallAt: now - 3_000, lastTurnEndAt: null, activityExpiresAt: now - 1_000 };
  const originalTool = toolCall(2, 'original-tool-rejected') as Extract<SessionEvent, { kind: 'tool_call' }>;
  const failed: SessionEvent = { ...originalTool, time: now - 3_000, turnId: 'previous-A-turn',
    call: { ...originalTool.call, outcome: 'tool_rejected',
      summary: { kind: 'read', title: 'Historical A local Core refusal', tone: 'bad' } } };
  const priorError: SessionEvent = { kind: 'chat_error', seq: 3, time: now - 2_000,
    source: 'extension', turnId: 'previous-A-turn', blocking: true, recoverable: false,
    message: text('Provider A error must not be B current provider failure.') };
  const history: SessionEvent[] = [failed, priorError];
  const app = await boot([], true, [], [], { sessions: [row],
    sessionEvents: { [row.id]: history }, controls: { activeTurnId: row.activeTurnId } });
  const doc = app.w.document;
  doc.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
  expect(field('Just did')).toContain('no exact current-turn final or tool outcome');
  expect(field('Just did')).not.toContain('Historical A local Core refusal');
  expect(field('Just did')).not.toContain('Provider A error');
  expect(field('Provider evidence')).toContain('not tied to the current');
  expect(field('Current status')).toContain('unverified');
  expect(pane.textContent).toContain('Historical A local Core refusal');
  expect(pane.textContent).toContain('Provider A error');
  // When an exact native B provider error arrives, that error changes only
  // B's current status; earlier A tools remain historical and readable.
  history.push({ ...priorError, seq: 4, time: now - 500, turnId: row.activeTurnId!,
    message: text('Current B provider restriction with exact turn identity.') });
  app.notifySession();
  await settle(700);
  expect(field('Just did')).toContain('Current B provider restriction');
  expect(field('Just did')).not.toContain('Historical A local Core refusal');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('keeps verified Off separate from an exact still-open turn and retires stale turn evidence after an observed close', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), id: 'off-with-open-native-turn',
    title: 'Off while last native turn settles', conversationId: 'off-open-provider',
    chatIds: ['off-open-provider'], activeTurnId: 'native-exact-turn',
    updatedAt: now - 1_000, lastToolCallAt: now - 2_000 };
  const supervisor: AutomationSupervisorSnapshot = {
    observedAt: now - 3_000, targetLanes: 1,
    counts: { working: 1, blocked: 0, paused: 0, recovering: 0, stalled: 0,
      'waiting-main': 0, 'waiting-workers': 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: 'working', spinning: true, reason: 'Previous active generation',
      nextAction: 'Inspect exact tool result.', nextRetryAt: null, lastWorkedAt: now - 3_000,
      activeWorkers: 0, recoverable: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation: supervisor,
    controls: { sessionId: row.id, conversationId: row.conversationId,
      automation: 'off', activeTurnId: row.activeTurnId } });
  const doc = app.w.document;
  const currentRow = () => doc.querySelector<HTMLButtonElement>(
    `[data-work-section="current"] [data-session-id="${row.id}"]`)!;
  currentRow().click();
  await settle();
  expect(currentRow().querySelector('.work-overview-state.is-paused')?.textContent).toBe('off · turn open');
  expect(currentRow().textContent).toContain('ongoing execution and completion remain unverified');
  expect(doc.querySelector(`#sessionList [data-id="${row.id}"] .session-status.is-working`)).toBeNull();
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('working');
  const pane = doc.getElementById('workOverviewPane')!;
  pane.querySelector<HTMLButtonElement>('[data-work-action="close"]')!.click();
  expect(currentRow().querySelector('.work-overview-state')?.textContent).toBe('off · turn open');

  await app.replaceSessions([{ ...row, activeTurnId: null, lastTurnOutcome: 'completed',
    lastTurnEndAt: Date.now(), updatedAt: Date.now() + 1_000 }]);
  expect(currentRow().querySelector('.work-overview-state')?.textContent).toBe('off');
  expect(currentRow().textContent).not.toContain('The native turn is open');
  expect(doc.querySelector<HTMLElement>(`#sessionList [data-id="${row.id}"] .sess-automation-state`)?.textContent).toBe('off');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('working');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('retains exact Off across inspecting another Work result without borrowing its controls', async () => {
  const now = Date.now();
  const off: SessionSummary = { ...summary([]), id: 'off-then-other-work',
    conversationId: 'off-original-provider', chatIds: ['off-original-provider'],
    title: 'Off with saved supervisor history' };
  const oneoff: SessionSummary = { ...summary([]), id: 'unrelated-read-only-result',
    conversationId: 'unrelated-provider', chatIds: ['unrelated-provider'],
    title: 'Unrelated saved answer', lastAssistantFinalAt: now - 300,
    lastTurnEndAt: now - 250, lastTurnOutcome: 'completed' };
  const supervisor: AutomationSupervisorSnapshot = { observedAt: now - 2000, targetLanes: 1,
    counts: { working: 0, blocked: 1, paused: 0, recovering: 0, stalled: 0,
      'waiting-main': 0, 'waiting-workers': 0 },
    chats: [{ sessionId: off.id, conversationId: off.conversationId!, title: off.title,
      mode: 'goal', state: 'blocked', spinning: false,
      reason: 'Prior provider hold remains in supervisor.', nextAction: 'Inspect prior hold.',
      nextRetryAt: null, lastWorkedAt: now - 2_000, activeWorkers: 0,
      recoverable: false, recoveryStage: null }] };
  const app = await boot([], true, [], [], { sessions: [off, oneoff], automation: supervisor,
    controls: { sessionId: off.id, conversationId: off.conversationId,
      automation: 'off', activeTurnId: null } });
  const doc = app.w.document;
  const offRow = () => doc.querySelector<HTMLButtonElement>(
    `[data-work-section="current"] [data-session-id="${off.id}"]`)!;
  offRow().click();
  await settle();
  expect(offRow().querySelector('.work-overview-state')?.textContent).toBe('off');
  expect(doc.getElementById('workOverviewMeta')!.textContent).toContain('1 off');
  doc.querySelector<HTMLButtonElement>(
    `[data-work-section="updates"] [data-session-id="${oneoff.id}"]`)!.click();
  await settle();
  expect(doc.getElementById('workOverviewPane')!.textContent).toContain('Unrelated saved answer');
  expect(offRow().querySelector('.work-overview-state')?.textContent).toBe('off');
  expect(doc.querySelector<HTMLElement>(`#sessionList [data-id="${off.id}"] .sess-automation-state`)?.textContent).toBe('off');
  expect(doc.getElementById('workOverviewMeta')!.textContent).toContain('1 off');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('1 blocked');
  await app.replaceSessions([{ ...off, conversationId: 'off-rebound-new-provider',
    chatIds: ['off-original-provider', 'off-rebound-new-provider'], updatedAt: now + 2000 }, oneoff]);
  expect(offRow().querySelector('.work-overview-state')?.textContent).toBe('unknown');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('1 off');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('keeps one authorized Recover stale request pending through duplicate session redraws', async () => {
  const row = summary([]);
  const supervisor: AutomationSupervisorSnapshot = {
    observedAt: T0, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0,
      stalled: 1, paused: 0, blocked: 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: 'stalled', reason: 'Exact bounded recovery exhausted.',
      nextAction: 'Request a manual retry.', nextRetryAt: null, lastWorkedAt: T0,
      activeWorkers: 0, recoverable: true, spinning: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation: supervisor });
  const api = (app.w as any).api;
  let finish!: (result: unknown) => void;
  let recoveryCalls = 0;
  api.recoverStaleAutomationChats = () => {
    recoveryCalls++;
    return new Promise(resolve => { finish = resolve; });
  };
  const retry = app.w.document.getElementById('recoverStaleAutomation') as HTMLButtonElement;
  retry.click();
  expect(recoveryCalls).toBe(1);
  expect(retry.disabled).toBe(true);
  app.notifySession();
  app.notifySession();
  await settle(700);
  expect(retry.disabled).toBe(true);
  retry.click();
  expect(recoveryCalls).toBe(1);
  finish({ ok: true, data: { queued: 1, alreadyWorking: 0, alreadyRecovering: 0, skipped: 0 } });
  await settle(700);
  expect(retry.disabled).toBe(false);
});

it('shows account pause, recorded native approval and a positively unsent saved reply as separate Work holds', async () => {
  const row: SessionSummary = { ...summary([]), id: 'work-distinct-global-pause',
    conversationId: 'paused-provider', chatIds: ['paused-provider'], title: 'Saved Loop work' };
  const waiting: SessionEvent = { kind: 'progress', source: 'app', seq: 1, time: T0 + 1_000,
    progressId: 'approval-wait:paused-provider:1', message: text(APPROVAL_WAITING_TEXT) };
  const queued = { id: 'saved-not-sent', sessionId: row.id, conversationId: row.conversationId,
    state: 'queued', owner: null, text: 'Do not replay this saved reply', mode: 'after-turn',
    dueAt: T0, createdAt: T0, model: null, reasoningEffort: null } as InputEntry;
  const projection: AutomationSupervisorSnapshot = { observedAt: Date.now(), targetLanes: 1,
    counts: { working: 1, 'waiting-main': 0, 'waiting-workers': 0, recovering: 0, blocked: 0, paused: 0, stalled: 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title, mode: 'loop',
      state: 'working', spinning: true, reason: 'Older supervisor says working',
      nextAction: 'Keep working', lastWorkedAt: T0, nextRetryAt: null, activeWorkers: 0,
      recoverable: false, recoveryStage: null }] };
  const app = await boot([], true, [], [], { sessions: [row], automation: projection,
    automationPaused: true, sessionEvents: { [row.id]: [waiting] }, inputs: [queued] });
  (app.w as any).api.decisionHelperCustody = () =>
    Promise.resolve({ ok: false, error: 'Optional helper IPC unavailable on this Loop fixture' });
  const doc = app.w.document;
  const current = doc.querySelector<HTMLButtonElement>(
    '.work-overview-section[data-work-section="current"] [data-session-id="' + row.id + '"]')!;
  expect(current.textContent).toContain('paused');
  expect(current.textContent).not.toContain('working');
  current.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const facts = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(el => el.querySelector('b')?.textContent === 'Status & next action')?.textContent ?? '';
  expect(facts).toContain('Account-wide automation pause ON');
  expect(facts).toContain('Provider tool approval observed');
  expect(facts).toContain('Saved input awaiting native Send');
  expect(facts).toContain('Recorded separately: Account-wide automation pause ON · Provider tool approval observed · Saved input awaiting native Send');
  expect(facts).toContain('Delivery queue');
  expect(facts).not.toContain('Private helper custody unavailable');
  expect(facts).not.toContain('Native Send confirmed');
  expect(pane.textContent).not.toContain(queued.text);
  const review = pane.querySelector<HTMLButtonElement>('[data-work-action="delivery"]')!;
  expect(review).not.toBeNull();
  review.focus(); review.click();
  const queue = doc.getElementById('deliveryQueuePanel') as HTMLDetailsElement;
  expect(queue.open).toBe(true);
  expect(doc.activeElement).toBe(queue.querySelector('summary'));
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it.each([
  { state: 'browser', sendAuthorizedAt: T0 + 500, offeredAt: undefined, label: 'Native Send receipt unresolved' },
  { state: 'tool', sendAuthorizedAt: undefined, offeredAt: T0 + 500, label: 'Tool handout awaiting receipt' }
] as const)('does not mislabel $state custody as a positively unsent queued reply', async item => {
  const row: SessionSummary = { ...summary([]), id: 'work-input-' + item.state,
    conversationId: 'provider-' + item.state, chatIds: ['provider-' + item.state],
    fileEdits: 1, lastFileChangeAt: T0 + 1_000 };
  const input = { id: 'pending-' + item.state, sessionId: row.id, conversationId: row.conversationId,
    text: 'Retained private input not rendered in Work', mode: 'after-turn', dueAt: T0,
    model: null, reasoningEffort: null, createdAt: T0, state: item.state,
    owner: 'existing-delivery-owner', sendAuthorizedAt: item.sendAuthorizedAt, offeredAt: item.offeredAt } as InputEntry;
  const app = await boot([], true, [], [], { sessions: [row], inputs: [input] });
  app.w.document.querySelector<HTMLButtonElement>(
    '.work-overview-section[data-work-section="updates"] [data-session-id="' + row.id + '"]')!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const facts = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(el => el.querySelector('b')?.textContent === 'Status & next action')?.textContent ?? '';
  expect(facts).toContain(item.label);
  expect(facts).not.toContain('Saved input awaiting native Send');
  expect(pane.textContent).not.toContain(input.text);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it.each([
  { state: 'browser', sendAuthorizedAt: T0 + 500, label: 'Native Send receipt unresolved' },
  { state: 'tool', sendAuthorizedAt: undefined, label: 'Tool handout awaiting receipt' }
] as const)('keeps an older $state delivery head visible beside a newer queued follower', async head => {
  const row: SessionSummary = { ...summary([]), id: 'work-head-and-follower-' + head.state,
    conversationId: 'provider-head-' + head.state, chatIds: ['provider-head-' + head.state],
    fileEdits: 1, lastFileChangeAt: T0 + 1_000 };
  const base = { sessionId: row.id, conversationId: row.conversationId, text: 'PRIVATE retained input',
    mode: 'after-turn', dueAt: T0, model: null, reasoningEffort: null };
  const original = { ...base, id: 'original-' + head.state, createdAt: T0, state: head.state,
    owner: 'original-delivery-owner', offeredAt: T0 + 100, sendAuthorizedAt: head.sendAuthorizedAt } as InputEntry;
  const follower = { ...base, id: 'queued-follower', createdAt: T0 + 10_000, state: 'queued', owner: null,
    queuedBehindDelivery: true } as InputEntry;
  const app = await boot([], true, [], [], { sessions: [row], inputs: [original, follower] });
  app.w.document.querySelector<HTMLButtonElement>(
    '.work-overview-section[data-work-section="updates"] [data-session-id="' + row.id + '"]')!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const facts = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(el => el.querySelector('b')?.textContent === 'Status & next action')?.textContent ?? '';
  expect(facts).toContain(head.label);
  expect(facts).toContain('Saved input awaiting native Send');
  expect(pane.textContent).not.toContain(base.text);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('shows the exact native completion hold and private helper collection without implying another Send', async () => {
  const row: SessionSummary = { ...summary([]), id: 'work-native-and-helper',
    conversationId: 'same-helper-provider', chatIds: ['same-helper-provider'],
    fileEdits: 1, lastFileChangeAt: T0 + 10_000 };
  const custody: SessionDecisionHelperCustody = { sessionId: row.id, conversationId: row.conversationId!,
    pendingOriginalReply: null, retainedTotal: 1, truncated: false,
    helpers: [{ id: 'helper-not-answered', sourceTurnId: 'original', createdAt: T0,
      state: 'sent', phase: 'awaiting-answer', nativeSend: 'confirmed', nativeMessageId: 'private-do-not-show',
      sendAuthorizedAt: T0, deliveredAt: T0, answer: 'not-recorded', rejection: null,
      sourceSuperseded: false, continuation: null }] };
  const app = await boot([], true, [], [], { sessions: [row],
    controls: { activeTurnId: null, conversationId: row.conversationId,
      goalWait: { reason: 'evidence', detail: 'Exact tool result missing for the original call.',
        nextAction: 'Read the original native completion receipt before continuing.' } } });
  (app.w as any).api.decisionHelperCustody = () => Promise.resolve({ ok: true, data: custody });
  app.w.document.querySelector<HTMLButtonElement>(
    '.work-overview-section[data-work-section="updates"] [data-session-id="' + row.id + '"]')!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const facts = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(el => el.querySelector('b')?.textContent === 'Status & next action')?.textContent ?? '';
  expect(facts).toContain('Native completion receipt unresolved');
  expect(facts).toContain('Exact tool result missing for the original call.');
  expect(facts).toContain('Private helper answer pending');
  expect(facts).toContain('Read the original native completion receipt');
  expect(facts).not.toContain('Private helper answer accepted');
  expect(facts).not.toContain('private-do-not-show');
  expect(app.live.sent).toEqual([]);
});

it('does not adopt old-provider approval or stream; keeps a resolved approval separate from a current recorded stream', async () => {
  const row: SessionSummary = { ...summary([]), id: 'work-provider-approval-boundary',
    conversationId: 'provider-B', chatIds: ['provider-A', 'provider-B'],
    activeTurnId: 'B-turn', fileEdits: 1, lastFileChangeAt: T0 + 10_000 };
  const events: SessionEvent[] = [
    { kind: 'progress', source: 'app', seq: 1, time: T0,
      progressId: 'approval-wait:provider-A:old', message: text(APPROVAL_WAITING_TEXT) },
    { kind: 'assistant_message', source: 'extension', seq: 2, time: T0 + 100,
      turnId: 'A-turn', messageId: 'old-stream', state: 'streaming', final: false, message: text('Historical stream') },
    { kind: 'progress', source: 'app', seq: 3, time: T0 + 1_000,
      progressId: 'approval-wait:provider-B:now', message: text(APPROVAL_ANSWERED_TEXT) },
    { kind: 'assistant_message', source: 'extension', seq: 4, time: T0 + 1_200,
      turnId: 'B-turn', messageId: 'B-stream', state: 'streaming', final: false, message: text('Recent stream fragment') }
  ];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events },
    controls: { activeTurnId: 'B-turn', conversationId: 'provider-B' } });
  app.w.document.querySelector<HTMLButtonElement>(
    '.work-overview-section[data-work-section="updates"] [data-session-id="' + row.id + '"]')!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const facts = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(el => el.querySelector('b')?.textContent === 'Status & next action')?.textContent ?? '';
  expect(facts).toContain('Provider tool approval answered');
  expect(facts).toContain('Streaming text recorded on this turn');
  expect(facts).not.toContain('Provider tool approval observed');
  expect(facts).not.toContain('Historical stream');
  expect(facts).not.toContain('approval-wait:provider-A');
  expect(app.live.sent).toEqual([]);
});

it('separates a prior same-provider approval and failed authorized Send from the new turn and its queued follower', async () => {
  const row: SessionSummary = { ...summary([]), id: 'approval-before-new-turn-with-failed-send',
    conversationId: 'same-provider', chatIds: ['same-provider'], title: 'Current B task with historical hold',
    activeTurnId: 'exact-turn-B', fileEdits: 1, lastFileChangeAt: T0 + 4_000,
    finishTurn: { turnId: 'exact-turn-B', conversationId: 'same-provider', startedAt: T0 + 4_000,
      notified: false, released: true, decisionRevision: null, workSeq: 0, decisionSeq: 0,
      decisionInputRevision: null } };
  const events: SessionEvent[] = [
    { kind: 'progress', source: 'app', seq: 1, time: T0 + 1_000,
      progressId: 'approval-wait:same-provider:old-A', message: text(APPROVAL_WAITING_TEXT) },
    { kind: 'turn_start', source: 'extension', seq: 2, time: T0 + 4_000, turnId: 'exact-turn-B' },
    { kind: 'assistant_message', source: 'extension', seq: 3, time: T0 + 4_100,
      turnId: 'exact-turn-B', messageId: 'B-stream', state: 'streaming',
      final: false, message: text('B is drafting while an older approval remains recorded.') }
  ];
  const failure = { id: 'unconfirmed-authorized-A', sessionId: row.id,
    conversationId: row.conversationId, text: 'PRIVATE ambiguous browser draft',
    state: 'failed', owner: null, createdAt: T0 + 600, dueAt: T0,
    mode: 'auto', sendAuthorizedAt: T0 + 900, model: null, reasoningEffort: null,
    recoveryFailure: { phase: 'native_send_ambiguous', retrySafe: false, detail: 'Provider status not established.' },
    error: 'Native authorization unresolved' } as InputEntry;
  const follower = { ...failure, id: 'saved-follower', state: 'queued', owner: null,
    text: 'PRIVATE next message', sendAuthorizedAt: undefined, recoveryFailure: undefined,
    error: undefined, createdAt: T0 + 5_000 } as InputEntry;
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events },
    inputs: [failure, follower], controls: { conversationId: row.conversationId, activeTurnId: 'exact-turn-B' } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const facts = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(el => el.querySelector('b')?.textContent === 'Status & next action')?.textContent ?? '';
  const firstFields = [...pane.querySelectorAll('.work-overview-pane-grid > .work-overview-pane-field > b')]
    .slice(0, 3).map(el => el.textContent);
  expect(firstFields).toEqual(['Just did', 'Current status', 'Status & next action']);
  expect(facts).toContain('Earlier-turn provider approval observed');
  expect(facts).not.toContain('Recorded separately: Provider tool approval observed');
  expect(facts).toContain('Failed delivery · native Send unresolved');
  expect(facts).toContain('Saved input awaiting native Send');
  expect(facts).toContain('Streaming text recorded on this turn');
  expect(facts).toContain('Review the existing Delivery queue');
  expect(pane.textContent).not.toContain(failure.text);
  expect(pane.textContent).not.toContain(follower.text);
  const review = pane.querySelector<HTMLButtonElement>('[data-work-action="delivery"]')!;
  expect(review).toBeTruthy(); review.focus(); review.click();
  expect(app.w.document.activeElement)
    .toBe(app.w.document.querySelector('#deliveryQueuePanel summary'));
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it.each(['waiting', 'answered'] as const)(
  'retains a new %s approval after a same-provider turn starts without reviving the older observed card',
  async (state) => {
    const row: SessionSummary = { ...summary([]), id: 'current-provider-approval-' + state,
      conversationId: 'reused-provider', chatIds: ['reused-provider'], title: 'Current B approval',
      activeTurnId: 'approval-turn-B', fileEdits: 1, lastFileChangeAt: T0 + 5_000 };
    const events: SessionEvent[] = [
      { kind: 'progress', seq: 1, time: T0 + 1_000, source: 'app',
        progressId: 'approval-wait:reused-provider:A', message: text(APPROVAL_WAITING_TEXT) },
      { kind: 'turn_start', seq: 2, time: T0 + 3_000, source: 'extension', turnId: 'approval-turn-B' },
      { kind: 'progress', seq: 3, time: T0 + 4_000, source: 'app',
        progressId: 'approval-wait:reused-provider:B',
        message: text(state === 'waiting' ? APPROVAL_WAITING_TEXT : APPROVAL_ANSWERED_TEXT) }
    ];
    const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events },
      controls: { conversationId: row.conversationId, activeTurnId: 'approval-turn-B' } });
    app.w.document.querySelector<HTMLButtonElement>(
      `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
    await settle();
    const pane = app.w.document.getElementById('workOverviewPane')!;
    const facts = [...pane.querySelectorAll('.work-overview-pane-field')]
      .find(el => el.querySelector('b')?.textContent === 'Status & next action')?.textContent ?? '';
    expect(facts).toContain(state === 'waiting'
      ? 'Provider tool approval observed' : 'Provider tool approval answered');
    expect(facts).toContain('current native turn association is unverified');
    expect(facts).not.toContain('Earlier-turn provider approval');
    expect(app.live.sent).toEqual([]);
  }
);

it.each([
  { label: 'Unconfirmed pre-Send failure', phase: 'pre_send_preparation' as const,
    authorized: undefined, offered: undefined, nativeMessage: undefined, delivered: undefined },
  { label: 'Failed tool handout · native Send unverified', phase: 'receipt_missing' as const,
    authorized: undefined, offered: T0 + 800, nativeMessage: undefined, delivered: undefined },
  { label: 'Native Send recorded · delivery later failed', phase: 'provider_recovery_unknown' as const,
    authorized: T0 + 800, offered: undefined, nativeMessage: 'exact-native-outbox-message', delivered: T0 + 900 }
])('shows $label in Work without implying a new Send or showing a held historical provider failure', async item => {
  const row: SessionSummary = { ...summary([]), id: 'failed-input-' + item.phase,
    title: 'Real failure kept in saved Work', conversationId: 'current-provider',
    chatIds: ['previous-provider', 'current-provider'], fileEdits: 1, lastFileChangeAt: T0 + 2_000 };
  const failure = { id: 'failed-input', sessionId: row.id, conversationId: row.conversationId,
    state: 'failed', owner: null, text: 'PRIVATE original text', mode: 'auto',
    createdAt: T0, dueAt: T0, model: null, reasoningEffort: null,
    sendAuthorizedAt: item.authorized, offeredAt: item.offered,
    messageId: item.nativeMessage, deliveredAt: item.delivered,
    recoveryFailure: { phase: item.phase, retrySafe: false, detail: 'Unverified state' } } as InputEntry;
  const old = { ...failure, id: 'previous-provider-failure', conversationId: 'previous-provider',
    text: 'PRIVATE older provider text', sendAuthorizedAt: T0 + 100,
    messageId: undefined, deliveredAt: undefined } as InputEntry;
  const app = await boot([], true, [], [], { sessions: [row], inputs: [old, failure] });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const facts = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(el => el.querySelector('b')?.textContent === 'Status & next action')?.textContent ?? '';
  expect(facts).toContain(item.label);
  expect(facts).toContain('Review the existing Delivery queue');
  expect(facts).not.toContain('Native Send receipt unresolved after failure from previous-provider');
  expect(pane.textContent).not.toContain(failure.text);
  expect(pane.textContent).not.toContain(old.text);
  // Terminal notices without a recorded error need not occupy the global
  // three-notice queue. Work still describes the durable failed receipt,
  // without advertising a Review action when that queue is hidden.
  expect(pane.querySelector('[data-work-action="delivery"]')).toBeNull();
  expect(pane.querySelector('[data-work-action="open"]')).not.toBeNull();
  expect(app.live.sent).toEqual([]);
});

it('does not project stale outbox custody as current Work after a failed queue read, and restores exact facts on recovery', async () => {
  const row: SessionSummary = { ...summary([]), id: 'work-queue-read-recovery',
    title: 'Retained output during outbox outage', conversationId: 'queue-outage-provider',
    chatIds: ['queue-outage-provider'], fileEdits: 1, lastFileChangeAt: T0 + 10_000,
    lastAssistantFinalAt: T0 + 9000 };
  const recorded: SessionEvent = { kind: 'assistant_message', seq: 1, source: 'extension',
    time: T0 + 9000, messageId: 'last-confirmed-final', final: true,
    message: text('Saved and recorded result must remain inspectable through the queue outage.') };
  const saved: InputEntry = { id: 'queued-existing', sessionId: row.id,
    conversationId: row.conversationId, mode: 'after-turn',
    state: 'queued', owner: null, text: 'PRIVATE unsent input', createdAt: T0 + 5000,
    dueAt: T0, model: null, reasoningEffort: null };
  const app = await boot([], true, [], [], { sessions: [row],
    sessionEvents: { [row.id]: [recorded] }, inputs: [saved] });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const facts = () => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(el => el.querySelector('b')?.textContent === 'Status & next action')?.textContent ?? '';
  expect(facts()).toContain('Saved input awaiting native Send');
  const lastResult = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  lastResult.open = true;
  const original = (app.w as any).api.listInputs;
  (app.w as any).api.listInputs = () => Promise.resolve({ ok: false, error: 'Current queue read unavailable' });
  pane.querySelector<HTMLButtonElement>('[data-work-action="close"]')!.focus();
  app.notifySession(); await settle(850);
  expect(facts()).toContain('Latest delivery queue read unavailable');
  expect(facts()).not.toContain('Saved input awaiting native Send');
  expect(app.w.document.getElementById('workOverviewMeta')?.textContent)
    .toContain('delivery status unknown');
  expect(app.w.document.getElementById('workOverviewMeta')?.textContent)
    .not.toContain('1 queued');
  expect(pane.querySelector('.work-overview-result')).toBe(lastResult);
  expect(lastResult.open).toBe(true);
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Saved and recorded result');
  expect(pane.textContent).not.toContain(saved.text);
  expect(app.w.document.activeElement?.getAttribute('data-work-action')).toBe('close');
  (app.w as any).api.listInputs = original;
  app.notifySession(); await settle(850);
  expect(facts()).not.toContain('Latest delivery queue read unavailable');
  expect(facts()).toContain('Saved input awaiting native Send');
  expect(app.w.document.getElementById('workOverviewMeta')?.textContent)
    .toContain('1 queued');
  expect(lastResult.open).toBe(true);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('retains paused and blocked Goal/Loop rows in Work & updates without calling them working', async () => {
  const paused = { ...summary([]), id: '2026-10-08-paused-work', conversationId: 'paused-work',
    title: 'Paused Loop review', activityExpiresAt: Date.now() + 60_000 };
  const blocked = { ...summary([]), id: '2026-10-08-blocked-work', conversationId: 'blocked-work',
    title: 'Provider sign-in needed', activityExpiresAt: Date.now() + 60_000 };
  const working = { ...summary([]), id: '2026-10-08-running-work', conversationId: 'running-work',
    title: 'Live Loop review' };
  const projection = (row: ReturnType<typeof summary>, state: 'paused' | 'blocked' | 'working', nextAction: string) => ({
    sessionId: row.id, conversationId: row.conversationId!, title: row.title, mode: 'loop' as const,
    state, reason: state === 'paused' ? 'Pause is active; finishing one worker.' :
      state === 'blocked' ? 'Provider sign-in is required.' : 'Local tool is active.',
    nextAction, nextRetryAt: null, lastWorkedAt: T0, activeWorkers: 0,
    recoverable: false, spinning: false, recoveryStage: null
  });
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0, targetLanes: 1,
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 1, blocked: 1 },
    chats: [projection(paused, 'paused', 'Wait for the active worker.'),
      projection(blocked, 'blocked', 'Sign in using the existing account.'),
      projection(working, 'working', 'Inspect latest result.')]
  };
  const { w, append } = await boot([], true, [], [], { sessions: [paused, blocked, working], automation,
    // The selected Goal/Loop is still enabled in this scenario; the generic test
    // harness defaults exact controls to Off for otherwise ordinary chats.
    controls: { automation: 'loop' } });
  const current = w.document.querySelector('.work-overview-section')!;
  const rows = [...current.querySelectorAll<HTMLButtonElement>('.work-overview-row')];
  expect(rows).toHaveLength(3);
  expect(rows.map(row => row.dataset.sessionId).sort()).toEqual([paused.id, blocked.id, working.id].sort());
  expect(rows.find(row => row.dataset.sessionId === paused.id)?.textContent).toContain('paused');
  expect(rows.find(row => row.dataset.sessionId === blocked.id)?.textContent).toContain('blocked');
  expect(rows.find(row => row.dataset.sessionId === blocked.id)?.textContent).toContain('Sign in using the existing account.');
  expect(rows.find(row => row.dataset.sessionId === paused.id)?.querySelector('.work-overview-state.is-paused')).not.toBeNull();
  expect(rows.find(row => row.dataset.sessionId === blocked.id)?.querySelector('.work-overview-state.is-failed')).not.toBeNull();
  const meta = w.document.getElementById('workOverviewMeta')!.textContent ?? '';
  expect(meta).toContain('1 working');
  expect(meta).toContain('1 paused');
  expect(meta).toContain('1 blocked');
  // Recent activity is retained as evidence, but a provider hold or deliberate pause
  // must still win in the sidebar's accessible explanation and hover text.
  const pausedSidebar = w.document.querySelector<HTMLElement>(`#sessionList [data-id="${paused.id}"]`)!;
  const blockedSidebar = w.document.querySelector<HTMLElement>(`#sessionList [data-id="${blocked.id}"]`)!;
  expect(pausedSidebar.title).toContain('Paused — Pause is active; finishing one worker.');
  expect(blockedSidebar.title).toContain('Needs attention — Provider sign-in is required.');
  expect(pausedSidebar.title).not.toContain('Working signal detected');
  expect(blockedSidebar.title).not.toContain('Working signal detected');
  rows.find(row => row.dataset.sessionId === blocked.id)!.click();
  await settle();
  expect(w.document.getElementById('workOverviewPane')!.textContent).toContain('Sign in using the existing account.');

  // A later real supervisor transition must replace the blocked state in place.
  automation.chats[1] = projection(blocked, 'working', 'Provider access was restored.');
  automation.counts.blocked = 0;
  automation.counts.working = 2;
  await append([]);
  const recovered = [...current.querySelectorAll<HTMLButtonElement>('.work-overview-row')]
    .filter(row => row.dataset.sessionId === blocked.id);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]!.textContent).toContain('working');
  expect(recovered[0]!.textContent).toContain('Provider access was restored.');
  expect(w.document.getElementById('workOverviewMeta')!.textContent).toContain('2 working');
  expect(w.document.getElementById('workOverviewMeta')!.textContent).not.toContain('blocked');
  expect(w.document.getElementById('workOverviewPane')!.textContent).toContain('Provider access was restored.');
});

it('explains a waiting Chrome page and retained Core evidence without calling the Loop working', async () => {
  const lastToolAt = Date.now() - 2_000;
  const row = { ...summary([]), id: 'chrome-interrupted-core-continues', title: 'Storyboard interrupted page',
    conversationId: 'storyboard-chat', chatIds: ['storyboard-chat'],
    lastToolCallAt: lastToolAt, activityExpiresAt: Date.now() + 60_000 };
  const tool = { ...toolCall(1, 'continued-core'), time: lastToolAt };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: Date.now(), targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 1, stalled: 0, paused: 0, blocked: 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title, mode: 'loop',
      state: 'recovering', reason: 'ChatGPT page is interrupted while Core calls remain recorded.',
      nextAction: 'Wait for the existing Chrome recovery owner; do not replay the message.',
      nextRetryAt: null, lastWorkedAt: lastToolAt, activeWorkers: 0,
      recoverable: false, spinning: false, recoveryStage: 'waiting-browser' }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation,
    controls: { automation: 'loop' }, sessionEvents: { [row.id]: [tool] } });
  const sidebar = app.w.document.querySelector<HTMLElement>(`#sessionList [data-id="${row.id}"]`)!;
  expect(sidebar.title).toContain('Waiting for Chrome — ChatGPT page is interrupted');
  expect(sidebar.title).not.toContain('Repairing Chrome');
  expect(sidebar.title).not.toContain('Working signal detected');
  const current = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] .work-overview-row[data-session-id="${row.id}"]`)!;
  expect(current.textContent).toContain('waiting for Chrome');
  current.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Current status');
  expect(pane.textContent).toContain('ChatGPT page is interrupted while Core calls remain recorded.');
  expect(pane.textContent).toContain('Wait for the existing Chrome recovery owner; do not replay the message.');
  expect(pane.textContent).toContain('Last exact local tool');
  expect(pane.textContent).toContain('does not prove current execution');
  expect(pane.textContent).not.toContain('Working signal detected');
});

it('shows an account-wide pause and the exact recorded Model not found error without reviving old Goal work', async () => {
  const now = Date.now();
  const root = { ...summary([]), id: 'pause-provider-goal', conversationId: 'held-original-goal',
    chatIds: ['held-original-goal'], title: 'Goal with an uncollected helper answer',
    lastAssistantFinalAt: T0 + 1_000, lastToolCallAt: now - 2_000,
    lastTurnEndAt: now - 500, lastTurnOutcome: 'failed' as const,
    activityExpiresAt: now + 60_000, activeTurnId: null };
  const restricted = { ...summary([]), id: 'pause-provider-blocked', conversationId: 'held-provider-blocked',
    chatIds: ['held-provider-blocked'], title: 'Other provider-held task' };
  const saved: SessionEvent = { kind: 'assistant_message', seq: 1, time: T0 + 1_000,
    source: 'extension', turnId: 'prior-accepted', messageId: 'prior-useful-output', final: true,
    message: text('Prior useful work is still available; no Goal completion was verified.') };
  const recent = { ...toolCall(2, 'recent-core-before-model-hold'), time: now - 2_000 };
  const error: SessionEvent = { kind: 'chat_error', seq: 3, time: now - 1_000,
    source: 'extension', turnId: 'model-failed', blocking: true, recoverable: false,
    message: text('Model not found') };
  const projection = (row: SessionSummary, state: 'working' | 'blocked', reason: string) => ({
    sessionId: row.id, conversationId: row.conversationId!, title: row.title, mode: 'goal' as const,
    state, reason, nextAction: state === 'blocked' ? 'Wait for the account owner.' : 'Observe previous work.',
    nextRetryAt: null, lastWorkedAt: now - 2_000, activeWorkers: 0,
    recoverable: false, spinning: false, recoveryStage: null
  });
  // The supervisor is an older Working snapshot. Current config is the account-wide
  // pause authority; a recent tool and old native delivery cannot override it.
  const supervisor: AutomationSupervisorSnapshot = { observedAt: now - 2_000, targetLanes: 2,
    counts: { working: 1, blocked: 1, paused: 0, recovering: 0,
      stalled: 0, 'waiting-main': 0, 'waiting-workers': 0 },
    chats: [projection(root, 'working', 'Last observed tool work.'),
      projection(restricted, 'blocked', 'Provider sign-in required.')] };
  const app = await boot([], true, [], [], { automationPaused: true, automation: supervisor,
    sessions: [root, restricted], sessionEvents: { [root.id]: [saved, recent, error] } });
  const doc = app.w.document;
  const current = doc.querySelector<HTMLElement>('.work-overview-section[data-work-section="current"]')!;
  const rootRow = current.querySelector<HTMLButtonElement>(`[data-session-id="${root.id}"]`)!;
  const restrictedRow = current.querySelector<HTMLButtonElement>(`[data-session-id="${restricted.id}"]`)!;
  expect(rootRow.textContent).toContain('paused');
  expect(rootRow.textContent).not.toContain('working');
  expect(restrictedRow.textContent).toContain('blocked');
  expect(doc.getElementById('workOverviewMeta')!.textContent).toContain('1 paused');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('working');
  expect(doc.getElementById('automationSupervisorSummary')!.textContent).not.toContain('working');
  const sidebar = doc.querySelector<HTMLElement>(`#sessionList [data-id="${root.id}"]`)!;
  expect(sidebar.title).toContain('Paused');
  expect(sidebar.title).not.toContain('Working signal detected');
  expect(sidebar.querySelector('.session-status.is-working')).toBeNull();

  rootRow.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Current status');
  expect(pane.textContent).toContain('paused');
  expect(pane.textContent).toContain('Model not found');
  expect(pane.textContent).toContain('recorded provider error');
  expect(pane.textContent).toContain('does not prove current execution');
  const disclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  expect(disclosure.textContent).toContain('Prior useful work is still available');
  disclosure.open = true;
  disclosure.querySelector('summary')!.focus();
  app.notifySession();
  await settle(700);
  expect(pane.querySelector('.work-overview-result')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(doc.activeElement).toBe(disclosure.querySelector('summary'));
  (doc.getElementById('progressToggle') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelector('.progress-state')?.textContent).toBe('paused');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('refreshes Progress for a rebound provider when an older in-flight history read finally settles', async () => {
  const previous: SessionEvent = { kind: 'user_message', seq: 1, time: T0,
    source: 'extension', messageId: 'provider-A-reminder',
    message: text('Reminder: Provider A status is historical.') };
  const source: SessionEvent[] = [previous];
  const owner: SessionSummary = { ...summary(source), id: 'pending-progress-binding',
    conversationId: 'provider-A', chatIds: ['provider-A'], title: 'Retained task scope' };
  const app = await boot(source, true, [], [], { sessions: [owner], sessionEvents: { [owner.id]: source } });
  const api = (app.w as any).api;
  const originalGetSession = api.getSession;
  let releaseOlder: ((reply: object) => void) | undefined;
  let holdFirstTail = true;
  api.getSession = (id: string, query?: { from?: number; before?: number; limit?: number }) => {
    if (id === owner.id && query?.from === undefined && query?.before === undefined && holdFirstTail) {
      holdFirstTail = false;
      return new Promise(resolve => { releaseOlder = resolve; });
    }
    return originalGetSession(id, query);
  };
  (app.w.document.getElementById('progressToggle') as HTMLButtonElement).click();
  await settle();
  expect(releaseOlder).toBeDefined();
  const successor: SessionSummary = { ...owner, conversationId: 'provider-B',
    chatIds: ['provider-A', 'provider-B'], updatedAt: T0 + 5_000 };
  source.push({ kind: 'user_message', seq: 2, time: T0 + 5_000,
    source: 'extension', messageId: 'provider-B-reminder',
    message: text('Reminder: Provider B is current after rebind.') });
  await app.replaceSessions([successor]);
  const inbox = app.w.document.getElementById('progressInbox')!;
  expect(inbox.textContent).not.toContain('Provider B is current after rebind.');
  releaseOlder!({ ok: true, data: { summary: owner, events: [previous], total: 1, nextFrom: 2 } });
  await settle(700);
  expect(inbox.textContent).toContain('Reminder: Provider B is current after rebind.');
  expect(inbox.textContent).not.toContain('Recorded history boundary');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('retains an independently proved draining main turn and explicit provider block during an account pause', async () => {
  const now = Date.now();
  const draining = { ...summary([]), id: 'paused-exact-draining', title: 'Current main turn is finishing',
    conversationId: 'draining-chat', chatIds: ['draining-chat'] };
  const held = { ...summary([]), id: 'paused-explicit-model-hold', title: 'Explicit provider hold',
    conversationId: 'blocked-model-chat', chatIds: ['blocked-model-chat'] };
  const projection = (row: SessionSummary, state: 'working' | 'blocked', reason: string) => ({
    sessionId: row.id, conversationId: row.conversationId!, title: row.title, mode: 'loop' as const,
    state, reason, nextAction: state === 'blocked' ? 'Leave the provider hold intact.' : 'Let the existing turn finish.',
    nextRetryAt: null, lastWorkedAt: now, activeWorkers: 0, recoverable: false,
    spinning: state === 'working', recoveryStage: null,
    pause: { phase: 'draining' as const, remaining: 1, mainTurn: state === 'working',
      runningTools: 0, activeWorkers: 0, handoff: false, browserAction: false }
  });
  const supervisor: AutomationSupervisorSnapshot = { observedAt: now, targetLanes: 2,
    counts: { working: 1, blocked: 1, paused: 0, recovering: 0,
      stalled: 0, 'waiting-main': 0, 'waiting-workers': 0 },
    chats: [projection(draining, 'working', 'One exact main turn is already finishing while paused.'),
      projection(held, 'blocked', 'Model not found is a provider hold.')] };
  const app = await boot([], true, [], [], { automationPaused: true, automation: supervisor,
    sessions: [draining, held] });
  const doc = app.w.document;
  const current = doc.querySelector<HTMLElement>('.work-overview-section[data-work-section="current"]')!;
  expect(current.querySelector(`[data-session-id="${draining.id}"]`)?.textContent).toContain('pausing');
  expect(current.querySelector(`[data-session-id="${held.id}"]`)?.textContent).toContain('blocked');
  expect(current.querySelector(`[data-session-id="${held.id}"]`)?.textContent).not.toContain('pausing');
  expect(doc.getElementById('workOverviewMeta')!.textContent).toContain('1 working');
  expect(doc.getElementById('workOverviewMeta')!.textContent).toContain('1 blocked');
  expect(doc.querySelector<HTMLElement>(`#sessionList [data-id="${draining.id}"]`)!.title)
    .toContain('One exact main turn is already finishing');
});

it('marks a retained provider error as historical after a distinct later recorded successful turn', async () => {
  const now = Date.now();
  const row = { ...summary([]), id: 'historical-provider-error', title: 'Later result was recorded',
    conversationId: 'provider-recovered-chat', chatIds: ['provider-recovered-chat'],
    fileEdits: 1, lastFileChangeAt: now - 500,
    lastAssistantFinalAt: now - 300, lastTurnEndAt: now - 200,
    lastTurnOutcome: 'completed' as const, activeTurnId: null };
  const oldError: SessionEvent = { kind: 'chat_error', seq: 1, time: now - 4_000,
    turnId: 'failed-before-recovery', source: 'extension', blocking: true,
    message: text('Model not found') };
  const events: SessionEvent[] = [oldError,
    { kind: 'turn_start', seq: 2, time: now - 2_000, source: 'extension', turnId: 'actual-new-turn' },
    { kind: 'assistant_message', seq: 3, time: now - 300, source: 'extension',
      turnId: 'actual-new-turn', messageId: 'new-saved-result', final: true,
      message: text('Newer source result was recorded; original task acceptance still requires verification.') },
    { kind: 'turn_end', seq: 4, time: now - 200, source: 'extension',
      turnId: 'actual-new-turn', outcome: 'completed' }];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events } });
  app.w.document.querySelector<HTMLButtonElement>(`.work-overview-row[data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const provider = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Provider evidence')!;
  expect(provider.textContent).toContain('Earlier recorded provider error: Model not found');
  expect(provider.textContent).toContain('does not prove a current provider restriction');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Newer source result was recorded');
  expect(pane.textContent).not.toContain('Last turn failed');
});

it.each([
  ['failed', 'failed with a visible error'],
  ['interrupted', 'interrupted before it finished'],
  ['stopped', 'stopped by the user'],
  ['unknown', 'ended for an unknown reason']
] as const)('shows a recently ended ordinary %s turn as attention instead of continuing work', async (outcome, description) => {
  const endedAt = Date.now() - 1_000;
  const row = { ...summary([]), id: 'ordinary-terminal-evidence', conversationId: 'ordinary-terminal-provider',
    chatIds: ['ordinary-terminal-provider'], title: 'Ordinary result review',
    lastToolCallAt: endedAt - 1_000, lastTurnEndAt: endedAt, lastTurnOutcome: outcome,
    activityExpiresAt: Date.now() + 60_000, activeTurnId: null };
  const source: SessionEvent[] = [
    { ...toolCall(1, 'pre-terminal-tool'), time: endedAt - 1_000 },
    { kind: 'turn_end', seq: 2, source: 'extension', time: endedAt, turnId: 'ended-ordinary-turn', outcome }
  ];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: source } });
  const sidebar = app.w.document.querySelector<HTMLElement>(`#sessionList [data-id="${row.id}"]`)!;
  expect(sidebar.title).toContain(description);
  expect(sidebar.title).not.toContain('Working signal detected');
  expect(sidebar.querySelector('.session-status.is-working')).toBeNull();
  const current = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] .work-overview-row[data-session-id="${row.id}"]`)!;
  expect(current.textContent).toContain(outcome);
  expect(current.textContent).not.toContain('working');
  current.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain(`Last turn ${description}`);
  expect(pane.textContent).not.toContain('current execution is active');
  (app.w.document.getElementById('progressToggle') as HTMLButtonElement).click();
  await settle();
  expect(app.w.document.querySelector('.progress-state')?.textContent).toBe(outcome);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('does not show a completed ordinary turn as working just because its activity deadline remains fresh', async () => {
  const endedAt = Date.now() - 1_000;
  const row: SessionSummary = { ...summary([]), id: 'ordinary-completed-stale-activity', title: 'Completed ordinary work',
    conversationId: 'ordinary-completed-native', chatIds: ['ordinary-completed-native'],
    lastToolCallAt: endedAt - 2_000, lastAssistantFinalAt: endedAt - 500,
    lastTurnEndAt: endedAt, lastTurnOutcome: 'completed' as const,
    activityExpiresAt: Date.now() + 60_000, activeTurnId: null };
  const events: SessionEvent[] = [
    { kind: 'assistant_message', source: 'extension', seq: 1, time: endedAt - 500,
      messageId: 'completed-ordinary-answer', final: true, message: text('Task result saved.') },
    { kind: 'turn_end', source: 'extension', seq: 2, time: endedAt,
      turnId: 'completed-ordinary-turn', outcome: 'completed' }
  ];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events } });
  const doc = app.w.document;
  expect(doc.querySelector(`.work-overview-section[data-work-section="current"] [data-session-id="${row.id}"]`)).toBeNull();
  const update = doc.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!;
  expect(update).not.toBeNull();
  expect(update.textContent).toContain('Final answer recorded');
  expect(doc.getElementById('workOverviewMeta')?.textContent).not.toContain('working');
  update.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const status = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Current status')!.textContent ?? '';
  expect(status).toContain('Idle; no current work signal recorded');
  expect(pane.textContent).toContain('Task result saved.');
  // A later genuinely opened turn supersedes the older completion boundary.
  row.activeTurnId = 'new-open-turn';
  app.notifySession();
  await settle();
  expect(doc.querySelector(`.work-overview-section[data-work-section="current"] [data-session-id="${row.id}"]`)).not.toBeNull();
  expect(app.live.sent).toEqual([]);
});

it('keeps a silent open ordinary turn inspectable, then follows recent activity and the exact terminal boundary', async () => {
  const now = Date.now();
  const row: SessionSummary = {
    ...summary([]), id: 'ordinary-silent-open-turn', title: 'Unverified open native turn',
    conversationId: 'ordinary-silent-provider', chatIds: ['ordinary-silent-provider'],
    activeTurnId: 'silent-exact-turn', lastTurnOutcome: null,
    lastToolCallAt: now - 10 * 60_000, activityExpiresAt: null
  };
  const app = await boot([], true, [], [], { sessions: [row] });
  const doc = app.w.document;
  const currentRow = () => doc.querySelector<HTMLButtonElement>(
    `[data-work-section="current"] [data-session-id="${row.id}"]`);
  const meta = doc.getElementById('workOverviewMeta')!;
  expect(currentRow()).not.toBeNull();
  expect(currentRow()?.querySelector('.work-overview-state.is-unknown')?.textContent).toBe('turn open · evidence stale');
  expect(meta.textContent).toContain('1 unverified open turn');
  expect(meta.textContent).not.toContain('working');
  currentRow()!.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const status = () => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Current status')?.textContent ?? '';
  expect(status()).toContain('no recent work signal');
  expect(pane.textContent).toContain('Inspect the exact provider turn');
  const close = pane.querySelector<HTMLButtonElement>('[data-work-action="close"]')!;
  close.focus();

  await app.replaceSessions([{ ...row, lastToolCallAt: now - 100, activityExpiresAt: now + 60_000,
    updatedAt: row.updatedAt + 1 }]);
  expect(currentRow()?.querySelector('.work-overview-state')?.textContent).toBe('turn open');
  expect(meta.textContent).toContain('1 recent signal');
  expect(meta.textContent).not.toContain('unverified open turn');
  expect(doc.activeElement).toBe(close);

  await app.replaceSessions([{ ...row, activeTurnId: null, lastTurnOutcome: 'failed',
    lastTurnEndAt: now - 1000, activityExpiresAt: null, updatedAt: row.updatedAt + 2 }]);
  expect(currentRow()?.querySelector('.work-overview-state.is-failed')?.textContent).toBe('failed');
  expect(pane.textContent).toContain('Last turn failed');

  await app.replaceSessions([{ ...row, activeTurnId: null, lastTurnOutcome: 'failed',
    lastTurnEndAt: now - 10 * 60_000, activityExpiresAt: null, updatedAt: row.updatedAt + 3 }]);
  expect(currentRow()).toBeNull();
  const older = doc.querySelector<HTMLButtonElement>(
    `[data-work-section="older"] [data-session-id="${row.id}"]`);
  expect(older?.querySelector('.work-overview-state.is-failed')?.textContent).toBe('last failed');
  expect(older?.textContent).toContain('historical');
  expect(doc.getElementById('workOverviewMeta')!.textContent).toContain('1 earlier outcome');
  expect(pane.hidden).toBe(false);
  expect(pane.textContent).toContain('Last turn failed');
  const justDid = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid).toContain('Last recorded turn failed');
  expect(justDid).not.toContain('Latest exact tool call recorded');
  expect(pane.querySelector('[data-work-action="close"]')).toBe(close);
  expect(doc.activeElement).toBe(close);

  await app.replaceSessions([{ ...row, activeTurnId: 'new-exact-return-turn', lastTurnOutcome: 'failed',
    lastTurnEndAt: now - 10 * 60_000, activityExpiresAt: null,
    updatedAt: row.updatedAt + 4 }]);
  expect(doc.querySelector(`[data-work-section="older"] [data-session-id="${row.id}"]`)).toBeNull();
  expect(currentRow()?.querySelector('.work-overview-state.is-unknown')?.textContent)
    .toBe('turn open · evidence stale');
  expect(doc.activeElement).toBe(close);
  expect(pane.hidden).toBe(false);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('bounds older ordinary failure and unknown outcomes without concealing the other loaded-session count', async () => {
  const now = Date.now();
  const base = summary([]);
  const results = (['failed', 'unknown', 'stalled', 'interrupted', 'stopped'] as const).map((outcome, index) => ({
    ...base, id: `older-outcome-${index}`, title: `Historical ${outcome}`,
    conversationId: `older-conversation-${index}`, chatIds: [`older-conversation-${index}`],
    activeTurnId: null, lastTurnOutcome: outcome, lastTurnEndAt: now - (index + 4) * 60_000,
    activityExpiresAt: null, lastToolCallAt: now - (index + 5) * 60_000
  }));
  const locallyBlocked = { ...results[3]!, id: 'older-locally-blocked',
    conversationId: 'older-locally-blocked-provider', chatIds: ['older-locally-blocked-provider'] };
  const automation = {
    ...results[0]!, id: 'older-supervised-failure',
    conversationId: 'older-supervised-provider', chatIds: ['older-supervised-provider']
  };
  const supervisor: AutomationSupervisorSnapshot = { observedAt: now, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0,
      stalled: 0, paused: 0, blocked: 1 },
    chats: [{ sessionId: automation.id, conversationId: automation.conversationId!, title: automation.title,
      mode: 'loop', state: 'blocked', reason: 'Provider hold retained.',
      nextAction: 'Review exact held chat.', nextRetryAt: null, lastWorkedAt: now,
      activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [...results, locallyBlocked, automation],
    blocked: [locallyBlocked.conversationId!], automation: supervisor });
  const doc = app.w.document;
  const earlier = doc.querySelector<HTMLElement>('[data-work-section="older"]')!;
  const rows = [...earlier.querySelectorAll<HTMLButtonElement>('.work-overview-row')];
  expect(rows).toHaveLength(3);
  expect(rows.map(row => row.dataset.sessionId)).toEqual(results.slice(0, 3).map(row => row.id));
  expect(rows[1]!.querySelector('.work-overview-state.is-unknown')?.textContent).toBe('last unknown');
  expect(earlier.textContent).toContain('1 more recorded outcome in loaded sessions');
  expect(doc.getElementById('workOverviewMeta')!.textContent).toContain('4 earlier outcomes (3 shown)');
  expect(doc.querySelector(`[data-work-section="older"] [data-session-id="${results[4]!.id}"]`)).toBeNull();
  expect(doc.querySelector(`[data-work-section="older"] [data-session-id="${locallyBlocked.id}"]`)).toBeNull();
  expect(doc.querySelector(`[data-work-section="older"] [data-session-id="${automation.id}"]`)).toBeNull();
  expect(doc.querySelector(`[data-work-section="current"] [data-session-id="${locallyBlocked.id}"]`)).not.toBeNull();
  expect(doc.querySelector(`[data-work-section="current"] [data-session-id="${automation.id}"]`)).not.toBeNull();

  await app.replaceSessions([...results.slice(1), locallyBlocked, automation,
    { ...results[0]!, lastTurnOutcome: 'completed', lastAssistantFinalAt: now - 50,
      lastTurnEndAt: now - 25 }]);
  expect(doc.querySelector(`[data-work-section="older"] [data-session-id="${results[0]!.id}"]`)).toBeNull();
  expect(doc.querySelector(`[data-work-section="updates"] [data-session-id="${results[0]!.id}"]`)).not.toBeNull();
  expect(doc.getElementById('workOverviewMeta')!.textContent).toContain('3 earlier outcomes');
  expect(app.live.sent).toEqual([]);
});

it('announces only short exact Work status and Prime receipt changes while retaining long worker results', async () => {
  const prime = { ...summary([]), id: 'accessible-prime' };
  const worker = { ...summary([]), id: 'accessible-worker', conversationId: 'accessible-worker-chat',
    chatIds: ['accessible-worker-chat'], title: 'Worker result with a very long descriptive title '.repeat(5),
    origin: { kind: 'worker' as const, fromSessionId: prime.id, agentId: 'worker-1', task: 'Audit status' },
    lastFinishReportAt: T0 + 45_000, lastToolCallAt: T0 + 20_000 };
  const report: SessionEvent = { kind: 'agent_message', seq: 2, time: T0 + 45_000,
    source: 'app', agent: 'worker-1', messageId: 'accessible-report', from: 'worker-1', to: 'prime', delivery: 'sent',
    message: text(`[worker-1 finished] RESULT: ${'Recorded meaningful worker proof. '.repeat(180)}`) };
  const primeEvents: SessionEvent[] = [];
  const app = await boot([], true, [], [], { sessions: [prime, worker],
    sessionEvents: { [worker.id]: [report], [prime.id]: primeEvents } });
  const row = app.w.document.querySelector<HTMLButtonElement>(
    '.work-overview-row[data-session-id="accessible-worker"]')!;
  row.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const body = app.w.document.getElementById('workOverviewBody')!;
  const announce = app.w.document.getElementById('workOverviewAnnouncement')!;
  expect(pane.getAttribute('role')).toBe('region');
  expect(pane.getAttribute('aria-labelledby')).toBe('workOverviewPaneTitle');
  expect(pane.getAttribute('aria-live')).toBe('off');
  expect(body.getAttribute('aria-live')).toBe('off');
  expect(announce.getAttribute('aria-live')).toBe('polite');
  expect(announce.getAttribute('aria-atomic')).toBe('true');
  expect(announce.textContent).toContain('Worker report saved');
  expect(announce.textContent).toContain('Prime receipt unverified');
  expect(announce.textContent!.length).toBeLessThan(260);
  expect(pane.querySelector('.work-overview-result-body')?.textContent?.length).toBeGreaterThan(4000);
  const originalAnnounce = announce.textContent;
  app.notifySession();
  await settle(700);
  expect(announce.textContent).toBe(originalAnnounce);
  primeEvents.push({ ...report, seq: 3, time: T0 + 50_000, source: 'app', agent: 'prime', delivery: 'delivered' });
  app.notifySession();
  await settle(700);
  expect(announce.textContent).toContain('Prime receipt confirmed');
  expect(announce.textContent).not.toContain('Recorded meaningful worker proof');
  expect(pane.textContent).toContain('Prime received this report');
  expect(app.live.sent).toEqual([]);
});

it('keeps waiting-worker and between-turn supervisor phases visible instead of calling Work & updates quiet', async () => {
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0, targetLanes: 2,
    counts: { working: 0, 'waiting-workers': 1, 'waiting-main': 1, recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [
      { sessionId: 'waiting-worker-session', conversationId: 'waiting-worker-chat', title: 'Prime waiting for worker',
        mode: 'loop', state: 'waiting-workers', reason: 'Exact worker has not finished.',
        nextAction: 'Collect the recorded worker report.', nextRetryAt: null, lastWorkedAt: T0,
        activeWorkers: 1, recoverable: false, spinning: false, recoveryStage: null },
      { sessionId: 'waiting-main-session', conversationId: 'waiting-main-chat', title: 'Prime between turns',
        mode: 'goal', state: 'waiting-main', reason: 'Workers completed; main chat not yet running.',
        nextAction: 'Wait for the confirmed main turn.', nextRetryAt: null, lastWorkedAt: T0,
        activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }
    ]
  };
  const { w, append } = await boot([], true, [], [], { automation });
  const meta = w.document.getElementById('workOverviewMeta')!;
  expect(meta.textContent).toContain('1 waiting workers');
  expect(meta.textContent).toContain('1 between turns');
  expect(meta.textContent).not.toContain('quiet');
  expect(meta.textContent).not.toContain('working');
  const currentRows = [...w.document.querySelectorAll<HTMLButtonElement>('.work-overview-section[data-work-section="current"] .work-overview-row')];
  expect(currentRows).toHaveLength(2);
  expect(currentRows.map(row => row.textContent)).toEqual(expect.arrayContaining([
    expect.stringContaining('waiting workers'), expect.stringContaining('between turns')
  ]));

  automation.chats[0]!.state = 'blocked';
  automation.chats[0]!.reason = 'Provider sign-in required.';
  automation.chats[0]!.nextAction = 'Use the existing login page.';
  automation.chats[1]!.state = 'paused';
  automation.chats[1]!.reason = 'Automation is paused.';
  automation.chats[1]!.nextAction = 'Wait for manual resume.';
  await append([]);
  expect(meta.textContent).toContain('1 blocked');
  expect(meta.textContent).toContain('1 paused');
  expect(meta.textContent).not.toContain('waiting workers');
  expect(meta.textContent).not.toContain('between turns');
});

it('opens Work & updates inline with typed evidence and refreshes the same pane without switching chats', async () => {
  const selected = summary([]);
  selected.title = 'Selected chat stays open';
  const work = {
    ...summary([]),
    id: '2026-09-02-work-pane',
    title: 'Recovery repair',
    conversationId: 'chat-work-pane',
    chatIds: ['chat-work-pane'],
    updatedAt: T0 + 60_000,
    fileEdits: 1,
    linesAdded: 8,
    linesRemoved: 2,
    lastFileChangeAt: T0 + 50_000,
    lastToolCallAt: T0 + 50_000
  };
  const edited = toolCall(1, 'work-pane-edit') as Extract<SessionEvent, { kind: 'tool_call' }>;
  edited.call.tool = 'apply_patch';
  edited.call.summary = { kind: 'edit', title: 'Edited recovery owner', detail: 'exact saved obligation', tone: 'good' };
  edited.call.changes = [{ path: 'src/main/bridge.ts', added: 8, removed: 2, approximate: false }];
  const workEvents: SessionEvent[] = [
    edited,
    { seq: 2, time: T0 + 51_000, source: 'app', kind: 'user_message', messageId: 'receipt-12345678', message: text('Progress checkpoint: 2h of proven accumulated active work.') },
    { seq: 3, time: T0 + 52_000, source: 'extension', kind: 'turn_start', turnId: 'scope-response-turn' },
    { seq: 4, time: T0 + 53_000, source: 'extension', kind: 'assistant_message', messageId: 'scope-response-final', turnId: 'scope-response-turn', message: text('Scope update: recovery ownership is fixed and the next action is installed-path proof.'), state: 'final', final: true },
    { seq: 5, time: T0 + 54_000, source: 'extension', kind: 'turn_start', turnId: 'unrelated-later-turn' },
    { seq: 6, time: T0 + 55_000, source: 'extension', kind: 'assistant_message', messageId: 'unrelated-later-final', turnId: 'unrelated-later-turn', message: text('Unrelated later final must not become the two-hour scope update.'), state: 'final', final: true }
  ];
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0 + 70_000, targetLanes: 5,
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [{ sessionId: work.id, conversationId: work.conversationId!, title: work.title, mode: 'loop', state: 'working',
      reason: 'Repairing exact recovery ownership.', nextAction: 'Run focused regression.', nextRetryAt: null, lastWorkedAt: T0 + 50_000,
      activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }]
  };
  const plan = { updatedAt: T0, plan: [{ step: 'Fix recovery ownership', status: 'in_progress' as const, details: 'Preserve exact receipts.' }],
    checklist: [
      { id: 'live', requirement: 'Keep drafts safe', source: 'user follow-up', acceptance: 'No replay', status: 'verified' as const,
        evidence: ['live-verified native workflow: focused helper test pass in the installed app.'] },
      { id: 'source', requirement: 'Keep source regression', source: 'user follow-up', acceptance: 'Source tests pass', status: 'implemented' as const,
        evidence: ['source-tested: focused renderer regression passed in Vitest.'] },
      { id: 'provider', requirement: 'Prove provider path', source: 'user follow-up', acceptance: 'Same-account live proof', status: 'blocked' as const,
        blocker: 'External provider restriction: quota-held model blocks live verification.', nextExperiment: 'Retry only when provider access returns.' },
      { id: 'ambiguous', requirement: 'Preserve send custody', source: 'user follow-up', acceptance: 'Native receipt is exact', status: 'blocked' as const,
        blocker: 'Ambiguous send: native receipt is missing for the exact request.', nextExperiment: 'Do not replay; inspect exact receipt boundary.' },
      { id: 'unknown', requirement: 'Recover original denominator', source: 'user follow-up', acceptance: 'Original count known', status: 'pending' as const,
        evidence: ['denominator unknown: original acceptance count has not been reconstructed.'] },
      { id: 'blocked', requirement: 'Prove installed path', source: 'user follow-up', acceptance: 'Live proof', status: 'blocked' as const, blocker: 'Installed bytes not updated', nextExperiment: 'Use a safe non-serving lane' }
    ] };
  const app = await boot([], true, [], [], {
    sessions: [selected, work],
    automation,
    sessionEvents: { [work.id]: workEvents },
    controls: {
      sessionId: work.id,
      conversationId: work.conversationId,
      plan,
      activeWork: {
        primeSessionId: work.id,
        sessionIds: [work.id],
        activeWorkMs: 7_200_000,
        activeWorkMeasurement: 'partial',
        report: {
          delivered: {
            thresholdMs: 7_200_000,
            messageId: 'receipt-12345678',
            confirmedAt: T0,
            sourceTurnId: 'turn-1',
            draftToken: 'draft-1'
          }
        }
      }
    }
  });
  const before = app.w.document.getElementById('chatTitle')!.textContent;
  const workRow = [...app.w.document.querySelectorAll<HTMLButtonElement>('.work-overview-row')].find(button => button.textContent?.includes(work.title))!;
  workRow.click();
  await settle();
  expect(app.w.document.getElementById('chatTitle')!.textContent).toBe(before);
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.hidden).toBe(false);
  expect(workRow.nextElementSibling).toBe(pane);
  expect(workRow.getAttribute('aria-expanded')).toBe('true');
  expect(pane.textContent).toContain('Edited recovery owner');
  expect(pane.textContent).toContain('src/main/bridge.ts');
  expect(pane.textContent).toContain('Fix recovery ownership');
  expect(pane.textContent).toContain('External provider restriction');
  const requirements = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(row => row.querySelector('b')?.textContent === 'Requirements')?.textContent ?? '';
  // The current acceptance owner requires a real native outcome + build + OS.
  // An older “installed app / focused helper test pass” self-claim is source
  // testing evidence, not a verified product result.
  expect(requirements).toContain('done=true: 0 / 6 active recorded requirements; done=false: 6');
  expect(requirements).toContain('source-tested=2');
  expect(requirements).not.toContain('live-verified=1');
  expect(requirements).toContain('provider-restricted=1');
  expect(requirements).toContain('ambiguous-send=1');
  expect(requirements).toContain('unknown=1');
  expect(requirements).toContain('blocked=1');
  expect(requirements).toContain('not completion proof');
  expect(requirements).not.toContain('Agent-reported verified');
  expect(pane.textContent).toContain('Two-active-hour scope update delivered at 2h');
  expect(pane.textContent).toContain('Scope update: recovery ownership is fixed');
  expect([...pane.querySelectorAll('.work-overview-pane-field')]
    .find(row => row.querySelector('b')?.textContent === '2h scope')?.textContent)
    .not.toContain('Unrelated later final must not become the two-hour scope update');
  expect(pane.querySelector('.work-overview-pane-history h3')?.textContent).toBe('Recent history');
  expect(pane.querySelectorAll('.work-overview-history li')).toHaveLength(3);
  expect(pane.querySelector('.work-overview-history')?.textContent).toContain('src/main/bridge.ts');
  expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Final answer recorded');

  const next = toolCall(7, 'work-pane-next') as Extract<SessionEvent, { kind: 'tool_call' }>;
  next.call.tool = 'apply_patch';
  next.call.summary = { kind: 'edit', title: 'Edited renderer pane', tone: 'good' };
  next.call.changes = [{ path: 'src/renderer/chat.ts', added: 4, removed: 0, approximate: false }];
  workEvents.push(next);
  app.notifySession();
  await settle(700);
  expect(pane.textContent).toContain('src/renderer/chat.ts');
  expect(app.w.document.getElementById('chatTitle')!.textContent).toBe(before);
  expect(app.w.document.querySelector(`[data-session-id="${work.id}"]`)?.nextElementSibling).toBe(pane);

  // A refresh can still be in flight when the user closes and immediately reopens this
  // temporary detail. An old response must not block or overwrite the new exact read.
  const originalGetSession = (app.w as any).api.getSession;
  let releaseOldRead: (() => void) | undefined;
  let holdNextRead = true;
  (app.w as any).api.getSession = (id: string, query?: { limit?: number }) => {
    const snapshot = originalGetSession(id, query);
    if (id !== work.id || !holdNextRead) return snapshot;
    holdNextRead = false;
    return new Promise(resolve => { releaseOldRead = () => void snapshot.then(resolve); });
  };
  app.notifySession();
  await settle(700);
  expect(releaseOldRead).toBeTypeOf('function');
  (pane.querySelector('.work-overview-pane-head button') as HTMLButtonElement).click();
  expect(pane.hidden).toBe(true);
  const latest = toolCall(8, 'work-pane-latest') as Extract<SessionEvent, { kind: 'tool_call' }>;
  latest.call.summary = { kind: 'edit', title: 'Newer exact pane read', tone: 'good' };
  workEvents.push(latest);
  app.w.document.querySelector<HTMLButtonElement>(`.work-overview-row[data-session-id="${work.id}"]`)!.click();
  await settle();
  expect(pane.textContent).toContain('Newer exact pane read');
  releaseOldRead!();
  await settle();
  expect(pane.textContent).toContain('Newer exact pane read');

  // Earlier-result lookups have their own action row before the navigation row.
  // Exercise the explicit navigation action rather than whichever button renders first.
  const openFullChat = pane.querySelector<HTMLButtonElement>('[data-work-action="open"]')!;
  expect(openFullChat.dataset.workAction).toBe('open');
  openFullChat.click();
  await settle();
  expect(app.w.document.getElementById('chatTitle')!.textContent).toBe(work.title);
  expect(app.w.document.querySelector<HTMLElement>('#chatBody > [data-view="progress"]')?.hidden).toBe(false);
});

it('reconciles a delayed Work & updates read after a newer exact final and blocked lifecycle update', async () => {
  // The first in-flight read belongs to a previously valid working snapshot. A native
  // final, blocked supervisor state, and duplicated session notifications arrive before
  // it resolves. A stale read must not keep the old tool as the latest result forever.
  const selected = { ...summary([]), title: 'Unchanged selected chat' };
  const target: SessionSummary = { ...summary([]), id: 'delayed-work-evidence', title: 'Lifecycle confirmation',
    conversationId: 'delayed-work-chat', chatIds: ['delayed-work-chat'], fileEdits: 1,
    lastFileChangeAt: T0 + 2_000, lastToolCallAt: T0 + 2_000 };
  const oldTool = toolCall(2, 'still-working') as Extract<SessionEvent, { kind: 'tool_call' }>;
  oldTool.call.summary = { kind: 'edit', title: 'Old unconfirmed work', tone: 'neutral' };
  const events: SessionEvent[] = [oldTool];
  const supervisor: AutomationSupervisorSnapshot = {
    observedAt: T0 + 2_000, targetLanes: 1,
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [{ sessionId: target.id, conversationId: target.conversationId!, title: target.title,
      mode: 'loop', state: 'working', reason: 'Waiting on the old tool', nextAction: 'Wait for result',
      nextRetryAt: null, lastWorkedAt: T0 + 2_000, activeWorkers: 0,
      recoverable: false, spinning: true, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], {
    sessions: [selected, target], automation: supervisor, sessionEvents: { [target.id]: events },
    controls: { automation: 'loop' }
  });
  const row = app.w.document.querySelector<HTMLButtonElement>(`.work-overview-row[data-session-id="${target.id}"]`)!;
  row.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Old unconfirmed work');
  const originalGetSession = (app.w as any).api.getSession;
  let releaseOldRead: (() => void) | undefined;
  let holdNext = true;
  let targetReads = 0;
  (app.w as any).api.getSession = (id: string, query?: { limit?: number }) => {
    if (id !== target.id) return originalGetSession(id, query);
    targetReads++;
    const frozen = originalGetSession(id, query);
    if (!holdNext) return frozen;
    holdNext = false;
    return new Promise(resolve => { releaseOldRead = () => void frozen.then(resolve); });
  };
  app.notifySession();
  await settle(700);
  expect(releaseOldRead).toBeTypeOf('function');

  const latestFinal: SessionEvent = {
    kind: 'assistant_message', seq: 5, time: T0 + 5_000, source: 'extension',
    turnId: 'confirmed-turn', messageId: 'confirmed-result', state: 'final', final: true,
    message: text('Confirmed exact result after the old tool. VALIDATION: saved output.')
  };
  events.push({ kind: 'turn_start', seq: 3, time: T0 + 3_000, source: 'extension', turnId: 'confirmed-turn' },
    latestFinal, { kind: 'turn_end', seq: 6, time: T0 + 6_000, source: 'extension',
      turnId: 'confirmed-turn', outcome: 'completed' });
  target.lastAssistantFinalAt = T0 + 5_000;
  target.lastTurnEndAt = T0 + 6_000;
  target.lastTurnOutcome = 'completed';
  supervisor.chats[0]!.state = 'blocked';
  supervisor.chats[0]!.reason = 'Exact provider access is blocked.';
  supervisor.chats[0]!.nextAction = 'Sign in to the same account.';
  supervisor.counts.working = 0;
  supervisor.counts.blocked = 1;
  app.notifySession();
  app.notifySession(); // Duplicate notification is one newer evidence generation.
  await settle(700);
  expect(app.w.document.getElementById('workOverviewMeta')!.textContent).toContain('1 blocked');
  releaseOldRead!();
  await settle(700);
  expect(pane.textContent).toContain('Recorded final: Confirmed exact result after the old tool');
  expect(pane.textContent).toContain('Sign in to the same account.');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('VALIDATION: saved output.');
  expect(targetReads).toBe(2); // The held request and exactly one coalesced replacement.
  expect(app.w.document.getElementById('chatTitle')!.textContent).toBe(selected.title);
});

it('does not re-read Work history for status-only repaints but refreshes on an exact session change', async () => {
  const evidence: SessionEvent[] = [toolCall(2, 'work-status-only')];
  const row = { ...summary(evidence), id: 'status-only-work-pane', title: 'Long-running result inspection',
    conversationId: 'status-only-chat', chatIds: ['status-only-chat'], fileEdits: 1,
    lastFileChangeAt: T0 + 2_000, lastToolCallAt: T0 + 2_000 };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0 + 2_000, targetLanes: 1,
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0,
      stalled: 0, paused: 0, blocked: 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId, title: row.title,
      mode: 'loop', state: 'working', reason: 'Current work observed.',
      nextAction: 'Inspect saved evidence.', nextRetryAt: null, lastWorkedAt: T0 + 2_000,
      activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation,
    // This regression is about supervisor-only paints, not overriding Main's
    // independent exact Off. Keep Goal/Loop enabled in its controls receipt.
    controls: { automation: 'loop' }, sessionEvents: { [row.id]: evidence } });
  app.w.document.querySelector<HTMLButtonElement>('.work-overview-row')!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const reads = () => app.sessionReads.filter(read => read.id === row.id && read.limit === 80).length;
  const before = reads();

  // Repainting a supervisor label or the sidebar's age must not start two new
  // Progress/history IPC requests. These paints contain no new recorded events.
  automation.chats[0]!.state = 'blocked';
  automation.chats[0]!.reason = 'Native sign-in restricted.';
  automation.chats[0]!.nextAction = 'Check sign-in without replaying the Send.';
  automation.counts.working = 0;
  automation.counts.blocked = 1;
  const chat = await import('../src/renderer/chat.js');
  chat.chatApply(app.state as unknown as AppState);
  chat.chatApply(app.state as unknown as AppState);
  await settle();
  expect(app.w.document.getElementById('workOverviewMeta')!.textContent).toContain('1 blocked');
  expect(pane.textContent).toContain('Check sign-in without replaying the Send.');
  expect(reads()).toBe(before);

  // A genuine recorded final is different: the coalesced session-changed load
  // must refresh the open pane once, without needing a new selection or poll.
  evidence.push({ kind: 'assistant_message', seq: 3, time: T0 + 3_000, source: 'extension',
    messageId: 'status-only-new-final', final: true,
    message: text('Result verified after the status-only repaint.') });
  row.lastAssistantFinalAt = T0 + 3_000;
  app.notifySession();
  await settle(700);
  expect(reads()).toBe(before + 1);
  expect(pane.textContent).toContain('Recorded final: Result verified after the status-only repaint.');
});

it('keeps a previous final accessible but not current after A to B to A selection and frontend rebind', async () => {
  const original: SessionSummary = { ...summary([]), id: 'retained-rebound-task',
    title: 'Retained task through frontend replacement',
    conversationId: 'original-provider-chat', chatIds: ['original-provider-chat'],
    fileEdits: 1, lastFileChangeAt: T0 + 3_000, lastToolCallAt: T0 + 2_000,
    lastAssistantFinalAt: T0 + 4_000, lastTurnEndAt: T0 + 5_000,
    lastTurnOutcome: 'completed', lastMessageAt: T0 + 5_000 };
  const other: SessionSummary = { ...summary([]), id: 'unrelated-selected-session',
    title: 'Unrelated selected session', conversationId: 'other-provider-chat',
    chatIds: ['other-provider-chat'] };
  const finalOne: SessionEvent = { kind: 'assistant_message', seq: 3, time: T0 + 4_000,
    source: 'extension', turnId: 'completed-old-turn', messageId: 'old-terminal-result',
    final: true, state: 'final', message: text('Old completed result. VALIDATION: previous provider only.') };
  const history: SessionEvent[] = [
    { kind: 'turn_start', seq: 1, time: T0 + 1_000, source: 'extension', turnId: 'completed-old-turn' },
    { ...toolCall(2, 'previous-edit'), turnId: 'completed-old-turn' }, finalOne,
    { kind: 'turn_end', seq: 4, time: T0 + 5_000, source: 'extension',
      turnId: 'completed-old-turn', outcome: 'completed' }
  ];
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0 + 5_000, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 1,
      recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [{ sessionId: original.id, conversationId: original.conversationId!, title: original.title,
      mode: 'loop', state: 'waiting-main', reason: 'Previous turn is complete.',
      nextAction: 'Wait for a new turn.', nextRetryAt: null, lastWorkedAt: T0 + 5_000,
      activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [original, other], automation,
    // This fixture's current Loop remains enabled. Generic boot() defaults
    // to exact Off, which must win over any old supervisor working state.
    controls: { automation: 'loop' }, sessionEvents: { [original.id]: history } });
  const workRow = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] .work-overview-row[data-session-id="${original.id}"]`)!;
  workRow.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = () => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid()).toContain('Recorded final: Old completed result.');
  const oldRead = (app.w as any).api.getSession;
  let release!: () => void;
  let pending = true;
  (app.w as any).api.getSession = (id: string, query?: { limit?: number }) => {
    const snapshot = oldRead(id, query);
    if (id !== original.id || query?.limit !== 80 || !pending) return snapshot;
    pending = false;
    return new Promise(resolve => { release = () => void snapshot.then(resolve); });
  };
  app.notifySession();
  await settle(700);
  expect(release).toBeTypeOf('function');
  app.w.document.querySelector<HTMLElement>(`#sessionList [data-id="${other.id}"]`)!.click();
  await settle();
  expect(app.w.document.getElementById('chatTitle')!.textContent).toBe(other.title);

  // The same durable local session is rebound to another provider conversation. Its
  // previous terminal answer remains in history, but a genuinely new turn has started.
  history.push({ kind: 'turn_start', seq: 5, time: T0 + 7_000,
    source: 'extension', turnId: 'new-provider-turn' });
  const rebound: SessionSummary = { ...original, conversationId: 'rebound-provider-chat',
    chatIds: [...original.chatIds, 'rebound-provider-chat'],
    activeTurnId: 'new-provider-turn', updatedAt: T0 + 7_000, lastMessageAt: T0 + 7_000 };
  automation.chats[0] = { ...automation.chats[0]!, conversationId: rebound.conversationId!,
    state: 'working', spinning: true, reason: 'Exact new provider turn started.',
    nextAction: 'Wait for this turn’s first result.', lastWorkedAt: T0 + 7_000 };
  automation.counts.working = 1;
  automation.counts['waiting-main'] = 0;
  await app.replaceSessions([rebound, other]);
  app.w.document.querySelector<HTMLElement>(`#sessionList [data-id="${original.id}"]`)!.click();
  app.notifySession();
  release();
  await settle(700);
  expect(app.w.document.getElementById('chatTitle')!.textContent).toBe(original.title);
  expect(app.w.document.getElementById('workOverviewMeta')!.textContent).toContain('1 working');
  expect(justDid()).toContain('no exact current-turn final or tool outcome yet.');
  expect(justDid()).not.toContain('Recorded final: Old completed result.');
  const disclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  expect(disclosure.querySelector('summary')?.textContent).toBe('Read previous recorded final answer');
  disclosure.open = true;
  expect(disclosure.textContent).toContain('VALIDATION: previous provider only.');
  expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Final answer recorded');
  expect(app.w.document.querySelectorAll('.work-overview-row[aria-expanded="true"]')).toHaveLength(1);

  history.push({ kind: 'assistant_message', seq: 6, time: T0 + 8_000,
    source: 'extension', turnId: 'new-provider-turn', messageId: 'fresh-completed-result',
    final: true, state: 'final', message: text('Current resumed turn completed with new evidence.') });
  // The provider can open its final before the browser reports turn_end; the exact
  // current turn ID is enough to show this new final immediately and truthfully.
  await app.replaceSessions([{ ...rebound, lastAssistantFinalAt: T0 + 8_000 }, other]);
  expect(justDid()).toContain('Recorded final: Current resumed turn completed');
  history.push({ kind: 'turn_end', seq: 7, time: T0 + 9_000,
    source: 'extension', turnId: 'new-provider-turn', outcome: 'completed' });
  // A completed successor turn loses activeTurnId; the exact current-provider
  // finish owner, rather than a session-wide final timestamp, proves this is B.
  await app.replaceSessions([{ ...rebound, activeTurnId: null,
    lastAssistantFinalAt: T0 + 8_000, lastTurnEndAt: T0 + 9_000,
    lastTurnOutcome: 'completed',
    finishTurn: { turnId: 'new-provider-turn', conversationId: 'rebound-provider-chat',
      startedAt: T0 + 7_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } }, other]);
  expect(justDid()).toContain('Recorded final: Current resumed turn completed');
  expect(justDid()).not.toContain('Old completed result.');
});

it.each(['working', 'recovering', 'blocked'] as const)(
  'does not carry an old conversation %s supervisor label into a rebound local chat',
  async oldState => {
    const now = Date.now();
    const current: SessionSummary = {
      ...summary([]), id: `binding-status-${oldState}`, title: 'Resume retained status task',
      conversationId: 'rebound-provider-B', chatIds: ['retired-provider-A', 'rebound-provider-B'],
      lastToolCallAt: now - 400, lastAssistantFinalAt: now - 900,
      lastFileChangeAt: now - 500, fileEdits: 1,
      activeTurnId: null, activityExpiresAt: now + 60_000
    };
    const previousResult: SessionEvent = {
      kind: 'assistant_message', seq: 1, time: now - 900, source: 'extension',
      turnId: 'old-completed-turn', messageId: 'retained-earlier-provider-answer',
      final: true, message: text('Historical output from before Compact & Resume stays accessible.')
    };
    const supervisor: AutomationSupervisorSnapshot = {
      observedAt: now, targetLanes: 1,
      counts: { working: oldState === 'working' ? 1 : 0, recovering: oldState === 'recovering' ? 1 : 0,
        blocked: oldState === 'blocked' ? 1 : 0, 'waiting-main': 0, 'waiting-workers': 0,
        stalled: 0, paused: 0 },
      chats: [{
        sessionId: current.id, conversationId: 'retired-provider-A', title: 'Old browser binding',
        mode: 'loop', state: oldState, spinning: oldState === 'working',
        reason: 'OLD_PROVIDER_STATUS_MUST_NOT_BECOME_CURRENT',
        nextAction: 'Do not apply the old provider state to the successor.',
        nextRetryAt: oldState === 'recovering' ? now + 25_000 : null,
        lastWorkedAt: now, activeWorkers: 0, recoverable: oldState === 'recovering',
        recoveryStage: oldState === 'recovering' ? 'retry-scheduled' : null
      }]
    };
    const source: SessionEvent[] = [previousResult, { kind: 'turn_start', seq: 2, time: now - 200,
      source: 'extension', turnId: 'new-provider-B-turn' }];
    const app = await boot(source, true, [], [], { sessions: [current], automation: supervisor,
      sessionEvents: { [current.id]: source },
      controls: { conversationId: current.conversationId, activeTurnId: null, automation: 'loop', goalWait: null }
    });
    const doc = app.w.document;
    const sidebar = doc.querySelector<HTMLElement>(`#sessionList [data-id="${current.id}"]`)!;
    expect(sidebar.querySelector('.sess-automation-state')?.textContent).toContain('unknown');
    expect(sidebar.title).toContain('Current conversation binding changed');
    expect(sidebar.title).not.toContain('OLD_PROVIDER_STATUS_MUST_NOT_BECOME_CURRENT');
    expect(sidebar.querySelector('.session-status.is-working')).toBeNull();
    expect(sidebar.querySelector('.sess-automation-retry')).toBeNull();
    const inline = doc.getElementById('chatState')!;
    expect(inline.textContent).toContain('unknown');
    expect(inline.textContent).not.toContain('Working');
    expect(inline.getAttribute('aria-label')).toContain('binding changed');
    expect(inline.classList.contains('is-unknown')).toBe(true);
    expect(inline.classList.contains('is-working')).toBe(false);
    const top = doc.getElementById('automationSupervisorSummary')!.textContent ?? '';
    const meta = doc.getElementById('workOverviewMeta')!.textContent ?? '';
    expect(top).toContain('1 unknown');
    expect(meta).toContain('1 unknown');
    expect(top).not.toContain('working');
    expect(meta).not.toContain('working');
    expect(top).not.toContain('repairing');
    expect(top).not.toContain('blocked');
    const currentRow = doc.querySelector<HTMLButtonElement>(
      `.work-overview-section[data-work-section="current"] [data-session-id="${current.id}"]`)!;
    expect(currentRow.textContent).toContain('unknown');
    expect(currentRow.querySelector('.work-overview-state.is-unknown')).not.toBeNull();
    currentRow.click();
    await settle();
    const pane = doc.getElementById('workOverviewPane')!;
    const status = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
      .find(item => item.querySelector('b')?.textContent === 'Current status')?.textContent ?? '';
    expect(status).toContain('unknown');
    expect(status).toContain('binding changed');
    expect(status).not.toContain('OLD_PROVIDER_STATUS_MUST_NOT_BECOME_CURRENT');
    expect(pane.querySelector('.work-overview-result')?.textContent)
      .toContain('Historical output from before Compact & Resume stays accessible.');
    (doc.getElementById('progressToggle') as HTMLButtonElement).click();
    await settle();
    expect(doc.querySelector('.progress-state')?.textContent).toBe('unknown');
    expect(doc.querySelector('.progress-state.is-unknown')).not.toBeNull();
    expect(doc.getElementById('progressInbox')?.textContent).not.toContain('OLD_PROVIDER_STATUS_MUST_NOT_BECOME_CURRENT');

    // The subsequent exact supervisor B snapshot resolves the unknown projection.
    supervisor.observedAt = Date.now() + 10;
    supervisor.chats[0] = {
      ...supervisor.chats[0]!, title: current.title, conversationId: current.conversationId!,
      state: 'waiting-main', spinning: false, nextRetryAt: null, recoveryStage: null,
      reason: 'New conversation is between turns.', nextAction: 'Wait for its own turn.',
      recoverable: false
    };
    supervisor.counts = { ...supervisor.counts, working: 0, recovering: 0, blocked: 0, 'waiting-main': 1 };
    app.notifySession();
    await settle(700);
    expect(doc.querySelector(`#sessionList [data-id="${current.id}"] .sess-automation-state`)?.textContent)
      .toContain('between turns');
    expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('unknown');
    expect(doc.getElementById('chatState')!.textContent).not.toContain('binding changed');
    expect(doc.querySelector('.progress-state')?.textContent).toBe('waiting main');
    expect(app.live.sent).toEqual([]);
    expect(app.live.controlCalls).toEqual([]);
  }
);

it('labels retained prior-provider Work evidence as historical when a rebound read is unavailable', async () => {
  const now = Date.now();
  const owner: SessionSummary = { ...summary([]), id: 'retained-provider-history-gap',
    title: 'Continue the same durable task',
    conversationId: 'previous-provider-A', chatIds: ['previous-provider-A'],
    lastAssistantFinalAt: now - 5_000, lastToolCallAt: now - 6_000,
    lastFileChangeAt: now - 5_000, fileEdits: 1, lastTurnOutcome: 'completed' };
  const previousResult: SessionEvent = { kind: 'assistant_message', seq: 2, time: now - 5_000,
    source: 'extension', turnId: 'old-provider-turn', messageId: 'old-read-result',
    final: true, message: text('Retained implementation and exact verification from old provider conversation.') };
  const sent: SessionEvent = { kind: 'user_message', seq: 1, time: now - 8_000,
    source: 'app', turnId: 'old-provider-turn', messageId: 'old-provider-native-send',
    inputId: 'old-provider-input-id', inputDelivery: 'confirmed',
    message: text('Original native message already sent in the prior provider conversation.') };
  const outbox: InputEntry = { id: 'old-provider-input-id', sessionId: owner.id,
    conversationId: owner.conversationId, mode: 'auto', text: 'Original native message',
    model: 'gpt-6-thinking', reasoningEffort: 'xhigh', dueAt: 0,
    state: 'cancelled', createdAt: now - 9_000, owner: 'old-provider-tab',
    deliveredAt: now - 8_000, messageId: sent.messageId, error: 'Collection was closed later.' };
  const source: SessionEvent[] = [sent, previousResult];
  const app = await boot([], true, [], [], { sessions: [owner],
    sessionEvents: { [owner.id]: source }, inputs: [outbox]
  });
  const update = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${owner.id}"]`)!;
  update.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const disclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  const originalBody = disclosure.querySelector<HTMLElement>('.work-overview-result-body')!;
  disclosure.open = true;
  disclosure.querySelector<HTMLElement>('summary')!.focus();
  expect(disclosure.textContent).toContain('Retained implementation and exact verification');

  const originalRead = (app.w as any).api.getSession;
  let historyUnavailable = true;
  (app.w as any).api.getSession = (id: string, query?: { limit?: number }) =>
    id === owner.id && historyUnavailable
      ? Promise.resolve({ ok: false, error: 'Exact new-provider history currently unavailable.' })
      : originalRead(id, query);
  const rebound: SessionSummary = { ...owner,
    conversationId: 'successor-provider-B', chatIds: [...owner.chatIds, 'successor-provider-B'],
    activeTurnId: 'successor-turn', lastMessageAt: now + 1_000, updatedAt: now + 1_000 };
  await app.replaceSessions([rebound]);
  const field = (label: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === label)?.textContent ?? '';
  // A retained open turn with an expired activity signal is unverified, not
  // the positive current-generation status of the previous provider.
  expect(field('Current status')).toContain('current execution and completion are unverified');
  expect(field('Recorded history boundary')).toContain('previous provider conversation');
  expect(field('Recorded history boundary')).toContain('Latest exact history unavailable');
  expect(field('Native delivery & answer')).toContain('old-provider-native-send');
  expect(field('Native delivery & answer')).toContain('previous provider conversation');
  expect(field('Native delivery & answer')).not.toContain('delivered to the current conversation');
  expect(pane.querySelector('.work-overview-result')).toBe(disclosure);
  expect(pane.querySelector('.work-overview-result-body')).toBe(originalBody);
  expect(disclosure.open).toBe(true);
  expect(app.w.document.activeElement).toBe(disclosure.querySelector('summary'));
  expect(field('Just did')).not.toContain('Recorded final: Retained implementation');

  // A later exact B read replaces the stale status, but never treats the old
  // native Send as permission to replay the input.
  historyUnavailable = false;
  source.push({ kind: 'turn_start', seq: 3, time: now + 1_000,
    source: 'extension', turnId: 'successor-turn' });
  app.notifySession();
  await settle(700);
  expect(field('Recorded history boundary')).toBe('');
  expect(field('Just did')).toContain('no exact current-turn final or tool outcome yet');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Retained implementation');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it.each([
  { label: 'working source and successful destination call', prior: 'working', current: 'ok', origin: 'current', laterPrior: false, proven: true },
  { label: 'recovering source and failed destination process', prior: 'recovering', current: 'process_exit_nonzero', origin: 'current', laterPrior: false, proven: true },
  { label: 'blocked source and rejected destination tool', prior: 'blocked', current: 'tool_rejected', origin: 'current', laterPrior: false, proven: true },
  { label: 'waiting source and destination execution error', prior: 'waiting-main', current: 'tool_execution_error', origin: 'current', laterPrior: false, proven: true },
  { label: 'stalled source only', prior: 'stalled', current: null, origin: 'none', laterPrior: false, proven: false },
  { label: 'unattributed destination-looking tool', prior: 'working', current: 'ok', origin: 'unattributed', laterPrior: false, proven: false },
  { label: 'old source tool recorded after a proved destination tool', prior: 'recovering', current: 'ok', origin: 'current', laterPrior: true, proven: true },
  { label: 'superseded destination-looking tool', prior: 'blocked', current: 'ok', origin: 'superseded', laterPrior: false, proven: false }
] as const)('separates old provider automation from $label in Work detail', async scenario => {
  const now = Date.now();
  const owner: SessionSummary = { ...summary([]), id: 'work-provider-transition-custody',
    title: 'Retained user task with current Core work', conversationId: 'provider-B',
    chatIds: ['provider-A', 'provider-B'], lastToolCallAt: now - 1_000,
    activityExpiresAt: now + 60_000 };
  const previous = toolCall(1, 'historical-source-tool') as Extract<SessionEvent, { kind: 'tool_call' }>;
  const priorTool: SessionEvent = { ...previous, time: now - 6_000,
    call: { ...previous.call, conversationId: 'provider-A',
      summary: { kind: 'read', title: 'Read previous provider file', tone: 'neutral' } } };
  const events: SessionEvent[] = [priorTool];
  if (scenario.current) {
    const tool = toolCall(2, 'current-provider-tool') as Extract<SessionEvent, { kind: 'tool_call' }>;
    events.push({ ...tool, time: now - 1_000, call: { ...tool.call,
      outcome: scenario.current,
      conversationId: scenario.origin === 'unattributed' ? null : 'provider-B',
      attributionMethod: scenario.origin === 'current' ? 'request_id' :
        scenario.origin === 'superseded' ? 'superseded' : 'unattributed',
      summary: { kind: 'read', title: 'Read current provider file', tone: 'neutral' }
    } });
  }
  if (scenario.laterPrior) events.push({ ...priorTool, seq: 3, time: now,
    call: { ...previous.call, callId: 'late-historical-call',
      summary: { kind: 'read', title: 'Late historical provider read', tone: 'neutral' } } });
  const supervisor: AutomationSupervisorSnapshot = { observedAt: now, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0,
      recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [{
      sessionId: owner.id, conversationId: 'provider-A', title: 'Historical provider task',
      mode: 'loop', state: scenario.prior, reason: 'Earlier provider status, no longer current',
      nextAction: 'Do not replay source work.', nextRetryAt: null,
      lastWorkedAt: now - 6_000, activeWorkers: 0,
      recoverable: scenario.prior === 'recovering', spinning: scenario.prior === 'working',
      recoveryStage: scenario.prior === 'recovering' ? 'retry-scheduled' : null
    }]
  };
  const app = await boot([], true, [], [], { sessions: [owner], automation: supervisor,
    sessionEvents: { [owner.id]: events } });
  const doc = app.w.document;
  const row = doc.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${owner.id}"]`)!;
  expect(row.textContent).toContain('unknown');
  row.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
  const custody = field('Provider transition evidence');
  expect(custody).toContain('provider-A');
  expect(custody).toContain('historical');
  expect(custody).toContain('provider-B');
  expect(field('Current status')).toContain('unknown');
  if (scenario.proven) {
    expect(custody).toContain('Read current provider file');
    expect(custody).toContain('exact Core call');
    expect(field('Just did')).toContain('Read current provider file');
    expect(field('Just did')).not.toContain('Late historical provider read');
  } else {
    expect(custody).toContain('No exact attributed Core call in this bounded current-provider read');
    expect(field('Just did')).not.toContain('Read previous provider file');
    expect(field('Just did')).not.toContain('Read current provider file');
  }
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it.each(['waiting-main', 'working'] as const)(
  'keeps provider A history separate after the supervisor has correctly caught up to B (%s)',
  async state => {
    const now = Date.now();
    const owner: SessionSummary = { ...summary([]), id: `current-provider-caught-up-${state}`,
      title: 'Same saved task after supervisor caught up', conversationId: 'provider-B',
      chatIds: ['provider-A', 'provider-B'], lastToolCallAt: now,
      fileEdits: 3, linesAdded: 7, lastFileChangeAt: now,
      activityExpiresAt: now + 60_000 };
    const base = toolCall(1, 'previous-provider-change') as Extract<SessionEvent, { kind: 'tool_call' }>;
    const previous: SessionEvent = { ...base, time: now - 4_000,
      call: { ...base.call, conversationId: 'provider-A', attributionMethod: 'request_id',
        summary: { kind: 'edit', title: 'Historical provider A edit', tone: 'neutral' },
        changes: [{ path: 'old-provider-only.md', added: 3, removed: 0, approximate: false }] } };
    const current: SessionEvent = { ...base, seq: 2, time: now - 2_000,
      call: { ...base.call, callId: 'proved-provider-B-change', conversationId: 'provider-B',
        attributionMethod: 'request_id',
        summary: { kind: 'edit', title: 'Exact current provider B edit', tone: 'neutral' },
        changes: [{ path: 'current-provider-B.ts', added: 4, removed: 0, approximate: false }] } };
    const lateHistorical: SessionEvent = { ...previous, seq: 3, time: now,
      call: { ...(previous as typeof base).call, callId: 'late-historical-provider-A',
        summary: { kind: 'edit', title: 'Late old provider A edit', tone: 'neutral' } } };
    const unboundError: SessionEvent = { kind: 'chat_error', seq: 4, time: now + 100,
      source: 'extension', turnId: 'older-provider-A-turn', reason: 'model_cooldown',
      blocking: true, recoverable: false, message: text('Earlier provider model was unavailable') };
    const automation: AutomationSupervisorSnapshot = { observedAt: now, targetLanes: 1,
      counts: { working: state === 'working' ? 1 : 0, 'waiting-main': state === 'waiting-main' ? 1 : 0,
        'waiting-workers': 0, recovering: 0, stalled: 0, paused: 0, blocked: 0 },
      chats: [{ sessionId: owner.id, conversationId: 'provider-B', title: owner.title, mode: 'loop',
        state, reason: 'Current provider B state verified by supervisor.', nextAction: 'Inspect saved B outcome.',
        nextRetryAt: null, lastWorkedAt: now - 2_000, activeWorkers: 0, recoverable: false,
        spinning: state === 'working', recoveryStage: null }]
    };
    const app = await boot([], true, [], [], { sessions: [owner], automation,
      sessionEvents: { [owner.id]: [previous, current, lateHistorical, unboundError] } });
    const doc = app.w.document;
    doc.querySelector<HTMLButtonElement>(
      `.work-overview-section[data-work-section="current"] [data-session-id="${owner.id}"]`)!.click();
    await settle();
    const pane = doc.getElementById('workOverviewPane')!;
    const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
      .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
    expect(field('Just did')).toContain('Exact current provider B edit');
    expect(field('Just did')).not.toContain('Late old provider A edit');
    expect(field('Changes')).toContain('current-provider-B.ts');
    expect(field('Changes')).not.toContain('old-provider-only.md');
    expect(field('Historical changes')).toContain('old-provider-only.md');
    expect(field('Provider transition evidence')).toContain('provider-A');
    expect(field('Provider transition evidence')).toContain('provider-B');
    expect(field('Provider transition evidence')).toContain('proved-provider-B-change');
    expect(field('Provider evidence')).toContain('not tied to the current provider turn');
    expect(field('Current status')).toContain('Exact current-provider Core call');
    expect(field('Current status')).toContain('does not independently prove ongoing generation');
    expect(field('Current status')).toContain(state === 'working' ? 'working' : 'between turns');
    expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Historical provider A');
    expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Exact current provider B edit');
    expect(app.live.sent).toEqual([]);
    expect(app.live.controlCalls).toEqual([]);
  }
);

it.each([true, false])(
  'keeps a late provider A final historical when B supervisor is current (exact B tool: %s)',
  async withCurrentTool => {
    const now = Date.now();
    const owner: SessionSummary = { ...summary([]),
      id: `prior-provider-final-${withCurrentTool ? 'with-current-tool' : 'without-current-tool'}`,
      title: 'Retained final while provider B owns a new turn',
      conversationId: 'provider-B', chatIds: ['provider-A', 'provider-B'],
      lastAssistantFinalAt: now - 8_000, lastToolCallAt: withCurrentTool ? now - 3_000 : null,
      lastTurnEndAt: now - 1_000, lastTurnOutcome: 'completed', activeTurnId: null,
      finishTurn: { turnId: 'current-B-turn', conversationId: 'provider-B', startedAt: now - 5_000,
        notified: false, released: true, decisionRevision: null,
        workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
    const historical: SessionEvent = { kind: 'assistant_message', seq: 3, time: now - 8_000,
      source: 'extension', turnId: 'completed-A-turn', messageId: 'historical-provider-A-result',
      final: true, message: text('Earlier A final is saved but must not be B current work.') };
    const base = toolCall(2, 'current-provider-B-read') as Extract<SessionEvent, { kind: 'tool_call' }>;
    const currentTool: SessionEvent = { ...base, time: now - 3_000, turnId: 'current-B-turn',
      call: { ...base.call, conversationId: 'provider-B', attributionMethod: 'request_id',
        summary: { kind: 'read', title: 'Current B exact Core result', tone: 'neutral' } } };
    const events: SessionEvent[] = [
      { kind: 'turn_start', seq: 1, time: now - 5_000, source: 'extension', turnId: 'current-B-turn' },
      ...(withCurrentTool ? [currentTool] : []), historical,
      { kind: 'turn_end', seq: 4, time: now - 1_000, source: 'extension',
        turnId: 'current-B-turn', outcome: 'completed' }
    ];
    const automation: AutomationSupervisorSnapshot = { observedAt: now, targetLanes: 1,
      counts: { working: 0, 'waiting-main': 1, 'waiting-workers': 0, recovering: 0,
        stalled: 0, paused: 0, blocked: 0 },
      chats: [{ sessionId: owner.id, conversationId: 'provider-B', title: owner.title,
        mode: 'loop', state: 'waiting-main', reason: 'Current B turn ended.',
        nextAction: 'Read current provider evidence before any new turn.',
        lastWorkedAt: now - 1_000, nextRetryAt: null, activeWorkers: 0,
        recoverable: false, spinning: false, recoveryStage: null }]
    };
    const app = await boot([], true, [], [], { sessions: [owner], automation,
      sessionEvents: { [owner.id]: events } });
    const doc = app.w.document;
    doc.querySelector<HTMLButtonElement>(
      `.work-overview-section[data-work-section="current"] [data-session-id="${owner.id}"]`)!.click();
    await settle();
    const pane = doc.getElementById('workOverviewPane')!;
    const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
      .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
    expect(field('Just did')).not.toContain('Earlier A final is saved');
    if (withCurrentTool) expect(field('Just did')).toContain('Current B exact Core result');
    else expect(field('Just did')).toContain('no exact');
    expect(pane.querySelector('.work-overview-result > summary')?.textContent)
      .toBe('Read previous recorded final answer');
    expect(pane.querySelector('.work-overview-result')?.textContent)
      .toContain('Earlier A final is saved');
    expect(pane.querySelector('.work-overview-history')?.textContent)
      .toContain('Earlier-turn: Final answer recorded · current turn result unverified');
    expect(app.live.sent).toEqual([]);
    expect(app.live.controlCalls).toEqual([]);
  }
);

it('promotes a recorded final only when its turn belongs to the current provider B', async () => {
  const now = Date.now();
  const owner: SessionSummary = { ...summary([]), id: 'proved-provider-B-final',
    title: 'Exact successor turn completed', conversationId: 'provider-B',
    chatIds: ['provider-A', 'provider-B'], activeTurnId: null,
    lastAssistantFinalAt: now - 1_000, lastTurnEndAt: now - 500, lastTurnOutcome: 'completed',
    finishTurn: { turnId: 'provider-B-finished-turn', conversationId: 'provider-B',
      startedAt: now - 4_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const events: SessionEvent[] = [
    { kind: 'assistant_message', seq: 1, time: now - 7_000, source: 'extension',
      turnId: 'old-provider-A', messageId: 'prior-A-answer', final: true, message: text('Earlier A result') },
    { kind: 'turn_start', seq: 2, time: now - 4_000, source: 'extension', turnId: 'provider-B-finished-turn' },
    { kind: 'assistant_message', seq: 3, time: now - 1_000, source: 'extension',
      turnId: 'provider-B-finished-turn', messageId: 'exact-B-answer',
      final: true, message: text('Current provider B final verified by matching turn.') },
    { kind: 'turn_end', seq: 4, time: now - 500, source: 'extension',
      turnId: 'provider-B-finished-turn', outcome: 'completed' }
  ];
  const automation: AutomationSupervisorSnapshot = { observedAt: now, targetLanes: 1,
    counts: { working: 0, 'waiting-main': 1, 'waiting-workers': 0, recovering: 0,
      stalled: 0, paused: 0, blocked: 0 },
    chats: [{ sessionId: owner.id, conversationId: 'provider-B', title: owner.title,
      mode: 'loop', state: 'waiting-main', reason: 'Current B final is retained.',
      nextAction: 'Wait for deliberate continuation.', lastWorkedAt: now - 500,
      nextRetryAt: null, activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [owner], automation,
    sessionEvents: { [owner.id]: events } });
  const doc = app.w.document;
  doc.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${owner.id}"]`)!.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid).toContain('Recorded final: Current provider B final verified');
  expect(pane.querySelector('.work-overview-result > summary')?.textContent)
    .toBe('Read recorded final answer');
  expect(app.live.sent).toEqual([]);
});

it.each(['late A final', 'late A turn start'] as const)(
  'does not dismiss a current B provider hold using a %s after its error', async laterKind => {
    const now = Date.now();
    const owner: SessionSummary = { ...summary([]), id: `provider-B-error-${laterKind.replaceAll(' ', '-')}`,
      title: 'Provider B restriction with old provider recorder events',
      conversationId: 'provider-B', chatIds: ['provider-A', 'provider-B'],
      activeTurnId: null, lastTurnOutcome: 'failed', lastTurnEndAt: now - 1_500,
      finishTurn: { turnId: 'provider-B-failed-turn', conversationId: 'provider-B',
        startedAt: now - 5_000, notified: false, released: true,
        decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
    const error: SessionEvent = { kind: 'chat_error', seq: 2, time: now - 2_000,
      source: 'extension', turnId: 'provider-B-failed-turn', blocking: true, recoverable: false,
      message: text('Model not found for current provider B') };
    const late: SessionEvent = laterKind === 'late A final'
      ? { kind: 'assistant_message', seq: 3, time: now - 1_000, source: 'extension',
        turnId: 'previous-A-turn', messageId: 'late-prior-A-final',
        final: true, message: text('Old A answer appended after B failed.') }
      : { kind: 'turn_start', seq: 3, time: now - 1_000, source: 'extension',
        turnId: 'previous-A-turn' };
    const automation: AutomationSupervisorSnapshot = { observedAt: now, targetLanes: 1,
      counts: { working: 0, 'waiting-main': 0, 'waiting-workers': 0, recovering: 0,
        stalled: 0, paused: 0, blocked: 1 },
      chats: [{ sessionId: owner.id, conversationId: 'provider-B', title: owner.title,
        mode: 'goal', state: 'blocked', reason: 'Provider B access is held.',
        nextAction: 'Wait for B provider access; never resend an unconfirmed request.',
        nextRetryAt: null, lastWorkedAt: now - 2_000, activeWorkers: 0,
        recoverable: false, spinning: false, recoveryStage: null }]
    };
    const app = await boot([], true, [], [], { sessions: [owner], automation,
      // Without this control the generic harness defaults to exact Off,
      // correctly superseding the older supervisor nextAction. Exercise a
      // genuinely still-enabled B Goal for this provider-hold regression.
      controls: { automation: 'goal' },
      sessionEvents: { [owner.id]: [
        { kind: 'turn_start', seq: 1, time: now - 5_000, source: 'extension', turnId: 'provider-B-failed-turn' },
        error, late
      ] } });
    const doc = app.w.document;
    doc.querySelector<HTMLButtonElement>(
      `.work-overview-section[data-work-section="current"] [data-session-id="${owner.id}"]`)!.click();
    await settle();
    const pane = doc.getElementById('workOverviewPane')!;
    const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
      .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
    expect(field('Just did')).toContain('Provider error recorded: Model not found for current provider B');
    expect(field('Provider evidence')).toContain('Last recorded provider error');
    expect(field('Provider evidence')).not.toContain('Earlier recorded provider error');
    expect(field('Current status')).toContain('blocked');
    expect(field('Next / blocker')).toContain('never resend');
    if (laterKind === 'late A final') {
      expect(pane.querySelector('.work-overview-result > summary')?.textContent)
        .toBe('Read previous recorded final answer');
      expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Old A answer appended');
    }
    expect(app.live.sent).toEqual([]);
    expect(app.live.controlCalls).toEqual([]);
  }
);

it.each([
  { kind: 'provider hold', state: 'blocked' as const, reason: 'model_cooldown' as const,
    text: 'B model remains unavailable', toolAfterError: false },
  { kind: 'interrupted page', state: 'recovering' as const, reason: 'stream_gone' as const,
    text: 'B page interrupted; current recovery unconfirmed', toolAfterError: true }
])(
  'retains current B $kind evidence when a delayed previous-provider A error arrives later',
  async scenario => {
    const now = Date.now();
    const owner: SessionSummary = { ...summary([]), id: `delayed-A-error-${scenario.state}`,
      title: 'Original provider B status retained despite late A page diagnostics',
      conversationId: 'provider-B', chatIds: ['provider-A', 'provider-B'],
      activeTurnId: null, lastTurnOutcome: scenario.state === 'blocked' ? 'failed' : 'interrupted',
      lastTurnEndAt: now - 1_000,
      finishTurn: { turnId: 'B-evidence-turn', conversationId: 'provider-B',
        startedAt: now - 7_000, notified: false, released: true,
        decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
    const base = toolCall(1, 'exact-B-core-result') as Extract<SessionEvent, { kind: 'tool_call' }>;
    const currentTool: SessionEvent = { ...base, seq: scenario.toolAfterError ? 3 : 1,
      time: scenario.toolAfterError ? now - 2_000 : now - 5_000,
      turnId: 'B-evidence-turn',
      call: { ...base.call, conversationId: 'provider-B', attributionMethod: 'request_id',
        summary: { kind: 'read', title: 'Request-attributed provider B Core work', tone: 'neutral' } } };
    const currentError: SessionEvent = { kind: 'chat_error', seq: 2,
      time: scenario.toolAfterError ? now - 4_000 : now - 2_000,
      source: 'extension', turnId: 'B-evidence-turn', reason: scenario.reason,
      recoverable: scenario.state === 'recovering', blocking: scenario.state === 'blocked',
      message: text(scenario.text) };
    const lateAError: SessionEvent = { kind: 'chat_error', seq: 4, time: now - 500,
      source: 'extension', turnId: 'historical-A-turn', reason: 'model_cooldown',
      blocking: true, message: text('Late provider A error: historical access problem') };
    const automation: AutomationSupervisorSnapshot = { observedAt: now, targetLanes: 1,
      counts: { working: 0, 'waiting-main': 0, 'waiting-workers': 0,
        recovering: scenario.state === 'recovering' ? 1 : 0,
        stalled: 0, paused: 0, blocked: scenario.state === 'blocked' ? 1 : 0 },
      chats: [{ sessionId: owner.id, conversationId: 'provider-B', title: owner.title,
        mode: 'loop', state: scenario.state, reason: 'B current provider status is authoritative.',
        nextAction: 'Keep existing owner; inspect actual current B evidence.',
        nextRetryAt: null, lastWorkedAt: now - 1_000, activeWorkers: 0,
        recoverable: scenario.state === 'recovering', spinning: false,
        recoveryStage: scenario.state === 'recovering' ? 'waiting-browser' : null }]
    };
    const app = await boot([], true, [], [], { sessions: [owner], automation,
      sessionEvents: { [owner.id]: [currentTool, currentError, lateAError] } });
    const doc = app.w.document;
    doc.querySelector<HTMLButtonElement>(
      `.work-overview-section[data-work-section="current"] [data-session-id="${owner.id}"]`)!.click();
    await settle();
    const pane = doc.getElementById('workOverviewPane')!;
    const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
      .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
    expect(field('Provider evidence')).toContain(scenario.text);
    expect(field('Provider evidence')).not.toContain('Late provider A error');
    expect(field('Current status')).toContain(scenario.state === 'blocked' ? 'blocked' : 'waiting for Chrome');
    if (scenario.state === 'blocked') {
      expect(field('Just did')).toContain(`Provider error recorded: ${scenario.text}`);
    } else {
      expect(field('Page & Core evidence')).toContain('Core work recorded after page interruption');
      expect(field('Page & Core evidence')).toContain('page recovery unverified');
      expect(field('Just did')).toContain('Request-attributed provider B Core work');
    }
    const history = pane.querySelector('.work-overview-history')?.textContent ?? '';
    expect(history).toContain('Provider error recorded');
    expect(history).toContain('current provider association unverified');
    expect(app.live.sent).toEqual([]);
    expect(app.live.controlCalls).toEqual([]);
  }
);

it.each([false, true])(
  'distinguishes a saved worker report from B current work after an A to B rebind (exact B report turn: %s)',
  async boundToB => {
    const now = Date.now();
    const prime = { ...summary([]), id: 'worker-report-prime-owner',
      title: 'Owning Prime waiting for exact worker receipt' };
    const worker: SessionSummary = { ...summary([]),
      id: `worker-report-provider-bound-${boundToB}`,
      title: 'Worker report after previous provider activity',
      conversationId: 'provider-B', chatIds: ['provider-A', 'provider-B'],
      origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-1',
        task: 'Check retained source evidence' },
      lastFinishReportAt: now - 500, lastToolCallAt: now - 5_000,
      activeTurnId: null, lastTurnOutcome: 'failed', lastTurnEndAt: now - 1_000,
      finishTurn: { turnId: 'B-current-worker-turn', conversationId: 'provider-B',
        startedAt: now - 7_000, notified: false, released: true,
        decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
    const base = toolCall(1, 'current-worker-B-tool') as Extract<SessionEvent, { kind: 'tool_call' }>;
    const currentTool: SessionEvent = { ...base, time: now - 5_000,
      turnId: 'B-current-worker-turn',
      call: { ...base.call, conversationId: 'provider-B', attributionMethod: 'request_id',
        summary: { kind: 'read', title: 'B current Core outcome', tone: 'neutral' } } };
    const error: SessionEvent = { kind: 'chat_error', seq: 2, time: now - 2_000,
      source: 'extension', turnId: 'B-current-worker-turn', reason: 'model_cooldown',
      blocking: true, message: text('Provider B failed after current work') };
    const report: SessionEvent = { kind: 'agent_message', seq: 3, time: now - 500,
      source: 'app', agent: 'worker-1', from: 'worker-1', to: 'prime', delivery: 'sent',
      messageId: `retained-worker-report-${boundToB}`,
      ...(boundToB ? { turnId: 'B-current-worker-turn' } : {}),
      message: text('[worker-1 finished] RESULT: Durable report retained even after a later provider failure.\nBLOCKERS: Historical review needs source attribution.') };
    const automation: AutomationSupervisorSnapshot = { observedAt: now, targetLanes: 1,
      counts: { working: 0, 'waiting-main': 0, 'waiting-workers': 0,
        recovering: 0, stalled: 0, paused: 0, blocked: 1 },
      chats: [{ sessionId: worker.id, conversationId: 'provider-B', title: worker.title,
        mode: 'goal', state: 'blocked', reason: 'Current B worker provider failed.',
        nextAction: 'Inspect the exact provider B error and retained report.',
        lastWorkedAt: now - 1_000, nextRetryAt: null, activeWorkers: 0, recoverable: false,
        spinning: false, recoveryStage: null }]
    };
    const app = await boot([], true, [], [], { sessions: [prime, worker], automation,
      sessionEvents: { [worker.id]: [currentTool, error, report] } });
    const doc = app.w.document;
    doc.querySelector<HTMLButtonElement>(`.work-overview-row[data-session-id="${worker.id}"]`)!.click();
    await settle();
    const pane = doc.getElementById('workOverviewPane')!;
    const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
      .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
    expect(field('Provider evidence')).toContain('Provider B failed after current work');
    expect(field('Current status')).toContain('blocked');
    if (boundToB) {
      expect(field('Just did')).toContain('Worker report saved for Prime');
      expect(pane.querySelector('.work-overview-result > summary')?.textContent)
        .toBe('Read saved worker report');
    } else {
      expect(field('Just did')).toContain('Provider error recorded: Provider B failed after current work');
      expect(field('Next / blocker')).not.toContain('Historical review needs source attribution');
      expect(pane.querySelector('.work-overview-result > summary')?.textContent)
        .toBe('Read previous saved worker report');
      expect(pane.querySelector('.work-overview-history')?.textContent)
        .toContain('worker report · provider association unverified');
    }
    expect(pane.querySelector('.work-overview-result')?.textContent)
      .toContain('Durable report retained even after a later provider failure');
    expect(field('Prime receipt')).not.toContain('confirmed');
    if (boundToB) expect(field('Prime receipt')).not.toContain('not attributed to the current provider turn');
    else {
      expect(field('Prime receipt')).toContain('not attributed to the current provider turn');
      expect(doc.getElementById('workOverviewAnnouncement')?.textContent)
        .toContain('current provider association unverified');
    }
    expect(app.live.sent).toEqual([]);
    expect(app.live.controlCalls).toEqual([]);
  }
);

it.each([false, true])(
  'keeps exact B worker result and Prime receipt when later historical A report arrives (A has turn: %s)',
  async historicalTurn => {
    const now = Date.now();
    const prime = { ...summary([]), id: 'mixed-worker-prime', title: 'Prime with exact B report receipt',
      conversationId: 'prime-B', chatIds: ['prime-B'] };
    const worker: SessionSummary = { ...summary([]), id: 'mixed-worker-report-owner',
      title: 'Worker with two retained provider reports',
      conversationId: 'provider-B', chatIds: ['provider-A', 'provider-B'],
      origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-1', task: 'Status review' },
      activeTurnId: null, lastTurnEndAt: now - 1_000, lastTurnOutcome: 'completed',
      lastFinishReportAt: now - 3_000,
      finishTurn: { turnId: 'B-finished-worker-turn', conversationId: 'provider-B',
        startedAt: now - 7_000, notified: false, released: true,
        decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
    const current: SessionEvent = { kind: 'agent_message', seq: 3, time: now - 3_000,
      source: 'app', agent: 'worker-1', from: 'worker-1', to: 'prime', delivery: 'sent',
      turnId: 'B-finished-worker-turn', messageId: 'current-B-report',
      message: text('[worker-1 finished] RESULT: Exact provider B validated output.\nNEXT: Review current provider result.') };
    const historical: SessionEvent = { kind: 'agent_message', seq: 4, time: now - 500,
      source: 'app', agent: 'worker-1', from: 'worker-1', to: 'prime', delivery: 'sent',
      ...(historicalTurn ? { turnId: 'A-previous-worker-turn' } : {}),
      messageId: 'late-A-report',
      message: text('[worker-1 finished] RESULT: Delayed previous-provider A output, still readable.') };
    const receipt: SessionEvent = { ...current, seq: 5, time: now - 2_000, agent: 'prime',
      delivery: 'delivered' };
    const app = await boot([], true, [], [], { sessions: [prime, worker],
      sessionEvents: { [prime.id]: [receipt], [worker.id]: [
        { kind: 'turn_start', seq: 1, time: now - 7_000, source: 'extension',
          turnId: 'B-finished-worker-turn' },
        { kind: 'turn_end', seq: 2, time: now - 1_000, source: 'extension',
          turnId: 'B-finished-worker-turn', outcome: 'completed' },
        current, historical
      ] } });
    const doc = app.w.document;
    doc.querySelector<HTMLButtonElement>(
      '.work-overview-section[data-work-section="updates"] [data-session-id="' + worker.id + '"]')!.click();
    await settle();
    const pane = doc.getElementById('workOverviewPane')!;
    const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
      .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
    expect(field('Just did')).toContain('Exact provider B validated output');
    expect(field('Just did')).not.toContain('Delayed previous-provider A');
    expect(pane.querySelector('.work-overview-result > summary')?.textContent)
      .toBe('Read saved worker report');
    expect(pane.querySelector('.work-overview-result')?.textContent)
      .toContain('Exact provider B validated output');
    const historicalResult = pane.querySelector<HTMLDetailsElement>('.work-overview-historical-worker-result');
    expect(historicalResult?.querySelector('summary')?.textContent)
      .toContain('Read historical worker report');
    expect(historicalResult?.textContent).toContain('Delayed previous-provider A output');
    historicalResult!.open = true;
    app.notifySession();
    await settle();
    expect(pane.querySelector('.work-overview-historical-worker-result')).toBe(historicalResult);
    expect(historicalResult!.open).toBe(true);
    expect(field('Prime receipt')).toContain('Prime received this report');
    expect(pane.querySelector('.work-overview-history')?.textContent)
      .toContain('provider association unverified');
    expect(pane.querySelector('.work-overview-history')?.textContent)
      .toContain('Worker finish report saved · exact Prime receipt confirmed');
    expect(app.live.sent).toEqual([]);
    expect(app.live.controlCalls).toEqual([]);
  }
);

it('distinguishes an interrupted provider page from a later exact Core call in the same B turn', async () => {
  const now = Date.now();
  const owner: SessionSummary = { ...summary([]), id: 'interrupted-provider-B-continued-core',
    title: 'Page interrupted; local work continued', conversationId: 'provider-B',
    chatIds: ['provider-A', 'provider-B'], lastToolCallAt: now - 1_000 };
  const error: SessionEvent = { kind: 'chat_error', seq: 1, time: now - 3_000,
    source: 'extension', turnId: 'current-provider-B-turn', reason: 'stream_gone',
    recoverable: true, message: text('Connection interrupted; page unavailable') };
  const base = toolCall(2, 'current-provider-B-core') as Extract<SessionEvent, { kind: 'tool_call' }>;
  const current: SessionEvent = { ...base, time: now - 1_000, turnId: 'current-provider-B-turn',
    call: { ...base.call, conversationId: 'provider-B', attributionMethod: 'request_id',
      summary: { kind: 'read', title: 'Exact B Core work after page interruption', tone: 'neutral' } } };
  const automation: AutomationSupervisorSnapshot = { observedAt: now, targetLanes: 1,
    counts: { working: 0, 'waiting-main': 0, 'waiting-workers': 0,
      recovering: 1, stalled: 0, paused: 0, blocked: 0 },
    chats: [{ sessionId: owner.id, conversationId: 'provider-B', title: owner.title,
      mode: 'loop', state: 'recovering', reason: 'Provider page interrupted.',
      nextAction: 'Wait for the incumbent Chrome recovery owner; do not resend.',
      nextRetryAt: null, lastWorkedAt: now - 1_000, activeWorkers: 0,
      recoverable: true, spinning: false, recoveryStage: 'waiting-browser' }]
  };
  const app = await boot([], true, [], [], { sessions: [owner], automation,
    // A current Loop controls receipt is required before presenting the
    // supervisor's recovery instruction as the present next action.
    controls: { automation: 'loop' },
    sessionEvents: { [owner.id]: [error, current] } });
  const doc = app.w.document;
  doc.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${owner.id}"]`)!.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
  expect(field('Just did')).toContain('Exact B Core work after page interruption');
  expect(field('Page & Core evidence')).toContain('same recorded turn');
  expect(field('Page & Core evidence')).toContain('Core work recorded after page interruption');
  expect(field('Page & Core evidence')).toContain('page recovery unverified');
  expect(field('Current status')).toContain('waiting for Chrome');
  expect(field('Next / blocker')).toContain('do not resend');
  expect(app.live.sent).toEqual([]);
});

it.each(['native row retained', 'outbox receipt only'] as const)(
  'keeps an earlier provider native Send historical after B is current (%s)', async evidenceKind => {
    const now = Date.now();
    const owner: SessionSummary = { ...summary([]), id: `prior-native-delivery-${evidenceKind.replaceAll(' ', '-')}`,
      title: 'Resumed task with old native Send history', conversationId: 'provider-B',
      chatIds: ['provider-A', 'provider-B'], lastToolCallAt: now - 1_000 };
    const nativeA: SessionEvent = { kind: 'user_message', seq: 1, time: now - 6_000,
      source: 'extension', turnId: 'original-provider-A-turn',
      messageId: 'old-native-provider-A-send', inputId: 'old-provider-A-input',
      inputDelivery: 'confirmed', message: text('Earlier A instruction already sent') };
    const core = toolCall(2, 'proved-current-B-tool') as Extract<SessionEvent, { kind: 'tool_call' }>;
    const provedB: SessionEvent = { ...core, time: now - 1_000, turnId: 'provider-B-turn',
      call: { ...core.call, conversationId: 'provider-B', attributionMethod: 'request_id',
        summary: { kind: 'read', title: 'Proved provider B useful read', tone: 'neutral' } } };
    const outbox: InputEntry = {
      id: 'old-provider-A-input', sessionId: owner.id, conversationId: 'provider-A',
      mode: 'auto', text: 'Earlier A instruction', model: 'gpt-6-thinking',
      reasoningEffort: 'xhigh', dueAt: 0, state: 'cancelled',
      createdAt: now - 7_000, deliveredAt: now - 6_000,
      messageId: 'old-native-provider-A-send', owner: 'previous-provider-A-tab'
    };
    const automation: AutomationSupervisorSnapshot = { observedAt: now, targetLanes: 1,
      counts: { working: 0, 'waiting-main': 1, 'waiting-workers': 0, recovering: 0,
        stalled: 0, paused: 0, blocked: 0 },
      chats: [{ sessionId: owner.id, conversationId: 'provider-B', title: owner.title, mode: 'loop',
        state: 'waiting-main', reason: 'Current B between turns.', nextAction: 'Keep saved receipts.',
        nextRetryAt: null, lastWorkedAt: now - 1_000, activeWorkers: 0, recoverable: false,
        spinning: false, recoveryStage: null }]
    };
    const events = evidenceKind === 'native row retained' ? [nativeA, provedB] : [provedB];
    const app = await boot([], true, [], [], { sessions: [owner], automation,
      sessionEvents: { [owner.id]: events }, inputs: [outbox] });
    const doc = app.w.document;
    doc.querySelector<HTMLButtonElement>(
      `.work-overview-section[data-work-section="current"] [data-session-id="${owner.id}"]`)!.click();
    await settle();
    const pane = doc.getElementById('workOverviewPane')!;
    const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
      .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
    expect(field('Just did')).toContain('Proved provider B useful read');
    expect(field('Native delivery & answer')).toContain('old-provider-A-input');
    expect(field('Native delivery & answer')).toContain('previous provider conversation or an unbound provider');
    expect(field('Native delivery & answer')).toContain('does not prove a native Send or answer for the current provider');
    expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Previous-provider Native Send');
    expect(app.live.sent).toEqual([]);
    expect(app.live.controlCalls).toEqual([]);
  }
);

it('does not keep Stop or prior Loop tool wait after the selected local session changes its provider binding', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), id: 'selected-provider-stop-rebind',
    title: 'Same local work, new browser conversation', conversationId: 'native-conversation-A',
    chatIds: ['native-conversation-A'], activeTurnId: 'old-provider-turn-A',
    lastToolCallAt: now - 100, activityExpiresAt: now + 60_000 };
  const old: SessionEvent = { kind: 'turn_start', seq: 1, time: now - 2000,
    source: 'extension', turnId: 'old-provider-turn-A' };
  const controls = { conversationId: row.conversationId, automation: 'loop',
    activeTurnId: 'old-provider-turn-A' as string | null, canInject: true,
    goalWait: { reason: 'tools' as const, detail: 'Old provider tool is still running.',
      nextAction: 'Wait for the old conversation.' } as object | null };
  const app = await boot([old], true, [], [], {
    sessions: [row], controls, sessionEvents: { [row.id]: [old] }
  });
  const doc = app.w.document;
  const send = doc.getElementById('chatSend') as HTMLButtonElement;
  expect(send.dataset.action).toBe('stop');
  const api = (app.w as any).api;
  const originalControls = api.getSessionControls;
  let activeResponse = controls;
  api.getSessionControls = (id: string) =>
    originalControls(id).then((reply: { ok: boolean; data: object }) => ({ ...reply,
      data: { ...reply.data, ...activeResponse } }));
  const stops = vi.fn(async () => ({ ok: true, data: true }));
  api.stopSessionTurn = stops;

  const next: SessionSummary = { ...row,
    conversationId: 'native-conversation-B',
    chatIds: [...row.chatIds, 'native-conversation-B'],
    activeTurnId: null, lastTurnEndAt: now - 100, lastTurnOutcome: 'completed',
    updatedAt: now + 1000
  };
  await app.replaceSessions([next]);
  expect(send.dataset.action).not.toBe('stop');
  expect(doc.getElementById('goalLifecycle')?.textContent).not.toContain('Old provider tool is still running.');
  expect(doc.getElementById('chatState')?.textContent).not.toContain('Working for');
  expect(doc.getElementById('chatState')?.textContent).not.toContain('Old provider tool');
  expect(doc.querySelector('#sessionList .sess-automation-state')?.textContent ?? '').not.toContain('working');
  send.click();
  await settle();
  expect(stops).not.toHaveBeenCalled();
  expect(app.live.sent).toEqual([]);

  activeResponse = { ...controls, conversationId: next.conversationId!,
    activeTurnId: 'new-provider-turn-B', goalWait: null };
  next.activeTurnId = 'new-provider-turn-B';
  app.notifySession();
  await settle(700);
  expect(send.dataset.action).toBe('stop');
  expect(doc.getElementById('goalLifecycle')?.textContent).not.toContain('Old provider tool is still running.');
  expect(stops).not.toHaveBeenCalled();
});

it('keeps an older final historical after a later source-recorded stalled turn has ended without work', async () => {
  // Read-only October 9 historical custody found this precise source shape twice:
  // local sessions 2026-10-08-1cbf57b3 (422 tool, 429 final, 433 start,
  // 436 stalled end) and 2026-10-08-47231cde (451 tool, 487 final,
  // 491 start, 495 stalled end). Never copy their authored/private text.
  const row: SessionSummary = { ...summary([]), id: 'stalled-after-prior-success',
    title: 'Saved final before a later stalled generation', conversationId: 'recorded-chat',
    chatIds: ['recorded-chat'], lastTurnOutcome: 'stalled', activeTurnId: null,
    lastAssistantFinalAt: T0 + 29_000, lastToolCallAt: T0 + 22_000,
    lastTurnEndAt: T0 + 36_000, lastMessageAt: T0 + 36_000 };
  const oldTool = toolCall(422, 'old-recorded-tool') as Extract<SessionEvent, { kind: 'tool_call' }>;
  oldTool.time = T0 + 22_000; oldTool.turnId = 'old-completed-turn';
  const oldFinal: SessionEvent = { kind: 'assistant_message', seq: 429, time: T0 + 29_000,
    source: 'extension', turnId: 'old-completed-turn', final: true,
    messageId: 'older-recorded-final', message: text('Previous verified output. VALIDATION: earlier turn only.') };
  const source: SessionEvent[] = [
    oldTool, oldFinal,
    { kind: 'turn_start', seq: 433, time: T0 + 33_000, source: 'extension',
      turnId: 'new-stalled-turn' },
    { kind: 'turn_end', seq: 436, time: T0 + 36_000, source: 'extension',
      turnId: 'new-stalled-turn', outcome: 'stalled' }
  ];
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0 + 36_000, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0,
      stalled: 1, paused: 0, blocked: 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: 'stalled', reason: 'No progress after the previous recorded final.',
      nextAction: 'Inspect and deliberately recover the stalled generation.',
      nextRetryAt: null, lastWorkedAt: T0 + 36_000, activeWorkers: 0,
      recoverable: false, spinning: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation,
    // This explicitly active Loop remains enabled in the exact controls. The
    // generic boot fixture otherwise defaults to Off and correctly supersedes
    // older stalled-supervisor next actions.
    controls: { automation: 'loop' },
    sessionEvents: { [row.id]: source } });
  app.w.document.querySelector<HTMLButtonElement>(
    '.work-overview-section[data-work-section="current"] .work-overview-row')!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = () => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid()).toContain('Latest turn stalled');
  expect(justDid()).toContain('no exact final or tool outcome');
  expect(justDid()).not.toContain('Recorded final: Previous verified output.');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read previous recorded final answer');
  expect(pane.textContent).toContain('VALIDATION: earlier turn only.');
  expect(pane.textContent).toContain('deliberately recover the stalled generation.');
  expect(app.live.controlCalls).toEqual([]);

  // After actual new work, the current turn's own result wins immediately,
  // without reclassifying the old final or manufacturing a provider Send.
  source.push({ kind: 'turn_start', seq: 440, time: T0 + 40_000,
    source: 'extension', turnId: 'recovered-turn' });
  source.push({ kind: 'assistant_message', seq: 441, time: T0 + 41_000,
    source: 'extension', turnId: 'recovered-turn', messageId: 'recovered-final',
    final: true, message: text('Recovered generation has its own exact final.') });
  await app.replaceSessions([{ ...row, activeTurnId: 'recovered-turn',
    lastAssistantFinalAt: T0 + 41_000, updatedAt: T0 + 41_000 }]);
  expect(justDid()).toContain('Recorded final: Recovered generation has its own exact final.');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read recorded final answer');
  expect(app.live.controlCalls).toEqual([]);
});

it('does not demote a final when a recovery reopens the same exact native turn ID', async () => {
  const row: SessionSummary = { ...summary([]), id: 'same-native-turn-reopened',
    title: 'Native turn reobserved', conversationId: 'reobserved-chat',
    chatIds: ['reobserved-chat'], activeTurnId: 'same-native-turn',
    fileEdits: 1, lastFileChangeAt: T0 + 6_000, lastToolCallAt: T0 + 6_000,
    lastAssistantFinalAt: T0 + 8_000 };
  const source: SessionEvent[] = [
    { kind: 'turn_start', seq: 1, time: T0 + 1_000, source: 'extension',
      turnId: 'same-native-turn' },
    { ...toolCall(2, 'same-turn-tool'), time: T0 + 6_000, turnId: 'same-native-turn' },
    { kind: 'assistant_message', seq: 3, time: T0 + 8_000, source: 'extension',
      turnId: 'same-native-turn', messageId: 'same-turn-final',
      final: true, message: text('The same exact turn retains its final.') },
    { kind: 'turn_start', seq: 4, time: T0 + 9_000, source: 'app',
      turnId: 'same-native-turn' }
  ];
  const app = await boot([], true, [], [], { sessions: [row],
    sessionEvents: { [row.id]: source } });
  app.w.document.querySelector<HTMLButtonElement>(
    '.work-overview-section[data-work-section="updates"] .work-overview-row')!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.querySelector('.work-overview-pane-field')?.textContent)
    .toContain('Recorded final: The same exact turn retains its final.');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read recorded final answer');
  expect(pane.textContent).not.toContain('New turn started; no exact final');
});

it.each([
  ['failed', 'failed with a visible error'],
  ['interrupted', 'interrupted before it finished'],
  ['stopped', 'stopped by the user'],
  ['unknown', 'ended for an unknown reason']
  ] as const)('keeps a previous final historical after a newer %s turn without an outcome', async (outcome, label) => {
    const row: SessionSummary = { ...summary([]), id: 'ended-without-result',
      title: 'Earlier completed work and newer no-result turn', conversationId: 'ended-conversation',
      chatIds: ['ended-conversation'], activeTurnId: null, lastTurnOutcome: outcome,
      fileEdits: 1, lastFileChangeAt: T0 + 3_000, lastToolCallAt: T0 + 2_000,
      lastAssistantFinalAt: T0 + 4_000, lastTurnEndAt: T0 + 8_000,
      finishTurn: { turnId: 'newer-ended-turn', conversationId: 'ended-conversation',
        startedAt: T0 + 7_000, notified: false, released: true,
        decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const source: SessionEvent[] = [
    { ...toolCall(2, 'prior-work'), turnId: 'prior-turn' },
    { kind: 'assistant_message', seq: 3, time: T0 + 4_000, source: 'extension',
      turnId: 'prior-turn', messageId: 'previous-final',
      final: true, message: text('Earlier successful output; not the latest turn.') },
    { kind: 'turn_start', seq: 4, time: T0 + 7_000, source: 'extension',
      turnId: 'newer-ended-turn' },
    { kind: 'turn_end', seq: 5, time: T0 + 8_000, source: 'extension',
      turnId: 'newer-ended-turn', outcome }
  ];
  const app = await boot([], true, [], [], { sessions: [row],
    sessionEvents: { [row.id]: source } });
  const update = app.w.document.querySelector<HTMLButtonElement>(
    '.work-overview-section[data-work-section="updates"] .work-overview-row')!;
  expect(update.textContent).toContain('Previous final retained');
  expect(update.textContent).not.toContain('Final answer recorded');
  update.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')!.textContent ?? '';
  expect(justDid).toContain(`Latest turn ${label}`);
  expect(justDid).not.toContain('Recorded final: Earlier successful output');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read previous recorded final answer');
  expect(app.live.controlCalls).toEqual([]);
});

it('shows a reused worker report as previous until that worker finishes the newly started turn', async () => {
  const worker: SessionSummary = { ...summary([]), id: 'reused-worker-chat',
    title: 'Reusable worker', conversationId: 'reused-worker-provider',
    chatIds: ['reused-worker-provider'],
    origin: { kind: 'worker', fromSessionId: 'owning-prime-chat', agentId: 'worker-1', task: 'Review source' },
    lastFinishReportAt: T0 + 4_000, lastToolCallAt: T0 + 2_000,
    activeTurnId: 'new-worker-turn' };
  const report = (seq: number, messageId: string, body: string): SessionEvent => ({
    kind: 'agent_message', seq, time: T0 + seq * 1000, source: 'app', agent: 'worker-1',
    messageId, from: 'worker-1', to: 'prime', delivery: 'sent',
    message: text(`[worker-1 reported] RESULT: ${body}`)
  });
  const events: SessionEvent[] = [
    { kind: 'turn_start', seq: 1, time: T0 + 1_000, source: 'extension', turnId: 'previous-worker-turn' },
    toolCall(2, 'worker-first-result'),
    report(4, 'previous-worker-finish', 'Previously completed analysis.'),
    { kind: 'turn_start', seq: 5, time: T0 + 5_000, source: 'extension', turnId: 'new-worker-turn' }
  ];
  const app = await boot([], true, [], [], {
    sessions: [worker], sessionEvents: { [worker.id]: events }
  });
  const row = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] .work-overview-row[data-session-id="${worker.id}"]`)!;
  row.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.querySelector('.work-overview-pane-field')?.textContent)
    .toContain('no exact current-turn final or tool outcome yet.');
  expect(pane.querySelector('.work-overview-result summary')?.textContent).toBe('Read previous saved worker report');
  expect(pane.textContent).toContain('Previously completed analysis.');
  expect(pane.textContent).toContain('Prime receipt unavailable');

  const rejected = toolCall(6, 'new-worker-read-failed') as Extract<SessionEvent, { kind: 'tool_call' }>;
  rejected.turnId = 'new-worker-turn';
  rejected.call.outcome = 'tool_rejected';
  rejected.call.summary = { kind: 'read', title: 'Worker new-turn read was rejected', tone: 'bad' };
  events.push(rejected);
  await app.replaceSessions([{ ...worker, lastToolCallAt: T0 + 6_000 }]);
  const failedJustDid = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(failedJustDid).toContain('Rejected');
  expect(failedJustDid).toContain('Worker new-turn read was rejected');
  expect(failedJustDid).not.toContain('Previously completed analysis.');
  expect(pane.querySelector('.work-overview-result summary')?.textContent).toBe('Read previous saved worker report');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Previously completed analysis.');
  expect(pane.textContent).not.toContain('Prime received this report');

  events.push(report(7, 'current-worker-finish', 'Finished current turn with new evidence.'));
  await app.replaceSessions([{ ...worker, lastToolCallAt: T0 + 6_000, lastFinishReportAt: T0 + 7_000 }]);
  expect(pane.querySelector('.work-overview-pane-field')?.textContent)
    .toContain('Worker report saved for Prime: RESULT: Finished current turn with new evidence.');
  expect(pane.querySelector('.work-overview-result summary')?.textContent).toBe('Read saved worker report');
  expect(pane.textContent).not.toContain('Prime received');
});

it('keeps an untagged A worker report historical when B is active but B turn-start has paged out', async () => {
  const now = Date.now();
  const worker: SessionSummary = { ...summary([]), id: 'worker-unbound-report-B-open',
    title: 'Worker B running after archived A report',
    conversationId: 'same-provider-worker-A-B', chatIds: ['same-provider-worker-A-B'],
    origin: { kind: 'worker', fromSessionId: 'unchanged-prime-owner',
      agentId: 'worker-1', task: 'Continue the original review' },
    activeTurnId: 'B-active-worker-turn', lastFinishReportAt: now - 12_000,
    lastToolCallAt: now - 24_000, lastMessageAt: now - 800, updatedAt: now,
    activityExpiresAt: now - 100 };
  // The bounded Work read retained A's saved report, not B's turn_start.
  // Its lack of turnId is not evidence that it came from B.
  const prior: SessionEvent = { kind: 'agent_message', seq: 3, time: now - 12_000,
    source: 'app', agent: 'worker-1', from: 'worker-1', to: 'prime', delivery: 'sent',
    messageId: 'earlier-A-worker-report',
    message: text('[worker-1 finished] RESULT: Retained older A worker output.\nNEXT: Historical A action, not B next step.') };
  const events: SessionEvent[] = [prior];
  const app = await boot([], true, [], [], { sessions: [worker],
    sessionEvents: { [worker.id]: events },
    controls: { conversationId: worker.conversationId, activeTurnId: 'B-active-worker-turn' } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${worker.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
  expect(field('Just did')).toContain('no exact current-turn final or tool outcome');
  expect(field('Just did')).not.toContain('Worker report saved for Prime');
  expect(field('Next / blocker')).not.toContain('Historical A action');
  expect(pane.querySelector('.work-overview-result > summary')?.textContent)
    .toBe('Read previous saved worker report');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Retained older A worker output');
  expect(field('Prime receipt')).toContain('not attributed to the current');
  expect(pane.querySelector('.work-overview-history')?.textContent).toContain('current turn association unverified');
  expect(app.w.document.getElementById('workOverviewAnnouncement')?.textContent)
    .toContain('current turn association unverified');
  // An actual B-tagged worker report may become B's current result without
  // claiming a Prime ACK or replaying A's native input.
  const current: SessionEvent = { ...prior, seq: 9, time: now - 400,
    turnId: 'B-active-worker-turn', messageId: 'verified-current-B-report',
    message: text('[worker-1 finished] RESULT: Exact B worker result now saved.\nNEXT: Inspect B evidence.') };
  events.push(current);
  await app.replaceSessions([{ ...worker, lastFinishReportAt: now - 400, updatedAt: now + 100 }]);
  expect(field('Just did')).toContain('Worker report saved for Prime: RESULT: Exact B worker result now saved');
  expect(pane.querySelector('.work-overview-result > summary')?.textContent).toBe('Read saved worker report');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Exact B worker result now saved');
  expect(field('Prime receipt')).not.toContain('Prime received this report');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('keeps a saved worker report historical when a newer exact turn rejects a tool despite reversed timestamps', async () => {
  const worker: SessionSummary = { ...summary([]), id: 'worker-new-turn-clock-skew',
    title: 'Worker later failure', conversationId: 'worker-clock-skew-provider',
    chatIds: ['worker-clock-skew-provider'],
    origin: { kind: 'worker', fromSessionId: 'worker-clock-skew-prime', agentId: 'worker-1', task: 'Review' },
    lastFinishReportAt: T0 + 60_000, lastToolCallAt: T0 + 55_000,
    lastTurnEndAt: T0 + 70_000, lastTurnOutcome: 'failed',
    finishTurn: { turnId: 'newer-worker-turn', conversationId: 'worker-clock-skew-provider',
      startedAt: T0 + 65_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const report: SessionEvent = { kind: 'agent_message', seq: 3, time: T0 + 60_000,
    source: 'app', agent: 'worker-1', messageId: 'prior-worker-report', from: 'worker-1', to: 'prime',
    delivery: 'sent', message: text('[worker-1 finished] RESULT: Previous verified worker output.') };
  const failed = toolCall(6, 'later-worker-tool-failed') as Extract<SessionEvent, { kind: 'tool_call' }>;
  failed.time = T0 + 55_000; // Started earlier on a different clock; its exact turn identity wins.
  failed.turnId = 'newer-worker-turn';
  failed.call.outcome = 'tool_rejected';
  failed.call.summary = { kind: 'read', title: 'Later worker read rejected', tone: 'bad' };
  const events: SessionEvent[] = [report,
    { kind: 'turn_start', seq: 5, time: T0 + 65_000, source: 'extension', turnId: 'newer-worker-turn' },
    failed];
  const app = await boot([], true, [], [], { sessions: [worker], sessionEvents: { [worker.id]: events } });
  const row = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${worker.id}"]`)!;
  expect(row.textContent).toContain('Previous worker report retained');
  row.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid).toContain('Rejected');
  expect(justDid).toContain('Later worker read rejected');
  expect(justDid).not.toContain('Previous verified worker output');
  expect(pane.querySelector('.work-overview-result summary')?.textContent).toBe('Read previous saved worker report');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Previous verified worker output');
  expect(pane.textContent).not.toContain('Prime received this report');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('keeps an ordinary exact same-turn rejected tool ahead of a later terminal timestamp', async () => {
  const row: SessionSummary = { ...summary([]), id: 'ordinary-failed-turn-exact-tool',
    title: 'Rejected exact ordinary Core work', conversationId: 'ordinary-last-tool-provider',
    chatIds: ['ordinary-last-tool-provider'], lastToolCallAt: T0 + 55_000,
    lastTurnEndAt: T0 + 70_000, lastTurnOutcome: 'failed', activeTurnId: null,
    finishTurn: { turnId: 'ordinary-latest-turn', conversationId: 'ordinary-last-tool-provider',
      startedAt: T0 + 65_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const rejected = toolCall(6, 'ordinary-same-turn-rejected') as Extract<SessionEvent, { kind: 'tool_call' }>;
  rejected.time = T0 + 55_000;
  rejected.turnId = 'ordinary-latest-turn';
  rejected.call.outcome = 'tool_rejected';
  rejected.call.summary = { kind: 'read', title: 'Exact ordinary tool rejected', tone: 'bad' };
  const events: SessionEvent[] = [
    { kind: 'turn_start', source: 'extension', seq: 5, time: T0 + 65_000,
      turnId: 'ordinary-latest-turn' },
    rejected
  ];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events } });
  app.w.document.querySelector<HTMLButtonElement>(
    `[data-work-section="older"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const headline = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(headline).toContain('Rejected');
  expect(headline).toContain('Exact ordinary tool rejected');
  expect(headline).not.toContain('Last recorded turn failed');
  expect(pane.textContent).toContain('Last turn failed');
  expect(app.live.sent).toEqual([]);
});

it('keeps a worker report current when the same turn reopens and an earlier tool finishes late', async () => {
  const worker: SessionSummary = { ...summary([]), id: 'worker-reopened-old-tool',
    title: 'Reopened worker', conversationId: 'worker-reopened-provider', chatIds: ['worker-reopened-provider'],
    origin: { kind: 'worker', fromSessionId: 'worker-reopened-prime', agentId: 'worker-1', task: 'Review' },
    lastFinishReportAt: T0 + 60_000, lastToolCallAt: T0 + 55_000,
    activeTurnId: 'same-worker-turn',
    finishTurn: { turnId: 'same-worker-turn', conversationId: 'worker-reopened-provider',
      startedAt: T0 + 40_000, notified: false, released: false,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const report: SessionEvent = { kind: 'agent_message', seq: 3, time: T0 + 60_000,
    source: 'app', agent: 'worker-1', messageId: 'same-turn-worker-report', from: 'worker-1', to: 'prime',
    delivery: 'sent', message: text('[worker-1 finished] RESULT: Latest saved worker conclusion.') };
  const lateTool = toolCall(6, 'same-turn-old-tool') as Extract<SessionEvent, { kind: 'tool_call' }>;
  lateTool.time = T0 + 55_000;
  lateTool.turnId = 'same-worker-turn';
  lateTool.call.outcome = 'tool_rejected';
  lateTool.call.summary = { kind: 'read', title: 'Earlier tool result arrived late', tone: 'bad' };
  const events: SessionEvent[] = [report,
    { kind: 'turn_start', seq: 5, time: T0 + 65_000, source: 'extension', turnId: 'same-worker-turn' },
    lateTool];
  const app = await boot([], true, [], [], { sessions: [worker], sessionEvents: { [worker.id]: events } });
  const row = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${worker.id}"]`)!;
  expect(row.textContent).toContain('Worker report saved');
  row.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid).toContain('Worker report saved for Prime: RESULT: Latest saved worker conclusion.');
  expect(justDid).not.toContain('Earlier tool result arrived late');
  expect(pane.querySelector('.work-overview-result summary')?.textContent).toBe('Read saved worker report');
  expect(app.live.sent).toEqual([]);
});

it('does not let an older session page erase a newer completed result and its recovery status', async () => {
  // The backend legitimately moves a newly finished chat from page two to page one.
  // The older cursor response was captured before that final and arrives last.
  const firstPage: SessionSummary[] = Array.from({ length: 60 }, (_, i) => ({
    ...summary([]), id: `page-one-${i}`, title: `Archived work ${i}`,
    conversationId: `page-one-chat-${i}`, chatIds: [`page-one-chat-${i}`],
    updatedAt: T0 + (100 - i) * 1_000, lastMessageAt: T0 + (100 - i) * 1_000
  }));
  const oldResult: SessionSummary = { ...summary([]), id: 'late-paginated-final', title: 'Completed after paging',
    conversationId: 'late-paginated-chat', chatIds: ['late-paginated-chat'],
    updatedAt: T0 + 1_000, lastMessageAt: T0 + 1_000, lastToolCallAt: T0 + 1_000 };
  const archive: SessionSummary = { ...summary([]), id: 'newly-visible-archive', title: 'Older useful history',
    conversationId: 'archive-only-chat', chatIds: ['archive-only-chat'], updatedAt: T0 - 8_000 };
  const cursor = { updatedAt: firstPage.at(-1)!.updatedAt, id: firstPage.at(-1)!.id };
  const automaton = (state: 'working' | 'blocked', reason: string): AutomationSupervisorSnapshot => ({
    observedAt: state === 'working' ? T0 + 2_000 : T0 + 210_000, targetLanes: 1,
    counts: { working: state === 'working' ? 1 : 0, blocked: state === 'blocked' ? 1 : 0,
      'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0 },
    chats: [{ sessionId: oldResult.id, conversationId: oldResult.conversationId!, title: oldResult.title,
      mode: 'loop', state, reason, nextAction: state === 'blocked' ? 'Sign in to this account.' : 'Observe current work.',
      nextRetryAt: null, lastWorkedAt: T0 + 2_000, activeWorkers: 0,
      recoverable: false, spinning: state === 'working', recoveryStage: null }]
  });
  const oldSupervisor = automaton('working', 'Previous in-progress observation');
  const liveSupervisor = automaton('working', 'Current in-progress observation');
  const recordedFinal: SessionEvent = { kind: 'assistant_message', seq: 3,
    time: T0 + 203_000, source: 'extension', turnId: 'completed-source', messageId: 'exact-recorded-final',
    final: true, state: 'final', message: text('Finished the actual task; proof saved.') };
  const app = await boot([], true, [], [], { sessions: firstPage, sessionTotal: 62, sessionPageCursor: cursor,
    automation: liveSupervisor, sessionEvents: { [oldResult.id]: [recordedFinal] } });
  let releaseOldPage: (() => void) | undefined;
  const list = (app.w as any).api.listSessions;
  (app.w as any).api.listSessions = (options?: { cursor?: unknown }) => {
    if (!options?.cursor) return list(options);
    return new Promise(resolve => { releaseOldPage = () => resolve({ ok: true, data: {
      sessions: [oldResult, archive], nextCursor: null, total: 62,
      blocked: ['older-blocked-conversation'], pressure: [], workerProgress: [], automation: oldSupervisor
    } }); });
  };
  const scroll = app.w.document.getElementById('sessionList')!.closest('.scroll')!;
  scroll.dispatchEvent(new app.w.Event('scroll'));
  await settle();
  expect(releaseOldPage).toBeTypeOf('function');

  const currentResult: SessionSummary = { ...oldResult, updatedAt: T0 + 205_000,
    lastMessageAt: T0 + 203_000, lastAssistantFinalAt: T0 + 203_000,
    lastTurnEndAt: T0 + 204_000, lastTurnOutcome: 'completed', activeTurnId: null };
  firstPage.splice(0, firstPage.length, currentResult, ...firstPage.slice(0, 59));
  liveSupervisor.chats[0]!.state = 'blocked';
  liveSupervisor.chats[0]!.reason = 'Confirmed access restriction after completion';
  liveSupervisor.chats[0]!.nextAction = 'Sign in to this account.';
  liveSupervisor.counts.working = 0;
  liveSupervisor.counts.blocked = 1;
  app.notifySession();
  await settle(700);
  const updates = app.w.document.querySelector<HTMLElement>('.work-overview-section[data-work-section="updates"]')!;
  expect(updates.querySelector(`[data-session-id="${oldResult.id}"]`)?.textContent ?? '').toContain('Final answer recorded');
  expect(app.w.document.getElementById('workOverviewMeta')!.textContent).toContain('1 blocked');

  releaseOldPage!();
  await settle();
  expect(updates.querySelector(`[data-session-id="${oldResult.id}"]`)?.textContent ?? '').toContain('Final answer recorded');
  expect(app.w.document.getElementById('workOverviewMeta')!.textContent).toContain('1 blocked');
  expect(app.w.document.querySelector(`.sess[data-id="${archive.id}"]`)).not.toBeNull();
  expect(app.w.document.querySelector(`.sess[data-id="${oldResult.id}"]`)?.getAttribute('title'))
    .not.toContain('Previous in-progress observation');
});

it('shows an exact failed tool after an older final in Work & updates and later records a successful retry', async () => {
  const row = { ...summary([]), title: 'Recover tool permission',
    fileEdits: 1, lastFileChangeAt: T0 + 1_000, lastToolCallAt: T0 + 3_000 };
  const first = toolCall(1, 'before-failure') as Extract<SessionEvent, { kind: 'tool_call' }>;
  first.call.summary = { kind: 'edit', title: 'Earlier saved edit', tone: 'good' };
  const final: SessionEvent = {
    kind: 'assistant_message', seq: 2, time: T0 + 2_000, source: 'extension',
    messageId: 'old-final', final: true, message: text('An earlier answer was recorded.')
  };
  const denied = toolCall(3, 'denied') as Extract<SessionEvent, { kind: 'tool_call' }>;
  denied.call.conversationId = row.conversationId;
  denied.call.outcome = 'tool_rejected';
  denied.call.summary = { kind: 'read', title: 'Read current evidence', detail: 'Access denied for this path', tone: 'bad' };
  denied.call.result = text('Sensitive raw tool output should stay outside the summary.');
  const events: SessionEvent[] = [first, final, denied];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events } });
  app.w.document.querySelector<HTMLButtonElement>('.work-overview-row')!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')!;
  expect(justDid.textContent).toContain('Rejected');
  expect(justDid.textContent).toContain('Read current evidence');
  expect(justDid.textContent).not.toContain('Recorded final');
  expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Rejected');
  expect(pane.textContent).toContain('Inspect its recorded error before a new attempt.');
  // Work's scan-friendly summary excludes raw provider text, while the
  // explicit recorded-tool disclosure retains the exact output for review.
  expect(justDid.textContent).not.toContain('Sensitive raw tool output');
  expect(pane.querySelector('.work-overview-history')?.textContent).not.toContain('Sensitive raw tool output');
  const raw = pane.querySelector<HTMLDetailsElement>('.work-overview-tool-result')!;
  expect(raw.open).toBe(false);
  expect(raw.querySelector('.work-overview-result-body')?.textContent).toContain('Sensitive raw tool output');

  const recovered = toolCall(4, 'retry-confirmed') as Extract<SessionEvent, { kind: 'tool_call' }>;
  recovered.call.conversationId = row.conversationId;
  recovered.call.summary = { kind: 'read', title: 'Read recovered evidence', tone: 'good' };
  events.push(recovered);
  app.notifySession();
  await settle(700);
  const latest = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')!;
  expect(latest.textContent).toContain('Read recovered evidence');
  expect(latest.textContent).not.toContain('Rejected');
  expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Rejected');
  expect(pane.textContent).not.toContain('Inspect its recorded error before a new attempt.');
});

it('uses recorded turn chronology when a terminal final was opened before its last tool', async () => {
  const row = { ...summary([]), title: 'Final after late in-turn tool', fileEdits: 1,
    lastFileChangeAt: T0 + 6_000, lastToolCallAt: T0 + 5_000,
    lastAssistantFinalAt: T0 + 2_000, lastTurnEndAt: T0 + 6_000,
    lastTurnOutcome: 'completed' as const };
  const started: SessionEvent = {
    kind: 'turn_start', seq: 1, time: T0 + 1_000, source: 'extension', turnId: 'same-turn'
  };
  const rejected = toolCall(2, 'same-turn-tool') as Extract<SessionEvent, { kind: 'tool_call' }>;
  rejected.call.conversationId = row.conversationId;
  rejected.turnId = 'same-turn';
  rejected.time = T0 + 5_000;
  rejected.call.outcome = 'tool_rejected';
  rejected.call.summary = { kind: 'read', title: 'Earlier rejected tool', tone: 'bad' };
  const final: SessionEvent = {
    kind: 'assistant_message', seq: 3, time: T0 + 2_000, source: 'extension',
    turnId: 'same-turn', messageId: 'terminal-answer', final: true,
    message: text('The final response was recorded after the tool completed.')
  };
  const ended: SessionEvent = {
    kind: 'turn_end', seq: 4, time: T0 + 6_000, source: 'extension',
    turnId: 'same-turn', outcome: 'completed'
  };
  const events: SessionEvent[] = [started, rejected, final, ended];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events } });
  app.w.document.querySelector<HTMLButtonElement>('.work-overview-row')!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = () => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')!.textContent ?? '';
  expect(justDid()).toContain('Recorded final: The final response was recorded');
  expect(justDid()).not.toContain('Earlier rejected tool');
  expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Rejected');
  expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Final answer recorded');
  expect(pane.textContent).not.toContain('Inspect its recorded error before a new attempt.');

  // A genuinely later turn still outranks the older final, even if its tool fails.
  events.push({ kind: 'turn_start', seq: 5, time: T0 + 7_000, source: 'extension', turnId: 'later-turn' });
  const later = toolCall(6, 'later-failure') as Extract<SessionEvent, { kind: 'tool_call' }>;
  later.call.conversationId = row.conversationId;
  later.turnId = 'later-turn';
  later.time = T0 + 8_000;
  later.call.outcome = 'tool_rejected';
  later.call.summary = { kind: 'read', title: 'Newer rejected tool', tone: 'bad' };
  events.push(later);
  app.notifySession();
  await settle(700);
  expect(justDid()).toContain('Rejected');
  expect(justDid()).toContain('Newer rejected tool');
  expect(justDid()).not.toContain('Recorded final');
  expect(pane.textContent).toContain('Inspect its recorded error before a new attempt.');
  // The older result remains worth reading, but it is no longer the current turn's result.
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read previous recorded final answer');
  expect(pane.querySelector('.work-overview-result')?.textContent)
    .toContain('The final response was recorded after the tool completed.');
});

it('keeps an older final historical when a later completed no-output turn has no tool call', async () => {
  const row = { ...summary([]), id: 'completed-no-result-after-prior-final',
    title: 'Previous useful answer, newer empty completed turn',
    conversationId: 'completed-empty-chat', chatIds: ['completed-empty-chat'],
    lastAssistantFinalAt: T0 + 4_000, lastToolCallAt: T0 + 2_000,
    lastTurnOutcome: 'completed' as const, lastTurnEndAt: T0 + 9_000,
    activeTurnId: null, fileEdits: 0,
    finishTurn: { turnId: 'newer-completed-empty', conversationId: 'completed-empty-chat',
      startedAt: T0 + 7_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const final: SessionEvent = { kind: 'assistant_message', seq: 3, time: T0 + 4_000,
    source: 'extension', turnId: 'older-completed-turn', messageId: 'old-useful-answer', final: true,
    message: text('An earlier completed result is still worth reading, but is not current.') };
  const events: SessionEvent[] = [
    { kind: 'turn_start', seq: 1, time: T0 + 1_000, source: 'extension', turnId: 'older-completed-turn' },
    { ...toolCall(2, 'previous-tool'), turnId: 'older-completed-turn' }, final,
    { kind: 'turn_end', seq: 4, time: T0 + 5_000, source: 'extension', turnId: 'older-completed-turn', outcome: 'completed' },
    { kind: 'turn_start', seq: 5, time: T0 + 7_000, source: 'extension', turnId: 'newer-completed-empty' },
    { kind: 'turn_end', seq: 6, time: T0 + 9_000, source: 'extension', turnId: 'newer-completed-empty', outcome: 'completed' }
  ];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events } });
  const update = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] .work-overview-row[data-session-id="${row.id}"]`)!;
  expect(update).toBeTruthy();
  expect(update.textContent).toContain('Previous final retained');
  expect(update.textContent).not.toContain('Final answer recorded');
  update.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')!.textContent ?? '';
  expect(justDid).toContain('Latest turn completed; no exact final or tool outcome recorded.');
  expect(justDid).not.toContain('Recorded final: An earlier completed result');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read previous recorded final answer');
  expect(pane.querySelector('.work-overview-result')?.textContent)
    .toContain('An earlier completed result is still worth reading');
});

it('opens exact Work & updates evidence for a supervised chat beyond the loaded session page', async () => {
  const firstPage = summary([]);
  const held = { ...summary([]), id: 'older-held-loop', title: 'Earlier Loop awaiting sign-in',
    conversationId: 'older-held-conversation', chatIds: ['older-held-conversation'],
    lastAssistantFinalAt: T0 + 25_000, lastTurnEndAt: T0 + 26_000,
    lastTurnOutcome: 'completed' as const };
  const supervisor: AutomationSupervisorSnapshot = {
    observedAt: T0 + 30_000, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 1 },
    chats: [{ sessionId: held.id, conversationId: held.conversationId!, title: held.title,
      mode: 'loop', state: 'blocked', reason: 'Existing provider account needs sign-in.',
      nextAction: 'Sign in using the existing account.', nextRetryAt: null, lastWorkedAt: T0 + 25_000,
      activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }]
  };
  const final: SessionEvent = { kind: 'assistant_message', seq: 1, time: T0 + 25_000,
    source: 'extension', messageId: 'held-previous-final', final: true,
    message: text('The last completed work is retained despite the current sign-in hold.') };
  const app = await boot([], true, [], [], {
    sessions: [firstPage], detailSessions: { [held.id]: held },
    sessionEvents: { [held.id]: [final] }, automation: supervisor,
    sessionTotal: 120, sessionPageCursor: { updatedAt: T0, id: firstPage.id }
  });
  expect(app.w.document.querySelector(`.sess[data-id="${held.id}"]`)).toBeNull();
  const row = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] .work-overview-row[data-session-id="${held.id}"]`)!;
  expect(row.textContent).toContain('blocked');
  row.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.hidden).toBe(false);
  expect(pane.textContent).toContain('Earlier Loop awaiting sign-in');
  expect(pane.textContent).toContain('The last completed work is retained');
  expect(pane.textContent).toContain('Sign in using the existing account.');
  expect(app.sessionReads).toContainEqual({ id: held.id, limit: 80 });

  pane.querySelector<HTMLButtonElement>('button[data-work-action="open"]')!.click();
  await settle();
  expect(app.w.document.getElementById('chatTitle')!.textContent).toContain(held.title);
  expect(app.w.document.getElementById('progressToggle')!.getAttribute('aria-pressed')).toBe('true');
  app.notifySession();
  await settle(550);
  expect(app.w.document.getElementById('chatTitle')!.textContent).toContain(held.title);
});

it('keeps an unloaded Work & updates status row actionable after an exact history-read failure', async () => {
  const firstPage = summary([]);
  const older = { ...summary([]), id: 'older-unloaded-work', title: 'Saved Loop outside recent history',
    conversationId: 'older-unloaded-chat', chatIds: ['older-unloaded-chat'] };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 1 },
    chats: [{ sessionId: older.id, conversationId: older.conversationId!, title: older.title,
      mode: 'loop', state: 'blocked', reason: 'Exact hold preserved.',
      nextAction: 'Retry the saved read.', nextRetryAt: null, lastWorkedAt: T0,
      activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }]
  };
  const final: SessionEvent = { kind: 'assistant_message', seq: 1, time: T0 + 2_000,
    source: 'extension', messageId: 'older-unloaded-result', final: true,
    message: text('Retained exact result after the history reader recovered.') };
  const app = await boot([], true, [], [], {
    sessions: [firstPage], detailSessions: { [older.id]: older }, automation,
    sessionEvents: { [older.id]: [final] }
  });
  const nativeApi = (app.w as any).api;
  const originalRead = nativeApi.getSession;
  nativeApi.getSession = (id: string, ...args: unknown[]) => id === older.id
    ? Promise.resolve({ ok: false, error: 'temporary exact history error' })
    : originalRead(id, ...args);
  app.w.document.querySelector<HTMLButtonElement>(`.work-overview-row[data-session-id="${older.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.hidden).toBe(false);
  expect(pane.textContent).toContain('could not be read');
  expect(pane.textContent).not.toContain('Retained exact result');
  const retry = pane.querySelector<HTMLButtonElement>('button[data-work-action="retry"]')!;
  expect(retry).toBeTruthy();
  nativeApi.getSession = originalRead;
  retry.click();
  await settle();
  expect(pane.textContent).toContain('Retained exact result after the history reader recovered.');
  expect(pane.textContent).toContain('Retry the saved read.');
});

it('does not reopen an unloaded status detail after Escape cancels its pending exact read', async () => {
  const recent = summary([]);
  const older = { ...summary([]), id: 'older-pending-work', title: 'Pending read for an older Goal',
    conversationId: 'older-pending-chat', chatIds: ['older-pending-chat'] };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 1, recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [{ sessionId: older.id, conversationId: older.conversationId!, title: older.title,
      mode: 'goal', state: 'waiting-main', reason: 'Waiting for exact native response.',
      nextAction: 'Inspect current evidence.', nextRetryAt: null, lastWorkedAt: T0,
      activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [recent], automation });
  const nativeApi = (app.w as any).api;
  const originalRead = nativeApi.getSession;
  let finishRead!: (result: unknown) => void;
  nativeApi.getSession = (id: string, ...args: unknown[]) => id === older.id
    ? new Promise(resolve => { finishRead = resolve; }) : originalRead(id, ...args);
  const row = app.w.document.querySelector<HTMLButtonElement>(`.work-overview-row[data-session-id="${older.id}"]`)!;
  row.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.hidden).toBe(false);
  expect(pane.textContent).toContain('Reading this chat');
  pane.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(pane.hidden).toBe(true);
  finishRead({ ok: true, data: { summary: older, events: [], total: 0, nextFrom: 0 } });
  await settle();
  expect(pane.hidden).toBe(true);
  expect(row.getAttribute('aria-expanded')).toBe('false');
});

it('retains saved worker and one-off results in Work & updates after their tabs close', async () => {
  const selected = summary([]);
  const worker = {
    ...summary([]), id: 'saved-worker', title: 'Finished worker review', conversationId: 'worker-chat',
    chatIds: ['worker-chat'], origin: { kind: 'worker' as const, fromSessionId: selected.id, agentId: 'worker-1', task: 'Review' },
    lastFinishReportAt: T0 + 60_000, lastAssistantFinalAt: T0 + 59_000, lastToolCallAt: T0 + 35_000,
    // Worker finish reports are durable even if native turn-end observation is delayed.
    lastTurnEndAt: null, activeTurnId: 'worker-native-turn-still-open', activityExpiresAt: null
  };
  const oneOff = {
    ...summary([]), id: 'saved-oneoff', title: 'Completed one-off response', conversationId: 'oneoff-chat',
    chatIds: ['oneoff-chat'], lastAssistantFinalAt: T0 + 55_000, lastTurnEndAt: T0 + 56_000,
    lastToolCallAt: T0 + 20_000, activityExpiresAt: null
  };
  const openTurn = {
    ...summary([]), id: 'open-turn', title: 'New turn still open', conversationId: 'open-chat',
    chatIds: ['open-chat'], lastAssistantFinalAt: T0 + 70_000, activeTurnId: 'newer-open-turn',
    lastToolCallAt: T0 + 68_000, activityExpiresAt: null
  };
  const olderTool = toolCall(2, 'oneoff-old-tool');
  const final: SessionEvent = {
    kind: 'assistant_message', seq: 3, time: T0 + 55_000, source: 'extension', messageId: 'oneoff-final',
    message: text('Implemented a real user-visible improvement, with verified regression coverage.'), final: true
  };
  const { w } = await boot([], true, [], [], {
    sessions: [selected, worker, oneOff, openTurn], sessionEvents: { [oneOff.id]: [olderTool, final] }
  });
  const updates = w.document.querySelectorAll('.work-overview-section')[1]!;
  const rows = [...updates.querySelectorAll<HTMLButtonElement>('.work-overview-row')];
  // The open ordinary turn also retains an older tool observation, which is
  // now discoverable without being presented as a final or worker report.
  expect(rows.map(row => row.dataset.sessionId)).toEqual([openTurn.id, worker.id, oneOff.id]);
  expect(rows[0]!.textContent).toContain('Recorded tool activity');
  expect(rows[1]!.textContent).toContain('Worker report saved');
  expect(rows[2]!.textContent).toContain('Final answer recorded');
  expect(w.document.getElementById('workOverviewMeta')!.textContent).toContain('3 updates');
  rows[2]!.click();
  await settle();
  const pane = w.document.getElementById('workOverviewPane')!;
  expect(pane.querySelector('.work-overview-pane-field')!.textContent)
    .toContain('Recorded final: Implemented a real user-visible improvement');
  expect(pane.querySelector('.work-overview-pane-field')!.textContent).not.toContain('Read README.md');
  expect(w.document.getElementById('chatTitle')!.textContent).toBe(selected.title);
});

it('reveals older saved worker and one-off outputs from Work without paging away their exact result or focus', async () => {
  const now = Date.now();
  const ordinary = Array.from({ length: 16 }, (_, index): SessionSummary => ({
    ...summary([]), id: `work-older-list-${index}`, title: `Recorded one-off update ${index + 1}`,
    conversationId: `provider-oneoff-${index}`, chatIds: [`provider-oneoff-${index}`],
    lastAssistantFinalAt: now - index * 1_000, lastTurnEndAt: now - index * 1_000 + 100,
    lastTurnOutcome: 'completed', activeTurnId: null, activityExpiresAt: null
  }));
  const worker: SessionSummary = {
    ...summary([]), id: 'saved-worker-after-six', title: 'Retained old worker report with a useful conclusion',
    conversationId: 'old-worker-provider', chatIds: ['old-worker-provider'],
    origin: { kind: 'worker', fromSessionId: ordinary[0]!.id, agentId: 'worker-1', task: 'Verify retained outputs' },
    lastFinishReportAt: now - 17_000, lastToolCallAt: now - 20_000,
    activeTurnId: null, activityExpiresAt: null
  };
  const oldOneoff: SessionSummary = { ...summary([]), id: 'saved-oneoff-after-six',
    title: 'Retained old one-off answer', conversationId: 'old-oneoff-provider',
    chatIds: ['old-oneoff-provider'], lastAssistantFinalAt: now - 18_000,
    lastTurnEndAt: now - 17_900, lastTurnOutcome: 'completed', activeTurnId: null };
  const report: SessionEvent = { kind: 'agent_message', seq: 1, time: now - 17_000,
    source: 'app', agent: 'worker-1', from: 'worker-1', to: 'prime', delivery: 'sent',
    messageId: 'old-worker-final-result', message: text(
      '[worker-1 finished] RESULT: The worker finished an older accessibility review.\nVALIDATION: Saved native result remains readable.\nBLOCKERS: Prime acknowledgment unconfirmed.') };
  const answer: SessionEvent = { kind: 'assistant_message', seq: 2, time: now - 18_000,
    source: 'extension', messageId: 'old-oneoff-final-result', final: true,
    message: text('An exact older one-off answer remains readable after newer Work updates.') };
  const app = await boot([], true, [], [], { sessions: [...ordinary, worker, oldOneoff],
    sessionEvents: { [worker.id]: [report], [oldOneoff.id]: [answer] } });
  const doc = app.w.document;
  const section = doc.querySelector<HTMLElement>('[data-work-section="updates"]')!;
  const rows = () => [...section.querySelectorAll<HTMLButtonElement>('.work-overview-row')];
  expect(rows()).toHaveLength(6);
  expect(rows().some(row => row.dataset.sessionId === worker.id)).toBe(false);
  const more = section.querySelector<HTMLButtonElement>('[data-work-action="more-updates"]')!;
  expect(more).not.toBeNull();
  expect(more.textContent).toContain('Show 6 older updates');
  expect(more.getAttribute('aria-label')).toContain('6 of 18');
  const historyReadsBeforeExpand = app.sessionReads.length;
  more.focus();
  more.click();
  expect(rows()).toHaveLength(12);
  expect(app.sessionReads.length).toBe(historyReadsBeforeExpand);
  expect(section.querySelector('[data-work-action="more-updates"]')).toBe(more);
  expect(more.textContent).toContain('Show 6 older updates');
  expect(doc.activeElement).toBe(rows()[6]);
  const earlier = rows()[6]!;
  earlier.focus();
  app.notifySession();
  await settle(700);
  expect(doc.activeElement).toBe(earlier);
  expect(rows()[6]).toBe(earlier);
  // The explicit session-notification read above belongs to the existing
  // recorder refresh. Revealing a second batch must add no new history IPC.
  const historyReadsBeforeSecondExpand = app.sessionReads.length;
  more.click();
  expect(rows()).toHaveLength(18);
  expect(app.sessionReads.length).toBe(historyReadsBeforeSecondExpand);
  expect(section.querySelector('[data-work-action="more-updates"]')).toBeNull();
  expect(doc.activeElement).toBe(rows()[12]);
  const reportRow = rows().find(row => row.dataset.sessionId === worker.id)!;
  const finalRow = rows().find(row => row.dataset.sessionId === oldOneoff.id)!;
  expect(reportRow.textContent).toContain('Worker report saved');
  expect(finalRow.textContent).toContain('Final answer recorded');
  reportRow.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const disclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  expect(disclosure.textContent).toContain('The worker finished an older accessibility review');
  expect(pane.textContent).toContain('Prime acknowledgment');
  disclosure.open = true;
  disclosure.querySelector('summary')!.focus();
  app.notifySession();
  await settle(700);
  expect(pane.querySelector('.work-overview-result')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(doc.activeElement).toBe(disclosure.querySelector('summary'));
  finalRow.click();
  await settle();
  expect(pane.textContent).toContain('An exact older one-off answer remains readable');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('loads older closed-tab work from the existing session cursor only after an explicit Work request', async () => {
  const now = Date.now();
  const firstPage: SessionSummary[] = Array.from({ length: 60 }, (_, index) => ({
    ...summary([]), id: `loaded-work-${index}`, title: `Recent saved result ${index}`,
    conversationId: `loaded-provider-${index}`, chatIds: [`loaded-provider-${index}`],
    lastMessageAt: now - index * 1000, lastAssistantFinalAt: now - index * 1000,
    lastTurnEndAt: now - index * 1000 + 1, lastTurnOutcome: 'completed' as const,
    activeTurnId: null, activityExpiresAt: null
  }));
  const worker: SessionSummary = { ...summary([]), id: 'unpaged-work-worker',
    title: 'Closed old worker with report', conversationId: 'unpaged-worker-provider',
    chatIds: ['unpaged-worker-provider'], lastMessageAt: now - 80_000,
    origin: { kind: 'worker', fromSessionId: firstPage[0]!.id, agentId: 'worker-1', task: 'Proof' },
    lastFinishReportAt: now - 80_000, lastToolCallAt: now - 90_000, activeTurnId: null };
  const oneoff: SessionSummary = { ...summary([]), id: 'unpaged-work-oneoff',
    title: 'Closed old one-off with answer', conversationId: 'unpaged-oneoff-provider',
    chatIds: ['unpaged-oneoff-provider'], lastMessageAt: now - 81_000,
    lastAssistantFinalAt: now - 81_000, lastTurnEndAt: now - 80_900,
    lastTurnOutcome: 'completed', activeTurnId: null };
  const report: SessionEvent = { kind: 'agent_message', seq: 1, time: now - 80_000,
    source: 'app', agent: 'worker-1', from: 'worker-1', to: 'prime',
    delivery: 'sent', messageId: 'unpaged-worker-report',
    message: text('[worker-1 finished] RESULT: Earlier closed worker proof is still saved.\nBLOCKERS: Prime receipt needs verification.') };
  const answer: SessionEvent = { kind: 'assistant_message', seq: 2, time: now - 81_000,
    source: 'extension', messageId: 'unpaged-oneoff-answer', final: true,
    message: text('Older closed one-off answer survives the first page.') };
  const cursor = { updatedAt: firstPage.at(-1)!.updatedAt, id: firstPage.at(-1)!.id };
  const app = await boot([], true, [], [], { sessions: firstPage, sessionTotal: 62,
    sessionPageCursor: cursor, sessionEvents: { [worker.id]: [report], [oneoff.id]: [answer] } });
  const doc = app.w.document;
  const updates = doc.querySelector<HTMLElement>('[data-work-section="updates"]')!;
  const rows = () => [...updates.querySelectorAll<HTMLButtonElement>('.work-overview-row')];
  const api = (app.w as any).api;
  const originalList = api.listSessions;
  const originalGet = api.getSession;
  const originalControls = api.getSessionControls;
  // The first-page fixture owns the initial 60 only. Once Work explicitly
  // loads the older cursor, the same incumbent exact-detail IPC must be able
  // to read those saved sessions; a synthetic 404 is not a real archive loss.
  api.getSession = (id: string, query?: object) =>
    id === worker.id || id === oneoff.id
      ? Promise.resolve({ ok: true, data: {
        summary: id === worker.id ? worker : oneoff,
        events: id === worker.id ? [report] : [answer],
        total: 1, nextFrom: 2 } })
      : originalGet(id, query);
  api.getSessionControls = (id: string) =>
    id === worker.id || id === oneoff.id
      ? Promise.resolve({ ok: true, data: {
        sessionId: id, conversationId: id === worker.id ? worker.conversationId : oneoff.conversationId,
        automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', objective: '', plan: null } })
      : originalControls(id);
  const requested: Array<unknown> = [];
  api.listSessions = (options?: { cursor?: unknown }) => {
    if (!options?.cursor) return originalList(options);
    requested.push(options.cursor);
    return Promise.resolve({ ok: true, data: { sessions: [worker, oneoff],
      nextCursor: null, total: 62, blocked: [], pressure: [], workerProgress: [],
      automation: null } });
  };
  expect(requested).toHaveLength(0);
  for (let step = 0; step < 9; step++) {
    updates.querySelector<HTMLButtonElement>('[data-work-action="more-updates"]')!.click();
  }
  expect(rows()).toHaveLength(60);
  expect(requested).toHaveLength(0);
  expect(updates.querySelector('[data-session-id="unpaged-work-worker"]')).toBeNull();
  const load = updates.querySelector<HTMLButtonElement>('[data-work-action="load-older-updates"]')!;
  expect(load).not.toBeNull();
  expect(load.textContent).toContain('Load older saved sessions');
  const readsBefore = app.sessionReads.length;
  load.focus();
  load.click();
  await settle(900);
  expect(requested).toEqual([cursor]);
  expect(app.sessionReads).toHaveLength(readsBefore);
  expect(rows()).toHaveLength(62);
  expect(doc.activeElement?.getAttribute('data-session-id')).toBe(worker.id);
  expect(updates.querySelector('[data-work-action="load-older-updates"]')).toBeNull();
  expect(updates.querySelector('[data-work-action="more-updates"]')).toBeNull();
  const workerRow = updates.querySelector<HTMLButtonElement>(`[data-session-id="${worker.id}"]`)!;
  const answerRow = updates.querySelector<HTMLButtonElement>(`[data-session-id="${oneoff.id}"]`)!;
  expect(workerRow.textContent).toContain('Worker report saved');
  expect(answerRow.textContent).toContain('Final answer recorded');
  workerRow.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Earlier closed worker proof is still saved');
  expect(pane.textContent).toContain('Prime receipt');
  answerRow.click();
  await settle();
  expect(pane.textContent).toContain('Older closed one-off answer survives the first page.');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('keeps closed tool-only successes and rejected tools discoverable in Work without claiming a final answer', async () => {
  const succeeded = { ...summary([]), id: 'closed-tool-only-success', title: 'Core read with no final',
    conversationId: 'closed-read-provider', chatIds: ['closed-read-provider'], origin: null,
    endedAt: T0 + 6_000, lastTurnEndAt: T0 + 6_000, lastTurnOutcome: 'completed' as const,
    lastToolCallAt: T0 + 5_000, lastAssistantFinalAt: null, lastFileChangeAt: null,
    fileEdits: 0, toolCalls: 1, activeTurnId: null };
  const failed = { ...succeeded, id: 'closed-tool-only-rejection', title: 'Tool rejected before final',
    conversationId: 'closed-error-provider', chatIds: ['closed-error-provider'],
    endedAt: T0 + 14_000, lastToolCallAt: T0 + 13_000, lastTurnEndAt: T0 + 14_000,
    lastTurnOutcome: 'failed' as const, toolRejected: 1 };
  const read = { ...toolCall(1, 'exact-closed-read'), time: T0 + 5_000, turnId: 'closed-read',
    call: { ...(toolCall(1, 'exact-closed-read') as Extract<SessionEvent, { kind: 'tool_call' }>).call,
      conversationId: succeeded.conversationId,
      summary: { kind: 'read' as const, title: 'Read recorded Core evidence', tone: 'neutral' as const } } };
  const rejected = { ...toolCall(2, 'exact-closed-rejected'), time: T0 + 13_000, turnId: 'failed-turn',
    call: { ...(toolCall(2, 'exact-closed-rejected') as Extract<SessionEvent, { kind: 'tool_call' }>).call,
      conversationId: failed.conversationId, outcome: 'tool_rejected' as const,
      summary: { kind: 'read' as const, title: 'Permission prevented read', tone: 'neutral' as const } } };
  const app = await boot([], true, [], [], { sessions: [summary([]), succeeded, failed],
    sessionEvents: { [succeeded.id]: [read], [failed.id]: [rejected] } });
  const updates = app.w.document.querySelector<HTMLElement>('[data-work-section="updates"]')!;
  const rows = [...updates.querySelectorAll<HTMLButtonElement>('.work-overview-row')];
  expect(rows.map(row => row.dataset.sessionId)).toEqual([failed.id, succeeded.id]);
  expect(rows[0]!.textContent).toContain('Recorded tool activity');
  expect(rows[0]!.textContent).not.toContain('Final answer');
  expect(rows[1]!.textContent).toContain('Recorded tool activity');
  rows[1]!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Read recorded Core evidence');
  expect(pane.textContent).not.toContain('Final answer recorded');
  rows[0]!.click();
  await settle();
  expect(pane.textContent).toContain('Permission prevented read');
  expect(pane.textContent).toContain('Rejected');
  expect(pane.textContent).not.toContain('Saved result available; task completion');
  expect(app.live.sent).toEqual([]);
});

it('keeps previous-provider tool-only evidence findable without promoting it to a resumed provider B result', async () => {
  const row = { ...summary([]), id: 'tool-only-previous-provider', title: 'Previous provider Core receipt',
    conversationId: 'new-provider-B', chatIds: ['old-provider-A', 'new-provider-B'],
    lastToolCallAt: T0 + 10_000, lastAssistantFinalAt: null, fileEdits: 0, toolCalls: 1,
    lastTurnOutcome: null, activeTurnId: 'open-turn-B' };
  const old = { ...toolCall(1, 'old-provider-tool'), time: T0 + 10_000, turnId: 'old-turn-A',
    call: { ...(toolCall(1, 'old-provider-tool') as Extract<SessionEvent, { kind: 'tool_call' }>).call,
      conversationId: 'old-provider-A', summary: { kind: 'read' as const,
        title: 'Previous-provider Core artifact', tone: 'neutral' as const } } };
  const app = await boot([], true, [], [], { sessions: [row],
    sessionEvents: { [row.id]: [old] } });
  const updates = app.w.document.querySelector<HTMLElement>('[data-work-section="updates"]')!;
  const item = updates.querySelector<HTMLButtonElement>(`.work-overview-row[data-session-id="${row.id}"]`)!;
  expect(item).toBeTruthy();
  expect(item.textContent).toContain('Recorded tool activity · provider unverified');
  item.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const did = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(did).not.toContain('Previous-provider Core artifact');
  expect(pane.textContent).toContain('Previous-provider Core artifact');
  expect(pane.textContent).toContain('current-provider tool execution is unverified');
  expect(app.live.sent).toEqual([]);
});

it('does not present a same-provider old A tool as current when newer B finished without a tool or final', async () => {
  const provider = 'tool-two-turns-same-provider';
  const row = { ...summary([]), id: 'tool-only-after-empty-new-turn',
    title: 'A Core result retained after empty native B', conversationId: provider,
    chatIds: [provider], toolCalls: 1, lastToolCallAt: T0 + 3_000,
    lastAssistantFinalAt: null, fileEdits: 0, activeTurnId: null,
    lastTurnOutcome: 'completed' as const, lastTurnEndAt: T0 + 9_000,
    finishTurn: { turnId: 'turn-B', conversationId: provider, startedAt: T0 + 8_000,
      notified: false, released: true, decisionRevision: null, workSeq: 0,
      decisionSeq: 0, decisionInputRevision: null } };
  const before = { ...(toolCall(2, 'old-A-tool') as Extract<SessionEvent, { kind: 'tool_call' }>),
    time: T0 + 3_000, turnId: 'turn-A',
    call: { ...(toolCall(2, 'old-A-tool') as Extract<SessionEvent, { kind: 'tool_call' }>).call,
      conversationId: provider, result: text('Original A Core result remains readable.') } };
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: [
    before, { kind: 'turn_start', source: 'extension', seq: 3, time: T0 + 8_000, turnId: 'turn-B' },
    { kind: 'turn_end', source: 'extension', seq: 4, time: T0 + 9_000,
      turnId: 'turn-B', outcome: 'completed' }
  ] } });
  const item = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!;
  expect(item.textContent).toContain('Previous tool activity retained');
  item.click(); await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid).toContain('Latest turn completed; no exact final or tool outcome recorded.');
  const output = pane.querySelector<HTMLDetailsElement>('.work-overview-tool-result')!;
  expect(output.querySelector('summary')?.textContent).toContain('provider/turn unverified');
  output.open = true;
  expect(output.textContent).toContain('Original A Core result remains readable');
  expect(output.textContent).toContain('not proof of current Core work');
  expect(app.live.sent).toEqual([]);
});

it('reveals an entire recorded tool result on demand, distinguishes capture truncation, and preserves disclosure focus on update', async () => {
  const row = { ...summary([]), id: 'tool-result-disclosure', title: 'Large recorded tool output',
    conversationId: 'tool-detail-provider', chatIds: ['tool-detail-provider'],
    endedAt: T0 + 6_000, lastToolCallAt: T0 + 5_000,
    lastAssistantFinalAt: null, lastTurnOutcome: 'completed' as const };
  const output = 'RESULT: Tool recorded useful work.\n' + 'Original evidence line. '.repeat(720) +
    '\nBLOCKERS: This output did not include a final answer.';
  const event = { ...toolCall(1, 'tool-large-output'), time: T0 + 5_000,
    call: { ...(toolCall(1, 'tool-large-output') as Extract<SessionEvent, { kind: 'tool_call' }>).call,
      conversationId: row.conversationId, result: { text: output, chars: output.length, truncated: true } } };
  const app = await boot([], true, [], [], { sessions: [row],
    sessionEvents: { [row.id]: [event] } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const detail = pane.querySelector<HTMLDetailsElement>('.work-overview-tool-result')!;
  expect(detail).toBeTruthy();
  expect(detail.querySelector('summary')?.textContent).toContain('Read recorded tool result');
  detail.open = true;
  const body = detail.querySelector<HTMLElement>('.work-overview-result-body')!;
  expect(body.textContent?.length).toBe(12_000);
  expect(detail.textContent).toContain('Original recording was truncated');
  const expand = detail.querySelector<HTMLButtonElement>('[data-work-action="expand-tool-result"]')!;
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  expand.focus(); expand.click();
  expect(body.textContent).toBe(output);
  expect(expand.getAttribute('aria-expanded')).toBe('true');
  app.notifySession();
  await settle(700);
  expect(pane.querySelector('.work-overview-tool-result')).toBe(detail);
  expect(detail.querySelector('.work-overview-result-body')).toBe(body);
  expect(detail.open).toBe(true);
  expect(body.textContent).toBe(output);
  expect(app.w.document.activeElement).toBe(expand);
  expect(app.live.sent).toEqual([]);
});

it('retrieves a tool-only result beyond the recent 80 events and retries a failed bounded history page without replay', async () => {
  const row = { ...summary([]), id: 'tool-only-older-history', title: 'Saved Core result past the recent tail',
    conversationId: 'old-core-provider', chatIds: ['old-core-provider'],
    toolCalls: 1, fileEdits: 0, lastAssistantFinalAt: null, lastToolCallAt: T0 + 2_000 };
  const tool: SessionEvent = { ...(toolCall(2, 'long-before-recent-window') as Extract<SessionEvent, { kind: 'tool_call' }>),
    call: { ...(toolCall(2, 'long-before-recent-window') as Extract<SessionEvent, { kind: 'tool_call' }>).call,
      conversationId: row.conversationId, result: text('RESULT: Saved previous Core output is available beyond the 80-event window.') } };
  const events: SessionEvent[] = [tool, ...Array.from({ length: 190 }, (_, i): SessionEvent => ({
    kind: 'progress', source: 'app', seq: i + 3, time: T0 + (i + 3) * 1000,
    progressId: 'unrelated-progress-' + i, message: text('A later progress note has no tool result.')
  }))];
  row.events = events.length;
  const app = await boot([], true, [], [], { sessions: [row], strictSessionPaging: true,
    sessionEvents: { [row.id]: events } });
  const api = (app.w as any).api, originalGet = api.getSession;
  let failedOlderPage = false;
  api.getSession = (id: string, query?: { before?: number }) =>
    id === row.id && query?.before && !failedOlderPage
      ? (failedOlderPage = true, Promise.resolve({ ok: false, error: 'Page interrupted' }))
      : originalGet(id, query);
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Older tool result');
  expect(pane.textContent).toContain('temporarily unavailable');
  const retry = pane.querySelector<HTMLButtonElement>('[data-work-action="retry-older"]')!;
  expect(retry).toBeTruthy();
  retry.focus(); retry.click();
  await settle();
  const disclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-tool-result')!;
  expect(disclosure).toBeTruthy();
  disclosure.open = true;
  expect(disclosure.textContent).toContain('RESULT: Saved previous Core output');
  expect(pane.querySelector('[data-work-action="retry-older"]')).toBeNull();
  const olderReads = app.sessionReads.filter(call => call.id === row.id && call.before !== undefined && call.before !== null).length;
  const heading = disclosure.querySelector<HTMLElement>('summary')!;
  heading.focus();
  app.notifySession();
  await settle(700);
  // The same immutable last-tool marker does not re-page the recorder on
  // each work update. Keep the open tool and its keyboard focus intact.
  expect(app.sessionReads.filter(call => call.id === row.id && call.before !== undefined && call.before !== null))
    .toHaveLength(olderReads);
  expect(pane.querySelector('.work-overview-tool-result')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(app.w.document.activeElement).toBe(heading);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('reveals a closed tool-only result from the existing older-session cursor with one explicit click', async () => {
  const now = Date.now();
  const first: SessionSummary[] = Array.from({ length: 60 }, (_, index) => ({
    ...summary([]), id: 'tool-paged-first-' + index,
    title: 'Previously loaded work ' + index,
    conversationId: 'tool-paged-provider-' + index, chatIds: ['tool-paged-provider-' + index],
    updatedAt: now - index * 1000, lastAssistantFinalAt: index < 6 ? now - index * 1000 : null,
    lastTurnOutcome: 'completed' as const, activeTurnId: null
  }));
  const older: SessionSummary = { ...summary([]), id: 'tool-paged-old-result',
    title: 'Earlier Core check without final', conversationId: 'tool-paged-old-provider',
    chatIds: ['tool-paged-old-provider'], updatedAt: now - 90_000, endedAt: now - 89_000,
    lastAssistantFinalAt: null, fileEdits: 0, lastToolCallAt: now - 90_000,
    lastTurnOutcome: 'completed', lastTurnEndAt: now - 89_000, toolCalls: 1 };
  const cursor = { updatedAt: first[59]!.updatedAt, id: first[59]!.id };
  const app = await boot([], true, [], [], { sessions: first, sessionTotal: 61, sessionPageCursor: cursor });
  const doc = app.w.document;
  const updates = doc.querySelector<HTMLElement>('[data-work-section="updates"]')!;
  const load = updates.querySelector<HTMLButtonElement>('[data-work-action="load-older-updates"]')!;
  expect(load).toBeTruthy();
  const api = (app.w as any).api, originalList = api.listSessions;
  let olderReads = 0;
  api.listSessions = (options?: { cursor?: unknown }) => {
    if (!options?.cursor) return originalList(options);
    olderReads++;
    return Promise.resolve({ ok: true, data: { sessions: [older], total: 61,
      nextCursor: null, blocked: [], pressure: [], workerProgress: [], automation: null } });
  };
  load.focus(); load.click(); await settle(800);
  expect(olderReads).toBe(1);
  const revealed = updates.querySelector<HTMLButtonElement>(
    `.work-overview-row[data-session-id="${older.id}"]`)!;
  expect(revealed).toBeTruthy();
  expect(revealed.textContent).toContain('Recorded tool activity');
  expect(doc.activeElement).toBe(revealed);
  expect(app.live.sent).toEqual([]);
});

it('keeps saved Work results and offers an explicit retry after an older session-page read fails', async () => {
  const now = Date.now();
  const firstPage: SessionSummary[] = Array.from({ length: 60 }, (_, index) => ({
    ...summary([]), id: `error-page-current-${index}`,
    title: `Current saved result ${index}`, conversationId: `error-page-provider-${index}`,
    chatIds: [`error-page-provider-${index}`],
    lastMessageAt: now - index * 1000, lastAssistantFinalAt: now - index * 1000,
    lastTurnEndAt: now - index * 1000 + 1,
    lastTurnOutcome: 'completed' as const, activeTurnId: null
  }));
  const previous: SessionSummary = { ...summary([]), id: 'error-page-retained-worker',
    title: 'Retained worker after a failed history-page read',
    conversationId: 'older-read-recovered-provider',
    chatIds: ['older-read-recovered-provider'],
    origin: { kind: 'worker', fromSessionId: firstPage[0]!.id, agentId: 'worker-1', task: 'Verify' },
    lastFinishReportAt: now - 71_000, lastToolCallAt: now - 73_000,
    lastMessageAt: now - 71_000, activeTurnId: null };
  const cursor = { updatedAt: firstPage.at(-1)!.updatedAt, id: firstPage.at(-1)!.id };
  const app = await boot([], true, [], [], { sessions: firstPage,
    sessionTotal: 61, sessionPageCursor: cursor });
  const doc = app.w.document;
  const updates = doc.querySelector<HTMLElement>('[data-work-section="updates"]')!;
  const oldList = (app.w as any).api.listSessions;
  let pageCalls = 0;
  (app.w as any).api.listSessions = (options?: { cursor?: unknown }) => {
    if (!options?.cursor) return oldList(options);
    pageCalls++;
    return pageCalls === 1
      ? Promise.resolve({ ok: false, error: 'Synthetic older session page unavailable.' })
      : Promise.resolve({ ok: true, data: { sessions: [previous],
        total: 61, nextCursor: null, blocked: [], pressure: [], workerProgress: [] } });
  };
  for (let index = 0; index < 9; index++) {
    updates.querySelector<HTMLButtonElement>('[data-work-action="more-updates"]')!.click();
  }
  const first = updates.querySelector<HTMLButtonElement>('[data-work-action="load-older-updates"]')!;
  first.focus();
  first.click();
  await settle(800);
  expect(pageCalls).toBe(1);
  const retry = updates.querySelector<HTMLButtonElement>('[data-work-action="load-older-updates"]')!;
  expect(retry.textContent).toContain('Older saved sessions unavailable · Retry read');
  expect(retry.disabled).toBe(false);
  expect(doc.activeElement).toBe(retry);
  expect(updates.querySelectorAll('.work-overview-row')).toHaveLength(60);
  expect(updates.querySelector('[data-session-id="error-page-current-0"]')).not.toBeNull();
  retry.click();
  await settle(800);
  expect(pageCalls).toBe(2);
  expect(updates.querySelectorAll('.work-overview-row')).toHaveLength(61);
  expect(doc.activeElement?.getAttribute('data-session-id')).toBe(previous.id);
  expect(updates.querySelector('[data-work-action="load-older-updates"]')).toBeNull();
  expect(updates.querySelector('[data-session-id="error-page-current-0"]')).not.toBeNull();
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('keeps an old-provider control snapshot historical when current Work history has rebound', async () => {
  const now = Date.now();
  const owner: SessionSummary = { ...summary([]), id: 'control-binding-current-B',
    title: 'Preserve exact provider control binding', conversationId: 'provider-B',
    chatIds: ['provider-A', 'provider-B'], updatedAt: now, activeTurnId: null,
    lastAssistantFinalAt: now - 1_000, lastTurnEndAt: now - 800, lastTurnOutcome: 'completed' };
  const app = await boot([], true, [], [], { sessions: [owner],
    controls: { conversationId: 'provider-A', activeTurnId: 'old-turn-A', automation: 'goal',
      plan: { plan: [{ step: 'Old provider A plan must be historical', status: 'in_progress' }],
        checklist: [{ id: 'old-check', requirement: 'Old provider task', status: 'implemented' }] },
      activeWork: { report: { delivered: { thresholdMs: 7_200_000, messageId: 'old-A-delivery' } } } } });
  const doc = app.w.document;
  const open = doc.querySelector<HTMLButtonElement>('[data-work-section="updates"] .work-overview-row')!;
  expect(open).not.toBeNull();
  open.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(row => row.querySelector('b')?.textContent === name)?.textContent ?? '';
  expect(field('Evidence source')).toContain('provider-B');
  expect(field('Evidence source')).toContain('provider-A');
  expect(field('Current task')).toContain('unverified');
  expect(field('Current task')).not.toContain('Old provider A plan must be historical');
  expect(field('Requirements')).toContain('unverified');
  expect(field('Control snapshot boundary')).toContain('provider-A');
  expect(pane.textContent).toContain('Old provider A plan must be historical');
  expect(pane.textContent).not.toContain('Two-active-hour scope update delivered');
  expect(pane.querySelector('[data-work-action="retry-controls"]')).not.toBeNull();
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('keeps same-provider prior-turn controls, checklist and active-work report historical through a newer native turn', async () => {
  const now = Date.now();
  const current: SessionSummary = {
    ...summary([]), id: 'work-same-provider-turn-race', title: 'Original retained task with a newer turn',
    conversationId: 'same-native-provider', chatIds: ['same-native-provider'],
    activeTurnId: 'turn-B-live', lastMessageAt: now - 1_000,
    updatedAt: now, activityExpiresAt: now + 30_000
  };
  const earlierPlan = { plan: [{ step: 'Old turn A finished validating first draft', status: 'in_progress' as const }],
    checklist: [{ id: 'old-turn-only', requirement: 'Old turn A acceptance', status: 'implemented' as const }] };
  const app = await boot([], true, [], [], { sessions: [current],
    controls: { conversationId: current.conversationId, activeTurnId: 'turn-A-ended',
      automation: 'goal', plan: earlierPlan,
      activeWork: { report: { delivered: { thresholdMs: 7_200_000, messageId: 'old-turn-only-native-user' } } } } });
  const doc = app.w.document;
  const row = doc.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${current.id}"]`)!;
  expect(row).not.toBeNull();
  row.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
  expect(field('Evidence source')).toContain('turn-A-ended');
  expect(field('Evidence source')).toContain('turn-B-live');
  expect(field('Current task')).toContain('unverified');
  expect(field('Current task')).not.toContain('Old turn A finished');
  expect(field('Requirements')).toContain('unverified');
  expect(field('Control snapshot boundary')).toContain('same provider');
  expect(field('Control snapshot boundary')).toContain('turn-B-live');
  expect(field('Control snapshot boundary')).toContain('Old turn A finished');
  expect(pane.textContent).not.toContain('Two-active-hour scope update delivered');
  const retry = pane.querySelector<HTMLButtonElement>('[data-work-action="retry-controls"]')!;
  expect(retry).not.toBeNull();
  // The original control read was stale. A deliberate follow-up read of the
  // SAME B turn may make its plan current without Send, replay or reconstruction.
  const original = (app.w as any).api.getSessionControls;
  (app.w as any).api.getSessionControls = (id: string) => id === current.id
    ? Promise.resolve({ ok: true, data: { sessionId: id,
      conversationId: current.conversationId, activeTurnId: 'turn-B-live', automation: 'goal',
      plan: { plan: [{ step: 'Current turn B is implementing the follow-up', status: 'in_progress' }],
        checklist: [{ id: 'current-B', requirement: 'Actual B acceptance', status: 'pending' }] },
      activeWork: null, blocked: '', objective: '', finishHeld: false, job: null } })
    : original(id);
  retry.focus(); retry.click();
  await settle();
  expect(field('Current task')).toContain('Current turn B is implementing');
  // The incumbent acceptance UI summarizes counts and evidence classes,
  // deliberately not raw requirement text. Current B's sole pending item
  // must replace the historical A checklist denominator.
  expect(field('Requirements')).toContain('0 / 1 active recorded requirements');
  expect(field('Requirements')).toContain('done=false: 1');
  expect(field('Control snapshot boundary')).toBe('');
  expect(field('Evidence source')).toContain('same-provider current-turn snapshot');
  expect(pane.querySelector('[data-work-action="retry-controls"]')).toBeNull();
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('does not call a prior-turn Off snapshot current Off while the same-provider newer turn remains open', async () => {
  const now = Date.now();
  const current: SessionSummary = { ...summary([]), id: 'prior-off-current-native-turn',
    conversationId: 'same-provider-new-turn', chatIds: ['same-provider-new-turn'],
    title: 'Turn B continues without a current control receipt',
    activeTurnId: 'turn-B', lastMessageAt: now - 2_000, updatedAt: now,
    activityExpiresAt: now - 1_000 };
  const app = await boot([], true, [], [], { sessions: [current],
    controls: { conversationId: current.conversationId, activeTurnId: 'turn-A', automation: 'off',
      plan: { plan: [{ step: 'Previous turn A was Off', status: 'completed' }], checklist: [] } } });
  const paneButton = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${current.id}"]`)!;
  paneButton.click(); await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(row => row.querySelector('b')?.textContent === name)?.textContent ?? '';
  expect(field('Current status')).toContain('Turn open');
  expect(field('Automation setting')).toBe('');
  expect(field('Control snapshot boundary')).toContain('turn-A');
  expect(field('Control snapshot boundary')).toContain('turn-B');
  expect(field('Current task')).not.toContain('Previous turn A was Off');
  expect(field('Evidence source')).toContain('not current');
  expect(pane.querySelector('[data-work-action="retry-controls"]')).not.toBeNull();
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it.each(['recorded A native message', 'outbox-only A Send'] as const)(
  'retains %s separately from a newer same-provider B turn with no B Send or tool result', async kind => {
    const now = Date.now();
    const owner: SessionSummary = { ...summary([]), id: 'saved-A-native-current-B-' + kind.replaceAll(' ', '-'),
      conversationId: 'same-provider-native-A-B', chatIds: ['same-provider-native-A-B'],
      title: 'New native turn B has no confirmed outgoing result',
      activeTurnId: 'native-turn-B', updatedAt: now, activityExpiresAt: now + 10_000,
      lastMessageAt: now - 500, lastAssistantFinalAt: null, lastToolCallAt: null };
    const message: SessionEvent = { kind: 'user_message', seq: 1, time: now - 7_000,
      source: 'app', turnId: 'native-turn-A', inputId: 'earlier-A-native-input',
      inputDelivery: 'confirmed', messageId: 'earlier-A-native-message',
      message: text('Earlier native A input already sent; never send it again.') };
    const outbox: InputEntry = { id: 'earlier-A-native-input', sessionId: owner.id,
      conversationId: owner.conversationId, mode: 'auto', text: 'Original A input',
      model: 'gpt-6-thinking', reasoningEffort: 'xhigh', dueAt: 0,
      state: 'cancelled', owner: 'old-browser-owner', createdAt: now - 8_000,
      deliveredAt: now - 7_000, messageId: 'earlier-A-native-message',
      error: 'Original answer collection was interrupted; Send remains durable.' };
    const app = await boot([], true, [], [], { sessions: [owner],
      sessionEvents: { [owner.id]: kind === 'recorded A native message' ? [message] : [] },
      inputs: [outbox], controls: { activeTurnId: 'native-turn-B' } });
    const row = app.w.document.querySelector<HTMLButtonElement>(
      `.work-overview-section[data-work-section="current"] [data-session-id="${owner.id}"]`)!;
    row.click(); await settle();
    const pane = app.w.document.getElementById('workOverviewPane')!;
    const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
      .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
    expect(field('Just did')).not.toContain('Native input delivered');
    expect(field('Current status')).toContain('current execution');
    expect(field('Native delivery & answer')).toContain('Native Send confirmed');
    expect(field('Native delivery & answer')).toContain('earlier-A-native-message');
    expect(field('Native delivery & answer')).toContain('native-turn-B');
    expect(field('Native delivery & answer')).toContain('not confirm');
    expect(pane.textContent).not.toContain('Exact answer recorded');
    expect(app.live.sent).toEqual([]);
    expect(app.live.controlCalls).toEqual([]);
  }
);

it.each(['native A row retained', 'outbox-only native A receipt'] as const)(
  'keeps %s historical when SAME-provider B has already ended with no new result', async kind => {
    const now = Date.now();
    const owner: SessionSummary = { ...summary([]), id: 'closed-B-old-A-send-' + kind.replaceAll(' ', '-'),
      conversationId: 'closed-B-same-provider', chatIds: ['closed-B-same-provider'],
      title: 'Finished B without a new native Send or result', activeTurnId: null,
      finishTurn: { turnId: 'completed-B', conversationId: 'closed-B-same-provider',
        startedAt: now - 3_000, notified: false, released: true,
        decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null },
      lastTurnOutcome: 'failed', lastTurnEndAt: now - 1_000, updatedAt: now,
      lastAssistantFinalAt: null, lastToolCallAt: null };
    const oldA: SessionEvent = { kind: 'user_message', source: 'app', seq: 3,
      time: now - 8_000, turnId: 'finished-A', inputId: 'sent-A-only',
      messageId: 'native-A-only', inputDelivery: 'confirmed',
      message: text('Old A was delivered; it belongs to A, not to finished B.') };
    const outbox: InputEntry = { id: 'sent-A-only', sessionId: owner.id,
      conversationId: owner.conversationId, mode: 'auto', text: 'Original A instruction',
      model: 'gpt-6-thinking', reasoningEffort: 'xhigh', dueAt: 0,
      state: 'cancelled', owner: 'original-A-tab', createdAt: now - 9_000,
      deliveredAt: now - 8_000, messageId: 'native-A-only' };
    const events: SessionEvent[] = [...kind.startsWith('native') ? [oldA] : [],
      { kind: 'turn_start', source: 'extension', seq: 4, time: now - 3_000, turnId: 'completed-B' },
      { kind: 'turn_end', source: 'extension', seq: 5, time: now - 1_000,
        turnId: 'completed-B', outcome: 'failed' }];
    const app = await boot([], true, [], [], { sessions: [owner],
      sessionEvents: { [owner.id]: events }, inputs: [outbox],
      controls: { activeTurnId: null, automation: 'loop' } });
    app.w.document.querySelector<HTMLButtonElement>(
      `.work-overview-section[data-work-section="updates"] [data-session-id="${owner.id}"]`)!.click();
    await settle();
    const pane = app.w.document.getElementById('workOverviewPane')!;
    const field = (label: string) => [...pane.querySelectorAll('.work-overview-pane-field')]
      .find(node => node.querySelector('b')?.textContent === label)?.textContent ?? '';
    expect(field('Native delivery & answer')).toContain('Native Send confirmed');
    expect(field('Native delivery & answer')).toContain('native-A-only');
    expect(field('Native delivery & answer')).toContain('completed-B');
    expect(field('Native delivery & answer')).toContain('not confirm');
    expect(field('Just did')).not.toContain('Native input delivered');
    expect(field('Just did')).not.toContain('old A');
    expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Earlier-turn Native Send');
    expect(app.live.sent).toEqual([]);
    expect(app.live.controlCalls).toEqual([]);
  }
);

it('does not headline delayed A tool/final/page failure or its file edits as finished B Work, but retains their exact recorded bodies', async () => {
  const now = Date.now(), id = 'closed-B-delayed-A-results';
  const owner: SessionSummary = { ...summary([]), id,
    conversationId: 'unchanged-provider-A-B', chatIds: ['unchanged-provider-A-B'],
    title: 'B ended without fresh work; A evidence arrived late',
    activeTurnId: null, lastToolCallAt: now - 1_400, lastFileChangeAt: now - 1_400,
    fileEdits: 1, lastAssistantFinalAt: now - 1_300, lastTurnEndAt: now - 2_000,
    lastTurnOutcome: 'failed', updatedAt: now,
    finishTurn: { turnId: 'closed-native-B', conversationId: 'unchanged-provider-A-B',
      startedAt: now - 4_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const oldTool = toolCall(2, 'late-A-tool') as Extract<SessionEvent, { kind: 'tool_call' }>;
  oldTool.time = now - 1_400;
  oldTool.turnId = 'older-native-A';
  oldTool.call.summary = { kind: 'edit', title: 'Old A changed a file', tone: 'good' };
  oldTool.call.changes = [{ path: 'src/old-A-file.ts', added: 3, removed: 0, approximate: false }];
  const events: SessionEvent[] = [
    { kind: 'turn_start', source: 'extension', seq: 1, time: now - 9_000, turnId: 'older-native-A' },
    { kind: 'turn_start', source: 'extension', seq: 3, time: now - 4_000, turnId: 'closed-native-B' },
    { kind: 'turn_end', source: 'extension', seq: 4, time: now - 2_000,
      turnId: 'closed-native-B', outcome: 'failed' },
    oldTool,
    { kind: 'assistant_message', source: 'extension', seq: 5, time: now - 1_300,
      turnId: 'older-native-A', messageId: 'late-old-A-result', final: true,
      message: text('RESULT: Old A completed useful changes, not B.') },
    { kind: 'chat_error', source: 'extension', seq: 6, time: now - 1_100,
      turnId: 'older-native-A', blocking: true, message: text('Old A provider error; B had no recorded provider error') }
  ];
  const app = await boot([], true, [], [], { sessions: [owner],
    sessionEvents: { [id]: events }, controls: { automation: 'loop', activeTurnId: null } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (label: string) => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(node => node.querySelector('b')?.textContent === label)?.textContent ?? '';
  expect(field('Just did')).toContain('Latest turn failed');
  expect(field('Just did')).not.toContain('Old A changed');
  expect(field('Just did')).not.toContain('Old A provider');
  expect(field('Changes')).not.toContain('Exact current');
  expect(field('Changes')).toContain('No exact current-turn file changes');
  expect(field('Historical changes')).toContain('src/old-A-file.ts');
  expect(field('Provider evidence')).toContain('not tied to the current provider turn');
  expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Earlier turn tool');
  expect(pane.querySelector('.work-overview-result summary')?.textContent).toContain('previous');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Old A completed useful changes');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('treats a positively bound B result, B tool changes and B native Send as current even after B closes', async () => {
  const now = Date.now(), id = 'positive-finished-B-turn';
  const owner: SessionSummary = { ...summary([]), id,
    title: 'B produced a recorded result after A', conversationId: 'one-provider-two-turns',
    chatIds: ['one-provider-two-turns'], activeTurnId: null, lastTurnEndAt: now - 500,
    lastTurnOutcome: 'completed', lastAssistantFinalAt: now - 1_000,
    lastToolCallAt: now - 1_500, fileEdits: 2, lastFileChangeAt: now - 1_500,
    updatedAt: now,
    finishTurn: { turnId: 'current-completed-B', conversationId: 'one-provider-two-turns',
      startedAt: now - 4_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const a: SessionEvent = { kind: 'assistant_message', source: 'extension', seq: 1,
    time: now - 9_000, turnId: 'older-A', messageId: 'prior-A-final',
    final: true, message: text('RESULT: A result remains historical and readable.') };
  const sentB: SessionEvent = { kind: 'user_message', source: 'app', seq: 3, time: now - 3_700,
    turnId: 'current-completed-B', inputId: 'exact-B-input', messageId: 'native-B-delivered',
    inputDelivery: 'confirmed', message: text('New B authorized instruction') };
  const newTool = toolCall(4, 'current-B-useful-edit') as Extract<SessionEvent, { kind: 'tool_call' }>;
  newTool.time = now - 1_500; newTool.turnId = 'current-completed-B';
  newTool.call.summary = { kind: 'edit', title: 'B changed correct current file', tone: 'good' };
  newTool.call.changes = [{ path: 'src/real-B.ts', added: 5, removed: 2, approximate: false }];
  const b: SessionEvent = { kind: 'assistant_message', source: 'extension', seq: 5,
    time: now - 1_000, turnId: 'current-completed-B', messageId: 'exact-B-final',
    final: true, goalEligible: true, inputReplyTo: 'native-B-delivered',
    message: text('RESULT: B completed useful work with exact native provenance.') };
  const outbox: InputEntry = { id: 'exact-B-input', sessionId: id, conversationId: owner.conversationId,
    mode: 'auto', text: 'B task', model: 'gpt-6-thinking', reasoningEffort: 'xhigh',
    dueAt: 0, state: 'sent', owner: 'B-native-owner', createdAt: now - 4_000,
    deliveredAt: now - 3_700, messageId: 'native-B-delivered' };
  const app = await boot([], true, [], [], { sessions: [owner],
    controls: { activeTurnId: null, automation: 'loop' }, inputs: [outbox],
    sessionEvents: { [id]: [a, { kind: 'turn_start', source: 'extension',
      seq: 2, time: now - 4_000, turnId: 'current-completed-B' }, sentB, newTool, b] } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (label: string) => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(node => node.querySelector('b')?.textContent === label)?.textContent ?? '';
  expect(field('Just did')).toContain('B completed useful work');
  expect(field('Changes')).toContain('Exact current-turn changes recorded');
  expect(field('Changes')).toContain('src/real-B.ts');
  expect(field('Native delivery & answer')).toContain('Native Send confirmed');
  expect(field('Native delivery & answer')).toContain('Exact answer recorded');
  expect(field('Native delivery & answer')).not.toContain('does not confirm native Send');
  const result = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  expect(result.querySelector('summary')?.textContent).toContain('Read recorded final answer');
  expect(result.textContent).toContain('B completed useful work');
  const older = pane.querySelector<HTMLDetailsElement>('.work-overview-previous-result')!;
  expect(older.querySelector('summary')?.textContent).toContain('Read previous saved final answer');
  expect(older.textContent).toContain('A result remains historical');
  expect(older.textContent).toContain('not current native turn current-completed-B');
  expect(older.querySelector('summary')?.getAttribute('data-work-action')).toBe('previous-result');
  result.open = true;
  older.open = true;
  older.querySelector('summary')!.focus();
  app.notifySession(); await settle(700);
  expect(pane.querySelector('.work-overview-result')).toBe(result);
  expect(pane.querySelector('.work-overview-previous-result')).toBe(older);
  expect(result.open).toBe(true);
  expect(older.open).toBe(true);
  expect(app.w.document.activeElement).toBe(older.querySelector('summary'));
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

/** Saved A is outside the 80-event Work tail, but B has a positively bound
 * current final. The existing eager older-result lookup has no reason to run. */
function deepOlderFinalAfterB(id: string) {
  const row: SessionSummary = { ...summary([]), id,
    title: 'Exact B result with earlier A output outside Work history preview',
    conversationId: 'same-provider-deep-final', chatIds: ['same-provider-deep-final'],
    activeTurnId: null, lastTurnOutcome: 'completed', lastTurnEndAt: T0 + 161_000,
    lastAssistantFinalAt: T0 + 110_000, lastToolCallAt: null,
    updatedAt: T0 + 162_000,
    finishTurn: { turnId: 'exact-B-last', conversationId: 'same-provider-deep-final',
      startedAt: T0 + 90_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const earlier: SessionEvent = { kind: 'assistant_message', seq: 2, time: T0 + 2_000,
    source: 'extension', turnId: 'original-A', messageId: 'saved-original-A', final: true,
    message: text('RESULT: Original A supplied the exact historical work, validation and blockers.') };
  const current: SessionEvent = { kind: 'assistant_message', seq: 110, time: T0 + 110_000,
    source: 'extension', turnId: 'exact-B-last', messageId: 'finished-B-final', final: true,
    message: text('RESULT: Exact current B finished its own separate useful work.') };
  const progress = (seq: number): SessionEvent => ({ kind: 'progress', seq,
    time: T0 + seq * 1000, source: 'app', progressId: 'work-depth-' + seq,
    message: text('Later bounded status evidence; not another result.') });
  const events: SessionEvent[] = [earlier,
    ...Array.from({ length: 85 }, (_, index) => progress(index + 3)),
    { kind: 'turn_start', seq: 90, time: T0 + 90_000,
      source: 'extension', turnId: 'exact-B-last' }, current,
    ...Array.from({ length: 45 }, (_, index) => progress(index + 111))];
  row.events = events.length;
  return { row, events, earlier, current };
}

function deepOlderToolHistory(id: string) {
  const provider = 'deep-tool-provider-B';
  const row: SessionSummary = { ...summary([]), id,
    title: 'Current B tool output with older Core results outside the Work tail',
    conversationId: provider, chatIds: ['deep-tool-provider-A', provider],
    activeTurnId: null, lastTurnOutcome: 'completed', lastTurnEndAt: T0 + 161_000,
    lastAssistantFinalAt: T0 + 110_000, lastToolCallAt: T0 + 100_000, toolCalls: 3,
    updatedAt: T0 + 162_000,
    finishTurn: { turnId: 'exact-B-last', conversationId: provider, startedAt: T0 + 90_000,
      notified: false, released: true, decisionRevision: null, workSeq: 0, decisionSeq: 0,
      decisionInputRevision: null } };
  const makeTool = (seq: number, turnId: string, callId: string, conversationId: string,
    title: string, body: string): Extract<SessionEvent, { kind: 'tool_call' }> => {
    const event = toolCall(seq, callId) as Extract<SessionEvent, { kind: 'tool_call' }>;
    event.time = T0 + seq * 1000;
    event.turnId = turnId;
    event.call.conversationId = conversationId;
    event.call.summary = { kind: 'read', title, tone: 'neutral' };
    event.call.result = text(body);
    return event;
  };
  const older = makeTool(2, 'original-A', 'tool-old-A', 'deep-tool-provider-A',
    'Read previous provider A file', 'CORE OUTPUT: original A tool result');
  const middle = makeTool(55, 'middle-C', 'tool-middle-C', provider,
    'Read previous turn C config', 'CORE OUTPUT: middle C tool result');
  const currentTool = makeTool(100, 'exact-B-last', 'tool-current-B', provider,
    'Read current B status', 'CORE OUTPUT: current B tool result');
  const currentFinal: SessionEvent = { kind: 'assistant_message', seq: 110, time: T0 + 110_000,
    source: 'extension', turnId: 'exact-B-last', messageId: 'finished-B-final', final: true,
    message: text('RESULT: Exact current B final remains the current answer.') };
  const progress = (seq: number): SessionEvent => ({ kind: 'progress', seq,
    time: T0 + seq * 1000, source: 'app', progressId: 'tool-depth-' + seq,
    message: text('Later bounded status evidence; not another tool output.') });
  const events: SessionEvent[] = [older,
    ...Array.from({ length: 52 }, (_, index) => progress(index + 3)), middle,
    ...Array.from({ length: 32 }, (_, index) => progress(index + 56)),
    { kind: 'turn_start', seq: 90, time: T0 + 90_000, source: 'extension', turnId: 'exact-B-last' },
    currentTool, currentFinal, ...Array.from({ length: 45 }, (_, index) => progress(index + 111))];
  row.events = events.length;
  return { row, events, older, middle, currentTool, currentFinal };
}

it('navigates older Core outputs on demand while preserving the latest tool result and exact B status', async () => {
  const { row, events } = deepOlderToolHistory('step-through-older-core-outputs');
  const app = await boot([], true, [], [], { sessions: [row], strictSessionPaging: true,
    sessionEvents: { [row.id]: events }, controls: { activeTurnId: null, automation: 'off' } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const current = pane.querySelector<HTMLDetailsElement>('.work-overview-tool-result')!;
  const previous = () => pane.querySelector<HTMLDetailsElement>('.work-overview-previous-tool-result');
  const next = () => pane.querySelector<HTMLButtonElement>('[data-work-action="find-previous-tool-result"]');
  expect(current.textContent).toContain('current B tool result');
  expect(previous()).toBeNull();
  expect(next()?.textContent).toContain('Find earlier tool result');
  expect(app.sessionReads.filter(read => read.id === row.id && read.before !== undefined)).toHaveLength(0);
  next()!.focus(); next()!.click(); await settle();
  expect(previous()?.textContent).toContain('middle C tool result');
  expect(previous()?.textContent).toContain('not current native turn exact-B-last');
  expect(current.textContent).toContain('current B tool result');
  expect(next()?.textContent).toContain('Find next earlier tool result');
  expect(app.w.document.activeElement).toBe(previous()!.querySelector('summary'));
  previous()!.open = true;
  app.notifySession(); await settle(700);
  expect(previous()!.open).toBe(true);
  expect(app.w.document.activeElement).toBe(previous()!.querySelector('summary'));
  next()!.click(); await settle();
  expect(previous()?.textContent).toContain('original A tool result');
  expect(previous()?.textContent).toContain('previous provider');
  expect(previous()?.textContent).toContain('not current native turn exact-B-last');
  expect(current.textContent).toContain('current B tool result');
  next()!.click(); await settle();
  expect(previous()?.textContent).toContain('original A tool result');
  expect(next()).toBeNull();
  expect(pane.textContent).toContain('No further earlier tool output');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Exact current B final');
  expect(app.sessionReads.filter(read => read.id === row.id && read.before !== undefined).length).toBeGreaterThan(0);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('retains the last older Core output through an interrupted next-page lookup and retries from it', async () => {
  const { row, events } = deepOlderToolHistory('interrupted-next-core-output');
  const app = await boot([], true, [], [], { sessions: [row], strictSessionPaging: true,
    sessionEvents: { [row.id]: events } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const next = () => pane.querySelector<HTMLButtonElement>('[data-work-action="find-previous-tool-result"]')!;
  next().click(); await settle();
  expect(pane.querySelector('.work-overview-previous-tool-result')?.textContent).toContain('middle C tool result');
  const ipc = (app.w as any).api, read = ipc.getSession;
  let unavailable = true;
  ipc.getSession = (id: string, query?: { before?: number }) =>
    unavailable && id === row.id && query?.before !== undefined
      ? Promise.resolve({ ok: false, error: 'Test-only older tool page outage' }) : read(id, query);
  next().click(); await settle();
  expect(pane.querySelector('.work-overview-previous-tool-result')?.textContent).toContain('middle C tool result');
  expect(next().textContent).toContain('Retry earlier tool lookup');
  expect(pane.textContent).toContain('Earlier tool output lookup was interrupted or bounded');
  unavailable = false; next().click(); await settle();
  expect(pane.querySelector('.work-overview-previous-tool-result')?.textContent).toContain('original A tool result');
  expect(pane.querySelector('.work-overview-tool-result')?.textContent).toContain('current B tool result');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('discards a pending older Core output lookup after switching the selected Work session', async () => {
  const { row, events } = deepOlderToolHistory('tool-output-before-pane-switch');
  const other = { ...summary([]), id: 'other-exact-tool-history-owner', title: 'Other exact session',
    conversationId: 'other-tool-provider', chatIds: ['other-tool-provider'],
    lastAssistantFinalAt: T0 + 30_000, lastTurnEndAt: T0 + 35_000, lastTurnOutcome: 'completed' as const };
  const foreign: SessionEvent = { kind: 'assistant_message', seq: 1, time: T0 + 30_000,
    source: 'extension', final: true, messageId: 'other-exact-final',
    message: text('Other exact session result.') };
  const app = await boot([], true, [], [], { sessions: [row, other], strictSessionPaging: true,
    sessionEvents: { [row.id]: events, [other.id]: [foreign] } });
  const ipc = (app.w as any).api, read = ipc.getSession;
  let release!: () => void;
  ipc.getSession = (id: string, query?: { before?: number }) =>
    id === row.id && query?.before !== undefined
      ? new Promise(resolve => { release = () => read(id, query).then(resolve); }) : read(id, query);
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  app.w.document.querySelector<HTMLButtonElement>('[data-work-action="find-previous-tool-result"]')!.click();
  await settle();
  expect(release).toBeTypeOf('function');
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${other.id}"]`)!.click();
  await settle();
  release(); await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Other exact session result');
  expect(pane.textContent).not.toContain('original A tool result');
  expect(pane.querySelector('.work-overview-previous-tool-result')).toBeNull();
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('navigates successive recorded older results by original position without borrowing current B custody', async () => {
  const { row, events } = deepOlderFinalAfterB('three-old-results-under-current-B');
  const saved = (seq: number, turnId: string): SessionEvent => ({
    kind: 'assistant_message', source: 'extension', seq, time: T0 + seq * 1000,
    turnId, messageId: 'saved-final-' + turnId, final: true,
    message: text('RESULT: Original recorded work from ' + turnId)
  });
  const replaced = events.map(event => event.seq === 55 ? saved(55, 'middle-C') :
    event.seq === 87 ? saved(87, 'recent-D') : event);
  const app = await boot([], true, [], [], { sessions: [row],
    strictSessionPaging: true, sessionEvents: { [row.id]: replaced },
    controls: { activeTurnId: null, automation: 'off' } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const previous = () => pane.querySelector('.work-overview-previous-result')?.textContent ?? '';
  const next = () => pane.querySelector<HTMLButtonElement>('[data-work-action="find-previous-result"]');
  expect(previous()).toContain('recent-D');
  expect(next()?.textContent).toContain('Find next earlier result');
  expect(app.sessionReads.filter(read => read.id === row.id && read.before !== undefined)).toHaveLength(0);
  next()!.focus(); next()!.click(); await settle();
  expect(previous()).toContain('middle-C');
  expect(previous()).not.toContain('recent-D');
  expect(app.w.document.activeElement).toBe(pane.querySelector('.work-overview-previous-result summary'));
  next()!.click(); await settle();
  expect(previous()).toContain('Original A supplied the exact historical work');
  next()!.click(); await settle();
  expect(previous()).toContain('Original A supplied the exact historical work');
  expect(next()).toBeNull();
  expect(pane.textContent).toContain('No further earlier saved result');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Exact current B finished');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('keeps the last visible older result during a failed next-page lookup and retries from that same result', async () => {
  const { row, events } = deepOlderFinalAfterB('stepwise-history-interruption');
  const middle: SessionEvent = { kind: 'assistant_message', source: 'extension',
    seq: 55, time: T0 + 55_000, turnId: 'middle-C', messageId: 'middle-C-result',
    final: true, message: text('RESULT: Middle C report must survive failed lookup.') };
  const app = await boot([], true, [], [], { sessions: [row], strictSessionPaging: true,
    sessionEvents: { [row.id]: events.map(event => event.seq === 55 ? middle : event) } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const next = () => pane.querySelector<HTMLButtonElement>('[data-work-action="find-previous-result"]')!;
  expect(pane.querySelector('.work-overview-previous-result')?.textContent).toContain('Middle C report');
  expect(next().textContent).toContain('Find next earlier result');
  const ipc = (app.w as any).api, read = ipc.getSession;
  let unavailable = true;
  ipc.getSession = (id: string, query?: { before?: number }) =>
    unavailable && id === row.id && query?.before !== undefined
      ? Promise.resolve({ ok: false, error: 'Test-only older-page outage' }) : read(id, query);
  next().click(); await settle();
  expect(pane.querySelector('.work-overview-previous-result')?.textContent).toContain('Middle C report');
  expect(next().textContent).toContain('Retry earlier result lookup');
  expect(pane.textContent).toContain('unavailable or bounded');
  unavailable = false; next().click(); await settle();
  expect(pane.querySelector('.work-overview-previous-result')?.textContent)
    .toContain('Original A supplied the exact historical work');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Exact current B finished');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('finds a preceding native A result only after explicit Work lookup while preserving B, focus and refresh', async () => {
  const { row, events } = deepOlderFinalAfterB('deep-B-with-earlier-A');
  const app = await boot([], true, [], [], { sessions: [row],
    strictSessionPaging: true, sessionEvents: { [row.id]: events },
    controls: { activeTurnId: null, automation: 'off' } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const current = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  expect(current.textContent).toContain('Exact current B finished');
  expect(pane.querySelector('.work-overview-previous-result')).toBeNull();
  expect(app.sessionReads.filter(read => read.id === row.id && read.before !== undefined)).toHaveLength(0);
  const find = pane.querySelector<HTMLButtonElement>('[data-work-action="find-previous-result"]')!;
  expect(find?.textContent).toContain('Find earlier saved result');
  // This navigation belongs immediately after the lookup explanation, before
  // possibly enormous saved output/history disclosures at 200% zoom.
  expect(find.parentElement?.classList.contains('work-overview-previous-lookup-actions')).toBe(true);
  expect(pane.querySelector(':scope > .work-overview-pane-grid')?.nextElementSibling).toBe(find.parentElement);
  find.focus(); find.click(); await settle();
  const previous = pane.querySelector<HTMLDetailsElement>('.work-overview-previous-result')!;
  expect(previous?.textContent).toContain('Original A supplied the exact historical work');
  expect(previous.textContent).toContain('not current native turn exact-B-last');
  expect(pane.querySelector('.work-overview-result')).toBe(current);
  expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Final answer recorded');
  expect(app.sessionReads.filter(read => read.id === row.id && read.before !== undefined).length).toBeGreaterThan(0);
  expect(app.w.document.activeElement).toBe(previous.querySelector('summary'));
  previous.open = true;
  app.notifySession(); await settle(700);
  expect(pane.querySelector('.work-overview-previous-result')).toBe(previous);
  expect(previous.open).toBe(true);
  expect(app.w.document.activeElement).toBe(previous.querySelector('summary'));
  expect(pane.querySelector('.work-overview-result')).toBe(current);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('keeps an interrupted explicit earlier-result read unverified, with one safe manual retry', async () => {
  const { row, events } = deepOlderFinalAfterB('deep-B-older-page-temporarily-failed');
  const app = await boot([], true, [], [], { sessions: [row],
    strictSessionPaging: true, sessionEvents: { [row.id]: events } });
  const ipc = (app.w as any).api;
  const originalRead = ipc.getSession;
  let fail = true;
  ipc.getSession = (id: string, query?: { before?: number }) =>
    id === row.id && query?.before !== undefined && fail
      ? Promise.resolve({ ok: false, error: 'Test-only older page outage' })
      : originalRead(id, query);
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  pane.querySelector<HTMLButtonElement>('[data-work-action="find-previous-result"]')!.click();
  await settle();
  expect(pane.querySelector('.work-overview-previous-result')).toBeNull();
  expect(pane.textContent).toContain('Earlier saved result lookup unavailable or bounded');
  expect(pane.textContent).not.toContain('No earlier result exists');
  const retry = pane.querySelector<HTMLButtonElement>('[data-work-action="find-previous-result"]')!;
  expect(retry.textContent).toContain('Retry earlier result lookup');
  fail = false; retry.focus(); retry.click(); await settle();
  expect(pane.querySelector('.work-overview-previous-result')?.textContent).toContain('Original A supplied');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Exact current B finished');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('discards an awaited earlier-result page after the user switches to another Work session', async () => {
  const { row, events } = deepOlderFinalAfterB('deep-original-before-session-switch');
  const other = { ...summary([]), id: 'different-new-owner-after-switch',
    title: 'Different exact source', conversationId: 'other-provider',
    chatIds: ['other-provider'], lastAssistantFinalAt: T0 + 30_000 };
  const foreign: SessionEvent = { kind: 'assistant_message', source: 'extension', seq: 1,
    time: T0 + 30_000, final: true, messageId: 'other-source-final',
    message: text('Different session current saved result.') };
  const app = await boot([], true, [], [], { sessions: [row, other],
    strictSessionPaging: true, sessionEvents: { [row.id]: events, [other.id]: [foreign] } });
  const ipc = (app.w as any).api, originalRead = ipc.getSession;
  let release!: () => void;
  ipc.getSession = (id: string, query?: { before?: number }) =>
    id === row.id && query?.before !== undefined
      ? new Promise(resolve => { release = () => originalRead(id, query).then(resolve); })
      : originalRead(id, query);
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  app.w.document.querySelector<HTMLButtonElement>('[data-work-action="find-previous-result"]')!.click();
  await settle();
  expect(release).toBeTypeOf('function');
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${other.id}"]`)!.click();
  await settle();
  release(); await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Different session current saved result');
  expect(pane.textContent).not.toContain('Original A supplied');
  expect(pane.querySelector('.work-overview-previous-result')).toBeNull();
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('does not publish an earlier-page result from before a newer status notification while the same Work pane stays open', async () => {
  const { row, events } = deepOlderFinalAfterB('deep-old-query-after-new-notification');
  const app = await boot([], true, [], [], { sessions: [row], strictSessionPaging: true,
    sessionEvents: { [row.id]: events } });
  const ipc = (app.w as any).api, originalRead = ipc.getSession;
  let release!: () => void;
  let holdOnePage = true;
  ipc.getSession = (id: string, query?: { before?: number }) =>
    id === row.id && query?.before !== undefined && holdOnePage
      ? new Promise(resolve => {
          holdOnePage = false;
          release = () => originalRead(id, query).then(resolve);
        })
      : originalRead(id, query);
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  pane.querySelector<HTMLButtonElement>('[data-work-action="find-previous-result"]')!.click();
  await settle();
  expect(release).toBeTypeOf('function');
  // A real notification could mean a replacement native result, correction or
  // session summary. The oldest page is still in flight, so it is not a receipt
  // for the new Work observation, even if B's turn identity has not changed.
  app.notifySession(); await settle(700);
  release(); await settle();
  expect(pane.querySelector('.work-overview-previous-result')).toBeNull();
  expect(pane.querySelector<HTMLButtonElement>('[data-work-action="find-previous-result"]')?.textContent)
    .toContain('Retry earlier result lookup');
  expect(pane.textContent).toContain('Earlier saved result lookup unavailable or bounded');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Exact current B finished');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('recovers a real previous worker finish for the selected worker without borrowing B Prime acknowledgement', async () => {
  const now = Date.now();
  const prime: SessionSummary = { ...summary([]), id: 'prime-deep-worker-previous',
    conversationId: 'prime-exact', chatIds: ['prime-exact'], title: 'Prime with no confirmed report receipt' };
  const worker: SessionSummary = { ...summary([]), id: 'worker-deep-previous-A',
    title: 'Worker B finished; older worker A report is beyond 80 events',
    conversationId: 'one-worker-provider', chatIds: ['one-worker-provider'],
    origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-1', task: 'Inspect old results' },
    activeTurnId: null, lastTurnOutcome: 'completed',
    lastFinishReportAt: now - 2_000, lastTurnEndAt: now - 1_000, updatedAt: now,
    finishTurn: { turnId: 'current-worker-B', conversationId: 'one-worker-provider',
      startedAt: now - 4_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const report = (seq: number, turnId: string, messageId: string, body: string): SessionEvent => ({
    kind: 'agent_message', source: 'app', seq, time: turnId === 'current-worker-B' ? now - 2_000 : now - 25_000,
    turnId, agent: 'worker-1', from: 'worker-1', to: 'prime', delivery: 'sent', messageId,
    message: text('[worker-1 finished] RESULT: ' + body)
  });
  const progress = (seq: number): SessionEvent => ({
    kind: 'progress', source: 'app', seq, time: now - 5_000, progressId: 'worker-depth-' + seq,
    message: text('Later observation; not a worker finish.') });
  const events: SessionEvent[] = [report(2, 'previous-worker-A', 'old-worker-result',
    'Earlier A worker checked original keyboard access; original details remain saved.'),
    ...Array.from({ length: 100 }, (_, index) => progress(index + 3)),
    { kind: 'turn_start', source: 'extension', seq: 103, time: now - 4_000,
      turnId: 'current-worker-B' },
    report(110, 'current-worker-B', 'current-worker-result', 'New B worker checked latest status.'),
    ...Array.from({ length: 44 }, (_, index) => progress(index + 111))];
  worker.events = events.length;
  const app = await boot([], true, [], [], { sessions: [prime, worker], strictSessionPaging: true,
    sessionEvents: { [worker.id]: events, [prime.id]: [] }, controls: { activeTurnId: null } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${worker.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('New B worker checked latest status');
  expect(pane.querySelector('.work-overview-previous-result')).toBeNull();
  pane.querySelector<HTMLButtonElement>('[data-work-action="find-previous-result"]')!.click();
  await settle();
  expect(pane.querySelector('.work-overview-previous-result')?.textContent)
    .toContain('Earlier A worker checked original keyboard access');
  const field = (name: string) => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
  expect(field('Prime receipt')).not.toContain('Prime received this report');
  expect(field('Prime receipt')).toMatch(/unverified|unavailable/);
  expect(pane.textContent).toContain('not current native turn current-worker-B');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('looks back more than one page for the previous result but never pages on subsequent status-only updates', async () => {
  const { row, earlier, current } = deepOlderFinalAfterB('deep-two-pages-current-B');
  current.seq = 350; current.time = T0 + 350_000;
  row.lastAssistantFinalAt = current.time;
  row.lastTurnEndAt = T0 + 398_000;
  row.updatedAt = T0 + 399_000;
  row.finishTurn!.startedAt = T0 + 340_000;
  const status = (seq: number): SessionEvent => ({ kind: 'progress', source: 'app',
    seq, time: T0 + seq * 1000, progressId: 'multi-page-' + seq,
    message: text('Existing progress observation, not a final.') });
  const events: SessionEvent[] = [earlier,
    ...Array.from({ length: 339 }, (_, i) => status(i + 3)),
    { kind: 'turn_start', source: 'extension', seq: 345, time: T0 + 340_000,
      turnId: 'exact-B-last' }, current,
    ...Array.from({ length: 42 }, (_, i) => status(i + 351))];
  row.events = events.length;
  const app = await boot([], true, [], [], { sessions: [row],
    strictSessionPaging: true, sessionEvents: { [row.id]: events } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  expect(app.sessionReads.filter(read => read.id === row.id && read.before !== undefined)).toHaveLength(0);
  app.w.document.querySelector<HTMLButtonElement>('[data-work-action="find-previous-result"]')!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.querySelector('.work-overview-previous-result')?.textContent).toContain('Original A supplied');
  const readCount = app.sessionReads.filter(read => read.id === row.id && read.before !== undefined).length;
  expect(readCount).toBeGreaterThan(1);
  app.notifySession(); await settle(700);
  expect(app.sessionReads.filter(read => read.id === row.id && read.before !== undefined)).toHaveLength(readCount);
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Exact current B finished');
  expect(app.live.sent).toEqual([]);
});

it('reports checked history without inventing an earlier result when no earlier final was recorded', async () => {
  const { row, events } = deepOlderFinalAfterB('deep-B-no-older-final');
  const noPrevious = events.filter(event => event.seq !== 2);
  row.events = noPrevious.length;
  const app = await boot([], true, [], [], { sessions: [row],
    strictSessionPaging: true, sessionEvents: { [row.id]: noPrevious } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  pane.querySelector<HTMLButtonElement>('[data-work-action="find-previous-result"]')!.click();
  await settle();
  expect(pane.querySelector('.work-overview-previous-result')).toBeNull();
  expect(pane.textContent).toContain('No additional final or finished-worker result was found');
  expect(pane.querySelector('[data-work-action="find-previous-result"]')).toBeNull();
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Exact current B finished');
  expect(app.live.sent).toEqual([]);
});

it('keeps a previous worker-to-Prime report readable without promoting it to a later finished native B turn', async () => {
  const now = Date.now(), id = 'worker-A-report-finished-B';
  const worker: SessionSummary = { ...summary([]), id,
    title: 'Worker report from A; B returned without one',
    conversationId: 'worker-same-provider', chatIds: ['worker-same-provider'],
    origin: { kind: 'worker', fromSessionId: 'prime-original', agentId: 'worker-A', task: 'Review' },
    activeTurnId: null, lastFinishReportAt: now - 1_000, lastTurnEndAt: now - 2_000,
    lastTurnOutcome: 'failed', updatedAt: now,
    finishTurn: { turnId: 'worker-B', conversationId: 'worker-same-provider',
      startedAt: now - 4_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const events: SessionEvent[] = [
    { kind: 'turn_start', source: 'extension', seq: 1, time: now - 7_000, turnId: 'worker-A' },
    { kind: 'turn_start', source: 'extension', seq: 2, time: now - 4_000, turnId: 'worker-B' },
    { kind: 'turn_end', source: 'extension', seq: 3, time: now - 2_000,
      turnId: 'worker-B', outcome: 'failed' },
    { kind: 'agent_message', source: 'app', seq: 4, time: now - 1_000, turnId: 'worker-A',
      from: 'worker-A', to: 'prime', agent: 'worker-A', delivery: 'sent',
      messageId: 'saved-old-A-worker-report',
      message: text('[worker-A finished] RESULT: Prior A worker produced a useful validated report.') }
  ];
  const app = await boot([], true, [], [], { sessions: [worker],
    sessionEvents: { [id]: events }, controls: { automation: 'off', activeTurnId: null } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (label: string) => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(node => node.querySelector('b')?.textContent === label)?.textContent ?? '';
  expect(field('Just did')).not.toContain('Worker report saved for Prime');
  expect(field('Just did')).toContain('Latest turn failed');
  expect(pane.querySelector('.work-overview-result summary')?.textContent).toContain('previous');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Prior A worker produced');
  expect(field('Prime receipt')).toContain('unavailable');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('keeps an A final readable without labeling it B current work when B turn-start is outside the retained window', async () => {
  const now = Date.now();
  const owner: SessionSummary = { ...summary([]), id: 'old-final-while-new-turn-start-evicted',
    title: 'Previously completed answer after new native turn starts',
    conversationId: 'same-provider-ongoing-turn', chatIds: ['same-provider-ongoing-turn'],
    activeTurnId: 'new-turn-B', lastMessageAt: now - 100, updatedAt: now,
    lastAssistantFinalAt: now - 7_000, lastToolCallAt: null,
    activityExpiresAt: now - 1_000 };
  // The backend still knows B is active. Its recorder turn_start could be
  // evicted by many progress/tool observations; A's old final is the one
  // retained result in this bounded UI read.
  const previous: SessionEvent = { kind: 'assistant_message', seq: 2, time: now - 7_000,
    source: 'extension', turnId: 'old-turn-A', messageId: 'old-turn-A-final',
    final: true, state: 'final', message: text('RESULT: Earlier A work finished; B has no recorded final.') };
  const app = await boot([], true, [], [], { sessions: [owner],
    sessionEvents: { [owner.id]: [previous] }, controls: { activeTurnId: 'new-turn-B' } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${owner.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (name: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === name)?.textContent ?? '';
  expect(field('Just did')).toContain('no exact current-turn final');
  expect(field('Just did')).not.toContain('Recorded final: RESULT: Earlier A');
  expect(pane.querySelector('.work-overview-result > summary')?.textContent)
    .toBe('Read previous recorded final answer');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Earlier A work finished');
  expect(app.live.sent).toEqual([]);
});

it('keeps a rebound worker report in updates without claiming current provider attribution', async () => {
  const selected = summary([]);
  const worker = {
    ...summary([]), id: 'rebound-saved-worker', title: 'Rebound worker evidence',
    conversationId: 'provider-B', chatIds: ['provider-A', 'provider-B'],
    origin: { kind: 'worker' as const, fromSessionId: selected.id, agentId: 'worker-1', task: 'Review' },
    lastFinishReportAt: T0 + 60_000, lastToolCallAt: T0 + 35_000,
    activityExpiresAt: null
  };
  const { w } = await boot([], true, [], [], { sessions: [selected, worker] });
  const updates = w.document.querySelectorAll('.work-overview-section')[1]!;
  const row = updates.querySelector<HTMLButtonElement>('.work-overview-row')!;
  expect(row.dataset.sessionId).toBe(worker.id);
  expect(row.textContent).toContain('Saved worker report · provider unverified');
  expect(row.textContent).toContain('current provider and turn require exact report evidence');
  expect(row.textContent).not.toContain('Worker report saved');
});

it('does not promote a saved A one-off final or A native delivery as current B work in the Work list', async () => {
  const now = Date.now();
  const oldFinal: SessionSummary = { ...summary([]), id: 'rebound-old-final-feed',
    title: 'Old answer stays readable after native provider rebinding',
    conversationId: 'final-provider-B', chatIds: ['final-provider-A', 'final-provider-B'],
    lastAssistantFinalAt: now - 3_000, lastToolCallAt: null,
    lastTurnEndAt: now - 2_800, lastTurnOutcome: 'completed', activeTurnId: null };
  const oldDelivery: SessionSummary = { ...summary([]), id: 'rebound-old-delivery-feed',
    title: 'Old native Send remains with original conversation',
    conversationId: 'delivery-provider-B', chatIds: ['delivery-provider-A', 'delivery-provider-B'],
    lastAssistantFinalAt: null, lastToolCallAt: null };
  const input: InputEntry = { id: 'old-provider-delivery-id', sessionId: oldDelivery.id,
    conversationId: 'delivery-provider-A', mode: 'auto', text: 'Previously saved request',
    model: 'gpt-6-thinking', reasoningEffort: 'xhigh', dueAt: 0,
    state: 'cancelled', createdAt: now - 5_000, owner: 'old-claimed-browser',
    deliveredAt: now - 1_000, messageId: 'original-native-A-message',
    error: 'Answer collection no longer attached to current provider.' };
  const app = await boot([], true, [], [], { sessions: [oldFinal, oldDelivery], inputs: [input] });
  const updates = app.w.document.querySelector<HTMLElement>('[data-work-section="updates"]')!;
  const final = updates.querySelector<HTMLButtonElement>(`[data-session-id="${oldFinal.id}"]`)!;
  const delivery = updates.querySelector<HTMLButtonElement>(`[data-session-id="${oldDelivery.id}"]`)!;
  expect(final.textContent).toContain('Saved final · provider unverified');
  expect(final.textContent).toContain('exact current provider and turn');
  expect(final.textContent).not.toContain('Final answer recorded');
  expect(delivery.textContent).toContain('Previous-provider delivery retained');
  expect(delivery.textContent).toContain('current-provider Send unverified');
  expect(delivery.textContent).not.toContain('Native delivery retained');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('recovers a retained one-off final beyond the 80-event tail without making it current after a failed resumed turn', async () => {
  const selected = summary([]);
  const oldFinalAt = T0 + 4_000;
  const oneoff: SessionSummary = { ...summary([]), id: 'deep-history-oneoff',
    title: 'One-off whose answer preceded long tool activity',
    conversationId: 'resumed-oneoff-provider', chatIds: ['original-oneoff-provider', 'resumed-oneoff-provider'],
    lastAssistantFinalAt: oldFinalAt, lastToolCallAt: T0 + 185_000,
    lastTurnEndAt: T0 + 186_000, lastTurnOutcome: 'failed', activeTurnId: null,
    finishTurn: { turnId: 'later-failed-turn', conversationId: 'resumed-oneoff-provider',
      startedAt: T0 + 9_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const final: SessionEvent = { kind: 'assistant_message', seq: 3, time: oldFinalAt,
    source: 'extension', turnId: 'earlier-completed-turn', messageId: 'genuine-shape-saved-final', final: true,
    message: text('RESULT: Earlier one-off output. VALIDATION: previous run only. BLOCKERS: New turn failed.') };
  const later: SessionEvent[] = Array.from({ length: 178 }, (_, index) => {
    const event = toolCall(index + 6, `later-tool-${index}`) as Extract<SessionEvent, { kind: 'tool_call' }>;
    return { ...event, time: T0 + (index + 7) * 1000, turnId: 'later-failed-turn',
      call: { ...event.call, conversationId: oneoff.conversationId } };
  });
  const denied = later.at(-1)! as Extract<SessionEvent, { kind: 'tool_call' }>;
  denied.call.outcome = 'tool_rejected';
  denied.call.summary = { kind: 'read', title: 'Current failed read after much later work', tone: 'bad' };
  const source: SessionEvent[] = [
    { kind: 'turn_start', seq: 1, time: T0 + 1_000, source: 'extension', turnId: 'earlier-completed-turn' },
    { ...toolCall(2, 'original-success'), turnId: 'earlier-completed-turn' }, final,
    { kind: 'turn_end', seq: 4, time: T0 + 5_000, source: 'extension', turnId: 'earlier-completed-turn', outcome: 'completed' },
    { kind: 'turn_start', seq: 5, time: T0 + 9_000, source: 'extension', turnId: 'later-failed-turn' },
    ...later,
    { kind: 'turn_end', seq: 184, time: T0 + 186_000, source: 'extension', turnId: 'later-failed-turn', outcome: 'failed' }
  ];
  oneoff.events = source.length;
  const app = await boot([], true, [], [], { sessions: [selected, oneoff],
    sessionEvents: { [oneoff.id]: source }, strictSessionPaging: true });
  const row = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${oneoff.id}"]`)!;
  expect(row.textContent).toContain('Previous final retained');
  row.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid).toContain('Current failed read after much later work');
  expect(justDid).not.toContain('Earlier one-off output');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read previous recorded final answer');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('VALIDATION: previous run only');
  expect(app.sessionReads.some(read => read.id === oneoff.id && typeof read.before === 'number')).toBe(true);
  const historicReads = app.sessionReads.filter(read => read.id === oneoff.id && read.before !== undefined).length;
  app.notifySession();
  await settle(700);
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Earlier one-off output');
  expect(app.sessionReads.filter(read => read.id === oneoff.id && read.before !== undefined)).toHaveLength(historicReads);
  pane.querySelector<HTMLButtonElement>('[data-work-action="open"]')!.click();
  await settle();
  expect(app.w.document.getElementById('chatTitle')!.textContent).toBe(oneoff.title);
  expect(app.w.document.getElementById('progressToggle')?.getAttribute('aria-pressed')).toBe('true');
  expect(app.live.sent).toEqual([]);
});

it('does not promote a recovered historical final when the newer empty turn start is also outside the recent event tail', async () => {
  const selected = summary([]);
  const row: SessionSummary = { ...summary([]), id: 'old-final-and-evicted-turn-start',
    title: 'Saved one-off, later progress-only turn', conversationId: 'current-provider-chat',
    chatIds: ['older-provider-chat', 'current-provider-chat'],
    lastAssistantFinalAt: T0 + 4_000, lastToolCallAt: T0 + 2_000,
    activeTurnId: null, lastTurnOutcome: 'completed', lastTurnEndAt: T0 + 170_000,
    finishTurn: { turnId: 'empty-newer-turn', conversationId: 'current-provider-chat',
      startedAt: T0 + 10_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const source: SessionEvent[] = [
    { kind: 'turn_start', seq: 1, time: T0 + 1_000, source: 'extension', turnId: 'completed-old-turn' },
    { ...toolCall(2, 'old-saved-tool'), turnId: 'completed-old-turn' },
    { kind: 'assistant_message', seq: 3, time: T0 + 4_000, source: 'extension',
      turnId: 'completed-old-turn', messageId: 'old-saved-answer', final: true,
      message: text('An older completed result is retained in this exact local session.') },
    { kind: 'turn_end', seq: 4, time: T0 + 5_000, source: 'extension',
      turnId: 'completed-old-turn', outcome: 'completed' },
    { kind: 'turn_start', seq: 5, time: T0 + 10_000, source: 'extension', turnId: 'empty-newer-turn' },
    ...Array.from({ length: 155 }, (_, index): SessionEvent => ({ kind: 'progress',
      seq: index + 6, time: T0 + (index + 12) * 1000, source: 'app',
      turnId: 'empty-newer-turn', progressId: `newer-not-a-result-${index}`,
      message: text('A later informational update is not an accepted result.') })),
    { kind: 'turn_end', seq: 161, time: T0 + 170_000, source: 'extension',
      turnId: 'empty-newer-turn', outcome: 'completed' }
  ];
  row.events = source.length;
  const app = await boot([], true, [], [], { sessions: [selected, row], strictSessionPaging: true,
    sessionEvents: { [row.id]: source } });
  const update = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!;
  expect(update.textContent).toContain('Previous final retained');
  update.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid).toContain('Latest turn completed; no exact final or tool outcome recorded.');
  expect(justDid).not.toContain('Recorded final: An older completed result');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read previous recorded final answer');
});

it('keeps the newest durable revision of one saved final when its stable message time and ID do not change', async () => {
  const selected = summary([]);
  const row = { ...summary([]), id: 'revised-saved-final-in-long-history',
    title: 'One-off result revised after an older cached read',
    conversationId: 'stable-revised-provider', chatIds: ['stable-revised-provider'],
    lastAssistantFinalAt: T0 + 4_000, lastToolCallAt: T0 + 114_000,
    lastTurnOutcome: 'failed' as const,
    finishTurn: { turnId: 'later-failed', conversationId: 'stable-revised-provider',
      startedAt: T0 + 10_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const first: SessionEvent = { kind: 'assistant_message', seq: 3, origin: 3,
    time: T0 + 4_000, source: 'extension', turnId: 'older-completed', messageId: 'canonical-answer',
    final: true, message: text('RESULT version one; subsequently revised.') };
  const source: SessionEvent[] = [first,
    ...Array.from({ length: 110 }, (_, i) => ({ ...toolCall(i + 4, `initial-activity-${i}`),
      turnId: 'later-failed' }))];
  row.events = source.length;
  const app = await boot([], true, [], [], { sessions: [selected, row], strictSessionPaging: true,
    sessionEvents: { [row.id]: source } });
  const update = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!;
  update.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('RESULT version one');
  source.push({ ...first, seq: 114, semanticUpdatedAt: T0 + 300_000,
    message: text('RESULT version two; corrected, final saved text.') });
  row.events = source.length;
  app.notifySession();
  await settle(700);
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('RESULT version two');
  source.push(...Array.from({ length: 95 }, (_, i) => ({ ...toolCall(i + 115, `subsequent-activity-${i}`),
    turnId: 'later-failed' })));
  row.events = source.length;
  app.notifySession();
  await settle(700);
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('RESULT version two');
  expect(pane.querySelector('.work-overview-result')?.textContent).not.toContain('RESULT version one');
});

it('does not mistake an older final revision for the newest distinct completed result after both leave the recent tail', async () => {
  const selected = summary([]);
  const row = { ...summary([]), id: 'two-finals-and-older-revision',
    title: 'Two independently completed results and an old correction',
    conversationId: 'two-final-provider', chatIds: ['two-final-provider'],
    lastAssistantFinalAt: T0 + 50_000, lastToolCallAt: T0 + 110_000,
    activeTurnId: null, lastTurnOutcome: 'failed' as const,
    finishTurn: { turnId: 'third-failed-turn', conversationId: 'two-final-provider',
      startedAt: T0 + 60_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const first: SessionEvent = { kind: 'assistant_message', seq: 3, origin: 3,
    time: T0 + 3_000, source: 'extension', turnId: 'first-turn', messageId: 'first-result',
    final: true, message: text('Earlier distinct result; revised after a later final.') };
  const second: SessionEvent = { kind: 'assistant_message', seq: 50, origin: 50,
    time: T0 + 50_000, source: 'extension', turnId: 'second-turn', messageId: 'second-result',
    final: true, message: text('NEWEST separate completed result belongs to turn two.') };
  const revisedFirst: SessionEvent = { ...first, seq: 110, semanticUpdatedAt: T0 + 150_000,
    message: text('Correction to earlier distinct result, not a new turn.') };
  const source: SessionEvent[] = [first, second, revisedFirst,
    ...Array.from({ length: 107 }, (_, i) => i + 1).filter(seq => seq !== 3 && seq !== 50)
      .map(seq => ({ ...toolCall(seq, `progress-between-${seq}`), turnId: 'third-failed-turn' }))]
    .sort((a, b) => a.seq - b.seq);
  row.events = source.length;
  const app = await boot([], true, [], [], { sessions: [selected, row], strictSessionPaging: true,
    sessionEvents: { [row.id]: source } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('NEWEST separate completed result');
  source.push(...Array.from({ length: 100 }, (_, i) => ({ ...toolCall(111 + i, `even-later-${i}`),
    turnId: 'third-failed-turn' })));
  row.events = source.length;
  app.notifySession();
  await settle(700);
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('NEWEST separate completed result');
  expect(pane.querySelector('.work-overview-result')?.textContent).not.toContain('Correction to earlier distinct result');
});

it('recovers the newest distinct final on cold reopen when only an old answer revision remains in the 80-event tail', async () => {
  const selected = summary([]);
  const row = { ...summary([]), id: 'cold-revision-supersession', title: 'Resumed one-off with multiple saved outputs',
    conversationId: 'cold-revision-provider', chatIds: ['before-resume-provider', 'cold-revision-provider'],
    lastAssistantFinalAt: T0 + 50_000, lastToolCallAt: T0 + 240_000,
    lastTurnOutcome: 'failed' as const, activeTurnId: null,
    finishTurn: { turnId: 'latest-failed-turn', conversationId: 'cold-revision-provider',
      startedAt: T0 + 80_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const oldResult: SessionEvent = { kind: 'assistant_message', seq: 3, origin: 3,
    time: T0 + 3_000, source: 'extension', turnId: 'older-result-turn',
    messageId: 'revised-but-older', final: true, message: text('First result later edited; still historical.') };
  const mostRecentResult: SessionEvent = { kind: 'assistant_message', seq: 50, origin: 50,
    time: T0 + 50_000, source: 'extension', turnId: 'newer-result-turn',
    messageId: 'the-actually-newest-final', final: true,
    message: text('LATEST DISTINCT completed result after the first result.') };
  const oldRevision: SessionEvent = { ...oldResult, seq: 205,
    semanticUpdatedAt: T0 + 240_000,
    message: text('Old-result revision arrived late after second result; do not promote.') };
  const source: SessionEvent[] = [oldResult, mostRecentResult, oldRevision,
    ...Array.from({ length: 235 }, (_, index) => index + 4)
      .filter(seq => seq !== 50 && seq !== 205)
      .map(seq => ({ ...toolCall(seq, `latest-turn-call-${seq}`), turnId: 'latest-failed-turn' }))]
    .sort((a, b) => a.seq - b.seq);
  row.events = source.length;
  const app = await boot([], true, [], [], {
    sessions: [selected, row], strictSessionPaging: true,
    sessionEvents: { [row.id]: source }
  });
  const button = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!;
  button.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const read = pane.querySelector<HTMLElement>('.work-overview-result-body')?.textContent ?? '';
  expect(read).toContain('LATEST DISTINCT completed result');
  expect(read).not.toContain('Old-result revision arrived late');
  expect(app.sessionReads.some(entry => entry.id === row.id && entry.before !== undefined)).toBe(true);
  expect(pane.querySelector('.work-overview-result summary')?.textContent).toBe('Read previous recorded final answer');
});

it('finds an exact Prime receipt beyond both 80-event tails for a reused worker without claiming current success', async () => {
  const prime = { ...summary([]), id: 'deep-receipt-prime', title: 'Original Prime with durable receipt',
    conversationId: 'prime-new-provider', chatIds: ['prime-old-provider', 'prime-new-provider'] };
  const worker = { ...summary([]), id: 'deep-receipt-worker', title: 'Worker after a later failed turn',
    conversationId: 'worker-new-provider', chatIds: ['worker-old-provider', 'worker-new-provider'],
    origin: { kind: 'worker' as const, fromSessionId: prime.id, agentId: 'worker-1', task: 'Review status' },
    lastFinishReportAt: T0 + 4_000, lastToolCallAt: T0 + 165_000,
    lastTurnOutcome: 'failed' as const, activeTurnId: null,
    finishTurn: { turnId: 'worker-failed-turn', conversationId: 'worker-new-provider',
      startedAt: T0 + 9_000, notified: false, released: true, decisionRevision: null,
      workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const report: SessionEvent = { kind: 'agent_message', seq: 3, time: T0 + 4_000,
    source: 'app', agent: 'worker-1', messageId: 'worker-exact-saved-report',
    from: 'worker-1', to: 'prime', delivery: 'sent',
    message: text('[worker-1 finished] RESULT: Saved analysis completed in an earlier turn.') };
  const receipt: SessionEvent = { ...report, seq: 4, time: T0 + 5_000, agent: 'prime', delivery: 'delivered' };
  const workerEvents: SessionEvent[] = [
    { kind: 'turn_start', seq: 1, time: T0 + 1_000, source: 'extension', turnId: 'worker-original-turn' },
    { ...toolCall(2, 'worker-success'), turnId: 'worker-original-turn' }, report,
    { kind: 'turn_start', seq: 5, time: T0 + 9_000, source: 'extension', turnId: 'worker-failed-turn' },
    ...Array.from({ length: 160 }, (_, index) => ({ ...toolCall(index + 6, `worker-later-${index}`),
      turnId: 'worker-failed-turn' })),
    { kind: 'turn_end', seq: 166, time: T0 + 166_000, source: 'extension',
      turnId: 'worker-failed-turn', outcome: 'failed' }
  ];
  const workerLastTool = workerEvents.at(-2)! as Extract<SessionEvent, { kind: 'tool_call' }>;
  workerLastTool.call.outcome = 'tool_rejected';
  workerLastTool.call.summary = { kind: 'read', title: 'Later worker check rejected', tone: 'bad' };
  const primeEvents: SessionEvent[] = [
    { ...toolCall(1, 'prime-earlier-tool'), turnId: 'prime-prior-turn' }, receipt,
    ...Array.from({ length: 160 }, (_, index) => ({ ...toolCall(index + 5, `prime-later-${index}`),
      turnId: 'prime-newer-turn' }))
  ];
  worker.events = workerEvents.length;
  prime.events = primeEvents.length;
  const app = await boot([], true, [], [], { sessions: [prime, worker], strictSessionPaging: true,
    sessionEvents: { [prime.id]: primeEvents, [worker.id]: workerEvents } });
  const row = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${worker.id}"]`)!;
  expect(row.textContent).toContain('Saved worker report · provider unverified');
  row.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Later worker check rejected');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read previous saved worker report');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Saved analysis completed in an earlier turn');
  expect(pane.textContent).toContain('Prime received this report');
  expect(pane.textContent).not.toContain('Prime accepted the work');
  expect(app.sessionReads.some(read => read.id === worker.id && read.before !== undefined)).toBe(true);
  expect(app.sessionReads.some(read => read.id === prime.id && read.before !== undefined)).toBe(true);
  const previous = app.sessionReads.filter(read => read.before !== undefined).length;
  app.notifySession();
  await settle(700);
  expect(pane.textContent).toContain('Prime received this report');
  expect(app.sessionReads.filter(read => read.before !== undefined)).toHaveLength(previous);
});

it('offers a deliberate retry when older Prime receipt history cannot be verified', async () => {
  const prime = { ...summary([]), id: 'prime-older-receipt-retry', title: 'Prime with older recipient ACK' };
  const worker = { ...summary([]), id: 'worker-older-receipt-retry', title: 'Saved worker result',
    conversationId: 'worker-receipt-retry-provider', chatIds: ['worker-receipt-retry-provider'],
    origin: { kind: 'worker' as const, fromSessionId: prime.id, agentId: 'worker-1', task: 'Inspect evidence' },
    lastFinishReportAt: T0 + 40_000, lastToolCallAt: T0 + 20_000 };
  const report: SessionEvent = { kind: 'agent_message', seq: 2, time: T0 + 40_000, source: 'app',
    agent: 'worker-1', messageId: 'exact-retry-worker-report', from: 'worker-1', to: 'prime',
    delivery: 'sent', message: text('[worker-1 finished] RESULT: Saved review remains available.') };
  const receipt: SessionEvent = { ...report, seq: 2, time: T0 + 41_000, agent: 'prime', delivery: 'delivered' };
  const primeEvents: SessionEvent[] = [receipt,
    ...Array.from({ length: 110 }, (_, index) => toolCall(index + 3, `later-prime-${index}`))];
  prime.events = primeEvents.length;
  worker.events = 1;
  const app = await boot([], true, [], [], { sessions: [prime, worker], strictSessionPaging: true,
    sessionEvents: { [prime.id]: primeEvents, [worker.id]: [report] } });
  const originalRead = (app.w as any).api.getSession;
  let failOlder = true;
  (app.w as any).api.getSession = (id: string, query?: { before?: number }) =>
    id === prime.id && query?.before !== undefined && failOlder
      ? Promise.resolve({ ok: false, error: 'Prime older history read failed' })
      : originalRead(id, query);
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${worker.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Prime receipt unavailable');
  expect(pane.textContent).not.toContain('Prime received this report');
  const retry = pane.querySelector<HTMLButtonElement>('[data-work-action="retry-older"]')!;
  expect(retry?.textContent).toBe('Retry older history');
  failOlder = false;
  retry.click();
  await settle();
  expect(pane.textContent).toContain('Prime received this report');
  expect(pane.querySelector('[data-work-action="retry-older"]')).toBeNull();
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('allows a failed historical-result page to be retried without inventing a current final', async () => {
  const selected = summary([]);
  const oneoff = { ...summary([]), id: 'failed-old-result-read', title: 'Retained one-off with intermittent history',
    conversationId: 'same-stable-provider', chatIds: ['same-stable-provider'],
    lastAssistantFinalAt: T0 + 3_000, lastToolCallAt: T0 + 120_000,
    lastTurnOutcome: 'failed' as const, activeTurnId: null,
    finishTurn: { turnId: 'later-failed', conversationId: 'same-stable-provider', startedAt: T0 + 8_000,
      notified: false, released: true, decisionRevision: null, workSeq: 0, decisionSeq: 0,
      decisionInputRevision: null } };
  const events: SessionEvent[] = [
    { kind: 'assistant_message', seq: 3, time: T0 + 3_000, source: 'extension',
      turnId: 'earlier-completed', messageId: 'older-real-final', final: true,
      message: text('Earlier implementation accepted for this one-off.') },
    { kind: 'turn_start', seq: 4, time: T0 + 8_000, source: 'extension', turnId: 'later-failed' },
    ...Array.from({ length: 108 }, (_, index): SessionEvent => ({ ...toolCall(index + 5, `later-${index}`),
      turnId: 'later-failed' }))
  ];
  oneoff.events = events.length;
  const app = await boot([], true, [], [], { sessions: [selected, oneoff], strictSessionPaging: true,
    sessionEvents: { [oneoff.id]: events } });
  const originalRead = (app.w as any).api.getSession;
  let rejectOlder = true;
  (app.w as any).api.getSession = (id: string, query?: { before?: number }) =>
    id === oneoff.id && query?.before !== undefined && rejectOlder
      ? Promise.resolve({ ok: false, error: 'Exact older history is temporarily unavailable.' })
      : originalRead(id, query);
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${oneoff.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('temporarily unavailable');
  expect(pane.textContent).not.toContain('Earlier implementation accepted');
  const retry = pane.querySelector<HTMLButtonElement>('[data-work-action="retry-older"]')!;
  expect(retry).toBeTruthy();
  rejectOlder = false;
  retry.click();
  await settle();
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Earlier implementation accepted');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read previous recorded final answer');
  expect(app.live.sent).toEqual([]);
});

it('discards an older session result returned after its Work detail was switched to a different session', async () => {
  const original = { ...summary([]), id: 'late-page-original', title: 'Original saved source result',
    conversationId: 'original-page-chat', chatIds: ['original-page-chat'],
    lastAssistantFinalAt: T0 + 4_000, lastToolCallAt: T0 + 130_000,
    lastTurnOutcome: 'failed' as const,
    finishTurn: { turnId: 'latest-failed', conversationId: 'original-page-chat',
      startedAt: T0 + 7_000, notified: false, released: true, decisionRevision: null,
      workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const other = { ...summary([]), id: 'different-page-session', title: 'Different owned one-off result',
    conversationId: 'different-page-chat', chatIds: ['different-page-chat'],
    lastAssistantFinalAt: T0 + 70_000, lastToolCallAt: T0 + 3_000 };
  const originalEvents: SessionEvent[] = [
    { kind: 'assistant_message', seq: 3, time: T0 + 4_000, source: 'extension',
      messageId: 'original-saved-result', final: true, message: text('Only original session owns this older output.') },
    ...Array.from({ length: 110 }, (_, i): SessionEvent => ({ ...toolCall(i + 4, `original-later-${i}`),
      turnId: 'latest-failed' }))
  ];
  const otherEvents: SessionEvent[] = [
    { kind: 'assistant_message', seq: 3, time: T0 + 70_000, source: 'extension',
      messageId: 'other-saved-result', final: true, message: text('Different session owns this result.') }
  ];
  original.events = originalEvents.length;
  other.events = otherEvents.length;
  const app = await boot([], true, [], [], { sessions: [original, other], strictSessionPaging: true,
    sessionEvents: { [original.id]: originalEvents, [other.id]: otherEvents } });
  const nativeApi = (app.w as any).api;
  const read = nativeApi.getSession;
  let resolveDelayed!: () => void;
  let firstOlder = true;
  nativeApi.getSession = (id: string, query?: { before?: number }) => {
    if (id === original.id && query?.before !== undefined && firstOlder) {
      firstOlder = false;
      return new Promise(resolve => { resolveDelayed = () => void read(id, query).then(resolve); });
    }
    return read(id, query);
  };
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-row[data-session-id="${original.id}"]`)!.click();
  await settle();
  expect(resolveDelayed).toBeTypeOf('function');
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-row[data-session-id="${other.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Different session owns this result.');
  resolveDelayed();
  await settle();
  expect(pane.textContent).toContain('Different session owns this result.');
  expect(pane.textContent).not.toContain('Only original session owns');
  expect(app.w.document.querySelectorAll('.work-overview-row[aria-expanded="true"]')).toHaveLength(1);
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-row[data-session-id="${original.id}"]`)!.click();
  await settle();
  expect(pane.textContent).toContain('Only original session owns this older output.');
  expect(pane.textContent).not.toContain('Different session owns this result.');
});

it('retains a closed one-off final in Recent updates when its native create_time precedes the last tool', async () => {
  const selected = summary([]);
  const makeFinish = (turnId: string, startedAt: number) => ({
    turnId, conversationId: 'one-off-conversation', startedAt, notified: false, released: true,
    decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null
  });
  const done = { ...summary([]), id: 'closed-early-final', title: 'Completed one-off with late tool',
    conversationId: 'one-off-conversation', chatIds: ['one-off-conversation'],
    endedAt: T0 + 7_000, lastAssistantFinalAt: T0 + 2_000, lastToolCallAt: T0 + 5_000,
    lastTurnEndAt: T0 + 6_000, lastTurnOutcome: 'completed' as const,
    finishTurn: makeFinish('completed-turn', T0 + 1_000) };
  // A completed newer turn without a final of its own may expose the older result only
  // as historical; it must never report that previous answer as the latest final.
  const noFreshFinal = { ...done, id: 'closed-no-new-final', title: 'Later completed turn without final',
    lastToolCallAt: T0 + 9_000, lastTurnEndAt: T0 + 10_000,
    finishTurn: makeFinish('later-no-final', T0 + 7_000) };
  const stopped = { ...done, id: 'stopped-after-early-final', title: 'Stopped turn',
    lastTurnOutcome: 'stopped' as const };
  const stillRunning = { ...done, id: 'open-after-early-final', title: 'New turn is still running',
    activeTurnId: 'another-turn' };
  const tool = toolCall(2, 'one-off-late-tool') as Extract<SessionEvent, { kind: 'tool_call' }>;
  tool.turnId = 'completed-turn';
  tool.time = T0 + 5_000;
  tool.call.summary = { kind: 'read', title: 'Retained evidence before final', tone: 'neutral' };
  const events: SessionEvent[] = [
    { kind: 'turn_start', seq: 1, time: T0 + 1_000, source: 'extension', turnId: 'completed-turn' },
    tool,
    { kind: 'assistant_message', seq: 3, time: T0 + 2_000, source: 'extension', turnId: 'completed-turn',
      messageId: 'early-final-one-off', final: true, message: text('Finished the one-off after the recorded tool.') },
    { kind: 'turn_end', seq: 4, time: T0 + 6_000, source: 'extension',
      turnId: 'completed-turn', outcome: 'completed' }
  ];
  const laterTool = toolCall(6, 'newer-tool-no-final') as Extract<SessionEvent, { kind: 'tool_call' }>;
  laterTool.time = T0 + 9_000;
  laterTool.turnId = 'later-no-final';
  laterTool.call.summary = { kind: 'read', title: 'New turn read evidence only', tone: 'neutral' };
  const noFreshEvents: SessionEvent[] = [...events,
    { kind: 'turn_start', seq: 5, time: T0 + 7_000, source: 'extension', turnId: 'later-no-final' },
    laterTool,
    { kind: 'turn_end', seq: 7, time: T0 + 10_000, source: 'extension',
      turnId: 'later-no-final', outcome: 'completed' }];
  const app = await boot([], true, [], [], {
    sessions: [selected, done, noFreshFinal, stopped, stillRunning],
    sessionEvents: { [done.id]: events, [noFreshFinal.id]: noFreshEvents }
  });
  const updates = app.w.document.querySelector<HTMLElement>('.work-overview-section[data-work-section="updates"]')!;
  const rows = [...updates.querySelectorAll<HTMLButtonElement>('.work-overview-row')];
  // All four records are discoverable. Their sort is by the actual saved
  // result/tool timestamp, not by fixture creation order or final-answer rank.
  expect(new Set(rows.map(row => row.dataset.sessionId)))
    .toEqual(new Set([done.id, noFreshFinal.id, stopped.id, stillRunning.id]));
  const byId = (id: string): HTMLButtonElement => rows.find(row => row.dataset.sessionId === id)!;
  expect(byId(done.id).textContent).toContain('Final answer recorded');
  expect(byId(noFreshFinal.id).textContent).toContain('Previous final retained');
  expect(byId(noFreshFinal.id).textContent).not.toContain('Final answer recorded');
  expect(byId(stopped.id).textContent).not.toContain('Final answer recorded');
  expect(byId(stillRunning.id).textContent).not.toContain('Final answer recorded');
  byId(done.id).click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Recorded final: Finished the one-off after the recorded tool.');
  expect(pane.textContent).toContain('Retained evidence before final');
  expect(app.w.document.getElementById('chatTitle')!.textContent).toBe(selected.title);
  byId(noFreshFinal.id).click();
  await settle();
  const justDid = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')!.textContent ?? '';
  expect(justDid).toContain('New turn read evidence only');
  expect(justDid).not.toContain('Recorded final: Finished the one-off');
  expect(pane.querySelector('.work-overview-result summary')?.textContent).toBe('Read previous recorded final answer');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Finished the one-off after the recorded tool.');
});

it('reveals the retained final result beyond the short Just did excerpt and keeps the disclosure open across refresh', async () => {
  const selected = summary([]);
  const result = {
    ...summary([]), id: 'long-result-oneoff', title: 'Finished detailed review',
    conversationId: 'long-result-chat', chatIds: ['long-result-chat'],
    lastAssistantFinalAt: T0 + 70_000, lastTurnEndAt: T0 + 71_000,
    lastToolCallAt: T0 + 20_000, activeTurnId: null
  };
  const completeText = `RESULT: Live status corrected.\n${'Checked exact ownership. '.repeat(30)}\n` +
    'CHANGES: renderer status detail.\nVALIDATION: 4 of 4 focused tests passed.\nBLOCKERS: Installed UI verification pending.';
  const final: SessionEvent = {
    kind: 'assistant_message', seq: 2, time: T0 + 70_000, source: 'extension',
    messageId: 'long-completed-result', message: text(completeText), final: true
  };
  const app = await boot([], true, [], [], {
    sessions: [selected, result], sessionEvents: { [result.id]: [toolCall(1, 'old-step'), final] }
  });
  const row = app.w.document.querySelector<HTMLButtonElement>(`.work-overview-row[data-session-id="${result.id}"]`)!;
  row.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Just did')!;
  expect(justDid.textContent).not.toContain('VALIDATION: 4 of 4');
  const disclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  expect(disclosure).not.toBeNull();
  expect(disclosure.open).toBe(false);
  disclosure.open = true;
  const toggle = disclosure.querySelector<HTMLElement>('summary')!;
  const savedBody = disclosure.querySelector<HTMLElement>('.work-overview-result-body')!;
  const originalTextNode = savedBody.firstChild;
  let removedDisclosures = 0;
  const removals = new app.w.MutationObserver(records => {
    for (const record of records) {
      if ([...record.removedNodes].includes(disclosure)) removedDisclosures++;
    }
  });
  removals.observe(pane, { childList: true });
  toggle.focus();
  expect(disclosure.textContent).toContain('VALIDATION: 4 of 4 focused tests passed');
  expect(disclosure.textContent).toContain('BLOCKERS: Installed UI verification pending');
  app.notifySession();
  await settle(700);
  const refreshed = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  // A status-only update must retain the very same disclosure and 12K result text
  // node. Detaching/rebuilding them loses native selection and wastes DOM work.
  expect(refreshed).toBe(disclosure);
  expect(refreshed.querySelector('.work-overview-result-body')).toBe(savedBody);
  expect(savedBody.firstChild).toBe(originalTextNode);
  expect(removedDisclosures).toBe(0);
  expect(refreshed.open).toBe(true);
  expect(app.w.document.activeElement).toBe(refreshed.querySelector('summary'));
  expect(app.w.document.getElementById('chatTitle')!.textContent).toBe(selected.title);
  // Neither the preview bound nor an incomplete original recording can masquerade as
  // the full answer. These are separate limitations with their own visible explanation.
  final.message.text += `\n${'Additional retained evidence. '.repeat(500)}`;
  final.message.truncated = true;
  app.notifySession();
  await settle(700);
  expect(pane.querySelector<HTMLElement>('.work-overview-result-body')?.textContent?.length).toBe(12_000);
  expect(pane.querySelector<HTMLElement>('.work-overview-result-body')).toBe(savedBody);
  expect(savedBody.textContent).toContain('Additional retained evidence.');
  // The existing explicit disclosure now names the actual saved-character
  // denominator, rather than the older generic clipping phrase.
  expect(pane.textContent).toContain('Showing the first 12,000 of');
  expect(pane.textContent).toContain('Original recording was truncated');
  expect(pane.querySelector<HTMLDetailsElement>('.work-overview-result')?.open).toBe(true);
  expect(removedDisclosures).toBe(0);
  removals.disconnect();
});

it('keeps an older useful result historical after an exact native Send with no linked answer or turn-start record', async () => {
  const row = { ...summary([]), id: 'native-delivered-unanswered', title: 'Delivered question awaiting answer',
    conversationId: 'native-awaiting-provider', chatIds: ['native-awaiting-provider'],
    fileEdits: 1, lastFileChangeAt: T0 + 4_000,
    lastAssistantFinalAt: T0 + 4_000, lastTurnOutcome: 'interrupted' as const,
    lastTurnEndAt: T0 + 10_000, activeTurnId: null };
  const older: SessionEvent = { kind: 'assistant_message', seq: 1, time: T0 + 4_000,
    source: 'extension', messageId: 'prior-native-final', final: true,
    message: text('RESULT: Previously implemented source repair; newer question unanswered.') };
  const delivered: SessionEvent = { kind: 'user_message', seq: 2, time: T0 + 8_000,
    source: 'app', messageId: 'native-question-123', inputId: 'confirmed-input-123',
    inputDelivery: 'confirmed', message: text('Continue original mission and verify installed acceptance.') };
  const source: SessionEvent[] = [older, delivered,
    { kind: 'turn_end', seq: 3, time: T0 + 10_000, source: 'extension',
      turnId: 'interrupted-new-turn', outcome: 'interrupted' }];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: source } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const delivery = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Native delivery & answer')!;
  expect(delivery).toBeTruthy();
  expect(delivery.textContent).toContain('native-question-123');
  expect(delivery.textContent).toContain('confirmed-input-123');
  expect(delivery.textContent).toContain('Native Send confirmed');
  expect(delivery.textContent).toContain('answer not confirmed');
  expect(delivery.textContent).not.toContain('answer accepted');
  expect(pane.querySelector('.work-overview-result summary')?.textContent).toBe('Read previous recorded final answer');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Previously implemented source repair');
  expect(pane.querySelector('.work-overview-pane-field')?.textContent).not.toContain('Recorded final: RESULT: Previously');
  expect(pane.textContent).toContain('interrupted');
  expect(app.live.sent).toEqual([]);
});

it('identifies an exact Main-linked final without turning a foreign or unlinked answer into an accepted response', async () => {
  const row = { ...summary([]), id: 'exact-delivery-final-link', title: 'Answer receipt review',
    conversationId: 'answer-receipt-provider', chatIds: ['answer-receipt-provider'],
    fileEdits: 1, lastFileChangeAt: T0 + 4_000, lastAssistantFinalAt: T0 + 7_000 };
  const question: SessionEvent = { kind: 'user_message', seq: 1, time: T0 + 4_000,
    source: 'extension', messageId: 'actual-native-user-456', inputId: 'input-456',
    inputDelivery: 'confirmed', message: text('Original user message') };
  const unrelated: SessionEvent = { kind: 'assistant_message', seq: 2, time: T0 + 5_000,
    source: 'extension', turnId: 'different-turn', messageId: 'other-final', final: true,
    goalEligible: true, inputReplyTo: 'different-native-user',
    message: text('This unrelated assistant final is not an answer receipt for input-456.') };
  const source: SessionEvent[] = [question, unrelated];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: source } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = () => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Native delivery & answer')!.textContent ?? '';
  expect(field()).toContain('answer not confirmed');
  expect(field()).not.toContain('Exact answer recorded');
  unrelated.inputReplyTo = question.messageId!;
  unrelated.message.text = 'Exact validated final returned for this input.';
  row.lastAssistantFinalAt = T0 + 9_000;
  app.notifySession();
  await settle(700);
  expect(field()).toContain('Exact answer recorded');
  expect(field()).toContain('not task-completion acceptance');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Exact validated final returned for this input');
  expect(app.live.sent).toEqual([]);
});

it('distinguishes a native-delivered cancelled input from a positively unsent replacement and hidden decision helpers', async () => {
  const row = { ...summary([]), id: 'cancelled-native-evidence', title: 'Cancelled answer collection',
    conversationId: 'cancelled-provider', chatIds: ['cancelled-provider'],
    fileEdits: 1, lastFileChangeAt: T0 + 11_000 };
  const receipt: SessionEvent = { kind: 'user_message', seq: 1, time: T0 + 11_000,
    source: 'app', messageId: 'native-original-unique', inputId: 'delivered-cancelled-uuid',
    inputDelivery: 'confirmed', message: text('The original delivered input') };
  const app = await boot([], true, [], [], { sessions: [row],
    sessionEvents: { [row.id]: [receipt] }, inputs: [
      { id: 'delivered-cancelled-uuid', sessionId: row.id, conversationId: row.conversationId,
        text: 'The original delivered input', mode: 'auto', dueAt: 0, model: 'gpt-6-thinking',
        reasoningEffort: 'xhigh', state: 'cancelled', owner: 'chrome-original', createdAt: T0 + 10_000,
        sendAuthorizedAt: T0 + 10_200, deliveredAt: T0 + 11_000, messageId: 'native-original-unique',
        error: 'Answer collection deadline expired. No automatic replay.' },
      { id: 'cancelled-before-send', sessionId: row.id, conversationId: row.conversationId,
        text: 'Positively unsent draft', mode: 'auto', dueAt: 0, model: 'gpt-6-thinking',
        reasoningEffort: 'xhigh', state: 'cancelled', owner: null, createdAt: T0 + 12_000,
        requiresAuthorization: true },
      { id: 'private-decision-helper', sessionId: row.id, conversationId: row.conversationId,
        purpose: 'decision', text: 'Hidden helper', mode: 'auto', dueAt: 0, model: 'gpt-6-thinking',
        reasoningEffort: 'xhigh', state: 'cancelled', owner: 'helper', createdAt: T0 + 15_000,
        deliveredAt: T0 + 15_000, messageId: 'private-native-helper' }
    ] });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const custody = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Native delivery & answer')!.textContent ?? '';
  expect(custody).toContain('Native Send confirmed');
  expect(custody).toContain('Cancelled after delivery');
  expect(custody).toContain('Answer collection deadline expired');
  expect(custody).not.toContain('private-native-helper');
  expect(custody).not.toContain('cancelled-before-send');
  expect(custody).not.toContain('answer accepted');
  expect(pane.querySelector('[data-work-action="retry"]')).toBeNull();
  const witnessedHistory = [...pane.querySelectorAll<HTMLElement>('.work-overview-history li')]
    .filter(item => item.textContent?.includes('Native Send confirmed'));
  expect(witnessedHistory).toHaveLength(1);
  expect(witnessedHistory[0]?.textContent).not.toContain('retained outbox receipt');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('recovers an exact cancelled-after-native-delivery receipt from the outbox after the message leaves recent history', async () => {
  const row = { ...summary([]), id: 'outbox-only-delivery-session', title: 'Persisted cancelled receipt',
    conversationId: 'outbox-only-provider', chatIds: ['outbox-only-provider'],
    fileEdits: 0, lastAssistantFinalAt: null, lastToolCallAt: null };
  const inputs: InputEntry[] = [
    { id: 'persisted-native-receipt-id', sessionId: row.id, conversationId: row.conversationId,
      text: 'The original delivered input is outside recent history', mode: 'auto', dueAt: 0,
      model: 'gpt-6-thinking', reasoningEffort: 'xhigh', state: 'cancelled',
      owner: 'original-tab', createdAt: T0 + 2_000, deliveredAt: T0 + 3_000,
      sendAuthorizedAt: T0 + 2_500, messageId: 'persisted-native-message', error: 'Answer collection expired' },
    { id: 'unrelated-private-decision', sessionId: row.id, conversationId: row.conversationId,
      purpose: 'decision', text: 'Private decision input', mode: 'auto', dueAt: 0,
      model: 'gpt-6-thinking', reasoningEffort: 'xhigh', state: 'cancelled',
      owner: 'other-helper', createdAt: T0 + 4_000, deliveredAt: T0 + 5_000,
      sendAuthorizedAt: T0 + 4_500, messageId: 'private-helper-native' }
  ];
  const app = await boot([], true, [], [], { sessions: [row],
    sessionEvents: { [row.id]: Array.from({ length: 100 }, (_, i) => toolCall(i + 6, `late-${i}`)) },
    strictSessionPaging: true, inputs });
  const update = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!;
  expect(update).not.toBeNull();
  expect(update.textContent).toContain('Native delivery retained');
  update.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const custody = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Native delivery & answer')!.textContent ?? '';
  expect(custody).toContain('persisted-native-message');
  expect(custody).toContain('Native Send confirmed');
  expect(custody).toContain('Cancelled after delivery');
  expect(custody).toContain('answer not confirmed');
  expect(custody).not.toContain('private-helper-native');
  expect(custody).not.toContain('answer accepted');
  expect(pane.querySelector('.work-overview-history')?.textContent).not.toContain('retained outbox receipt');
  const disclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-result');
  expect(disclosure).toBeNull();
  pane.querySelector<HTMLButtonElement>('[data-work-action="open"]')!.click();
  await settle();
  const progress = app.w.document.getElementById('progressInbox')!;
  expect(progress.textContent).toContain('Native delivery & answer');
  expect(progress.textContent).toContain('persisted-native-message');
  expect(progress.textContent).toContain('Cancelled after delivery');
  expect(progress.textContent).not.toContain('private-helper-native');
  expect(app.live.sent).toEqual([]);
});

it('keeps an older saved final historical when a newer unanswered receipt exists only in the durable outbox', async () => {
  const row = { ...summary([]), id: 'outbox-newer-than-old-final', title: 'Earlier proof after later unanswered delivery',
    conversationId: 'outbox-later-delivery-provider', chatIds: ['outbox-later-delivery-provider'],
    lastAssistantFinalAt: T0 + 2_000, lastTurnEndAt: T0 + 3_000,
    lastTurnOutcome: 'completed' as const, fileEdits: 1, lastFileChangeAt: T0 + 2_000 };
  const previous: SessionEvent = { kind: 'assistant_message', seq: 3, time: T0 + 2_000,
    source: 'extension', messageId: 'earlier-confirmed-final', final: true,
    message: text('OLD RESULT: A real previous repair, unrelated to the new native delivery.') };
  const outbox: InputEntry = { id: 'later-native-outbox-only', sessionId: row.id,
    conversationId: row.conversationId, text: 'Later unanswered delivery', mode: 'auto',
    dueAt: 0, model: 'gpt-6-thinking', reasoningEffort: 'xhigh',
    state: 'cancelled', owner: 'real-elected-tab', createdAt: T0 + 7_000,
    sendAuthorizedAt: T0 + 8_000, deliveredAt: T0 + 9_000,
    messageId: 'later-native-question-id', error: 'Native answer collection expired' };
  const app = await boot([], true, [], [], {
    sessions: [row], sessionEvents: { [row.id]: [previous] }, inputs: [outbox]
  });
  const update = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!;
  expect(update).not.toBeNull();
  expect(update.textContent).toContain('Native delivery retained');
  update.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid).toContain('Native input delivered');
  expect(justDid).not.toContain('Recorded final: OLD RESULT');
  expect(pane.querySelector('.work-overview-result summary')?.textContent).toBe('Read previous recorded final answer');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('OLD RESULT: A real previous repair');
  expect(pane.textContent).toContain('Native Send confirmed');
  expect(pane.textContent).toContain('Cancelled after delivery');
  expect(pane.textContent).toContain('answer not confirmed');
  expect(app.live.sent).toEqual([]);
});

it('keeps an outbox-only newer native Send visible in Work recent history after the old final', async () => {
  const row = { ...summary([]), id: 'outbox-current-history-session', title: 'Original answer and later native delivery',
    conversationId: 'outbox-history-provider', chatIds: ['outbox-history-provider'],
    lastAssistantFinalAt: T0 + 2_000, fileEdits: 1, lastFileChangeAt: T0 + 2_000 };
  const previous: SessionEvent = { kind: 'assistant_message', seq: 1, time: T0 + 2_000,
    source: 'extension', messageId: 'past-final-history', final: true,
    message: text('Previous completed output remains readable.') };
  const outbox: InputEntry = { id: 'newer-outbox-history-input', sessionId: row.id,
    conversationId: row.conversationId, text: 'Native input whose recorder row is outside the recent window',
    mode: 'auto', dueAt: 0, model: 'gpt-6-thinking', reasoningEffort: 'xhigh', state: 'sent',
    owner: 'owned-native-page', createdAt: T0 + 7_000, deliveredAt: T0 + 9_000,
    messageId: 'newer-outbox-history-native-id' };
  const app = await boot([], true, [], [], {
    sessions: [row], sessionEvents: { [row.id]: [previous] }, inputs: [outbox]
  });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const history = [...pane.querySelectorAll<HTMLElement>('.work-overview-history li')].map(item => item.textContent ?? '');
  expect(history).toHaveLength(2);
  expect(history[0]).toContain('Native Send confirmed');
  expect(history[0]).toContain('retained outbox receipt');
  expect(history[0]).toContain('answer not confirmed');
  expect(history[0]).not.toContain('later cancelled');
  expect(history[1]).toContain('Final answer recorded');
  const disclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  expect(disclosure.textContent).toContain('Previous completed output');
  disclosure.open = true;
  disclosure.querySelector('summary')!.focus();
  app.live.inputs[0]!.state = 'cancelled';
  app.live.inputs[0]!.error = 'Collection ended without an answer';
  await app.append([]);
  expect(pane.querySelector('.work-overview-result')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(app.w.document.activeElement).toBe(disclosure.querySelector('summary'));
  expect(pane.querySelector('.work-overview-history li')?.textContent).toContain('later cancelled');
  expect(pane.textContent).toContain('Collection ended without an answer');
  expect(history.join(' ')).not.toContain('answer accepted');
  expect(app.live.sent).toEqual([]);
});

it('keeps an earlier confirmed native Send readable when a newer offered handout is still unsent', async () => {
  const row = { ...summary([]), id: 'offered-after-native-receipt', title: 'Sent history before an unsent handout',
    conversationId: 'offered-after-native-provider', chatIds: ['offered-after-native-provider'],
    lastAssistantFinalAt: T0 + 2_000, fileEdits: 1, lastFileChangeAt: T0 + 2_000 };
  const previous: SessionEvent = { kind: 'assistant_message', seq: 1, time: T0 + 2_000,
    source: 'extension', messageId: 'historical-result', final: true,
    message: text('A completed earlier output must stay readable.') };
  const offered: SessionEvent = { kind: 'user_message', seq: 2, time: T0 + 9_000,
    source: 'app', inputId: 'new-not-sent', messageId: 'tool-handout-only',
    inputDelivery: 'offered', message: text('One new offered message, not natively sent.') };
  const inputs: InputEntry[] = [
    { id: 'older-confirmed-input', sessionId: row.id, conversationId: row.conversationId,
      text: 'Previous delivery', mode: 'auto', dueAt: 0, model: 'gpt-6-thinking',
      reasoningEffort: 'xhigh', state: 'cancelled', owner: 'original-tab', createdAt: T0 + 2_500,
      deliveredAt: T0 + 3_000, messageId: 'older-confirmed-native-id',
      error: 'Old answer collection expired' },
    { id: 'new-not-sent', sessionId: row.id, conversationId: row.conversationId,
      text: 'One new offered message', mode: 'auto', dueAt: 0, model: 'gpt-6-thinking',
      reasoningEffort: 'xhigh', state: 'tool', owner: 'offered-tool', createdAt: T0 + 8_000 },
    { id: 'hidden-private-decision', sessionId: row.id, conversationId: row.conversationId,
      purpose: 'decision', text: 'Private helper must not surface', mode: 'auto', dueAt: 0,
      model: 'gpt-6-thinking', reasoningEffort: 'xhigh', state: 'sent', owner: 'helper',
      createdAt: T0 + 8_100, deliveredAt: T0 + 8_500, messageId: 'private-helper-native-id' }
  ];
  const app = await boot([], true, [], [], {
    sessions: [row], sessionEvents: { [row.id]: [previous, offered] }, inputs
  });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (label: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === label)?.textContent ?? '';
  expect(field('Just did')).toContain('Tool handout offered');
  expect(field('Just did')).not.toContain('Recorded final:');
  expect(field('Native delivery & answer')).toContain('Tool handout offered');
  expect(field('Native delivery & answer')).toContain('native message identity unconfirmed');
  expect(field('Native delivery & answer')).not.toContain('Native Send confirmed');
  expect(field('Earlier native delivery')).toContain('older-confirmed-input');
  expect(field('Earlier native delivery')).toContain('older-confirmed-native-id');
  expect(field('Earlier native delivery')).toContain('Native Send confirmed');
  expect(field('Earlier native delivery')).toContain('Cancelled after delivery');
  const chronology = [...pane.querySelectorAll<HTMLElement>('.work-overview-history li')]
    .map(item => item.textContent ?? '');
  expect(chronology[0]).toContain('Tool handout offered');
  expect(chronology[1]).toContain('Earlier Native Send confirmed');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('A completed earlier output');
  expect(pane.textContent).not.toContain('private-helper-native-id');
  pane.querySelector<HTMLButtonElement>('[data-work-action="open"]')!.click();
  await settle();
  const progress = app.w.document.getElementById('progressInbox')!.textContent ?? '';
  expect(progress).toContain('Tool handout offered');
  expect(progress).toContain('Earlier native delivery');
  expect(progress).toContain('older-confirmed-native-id');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('distinguishes an offered synthetic input reference from the same input’s later exact outbox-native Send', async () => {
  const row = { ...summary([]), id: 'same-input-native-after-tool', title: 'One input: handout, then native receipt',
    conversationId: 'same-input-native-provider', chatIds: ['same-input-native-provider'],
    fileEdits: 1, lastFileChangeAt: T0 + 2_000, lastAssistantFinalAt: T0 + 2_000 };
  const prior: SessionEvent = { kind: 'assistant_message', seq: 1, time: T0 + 2_000,
    source: 'extension', messageId: 'prior-final-same-input', final: true,
    message: text('Old completed output remains saved separately.') };
  // The actual input-history owner publishes a synthetic input:<id> row for
  // a tool handout, not a native provider message ID. The recorder may lag
  // behind the independently durable confirmed outbox receipt.
  const handout: SessionEvent = { kind: 'user_message', seq: 2, time: T0 + 7_000,
    source: 'app', inputId: 'matched-native-input', messageId: 'input:matched-native-input',
    inputDelivery: 'offered', message: text('One handout that later reached native Send.') };
  const delivered: InputEntry = { id: handout.inputId!, sessionId: row.id,
    conversationId: row.conversationId, text: 'One handout that later reached native Send.',
    mode: 'auto', dueAt: 0, model: 'gpt-6-thinking', reasoningEffort: 'xhigh',
    state: 'cancelled', owner: 'same-owner', createdAt: T0 + 6_000,
    offeredAt: T0 + 7_000, sendAuthorizedAt: T0 + 7_500,
    deliveredAt: T0 + 8_000, messageId: 'actual-native-send-id',
    error: 'Answer retrieval closed without a matching final' };
  const app = await boot([], true, [], [], { sessions: [row],
    sessionEvents: { [row.id]: [prior, handout] }, inputs: [delivered] });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (label: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === label)?.textContent ?? '';
  expect(field('Native delivery & answer')).toContain('Native Send confirmed');
  expect(field('Native delivery & answer')).toContain('native message actual-native-send-id');
  expect(field('Native delivery & answer')).not.toContain('Conflicting outbox native message identity');
  expect(field('Native delivery & answer')).toContain('Cancelled after delivery');
  expect(field('Native delivery & answer')).toContain('answer not confirmed');
  expect(field('Just did')).toContain('Native input delivered');
  expect(field('Just did')).not.toContain('Recorded final:');
  const history = [...pane.querySelectorAll<HTMLElement>('.work-overview-history li')]
    .map(item => item.textContent ?? '');
  expect(history[0]).toContain('Native Send confirmed');
  expect(history[0]).toContain('retained outbox receipt');
  expect(history[1]).toContain('Tool handout offered');
  expect(history[2]).toContain('Final answer recorded');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Old completed output');
  pane.querySelector<HTMLButtonElement>('[data-work-action="open"]')!.click();
  await settle();
  const progress = app.w.document.getElementById('progressInbox')!;
  expect(progress.textContent).toContain('native message actual-native-send-id');
  const handoutEvidence = [...progress.querySelectorAll<HTMLElement>('.progress-evidence-copy')]
    .find(item => item.textContent?.includes('Tool handout offered'))?.textContent ?? '';
  expect(handoutEvidence).toContain('handout reference input:matched-native-input');
  expect(handoutEvidence).not.toContain('native message input:matched-native-input');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('requires deliveredAt for a matching outbox native identity before promoting a synthetic tool handout', async () => {
  const row = { ...summary([]), id: 'same-input-unconfirmed-browser', title: 'No proven native Send',
    conversationId: 'same-input-unconfirmed-provider', chatIds: ['same-input-unconfirmed-provider'],
    fileEdits: 1, lastFileChangeAt: T0 + 8_000 };
  const handout: SessionEvent = { kind: 'user_message', seq: 1, time: T0 + 8_000,
    source: 'app', inputId: 'same-no-confirmation', messageId: 'input:same-no-confirmation',
    inputDelivery: 'offered', message: text('Tool handout awaiting native receipt') };
  const notConfirmed: InputEntry = { id: handout.inputId!, sessionId: row.id,
    conversationId: row.conversationId, text: 'Tool handout awaiting native receipt',
    mode: 'auto', dueAt: 0, model: 'gpt-6-thinking', reasoningEffort: 'xhigh',
    state: 'browser', owner: 'elected-browser', createdAt: T0 + 7_000,
    offeredAt: T0 + 8_000, sendAuthorizedAt: T0 + 8_500,
    messageId: 'provisional-message-id-without-delivery' };
  const app = await boot([], true, [], [], { sessions: [row],
    sessionEvents: { [row.id]: [handout] }, inputs: [notConfirmed] });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const delivery = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Native delivery & answer')?.textContent ?? '';
  expect(delivery).toContain('Tool handout offered');
  expect(delivery).toContain('handout reference input:same-no-confirmation');
  expect(delivery).toContain('native message identity unconfirmed');
  expect(delivery).not.toContain('Native Send confirmed');
  expect(pane.querySelector('.work-overview-history')?.textContent).not.toContain('Native Send confirmed');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('does not import an unrelated native receipt or promote an old offer over a newer failed tool', async () => {
  const row = { ...summary([]), id: 'offered-before-later-rejection', title: 'Rejected later action',
    conversationId: 'offered-rejection-provider', chatIds: ['offered-rejection-provider'],
    lastToolCallAt: T0 + 12_000, fileEdits: 1, lastFileChangeAt: T0 + 12_000 };
  const offered: SessionEvent = { kind: 'user_message', seq: 1, time: T0 + 8_000,
    source: 'app', inputId: 'offered-no-native-receipt', messageId: 'offered-no-native-id',
    inputDelivery: 'offered', message: text('Waiting for native Send') };
  const rejected = { ...toolCall(2, 'native-tool-denied'), time: T0 + 12_000,
    call: { ...(toolCall(2, 'native-tool-denied') as Extract<SessionEvent, { kind: 'tool_call' }>).call,
      outcome: 'tool_rejected' as const } } as SessionEvent;
  const unrelated: InputEntry = { id: 'foreign-native-send', sessionId: 'different-local-session',
    conversationId: 'different-provider', text: 'Delivered elsewhere', mode: 'auto', dueAt: 0,
    model: 'gpt-6-thinking', reasoningEffort: 'xhigh', state: 'cancelled', owner: 'other-tab',
    createdAt: T0 + 2_000, deliveredAt: T0 + 3_000, messageId: 'foreign-native-message' };
  const app = await boot([], true, [], [], {
    sessions: [row], sessionEvents: { [row.id]: [offered, rejected] }, inputs: [unrelated]
  });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid).toContain('Rejected');
  expect(justDid).toContain('Read README.md');
  expect(pane.textContent).not.toContain('Earlier native delivery');
  expect(pane.textContent).not.toContain('foreign-native-message');
  expect(app.live.sent).toEqual([]);
});

it('does not promote a separate outbox Send above an offered handout when their clocks disagree', async () => {
  const row = { ...summary([]), id: 'native-handout-clock-conflict', title: 'Different source clocks',
    conversationId: 'clock-conflict-provider', chatIds: ['clock-conflict-provider'],
    fileEdits: 1, lastFileChangeAt: T0 + 7_000 };
  const offered: SessionEvent = { kind: 'user_message', seq: 5, time: T0 + 9_000,
    source: 'app', inputId: 'unconfirmed-new-handout', messageId: 'not-a-native-receipt',
    inputDelivery: 'offered', message: text('Native confirmation missing') };
  // A durable Main receipt and a provider/recorder create_time do not give
  // cross-source ordering authority when they conflict.
  const distinctReceipt: InputEntry = { id: 'confirmed-separate-input', sessionId: row.id,
    conversationId: row.conversationId, text: 'Delivered earlier, clock observed later',
    mode: 'auto', dueAt: 0, model: 'gpt-6-thinking', reasoningEffort: 'xhigh',
    state: 'sent', owner: 'earlier-page', createdAt: T0 + 5_000,
    deliveredAt: T0 + 10_000, messageId: 'confirmed-other-native-message' };
  const app = await boot([], true, [], [], { sessions: [row],
    sessionEvents: { [row.id]: [offered] }, inputs: [distinctReceipt] });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (label: string) => [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === label)?.textContent ?? '';
  expect(field('Native delivery & answer')).toContain('Tool handout offered');
  expect(field('Native delivery & answer')).not.toContain('Native Send confirmed');
  expect(field('Separate native delivery')).toContain('confirmed-other-native-message');
  expect(field('Separate native delivery')).toContain('order unverified');
  expect(pane.querySelector('.work-overview-history')?.textContent).not.toContain('Earlier Native Send');
  expect(pane.textContent).not.toContain('Exact answer recorded');
  expect(app.live.sent).toEqual([]);
});

it.each([false, true])('keeps a later rejected tool ahead of an unanswered native Send (outbox-only: %s)', async outboxOnly => {
  const row = { ...summary([]), id: `newer-tool-after-native-${outboxOnly}`, title: 'Later tool failure after saved input',
    conversationId: `tool-failure-native-${outboxOnly}`, chatIds: [`tool-failure-native-${outboxOnly}`],
    lastAssistantFinalAt: T0 + 2_000, lastToolCallAt: T0 + 11_000,
    fileEdits: 1, lastFileChangeAt: T0 + 2_000 };
  const prior: SessionEvent = { kind: 'assistant_message', source: 'extension', seq: 1, time: T0 + 2_000,
    messageId: `older-success-${outboxOnly}`, final: true, message: text('OLDER ACCEPTED RESULT remains available.') };
  const question: SessionEvent = { kind: 'user_message', source: 'app', seq: 2, time: T0 + 9_000,
    inputId: 'native-before-later-tool', messageId: 'delivered-question-before-tool', inputDelivery: 'confirmed',
    message: text('Review the next step of this task') };
  const denied = toolCall(3, 'newer-tool-rejected') as Extract<SessionEvent, { kind: 'tool_call' }>;
  denied.time = T0 + 11_000;
  denied.call.outcome = 'tool_rejected';
  denied.call.summary = { kind: 'read', title: 'Read follow-up evidence failed', tone: 'bad' };
  const events: SessionEvent[] = outboxOnly ? [prior, denied] : [prior, question, denied];
  const native: InputEntry = { id: question.inputId!, sessionId: row.id, conversationId: row.conversationId,
    text: 'Review the next step of this task', mode: 'auto', dueAt: 0,
    model: 'gpt-6-thinking', reasoningEffort: 'xhigh', state: 'sent', owner: 'native-original-tab',
    createdAt: T0 + 8_000, sendAuthorizedAt: T0 + 8_500, deliveredAt: T0 + 9_000,
    messageId: question.messageId };
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events }, inputs: [native] });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = () => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid()).toContain('Rejected');
  expect(justDid()).toContain('Read follow-up evidence failed');
  expect(justDid()).not.toContain('Native input delivered');
  const recent = [...pane.querySelectorAll<HTMLElement>('.work-overview-history li')].map(node => node.textContent ?? '');
  expect(recent).toHaveLength(3);
  expect(recent[0]).toContain('Rejected');
  expect(recent[1]).toContain('Native Send confirmed');
  expect(recent[2]).toContain('Final answer recorded');
  const disclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  expect(disclosure.querySelector('summary')?.textContent).toBe('Read previous recorded final answer');
  expect(disclosure.textContent).toContain('OLDER ACCEPTED RESULT');
  disclosure.open = true;
  disclosure.querySelector('summary')!.focus();
  app.live.inputs[0]!.state = 'cancelled';
  app.live.inputs[0]!.error = 'Later answer collection ended';
  await app.append([]);
  expect(justDid()).toContain('Rejected');
  expect(pane.querySelector('.work-overview-result')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(app.w.document.activeElement).toBe(disclosure.querySelector('summary'));
  expect(pane.textContent).toContain('Cancelled after delivery');
  expect(pane.textContent).not.toContain('Exact answer recorded');
  expect(app.live.sent).toEqual([]);
});

it('puts a newer recorded provider error ahead of a previous final without erasing either on recovery', async () => {
  const row: SessionSummary = { ...summary([]), id: 'provider-failed-after-final', title: 'Error after earlier successful work',
    conversationId: 'provider-later-error', chatIds: ['provider-later-error'],
    lastAssistantFinalAt: T0 + 2_000, fileEdits: 1, lastFileChangeAt: T0 + 2_000 };
  const events: SessionEvent[] = [
    { kind: 'assistant_message', source: 'extension', seq: 1, time: T0 + 2_000,
      messageId: 'earlier-provider-success', final: true, message: text('PRIOR COMPLETED OUTPUT can still be reviewed.') },
    { kind: 'chat_error', source: 'extension', seq: 2, time: T0 + 10_000,
      turnId: 'provider-failed-turn', blocking: true, message: text('Model not found') }
  ];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (label: string) => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === label)?.textContent ?? '';
  expect(field('Just did')).toContain('Provider error');
  expect(field('Just did')).toContain('Model not found');
  expect(field('Current status')).toContain('provider status unknown');
  expect(field('Next / blocker')).toContain('Check the provider account');
  expect(pane.querySelector('.work-overview-history')?.textContent).toContain('Provider error recorded');
  const saved = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  expect(saved.textContent).toContain('PRIOR COMPLETED OUTPUT');
  expect(saved.querySelector('summary')?.textContent).toBe('Read previous recorded final answer');
  events.push({ kind: 'turn_start', seq: 3, time: T0 + 12_000, source: 'extension', turnId: 'new-recovered-turn' });
  events.push({ kind: 'assistant_message', seq: 4, time: T0 + 13_000, source: 'extension',
    turnId: 'new-recovered-turn', messageId: 'new-recovered-final', final: true,
    message: text('RECOVERED SOURCE RESULT; live native proof remains separate.') });
  events.push({ kind: 'turn_end', seq: 5, time: T0 + 14_000, source: 'extension',
    turnId: 'new-recovered-turn', outcome: 'completed' });
  row.lastAssistantFinalAt = T0 + 13_000;
  row.lastTurnOutcome = 'completed';
  row.lastTurnEndAt = T0 + 14_000;
  app.notifySession();
  await settle(700);
  expect(field('Just did')).toContain('RECOVERED SOURCE RESULT');
  expect(field('Provider evidence')).toContain('Earlier recorded provider error');
  expect(field('Current status')).not.toContain('provider status unknown');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('RECOVERED SOURCE RESULT');
  expect(app.live.sent).toEqual([]);
});

it('explains a same-provider bounded helper exhaustion prominently in Work, retaining earlier useful results without Send', async () => {
  const row = { ...summary([]), id: 'helper-exhausted-in-work', title: 'Original Loop with missing continuation helper',
    conversationId: 'exact-helper-source', chatIds: ['exact-helper-source'],
    activeTurnId: 'original-native-A', lastAssistantFinalAt: T0 + 2_000,
    fileEdits: 1, lastFileChangeAt: T0 + 2_000 };
  const supervisor: AutomationSupervisorSnapshot = {
    observedAt: T0 + 40_000, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0,
      recovering: 0, stalled: 0, paused: 0, blocked: 1 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId, title: row.title,
      mode: 'loop', state: 'blocked', reason: 'goal_browser_helper_exhausted',
      nextAction: 'Review the current helper model settings.',
      nextRetryAt: null, lastWorkedAt: T0 + 39_000, activeWorkers: 0,
      recoverable: false, spinning: false, recoveryStage: null }]
  };
  const safeCause = 'Three helper attempts failed for this exact turn. The requested model or reasoning could not be confirmed before Send. The exact Loop reply remains saved. Automatic helper creation is paused.';
  const olderFinal: SessionEvent = { kind: 'assistant_message', source: 'extension',
    seq: 1, time: T0 + 2_000, turnId: 'finished-prior', messageId: 'retained-prior-work', final: true,
    message: text('Previous validated work remains readable while helper continuation is held.') };
  const app = await boot([], true, [], [], { sessions: [row], automation: supervisor,
    controls: { automation: 'loop', activeTurnId: 'original-native-A',
      goalDraft: { stage: 'failed', stageStartedAt: T0 + 35_000,
        model: 'gpt-6-thinking', text: 'PRIVATE_GOAL_INPUT_MUST_NOT_LEAK',
        error: 'goal_browser_helper_exhausted', message: safeCause } },
    sessionEvents: { [row.id]: [olderFinal] } });
  const item = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${row.id}"]`)!;
  expect(item.textContent).toContain('blocked');
  item.click(); await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (label: string) => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(node => node.querySelector('b')?.textContent === label)?.textContent ?? '';
  expect(field('Status & next action')).toContain('Helper retry budget exhausted');
  expect(field('Status & next action')).toContain('before Send');
  expect(field('Status & next action')).toContain('Goal, Loop and Plan');
  expect(field('Status & next action')).toContain('No new native Send is authorized');
  expect(field('Current status')).toContain('blocked');
  expect(field('Current status')).not.toContain('goal_browser_helper_exhausted');
  expect(pane.textContent).not.toContain('PRIVATE_GOAL_INPUT_MUST_NOT_LEAK');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Previous validated work');
  expect(pane.querySelector('[data-work-action="restart-helper"]')).toBeNull();
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('replaces an opaque helper machine-error headline with a readable bounded hold while keeping supervisor state blocked', async () => {
  const row = { ...summary([]), id: 'headline-helper-held', title: 'Loop paused at helper decision',
    conversationId: 'headline-helper-conversation', chatIds: ['headline-helper-conversation'],
    activeTurnId: 'held-native-turn', fileEdits: 0, toolCalls: 0, lastAssistantFinalAt: null };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0 + 18_000, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0,
      stalled: 0, paused: 0, blocked: 1 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId, title: row.title,
      mode: 'loop', state: 'blocked', reason: 'goal_browser_helper_exhausted',
      nextAction: 'Inspect exact helper error and saved reply', nextRetryAt: null,
      lastWorkedAt: T0 + 12_000, activeWorkers: 0, recoverable: false,
      spinning: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation,
    controls: { automation: 'loop', activeTurnId: 'held-native-turn',
      goalDraft: { stage: 'failed', stageStartedAt: T0 + 15_000,
        model: 'gpt-6-thinking', text: '', error: 'goal_browser_helper_exhausted',
        message: 'Three helper attempts failed for this exact turn.' } } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = (label: string) => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(node => node.querySelector('b')?.textContent === label)?.textContent ?? '';
  expect(field('Just did')).toContain('bounded helper attempt');
  expect(field('Just did')).not.toContain('goal_browser_helper_exhausted');
  expect(field('Current status')).toContain('blocked');
  expect(field('Current status')).toContain('helper retry budget exhausted');
  expect(field('Current status')).not.toContain('goal_browser_helper_exhausted');
  expect(field('Status & next action')).toContain('Restart helper');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it.each(['provider', 'turn'])('does not adopt a previous %s helper failure as a new Work hold', async boundary => {
  const row = { ...summary([]), id: 'new-source-after-helper-' + boundary,
    title: 'Source B with old helper evidence', conversationId: 'source-B',
    chatIds: ['source-A', 'source-B'], activeTurnId: 'native-B',
    lastAssistantFinalAt: T0 + 1_000, fileEdits: 1, lastFileChangeAt: T0 + 1_000 };
  const olderProvider = boundary === 'provider';
  const sourceA = olderProvider ? 'source-A' : row.conversationId;
  const app = await boot([], true, [], [], { sessions: [row],
    controls: { automation: 'loop', conversationId: sourceA,
      activeTurnId: 'native-A', goalDraft: { stage: 'failed', stageStartedAt: T0,
        model: 'gpt-6-thinking', text: '', error: 'goal_browser_helper_exhausted',
        message: 'Three helper attempts failed for this exact turn. Earlier A failure.' } },
    sessionEvents: { [row.id]: [] } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Current-provider');
  expect(pane.textContent).not.toContain('Helper retry budget exhausted');
  expect(pane.textContent).not.toContain('Earlier A failure');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it.each([
  { label: 'prior A helper before completed B', stageAt: T0 + 2_000, present: false },
  { label: 'new helper started after B', stageAt: T0 + 15_000, present: true }
])('distinguishes a same-provider finished B from $label when native turn is now closed', async ({ stageAt, present }) => {
  const row = { ...summary([]), id: 'ended-B-helper-boundary-' + stageAt,
    title: 'Completed native B with retained earlier A helper evidence',
    conversationId: 'same-provider-ended-B', chatIds: ['same-provider-ended-B'],
    activeTurnId: null, lastTurnOutcome: 'completed' as const, lastTurnEndAt: T0 + 12_000,
    fileEdits: 1, lastFileChangeAt: T0 + 3_000,
    finishTurn: { turnId: 'ended-native-B', conversationId: 'same-provider-ended-B',
      startedAt: T0 + 10_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const app = await boot([], true, [], [], { sessions: [row],
    controls: { automation: 'loop', activeTurnId: null,
      goalDraft: { stage: 'failed', stageStartedAt: stageAt,
        model: 'gpt-6-thinking', text: '', error: 'goal_browser_helper_exhausted',
        message: 'Three helper attempts failed for this exact turn.' } } });
  const item = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!;
  item.click(); await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const attention = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(node => node.querySelector('b')?.textContent === 'Status & next action')?.textContent ?? '';
  expect(attention.includes('Helper retry budget exhausted')).toBe(present);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('shows global Pause and an independent exact helper failure without pretending that either action resumed work', async () => {
  const row = { ...summary([]), id: 'paused-with-owed-helper',
    title: 'Paused account with a failed Loop helper', conversationId: 'paused-helper-provider',
    chatIds: ['paused-helper-provider'], activeTurnId: 'paused-turn',
    fileEdits: 1, lastFileChangeAt: T0 + 1_000 };
  const app = await boot([], true, [], [], { sessions: [row], automationPaused: true,
    controls: { automation: 'loop', activeTurnId: 'paused-turn',
      goalDraft: { stage: 'failed', stageStartedAt: T0 + 2_000, model: 'gpt-6-thinking',
        text: '', error: 'goal_browser_helper_exhausted', message:
          'Three helper attempts failed for this exact turn. Automatic helper creation is paused.' } } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const status = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(node => node.querySelector('b')?.textContent === 'Status & next action')?.textContent ?? '';
  expect(status).toContain('Account-wide automation pause ON');
  expect(status).toContain('Helper retry budget exhausted');
  expect(status).toContain('Resolve the account-wide pause separately');
  expect(pane.textContent).not.toContain('Exact chat recovery:');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('does not call an earlier failed helper current after a newer exact helper acceptance', async () => {
  const row = { ...summary([]), id: 'helper-later-accepted',
    title: 'Original reply accepted after retry', conversationId: 'recovered-helper-provider',
    chatIds: ['recovered-helper-provider'], activeTurnId: 'same-original-turn',
    fileEdits: 1, lastFileChangeAt: T0 + 1_000 };
  const custody: SessionDecisionHelperCustody = {
    sessionId: row.id, conversationId: row.conversationId,
    retainedTotal: 2, truncated: false,
    pendingOriginalReply: { replyId: 'saved-original-answer', sourceTurnId: 'same-original-turn', acceptedAt: T0 + 15_000 },
    helpers: [{ id: 'accepted-helper', sourceTurnId: 'same-original-turn', createdAt: T0 + 10_000,
      state: 'sent', phase: 'answer-accepted', nativeSend: 'confirmed',
      nativeMessageId: 'native-helper-accepted', sendAuthorizedAt: T0 + 11_000,
      deliveredAt: T0 + 12_000, answer: 'accepted', rejection: null,
      sourceSuperseded: false, continuation: null }]
  };
  const app = await boot([], true, [], [], { sessions: [row],
    controls: { automation: 'goal', activeTurnId: 'same-original-turn',
      goalDraft: { stage: 'failed', stageStartedAt: T0 + 2_000,
        model: 'gpt-6-thinking', text: '', error: 'goal_browser_helper_exhausted',
        message: 'Three helper attempts failed for this exact turn.' } } });
  (app.w as any).api.decisionHelperCustody = (id: string) =>
    Promise.resolve({ ok: true, data: id === row.id ? custody : null });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Original Goal reply pending after helper acceptance');
  expect(pane.textContent).not.toContain('Helper retry budget exhausted');
  expect(pane.textContent).not.toContain('new native Send is authorized');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('does not promote an opaque helper error when the latest exact controls cannot be read, then restores the explanation on read-only retry', async () => {
  const row = { ...summary([]), id: 'temporarily-unreadable-helper-controls',
    title: 'Saved Loop with temporarily unreadable helper state',
    conversationId: 'helper-unreadable-provider', chatIds: ['helper-unreadable-provider'],
    activeTurnId: 'helper-source-current', fileEdits: 1, lastFileChangeAt: T0 + 1_000 };
  const final: SessionEvent = { kind: 'assistant_message', source: 'extension',
    seq: 1, time: T0 + 1_000, messageId: 'earlier-output-before-helper',
    final: true, message: text('Prior useful work survives both the failed read and its recovery.') };
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: [final] },
    controls: { automation: 'loop', activeTurnId: 'helper-source-current',
      goalDraft: { stage: 'failed', stageStartedAt: T0 + 3_000,
        model: 'gpt-6-thinking', text: '', error: 'goal_browser_helper_exhausted',
        message: 'Three helper attempts failed for this exact turn.' } } });
  const api = (app.w as any).api, readControls = api.getSessionControls;
  api.getSessionControls = () => Promise.resolve({ ok: false, error: 'Synthetic read unavailable' });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Latest progress could not be read');
  expect(pane.textContent).toContain('Prior useful work survives');
  expect(pane.textContent).not.toContain('Helper retry budget exhausted');
  api.getSessionControls = readControls;
  const retry = pane.querySelector<HTMLButtonElement>('[data-work-action="retry"]')!;
  expect(retry).toBeTruthy();
  retry.click(); await settle();
  expect(pane.textContent).toContain('Helper retry budget exhausted');
  expect(pane.textContent).toContain('Prior useful work survives');
  expect(pane.textContent).not.toContain('Latest progress could not be read');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('shows bounded private-helper delivery, answer and Goal reply custody in Work detail without claiming Send', async () => {
  const row = { ...summary([]), id: 'helper-custody-work-detail', conversationId: 'original-helper-source',
    chatIds: ['original-helper-source'], title: 'Original Goal with saved private helpers',
    fileEdits: 1, lastFileChangeAt: T0 + 10_000 };
  const custody: SessionDecisionHelperCustody = {
    sessionId: row.id, conversationId: row.conversationId,
    pendingOriginalReply: { replyId: 'goal-reply-held', sourceTurnId: 'original-turn', acceptedAt: T0 + 11_000 },
    retainedTotal: 43, truncated: true,
    helpers: [
      { id: 'helper-delivered-unanswered', sourceTurnId: 'original-turn', createdAt: T0 + 6_000,
        state: 'cancelled', phase: 'cancelled-after-native-delivery', nativeSend: 'confirmed',
        nativeMessageId: 'confirmed-helper-native-message', sendAuthorizedAt: T0 + 7_000,
        deliveredAt: T0 + 8_000, answer: 'not-recorded', rejection: null, sourceSuperseded: false,
        continuation: null },
      { id: 'helper-accepted-but-unsent-continuation', sourceTurnId: 'original-turn', createdAt: T0 + 4_000,
        state: 'sent', phase: 'answer-accepted', nativeSend: 'confirmed',
        nativeMessageId: 'accepted-helper-native-message', sendAuthorizedAt: T0 + 4_500,
        deliveredAt: T0 + 5_000, answer: 'accepted', rejection: null, sourceSuperseded: false,
        continuation: { id: 'continuation-still-queued', state: 'queued', nativeSend: 'not-confirmed',
          nativeMessageId: null, deliveredAt: null } }
    ]
  };
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: [] } });
  const api = (app.w as any).api;
  let readFails = false;
  api.decisionHelperCustody = vi.fn((id: string) => readFails
    ? Promise.resolve({ ok: false, error: 'Private helper read unavailable' })
    : Promise.resolve({ ok: true, data: id === row.id ? custody : null }));
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const field = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Private helper & Goal reply')!;
  expect(field.textContent).toContain('Original Goal reply pending');
  expect(field.textContent).toContain('native Send not confirmed');
  expect(field.textContent).toContain('43 retained private helpers');
  const disclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-helper-custody')!;
  expect(disclosure).not.toBeNull();
  expect(disclosure.querySelectorAll('li')).toHaveLength(2);
  expect(disclosure.textContent).toContain('Only 2 of 43 retained helper records shown');
  expect(disclosure.textContent).toContain('Native Send confirmed · answer not recorded · cancelled after delivery');
  expect(disclosure.textContent).toContain('Helper answer accepted');
  expect(disclosure.textContent).toContain('source continuation queued · native Send not confirmed');
  expect(pane.textContent).not.toContain('confirmed-helper-native-message');
  expect(pane.textContent).not.toContain('accepted-helper-native-message');
  expect(pane.textContent).not.toContain('goal-reply-held');
  expect(pane.textContent).not.toContain('continuation-still-queued');
  expect(pane.textContent).not.toContain('Original Goal reply sent');
  expect(pane.textContent).not.toContain('Task accepted as complete');
  expect(pane.textContent).toContain('Original Goal reply pending after helper acceptance');
  custody.pendingOriginalReply = null;
  await app.append([]);
  expect(pane.textContent).toContain('Saved source continuation after helper acceptance');
  expect(pane.textContent).not.toContain('Source continuation native Send confirmed');
  disclosure.open = true;
  disclosure.querySelector('summary')!.focus();
  readFails = true;
  await app.append([]);
  expect(pane.querySelector('.work-overview-helper-custody')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(app.w.document.activeElement).toBe(disclosure.querySelector('summary'));
  expect(pane.textContent).toContain('Last confirmed helper custody; latest read unavailable');
  const retry = pane.querySelector<HTMLButtonElement>('[data-work-action="retry-helper"]')!;
  expect(retry).not.toBeNull();
  readFails = false;
  retry.click();
  await settle();
  expect(pane.querySelector('.work-overview-helper-custody')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(pane.textContent).not.toContain('latest read unavailable');
  expect(pane.querySelector('[data-work-action="retry-helper"]')).toBeNull();
  expect(api.decisionHelperCustody).toHaveBeenCalledWith(row.id);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('shows unavailable private helper status on a held Goal without inventing an unsent receipt', async () => {
  const row = { ...summary([]), id: 'held-helper-custody', conversationId: 'held-source-goal',
    chatIds: ['held-source-goal'], title: 'Held Goal with unknown private-helper custody' };
  const automation: AutomationSupervisorSnapshot = { observedAt: Date.now(), targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0,
      stalled: 0, paused: 0, blocked: 1 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId, title: row.title,
      mode: 'goal', state: 'blocked', reason: 'Sign in to the provider on this account.',
      nextAction: 'Review the existing provider restriction.', nextRetryAt: null,
      lastWorkedAt: T0, activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }] };
  const app = await boot([], true, [], [], { sessions: [row], automation, sessionEvents: { [row.id]: [] } });
  const api = (app.w as any).api;
  let available = false;
  api.decisionHelperCustody = vi.fn(() => Promise.resolve(available
    ? { ok: true, data: { sessionId: row.id, conversationId: row.conversationId,
      pendingOriginalReply: null, retainedTotal: 0, truncated: false, helpers: [] } }
    : { ok: false, error: 'Helper read blocked on this account' }));
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Helper custody unavailable');
  expect(pane.textContent).toContain('status are unknown');
  expect(pane.textContent).not.toContain('Native Send confirmed');
  expect(pane.textContent).not.toContain('Helper answer accepted');
  const retry = pane.querySelector<HTMLButtonElement>('[data-work-action="retry-helper"]')!;
  expect(retry).not.toBeNull();
  available = true;
  retry.click();
  await settle();
  expect(pane.textContent).not.toContain('Helper custody unavailable');
  expect(pane.textContent).toContain('Latest exact read: no retained private helpers or pending original Goal reply recorded');
  expect(pane.textContent).toContain('This does not establish task completion');
  expect(pane.querySelector('[data-work-action="retry-helper"]')).toBeNull();
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('does not expose another local session’s helper custody after a Work detail switch or a late read', async () => {
  const alpha = { ...summary([]), id: 'helper-custody-session-A', title: 'Original private Goal A',
    conversationId: 'helper-private-route-A', chatIds: ['helper-private-route-A'],
    fileEdits: 1, lastFileChangeAt: T0 + 10_000 };
  const beta = { ...summary([]), id: 'helper-custody-session-B', title: 'Different Goal B',
    conversationId: 'helper-private-route-B', chatIds: ['helper-private-route-B'],
    fileEdits: 1, lastFileChangeAt: T0 + 12_000 };
  const older: SessionDecisionHelperCustody = { sessionId: alpha.id, conversationId: alpha.conversationId,
    pendingOriginalReply: { replyId: 'private-reply-only-A', sourceTurnId: 'turn-A', acceptedAt: T0 },
    retainedTotal: 0, truncated: false, helpers: [] };
  let finishAlpha!: (result: {ok: boolean;data: SessionDecisionHelperCustody}) => void;
  const alphaWait = new Promise<{ok:boolean;data:SessionDecisionHelperCustody}>(resolve => { finishAlpha = resolve; });
  const app = await boot([], true, [], [], { sessions: [alpha, beta],
    sessionEvents: { [alpha.id]: [], [beta.id]: [] } });
  const api = (app.w as any).api;
  api.decisionHelperCustody = vi.fn((id: string) => id === alpha.id
    ? alphaWait : Promise.resolve({ok:true,data:older})); // A's response must never bind to B.
  const rows = app.w.document.querySelector<HTMLElement>('.work-overview-section[data-work-section="updates"]')!;
  rows.querySelector<HTMLButtonElement>(`[data-session-id="${alpha.id}"]`)!.click();
  await settle();
  rows.querySelector<HTMLButtonElement>(`[data-session-id="${beta.id}"]`)!.click();
  await settle();
  finishAlpha({ok:true,data:older});
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.querySelector('#workOverviewPaneTitle')?.textContent).toBe(beta.title);
  expect(pane.textContent).not.toContain('private-reply-only-A');
  expect(pane.textContent).not.toContain('Original Goal reply pending');
  expect(pane.querySelector('.work-overview-helper-custody')).toBeNull();
  expect(app.live.sent).toEqual([]);
});

it('shows the saved Work result while an optional private-helper custody read remains pending', async () => {
  const row = { ...summary([]), id: 'slow-private-helper-read', title: 'Saved result waiting for optional helper read',
    conversationId: 'slow-helper-chat', chatIds: ['slow-helper-chat'],
    lastAssistantFinalAt: T0 + 1_000, fileEdits: 1, lastFileChangeAt: T0 + 1_000 };
  const final: SessionEvent = { kind: 'assistant_message', source: 'extension', seq: 1,
    time: T0 + 1_000, messageId: 'slow-helper-saved-result', final: true,
    message: text('Recorded result is available while private helper storage is slow.') };
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: [final] } });
  let finishHelper!: (response: {ok:true;data:SessionDecisionHelperCustody}) => void;
  const pendingHelper = new Promise<{ok:true;data:SessionDecisionHelperCustody}>(resolve => { finishHelper = resolve; });
  (app.w as any).api.decisionHelperCustody = vi.fn(() => pendingHelper);
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const resultAlreadyReadable = !!pane.querySelector('.work-overview-result')?.textContent
    .includes('Recorded result is available while private helper storage is slow.') &&
    !!pane.querySelector('[data-work-action="open"]');
  finishHelper({ ok: true, data: { sessionId: row.id, conversationId: row.conversationId,
    retainedTotal: 0, truncated: false, helpers: [], pendingOriginalReply: null } });
  await settle();
  expect(resultAlreadyReadable).toBe(true);
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Recorded result is available');
  expect(app.live.sent).toEqual([]);
});

it('keeps native input/answer evidence scoped to the opened local session across A-B-A Work inspection', async () => {
  const first = { ...summary([]), id: 'receipt-navigation-A', title: 'First native receipt',
    conversationId: 'receipt-provider-A', chatIds: ['receipt-provider-A'],
    fileEdits: 1, lastFileChangeAt: T0 + 10_000 };
  const second = { ...summary([]), id: 'receipt-navigation-B', title: 'Second unrelated native receipt',
    conversationId: 'receipt-provider-B', chatIds: ['receipt-provider-B'],
    fileEdits: 1, lastFileChangeAt: T0 + 12_000 };
  const sourceA: SessionEvent[] = [{ kind: 'user_message', seq: 2, time: T0 + 10_000,
    source: 'app', messageId: 'native-A', inputId: 'input-A', inputDelivery: 'confirmed',
    message: text('First input') }];
  const sourceB: SessionEvent[] = [{ kind: 'user_message', seq: 2, time: T0 + 12_000,
    source: 'app', messageId: 'native-B', inputId: 'input-B', inputDelivery: 'confirmed',
    message: text('Second input') }];
  const app = await boot([], true, [], [], { sessions: [first, second],
    sessionEvents: { [first.id]: sourceA, [second.id]: sourceB } });
  const doc = app.w.document;
  const pane = doc.getElementById('workOverviewPane')!;
  const row = (id: string) => doc.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${id}"]`)!;
  row(first.id).click();
  await settle();
  expect(pane.textContent).toContain('native-A');
  expect(pane.textContent).not.toContain('native-B');
  row(second.id).click();
  await settle();
  expect(pane.textContent).toContain('native-B');
  expect(pane.textContent).not.toContain('native-A');
  row(first.id).click();
  await settle();
  expect(pane.textContent).toContain('native-A');
  expect(pane.textContent).not.toContain('native-B');
  expect(doc.querySelectorAll('.work-overview-row[aria-expanded="true"]')).toHaveLength(1);
  expect(app.live.sent).toEqual([]);
});

it('attributes an outbox-only native receipt to deliveredSessionId instead of a stale source session', async () => {
  const source = { ...summary([]), id: 'delivery-original-session', title: 'Original source session',
    conversationId: 'original-source-provider', chatIds: ['original-source-provider'],
    fileEdits: 1, lastFileChangeAt: T0 + 500 };
  const destination = { ...summary([]), id: 'delivery-bound-destination', title: 'Bound delivery destination',
    conversationId: 'bound-native-provider', chatIds: ['bound-native-provider'] };
  const receipt: InputEntry = { id: 'rebound-input-id', sessionId: source.id, deliveredSessionId: destination.id,
    conversationId: destination.conversationId, text: 'One native input bound to destination',
    mode: 'auto', dueAt: 0, model: 'gpt-6-thinking', reasoningEffort: 'xhigh',
    state: 'sent', owner: 'original-elected-page', createdAt: T0 + 1_000,
    deliveredAt: T0 + 2_000, messageId: 'native-rebound-destination' };
  const app = await boot([], true, [], [], { sessions: [source, destination],
    sessionEvents: { [source.id]: [], [destination.id]: [] }, inputs: [receipt] });
  const updates = app.w.document.querySelector<HTMLElement>('.work-overview-section[data-work-section="updates"]')!;
  const sourceRow = updates.querySelector<HTMLButtonElement>(`[data-session-id="${source.id}"]`)!;
  expect(sourceRow).not.toBeNull();
  sourceRow.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).not.toContain('native-rebound-destination');
  const target = updates.querySelector<HTMLButtonElement>(`[data-session-id="${destination.id}"]`)!;
  expect(target).not.toBeNull();
  target.click();
  await settle();
  expect(pane.textContent).toContain('native-rebound-destination');
  expect(pane.textContent).not.toContain('Original source session');
  expect(app.live.sent).toEqual([]);
});

it('updates a late outbox cancellation without detaching an earlier saved result or its keyboard focus', async () => {
  const row = { ...summary([]), id: 'later-native-cancellation', title: 'Retained answer and native cancellation',
    conversationId: 'late-native-cancellation-provider', chatIds: ['late-native-cancellation-provider'],
    lastAssistantFinalAt: T0 + 2_000, fileEdits: 1, lastFileChangeAt: T0 + 2_000 };
  const older: SessionEvent = { kind: 'assistant_message', seq: 1, time: T0 + 2_000,
    source: 'extension', messageId: 'saved-prior-implementation', final: true,
    message: text('Existing earlier source result remains available after the new input is cancelled.') };
  const question: SessionEvent = { kind: 'user_message', seq: 2, time: T0 + 5_000,
    source: 'app', messageId: 'recorded-native-new-question', inputId: 'late-cancelled-input',
    inputDelivery: 'confirmed', message: text('Newest follow-up asking for physical validation.') };
  const entry: InputEntry = { id: question.inputId!, sessionId: row.id,
    conversationId: row.conversationId, text: 'Newest follow-up asking for physical validation.',
    mode: 'auto', dueAt: 0, model: 'gpt-6-thinking', reasoningEffort: 'xhigh',
    state: 'sent', owner: 'native-elected-tab', createdAt: T0 + 4_000,
    deliveredAt: T0 + 5_000, messageId: question.messageId };
  const app = await boot([], true, [], [], {
    sessions: [row], sessionEvents: { [row.id]: [older, question] }, inputs: [entry]
  });
  const pane = app.w.document.getElementById('workOverviewPane')!;
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const disclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  const body = disclosure.querySelector<HTMLElement>('.work-overview-result-body')!;
  disclosure.open = true;
  disclosure.querySelector('summary')!.focus();
  const deliveryField = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(field => field.querySelector('b')?.textContent === 'Native delivery & answer')!;
  expect(deliveryField.textContent).not.toContain('Cancelled after delivery');
  app.live.inputs[0]!.state = 'cancelled';
  app.live.inputs[0]!.error = 'Collection deadline expired; no automatic retry';
  await app.append([]);
  expect(pane.querySelector('.work-overview-result')).toBe(disclosure);
  expect(pane.querySelector('.work-overview-result-body')).toBe(body);
  expect(disclosure.open).toBe(true);
  expect(app.w.document.activeElement).toBe(disclosure.querySelector('summary'));
  expect(deliveryField.textContent).toContain('Cancelled after delivery');
  expect(deliveryField.textContent).toContain('Collection deadline expired');
  expect(deliveryField.textContent).not.toContain('answer accepted');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Existing earlier source result');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('never treats an unconfirmed tool handout as a native Send or a collected answer', async () => {
  const row = { ...summary([]), id: 'offered-only-work', title: 'Tool offer awaits native receipt',
    conversationId: 'unconfirmed-tool-input', chatIds: ['unconfirmed-tool-input'],
    fileEdits: 1, lastFileChangeAt: T0 + 3_000 };
  const offered: SessionEvent = { kind: 'user_message', seq: 1, time: T0 + 3_000,
    source: 'app', inputId: 'tool-offer-not-sent', messageId: 'offered-user-message',
    inputDelivery: 'offered', message: text('Await exact later Core pickup.') };
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: [offered] } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const delivery = [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Native delivery & answer')!.textContent ?? '';
  expect(delivery).toContain('Tool handout offered');
  expect(delivery).toContain('native Send receipt not established');
  expect(delivery).not.toContain('Native Send confirmed');
  expect(delivery).not.toContain('Exact answer recorded');
  expect(app.live.sent).toEqual([]);
});

it('keeps Work detail actions and unchanged status text mounted through evidence refresh', async () => {
  const selected = summary([]);
  const result = { ...summary([]), id: 'stable-detail-actions', title: 'Status detail remains keyboard-readable',
    conversationId: 'stable-detail-provider', chatIds: ['stable-detail-provider'],
    fileEdits: 1, lastFileChangeAt: T0 + 30_000, lastToolCallAt: T0 + 20_000 };
  const events: SessionEvent[] = [toolCall(1, 'initial-detail-evidence')];
  const app = await boot([], true, [], [], {
    sessions: [selected, result], sessionEvents: { [result.id]: events }
  });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-row[data-session-id="${result.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const close = pane.querySelector<HTMLButtonElement>('[data-work-action="close"]')!;
  const open = pane.querySelector<HTMLButtonElement>('[data-work-action="open"]')!;
  const status = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(node => node.querySelector('b')?.textContent === 'Current status')!;
  const value = status.querySelector('span')!;
  const originalText = value.firstChild;
  const originalStatus = value.textContent;
  let actionDetachments = 0;
  let statusDetachments = 0;
  let paneMoves = 0;
  const paneParent = pane.parentElement!;
  const paneObserver = new app.w.MutationObserver(records => {
    for (const record of records) if ([...record.removedNodes].includes(pane)) paneMoves++;
  });
  paneObserver.observe(paneParent, { childList: true });
  const observer = new app.w.MutationObserver(records => {
    for (const record of records) {
      for (const removed of record.removedNodes) {
        if (removed === close || removed === open || removed.contains?.(close) || removed.contains?.(open)) actionDetachments++;
        if (removed === status || removed.contains?.(status)) statusDetachments++;
      }
    }
  });
  observer.observe(pane, { childList: true, subtree: true });
  open.focus();
  app.notifySession();
  await settle(700);
  expect(pane.querySelector('[data-work-action="close"]')).toBe(close);
  expect(pane.querySelector('[data-work-action="open"]')).toBe(open);
  expect(app.w.document.activeElement).toBe(open);
  expect([...pane.querySelectorAll('.work-overview-pane-field')]
    .find(node => node.querySelector('b')?.textContent === 'Current status')).toBe(status);
  expect(value.firstChild).toBe(originalText);
  expect(value.textContent).toBe(originalStatus);
  expect(actionDetachments).toBe(0);
  expect(statusDetachments).toBe(0);
  expect(paneMoves).toBe(0);

  // Changed evidence must still update the existing named field without moving the user's control.
  result.lastToolCallAt = T0 + 140_000;
  events.push(toolCall(3, 'newer-detail-evidence'));
  app.notifySession();
  await settle(700);
  expect(pane.querySelector('[data-work-action="open"]')).toBe(open);
  expect(app.w.document.activeElement).toBe(open);
  expect(value.parentElement).toBe(status);
  expect(value.textContent).not.toBe(originalStatus);
  expect(value.textContent).toContain('Last exact local tool recorded');
  expect(actionDetachments).toBe(0);
  expect(statusDetachments).toBe(0);
  expect(paneMoves).toBe(0);
  observer.disconnect();
  paneObserver.disconnect();
});

it('shows a saved worker report as delivered only after the exact Prime receipt, despite foreign reports', async () => {
  const prime = { ...summary([]), id: 'receipt-owner-prime', title: 'Prime with saved worker result' };
  const worker = { ...summary([]), id: 'receipt-owner-worker', title: 'Finished review worker',
    conversationId: 'receipt-owner-worker-provider', chatIds: ['receipt-owner-worker-provider'],
    origin: { kind: 'worker' as const, fromSessionId: prime.id, agentId: 'worker-1', task: 'Review status' },
    lastFinishReportAt: T0 + 40_000, lastToolCallAt: T0 + 25_000 };
  const report: SessionEvent = { kind: 'agent_message', seq: 3, time: T0 + 40_000, source: 'app',
    agent: 'worker-1', messageId: 'exact-worker-report', from: 'worker-1', to: 'prime', delivery: 'sent',
    message: text('[worker-1 finished] RESULT: Verified the actual UI status behavior.') };
  const parentEvents: SessionEvent[] = [{ kind: 'agent_message', seq: 1, time: T0 + 41_000, source: 'app',
    agent: 'prime', messageId: 'exact-worker-report', from: 'worker-2', to: 'prime', delivery: 'delivered',
    message: text('Foreign worker report must never confirm this worker.') }];
  const app = await boot([], true, [], [], { sessions: [prime, worker],
    sessionEvents: { [worker.id]: [report], [prime.id]: parentEvents } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-row[data-session-id="${worker.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Verified the actual UI status behavior');
  expect(pane.textContent).not.toContain('Prime received this report');
  expect(pane.textContent).not.toContain('Foreign worker report');
  expect(app.sessionReads).toContainEqual({ id: prime.id, limit: 80 });
  const savedDisclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  savedDisclosure.open = true;
  const savedText = savedDisclosure.querySelector<HTMLElement>('.work-overview-result-body')!;
  savedDisclosure.querySelector('summary')!.focus();

  parentEvents.push({ kind: 'agent_message', seq: 2, time: T0 + 45_000, source: 'app',
    agent: 'prime', messageId: report.messageId, from: 'worker-1', to: 'prime', delivery: 'delivered',
    message: text('A genuine receipt exists only in Prime history.') });
  app.notifySession();
  await settle(700);
  expect(pane.textContent).toContain('Prime received this report');
  expect(pane.textContent).not.toContain('delivery not yet confirmed');
  expect(pane.textContent).not.toContain('Foreign worker report');
  expect(pane.querySelector('.work-overview-result')).toBe(savedDisclosure);
  expect(pane.querySelector('.work-overview-result-body')).toBe(savedText);
  expect(savedDisclosure.open).toBe(true);
  expect(app.w.document.activeElement).toBe(savedDisclosure.querySelector('summary'));
});

it('keeps a late Prime receipt from reopening a cancelled worker detail and handles recipient read failure', async () => {
  const prime = { ...summary([]), id: 'cancelled-prime-receipt' };
  const worker = { ...summary([]), id: 'cancelled-worker-detail',
    conversationId: 'cancelled-worker-provider', chatIds: ['cancelled-worker-provider'],
    origin: { kind: 'worker' as const, fromSessionId: prime.id, agentId: 'worker-1', task: 'Review' },
    lastFinishReportAt: T0 + 40_000, lastToolCallAt: T0 + 20_000 };
  const report: SessionEvent = { kind: 'agent_message', seq: 3, time: T0 + 40_000, source: 'app',
    agent: 'worker-1', messageId: 'exact-cancelled-report', from: 'worker-1', to: 'prime',
    delivery: 'sent', message: text('[worker-1 reported] RESULT: Saved despite a closed tab.') };
  const receipt: SessionEvent = { ...report, seq: 4, time: T0 + 42_000, agent: 'prime', delivery: 'delivered' };
  const app = await boot([], true, [], [], {
    sessions: [prime, worker], sessionEvents: { [worker.id]: [report], [prime.id]: [receipt] }
  });
  const nativeApi = (app.w as any).api;
  const originalRead = nativeApi.getSession;
  let resolvePrime!: (value: unknown) => void;
  nativeApi.getSession = (id: string, query?: { limit?: number }) => id === prime.id && query?.limit === 80
    ? new Promise(resolve => { resolvePrime = resolve; }) : originalRead(id, query);
  const row = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-row[data-session-id="${worker.id}"]`)!;
  row.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Reading this chat');
  pane.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(pane.hidden).toBe(true);
  resolvePrime({ ok: true, data: { summary: prime, events: [receipt], total: 1, nextFrom: 5 } });
  await settle();
  expect(pane.hidden).toBe(true);
  expect(row.getAttribute('aria-expanded')).toBe('false');

  nativeApi.getSession = (id: string, query?: { limit?: number }) => id === prime.id && query?.limit === 80
    ? Promise.resolve({ ok: false, error: 'Prime read temporarily unavailable' }) : originalRead(id, query);
  row.click();
  await settle();
  expect(pane.textContent).toContain('Prime receipt unavailable');
  expect(pane.textContent).not.toContain('Prime received this report');
  nativeApi.getSession = originalRead;
  app.notifySession();
  await settle(700);
  expect(pane.textContent).toContain('Prime received this report');
  expect(app.live.controlCalls).toEqual([]);
});

it('shows the exact locally saved worker report in Work & updates without claiming Prime receipt', async () => {
  const primeEvents = [toolCall(1, 'prime-receipt-check')];
  const prime = summary(primeEvents);
  const worker = {
    ...summary([]), id: 'saved-worker-report', title: 'Completed independent review',
    conversationId: 'worker-report-chat', chatIds: ['worker-report-chat'],
    origin: { kind: 'worker' as const, fromSessionId: prime.id, agentId: 'worker-1', task: 'Review UI behavior' },
    lastFinishReportAt: T0 + 60_000, lastToolCallAt: T0 + 35_000,
    lastAssistantFinalAt: T0 + 30_000, activeTurnId: 'native-page-still-open'
  };
  const report: SessionEvent = {
    kind: 'agent_message', seq: 4, time: T0 + 60_000, source: 'app', agent: 'worker-1',
    messageId: 'saved-worker-1-result', from: 'worker-1', to: 'prime', delivery: 'sent',
    // This fixture expects a CURRENT report despite a still-open native turn;
    // supply the exact positive turn binding, not an ambiguous untagged A report.
    turnId: 'native-page-still-open',
    message: text(`[worker-1 reported] RESULT: Completed accessibility review.\n${'Observed safe native controls. '.repeat(52)}\n` +
      'VALIDATION: Keyboard regression passed in the renderer fixture.\nBLOCKERS: Installed interface still needs a keyboard check.')
  };
  const unrelated: SessionEvent = {
    kind: 'agent_message', seq: 3, time: T0 + 40_000, source: 'app', agent: 'worker-1',
    messageId: 'unrelated-status', from: 'worker-1', to: 'prime', delivery: 'sent',
    message: text('Private interim progress must not be mistaken for the final report.')
  };
  const { w } = await boot([], true, [], [], {
    sessions: [prime, worker], sessionEvents: { [worker.id]: [toolCall(2, 'older-check'), unrelated, report], [prime.id]: primeEvents }
  });
  const row = w.document.querySelector<HTMLButtonElement>('.work-overview-row[data-session-id="saved-worker-report"]')!;
  expect(row.textContent).toContain('Worker report saved');
  row.click();
  await settle();
  const pane = w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Completed accessibility review');
  expect(pane.textContent).toContain('Installed interface still needs a keyboard check');
  expect(pane.textContent).toContain('No matching receipt in the most recent Prime history');
  expect(pane.textContent).not.toContain('Private interim progress');
  expect(pane.textContent).not.toContain('Prime received');
  const reportDisclosure = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  expect(reportDisclosure).not.toBeNull();
  expect(reportDisclosure.querySelector('summary')?.textContent).toBe('Read saved worker report');
  reportDisclosure.open = true;
  expect(reportDisclosure.textContent).toContain('VALIDATION: Keyboard regression passed');
  expect(reportDisclosure.textContent).toContain('BLOCKERS: Installed interface still needs a keyboard check.');
  expect(pane.querySelector('.work-overview-pane-field')?.textContent).not.toContain('VALIDATION: Keyboard regression passed');
  expect(pane.textContent).not.toContain('Prime received');
  expect(w.document.getElementById('chatTitle')!.textContent).toBe(prime.title);
});

it('reveals the complete recorded final from a bounded Work preview only on demand and retains keyboard focus', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), id: 'full-read-recorded-final',
    conversationId: 'full-result-provider', chatIds: ['full-result-provider'],
    title: 'Long retained final and validation', lastAssistantFinalAt: now - 1000,
    lastMessageAt: now - 1000, updatedAt: now };
  const body = `RESULT: ${'verified change, '.repeat(880)}\nVALIDATION: source result tail available.\nNEXT: Exact historical follow-up.`;
  const final: SessionEvent = { kind: 'assistant_message', seq: 1, time: now - 1000,
    source: 'extension', turnId: 'final-turn', messageId: 'full-saved-result',
    final: true, state: 'final', message: text(body) };
  const events: SessionEvent[] = [final];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: events } });
  const button = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!;
  button.click(); await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const recorded = () => pane.querySelector<HTMLElement>('.work-overview-result-body')?.textContent ?? '';
  expect(recorded().length).toBe(12000);
  expect(recorded()).not.toContain('NEXT: Exact historical follow-up.');
  const reveal = pane.querySelector<HTMLButtonElement>(
    '.work-overview-result [data-work-action="expand-current-result"]')!;
  expect(reveal).not.toBeNull();
  expect(reveal.getAttribute('aria-expanded')).toBe('false');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('12,000');
  reveal.focus(); reveal.click();
  expect(recorded()).toBe(body);
  expect(reveal.getAttribute('aria-expanded')).toBe('true');
  expect(reveal.textContent).toContain('Show shorter preview');
  expect(app.w.document.activeElement).toBe(reveal);
  app.notifySession(); await settle(700);
  expect(pane.querySelector('[data-work-action="expand-current-result"]')).toBe(reveal);
  expect(recorded()).toBe(body);
  expect(reveal.getAttribute('aria-expanded')).toBe('true');
  expect(app.w.document.activeElement).toBe(reveal);
  // The recorder may revise one final without changing its original message
  // identity. Preserve the disclosure, but update the exact retained text.
  const revised = body.replace('NEXT: Exact historical follow-up.', 'NEXT: Revised current saved receipt is available.');
  events.push({ ...final, seq: 2, origin: 1, semanticUpdatedAt: now + 5000,
    message: text(revised) });
  row.events = events.length;
  row.updatedAt = now + 5000;
  app.notifySession(); await settle(700);
  expect(pane.querySelector('[data-work-action="expand-current-result"]')).toBe(reveal);
  expect(recorded()).toBe(revised);
  expect(recorded()).not.toContain('NEXT: Exact historical follow-up.');
  expect([...pane.querySelectorAll('.work-overview-history li')].filter(
    item => item.textContent?.includes('Final answer recorded'))).toHaveLength(1);
  expect(app.w.document.activeElement).toBe(reveal);
  reveal.click();
  expect(recorded().length).toBe(12000);
  expect(reveal.getAttribute('aria-expanded')).toBe('false');
  pane.querySelector<HTMLButtonElement>('[data-work-action="close"]')!.click();
  expect(app.w.document.activeElement).toBe(button);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('exposes a late historical worker report tail without promoting it or claiming unrecorded text', async () => {
  const now = Date.now();
  const prime = { ...summary([]), id: 'long-worker-prime', title: 'Prime review' };
  const worker: SessionSummary = { ...summary([]), id: 'long-historical-worker',
    conversationId: 'long-provider-B', chatIds: ['long-provider-A', 'long-provider-B'],
    title: 'Current B worker and previous A report',
    origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-1', task: 'Review evidence' },
    lastFinishReportAt: now - 1000, lastMessageAt: now - 1000,
    finishTurn: { turnId: 'worker-turn-B', conversationId: 'long-provider-B',
      startedAt: now - 5000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const historical = `[worker-1 finished] RESULT: ${'historical notes '.repeat(850)}\nBLOCKERS: A result is still retained after B.`;
  const reportB: SessionEvent = { kind: 'agent_message', seq: 2, time: now - 2000, source: 'app',
    from: 'worker-1', to: 'prime', agent: 'worker-1', delivery: 'sent',
    messageId: 'worker-B-verified', turnId: 'worker-turn-B',
    message: text('[worker-1 finished] RESULT: B remains the exact latest worker report.') };
  const reportA: SessionEvent = { ...reportB, seq: 3, time: now - 1000,
    turnId: 'worker-turn-A', messageId: 'worker-A-historical', message: { ...text(historical), truncated: true } };
  const app = await boot([], true, [], [], { sessions: [prime, worker],
    sessionEvents: { [worker.id]: [reportB, reportA] } });
  const row = app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${worker.id}"]`)!;
  row.click(); await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('B remains the exact latest');
  const previous = pane.querySelector<HTMLDetailsElement>('.work-overview-historical-worker-result')!;
  expect(previous).not.toBeNull();
  expect(previous.querySelector('.work-overview-result-body')?.textContent?.length).toBe(12000);
  expect(previous.textContent).toContain('Recorder retained only part');
  const reveal = previous.querySelector<HTMLButtonElement>('[data-work-action="expand-historical-result"]')!;
  expect(reveal).not.toBeNull();
  previous.open = true;
  reveal.focus(); reveal.click();
  expect(previous.querySelector('.work-overview-result-body')?.textContent).toBe(historical);
  expect(previous.textContent).toContain('A result is still retained after B.');
  expect(previous.textContent).toContain('Original recording was truncated');
  app.notifySession(); await settle(700);
  expect(previous.open).toBe(true);
  expect(previous.querySelector('[data-work-action="expand-historical-result"]')).toBe(reveal);
  expect(reveal.getAttribute('aria-expanded')).toBe('true');
  expect(app.w.document.activeElement).toBe(reveal);
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('B remains the exact latest');
  expect(pane.textContent).not.toContain('Prime received this report');
  expect(app.live.sent).toEqual([]);
});

it('keeps distinct turn finals separate even when a provider reuses a message identifier', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), id: 'turn-specific-recorded-finals',
    title: 'Two genuine turn results with a reused provider identifier',
    conversationId: 'same-conversation-distinct-turns',
    chatIds: ['same-conversation-distinct-turns'], activeTurnId: null,
    lastAssistantFinalAt: now - 1000, lastMessageAt: now - 500,
    lastTurnOutcome: 'completed', lastTurnEndAt: now - 500,
    finishTurn: { turnId: 'real-native-turn-B', conversationId: 'same-conversation-distinct-turns',
      startedAt: now - 3000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  const first: SessionEvent = { kind: 'assistant_message', seq: 2, time: now - 8000,
    source: 'extension', turnId: 'real-native-turn-A', messageId: 'reused-message-id',
    final: true, state: 'final', message: text('Earlier distinct A output, still preserved.') };
  const second: SessionEvent = { ...first, seq: 5, time: now - 1000,
    turnId: 'real-native-turn-B',
    message: text('Current B output with independent identity.') };
  const records: SessionEvent[] = [
    { kind: 'turn_start', seq: 1, time: now - 9000, source: 'extension', turnId: 'real-native-turn-A' },
    first,
    { kind: 'turn_end', seq: 3, time: now - 7000, source: 'extension',
      turnId: 'real-native-turn-A', outcome: 'completed' },
    { kind: 'turn_start', seq: 4, time: now - 3000, source: 'extension', turnId: 'real-native-turn-B' },
    second,
    { kind: 'turn_end', seq: 6, time: now - 500, source: 'extension',
      turnId: 'real-native-turn-B', outcome: 'completed' }
  ];
  const app = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: records } });
  app.w.document.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="updates"] [data-session-id="${row.id}"]`)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Current B output');
  expect(pane.querySelector('.work-overview-result')?.textContent).not.toContain('Earlier distinct A output');
  expect([...pane.querySelectorAll('.work-overview-history li')].filter(
    item => item.textContent?.includes('Final answer recorded'))).toHaveLength(2);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('shows failed Work & updates reads as unavailable and recovers on an explicit retry', async () => {
  const row = {
    ...summary([]), title: 'Read failure review',
    conversationId: 'read-failure-provider', chatIds: ['read-failure-provider'],
    fileEdits: 1, linesAdded: 2,
    lastFileChangeAt: T0 + 55_000
  };
  const final: SessionEvent = {
    kind: 'assistant_message', seq: 1, time: T0 + 55_000, source: 'extension', messageId: 'saved-final',
    message: text('Retained result is readable after recovery.'), final: true
  };
  const { w } = await boot([], true, [], [], { sessions: [row], sessionEvents: { [row.id]: [final] } });
  const actualGetSession = (w as any).api.getSession;
  const actualGetControls = (w as any).api.getSessionControls;
  let failedReads = 2;
  (w as any).api.getSession = (...args: unknown[]) => failedReads-- > 0
    ? Promise.resolve({ ok: false, error: 'Temporary session read failure' }) : actualGetSession(...args);
  (w as any).api.getSessionControls = (...args: unknown[]) => failedReads-- > 0
    ? Promise.resolve({ ok: false, error: 'Temporary progress read failure' }) : actualGetControls(...args);
  w.document.querySelector<HTMLButtonElement>('.work-overview-row')!.click();
  await settle();
  const pane = w.document.getElementById('workOverviewPane')!;
  expect(pane.textContent).toContain('Latest progress and history could not be read');
  expect(pane.textContent).toContain('Latest controls and checklist read unavailable');
  expect(pane.textContent).not.toContain('No acceptance checklist is recorded for this chat');
  expect(pane.textContent).not.toContain('No recent successful tool calls or recorded final answers');
  const retry = [...pane.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry read')!;
  expect(retry).toBeTruthy();
  retry.click();
  await settle();
  expect(pane.textContent).toContain('Recorded final: Retained result is readable after recovery.');
  expect(pane.textContent).not.toContain('could not be read');
});

it('retains the last confirmed Work result through a later history outage without calling it current success', async () => {
  const previous: SessionSummary = { ...summary([]), id: 'history-outage-previous',
    title: 'Result retained through a connection gap', conversationId: 'history-gap-chat',
    chatIds: ['history-gap-chat'], lastAssistantFinalAt: T0 + 3_000,
    lastTurnEndAt: T0 + 4_000, lastTurnOutcome: 'completed',
    fileEdits: 1, lastFileChangeAt: T0 + 3_000 };
  const other: SessionSummary = { ...summary([]), id: 'history-outage-other',
    title: 'Other unrelated chat', conversationId: 'other-provider-chat',
    chatIds: ['other-provider-chat'], lastAssistantFinalAt: T0 + 5_000,
    fileEdits: 1, lastFileChangeAt: T0 + 5_000 };
  const saved: SessionEvent = { kind: 'assistant_message', seq: 2, time: T0 + 3_000,
    source: 'extension', turnId: 'first-completed', messageId: 'saved-before-outage', final: true,
    message: text('RESULT: Already recorded valid implementation. VALIDATION: passed before outage.') };
  const unrelated: SessionEvent = { ...saved, seq: 3, time: T0 + 5_000, messageId: 'unrelated-final',
    message: text('RESULT: Different session must remain separate.') };
  const previousEvents: SessionEvent[] = [saved];
  const app = await boot([], true, [], [], { sessions: [previous, other],
    sessionEvents: { [previous.id]: previousEvents, [other.id]: [unrelated] } });
  const target = '.work-overview-section[data-work-section="updates"] [data-session-id="' + previous.id + '"]';
  app.w.document.querySelector<HTMLButtonElement>(target)!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = () => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(row => row.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  const result = pane.querySelector<HTMLDetailsElement>('.work-overview-result')!;
  expect(result.textContent).toContain('Already recorded valid implementation');
  result.open = true;
  result.querySelector('summary')!.focus();

  let failHistory = true;
  const originalRead = (app.w as any).api.getSession;
  (app.w as any).api.getSession = (id: string, query?: { limit?: number }) =>
    id === previous.id && failHistory
      ? Promise.resolve({ ok: false, error: 'Session history temporarily disconnected.' })
      : originalRead(id, query);
  previous.lastToolCallAt = T0 + 7_000;
  previous.lastTurnOutcome = 'failed';
  const rejected = toolCall(7, 'newer-failed-tool') as Extract<SessionEvent, { kind: 'tool_call' }>;
  rejected.call.outcome = 'tool_rejected';
  rejected.call.summary = { kind: 'read', title: 'Latest access denied', tone: 'bad' };
  previousEvents.push(rejected);
  app.notifySession();
  await settle(700);
  expect(pane.textContent).toContain('Latest history could not be read');
  expect(pane.textContent).toContain('Latest history read unavailable');
  expect(pane.textContent).toContain('Use Retry read in Work detail');
  expect(pane.querySelector('.work-overview-result-body')?.textContent)
    .toContain('Already recorded valid implementation');
  expect(justDid()).toContain('Latest history unavailable');
  expect(justDid()).not.toContain('Recorded final:');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toContain('last confirmed');
  expect(pane.querySelector<HTMLDetailsElement>('.work-overview-result')?.open).toBe(true);
  expect(app.w.document.activeElement).toBe(pane.querySelector('.work-overview-result summary'));
  expect(pane.querySelector('[data-work-action="retry"]')).not.toBeNull();

  app.w.document.querySelector<HTMLButtonElement>(
    '.work-overview-section[data-work-section="updates"] [data-session-id="' + other.id + '"]')!.click();
  await settle();
  expect(pane.textContent).toContain('Different session must remain separate');
  expect(pane.textContent).not.toContain('Already recorded valid implementation');

  failHistory = false;
  app.w.document.querySelector<HTMLButtonElement>(target)!.click();
  await settle();
  expect(justDid()).toContain('Rejected');
  expect(justDid()).toContain('Latest access denied');
  expect(pane.textContent).toContain('Already recorded valid implementation');
  expect(pane.textContent).not.toContain('Latest history could not be read');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read previous recorded final answer');
  expect(app.live.sent).toEqual([]);
});

it('uses the exact refreshed Work session boundary when its sidebar summary still describes an older turn', async () => {
  const listed: SessionSummary = { ...summary([]), id: 'outdated-sidebar-work-result',
    title: 'Provider rebind before the next sidebar snapshot',
    conversationId: 'old-provider-binding', chatIds: ['old-provider-binding'],
    lastAssistantFinalAt: T0 + 2_000, lastTurnEndAt: T0 + 3_000,
    activeTurnId: 'older-turn', fileEdits: 1, lastFileChangeAt: T0 + 2_000 };
  let exact: SessionSummary = { ...listed, conversationId: 'new-provider-binding',
    chatIds: ['old-provider-binding', 'new-provider-binding'], activeTurnId: 'newer-turn',
    events: 4, lastTurnOutcome: null };
  const oldResult: SessionEvent = { kind: 'assistant_message', seq: 2, time: T0 + 2_000,
    source: 'extension', turnId: 'older-turn', messageId: 'old-provider-final', final: true,
    message: text('Previous provider answer was saved before the new turn.') };
  const rows: SessionEvent[] = [
    { kind: 'turn_start', seq: 1, time: T0 + 1_000, source: 'extension', turnId: 'older-turn' },
    oldResult,
    { kind: 'turn_end', seq: 3, time: T0 + 3_000, source: 'extension',
      turnId: 'older-turn', outcome: 'completed' },
    { kind: 'turn_start', seq: 4, time: T0 + 4_000, source: 'extension', turnId: 'newer-turn' }
  ];
  const app = await boot([], true, [], [], { sessions: [listed], sessionEvents: { [listed.id]: rows } });
  const normalRead = (app.w as any).api.getSession;
  (app.w as any).api.getSession = (id: string, query?: { limit?: number }) =>
    normalRead(id, query).then((result: { ok: boolean; data: { summary: SessionSummary } }) =>
      id === listed.id && result.ok ? { ...result, data: { ...result.data, summary: { ...exact } } } : result);
  app.w.document.querySelector<HTMLButtonElement>(
    '.work-overview-section[data-work-section="updates"] [data-session-id="' + listed.id + '"]')!.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const justDid = () => [...pane.querySelectorAll('.work-overview-pane-field')]
    .find(row => row.querySelector('b')?.textContent === 'Just did')?.textContent ?? '';
  expect(justDid()).toContain('no exact current-turn final or tool outcome yet');
  expect(justDid()).not.toContain('Recorded final:');
  expect(pane.querySelector('.work-overview-result summary')?.textContent)
    .toBe('Read previous recorded final answer');
  expect(pane.querySelector('.work-overview-result-body')?.textContent)
    .toContain('Previous provider answer');

  rows.push({ kind: 'assistant_message', seq: 5, time: T0 + 5_000,
    source: 'extension', turnId: 'newer-turn', messageId: 'new-provider-final', final: true,
    message: text('Latest new-provider final is the current recorded output.') });
  exact = { ...exact, activeTurnId: null, lastAssistantFinalAt: T0 + 5_000,
    lastTurnEndAt: T0 + 6_000, lastTurnOutcome: 'completed', events: 5,
    finishTurn: { turnId: 'newer-turn', conversationId: 'new-provider-binding',
      startedAt: T0 + 4_000, notified: false, released: true,
      decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null } };
  app.notifySession();
  await settle(700);
  expect(justDid()).toContain('Recorded final: Latest new-provider final');
  expect(justDid()).not.toContain('Previous provider answer');
  expect(pane.querySelector('.work-overview-result-body')?.textContent)
    .toContain('Latest new-provider final');
  expect(app.live.sent).toEqual([]);
});

it('keeps Work & updates keyboard focus through evidence refreshes', async () => {
  const row = { ...summary([]), title: 'A long-running renderer acceptance review',
    fileEdits: 1, linesAdded: 4, lastFileChangeAt: T0 + 50_000 };
  const app = await boot([], true, [], [], { sessions: [row] });
  const button = app.w.document.querySelector<HTMLButtonElement>('.work-overview-row')!;
  button.focus();
  expect(app.w.document.activeElement).toBe(button);

  await app.replaceSessions([{ ...row, fileEdits: 2, lastFileChangeAt: T0 + 60_000 }]);
  expect(button.isConnected).toBe(true);
  expect(app.w.document.activeElement).toBe(button);

  button.click();
  await settle();
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const open = [...pane.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === 'Open full chat / Progress')!;
  open.focus();
  await app.replaceSessions([{ ...row, fileEdits: 3, lastFileChangeAt: T0 + 70_000 }]);
  expect(pane.hidden).toBe(false);
  expect(app.w.document.activeElement?.textContent).toBe('Open full chat / Progress');
});

it('returns keyboard focus to the originating Work & updates row when detail closes', async () => {
  const row = { ...summary([]), title: 'Inspect completed work',
    fileEdits: 1, lastFileChangeAt: T0 + 50_000 };
  const app = await boot([], true, [], [], { sessions: [row] });
  const origin = app.w.document.querySelector<HTMLButtonElement>('.work-overview-row')!;
  const pane = app.w.document.getElementById('workOverviewPane')!;

  origin.focus();
  origin.click();
  await settle();
  const close = pane.querySelector<HTMLButtonElement>('button[data-work-action="close"]')!;
  close.focus();
  close.click();
  expect(pane.hidden).toBe(true);
  expect(origin.getAttribute('aria-expanded')).toBe('false');
  expect(app.w.document.activeElement).toBe(origin);

  origin.click();
  await settle();
  const fullChat = pane.querySelector<HTMLButtonElement>('button[data-work-action="open"]')!;
  fullChat.focus();
  fullChat.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(pane.hidden).toBe(true);
  expect(app.w.document.activeElement).toBe(origin);
});

it('keeps Work & updates detail beside the exact row selected in both feeds', async () => {
  const row = { ...summary([]), title: 'Live work with recent edits',
    fileEdits: 1, lastFileChangeAt: T0 + 50_000, lastToolCallAt: T0 + 40_000 };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0 + 55_000, targetLanes: 1,
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: 'working', reason: 'Reviewing current edits', nextAction: 'Verify the result',
      nextRetryAt: null, lastWorkedAt: T0 + 55_000, activeWorkers: 0,
      recoverable: false, spinning: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation });
  const rows = [...app.w.document.querySelectorAll<HTMLButtonElement>(`.work-overview-row[data-session-id="${row.id}"]`)];
  expect(rows).toHaveLength(2);
  const recent = rows[1]!;
  const pane = app.w.document.getElementById('workOverviewPane')!;
  recent.focus();
  recent.click();
  await settle();
  expect(pane.previousElementSibling === recent).toBe(true);
  expect(rows[0]!.getAttribute('aria-expanded')).toBe('false');
  expect(recent.getAttribute('aria-expanded')).toBe('true');
  pane.querySelector<HTMLButtonElement>('button[data-work-action="close"]')!.click();
  expect(app.w.document.activeElement === recent).toBe(true);
});

it('keeps an inspected older result anchored when six newer updates evict its original row', async () => {
  const update = (id: string, at: number) => ({
    ...summary([]), id, title: `Result ${id}`, conversationId: `chat-${id}`, chatIds: [`chat-${id}`],
    fileEdits: 1, lastFileChangeAt: at, lastToolCallAt: at - 1_000, activeTurnId: null
  });
  const oldest = update('opened-oldest', T0 + 10_000);
  const initial = [oldest, ...Array.from({ length: 5 }, (_, i) => update(`initial-${i}`, T0 + 20_000 + i * 1_000))];
  const app = await boot([], true, [], [], { sessions: initial });
  const pane = app.w.document.getElementById('workOverviewPane')!;
  const origin = app.w.document.querySelector<HTMLButtonElement>('.work-overview-section[data-work-section="updates"] .work-overview-row[data-session-id="opened-oldest"]')!;
  origin.click();
  await settle();
  pane.querySelector<HTMLButtonElement>('[data-work-action="close"]')!.focus();
  await app.replaceSessions([...initial, ...Array.from({ length: 6 }, (_, i) => update(`new-${i}`, T0 + 40_000 + i * 1_000))]);
  const retained = app.w.document.querySelector<HTMLButtonElement>('.work-overview-section[data-work-section="updates"] .work-overview-row[data-session-id="opened-oldest"]')!;
  expect(retained).not.toBeNull();
  expect(retained.isConnected).toBe(true);
  expect(retained.getAttribute('aria-expanded')).toBe('true');
  expect(pane.previousElementSibling).toBe(retained);
  expect(pane.hidden).toBe(false);
  expect(app.w.document.activeElement?.getAttribute('data-work-action')).toBe('close');
  pane.querySelector<HTMLButtonElement>('[data-work-action="close"]')!.click();
  expect(pane.hidden).toBe(true);
  expect(app.w.document.querySelectorAll('.work-overview-section[data-work-section="updates"] .work-overview-row')).toHaveLength(6);
  expect(app.w.document.activeElement).toBe(app.w.document.querySelector('#workOverview > summary'));
});

it('closes an inspected work result and restores overview focus when its evidence no longer qualifies for either feed', async () => {
  const row = { ...summary([]), title: 'Formerly completed work',
    fileEdits: 1, lastFileChangeAt: T0 + 40_000, lastToolCallAt: T0 + 30_000 };
  const app = await boot([], true, [], [], { sessions: [row] });
  const origin = app.w.document.querySelector<HTMLButtonElement>('.work-overview-section[data-work-section="updates"] .work-overview-row')!;
  const pane = app.w.document.getElementById('workOverviewPane')!;
  origin.click();
  await settle();
  pane.querySelector<HTMLButtonElement>('[data-work-action="close"]')!.focus();
  await app.replaceSessions([{ ...row, fileEdits: 0, lastFileChangeAt: null, lastToolCallAt: null }]);
  expect(pane.hidden).toBe(true);
  expect(app.w.document.activeElement).toBe(app.w.document.querySelector('#workOverview > summary'));
  expect(app.w.document.querySelectorAll('.work-overview-section[data-work-section="updates"] .work-overview-row')).toHaveLength(0);
});

it('surfaces durable Delivery queue holds in Work & updates without treating them as sent', async () => {
  const { w, live, append } = await boot([]);
  const current = summary([]);
  live.inputs.push(
    {
      id: 'work-pending', sessionId: current.id, text: 'Private queued message body', mode: 'auto', dueAt: 0,
      model: 'gpt-6-thinking', reasoningEffort: 'xhigh', state: 'queued', owner: null,
      createdAt: 1, conversationId: current.conversationId
    },
    {
      id: 'work-receipt', sessionId: '2026-09-02-work2001', text: 'Private browser message body',
      mode: 'auto', dueAt: 0, model: 'gpt-6-thinking', reasoningEffort: 'xhigh', state: 'browser',
      owner: 'exact-browser-owner', sendAuthorizedAt: T0 + 1_000, createdAt: 2, conversationId: 'browser-chat'
    },
    {
      id: 'work-ambiguous', sessionId: '2026-09-02-work2002', text: 'Private cancelled message body',
      mode: 'auto', dueAt: 0, model: 'gpt-6-thinking', reasoningEffort: 'xhigh', state: 'cancelled',
      owner: 'former-browser-owner', sendAuthorizedAt: T0 + 2_000, createdAt: 3,
      conversationId: 'cancelled-chat', error: 'Delivery confirmation was not observed; the message may have been sent.'
    }
  );
  await append([]);

  const meta = w.document.getElementById('workOverviewMeta')!;
  expect(meta.textContent).toContain('1 queued');
  expect(meta.textContent).toContain('1 awaiting receipt');
  expect(meta.textContent).toContain('1 delivery notice');
  expect(meta.textContent).not.toContain('quiet');
  const row = w.document.querySelector<HTMLButtonElement>('.work-overview-row[data-work-kind="delivery"]')!;
  expect(row).toBeTruthy();
  expect(row.textContent).toContain('Delivery queue');
  expect(row.textContent).not.toContain('Private queued message body');
  expect(row.hasAttribute('aria-expanded')).toBe(false);
  const dock = w.document.getElementById('deliveryQueuePanel') as HTMLDetailsElement;
  expect(w.document.getElementById('deliveryQueueCount')!.textContent).toBe('3');
  dock.open = false;
  row.focus();
  row.click();
  expect(dock.open).toBe(true);
  expect(w.document.activeElement).toBe(dock.querySelector('summary'));
  expect(live.controlCalls).toEqual([]);

  // Retain a terminal receipt after both active messages settle. Without an active chat or
  // pending Send, an ambiguous cancelled receipt must still prevent the feed saying quiet.
  live.inputs = live.inputs.filter(entry => entry.id === 'work-ambiguous');
  await append([]);
  expect(meta.textContent).toContain('1 delivery notice');
  expect(meta.textContent).not.toContain('queued');
  expect(meta.textContent).not.toContain('awaiting receipt');
  expect(w.document.querySelector('.work-overview-row[data-work-kind="delivery"]')).not.toBeNull();

  live.inputs = live.inputs.map(entry => ({ ...entry, state: 'sent' as const, messageId: `ack-${entry.id}` }));
  await append([]);
  expect(w.document.querySelector('.work-overview-row[data-work-kind="delivery"]')).toBeNull();
  expect(meta.textContent).not.toContain('awaiting receipt');
  expect(meta.textContent).not.toContain('delivery notice');
});

it('shows one Waiting for Core recovery state and countdown without making it a stale-chat retry', async () => {
  const row = summary([]);
  const retryAt = T0 + 70_000;
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0 + 10_000,
    targetLanes: 5,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 1, stalled: 0, paused: 0, blocked: 0 },
    chats: [{
      sessionId: row.id,
      conversationId: row.conversationId!,
      title: row.title,
      mode: 'loop',
      state: 'recovering',
      reason: 'This exact Loop reply is waiting for Core health proof.',
      nextAction: 'The existing Core connection will be checked again.',
      nextRetryAt: retryAt,
      lastWorkedAt: T0,
      activeWorkers: 0,
      recoverable: false,
      spinning: false,
      recoveryStage: 'core'
    }]
  };
  const { w } = await boot([], true, [], [], { sessions: [row], automation });
  expect(w.document.getElementById('automationSupervisorSummary')!.textContent).toContain('1 waiting for Core');
  const pill = w.document.querySelector('.sess-automation-state') as HTMLElement;
  expect(pill.textContent).toBe('waiting for Core');
  expect(pill.classList.contains('is-recovery-core')).toBe(true);
  expect(pill.getAttribute('aria-label')).toContain('waiting for Core');
  expect(w.document.querySelector('.sess-automation-retry')?.textContent).not.toBe('');
  expect((w.document.getElementById('recoverStaleAutomation') as HTMLButtonElement).disabled).toBe(true);
});

it('shows the rotating Loop batch and each chat queue position', async () => {
  const row = summary([]);
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0,
    targetLanes: 5,
    rotation: { batchSize: 5, cycleMinutes: 60, activatedAt: T0, nextRotationAt: T0 + 60 * 60_000,
      draining: false, active: 5, foreground: 0, attention: 0, foregroundSlots: 2, members: [row.conversationId!],
      queued: 4, busyActive: 2, previous: 0, rotatedAt: 0, drainingAt: 0 },
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 1, recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [{
      sessionId: row.id,
      conversationId: row.conversationId!,
      title: row.title,
      mode: 'loop',
      state: 'waiting-main',
      reason: 'Parked behind the active batch.',
      nextAction: 'Wait for the next safe rotation.',
      nextRetryAt: null,
      lastWorkedAt: T0,
      activeWorkers: 0,
      recoverable: false,
      spinning: false,
      recoveryStage: null,
      rotation: { state: 'queued', position: 3 }
    }]
  };
  const { w } = await boot([], true, [], [], { sessions: [row], automationProfile: 'rotation', automation });
  expect(w.document.getElementById('automationSupervisorDetail')!.textContent).toContain('slots 1–5 active (5/5)');
  expect(w.document.getElementById('automationSupervisorDetail')!.textContent).toContain('4 queued');
  expect(w.document.querySelector('.sess-rotation.is-queued')?.textContent).toBe('queue #3');
  expect(w.document.querySelector('.sess-batch-membership')?.textContent).toBe('Batch');
});

it('shows G, L, or no automation mode badge for goal, loop and off chats', async () => {
  const base = summary([]);
  const rows = [
    { ...base, id: '2026-09-02-goal0001', conversationId: 'b1111111-1111-4111-8111-111111111111', title: 'Goal chat' },
    { ...base, id: '2026-09-02-loop0001', conversationId: 'b2222222-2222-4222-8222-222222222222', title: 'Loop chat' },
    { ...base, id: '2026-09-02-off00001', conversationId: 'b3333333-3333-4333-8333-333333333333', title: 'Off chat' }
  ];
  const projection = (row: typeof rows[number], mode: 'goal' | 'loop') => ({
    sessionId: row.id,
    conversationId: row.conversationId,
    title: row.title,
    mode,
    state: 'waiting-main' as const,
    reason: 'Ready for the next answer.',
    nextAction: 'Wait for ChatGPT.',
    nextRetryAt: null,
    lastWorkedAt: T0,
    activeWorkers: 0,
    recoverable: false,
    spinning: false,
    recoveryStage: null
  });
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0,
    targetLanes: 2,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 2, recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [projection(rows[0]!, 'goal'), projection(rows[1]!, 'loop')]
  };
  const { w } = await boot([], true, [], [], { sessions: rows, automation });
  const goal = w.document.querySelector(`[data-id="${rows[0]!.id}"]`)!;
  const loop = w.document.querySelector(`[data-id="${rows[1]!.id}"]`)!;
  const off = w.document.querySelector(`[data-id="${rows[2]!.id}"]`)!;
  expect(goal.querySelector('.sess-mode-badge.is-goal')?.textContent).toBe('G');
  expect(loop.querySelector('.sess-mode-badge.is-loop')?.textContent).toBe('L');
  expect(off.querySelector('.sess-mode-badge')).toBeNull();
});

it('keeps internal shared-context delivery shells in sub-agent history while real work stays visible', async () => {
  const base = summary([]);
  const normal = { ...base, id: '2026-09-02-normal01', conversationId: 'failed-group-normal', title: 'Original chat' };
  const failed = { ...base, id: '2026-09-02-failed01', conversationId: 'failed-group-copy',
    title: '[[COS_CONTEXT:26082]]', titleSource: 'fallback' as const,
    userMessages: 1, toolCalls: 0, errors: 1, activeTurnId: null, lastAssistantFinalAt: null, lastToolCallAt: null };
  const toolActive = { ...failed, id: '2026-09-02-tools001', conversationId: 'failed-group-tools', title: 'Real tool work', toolCalls: 3 };
  const authoredFailure = { ...failed, id: '2026-09-02-authored-fail', conversationId: 'failed-group-authored',
    title: 'Clean this folder', titleSource: 'fallback' as const };
  const repairedContext = { ...failed, id: '2026-09-02-repaired-context', conversationId: 'failed-group-repaired',
    title: 'Shared context for every worker in this run:', titleSource: 'fallback' as const };
  const inferredWorker = { ...failed, id: '2026-09-02-inferred-worker', conversationId: 'worker-four-chat',
    title: 'Spiffy Color verification update', titleSource: 'fallback' as const, agents: ['worker-4'],
    userMessages: 1, toolCalls: 3, errors: 0 };
  const attention = { ...failed, id: '2026-09-02-failed-attn', conversationId: 'failed-group-attn', title: 'Delivery needs attention' };
  const blocked = { ...failed, id: '2026-09-02-failed-blocked', conversationId: 'failed-group-blocked', title: 'Blocked delivery' };
  const inputs = [{
    id: 'failed-attention-input', sessionId: attention.id, deliveredSessionId: null, conversationId: attention.conversationId,
    text: 'Continue', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'failed', owner: null,
    createdAt: T0, error: 'Delivery needs attention.'
  }] as InputEntry[];
  const { w } = await boot([], false, [], [], {
    sessions: [normal, failed, repairedContext, inferredWorker, toolActive, authoredFailure, attention, blocked], inputs, blocked: [blocked.conversationId!]
  });

  const disclosure = [...w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics')]
    .find(row => row.querySelector(':scope > summary')?.textContent?.includes('Sub-agent history'))!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('summary')?.textContent).toContain('Sub-agent history · 3');
  expect(disclosure.querySelector(`[data-id="${failed.id}"]`)).not.toBeNull();
  expect(disclosure.querySelector(`[data-id="${repairedContext.id}"]`)).not.toBeNull();
  expect(disclosure.querySelector(`[data-id="${inferredWorker.id}"]`)).not.toBeNull();
  expect(disclosure.querySelector(`[data-id="${toolActive.id}"]`)).toBeNull();
  expect(disclosure.querySelector(`[data-id="${normal.id}"]`)).toBeNull();
  expect(disclosure.querySelector(`[data-id="${authoredFailure.id}"]`)).toBeNull();
  expect(disclosure.querySelector(`[data-id="${attention.id}"]`)).toBeNull();
  expect(disclosure.querySelector(`[data-id="${blocked.id}"]`)).toBeNull();
});

it('keeps the Sub-agent history wrapper mounted when only worker activity changes', async () => {
  const base = summary([]);
  const shell: SessionSummary = {
    ...base,
    id: '2026-09-02-subagent-stable',
    conversationId: 'subagent-stable-chat',
    title: '[[COS_CONTEXT:26082]]',
    titleSource: 'fallback',
    origin: null,
    userMessages: 1,
    toolCalls: 0,
    activeTurnId: null,
    lastAssistantFinalAt: null,
    activityExpiresAt: Date.now() + 60_000
  };
  const app = await boot([], false, [], [], { sessions: [shell] });
  const disclosure = [...app.w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics')]
    .find(row => row.querySelector(':scope > summary')?.textContent?.includes('Sub-agent history'))!;
  const mountedRow = disclosure.querySelector<HTMLElement>(`[data-id="${shell.id}"]`)!;

  await app.replaceSessions([{ ...shell, activityExpiresAt: null, updatedAt: shell.updatedAt + 1_000 }]);

  const currentDisclosure = [...app.w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics')]
    .find(row => row.querySelector(':scope > summary')?.textContent?.includes('Sub-agent history'))!;
  expect(currentDisclosure).toBe(disclosure);
  expect(currentDisclosure.querySelector(`[data-id="${shell.id}"]`)).toBe(mountedRow);
  expect(currentDisclosure.querySelector(':scope > summary')?.textContent).toBe('Sub-agent history · 1');
});

it('collapses exact transport-only history but keeps every live or attention-owned row visible', async () => {
  const base = summary([]);
  const transport = (id: string, conversationId: string, title: string): SessionSummary => ({
    ...base, id, conversationId, title, origin: null, userMessages: 0, toolCalls: 2,
    activeTurnId: null, lastAssistantFinalAt: null, lastToolCallAt: null, activityExpiresAt: null
  });
  const idle = transport('2026-09-02-transport-idle', 'transport-idle', 'Transport shell');
  const active = { ...transport('2026-09-02-transport-active', 'transport-active', 'Active transport'),
    activityExpiresAt: Date.now() + 60_000 };
  const staleGeneric = { ...transport('2026-09-02-transport-generic', 'transport-generic', 'Resume ChatGPT session'),
    titleSource: 'fallback' as const, activeTurnId: 'stale-turn', activityExpiresAt: Date.now() + 60_000 };
  const automated = transport('2026-09-02-transport-loop', 'transport-loop', 'Loop transport');
  const queued = transport('2026-09-02-transport-queued', 'transport-queued', 'Queued transport');
  const attention = transport('2026-09-02-transport-attn', 'transport-attn', 'Browser attention');
  const blocked = transport('2026-09-02-transport-blocked', 'transport-blocked', 'Blocked transport');
  const answered = { ...transport('2026-09-02-transport-final', 'transport-final', 'Answered transport'),
    lastAssistantFinalAt: T0 + 30_000 };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 1, stalled: 0, paused: 0, blocked: 0 },
    chats: [{
      sessionId: automated.id, conversationId: automated.conversationId!, title: automated.title, mode: 'loop',
      state: 'recovering', reason: 'Chrome action is owned.', nextAction: 'Verify the exact chat.',
      nextRetryAt: null, lastWorkedAt: T0, activeWorkers: 0, recoverable: false, spinning: false,
      recoveryStage: 'checking-activity'
    }]
  };
  const inputs = [
    { id: 'transport-queued-input', sessionId: queued.id, deliveredSessionId: null, conversationId: queued.conversationId,
      text: 'Continue', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null,
      createdAt: T0 },
    { id: 'transport-attention-input', sessionId: attention.id, deliveredSessionId: null, conversationId: attention.conversationId,
      text: 'Continue', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'failed', owner: null,
      createdAt: T0, error: 'Browser delivery needs attention.' }
  ] as InputEntry[];
  const rows = [idle, staleGeneric, active, automated, queued, attention, blocked, answered];
  const { w } = await boot([], false, [], [], { sessions: rows, inputs, automation, blocked: [blocked.conversationId!] });

  const disclosure = w.document.querySelector<HTMLDetailsElement>('details.transport-only-activity')!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('summary')?.textContent).toContain('Tool-only records · 2');
  expect(disclosure.querySelector(`[data-id="${idle.id}"]`)).not.toBeNull();
  expect(disclosure.querySelector(`[data-id="${staleGeneric.id}"]`)).not.toBeNull();
  for (const row of rows.slice(2)) {
    expect(w.document.querySelector(`[data-id="${row.id}"]`)?.closest('details.transport-only-activity')).toBeNull();
  }
});

it('immediately reveals a transport-only row when it is selected, multiselected, or renamed', async () => {
  const base = summary([]);
  const rows = ['first', 'second', 'third'].map((name, index): SessionSummary => ({
    ...base, id: `2026-09-02-transport-${name}`, conversationId: `transport-${name}`, title: `${name} transport`,
    origin: null, userMessages: 0, toolCalls: index + 1, activeTurnId: null, lastAssistantFinalAt: null,
    lastToolCallAt: null, activityExpiresAt: null
  }));
  const { w } = await boot([], false, [], [], { sessions: rows });
  const group = () => w.document.querySelector<HTMLDetailsElement>('details.transport-only-activity');

  (group()!.querySelector(`[data-id="${rows[0]!.id}"]`) as HTMLElement).click();
  expect(w.document.querySelector(`[data-id="${rows[0]!.id}"]`)?.closest('details.transport-only-activity')).toBeNull();
  expect(group()?.querySelector('summary')?.textContent).toContain('Tool-only records · 2');

  group()!.querySelector(`[data-id="${rows[1]!.id}"]`)!.dispatchEvent(new w.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  expect(w.document.querySelector(`[data-id="${rows[1]!.id}"]`)?.closest('details.transport-only-activity')).toBeNull();
  expect(group()?.querySelector('summary')?.textContent).toContain('Tool-only records · 1');

  (group()!.querySelector(`[data-id="${rows[2]!.id}"] .sess-more`) as HTMLButtonElement).click();
  [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Add or edit chat nickname')!.click();
  expect(w.document.querySelector(`[data-id="${rows[2]!.id}"]`)?.closest('details.transport-only-activity')).toBeNull();
  expect(group()?.querySelector('summary')?.textContent).toContain('Tool-only records · 1');
  expect(group()?.querySelector(`[data-id="${rows[1]!.id}"]`)).not.toBeNull();
});

it('keeps worker history under Sub-agent history instead of attaching it to a transport-only parent', async () => {
  const base = summary([]);
  const parent: SessionSummary = {
    ...base, id: '2026-09-02-transport-parent', conversationId: 'transport-parent', title: 'Transport parent',
    origin: null, userMessages: 0, toolCalls: 4, activeTurnId: null, lastAssistantFinalAt: null,
    lastToolCallAt: null, activityExpiresAt: null
  };
  const worker: SessionSummary = {
    ...base, id: '2026-09-02-transport-worker', conversationId: 'transport-worker', title: 'worker-1',
    origin: { kind: 'worker', fromSessionId: parent.id, agentId: 'worker-1', task: 'Inspect the workspace' },
    userMessages: 1, toolCalls: 1
  };
  const { w } = await boot([], false, [], [], { sessions: [parent, worker] });

  const parentRow = w.document.querySelector(`[data-id="${parent.id}"]`)!;
  expect(parentRow.closest('details.transport-only-activity')).not.toBeNull();
  expect(parentRow.querySelector('.worker-toggle')).toBeNull();
  const subagents = [...w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics')]
    .find(details => details.querySelector(':scope > summary')?.textContent?.includes('Sub-agent history'))!;
  expect(subagents.querySelector(`[data-id="${worker.id}"]`)).not.toBeNull();
});

it('keeps workers in Sub-agent history even when their parent is an unattributed internal record', async () => {
  const base = summary([]);
  const parent: SessionSummary = {
    ...base, id: '2026-09-02-system-parent', conversationId: null, chatIds: [], title: 'Internal activity',
    origin: null, userMessages: 0, toolCalls: 2, activeTurnId: null, lastAssistantFinalAt: null
  };
  const worker: SessionSummary = {
    ...base, id: '2026-09-02-system-worker', conversationId: 'system-worker-chat', title: 'worker-1',
    origin: { kind: 'worker', fromSessionId: parent.id, agentId: 'worker-1', task: 'Inspect transport state' },
    userMessages: 1, toolCalls: 1
  };
  const { w } = await boot([], false, [], [], { sessions: [parent, worker] });
  const systemActivity = () => [...w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics')]
    .find(details => details.querySelector(':scope > summary')?.textContent?.includes('Internal CoS records'))!;

  const parentRow = systemActivity().querySelector(`[data-id="${parent.id}"]`)!;
  expect(parentRow.querySelector('.worker-toggle')).toBeNull();
  const subagents = [...w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics')]
    .find(details => details.querySelector(':scope > summary')?.textContent?.includes('Sub-agent history'))!;
  const workerRow = subagents.querySelector(`[data-id="${worker.id}"]`)!;
  expect(workerRow).not.toBeNull();
  expect(workerRow.closest('details')).toBe(subagents);
});

it('uses the automation projection as the only top-level spinner owner', async () => {
  const base = summary([]);
  const rows = [
    { ...base, id: '2026-09-02-exact001', conversationId: 'a1111111-1111-4111-8111-111111111111', title: 'Exact work' },
    { ...base, id: '2026-09-02-recent01', conversationId: 'a2222222-2222-4222-8222-222222222222', title: 'Recent only' },
    { ...base, id: '2026-09-02-recover1', conversationId: 'a3333333-3333-4333-8333-333333333333', title: 'Recovering' }
  ];
  const common = {
    mode: 'loop' as const,
    nextRetryAt: null,
    lastWorkedAt: T0,
    activeWorkers: 0,
    recoverable: false
  };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0,
    targetLanes: 3,
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 1, recovering: 1, stalled: 0, paused: 0, blocked: 0 },
    chats: [
      { ...common, sessionId: rows[0]!.id, conversationId: rows[0]!.conversationId!, title: rows[0]!.title,
        state: 'working', reason: 'Exact native generation.', nextAction: 'Observe.', spinning: true, recoveryStage: null },
      { ...common, sessionId: rows[1]!.id, conversationId: rows[1]!.conversationId!, title: rows[1]!.title,
        state: 'waiting-main', reason: 'Recent activity only.', nextAction: 'Wait.', spinning: false, recoveryStage: null },
      { ...common, sessionId: rows[2]!.id, conversationId: rows[2]!.conversationId!, title: rows[2]!.title,
        state: 'recovering', reason: 'Browser action landed.', nextAction: 'Check activity.', spinning: false,
        recoveryStage: 'checking-activity' }
    ]
  };
  const { w } = await boot([], true, [], [], { sessions: rows, automation });
  const exact = w.document.querySelector(`[data-id="${rows[0]!.id}"]`)!;
  const recent = w.document.querySelector(`[data-id="${rows[1]!.id}"]`)!;
  const recovering = w.document.querySelector(`[data-id="${rows[2]!.id}"]`)!;
  expect(exact.querySelector('.session-status.is-working')).not.toBeNull();
  expect(recent.querySelector('.session-status')).toBeNull();
  expect(recovering.querySelector('.session-status.is-working')).toBeNull();
  expect(recovering.querySelector('.session-status.is-recovering')).not.toBeNull();
  expect(recovering.querySelector('.sess-automation-state')?.textContent).toBe('verifying repair');
  expect(recovering.querySelector('.sess-automation-state.is-recovery-checking-activity')).not.toBeNull();
});

it('projects a mixed automation set truthfully and clears stale recovery labels without remounting rows', async () => {
  const base = summary([]);
  const rows = [
    { ...base, id: '2026-09-02-mixed-work', conversationId: 'aa111111-1111-4111-8111-111111111111', title: 'Healthy work' },
    { ...base, id: '2026-09-02-mixed-core', conversationId: 'aa222222-2222-4222-8222-222222222222', title: 'Core wait' },
    { ...base, id: '2026-09-02-mixed-browser', conversationId: 'aa333333-3333-4333-8333-333333333333', title: 'Browser repair' },
    { ...base, id: '2026-09-02-mixed-attn', conversationId: 'aa444444-4444-4444-8444-444444444444', title: 'Needs review' }
  ];
  const common = {
    mode: 'loop' as const, nextRetryAt: null, lastWorkedAt: T0, activeWorkers: 0, recoverable: false
  };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0,
    targetLanes: 4,
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 2, stalled: 1, paused: 0, blocked: 0 },
    chats: [
      { ...common, sessionId: rows[0]!.id, conversationId: rows[0]!.conversationId!, title: rows[0]!.title,
        state: 'working', reason: 'Exact native generation.', nextAction: 'Observe.', spinning: true, recoveryStage: null },
      { ...common, sessionId: rows[1]!.id, conversationId: rows[1]!.conversationId!, title: rows[1]!.title,
        state: 'recovering', reason: 'Exact saved work is waiting for Core.', nextAction: 'Wait for Core.', spinning: false,
        recoveryStage: 'core' },
      { ...common, sessionId: rows[2]!.id, conversationId: rows[2]!.conversationId!, title: rows[2]!.title,
        state: 'recovering', reason: 'Exact Chrome action is in flight.', nextAction: 'Verify the same chat.', spinning: false,
        recoveryStage: 'browser-action' },
      { ...common, sessionId: rows[3]!.id, conversationId: rows[3]!.conversationId!, title: rows[3]!.title,
        state: 'stalled', reason: 'The bounded recovery episode is exhausted.', nextAction: 'Resume deliberately.', spinning: false,
        recoveryStage: 'core' }
    ]
  };
  const app = await boot([], true, [], [], { sessions: rows, automation });
  const summaryText = app.w.document.getElementById('automationSupervisorSummary')!.textContent ?? '';
  expect(summaryText).toContain('1 working');
  expect(summaryText).toContain('1 waiting for Core');
  expect(summaryText).toContain('1 repairing');
  expect(summaryText).toContain('1 needs attention');
  const mounted = new Map(rows.map(row => [row.id,
    app.w.document.querySelector<HTMLElement>(`.sess[data-id="${row.id}"]`)!]));
  expect(mounted.get(rows[1]!.id)!.querySelector('.sess-automation-state')?.textContent).toBe('waiting for Core');
  expect(mounted.get(rows[2]!.id)!.querySelector('.sess-automation-state')?.textContent).toBe('repairing Chrome');
  expect(mounted.get(rows[3]!.id)!.querySelector('.sess-automation-state')?.textContent).toBe('needs attention');
  expect(app.w.document.querySelectorAll('#sessionList .sess').length).toBe(rows.length);

  // One authoritative snapshot replaces every old label. Repaint must update the existing rows,
  // not leave contradictory Core/browser/attention badges mounted beside the new state.
  automation.observedAt += 1_000;
  automation.counts = { working: 3, 'waiting-workers': 0, 'waiting-main': 1, recovering: 0, stalled: 0, paused: 0, blocked: 0 };
  automation.chats = automation.chats.map((chat, index) => ({
    ...chat,
    state: index === 2 ? 'waiting-main' : 'working',
    reason: index === 2 ? 'Healthy chat is between turns.' : 'Exact work is active.',
    nextAction: index === 2 ? 'Wait.' : 'Observe.',
    spinning: index !== 2,
    recoveryStage: null
  }));
  await app.replaceSessions(rows.map(row => ({ ...row, updatedAt: row.updatedAt + 1_000 })));

  const refreshedSummary = app.w.document.getElementById('automationSupervisorSummary')!.textContent ?? '';
  expect(refreshedSummary).toContain('3 working');
  expect(refreshedSummary).not.toContain('waiting for Core');
  expect(refreshedSummary).not.toContain('repairing');
  expect(refreshedSummary).not.toContain('needs attention');
  for (const row of rows) {
    const refreshed = app.w.document.querySelector<HTMLElement>(`.sess[data-id="${row.id}"]`)!;
    expect(refreshed).toBe(mounted.get(row.id));
    expect(refreshed.querySelector('.is-recovery-core')).toBeNull();
    expect(refreshed.querySelector('.is-recovery-browser-action')).toBeNull();
    expect(refreshed.querySelector('.is-stalled')).toBeNull();
  }
  expect(app.w.document.querySelectorAll('#sessionList .sess').length).toBe(rows.length);
});

it('shows the newest concrete work proof beside the automation state', async () => {
  const now = Date.now();
  const row = {
    ...summary([]),
    lastMessageAt: now - 60_000,
    lastToolCallAt: now - 30_000,
    lastFileChangeAt: now - 12_000,
    fileEdits: 1,
    linesAdded: 4
  };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: now,
    targetLanes: 1,
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [{
      sessionId: row.id,
      conversationId: row.conversationId!,
      title: row.title,
      mode: 'loop',
      state: 'working',
      reason: 'Exact local tool execution is active.',
      nextAction: 'Observe.',
      nextRetryAt: null,
      lastWorkedAt: now - 30_000,
      activeWorkers: 0,
      recoverable: false,
      spinning: true,
      recoveryStage: null
    }]
  };
  const { w } = await boot([], true, [], [], { sessions: [row], automation });
  const rendered = w.document.querySelector<HTMLElement>(`.sess[data-id="${row.id}"]`)!;
  const state = rendered.querySelector<HTMLElement>('.sess-automation-state')!;
  const proof = rendered.querySelector<HTMLElement>('.sess-last-work.is-edit')!;
  expect(proof.textContent).toMatch(/^edit (?:10|15)s$/);
  expect(proof.title).toContain('Last recorded file change');
  expect(state.compareDocumentPosition(proof) & w.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('shows Chrome repair in amber with an honest retry countdown and no false spinner', async () => {
  const row = { ...summary([]), id: '2026-09-02-repair01', conversationId: 'a5555555-5555-4555-8555-555555555555' };
  const retryAt = Date.now() + 37_000;
  const automation: AutomationSupervisorSnapshot = {
    observedAt: Date.now(),
    targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 1, stalled: 0, paused: 0, blocked: 0 },
    chats: [{
      sessionId: row.id,
      conversationId: row.conversationId,
      title: row.title,
      mode: 'loop',
      state: 'recovering',
      reason: 'Chrome did not finish reading its tabs in time.',
      nextAction: 'Retry the same browser repair.',
      nextRetryAt: retryAt,
      lastWorkedAt: T0,
      activeWorkers: 0,
      recoverable: true,
      // A contradictory stale flag must not turn browser repair into a working spinner.
      spinning: true,
      recoveryStage: 'browser-action'
    }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation });
  const rendered = app.w.document.querySelector<HTMLElement>(`.sess[data-id="${row.id}"]`)!;
  const pill = rendered.querySelector<HTMLElement>('.sess-automation-state')!;
  const retry = rendered.querySelector<HTMLElement>('.sess-automation-retry')!;
  expect(pill.textContent).toBe('repairing Chrome');
  expect(pill.classList.contains('is-recovery-browser-action')).toBe(true);
  expect(pill.title).toContain('Chrome did not finish reading its tabs in time.');
  expect(retry.textContent).toMatch(/^retry (?:3[4-7])s$/);
  expect(retry.classList.contains('is-recovery-browser-action')).toBe(true);
  expect(retry.title).toContain('Chrome did not finish reading its tabs in time.');
  expect(rendered.querySelector('.session-status.is-working')).toBeNull();
  expect(rendered.querySelector('.session-status.is-recovering.is-recovery-browser-action')).not.toBeNull();
  expect(rendered.title).toContain('Retry the same browser repair.');

  automation.chats[0] = { ...automation.chats[0]!, nextRetryAt: Date.now() + 125_000 };
  await app.replaceSessions([{ ...row, updatedAt: row.updatedAt + 1 }]);
  expect(rendered.querySelector('.sess-automation-retry')?.textContent).toBe('retry 1m+');
});

it('keeps a hot sidebar row and continuing spinner mounted while applying newer status', async () => {
  const row = { ...summary([]), id: '2026-09-02-stable01', conversationId: 'a4444444-4444-4444-8444-444444444444' };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0,
    targetLanes: 1,
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [{
      sessionId: row.id,
      conversationId: row.conversationId,
      title: row.title,
      mode: 'loop',
      state: 'working',
      reason: 'Exact native generation started.',
      nextAction: 'Observe the current turn.',
      nextRetryAt: null,
      lastWorkedAt: T0,
      activeWorkers: 0,
      recoverable: false,
      spinning: true,
      recoveryStage: null
    }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation });
  const mountedRow = app.w.document.querySelector<HTMLElement>(`.sess[data-id="${row.id}"]`)!;
  const mountedSpinner = mountedRow.querySelector<HTMLElement>('.session-status.is-working')!;
  let removedWithSpinner = false;
  const observer = new app.w.MutationObserver(records => {
    removedWithSpinner ||= records.some(record => [...record.removedNodes].some(node =>
      node === mountedSpinner || (node instanceof app.w.Element && node.contains(mountedSpinner))));
  });
  observer.observe(app.w.document.getElementById('sessionList')!, { childList: true, subtree: true });

  automation.observedAt += 1_000;
  automation.chats[0] = {
    ...automation.chats[0]!,
    reason: 'Exact local tool execution is active.',
    nextAction: 'Wait for the tool to finish.'
  };
  await app.replaceSessions([{ ...row, updatedAt: row.updatedAt + 1_000 }]);
  const refreshedRow = app.w.document.querySelector<HTMLElement>(`.sess[data-id="${row.id}"]`)!;
  expect(refreshedRow).toBe(mountedRow);
  expect(refreshedRow.querySelector('.session-status.is-working')).toBe(mountedSpinner);
  expect(mountedSpinner.isConnected).toBe(true);
  expect(removedWithSpinner).toBe(false);
  expect(refreshedRow.title).toContain('Exact local tool execution is active.');
  observer.disconnect();

  automation.counts = { working: 0, 'waiting-workers': 0, 'waiting-main': 1, recovering: 0, stalled: 0, paused: 0, blocked: 0 };
  automation.chats[0] = {
    ...automation.chats[0]!,
    state: 'waiting-main',
    reason: 'The latest activity was recent but is no longer executing.',
    nextAction: 'Wait for the main chat.',
    spinning: false
  };
  await app.replaceSessions([{ ...row, updatedAt: row.updatedAt + 2_000 }]);
  const waitingRow = app.w.document.querySelector<HTMLElement>(`.sess[data-id="${row.id}"]`)!;
  expect(waitingRow).toBe(mountedRow);
  expect(waitingRow.querySelector('.session-status')).toBeNull();
  expect(waitingRow.querySelector('.sess-automation-state')?.textContent).toBe('between turns');
  expect(waitingRow.title).toContain('The latest activity was recent but is no longer executing.');
});

it.each(['compaction', 'blocked', 'worker'])('retires %s control status when leaving its session, including late IPC and locale refresh', async kind => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const controls = { sessionId: summary([]).id, automation: 'off', objective: '',
    blocked: kind === 'compaction' ? '' : kind, job: kind === 'compaction' ? { busy: true } : null };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  await append([]);
  const status = w.document.getElementById('sessionControlStatus')!;
  expect(status.textContent).not.toBe('');
  let release!: (value: unknown) => void;
  api.getSessionControls = () => new Promise(resolve => { release = resolve; });
  await append([]);
  // An ordinary refresh of the same selected owner retains its last known status.
  expect(status.textContent).not.toBe('');
  w.document.getElementById('newChat')!.click();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('compactSession')!.hidden).toBe(true);
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  release({ ok: true, data: controls }); await settle();
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('zh-CN');
  expect(status.textContent).toBe('');
  setLanguage('en');
  // Returning to A is a new selection epoch; only its new read may restore status.
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
  expect(status.textContent).toBe('');
  release({ ok: true, data: controls }); await settle();
  expect(status.textContent).not.toBe('');
});

it('clears control projections on an existing-session switch and fences A to B to A responses', async () => {
  const first = summary([]), second = { ...summary([]), id: '2026-09-02-test0002', title: 'Other session' };
  const { w, append } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  const busy = { sessionId: first.id, conversationId: first.conversationId,
    automation: 'off', objective: '', blocked: '', job: { busy: true },
    recovery: [{ kind: 'unattributed', deadline: Date.now() + 60_000 }] };
  api.getSessionControls = async () => ({ ok: true, data: busy });
  await append([]);
  const status = w.document.getElementById('sessionControlStatus')!;
  expect(status.textContent).toContain('Compaction');
  expect(w.document.getElementById('recoveryStatus')!.textContent).toContain('Next recovery check in');
  const pending: Array<(value: unknown) => void> = [];
  api.getSessionControls = () => new Promise(resolve => pending.push(resolve));
  await append([]); // old A refresh
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click();
  expect(pending).toHaveLength(3);
  pending[2]!({ ok: true, data: { ...busy, job: null, recovery: [] } }); await settle();
  pending[1]!({ ok: true, data: busy });
  pending[0]!({ ok: true, data: busy }); await settle();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
});

it('reorders queued tasks by drag and keyboard through the durable IPC operation', async () => {
  const { w, live, append } = await boot([]);
  const sessionId = summary([]).id;
  for (const [index, label] of ['first', 'second'].entries()) live.inputs.push({
    id: `queue-${index}`, sessionId, text: label, mode: 'finish', dueAt: 0, model: null, reasoningEffort: null,
    state: 'queued', owner: null, createdAt: index, conversationId: 'chat-b'
  });
  const reorder = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.reorderQueuedInputs = reorder;
  await append([]);
  let labels = w.document.querySelectorAll<HTMLElement>('#finishQueue .queue-label');
  expect(labels[0]!.draggable).toBe(true);
  labels[1]!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
  await settle();
  expect(reorder).toHaveBeenCalledWith(sessionId, ['queue-1', 'queue-0']);
  const data = new Map<string, string>();
  const transfer = { setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => data.get(key) ?? '', effectAllowed: '', dropEffect: '' };
  labels = w.document.querySelectorAll<HTMLElement>('#finishQueue .queue-label');
  const start = new w.Event('dragstart', { bubbles: true }); Object.defineProperty(start, 'dataTransfer', { value: transfer });
  labels[1]!.dispatchEvent(start);
  const drop = new w.MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 0 }); Object.defineProperty(drop, 'dataTransfer', { value: transfer });
  labels[0]!.parentElement!.dispatchEvent(drop);
  await settle();
  expect(reorder).toHaveBeenCalledTimes(2);
});

it.each([false, true])('closes a saved queue editor while Save has focus (delayed refresh: %s)', async delayedRefresh => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'edit-task', sessionId: summary([]).id, text: 'Before', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = '  Saved task  ';
  const save = field.nextElementSibling as HTMLButtonElement;
  const edit = vi.fn(async () => { live.inputs[0]!.text = field.value.trim(); return { ok: true, data: true }; });
  (w as any).api.editQueuedInput = edit;
  // A refresh can wait on unrelated outbox work. Its completion is not the save receipt.
  if (delayedRefresh) (w as any).api.listInputs = () => new Promise(() => {});
  save.focus(); save.click(); await settle();
  expect(edit).toHaveBeenCalledWith('edit-task', '  Saved task  ');
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(w.document.querySelector('#finishQueue .queue-label')?.textContent).toBe('Saved task');
});

it('keeps queue edits during refresh and allows only one pending save, retaining failed drafts', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'edit-task', sessionId: summary([]).id, text: 'Before', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Keep my edit';
  const save = field.nextElementSibling as HTMLButtonElement;
  let finish!: (result: unknown) => void;
  const edit = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  (w as any).api.editQueuedInput = edit;
  save.focus(); save.click(); save.click();
  expect(edit).toHaveBeenCalledTimes(1);
  expect(save.disabled).toBe(true);
  expect(save.textContent).toBe('Saving…');
  w.document.getElementById('chatInput')!.focus(); await append([]);
  expect(w.document.querySelector('#finishQueue textarea')).toBe(field);
  finish({ ok: false, error: 'Could not save this task' }); await settle();
  expect(field.value).toBe('Keep my edit'); expect(field.readOnly).toBe(false);
  expect(save.disabled).toBe(false); expect(save.textContent).toBe('Save');
  expect(w.document.body.textContent).toContain('Could not save this task');
});

it.each([
  { label: 'durable stale-state rejection', reply: { ok: true as const, data: false }, disabled: true, readOnly: true },
  { label: 'IPC failure', reply: { ok: false as const, error: 'Could not save this task' }, disabled: false, readOnly: false }
])('keeps finish-queue Save $label fenced correctly while refresh is unavailable', async ({ reply, disabled, readOnly }) => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'edit-task-authority', sessionId: summary([]).id, text: 'Before', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Preserve this draft';
  const save = field.nextElementSibling as HTMLButtonElement;
  const edit = vi.fn(async () => reply);
  (w as any).api.editQueuedInput = edit;
  (w as any).api.listInputs = () => new Promise(() => {});

  save.click();
  await settle();

  expect(edit).toHaveBeenCalledWith('edit-task-authority', 'Preserve this draft');
  expect(field.value).toBe('Preserve this draft');
  expect(save.disabled).toBe(disabled);
  expect(field.readOnly).toBe(readOnly);
});

it.each([
  { label: 'durable stale-state rejection', reply: { ok: true as const, data: false }, disabled: true },
  { label: 'IPC failure', reply: { ok: false as const, error: 'The queued task could not be removed.' }, disabled: false }
])('keeps finish-queue Remove $label fenced correctly while refresh is unavailable', async ({ reply, disabled }) => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'remove-task-authority', sessionId: summary([]).id, text: 'Remove authority test', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  const cancel = vi.fn(async () => reply);
  (w as any).api.cancelInput = cancel;
  (w as any).api.listInputs = () => new Promise(() => {});
  const remove = w.document.querySelector<HTMLButtonElement>('#finishQueue [aria-label="Remove queued task"]')!;

  remove.click();
  await settle();

  expect(cancel).toHaveBeenCalledWith('remove-task-authority');
  expect(remove.disabled).toBe(disabled);
});

it('shows ordinary after-turn messages in the task dock until actual delivery', async () => {
  const { w, live, append } = await boot([]);
  for (const [index, label] of ['Next task', 'Following task'].entries()) live.inputs.push({
    id: `after-${index}`, sessionId: summary([]).id, text: label, mode: 'after-turn', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'queued', owner: null, createdAt: index, conversationId: 'chat-b'
  });
  await append([]);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Next task');
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', historyRecorded: true, messageId: 'after-message' };
  await append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'after-message', inputId: 'after-0', message: text('Next task') }]);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(1);
  expect(w.document.getElementById('timeline')!.textContent).toContain('Next task');
});

it('shows an off-screen chat delivery with obvious edit and delete controls', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-02-test0002', title: 'Video Editor', conversationId: 'chat-video' };
  const app = await boot([], true, [], [], { sessions: [first, second] });
  const { w, live, append } = app;
  live.inputs.push({
    id: 'offscreen-delivery', sessionId: second.id, text: 'Build the production editor', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'queued', owner: null, createdAt: 1, conversationId: second.conversationId
  });
  await append([]);

  const panel = w.document.getElementById('deliveryQueuePanel') as HTMLDetailsElement;
  expect(panel.hidden).toBe(false);
  expect(panel.open).toBe(true);
  expect(w.document.getElementById('deliveryQueueCount')!.textContent).toBe('1');
  expect(w.document.getElementById('deliveryQueueList')!.textContent).toContain('#1 · Video Editor');
  expect(w.document.getElementById('deliveryQueueList')!.textContent).toContain('Build the production editor');
  expect(w.document.getElementById('deliveryQueueList')!.textContent).toContain('Ready for Chrome pickup');
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Build the production editor');

  const edit = vi.fn(async (id: string, text: string) => {
    live.inputs = live.inputs.map(row => row.id === id ? { ...row, text: text.trim() } : row);
    return { ok: true, data: true };
  });
  (w as any).api.editQueuedInput = edit;
  (panel.querySelector('[aria-label="Edit queued message"]') as HTMLButtonElement).click();
  await settle();
  const field = panel.querySelector<HTMLTextAreaElement>('.delivery-queue-editor')!;
  field.value = 'Build the revised production editor';
  field.dispatchEvent(new w.Event('input', { bubbles: true }));
  (field.parentElement!.querySelector('.delivery-queue-actions .btn') as HTMLButtonElement).click();
  await settle();
  expect(edit).toHaveBeenCalledWith('offscreen-delivery', 'Build the revised production editor');
  expect(w.document.getElementById('deliveryQueueList')!.textContent).toContain('Build the revised production editor');

  (panel.querySelector('[aria-label="Retry browser"]') as HTMLButtonElement).click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: 'offscreen-delivery', action: 'retry-browser' });

  const cancel = vi.fn(async (id: string) => {
    live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' as const, error: 'Cancelled by user.' } : row);
    return { ok: true, data: true };
  });
  (w as any).api.cancelInput = cancel;
  (panel.querySelector('[aria-label="Delete queued message"]') as HTMLButtonElement).click();
  await settle();
  expect(cancel).toHaveBeenCalledWith('offscreen-delivery');
  expect(panel.hidden).toBe(true);
});

it('projects the Main route-settle hold only for ready unsent existing-chat messages and expires on the existing clock', async () => {
  const input: InputEntry = { id: 'route-ready', sessionId: summary([]).id, text: 'Continue the same task', mode: 'auto',
    dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 1, conversationId: 'chat-b' };
  const app = await boot([], true, [], [], { inputs: [input] });
  const chat = await import('../src/renderer/chat.js');
  const deadline = Date.now() + 200;
  Object.assign(app.state.status, { routeSettlingUntil: deadline });
  chat.chatApply(app.state as unknown as AppState);
  await settle();
  expect(app.w.document.querySelector('.pending-message-status')?.textContent).toBe('Sending in a moment…');
  expect(app.w.document.querySelector('.delivery-queue-status')?.textContent).toBe('Sending in a moment…');
  expect(app.w.document.querySelector('.pending-message')?.classList.contains('is-delivered')).toBe(false);
  expect(app.live.sent).toHaveLength(0);
  await settle(240);
  expect(app.w.document.querySelector('.pending-message-status')?.textContent).not.toBe('Sending in a moment…');
  expect(app.w.document.querySelector('.delivery-queue-status')?.textContent).toBe('Ready for Chrome pickup');
  expect(app.live.sent).toHaveLength(0);
});

it('shows the exact stopped-end timestamp after late work without reporting completion', async () => {
  const turnId = 'stopped-late-turn';
  const app = await boot([
    { seq: 1, time: T0 + 1_000, source: 'extension', kind: 'turn_start', turnId },
    { ...toolCall(2, 'before-stop'), turnId },
    { seq: 3, time: T0 + 3_000, source: 'extension', kind: 'turn_end', turnId, outcome: 'stopped' }
  ], true, [], [], { controls: { activeTurnId: null } });
  expect(app.w.document.querySelectorAll('.turn-stopped')).toHaveLength(1);
  await app.append([
    { seq: 4, time: T0 + 4_000, source: 'app', kind: 'turn_start', turnId, detail: 'Late exact tool activity' },
    { ...toolCall(5, 'after-stop'), turnId }
  ]);
  expect(app.w.document.querySelector('.turn-stopped')).toBeNull();
  await app.append([{ seq: 6, time: T0 + 6_000, source: 'extension', kind: 'turn_end', turnId, outcome: 'stopped' }]);
  const stopped = app.w.document.querySelector('.turn-stopped')!;
  expect(stopped.textContent).toBe('Stopped. ChatGPT no longer shows this turn running.');
  expect(stopped.closest('.ev-turn_end')?.querySelector('time')?.getAttribute('datetime')).toBe(new Date(T0 + 6_000).toISOString());
  expect(app.w.document.querySelectorAll('.turn-stopped')).toHaveLength(1);
  expect(stopped.classList.contains('is-good')).toBe(false);
  expect(app.w.document.querySelectorAll('.ev-tool_call')).toHaveLength(2);
  expect(stopped.closest('.ev-turn_end')).toBe(app.w.document.getElementById('timeline')?.lastElementChild);
});

it('does not show an older stopped end as settled after newer exact-turn work or a different terminal boundary', async () => {
  const turnId = 'stopped-superseded-turn';
  const app = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId },
    { seq: 2, time: T0 + 2_000, source: 'extension', kind: 'turn_end', turnId, outcome: 'stopped' },
    { ...toolCall(3, 'late-without-start'), turnId }
  ]);
  expect(app.w.document.querySelector('.turn-stopped')).toBeNull();
  await app.append([{ seq: 4, time: T0 + 4_000, source: 'extension', kind: 'turn_end', turnId, outcome: 'completed' }]);
  expect(app.w.document.querySelector('.turn-stopped')).toBeNull();
});

it.each([
  { conversationId: null }, { state: 'browser', owner: 'chrome-page' }, { sendAuthorizedAt: 1 },
  { deliveredAt: 1 }, { messageId: 'native-receipt' }, { error: 'Delivery needs attention' },
  { mode: 'after-turn' }, { mode: 'finish' }, { transportIntent: 'tool' }, { attachmentDelivery: 'tool' },
  { afterTurn: true }, { queuedBehindBrowser: true },
  { queuedBehindDelivery: true }, { dueAt: Number.MAX_SAFE_INTEGER }
] as Array<Partial<InputEntry>>)('does not disguise another delivery boundary as a route hold (%j)', async boundary => {
  const input: InputEntry = { id: 'route-negative', sessionId: summary([]).id, text: 'Exact saved input', mode: 'auto',
    dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 1, conversationId: 'chat-b', ...boundary };
  const app = await boot([], true, [], [], { inputs: [input] });
  Object.assign(app.state.status, { routeSettlingUntil: Date.now() + 60_000 });
  (await import('../src/renderer/chat.js')).chatApply(app.state as unknown as AppState);
  await settle();
  expect(app.w.document.getElementById('inputQueue')?.textContent).not.toContain('Sending in a moment…');
  expect(app.w.document.getElementById('deliveryQueueList')?.textContent).not.toContain('Sending in a moment…');
  expect(app.live.sent).toHaveLength(0);
});

it('shows a new-chat nickname before the provider creates its session', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({
    id: 'named-new-chat', sessionId: null, nickname: 'AI Edit Intelligence', text: 'Build editable graphics',
    mode: 'auto', dueAt: 0, model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', state: 'queued', owner: null,
    createdAt: 1, conversationId: null
  });
  await append([]);
  const queue = w.document.getElementById('deliveryQueueList')!;
  expect(queue.textContent).toContain('#1 · AI Edit Intelligence');
  expect(queue.textContent).not.toContain('#1 · New Chat');
});

it('keeps a new-chat nickname while its delivered session awaits the catalog refresh', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({
    id: 'named-delivered-chat', sessionId: null, deliveredSessionId: '2026-10-01-catalog-lag',
    nickname: 'MMA Cage Removal', text: 'Continue the retained fixture', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', state: 'browser', owner: 'browser-owner',
    createdAt: 1, conversationId: 'provider-conversation'
  });
  await append([]);
  const queue = w.document.getElementById('deliveryQueueList')!;
  expect(queue.textContent).toContain('#1 · MMA Cage Removal');
  expect(queue.textContent).not.toContain('Unknown chat');
  expect(queue.textContent).not.toContain('2026-10-01-catalog-lag');
});

it('keeps an off-screen queue edit retryable when the save fails and refresh is unavailable', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-02-editfail', title: 'Edit Failure Chat', conversationId: 'chat-edit-failure' };
  const app = await boot([], true, [], [], { sessions: [first, second] });
  const { w, live, append } = app;
  live.inputs.push({
    id: 'offscreen-edit-failure', sessionId: second.id, text: 'Original queued text', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'queued', owner: null, createdAt: 1, conversationId: second.conversationId
  });
  await append([]);
  const panel = w.document.getElementById('deliveryQueuePanel') as HTMLDetailsElement;
  (panel.querySelector('[aria-label="Edit queued message"]') as HTMLButtonElement).click();
  await settle();
  const field = panel.querySelector<HTMLTextAreaElement>('.delivery-queue-editor')!;
  field.value = 'Revised queued text';
  field.dispatchEvent(new w.Event('input', { bubbles: true }));
  const save = field.parentElement!.querySelector<HTMLButtonElement>('.delivery-queue-actions .btn')!;
  const edit = vi.fn(async () => ({ ok: false as const, error: 'The durable message could not be saved.' }));
  (w as any).api.editQueuedInput = edit;
  (w as any).api.listInputs = () => new Promise(() => {});

  save.click();
  await settle();

  expect(edit).toHaveBeenCalledWith('offscreen-edit-failure', 'Revised queued text');
  expect(field.value).toBe('Revised queued text');
  expect(save.disabled).toBe(false);
});

it.each([
  { label: 'durable stale-state rejection', reply: { ok: true as const, data: false }, disabled: true },
  { label: 'IPC failure', reply: { ok: false as const, error: 'The durable cancel could not be saved.' }, disabled: false }
])('keeps global Delete $label fenced correctly while refresh is unavailable', async ({ reply, disabled }) => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-02-deletefail', title: 'Delete Failure Chat', conversationId: 'chat-delete-failure' };
  const app = await boot([], true, [], [], { sessions: [first, second] });
  const { w, live, append } = app;
  live.inputs.push({
    id: 'offscreen-delete-failure', sessionId: second.id, text: 'Delete authority test', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'queued', owner: null, createdAt: 1, conversationId: second.conversationId
  });
  await append([]);
  const panel = w.document.getElementById('deliveryQueuePanel') as HTMLDetailsElement;
  const cancel = vi.fn(async () => reply);
  (w as any).api.cancelInput = cancel;
  (w as any).api.listInputs = () => new Promise(() => {});
  const remove = panel.querySelector<HTMLButtonElement>('[aria-label="Delete queued message"]')!;

  remove.click();
  await settle();

  expect(cancel).toHaveBeenCalledWith('offscreen-delete-failure');
  expect(remove.disabled).toBe(disabled);
});

it.each([
  { label: 'durable stale-state result', reply: { ok: true as const, data: null }, disabled: true },
  { label: 'IPC failure', reply: { ok: false as const, error: 'The browser retry could not start.' }, disabled: false }
])('keeps global Retry browser $label fenced correctly while refresh is unavailable', async ({ reply, disabled }) => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-02-retryfail', title: 'Retry Failure Chat', conversationId: 'chat-retry-failure' };
  const app = await boot([], true, [], [], { sessions: [first, second] });
  const { w, live, append } = app;
  live.inputs.push({
    id: 'offscreen-retry-failure', sessionId: second.id, text: 'Retry authority test', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'queued', owner: null, createdAt: 1, conversationId: second.conversationId
  });
  await append([]);
  const panel = w.document.getElementById('deliveryQueuePanel') as HTMLDetailsElement;
  const retryApi = vi.fn(async () => reply);
  (w as any).api.retryInputBrowser = retryApi;
  (w as any).api.listInputs = () => new Promise(() => {});
  const retry = panel.querySelector<HTMLButtonElement>('[aria-label="Retry browser"]')!;

  retry.click();
  await settle();

  expect(retryApi).toHaveBeenCalledWith('offscreen-retry-failure');
  expect(retry.disabled).toBe(disabled);
});

it('keeps an off-screen authorized cancellation inspectable in the global Delivery queue', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-02-test0003', title: 'Background Chat', conversationId: 'chat-background' };
  const app = await boot([], true, [], [], { sessions: [first, second] });
  const { w, live, append } = app;
  live.inputs.push({
    id: 'offscreen-ambiguous-cancel', sessionId: second.id, text: 'Possibly delivered off-screen', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'browser', owner: 'background-page', createdAt: 2,
    conversationId: second.conversationId, requiresAuthorization: true, sendAuthorizedAt: Date.now()
  });
  await append([]);
  const panel = w.document.getElementById('deliveryQueuePanel') as HTMLDetailsElement;
  expect(panel.hidden).toBe(false);
  const cancel = vi.fn(async (id: string) => {
    live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' as const,
      error: 'Cancelled locally. Delivery to ChatGPT is unconfirmed; the message may already have been sent.' } : row);
    return { ok: true, data: true };
  });
  (w as any).api.cancelInput = cancel;
  (panel.querySelector('[aria-label="Delete queued message"]') as HTMLButtonElement).click();
  await settle();
  expect(cancel).toHaveBeenCalledWith('offscreen-ambiguous-cancel');
  expect(panel.hidden).toBe(false);
  expect(w.document.getElementById('deliveryQueueCount')!.textContent).toBe('1');
  expect(w.document.getElementById('deliveryQueueList')!.textContent).toContain('Possibly delivered off-screen');
  expect(w.document.getElementById('deliveryQueueList')!.textContent).toContain('may already have been sent');
  expect(panel.querySelector('[aria-label="Delete queued message"]')).toBeNull();
  const dismiss = panel.querySelector<HTMLButtonElement>('[aria-label="Dismiss delivery notice"]');
  expect(dismiss).not.toBeNull();
  dismiss!.click();
  await settle();
  expect(panel.hidden).toBe(true);
});

it('collapses old delivery attention to the newest cue per chat without revealing older cues after dismissal', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-02-delivery-cues', title: 'Zeta work', conversationId: 'chat-delivery-cues' };
  const now = Date.now();
  const app = await boot([], true, [], [], { sessions: [first, second], inputs: [
    {
      id: 'older-delivery-cue', sessionId: second.id, text: 'Older ambiguous delivery', mode: 'auto', dueAt: 0,
      model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'cancelled', owner: 'old-page', createdAt: now - 20_000,
      conversationId: second.conversationId, requiresAuthorization: true, sendAuthorizedAt: now - 19_000,
      error: 'Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.'
    },
    {
      id: 'newer-delivery-cue', sessionId: second.id, text: 'Newest ambiguous delivery', mode: 'auto', dueAt: 0,
      model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'cancelled', owner: 'new-page', createdAt: now - 10_000,
      conversationId: second.conversationId, requiresAuthorization: true, sendAuthorizedAt: now - 9_000,
      error: 'Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.'
    }
  ] });
  const { w, append } = app;
  await append([]);

  const panel = w.document.getElementById('deliveryQueuePanel') as HTMLDetailsElement;
  const global = w.document.getElementById('deliveryQueueList')!;
  expect(panel.hidden).toBe(false);
  expect(panel.open).toBe(false); // Terminal history alone does not pop the dock open.
  expect(w.document.getElementById('deliveryQueueCount')!.textContent).toBe('1');
  expect(global.textContent).toContain('Newest ambiguous delivery');
  expect(global.textContent).not.toContain('Older ambiguous delivery');

  panel.open = true;
  panel.querySelector<HTMLButtonElement>('[aria-label="Dismiss delivery notice"]')!.click();
  await settle();
  expect(panel.hidden).toBe(true);
  expect(global.textContent).not.toContain('Older ambiguous delivery');
});

it('caps global terminal delivery attention while leaving active transport complete', async () => {
  const first = summary([]);
  const now = Date.now();
  const sessions = [first];
  const inputs: InputEntry[] = [];
  for (let index = 0; index < 6; index += 1) {
    const session = { ...summary([]), id: `2026-09-02-cue-${index}`, title: `Cue ${index}`, conversationId: `chat-cue-${index}` };
    sessions.push(session);
    inputs.push({
      id: `terminal-cue-${index}`, sessionId: session.id, text: `Terminal cue ${index}`, mode: 'auto', dueAt: 0,
      model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'cancelled', owner: `page-${index}`, createdAt: now - index * 1000,
      conversationId: session.conversationId, requiresAuthorization: true, sendAuthorizedAt: now - index * 1000 + 1,
      error: 'Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.'
    });
  }
  inputs.push({
    id: 'active-delivery-stays-visible', sessionId: first.id, text: 'Active delivery stays visible', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'queued', owner: null, createdAt: now + 1,
    conversationId: first.conversationId
  });
  const app = await boot([], true, [], [], { sessions, inputs });
  await app.append([]);
  const list = app.w.document.getElementById('deliveryQueueList')!;
  expect(app.w.document.getElementById('deliveryQueueCount')!.textContent).toBe('4');
  expect(list.textContent).toContain('Active delivery stays visible');
  expect(list.querySelectorAll('.delivery-queue-item')).toHaveLength(4);
});

it('does not optimistically hide an off-screen cancellation when Send authorization wins during Delete', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-02-delete-race', title: 'Delete Race Chat', conversationId: 'chat-delete-race' };
  const app = await boot([], true, [], [], { sessions: [first, second] });
  const { w, live, append } = app;
  live.inputs.push({
    id: 'offscreen-delete-race', sessionId: second.id, text: 'Race against browser authorization', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'browser', owner: 'background-page', createdAt: 2,
    conversationId: second.conversationId, requiresAuthorization: true
  });
  await append([]);
  const panel = w.document.getElementById('deliveryQueuePanel') as HTMLDetailsElement;
  const cancel = vi.fn(async (id: string) => {
    live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' as const, sendAuthorizedAt: Date.now(),
      error: 'Cancelled locally. Delivery to ChatGPT is unconfirmed; the message may already have been sent.' } : row);
    return { ok: true, data: true };
  });
  (w as any).api.cancelInput = cancel;
  (w as any).api.listInputs = () => new Promise(() => {});
  const remove = panel.querySelector<HTMLButtonElement>('[aria-label="Delete queued message"]')!;

  remove.click();
  await settle();

  expect(cancel).toHaveBeenCalledWith('offscreen-delete-race');
  expect(panel.hidden).toBe(false);
  expect(w.document.getElementById('deliveryQueueCount')!.textContent).toBe('1');
  expect(w.document.getElementById('deliveryQueueList')!.textContent).toContain('Race against browser authorization');
  expect(remove.disabled).toBe(true);
});

it('repaints browser-send authorization immediately without waiting for a slow sidebar refresh', async () => {
  const app = await boot([]);
  const { w, live, append, notifySession } = app;
  live.inputs.push({
    id: 'fast-receipt', sessionId: summary([]).id, text: 'Already submitted', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'browser', owner: 'chrome-page', createdAt: 1,
    conversationId: 'chat-a'
  });
  await append([]);
  expect(w.document.getElementById('deliveryQueueList')!.textContent).toContain('Chrome is preparing the message');
  (w as any).api.listSessions = () => new Promise(() => {});
  live.inputs[0] = { ...live.inputs[0]!, sendAuthorizedAt: Date.now() };
  notifySession();
  await settle();
  expect(w.document.getElementById('deliveryQueueList')!.textContent).toContain('Sent to ChatGPT · confirming receipt');
});

it('keeps canonical image attachments above the user text bubble for the selected session', async () => {
  const app = await boot([]);
  const { w } = app;
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:one', inputId: 'one', message: text('Inspect this'), assets: [{ id: 'abcdef.bin', mimeType: 'image/webp', bytes: 12 }] };
  const getImage = vi.fn(async () => ({ ok: true, data: 'data:image/webp;base64,YQ==' }));
  // Match the real IPC result envelope used by this harness.
  (w as any).api.getSessionImage = getImage;
  await app.append([message]);
  const attachments = w.document.querySelector('.message-attachments')!;
  expect(attachments.tagName).toBe('DIV');
  expect(attachments.querySelector('summary')).toBeNull();
  expect(attachments.nextElementSibling?.classList.contains('user-message-text')).toBe(true);
  await settle();
  expect(getImage).toHaveBeenCalledWith(summary([]).id, 'abcdef.bin');
  expect(attachments.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,YQ==');
});

it('shows a native image-only message immediately as a card without a guessed caption or image fetch', async () => {
  const app = await boot([]);
  await app.append([{ seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'native-image-only',
    message: text(''), attachments: [{ id: 'native-provider-file', name: 'example.png', size: 123, mimeType: 'image/png' }] }]);
  const row = app.w.document.querySelector('.said.is-user')!;
  expect(row.querySelector('.attachment-card')?.textContent).toContain('example.png');
  expect(row.querySelector('.user-message-text')).toBeNull();
  expect(row.querySelector('img')).toBeNull();
});

it.each(['image', 'txt', 'mixed', 'new-chat', 'after-turn'])('routes the composer attachment action truthfully (%s)', async kind => {
  const app = await boot([], kind !== 'new-chat');
  const image = { id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 };
  const txt = { ...image, id: '22222222-2222-4333-8444-555555555555', name: 'notes.txt', mimeType: 'text/plain' };
  const files = kind === 'txt' ? [txt] : kind === 'mixed' ? [image, txt] : [image];
  (app.w as any).api.chooseFiles = async () => ({ ok: true, data: files });
  app.w.document.getElementById('attachImages')!.click(); await settle();
  expect(app.w.document.getElementById('immediateDeliveryLabel')!.textContent).toBe(
    kind === 'new-chat' ? 'Send' : ['txt', 'mixed'].includes(kind) ? 'After this turn' : 'Inject now');
  if (kind === 'after-turn') (app.w.document.getElementById('sendMode') as HTMLSelectElement).value = 'after-turn';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(app.live.sent).toHaveLength(1);
  expect(app.live.sent[0]).toMatchObject({ text: 'Please look at the attached files.', attachments: files });
  expect(app.live.sent[0]!.attachmentDelivery).toBe(kind === 'image' ? 'tool' : undefined);
});

it('restores the image draft after rejected injection and removes native-only delivery when the document is removed', async () => {
  const app = await boot([]);
  const image = { id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 };
  const txt = { ...image, id: '22222222-2222-4333-8444-555555555555', name: 'notes.txt', mimeType: 'text/plain' };
  (app.w as any).api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id, conversationId: summary([]).conversationId, activeTurnId: 'held-turn', canInject: true, queueAtFinish: true } });
  await app.append([]);
  (app.w as any).api.chooseFiles = async () => ({ ok: true, data: [image, txt] });
  app.w.document.getElementById('attachImages')!.click(); await settle();
  expect(app.w.document.getElementById('afterTurnLabel')!.textContent).toBe('After this turn');
  expect(app.w.document.getElementById('queueAtFinish')!.hidden).toBe(true);
  (app.w.document.querySelector('[aria-label="Remove notes.txt"]') as HTMLButtonElement).click();
  expect(app.w.document.getElementById('immediateDeliveryLabel')!.textContent).toBe('Inject now');
  (app.w as any).api.sendInput = async () => ({ ok: false, error: 'Image is too large for injection' });
  const field = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  field.value = 'Use the original image';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(field.value).toBe('Use the original image');
  expect(app.w.document.querySelectorAll('#composerImages .image-remove')).toHaveLength(1);
  expect(app.w.document.querySelector('[aria-label="Remove image.png"]')).not.toBeNull();
});

it('uses the same separate image row for pending and recorded native attachments', async () => {
  const app = await boot([]);
  const attachment = { id: 'a'.repeat(32), name: 'meme.png', mimeType: 'image/png', size: 42, preview: 'data:image/webp;base64,YQ==' };
  app.live.inputs.push({ id: 'image-input', sessionId: summary([]).id, text: 'whats that', attachments: [attachment],
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'browser', owner: null, createdAt: T0, conversationId: 'chat-b' });
  await app.append([]);
  const pending = app.w.document.querySelector('.pending-message')!;
  expect(pending.querySelector('.message-attachments')?.nextElementSibling?.className).toBe('pending-message-text');
  expect(pending.querySelector('.composer-image')).toBeNull();
  await app.append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'native-image',
    inputId: 'image-input', message: text('whats that'), attachments: [attachment] }]);
  const recorded = app.w.document.querySelector('.said.is-user')!;
  expect(recorded.querySelector('.message-attachments')?.nextElementSibling?.classList.contains('user-message-text')).toBe(true);
  expect(recorded.querySelector('.message-attachments > img')?.getAttribute('alt')).toBe('meme.png');
  expect(recorded.querySelector('.composer-image')).toBeNull();
});

it('collapses all provider problems to one warning glyph while retaining the sent message', async () => {
  const app = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'chat_error',
      message: text('Too many requests. You are making requests too quickly.'), blocking: true, recoverable: false },
    { seq: 2, time: T0 + 1, source: 'extension', kind: 'user_message', messageId: 'visible-prompt',
      message: text('Keep the recorded prompt visible') },
    { seq: 3, time: T0 + 2, source: 'extension', kind: 'chat_error',
      message: text('Thinking failed'), blocking: true, recoverable: true },
    { seq: 4, time: T0 + 3, source: 'extension', kind: 'chat_error',
      message: text('Too many requests. You are making requests too quickly.'), blocking: true, recoverable: false }
  ]);
  expect(app.w.document.querySelector('.chat-error-notice')).toBeNull();
  const compactRows = app.w.document.querySelectorAll('.chat-error-compact');
  expect(compactRows).toHaveLength(1);
  const compact = compactRows[0]!;
  expect(compact).not.toBeNull();
  expect(compact.textContent).toBe('');
  expect(compact.getAttribute('aria-label')).toMatch(/3 ChatGPT problem notices collapsed/i);
  expect(compact.getAttribute('title')).toMatch(/3 problem notices collapsed/i);
  expect(app.w.document.querySelector('.user-message-text')?.textContent).toBe('Keep the recorded prompt visible');
  app.live.inputs.push({ id: 'rate-limited-input', sessionId: summary([]).id, text: 'Keep my actual prompt visible', error: 'Too many requests. Please wait.',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'failed', owner: null, createdAt: T0, conversationId: 'chat-b' });
  await app.append([]);
  const pending = app.w.document.querySelector('.pending-message.is-rate-limited')!;
  expect(pending.textContent).toContain('Keep my actual prompt visible');
  expect(pending.textContent).not.toContain('Too many requests');
});

it('edits and persists a chat nickname from the selected row', async () => {
  const named = { ...summary([]), title: 'storyboard/photoeditor', titleSource: 'fallback' as const,
    originalTitle: 'Coding Agent Guidance', lastMessageAt: T0 };
  const app = await boot([], true, [], [], { sessions: [named] });
  const reveal = app.w.document.querySelector('.sess-title-toggle') as HTMLButtonElement;
  expect(reveal.getAttribute('aria-expanded')).toBe('false');
  reveal.click();
  expect(app.w.document.querySelector('.sess-original-title')?.textContent).toBe('Coding Agent Guidance');
  expect(app.w.document.getElementById('chatOriginalTitle')?.textContent).toBe('Coding Agent Guidance');
  (app.w.document.querySelector('.sess-more') as HTMLButtonElement).click();
  [...app.w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Add or edit chat nickname')!.click();
  await settle();
  const input = app.w.document.querySelector('.sess-rename-input') as HTMLInputElement;
  expect(input.value).toBe('storyboard/photoeditor');
  input.value = 'Render automation';
  await app.append([]);
  expect(app.w.document.querySelector('.sess-rename-input')).toBe(input);
  expect(input.value).toBe('Render automation');
  input.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(app.live.controlCalls).toContainEqual({ id: summary([]).id, action: 'rename:Render automation' });
  expect(app.w.document.getElementById('chatTitle')!.textContent).toBe('Render automation');
});

it('keeps Open in Chrome pending only while its exact request is in flight and offers immediate Retry on failure', async () => {
  const { w } = await boot([]);
  const api = (w as any).api;
  const completions: Array<(value: unknown) => void> = [];
  api.openSessionChat = vi.fn(() => new Promise(resolve => completions.push(resolve)));

  (w.document.querySelector('.sess-more') as HTMLButtonElement).click();
  [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Open this chat in Chrome')!.click();
  await settle();
  (w.document.querySelector('.sess-more') as HTMLButtonElement).click();
  let open = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Opening this chat in Chrome…')!;
  expect(api.openSessionChat).toHaveBeenCalledTimes(1);
  expect(open.disabled).toBe(true);
  open.click();
  expect(api.openSessionChat).toHaveBeenCalledTimes(1);

  completions.shift()!({
    ok: true,
    data: {
      ok: false,
      requestId: 'failed-open',
      conversationId: 'chat-a',
      outcome: null,
      failure: 'inventory_timeout',
      message: 'Chrome did not finish reading its tabs in time. Retry the request.',
      timing: { renderer: null, main: {}, extension: null }
    }
  });
  await settle();
  (w.document.querySelector('.sess-more') as HTMLButtonElement).click();
  open = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Open this chat in Chrome')!;
  expect(open.disabled).toBe(false);
  const retry = w.document.querySelector('.toast-action-button') as HTMLButtonElement;
  expect(retry.textContent).toBe('Retry');
  expect(w.document.querySelector('.toast')?.textContent).toContain('did not finish reading its tabs');

  retry.click();
  await settle();
  expect(api.openSessionChat).toHaveBeenCalledTimes(2);
  completions.shift()!({
    ok: true,
    data: {
      ok: true,
      requestId: 'successful-open',
      conversationId: 'chat-a',
      outcome: 'focused',
      failure: null,
      message: 'Chrome focused the existing conversation tab.',
      timing: { renderer: null, main: {}, extension: null }
    }
  });
  await settle();
  (w.document.querySelector('.sess-more') as HTMLButtonElement).click();
  const reopened = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Open this chat in Chrome')!;
  expect(reopened.disabled).toBe(false);
});

it('explains a legacy missing image recording without asserting a provider receipt', async () => {
  const app = await boot([]);
  const event = toolCall(1, 'missing-image') as Extract<SessionEvent, { kind: 'tool_call' }>;
  event.call.tool = 'view_image';
  event.call.result = text('');
  await app.append([event]);
  const tool = app.w.document.querySelector('details.tool')!;
  expect(tool.textContent).toContain('No image preview was retained in this recording.');
  expect(tool.textContent).not.toContain('received');
});

it('loads recorded tool images on expansion and hides truncated binary envelopes', async () => {
  const app = await boot([]);
  const { w } = app;
  const event = toolCall(1, 'plugin-image') as Extract<SessionEvent, { kind: 'tool_call' }>;
  event.call.tool = 'get_viewport_screenshot';
  event.call.result = { text: '{"content":[{"type":"image","data":"AAAA', truncated: true, chars: 140000, assetId: 'aaaaaaaa.txt' };
  event.call.assets = [{ id: 'abcdefab.png', mimeType: 'image/png', bytes: 99000 }];
  const getImage = vi.fn(async () => ({ ok: true, data: 'data:image/png;base64,YQ==' }));
  (w as any).api.getSessionImage = getImage;
  await app.append([event]);
  const tool = w.document.querySelector('details.tool') as HTMLDetailsElement;
  expect(getImage).not.toHaveBeenCalled();
  expect(tool.textContent).not.toContain('AAAA');
  expect(tool.textContent).toContain('aaaaaaaa.txt');
  tool.open = true; tool.dispatchEvent(new w.Event('toggle'));
  await settle();
  expect(getImage).toHaveBeenCalledWith(summary([]).id, 'abcdefab.png');
  expect(tool.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,YQ==');
});

it('creates a local sidebar folder from a right-clicked multi-selection without changing chats', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-14-bbbbbbbb', conversationId: 'folder-chat-b', title: 'Second chat' };
  const { w, sidebarFolders } = await boot([], false, [], [], { sessions: [first, second] });
  vi.spyOn(w, 'prompt').mockReturnValue('Editing');

  for (const id of [first.id, second.id]) {
    w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!.dispatchEvent(
      new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
    );
  }
  const secondRow = w.document.querySelector<HTMLElement>(`.sess[data-id="${second.id}"]`)!;
  secondRow.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  const create = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent?.includes('Create folder from 2 selected'))!;
  create.click();
  await settle();

  expect(sidebarFolders()).toHaveLength(1);
  expect(w.document.querySelector('.toast')?.textContent).toBe('Folder created');
  const section = w.document.querySelector<HTMLElement>('.local-folder-group')!;
  expect(section.querySelector('.project-name')?.textContent).toBe('Editing');
  expect(section.querySelectorAll('.sess')).toHaveLength(2);
  expect(sidebarFolders()[0]?.sessionIds).toEqual([first.id, second.id]);
  expect(w.document.getElementById('sessionContextMenu')).toBeNull();
});

it('keeps destructive actions out of rows and blocks or releases one chat only from its context menu', async () => {
  const first = summary([]);
  const unattributed = { ...summary([]), id: '2026-09-14-00000000', conversationId: null, title: 'Unattributed' };
  const { w, live } = await boot([], false, [], [], { sessions: [first, unattributed] });
  const firstRow = w.document.querySelector<HTMLElement>(`.sess[data-id="${first.id}"]`)!;
  const unattributedRow = w.document.querySelector<HTMLElement>(`.sess[data-id="${unattributed.id}"]`)!;

  expect(firstRow.querySelector('.sess-del')).toBeNull();
  expect(firstRow.querySelector('.sess-block')).toBeNull();
  expect(firstRow.querySelectorAll('.sess-action')).toHaveLength(1);
  expect(firstRow.querySelector('.sess-more')).not.toBeNull();
  expect(unattributedRow.querySelector('.sess-del, .sess-block, .sess-open')).toBeNull();
  expect(unattributedRow.querySelector('.sess-more')).not.toBeNull();

  firstRow.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  const block = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Block this chat')!;
  expect(block.disabled).toBe(false);
  block.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: first.id, action: 'block' });

  w.document.querySelector<HTMLElement>(`.sess[data-id="${first.id}"]`)!.dispatchEvent(
    new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })
  );
  const release = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Release this chat')!;
  release.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: first.id, action: 'release' });
});

it('sets and clears a chat-owned sub-agent limit from the right-click menu', async () => {
  const first = summary([]);
  const { w, live } = await boot([], false, [], [], { sessions: [first] });
  const prompts = vi.spyOn(w, 'prompt').mockReturnValueOnce('1').mockReturnValueOnce('');
  const row = () => w.document.querySelector<HTMLElement>(`.sess[data-id="${first.id}"]`)!;

  row().dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }));
  [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent?.startsWith('Sub-agent limit:'))!.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: first.id, action: 'workers:1' });

  row().dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }));
  expect(w.document.getElementById('sessionContextMenu')?.textContent).toContain('Sub-agent limit: 1');
  [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent?.startsWith('Sub-agent limit:'))!.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: first.id, action: 'workers:global' });
  expect(prompts).toHaveBeenCalledTimes(2);
});

it('shows the effective sub-agent limit on each normal chat and edits it directly', async () => {
  const first = summary([]);
  const { w, live } = await boot([], false, [], [], { sessions: [first] });
  const prompt = vi.spyOn(w, 'prompt').mockReturnValue('1');
  const row = () => w.document.querySelector<HTMLElement>(`.sess[data-id="${first.id}"]`)!;

  const inherited = row().querySelector<HTMLButtonElement>('.sess-worker-limit')!;
  expect(inherited.textContent).toBe('A2');
  expect(inherited.classList.contains('is-global')).toBe(true);
  expect(inherited.title).toContain('Global (2)');
  inherited.click();
  await settle();

  expect(prompt).toHaveBeenCalledTimes(1);
  expect(live.controlCalls).toContainEqual({ id: first.id, action: 'workers:1' });
  const custom = row().querySelector<HTMLButtonElement>('.sess-worker-limit')!;
  expect(custom.textContent).toBe('A1');
  expect(custom.classList.contains('is-custom')).toBe(true);
  expect(custom.title).toContain('1 for this chat');
});

it('shows the hard effective cap and truthful worker lifecycle counts on normal chat rows', async () => {
  const first = { ...summary([]), workerLimit: 8 };
  const second = { ...summary([]), id: '2026-09-14-workerzero', conversationId: 'worker-zero-chat', title: 'No workers needed' };
  const { w } = await boot([], false, [], [], {
    sessions: [first, second],
    globalWorkerLimit: 6,
    workerProgress: [
      { id: first.id, total: 5, active: 1, queued: 1, finished: 2, failed: 1, names: ['Audit'], failures: ['One worker failed'] },
      { id: second.id, total: 0, active: 0, queued: 0, finished: 0, failed: 0, names: [], failures: [] }
    ]
  });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;

  const limit = row(first.id).querySelector<HTMLButtonElement>('.sess-worker-limit')!;
  expect(limit.textContent).toBe('A6');
  expect(limit.title).toMatch(/effective limit: 6/i);
  expect(row(first.id).querySelector('.sess-worker-summary')?.textContent)
    .toBe('1 active · 1 queued · 2 finished · 1 failed');
  expect(row(second.id).querySelector('.sess-worker-summary')?.textContent).toBe('0 workers');

  row(first.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }));
  expect(w.document.getElementById('sessionContextMenu')?.textContent)
    .toMatch(/Sub-agent limit: 6 effective \(saved 8\)/i);
});

it('sets one sub-agent limit across a right-clicked multi-selection', async () => {
  const first = { ...summary([]), workerLimit: 1 };
  const second = { ...summary([]), id: '2026-09-14-bbbbbbbb', conversationId: 'worker-limit-chat-b', title: 'Second chat', workerLimit: 4 };
  const { w, live } = await boot([], false, [], [], { sessions: [first, second] });
  const prompt = vi.spyOn(w, 'prompt').mockReturnValue('3');
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;

  for (const id of [first.id, second.id]) {
    row(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  }
  row(second.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  const batch = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Sub-agent limit for 2 chats: Mixed')!;
  expect(batch.disabled).toBe(false);
  batch.click();
  await settle();

  expect(prompt).toHaveBeenCalledTimes(1);
  expect(live.controlCalls.filter(call => call.action === 'workers:3')).toEqual([
    { id: first.id, action: 'workers:3' },
    { id: second.id, action: 'workers:3' }
  ]);
  expect(w.document.querySelector('.toast')?.textContent).toBe('Sub-agent limits: 2 updated, 0 failed.');

  row(second.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  expect(w.document.getElementById('sessionContextMenu')?.textContent).toContain('Sub-agent limit for 2 chats: 2 effective (saved 3)');
});

it('sets, edits, and removes one shared Goal or Loop across a right-clicked multi-selection', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-14-bbbbbbbb', conversationId: 'automation-chat-b', title: 'Second chat' };
  const { w, live } = await boot([], false, [], [], { sessions: [first, second] });
  const prompt = vi.spyOn(w, 'prompt').mockReturnValue('Ship and verify the shared result');
  (w as any).api.getSessionControls = vi.fn((id: string) => Promise.resolve({ ok: true, data: {
    sessionId: id,
    conversationId: id === first.id ? first.conversationId : second.conversationId,
    automation: 'goal',
    objective: 'Existing shared goal',
    activeTurnId: null,
    finishHeld: false,
    blocked: '',
    job: null,
    plan: null
  } }));
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;
  for (const id of [first.id, second.id]) {
    row(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  }

  row(second.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Add selected to rotation batch')!.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: [first.id, second.id].join(','), action: 'batch-add' });

  row(second.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Set or edit shared Goal for 2 chats…')!.click();
  await settle();

  expect(prompt).toHaveBeenCalledWith(expect.stringContaining('one shared Goal'), '');
  expect(live.controlCalls).toContainEqual({
    id: [first.id, second.id].join(','),
    action: 'goal-selected:Ship and verify the shared result'
  });
  expect(w.document.querySelector('.toast')?.textContent).toBe('Shared Goal applied to 2 chat(s).');

  row(second.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Remove Goal / Loop from 2 chats')!.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: [first.id, second.id].join(','), action: 'off-selected' });
  expect(w.document.querySelector('.toast')?.textContent).toBe('Goal / Loop removed from 2 chat(s).');
});

it('pauses a right-clicked multi-selection after current work', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-14-bbbbbbbc', conversationId: 'pause-chat-b', title: 'Second paused chat' };
  const projection = (row: typeof first): AutomationSupervisorSnapshot['chats'][number] => ({
    sessionId: row.id,
    conversationId: row.conversationId!,
    title: row.title,
    mode: 'loop',
    state: 'working',
    reason: 'The main chat is working.',
    nextAction: 'Wait.',
    nextRetryAt: null,
    lastWorkedAt: T0,
    activeWorkers: 0,
    failedWorkers: 0,
    recoverable: false,
    spinning: true,
    recoveryStage: null
  });
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0,
    targetLanes: 2,
    chats: [projection(first), projection(second)],
    counts: { working: 2, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 0 }
  };
  const { w, live } = await boot([], false, [], [], { sessions: [first, second], automation });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;
  for (const id of [first.id, second.id]) {
    row(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  }
  row(second.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  const pause = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Pause after current work for 2 chats')!;
  expect(pause.disabled).toBe(false);
  pause.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: [first.id, second.id].join(','), action: 'pause-selected' });
  expect(w.document.querySelector('.toast')?.textContent)
    .toBe('2 chat(s) are pausing after current work; 0 had nothing active to pause.');

});

it('shows exact graceful-pause drain progress and the safe-to-restart boundary', async () => {
  const current = summary([]);
  const projection = (phase: 'draining' | 'ready'): AutomationSupervisorSnapshot['chats'][number] => ({
    sessionId: current.id,
    conversationId: current.conversationId!,
    title: current.title,
    mode: 'loop',
    state: 'paused',
    reason: phase === 'ready' ? 'Paused and fully drained.' : 'Pause is active; finishing one worker.',
    nextAction: phase === 'ready' ? 'Safe to restart.' : 'Wait for the worker.',
    nextRetryAt: null,
    lastWorkedAt: T0,
    activeWorkers: phase === 'ready' ? 0 : 1,
    failedWorkers: 0,
    recoverable: false,
    spinning: false,
    recoveryStage: null,
    pause: { phase, remaining: phase === 'ready' ? 0 : 1, mainTurn: false, runningTools: 0,
      activeWorkers: phase === 'ready' ? 0 : 1, handoff: false, browserAction: false }
  });
  const automation: AutomationSupervisorSnapshot = {
    observedAt: T0,
    targetLanes: 0,
    chats: [projection('draining')],
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 1, blocked: 0 }
  };
  const { w, append } = await boot([], false, [], [], { sessions: [current], automation });
  const row = () => w.document.querySelector<HTMLElement>(`.sess[data-id="${current.id}"]`)!;
  expect(row().querySelector('.sess-automation-state')?.textContent).toBe('pausing');
  expect(row().querySelector('.sess-pause-progress')?.textContent).toBe('1 left · 1 workers');

  automation.chats = [projection('ready')];
  await append([]);
  expect(row().querySelector('.sess-automation-state')?.textContent).toBe('paused');
  expect(row().querySelector('.sess-pause-progress')?.textContent).toBe('safe to restart');
});

it('disables shared Goal and Loop editing when a selection includes a worker', async () => {
  const first = summary([]);
  const worker = { ...summary([]), id: '2026-09-14-cccccccc', conversationId: 'automation-worker-c', title: 'Worker',
    origin: { kind: 'worker' as const, fromSessionId: first.id, agentId: 'worker-1', task: 'Inspect' } };
  const { w, live } = await boot([], false, [], [], { sessions: [first, worker] });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;
  const subagents = [...w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics')]
    .find(details => details.querySelector(':scope > summary')?.textContent?.includes('Sub-agent history'))!;
  subagents.open = true;
  for (const id of [first.id, worker.id]) {
    row(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  }
  row(worker.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  const unavailable = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Goal / Loop unavailable')!;
  expect(unavailable.disabled).toBe(true);
  expect(unavailable.title).toMatch(/normal conversations/i);
  expect(live.controlCalls.some(call => call.action.includes('-selected'))).toBe(false);
});

it('disables batch sub-agent limits when the selection includes a worker or Unattributed activity', async () => {
  const first = summary([]);
  const worker = { ...summary([]), id: '2026-09-14-cccccccc', conversationId: 'worker-limit-chat-c', title: 'Worker',
    origin: { kind: 'worker' as const, fromSessionId: first.id, agentId: 'worker-1', task: 'Inspect' } };
  const unattributed = { ...summary([]), id: '2026-09-14-00000000', conversationId: null, title: 'Unattributed' };
  const { w, live } = await boot([], false, [], [], { sessions: [first, worker, unattributed] });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;

  expect(row(first.id).querySelector('.sess-worker-limit')).not.toBeNull();
  expect(row(worker.id).querySelector('.sess-worker-limit')).toBeNull();
  expect(row(unattributed.id).querySelector('.sess-worker-limit')).toBeNull();

  const subagents = [...w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics')]
    .find(details => details.querySelector(':scope > summary')?.textContent?.includes('Sub-agent history'))!;
  subagents.open = true;
  for (const id of [first.id, worker.id]) {
    row(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  }
  row(worker.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  const unsupported = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Sub-agent limit for 2 chats unavailable')!;
  expect(unsupported.disabled).toBe(true);
  expect(unsupported.title).toMatch(/normal conversations/i);
  expect(live.controlCalls.some(call => call.action.startsWith('workers:'))).toBe(false);

  // An Unattributed diagnostics row is rejected by the same user-facing action and reason.
  row(first.id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  row(worker.id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics').forEach(details => { details.open = true; });
  row(unattributed.id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  row(unattributed.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  const unattributedAction = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent?.startsWith('Sub-agent limit') && button.textContent.includes('unavailable'))!;
  expect(unattributedAction.disabled).toBe(true);
});

it('batch-blocks selected chats and disables Block when the selection includes Unattributed activity', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-14-bbbbbbbb', conversationId: 'batch-chat-b', title: 'Second chat' };
  const unattributed = { ...summary([]), id: '2026-09-14-00000000', conversationId: null, title: 'Unattributed' };
  const { w, live } = await boot([], false, [], [], { sessions: [first, second, unattributed] });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;

  for (const id of [first.id, second.id]) {
    row(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  }
  row(second.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  expect(w.document.querySelectorAll('.sess.is-multi-sel')).toHaveLength(2);
  const batch = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Block selected')!;
  expect(batch.disabled).toBe(false);
  batch.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: [first.id, second.id].join(','), action: 'block-selected' });

  // Add an unattributed diagnostics row to that explicit selection. The menu must preserve the
  // selection, disable the chat action, and explain why instead of touching the global policy.
  row(unattributed.id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  row(second.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  const unsupported = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Block selected')!;
  expect(unsupported.disabled).toBe(true);
  expect(unsupported.title).toMatch(/Unattributed activity/i);
  expect([...w.document.querySelectorAll('.session-context-hint')]
    .some(hint => /Select only recorded chats/i.test(hint.textContent ?? ''))).toBe(true);
  const before = live.controlCalls.length;
  unsupported.click();
  await settle();
  expect(live.controlCalls).toHaveLength(before);
});

it('keeps an open context menu and active nickname edit through harmless list refreshes', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-14-bbbbbbbb', conversationId: 'refresh-chat-b', title: 'Second chat' };
  const { w, replaceSessions, notifySession } = await boot([], false, [], [], { sessions: [first, second] });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;
  for (const id of [first.id, second.id]) row(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  row(second.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  const menu = w.document.getElementById('sessionContextMenu')!;
  await replaceSessions([{ ...second, updatedAt: T0 + 500_000 }, { ...first, title: 'First refreshed' }]);
  expect(w.document.getElementById('sessionContextMenu')).toBe(menu);
  expect(w.document.querySelectorAll('.sess.is-multi-sel')).toHaveLength(2);

  menu.remove();
  const refreshedFirst = row(first.id);
  (refreshedFirst.querySelector('.sess-more') as HTMLButtonElement).click();
  [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent === 'Add or edit chat nickname')!.click();
  await settle();
  const editor = w.document.querySelector<HTMLInputElement>(`.sess[data-id="${first.id}"] .sess-rename-input`)!;
  editor.value = 'Still typing'; editor.setSelectionRange(2, 8); editor.focus();
  notifySession();
  await settle();
  const preserved = w.document.querySelector<HTMLInputElement>(`.sess[data-id="${first.id}"] .sess-rename-input`)!;
  expect(preserved).toBe(editor);
  expect(w.document.activeElement).toBe(editor);
  expect(preserved.value).toBe('Still typing');
  expect(preserved.selectionStart).toBe(2);
  expect(preserved.selectionEnd).toBe(8);
});

it('extends selection with Shift-right-click and permanently deletes every selected conversation', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-14-bbbbbbbb', conversationId: 'delete-chat-b', title: 'Second chat' };
  const third = { ...summary([]), id: '2026-09-14-cccccccc', conversationId: 'delete-chat-c', title: 'Third chat' };
  const { w, live } = await boot([], false, [], [], { sessions: [first, second, third] });
  vi.spyOn(w, 'confirm').mockReturnValue(true);

  w.document.querySelector<HTMLElement>(`.sess[data-id="${first.id}"]`)!.click();
  w.document.querySelector<HTMLElement>(`.sess[data-id="${third.id}"]`)!.dispatchEvent(
    new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true, clientX: 40, clientY: 50 })
  );
  expect(w.document.querySelectorAll('.sess.is-multi-sel')).toHaveLength(3);
  const permanent = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent?.includes('Permanently delete 3 selected'))!;
  permanent.click();
  await settle();

  expect(live.controlCalls).toContainEqual({ id: [first.id, second.id, third.id].join(','), action: 'permanent-delete' });
  expect(w.document.querySelectorAll('#sessionList .sess')).toHaveLength(0);
  expect(w.confirm).toHaveBeenCalledWith(expect.stringMatching(/loops, queues, helpers, and worker runs will be stopped/i));
});

it('drains selections larger than the durable 200-row limit through bounded delete batches', async () => {
  const many = Array.from({ length: 205 }, (_unused, index) => ({
    ...summary([]),
    id: `2026-09-14-${index.toString(16).padStart(8, '0')}`,
    conversationId: `delete-many-${index.toString().padStart(4, '0')}`,
    title: `Delete ${index + 1}`
  }));
  const expectedIds = many.map(row => row.id);
  const { w, live } = await boot([], false, [], [], { sessions: many });
  const confirm = vi.spyOn(w, 'confirm').mockReturnValue(true);
  const first = w.document.querySelector<HTMLElement>('.sess[data-id]')!;
  first.click();
  first.dispatchEvent(new w.KeyboardEvent('keydown', {
    key: 'a', bubbles: true, cancelable: true, ctrlKey: true
  }));
  first.dispatchEvent(new w.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 40, clientY: 50
  }));
  const permanent = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent?.includes('Permanently delete 205 selected'))!;
  permanent.click();
  await settle();

  const batches = live.controlCalls
    .filter(call => call.action === 'permanent-delete')
    .map(call => call.id.split(','));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(batches.map(batch => batch.length)).toEqual([100, 100, 5]);
  expect(new Set(batches.flat())).toEqual(new Set(expectedIds));
  expect(w.document.querySelectorAll('#sessionList .sess')).toHaveLength(0);
});

it('keeps stable multi-selection across mouse modifiers, keyboard navigation and harmless refreshes', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-14-bbbbbbbb', conversationId: 'select-chat-b', title: 'Second chat' };
  const third = { ...summary([]), id: '2026-09-14-cccccccc', conversationId: 'select-chat-c', title: 'Third chat' };
  const { w, replaceSessions } = await boot([], false, [], [], { sessions: [first, second, third] });
  const count = () => w.document.getElementById('sessionSelectionCount')!;
  const summaryNode = () => w.document.getElementById('sessionSelectionSummary')!;
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;

  expect(w.document.getElementById('sessionList')?.getAttribute('role')).toBe('listbox');
  expect(w.document.getElementById('sessionList')?.getAttribute('aria-multiselectable')).toBe('true');
  expect(summaryNode().hidden).toBe(true);

  // Ordinary click establishes the range anchor; Shift+left-click must include the whole range.
  row(first.id).click();
  await settle();
  row(third.id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
  expect(count().textContent).toContain('3 selected');
  expect(summaryNode().hidden).toBe(false);
  expect(w.document.querySelectorAll('.sess.is-multi-sel')).toHaveLength(3);

  // Windows/Linux Ctrl and macOS Cmd both toggle one stable session id.
  row(second.id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  expect(count().textContent).toContain('2 selected');
  row(second.id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  expect(count().textContent).toContain('3 selected');

  // Rename/status/order churn replaces DOM nodes but must not replace identity-based selection.
  await replaceSessions([
    { ...third, title: 'Third renamed', endedAt: T0 + 180_000 },
    { ...first, title: 'First renamed', updatedAt: T0 + 240_000 },
    { ...second, title: 'Second renamed', updatedAt: T0 + 220_000 }
  ]);
  expect(count().textContent).toContain('3 selected');
  expect(new Set([...w.document.querySelectorAll<HTMLElement>('.sess.is-multi-sel')].map(entry => entry.dataset.id))).toEqual(
    new Set([first.id, second.id, third.id])
  );

  w.document.getElementById('clearSessionSelection')!.click();
  expect(summaryNode().hidden).toBe(true);
  const firstVisible = w.document.querySelector<HTMLElement>('.sess[data-id]')!;
  firstVisible.focus();
  firstVisible.dispatchEvent(new w.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  expect(count().textContent).toContain('1 selected');
  expect(w.document.activeElement?.getAttribute('role')).toBe('option');
  (w.document.activeElement as HTMLElement).dispatchEvent(new w.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true, shiftKey: true
  }));
  expect(count().textContent).toContain('2 selected');
  expect(w.document.activeElement?.getAttribute('aria-selected')).toBe('true');

  (w.document.activeElement as HTMLElement).dispatchEvent(new w.KeyboardEvent('keydown', {
    key: 'a', bubbles: true, cancelable: true, ctrlKey: true
  }));
  expect(count().textContent).toContain('3 selected');
  (w.document.activeElement as HTMLElement).dispatchEvent(new w.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true
  }));
  expect(summaryNode().hidden).toBe(true);
});

it('right-clicking an unselected conversation makes it the only selected row and keyboard-opens its menu', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-14-bbbbbbbb', conversationId: 'context-chat-b', title: 'Second chat' };
  const third = { ...summary([]), id: '2026-09-14-cccccccc', conversationId: 'context-chat-c', title: 'Third chat' };
  const { w } = await boot([], false, [], [], { sessions: [first, second, third] });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;

  for (const id of [first.id, second.id]) {
    row(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  }
  row(third.id).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  expect(w.document.querySelectorAll('.sess.is-multi-sel')).toHaveLength(1);
  expect(row(third.id).getAttribute('aria-selected')).toBe('true');
  expect(w.document.getElementById('sessionSelectionCount')?.textContent).toContain('1 selected');
  expect(w.document.querySelector('#sessionContextMenu button:focus')).not.toBeNull();

  w.document.getElementById('sessionContextMenu')?.remove();
  row(second.id).focus();
  row(second.id).dispatchEvent(new w.KeyboardEvent('keydown', {
    key: 'F10', bubbles: true, cancelable: true, shiftKey: true
  }));
  expect(w.document.getElementById('sessionContextMenu')).not.toBeNull();
  expect(row(second.id).getAttribute('aria-selected')).toBe('true');
  expect(w.document.querySelector('#sessionContextMenu button:focus')).not.toBeNull();

  w.document.getElementById('sessionContextMenu')?.remove();
  row(second.id).focus();
  row(second.id).dispatchEvent(new w.KeyboardEvent('keydown', {
    key: 'ContextMenu', bubbles: true, cancelable: true
  }));
  expect(w.document.getElementById('sessionContextMenu')).not.toBeNull();
  expect(row(second.id).getAttribute('aria-selected')).toBe('true');
});

it('offers one exact-count confirmation and one Undo for a recoverable multi-row deletion', async () => {
  const first = summary([]);
  const second = { ...summary([]), id: '2026-09-14-bbbbbbbb', conversationId: 'undo-chat-b', title: 'Second chat' };
  const { w, live } = await boot([], false, [], [], { sessions: [first, second] });
  const confirm = vi.spyOn(w, 'confirm').mockReturnValue(true);
  for (const id of [first.id, second.id]) {
    w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!.dispatchEvent(
      new w.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
    );
  }
  w.document.querySelector<HTMLElement>(`.sess[data-id="${second.id}"]`)!.dispatchEvent(
    new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })
  );
  const trash = [...w.document.querySelectorAll<HTMLButtonElement>('#sessionContextMenu button')]
    .find(button => button.textContent?.includes('Move 2 selected to Trash'))!;
  trash.click();
  await settle();

  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Move 2 selected conversations/));
  expect(w.document.querySelectorAll('#sessionList .sess')).toHaveLength(0);
  expect(w.document.querySelector('.toast-action')?.textContent).toContain('2 conversations moved to Trash');
  const undo = w.document.querySelector<HTMLButtonElement>('.toast-action-button')!;
  expect(undo.textContent).toBe('Undo');
  undo.click();
  await settle();

  expect(live.controlCalls).toContainEqual({ id: first.id, action: 'restore' });
  expect(live.controlCalls).toContainEqual({ id: second.id, action: 'restore' });
  expect(w.document.querySelectorAll('#sessionList .sess')).toHaveLength(2);
  expect(w.document.querySelector('.toast')?.textContent).toContain('2 conversation(s) restored');
});

it('queues the bulk fresh-copy command from its hotkey only after confirmation', async () => {
  const { w, live } = await boot([], false);
  vi.spyOn(w, 'confirm').mockReturnValue(true);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', {
    key: 'N', bubbles: true, cancelable: true, ctrlKey: true, altKey: true, shiftKey: true
  }));
  await settle();
  expect(live.controlCalls).toContainEqual({ id: '*', action: 'fresh-copy' });
});

it('shows the durable global automation pause and resumes it from the chat toolbar', async () => {
  const { w, live } = await boot([], true, [], [], { automationPaused: true });
  const toggle = w.document.getElementById('toggleAutomationPause') as HTMLButtonElement;
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(w.document.getElementById('automationPauseLabel')?.textContent).toBe('Resume');
  const resumeAll = w.document.getElementById('resumeAutomation') as HTMLButtonElement;
  expect(resumeAll.disabled).toBe(false);
  expect(resumeAll.title).toContain('Release the global pause');
  expect((w.document.getElementById('freshCopyAutomation') as HTMLButtonElement).disabled).toBe(true);
  expect((w.document.getElementById('compactSession') as HTMLButtonElement).disabled).toBe(true);

  resumeAll.click();
  await settle();
  expect(live.controlCalls.filter(call => call.action === 'resume-all')).toEqual([{ id: '*', action: 'resume-all' }]);
  expect(w.document.querySelector('.toast')?.textContent)
    .toContain('Automation resumed: 2 eligible chat(s), 2 queued, 0 working, 0 recovering, 0 exact replies restored. Chats with Goal/Loop Off stay Off; active turns are not interrupted.');
});

it('exposes graceful pause controls for all chats and for the selected automated chat', async () => {
  const { w, live } = await boot([]);
  expect(w.document.getElementById('automationPauseLabel')?.textContent).toBe('Pause all');
  const pauseAll = w.document.getElementById('toggleAutomationPause') as HTMLButtonElement;
  expect(pauseAll.title).toContain('current provider turns and running workers finish');

  (w.document.querySelector('#automationSwitch [data-mode="loop"]') as HTMLButtonElement).click();
  await settle();
  const pauseChat = w.document.querySelector('#activeGoalRow button[aria-label="Pause after turn"]') as HTMLButtonElement;
  expect(pauseChat).not.toBeNull();
  expect(pauseChat.textContent).toContain('Pause after turn');
  pauseChat.click();
  await settle();

  expect(live.controlCalls).toContainEqual({ id: summary([]).id, action: 'off' });
  expect(live.sent).toEqual([]);
  expect(w.document.querySelector('.toast')?.textContent)
    .toContain('current turn and running workers finish');
});

it('pages project tasks without mixing their worker sessions into the project list', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Paged', path: '/paged', createdAt: 1 };
  const tasks = Array.from({ length: 8 }, (_, index) => ({ ...summary([]), id: `project-task-${index}`, conversationId: `chat-${index}`, title: `Task ${index}`, projectId: project.id }));
  const worker = { ...summary([]), id: 'project-worker', conversationId: 'worker-chat', projectId: project.id,
    origin: { kind: 'worker' as const, fromSessionId: tasks[0]!.id, agentId: 'worker-1', task: 'Inspect' } };
  const entries = [...tasks, worker];
  const { w, append } = await boot([], true, [], [project], { sessions: entries });
  const section = () => w.document.querySelector('.project-group')!;
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  let subagents = [...w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics')]
    .find(details => details.querySelector(':scope > summary')?.textContent?.includes('Sub-agent history'))!;
  expect(subagents.querySelector('[data-id="project-worker"]')).not.toBeNull();
  // A refresh can move the selected older task below the default five. Keep its complete
  // group visible without expanding every other old task or splitting off its child.
  entries.splice(0, entries.length, ...tasks.slice(1), tasks[0]!, worker);
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(6);
  expect(section().querySelector('[data-id="project-task-0"]')).not.toBeNull();
  subagents = [...w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics')]
    .find(details => details.querySelector(':scope > summary')?.textContent?.includes('Sub-agent history'))!;
  expect(subagents.querySelector('[data-id="project-worker"]')).not.toBeNull();
  (section().querySelector('.project-show-more') as HTMLButtonElement).click();
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(8);
  expect(section().querySelector('.project-show-more')).toBeNull();
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(8);
});
it('shows five project chats initially and reveals eight more per click', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Paged', path: '/paged', createdAt: 1 };
  const tasks = Array.from({ length: 22 }, (_, index) => ({ ...summary([]), id: `page-task-${index}`, conversationId: `chat-${index}`, projectId: project.id }));
  const { w, append } = await boot([], false, [], [project], { sessions: tasks });
  const section = () => w.document.querySelector('.project-group')!;
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  for (const count of [13, 21, 22]) {
    (section().querySelector('.project-show-more') as HTMLButtonElement).click();
    expect(section().querySelectorAll(':scope > .sess')).toHaveLength(count);
  }
  expect(section().querySelector('.project-show-more')).toBeNull();
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(22);
});

it('shows original user text while retaining transport instructions outside the visible bubble', async () => {
  const { w } = await boot([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'native-one', inputId: 'one', authoredText: 'hello', message: text('hello\n\nTransport-only control instruction') }]);
  expect(w.document.querySelector('.said.is-user .msg')?.textContent).toBe('hello');
  expect(w.document.body.textContent).toContain('hello');
});
it.each(['', '\n', '\n\n'])('hides complete worker instructions without an app receipt, including native prefix %j', async prefix => {
  const sent = prefix + prependUserPrompt('Visible authored message', 'Invisible complete guidance');
  const { w } = await boot([{ seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'echo', message: text(sent) }]);
  expect(w.document.querySelector('.said.is-user .msg')?.textContent).toBe('Visible authored message');
  expect(w.document.body.textContent).not.toContain('Invisible complete guidance');
});

it('appends dropped files to the originating composer draft and caps attachments', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const image = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'dropped.md', size: 12, mimeType: 'text/markdown' };
  api.dropFiles = vi.fn(async () => ({ ok: true, data: [image] }));
  const composer = w.document.getElementById('composer')!;
  const drop = (count: number) => {
    const event = new w.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: Array.from({ length: count }, () => new w.File(['image'], 'image.png', { type: 'image/png' })) } });
    composer.dispatchEvent(event);
    return event;
  };
  expect(drop(1).defaultPrevented).toBe(true);
  await settle();
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(1);
  expect(w.document.getElementById('composerImages')!.textContent).toContain('dropped.md');
  drop(20);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(1);
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(1);
});

it('removes a project group in one click, keeps its chats and draft, and rejects an older refresh', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Removed', path: '/removed', createdAt: 1 };
  const other = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Other', path: '/other', createdAt: 2 };
  const parent = { ...summary([]), projectId: project.id };
  const child = { ...summary([]), id: 'child-session', conversationId: 'child-chat', projectId: project.id,
    origin: { kind: 'worker' as const, fromSessionId: parent.id, agentId: 'worker-1', task: 'Keep working' } };
  const { w, live } = await boot([], false, [], [project, other], { sessions: [parent, child] });
  const api = (w as any).api;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep my separate unfiled draft'; input.dispatchEvent(new w.Event('input'));
  (w.document.querySelector(`[data-new-project="${project.id}"]`) as HTMLButtonElement).click();
  input.value = 'Keep my draft';
  let finishList!: (value: unknown) => void;
  api.listSessions = () => new Promise(resolve => { finishList = resolve; });
  (w.document.getElementById('chatRefresh') as HTMLButtonElement).click();
  await settle();
  api.removeProject = vi.fn(async () => ({ ok: true, data: { ...project, ungrouped: true } }));
  (w.document.querySelector('.project-remove') as HTMLButtonElement).click();
  await settle();
  expect(api.removeProject).toHaveBeenCalledExactlyOnceWith(project.id);
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).toBeNull();
  expect(w.document.querySelector(`[data-project-id="${other.id}"]`)).not.toBeNull();
  expect(w.document.querySelector(`#sessionList > [data-id="${parent.id}"]`)).not.toBeNull();
  const subagents = [...w.document.querySelectorAll<HTMLDetailsElement>('details.session-diagnostics')]
    .find(details => details.querySelector(':scope > summary')?.textContent?.includes('Sub-agent history'))!;
  expect(subagents.querySelector('[data-id="child-session"]')).not.toBeNull();
  expect(input.value).toBe('Keep my separate unfiled draft');
  expect(input.placeholder).toBe('Ask anything…');
  finishList({ ok: true, data: { sessions: [parent, child], activeId: null, pressure: [], blocked: [] } });
  await settle();
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).toBeNull();
  const recover = [...w.document.querySelectorAll<HTMLButtonElement>('#draftRecoveryStatus button')]
    .find(button => button.textContent === 'Open saved draft · Removed')!;
  expect(recover).toBeDefined(); recover.click(); await settle();
  expect(input.value).toBe('Keep my draft');
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: project.id, text: 'Keep my draft' });
  (w.document.getElementById('newChat') as HTMLButtonElement).click();
  expect(input.value).toBe('Keep my separate unfiled draft');
});

it('keeps the project visible when its removal fails', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Keep', path: '/keep', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  (w as any).api.removeProject = async () => ({ ok: false, error: 'Could not save' });
  (w.document.querySelector('.project-remove') as HTMLButtonElement).click();
  await settle();
  expect(w.document.querySelector('.project-group')).not.toBeNull();
  expect((w.document.querySelector('.project-remove') as HTMLButtonElement).disabled).toBe(false);
});

it('re-enables native Project Retry after an IPC failure', async () => {
  const project: LocalProject = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Retry me', path: '/retry', createdAt: 1,
    chatgpt: { state: 'failed', requestId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', error: 'Native creation failed', updatedAt: 2 } };
  const { w } = await boot([], false, [], [project]);
  const retryProject = vi.fn(async () => ({ ok: false, error: 'Bridge unavailable' }));
  (w as any).api.retryChatgptProject = retryProject;
  (w.document.querySelector('.project-heading button[title="Retry creating this project in ChatGPT"]') as HTMLButtonElement).click();
  await settle();
  expect(retryProject).toHaveBeenCalledExactlyOnceWith(project.id);
  const retry = w.document.querySelector('.project-heading button[title="Retry creating this project in ChatGPT"]') as HTMLButtonElement;
  expect(retry).not.toBeNull();
  expect(retry.disabled).toBe(false);
});

it.each([
  { paused: true, state: 'requested' as const, text: 'Native Project request saved · automation is paused' },
  { paused: false, state: 'creating' as const, text: 'Creating this project in ChatGPT…' }
])('shows truthful native Project input status while paused/armed ($state)', async ({ paused, state, text }) => {
  const project: LocalProject = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Native', path: '/native', createdAt: 1,
    chatgpt: state === 'creating'
      ? { state, requestId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', owner: 'page', updatedAt: 2 }
      : { state, requestId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', updatedAt: 2 } };
  const input: InputEntry = { id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', projectId: project.id, sessionId: null,
    conversationId: null, text: 'Start here', mode: 'auto', state: 'queued', owner: null,
    dueAt: 0, createdAt: 0, model: null, reasoningEffort: null };
  const { w } = await boot([], false, [], [project], { automationPaused: paused, inputs: [input] });
  (w.document.querySelector(`[data-new-project="${project.id}"]`) as HTMLButtonElement).click();
  (w.document.getElementById('chatRefresh') as HTMLButtonElement).click();
  await settle();
  expect(w.document.querySelector('.pending-message-status')?.textContent).toBe(text);
});

it('Share a folder creates a sidebar project and keeps it when an older list refresh finishes', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Shared', path: '/shared', createdAt: 1 };
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  let finishList!: (value: unknown) => void;
  api.listSessions = () => new Promise(resolve => { finishList = resolve; });
  (w.document.getElementById('chatRefresh') as HTMLButtonElement).click();
  await settle();
  api.addProject = vi.fn(async () => ({ ok: true, data: project }));
  api.addRoot = vi.fn();
  (w.document.getElementById('composerFolder') as HTMLButtonElement).click();
  await settle();
  expect(api.addProject).toHaveBeenCalledTimes(1);
  expect(api.addRoot).not.toHaveBeenCalled();
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).not.toBeNull();
  finishList({ ok: true, data: { sessions: [], activeId: null, pressure: [], blocked: [] } });
  await settle();
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).not.toBeNull();
  expect(input.placeholder).toContain('Shared');
  input.value = 'Work in this folder';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: project.id, text: 'Work in this folder' });
});

it('preserves the draft and refuses send while model discovery has no confirmed choices', async () => {
  const { w, live } = await boot([], false);
  const discover = vi.fn(async () => ({ ok: true, data: { state: 'unavailable', requestedAt: 1, observedAt: null, models: [] } }));
  (w as any).api.requestChatModels = discover;
  (w.document.getElementById('refreshComposerModels') as HTMLButtonElement).click();
  await settle();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this until a real model is selected';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(input.value).toBe('Keep this until a real model is selected');
  expect(live.sent).toHaveLength(0);
  expect(discover).toHaveBeenCalledTimes(2); // Manual Reload, then automatic discovery on Send.
  expect(w.document.body.textContent).toContain('Model discovery could not confirm your selection');
  expect(w.document.querySelector('.pending-message')).toBeNull();
});

it('cancelling Share a folder preserves the selected composer and creates no sidebar group', async () => {
  const { w } = await boot([], false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this draft';
  (w as any).api.addProject = vi.fn(async () => ({ ok: true, data: null }));
  (w.document.getElementById('composerFolder') as HTMLButtonElement).click();
  await settle();
  expect(input.value).toBe('Keep this draft');
  expect(w.document.querySelector('.project-group')).toBeNull();
});

it('groups project chats and starts an empty composer with the selected project identity', async () => {
  const projects = [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Alpha', path: '/alpha', createdAt: 1 }, { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Beta', path: '/beta', createdAt: 2 }];
  const { w, live, append } = await boot([], false, [], projects);
  const groups = w.document.querySelectorAll<HTMLDetailsElement>('.project-group');
  expect(groups).toHaveLength(2);
  expect(groups[0]!.querySelector('[data-id]')?.getAttribute('data-id')).toBe(summary([]).id);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const choose = (id: string) => (w.document.querySelector(`[data-new-project="${id}"]`) as HTMLButtonElement).click();
  choose(projects[0]!.id); input.value = 'Alpha draft';
  choose(projects[1]!.id); expect(input.value).toBe(''); input.value = 'Beta draft';
  (w.document.getElementById('newChat') as HTMLButtonElement).click();
  expect(input.value).toBe(''); input.value = 'Unfiled draft';
  choose(projects[0]!.id); expect(input.value).toBe('Alpha draft'); input.value = 'Alpha request';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: projects[0]!.id, text: 'Alpha request' });
  choose(projects[1]!.id); expect(input.value).toBe('Beta draft');
  const beta = w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!;
  beta.open = false; beta.dispatchEvent(new w.Event('toggle')); await append([]);
  expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!.open).toBe(false);
});

it('folds a whole Compact & Resume into one row that says the new chat opened', async () => {
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    toolCall(2, 'call-1'),
    ...compaction(3),
    toolCall(9, 'call-2')
  ]);
  const timeline = w.document.getElementById('timeline')!;

  const cards = timeline.querySelectorAll('details.compaction');
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.className).toContain('tone-good');
  expect(card.querySelector('summary')!.textContent).toMatch(/^Compact & Resume:New chat opened at .* \(44 characters\)$/);
  expect(card.querySelectorAll('summary .step')).toHaveLength(0);

  // The rows the card replaces are gone from the list; nothing else is.
  expect(timeline.querySelector('.ev-handoff')).toBeNull();
  expect(timeline.textContent).not.toContain('[[CLF-');
  expect(timeline.querySelectorAll('.ev-turn_start, .ev-turn_end')).toHaveLength(0);
  expect(timeline.querySelectorAll('.ev-tool_call')).toHaveLength(2);
  // The card sits where the compaction happened, between the two calls.
  const order = [...timeline.children].map((row) => row.className);
  expect(order).toEqual(['ev ev-tool_call', 'ev ev-compaction', 'ev ev-tool_call']);

  // Everything is still there for whoever unfolds the card.
  card.toggleAttribute('open', true);
  expect(card.textContent).toContain('Brief request');
  expect(card.textContent).toContain('keep the loop running');
  expect(card.textContent).toContain('Handoff saved');
  expect(card.textContent).toContain('Bootstrap sent into the new chat');
});

it('starts in New Chat despite active history and selects only the exact acknowledged send', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'A new request';
  (w.document.getElementById('chatAutomation') as HTMLSelectElement).value = 'loop';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, text: 'A new request', automation: 'loop' });
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')?.getAttribute('data-id')).toBe(summary([]).id);
});

it('selects an acknowledged New Chat while recording notifications keep arriving', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'Streaming request';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  const timer = setInterval(app.notifySession, 30);
  try {
    await vi.waitFor(() => expect(w.document.querySelector('#sessionList .is-sel')?.getAttribute('data-id')).toBe(summary([]).id), { timeout: 2000 });
  } finally { clearInterval(timer); }
});

it.each(['composer', 'bubble'])('preserves New Chat drafts and removes a delivery explicitly cancelled with %s', async (control) => {
  const app = await boot([], false);
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Old attempt';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Old attempt');
  live.inputs[0] = { ...live.inputs[0]!, state: 'browser', requiresAuthorization: true };
  input.value = 'Keep this unsent draft';
  w.document.getElementById('newChat')!.click();
  await app.append([]);
  expect(input.value).toBe('Keep this unsent draft');
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Old attempt');
  expect(live.inputs[0]!.state).toBe('browser'); // Navigation does not cancel a claimed delivery; the explicit pre-Send cancel below does.
  const cancel = vi.fn(async (id: string) => { live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' as const, error: 'Not sent: this delivery was cancelled before Send was authorized.' } : row); return { ok: true, data: true }; });
  (w as any).api.cancelInput = cancel;
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Send message');
  // Clearing authored text is an explicit user action; navigation never does it.
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Cancel delivery');
  if (control === 'composer') w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  else (w.document.querySelector('#inputQueue [title="Cancel delivery"]') as HTMLButtonElement).click();
  await settle();
  expect(cancel).toHaveBeenCalledWith(live.inputs[0]!.id);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
  input.value = 'Fresh attempt';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Fresh attempt');
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
});

it.each(['composer', 'bubble'])('keeps an ambiguous authorized-send notice visible after cancelling with %s', async (control) => {
  const app = await boot([], false);
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Possibly submitted request';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  live.inputs[0] = { ...live.inputs[0]!, state: 'browser', owner: 'authorized-page', requiresAuthorization: true, sendAuthorizedAt: Date.now() };
  await app.append([]);
  const cancel = vi.fn(async (id: string) => {
    live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' as const,
      error: 'Cancelled locally. Delivery to ChatGPT is unconfirmed; the message may already have been sent.' } : row);
    return { ok: true, data: true };
  });
  (w as any).api.cancelInput = cancel;
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Cancel delivery');
  if (control === 'composer') w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  else (w.document.querySelector('#inputQueue [title="Cancel delivery"]') as HTMLButtonElement).click();
  await settle();
  expect(cancel).toHaveBeenCalledWith(live.inputs[0]!.id);
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('Possibly submitted request');
  expect(queue.textContent).toContain('may already have been sent');
  expect(queue.querySelector('[title="Dismiss delivery notice"]')).not.toBeNull();
  expect(queue.querySelector('[aria-label="Retry delivery"]')).toBeNull();
});

it.each(['composer', 'bubble'])('keeps an ambiguous cancellation visible when Send authorization wins during %s cancel', async (control) => {
  const app = await boot([], false);
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Racing Send authorization';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  live.inputs[0] = { ...live.inputs[0]!, state: 'browser', owner: 'claim-before-send', requiresAuthorization: true, sendAuthorizedAt: undefined };
  await app.append([]);
  const cancel = vi.fn(async (id: string) => {
    live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' as const, sendAuthorizedAt: Date.now(),
      error: 'Cancelled locally. Delivery to ChatGPT is unconfirmed; the message may already have been sent.' } : row);
    return { ok: true, data: true };
  });
  (w as any).api.cancelInput = cancel;

  if (control === 'composer') w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  else (w.document.querySelector('#inputQueue [title="Cancel delivery"]') as HTMLButtonElement).click();
  await settle();

  expect(cancel).toHaveBeenCalledWith(live.inputs[0]!.id);
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('Racing Send authorization');
  expect(queue.textContent).toContain('may already have been sent');
  expect(queue.querySelector('[title="Dismiss delivery notice"]')).not.toBeNull();
  expect(queue.querySelector('[aria-label="Retry delivery"]')).toBeNull();
});

it.each([
  { label: 'durable stale-state rejection', reply: { ok: true as const, data: false }, disabled: true },
  { label: 'IPC failure', reply: { ok: false as const, error: 'The durable cancel could not be saved.' }, disabled: false }
])('keeps selected-chat Cancel $label fenced correctly while refresh is unavailable', async ({ reply, disabled }) => {
  const app = await boot([], false);
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Cancel control authority test';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  live.inputs[0] = { ...live.inputs[0]!, state: 'browser', owner: 'cancel-authority-page', requiresAuthorization: true };
  await app.append([]);
  const cancel = vi.fn(async () => reply);
  (w as any).api.cancelInput = cancel;
  (w as any).api.listInputs = () => new Promise(() => {});
  const button = w.document.querySelector<HTMLButtonElement>('#inputQueue [title="Cancel delivery"]')!;

  button.click();
  await settle();

  expect(cancel).toHaveBeenCalledWith(live.inputs[0]!.id);
  expect(button.disabled).toBe(disabled);
});

it.each([
  { label: 'durable stale-state result', reply: { ok: true as const, data: null }, disabled: true },
  { label: 'IPC failure', reply: { ok: false as const, error: 'The browser retry could not start.' }, disabled: false }
])('keeps selected-chat Retry browser $label fenced correctly while refresh is unavailable', async ({ reply, disabled }) => {
  const app = await boot([]);
  const { w, live, append } = app;
  live.inputs.push({
    id: 'selected-retry-failure', sessionId: summary([]).id, text: 'Retry authority test', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'queued', owner: null, createdAt: 1, conversationId: 'chat-b'
  });
  await append([]);
  const retryApi = vi.fn(async () => reply);
  (w as any).api.retryInputBrowser = retryApi;
  (w as any).api.listInputs = () => new Promise(() => {});
  const retry = w.document.querySelector<HTMLButtonElement>('#inputQueue [aria-label="Retry browser"]')!;

  retry.click();
  await settle();

  expect(retryApi).toHaveBeenCalledWith('selected-retry-failure');
  expect(retry.disabled).toBe(disabled);
});

it.each([undefined, 'native-late-confirmed'] as const)('does not offer Retry delivery after a late exact ACK confirms a cancelled browser send (messageId=%s)', async messageId => {
  const app = await boot([]);
  const { w, live } = app;
  live.inputs.push({
    id: 'late-confirmed-cancel', sessionId: summary([]).id, text: 'Confirmed after cancellation', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'cancelled', owner: 'authorized-page', createdAt: 1,
    conversationId: 'chat-b', ...(messageId ? { messageId } : {}), deliveredAt: Date.now(), historyRecorded: !!messageId,
    error: 'Cancelled locally; delivery was later confirmed in ChatGPT.'
  });
  await app.append([]);
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('Confirmed after cancellation');
  expect(queue.textContent).toContain('delivery was later confirmed in ChatGPT');
  expect(queue.querySelector('[title="Dismiss delivery notice"]')).not.toBeNull();
  expect(queue.querySelector('[aria-label="Retry delivery"]')).toBeNull();
});

it.each([
  { label: 'Send authorization', evidence: { sendAuthorizedAt: 2 } },
  { label: 'delivery receipt', evidence: { deliveredAt: 3 } },
  { label: 'native message identity', evidence: { messageId: 'native-post-send' } },
  { label: 'post-Send ambiguity', evidence: { error: 'Delivery confirmation timed out. The message may already have reached ChatGPT.' } }
])('keeps a failed row with $label presentation-only', async ({ evidence }) => {
  const app = await boot([]);
  app.live.inputs.push({
    id: `failed-${Object.keys(evidence)[0]}`, sessionId: summary([]).id, text: 'Do not duplicate this message', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'failed', owner: null, createdAt: 1,
    conversationId: 'chat-b', requiresAuthorization: true, preSendReoffers: 3, error: 'Browser delivery failed', ...evidence
  });
  await app.append([]);
  const queue = app.w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('Do not duplicate this message');
  expect(queue.querySelector('[aria-label="Dismiss delivery notice"]')).not.toBeNull();
  expect(queue.querySelector('[aria-label="Retry delivery"]')).toBeNull();
});

it('offers Retry delivery only for a positively pre-Send failed row', async () => {
  const app = await boot([]);
  app.live.inputs.push({
    id: 'confirmed-pre-send-failure', sessionId: summary([]).id, text: 'Safe message to review', mode: 'auto', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'failed', owner: null, createdAt: 1,
    conversationId: 'chat-b', requiresAuthorization: true, preSendReoffers: 3,
    error: 'The model picker could not be confirmed before native Send.'
  });
  await app.append([]);
  const retry = app.w.document.querySelector<HTMLButtonElement>('#inputQueue [aria-label="Retry delivery"]')!;
  expect(retry).not.toBeNull();
  retry.click(); await settle();
  expect((app.w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('Safe message to review');
  expect(app.live.sent).toHaveLength(0);
});

it.each([false, true])('dismisses ambiguous retired delivery errors in selected-chat=%s without resending', async selected => {
  const app = await boot([], selected);
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const submit = () => w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  input.value = 'Expired request'; submit(); await settle();
  live.inputs[0] = { ...live.inputs[0]!, state: 'cancelled', error: 'Delivery confirmation timed out. The message may already have reached ChatGPT.' };
  if (!selected) w.document.getElementById('newChat')!.click();
  await app.append([]);
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('Expired request');
  expect(queue.textContent).toContain('may already have reached ChatGPT');
  expect(queue.querySelector('[aria-label="Retry delivery"]')).toBeNull();
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).not.toBe('Cancel delivery');
  (queue.querySelector('[title="Dismiss delivery notice"]') as HTMLButtonElement).click();
  await app.append([]);
  expect(queue.textContent).not.toContain('Expired request');
  input.value = 'Fresh request'; submit(); await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'Fresh request' });
  expect(queue.textContent).not.toContain('Expired request');
});

it('does not steal a newer New Chat draft when an older queued send is acknowledged', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'First request';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  w.document.getElementById('newChat')!.click();
  input.value = 'Newer unsent draft';
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  expect(input.value).toBe('Newer unsent draft');
  w.document.getElementById('newChat')!.click();
  input.value = '';
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
});

it.each(['stopped', 'failed'] as const)('shows the exact summary turn %s instead of writing, then updates the same card on recovery', async outcome => {
  const [request, start, brief, end, handoff, resume] = compaction(2);
  const app = await boot([request!, start!, { ...brief!, final: false, state: 'streaming' } as SessionEvent]);
  const card = app.w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  const state = () => card.querySelector('summary .state')!.textContent;
  expect(state()).toBe('ChatGPT is writing the summary…');
  await app.append([{ ...end!, outcome, detail: outcome === 'failed' ? 'Provider request limit' : undefined } as SessionEvent]);
  expect(state()).toBe(outcome === 'stopped' ? 'Summary generation stopped' : 'Summary generation failed — Provider request limit');
  expect(card.className).toContain('tone-bad');
  await app.append([{ ...handoff!, seq: 9, time: T0 + 9000 }]);
  expect(state()).toContain('Summary saved');
  expect(card.className).toContain('tone-wait');
  await app.append([{ ...resume!, seq: 10, time: T0 + 10000 }]);
  expect(app.w.document.querySelector('details.compaction')).toBe(card);
  expect(state()).toContain('New chat opened');
  expect(card.className).toContain('tone-good');
});

it('keeps a stopped empty summary truthful without adopting another turn or its completed outcome', async () => {
  const [request, start, , end] = compaction(2);
  const app = await boot([request!, start!, { ...end!, outcome: 'stopped' } as SessionEvent]);
  await app.append([
    { seq: 10, time: T0 + 10000, source: 'extension', kind: 'turn_start', turnId: 'other' },
    { seq: 11, time: T0 + 11000, source: 'extension', kind: 'turn_end', turnId: 'other', outcome: 'completed' }
  ]);
  expect(app.w.document.querySelector('details.compaction summary .state')!.textContent).toBe('Summary generation stopped');
});

it('a committed resume supersedes an older abandonment on the same compaction', async () => {
  const [request, start, , end, , resume] = compaction(2);
  const app = await boot([request!, start!, { ...end!, outcome: 'failed' } as SessionEvent,
    { seq: 8, time: T0 + 8000, source: 'app', kind: 'note', continuation: TOKEN, message: text('Compact & Resume abandoned — earlier failure') }]);
  await app.append([{ ...resume!, seq: 9, time: T0 + 9000 }]);
  expect(app.w.document.querySelector('details.compaction summary .state')!.textContent).toContain('New chat opened');
});

it('does not infer compaction failure from a later tool call while the handoff is being saved', async () => {
  const [request, start, brief, end] = compaction(2);
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request!,
    start!,
    brief!,
    end!
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const state = () => timeline.querySelector('details.compaction summary .state')!.textContent;
  // Still the newest thing recorded: the summary is written, the app is saving it.
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-wait');

  // A late call does not settle the continuation transaction.
  await append([toolCall(9, 'call-late')]);
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-wait');
});

it('keeps one live compaction across refused source calls and unrelated old-turn commentary', async () => {
  const [request, start, brief, end, handoff, resume] = compaction(2);
  const app = await boot([request!, start!]);
  const card = app.w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  const state = () => card.querySelector('summary .state')!.textContent;
  const late = toolCall(4, 'late-source-call') as Extract<SessionEvent, { kind: 'tool_call' }>;
  late.call.outcome = 'tool_rejected';
  late.call.result = text('COMPACTION_IN_PROGRESS: no local tool was run.');
  await app.append([late, { seq: 5, time: T0 + 5000, source: 'extension', kind: 'assistant_message',
    messageId: 'old-commentary', turnId: 'old-turn', final: false, message: text('Still reading the old task.') }]);
  expect(state()).toBe('Summary requested — waiting for ChatGPT…');
  expect(card.className).toContain('tone-wait');
  expect(card.textContent).not.toContain('Still reading the old task.');
  expect(app.w.document.querySelector('.ev-assistant_message')!.textContent).toContain('Still reading the old task.');
  await app.append([{ ...brief!, seq: 6, time: T0 + 6000 }, { ...end!, seq: 7, time: T0 + 7000 }]);
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(card.textContent).toContain('Goal: keep the loop running.');
  await app.append([{ ...handoff!, seq: 8, time: T0 + 8000 }, toolCall(9, 'late-recording')]);
  expect(state()).toContain('opening the new chat');
  await app.append([{ ...resume!, seq: 10, time: T0 + 10000 }]);
  expect(app.w.document.querySelector('details.compaction')).toBe(card);
  expect(app.w.document.querySelectorAll('details.compaction')).toHaveLength(1);
  expect(card.className).toContain('tone-good');
});

/**
 * The shape the live recorder actually writes. The brief request is typed by the app, so its
 * row carries no local turn id; the turn ChatGPT answers it in opens right after it. Folding by
 * the request's own turn id left the start, the brief, the end and the handoff loose under an
 * empty card — twenty rows for one compaction.
 */
it('folds the answer turn into the card when the request row has no turn id', async () => {
  const [request, start, brief, end, handoff, resume] = compaction(2) as [
    SessionEvent, SessionEvent, SessionEvent, SessionEvent, SessionEvent, SessionEvent
  ];
  delete (request as { turnId?: string }).turnId;
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request,
    start,
    brief,
    end,
    handoff,
    { seq: 8, time: T0 + 8000, source: 'extension', kind: 'turn_start', turnId: 'turn-next' },
    resume
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const order = [...timeline.children].map((row) => row.className);
  expect(order).toEqual(['ev ev-compaction']);
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-good');
});

it('says why a compaction died when the app abandoned it', async () => {
  const [request, start, brief, end] = compaction(2);
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request!,
    start!,
    brief!,
    end!,
    {
      seq: 7,
      time: T0 + 7000,
      source: 'app',
      kind: 'note',
      continuation: TOKEN,
      message: text('Compact & Resume abandoned — the handover never landed and was given up on')
    },
    toolCall(8, 'call-after')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const card = timeline.querySelector('details.compaction')!;
  expect(card.className).toContain('tone-bad');
  expect(card.querySelector('summary .state')!.textContent).toBe('Failed — the handover never landed and was given up on');
  // The note is the card's, not a loose row of its own.
  expect(timeline.querySelectorAll('.ev-note')).toHaveLength(0);
  card.toggleAttribute('open', true);
  expect(card.textContent).toContain('abandoned');
});

it('retains the open compaction disclosure and brief request while the summary streams and completes', async () => {
  const [request, start, original, , handoff, resume] = compaction(2);
  const brief = { ...original, origin: original!.seq, state: 'streaming', final: false } as Extract<SessionEvent, { kind: 'assistant_message' }>;
  const { w, append } = await boot([request!, start!, brief]);
  const card = w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  card.open = true;
  card.dispatchEvent(new w.Event('toggle'));
  const requestText = card.querySelector('.pre')!;
  const head = card.querySelector('summary')!;
  head.focus();
  for (let i = 0; i < 3; i++) {
    await append([{ ...brief, seq: 20 + i, message: text('# Brief\n\n' + 'More summary text. '.repeat(i + 2)), final: i === 2, state: i === 2 ? 'final' : 'streaming' }]);
    expect(w.document.querySelector('details.compaction')).toBe(card);
    expect(card.open).toBe(true);
    expect(card.querySelector('.pre')).toBe(requestText);
    expect(w.document.activeElement).toBe(head);
    expect(card.querySelector('.rich')!.textContent).toContain('More summary text.');
  }
  expect(card.querySelector('summary .state')!.textContent).toBe('Summary written — saving the handoff…');
  await append([{ ...handoff!, seq: 23 }, { ...resume!, seq: 24 }]);
  expect(w.document.querySelector('details.compaction')).toBe(card);
  expect(card.className).toContain('tone-good');
  card.open = false;
  card.dispatchEvent(new w.Event('toggle'));
  await append([toolCall(25, 'after-resume')]);
  expect(card.open).toBe(false);
});

it('keeps a streaming message anchor and its following tool group across canonical revisions', async () => {
  const message: Extract<SessionEvent, { kind: 'assistant_message' }> = { seq: 1, origin: 1, time: T0, source: 'extension',
    kind: 'assistant_message', messageId: 'live-message', message: text('Working'), state: 'streaming', final: false };
  const { w, append } = await boot([message, toolCall(2, 'live-tool'), toolCall(3, 'next-tool')]);
  const timeline = w.document.getElementById('timeline')!;
  const anchor = timeline.querySelector<HTMLElement>('.ev-assistant_message')!.dataset.timelineKey;
  const group = timeline.querySelector<HTMLDetailsElement>('.tool-group')!;
  group.open = true;
  group.dispatchEvent(new w.Event('toggle'));
  await append([{ ...message, seq: 4, message: text('Working on the next step') }]);
  expect(timeline.querySelector<HTMLElement>('.ev-assistant_message')!.dataset.timelineKey).toBe(anchor);
  expect(timeline.querySelector('.tool-group')).toBe(group);
  expect(group.open).toBe(true);
});

it('keeps an unfolded tool row as the same open node while the chat keeps appending', async () => {
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    toolCall(2, 'call-1')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const before = timeline.querySelector('.ev-tool_call details.tool') as HTMLDetailsElement;
  expect(before.open).toBe(false);
  before.open = true;
  before.dispatchEvent(new w.Event('toggle'));

  await append([toolCall(3, 'call-2'), toolCall(4, 'call-3')]);
  const rows = timeline.querySelectorAll('.ev-tool_call');
  expect(rows).toHaveLength(3);
  const after = rows[0]!.querySelector('details.tool') as HTMLDetailsElement;
  // Not rebuilt: the very node the user unfolded, still unfolded.
  expect(after).toBe(before);
  expect(after.open).toBe(true);
  const group = timeline.querySelector('details.tool-group') as HTMLDetailsElement;
  expect(group.open).toBe(true);
  group.open = false;
  group.dispatchEvent(new w.Event('toggle'));
  const detached: Node[] = [];
  const observer = new w.MutationObserver(records => records.forEach(record => detached.push(...record.removedNodes)));
  observer.observe(timeline, { childList: true, subtree: true });
  await append([toolCall(5, 'call-4')]);
  observer.disconnect();
  expect(detached.some(node => node === group || node === before || (node as Element).contains?.(before))).toBe(false);
  expect(timeline.querySelector('details.tool-group')).toBe(group);
  expect(group.open).toBe(false);
  expect(group.querySelector('summary')!.textContent).toBe('Read README.md');
  expect(group.querySelector('summary')!.title).toContain('4 actions');
});

it('keeps mixed tool and agent activity in one latest-action disclosure between authored messages', async () => {
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'progress', message: text('Checking the implementation') },
    toolCall(2, 'first'),
    { seq: 3, time: T0 + 3000, source: 'app', kind: 'agent_message', messageId: 'agent-update', from: 'worker-2', to: 'prime', delivery: 'delivered', message: text('Found the root cause') },
    toolCall(4, 'last')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const group = timeline.querySelector<HTMLDetailsElement>('.tool-group')!;
  expect(group.open).toBe(false);
  expect(group.querySelector('.activity-title')!.textContent).toBe('Read README.md');
  expect(group.querySelector('.agent-communication summary')!.textContent).toContain('Message from worker-2');
  expect(group.querySelector('.agent-avatar')).not.toBeNull();
  expect(group.querySelectorAll('.ev')).toHaveLength(3);
  await append([
    { seq: 5, time: T0 + 5000, source: 'extension', kind: 'progress', message: text('Now validating') },
    toolCall(6, 'next'), toolCall(7, 'next-2')
  ]);
  expect(timeline.querySelectorAll('.tool-group')).toHaveLength(2);
  expect(timeline.children[0]!.className).toContain('ev-progress');
});

it('names an activity group after its latest real action rather than a page note around it', async () => {
  const note = (seq: number, label: string): SessionEvent => ({ seq, time: T0 + seq * 1000, source: 'extension', kind: 'page_tool', messageId: `note-${seq}`, label });
  const { w } = await boot([note(1, 'Planning the check'), toolCall(2, 'call-a'), toolCall(3, 'call-b'), note(4, 'Executed exact command check')]);
  const group = w.document.querySelector<HTMLDetailsElement>('#timeline details.tool-group')!;
  const lastTool = [...w.document.querySelectorAll<HTMLElement>('#timeline .ev-tool_call')].at(-1)!;
  const title = lastTool.querySelector('.tool > summary b')?.textContent ?? lastTool.querySelector('.tool > summary span')?.textContent;
  expect(title).toBeTruthy();
  expect(group.querySelector('.activity-title')!.textContent).toBe(title);
  expect(group.querySelector('.activity-title')!.textContent).not.toBe('Executed exact command check');
});

it('uses a native closing recap as the completed activity title while preserving its open tools and focus', async () => {
  const note = (seq: number, label: string): SessionEvent => ({ seq, time: T0 + seq * 1000, source: 'extension',
    kind: 'page_tool', messageId: `round-note-${seq}`, label });
  const { w, append } = await boot([
    note(1, 'Planning the command check'), toolCall(2, 'checked-readme'),
    toolCall(3, 'checked-command'), note(4, 'Executed exact command check')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const group = timeline.querySelector<HTMLDetailsElement>('details.tool-group')!;
  const summary = group.querySelector<HTMLElement>('summary')!;
  const firstTool = group.querySelector<HTMLElement>('.ev-tool_call')!;
  expect(group.querySelector('.activity-title')!.textContent).not.toBe('Executed exact command check');
  group.open = true;
  group.dispatchEvent(new w.Event('toggle'));
  summary.focus();
  await append([{
    seq: 5, time: T0 + 5000, source: 'extension', kind: 'turn_end', outcome: 'completed'
  }]);
  // A completed turn signal alone does not prove a canonical assistant final.
  expect(group.querySelector('.activity-title')!.textContent).not.toBe('Executed exact command check');
  await append([{
    seq: 6, time: T0 + 6000, source: 'extension', kind: 'assistant_message',
    messageId: 'closed-round-final', final: true, state: 'final', message: text('The command check is complete.')
  }]);
  expect(timeline.querySelector('details.tool-group')).toBe(group);
  expect(group.open).toBe(true);
  expect(w.document.activeElement).toBe(summary);
  expect(group.querySelector('.activity-title')!.textContent).toBe('Executed exact command check');
  expect(summary.getAttribute('aria-label')).toContain('Completed');
  expect(summary.title).toContain('3 actions');
  expect(group.querySelector('.ev-tool_call')).toBe(firstTool);
  expect(group.querySelectorAll('.ev-tool_call')).toHaveLength(2);
  expect(group.querySelector('.ev-page_tool[data-event-seq="4"]')).toBeNull();
  expect(group.querySelector('.ev-page_tool[data-event-seq="1"]')).not.toBeNull();
  expect(timeline.textContent).toContain('The command check is complete.');
});

it('does not promote a failed native page note when an unrelated later turn completes', async () => {
  const { w, append } = await boot([
    toolCall(2, 'failed-round-call'),
    { seq: 3, time: T0 + 3000, source: 'extension', kind: 'page_tool', messageId: 'not-a-recap',
      label: 'Checking the command', turnId: 'first-turn' },
    { seq: 4, time: T0 + 4000, source: 'extension', kind: 'turn_end', outcome: 'failed', turnId: 'first-turn' }
  ]);
  const group = w.document.querySelector<HTMLDetailsElement>('#timeline .tool-group')!;
  const originalTitle = group.querySelector('.activity-title')!.textContent;
  expect(originalTitle).not.toBe('Checking the command');
  await append([
    { seq: 5, time: T0 + 5000, source: 'extension', kind: 'user_message', messageId: 'next-question',
      turnId: 'second-turn', message: text('Try a different test') },
    { seq: 6, time: T0 + 6000, source: 'extension', kind: 'assistant_message', messageId: 'next-final',
      turnId: 'second-turn', final: true, message: text('The unrelated test completed.') }
  ]);
  expect(w.document.querySelector('#timeline .tool-group')).toBe(group);
  expect(group.querySelector('.activity-title')!.textContent).toBe(originalTitle);
  expect(group.querySelector<HTMLElement>('.ev-page_tool')!.hidden).toBe(false);
  expect(group.querySelector('summary')!.getAttribute('aria-label')).toBeNull();
});

it('controls the selected session without submitting another user message', async () => {
  const { w, live } = await boot([]);
  const mode = w.document.getElementById('chatAutomation') as HTMLSelectElement;
  mode.value = 'loop'; mode.dispatchEvent(new w.Event('change'));
  await settle();
  expect(live.controlCalls).toEqual([{ id: summary([]).id, action: 'loop' }]);
  expect(live.sent).toEqual([]);
  w.document.getElementById('compactSession')!.click(); await settle();
  expect(live.controlCalls.at(-1)).toEqual({ id: summary([]).id, action: 'compact' });
  expect((w.document.getElementById('compactSession') as HTMLButtonElement).disabled).toBe(true);
  expect((w.document.getElementById('cancelCompaction') as HTMLElement).hidden).toBe(false);
  w.document.getElementById('cancelCompaction')!.click(); await settle();
  expect(live.controlCalls.at(-1)).toEqual({ id: summary([]).id, action: 'cancel' });
  w.document.getElementById('newChat')!.click(); await settle();
  expect((w.document.getElementById('sessionControls') as HTMLElement).hidden).toBe(false);
});

it('keeps Cancel available for a failed retained compaction without showing it as running or sending a message', async () => {
  const error = 'The exact Core app was unavailable; the handoff is retained.';
  const { w, live } = await boot([], true, [], [], { controls: { activeTurnId: null, finishHeld: false,
    job: { token: 'renderer-failed-handoff', stage: 'failed', busy: false, cancellable: true, error } } });
  expect((w.document.getElementById('compactSession') as HTMLButtonElement).disabled).toBe(true);
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(false);
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toBe(error);
  w.document.getElementById('cancelCompaction')!.click(); await settle();
  expect(live.controlCalls).toEqual([{ id: summary([]).id, action: 'cancel' }]);
  expect(live.cancelTokens).toEqual(['renderer-failed-handoff']);
  expect(live.sent).toEqual([]);
});

it('sends the rendered Cancel token rather than a newer unpainted handoff token', async () => {
  const controls = { job: { token: 'renderer-shown-a', stage: 'failed', busy: false, cancellable: true, error: 'Retained A' } };
  const { w, live } = await boot([], true, [], [], { controls });
  controls.job = { ...controls.job, token: 'renderer-new-b', error: 'Retained B' };
  w.document.getElementById('cancelCompaction')!.click(); await settle();
  expect(live.cancelTokens).toEqual(['renderer-shown-a']);
  expect(live.sent).toEqual([]);
});

it('hides Cancel when the authoritative compaction owner has crossed its commit boundary', async () => {
  const { w } = await boot([], true, [], [], { controls: {
    job: { stage: 'opening', busy: true, cancellable: false, error: null } } });
  expect((w.document.getElementById('compactSession') as HTMLButtonElement).disabled).toBe(true);
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
});

it('offers deliberate helper retry only for the selected source session', async () => {
  const sourceSessionId = summary([]).id;
  const { w, live } = await boot([], true, [
    { id: 'paused-selected-old', sourceSessionId },
    { id: 'paused-selected-new', sourceSessionId },
    { id: 'paused-other', sourceSessionId: 'another-session' }
  ]);
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('2 old helper owners were collapsed behind this one exact saved turn');
  expect(queue.textContent).toContain('No message will be replayed');
  expect(queue.querySelectorAll('button')).toHaveLength(2);
  expect(live.controlCalls).toEqual([]);
  ([...queue.querySelectorAll('button')].find(button => button.textContent?.includes('Restart helper')) as HTMLButtonElement).click();
  await settle();
  expect(live.controlCalls).toEqual([{ id: sourceSessionId, action: 'retry:paused-selected-new' }]);
  expect(queue.querySelectorAll('button')).toHaveLength(0);
});

it.each(['Restart helper', 'Resume this chat'])('refuses a lingering %s card after selecting another chat', async label => {
  const first = summary([]), second = { ...first, id: 'second-helper-source', conversationId: 'second-helper-conversation', title: 'Second helper source' };
  const { w, live } = await boot([], true, [{ id: 'old-selected-helper', sourceSessionId: first.id }], [], { sessions: [first, second] });
  const api = (w as any).api;
  let release!: (value: unknown) => void;
  api.listPausedHelpers = () => new Promise(resolve => { release = resolve; });
  const oldButton = [...w.document.querySelectorAll<HTMLButtonElement>('#inputQueue button')].find(button => button.textContent?.includes(label))!;
  expect(oldButton.isConnected).toBe(true);
  (w.document.querySelector('#sessionList [data-id="second-helper-source"]') as HTMLElement).click();
  expect(oldButton.isConnected).toBe(true); // Old queue stays visible while the new owner refresh is pending.
  oldButton.click();
  expect(live.controlCalls).toEqual([]);
  await settle(); release?.({ ok: true, data: [] }); await settle();
  expect(live.controlCalls).toEqual([]);
  expect(live.sent).toEqual([]);
});

it('resumes only the selected saved helper obligation instead of waking every chat', async () => {
  const sourceSessionId = summary([]).id;
  const { w, live } = await boot([], true, [
    { id: 'paused-selected', sourceSessionId },
    { id: 'paused-other', sourceSessionId: 'another-session' }
  ]);
  const queue = w.document.getElementById('inputQueue')!;
  const resume = [...queue.querySelectorAll('button')].find(button => button.textContent?.includes('Resume this chat')) as HTMLButtonElement;
  expect(resume).toBeTruthy();
  resume.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: sourceSessionId, action: 'resume-one' });
  expect(live.controlCalls).not.toContainEqual({ id: '*', action: 'resume-all' });
});

it.each([
  { label: 'Restart helper', retainedHelper: true },
  { label: 'Resume this chat', retainedHelper: true },
  { label: 'Restart helper', retainedHelper: false }
])('unlocks selected $label after a raw IPC rejection without replay or a private-error leak (retained=$retainedHelper)', async ({ label, retainedHelper }) => {
  const sourceSessionId = summary([]).id;
  const { w, live } = await boot([], true, retainedHelper ? [{ id: 'selected-rejected-helper', sourceSessionId }] : [], [],
    retainedHelper ? {} : { controls: { goalDraft: { stage: 'failed', error: 'goal_browser_helper_exhausted', message: 'Exact helper attempts exhausted.' } } });
  const api = (w as any).api;
  const reject = vi.fn(async () => { throw new Error('PRIVATE_RECOVERY_TRANSPORT'); });
  api.retryHelper = reject;
  api.resumeAutomationChat = reject;
  api.listPausedHelpers = () => new Promise(() => {});
  const button = [...w.document.querySelectorAll<HTMLButtonElement>('#inputQueue button')].find(row => row.textContent?.includes(label))!;
  const action = button.onclick!(new w.PointerEvent('click')) as unknown as Promise<void>;
  expect(button.disabled).toBe(true);
  await expect(action).resolves.toBeUndefined();
  expect(button.disabled).toBe(false);
  expect(w.document.querySelector('.toast')?.textContent).toContain('Saved work is unchanged');
  expect(w.document.body.textContent).not.toContain('PRIVATE_RECOVERY_TRANSPORT');
  expect(reject).toHaveBeenCalledTimes(1);
  expect(live.sent).toEqual([]);
  expect(live.controlCalls).toEqual([]);
});

it.each(['Restart helper', 'Resume this chat'])('explains the account-wide pause instead of claiming per-chat %s succeeded with zero recovery', async label => {
  const sourceSessionId = summary([]).id;
  const { w, live } = await boot([], true, [{ id: 'selected-paused-helper', sourceSessionId }], [], { automationPaused: true });
  const api = (w as any).api;
  const resume = vi.fn(async () => ({ ok: true, data: { eligible: 0, queued: 0, alreadyActive: 0, recovering: 0, rearmed: 0, skipped: 0 } }));
  const retry = vi.fn(async () => ({ ok: true, data: true }));
  api.resumeAutomationChat = resume;
  api.retryHelper = retry;
  api.listPausedHelpers = () => new Promise(() => {});
  const button = [...w.document.querySelectorAll<HTMLButtonElement>('#inputQueue button')].find(row => row.textContent?.includes(label))!;
  await button.onclick!(new w.PointerEvent('click'));
  expect(w.document.querySelector('.toast')?.textContent).toContain('Automation is paused for this account');
  expect(w.document.querySelector('.toast')?.textContent).not.toContain('Exact chat recovery:');
  expect(button.disabled).toBe(false);
  expect(resume).not.toHaveBeenCalled();
  expect(retry).not.toHaveBeenCalled();
  expect(live.controlCalls).toEqual([]);
  expect(live.sent).toEqual([]);
});

it.each(['Restart helper', 'Resume this chat'])('does not let a rejected old %s request toast or unlock a different chat', async label => {
  const first = summary([]), second = { ...first, id: 'rejected-recovery-second', conversationId: 'rejected-recovery-chat', title: 'Second recovery owner' };
  const { w, live } = await boot([], true, [{ id: 'selected-rejected-helper', sourceSessionId: first.id }], [], { sessions: [first, second] });
  const api = (w as any).api;
  let reject!: (error: Error) => void;
  const pending = vi.fn(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  api.retryHelper = pending;
  api.resumeAutomationChat = pending;
  api.listPausedHelpers = () => new Promise(() => {});
  const button = [...w.document.querySelectorAll<HTMLButtonElement>('#inputQueue button')].find(row => row.textContent?.includes(label))!;
  const action = button.onclick!(new w.PointerEvent('click')) as unknown as Promise<void>;
  expect(button.disabled).toBe(true);
  (w.document.querySelector('#sessionList [data-id="rejected-recovery-second"]') as HTMLElement).click();
  const existingToast = w.document.querySelector('.toast')?.textContent;
  reject(new Error('PRIVATE_OLD_RECOVERY_TRANSPORT'));
  await expect(action).resolves.toBeUndefined();
  expect(button.disabled).toBe(true);
  expect(w.document.querySelector('.toast')?.textContent).toBe(existingToast);
  expect(w.document.body.textContent).not.toContain('PRIVATE_OLD_RECOVERY_TRANSPORT');
  expect(pending).toHaveBeenCalledTimes(1);
  expect(live.controlCalls).toEqual([]);
  expect(live.sent).toEqual([]);
});

it('explains a global pause acquired during per-chat Resume rather than presenting a zero-count success', async () => {
  const sourceSessionId = summary([]).id;
  const { w, live, state } = await boot([], true, [{ id: 'selected-mid-pause-helper', sourceSessionId }]);
  const api = (w as any).api;
  let release!: (value: unknown) => void;
  const resume = vi.fn(() => new Promise(resolve => { release = resolve; }));
  api.resumeAutomationChat = resume;
  const button = [...w.document.querySelectorAll<HTMLButtonElement>('#inputQueue button')].find(row => row.textContent?.includes('Resume this chat'))!;
  const action = button.onclick!(new w.PointerEvent('click')) as unknown as Promise<void>;
  state.config.ui.automationPaused = true;
  release({ ok: true, data: { eligible: 0, queued: 0, alreadyActive: 0, recovering: 0, rearmed: 0, skipped: 0 } });
  await action;
  expect(w.document.querySelector('.toast')?.textContent).toContain('Automation is paused for this account');
  expect(w.document.querySelector('.toast')?.textContent).not.toContain('Exact chat recovery:');
  expect(button.disabled).toBe(false);
  expect(state.config.ui.automationPaused).toBe(true);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(live.controlCalls).toEqual([]);
  expect(live.sent).toEqual([]);
});

it('offers exact-chat recovery after three helper failures even when no cancelled helper row remains', async () => {
  const sourceSessionId = summary([]).id;
  const cause = 'Three helper attempts failed for this exact turn. The requested model or reasoning could not be confirmed before Send.';
  const { w, live } = await boot([], true, [], [], {
    controls: {
      goalDraft: {
        stage: 'failed',
        stageStartedAt: T0,
        model: 'gpt-5.6-sol',
        text: '',
        error: 'goal_browser_helper_exhausted',
        message: cause
      }
    }
  });
  await settle();
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain(cause);
  expect(queue.textContent).toContain('This exact saved turn is still owed');
  const restart = [...queue.querySelectorAll('button')].find(button => button.textContent?.includes('Restart helper')) as HTMLButtonElement;
  expect(restart).toBeTruthy();

  restart.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: sourceSessionId, action: 'resume-one' });
  expect(live.controlCalls).not.toContainEqual({ id: '*', action: 'resume-all' });
});

it.each([
  { label: 'durable stale-state rejection', reply: { ok: true as const, data: false }, disabled: true, changed: true },
  { label: 'IPC failure', reply: { ok: false as const, error: 'Helper retry IPC failed.' }, disabled: false, changed: false }
])('keeps selected helper retry $label fenced correctly while refresh is unavailable', async ({ reply, disabled, changed }) => {
  const sourceSessionId = summary([]).id;
  const { w } = await boot([], true, [{ id: 'paused-selected', sourceSessionId }]);
  const api = (w as any).api;
  const retryHelper = vi.fn(async () => reply);
  api.retryHelper = retryHelper;
  api.listPausedHelpers = () => new Promise(() => {});
  const button = w.document.querySelector<HTMLButtonElement>('#inputQueue button')!;

  button.click();
  await settle();

  expect(retryHelper).toHaveBeenCalledWith('paused-selected', sourceSessionId);
  expect(button.disabled).toBe(disabled);
  expect(w.document.body.textContent?.includes('This helper has changed. Refreshing its status.')).toBe(changed);
});

it('bulk-restarts one helper per affected source and reports automation recovery separately', async () => {
  const sourceSessionId = summary([]).id;
  const { w, live } = await boot([], true, [
    { id: 'paused-one-old', sourceSessionId },
    { id: 'paused-one-new', sourceSessionId },
    { id: 'paused-two', sourceSessionId: 'another-session' }
  ]);
  const button = w.document.getElementById('retryPausedHelpers') as HTMLButtonElement;
  expect(button.hidden).toBe(false);
  expect(button.textContent).toContain('Restart 2 helper chats');
  button.click();
  await settle();
  expect(live.controlCalls).toContainEqual({ id: '*', action: 'retry-helpers:2' });
  expect(button.hidden).toBe(true);
  expect(w.document.body.textContent).toContain('2 helper chats restarted; 2 automation chats queued; 0 working; 0 recovering.');
});

it('does not expose the retired End turn menu action', async () => {
  const { w, live } = await boot([]);
  expect(w.document.getElementById('releaseFinish')).toBeNull();
  expect(live.controlCalls).toEqual([]);
  expect(live.sent).toEqual([]);
});

it('updates an offered injection receipt in its existing transcript position', async () => {
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:receipt-test', message: text('Injected instruction'), inputDelivery: 'offered' };
  const app = await boot([message, toolCall(2, 'later-work')]);
  expect(app.w.document.querySelector('.input-receipt')?.getAttribute('aria-label')).toBe('Sent to the active turn · awaiting receipt');
  app.live.events[0] = { ...message, seq: 3, inputDelivery: 'confirmed' };
  await app.append([]);
  expect(app.w.document.querySelectorAll('.input-receipt')).toHaveLength(1);
  expect(app.w.document.querySelector('.input-receipt')?.getAttribute('aria-label')).toBe('Delivery confirmed');
});

it.each(['menu', 'send'])('queues an Astra finish message through %s using the existing staged queue', async action => {
  const app = await boot([]);
  const { w, live } = app;
  const api = (w as any).api;
  const original = api.getSessionControls;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, queueAtFinish: true, canInject: true } });
  await app.append([]);
  expect(w.document.getElementById('queueAtFinish')!.hidden).toBe(false);
  expect(w.document.getElementById('afterTurnLabel')!.textContent).toBe('Queue at Session finish');
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'The next stage';
  input.dispatchEvent(new w.Event('input'));
  if (action === 'menu') w.document.getElementById('queueAtFinish')!.click();
  else {
    (w.document.getElementById('sendMode') as HTMLSelectElement).value = 'after-turn';
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  }
  await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'The next stage', mode: 'finish' });
});

it('shows injection only for an exact active turn, never merely recent chat activity', async () => {
  const { w, append } = await boot([toolCall(1, 'recent-call')]);
  const options = w.document.getElementById('sendOptions')!;
  expect(options.hidden).toBe(false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'An authored follow-up'; input.dispatchEvent(new w.Event('input'));
  expect(options.hidden).toBe(false);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true, data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([toolCall(2, 'more-recent-call')]);
  expect(options.hidden).toBe(true);
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('auto');
});

it('shows Send directly before MCP, keeps After this turn selected, and changes the visible menu after MCP', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let tools = false;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    activeTurnId: 'plain-turn', canInject: tools, canSendDirectly: !tools, queueAtFinish: false } });
  await append([]);
  const options = w.document.getElementById('sendOptions')!;
  expect(options.hidden).toBe(false);
  expect(options.querySelector('[data-delivery="auto"]')!.textContent).toBe('Send directly');
  (options.querySelector('[data-delivery="after-turn"]') as HTMLButtonElement).click();
  await append([]);
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('after-turn');
  tools = true;
  await append([toolCall(1, 'first-mcp-call')]);
  expect(options.querySelector('[data-delivery="auto"]')!.textContent).toBe('Inject now');
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('after-turn');
});

it.each(['reopened', 'completed', 'reordered'] as const)(
  'uses the latest recorded sequence for an exact-turn work caption (%s)', async condition => {
    const recorded: SessionEvent[] = [
      { seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'reopened-caption' },
      { seq: 2, time: T0 + 10_000, source: 'extension', kind: 'turn_end', turnId: 'reopened-caption', outcome: 'completed' },
      { seq: 3, time: T0 + 11_000, source: 'extension', kind: 'turn_start', turnId: 'reopened-caption' }
    ];
    if (condition !== 'reopened') recorded.push({ seq: 4, time: T0 + 20_000,
      source: 'extension', kind: 'turn_end', turnId: 'reopened-caption', outcome: 'completed' });
    // Restored/paged rows need not arrive in recorder sequence order.
    const events = condition === 'reordered' ? [recorded[3]!, recorded[0]!, recorded[2]!, recorded[1]!] : recorded;
    const row = summary(events);
    const { w, live } = await boot(events, true, [], [], {
      sessions: [row], controls: { activeTurnId: null, conversationId: row.conversationId }
    });
    const caption = w.document.getElementById('chatState')!;
    expect(caption.textContent).toBe(condition === 'reopened' ? '' : 'Worked for 20s');
    expect(caption.classList.contains('is-working')).toBe(false);
    expect(live.sent).toEqual([]);
  }
);

it('shows elapsed work for the exact recorded turn without exposing lifecycle rows', async () => {
  const { w, append } = await boot([{ seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'held-turn' }]);
  expect(w.document.getElementById('chatState')!.textContent).toMatch(/^Working for /);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true, data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([{ seq: 2, time: T0 + 65_000, source: 'extension', kind: 'turn_end', turnId: 'held-turn', outcome: 'completed' }]);
  expect(w.document.getElementById('chatState')!.textContent).toBe('Worked for 1m 5s');
});

it.each([
  { state: 'blocked' as const, stage: null, paused: false,
    reason: 'Provider sign-in is required for this account.', expected: 'blocked', next: 'Review the existing account session.' },
  { state: 'working' as const, stage: null, paused: true,
    reason: 'Earlier working state before account pause.', expected: 'paused', next: 'Review the account hold before any deliberate resume.' },
  { state: 'recovering' as const, stage: 'waiting-browser' as const, paused: false,
    reason: 'ChatGPT page unavailable while Core work is retained.', expected: 'waiting for Chrome', next: 'Wait for the existing recovery owner.' },
  { state: 'waiting-main' as const, stage: null, paused: false,
    reason: 'Waiting for the next exact answer boundary.', expected: 'between turns', next: 'Keep the saved input without replay.' }
])('keeps inline chat and Work status aligned for $expected despite stale turn/tool signals', async scenario => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), activeTurnId: 'stale-open-turn',
    lastToolCallAt: now - 500, activityExpiresAt: now + 60_000 };
  const events: SessionEvent[] = [
    { seq: 1, time: now - 4_000, source: 'extension', kind: 'turn_start', turnId: 'stale-open-turn' },
    { ...toolCall(2, 'already-recorded-core-tool'), time: now - 500, turnId: 'stale-open-turn' }
  ];
  const automation: AutomationSupervisorSnapshot = {
    observedAt: now, targetLanes: 1,
    counts: { working: scenario.state === 'working' ? 1 : 0,
      'waiting-main': scenario.state === 'waiting-main' ? 1 : 0,
      'waiting-workers': 0, recovering: scenario.state === 'recovering' ? 1 : 0,
      stalled: 0, blocked: scenario.state === 'blocked' ? 1 : 0, paused: 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: scenario.state, reason: scenario.reason, nextAction: scenario.next,
      nextRetryAt: null, lastWorkedAt: now - 500, activeWorkers: 0, recoverable: false,
      spinning: scenario.state === 'working', recoveryStage: scenario.stage }]
  };
  const app = await boot(events, true, [], [], {
    sessions: [row], automation, automationPaused: scenario.paused,
    controls: { conversationId: row.conversationId, activeTurnId: 'stale-open-turn' }
  });
  const doc = app.w.document;
  const inline = doc.getElementById('chatState')!;
  const overview = doc.querySelector<HTMLElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${row.id}"]`)!;
  expect(overview.textContent).toContain(scenario.expected);
  expect(inline.textContent).toContain(scenario.expected);
  expect(inline.textContent).not.toContain('Working for');
  expect(inline.classList.contains('is-working')).toBe(false);
  expect(inline.getAttribute('aria-label')).toContain(scenario.expected);
  expect(inline.getAttribute('title')?.toLowerCase())
    .toContain((scenario.paused ? 'review the account hold' : scenario.next).toLowerCase());
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('labels an explicitly draining main turn as pausing while retaining its live evidence', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), activeTurnId: 'active-draining-turn',
    lastToolCallAt: now - 500, activityExpiresAt: now + 60_000 };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: now, targetLanes: 1,
    counts: { working: 1, 'waiting-main': 0, 'waiting-workers': 0,
      recovering: 0, stalled: 0, blocked: 0, paused: 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: 'working', reason: 'Existing main turn may finish.',
      nextAction: 'Let the current turn complete.', nextRetryAt: null, lastWorkedAt: now,
      activeWorkers: 0, recoverable: false, spinning: true, recoveryStage: null,
      pause: { phase: 'draining', remaining: 1, mainTurn: true,
        runningTools: 0, activeWorkers: 0, handoff: false, browserAction: false } }]
  };
  const app = await boot([
    { seq: 1, time: now - 5_000, source: 'extension', kind: 'turn_start', turnId: 'active-draining-turn' }
  ], true, [], [], { sessions: [row], automationPaused: true, automation,
    controls: { conversationId: row.conversationId, activeTurnId: 'active-draining-turn' } });
  const inline = app.w.document.getElementById('chatState')!;
  expect(inline.textContent).toContain('pausing');
  expect(inline.textContent).toContain('Existing main turn may finish.');
  expect(inline.classList.contains('is-paused')).toBe(true);
  expect(inline.textContent).not.toContain('Working for');
  expect(inline.getAttribute('title')).toContain('Let the current turn complete.');
  expect(app.w.document.querySelector(
    `.work-overview-section[data-work-section="current"] [data-session-id="${row.id}"]`)?.textContent)
    .toContain('pausing');
  expect(app.live.controlCalls).toEqual([]);
});

it('does not show inline working for a recorded terminal failure with no newer exact turn', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), activeTurnId: null,
    lastTurnEndAt: now - 100, lastTurnOutcome: 'failed',
    lastToolCallAt: now - 500, activityExpiresAt: now + 60_000 };
  const app = await boot([
    { seq: 1, time: now - 6_000, source: 'extension', kind: 'turn_start', turnId: 'old-failed-turn' },
    { seq: 2, time: now - 100, source: 'extension', kind: 'turn_end', turnId: 'old-failed-turn', outcome: 'failed' }
  ], true, [], [], { sessions: [row], controls: { activeTurnId: 'old-failed-turn' } });
  const inline = app.w.document.getElementById('chatState')!;
  expect(inline.textContent).toContain('Last turn failed');
  expect(inline.classList.contains('is-bad')).toBe(true);
  expect(inline.classList.contains('is-working')).toBe(false);
  expect(inline.textContent).not.toContain('Working for');
  expect(app.live.controlCalls).toEqual([]);
});

it.each(['unknown', 'stopped'] as const)('keeps a recorded %s outcome distinct from the other pause/completion states', async outcome => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), activeTurnId: null,
    lastTurnEndAt: now - 100, lastTurnOutcome: outcome,
    lastToolCallAt: now - 500, activityExpiresAt: now + 60_000 };
  const app = await boot([
    { seq: 1, time: now - 6_000, source: 'extension', kind: 'turn_start', turnId: 'terminal-state-turn' },
    { seq: 2, time: now - 100, source: 'extension', kind: 'turn_end', turnId: 'terminal-state-turn', outcome }
  ], true, [], [], { sessions: [row], controls: { activeTurnId: null } });
  const inline = app.w.document.getElementById('chatState')!;
  expect(inline.textContent?.toLowerCase()).toContain(outcome);
  expect(inline.classList.contains('is-unknown')).toBe(outcome === 'unknown');
  expect(inline.classList.contains('is-paused')).toBe(outcome === 'stopped');
  expect(inline.classList.contains('is-working')).toBe(false);
  expect(app.live.controlCalls).toEqual([]);
  expect(app.live.sent).toEqual([]);
});

it('retires an old inline provider hold when newer exact status arrives and clears stale hover/accessibility text', async () => {
  const now = Date.now();
  const row: SessionSummary = { ...summary([]), activeTurnId: 'older-turn', lastToolCallAt: now - 6_000 };
  const events: SessionEvent[] = [
    { seq: 1, time: now - 8_000, source: 'extension', kind: 'turn_start', turnId: 'older-turn' }
  ];
  const chat: AutomationSupervisorSnapshot['chats'][number] = {
    sessionId: row.id, conversationId: row.conversationId!, title: row.title, mode: 'loop',
    state: 'blocked', reason: 'Provider authorization blocked the old turn.',
    nextAction: 'Review this provider hold.', lastWorkedAt: now - 6_000, nextRetryAt: null,
    activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null
  };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: now, targetLanes: 1,
    chats: [chat], counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0,
      recovering: 0, stalled: 0, blocked: 1, paused: 0 }
  };
  const app = await boot(events, true, [], [], { sessions: [row], automation,
    controls: { conversationId: row.conversationId, activeTurnId: 'older-turn' } });
  const note = app.w.document.getElementById('chatState')!;
  expect(note.textContent).toContain('blocked');
  expect(note.classList.contains('is-bad')).toBe(true);
  expect(note.title).toContain('Review this provider hold');

  chat.state = 'waiting-main';
  chat.reason = 'A later exact status superseded the blocked snapshot.';
  chat.nextAction = 'Observe the existing next-turn owner.';
  app.notifySession();
  await settle(650);
  expect(note.textContent).toContain('between turns');
  expect(note.textContent).toContain('later exact status');
  expect(note.title).toContain('Observe the existing next-turn owner');
  expect(note.title).not.toContain('Review this provider hold');
  expect(note.classList.contains('is-bad')).toBe(false);
  expect(note.classList.contains('is-working')).toBe(false);

  automation.chats.splice(0, 1);
  row.activeTurnId = null;
  row.lastTurnOutcome = 'completed';
  row.lastTurnEndAt = now - 2_000;
  app.live.events.push({ seq: 2, time: now - 2_000, source: 'extension', kind: 'turn_end',
    turnId: 'older-turn', outcome: 'completed' });
  (app.w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, conversationId: row.conversationId, automation: 'off',
      activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  app.notifySession();
  await settle(650);
  expect(note.textContent).toBe('Worked for 6s');
  expect(note.getAttribute('title')).toBeNull();
  expect(note.getAttribute('aria-label')).toBeNull();
  expect(note.classList.contains('is-working')).toBe(false);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('updates an inline provider hold and its accessible explanation when the workspace language changes', async () => {
  const row = summary([]);
  const automation: AutomationSupervisorSnapshot = {
    observedAt: Date.now(), targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0,
      recovering: 0, stalled: 0, blocked: 1, paused: 0 },
    chats: [{ sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: 'blocked', reason: 'Provider model unavailable.',
      nextAction: 'Inspect this exact account.', nextRetryAt: null, lastWorkedAt: Date.now(),
      activeWorkers: 0, recoverable: false, spinning: false, recoveryStage: null }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation });
  const inline = app.w.document.getElementById('chatState')!;
  expect(inline.textContent).toContain('blocked');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('zh-CN');
  expect(inline.textContent).toContain('已阻止');
  expect(inline.getAttribute('title')).toContain('已阻止');
  expect(inline.getAttribute('aria-label')).toContain('已阻止');
  expect(inline.getAttribute('title')).toContain('Inspect this exact account.');
  setLanguage('en');
  expect(inline.textContent).toContain('blocked');
  expect(app.live.sent).toEqual([]);
});

it('shows recent exact tool work when the page reports no active turn', async () => {
  const ended: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'page-turn' },
    { seq: 2, time: T0 + 5_000, source: 'extension', kind: 'turn_end', turnId: 'page-turn', outcome: 'completed' }
  ];
  const row = { ...summary(ended), lastToolCallAt: null as number | null };
  const { w, append } = await boot(ended, true, [], [], { sessions: [row] });
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  const note = w.document.getElementById('chatState')!;

  await append([]);
  expect(note.textContent).toBe('Worked for 5s');
  row.lastToolCallAt = Date.now() - 20_000;
  await append([]);
  expect(note.textContent).toBe('Working…');
  expect(note.classList.contains('is-working')).toBe(true);
  row.lastToolCallAt = Date.now() - 10 * 60_000;
  await append([]);
  expect(note.textContent).toBe('Worked for 5s');
});

it('stops calling a chat active as soon as its page reports an end after the last tool', async () => {
  const start = Date.now() - 40_000;
  const ended: SessionEvent[] = [
    { seq: 1, time: start, source: 'extension', kind: 'turn_start', turnId: 'page-turn' },
    { seq: 2, time: start + 38_000, source: 'extension', kind: 'turn_end', turnId: 'page-turn', outcome: 'completed' }
  ];
  const row = { ...summary(ended), lastToolCallAt: start + 33_000 as number | null,
    lastTurnEndAt: start + 38_000, lastAssistantFinalAt: null };
  const { w, append } = await boot(ended, true, [], [], { sessions: [row] });
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  const note = w.document.getElementById('chatState')!;
  await append([]);
  expect(note.textContent).toBe('Worked for 38s');
  expect(note.classList.contains('is-working')).toBe(false);
  row.lastToolCallAt = start + 39_000;
  await append([]);
  expect(note.textContent).toBe('Working…');
});


it('stops directly from the empty composer without a second Stop menu action', async () => {
  const { w } = await boot([]);
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  (w as any).api.stopSessionTurn = stop;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  expect(send.getAttribute('aria-label')).toBe('Stop turn');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(); expect(stop).not.toHaveBeenCalled();
  input.value = 'Keep this draft'; input.dispatchEvent(new w.Event('input'));
  expect(send.getAttribute('aria-label')).toBe('Send message');
  expect(w.document.getElementById('sendOptions')!.hidden).toBe(false);
  expect(w.document.getElementById('stopTurnAction')).toBeNull();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(w.document.getElementById('sendOptions')!.hidden).toBe(false);
  send.click();
  await settle();
  expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'held-turn');
  expect(input.value).toBe('');
});

it('shows Stop after durable first-send admission, switches to Send for a new draft, and cancels through the same button', async () => {
  const { w, live } = await boot([], false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  input.value = 'First request';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  expect(send.dataset.action).toBe('send');
  expect(send.disabled).toBe(true);
  expect(input.value).toBe('First request');
  await settle();
  expect(send.dataset.action).toBe('stop');
  expect(send.disabled).toBe(false);
  expect(w.document.querySelector('#inputQueue button')?.textContent).not.toBe('Cancel');
  input.value = 'Second request'; input.dispatchEvent(new w.Event('input'));
  expect(send.dataset.action).toBe('send');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(send.dataset.action).toBe('stop');
  const cancel = vi.fn(async (id: string) => { live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' } : row); return { ok: true, data: true }; });
  (w as any).api.cancelInput = cancel;
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(cancel).toHaveBeenCalledWith(live.sent[0]!.id);
  expect(send.dataset.action).toBe('send');
});

it('opens the saved task editor from the Goal dock and still closes it on outside clicks', async () => {
  const { w } = await boot([]);
  (w.document.querySelector('#automationSwitch [data-mode="goal"]') as HTMLButtonElement).click();
  await settle();
  const menu = w.document.getElementById('composerSettings') as HTMLDetailsElement;
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  expect(objective.placeholder).toBe('Optional. Leave empty to work toward what you asked in this chat.');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('zh-CN');
  expect(objective.placeholder).toBe('可选。留空时，将根据你在此聊天中的请求继续工作。');
  setLanguage('en');
  const edit = w.document.querySelector('#activeGoalRow button[aria-label="Edit task"]') as HTMLButtonElement;
  expect(edit).not.toBeNull();
  menu.open = false;
  edit.click();
  expect(menu.open).toBe(true);
  expect(w.document.activeElement).toBe(objective);
  w.document.body.click();
  expect(menu.open).toBe(false);
  await settle();
});

it('retains the New Chat objective through Goal, Off and Goal toggles', async () => {
  const { w } = await boot([], false);
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Build and verify the requested feature';
  objective.dispatchEvent(new w.Event('input'));
  for (const mode of ['goal', 'off', 'goal']) {
    (w.document.querySelector(`#automationSwitch [data-mode="${mode}"]`) as HTMLButtonElement).click();
    await settle();
    expect(objective.value).toBe('Build and verify the requested feature');
    expect(objective.hidden).toBe(mode === 'off');
    expect(w.document.getElementById('saveSessionObjective')!.hidden).toBe(mode === 'off');
    expect((w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe(mode);
  }
  expect(w.document.getElementById('clearSessionObjective')).toBeNull();
  expect(w.document.getElementById('showHandoff')).toBeNull();
});

it('keeps editable stages and sends the original request with the full workflow exactly once', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task';
  input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click();
  await settle();
  expect(live.sent).toHaveLength(0);
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toMatch(/Start plan|Review stages/);
  const edit = w.document.querySelector<HTMLButtonElement>('[aria-label="Edit stage 1"]')!;
  edit.click();
  const stage = w.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit stage 1"]')!;
  stage.value = 'Build the edited foundation'; stage.dispatchEvent(new w.Event('input'));
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Start full plan');
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Build the edited foundation', stages: ['Verify it'], objective: 'Build the whole task' });
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(false);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('Verify it');
  expect(w.document.querySelector('[aria-label="Plan stage · waiting for the first message to be sent"]')).not.toBeNull();
});

it.each([true, false])('hands plan presentation to queued stages while sending and restores a rejected draft (accepted=%s)', async accepted => {
  const { w, live, append } = await boot([], false);
  const api = (w as any).api;
  const stages = ['Define the build', 'Assign first worker', 'Assign second worker', 'Integrate', 'Verify', 'Acceptance'];
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: stages }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click();
  await settle();
  const preview = w.document.getElementById('taskPlanPreview')!;
  expect(preview.hidden).toBe(false);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(6);
  let finish!: (result: unknown) => void;
  let first!: InputEntry;
  api.sendInput = vi.fn((args: InputArgs) => {
    live.sent.push(args);
    first = { ...args, state: 'queued', owner: null, createdAt: Date.now(), conversationId: 'chat-b' };
    // An outbox observation can arrive before the original send IPC response. Its
    // checkpoint projection must not coexist with the editable six-stage draft.
    live.inputs = [first];
    return new Promise(resolve => { finish = resolve; });
  });
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await append([]);
  expect(preview.hidden).toBe(true);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(0);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(5);
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: stages[0], stages: stages.slice(1) });
  if (!accepted) live.inputs = [];
  finish(accepted ? { ok: true, data: first } : { ok: false, error: 'Fixture send rejected' });
  await settle();
  expect(preview.hidden).toBe(accepted);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(accepted ? 0 : 6);
  if (!accepted) {
    expect(input.value).toBe('Build the whole task');
    expect(w.document.getElementById('draftRecoveryStatus')!.textContent).toContain('reconciliation');
  }
});

it.each(['delivery', 'model', 'refresh-failed', 'enqueue-failed'])('retries the durable full plan without pasting stage one (%s)', async failure => {
  const { w, live, append } = await boot([], false);
  const api = (w as any).api;
  const original: InputEntry = { id: 'failed-plan', sessionId: null, projectId: null, text: 'Implement everything',
    objective: 'Original complete request', stages: ['Verify gameplay', 'Verify voice', 'Final review'], automation: 'off',
    model: 'gpt-5.6-sol', reasoningEffort: 'high', mode: 'auto', dueAt: 1, createdAt: 1, state: 'failed',
    owner: null, conversationId: null, requiresAuthorization: true, preSendReoffers: 3, error: failure === 'model' || failure === 'refresh-failed'
      ? 'Requested model or reasoning could not be confirmed' : 'Delivery failed' };
  live.inputs = [original]; await append([]);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'An independent draft'; input.dispatchEvent(new w.Event('input'));
  api.requestChatModels = vi.fn(async () => ({ ok: true, data: failure === 'refresh-failed'
    ? { state: 'unavailable', models: [], error: 'Unavailable' }
    : { state: 'ready', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['xhigh'] }] } }));
  if (failure === 'enqueue-failed') api.sendInput = vi.fn(async () => ({ ok: false, error: 'Connection failed' }));
  const retry = w.document.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!;
  retry.click(); retry.click(); await settle(); await append([]);
  expect(input.value).toBe('An independent draft');
  if (failure === 'refresh-failed' || failure === 'enqueue-failed') {
    expect(live.sent).toHaveLength(0);
    expect(w.document.querySelector('[aria-label="Retry delivery"]')).not.toBeNull();
    expect(live.inputs[0]!.stages).toEqual(original.stages);
    expect(w.localStorage.getItem('dismissed-input-notices') ?? '').not.toContain(original.id);
  } else {
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0]).toMatchObject({ text: original.text, objective: original.objective, stages: original.stages,
      automation: 'off', model: original.model, reasoningEffort: failure === 'model' ? 'xhigh' : 'high', mode: 'auto' });
    expect(live.sent[0]!.id).not.toBe(original.id);
    expect(live.sent[0]).not.toHaveProperty('owner');
    expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(3);
  }
  expect(api.requestChatModels).toHaveBeenCalledTimes(failure === 'model' || failure === 'refresh-failed' ? 1 : 0);
});

it('disables empty task actions and confirms saving without the old helper sentence', async () => {
  const { w } = await boot([], false);
  const save = w.document.getElementById('saveSessionObjective') as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  plan.click();
  expect(w.document.activeElement?.id).toBe('chatInput');
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toContain('plan');
  expect(w.document.getElementById('chatSend')!.title).toBe('Click to generate plan');
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Generate plan');
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  plan.click();
  expect(plan.getAttribute('aria-pressed')).toBe('false');
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toBe('Ask anything…');
  expect(w.document.getElementById('chatSend')!.title).toBe('');
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Implement and verify'; objective.dispatchEvent(new w.Event('input'));
  expect(save.disabled).toBe(false); save.click(); await settle();
  expect(save.textContent).toContain('Saved'); expect(save.disabled).toBe(true);
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toBe('');
  objective.value += ' everything'; objective.dispatchEvent(new w.Event('input'));
  expect(save.disabled).toBe(false); expect(save.textContent).not.toContain('Saved');
});


it('omits the selected worker identity but retains a different sender', async () => {
  const events: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'assistant_message', agent: 'worker-2', message: text('Own reply'), final: true },
    { seq: 2, time: T0 + 1, source: 'extension', kind: 'assistant_message', agent: 'worker-3', message: text('Other reply'), final: true }
  ];
  const { w } = await boot(events, true, [], [], { origin: { kind: 'worker', agentId: 'worker-2', fromSessionId: 'parent', task: 'Audit' } });
  const labels = [...w.document.querySelectorAll('.ev-body > .chip')].map(el => el.textContent);
  expect(labels).toEqual(['worker-3']);
  expect(w.document.querySelector('.timeline')?.textContent ?? w.document.body.textContent).toContain('Own reply');
});

it('collapses legacy interrupted-response repeats into one icon and updates its status after completion', async () => {
  const error: SessionEvent = { seq: 2, time: T0 + 2, source: 'extension', kind: 'chat_error', turnId: 'original', recoverable: true, message: text('Connection interrupted') };
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'question', message: text('Build') },
    error, { ...error, seq: 3, turnId: undefined }, { ...error, seq: 4, turnId: 'replacement' },
    { seq: 5, time: T0 + 5, source: 'app', kind: 'progress', turnId: 'replacement', progressId: 'browser-repair:test', message: text('Reloaded chat') }
  ]);
  expect(w.document.querySelectorAll('.chat-error-compact')).toHaveLength(1);
  expect(w.document.querySelector('.chat-error-compact')!.getAttribute('title')).toContain('Reloaded chat');
  await append([{ seq: 6, time: T0 + 6, source: 'extension', kind: 'assistant_message', final: true, messageId: 'answer', message: text('Done') }]);
  expect(w.document.querySelectorAll('.chat-error-compact')).toHaveLength(1);
  expect(w.document.querySelector('.chat-error-compact')!.getAttribute('title')).toContain('later completed');
});

it('docks recent app repair progress without hiding authored lookalikes', async () => {
  const events: SessionEvent[] = [
    { seq: 1, time: Date.now(), source: 'app', kind: 'progress', progressId: 'browser-repair:test', message: text('Restored the browser connection') },
    { seq: 2, time: Date.now(), source: 'extension', kind: 'assistant_message', message: text('Reopened chat to recover a missing browser tab.'), final: true }
  ];
  const { w } = await boot(events);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(false);
  expect(w.document.getElementById('recoveryStatus')!.textContent).toContain('Restored the browser connection');
  expect(w.document.querySelectorAll('.ev-progress')).toHaveLength(0);
  expect(w.document.querySelector('.ev-assistant_message')!.textContent).toContain('Reopened chat');
  w.document.getElementById('newChat')!.click();
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
});

it('keeps historical repair details in developer mode without reviving a status', async () => {
  const { w } = await boot([{ seq: 1, time: T0, source: 'app', kind: 'progress', progressId: 'browser-repair:old', message: text('Historical repair') }], true, [], [], { developerMode: true });
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
  expect(w.document.querySelector('.ev-progress')!.textContent).toContain('Historical repair');
});

it('keeps accepted pending-send Stop while the durable queue refresh is still in flight', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  const listings: Array<(value: any) => void> = [];
  api.listInputs = () => new Promise(resolve => listings.push(resolve));
  api.sendInput = async (value: InputArgs) => ({ ok: true, data: { ...value, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null } });
  input.value = 'First request';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  expect(send.dataset.action).toBe('send');
  expect(send.disabled).toBe(true);
  expect(input.value).toBe('First request');
  await settle();
  expect(send.dataset.action).toBe('stop');
  listings[0]!({ ok: true, data: [] });
  await settle();
  expect(send.dataset.action).toBe('stop');
});

it('dismisses only the displayed recovery revision and reveals a changed status or new incident', async () => {
  const time = Date.now();
  const repair: SessionEvent = { seq: 1, time, source: 'app', kind: 'progress', progressId: 'browser-repair:dismiss', message: text('Reloaded chat to recover an unresponsive open turn.') };
  const { w, append, live } = await boot([repair], true, [], [], { developerMode: true });
  const status = w.document.getElementById('recoveryStatus')!;
  const dismiss = () => (status.querySelector('[aria-label="Dismiss recovery notice"]') as HTMLButtonElement).click();
  expect(status.hidden).toBe(false); dismiss(); expect(status.hidden).toBe(true);
  expect(live.events).toEqual([repair]);
  expect(w.document.querySelector('.ev-progress')?.textContent).toContain('Reloaded chat');
  await append([]); expect(status.hidden).toBe(true);
  await append([{ ...repair, seq: 2, message: text('The browser connection is restored.') }]);
  expect(status.hidden).toBe(false); expect(status.textContent).toContain('connection is restored');
  dismiss(); await append([]); expect(status.hidden).toBe(true);
  await append([{ ...repair, seq: 3, progressId: 'browser-repair:new' }]);
  expect(status.hidden).toBe(false);
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).disabled).toBe(false);
});

it('blocks an empty stage, deletes it explicitly, and hides the whole dock in settings', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Write poem', 'Verify lines'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Rain poem'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  const stage = w.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit stage 1"]')!;
  stage.value = ''; stage.dispatchEvent(new w.Event('input'));
  expect(stage.getAttribute('aria-invalid')).toBe('true');
  expect((w.document.getElementById('chatSend') as HTMLButtonElement).disabled).toBe(true);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle(); expect(live.sent).toHaveLength(0);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  expect((w.document.getElementById('chatSend') as HTMLButtonElement).disabled).toBe(false);
  const chat = await import('../src/renderer/chat.js');
  chat.openChatView('settings');
  expect(w.document.getElementById('composerDock')!.hidden).toBe(true);
  chat.openChatView('timeline');
  expect(w.document.getElementById('composerDock')!.hidden).toBe(false);
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle(); expect(live.sent[0]).toMatchObject({ text: 'Verify lines', stages: [] });
});

it('cancels pending planning without replacing the draft with a late result', async () => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this draft';
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  plan.click(); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  plan.click();
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Stale cancelled plan' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Stale cancelled plan');
  finish({ ok: true, data: ['First', 'Second'] }); await settle();
  expect(input.value).toBe('Keep this draft');
  expect(plan.getAttribute('aria-pressed')).toBe('false');
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(live.sent).toHaveLength(0);
});

it('keeps completed stages after clearing or replacing the composer until explicitly deleted', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  for (const replacement of ['', 'Unrelated next message', '']) {
    input.value = replacement; input.dispatchEvent(new w.Event('input'));
    expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);
    expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Verify it');
  }
  expect(live.sent).toHaveLength(0);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
});

it('queues every generated stage in a running existing session without Send and preserves them after clearing the composer', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: summary([]).id, text: 'Build foundation', stages: ['Verify it'], mode: 'finish', model: null, reasoningEffort: null });
  expect(input.value).toBe('');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(w.document.querySelectorAll('[aria-label="Remove queued task"]')).toHaveLength(2);
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  api.cancelInput = vi.fn(async (id: string) => { live.inputs = live.inputs.filter(row => row.id !== id); return { ok: true, data: true }; });
  w.document.querySelector<HTMLButtonElement>('[aria-label="Remove queued task"]')!.click(); await settle();
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(1);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('Verify it');
  expect(live.sent).toHaveLength(1);
});

it('keeps a generated plan visible in a known-idle session and starts it with Enter', async () => {
  const { w, live } = await boot([], true, [], [], { controls: { activeTurnId: null } });
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  expect(live.sent).toHaveLength(0);
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Start full plan');
  expect(w.document.querySelector('.plan-stage-heading')!.getAttribute('title')).not.toMatch(/Session finish/);
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: summary([]).id, text: 'Build foundation', stages: ['Verify it'],
    objective: 'Build the whole task', mode: 'auto' });
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
});

it.each(['running', 'unavailable', 'missing activeTurnId', 'undefined activeTurnId'] as const)('rechecks an idle session before Enter and queues the plan when controls become %s', async state => {
  const { w, live } = await boot([], true, [], [], { controls: { activeTurnId: null } });
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['First checkpoint', 'Last checkpoint'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Plan the remaining work'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  expect(live.sent).toHaveLength(0);
  api.getSessionControls = vi.fn((id: string) => state === 'unavailable'
    ? Promise.resolve({ ok: false, error: 'controls unavailable' })
    : Promise.resolve({ ok: true, data: { sessionId: id, conversationId: 'chat-a', automation: 'off',
      ...(state === 'running' ? { activeTurnId: 'new-running-turn' }
        : state === 'undefined activeTurnId' ? { activeTurnId: undefined } : {}),
      finishHeld: false, blocked: '', objective: '', plan: null, job: null } }));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: summary([]).id, text: 'First checkpoint',
    stages: ['Last checkpoint'], mode: 'finish' });
});

it('does not send or queue an idle plan when the selected session changes during the controls reread', async () => {
  const first = summary([]);
  const second: SessionSummary = { ...first, id: 'selection-race-session', title: 'Selection race target',
    conversationId: 'selection-race-chat' };
  const { w, live } = await boot([], true, [], [], { sessions: [first, second], controls: { activeTurnId: null } });
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Keep first plan', 'Verify first plan'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Plan for the first session'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  expect(live.sent).toHaveLength(0);
  let release!: (value: unknown) => void;
  let holdFirst = true;
  const idleControls = (id: string) => ({ ok: true, data: { sessionId: id,
    conversationId: id === first.id ? first.conversationId : second.conversationId, automation: 'off',
    activeTurnId: null, finishHeld: false, blocked: '', objective: '', plan: null, job: null } });
  api.getSessionControls = vi.fn((id: string) => {
    if (id === first.id && holdFirst) {
      holdFirst = false;
      return new Promise(resolve => { release = resolve; });
    }
    return Promise.resolve(idleControls(id));
  });
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(release).toBeTypeOf('function');
  (w.document.querySelector(`[data-id="${second.id}"]`) as HTMLButtonElement).click(); await settle();
  release(idleControls(first.id)); await settle();
  expect(live.sent).toHaveLength(0);
  (w.document.querySelector(`[data-id="${first.id}"]`) as HTMLButtonElement).click(); await settle();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);
});

it('does not use stale idle controls when a same-session refresh supersedes the Enter reread', async () => {
  const session = summary([]);
  const { w, live } = await boot([], true, [], [], { controls: { activeTurnId: null } });
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Keep the staged plan', 'Verify the staged plan'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Plan the idle session safely'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  expect(live.sent).toHaveLength(0);

  const snapshot = (activeTurnId: string | null) => ({ ok: true, data: { sessionId: session.id,
    conversationId: session.conversationId, automation: 'off', activeTurnId,
    finishHeld: false, blocked: '', objective: '', plan: null, job: null } });
  const releases: Array<(value: unknown) => void> = [];
  let reads = 0;
  api.getSessionControls = vi.fn(() => {
    reads += 1;
    if (reads <= 2) return new Promise(resolve => { releases[reads - 1] = resolve; });
    return Promise.resolve(snapshot('new-running-turn'));
  });

  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(releases[0]).toBeTypeOf('function');
  (w.document.getElementById('chatRefresh') as HTMLButtonElement).click();
  await settle();
  expect(releases[1]).toBeTypeOf('function');

  releases[0]!(snapshot(null));
  await settle();
  expect(live.sent).toHaveLength(0);
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);

  releases[1]!(snapshot('new-running-turn'));
  await settle();
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: session.id, text: 'Keep the staged plan',
    stages: ['Verify the staged plan'], mode: 'finish' });
});

it('retries a materialized finish checkpoint without recreating its already independent siblings', async () => {
  const { w, live, append } = await boot([]);
  live.inputs = [{ id: 'failed-first-checkpoint', sessionId: summary([]).id, text: 'Retry just this checkpoint', stages: ['Deleted sibling'],
    stagesApplied: true, mode: 'finish', dueAt: 0, model: null, reasoningEffort: null, state: 'failed', owner: null,
    createdAt: 0, conversationId: 'chat-b', requiresAuthorization: true, preSendReoffers: 3,
    error: 'Provider rejected opted-in after-turn delivery before native Send' }];
  await append([]);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!.click(); await settle();
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('Retry just this checkpoint');
  expect(live.sent).toHaveLength(0);
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(true);
});

it('retains uncertain queue admission across edits and reconciles its durable failed receipt before a finish-only retry', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api, send = api.sendInput;
  let reject!: (value: unknown) => void;
  api.sendInput = vi.fn(() => new Promise(resolve => { reject = resolve; }));
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['First checkpoint', 'Last checkpoint'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Plan the remaining checks';
  w.document.getElementById('createPlan')!.click(); await settle();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  const attempted = api.sendInput.mock.calls[0][0] as InputArgs;
  reject({ ok: false, error: 'Admission reply lost' }); await settle();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Queue plan at Session finish');
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  expect(api.sendInput).toHaveBeenCalledTimes(1);
  expect(w.document.getElementById('draftRecoveryStatus')!.textContent).toContain('reconciliation');
  // A later authoritative ledger read proves admission failed terminally. The
  // original ID remains in the outbox; the explicit retry authors a fresh ID.
  live.inputs.push({ ...attempted, state: 'failed', owner: null, createdAt: Date.now(), conversationId: null, error: 'Failed before native Send' });
  [...w.document.querySelectorAll<HTMLButtonElement>('#draftRecoveryStatus button')]
    .find(button => button.textContent === 'Check saved delivery')!.click(); await settle();
  api.sendInput = send;
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ mode: 'finish', text: 'First checkpoint', stages: ['Last checkpoint'] });
  expect(live.sent[0]!.id).not.toBe(attempted.id);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(input.value).toBe('');
});

it.each([false, true])('retains the planner prompt until Enter durably admits the new-chat plan (pro=%s)', async pro => {
  const { w, live } = await boot([], false, [], [], { pro });
  const effort = w.document.getElementById('composerReasoning') as HTMLSelectElement;
  effort.value = pro ? 'pro' : 'high'; effort.dispatchEvent(new w.Event('change')); await settle();
  (w as any).api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Original objective';
  w.document.getElementById('createPlan')!.click(); await settle();
  expect(input.value).toBe('Original objective');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true }));
  await settle(); expect(live.sent).toHaveLength(0);
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ objective: 'Original objective', text: 'Build foundation', stages: ['Verify it'], reasoningEffort: pro ? 'pro' : 'high' });
  expect(input.value).toBe('');
});

it('does not erase a new composer draft while completed-plan queue admission is pending', async () => {
  const { w } = await boot([]);
  const api = (w as any).api, send = api.sendInput;
  let admit!: () => Promise<void>;
  api.sendInput = vi.fn((args: InputArgs) => new Promise(resolve => { admit = async () => resolve(await send(args)); }));
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['First checkpoint', 'Last checkpoint'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Planner request';
  w.document.getElementById('createPlan')!.click(); await settle();
  expect(input.value).toBe('Planner request');
  input.value = 'My next correction'; input.dispatchEvent(new w.Event('input'));
  await admit(); await settle();
  expect(input.value).toBe('My next correction');
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
});

it('clearing the complete planner task cancels generation and restores Create plan', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Write a poem'; w.document.getElementById('createPlan')!.click(); await settle();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).toHaveBeenCalled();
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-pressed')).toBe('false');
  expect(w.document.getElementById('createPlan')!.textContent).toBe('Create plan');
  finish({ ok: true, data: ['Old stage', 'Old check'] }); await settle();
  expect(live.sent).toHaveLength(0);
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
});

it('routes an armed empty-composer plan through the planner and paints only its live progress', async () => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  w.document.getElementById('createPlan')!.click();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Create an SVG cat';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(0);
  expect(api.draftTaskPlan.mock.calls[0][0]).toBe('Create an SVG cat');
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  progress({ requestId: 'another-request', phase: 'generating', text: 'Wrong work' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Wrong work');
  progress({ requestId, phase: 'generating', text: 'Design the SVG paths' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Design the SVG paths');
  progress({ requestId, phase: 'retrying', text: '', attempt: 2, retryAt: Date.now() + 30000, error: 'rate_limited' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Provider busy · retry 2');
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  finish({ ok: true, data: ['Write SVG paths', 'Validate the SVG'] }); await settle();
  expect(live.sent).toHaveLength(0);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Write SVG paths', stages: ['Validate the SVG'] });
});

it('keeps actual-turn Stop through two authored sends and stops only the captured active turn', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  const cancel = vi.fn(async () => ({ ok: true, data: true }));
  api.cancelInput = cancel;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  for (const text of ['First new direction', 'Second new direction']) {
    expect(send.dataset.action).toBe('stop');
    input.value = text; input.dispatchEvent(new w.Event('input'));
    expect(send.dataset.action).toBe('send');
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    expect(send.dataset.action).toBe('send');
    expect(send.disabled).toBe(true);
    expect(input.value).toBe(text);
    await settle();
    expect(send.dataset.action).toBe('stop');
  }
  expect(live.sent.map(row => row.text)).toEqual(['First new direction', 'Second new direction']);
  expect(live.sent.every(row => row.sessionId === '2026-09-02-test0001' && row.mode === 'auto')).toBe(true);
  // A queued follow-up does not replace the real active turn as Stop's authority.
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'held-turn');
  expect(cancel).not.toHaveBeenCalled();
  expect(input.value).toBe('');
});

it('keeps exact-turn Stop available after clearing a follow-up whose durable admission reply is pending', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api, sendInput = api.sendInput;
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  const cancel = vi.fn(async () => ({ ok: true, data: true }));
  api.stopSessionTurn = stop; api.cancelInput = cancel;
  let admit!: () => Promise<void>;
  api.sendInput = vi.fn((args: InputArgs) => new Promise(resolve => { admit = async () => resolve(await sendInput(args)); }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  input.value = 'Follow-up while the current native turn runs'; input.dispatchEvent(new w.Event('input'));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await settle();
  expect(api.sendInput).toHaveBeenCalledTimes(1);
  expect(input.value).toBe('Follow-up while the current native turn runs');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(send.dataset.action).toBe('stop');
  expect(send.disabled).toBe(false);
  send.click(); await settle();
  expect(stop).toHaveBeenCalledExactlyOnceWith(summary([]).id, 'held-turn');
  expect(cancel).not.toHaveBeenCalled();
  expect(api.sendInput).toHaveBeenCalledTimes(1);
  expect(live.sent).toHaveLength(0);
  await admit(); await settle();
  expect(live.sent.map(row => row.text)).toEqual(['Follow-up while the current native turn runs']);
  expect(stop).toHaveBeenCalledTimes(1); expect(cancel).not.toHaveBeenCalled();
  expect(input.value).toBe('');
});

it('does not retarget an awaiting Stop after leaving and reselecting the same chat', async () => {
  const { w } = await boot([]);
  const api = (w as any).api;
  const baseControls = api.getSessionControls;
  const original = async (id: string) => ({ ok: true, data: { ...(await baseControls(id)).data,
    plan: { updatedAt: 2, plan: [{ step: 'Current plan', status: 'in_progress', details: 'Current selection' }] } } });
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  let resolve!: (value: any) => void;
  api.getSessionControls = () => new Promise(done => { resolve = done; });
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  api.getSessionControls = original;
  w.document.getElementById('newChat')!.click();
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
  await settle();
  expect(w.document.getElementById('agentPlan')!.textContent).toContain('Current plan');
  resolve({ ok: true, data: { ...(await original('2026-09-02-test0001')).data,
    plan: { updatedAt: 1, plan: [{ step: 'Stale plan', status: 'pending' }] } } });
  await settle();
  expect(stop).not.toHaveBeenCalled();
  expect(w.document.getElementById('chatSend')!.dataset.action).toBe('stop');
  expect(w.document.getElementById('agentPlan')!.textContent).toContain('Current plan');
  expect(w.document.getElementById('agentPlan')!.textContent).not.toContain('Stale plan');
});

it('streams a new Goal opening, queues it once, and displays authoritative delivery failure', async () => {
  const { w, live, progress, append } = await boot([], false);
  let finish!: (value: any) => void;
  const opening = vi.fn((_text: string, _mode: string, _requestId: string) => new Promise(resolve => { finish = resolve; }));
  (w as any).api.draftGoalOpening = opening;
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Implement and verify'; objective.dispatchEvent(new w.Event('input'));
  (w.document.getElementById('saveSessionObjective') as HTMLButtonElement).click();
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Preparing the opening message');
  expect(row.getAttribute('aria-busy')).toBe('true');
  const requestId = opening.mock.calls[0]![2];
  progress({ requestId: 'unrelated-request', phase: 'generating', text: 'Wrong Goal' });
  expect(row.textContent).not.toContain('Wrong Goal');
  progress({ requestId, phase: 'retrying', text: '', error: 'rate_limited', attempt: 2, retryAt: Date.now() + 30000 });
  expect(row.textContent).toContain('Provider busy · retry 2');
  expect(row.getAttribute('aria-busy')).toBe('true');
  progress({ requestId, phase: 'generating', text: 'Inspect the existing code first' });
  expect(row.textContent).not.toContain('Inspect the existing code first');
  expect(live.sent).toEqual([]);
  finish({ ok: true, data: { reply: 'Inspect and implement the task', model: 'fixture' } });
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Inspect and implement the task', objective: 'Implement and verify', automation: 'goal' });
  expect(row.textContent).toContain('Opening message queued');
  live.inputs = live.inputs.map(input => ({ ...input, state: 'failed', error: 'Model could not be selected' }));
  await append([]);
  expect(row.textContent).toContain('Model could not be selected');
  expect(row.getAttribute('aria-busy')).toBe('false');
});

it('preserves an Off goal and never sends its late generated opening after Off and On', async () => {
  const { w, live, progress } = await boot([], false);
  const cancel = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.cancelTaskRequest = cancel;
  let finish!: (value: any) => void;
  let requestId = '';
  (w as any).api.draftGoalOpening = (_text: string, _mode: string, id: string) => { requestId = id; return new Promise(resolve => { finish = resolve; }); };
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Keep this objective'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click();
  for (const mode of ['off', 'goal']) (w.document.querySelector(`#automationSwitch [data-mode="${mode}"]`) as HTMLButtonElement).click();
  expect(cancel).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Late provider text' });
  finish({ ok: true, data: { reply: 'Must not send', model: 'fixture' } });
  await settle();
  expect(live.sent).toEqual([]);
  expect(objective.value).toBe('Keep this objective');
  expect(w.document.getElementById('goalLifecycle')!.hidden).toBe(true);
  expect(w.document.getElementById('goalLifecycle')!.textContent).not.toContain('Late provider text');
});

it.each(['navigate', 'objective edit', 'mode change', 'automation change'] as const)('cancels native Goal generation on %s and ignores stale progress', async (action) => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftGoalOpening = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Original task'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click();
  const requestId = api.draftGoalOpening.mock.calls[0][2];
  if (action === 'navigate') {
    (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
    await settle();
  } else if (action === 'objective edit') {
    objective.value = 'Replacement task'; objective.dispatchEvent(new w.Event('input'));
  } else if (action === 'mode change') {
    const mode = w.document.getElementById('sessionObjectiveMode') as HTMLSelectElement;
    mode.value = 'loop'; mode.dispatchEvent(new w.Event('change'));
  } else {
    (w.document.querySelector('#automationSwitch [data-mode="loop"]') as HTMLButtonElement).click();
  }
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Obsolete provider progress' });
  expect(w.document.getElementById('goalLifecycle')!.textContent).not.toContain('Obsolete provider progress');
  finish({ ok: true, data: { reply: 'Obsolete opening', model: 'fixture' } });
  await settle();
  expect(live.sent).toHaveLength(0);
});

it('shows the main-chat Loop wait and deadline without presenting an unsent helper draft as chat output', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const controls = { sessionId: summary([]).id, conversationId: summary([]).conversationId,
    automation: 'loop', objective: 'Continue the task', blocked: '', job: null,
    goalWait: { reason: 'quiet', until: Date.now() + 125_000 }, goalDraft: null as unknown };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Loop · Waiting for the main chat to continue');
  expect(row.querySelector('[role="timer"]')?.textContent).toContain('2:05');
  expect(row.getAttribute('aria-busy')).toBe('true');
  controls.goalDraft = { stage: 'answering', stageStartedAt: Date.now() - 65_000,
    model: 'fixture', text: 'Continue with the remaining checks', error: null };
  await append([]);
  expect(w.document.getElementById('goalLifecycle')).toBe(row);
  expect(row.textContent).toContain('Drafting the next continuation');
  expect(row.textContent).not.toContain('Continue with the remaining checks');
  expect(row.querySelector('[role="timer"]')?.textContent).toMatch(/^1:0[5-6]$/);
  controls.automation = 'off'; await append([]);
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Automation stopped · saved objective retained');
  expect(row.getAttribute('aria-busy')).toBe('false');
});

it('follows the accepted New Chat receipt while preserving a typed follow-up', async () => {
  const { w, live, append } = await boot([], false);
  const composer = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  composer.value = 'Opening message';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  composer.value = 'Follow-up while delivery is pending';
  composer.dispatchEvent(new w.Event('input'));
  live.inputs = live.inputs.map(row => ({ ...row, state: 'sent', deliveredSessionId: summary([]).id }));
  await append([]);
  expect(w.document.querySelector('#sessionList [data-id].is-sel')).not.toBeNull();
  expect(composer.value).toBe('Follow-up while delivery is pending');
});

it('shows Pro Loop delivery before sending and freezes changes made while the opening is being accepted', async () => {
  const { w, live } = await boot([], false, [], [], { pro: true });
  const row = w.document.getElementById('loopDeliveryRow')!;
  const effort = w.document.getElementById('composerReasoning') as HTMLSelectElement;
  const delivery = w.document.getElementById('loopDelivery') as HTMLSelectElement;
  const choose = (value: string) => { effort.value = value; effort.dispatchEvent(new w.Event('change')); };
  w.document.querySelector<HTMLButtonElement>('#automationSwitch [data-mode="loop"]')!.click();
  expect(row.hidden).toBe(true);
  choose('pro'); expect(row.hidden).toBe(false);
  expect(delivery.value).toBe('after-turn');
  delivery.dispatchEvent(new w.Event('change'));
  choose('high'); expect(row.hidden).toBe(true);
  choose('pro'); expect(row.hidden).toBe(false);
  expect(delivery.value).toBe('after-turn');
  const api = (w as any).api;
  const originalSend = api.sendInput;
  let accept!: () => void;
  api.sendInput = vi.fn((input: InputArgs) => new Promise(resolve => { accept = () => resolve(originalSend(input)); }));
  api.setInputAutomation = vi.fn(async () => ({ ok: true, data: true }));
  (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'First Pro Loop message';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(api.sendInput.mock.calls[0][0]).toMatchObject({ sessionId: null, automation: 'loop', loopAfterTurn: true });
  delivery.value = 'finish'; delivery.dispatchEvent(new w.Event('change'));
  accept(); await settle();
  expect(api.setInputAutomation).toHaveBeenLastCalledWith(live.sent[0]!.id, 'loop', false);
  w.document.querySelector<HTMLButtonElement>('#automationSwitch [data-mode="goal"]')!.click();
  expect(row.hidden).toBe(true);
  w.document.getElementById('newChat')!.click();
  expect(delivery.value).toBe('after-turn');
});

it.each(['off', 'goal'] as const)('does not attach hidden Loop delivery to a fresh %s message', async automation => {
  const { w, live } = await boot([], false, [], [], { pro: true });
  if (automation === 'goal') w.document.querySelector<HTMLButtonElement>('#automationSwitch [data-mode="goal"]')!.click();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = `Opening with ${automation}`;
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.inputs[0]).toMatchObject({ sessionId: null, automation });
  expect(live.inputs[0]?.loopAfterTurn).toBeUndefined();
});

it.each([
  { label: 'durable stale-state rejection', reply: { ok: true as const, data: false } },
  { label: 'IPC failure', reply: { ok: false as const, error: 'Could not update opening automation.' } }
])('reconciles accepted New Chat automation after $label', async ({ reply }) => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  const automation = w.document.getElementById('chatAutomation') as HTMLSelectElement;
  automation.value = 'goal'; automation.dispatchEvent(new w.Event('change')); await settle();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Opening with Goal';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.inputs[0]).toMatchObject({ automation: 'goal', state: 'queued' });
  const update = vi.fn(async () => reply);
  api.setInputAutomation = update;

  automation.value = 'off'; automation.dispatchEvent(new w.Event('change'));
  await settle();

  expect(update).toHaveBeenCalledWith(live.inputs[0]!.id, 'off');
  expect(automation.value).toBe('goal');
  expect(w.document.querySelector<HTMLButtonElement>('#automationSwitch [data-mode="goal"]')!.getAttribute('aria-checked')).toBe('true');
});

it.each([
  { label: 'durable stale-state rejection', reply: { ok: true as const, data: false } },
  { label: 'IPC failure', reply: { ok: false as const, error: 'Could not update opening Loop delivery.' } }
])('reconciles accepted New Chat Loop delivery after $label', async ({ reply }) => {
  const { w, live } = await boot([], false, [], [], { pro: true });
  const api = (w as any).api;
  const effort = w.document.getElementById('composerReasoning') as HTMLSelectElement;
  effort.value = 'pro'; effort.dispatchEvent(new w.Event('change')); await settle();
  w.document.querySelector<HTMLButtonElement>('#automationSwitch [data-mode="loop"]')!.click();
  const delivery = w.document.getElementById('loopDelivery') as HTMLSelectElement;
  expect(delivery.value).toBe('after-turn');
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Opening with Pro Loop';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.inputs[0]).toMatchObject({ automation: 'loop', loopAfterTurn: true, state: 'queued' });
  const update = vi.fn(async () => reply);
  api.setInputAutomation = update;

  delivery.value = 'finish'; delivery.dispatchEvent(new w.Event('change'));
  await settle();

  expect(update).toHaveBeenCalledWith(live.inputs[0]!.id, 'loop', false);
  expect(delivery.value).toBe('after-turn');
});

it('does not let a late failed-opening reconciliation overwrite a newer automation choice', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  const automation = w.document.getElementById('chatAutomation') as HTMLSelectElement;
  automation.value = 'goal'; automation.dispatchEvent(new w.Event('change')); await settle();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Opening with mutable automation';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  const stale = structuredClone(live.inputs);
  let resolveList!: () => void;
  const listInputs = vi.fn(() => new Promise(resolve => { resolveList = () => resolve({ ok: true, data: stale }); }));
  api.listInputs = listInputs;
  let changes = 0;
  api.setInputAutomation = vi.fn(async (id: string, mode: 'off' | 'goal' | 'loop') => {
    if (++changes === 1) return { ok: true, data: false };
    live.inputs = live.inputs.map(row => row.id === id ? { ...row, automation: mode } : row);
    return { ok: true, data: true };
  });

  automation.value = 'off'; automation.dispatchEvent(new w.Event('change'));
  await vi.waitFor(() => expect(listInputs).toHaveBeenCalledTimes(1));
  automation.value = 'loop'; automation.dispatchEvent(new w.Event('change'));
  await settle();
  expect(live.inputs[0]!.automation).toBe('loop');
  resolveList(); await settle();

  expect(automation.value).toBe('loop');
  expect(w.document.querySelector<HTMLButtonElement>('#automationSwitch [data-mode="loop"]')!.getAttribute('aria-checked')).toBe('true');
});

it('applies Off to the exact accepted New Chat opening while preserving an unrelated composer draft', async () => {
  const { w, live, append } = await boot([], false);
  const api = (w as any).api;
  api.draftGoalOpening = vi.fn(async () => ({ ok: true, data: { reply: 'Say hello once', model: 'fixture' } }));
  const controls = api.getSessionControls;
  api.getSessionControls = async (id: string) => { const result = await controls(id); result.data.objective = 'Greeting goal'; return result; };
  api.setInputAutomation = vi.fn(async (id: string, mode: 'off' | 'goal' | 'loop') => {
    live.inputs = live.inputs.map(row => row.id === id ? { ...row, automation: mode } : row);
    return { ok: true, data: true };
  });
  const composer = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  composer.value = 'Keep my separate draft';
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Greeting goal'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click(); await settle();
  expect(live.sent).toHaveLength(1);
  const id = live.sent[0]!.id;
  (w.document.querySelector('#automationSwitch [data-mode="off"]') as HTMLButtonElement).click(); await settle();
  expect(api.setInputAutomation).toHaveBeenCalledWith(id, 'off');
  live.inputs = live.inputs.map(row => ({ ...row, state: 'sent', deliveredSessionId: summary([]).id }));
  await append([]);
  expect(composer.value).toBe('Keep my separate draft');
  expect(objective.value).toBe('Greeting goal');
  expect(live.sent).toHaveLength(1);
});

it('cancels pending plan generation when its own draft changes', async () => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Original plan';
  w.document.getElementById('createPlan')!.click(); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  input.value = 'Replacement plan'; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Old plan text' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Old plan text');
  finish({ ok: true, data: ['Old first stage', 'Old second stage'] }); await settle();
  expect(live.sent).toHaveLength(0);
});

it('preserves composer drafts across chat and settings navigation without forcing a fixed height', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w } = await boot([], true, [], [], { sessions: [first, second] });
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Long draft\n'.repeat(60); input.dispatchEvent(new w.Event('input'));
  const draft = input.value;
  expect(input.style.height).toBe('');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  expect(input.value).toBe('');
  expect(input.style.height).toBe('');
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click(); await settle();
  expect(input.value).toBe(draft);
  expect(input.style.height).toBe('');
  const chat = await import('../src/renderer/chat.js');
  chat.openChatView('settings');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click(); await settle();
  chat.openChatView('timeline');
  expect(input.value).toBe(draft);
  expect(input.style.height).toBe('');
});

it('retains an existing running chat planner across navigation and accepts its result only in that draft', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w, live, progress } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Plan for this running chat'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  input.value = 'Unrelated draft'; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).not.toHaveBeenCalled();
  progress({ requestId, phase: 'generating', text: 'Original chat progress' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Original chat progress');
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  expect(input.value).toBe('Plan for this running chat');
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Original chat progress');
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  finish({ ok: true, data: ['Original first stage', 'Original checkpoint'] }); await settle();
  expect(input.value).toBe('Unrelated draft');
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(input.value).toBe('');
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: summary([]).id, mode: 'finish', text: 'Original first stage', stages: ['Original checkpoint'] });
});

it('keeps two planner owners independent and ignores a cancelled result after returning to its chat', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w, live } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  const pending = new Map<string, (value: any) => void>();
  api.draftTaskPlan = vi.fn((text: string) => new Promise(resolve => { pending.set(text, resolve); }));
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const generate = () => w.document.getElementById('createPlan')!.click();
  const select = async (id: string) => { (w.document.querySelector(`#sessionList [data-id="${id}"]`) as HTMLElement).click(); await settle(); };
  input.value = 'Plan A'; generate(); await settle();
  const requestA = api.draftTaskPlan.mock.calls[0][2];
  await select(second.id);
  input.value = 'Plan B'; generate(); await settle();
  pending.get('Plan A')!({ ok: true, data: ['A first', 'A check'] }); await settle();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  await select(first.id);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('A first');
  await select(second.id);
  const requestB = api.draftTaskPlan.mock.calls[1][2];
  generate(); // Explicitly cancel B; A and navigation did not cancel it.
  expect(api.cancelTaskRequest.mock.calls).toEqual([[requestB]]);
  expect(api.cancelTaskRequest).not.toHaveBeenCalledWith(requestA);
  input.value = 'B replacement'; generate(); await settle();
  pending.get('Plan B')!({ ok: true, data: ['Stale B result'] }); await settle();
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Stale B');
  pending.get('B replacement')!({ ok: false, error: 'Planner unavailable' }); await settle();
  await select(first.id); await select(second.id);
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Planner unavailable');
  expect(input.value).toBe('B replacement');
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: first.id, text: 'A first', mode: 'finish' });
});

it('renders existing-chat Goal draft stages from main controls without starting another request', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let draft = { stage: 'answering', stageStartedAt: Date.now() - 65_000,
    model: 'fixture', text: 'Actual continuation text', error: null as string | null };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'goal', goalDraft: draft } });
  const opening = vi.fn(); api.draftGoalOpening = opening;
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Drafting the next continuation');
  expect(row.textContent).not.toContain('Actual continuation text');
  expect(row.querySelector('[role="timer"]')?.textContent).toMatch(/^1:0[5-6]$/);
  expect(row.getAttribute('aria-busy')).toBe('true');
  draft = { ...draft, stage: 'ready' }; await append([]);
  expect(row.textContent).toContain('awaiting ChatGPT delivery');
  draft = { ...draft, stage: 'failed', error: 'no_api_key' }; await append([]);
  expect(row.textContent).toContain('No API key is configured for the continuation provider.');
  expect(row.textContent).not.toContain('no_api_key');
  expect(row.getAttribute('aria-busy')).toBe('false');
  expect(opening).not.toHaveBeenCalled();
});

it('renders an outbox-owned continuation without claiming Goal completion or active generation', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let draft = { stage: 'no-reply', stageStartedAt: Date.now(), outboxContinuationOwned: true,
    model: 'fixture', text: '', error: null };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', goalDraft: draft } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Continuation saved · delivery tracked');
  expect(row.textContent).not.toContain('Goal reached');
  expect(row.getAttribute('aria-busy')).toBe('false');
  expect(row.querySelector('.session-status.is-working')).toBeNull();
  draft = { ...draft, outboxContinuationOwned: false };
  await append([]);
  expect(row.textContent).toContain('Loop · Waiting for the main chat to continue');
  expect(row.textContent).not.toContain('Goal finished');
  expect(row.textContent).not.toContain('Goal reached');
});

it('renders a provider approval as human attention without a busy marker, countdown or request', async () => {
  const { w, append, live } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', goalDraft: null, goalWait: { reason: 'approval', until: Date.now() + 60_000,
      detail: APPROVAL_WAITING_TEXT, nextAction: 'Review the native card in this chat.' } } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain(APPROVAL_WAITING_TEXT);
  expect(row.getAttribute('aria-busy')).toBe('false');
  expect(row.querySelector('.session-status.is-working')).toBeNull();
  expect(row.querySelector('[role="timer"]')).toBeNull();
  expect(live.sent).toEqual([]);
  expect(live.controlCalls).toEqual([]);
});

it('renders unresolved native final evidence as non-busy unknown without a recovery timer or request', async () => {
  const { w, append, live } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', goalDraft: null, goalWait: { reason: 'evidence',
      detail: 'Exact native tool completion remains unresolved.',
      nextAction: 'Keep current work; this status authorizes no replay.' } } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Exact native tool completion remains unresolved');
  expect(row.getAttribute('aria-busy')).toBe('false');
  expect(row.querySelector('.session-status.is-working')).toBeNull();
  expect(row.querySelector('[role="timer"]')).toBeNull();
  expect(live.sent).toEqual([]);
  expect(live.controlCalls).toEqual([]);
});

it('aligns selected Loop inline, sidebar and Work status with a newer exact unresolved-native-tool hold', async () => {
  const now = Date.now();
  const row = { ...summary([]), id: 'loop-unverified-native-finish', title: 'Native final / tool evidence mismatch',
    conversationId: 'loop-unverified-native-provider', chatIds: ['loop-unverified-native-provider'],
    activeTurnId: null as string | null, lastToolCallAt: now - 400, lastAssistantFinalAt: now - 1200,
    lastTurnOutcome: null, fileEdits: 1, lastFileChangeAt: now - 700 };
  const unresolved = {
    reason: 'evidence' as const,
    detail: 'Exact native tool completion remains unresolved; the final page is not proof of a finished tool.',
    nextAction: 'Inspect the native tool/error state; do not replay any input.',
    until: now + 60_000 // A stale deadline must not animate an unverified evidence hold.
  };
  const controls = { conversationId: row.conversationId, automation: 'loop', activeTurnId: null as string | null,
    goalWait: unresolved as typeof unresolved | null };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: now - 3_000, targetLanes: 1,
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 0 },
    chats: [{
      sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: 'working', spinning: true,
      reason: 'Older current-generation signal before the exact final/tool evidence read.',
      nextAction: 'Keep observing generation.',
      nextRetryAt: null, lastWorkedAt: now - 1_000,
      activeWorkers: 0, recoverable: false, recoveryStage: null
    }]
  };
  const final: SessionEvent = { kind: 'assistant_message', seq: 2, time: now - 1_200,
    source: 'extension', turnId: 'previous-native-final', messageId: 'native-result-saved',
    final: true, message: text('Recorded final body exists; original mission acceptance remains open.') };
  const app = await boot([toolCall(1, 'recorded-tool-evidence'), final], true, [], [], {
    sessions: [row], sessionEvents: { [row.id]: [toolCall(1, 'recorded-tool-evidence'), final] },
    automation, controls
  });
  await settle();
  const doc = app.w.document;
  const lifecycle = doc.getElementById('goalLifecycle')!;
  expect(lifecycle.textContent).toContain(unresolved.detail);
  expect(lifecycle.getAttribute('aria-busy')).toBe('false');
  expect(lifecycle.querySelector('[role="timer"]')).toBeNull();
  const sidebar = doc.querySelector<HTMLElement>(`#sessionList [data-id="${row.id}"]`)!;
  expect(sidebar.querySelector('.sess-automation-state')?.textContent).toContain('unknown');
  expect(sidebar.title).toContain(unresolved.detail);
  expect(sidebar.querySelector('.session-status.is-working')).toBeNull();
  const inline = doc.getElementById('chatState')!;
  expect(inline.textContent).toContain('unknown');
  expect(inline.getAttribute('aria-label')).toContain(unresolved.nextAction);
  expect(inline.classList.contains('is-working')).toBe(false);
  expect(doc.getElementById('automationSupervisorSummary')!.textContent).not.toContain('working');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('working');
  const current = doc.querySelector<HTMLButtonElement>(
    `.work-overview-section[data-work-section="current"] [data-session-id="${row.id}"]`)!;
  expect(current.textContent).toContain('unknown');
  current.click();
  await settle();
  const pane = doc.getElementById('workOverviewPane')!;
  const status = [...pane.querySelectorAll<HTMLElement>('.work-overview-pane-field')]
    .find(item => item.querySelector('b')?.textContent === 'Current status')?.textContent ?? '';
  expect(status).toContain(unresolved.detail);
  expect(status).toContain('unknown');
  expect(pane.querySelector('.work-overview-result')?.textContent).toContain('Recorded final body exists');
  // A distinct newer exact generation supersedes the old missing-completion
  // presentation. Neither the older hold nor saved result may veto real new work.
  row.activeTurnId = 'new-exact-turn';
  controls.activeTurnId = 'new-exact-turn';
  controls.goalWait = null;
  automation.observedAt = Date.now() + 1;
  automation.chats[0]!.reason = 'Fresh exact generation after the held native final.';
  app.notifySession();
  await settle(700);
  expect(doc.querySelector(`#sessionList [data-id="${row.id}"] .sess-automation-state`)?.textContent).toContain('working');
  expect(doc.getElementById('chatState')!.textContent).not.toContain(unresolved.detail);
  expect(doc.getElementById('workOverviewPane')!.textContent).not.toContain(unresolved.detail);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('does not override a current explicit provider block with an old evidence wait', async () => {
  const now = Date.now();
  const row = { ...summary([]), id: 'loop-real-block-before-unknown', title: 'Blocked state remains authoritative',
    conversationId: 'loop-provider-blocked', chatIds: ['loop-provider-blocked'], activeTurnId: null };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: now - 1_000, targetLanes: 1,
    counts: { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 1 },
    chats: [{
      sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: 'blocked', spinning: false,
      reason: 'Provider approval or sign-in is required.',
      nextAction: 'Review the existing native approval control.',
      nextRetryAt: null, lastWorkedAt: now - 1_000,
      activeWorkers: 0, recoverable: false, recoveryStage: null
    }]
  };
  const app = await boot([], true, [], [], { sessions: [row], automation, controls: {
    conversationId: row.conversationId, automation: 'loop', activeTurnId: null,
    goalWait: { reason: 'evidence', detail: 'Earlier unresolved final.', nextAction: 'Earlier action.' }
  } });
  await settle();
  const doc = app.w.document;
  expect(doc.querySelector(`#sessionList [data-id="${row.id}"] .sess-automation-state`)?.textContent).toContain('blocked');
  expect(doc.getElementById('chatState')?.textContent).toContain('Provider approval or sign-in');
  expect(doc.getElementById('workOverviewMeta')?.textContent).toContain('blocked');
  expect(doc.getElementById('automationSupervisorSummary')?.textContent).toContain('blocked');
  expect(doc.querySelector('.session-status.is-working')).toBeNull();
  expect(app.live.sent).toEqual([]);
});

it('does not revive unknown tool completion when an older controls read finishes after newer supervisor evidence', async () => {
  const now = Date.now();
  const row = { ...summary([]), id: 'loop-control-status-read-race', title: 'Final tool receipt pending',
    conversationId: 'loop-control-read-race-provider', chatIds: ['loop-control-read-race-provider'],
    activeTurnId: null as string | null };
  const chat: AutomationSupervisorSnapshot['chats'][number] = {
    sessionId: row.id, conversationId: row.conversationId!, title: row.title, mode: 'loop',
    state: 'working', spinning: true, reason: 'Current Main generation is running.',
    nextAction: 'Observe current execution.', nextRetryAt: null, lastWorkedAt: now,
    activeWorkers: 0, recoverable: false, recoveryStage: null
  };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: now - 10_000, targetLanes: 1, chats: [chat],
    counts: { working: 1, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0,
      stalled: 0, paused: 0, blocked: 0 }
  };
  const app = await boot([], true, [], [], { sessions: [row], automation,
    controls: { conversationId: row.conversationId, activeTurnId: null, automation: 'loop' } });
  const api = (app.w as any).api;
  const originalControls = api.getSessionControls;
  let resolveOlder!: (result: unknown) => void;
  let startedRead!: () => void;
  const started = new Promise<void>(resolve => { startedRead = resolve; });
  let intercepted = false;
  api.getSessionControls = (id: string) => {
    if (intercepted) return originalControls(id);
    intercepted = true;
    startedRead();
    return new Promise(resolve => { resolveOlder = resolve; });
  };
  app.notifySession();
  await started;
  // One supervisor observation arrives later than the exact Main-controls read
  // started but before that older response resolves. It proves a NEW status
  // version; resolving the older future must not resurrect its unknown hold.
  await settle(20);
  automation.observedAt = Date.now();
  chat.reason = 'A newer exact generation superseded the old missing-result hold.';
  resolveOlder({ ok: true, data: {
    ...(await originalControls(row.id)).data,
    sessionId: row.id, conversationId: row.conversationId, activeTurnId: null, automation: 'loop',
    goalWait: { reason: 'evidence', detail: 'OLD unknown tool completion from an earlier read.',
      nextAction: 'OLD evidence action; not a new generation.' }
  } });
  await settle(700);
  const doc = app.w.document;
  expect(doc.querySelector(`#sessionList [data-id="${row.id}"] .sess-automation-state`)?.textContent).toContain('working');
  expect(doc.getElementById('chatState')?.textContent).not.toContain('OLD unknown tool completion');
  expect(doc.getElementById('automationSupervisorSummary')?.textContent).toContain('working');
  expect(doc.getElementById('workOverviewMeta')?.textContent).not.toContain('unknown');
  expect(doc.getElementById('goalLifecycle')?.textContent).not.toContain('OLD unknown tool completion');
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it.each([
  { state: 'working' as const, stage: null, activeTurn: 'fresh-native-turn',
    reason: 'A new exact native turn and tool work are current.', expected: 'working' },
  { state: 'recovering' as const, stage: 'waiting-browser' as const, activeTurn: null,
    reason: 'Provider approval and Chrome availability are being rechecked.', expected: 'waiting for Chrome' },
  { state: 'waiting-workers' as const, stage: null, activeTurn: null,
    reason: 'An exact current worker is still active.', expected: 'waiting workers' }
])('does not substitute old unknown tool evidence for current $state authority', async scenario => {
  const now = Date.now();
  const row = { ...summary([]), id: 'superseded-evidence-status',
    conversationId: 'superseded-evidence-provider', chatIds: ['superseded-evidence-provider'],
    activeTurnId: scenario.activeTurn as string | null,
    lastToolCallAt: now - 200, activityExpiresAt: now + 60_000 };
  const automation: AutomationSupervisorSnapshot = {
    observedAt: now - 1_000, targetLanes: 1,
    counts: {
      working: scenario.state === 'working' ? 1 : 0,
      'waiting-workers': scenario.state === 'waiting-workers' ? 1 : 0,
      'waiting-main': 0, recovering: scenario.state === 'recovering' ? 1 : 0,
      stalled: 0, blocked: 0, paused: 0
    },
    chats: [{
      sessionId: row.id, conversationId: row.conversationId!, title: row.title,
      mode: 'loop', state: scenario.state, spinning: scenario.state === 'working',
      reason: scenario.reason, nextAction: 'Preserve the current exact owner.',
      nextRetryAt: null, lastWorkedAt: now,
      activeWorkers: scenario.state === 'waiting-workers' ? 1 : 0,
      recoverable: false, recoveryStage: scenario.stage
    }]
  };
  const events: SessionEvent[] = scenario.activeTurn
    ? [{ seq: 1, time: now - 900, source: 'extension', kind: 'turn_start',
      turnId: scenario.activeTurn }] : [];
  const app = await boot(events, true, [], [], {
    sessions: [row], automation, controls: { automation: 'loop', conversationId: row.conversationId,
      activeTurnId: scenario.activeTurn, goalWait: { reason: 'evidence',
        detail: 'Old unresolved native tool completion must not win.',
        nextAction: 'Old evidence action is no longer current.' } }
  });
  const doc = app.w.document;
  const state = doc.querySelector<HTMLElement>(`#sessionList [data-id="${row.id}"] .sess-automation-state`)!;
  expect(state.textContent).toContain(scenario.expected);
  expect(doc.getElementById('chatState')!.textContent!.toLowerCase()).toContain(scenario.expected.toLowerCase());
  expect(doc.getElementById('chatState')!.textContent).not.toContain('Old unresolved native tool');
  expect(doc.getElementById('goalLifecycle')?.textContent).not.toContain('Old unresolved native tool');
  expect(doc.getElementById('automationSupervisorSummary')!.textContent).not.toContain('unknown');
  expect(doc.getElementById('workOverviewMeta')!.textContent).not.toContain('unknown');
  expect(doc.querySelector(`.work-overview-section[data-work-section="current"] [data-session-id="${row.id}"]`)?.textContent)
    .toContain(scenario.expected);
  expect(app.live.sent).toEqual([]);
  expect(app.live.controlCalls).toEqual([]);
});

it('renders an exhausted Goal recovery as non-busy attention without a countdown', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let goalWait: object | null = {
    reason: 'attention', until: Date.now() + 30_000,
    detail: 'Automatic recovery stopped. The exact reply is saved and has not been confirmed sent.',
    nextAction: 'Inspect this chat, then use Recover stale for one bounded attempt.'
  };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', goalWait, goalDraft: null } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Automatic recovery stopped');
  expect(row.textContent).toContain('Recover stale');
  expect(row.getAttribute('aria-busy')).toBe('false');
  expect(row.querySelector('.session-status.is-working')).toBeNull();
  expect(row.querySelector('[role="timer"]')).toBeNull();
  expect(row.textContent).not.toContain('Next recovery check');
  goalWait = null;
  await append([]);
  expect(row.hidden).toBe(true);
});

it('shows the immediate recovery deadline before a draft exists and clears it on fresh work', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let goalWait: object | null = { reason: 'silence', until: Date.now() + 120_000 };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', goalWait, goalDraft: null } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Loop · Waiting before recovery reload');
  expect(row.querySelector('[role="timer"]')).not.toBeNull();
  goalWait = null;
  await append([]);
  expect(row.hidden).toBe(true);
});

it.each([
  { reason: 'silence', kind: 'silence' },
  { reason: 'listening', kind: 'post-reload' },
  { reason: 'native-busy', kind: 'native-busy' },
  { reason: 'quiet', kind: 'post-reload' }
] as const)('shows the shared $reason deadline once while keeping independent Loop waits', async ({ reason, kind }) => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  const deadline = Date.now() + 60_000;
  const goalWait = { reason, until: deadline };
  const recovery = [{ kind: kind as string, deadline, visibleAt: 0 }];
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', objective: 'Keep working', goalWait, recovery, goalDraft: null } });
  await append([]);
  const lifecycle = w.document.getElementById('goalLifecycle')!;
  expect(lifecycle.hidden).toBe(true);
  expect(lifecycle.querySelector('[role="timer"]')).toBeNull();
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(false);
  expect(w.document.getElementById('activeGoalRow')!.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(1);

  goalWait.until += 15_000;
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(2);

  goalWait.until = deadline; recovery[0]!.visibleAt = deadline - 15_000;
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);

  recovery[0]!.visibleAt = 0; recovery[0]!.kind = 'pickup';
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(2);
});

it.each([false, true])('does not redisplay an old reload receipt after the next turn starts (developer mode: %s)', async developerMode => {
  const reloadedAt = Date.now() - 60_000;
  const repair: SessionEvent = { seq: 1, time: reloadedAt, source: 'app', kind: 'progress',
    progressId: 'browser-repair:fixture', turnId: 'silent-turn',
    message: text('Reloaded chat to recover an unresponsive open turn.') };
  const { w, append, live } = await boot([repair], true, [], [], { developerMode });
  const host = w.document.getElementById('recoveryStatus')!;
  expect(host.hidden).toBe(false);
  await append([{ seq: 2, time: Date.now(), source: 'app', kind: 'turn_start', turnId: 'silent-turn' }]);
  expect(host.hidden).toBe(false);
  await append([
    { seq: 3, time: Date.now(), source: 'extension', kind: 'user_message', messageId: 'continue-message', message: text('Continue the work.') },
    { seq: 4, time: Date.now(), source: 'extension', kind: 'turn_start', turnId: 'continued-turn' }
  ]);
  expect(host.hidden).toBe(true);
  expect(live.events).toContainEqual(repair);
  if (developerMode) expect(w.document.getElementById('timeline')!.textContent).toContain(repair.message.text);
  await append([{ ...repair, seq: 5, time: Date.now(), turnId: 'continued-turn', progressId: 'browser-repair:new-turn' }]);
  expect(host.hidden).toBe(false);
});

it('reuses the Goal animation for a session-finish draft while ordinary automation is off', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let finishGoalDraft: object | null = { stage: 'answering', model: 'fixture', text: 'Next useful action', error: null };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'off', finishGoalDraft } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Drafting the next continuation');
  expect(row.textContent).not.toContain('Next useful action');
  expect(row.getAttribute('aria-busy')).toBe('true');
  finishGoalDraft = null; await append([]);
  expect(row.hidden).toBe(true);
  expect(row.getAttribute('aria-busy')).toBe('false');
});

it('shows the active finish animation after an earlier ordinary Goal save failed', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let finishGoalDraft: object | null = null;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'goal', finishGoalDraft } });
  api.setSessionObjective = vi.fn(async () => ({ ok: false, error: 'Save failed' }));
  await append([]);
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Verify remaining work'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click(); await settle();
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Task could not be saved');
  finishGoalDraft = { stage: 'answering', model: 'fixture', text: 'Check the active task', error: null };
  await append([]);
  expect(row.textContent).toContain('Drafting the next continuation');
  expect(row.textContent).not.toContain('Check the active task');
  expect(row.textContent).not.toContain('Task could not be saved');
  expect(row.getAttribute('aria-busy')).toBe('true');
  expect(row.querySelector('.session-status.is-working')).not.toBeNull();
});

it('offers Generate Goal only at an empty finish wait and preserves the manual draft', async () => {
  const { w, append, live } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let waiting = false;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, finishWaiting: waiting } });
  const generate = vi.fn(async () => ({ ok: true, data: 'Goal queued' })); api.generateFinishGoal = generate;
  const button = w.document.getElementById('generateFinishGoal') as HTMLButtonElement;
  await append([]); expect(button.hidden).toBe(true);
  waiting = true; await append([]); expect(button.hidden).toBe(false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'My own follow-up'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect(input.disabled).toBe(false);
  button.click(); await settle();
  expect(generate).toHaveBeenCalledWith(summary(live.events).id, 'held-turn');
  expect(input.value).toBe('My own follow-up');
  live.inputs.push({ id: 'pending', sessionId: summary(live.events).id, state: 'queued', mode: 'finish', text: 'Prior task', dueAt: Date.now(), createdAt: Date.now() } as InputEntry);
  await append([]); expect(button.hidden).toBe(true);
  button.click(); await settle(); expect(generate).toHaveBeenCalledTimes(1);
});

it('offers a per-task post-turn opt-in only for Astra', async () => {
  const { w, live, append } = await boot([]);
  const current = summary([]);
  live.inputs.push({ id: 'choice-task', sessionId: current.id, text: 'Next task', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  expect(w.document.querySelector('.queue-delivery')).toBeNull();
  current.selectedModel = { conversationId: 'chat-b', model: 'gpt-6-pro', reasoningEffort: 'pro', observedAt: T0 };
  (w as any).api.listSessions = async () => ({ ok: true, data: { sessions: [current], activeId: current.id, pressure: [] } });
  (w as any).api.getSession = async () => ({ ok: true, data: { summary: current, events: [], total: 0, nextFrom: 0 } });
  const edit = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.editQueuedInput = edit;
  await append([]);
  const toggle = w.document.querySelector<HTMLButtonElement>('.queue-delivery');
  expect(toggle?.getAttribute('aria-pressed')).toBe('false');
  toggle!.click();
  await settle();
  expect(edit).toHaveBeenCalledWith('choice-task', 'Next task', true);
});

it.each([
  { label: 'durable stale-state rejection', reply: { ok: true as const, data: false }, disabled: true },
  { label: 'IPC failure', reply: { ok: false as const, error: 'Could not change task delivery.' }, disabled: false }
])('keeps Astra finish-delivery toggle $label fenced correctly while refresh is unavailable', async ({ reply, disabled }) => {
  const current = summary([]);
  current.selectedModel = { conversationId: 'chat-b', model: 'gpt-6-pro', reasoningEffort: 'pro', observedAt: T0 };
  const { w, live, append } = await boot([], true, [], [], { sessions: [current] });
  live.inputs.push({ id: 'choice-task-authority', sessionId: current.id, text: 'Next task', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  const edit = vi.fn(async () => reply);
  (w as any).api.editQueuedInput = edit;
  (w as any).api.listInputs = () => new Promise(() => {});
  const toggle = w.document.querySelector<HTMLButtonElement>('.queue-delivery')!;

  toggle.click();
  await settle();

  expect(edit).toHaveBeenCalledWith('choice-task-authority', 'Next task', true);
  expect(toggle.disabled).toBe(disabled);
});

it('opens every selected chat at the bottom and preserves manual reading during live updates', async () => {
  const rows = Array.from({ length: 160 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `opening-${i}`, message: text(`Opening item ${i + 1}`) }));
  const first = summary(rows), second = { ...summary(rows), id: '2026-09-02-test0002', title: 'Other chat' };
  const { w, append } = await boot(rows, false, [], [], { sessions: [first, second] });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  const select = async (id: string) => {
    (w.document.querySelector(`#sessionList [data-id="${id}"]`) as HTMLElement).click();
    await settle();
    expect(pane.scrollTop).toBe(pane.scrollHeight); // Chromium clamps to the actual bottom.
  };
  const readTo = (top: number) => {
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    pane.scrollTop = top;
    pane.dispatchEvent(new w.Event('scroll'));
  };
  await select(first.id);
  for (let i = 0; i < 3; i++) {
    readTo(700);
    await append([]);
    expect(pane.scrollTop).toBe(700);
    await select(second.id);
    pane.scrollTop = 0;
    await select(first.id);
  }

  // A late opening response must neither replace the current chat nor drag its reader down.
  const api = (w as any).api, original = api.getSession;
  const pending: Array<() => void> = [];
  api.getSession = async (id: string, options: unknown) => {
    await new Promise<void>(resolve => pending.push(resolve));
    return original(id, options);
  };
  await append([]); // Old A refresh is still in flight when A -> B -> A begins.
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click();
  expect(pending).toHaveLength(3);
  pending[2]!(); await settle();
  expect(pane.scrollTop).toBe(pane.scrollHeight);
  readTo(850);
  pending[1]!(); pending[0]!(); await settle();
  expect(pane.scrollTop).toBe(850);
  expect(w.document.getElementById('chatTitle')!.textContent).toBe(first.title);
});

it.each([
  { setting: undefined, readerScrolled: false, follows: true },
  { setting: undefined, readerScrolled: true, follows: false },
  { setting: false, readerScrolled: false, follows: false }
])('follows repaint growth by reader intent (setting $setting, reader scrolled $readerScrolled)', async ({ setting, readerScrolled, follows }) => {
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `follow-${i}`, message: text(`Follow item ${i + 1}`) }));
  const { w, append } = await boot(rows, true, [], [], setting === undefined ? {} : { followOutput: setting });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  pane.scrollTop = pane.scrollHeight;
  if (readerScrolled) pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
  pane.scrollTop = 300;
  pane.dispatchEvent(new w.Event('scroll'));
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
    messageId: 'follow-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollTop).toBe(follows ? pane.scrollHeight : 300);
});

it('does not follow repaint growth from the old bottom when Follow Output is disabled', async () => {
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `disabled-follow-${i}`,
    message: text(`Disabled follow item ${i + 1}`) }));
  const { w, append } = await boot(rows, true, [], [], { followOutput: false });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  pane.scrollTop = pane.scrollHeight;
  const oldBottom = pane.scrollTop;
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
    messageId: 'disabled-follow-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollHeight).toBeGreaterThan(oldBottom);
  expect(pane.scrollTop).toBe(oldBottom);
});

it('follows layout-only growth, pauses on a reader scroll, and resumes only at the end', async () => {
  let resize!: () => void;
  class TestResizeObserver {
    constructor(callback: () => void) { resize = callback; }
    observe(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = TestResizeObserver;
  const { w } = await boot([]);
  const pane = w.document.getElementById('chatBody')!;
  let contentHeight = 1000;
  let scrollTop = 0;
  Object.defineProperties(pane, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, get: () => contentHeight },
    scrollTop: { configurable: true, get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, contentHeight - 400)); } }
  });
  pane.scrollTop = 600;
  resize();

  contentHeight = 1200;
  resize();
  expect(pane.scrollTop).toBe(800);

  pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
  pane.scrollTop = 200;
  pane.dispatchEvent(new w.Event('scroll'));
  contentHeight = 1400;
  resize();
  expect(pane.scrollTop).toBe(200);

  pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100 }));
  pane.scrollTop = contentHeight - pane.clientHeight;
  pane.dispatchEvent(new w.Event('scroll'));
  contentHeight = 1600;
  resize();
  expect(pane.scrollTop).toBe(1200);
});

it('keeps a bottom-following chat at its end when the visible area shrinks', async () => {
  let resize!: () => void;
  class TestResizeObserver {
    constructor(callback: () => void) { resize = callback; }
    observe(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = TestResizeObserver;
  const { w } = await boot([]);
  const pane = w.document.getElementById('chatBody')!;
  let height = 400;
  Object.defineProperties(pane, {
    clientHeight: { configurable: true, get: () => height },
    scrollHeight: { configurable: true, get: () => 1000 }
  });
  pane.scrollTop = 600;
  pane.dispatchEvent(new w.Event('scroll'));
  height = 300;
  resize();
  expect(pane.scrollTop).toBe(1000);
  pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
  pane.scrollTop = 100;
  pane.dispatchEvent(new w.Event('scroll'));
  height = 200;
  resize();
  expect(pane.scrollTop).toBe(100);
});

it('loads bounded earlier pages on deliberate upward scrolling without draining on render', async () => {
  const rows = Array.from({ length: 360 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `history-${i}`, message: text(`History item ${i + 1}`) }));
  const { w, append } = await boot(rows);
  const timeline = w.document.getElementById('timeline')!;
  const pane = w.document.getElementById('chatBody')!;
  expect(timeline.querySelector('[data-history="older"]')).toBeNull();
  pane.dispatchEvent(new w.Event('scroll')); await settle();
  expect(timeline.textContent).toContain('History item 360');
  expect(timeline.textContent).not.toContain('History item 121');
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 10000 });
  for (const row of timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')) row.getBoundingClientRect = () => {
    const top = [...timeline.querySelectorAll('[data-timeline-key]')].indexOf(row) * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) };
  };  const up = async () => { pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); await settleWheelFrame(w); };
  await up();
  expect(pane.scrollTop).toBe(1600);
  expect(timeline.textContent).toContain('History item 121');
  expect(timeline.textContent).not.toContain('History item 360');
  await append([{ seq: 361, time: T0 + 361, source: 'extension', kind: 'user_message', messageId: 'newest', message: text('Newest live input') }]);
  expect(timeline.textContent).toContain('History item 121');
  expect(timeline.textContent).not.toContain('Newest live input');
  await up(); expect(timeline.textContent).toContain('History item 41');
  await up(); expect(timeline.textContent).toContain('History item 1');
  expect(timeline.querySelectorAll('[data-timeline-key]').length).toBeLessThanOrEqual(160);
  (timeline.querySelector('[data-history="latest"]') as HTMLElement).click(); await settle();
  expect(timeline.textContent).toContain('Newest live input');
});
it('opens the earliest recorded page directly from the top-right history control', async () => {
  const rows = Array.from({ length: 360 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `jump-start-${i}`, message: text(`Original item ${i + 1}`) }));
  const { w } = await boot(rows);
  const timeline = w.document.getElementById('timeline')!;
  const pane = w.document.getElementById('chatBody')!;
  const start = w.document.getElementById('chatJumpStart') as HTMLButtonElement;
  expect(start.hidden).toBe(false);
  expect(timeline.textContent).toContain('Original item 360');
  expect(timeline.textContent).not.toContain('Original item 1');
  pane.scrollTop = 900;
  start.click(); await settle();
  expect(pane.scrollTop).toBe(0);
  expect(timeline.textContent).toContain('Original item 1');
  expect(timeline.textContent).not.toContain('Original item 360');
  expect(timeline.querySelector('[data-history="latest"]')).not.toBeNull();
});
it('scrolls forward through evicted history with wheel, keyboard and scrollbar, then resumes live deltas', async () => {
  const rows = Array.from({ length: 400 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `bidirectional-${i}`, message: text(`Bidirectional item ${i + 1}.`) }));
  const { w, live, append } = await boot(rows);
  const api = (w as any).api;
  const read = vi.fn(async (_id: string, options: { from?: number; before?: number; limit: number }) => {
    const eligible = live.events.filter(e => (options.from === undefined || e.seq >= options.from) && (options.before === undefined || e.seq < options.before));
    const page = options.from === undefined ? eligible.slice(-options.limit) : eligible.slice(0, options.limit);
    return { ok: true, data: { summary: summary(live.events), events: page, total: live.events.length,
      nextFrom: page.reduce((next, e) => Math.max(next, e.seq + 1), options.from ?? 0) } };
  });
  api.getSession = read;
  const timeline = w.document.getElementById('timeline')!;
  const pane = w.document.getElementById('chatBody')!;
  Object.defineProperties(pane, { clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, get: () => timeline.querySelectorAll('[data-timeline-key]').length * 20 } });
  // Model one layout snapshot per DOM revision. A selector scan inside every
  // rectangle read made this mock quadratic and exhausted Windows CI's timeout.
  let geometryRows: Map<Element, number> | null = null;
  const geometryChanges = new w.MutationObserver(() => { geometryRows = null; });
  geometryChanges.observe(timeline, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-timeline-key'] });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (geometryChanges.takeRecords().length) geometryRows = null;
    geometryRows ??= new Map([...timeline.querySelectorAll('[data-timeline-key]')].map((row, index) => [row, index]));
    const index = geometryRows.get(this) ?? -1;
    const top = index < 0 ? 0 : index * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20 } as DOMRect;
  };
  for (let i = 0; i < 3; i++) {
    pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); await settleWheelFrame(w);
  }
  expect(timeline.textContent).toContain('Bidirectional item 1.');
  expect(timeline.textContent).not.toContain('Bidirectional item 400.');
  const downward = async (kind: string) => {
    pane.scrollTop = pane.scrollHeight - pane.clientHeight;
    const anchor = timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')[140]!;
    const before = anchor.getBoundingClientRect().top;
    if (kind === 'wheel') pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100 }));
    else if (kind === 'keyboard') pane.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'PageDown' }));
    else {
      pane.scrollTop -= 100;
      pane.dispatchEvent(new w.Event('pointerdown'));
      pane.scrollTop += 100; pane.dispatchEvent(new w.Event('scroll'));
      w.dispatchEvent(new w.Event('pointerup'));
    }
    if (kind === 'wheel') await settleWheelFrame(w);
    else await settle();
    expect(anchor.isConnected).toBe(true);
    expect(anchor.getBoundingClientRect().top).toBe(before);
    expect(timeline.querySelectorAll('[data-timeline-key]').length).toBeLessThanOrEqual(160);
    const count = read.mock.calls.length;
    pane.dispatchEvent(new w.Event('scroll')); await settle();
    expect(read).toHaveBeenCalledTimes(count);
  };
  await downward('wheel');
  expect(timeline.textContent).toContain('Bidirectional item 240.');
  await downward('keyboard');
  expect(timeline.textContent).toContain('Bidirectional item 320.');
  await downward('scrollbar');
  expect(timeline.textContent).toContain('Bidirectional item 400.');
  await downward('wheel'); // Empty forward page proves we reached the current tail.
  await append([{ seq: 401, time: T0 + 401, source: 'extension', kind: 'user_message', messageId: 'live-again', message: text('Live again') }]);
  expect(timeline.textContent).toContain('Live again');
  geometryChanges.disconnect();
});

it('keeps admitting newer data when dense collapsed activity reaches the resident bound', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => toolCall(i + 1, `dense-${i}`));
  const { w, live, append } = await boot(rows);
  const api = (w as any).api;
  api.getSession = async (_id: string, options: { from?: number; before?: number; limit: number }) => {
    const eligible = live.events.filter(e => (options.from === undefined || e.seq >= options.from) && (options.before === undefined || e.seq < options.before));
    const page = options.from === undefined ? eligible.slice(-options.limit) : eligible.slice(0, options.limit);
    return { ok: true, data: { summary: summary(live.events), events: page, total: live.events.length,
      nextFrom: page.reduce((next, e) => Math.max(next, e.seq + 1), options.from ?? 0) } };
  };
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 400 } });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: 0, bottom: this.classList.contains('tool-group') ? 30 : 0,
      height: this.classList.contains('tool-group') ? 30 : 0 } as DOMRect;
  };
  const group = timeline.querySelector('.tool-group');
  for (let i = 0; i < 2; i++) {
    pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); await settleWheelFrame(w);
  }
  expect(timeline.querySelectorAll('.ev-tool_call')).toHaveLength(320);
  expect(timeline.querySelector('.tool-group')).toBe(group);
  pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100 })); await settleWheelFrame(w);
  await append([{ seq: 401, time: T0 + 401_000, source: 'extension', kind: 'user_message',
    messageId: 'dense-live', message: text('New data at the resident bound') }]);
  expect(timeline.textContent).toContain('New data at the resident bound');
  expect(timeline.querySelectorAll('.ev').length).toBeLessThanOrEqual(320);
});

it.each(['older', 'newer'])('does not apply a %s-page response or scroll after switching to a new chat', async direction => {
  const rows = Array.from({ length: 200 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `prior-${i}`, message: text(`Prior row ${i}`) }));
  const { w } = await boot(rows);
  const api = (w as any).api;
  const pane = w.document.getElementById('chatBody')!;
  if (direction === 'newer') {
    pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); await settleWheelFrame(w);
  }
  const original = api.getSession;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  api.getSession = async (id: string, options: any) => { if (options?.before || options?.from) await pending; return original(id, options); };
  pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: direction === 'older' ? -100 : 100 }));
  await settleWheelFrame(w);
  (w.document.getElementById('newChat') as HTMLElement).click(); await settle();
  pane.scrollTop = 73;
  release(); await settle();
  expect(w.document.getElementById('timeline')!.textContent).not.toContain('Prior row');
  expect(pane.scrollTop).toBe(73);
});

it('clears a delivered check when later model activity arrives without a timer', async () => {
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:receipt', inputId: 'receipt', inputDelivery: 'confirmed', message: text('Continue') };
  const app = await boot([message]);
  const receipt = app.w.document.querySelector('.input-receipt') as HTMLElement;
  expect(receipt.hidden).toBe(false);
  await app.append([toolCall(2, 'next-tool')]);
  expect(app.w.document.querySelector('.input-receipt')).toBe(receipt);
  expect(receipt.hidden).toBe(true);
});


it.each(['finish', 'rotation-cancelled', 'rotation-failed'] as const)('keeps a retired automatic draft at its creation time (%s)', async kind => {
  const app = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'before-draft', message: text('Original work') },
    { seq: 2, time: T0 + 2000, source: 'extension', kind: 'user_message', messageId: 'after-draft', message: text('Later continuation') }
  ]);
  const { w, live } = app;
  live.inputs.push({ id: 'retired-auto', sessionId: summary([]).id, conversationId: 'chat-b', text: 'Unused automatic instruction',
    mode: 'auto', dueAt: T0 + 1000, createdAt: T0 + 1000, state: kind === 'rotation-failed' ? 'failed' : 'cancelled', owner: null, model: null, reasoningEffort: null,
    ...(kind === 'finish' ? { finishOwner: { turnId: 'old-turn', periodic: false } } : { purpose: 'rotation' as const }),
    error: 'Automatic follow-up cancelled because its active turn or setting changed.' });
  await app.append([]);
  const timeline = w.document.getElementById('timeline')!;
  const retired = timeline.querySelector<HTMLElement>('[data-input-id="retired-auto"]')!;
  expect(retired).not.toBeNull();
  expect(retired.querySelector('time')!.textContent).toBe(new Date(T0 + 1000).toLocaleString());
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Unused automatic instruction');
  const before = () => timeline.textContent!.indexOf('Unused automatic instruction') < timeline.textContent!.indexOf('Later continuation');
  expect(before()).toBe(true);
  await app.append([{ seq: 3, time: T0 + 3000, source: 'extension', kind: 'assistant_message', messageId: 'new-progress', message: text('New work continues'), final: false }]);
  expect(timeline.querySelector('[data-input-id="retired-auto"]')).toBe(retired);
  expect(before()).toBe(true);
  expect(live.sent).toHaveLength(0);
  retired.querySelector<HTMLButtonElement>('[title="Dismiss delivery notice"]')!.click();
  await app.append([]);
  expect(timeline.textContent).not.toContain('Unused automatic instruction');
  expect(live.sent).toHaveLength(0);
});


it.each([
  { name: 'completed Goal', mode: 'goal', objective: 'Finish the real task', owned: false, expected: 'Goal finished', hidden: false },
  { name: 'retained stopped Goal', mode: 'off', objective: 'Finish the real task', owned: false, expected: 'Automation stopped', hidden: false },
  { name: 'ordinary Off chat', mode: 'off', objective: '', owned: false, expected: '', hidden: true },
  { name: 'owned outbox continuation', mode: 'goal', objective: 'Finish the real task', owned: true, expected: 'Continuation saved', hidden: false }
])('shows truthful terminal state for $name', async ({ mode, objective, owned, expected, hidden }) => {
  const { w, live } = await boot([], true, [], [], { controls: { automation: mode, activeTurnId: null, objective,
    goalDraft: mode === 'goal' ? { stage: 'no-reply', stageStartedAt: Date.now(), model: 'fixture', text: '', outboxContinuationOwned: owned } : null } });
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(hidden);
  if (!hidden) { expect(row.textContent).toContain(expected); expect(row.getAttribute('aria-busy')).toBe('false'); }
  if (owned || mode === 'off') expect(row.textContent).not.toContain('Goal finished');
  expect(live.sent).toEqual([]);
});


it.each(['evidence','active-turn'] as const)('does not mark a retained no-reply decision finished during %s', async reason => {
  const { w, live }=await boot([],true,[],[],{controls:{automation:'goal',objective:'Complete original scope',activeTurnId:reason==='active-turn'?'later-native-turn':null,goalWait:reason==='evidence'?{reason:'evidence',detail:'Missing exact receipt'}:null,goalDraft:{stage:'no-reply',stageStartedAt:Date.now(),model:'fixture',text:''}}});
  const row=w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);expect(row.textContent).not.toContain('Goal finished');
  if(reason==='evidence')expect(row.textContent).toContain('Missing exact receipt');
  expect(live.sent).toEqual([]);
});

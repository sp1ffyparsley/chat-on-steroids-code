import { readDurable, writeDurableSoon } from './durable.js';
import { logInfo, logWarn } from './logger.js';

const ROTATION_STATE = 'automation-rotation';
const ROTATION_VERSION = 4;
const FOREGROUND_START_GRACE_MS = 30_000;
/** A slot with no durable chat progress yields without deleting or disabling its Loop. */
export const ROTATION_STALL_MS = 15 * 60_000;

export type AutomationRotationCandidate = {
  conversationId: string;
  /** Creation/enablement priority. Newer chats enter at the front of the waiting queue. */
  priorityAt: number;
  /** Newest durable message/turn/tool progress observed for this chat. */
  progressAt?: number;
};

type DurableAutomationRotation = {
  version: 4;
  active: string[];
  activeSince: Record<string, number>;
  queue: string[];
  attention: Array<{ conversationId: string; stalledAt: number; lastProgressAt: number }>;
  foreground: Array<{ conversationId: string; grantedAt: number; seenBusy: boolean }>;
  enrolled: string[];
  membershipInitialized: boolean;
  previous: string[];
  rotatedAt: number;
  activatedAt: number;
  draining: boolean;
  drainingAt: number;
};

export type AutomationRotationView = {
  enabled: boolean;
  batchSize: number;
  cycleMs: number;
  activatedAt: number;
  draining: boolean;
  active: readonly string[];
  attention: readonly string[];
  foreground: readonly string[];
  foregroundSlots: number;
  enrolled: readonly string[];
  previous: readonly string[];
  rotatedAt: number;
  busyActive: readonly string[];
  queue: readonly string[];
  nextRotationAt: number | null;
  drainingAt: number;
};

let state: DurableAutomationRotation = {
  version: ROTATION_VERSION,
  active: [],
  activeSince: {},
  queue: [],
  attention: [],
  foreground: [],
  enrolled: [],
  membershipInitialized: false,
  previous: [],
  rotatedAt: 0,
  activatedAt: 0,
  draining: false,
  drainingAt: 0
};
let enabled = false;
let batchSize = 5;
let cycleMs = 30 * 60_000;
let foregroundSlots = 2;
let restored = false;
let reconciled = false;
let busyActive: string[] = [];

function unique(rows: readonly string[]): string[] {
  return [...new Set(rows.filter(Boolean))];
}

function snapshot(): DurableAutomationRotation {
  return {
    version: ROTATION_VERSION,
    active: [...state.active],
    activeSince: { ...state.activeSince },
    queue: [...state.queue],
    attention: state.attention.map(row => ({ ...row })),
    foreground: state.foreground.map(row => ({ ...row })),
    enrolled: [...state.enrolled],
    membershipInitialized: state.membershipInitialized,
    previous: [...state.previous],
    rotatedAt: state.rotatedAt,
    activatedAt: state.activatedAt,
    draining: state.draining,
    drainingAt: state.drainingAt
  };
}

function signature(value: DurableAutomationRotation): string {
  return `${value.active.join(',')}|${Object.entries(value.activeSince).sort().map(([id, at]) => `${id}:${at}`).join(',')}|` +
    `${value.queue.join(',')}|${value.attention.map(row => `${row.conversationId}:${row.stalledAt}:${row.lastProgressAt}`).join(',')}|${value.foreground.map(row =>
    `${row.conversationId}:${row.grantedAt}:${row.seenBusy ? 1 : 0}`).join(',')}|${value.enrolled.join(',')}|` +
    `${value.membershipInitialized}|${value.previous.join(',')}|${value.rotatedAt}|` +
    `${value.activatedAt}|${value.draining}|${value.drainingAt}`;
}

function persistIfChanged(before: string): void {
  if (signature(state) !== before) writeDurableSoon(ROTATION_STATE, snapshot());
}

/** Restores only queue order. Eligibility is reconciled against live sessions before dispatch. */
export async function restoreAutomationRotation(): Promise<void> {
  if (restored) return;
  restored = true;
  const saved = await readDurable<Partial<DurableAutomationRotation> & { version?: number }>(ROTATION_STATE);
  if (!saved || ![1, 2, 3, ROTATION_VERSION].includes(saved.version ?? 0) ||
      !Array.isArray(saved.active) || !Array.isArray(saved.queue)) return;
  const savedForeground = Array.isArray(saved.foreground) ? saved.foreground : [];
  state = {
    version: ROTATION_VERSION,
    active: unique(saved.active.filter((id): id is string => typeof id === 'string')),
    activeSince: saved.activeSince && typeof saved.activeSince === 'object'
      ? Object.fromEntries(Object.entries(saved.activeSince).filter((row): row is [string, number] =>
        typeof row[0] === 'string' && typeof row[1] === 'number' && Number.isFinite(row[1])))
      : {},
    queue: unique(saved.queue.filter((id): id is string => typeof id === 'string')),
    attention: Array.isArray(saved.attention) ? saved.attention.flatMap(row => row && typeof row === 'object' &&
      typeof row.conversationId === 'string' && typeof row.stalledAt === 'number' && Number.isFinite(row.stalledAt) &&
      typeof row.lastProgressAt === 'number' && Number.isFinite(row.lastProgressAt)
      ? [{ conversationId: row.conversationId, stalledAt: row.stalledAt, lastProgressAt: row.lastProgressAt }]
      : []) : [],
    foreground: savedForeground.flatMap(row => row && typeof row === 'object' &&
      typeof row.conversationId === 'string' && typeof row.grantedAt === 'number' && Number.isFinite(row.grantedAt)
      ? [{ conversationId: row.conversationId, grantedAt: row.grantedAt, seenBusy: row.seenBusy === true }]
      : []),
    enrolled: Array.isArray(saved.enrolled)
      ? unique(saved.enrolled.filter((id): id is string => typeof id === 'string'))
      : unique([...saved.active, ...saved.queue, ...savedForeground.map(row => row?.conversationId).filter((id): id is string => typeof id === 'string')]),
    membershipInitialized: saved.membershipInitialized === true || Number(saved.version) === 1,
    previous: Array.isArray(saved.previous)
      ? unique(saved.previous.filter((id): id is string => typeof id === 'string'))
      : [],
    rotatedAt: typeof saved.rotatedAt === 'number' && Number.isFinite(saved.rotatedAt) ? saved.rotatedAt : 0,
    activatedAt: typeof saved.activatedAt === 'number' && Number.isFinite(saved.activatedAt) ? saved.activatedAt : 0,
    draining: saved.draining === true,
    drainingAt: typeof saved.drainingAt === 'number' && Number.isFinite(saved.drainingAt)
      ? saved.drainingAt
      : saved.draining === true ? Date.now() : 0
  };
  state.queue = state.queue.filter(id => !state.active.includes(id) && !state.attention.some(row => row.conversationId === id));
  state.activeSince = Object.fromEntries(state.active.map(id => [id, state.activeSince[id] || state.activatedAt || Date.now()]));
  const foregroundIds = new Set(state.foreground.map(row => row.conversationId));
  state.active = state.active.filter(id => !foregroundIds.has(id));
  state.queue = state.queue.filter(id => !foregroundIds.has(id));
  logInfo(`automation rotation: restored ${state.active.length} active, ${state.foreground.length} foreground, ` +
    `${state.queue.length} queued, and ${state.attention.length} needing attention`);
}

/**
 * Gives one deliberately foregrounded chat a temporary slot without preempting the five-chat
 * batch. Existing active/queued chats keep their position: editing a queued Goal/Loop is a
 * metadata operation, not permission to jump the line. The caller invokes this only for a new
 * user-owned chat or an explicit single-chat activation.
 */
export function grantAutomationRotationForeground(conversationId: string, now = Date.now()): boolean {
  const current = automationRotationPosition(conversationId);
  if (!enabled || foregroundSlots <= 0 || !conversationId || (current && current.state !== 'attention')) return false;
  if (!state.enrolled.includes(conversationId)) state.enrolled.push(conversationId);
  state.membershipInitialized = true;
  state.attention = state.attention.filter(row => row.conversationId !== conversationId);
  if (state.foreground.length >= foregroundSlots) {
    state.queue = [conversationId, ...state.queue.filter(id => id !== conversationId)];
    writeDurableSoon(ROTATION_STATE, snapshot());
    return false;
  }
  state.foreground.push({ conversationId, grantedAt: now, seenBusy: false });
  state.active = state.active.filter(id => id !== conversationId);
  delete state.activeSince[conversationId];
  state.queue = state.queue.filter(id => id !== conversationId);
  writeDurableSoon(ROTATION_STATE, snapshot());
  logInfo(`automation rotation: granted foreground slot ${batchSize + state.foreground.length} to ${conversationId}`);
  return true;
}

/** The sole durable owner of explicit per-chat Rotation membership. */
export function setAutomationRotationMembership(conversationIds: readonly string[], enrolled: boolean): number {
  const ids = unique(conversationIds);
  if (!ids.length) return 0;
  const changed = ids.filter(id => state.enrolled.includes(id) !== enrolled).length;
  const before = signature(state);
  state.membershipInitialized = true;
  if (enrolled) {
    state.attention = state.attention.filter(row => !ids.includes(row.conversationId));
    state.enrolled = unique([...state.enrolled, ...ids]);
    state.queue = [...ids.filter(id => !state.active.includes(id) &&
      !state.foreground.some(row => row.conversationId === id)), ...state.queue.filter(id => !ids.includes(id))];
  } else {
    state.enrolled = state.enrolled.filter(id => !ids.includes(id));
    state.active = state.active.filter(id => !ids.includes(id));
    for (const id of ids) delete state.activeSince[id];
    state.queue = state.queue.filter(id => !ids.includes(id));
    state.attention = state.attention.filter(row => !ids.includes(row.conversationId));
    state.foreground = state.foreground.filter(row => !ids.includes(row.conversationId));
  }
  persistIfChanged(before);
  return changed;
}

export function automationRotationEnrolled(conversationId: string | null | undefined): boolean {
  return Boolean(conversationId && state.enrolled.includes(conversationId));
}

/**
 * A deliberate Resume all is the user's instruction to revisit every enrolled stalled chat.
 * Move those exact rows back into the fair queue and give already-active rows a fresh watchdog
 * window. Background maintenance never calls this function, so Needs attention remains a real
 * bounded stop until the user explicitly resumes.
 */
export function rearmAutomationRotationForExplicitResume(
  conversationIds: readonly string[],
  now = Date.now()
): number {
  if (!enabled) return 0;
  const eligible = new Set(unique(conversationIds).filter(id => state.enrolled.includes(id)));
  if (eligible.size === 0) return 0;
  const requeued = state.attention
    .filter(row => eligible.has(row.conversationId))
    .map(row => row.conversationId);
  const before = signature(state);
  state.attention = state.attention.filter(row => !eligible.has(row.conversationId));
  const foreground = new Set(state.foreground.map(row => row.conversationId));
  state.queue = unique([
    ...requeued,
    ...state.queue
  ]).filter(id => !state.active.includes(id) && !foreground.has(id));
  for (const id of state.active) if (eligible.has(id)) state.activeSince[id] = now;
  // Resume all starts one new rotation window. Keeping the pre-restart activatedAt made a
  // correctly restored batch enter "finishing" immediately even though the user had just
  // explicitly resumed it.
  state.activatedAt = now;
  state.draining = false;
  state.drainingAt = 0;
  persistIfChanged(before);
  if (requeued.length > 0) {
    logInfo(`automation rotation: explicit Resume returned ${requeued.length} Needs attention chat(s) to the fair queue`);
  }
  return requeued.length;
}

/**
 * Reconciles the one scheduler-owned rotation queue.
 *
 * A due batch first enters draining: it receives no new automatic browser work, but turns and
 * local tools that already crossed their send boundary keep running. The batch rotates only
 * after every active chat reaches the caller-proven safe set. New chats are prepended to the
 * waiting queue, so they lead the next batch without interrupting work already in flight.
 */
export function reconcileAutomationRotation(
  candidates: readonly AutomationRotationCandidate[],
  busyConversationIds: ReadonlySet<string>,
  options: { enabled: boolean; batchSize: number; cycleMs: number; foregroundSlots?: number },
  now = Date.now()
): AutomationRotationView {
  const adoptExistingWork = !reconciled || (!enabled && options.enabled);
  reconciled = true;
  enabled = options.enabled;
  batchSize = Math.max(1, Math.min(16, Math.floor(options.batchSize)));
  cycleMs = Math.max(60_000, Math.floor(options.cycleMs));
  foregroundSlots = Math.max(0, Math.min(3, Math.floor(options.foregroundSlots ?? 2)));
  if (!enabled) {
    busyActive = [];
    return automationRotationView(now);
  }

  const before = signature(state);
  if (!state.membershipInitialized) {
    state.enrolled = unique(candidates.map(row => row.conversationId));
    state.membershipInitialized = true;
  }
  const candidateIds = new Set(candidates.map(row => row.conversationId));
  state.enrolled = unique(state.enrolled);
  const eligible = new Set(state.enrolled.filter(id => candidateIds.has(id)));
  const releasedForeground: string[] = [];
  state.foreground = state.foreground.slice(0, foregroundSlots).filter(row => {
    if (!eligible.has(row.conversationId)) return false;
    if (busyConversationIds.has(row.conversationId)) {
      row.seenBusy = true;
      return true;
    }
    if (!row.seenBusy && now < row.grantedAt + FOREGROUND_START_GRACE_MS) return true;
    releasedForeground.push(row.conversationId);
    return false;
  });
  const foregroundIds = new Set(state.foreground.map(row => row.conversationId));
  state.active = unique(state.active).filter(id => eligible.has(id));
  state.active = state.active.filter(id => !foregroundIds.has(id));
  const attentionIds = new Set(state.attention.map(row => row.conversationId));
  state.attention = state.attention.filter(row => eligible.has(row.conversationId));
  for (const id of Object.keys(state.activeSince)) if (!state.active.includes(id)) delete state.activeSince[id];
  state.queue = unique(state.queue).filter(id => eligible.has(id) && !state.active.includes(id) &&
    !foregroundIds.has(id) && !attentionIds.has(id));
  if (releasedForeground.length) {
    state.queue = [...releasedForeground, ...state.queue.filter(id => !releasedForeground.includes(id))];
  }

  // The first reconciliation after launch is the only safe point to adopt work that was
  // already running before Rotation took control. Put those chats in the visible numbered
  // batch before restored idle members, then retain ordinary fair-queue order afterward.
  if (adoptExistingWork && busyConversationIds.size > 0) {
    const candidatePriority = new Map(candidates.map(row => [row.conversationId, row.priorityAt]));
    const working = [...busyConversationIds]
      .filter(id => eligible.has(id) && !foregroundIds.has(id))
      .sort((left, right) => (candidatePriority.get(right) ?? 0) - (candidatePriority.get(left) ?? 0) ||
        left.localeCompare(right));
    const ordered = unique([...working, ...state.active, ...state.queue]);
    const adopted = ordered.slice(0, batchSize);
    state.active = adopted;
    state.activeSince = Object.fromEntries(adopted.map(id => [id, state.activeSince[id] || now]));
    state.queue = ordered.slice(batchSize);
    // Startup has just re-proved these exact chats from current durable work. A persisted drain
    // belongs to the pre-restart batch and must not fence this newly adopted one; individual
    // turns/tools still retain their ordinary busy owners, so reopening admission cannot replay
    // them. Keeping the old latch is what made every restored worker command sit queued forever.
    if (state.draining) {
      state.draining = false;
      state.drainingAt = 0;
      state.activatedAt = now;
      logInfo('automation rotation: cleared the stale pre-restart finishing latch after current work was revalidated');
    }
    logInfo(`automation rotation: adopted ${working.filter(id => adopted.includes(id)).length} already-working chat(s) into numbered batch slots`);
  }

  const known = new Set([...state.active, ...state.queue, ...state.attention.map(row => row.conversationId), ...foregroundIds]);
  const newlyEligible = candidates
    .filter(row => eligible.has(row.conversationId) && !known.has(row.conversationId))
    .sort((left, right) => right.priorityAt - left.priorityAt || left.conversationId.localeCompare(right.conversationId))
    .map(row => row.conversationId);
  if (newlyEligible.length) state.queue = [...newlyEligible, ...state.queue];

  // One stuck slot must not pin the other chats forever. Progress is durable session evidence,
  // so a spinner/reload loop without a new message, turn end, tool call, or file change cannot
  // refresh this deadline. The chat stays enrolled and visible under Needs attention; an explicit
  // user send/retry grants it a foreground slot again.
  // A saved batch can already be draining when the app starts. Do not let one stale busy marker
  // pin that whole batch forever: the same per-slot watchdog still applies while draining. Only
  // the stale slot yields; healthy in-flight slots remain owned, and a replacement gets a fresh
  // rotation window. The yielded chat remains explicit and recoverable under Needs attention.
  const candidateProgress = new Map(candidates.map(row => [row.conversationId, row.progressAt ?? 0]));
  const stalled = state.active.filter(id => {
    const since = state.activeSince[id] || state.activatedAt || now;
    const progressAt = candidateProgress.get(id) ?? 0;
    return now - Math.max(since, progressAt) >= ROTATION_STALL_MS;
  });
  if (stalled.length) {
    for (const id of stalled) {
      const lastProgressAt = candidateProgress.get(id) ?? 0;
      state.attention = [
        ...state.attention.filter(row => row.conversationId !== id),
        { conversationId: id, stalledAt: now, lastProgressAt }
      ];
      delete state.activeSince[id];
      logWarn(`automation rotation: slot for ${id} made no durable progress for 15 minutes; ` +
        'moved it to Needs attention and promoted the next queued chat');
    }
    state.active = state.active.filter(id => !stalled.includes(id));
    if (state.draining) {
      state.draining = false;
      state.drainingAt = 0;
      state.activatedAt = now;
      logInfo('automation rotation: a stale slot yielded while the batch was finishing; ' +
        'healthy slots kept running with a fresh rotation window');
    }
  }

  if (state.active.length === 0) {
    state.active = state.queue.splice(0, batchSize);
    state.activeSince = Object.fromEntries(state.active.map(id => [id, now]));
    state.activatedAt = now;
    state.draining = false;
    state.drainingAt = 0;
  } else if (!state.draining && state.active.length < batchSize) {
    const promoted = state.queue.splice(0, batchSize - state.active.length);
    state.active.push(...promoted);
    for (const id of promoted) state.activeSince[id] = now;
  }
  if (!state.activatedAt) state.activatedAt = now;
  if (state.queue.length > 0 && now >= state.activatedAt + cycleMs && !state.draining) {
    state.draining = true;
    state.drainingAt = now;
    logInfo(`automation rotation: batch timer elapsed; draining ${state.active.length} slot(s) at already-started turn/tool boundaries`);
  }

  if (state.draining && state.active.every(id => !busyConversationIds.has(id))) {
    const completed = [...state.active];
    state.queue.push(...completed.filter(id => eligible.has(id) && !state.queue.includes(id)));
    state.active = state.queue.splice(0, batchSize);
    state.activeSince = Object.fromEntries(state.active.map(id => [id, now]));
    state.previous = completed;
    state.rotatedAt = now;
    state.activatedAt = now;
    state.draining = false;
    state.drainingAt = 0;
    logInfo(`automation rotation: safely parked ${completed.length} automation chat(s) and activated ${state.active.length} next chat(s)`);
  }

  busyActive = state.active.filter(id => busyConversationIds.has(id));

  persistIfChanged(before);
  return automationRotationView(now);
}

export function automationRotationView(_now = Date.now()): AutomationRotationView {
  return {
    enabled,
    batchSize,
    cycleMs,
    activatedAt: state.activatedAt,
    draining: enabled && state.draining,
    active: [...state.active],
    attention: state.attention.map(row => row.conversationId),
    foreground: state.foreground.map(row => row.conversationId),
    foregroundSlots,
    enrolled: [...state.enrolled],
    previous: [...state.previous],
    rotatedAt: state.rotatedAt,
    busyActive: [...busyActive],
    queue: [...state.queue],
    nextRotationAt: enabled && state.active.length > 0 && state.queue.length > 0
      ? state.draining ? null : state.activatedAt + cycleMs
      : null,
    drainingAt: enabled && state.draining ? state.drainingAt : 0
  };
}

/** Manual user sends are never fenced; callers use this only for app-authored automatic work. */
export function automationRotationAdmits(conversationId: string | null | undefined): boolean {
  if (!enabled) return true;
  if (!conversationId) return false;
  if (!state.enrolled.includes(conversationId)) return true;
  return state.foreground.some(row => row.conversationId === conversationId) ||
    (!state.draining && state.active.includes(conversationId));
}

export function automationRotationPosition(conversationId: string): {
  state: 'active' | 'draining' | 'foreground' | 'queued' | 'attention';
  position: number;
  previous?: true;
} | null {
  if (!enabled) return null;
  const foregroundIndex = state.foreground.findIndex(row => row.conversationId === conversationId);
  if (foregroundIndex >= 0) return { state: 'foreground', position: batchSize + foregroundIndex + 1 };
  const activeIndex = state.active.indexOf(conversationId);
  if (activeIndex >= 0) return { state: state.draining ? 'draining' : 'active', position: activeIndex + 1 };
  const attentionIndex = state.attention.findIndex(row => row.conversationId === conversationId);
  if (attentionIndex >= 0) return { state: 'attention', position: attentionIndex + 1 };
  const queueIndex = state.queue.indexOf(conversationId);
  return queueIndex >= 0
    ? { state: 'queued', position: queueIndex + 1, ...(state.previous.includes(conversationId) ? { previous: true } : {}) }
    : null;
}

/** Test seam; product state is restored once per process. */
export function resetAutomationRotationForTests(): void {
  state = { version: ROTATION_VERSION, active: [], activeSince: {}, queue: [], attention: [], foreground: [], enrolled: [], membershipInitialized: false,
    previous: [], rotatedAt: 0, activatedAt: 0, draining: false, drainingAt: 0 };
  enabled = false;
  batchSize = 5;
  cycleMs = 60 * 60_000;
  foregroundSlots = 2;
  restored = false;
  reconciled = false;
  busyActive = [];
}

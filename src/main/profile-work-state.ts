import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getActiveInstanceRuntime, getConfig } from './config.js';
import { getLocalInstanceOwnerPaths } from './config.js';
import type { InstanceProfileRegistry } from '../shared/instance-profile.js';
import { exactAutomaticMainWork, pendingCommands, swarmHealthState } from './bridge.js';
import { unifiedExecManager } from './codex/manager.js';
import { CORE_BROWSER_EVIDENCE_MAX_AGE_MS, coreBrowserEvidence } from './core-browser-evidence.js';
import { inFlightMcpRequests } from './mcp/call-context.js';
import { activeBrowserDecisionWork, listInputs, userRequestedInput, type InputEntry } from './session/input.js';
import { pendingContinuations } from './session/continuation.js';
import { listUsageSessions } from './session/store.js';
import type { ActiveWorkBlocker, ActiveWorkCensus } from './profile-lifecycle.js';
import { profileWorkAdmission } from './work-admission.js';

export interface ProfileWorkerCounts {
  active: number;
  queued: number;
}

export function profileWorkerCounts(): ProfileWorkerCounts {
  const workers = swarmHealthState().agents.filter(agent => agent.role === 'worker');
  return {
    active: workers.filter(agent => agent.state === 'active' || agent.state === 'detached' || agent.state === 'waking').length,
    queued: workers.filter(agent => agent.state === 'invited').length
  };
}

interface PersistedAgentRow {
  info?: { role?: unknown; state?: unknown };
}

interface PersistedSwarmProjection {
  version?: unknown;
  agents?: unknown;
  activeRuns?: unknown;
}

const ACTIVE_WORKER_STATES = new Set(['active', 'detached', 'waking']);

/**
 * An untouched durable queue row has not crossed into browser/tool custody. Attention-parked
 * rows and deferred automatic rows need not start a new delivery while lifecycle Drain is active; their
 * exact UUID and payload already survive restart in the outbox. Treat only that complete,
 * positively-unsent shape as deferred; an explicit user message, an ordinary unpaused queue, or
 * any prior offer/claim/Send evidence still blocks shutdown under its existing delivery owner.
 */
function deferredQueuedInput(entry: InputEntry, automaticDeferred: boolean): boolean {
  if (entry.state !== 'queued' || entry.owner !== null || entry.offeredAt !== undefined ||
      entry.sendAuthorizedAt !== undefined || entry.deliveredAt !== undefined ||
      entry.messageId !== undefined) return false;
  const recoveryPhase = entry.recoveryTransitions?.at(-1)?.phase ?? entry.recoveryFailure?.phase;
  if (entry.toolReceiptUncertain === true || entry.response !== undefined ||
      recoveryPhase === 'native_send_ambiguous' || recoveryPhase === 'receipt_missing' ||
      recoveryPhase === 'provider_recovery_unknown') return false;
  const provenPreSend = recoveryPhase === 'pre_send_preparation' || (recoveryPhase === undefined &&
    entry.recoveryWithdrawnSince !== undefined && (entry.recoveryWithdrawAttempts ?? 0) > 0 &&
    Boolean(entry.recovery || entry.silenceBoundary || entry.sourceHelperId));
  // Project binding may be learned before Send. Retain that safe case only alongside the exact
  // pre-Send failure/withdrawal proof; every other delivered-session projection stays a blocker.
  if (entry.deliveredSessionId === null ||
      (entry.deliveredSessionId !== undefined && !provenPreSend)) return false;
  return entry.deliveryAttentionAt !== undefined || (automaticDeferred && !userRequestedInput(entry));
}

function countsFromPersistedAgents(rows: unknown): ProfileWorkerCounts | null {
  if (!Array.isArray(rows)) return null;
  const workers = rows.filter((row): row is PersistedAgentRow =>
    !!row && typeof row === 'object' && !!(row as PersistedAgentRow).info &&
    (row as PersistedAgentRow).info?.role === 'worker');
  return {
    active: workers.filter(row => typeof row.info?.state === 'string' && ACTIVE_WORKER_STATES.has(row.info.state)).length,
    queued: workers.filter(row => row.info?.state === 'invited').length
  };
}

/**
 * Reads only the inactive profile's durable swarm snapshot. It never points the live durable
 * singleton at another profile, so inspecting the account menu cannot change runtime ownership.
 * ENOENT is a proven empty queue; corruption/unknown schema is reported as unavailable instead
 * of the misleading 0/0 that previously hid persisted work.
 */
export async function persistedProfileWorkerCounts(profileId: string, registry?: InstanceProfileRegistry): Promise<ProfileWorkerCounts | null> {
  const owners = getLocalInstanceOwnerPaths(profileId, registry);
  if (!owners) return null;
  const file = path.join(owners.durableStoreRoot, 'state', 'swarm.json');
  let parsed: PersistedSwarmProjection;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8')) as PersistedSwarmProjection;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { active: 0, queued: 0 };
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.version === 6) {
    if (!Array.isArray(parsed.activeRuns)) return null;
    const rows = parsed.activeRuns.flatMap(run =>
      run && typeof run === 'object' && Array.isArray((run as { agents?: unknown }).agents)
        ? (run as { agents: unknown[] }).agents
        : []);
    return countsFromPersistedAgents(rows);
  }
  if (parsed.version === 4 || parsed.version === 5) return countsFromPersistedAgents(parsed.agents);
  return null;
}

/**
 * A read-only census of work that must settle before a process-bound profile switch or update.
 * Every source is already owned by the active profile's startup-bound stores/bridge.
 */
export async function activeProfileWorkCensus(): Promise<ActiveWorkCensus> {
  const profileId = getActiveInstanceRuntime().profile.id;
  const blockers: ActiveWorkBlocker[] = [];

  const mcp = inFlightMcpRequests();
  if (mcp > 0) blockers.push({ category: 'mcp-request', count: mcp, detail: 'connector request(s) still executing or recording' });

  const [inputs, sessions] = await Promise.all([listInputs(), listUsageSessions()]);
  const helperWork = await activeBrowserDecisionWork(inputs);
  if (helperWork.collecting + helperWork.accepting > 0) blockers.push({
    category: 'browser-helper', count: helperWork.collecting + helperWork.accepting,
    detail: `delivered helper answer collection=${helperWork.collecting}, Goal acceptance=${helperWork.accepting}; existing request custody must settle`
  });
  const automationPaused = getConfig().ui.automationPaused === true;
  // A normal maintenance Drain must not require flipping a user's persistent Pause merely
  // to defer an untouched generated outbox row. Only positively unoffered/unclaimed/unsent
  // automatic debt qualifies; manual, leased, authorized and ambiguous ownership still blocks.
  const automaticDeferred = automationPaused || profileWorkAdmission.snapshot().mode === 'draining';
  const ambiguousInputs = inputs.filter(entry =>
    (entry.state === 'browser' && entry.sendAuthorizedAt !== undefined) || entry.state === 'tool');
  const pendingInputs = inputs.filter(entry =>
    (entry.state === 'queued' || entry.state === 'browser' || entry.state === 'tool') &&
    !ambiguousInputs.includes(entry) && !deferredQueuedInput(entry, automaticDeferred));
  if (ambiguousInputs.length > 0) blockers.push({
    category: 'ambiguous-send',
    count: ambiguousInputs.length,
    detail: 'send(s) are already authorized/in delivery and must resolve without replay'
  });
  if (pendingInputs.length > 0) blockers.push({
    category: 'pending-send',
    count: pendingInputs.length,
    detail: 'already-created message(s) are waiting for their existing delivery contract'
  });

  // A retained recorder turn alone cannot keep a deliberate maintenance Drain alive.
  // Local work has its own non-expiring veto even if its caller has already returned.
  const processes = unifiedExecManager.listProcesses();
  if (processes.length > 0) blockers.push({ category: 'local-process', count: processes.length, detail: 'managed local process(es) are still running' });
  const now = Date.now();
  const activeTurns = sessions.filter(session => {
    if (!session.conversationId) return false;
    if (session.activeTurnId && exactAutomaticMainWork(session.conversationId, session.id, now)) return true;
    // A native handoff can already be answering while its first question has
    // not reached the recorder. The incumbent authenticated document cache
    // may veto shutdown during that fresh busy view; it cannot mint a turn,
    // grant Send or certify tool completion. Old/open-call history is not busy.
    const native = coreBrowserEvidence(session.conversationId);
    return native?.shellDiscovery === 'compatible' && native.ordinaryFinal?.reason === 'busy' &&
      (native.ordinaryFinal.maintenanceIdle !== true || native.observedAt > now) &&
      Number.isFinite(native.observedAt) &&
      Math.abs(now - native.observedAt) <= CORE_BROWSER_EVIDENCE_MAX_AGE_MS;
  }).length;
  if (activeTurns > 0) blockers.push({ category: 'active-turn', count: activeTurns, detail: 'ChatGPT is reporting active work; preserving the current answer while it settles' });

  const continuations = pendingContinuations();
  if (continuations.length > 0) blockers.push({
    category: 'continuation',
    count: continuations.length,
    detail: 'Compact & Resume / handoff transaction(s) have not reached a terminal commit or abort'
  });

  const workerCounts = profileWorkerCounts();
  if (workerCounts.active > 0) blockers.push({ category: 'worker', count: workerCounts.active, detail: 'worker(s) are active, detached, or waking' });
  if (workerCounts.queued > 0) blockers.push({ category: 'worker-bootstrap', count: workerCounts.queued, detail: 'already-created worker(s) are waiting for browser bootstrap' });

  const browserCommands = pendingCommands();
  if (browserCommands.length > 0) blockers.push({
    category: 'browser-command',
    count: browserCommands.length,
    detail: 'profile-owned browser command(s) are still queued or leased'
  });

  return { profileId, blockers };
}

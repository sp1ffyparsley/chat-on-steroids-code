import { APPROVAL_ANSWERED_TEXT, APPROVAL_PROGRESS_PREFIX, APPROVAL_WAITING_TEXT } from '../shared/approval-wait.js';

export const APPROVAL_FRESH_MS = 75_000;
export const APPROVAL_NOTICE_GRACE_MS = 30_000;

export interface ApprovalWaitDeps {
  record(sessionId: string, progressId: string, text: string, anchor?: { seq: number; time: number }): Promise<{ seq: number; time: number } | null>;
  notify(sessionId: string): void;
  log(message: string): void;
}

interface Wait {
  since: number;
  seenAt: number;
  noticed: boolean;
  progressId: string;
  sessionId: string | null;
  row: Promise<{ seq: number; time: number } | null> | null;
}

const waits = new Map<string, Wait>();
let generation = 0;
let episode = 0;

function logApproval(deps: ApprovalWaitDeps, message: string): void {
  try { deps.log(`bridge: ${message}`); } catch { /* Diagnostics cannot change wait custody. */ }
}

/** Catch synchronous throws as well as rejected durable writes. Never invent an anchor. */
async function recordApproval(
  deps: ApprovalWaitDeps, sessionId: string, progressId: string, text: string,
  anchor?: { seq: number; time: number }
): Promise<{ seq: number; time: number } | null> {
  try { return await deps.record(sessionId, progressId, text, anchor); }
  catch {
    logApproval(deps, `tool approval progress write failed for ${sessionId}; check the session store`);
    return null;
  }
}

export function approvalCardWaiting(conversationId: string, now = Date.now()): boolean {
  const wait = waits.get(conversationId);
  return !!wait && now >= wait.seenAt && now - wait.seenAt < APPROVAL_FRESH_MS;
}

export async function noteApprovalCard(
  conversationId: string,
  waiting: boolean,
  sessionId: string | null,
  deps: ApprovalWaitDeps,
  now = Date.now()
): Promise<void> {
  if (!conversationId || !Number.isFinite(now) || now < 0) return;
  let wait = waits.get(conversationId);
  if (wait && now < wait.seenAt) return;
  if (wait && (!waiting || now - wait.seenAt >= APPROVAL_FRESH_MS)) {
    waits.delete(conversationId);
    logApproval(deps, `${conversationId} tool approval ${waiting ? 'evidence expired' : 'card no longer pending'}`);
    // Staleness only means the page stopped proving the card. An explicit `waiting=false`
    // is what proves the user/provider cleared it and may rewrite the stable progress row.
    const ownGeneration = generation;
    const anchor = waiting ? null : await wait.row;
    if (generation === ownGeneration && anchor && wait.sessionId) {
      await recordApproval(deps, wait.sessionId, wait.progressId, APPROVAL_ANSWERED_TEXT, anchor);
    }
    wait = undefined;
  }
  if (!waiting) return;
  if (!wait) {
    wait = {
      since: now,
      seenAt: now,
      noticed: false,
      progressId: `${APPROVAL_PROGRESS_PREFIX}${conversationId}:${now}:${++episode}`,
      sessionId: null,
      row: null
    };
    waits.set(conversationId, wait);
    logApproval(deps, `${conversationId} waits for ChatGPT's native tool approval card to clear`);
  }
  wait.seenAt = now;
  if (sessionId && !wait.sessionId) {
    wait.sessionId = sessionId;
    // Store the pending promise before invoking a potentially re-entrant dependency.
    const progressId = wait.progressId;
    const ownGeneration = generation;
    wait.row = Promise.resolve().then(() => generation === ownGeneration
      ? recordApproval(deps, sessionId, progressId, APPROVAL_WAITING_TEXT) : null);
  }
  if (wait.sessionId && !wait.noticed && now - wait.since >= APPROVAL_NOTICE_GRACE_MS) {
    wait.noticed = true;
    try { deps.notify(wait.sessionId); }
    catch { logApproval(deps, `tool approval notification failed for ${wait.sessionId}; inspect the native card`); }
  }
}

export function resetApprovalWaits(): void {
  generation++;
  waits.clear();
}


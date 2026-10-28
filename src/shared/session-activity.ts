import { CHAT_ACTIVE_MS, type SessionSummary } from './session.js';

/** The Active label uses the bridge's projected deadline when one is available. */
export function recentChatActivity(summary: SessionSummary, now = Date.now()): boolean {
  if (summary.activityExpiresAt !== undefined) {
    return summary.activityExpiresAt !== null && now < summary.activityExpiresAt;
  }
  const lastActivityAt = Math.max(summary.startedAt, summary.lastToolCallAt ?? 0);
  const finishedAt = Math.max(summary.lastAssistantFinalAt ?? 0, summary.lastTurnEndAt ?? 0);
  return lastActivityAt > finishedAt && now - lastActivityAt < CHAT_ACTIVE_MS;
}

/** A worker's own finish report ends its work even while the broker view catches up. */
export function workerReportedFinish(summary: SessionSummary): boolean {
  return summary.origin?.kind === 'worker' && typeof summary.lastFinishReportAt === 'number' &&
    summary.lastFinishReportAt >= (summary.lastToolCallAt ?? 0);
}

/** Shared by the displayed label and the opening cohort of attribution recovery. */
export function sessionWorkingAt(summary: SessionSummary, now: number): boolean {
  return summary.endedAt === null && !workerReportedFinish(summary) && recentChatActivity(summary, now);
}

/**
 * Newest meaningful chat work for a visible "last worked" age.
 *
 * `updatedAt` also advances for transport/error bookkeeping, so it would make a stalled chat
 * look freshly productive. Messages, exact tool calls and turn completion are the durable facts
 * that represent the chat or user actually doing work; session start is the legacy fallback.
 */
export function sessionLastWorkedAt(summary: SessionSummary): number {
  return Math.max(
    summary.startedAt,
    summary.lastMessageAt ?? 0,
    summary.lastToolCallAt ?? 0,
    summary.lastAssistantFinalAt ?? 0,
    summary.lastTurnEndAt ?? 0
  );
}

/** One quiet minute is enough to expose retryable automation debt; it never authorizes a resend. */
export const AUTOMATION_STALE_MS = 60_000;

export type AutomationChatState =
  | 'working'
  | 'waiting-workers'
  | 'waiting-main'
  | 'recovering'
  | 'stalled'
  | 'paused'
  | 'blocked';

/** Read-only phase of an already-owned recovery; none of these phases runs work itself. */
export type AutomationRecoveryStage =
  | 'core'
  | 'queued'
  | 'browser-action'
  | 'checking-activity'
  | 'waiting-browser'
  | 'focusing-existing-tab'
  | 'reopening-missing-tab'
  | 'waiting-activity'
  | 'retry-scheduled'
  | 'handoff'
  | 'draft'
  | 'pending-reply'
  | 'cooldown';

export interface AutomationHealthEvidence {
  observedAt: number;
  mode: 'goal' | 'loop';
  lastWorkedAt: number;
  paused: boolean;
  blockedReason: string | null;
  /** Exact current main-chat execution, not a freshness/grace estimate. */
  exactMainWork: boolean;
  /** Recent accepted work evidence that may outlive the exact native/tool execution. */
  recentActivity: boolean;
  activeWorkers: number;
  recovery: null | {
    stage: AutomationRecoveryStage;
    reason: string;
    nextAction: string;
    nextRetryAt: number | null;
  };
}

export interface AutomationHealthProjection {
  state: AutomationChatState;
  reason: string;
  nextAction: string;
  nextRetryAt: number | null;
  recoverable: boolean;
  /** The only authority for a spinner on a top-level automated session row. */
  spinning: boolean;
  recoveryStage: AutomationRecoveryStage | null;
}

/**
 * Pure status projection for a top-level Goal/Loop chat.
 *
 * The bridge supplies facts from the existing scheduler, repair queue and broker. This helper
 * adds no timer and creates no authority; it exists so the sidebar and the recovery action use
 * the same definitions for working, waiting, recovering and stalled.
 */
export function evaluateAutomationHealth(evidence: AutomationHealthEvidence): AutomationHealthProjection {
  const finish = (
    state: AutomationChatState,
    reason: string,
    nextAction: string,
    nextRetryAt: number | null = null,
    recoverable = false,
    spinning = false,
    recoveryStage: AutomationRecoveryStage | null = null
  ): AutomationHealthProjection => ({ state, reason, nextAction, nextRetryAt, recoverable, spinning, recoveryStage });

  if (evidence.blockedReason) {
    return finish('blocked', evidence.blockedReason, 'Review this chat before allowing automatic work.');
  }
  if (evidence.paused && evidence.exactMainWork) {
    return finish(
      'working',
      'An already-started ChatGPT turn is finishing while automation is paused. No new app-authored work will start.',
      'Let this turn finish; use Resume when you want the app to start new work.',
      null,
      false,
      true
    );
  }
  if (evidence.paused) {
    return finish('paused', 'All new app-authored ChatGPT work is paused.', 'Resume automation when you are ready.');
  }
  // A current recovery/error owner is the truthful browser state even when the server keeps
  // producing exact tool/model activity behind a broken page. Showing Working + a spinner here
  // made a visibly failed Loop look healthy while its Retry/reload repair was already queued.
  if (evidence.recovery) {
    return finish(
      'recovering',
      evidence.recovery.reason,
      evidence.recovery.nextAction,
      evidence.recovery.nextRetryAt,
      evidence.recovery.stage === 'cooldown' || evidence.recovery.stage === 'retry-scheduled',
      false,
      evidence.recovery.stage
    );
  }
  if (evidence.exactMainWork) {
    return finish(
      'working',
      'The main chat has an exact current generation or local-tool execution.',
      'Keep observing the current execution.',
      null,
      false,
      true
    );
  }
  if (evidence.activeWorkers > 0) {
    return finish(
      'waiting-workers',
      `${evidence.activeWorkers} sub-agent${evidence.activeWorkers === 1 ? ' is' : 's are'} still running.`,
      'Wait for the active workers to report back.'
    );
  }
  if (evidence.recentActivity) {
    return finish(
      'waiting-main',
      'Recent work was recorded, but no exact main-chat execution is active now.',
      'Wait for the next exact generation, tool execution, or durable completion boundary.'
    );
  }
  const idleFor = Math.max(0, evidence.observedAt - evidence.lastWorkedAt);
  if (evidence.mode === 'loop' && idleFor >= AUTOMATION_STALE_MS) {
    return finish(
      'stalled',
      'This Loop has no fresh work, active workers, handoff, draft, or browser repair.',
      'Reload or reopen the exact chat through the existing repair queue.',
      null,
      true
    );
  }
  return finish(
    'waiting-main',
    evidence.mode === 'loop'
      ? 'The Loop is idle inside its normal grace window.'
      : 'The Goal is armed and waiting for the main chat.',
    'Wait for the main chat or its next durable Goal/Loop boundary.'
  );
}

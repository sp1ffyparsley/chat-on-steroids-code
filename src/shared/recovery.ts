/** Read-only projection of an existing recovery deadline. Never authorizes an action. */
export type RecoveryCountdown = {
  kind: 'unattributed' | 'unattributed-wait' | 'thinking-failed' | 'native-busy' | 'silence' | 'post-reload';
  deadline: number;
  /** Last exact activity/evidence time for a page that is now stale. Presentation only. */
  staleSince?: number;
  /** The existing UI clock reveals this row without needing a new backend event. */
  visibleAt?: number;
  next?: 'queue' | 'goal' | 'loop';
  /** Human-readable projection of the existing owner; never an action receipt. */
  reason?: string;
  /** Existing next action that owns the deadline. */
  nextAction?: string;
};

/** Upstream Maximapple/#1402: an ordinary long turn continues without changing its objective. */
export function rotationMessage(): string {
  return 'Continue the task from where you are. Preserve the original requirements, user corrections, current work and evidence. Do not restart completed work.';
}

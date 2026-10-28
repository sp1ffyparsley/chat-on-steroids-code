/**
 * Whether a compaction is opening its replacement chat right at this moment.
 *
 * One boolean, in a module of its own, because the two sides of it must not import each
 * other: the continuation owns the transaction and says when a brief has been claimed, and
 * the recorder — which the continuation already depends on — has to be able to ask.
 *
 * The question exists because of what the answer prevents. When a resume opens chat B, two
 * things race to react to B appearing: the recorder, which invents a session for any
 * conversation it has never seen, and the commit, which moves the *existing* session onto B.
 * On 2026-08-23 the recorder won by 302 ms. The commit then found its own destination owned
 * by a session it had never heard of, refused to rebind — "the replacement chat already
 * belongs to another local session" — and the compaction lost its session while the swarm's
 * prime role moved to the new chat anyway. The replacement chat asked its own session for the
 * handoff history, was told it had no recorded events, and rebuilt the work off the
 * filesystem.
 *
 * The content script holds its own opening batch back for exactly this reason
 * (`commandJournalGate`), but that gate cannot cover events already journalled in the
 * extension's service worker, which is how they arrived early anyway. So the invariant is
 * kept here, where it is owned, instead of there, where it is merely usually observed.
 */

/**
 * How long after a claim a replacement chat is still expected to appear.
 *
 * Only has to outlast a browser opening a tab and ChatGPT minting a conversation id — the
 * bridge command that opened it is bounded by its own deadline. Kept short because the
 * window is not free: while it is open, a genuinely unrelated new conversation waits before
 * getting a session of its own.
 */
export const RESUME_CLAIM_WINDOW_MS = 60_000;

/** The existing post-redeem bridge delivery budget, shared rather than independently renewed. */
export const REDEEMED_COMMAND_DELIVERY_MS = 120_000;

type ResumeClaim = { deadlineAt: number; claimant?: string; deliveryClaimedAt?: number };
const claims = new Map<string, ResumeClaim>();

/** Records that a replacement chat is expected to appear imminently. */
function noteExpectedResume(token: string, claimant?: string): void {
  const current = claims.get(token);
  // Redeem retries and native dispatch cannot give the same command a new clock.
  if (current?.deliveryClaimedAt !== undefined ||
      (current?.claimant && claimant && current.claimant !== claimant)) return;
  if (current) {
    current.deadlineAt = Date.now() + RESUME_CLAIM_WINDOW_MS;
    current.claimant ??= claimant;
  } else claims.set(token, { deadlineAt: Date.now() + RESUME_CLAIM_WINDOW_MS, claimant });
}

/**
 * Arms the recorder gate before the browser is opened for a queued resume.
 *
 * This has to precede `openExternal()`, not merely the page's later redeem. Chrome/ChatGPT can
 * expose the new conversation quickly enough for an already-journalled service-worker event to
 * reach the recorder before the content script has redeemed its marker. That observation must
 * wait for the A→B commit rather than inventing a shadow local session for B.
 */
export function noteResumeOpening(token: string): void {
  noteExpectedResume(token);
}

/** Records that a replacement chat has durably taken this continuation's brief and is opening. */
export function noteResumeClaim(token: string, claimant?: string): void {
  noteExpectedResume(token, claimant);
}

/** Only the bridge's already-durable exact command lease may extend its own recorder gate. */
export function noteResumeCommandLease(token: string, claimant: string, claimedAt: number): boolean {
  const current = claims.get(token);
  const now = Date.now();
  const deadlineAt = claimedAt + REDEEMED_COMMAND_DELIVERY_MS;
  if (!current || !claimant || current.claimant !== claimant || !Number.isSafeInteger(claimedAt) ||
      claimedAt <= 0 || claimedAt > now || !Number.isSafeInteger(deadlineAt) || deadlineAt <= now) return false;
  if (current.deliveryClaimedAt !== undefined) return current.deliveryClaimedAt === claimedAt;
  current.deliveryClaimedAt = claimedAt;
  current.deadlineAt = deadlineAt;
  return true;
}

/** Only the existing durable untouched-tab transfer may replace its prior exact lease clock. */
export function replaceResumeCommandLease(token: string, claimant: string, priorClaimedAt: number, claimedAt: number): boolean {
  const current = claims.get(token);
  const now = Date.now();
  const deadlineAt = claimedAt + REDEEMED_COMMAND_DELIVERY_MS;
  if (!current || current.claimant !== claimant || current.deliveryClaimedAt !== priorClaimedAt ||
      current.deadlineAt < now || !Number.isSafeInteger(claimedAt) || claimedAt <= 0 || claimedAt > now ||
      claimedAt < priorClaimedAt || !Number.isSafeInteger(deadlineAt) || deadlineAt <= now) return false;
  current.deliveryClaimedAt = claimedAt;
  current.deadlineAt = deadlineAt;
  return true;
}

/** Capture just the opening attempts already blocking this unknown conversation.
 * A later unrelated claim cannot extend the wait. The same attempt may acquire its existing
 * durable post-redeem lease while we wait; its opening + delivery budgets remain finite. */
export function resumeOpeningWait(): () => boolean {
  const now = Date.now();
  resumeOpeningChat(now);
  const expected = [...claims.entries()];
  const genericDeadline = now + RESUME_CLAIM_WINDOW_MS;
  const deliveryDeadline = genericDeadline + REDEEMED_COMMAND_DELIVERY_MS;
  return () => {
    const currentTime = Date.now();
    return expected.some(([token, claim]) => claims.get(token) === claim && currentTime <= Math.min(
      claim.deadlineAt, claim.deliveryClaimedAt === undefined ? genericDeadline : deliveryDeadline
    ));
  };
}

/** Records that the move landed, or was given up on, so nothing waits on it any longer. */
export function endResumeClaim(token: string): void {
  claims.delete(token);
}

/**
 * True while some replacement chat is expected to appear.
 *
 * Self-expiring, so a claim that is never resolved — a crash between the claim and the
 * commit, a browser that never opens the tab — costs a bounded window rather than a
 * permanent one. That is the safe direction: failing to wait creates a stub session, which
 * is recoverable and visible, while waiting forever would stop recording new chats.
 */
export function resumeOpeningChat(now: number = Date.now()): boolean {
  for (const [token, claim] of claims) {
    if (now <= claim.deadlineAt) return true;
    claims.delete(token);
  }
  return false;
}

/** Test seam. */
export function resetResumeGate(): void {
  claims.clear();
}

import { createHash } from 'node:crypto';
import type { AgentPlan, AcceptanceMigrationPreview, HumanCorrectionFragment } from '../../shared/agent-plan.js';

/** CoS40 owner-review protocol. This module has NO storage writer and NO way
 * to convert a review into approval. CoS24 owns session storage/transport,
 * and a future independently authorized, identity-bound transaction must be
 * designed with that owner before any durable mutation is introduced.
 *
 * A parsed-plan digest is a compare-and-swap *precondition proposal*, not a
 * filesystem hash. The rollback copy preserves historical checklist evidence
 * and exclusions verbatim; it is not an instruction to replay tool requests.
 */
export interface RecoveryReviewSource {
  sessionId: string;
  conversationId: string;
  originalObjective: string;
  objective: string;
  originalReference: string;
  objectiveReference: string;
  corrections: readonly { text: string; reference: string }[];
  incompleteHumanCorrections?: readonly HumanCorrectionFragment[];
  recorded: AgentPlan | null;
  preview: AcceptanceMigrationPreview;
}

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function authorityDigest(source: RecoveryReviewSource): string {
  return digest({
    originalObjective: source.originalObjective,
    objective: source.objective,
    originalReference: source.originalReference,
    objectiveReference: source.objectiveReference,
    corrections: source.corrections.map(({ text, reference }) => ({ text, reference })),
    incompleteHumanCorrections: source.incompleteHumanCorrections?.map(({ text, reference }) => ({
      text, reference
    })) ?? [],
    coverage: source.preview.historyCoverage,
    inspected: source.preview.historyInspected
  });
}

const planDigest = (plan: AgentPlan | null): string | null =>
  plan === null ? null : digest(plan);

interface RecoveryReviewCore {
  schemaVersion: 1;
  action: 'owner-review-only';
  applyAuthorized: false;
  reviewDecision: AcceptanceMigrationPreview['decision'];
  expected: {
    sessionId: string;
    conversationId: string;
    planSnapshotSha256: string | null;
    humanAuthoritySha256: string;
    previewSha256: string;
    historyCoverage: AcceptanceMigrationPreview['historyCoverage'];
    historyInspected: number | null;
  };
  rollback: {
    originalPlan: AgentPlan | null;
    planSnapshotSha256: string | null;
    requiresOwnerReviewedRestore: true;
  };
  prerequisites: {
    nativeCallerIdentity: 'not-granted';
    freshHumanApproval: 'not-granted';
    sessionStoreOwnerApproval: 'not-granted';
    atomicCompareAndSwap: 'not-implemented';
    rollbackTransaction: 'not-implemented';
  };
}

export type AcceptanceRecoveryReview = RecoveryReviewCore & { reviewSealSha256: string };

/** Serializable, deterministic review packet; no filesystem/network writes. */
export function prepareAcceptanceRecoveryReview(source: RecoveryReviewSource): AcceptanceRecoveryReview {
  const currentHash = planDigest(source.recorded);
  if (source.preview.recordedSnapshotSha256 !== currentHash) {
    throw new Error('Acceptance recovery preview does not match the exact recorded-plan snapshot; regenerate before owner review.');
  }
  const rollback = source.recorded === null
    ? null : JSON.parse(JSON.stringify(source.recorded)) as AgentPlan;
  const core: RecoveryReviewCore = {
    schemaVersion: 1,
    action: 'owner-review-only',
    applyAuthorized: false,
    reviewDecision: source.preview.decision,
    expected: {
      sessionId: source.sessionId,
      conversationId: source.conversationId,
      planSnapshotSha256: currentHash,
      humanAuthoritySha256: authorityDigest(source),
      previewSha256: digest(source.preview),
      historyCoverage: source.preview.historyCoverage,
      historyInspected: source.preview.historyInspected
    },
    rollback: {
      originalPlan: rollback,
      planSnapshotSha256: currentHash,
      requiresOwnerReviewedRestore: true
    },
    prerequisites: {
      nativeCallerIdentity: 'not-granted',
      freshHumanApproval: 'not-granted',
      sessionStoreOwnerApproval: 'not-granted',
      atomicCompareAndSwap: 'not-implemented',
      rollbackTransaction: 'not-implemented'
    }
  };
  return { ...core, reviewSealSha256: digest(core) };
}

/** Preflight only: fail closed after a stale plan, new human correction,
 * Compact & Resume rebinding, incomplete history or tampered rollback packet.
 * Returning a valid REVIEW is never permission or ability to mutate data. */
export function validateAcceptanceRecoveryReview(
  packet: AcceptanceRecoveryReview, current: RecoveryReviewSource
): { validForReview: boolean; applyAuthorized: false; problems: string[] } {
  const problems: string[] = [];
  if (packet.schemaVersion !== 1 || packet.action !== 'owner-review-only' ||
      packet.applyAuthorized !== false ||
      packet.prerequisites?.nativeCallerIdentity !== 'not-granted' ||
      packet.prerequisites?.freshHumanApproval !== 'not-granted' ||
      packet.prerequisites?.sessionStoreOwnerApproval !== 'not-granted' ||
      packet.prerequisites?.atomicCompareAndSwap !== 'not-implemented' ||
      packet.prerequisites?.rollbackTransaction !== 'not-implemented') {
    problems.push('Invalid or approval-spoofed recovery protocol; no mutation authority exists.');
  }
  const { reviewSealSha256, ...core } = packet;
  if (digest(core) !== reviewSealSha256) {
    problems.push('Recovery review seal mismatch; the review or rollback data was modified.');
  }
  const planHash = planDigest(current.recorded);
  if (planDigest(packet.rollback?.originalPlan ?? null) !== packet.rollback?.planSnapshotSha256 ||
      packet.rollback?.planSnapshotSha256 !== packet.expected?.planSnapshotSha256) {
    problems.push('Historical rollback snapshot/hash mismatch; do not restore or overwrite any record.');
  }
  if (packet.expected?.sessionId !== current.sessionId ||
      packet.expected?.conversationId !== current.conversationId) {
    problems.push('Session/conversation binding changed; a committed Resume needs a new scoped review.');
  }
  if (packet.expected?.planSnapshotSha256 !== planHash) {
    problems.push('The persisted plan changed since preview; refuse stale migration and regenerate the review.');
  }
  if (packet.expected?.humanAuthoritySha256 !== authorityDigest(current)) {
    problems.push('The human Goal/corrections/recorded history changed; recover complete authority again.');
  }
  if (packet.expected?.previewSha256 !== digest(current.preview) ||
      packet.reviewDecision !== current.preview.decision) {
    problems.push('The acceptance review projection changed; do not reuse old proposed fields.');
  }
  if (packet.expected?.historyCoverage !== 'complete' ||
      current.preview.historyCoverage !== 'complete' ||
      current.preview.decision === 'blocked') {
    problems.push('Incomplete/contradictory human history or blocked review cannot proceed.');
  }
  return { validForReview: problems.length === 0, applyAuthorized: false, problems };
}

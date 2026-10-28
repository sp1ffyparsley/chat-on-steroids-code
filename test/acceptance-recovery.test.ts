import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentPlanSchema, previewAcceptanceMigration } from '../src/shared/agent-plan.js';
import {
  prepareAcceptanceRecoveryReview, validateAcceptanceRecoveryReview,
  type RecoveryReviewSource
} from '../src/main/mcp/acceptance-recovery.js';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture(): RecoveryReviewSource {
  const originalObjective = [
    'Original acceptance IDs: canonical_continuity, task_fidelity, skills_fidelity, progress_truth.',
    'canonical_continuity: Preserve full human corrections across real Resume.',
    'task_fidelity: Verify actual native Windows product behavior.',
    'skills_fidelity: Read the selected Skill body and verify output follows it.',
    'progress_truth: Report native results separately from source tests.'
  ].join('\n');
  const correction = [
    'Current human correction: Native task fidelity must preserve keyboard shortcuts.',
    'task_fidelity: Verify actual native Windows product behavior including keyboard shortcuts.'
  ].join('\n');
  const recorded = agentPlanSchema.parse({
    updatedAt: 1700,
    plan: [{ step: 'Implement the native keyboard workflow', status: 'in_progress' }],
    checklist: [
      ...['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'].map(id => ({
        id, requirement: `Local ${id} source patch`, source: 'Historical assistant progress',
        acceptance: 'Vitest tests pass', status: 'verified' as const,
        evidence: ['Vitest source unit tests PASS, 7/7 revision abc123.']
      })),
      { id: 'retired_step', requirement: 'Historically excluded temp step',
        source: 'Genuine older human scope correction', acceptance: 'Archived source milestone',
        status: 'excluded' as const, scopeChange: 'Human excluded this completed historical step.' }
    ]
  });
  const corrections = [{ text: correction, reference: 'human-event:later-genuine-keyboard' }];
  const preview = previewAcceptanceMigration({
    objective: originalObjective, originalObjective, originalReference: 'saved-goal:CoS40',
    recorded, corrections, historyCoverage: 'complete', historyInspected: 143,
    recordedSnapshotSha256: sha(recorded)
  });
  return {
    sessionId: '2026-10-15-simulated-review',
    conversationId: 'synthetic-Cos40-chat-1',
    originalObjective, objective: originalObjective,
    originalReference: 'saved-goal:CoS40', objectiveReference: 'saved-goal:CoS40',
    corrections, recorded, preview
  };
}

describe('CoS40 owner-review-only acceptance recovery contract', () => {
  it('makes a byte-stable sealed review and full historic rollback copy without granting a write', () => {
    const current = fixture();
    const untouched = JSON.stringify(current);
    const first = prepareAcceptanceRecoveryReview(current);
    const second = prepareAcceptanceRecoveryReview(current);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      schemaVersion: 1, action: 'owner-review-only', applyAuthorized: false,
      reviewDecision: 'requires-human-review',
      expected: {
        sessionId: current.sessionId, conversationId: current.conversationId,
        planSnapshotSha256: sha(current.recorded),
        historyCoverage: 'complete', historyInspected: 143
      },
      rollback: {
        originalPlan: current.recorded, planSnapshotSha256: sha(current.recorded),
        requiresOwnerReviewedRestore: true
      },
      prerequisites: {
        nativeCallerIdentity: 'not-granted', freshHumanApproval: 'not-granted',
        sessionStoreOwnerApproval: 'not-granted',
        atomicCompareAndSwap: 'not-implemented', rollbackTransaction: 'not-implemented'
      }
    });
    expect(first.reviewSealSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.expected.humanAuthoritySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validateAcceptanceRecoveryReview(first, current)).toEqual({
      validForReview: true, applyAuthorized: false, problems: []
    });
    expect(JSON.stringify(current)).toBe(untouched);
  });

  it('fails closed on concurrent plan changes, changed human correction, stale resumed chat or tampered rollback', () => {
    const current = fixture();
    const packet = prepareAcceptanceRecoveryReview(current);
    const changedPlan = agentPlanSchema.parse({
      ...current.recorded!, updatedAt: 1701,
      plan: [{ step: 'Concurrent source owner changed workflow', status: 'completed' }]
    });
    const modifiedPlan = validateAcceptanceRecoveryReview(packet, { ...current, recorded: changedPlan });
    expect(modifiedPlan.validForReview).toBe(false);
    expect(modifiedPlan.problems.join(' ')).toMatch(/persisted plan changed/);
    const changedGoal = validateAcceptanceRecoveryReview(packet, {
      ...current, originalObjective: current.originalObjective + '\nCurrent human correction: Expand quality bar.'
    });
    expect(changedGoal.validForReview).toBe(false);
    expect(changedGoal.problems.join(' ')).toMatch(/human Goal/);
    const changedCorrections = validateAcceptanceRecoveryReview(packet, {
      ...current, corrections: [...current.corrections, {
        reference: 'human-event:newer-authentic', text: 'Current human correction: Add native save/reopen.'
      }]
    });
    expect(changedCorrections.validForReview).toBe(false);
    const resumed = validateAcceptanceRecoveryReview(packet, {
      ...current, conversationId: 'successor-real-Resume-conversation'
    });
    expect(resumed.validForReview).toBe(false);
    expect(resumed.problems.join(' ')).toMatch(/binding changed/);

    const tampered = JSON.parse(JSON.stringify(packet)) as typeof packet;
    tampered.rollback.originalPlan!.checklist![0]!.evidence![0] = 'Forged live verification after review';
    const checked = validateAcceptanceRecoveryReview(tampered, current);
    expect(checked.validForReview).toBe(false);
    expect(checked.problems.join(' ')).toMatch(/seal mismatch|rollback snapshot/);
    const spoofed = JSON.parse(JSON.stringify(packet)) as typeof packet;
    (spoofed.prerequisites as { freshHumanApproval: string }).freshHumanApproval = 'granted';
    // Even an attacker who recomputes the unkeyed integrity digest cannot
    // turn a review packet into native/human permission or a write interface.
    const { reviewSealSha256: _ignored, ...body } = spoofed;
    spoofed.reviewSealSha256 = sha(body);
    expect(validateAcceptanceRecoveryReview(spoofed, current).validForReview).toBe(false);
    expect(validateAcceptanceRecoveryReview(spoofed, current).applyAuthorized).toBe(false);
  });

  it('rejects partial human history and contradicted acceptance even with four original IDs', () => {
    const current = fixture();
    const partialPreview = previewAcceptanceMigration({
      objective: current.objective, originalObjective: current.originalObjective,
      originalReference: current.originalReference,
      recorded: current.recorded, corrections: current.corrections,
      recordedSnapshotSha256: sha(current.recorded),
      historyCoverage: 'partial', historyInspected: 2048,
      historyIssue: 'History page cap reached before original human event.'
    });
    expect(partialPreview).toMatchObject({ decision: 'blocked',
      originalIds: ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'],
      verified: 0, historyCoverage: 'partial' });
    const partial = { ...current, preview: partialPreview };
    const packet = prepareAcceptanceRecoveryReview(partial);
    expect(packet.reviewDecision).toBe('blocked');
    expect(validateAcceptanceRecoveryReview(packet, partial)).toMatchObject({
      validForReview: false, applyAuthorized: false
    });
    expect(validateAcceptanceRecoveryReview(packet, partial).problems.join(' '))
      .toMatch(/Incomplete\/contradictory human history/);
  });
});

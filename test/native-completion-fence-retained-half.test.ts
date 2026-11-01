import { describe, expect, it } from 'vitest';
import {
  acknowledgeNativeCompletion,
  coreBrowserEvidence,
  nativeCompletionCandidate,
  nativeCompletionDiagnostic,
  nativeFinalEvidenceWait,
  noteCoreBrowserEvidence,
  resetCoreBrowserEvidenceForTests
} from '../src/main/core-browser-evidence.js';

const TARGET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const QUESTION = 'abababab-1111-4111-8111-111111111111';
const DOCUMENT = 'retained-half-document';
const NOW = 1_800_000_000_000;
const CALLS = ['native-call-1', 'native-call-2'];

/** One frame from the incumbent reader with a complete Core parent census. */
const frame = (at: number, overrides: Record<string, unknown> = {}) => ({
  conversationId: TARGET, documentId: DOCUMENT, navigationEpoch: 7, observedAt: at,
  shell: 'alternate' as const, shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
  ordinaryFinal: {
    reason: 'open-call' as const, questions: 1, calls: 2, openCalls: 2, codeCalls: 0, openCodeCalls: 0,
    activeTurnMapped: false, sourceUserMessageId: QUESTION,
    coreCallMessageIds: CALLS, allCoreRequestIds: ['workflow-1', 'workflow-2'],
    ...overrides
  }
});

const settled = (at: number, overrides: Record<string, unknown> = {}) =>
  frame(at, { reason: 'associated' as const, openCalls: 0, ...overrides });

describe('retained native-completion request identity', () => {
  it('settles a retained fence when a later settled frame omits the request-id half', () => {
    resetCoreBrowserEvidenceForTests();
    expect(noteCoreBrowserEvidence(frame(NOW))).toBe(true);
    // A later pass re-rendered the same exact native parents but published no workflow ids.
    // That is a narrower inspection of the same exchange, not a changed parent set.
    expect(noteCoreBrowserEvidence(settled(NOW + 1000, { allCoreRequestIds: undefined }))).toBe(true);

    const evidence = coreBrowserEvidence(TARGET)!;
    expect(evidence.ordinaryFinal?.allCoreRequestIds).toBeUndefined();
    expect(evidence.pendingCompletion).toMatchObject({
      calls: 2, coreCallMessageIds: CALLS, allCoreRequestIds: ['workflow-1', 'workflow-2']
    });
    expect(nativeCompletionDiagnostic(TARGET)?.reason).toBe('durable-proof-required');
    expect(nativeFinalEvidenceWait(evidence, NOW + 1000)?.detail).not.toContain('identities changed');
    expect(nativeFinalEvidenceWait(evidence, NOW + 1000)?.detail).toContain('Blocker: durable-proof-required');

    const candidate = nativeCompletionCandidate(TARGET);
    expect(candidate).toMatchObject({ allCoreRequestIds: ['workflow-1', 'workflow-2'], coreCallMessageIds: CALLS });
    // The retained half - not the current frame - still scopes Main's durable receipts: one
    // partial receipt/native pair cannot settle two retained parents.
    expect(acknowledgeNativeCompletion(TARGET, candidate!.observedAt, candidate!.pendingObservedAt,
      ['workflow-1'], ['native-call-1'])).toBe(false);
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion).not.toBeNull();
    expect(acknowledgeNativeCompletion(TARGET, candidate!.observedAt, candidate!.pendingObservedAt,
      ['workflow-1', 'workflow-2'], CALLS)).toBe(true);
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion).toBeNull();
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1000)).toBeNull();
  });

  it.each(['other-question', 'reordered-parents', 'missing-parent-ids', 'inventory-incomplete'])(
    'keeps the %s control held when the request-id half is omitted', kind => {
      resetCoreBrowserEvidenceForTests();
      expect(noteCoreBrowserEvidence(frame(NOW))).toBe(true);
      const next: Record<string, unknown> = { allCoreRequestIds: undefined };
      if (kind === 'other-question') next.sourceUserMessageId = 'cdcdcdcd-2222-4222-8222-222222222222';
      if (kind === 'reordered-parents') next.coreCallMessageIds = ['native-call-2', 'native-call-1'];
      if (kind === 'missing-parent-ids') next.coreCallMessageIds = undefined;
      if (kind === 'inventory-incomplete') next.callInventoryComplete = false;
      if (kind === 'missing-parent-ids') next.calls = 2;
      expect(noteCoreBrowserEvidence(settled(NOW + 1000, next))).toBe(true);
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
      expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1000)?.reason).toBe('evidence');
    });
});

describe('retained request half refuses substituted evidence', () => {
  it.each(['different-document', 'different-epoch', 'different-request-half', 'empty-request-half',
    'null-request-half', 'malformed-request-half', 'longer-request-half', 'native-still-open', 'code-parent-substituted'])(
    'preserves the original fence for %s', async kind => {
      resetCoreBrowserEvidenceForTests();
      const original = frame(NOW);
      if (kind === 'code-parent-substituted') Object.assign(original.ordinaryFinal, {
        reason: 'open-code', codeCalls: 1, openCodeCalls: 1,
        codeCallMessageIds: ['original-code-parent'], openCodeCallMessageIds: ['original-code-parent']
      });
      expect(noteCoreBrowserEvidence(original)).toBe(true);
      const next = settled(NOW + 1000, { allCoreRequestIds: undefined });
      if (kind === 'different-document') next.documentId = 'another-document';
      if (kind === 'different-epoch') next.navigationEpoch++;
      if (kind === 'different-request-half') next.ordinaryFinal.allCoreRequestIds = ['foreign-1', 'foreign-2'];
      if (kind === 'empty-request-half') next.ordinaryFinal.allCoreRequestIds = [];
      if (kind === 'null-request-half') Object.assign(next.ordinaryFinal, { allCoreRequestIds: null });
      if (kind === 'malformed-request-half') Object.assign(next.ordinaryFinal, { allCoreRequestIds: [1, 2] });
      if (kind === 'longer-request-half') next.ordinaryFinal.allCoreRequestIds = ['workflow-1', 'workflow-2', 'foreign-3'];
      if (kind === 'native-still-open') Object.assign(next.ordinaryFinal, { reason: 'open-call', openCalls: 1 });
      if (kind === 'code-parent-substituted') Object.assign(next.ordinaryFinal, {
        codeCalls: 1, codeCallMessageIds: ['foreign-code-parent'], answeredCodeCallMessageIds: ['foreign-code-parent']
      });
      expect(noteCoreBrowserEvidence(next)).toBe(true);
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
      expect(acknowledgeNativeCompletion(TARGET, NOW + 1000, NOW,
        ['workflow-1', 'workflow-2'], CALLS)).toBe(false);
      expect(coreBrowserEvidence(TARGET)?.pendingCompletion).not.toBeNull();
    });

  it('keeps ordered parent/result ACK and current-observation checks after omission', () => {
    resetCoreBrowserEvidenceForTests();
    expect(noteCoreBrowserEvidence(frame(NOW))).toBe(true);
    expect(noteCoreBrowserEvidence(settled(NOW + 1000, { allCoreRequestIds: undefined }))).toBe(true);
    const candidate = nativeCompletionCandidate(TARGET)!;
    expect(candidate).not.toBeNull();
    expect(acknowledgeNativeCompletion(TARGET, candidate.observedAt, candidate.pendingObservedAt,
      ['workflow-2', 'workflow-1'], CALLS)).toBe(false);
    expect(acknowledgeNativeCompletion(TARGET, candidate.observedAt, candidate.pendingObservedAt,
      ['workflow-1', 'workflow-2'], ['native-call-1', 'native-call-1'])).toBe(false);
    expect(noteCoreBrowserEvidence(settled(NOW + 2000, { allCoreRequestIds: undefined,
      sourceUserMessageId: 'cdcdcdcd-2222-4222-8222-222222222222' }))).toBe(true);
    expect(acknowledgeNativeCompletion(TARGET, candidate.observedAt, candidate.pendingObservedAt,
      ['workflow-1', 'workflow-2'], CALLS)).toBe(false);
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion).not.toBeNull();
  });
});

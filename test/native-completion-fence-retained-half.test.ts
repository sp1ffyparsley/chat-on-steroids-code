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
  it.each(['missing-native', 'invalid-native', 'invalid-request', 'oversized', 'code-only'])(
    'retains the initial negative census when its %s request half cannot be admitted', kind => {
      resetCoreBrowserEvidenceForTests();
      const initial = frame(NOW);
      if (kind === 'missing-native') Object.assign(initial.ordinaryFinal, { coreCallMessageIds: undefined });
      if (kind === 'invalid-native') Object.assign(initial.ordinaryFinal, { coreCallMessageIds: [null, null] });
      if (kind === 'invalid-request') Object.assign(initial.ordinaryFinal, { allCoreRequestIds: [null, null] });
      if (kind === 'oversized') Object.assign(initial.ordinaryFinal, { calls: 201, openCalls: 201,
        coreCallMessageIds: Array.from({ length: 201 }, (_, i) => 'native-' + i),
        allCoreRequestIds: Array.from({ length: 201 }, (_, i) => 'workflow-' + i) });
      if (kind === 'code-only') Object.assign(initial.ordinaryFinal, { reason: 'open-code',
        calls: 0, openCalls: 0, coreCallMessageIds: [], allCoreRequestIds: null,
        codeCalls: 1, openCodeCalls: 1, codeCallMessageIds: ['code-parent'],
        openCodeCallMessageIds: ['code-parent'] });
      expect(noteCoreBrowserEvidence(initial)).toBe(true);
      const retained = coreBrowserEvidence(TARGET)?.pendingCompletion;
      expect(retained).toMatchObject({ calls: initial.ordinaryFinal.calls,
        codeCalls: initial.ordinaryFinal.codeCalls, allCoreRequestIds: kind === 'code-only' ? [] : null });
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
      expect(nativeCompletionDiagnostic(TARGET)?.reason).not.toBe('no-retained-fence');
      // A later empty view cannot erase the original negative census.
      noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1000, ordinaryFinal: null });
      expect(coreBrowserEvidence(TARGET)?.pendingCompletion).toEqual(retained);
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
    });

});

describe('native result wait after browser activation', () => {
  it.each(['document', 'epoch', 'both'])('explains a changed %s without claiming original tool identity changed', kind => {
    resetCoreBrowserEvidenceForTests();
    expect(noteCoreBrowserEvidence(frame(NOW))).toBe(true);
    const next = settled(NOW + 1000);
    if (kind !== 'epoch') next.documentId = 'reloaded-document';
    if (kind !== 'document') next.navigationEpoch = 8;
    expect(noteCoreBrowserEvidence(next)).toBe(true);
    const wait = nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1000)!;
    expect(wait.reason).toBe('evidence');
    expect(wait.detail).toMatch(/browser document or navigation epoch changed/i);
    expect(wait.detail).not.toMatch(/tool identities changed/);
    expect(wait.nextAction).toMatch(/no replay/);
    expect(nativeCompletionDiagnostic(TARGET)?.reason).toBe('document-changed');
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion).toMatchObject({ documentId: DOCUMENT, navigationEpoch: 7, allCoreRequestIds: ['workflow-1', 'workflow-2'] });
  });
});


describe('exact original completion reobserved after navigation', () => {
  it.each(['document', 'epoch', 'both'] as const)('offers only the same complete original for durable verification after %s changes', kind => {
    resetCoreBrowserEvidenceForTests();
    expect(noteCoreBrowserEvidence(frame(Date.now() - 20))).toBe(true);
    const original = coreBrowserEvidence(TARGET)!.pendingCompletion!;
    const next = settled(Date.now(), { settledFinalMessageId: 'abababab-3333-4333-8333-333333333333' });
    if (kind !== 'epoch') next.documentId = 'new-original-document';
    if (kind !== 'document') next.navigationEpoch = 8;
    expect(noteCoreBrowserEvidence(next)).toBe(true);
    const candidate = nativeCompletionCandidate(TARGET);
    expect(candidate).toMatchObject({ allCoreRequestIds: ['workflow-1', 'workflow-2'], coreCallMessageIds: CALLS });
    // A candidate is not completion and never rebinds the original private fence.
    expect(coreBrowserEvidence(TARGET)!.pendingCompletion).toEqual(original);
    expect(acknowledgeNativeCompletion(TARGET, next.observedAt, original.observedAt,
      ['workflow-1'], ['native-call-1'])).toBe(false);
  });

  it.each(['no-final', 'question', 'native-parent', 'request-half', 'missing-original-half',
    'missing-current-half', 'open-result', 'busy', 'stale', 'future', 'code-parent'] as const)(
    'retains the old document fence when reobservation proof is %s', kind => {
      resetCoreBrowserEvidenceForTests();
      const first = frame(Date.now() - 20);
      if (kind === 'missing-original-half') delete (first.ordinaryFinal as any).allCoreRequestIds;
      expect(noteCoreBrowserEvidence(first)).toBe(true);
      const original = coreBrowserEvidence(TARGET)!.pendingCompletion!;
      const now = Date.now();
      const next = settled(now, { settledFinalMessageId: 'abababab-3333-4333-8333-333333333333' });
      next.documentId = 'new-original-document';
      if (kind === 'no-final') delete (next.ordinaryFinal as any).settledFinalMessageId;
      if (kind === 'question') next.ordinaryFinal.sourceUserMessageId = 'abababab-4444-4444-8444-444444444444';
      if (kind === 'native-parent') next.ordinaryFinal.coreCallMessageIds = ['substituted', CALLS[1]!];
      if (kind === 'request-half') next.ordinaryFinal.allCoreRequestIds = ['substituted', 'workflow-2'];
      if (kind === 'missing-current-half') delete (next.ordinaryFinal as any).allCoreRequestIds;
      if (kind === 'open-result') next.ordinaryFinal.openCalls = 1;
      if (kind === 'busy') next.ordinaryFinal.activeTurnMapped = true;
      if (kind === 'stale') next.observedAt = now - 120_000;
      if (kind === 'future') next.observedAt = now + 120_000;
      if (kind === 'code-parent') Object.assign(next.ordinaryFinal, { codeCalls: 1, codeCallMessageIds: ['new-code'], answeredCodeCallMessageIds: ['new-code'] });
      expect(noteCoreBrowserEvidence(next)).toBe(kind !== 'stale');
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
      expect(coreBrowserEvidence(TARGET)!.pendingCompletion).toEqual(original);
    });
});

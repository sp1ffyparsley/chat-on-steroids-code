import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CORE_TOOL_SURFACE_INCIDENT_FRESH_MS,
  DIAGNOSTIC_INCIDENT_BACKLOG_MAX,
  bindDiagnosticIncidentChatNow,
  bindDiagnosticIncidentWakeInputNow,
  claimDiagnosticIncidentWakeNow,
  classifyCoreToolSurfaceFailure,
  classifyProviderRecoveryFailure,
  describeCoreArrival,
  diagnosticIncidentSnapshot,
  diagnosticIncidentWakeClaimCurrent,
  diagnosticIncidentWakeOfferForClaim,
  noteExhaustedDiagnosticIncidentNow,
  projectCoreToolSurfaceIncidentEvidence,
  resetDiagnosticIncidentOwnerForTests,
  retireMissingDiagnosticIncidentChatNow,
  resolveDiagnosticIncidentNow,
  resolveRecoveredDiagnosticIncidentNow,
  settleDiagnosticIncidentWakeNow,
  suppressDiagnosticIncidentsForSourceNow,
  type ExhaustedDiagnosticIncident,
  type CoreToolSurfaceIncidentSources,
  type CoreToolSurfaceIncidentWindow,
  type CoreToolSurfaceEvidence
} from '../src/main/diagnostics.js';
import {
  CORE_BROWSER_EVIDENCE_MAX_AGE_MS,
  CORE_SHELL_CALL_REJECTION_KEYS,
  acknowledgeNativeCompletion,
  coreBrowserEvidence,
  nativeCompletionCandidate,
  nativeFinalEvidenceWait,
  noteCoreBrowserEvidence,
  resetCoreBrowserEvidenceForTests
} from '../src/main/core-browser-evidence.js';
import * as nativeEvidence from '../src/main/core-browser-evidence.js';
import { initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import { emptyEvidence, trackInFlight } from '../src/main/mcp/call-context.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const healthy = (overrides: Partial<CoreToolSurfaceEvidence> = {}): CoreToolSurfaceEvidence => ({
  localServer: 'healthy',
  tunnel: 'healthy',
  route: 'healthy',
  coreIngress: 'unknown',
  toolCall: 'unknown',
  exactIdentity: 'unknown',
  browserShell: 'unknown',
  shellDiscovery: 'unknown',
  browserEvidenceFresh: false,
  connectorName: 'unknown',
  connectorSchema: 'unknown',
  connectorEvidenceFresh: false,
  ...overrides
});

const TARGET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = '11111111-2222-4333-8444-555555555555';
const NOW = 1_800_000_000_000;
const incident = (overrides: Partial<CoreToolSurfaceIncidentWindow> = {}): CoreToolSurfaceIncidentWindow => ({
  conversationId: TARGET,
  startedAt: NOW - 10_000,
  endedAt: NOW,
  now: NOW,
  ...overrides
});
const sources = (overrides: Partial<CoreToolSurfaceIncidentSources> = {}): CoreToolSurfaceIncidentSources => ({
  ingress: { records: [], complete: true },
  toolDispatches: { records: [], complete: true },
  browser: null,
  connector: null,
  serverRunning: true,
  connection: { state: 'connected', handshakeAt: NOW - 1000 },
  requestOwner: () => null,
  ...overrides
});

describe('Core tool-surface incident diagnostics', () => {

  it('retains only complete distinct native scopes and returns detached diagnostic copies', () => {
    resetCoreBrowserEvidenceForTests();
    const observedAt = Date.now() - 1000;
    const frame = (scope: string, at: number): any => ({ conversationId: TARGET, documentId: 'scope-document',
      navigationEpoch: 1, observedAt: at, shell: 'alternate', shellDiscovery: 'compatible',
      requestIds: [], turnId: scope + '-turn', ordinaryFinal: { reason: 'open-call', questions: 1,
        calls: 1, openCalls: 1, codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
        sourceUserMessageId: scope, coreCallMessageIds: [scope + '-parent'], allCoreRequestIds: [scope + '-workflow'],
        openRequestIds: [scope + '-workflow'], codeCallMessageIds: [], openCodeCallMessageIds: [] } });
    const a = frame('aaaaaaaa-1111-4111-8111-111111111111', observedAt);
    const b = frame('bbbbbbbb-1111-4111-8111-111111111111', observedAt + 1);
    expect(noteCoreBrowserEvidence(a)).toBe(true);
    const frozen = coreBrowserEvidence(TARGET)!.pendingCompletion;
    for (const bad of [
      { ...b, turnId: null },
      { ...b, shellDiscovery: 'unknown' },
      { ...b, ordinaryFinal: { ...b.ordinaryFinal, coreCallMessageIds: [] } },
      { ...b, ordinaryFinal: { ...b.ordinaryFinal, sourceUserMessageId: undefined } }
    ]) {
      expect(noteCoreBrowserEvidence(bad)).toBe(true);
      expect(coreBrowserEvidence(TARGET)?.retainedObservations ?? []).toEqual([]);
    }
    expect(noteCoreBrowserEvidence(b)).toBe(true);
    const retained = coreBrowserEvidence(TARGET)!.retainedObservations!;
    expect(retained).toHaveLength(1);
    retained[0]!.coreCallMessageIds[0] = 'caller-mutated-copy';
    expect(coreBrowserEvidence(TARGET)?.retainedObservations?.[0]?.coreCallMessageIds).toEqual(b.ordinaryFinal.coreCallMessageIds);
    // A changed/incomplete/stale same-scope frame cannot rewrite accepted evidence.
    expect(noteCoreBrowserEvidence({ ...b, observedAt: observedAt + 2,
      ordinaryFinal: { ...b.ordinaryFinal, coreCallMessageIds: ['foreign-parent'] } })).toBe(true);
    expect(noteCoreBrowserEvidence({ ...b, observedAt })).toBe(false);
    expect(coreBrowserEvidence(TARGET)?.retainedObservations?.[0]?.coreCallMessageIds).toEqual(b.ordinaryFinal.coreCallMessageIds);
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion).toEqual(frozen);
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
  });

  it('refuses a new scope at cache capacity without evicting the original or earlier scopes', () => {
    resetCoreBrowserEvidenceForTests();
    const at = Date.now() - 1000;
    const frame = (i: number): any => ({ conversationId: TARGET, documentId: 'bounded-scope-document',
      navigationEpoch: 1, observedAt: at + i, shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: 'turn-' + i,
      ordinaryFinal: { reason: 'open-call', questions: 1, calls: 1, openCalls: 1, codeCalls: 0, openCodeCalls: 0,
        activeTurnMapped: false, sourceUserMessageId: String(i).padStart(8, '0') + '-1111-4111-8111-111111111111',
        coreCallMessageIds: ['parent-' + i], allCoreRequestIds: ['workflow-' + i], openRequestIds: ['workflow-' + i],
        codeCallMessageIds: [], openCodeCallMessageIds: [] } });
    expect(noteCoreBrowserEvidence(frame(0))).toBe(true);
    for (let i = 1; i <= 32; i++) expect(noteCoreBrowserEvidence(frame(i))).toBe(true);
    const before = coreBrowserEvidence(TARGET);
    expect(before?.retainedObservations).toHaveLength(32);
    expect(noteCoreBrowserEvidence(frame(33))).toBe(false);
    expect(coreBrowserEvidence(TARGET)).toEqual(before);
    const large = Array.from({ length: 8 }, (_, i) => ({ ...before!.retainedObservations![0]!,
      turnId: 'large-turn-' + i, calls: 200, codeCalls: 200, openCalls: 200, openCodeCalls: 200,
      allCoreRequestIds: Array.from({ length: 200 }, (_, at) => ('r'.repeat(95) + at).padEnd(100, 'r')),
      openRequestIds: Array.from({ length: 200 }, (_, at) => ('r'.repeat(95) + at).padEnd(100, 'r')),
      coreCallMessageIds: Array.from({ length: 200 }, (_, at) => ('p'.repeat(195) + at).padEnd(200, 'p')),
      codeCallMessageIds: Array.from({ length: 200 }, (_, at) => ('c'.repeat(195) + at).padEnd(200, 'c')),
      openCodeCallMessageIds: Array.from({ length: 200 }, (_, at) => ('c'.repeat(195) + at).padEnd(200, 'c')) }));
    expect(nativeEvidence.normalizedNativeCompletionObservation(large[0])).not.toBeNull();
    expect(nativeEvidence.retainNativeCompletionObservationsFromCheckpoint(TARGET, large)).toBe(false);
    expect(coreBrowserEvidence(TARGET)).toEqual(before);
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
  });

  const refusalFrame = (): any => ({ conversationId: TARGET, documentId: 'exact-diagnostic-document',
    navigationEpoch: 4, observedAt: NOW, shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: null,
    ordinaryFinal: { reason: 'open-call', questions: 1, calls: 2, openCalls: 2, codeCalls: 0, openCodeCalls: 0,
      activeTurnMapped: false, sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
      coreCallMessageIds: ['private-parent-a', 'private-parent-b'], codeCallMessageIds: [], openCodeCallMessageIds: [],
      identityRefusals: [{ messageId: 'private-parent-a', reasons: ['workingTurnMismatch'] },
        { messageId: 'private-parent-b', reasons: ['workingTurnMismatch', 'turnExchangeMissing'] }] } });

  it('reports exact native-parent refusal reasons and observation age without granting completion', () => {
    resetCoreBrowserEvidenceForTests();
    noteCoreBrowserEvidence(refusalFrame());
    const diagnostic = nativeEvidence.nativeCompletionDiagnostic(TARGET, NOW + 1000);
    expect(diagnostic).toMatchObject({ reason: 'original-request-identity-missing',
      observation: { observedAt: NOW, ageMs: 1000, freshness: 'fresh' },
      requestIdentity: { failureReasons: [{ code: 'workingTurnMismatch', calls: 2 },
        { code: 'turnExchangeMissing', calls: 1 }] } });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-parent|abababab/);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1000)?.detail).toContain('working turn mismatch');
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1000)?.detail).toContain('Blocker: original-request-identity-missing');
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1000)?.detail).toContain('1s old (fresh)');
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
    const snapshot: any = coreBrowserEvidence(TARGET);
    snapshot.ordinaryFinal.identityRefusals[0].reasons.push('decodedPathMissing');
    expect((coreBrowserEvidence(TARGET)?.ordinaryFinal as any).identityRefusals[0].reasons).toEqual(['workingTurnMismatch']);
  });

  it.each([
    'nativeScopeTurnIncomplete', 'nativeScopePathUnproved', 'nativeScopeFinalCount',
    'nativeScopeFinalPathMismatch', 'nativeScopeFinalReceiptUnproved', 'nativeScopeFinalNamespaceMissing',
    'nativeScopeNodeConflict', 'nativeScopeCacheConflict', 'nativeScopeBranchConflict', 'nativeScopeUnsupported'
  ] as const)('preserves a bounded first native anchor stage without granting original identity: %s', stage => {
    resetCoreBrowserEvidenceForTests();
    const frame = refusalFrame();
    frame.ordinaryFinal.identityRefusals[0].reasons.push(stage);
    expect(noteCoreBrowserEvidence(frame)).toBe(true);
    const snapshot = coreBrowserEvidence(TARGET);
    expect(nativeEvidence.nativeIdentityRefusalSummary(snapshot)).toEqual({ calls: 2, reasons: [
      { code: 'workingTurnMismatch', calls: 2 }, { code: 'turnExchangeMissing', calls: 1 }, { code: stage, calls: 1 }
    ] });
    const diagnostic = nativeEvidence.nativeCompletionDiagnostic(TARGET, NOW);
    expect(diagnostic?.requestIdentity.failureReasons).toContainEqual({ code: stage, calls: 1 });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-parent|abababab/);
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
    const invalid = refusalFrame(); invalid.observedAt++;
    invalid.ordinaryFinal.identityRefusals[0].reasons = [stage, 'PRIVATE_UNKNOWN_ANCHOR_REASON'];
    expect(noteCoreBrowserEvidence(invalid)).toBe(true);
    expect(nativeEvidence.nativeIdentityRefusalSummary(coreBrowserEvidence(TARGET))).toBeNull();
    expect(JSON.stringify(coreBrowserEvidence(TARGET))).not.toContain('PRIVATE_UNKNOWN_ANCHOR_REASON');
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
  });

  it.each(['document', 'epoch', 'question', 'parents'] as const)(
    'does not borrow exact refusal reasons after the retained %s changes', changed => {
      resetCoreBrowserEvidenceForTests();
      noteCoreBrowserEvidence(refusalFrame());
      const later = refusalFrame(); later.observedAt++;
      if (changed === 'document') later.documentId = 'foreign-document';
      if (changed === 'epoch') later.navigationEpoch++;
      if (changed === 'question') later.ordinaryFinal.sourceUserMessageId = '11111111-2222-4333-8444-555555555555';
      if (changed === 'parents') later.ordinaryFinal.coreCallMessageIds.reverse();
      noteCoreBrowserEvidence(later);
      expect(nativeEvidence.nativeCompletionDiagnostic(TARGET, NOW + 2)?.requestIdentity.failureReasons).toBeNull();
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
    });

  it.each(['unknown-reason', 'duplicate-reason', 'foreign-parent', 'partial', 'accessor'] as const)(
    'drops malformed optional refusal diagnostics without evaluating payloads or releasing the fence (%s)', variant => {
      resetCoreBrowserEvidenceForTests();
      const frame = refusalFrame(); let getterReads = 0;
      if (variant === 'unknown-reason') frame.ordinaryFinal.identityRefusals[0].reasons = ['PRIVATE_UNKNOWN_REASON'];
      if (variant === 'duplicate-reason') frame.ordinaryFinal.identityRefusals[0].reasons.push('workingTurnMismatch');
      if (variant === 'foreign-parent') frame.ordinaryFinal.identityRefusals[0].messageId = 'foreign-parent';
      if (variant === 'partial') frame.ordinaryFinal.identityRefusals.pop();
      if (variant === 'accessor') Object.defineProperty(frame.ordinaryFinal.identityRefusals[0], 'reasons', {
        get() { getterReads++; throw new Error('PRIVATE_ACCESSOR'); } });
      expect(noteCoreBrowserEvidence(frame)).toBe(true);
      expect(nativeEvidence.nativeCompletionDiagnostic(TARGET, NOW)?.requestIdentity.failureReasons).toBeNull();
      expect(getterReads).toBe(0);
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
    });

  it('distinguishes a missing original question from stale or future browser observations', () => {
    resetCoreBrowserEvidenceForTests();
    const frame = refusalFrame(); delete frame.ordinaryFinal.sourceUserMessageId;
    noteCoreBrowserEvidence(frame);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)?.detail).toContain('original native question');
    expect(nativeEvidence.nativeCompletionDiagnostic(TARGET, NOW + CORE_BROWSER_EVIDENCE_MAX_AGE_MS + 1)?.observation?.freshness).toBe('stale');
    expect(nativeEvidence.nativeCompletionDiagnostic(TARGET, NOW - 1)?.observation).toMatchObject({ ageMs: null, freshness: 'future' });
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
  });

  it.each([[2, 2], [2, 1], [1, 2], [0, 0]] as const)(
    'does not assign aggregate shell counters to one retained question (%s selected, %s mapped)', (selectorMatches, mapped) => {
      resetCoreBrowserEvidenceForTests();
      const frame = refusalFrame();
      frame.shellScan = { selectorMatches, mapped, rejects: {
        fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0,
        callRequestIdPresent: 2, callRequestIdMissing: 0,
        callIdentityScopeUnproved: 2, callIdentitySelectedWithheld: 2 } };
      expect(noteCoreBrowserEvidence(frame)).toBe(true);
      const before = coreBrowserEvidence(TARGET);
      const diagnostic = nativeEvidence.nativeCompletionDiagnostic(TARGET, NOW);
      expect(diagnostic?.requestIdentity).toEqual({ status: 'unverified',
        selectedFieldsPresent: null, selectedFieldsMissing: null,
        selectedIdentitiesWithheld: null, scopeRefusals: null,
        failureReasons: [{ code: 'workingTurnMismatch', calls: 2 },
          { code: 'turnExchangeMissing', calls: 1 }] });
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
      expect(coreBrowserEvidence(TARGET)).toEqual(before);
      expect(JSON.stringify(diagnostic)).not.toMatch(/private-parent|abababab/);
    });

  it.each(['withheld', 'absent', 'partial', 'different-epoch', 'different-parent', 'unreported'] as const)(
    'distinguishes native request fields from unverified original attribution (%s)', variant => {
      resetCoreBrowserEvidenceForTests();
      const calls = 32;
      const initial: any = { conversationId: TARGET, documentId: 'original-native-document', navigationEpoch: 4,
        observedAt: NOW, shell: 'alternate', shellDiscovery: 'compatible', requestIds: ['unrelated-stream-workflow'],
        turnId: null, shellScan: { selectorMatches: 1, mapped: 1, rejects: {
          fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0,
          callCompletionVeto: calls, callRequestIdPresent: variant === 'absent' ? 0 : variant === 'partial' ? 31 : calls,
          callRequestIdMissing: variant === 'absent' ? calls : variant === 'partial' ? 1 : 0,
          callIdentityScopeUnproved: calls, callIdentitySelectedWithheld: calls } },
        ordinaryFinal: { reason: 'open-call', questions: 1, calls, openCalls: calls,
          codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
          sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
          coreCallMessageIds: Array.from({ length: calls }, (_, n) => `private-native-parent-${n}`),
          codeCallMessageIds: [], openCodeCallMessageIds: [] } };
      noteCoreBrowserEvidence(initial);
      const current = structuredClone(initial);
      current.observedAt++;
      if (variant === 'different-epoch') current.navigationEpoch++;
      if (variant === 'different-parent') current.ordinaryFinal.coreCallMessageIds[0] = 'foreign-native-parent';
      if (variant === 'unreported') delete current.shellScan.rejects.callRequestIdPresent;
      noteCoreBrowserEvidence(current);
      const before = coreBrowserEvidence(TARGET);
      const diagnostic = nativeEvidence.nativeCompletionDiagnostic(TARGET);
      const comparable = !['different-epoch', 'different-parent'].includes(variant);
      expect(diagnostic).toMatchObject({ missingOriginalRequestIds: calls,
        requestIdentity: { status: variant === 'withheld' || variant === 'partial' ? 'reader-withheld'
          : variant === 'absent' ? 'native-field-missing' : 'unverified',
          selectedFieldsPresent: comparable && variant !== 'unreported' ? variant === 'absent' ? 0 : variant === 'partial' ? 31 : calls : null,
          selectedFieldsMissing: comparable ? variant === 'absent' ? calls : variant === 'partial' ? 1 : 0 : null,
          selectedIdentitiesWithheld: comparable ? calls : null } });
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
      expect(coreBrowserEvidence(TARGET)).toEqual(before);
      expect(JSON.stringify(diagnostic)).not.toMatch(/private-native|unrelated-stream|abababab/);
    });

  it.each(['valid', 'busy', 'mapped', 'invalid-user', 'partial-core', 'partial-code'] as const)(
    'normalizes stopped checkpoint %s identity without granting native completion', state => {
      resetCoreBrowserEvidenceForTests();
      const ordinaryFinal: any = { reason: 'turn-invalid', questions: 1, calls: 1, openCalls: 1, codeCalls: 0, openCodeCalls: 0,
        activeTurnMapped: false, checkpointSourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
        coreCallMessageIds: ['checkpoint-unverified-call'], codeCallMessageIds: [] };
      if (state === 'busy') ordinaryFinal.reason = 'busy';
      if (state === 'mapped') ordinaryFinal.activeTurnMapped = true;
      if (state === 'invalid-user') ordinaryFinal.checkpointSourceUserMessageId = 'not-a-native-uuid';
      if (state === 'partial-core') ordinaryFinal.coreCallMessageIds = [];
      if (state === 'partial-code') { ordinaryFinal.codeCalls = 1; ordinaryFinal.openCodeCalls = 1; }
      expect(noteCoreBrowserEvidence({ conversationId: TARGET, documentId: 'checkpoint-native-document', navigationEpoch: 4,
        observedAt: NOW, shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: null, ordinaryFinal })).toBe(true);
      expect(coreBrowserEvidence(TARGET)?.ordinaryFinal?.checkpointSourceUserMessageId)
        .toBe(state === 'valid' ? ordinaryFinal.checkpointSourceUserMessageId : undefined);
      expect(nativeEvidence.settledNativeTurnCandidate(TARGET, NOW)).toBeNull();
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
    });

  it('projects a fresh settled native turn separately without completing unresolved tool receipts', () => {
    resetCoreBrowserEvidenceForTests();
    const user = 'abababab-1111-4111-8111-111111111111';
    const final = 'cdcdcdcd-2222-4222-8222-222222222222';
    noteCoreBrowserEvidence({ conversationId: TARGET, documentId: 'settled-current-document', navigationEpoch: 4,
      observedAt: NOW, shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-call', questions: 1, calls: 1, openCalls: 1, codeCalls: 0, openCodeCalls: 0,
        activeTurnMapped: false, sourceUserMessageId: user, settledFinalMessageId: final,
        coreCallMessageIds: ['original-native-call'] } });
    const candidate = nativeEvidence.settledNativeTurnCandidate(TARGET, NOW);
    expect(candidate).toMatchObject({ documentId: 'settled-current-document', navigationEpoch: 4,
      sourceUserMessageId: user, finalMessageId: final });
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)?.reason).toBe('evidence');
  });

  it.each(['stale', 'future', 'missing-final', 'foreign-final', 'active-turn', 'open-code', 'partial-calls', 'missing-code-result'])(
    'withholds settled native forward-readiness for %s', reason => {
      resetCoreBrowserEvidenceForTests();
      const ordinaryFinal: any = { reason: 'open-call', questions: 1, calls: 1, openCalls: 1,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
        sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
        settledFinalMessageId: 'cdcdcdcd-2222-4222-8222-222222222222', coreCallMessageIds: ['original-native-call'] };
      if (reason === 'missing-final') delete ordinaryFinal.settledFinalMessageId;
      if (reason === 'foreign-final') ordinaryFinal.settledFinalMessageId = ordinaryFinal.sourceUserMessageId;
      if (reason === 'active-turn') ordinaryFinal.activeTurnMapped = true;
      if (reason === 'partial-calls') ordinaryFinal.coreCallMessageIds = [];
      if (reason === 'open-code') { ordinaryFinal.codeCalls = 1; ordinaryFinal.openCodeCalls = 1; }
      if (reason === 'missing-code-result') { ordinaryFinal.codeCalls = 1; ordinaryFinal.codeCallMessageIds = ['original-exec']; }
      noteCoreBrowserEvidence({ conversationId: TARGET, documentId: 'settled-current-document', navigationEpoch: 4,
        observedAt: reason === 'stale' ? NOW - CORE_BROWSER_EVIDENCE_MAX_AGE_MS - 1 : reason === 'future' ? NOW + 1 : NOW,
        shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: null, ordinaryFinal });
      expect(nativeEvidence.settledNativeTurnCandidate(TARGET, NOW)).toBeNull();
    });

  it('projects only fresh exact native completion uncertainty without granting recovery', () => {
    resetCoreBrowserEvidenceForTests();
    const note = (conversationId = TARGET, observedAt = NOW, reason = 'open-call', openCalls = 1, accepted = true) => {
      expect(noteCoreBrowserEvidence({ conversationId, documentId: 'current-document', navigationEpoch: 2,
        observedAt, shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: null,
        ordinaryFinal: { reason, questions: 1, calls: 1, openCalls,
          codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false } })).toBe(accepted);
    };
    note();
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)).toMatchObject({
      reason: 'evidence', detail: expect.stringContaining('not proof that work is running'),
      nextAction: expect.stringContaining('authorizes no replay')
    });
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)).not.toHaveProperty('until');
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(OTHER), NOW)).toBeNull();
    note(TARGET, NOW - 30_001, 'open-call', 1, false);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)).not.toBeNull(); // Older report cannot replace the current owner.
    resetCoreBrowserEvidenceForTests(); note(TARGET, NOW - 30_001);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)).toMatchObject({
      reason: 'evidence', detail: expect.stringContaining('current activity is unknown')
    });
    resetCoreBrowserEvidenceForTests(); note(TARGET, NOW + 1);
    // A one-millisecond local clock reversal cannot turn an unresolved native
    // tool into an authorized Loop Send. Unknown stays unknown.
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)?.reason).toBe('evidence');
    for (const reason of ['associated', 'busy', 'local-owner', 'question-invalid', 'turn-invalid', 'open-code', 'final-invalid']) {
      resetCoreBrowserEvidenceForTests(); note(TARGET, NOW, reason);
      expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)).toBeNull();
    }
    resetCoreBrowserEvidenceForTests(); note(TARGET, NOW, 'open-call', 0);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)).toBeNull();
    resetCoreBrowserEvidenceForTests();
  });

  it('uses the latest browser observation for freshness without aging away the original unresolved fence', () => {
    resetCoreBrowserEvidenceForTests();
    const open = { conversationId: TARGET, documentId: 'refreshed-original-document', navigationEpoch: 4,
      observedAt: NOW - CORE_BROWSER_EVIDENCE_MAX_AGE_MS - 1, shell: 'alternate' as const,
      shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-call' as const, questions: 1, calls: 1, openCalls: 1,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false } };
    expect(noteCoreBrowserEvidence(open)).toBe(true);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)?.detail).toContain('current activity is unknown');
    expect(noteCoreBrowserEvidence({ ...open, observedAt: NOW })).toBe(true);
    const refreshed = coreBrowserEvidence(TARGET)!;
    expect(refreshed.pendingCompletion?.observedAt).toBe(open.observedAt);
    expect(nativeFinalEvidenceWait(refreshed, NOW)).toMatchObject({ reason: 'evidence',
      detail: expect.stringContaining('exact native tool completion remains unresolved') });
    expect(nativeFinalEvidenceWait(refreshed, NOW)).not.toHaveProperty('until');
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
    expect(nativeFinalEvidenceWait(refreshed, NOW + CORE_BROWSER_EVIDENCE_MAX_AGE_MS + 1)?.detail)
      .toContain('current activity is unknown');
    resetCoreBrowserEvidenceForTests();
  });

  it('withholds automatic completion for a pending native Code Mode result as well as an ordinary Core call', () => {
    resetCoreBrowserEvidenceForTests();
    noteCoreBrowserEvidence({
      conversationId: TARGET, documentId: 'actual-code-final-document', navigationEpoch: 1,
      observedAt: NOW, shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-code', questions: 1, calls: 0, openCalls: 0,
        codeCalls: 1, openCodeCalls: 1, activeTurnMapped: false }
    });
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)).toMatchObject({
      reason: 'evidence', nextAction: expect.stringContaining('authorizes no replay')
    });
    resetCoreBrowserEvidenceForTests();
  });

  it('keeps an unresolved native final unknown after the freshness window until new positive native evidence arrives', () => {
    resetCoreBrowserEvidenceForTests();
    const unresolved = { conversationId: TARGET, documentId: 'same-native-document',
      navigationEpoch: 5, observedAt: NOW - CORE_BROWSER_EVIDENCE_MAX_AGE_MS - 1,
      shell: 'alternate' as const, shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-call' as const, questions: 1, calls: 1,
        openCalls: 1, codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false } };
    expect(noteCoreBrowserEvidence(unresolved)).toBe(true);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)).toMatchObject({
      reason: 'evidence', detail: expect.stringContaining('current activity is unknown'),
      nextAction: expect.stringContaining('authorizes no replay')
    });
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(OTHER), NOW)).toBeNull();
    expect(noteCoreBrowserEvidence({ ...unresolved, observedAt: NOW,
      ordinaryFinal: { ...unresolved.ordinaryFinal, reason: 'associated', openCalls: 0 } })).toBe(true);
    // Associated prose on the same document without exact question/request evidence
    // cannot prove the earlier MCP result, no matter how stale the old frame is.
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)?.reason).toBe('evidence');
    resetCoreBrowserEvidenceForTests();
  });

  it('retains an unknown native tool-completion fence across reconnect and transient unobserved shell frames', () => {
    resetCoreBrowserEvidenceForTests();
    const initial = { conversationId: TARGET, documentId: 'terminal-first-document',
      navigationEpoch: 2, observedAt: NOW, shell: 'alternate' as const,
      shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-call' as const, questions: 1, calls: 1, openCalls: 1,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false } };
    expect(noteCoreBrowserEvidence(initial)).toBe(true);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)?.reason).toBe('evidence');
    // The browser worker authenticated a new document, but its Fiber frame is
    // missing. Navigation is not proof that the old MCP request completed.
    expect(noteCoreBrowserEvidence({ ...initial, documentId: 'reconnected-document',
      navigationEpoch: 0, observedAt: NOW + 1, shellDiscovery: 'unknown',
      ordinaryFinal: null } as any)).toBe(true);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1)).toMatchObject({
      reason: 'evidence'
    });
    const retained = coreBrowserEvidence(TARGET)!;
    expect(retained.documentId).toBe('reconnected-document');
    expect(retained.navigationEpoch).toBe(0);
    // Without the original request identity, a different document's generic
    // terminal text cannot retroactively establish the missing Core result.
    noteCoreBrowserEvidence({ ...initial, documentId: 'reconnected-document',
      navigationEpoch: 0, observedAt: NOW + 2,
      ordinaryFinal: { ...initial.ordinaryFinal, reason: 'associated', openCalls: 0 } });
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 2)?.reason).toBe('evidence');
    resetCoreBrowserEvidenceForTests();
  });

  it.each(['failed', 'unknown'] as const)(
    'retains an already witnessed negative native census on a %s reader before the first Main observation', shellDiscovery => {
      resetCoreBrowserEvidenceForTests();
      const initial = { conversationId: TARGET, documentId: 'reader-lost-native-document',
        navigationEpoch: 4, observedAt: NOW, shell: 'alternate' as const,
        shellDiscovery, requestIds: [], turnId: null,
        ordinaryFinal: { reason: 'turn-invalid' as const, questions: 1, calls: 0,
          openCalls: 0, codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
          callInventoryComplete: false as const } };
      expect(noteCoreBrowserEvidence(initial)).toBe(true);
      expect(coreBrowserEvidence(TARGET)?.shellDiscovery).toBe(shellDiscovery);
      expect(coreBrowserEvidence(TARGET)?.pendingCompletion?.reason).toBe('inventory-incomplete');
      expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)?.reason).toBe('evidence');
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
      // A newer document can look finished but cannot repair the old unknown parent.
      noteCoreBrowserEvidence({ ...initial, documentId: 'replacement-native-document', observedAt: NOW + 1,
        shellDiscovery: 'compatible', ordinaryFinal: { ...initial.ordinaryFinal,
          reason: 'associated', callInventoryComplete: undefined,
          sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
          settledFinalMessageId: 'cdcdcdcd-2222-4222-8222-222222222222' } });
      expect(coreBrowserEvidence(TARGET)?.pendingCompletion?.reason).toBe('inventory-incomplete');
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
      // A distinct conversation's later provider state has no authority over
      // the retained old document, even if its visible answer is complete.
      noteCoreBrowserEvidence({ ...initial, conversationId: OTHER, documentId: 'foreign-native-document',
        observedAt: NOW + 2, shellDiscovery: 'compatible', ordinaryFinal: null });
      expect(coreBrowserEvidence(OTHER)?.pendingCompletion).toBeNull();
      expect(coreBrowserEvidence(TARGET)?.pendingCompletion?.reason).toBe('inventory-incomplete');
      resetCoreBrowserEvidenceForTests();
    }
  );

  it.each([
    ['incomplete', 'inventory-incomplete'], ['document', 'document-changed'],
    ['question', 'question-changed'], ['core-parent', 'parents-changed'], ['code-parent', 'parents-changed'],
    ['missing-source', 'original-source-missing'], ['missing-native', 'original-native-identity-missing'],
    ['missing-request', 'original-request-identity-missing'], ['open-result', 'native-results-open'],
    ['candidate', 'durable-proof-required']
  ] as const)('projects the bounded native completion refusal for %s without changing its fence', (variant, reason) => {
    resetCoreBrowserEvidenceForTests();
    const initial: any = { conversationId: TARGET, documentId: 'diagnostic-original-document', navigationEpoch: 4,
      observedAt: NOW, shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-call', questions: 1, calls: 1, openCalls: 1, codeCalls: 1, openCodeCalls: 0,
        activeTurnMapped: false, sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
        coreCallMessageIds: ['private-core-parent'], allCoreRequestIds: ['private-workflow-request'],
        openRequestIds: ['private-workflow-request'], codeCallMessageIds: ['private-code-parent'],
        openCodeCallMessageIds: [], answeredCodeCallMessageIds: ['private-code-parent'] } };
    if (variant === 'missing-source') delete initial.ordinaryFinal.sourceUserMessageId;
    if (variant === 'missing-native') delete initial.ordinaryFinal.coreCallMessageIds;
    if (variant === 'missing-request') delete initial.ordinaryFinal.allCoreRequestIds;
    noteCoreBrowserEvidence(initial);
    const final: any = { ...initial.ordinaryFinal, reason: 'associated', openCalls: 0, openRequestIds: [] };
    if (variant === 'question') final.sourceUserMessageId = OTHER;
    if (variant === 'core-parent') final.coreCallMessageIds = ['different-private-parent'];
    if (variant === 'code-parent') final.codeCallMessageIds = ['different-private-code'];
    if (variant === 'incomplete') final.callInventoryComplete = false;
    if (variant === 'open-result') { final.reason = 'open-call'; final.openCalls = 1; }
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: final,
      ...(variant === 'document' ? { documentId: 'different-private-document' } : {}) });
    const before = coreBrowserEvidence(TARGET);
    expect(typeof nativeEvidence.nativeCompletionDiagnostic).toBe('function');
    const diagnostic = nativeEvidence.nativeCompletionDiagnostic(TARGET);
    expect(diagnostic).toMatchObject({ reason, retainedCalls: 1, retainedCodeCalls: 1,
      missingOriginalNativeIds: variant === 'missing-native' ? 1 : 0,
      missingOriginalRequestIds: ['missing-native', 'missing-request'].includes(variant) ? 1 : 0 });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-|abababab|aaaaaaaa|bbbbbbbb/);
    expect(coreBrowserEvidence(TARGET)).toEqual(before);
    expect(nativeCompletionCandidate(TARGET) !== null).toBe(variant === 'candidate');
    resetCoreBrowserEvidenceForTests();
  });

  it.each(['open-call', 'open-code'] as const)(
    'strengthens an existing %s fence when a later native census is incomplete', reason => {
      const initial = { conversationId: TARGET, documentId: 'late-incomplete-native-document',
        navigationEpoch: 4, observedAt: NOW, shell: 'alternate' as const,
        shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
        ordinaryFinal: { reason, questions: 1, calls: 1, openCalls: reason === 'open-call' ? 1 : 0,
          codeCalls: 1, openCodeCalls: reason === 'open-code' ? 1 : 0, activeTurnMapped: false,
          sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
          coreCallMessageIds: ['original-core-parent'], allCoreRequestIds: ['wfr_original_parent'],
          openRequestIds: reason === 'open-call' ? ['wfr_original_parent'] : [],
          codeCallMessageIds: ['original-code-parent'],
          openCodeCallMessageIds: reason === 'open-code' ? ['original-code-parent'] : [],
          answeredCodeCallMessageIds: reason === 'open-code' ? [] : ['original-code-parent'] } };
      const final = { ...initial.ordinaryFinal, reason: 'associated' as const,
        openCalls: 0, openCodeCalls: 0, openRequestIds: [], openCodeCallMessageIds: [],
        answeredCodeCallMessageIds: ['original-code-parent'] };
      try {
        // Without a negative census, exact original proof still permits acknowledgment.
        resetCoreBrowserEvidenceForTests();
        noteCoreBrowserEvidence(initial);
        noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: final });
        expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW,
          ['wfr_original_parent'], ['original-core-parent'])).toBe(true);

        for (const shellDiscovery of ['compatible', 'failed', 'unknown'] as const) {
          resetCoreBrowserEvidenceForTests();
          noteCoreBrowserEvidence(initial);
          const original = coreBrowserEvidence(TARGET)!.pendingCompletion!;
          // The content census hold can omit the selected user and every call ID.
          noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, shellDiscovery,
            ordinaryFinal: { reason: 'turn-invalid', questions: 1, calls: 0, openCalls: 0,
              codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false, callInventoryComplete: false } });
          noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 2, ordinaryFinal: final });
          expect(coreBrowserEvidence(TARGET)?.pendingCompletion)
            .toEqual({ ...original, reason: 'inventory-incomplete' });
          expect(nativeCompletionCandidate(TARGET)).toBeNull();
          expect(acknowledgeNativeCompletion(TARGET, NOW + 2, NOW,
            ['wfr_original_parent'], ['original-core-parent'])).toBe(false);
          expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 2)?.detail).toContain('incomplete');
        }
        // A foreign current source cannot settle even the original complete census.
        resetCoreBrowserEvidenceForTests();
        noteCoreBrowserEvidence(initial);
        noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: {
          ...final, sourceUserMessageId: 'cdcdcdcd-2222-4222-8222-222222222222' } });
        expect(nativeCompletionCandidate(TARGET)).toBeNull();
        expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW,
          ['wfr_original_parent'], ['original-core-parent'])).toBe(false);
      } finally { resetCoreBrowserEvidenceForTests(); }
    }
  );

  it('never clears an earlier unanswered native Core call just because a different question has an associated final in the same browser document', () => {
    resetCoreBrowserEvidenceForTests();
    const shell = { conversationId: TARGET, documentId: 'same-browser-different-question',
      navigationEpoch: 4, observedAt: NOW, shell: 'alternate' as const,
      shellDiscovery: 'compatible' as const, requestIds: [], turnId: 'answer-viewport',
      ordinaryFinal: { reason: 'open-call' as const, questions: 1, calls: 1, openCalls: 1,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
        sourceUserMessageId: 'aaaabbbb-1111-4111-8111-111111111111',
        openRequestIds: ['wfr_prior_unfinished_core'] } };
    expect(noteCoreBrowserEvidence(shell)).toBe(true);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)?.reason).toBe('evidence');
    expect(noteCoreBrowserEvidence({ ...shell, observedAt: NOW + 1, ordinaryFinal: {
      ...shell.ordinaryFinal, reason: 'associated', openCalls: 0,
      sourceUserMessageId: 'ccccdddd-2222-4222-8222-222222222222', openRequestIds: []
    } })).toBe(true);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1)?.reason).toBe('evidence');
    resetCoreBrowserEvidenceForTests();
  });

  it('does not describe absent zero-count Code Mode identifiers as a different native parent', () => {
    resetCoreBrowserEvidenceForTests();
    const sourceUserMessageId = 'abcdabcd-1111-4111-8111-111111111111';
    const opened = { conversationId: TARGET, documentId: 'core-only-no-code-parent',
      navigationEpoch: 1, observedAt: NOW, shell: 'alternate' as const,
      shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-call' as const, questions: 1, calls: 1, openCalls: 1,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false, sourceUserMessageId,
        coreCallMessageIds: ['one-native-core'], allCoreRequestIds: ['wfr_one_native_core'] } };
    noteCoreBrowserEvidence(opened);
    noteCoreBrowserEvidence({ ...opened, observedAt: NOW + 1, ordinaryFinal: {
      ...opened.ordinaryFinal, reason: 'associated', openCalls: 0
    } });
    const wait = nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1);
    expect(wait?.reason).toBe('evidence');
    expect(wait?.detail).not.toContain('identities changed');
    resetCoreBrowserEvidenceForTests();
  });

  it('accepts only the original Code Mode parent tool-result receipt and never unrelated final text or missing native call ids', () => {
    resetCoreBrowserEvidenceForTests();
    const question = '1111aaaa-1111-4111-8111-111111111111';
    const initial = { conversationId: TARGET, documentId: 'code-parent-receipt-document',
      navigationEpoch: 5, observedAt: NOW, shell: 'alternate' as const,
      shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-code' as const, questions: 1, calls: 0, openCalls: 0,
        codeCalls: 1, openCodeCalls: 1, activeTurnMapped: false,
        sourceUserMessageId: question, openCodeCallMessageIds: ['native-exec-parent-A'],
        codeCallMessageIds: ['native-exec-parent-A'],
        answeredCodeCallMessageIds: [] } };
    expect(noteCoreBrowserEvidence(initial)).toBe(true);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW)?.reason).toBe('evidence');
    const final = { ...initial.ordinaryFinal, reason: 'associated' as const,
      openCodeCalls: 0, openCodeCallMessageIds: [], answeredCodeCallMessageIds: ['different-native-exec-parent'] };
    expect(noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: final })).toBe(true);
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1)?.reason).toBe('evidence');
    expect(noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 2,
      ordinaryFinal: { ...final, answeredCodeCallMessageIds: ['native-exec-parent-A'] } })).toBe(true);
    const candidate = nativeCompletionCandidate(TARGET);
    expect(candidate).toMatchObject({ reason: 'open-code', observedAt: NOW + 2, openCalls: 0 });
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, [])).toBe(false);
    expect(acknowledgeNativeCompletion(TARGET, NOW + 2, NOW, [])).toBe(true);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 2)).toBeNull();
    resetCoreBrowserEvidenceForTests();
    expect(noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 3,
      ordinaryFinal: { ...initial.ordinaryFinal, openCodeCallMessageIds: undefined } })).toBe(true);
    expect(noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 4,
      ordinaryFinal: { ...final, answeredCodeCallMessageIds: ['native-exec-parent-A'] } })).toBe(true);
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 4)?.reason).toBe('evidence');
    resetCoreBrowserEvidenceForTests();
  });

  it('requires both exact Core outcomes and parent Code Mode results when the same native final contains both open call types', () => {
    resetCoreBrowserEvidenceForTests();
    const user = '2222bbbb-2222-4222-8222-222222222222';
    const source = { conversationId: TARGET, documentId: 'mixed-native-document', navigationEpoch: 1,
      observedAt: NOW, shell: 'alternate' as const, shellDiscovery: 'compatible' as const,
      requestIds: [], turnId: null, ordinaryFinal: {
        reason: 'open-call' as const, questions: 1, calls: 1, openCalls: 1, codeCalls: 1, openCodeCalls: 1,
        activeTurnMapped: false, sourceUserMessageId: user, openRequestIds: ['wfr_mixed_native_core'],
        allCoreRequestIds: ['wfr_mixed_native_core'], coreCallMessageIds: ['mixed-core-message'],
        codeCallMessageIds: ['mixed-code-parent'],
        openCodeCallMessageIds: ['mixed-code-parent'], answeredCodeCallMessageIds: []
      } };
    noteCoreBrowserEvidence(source);
    const final = { ...source.ordinaryFinal, reason: 'associated' as const, openCalls: 0, openCodeCalls: 0,
      openRequestIds: [], openCodeCallMessageIds: [], answeredCodeCallMessageIds: ['mixed-code-parent'] };
    noteCoreBrowserEvidence({ ...source, observedAt: NOW + 1, ordinaryFinal: final });
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, [])).toBe(false);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1)?.reason).toBe('evidence');
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, ['wfr_mixed_native_core'])).toBe(true);
    resetCoreBrowserEvidenceForTests();
  });

  it('cannot promote a native final when an already-answered sibling has no durable Core receipt or when an extra call appeared later', () => {
    const original = { conversationId: TARGET, documentId: 'durable-complete-sibling',
      navigationEpoch: 1, observedAt: NOW, shell: 'alternate' as const,
      shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-call' as const, questions: 1, calls: 2, openCalls: 1,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
        sourceUserMessageId: 'abcdefff-1111-4111-8111-111111111111',
        openRequestIds: ['wfr_still_pending'], allCoreRequestIds: ['wfr_initially_answered', 'wfr_still_pending'],
        coreCallMessageIds: ['original-native-a', 'original-native-b'] } };
    resetCoreBrowserEvidenceForTests();
    noteCoreBrowserEvidence(original);
    const final = { ...original.ordinaryFinal, reason: 'associated' as const,
      openCalls: 0, openRequestIds: [] };
    noteCoreBrowserEvidence({ ...original, observedAt: NOW + 1, ordinaryFinal: final });
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, ['wfr_still_pending'])).toBe(false);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1)?.reason).toBe('evidence');
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW,
      ['wfr_initially_answered', 'wfr_still_pending'])).toBe(true);
    resetCoreBrowserEvidenceForTests();
    noteCoreBrowserEvidence(original);
    noteCoreBrowserEvidence({ ...original, observedAt: NOW + 2, ordinaryFinal: {
      ...final, calls: 3, allCoreRequestIds: [...original.ordinaryFinal.allCoreRequestIds, 'wfr_unseen_third'],
      coreCallMessageIds: [...original.ordinaryFinal.coreCallMessageIds, 'unseen-native-c']
    } });
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 2)?.reason).toBe('evidence');
    resetCoreBrowserEvidenceForTests();
  });

  it('enriches initially absent workflow request IDs only for the identical native question, document, and call message IDs', () => {
    const initial = { conversationId: TARGET, documentId: 'late-request-document',
      navigationEpoch: 7, observedAt: NOW, shell: 'alternate' as const,
      shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-call' as const, questions: 1, calls: 1, openCalls: 1,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
        sourceUserMessageId: 'babababa-1111-4111-8111-111111111111',
        coreCallMessageIds: ['stable-native-tool-request'] } };
    const later = { ...initial.ordinaryFinal, openRequestIds: ['wfr_late_matched_native'],
      allCoreRequestIds: ['wfr_late_matched_native'] };
    resetCoreBrowserEvidenceForTests();
    noteCoreBrowserEvidence(initial);
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: later });
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion?.allCoreRequestIds).toEqual(['wfr_late_matched_native']);
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 2, ordinaryFinal: {
      ...later, reason: 'associated', openCalls: 0, openRequestIds: []
    } });
    expect(nativeCompletionCandidate(TARGET)).toMatchObject({
      pendingObservedAt: NOW, allCoreRequestIds: ['wfr_late_matched_native'] });
    expect(acknowledgeNativeCompletion(TARGET, NOW + 2, NOW, [])).toBe(false);
    expect(acknowledgeNativeCompletion(TARGET, NOW + 2, NOW, ['wfr_late_matched_native'])).toBe(true);
    resetCoreBrowserEvidenceForTests();
    noteCoreBrowserEvidence(initial);
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: {
      ...later, coreCallMessageIds: ['replaced-tool-request'] } });
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion?.allCoreRequestIds).toBeNull();
    resetCoreBrowserEvidenceForTests();
    noteCoreBrowserEvidence(initial);
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: {
      ...later, sourceUserMessageId: 'cdcdcdcd-1111-4111-8111-111111111111' } });
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion?.allCoreRequestIds).toBeNull();
    resetCoreBrowserEvidenceForTests();
  });

  it.each([
    ['replaced', ['foreign-code-parent', 'original-code-b']],
    ['missing', undefined],
    ['reordered', ['original-code-b', 'original-code-a']]
  ] as const)('does not poison late Core receipt recovery with %s Code Mode parents', (_variant, codeParents) => {
    resetCoreBrowserEvidenceForTests();
    const initial = { conversationId: TARGET, documentId: 'late-mixed-receipt-document',
      navigationEpoch: 7, observedAt: NOW, shell: 'alternate' as const,
      shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-call' as const, questions: 1, calls: 1, openCalls: 1,
        codeCalls: 2, openCodeCalls: 1, activeTurnMapped: false,
        sourceUserMessageId: 'babababa-1111-4111-8111-111111111111',
        coreCallMessageIds: ['original-core-parent'],
        codeCallMessageIds: ['original-code-a', 'original-code-b'],
        openCodeCallMessageIds: ['original-code-b'], answeredCodeCallMessageIds: ['original-code-a'] } };
    noteCoreBrowserEvidence(initial);
    const originalFence = coreBrowserEvidence(TARGET)?.pendingCompletion;
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: {
      ...initial.ordinaryFinal, allCoreRequestIds: ['wfr_from_conflicting_census'],
      codeCallMessageIds: codeParents ? [...codeParents] : undefined
    } });
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion).toEqual(originalFence);
    expect(nativeCompletionCandidate(TARGET)).toBeNull();

    // A rejected observation must not pin its workflow into the original fence.
    // The subsequent complete original inventory can still recover normally.
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 2, ordinaryFinal: {
      ...initial.ordinaryFinal, reason: 'associated', openCalls: 0, openCodeCalls: 0,
      openRequestIds: [], openCodeCallMessageIds: [],
      allCoreRequestIds: ['wfr_original_complete'],
      answeredCodeCallMessageIds: ['original-code-a', 'original-code-b']
    } });
    expect(nativeCompletionCandidate(TARGET)).toMatchObject({
      pendingObservedAt: NOW, allCoreRequestIds: ['wfr_original_complete']
    });
    expect(acknowledgeNativeCompletion(TARGET, NOW + 2, NOW,
      ['wfr_original_complete'], ['original-core-parent'])).toBe(true);
    resetCoreBrowserEvidenceForTests();
  });

  it('retains an unknown original Code Mode census instead of enriching a mixed Core receipt', () => {
    resetCoreBrowserEvidenceForTests();
    const initial = { conversationId: TARGET, documentId: 'unknown-original-mixed-census',
      navigationEpoch: 1, observedAt: NOW, shell: 'alternate' as const,
      shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-call' as const, questions: 1, calls: 1, openCalls: 1,
        codeCalls: 1, openCodeCalls: 1, activeTurnMapped: false,
        sourceUserMessageId: 'babababa-1111-4111-8111-111111111111',
        coreCallMessageIds: ['known-original-core'] } };
    noteCoreBrowserEvidence(initial);
    const original = coreBrowserEvidence(TARGET)?.pendingCompletion;
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: {
      ...initial.ordinaryFinal, allCoreRequestIds: ['wfr_later_unknown_parent'],
      codeCallMessageIds: ['later-code-parent'], openCodeCallMessageIds: ['later-code-parent']
    } });
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion).toEqual(original);
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
    resetCoreBrowserEvidenceForTests();
  });

  it('recovers a complete mixed census without deduplicating shared Core workflow receipts', () => {
    resetCoreBrowserEvidenceForTests();
    const initial = { conversationId: TARGET, documentId: 'mixed-shared-receipt-document',
      navigationEpoch: 1, observedAt: NOW, shell: 'alternate' as const,
      shellDiscovery: 'compatible' as const, requestIds: [], turnId: null,
      ordinaryFinal: { reason: 'open-call' as const, questions: 1, calls: 2, openCalls: 2,
        codeCalls: 1, openCodeCalls: 1, activeTurnMapped: false,
        sourceUserMessageId: 'babababa-1111-4111-8111-111111111111',
        coreCallMessageIds: ['original-core-a', 'original-core-b'],
        codeCallMessageIds: ['original-code'], openCodeCallMessageIds: ['original-code'] } };
    noteCoreBrowserEvidence(initial);
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: {
      ...initial.ordinaryFinal, reason: 'associated', openCalls: 0, openCodeCalls: 0,
      allCoreRequestIds: ['wfr_shared', 'wfr_shared'],
      openRequestIds: [], openCodeCallMessageIds: [], answeredCodeCallMessageIds: ['original-code']
    } });
    expect(nativeCompletionCandidate(TARGET)?.allCoreRequestIds).toEqual(['wfr_shared', 'wfr_shared']);
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW,
      ['wfr_shared', 'wfr_shared'], ['original-core-a', 'original-core-b'])).toBe(true);
    resetCoreBrowserEvidenceForTests();
  });

  it('requires exact ordered native-call proofs when several calls share one workflow', () => {
    resetCoreBrowserEvidenceForTests();
    const requests = ['wfr_shared_owned_calls', 'wfr_shared_owned_calls'];
    const messages = ['native-owned-first', 'native-owned-second'];
    const initial = { conversationId: TARGET, documentId: 'owned-shared-native-proof', navigationEpoch: 3,
      observedAt: NOW, shell: 'alternate' as const, shellDiscovery: 'compatible' as const,
      requestIds: [], turnId: null, ordinaryFinal: {
        reason: 'open-call' as const, questions: 1, calls: 2, openCalls: 2,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
        sourceUserMessageId: 'abcddcba-1111-4111-8111-111111111111',
        coreCallMessageIds: messages, allCoreRequestIds: requests, openRequestIds: requests
      } };
    expect(noteCoreBrowserEvidence(initial)).toBe(true);
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: {
      ...initial.ordinaryFinal, reason: 'associated', openCalls: 0, openRequestIds: [] } });
    expect(nativeCompletionCandidate(TARGET)?.allCoreRequestIds).toEqual(requests);
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, requests)).toBe(false);
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, requests, [messages[0]!, messages[0]!])).toBe(false);
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, requests, [...messages].reverse())).toBe(false);
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, requests, messages)).toBe(true);
  });

  it.each([17, 25, 85, 200])('retains the complete native completion proof for %i Core calls', count => {
    resetCoreBrowserEvidenceForTests();
    const requests = Array.from({ length: count }, (_, i) => `wfr_capacity_${i}`);
    const messages = Array.from({ length: count }, (_, i) => `native-capacity-call-${i}`);
    const initial = { conversationId: TARGET, documentId: 'complete-large-native-proof', navigationEpoch: 3,
      observedAt: NOW, shell: 'alternate' as const, shellDiscovery: 'compatible' as const,
      requestIds: [], turnId: null, ordinaryFinal: {
        reason: 'open-call' as const, questions: 1, calls: count, openCalls: count,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
        sourceUserMessageId: 'abcddcba-1111-4111-8111-111111111111',
        coreCallMessageIds: messages, allCoreRequestIds: requests, openRequestIds: requests
      } };
    expect(noteCoreBrowserEvidence(initial)).toBe(true);
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion).toMatchObject({
      coreCallMessageIds: messages, allCoreRequestIds: requests, openRequestIds: requests });
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: {
      ...initial.ordinaryFinal, reason: 'associated', openCalls: 0, openRequestIds: [] } });
    expect(nativeCompletionCandidate(TARGET)).toMatchObject({ coreCallMessageIds: messages,
      allCoreRequestIds: requests, openCalls: count });
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, requests.slice(0, -1))).toBe(false);
    expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1)?.reason).toBe('evidence');
    expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, requests)).toBe(true);
    resetCoreBrowserEvidenceForTests();
  });

  it.each([17, 25, 85, 200])('retains all %i original Code Mode parents and refuses a missing parent result', count => {
    resetCoreBrowserEvidenceForTests();
    const parents = Array.from({ length: count }, (_, i) => `native-capacity-exec-${i}`);
    const initial = { conversationId: TARGET, documentId: 'complete-large-code-proof', navigationEpoch: 2,
      observedAt: NOW, shell: 'alternate' as const, shellDiscovery: 'compatible' as const,
      requestIds: [], turnId: null, ordinaryFinal: {
        reason: 'open-code' as const, questions: 1, calls: 0, openCalls: 0,
        codeCalls: count, openCodeCalls: count, activeTurnMapped: false,
        sourceUserMessageId: 'abcddcba-2222-4222-8222-222222222222',
        coreCallMessageIds: [], allCoreRequestIds: [], codeCallMessageIds: parents,
        openCodeCallMessageIds: parents, answeredCodeCallMessageIds: []
      } };
    noteCoreBrowserEvidence(initial);
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion?.codeCallMessageIds).toEqual(parents);
    const final = { ...initial.ordinaryFinal, reason: 'associated' as const, openCodeCalls: 0,
      openCodeCallMessageIds: [], answeredCodeCallMessageIds: parents.slice(0, -1) };
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: final });
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 2, ordinaryFinal: {
      ...final, answeredCodeCallMessageIds: parents } });
    expect(nativeCompletionCandidate(TARGET)).not.toBeNull();
    expect(acknowledgeNativeCompletion(TARGET, NOW + 2, NOW, [])).toBe(true);
    resetCoreBrowserEvidenceForTests();
  });

  it.each(['duplicate-message', 'duplicate-request', 'replaced-message', 'replaced-request', 'missing-result',
    'different-user', 'different-document', 'different-epoch'] as const)(
    'keeps a large native proof held for %s instead of accepting a partial or foreign set', mutation => {
      const messages = Array.from({ length: 25 }, (_, i) => `native-unchanged-${i}`);
      const requests = Array.from({ length: 25 }, (_, i) => `wfr_unchanged_${i}`);
      const initial = { conversationId: TARGET, documentId: 'same-large-proof', navigationEpoch: 4,
        observedAt: NOW, shell: 'alternate' as const, shellDiscovery: 'compatible' as const,
        requestIds: [], turnId: null, ordinaryFinal: {
          reason: 'open-call' as const, questions: 1, calls: 25, openCalls: 25,
          codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
          sourceUserMessageId: 'abcddcba-4444-4444-8444-444444444444',
          coreCallMessageIds: messages, allCoreRequestIds: requests, openRequestIds: requests
        } };
      resetCoreBrowserEvidenceForTests(); noteCoreBrowserEvidence(initial);
      const final = { ...initial, observedAt: NOW + 1, ordinaryFinal: {
        ...initial.ordinaryFinal, reason: 'associated' as const, openCalls: 0,
        coreCallMessageIds: [...messages], allCoreRequestIds: [...requests], openRequestIds: [] as string[] } };
      if (mutation === 'duplicate-message') final.ordinaryFinal.coreCallMessageIds[24] = messages[0]!;
      if (mutation === 'duplicate-request') final.ordinaryFinal.allCoreRequestIds[24] = requests[0]!;
      if (mutation === 'replaced-message') final.ordinaryFinal.coreCallMessageIds[24] = 'foreign-native-message';
      if (mutation === 'replaced-request') final.ordinaryFinal.allCoreRequestIds[24] = 'wfr_foreign';
      if (mutation === 'missing-result') final.ordinaryFinal.openCalls = 1;
      if (mutation === 'different-user') final.ordinaryFinal.sourceUserMessageId = 'abcddcba-5555-4555-8555-555555555555';
      if (mutation === 'different-document') final.documentId = 'reloaded-large-proof';
      if (mutation === 'different-epoch') final.navigationEpoch++;
      noteCoreBrowserEvidence(final);
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
      expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, requests)).toBe(false);
      expect(nativeFinalEvidenceWait(coreBrowserEvidence(TARGET), NOW + 1)?.reason).toBe('evidence');
      resetCoreBrowserEvidenceForTests();
    });

  it('does not adopt missing original proof or a truncated oversized proof from a later large final', () => {
    const messages = Array.from({ length: 201 }, (_, i) => `native-large-${i}`);
    const requests = Array.from({ length: 201 }, (_, i) => `wfr_large_${i}`);
    const initial = { conversationId: TARGET, documentId: 'unproved-original-capacity', navigationEpoch: 1,
      observedAt: NOW, shell: 'alternate' as const, shellDiscovery: 'compatible' as const,
      requestIds: [], turnId: null, ordinaryFinal: {
        reason: 'open-call' as const, questions: 1, calls: 25, openCalls: 25,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
        sourceUserMessageId: 'abcddcba-3333-4333-8333-333333333333'
      } };
    resetCoreBrowserEvidenceForTests(); noteCoreBrowserEvidence(initial);
    noteCoreBrowserEvidence({ ...initial, observedAt: NOW + 1, ordinaryFinal: {
      ...initial.ordinaryFinal, reason: 'associated', openCalls: 0,
      coreCallMessageIds: messages.slice(0, 25), allCoreRequestIds: requests.slice(0, 25) } });
    expect(coreBrowserEvidence(TARGET)?.pendingCompletion?.coreCallMessageIds).toBeNull();
    expect(nativeCompletionCandidate(TARGET)).toBeNull();
    for (const truncated of [false, true]) {
      resetCoreBrowserEvidenceForTests();
      const large = { ...initial, ordinaryFinal: { ...initial.ordinaryFinal, calls: 201, openCalls: 201,
        coreCallMessageIds: truncated ? messages.slice(0, 200) : messages,
        allCoreRequestIds: truncated ? requests.slice(0, 200) : requests } };
      noteCoreBrowserEvidence(large);
      expect(coreBrowserEvidence(TARGET)?.pendingCompletion?.coreCallMessageIds).toBeNull();
      noteCoreBrowserEvidence({ ...large, observedAt: NOW + 1, ordinaryFinal: {
        ...large.ordinaryFinal, reason: 'associated', openCalls: 0 } });
      expect(nativeCompletionCandidate(TARGET)).toBeNull();
      expect(acknowledgeNativeCompletion(TARGET, NOW + 1, NOW, requests.slice(0, 200))).toBe(false);
    }
    resetCoreBrowserEvidenceForTests();
  });

  it('keeps the exact native request/parent identity immutable across external evidence readers', () => {
    resetCoreBrowserEvidenceForTests();
    const id = 'wfr_snapshot_native_tool';
    const scan = { conversationId: TARGET, documentId: 'same-request-document',
      navigationEpoch: 8, observedAt: NOW, shell: 'alternate' as const,
      shellDiscovery: 'compatible' as const, requestIds: [id], turnId: null,
      ordinaryFinal: { reason: 'open-call' as const, questions: 1, calls: 1, openCalls: 1,
        codeCalls: 1, openCodeCalls: 1, activeTurnMapped: false,
        sourceUserMessageId: 'ababcdcd-1111-4111-8111-111111111111',
        openRequestIds: [id], allCoreRequestIds: [id], coreCallMessageIds: ['native-call'],
        codeCallMessageIds: ['native-exec'],
        openCodeCallMessageIds: ['native-exec'], answeredCodeCallMessageIds: [] } };
    expect(noteCoreBrowserEvidence(scan)).toBe(true);
    const read = coreBrowserEvidence(TARGET)!;
    read.ordinaryFinal?.openRequestIds?.splice(0);
    read.ordinaryFinal?.allCoreRequestIds?.splice(0);
    read.ordinaryFinal?.coreCallMessageIds?.splice(0);
    read.ordinaryFinal?.codeCallMessageIds?.splice(0);
    read.ordinaryFinal?.openCodeCallMessageIds?.splice(0);
    read.pendingCompletion?.openRequestIds?.splice(0);
    read.pendingCompletion?.allCoreRequestIds?.splice(0);
    read.pendingCompletion?.coreCallMessageIds?.splice(0);
    read.pendingCompletion?.codeCallMessageIds?.splice(0);
    read.pendingCompletion?.openCodeCallMessageIds?.splice(0);
    const original = coreBrowserEvidence(TARGET)!;
    expect(original.ordinaryFinal).toMatchObject({ openRequestIds: [id],
      allCoreRequestIds: [id], coreCallMessageIds: ['native-call'],
      codeCallMessageIds: ['native-exec'],
      openCodeCallMessageIds: ['native-exec'] });
    expect(original.pendingCompletion).toMatchObject({ openRequestIds: [id],
      allCoreRequestIds: [id], coreCallMessageIds: ['native-call'],
      codeCallMessageIds: ['native-exec'],
      openCodeCallMessageIds: ['native-exec'] });
    resetCoreBrowserEvidenceForTests();
  });

  it('classifies recovery custody without turning ambiguous Send into a retry', () => {
    expect(classifyProviderRecoveryFailure({
      state: 'failed',
      sendAuthorized: false,
      messageIdPresent: false,
      deliveredAtPresent: false,
      confirmedUnsent: true,
      error: 'browser preparation failed'
    })).toMatchObject({
      phase: 'pre_send_preparation',
      retrySafe: true
    });

    expect(classifyProviderRecoveryFailure({
      state: 'sent',
      sendAuthorized: true,
      messageIdPresent: false,
      deliveredAtPresent: false
    })).toMatchObject({
      phase: 'native_send_ambiguous',
      retrySafe: false
    });
  });
  it('keeps only the newest authenticated browser observation per conversation and returns clones', () => {
    resetCoreBrowserEvidenceForTests();
    const callRejects = {
      callCompletionVeto: 0,
      callLiveMappingMissing: 2,
      callLiveMappingConflict: 3,
      callPathMissing: 4,
      callReceiptMissing: 5,
      callReceiptConflict: 6,
      callNativePending: 7,
      callScopeConflict: 8,
      callExecUnresolved: 400
    };
    noteCoreBrowserEvidence({
      conversationId: TARGET,
      documentId: 'doc-current',
      navigationEpoch: 4,
      observedAt: NOW,
      shell: 'alternate',
      shellDiscovery: 'compatible',
      shellScan: {
        selectorMatches: 2,
        mapped: 1,
        rejects: {
          fiberMissing: 0,
          ownerMissing: 1,
          stableKeyMismatch: 0,
          itemsOverLimit: 0,
          ...callRejects,
          unknown: 99,
          privateText: 'not retained'
        },
        privateText: 'not retained'
      } as any,
      requestIds: ['wfr_a', 'wfr_a', 'wfr_b'],
      turnId: 'turn-current'
    });
    noteCoreBrowserEvidence({
      conversationId: TARGET,
      documentId: 'doc-stale',
      navigationEpoch: 3,
      observedAt: NOW - 1,
      shell: 'classic',
      shellDiscovery: 'failed',
      requestIds: ['wfr_stale'],
      turnId: 'turn-stale'
    });
    const first = coreBrowserEvidence(TARGET)!;
    expect(first).toMatchObject({
      documentId: 'doc-current', navigationEpoch: 4, shell: 'alternate',
      shellDiscovery: 'compatible', observedAt: NOW, requestIds: ['wfr_a', 'wfr_b'],
      shellScan: {
        selectorMatches: 2,
        mapped: 1,
        rejects: { fiberMissing: 0, ownerMissing: 1, stableKeyMismatch: 0, itemsOverLimit: 0, ...callRejects }
      }
    });
    const vetoDiagnosticKeys = [
      'callRequestIdPresent', 'callRequestIdMissing', 'callInventoryMissing', 'callInventoryIncomplete',
      'callVetoReceiptChecked', 'callVetoReceiptMatched',
      'callJoinReferenceMissing', 'callJoinReferenceUnselected', 'callJoinReferenceConflict',
      'callJoinResultMissing', 'callJoinResultIdentity', 'callJoinDescriptorUnsupported',
      'callIdentityRecovered', 'callIdentityPriorPair', 'callIdentityUserUnproved',
      'callIdentityNativeUnproved', 'callIdentityScopeUnproved', 'callIdentityParentUnproved',
      'callIdentitySelectedWithheld',
      'identityReasonCurrentQuestionMissing',
      'identityReasonCurrentQuestionUnselected',
      'identityReasonCurrentQuestionConflict',
      'identityReasonNativeInvocationMissing',
      'identityReasonNativeInvocationMismatch',
      'identityReasonRequestIdMissing',
      'identityReasonDecodedPathMissing',
      'identityReasonDecodedPathForeign',
      'identityReasonServerMissing',
      'identityReasonServerMismatch',
      'identityReasonToolMismatch',
      'identityReasonWorkingTurnMissing',
      'identityReasonWorkingTurnMismatch',
      'identityReasonTurnExchangeMissing',
      'identityReasonTurnExchangeMismatch',
      'identityReasonNativeAncestryUnproved',
      'identityReasonPriorRequestIdMissing',
      'identityReasonPriorRequestIdMismatch',
      'identityReasonPriorResultResourceIncomplete',
      'identityReasonPriorToolScopeMismatch',
      'identityReasonNativeScopeTurnIncomplete',
      'identityReasonNativeScopePathUnproved',
      'identityReasonNativeScopeFinalCount',
      'identityReasonNativeScopeFinalPathMismatch',
      'identityReasonNativeScopeFinalReceiptUnproved',
      'identityReasonNativeScopeFinalNamespaceMissing',
      'identityReasonNativeScopeNodeConflict',
      'identityReasonNativeScopeCacheConflict',
      'identityReasonNativeScopeBranchConflict',
      'identityReasonNativeScopeUnsupported',
      'assistantTerminalReceiptChecked', 'assistantTerminalReceiptMatched',
      'callCompletedFalse', 'callCompletedUndefined', 'callCompletedNull', 'callCompletedMalformed', 'callStatusVeto',
      'callVetoStatusAbsent', 'callVetoStatusPending', 'callVetoStatusError', 'callVetoStatusDone',
      'callVetoStatusFinal', 'callVetoStatusCompleted', 'callVetoStatusComplete', 'callVetoStatusFinished',
      'callVetoStatusFinishedSuccessfully', 'callVetoStatusUnknown',
      'userTypedMissing', 'userIdentityInvalid', 'userTextEmpty', 'userTextUnsupported', 'userBudgetDropped', 'userProjected'
    ];
    expect(CORE_SHELL_CALL_REJECTION_KEYS).toEqual([...Object.keys(callRejects), ...vetoDiagnosticKeys]);
    expect(Object.isFrozen(CORE_SHELL_CALL_REJECTION_KEYS)).toBe(true);
    for (const key of vetoDiagnosticKeys) expect(first.shellScan!.rejects).not.toHaveProperty(key);
    expect(first.shellScan!.rejects).not.toHaveProperty('unknown');
    expect(first.shellScan!.rejects).not.toHaveProperty('privateText');
    first.requestIds.push('mutated-copy');
    first.shellScan!.rejects.ownerMissing = 99;
    first.shellScan!.rejects.callCompletionVeto = 99;
    expect(coreBrowserEvidence(TARGET)?.requestIds).toEqual(['wfr_a', 'wfr_b']);
    expect(coreBrowserEvidence(TARGET)?.shellScan?.rejects.ownerMissing).toBe(1);
    expect(coreBrowserEvidence(TARGET)?.shellScan?.rejects.callCompletionVeto).toBe(0);

    expect(noteCoreBrowserEvidence({
      conversationId: OTHER,
      documentId: 'doc-malformed',
      navigationEpoch: 1,
      observedAt: NOW,
      shell: 'alternate',
      shellDiscovery: 'compatible',
      shellScan: {
        selectorMatches: '2',
        mapped: 1,
        rejects: { fiberMissing: 0, ownerMissing: 1, stableKeyMismatch: 0, itemsOverLimit: 0 }
      } as any,
      requestIds: [],
      turnId: null
    })).toBe(true);
    expect(coreBrowserEvidence(OTHER)?.shellScan).toBeNull();
    resetCoreBrowserEvidenceForTests();
  });

  it('preserves the exact legacy shell rejection shape when additive counters are absent', () => {
    resetCoreBrowserEvidenceForTests();
    expect(noteCoreBrowserEvidence({
      conversationId: TARGET,
      documentId: 'doc-legacy',
      navigationEpoch: 1,
      observedAt: NOW,
      shell: 'alternate',
      shellDiscovery: 'compatible',
      shellScan: {
        selectorMatches: 2,
        mapped: 1,
        rejects: {
          fiberMissing: 0,
          ownerMissing: 1,
          stableKeyMismatch: 0,
          itemsOverLimit: 0,
          unknownPrivateCounter: { secret: 'not retained' }
        }
      } as any,
      requestIds: [],
      turnId: null
    })).toBe(true);
    expect(coreBrowserEvidence(TARGET)?.shellScan?.rejects).toEqual({
      fiberMissing: 0,
      ownerMissing: 1,
      stableKeyMismatch: 0,
      itemsOverLimit: 0
    });
    resetCoreBrowserEvidenceForTests();
  });

  it.each([
    ['private object', { privateText: 'must-not-leak' }],
    ['present undefined', undefined],
    ['null', null],
    ['string', '1'],
    ['negative', -1],
    ['fraction', 1.5],
    ['over the bound', 401]
  ])('drops the whole optional shell scan for an invalid %s additive counter', (_label, invalid) => {
    resetCoreBrowserEvidenceForTests();
    expect(noteCoreBrowserEvidence({
      conversationId: TARGET,
      documentId: 'doc-invalid-additive-counter',
      navigationEpoch: 1,
      observedAt: NOW,
      shell: 'alternate',
      shellDiscovery: 'compatible',
      shellScan: {
        selectorMatches: 1,
        mapped: 1,
        rejects: {
          fiberMissing: 0,
          ownerMissing: 0,
          stableKeyMismatch: 0,
          itemsOverLimit: 0,
          callCompletionVeto: invalid
        }
      } as any,
      requestIds: ['wfr_base_evidence_survives'],
      turnId: 'turn-base-evidence-survives'
    })).toBe(true);
    expect(coreBrowserEvidence(TARGET)).toMatchObject({
      documentId: 'doc-invalid-additive-counter',
      observedAt: NOW,
      shellScan: null,
      requestIds: ['wfr_base_evidence_survives'],
      turnId: 'turn-base-evidence-survives'
    });
    expect(JSON.stringify(coreBrowserEvidence(TARGET))).not.toContain('must-not-leak');
    resetCoreBrowserEvidenceForTests();
  });

  it('proves zero ingress for one chat even while another exact chat uses Core', () => {
    const owner = new Map([['wfr_other', OTHER]]);
    const evidence = projectCoreToolSurfaceIncidentEvidence(incident(), sources({
      ingress: {
        records: [{ surface: 'core', at: NOW - 5000, requestId: 'wfr_other', methods: ['tools/call'] }],
        complete: true
      },
      toolDispatches: {
        records: [{ surface: 'core', at: NOW - 4900, requestId: 'wfr_other' }],
        complete: true
      },
      requestOwner: (requestId) => owner.get(requestId) ?? null
    }));
    expect(evidence).toMatchObject({
      localServer: 'healthy', tunnel: 'healthy', route: 'healthy',
      coreIngress: 'absent', toolCall: 'absent', exactIdentity: 'unknown'
    });
    expect(classifyCoreToolSurfaceFailure(evidence)).toMatchObject({ kind: 'zero_core_ingress', boundary: 'ingress' });
  });

  it('retains only bounded completion veto diagnostics without promoting them to live tool proof', () => {
    resetCoreBrowserEvidenceForTests();
    const details = { callVetoReceiptChecked: 1, callVetoReceiptMatched: 1,
      callJoinReferenceMissing: 1, callJoinReferenceUnselected: 2, callJoinReferenceConflict: 3,
      callJoinResultMissing: 4, callJoinResultIdentity: 5, callJoinDescriptorUnsupported: 400,
      assistantTerminalReceiptChecked: 2, assistantTerminalReceiptMatched: 1,
      callCompletedFalse: 1, callCompletedUndefined: 2, callCompletedNull: 3,
      callCompletedMalformed: 4, callStatusVeto: 5, callVetoStatusAbsent: 6, callVetoStatusPending: 7,
      callVetoStatusError: 8, callVetoStatusDone: 9, callVetoStatusFinal: 10, callVetoStatusCompleted: 11,
      callVetoStatusComplete: 12, callVetoStatusFinished: 13, callVetoStatusFinishedSuccessfully: 14,
      callVetoStatusUnknown: 400, userTypedMissing: 1, userIdentityInvalid: 2, userTextEmpty: 3,
      userTextUnsupported: 4, userBudgetDropped: 5, userProjected: 400 };
    let observedAt = NOW;
    const project = (rejects: unknown) => {
      noteCoreBrowserEvidence({ conversationId: TARGET, documentId: 'doc-veto', navigationEpoch: 1,
        observedAt: observedAt++, shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: null,
        shellScan: { selectorMatches: 1, mapped: 1, rejects } });
      return coreBrowserEvidence(TARGET);
    };
    const rejects = { fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0,
      callCompletionVeto: 1, ...details, privateStatus: 'PRIVATE_STATUS_VALUE' };
    const valid = project(rejects);
    expect(valid?.shellScan?.rejects).toMatchObject({ callCompletionVeto: 1, ...details });
    expect(JSON.stringify(valid)).not.toContain('PRIVATE_STATUS_VALUE');
    (valid!.shellScan!.rejects as any).callCompletedFalse = 99;
    expect((coreBrowserEvidence(TARGET)?.shellScan?.rejects as any).callCompletedFalse).toBe(1);
    expect(project({ fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0,
      callCompletionVeto: 0, callVetoReceiptChecked: 0, callVetoReceiptMatched: 0 })?.shellScan?.rejects)
      .toMatchObject({ callVetoReceiptChecked: 0, callVetoReceiptMatched: 0 });
    for (const key of Object.keys(details)) for (const invalid of [-1, 401, 1.5, 'PRIVATE_STATUS_VALUE', null, undefined])
      expect(project({ ...rejects, [key]: invalid })?.shellScan).toBeNull();
    const legacy = project({ fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0,
      callCompletionVeto: 1 });
    expect((legacy?.shellScan?.rejects as any).callCompletionVeto).toBe(1);
    expect(legacy?.shellScan?.rejects).not.toHaveProperty('callCompletedFalse');
    expect(legacy?.shellScan?.rejects).not.toHaveProperty('userProjected');
    expect(legacy?.shellScan?.rejects).not.toHaveProperty('callVetoReceiptChecked');
    expect(legacy?.shellScan?.rejects).not.toHaveProperty('callVetoReceiptMatched');
    expect(legacy?.shellScan?.rejects).not.toHaveProperty('assistantTerminalReceiptChecked');
    expect(legacy?.shellScan?.rejects).not.toHaveProperty('assistantTerminalReceiptMatched');
    for (const key of ['userProjected', 'callVetoReceiptChecked', 'callVetoReceiptMatched',
      'callJoinReferenceMissing', 'callJoinReferenceUnselected', 'callJoinReferenceConflict',
      'callJoinResultMissing', 'callJoinResultIdentity', 'callJoinDescriptorUnsupported',
      'assistantTerminalReceiptChecked', 'assistantTerminalReceiptMatched']) {
      const inherited = Object.assign(Object.create({ [key]: 400 }), {
        fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0 });
      expect(project(inherited)?.shellScan?.rejects).not.toHaveProperty(key);
      let getterReads = 0;
      Object.defineProperty(inherited, key, { enumerable: true, get() { getterReads++; return 1; } });
      expect(project(inherited)?.shellScan).toBeNull();
      expect(getterReads).toBe(0);
    }
    expect(classifyCoreToolSurfaceFailure(projectCoreToolSurfaceIncidentEvidence(incident(), sources({ browser: legacy }))).kind)
      .toBe('insufficient_evidence');
    resetCoreBrowserEvidenceForTests();
  });

  it.each([
    { callVetoReceiptChecked: 1 },
    { callVetoReceiptMatched: 1 },
    { callVetoReceiptChecked: 0, callVetoReceiptMatched: 1 },
    { callCompletionVeto: 0, callVetoReceiptChecked: 1, callVetoReceiptMatched: 1 }
  ])('rejects an incomplete or impossible veto receipt pair: %j', (pair) => {
    resetCoreBrowserEvidenceForTests();
    noteCoreBrowserEvidence({ conversationId: TARGET, documentId: 'doc-veto-pair', navigationEpoch: 1,
      observedAt: NOW, shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: null,
      shellScan: { selectorMatches: 1, mapped: 1, rejects: {
        fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0, ...pair } } });
    expect(coreBrowserEvidence(TARGET)?.shellScan).toBeNull();
    resetCoreBrowserEvidenceForTests();
  });

  it.each([
    { assistantTerminalReceiptChecked: 1 },
    { assistantTerminalReceiptMatched: 1 },
    { assistantTerminalReceiptChecked: 0, assistantTerminalReceiptMatched: 1 }
  ])('rejects an incomplete or impossible assistant terminal receipt pair: %j', (pair) => {
    resetCoreBrowserEvidenceForTests();
    noteCoreBrowserEvidence({ conversationId: TARGET, documentId: 'doc-assistant-terminal-pair', navigationEpoch: 1,
      observedAt: NOW, shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: null,
      shellScan: { selectorMatches: 1, mapped: 1, rejects: {
        fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0, ...pair } } });
    expect(coreBrowserEvidence(TARGET)?.shellScan).toBeNull();
    resetCoreBrowserEvidenceForTests();
  });

  it('keeps absence unknown when a Core tool request in the incident window has no exact owner', () => {
    const evidence = projectCoreToolSurfaceIncidentEvidence(incident(), sources({
      ingress: {
        records: [{ surface: 'core', at: NOW - 5000, requestId: 'wfr_unowned', methods: ['tools/call'] }],
        complete: true
      },
      toolDispatches: {
        records: [{ surface: 'core', at: NOW - 4900, requestId: 'wfr_unowned' }],
        complete: true
      }
    }));
    expect(evidence).toMatchObject({ coreIngress: 'unknown', toolCall: 'unknown', exactIdentity: 'unknown' });
    expect(classifyCoreToolSurfaceFailure(evidence).kind).toBe('insufficient_evidence');
  });

  it('identifies account-wide missing request keys at MCP ingress and dispatch without assigning them to this chat', () => {
    const evidence = projectCoreToolSurfaceIncidentEvidence(incident(), sources({
      ingress: { records: [
        { surface: 'core', at: NOW - 3300, requestId: null, methods: ['tools/call'] },
        { surface: 'core', at: NOW - 3200, requestId: 'wfr_other', methods: ['tools/call'] }
      ], complete: true },
      toolDispatches: { records: [
        { surface: 'core', at: NOW - 3150, requestId: null },
        { surface: 'core', at: NOW - 3000, requestId: 'wfr_other' }
      ], complete: true },
      requestOwner: id => id === 'wfr_other' ? OTHER : null
    }));
    expect(evidence).toMatchObject({
      coreIngress: 'unknown', toolCall: 'unknown', exactIdentity: 'unknown',
      headerlessIngressCalls: 1, headerlessDispatches: 1
    });
    expect(classifyCoreToolSurfaceFailure(evidence)).toMatchObject({
      kind: 'insufficient_evidence', boundary: 'ingress',
      detail: expect.stringContaining('x-request-id')
    });
    expect(classifyCoreToolSurfaceFailure(evidence).detail).toContain('not attributed to this conversation');
  });

  it('keeps a proved exact target call authoritative even when another account-scoped ingress was headerless', () => {
    const evidence = projectCoreToolSurfaceIncidentEvidence(incident(), sources({
      ingress: { records: [
        { surface: 'core', at: NOW - 3300, requestId: null, methods: ['tools/call'] },
        { surface: 'core', at: NOW - 3200, requestId: 'wfr_target', methods: ['tools/call'] }
      ], complete: true },
      toolDispatches: { records: [{ surface: 'core', at: NOW - 3000, requestId: 'wfr_target' }], complete: true },
      requestOwner: id => id === 'wfr_target' ? TARGET : null
    }));
    expect(evidence).toMatchObject({
      coreIngress: 'present', toolCall: 'present', exactIdentity: 'resolved',
      headerlessIngressCalls: 1, headerlessDispatches: 0
    });
    expect(classifyCoreToolSurfaceFailure(evidence)).toMatchObject({
      kind: 'insufficient_evidence', boundary: 'unknown'
    });
  });

  it('classifies a fresh browser-linked tool dispatch with no correlation as exact identity delay', () => {
    const requestId = 'wfr_target_delayed';
    const evidence = projectCoreToolSurfaceIncidentEvidence(incident(), sources({
      ingress: {
        records: [{ surface: 'core', at: NOW - 3000, requestId, methods: ['tools/call'] }],
        complete: true
      },
      toolDispatches: {
        records: [{ surface: 'core', at: NOW - 2900, requestId }],
        complete: true
      },
      browser: {
        conversationId: TARGET,
        documentId: 'document-current',
        navigationEpoch: 7,
        observedAt: NOW - 1000,
        shell: 'alternate',
        shellDiscovery: 'compatible',
        requestIds: [requestId],
        turnId: 'turn-current'
      }
    }));
    expect(evidence).toMatchObject({
      coreIngress: 'present',
      toolCall: 'present',
      exactIdentity: 'delayed',
      browserEvidenceFresh: true,
      browserShell: 'alternate'
    });
    expect(classifyCoreToolSurfaceFailure(evidence)).toMatchObject({ kind: 'exact_identity_delay', boundary: 'identity' });
  });

  it('does not turn stale or contradictory browser request ids into incident ownership', () => {
    const requestId = 'wfr_wrong_owner';
    const evidence = projectCoreToolSurfaceIncidentEvidence(incident(), sources({
      ingress: {
        records: [{ surface: 'core', at: NOW - 3000, requestId, methods: ['tools/call'] }],
        complete: true
      },
      toolDispatches: {
        records: [{ surface: 'core', at: NOW - 2900, requestId }],
        complete: true
      },
      browser: {
        conversationId: TARGET,
        documentId: 'document-current',
        navigationEpoch: 7,
        observedAt: NOW - 1000,
        shell: 'alternate',
        shellDiscovery: 'failed',
        requestIds: [requestId],
        turnId: 'turn-current'
      },
      requestOwner: () => OTHER
    }));
    expect(evidence).toMatchObject({
      coreIngress: 'absent', toolCall: 'absent', browserEvidenceFresh: false,
      browserShell: 'unknown', shellDiscovery: 'unknown'
    });
  });

  it('requires complete bounded histories before claiming no ingress or tool dispatch', () => {
    const evidence = projectCoreToolSurfaceIncidentEvidence(incident(), sources({
      ingress: { records: [], complete: false },
      toolDispatches: { records: [], complete: false }
    }));
    expect(evidence).toMatchObject({ localServer: 'unknown', coreIngress: 'unknown', toolCall: 'unknown' });
    expect(classifyCoreToolSurfaceFailure(evidence).kind).toBe('insufficient_evidence');
  });

  it('uses connector mismatch only while the passive provider observation is incident-fresh', () => {
    const fresh = projectCoreToolSurfaceIncidentEvidence(incident(), sources({
      connector: {
        surface: 'core',
        observedAt: NOW - 2000,
        providerConnectorName: 'Wrong Core',
        providerSchemaId: 'provider-schema',
        expectedConnectorName: 'Luna Forge X7 Core',
        expectedSchemaId: 'expected-schema'
      }
    }));
    expect(fresh).toMatchObject({
      connectorEvidenceFresh: true,
      connectorName: 'mismatch',
      connectorSchema: 'mismatch'
    });
    expect(classifyCoreToolSurfaceFailure(fresh).kind).toBe('connector_name_or_schema_mismatch');

    const stale = projectCoreToolSurfaceIncidentEvidence(incident(), sources({
      connector: {
        surface: 'core',
        observedAt: NOW - CORE_TOOL_SURFACE_INCIDENT_FRESH_MS - 1,
        providerConnectorName: 'Wrong Core',
        providerSchemaId: 'provider-schema',
        expectedConnectorName: 'Luna Forge X7 Core',
        expectedSchemaId: 'expected-schema'
      }
    }));
    expect(stale).toMatchObject({ connectorEvidenceFresh: false, connectorName: 'unknown', connectorSchema: 'unknown' });
    expect(classifyCoreToolSurfaceFailure(stale).kind).toBe('insufficient_evidence');
  });

  it('does not call a merely connected current tunnel proof of a healthy Core route', () => {
    const evidence = projectCoreToolSurfaceIncidentEvidence(incident(), sources());
    expect(evidence).toMatchObject({
      localServer: 'healthy',
      tunnel: 'healthy',
      route: 'unknown',
      coreIngress: 'absent',
      toolCall: 'absent'
    });
    expect(classifyCoreToolSurfaceFailure(evidence).kind).toBe('insufficient_evidence');
  });

  it('does not project current transport health backward onto an old incident', () => {
    const old = incident({
      startedAt: NOW - CORE_TOOL_SURFACE_INCIDENT_FRESH_MS - 20_000,
      endedAt: NOW - CORE_TOOL_SURFACE_INCIDENT_FRESH_MS - 10_000
    });
    const evidence = projectCoreToolSurfaceIncidentEvidence(old, sources());
    expect(evidence).toMatchObject({ localServer: 'unknown', tunnel: 'unknown', route: 'unknown' });
    expect(classifyCoreToolSurfaceFailure(evidence).kind).toBe('insufficient_evidence');
  });

  it('classifies exact zero ingress without inventing a provider cause', () => {
    const result = classifyCoreToolSurfaceFailure(healthy({ coreIngress: 'absent', toolCall: 'absent' }));
    expect(result).toMatchObject({ kind: 'zero_core_ingress', boundary: 'ingress' });
    expect(result.detail).toContain('boundary only');
    expect(result.detail).not.toMatch(/model bug|provider bug|Pro caused/i);
  });

  it('uses only fresh current-document shell failure evidence', () => {
    const current = classifyCoreToolSurfaceFailure(healthy({
      coreIngress: 'absent',
      toolCall: 'absent',
      browserShell: 'alternate',
      shellDiscovery: 'failed',
      browserEvidenceFresh: true
    }));
    expect(current).toMatchObject({ kind: 'browser_shell_discovery_failure', boundary: 'browser' });

    const stale = classifyCoreToolSurfaceFailure(healthy({
      coreIngress: 'absent',
      toolCall: 'absent',
      browserShell: 'alternate',
      shellDiscovery: 'failed',
      browserEvidenceFresh: false
    }));
    expect(stale).toMatchObject({ kind: 'zero_core_ingress', boundary: 'ingress' });
  });

  it('separates post-ingress exact-identity delay from exposure loss', () => {
    expect(classifyCoreToolSurfaceFailure(healthy({
      coreIngress: 'present',
      toolCall: 'present',
      exactIdentity: 'delayed'
    }))).toMatchObject({ kind: 'exact_identity_delay', boundary: 'identity' });
  });

  it('requires an actual Core tool call before classifying an exact-identity delay', () => {
    expect(classifyCoreToolSurfaceFailure(healthy({
      coreIngress: 'present',
      toolCall: 'absent',
      exactIdentity: 'delayed'
    }))).toMatchObject({ kind: 'insufficient_evidence', boundary: 'unknown' });
  });

  it.each([
    [{ connectorName: 'mismatch' as const }, 'connector identity/name'],
    [{ connectorSchema: 'mismatch' as const }, 'tool schema']
  ])('reports fresh connector mismatch without using model or queue state', (difference, phrase) => {
    const result = classifyCoreToolSurfaceFailure(healthy({
      ...difference,
      connectorEvidenceFresh: true,
      coreIngress: 'absent',
      toolCall: 'absent'
    }));
    expect(result).toMatchObject({ kind: 'connector_name_or_schema_mismatch', boundary: 'connector' });
    expect(result.detail).toContain(phrase);
  });

  it('ignores stale connector mismatch evidence', () => {
    const result = classifyCoreToolSurfaceFailure(healthy({
      connectorName: 'mismatch',
      connectorSchema: 'mismatch',
      connectorEvidenceFresh: false,
      coreIngress: 'absent',
      toolCall: 'absent'
    }));
    expect(result.kind).toBe('zero_core_ingress');
  });

  it('keeps a fresh connector mismatch ahead of a later identity symptom', () => {
    expect(classifyCoreToolSurfaceFailure(healthy({
      connectorSchema: 'mismatch',
      connectorEvidenceFresh: true,
      coreIngress: 'present',
      toolCall: 'present',
      exactIdentity: 'delayed'
    }))).toMatchObject({ kind: 'connector_name_or_schema_mismatch', boundary: 'connector' });
  });

  it.each([
    ['localServer', { localServer: 'failed' as const }],
    ['tunnel', { tunnel: 'failed' as const }],
    ['route', { route: 'failed' as const }]
  ])('keeps genuine local Core/tunnel failure at the earliest boundary (%s)', (_name, failure) => {
    const result = classifyCoreToolSurfaceFailure(healthy({
      ...failure,
      coreIngress: 'absent',
      toolCall: 'absent',
      browserShell: 'alternate',
      shellDiscovery: 'failed',
      browserEvidenceFresh: true,
      connectorName: 'mismatch',
      connectorEvidenceFresh: true
    }));
    expect(result).toMatchObject({ kind: 'local_core_or_tunnel_failure', boundary: 'local' });
  });

  it('fails closed on contradictory or incomplete evidence', () => {
    expect(classifyCoreToolSurfaceFailure(healthy({
      coreIngress: 'absent',
      toolCall: 'present'
    })).kind).toBe('insufficient_evidence');

    expect(classifyCoreToolSurfaceFailure(healthy({
      localServer: 'unknown',
      coreIngress: 'unknown',
      toolCall: 'unknown'
    })).kind).toBe('insufficient_evidence');
  });

  it('keeps Core self-test clocks separate from Desktop or app-wide traffic', () => {
    const absent = describeCoreArrival(null, null);
    expect(absent[0]).toMatchObject({ name: 'ChatGPT reaching Core', status: 'not-run', ok: null });
    expect(absent[0]!.detail).toContain('Other connectors do not count');
    expect(absent[1]).toMatchObject({ name: 'ChatGPT allowed to use the tools', status: 'not-run', ok: null });

    const now = Date.now();
    const present = describeCoreArrival(now - 1000, now - 500);
    expect(present[0]).toMatchObject({ name: 'ChatGPT reaching Core', status: 'pass', ok: true });
    expect(present[1]).toMatchObject({ status: 'pass', ok: true });
  });
});

describe('durable event-driven diagnostic incidents', () => {
  let directory = '';
  const exhausted = (
    overrides: Partial<ExhaustedDiagnosticIncident> = {}
  ): ExhaustedDiagnosticIncident => ({
    kind: 'loop',
    sourceSessionId: '2026-10-05-source-session',
    sourceConversationId: TARGET,
    recoveryEpisodeId: 'loop-recovery-episode',
    exhaustedAt: NOW,
    appOwned: true,
    recoveryExhausted: true,
    inputCustody: 'none',
    origin: 'runtime',
    userStopped: false,
    ...overrides
  });

  beforeEach(async () => {
    resetDiagnosticIncidentOwnerForTests();
    resetDurableForTests();
    directory = await makeTempDir();
    initDurableStore(directory);
  });

  afterEach(async () => {
    resetDiagnosticIncidentOwnerForTests();
    resetDurableForTests();
    await removeTempDir(directory);
  });

  it('admits only exact app-owned exhausted recovery and never turns admission into a wake', async () => {
    expect(await diagnosticIncidentSnapshot()).toEqual({
      ownerId: null,
      chat: null,
      overflowCount: 0,
      incidents: []
    });
    expect(await noteExhaustedDiagnosticIncidentNow(exhausted({ appOwned: false }))).toEqual({
      accepted: false,
      reason: 'native-recovery-not-exhausted'
    });
    expect(await noteExhaustedDiagnosticIncidentNow(exhausted({ recoveryExhausted: false }))).toEqual({
      accepted: false,
      reason: 'native-recovery-not-exhausted'
    });
    expect(await noteExhaustedDiagnosticIncidentNow(exhausted({ userStopped: true }))).toEqual({
      accepted: false,
      reason: 'user-stopped'
    });
    expect(await noteExhaustedDiagnosticIncidentNow(exhausted({ origin: 'diagnostic' }))).toEqual({
      accepted: false,
      reason: 'recursive'
    });

    const accepted = await noteExhaustedDiagnosticIncidentNow(exhausted());
    expect(accepted).toMatchObject({ accepted: true, coalesced: false });
    expect(await diagnosticIncidentSnapshot()).toMatchObject({
      chat: null,
      overflowCount: 0,
      incidents: [expect.objectContaining({ status: 'pending', repeatCount: 1 })]
    });
  });

  it('defers admission and a claimed wake while the exact source owns live local tool work', async () => {
    let release = () => {};
    const work = trackInFlight({
      startedAt: NOW,
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: 'wfr_diagnostic_custody', conversationId: TARGET },
      outcome: null,
      evidence: emptyEvidence()
    }, () => new Promise<void>(resolve => { release = resolve; }));

    expect(await noteExhaustedDiagnosticIncidentNow(exhausted())).toEqual({
      accepted: false,
      reason: 'local-tool-active'
    });
    release();
    await work;

    const accepted = await noteExhaustedDiagnosticIncidentNow(exhausted());
    expect(accepted.accepted).toBe(true);
    const offer = await claimDiagnosticIncidentWakeNow();
    expect(offer).not.toBeNull();
    expect(await diagnosticIncidentWakeClaimCurrent(offer!.claimId)).toBe(true);

    let releaseSecond = () => {};
    const second = trackInFlight({
      startedAt: NOW + 1,
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: 'wfr_diagnostic_custody_2', conversationId: TARGET },
      outcome: null,
      evidence: emptyEvidence()
    }, () => new Promise<void>(resolve => { releaseSecond = resolve; }));
    expect(await diagnosticIncidentWakeClaimCurrent(offer!.claimId)).toBe(false);
    releaseSecond();
    await second;
    expect(await diagnosticIncidentWakeClaimCurrent(offer!.claimId)).toBe(true);
  });

  it('coalesces one exact episode, keeps recovery text out of durable state, and never replays an ambiguous wake', async () => {
    const secretEpisode = 'episode-sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
    const first = await noteExhaustedDiagnosticIncidentNow(exhausted({
      recoveryEpisodeId: secretEpisode,
      inputCustody: 'sent'
    }), NOW + 1);
    const repeated = await noteExhaustedDiagnosticIncidentNow(exhausted({
      recoveryEpisodeId: secretEpisode,
      inputCustody: 'ambiguous'
    }), NOW + 2);
    expect(first).toMatchObject({ accepted: true, coalesced: false });
    expect(repeated).toMatchObject({
      accepted: true,
      coalesced: true,
      incident: expect.objectContaining({ id: (first as any).incident.id, repeatCount: 2, inputCustody: 'ambiguous' })
    });

    const raw = await readDurable<unknown>('diagnostic-incidents');
    expect(JSON.stringify(raw)).not.toContain(secretEpisode);
    expect(JSON.stringify(raw)).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');

    const offer = await claimDiagnosticIncidentWakeNow(NOW + 3);
    expect(offer).toMatchObject({
      target: { kind: 'create' },
      incidentId: (first as any).incident.id
    });
    expect(offer!.message).toContain('ambiguous send evidence is preserved; do not resend or reconstruct the input');
    expect(offer!.message).not.toContain(secretEpisode);

    resetDiagnosticIncidentOwnerForTests();
    expect((await diagnosticIncidentSnapshot()).incidents[0]).toMatchObject({
      status: 'claimed',
      repeatCount: 2,
      inputCustody: 'ambiguous'
    });
    expect(await claimDiagnosticIncidentWakeNow(NOW + 4)).toBeNull();

    expect(await settleDiagnosticIncidentWakeNow({
      claimId: offer!.claimId,
      outcome: 'ambiguous'
    }, NOW + 5)).toBe(true);
    resetDiagnosticIncidentOwnerForTests();
    expect((await diagnosticIncidentSnapshot()).incidents[0]?.status).toBe('ambiguous');
    expect(await claimDiagnosticIncidentWakeNow(NOW + 6)).toBeNull();
  });

  it('rearms only from positive unsent proof and reuses one durable diagnostic session across provider rebinding', async () => {
    const first = await noteExhaustedDiagnosticIncidentNow(exhausted({ inputCustody: 'confirmed-unsent' }));
    expect(first.accepted).toBe(true);
    const initial = await claimDiagnosticIncidentWakeNow(NOW + 1);
    expect(initial?.target.kind).toBe('create');

    expect(await settleDiagnosticIncidentWakeNow({
      claimId: initial!.claimId,
      outcome: 'confirmed-unsent'
    }, NOW + 2)).toBe(true);
    const retry = await claimDiagnosticIncidentWakeNow(NOW + 3);
    expect(retry?.claimId).not.toBe(initial?.claimId);

    const diagnosticSessionId = '2026-10-05-diagnostic-session';
    const diagnosticConversationId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    expect(await settleDiagnosticIncidentWakeNow({
      claimId: retry!.claimId,
      outcome: 'delivered',
      diagnosticSessionId,
      diagnosticConversationId
    }, NOW + 4)).toBe(true);
    expect(await diagnosticIncidentSnapshot()).toMatchObject({
      ownerId: initial!.ownerId,
      chat: { sessionId: diagnosticSessionId, conversationId: diagnosticConversationId },
      incidents: [expect.objectContaining({ status: 'delivered' })]
    });

    expect(await resolveDiagnosticIncidentNow((first as any).incident.id, 'recovered', NOW + 5)).toBe(true);
    const reboundConversationId = 'cccccccc-dddd-4eee-8fff-000000000000';
    expect(await bindDiagnosticIncidentChatNow(diagnosticSessionId, reboundConversationId)).toBe(true);
    expect(await bindDiagnosticIncidentChatNow('different-diagnostic-session', reboundConversationId)).toBe(false);

    expect(await noteExhaustedDiagnosticIncidentNow(exhausted({
      sourceSessionId: diagnosticSessionId,
      sourceConversationId: reboundConversationId,
      recoveryEpisodeId: 'diagnostic-self-failure'
    }))).toEqual({ accepted: false, reason: 'recursive' });

    const next = await noteExhaustedDiagnosticIncidentNow(exhausted({
      kind: 'worker',
      recoveryEpisodeId: 'worker-episode-two',
      sourceConversationId: OTHER
    }));
    expect(next.accepted).toBe(true);
    const reused = await claimDiagnosticIncidentWakeNow(NOW + 6);
    expect(reused?.target).toEqual({
      kind: 'reuse',
      sessionId: diagnosticSessionId,
      conversationId: reboundConversationId
    });
  });

  it('retires only an exact missing-chat claim while preserving its wake custody for the same create offer', async () => {
    const diagnosticSessionId = '2026-10-05-stale-diagnostic-session';
    const diagnosticConversationId = 'bbbbbbbb-cccc-4ddd-8eee-111111111111';
    expect(await bindDiagnosticIncidentChatNow(diagnosticSessionId, diagnosticConversationId)).toBe(true);
    expect((await noteExhaustedDiagnosticIncidentNow(exhausted())).accepted).toBe(true);
    const offer = await claimDiagnosticIncidentWakeNow(NOW + 1);
    const wakeInputId = '11111111-2222-4333-8444-777777777777';
    expect(await bindDiagnosticIncidentWakeInputNow(offer!.claimId, wakeInputId)).toBe(true);

    expect(await retireMissingDiagnosticIncidentChatNow(
      offer!.claimId,
      diagnosticSessionId,
      'bbbbbbbb-cccc-4ddd-8eee-222222222222'
    )).toBe(false);
    expect(await retireMissingDiagnosticIncidentChatNow(
      offer!.claimId,
      diagnosticSessionId,
      diagnosticConversationId
    )).toBe(true);
    expect(await diagnosticIncidentSnapshot()).toMatchObject({
      chat: null,
      incidents: [expect.objectContaining({
        claimId: offer!.claimId,
        status: 'claimed',
        wakeInputId
      })]
    });
    expect(await diagnosticIncidentWakeOfferForClaim(offer!.claimId)).toMatchObject({
      claimId: offer!.claimId,
      target: { kind: 'create' }
    });

    expect(await settleDiagnosticIncidentWakeNow({ claimId: offer!.claimId, outcome: 'ambiguous', wakeInputId }, NOW + 2)).toBe(true);
    expect(await retireMissingDiagnosticIncidentChatNow(
      offer!.claimId,
      diagnosticSessionId,
      diagnosticConversationId
    )).toBe(false);
  });

  it('persists one wake input UUID and reconstructs the same claim and exact native receipt after restart', async () => {
    const accepted = await noteExhaustedDiagnosticIncidentNow(exhausted());
    expect(accepted.accepted).toBe(true);
    const offer = await claimDiagnosticIncidentWakeNow(NOW + 1);
    expect(offer).not.toBeNull();
    const inputId = '11111111-2222-4333-8444-555555555555';
    expect(await bindDiagnosticIncidentWakeInputNow(offer!.claimId, inputId)).toBe(true);
    expect(await bindDiagnosticIncidentWakeInputNow(offer!.claimId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(false);

    resetDiagnosticIncidentOwnerForTests();
    expect(await diagnosticIncidentWakeOfferForClaim(offer!.claimId)).toMatchObject({
      claimId: offer!.claimId,
      incidentId: offer!.incidentId,
      target: { kind: 'create' }
    });
    expect((await diagnosticIncidentSnapshot()).incidents[0]).toMatchObject({
      claimId: offer!.claimId,
      wakeInputId: inputId,
      wakeMessageId: null,
      status: 'claimed'
    });

    expect(await settleDiagnosticIncidentWakeNow({
      claimId: offer!.claimId,
      outcome: 'delivered',
      wakeInputId: inputId,
      wakeMessageId: 'native-diagnostic-message',
      diagnosticSessionId: '2026-10-05-diagnostic-receipt',
      diagnosticConversationId: 'eeeeeeee-ffff-4000-8111-222222222222'
    }, NOW + 2)).toBe(true);
    resetDiagnosticIncidentOwnerForTests();
    expect((await diagnosticIncidentSnapshot()).incidents[0]).toMatchObject({
      wakeInputId: inputId,
      wakeMessageId: 'native-diagnostic-message',
      status: 'delivered'
    });
  });

  it('requires exact confirmed-unsent wake custody before source recovery can retire a bound diagnostic wake', async () => {
    const episode = exhausted({ recoveryEpisodeId: 'source-recovered-before-wake', inputCustody: 'ambiguous' });
    const admitted = await noteExhaustedDiagnosticIncidentNow(episode, NOW);
    expect(admitted.accepted).toBe(true);
    const offer = await claimDiagnosticIncidentWakeNow(NOW + 1);
    expect(offer).not.toBeNull();
    const wakeInputId = '11111111-2222-4333-8444-666666666666';
    expect(await bindDiagnosticIncidentWakeInputNow(offer!.claimId, wakeInputId)).toBe(true);

    expect(await resolveRecoveredDiagnosticIncidentNow({
      kind: episode.kind,
      sourceSessionId: episode.sourceSessionId,
      sourceConversationId: episode.sourceConversationId,
      recoveryEpisodeId: episode.recoveryEpisodeId
    }, NOW + 2)).toMatchObject({
      resolved: false,
      incident: { status: 'claimed', wakeInputId }
    });
    expect(await resolveRecoveredDiagnosticIncidentNow({
      kind: episode.kind,
      sourceSessionId: episode.sourceSessionId,
      sourceConversationId: episode.sourceConversationId,
      recoveryEpisodeId: episode.recoveryEpisodeId,
      confirmedUnsentWakeInputId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    }, NOW + 3)).toMatchObject({ resolved: false });
    expect(await resolveRecoveredDiagnosticIncidentNow({
      kind: episode.kind,
      sourceSessionId: episode.sourceSessionId,
      sourceConversationId: episode.sourceConversationId,
      recoveryEpisodeId: episode.recoveryEpisodeId,
      confirmedUnsentWakeInputId: wakeInputId
    }, NOW + 4)).toMatchObject({
      resolved: true,
      incident: { status: 'resolved', disposition: 'recovered', wakeInputId }
    });
  });

  it('suppresses pending or claimed incidents on explicit Stop and invalidates the pre-Send claim', async () => {
    const pending = await noteExhaustedDiagnosticIncidentNow(exhausted());
    expect(pending.accepted).toBe(true);
    const offer = await claimDiagnosticIncidentWakeNow(NOW + 1);
    expect(await diagnosticIncidentWakeClaimCurrent(offer!.claimId)).toBe(true);

    expect(await suppressDiagnosticIncidentsForSourceNow(
      exhausted().sourceSessionId,
      exhausted().sourceConversationId,
      NOW + 2
    )).toBe(1);
    expect(await diagnosticIncidentWakeClaimCurrent(offer!.claimId)).toBe(false);
    expect(await claimDiagnosticIncidentWakeNow(NOW + 3)).toBeNull();
    expect((await diagnosticIncidentSnapshot()).incidents[0]).toMatchObject({
      status: 'suppressed',
      disposition: 'user-action'
    });
  });

  it('serializes diagnostic work to one delivered incident and bounds an unresolved backlog', async () => {
    const first = await noteExhaustedDiagnosticIncidentNow(exhausted({ recoveryEpisodeId: 'serial-first' }));
    const second = await noteExhaustedDiagnosticIncidentNow(exhausted({ recoveryEpisodeId: 'serial-second' }));
    expect(first.accepted && second.accepted).toBe(true);
    const offer = await claimDiagnosticIncidentWakeNow(NOW + 1);
    expect(await settleDiagnosticIncidentWakeNow({
      claimId: offer!.claimId,
      outcome: 'delivered',
      diagnosticSessionId: '2026-10-05-serial-diagnostic',
      diagnosticConversationId: 'dddddddd-eeee-4fff-8000-111111111111'
    }, NOW + 2)).toBe(true);
    expect(await claimDiagnosticIncidentWakeNow(NOW + 3)).toBeNull();
    expect(await resolveDiagnosticIncidentNow(offer!.incidentId, 'failed', NOW + 4)).toBe(true);
    expect((await claimDiagnosticIncidentWakeNow(NOW + 5))?.incidentId).toBe((second as any).incident.id);

    resetDiagnosticIncidentOwnerForTests();
    resetDurableForTests();
    await removeTempDir(directory);
    directory = await makeTempDir();
    initDurableStore(directory);
    for (let index = 0; index < DIAGNOSTIC_INCIDENT_BACKLOG_MAX; index += 1) {
      const admitted = await noteExhaustedDiagnosticIncidentNow(exhausted({ recoveryEpisodeId: `bounded-${index}` }), NOW + index);
      expect(admitted.accepted).toBe(true);
    }
    expect(await noteExhaustedDiagnosticIncidentNow(exhausted({ recoveryEpisodeId: 'bounded-overflow' }), NOW + 100)).toEqual({
      accepted: false,
      reason: 'backlog-full'
    });
    expect((await diagnosticIncidentSnapshot()).overflowCount).toBe(1);
  });
});

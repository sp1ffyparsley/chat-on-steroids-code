import { beforeEach, describe, expect, it } from 'vitest';
import { coreBrowserEvidence, noteCoreBrowserEvidence, resetCoreBrowserEvidenceForTests } from '../src/main/core-browser-evidence.js';

const CONV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const rejects53 = {
  fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0,
  ...Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`r${i}`, 0])),
};

describe('R80.3 noteCoreBrowserEvidence provenance and negative controls', () => {
  beforeEach(() => resetCoreBrowserEvidenceForTests());

  it.each([244, 400, 401])('retains the complete %s-call native request census only within the shared bound', count => {
    const parents = Array.from({ length: count }, (_, at) => `native-${at}`);
    const requests = Array.from({ length: count }, (_, at) => `request-${at}`);
    expect(noteCoreBrowserEvidence({ conversationId: CONV, documentId: 'long-turn-document', navigationEpoch: 0,
      observedAt: Date.now(), shell: 'alternate', shellDiscovery: 'compatible', requestIds: [], turnId: 'long-turn', ordinaryFinal: {
        reason: 'open-call', questions: 1, calls: count, openCalls: count, codeCalls: 0, openCodeCalls: 0,
        activeTurnMapped: false, sourceUserMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        coreCallMessageIds: parents, allCoreRequestIds: requests, openRequestIds: requests,
        codeCallMessageIds: [], openCodeCallMessageIds: [], answeredCodeCallMessageIds: []
      } })).toBe(true);
    const snapshot = coreBrowserEvidence(CONV)!;
    if (count <= 400) expect(snapshot.pendingCompletion).toMatchObject({ calls: count,
      coreCallMessageIds: parents, allCoreRequestIds: requests });
    else expect(snapshot.ordinaryFinal).toBeNull();
  });

  it('refuses a newer-arriving old navigation epoch without replacing current evidence', () => {
    const current = {
      conversationId: CONV, documentId: 'same-document', navigationEpoch: 5,
      observedAt: 1762780010000, shell: 'classic' as const, shellDiscovery: 'compatible' as const,
      requestIds: ['current-request'], turnId: 'current-turn',
    };
    expect(noteCoreBrowserEvidence(current)).toBe(true);
    const before = coreBrowserEvidence(CONV);
    expect(noteCoreBrowserEvidence({ ...current, navigationEpoch: 4,
      observedAt: current.observedAt + 100, requestIds: ['old-request'], turnId: 'old-turn' })).toBe(false);
    expect(coreBrowserEvidence(CONV)).toEqual(before);
  });

  it('accepts increasing same-document epochs and a new document starting at epoch zero', () => {
    const current = {
      conversationId: CONV, documentId: 'first-document', navigationEpoch: 5,
      observedAt: 1762780010000, shell: 'classic' as const, shellDiscovery: 'compatible' as const,
      requestIds: ['current-request'], turnId: 'current-turn',
    };
    expect(noteCoreBrowserEvidence(current)).toBe(true);
    expect(noteCoreBrowserEvidence({ ...current, navigationEpoch: 6, observedAt: current.observedAt + 1 })).toBe(true);
    expect(noteCoreBrowserEvidence({ ...current, documentId: 'new-document', navigationEpoch: 0,
      observedAt: current.observedAt + 2 })).toBe(true);
    expect(coreBrowserEvidence(CONV)).toMatchObject({ documentId: 'new-document', navigationEpoch: 0 });
    expect(noteCoreBrowserEvidence({ ...current, observedAt: current.observedAt + 1 })).toBe(false);
  });
  it('retains shellScan.reader when input.reader is an explicit undefined own property', () => {
    const input = {
      conversationId: CONV,
      documentId: 'doc-162',
      navigationEpoch: 1,
      observedAt: 1762780000000,
      shell: 'classic' as const,
      shellDiscovery: 'compatible' as const,
      requestIds: ['req-1'],
      turnId: 'turn-1',
      reader: undefined as unknown as Record<string, unknown>,
      shellScan: {
        selectorMatches: 2, mapped: 2,
        rejects: rejects53,
        reader: {
          fiberWire: 19,
          fiberKeys: 53,
          contentRecorder: 162,
          contentKeys: 53,
          workerRecorder: 162,
          workerKeys: 53,
        },
      },
    };
    // The regression precondition: the own property descriptor IS defined even though the value is undefined.
    expect(Object.getOwnPropertyDescriptor(input, 'reader')).toBeDefined();
    expect((Object.getOwnPropertyDescriptor(input, 'reader') as PropertyDescriptor).value).toBeUndefined();
    expect(noteCoreBrowserEvidence(input)).toBe(true);
  });

  it('negative control 1: strips fiberWire, fiberKeys, contentKeys, workerKeys when shellScan is absent', () => {
    const input = {
      conversationId: CONV,
      documentId: 'doc-no-scan',
      navigationEpoch: 0,
      observedAt: 1762780001000,
      shell: 'unknown' as const,
      shellDiscovery: 'unknown' as const,
      requestIds: [],
      turnId: 'turn-0',
      shellScan: undefined as unknown as Record<string, never>,
      reader: {
        fiberWire: 19,
        fiberKeys: 53,
        contentRecorder: 162,
        contentKeys: 53,
        workerRecorder: 162,
        workerKeys: 53,
      },
    };
    expect(noteCoreBrowserEvidence(input)).toBe(true);
  });

  it('negative control 2: rejects evidence when navigationEpoch or observedAt is invalid', () => {
    expect(
      noteCoreBrowserEvidence({
        conversationId: CONV,
        documentId: 'doc-invalid',
        navigationEpoch: -1,
        observedAt: 0,
        shell: 'classic',
        shellDiscovery: 'compatible',
        requestIds: [],
        turnId: 'turn-invalid',
      }),
    ).toBe(false);
  });

  it('positive control: valid input with undefined reader and valid shellScan still accepted', () => {
    expect(
      noteCoreBrowserEvidence({
        conversationId: CONV,
        documentId: 'doc-valid',
        navigationEpoch: 3,
        observedAt: 1762780002000,
        shell: 'classic',
        shellDiscovery: 'compatible',
        requestIds: ['req-a', 'req-b'],
        turnId: 'turn-pos',
        shellScan: {
          selectorMatches: 3, mapped: 3,
          rejects: rejects53,
          reader: { fiberWire: 19, fiberKeys: 53, contentRecorder: 162, contentKeys: 53, workerRecorder: 162, workerKeys: 53 },
        },
      }),
    ).toBe(true);
  });
});

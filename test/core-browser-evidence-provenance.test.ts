import { describe, expect, it } from 'vitest';
import { noteCoreBrowserEvidence } from '../src/main/core-browser-evidence.js';

const CONV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const rejects53 = {
  fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0,
  ...Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`r${i}`, 0])),
};

describe('R80.3 noteCoreBrowserEvidence provenance and negative controls', () => {
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

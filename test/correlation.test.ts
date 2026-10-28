import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushDurable, initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import {
  appendEvent,
  createSession,
  initSessionStore,
  resetSessionStoreForTests,
  unsetSessionRootForTests
} from '../src/main/session/store.js';
import {
  observeRequestCorrelation,
  observeRequestCorrelations,
  commitRequestCorrelations,
  correlationCommitPending,
  requestCorrelation,
  awaitRequestCorrelation,
  restoreRequestCorrelations,
  resetCorrelationRegistryForTests
} from '../src/main/session/correlation.js';

describe('request correlation ownership', () => {
  beforeEach(() => resetCorrelationRegistryForTests());
  afterEach(() => vi.useRealTimers());

  it('spends grace once per request while accepting late exact evidence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const first = awaitRequestCorrelation('wfr-missing', 60);
    await vi.advanceTimersByTimeAsync(60);
    expect(await first).toBeNull();
    expect(await awaitRequestCorrelation('wfr-missing', 60)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    const other = awaitRequestCorrelation('wfr-other', 60);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(await other).toBeNull();

    observeRequestCorrelation({ requestId: 'wfr-missing', conversationId: 'conv-late',
      sessionId: 'session-late', messageId: 'message-late', tool: '', observedAt: 1 });
    expect((await awaitRequestCorrelation('wfr-missing', 60))?.conversationId).toBe('conv-late');
  });

  it('joins only the upstream UUID version alias while keeping opaque IDs exact and foreign epochs refused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = '93ff44d2-cfea-4f32-8ea7-7a991c9cfe49';
    const call = '93ff44d2-cfea-9f32-8ea7-7a991c9cfe49';
    const waiting = awaitRequestCorrelation(call, 20_000);
    const owner = { requestId: page, conversationId: 'conv-version', sessionId: 'session-version', messageId: 'native-one', tool: 'read', observedAt: 1 };
    observeRequestCorrelation(owner);
    expect(requestCorrelation(call)?.conversationId).toBe('conv-version');
    expect((await waiting)?.requestId).toBe(page);
    expect(requestCorrelation(call.toUpperCase())?.requestId).toBe(page);
    for (const other of ['93ff44d2-cfea-9f32-8ea7-7a991c9cfe4a', '93ff44d2-cfeb-4f32-8ea7-7a991c9cfe49', '93ff44d2-cfea-f32-8ea7-7a991c9cfe49']) expect(requestCorrelation(other)).toBeNull();
    observeRequestCorrelation({ ...owner, requestId: 'wfr_01a0ec298ec4718b8145bf6a9c2413a2' });
    expect(requestCorrelation('wfr_01a0ec298ec4719b8145bf6a9c2413a2')).toBeNull();
    expect(observeRequestCorrelation({ ...owner, requestId: call, conversationId: 'conv-other' })).toBe('refused');
    expect(observeRequestCorrelation({ ...owner, requestId: call, sessionId: 'session-other' })).toBe('refused');
    expect(requestCorrelation(call)?.nativeCallAmbiguous).not.toBe(true);
  });

  it('spends UUID version aliases against one existing evidence deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const first = awaitRequestCorrelation('93ff44d2-cfea-4f32-8ea7-7a991c9cfe49', 100);
    await vi.advanceTimersByTimeAsync(60);
    const second = awaitRequestCorrelation('93ff44d2-cfea-9f32-8ea7-7a991c9cfe49', 100);
    await vi.advanceTimersByTimeAsync(40);
    expect(await first).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(await second).toBeNull();
  });

  it('retains sibling-native ambiguity across UUID version aliases and durable restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-version-siblings-'));
    try {
      resetDurableForTests(); initDurableStore(dir);
      const original = { requestId: '93ff44d2-cfea-4f32-8ea7-7a991c9cfe49', conversationId: 'conv-version', sessionId: 'session-version', messageId: 'native-one', tool: 'read', observedAt: 1 };
      observeRequestCorrelation(original);
      expect(observeRequestCorrelation({ ...original, requestId: '93ff44d2-cfea-9f32-8ea7-7a991c9cfe49', messageId: 'native-two', observedAt: 2 })).toBe('same');
      await commitRequestCorrelations(); await flushDurable(); resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation(original.requestId)).toMatchObject({ requestId: original.requestId, nativeCallAmbiguous: true, messageId: original.messageId });
    } finally { resetCorrelationRegistryForTests(); resetDurableForTests(); await rm(dir, { recursive: true, force: true }); }
  });

  it('refuses duplicate committed owners hidden behind UUID version aliases without rewriting the ledger', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-version-duplicate-'));
    try {
      resetDurableForTests(); initDurableStore(dir);
      const original = { requestId: '93ff44d2-cfea-4f32-8ea7-7a991c9cfe49', conversationId: 'conv-version', sessionId: 'session-version', messageId: 'native-one', tool: 'read', observedAt: 1 };
      const saved = { version: 6, complete: true, entries: [original, { ...original, requestId: '93ff44d2-cfea-9f32-8ea7-7a991c9cfe49', nativeCallAmbiguous: true }] };
      await writeDurableNow('request-correlations', saved);
      await expect(restoreRequestCorrelations()).rejects.toThrow(/restore request-correlations/);
      expect(await readDurable('request-correlations')).toEqual(saved);
    } finally { resetCorrelationRegistryForTests(); resetDurableForTests(); await rm(dir, { recursive: true, force: true }); }
  });

  it('shares a deadline across overlapping callers instead of restarting their grace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const first = awaitRequestCorrelation('wfr-overlap', 100);
    await vi.advanceTimersByTimeAsync(40);
    const second = awaitRequestCorrelation('wfr-overlap', 100);
    await vi.advanceTimersByTimeAsync(60);
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the remaining longer recorder grace after a shorter identity timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const short = awaitRequestCorrelation('wfr-longer', 15);
    await vi.advanceTimersByTimeAsync(15);
    expect(await short).toBeNull();
    const longer = awaitRequestCorrelation('wfr-longer', 20);
    await vi.advanceTimersByTimeAsync(4);
    expect(vi.getTimerCount()).toBe(1);
    observeRequestCorrelation({ requestId: 'wfr-longer', conversationId: 'conv-proved',
      sessionId: 'session-proved', messageId: 'message-proved', tool: '', observedAt: 1 });
    expect((await longer)?.conversationId).toBe('conv-proved');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the longer grace at its original deadline and leaves zero-time lookups uncharged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    expect(await awaitRequestCorrelation('wfr-budget', 0)).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    const short = awaitRequestCorrelation('wfr-budget', 15);
    await vi.advanceTimersByTimeAsync(15);
    expect(await short).toBeNull();
    const longer = awaitRequestCorrelation('wfr-budget', 20);
    await vi.advanceTimersByTimeAsync(5);
    expect(await longer).toBeNull();
    expect(await awaitRequestCorrelation('wfr-budget', 20)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one turn-level request id owned across different MCP messages and tools in the same session epoch', () => {
    const requestId = 'wfr_shared_turn';
    const now = Date.now();
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-read',
        tool: 'read',
        observedAt: now
      })
    ).toBe('stored');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-exec',
        tool: 'exec_command',
        observedAt: now + 1
      })
    ).toBe('same');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-session',
        tool: 'session',
        observedAt: now + 2
      })
    ).toBe('same');

    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
    expect(requestCorrelation(requestId)?.sessionId).toBe('session-a');
  });

  it('retains positive evidence of distinct native Core calls sharing one workflow request without reassigning the original owner', () => {
    const original = { requestId: 'wfr_two_distinct_native_calls', conversationId: 'conv-shared-workflow',
      sessionId: 'session-shared-workflow', messageId: 'provider-read-first',
      tool: 'read', observedAt: 100 };
    expect(observeRequestCorrelation(original)).toBe('stored');
    expect(observeRequestCorrelation({ ...original, observedAt: 101 })).toBe('same');
    expect(requestCorrelation(original.requestId)?.nativeCallAmbiguous).not.toBe(true);
    expect(observeRequestCorrelation({
      ...original, messageId: 'provider-read-second', observedAt: 102
    })).toBe('same');
    expect(requestCorrelation(original.requestId)).toMatchObject({
      conversationId: original.conversationId, sessionId: original.sessionId,
      messageId: original.messageId, nativeCallAmbiguous: true
    });
    expect(observeRequestCorrelation({
      ...original, sessionId: 'session-foreign-epoch', messageId: 'provider-foreign',
      observedAt: 103
    })).toBe('refused');
    expect(requestCorrelation(original.requestId)).toMatchObject({
      messageId: original.messageId, nativeCallAmbiguous: true
    });
  });

  it('tracks a real typed native call separately from early untooled request sightings before flagging a second typed call', () => {
    const bare = { requestId: 'wfr_rowless_then_two_native_calls',
      conversationId: 'conv-rowless-native', sessionId: 'session-rowless-native',
      messageId: 'stream:wfr_rowless_then_two_native_calls', tool: '', observedAt: 100 };
    expect(observeRequestCorrelation(bare)).toBe('stored');
    expect(observeRequestCorrelation({
      ...bare, messageId: 'actual-first-core-call', tool: 'read', observedAt: 101
    })).toBe('same');
    expect(requestCorrelation(bare.requestId)?.nativeCallAmbiguous).not.toBe(true);
    expect(observeRequestCorrelation({
      ...bare, messageId: 'actual-second-core-call', tool: 'read', observedAt: 102
    })).toBe('same');
    expect(requestCorrelation(bare.requestId)).toMatchObject({
      messageId: bare.messageId, nativeCallAmbiguous: true
    });
  });

  it('restores sticky sibling-native-message uncertainty after the durable ACK boundary without replacing the first session owner', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-native-siblings-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const original = { requestId: 'wfr_sibling_native_restart', conversationId: 'conv-native-restart',
        sessionId: 'session-native-restart', messageId: 'native-first', tool: 'read', observedAt: 100 };
      expect(observeRequestCorrelation(original)).toBe('stored');
      expect(observeRequestCorrelation({
        ...original, messageId: 'native-second', observedAt: 101
      })).toBe('same');
      await flushDurable();
      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation(original.requestId)).toMatchObject({
        conversationId: original.conversationId, sessionId: original.sessionId,
        messageId: original.messageId, nativeCallAmbiguous: true
      });
      expect(observeRequestCorrelation({ ...original, observedAt: 102 })).toBe('same');
      expect(observeRequestCorrelation({
        ...original, messageId: 'native-second', observedAt: 103
      })).toBe('same');
      expect(requestCorrelation(original.requestId)).toMatchObject({
        messageId: original.messageId, nativeCallAmbiguous: true
      });
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restores a valid complete-v6 rowless-to-typed native owner without manufacturing a sibling veto', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-valid-typed-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const original = { requestId: 'wfr_valid_native_complete', conversationId: 'conv-valid-native',
        sessionId: 'session-valid-native', messageId: 'stream:wfr_valid_native_complete',
        tool: '', turnId: 'g-valid-native', observedAt: 100 };
      expect(observeRequestCorrelation(original)).toBe('stored');
      expect(observeRequestCorrelation({ ...original, messageId: 'native-first-real-tool',
        tool: 'read', observedAt: 101 })).toBe('same');
      await commitRequestCorrelations();
      await flushDurable();
      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation(original.requestId)).toMatchObject({
        ...original, tool: 'read', observedAt: 101,
        nativeCallMessageId: 'native-first-real-tool'
      });
      expect(requestCorrelation(original.requestId)?.nativeCallAmbiguous).not.toBe(true);
      expect(observeRequestCorrelation({ ...original, messageId: 'native-first-real-tool',
        tool: 'read', observedAt: 102 })).toBe('same');
      expect(requestCorrelation(original.requestId)?.nativeCallAmbiguous).not.toBe(true);
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('durably enriches an older complete-v6 rowless owner that already names the SAME native message but lacks its tool type', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-native-tool-enrich-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const owner = { requestId: 'wfr_legacy_rowless_typed_tool', conversationId: 'conv-old-v6-tool',
        sessionId: 'session-old-v6-tool', messageId: 'stream:wfr_legacy_rowless_typed_tool',
        nativeCallMessageId: 'native-original-named', tool: '', observedAt: 100 };
      await writeDurableNow('request-correlations', { version: 6, complete: true, entries: [owner] });
      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation(owner.requestId)).toMatchObject(owner);
      expect(correlationCommitPending()).toBe(false);
      expect(observeRequestCorrelation({ ...owner, messageId: 'native-original-named',
        tool: 'read', observedAt: 100 })).toBe('same');
      expect(requestCorrelation(owner.requestId)).toMatchObject({
        ...owner, tool: 'read', nativeCallMessageId: owner.nativeCallMessageId
      });
      expect(requestCorrelation(owner.requestId)?.nativeCallAmbiguous).not.toBe(true);
      // The type was the sole changed field: a successful browser read-back
      // must wait for a new durable commit even without a newer timestamp.
      expect(correlationCommitPending()).toBe(true);
      await commitRequestCorrelations();
      expect(correlationCommitPending()).toBe(false);
      await flushDurable();
      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation(owner.requestId)).toMatchObject({
        ...owner, tool: 'read', nativeCallMessageId: owner.nativeCallMessageId
      });
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retains a same-native-message tool-type contradiction as a sticky durable completion veto across restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-tool-type-veto-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const owner = { requestId: 'wfr_one_parent_two_tool_names', conversationId: 'conv-tool-veto',
        sessionId: 'session-tool-veto', messageId: 'stream:wfr_one_parent_two_tool_names',
        tool: '', observedAt: 100 };
      expect(observeRequestCorrelation(owner)).toBe('stored');
      expect(observeRequestCorrelation({ ...owner, messageId: 'native-typed-original',
        tool: 'read', observedAt: 101 })).toBe('same');
      expect(requestCorrelation(owner.requestId)).toMatchObject({
        tool: 'read', nativeCallMessageId: 'native-typed-original'
      });
      expect(observeRequestCorrelation({ ...owner, messageId: 'native-typed-original',
        tool: 'exec_command', observedAt: 102 })).toBe('same');
      expect(requestCorrelation(owner.requestId)).toMatchObject({
        tool: 'read', nativeCallMessageId: 'native-typed-original', nativeCallAmbiguous: true
      });
      await commitRequestCorrelations();
      await flushDurable();
      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation(owner.requestId)).toMatchObject({
        tool: 'read', nativeCallMessageId: 'native-typed-original', nativeCallAmbiguous: true
      });
      expect(observeRequestCorrelation({ ...owner, messageId: 'native-typed-original',
        tool: 'read', observedAt: 103 })).toBe('same');
      expect(requestCorrelation(owner.requestId)?.nativeCallAmbiguous).toBe(true);
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not acknowledge a newer sibling observation while an older snapshot is still committing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-overlap-'));
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const durable = await import('../src/main/durable.js');
    const realWrite = durable.writeDurableNow;
    let holdFirst = true;
    const spy = vi.spyOn(durable, 'writeDurableNow').mockImplementation(async (name, value) => {
      if (name === 'request-correlations' && holdFirst) {
        holdFirst = false;
        entered();
        await blocked;
      }
      return realWrite(name, value);
    });
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const original = { requestId: 'wfr_overlap_native_result', conversationId: 'conv-overlap',
        sessionId: 'session-overlap', messageId: 'provider-first', tool: 'read', observedAt: 100 };
      expect(observeRequestCorrelation(original)).toBe('stored');
      const initialCommit = commitRequestCorrelations();
      await started;
      expect(correlationCommitPending()).toBe(true);
      expect(observeRequestCorrelation({
        ...original, messageId: 'provider-second', observedAt: 101
      })).toBe('same');
      expect(correlationCommitPending()).toBe(true);
      let newerAcknowledged = false;
      const newerCommit = commitRequestCorrelations().then(() => { newerAcknowledged = true; });
      await Promise.resolve();
      expect(newerAcknowledged).toBe(false);
      release();
      await initialCommit;
      await newerCommit;
      expect(newerAcknowledged).toBe(true);
      expect(correlationCommitPending()).toBe(false);
      await flushDurable();
      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation(original.requestId)).toMatchObject({
        messageId: original.messageId, nativeCallAmbiguous: true
      });
    } finally {
      release();
      spy.mockRestore();
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['malformed-json', 'invalid-complete-owner', 'lost-sibling-veto',
    'duplicate-committed-owner', 'invalid-typed-native-call'] as const)(
    'fails closed on %s after a durably acknowledged sibling-native-call veto, retaining the original ledger bytes',
    async (failure) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-unreadable-'));
      try {
        resetDurableForTests();
        resetSessionStoreForTests();
        initDurableStore(dir);
        initSessionStore(dir);
        const session = await createSession({ conversationId: 'conv-sibling-incident' });
        const owner = { requestId: 'wfr_sibling_unreadable_ledger', conversationId: 'conv-sibling-incident',
          sessionId: session.id, messageId: 'native-original', tool: 'read', observedAt: 100 };
        expect(observeRequestCorrelation(owner)).toBe('stored');
        expect(observeRequestCorrelation({ ...owner, messageId: 'native-sibling', observedAt: 101 })).toBe('same');
        await commitRequestCorrelations();
        await flushDurable();
        const file = path.join(dir, 'state', 'request-correlations.json');
        const acknowledged = { ...owner, observedAt: 101, nativeCallAmbiguous: true };
        const unreadable = failure === 'malformed-json' ? '{invalid-snapshot' :
          JSON.stringify({ version: 6, complete: true, entries:
            failure === 'invalid-complete-owner' ? [{ requestId: owner.requestId }] :
            failure === 'lost-sibling-veto' ? [{ ...acknowledged, nativeCallAmbiguous: 'invalid' }] :
            failure === 'duplicate-committed-owner' ? [acknowledged, { ...acknowledged,
              sessionId: 'session-foreign-native-owner', nativeCallAmbiguous: undefined }] :
            [{ ...acknowledged, nativeCallMessageId: 42 }] });
        await writeFile(file, unreadable, 'utf8');
        resetCorrelationRegistryForTests();
        await expect(restoreRequestCorrelations()).rejects.toThrow(/request-correlations state/);
        expect(requestCorrelation(owner.requestId)).toBeNull();
        // A missing native-call veto cannot silently become a fresh, usable
        // workflow owner after corruption or a failed disk/restore boundary.
        expect(await readFile(file, 'utf8')).toBe(unreadable);
      } finally {
        resetCorrelationRegistryForTests();
        resetSessionStoreForTests();
        unsetSessionRootForTests();
        resetDurableForTests();
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it('refuses a later same-conversation different-session epoch without refreshing the original request proof', () => {
    const original = {
      requestId: 'wfr_epoch_must_not_reattach', conversationId: 'conv-epoch-bound',
      sessionId: 'session-original', messageId: 'native-original', tool: 'read', observedAt: 100
    };
    expect(observeRequestCorrelation(original)).toBe('stored');
    expect(observeRequestCorrelation({
      ...original, sessionId: 'session-new-epoch', messageId: 'native-new',
      tool: 'exec_command', observedAt: 900
    })).toBe('refused');
    expect(requestCorrelation(original.requestId)).toEqual(original);
    expect(observeRequestCorrelation({
      ...original, messageId: 'native-later-same-epoch', observedAt: 110
    })).toBe('same');
    expect(requestCorrelation(original.requestId)).toMatchObject({
      sessionId: original.sessionId, messageId: original.messageId, observedAt: 110
    });
  });

  it('retains the first exact native turn without letting a later turn or session retarget it', () => {
    const owner = { requestId: 'wfr-native-turn', conversationId: 'conv-native-turn',
      sessionId: 'session-native-turn', messageId: 'native-message-a', tool: 'agents', observedAt: 1 };
    observeRequestCorrelation({ ...owner, turnId: 'native-turn-a' });
    observeRequestCorrelation({ ...owner, messageId: 'native-message-b', turnId: 'native-turn-b', observedAt: 2 });
    observeRequestCorrelation({ ...owner, sessionId: 'session-other-epoch', turnId: 'native-turn-c', observedAt: 3 });
    expect(requestCorrelation(owner.requestId)).toMatchObject({
      sessionId: owner.sessionId, messageId: owner.messageId, turnId: 'native-turn-a'
    });
  });

  it('enriches unknown legacy turn identity only from the same exact request session', () => {
    const owner = { requestId: 'wfr-native-turn-late', conversationId: 'conv-native-turn-late',
      sessionId: 'session-native-turn-late', messageId: 'native-message-a', tool: '', observedAt: 1 };
    observeRequestCorrelation(owner);
    observeRequestCorrelation({ ...owner, sessionId: 'session-foreign-epoch', turnId: 'foreign-turn', observedAt: 2 });
    expect(requestCorrelation(owner.requestId)?.turnId).toBeUndefined();
    observeRequestCorrelation({ ...owner, turnId: 'native-turn-a' });
    expect(requestCorrelation(owner.requestId)?.turnId).toBe('native-turn-a');
  });

  /**
   * The rule the whole registry exists to keep: a request id is bound to a chat once, and then
   * it is that chat's for good.
   *
   * A second conversation claiming a proven id is a page that is wrong about itself - a React
   * tree still mounted from the chat before it, a fresh chat whose client thread id has not
   * caught up. Believing it used to cost the id itself: the entry went permanently unresolved,
   * so every further call of a workflow that was still running waited fifteen seconds for
   * evidence that could no longer be accepted, and landed in Unattributed activity. Refusing
   * the claimant costs the claimant nothing that was ever really theirs.
   */
  it('keeps the first proven owner when a second conversation claims the same request id', () => {
    const requestId = 'wfr_cross_chat';
    const now = Date.now();
    observeRequestCorrelation({
      requestId,
      conversationId: 'conv-a',
      sessionId: 'session-a',
      messageId: 'msg-a',
      tool: 'read',
      observedAt: now
    });
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-a-refresh',
        tool: 'read',
        observedAt: now + 1
      })
    ).toBe('same');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-b',
        sessionId: 'session-b',
        messageId: 'msg-b',
        tool: 'read',
        observedAt: now + 2
      })
    ).toBe('refused');
    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
    expect(requestCorrelation(requestId)?.sessionId).toBe('session-a');

    // And the owner is still an owner afterwards, not a survivor in a degraded state: its own
    // later sightings keep being accepted exactly as they were before anyone argued.
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-a-later',
        tool: 'exec_command',
        observedAt: now + 3
      })
    ).toBe('same');
    expect(requestCorrelation(requestId)?.observedAt).toBe(now + 3);
  });

  it('does not age a proven request owner out just because the page evidence is old', () => {
    const requestId = 'wfr_long_running_workflow';
    observeRequestCorrelation({
      requestId,
      conversationId: 'conv-a',
      sessionId: 'session-a',
      messageId: 'msg-a',
      tool: 'exec_command',
      // Deliberately ancient. 1.8.1 forgot this after ten minutes and started filing later
      // calls from the same still-running workflow into Unattributed activity.
      observedAt: 1
    });

    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
  });

  it('evicts by latest same-owner observation rather than original insertion order', () => {
    const refreshedId = 'wfr_refreshed_old_request';
    const correlation = (requestId: string, observedAt: number) => ({
      requestId,
      conversationId: 'conv-a',
      sessionId: 'session-a',
      messageId: `msg-${requestId}`,
      tool: 'read',
      observedAt
    });

    // Fill the bounded registry exactly. The request we care about is deliberately the oldest
    // insertion, then is observed again immediately before one new id forces an eviction.
    observeRequestCorrelations([
      correlation(refreshedId, 1),
      ...Array.from({ length: 49_999 }, (_, index) => correlation(`wfr_fill_${index}`, index + 2))
    ]);
    expect(
      observeRequestCorrelation({
        ...correlation(refreshedId, 100_000),
        messageId: 'msg-refreshed'
      })
    ).toBe('same');

    observeRequestCorrelation(correlation('wfr_newest', 100_001));

    expect(requestCorrelation(refreshedId)?.conversationId).toBe('conv-a');
    expect(requestCorrelation(refreshedId)?.observedAt).toBe(100_000);
    expect(requestCorrelation('wfr_fill_0')).toBeNull();
  });

  it('restores proven request ownership from durable state after an app restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const requestId = 'wfr_survives_restart';
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-durable',
        sessionId: 'session-durable',
        messageId: 'msg-durable',
        tool: 'read',
        observedAt: 123
      });
      await flushDurable();

      resetCorrelationRegistryForTests();
      expect(requestCorrelation(requestId)).toBeNull();

      await restoreRequestCorrelations();
      expect(requestCorrelation(requestId)?.conversationId).toBe('conv-durable');
      expect(requestCorrelation(requestId)?.sessionId).toBe('session-durable');
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restores the original session epoch after an overlapping stale-session callback and rejects that callback again after restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-epoch-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const original = { requestId: 'wfr_durable_epoch_proof', conversationId: 'conv-durable-epoch',
        sessionId: 'session-native-original', messageId: 'original-call', tool: 'read', observedAt: 10 };
      expect(observeRequestCorrelation(original)).toBe('stored');
      const late = { ...original, sessionId: 'session-native-next', messageId: 'duplicate-callback',
        observedAt: 900 };
      expect(observeRequestCorrelation(late)).toBe('refused');
      expect(observeRequestCorrelation(late)).toBe('refused');
      await flushDurable();
      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation(original.requestId)).toEqual(original);
      expect(observeRequestCorrelation(late)).toBe('refused');
      expect(requestCorrelation(original.requestId)).toEqual(original);
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * ChatGPT publishes `metadata.request_id` before the `api_tool` message that names the tool,
   * and the bridge stores that early sighting with an empty tool on purpose: the join never uses
   * the name, and waiting for it is what used to file the call under Unattributed activity. Two
   * such rows sat in the live 2026-09-01 registry. Both would have been thrown away on the next
   * launch by a validity check stricter than the registry's own answer, taking the proven owner
   * of a workflow whose calls could still be arriving.
   */
  it('restores an owner proved by a request id ChatGPT had not yet given a tool name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-untooled-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const requestId = 'f0f00012-1111-4111-8111-111111111111';
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-bare-request-id',
        sessionId: '2026-01-01-00000028',
        messageId: 'f0f00013-1111-4111-8111-111111111111',
        tool: '',
        observedAt: 1_788_276_631_192
      });
      await flushDurable();

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();

      expect(requestCorrelation(requestId)?.conversationId).toBe('conv-bare-request-id');
      expect(requestCorrelation(requestId)?.sessionId).toBe('2026-01-01-00000028');
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('migrates older proven owners and forgets the sticky conflicts those versions wrote', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-v3-conflict-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      await writeDurableNow('request-correlations', {
        version: 3,
        entries: [
          {
            requestId: 'wfr_v3_proven_owner',
            value: {
              requestId: 'wfr_v3_proven_owner',
              conversationId: 'conv-v3-proven',
              sessionId: 'session-v3-proven',
              messageId: 'message-v3-proven',
              tool: 'read',
              observedAt: 100
            },
            conflicted: false
          },
          {
            requestId: 'wfr_v3_false_conflict',
            value: null,
            conflicted: true
          }
        ]
      });

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_v3_proven_owner')?.conversationId).toBe('conv-v3-proven');
      // Forgotten, not restored as a verdict: the id is simply unproved again, and the next page
      // that proves it owns it.
      expect(requestCorrelation('wfr_v3_false_conflict')).toBeNull();
      expect(
        observeRequestCorrelation({
          requestId: 'wfr_v3_false_conflict',
          conversationId: 'conv-after-migration',
          sessionId: 'session-after-migration',
          messageId: 'message-after-migration',
          tool: 'read',
          observedAt: 200
        })
      ).toBe('stored');
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds the first 1.8.2 owner index from already-attributed session history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-migrate-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);

      const session = await createSession({ title: 'old attributed history', conversationId: 'conv-history' });
      await appendEvent(session.id, {
        time: 200,
        source: 'mcp',
        kind: 'tool_call',
        call: {
          callId: 'call-history',
          tool: 'read',
          attribution: 'request_id',
          requestId: 'wfr_history',
          conversationId: 'conv-history',
          attributionMethod: 'request_id',
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok',
          durationMs: 1,
          summary: { kind: 'read', tone: 'neutral', title: 'Read history' }
        }
      });

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_history')?.conversationId).toBe('conv-history');
      expect(requestCorrelation('wfr_history')?.sessionId).toBe(session.id);

      await flushDurable();
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_history')?.conversationId).toBe('conv-history');
      expect(requestCorrelation('wfr_history')?.sessionId).toBe(session.id);
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reconciles a valid stale snapshot with newer durable attributed history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-stale-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const conversationId = 'conv-stale-reconcile';
      const session = await createSession({ title: 'stale correlation snapshot', conversationId });
      const toolCall = (callId: string, requestId: string, time: number) => ({
        time,
        source: 'mcp' as const,
        kind: 'tool_call' as const,
        call: {
          callId,
          tool: 'read',
          attribution: 'request_id' as const,
          requestId,
          conversationId,
          attributionMethod: 'request_id' as const,
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok' as const,
          durationMs: 1,
          summary: { kind: 'read' as const, tone: 'neutral' as const, title: callId }
        }
      });

      await appendEvent(session.id, toolCall('call-old', 'wfr_old_snapshot', 1));
      // Version 5 acknowledged owners before its debounced snapshot was necessarily current.
      // Preserve that legacy shape so this test exercises the one-time migration scan rather
      // than version 6's committed browser-ack boundary.
      await writeDurableNow('request-correlations', {
        version: 5,
        entries: [{
          requestId: 'wfr_old_snapshot', conversationId, sessionId: session.id,
          messageId: 'msg-old', tool: 'read', observedAt: 1
        }]
      });

      await appendEvent(session.id, toolCall('call-new', 'wfr_new_history', 2));
      // Lose process memory before the debounced index write catches up. Session JSONL is
      // already durable, so restore must merge it into the older valid snapshot.
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      initDurableStore(dir);

      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_old_snapshot')?.conversationId).toBe(conversationId);
      expect(requestCorrelation('wfr_new_history')?.conversationId).toBe(conversationId);
      const migrated = await readDurable<{ version: number; complete?: boolean; entries: Array<{ requestId: string }> }>('request-correlations');
      expect(migrated?.version).toBe(6);
      expect(migrated?.complete).toBe(true);
      expect(migrated?.entries.map((entry) => entry.requestId).sort()).toEqual(['wfr_new_history', 'wfr_old_snapshot']);
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('trusts a complete version-6 ledger and scans history only when the ledger cannot vouch for itself', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-complete-'));
    const owner = (requestId: string, sessionId: string) => ({
      requestId, conversationId: 'conv-complete', sessionId, messageId: `msg-${requestId}`, tool: 'read', observedAt: 1
    });
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const session = await createSession({ title: 'complete ledger', conversationId: 'conv-complete' });
      await appendEvent(session.id, {
        time: 2,
        source: 'mcp',
        kind: 'tool_call',
        call: {
          callId: 'call-history-only',
          tool: 'read',
          attribution: 'request_id',
          requestId: 'wfr_history_only',
          conversationId: 'conv-complete',
          attributionMethod: 'request_id',
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok',
          durationMs: 1,
          summary: { kind: 'read', tone: 'neutral', title: 'Read history' }
        }
      });

      const ledgers = [
        { scanned: false, value: { version: 6, complete: true, entries: [owner('wfr_committed', session.id)] } },
        { scanned: true, value: { version: 6, entries: [owner('wfr_committed', session.id)] } }
      ];
      for (const ledger of ledgers) {
        await writeDurableNow('request-correlations', ledger.value);
        resetCorrelationRegistryForTests();
        await restoreRequestCorrelations();
        expect(requestCorrelation('wfr_committed')?.conversationId).toBe('conv-complete');
        expect(requestCorrelation('wfr_history_only')?.conversationId ?? null).toBe(ledger.scanned ? 'conv-complete' : null);
      }
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

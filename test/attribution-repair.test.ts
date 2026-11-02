import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { flushRecorder, queueDeterministicAttributionRepair, recordToolCall, repairDeterministicAttribution, resetRecorderForTests, sessionForConversation } from '../src/main/session/recorder.js';
import { appendEvent, createSession, flushSessions, getSession, indexedSessions, initSessionStore, readEvents, rebindSession, resetSessionStoreForTests, unsetSessionRootForTests, writeAsset } from '../src/main/session/store.js';
import type { SessionEvent } from '../src/shared/session.js';

let dir = '';
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const row = (id: string, requestId: string | null, time: number) => ({
  source: 'mcp' as const, kind: 'tool_call' as const, time,
  call: { callId: id, requestId, tool: 'read', attribution: 'unattributed' as const, conversationId: null,
    attributionMethod: 'unattributed' as const, args: { text: '{}', chars: 2, truncated: false },
    result: { text: 'ok', chars: 2, truncated: false }, durationMs: 1, outcome: 'ok' as const,
    summary: { title: id, tone: 'neutral' as const, kind: 'read' as const } }
});
const record = (requestId?: string, text = 'ok') => recordToolCall({
  tool: 'read', args: {}, content: [{ type: 'text', text }], outcome: 'ok', durationMs: 1,
  startedAt: Date.now(), requestId
});
const prove = (requestId: string, sessionId: string) => observeRequestCorrelation({
  requestId, sessionId, conversationId: 'repair-target', messageId: requestId, tool: 'read', observedAt: Date.now()
});
const calls = async (id: string) => (await readEvents(id, { kinds: ['tool_call'] })) as Extract<SessionEvent, { kind: 'tool_call' }>[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-attribution-repair-'));
  initConfigPath(dir); initSessionStore(dir); initDurableStore(dir);
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await flushRecorder(); await flushSessions(); await flushDurable();
  resetRecorderForTests(); resetCorrelationRegistryForTests(); resetSessionStoreForTests();
  unsetSessionRootForTests(); resetDurableForTests();
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

async function storageRetryFixture() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const bucket = await createSession({ title: 'Unattributed activity' });
  const target = (await sessionForConversation('repair-target'))!;
  const bytes = Buffer.from('Retained exact tool-result asset');
  const asset = await writeAsset(bucket.id, bytes, 'text/plain');
  const original = row('storage-retry-call', 'storage-retry-request', Date.now());
  original.call.result = { ...original.call.result, assetId: asset.id } as typeof original.call.result;
  await appendEvent(bucket.id, original);
  await flushSessions();
  prove('storage-retry-request', target);
  return { bucket: bucket.id, target, bytes, asset, original };
}

it.each(['asset', 'append', 'source-sync', 'destination-sync', 'source-rewrite'] as const)(
  'retries one transient attribution storage failure without losing or duplicating custody (%s)', async failure => {
    const f = await storageRetryFixture();
    if (failure === 'source-rewrite') {
      // Keep one unowned row so the store rewrites this bucket rather than deleting it.
      await appendEvent(f.bucket, row('retained-unknown-call', null, Date.now()));
      await flushSessions();
    }
    const retained = failure === 'source-rewrite' ? ['retained-unknown-call'] : [];
    const sourceJournal = path.join(dir, 'sessions', f.bucket, 'events.jsonl');
    const targetJournal = path.join(dir, 'sessions', f.target, 'events.jsonl');
    const targetAsset = path.join(dir, 'sessions', f.target, 'assets', f.asset.id);
    let failed = false;
    const failOnce = () => { if (failed) return; failed = true; throw new Error('fixture transient storage failure'); };
    if (failure === 'asset') {
      const write = fs.writeFile.bind(fs);
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        if (String(args[0]) === targetAsset) failOnce();
        return write(...args);
      });
    } else if (failure === 'append') {
      const append = fs.appendFile.bind(fs);
      vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
        if (String(args[0]) === targetJournal) failOnce();
        return append(...args);
      });
    } else if (failure === 'source-rewrite') {
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
        if (String(args[1]) === sourceJournal) failOnce();
        return rename(...args);
      });
    } else {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[1] === 'r+' && String(args[0]) === (failure === 'source-sync' ? sourceJournal : targetJournal)) {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, 'sync').mockImplementation(async () => { failOnce(); await sync(); });
        }
        return handle;
      });
    }
    const first = await repairDeterministicAttribution().then(value => ({ value, error: null }),
      error => ({ value: null, error: error as Error }));
    expect(failed).toBe(true);
    if (first.error) expect(first.error.message).toContain('fixture transient storage failure');
    else expect(first.value).toEqual({ sessions: 0, calls: 0 });
    expect((await calls(f.bucket)).map(event => event.call.callId)).toEqual([f.original.call.callId, ...retained]);
    expect(await fs.readFile(path.join(dir, 'sessions', f.bucket, 'assets', f.asset.id))).toEqual(f.bytes);
    await vi.advanceTimersByTimeAsync(999);
    expect((await calls(f.bucket))).toHaveLength(1 + retained.length);
    await vi.advanceTimersByTimeAsync(1);
    await flushRecorder();
    expect((await calls(f.target)).map(event => event.call.callId)).toEqual([f.original.call.callId]);
    expect((await calls(f.bucket)).map(event => event.call.callId)).toEqual(retained);
    expect(await fs.readFile(targetAsset)).toEqual(f.bytes);
    expect((await calls(f.target))[0]!.call).toMatchObject({
      requestId: 'storage-retry-request', attributionMethod: 'request_id', conversationId: 'repair-target'
    });
  });

it('exhausts one automatic storage retry and rearms only on a fresh startup trigger', async () => {
  const f = await storageRetryFixture();
  const targetAsset = path.join(dir, 'sessions', f.target, 'assets', f.asset.id);
  const write = fs.writeFile.bind(fs);
  let attempts = 0, broken = true;
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]) === targetAsset) { attempts++; if (broken) throw new Error('fixture persistent storage failure'); }
    return write(...args);
  });
  await repairDeterministicAttribution();
  expect(attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  await flushRecorder();
  expect(attempts).toBe(2);
  await vi.advanceTimersByTimeAsync(60_000);
  await flushRecorder();
  expect(attempts).toBe(2);
  expect((await calls(f.bucket))).toHaveLength(1);
  broken = false;
  queueDeterministicAttributionRepair();
  await flushRecorder();
  expect(attempts).toBe(3);
  expect((await calls(f.target))).toHaveLength(1);
  expect((await calls(f.bucket))).toHaveLength(0);
});

it('flushes a newly scheduled attribution storage retry before shutdown returns', async () => {
  const f = await storageRetryFixture();
  const write = fs.writeFile.bind(fs);
  let failed = false;
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (!failed && String(args[0]) === path.join(dir, 'sessions', f.target, 'assets', f.asset.id)) {
      failed = true; throw new Error('fixture shutdown storage failure');
    }
    return write(...args);
  });
  await repairDeterministicAttribution();
  expect((await calls(f.bucket))).toHaveLength(1);
  await flushRecorder();
  expect((await calls(f.bucket))).toHaveLength(0);
  expect((await calls(f.target))).toHaveLength(1);
});

it('rechecks exact ownership on the delayed storage retry after a conversation handoff', async () => {
  const f = await storageRetryFixture();
  const write = fs.writeFile.bind(fs);
  let failed = false;
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (!failed && String(args[0]) === path.join(dir, 'sessions', f.target, 'assets', f.asset.id)) {
      failed = true; throw new Error('fixture storage failure before handoff');
    }
    return write(...args);
  });
  await repairDeterministicAttribution();
  expect(failed).toBe(true);
  expect(await rebindSession(f.target, 'repair-target', 'repair-successor')).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  await flushRecorder();
  expect((await calls(f.target))).toHaveLength(0);
  expect((await calls(f.bucket))).toEqual([expect.objectContaining({ call: expect.objectContaining({
    callId: f.original.call.callId, attributionMethod: 'unattributed', conversationId: null
  }) })]);
  expect(await fs.readFile(path.join(dir, 'sessions', f.bucket, 'assets', f.asset.id))).toEqual(f.bytes);
});

it('invalidates a repaired bucket when concurrent replacement preserves its count and timestamp', async () => {
  const bucket = await createSession({ title: 'Unattributed activity' });
  const target = (await sessionForConversation('repair-target'))!;
  const time = Date.now() + 10_000;
  await appendEvent(bucket.id, row('known', 'known', time - 1));
  await appendEvent(bucket.id, row('still-unknown', 'still-unknown', time));
  prove('known', target);
  const entered = gate(); const release = gate();
  const append = fs.appendFile.bind(fs);
  vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
    if (String(args[0]).includes(target) && String(args[0]).endsWith('events.jsonl')) {
      entered.resolve(); await release.promise;
    }
    return append(...args);
  });
  const repairing = repairDeterministicAttribution();
  try {
    await entered.promise;
    await appendEvent(bucket.id, row('concurrent', 'concurrent', time - 2));
  } finally { release.resolve(); }
  await repairing;
  expect((await getSession(bucket.id))?.toolCalls).toBe(2);
  expect((await getSession(bucket.id))?.updatedAt).toBe(time);
  prove('concurrent', target);
  await repairDeterministicAttribution(new Set(['concurrent']));
  expect((await calls(target)).map(event => event.call.callId)).toEqual(['known', 'concurrent']);
  expect((await calls(bucket.id)).map(event => event.call.callId)).toEqual(['still-unknown']);
});

it('does not delete a bucket when every scanned call was repaired but another call arrived during copying', async () => {
  const bucket = await createSession({ title: 'Unattributed activity' });
  const target = (await sessionForConversation('repair-target'))!;
  await appendEvent(bucket.id, row('known', 'known', Date.now()));
  prove('known', target);
  const entered = gate(); const release = gate();
  const append = fs.appendFile.bind(fs);
  vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
    if (String(args[0]).includes(target) && String(args[0]).endsWith('events.jsonl')) {
      entered.resolve(); await release.promise;
    }
    return append(...args);
  });
  const repairing = repairDeterministicAttribution();
  try { await entered.promise; await appendEvent(bucket.id, row('arrived', null, Date.now())); }
  finally { release.resolve(); }
  await repairing;
  expect((await calls(bucket.id)).map(event => event.call.callId)).toEqual(['arrived']);
});

it('retains the writable empty bucket while an admitted call is still preparing its result asset', async () => {
  const target = (await sessionForConversation('repair-target'))!;
  await record('known');
  const bucket = (await indexedSessions()).find(session => session.title === 'Unattributed activity')!;
  prove('known', target);
  const entered = gate(); const release = gate();
  const write = fs.writeFile.bind(fs);
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]).includes(bucket.id) && String(args[0]).includes(`${path.sep}assets${path.sep}`)) {
      entered.resolve(); await release.promise;
    }
    return write(...args);
  });
  const pending = record(undefined, 'large result '.repeat(20_000));
  try {
    await entered.promise;
    await repairDeterministicAttribution();
    expect(await getSession(bucket.id)).not.toBeNull();
    expect(await calls(bucket.id)).toEqual([]);
  } finally { release.resolve(); }
  expect(await pending).not.toBeNull();
  expect(await calls(bucket.id)).toHaveLength(1);
});

it('deletes an empty inactive historical bucket inside the queued rewrite', async () => {
  const bucket = await createSession({ title: 'Unattributed activity' });
  const target = (await sessionForConversation('repair-target'))!;
  await appendEvent(bucket.id, row('known', 'known', Date.now()));
  prove('known', target);
  await repairDeterministicAttribution();
  expect(await getSession(bucket.id)).toBeNull();
  expect(await calls(target)).toHaveLength(1);
});

it('caps cached request identities across buckets rather than allowing 50,000 per bucket', async () => {
  const buckets = await Promise.all([0, 1].map(async bucketIndex => {
    const bucket = await createSession({ title: 'Unattributed activity' });
    const rows = Array.from({ length: 25_001 }, (_, i) => ({ ...row(`${bucketIndex}-${i}`, `${bucketIndex}-${i}`, bucket.startedAt), seq: i + 1 }));
    await fs.writeFile(path.join(dir, 'sessions', bucket.id, 'events.jsonl'), rows.map(event => JSON.stringify(event)).join('\n') + '\n');
    return bucket;
  }));
  await flushSessions(); resetSessionStoreForTests();
  await repairDeterministicAttribution();
  const read = vi.spyOn(fs, 'readFile');
  await repairDeterministicAttribution(new Set(['unrelated-new-request']));
  const reread = read.mock.calls.filter(([file]) => buckets.some(bucket => String(file) === path.join(dir, 'sessions', bucket.id, 'events.jsonl')));
  // At least one bucket was evicted to maintain the aggregate bound and is reconstructed.
  expect(reread.length).toBeGreaterThan(0);
});


it('serializes an explicit exact request repair with queued recorder maintenance before either can copy the same execution', async () => {
  const store = await import('../src/main/session/store.js');
  const recorder = await import('../src/main/session/recorder.js');
  const bucket = await createSession({ title: 'Unattributed activity' });
  const target = (await sessionForConversation('repair-target'))!;
  await appendEvent(bucket.id, row('one-exact-execution', 'one-exact-request', Date.now()));
  prove('one-exact-request', target);
  const entered = gate(), release = gate();
  const actualRead = store.readEvents;
  let activeSnapshots = 0, maximumSnapshots = 0;
  const read = vi.spyOn(store, 'readEvents').mockImplementation(async (id, options) => {
    const snapshot = await actualRead(id, options);
    if (id === target && options?.kinds?.includes('tool_call')) {
      activeSnapshots++;
      maximumSnapshots = Math.max(maximumSnapshots, activeSnapshots);
      entered.resolve();
      try { await release.promise; } finally { activeSnapshots--; }
    }
    return snapshot;
  });
  const explicit = repairDeterministicAttribution(new Set(['one-exact-request']));
  try {
    await entered.promise;
    recorder.queueDeterministicAttributionRepair();
    // Hold the first destination snapshot across the incumbent maintenance tick.
    // A second repair must stay queued, never snapshot the same empty target.
    await new Promise(resolve => setTimeout(resolve, 1000));
  } finally { release.resolve(); }
  await explicit;
  await flushRecorder();
  read.mockRestore();
  expect(maximumSnapshots).toBe(1);
  expect((await calls(target)).map(event => event.call.callId)).toEqual(['one-exact-execution']);
  expect(await getSession(bucket.id)).toBeNull();
});

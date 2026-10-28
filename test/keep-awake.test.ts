import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { createKeepAwake, installKeepAwake, keepAwakeState, refreshKeepAwake } from '../src/main/keep-awake.js';
import type { SessionSummary } from '../src/shared/session.js';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../src/main/logger.js', () => ({ logInfo: logs.info, logWarn: logs.warn }));
const NOW = Date.UTC(2026, 9, 13, 20);
const chat = (id: string, activityExpiresAt: number | null, extra: Partial<SessionSummary> = {}) =>
  ({ id, startedAt: NOW - 600_000, endedAt: null, activityExpiresAt, ...extra }) as SessionSummary;
const controllers: Array<ReturnType<typeof createKeepAwake>> = [];
function fixture(sessions = [chat('a', NOW + 30_000)]) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  const state = { enabled: true };
  const read = vi.fn(async () => sessions);
  let next = 1;
  const blocker = { start: vi.fn(() => next++), stop: vi.fn() };
  const awake = createKeepAwake({ sessions: read, enabled: () => state.enabled, blocker });
  controllers.push(awake);
  return { awake, read, blocker, state };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
afterEach(() => {
  for (const awake of controllers.splice(0)) awake.dispose();
  vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks();
});

it('uses custom working evidence, expiry and finished-worker boundaries', () => {
  expect(keepAwakeState([chat('idle', null), chat('b', NOW + 90_000), chat('c', NOW + 30_000)], NOW))
    .toEqual({ awake: true, nextAt: NOW + 30_000 });
  expect(keepAwakeState([chat('idle', null), chat('expired', NOW - 1), chat('ended', NOW + 10_000, { endedAt: NOW - 1 })], NOW))
    .toEqual({ awake: false, nextAt: null });
  expect(keepAwakeState([chat('worker', NOW + 60_000, {
    origin: { kind: 'worker' } as SessionSummary['origin'], lastFinishReportAt: NOW - 10, lastToolCallAt: NOW - 20
  })], NOW).awake).toBe(false);
});

it('does not cap working evidence at the UI session-list boundary', async () => {
  const rows = Array.from({ length: 1500 }, (_, i) => chat(`idle-${i}`, null));
  rows.push(chat('active-beyond-ui-cap', NOW + 30_000));
  const live = fixture(rows);
  await live.awake.refresh();
  expect(live.blocker.start).toHaveBeenCalledTimes(1);
});

it('holds one exact blocker and releases it at the bounded activity deadline', async () => {
  const live = fixture();
  await live.awake.refresh(); await live.awake.refresh();
  expect(live.blocker.start).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_100);
  expect(live.blocker.stop).toHaveBeenCalledWith(1);
  expect(logs.info.mock.calls.flat().join(' ')).toContain('activity deadline');
});

it('releases the old hold when the deadline expires during a hanging activity read', async () => {
  const live = fixture([chat('a', NOW + 5_000)]);
  await live.awake.refresh();
  const read = deferred<SessionSummary[]>(); live.read.mockImplementation(() => read.promise);
  const pending = live.awake.refresh();
  await vi.advanceTimersByTimeAsync(5_100);
  expect(live.blocker.stop).toHaveBeenCalledWith(1);
  read.resolve([]); await pending;
});

it('coalesces overlapping reads and rechecks Off after the read before acquiring a hold', async () => {
  const live = fixture(); const read = deferred<SessionSummary[]>();
  live.read.mockImplementation(() => read.promise);
  const pending = live.awake.refresh();
  for (let i = 0; i < 20; i++) void live.awake.refresh();
  expect(live.read).toHaveBeenCalledTimes(1);
  live.state.enabled = false; void live.awake.refresh();
  read.resolve([chat('a', NOW + 30_000)]); await pending;
  expect(live.blocker.start).not.toHaveBeenCalled();
});

it('releases synchronously when Off is published during a later in-flight read', async () => {
  const live = fixture(); await live.awake.refresh();
  const read = deferred<SessionSummary[]>(); live.read.mockImplementation(() => read.promise);
  const pending = live.awake.refresh(); live.state.enabled = false; void live.awake.refresh();
  expect(live.blocker.stop).toHaveBeenCalledWith(1);
  read.resolve([chat('a', NOW + 30_000)]); await pending;
  expect(live.blocker.start).toHaveBeenCalledTimes(1);
});

it('does not resurrect a hold or timer after shutdown while a read is pending', async () => {
  const live = fixture(); await live.awake.refresh();
  const read = deferred<SessionSummary[]>(); live.read.mockImplementation(() => read.promise);
  const pending = live.awake.refresh(); live.awake.dispose(); live.awake.dispose();
  read.resolve([chat('a', NOW + 30_000)]); await pending;
  await live.awake.refresh();
  expect(live.blocker.start).toHaveBeenCalledTimes(1);
  expect(live.blocker.stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('releases on an activity-read failure and logs only a bounded actionable cause', async () => {
  const live = fixture(); await live.awake.refresh();
  live.read.mockRejectedValueOnce(new Error('private activity contents'));
  await live.awake.refresh();
  expect(live.blocker.stop).toHaveBeenCalledWith(1);
  expect(logs.warn.mock.calls.flat().join(' ')).toContain('session activity read failed');
  expect(logs.warn.mock.calls.flat().join(' ')).not.toContain('private activity contents');
});

it('bounds a hanging read and ignores its late result without starting parallel reads', async () => {
  const live = fixture(); await live.awake.refresh();
  const read = deferred<SessionSummary[]>(); live.read.mockImplementation(() => read.promise);
  const pending = live.awake.refresh();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(live.blocker.stop).toHaveBeenCalledWith(1);
  expect(logs.warn.mock.calls.flat().join(' ')).toContain('activity read deadline');
  expect(live.read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(live.read).toHaveBeenCalledTimes(2); // A stuck reader fails closed, without replacement reads.
  expect(live.blocker.start).toHaveBeenCalledTimes(1);
  read.resolve([chat('a', NOW + 30_000)]); await pending;
  expect(live.blocker.start).toHaveBeenCalledTimes(1);
});

it('keeps profile controllers independent and releases each exact blocker id', async () => {
  const first = fixture(), second = fixture();
  await first.awake.refresh(); await second.awake.refresh();
  first.state.enabled = false; await first.awake.refresh();
  expect(first.blocker.stop).toHaveBeenCalledWith(1);
  expect(second.blocker.stop).not.toHaveBeenCalled();
  second.awake.dispose(); expect(second.blocker.stop).toHaveBeenCalledWith(1);
});

it('retains the exact failed native stop id for retry instead of acquiring a second hold', async () => {
  const live = fixture(); await live.awake.refresh();
  live.blocker.stop.mockImplementationOnce(() => { throw new Error('native stop failed'); });
  live.state.enabled = false; await live.awake.refresh();
  expect(logs.warn).toHaveBeenCalled();
  live.state.enabled = true; await live.awake.refresh();
  expect(live.blocker.start).toHaveBeenCalledTimes(1);
  live.awake.dispose();
  expect(live.blocker.stop.mock.calls).toEqual([[1], [1]]);
});

it('bounds an infinite activity deadline even if the periodic renewal read hangs', async () => {
  const live = fixture([chat('exact-tool', Infinity)]);
  await live.awake.refresh();
  const read = deferred<SessionSummary[]>(); live.read.mockImplementation(() => read.promise);
  await vi.advanceTimersByTimeAsync(60_100);
  expect(live.blocker.stop).toHaveBeenCalledWith(1);
  expect(live.blocker.start).toHaveBeenCalledTimes(1);
  read.resolve([]);
});

it('uninstalls the process-local settings owner on shutdown and cannot enable it again', async () => {
  const live = fixture(); const uninstall = installKeepAwake(live.awake);
  await live.awake.refresh(); uninstall(); refreshKeepAwake();
  expect(live.blocker.stop).toHaveBeenCalledTimes(1);
  expect(live.blocker.start).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('uses the uncapped catalog and normal before-quit disposal in the startup owner', async () => {
  const text = await fs.readFile('src/main/index.ts', 'utf8');
  expect(text).toMatch(/indexedSessions\(\).*sessionActivityExpiresAt/s);
  const quit = text.slice(text.indexOf("app.on('before-quit'"), text.indexOf("app.on('window-all-closed'"));
  expect(quit).toContain('stopKeepAwake?.()');
  expect(quit).toContain('stopKeepAwake = null');
  expect(text).toContain("powerSaveBlocker.start('prevent-app-suspension')");
  expect(text).not.toContain("powerSaveBlocker.start('prevent-display-sleep')");
});

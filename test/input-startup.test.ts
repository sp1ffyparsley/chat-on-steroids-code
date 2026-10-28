import { beforeEach, expect, it, vi } from 'vitest';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';
const ports = vi.hoisted(() => ({ backgroundChats: false, running: false as boolean | null, connect: vi.fn(), status: { state: 'connected', detail: '' },
  browser: { connected: false, present: false, lastSeenAt: null as number | null }, open: vi.fn(), bridge: vi.fn(), exactOpen: vi.fn(), wake: vi.fn(), enqueue: vi.fn(), cancel: vi.fn(), note: vi.fn(), rearm: vi.fn(), list: vi.fn(), warn: vi.fn(), rows: [] as InputEntry[], listeners: new Set<() => void>(), inputListeners: new Set<() => void>() }));
vi.mock('../src/main/connection.js', () => ({ connect: ports.connect, getStatus: () => ports.status, onStatusChange: (fn: () => void) => { ports.listeners.add(fn); return () => ports.listeners.delete(fn); } }));
vi.mock('../src/main/bridge.js', () => ({
  bridgeStatus: async () => ports.browser,
  browserDispatchAllowed: () => true,
  browserWakeConnected: () => ports.browser.connected,
  startBridge: ports.bridge,
  requestBrowserConversationOpen: ports.exactOpen
}));
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: ports.wake }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: ports.open, isPreferredBrowserRunning: async () => ports.running }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { backgroundChats: ports.backgroundChats } }) }));
vi.mock('../src/main/logger.js', () => ({ logWarn: ports.warn }));
vi.mock('../src/main/session/input.js', () => ({
  enqueueInput: ports.enqueue,
  cancelInput: ports.cancel,
  noteInputStartupError: ports.note,
  rearmQueuedBrowserInput: (id: string, requireAttentionFence?: boolean, operatorReceipt?: string) =>
    ports.rearm(id, requireAttentionFence, operatorReceipt),
  listInputs: () => ports.list(),
  onInputChange: (listener: () => void) => { ports.inputListeners.add(listener); return () => ports.inputListeners.delete(listener); },
  userRequestedInput: (entry: InputEntry) => (entry.requestedMode ?? entry.mode) === 'auto' &&
    !entry.finishOwner && entry.purpose !== 'decision' && entry.attachmentDelivery !== 'tool'
}));
import { sendDesktopInput, cancelDesktopInput, retryQueuedInputBrowser, resetInputStartupForTests, startQueuedWakeRetrySync, stopQueuedWakeRetrySync } from '../src/main/session/start-input.js';
const request: InputArgs = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionId: null, text: 'Please start', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null };
beforeEach(async () => {
  vi.resetAllMocks(); resetInputStartupForTests();
  ports.rows = []; ports.listeners.clear(); ports.backgroundChats = false; ports.running = false;
  ports.status = { state: 'connected', detail: '' }; ports.browser = { connected: false, present: false, lastSeenAt: null };
  ports.bridge.mockResolvedValue(8765); ports.open.mockResolvedValue('chrome.exe');
  ports.exactOpen.mockResolvedValue({ ok: true, message: 'Chrome focused the existing conversation tab.' });
  ports.rearm.mockImplementation(async (id: string, _requireAttentionFence?: boolean, operatorReceipt?: string) => {
    const row = ports.rows.find(entry => entry.id === id);
    if (row?.deliveryAttentionAt !== undefined) {
      row.deliveryAttentionAt = undefined;
      row.operatorRetryReceipt = operatorReceipt;
      row.queuedBehindBrowser = undefined;
      row.error = undefined;
    }
    return row ?? null;
  });
  ports.enqueue.mockImplementation(async (input: InputArgs): Promise<InputEntry> => {
    const row: InputEntry = { ...input, state: 'queued', owner: null, createdAt: 1, conversationId: input.sessionId ? 'exact-conversation' : null };
    ports.rows.push(row); return row;
  });
  ports.list.mockImplementation(async () => ports.rows);
  ports.note.mockImplementation(async (id, error) => { const row = ports.rows.find(entry => entry.id === id); if (row) row.error = error ?? undefined; return row; });
  await startQueuedWakeRetrySync();
});
it('waits for the existing connector readiness event before publishing input', async () => {
  ports.status = { state: 'connecting-tunnel', detail: 'Starting tunnel' };
  const pending = sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.listeners.size).toBe(1));
  expect(ports.enqueue).not.toHaveBeenCalled(); expect(ports.open).not.toHaveBeenCalled();
  ports.status = { state: 'connected', detail: '' };
  for (const listener of ports.listeners) listener();
  await pending;
  expect(ports.enqueue).toHaveBeenCalledTimes(1); expect(ports.listeners.size).toBe(0);
});
it('retries an unclaimed user message with the same durable UUID and stops after browser claim', async () => {
  ports.open.mockRejectedValueOnce(new Error('startup refused'));
  await sendDesktopInput(request);
  expect(ports.rows[0]?.error).toContain('Browser startup failed');
  await Promise.all([retryQueuedInputBrowser(request.id), retryQueuedInputBrowser(request.id)]);
  expect(ports.open).toHaveBeenCalledTimes(2);
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
  expect(ports.rows).toHaveLength(1);
  expect(ports.rows[0]).toMatchObject({ id: request.id, state: 'queued', error: undefined });
  ports.running = true;
  expect(await retryQueuedInputBrowser(request.id)).toMatchObject({ id: request.id, state: 'queued' });
  expect(ports.open).toHaveBeenCalledTimes(2);
  ports.rows[0]!.state = 'browser'; ports.rows[0]!.error = 'Message queued. Browser startup failed: old';
  expect(await retryQueuedInputBrowser(request.id)).toBeNull();
});
it('makes manual retry target the exact existing conversation instead of only rewriting queue state', async () => {
  ports.browser = { connected: true, present: true, lastSeenAt: 10 };
  await sendDesktopInput({ ...request, sessionId: 'session-existing' });
  await retryQueuedInputBrowser(request.id);
  expect(ports.exactOpen).toHaveBeenCalledWith('exact-conversation');
  expect(ports.wake).toHaveBeenCalled();
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
});
it('does not prepare the connector after Chrome claims the row during manual Retry rearm', async () => {
  const row: InputEntry = {
    ...request, state: 'queued', owner: null, createdAt: 1,
    conversationId: 'exact-conversation', deliveryAttentionAt: 2
  };
  ports.rows.push(row);
  ports.rearm.mockImplementationOnce(async () => {
    row.state = 'browser';
    row.owner = 'claimed-page';
    return row;
  });

  expect(await retryQueuedInputBrowser(request.id)).toMatchObject({ state: 'browser', owner: 'claimed-page' });
  expect(ports.connect).not.toHaveBeenCalled();
  expect(ports.bridge).not.toHaveBeenCalled();
  expect(ports.exactOpen).not.toHaveBeenCalled();
  expect(ports.open).not.toHaveBeenCalled();
  expect(ports.wake).not.toHaveBeenCalled();
});
it('requires the exact ownerless attention fence for a headless operator retry', async () => {
  const receipt = '4ccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const attention: InputEntry = {
    ...request, state: 'queued', owner: null, createdAt: 1,
    conversationId: 'exact-conversation', deliveryAttentionAt: 2
  };
  ports.rows = [attention];
  await expect(retryQueuedInputBrowser(request.id, true, receipt)).resolves.toMatchObject({
    id: request.id, state: 'queued', deliveryAttentionAt: undefined,
    operatorRetryReceipt: receipt
  });
  expect(ports.rearm).toHaveBeenCalledWith(request.id, true, receipt);
  expect(ports.exactOpen).toHaveBeenCalledWith('exact-conversation');

  await expect(retryQueuedInputBrowser(request.id, true))
    .rejects.toThrow('requires exactly one operation receipt');

  vi.clearAllMocks();
  const unsafeId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  ports.rows = [{ ...attention, id: unsafeId, deliveryAttentionAt: 3, sendAuthorizedAt: 4 }];
  await expect(retryQueuedInputBrowser(unsafeId, true, receipt)).resolves.toBeNull();
  expect(ports.rearm).not.toHaveBeenCalled();
  expect(ports.connect).not.toHaveBeenCalled();
  expect(ports.bridge).not.toHaveBeenCalled();
  expect(ports.exactOpen).not.toHaveBeenCalled();
  expect(ports.wake).not.toHaveBeenCalled();
});
it('automatically re-wakes a still-unclaimed durable message without cloning or opening tabs', async () => {
  vi.useFakeTimers();
  try {
    ports.browser = { connected: true, present: true, lastSeenAt: 10 };
    await sendDesktopInput({ ...request, sessionId: 'session-existing' });
    expect(ports.wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ports.wake).toHaveBeenCalledTimes(1);
    expect(ports.enqueue).toHaveBeenCalledTimes(1);
    expect(ports.open).not.toHaveBeenCalled();
  } finally {
    resetInputStartupForTests();
    vi.useRealTimers();
  }
});
it('arms the existing bounded wake retries when a parked durable message becomes eligible', async () => {
  vi.useFakeTimers();
  try {
    ports.browser = { connected: true, present: true, lastSeenAt: 10 };
    const parked: InputEntry = {
      ...request,
      sessionId: 'session-existing',
      conversationId: 'exact-conversation',
      mode: 'after-turn',
      requestedMode: 'auto',
      queuedBehindDelivery: true,
      state: 'queued',
      owner: null,
      createdAt: 1
    };
    ports.rows = [parked];
    for (const listener of ports.inputListeners) listener();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ports.wake).not.toHaveBeenCalled();

    parked.mode = 'auto';
    parked.queuedBehindDelivery = undefined;
    for (const listener of ports.inputListeners) listener();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(ports.wake).toHaveBeenCalledTimes(1);
    expect(ports.open).not.toHaveBeenCalled();
    expect(ports.exactOpen).not.toHaveBeenCalled();
    expect(ports.enqueue).not.toHaveBeenCalled();
  } finally {
    resetInputStartupForTests();
    vi.useRealTimers();
  }
});
it('restores bounded wake retries once after durable bootstrap', async () => {
  vi.useFakeTimers();
  try {
    resetInputStartupForTests();
    ports.rows = [{
      ...request,
      sessionId: 'session-existing',
      conversationId: 'exact-conversation',
      state: 'queued',
      owner: null,
      createdAt: 1
    }];

    const firstStart = startQueuedWakeRetrySync();
    const secondStart = startQueuedWakeRetrySync();
    await Promise.all([firstStart, secondStart]);
    expect(ports.inputListeners.size).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ports.wake).toHaveBeenCalledTimes(1);
    expect(ports.open).not.toHaveBeenCalled();
    expect(ports.enqueue).not.toHaveBeenCalled();
  } finally {
    resetInputStartupForTests();
    vi.useRealTimers();
  }
});
it('releases a failed startup latch so an explicit retry can restore the outbox', async () => {
  resetInputStartupForTests();
  const readsBeforeFailure = ports.list.mock.calls.length;
  ports.list.mockRejectedValueOnce(new Error('outbox temporarily unreadable'));

  await expect(startQueuedWakeRetrySync()).rejects.toThrow('outbox temporarily unreadable');
  expect(ports.inputListeners.size).toBe(0);

  ports.rows = [{
    ...request,
    sessionId: 'session-existing',
    conversationId: 'exact-conversation',
    state: 'queued',
    owner: null,
    createdAt: 1
  }];
  await expect(startQueuedWakeRetrySync()).resolves.toBeUndefined();
  expect(ports.inputListeners.size).toBe(1);
  expect(ports.list).toHaveBeenCalledTimes(readsBeforeFailure + 2);
});
it('does not let an old timer read clear the same input retries scheduled by a later start', async () => {
  vi.useFakeTimers();
  try {
    resetInputStartupForTests();
    const row: InputEntry = {
      ...request,
      sessionId: 'session-existing',
      conversationId: 'exact-conversation',
      state: 'queued',
      owner: null,
      createdAt: 1
    };
    ports.rows = [row];
    await startQueuedWakeRetrySync();

    let release!: (rows: InputEntry[]) => void;
    ports.list.mockImplementationOnce(() => new Promise<InputEntry[]>(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    stopQueuedWakeRetrySync();
    expect(ports.inputListeners.size).toBe(0);
    ports.list.mockImplementation(async () => ports.rows);
    await startQueuedWakeRetrySync();
    expect(ports.inputListeners.size).toBe(1);

    release([row]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ports.wake).toHaveBeenCalledTimes(1);
  } finally {
    resetInputStartupForTests();
    vi.useRealTimers();
  }
});
it('logs repeated input-change sync failures once with context', async () => {
  ports.list.mockRejectedValue(new Error('outbox read denied'));

  for (const listener of ports.inputListeners) listener();
  for (const listener of ports.inputListeners) listener();
  await vi.waitFor(() => expect(ports.warn).toHaveBeenCalledTimes(1));
  expect(ports.warn).toHaveBeenCalledWith(expect.stringContaining('input-change sync failed: outbox read denied'));

  for (const listener of ports.inputListeners) listener();
  await Promise.resolve();
  expect(ports.warn).toHaveBeenCalledTimes(1);
});
it('logs repeated bounded timer read failures once with the durable input id', async () => {
  vi.useFakeTimers();
  try {
    resetInputStartupForTests();
    ports.rows = [{
      ...request,
      sessionId: 'session-existing',
      conversationId: 'exact-conversation',
      state: 'queued',
      owner: null,
      createdAt: 1
    }];
    await startQueuedWakeRetrySync();
    ports.list.mockRejectedValue(new Error('outbox read denied'));

    await vi.advanceTimersByTimeAsync(15_000);
    expect(ports.warn).toHaveBeenCalledTimes(1);
    expect(ports.warn).toHaveBeenCalledWith(expect.stringContaining(`timer read for ${request.id} failed: outbox read denied`));
  } finally {
    resetInputStartupForTests();
    vi.useRealTimers();
  }
});
it('connects before publication and opens exactly one marked bootstrap while Chrome starts', async () => {
  let release!: () => void;
  ports.open.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('chrome.exe'); }));
  const first = sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.open).toHaveBeenCalledTimes(1));
  const second = sendDesktopInput({ ...request, id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' });
  await vi.waitFor(() => expect(ports.enqueue).toHaveBeenCalledTimes(2));
  expect(ports.open).toHaveBeenCalledTimes(1); release(); await Promise.all([first, second]);
  const url = new URL(ports.open.mock.calls[0]![0]);
  expect(url.searchParams.get('cos-input')).toBe(request.id);
  expect(ports.connect.mock.invocationCallOrder[0]).toBeLessThan(ports.enqueue.mock.invocationCallOrder[0]!);
});
it('preserves setup failures without queueing or opening a browser', async () => {
  ports.status = { state: 'disconnected', detail: 'Add a folder before connecting.' };
  await expect(sendDesktopInput(request)).rejects.toThrow('Add a folder');
  expect(ports.enqueue).not.toHaveBeenCalled(); expect(ports.open).not.toHaveBeenCalled();
});
it('keeps a failed browser launch queued and opens existing targets by exact identity', async () => {
  ports.open.mockRejectedValueOnce(new Error('Chrome refused startup'));
  expect(await sendDesktopInput({ ...request, sessionId: 'session-existing' })).toMatchObject({ state: 'queued' });
  expect(ports.open).toHaveBeenCalledWith('https://chatgpt.com/c/exact-conversation');
  expect(ports.note).toHaveBeenCalledWith(request.id, expect.stringContaining('Message queued. Browser startup failed'));
  ports.browser = { connected: true, present: true, lastSeenAt: 10 };
  await sendDesktopInput(request); expect(ports.open).toHaveBeenCalledTimes(1);
  ports.browser = { connected: false, present: false, lastSeenAt: 10 };
  await sendDesktopInput(request); expect(ports.open).toHaveBeenCalledTimes(2);
});

it('cancels a first send while waiting for connection without publishing or opening Chrome', async () => {
  ports.status = { state: 'connecting-tunnel', detail: '' };
  const pending = sendDesktopInput(request);
  const rejected = expect(pending).rejects.toThrow('Input cancelled');
  await vi.waitFor(() => expect(ports.listeners.size).toBe(1));
  expect(await cancelDesktopInput(request.id)).toBe(true);
  await rejected;
  expect(ports.listeners.size).toBe(0);
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.open).not.toHaveBeenCalled();
});
it('leaves delivery with the existing browser while its wake transport reconnects', async () => {
  ports.running = true;
  ports.browser = { connected: false, present: true, lastSeenAt: Date.now() };
  await sendDesktopInput(request);
  expect(ports.open).not.toHaveBeenCalled();
  expect(ports.rows[0]).toMatchObject({ state: 'queued', error: undefined });
});
it('preserves background placement for a cold authored send and its explicit retry', async () => {
  ports.backgroundChats = true;
  ports.open.mockRejectedValueOnce(new Error('startup refused'));
  await sendDesktopInput(request);
  await retryQueuedInputBrowser(request.id);
  expect(ports.open).toHaveBeenCalledTimes(2);
  for (const call of ports.open.mock.calls) expect(call[1]).toEqual({ backgroundStartup: true });
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
});
it('cancels an enqueue that commits after the user stopped startup', async () => {
  let commit!: () => void;
  ports.enqueue.mockImplementation(() => new Promise(resolve => { commit = () => resolve({ ...request, state: 'queued' }); }));
  const pending = sendDesktopInput(request);
  const rejected = expect(pending).rejects.toThrow('Input cancelled');
  await vi.waitFor(() => expect(ports.enqueue).toHaveBeenCalled());
  expect(await cancelDesktopInput(request.id)).toBe(true);
  commit(); await rejected;
  expect(ports.cancel).toHaveBeenCalledWith(request.id);
  expect(ports.open).not.toHaveBeenCalled();
});

it.each([true, null])('queues authored input without activating a running or unknown browser (%s)', async state => {
  ports.running = state;
  await sendDesktopInput(request);
  expect(ports.open).not.toHaveBeenCalled();
  expect(ports.rows[0]).toMatchObject({ state: 'queued', error: undefined });
});

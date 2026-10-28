import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const transport = source.slice(source.indexOf('function conversationAdmission('), source.indexOf('function provision('));
const admissionDependencies = ['ownsDocument', 'cleanConversationId', 'unassignedHistoryConversation'].map(name => {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Shipped wake admission dependency is missing: ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');
const wake = source.slice(source.indexOf('let wakeSocket = null;'), source.indexOf('async function applyRequestedBrowserPreferences('));

function harness(status = 200, unavailableSocket = false) {
  const sockets: any[] = [];
  const maintain = vi.fn(async () => {});
  const urgentOpen = vi.fn(async () => {});
  const browserPump = vi.fn(async () => {});
  const createBrowserControl = vi.fn(() => ({ pump: browserPump }));
  class Socket {
    readyState = 0;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; });
    constructor(public url: string) { if (unavailableSocket) throw new Error('WebSocket unavailable'); sockets.push(this); }
  }
  const fetchBounded = vi.fn(async () => ({ ok: status === 200, status, json: async () => ({}) }));
  const context = vm.createContext({ WebSocket: Socket, URL, token: 'paired-secret', disconnected: false, port: 8765,
    connectionEpoch: 0, unassignedHistoryGeneration: null, unassignedHistoryUncertain: false, sealedUnassignedHistory: null,
    // Mirror the real connection tuple and incumbent repair registry read by the extracted transport.
    instanceId: 'fixture-instance', browserId: 'fixture-browser', desktopInputReceiverRepairs: new Map(),
    tabDocuments: {}, tabEpochs: {}, terminalDocuments: {}, retiredDocuments: {},
    discover: async () => ({ port: 8765, compatible: true }), load: async () => {},
    fetchBounded,
    REQUEST_TIMEOUT_MS: 15000, TIMED_OUT: 'timed_out', versionHeaders: () => ({}), maintain,
    // The shipped wake slice owns pumpBrowserControl, so a same-named mock is shadowed.
    // Supply its actual reload/controller dependencies and exercise that wrapper unchanged.
    companionReloadFlight: null, createBrowserControl,
    chrome: { debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } } },
    pumpUrgentOpenConversationRequests: urgentOpen,
    persist: async () => {}, latchAppDisconnect: async () => {} });
  vm.runInContext(`${admissionDependencies}\n${wake}\n${transport}\nglobalThis.callBridge = call;`, context);
  return { sockets, maintain, urgentOpen, browserPump, createBrowserControl, context, fetchBounded,
    call: context.callBridge as (path: string, init?: Record<string, unknown>) => Promise<unknown> };
}

it('reattaches wake transport on the first authenticated HTTP success before an alarm/status pass', async () => {
  const h = harness();
  await h.call('/events');
  expect(h.sockets).toHaveLength(1);
  const socket = h.sockets[0];
  expect(socket.url).toBe('ws://127.0.0.1:8765/wake');
  socket.onopen(); expect(socket.send).toHaveBeenCalledWith('paired-secret');
  socket.onmessage({ data: 'wake' }); expect(h.maintain).toHaveBeenCalledWith(true);
  await vi.waitFor(() => expect(h.browserPump).toHaveBeenCalledTimes(1));
  expect(h.createBrowserControl).toHaveBeenCalledTimes(1);
  socket.onmessage({ data: 'open-conversation' }); expect(h.urgentOpen).toHaveBeenCalledTimes(1);
  await h.call('/events'); expect(h.sockets).toHaveLength(1);
  socket.onclose(); await h.call('/events'); expect(h.sockets).toHaveLength(2);
});

it('keeps the shipped reload admission guard without dropping normal repeated browser-control wakes', async () => {
  const h = harness();
  await h.call('/events');
  const socket = h.sockets[0];
  h.context.companionReloadFlight = Promise.resolve();
  socket.onmessage({ data: 'browser-control' });
  await Promise.resolve();
  expect(h.browserPump).not.toHaveBeenCalled();
  expect(h.createBrowserControl).not.toHaveBeenCalled();

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.browserPump.mockImplementation(async () => { await gate; });
  h.context.companionReloadFlight = null;
  socket.onmessage({ data: 'browser-control' });
  await vi.waitFor(() => expect(h.browserPump).toHaveBeenCalledTimes(1));
  socket.onmessage({ data: 'browser-control' });
  await vi.waitFor(() => expect(h.browserPump).toHaveBeenCalledTimes(2));
  expect(h.createBrowserControl).toHaveBeenCalledTimes(1);
  expect(vm.runInContext('browserControlFlights.size', h.context)).toBe(2);
  release();
  await vi.waitFor(() => expect(vm.runInContext('browserControlFlights.size', h.context)).toBe(0));
});

it('does not treat failed HTTP as proof of a restored wake channel', async () => {
  const h = harness(503);
  await h.call('/events'); expect(h.sockets).toHaveLength(0);
});
it('preserves an HTTP delivery receipt if WebSocket construction fails', async () => {
  expect(await harness(200, true).call('/events')).toMatchObject({ ok: true, status: 200 });
});

it('keeps the shipped archived-conversation admission fence before HTTP or wake reconnection', async () => {
  const h = harness();
  const id = 'abcdefab-2222-3333-4444-555555555555';
  h.context.sealedUnassignedHistory = { history: { journal: [{ conversationId: id.toUpperCase() }], localCloseOutbox: [], tabConversations: {} } };
  expect(await h.call(`/activity?conversationId=${id}`)).toMatchObject({ ok: false, status: 409, error: 'account_history_unassigned' });
  expect(h.fetchBounded).not.toHaveBeenCalled();
  expect(h.sockets).toHaveLength(0);
});

it('keeps the captured admission epoch across discovery before a named HTTP request', async () => {
  const h = harness();
  h.context.discover = async () => { h.context.connectionEpoch++; return { port: 8765, compatible: true }; };
  expect(await h.call('/correlations', { body: JSON.stringify({ conversationId: 'abcdefab-2222-3333-4444-555555555555' }) }))
    .toMatchObject({ ok: false, status: 409, error: 'request_owner_changed' });
  expect(h.fetchBounded).not.toHaveBeenCalled();
  expect(h.sockets).toHaveLength(0);
});

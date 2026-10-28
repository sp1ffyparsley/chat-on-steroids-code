import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { attachBrowserWake, wakeBrowserWork } from '../src/main/browser-wake.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup(auth: (token: string, request: http.IncomingMessage) => Promise<boolean> = async token => token === 'paired') {
  const server = http.createServer();
  const bridge = attachBrowserWake(server, req => req.headers.origin === 'chrome-extension://test', auth);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  cleanup.push(async () => { bridge.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  function client(origin = 'chrome-extension://test') {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/wake`, { origin });
    socket.on('error', () => {});
    return socket;
  }
  return { bridge, client };
}
describe('authenticated wake-only browser transport', () => {
  it('signals current and newly published work without carrying input text', async () => {
    const h = await setup(); const client = h.client(); await once(client, 'open');
    expect(h.bridge.connected()).toBe(false); // an unauthenticated socket is not delivery reachability
    const first = once(client, 'message'); client.send('paired');
    expect(String((await first)[0])).toBe('wake');
    expect(h.bridge.connected()).toBe(true);
    const next = once(client, 'message'); wakeBrowserWork();
    expect(String((await next)[0])).toBe('wake');
    const urgent = once(client, 'message'); wakeBrowserWork('open-conversation');
    expect(String((await urgent)[0])).toBe('open-conversation');
    const disconnected = once(client, 'message');
    const closing = h.bridge.disconnect();
    expect(String((await disconnected)[0])).toBe('disconnect');
    client.send('disconnected');
    await closing;
    expect(h.bridge.connected()).toBe(false);
  });
  it('silently revokes on ordinary lifecycle shutdown without latching a user disconnect', async () => {
    const h = await setup(); const client = h.client(); await once(client, 'open');
    const ready = once(client, 'message'); client.send('paired'); await ready;
    const messages: string[] = [];
    client.on('message', value => messages.push(String(value)));
    const closed = once(client, 'close'); h.bridge.revoke(); await closed;
    expect(messages).not.toContain('disconnect');
  });
  it('isolates a socket send race so one broken wake cannot fail the publisher or starve another socket', async () => {
    const h = await setup();
    const first = h.client(); const second = h.client();
    await Promise.all([once(first, 'open'), once(second, 'open')]);
    const firstReady = once(first, 'message'); const secondReady = once(second, 'message');
    first.send('paired'); second.send('paired');
    await Promise.all([firstReady, secondReady]);

    const originalSend = WebSocket.prototype.send;
    let injected = false;
    const send = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function(this: WebSocket, data: unknown, ...args: unknown[]) {
      if (this !== first && this !== second && String(data) === 'wake' && !injected) {
        injected = true;
        throw new Error('socket closed between readyState and send');
      }
      return Reflect.apply(originalSend as (...params: unknown[]) => unknown, this, [data, ...args]);
    } as never);
    try {
      const healthyWake = once(second, 'message');
      expect(() => wakeBrowserWork()).not.toThrow();
      expect(String((await healthyWake)[0])).toBe('wake');
      expect(injected).toBe(true);
    } finally { send.mockRestore(); }
  });
  it('rejects ordinary web origins before authentication', async () => {
    const h = await setup(); const client = h.client('https://chatgpt.com');
    await new Promise<void>(resolve => client.once('close', () => resolve()));
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });
  it('gives credential authentication the exact extension upgrade request', async () => {
    let authenticatedOrigin: string | null = null;
    const h = await setup(async (token, request) => {
      authenticatedOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : null;
      return token === 'paired';
    });
    const client = h.client(); await once(client, 'open');
    const ready = once(client, 'message'); client.send('paired'); await ready;
    expect(authenticatedOrigin).toBe('chrome-extension://test');
  });
  it('rejects wrong credentials and non-protocol frames', async () => {
    const h = await setup(); const bad = h.client(); await once(bad, 'open');
    const denied = once(bad, 'close'); bad.send('wrong'); await denied;
    const good = h.client(); await once(good, 'open');
    const ready = once(good, 'message'); good.send('paired'); await ready;
    const closed = once(good, 'close'); good.send('send this user message'); await closed;
  });
  it('does not authorize a connection whose credential check finished after revocation', async () => {
    let resolve!: (ok: boolean) => void;
    let entered!: () => void;
    const checking = new Promise<void>(done => { entered = done; });
    const h = await setup(() => { entered(); return new Promise(done => { resolve = done; }); });
    const client = h.client(); await once(client, 'open');
    client.send('paired'); await checking;
    const closed = once(client, 'close'); h.bridge.revoke(); resolve(true); await closed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });
});

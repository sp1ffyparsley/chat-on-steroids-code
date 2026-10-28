/** Wake-only transport. Durable HTTP claims remain the sole delivery authority. */
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { logInfo } from './logger.js';

type BrowserWakeTopic = 'wake' | 'browser-control' | 'open-conversation';

const subscribers = new Set<(topic: BrowserWakeTopic) => void>();
export function wakeBrowserWork(topic: BrowserWakeTopic = 'wake'): void {
  for (const wake of subscribers) {
    try { wake(topic); }
    catch { logInfo(`bridge: browser wake subscriber failed for ${topic}; durable work remains queued`); }
  }
}

export function attachBrowserWake(server: http.Server, allowed: (request: http.IncomingMessage) => boolean,
  authenticate: (token: string, request: http.IncomingMessage) => Promise<boolean>): {
    connected(): boolean;
    disconnect(): Promise<void>;
    revoke(): void;
    dispose(): void;
  } {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 512, perMessageDeflate: false });
  const authorized = new Map<WebSocket, number>();
  const disconnectAcks = new Map<WebSocket, () => void>();
  let epoch = 0;
  const upgrade = (request: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (request.url !== '/wake' || !allowed(request) || sockets.clients.size >= 8) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (client) => {
      const generation = epoch;
      let authenticating = false;
      const deadline = setTimeout(() => client.terminate(), 5000);
      deadline.unref();
      client.on('error', () => client.terminate());
      client.on('close', () => {
        clearTimeout(deadline);
        disconnectAcks.get(client)?.();
        if (authorized.delete(client)) logInfo('bridge: browser wake channel disconnected');
      });
      client.on('message', (bytes, binary) => {
        if (binary) { client.terminate(); return; }
        const message = bytes.toString();
        const disconnected = disconnectAcks.get(client);
        if (disconnected) {
          if (message === 'disconnected') disconnected();
          else client.terminate();
          return;
        }
        if (authorized.has(client)) {
          if (message === 'pong') authorized.set(client, Date.now());
          else client.terminate();
          return;
        }
        if (authenticating) { client.terminate(); return; }
        authenticating = true;
        void authenticate(message, request).then((ok) => {
          if (!ok || epoch !== generation) { client.terminate(); return; }
          if (client.readyState !== WebSocket.OPEN) return;
          clearTimeout(deadline);
          authorized.set(client, Date.now());
          logInfo('bridge: browser wake channel authenticated');
          // Reconnection always reads current work; no lost notification is durable state.
          client.send('wake');
        }).catch(() => client.terminate());
      });
    });
  };
  server.on('upgrade', upgrade);
  const wake = (topic: BrowserWakeTopic) => {
    for (const client of authorized.keys()) {
      try {
        if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1024) client.send(topic);
        else client.terminate();
      } catch {
        logInfo(`bridge: browser wake socket failed during ${topic}; dropping stale socket`);
        try { client.terminate(); } catch { /* already closed */ }
      }
    }
  };
  subscribers.add(wake);
  // Chrome 116+ keeps an extension worker alive with WebSocket activity under 30s.
  // This is a transport heartbeat, not a poll of chats or the outbox.
  const heartbeat = setInterval(() => {
    for (const [client, seen] of authorized) {
      try {
        if (Date.now() - seen > 45000 || client.bufferedAmount >= 1024) client.terminate();
        else if (client.readyState === WebSocket.OPEN) client.send('ping');
      } catch {
        logInfo('bridge: browser wake heartbeat failed; dropping stale socket');
        try { client.terminate(); } catch { /* already closed */ }
      }
    }
  }, 20000);
  heartbeat.unref();
  const revoke = () => {
    epoch++;
    for (const finish of disconnectAcks.values()) finish();
    disconnectAcks.clear();
    for (const client of sockets.clients) client.terminate();
    authorized.clear();
  };
  const disconnect = async () => {
    epoch++;
    const pending = [...sockets.clients].map((client) => new Promise<void>((resolve) => {
      if (!authorized.delete(client) || client.readyState !== WebSocket.OPEN) {
        client.terminate();
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        disconnectAcks.delete(client);
        try { client.terminate(); } catch { /* already closed */ }
        resolve();
      };
      const timeout = setTimeout(finish, 1000);
      timeout.unref?.();
      disconnectAcks.set(client, finish);
      try { client.send('disconnect', (error) => { if (error) finish(); }); }
      catch { finish(); }
    }));
    await Promise.all(pending);
  };
  return { connected: () => [...authorized].some(([client, seen]) => client.readyState === WebSocket.OPEN &&
    client.bufferedAmount < 1024 && Date.now() - seen <= 45000), disconnect, revoke, dispose() {
    subscribers.delete(wake); clearInterval(heartbeat); server.off('upgrade', upgrade); revoke(); sockets.close();
  } };
}

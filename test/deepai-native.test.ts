import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Dynamic URL import keeps the production .mjs executable directly usable without a second build.
const { connectNative, assertFreeModel, NativeClientError } =
  await import(new URL('../scripts/deepai-native.mjs', import.meta.url).href);
const token = 'native-local-fixture-token-01';
const ticket = 'native-local-fixture-ticket-01';
const origin = 'http://127.0.0.1:19081';
const descriptor = { serverVersion: '0.3.36', orchestrationProtocolVersion: 2,
  environmentId: 'fixture-environment', capabilities: { threadStop: true } };
const clients: Array<{ close: () => Promise<unknown> }> = [];
const scopes = ['orchestration:read', 'orchestration:operate'];
type Frame = { _tag: string; id: string; tag: string; payload: unknown; headers: unknown[] };
type FixtureOptions = { autoOpen?: boolean; descriptor?: unknown; auth?: Record<string, unknown> };

function fixture(options: FixtureOptions = {}) {
  const clock = { now: Date.now() };
  const sockets: FixtureSocket[] = [];
  class FixtureSocket extends EventEmitter {
    readyState = 0;
    sent: Frame[] = [];
    terminated = 0;
    writeError = false;
    throwWrite = false;
    constructor(readonly url: URL, readonly options: Record<string, unknown>) {
      super();
      sockets.push(this);
      if (options && settings.autoOpen !== false) queueMicrotask(() => {
        if (this.readyState === 0) { this.readyState = 1; this.emit('open'); }
      });
    }
    send(raw: string, callback?: (error?: Error) => void) {
      if (this.throwWrite) throw new Error(token + ' ' + ticket);
      this.sent.push(JSON.parse(raw));
      callback?.(this.writeError ? new Error(token + ' ' + ticket) : undefined);
    }
    reply(id: string, value: unknown) {
      this.emit('message', Buffer.from(JSON.stringify({ _tag: 'Exit', requestId: id,
        exit: { _tag: 'Success', value } })));
    }
    terminate() {
      this.terminated++;
      this.readyState = 3;
      this.emit('close');
    }
  }
  const settings = options;
  const issued = { sessionId: 'fixture-session-01', token, method: 'cli', scopes,
    expiresAt: new Date(clock.now + 3600000).toISOString(), ...options.auth };
  const command = vi.fn(async (args: string[]) => args[2] === 'issue' ? JSON.stringify(issued) : '{}');
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' }
  });
  const external = { handler: async (_url: URL, _init: RequestInit): Promise<Response> => response({ ok: true }) };
  const fetch = vi.fn(async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === '/.well-known/t3/environment') return response(options.descriptor ?? descriptor);
    if (url.pathname === '/api/auth/websocket-ticket') return response({ ticket });
    return external.handler(url, init);
  });
  const dependencies = { readRuntime: () => ({ origin }), nativeCommand: command, fetch,
    WebSocket: FixtureSocket, now: () => clock.now };
  return { clock, sockets, command, fetch, dependencies, external, response,
    async connect(websocket = true) {
      const client = await connectNative({ websocket }, dependencies);
      clients.push(client);
      return client;
    } };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  vi.useRealTimers();
});

function freeConfig() {
  return { providers: [{ instanceId: 'deepai', driver: 'pi', enabled: true, installed: true, status: 'ready',
    models: [{ slug: 'deepai/glm-5.3-flash', subProvider: 'deepai', isCustom: false, theosPerRequest: '0' as string | number,
      capabilities: { optionDescriptors: [{ id: 'thinking', type: 'select',
        options: ['off', 'minimal', 'low', 'medium', 'high'].map(id => ({ id })) }] } }] }] };
}

describe('DeepAI exact free native model', () => {
  it.each([0, '0'])('selects the verified catalog model for %s Theos with high thinking', cost => {
    const config = freeConfig();
    config.providers[0]!.models[0]!.theosPerRequest = cost;
    expect(assertFreeModel(config)).toEqual({ instanceId: 'deepai',
      model: 'deepai/glm-5.3-flash', options: { thinking: 'high' } });
  });
  it.each([
    ['paid', (c: ReturnType<typeof freeConfig>) => { c.providers[0]!.models[0]!.theosPerRequest = '1'; }],
    ['missing price', (c: ReturnType<typeof freeConfig>) => { delete (c.providers[0]!.models[0] as Record<string, unknown>).theosPerRequest; }],
    ['disabled', (c: ReturnType<typeof freeConfig>) => { c.providers[0]!.enabled = false; }],
    ['not ready', (c: ReturnType<typeof freeConfig>) => { c.providers[0]!.status = 'error'; }],
    ['not installed', (c: ReturnType<typeof freeConfig>) => { c.providers[0]!.installed = false; }],
    ['wrong exact model', (c: ReturnType<typeof freeConfig>) => { c.providers[0]!.models[0]!.slug += '-other'; }],
    ['custom model', (c: ReturnType<typeof freeConfig>) => { c.providers[0]!.models[0]!.isCustom = true; }],
    ['wrong subprovider', (c: ReturnType<typeof freeConfig>) => { c.providers[0]!.models[0]!.subProvider = 'other'; }],
    ['missing high', (c: ReturnType<typeof freeConfig>) => { c.providers[0]!.models[0]!.capabilities.optionDescriptors[0]!.options.pop(); }],
    ['duplicate catalog', (c: ReturnType<typeof freeConfig>) => { c.providers[0]!.models.push(c.providers[0]!.models[0]!); }],
    ['duplicate provider', (c: ReturnType<typeof freeConfig>) => { c.providers.push(c.providers[0]!); }]
  ])('rejects %s without a fallback', (_name, mutate) => {
    const config = freeConfig(); mutate(config);
    expect(() => assertFreeModel(config)).toThrow(NativeClientError);
    expect(() => assertFreeModel(config)).toThrow('No fallback');
  });
  it('rejects a caller substitution and malformed configuration, including false or empty prices', () => {
    expect(() => assertFreeModel(freeConfig(), 'other/glm-5.3-flash')).toThrow('No fallback');
    for (const bad of [null, {}, { providers: false }]) expect(() => assertFreeModel(bad)).toThrow('No fallback');
    for (const cost of [false, null, '', '0.0', 'unlimited']) {
      const config = freeConfig();
      (config.providers[0]!.models[0] as Record<string, unknown>).theosPerRequest = cost;
      expect(() => assertFreeModel(config)).toThrow('No fallback');
    }
  });
});

describe('DeepAI paired transport', () => {
  it('uses scoped one-hour credentials, exposes expiration only, and revokes exactly once', async () => {
    const f = fixture();
    const client = await f.connect();
    expect(f.command.mock.calls[0]![0]).toEqual(['auth', 'session', 'issue', '--scope', scopes[0],
      '--scope', scopes[1], '--ttl', '1h', '--label', 'CoS DeepAI native integration', '--json']);
    expect(client.credentialMetadata.expiresAtMs).toBe(f.clock.now + 3600000);
    expect(client.credentialMetadata.expiresAt).toBe(new Date(f.clock.now + 3600000).toISOString());
    expect(JSON.stringify(client.credentialMetadata)).not.toContain(token);
    expect(JSON.stringify(client.credentialMetadata)).not.toContain('fixture-session-01');
    const authHeaders = new Headers(f.fetch.mock.calls[1]![1].headers);
    expect(authHeaders.get('authorization')).toBe('Bearer ' + token);
    expect(authHeaders.get('x-t3-orchestration-protocol')).toBe('2');
    expect(f.sockets[0]!.url.searchParams.get('wsTicket')).toBe(ticket);
    expect(f.sockets[0]!.url.searchParams.get('orchestrationProtocol')).toBe('2');
    expect(f.sockets[0]!.options.followRedirects).toBe(false);
    expect(await Promise.all([client.close(), client.close()])).toEqual([
      { credentialRevoked: true }, { credentialRevoked: true }]);
    expect(f.command.mock.calls.filter(([args]) => args[2] === 'revoke')).toEqual([
      [['auth', 'session', 'revoke', 'fixture-session-01']]]);
    expect(f.sockets[0]!.listenerCount('message')).toBe(0);
  });

  it('accepts the reviewed 0.3.37 protocol-2 transport with the same scoped credentials', async () => {
    const f = fixture({ descriptor: { ...descriptor, serverVersion: '0.3.37' } });
    const client = await f.connect();
    expect(client.descriptor.serverVersion).toBe('0.3.37');
    expect(f.command.mock.calls[0]![0]).toEqual(['auth', 'session', 'issue', '--scope', scopes[0],
      '--scope', scopes[1], '--ttl', '1h', '--label', 'CoS DeepAI native integration', '--json']);
    const probe = client.rpc('server.probe', {});
    const request = f.sockets[0]!.sent.at(-1)!;
    f.sockets[0]!.reply(request.id, { ok: true });
    await expect(probe).resolves.toEqual({ ok: true });
  });

  it.each([{ serverVersion: '0.3.38', orchestrationProtocolVersion: 2 },
    { serverVersion: '0.3.37', orchestrationProtocolVersion: 1 },
    { serverVersion: '0.3.37', orchestrationProtocolVersion: 3 },
    { serverVersion: '0.3.36', orchestrationProtocolVersion: 1 }])(
    'rejects unsupported descriptor %j before issuing credentials', async bad => {
      const f = fixture({ descriptor: bad });
      await expect(f.connect()).rejects.toMatchObject({ code: 'NATIVE_VERSION_UNSUPPORTED', acceptance: 'not_sent' });
      expect(f.command).not.toHaveBeenCalled();
    });

  it('refuses non-loopback discovery before any network or credential operation', async () => {
    const f = fixture();
    for (const value of ['https://127.0.0.1:19081', 'http://example.invalid:19081',
      'http://127.0.0.1:19081/?token=fixture', 'http://user:pass@127.0.0.1:19081']) {
      await expect(connectNative({}, { ...f.dependencies, readRuntime: () => ({ origin: value }) }))
        .rejects.toMatchObject({ code: 'NATIVE_LOOPBACK_REQUIRED', acceptance: 'not_sent' });
    }
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.command).not.toHaveBeenCalled();
  });

  it('correlates concurrent replies out of order, ignores unrelated and duplicate exits, and answers Ping', async () => {
    const f = fixture(); const client = await f.connect(); const socket = f.sockets[0]!;
    const first = client.rpc('orchestration.launchThread', { commandId: 'first' });
    const second = client.rpc('orchestration.getThreadProjection', { threadId: 'second' });
    expect(socket.sent[0]).toMatchObject({ _tag: 'Request', tag: 'orchestration.launchThread',
      payload: { commandId: 'first' }, headers: [] });
    socket.reply('foreign-request-id', { wrong: true });
    socket.reply(socket.sent[1]!.id, { threadId: 'second' });
    await expect(second).resolves.toEqual({ threadId: 'second' });
    socket.reply(socket.sent[1]!.id, { wrong: true });
    socket.emit('message', Buffer.from(JSON.stringify({ _tag: 'Ping' })));
    expect(socket.sent.at(-1)).toEqual({ _tag: 'Pong' });
    socket.reply(socket.sent[0]!.id, { threadId: 'first' });
    await expect(first).resolves.toEqual({ threadId: 'first' });
  });

  it('marks a sent mutation timeout as ambiguous, ignores its late reply, and does not replay', async () => {
    vi.useFakeTimers();
    const f = fixture(); const client = await f.connect(); const socket = f.sockets[0]!;
    const request = client.rpc('orchestration.dispatchCommand', { commandId: 'durable-command-1' }, 30);
    const outcome = expect(request).rejects.toMatchObject({
      code: 'NATIVE_RPC_TIMEOUT', acceptance: 'unknown', ambiguous: true
    });
    const id = socket.sent[0]!.id;
    await vi.advanceTimersByTimeAsync(31);
    await outcome;
    socket.reply(id, { accepted: true });
    expect(socket.sent).toHaveLength(1);
    const read = client.rpc('orchestration.getThreadProjection', { threadId: 'existing-thread' });
    socket.reply(socket.sent[1]!.id, { completed: true });
    await expect(read).resolves.toEqual({ completed: true });
    await client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies archived-shell reads as read-only and malformed requests as never sent', async () => {
    vi.useFakeTimers();
    const f = fixture(); const client = await f.connect(); const socket = f.sockets[0]!;
    const read = client.rpc('orchestration.getArchivedShellSnapshot', {}, 5);
    const outcome = expect(read).rejects.toMatchObject({ acceptance: 'not_applicable', ambiguous: false });
    await vi.advanceTimersByTimeAsync(6); await outcome;
    await expect(client.rpc('orchestration.launchThread', {}, 0)).rejects.toMatchObject({ acceptance: 'not_sent' });
    await expect(client.rpc(token, {})).rejects.toMatchObject({ acceptance: 'not_sent' });
    expect(socket.sent).toHaveLength(1);
  });

  it.each(['callback', 'throw'])('never retries a %s write failure or leaks its error text', async kind => {
    const f = fixture(); const client = await f.connect(); const socket = f.sockets[0]!;
    socket.writeError = kind === 'callback'; socket.throwWrite = kind === 'throw';
    const error = await client.rpc('orchestration.launchThread', {}).catch((error: Error) => error);
    expect(error).toMatchObject({ code: 'NATIVE_RPC_WRITE_FAILED', acceptance: 'unknown', ambiguous: true });
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(ticket);
    expect(socket.sent.length).toBeLessThanOrEqual(1);
  });

  it('settles every pending request on socket failure, cancels timers, and retains an error guard', async () => {
    vi.useFakeTimers();
    const f = fixture(); const client = await f.connect(); const socket = f.sockets[0]!;
    const writes = client.rpc('orchestration.launchThread', {});
    const reads = client.rpc('server.getConfig', {});
    const writeOutcome = expect(writes).rejects.toMatchObject({ acceptance: 'unknown' });
    const readOutcome = expect(reads).rejects.toMatchObject({ acceptance: 'not_applicable' });
    socket.emit('error', new Error(token + ' ' + ticket));
    await Promise.all([writeOutcome, readOutcome]);
    expect(socket.terminated).toBe(1);
    expect(socket.listenerCount('message')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => socket.emit('error', new Error(token))).not.toThrow();
    await expect(client.rpc('server.probe', {})).rejects.toMatchObject({ acceptance: 'not_sent' });
  });

  it('rejects an explicit close immediately and does not mistake close for native cancellation', async () => {
    const f = fixture(); const client = await f.connect(); const socket = f.sockets[0]!;
    const pending = client.rpc('orchestration.launchThread', {});
    const outcome = expect(pending).rejects.toMatchObject({ code: 'NATIVE_CLIENT_CLOSED', acceptance: 'unknown' });
    await client.close(); await outcome;
    await expect(client.rpc('server.probe', {})).rejects.toMatchObject({ acceptance: 'not_sent' });
    expect(socket.sent.map(frame => frame.tag)).toEqual(['orchestration.launchThread']);
  });

  it('cleans up a failed handshake and revokes its credential without reporting the ticket', async () => {
    vi.useFakeTimers();
    const f = fixture({ autoOpen: false });
    const connection = f.connect();
    const outcome = expect(connection).rejects.toMatchObject({ code: 'NATIVE_SOCKET_OPEN_FAILED', acceptance: 'not_sent' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000); await outcome;
    expect(f.sockets[0]!.terminated).toBe(1);
    expect(f.sockets[0]!.listenerCount('open')).toBe(0);
    expect(f.command.mock.calls.at(-1)![0]).toEqual(['auth', 'session', 'revoke', 'fixture-session-01']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('redacts credential echoes and does not expose a remote failure cause', async () => {
    const f = fixture(); const client = await f.connect(); const socket = f.sockets[0]!;
    const read = client.rpc('server.getConfig', {});
    socket.reply(socket.sent[0]!.id, { nested: [token, 'url?wsTicket=' + ticket] });
    await expect(read).resolves.toEqual({ nested: ['[redacted]', 'url?wsTicket=[redacted]'] });
    const write = client.rpc('orchestration.launchThread', {});
    socket.emit('message', Buffer.from(JSON.stringify({ _tag: 'Exit', requestId: socket.sent[1]!.id,
      exit: { _tag: 'Failure', cause: { message: token, nested: ticket } } })));
    const error = await write.catch((error: Error) => error);
    expect(error).toMatchObject({ code: 'NATIVE_RPC_FAILED', acceptance: 'unknown' });
    expect(String(error) + JSON.stringify(error)).not.toContain(token);
    expect(String(error) + JSON.stringify(error)).not.toContain(ticket);
  });

  it('fails pending work on malformed protocol instead of leaving it waiting', async () => {
    const f = fixture(); const client = await f.connect(); const socket = f.sockets[0]!;
    const write = client.rpc('orchestration.launchThread', {});
    const outcome = expect(write).rejects.toMatchObject({ code: 'NATIVE_PROTOCOL_ERROR', acceptance: 'unknown' });
    socket.emit('message', Buffer.from('invalid ' + token)); await outcome;
    expect(socket.terminated).toBe(1);
  });

  it('does not send authenticated HTTP outside its immutable loopback origin or accept auth overrides', async () => {
    const f = fixture(); const client = await f.connect(false);
    const before = f.fetch.mock.calls.length;
    for (const route of ['https://example.invalid/api/x', '//example.invalid/api/x',
      'http://127.0.0.1:19082/api/x', '/\\example.invalid/api/x', '/api/x#fragment']) {
      await expect(client.http(route)).rejects.toMatchObject({ code: 'NATIVE_LOOPBACK_REQUIRED', acceptance: 'not_sent' });
    }
    for (const name of ['Authorization', 'x-t3-orchestration-protocol', 'Host', 'Cookie']) {
      await expect(client.http('/api/orchestration/shell', { headers: { [name]: 'override' } }))
        .rejects.toMatchObject({ code: 'NATIVE_REQUEST_INVALID', acceptance: 'not_sent' });
    }
    expect(f.fetch.mock.calls).toHaveLength(before);
    client.origin.hostname = 'example.invalid';
    await client.http('/api/orchestration/shell');
    const [url, init] = f.fetch.mock.calls.at(-1)!;
    expect(url.origin).toBe(origin);
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
  });

  it('bounds HTTP waits and redacts failures, including disconnecting an in-flight request', async () => {
    const f = fixture(); const client = await f.connect(false);
    f.external.handler = (_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error(token)), { once: true });
    });
    const pending = client.http('/api/orchestration/shell');
    const outcome = expect(pending).rejects.toMatchObject({ code: 'NATIVE_HTTP_FAILED', acceptance: 'not_applicable' });
    await client.close(); await outcome;
    const calls = f.fetch.mock.calls.length;
    await expect(client.http('/api/orchestration/shell')).rejects.toMatchObject({ code: 'NATIVE_CLIENT_CLOSED', acceptance: 'not_sent' });
    expect(f.fetch.mock.calls).toHaveLength(calls);
  });

  it('rejects expired credentials before new requests and leaves renewal to the caller', async () => {
    const f = fixture(); const client = await f.connect(); const socket = f.sockets[0]!;
    f.clock.now = client.credentialMetadata.expiresAtMs;
    await expect(client.rpc('server.probe', {})).rejects.toMatchObject({ code: 'NATIVE_CREDENTIAL_EXPIRED', acceptance: 'not_sent' });
    await expect(client.http('/api/orchestration/shell')).rejects.toMatchObject({ code: 'NATIVE_CREDENTIAL_EXPIRED', acceptance: 'not_sent' });
    expect(socket.sent).toHaveLength(0);
    expect(f.command).toHaveBeenCalledTimes(1);
  });

  it('revokes malformed credentials and preserves a bounded lifetime when revoke fails', async () => {
    const bad = fixture({ auth: { expiresAt: 'never', scopes: ['admin'] } });
    await expect(bad.connect()).rejects.toMatchObject({ code: 'NATIVE_AUTH_INVALID' });
    expect(bad.command.mock.calls.at(-1)![0]).toEqual(['auth', 'session', 'revoke', 'fixture-session-01']);
    const f = fixture(); const client = await f.connect();
    f.command.mockRejectedValueOnce(new Error(token));
    expect(await client.close()).toEqual({ credentialRevoked: false });
    expect(await client.close()).toEqual({ credentialRevoked: false });
    expect(f.command).toHaveBeenCalledTimes(2);
  });
});

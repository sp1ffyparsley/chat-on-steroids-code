import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../extension/usage.js', import.meta.url), 'utf8');
function harness(nativeFetch?: (...args: any[]) => Promise<unknown>) {
  const posts: Array<Record<string, any>> = [];
  let now = Date.parse('2026-09-05T12:00:00Z');
  class Clock extends Date { static override now() { return now; } }
  let response: unknown;
  let nextBodyGate: Promise<void> | null = null;
  const timers = new Map<number, { at: number; run: () => void }>();
  let timerId = 0;
  const listeners = new Map<string, Array<{ handler: (event: unknown) => void; once: boolean }>>();
  const document = { readyState: 'loading' };
  class Socket {
    static OPEN = 1;
    handlers: Array<(event: { data: string }) => void> = [];
    constructor(readonly url: string) {}
    addEventListener(type: string, listener: (event: { data: string }) => void) { if (type === 'message') this.handlers.push(listener); }
    removeEventListener(type: string, listener: (event: { data: string }) => void) {
      if (type === 'message') this.handlers = this.handlers.filter(handler => handler !== listener);
    }
    receive(data: unknown) { for (const listener of this.handlers) listener({ data: JSON.stringify(data) }); }
  }
  const window: any = {
    WebSocket: Socket,
    fetch: nativeFetch ?? ((..._args: unknown[]) => Promise.resolve(response)),
    postMessage: (data: unknown) => posts.push(JSON.parse(JSON.stringify(data))),
    addEventListener: (type: string, handler: (event: unknown) => void, options?: { once?: boolean }) => {
      const rows = listeners.get(type) ?? [];
      rows.push({ handler, once: options?.once === true });
      listeners.set(type, rows);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter(row => row.handler !== handler));
    }
  };
  const dispatch = (type: string, event: unknown) => {
    const rows = listeners.get(type) ?? [];
    listeners.set(type, rows.filter(row => !row.once));
    for (const row of rows) row.handler(event);
  };
  window.dispatchEvent = (event: { type: string }) => { dispatch(event.type, event); return true; };
  window.addEventListener('message', (event: any) => {
    if (event.data?.type === 'cos-deletion-request') posts.push(JSON.parse(JSON.stringify(event.data)));
  });
  class MessageEvent { constructor(readonly type: string, init: Record<string, unknown>) { Object.assign(this, init); } }
  const location = { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/', hash: '', pathname: '/' };
  const evaluate = (source = script) => runInNewContext(source, { window, document,
    location, URL, URLSearchParams, Request,
    sessionStorage: { getItem: () => null, setItem: () => undefined }, crypto, Date: Clock, TextDecoder, MessageEvent,
    setTimeout: (run: () => void, ms: number) => { timers.set(++timerId, { at: now + ms, run }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id) });
  evaluate();
  async function feed(data: unknown, url = 'https://chatgpt.com/backend-api/wham/usage', init: Record<string, unknown> = {}, status = 200, requestUrl = '/endpoint') {
    let done: () => void = () => {};
    const inspected = new Promise<void>(resolve => { done = resolve; });
    let read = false;
    const bodyGate = nextBodyGate; nextBodyGate = null;
    const body = new TextEncoder().encode(JSON.stringify(data));
    response = { url, status, ok: status >= 200 && status < 300, headers: { get: () => 'application/json' }, clone: () => ({ body: { getReader: () => ({
      read: async () => { await bodyGate; return read ? { done: true } : (read = true, { done: false, value: body }); },
      cancel: async () => { done(); }
    }) } }) };
    const expectedResponse = response;
    const returned = await window.fetch(requestUrl, { headers: { Authorization: 'private-test-value' }, ...init });
    expect(returned).toBe(expectedResponse);
    if (new URL(url).origin === 'https://chatgpt.com' && /^\/backend-api\/(wham\/usage|conversation\/init|conversation\/prepare|models)$/.test(new URL(url).pathname)) await inspected;
    else await new Promise(resolve => setTimeout(resolve, 0));
  }
  async function feedSse(chunks: string[], init: Record<string, unknown> = { method: 'POST' }, url = 'https://chatgpt.com/backend-api/conversation') {
    let done: () => void = () => {};
    const inspected = new Promise<void>(resolve => { done = resolve; });
    let at = 0;
    response = {
      url,
      ok: true,
      headers: { get: () => 'text/event-stream; charset=utf-8' },
      clone: () => ({ body: { getReader: () => ({
        read: async () => at < chunks.length
          ? { done: false, value: new TextEncoder().encode(chunks[at++]!) }
          : { done: true },
        cancel: async () => { done(); }
      }) } })
    };
    const returned = await window.fetch('/backend-api/conversation', init);
    expect(returned).toBe(response);
    if (String(init.method || 'GET').toUpperCase() === 'POST' && new URL(url).origin === 'https://chatgpt.com' && /^\/backend-api\/(?:conversation|f\/conversation(?:\/resume)?)$/.test(new URL(url).pathname)) await inspected;
    else await new Promise(resolve => setTimeout(resolve, 0));
  }
  return {
    posts,
    route: (id: string | null) => { location.pathname = id ? `/c/${id}` : '/'; location.href = location.origin + location.pathname; },
    nativeSocket: Socket,
    currentSocket: () => window.WebSocket,
    socket: (url = 'wss://ws.chatgpt.com/ws') => new window.WebSocket(url),
    feed,
    feedSse,
    resume: async (status = 404, conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      endpoint = 'https://chatgpt.com/backend-api/f/conversation/resume', method = 'POST', mime = 'application/json') => {
      response = { url: endpoint, status, ok: status === 200, clone: () => { throw new Error('Do not read error bodies'); },
        headers: { get: () => mime } };
      const starts: unknown[] = [];
      const listener = (event: any) => { if (event.data?.type === 'cos-resume-request') starts.push(event.data); };
      window.addEventListener('message', listener);
      const result = window.fetch(endpoint, { method, body: JSON.stringify({ conversation_id: conversationId, private: 'not projected' }) });
      const synchronousStarts = starts.length;
      const returned = await result;
      expect(returned).toBe(response);
      await Promise.resolve();
      window.removeEventListener('message', listener);
      return { starts, synchronousStarts };
    },
    openSse: async (options: { cloneFailure?: boolean; cancelWaits?: boolean } = {}) => {
      let resolve: (value: unknown) => void = () => {};
      let cancelled = false, clones = 0;
      const reader = {
        read: () => new Promise(done => { resolve = done; }),
        cancel: async () => { cancelled = true; if (!options.cancelWaits) resolve({ done: true }); }
      };
      response = { url: 'https://chatgpt.com/backend-api/f/conversation', ok: true,
        headers: { get: () => 'text/event-stream' },
        clone: () => { clones++; if (options.cloneFailure) throw new Error('passive clone unavailable'); return { body: { getReader: () => reader } }; } };
      const returned = await window.fetch('/backend-api/f/conversation', { method: 'POST' });
      return { nativeResponseUnchanged: returned === response, push: (data: unknown) => resolve({ done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`) }),
        get cancelled() { return cancelled; }, get clones() { return clones; } };
    },
    hide: () => dispatch('pagehide', {}),
    replaceFetch: (wrapExisting = false) => {
      const previous = window.fetch;
      const replacement = (...args: unknown[]) => wrapExisting ? previous(...args) : Promise.resolve(response);
      window.fetch = replacement;
      return replacement;
    },
    ready: () => { document.readyState = 'interactive'; dispatch('DOMContentLoaded', {}); },
    currentFetch: () => window.fetch,
    holdNextBody: () => { let release = () => {}; nextBodyGate = new Promise<void>(resolve => { release = resolve; }); return () => release(); },
    advance: (ms: number) => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); } },
    request: (source: unknown = window, origin = 'https://chatgpt.com') => dispatch('message', { source, origin, data: { type: 'cos-usage-request' } }),
    evaluate,
    observer: () => window.__cosUsageObserver,
    askReplace: () => { window.__cosUsageReplace = true; }
  };
}

describe('MAIN-world usage projection', () => {
  it.each(['history', 'send'] as const)('projects only bounded positive deletion for the exact %s request', async kind => {
    const h = harness(), id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    h.route(id);
    const url = `https://chatgpt.com/backend-api/${kind === 'history' ? `conversation/${id}` : 'f/conversation'}`;
    await h.feed({ detail: { code: 'conversation_deleted', conversation_id: id, private: 'never projected' } }, url,
      kind === 'history' ? {} : { method: 'POST', body: JSON.stringify({ conversation_id: id, private: 'never projected' }) }, 404, url);
    const deleted = h.posts.filter(row => row.type === 'cos-conversation-deleted');
    expect(deleted).toEqual([expect.objectContaining({ conversationId: id })]);
    expect(h.posts.filter(row => row.type === 'cos-deletion-request')).toEqual([expect.objectContaining({ id: deleted[0]!.id, conversationId: id })]);
    expect(JSON.stringify(deleted)).not.toContain('private');
    h.request();
    expect(h.posts.filter(row => row.type === 'cos-conversation-deleted')).toHaveLength(2);
  });

  it.each(['other-code', '403', '401', '429', 'foreign', 'other-id', 'oversized', 'other-route', 'null-send'])(
    'does not infer deletion from %s', async kind => {
      const h = harness(), id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; h.route(id);
      const url = `${kind === 'foreign' ? 'https://foreign.test' : 'https://chatgpt.com'}/backend-api/conversation/${id}`;
      if (kind === 'other-route') h.route('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      await h.feed({ detail: { code: kind === 'other-code' ? 'conversation_not_found' : 'conversation_deleted',
        conversation_id: kind === 'other-id' ? 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' : id,
        ...(kind === 'oversized' ? { padding: 'x'.repeat(17 * 1024) } : {}) } },
        kind === 'null-send' ? 'https://chatgpt.com/backend-api/f/conversation' : url,
        kind === 'null-send' ? { method: 'POST', body: JSON.stringify({ conversation_id: null }) } : {},
        /^\d+$/.test(kind) ? Number(kind) : 404, kind === 'null-send' ? 'https://chatgpt.com/backend-api/f/conversation' : url);
      expect(h.posts.filter(row => row.type === 'cos-conversation-deleted')).toEqual([]);
    });

  it('does not publish deletion after its bounded body-reader deadline', async () => {
    const h = harness(), id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; h.route(id);
    const release = h.holdNextBody(), url = `https://chatgpt.com/backend-api/conversation/${id}`;
    const feeding = h.feed({ detail: { code: 'conversation_deleted' } }, url, {}, 404, url);
    await Promise.resolve(); await Promise.resolve(); h.advance(10_001); release(); await feeding;
    expect(h.posts.filter(row => row.type === 'cos-conversation-deleted')).toEqual([]);
  });

  it('observes an exact resume 404 without reading its body and captures ownership synchronously', async () => {
    const h = harness();
    const { starts, synchronousStarts } = await h.resume();
    expect(synchronousStarts).toBe(1);
    expect(starts).toEqual([expect.objectContaining({ type: 'cos-resume-request', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })]);
    expect(h.posts.filter(row => row.type === 'cos-resume-response')).toEqual([
      { type: 'cos-resume-response', id: (starts[0] as any).id, conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 404 }
    ]);
    expect(JSON.stringify(starts)).not.toContain('not projected');
  });

  it.each([
    ['foreign endpoint', 'https://elsewhere.example/backend-api/f/conversation/resume', 'POST', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
    ['GET resume', 'https://chatgpt.com/backend-api/f/conversation/resume', 'GET', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
    ['invalid identity', 'https://chatgpt.com/backend-api/f/conversation/resume', 'POST', 'unknown']
  ])('ignores %s', async (_name, endpoint, method, conversationId) => {
    const h = harness();
    expect((await h.resume(404, conversationId, endpoint, method)).synchronousStarts).toBe(0);
    expect(h.posts.filter(row => row.type === 'cos-resume-response')).toEqual([]);
  });

  it('deduplicates a resume response when a provider wrapper delegates through the earlier observer', async () => {
    const h = harness();
    h.replaceFetch(true); h.ready();
    await h.resume();
    expect(h.posts.filter(row => row.type === 'cos-resume-response' && row.status === 404)).toHaveLength(1);
  });

  it.each(['application/json', 'text/event-stream; charset=utf-8'])('projects successful resume headers for %s', async mime => {
    const h = harness();
    await h.resume(200, undefined, undefined, undefined, mime);
    const [response] = h.posts.filter(row => row.type === 'cos-resume-response');
    expect(response?.status).toBe(200);
    expect(response?.streamOpened === true).toBe(mime.startsWith('text/event-stream'));
  });

  it('reads exact identity from the native resume endpoint only', async () => {
    const h = harness(), conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const frame = [`data: {"conversation_id":"${conversationId}","metadata":{"request_id":"wfr_resume"}}\n\n`];
    await h.feedSse(frame, { method: 'POST' }, 'https://chatgpt.com/backend-api/f/conversation/resume');
    expect(h.posts.map(row => row.requestIds)).toEqual([['wfr_resume']]);
    await h.feedSse(frame, { method: 'POST' }, 'https://chatgpt.com/backend-api/other/conversation/resume');
    expect(h.posts).toHaveLength(1);
  });

  it('reads complete root messages with inherited v1 delta headers', async () => {
    const h = harness(), conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const delta = (value: unknown) => `event: delta\ndata: ${JSON.stringify(value)}\n\n`;
    await h.feedSse([
      'event: delta_encoding\ndata: "v1"\n\n',
      delta({ p: '', o: 'add', c: 0, v: { conversation_id: conversationId, message: { metadata: {} } } }),
      delta({ c: 1, v: { conversation_id: conversationId, message: { metadata: { request_id: 'wfr_early_shell' }, content: { parts: ['NEVER_PROJECT_CONTENT'] } } } }),
      delta({ v: { conversation_id: conversationId, message: { metadata: { request_id: 'wfr_next_shell' } } } })
    ]);
    expect(h.posts.map(row => row.requestIds)).toEqual([['wfr_early_shell'], ['wfr_next_shell']]);
    expect(JSON.stringify(h.posts)).not.toContain('NEVER_PROJECT_CONTENT');
  });

  it('reports only provider-owned model and user ids from a native Send request', async () => {
    const h = harness(), messageId = '2bd27eea-290d-444c-bc46-1487f143d603';
    const body = JSON.stringify({ action: 'next', model: 'gpt-5-6-thinking', thinking_effort: 'high',
      messages: [{ id: messageId, author: { role: 'user' }, content: { parts: ['private prompt bytes'] } }] });
    await h.feedSse([], { method: 'POST', body }, 'https://chatgpt.com/backend-api/f/conversation');
    expect(h.posts.filter(row => row.type === 'cos-send-model')).toEqual([
      { type: 'cos-send-model', model: 'gpt-5-6-thinking', messageIds: [messageId], observedAt: expect.any(Number) }
    ]);
    expect(h.posts.filter(row => row.type === 'cos-send-request')).toEqual([
      { type: 'cos-send-request', messageIds: [messageId], observedAt: expect.any(Number) }
    ]);
    expect(JSON.stringify(h.posts)).not.toContain('private prompt bytes');
  });

  it.each([undefined, null])('captures an inherited Request body before native fetch consumes it (init.body=%s)', async bodyOverride => {
    const messageId = '2bd27eea-290d-444c-bc46-1487f143d603';
    const body = JSON.stringify({ model: 'gpt-6-thinking', messages: [{ id: messageId,
      author: { role: 'user' }, content: { parts: ['private Request prompt'] } }] });
    const input = new Request('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body });
    let nativeBody: Promise<string> | undefined;
    const response = { url: 'https://chatgpt.com/other', ok: true };
    const result = Promise.resolve(response);
    const receiver = { nativeReceiver: true };
    let actualReceiver: unknown, actualArgs: unknown[] | undefined;
    const h = harness(function (this: unknown, ...args: any[]) {
      actualReceiver = this; actualArgs = args;
      nativeBody = new Request(args[0], args[1]).text();
      return result;
    });
    const init = { body: bodyOverride };
    expect(h.currentFetch().call(receiver, input, init)).toBe(result);
    expect(actualReceiver).toBe(receiver);
    expect(actualArgs).toEqual([input, init]);
    expect(input.bodyUsed).toBe(true);
    expect(await nativeBody).toBe(body);
    await expect.poll(() => h.posts.filter(row => row.type === 'cos-send-request')).toEqual([
      { type: 'cos-send-request', messageIds: [messageId], observedAt: expect.any(Number) }
    ]);
    expect(JSON.stringify(h.posts)).not.toContain('private Request prompt');
    expect(input.bodyUsed).toBe(true);
  });

  it('uses an explicit string override instead of cloning the inherited Request body', async () => {
    const oldId = '2bd27eea-290d-444c-bc46-1487f143d603', id = '3bd27eea-290d-444c-bc46-1487f143d604';
    const payload = (messageId: string) => JSON.stringify({ messages: [{ id: messageId, author: { role: 'user' } }] });
    const input = new Request('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: payload(oldId) });
    input.clone = () => { throw new Error('An overridden body must never be cloned'); };
    const h = harness(); await h.currentFetch()(input, { body: payload(id) });
    expect(h.posts.filter(row => row.type === 'cos-send-request').map(row => row.messageIds)).toEqual([[id]]);
    expect(input.bodyUsed).toBe(false);
  });

  it.each(['binary override', 'foreign origin', 'wrong endpoint', 'GET override', 'used body', 'locked body', 'clone failure', 'aborted signal'])(
    'does not infer a native Send from %s and preserves the original fetch result', async kind => {
      const id = '2bd27eea-290d-444c-bc46-1487f143d603';
      const body = JSON.stringify({ messages: [{ id, author: { role: 'user' } }] });
      const controller = new AbortController();
      const input = new Request(kind === 'foreign origin' ? 'https://example.com/backend-api/f/conversation' :
        'https://chatgpt.com/backend-api/' + (kind === 'wrong endpoint' ? 'other' : 'f/conversation'),
        { method: 'POST', body, signal: controller.signal });
      let lock: ReadableStreamDefaultReader<Uint8Array> | undefined;
      if (kind === 'used body') await input.text();
      if (kind === 'locked body') lock = input.body!.getReader();
      if (kind === 'clone failure') input.clone = () => { throw new TypeError('clone unavailable'); };
      if (kind === 'aborted signal') controller.abort();
      const response = {}, result = Promise.resolve(response), h = harness(() => result);
      const init = kind === 'binary override' ? { body: new TextEncoder().encode(body) } : kind === 'GET override' ? { method: 'GET' } : undefined;
      expect(h.currentFetch()(input, init)).toBe(result);
      expect(await result).toBe(response);
      await Promise.resolve();
      expect(h.posts.filter(row => row.type === 'cos-send-request')).toEqual([]);
      lock?.releaseLock(); h.observer().dispose();
    });

  it.each(['route', 'pagehide', 'abort', 'timeout', 'later Send', 'dispose'])(
    'does not publish delayed Request evidence after %s retires its capture', async boundary => {
      const id = '2bd27eea-290d-444c-bc46-1487f143d603', next = '3bd27eea-290d-444c-bc46-1487f143d604';
      const body = JSON.stringify({ messages: [{ id, author: { role: 'user' } }] });
      let producer!: ReadableStreamDefaultController<Uint8Array>;
      const signal = new AbortController();
      const input = new Request('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', signal: signal.signal,
        body: new ReadableStream<Uint8Array>({ start(controller) { producer = controller; } }), duplex: 'half' } as RequestInit);
      const result = Promise.resolve({}), h = harness(() => result);
      expect(h.currentFetch()(input)).toBe(result);
      if (boundary === 'route') h.route('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      if (boundary === 'pagehide') h.hide();
      if (boundary === 'abort') signal.abort();
      if (boundary === 'timeout') h.advance(10_001);
      if (boundary === 'dispose') h.observer().dispose();
      if (boundary === 'later Send') await h.currentFetch()('/backend-api/f/conversation', { method: 'POST',
        body: JSON.stringify({ messages: [{ id: next, author: { role: 'user' } }] }) });
      producer.enqueue(new TextEncoder().encode(body)); producer.close();
      expect(await input.text()).toBe(body);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(h.posts.filter(row => row.type === 'cos-send-request').map(row => row.messageIds)).toEqual(boundary === 'later Send' ? [[next]] : []);
      h.observer().dispose();
    });

  it('bounds Request inspection in UTF-8 bytes without consuming the native body', async () => {
    const body = JSON.stringify({ messages: [{ id: '2bd27eea-290d-444c-bc46-1487f143d603',
      author: { role: 'user' }, content: { parts: ['😀'.repeat(510_000)] } }] });
    expect(body.length).toBeLessThan(2_000_000); expect(Buffer.byteLength(body)).toBeGreaterThan(2_000_000);
    const input = new Request('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body });
    const h = harness(); await h.currentFetch()(input);
    expect(await input.text()).toBe(body);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.posts.filter(row => row.type === 'cos-send-request')).toEqual([]); h.observer().dispose();
  });

  it('preserves the native rejection object and never publishes a disposed pending capture', async () => {
    const error = new Error('native failure'), result = Promise.reject(error);
    const input = new Request('https://chatgpt.com/backend-api/f/conversation', { method: 'POST',
      body: JSON.stringify({ messages: [{ id: '2bd27eea-290d-444c-bc46-1487f143d603', author: { role: 'user' } }] }) });
    const h = harness(() => result);
    expect(h.currentFetch()(input)).toBe(result); h.observer().dispose();
    await expect(result).rejects.toBe(error);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.posts.filter(row => row.type === 'cos-send-request')).toEqual([]);
  });

  it.each(['rejected promise', 'synchronous throw'])('keeps a native %s unchanged and cancels only its passive capture', async failure => {
    const error = new Error('original native error');
    const result = failure === 'rejected promise' ? Promise.reject(error) : undefined;
    const input = new Request('https://chatgpt.com/backend-api/f/conversation', { method: 'POST',
      body: JSON.stringify({ messages: [{ id: '2bd27eea-290d-444c-bc46-1487f143d603', author: { role: 'user' } }] }) });
    const h = harness(() => { if (failure === 'synchronous throw') throw error; return result!; });
    if (result) { expect(h.currentFetch()(input)).toBe(result); await expect(result).rejects.toBe(error); }
    else { expect(() => h.currentFetch()(input)).toThrow(error); }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.posts.filter(row => row.type === 'cos-send-request')).toEqual([]);
    expect(input.bodyUsed).toBe(false); h.observer().dispose();
  });

  it('limits pending Request clones and leaves the ninth native request untouched', async () => {
    const h = harness();
    const pending: Array<{ request: Request; producer: ReadableStreamDefaultController<Uint8Array> }> = [];
    let clones = 0;
    for (let index = 0; index < 9; index++) {
      let producer!: ReadableStreamDefaultController<Uint8Array>;
      const request = new Request('https://chatgpt.com/backend-api/f/conversation', { method: 'POST',
        body: new ReadableStream<Uint8Array>({ start(value) { producer = value; } }), duplex: 'half' } as RequestInit);
      const clone = request.clone.bind(request);
      request.clone = () => { clones++; return clone(); };
      pending.push({ request, producer });
      await h.currentFetch()(request);
    }
    expect(clones).toBe(8);
    h.observer().dispose();
    for (const row of pending) row.producer.close();
    await Promise.all(pending.map(row => row.request.text()));
    expect(h.posts.filter(row => row.type === 'cos-send-request')).toEqual([]);
  });

  it('keeps model evidence separate from the exact single-user Send receipt', async () => {
    const h = harness(), first = '2bd27eea-290d-444c-bc46-1487f143d603', second = '3bd27eea-290d-444c-bc46-1487f143d604';
    // A malformed model cannot prove a model, but the provider's one exact user id still proves
    // which question this native request carried.
    await h.feedSse([], { method: 'POST', body: JSON.stringify({ model: 'gpt 6 <b>',
      messages: [{ id: first, author: { role: 'user' } }] }) }, 'https://chatgpt.com/backend-api/f/conversation');
    // More than one user id can describe model usage but is deliberately ambiguous as the
    // receipt for one app-owned Send click.
    await h.feedSse([], { method: 'POST', body: JSON.stringify({ model: 'gpt-5-6-thinking', messages: [
      { id: first, author: { role: 'user' } }, { id: second, author: { role: 'user' } }
    ] }) }, 'https://chatgpt.com/backend-api/f/conversation');
    expect(h.posts.filter(row => row.type === 'cos-send-model')).toHaveLength(1);
    expect(h.posts.filter(row => row.type === 'cos-send-request')).toEqual([
      { type: 'cos-send-request', messageIds: [first], observedAt: expect.any(Number) }
    ]);
  });

  it('keeps inherited socket headers scoped to one exact linked turn', () => {
    const h = harness(), socket = h.socket(), conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const send = (turnId: string, itemId: string, parentId: string | null, encodedItem: string) => socket.receive([
      { type: 'message', payload: { type: 'conversation-turn-stream', payload: {
        type: 'stream-item', conversation_id: conversationId, turn_id: turnId,
        stream_item_id: itemId, parent_stream_item_id: parentId, encoded_item: encodedItem
      } } }
    ]);
    const delta = (value: unknown) => `event: delta\ndata: ${JSON.stringify(value)}\n\n`;
    const value = (requestId: string) => ({ conversation_id: conversationId, message: { metadata: { request_id: requestId } } });
    send('turn-a', 'a0', null, 'event: delta_encoding\ndata: "v1"\n\n');
    send('turn-a', 'a1', 'a0', delta({ v: value('wfr_socket_early') }));
    send('turn-a', 'a1', 'a0', delta({ v: value('wfr_duplicate') }));
    send('turn-b', 'b1', null, delta({ v: value('wfr_foreign_turn') }));
    send('turn-a', 'a3', 'missing', delta({ v: value('wfr_missing_parent') }));
    expect(h.posts.map(row => row.requestIds)).toEqual([['wfr_socket_early']]);
  });

  it('joins a request id that ChatGPT splits from its conversation across two response events', async () => {
    const h = harness();
    const conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const request_id = '11111111-2222-4333-8444-555555555555';
    await h.feedSse([
      `data: ${JSON.stringify({ conversation_id, turn_topic_id: 'topic-1' })}\n\n`,
      `data: ${JSON.stringify({ type: 'input_message', input_message: { metadata: { request_id } } })}\n\n`
    ], { method: 'POST' }, 'https://chatgpt.com/backend-api/f/conversation');
    expect(h.posts).toEqual([{ type: 'cos-request-origin', conversationId: conversation_id,
      requestIds: [request_id], observedAt: expect.any(Number) }]);
  });

  it('refuses a split request join when the same response contradicts its conversation', async () => {
    const h = harness();
    const conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const other = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    await h.feedSse([
      `data: ${JSON.stringify({ conversation_id, turn_topic_id: 'topic-1' })}\n\n`,
      `data: ${JSON.stringify({ conversation_id: other, type: 'input_message',
        input_message: { metadata: { request_id: '11111111-2222-4333-8444-555555555555' } } })}\n\n`
    ], { method: 'POST' }, 'https://chatgpt.com/backend-api/f/conversation');
    expect(h.posts).toEqual([]);
  });

  describe('connector app metadata from the response stream (#1305)', () => {
    const conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const request_id = '11111111-2222-4333-8444-555555555555';
    const sighting = { requestId: request_id, appId: 'asdk_app_6ac261da', linkId: 'link_6ac26253', appName: 'Chat On Steroids Core' };
    const result = (metadata: Record<string, unknown> = {}, author: Record<string, unknown> = { role: 'tool', name: 'api_tool.call_tool' }) => ({
      conversation_id,
      message: { author, content: { parts: ['PRIVATE_RESULT_NEVER_PROJECT /asdk_app_fake/link_fake/exec_command'] },
        metadata: { request_id, invoked_resource: { resource_uri: '/asdk_app_6ac261da/link_6ac26253/exec_command', app_name: 'Chat On Steroids Core' }, ...metadata } }
    });
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const sightings = (posts: Array<Record<string, any>>) => posts.filter(row => row.type === 'cos-app-sighting');

    it('learns first-turn app metadata after the request origin was already emitted, without projecting content', async () => {
      const h = harness();
      await h.feedSse([frame({ conversation_id, input_message: { metadata: { request_id } } }), frame(result())]);
      expect(sightings(h.posts)).toEqual([{ type: 'cos-app-sighting', conversationId: conversation_id, sightings: [sighting] }]);
      expect(h.posts.filter(row => row.type === 'cos-request-origin')).toHaveLength(1);
      expect(JSON.stringify(h.posts)).not.toContain('PRIVATE_RESULT_NEVER_PROJECT');
    });

    it('shares bounded composite app deduplication across SSE and the exact Pro socket, and replays startup metadata', async () => {
      const h = harness(), socket = h.socket();
      const envelope = (value: unknown) => [{ type: 'message', payload: { type: 'conversation-turn-stream', payload: {
        type: 'stream-item', conversation_id, encoded_item: frame(value)
      } } }];
      socket.receive(envelope(result())); socket.receive(envelope(result()));
      await h.feedSse([frame(result())]);
      expect(sightings(h.posts)).toEqual([{ type: 'cos-app-sighting', conversationId: conversation_id, sightings: [sighting] }]);
      socket.receive(envelope(result({ invoked_resource: { resource_uri: '/asdk_app_6ac261da/link_6ac26253/exec_command', app_name: 'Renamed Core' } })));
      expect(sightings(h.posts)).toHaveLength(2);
      h.request();
      expect(sightings(h.posts).at(-1)?.sightings).toEqual([{ ...sighting, appName: 'Renamed Core' }]);
    });

    it.each([
      ['resource outside the app path', result({ invoked_resource: { resource_uri: 'https://example.com/exec_command' } })],
      ['missing exact request id', result({ request_id: undefined })],
      ['malformed exact request id', result({ request_id: 'not-a-request' })],
      ['model-authored text', result({}, { role: 'assistant', name: null })],
      ['a different tool', result({}, { role: 'tool', name: 'other.call_tool' })],
      ['contradictory conversation', { ...result(), conversation_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' }],
      ['partial metadata delta', { p: '/message/metadata', o: 'add', v: result().message.metadata }]
    ])('does not teach app identity from %s', async (_name, value) => {
      const h = harness();
      await h.feedSse([frame({ conversation_id }), frame(value)]);
      expect(sightings(h.posts)).toEqual([]);
    });

    it('accepts a complete inherited delta result but never carries it across a broken socket parent', () => {
      const h = harness(), socket = h.socket();
      const send = (id: string, parent: string | null, encoded_item: string) => socket.receive([{ type: 'message', payload: {
        type: 'conversation-turn-stream', payload: { type: 'stream-item', conversation_id, turn_id: 'app-turn',
          stream_item_id: id, parent_stream_item_id: parent, encoded_item }
      } }]);
      send('root', null, 'event: delta_encoding\ndata: "v1"\n\n');
      send('result', 'root', `event: delta\ndata: ${JSON.stringify({ v: result() })}\n\n`);
      send('broken', 'missing', `event: delta\ndata: ${JSON.stringify({ v: result({ request_id: 'wfr_broken_parent' }) })}\n\n`);
      expect(sightings(h.posts)).toEqual([{ type: 'cos-app-sighting', conversationId: conversation_id, sightings: [sighting] }]);
    });

    it('bounds the reused origin replay window and retires app metadata on page exit', () => {
      const h = harness(), socket = h.socket();
      const send = (id: number) => socket.receive([{ type: 'message', payload: { type: 'conversation-turn-stream', payload: {
        type: 'stream-item', conversation_id, encoded_item: frame(result({ request_id: `wfr_app_${id}` }))
      } } }]);
      for (let id = 0; id < 65; id++) send(id);
      const firstPass = h.posts.length;
      h.request();
      expect(sightings(h.posts.slice(firstPass)).map(row => row.sightings[0].requestId)).toEqual(
        Array.from({ length: 16 }, (_, index) => `wfr_app_${64 - index}`)
      );
      const replayed = h.posts.length;
      send(64); expect(h.posts).toHaveLength(replayed);
      h.hide(); h.request(); expect(h.posts).toHaveLength(replayed);
    });

    it('does not project app metadata from foreign transports and omits unsafe app names', async () => {
      const h = harness();
      await h.feedSse([frame(result())], { method: 'POST' }, 'https://elsewhere.example/backend-api/f/conversation');
      h.socket('wss://chatgpt.com.evil.test/ws').receive([{ type: 'message', payload: { type: 'conversation-turn-stream', payload: {
        type: 'stream-item', conversation_id, encoded_item: frame(result())
      } } }]);
      expect(sightings(h.posts)).toEqual([]);
      await h.feedSse([frame(result({ invoked_resource: { resource_uri: '/asdk_app_6ac261da/link_6ac26253/exec_command', app_name: 'unsafe\nname' } }))]);
      expect(sightings(h.posts)).toEqual([{ type: 'cos-app-sighting', conversationId: conversation_id, sightings: [{ ...sighting, appName: null }] }]);
    });
  });

  it('uses the exact outer socket conversation for a split request event', () => {
    const h = harness(), socket = h.socket();
    const conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const request_id = '11111111-2222-4333-8444-555555555555';
    socket.receive([{ type: 'message', payload: { type: 'conversation-turn-stream', payload: {
      type: 'stream-item', conversation_id, turn_id: 'turn-split',
      stream_item_id: 'split-0', parent_stream_item_id: null,
      encoded_item: `data: ${JSON.stringify({ type: 'input_message', input_message: { metadata: { request_id } } })}\n\n`
    } } }]);
    expect(h.posts).toEqual([{ type: 'cos-request-origin', conversationId: conversation_id,
      requestIds: [request_id], observedAt: expect.any(Number) }]);
  });

  it('observes the Pro socket handoff with exact inner/outer conversation proof and shares HTTP deduplication', async () => {
    const h = harness(), socket = h.socket();
    expect(socket).toBeInstanceOf(h.nativeSocket);
    const conversation_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const frame = `data: ${JSON.stringify({ conversation_id, message: { metadata: { request_id: 'wfr_socket' } } })}\n\n`;
    const envelope = [{ type: 'message', payload: { type: 'conversation-turn-stream', payload: {
      type: 'stream-item', conversation_id, encoded_item: frame
    } } }];
    socket.receive(envelope); socket.receive(envelope);
    expect(h.posts).toHaveLength(1);
    await h.feedSse([frame]);
    expect(h.posts).toHaveLength(1);
    h.request(); expect(h.posts).toHaveLength(2);
  });
  it('rejects foreign sockets, contradictory envelopes and request IDs hidden in model text', () => {
    const h = harness(), socket = h.socket();
    const conversation_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const envelope = (value: unknown, owner = conversation_id) => [{ type: 'message', payload: {
      type: 'conversation-turn-stream', payload: { type: 'stream-item', conversation_id: owner,
        encoded_item: `data: ${JSON.stringify(value)}\n\n` }
    } }];
    const value = { conversation_id, message: { metadata: { request_id: 'wfr_exact' } } };
    h.socket('wss://chatgpt.com.evil.test/ws').receive(envelope(value));
    socket.receive(envelope(value, '11111111-2222-3333-4444-555555555555'));
    socket.receive(envelope({ conversation_id, message: { content: JSON.stringify(value) } }));
    socket.receive(envelope(value).concat(Array(33).fill({})));
    expect(h.posts).toHaveLength(0);
  });
  it('listens beyond five minutes, deduplicates and replays bounded ID evidence, then cancels at fifteen minutes', async () => {
    const h = harness();
    const stream = await h.openSse();
    h.advance(6 * 60_000);
    expect(stream.cancelled).toBe(false);
    const event = { conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', metadata: { request_id: 'wfr_late' } };
    stream.push(event);
    await Promise.resolve(); await Promise.resolve();
    expect(h.posts).toHaveLength(1);
    stream.push(event);
    await Promise.resolve(); await Promise.resolve();
    expect(h.posts).toHaveLength(1);
    h.request();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toEqual(h.posts[0]);
    h.advance(9 * 60_000);
    expect(stream.cancelled).toBe(true);
    h.hide(); h.request();
    expect(h.posts).toHaveLength(2);
  });
  it('keeps the newest request stream when two older passive readers remain open', async () => {
    const h = harness();
    const a = await h.openSse(), b = await h.openSse(), c = await h.openSse();
    expect([a.clones, b.clones, c.clones]).toEqual([1, 1, 1]);
    expect([a.cancelled, b.cancelled, c.cancelled]).toEqual([true, false, false]);
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    c.push({ conversation_id: conversationId, input_message: { metadata: { request_id: 'wfr_current_reader' } } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.posts).toContainEqual({ type: 'cos-request-origin', conversationId,
      requestIds: ['wfr_current_reader'], observedAt: expect.any(Number) });
    h.hide();
    expect(b.cancelled && c.cancelled).toBe(true);
  });
  it('retains both existing stream readers if the newest passive clone fails', async () => {
    const h = harness();
    const a = await h.openSse(), b = await h.openSse();
    const c = await h.openSse({ cloneFailure: true });
    expect(c.nativeResponseUnchanged).toBe(true);
    expect([a.cancelled, b.cancelled, c.cancelled]).toEqual([false, false, false]);
    h.hide(); expect(a.cancelled && b.cancelled).toBe(true);
  });
  it('does not publish a late frame from an evicted stream reader', async () => {
    const h = harness();
    const a = await h.openSse({ cancelWaits: true }), b = await h.openSse(), c = await h.openSse();
    expect(a.cancelled).toBe(true);
    const conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    a.push({ conversation_id, input_message: { metadata: { request_id: 'wfr_evicted_late' } } });
    c.push({ conversation_id, input_message: { metadata: { request_id: 'wfr_current_after_eviction' } } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.posts.flatMap(row => row.requestIds ?? [])).toEqual(['wfr_current_after_eviction']);
    expect(a.nativeResponseUnchanged && b.nativeResponseUnchanged && c.nativeResponseUnchanged).toBe(true);
    h.hide();
  });
  it('republishes retained origins before replacing an older observer version', async () => {
    const h = harness();
    const currentVersion = h.observer().version;
    h.evaluate(script.replace(/const OBSERVER_VERSION = \d+;/, 'const OBSERVER_VERSION = 0;'));
    const conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse(['data: ' + JSON.stringify({ conversation_id,
      input_message: { metadata: { request_id: 'wfr_before_version_upgrade' } } }) + '\n\n']);
    expect(h.posts.filter(row => row.type === 'cos-request-origin')).toHaveLength(1);
    h.evaluate();
    expect(h.observer().version).toBe(currentVersion);
    expect(h.posts.filter(row => row.type === 'cos-request-origin')).toHaveLength(2);
  });
  it('retains supported model counts without requiring a reset timestamp', async () => {
    const h = harness();
    await h.feed({ model_limits: [{ model_slug: 'model-a', remaining: 3 }, { model_slug: 'model-b', remaining: 0, resets_after: 'invalid' }, { model_slug: 'unknown' }] });
    expect(h.posts[0]?.rows).toEqual([
      expect.objectContaining({ model: 'model-a', remaining: 3, resetAt: null }),
      expect.objectContaining({ model: 'model-b', remaining: 0, resetAt: null })
    ]);
  });
  it('rejects an older response completing after a newer recognized snapshot, even within one millisecond', async () => {
    const h = harness();
    const release = h.holdNextBody();
    const old = h.feed({ limits_progress: [{ model_slug: 'old-model', remaining: 3 }] });
    await h.feed({ limits_progress: [] });
    release(); await old;
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.rows).toEqual([]);
    h.request();
    expect(h.posts[1]?.rows).toEqual([]);
  });
  it('preserves invocation time and does not let unrelated newer responses suppress quota evidence', async () => {
    const h = harness();
    const release = h.holdNextBody();
    const old = h.feed({ limits_progress: [{ model_slug: 'model-a', remaining: 3 }] });
    h.advance(2000);
    await h.feed({ models: [] }, 'https://chatgpt.com/backend-api/models');
    release(); await old;
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.observedAt).toBe(Date.parse('2026-09-05T12:00:00Z'));
  });
  it('projects shared percentage windows without copying credentials or inventing a model balance', async () => {
    const h = harness();
    await h.feed({ access_token: 'secret', email: 'private@example.test', rate_limit: { primary_window: { used_percent: 25, reset_at: 1900000000, limit_window_seconds: 18000 } } });
    expect(h.posts).toEqual([{ type: 'cos-usage', observedAt: expect.any(Number), rows: [{ model: 'Shared usage', scope: 'shared', remaining: null, remainingPercent: 75, resetAt: 1900000000000, windowSeconds: 18000 }] }]);
    expect(JSON.stringify(h.posts)).not.toMatch(/secret|private|Authorization/);
  });

  it('keeps model and feature evidence separate', async () => {
    const h = harness();
    await h.feed({ conversation_detail_metadata: { limits_progress: [{ feature_name: 'deep-research', remaining: 5 }, { model_slug: 'gpt-example', remaining: 2 }], model_limits: [{ model_slug: 'gpt-exhausted', resets_after: '2030-01-01T00:00:00Z' }] } }, 'https://chatgpt.com/backend-api/conversation/init');
    expect(h.posts[0]?.rows).toEqual([
      expect.objectContaining({ model: 'gpt-exhausted', scope: 'model', remaining: null }),
      expect.objectContaining({ model: 'deep-research', scope: 'feature', remaining: 5 }),
      expect.objectContaining({ model: 'gpt-example', scope: 'model', remaining: 2 })
    ]);
  });

  it('ignores foreign and unrelated responses, invalid counts and oversized payloads', async () => {
    const h = harness();
    const valid = { rate_limit: { primary_window: { used_percent: 20 } } };
    await h.feed(valid, 'https://example.test/backend-api/wham/usage');
    await h.feed(valid, 'https://chatgpt.com/backend-api/conversations');
    await h.feed({ limits_progress: [{ model_slug: 'gpt-example', remaining: -2 }, { model_slug: 'gpt-other', remaining: '3' }], rate_limit: { primary_window: { used_percent: 101 } } });
    await h.feed({ ...valid, padding: 'x'.repeat(513 * 1024) });
    expect(h.posts).toEqual([{ type: 'cos-usage', observedAt: expect.any(Number), rows: [] }]);
  });

  it('does not emit zero reset timestamps or durations rejected by the app schema', async () => {
    const h = harness();
    await h.feed({ rate_limit: { primary_window: { used_percent: 20, reset_at: 0, limit_window_seconds: 0 } } });
    expect(h.posts[0]?.rows[0]).toMatchObject({ remainingPercent: 80, resetAt: null, windowSeconds: null });
  });

  it('only replays to an exact same-page request', async () => {
    const h = harness();
    await h.feed({ rate_limit: { primary_window: { used_percent: 20 } } });
    h.request({}, 'https://chatgpt.com');
    h.request(undefined, 'https://example.test');
    expect(h.posts).toHaveLength(1);
    h.advance(600000);
    h.request();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]?.observedAt).toBe(h.posts[0]?.observedAt);
  });

  it('emits an empty recognized quota snapshot but abstains on unrelated model metadata', async () => {
    const h = harness();
    await h.feed({ models: [{ slug: 'gpt-example', title: 'Example', max_tokens: 100000 }] }, 'https://chatgpt.com/backend-api/models');
    expect(h.posts).toEqual([]);
    await h.feed({ conversation_detail_metadata: { model_limits: [], limits_progress: [] } }, 'https://chatgpt.com/backend-api/conversation/prepare');
    expect(h.posts).toEqual([{ type: 'cos-usage', observedAt: expect.any(Number), rows: [] }]);
  });

  it('bounds the complete projection and rejects labels that could carry private or executable text', async () => {
    const h = harness();
    await h.feed({ limits_progress: [{ model_slug: 'private@example.test', remaining: 3 }, { feature_name: '<script>secret</script>', remaining: 5 }] });
    expect(h.posts[0]?.rows).toEqual([]);
    await h.feed({
      model_limits: Array.from({ length: 45 }, (_, i) => ({ model_slug: `model-${i}`, resets_after: '2030-01-01T00:00:00Z' })),
      limits_progress: Array.from({ length: 45 }, (_, i) => ({ feature_name: `feature-${i}`, remaining: 3 })),
      rate_limit: { primary_window: { used_percent: 20 } }
    });
    expect(h.posts[1]?.rows).toHaveLength(80);
    expect(JSON.stringify(h.posts)).not.toMatch(/private@example|<script>/);
  });

  it('publishes an exact conversation/request pair from a chunked live response before React renders it', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_`,
      'id":"wfr_early_exact"},"content":{"parts":["private prompt and tool args"]}}}\n\n',
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_id":"wfr_early_exact"}}}\n\n`,
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_id":"wfr_second"}}}\n\n`
    ]);

    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_early_exact'], observedAt: expect.any(Number) },
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_second'], observedAt: expect.any(Number) }
    ]);
    expect(JSON.stringify(h.posts)).not.toContain('private prompt');
    expect(JSON.stringify(h.posts)).not.toContain('tool args');
  });

  it('reattaches after the page runtime replaces fetch during startup', async () => {
    const h = harness();
    const replacement = h.replaceFetch();
    expect(h.currentFetch()).toBe(replacement);
    h.ready();
    expect(h.currentFetch()).not.toBe(replacement);
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    await h.feedSse([`data: {"conversation_id":"${conversationId}","metadata":{"request_id":"wfr_after_runtime_wrap"}}\n\n`]);

    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_after_runtime_wrap'], observedAt: expect.any(Number) }
    ]);
  });

  it('preserves a page wrapper that delegates to the earlier observer without recursion or duplicate inspection', async () => {
    const h = harness();
    h.replaceFetch(true);
    h.ready();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([`data: {"conversation_id":"${conversationId}","metadata":{"request_id":"wfr_nested_wrapper"}}\n\n`]);
    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_nested_wrapper'], observedAt: expect.any(Number) }
    ]);
  });

  it('supports the f/conversation endpoint and bounds request ids to sixteen per stream', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse(Array.from({ length: 20 }, (_, i) =>
      'data: ' + JSON.stringify({ conversation_id: conversationId, message: { metadata: { request_id: 'wfr_limit_' + i } } }) + '\r\n\r\n'
    ), { method: 'POST' }, 'https://chatgpt.com/backend-api/f/conversation');
    expect(h.posts).toHaveLength(16);
  });

  it('does not turn quoted text, tool arguments or cross-event identifiers into ownership', async () => {
    const h = harness();
    const a = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    for (const event of [
      { conversation_id: a, tool_arguments: { request_id: 'wfr_argument' } },
      { conversation_id: a, message: { content: { parts: ['{"request_id":"wfr_quoted"}'] } } },
      { conversation_id: a },
      { metadata: { request_id: 'wfr_separate_event' } }
    ]) await h.feedSse(['data: ' + JSON.stringify(event) + '\n\n']);
    await h.feedSse(['data: ' + JSON.stringify({ conversation_id: a, metadata: { request_id: 'wfr_foreign' } }) + '\n\n'],
      { method: 'POST' }, 'https://example.com/backend-api/conversation');
    expect(h.posts).toEqual([]);
  });

  it('ignores non-POST, foreign, malformed and contradictory stream identity', async () => {
    const h = harness();
    const a = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const b = '11111111-2222-4333-8444-555555555555';
    await h.feedSse([`data: {"conversation_id":"${a}","request_id":"wfr_get"}\n\n`], { method: 'GET' });
    await h.feedSse([`data: {"conversation_id":"${a}","request_id":"not-a-workflow"}\n\n`]);
    await h.feedSse([`data: {"conversation_id":"${a}","nested":{"conversation_id":"${b}"},"request_id":"wfr_conflict"}\n\n`]);
    expect(h.posts).toEqual([]);
  });
});

describe('replacing the MAIN-world observer after an extension update', () => {
  it('keeps the current observer on an ordinary re-execution', () => {
    const h = harness(), first = h.observer();
    h.evaluate();
    expect(h.observer()).toBe(first);
  });

  it('replaces it only when asked and republishes retained request origins first', async () => {
    const h = harness();
    h.ready();
    await h.feedSse([`data: ${JSON.stringify({ conversation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      message: { metadata: { request_id: 'wfr_handover_1' } } })}\n\n`]);
    const first = h.observer();
    h.posts.length = 0;
    h.askReplace();
    h.evaluate();
    expect(h.observer()).not.toBe(first);
    expect(h.posts).toContainEqual(expect.objectContaining({ type: 'cos-request-origin', requestIds: ['wfr_handover_1'] }));
    const second = h.observer();
    h.evaluate();
    expect(h.observer()).toBe(second);
  });
  it('restores owned native wrappers and makes repeated disposal inert', () => {
    const nativeFetch = () => Promise.resolve(undefined), h = harness(nativeFetch);
    expect(h.currentFetch()).not.toBe(nativeFetch);
    expect(h.currentSocket()).not.toBe(h.nativeSocket);
    const observer = h.observer();
    observer.dispose();
    expect(h.currentFetch()).toBe(nativeFetch);
    expect(h.currentSocket()).toBe(h.nativeSocket);
    observer.dispose();
    expect(h.currentFetch()).toBe(nativeFetch);
    expect(h.currentSocket()).toBe(h.nativeSocket);
  });

  it('preserves a later page wrapper and passes inactive native calls through exactly', () => {
    const result = Promise.resolve({ native: true }), calls: Array<{ receiver: unknown; args: unknown[] }> = [];
    const nativeFetch = function (this: unknown, ...args: unknown[]) {
      calls.push({ receiver: this, args }); return result;
    };
    const h = harness(nativeFetch), retiredFetch = h.currentFetch(), pageWrapper = h.replaceFetch(true);
    h.observer().dispose();
    expect(h.currentFetch()).toBe(pageWrapper);
    const receiver = {}, args = ['/backend-api/f/conversation', { method: 'POST', body: '{}' }];
    expect(retiredFetch.apply(receiver, args)).toBe(result);
    expect(calls).toEqual([{ receiver, args }]);
    expect(h.posts).toEqual([]);
  });

  it('does not retain outer inactive wrappers across repeated observer replacement', () => {
    const nativeFetch = () => Promise.resolve(undefined), h = harness(nativeFetch);
    h.ready();
    for (let n = 0; n < 5; n++) { h.askReplace(); h.evaluate(); }
    h.observer().dispose();
    expect(h.currentFetch()).toBe(nativeFetch);
    expect(h.currentSocket()).toBe(h.nativeSocket);
  });

  it('detaches a retired observer on socket activity without publishing or closing the socket', () => {
    const h = harness(), socket = h.socket();
    expect(socket.handlers).toHaveLength(1);
    h.observer().dispose();
    socket.receive([]);
    expect(socket.handlers).toHaveLength(0);
    expect(socket).toBeInstanceOf(h.nativeSocket);
    expect(h.posts).toEqual([]);
  });

  it('never seeds a split request from a nested-only conversation field', async () => {
    const h = harness(), conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([
      'data: ' + JSON.stringify({ nested: { conversation_id } }) + '\n\n',
      'data: ' + JSON.stringify({ metadata: { request_id: 'wfr_nested_seed' } }) + '\n\n'
    ]);
    expect(h.posts).toEqual([]);
  });

  it('keeps a contradictory stream poisoned but permits an independent healthy response', async () => {
    const h = harness(), conversation_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
    await h.feedSse([
      frame({ conversation_id }),
      frame({ conversation_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' }),
      frame({ conversation_id, metadata: { request_id: 'wfr_after_conflict' } })
    ]);
    expect(h.posts).toEqual([]);
    await h.feedSse([frame({ conversation_id, metadata: { request_id: 'wfr_independent_healthy' } })]);
    expect(h.posts.map(row => row.requestIds)).toEqual([['wfr_independent_healthy']]);
  });

  it('does not publish a read that resolves after the passive observation deadline', async () => {
    const h = harness(), pending = await h.openSse({ cancelWaits: true });
    h.advance(15 * 60_000 + 1);
    expect(pending.cancelled).toBe(true);
    pending.push({ conversation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      metadata: { request_id: 'wfr_after_deadline' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.posts).toEqual([]);
    expect(pending.nativeResponseUnchanged).toBe(true);
    h.hide();
  });

});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { startTunnel, type TunnelHandle } from '../src/main/tunnel/index.js';
import type { TunnelSettings } from '../src/shared/types.js';

let handle: TunnelHandle | undefined;
afterEach(async () => { await handle?.stop(); handle = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
const settings = { kind: 'manual', tunnelId: '', desktopTunnelId: '', binaryPath: '', manualPublicOrigin: 'https://Delta.example.com', manualPort: 9765 } as TunnelSettings;
const localUrl = 'http://127.0.0.1:9765/mcp/core/private-test-path';
const discoveryHeaders = { 'x-local-tunnel-probe': 'current-proof' };
const metadataPath = '/.well-known/oauth-protected-resource/mcp/core/private-test-path';
const fixtureSecret = randomBytes(32);
const sign = (challenge: string, path = metadataPath, secret = fixtureSecret) => createHmac('sha256', secret).update(`cos-external-route-v1\n${path}\n${challenge}`).digest('hex');
const externalRouteProof = (path: string, challenge: string, proof: string | null) => [metadataPath, new URL(localUrl).pathname].includes(path) &&
  /^[a-f0-9]{64}$/.test(challenge) && typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof) &&
  timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(sign(challenge, path), 'hex'));
const signedResponse = (url: string, options: RequestInit) => new Response(null, {
  status: new URL(url).pathname.startsWith('/.well-known/') ? 200 : 204,
  headers: { 'x-local-tunnel-proof': sign(new Headers(options.headers).get('x-local-tunnel-challenge') ?? '', new URL(url).pathname) }
});

describe('externally owned HTTPS route', () => {
  it('keeps a verified external route connected while reporting missing request-id forwarding', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(signedResponse);
    vi.stubGlobal('fetch', fetcher);
    const report = vi.fn();
    handle = await startTunnel({ localUrl, settings, apiKey: null, externalRouteProof, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'connected', publicUrl: expect.any(String),
      detail: expect.stringContaining('x-request-id') });
    expect(new Headers(fetcher.mock.calls[0]![1].headers).get('x-request-id')).toMatch(/^wfr_cos_probe_[a-f0-9]{32}\//);
  });

  it('uses the existing route check to verify forwarded request identity and its later recovery', async () => {
    vi.useFakeTimers();
    let forwardHeader = false;
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      const response = signedResponse(url, options);
      const requestId = new Headers(options.headers).get('x-request-id');
      const digest = forwardHeader && requestId ? createHash('sha256').update(requestId.split('/')[0]!).digest('hex') : null;
      return new Response(null, { status: response.status, headers: {
        'x-local-tunnel-proof': response.headers.get('x-local-tunnel-proof')!,
        ...(digest ? { 'x-local-tunnel-request-id-digest': digest } : {})
      } });
    });
    vi.stubGlobal('fetch', fetcher);
    const report = vi.fn();
    handle = await startTunnel({ localUrl, settings, apiKey: null, externalRouteProof, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'connected',
      detail: expect.stringContaining('x-request-id') });
    forwardHeader = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'connected',
      detail: 'Public route verified against this account’s current MCP endpoint.' });
    expect(report).toHaveBeenCalledTimes(3); // Connecting, identity-unverified, recovered.
  });

  it('keeps a synthetic-header-verified route connected but warns when real Core tool calls still lack identity', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      const response = signedResponse(url, options);
      const raw = new Headers(options.headers).get('x-request-id');
      return new Response(null, { status: response.status, headers: {
        'x-local-tunnel-proof': response.headers.get('x-local-tunnel-proof')!,
        ...(raw ? { 'x-local-tunnel-request-id-digest': createHash('sha256')
          .update(raw.split('/')[0]!).digest('hex') } : {})
      } });
    });
    vi.stubGlobal('fetch', fetcher);
    const report = vi.fn();
    let actual = { toolCalls: 0, withoutRequestId: 0, complete: true };
    const actualToolIdentity = vi.fn(() => actual);
    handle = await startTunnel({ localUrl, settings, apiKey: null, externalRouteProof,
      label: 'core', actualToolIdentity, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.lastCall?.[0]).toMatchObject({
      state: 'connected', detail: 'Public route verified against this account’s current MCP endpoint.'
    });

    // This is the installed Delta failure: synthetic x-request-id reaches the
    // endpoint, but actual provider-issued MCP tools/call requests have no usable
    // request id. No account/turn identity or Send authority may be inferred.
    actual = { toolCalls: 5, withoutRequestId: 5, complete: true };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report.mock.lastCall?.[0]).toMatchObject({
      state: 'connected', publicUrl: expect.any(String),
      detail: expect.stringContaining('real Core tool calls')
    });
    expect(report.mock.lastCall?.[0].detail).toContain('Unattributed');
    expect(report.mock.lastCall?.[0].detail).not.toContain('tool results attributed');
    expect(actualToolIdentity).toHaveBeenCalled();

    const warnings = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report).toHaveBeenCalledTimes(warnings); // no repeated warning for identical evidence
    actual = { toolCalls: 6, withoutRequestId: 5, complete: true };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report.mock.lastCall?.[0]).toMatchObject({
      state: 'connected', detail: expect.stringContaining('Some real Core tool calls')
    });
    // One valid header does not retroactively claim the five ambiguous results.
    expect(report.mock.lastCall?.[0].detail).toContain('Unattributed');
  });

  it('retains explicit Core identity uncertainty when the bounded ingress history is incomplete or its reader fails', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      const response = signedResponse(url, options);
      const raw = new Headers(options.headers).get('x-request-id');
      return new Response(null, { status: response.status, headers: {
        'x-local-tunnel-proof': response.headers.get('x-local-tunnel-proof')!,
        ...(raw ? { 'x-local-tunnel-request-id-digest':
          createHash('sha256').update(raw.split('/')[0]!).digest('hex') } : {})
      } });
    }));
    const report = vi.fn();
    let actual: { toolCalls: number; withoutRequestId: number; complete: boolean } | null =
      { toolCalls: 3, withoutRequestId: 3, complete: true };
    const actualToolIdentity = () => {
      if (!actual) throw new Error('private runtime failure details');
      return actual;
    };
    handle = await startTunnel({ localUrl, settings, apiKey: null, externalRouteProof,
      label: 'core', actualToolIdentity, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.lastCall?.[0].detail).toContain('Unattributed');
    actual = { toolCalls: 0, withoutRequestId: 0, complete: false };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'connected',
      detail: expect.stringContaining('incomplete') });
    actual = null;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'connected',
      detail: expect.stringContaining('unavailable') });
    expect(report.mock.lastCall?.[0].detail).not.toContain('private runtime failure details');
  });

  it('does not certify request forwarding from GET when the actual MCP POST method strips it', async () => {
    vi.useFakeTimers();
    let forwardPost = false;
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      const response = signedResponse(url, options);
      const requestId = new Headers(options.headers).get('x-request-id');
      const forwarded = requestId && (options.method !== 'POST' || forwardPost);
      return new Response(null, { status: response.status, headers: {
        'x-local-tunnel-proof': response.headers.get('x-local-tunnel-proof')!,
        ...(forwarded ? { 'x-local-tunnel-request-id-digest': createHash('sha256').update(requestId.split('/')[0]!).digest('hex') } : {})
      } });
    });
    vi.stubGlobal('fetch', fetcher);
    const report = vi.fn();
    handle = await startTunnel({ localUrl, settings, apiKey: null, externalRouteProof, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'connected', detail: expect.stringContaining('x-request-id') });
    const mcp = fetcher.mock.calls.filter(([url]) => new URL(url).pathname === new URL(localUrl).pathname);
    expect(mcp.map(([, options]) => options.method)).toEqual(['POST']);
    expect(mcp[0]![1].body).toBeUndefined();
    expect(fetcher.mock.calls.filter(([url]) => new URL(url).pathname === metadataPath).map(([, options]) => options.method)).toEqual(['GET']);
    forwardPost = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'connected',
      detail: 'Public route verified against this account’s current MCP endpoint.' });
  });

  it('retains a verified live MCP route when an external proxy rejects only the synthetic identity header', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      const headers = new Headers(options.headers);
      if (url.endsWith('/mcp/core/private-test-path') && headers.has('x-request-id'))
        return new Response(null, { status: 403 });
      return signedResponse(url, options);
    });
    vi.stubGlobal('fetch', fetcher);
    const report = vi.fn();
    handle = await startTunnel({ localUrl, settings, apiKey: null, externalRouteProof, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'connected', publicUrl: expect.any(String),
      detail: expect.stringContaining('x-request-id') });
    expect(fetcher).toHaveBeenCalledTimes(3); // Identity probe, ordinary route proof, metadata proof.
    expect(new Headers(fetcher.mock.calls[0]![1].headers).has('x-request-id')).toBe(true);
    expect(new Headers(fetcher.mock.calls[1]![1].headers).has('x-request-id')).toBe(false);
  });

  it('requires metadata proof as well as actual MCP proof and recovers each failed check', async () => {
    vi.useFakeTimers();
    let metadataHealthy = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if (!metadataHealthy && new URL(url).pathname.startsWith('/.well-known/')) return new Response(null, { status: 404 });
      return signedResponse(url, options);
    }));
    const report = vi.fn();
    handle = await startTunnel({ localUrl, settings, apiKey: null, externalRouteProof, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'tunnel-unavailable', publicUrl: null });
    metadataHealthy = true; await vi.advanceTimersByTimeAsync(15_000);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'connected', publicUrl: expect.any(String) });
    metadataHealthy = false; await vi.advanceTimersByTimeAsync(15_000);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'tunnel-unavailable', publicUrl: null });
  });

  it.each(['core', 'desktop', 'plugins'])('refuses valid metadata when the actual %s MCP prefix goes elsewhere', async surface => {
    vi.useFakeTimers();
    const route = `/mcp/${surface}/private-test-path`;
    const verifier = (path: string, challenge: string, proof: string | null) =>
      [route, '/.well-known/oauth-protected-resource' + route].includes(path) && proof === sign(challenge, path);
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      const pathname = new URL(url).pathname;
      const challenge = new Headers(options.headers).get('x-local-tunnel-challenge') ?? '';
      return new Response(null, { status: pathname === route ? 204 : 200, headers: { 'x-local-tunnel-proof': sign(challenge, pathname,
        pathname === route ? randomBytes(32) : fixtureSecret) } });
    });
    vi.stubGlobal('fetch', fetcher);
    const report = vi.fn();
    handle = await startTunnel({ localUrl: 'http://127.0.0.1:9765' + route, settings, apiKey: null, externalRouteProof: verifier, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'tunnel-unavailable', publicUrl: null });
    expect(fetcher.mock.calls.some(row => new URL(row[0]).pathname === route)).toBe(true);
  });

  it('publishes only after proving the current endpoint, retires failed proof, and recovers without spawning a connector', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(new Response('', { headers: { 'x-local-tunnel-proof': 'foreign-proof' } }));
    vi.stubGlobal('fetch', fetcher);
    const report = vi.fn();
    handle = await startTunnel({ localUrl, settings, apiKey: null, discoveryHeaders, externalRouteProof, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.calls[0]![0]).toMatchObject({ state: 'connecting-tunnel', publicUrl: null });
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'tunnel-unavailable', publicUrl: null });
    fetcher.mockImplementation(signedResponse);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'connected', publicUrl: 'https://Delta.example.com/mcp/core/private-test-path' });
    expect(fetcher.mock.lastCall?.[0]).toBe('https://Delta.example.com/.well-known/oauth-protected-resource/mcp/core/private-test-path');
    expect(fetcher.mock.lastCall?.[1]).toMatchObject({ redirect: 'error', cache: 'no-store' });
    const sent = new Headers(fetcher.mock.lastCall?.[1]?.headers);
    expect(sent.get('x-local-tunnel-challenge')).toMatch(/^[a-f0-9]{64}$/);
    expect(sent.get('x-local-tunnel-probe')).toBeNull();
    fetcher.mockRejectedValue(new Error('private upstream URL must never be exposed'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'tunnel-unavailable', publicUrl: null });
    expect(JSON.stringify(report.mock.calls)).not.toContain('private upstream');
  });

  it('aborts an outstanding check and ignores a late healthy response after stop', async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn((_url: string, _options: RequestInit) => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    const report = vi.fn();
    handle = await startTunnel({ localUrl, settings, apiKey: null, discoveryHeaders, externalRouteProof, report });
    const before = report.mock.calls.length;
    const stopping = handle.stop();
    expect(fetcher.mock.lastCall?.[1]?.signal?.aborted).toBe(true);
    resolve(signedResponse(localUrl, fetcher.mock.lastCall![1]));
    await stopping;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(report).toHaveBeenCalledTimes(before);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a reflecting proxy without transmitting the legacy discovery secret', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => new Response('', { headers: {
      'x-local-tunnel-proof': new Headers(options.headers).get('x-local-tunnel-probe') ?? new Headers(options.headers).get('x-local-tunnel-challenge') ?? ''
    } }));
    vi.stubGlobal('fetch', fetcher);
    const report = vi.fn();
    handle = await startTunnel({ localUrl, settings, apiKey: null, discoveryHeaders, externalRouteProof, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'tunnel-unavailable', publicUrl: null });
    expect(new Headers(fetcher.mock.lastCall![1].headers).get('x-local-tunnel-probe')).toBeNull();
  });

  it.each(['wrong-account', 'wrong-path', 'malformed', 'missing', 'replayed'])('retires %s proof and uses a fresh challenge on every check', async (failure) => {
    vi.useFakeTimers();
    const previousProof = new Map<string, string>();
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      const pathname = new URL(url).pathname;
      const challenge = new Headers(options.headers).get('x-local-tunnel-challenge') ?? '';
      let proof: string | undefined = sign(challenge, pathname);
      if (previousProof.has(pathname)) {
        if (failure === 'wrong-account') proof = sign(challenge, pathname, randomBytes(32));
        if (failure === 'wrong-path') proof = sign(challenge, pathname.replace('/core/', '/desktop/'));
        if (failure === 'malformed') proof = proof.toUpperCase();
        if (failure === 'missing') proof = undefined;
        if (failure === 'replayed') proof = previousProof.get(pathname);
      }
      previousProof.set(pathname, proof ?? '');
      return new Response(null, { status: pathname.startsWith('/.well-known/') ? 200 : 204,
        headers: proof === undefined ? {} : { 'x-local-tunnel-proof': proof } });
    });
    vi.stubGlobal('fetch', fetcher);
    const report = vi.fn();
    handle = await startTunnel({ localUrl, settings, apiKey: null, discoveryHeaders, externalRouteProof, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'connected' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(report.mock.lastCall?.[0]).toMatchObject({ state: 'tunnel-unavailable', publicUrl: null });
    const challenges = fetcher.mock.calls.map(call => new Headers(call[1].headers).get('x-local-tunnel-challenge'));
    expect(challenges[1]).not.toBe(challenges[0]);
  });

  it('retains the original local-only manual contract when no public origin is chosen', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const report = vi.fn();
    handle = await startTunnel({ localUrl, settings: { ...settings, manualPublicOrigin: '' }, apiKey: null, report });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ state: 'connected', publicUrl: null }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires the real current-endpoint verifier before starting an external check', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(startTunnel({ localUrl, settings, apiKey: null, discoveryHeaders, report: vi.fn() })).rejects.toThrow(/current local endpoint verifier/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

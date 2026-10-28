import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const caps = {
    browse: true,
    search: true,
    read: true,
    metadata: true,
    create: false,
    edit: false,
    move: false,
    deleteFile: false,
    command: false,
    screen: false,
    control: false,
    clipboardRead: false,
    clipboardWrite: false
  };
  const config = {
    roots: [{ name: 'workspace', path: 'C:\\workspace' }],
    readOnly: true,
    capabilities: caps,
    tunnel: { kind: 'cloudflared', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', binaryPath: '', manualPublicOrigin: '', manualPort: 0, manualEndpointRevision: 0 },
    ui: { privacyScreenshots: false, automationPaused: false },
    sessions: { record: false },
    multiAgent: { enabled: false }
  };
  return {
    caps,
    tunnelIsolation: vi.fn(async () => {}),
    config,
    instanceId: 'profile-business',
    endpointTokens: vi.fn(async (_id: string, _revision = 0) => ({ core: 'a'.repeat(43), desktop: 'b'.repeat(43), plugins: 'c'.repeat(43) })),
    applyPause: vi.fn(),
    report: null as null | ((report: Record<string, unknown>) => void),
    tunnelOptions: [] as Array<Record<string, unknown>>,
    starts: 0,
    prewarm: vi.fn(async () => undefined),
    endpointStop: vi.fn(async (_options?: { forceAfterMs?: number }): Promise<void> => undefined),
    externalRouteProof: vi.fn(() => false),
    ingressRows: [] as Array<{ surface: string; at: number; requestId: string | null; methods: string[] }>,
    surfacePlatform: undefined as NodeJS.Platform | undefined,
    externalFailures: new Set<string>(),
    publication: vi.fn((surface: string, observe: (name: string, version: string, instructions: string, tools: unknown[]) => void) => observe(`Chat On Steroids ${surface}`, '1', 'instructions', [])),
    approvedRootsRefresh: null as null | (() => void),
    endpointStartGate: null as Promise<void> | null,
    endpointStartReached: vi.fn(),
    tunnelStartGate: null as Promise<void> | null,
    tunnelStartReached: vi.fn(),
    optionalStartGate: null as Promise<void> | null,
    optionalStartReached: vi.fn(),
    tunnelStop: vi.fn(async (): Promise<void> => undefined),
    secretGate: null as Promise<void> | null,
    secretReached: vi.fn()
  };
});

vi.mock('../src/main/computer/index.js', () => ({ prewarmComputerHelper: mocks.prewarm }));

vi.mock('../src/main/config.js', () => ({
  assertActiveSecureTunnelIsolation: mocks.tunnelIsolation,
  getConfig: () => mocks.config,
  effectiveCapabilities: () => mocks.caps,
  getActiveInstanceOwnerPaths: () => ({ healthRoot: 'C:\\instance-health' }),
  getActiveInstanceRuntime: () => ({ profile: { id: mocks.instanceId, bridge: { port: 8770 } } }),
  configureApprovedRootPublicationRefresh: (listener: (() => void) | null) => { mocks.approvedRootsRefresh = listener; }
}));

vi.mock('../src/main/logger.js', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/bridge.js', () => ({ applyAutomationPause: mocks.applyPause }));
vi.mock('../src/main/mcp/surfaces.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/mcp/surfaces.js')>();
  return { ...actual,
    surfacePublishedSeparately: (id: Parameters<typeof actual.surfacePublishedSeparately>[0]) => actual.surfacePublishedSeparately(id, mocks.surfacePlatform),
    surfaceIsUseful: (id: Parameters<typeof actual.surfaceIsUseful>[0], caps: Parameters<typeof actual.surfaceIsUseful>[1]) => actual.surfaceIsUseful(id, caps, mocks.surfacePlatform)
  };
});

vi.mock('../src/main/mcp/server.js', () => ({
  lastRequestAt: () => null,
  recentMcpIngress: (surface: string, since: number) => ({
    records: mocks.ingressRows.filter(row => row.surface === surface && row.at >= since),
    complete: true
  }),
  tunnelProbeHeaders: () => ({}),
  startMcpServer: vi.fn(async () => {
    mocks.endpointStartReached();
    if (mocks.endpointStartGate) await mocks.endpointStartGate;
    return {
      port: 45678,
      publication: mocks.publication,
      externalRouteProof: mocks.externalRouteProof,
      url: 'http://127.0.0.1:45678/mcp/core/core-token',
      urls: {
        core: 'http://127.0.0.1:45678/mcp/core/core-token',
        desktop: 'http://127.0.0.1:45678/mcp/desktop/desktop-token',
        plugins: 'http://127.0.0.1:45678/mcp/plugins/plugins-token'
      },
      stop: mocks.endpointStop
    };
  })
}));

vi.mock('../src/main/mcp/tools.js', () => ({ lastToolCallAt: () => null }));
vi.mock('../src/main/secrets.js', () => ({
  getOrCreateMcpEndpointTokens: mocks.endpointTokens,
  getSecret: vi.fn(async () => {
    mocks.secretReached();
    if (mocks.secretGate) await mocks.secretGate;
    return null;
  })
}));
vi.mock('../src/main/tunnel/index.js', () => ({
  TunnelError: class extends Error {},
  startTunnel: vi.fn(async (options: { label?: string; localUrl: string; settings: { kind: string; manualPublicOrigin?: string }; report: (report: Record<string, unknown>) => void }) => {
    mocks.starts += 1;
    mocks.tunnelOptions.push(options as unknown as Record<string, unknown>);
    mocks.report = options.report;
    mocks.tunnelStartReached();
    if (mocks.tunnelStartGate) await mocks.tunnelStartGate;
    if (options.label === 'plugins') {
      mocks.optionalStartReached();
      if (mocks.optionalStartGate) await mocks.optionalStartGate;
    }
    const external = options.settings.kind === 'manual' && options.settings.manualPublicOrigin;
    options.report({
      state: external && mocks.externalFailures.has(options.label!) ? 'tunnel-unavailable' : 'connected',
      detail: 'Connected.',
      publicUrl: external ? (mocks.externalFailures.has(options.label!) ? null : options.settings.manualPublicOrigin + new URL(options.localUrl).pathname)
        : 'https://example.trycloudflare.com/mcp/core/core-token'
    });
    return { stop: mocks.tunnelStop };
  })
}));

describe('connection surface state', () => {
  beforeEach(() => {
    mocks.tunnelIsolation.mockReset(); mocks.tunnelIsolation.mockResolvedValue(undefined);
    mocks.report = null;
    mocks.starts = 0;
    mocks.tunnelOptions.length = 0;
    mocks.prewarm.mockClear();
    mocks.endpointStop.mockClear();
    mocks.publication.mockClear();
    mocks.approvedRootsRefresh = null;
    mocks.endpointStartReached.mockClear();
    mocks.endpointStartGate = null;
    mocks.tunnelStartReached.mockClear();
    mocks.tunnelStartGate = null;
    mocks.optionalStartGate = null;
    mocks.optionalStartReached.mockClear();
    mocks.tunnelStop.mockClear();
    mocks.secretReached.mockClear();
    mocks.secretGate = null;
    Object.assign(mocks.caps, {
      browse: true,
      search: true,
      read: true,
      metadata: true,
      create: false,
      edit: false,
      move: false,
      deleteFile: false,
      command: false,
      screen: false,
      control: false,
      clipboardRead: false,
      clipboardWrite: false
    });
    mocks.config.roots = [{ name: 'workspace', path: 'C:\\workspace' }];
    mocks.config.readOnly = true;
    mocks.config.tunnel.kind = 'cloudflared';
    mocks.config.tunnel.tunnelId = '';
    mocks.config.tunnel.desktopTunnelId = '';
    mocks.config.tunnel.pluginsTunnelId = '';
    mocks.config.tunnel.binaryPath = '';
    mocks.config.tunnel.manualPublicOrigin = '';
    mocks.config.tunnel.manualPort = 0;
    mocks.config.tunnel.manualEndpointRevision = 0;
    mocks.config.ui.automationPaused = false;
    mocks.applyPause.mockClear();
    mocks.instanceId = 'profile-business';
    mocks.endpointTokens.mockClear();
    mocks.surfacePlatform = undefined;
    mocks.externalFailures.clear();
    mocks.ingressRows.length = 0;
    vi.resetModules();
  });

  it('refuses a colliding Secure MCP tunnel before opening a local endpoint', async () => {
    mocks.config.tunnel.kind = 'openai';
    mocks.tunnelIsolation.mockRejectedValueOnce(new Error('Secure MCP tunnel identity conflicts with another account'));
    const connection = await import('../src/main/connection.js');
    const server = await import('../src/main/mcp/server.js');
    await connection.connect();
    expect(server.startMcpServer).not.toHaveBeenCalled();
    expect(mocks.tunnelOptions).toHaveLength(0);
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('uses the exact profile’s encrypted persistent authority only for an explicitly configured external route', async () => {
    const connection = await import('../src/main/connection.js');
    const server = await import('../src/main/mcp/server.js');
    await connection.connect();
    expect(mocks.endpointTokens).not.toHaveBeenCalled();
    await connection.disconnect();
    mocks.config.tunnel.kind = 'manual';
    mocks.config.tunnel.manualPublicOrigin = 'https://Delta.example.com';
    await connection.connect();
    expect(mocks.endpointTokens).toHaveBeenCalledWith('profile-business', 0);
    expect(server.startMcpServer).toHaveBeenLastCalledWith(expect.any(Function), { port: 9770,
      surfaceTokens: { core: 'a'.repeat(43), desktop: 'b'.repeat(43), plugins: 'c'.repeat(43) } });
    expect(mocks.tunnelOptions.at(-1)?.externalRouteProof).toBe(mocks.externalRouteProof);
    await connection.disconnect();
  });

  it('supplies only the exact local MCP surface’s real tool-call identity evidence to the existing manual route reporter', async () => {
    mocks.config.tunnel.kind = 'manual';
    mocks.config.tunnel.manualPublicOrigin = 'https://Delta.example.com';
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    try {
      const core = mocks.tunnelOptions.find(row => row.label === 'core')!;
      const observe = core.actualToolIdentity as (since: number) => {
        toolCalls: number; withoutRequestId: number; complete: boolean;
      };
      expect(typeof observe).toBe('function');
      const since = Date.now() - 100;
      mocks.ingressRows.push(
        { surface: 'core', at: since + 1, requestId: null, methods: ['tools/call'] },
        { surface: 'core', at: since + 2, requestId: 'wfr_exact_native_id', methods: ['tools/call'] },
        { surface: 'core', at: since + 3, requestId: null, methods: ['tools/list'] },
        { surface: 'plugins', at: since + 4, requestId: null, methods: ['tools/call'] }
      );
      expect(observe(since)).toEqual({ toolCalls: 2, withoutRequestId: 1, complete: true });
      expect(observe(since + 2)).toEqual({ toolCalls: 1, withoutRequestId: 0, complete: true });
      const plugins = mocks.tunnelOptions.find(row => row.label === 'plugins');
      if (plugins) {
        const observePlugins = plugins.actualToolIdentity as typeof observe;
        expect(observePlugins(since)).toEqual({ toolCalls: 1, withoutRequestId: 1, complete: true });
      }
      // Source-session ownership, helper ACK, and any native Send remain untouched.
    } finally { await connection.disconnect(); }
  });

  it('reapplies the existing automation hold before external transport health and binds the exact revocation revision', async () => {
    mocks.config.tunnel.kind = 'manual';
    mocks.config.tunnel.manualPublicOrigin = 'https://Delta.example.com';
    mocks.config.tunnel.manualEndpointRevision = 2;
    mocks.config.ui.automationPaused = true;
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    expect(mocks.applyPause).toHaveBeenCalledWith(true);
    expect(mocks.endpointTokens).toHaveBeenCalledWith('profile-business', 2);
    expect(mocks.applyPause.mock.invocationCallOrder[0]).toBeLessThan(mocks.endpointTokens.mock.invocationCallOrder.at(-1)!);
    mocks.report?.({ state: 'connected', publicUrl: 'https://Delta.example.com/mcp/core/core-token' });
    expect(mocks.config.ui.automationPaused).toBe(true);
    await connection.disconnect();
  });

  it('keeps the captured external endpoint owner across live pause application', async () => {
    mocks.config.tunnel.kind = 'manual';
    mocks.config.tunnel.manualPublicOrigin = 'https://Delta.example.com';
    mocks.config.tunnel.manualEndpointRevision = 1;
    mocks.config.ui.automationPaused = true;
    mocks.applyPause.mockImplementationOnce(() => { mocks.instanceId = 'profile-foreign'; });
    const connection = await import('../src/main/connection.js');
    const server = await import('../src/main/mcp/server.js');
    await connection.connect();
    expect(mocks.endpointTokens).not.toHaveBeenCalled();
    expect(server.startMcpServer).not.toHaveBeenCalled();
    await connection.disconnect();
  });

  it('does not bounce a quick tunnel when dormant external settings change', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    mocks.config.tunnel.manualPublicOrigin = 'https://Delta.example.com';
    mocks.config.tunnel.manualPort = 9770;
    await connection.applySettings();
    expect(mocks.starts).toBe(1);
    expect(mocks.endpointTokens).not.toHaveBeenCalled();
    await connection.disconnect();
  });

  it.each(['desktop', 'plugins'] as const)('proves the Mac %s external route independently and withdraws/recover its exact publication', async failed => {
    mocks.surfacePlatform = 'darwin';
    mocks.caps.screen = true;
    mocks.config.tunnel.kind = 'manual';
    mocks.config.tunnel.manualPublicOrigin = 'https://Delta.example.com';
    mocks.externalFailures.add(failed);
    const connection = await import('../src/main/connection.js');
    try {
      await connection.connect();
      expect(mocks.tunnelOptions.map(row => row.label)).toEqual(['core', 'desktop', 'plugins']);
      const options = mocks.tunnelOptions.find(row => row.label === failed)!;
      expect(options.localUrl).toContain(`/mcp/${failed}/`);
      expect(options.externalRouteProof).toBe(mocks.externalRouteProof);
      expect(connection.getStatus().surfaces.find(row => row.id === failed)).toMatchObject({ state: 'error', publicUrl: null });
      expect(connection.getStatus().surfaces.find(row => row.id === 'core')).toMatchObject({ state: 'live' });
      const report = options.report as (row: Record<string, unknown>) => void;
      report({ state: 'connected', publicUrl: `https://Delta.example.com/mcp/${failed}/${failed}-token` });
      expect(connection.getStatus().surfaces.find(row => row.id === failed)).toMatchObject({ state: 'live', publicUrl: expect.stringContaining(`/mcp/${failed}/`) });
      report({ state: 'tunnel-unavailable', publicUrl: null });
      await connection.applySettings();
      expect(connection.getStatus().surfaces.find(row => row.id === failed)).toMatchObject({ state: 'error', publicUrl: null });
      // A later Core report cannot overwrite independent optional health.
      (mocks.tunnelOptions[0]!.report as typeof report)({ state: 'connected', publicUrl: 'https://Delta.example.com/mcp/core/core-token' });
      expect(connection.getStatus().surfaces.find(row => row.id === failed)).toMatchObject({ state: 'error', publicUrl: null });
      await connection.disconnect();
      report({ state: 'connected', publicUrl: 'https://Delta.example.com/stale' });
      expect(connection.getStatus().surfaces.every(row => row.publicUrl === null && row.state === 'off')).toBe(true);
    } finally { await connection.disconnect(); }
  });

  it('retires a disabled Mac Desktop proof lifetime and starts a fresh one when enabled', async () => {
    mocks.surfacePlatform = 'darwin'; mocks.caps.screen = true;
    mocks.config.tunnel.kind = 'manual'; mocks.config.tunnel.manualPublicOrigin = 'https://Delta.example.com';
    const connection = await import('../src/main/connection.js');
    try {
      await connection.connect();
      const oldReport = mocks.tunnelOptions.find(row => row.label === 'desktop')!.report as (row: Record<string, unknown>) => void;
      mocks.caps.screen = false; await connection.applySettings();
      oldReport({ state: 'connected', publicUrl: 'https://Delta.example.com/stale' });
      expect(connection.getStatus().surfaces.find(row => row.id === 'desktop')).toMatchObject({ state: 'off', publicUrl: null });
      mocks.caps.screen = true; await connection.applySettings();
      expect(mocks.tunnelOptions.filter(row => row.label === 'desktop')).toHaveLength(2);
      oldReport({ state: 'tunnel-unavailable', publicUrl: null });
      expect(connection.getStatus().surfaces.find(row => row.id === 'desktop')).toMatchObject({ state: 'live' });
    } finally { await connection.disconnect(); }
  });

  it('projects the current route takeover deadline without treating it as connection or delivery proof (#1250)', async () => {
    vi.useFakeTimers();
    const connection = await import('../src/main/connection.js');
    const route = await import('../src/main/tunnel/route-settle.js');
    try {
      expect(connection.getStatus()).toMatchObject({ state: 'disconnected', routeSettlingUntil: null });
      route.noteTunnelClientConnected();
      expect(connection.getStatus()).toMatchObject({ state: 'disconnected', routeSettlingUntil: Date.now() + route.ROUTE_SETTLE_MS });
      await vi.advanceTimersByTimeAsync(route.ROUTE_SETTLE_MS);
      expect(connection.getStatus()).toMatchObject({ state: 'disconnected', routeSettlingUntil: null });
    } finally { route.resetRouteSettleForTests(); vi.useRealTimers(); }
  });

  it('reconnects with the selected setup key even when both profiles use the same tunnel ID', async () => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.tunnelId = 'same-core';
    Object.assign(mocks.config.tunnel, { profileId: 'default', profileEpoch: 0 });
    const connection = await import('../src/main/connection.js');
    const { getSecret } = await import('../src/main/secrets.js');
    try {
      await connection.connect();
      expect(getSecret).toHaveBeenLastCalledWith('openaiApiKey');
      Object.assign(mocks.config.tunnel, { profileId: 'second', profileEpoch: 1 });
      await connection.applySettings();
      expect(getSecret).toHaveBeenLastCalledWith('setup:second');
      expect(mocks.endpointStop).toHaveBeenCalled();
      expect(mocks.starts).toBe(2);
    } finally {
      await connection.disconnect();
      delete (mocks.config.tunnel as any).profileId; delete (mocks.config.tunnel as any).profileEpoch;
    }
  });

  it('keeps tunnel health scratch inside the active instance health namespace', async () => {
    const connection = await import('../src/main/connection.js');
    try {
      await connection.connect();
      expect(mocks.tunnelOptions).toHaveLength(1);
      expect(mocks.tunnelOptions[0]).toMatchObject({ healthRoot: 'C:\\instance-health' });
    } finally {
      await connection.disconnect();
    }
  });

  it('ignores retired Plugins tunnel reports after changing only its tunnel', async () => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.tunnelId = 'core-test';
    mocks.config.tunnel.pluginsTunnelId = 'plugins-before';
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    expect(mocks.starts).toBe(2);
    const oldReport = mocks.report!;
    mocks.config.tunnel.pluginsTunnelId = 'plugins-after';
    await connection.applySettings();
    expect(mocks.starts).toBe(3);
    expect(mocks.endpointStop).not.toHaveBeenCalled();
    oldReport({ state: 'error', detail: 'Retired failure', publicUrl: 'https://old.invalid' });
    expect(connection.getStatus().surfaces.find((s) => s.id === 'plugins')).toMatchObject({ state: 'live', detail: 'Connected.' });
    await connection.disconnect();
  });
  it('publishes refresh declarations only for live surfaces and does not rebuild on unchanged health reports', async () => {
    const connection = await import('../src/main/connection.js');
    const refresh = await import('../src/main/plugin-refresh.js');
    expect(refresh.pluginRefreshPublications()).toEqual([]);
    await connection.connect();
    expect(refresh.pluginRefreshPublications().map(row => row.surface)).toEqual(['core']);
    const first = refresh.pluginRefreshPublications()[0]!.schemaId;
    const calls = mocks.publication.mock.calls.length;
    mocks.report?.({ state: 'connected', detail: 'Still healthy' });
    expect(mocks.publication).toHaveBeenCalledTimes(calls);
    await connection.applySettings();
    expect(refresh.pluginRefreshPublications()[0]!.schemaId).toBe(first);
    await connection.disconnect();
    expect(refresh.pluginRefreshPublications()).toEqual([]);
  });

  it('republishes the live Core declaration when approved roots change without restarting transport', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    const calls = mocks.publication.mock.calls.length;
    const starts = mocks.starts;
    expect(mocks.approvedRootsRefresh).toBeTypeOf('function');

    mocks.config.roots = [
      { name: 'workspace', path: 'C:\\workspace' },
      { name: 'media', path: 'D:\\media' }
    ];
    mocks.approvedRootsRefresh!();

    expect(mocks.publication).toHaveBeenCalledTimes(calls + 1);
    expect(mocks.publication.mock.calls.at(-1)?.[0]).toBe('core');
    expect(mocks.starts).toBe(starts);
    expect(mocks.endpointStop).not.toHaveBeenCalled();

    await connection.disconnect();
    const disconnectedCalls = mocks.publication.mock.calls.length;
    mocks.approvedRootsRefresh!();
    expect(mocks.publication).toHaveBeenCalledTimes(disconnectedCalls);
    expect(mocks.starts).toBe(starts);
  });

  it('publishes Windows Desktop capability through Core without a second tunnel or connector card', async () => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.tunnelId = 'core-test';
    mocks.config.tunnel.desktopTunnelId = 'legacy-desktop-id';
    Object.assign(mocks.caps, { screen: true, control: true, clipboardRead: true, clipboardWrite: true });
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    const connected = connection.getStatus();
    expect(connected.surfaces.map(surface => surface.id)).toEqual(['core', 'plugins']);
    expect(connected.surfaces.find(surface => surface.id === 'core')?.tools).toEqual(expect.arrayContaining([
      'read', 'browser_tabs', 'list_apps', 'get_window_state', 'read_clipboard', 'write_clipboard'
    ]));
    expect(mocks.tunnelOptions.map(options => options.label)).toEqual(['core']);
    expect(mocks.starts).toBe(1);

    // A remembered pre-merge Desktop tunnel id is migration data only on Windows. Editing it
    // cannot create a second live publication or restart the working Core transport.
    mocks.config.tunnel.desktopTunnelId = 'another-legacy-desktop-id';
    await connection.applySettings();
    expect(mocks.tunnelOptions.map(options => options.label)).toEqual(['core']);
    expect(mocks.starts).toBe(1);
    expect(connection.getStatus().surfaces.some(surface => surface.id === 'desktop')).toBe(false);
    await connection.disconnect();
  });

  it('drops the previous tunnel state and URL from connector cards after disconnect', async () => {
    const connection = await import('../src/main/connection.js');

    await connection.connect();
    expect(connection.getStatus().surfaces.find((surface) => surface.id === 'core')).toMatchObject({
      state: 'live',
      publicUrl: 'https://example.trycloudflare.com/mcp/core/core-token'
    });

    await connection.disconnect();
    const disconnected = connection.getStatus();
    expect(disconnected.state).toBe('disconnected');
    expect(disconnected.surfaces.find((surface) => surface.id === 'core')).toMatchObject({
      state: 'off',
      localUrl: null,
      publicUrl: null,
      detail: ''
    });
  });

  it('keeps ordinary disconnect graceful and reserves forced MCP drain for final shutdown', async () => {
    const connection = await import('../src/main/connection.js');

    await connection.connect();
    await connection.disconnect();
    expect(mocks.endpointStop).toHaveBeenLastCalledWith();

    await connection.connect();
    await connection.shutdownConnection();
    expect(mocks.endpointStop).toHaveBeenLastCalledWith({ forceAfterMs: 30_000 });
  });

  it('publishes Disconnect immediately and coalesces 100 clicks while accepted work drains', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    let release!: () => void;
    mocks.endpointStop.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const stopping = connection.disconnect();
    expect(connection.getStatus().state).toBe('disconnecting');
    for (let click = 0; click < 100; click++) expect(connection.disconnect()).toBe(stopping);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    mocks.report?.({ state: 'connected', detail: 'late health report' });
    expect(connection.getStatus().state).toBe('disconnecting');
    expect(mocks.tunnelStop).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(mocks.endpointStop).toHaveBeenCalledTimes(1);
    expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
    expect(connection.getStatus().state).toBe('disconnected');
    await connection.connect();
    expect(connection.getStatus().state).toBe('connected');
  });

  it('lets final shutdown bound the ordinary drain already ahead of it in the lifecycle queue', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.endpointStop.mockImplementationOnce(() => gate);
    const stopping = connection.disconnect();
    await vi.waitFor(() => expect(mocks.endpointStop).toHaveBeenCalledTimes(1));
    mocks.endpointStop.mockImplementationOnce(async (options) => {
      expect(options).toEqual({ forceAfterMs: 30_000 });
      release();
    });
    await connection.shutdownConnection();
    await stopping;
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('cancels a queued Connect and permits an explicit Connect after Disconnect', async () => {
    const connection = await import('../src/main/connection.js');
    const connecting = connection.connect();
    const stopping = connection.disconnect();
    await Promise.all([connecting, stopping]);
    expect(mocks.starts).toBe(0);
    const disconnecting = connection.disconnect();
    const reconnecting = connection.connect();
    await Promise.all([disconnecting, reconnecting]);
    expect(connection.getStatus().state).toBe('connected');
  });

  it('bounds Disconnect when final shutdown arrives before its queued drain starts', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    const stopping = connection.disconnect();
    const shutdown = connection.shutdownConnection();
    await Promise.all([stopping, shutdown]);
    expect(mocks.endpointStop).toHaveBeenCalledWith({ forceAfterMs: 30_000 });
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('cancels an MCP endpoint that finishes starting after final shutdown was requested', async () => {
    let releaseEndpoint!: () => void;
    mocks.endpointStartGate = new Promise<void>((resolve) => {
      releaseEndpoint = resolve;
    });
    const connection = await import('../src/main/connection.js');

    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.endpointStartReached).toHaveBeenCalledTimes(1));
    const shuttingDown = connection.shutdownConnection();
    await shuttingDown;
    expect(connection.getStatus().state).toBe('disconnected');
    releaseEndpoint();
    await Promise.all([connecting, shuttingDown]);

    expect(mocks.starts).toBe(0);
    expect(mocks.prewarm).not.toHaveBeenCalled();
    expect(mocks.endpointStop).toHaveBeenCalledWith({ forceAfterMs: 30_000 });
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('does not publish a tunnel that finishes starting after final shutdown was requested', async () => {
    let releaseTunnel!: () => void;
    mocks.tunnelStartGate = new Promise<void>((resolve) => {
      releaseTunnel = resolve;
    });
    const connection = await import('../src/main/connection.js');

    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.tunnelStartReached).toHaveBeenCalledTimes(1));
    const shuttingDown = connection.shutdownConnection();
    await shuttingDown;
    expect(mocks.tunnelStop).not.toHaveBeenCalled();
    releaseTunnel();
    await Promise.all([connecting, shuttingDown]);

    expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.endpointStop).toHaveBeenCalledWith({ forceAfterMs: 30_000 });
    expect(connection.getStatus()).toMatchObject({ state: 'disconnected', publicUrl: null, localUrl: null });
  });

  it('finishes final shutdown without waiting for a parked credential lookup', async () => {
    let releaseSecret!: () => void;
    mocks.secretGate = new Promise<void>(resolve => { releaseSecret = resolve; });
    const connection = await import('../src/main/connection.js');
    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.secretReached).toHaveBeenCalledTimes(1));
    const shutdown = connection.shutdownConnection();
    let finished = false;
    void shutdown.then(() => { finished = true; });
    try {
      expect(mocks.endpointStop).toHaveBeenCalledWith({ forceAfterMs: 30_000 });
      await vi.waitFor(() => expect(finished).toBe(true));
      expect(connection.getStatus().state).toBe('disconnected');
      expect(mocks.starts).toBe(0);
    } finally {
      releaseSecret();
      await Promise.all([connecting, shutdown]);
    }
    expect(mocks.starts).toBe(0);
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('joins the entire existing teardown, including tunnel retirement after the response drain', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    let releaseDrain!: () => void;
    const drain = new Promise<void>(resolve => { releaseDrain = resolve; });
    let releaseTunnel!: () => void;
    const tunnelStop = new Promise<void>(resolve => { releaseTunnel = resolve; });
    mocks.endpointStop.mockImplementationOnce(() => drain).mockImplementationOnce(() => drain);
    mocks.tunnelStop.mockImplementationOnce(() => tunnelStop);
    const disconnect = connection.disconnect();
    await vi.waitFor(() => expect(mocks.endpointStop).toHaveBeenCalledTimes(1));
    let finished = false;
    const shutdown = connection.shutdownConnection().then(() => { finished = true; });
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finished).toBe(false);
      expect(mocks.tunnelStop).not.toHaveBeenCalled();
      releaseDrain();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
      expect(finished).toBe(false);
      releaseTunnel();
      await Promise.all([disconnect, shutdown]);
      expect(connection.getStatus().state).toBe('disconnected');
    } finally {
      releaseDrain();
      releaseTunnel();
      await Promise.all([disconnect, shutdown]);
      vi.useRealTimers();
    }
  });

  it('retires a late optional tunnel after shutdown without publishing or leaking it', async () => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.tunnelId = 'core-test';
    mocks.config.tunnel.pluginsTunnelId = 'plugins-test';
    let releaseOptional!: () => void;
    mocks.optionalStartGate = new Promise<void>(resolve => { releaseOptional = resolve; });
    const connection = await import('../src/main/connection.js');
    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.optionalStartReached).toHaveBeenCalledTimes(1));
    let finished = false;
    const shutdown = connection.shutdownConnection().then(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(finished).toBe(true));
      expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
      expect(connection.getStatus().state).toBe('disconnected');
    } finally {
      releaseOptional();
      await Promise.all([connecting, shutdown]);
    }
    expect(mocks.tunnelStop).toHaveBeenCalledTimes(2);
    expect(connection.getStatus().surfaces.every(surface => surface.state === 'off' && surface.publicUrl === null)).toBe(true);
  });

  it.each(['core', 'plugins'] as const)('keeps a late %s transport alive until accepted responses drain', async surface => {
    mocks.config.tunnel.kind = 'openai';
    mocks.config.tunnel.pluginsTunnelId = surface === 'plugins' ? 'plugins-test' : '';
    let releaseStart!: () => void;
    const startup = new Promise<void>(resolve => { releaseStart = resolve; });
    if (surface === 'core') mocks.tunnelStartGate = startup;
    else mocks.optionalStartGate = startup;
    const connection = await import('../src/main/connection.js');
    const connecting = connection.connect();
    await vi.waitFor(() => expect(surface === 'core' ? mocks.tunnelStartReached : mocks.optionalStartReached).toHaveBeenCalled());
    let releaseDrain!: () => void;
    const drain = new Promise<void>(resolve => { releaseDrain = resolve; });
    mocks.endpointStop.mockImplementationOnce(() => drain);
    const shutdown = connection.shutdownConnection();
    vi.useFakeTimers();
    try {
      releaseStart();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.tunnelStop).not.toHaveBeenCalled();
      expect(connection.getStatus().state).toBe('disconnecting');
      releaseDrain();
      await Promise.all([connecting, shutdown]);
      expect(mocks.tunnelStop).toHaveBeenCalledTimes(surface === 'core' ? 1 : 2);
      expect(connection.getStatus().state).toBe('disconnected');
    } finally {
      releaseStart();
      releaseDrain();
      await Promise.all([connecting, shutdown]);
      vi.useRealTimers();
    }
  });

  it('tears down the local endpoint when Keychain lookup resumes after final shutdown', async () => {
    let releaseSecret!: () => void;
    mocks.secretGate = new Promise<void>((resolve) => {
      releaseSecret = resolve;
    });
    const connection = await import('../src/main/connection.js');

    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.secretReached).toHaveBeenCalledTimes(1));
    const shuttingDown = connection.shutdownConnection();
    releaseSecret();
    await Promise.all([connecting, shuttingDown]);

    expect(mocks.starts).toBe(0);
    expect(mocks.endpointStop).toHaveBeenCalledWith({ forceAfterMs: 30_000 });
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('cancels tunnel startup through the same graceful endpoint-before-tunnel drain', async () => {
    let releaseTunnel!: () => void;
    mocks.tunnelStartGate = new Promise<void>(resolve => { releaseTunnel = resolve; });
    const connection = await import('../src/main/connection.js');
    const connecting = connection.connect();
    await vi.waitFor(() => expect(mocks.tunnelStartReached).toHaveBeenCalledTimes(1));
    let releaseDrain!: () => void;
    mocks.endpointStop.mockImplementationOnce(() => new Promise<void>(resolve => { releaseDrain = resolve; }));
    const stopping = connection.disconnect();
    releaseTunnel();
    await vi.waitFor(() => expect(releaseDrain).toBeTypeOf('function'));
    expect(mocks.endpointStop).toHaveBeenLastCalledWith();
    expect(mocks.tunnelStop).not.toHaveBeenCalled();
    expect(connection.getStatus().state).toBe('disconnecting');
    releaseDrain();
    await Promise.all([connecting, stopping]);
    expect(mocks.tunnelStop).toHaveBeenCalledTimes(1);
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('keeps ordinary disconnect reconnectable while final shutdown remains terminal', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    await connection.disconnect();
    await connection.connect();
    expect(mocks.starts).toBe(2);
    expect(connection.getStatus().state).toBe('connected');

    await connection.shutdownConnection();
    await connection.connect();
    expect(mocks.starts).toBe(2);
    expect(connection.getStatus().state).toBe('disconnected');
  });

  it('shows terminal tunnel reports as connector errors instead of an endless starting state', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();

    mocks.report?.({ state: 'tunnel-unavailable', detail: 'cloudflared stopped unexpectedly' });

    const failed = connection.getStatus();
    expect(failed.state).toBe('tunnel-unavailable');
    expect(failed.surfaces.find((surface) => surface.id === 'core')).toMatchObject({
      state: 'error',
      detail: 'cloudflared stopped unexpectedly'
    });
  });

  it('reconnects Core when its transport method changes instead of mixing old and new methods', async () => {
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    expect(mocks.starts).toBe(1);

    mocks.config.tunnel.kind = 'manual';
    await connection.applySettings();

    expect(mocks.starts).toBe(2);
    expect(connection.getStatus().state).toBe('connected');
  });

  it('prewarms the helper only when a native Desktop capability is published', async () => {
    mocks.caps.screen = true;
    const connection = await import('../src/main/connection.js');
    await connection.connect();
    // Windows and macOS have native helpers. Linux masks the same stored preference from the
    // live surface, so it intentionally does not prewarm anything.
    expect(mocks.prewarm).toHaveBeenCalledTimes(process.platform === 'win32' || process.platform === 'darwin' ? 1 : 0);
  });

  it('does not let a Desktop permission hide a missing root required by Core capabilities', async () => {
    mocks.config.roots = [];
    mocks.caps.screen = true;
    const connection = await import('../src/main/connection.js');

    await connection.connect();

    expect(mocks.starts).toBe(0);
    expect(connection.getStatus()).toMatchObject({
      state: 'disconnected',
      detail: 'Add a folder before connecting.'
    });
  });

  it('still requires a root for command even though command execution itself is not root-confined', async () => {
    mocks.config.roots = [];
    mocks.config.readOnly = false;
    Object.assign(mocks.caps, {
      browse: false,
      search: false,
      read: false,
      metadata: false,
      command: true,
      screen: true
    });
    const connection = await import('../src/main/connection.js');

    await connection.connect();

    expect(mocks.starts).toBe(0);
    expect(connection.getStatus().detail).toBe('Add a folder before connecting.');
  });

  it('keeps genuinely rootless Desktop and clipboard setups connectable', async () => {
    mocks.config.roots = [];
    Object.assign(mocks.caps, {
      browse: false,
      search: false,
      read: false,
      metadata: false,
      screen: true
    });
    const desktop = await import('../src/main/connection.js');
    await desktop.connect();
    expect(desktop.getStatus().state).toBe('connected');
    expect(mocks.starts).toBe(1);

    await desktop.disconnect();
    mocks.caps.screen = false;
    mocks.caps.clipboardRead = true;
    await desktop.connect();
    expect(desktop.getStatus().state).toBe('connected');
    expect(mocks.starts).toBe(2);
  });
});

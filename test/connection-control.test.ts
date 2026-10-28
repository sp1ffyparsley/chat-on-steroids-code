import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
const state = vi.hoisted(() => ({
  id: 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4',
  config: { tunnel: { kind: 'openai', tunnelId: 'keep-id', binaryPath: 'keep-path' }, ui: { automationPaused: true }, roots: ['keep-root'] },
  blockers: [] as object[]
}));
vi.mock('../src/main/config.js', () => ({
  assertActiveSecureTunnelIsolation: vi.fn(async () => {}),
  getActiveInstanceRuntime: () => ({ profile: { id: state.id, bridge: { port: 8770 } } }), getConfig: () => state.config,
  getActiveInstanceOwnerPaths: () => ({ runtimeRoot: '/test/runtime', durableStoreRoot: '/test/state' }),
  updateConfig: vi.fn(async updater => { state.config = updater(state.config); return state.config; })
}));
vi.mock('../src/main/connection.js', () => ({
  connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), applySettings: vi.fn(async () => {}),
  getStatus: () => ({ state: 'connected', detail: 'https://secret/path', publicUrl: 'secret', localUrl: 'secret',
    health: { token: 'secret' }, handshakeAt: 1, lastRequestAt: 2, lastToolCallAt: 3,
    surfaces: [{ id: 'core', state: 'connected', connectorName: 'Exact Core', description: 'Exact account Core connector', publicUrl: 'https://secret/path' }] })
}));
vi.mock('../src/main/profile-work-state.js', () => ({
  activeProfileWorkCensus: vi.fn(async () => ({ profileId: state.id, blockers: state.blockers }))
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
import { controlConnection, getConnectionControlStatus } from '../src/main/connection-control.js';
import { applySettings, connect, disconnect } from '../src/main/connection.js';
import { assertActiveSecureTunnelIsolation, updateConfig } from '../src/main/config.js';
import { activeProfileWorkCensus } from '../src/main/profile-work-state.js';
import { profileWorkAdmission } from '../src/main/work-admission.js';
import { configureSettingsControl, readAgentSettings } from '../src/main/settings-control.js';
import { operatorInputDirectory, processOperatorSettingsControl } from '../src/main/operator-input.js';
import { initDurableStore } from '../src/main/durable.js';

beforeEach(() => {
  vi.clearAllMocks(); state.blockers = [];
  state.config = { tunnel: { kind: 'openai', tunnelId: 'keep-id', binaryPath: 'keep-path' }, ui: { automationPaused: true }, roots: ['keep-root'] };
  const owner = profileWorkAdmission.snapshot().owner;
  if (owner) profileWorkAdmission.release(owner);
});
describe('exact-account connection control', () => {
  it('corrects only the exact account Core tunnel through the idle connection owner', async () => {
    const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
    await controlConnection({ instanceId: state.id, action: 'configure', kind: 'openai', tunnelId });
    expect(state.config.tunnel.tunnelId).toBe(tunnelId);
    expect(assertActiveSecureTunnelIsolation).toHaveBeenCalledWith(expect.objectContaining({ tunnelId }));
    expect(state.config.ui.automationPaused).toBe(true);
    expect(applySettings).toHaveBeenCalledOnce();
  });
  it('rejects a private tunnel collision before settings change or transport startup', async () => {
    vi.mocked(assertActiveSecureTunnelIsolation).mockRejectedValueOnce(new Error('Account tunnel collision'));
    await expect(controlConnection({ instanceId: state.id, action: 'configure', kind: 'openai' })).rejects.toThrow(/Connection control failed/);
    expect(updateConfig).not.toHaveBeenCalled(); expect(applySettings).not.toHaveBeenCalled();
    expect(profileWorkAdmission.snapshot().mode).toBe('open');
  });
  it('applies background settings through the registered Save owner and retains exact non-replay receipts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-operator-settings-'));
    initDurableStore(root);
    const schema = z.object({ tunnel: z.object({ kind: z.string(), tunnelId: z.string(), binaryPath: z.string() }),
      ui: z.object({ automationPaused: z.boolean() }), roots: z.array(z.string()) });
    const save = vi.fn(async ({ patch }: { patch: unknown }) => { state.config = patch as typeof state.config; });
    configureSettingsControl({ schema, save });
    const receipt = randomUUID(), inbox = operatorInputDirectory(root);
    await mkdir(inbox, { recursive: true });
    const file = path.join(inbox, `${receipt}.settings.json`);
    await writeFile(file, JSON.stringify({ instanceId: state.id, revision: readAgentSettings().revision,
      patch: { ui: { automationPaused: false } } }));
    const args = ['--cos-settings-action=update', `--cos-settings-profile=${state.id}`, `--cos-settings-receipt=${receipt}`];
    await expect(processOperatorSettingsControl(args, root)).resolves.toMatchObject({ state: 'completed' });
    expect(save).toHaveBeenCalledOnce(); expect(state.config.ui.automationPaused).toBe(false);
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await processOperatorSettingsControl(args, root); expect(save).toHaveBeenCalledOnce();
    const staleReceipt = randomUUID(), staleArgs = args.map(arg => arg.startsWith('--cos-settings-receipt=') ? `--cos-settings-receipt=${staleReceipt}` : arg);
    await writeFile(path.join(inbox, `${staleReceipt}.settings.json`), JSON.stringify({ instanceId: state.id,
      revision: '0'.repeat(64), patch: { ui: { automationPaused: true } } }));
    await expect(processOperatorSettingsControl(staleArgs, root)).resolves.toMatchObject({ state: 'failed' });
    expect(save).toHaveBeenCalledOnce(); expect(state.config.ui.automationPaused).toBe(false);
    await expect(processOperatorSettingsControl(['--cos-settings-action=read', '--cos-settings-profile=wrong',
      `--cos-settings-receipt=${randomUUID()}`], root)).rejects.toThrow(/another account/);
  });
  it('projects no secret URLs, diagnostic text or arbitrary tunnel health', () => {
    expect(getConnectionControlStatus()).toEqual({ instanceId: state.id, kind: 'openai', state: 'connected',
      handshakeAt: 1, lastRequestAt: 2, lastToolCallAt: 3, surfaces: [{ id: 'core', state: 'connected', setupAvailable: true }] });
    expect(JSON.stringify(getConnectionControlStatus())).not.toContain('secret');
  });
  it('discloses exact setup only to the explicit exact-account action without mutating busy work', async () => {
    state.blockers = [{ category: 'mcp-request', count: 1 }];
    profileWorkAdmission.beginDrain('existing');
    await expect(controlConnection({ instanceId: state.id, action: 'setup' })).resolves.toEqual({
      instanceId: state.id, kind: 'openai', surfaces: [{ id: 'core', name: 'Exact Core',
        description: 'Exact account Core connector', url: 'https://secret/path' }]
    });
    await expect(controlConnection({ instanceId: 'wrong-profile', action: 'setup' })).rejects.toThrow(/different account/);
    expect(profileWorkAdmission.snapshot().owner).toBe('existing');
    expect(connect).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled(); expect(updateConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(getConnectionControlStatus())).not.toContain('secret');
  });
  it('updates only the kind through config and existing applySettings owner', async () => {
    await controlConnection({ instanceId: state.id, action: 'configure', kind: 'cloudflared' });
    expect(state.config).toEqual({ tunnel: { kind: 'cloudflared', tunnelId: 'keep-id', binaryPath: 'keep-path' }, ui: { automationPaused: true }, roots: ['keep-root'] });
    expect(applySettings).toHaveBeenCalledOnce(); expect(connect).not.toHaveBeenCalled();
    expect(profileWorkAdmission.snapshot().mode).toBe('open');
  });
  it.each(['connect', 'disconnect'] as const)('routes %s to the existing owner', async action => {
    await controlConnection({ instanceId: state.id, action });
    expect(action === 'connect' ? connect : disconnect).toHaveBeenCalledOnce();
  });
  it('refuses a wrong account before changing config or admission', async () => {
    const before = profileWorkAdmission.snapshot();
    await expect(controlConnection({ instanceId: 'wrong-profile', action: 'connect' })).rejects.toThrow(/different account/);
    expect(connect).not.toHaveBeenCalled(); expect(updateConfig).not.toHaveBeenCalled();
    expect(profileWorkAdmission.snapshot()).toEqual(before);
  });
  it('rechecks exact account identity after the asynchronous census', async () => {
    const original = state.id;
    let finish!: (value: { profileId: string; blockers: [] }) => void;
    vi.mocked(activeProfileWorkCensus).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const result = controlConnection({ instanceId: original, action: 'connect' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    state.id = 'different-profile';
    finish({ profileId: original, blockers: [] });
    await expect(result).rejects.toThrow(/different account/);
    state.id = original;
    expect(connect).not.toHaveBeenCalled(); expect(profileWorkAdmission.snapshot().mode).toBe('open');
  });
  it.each(['configure', 'connect', 'disconnect'] as const)('refuses %s with active work and releases its temporary fence', async action => {
    state.blockers = [{ category: 'mcp-request', count: 1 }];
    await expect(controlConnection({ instanceId: state.id, action, ...(action === 'configure' ? { kind: 'manual' as const } : {}) })).rejects.toThrow(/idle/);
    expect(updateConfig).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled();
    expect(profileWorkAdmission.snapshot().mode).toBe('open');
  });
  it('allows read status while busy without acquiring admission', async () => {
    state.blockers = [{ category: 'active-turn', count: 1 }]; profileWorkAdmission.beginDrain('existing');
    await expect(controlConnection({ instanceId: state.id, action: 'status' })).resolves.toMatchObject({ instanceId: state.id });
    expect(profileWorkAdmission.snapshot().owner).toBe('existing');
  });
  it('preserves another lifecycle owner and rejects malformed mixed requests', async () => {
    profileWorkAdmission.beginDrain('existing');
    await expect(controlConnection({ instanceId: state.id, action: 'connect' })).rejects.toThrow(/lifecycle/);
    expect(profileWorkAdmission.snapshot().owner).toBe('existing');
    for (const value of [{ instanceId: state.id, action: 'connect', kind: 'manual' },
      { instanceId: state.id, action: 'configure' }, { instanceId: state.id, action: 'configure', kind: 'unsupported' },
      { instanceId: state.id, action: 'status', token: 'secret' }])
      await expect(controlConnection(value as never)).rejects.toThrow(/unknown fields/);
  });
  it('redacts upstream failure values and releases admission without undoing committed config', async () => {
    vi.mocked(applySettings).mockRejectedValueOnce(new Error('https://secret.example/path'));
    await expect(controlConnection({ instanceId: state.id, action: 'configure', kind: 'manual' })).rejects.toThrow(/Saved settings may already/);
    expect(state.config.tunnel.kind).toBe('manual'); expect(profileWorkAdmission.snapshot().mode).toBe('open');
  });
});


it('configures one external manual route while preserving pause, roots and existing tunnel identity', async () => {
  await controlConnection({ instanceId: state.id, action: 'configure', kind: 'manual', manualPublicOrigin: 'https://Delta.example.com/', manualPort: 9770 });
  expect(state.config.tunnel).toMatchObject({ kind: 'manual', manualPublicOrigin: 'https://Delta.example.com', manualPort: 9770, tunnelId: 'keep-id' });
  expect(state.config.ui.automationPaused).toBe(true);
  expect(state.config.roots).toEqual(['keep-root']);
  expect(getConnectionControlStatus()).toMatchObject({ externalOrigin: 'https://Delta.example.com', localOrigin: null, httpHostHeader: '127.0.0.1' });
  expect(JSON.stringify(getConnectionControlStatus())).not.toContain('secret');
  await expect(controlConnection({ instanceId: state.id, action: 'configure', kind: 'manual', manualPort: 8770 })).rejects.toThrow(/distinct/);
  expect(updateConfig).toHaveBeenCalledTimes(1);
});

it('refuses malformed or misplaced external controls before any settings mutation', async () => {
  for (const request of [
    { action: 'status', manualPublicOrigin: 'https://Delta.example.com' },
    { action: 'configure', kind: 'cloudflared', manualPort: 9770 },
    { action: 'configure', kind: 'manual', manualPublicOrigin: 'http://Delta.example.com' },
    { action: 'configure', kind: 'manual', manualPublicOrigin: 'https://user:secret@Delta.example.com' },
    { action: 'configure', kind: 'manual', manualPort: 80 }
  ]) await expect(controlConnection({ instanceId: state.id, ...request } as any)).rejects.toThrow();
  expect(updateConfig).not.toHaveBeenCalled();
});


it('does not replay a completed local connection receipt with a different external hostname or port', async () => {
  const { processOperatorConnectionControl } = await import('../src/main/operator-input.js');
  const { rm } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cos-external-receipt-'));
  try {
    initDurableStore(root);
    const receipt = randomUUID();
    const argv = ['--cos-connection-action=configure', `--cos-connection-profile=${state.id}`, `--cos-connection-receipt=${receipt}`,
      '--cos-connection-kind=manual', '--cos-connection-origin=https://Delta.example.com', '--cos-connection-port=9770'];
    const controller = vi.fn(async () => ({ state: 'disconnected' }));
    await processOperatorConnectionControl(argv, controller, root);
    await processOperatorConnectionControl(argv, controller, root);
    expect(controller).toHaveBeenCalledOnce();
    for (const changed of [argv.map(arg => arg.startsWith('--cos-connection-origin=') ? '--cos-connection-origin=https://Epsilon.example.com' : arg),
      argv.map(arg => arg.startsWith('--cos-connection-port=') ? '--cos-connection-port=9771' : arg)])
      await expect(processOperatorConnectionControl(changed, controller, root)).rejects.toThrow(/another operation/);
    expect(controller).toHaveBeenCalledOnce();
  } finally { await rm(root, { recursive: true, force: true }); }
});

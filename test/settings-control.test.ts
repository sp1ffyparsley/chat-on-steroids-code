import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

const state = vi.hoisted(() => ({ config: {} as Record<string, any>, active: 'child', root: '/accounts/child' }));
vi.mock('../src/main/config.js', () => ({
  getConfig: () => state.config,
  getActiveInstanceRuntime: () => ({ profile: state.config.instances.profiles.find((p: any) => p.id === state.active) }),
  getActiveInstanceOwnerPaths: () => ({ stateRoot: state.root })
}));
vi.mock('../src/main/connection-control.js', () => ({ getConnectionControlStatus: () => ({ instanceId: state.active }) }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
import { configureSettingsControl, readAgentSettings, updateAgentSettings, readRemoteAgentSettings, updateRemoteAgentSettings } from '../src/main/settings-control.js';

const schema = z.object({ mcp: z.object({ instructions: z.string() }).optional(), ui: z.object({ theme: z.string(), followOutput: z.boolean().optional(), automationPaused: z.boolean() }),
  sessions: z.object({ record: z.boolean() }), goal: z.object({ enabled: z.boolean(), prompt: z.string().optional() }), capabilities: z.record(z.string(), z.boolean()).optional(), tunnel: z.object({ kind: z.string() }) });
const save = vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => { Object.assign(state.config, patch); });
beforeEach(() => {
  vi.clearAllMocks(); state.active = 'child'; state.root = '/accounts/child';
  state.config = { ui: { theme: 'light', automationPaused: true }, sessions: { record: true }, goal: { enabled: true },
    tunnel: { kind: 'openai' }, roots: [],
    instances: { sharedFolderAccess: { enabled: true, platform: 'linux', deviceId: 'device' }, profiles: [
      { id: 'primary', displayName: 'Main Account', platform: 'linux', deviceId: 'device', state: { mode: 'legacy', root: '/accounts' } },
      { id: 'child', displayName: 'Business', platform: 'linux', deviceId: 'device', state: { mode: 'isolated', root: '/accounts/child' } }
    ] }, sharedAccountPreferences: { preferences: { version: 1, ui: { theme: 'light' } } } };
  save.mockImplementation(async ({ patch }) => { Object.assign(state.config, patch); });
  configureSettingsControl({ schema, save });
});
function update(patch: Record<string, unknown>) {
  return updateAgentSettings({ instanceId: state.active, revision: readAgentSettings().revision, patch });
}
it('reports the actual shared leaf fields and exact primary owner', () => {
  expect(readAgentSettings().sharedPreferences).toEqual({ enabled: true, isOwner: false,
    owner: { instanceId: 'primary', displayName: 'Main Account' }, fields: ['ui.theme'] });
});
it('refuses mixed shared and local edits before Save with exact owner guidance', async () => {
  await expect(update({ ui: { theme: 'dark', automationPaused: false } })).rejects.toThrow(/--profile primary \(Main Account\)/);
  expect(save).not.toHaveBeenCalled(); expect(state.config.ui.automationPaused).toBe(true);
});
it('allows local fields and unchanged shared fields in child updates', async () => {
  await expect(update({ ui: { theme: 'light', automationPaused: false } })).resolves.toMatchObject({ settings: { ui: { automationPaused: false } } });
  expect(save).toHaveBeenCalledOnce();
});
it('allows primary edits through the existing Save owner', async () => {
  state.active = 'primary'; state.root = '/accounts';
  await expect(update({ ui: { theme: 'dark' } })).resolves.toMatchObject({ settings: { ui: { theme: 'dark' } } });
  expect(save).toHaveBeenCalledOnce();
});
it('uses actual owner paths with Windows case normalization rather than trusting the profile id alone', () => {
  state.config.instances.profiles.forEach((profile: any) => { profile.platform = 'win32'; });
  state.config.instances.sharedFolderAccess.platform = 'win32';
  state.config.instances.profiles[0].state.root = 'C:\\Accounts';
  state.active = 'primary'; state.root = 'c:\\ACCOUNTS';
  expect(readAgentSettings().sharedPreferences.isOwner).toBe(true);
  state.root = 'C:\\Accounts\\child';
  expect(readAgentSettings().sharedPreferences.isOwner).toBe(false);
});
it('allows private edits after sharing is disabled', async () => {
  state.config.instances.sharedFolderAccess.enabled = false;
  await expect(update({ ui: { theme: 'dark' } })).resolves.toMatchObject({ settings: { ui: { theme: 'dark' } } });
});
it('fails rather than reporting completion if Save overrides a requested field', async () => {
  save.mockImplementationOnce(async () => { state.config.ui.automationPaused = true; });
  await expect(update({ ui: { automationPaused: false } })).rejects.toThrow(/not fully applied/);
});
it('accepts a dependency change outside the requested edit but detects explicitly overridden values', async () => {
  save.mockImplementationOnce(async ({ patch }) => { Object.assign(state.config, patch); state.config.goal.enabled = false; });
  await expect(update({ sessions: { record: false } })).resolves.toMatchObject({ settings: { goal: { enabled: false } } });
  save.mockImplementationOnce(async ({ patch }) => { Object.assign(state.config, patch); state.config.goal.enabled = false; });
  await expect(update({ goal: { enabled: true } })).rejects.toThrow(/setting dependency/);
});
it('retains prototype and stale revision rejection', async () => {
  await expect(update(JSON.parse('{"ui":{"__proto__":{"theme":"dark"}}}'))).rejects.toThrow(/Unknown setting/);
  await expect(updateAgentSettings({ instanceId: 'child', revision: '0'.repeat(64), patch: { ui: { automationPaused: false } } })).rejects.toThrow(/changed since inspection/);
  expect(save).not.toHaveBeenCalled();
});

it('remote inspection excludes private prompts, native paths, permissions and automation holds', () => {
  state.config.goal.prompt = 'PRIVATE_PROMPT'; state.config.capabilities = { command: true };
  const local = readAgentSettings();
  expect(local.settings.goal).toMatchObject({ prompt: 'PRIVATE_PROMPT' });
  expect(local).toHaveProperty('paths.stateRoot', '/accounts/child');
  const result = readRemoteAgentSettings();
  expect(result.settings).toEqual({ ui: { theme: 'light' } });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_PROMPT|automationPaused|capabilities|accounts\/child/);
  expect(result).not.toHaveProperty('paths'); expect(result).not.toHaveProperty('profile');
});
it.each([{ capabilities: { command: true } }, { readOnly: false }, { ui: { privacyScreenshots: false } },
  { multiAgent: { limitAutomaticChats: 8 } }, { compaction: { autoTokens: 1000 } },
  { ui: { automationPaused: false } }, { multiAgent: { enabled: true } }, { goal: { enabled: true } },
  { goal: { prompt: 'OVERRIDE' } }, { goal: { continuationPolicy: 'settled-turn' } },
  { sessions: { retainDays: 1 } }, { tunnel: { kind: 'cloudflared' } }, { sessions: { record: true } }])
  ('remote mutations refuse local authority fields before Save: %j', async patch => {
    await expect(updateRemoteAgentSettings({ instanceId: 'child', revision: readAgentSettings().revision, patch }))
      .rejects.toThrow(/local-only/);
    expect(save).not.toHaveBeenCalled(); expect(state.config.ui.automationPaused).toBe(true);
  });
it('remote permitted preference edits use Save and return only the remote projection', async () => {
  state.active = 'primary'; state.root = '/accounts';
  const result = await updateRemoteAgentSettings({ instanceId: 'primary', revision: readAgentSettings().revision, patch: { ui: { theme: 'dark' } } });
  expect(result.settings).toMatchObject({ ui: { theme: 'dark' } });
  expect(result).not.toHaveProperty('paths'); expect(save).toHaveBeenCalledOnce();
});

it('initializes supported optional fields and groups without allowing unknown settings', async () => {
  await expect(update({ ui: { followOutput: true }, mcp: { instructions: 'LOCAL_INSTRUCTIONS' } }))
    .resolves.toMatchObject({ settings: { ui: { followOutput: true }, mcp: { instructions: 'LOCAL_INSTRUCTIONS' } } });
  await expect(update({ mcp: { unknown: true } })).rejects.toThrow(/Unknown setting/);
});

/**
 * The settings handler, exercised through the channel the renderer actually uses.
 *
 * Only the part where two subsystems have to be shut down in the right order. The rest of
 * the IPC surface is thin validation over modules that have their own tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false }))
  },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  nativeTheme: { themeSource: 'system' },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  app: { getPath: () => '', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false }
}));

// This suite owns IPC behavior, not Electron's packaged-vs-checkout path discovery.
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd() }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: vi.fn(async () => 'chrome.exe') }));

const { defaultConfig, getActiveInstanceRuntime, getConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { clearSecret, initSecretsPath, resetSecretsCacheForTests, setSecret } = await import('../src/main/secrets.js');
const { appendEvent, createSession, getSession, initSessionStore, rebindSession, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } = await import('../src/main/durable.js');
const { applyAutomationPause, bridgeStatus, pendingCommands, resetBridgeForTests, setBrowserOpener, startBridge, stopBridge } = await import(
  '../src/main/bridge.js'
);
const {
  bindConversation,
  finishAgent,
  onRetiredWorkersPersist,
  onRetiredWorkersPersistNow,
  onSwarmPersist,
  onSwarmPersistNow,
  pauseSwarmForDisable,
  persistAgentAuthorityNow,
  pendingWorkerRevivals,
  releaseQuiescentRun,
  resetSwarm,
  restoreSwarm,
  sendMessage,
  snapshotRetiredWorkers,
  snapshotSwarm,
  spawn,
  swarmStateForCaller
} = await import('../src/main/agents.js');
const { registerIpc, setHelperReasoningAfterExplicitRequest, retireRecordedChatsAfterExplicitRequest } = await import('../src/main/ipc.js');
const { openInPreferredBrowser } = await import('../src/main/browser.js');
const { app, nativeTheme, safeStorage, shell, dialog } = await import('electron');
const { resetWorkspaces, setWorkspaceFor, workspaceEntries } = await import('../src/main/workspace.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
const fixturePath = (...parts: string[]): string => path.join(dir, ...parts);
let currentWindow: {
  setBackgroundColor: ReturnType<typeof vi.fn>;
  setTitleBarOverlay: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
} | null = null;
/** How many times the IPC layer asked the app to quit so a staged update can be applied. */
let quitToInstallCalls = 0;

const save = (patch: unknown, base: unknown = getConfig()): Promise<any> =>
  handlers.get('settings:save')!(null, { patch, base }) as Promise<any>;

it('saves explicit Loop policy through the local Save owner without stale unrelated saves revoking it', async () => {
  const before = getConfig();
  const enabled = { ...before, goal: { ...before.goal, continuationPolicy: 'settled-turn' } };
  expect(await save(enabled, before)).toMatchObject({ ok: true });
  expect(getConfig().goal).toHaveProperty('continuationPolicy', 'settled-turn');
  const staleCosmetic = { ...before, ui: { ...before.ui, followOutput: !before.ui.followOutput } };
  expect(await save(staleCosmetic, before)).toMatchObject({ ok: true });
  expect(getConfig().goal).toHaveProperty('continuationPolicy', 'settled-turn');
  const current = getConfig();
  expect(await save({ ...current, goal: { ...current.goal, continuationPolicy: 'strict' } }, current)).toMatchObject({ ok: true });
  expect(getConfig().goal).toHaveProperty('continuationPolicy', 'strict');
  expect(await save({ ...current, goal: { ...current.goal, continuationPolicy: 'always-send' } }, current)).toMatchObject({ ok: false });
  expect(getConfig().goal).toHaveProperty('continuationPolicy', 'strict');
});

it('publishes queued keep-awake On then Off in Save order and preserves Off on an unrelated stale save', async () => {
  const { createKeepAwake, installKeepAwake } = await import('../src/main/keep-awake.js');
  const before = { ...getConfig(), ui: { ...getConfig().ui, keepAwake: false } };
  await saveConfig(before);
  const states: string[] = [];
  const awake = createKeepAwake({
    enabled: () => getConfig().ui.keepAwake !== false,
    sessions: async () => [{ id: 'ipc-awake', endedAt: null, activityExpiresAt: Date.now() + 30_000 }] as any,
    blocker: { start: () => { states.push(`start:${getConfig().ui.keepAwake}`); return 17; },
      stop: id => { states.push(`stop:${id}:${getConfig().ui.keepAwake}`); } }
  });
  const uninstall = installKeepAwake(awake);
  try {
    const on = { ...before, ui: { ...before.ui, keepAwake: true } };
    const enabling = save(on, before);
    const disabling = save(before, on);
    expect(await enabling).toMatchObject({ ok: true });
    expect(await disabling).toMatchObject({ ok: true });
    expect(states).toEqual(['start:true', 'stop:17:false']);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.keepAwake).toBe(false);
    const cosmetic = { ...on, ui: { ...on.ui, followOutput: !on.ui.followOutput } };
    expect(await save(cosmetic, on)).toMatchObject({ ok: true });
    expect(getConfig().ui.keepAwake).toBe(false);
    expect(states).toEqual(['start:true', 'stop:17:false']);
    expect(await save({ ...before, ui: { ...before.ui, keepAwake: 'yes' } }, before)).toMatchObject({ ok: false });
    expect(getConfig().ui.keepAwake).toBe(false);
  } finally { uninstall(); }
});

it('releases the keep-awake hold at publication even if a later Save effect fails', async () => {
  const { createKeepAwake, installKeepAwake } = await import('../src/main/keep-awake.js');
  const blocker = { start: vi.fn(() => 23), stop: vi.fn() };
  const awake = createKeepAwake({ enabled: () => getConfig().ui.keepAwake !== false,
    sessions: async () => [{ id: 'ipc-effect-awake', endedAt: null, activityExpiresAt: Date.now() + 30_000 }] as any,
    blocker });
  const uninstall = installKeepAwake(awake);
  try {
    await awake.refresh();
    const before = getConfig();
    currentWindow = { setBackgroundColor: vi.fn(() => { throw new Error('native window effect failed'); }),
      setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
    expect(await save({ ...before, ui: { ...before.ui, keepAwake: false } }, before)).toMatchObject({ ok: false });
    expect(getConfig().ui.keepAwake).toBe(false);
    expect(blocker.stop).toHaveBeenCalledWith(23);
    expect(blocker.start).toHaveBeenCalledTimes(1);
  } finally { uninstall(); }
});

it('agent partial settings use the live Save owner and preserve unrelated account state', async () => {
  const { readAgentSettings, updateAgentSettings } = await import('../src/main/settings-control.js');
  const before = getConfig();
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
  const observed = readAgentSettings();
  const theme = before.ui.theme === 'dark' ? 'light' : 'dark';
  const result = await updateAgentSettings({ instanceId: observed.instanceId, revision: observed.revision, patch: { ui: { theme } } });
  expect(getConfig().ui.theme).toBe(theme);
  expect(nativeTheme.themeSource).toBe(theme);
  expect(currentWindow.setBackgroundColor).toHaveBeenCalledWith(theme === 'dark' ? '#0e0e11' : '#ffffff');
  expect(getConfig().roots).toEqual(before.roots);
  expect(getConfig().ui.automationPaused).toBe(before.ui.automationPaused);
  expect(result.revision).not.toBe(observed.revision);
  expect(observed.settings).not.toHaveProperty('secrets');
});

it('agent settings refuse stale revision, another account, invalid fields and self-reconnection before writes', async () => {
  const { readAgentSettings, updateAgentSettings } = await import('../src/main/settings-control.js');
  const observed = readAgentSettings();
  const request = { instanceId: observed.instanceId, revision: observed.revision, patch: { ui: { followOutput: !getConfig().ui.followOutput } } };
  await expect(updateAgentSettings({ ...request, instanceId: 'foreign-profile' })).rejects.toThrow('another account');
  await expect(updateAgentSettings({ ...request, patch: { ui: { autoConect: true } } })).rejects.toThrow('Unknown setting');
  await expect(updateAgentSettings({ ...request, patch: { sessions: { retainDays: -1 } } })).rejects.toThrow();
  await expect(updateAgentSettings({ ...request, patch: { tunnel: { kind: getConfig().tunnel.kind === 'openai' ? 'cloudflared' : 'openai' } } })).rejects.toThrow('background connection control');
  expect(readAgentSettings().revision).toBe(observed.revision);
  await updateAgentSettings(request);
  await expect(updateAgentSettings(request)).rejects.toThrow('changed since inspection');
});

it('an unchanged agent settings patch does not execute runtime Save effects', async () => {
  const { readAgentSettings, updateAgentSettings } = await import('../src/main/settings-control.js');
  const observed = readAgentSettings();
  nativeTheme.themeSource = 'system';
  await updateAgentSettings({ instanceId: observed.instanceId, revision: observed.revision, patch: {} });
  await updateAgentSettings({ instanceId: observed.instanceId, revision: observed.revision, patch: { ui: { theme: getConfig().ui.theme } } });
  expect(nativeTheme.themeSource).toBe('system');
  expect(readAgentSettings().revision).toBe(observed.revision);
});
const renameRoot = (payload: unknown): Promise<any> => handlers.get('roots:rename')!(null, payload) as Promise<any>;
const removeRoot = (payload: unknown): Promise<any> => handlers.get('roots:remove')!(null, payload) as Promise<any>;
const sessionEvents = (payload: unknown): Promise<any> => handlers.get('sessions:events')!(null, payload) as Promise<any>;
const sessionList = (): Promise<any> => handlers.get('sessions:list')!(null, undefined) as Promise<any>;

it('publishes current and provider-confirmed connector schemas separately through state:get', async () => {
  const refresh = await import('../src/main/plugin-refresh.js');
  refresh.resetPluginRefreshForTests();
  try {
    const tools = [{ name: 'read', description: 'Read fixture', inputSchema: { type: 'object', properties: {} } }];
    refresh.publishPluginSurface('core', 'Fixture Core', 'fixture', '', tools);
    const request = (await refresh.pendingPluginRefreshes())[0]!;
    const pending = await handlers.get('state:get')!(null, undefined) as any;
    expect(pending.ok).toBe(true);
    expect(pending.data.connectorSchemas).toEqual({ core: request.schemaId });
    expect(pending.data.confirmedConnectorSchemas).toEqual({});
    expect(await refresh.claimPluginRefresh({ ...request, appId: 'asdk_app_fixture', connectorName: 'Fixture Core', tools, alreadyCurrent: true })).toBe(true);
    const completed = await handlers.get('state:get')!(null, undefined) as any;
    expect(completed.ok).toBe(true);
    expect(completed.data.confirmedConnectorSchemas).toEqual({ core: request.schemaId });
  } finally { refresh.resetPluginRefreshForTests(); }
});

it('changes only the explicitly addressed account helper effort and retires stale drafts without resuming', async () => {
  const goal = await import('../src/main/goal.js');
  const base = defaultConfig();
  await saveConfig({ ...base, ui: { ...base.ui, automationPaused: true }, goal: {
    ...base.goal, enabled: true, helperReasoning: 'xhigh'
  } });
  const before = getConfig();
  const profileId = getActiveInstanceRuntime().profile.id;
  const chat = 'cafe4545-0000-4000-8000-000000004545';
  await goal.setGoalSwitchNow(chat, 'loop', true, true);
  goal.startGoalDraft({ sessionId: 'helper-setting-test', conversationId: chat, turnId: 'turn-helper-setting', deferStart: true });
  expect(goal.goalViewFor(chat)).not.toBeNull();
  await expect(setHelperReasoningAfterExplicitRequest(profileId, 'high')).resolves.toMatchObject({ profileId, reasoning: 'high' });
  expect(getConfig()).toEqual({ ...before, goal: { ...before.goal, helperReasoning: 'high' } });
  expect(goal.goalViewFor(chat)).toBeNull();
  expect(goal.goalSwitchFor(chat)).toMatchObject({ enabled: true, mode: 'loop', afterTurn: true });
  const retired = vi.spyOn(goal, 'retireGoalDrafts');
  try {
    await setHelperReasoningAfterExplicitRequest(profileId, 'high');
    expect(retired).not.toHaveBeenCalled();
    await expect(setHelperReasoningAfterExplicitRequest('wrong-profile', 'xhigh')).rejects.toThrow(/profile/i);
    await expect(setHelperReasoningAfterExplicitRequest(profileId, 'automatic')).rejects.toThrow();
    expect(getConfig().goal.helperReasoning).toBe('high');
  } finally { retired.mockRestore(); goal.resetGoalStateForTests(); }
});

it('sets explicitly requested new-chat, worker and helper defaults without changing pause or replaying inputs', async () => {
  const base = defaultConfig();
  await saveConfig({ ...base, ui: { ...base.ui, automationPaused: true } });
  const profileId = getActiveInstanceRuntime().profile.id;
  await setHelperReasoningAfterExplicitRequest(profileId, 'high', 'gpt-6-thinking');
  expect(getConfig().multiAgent).toMatchObject({ defaultModel: 'gpt-6-thinking', defaultReasoning: 'high' });
  expect(getConfig().goal).toMatchObject({ helperModel: 'gpt-6-thinking', helperReasoning: 'high' });
  expect(getConfig().ui.automationPaused).toBe(true);
  await expect(setHelperReasoningAfterExplicitRequest('wrong-profile', 'high', 'gpt-6-thinking')).rejects.toThrow(/profile/i);
  await expect(setHelperReasoningAfterExplicitRequest(profileId, 'high', '../bad')).rejects.toThrow();
});

it('retires only the explicitly addressed account chats through recoverable deletion and keeps automation paused', async () => {
  const first = await createSession({ title: 'Retire first', conversationId: 'retire-first' });
  const second = await createSession({ title: 'Retire second', conversationId: 'retire-second' });
  const profileId = getActiveInstanceRuntime().profile.id;
  await expect(retireRecordedChatsAfterExplicitRequest('wrong-profile')).rejects.toThrow(/profile/i);
  expect(await getSession(first.id)).not.toBeNull();
  const result = await retireRecordedChatsAfterExplicitRequest(profileId);
  expect(result.removed).toBeGreaterThanOrEqual(2);
  expect(await getSession(first.id)).toBeNull();
  expect(await getSession(second.id)).toBeNull();
  const { listDeletedSessions } = await import('../src/main/session/store.js');
  expect((await listDeletedSessions()).map(row => row.id)).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(getConfig().ui.automationPaused).toBe(true);
  expect((await retireRecordedChatsAfterExplicitRequest(profileId)).removed).toBe(0);
  await (await import('../src/main/session/store.js')).emptyDeletedSessions();
});

it('defaults Follow new output on and preserves it across stale settings saves', async () => {
  const base = defaultConfig();
  expect(base.ui.followOutput).toBe(true);
  await saveConfig(base);
  expect(await save({ ...base, ui: { ...base.ui, followOutput: false } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui.followOutput).toBe(false);
  expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.followOutput).toBe(false);

  const stale = { ...base, ui: { ...base.ui, theme: base.ui.theme === 'light' ? 'dark' as const : 'light' as const } };
  expect(await save(stale, base)).toMatchObject({ ok: true });
  expect(getConfig().ui).toMatchObject({ followOutput: false, theme: stale.ui.theme });
});

it('switches setup IDs and encrypted key ownership without changing shared settings', async () => {
  const { getSecret } = await import('../src/main/secrets.js');
  const original = getConfig();
  const tunnelA = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await saveConfig({ ...original, tunnel: { ...original.tunnel, tunnelId: tunnelA } });
  const secret = (value: string, profileId?: string) => handlers.get('secret:set')!(null, { value, profileId }) as Promise<any>;
  const profile = (payload: unknown) => handlers.get('setup:profile')!(null, payload) as Promise<any>;
  expect(await secret('fixture-setup-a')).toMatchObject({ ok: true });
  const added = await profile({ action: 'add', name: 'Second account' });
  expect(added).toMatchObject({ ok: true, data: { hasApiKey: false } });
  const second = getConfig().tunnel.profileId!;
  expect(getConfig().tunnel.tunnelId).toBe('');
  const shared = getConfig();
  expect(shared.roots).toEqual(original.roots); expect(shared.multiAgent).toEqual(original.multiAgent);
  expect(await secret('fixture-setup-b', second)).toMatchObject({ ok: true });
  const baseB = getConfig();
  expect(await save({ ...baseB, tunnel: { ...baseB.tunnel, tunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } })).toMatchObject({ ok: true });
  expect(await profile({ action: 'select', id: 'default' })).toMatchObject({ ok: true, data: { hasApiKey: true } });
  expect(getConfig().tunnel.tunnelId).toBe(tunnelA);
  expect(await getSecret('openaiApiKey')).toBe('fixture-setup-a');
  expect(await getSecret(`setup:${second}`)).toBe('fixture-setup-b');
  // A late write still names B even when A is now selected.
  await secret('fixture-setup-b-edited', second);
  expect(await getSecret('openaiApiKey')).toBe('fixture-setup-a');
  const stored = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
  expect(stored).not.toContain('fixture-setup-');
  expect((await profile({ action: 'select', id: second })).data.hasApiKey).toBe(true);
  expect(getConfig().tunnel.tunnelId).toBe('tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  expect(getConfig().setupProfiles).toHaveLength(1);
});

it('removes active and inactive profiles with their exact keys, preserving the final profile', async () => {
  const { getSecret } = await import('../src/main/secrets.js');
  const profile = (payload: unknown) => handlers.get('setup:profile')!(null, payload) as Promise<any>;
  const secret = (value: string, profileId?: string) => handlers.get('secret:set')!(null, { value, profileId }) as Promise<any>;
  await secret('fixture-default-key');
  await profile({ action: 'add', name: 'Second' });
  const second = getConfig().tunnel.profileId!;
  await secret('fixture-second-key', second);
  await profile({ action: 'add', name: 'Third' });
  const third = getConfig().tunnel.profileId!;
  await secret('fixture-third-key', third);
  expect(await profile({ action: 'remove', id: second })).toMatchObject({ ok: true });
  expect(getConfig().tunnel.profileId).toBe(third);
  expect(await getSecret(`setup:${second}`)).toBeNull();
  expect(await getSecret(`setup:${third}`)).toBe('fixture-third-key');
  expect(await profile({ action: 'remove', id: third })).toMatchObject({ ok: true, data: { hasApiKey: true } });
  expect(getConfig().tunnel.profileId).toBe('default');
  expect(await getSecret(`setup:${third}`)).toBeNull();
  expect(await secret('late-key', third)).toMatchObject({ ok: false });
  expect(await profile({ action: 'select', id: third })).toMatchObject({ ok: false });
  expect(await profile({ action: 'remove', id: 'default' })).toMatchObject({ ok: false });
  expect(await getSecret('openaiApiKey')).toBe('fixture-default-key');
});

it('rejects stale profile tunnel edits after A to B to A while accepting unrelated settings', async () => {
  const base = getConfig();
  await handlers.get('setup:profile')!(null, { action: 'add', name: 'Other' });
  await handlers.get('setup:profile')!(null, { action: 'select', id: 'default' });
  expect(await save({ ...base, tunnel: { ...base.tunnel, tunnelId: 'tunnel_cccccccccccccccccccccccccccccccc' } }, base)).toMatchObject({ ok: false });
  expect(await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base)).toMatchObject({ ok: true });
  expect(getConfig().tunnel.profileEpoch).toBe(2);
  expect(getConfig().setupProfiles).toHaveLength(1);
});

it('validates dropped file count and stages arbitrary native file types', async () => {
  const drop = (payload: unknown) => handlers.get('sessions:dropFiles')!(null, payload) as Promise<any>;
  expect(await drop({ files: [] })).toMatchObject({ ok: false });
  expect(await drop({ files: Array(21).fill('image.png') })).toMatchObject({ ok: false });
  expect(await drop({ files: [''] })).toMatchObject({ ok: false });
  expect(await drop({ files: [path.join(process.cwd(), 'package.json')] })).toMatchObject({ ok: true, data: [expect.objectContaining({ name: 'package.json', mimeType: 'application/json' })] });
});

it('publishes Goal draft progress through the session refresh channel without a new transcript event', async () => {
  const { startGoalDraft, resetGoalStateForTests } = await import('../src/main/goal.js');
  const session = await createSession({ title: 'Goal progress', conversationId: 'ipc-goal-progress' });
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
  try {
    startGoalDraft({ conversationId: session.conversationId!, sessionId: session.id, turnId: 'finished-turn', deferStart: true });
    expect(currentWindow.webContents.send).toHaveBeenCalledWith('session:changed');
  } finally {
    resetGoalStateForTests();
  }
});

it('stages clipboard image bytes with a preview through the general attachment owner', async () => {
  const drop = (payload: unknown) => handlers.get('sessions:dropFiles')!(null, payload) as Promise<any>;
  expect(await drop({ files: [] })).toMatchObject({ ok: false });
  expect(await drop({ files: [{ name: 'huge.png', bytes: new Uint8Array(12 * 1024 * 1024 + 1) }] })).toMatchObject({ ok: false });
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
  const pasted = await drop({ files: [{ name: 'screenshot.png', bytes: new Uint8Array(bytes) }] });
  expect(pasted).toMatchObject({ ok: true, data: [{ name: 'screenshot.png', size: bytes.length, mimeType: 'image/png', preview: expect.stringMatching(/^data:image\/webp;base64,/) }] });
  const { readInputAttachmentChunk } = await import('../src/main/session/input-attachments.js');
  expect(await readInputAttachmentChunk(pasted.data[0], 0)).toBe(bytes.toString('base64'));
});

it('does not authorize the composer Generate Goal action from an absent or stale finish wait', async () => {
  const generate = (payload: unknown) => handlers.get('sessions:generateFinishGoal')!(null, payload) as Promise<any>;
  const session = await createSession({ title: 'No finish wait', conversationId: 'finish-action-ipc-chat' });
  expect(await generate({ id: session.id })).toMatchObject({ ok: false });
  expect(await generate({ id: session.id, expectedTurnId: 'old-turn' })).toMatchObject({ ok: false });
});

it('reads session-owned helper custody through IPC while the ordinary outbox still hides planner bodies', async () => {
  const outbox = await import('../src/main/session/input.js');
  const original = await outbox.listInputs();
  const session = await createSession({ title: 'Private helper evidence', conversationId: 'ipc-helper-owned-conversation' });
  const at = Date.now();
  const helperId = '46cab2c3-1111-4111-8111-111111111111';
  try {
    await writeDurableNow('session-input', [{
      id: helperId, sessionId: null, text: 'PRIVATE helper instruction', mode: 'after-turn',
      dueAt: at - 900, model: 'gpt-6-thinking', reasoningEffort: 'high',
      purpose: 'decision', lifetime: 'temporary-planner', state: 'cancelled', owner: 'private-browser-document',
      requiresAuthorization: true, createdAt: at - 1000, sendAuthorizedAt: at - 800,
      deliveredAt: at - 500, messageId: 'original-native-helper-message',
      decisionSourceSessionId: session.id, decisionSourceTurnId: 'original-source-turn',
      response: 'PRIVATE helper decision', conversationId: 'private-helper-route'
    }]);
    outbox.resetInputForTests();
    expect((await handlers.get('sessions:outbox')!(null, undefined) as any).data).toEqual([]);
    const custody = await handlers.get('sessions:helperCustody')!(null, { id: session.id }) as any;
    expect(custody).toMatchObject({ ok: true, data: {
      sessionId: session.id, conversationId: 'ipc-helper-owned-conversation', retainedTotal: 1,
      helpers: [{ id: helperId, phase: 'cancelled-after-native-delivery', nativeSend: 'confirmed',
        answer: 'not-recorded', nativeMessageId: 'original-native-helper-message' }]
    } });
    expect(JSON.stringify(custody)).not.toMatch(/PRIVATE|private-browser-document|private-helper-route|helper instruction|helper decision/i);
    expect(await handlers.get('sessions:helperCustody')!(null, { id: 'missing-session-id' })).toMatchObject({ ok: true, data: null });
    expect(await handlers.get('sessions:helperCustody')!(null, { id: '' })).toMatchObject({ ok: false });
  } finally {
    await writeDurableNow('session-input', original);
    outbox.resetInputForTests();
  }
});

it('round-trips Goal controls and cannot revive old periodic input when Off cancellation fails then On retries', async () => {
  const outbox = await import('../src/main/session/input.js');
  const durable = await import('../src/main/durable.js');
  const store = await import('../src/main/session/store.js');
  const original = await outbox.listInputs();
  await writeDurableNow('session-input', []); outbox.resetInputForTests();
  const config = (minutes: number) => ({ ...settings({ record: true, multiAgent: false }),
    ui: { ...defaultConfig().ui, finishTool: true },
    goal: { ...defaultConfig().goal, impulseMinutes: minutes, includeToolCalls: true } });
  let write: ReturnType<typeof vi.spyOn> | undefined;
  try {
    expect(await save(config(1))).toMatchObject({ ok: true });
    expect(getConfig().goal).toMatchObject({ impulseMinutes: 1, includeToolCalls: true });
    const session = await createSession({ title: 'Periodic ownership', conversationId: 'periodic-settings-chat' });
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'periodic-turn', time: Date.now() });
    await store.observeSessionModel(session.id, 'periodic-settings-chat', 'gpt-6-astra', Date.now());
    const row = await outbox.enqueueInput({ id: 'f0f00014-1111-4111-8111-111111111111', sessionId: session.id,
      text: 'Pending automatic instruction', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null },
      { turnId: 'periodic-turn', periodic: false, userRequested: true });
    // Seed an old-version row; current code deliberately refuses new periodic input.
    await writeDurableNow('session-input', [{ ...row, finishOwner: { turnId: 'periodic-turn', periodic: true } }]);
    outbox.resetInputForTests();
    write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('Cancellation disk failure'));
    expect(await save(config(0))).toMatchObject({ ok: false });
    expect(getConfig().goal.impulseMinutes).toBe(0); // Off was published before retirement.
    write.mockRejectedValueOnce(new Error('Still cannot retire'));
    expect(await save(config(1))).toMatchObject({ ok: false });
    expect(getConfig().goal.impulseMinutes).toBe(0); // Failed retirement cannot publish On.
    write.mockRestore(); write = undefined;
    expect(await save(config(1))).toMatchObject({ ok: true });
    outbox.resetInputForTests();
    expect((await outbox.listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    expect(await outbox.offerToolInput(session.id, 'periodic-settings-chat', 'later-request', Date.now())).toEqual({ messages: [], reminder: '' });
  } finally {
    write?.mockRestore();
    await writeDurableNow('session-input', original); outbox.resetInputForTests();
  }
});

it('native opening cancellation aborts the exact IPC invocation and prevents a late ready result', async () => {
  const goal = await import('../src/main/goal.js');
  const requestId = 'ad3ecbf4-c3a1-4d0d-9e9f-619787bcf982';
  let signal: AbortSignal | undefined;
  const draft = vi.spyOn(goal, 'draftOpeningMessage').mockImplementation(async (_text, _mode, _progress, current) => {
    signal = current;
    return new Promise((_resolve, reject) => current!.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true }));
  });
  try {
    const opening = handlers.get('sessions:goalOpening')!(null, { text: 'Implement safely', mode: 'goal', requestId });
    const cancelled = await handlers.get('tasks:cancel')!(null, { requestId }) as any;
    expect(cancelled).toEqual({ ok: true, data: true });
    expect(signal?.aborted).toBe(true);
    expect(await opening).toMatchObject({ ok: false, error: 'task_cancelled' });
    expect(draft).toHaveBeenCalledTimes(1);
  } finally { draft.mockRestore(); }
});

it('projects exact retained workers under their parents without adopting unrelated recordings', async () => {
  const prime = await createSession({ title: 'Parent', conversationId: 'parent-projection' });
  spawn({ workers: [{ task: 'test parent identity' }], caller: { conversationId: 'parent-projection' } });
  expect(bindConversation('worker-1', 'worker-projection')).toBe(true);
  const origin = { kind: 'worker' as const, fromSessionId: null, agentId: 'worker-1', task: 'test parent identity' };
  // Simulate an old restart race: the recorder made a generic row before the worker-open
  // acknowledgement attached its origin. Exact durable broker ownership repairs the view.
  const child = await createSession({ title: 'ChatGPT session', conversationId: 'worker-projection' });
  const unrelated = await createSession({ title: 'Unrelated', conversationId: 'unrelated-worker', origin });
  const result = await sessionList();
  expect(result.ok).toBe(true);
  expect(result.data.sessions.find((row: any) => row.id === child.id)).toMatchObject({
    title: 'Parent · worker-1 · test parent identity',
    origin: { kind: 'worker', agentId: 'worker-1', task: 'test parent identity', fromSessionId: prime.id }
  });
  // Exact retained broker ownership repairs the durable owner too. A later restart/list must not
  // fall back to "ChatGPT session" just because the one projection above is gone.
  expect(await getSession(child.id)).toMatchObject({
    title: 'Parent · worker-1 · test parent identity',
    origin: { kind: 'worker', agentId: 'worker-1', task: 'test parent identity', fromSessionId: prime.id }
  });
  expect(result.data.sessions.find((row: any) => row.id === unrelated.id).origin.fromSessionId).toBeNull();
  restoreSwarm(null); // End this fixture without user-clear retiring it into later tests.
});

it('adds picker-selected projects, reuses containing approval, and leaves cancellation unchanged', async () => {
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
  const folder = path.join(dir, 'picker-project');
  await fs.mkdir(path.join(folder, 'child'), { recursive: true });
  await saveConfig({ ...defaultConfig(), roots: [] });
  await writeDurableNow('projects', []);
  const add = () => handlers.get('projects:add')!(null, {}) as Promise<any>;
  expect((await add()).data).toBeNull();
  expect(getConfig().roots).toHaveLength(0);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [folder] });
  const first = await add();
  expect(first.ok, first.error).toBe(true);
  expect(first.data.name).toBe('picker-project');
  expect(getConfig().roots).toHaveLength(1);
  expect((await add()).data.id).toBe(first.data.id);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [path.join(folder, 'child')] });
  expect((await add()).data.name).toBe('child');
  expect(getConfig().roots).toHaveLength(1);
  const listed = await handlers.get('projects:list')!(null, {}) as any;
  expect(listed.data).toHaveLength(2);
  const removed = await handlers.get('projects:remove')!(null, { id: first.data.id }) as any;
  expect(removed).toMatchObject({ ok: true, data: { id: first.data.id, ungrouped: true } });
  expect(getConfig().roots).toHaveLength(1);
  expect((await fs.stat(folder)).isDirectory()).toBe(true);
  expect(await handlers.get('projects:remove')!(null, { id: folder })).toMatchObject({ ok: false });
});

it('discovers real unused Chrome profile directories without reading account data', async () => {
  const previous = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME
  };
  const local = path.join(dir, 'chrome-profile-discovery');
  process.env.LOCALAPPDATA = local;
  process.env.USERPROFILE = local;
  process.env.HOME = local;
  try {
    const userData = process.platform === 'win32'
      ? path.join(local, 'Google', 'Chrome', 'User Data')
      : process.platform === 'darwin'
        ? path.join(local, 'Library', 'Application Support', 'Google', 'Chrome')
        : path.join(local, '.config', 'google-chrome');
    const usable = path.join(userData, 'Profile 991');
    const incomplete = path.join(userData, 'Profile 992');
    await fs.mkdir(usable, { recursive: true });
    await fs.mkdir(incomplete, { recursive: true });
    await fs.writeFile(path.join(usable, 'Preferences'), '{}', 'utf8');
    const result = await handlers.get('instances:browserProfiles')!(null, undefined) as any;
    expect(result).toMatchObject({ ok: true });
    expect(result.data).toContain('Profile 991');
    expect(result.data).not.toContain('Profile 992');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

/** The whole settings object the renderer sends, with the parts a test cares about set. */
function settings(over: { record: boolean; multiAgent: boolean }) {
  const base = defaultConfig();
  return {
    capabilities: base.capabilities,
    readOnly: base.readOnly,
    tunnel: base.tunnel,
    ui: base.ui,
    sessions: { ...base.sessions, record: over.record },
    compaction: base.compaction,
    multiAgent: { ...base.multiAgent, enabled: over.multiAgent },
    goal: base.goal
  };
}

beforeAll(async () => {
  dir = await makeTempDir('clf-ipc-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  onSwarmPersist(() => writeDurableSoon('ipc-swarm', snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow('ipc-swarm', snapshot));
  onRetiredWorkersPersist(() => writeDurableSoon('ipc-retired-workers', snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow((snapshot) => writeDurableNow('ipc-retired-workers', snapshot));
  registerIpc(
    () => currentWindow as any,
    () => {
      quitToInstallCalls += 1;
    }
  );
});

afterAll(async () => {
  await stopBridge();
  await flushDurable();
  onSwarmPersist(null);
  onSwarmPersistNow(null);
  onRetiredWorkersPersist(null);
  onRetiredWorkersPersistNow(null);
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  currentWindow = null;
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
  nativeTheme.themeSource = 'system';
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  vi.mocked(shell.openPath).mockReset().mockResolvedValue('');
  vi.mocked(shell.openExternal).mockReset().mockResolvedValue(undefined);
  vi.mocked(app.getVersion).mockReset().mockReturnValue('0.0.0');
  resetSwarm();
  resetBridgeForTests();
  resetWorkspaces();
  // The app opens the worker's chat itself; a command only exists while a page it opened
  // still has it to redeem.
  setBrowserOpener(async () => undefined);
  const defaults = defaultConfig();
  const existingInstances = getConfig().instances;
  await saveConfig({
    ...defaults,
    sessions: { ...defaults.sessions, record: true },
    multiAgent: {
      ...defaults.multiAgent,
      enabled: true,
      maxWorkers: 3,
      allowUnattributedCalls: false,
      recoverAgentTabs: true
    },
    ...(existingInstances ? {
      instances: {
        ...existingInstances,
        profiles: existingInstances.profiles.map(profile => profile.id === existingInstances.activeInstanceId
          ? { ...profile, tunnelProfileRef: 'default' }
          : profile)
      }
    } : {})
  });
});

it('makes the primary Disconnect button revoke the Chrome companion as well as Core', async () => {
  try {
    await setSecret('bridgeToken', 'ipc-paired-browser');
    expect(await bridgeStatus()).toMatchObject({ paired: true });

    const result = await handlers.get('connection:disconnect')!(null, undefined) as any;

    expect(result).toMatchObject({ ok: true, data: { bridge: { paired: false } } });
    expect(await bridgeStatus()).toMatchObject({ paired: false });
  } finally {
    await clearSecret('bridgeToken');
  }
});

it('rejects new global and per-chat worker limits above six at IPC', async () => {
  const base = settings({ record: true, multiAgent: true });
  const settingsResult = await save({
    ...base,
    multiAgent: { ...base.multiAgent, maxWorkers: 7 }
  });
  expect(settingsResult).toMatchObject({ ok: false });
  expect(getConfig().multiAgent.maxWorkers).toBe(3);

  const session = await createSession({ title: 'Worker limit IPC', conversationId: 'ipc-worker-limit' });
  const chatResult = await handlers.get('sessions:workerLimit')!(null, { id: session.id, workerLimit: 7 }) as any;
  expect(chatResult).toMatchObject({ ok: false });
});

it('projects an explicit zero worker lifecycle for an ordinary chat with no worker family', async () => {
  const session = await createSession({ title: 'No workers needed', conversationId: 'ipc-zero-workers' });
  const result = await sessionList();
  expect(result.ok, result.error).toBe(true);
  expect(result.data.workerProgress.find((row: any) => row.id === session.id)).toEqual({
    id: session.id, total: 0, active: 0, queued: 0, finished: 0, failed: 0, names: [], failures: []
  });
});

it('releases the existing queue admission owner when local Settings Save changes only the global pause', async () => {
  const { onLog } = await import('../src/main/logger.js');
  const goal = await import('../src/main/goal.js');
  const previousReplies = goal.snapshotGoalReplies();
  const previousSwitches = goal.snapshotGoalSwitches();
  const session = await createSession({ conversationId: 'settings-pause-saved-obligation' });
  await goal.setGoalSwitchNow(session.conversationId!, 'loop', true);
  await goal.acceptGoalReplyNow({ conversationId: session.conversationId!, sessionId: session.id,
    turnId: 'exact-settings-source', replyId: 'exact-settings-final', eventSeq: 7, blocked: false });
  const obligation = goal.snapshotGoalReplies();
  const commands = pendingCommands();
  const transitions: boolean[] = [];
  const persistedAtTransition: boolean[] = [];
  const { readFileSync } = await import('node:fs');
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(),
    isDestroyed: () => false, webContents: { send: vi.fn() } };
  const off = onLog(entry => {
    if (entry.message.startsWith('bridge: global ChatGPT automation ')) {
      transitions.push(getConfig().ui.automationPaused === true);
      persistedAtTransition.push(JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')).ui.automationPaused);
    }
  });
  try {
    let before = getConfig();
    expect(await save({ ...before, ui: { ...before.ui, automationPaused: true } }, before))
      .toMatchObject({ ok: true });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.automationPaused).toBe(true);
    before = getConfig();
    expect(await save({ ...before, ui: { ...before.ui, automationPaused: false } }, before))
      .toMatchObject({ ok: true });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.automationPaused).toBe(false);
    expect(transitions).toEqual([true, false]);
    expect(persistedAtTransition).toEqual([true, false]);
    expect(currentWindow.webContents.send).toHaveBeenCalledWith('session:changed');
    expect(goal.snapshotGoalReplies().replies).toEqual(obligation.replies);
    expect(pendingCommands()).toEqual(commands);
    before = getConfig();
    expect(await save({ ...before, ui: { ...before.ui, followOutput: !before.ui.followOutput } }, before))
      .toMatchObject({ ok: true });
    expect(transitions).toEqual([true, false]); // Cosmetic saves cannot mint another resume episode.
  } finally {
    off();
    goal.restoreGoalReplies(previousReplies);
    goal.restoreGoalSwitches(previousSwitches);
  }
});

it('lets explicit Resume all durably release a global pause while background recovery cannot', async () => {
  await saveConfig({ ...getConfig(), ui: { ...getConfig().ui, automationPaused: true } });
  applyAutomationPause(true);

  const background = await handlers.get('sessions:recoverStaleAutomation')!(null, undefined) as any;
  expect(background.ok).toBe(true);
  expect(getConfig().ui.automationPaused).toBe(true);

  const resumed = await handlers.get('sessions:resumeAutomation')!(null, undefined) as any;
  expect(resumed).toMatchObject({ ok: true, data: { queued: 0 } });
  expect(getConfig().ui.automationPaused).toBe(false);
  expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.automationPaused).toBe(false);
});

it('invalidates cached session automation health when the global pause changes', async () => {
  currentWindow = {
    setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  };

  const paused = await handlers.get('sessions:automationPause')!(null, { paused: true }) as any;
  expect(paused.ok, paused.error).toBe(true);
  expect(currentWindow.webContents.send).toHaveBeenCalledWith('session:changed');

  currentWindow.webContents.send.mockClear();
  const resumed = await handlers.get('sessions:automationPause')!(null, { paused: false }) as any;
  expect(resumed.ok, resumed.error).toBe(true);
  expect(currentWindow.webContents.send).toHaveBeenCalledWith('session:changed');
});

describe('explicit settings replace the published tool contract', () => {
  it.each(['finish', 'command', 'session'] as const)('withdraws %s from real endpoint publication after its setting is disabled', async kind => {
    const { startMcpServer } = await import('../src/main/mcp/server.js');
    const { effectiveCapabilities } = await import('../src/main/config.js');
    const { publishPluginSurface, pluginRefreshPublications, resetPluginRefreshForTests } = await import('../src/main/plugin-refresh.js');
    const initial = getConfig();
    await saveConfig({ ...initial, ui: { ...initial.ui, finishTool: true }, capabilities: { ...initial.capabilities, read: true } });
    const endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
    const snapshot = () => {
      endpoint.publication!('core', (name, version, instructions, tools) => publishPluginSurface('core', name, version, instructions, tools));
      return pluginRefreshPublications().find(row => row.surface === 'core')!;
    };
    try {
      const before = snapshot();
      const tool = kind === 'finish' ? 'session_finish' : kind === 'command' ? 'exec_command' : kind;
      expect(before.tools.map(row => row.name)).toContain(tool);
      const current = getConfig();
      const patch = { ...current, ...(kind === 'finish' ? { ui: { ...current.ui, finishTool: false } } : kind === 'command' ? { capabilities: { ...current.capabilities, command: false } } : { sessions: { ...current.sessions, record: false } }) };
      expect((await save(patch)).ok).toBe(true);
      const after = snapshot();
      expect(after.tools.map(row => row.name)).not.toContain(tool);
      expect(after.schemaId).not.toBe(before.schemaId);
      const saved = getConfig();
      expect((await save({ ...saved, ui: { ...saved.ui, theme: 'dark' } })).ok).toBe(true);
      expect(snapshot().schemaId).toBe(after.schemaId);
    } finally { await endpoint.stop(); resetPluginRefreshForTests(); }
  });
});

describe('startup state without secure storage', () => {
  it('still returns a usable app/bridge state instead of crashing state discovery', async () => {
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    const reply = (await handlers.get('state:get')!(null, undefined)) as any;
    expect(reply.ok).toBe(true);
    expect(reply.data.secureStorage.available).toBe(false);
    expect(reply.data.hasApiKey).toBe(false);
    expect(reply.data.hasGoalKey).toBe(false);
    expect(reply.data.bridge.paired).toBe(false);
  });
});

describe('turning multi-agent mode off', () => {
  /**
   * Pausing execution must withdraw queued browser work before the bridge goes away. The
   * durable worker history itself survives; only the pending transport is cancelled.
   */
  it('cancels the run’s queued worker chats before the bridge goes away', async () => {
    await startBridge();
    spawn({ workers: [{ task: 'work' }], caller: { conversationId: 'c-prime' } });
    // Opening is asynchronous, as it is in the app.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingCommands().length).toBe(1);

    // Recording off as well, so this really is the case where the bridge is shut down.
    await save(settings({ record: false, multiAgent: false }));

    expect(getConfig().multiAgent.enabled).toBe(false);
    expect(pendingCommands(), 'a worker chat was left queued for a run that has ended').toEqual([]);
  });

  it('does not acknowledge the toggle until the parked retained history is durable', async () => {
    const prime = '11111111-2222-4333-8444-555555555555';
    const worker = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    spawn({ workers: [{ task: 'must stay fenced after disable' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);
    expect(await persistAgentAuthorityNow()).toBe(true);
    expect(await readDurable('ipc-swarm')).not.toBeNull();

    const reply = await save(settings({ record: false, multiAgent: false }));
    expect(reply.ok, reply.error).toBe(true);
    expect(await readDurable<any>('ipc-swarm')).toMatchObject({
      version: 6,
      runId: null,
      primeConversationId: null,
      agents: [],
      dormantRuns: [
        expect.objectContaining({
          primeConversationId: prime,
          agents: expect.arrayContaining([
            expect.objectContaining({
              info: expect.objectContaining({
                id: 'worker-1',
                conversationId: worker,
                state: 'sleeping',
                revivable: true
              })
            })
          ])
        })
      ]
    });
    expect(await readDurable<any>('ipc-retired-workers')).toMatchObject({ workers: [] });
  });

  it('survives a disabled restart and re-enable with the exact old worker chat still revivable', async () => {
    const prime = '22222222-3333-4444-8555-666666666666';
    const worker = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    spawn({ workers: [{ task: 'remember this exact worker' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);
    expect(await persistAgentAuthorityNow()).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    const saved = await readDurable<any>('ipc-swarm');
    expect(saved).not.toBeNull();

    // The startup path restores authority even while the feature is off, then canonicalizes
    // any leftover active incarnation into parked history. Reproduce that process boundary here.
    restoreSwarm(saved);
    pauseSwarmForDisable('multi-agent mode is disabled');
    expect(snapshotSwarm()).toMatchObject({
      runId: null,
      dormantRuns: [expect.objectContaining({ primeConversationId: prime })]
    });

    const enabled = await save(settings({ record: false, multiAgent: true }));
    expect(enabled.ok, enabled.error).toBe(true);
    expect(swarmStateForCaller({ conversationId: prime }).agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'worker-1',
          conversationId: worker,
          state: 'sleeping',
          revivable: true
        })
      ])
    );

    sendMessage({ conversationId: prime }, 'worker-1', 'continue in the exact worker chat');
    expect(pendingWorkerRevivals()).toEqual([
      expect.objectContaining({ id: 'worker-1', conversationId: worker })
    ]);
  });

  it('preserves every parked owner when disabling a different prime that is still active', async () => {
    const primeA = '33333333-4444-4555-8666-777777777777';
    const workerA = 'cccccccc-dddd-4eee-8fff-000000000001';
    spawn({ workers: [{ task: 'A retained history' }], caller: { conversationId: primeA } });
    expect(bindConversation('worker-1', workerA)).toBe(true);
    finishAgent({ conversationId: workerA }, 'A is parked already');
    expect(releaseQuiescentRun()).toBe(true);

    const primeB = '44444444-5555-4666-8777-888888888888';
    const workerB = 'dddddddd-eeee-4fff-8000-000000000002';
    spawn({ workers: [{ task: 'B is live when disabled' }], caller: { conversationId: primeB } });
    expect(bindConversation('worker-1', workerB)).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    const saved = await readDurable<any>('ipc-swarm');
    expect(saved?.runId).toBeNull();
    expect(saved?.dormantRuns).toHaveLength(2);
    expect(saved?.dormantRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ primeConversationId: primeA }),
        expect.objectContaining({ primeConversationId: primeB })
      ])
    );

    restoreSwarm(saved);
    pauseSwarmForDisable('multi-agent mode is disabled');
    const enabled = await save(settings({ record: false, multiAgent: true }));
    expect(enabled.ok, enabled.error).toBe(true);
    expect(swarmStateForCaller({ conversationId: primeA }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: workerA
    });
    expect(swarmStateForCaller({ conversationId: primeB }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: workerB
    });
  });

  it('keeps disabled history until the explicit Clear swarm IPC destroys it', async () => {
    const prime = '55555555-6666-4777-8888-999999999999';
    const worker = 'eeeeeeee-ffff-4000-8111-000000000003';
    spawn({ workers: [{ task: 'survive disable until explicit clear' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    expect((await readDurable<any>('ipc-swarm'))?.dormantRuns).toHaveLength(1);

    const cleared = await handlers.get('swarm:reset')!(null, undefined) as any;
    expect(cleared.ok, cleared.error).toBe(true);
    expect(await readDurable('ipc-swarm')).toBeNull();
    expect(await readDurable<any>('ipc-retired-workers')).toMatchObject({
      workers: expect.arrayContaining([expect.objectContaining({ id: 'worker-1', conversationId: worker })])
    });
  });
});

describe('bounded IPC identities and OS launch results', () => {
  it('reports shell.openPath failure instead of claiming the extension folder opened', async () => {
    vi.mocked(shell.openPath).mockResolvedValueOnce('Access is denied');
    const reply = (await handlers.get('bridge:openExtensionFolder')!(null, undefined)) as {
      ok: boolean;
      error?: string;
    };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/could not open.*access is denied/i);
  });

  it('opens the exact packaged companion for recovery instead of a version-colliding public ZIP', async () => {
    const reply = await handlers.get('bridge:downloadExtension')!(null, undefined);

    expect(reply).toEqual({ ok: true, data: true });
    expect(shell.openPath).toHaveBeenCalledWith(process.cwd());
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('bounds and validates an agent id before it reaches the global broker', async () => {
    const clear = handlers.get('swarm:clearAgent')!;
    const oversized = (await clear(null, 'worker-' + 'x'.repeat(200_000))) as { ok: boolean; error?: string };
    expect(oversized.ok).toBe(false);
    expect(oversized.error).toMatch(/64|too big/i);

    const punctuation = (await clear(null, 'worker-1\nspoofed')) as { ok: boolean; error?: string };
    expect(punctuation.ok).toBe(false);
  });
});

describe('ChatGPT browser settings', () => {
  it('persists Edge and keeps it through an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const result = await save({ ...base, ui: { ...base.ui, chatBrowser: 'edge' } }, base);
    expect(result.ok, result.error).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.chatBrowser).toBe('edge');
    const stale = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().ui).toMatchObject({ chatBrowser: 'edge', theme: 'light' });
    const current = getConfig();
    expect((await save({ ...current, ui: { ...current.ui, chatBrowser: 'unsupported' } }, current)).ok).toBe(false);
    expect(getConfig().ui.chatBrowser).toBe('edge');
  });
});

describe('settings writes from more than one UI', () => {
  it('validates and persists the Plugins tunnel id through Settings, including explicit clearing', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const tunnelId = `tunnel_${'a'.repeat(32)}`;
    expect((await save({ ...base, tunnel: { ...base.tunnel, pluginsTunnelId: tunnelId } }, base)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).tunnel.pluginsTunnelId).toBe(tunnelId);
    for (const invalid of ['not-a-tunnel', `tunnel_${'g'.repeat(32)}`, `tunnel_${'a'.repeat(31)}`, 'x'.repeat(129)]) {
      const current = getConfig();
      expect((await save({ ...current, tunnel: { ...current.tunnel, pluginsTunnelId: invalid } }, current)).ok).toBe(false);
      expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    }
    const current = getConfig();
    expect((await save({ ...current, tunnel: { ...current.tunnel, pluginsTunnelId: '' } }, current)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe('');
  });

  it('preserves a newer Plugins tunnel across stale and legacy renderer saves', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const tunnelId = `tunnel_${'b'.repeat(32)}`;
    expect((await save({ ...base, tunnel: { ...base.tunnel, pluginsTunnelId: tunnelId } }, base)).ok).toBe(true);
    expect((await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    const legacy = { ...base, tunnel: { ...base.tunnel } };
    delete legacy.tunnel.pluginsTunnelId;
    expect((await save({ ...legacy, ui: { ...legacy.ui, minimizeToTray: !legacy.ui.minimizeToTray } }, legacy)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    expect(getConfig().ui.minimizeToTray).toBe(!legacy.ui.minimizeToTray);
  });

  it('changes login registration only on a changed preference and reports failure after other effects', async () => {
    const lifecycle = await import('../src/main/window-lifecycle.js');
    const connection = await import('../src/main/connection.js');
    const applied = vi.spyOn(connection, 'applySettings');
    const login = vi.spyOn(lifecycle, 'applyLoginStartup').mockImplementation(() => { throw new Error('login registration refused'); });
    try {
      const base = defaultConfig();
      await saveConfig(base);
      const cosmetic = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
      expect(cosmetic.ok, cosmetic.error).toBe(true);
      expect(login).not.toHaveBeenCalled();
      applied.mockClear();
      const current = getConfig();
      const changed = await save({ ...current, ui: { ...current.ui, theme: 'dark', startAtLogin: true } }, current);
      expect(changed.ok).toBe(false);
      expect(changed.error).toContain('login registration refused');
      expect(getConfig().ui.startAtLogin).toBe(true);
      expect(nativeTheme.themeSource).toBe('dark');
      expect(applied).toHaveBeenCalledOnce();
      expect(login).toHaveBeenCalledOnce();
      expect(applied.mock.invocationCallOrder[0]).toBeLessThan(login.mock.invocationCallOrder[0]!);
    } finally { login.mockRestore(); applied.mockRestore(); }
  });
  it('rotates only the active Goal provider and exposes key presence without the secret', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, goal: { ...base.goal, provider: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' } } });
    const goal = await import('../src/main/goal.js');
    const retired = vi.spyOn(goal, 'retireGoalDrafts');
    try {
      await handlers.get('secret:set')!({}, { key: 'openRouterApiKey', value: 'synthetic-inactive-key' });
      expect(retired).not.toHaveBeenCalled();
      const response = await handlers.get('secret:set')!({}, { key: 'customProviderApiKey', value: 'synthetic-active-key' });
      expect(retired).toHaveBeenCalledTimes(1);
      expect(response).toMatchObject({ ok: true, data: { hasCustomProviderKey: true } });
      expect(JSON.stringify(response)).not.toContain('synthetic-active-key');
    } finally { retired.mockRestore(); }
  });

  it('retires an old Goal draft before a published provider change can wait on another settings side effect', async () => {
    const goal = await import('../src/main/goal.js');
    const outbox = await import('../src/main/session/input.js');
    const base = defaultConfig();
    await saveConfig({
      ...base,
      ui: { ...base.ui, finishTool: true },
      goal: {
        ...base.goal,
        enabled: true,
        provider: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' }
      }
    });
    const conversationId = 'cafe4343-0000-4000-8000-000000004343';
    goal.startGoalDraft({ sessionId: 'session-provider-race', conversationId, turnId: 'turn-provider-race', deferStart: true });
    let releaseCancellation!: () => void;
    let enteredCancellation!: () => void;
    const cancellationHeld = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const cancellationEntered = new Promise<void>((resolve) => { enteredCancellation = resolve; });
    const cancel = vi.spyOn(outbox, 'cancelFinishInputs').mockImplementation(async () => {
      enteredCancellation();
      await cancellationHeld;
    });
    try {
      const current = getConfig();
      const saving = save({
        ...current,
        ui: { ...current.ui, finishTool: false },
        goal: { ...current.goal, provider: { kind: 'openrouter', baseUrl: '' } }
      }, current);
      await cancellationEntered;
      expect(getConfig().goal.provider.kind).toBe('openrouter');
      expect(goal.goalViewFor(conversationId)).toBeNull();
      releaseCancellation();
      expect((await saving).ok).toBe(true);
    } finally {
      releaseCancellation();
      cancel.mockRestore();
      goal.resetGoalStateForTests();
    }
  });

  it('revokes in-flight Goal drafts when Recording turns off even if the global Goal master was already off', async () => {
    const goal = await import('../src/main/goal.js');
    const retired = vi.spyOn(goal, 'retireGoalDrafts');
    try {
      const base = defaultConfig();
      await saveConfig({
        ...base,
        sessions: { ...base.sessions, record: true },
        multiAgent: { ...base.multiAgent, enabled: true },
        goal: { ...base.goal, enabled: false }
      });
      const current = getConfig();
      const reply = await save({
        ...current,
        sessions: { ...current.sessions, record: false },
        multiAgent: { ...current.multiAgent, enabled: true }
      }, current);
      expect(reply.ok, reply.error).toBe(true);
      expect(retired).toHaveBeenCalledWith(false);
    } finally { retired.mockRestore(); }
  });

  it('preserves a per-chat Loop when Recording Off dependency-normalizes the global Goal master', async () => {
    const goal = await import('../src/main/goal.js');
    const base = defaultConfig();
    await saveConfig({
      ...base,
      sessions: { ...base.sessions, record: true },
      multiAgent: { ...base.multiAgent, enabled: true },
      goal: { ...base.goal, enabled: true, mode: 'goal' }
    });
    const chat = 'cafe4242-0000-4000-8000-000000004242';
    await goal.setGoalSwitchNow(chat, 'loop', true, true);

    const current = getConfig();
    const reply = await save({
      ...current,
      sessions: { ...current.sessions, record: false },
      multiAgent: { ...current.multiAgent, enabled: true }
    }, current);
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().sessions.record).toBe(false);
    expect(getConfig().goal.enabled).toBe(false);
    expect(goal.goalSwitchFor(chat)).toMatchObject({ own: true, enabled: true, mode: 'loop' });
  });

  it('still treats an explicit Goal master Off as the command to clear per-chat automation', async () => {
    const goal = await import('../src/main/goal.js');
    const base = defaultConfig();
    await saveConfig({
      ...base,
      sessions: { ...base.sessions, record: true },
      goal: { ...base.goal, enabled: true, mode: 'goal' }
    });
    const chat = 'cafe4343-0000-4000-8000-000000004343';
    await goal.setGoalSwitchNow(chat, 'loop', true, true);
    expect(goal.goalSwitchFor(chat)).toMatchObject({ own: true, enabled: true });

    const current = getConfig();
    const reply = await save({ ...current, goal: { ...current.goal, enabled: false } }, current);
    expect(reply.ok, reply.error).toBe(true);
    expect(goal.goalSwitchFor(chat)).toMatchObject({ own: false, enabled: false });
  });
  it('persists connector instructions through IPC, preserves concurrent edits, and allows explicit clearing', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const wanted = { ...base, mcp: { instructions: 'Use the approved project only.' }, ui: { ...base.ui, browserOnly: true } };
    expect((await save(wanted, base)).ok).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).mcp).toEqual(wanted.mcp);
    expect(getConfig().ui.browserOnly).toBe(true);
    expect((await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base)).ok).toBe(true);
    expect(getConfig().mcp).toEqual(wanted.mcp);
    expect(getConfig().ui.browserOnly).toBe(true);
    const legacy = { ...base } as any; delete legacy.mcp;
    expect((await save(legacy, legacy)).ok).toBe(true);
    expect(getConfig().mcp).toEqual(wanted.mcp);
    const current = getConfig();
    expect((await save({ ...current, mcp: { instructions: '' } }, current)).ok).toBe(true);
    expect(getConfig().mcp.instructions).toBe('');
    expect((await save({ ...current, mcp: { instructions: 'x'.repeat(4001) } }, current)).ok).toBe(false);
    expect(getConfig().mcp.instructions).toBe('');
  });
  it('saves helper settings and tab retention through the renderer schema and merge boundary', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const wanted = { ...base, ui: { ...base.ui, tabsToKeepOpen: 6 }, goal: {
      ...base.goal, helperModel: 'account-helper', helperReasoning: 'medium' as const
    } };
    const result = await save(wanted, base);
    expect(result.ok, result.error).toBe(true);
    expect(getConfig().ui.tabsToKeepOpen).toBe(6);
    expect(getConfig().goal).toMatchObject({ helperModel: 'account-helper', helperReasoning: 'medium', model: base.goal.model });
  });
  it('persists the planner backend and preserves it across an unrelated stale settings save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const selected = await save({ ...base, ui: { ...base.ui, planBackend: 'api' } }, base);
    expect(selected.ok, selected.error).toBe(true);
    expect(getConfig().ui.planBackend).toBe('api');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.planBackend).toBe('api');
    const stale = await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().ui).toMatchObject({ planBackend: 'api', minimizeToTray: !base.ui.minimizeToTray });
    const current = getConfig();
    expect((await save({ ...current, ui: { ...current.ui, planBackend: 'chatgpt' } }, current)).ok).toBe(true);
    expect(getConfig().ui.planBackend).toBe('chatgpt');
    expect((await save({ ...current, ui: { ...current.ui, planBackend: 'unsupported' } }, current)).ok).toBe(false);
    expect(getConfig().ui.planBackend).toBe('chatgpt');
  });
  it('does not let a stale renderer snapshot undo a newer extension setting', async () => {
    currentWindow = {
      setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(),
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    };
    const original = defaultConfig();
    const base = {
      ...original,
      ui: { ...original.ui, theme: 'light' as const },
      goal: { ...original.goal, enabled: true }
    };
    await saveConfig(base);

    // The extension writes after the renderer has already captured `base` for an unrelated
    // form edit. This is exactly the race a serialized config queue cannot solve by itself.
    await saveConfig({ ...base, goal: { ...base.goal, enabled: false } });
    const wanted = { ...base, ui: { ...base.ui, theme: 'dark' as const } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.theme).toBe('dark');
    expect(nativeTheme.themeSource).toBe('dark');
    expect(currentWindow.setBackgroundColor).toHaveBeenCalledWith('#0e0e11');
    if (process.platform === 'win32') expect(currentWindow.setTitleBarOverlay).toHaveBeenCalledWith({
      height: 36, color: '#1a2129', symbolColor: '#b8c0c5'
    });
    expect(getConfig().goal.enabled).toBe(false);
  });

  it('preserves a newer unattributed-call choice across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, allowUnattributedCalls: true }
    });

    const wanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.minimizeToTray).toBe(!base.ui.minimizeToTray);
    expect(getConfig().multiAgent.allowUnattributedCalls).toBe(true);
  });

  it('preserves a newer agent-tab recovery choice across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, recoverAgentTabs: false }
    });

    const wanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.minimizeToTray).toBe(!base.ui.minimizeToTray);
    expect(getConfig().multiAgent.recoverAgentTabs).toBe(false);
  });
});

describe('root namespace invariants', () => {
  it('requires an exact native confirmation before approving a whole drive and preserves narrower aliases', async () => {
    const nested = fixturePath('broad-drive-alias');
    await fs.mkdir(nested, { recursive: true });
    const alias = { name: 'creative', path: await fs.realpath(nested) };
    const wholeDrive = path.parse(nested).root;
    await saveConfig({ ...defaultConfig(), roots: [alias] });
    currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [wholeDrive] });
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    expect((await handlers.get('roots:add')!(null, undefined) as any).ok).toBe(true);
    expect(getConfig().roots).toEqual([alias]);
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [wholeDrive] });
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const allowed = await handlers.get('roots:add')!(null, undefined) as any;
    expect(allowed.ok, allowed.error).toBe(true);
    expect(getConfig().roots).toContainEqual(alias);
    expect(getConfig().roots.some(root => path.parse(root.path).root.toLowerCase() === root.path.toLowerCase())).toBe(true);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(currentWindow, expect.objectContaining({
      title: 'Approve whole-drive access', buttons: ['Share drives', 'Cancel'], defaultId: 1,
      detail: expect.stringContaining('this is not an OS sandbox')
    }));
  });

  it('keeps sharing off when its exact current-folder confirmation is cancelled', async () => {
    const folder = fixturePath('share-cancel');
    await fs.mkdir(folder, { recursive: true });
    await saveConfig({ ...defaultConfig(), roots: [{ name: 'creative', path: folder }] });
    currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const reply = await handlers.get('roots:shared')!(null, { enabled: true }) as any;
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().instances?.sharedFolderAccess?.enabled).not.toBe(true);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(currentWindow, expect.objectContaining({
      detail: expect.stringContaining(folder), buttons: ['Share across accounts', 'Cancel'], defaultId: 1
    }));
  });

  it('confirms exact picker paths once and atomically adds unique workspace folders', async () => {
    const existing = fixturePath('workspace-plan-existing');
    const editing = fixturePath('workspace-plan-editing');
    const vfx = fixturePath('workspace-plan-vfx');
    await Promise.all([existing, editing, vfx].map(folder => fs.mkdir(folder, { recursive: true })));
    const existingReal = await fs.realpath(existing);
    await saveConfig({
      ...defaultConfig(),
      roots: [{ name: 'existing', path: existingReal }]
    });
    currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
    const selected = [existing, editing, vfx, editing];
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: selected });
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false });

    const reply = await handlers.get('roots:addWorkspaceFolders')!(null, undefined) as any;

    expect(reply.ok, reply.error).toBe(true);
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(currentWindow, expect.objectContaining({
      properties: ['openDirectory', 'multiSelections']
    }));
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(currentWindow, expect.objectContaining({
      detail: selected.map(folder => `• ${folder}`).join('\n'),
      buttons: ['Share folders', 'Cancel'],
      cancelId: 1
    }));
    expect(getConfig().roots.map(root => root.name)).toEqual(['existing', 'workspace-plan-editing', 'workspace-plan-vfx']);
    expect(getConfig().roots.filter(root => root.path === existingReal)).toHaveLength(1);
  });

  it('leaves every prior root unchanged when any new workspace folder is unavailable or overlapping', async () => {
    const prior = fixturePath('workspace-plan-prior');
    const valid = fixturePath('workspace-plan-valid');
    const child = path.join(valid, 'child');
    const missing = fixturePath('workspace-plan-missing');
    await fs.mkdir(prior, { recursive: true });
    await fs.mkdir(child, { recursive: true });
    const priorRoot = { name: 'prior', path: await fs.realpath(prior) };
    currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };

    for (const selected of [[valid, missing], [valid, child]]) {
      await saveConfig({ ...defaultConfig(), roots: [priorRoot] });
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: selected });
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false });

      const reply = await handlers.get('roots:addWorkspaceFolders')!(null, undefined) as any;

      expect(reply.ok).toBe(false);
      expect(getConfig().roots).toEqual([priorRoot]);
    }
  });

  it('approves a dropped folder path exactly like the picker, and refuses a dropped file', async () => {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    await saveConfig({ ...defaultConfig(), roots: [] });
    const folder = path.join(dir, 'dropped-project');
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(dir, 'dropped-file.txt');
    await fs.writeFile(file, 'not a folder');
    const addPath = (payload: unknown): Promise<any> => handlers.get('roots:addPath')!(null, payload) as Promise<any>;

    const added = await addPath({ path: folder });
    expect(added.ok).toBe(true);
    expect(getConfig().roots.map((root) => root.name)).toEqual(['dropped-project']);

    // The drop zone is not a second, weaker approval path: the same validation applies.
    const refused = await addPath({ path: file });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not a folder/i);
    expect((await addPath({ path: '' })).ok).toBe(false);
    expect(getConfig().roots).toHaveLength(1);
  });

  it('refuses a live rename into the reserved /skills namespace', async () => {
    const base = defaultConfig();
    await saveConfig({
      ...base,
      roots: [
        { name: 'project', path: fixturePath('project') },
        { name: 'skills-folder', path: fixturePath('skills-folder') }
      ]
    });

    const reply = await renameRoot({ name: 'project', newName: 'skills' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/reserved/i);
    expect(getConfig().roots.map((root) => root.name)).toEqual(['project', 'skills-folder']);
  });

  it('moves live workspace bindings with a root rename and drops them with root removal', async () => {
    const base = defaultConfig();
    await saveConfig({
      ...base,
      roots: [{ name: 'project', path: fixturePath('project') }]
    });
    setWorkspaceFor('chat:conv-root-change', {
      virtual: '/project/src',
      real: fixturePath('project', 'src')
    });

    const renamed = await renameRoot({ name: 'project', newName: 'repo' });
    expect(renamed.ok, renamed.error).toBe(true);
    expect(workspaceEntries()).toEqual([{ key: 'chat:conv-root-change', virtual: '/repo/src' }]);

    const removed = await removeRoot({ name: 'repo' });
    expect(removed.ok, removed.error).toBe(true);
    expect(workspaceEntries()).toEqual([]);
  });

  it('refuses stale root rename/remove requests instead of reporting a no-op as success', async () => {
    await saveConfig({ ...defaultConfig(), roots: [] });
    const renamed = await renameRoot({ name: 'gone', newName: 'other' });
    expect(renamed.ok).toBe(false);
    expect(renamed.error).toMatch(/not an approved folder/i);
    const removed = await removeRoot({ name: 'gone' });
    expect(removed.ok).toBe(false);
    expect(removed.error).toMatch(/not an approved folder/i);
  });
});

/** Exercise the real IPC policy for both Settings buttons and authored chat links. */
describe('every link the window offers', () => {
  it('is one link:open will actually open', async () => {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');

    const offered = [...html.matchAll(/data-link="([^"]+)"/g)].map((match) => match[1]!);
    expect(offered.length, 'the markup offers no links at all — has data-link been renamed?').toBeGreaterThan(0);

    for (const url of offered) expect(await handlers.get('link:open')!(null, { url })).toEqual({ ok: true, data: true });
  });

  it('opens the OpenRouter key page the goal loop sends people to', async () => {
    const open = handlers.get('link:open')!;
    expect(await open(null, { url: 'https://openrouter.ai/settings/keys' })).toEqual({ ok: true, data: true });
    expect(await open(null, { url: 'https://example.com/reference#section' })).toEqual({ ok: true, data: true });
  });

  it.each(['https://example.com/path?q=hello', 'http://localhost:3000/', 'mailto:person@example.com?subject=Hello'])(
    'opens an authored external link: %s', async url => {
      expect(await handlers.get('link:open')!(null, { url })).toEqual({ ok: true, data: true });
      expect(shell.openExternal).toHaveBeenLastCalledWith(url);
    }
  );
  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///C:/secret', 'ms-settings:privacy',
    'x-apple.systempreferences:unapproved', 'https://user:password@example.com/', '//example.com/',
    'https:example.com', 'https://example.com/\nfoo', 'mailto:a@example.com?body=%0Ainjected', 'https://example.com/\\path'])(
    'refuses unsafe authored link: %s', async url => {
    const before = vi.mocked(shell.openExternal).mock.calls.length;
    const refused = (await handlers.get('link:open')!(null, { url })) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not allowed/i);
    expect(vi.mocked(shell.openExternal).mock.calls.length).toBe(before);
  });

  it('serializes non-Error throws into a real IPC error string', async () => {
    vi.mocked(shell.openExternal).mockRejectedValueOnce('Windows shell refused the request');
    const reply = (await handlers.get('link:open')!(null, {
      url: 'https://openrouter.ai/settings/keys'
    })) as { ok: boolean; error?: string };
    expect(reply).toEqual({ ok: false, error: 'Windows shell refused the request' });
  });
});

/** The Install button must never retain a lifecycle-less direct-quit compatibility path. */
describe('installing a downloaded update on request', () => {
  it('fails closed, and does not quit, when no lifecycle coordinator owns Drain', async () => {
    const before = quitToInstallCalls;
    const reply = (await handlers.get('update:install')!(null, undefined)) as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/profile lifecycle is not available/i);
    expect(quitToInstallCalls).toBe(before);
  });
});

/**
 * OpenRouter publishes twelve ids that begin with `~` — `~deepseek/deepseek-v4-flash-latest`
 * and its siblings — and they are aliases that always resolve to the newest model in a
 * family. The picker lists them because the catalogue does, so a validator that refused the
 * `~` made the one kind of entry most worth choosing the one kind that could not be saved:
 * the click reported an error and the model in use silently stayed where it was.
 */
describe('the goal model id', () => {
  const withModel = (model: string) => ({ ...settings({ record: false, multiAgent: false }), goal: { ...defaultConfig().goal, model } });

  it('accepts the family aliases OpenRouter marks with a tilde', async () => {
    const reply = await save(withModel('~z-ai/glm-latest'));
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.model).toBe('~z-ai/glm-latest');
  });

  it('still accepts an ordinary pinned id, with or without a variant suffix', async () => {
    expect((await save(withModel('deepseek/deepseek-v4-flash-0731'))).ok).toBe(true);
    expect((await save(withModel('openai/gpt-5.2-mini:nitro'))).ok).toBe(true);
  });

  it('refuses something that is not a model id at all', async () => {
    const reply = await save(withModel('not a model'));
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/vendor\/model/);
  });

  /** The shipped default is one of those aliases, so it has to survive its own validator. */
  it('accepts the default this app ships with', async () => {
    const reply = await save(settings({ record: false, multiAgent: false }));
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.model).toBe(defaultConfig().goal.model);
  });

  it('accepts a bare endpoint id while custom and stores the base URL verbatim', async () => {
    const patch = {
      ...settings({ record: false, multiAgent: false }),
      goal: {
        ...defaultConfig().goal,
        provider: { kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1/' },
        model: 'llama3.1'
      }
    };
    const reply = await save(patch);
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.provider).toEqual({ kind: 'custom', baseUrl: 'http://localhost:11434/v1/' });
    expect(getConfig().goal.model).toBe('llama3.1');
  });

  it('still refuses a bare id while on OpenRouter, and an unknown provider kind', async () => {
    const custom = {
      ...settings({ record: false, multiAgent: false }),
      goal: {
        ...defaultConfig().goal,
        provider: { kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1' },
        model: 'llama3.1'
      }
    };
    // Same model, OpenRouter provider: the vendor/model shape still applies.
    const openrouter = {
      ...custom,
      goal: { ...custom.goal, provider: { kind: 'openrouter' as const, baseUrl: '' } }
    };
    expect((await save(openrouter)).ok).toBe(false);
    const unknown = {
      ...custom,
      goal: { ...custom.goal, provider: { kind: 'own' as never, baseUrl: '' } }
    };
    expect((await save(unknown)).ok).toBe(false);
  });
});

describe('the custom provider key slot', () => {
  const storeSecret = (payload: unknown): Promise<any> =>
    handlers.get('secret:set')!(null, payload) as Promise<any>;

  it('stores a custom key in its own slot and refuses an unnamed one', async () => {
    const prior = await handlers.get('state:get')!(null, undefined) as any;
    const stored = await storeSecret({ value: 'sk-custom-1', key: 'customProviderApiKey' });
    expect(stored.ok, stored.error).toBe(true);
    expect(stored.data.hasCustomProviderKey).toBe(true);
    // The OpenRouter slot is untouched: naming is exact, never a shared bucket.
    expect(stored.data.hasGoalKey).toBe(prior.data.hasGoalKey);
    const cleared = await storeSecret({ value: '', key: 'customProviderApiKey' });
    expect(cleared.ok).toBe(true);
    expect(cleared.data.hasCustomProviderKey).toBe(false);
    const refused = await storeSecret({ value: 'x', key: 'nobodyDefinedThis' });
    expect(refused.ok).toBe(false);
  });

  it('writes and reports provider keys only for the active isolated account profile', async () => {
    const configModule = await import('../src/main/config.js');
    const secretModule = await import('../src/main/secrets.js');
    const baseline = structuredClone(getConfig());
    const legacyBefore = await secretModule.getSecret('customProviderApiKey');
    let isolatedSlot: ReturnType<typeof secretModule.profileProviderSecretSlot> | null = null;
    try {
      await secretModule.setSecret('customProviderApiKey', 'legacy-provider-key');
      const profile = await configModule.createLocalInstanceProfile('IPC isolated', 'Profile 18');
      await configModule.stageInstanceActivationForNextStart(profile.id);
      initConfigPath(dir);
      secretModule.resetSecretsCacheForTests();
      await configModule.loadConfig();
      isolatedSlot = secretModule.profileProviderSecretSlot('isolated', profile.id, 'customProviderApiKey');

      const stored = await storeSecret({ value: 'isolated-provider-key', key: 'customProviderApiKey' });
      expect(stored).toMatchObject({ ok: true, data: { hasCustomProviderKey: true } });
      expect(JSON.stringify(stored)).not.toContain('isolated-provider-key');
      expect(await secretModule.getSecret(isolatedSlot)).toBe('isolated-provider-key');
      expect(await secretModule.getSecret('customProviderApiKey')).toBe('legacy-provider-key');
    } finally {
      initConfigPath(dir);
      secretModule.resetSecretsCacheForTests();
      await saveConfig(baseline);
      if (isolatedSlot) await secretModule.setSecret(isolatedSlot, '');
      await secretModule.setSecret('customProviderApiKey', legacyBefore ?? '');
    }
  });
});

describe('the editable goal system prompt', () => {
  it('stores a deliberate custom prompt', async () => {
    const prompt = 'Only continue explicit missing work. Return NO_REPLY when ChatGPT says done.';
    const base = settings({ record: false, multiAgent: false });
    const reply = await save({ ...base, goal: { ...base.goal, prompt } });
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.prompt).toBe(prompt);
  });

  it('refuses blank and unbounded prompts at the renderer boundary', async () => {
    const base = settings({ record: false, multiAgent: false });
    expect((await save({ ...base, goal: { ...base.goal, prompt: '   ' } })).ok).toBe(false);
    expect((await save({ ...base, goal: { ...base.goal, prompt: 'x'.repeat(20_001) } })).ok).toBe(false);
  });

  /**
   * The driver prompt crosses the same boundary as the gate, so it needs the same guards.
   * It used to be a source constant no renderer could reach; now that it is editable, a
   * blank or unbounded value has to be refused here rather than reaching the goal loop.
   */
  it('stores the goal driver prompt and holds it to the same bounds', async () => {
    const objectivePrompt = 'Drive to the goal. NO_REPLY once it is reached.';
    const base = settings({ record: false, multiAgent: false });
    const reply = await save({ ...base, goal: { ...base.goal, objectivePrompt } });
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.objectivePrompt).toBe(objectivePrompt);

    expect((await save({ ...base, goal: { ...base.goal, objectivePrompt: '   ' } })).ok).toBe(false);
    expect(
      (await save({ ...base, goal: { ...base.goal, objectivePrompt: 'x'.repeat(20_001) } })).ok
    ).toBe(false);
  });
});

describe('session IPC contracts', () => {
  it('projects absent live activity without persisting the runtime deadline', async () => {
    const { observeSessionModel, getSession } = await import('../src/main/session/store.js');
    const pro = await createSession({ title: 'Idle Pro', conversationId: 'idle-pro-projection' });
    const sol = await createSession({ title: 'Idle Sol', conversationId: 'idle-sol-projection' });
    await observeSessionModel(pro.id, pro.conversationId!, 'gpt-6', Date.now(), 'pro');
    await observeSessionModel(sol.id, sol.conversationId!, 'gpt-5.6', Date.now(), 'medium');
    const reply = await sessionList();
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.sessions.find((row: any) => row.id === pro.id).activityExpiresAt).toBeNull();
    expect(reply.data.sessions.find((row: any) => row.id === sol.id).activityExpiresAt).toBeNull();
    expect(await getSession(pro.id)).not.toHaveProperty('activityExpiresAt');
  });

  it('keeps total as the whole session size on an explicit event page', async () => {
    const session = await createSession({ title: 'paged IPC total', conversationId: null });
    for (let index = 0; index < 5; index++) {
      await appendEvent(session.id, {
        time: 10_000 + index,
        source: 'app',
        kind: 'note',
        message: { text: `note-${index}`, truncated: false, chars: 6 }
      });
    }

    const reply = await sessionEvents({ id: session.id, from: 3, limit: 2 });
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.events).toHaveLength(2);
    expect(reply.data.total).toBe(5);
  });

  it('does not send pressure rows for sessions it already omitted from the capped list', async () => {
    for (let index = 0; index < 61; index++) {
      await createSession({ title: `list cap ${index}`, conversationId: null });
    }
    const reply = await sessionList();
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.sessions).toHaveLength(60);
    expect(reply.data.pressure).toHaveLength(60);
    expect(new Set(reply.data.pressure.map((entry: { id: string }) => entry.id))).toEqual(
      new Set(reply.data.sessions.map((entry: { id: string }) => entry.id))
    );
  });

  it('projects compaction pressure from the current chat context, not session lifetime history', async () => {
    const chatA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const chatB = 'bbbbbbbb-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'reset context pressure', conversationId: chatA });
    await appendEvent(session.id, {
      time: Date.now(),
      source: 'app',
      kind: 'note',
      message: { text: 'x'.repeat(8_000), truncated: false, chars: 8_000 }
    });
    expect(await rebindSession(session.id, chatA, chatB)).toBe(true);

    const reply = await sessionList();
    const listed = reply.data.sessions.find((entry: { id: string }) => entry.id === session.id);
    const pressure = reply.data.pressure.find((entry: { id: string }) => entry.id === session.id);
    expect(listed.estimatedTokens).toBeGreaterThan(0);
    expect(listed.contextTokens).toBe(0);
    expect(pressure.estimated).toBe(0);
    expect(pressure.level).toBe('ok');
  });

  it('blocks and releases the stored conversation, and never a renderer-supplied one', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'rogue chat', conversationId });

    const blocked = (await handlers.get('sessions:block')!(null, { id: session.id, blocked: true })) as any;
    expect(blocked.ok, blocked.error).toBe(true);
    expect(blocked.data).toEqual([conversationId]);
    expect(isChatBlocked(conversationId)).toBe(true);

    const released = (await handlers.get('sessions:block')!(null, { id: session.id, blocked: false })) as any;
    expect(released.ok, released.error).toBe(true);
    expect(released.data).toEqual([]);
    expect(isChatBlocked(conversationId)).toBe(false);

    // The renderer names a session; it can neither name a conversation nor block a session
    // that has none — the same boundary `sessions:openChat` holds.
    const unattributed = await createSession({ title: 'no conversation', conversationId: null });
    const refused = (await handlers.get('sessions:block')!(null, { id: unattributed.id, blocked: true })) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid ChatGPT conversation/i);
    resetBlockedChatsForTests();
  });

  it('preflights a selected block batch so unsupported rows cannot partially change policy', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const firstConversation = 'block-many-1111-2222-3333-444444444444';
    const secondConversation = 'block-many-2222-2222-3333-444444444444';
    const first = await createSession({ title: 'Batch one', conversationId: firstConversation });
    const second = await createSession({ title: 'Batch two', conversationId: secondConversation });
    const unattributed = await createSession({ title: 'No conversation', conversationId: null });

    const refused = await handlers.get('sessions:blockMany')!(null, {
      ids: [first.id, unattributed.id, second.id], blocked: true
    }) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/Unattributed activity/i);
    expect(isChatBlocked(firstConversation)).toBe(false);
    expect(isChatBlocked(secondConversation)).toBe(false);

    const blocked = await handlers.get('sessions:blockMany')!(null, {
      ids: [first.id, second.id], blocked: true
    }) as any;
    expect(blocked.ok, blocked.error).toBe(true);
    expect(isChatBlocked(firstConversation)).toBe(true);
    expect(isChatBlocked(secondConversation)).toBe(true);

    const released = await handlers.get('sessions:blockMany')!(null, {
      ids: [first.id, second.id], blocked: false
    }) as any;
    expect(released.ok, released.error).toBe(true);
    expect(isChatBlocked(firstConversation)).toBe(false);
    expect(isChatBlocked(secondConversation)).toBe(false);
    resetBlockedChatsForTests();
  });

  it('keeps manual block and deletion fences independent across delete and restore', async () => {
    const { isChatBlocked, isChatDeleted, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    const { sessionForConversation } = await import('../src/main/session/recorder.js');
    resetBlockedChatsForTests();
    const conversationId = 'bbbbbbbb-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'blocked then deleted', conversationId });
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect(isChatBlocked(conversationId)).toBe(true);

    const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
    expect(deleted.ok, deleted.error).toBe(true);
    expect(deleted.data).toMatchObject({ id: session.id, title: 'blocked then deleted', conversationId });
    expect(isChatDeleted(conversationId)).toBe(true);
    expect(isChatBlocked(conversationId)).toBe(true);
    // The still-open browser page cannot manufacture a replacement row after deletion.
    expect(await sessionForConversation(conversationId)).toBeNull();

    const restored = (await handlers.get('sessions:restoreDeleted')!(null, { id: session.id })) as any;
    expect(restored.ok, restored.error).toBe(true);
    expect(restored.data).toMatchObject({ id: session.id, title: 'blocked then deleted', conversationId });
    expect(isChatDeleted(conversationId)).toBe(false);
    // Undo restores history, but cannot silently reverse the manual Block that existed first.
    expect(isChatBlocked(conversationId)).toBe(true);
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: false });
  });

  it('keeps every Compact & Resume conversation in a deleted lineage fenced until Undo restores it', async () => {
    const { isChatDeleted, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    const { sessionForConversation } = await import('../src/main/session/recorder.js');
    resetBlockedChatsForTests();
    const sourceConversation = 'de1e7eda-1111-4222-8333-444444444441';
    const successorConversation = 'de1e7eda-1111-4222-8333-444444444442';
    const session = await createSession({ title: 'Compacted lineage deletion', conversationId: sourceConversation });
    expect(await rebindSession(session.id, sourceConversation, successorConversation)).toBe(true);

    const deleted = await handlers.get('sessions:delete')!(null, { id: session.id }) as any;
    expect(deleted.ok, deleted.error).toBe(true);
    expect(isChatDeleted(sourceConversation)).toBe(true);
    expect(isChatDeleted(successorConversation)).toBe(true);
    expect(await sessionForConversation(sourceConversation)).toBeNull();
    expect(await sessionForConversation(successorConversation)).toBeNull();

    const restored = await handlers.get('sessions:restoreDeleted')!(null, { id: session.id }) as any;
    expect(restored.ok, restored.error).toBe(true);
    expect(isChatDeleted(sourceConversation)).toBe(false);
    expect(isChatDeleted(successorConversation)).toBe(false);
    // A remains historical after Undo: it still must not mint a shadow session beside successor B.
    expect(await sessionForConversation(sourceConversation)).toBeNull();
    expect(await sessionForConversation(successorConversation)).toBe(session.id);
  });

  it('recovers an Undo that crashes after Trash moved active but before lineage fences cleared', async () => {
    const { isChatBlocked, isChatDeleted, resetBlockedChatsForTests, restoreBlockedChats, setChatBlocked } =
      await import('../src/main/session/blocked-chats.js');
    const { restoreDeletedSession } = await import('../src/main/session/store.js');
    const { sessionForConversation } = await import('../src/main/session/recorder.js');
    const { reconcilePendingSessionRestore, SESSION_DELETION_RESTORE_STATE } =
      await import('../src/main/session/deletion.js');
    resetBlockedChatsForTests();
    const sourceConversation = 'de1e7edc-1111-4222-8333-444444444441';
    const successorConversation = 'de1e7edc-1111-4222-8333-444444444442';
    const session = await createSession({ title: 'Crash-safe compacted Undo', conversationId: sourceConversation });
    expect(await rebindSession(session.id, sourceConversation, successorConversation)).toBe(true);
    setChatBlocked(sourceConversation, true);
    expect((await handlers.get('sessions:delete')!(null, { id: session.id }) as any).ok).toBe(true);

    // Simulate the exact crash boundary: the restore intent is durable and the same-volume
    // Trash->active rename landed, but the deletion fences were never released.
    await writeDurableNow(SESSION_DELETION_RESTORE_STATE, {
      version: 1,
      id: session.id,
      createdAt: Date.now(),
      conversationId: successorConversation,
      chatIds: [sourceConversation, successorConversation]
    });
    expect(await restoreDeletedSession(session.id)).toMatchObject({ id: session.id, conversationId: successorConversation });
    expect(isChatDeleted(sourceConversation)).toBe(true);
    expect(isChatDeleted(successorConversation)).toBe(true);

    resetSessionStoreForTests();
    resetBlockedChatsForTests();
    await restoreBlockedChats();
    const restored = await reconcilePendingSessionRestore();

    expect(restored).toMatchObject({ id: session.id, conversationId: successorConversation });
    expect(await readDurable(SESSION_DELETION_RESTORE_STATE)).toBeNull();
    expect(isChatDeleted(sourceConversation)).toBe(false);
    expect(isChatDeleted(successorConversation)).toBe(false);
    expect(isChatBlocked(sourceConversation)).toBe(true); // Undo releases only deletion's reason.
    expect(isChatBlocked(successorConversation)).toBe(false);
    expect(await sessionForConversation(sourceConversation)).toBeNull();
    expect(await sessionForConversation(successorConversation)).toBe(session.id);
    setChatBlocked(sourceConversation, false);
  });

  it('keeps the complete Compact & Resume lineage fenced after permanent local deletion', async () => {
    const { isChatDeleted, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    const { sessionForConversation } = await import('../src/main/session/recorder.js');
    resetBlockedChatsForTests();
    const sourceConversation = 'de1e7edb-1111-4222-8333-444444444441';
    const successorConversation = 'de1e7edb-1111-4222-8333-444444444442';
    const session = await createSession({ title: 'Permanently deleted compacted lineage', conversationId: sourceConversation });
    expect(await rebindSession(session.id, sourceConversation, successorConversation)).toBe(true);

    const deleted = await handlers.get('sessions:deleteMany')!(null, { ids: [session.id], permanent: true }) as any;
    expect(deleted.ok, deleted.error).toBe(true);
    expect(deleted.data).toMatchObject({ requested: 1, permanent: true, failed: [] });
    expect(isChatDeleted(sourceConversation)).toBe(true);
    expect(isChatDeleted(successorConversation)).toBe(true);
    expect(await sessionForConversation(sourceConversation)).toBeNull();
    expect(await sessionForConversation(successorConversation)).toBeNull();
    resetBlockedChatsForTests();
  });

  it('rejects a lineage deletion that would exceed fence capacity before committing the batch', async () => {
    const {
      isChatDeleted,
      MAX_DELETED_CHATS,
      resetBlockedChatsForTests,
      setChatsDeletedNow
    } = await import('../src/main/session/blocked-chats.js');
    const { SESSION_DELETION_BATCH_STATE } = await import('../src/main/session/deletion.js');
    resetBlockedChatsForTests();
    const existing = Array.from({ length: MAX_DELETED_CHATS - 1 }, (_, index) =>
      `cap-${index.toString(36).padStart(8, '0')}`
    );
    await setChatsDeletedNow(existing, true);
    try {
      const sourceConversation = 'de1e7edd-1111-4222-8333-444444444441';
      const successorConversation = 'de1e7edd-1111-4222-8333-444444444442';
      const session = await createSession({ title: 'Capacity-safe compacted deletion', conversationId: sourceConversation });
      expect(await rebindSession(session.id, sourceConversation, successorConversation)).toBe(true);

      const reply = await handlers.get('sessions:deleteMany')!(null, { ids: [session.id], permanent: false }) as any;
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/Deleted-chat safety fence limit reached/i);
      expect(await readDurable(SESSION_DELETION_BATCH_STATE)).toBeNull();
      expect(await getSession(session.id)).toMatchObject({ conversationId: successorConversation });
      expect(isChatDeleted(sourceConversation)).toBe(false);
      expect(isChatDeleted(successorConversation)).toBe(false);
    } finally {
      await setChatsDeletedNow(existing, false);
      resetBlockedChatsForTests();
    }
  });

  it('permanently deletes a multi-selection without leaving recoverable copies or recreation authority', async () => {
    const { getSession } = await import('../src/main/session/store.js');
    const { isChatDeleted, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    const { sessionForConversation } = await import('../src/main/session/recorder.js');
    resetBlockedChatsForTests();
    const conversationIds = [
      'de1e7ed1-1111-2222-3333-444444444444',
      'de1e7ed2-1111-2222-3333-444444444444'
    ];
    const rows = await Promise.all(conversationIds.map((conversationId, index) =>
      createSession({ title: `Permanent ${index + 1}`, conversationId })
    ));

    const reply = await handlers.get('sessions:deleteMany')!(null, {
      ids: rows.map((row) => row.id),
      permanent: true
    }) as any;
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data).toMatchObject({ requested: 2, permanent: true, failed: [] });
    expect(reply.data.deleted).toHaveLength(2);
    expect((await sessionList()).data.deleted).toBe(0);
    for (let index = 0; index < rows.length; index++) {
      expect(await getSession(rows[index]!.id)).toBeNull();
      expect(isChatDeleted(conversationIds[index]!)).toBe(true);
      expect(await sessionForConversation(conversationIds[index]!)).toBeNull();
    }
    resetBlockedChatsForTests();
  });

  it('deleting one row also retires every exact active duplicate from an older build', async () => {
    const { getSession } = await import('../src/main/session/store.js');
    const { isChatDeleted, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'de1e7ed9-1111-2222-3333-444444444444';
    const first = await createSession({ title: 'Legacy duplicate one', conversationId });
    const second = await createSession({ title: 'Legacy duplicate two', conversationId });
    const unrelated = await createSession({ title: 'Keep this chat', conversationId: 'de1e7eda-1111-2222-3333-444444444444' });

    const reply = await handlers.get('sessions:deleteMany')!(null, {
      ids: [first.id], permanent: true
    }) as any;

    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data).toMatchObject({ requested: 2, permanent: true, failed: [] });
    expect(new Set(reply.data.deleted.map((row: { id: string }) => row.id))).toEqual(new Set([first.id, second.id]));
    expect(await getSession(first.id)).toBeNull();
    expect(await getSession(second.id)).toBeNull();
    expect(await getSession(unrelated.id)).not.toBeNull();
    expect(isChatDeleted(conversationId)).toBe(true);
    resetBlockedChatsForTests();
  });

  it('preflights an entire bulk deletion before mutating any selected conversation', async () => {
    const { getSession } = await import('../src/main/session/store.js');
    const { isChatDeleted, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'de1e7ed4-1111-2222-3333-444444444444';
    const existing = await createSession({ title: 'Keep when batch preflight fails', conversationId });
    const deletedBefore = (await sessionList()).data.deleted;

    const reply = await handlers.get('sessions:deleteMany')!(null, {
      ids: [existing.id, '2026-09-14-deadbeef'],
      permanent: false
    }) as any;

    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/session not found/i);
    expect(await getSession(existing.id)).not.toBeNull();
    expect((await sessionList()).data.deleted).toBe(deletedBefore);
    expect(isChatDeleted(conversationId)).toBe(false);
    resetBlockedChatsForTests();
  });

  it('finishes the exact committed bulk deletion after a restart between selected rows', async () => {
    const { getSession, listDeletedSessions, permanentlyDeleteSession } = await import('../src/main/session/store.js');
    const { isChatDeleted, resetBlockedChatsForTests, restoreBlockedChats, setChatDeletedNow } = await import('../src/main/session/blocked-chats.js');
    const {
      SESSION_DELETION_BATCH_STATE,
      deleteRecordedSession,
      reconcilePendingSessionDeletionBatch
    } = await import('../src/main/session/deletion.js');
    resetBlockedChatsForTests();
    const firstConversation = 'de1e7ed5-1111-2222-3333-444444444444';
    const secondConversation = 'de1e7ed6-1111-2222-3333-444444444444';
    const first = await createSession({ title: 'Crash batch first', conversationId: firstConversation });
    const second = await createSession({ title: 'Crash batch second', conversationId: secondConversation });
    const createdAt = Date.now();
    await writeDurableNow(SESSION_DELETION_BATCH_STATE, {
      version: 1,
      id: '11111111-2222-4333-8444-555555555555',
      createdAt,
      permanent: false,
      rows: [
        { id: first.id, title: first.title, conversationId: firstConversation },
        { id: second.id, title: second.title, conversationId: secondConversation }
      ]
    });

    // Simulate a process exit after row one reached Trash but before the batch intent cleared.
    await deleteRecordedSession(first.id, false);
    expect(await getSession(first.id)).toBeNull();
    expect(await getSession(second.id)).not.toBeNull();
    resetBlockedChatsForTests();
    await restoreBlockedChats();

    const recovered = await reconcilePendingSessionDeletionBatch();
    expect(recovered).toMatchObject({ requested: 2, permanent: false, failed: [] });
    expect(recovered?.deleted.map(row => row.id)).toEqual([first.id, second.id]);
    expect(await getSession(first.id)).toBeNull();
    expect(await getSession(second.id)).toBeNull();
    expect((await listDeletedSessions()).map(row => row.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(isChatDeleted(firstConversation)).toBe(true);
    expect(isChatDeleted(secondConversation)).toBe(true);
    expect(await readDurable(SESSION_DELETION_BATCH_STATE)).toBeNull();
    await permanentlyDeleteSession(first.id);
    await permanentlyDeleteSession(second.id);
    await setChatDeletedNow(firstConversation, false);
    await setChatDeletedNow(secondConversation, false);
    resetBlockedChatsForTests();
  });

  it('finishes permanent bulk deletion after a crash between Trash move and recovery-copy removal', async () => {
    const { getSession, listDeletedSessions } = await import('../src/main/session/store.js');
    const { isChatDeleted, resetBlockedChatsForTests, restoreBlockedChats, setChatDeletedNow } = await import('../src/main/session/blocked-chats.js');
    const {
      SESSION_DELETION_BATCH_STATE,
      deleteRecordedSession,
      reconcilePendingSessionDeletionBatch
    } = await import('../src/main/session/deletion.js');
    resetBlockedChatsForTests();
    const firstConversation = 'de1e7ed7-1111-2222-3333-444444444444';
    const secondConversation = 'de1e7ed8-1111-2222-3333-444444444444';
    const first = await createSession({ title: 'Permanent crash first', conversationId: firstConversation });
    const second = await createSession({ title: 'Permanent crash second', conversationId: secondConversation });
    await writeDurableNow(SESSION_DELETION_BATCH_STATE, {
      version: 1,
      id: '22222222-3333-4444-8555-666666666666',
      createdAt: Date.now(),
      permanent: true,
      rows: [
        { id: first.id, title: first.title, conversationId: firstConversation },
        { id: second.id, title: second.title, conversationId: secondConversation }
      ]
    });

    // A permanent delete has two filesystem commits. Simulate a process exit after the active
    // history moved into Trash but before that recoverable copy was removed.
    await deleteRecordedSession(first.id, false);
    expect((await listDeletedSessions()).map(row => row.id)).toContain(first.id);
    expect(await getSession(second.id)).not.toBeNull();
    resetBlockedChatsForTests();
    await restoreBlockedChats();

    const recovered = await reconcilePendingSessionDeletionBatch();
    expect(recovered).toMatchObject({ requested: 2, permanent: true, failed: [] });
    expect(await getSession(first.id)).toBeNull();
    expect(await getSession(second.id)).toBeNull();
    expect((await listDeletedSessions()).map(row => row.id)).not.toEqual(expect.arrayContaining([first.id, second.id]));
    expect(isChatDeleted(firstConversation)).toBe(true);
    expect(isChatDeleted(secondConversation)).toBe(true);
    expect(await readDurable(SESSION_DELETION_BATCH_STATE)).toBeNull();
    await setChatDeletedNow(firstConversation, false);
    await setChatDeletedNow(secondConversation, false);
    resetBlockedChatsForTests();
  });

  it('empty Trash removes every old live duplicate and fences the browser identity', async () => {
    const { getSession } = await import('../src/main/session/store.js');
    const { isChatDeleted, resetBlockedChatsForTests, setChatDeletedNow } = await import('../src/main/session/blocked-chats.js');
    const { sessionForConversation } = await import('../src/main/session/recorder.js');
    resetBlockedChatsForTests();
    const conversationId = 'de1e7ed3-1111-2222-3333-444444444444';
    const trashed = await createSession({ title: 'Old Trash row', conversationId });
    expect((await handlers.get('sessions:delete')!(null, { id: trashed.id }) as any).ok).toBe(true);
    // Recreate the pre-fix state: a Trash copy existed but deletion did not retain a fence,
    // so the open page could produce more than one live replacement row.
    await setChatDeletedNow(conversationId, false);
    const duplicates = await Promise.all([
      createSession({ title: 'Old duplicate one', conversationId }),
      createSession({ title: 'Old duplicate two', conversationId })
    ]);

    const reply = await handlers.get('sessions:emptyTrash')!(null, undefined) as any;
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data).toEqual({ removed: 1, activeDuplicatesDeleted: 2 });
    expect((await sessionList()).data.deleted).toBe(0);
    for (const duplicate of duplicates) expect(await getSession(duplicate.id)).toBeNull();
    expect(isChatDeleted(conversationId)).toBe(true);
    expect(await sessionForConversation(conversationId)).toBeNull();
    resetBlockedChatsForTests();
  });

  it('purges every local record category only after the exact destructive confirmation', async () => {
    const { getSession, indexedSessions, listDeletedSessions } = await import('../src/main/session/store.js');
    const { createSidebarFolder, listSidebarFolders } = await import('../src/main/session/sidebar-folders.js');
    const trashed = await createSession({
      title: 'Old main chat in Trash',
      conversationId: 'purge-trash-1111-2222-3333-444444444444'
    });
    expect((await handlers.get('sessions:delete')!(null, { id: trashed.id }) as any).ok).toBe(true);
    const main = await createSession({
      title: 'Main channel',
      conversationId: 'purge-main-1111-2222-3333-444444444444'
    });
    const worker = await createSession({
      title: 'Worker 1',
      conversationId: 'purge-worker-1111-2222-3333-444444444444'
    });
    const toolOnly = await createSession({ title: 'Unattributed tool activity', conversationId: null });
    await createSidebarFolder('Purge fixture', [main.id, worker.id, toolOnly.id]);

    const rejected = await handlers.get('sessions:purgeAll')!(null, { confirmation: 'delete all' }) as any;
    expect(rejected.ok).toBe(false);
    expect(await getSession(main.id)).not.toBeNull();

    const reply = await handlers.get('sessions:purgeAll')!(null, { confirmation: 'DELETE ALL' }) as any;
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data).toMatchObject({ trashRemoved: 1, foldersRemoved: 1 });
    expect(reply.data.activeRemoved).toBeGreaterThanOrEqual(3);
    expect(await indexedSessions()).toEqual([]);
    expect(await listDeletedSessions()).toEqual([]);
    expect(await listSidebarFolders()).toEqual([]);
    expect(await getSession(main.id)).toBeNull();
    expect(await getSession(worker.id)).toBeNull();
    expect(await getSession(toolOnly.id)).toBeNull();
  });

  it('stores a manual chat nickname and rejects blank or oversized names', async () => {
    const session = await createSession({ title: 'Coding agent', conversationId: 'dddddddd-1111-2222-3333-444444444444' });
    const rename = (title: string) => handlers.get('sessions:rename')!(null, { id: session.id, title }) as Promise<any>;
    expect(await rename('My VFX render notes')).toMatchObject({ ok: true, data: true });
    expect((await sessionEvents({ id: session.id })).data.summary).toMatchObject({ title: 'My VFX render notes', titleSource: 'manual' });
    expect((await rename('   ')).ok).toBe(false);
    expect((await rename('x'.repeat(121))).ok).toBe(false);
  });

  it('reports the blocked set with every session list, so one paint marks every row', async () => {
    const { resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'cccccccc-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'listed while blocked', conversationId });

    expect((await sessionList()).data.blocked).toEqual([]);
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect((await sessionList()).data.blocked).toEqual([conversationId]);
    resetBlockedChatsForTests();
  });

  it('routes only the stored conversation through the extension and reports an unavailable Chrome process', async () => {
    const session = await createSession({
      title: 'open me',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    });
    const reply = await handlers.get('sessions:openChat')!(null, {
      id: session.id,
      timing: { clickAt: 10, ipcAt: 11 }
    }) as any;
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data).toMatchObject({
      ok: false,
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      failure: 'chrome_unavailable',
      timing: { renderer: { clickAt: 10, ipcAt: 11 } }
    });
    expect(openInPreferredBrowser).not.toHaveBeenCalled();

    const unattributed = await createSession({ title: 'no conversation', conversationId: null });
    const refused = await handlers.get('sessions:openChat')!(null, { id: unattributed.id }) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid ChatGPT conversation/i);
  });
});

describe('renderer pushes after the window is gone', () => {
  it('does not touch a destroyed BrowserWindow, whose members all throw', async () => {
    // Electron keeps the object after the window is destroyed, so the existing `?.` on
    // `getWindow()` never fires: the reference is truthy and reading `.webContents` throws.
    // The log push is the one that matters, because `onLog` listeners run synchronously on
    // the writer's stack — during a quit that turned every teardown log line into a throw
    // inside the teardown step that wrote it.
    const { logInfo } = await import('../src/main/logger.js');
    let touchedWebContents = false;
    const destroyed = {
      isDestroyed: () => true,
      get webContents() {
        touchedWebContents = true;
        throw new Error('Object has been destroyed');
      }
    } as unknown as import('electron').BrowserWindow;

    registerIpc(
      () => destroyed,
      () => {}
    );
    expect(() => logInfo('teardown progress written after the window went away')).not.toThrow();
    expect(touchedWebContents).toBe(false);
  });
});

describe('Stop IPC exact session and turn authority', () => {
  it('requires an explicit current turn and cannot stop a replacement conversation', async () => {
    const invoke = (payload: unknown) => handlers.get('sessions:stopTurn')!(null, payload) as Promise<any>;
    const conversationId = 'f1111111-aaaa-4bbb-8ccc-111111111111';
    const session = await createSession({ title: 'Stop IPC', conversationId });
    await appendEvent(session.id, { time: Date.now(), source: 'app', kind: 'turn_start', turnId: 'ipc-stop-one' });
    expect((await invoke({ id: session.id })).ok).toBe(false);
    expect(await invoke({ id: session.id, expectedTurnId: 'other-turn' })).toMatchObject({ ok: false, error: 'active_turn_changed' });
    // A stored historical start alone cannot authorize stopping a browser turn.
    expect(await invoke({ id: session.id, expectedTurnId: 'ipc-stop-one' })).toMatchObject({ ok: false, error: 'active_turn_changed' });
    await rebindSession(session.id, conversationId, 'f2222222-aaaa-4bbb-8ccc-111111111111');
    expect((await invoke({ id: session.id, expectedTurnId: 'ipc-stop-one' })).ok).toBe(false);
    const missing = await createSession({ title: 'No browser ownership', conversationId: null });
    expect(await invoke({ id: missing.id, expectedTurnId: 'ipc-stop-one' })).toMatchObject({ ok: false, error: 'session_not_recorded' });
  });
});

describe('Cancel IPC exact continuation authority', () => {
  it('requires the displayed token and cannot cancel a newer handoff for the same session', async () => {
    const continuation = await import('../src/main/session/continuation.js');
    const bridge = await import('../src/main/bridge.js');
    const from = 'c-ipc-cancel-token';
    const source = await createSession({ title: 'IPC Cancel token', conversationId: from });
    const a = await continuation.openContinuationNow(source.id, from, false);
    expect(await continuation.abortContinuationNow(a.token, 'other explicit cancellation')).toBe(true);
    const b = await continuation.openContinuationNow(source.id, from, false);
    const before = continuation.continuationByToken(b.token);
    const invoke = (payload: unknown) => handlers.get('sessions:cancelCompaction')!(null, payload) as Promise<any>;
    try {
      expect((await invoke({ id: source.id })).ok).toBe(false);
      expect(await invoke({ id: source.id, expectedToken: a.token })).toMatchObject({ ok: false, error: 'resume_changed' });
      expect(continuation.continuationByToken(b.token)).toEqual(before);
      expect((await invoke({ id: source.id, expectedToken: b.token })).ok).toBe(true);
      expect(continuation.continuationByToken(b.token)?.state).toBe('aborted');
    } finally { await bridge.cancelResumeNow(source.id); }
  });
});

describe('profile lifecycle runtime progression', () => {
  it('records profile collisions as structured profile-owned warning events', async () => {
    const { ProfileLifecycleCoordinator } = await import('../src/main/profile-lifecycle.js');
    const { WorkAdmissionGate } = await import('../src/main/work-admission.js');
    const { getLog, setLogProfileContext } = await import('../src/main/logger.js');
    const before = structuredClone(getConfig());
    const profileId = getActiveInstanceRuntime().profile.id;
    const lifecycle = new ProfileLifecycleCoordinator({
      profileId,
      admission: new WorkAdmissionGate(),
      census: async () => ({ profileId, blockers: [] }),
      readDeferredSwitch: async () => null,
      writeDeferredSwitch: async () => undefined,
      onSwitchReady: vi.fn(),
      applyUpdate: vi.fn(),
      applyShutdown: vi.fn()
    });
    const stop = registerIpc(() => null, () => { quitToInstallCalls += 1; }, lifecycle);
    setLogProfileContext(profileId);
    try {
      const request = { nickname: 'Collision A', browserProfileDirectory: 'Profile collision-fixture' };
      const first = await handlers.get('instances:create')!(null, request) as any;
      expect(first.ok, first.error).toBe(true);
      const second = await handlers.get('instances:create')!(null, { ...request, nickname: 'Collision B' }) as any;
      expect(second).toMatchObject({ ok: false, code: 'browser_profile_collision' });
      expect(getLog().findLast(entry => entry.event === 'profile.collision')).toMatchObject({
        level: 'warn',
        profileId,
        event: 'profile.collision'
      });
      expect(getLog().findLast(entry => entry.event === 'profile.collision')?.message)
        .toContain('browser_profile_collision');
    } finally {
      setLogProfileContext(null);
      stop();
      await saveConfig(before);
    }
  });

  it('polls a busy deferred switch to idle, pushes renderer status, and invokes the handoff exactly once', async () => {
    vi.useFakeTimers();
    const { ProfileLifecycleCoordinator } = await import('../src/main/profile-lifecycle.js');
    const { WorkAdmissionGate } = await import('../src/main/work-admission.js');
    const profileId = getActiveInstanceRuntime().profile.id;
    let blockers = [{ category: 'worker', count: 1 }];
    let durable: unknown = null;
    const census = vi.fn(async () => ({ profileId, blockers }));
    const ready = vi.fn(async () => undefined);
    const lifecycle = new ProfileLifecycleCoordinator({
      profileId,
      admission: new WorkAdmissionGate(),
      census,
      readDeferredSwitch: async () => durable,
      writeDeferredSwitch: async state => { durable = state ? structuredClone(state) : null; },
      onSwitchReady: ready,
      applyUpdate: vi.fn(),
      applyShutdown: vi.fn()
    });
    currentWindow = {
      setBackgroundColor: vi.fn(),
      setTitleBarOverlay: vi.fn(),
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    };
    const stop = registerIpc(() => currentWindow as any, () => { quitToInstallCalls += 1; }, lifecycle);
    try {
      expect((await lifecycle.requestSwitch('poll-target', true)).outcome).toBe('draining');
      expect(ready).not.toHaveBeenCalled();
      currentWindow.webContents.send.mockClear();

      blockers = [];
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(lifecycle.getStatus()).toMatchObject({ phase: 'switch-ready', targetProfileId: 'poll-target' });
      expect(ready).toHaveBeenCalledTimes(1);
      expect(currentWindow.webContents.send).toHaveBeenCalledWith(
        'instances:changed',
        expect.objectContaining({ drain: expect.objectContaining({ state: 'ready' }) })
      );

      const censusAtReady = census.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(census).toHaveBeenCalledTimes(censusAtReady);
      expect(ready).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it('stops lifecycle polling at shutdown cleanup even when a Drain is still busy', async () => {
    vi.useFakeTimers();
    const { ProfileLifecycleCoordinator } = await import('../src/main/profile-lifecycle.js');
    const { WorkAdmissionGate } = await import('../src/main/work-admission.js');
    const profileId = getActiveInstanceRuntime().profile.id;
    let blockers = [{ category: 'mcp-request', count: 1 }];
    const census = vi.fn(async () => ({ profileId, blockers }));
    const ready = vi.fn(async () => undefined);
    const lifecycle = new ProfileLifecycleCoordinator({
      profileId,
      admission: new WorkAdmissionGate(),
      census,
      readDeferredSwitch: async () => null,
      writeDeferredSwitch: async () => undefined,
      onSwitchReady: ready,
      applyUpdate: vi.fn(),
      applyShutdown: vi.fn()
    });
    const stop = registerIpc(() => null, () => { quitToInstallCalls += 1; }, lifecycle);
    try {
      await lifecycle.requestSwitch('shutdown-target', true);
      const censusBeforeStop = census.mock.calls.length;
      stop();
      blockers = [];
      await vi.advanceTimersByTimeAsync(5_000);

      expect(census).toHaveBeenCalledTimes(censusBeforeStop);
      expect(lifecycle.getStatus().phase).toBe('draining-switch');
      expect(ready).not.toHaveBeenCalled();
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it('routes update:install through Drain and applies only after automatic idle verification', async () => {
    vi.useFakeTimers();
    const { ProfileLifecycleCoordinator } = await import('../src/main/profile-lifecycle.js');
    const { WorkAdmissionGate } = await import('../src/main/work-admission.js');
    const profileId = getActiveInstanceRuntime().profile.id;
    let blockers = [{ category: 'active-turn', count: 1 }];
    const census = vi.fn(async () => ({ profileId, blockers }));
    const applyUpdate = vi.fn(async () => undefined);
    const lifecycle = new ProfileLifecycleCoordinator({
      profileId,
      admission: new WorkAdmissionGate(),
      census,
      readDeferredSwitch: async () => null,
      writeDeferredSwitch: async () => undefined,
      onSwitchReady: vi.fn(),
      applyUpdate,
      applyShutdown: vi.fn()
    });
    const stop = registerIpc(() => null, () => { quitToInstallCalls += 1; }, lifecycle);
    try {
      const requested = await handlers.get('update:install')!(null, undefined) as any;
      expect(requested).toMatchObject({
        ok: true,
        data: {
          activeProfileId: profileId,
          drain: {
            kind: 'update',
            phase: 'draining-update',
            state: 'draining',
            pendingOperations: 1
          }
        }
      });
      expect(lifecycle.getStatus()).toMatchObject({ phase: 'draining-update', blockerCount: 1 });
      expect(applyUpdate).not.toHaveBeenCalled();

      blockers = [];
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lifecycle.getStatus().phase).toBe('update-applied');
      expect(applyUpdate).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(applyUpdate).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});


it('validates and preserves external endpoint fields through Settings Save without erasing them in a legacy payload', async () => {
  const original = getConfig();
  try {
    const base = structuredClone(original);
    expect((await save({ ...base, tunnel: { ...base.tunnel, manualPublicOrigin: 'https://Delta.example.com/', manualPort: 9770 } }, base)).ok).toBe(true);
    expect(getConfig().tunnel).toMatchObject({ manualPublicOrigin: 'https://Delta.example.com', manualPort: 9770 });
    const next = structuredClone(getConfig());
    const legacy = { ...next, tunnel: { ...next.tunnel } };
    delete legacy.tunnel.manualPublicOrigin; delete legacy.tunnel.manualPort;
    expect((await save(legacy, next)).ok).toBe(true);
    expect(getConfig().tunnel).toMatchObject({ manualPublicOrigin: 'https://Delta.example.com', manualPort: 9770 });
    expect((await save({ ...next, tunnel: { ...next.tunnel, manualPublicOrigin: 'https://user:secret@example.com' } }, next)).ok).toBe(false);
  } finally { await saveConfig(original); }
});


describe('final prepared native instruction authorization', () => {
  it('holds an existing queued delivery when selected Skill source validation fails', async () => {
    const ipc = await import('../src/main/ipc.js');
    const skills = await import('../src/main/session/skill-prompt.js');
    const projects = await import('../src/main/projects.js');
    const scope = await import('../src/main/mcp/plan-tool.js');
    const body = 'app-owned frame with cos-skill-body-sha256: selected Skill';
    const folder = { real: fixturePath('selected-project'), virtual: '/project' };
    const project = vi.spyOn(projects, 'getSessionProject').mockResolvedValue(folder);
    const verify = vi.spyOn(skills, 'verifySelectedSkillBodies').mockRejectedValue(new Error('Skill source changed'));
    const human = vi.spyOn(scope, 'nativeExecutionScopeForPreparedInput').mockResolvedValue(null);
    const entry = { id: 'frozen-skill-input', sessionId: 'bound-session', conversationId: 'bound-native',
      text: 'Keep the original task', deliveryText: body } as import('../src/main/session/input.js').InputEntry;
    try {
      await expect(ipc.preparedNativeScopeCurrent(entry, [])).rejects.toThrow('Skill source changed');
      expect(verify).toHaveBeenCalledWith(body, { projectPath: folder.real });
      expect(human).not.toHaveBeenCalled();
      expect(entry.deliveryText).toBe(body); // Never rewrite ambiguous or already frozen delivery bytes.
    } finally { project.mockRestore(); verify.mockRestore(); human.mockRestore(); }
  });

  it('checks opening prompts too and refuses a project rebind while checking selected Skills', async () => {
    const ipc = await import('../src/main/ipc.js');
    const skills = await import('../src/main/session/skill-prompt.js');
    const projects = await import('../src/main/projects.js');
    const first = { real: fixturePath('project-a'), virtual: '/a' };
    const second = { real: fixturePath('project-b'), virtual: '/b' };
    const project = vi.spyOn(projects, 'projectWorkspace').mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const verify = vi.spyOn(skills, 'verifySelectedSkillBodies').mockResolvedValue([]);
    const entry = { id: 'opening-skill-input', projectId: 'selected-project', text: 'Original task',
      deliveryText: 'app frame cos-skill-body-sha256:' } as import('../src/main/session/input.js').InputEntry;
    try {
      expect(await ipc.preparedNativeScopeCurrent(entry, [])).toBe(false);
      expect(verify).toHaveBeenCalledWith(entry.deliveryText, { projectPath: first.real });
    } finally { project.mockRestore(); verify.mockRestore(); }
  });

  it('keeps the exact human scope check after asynchronous Skill validation', async () => {
    const ipc = await import('../src/main/ipc.js');
    const skills = await import('../src/main/session/skill-prompt.js');
    const scope = await import('../src/main/mcp/plan-tool.js');
    let checked = false;
    const verify = vi.spyOn(skills, 'verifySelectedSkillBodies').mockImplementation(async () => { checked = true; return []; });
    const human = vi.spyOn(scope, 'nativeExecutionScopeForPreparedInput').mockImplementation(async () => {
      expect(checked).toBe(true);
      return 'b'.repeat(64); // A newer human correction must still veto the old prepared payload.
    });
    const entry = { id: 'human-scope-input', sessionId: 'bound-session', conversationId: 'bound-native',
      text: 'Original task', deliveryText: 'cos-execution-scope-sha256:' + 'a'.repeat(64) } as import('../src/main/session/input.js').InputEntry;
    try { expect(await ipc.preparedNativeScopeCurrent(entry, [])).toBe(false); }
    finally { verify.mockRestore(); human.mockRestore(); }
  });
});


it('rejects actual frozen Skill bytes after a managed file edit and accepts freshly prepared bytes', async () => {
  const { initSkills, importSkillFile, skillsDirectory } = await import('../src/main/skills.js');
  const { prepareSessionPrompt } = await import('../src/main/session/prompt.js');
  const { preparedNativeScopeCurrent } = await import('../src/main/ipc.js');
  await initSkills(dir, { installDefaults: false });
  const source = fixturePath('frozen-source.md');
  const v1 = '---\nname: Root Attestation\ndescription: Exact frozen source verification\n---\nROOT_ATTEST_V1';
  await fs.writeFile(source, v1);
  const installed = await importSkillFile(source);
  const text = '/' + installed.id + '\nKeep the original task.';
  const frozen = await prepareSessionPrompt(text);
  const entry = { id: 'actual-frozen-skill', text, deliveryText: frozen } as import('../src/main/session/input.js').InputEntry;
  expect(await preparedNativeScopeCurrent(entry, [])).toBe(true);
  await fs.writeFile(path.join(skillsDirectory()!, installed.id, 'SKILL.md'), v1.replace('ROOT_ATTEST_V1', 'ROOT_ATTEST_V2'));
  await expect(preparedNativeScopeCurrent(entry, [])).rejects.toThrow(/changed after preparation/);
  expect(entry.deliveryText).toBe(frozen);
  const fresh = await prepareSessionPrompt(text);
  expect(fresh).toContain('ROOT_ATTEST_V2');
  expect(await preparedNativeScopeCurrent({ ...entry, deliveryText: fresh }, [])).toBe(true);
});

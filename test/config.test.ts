import { REASONING_EFFORTS } from '../src/shared/session.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GOAL_MODEL,
  assertCurrentApprovedRoots,
  createLocalInstanceProfile,
  configureApprovedRootPublicationRefresh,
  configureSharedAccountSettings,
  defaultConfig,
  getActiveInstanceRuntime,
  getActiveInstanceOwnerPaths,
  developmentBrowserBridgeInstanceId,
  getConfig,
  initConfigPath,
  loadConfig,
  prepareIsolatedInstanceRuntimeConfig,
  readCanonicalInstanceConfig,
  assertActiveSecureTunnelIsolation,
  refreshSharedFolderAccess,
  renameLocalInstanceProfile,
  saveConfig,
  setLocalInstanceBrowserProfile,
  setLocalInstanceBridgePort,
  setSharedFolderAccess,
  snapshotConfigForInstance,
  stageInstanceActivationForNextStart,
  updateConfig
} from '../src/main/config.js';
import { DESKTOP_CAPABILITIES, type Capability } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { openInPreferredBrowser } from '../src/main/browser.js';
import { instanceConnectorAccountAlias, sharedAccountPreferencesSchema } from '../src/shared/instance-profile.js';

let dir: string;
const fixturePath = (...parts: string[]): string => path.join(dir, ...parts);
const hostPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const hostPlatformLabel = hostPlatform === 'win32' ? 'Windows' : hostPlatform === 'darwin' ? 'Mac' : 'Linux';

beforeAll(async () => {
  dir = await makeTempDir('clf-config-');
  initConfigPath(dir);
});

afterAll(async () => {
  await removeTempDir(dir);
});

describe('settings migration', () => {
  it('defaults fresh ordinary turns to 30 minutes and preserves an explicit Off', async () => {
    expect(defaultConfig().ui.rotateTurnMinutes).toBe(30);
    const before = getConfig();
    try {
      await saveConfig({ ...before, ui: { ...before.ui, rotateTurnMinutes: 0 } });
      expect(getConfig().ui.rotateTurnMinutes).toBe(0);
    } finally { await saveConfig(before); }
  });
  it('explicit local settings share updates prepared paused accounts without widening private controls', async () => {
    const root = await makeTempDir('clf-common-settings-');
    const addedRoot = await makeTempDir('clf-common-settings-added-');
    const schemaRefresh = vi.fn();
    const { createKeepAwake, installKeepAwake } = await import('../src/main/keep-awake.js');
    const sleepBlocker = { start: vi.fn(() => 19), stop: vi.fn() };
    let stopAwake = () => {};
    try {
      initConfigPath(root); await loadConfig();
      await updateConfig(config => ({ ...config, roots: [{ name: 'workspace', path: root }] }));
      const peer = await createLocalInstanceProfile('Peer', 'Profile 4');
      const privateRoot = await prepareIsolatedInstanceRuntimeConfig(peer.id);
      initConfigPath(privateRoot, root); await loadConfig();
      await updateConfig(config => ({ ...config,
        ui: { ...config.ui, theme: 'dark', privacyScreenshots: true, automationPaused: true, automationProfile: 'overnight', keepAwake: true },
        multiAgent: { ...config.multiAgent, enabled: false, defaultModel: 'gpt-5.5', defaultReasoning: 'xhigh', allowUnattributedCalls: false },
        goal: { ...config.goal, model: 'gpt-5.5', reasoningEffort: 'high', backend: 'templates' },
        readOnly: true, capabilities: { ...config.capabilities, exec: false },
        sessions: { ...config.sessions, record: false, retainDays: 7 }
      }));
      const privateBytes = await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8');
      const privateControls = getConfig();
      initConfigPath(root); await loadConfig();
      await updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'light', privacyScreenshots: false, keepAwake: false },
        multiAgent: { ...config.multiAgent, maxWorkers: 2 }, sessions: { ...config.sessions, advisoryTokens: 120_000, limitTokens: 160_000 } }));
      const enabled = await configureSharedAccountSettings({ action: 'enable', drives: [], dryRun: false });
      expect(enabled).toMatchObject({ changed: true, revision: 1, projectedRevision: 1, commonPreferencesEnabled: true });
      const future = await createLocalInstanceProfile('Future', 'Profile 5');
      const futureConfig = await snapshotConfigForInstance(future.id);
      expect(futureConfig.ui.theme).toBe('light');
      expect(futureConfig.ui.keepAwake).toBe(false);
      expect(futureConfig.roots).toEqual([{ name: 'workspace', path: root }]);
      expect(futureConfig.multiAgent).toMatchObject({ defaultModel: 'gpt-6-thinking', defaultReasoning: 'high', maxWorkers: 2 });
      const primaryBytes = await fs.readFile(path.join(root, 'config.json'), 'utf8');
      initConfigPath(privateRoot, root); await loadConfig();
      const inspect = await configureSharedAccountSettings({ action: 'inspect', drives: [], dryRun: false });
      expect(inspect).toMatchObject({ changed: false, revision: 1, projectedRevision: 1, commonPreferencesEnabled: true });
      expect(inspect.projectedPreferences!.ui).toMatchObject({ theme: 'light', privacyScreenshots: true, keepAwake: false });
      expect(inspect.storedPreferences!.ui.privacyScreenshots).toBe(false);
      expect(inspect.canonicalProfileRoots.find(profile => profile.profileId === peer.id)?.roots)
        .toEqual([{ name: 'workspace', path: hostPlatform === 'win32' ? root.toLowerCase() : root }]);
      const projected = getConfig();
      expect(projected.ui).toMatchObject({ automationPaused: true, automationProfile: 'overnight' });
      expect(projected.multiAgent).toMatchObject({ enabled: false, defaultModel: 'gpt-5.5', defaultReasoning: 'xhigh', allowUnattributedCalls: false, maxWorkers: 2 });
      expect(projected.goal).toEqual(privateControls.goal);
      expect(projected.capabilities).toEqual(privateControls.capabilities);
      expect(projected.readOnly).toBe(true);
      expect(projected.sessions).toMatchObject({ record: false, retainDays: 7, advisoryTokens: 120_000, limitTokens: 160_000 });
      expect(projected.tunnel).toEqual(privateControls.tunnel);
      expect(projected.instances!.profiles.find(profile => profile.id === peer.id)!.browser)
        .toEqual(privateControls.instances!.profiles.find(profile => profile.id === peer.id)!.browser);
      expect(sharedAccountPreferencesSchema.safeParse({ ...inspect.storedPreferences, model: 'gpt-5.5' }).success).toBe(false);
      expect(sharedAccountPreferencesSchema.safeParse({ ...inspect.storedPreferences,
        ui: { ...inspect.storedPreferences!.ui, automationPaused: false } }).success).toBe(false);
      for (const action of ['enable', 'disable'] as const) {
        await expect(configureSharedAccountSettings({ action, drives: [], dryRun: true })).rejects.toThrow(/primary/);
      }
      expect(await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8')).toBe(privateBytes);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(primaryBytes);
      const awake = createKeepAwake({ enabled: () => getConfig().ui.keepAwake !== false,
        sessions: async () => [{ id: 'shared-awake', endedAt: null, activityExpiresAt: Date.now() + 30_000 }] as any,
        blocker: sleepBlocker });
      stopAwake = installKeepAwake(awake);
      await awake.refresh();
      expect(sleepBlocker.start).not.toHaveBeenCalled();
      // Simulate the existing primary publisher while the paused child remains live.
      const updated = JSON.parse(primaryBytes);
      updated.ui.theme = 'dark';
      updated.ui.keepAwake = true;
      updated.sharedAccountPreferences.preferences.ui.theme = 'dark';
      updated.sharedAccountPreferences.preferences.ui.keepAwake = true;
      updated.roots.push({ name: 'added-workspace', path: addedRoot });
      updated.instances.sharedFolderAccess.roots = updated.roots;
      updated.instances.sharedFolderAccess.revision += 1;
      updated.sharedAccountPreferences.revision += 1;
      await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(updated), 'utf8');
      configureApprovedRootPublicationRefresh(schemaRefresh);
      const refreshed = await configureSharedAccountSettings({ action: 'inspect', drives: [], dryRun: false });
      expect(refreshed).toMatchObject({ revision: 2, projectedRevision: 2 });
      expect(refreshed.projectedPreferences!.ui.theme).toBe('dark');
      expect(getConfig().ui.keepAwake).toBe(true);
      expect(sleepBlocker.start).toHaveBeenCalledTimes(1);
      expect(refreshed.projectedRoots.map(entry => entry.name)).toEqual(['workspace', 'added-workspace']);
      expect(schemaRefresh).toHaveBeenCalledTimes(1);
      await refreshSharedFolderAccess();
      expect(schemaRefresh).toHaveBeenCalledTimes(1);

      // A reusable-preference revision shares no tool-schema authority. It must not create a
      // second Core publication while private model, credential, permission and pause controls
      // remain local to this account.
      const preferencesOnly = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
      preferencesOnly.ui.theme = 'light';
      preferencesOnly.ui.keepAwake = false;
      preferencesOnly.sharedAccountPreferences.preferences.ui.theme = 'light';
      preferencesOnly.sharedAccountPreferences.preferences.ui.keepAwake = false;
      preferencesOnly.instances.sharedFolderAccess.revision += 1;
      preferencesOnly.sharedAccountPreferences.revision += 1;
      await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(preferencesOnly), 'utf8');
      const preferenceRefresh = await configureSharedAccountSettings({ action: 'inspect', drives: [], dryRun: false });
      expect(preferenceRefresh).toMatchObject({ revision: 3, projectedRevision: 3 });
      expect(schemaRefresh).toHaveBeenCalledTimes(1);
      expect(getConfig().ui.keepAwake).toBe(false);
      expect(sleepBlocker.stop).toHaveBeenCalledWith(19);
      expect(getConfig().ui.automationPaused).toBe(true);
      expect(getConfig().goal).toEqual(privateControls.goal);
      expect(getConfig().tunnel).toEqual(privateControls.tunnel);
      expect(getConfig().capabilities).toEqual(privateControls.capabilities);
      expect(await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8')).toBe(privateBytes);
    } finally {
      stopAwake();
      configureApprovedRootPublicationRefresh(null);
      initConfigPath(dir); await loadConfig();
      await removeTempDir(addedRoot); await removeTempDir(root);
    }
  });

  it('whole-drive settings control validates atomically, previews read-only, and is revision-idempotent', async () => {
    const root = await makeTempDir('clf-common-drive-');
    try {
      initConfigPath(root); await loadConfig();
      const drive = path.parse(root).root;
      const before = await fs.readFile(path.join(root, 'config.json'), 'utf8');
      const preview = await configureSharedAccountSettings({ action: 'enable', drives: [drive], dryRun: true });
      expect(preview).toMatchObject({ dryRun: true, changed: true, revision: 0, projectedRevision: 0,
        sharedFoldersEnabled: false, storedRoots: [], projectedRoots: [], plannedRevision: 1 });
      expect(preview.plannedRoots?.[0]?.path).toBe(drive);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(before);
      for (const drives of [[drive, root], [drive, drive], [root], ['relative'], ['C:'], ['C:/'], ['\\\\server\\share\\']]) {
        await expect(configureSharedAccountSettings({ action: 'enable', drives, dryRun: false })).rejects.toThrow();
        expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(before);
        expect(getConfig().roots).toEqual([]);
      }
      await expect(configureSharedAccountSettings({ action: 'inspect', drives: [drive], dryRun: false })).rejects.toThrow();
      const enabled = await configureSharedAccountSettings({ action: 'enable', drives: [drive], dryRun: false });
      expect(enabled).toMatchObject({ changed: true, revision: 1, sharedFoldersEnabled: true, commonPreferencesEnabled: true });
      const committed = await fs.readFile(path.join(root, 'config.json'), 'utf8');
      expect(await configureSharedAccountSettings({ action: 'enable', drives: [drive], dryRun: false }))
        .toMatchObject({ changed: false, revision: 1 });
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(committed);
      await updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'light' } }));
      expect(getConfig().sharedAccountPreferences).toMatchObject({ revision: 2, preferences: { ui: { theme: 'light' } } });
      await updateConfig(config => ({ ...config, ui: { ...config.ui, automationPaused: true },
        multiAgent: { ...config.multiAgent, defaultModel: 'gpt-5.5' } }));
      expect(getConfig().instances!.sharedFolderAccess!.revision).toBe(2);
      expect(await configureSharedAccountSettings({ action: 'disable', drives: [], dryRun: false }))
        .toMatchObject({ changed: true, revision: 3, sharedFoldersEnabled: false, commonPreferencesEnabled: false });
      await updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'dark' } }));
      expect(getConfig().sharedAccountPreferences).toMatchObject({ revision: 3, preferences: { ui: { theme: 'light' } } });
      const foreign = getConfig();
      await updateConfig(config => ({ ...config, instances: { ...config.instances!, sharedFolderAccess: {
        ...foreign.instances!.sharedFolderAccess!, deviceId: 'fafb334a-4bca-4e57-9d33-8e4ac8aab2ac'
      } }, sharedAccountPreferences: { ...foreign.sharedAccountPreferences!, deviceId: 'fafb334a-4bca-4e57-9d33-8e4ac8aab2ac' } }));
      await expect(configureSharedAccountSettings({ action: 'enable', drives: [], dryRun: false })).rejects.toThrow(/another device/);
    } finally { initConfigPath(dir); await loadConfig(); await removeTempDir(root); }
  });

  it('sharing Off freezes the last shared preferences equally across private-write and read-only children', async () => {
    const root = await makeTempDir('clf-common-off-');
    try {
      initConfigPath(root); await loadConfig();
      await updateConfig(config => ({ ...config, roots: [{ name: 'workspace', path: root }] }));
      const peers = [await createLocalInstanceProfile('ReadOnly', 'Profile 4'), await createLocalInstanceProfile('Writer', 'Profile 5')];
      const privateRoots: string[] = [];
      for (const peer of peers) {
        privateRoots.push(await prepareIsolatedInstanceRuntimeConfig(peer.id));
      }
      for (const privateRoot of privateRoots) {
        initConfigPath(privateRoot, root); await loadConfig();
        await updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'dark', automationPaused: true },
          multiAgent: { ...config.multiAgent, defaultModel: 'gpt-5.5', defaultReasoning: 'high' } }));
      }
      initConfigPath(root); await loadConfig();
      await updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'light' } }));
      await configureSharedAccountSettings({ action: 'enable', drives: [], dryRun: false });
      for (let index = 0; index < privateRoots.length; index++) {
        initConfigPath(privateRoots[index]!, root); await loadConfig();
        expect(getConfig().ui.theme).toBe('light');
        if (index === 1) await updateConfig(config => ({ ...config, ui: { ...config.ui, automationProfile: 'overnight' } }));
      }
      initConfigPath(root); await loadConfig();
      await configureSharedAccountSettings({ action: 'disable', drives: [], dryRun: false });
      for (const privateRoot of privateRoots) {
        initConfigPath(privateRoot, root); await loadConfig();
        expect(getConfig().ui).toMatchObject({ theme: 'light', automationPaused: true });
        expect(getConfig().multiAgent).toMatchObject({ defaultModel: 'gpt-5.5', defaultReasoning: 'high' });
        await updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'dark' } }));
        await loadConfig();
        expect(getConfig().ui.theme).toBe('dark');
        expect(getConfig().instances!.sharedFolderAccess!.enabled).toBe(false);
      }
    } finally { initConfigPath(dir); await loadConfig(); await removeTempDir(root); }
  });

  it('enabled and disabled shared settings remain readable by the pinned pre-shared-preferences Config schema', async () => {
    // Strict release checkouts need not contain private, unrelated Git history.
    // This immutable reader preserves cb09509b and its exact relative dependencies,
    // rather than compiling the old Config against today's evolving shared schemas.
    const legacyReader = await fs.readFile(new URL('./fixtures/config-preferences-legacy-reader.cjs', import.meta.url), 'utf8');
    expect(createHash('sha256').update(legacyReader).digest('hex'))
      .toBe('f1a6cddf9a3cdb2a83a7fc56243785ae63771efeb4fd9ecc4a006763173d0063');
    const module = { exports: {} as { configSchema?: { parse(value: unknown): Record<string, unknown> } } };
    runInNewContext(legacyReader, { module, exports: module.exports, require: createRequire(import.meta.url), process, console });
    const prior = module.exports.configSchema!;
    const root = await makeTempDir('clf-common-predecessor-');
    try {
      initConfigPath(root); await loadConfig();
      await updateConfig(config => ({ ...config, roots: [{ name: 'workspace', path: root }],
        ui: { ...config.ui, automationPaused: true } }));
      await configureSharedAccountSettings({ action: 'enable', drives: [], dryRun: false });
      for (const enabled of [true, false]) {
        if (!enabled) await configureSharedAccountSettings({ action: 'disable', drives: [], dryRun: false });
        const current = getConfig();
        if (enabled) {
          const incompatiblePrototype = structuredClone(current) as typeof current & { sharedAccountPreferences?: unknown };
          Object.assign(incompatiblePrototype.instances!.sharedFolderAccess!, { commonPreferences: current.sharedAccountPreferences!.preferences });
          delete incompatiblePrototype.sharedAccountPreferences;
          expect(() => prior.parse(incompatiblePrototype)).toThrow();
        }
        const oldRead = prior.parse(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')));
        expect(oldRead.sharedAccountPreferences).toBeUndefined();
        expect(oldRead.instances).toEqual(current.instances);
        expect(oldRead.roots).toEqual(current.roots);
        expect(oldRead.tunnel).toEqual(current.tunnel);
        expect(oldRead.ui).toMatchObject({ automationPaused: true });
        // An ordinary predecessor rewrite may drop the optional extension, not the grant.
        await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(oldRead), 'utf8');
        await loadConfig();
        expect(getConfig().sharedAccountPreferences).toBeUndefined();
        expect((await configureSharedAccountSettings({ action: 'inspect', drives: [], dryRun: false })).commonPreferencesEnabled).toBe(false);
        expect(getConfig().instances!.sharedFolderAccess!.enabled).toBe(enabled);
        if (enabled) await configureSharedAccountSettings({ action: 'enable', drives: [], dryRun: false });
      }
    } finally { initConfigPath(dir); await loadConfig(); await removeTempDir(root); }
  });

  it('folder-only UI re-enable never reactivates an old common preference snapshot', async () => {
    const root = await makeTempDir('clf-common-folder-only-');
    try {
      initConfigPath(root); await loadConfig();
      await updateConfig(config => ({ ...config, roots: [{ name: 'workspace', path: root }], ui: { ...config.ui, theme: 'light' } }));
      const peer = await createLocalInstanceProfile('Peer', 'Profile 4');
      const privateRoot = await prepareIsolatedInstanceRuntimeConfig(peer.id);
      await configureSharedAccountSettings({ action: 'enable', drives: [], dryRun: false });
      await configureSharedAccountSettings({ action: 'disable', drives: [], dryRun: false });
      initConfigPath(privateRoot, root); await loadConfig();
      await updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'dark', automationPaused: true } }));
      initConfigPath(root); await loadConfig();
      const folderOnly = await setSharedFolderAccess(true);
      expect(folderOnly.instances!.sharedFolderAccess!.enabled).toBe(true);
      expect(folderOnly.sharedAccountPreferences).toBeUndefined();
      initConfigPath(privateRoot, root); await loadConfig();
      expect(getConfig().ui).toMatchObject({ theme: 'dark', automationPaused: true });
      expect(getConfig().sharedAccountPreferences).toBeUndefined();
      initConfigPath(root); await loadConfig();
      await configureSharedAccountSettings({ action: 'enable', drives: [], dryRun: false });
      expect(getConfig().sharedAccountPreferences!.preferences.ui.theme).toBe('light');
      initConfigPath(privateRoot, root); await loadConfig();
      expect(getConfig().ui).toMatchObject({ theme: 'light', automationPaused: true });
    } finally { initConfigPath(dir); await loadConfig(); await removeTempDir(root); }
  });

  it('migrates prototype preferences read-only and rejects foreign, stale or conflicting snapshots', async () => {
    const root = await makeTempDir('clf-common-envelope-');
    try {
      initConfigPath(root); await loadConfig();
      await updateConfig(config => ({ ...config, roots: [{ name: 'workspace', path: root }] }));
      await configureSharedAccountSettings({ action: 'enable', drives: [], dryRun: false });
      const original = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
      const envelope = original.sharedAccountPreferences;
      const legacy = structuredClone(original);
      legacy.instances.sharedFolderAccess.commonPreferences = legacy.sharedAccountPreferences.preferences;
      delete legacy.sharedAccountPreferences;
      const bytes = JSON.stringify(legacy);
      await fs.writeFile(path.join(root, 'config.json'), bytes, 'utf8');
      expect((await loadConfig()).sharedAccountPreferences).toEqual(envelope);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(bytes);
      for (const malformed of [
        { ...original, sharedAccountPreferences: { ...envelope, revision: envelope.revision + 1 } },
        { ...original, sharedAccountPreferences: { ...envelope, deviceId: 'fafb334a-4bca-4e57-9d33-8e4ac8aab2ac' } },
        { ...original, sharedAccountPreferences: { ...envelope, platform: hostPlatform === 'win32' ? 'darwin' : 'win32' } },
        { ...original, sharedAccountPreferences: { ...envelope, preferences: { ...envelope.preferences, models: 'not allowed' } } },
        { ...legacy, sharedAccountPreferences: { ...envelope, preferences: { ...envelope.preferences,
          ui: { ...envelope.preferences.ui, theme: envelope.preferences.ui.theme === 'light' ? 'dark' : 'light' } } } }
      ]) {
        const invalidBytes = JSON.stringify(malformed);
        await fs.writeFile(path.join(root, 'config.json'), invalidBytes, 'utf8');
        await expect(loadConfig()).rejects.toThrow();
        expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(invalidBytes);
      }
    } finally { initConfigPath(dir); await loadConfig(); await removeTempDir(root); }
  });

  it.each([
    { label: 'at the same revision', revisionBump: 0, canonicalEnabled: true },
    { label: 'after missing the Off transition', revisionBump: 2, canonicalEnabled: true },
    { label: 'when an old reader drops the Off snapshot', revisionBump: 1, canonicalEnabled: false }
  ])('live preference authority loss $label refuses stale projection writes until a coherent disk reload', async ({ revisionBump, canonicalEnabled }) => {
    const root = await makeTempDir('clf-common-loss-');
    try {
      initConfigPath(root); await loadConfig();
      await updateConfig(config => ({ ...config, roots: [{ name: 'workspace', path: root }], ui: { ...config.ui, theme: 'dark' } }));
      const peer = await createLocalInstanceProfile('Peer', 'Profile 4');
      const privateRoot = await prepareIsolatedInstanceRuntimeConfig(peer.id);
      await updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'light' } }));
      await configureSharedAccountSettings({ action: 'enable', drives: [], dryRun: false });
      const stripped = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
      delete stripped.sharedAccountPreferences;
      stripped.instances.sharedFolderAccess.revision += revisionBump;
      stripped.instances.sharedFolderAccess.enabled = canonicalEnabled;
      initConfigPath(privateRoot, root); await loadConfig();
      expect(getConfig().ui.theme).toBe('light');
      const privateBytes = await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8');
      // An old reader can drop either snapshot, or this live child can miss Off and next
      // observe folder-only On. None of these observations grants stale shared preferences.
      const canonicalBytes = JSON.stringify(stripped);
      await fs.writeFile(path.join(root, 'config.json'), canonicalBytes, 'utf8');
      await expect(refreshSharedFolderAccess()).rejects.toThrow(/shared preference.*reload/i);
      await expect(updateConfig(config => ({ ...config, ui: { ...config.ui, finishTool: true } }))).rejects.toThrow(/shared preference.*reload/i);
      expect(getConfig().ui.theme).toBe('light');
      expect(getConfig().sharedAccountPreferences).toBeDefined();
      expect(await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8')).toBe(privateBytes);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(canonicalBytes);
      const reloaded = await loadConfig();
      expect(reloaded.ui.theme).toBe('dark');
      expect(reloaded.sharedAccountPreferences).toBeUndefined();
      expect(reloaded.instances!.sharedFolderAccess!.enabled).toBe(canonicalEnabled);
      await updateConfig(config => ({ ...config, ui: { ...config.ui, finishTool: true } }));
      expect((await loadConfig()).ui.finishTool).toBe(true);
    } finally { initConfigPath(dir); await loadConfig(); await removeTempDir(root); }
  });

  it('opt-in shares exact current folders with existing/future accounts without writing private preferences', async () => {
    const root = await makeTempDir('clf-shared-folders-');
    try {
      initConfigPath(root);
      await loadConfig();
      const first = await createLocalInstanceProfile('First', 'Profile 4');
      const privateRoot = await prepareIsolatedInstanceRuntimeConfig(first.id);
      initConfigPath(privateRoot, root);
      await loadConfig();
      await updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'light' },
        multiAgent: { ...config.multiAgent, defaultModel: 'gpt-5.5', defaultReasoning: 'high' },
        roots: [{ name: 'private-old', path: path.join(root, 'Private') }] }));
      const privateBytes = await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8');
      initConfigPath(root);
      await loadConfig();
      const roots = [{ name: 'shared', path: path.join(root, 'Shared') }];
      await updateConfig(config => ({ ...config, roots }));
      const enabled = await setSharedFolderAccess(true);
      expect(enabled.instances!.sharedFolderAccess).toMatchObject({ enabled: true, revision: 1, roots });
      const later = await createLocalInstanceProfile('Later', 'Profile 5');
      expect((await snapshotConfigForInstance(later.id)).roots).toEqual(roots);
      expect(await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8')).toBe(privateBytes);
      initConfigPath(privateRoot, root);
      const loaded = await loadConfig();
      expect(loaded.roots).toEqual(roots);
      expect(loaded.ui.theme).toBe('light');
      expect(loaded.multiAgent.defaultModel).toBe('gpt-5.5');
      expect((await readCanonicalInstanceConfig()).instances!.profiles.some(profile => profile.id === later.id)).toBe(true);
      await expect(setSharedFolderAccess(false)).rejects.toThrow(/primary/i);
      await expect(updateConfig(config => ({ ...config, roots: [] }))).rejects.toThrow(/primary/i);
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('refreshes shared revocations in live account memory and does not resurrect old roots when sharing stops', async () => {
    const root = await makeTempDir('clf-shared-revoke-');
    try {
      initConfigPath(root);
      await loadConfig();
      await updateConfig(config => ({ ...config, roots: [{ name: 'one', path: path.join(root, 'One') }] }));
      const peer = await createLocalInstanceProfile('Peer', 'Profile 4');
      const privateRoot = await prepareIsolatedInstanceRuntimeConfig(peer.id);
      await setSharedFolderAccess(true);
      const primaryBytes = await fs.readFile(path.join(root, 'config.json'), 'utf8');
      initConfigPath(privateRoot, root);
      await loadConfig();
      const before = await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8');
      const captured = [...getConfig().roots];
      // Simulate the sole primary publisher while this isolated process remains live.
      const revoked = JSON.parse(primaryBytes);
      revoked.roots = [];
      revoked.instances.sharedFolderAccess.roots = [];
      revoked.instances.sharedFolderAccess.revision += 1;
      await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(revoked), 'utf8');
      expect((await refreshSharedFolderAccess()).roots).toEqual([]);
      await expect(assertCurrentApprovedRoots(captured)).rejects.toThrow(/stale namespace/i);
      await expect(assertCurrentApprovedRoots([])).resolves.toBeUndefined();
      expect(await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8')).toBe(before);
      const off = await readCanonicalInstanceConfig();
      off.instances!.sharedFolderAccess!.enabled = false;
      off.instances!.sharedFolderAccess!.revision += 1;
      await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(off), 'utf8');
      expect((await refreshSharedFolderAccess()).roots).toEqual([]);
      await expect(assertCurrentApprovedRoots(captured)).rejects.toThrow(/stale namespace/i);
      // After the disabled revision is saved, this account may intentionally choose a private root.
      await updateConfig(config => ({ ...config, roots: [{ name: 'new-private', path: path.join(root, 'New') }] }));
      expect((await refreshSharedFolderAccess()).roots.map(item => item.name)).toEqual(['new-private']);
      expect((await loadConfig()).roots.map(item => item.name)).toEqual(['new-private']);
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('does not create a sharing grant when Off is selected on a legacy isolated installation', async () => {
    const root = await makeTempDir('clf-sharing-off-');
    try {
      initConfigPath(root);
      await loadConfig();
      expect((await setSharedFolderAccess(false)).instances!.sharedFolderAccess).toBeUndefined();
      await expect(assertCurrentApprovedRoots([{ name: 'manual-context', path: root }])).resolves.toBeUndefined();
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('reads Windows UTF-8 BOM settings without losing folders, identity or selected effort', async () => {
    const settings = defaultConfig();
    settings.roots = [{ name: 'project', path: dir }];
    settings.multiAgent.defaultReasoning = 'xhigh';
    await saveConfig(settings);
    const configFile = path.join(dir, 'config.json');
    const raw = await fs.readFile(configFile, 'utf8');
    const identity = JSON.parse(raw).instances;
    await fs.writeFile(configFile, '\uFEFF' + raw, 'utf8');
    const loaded = await loadConfig();
    expect(loaded.roots).toEqual(settings.roots);
    expect(loaded.multiAgent.defaultReasoning).toBe('xhigh');
    expect(loaded.instances).toEqual(identity);
  });
  it('clamps the legacy eight-worker ceiling to six without treating settings as malformed', async () => {
    const legacy = defaultConfig();
    legacy.multiAgent.maxWorkers = 8;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');

    const loaded = await loadConfig();
    expect(loaded.multiAgent.maxWorkers).toBe(6);
    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as { multiAgent?: { maxWorkers?: number } };
    expect(persisted.multiAgent?.maxWorkers).toBe(6);
  });

  it('defaults background chats on for fresh and omitted settings while preserving saved choices', async () => {
    expect(defaultConfig().ui.backgroundChats).toBe(true);
    expect((await loadConfig()).ui.backgroundChats).toBe(true);
    const legacy = defaultConfig(); delete legacy.ui.backgroundChats;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).ui.backgroundChats).toBe(true);
    for (const backgroundChats of [false, true]) {
      await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, backgroundChats } });
      expect((await loadConfig()).ui.backgroundChats).toBe(backgroundChats);
    }
  });
  it('defaults login startup off for fresh and legacy settings independently of auto-connect', async () => {
    expect(defaultConfig().ui.startAtLogin).toBe(false);
    const legacy = defaultConfig();
    delete legacy.ui.startAtLogin;
    legacy.ui.autoConnect = true;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).ui).toMatchObject({ startAtLogin: false, autoConnect: true });
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, startAtLogin: true, autoConnect: false } });
    expect((await loadConfig()).ui).toMatchObject({ startAtLogin: true, autoConnect: false });
  });
  it('defaults automatic plugin refresh off for fresh and legacy settings while preserving explicit opt-in', async () => {
    expect(defaultConfig().ui.autoRefreshPlugins).toBe(false);
    const legacy = defaultConfig(); delete legacy.ui.autoRefreshPlugins;
    await saveConfig(legacy);
    expect((await loadConfig()).ui.autoRefreshPlugins).toBe(false);
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoRefreshPlugins: true } });
    expect((await loadConfig()).ui.autoRefreshPlugins).toBe(true);
  });
  it('keeps sign-out emergency alerts opt-in and preserves one validated durable incident receipt', async () => {
    expect(defaultConfig('win32').ui.signOutEmergencyAlerts).toBe(false);
    const legacy = defaultConfig('win32'); delete legacy.ui.signOutEmergencyAlerts;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).ui.signOutEmergencyAlerts).toBe(false);

    const incident = {
      id: '0f29df9e-8a2b-44df-a820-2208a861c9e8',
      profileId: 'local-instance',
      observedAt: 1_796_000_000_000,
      receipt: 'R'.repeat(30)
    };
    await saveConfig({
      ...defaultConfig('win32'),
      ui: { ...defaultConfig('win32').ui, signOutEmergencyAlerts: true },
      noticeState: { signOutEmergency: incident }
    });
    expect(await loadConfig()).toMatchObject({
      ui: { signOutEmergencyAlerts: true },
      noticeState: { signOutEmergency: incident }
    });
  });
  it('defaults Goal and Loop to ChatGPT while preserving explicit backend choices', async () => {
    expect(defaultConfig().goal).toMatchObject({ backend: 'chatgpt', loopBackend: 'chatgpt' });
    for (const backend of ['api', 'templates', 'chatgpt'] as const) {
      await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend, loopBackend: 'api' } });
      expect((await loadConfig()).goal).toMatchObject({ backend, loopBackend: 'api' });
    }
  });
  it('requires an explicit settled-turn policy and repairs missing or invalid policy without losing settings', async () => {
    expect(defaultConfig().goal).toHaveProperty('continuationPolicy', 'strict');
    for (const policy of [undefined, 'guess-complete', 'settled-turn', 'strict']) {
      const candidate = { ...defaultConfig(), goal: { ...defaultConfig().goal, continuationPolicy: policy },
        ui: { ...defaultConfig().ui, automationPaused: true } };
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(candidate), 'utf8');
      const loaded = await loadConfig();
      expect(loaded.goal).toHaveProperty('continuationPolicy', policy === 'settled-turn' ? 'settled-turn' : 'strict');
      expect(loaded.ui.automationPaused).toBe(true);
      expect(loaded.roots).toEqual(candidate.roots);
      await saveConfig(loaded);
      expect((await loadConfig()).goal).toHaveProperty('continuationPolicy', policy === 'settled-turn' ? 'settled-turn' : 'strict');
    }
  });
  it('never leaves Goal enabled while session recording is off', async () => {
    const impossible = {
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: false },
      goal: { ...defaultConfig().goal, enabled: true }
    };

    // Every writer goes through saveConfig/updateConfig, including the renderer and extension.
    const saved = await saveConfig(impossible);
    expect(saved.sessions.record).toBe(false);
    expect(saved.goal.enabled).toBe(false);

    // Hand-edited or older persisted state gets the same privacy-preserving repair on load:
    // Goal turns off rather than silently turning recording back on.
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(impossible), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.sessions.record).toBe(false);
    expect(loaded.goal.enabled).toBe(false);
  });

  it('preserves old settings when new safe-default capabilities and UI prefs are added', async () => {
    const oldConfig = {
      roots: [{ name: 'project', path: fixturePath('project') }],
      capabilities: {
        browse: true,
        search: true,
        read: true,
        metadata: true,
        create: true,
        edit: true,
        move: false,
        deleteFile: false,
        powershell: true,
        command: true,
        screen: true,
        control: true
      },
      readOnly: false,
      tunnel: {
        kind: 'openai',
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        binaryPath: ''
      },
      ui: { minimizeToTray: true, autoConnect: true }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(oldConfig), 'utf8');

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual(oldConfig.roots);
    expect(loaded.capabilities.create).toBe(true);
    expect(loaded.capabilities.clipboardRead).toBe(false);
    expect(loaded.capabilities.clipboardWrite).toBe(false);
    expect(loaded.capabilities.saveArtifact).toBe(false);
    expect(loaded.artifacts.maxFileBytes).toBe(defaultConfig().artifacts.maxFileBytes);
    // A config written before custom providers existed keeps OpenRouter with no URL:
    // an upgrade never moves a running Goal loop onto an endpoint nobody chose.
    expect(loaded.goal.provider).toEqual({ kind: 'openrouter', baseUrl: '' });
    expect(loaded.ui.autoConnect).toBe(true);
    expect(loaded.ui.privacyScreenshots).toBe(false);
    // The one tunnel id a pre-split config had is Core's, because Core is the connector
    // the app cannot work without. Desktop is a second, optional tunnel that starts empty
    // rather than inheriting Core's id — publishing Core twice would be worse than not
    // publishing Desktop at all.
    expect(loaded.tunnel.tunnelId).toBe(oldConfig.tunnel.tunnelId);
    expect(loaded.tunnel.desktopTunnelId).toBe('');
  });

  it('folds a PowerShell-only permission into the single command permission', async () => {
    // `powershell` and `command` were one tool each and are now the single exec_command.
    // A user who had granted only PowerShell keeps the ability they chose; the dead key
    // does not survive into the saved config.
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...defaultConfig(),
        capabilities: {
          ...defaultConfig().capabilities,
          command: false,
          deleteFile: false,
          powershell: true,
          deleteFolder: true
        }
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.capabilities.command).toBe(true);
    expect(Object.keys(loaded.capabilities)).not.toContain('powershell');
    // `deleteFolder` is dropped rather than folded into deleteFile: they were never the
    // same permission, and turning one into the other would widen what the user approved.
    expect(Object.keys(loaded.capabilities)).not.toContain('deleteFolder');
    expect(loaded.capabilities.deleteFile).toBe(false);
  });

  it('renames a saved root that claims a reserved virtual namespace', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...defaultConfig(), roots: [{ name: 'skills', path: fixturePath('skills') }] }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.roots[0]?.name).toBe('skills-folder');
    expect(loaded.roots[0]?.path).toBe(fixturePath('skills'));
  });

  it('keeps reserved-name migration from creating duplicate virtual roots', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...defaultConfig(),
        roots: [
          { name: 'skills-folder', path: fixturePath('already-there') },
          { name: 'skills', path: fixturePath('legacy-skills') },
          { name: 'skills-folder', path: fixturePath('duplicate') }
        ]
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.roots.map((root) => root.name)).toEqual(['skills-folder', 'skills-folder-2', 'skills-folder-3']);
    expect(new Set(loaded.roots.map((root) => root.name)).size).toBe(loaded.roots.length);
  });

  it('round-trips a second tunnel id for the Desktop connector', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      tunnel: {
        ...config.tunnel,
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        desktopTunnelId: 'tunnel_fedcba9876543210fedcba9876543210'
      }
    });
    const loaded = await loadConfig();
    expect(loaded.tunnel.tunnelId).toBe('tunnel_0123456789abcdef0123456789abcdef');
    expect(loaded.tunnel.desktopTunnelId).toBe('tunnel_fedcba9876543210fedcba9876543210');
  });

  /**
   * Automatic compaction ends the chat the user is working in and opens a fresh one, and it
   * used to start off on the grounds that this is not something to do to somebody who never
   * asked for it. In use that reasoning turned out to be backwards: the alternative to
   * compacting is hitting the ceiling mid-thought and losing the thread entirely, which is
   * the worse thing to have happen to somebody who never asked for it. Since 1.8 the trigger
   * is edge-based rather than "currently above the line", so the advisory line is safe as
   * the default and still leaves room to finish the crossing turn and write the handoff.
   */
  it('starts with automatic compaction on at the advisory line', async () => {
    await saveConfig(defaultConfig());
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(loaded.sessions.advisoryTokens);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  /**
   * The Chat panel offers one number and derives the red line from it, `limit = threshold ×
   * 4/3`. A shipped default that does not already satisfy that relation is a state the UI
   * cannot produce, and it would not survive contact with it: the first save of anything at
   * all in that panel would silently move the red line. So the defaults have to agree with
   * the arithmetic the panel does, which is what this pins.
   */
  it('ships a red line the settings panel would have derived itself', async () => {
    const config = defaultConfig();
    expect(config.sessions.advisoryTokens).toBe(config.compaction.autoTokens);
    expect(config.sessions.limitTokens).toBe(Math.round((config.compaction.autoTokens * 4) / 3));
  });

  /**
   * The migration, and the line it must not cross. A config still carrying both old
   * defaults never had a decision made about it, so it moves to the new one. A config
   * carrying anything else is somebody's own setting and is left exactly as it is.
   */
  it('moves an untouched old default onto the new one', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 300_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  /**
   * The window moved to 400k, and the number that has to follow it is the one the app wrote
   * for itself. Since 1.8 that is `auto: true` at 300k — the shipped default, in every config
   * written by every install that never opened the panel. Raising the default alone would
   * reach a fresh install and nothing else, which is the whole reason this file has
   * migrations at all.
   */
  it('moves the untouched 1.8 automatic default up to the wider window', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 300_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 400_000 });
  });

  /** And nothing moves back down: 400k is the default now, however a config came to hold it. */
  it('leaves a config already at the wider window alone', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 400_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 400_000 });
  });

  /**
   * The meter's own pair, migrated on the same rule. 300k/400k is what 1.8 wrote for itself,
   * so it follows the window; anything else in either slot was typed and stays.
   */
  it('recalibrates an untouched meter pair and leaves a chosen one', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, advisoryTokens: 300_000, limitTokens: 400_000 } });
    const moved = await loadConfig();
    expect(moved.sessions.advisoryTokens).toBe(400_000);
    expect(moved.sessions.limitTokens).toBe(Math.round((400_000 * 4) / 3));

    await saveConfig({ ...config, sessions: { ...config.sessions, advisoryTokens: 300_000, limitTokens: 350_000 } });
    const kept = await loadConfig();
    expect(kept.sessions).toMatchObject({ advisoryTokens: 300_000, limitTokens: 350_000 });
  });

  it('leaves a user who turned automatic compaction off turned off', async () => {
    const config = defaultConfig();
    // Off, but at a threshold they chose: that is a decision, not an untouched default.
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 250_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(false);
    expect(loaded.compaction.autoTokens).toBe(250_000);
  });

  it('keeps an automatic compaction the user configured', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      compaction: { ...config.compaction, auto: true, autoTokens: 150_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 150_000 });
  });

  it('keeps the meter threshold aligned with a high automatic-compaction threshold', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      sessions: { ...config.sessions, advisoryTokens: 3_000_000, limitTokens: 4_000_000 },
      compaction: { ...config.compaction, auto: true, autoTokens: 3_000_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.compaction.autoTokens).toBe(3_000_000);
    expect(loaded.sessions.advisoryTokens).toBe(3_000_000);
    expect(loaded.sessions.limitTokens).toBe(4_000_000);
  });

  /**
   * A config written before these fields existed gets the current defaults, like any other
   * absent field: absent is not a decision, so it reads as whatever the app decides now.
   */
  it('reads a config from before the setting existed as the current default', async () => {
    const config = defaultConfig();
    const older = { ...config, compaction: { ...config.compaction } } as Record<string, any>;
    delete older.compaction.auto;
    delete older.compaction.autoTokens;
    await saveConfig(older as ReturnType<typeof defaultConfig>);
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  it('serializes concurrent read-modify-write changes instead of losing one', async () => {
    await saveConfig(defaultConfig());
    const first = updateConfig(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...config, roots: [{ name: 'project', path: fixturePath('project') }] };
    });
    const second = updateConfig((config) => ({
      ...config,
      ui: { ...config.ui, theme: 'dark' as const }
    }));
    await Promise.all([first, second]);

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual([{ name: 'project', path: fixturePath('project') }]);
    expect(loaded.ui.theme).toBe('dark');
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries a transient atomic settings publish blocked with %s', async (code) => {
    const target = path.join(dir, 'config.json');
    const realRename = fs.rename.bind(fs);
    let targetAttempts = 0;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === target) {
        targetAttempts += 1;
        if (targetAttempts === 1) throw Object.assign(new Error('injected transient settings lock'), { code });
      }
      return realRename(from, to);
    });

    try {
      const config = defaultConfig();
      await saveConfig({ ...config, ui: { ...config.ui, theme: 'dark' } });
      expect(targetAttempts).toBe(2);
      expect(JSON.parse(await fs.readFile(target, 'utf8')).ui.theme).toBe('dark');
    } finally {
      rename.mockRestore();
    }
  });

  it('does not retry a non-sharing settings failure or publish it in memory', async () => {
    const target = path.join(dir, 'config.json');
    const baseline = defaultConfig();
    baseline.ui.theme = 'light';
    await saveConfig(baseline);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (_from, to) => {
      if (String(to) === target) throw Object.assign(new Error('injected full disk'), { code: 'ENOSPC' });
    });

    try {
      await expect(saveConfig({ ...baseline, ui: { ...baseline.ui, theme: 'dark' } })).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(rename).toHaveBeenCalledTimes(1);
      expect((await loadConfig()).ui.theme).toBe('light');
    } finally {
      rename.mockRestore();
    }
  });
});

/** Fresh-install defaults, while migrations above prove existing choices stay narrow. */
describe('shipped defaults', () => {
  // Windows alone starts the Desktop group on. macOS has the backend but starts it off; the
  // user switches it on and grants Screen Recording / Accessibility. Linux has no backend.
  const expectedFreshCapability = (capability: Capability, platform: NodeJS.Platform): boolean =>
    platform === 'win32' || !DESKTOP_CAPABILITIES.includes(capability);

  it('records sessions from first launch', () => {
    expect(defaultConfig().sessions.record).toBe(true);
  });

  it('loads a genuinely missing config with every portable Core capability enabled', async () => {
    await fs.rm(path.join(dir, 'config.json'), { force: true });
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(false);
    for (const [capability, enabled] of Object.entries(loaded.capabilities) as Array<[Capability, boolean]>) {
      expect(enabled, capability).toBe(expectedFreshCapability(capability, process.platform));
    }
    expect(loaded.multiAgent.enabled).toBe(true);
    expect(loaded.multiAgent.allowUnattributedCalls).toBe(true);
    expect(loaded.multiAgent.recoverAgentTabs).toBe(false);
  });

  it.each(['win32', 'darwin', 'linux'] as const)(
    'starts portable permissions on and Desktop automation on Windows only on %s',
    (platform) => {
      const config = defaultConfig(platform);
      expect(config.readOnly).toBe(false);
      for (const [capability, enabled] of Object.entries(config.capabilities) as Array<[Capability, boolean]>) {
        expect(enabled, `${platform}:${capability}`).toBe(expectedFreshCapability(capability, platform));
      }
      expect(config.multiAgent.enabled).toBe(true);
      expect(config.multiAgent.maxWorkers).toBe(6);
      expect(config.multiAgent.limitAutomaticChats).toBe(false);
      expect(config.multiAgent.allowUnattributedCalls).toBe(true);
      expect(config.multiAgent.recoverAgentTabs).toBe(false);
    }
  );

  it('does not widen omitted permissions or agents exposure in an existing legacy config', async () => {
    const legacy = {
      roots: [],
      capabilities: { browse: true, search: true, read: true, metadata: true },
      readOnly: true,
      tunnel: { kind: 'openai', tunnelId: '', binaryPath: '' },
      ui: { minimizeToTray: true, autoConnect: false }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.capabilities.command).toBe(false);
    expect(loaded.capabilities.control).toBe(false);
    expect(loaded.multiAgent.enabled).toBe(false);
    expect(loaded.multiAgent.limitAutomaticChats).toBe(false);
    expect(loaded.multiAgent.allowUnattributedCalls).toBe(false);
    expect(loaded.multiAgent.recoverAgentTabs).toBe(false);
    expect(loaded.readOnly).toBe(true);
  });

  it('does not turn config corruption into permission consent', async () => {
    const damaged = '{ definitely-not-json';
    await fs.writeFile(path.join(dir, 'config.json'), damaged, 'utf8');
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(true);
    expect(loaded.capabilities.command).toBe(false);
    expect(loaded.capabilities.control).toBe(false);
    expect(loaded.multiAgent.enabled).toBe(false);
    expect(await fs.readFile(path.join(dir, 'config.pre-instance-profile-recovery.json'), 'utf8')).toBe(damaged);
    expect((await fs.readFile(path.join(dir, 'config.json'), 'utf8'))).not.toBe(damaged);
  });

  /**
   * The default moved after this app had already shipped with recording off. Turning it on
   * underneath somebody who switched it off would be changing a privacy setting on their
   * behalf, so the new default is for configs that do not have the key at all.
   */
  it('leaves an existing choice to record alone', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: false } });
    expect((await loadConfig()).sessions.record).toBe(false);
  });

  it('applies the new default to a config written before the setting existed', async () => {
    const before = defaultConfig() as unknown as Record<string, unknown>;
    const { sessions: _dropped, ...withoutSessions } = before;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(withoutSessions), 'utf8');
    expect((await loadConfig()).sessions.record).toBe(true);
  });

  /**
   * Save, close, reopen. The unattributed switch is on out of the box, so the only way to
   * see it off is to have turned it off — and that choice has to survive the next launch
   * rather than being handed back the fresh-install default on load.
   */
  it('keeps either unattributed choice across a save and reload', async () => {
    const config = defaultConfig();
    expect(config.multiAgent.allowUnattributedCalls).toBe(true);

    await saveConfig({
      ...config,
      multiAgent: { ...config.multiAgent, allowUnattributedCalls: false }
    });
    expect((await loadConfig()).multiAgent.allowUnattributedCalls).toBe(false);

    await saveConfig({
      ...config,
      multiAgent: { ...config.multiAgent, allowUnattributedCalls: true }
    });
    expect((await loadConfig()).multiAgent.allowUnattributedCalls).toBe(true);
  });
});

// Adapted from upstream Maxim's b6b9f162: one future UI choice must not discard
// the account's folders, connection, permissions, automation hold or model choices.
describe('unknown UI preference recovery', () => {
  it.each([false, true])('keeps account settings for an unknown UI choice (profile era %s)', async profileEra => {
    const root = await makeTempDir('clf-unknown-ui-choice-');
    try {
      initConfigPath(root);
      const initial = await loadConfig();
      await saveConfig({ ...initial,
        roots: [{ name: 'work', path: root }],
        readOnly: true,
        tunnel: { ...initial.tunnel, tunnelId: 'test-owned-tunnel' },
        ui: { ...initial.ui, automationPaused: true, automationProfile: 'overnight', privacyScreenshots: false,
          autoConnect: false, theme: 'light', chatBrowser: 'chrome' },
        sessions: { ...initial.sessions, retainDays: 9 },
        multiAgent: { ...initial.multiAgent, enabled: false, allowUnattributedCalls: false,
          defaultModel: 'gpt-6-thinking', defaultReasoning: 'xhigh' },
        goal: { ...initial.goal, helperModel: 'gpt-6-thinking', helperReasoning: 'xhigh' }
      });
      const expected = structuredClone(getConfig());
      const raw = JSON.stringify({ ...expected, ui: { ...expected.ui, chatBrowser: 'future-browser',
        theme: profileEra ? 'light' : 'future-theme' } });
      await fs.writeFile(path.join(root, 'config.json'), raw, 'utf8');
      if (profileEra) {
        const { DEVICE_IDENTITY_FILE } = await import('../src/main/device-identity.js');
        await fs.writeFile(path.join(root, DEVICE_IDENTITY_FILE), '{}', 'utf8');
      }
      const loaded = await loadConfig();
      expect(loaded).toEqual({ ...expected, ui: { ...expected.ui, chatBrowser: 'chrome', theme: profileEra ? 'light' : 'dark' } });
      expect(await fs.readFile(path.join(root, 'config.pre-instance-profile-recovery.json'), 'utf8')).toBe(raw);
      expect(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'))).toEqual(loaded);
      expect(await loadConfig()).toEqual(loaded);
    } finally { initConfigPath(dir); await loadConfig(); await removeTempDir(root); }
  });

  it.each(['roots', 'automationPaused', 'automationProfile', 'privacyScreenshots'])('does not salvage an invalid %s with an unknown UI choice', async field => {
    const root = await makeTempDir('clf-unknown-ui-invalid-');
    try {
      initConfigPath(root);
      const initial = await loadConfig();
      const { DEVICE_IDENTITY_FILE } = await import('../src/main/device-identity.js');
      await fs.writeFile(path.join(root, DEVICE_IDENTITY_FILE), '{}', 'utf8');
      const invalid = { ...initial, ui: { ...initial.ui, chatBrowser: 'future-browser' } } as Record<string, unknown>;
      if (field === 'roots') invalid.roots = 'not an approved folder list';
      else (invalid.ui as Record<string, unknown>)[field] = 'unknown';
      const raw = JSON.stringify(invalid);
      await fs.writeFile(path.join(root, 'config.json'), raw, 'utf8');
      await expect(loadConfig()).rejects.toThrow(/Profile-era settings are malformed/);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(raw);
      await expect(fs.access(path.join(root, 'config.pre-instance-profile-recovery.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { initConfigPath(dir); await loadConfig(); await removeTempDir(root); }
  });

  it('preserves a different recovery copy and refuses to overwrite either original', async () => {
    const root = await makeTempDir('clf-unknown-ui-conflict-');
    try {
      initConfigPath(root);
      const initial = await loadConfig();
      const previous = 'previous exact unreadable settings';
      const recovery = path.join(root, 'config.pre-instance-profile-recovery.json');
      await fs.writeFile(recovery, previous, 'utf8');
      const raw = JSON.stringify({ ...initial, ui: { ...initial.ui, chatBrowser: 'future-browser' } });
      await fs.writeFile(path.join(root, 'config.json'), raw, 'utf8');
      await expect(loadConfig()).rejects.toThrow(/different unreadable legacy settings file is already preserved/);
      expect(await fs.readFile(recovery, 'utf8')).toBe(previous);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(raw);
      expect(getConfig()).toEqual(initial);
    } finally { initConfigPath(dir); await loadConfig(); await removeTempDir(root); }
  });
});

/**
 * The goal loop's settings.
 *
 * This is the one feature in this app that types into somebody's chat without being asked
 * each time, so what it defaults to — and what a damaged config falls back to — is a
 * consent question rather than a convenience one.
 */
describe('the goal loop settings', () => {
  it('keeps helper settings independent from the API and preserves a chosen idle tab budget', async () => {
    const config = defaultConfig();
    expect(config.goal).toMatchObject({ helperModel: 'gpt-6-thinking', helperReasoning: 'high', model: DEFAULT_GOAL_MODEL });
    expect(config.multiAgent).toMatchObject({ defaultModel: 'gpt-6-thinking', defaultReasoning: 'high' });
    await saveConfig({ ...config, ui: { ...config.ui, tabsToKeepOpen: 7 }, goal: {
      ...config.goal, model: 'provider/api-model', reasoning: 'low', helperModel: 'account-browser-model', helperReasoning: 'medium'
    } });
    const loaded = await loadConfig();
    expect(loaded.goal).toMatchObject({ model: 'provider/api-model', reasoning: 'low', helperModel: 'account-browser-model', helperReasoning: 'medium' });
    expect(loaded.ui.tabsToKeepOpen).toBe(7);
  });
  it('is off out of the box', () => {
    const config = defaultConfig();
    expect(config.goal.enabled).toBe(false);
    expect(config.goal.model).toBe('z-ai/glm-5.3');
    expect(config.goal.reasoning).toBe('default');
    expect(config.goal.prompt).toContain('Your job is to prompt ChatGPT');
    expect(config.goal.prompt).toContain('No separate objective is supplied');
    // The driver ships beside the gate rather than staying hardcoded, so a fresh install has
    // both editable instructions on disk and the settings screen has something to paint.
    expect(config.goal.objectivePrompt).toContain('Your job is to prompt ChatGPT');
    expect(config.goal.objectivePrompt).toContain('Read it together with the original task');
  });

  it('keeps the model, reasoning level and system prompt that were chosen', async () => {
    const prompt = 'Custom continuation gate. Reply NO_REPLY when finished.';
    const objectivePrompt = 'Custom goal driver. Reply NO_REPLY once the goal is reached.';
    const loopPrompt = 'Custom loop. Always write the next message.';
    await saveConfig({
      ...defaultConfig(),
      goal: {
        ...defaultConfig().goal,
        enabled: true,
        mode: 'loop',
        model: 'openai/gpt-5.2-mini:nitro',
        reasoning: 'high',
        prompt,
        objectivePrompt,
        loopPrompt
      }
    });
    expect((await loadConfig()).goal).toEqual({
      backend: 'chatgpt',
      loopBackend: 'chatgpt',
      continuationPolicy: 'strict',
      includeToolCalls: false,
      impulseMinutes: 0,
      helperModel: 'gpt-6-thinking',
      helperReasoning: 'high',
      enabled: true,
      mode: 'loop',
      provider: { kind: 'openrouter', baseUrl: '' },
      model: 'openai/gpt-5.2-mini:nitro',
      reasoning: 'high',
      prompt,
      objectivePrompt,
      loopPrompt
    });
  });

  it('upgrades only the exact previous shipped prompt and preserves customized prompts', async () => {
    const { PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT } = await import('../src/shared/goal.js');
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT } }),
      'utf8'
    );
    expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);

    const customized = `${PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT}\ncustom sentence`;
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: customized } }),
      'utf8'
    );
    expect((await loadConfig()).goal.prompt).toBe(customized);
  });

  /**
   * Migration compares against every default ever shipped, not just the one before this.
   *
   * The single-predecessor check this replaced stranded anyone who had skipped a release:
   * their untouched prompt matched neither the current default nor its immediate predecessor,
   * so it was mistaken for a customization and kept forever.
   */
  it('upgrades an untouched default from any earlier version, not just the last one', async () => {
    const { SUPERSEDED_GOAL_SYSTEM_PROMPTS } = await import('../src/shared/goal.js');
    const config = defaultConfig();
    for (const superseded of SUPERSEDED_GOAL_SYSTEM_PROMPTS) {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ ...config, goal: { ...config.goal, prompt: superseded } }),
        'utf8'
      );
      expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);
    }
  });

  /**
   * The driver and the loop are persisted and editable exactly as the gate is.
   *
   * They were migrated by nothing at all until the requirements rewrite, so an install holding
   * either one verbatim would have kept a superseded instruction forever while the shipped
   * constant moved on — the same stranding the gate's list exists to prevent.
   */
  it('upgrades an untouched driver and loop prompt too, not only the gate', async () => {
    const { SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS, SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS } =
      await import('../src/shared/goal.js');
    const config = defaultConfig();

    for (const superseded of SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS) {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ ...config, goal: { ...config.goal, objectivePrompt: superseded } }),
        'utf8'
      );
      expect((await loadConfig()).goal.objectivePrompt).toBe(defaultConfig().goal.objectivePrompt);
    }

    for (const superseded of SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS) {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ ...config, goal: { ...config.goal, loopPrompt: superseded } }),
        'utf8'
      );
      expect((await loadConfig()).goal.loopPrompt).toBe(defaultConfig().goal.loopPrompt);
    }
  });

  it('keeps a customized driver or loop prompt that merely starts like a shipped one', async () => {
    const { SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS, SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS } =
      await import('../src/shared/goal.js');
    const config = defaultConfig();
    const objectivePrompt = `${SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS[0]}\ncustom sentence`;
    const loopPrompt = `${SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS[0]}\ncustom sentence`;
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, objectivePrompt, loopPrompt } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.objectivePrompt).toBe(objectivePrompt);
    expect(loaded.goal.loopPrompt).toBe(loopPrompt);
  });

  it('repairs a blank goal driver prompt to its shipped default', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, objectivePrompt: '   ' } }),
      'utf8'
    );
    expect((await loadConfig()).goal.objectivePrompt).toBe(defaultConfig().goal.objectivePrompt);
  });

  /**
   * The id is free text from a provider listing that changes weekly. A config that lost it
   * still has every root and permission in it, and losing those to a blank string would be
   * a far worse failure than starting the picker back at its default.
   */
  it('repairs a blank model id rather than refusing the whole config', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { enabled: true, model: '   ', reasoning: 'low' } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.model).toBe(DEFAULT_GOAL_MODEL);
    expect(loaded.goal.prompt).toBe(defaultConfig().goal.prompt);
    expect(loaded.goal.enabled).toBe(true);
    expect(loaded.roots).toEqual(config.roots);
  });

  it('defaults Goal tool context off for old configs and preserves an explicit opt-in', async () => {
    const config = defaultConfig();
    expect(config.goal.includeToolCalls).toBe(false);
    const { includeToolCalls: omitted, ...oldGoal } = config.goal;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...config, goal: oldGoal }), 'utf8');
    expect((await loadConfig()).goal.includeToolCalls).toBe(false);
    await saveConfig({ ...config, goal: { ...config.goal, includeToolCalls: true } });
    expect((await loadConfig()).goal.includeToolCalls).toBe(true);
  });

  it('adds the section to a config written before the loop existed', async () => {
    const before = defaultConfig() as unknown as Record<string, unknown>;
    const { goal: _dropped, ...withoutGoal } = before;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(withoutGoal), 'utf8');
    expect((await loadConfig()).goal).toEqual({
      backend: 'chatgpt',
      loopBackend: 'chatgpt',
      continuationPolicy: 'strict',
      includeToolCalls: false,
      impulseMinutes: 0,
      helperModel: 'gpt-6-thinking',
      helperReasoning: 'high',
      enabled: false,
      mode: 'goal',
      provider: { kind: 'openrouter', baseUrl: '' },
      model: DEFAULT_GOAL_MODEL,
      reasoning: 'default',
      prompt: defaultConfig().goal.prompt,
      objectivePrompt: defaultConfig().goal.objectivePrompt,
      loopPrompt: defaultConfig().goal.loopPrompt
    });
  });

  /**
   * Loop is the mode that cannot stop on its own, so a blank instruction here would be an
   * unconstrained model typing into somebody's chat for ever. Repaired like the other two.
   */
  it('repairs a blank loop prompt rather than running the loop with no instruction', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopPrompt: '   ' } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.loopPrompt).toBe(defaultConfig().goal.loopPrompt);
    expect(loaded.goal.mode).toBe('loop');
  });

  /**
   * The mode is one word out of a file holding every root and permission this app has. A
   * version that knows a third mode must not cost the rest of it a trip through recovery.
   */
  it('repairs an unknown mode without discarding the config around it', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...config,
        roots: [{ name: 'project', path: fixturePath('project') }],
        goal: { ...config.goal, enabled: true, mode: 'swarm' }
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.mode).toBe('goal');
    expect(loaded.goal.enabled).toBe(true);
    expect(loaded.roots).toEqual([{ name: 'project', path: fixturePath('project') }]);
  });

  it('repairs a blank prompt to the safe continuation-gate default', async () => {
    const config = defaultConfig();
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...config, goal: { ...config.goal, prompt: '   ' } }), 'utf8');
    expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);
  });

  it('repairs an invalid prompt without discarding unrelated settings', async () => {
    const config = {
      ...defaultConfig(),
      roots: [{ name: 'project', path: fixturePath('project') }]
    };
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: 'x'.repeat(20_001) } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.prompt).toBe(defaultConfig().goal.prompt);
    expect(loaded.roots).toEqual(config.roots);
  });

  /** Corruption is not consent here either: a broken file must not switch the loop on. */
  it('leaves the loop off when the config cannot be read', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), '{ definitely-not-json', 'utf8');
    expect((await loadConfig()).goal.enabled).toBe(false);
  });

  it('persists one lossless legacy instance migration and repeats without identity drift', async () => {
    const root = { name: 'project', path: path.join(dir, 'project') };
    const legacy = { ...defaultConfig(), roots: [root] };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy, null, 2), 'utf8');
    initConfigPath(dir);

    const first = await loadConfig();
    expect(first.roots).toEqual([root]);
    expect(first.instances).toMatchObject({
      schemaVersion: 1,
      activeInstanceId: 'local-instance',
      profiles: [{
        id: 'local-instance',
        platform: hostPlatform,
        state: { mode: 'legacy', root: dir },
        bridge: { host: '127.0.0.1', port: 8765 },
        browser: { profileId: 'default', electronPartition: 'default' }
      }]
    });
    const firstBytes = await fs.readFile(path.join(dir, 'config.json'), 'utf8');

    initConfigPath(dir);
    const repeated = await loadConfig();
    const repeatedBytes = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
    expect(repeated.instances).toEqual(first.instances);
    expect(repeatedBytes).toBe(firstBytes);
  });

  it('lets the isolated dev bootstrap retarget only its legacy bridge through the normal config owner', async () => {
    expect(developmentBrowserBridgeInstanceId()).toBeNull();
    initConfigPath(dir, dir, 8796);
    const devIdentity = developmentBrowserBridgeInstanceId();
    expect(devIdentity).toMatch(/^dev-[0-9a-f]{24}$/);
    expect(devIdentity).not.toBe('local-instance');
    const first = await loadConfig();
    expect(first.instances).toMatchObject({
      activeInstanceId: 'local-instance',
      profiles: [{ id: 'local-instance', state: { mode: 'legacy' }, bridge: { host: '127.0.0.1', port: 8796 } }]
    });

    // A later dev launch may find that first port occupied by another local account. The same
    // config owner updates the disposable development route; no launcher edits config.json.
    initConfigPath(dir, dir, 8795);
    expect(developmentBrowserBridgeInstanceId()).toBe(devIdentity);
    const moved = await loadConfig();
    expect(moved.instances?.profiles.find(profile => profile.id === 'local-instance')?.bridge.port).toBe(8795);
    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as any;
    expect(persisted.instances.profiles.find((profile: any) => profile.id === 'local-instance').bridge.port).toBe(8795);

    // A second private dev root must never be mistaken for the first even if both run
    // the same source/profile template on different machines or on separate ports.
    initConfigPath(path.join(dir, 'other-independent-dev-root'), dir, 8795);
    expect(developmentBrowserBridgeInstanceId()).toMatch(/^dev-[0-9a-f]{24}$/);
    expect(developmentBrowserBridgeInstanceId()).not.toBe(devIdentity);

    // Ordinary product/config callers retain the persisted route instead of implicitly applying
    // a development override.
    initConfigPath(dir);
    expect(developmentBrowserBridgeInstanceId()).toBeNull();
    expect((await loadConfig()).instances?.profiles.find(profile => profile.id === 'local-instance')?.bridge.port).toBe(8795);
  });

  it('fails closed on copied device ownership and unsupported profile versions without rewriting config', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(defaultConfig()), 'utf8');
    initConfigPath(dir);
    const migrated = await loadConfig();

    const copied = structuredClone(migrated);
    copied.instances!.profiles[0]!.deviceId = '99999999-9999-4999-8999-999999999999';
    const copiedBytes = JSON.stringify(copied, null, 2);
    await fs.writeFile(path.join(dir, 'config.json'), copiedBytes, 'utf8');
    initConfigPath(dir);
    await expect(loadConfig()).rejects.toMatchObject({ code: 'wrong_device' });
    expect(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).toBe(copiedBytes);

    const future = structuredClone(migrated) as any;
    future.instances.schemaVersion = 2;
    const futureBytes = JSON.stringify(future, null, 2);
    await fs.writeFile(path.join(dir, 'config.json'), futureBytes, 'utf8');
    initConfigPath(dir);
    await expect(loadConfig()).rejects.toMatchObject({ code: 'unsupported_profile_version' });
    expect(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).toBe(futureBytes);
  });

  it('rejects a stale private runtime tunnel collision even when the primary setup catalog differs', async () => {
    await saveConfig(defaultConfig());
    const root = await makeTempDir('clf-private-tunnel-collision-');
    try {
      initConfigPath(root); await loadConfig();
      const peer = await createLocalInstanceProfile('Peer', 'Profile 2');
      const runtimeRoot = await prepareIsolatedInstanceRuntimeConfig(peer.id);
      const file = path.join(runtimeRoot, 'config.json');
      const privateConfig = JSON.parse(await fs.readFile(file, 'utf8'));
      const duplicated = 'tunnel_0123456789abcdef0123456789abcdef';
      privateConfig.tunnel.tunnelId = duplicated;
      await fs.writeFile(file, JSON.stringify(privateConfig));
      const proposed = { ...getConfig().tunnel, kind: 'openai' as const, tunnelId: duplicated };
      await expect(assertActiveSecureTunnelIsolation(proposed)).rejects.toMatchObject({ code: 'tunnel_collision' });
      await expect(assertActiveSecureTunnelIsolation({ ...proposed, kind: 'manual' })).resolves.toBeUndefined();
      await expect(assertActiveSecureTunnelIsolation({ ...proposed,
        tunnelId: 'tunnel_fedcba9876543210fedcba9876543210' })).resolves.toBeUndefined();
      await expect(assertActiveSecureTunnelIsolation({ ...proposed,
        tunnelId: '', desktopTunnelId: duplicated })).rejects.toMatchObject({ code: 'tunnel_collision' });
      await fs.writeFile(file, '{"private":"never-print-this-value",');
      await expect(assertActiveSecureTunnelIsolation(proposed)).rejects.toThrow('Cannot parse sibling account settings');
    } finally {
      initConfigPath(dir); await loadConfig(); await removeTempDir(root);
    }
  });

  it('rejects the same concrete tunnel id behind two different instance setup references', async () => {
    await saveConfig(defaultConfig());
    const config = await loadConfig();
    const legacy = config.instances!.profiles.find(profile => profile.id === config.instances!.activeInstanceId)!;
    const secondId = 'second-instance';
    const sharedTunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
    const second = {
      ...legacy,
      id: secondId,
      displayName: 'Second instance',
      state: { mode: 'isolated' as const, root: path.join(dir, 'instances', secondId) },
      bridge: { host: '127.0.0.1' as const, port: 8766 },
      connector: { identity: 'second-instance', legacyNames: false },
      tunnelProfileRef: 'second-setup',
      browser: { profileId: secondId, electronPartition: secondId },
      namespaces: { sessions: secondId, queue: secondId, logs: secondId, health: secondId },
      approvedFolders: [],
      projects: []
    };
    const colliding = {
      ...config,
      tunnel: { ...config.tunnel, profileId: 'default', tunnelId: sharedTunnelId },
      setupProfiles: [{
        id: 'second-setup',
        name: 'Second setup',
        tunnelId: sharedTunnelId,
        desktopTunnelId: '',
        pluginsTunnelId: ''
      }],
      instances: {
        schemaVersion: 1 as const,
        activeInstanceId: legacy.id,
        profiles: [{ ...legacy, tunnelProfileRef: 'default' }, second]
      }
    };

    await expect(saveConfig(colliding)).rejects.toMatchObject({ code: 'tunnel_collision' });
  });

  it('creates isolated profiles without changing the active default profile, tunnel, roots, or owner namespaces', async () => {
    const profileDir = await makeTempDir('clf-instance-create-');
    try {
      initConfigPath(profileDir);
      const baseline = await loadConfig();
      const sourceId = baseline.instances!.activeInstanceId;
      const sourceProfile = structuredClone(baseline.instances!.profiles.find(profile => profile.id === sourceId)!);
      const sourceTunnel = structuredClone(baseline.tunnel);
      const sourceRoots = structuredClone(baseline.roots);

      const work = await createLocalInstanceProfile('Work', 'Profile 2');
      const personal = await createLocalInstanceProfile('Personal', 'Profile 3');
      const live = getConfig();
      const profiles = live.instances!.profiles;

      expect(live.instances!.activeInstanceId).toBe(sourceId);
      expect(profiles.find(profile => profile.id === sourceId)).toEqual(sourceProfile);
      expect(live.tunnel).toEqual({ ...sourceTunnel, pluginsTunnelId: sourceTunnel.pluginsTunnelId ?? '' });
      expect(live.roots).toEqual(sourceRoots);
      expect(getActiveInstanceRuntime().profile.id).toBe(sourceId);

      expect(new Set(profiles.map(profile => profile.bridge.port)).size).toBe(profiles.length);
      expect(new Set(profiles.map(profile => profile.tunnelProfileRef)).size).toBe(profiles.length);
      expect(new Set(profiles.map(profile => profile.browser.profileId)).size).toBe(profiles.length);
      expect(new Set(profiles.map(profile => profile.browser.electronPartition)).size).toBe(profiles.length);
      expect(new Set(profiles.map(profile => profile.connector.identity.toLowerCase())).size).toBe(profiles.length);
      for (const namespace of ['sessions', 'queue', 'logs', 'health'] as const) {
        expect(new Set(profiles.map(profile => profile.namespaces[namespace])).size).toBe(profiles.length);
      }
      expect(work.browser.profileDirectory).toBe('Profile 2');
      expect(personal.browser.profileDirectory).toBe('Profile 3');
      expect(instanceConnectorAccountAlias(work)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ [0-9a-f]{12}$/);
      expect(work.connector.displayBrand).toContain(instanceConnectorAccountAlias(work));
      expect(work.connector.displayBrand).toContain(`Work ${hostPlatformLabel}`);
      expect(personal.connector.displayBrand).toContain(`Personal ${hostPlatformLabel}`);
      expect(work.connector.displayBrand).not.toBe(personal.connector.displayBrand);
      expect(live.setupProfiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: work.tunnelProfileRef }),
        expect.objectContaining({ id: personal.tunnelProfileRef })
      ]));
      expect(live.tunnel.profileId ?? 'default').toBe(sourceTunnel.profileId ?? 'default');
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(profileDir);
    }
  });

  it('device-qualifies setup and connector labels exactly once', async () => {
    const profileDir = await makeTempDir('clf-instance-device-label-');
    try {
      initConfigPath(profileDir);
      await loadConfig();
      const profile = await createLocalInstanceProfile(`Alpha ${hostPlatformLabel}`, 'Profile 7');
      expect(profile.displayName).toBe(`Alpha ${hostPlatformLabel}`);
      expect(profile.connector.displayBrand!.endsWith(hostPlatformLabel)).toBe(true);
      expect(getConfig().setupProfiles?.find(row => row.id === profile.tunnelProfileRef)?.name)
        .toBe(`Alpha ${hostPlatformLabel}`);

      const renamed = await renameLocalInstanceProfile(profile.id, `Editing ${hostPlatformLabel}`);
      expect(renamed.displayName).toBe(`Editing ${hostPlatformLabel}`);
      expect(renamed.connector).toEqual(profile.connector);
      expect(getConfig().setupProfiles?.find(row => row.id === profile.tunnelProfileRef)?.name)
        .toBe(`Editing ${hostPlatformLabel}`);
      expect((await loadConfig()).instances!.profiles.find(row => row.id === profile.id)?.connector).toEqual(profile.connector);
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(profileDir);
    }
  });

  it.each(['\u2028', '\u2029'])('refuses nickname separator %j before creating setup or account state', async separator => {
    const before = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
    await expect(createLocalInstanceProfile(`Ja${separator}sury`, 'Profile 8')).rejects.toThrow(/control characters/);
    expect(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).toBe(before);
  });

  it('atomically reuses an exact account pair while refusing nickname or directory rebinding', async () => {
    const root = await makeTempDir('clf-instance-create-idempotent-');
    try {
      initConfigPath(root);
      const baseline = await loadConfig();
      await updateConfig(config => ({ ...config,
        roots: [{ name: 'documents', path: path.join(root, 'Documents') }],
        ui: { ...config.ui, automationPaused: true }
      }));
      const [first, second] = await Promise.all([
        createLocalInstanceProfile(' Gamma ', ' Profile 8 '),
        createLocalInstanceProfile('Gamma', 'Profile 8')
      ]);
      expect(second.id).toBe(first.id);
      const before = await fs.readFile(path.join(root, 'config.json'), 'utf8');
      expect((await createLocalInstanceProfile('Gamma', 'profile 8')).id).toBe(first.id);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(before);
      expect(getConfig().instances!.profiles).toHaveLength(2);
      expect(getConfig().setupProfiles?.filter(profile => profile.id === first.tunnelProfileRef)).toHaveLength(1);
      expect(getConfig().instances!.activeInstanceId).toBe(baseline.instances!.activeInstanceId);
      expect(getConfig().tunnel).toEqual({ ...baseline.tunnel, pluginsTunnelId: baseline.tunnel.pluginsTunnelId ?? '' });
      expect(getConfig().ui.automationPaused).toBe(true);
      expect(first.approvedFolders).toEqual([]);
      expect(first.projects).toEqual([]);
      await expect(fs.stat(first.state.root)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(createLocalInstanceProfile('Other', 'Profile 8')).rejects.toMatchObject({ code: 'browser_profile_collision' });
      await expect(createLocalInstanceProfile('Gamma', 'Profile 6')).rejects.toThrow(/nickname.*already assigned/i);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(before);
      const business = await createLocalInstanceProfile('Business', 'Profile 6');
      const afterBusiness = await fs.readFile(path.join(root, 'config.json'), 'utf8');
      await expect(renameLocalInstanceProfile(business.id, 'Gamma')).rejects.toThrow(/nickname.*already assigned/i);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(afterBusiness);
      // Old saved names also remain stable when their human-facing nickname is corrected.
      await updateConfig(config => ({ ...config, instances: { ...config.instances!,
        profiles: config.instances!.profiles.map(profile => profile.id === business.id
          ? { ...profile, connector: { ...profile.connector, identity: 'old-bound-business', displayBrand: 'Previously bound Business' } }
          : profile)
      } }));
      const oldConnector = structuredClone(getConfig().instances!.profiles.find(profile => profile.id === business.id)!.connector);
      expect((await renameLocalInstanceProfile(business.id, 'Business renamed')).connector).toEqual(oldConnector);
      await expect(fs.stat(path.join(root, 'secrets.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('reuses an exact account at the registry limit without enabling it or preparing its runtime', async () => {
    const root = await makeTempDir('clf-instance-create-limit-');
    try {
      initConfigPath(root);
      await loadConfig();
      const profiles = await Promise.all(Array.from({ length: 31 }, (_, index) =>
        createLocalInstanceProfile(`Account ${index}`, `Profile ${index + 1}`)));
      const existing = profiles[0]!;
      await updateConfig(config => ({ ...config, instances: { ...config.instances!,
        profiles: config.instances!.profiles.map(profile => profile.id === existing.id
          ? { ...profile, enabled: false } : profile)
      } }));
      const before = await fs.readFile(path.join(root, 'config.json'), 'utf8');
      const reused = await createLocalInstanceProfile(existing.displayName, existing.browser.profileDirectory!);
      expect(reused.id).toBe(existing.id);
      expect(reused.enabled).toBe(false);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(before);
      await expect(createLocalInstanceProfile('Over limit', 'Profile 32')).rejects.toThrow(/limit reached/);
      await expect(fs.stat(existing.state.root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('does not reuse a matching account pair belonging to another physical device', async () => {
    const root = await makeTempDir('clf-instance-create-device-');
    try {
      initConfigPath(root);
      await loadConfig();
      const foreign = await createLocalInstanceProfile('Gamma', 'Profile 8');
      const foreignDeviceId = '00000000-0000-4000-8000-000000000099';
      await updateConfig(config => ({ ...config, instances: { ...config.instances!,
        profiles: config.instances!.profiles.map(profile => profile.id === foreign.id
          ? { ...profile, deviceId: foreignDeviceId } : profile)
      } }));
      const own = await createLocalInstanceProfile('Gamma', 'Profile 8');
      expect(own.id).not.toBe(foreign.id);
      expect(own.deviceId).not.toBe(foreignDeviceId);
      expect(instanceConnectorAccountAlias(own)).not.toBe(instanceConnectorAccountAlias(foreign));
      expect(own.approvedFolders).toEqual([]);
      expect(getConfig().instances!.profiles.find(profile => profile.id === foreign.id)?.deviceId).toBe(foreignDeviceId);
      expect(getConfig().instances!.profiles).toHaveLength(3);
      await expect(fs.stat(own.state.root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('rebinds an inactive account without changing its owner or stealing another Chrome profile', async () => {
    const profileDir = await makeTempDir('clf-instance-browser-rebind-');
    try {
      initConfigPath(profileDir);
      const baseline = await loadConfig();
      const sourceId = baseline.instances!.activeInstanceId;
      const Zeta = await createLocalInstanceProfile('Zeta', 'Profile 3');
      const foot = await createLocalInstanceProfile('Alpha', 'Profile 4');

      const rebound = await setLocalInstanceBrowserProfile(Zeta.id, 'Profile');
      expect(rebound.browser.profileDirectory).toBe('Profile');
      expect(getConfig().instances!.profiles.map(profile => profile.id)).toEqual([sourceId, Zeta.id, foot.id]);
      expect(getActiveInstanceRuntime().profile.id).toBe(sourceId);
      expect(getConfig().instances!.profiles.find(profile => profile.id === foot.id)?.browser.profileDirectory).toBe('Profile 4');

      await expect(setLocalInstanceBrowserProfile(Zeta.id, 'Profile 4')).rejects.toMatchObject({ code: 'browser_profile_collision' });
      const boundSource = await setLocalInstanceBrowserProfile(sourceId, 'Profile 3');
      expect(boundSource.browser.profileDirectory).toBe('Profile 3');
      expect(getActiveInstanceRuntime().profile.browser.profileDirectory).toBe('Profile 3');
      await expect(setLocalInstanceBrowserProfile(sourceId, 'Profile 5')).rejects.toThrow(/Pause this account and switch away/);
      expect(getConfig().instances!.profiles.find(profile => profile.id === Zeta.id)?.browser.profileDirectory).toBe('Profile');
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(profileDir);
    }
  });

  it('never lets Chrome choose another account when the active profile is unbound', async () => {
    const profileDir = await makeTempDir('clf-instance-browser-routing-');
    try {
      initConfigPath(profileDir);
      const baseline = await loadConfig();
      const sourceId = baseline.instances!.activeInstanceId;
      await createLocalInstanceProfile('Zeta', 'Profile');
      const launch = vi.fn(async (_file: string, _args: readonly string[], _cwd: string) => ({ pid: 123 }));
      const windowsLaunch = vi.fn(async (
        _file: string, _args: readonly string[], _cwd: string, _visibility: 'visible' | 'minimized'
      ) => ({ pid: 123 }));
      const options = {
        browser: 'chrome' as const,
        platform: 'win32' as const,
        env: { ProgramFiles: 'C:\\Program Files' },
        usable: () => true,
        launch,
        windowsLaunch
      };
      await expect(openInPreferredBrowser('https://chatgpt.com/', options)).rejects.toThrow(/no exact Chrome profile directory/);
      expect(launch).not.toHaveBeenCalled();
      expect(windowsLaunch).not.toHaveBeenCalled();

      await setLocalInstanceBrowserProfile(sourceId, 'Profile 3');
      await openInPreferredBrowser('https://chatgpt.com/', options);
      expect(windowsLaunch).toHaveBeenCalledTimes(1);
      expect(windowsLaunch.mock.calls[0]?.[1]).toContain('--profile-directory=Profile 3');
      expect(windowsLaunch.mock.calls[0]?.[3]).toBe('visible');
      expect(launch).not.toHaveBeenCalled();
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(profileDir);
    }
  });

  it('loads an isolated account runtime from a private config path against the canonical device root', async () => {
    const root = await makeTempDir('clf-concurrent-profile-');
    try {
      initConfigPath(root);
      await loadConfig();
      const profile = await createLocalInstanceProfile('Zeta', 'Profile');
      const prepared = await snapshotConfigForInstance(profile.id);
      expect(getActiveInstanceRuntime().profile.id).not.toBe(profile.id);
      expect(prepared.multiAgent.defaultModel).toBe('gpt-6-thinking');
      expect(prepared.multiAgent.defaultReasoning).toBe('high');
      expect(prepared.goal.helperModel).toBe('gpt-6-thinking');
      expect(prepared.goal.helperReasoning).toBe('high');
      const privateConfigRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
      expect(JSON.parse(await fs.readFile(path.join(privateConfigRoot, 'config.json'), 'utf8'))).toEqual(prepared);
      initConfigPath(privateConfigRoot, root);
      await loadConfig();
      expect(getActiveInstanceRuntime().profile.id).toBe(profile.id);
      expect(getActiveInstanceOwnerPaths().stateRoot).toBe(profile.state.root);
      await updateConfig(config => ({
        ...config,
        ui: { ...config.ui, theme: 'light' },
        multiAgent: { ...config.multiAgent, defaultModel: 'gpt-5.5', defaultReasoning: 'high' },
        goal: { ...config.goal, helperModel: 'gpt-5.5', helperReasoning: 'high' }
      }));
      const startupMigrated = await loadConfig();
      expect(startupMigrated.ui.theme).toBe('light');
      expect(startupMigrated.multiAgent.defaultReasoning).toBe('high');
      expect(startupMigrated.goal.helperReasoning).toBe('high');
      expect(startupMigrated.multiAgent.defaultModel).toBe('gpt-5.5');
      expect(startupMigrated.goal.helperModel).toBe('gpt-5.5');
      const startupDisk = JSON.parse(await fs.readFile(path.join(privateConfigRoot, 'config.json'), 'utf8'));
      expect(startupDisk.ui.theme).toBe('light');
      expect(startupDisk.multiAgent.defaultReasoning).toBe('high');
      expect(startupDisk.goal.helperReasoning).toBe('high');
      expect(startupDisk.multiAgent.defaultModel).toBe('gpt-5.5');
      expect(startupDisk.goal.helperModel).toBe('gpt-5.5');
      initConfigPath(root);
      await loadConfig();
      expect(await prepareIsolatedInstanceRuntimeConfig(profile.id)).toBe(privateConfigRoot);
      initConfigPath(privateConfigRoot, root);
      const migrated = await loadConfig();
      expect(migrated.ui.theme).toBe('light');
      expect(migrated.multiAgent.defaultReasoning).toBe('high');
      expect(migrated.goal.helperReasoning).toBe('high');
      expect(migrated.multiAgent.defaultModel).toBe('gpt-5.5');
      expect(migrated.goal.helperModel).toBe('gpt-5.5');
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('moves an inactive account bridge route in both owners without resetting private model preferences', async () => {
    const root = await makeTempDir('clf-instance-bridge-route-');
    try {
      initConfigPath(root);
      await loadConfig();
      const profile = await createLocalInstanceProfile('Garry', 'Profile 5');
      const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
      initConfigPath(privateRoot, root);
      await loadConfig();
      await updateConfig(config => ({
        ...config,
        ui: { ...config.ui, theme: 'light' },
        multiAgent: { ...config.multiAgent, defaultModel: 'gpt-5.5', defaultReasoning: 'high' },
        goal: { ...config.goal, helperModel: 'gpt-5.5', helperReasoning: 'high' }
      }));

      initConfigPath(root);
      await loadConfig();
      const moved = await setLocalInstanceBridgePort(profile.id, 8796);
      expect(moved.bridge.port).toBe(8796);
      expect(getConfig().instances?.profiles.find(row => row.id === profile.id)?.bridge.port).toBe(8796);

      const privateConfig = JSON.parse(await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8'));
      expect(privateConfig.instances.profiles.find((row: any) => row.id === profile.id).bridge.port).toBe(8796);
      expect(privateConfig.ui.theme).toBe('light');
      expect(privateConfig.multiAgent).toMatchObject({ defaultModel: 'gpt-5.5', defaultReasoning: 'high' });
      expect(privateConfig.goal).toMatchObject({ helperModel: 'gpt-5.5', helperReasoning: 'high' });
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('serializes prepared nickname projections so a second rename cannot publish the first nickname', async () => {
    const root = await makeTempDir('clf-instance-nickname-serial-');
    try {
      initConfigPath(root);
      await loadConfig();
      const profile = await createLocalInstanceProfile('Business', 'Profile 6');
      const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
      const file = path.join(privateRoot, 'config.json');
      const original = JSON.parse(await fs.readFile(file, 'utf8'));
      original.ui.theme = 'light';
      original.goal.helperReasoning = 'xhigh';
      original.futurePrivatePreference = { preserveExactly: true };
      await fs.writeFile(file, JSON.stringify(original));
      await Promise.all([renameLocalInstanceProfile(profile.id, 'First name'), renameLocalInstanceProfile(profile.id, 'Delta')]);
      const privateAfter = JSON.parse(await fs.readFile(file, 'utf8'));
      const canonical = getConfig().instances!.profiles.find(row => row.id === profile.id)!;
      expect(canonical.displayName).toBe('Delta');
      expect(canonical.connector).toEqual(profile.connector);
      const expected = structuredClone(original);
      const privateProfile = expected.instances.profiles.find((row: { id: string }) => row.id === profile.id);
      privateProfile.displayName = privateProfile.accountLabel = 'Delta';
      expected.tunnel.profileName = getConfig().setupProfiles!.find(row => row.id === profile.tunnelProfileRef)!.name;
      for (const setup of expected.setupProfiles ?? []) if (setup.id === profile.tunnelProfileRef)
        setup.name = getConfig().setupProfiles!.find(row => row.id === profile.tunnelProfileRef)!.name;
      expect(privateAfter).toEqual(expected);
      expect((await fs.readdir(privateRoot)).some(name => name.includes('.tmp-nickname-'))).toBe(false);
      initConfigPath(privateRoot, root);
      await loadConfig();
      await expect(renameLocalInstanceProfile(profile.id, 'Other')).rejects.toThrow(/primary account/);
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('refuses malformed or foreign prepared nickname owners before changing either config', async () => {
    const root = await makeTempDir('clf-instance-nickname-identity-');
    try {
      initConfigPath(root);
      await loadConfig();
      const profile = await createLocalInstanceProfile('Business', 'Profile 6');
      const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
      const file = path.join(privateRoot, 'config.json');
      const primaryBefore = await fs.readFile(path.join(root, 'config.json'), 'utf8');
      const original = JSON.parse(await fs.readFile(file, 'utf8'));
      for (const mutation of [
        (config: typeof original) => { config.instances.activeInstanceId = 'local-instance'; },
        (config: typeof original) => { config.tunnel.profileId = 'default'; },
        (config: typeof original) => { config.instances.profiles.find((row: { id: string }) => row.id === profile.id).bridge.port = 8796; },
        (config: typeof original) => { config.instances.profiles.find((row: { id: string }) => row.id === profile.id).connector.displayBrand = 'Foreign brand'; },
        (config: typeof original) => { config.instances.profiles.find((row: { id: string }) => row.id === profile.id).browser.profileId = 'foreign-browser'; }
      ]) {
        const foreign = structuredClone(original);
        mutation(foreign);
        const bytes = JSON.stringify(foreign);
        await fs.writeFile(file, bytes);
        await expect(renameLocalInstanceProfile(profile.id, 'Delta')).rejects.toThrow();
        expect(await fs.readFile(file, 'utf8')).toBe(bytes);
        expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(primaryBefore);
      }
      await fs.writeFile(file, '{invalid');
      await expect(renameLocalInstanceProfile(profile.id, 'Delta')).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe('{invalid');
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(primaryBefore);
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('refuses a newer private snapshot at nickname publication and restores only its canonical labels', async () => {
    const root = await makeTempDir('clf-instance-nickname-cas-');
    try {
      initConfigPath(root);
      await loadConfig();
      const profile = await createLocalInstanceProfile('Business', 'Profile 6');
      const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
      const file = path.join(privateRoot, 'config.json');
      const primaryBefore = await fs.readFile(path.join(root, 'config.json'), 'utf8');
      const newer = JSON.parse(await fs.readFile(file, 'utf8'));
      newer.ui.theme = 'light';
      const newerBytes = JSON.stringify(newer);
      let boundaries = 0;
      await expect(renameLocalInstanceProfile(profile.id, 'Delta', async () => {
        if (++boundaries === 2) await fs.writeFile(file, newerBytes);
      })).rejects.toThrow(/settings changed/);
      expect(boundaries).toBe(2);
      expect(await fs.readFile(file, 'utf8')).toBe(newerBytes);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(primaryBefore);
      expect((await fs.readdir(privateRoot)).some(name => name.includes('.tmp-nickname-'))).toBe(false);
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it.each(['EIO', 'EACCES'])('rolls back a failed private nickname write (%s) before a queued canonical settings edit', async code => {
    const root = await makeTempDir('clf-instance-nickname-rollback-');
    let rename: ReturnType<typeof vi.spyOn> | undefined;
    try {
      initConfigPath(root);
      await loadConfig();
      const profile = await createLocalInstanceProfile('Business', 'Profile 6');
      const privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
      const file = path.join(privateRoot, 'config.json');
      const privateBefore = await fs.readFile(file, 'utf8');
      const realRename = fs.rename.bind(fs);
      rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === file) throw Object.assign(new Error('test private publish failure'), { code });
        return realRename(from, to);
      });
      const [failed, saved] = await Promise.allSettled([
        renameLocalInstanceProfile(profile.id, 'Delta'),
        updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'light' } }))
      ]);
      expect(failed.status).toBe('rejected');
      expect(saved.status).toBe('fulfilled');
      expect(getConfig().instances!.profiles.find(row => row.id === profile.id)!.displayName).toBe('Business');
      expect(getConfig().ui.theme).toBe('light');
      expect(rename.mock.calls.filter((call: unknown[]) => String(call[1]) === file)).toHaveLength(1);
      expect(await fs.readFile(file, 'utf8')).toBe(privateBefore);
      expect((await fs.readdir(privateRoot)).some(name => name.includes('.tmp-nickname-'))).toBe(false);
    } finally {
      rename?.mockRestore();
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('refuses an account prepared while nickname verification waits without rewriting its new settings', async () => {
    const root = await makeTempDir('clf-instance-nickname-bootstrap-race-');
    try {
      initConfigPath(root);
      await loadConfig();
      const profile = await createLocalInstanceProfile('Business', 'Profile 6');
      const primaryBefore = await fs.readFile(path.join(root, 'config.json'), 'utf8');
      let privateRoot = '', privateBefore = '';
      await expect(renameLocalInstanceProfile(profile.id, 'Delta', async () => {
        privateRoot = await prepareIsolatedInstanceRuntimeConfig(profile.id);
        privateBefore = await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8');
      })).rejects.toThrow(/runtime was prepared/);
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(primaryBefore);
      expect(await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8')).toBe(privateBefore);
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(root);
    }
  });

  it('stages target roots, setup, and active profile on disk without rebinding the live source process', async () => {
    const profileDir = await makeTempDir('clf-instance-stage-');
    try {
      initConfigPath(profileDir);
      await loadConfig();
      const sourceRoot = { name: 'source', path: path.join(profileDir, 'source-work') };
      await updateConfig(config => ({ ...config, roots: [sourceRoot] }));
      const sourceId = getConfig().instances!.activeInstanceId;
      const target = await createLocalInstanceProfile('Target', 'Profile 9');
      const targetRoot = { name: 'target', path: path.join(profileDir, 'target-work') };

      await updateConfig(config => ({
        ...config,
        instances: {
          ...config.instances!,
          profiles: config.instances!.profiles.map(profile => profile.id === target.id ? {
            ...profile,
            approvedFolders: [{
              id: 'target-root',
              label: 'Target root',
              role: 'approved-root',
              bindings: [{
                platform: target.platform,
                deviceId: target.deviceId,
                rootName: targetRoot.name,
                localPath: targetRoot.path
              }]
            }]
          } : profile)
        }
      }));

      const liveBeforeStage = {
        activeInstanceId: getConfig().instances!.activeInstanceId,
        runtimeProfileId: getActiveInstanceRuntime().profile.id,
        roots: structuredClone(getConfig().roots),
        tunnel: structuredClone(getConfig().tunnel)
      };
      expect(liveBeforeStage).toMatchObject({ activeInstanceId: sourceId, runtimeProfileId: sourceId, roots: [sourceRoot] });

      const staged = await stageInstanceActivationForNextStart(target.id);
      expect(staged.instances!.activeInstanceId).toBe(target.id);
      expect(staged.roots).toEqual([targetRoot]);
      expect(staged.tunnel.profileId).toBe(target.tunnelProfileRef);
      expect(staged.instances!.profiles.find(profile => profile.id === target.id)?.tunnelProfileRef).toBe(target.tunnelProfileRef);

      const disk = JSON.parse(await fs.readFile(path.join(profileDir, 'config.json'), 'utf8'));
      expect(disk.instances.activeInstanceId).toBe(target.id);
      expect(disk.roots).toEqual([targetRoot]);
      expect(disk.tunnel.profileId).toBe(target.tunnelProfileRef);

      expect(getConfig().instances!.activeInstanceId).toBe(liveBeforeStage.activeInstanceId);
      expect(getActiveInstanceRuntime().profile.id).toBe(liveBeforeStage.runtimeProfileId);
      expect(getConfig().roots).toEqual(liveBeforeStage.roots);
      expect(getConfig().tunnel).toEqual(liveBeforeStage.tunnel);
    } finally {
      initConfigPath(dir);
      await loadConfig();
      await removeTempDir(profileDir);
    }
  });

  /** An unknown reasoning level is somebody else's vocabulary, not a level to guess at. */
  it('falls back rather than passing an unknown reasoning level to OpenRouter', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { enabled: true, model: 'x/y', reasoning: 'extreme' } }),
      'utf8'
    );
    expect((await loadConfig()).goal.reasoning).toBe('default');
  });
});


it.each(REASONING_EFFORTS)('retains canonical worker/helper effort %s across settings save and reload', async effort => {
  const config = defaultConfig();
  config.multiAgent.defaultReasoning = effort;
  config.goal.helperReasoning = effort;
  await saveConfig(config);
  const loaded = await loadConfig();
  expect(loaded.multiAgent.defaultReasoning).toBe(effort);
  expect(loaded.goal.helperReasoning).toBe(effort);
});


it('persists external origin/port through the normal config owner and holds new external enrollment', async () => {
  const original = getConfig();
  try {
    await saveConfig({ ...original, tunnel: { ...original.tunnel, kind: 'manual', manualPublicOrigin: 'https://Delta.example.com/', manualPort: 9770 } });
    const loaded = await loadConfig();
    expect(loaded.tunnel).toMatchObject({ kind: 'manual', manualPublicOrigin: 'https://Delta.example.com', manualPort: 9770 });
    expect(loaded.ui.automationPaused).toBe(true);
    expect(loaded.tunnel.manualEndpointRevision).toBeGreaterThan(0);
    expect(loaded.instances).toEqual(original.instances);
  } finally { await saveConfig(original); }
});

it('keeps same-origin restart continuity and retires authority on explicit replacement or clear/re-enable', async () => {
  const original = getConfig();
  try {
    await saveConfig({ ...original, ui: { ...original.ui, automationPaused: false },
      tunnel: { ...original.tunnel, kind: 'manual', manualPublicOrigin: 'https://Delta.example.com' } });
    const revision = getConfig().tunnel.manualEndpointRevision!;
    expect(getConfig().ui.automationPaused).toBe(true);
    await updateConfig(config => ({ ...config, ui: { ...config.ui, automationPaused: false } }));
    await loadConfig();
    expect(getConfig().tunnel.manualEndpointRevision).toBe(revision);
    expect(getConfig().ui.automationPaused).toBe(false);
    const withoutRevision = { ...getConfig().tunnel }; delete withoutRevision.manualEndpointRevision;
    await updateConfig(config => ({ ...config, tunnel: withoutRevision }));
    expect(getConfig().tunnel.manualEndpointRevision).toBe(revision);
    expect(getConfig().ui.automationPaused).toBe(false);
    await updateConfig(config => ({ ...config, tunnel: { ...config.tunnel, manualPublicOrigin: 'https://replacement.example.com' } }));
    expect(getConfig().tunnel.manualEndpointRevision).toBe(revision + 1);
    expect(getConfig().ui.automationPaused).toBe(true);
    await updateConfig(config => ({ ...config, tunnel: { ...config.tunnel, manualPublicOrigin: '' } }));
    expect(getConfig().tunnel.manualEndpointRevision).toBe(revision + 2);
    await updateConfig(config => ({ ...config, tunnel: { ...config.tunnel, manualPublicOrigin: 'https://replacement.example.com' } }));
    expect(getConfig().tunnel.manualEndpointRevision).toBe(revision + 3);
  } finally { await saveConfig(original); }
});


it('does not inherit another profile’s external hostname or fixed port and preserves a prepared target’s own route', async () => {
  const profileDir = await makeTempDir('clf-external-profile-');
  try {
    initConfigPath(profileDir);
    const baseline = await loadConfig();
    await saveConfig({ ...baseline, tunnel: { ...baseline.tunnel, kind: 'manual', manualPublicOrigin: 'https://Delta.example.com', manualPort: 9770 } });
    const target = await createLocalInstanceProfile('External Target', 'Profile 31');
    const snapshot = await snapshotConfigForInstance(target.id);
    expect(snapshot.tunnel.manualPublicOrigin).toBeUndefined();
    expect(snapshot.tunnel.manualPort).toBeUndefined();
    expect(snapshot.tunnel.manualEndpointRevision).toBeUndefined();
    expect(getConfig().tunnel).toMatchObject({ manualPublicOrigin: 'https://Delta.example.com', manualPort: 9770 });
    const runtime = await prepareIsolatedInstanceRuntimeConfig(target.id);
    const file = path.join(runtime, 'config.json');
    const prepared = JSON.parse(await fs.readFile(file, 'utf8'));
    prepared.tunnel.manualPublicOrigin = 'https://Epsilon.example.com'; prepared.tunnel.manualPort = 9771; prepared.tunnel.manualEndpointRevision = 7;
    await fs.writeFile(file, JSON.stringify(prepared));
    await prepareIsolatedInstanceRuntimeConfig(target.id);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).tunnel).toMatchObject({ manualPublicOrigin: 'https://Epsilon.example.com', manualPort: 9771, manualEndpointRevision: 7 });
  } finally { initConfigPath(dir); await loadConfig(); await removeTempDir(profileDir); }
});

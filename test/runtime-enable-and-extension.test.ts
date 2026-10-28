import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  operatorSessionInspectionRequest, operatorSettingsControlRequest, operatorConnectionControlRequest,
  operatorSharedAccountSettingsRequest, operatorProfileCreationRequest, operatorProfileBrowserBindingRequest,
  operatorProfileRenameRequest,
  operatorInputRequestIds, operatorInputCancellationIds, operatorInputRetryIds, operatorProfileCreationAdditionalData
} from '../src/main/operator-input.js';
import { helperReasoningSettingsRequest, signOutEmergencyAlertSettingRequest } from '../src/main/window-lifecycle.js';

const repo = process.cwd();

describe('runtime multi-agent enable regression', () => {
  it('wires persistence before unconditional restore and preserves history while disabled', async () => {
    const source = await readFile(path.join(repo, 'src/main/index.ts'), 'utf8');
    const persistSink = source.indexOf('onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot))');
    const restoreRead = source.indexOf('const savedSwarm = await readDurable<SwarmSnapshot>(SWARM_STATE)');
    const shutdownFence = source.indexOf('if (windowActivation.isDisabled()) return;', restoreRead);
    const restore = source.indexOf('restoreSwarm(savedSwarm)', restoreRead);
    const disabledPause = source.indexOf("pauseSwarmForDisable('multi-agent mode is disabled')");

    expect(persistSink).toBeGreaterThanOrEqual(0);
    expect(restoreRead).toBeGreaterThanOrEqual(0);
    expect(shutdownFence).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(disabledPause).toBeGreaterThanOrEqual(0);
    expect(persistSink).toBeLessThan(restoreRead);
    expect(restoreRead).toBeLessThan(shutdownFence);
    expect(shutdownFence).toBeLessThan(restore);
    expect(restore).toBeLessThan(disabledPause);
    expect(source).not.toContain('await writeDurableNow(SWARM_STATE, null)');
  });
});

describe('durable input startup order', () => {
  it('restores queued wake retries only after durable and IPC owners are initialized', async () => {
    const source = await readFile(path.join(repo, 'src/main/index.ts'), 'utf8');
    const durable = source.indexOf('initDurableStore(ownerPaths.durableStoreRoot)');
    const ipc = source.indexOf('stopIpcLifecyclePolling = registerIpc(');
    const wakeRestore = source.indexOf('await startQueuedWakeRetrySync()');
    const guardedRestore = source.indexOf('try {', ipc);
    const restoreFailure = source.indexOf('Durable input startup failed:', wakeRestore);
    const postRestoreQuitGate = source.indexOf('if (quitting || windowActivation.isDisabled()) return;', wakeRestore);
    const windowEnable = source.indexOf('windowActivation.enable()', postRestoreQuitGate);
    const operatorReady = source.indexOf('operatorInputRuntimeReady = true');
    const beforeQuit = source.indexOf("app.on('before-quit'");
    const stopWakeRestore = source.indexOf('stopQueuedWakeRetrySync()', beforeQuit);
    const stopIpc = source.indexOf('stopIpcLifecyclePolling?.()', beforeQuit);

    expect(durable).toBeGreaterThanOrEqual(0);
    expect(ipc).toBeGreaterThanOrEqual(0);
    expect(wakeRestore).toBeGreaterThanOrEqual(0);
    expect(guardedRestore).toBeGreaterThanOrEqual(0);
    expect(restoreFailure).toBeGreaterThanOrEqual(0);
    expect(postRestoreQuitGate).toBeGreaterThanOrEqual(0);
    expect(windowEnable).toBeGreaterThanOrEqual(0);
    expect(operatorReady).toBeGreaterThanOrEqual(0);
    expect(beforeQuit).toBeGreaterThanOrEqual(0);
    expect(stopWakeRestore).toBeGreaterThanOrEqual(0);
    expect(stopIpc).toBeGreaterThanOrEqual(0);
    expect(durable).toBeLessThan(ipc);
    expect(ipc).toBeLessThan(wakeRestore);
    expect(guardedRestore).toBeLessThan(wakeRestore);
    expect(wakeRestore).toBeLessThan(restoreFailure);
    expect(wakeRestore).toBeLessThan(postRestoreQuitGate);
    expect(postRestoreQuitGate).toBeLessThan(windowEnable);
    expect(wakeRestore).toBeLessThan(operatorReady);
    expect(beforeQuit).toBeLessThan(stopWakeRestore);
    expect(stopWakeRestore).toBeLessThan(stopIpc);
  });
});

describe('companion extension setup contract', () => {
  it('materializes the packaged companion during startup before the bridge can run', async () => {
    const source = await readFile(path.join(repo, 'src/main/index.ts'), 'utf8');
    const materialize = source.indexOf('const companion = extensionDir()');
    const bridge = source.indexOf('void startBridge()');
    const reload = source.indexOf('await reloadPairedCompanionAfterUpdate(companionFingerprint)');
    expect(source).toContain("import { companionMaterializedFingerprint, companionReloadUrl, extensionDir, usePrimaryStableExtensionRoot } from './extension-path.js'");
    expect(source).toContain('usePrimaryStableExtensionRoot(isolatedSelection.canonicalRoot)');
    expect(materialize).toBeGreaterThanOrEqual(0);
    expect(bridge).toBeGreaterThanOrEqual(0);
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(materialize).toBeLessThan(bridge);
    expect(bridge).toBeLessThan(reload);
    expect(source).toContain('const previouslyActivated = await readDurable<string>(COMPANION_FINGERPRINT_STATE)');
    expect(source).toContain('previouslyActivated === fingerprint');
    expect(source).toContain('armPendingCompanionReload(fingerprint)');
    expect(source).toContain('state.unsubscribe = onBridgeChange(() => { void completePendingCompanionReload(state); })');
    expect(source).toContain('void completePendingCompanionReload(state)');
    expect(source).not.toContain('COMPANION_ORIGIN_MIGRATION_MS');
    expect(source).toContain('writeDurableNow(COMPANION_FINGERPRINT_STATE, state.fingerprint)');
  });

  it('reconciles surviving Chrome tabs before automation after an update restart', async () => {
    const [source, installer] = await Promise.all([
      readFile(path.join(repo, 'src/main/index.ts'), 'utf8'),
      readFile(path.join(repo, 'scripts/install-custom.ps1'), 'utf8')
    ]);
    expect(source).toContain("argv.includes('--resume-automation') && !argv.includes('--updated')");
    expect(source).toContain('suppressed bulk --resume-automation on updated launch');
    expect(installer).toContain("@('--updated', '--background')");
    expect(installer).not.toContain("@('--updated', '--background', '--resume-automation')");
  });

  it('keeps standalone recovery visible without pointing an installed app at releases/latest', async () => {
    const [html, renderer, preload, ipc] = await Promise.all([
      readFile(path.join(repo, 'src/renderer/index.html'), 'utf8'),
      readFile(path.join(repo, 'src/renderer/main.ts'), 'utf8'),
      readFile(path.join(repo, 'src/preload/index.ts'), 'utf8'),
      readFile(path.join(repo, 'src/main/ipc.ts'), 'utf8')
    ]);

    expect(html).toMatch(/id="bridgeDownload"[\s\S]*?Open packaged extension/i);
    expect(html).toMatch(/Required for sub-agents/i);
    expect(html).toMatch(/Requires the Chrome extension to be loaded and connected/i);
    expect(html).not.toContain('/releases/latest/');
    expect(ipc).not.toContain('/releases/latest/');
    expect(renderer).toContain('api.downloadExtension()');
    expect(preload).toContain("call<boolean>('bridge:downloadExtension')");
    expect(ipc).toContain("handle('bridge:downloadExtension'");
  });
});

/** Execute the shipped startup owner, not a second implementation of its reload policy. */
async function companionReloadFixture(withControls = false) {
  const source = await readFile(path.join(repo, 'src/main/index.ts'), 'utf8');
  const start = source.indexOf(withControls ? 'export function startupAutomationResumeRequested' : 'type PendingCompanionReload =');
  const end = source.indexOf('// Validate account setup controls', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const status = { running: true, port: 8766, paired: true, present: true, authState: 'signed-in', lastSeenAt: Date.now() };
  const config = { ui: { automationPaused: false }, tunnel: { profileEpoch: 3 } };
  const runtime = { profile: { id: 'profile-Delta', state: { mode: 'isolated' } }, stateRoot: 'retained-runtime' };
  const listeners = new Set<() => void>();
  const open = vi.fn(async (_url: string): Promise<void> => {});
  const write = vi.fn(async (_key: string, _fingerprint: string) => undefined);
  const read = vi.fn(async () => 'previous-fingerprint');
  const secret = vi.fn(async () => 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip');
  const originSlot = vi.fn((mode: string, id: string) => `${mode}:${id}:extension-origin`);
  const bridge = vi.fn(async () => ({ ...status }));
  const resume = vi.fn(async (_trigger: string, _ownerCurrent?: () => boolean) => {
    config.ui.automationPaused = false;
    for (const listener of [...listeners]) listener();
    return { queued: 0, alreadyActive: 1, recovering: 0 };
  });
  const context = vm.createContext({
    app: { isPackaged: true }, process: { argv: ['app.exe'], pid: 19 }, quitting: false,
    processCreationTime: 1700000000019,
    COMPANION_FINGERPRINT_STATE: 'companion-fingerprint',
    getConfig: () => config, getActiveInstanceRuntime: () => runtime,
    bridgeStatus: bridge, getSecret: secret, bridgeExtensionOriginSecretSlot: originSlot, URL,
    onBridgeChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    openInPreferredBrowser: open, writeDurableNow: write, readDurable: read,
    operatorSessionInspectionRequest, operatorSettingsControlRequest,
    operatorConnectionControlRequest, operatorSharedAccountSettingsRequest,
    operatorProfileCreationRequest, operatorProfileBrowserBindingRequest,
    operatorProfileRenameRequest,
    helperReasoningSettingsRequest, signOutEmergencyAlertSettingRequest,
    operatorInputRequestIds, operatorInputCancellationIds, operatorInputRetryIds,
    operatorPluginRefreshRearmIds: () => [], resumeAutomationAfterExplicitRequest: resume,
    logInfo: vi.fn(), logWarn: vi.fn()
  });
  const extensionPath = await readFile(path.join(repo, 'src/main/extension-path.ts'), 'utf8');
  const urlStart = extensionPath.indexOf('export function companionReloadUrl');
  const urlEnd = extensionPath.indexOf('\nfunction extensionFingerprint', urlStart);
  vm.runInContext(stripTypeScriptTypes(extensionPath.slice(urlStart, urlEnd)).replace(/^export /gm, ''), context);
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)).replace(/^export /gm, ''), context);
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { status, config, runtime, listeners, open, write, read, secret, originSlot, bridge, resume, context, settle,
    start: (fingerprint = 'new-fingerprint') => {
      context.fingerprint = fingerprint;
      return vm.runInContext('reloadPairedCompanionAfterUpdate(fingerprint)', context) as Promise<void>;
    },
    control: (argv: string[]) => {
      context.controlArgs = argv;
      vm.runInContext('acceptExplicitAutomationControlArgs(controlArgs)', context);
    },
    ready: () => vm.runInContext('markExplicitAutomationSettingsRuntimeReady(); markExplicitAutomationControlRuntimeReady()', context),
    pending: () => vm.runInContext('pendingCompanionReload', context),
    changed: () => { for (const listener of [...listeners]) listener(); } };
}

describe('automatic companion reload custody', () => {
  const deferralArgs = (fingerprint = 'a'.repeat(64)) => ['app.exe', '--background',
    '--cos-instance-runtime=profile-Delta', '--defer-companion-reload=profile-Delta',
    '--defer-companion-reload-pid=19', '--defer-companion-reload-generation=1700000000019',
    '--defer-companion-reload-epoch=3', `--defer-companion-reload-fingerprint=${fingerprint}`];
  const manualReloadArgs = (fingerprint = 'a'.repeat(64)) =>
    [...deferralArgs(fingerprint).map(arg => arg.replace('--defer-companion-reload', '--reload-companion')),
      '--discard-unexportable-companion-buffers'];
  it('requests one exact approved manual companion reload while unpaired and keeps automation paused', async () => {
    const fixture = await companionReloadFixture(true);
    fixture.config.ui.automationPaused = true; fixture.status.paired = false;
    fixture.status.present = false; fixture.status.authState = 'unknown'; fixture.ready();
    const fingerprint = 'a'.repeat(64); await fixture.start(fingerprint);
    const pending = fixture.pending();
    fixture.control(manualReloadArgs(fingerprint)); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.open.mock.calls[0]![0]).toMatch(/^chrome-extension:\/\/[a-p]{32}\/popup\.html\?clf-reload=1&nonce=[a-zA-Z0-9_-]+&close=1$/);
    expect(fixture.originSlot).toHaveBeenCalledWith('isolated', 'profile-Delta');
    expect(fixture.secret).toHaveBeenCalledWith('isolated:profile-Delta:extension-origin');
    expect(fixture.config.ui.automationPaused).toBe(true); expect(fixture.resume).not.toHaveBeenCalled();
    expect(fixture.write).not.toHaveBeenCalled();
    expect(fixture.pending()).toBe(pending); expect(fixture.pending()?.dispatched).toBe(true);
    expect(fixture.pending()?.fingerprint).toBe(fingerprint);
    expect(JSON.stringify([...fixture.context.logInfo.mock.calls, ...fixture.context.logWarn.mock.calls]))
      .not.toContain('chrome-extension://');
    fixture.control(manualReloadArgs(fingerprint)); fixture.changed(); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledOnce(); expect(fixture.write).not.toHaveBeenCalled();
  });

  it.each(['missing-approval', 'duplicate-approval', 'resume', 'deferral', 'wrong-pid', 'stale-generation',
    'wrong-epoch', 'wrong-fingerprint', 'unpaused', 'missing-origin', 'malformed-origin', 'origin-error'] as const)
    ('refuses %s manual reload without exposing the origin, resuming or writing a fingerprint', async hold => {
      const fixture = await companionReloadFixture(true); fixture.ready();
      fixture.config.ui.automationPaused = true; fixture.status.paired = false;
      const fingerprint = 'a'.repeat(64); await fixture.start(fingerprint);
      let args = manualReloadArgs(fingerprint);
      if (hold === 'missing-approval') args = args.filter(arg => arg !== '--discard-unexportable-companion-buffers');
      else if (hold === 'duplicate-approval') args.push('--discard-unexportable-companion-buffers');
      else if (hold === 'resume') args.push('--resume-automation');
      else if (hold === 'deferral') args.push('--defer-companion-reload=profile-Delta');
      else if (hold === 'wrong-pid') args = args.map(arg => arg === '--reload-companion-pid=19' ? '--reload-companion-pid=20' : arg);
      else if (hold === 'stale-generation') args = args.map(arg => arg.startsWith('--reload-companion-generation=') ? '--reload-companion-generation=1700000000020' : arg);
      else if (hold === 'wrong-epoch') args = args.map(arg => arg === '--reload-companion-epoch=3' ? '--reload-companion-epoch=4' : arg);
      else if (hold === 'wrong-fingerprint') args = args.map(arg => arg.startsWith('--reload-companion-fingerprint=') ? `--reload-companion-fingerprint=${'b'.repeat(64)}` : arg);
      else if (hold === 'unpaused') fixture.config.ui.automationPaused = false;
      else if (hold === 'missing-origin') fixture.secret.mockResolvedValue('');
      else if (hold === 'malformed-origin') fixture.secret.mockResolvedValue('https://never-print-secret-origin.example/private');
      else fixture.secret.mockRejectedValue(new Error('never-print-secret-origin'));
      fixture.control(args); await fixture.settle();
      expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.write).not.toHaveBeenCalled();
      expect(fixture.resume).not.toHaveBeenCalled(); expect(fixture.pending()?.dispatched).toBe(false);
      expect(JSON.stringify([...fixture.context.logInfo.mock.calls, ...fixture.context.logWarn.mock.calls]))
        .not.toContain('never-print-secret-origin');
      if (['missing-origin', 'malformed-origin', 'origin-error'].includes(hold))
        expect(fixture.context.logWarn).toHaveBeenCalledWith(expect.stringContaining('popup Reload'));
    });

  it.each(['profile-id', 'mode', 'root', 'epoch', 'fingerprint', 'unpause', 'quit'] as const)
    ('fences manual reload when %s changes during the encrypted origin read', async change => {
      const fixture = await companionReloadFixture(true); fixture.ready();
      fixture.config.ui.automationPaused = true; fixture.status.paired = false;
      const fingerprint = 'a'.repeat(64); await fixture.start(fingerprint);
      let release!: () => void;
      fixture.secret.mockImplementationOnce(() => new Promise<string>(resolve => {
        release = () => resolve('chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip');
      }));
      fixture.control(manualReloadArgs(fingerprint));
      await vi.waitFor(() => expect(fixture.secret).toHaveBeenCalledOnce());
      if (change === 'profile-id') fixture.runtime.profile.id = 'profile-Epsilon';
      else if (change === 'mode') fixture.runtime.profile.state.mode = 'legacy';
      else if (change === 'root') fixture.runtime.stateRoot = 'other-runtime';
      else if (change === 'epoch') fixture.config.tunnel.profileEpoch += 1;
      else if (change === 'fingerprint') await fixture.start('b'.repeat(64));
      else if (change === 'unpause') fixture.config.ui.automationPaused = false;
      else fixture.context.quitting = true;
      release(); await fixture.settle();
      expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.write).not.toHaveBeenCalled();
      expect(fixture.resume).not.toHaveBeenCalled();
    });

  it('spends manual native dispatch before an uncertain failure and never retries or logs its origin', async () => {
    const fixture = await companionReloadFixture(true); fixture.ready();
    fixture.config.ui.automationPaused = true; fixture.status.paired = false;
    const fingerprint = 'a'.repeat(64); await fixture.start(fingerprint);
    fixture.open.mockRejectedValueOnce(new Error('Native failure chrome-extension://never-print-secret-origin'));
    fixture.control(manualReloadArgs(fingerprint)); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledOnce(); expect(fixture.pending()?.dispatched).toBe(true);
    fixture.control(manualReloadArgs(fingerprint)); fixture.changed(); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledOnce(); expect(fixture.write).not.toHaveBeenCalled();
    expect(fixture.config.ui.automationPaused).toBe(true); expect(fixture.resume).not.toHaveBeenCalled();
    expect(JSON.stringify([...fixture.context.logInfo.mock.calls, ...fixture.context.logWarn.mock.calls]))
      .not.toContain('never-print-secret-origin');
  });
  it('keeps changed companion bytes pending while an exact human-authorized warm deferral resumes automation', async () => {
    const fixture = await companionReloadFixture(true);
    const fingerprint = 'a'.repeat(64);
    fixture.config.ui.automationPaused = true;
    fixture.ready();
    await fixture.start(fingerprint);
    const pending = fixture.pending();
    fixture.control(['app.exe', '--background', '--resume-automation',
      '--cos-instance-runtime=profile-Delta', '--defer-companion-reload=profile-Delta',
      '--defer-companion-reload-pid=19', '--defer-companion-reload-generation=1700000000019',
      '--defer-companion-reload-epoch=3', `--defer-companion-reload-fingerprint=${fingerprint}`]);
    await fixture.settle();
    expect(fixture.resume).toHaveBeenCalledOnce();
    expect(fixture.config.ui.automationPaused).toBe(false);
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.write).not.toHaveBeenCalled();
    expect(fixture.pending()).toBe(pending);
    expect(fixture.pending()?.fingerprint).toBe(fingerprint);
    expect(fixture.pending()?.deferredForProcess).toBe(true);
    expect(fixture.listeners.size).toBe(1);
    fixture.changed(); await fixture.settle();
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it.each(['profile', 'pid', 'generation', 'epoch', 'fingerprint', 'selector', 'missing', 'duplicate',
    'unknown-option', 'updated', 'pause', 'shutdown', 'quit', 'input', 'cancel', 'retry', 'settings',
    'connection', 'creation', 'folders', 'helper', 'alerts'] as const)
    ('refuses %s deferral without resuming, opening or writing a requested fingerprint', async change => {
      const fixture = await companionReloadFixture(true);
      const fingerprint = 'a'.repeat(64);
      fixture.config.ui.automationPaused = true; fixture.ready();
      await fixture.start(fingerprint);
      const pending = fixture.pending();
      let args = [...deferralArgs(fingerprint), '--resume-automation'];
      if (change === 'profile') args = args.map(arg => arg === '--defer-companion-reload=profile-Delta' ? '--defer-companion-reload=profile-Epsilon' : arg);
      else if (change === 'pid') args = args.map(arg => arg === '--defer-companion-reload-pid=19' ? '--defer-companion-reload-pid=20' : arg);
      else if (change === 'generation') args = args.map(arg => arg.startsWith('--defer-companion-reload-generation=') ? '--defer-companion-reload-generation=1700000000020' : arg);
      else if (change === 'epoch') args = args.map(arg => arg === '--defer-companion-reload-epoch=3' ? '--defer-companion-reload-epoch=4' : arg);
      else if (change === 'fingerprint') args = args.map(arg => arg.startsWith('--defer-companion-reload-fingerprint=') ? `--defer-companion-reload-fingerprint=${'b'.repeat(64)}` : arg);
      else if (change === 'selector') args = args.map(arg => arg === '--cos-instance-runtime=profile-Delta' ? '--cos-instance-runtime=profile-Epsilon' : arg);
      else if (change === 'missing') args = args.filter(arg => arg !== '--defer-companion-reload-pid=19');
      else if (change === 'duplicate') args.push('--defer-companion-reload-pid=19');
      else if (change === 'unknown-option') args.push('--defer-companion-reload-other=never-print');
      else if (change === 'updated') args.push('--updated');
      else if (change === 'pause') args.push('--pause-automation');
      else if (change === 'shutdown') args.push('--safe-close-for-update=profile-Delta');
      else if (change === 'input') args.push('--cos-enqueue-input=3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      else if (change === 'cancel') args.push('--cos-cancel-queued-input=3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      else if (change === 'retry') args.push('--cos-retry-queued-input=3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--cos-retry-queued-input-receipt=4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      else if (change === 'settings') args.push('--cos-settings-action=read');
      else if (change === 'connection') args.push('--cos-connection-action=status');
      else if (change === 'creation') args.push('--cos-create-profile=Another', '--cos-profile-browser=Profile 11');
      else if (change === 'folders') args.push('--cos-shared-accounts=enable');
      else if (change === 'helper') args.push('--set-helper-reasoning=high', '--helper-settings-profile=profile-Delta');
      else if (change === 'alerts') args.push('--enable-signout-emergency-alerts');
      else fixture.context.quitting = true;
      fixture.control(args); await fixture.settle();
      expect(fixture.resume).not.toHaveBeenCalled();
      expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.write).not.toHaveBeenCalled();
      expect(fixture.pending()).toBe(pending);
      expect(fixture.pending()?.deferredForProcess).toBe(false);
      expect(fixture.context.logWarn).toHaveBeenCalledWith(expect.stringContaining('arguments rejected'));
      expect(JSON.stringify(fixture.context.logWarn.mock.calls)).not.toContain('never-print');
    });

  it.each(['profile-id', 'mode', 'root', 'epoch', 'pending-generation'] as const)
    ('does not resume an obsolete deferred control after its %s owner changes while queued', async change => {
      const fixture = await companionReloadFixture(true);
      fixture.config.ui.automationPaused = true;
      const fingerprint = 'a'.repeat(64);
      await fixture.start(fingerprint);
      fixture.control([...deferralArgs(fingerprint), '--resume-automation']);
      expect(fixture.pending()?.deferredForProcess).toBe(true);
      if (change === 'profile-id') fixture.runtime.profile.id = 'profile-Epsilon';
      else if (change === 'mode') fixture.runtime.profile.state.mode = 'legacy';
      else if (change === 'root') fixture.runtime.stateRoot = 'different-runtime';
      else if (change === 'epoch') fixture.config.tunnel.profileEpoch += 1;
      else await vm.runInContext(`armPendingCompanionReload("${'b'.repeat(64)}")`, fixture.context);
      fixture.ready(); await fixture.settle();
      expect(fixture.resume).not.toHaveBeenCalled();
      expect(fixture.config.ui.automationPaused).toBe(true);
      expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.write).not.toHaveBeenCalled();
    });

  it.each(['profile-id', 'epoch', 'fingerprint'] as const)
    ('does not release a replacement %s owner while the actual pause-publication resume is awaiting', async change => {
      const fixture = await companionReloadFixture(true);
      fixture.config.ui.automationPaused = true; fixture.ready();
      const fingerprint = 'a'.repeat(64); await fixture.start(fingerprint);
      const ipc = await readFile(path.join(repo, 'src/main/ipc.ts'), 'utf8');
      const start = ipc.indexOf('export async function resumeAutomationAfterExplicitRequest');
      const end = ipc.indexOf('/** Explicit account reset:', start);
      expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
      let release!: () => void, arrived!: () => void;
      const publication = new Promise<void>(resolve => { release = resolve; });
      const publishing = new Promise<void>(resolve => { arrived = resolve; });
      fixture.context.updateConfig = vi.fn(async update => {
        arrived(); await publication;
        const next = await update(fixture.config);
        fixture.config.ui.automationPaused = next.ui.automationPaused;
        return fixture.config;
      });
      const admission = vi.fn(() => fixture.changed());
      const chats = vi.fn(async () => ({ queued: 0, alreadyActive: 0, recovering: 0 }));
      fixture.context.applyAutomationPause = admission;
      fixture.context.resumeAutomationChats = chats;
      vm.runInContext(stripTypeScriptTypes(ipc.slice(start, end)).replace('export async function resumeAutomationAfterExplicitRequest',
        'async function actualResumeOwner'), fixture.context);
      fixture.resume.mockImplementation(async (trigger: string, ownerCurrent?: () => boolean) => {
        fixture.context.resumeTrigger = trigger; fixture.context.ownerCurrent = ownerCurrent;
        return vm.runInContext('actualResumeOwner(resumeTrigger, ownerCurrent)', fixture.context);
      });
      fixture.control([...deferralArgs(fingerprint), '--resume-automation']);
      await publishing;
      if (change === 'profile-id') fixture.runtime.profile.id = 'profile-Epsilon';
      else if (change === 'epoch') fixture.config.tunnel.profileEpoch += 1;
      else await fixture.start('b'.repeat(64));
      release(); await fixture.settle();
      expect(fixture.config.ui.automationPaused).toBe(true);
      expect(admission).not.toHaveBeenCalled(); expect(chats).not.toHaveBeenCalled();
      expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.write).not.toHaveBeenCalled();
      expect(fixture.context.logWarn).toHaveBeenCalledWith(expect.stringContaining('control failed'));
    });

  it.each(['origin', 'presence', 'before-dispatch'] as const)
    ('honors exact deferral arriving at the awaited %s boundary', async boundary => {
      const fixture = await companionReloadFixture(true);
      const fingerprint = 'a'.repeat(64);
      let release!: () => void;
      if (boundary === 'origin') fixture.secret.mockImplementationOnce(() => new Promise<string>(resolve => {
        release = () => resolve('chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip');
      }));
      else if (boundary === 'presence') fixture.bridge.mockImplementationOnce(() => new Promise<typeof fixture.status>(resolve => {
        release = () => resolve({ ...fixture.status });
      }));
      else {
        fixture.context.deferralArgs = deferralArgs(fingerprint);
        vm.runInContext(`const originalEligibility = companionReloadEligible;
          companionReloadEligible = async state => {
            const eligible = await originalEligibility(state);
            acceptExplicitAutomationControlArgs(deferralArgs);
            return eligible;
          };`, fixture.context);
      }
      const starting = fixture.start(fingerprint);
      if (boundary !== 'before-dispatch') {
        await vi.waitFor(() => expect(boundary === 'origin' ? fixture.secret : fixture.bridge).toHaveBeenCalledOnce());
        fixture.control(deferralArgs(fingerprint)); release();
      }
      await starting; await fixture.settle();
      expect(fixture.pending()?.deferredForProcess).toBe(true);
      expect(fixture.pending()?.dispatched).toBe(false);
      expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.write).not.toHaveBeenCalled();
      expect(fixture.resume).not.toHaveBeenCalled();
    });

  it('refuses to defer a native reload already dispatched and never repeats it', async () => {
    const fixture = await companionReloadFixture(true);
    const fingerprint = 'a'.repeat(64); fixture.ready();
    fixture.open.mockRejectedValueOnce(new Error('Native launch receipt uncertain'));
    await fixture.start(fingerprint); await fixture.settle();
    const pending = fixture.pending();
    expect(pending?.dispatched).toBe(true);
    fixture.control([...deferralArgs(fingerprint), '--resume-automation']); await fixture.settle();
    expect(fixture.resume).not.toHaveBeenCalled();
    expect(fixture.pending()).toBe(pending); expect(pending?.deferredForProcess).toBe(false);
    fixture.changed(); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledOnce(); expect(fixture.write).not.toHaveBeenCalled();
  });

  it.each(['new-process', 'new-fingerprint', 'new-epoch'] as const)
    ('restores normal reload safety for a %s instead of persisting deferral', async replacement => {
      const fixture = await companionReloadFixture(true);
      const fingerprint = 'a'.repeat(64);
      fixture.config.ui.automationPaused = true; await fixture.start(fingerprint);
      const old = fixture.pending(); fixture.control(deferralArgs(fingerprint));
      expect(old?.deferredForProcess).toBe(true);
      expect(fixture.write).not.toHaveBeenCalled();
      if (replacement === 'new-process') {
        const restarted = await companionReloadFixture(true);
        await restarted.start(fingerprint); await restarted.settle();
        expect(restarted.open).toHaveBeenCalledOnce(); expect(restarted.write).toHaveBeenCalledOnce();
        return;
      }
      fixture.config.ui.automationPaused = false;
      if (replacement === 'new-epoch') fixture.config.tunnel.profileEpoch += 1;
      await fixture.start(replacement === 'new-fingerprint' ? 'b'.repeat(64) : fingerprint);
      await fixture.settle();
      expect(fixture.open).toHaveBeenCalledOnce(); expect(fixture.write).toHaveBeenCalledOnce();
      expect(old?.dispatched).toBe(false); expect(fixture.pending()).toBeNull();
    });

  it.each(['deferral', 'manual'] as const)('rejects %s on cold launch before any runtime is started', async action => {
    const source = await readFile(path.join(repo, 'src/main/index.ts'), 'utf8');
    const start = source.indexOf("} else if (process.argv.some(argument => argument.startsWith('--defer-companion-reload')");
    const end = source.indexOf('} else if (safeCloseForUpdateAttempted(process.argv))', start);
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    const quit = vi.fn(), error = vi.fn();
    const context = vm.createContext({ process: { argv: action === 'manual' ? manualReloadArgs() : deferralArgs() }, app: { quit }, console: { error }, quitting: false });
    vm.runInContext(`if (false) { ${source.slice(start, end)} }`, context);
    expect(quit).toHaveBeenCalledOnce(); expect(context.quitting).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('No runtime was started'));
  });

  it.each(['deferral', 'manual'] as const)('consumes warm %s before transported input, maintenance and window activation', async action => {
    const fixture = await companionReloadFixture(true);
    fixture.config.ui.automationPaused = true; fixture.ready();
    const fingerprint = 'a'.repeat(64); await fixture.start(fingerprint);
    const source = await readFile(path.join(repo, 'src/main/index.ts'), 'utf8');
    const start = source.indexOf("app.on('second-instance'");
    const handler = source.slice(start, source.indexOf('\n});', start) + 4);
    let received!: (event: unknown, args: string[], cwd: string, data: unknown) => void;
    fixture.context.app.on = (_event: string, callback: typeof received) => { received = callback; };
    const registration = vi.fn(() => ['--cos-enqueue-input=3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
    const input = vi.fn(), close = vi.fn(() => false), focus = vi.fn();
    Object.assign(fixture.context, { operatorProfileCreationSecondInstanceArgs: registration,
      acceptOperatorInputArgs: input, safeCloseForUpdate: { accept: close },
      windowActivation: { request: focus }, isBackgroundLaunch: (args: string[]) => args.includes('--background') });
    vm.runInContext(handler, fixture.context);
    const args = action === 'manual' ? manualReloadArgs(fingerprint) : [...deferralArgs(fingerprint), '--resume-automation'];
    for (const payload of [
      operatorProfileCreationAdditionalData(['app.exe', '--cos-create-profile=Another', '--cos-profile-browser=Profile 11']),
      { cosSettingsControl: { version: 1, request: { action: 'update' } } },
      { cosInput: { id: '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }, ['malformed'], 'malformed'
    ]) received({}, args, 'C:/', payload);
    await fixture.settle();
    expect(fixture.resume).not.toHaveBeenCalled(); expect(fixture.pending()?.deferredForProcess).toBe(false);
    expect(registration).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    received({}, args, 'C:/', {});
    await fixture.settle();
    if (action === 'manual') expect(fixture.resume).not.toHaveBeenCalled();
    else expect(fixture.resume).toHaveBeenCalledOnce();
    expect(registration).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    if (action === 'manual') {
      expect(fixture.pending()?.dispatched).toBe(true);
      expect(fixture.pending()?.deferredForProcess).toBe(false);
      expect(fixture.open).toHaveBeenCalledOnce();
      expect(fixture.config.ui.automationPaused).toBe(true);
    } else {
      expect(fixture.pending()?.deferredForProcess).toBe(true);
      expect(fixture.open).not.toHaveBeenCalled();
    }
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it.each(['paused', 'unpaired', 'absent', 'signed-out', 'unknown-auth'] as const)
    ('retains the pending fingerprint without opening a cached origin while %s', async (hold) => {
      const fixture = await companionReloadFixture();
      if (hold === 'paused') fixture.config.ui.automationPaused = true;
      else if (hold === 'unpaired') fixture.status.paired = false;
      else if (hold === 'absent') fixture.status.present = false;
      else fixture.status.authState = hold === 'signed-out' ? 'signed-out' : 'unknown';
      await fixture.start(); await fixture.settle();
      expect(fixture.open).not.toHaveBeenCalled();
      expect(fixture.write).not.toHaveBeenCalled();
      expect(fixture.pending()?.fingerprint).toBe('new-fingerprint');
    });

  it('uses the same pending owner after a positive paired bridge change and activates once', async () => {
    const fixture = await companionReloadFixture();
    fixture.config.ui.automationPaused = true;
    await fixture.start(); await fixture.settle();
    const pending = fixture.pending();
    expect(pending?.fingerprint).toBe('new-fingerprint');
    fixture.config.ui.automationPaused = false;
    fixture.changed(); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.write).toHaveBeenCalledWith('companion-fingerprint', 'new-fingerprint');
    expect(fixture.pending()).toBeNull();
    expect(fixture.listeners.size).toBe(0);
    fixture.changed(); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledTimes(1);
  });

  it('allows the normal paired unpaused path and skips an already activated ordinary startup', async () => {
    const fixture = await companionReloadFixture();
    await fixture.start(); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.write).toHaveBeenCalledTimes(1);
    fixture.read.mockResolvedValue('new-fingerprint');
    await fixture.start(); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.pending()).toBeNull();
  });

  it.each(['pause', 'withdraw-pair', 'profile-epoch', 'profile-id', 'quit'] as const)
    ('does not open or spend a fingerprint after %s during the origin read', async (change) => {
      const fixture = await companionReloadFixture();
      let release!: (origin: string) => void;
      fixture.secret.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
      const starting = fixture.start();
      await vi.waitFor(() => expect(fixture.secret).toHaveBeenCalledTimes(1));
      if (change === 'pause') fixture.config.ui.automationPaused = true;
      else if (change === 'withdraw-pair') fixture.status.paired = false;
      else if (change === 'profile-epoch') fixture.config.tunnel.profileEpoch += 1;
      else if (change === 'profile-id') fixture.runtime.profile.id = 'profile-Epsilon';
      else fixture.context.quitting = true;
      release('chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip');
      await starting; await fixture.settle();
      expect(fixture.open).not.toHaveBeenCalled();
      expect(fixture.write).not.toHaveBeenCalled();
    });

  it('records one requested reload when that reload itself disconnects the companion', async () => {
    const fixture = await companionReloadFixture();
    let release!: () => void;
    fixture.open.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const starting = fixture.start();
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(1));
    fixture.status.paired = false;
    release(); await starting; await fixture.settle();
    expect(fixture.write).toHaveBeenCalledWith('companion-fingerprint', 'new-fingerprint');
    expect(fixture.pending()).toBeNull();
    fixture.status.paired = true;
    fixture.changed(); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledTimes(1);
  });

  it('does not reload again if presence drops while the requested fingerprint is persisted', async () => {
    const fixture = await companionReloadFixture();
    fixture.write.mockImplementationOnce(async () => { fixture.status.present = false; fixture.status.authState = 'unknown'; });
    await fixture.start(); await fixture.settle();
    expect(fixture.pending()).toBeNull();
    fixture.status.present = true; fixture.status.authState = 'signed-in';
    fixture.changed(); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.write).toHaveBeenCalledTimes(1);
  });

  it.each(['open', 'write'] as const)('never repeats a dispatched reload after an uncertain %s failure', async (failure) => {
    const fixture = await companionReloadFixture();
    if (failure === 'open') fixture.open.mockRejectedValueOnce(new Error('Browser launch may already have been dispatched'));
    else fixture.write.mockRejectedValueOnce(new Error('Activation receipt write failed'));
    await fixture.start(); await fixture.settle();
    expect(fixture.pending()?.dispatched).toBe(true);
    fixture.changed(); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.write).toHaveBeenCalledTimes(failure === 'open' ? 0 : 1);
  });

  it('allows an explicit same-fingerprint rearm for a changed profile epoch without reviving the old owner', async () => {
    const fixture = await companionReloadFixture();
    fixture.config.ui.automationPaused = true;
    await fixture.start(); await fixture.settle();
    const old = fixture.pending();
    fixture.config.tunnel.profileEpoch += 1;
    fixture.config.ui.automationPaused = false;
    fixture.changed(); await fixture.settle();
    expect(fixture.open).not.toHaveBeenCalled();
    await vm.runInContext('armPendingCompanionReload("new-fingerprint")', fixture.context);
    await fixture.settle();
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.pending()).toBeNull();
    expect(old?.dispatched).toBe(false);
  });

  it('retains a dispatched owner without reopening after pause arrives during the receipt write', async () => {
    const fixture = await companionReloadFixture();
    let release!: () => void;
    fixture.write.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
    const starting = fixture.start();
    await vi.waitFor(() => expect(fixture.write).toHaveBeenCalledTimes(1));
    fixture.config.ui.automationPaused = true;
    release(); await starting; await fixture.settle();
    expect(fixture.pending()?.dispatched).toBe(true);
    expect(fixture.context.logWarn).toHaveBeenCalledWith(expect.stringContaining('No automatic replay will occur'));
    fixture.config.ui.automationPaused = false;
    fixture.changed(); await fixture.settle();
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.write).toHaveBeenCalledTimes(1);
  });

  it('never rearms an already dispatched fingerprint just because the profile epoch changes', async () => {
    const fixture = await companionReloadFixture();
    fixture.open.mockRejectedValueOnce(new Error('Issued request has no trustworthy acknowledgement'));
    await fixture.start(); await fixture.settle();
    const dispatched = fixture.pending();
    expect(dispatched?.dispatched).toBe(true);
    fixture.config.tunnel.profileEpoch += 1;
    await vm.runInContext('armPendingCompanionReload("new-fingerprint")', fixture.context);
    fixture.changed(); await fixture.settle();
    expect(fixture.pending()).toBe(dispatched);
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it('cannot clear or activate a replaced pending generation when its old origin read resolves', async () => {
    const fixture = await companionReloadFixture();
    let release!: (origin: string) => void;
    fixture.secret.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const starting = fixture.start();
    await vi.waitFor(() => expect(fixture.secret).toHaveBeenCalledTimes(1));
    vm.runInContext('armPendingCompanionReload("replacement-fingerprint")', fixture.context);
    await fixture.settle();
    release('chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip');
    await starting; await fixture.settle();
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.write.mock.calls).toEqual([['companion-fingerprint', 'replacement-fingerprint']]);
    expect(fixture.pending()).toBeNull();
  });
});

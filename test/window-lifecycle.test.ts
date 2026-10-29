import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import {
  operatorSettingsControlRequest, operatorConnectionControlRequest, operatorSharedAccountSettingsRequest,
  operatorProfileCreationRequest, operatorProfileBrowserBindingRequest, operatorProfileRenameRequest, operatorProfileCreationAdditionalData,
  operatorProfileCreationSecondInstanceArgs, processOperatorProfileCreation, processOperatorProfileBrowserBinding, processOperatorProfileRename,
  operatorSessionInspectionRequest
} from '../src/main/operator-input.js';
import {
  accountWindowTitle,
  applyLoginStartup,
  coldSafeCloseForUpdateProfileId,
  createSafeCloseForUpdateGate,
  isBackgroundLaunch,
  safeCloseForUpdateAttempted,
  safeCloseForUpdateExpectedGeneration,
  safeCloseForUpdateExpectedPid,
  safeCloseForUpdateProfileId,
  supportsLoginStartup,
  createWindowActivationGate,
  ownsAppRuntime,
  registerNativeWindowActivation,
  signOutEmergencyAlertSettingRequest,
  shouldBeginAppBootstrap,
  shouldQuitOnWindowAllClosed
} from '../src/main/window-lifecycle.js';
import { helperReasoningSettingsRequest } from '../src/main/window-lifecycle.js';
import * as lifecycleExports from '../src/main/window-lifecycle.js';
import { ProfileLifecycleCoordinator } from '../src/main/profile-lifecycle.js';
import { WorkAdmissionGate } from '../src/main/work-admission.js';

describe('safe-close lifecycle operator controls', () => {
  it('projects headless companion activation with an allowlist and no loaded-generation promotion', async () => {
    const f = controlsFixture();
    await f.owner.requestShutdown();
    await f.gate.enable('profile-foot', () => f.owner.requestShutdown(), { ...f.callbacks,
      companionStatus: () => ({ startupPublishedFingerprint: 'a'.repeat(64), requestFingerprint: 'PRIVATE_DRAFT',
        requestState: 'deferred-for-process', executingGeneration: 'verified', privatePath: 'PRIVATE_DRAFT' }) });
    f.gate.accept([...base.slice(0, 2), ...base.slice(3), '--safe-close-for-update-status=profile-foot']);
    const line = f.info.mock.calls.find(([line]) => line.includes('lifecycle snapshot '))![0];
    expect(JSON.parse(line.split('lifecycle snapshot ')[1]!).companionActivation).toEqual({
      startupPublishedFingerprint: 'a'.repeat(64), requestFingerprint: null, requestState: 'deferred-for-process',
      executingGeneration: 'unverified' });
    expect(line).not.toContain('PRIVATE_DRAFT');
    expect(f.shutdown).not.toHaveBeenCalled();
  });

  it('keeps lifecycle status available when companion activation diagnostics fail', async () => {
    const f = controlsFixture();
    await f.gate.enable('profile-foot', () => f.owner.requestShutdown(), { ...f.callbacks,
      companionStatus: () => { throw new Error('PRIVATE_DRAFT'); } });
    f.gate.accept([...base.slice(0, 2), ...base.slice(3), '--safe-close-for-update-status=profile-foot']);
    const line = f.info.mock.calls.find(([line]) => line.includes('lifecycle snapshot '))![0];
    const snapshot = JSON.parse(line.split('lifecycle snapshot ')[1]!);
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.companionActivation).toMatchObject({ requestState: 'unavailable', executingGeneration: 'unverified' });
    expect(line).not.toContain('PRIVATE_DRAFT');
    expect(f.census).not.toHaveBeenCalled();
  });

  const base = ['app.exe', '--cos-instance-runtime=profile-foot', '--safe-close-for-update=profile-foot',
    '--safe-close-for-update-pid=4242', '--safe-close-for-update-generation=1700000000424'];
  function controlsFixture() {
    let blockers = [{ category: 'provider-turn', count: 1, detail: 'PRIVATE_DRAFT' }];
    let id = 0;
    const admission = new WorkAdmissionGate();
    const shutdown = vi.fn(async () => undefined);
    const census = vi.fn(async () => ({ profileId: 'profile-foot', blockers }));
    const owner = new ProfileLifecycleCoordinator({ profileId: 'profile-foot', admission, census,
      readDeferredSwitch: async () => null, writeDeferredSwitch: async () => undefined,
      onSwitchReady: async () => undefined, applyUpdate: async () => undefined, applyShutdown: shutdown,
      idFactory: () => `transition-${++id}` });
    const info = vi.fn(), warn = vi.fn();
    const gate = createSafeCloseForUpdateGate({ info, warn, runningProcessId: 4242,
      runningProcessGeneration: 1700000000424 });
    const callbacks = { status: () => owner.getStatus(), cancel: (transition: string) => owner.cancelDrain(transition) };
    return { owner, gate, info, warn, shutdown, census, admission, callbacks,
      settle: () => { blockers = []; } };
  }

  it('reads bounded status without polling or finalizing work, then cancels the exact Drain', async () => {
    const f = controlsFixture();
    await f.owner.requestShutdown();
    const transition = f.owner.getStatus().transitionId!;
    await f.gate.enable('profile-foot', () => f.owner.requestShutdown(), f.callbacks);
    const censusCalls = f.census.mock.calls.length;
    f.settle();
    f.gate.accept([...base.slice(0, 2), ...base.slice(3), '--safe-close-for-update-status=profile-foot']);
    await vi.waitFor(() => expect(f.info).toHaveBeenCalledWith(expect.stringContaining('lifecycle snapshot ')));
    const snapshot = JSON.parse(f.info.mock.calls.find(([line]) => line.includes('lifecycle snapshot '))![0].split('lifecycle snapshot ')[1]!);
    expect(snapshot).toMatchObject({ profileId: 'profile-foot', pid: 4242, generation: 1700000000424,
      action: 'status', phase: 'draining-shutdown', transitionId: transition,
      admission: { mode: 'draining', owner: transition }, blockers: [{ category: 'provider-turn', count: 1 }] });
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_DRAFT');
    expect(f.census).toHaveBeenCalledTimes(censusCalls);
    expect(f.shutdown).not.toHaveBeenCalled();
    f.gate.accept([...base.slice(0, 2), ...base.slice(3), '--safe-close-for-update-cancel=profile-foot', `--safe-close-for-update-transition=${transition}`]);
    await vi.waitFor(() => expect(f.owner.getStatus().phase).toBe('idle'));
    expect(f.admission.snapshot()).toMatchObject({ mode: 'open', owner: null });
    expect(f.shutdown).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.info.mock.calls.some(([line]) => {
      if (!line.includes('lifecycle snapshot ')) return false;
      const snapshot = JSON.parse(line.split('lifecycle snapshot ')[1]!);
      return snapshot.action === 'cancel' && snapshot.requestedTransitionId === transition &&
        snapshot.phase === 'idle' && snapshot.admission.mode === 'open';
    })).toBe(true));
  });

  it('bounds status logs and excludes blocker detail while retaining the aggregate count', async () => {
    const f = controlsFixture();
    f.census.mockResolvedValue({ profileId: 'profile-foot', blockers: Array.from({ length: 40 }, (_, i) => ({
      category: `tool-${i}`, count: 2, detail: 'PRIVATE_DRAFT' })) });
    await f.owner.requestShutdown();
    await f.gate.enable('profile-foot', () => f.owner.requestShutdown(), f.callbacks);
    f.gate.accept([...base.slice(0, 2), ...base.slice(3), '--safe-close-for-update-status=profile-foot']);
    const line = f.info.mock.calls.find(([line]) => line.includes('lifecycle snapshot '))![0];
    const snapshot = JSON.parse(line.split('lifecycle snapshot ')[1]!);
    expect(snapshot.blockers).toHaveLength(24);
    expect(snapshot.blockerCount).toBe(80);
    expect(line).not.toContain('PRIVATE_DRAFT');
    expect(f.shutdown).not.toHaveBeenCalled();
  });

  it.each(['wrong-pid', 'wrong-generation', 'wrong-profile', 'wrong-selector', 'missing-selector',
    'missing-transition', 'stale-transition', 'mixed', 'unknown'])
    ('refuses %s without reopening admission or calling shutdown', async reason => {
      const f = controlsFixture();
      await f.owner.requestShutdown();
      await f.gate.enable('profile-foot', () => f.owner.requestShutdown(), f.callbacks);
      let args = [...base.slice(0, 2), ...base.slice(3), '--safe-close-for-update-cancel=profile-foot',
        `--safe-close-for-update-transition=${f.owner.getStatus().transitionId}`];
      if (reason === 'wrong-pid') args = args.map(value => value.replace('-pid=4242', '-pid=4243'));
      if (reason === 'wrong-generation') args = args.map(value => value.replace('generation=1700000000424', 'generation=1700000000423'));
      if (reason === 'wrong-profile') args = args.map(value => value.replace('profile-foot', 'profile-other'));
      if (reason === 'wrong-selector') args = args.map(value => value === '--cos-instance-runtime=profile-foot' ? '--cos-instance-runtime=profile-other' : value);
      if (reason === 'missing-selector') args = args.filter(value => !value.startsWith('--cos-instance-runtime='));
      if (reason === 'missing-transition') args = args.filter(value => !value.startsWith('--safe-close-for-update-transition='));
      if (reason === 'stale-transition') args = args.map(value => value.replace('transition=transition-1', 'transition=transition-old'));
      if (reason === 'mixed') args.push('--cos-settings-action=update');
      if (reason === 'unknown') args.push('--safe-close-for-update-force=1');
      f.gate.accept(args);
      await vi.waitFor(() => expect(f.warn).toHaveBeenCalled());
      expect(f.owner.getStatus().phase).toBe('draining-shutdown');
      expect(f.admission.snapshot().mode).toBe('draining');
      expect(f.shutdown).not.toHaveBeenCalled();
    });

  it('keeps status synchronous while a census and exact cancellation are waiting', async () => {
    const f = controlsFixture();
    await f.owner.requestShutdown();
    await f.gate.enable('profile-foot', () => f.owner.requestShutdown(), f.callbacks);
    const transition = f.owner.getStatus().transitionId!;
    let release!: (value: { profileId: string; blockers: Array<{ category: string; count: number; detail: string }> }) => void;
    f.census.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const polling = f.owner.poll();
    await vi.waitFor(() => expect(release).toBeDefined());
    try {
      f.gate.accept([...base.slice(0, 2), ...base.slice(3), '--safe-close-for-update-cancel=profile-foot', `--safe-close-for-update-transition=${transition}`]);
      f.info.mockClear();
      f.gate.accept([...base.slice(0, 2), ...base.slice(3), '--safe-close-for-update-status=profile-foot']);
      expect(f.info).toHaveBeenCalledWith(expect.stringContaining('lifecycle snapshot '));
      expect(f.admission.snapshot().mode).toBe('draining');
      expect(f.shutdown).not.toHaveBeenCalled();
    } finally { release({ profileId: 'profile-foot', blockers: [{ category: 'provider-turn', count: 1, detail: 'PRIVATE_DRAFT' }] }); }
    await polling;
    await vi.waitFor(() => expect(f.admission.snapshot().mode).toBe('open'));
    expect(f.shutdown).not.toHaveBeenCalled();
  });

  it('fails closed when a running old gate has no status/cancel callbacks', async () => {
    const f = controlsFixture();
    await f.gate.enable('profile-foot', () => f.owner.requestShutdown());
    f.gate.accept([...base.slice(0, 2), ...base.slice(3), '--safe-close-for-update-status=profile-foot']);
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
    expect(f.census).not.toHaveBeenCalled();
    expect(f.shutdown).not.toHaveBeenCalled();
  });

  it('refuses cancel after finalization and refuses status/cancel on a cold launch', async () => {
    const f = controlsFixture();
    f.settle();
    await f.owner.requestShutdown();
    await f.gate.enable('profile-foot', () => f.owner.requestShutdown(), f.callbacks);
    const args = [...base.slice(0, 2), ...base.slice(3), '--safe-close-for-update-cancel=profile-foot', `--safe-close-for-update-transition=${f.owner.getStatus().transitionId}`];
    f.gate.accept(args);
    await vi.waitFor(() => expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('finalization')));
    expect(f.admission.snapshot().mode).toBe('finalizing');
    expect(f.shutdown).toHaveBeenCalledOnce();
    expect(() => coldSafeCloseForUpdateProfileId(args, 'profile-foot')).toThrow('already-running');
    expect(() => coldSafeCloseForUpdateProfileId([...base.slice(0, 2), ...base.slice(3), '--safe-close-for-update-status=profile-foot'], 'profile-foot')).toThrow('already-running');
  });
});

it('identifies the owning account in the native window title', () => {
  expect(accountWindowTitle({ id: 'profile-Primary', displayName: 'Primary', accountLabel: 'Primary' }))
    .toBe('Primary · Chat On Steroids');
  expect(accountWindowTitle({ id: 'profile-fallback', displayName: 'Fallback', accountLabel: '' }))
    .toBe('Fallback · Chat On Steroids');
});

it('requires one exact account and effort for an explicit local helper settings change', () => {
  expect(helperReasoningSettingsRequest(['app.exe'])).toBeNull();
  expect(() => helperReasoningSettingsRequest(['--retire-recorded-chats'])).toThrow();
  expect(helperReasoningSettingsRequest(['--set-helper-reasoning=high', '--helper-settings-profile=local-instance', '--retire-recorded-chats']))
    .toEqual({ profileId: 'local-instance', reasoning: 'high', retireChats: true });
  expect(helperReasoningSettingsRequest(['--set-helper-reasoning=high', '--helper-settings-profile=local-instance', '--set-chat-default-model=gpt-6-thinking']))
    .toEqual({ profileId: 'local-instance', reasoning: 'high', model: 'gpt-6-thinking' });
  expect(() => helperReasoningSettingsRequest(['--set-chat-default-model=gpt-6-thinking'])).toThrow();
  expect(() => helperReasoningSettingsRequest(['--set-helper-reasoning=high', '--helper-settings-profile=local-instance', '--set-chat-default-model=../bad'])).toThrow();
  expect(helperReasoningSettingsRequest(['app.exe', '--set-helper-reasoning=high', '--helper-settings-profile=local-instance']))
    .toEqual({ profileId: 'local-instance', reasoning: 'high' });
  for (const args of [
    ['--set-helper-reasoning=high'], ['--helper-settings-profile=local-instance'],
    ['--set-helper-reasoning=medium', '--set-helper-reasoning=high', '--helper-settings-profile=local-instance'],
    ['--set-helper-reasoning=automatic', '--helper-settings-profile=local-instance'],
    ['--set-helper-reasoning=high', '--helper-settings-profile=../../config'],
    ['--set-helper-reasoning=high', '--helper-settings-profile=local-instance', '--updated']
  ]) expect(() => helperReasoningSettingsRequest(['app.exe', ...args])).toThrow();
});

it('parses one exact per-account sign-out emergency preference control', () => {
  expect(signOutEmergencyAlertSettingRequest(['app.exe'])).toBeNull();
  expect(signOutEmergencyAlertSettingRequest(['app.exe', '--enable-signout-emergency-alerts'])).toBe(true);
  expect(signOutEmergencyAlertSettingRequest(['app.exe', '--disable-signout-emergency-alerts'])).toBe(false);
  expect(() => signOutEmergencyAlertSettingRequest([
    'app.exe', '--enable-signout-emergency-alerts', '--disable-signout-emergency-alerts'
  ])).toThrow(/exactly one enable or disable/i);
  expect(() => signOutEmergencyAlertSettingRequest([
    'app.exe', '--enable-signout-emergency-alerts', '--enable-signout-emergency-alerts'
  ])).toThrow(/exactly one enable or disable/i);
  expect(() => signOutEmergencyAlertSettingRequest([
    'app.exe', '--updated', '--enable-signout-emergency-alerts'
  ])).toThrow(/ordinary launch/i);
});

describe('native window activation', () => {
  it.each(['connected', 'offline', 'disconnected'])('identifies the current account in the tray tooltip and menu while %s', state => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('function refreshTray(): void {');
    const end = source.indexOf("app.on('second-instance'", start);
    const tooltip = vi.fn(), menu = vi.fn();
    const profile = { id: 'profile-garry', displayName: 'Garry', accountLabel: 'Garry DeSnell' };
    vm.runInNewContext(`${stripTypeScriptTypes(source.slice(start, end))}\nrefreshTray();`, {
      tray: { setImage: vi.fn(), setToolTip: tooltip, setContextMenu: menu },
      getStatus: () => ({ state }), getActiveInstanceRuntime: () => ({ profile }), accountWindowTitle,
      trayIcon: vi.fn(), Menu: { buildFromTemplate: (rows: unknown[]) => rows },
      windowActivation: { request: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(),
      app: { quit: vi.fn() }, quitting: false
    });
    expect(tooltip.mock.calls[0]?.[0]).toContain('Garry DeSnell');
    const rows = menu.mock.calls[0]?.[0];
    expect(rows[0]).toMatchObject({ label: 'Garry DeSnell · Chat On Steroids', enabled: false });
    expect(rows.find((row: { label?: string }) => row.label === 'Quit')).toBeDefined();
  });

  it('refuses a session inspection that wins the singleton before any bootstrap, recovery or window owner starts', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const hasSingleInstanceLock = app.requestSingleInstanceLock(startupProfileCreationData);');
    const end = source.indexOf('function createWindow(): void', start);
    const guard = stripTypeScriptTypes(source.slice(start, end));
    for (const id of ['local-instance', 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4']) {
      const argv = ['app.exe', '--cos-sessions-action=list', `--cos-sessions-profile=${id}`,
        '--cos-sessions-receipt=4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--cos-sessions-limit=20',
        ...(id.startsWith('profile-') ? [`--cos-instance-runtime=${id}`] : []), '--background'];
      const bootstrap = vi.fn(), error = vi.fn(), quit = vi.fn(), exit = vi.fn();
      vm.runInNewContext(`${guard}\nif (shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) bootstrap();`, {
        startupProfileCreationData: operatorProfileCreationAdditionalData(argv), process: { argv },
        app: { requestSingleInstanceLock: () => true, quit, exit }, quitting: false,
        operatorSessionInspectionRequest, safeCloseForUpdateAttempted, coldSafeCloseForUpdateProfileId,
        isolatedSelection: id.startsWith('profile-') ? { instanceId: id } : null,
        console: { error, info: vi.fn() }, shouldBeginAppBootstrap, bootstrap
      });
      expect(bootstrap).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('must already be running'));
      expect(quit).not.toHaveBeenCalled();
    }
    for (const ownsLock of [false, true]) {
      const bootstrap = vi.fn(), exit = vi.fn(), quit = vi.fn();
      vm.runInNewContext(`${guard}\nif (shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) bootstrap();`, {
        startupProfileCreationData: undefined, process: { argv: ['app.exe'] }, quitting: false,
        app: { requestSingleInstanceLock: () => ownsLock, quit, exit }, operatorSessionInspectionRequest,
        safeCloseForUpdateAttempted, coldSafeCloseForUpdateProfileId, isolatedSelection: null,
        console: { error: vi.fn(), info: vi.fn() }, shouldBeginAppBootstrap, bootstrap
      });
      expect(bootstrap).toHaveBeenCalledTimes(ownsLock ? 1 : 0);
      expect(quit).toHaveBeenCalledTimes(ownsLock ? 0 : 1); expect(exit).not.toHaveBeenCalled();
    }
    expect(end).toBeLessThan(source.indexOf('initConfigPath(userData'));
    expect(end).toBeLessThan(source.indexOf('await startQueuedWakeRetrySync();'));
    expect(end).toBeLessThan(source.indexOf('armBrowserStartupRecovery();'));
  });
  it('queues exact inspection before runtime readiness and invokes only the read-only owner after restore', async () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('let operatorInputRuntimeReady');
    const dispatcher = stripTypeScriptTypes(source.slice(start, source.indexOf('\n/**\n * An update restart', start)));
    const inspect = vi.fn(async () => ({ receipt: '4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', state: 'completed' }));
    const otherOwner = vi.fn(), logInfo = vi.fn(), logWarn = vi.fn();
    const context = vm.createContext({
      app: { getPath: () => 'C:/exact-account-runtime' }, logInfo, logWarn, quitting: false, shutdownStarted: false,
      operatorSessionInspectionRequest, operatorSettingsControlRequest, operatorConnectionControlRequest,
      operatorSharedAccountSettingsRequest, operatorProfileCreationRequest, operatorProfileBrowserBindingRequest, operatorProfileRenameRequest,
      operatorInputRequestIds: () => [], operatorInputCancellationIds: () => [], operatorInputRetryIds: () => [],
      operatorPluginRefreshRearmIds: () => [], processOperatorSessionInspection: inspect,
      processOperatorSettingsControl: otherOwner, processOperatorConnectionControl: otherOwner,
      configureSharedAccountSettings: otherOwner, processOperatorProfileCreation: otherOwner,
      processOperatorProfileBrowserBinding: otherOwner, processOperatorInputRequests: otherOwner,
      processOperatorInputCancellations: otherOwner, processOperatorInputRetries: otherOwner,
      processOperatorPluginRefreshRearms: otherOwner, connect: otherOwner,
      args: ['--cos-sessions-action=controls', '--cos-sessions-profile=local-instance',
        '--cos-sessions-receipt=4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--cos-sessions-session=2026-10-13-839d5152', '--background']
    });
    vm.runInContext(dispatcher, context); vm.runInContext('acceptOperatorInputArgs(args)', context);
    expect(inspect).not.toHaveBeenCalled(); expect(vm.runInContext('pendingOperatorInputArgv.length', context)).toBe(1);
    vm.runInContext('operatorInputRuntimeReady=true; for (const args of pendingOperatorInputArgv.splice(0)) acceptOperatorInputArgs(args);', context);
    await vm.runInContext('operatorInputSerial', context);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(context.args, 'C:/exact-account-runtime');
    expect(otherOwner).not.toHaveBeenCalled(); expect(logWarn).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa completed'));
    context.shutdownStarted = true; vm.runInContext('acceptOperatorInputArgs(args)', context);
    await vm.runInContext('operatorInputSerial', context); expect(inspect).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('unavailable during shutdown'));
  });
  it('keeps structured session inspection exclusive under Chromium argument mutation and malformed envelopes', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf("app.on('second-instance'");
    const handler = source.slice(start, source.indexOf('\n});', start) + 4);
    let received!: (event: unknown, argv: string[], cwd: string, data: unknown) => void;
    const inspect = vi.fn(), automation = vi.fn(), focus = vi.fn(), close = vi.fn(), warn = vi.fn();
    vm.runInNewContext(handler, { app: { on: (_event: string, callback: typeof received) => { received = callback; } },
      operatorProfileCreationSecondInstanceArgs, acceptOperatorInputArgs: inspect,
      acceptExplicitAutomationControlArgs: automation, safeCloseForUpdate: { accept: close },
      windowActivation: { request: focus }, isBackgroundLaunch, logWarn: warn });
    const id = 'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4';
    for (const operation of [['list', '--cos-sessions-limit=20'], ['controls', '--cos-sessions-session=2026-10-13-839d5152']]) {
      const args = [`--cos-sessions-action=${operation[0]}`, `--cos-sessions-profile=${id}`,
        '--cos-sessions-receipt=4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operation[1]!, `--cos-instance-runtime=${id}`, '--background'];
      const data = operatorProfileCreationAdditionalData(args)!;
      if (!('cosSessionInspection' in data)) throw new Error('Expected exact inspection transport');
      const mutated = ['app.exe', '--enable-features=Native', '--resume-automation', ...args.toReversed()];
      received({}, mutated, 'C:/', data); expect(inspect).toHaveBeenLastCalledWith(args);
      const admitted = inspect.mock.calls.length;
      for (const payload of [undefined, {}, { ...data, extra: 'never-log' },
        { cosSessionInspection: { ...data.cosSessionInspection, request: { ...data.cosSessionInspection.request, action: 'resume' } } },
        { cosSessionInspection: { ...data.cosSessionInspection, request: { ...data.cosSessionInspection.request, token: 'never-log' } } }])
        received({}, mutated, 'C:/', payload);
      expect(inspect).toHaveBeenCalledTimes(admitted);
    }
    expect(automation).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(10); expect(JSON.stringify(warn.mock.calls)).not.toContain('never-log');
  });
  it('maximizes only on initial presentation and preserves user-sized geometry on reopen', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const present = source.slice(source.indexOf('function showWindow()'), source.indexOf('\nsetFinishNotifier(', source.indexOf('function showWindow()'))).replace('function showWindow(): void', 'function showWindow()');
    const operations: string[] = [];
    const state = { minimized: false };
    const native = { isMinimized: () => state.minimized, isFullScreen: () => false,
      maximize: () => operations.push('maximize'),
      restore: () => operations.push('restore'),
      show: () => operations.push('show'), focus: () => operations.push('focus') };
    const createWindow = vi.fn();
    const context = vm.createContext({ window: native, quitting: false, createWindow });
    vm.runInContext(present + '\nshowWindow();', context);
    expect(operations.splice(0)).toEqual(['show', 'focus']);
    state.minimized = true;
    vm.runInContext('showWindow()', context);
    expect(operations.splice(0)).toEqual(['restore', 'show', 'focus']);
    context.quitting = true;
    vm.runInContext('showWindow()', context);
    expect(operations).toEqual([]);

    let ready!: () => void;
    const startup = source.slice(source.indexOf("  window.once('ready-to-show'"), source.indexOf('  // A renderer that fails', source.indexOf("  window.once('ready-to-show'")));
    const startupOperations: string[] = [];
    const startupState = { fullscreen: false };
    const showWindow = vi.fn(() => startupOperations.push('showWindow'));
    const launch = vm.createContext({ window: {
      once: (_event: string, listener: () => void) => { ready = listener; },
      isFullScreen: () => startupState.fullscreen,
      maximize: () => startupOperations.push('maximize')
    }, quitting: false, showWindow });
    vm.runInContext(startup, launch);
    ready();
    expect(startupOperations.splice(0)).toEqual(['maximize', 'showWindow']);
    startupState.fullscreen = true;
    ready();
    expect(startupOperations.splice(0)).toEqual(['showWindow']);
    launch.quitting = true;
    ready();
    expect(showWindow).toHaveBeenCalledTimes(2);
  });
  it('passively discovers on first visible use only when there is no saved catalog, never on repeat show or quit', async () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const listener = source.slice(source.indexOf("  window.on('show'"), source.indexOf("  window.once('ready-to-show'"));
    let show!: () => void;
    let state = 'ready';
    const start = vi.fn(async () => { state = 'pending'; return {}; });
    const context = vm.createContext({ window: { on: (event: string, callback: () => void) => {
      expect(event).toBe('show'); show = callback;
    } }, quitting: false, getChatModels: () => ({ state }), startChatModelDiscovery: start, logWarn: vi.fn() });
    vm.runInContext(listener, context);
    show(); await Promise.resolve(); expect(start).not.toHaveBeenCalled();
    state = 'unknown';
    show(); await Promise.resolve();
    show(); await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(false);
    state = 'unavailable';
    show(); await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    state = 'unknown';
    context.quitting = true;
    show();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('never bootstraps shared state from a secondary or already-quitting process', () => {
    expect(ownsAppRuntime(true)).toBe(true);
    expect(ownsAppRuntime(false)).toBe(false);
    expect(shouldBeginAppBootstrap(true, false)).toBe(true);
    expect(shouldBeginAppBootstrap(false, false)).toBe(false);
    expect(shouldBeginAppBootstrap(false, true)).toBe(false);
    expect(shouldBeginAppBootstrap(true, true)).toBe(false);
  });

  it('drops second-instance focus requests until renderer security and IPC startup are ready', () => {
    const show = vi.fn();
    const gate = createWindowActivationGate(show);

    // Electron can emit second-instance after its `ready` event while our async startup is still
    // restoring state. The initial startup path will show a window itself, so this early request
    // must not create one before CSP/permission/IPC setup is complete.
    gate.request();
    expect(show).not.toHaveBeenCalled();

    gate.enable();
    expect(show).not.toHaveBeenCalled();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);

    // `before-quit` closes the gate again while bounded teardown drains. Native activation or a
    // second launch in that window must not resurrect application UI during shutdown.
    gate.disable();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);

    // Startup is async. A continuation that resumes after `before-quit` can still execute its
    // old enable() call; shutdown must be a one-way boundary so that stale continuation cannot
    // reactivate Dock/second-instance/tray presentation.
    expect(gate.isDisabled()).toBe(true);
    gate.enable();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('stops lifecycle auto-progression polling as soon as shutdown begins', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf("app.on('before-quit'");
    const end = source.indexOf("app.on('window-all-closed'", start);
    const shutdownStart = source.slice(start, end);
    const stopPolling = shutdownStart.indexOf('stopIpcLifecyclePolling?.()');
    const disableWindowActivation = shutdownStart.indexOf('windowActivation.disable()');

    expect(stopPolling).toBeGreaterThanOrEqual(0);
    expect(disableWindowActivation).toBeGreaterThan(stopPolling);
  });

  it('reopens the app from the macOS Dock activation event', () => {
    const listeners = new Map<string, () => void>();
    const source = { on: vi.fn((event: 'activate', listener: () => void) => listeners.set(event, listener)) };
    const show = vi.fn();
    registerNativeWindowActivation(source, show, 'darwin');

    expect(source.on).toHaveBeenCalledWith('activate', show);
    listeners.get('activate')!();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it.each(['win32', 'linux'] as const)('does not add a foreign activation contract on %s', (platform) => {
    const source = { on: vi.fn() };
    registerNativeWindowActivation(source, vi.fn(), platform);
    expect(source.on).not.toHaveBeenCalled();
  });

  it('keeps a macOS app alive after its last window closes, regardless of close-to-tray preference', () => {
    expect(shouldQuitOnWindowAllClosed('darwin', true)).toBe(false);
    expect(shouldQuitOnWindowAllClosed('darwin', false)).toBe(false);
  });

  it.each(['win32', 'linux'] as const)('keeps close-to-tray semantics on %s', (platform) => {
    expect(shouldQuitOnWindowAllClosed(platform, true)).toBe(false);
    expect(shouldQuitOnWindowAllClosed(platform, false)).toBe(true);
  });
});

describe('Windows login startup', () => {
  it('refuses malformed or mixed cold account creation before runtime selection or singleton startup', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('// Validate account setup controls before selecting any runtime');
    const end = source.indexOf("// Chromium's process singleton", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThan(source.indexOf('const isolatedSelection'));
    expect(end).toBeLessThan(source.indexOf('app.requestSingleInstanceLock(startupProfileCreationData)'));
    const guard = stripTypeScriptTypes(source.slice(start, end));
    for (const argv of [
      ['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8', '--cos-instance-runtime=profile-example'],
      ['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8', '--pause-automation'],
      ['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8', '--api-key=secret-never-log'],
      ['app.exe', '--cos-create-profile=Gamma'], ['app.exe', '--cos-create-unknown=Gamma'],
      ['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile', '8'],
      ['app.exe', '8', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8'],
      ['app.exe', '--cos-set-profile-browser=profile-7a25c7a4-3452-4c79-8e67-f968852d90b4', '--cos-profile-browser=Profile 8', '--cos-instance-runtime=profile-example'],
      ['app.exe', '--cos-set-profile-browser=profile-7a25c7a4-3452-4c79-8e67-f968852d90b4', '--cos-profile-browser=Profile 8', '--pause-automation'],
      ['app.exe', '--cos-set-profile-browser=profile-7a25c7a4-3452-4c79-8e67-f968852d90b4', '--cos-profile-browser=Profile 8', '--api-key=secret-never-log'],
      ['app.exe', '--cos-set-profile-browser=local-instance', '--cos-profile-browser=Profile 8']
    ]) {
      const enteredRuntime = vi.fn(), error = vi.fn();
      const exit = vi.fn(() => { throw new Error('process exited'); });
      expect(() => vm.runInNewContext(`${guard}\nenteredRuntime();`, {
        operatorProfileCreationAdditionalData, process: { argv }, console: { error }, app: { exit }, enteredRuntime
      })).toThrow('process exited');
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(enteredRuntime).not.toHaveBeenCalled();
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret-never-log');
    }
    const enteredRuntime = vi.fn(), exit = vi.fn();
    vm.runInNewContext(`${guard}\nenteredRuntime();`, {
      operatorProfileCreationAdditionalData, process: { argv: ['app.exe', '--background', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8'] },
      console: { error: vi.fn() }, app: { exit }, enteredRuntime
    });
    expect(exit).not.toHaveBeenCalled();
    expect(enteredRuntime).toHaveBeenCalledOnce();
  });

  it('serializes account provisioning only after lifecycle restore without entering delivery or connection owners', async () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('let operatorInputRuntimeReady');
    const end = source.indexOf('\n/**\n * An update restart', start);
    const dispatcher = stripTypeScriptTypes(source.slice(start, end));
    const create = vi.fn(async () => ({ createdProfileId: 'profile-Gamma' }));
    const logInfo = vi.fn(), logWarn = vi.fn();
    const delivery = vi.fn(async () => ({ requested: 0, accepted: 0 }));
    const configureSharedAccountSettings = vi.fn();
    const connect = vi.fn();
    const context = vm.createContext({
      app: { getPath: vi.fn() }, logInfo, logWarn, connect,
      operatorInputRequestIds: () => [], operatorInputCancellationIds: () => [],
      operatorInputRetryIds: () => [], operatorPluginRefreshRearmIds: () => [],
      configureSharedAccountSettings,
      operatorSessionInspectionRequest, operatorSettingsControlRequest, operatorConnectionControlRequest, operatorSharedAccountSettingsRequest,
      operatorProfileCreationRequest, operatorProfileBrowserBindingRequest, operatorProfileRenameRequest, processOperatorProfileCreation,
      processOperatorProfileBrowserBinding,
      processOperatorInputRequests: delivery, processOperatorInputCancellations: delivery,
      processOperatorInputRetries: delivery, processOperatorPluginRefreshRearms: delivery,
      pluginRefreshPublications: () => [], createManagedInstanceProfile: create,
      operatorProfileLifecycle: null, quitting: false, shutdownStarted: false
    });
    vm.runInContext(dispatcher, context);
    vm.runInContext("acceptOperatorInputArgs(['app.exe','--cos-create-profile=Gamma','--cos-profile-browser=Profile 8'])", context);
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
    expect(vm.runInContext('pendingOperatorInputArgv.length', context)).toBe(1);
    vm.runInContext("operatorProfileLifecycle={profileId:'local-instance'}; operatorInputRuntimeReady=true; for (const argv of pendingOperatorInputArgv.splice(0)) acceptOperatorInputArgs(argv);", context);
    await vm.runInContext('operatorInputSerial', context);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'local-instance' }), 'Gamma', 'Profile 8');
    expect(delivery).not.toHaveBeenCalled();
    expect(configureSharedAccountSettings).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('profile-Gamma'));
    expect(logWarn).not.toHaveBeenCalled();
    vm.runInContext("acceptOperatorInputArgs(['app.exe','--cos-create-profile=Gamma','--cos-profile-browser=Profile 8','--cos-enqueue-input=private-value'])", context);
    vm.runInContext("acceptOperatorInputArgs(['app.exe','--cos-create-profile=Gamma','--cos-profile-browser=Profile 8','--api-key=private-value'])", context);
    await vm.runInContext('operatorInputSerial', context);
    expect(create).toHaveBeenCalledTimes(1);
    expect(delivery).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('private-value');
    context.shutdownStarted = true;
    vm.runInContext("acceptOperatorInputArgs(['app.exe','--cos-create-profile=Gamma','--cos-profile-browser=Profile 8'])", context);
    await vm.runInContext('operatorInputSerial', context);
    expect(create).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('shutting down'));
    const restoreAnchor = source.indexOf('await profileLifecycle.restore()');
    const assignmentAnchor = source.indexOf('operatorProfileLifecycle = profileLifecycle;');
    const readyAnchor = source.indexOf('operatorInputRuntimeReady = true;');
    expect(restoreAnchor).toBeGreaterThanOrEqual(0);
    expect(assignmentAnchor).toBeGreaterThanOrEqual(0);
    expect(readyAnchor).toBeGreaterThanOrEqual(0);
    expect(assignmentAnchor).toBeGreaterThan(restoreAnchor);
    expect(assignmentAnchor).toBeLessThan(readyAnchor);
  });

  it('serializes browser rebinding through the same guarded native IPC owner and preserves its refusals', async () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('let operatorInputRuntimeReady');
    const end = source.indexOf('\n/**\n * An update restart', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const nativeIpc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8');
    expect(nativeIpc).toContain('setManagedInstanceBrowserProfile(requireProfileLifecycle(), request.id, request.browserProfileDirectory)');
    const setBrowser = vi.fn(async () => ({ profiles: [] }));
    const create = vi.fn(), delivery = vi.fn(), configureSharedAccountSettings = vi.fn();
    const connect = vi.fn(), logInfo = vi.fn(), logWarn = vi.fn();
    const context = vm.createContext({
      app: { getPath: vi.fn() }, logInfo, logWarn, connect,
      operatorInputRequestIds: () => [], operatorInputCancellationIds: () => [],
      operatorInputRetryIds: () => [], operatorPluginRefreshRearmIds: () => [],
      configureSharedAccountSettings,
      operatorSessionInspectionRequest, operatorSettingsControlRequest, operatorConnectionControlRequest, operatorSharedAccountSettingsRequest,
      operatorProfileCreationRequest, operatorProfileBrowserBindingRequest, operatorProfileRenameRequest,
      processOperatorProfileCreation, processOperatorProfileBrowserBinding,
      processOperatorInputRequests: delivery, processOperatorInputCancellations: delivery,
      processOperatorInputRetries: delivery, processOperatorPluginRefreshRearms: delivery,
      pluginRefreshPublications: () => [], createManagedInstanceProfile: create,
      setManagedInstanceBrowserProfile: setBrowser,
      operatorProfileLifecycle: null, quitting: false, shutdownStarted: false
    });
    vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
    const argv = ['app.exe', '--cos-set-profile-browser=profile-7a25c7a4-3452-4c79-8e67-f968852d90b4', '--cos-profile-browser=Profile 8'];
    context.args = argv;
    vm.runInContext('acceptOperatorInputArgs(args)', context);
    await Promise.resolve();
    expect(setBrowser).not.toHaveBeenCalled();
    vm.runInContext("operatorProfileLifecycle={profileId:'local-instance'}; operatorInputRuntimeReady=true; for (const argv of pendingOperatorInputArgv.splice(0)) acceptOperatorInputArgs(argv);", context);
    await vm.runInContext('operatorInputSerial', context);
    expect(setBrowser).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ profileId: 'local-instance' }),
      'profile-7a25c7a4-3452-4c79-8e67-f968852d90b4', 'Profile 8');
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('browser binding: saved profile-7a25c7a4'));
    expect(create).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
    expect(configureSharedAccountSettings).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    setBrowser.mockRejectedValueOnce(new Error('Create account profiles from the primary account window.'));
    vm.runInContext('acceptOperatorInputArgs(args)', context);
    await vm.runInContext('operatorInputSerial', context);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('primary account window'));
    for (const flag of ['--pause-automation', '--resume-automation', '--cos-enqueue-input=never-log', '--api-key=never-log']) {
      context.args = [...argv, flag];
      vm.runInContext('acceptOperatorInputArgs(args)', context);
    }
    await vm.runInContext('operatorInputSerial', context);
    expect(setBrowser).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('never-log');
  });

  it('serializes nickname rename after restore through the same native owner and retains its refusals', async () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('let operatorInputRuntimeReady');
    const end = source.indexOf('\n/**\n * An update restart', start);
    const nativeIpc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8');
    expect(nativeIpc).toContain('renameManagedInstanceProfile(requireProfileLifecycle(), request.id, request.nickname)');
    const rename = vi.fn(async () => ({ profiles: [] }));
    const otherOwner = vi.fn(), logInfo = vi.fn(), logWarn = vi.fn();
    const id = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    const original = ['app.exe', `--cos-rename-profile=${id}`, '--cos-profile-nickname=Delta', '--background'];
    const args = operatorProfileCreationSecondInstanceArgs(['app.exe', '--enable-features=ChromiumOwned'],
      operatorProfileCreationAdditionalData(original));
    const context = vm.createContext({
      app: { getPath: vi.fn() }, logInfo, logWarn, args, quitting: false, shutdownStarted: false,
      operatorInputRequestIds: () => [], operatorInputCancellationIds: () => [],
      operatorInputRetryIds: () => [], operatorPluginRefreshRearmIds: () => [],
      operatorSessionInspectionRequest, operatorSettingsControlRequest, operatorConnectionControlRequest,
      operatorSharedAccountSettingsRequest, operatorProfileCreationRequest, operatorProfileBrowserBindingRequest, operatorProfileRenameRequest,
      processOperatorProfileRename, renameManagedInstanceProfile: rename,
      processOperatorProfileCreation: otherOwner, processOperatorProfileBrowserBinding: otherOwner,
      processOperatorInputRequests: otherOwner, processOperatorInputCancellations: otherOwner,
      processOperatorInputRetries: otherOwner, processOperatorPluginRefreshRearms: otherOwner,
      configureSharedAccountSettings: otherOwner, connect: otherOwner
    });
    vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
    vm.runInContext('acceptOperatorInputArgs(args)', context);
    await Promise.resolve();
    expect(rename).not.toHaveBeenCalled();
    vm.runInContext("operatorProfileLifecycle={profileId:'local-instance'}; operatorInputRuntimeReady=true; for (const argv of pendingOperatorInputArgv.splice(0)) acceptOperatorInputArgs(argv);", context);
    await vm.runInContext('operatorInputSerial', context);
    expect(rename).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ profileId: 'local-instance' }), id, 'Delta');
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining(`account nickname: saved ${id}`));
    expect(otherOwner).not.toHaveBeenCalled();
    rename.mockRejectedValueOnce(new Error('Account is running in another window.'));
    vm.runInContext('acceptOperatorInputArgs(args)', context);
    await vm.runInContext('operatorInputSerial', context);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('running in another window'));
    for (const flag of ['--pause-automation', '--resume-automation', '--cos-enqueue-input=never-log',
      `--cos-instance-runtime=${id}`, '--api-key=never-log']) {
      context.args = [...original, flag];
      vm.runInContext('acceptOperatorInputArgs(args)', context);
    }
    await vm.runInContext('operatorInputSerial', context);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(otherOwner).not.toHaveBeenCalled();
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('never-log');
    context.args = args;
    context.shutdownStarted = true;
    vm.runInContext('acceptOperatorInputArgs(args)', context);
    await vm.runInContext('operatorInputSerial', context);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('shutting down'));
  });

  it('rejects account creation mixed into safe-close before requesting shutdown', async () => {
    const args = ['app.exe', '--safe-close-for-update=local-instance', '--safe-close-for-update-pid=4242',
      '--safe-close-for-update-generation=1700000000424', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8'];
    expect(() => coldSafeCloseForUpdateProfileId(args, null)).toThrow(/cannot share a launch/);
    const shutdown = vi.fn(async () => ({ outcome: 'closed', status: { phase: 'idle', blockerCount: 0 } }));
    const gate = createSafeCloseForUpdateGate({ info: vi.fn(), warn: vi.fn(), runningProcessId: 4242,
      runningProcessGeneration: 1700000000424 });
    await gate.enable('local-instance', shutdown);
    expect(gate.accept(args)).toBe(true);
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
    for (const binding of ['--cos-set-profile-browser=profile-7a25c7a4-3452-4c79-8e67-f968852d90b4',
      '--cos-set-profile-browser', '--cos-set-profile-unknown=never-log']) {
      const mixed = args.slice(0, 4).concat(binding);
      expect(() => coldSafeCloseForUpdateProfileId(mixed, null)).toThrow(/cannot share a launch/);
      expect(gate.accept(mixed)).toBe(true);
    }
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('writes only packaged Windows login settings and supports turning the same entry off', () => {
    const app = { isPackaged: true, setLoginItemSettings: vi.fn() };
    applyLoginStartup(app, true, 'win32', 'C:/Program Files/Chat On Steroids/app.exe');
    applyLoginStartup(app, false, 'win32', 'C:/Program Files/Chat On Steroids/app.exe');
    expect(app.setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: true, path: 'C:/Program Files/Chat On Steroids/app.exe', args: ['--background'] }],
      [{ openAtLogin: false, path: 'C:/Program Files/Chat On Steroids/app.exe', args: ['--background'] }]
    ]);
    for (const platform of ['darwin', 'linux'] as const) applyLoginStartup(app, true, platform);
    app.isPackaged = false;
    applyLoginStartup(app, true, 'win32');
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(2);
    expect(supportsLoginStartup('win32', false)).toBe(false);
  });
  it('exclusively routes structured registration despite Chromium argv mutation and consumes invalid transport', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf("app.on('second-instance'");
    const handler = source.slice(start, source.indexOf('\n});', start) + 4);
    let received!: (event: unknown, argv: string[], workingDirectory: string, additionalData: unknown) => void;
    const input = vi.fn(), automation = vi.fn(), close = vi.fn(), focus = vi.fn(), warn = vi.fn();
    vm.runInNewContext(handler, {
      app: { on: (_: string, callback: typeof received) => { received = callback; } },
      operatorProfileCreationSecondInstanceArgs, acceptOperatorInputArgs: input,
      acceptExplicitAutomationControlArgs: automation, safeCloseForUpdate: { accept: close },
      windowActivation: { request: focus }, isBackgroundLaunch, logWarn: warn
    });
    const argv = ['app.exe', '--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8', '--background'];
    const data = operatorProfileCreationAdditionalData(argv)!;
    if (!('cosProfileCreation' in data)) throw new Error('Expected a creation envelope');
    const mutated = ['app.exe', '--original-process-start-time=123456789', '--cos-profile-browser=Profile 8',
      '--background', '--cos-create-profile=Gamma'];
    received({}, mutated, 'C:\\', data);
    expect(input).toHaveBeenCalledExactlyOnceWith(['--cos-create-profile=Gamma', '--cos-profile-browser=Profile 8', '--background']);
    for (const payload of [undefined, {}, { ...data, apiKey: 'never-log' },
      { cosProfileCreation: { ...data.cosProfileCreation, request: { ...data.cosProfileCreation.request, root: 'never-log' } } }])
      received({}, [...mutated, '--pause-automation'], 'C:\\', payload);
    expect(input).toHaveBeenCalledOnce();
    expect(automation).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('never-log');
    const bindingArgv = ['app.exe', '--cos-set-profile-browser=profile-7a25c7a4-3452-4c79-8e67-f968852d90b4', '--cos-profile-browser=Profile 8', '--background'];
    const bindingData = operatorProfileCreationAdditionalData(bindingArgv)!;
    received({}, [...bindingArgv, '--original-process-start-time=123456789'], 'C:\\', bindingData);
    expect(input).toHaveBeenLastCalledWith(bindingArgv.slice(1));
    for (const payload of [undefined, {}, { ...bindingData, apiKey: 'never-log' }])
      received({}, [...bindingArgv, '--pause-automation'], 'C:\\', payload);
    expect(input).toHaveBeenCalledTimes(2);
    expect(automation).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('never-log');
  });

  it('ignores background second-instance launches while ordinary launches still focus', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf("app.on('second-instance'");
    const handler = source.slice(start, source.indexOf('\n});', start) + 4);
    let received!: (event: unknown, argv: string[]) => void;
    const request = vi.fn();
    const acceptOperatorInputArgs = vi.fn();
    const acceptSafeCloseForUpdateArgs = vi.fn(() => false);
    const acceptExplicitAutomationControlArgs = vi.fn();
    vm.runInNewContext(handler, {
      app: { on: (_: string, listener: typeof received) => { received = listener; } },
      windowActivation: { request },
      acceptOperatorInputArgs,
      safeCloseForUpdate: { accept: acceptSafeCloseForUpdateArgs },
      acceptExplicitAutomationControlArgs,
      isBackgroundLaunch,
      operatorProfileCreationSecondInstanceArgs,
      logWarn: vi.fn(),
    });
    const cancellationId = '4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const retryId = '4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const retryReceipt = '4ccccccc-cccc-4ccc-8ccc-cccccccccccc';
    received({}, ['app.exe', '--background', `--cos-cancel-queued-input=${cancellationId}`]);
    expect(request).not.toHaveBeenCalled();
    received({}, ['app.exe', '--background', `--cos-retry-queued-input=${retryId}`,
      `--cos-retry-queued-input-receipt=${retryReceipt}`]);
    expect(request).not.toHaveBeenCalled();
    received({}, ['app.exe']);
    expect(request).toHaveBeenCalledOnce();
    expect(acceptOperatorInputArgs.mock.calls).toEqual([
      [['app.exe', '--background', `--cos-cancel-queued-input=${cancellationId}`]],
      [['app.exe', '--background', `--cos-retry-queued-input=${retryId}`,
        `--cos-retry-queued-input-receipt=${retryReceipt}`]],
      [['app.exe']]
    ]);
    acceptSafeCloseForUpdateArgs.mockReturnValueOnce(true);
    received({}, [
      'app.exe', '--safe-close-for-update=local-instance', '--safe-close-for-update-pid=1234',
      '--safe-close-for-update-generation=1700000000123'
    ]);
    expect(acceptOperatorInputArgs).toHaveBeenCalledTimes(3);
    expect(acceptExplicitAutomationControlArgs).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledOnce();
    expect(isBackgroundLaunch(['app.exe', '--background=false'])).toBe(false);
    expect(source).toContain('if (!isBackgroundLaunch(process.argv)) windowActivation.request();');
    expect(source).toContain('operatorInputCancellationIds(argv)');
    expect(source).toContain('operatorInputRetryIds(argv)');
    expect(source).toContain('processOperatorInputRetries(argv)');
    const readyAnchor = source.indexOf('operatorInputRuntimeReady = true;');
    const acceptAnchor = source.indexOf('acceptOperatorInputArgs(process.argv);');
    expect(readyAnchor).toBeGreaterThanOrEqual(0);
    expect(acceptAnchor).toBeGreaterThanOrEqual(0);
    expect(readyAnchor).toBeLessThan(acceptAnchor);
    const coldClose = source.indexOf('} else if (safeCloseForUpdateAttempted(process.argv)) {');
    expect(coldClose).toBeGreaterThan(source.indexOf('const hasSingleInstanceLock = app.requestSingleInstanceLock(startupProfileCreationData);'));
    expect(coldClose).toBeLessThan(source.indexOf('function createWindow(): void'));
    expect(source.slice(coldClose, source.indexOf('function createWindow(): void')))
      .toContain('coldSafeCloseForUpdateProfileId(process.argv, isolatedSelection?.instanceId ?? null)');
    expect(source.slice(coldClose, source.indexOf('function createWindow(): void')))
      .toContain('quitting = true;\n  app.quit();');
  });

  it('strictly scopes the external safe-close command and waits for the lifecycle owner', async () => {
    expect(safeCloseForUpdateAttempted(['app.exe'])).toBe(false);
    expect(safeCloseForUpdateAttempted(['app.exe', '--safe-close-for-update'])).toBe(true);
    expect(safeCloseForUpdateAttempted(['app.exe', '--safe-close-for-update-pid=1234'])).toBe(true);
    expect(safeCloseForUpdateAttempted(['app.exe', '--safe-close-for-update-generation=1700000000424'])).toBe(true);
    expect(safeCloseForUpdateProfileId(['app.exe'])).toBeNull();
    expect(safeCloseForUpdateProfileId(['app.exe', '--safe-close-for-update=local-instance']))
      .toBe('local-instance');
    expect(() => safeCloseForUpdateProfileId(['app.exe', '--safe-close-for-update']))
      .toThrow(/exact active profile id/);
    expect(() => safeCloseForUpdateProfileId([
      'app.exe', '--safe-close-for-update=local-instance', '--safe-close-for-update=local-instance'
    ])).toThrow(/exactly one/);
    expect(() => safeCloseForUpdateProfileId(['app.exe', '--safe-close-for-update=..\\config']))
      .toThrow(/exact active profile id/);
    expect(safeCloseForUpdateExpectedPid(['app.exe', '--safe-close-for-update-pid=4242'])).toBe(4242);
    expect(() => safeCloseForUpdateExpectedPid(['app.exe'])).toThrow(/exactly one expected/);
    expect(() => safeCloseForUpdateExpectedPid(['app.exe', '--safe-close-for-update-pid=0']))
      .toThrow(/positive decimal/);
    expect(safeCloseForUpdateExpectedGeneration([
      'app.exe', '--safe-close-for-update-generation=1700000000424'
    ])).toBe(1_700_000_000_424);
    expect(() => safeCloseForUpdateExpectedGeneration(['app.exe'])).toThrow(/exactly one expected/);
    expect(() => safeCloseForUpdateExpectedGeneration([
      'app.exe', '--safe-close-for-update-generation=1.7e12'
    ])).toThrow(/positive decimal/);
    expect(coldSafeCloseForUpdateProfileId([
      'app.exe', '--safe-close-for-update=local-instance', '--safe-close-for-update-pid=4242',
      '--safe-close-for-update-generation=1700000000424'
    ], null)).toBe('local-instance');
    expect(coldSafeCloseForUpdateProfileId([
      'app.exe', '--cos-instance-runtime=profile-foot', '--safe-close-for-update=profile-foot',
      '--safe-close-for-update-pid=4242', '--safe-close-for-update-generation=1700000000424'
    ], 'profile-foot')).toBe('profile-foot');
    expect(() => coldSafeCloseForUpdateProfileId([
      'app.exe', '--safe-close-for-update=profile-foot', '--safe-close-for-update-pid=4242',
      '--safe-close-for-update-generation=1700000000424'
    ], null)).toThrow(/requires its matching --cos-instance-runtime/);
    expect(() => coldSafeCloseForUpdateProfileId([
      'app.exe', '--cos-instance-runtime=profile-foot', '--safe-close-for-update=profile-other',
      '--safe-close-for-update-pid=4242', '--safe-close-for-update-generation=1700000000424'
    ], 'profile-foot')).toThrow(/same profile/);
    expect(() => coldSafeCloseForUpdateProfileId([
      'app.exe', '--safe-close-for-update=local-instance', '--safe-close-for-update-pid=4242',
      '--safe-close-for-update-generation=1700000000424', '--pause-automation'
    ], null)).toThrow(/cannot share a launch/);
    // A cold helper consumes a syntactically valid stale generation without starting the app;
    // there is no surviving target process left to compare in this race.
    expect(coldSafeCloseForUpdateProfileId([
      'app.exe', '--safe-close-for-update=local-instance', '--safe-close-for-update-pid=4242',
      '--safe-close-for-update-generation=1600000000000'
    ], null)).toBe('local-instance');

    const info = vi.fn();
    const warn = vi.fn();
    const gate = createSafeCloseForUpdateGate({
      info, warn, runningProcessId: 4242, runningProcessGeneration: 1_700_000_000_424
    });
    let releaseFirstShutdown!: () => void;
    const firstShutdown = new Promise<void>(resolve => { releaseFirstShutdown = resolve; });
    const shutdown = vi.fn(async () => {
      if (shutdown.mock.calls.length === 1) await firstShutdown;
      return { outcome: 'draining', status: { phase: 'draining-shutdown', blockerCount: 2 } };
    });

    const exactClose = [
      'app.exe', '--background', '--safe-close-for-update=profile-foot',
      '--safe-close-for-update-pid=4242', '--safe-close-for-update-generation=1700000000424'
    ];
    expect(gate.accept(exactClose)).toBe(true);
    expect(gate.accept(exactClose)).toBe(true);
    expect(shutdown).not.toHaveBeenCalled();
    const enabled = gate.enable('profile-foot', shutdown);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    // A duplicate that arrives while the same request is in flight remains one operation.
    expect(gate.accept(exactClose)).toBe(true);
    releaseFirstShutdown();
    await enabled;
    expect(shutdown).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('draining-shutdown'));

    // The first request only began a cancellable Drain. Once it is no longer pending/in-flight,
    // a later exact CLI request must reach the lifecycle owner again so a cancelled Drain can be
    // explicitly re-armed without restarting the process.
    expect(gate.accept(exactClose)).toBe(true);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(2));
    expect(gate.accept([
      'app.exe', '--safe-close-for-update=profile-other', '--safe-close-for-update-pid=4242',
      '--safe-close-for-update-generation=1700000000424'
    ])).toBe(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not match running profile')));
    expect(shutdown).toHaveBeenCalledTimes(2);

    // A replacement process with the same profile cannot spend a request addressed to the old PID.
    expect(gate.accept([
      'app.exe', '--safe-close-for-update=profile-foot', '--safe-close-for-update-pid=3131',
      '--safe-close-for-update-generation=1700000000424'
    ])).toBe(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'expected process 3131 does not match running process 4242'
    )));
    expect(shutdown).toHaveBeenCalledTimes(2);

    // PID reuse cannot spend an earlier process generation's request.
    expect(gate.accept([
      'app.exe', '--safe-close-for-update=profile-foot', '--safe-close-for-update-pid=4242',
      '--safe-close-for-update-generation=1700000000423'
    ])).toBe(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'expected process generation 1700000000423 does not match running generation 1700000000424'
    )));
    expect(shutdown).toHaveBeenCalledTimes(2);

    const mixed = createSafeCloseForUpdateGate({
      info: vi.fn(), warn, runningProcessId: 4242, runningProcessGeneration: 1_700_000_000_424
    });
    expect(mixed.accept([
      'app.exe', '--safe-close-for-update=local-instance', '--safe-close-for-update-pid=4242',
      '--safe-close-for-update-generation=1700000000424', '--resume-automation'
    ])).toBe(true);
    await mixed.enable('local-instance', shutdown);
    expect(shutdown).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot share a launch'));
  });

  it('queues ordered pause controls and coalesces duplicate resume until bridge/runtime startup is ready', async () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const queueStart = source.indexOf('let explicitAutomationControlRuntimeReady');
    const queueEnd = source.indexOf('type PendingCompanionReload', queueStart);
    const handlerStart = source.indexOf("app.on('second-instance'");
    const handler = source.slice(handlerStart, source.indexOf('\n});', handlerStart) + 4);
    const operations: string[] = [];
    const runtime = { paused: false };
    const resume = vi.fn(async () => {
      operations.push('resume');
      runtime.paused = false;
      return { queued: 2, alreadyActive: 1, recovering: 0 };
    });
    const pauseSessions = vi.fn(async (ids: string[]) => {
      operations.push(`pause-sessions:${ids.join(',')}`);
      return { requested: ids.length, updated: ids.length, skipped: 0, paused: true };
    });
    const acceptOperatorInputArgs = vi.fn();
    const focus = vi.fn();
    let received!: (event: unknown, argv: string[]) => void;
    const context = vm.createContext({
      operations,
      quitting: false,
      app: { on: (_: string, listener: typeof received) => { received = listener; } },
      windowActivation: { request: focus },
      acceptOperatorInputArgs,
      safeCloseForUpdate: { accept: vi.fn(() => false) },
      isBackgroundLaunch,
      operatorProfileCreationSecondInstanceArgs,
      explicitAutomationControlFromArgs: (argv: string[]) => {
        const pauseAll = argv.includes('--pause-automation');
        const resumeAll = !pauseAll && argv.includes('--resume-automation') && !argv.includes('--updated');
        const pauseSessionIds = argv.filter(value => value.startsWith('--pause-session-automation='))
          .map(value => value.split('=', 2)[1]);
        const helperSettings = helperReasoningSettingsRequest(argv);
        if (!pauseAll && !resumeAll && pauseSessionIds.length === 0 && !helperSettings) return null;
        return { pauseAll, pauseSessionIds, resumeAll, helperSettings, trigger: pauseAll
          ? 'explicit --pause-automation request'
          : resumeAll ? 'explicit --resume-automation request' : 'explicit --pause-session-automation request' };
      },
      sameExplicitAutomationControl: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
      getConfig: () => ({ ui: { automationPaused: runtime.paused } }),
      updateConfig: vi.fn(async (update: (config: { ui: { automationPaused: boolean } }) => { ui: { automationPaused: boolean } }) => {
        operations.push('persist-pause');
        runtime.paused = update({ ui: { automationPaused: runtime.paused } }).ui.automationPaused;
      }),
      applyAutomationPause: vi.fn(() => operations.push('apply-pause')),
      setSessionsAutomationPaused: pauseSessions,
      resumeAutomationAfterExplicitRequest: resume,
      setHelperReasoningAfterExplicitRequest: vi.fn(async (profileId: string, reasoning: string) => {
        operations.push(`helper:${profileId}:${reasoning}`);
      }),
      logInfo: vi.fn(),
      logWarn: vi.fn()
    });

    expect(queueStart).toBeGreaterThanOrEqual(0);
    expect(queueEnd).toBeGreaterThan(queueStart);
    const queue = source.slice(queueStart, queueEnd)
      .replace('const pendingExplicitAutomationControls: ExplicitAutomationControl[] = [];', 'const pendingExplicitAutomationControls = [];')
      .replaceAll('control: ExplicitAutomationControl', 'control')
      .replaceAll('argv: readonly string[]', 'argv')
      .replaceAll(': Promise<void>', '')
      .replaceAll(': boolean', '')
      .replaceAll(': void', '')
      .replace('.shift()!', '.shift()')
      .replace('[0]!', '[0]');
    vm.runInContext(queue, context);
    vm.runInContext(handler, context);

    vm.runInContext("startExplicitAutomationControlRuntime = () => operations.push('start-runtime')", context);

    // Helper-only settings may publish once local config/account identity is ready. They must not
    // require the browser recovery gate or implicitly resume any Loop work.
    received({}, ['app.exe', '--background', '--set-helper-reasoning=high', '--helper-settings-profile=local-instance']);
    received({}, ['app.exe', '--background', '--set-helper-reasoning=xhigh', '--helper-settings-profile=local-instance']);
    expect(operations).toEqual([]);
    vm.runInContext('markExplicitAutomationSettingsRuntimeReady()', context);
    await vi.waitFor(() => expect(operations).toEqual(['helper:local-instance:high', 'helper:local-instance:xhigh']));
    expect(operations).not.toContain('start-runtime');
    expect(resume).not.toHaveBeenCalled();
    operations.length = 0;

    received({}, ['app.exe', '--background', '--pause-automation', '--pause-session-automation=session-old-1']);
    received({}, ['app.exe', '--background', '--pause-automation', '--pause-session-automation=session-old-1']);
    received({}, ['app.exe', '--background', '--set-helper-reasoning=high', '--helper-settings-profile=local-instance']);
    received({}, ['app.exe', '--background', '--set-helper-reasoning=high', '--helper-settings-profile=local-instance']);
    received({}, ['app.exe', '--resume-automation']);
    received({}, ['app.exe', '--background', '--resume-automation']);
    expect(resume).not.toHaveBeenCalled();
    expect(pauseSessions).not.toHaveBeenCalled();
    expect(acceptOperatorInputArgs.mock.calls).toEqual([
      [['app.exe', '--background', '--set-helper-reasoning=high', '--helper-settings-profile=local-instance']],
      [['app.exe', '--background', '--set-helper-reasoning=xhigh', '--helper-settings-profile=local-instance']],
      [['app.exe', '--background', '--pause-automation', '--pause-session-automation=session-old-1']],
      [['app.exe', '--background', '--pause-automation', '--pause-session-automation=session-old-1']],
      [['app.exe', '--background', '--set-helper-reasoning=high', '--helper-settings-profile=local-instance']],
      [['app.exe', '--background', '--set-helper-reasoning=high', '--helper-settings-profile=local-instance']],
      [['app.exe', '--resume-automation']],
      [['app.exe', '--background', '--resume-automation']]
    ]);
    expect(focus).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(operations).toContain('start-runtime'));
    operations.length = 0;
    vm.runInContext('markExplicitAutomationControlRuntimeReady()', context);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(operations).toEqual([
      'persist-pause',
      'apply-pause',
      'pause-sessions:session-old-1',
      'helper:local-instance:high',
      'resume'
    ]);
    expect(runtime.paused).toBe(false);
    expect(pauseSessions).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith('explicit --resume-automation request');

    context.quitting = true;
    received({}, ['app.exe', '--background', '--set-helper-reasoning=xhigh', '--helper-settings-profile=local-instance']);
    await Promise.resolve();
    expect(operations).not.toContain('helper:local-instance:xhigh');

    // An update-owned launch retains inventory-first suppression even after the gate is ready.
    received({}, ['app.exe', '--updated', '--resume-automation']);
    await Promise.resolve();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(acceptOperatorInputArgs).toHaveBeenLastCalledWith(['app.exe', '--updated', '--resume-automation']);

    // Production opens this gate only after a real bridge publication and companion reconcile.
    const bridgeStart = source.indexOf('void startBridge()');
    const nullBridgeFence = source.indexOf('if (bridgePort === null)', bridgeStart);
    const companionReconcile = source.indexOf('await reloadPairedCompanionAfterUpdate(companionFingerprint)', bridgeStart);
    const readySignal = source.indexOf('markExplicitAutomationControlRuntimeReady()', bridgeStart);
    expect(bridgeStart).toBeGreaterThanOrEqual(0);
    expect(nullBridgeFence).toBeGreaterThan(bridgeStart);
    expect(companionReconcile).toBeGreaterThan(nullBridgeFence);
    expect(readySignal).toBeGreaterThan(companionReconcile);
  });

  it('strictly validates and deduplicates command-line per-chat pause ids', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf("const PAUSE_SESSION_AUTOMATION_ARG =");
    const end = source.indexOf('\ntype ExplicitAutomationControl', start);
    const parser = source.slice(start, end)
      .replaceAll('export ', '')
      .replaceAll('argv: readonly string[]', 'argv')
      .replaceAll(': boolean', '')
      .replaceAll(': string[]', '');
    const logWarn = vi.fn();
    const context = vm.createContext({
      logWarn,
      helperReasoningSettingsRequest,
      signOutEmergencyAlertSettingRequest,
      operatorSessionInspectionRequest, operatorSettingsControlRequest, operatorConnectionControlRequest, operatorSharedAccountSettingsRequest,
      operatorProfileCreationRequest,
      operatorProfileBrowserBindingRequest,
      operatorProfileRenameRequest,
      startupAutomationResumeRequested: (argv: string[]) => argv.includes('--resume-automation') && !argv.includes('--updated')
    });
    vm.runInContext(parser, context);
    const controlStart = source.indexOf('function explicitAutomationControlFromArgs');
    const controlEnd = source.indexOf('\n}\n\n// A second process', controlStart) + 2;
    const controlParser = source.slice(controlStart, controlEnd)
      .replace('argv: readonly string[]', 'argv')
      .replace(': ExplicitAutomationControl | null', '');
    vm.runInContext(controlParser, context);

    expect(() => vm.runInContext("explicitAutomationControlFromArgs(['app.exe','--cos-create-profile=Gamma','--cos-profile-browser=Profile 8','--pause-automation'])", context))
      .toThrow(/cannot share a launch/);
    expect(() => vm.runInContext("explicitAutomationControlFromArgs(['app.exe','--cos-create-profile=Gamma','--cos-profile-browser=Profile 8','--resume-automation'])", context))
      .toThrow(/cannot share a launch/);

    expect(vm.runInContext("startupAutomationPauseRequested(['app.exe', '--pause-automation'])", context)).toBe(true);
    expect(vm.runInContext("startupSessionAutomationPauseIds(['app.exe', '--pause-session-automation=session-old-1', '--pause-session-automation=session-old-1', '--pause-session-automation=session-old-2'])", context))
      .toEqual(['session-old-1', 'session-old-2']);
    expect(() => vm.runInContext("startupSessionAutomationPauseIds(['app.exe', '--pause-session-automation'])", context))
      .toThrow(/stable local session id/);
    expect(() => vm.runInContext("startupSessionAutomationPauseIds(['app.exe', '--pause-session-automation=../../config'])", context))
      .toThrow(/stable local session id/);
    const contradictory = vm.runInContext(
      "explicitAutomationControlFromArgs(['app.exe', '--pause-automation', '--resume-automation'])",
      context
    ) as { pauseAll: boolean; resumeAll: boolean };
    expect({ pauseAll: contradictory.pauseAll, resumeAll: contradictory.resumeAll })
      .toEqual({ pauseAll: true, resumeAll: false });
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('--pause-automation overrides --resume-automation'));
    const helper = vm.runInContext(
      "explicitAutomationControlFromArgs(['app.exe', '--set-helper-reasoning=high', '--helper-settings-profile=local-instance'])",
      context
    );
    expect(helper).toMatchObject({ pauseAll: false, resumeAll: false, helperSettings: { profileId: 'local-instance', reasoning: 'high' } });
    const equalityStart = source.indexOf('function sameExplicitAutomationControl');
    const equalityEnd = source.indexOf('\nfunction explicitAutomationControlFromArgs', equalityStart);
    vm.runInContext(source.slice(equalityStart, equalityEnd)
      .replaceAll(': ExplicitAutomationControl', '').replace(': boolean', ''), context);
    context.helper = helper;
    expect(vm.runInContext('sameExplicitAutomationControl(helper, helper)', context)).toBe(true);
    expect(vm.runInContext("sameExplicitAutomationControl(helper, { ...helper, helperSettings: { ...helper.helperSettings, reasoning: 'xhigh' } })", context)).toBe(false);
    expect(vm.runInContext("sameExplicitAutomationControl(helper, { ...helper, helperSettings: { ...helper.helperSettings, profileId: 'another-account' } })", context)).toBe(false);
  });

  it('routes a cold-start pause request through the restored runtime gate', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const runtimeAssignment = source.indexOf('startExplicitAutomationControlRuntime = ensureExplicitAutomationControlRuntime;');
    const coldStartAccept = source.indexOf('acceptExplicitAutomationControlArgs(process.argv);', runtimeAssignment);
    const pendingFence = source.indexOf('pendingExplicitAutomationControls.some(explicitAutomationControlNeedsBridge)', coldStartAccept);
    const bridgeStart = source.indexOf('ensureExplicitAutomationControlRuntime();', pendingFence);

    expect(runtimeAssignment).toBeGreaterThanOrEqual(0);
    expect(coldStartAccept).toBeGreaterThan(runtimeAssignment);
    expect(pendingFence).toBeGreaterThan(coldStartAccept);
    expect(bridgeStart).toBeGreaterThan(pendingFence);
    expect(source.slice(runtimeAssignment, pendingFence)).not.toContain('resumeAutomationAfterExplicitRequest(');
  });
});


describe('one-shot controls across native relaunch', () => {
  it.each([
    ['C:\\CoS\\app.exe', '--background'],
    ['/Applications/CoS.app/Contents/MacOS/CoS', '--disable-gpu'],
    ['/usr/bin/electron', '/workspace/CoS', '--background']
  ])('retains runtime and host arguments without mutating %s', (...ordinary) => {
    const once = ['--resume-automation', '--pause-automation', '--pause-session-automation=local-session',
      '--cos-enqueue-input=private-path', '--cos-retry-queued-input=private-id', '--cos-cancel-queued-input=private-id',
      '--cos-connection-origin=private-origin', '--cos-settings-action=save', '--cos-share-drive=private-path',
      '--cos-future-command=private-value', '--set-helper-reasoning=high', '--helper-settings-profile=profile-foot',
      '--set-chat-default-model=gpt-6-thinking', '--retire-recorded-chats', '--enable-signout-emergency-alerts',
      '--disable-signout-emergency-alerts', '--defer-companion-reload=profile-foot', '--reload-companion=profile-foot',
      '--discard-unexportable-companion-buffers', '--safe-close-for-update=profile-foot',
      '--safe-close-for-update-status=profile-foot', '--safe-close-for-update-cancel=profile-foot',
      '--safe-close-for-update-pid=123', '--safe-close-for-update-generation=123', '--updated'];
    const argv = Object.freeze([...ordinary, '--cos-instance-runtime=profile-foot', ...once]);
    const expected = [...ordinary.slice(1), '--cos-instance-runtime=profile-foot'];
    expect(lifecycleExports.relaunchArguments(argv)).toEqual(expected);
    expect(lifecycleExports.relaunchArguments([ordinary[0]!, ...expected])).toEqual(expected);
    expect(argv).toEqual([...ordinary, '--cos-instance-runtime=profile-foot', ...once]);
  });

  it('leaves a later saved Pause in control at the real successor startup decision', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export function startupAutomationResumeRequested');
    const end = source.indexOf('\nconst PAUSE_SESSION_AUTOMATION_ARG', start);
    const code = stripTypeScriptTypes(source.slice(start, end).replace('export function', 'function'));
    const argv = ['app.exe', '--background', '--resume-automation'];
    const context = vm.createContext({ argv });
    expect(vm.runInContext(code + '\nstartupAutomationResumeRequested(argv)', context)).toBe(true);
    context.argv = ['app.exe', ...lifecycleExports.relaunchArguments(argv)];
    expect(vm.runInContext('startupAutomationResumeRequested(argv)', context)).toBe(false);
  });

  it('does not replay Resume or queued work when the actual profile-switch owner restarts', async () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    onSwitchReady: async (state) => {');
    const end = source.indexOf('    applyUpdate: async () => {', start);
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
    const argv = ['app.exe', '--background', '--cos-instance-runtime=profile-rivera',
      '--resume-automation', '--cos-enqueue-input=private-payload', '--cos-enqueue-receipt=private-receipt'];
    let successor: string[] = [];
    const order: string[] = [];
    const context = vm.createContext({ ...lifecycleExports, process: { argv }, quitting: false,
      logEvent: () => undefined, logInfo: () => undefined,
      flushRecorder: async () => { order.push('recorder'); },
      flushSessions: async () => { order.push('sessions'); }, flushDurable: async () => { order.push('durable'); },
      stageInstanceActivationForNextStart: async () => { order.push('stage'); },
      app: { relaunch: (options?: { args?: string[] }) => {
        successor = options?.args ?? argv.slice(1); order.push('relaunch');
      }, quit: () => { order.push('quit'); } }
    });
    await vm.runInContext(stripTypeScriptTypes('({' + source.slice(start, end) + '}).onSwitchReady({sourceProfileId:"profile-rivera",targetProfileId:"profile-foot"})'), context);
    expect(successor).toEqual(['--background', '--cos-instance-runtime=profile-rivera']);
    expect(order).toEqual(['recorder', 'sessions', 'durable', 'stage', 'relaunch', 'quit']);
    expect(context.quitting).toBe(true);
  });
});

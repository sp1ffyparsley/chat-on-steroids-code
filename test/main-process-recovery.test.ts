import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { childProcessFailureDiagnostic, createRendererRecoveryGate } from '../src/main/window-lifecycle.js';

const crash = { reason: 'crashed', exitCode: 9 };
const controls = (reload = vi.fn()) => ({ isCurrent: () => true, isStopping: () => false, reload });

describe('bounded view-only renderer recovery', () => {
  it('requests one automatic reload and offers one native fallback for subsequent failures', async () => {
    const gate = createRendererRecoveryGate();
    const callbacks = controls();
    expect(await gate.recover(crash, callbacks)).toMatchObject({ outcome: 'reload_requested', automaticReloadUsed: true, notify: false });
    expect(await gate.recover(crash, callbacks)).toMatchObject({ outcome: 'attention', notify: true });
    expect(await gate.recover(crash, callbacks)).toMatchObject({ outcome: 'attention', notify: false });
    expect(callbacks.reload).toHaveBeenCalledTimes(1);
  });

  it('ignores obsolete windows and clean exits without spending the automatic reload', async () => {
    const gate = createRendererRecoveryGate();
    const callbacks = controls();
    expect(await gate.recover(crash, { ...callbacks, isCurrent: () => false })).toMatchObject({ outcome: 'ignored', automaticReloadUsed: false });
    expect(await gate.recover({ reason: 'clean-exit', exitCode: 0 }, callbacks)).toMatchObject({ outcome: 'ignored', automaticReloadUsed: false });
    expect(await gate.recover(crash, callbacks)).toMatchObject({ outcome: 'reload_requested' });
    expect(callbacks.reload).toHaveBeenCalledTimes(1);
  });

  it('defers during shutdown or Drain, including when lifecycle observation fails', async () => {
    const gate = createRendererRecoveryGate();
    const callbacks = controls();
    expect(await gate.recover(crash, { ...callbacks, isStopping: () => true })).toMatchObject({ outcome: 'deferred', automaticReloadUsed: false });
    expect(await gate.recover(crash, { ...callbacks, isStopping: () => { throw new Error('private state'); } })).toMatchObject({ outcome: 'deferred', automaticReloadUsed: false });
    expect(callbacks.reload).not.toHaveBeenCalled();
  });

  it('contains reload failure without leaking its message or resetting the retry budget', async () => {
    const gate = createRendererRecoveryGate();
    const reload = vi.fn(() => { throw new Error('SECRET private draft'); });
    const failure = await gate.recover({ reason: 'SECRET private draft', exitCode: NaN }, controls(reload));
    expect(failure).toEqual({ outcome: 'attention', reason: 'unknown', exitCode: null, automaticReloadUsed: true, notify: true });
    expect(JSON.stringify(gate.snapshot())).not.toContain('SECRET');
    expect(await gate.recover(crash, controls(reload))).toMatchObject({ outcome: 'attention', notify: false });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('preserves a newer crash while the original reload is still pending', async () => {
    const gate = createRendererRecoveryGate();
    let release!: () => void;
    const reload = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = gate.recover(crash, controls(reload));
    expect(await gate.recover({ reason: 'oom', exitCode: 7 }, controls(reload)))
      .toMatchObject({ outcome: 'attention', reason: 'oom', notify: true });
    release();
    expect(await pending).toMatchObject({ outcome: 'superseded', notify: false });
    expect(gate.snapshot()).toMatchObject({ outcome: 'attention', reason: 'oom' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each(['stopping', 'replacement'] as const)('suppresses late fallback after %s', async change => {
    const gate = createRendererRecoveryGate();
    let release!: () => void;
    let stopping = false, current = true;
    const reload = () => new Promise<void>((_resolve, reject) => { release = () => reject(new Error('private reason')); });
    const pending = gate.recover(crash, { reload, isCurrent: () => current, isStopping: () => stopping });
    if (change === 'stopping') stopping = true; else current = false;
    release();
    expect(await pending).toMatchObject({ outcome: change === 'stopping' ? 'deferred' : 'superseded', notify: false });
  });

  it('returns diagnostic copies instead of exposing mutable internal state', async () => {
    const gate = createRendererRecoveryGate();
    await gate.recover(crash, controls());
    const snapshot = gate.snapshot()!;
    snapshot.automaticReloadUsed = false;
    expect(gate.snapshot()?.automaticReloadUsed).toBe(true);
  });
});

describe('auxiliary-process fault isolation', () => {
  it('reports only bounded categories and never requests tool or app restart', () => {
    expect(childProcessFailureDiagnostic({ type: 'GPU', reason: 'crashed', exitCode: 3221226505 }))
      .toEqual({ processType: 'gpu', reason: 'crashed', exitCode: 3221226505, action: 'inspect' });
    const diagnostic = childProcessFailureDiagnostic({ type: 'SECRET service name', reason: 'SECRET request', exitCode: Infinity });
    expect(diagnostic).toEqual({ processType: 'other', reason: 'unknown', exitCode: null, action: 'inspect' });
    expect(JSON.stringify(diagnostic)).not.toContain('SECRET');
  });
});

// Execute the actual Main bindings with native objects replaced by small event sources.
// This exercises owner/lifecycle checks without starting Electron or sending any work.
const mainSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
const handlerStart = mainSource.indexOf('async function handleRendererFailure(');
const handlerSource = mainSource.slice(handlerStart, mainSource.indexOf('\nfunction createWindow()', handlerStart));
const rendererBindingStart = mainSource.indexOf("createdWindow.webContents.on('render-process-gone'");
const rendererBinding = mainSource.slice(rendererBindingStart,
  mainSource.indexOf("\n  window.webContents.on('before-input-event'", rendererBindingStart));
const childBindingStart = mainSource.indexOf("if (ownsAppRuntime(hasSingleInstanceLock)) app.on('child-process-gone'");
const childBinding = mainSource.slice(childBindingStart, mainSource.indexOf('\nconst processCreationTime', childBindingStart));

function mainFixture() {
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, reload: vi.fn() });
  const owner = { webContents, isDestroyed: () => false };
  let mode = 'open';
  let activationDisabled = false;
  const runtime = {
    window: owner as typeof owner | null, createdWindow: owner,
    quitting: false, shutdownStarted: false,
    windowActivation: { isDisabled: () => activationDisabled },
    profileWorkAdmission: { snapshot: () => ({ mode }) },
    rendererRecovery: createRendererRecoveryGate(),
    dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
    logEvent: vi.fn(),
    // Any accidental change from view recovery into operation recovery is observable.
    resumeAutomationAfterExplicitRequest: vi.fn(), applyAutomationPause: vi.fn(),
    retryInput: vi.fn(), cancelInput: vi.fn(),
    handleRendererFailure: undefined as unknown as (nativeOwner: typeof owner, details: typeof crash) => Promise<void>
  };
  vm.runInNewContext(stripTypeScriptTypes(handlerSource), runtime);
  vm.runInNewContext(stripTypeScriptTypes(rendererBinding), runtime);
  return {
    runtime, owner, webContents,
    fail: (details = crash) => runtime.handleRendererFailure(owner, details),
    setMode: (value: string) => { mode = value; },
    disableActivation: () => { activationDisabled = true; }
  };
}

describe('Main native fault bindings', () => {
  it('reloads once through the real renderer event, then offers one dismissible native fallback', async () => {
    const f = mainFixture();
    f.webContents.emit('render-process-gone', {}, crash);
    await vi.waitFor(() => expect(f.runtime.logEvent).toHaveBeenCalledWith('window.renderer.failure',
      expect.stringContaining('outcome=reload_requested'), 'warn'));
    expect(f.webContents.reload).toHaveBeenCalledTimes(1);
    await f.fail();
    await f.fail();
    expect(f.runtime.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(f.runtime.dialog.showMessageBox).toHaveBeenCalledWith(f.owner,
      expect.objectContaining({ buttons: ['Reload view', 'Dismiss'], cancelId: 1 }));
    expect(f.webContents.reload).toHaveBeenCalledTimes(1);
    expect(f.runtime.resumeAutomationAfterExplicitRequest).not.toHaveBeenCalled();
    expect(f.runtime.applyAutomationPause).not.toHaveBeenCalled();
    expect(f.runtime.retryInput).not.toHaveBeenCalled();
    expect(f.runtime.cancelInput).not.toHaveBeenCalled();
  });

  it('allows an explicit native view reload without restoring the automatic reload budget', async () => {
    const f = mainFixture();
    f.runtime.dialog.showMessageBox.mockResolvedValue({ response: 0 });
    await f.fail();
    await f.fail();
    await f.fail();
    expect(f.webContents.reload).toHaveBeenCalledTimes(2);
    expect(f.runtime.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(f.runtime.rendererRecovery.snapshot()).toMatchObject({ automaticReloadUsed: true, notify: false });
  });

  it.each(['quitting', 'shutdown', 'activation', 'draining', 'replacement'] as const)
    ('rejects a late native reload after %s', async lifecycle => {
      const f = mainFixture();
      await f.fail();
      let respond!: (choice: { response: number }) => void;
      f.runtime.dialog.showMessageBox.mockImplementation(() => new Promise(resolve => { respond = resolve; }));
      const pending = f.fail();
      await vi.waitFor(() => expect(f.runtime.dialog.showMessageBox).toHaveBeenCalledTimes(1));
      if (lifecycle === 'quitting') f.runtime.quitting = true;
      if (lifecycle === 'shutdown') f.runtime.shutdownStarted = true;
      if (lifecycle === 'activation') f.disableActivation();
      if (lifecycle === 'draining') f.setMode('draining');
      if (lifecycle === 'replacement') f.runtime.window = null;
      respond({ response: 0 });
      await pending;
      expect(f.webContents.reload).toHaveBeenCalledTimes(1);
      expect(f.runtime.logEvent).not.toHaveBeenCalledWith('window.renderer.manual-reload', expect.anything());
    });

  it('contains native reload and dialog failures with bounded diagnostic messages', async () => {
    const f = mainFixture();
    f.webContents.reload.mockImplementation(() => { throw new Error('SECRET_DRAFT'); });
    f.runtime.dialog.showMessageBox.mockRejectedValue(new Error('SECRET_PATH'));
    await f.fail({ reason: 'SECRET_REQUEST', exitCode: 9 });
    await f.fail();
    expect(f.runtime.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(f.webContents.reload).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.runtime.logEvent.mock.calls)).not.toContain('SECRET');
    expect(f.runtime.logEvent).toHaveBeenCalledWith('window.renderer.recovery-unavailable', expect.any(String), 'warn');
  });

  it('reports an auxiliary failure without quitting Main, leaking service names, or restarting work', () => {
    const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
    const runtime = { app, ownsAppRuntime: (lock: boolean) => lock, hasSingleInstanceLock: true,
      quitting: false, shutdownStarted: false, childProcessFailureDiagnostic, logEvent: vi.fn() };
    vm.runInNewContext(childBinding, runtime);
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'oom', exitCode: 9, name: 'SECRET_DRAFT' });
    expect(runtime.logEvent).toHaveBeenCalledWith('app.auxiliary.failure', 'type=gpu reason=oom exit=9 action=inspect', 'warn');
    app.emit('child-process-gone', {}, { type: 'SECRET_PATH', reason: 'SECRET_DRAFT' });
    expect(JSON.stringify(runtime.logEvent.mock.calls)).not.toContain('SECRET');
    const calls = runtime.logEvent.mock.calls.length;
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 });
    runtime.shutdownStarted = true;
    app.emit('child-process-gone', {}, crash);
    expect(runtime.logEvent).toHaveBeenCalledTimes(calls);
    expect(app.quit).not.toHaveBeenCalled();
  });
});

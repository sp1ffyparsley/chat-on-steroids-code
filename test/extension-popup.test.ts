import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
let popup: JSDOM | undefined;
afterEach(() => { popup?.window.close(); });

function openPopup(reload: () => void, url = 'https://extension-popup.test/', remove = vi.fn(), sendMessage?: (message: any) => Promise<any>, storage?: { get: (keys: string[]) => Promise<any>, set: (patch: Record<string, unknown>) => Promise<any> }, permissions?: { contains: () => Promise<boolean>; request: () => Promise<boolean> }) {
  popup = new JSDOM(html, { url, runScripts: 'outside-only' });
  const unavailable = () => new Promise(() => undefined);
  Object.assign(popup.window, {
    chrome: {
      runtime: { reload, sendMessage: async (message: any) => {
        const reply = sendMessage ? await sendMessage(message)
          : message.type === 'reloadCompanion' ? { ok: true, reloading: true } : await unavailable();
        // The production worker, not the popup, owns the destructive call after its checks.
        if (message.type === 'reloadCompanion' && reply?.ok === true && reply.reloading === true) reload();
        return reply;
      } },
      storage: { local: storage || { get: async () => ({}), set: async () => undefined } },
      permissions: permissions || { contains: async () => false, request: async () => false },
      tabs: { getCurrent: (callback: (tab: { id: number }) => void) => callback({ id: 71 }), remove }
    },
    setInterval: () => 0
  });
  popup.window.eval(script);
  return popup.window.document;
}

const accountChoiceKey = 'popupAccountChoiceInstanceId';

it.each([
  ['ready', 'ready', 'ok'], ['paused', 'paused in CoS', 'off'],
  ['policy-unverified', 'waiting for policy', 'wait'], ['route-unverified', 'waiting for chat', 'wait'],
  ['owner-unavailable', 'needs attention', 'no'], ['error', 'needs attention', 'no'],
  ['unexpected-private-value', 'needs attention', 'no']
])('shows loaded approval health outside collapsed details (%s)', async (state, label, style) => {
  const send = vi.fn(async (message: any) => message.type === 'status'
    ? { connected: true, paired: true, compatible: true }
    : message.type === 'tabStatus' ? { isChat: true, recorder: true,
      page: { nativeApproval: { protocol: 1, state }, events: 0 } } : {});
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  await vi.waitFor(() => expect(document.getElementById('approvalStatus')?.textContent).toContain(`Native approvals: ${label}.`));
  expect(document.getElementById('approvalStatus')?.getAttribute('data-health')).toBe(style);
  expect(document.getElementById('r-approval')?.closest('details')).toBeNull();
  expect(document.getElementById('approvalStatus')?.closest('details')).toBeNull();
  expect(document.getElementById('approvalStatus')?.getAttribute('role')).toBe('status');
  expect(document.getElementById('approvalStatus')?.textContent).not.toContain('unexpected-private-value');
  expect(send.mock.calls.every(([message]) => ['status', 'tabStatus', 'accountChoices'].includes(message.type))).toBe(true);
  expect(document.querySelector('#r-approval input')).toBeNull();
});

it.each([undefined, { protocol: 0, state: 'adapter-unavailable' }, { protocol: 2, state: 'ready' }])(
  'does not label an old, missing or incompatible approval handler ready (%j)', async nativeApproval => {
    const document = openPopup(vi.fn(), undefined, vi.fn(), async message => message.type === 'status'
      ? { connected: true, paired: true, compatible: true }
      : message.type === 'tabStatus' ? { isChat: true, recorder: true, page: { nativeApproval, events: 0 } } : {});
    await vi.waitFor(() => expect(document.getElementById('approvalStatus')?.textContent).toContain('Native approvals: needs repair.'));
    expect(document.getElementById('approvalStatus')?.textContent).toContain('installed files alone do not confirm activation');
  });

it('clears a ready claim when the app status request fails', async () => {
  const document = openPopup(vi.fn(), undefined, vi.fn(), async message => {
    if (message.type === 'status') throw new Error('PRIVATE_RUNTIME_FAILURE');
    if (message.type === 'tabStatus') return { isChat: true, recorder: true,
      page: { nativeApproval: { protocol: 1, state: 'ready' }, events: 0 } };
    return {};
  });
  await vi.waitFor(() => expect(document.getElementById('approvalStatus')?.textContent).toContain('Approval status is unavailable'));
  expect(document.body.textContent).not.toContain('PRIVATE_RUNTIME_FAILURE');
});



it.each([true, false, undefined])('shows required-feature evidence outside Advanced (%s)', async available => {
  const send = vi.fn(async (message: any) => {
    if (message.type === 'status') return { connected: true, paired: true, compatible: true, port: 8765 };
    if (message.type === 'tabStatus') return { isChat: true, recorder: true,
      page: { generating: false, events: 0, requiredFeatures: available === undefined ? undefined :
        { promptEnvelope: available, nativeAllowOnce: available } } };
    return { ok: true, accounts: [] };
  });
  const reload = vi.fn();
  const document = openPopup(reload, undefined, vi.fn(), send);
  await vi.waitFor(() => expect(document.getElementById('d-prompt')?.textContent)
    .toBe(available === true ? 'required' : available === false ? 'unavailable' : 'not verified'));
  for (const name of ['prompt', 'approval']) {
    const row = document.getElementById(`r-${name}`)!;
    expect(row.closest('details')).toBeNull();
    expect(row.querySelector('input,button')).toBeNull();
    expect(row.classList.contains(available === true ? 'ok' : available === false ? 'no' : 'wait')).toBe(true);
  }
  if (available === true) {
    const overwrite = document.getElementById('overwriteToggle') as HTMLInputElement;
    overwrite.checked = false; overwrite.dispatchEvent(new popup!.window.Event('change'));
    expect(document.getElementById('r-prompt')!.classList.contains('ok')).toBe(true);
    expect(document.getElementById('r-approval')!.classList.contains('ok')).toBe(true);
  }
  if (available === false) {
    expect(document.getElementById('alert')?.textContent).toContain('Required companion features are unavailable');
    expect(document.getElementById('alert')?.hidden).toBe(false);
  }
  expect(reload).not.toHaveBeenCalled();
  expect(send.mock.calls.some(([message]) => ['reloadCompanion', 'pair', 'settings_set'].includes(message.type))).toBe(false);
});

it.each(['tabStatus', 'status'])('does not retain verified feature status after a failed %s observation', async failure => {
  let broken = false;
  const document = openPopup(vi.fn(), undefined, vi.fn(), async message => {
    if (broken && message.type === failure) throw new Error('PRIVATE_TRANSPORT_ERROR');
    if (message.type === 'status') return { connected: true, paired: true, compatible: true, port: 8765 };
    if (message.type === 'tabStatus') return { isChat: !broken, recorder: true,
      page: broken ? null : { requiredFeatures: { promptEnvelope: true, nativeAllowOnce: true } } };
    return { ok: true, accounts: [] };
  });
  await vi.waitFor(() => expect(document.getElementById('d-prompt')?.textContent).toBe('required'));
  broken = true;
  await Promise.resolve(popup!.window.eval('refresh()')).catch(() => undefined);
  expect(document.getElementById('d-prompt')?.textContent).toBe('not verified');
  expect(document.getElementById('d-approval')?.textContent).toBe('not verified');
  expect(document.body.textContent).not.toContain('PRIVATE_TRANSPORT_ERROR');
});

it.each([false, true])('retains the companion when the worker defers reload (recovery URL=%s)', async recovery => {
  const reload = vi.fn(), remove = vi.fn();
  const send = vi.fn(async (message: any) => message.type === 'reloadCompanion'
    ? { ok: false, error: 'reload_deferred', pendingWork: { journal: 1 } } : {});
  const document = openPopup(reload, recovery
    ? 'https://extension-popup.test/popup.html?clf-reload=1&close=1&nonce=retained' : undefined, remove, send);
  if (!recovery) document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(send.mock.calls.some(([message]) => message.type === 'reloadCompanion')).toBe(true));
  expect(reload).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(document.getElementById('alert')?.textContent).toMatch(/Reload deferred.*saved observation journal entries \(1\)/);
  expect(document.getElementById('alert')?.getAttribute('role')).toBe('alert');
  if (recovery) {
    popup!.window.eval(script);
    expect(remove).not.toHaveBeenCalled();
    expect(send.mock.calls.filter(([message]) => message.type === 'reloadCompanion')).toHaveLength(1);
  }
});

it('reports an uncertain request, not retained-work proof, when the worker response fails', async () => {
  const reload = vi.fn();
  const document = openPopup(reload, undefined, vi.fn(), async message => {
    if (message.type === 'reloadCompanion') throw new Error('old worker unavailable');
    return {};
  });
  document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toMatch(/Reload outcome unknown.*response channel closed or failed/));
  expect(document.getElementById('alert')?.textContent).not.toContain('remains retained');
  expect(reload).not.toHaveBeenCalled();
});

it.each([undefined, null, {}, { ok: true }, { ok: false, error: 'unknown_message' }])('distinguishes refused and uncertain worker replies without a destructive fallback (%j)', async reply => {
  const reload = vi.fn();
  const document = openPopup(reload, undefined, vi.fn(), async () => reply);
  const button = document.getElementById('reloadBtn') as HTMLButtonElement;
  const original = button.textContent;
  button.click();
  await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toContain('Reload outcome unknown'));
  expect(document.getElementById('alert')?.textContent).not.toContain('Reload accepted');
  expect(document.getElementById('alert')?.textContent).not.toContain('saved work remains retained');
  expect(reload).not.toHaveBeenCalled();
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe(original);
});

it('does not falsely report retained work or auto-close after reload destroys its response channel', async () => {
  const reload = vi.fn(), remove = vi.fn();
  const send = vi.fn(async (message: any) => {
    if (message.type === 'reloadCompanion') { reload(); throw new Error('PRIVATE_CHANNEL_DESTROYED'); }
    return {};
  });
  const document = openPopup(reload, 'https://extension-popup.test/popup.html?clf-reload=1&close=1&nonce=destroyed', remove, send);
  await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toContain('Reload outcome unknown'));
  expect(document.getElementById('alert')?.textContent).not.toMatch(/remains retained|PRIVATE_CHANNEL/);
  expect(popup!.window.sessionStorage.getItem('clf-reload-spent:destroyed')).toBe('attempted');
  popup!.window.eval(script);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  expect(send.mock.calls.filter(([message]) => message.type === 'reloadCompanion')).toHaveLength(1);
});

it('shows one bounded-custody check and suppresses duplicate reload requests while it is pending', async () => {
  let release!: (value: any) => void;
  const reload = vi.fn();
  const send = vi.fn(async (message: any) => message.type === 'reloadCompanion'
    ? new Promise(resolve => { release = resolve; }) : {});
  const document = openPopup(reload, undefined, vi.fn(), send);
  const button = document.getElementById('reloadBtn') as HTMLButtonElement;
  button.click(); button.click();
  await vi.waitFor(() => expect(send.mock.calls.filter(([message]) => message.type === 'reloadCompanion')).toHaveLength(1));
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe('Checking saved work…');
  release({ ok: false, error: 'reload_deferred' });
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(reload).not.toHaveBeenCalled();
});

it.each([true, false])('requests optional screenshot permission only from a deliberate button click (granted=%s)', async granted => {
  const request = vi.fn(async () => granted);
  const stored: Record<string, unknown> = {};
  const storage = { get: async () => ({ ...stored }), set: vi.fn(async patch => { Object.assign(stored, patch); }) };
  const document = openPopup(vi.fn(), undefined, vi.fn(), accountPopupSender(), storage,
    { contains: async () => false, request });
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(2));
  expect(request).not.toHaveBeenCalled();
  const button = document.getElementById('debugCaptureBtn') as HTMLButtonElement;
  button.click(); button.click();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
  expect(stored.browserDebugScreenshots).toBe(granted ? true : undefined);
  if (granted) {
    expect(button.textContent).toBe('Disable failure screenshots');
    button.click();
    await vi.waitFor(() => expect(stored.browserDebugScreenshots).toBe(false));
    expect(request).toHaveBeenCalledTimes(1);
  } else expect(document.getElementById('debugCaptureStatus')?.textContent).toContain('did not grant');
});
const popupAccounts = [
  { instanceId: 'profile-Primary', name: 'Primary', port: 8765, compatible: true },
  { instanceId: 'profile-Epsilon', name: 'Epsilon', port: 8771, compatible: true }
];

function accountPopupSender(status: Record<string, unknown> = { connected: false, paired: false }, accounts = popupAccounts) {
  return vi.fn(async (message: any) => {
    if (message.type === 'accountChoices') return { ok: true, accounts };
    if (message.type === 'status') return status;
    if (message.type === 'pairTo') return { ok: false, error: 'account_history_preservation_required', message: 'Unassigned history remains held.' };
    if (message.type === 'reloadCompanion') return { ok: true, reloading: true };
    return {};
  });
}

it('retains an explicit popup account choice after reopen and extension reload even while pairing is held', async () => {
  const stored: Record<string, unknown> = {};
  const storage = { get: vi.fn(async () => ({ ...stored })), set: vi.fn(async (patch: Record<string, unknown>) => { Object.assign(stored, patch); }) };
  const send = accountPopupSender();
  const reload = vi.fn();
  let document = openPopup(reload, undefined, vi.fn(), send, storage);
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(2));
  let select = document.getElementById('accountSelect') as HTMLSelectElement;
  select.value = 'profile-Epsilon'; select.dispatchEvent(new popup!.window.Event('change'));
  await vi.waitFor(() => expect(stored[accountChoiceKey]).toBe('profile-Epsilon'));
  expect(send.mock.calls.some(([message]) => message.type === 'pairTo')).toBe(false);
  document.getElementById('accountConnect')!.click();
  await vi.waitFor(() => expect(document.getElementById('accountStatus')?.textContent).toBe('Unassigned history remains held.'));
  popup!.window.close();
  document = openPopup(reload, undefined, vi.fn(), send, storage);
  await vi.waitFor(() => expect((document.getElementById('accountSelect') as HTMLSelectElement).value).toBe('profile-Epsilon'));
  select = document.getElementById('accountSelect') as HTMLSelectElement;
  select.value = 'profile-Primary'; select.dispatchEvent(new popup!.window.Event('change'));
  select.value = 'profile-Epsilon'; select.dispatchEvent(new popup!.window.Event('change'));
  document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  popup!.window.close();
  document = openPopup(reload, undefined, vi.fn(), send, storage);
  await vi.waitFor(() => expect((document.getElementById('accountSelect') as HTMLSelectElement).value).toBe('profile-Epsilon'));
  expect(send.mock.calls.filter(([message]) => message.type === 'pairTo')).toHaveLength(1);
  expect(send.mock.calls.some(([message]) => ['pair', 'unpair', 'settings_set', 'goal_open'].includes(message.type))).toBe(false);
  expect(storage.set.mock.calls.every(([patch]) => Object.keys(patch).length === 1 && typeof patch[accountChoiceKey] === 'string')).toBe(true);
});

it('restores the draft popup choice while accurately naming the currently paired account', async () => {
  const send = accountPopupSender({ connected: true, paired: true, compatible: true, instanceId: 'profile-Primary', port: 8765 });
  const document = openPopup(vi.fn(), undefined, vi.fn(), send, {
    get: async () => ({ [accountChoiceKey]: 'profile-Epsilon' }), set: vi.fn(async () => undefined)
  });
  await vi.waitFor(() => expect((document.getElementById('accountSelect') as HTMLSelectElement).value).toBe('profile-Epsilon'));
  expect(document.getElementById('accountStatus')?.textContent).toContain('Primary');
  expect(document.getElementById('accountStatus')?.textContent).not.toMatch(/(?:connected|paired) to Epsilon/);
  expect((document.getElementById('accountConnect') as HTMLButtonElement).disabled).toBe(false);
  expect(send.mock.calls.some(([message]) => ['pairTo', 'pair', 'unpair'].includes(message.type))).toBe(false);
});

it.each(['missing', 'deleted', 'incompatible', 'oversized', 'object'])('falls back from a %s saved popup account choice without selecting or pairing it', async mode => {
  const accounts = popupAccounts.map(account => ({ ...account, compatible: mode === 'incompatible' && account.name === 'Epsilon' ? false : account.compatible }));
  const saved = mode === 'missing' ? undefined : mode === 'deleted' ? 'profile-deleted' : mode === 'oversized' ? 'x'.repeat(1000) : mode === 'object' ? { instanceId: 'profile-Epsilon' } : 'profile-Epsilon';
  const current = mode === 'incompatible' ? 'profile-Primary' : 'profile-Epsilon';
  const send = accountPopupSender({ connected: true, paired: true, compatible: true, instanceId: current, port: current === 'profile-Primary' ? 8765 : 8771 }, accounts);
  const set = vi.fn(async () => undefined);
  const document = openPopup(vi.fn(), undefined, vi.fn(), send, { get: async () => ({ [accountChoiceKey]: saved }), set });
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(2));
  expect((document.getElementById('accountSelect') as HTMLSelectElement).value).toBe(current);
  expect(set).not.toHaveBeenCalled();
  expect(send.mock.calls.some(([message]) => ['pairTo', 'pair', 'unpair'].includes(message.type))).toBe(false);
});

it('leaves an incompatible-only popup account unselected and refuses to send it', async () => {
  const send = accountPopupSender({}, [{ ...popupAccounts[1]!, compatible: false }]);
  const document = openPopup(vi.fn(), undefined, vi.fn(), send, { get: async () => ({ [accountChoiceKey]: 'profile-Epsilon' }), set: vi.fn(async () => undefined) });
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(1));
  expect((document.getElementById('accountSelect') as HTMLSelectElement).value).toBe('');
  expect((document.getElementById('accountConnect') as HTMLButtonElement).disabled).toBe(true);
  document.getElementById('accountConnect')!.dispatchEvent(new popup!.window.Event('click'));
  expect(send.mock.calls.some(([message]) => message.type === 'pairTo')).toBe(false);
});

it.each(['read', 'write'])('shows a recoverable popup account preference %s error without exposing private details', async mode => {
  const stored: Record<string, unknown> = {};
  let fail = true;
  const storage = {
    get: async () => { if (mode === 'read' && fail) throw new Error('PRIVATE_LOCAL_STORAGE_ERROR'); return { ...stored }; },
    set: vi.fn(async (patch: Record<string, unknown>) => { if (mode === 'write' && fail) throw new Error('PRIVATE_LOCAL_STORAGE_ERROR'); Object.assign(stored, patch); })
  };
  const send = accountPopupSender();
  const document = openPopup(vi.fn(), undefined, vi.fn(), send, storage);
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(2));
  if (mode === 'read') {
    await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toMatch(/could not load the saved account choice/i));
    expect(document.getElementById('alert')?.hidden).toBe(false);
    expect(document.body.textContent).not.toContain('PRIVATE_LOCAL_STORAGE_ERROR');
  }
  const select = document.getElementById('accountSelect') as HTMLSelectElement;
  select.value = 'profile-Epsilon'; select.dispatchEvent(new popup!.window.Event('change'));
  if (mode === 'read') await vi.waitFor(() => expect(stored[accountChoiceKey]).toBe('profile-Epsilon'));
  else await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toMatch(/could not save the account choice/i));
  if (mode === 'write') {
    expect(document.getElementById('alert')?.hidden).toBe(false);
    expect(document.body.textContent).not.toContain('PRIVATE_LOCAL_STORAGE_ERROR');
    expect(document.getElementById('accountStatus')?.textContent).not.toMatch(/^Connected/);
    fail = false;
    select.value = 'profile-Primary'; select.dispatchEvent(new popup!.window.Event('change'));
    select.value = 'profile-Epsilon'; select.dispatchEvent(new popup!.window.Event('change'));
    await vi.waitFor(() => expect(stored[accountChoiceKey]).toBe('profile-Epsilon'));
  }
  await vi.waitFor(() => expect(document.getElementById('alert')?.hidden).toBe(true));
  expect(send.mock.calls.some(([message]) => ['pairTo', 'pair', 'unpair'].includes(message.type))).toBe(false);
});

it('keeps a newer explicit popup choice when a delayed preference read completes', async () => {
  let release!: (value: unknown) => void;
  const stored: Record<string, unknown> = {};
  const send = accountPopupSender();
  const storage = { get: () => new Promise(resolve => { release = resolve; }), set: vi.fn(async (patch: Record<string, unknown>) => { Object.assign(stored, patch); }) };
  const document = openPopup(vi.fn(), undefined, vi.fn(), send, storage);
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(2));
  const select = document.getElementById('accountSelect') as HTMLSelectElement;
  select.value = 'profile-Epsilon'; select.dispatchEvent(new popup!.window.Event('change'));
  release({ [accountChoiceKey]: 'profile-Primary' });
  await vi.waitFor(() => expect(stored[accountChoiceKey]).toBe('profile-Epsilon'));
  expect(select.value).toBe('profile-Epsilon');
  expect(send.mock.calls.some(([message]) => message.type === 'pairTo')).toBe(false);
});

it('serializes rapid popup choice writes and waits for the latest choice before explicit reload', async () => {
  let release!: () => void;
  const stored: Record<string, unknown> = {};
  const storage = {
    get: async () => ({ ...stored }),
    set: vi.fn(async (patch: Record<string, unknown>) => {
      if (storage.set.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
      Object.assign(stored, patch);
    })
  };
  const reload = vi.fn();
  const send = accountPopupSender();
  const document = openPopup(reload, undefined, vi.fn(), send, storage);
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(2));
  const select = document.getElementById('accountSelect') as HTMLSelectElement;
  select.value = 'profile-Primary'; select.dispatchEvent(new popup!.window.Event('change'));
  await vi.waitFor(() => expect(storage.set).toHaveBeenCalledTimes(1));
  select.value = 'profile-Epsilon'; select.dispatchEvent(new popup!.window.Event('change'));
  document.getElementById('reloadBtn')!.click();
  expect(reload).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(stored[accountChoiceKey]).toBe('profile-Epsilon');
  expect(storage.set).toHaveBeenCalledTimes(2);
  expect(select.value).toBe('profile-Epsilon');
  expect(send.mock.calls.some(([message]) => message.type === 'pairTo')).toBe(false);
});

it('permits explicit Reload after a failed popup preference write and recovers after a selection retry', async () => {
  let fail = true;
  const stored: Record<string, unknown> = {};
  const storage = {
    get: async () => ({ ...stored }),
    set: vi.fn(async (patch: Record<string, unknown>) => {
      if (fail) throw new Error('PRIVATE_PREFERENCE_SAVE_ERROR');
      Object.assign(stored, patch);
    })
  };
  const reload = vi.fn();
  const send = accountPopupSender();
  const document = openPopup(reload, undefined, vi.fn(), send, storage);
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(2));
  const select = document.getElementById('accountSelect') as HTMLSelectElement;
  select.value = 'profile-Epsilon'; select.dispatchEvent(new popup!.window.Event('change'));
  document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toContain('could not save the account choice'));
  await vi.waitFor(() => expect((document.getElementById('reloadBtn') as HTMLButtonElement).disabled).toBe(false));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(select.value).toBe('profile-Epsilon');
  fail = false;
  select.dispatchEvent(new popup!.window.Event('change'));
  document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  expect(stored[accountChoiceKey]).toBe('profile-Epsilon');
  expect(document.body.textContent).not.toContain('PRIVATE_PREFERENCE_SAVE_ERROR');
  expect(send.mock.calls.some(([message]) => ['pairTo', 'pair', 'unpair'].includes(message.type))).toBe(false);
});

it.each(['read', 'write'])('ignores an older popup preference %s rejection after a newer explicit choice', async mode => {
  let reject!: (error: Error) => void;
  const stored: Record<string, unknown> = {};
  const storage = {
    get: () => mode === 'read' ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve({ ...stored }),
    set: vi.fn(async (patch: Record<string, unknown>) => {
      if (mode === 'write' && storage.set.mock.calls.length === 1) await new Promise((_resolve, fail) => { reject = fail; });
      Object.assign(stored, patch);
    })
  };
  const send = accountPopupSender();
  const document = openPopup(vi.fn(), undefined, vi.fn(), send, storage);
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(2));
  const select = document.getElementById('accountSelect') as HTMLSelectElement;
  if (mode === 'write') {
    select.value = 'profile-Primary'; select.dispatchEvent(new popup!.window.Event('change'));
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalledTimes(1));
  }
  select.value = 'profile-Epsilon'; select.dispatchEvent(new popup!.window.Event('change'));
  reject(new Error('PRIVATE_STALE_PREFERENCE_ERROR'));
  await vi.waitFor(() => expect(stored[accountChoiceKey]).toBe('profile-Epsilon'));
  expect(select.value).toBe('profile-Epsilon');
  expect(document.getElementById('alert')?.hidden).toBe(true);
  expect(document.body.textContent).not.toContain('PRIVATE_STALE_PREFERENCE_ERROR');
  expect(send.mock.calls.some(([message]) => ['pairTo', 'pair', 'unpair'].includes(message.type))).toBe(false);
});

it.each(['accept', 'cancel', 'selection-changed', 'wrong-target', 'extra-field', 'bad-count'])
  ('confirms exact retained history in the popup before pairing (%s)', async (mode) => {
    const offer = { version: 1, targetInstanceId: 'profile-business', snapshotDigest: 'b'.repeat(64), journalCount: 1, ordinaryCloseCount: 1 };
    if (mode === 'wrong-target') offer.targetInstanceId = 'profile-Epsilon';
    if (mode === 'extra-field') Object.assign(offer, { force: true });
    if (mode === 'bad-count') offer.ordinaryCloseCount = 0.5;
    let paired = false;
    const send = vi.fn(async (message: any) => {
      if (message.type === 'accountChoices') return { ok: true, accounts: [
        { instanceId: 'profile-business', name: 'Business', port: 8770, compatible: true },
        { instanceId: 'profile-Epsilon', name: 'Epsilon', port: 8771, compatible: true }
      ] };
      if (message.type === 'status') return { connected: paired, paired, compatible: true, instanceId: paired ? 'profile-business' : null };
      if (message.type === 'pairTo') {
        if (message.operatorAdoption) { paired = true; return { ok: true }; }
        return { ok: false, error: 'account_history_adoption_required', operatorAdoption: offer };
      }
      return {};
    });
    const document = openPopup(vi.fn(), undefined, vi.fn(), send);
    await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(2));
    const select = document.getElementById('accountSelect') as HTMLSelectElement;
    select.value = 'profile-business'; select.dispatchEvent(new popup!.window.Event('change'));
    const confirm = vi.spyOn(popup!.window, 'confirm').mockImplementation(() => {
      if (mode === 'selection-changed') { select.value = 'profile-Epsilon'; select.dispatchEvent(new popup!.window.Event('change')); }
      return mode !== 'cancel';
    });
    document.getElementById('accountConnect')!.click();
    await vi.waitFor(() => expect(document.getElementById('accountStatus')?.dataset.actionResult).toBe('1'));
    const calls = send.mock.calls.filter(([row]) => row.type === 'pairTo');
    expect(calls).toHaveLength(mode === 'accept' ? 2 : 1);
    expect(paired).toBe(mode === 'accept');
    expect(confirm).toHaveBeenCalledTimes(['wrong-target', 'extra-field', 'bad-count'].includes(mode) ? 0 : 1);
    if (mode === 'accept') {
      expect(confirm.mock.calls[0]![0]).toMatch(/Business[\s\S]*original account was not recorded[\s\S]*misfile/i);
      expect(calls[1]![0]).toEqual({ type: 'pairTo', instanceId: 'profile-business', operatorAdoption: offer });
    }
    expect(send.mock.calls.some(([row]) => ['goal_open', 'settings_set', 'unpair'].includes(row.type))).toBe(false);
  });

it.each(['accept', 'close-only', 'observations-only', 'cancel', 'retarget'])('offers preservation and new-chat work without history association (%s)', async mode => {
  const offer = { version: 1, targetInstanceId: 'profile-business', snapshotDigest: 'c'.repeat(64), journalCount: mode === 'close-only' ? 0 : 2, ordinaryCloseCount: mode === 'observations-only' ? 0 : 1 };
  const accepts = ['accept', 'close-only'].includes(mode);
  let paired = false;
  const send = vi.fn(async (message: any) => {
    if (message.type === 'accountChoices') return { ok: true, accounts: [
      { instanceId: 'profile-business', name: 'Business', port: 8770, compatible: true },
      { instanceId: 'profile-Epsilon', name: 'Epsilon', port: 8771, compatible: true }
    ] };
    if (message.type === 'status') return { connected: paired, paired, compatible: true, instanceId: paired ? 'profile-business' : null };
    if (message.type === 'pairTo') {
      if (message.operatorPreservation) { paired = true; return { ok: true }; }
      return { ok: false, error: 'account_history_preservation_required', operatorPreservation: offer,
        historyEligibility: 'terminal_mismatch' };
    }
    return {};
  });
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(2));
  const select = document.getElementById('accountSelect') as HTMLSelectElement;
  select.value = 'profile-business'; select.dispatchEvent(new popup!.window.Event('change'));
  const confirm = vi.spyOn(popup!.window, 'confirm').mockImplementation(() => {
    if (mode === 'retarget') select.value = 'profile-Epsilon';
    return mode !== 'cancel';
  });
  document.getElementById('accountConnect')!.click();
  await vi.waitFor(() => expect(document.getElementById('accountStatus')?.dataset.actionResult).toBe('1'));
  expect(confirm).toHaveBeenCalledTimes(mode === 'observations-only' ? 0 : 1);
  if (mode !== 'observations-only') {
    expect(confirm.mock.calls[0]![0]).toMatch(/Preserve unassigned history[\s\S]*Old unassigned conversations remain held[\s\S]*new chat/);
    expect(confirm.mock.calls[0]![0]).not.toContain('misfile');
  }
  const calls = send.mock.calls.filter(([message]) => message.type === 'pairTo');
  expect(calls).toHaveLength(accepts ? 2 : 1);
  if (accepts) expect(calls[1]![0]).toEqual({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer });
  expect(send.mock.calls.some(([message]) => message.operatorAdoption || ['settings_set', 'unpair', 'goal_open'].includes(message.type))).toBe(false);
});

it.each(['wrong-target', 'hidden-extra', 'accessor', 'wrong-key', 'missing-offer'])
  ('refuses malformed preservation offers in the popup (%s)', async mode => {
    const offer = { version: 1, targetInstanceId: 'profile-business', snapshotDigest: 'c'.repeat(64), journalCount: 0, ordinaryCloseCount: 1 };
    const getter = vi.fn(() => 0);
    if (mode === 'wrong-target') offer.targetInstanceId = 'profile-Epsilon';
    if (mode === 'hidden-extra') Object.defineProperty(offer, 'force', { value: true });
    if (mode === 'accessor') Object.defineProperty(offer, 'journalCount', { get: getter, enumerable: true });
    const diagnostic = 'This Chrome profile still has pending CoS work: chat-close receipts (1). History eligibility diagnostic: terminal_mismatch. Terminal custody diagnostic: monitoring_off. Recovery protocol 1.';
    const send = vi.fn(async (message: any) => {
      if (message.type === 'accountChoices') return { ok: true, accounts: [
        { instanceId: 'profile-business', name: 'Business', port: 8770, compatible: true }
      ] };
      if (message.type === 'status') return { connected: false, paired: false, instanceId: null };
      if (message.type === 'pairTo') return { ok: false, error: 'account_history_preservation_required', message: diagnostic,
        ...(mode === 'wrong-key' ? { operatorAdoption: offer } : mode === 'missing-offer' ? {} : { operatorPreservation: offer }) };
      return {};
    });
    const document = openPopup(vi.fn(), undefined, vi.fn(), send);
    await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(1));
    const confirm = vi.spyOn(popup!.window, 'confirm').mockReturnValue(true);
    document.getElementById('accountConnect')!.click();
    await vi.waitFor(() => expect(document.getElementById('accountStatus')?.dataset.actionResult).toBe('1'));
    expect(confirm).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(send.mock.calls.filter(([message]) => message.type === 'pairTo')).toHaveLength(1);
    expect(document.getElementById('accountStatus')?.textContent).toBe(diagnostic);
    expect(send.mock.calls.some(([message]) => message.operatorAdoption || message.operatorPreservation || ['settings_set', 'unpair', 'goal_open'].includes(message.type))).toBe(false);
  });

it('unlocks the explicit pairing retry after a rejected transport without leaking the error or retrying automatically', async () => {
  let attempts = 0;
  const send = vi.fn(async (message: any) => {
    if (message.type === 'status') return { connected: false, paired: false, compatible: true };
    if (message.type === 'accountChoices') return { ok: true, accounts: [] };
    if (message.type === 'pair') {
      attempts++;
      if (attempts === 1) throw new Error('PRIVATE_TRANSPORT_CREDENTIAL');
      return { ok: false, error: 'account_busy' };
    }
    return {};
  });
  const reload = vi.fn();
  const document = openPopup(reload, undefined, vi.fn(), send);
  const button = document.getElementById('retryBtn') as HTMLButtonElement;
  await vi.waitFor(() => expect(document.getElementById('state')?.textContent).toBe('App not reachable'));
  button.click();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(attempts).toBe(1);
  expect(document.getElementById('why')?.textContent).toContain('Retained work is unchanged');
  expect(document.body.textContent).not.toContain('PRIVATE_TRANSPORT_CREDENTIAL');
  button.click();
  await vi.waitFor(() => expect(attempts).toBe(2));
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(reload).not.toHaveBeenCalled();
  expect(send.mock.calls.some(([row]) => ['goal_open', 'settings_set', 'unpair', 'pairTo'].includes(row.type))).toBe(false);
});

it('keeps one pairing retry in flight through its status refresh', async () => {
  let release: (value: unknown) => void = () => undefined;
  let attempts = 0;
  const send = vi.fn(async (message: any) => {
    if (message.type === 'status') return { connected: false, paired: false, compatible: true };
    if (message.type === 'accountChoices') return { ok: true, accounts: [] };
    if (message.type === 'pair') { attempts++; return new Promise(resolve => { release = resolve; }); }
    return {};
  });
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  const button = document.getElementById('retryBtn') as HTMLButtonElement;
  button.click(); button.dispatchEvent(new popup!.window.Event('click'));
  expect(button.disabled).toBe(true);
  expect(attempts).toBe(1);
  release({ ok: false, error: 'account_busy' });
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(attempts).toBe(1);
});

it('does not let an older popup refresh overwrite the verified post-pair connection', async () => {
  let releaseOld: (value: unknown) => void = () => undefined;
  let statusCalls = 0;
  const send = vi.fn(async (message: any) => {
    if (message.type === 'accountChoices') return { ok: true, accounts: [
      { instanceId: 'profile-business', name: 'Business', port: 8770, compatible: true }
    ] };
    if (message.type === 'status') {
      if (++statusCalls === 1) return new Promise(resolve => { releaseOld = resolve; });
      return { connected: true, paired: true, compatible: true, port: 8770, instanceId: 'profile-business' };
    }
    if (message.type === 'pairTo') return { ok: true };
    return {};
  });
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(1));
  const select = document.getElementById('accountSelect') as HTMLSelectElement;
  select.value = 'profile-business'; select.dispatchEvent(new popup!.window.Event('change'));
  document.getElementById('accountConnect')!.click();
  await vi.waitFor(() => expect(document.getElementById('accountStatus')?.textContent).toBe('Connected to Business.'));
  releaseOld({ connected: false, paired: false, compatible: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.getElementById('state')?.textContent).toBe('App reachable · Port 8770');
  expect(document.getElementById('accountStatus')?.textContent).toBe('Connected to Business.');
  expect(send.mock.calls.filter(([row]) => row.type === 'pairTo')).toHaveLength(1);
  expect(send.mock.calls.some(([row]) => ['goal_open', 'settings_set', 'unpair'].includes(row.type))).toBe(false);
});

it('does not let a late pairing retry rejection repaint a newer selected-account connection', async () => {
  let rejectRetry: (error: Error) => void = () => undefined;
  let paired = false;
  const send = vi.fn(async (message: any) => {
    if (message.type === 'accountChoices') return { ok: true, accounts: [
      { instanceId: 'profile-business', name: 'Business', port: 8770, compatible: true }
    ] };
    if (message.type === 'status') return { connected: paired, paired, compatible: true, port: 8770,
      instanceId: paired ? 'profile-business' : null };
    if (message.type === 'pair') return new Promise((_resolve, reject) => { rejectRetry = reject; });
    if (message.type === 'pairTo') { paired = true; return { ok: true }; }
    return {};
  });
  const reload = vi.fn();
  const document = openPopup(reload, undefined, vi.fn(), send);
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(1));
  const retry = document.getElementById('retryBtn') as HTMLButtonElement;
  retry.click();
  expect(retry.disabled).toBe(true);
  const select = document.getElementById('accountSelect') as HTMLSelectElement;
  select.value = 'profile-business'; select.dispatchEvent(new popup!.window.Event('change'));
  document.getElementById('accountConnect')!.click();
  await vi.waitFor(() => expect(document.getElementById('accountStatus')?.textContent).toBe('Connected to Business.'));
  const why = document.getElementById('why')!;
  const healthy = { text: why.textContent, className: why.className };
  rejectRetry(new Error('PRIVATE_OLD_RETRY_TRANSPORT'));
  await vi.waitFor(() => expect(retry.disabled).toBe(false));
  expect({ text: why.textContent, className: why.className }).toEqual(healthy);
  expect(document.getElementById('state')?.textContent).toBe('App reachable · Port 8770');
  expect(document.getElementById('accountStatus')?.textContent).toBe('Connected to Business.');
  expect(send.mock.calls.filter(([row]) => row.type === 'pair')).toHaveLength(1);
  expect(send.mock.calls.filter(([row]) => row.type === 'pairTo')).toHaveLength(1);
  expect(document.body.textContent).not.toContain('PRIVATE_OLD_RETRY_TRANSPORT');
  expect(reload).not.toHaveBeenCalled();
});

it('retains the selected-account pending view when an earlier Retry rejects before the account result', async () => {
  let rejectRetry!: (error: Error) => void;
  let releaseAccount!: (value: unknown) => void;
  const send = vi.fn(async (message: any) => {
    if (message.type === 'accountChoices') return { ok: true, accounts: [
      { instanceId: 'profile-business', name: 'Business', port: 8770, compatible: true }
    ] };
    if (message.type === 'status') return { connected: false, paired: false, compatible: true };
    if (message.type === 'pair') return new Promise((_resolve, reject) => { rejectRetry = reject; });
    if (message.type === 'pairTo') return new Promise(resolve => { releaseAccount = resolve; });
    return {};
  });
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(1));
  const retry = document.getElementById('retryBtn') as HTMLButtonElement;
  retry.click();
  document.getElementById('accountConnect')!.click();
  const why = document.getElementById('why')!;
  const pending = { text: why.textContent, className: why.className };
  rejectRetry(new Error('PRIVATE_SUPERSEDED_RETRY'));
  await vi.waitFor(() => expect(retry.disabled).toBe(false));
  expect({ text: why.textContent, className: why.className }).toEqual(pending);
  expect((document.getElementById('accountConnect') as HTMLButtonElement).disabled).toBe(true);
  releaseAccount({ ok: false, message: 'The selected account remains held.' });
  await vi.waitFor(() => expect(document.getElementById('accountStatus')?.textContent).toBe('The selected account remains held.'));
  expect(send.mock.calls.filter(([row]) => row.type === 'pair')).toHaveLength(1);
  expect(send.mock.calls.filter(([row]) => row.type === 'pairTo')).toHaveLength(1);
});

it('unlocks a current Retry and explains failure when its own status refresh rejects', async () => {
  let statuses = 0;
  const send = vi.fn(async (message: any) => {
    if (message.type === 'accountChoices') return { ok: true, accounts: [] };
    if (message.type === 'status') {
      if (++statuses > 1) throw new Error('PRIVATE_CURRENT_STATUS_TRANSPORT');
      return { connected: false, paired: false, compatible: true };
    }
    return {};
  });
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  await vi.waitFor(() => expect(document.getElementById('state')?.textContent).toBe('App not reachable'));
  const retry = document.getElementById('retryBtn') as HTMLButtonElement;
  retry.click();
  await vi.waitFor(() => expect(retry.disabled).toBe(false));
  expect(document.getElementById('why')?.textContent).toContain('Retained work is unchanged');
  expect(document.body.textContent).not.toContain('PRIVATE_CURRENT_STATUS_TRANSPORT');
  expect(send.mock.calls.filter(([row]) => row.type === 'pair')).toHaveLength(1);
});

it('shows the private companion display name without changing its runtime identity', () => {
  const document = openPopup(vi.fn());
  expect(document.title).toBe('Luna Forge X7 Companion');
  expect(document.querySelector('h1')?.textContent).toBe('Luna Forge X7 Companion');
});

it('does not duplicate a pending popup choice or claim connected from an unverified success reply', async () => {
  let settle: (value: any) => void = () => undefined;
  const send = vi.fn(async (message: any) => {
    if (message.type === 'accountChoices') return { ok: true, accounts: [
      { instanceId: 'profile-business', name: 'Business', port: 8770, compatible: true }
    ] };
    if (message.type === 'status') return { connected: false, paired: false };
    if (message.type === 'pairTo') return new Promise(resolve => { settle = resolve; });
    return {};
  });
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  await vi.waitFor(() => expect(document.querySelectorAll('#accountSelect option')).toHaveLength(1));
  const button = document.getElementById('accountConnect')!;
  button.click();
  button.dispatchEvent(new popup!.window.Event('click'));
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect((document.getElementById('accountSelect') as HTMLSelectElement).disabled).toBe(true);
  expect(send.mock.calls.filter(([row]) => row.type === 'pairTo')).toHaveLength(1);
  settle({ ok: true });
  await vi.waitFor(() => expect(document.getElementById('accountStatus')!.dataset.actionResult).toBe('1'));
  expect(document.getElementById('accountStatus')!.textContent).not.toMatch(/^Connected/);
  expect((button as HTMLButtonElement).disabled).toBe(false);
});

it('does not reload an ordinary popup and requests a worker-owned reload on explicit click', async () => {
  const reload = vi.fn();
  const document = openPopup(reload);
  expect(reload).not.toHaveBeenCalled();
  document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it('supports an explicit local recovery URL without reloading ordinary popup opens', async () => {
  const reload = vi.fn();
  openPopup(reload, 'https://extension-popup.test/popup.html?clf-reload=1&nonce=build-19');
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  // A retained recovery tab must not reload in a loop even if its opaque test origin refuses
  // the query-removing history update.
  popup!.window.eval(script);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('retains a marked recovery tab because a reload response is not post-reload loaded-build proof', async () => {
  const reload = vi.fn();
  const remove = vi.fn();
  openPopup(reload, 'https://extension-popup.test/popup.html?clf-reload=1&close=1&nonce=build-23', remove);
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(remove).not.toHaveBeenCalled();
  // Even a returned response cannot prove that the new worker/build became active.
  popup!.window.eval(script);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
});

it('reports only app reachability from compatible health and pairing', () => {
  const document = openPopup(vi.fn());
  expect(document.getElementById('pill')!.classList.contains('off')).toBe(true);
  (popup!.window as any).paintHeader({ connected: true, paired: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).not.toContain('Connected');
  (popup!.window as any).paintHeader({ connected: true, paired: true, compatible: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).toBe('App reachable · Port 8765');
  expect(document.getElementById('state')!.textContent).not.toContain('Connected');
  (popup!.window as any).paintHeader({ connected: false });
  expect(document.getElementById('state')!.textContent).toBe('App not reachable');
});

it('shows an explicit account choice instead of treating a second COS bridge as unreachable', () => {
  const document = openPopup(vi.fn());
  expect(document.getElementById('accountSelect')).not.toBeNull();
  expect(document.getElementById('accountConnect')).not.toBeNull();
  (popup!.window as any).paintHeader({ connected: false, paired: false, instanceError: 'instance_selection_required' });
  expect(document.getElementById('state')!.textContent).toBe('Choose COS account');
  expect((document.getElementById('retryBtn') as HTMLButtonElement).hidden).toBe(true);
});

it('explains manual mismatch recovery with both versions and keeps reload available', () => {
  const document = openPopup(vi.fn());
  (popup!.window as any).paintAlert({ connected: true, paired: true, compatible: false, appVersion: '2.0.7', appProtocol: 13, extensionVersion: '2.0.6', extensionProtocol: 12 }, null);
  const alert = document.getElementById('alert')!;
  expect(alert.textContent).toContain('2.0.7'); expect(alert.textContent).toContain('2.0.6');
  expect(alert.textContent).toContain('protocol 13'); expect(alert.textContent).toContain('protocol 12');
  expect(alert.textContent).toContain('Developer mode'); expect(alert.textContent).toContain('Open extension folder');
  expect(document.getElementById('reloadBtn')).not.toBeNull();
});

it('requires this chat session receipt before claiming delivery even with global delivery success', () => {
  openPopup(vi.fn());
  const info = { isChat: true, recorder: true, page: { events: 3 }, pending: 0, delivery: { ok: true, total: 50 } };
  const waiting = (popup!.window as any).pipeline(info, true);
  expect(waiting.sent[0]).toBe('running');
  expect(waiting.proc[0]).toBe('running');
  expect(waiting.why[1]).toContain('this chat’s session receipt');
  const recorded = (popup!.window as any).pipeline({ ...info, page: { events: 3, session: 'local-session' } }, true);
  expect(recorded.sent[0]).toBe('off');
  expect(recorded.proc[0]).toBe('off');
  expect(recorded.why[1]).toContain('latest turn');
});

it('distinguishes queued, received, owner confirmed and recorded tool activity for the current ID', () => {
  openPopup(vi.fn());
  const project = (trace: unknown[]) => (popup!.window as any).pipeline({
    isChat: true, recorder: true, pending: 0, delivery: { ok: true, total: 999 },
    page: { events: 1000, session: 'local-session', trace }
  }, true);
  const request = { requestId: 'wfr_current', read: 1, queued: 2 };
  expect(project([request]).sent[0]).toBe('running');
  expect(project([{ ...request, sent: 3 }]).why[1]).toContain('Waiting for owner confirmation');
  const confirmed = project([{ ...request, sent: 3, confirmed: true }]);
  expect(confirmed.proc[0]).toBe('done');
  expect(confirmed.why[1]).toContain('No matching tool activity');
  expect(project([{ ...request, app: 'request_id' }]).why[1]).toContain('matched to recorded tool activity');
  expect(project([]).proc[0]).toBe('off');
});

it('keeps blocked delivery distinct from network unreachability and requires pairing too', () => {
  const document = openPopup(vi.fn());
  (popup!.window as any).paintHeader({ connected: true, paired: false, compatible: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).not.toContain('Connected');
  const result = (popup!.window as any).pipeline({ isChat: true, recorder: true, page: { events: 1 }, pending: 1 }, false);
  expect(result.why[1]).toContain('protocol compatibility');
  expect(result.why[1]).not.toContain('not reachable');
});


it.each([undefined, null, {}, { ok: true }, { ok: false, error: 'unknown_message' }])('keeps an incomplete or legacy worker reply in the unknown state (%j)', async reply => {
  const reload = vi.fn();
  const document = openPopup(reload, undefined, vi.fn(), async () => reply);
  const button = document.getElementById('reloadBtn') as HTMLButtonElement;
  const original = button.textContent;
  button.click();
  const expected = reply && reply.error === 'unknown_message' ? 'did not recognize the reload request' : 'Reload outcome unknown';
  await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toContain(expected));
  expect(reload).not.toHaveBeenCalled();
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe(original);
});


it('gives every current worker pendingWork key a bounded count and an explicit action', () => {
  openPopup(vi.fn());
  const keys = popup!.window.eval('reloadPendingWorkReasonKeys()') as string[];
  const workerKeys = [
    'reload', 'openChatgptTabs', 'documentUnverified', 'pageWorkUnverified', 'inventoryChanged', 'inventoryUnverified',
    'connectionChanged', 'custodyChanged', 'leaseDurabilityUnverified', 'ownerReadFailed', 'ownerReadTimedOut',
    'custodyCheckFailed', 'unverified', 'journal', 'journalWorkers', 'closeOutbox', 'commandAckOutbox',
    'deferredRevivals', 'retiredHelperElections', 'inputOpenings', 'stopOpenings', 'commandTabLeases', 'maintenanceFlight', 'modelCatalogFlight',
    'pluginRefreshFlight', 'projectCreateFlight', 'deferredRecoveryWork', 'tabOperations', 'pendingInputReceipts',
    'pairing', 'commandDelivery', 'closeDelivery', 'journalInFlight', 'browserCapture', 'backgroundWindow',
    'tabRetirement', 'openConversation', 'browserControl', 'browserControlFlight', 'urgentOpen', 'tabCloseReceipts',
    'receiverRepair', 'stopOffers', 'projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner', 'streaming', 'generating',
    'pendingTools', 'jobBusy', 'goalBusy', 'queued', 'projectCreateBusy', 'pluginRefreshBusy', 'modelCatalogBusy', 'desktopInputBusy'
  ];
  expect(keys.sort()).toEqual(workerKeys.sort());
  for (const key of workerKeys) {
    const message = (popup!.window as any).reloadDeferredReason({
      ok: false, error: 'reload_deferred', pendingWork: { [key]: 5001 }
    });
    expect(message).toContain('(4000)');
    expect(message).not.toContain('Current operations or retained helper ownership');
  }
});


it('explains helper-only retained custody and browser-control or tab-operation holds', async () => {
  const send = vi.fn(async (message: any) => message.type === 'reloadCompanion'
    ? { ok: false, error: 'reload_deferred', pendingWork: {
      deferredRevivals: 2, projectCreateOwner: 1, browserControl: 3, browserControlFlight: 1, tabOperations: 4
    } } : {});
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toContain('retained project-creation custody (1)'));
  const alert = document.getElementById('alert')?.textContent || '';
  expect(alert).toContain('saved worker revivals (2)');
  expect(alert).toContain('browser-control lease active (3)');
  expect(alert).toContain('browser-control operation in flight (1)');
  expect(alert).toContain('tab operations in progress (4)');
  expect(alert).not.toContain('Current operations or retained helper ownership');
  expect(send.mock.calls.filter(([row]) => row.type === 'reloadCompanion')).toHaveLength(1);
});


it('explains pending input, command and close receipts without suggesting replay or clearing', async () => {
  const send = vi.fn(async (message: any) => message.type === 'reloadCompanion'
    ? { ok: false, error: 'reload_deferred', pendingWork: {
      pendingInputReceipts: 2, commandAckOutbox: 1, closeOutbox: 3, tabCloseReceipts: 4
    } } : {});
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toContain('pending input receipts (2)'));
  const alert = document.getElementById('alert')?.textContent || '';
  expect(alert).toContain('pending command delivery receipts (1)');
  expect(alert).toContain('pending chat-close receipts (3)');
  expect(alert).toContain('retained tab-close receipts (4)');
  expect(alert).toContain('do not resend input or clear a receipt');
  expect(alert).toContain('do not clear the outbox');
  expect(alert).toContain('do not clear the receipts');
});


it('preserves unknown worker keys and gives a truthful older-worker fallback', async () => {
  const send = vi.fn(async (message: any) => message.type === 'reloadCompanion'
    ? { ok: false, error: 'reload_deferred', pendingWork: { futureCustodyGate: 3 } } : {});
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toContain('Unrecognized worker key "futureCustodyGate" (3)'));
  expect(document.getElementById('alert')?.textContent).toContain('Its meaning is unknown');
  expect(document.getElementById('alert')?.textContent).not.toContain('Current operations or retained helper ownership');
  expect(send.mock.calls.filter(([row]) => row.type === 'reloadCompanion')).toHaveLength(1);
});


it('separates no selected ChatGPT page from companion reachability and retained browser-wide custody', async () => {
  const send = vi.fn(async (message: any) => {
    if (message.type === 'status') return { connected: true, paired: true, compatible: true, port: 8770 };
    if (message.type === 'tabStatus') return { isChat: false, tab: 71, epoch: 4, pending: 0, pendingAll: 0 };
    if (message.type === 'reloadCompanion') return { ok: false, error: 'reload_deferred', pendingWork: { openChatgptTabs: 2 } };
    return {};
  });
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  await vi.waitFor(() => expect(document.getElementById('state')?.textContent).toBe('App reachable · Port 8770'));
  expect(document.getElementById('d-tab')?.textContent).toBe('not selected');
  document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toContain('No ChatGPT page is selected in this popup tab'));
  const alert = document.getElementById('alert')?.textContent || '';
  expect(alert).toContain('ChatGPT tabs still open (2)');
  expect(alert).toContain('separate from extension presence');
  expect(alert).toContain('browser-wide ChatGPT tabs or retained work checked by the worker');
  expect(document.getElementById('state')?.textContent).not.toBe('Companion status unavailable');
});


it('does not confuse a missing worker status reply with no selected ChatGPT page or an absent extension', async () => {
  const send = vi.fn(async (message: any) => {
    if (message.type === 'status') throw new Error('PRIVATE_STATUS_FAILURE');
    if (message.type === 'tabStatus') return { isChat: false, tab: 71, epoch: 4 };
    if (message.type === 'reloadCompanion') return { ok: false, error: 'unknown_message' };
    return {};
  });
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  await vi.waitFor(() => expect(document.getElementById('state')?.textContent).toBe('Companion status unavailable'));
  expect(document.getElementById('d-tab')?.textContent).toBe('not selected');
  document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toContain('did not recognize the reload request'));
  const alert = document.getElementById('alert')?.textContent || '';
  expect(alert).toContain('does not prove the extension is absent');
  expect(alert).toContain('No ChatGPT page is selected in this popup tab');
  expect(alert).not.toContain('PRIVATE_STATUS_FAILURE');
});


it('keeps the newer no-selected-page diagnosis and reload hold when an older refresh completes late', async () => {
  let releaseOldStatus!: (value: any) => void;
  let statusCalls = 0;
  const send = vi.fn(async (message: any) => {
    if (message.type === 'status') {
      statusCalls += 1;
      if (statusCalls === 1) return new Promise(resolve => { releaseOldStatus = resolve; });
      return { connected: true, paired: true, compatible: true, port: 8770 };
    }
    if (message.type === 'tabStatus') return statusCalls === 1
      ? { isChat: true, recorder: true, page: { generating: false }, tab: 71, epoch: 1 }
      : { isChat: false, tab: 72, epoch: 2, pending: 0, pendingAll: 0 };
    if (message.type === 'reloadCompanion') return { ok: false, error: 'reload_deferred', pendingWork: { browserControl: 1 } };
    return {};
  });
  const document = openPopup(vi.fn(), undefined, vi.fn(), send);
  await vi.waitFor(() => expect(typeof releaseOldStatus).toBe('function'));
  await (popup!.window as any).refresh();
  expect(document.getElementById('d-tab')?.textContent).toBe('not selected');
  document.getElementById('reloadBtn')!.click();
  await vi.waitFor(() => expect(document.getElementById('alert')?.textContent).toContain('browser-control lease active (1)'));
  releaseOldStatus({ connected: true, paired: true, compatible: true, port: 8770 });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.getElementById('d-tab')?.textContent).toBe('not selected');
  expect(document.getElementById('alert')?.textContent).toContain('browser-control lease active (1)');
  expect(document.getElementById('alert')?.textContent).toContain('No ChatGPT page is selected in this popup tab');
});

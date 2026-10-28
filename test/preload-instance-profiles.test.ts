import { expect, it, vi } from 'vitest';

const { invoke, expose, on, removeListener } = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ ok: true, data: null })),
  expose: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke, on, removeListener },
  webUtils: { getPathForFile: vi.fn(() => '') }
}));

it('exposes the bounded instance-profile IPC contract with exact named payloads', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];

  await api.getInstanceProfiles();
  await api.listInstanceBrowserProfiles();
  await api.createInstanceProfile('Work', 'Profile 2');
  await api.renameInstanceProfile('profile-2', 'Work account');
  await api.setInstanceBrowserProfile('profile-2', 'Profile 4');
  await api.setInstanceProfileEnabled('profile-2', false);
  await api.removeInstanceProfile('profile-2', 'Work account');
  await api.switchInstanceProfile('profile-2', 'check');
  await api.switchInstanceProfile('profile-2', 'after-work');
  await api.openInstanceProfileBrowser('profile-2');
  await api.copyInstanceConnectorSetup('profile-2');
  await api.refreshInstanceConnector();
  await api.drainInstanceProfile('start');
  await api.drainInstanceProfile('cancel');
  await api.drainInstanceProfile('apply-update');
  await api.drainInstanceProfile('shutdown');

  expect(invoke.mock.calls).toEqual([
    ['instances:get', undefined],
    ['instances:browserProfiles', undefined],
    ['instances:create', { nickname: 'Work', browserProfileDirectory: 'Profile 2' }],
    ['instances:rename', { id: 'profile-2', nickname: 'Work account' }],
    ['instances:setBrowserProfile', { id: 'profile-2', browserProfileDirectory: 'Profile 4' }],
    ['instances:setEnabled', { id: 'profile-2', enabled: false }],
    ['instances:remove', { id: 'profile-2', confirmation: 'Work account' }],
    ['instances:switch', { id: 'profile-2', mode: 'check' }],
    ['instances:switch', { id: 'profile-2', mode: 'after-work' }],
    ['instances:openBrowser', { id: 'profile-2' }],
    ['instances:copyConnectorSetup', { id: 'profile-2' }],
    ['instances:refreshConnector', undefined],
    ['instances:drain', { action: 'start' }],
    ['instances:drain', { action: 'cancel' }],
    ['instances:drain', { action: 'apply-update' }],
    ['instances:drain', { action: 'shutdown' }]
  ]);

  const listener = vi.fn();
  const unsubscribe = api.onInstanceProfilesChanged(listener);
  expect(on).toHaveBeenCalledWith('instances:changed', expect.any(Function));
  const wrapped = on.mock.calls.at(-1)![1];
  const snapshot = { activeProfileId: 'profile-2', profiles: [] };
  wrapped({}, snapshot);
  expect(listener).toHaveBeenCalledWith(snapshot);
  unsubscribe();
  expect(removeListener).toHaveBeenCalledWith('instances:changed', wrapped);
});

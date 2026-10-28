import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const workflow = source.slice(source.indexOf('let pluginRefreshFlight = null;'), source.indexOf('async function catalogProbe('));

// Adapted from atsu6's upstream db347562 / #1538. A retired settings hash may
// land on ChatGPT's home, so opening authority must name the native app route.
it.each(['asdk_app_core', 'asdk_app_plugins'])('opens %s on its exact native settings route with its original refresh id', async appId => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const saved: Record<string, unknown> = {};
  const create = vi.fn(async (url: string) => ({ id: 8, url }));
  const context = vm.createContext({ URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], createChatTab: create,
    call: async () => ({ ok: true, data: { requests: [{ id, appId }] } }),
    chrome: { storage: { session: { get: async () => saved,
      set: async (next: object) => Object.assign(saved, next) } }, tabs: { query: async () => [] } }
  });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);

  await context.run([{}], true);

  const expected = `https://chatgpt.com/settings/plugins-settings/plugin_${appId}?cos-plugin-refresh=${id}`;
  expect(create).toHaveBeenCalledExactlyOnceWith(expected, true);
  const destination = new URL(create.mock.calls[0]![0]);
  expect(destination.origin).toBe('https://chatgpt.com');
  expect(destination.pathname).toBe(`/settings/plugins-settings/plugin_${appId}`);
  expect([...destination.searchParams]).toEqual([['cos-plugin-refresh', id]]);
  expect(destination.hash).toBe('');
  expect(saved.pluginRefreshOwner).toEqual({ id, tab: 8, documentId: null, navigationEpoch: null });
});

it('keeps one operation on its original tab after marker loss, worker restart, and user closure', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const saved: Record<string, unknown> = {};
  const tabDocuments: Record<string, string> = { '8': 'refresh-document-8' };
  const tabEpochs: Record<string, number> = { '8': 4 };
  let tab: { id: number; url: string } | null = null;
  const create = vi.fn(async (url: string) => (tab = { id: 8, url }));
  const update = vi.fn(async (_id: number, patch: { url: string }) => { if (tab) tab.url = patch.url; return tab; });
  const storage = { session: { get: async () => saved, set: async (next: object) => { Object.assign(saved, next); } } };
  const start = () => {
    const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], createChatTab: create,
      tabDocuments, tabEpochs, tabReply: async () => ({ safe: true }),
      call: async () => ({ ok: true, data: { requests: [{ id, appId: null }] } }),
      chrome: { storage, tabs: { query: async () => tab ? [tab] : [], get: async () => { if (!tab) throw Error('closed'); return tab; }, update, sendMessage: async () => ({ ok: true }) } } });
    vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context); return context;
  };
  await start().run([{}], true);
  expect(create).toHaveBeenCalledTimes(1);
  tab!.url = 'https://chatgpt.com/#settings/Plugins/plugin_asdk_app_synthetic';
  await start().run([{}], true);
  expect(create).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith(8, { url: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic` });
  tab = null;
  await start().run([{}], true); await start().run([{}], true);
  expect(create).toHaveBeenCalledTimes(1);
});

it('turns over one missing same-row owner once when an exact operator generation is rearmed', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const receipt = '11111111-2222-4333-8444-555555555555';
  const request = { id, surface: 'core', appId: 'asdk_app_synthetic',
    operatorRearmReceipt: receipt, operatorRearmGeneration: 2 };
  const saved: Record<string, any> = {
    pluginRefreshOwner: { id, tab: 8, documentId: 'missing-document', navigationEpoch: 4 }
  };
  const tabs: Array<{ id: number; url: string; pinned: boolean }> = [];
  const createChatTab = vi.fn(async (url: string) => {
    const tab = { id: 9, url, pinned: false };
    tabs.push(tab);
    return tab;
  });
  const storage = { session: { get: async () => saved,
    set: async (next: object) => Object.assign(saved, next) } };
  const context = vm.createContext({ URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], tabDocuments: {}, tabEpochs: {},
    tabReply: vi.fn(), retireAutomaticTab: vi.fn(), createChatTab,
    call: async () => ({ ok: true, data: { requests: [request] } }),
    chrome: { storage, tabs: { query: async () => tabs,
      get: async (tabId: number) => tabs.find(tab => tab.id === tabId) ?? null,
      update: vi.fn(), sendMessage: vi.fn() } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);

  await context.run([{}], true);
  await context.run([{}], true);

  expect(createChatTab).toHaveBeenCalledTimes(1);
  expect(saved.pluginRefreshOwner).toEqual({ id, tab: 9, documentId: null, navigationEpoch: null });
  expect(saved.pluginRefreshSuppressedOwners).toEqual([]);
  expect(saved.pluginRefreshOperatorTurnovers).toEqual([{ id, receipt, generation: 2 }]);
});

it('does not create a plugin helper in browser-only mode', async () => {
  const create = vi.fn();
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], createChatTab: create,
    call: async () => ({ ok: true, data: { requests: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }] } }),
    chrome: { storage: { session: { get: async () => ({}) } }, tabs: { query: async () => [] } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true, true);
  expect(create).not.toHaveBeenCalled();
});

it('lets an eligible third surface progress when the first two have durable no-reopen custody', async () => {
  const ids = [
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa'
  ];
  const requests = ids.map(id => ({ id }));
  const third = { id: 8,
    url: `https://chatgpt.com/settings/plugins-settings?cos-plugin-refresh=${ids[2]}`,
    pinned: false };
  const retireAutomaticTab = vi.fn();
  const tabReply = vi.fn();
  const sendMessage = vi.fn(async () => ({ ok: true }));
  const createChatTab = vi.fn();
  const saved: Record<string, unknown> = { pluginRefreshSuppressedOwners: ids.slice(0, 2) };
  const context = vm.createContext({ URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    tabDocuments: { '8': 'refresh-document-8' }, tabEpochs: { '8': 4 },
    tabReply, retireAutomaticTab, createChatTab,
    call: async () => ({ ok: true, data: { requests } }),
    chrome: { storage: { session: { get: async () => saved,
      set: async (next: object) => Object.assign(saved, next) } },
      tabs: { query: async () => [third], get: async () => third, sendMessage } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);

  await context.run([{}, {}, {}], true, true);

  expect(tabReply).not.toHaveBeenCalled();
  expect(retireAutomaticTab).not.toHaveBeenCalled();
  expect(createChatTab).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(8,
    { type: 'clf-plugin-refresh', request: requests[2] }, { documentId: 'refresh-document-8' });
});

it('retains plugin-refresh custody on the current ChatGPT settings path', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const saved: Record<string, unknown> = { pluginRefreshOwner: { id, tab: 8, documentId: null, navigationEpoch: null } };
  const tab = { id: 8, url: 'https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic' };
  const update = vi.fn(async (_id: number, patch: { url: string }) => { tab.url = patch.url; return tab; });
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    tabDocuments: {}, tabEpochs: {}, tabReply: async () => null,
    createChatTab: vi.fn(), call: async () => ({ ok: true, data: { requests: [{ id, appId: 'asdk_app_synthetic' }] } }),
    chrome: { storage: { session: { get: async () => saved, set: async (next: object) => Object.assign(saved, next) } },
      tabs: { query: async () => [tab], get: async () => tab, update, sendMessage: async () => ({ ok: true }) } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true);
  expect(update).toHaveBeenCalledWith(8, { url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}` });
});

it('holds the exact boot-owned refresh document after marker loss without reloading an in-flight refresh', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const documentId = 'refresh-document-8';
  const navigationEpoch = 4;
  const saved: Record<string, unknown> = { pluginRefreshOwner: { id, tab: 8, documentId, navigationEpoch } };
  const tab = { id: 8, url: 'https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic', pinned: false };
  const update = vi.fn();
  const sendMessage = vi.fn(async (_tabId: number, message: { type: string }, _options?: { documentId: string }) =>
    message.type === 'clf-plugin-refresh-state' ? { owned: true, safe: false } : { ok: false });
  const tabReply = vi.fn((tabId: number, message: { type: string }, options: { documentId: string }) =>
    sendMessage(tabId, message, options));
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    tabDocuments: { '8': documentId }, tabEpochs: { '8': navigationEpoch }, tabReply,
    createChatTab: vi.fn(), call: async () => ({ ok: true, data: { requests: [{ id, appId: 'asdk_app_synthetic' }] } }),
    chrome: { storage: { session: { get: async () => saved, set: async (next: object) => Object.assign(saved, next) } },
      tabs: { query: async () => [tab], get: async () => ({ ...tab }), update, sendMessage } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true);
  expect(update).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(8, { type: 'clf-plugin-refresh-state', id }, { documentId });
  expect(tabReply).toHaveBeenCalledExactlyOnceWith(8, { type: 'clf-plugin-refresh-state', id }, { documentId });
  expect(saved.pluginRefreshOwner).toEqual({ id, tab: 8, documentId, navigationEpoch });
});

it('rejects a marker-loss proof when its navigation epoch changes before the final owner check', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const documentId = 'refresh-document-8';
  const tabEpochs: Record<string, number> = { '8': 4 };
  const saved = { pluginRefreshOwner: { id, tab: 8, documentId, navigationEpoch: 4 } };
  const tab = { id: 8, url: 'https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic', pinned: false };
  const update = vi.fn(async (_tabId: number, patch: { url: string }) => ({ ...tab, ...patch }));
  const sendMessage = vi.fn();
  const tabReply = vi.fn(async () => {
    tabEpochs['8'] = 5;
    return { owned: true, safe: true };
  });
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    tabDocuments: { '8': documentId }, tabEpochs, tabReply, createChatTab: vi.fn(),
    call: async () => ({ ok: true, data: { requests: [{ id, appId: 'asdk_app_synthetic' }] } }),
    chrome: { storage: { session: { get: async () => saved, set: async () => {} } },
      tabs: { query: async () => [tab], get: async () => ({ ...tab }), update, sendMessage } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true);
  expect(tabReply).toHaveBeenCalledExactlyOnceWith(8, { type: 'clf-plugin-refresh-state', id }, { documentId });
  expect(sendMessage).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledExactlyOnceWith(8, {
    url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`
  });
});

it('denies a second marked document while an exact saved refresh owner exists', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const tabs = [
    { id: 8, url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`, pinned: false },
    { id: 9, url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`, pinned: false }
  ];
  const saved = { pluginRefreshOwner: { id, tab: 8, documentId: 'refresh-document-8', navigationEpoch: 4 } };
  const tabDocuments = { '8': 'refresh-document-8', '9': 'refresh-document-9' };
  const tabEpochs = { '8': 4, '9': 7 };
  const ownsDocument = (source: { tab: number; documentId: string; navigationEpoch: number }) =>
    tabDocuments[String(source.tab) as keyof typeof tabDocuments] === source.documentId &&
    tabEpochs[String(source.tab) as keyof typeof tabEpochs] === source.navigationEpoch;
  const context = vm.createContext({ URL, ownsDocument, tabDocuments, tabEpochs,
    chrome: { storage: { session: { get: async () => saved } },
      tabs: { get: async (tabId: number) => tabs.find(tab => tab.id === tabId) } } });
  vm.runInContext(`${workflow}\nglobalThis.owner = pluginRefreshBridgeOwner;`, context);
  await expect(context.owner({ tab: 9, documentId: 'refresh-document-9', navigationEpoch: 7 }, id)).resolves.toBeNull();
  await expect(context.owner({ tab: 8, documentId: 'refresh-document-8', navigationEpoch: 4 }, id)).resolves.toMatchObject({ id: 8 });
});

it('revokes bridge ownership when the document changes during the saved-owner lookup', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const tab = { id: 8,
    url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`,
    pinned: false };
  const tabDocuments: Record<string, string> = { '8': 'refresh-document-8' };
  const tabEpochs: Record<string, number> = { '8': 4 };
  const saved = { pluginRefreshOwner: { id, tab: 8,
    documentId: 'refresh-document-8', navigationEpoch: 4 } };
  const source = { tab: 8, documentId: 'refresh-document-8', navigationEpoch: 4 };
  const ownsDocument = (candidate: typeof source) =>
    tabDocuments[String(candidate.tab)] === candidate.documentId &&
    tabEpochs[String(candidate.tab)] === candidate.navigationEpoch;
  const context = vm.createContext({ URL, ownsDocument, tabDocuments, tabEpochs,
    chrome: { storage: { session: { get: async () => {
      tabDocuments['8'] = 'replacement-document-8';
      return saved;
    } } }, tabs: { get: async () => tab } } });
  vm.runInContext(`${workflow}\nglobalThis.owner = pluginRefreshBridgeOwner;`, context);

  await expect(context.owner(source, id)).resolves.toBeNull();
});

it('retires one exact idle duplicate and refreshes only the saved owner document', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const request = { id, appId: 'asdk_app_synthetic' };
  const saved: Record<string, unknown> = {
    pluginRefreshOwner: { id, tab: 8, documentId: 'refresh-document-8', navigationEpoch: 4 }
  };
  const tabs = [
    { id: 8, url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`, pinned: false },
    { id: 9, url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`, pinned: false }
  ];
  const retired = new Set<number>();
  const tabReply = vi.fn(async () => ({ owned: true, safe: true }));
  const sendMessage = vi.fn(async () => ({ ok: true }));
  const retireAutomaticTab = vi.fn(async (tabId: number, current: () => Promise<boolean>) => {
    if (!await current()) return false;
    retired.add(tabId);
    return true;
  });
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    tabDocuments: { '8': 'refresh-document-8', '9': 'refresh-document-9' },
    tabEpochs: { '8': 4, '9': 7 }, tabReply, retireAutomaticTab, createChatTab: vi.fn(),
    call: async () => ({ ok: true, data: { requests: [request] } }),
    chrome: { storage: { session: { get: async () => saved, set: async (next: object) => Object.assign(saved, next) } },
      tabs: { query: async () => tabs, get: async (tabId: number) => retired.has(tabId) ? null : tabs.find(tab => tab.id === tabId), sendMessage } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true);
  expect(retireAutomaticTab).toHaveBeenCalledTimes(1);
  expect(retireAutomaticTab.mock.calls[0]?.[0]).toBe(9);
  expect(tabReply).toHaveBeenCalledTimes(3);
  expect(tabReply).toHaveBeenNthCalledWith(1, 9, { type: 'clf-plugin-refresh-state', id }, { documentId: 'refresh-document-9' });
  expect(tabReply).toHaveBeenNthCalledWith(2, 8, { type: 'clf-plugin-refresh-state', id }, { documentId: 'refresh-document-8' });
  expect(tabReply).toHaveBeenNthCalledWith(3, 9, { type: 'clf-plugin-refresh-state', id }, { documentId: 'refresh-document-9' });
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(8, { type: 'clf-plugin-refresh', request }, { documentId: 'refresh-document-8' });
  expect(saved.pluginRefreshOwner).toEqual({ id, tab: 8, documentId: 'refresh-document-8', navigationEpoch: 4 });
});

it('retires a marked duplicate while retaining the exact markerless boot-owned keeper', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const request = { id, appId: 'asdk_app_synthetic' };
  const saved: Record<string, unknown> = {
    pluginRefreshOwner: { id, tab: 8, documentId: 'refresh-document-8', navigationEpoch: 4 }
  };
  const tabs = [
    { id: 8, url: 'https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic', pinned: false },
    { id: 9, url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`, pinned: false }
  ];
  const retired = new Set<number>();
  const tabReply = vi.fn(async () => ({ owned: true, safe: true }));
  const sendMessage = vi.fn(async () => ({ ok: true }));
  const retireAutomaticTab = vi.fn(async (tabId: number, current: () => Promise<boolean>) => {
    if (!await current()) return false;
    retired.add(tabId);
    return true;
  });
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    tabDocuments: { '8': 'refresh-document-8', '9': 'refresh-document-9' },
    tabEpochs: { '8': 4, '9': 7 }, tabReply, retireAutomaticTab, createChatTab: vi.fn(),
    call: async () => ({ ok: true, data: { requests: [request] } }),
    chrome: { storage: { session: { get: async () => saved, set: async (next: object) => Object.assign(saved, next) } },
      tabs: { query: async () => tabs, get: async (tabId: number) => retired.has(tabId) ? null : tabs.find(tab => tab.id === tabId), sendMessage } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true);
  expect(retireAutomaticTab).toHaveBeenCalledTimes(1);
  expect(retireAutomaticTab.mock.calls[0]?.[0]).toBe(9);
  expect(retired).toEqual(new Set([9]));
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(8, { type: 'clf-plugin-refresh', request }, { documentId: 'refresh-document-8' });
});

it('keeps the duplicate when the exact keeper disappears, then transfers custody on the next pass', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const saved: Record<string, unknown> = {
    pluginRefreshOwner: { id, tab: 8, documentId: 'refresh-document-8', navigationEpoch: 4 }
  };
  const tabs = [
    { id: 8, url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`, pinned: false },
    { id: 9, url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`, pinned: false }
  ];
  let keeperPresent = true;
  const removed = new Set<number>();
  const retireAutomaticTab = vi.fn(async (tabId: number, current: () => Promise<boolean>) => {
    keeperPresent = false;
    if (!await current()) return false;
    removed.add(tabId);
    return true;
  });
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    tabDocuments: { '8': 'refresh-document-8', '9': 'refresh-document-9' },
    tabEpochs: { '8': 4, '9': 7 }, tabReply: async () => ({ owned: true, safe: true }),
    retireAutomaticTab, createChatTab: vi.fn(),
    call: async () => ({ ok: true, data: { requests: [{ id, appId: 'asdk_app_synthetic' }] } }),
    chrome: { storage: { session: { get: async () => saved,
      set: async (next: object) => Object.assign(saved, next) } },
      tabs: { query: async () => tabs.filter(tab => tab.id !== 8 || keeperPresent),
        get: async (tabId: number) => tabId === 8 && !keeperPresent ? null : tabs.find(tab => tab.id === tabId),
        sendMessage: vi.fn() } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true);
  expect(retireAutomaticTab).toHaveBeenCalledTimes(1);
  expect(removed.size).toBe(0);
  await context.run([{}], true);
  expect(context.chrome.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(9,
    { type: 'clf-plugin-refresh', request: { id, appId: 'asdk_app_synthetic' } },
    { documentId: 'refresh-document-9' });
  expect(saved.pluginRefreshOwner).toEqual({ id, tab: 9,
    documentId: 'refresh-document-9', navigationEpoch: 7 });
  expect(saved.pluginRefreshSuppressedOwners).toEqual([]);
});

it('does not let a saved owner that left settings starve another pending surface', async () => {
  const first = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const second = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const firstRequest = { id: first, appId: 'asdk_app_first' };
  const secondRequest = { id: second, appId: 'asdk_app_second' };
  let requests = [firstRequest, secondRequest];
  const saved: Record<string, unknown> = {
    pluginRefreshOwner: { id: first, tab: 8, documentId: 'refresh-document-8', navigationEpoch: 4 }
  };
  const tabs = [
    { id: 8, url: 'https://chatgpt.com/c/user-conversation', pinned: false },
    { id: 9, url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_second?cos-plugin-refresh=${second}`, pinned: false }
  ];
  const update = vi.fn();
  const sendMessage = vi.fn(async () => ({ ok: true }));
  const createChatTab = vi.fn();
  const context = vm.createContext({ URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    tabDocuments: { '8': 'refresh-document-8', '9': 'refresh-document-9' },
    tabEpochs: { '8': 4, '9': 7 }, tabReply: async () => ({ owned: true, safe: true }),
    retireAutomaticTab: vi.fn(), createChatTab,
    call: async () => ({ ok: true, data: { requests } }),
    chrome: { storage: { session: { get: async () => saved,
      set: async (next: object) => Object.assign(saved, next) } },
      tabs: { query: async () => tabs, get: async (tabId: number) => tabs.find(tab => tab.id === tabId),
        update, sendMessage } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);

  await context.run([{}, {}], true);

  expect(update).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(9,
    { type: 'clf-plugin-refresh', request: secondRequest }, { documentId: 'refresh-document-9' });
  expect(saved.pluginRefreshOwner).toEqual({ id: second, tab: 9,
    documentId: 'refresh-document-9', navigationEpoch: 7 });
  expect(saved.pluginRefreshSuppressedOwners).toEqual([first]);

  // Completing the unrelated surface must not erase the first request's explicit no-reopen
  // custody merely because the single active-owner slot now names the second request.
  requests = [firstRequest];
  await context.run([{}], true);
  expect(createChatTab).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(saved.pluginRefreshSuppressedOwners).toEqual([first]);
});

it.each(['marked', 'markerless'] as const)(
  'leaves a %s pinned current owner untouched and creates an unpinned helper', async mode => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const request = { id, appId: 'asdk_app_synthetic' };
    const suffix = mode === 'marked' ? `?cos-plugin-refresh=${id}` : '';
    const pinned = { id: 8,
      url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic${suffix}`,
      pinned: true };
    const saved: Record<string, unknown> = {
      pluginRefreshOwner: { id, tab: 8, documentId: 'refresh-document-8', navigationEpoch: 4 }
    };
    const created = { id: 9,
      url: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`,
      pinned: false };
    const createChatTab = vi.fn(async () => created);
    const update = vi.fn();
    const sendMessage = vi.fn();
    const retireAutomaticTab = vi.fn();
    const context = vm.createContext({ URL, setTimeout, clearTimeout,
      CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
      tabDocuments: { '8': 'refresh-document-8' }, tabEpochs: { '8': 4 },
      tabReply: vi.fn(), retireAutomaticTab, createChatTab,
      call: async () => ({ ok: true, data: { requests: [request] } }),
      chrome: { storage: { session: { get: async () => saved,
        set: async (next: object) => Object.assign(saved, next) } },
        tabs: { query: async () => [pinned], get: async () => pinned, update, sendMessage } } });
    vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);

    await context.run([{}], true);

    expect(update).not.toHaveBeenCalled();
    expect(retireAutomaticTab).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(createChatTab).toHaveBeenCalledExactlyOnceWith(created.url, true);
    expect(saved.pluginRefreshOwner).toEqual({ id, tab: 9, documentId: null, navigationEpoch: null });
  }
);

it('records browser creation failure before claim and retries the same obligation', async () => {
  const request = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', appId: 'asdk_app_synthetic' };
  const call = vi.fn(async (_path: string, init: { body: string }) => JSON.parse(init.body).action === 'pending'
    ? { ok: true, data: { requests: [request] } } : { ok: true });
  const createChatTab = vi.fn().mockRejectedValueOnce(new Error('window size rejected')).mockResolvedValueOnce({ id: 8 });
  const context = vm.createContext({ call, createChatTab, URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], chrome: { storage: { session: { get: async () => ({}), set: async () => {} } }, tabs: { query: async () => [] } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true);
  const actions = call.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(actions).toEqual([{ action: 'pending' }, { action: 'fail', id: request.id, error: 'The background plugin refresh tab could not be created' }]);
  await context.run([{}], true);
  expect(createChatTab).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.map(([, init]) => JSON.parse(init.body).action)).toEqual(['pending', 'fail', 'pending']);
});

it('fails a spent operator owner turnover closed instead of suppressing the row forever', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const receipt = '11111111-2222-4333-8444-555555555555';
  const request = { id, surface: 'core', appId: 'asdk_app_synthetic',
    operatorRearmReceipt: receipt, operatorRearmGeneration: 1 };
  let pending = true;
  const actions: any[] = [];
  const call = vi.fn(async (_path: string, init: { body: string }) => {
    const body = JSON.parse(init.body); actions.push(body);
    if (body.action === 'pending') return { ok: true, data: { requests: pending ? [request] : [] } };
    if (body.action === 'operator-owner-fail') pending = false;
    return { ok: true };
  });
  const saved: Record<string, any> = {
    pluginRefreshOwner: { id, tab: 8, documentId: 'missing-document', navigationEpoch: 4 }
  };
  const context = vm.createContext({ call, URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], tabDocuments: {}, tabEpochs: {},
    tabReply: vi.fn(), retireAutomaticTab: vi.fn(),
    createChatTab: vi.fn(async () => { throw new Error('window rejected'); }),
    chrome: { storage: { session: { get: async () => saved,
      set: async (next: object) => Object.assign(saved, next) } },
      tabs: { query: async () => [], get: async () => null } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);

  await context.run([{}], true);
  await context.run([{}], true);

  expect(context.createChatTab).toHaveBeenCalledTimes(1);
  expect(actions).toContainEqual({ action: 'operator-owner-fail', id,
    operatorRearmReceipt: receipt, operatorRearmGeneration: 1,
    error: 'The operator-authorized plugin refresh owner could not be replaced' });
  expect(saved.pluginRefreshSuppressedOwners).toEqual([]);
  expect(saved.pluginRefreshOperatorTurnovers).toEqual([]);
});

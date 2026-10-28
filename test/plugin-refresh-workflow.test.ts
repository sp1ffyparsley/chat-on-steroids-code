import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('  let pluginRefreshBusy = false;'), source.indexOf('  function catalogPageReady('));
const askSectionStart = source.indexOf('  async function ask(');
const askSectionEnd = source.indexOf('  /**\n   * Whether a worker reply', Math.max(0, askSectionStart));
if (askSectionStart < 0 || askSectionEnd <= askSectionStart)
  throw new Error('content.js ask source boundaries changed; update the plugin refresh workflow fixture.');
const askSection = source.slice(askSectionStart, askSectionEnd);
const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const attemptToken = '11111111-1111-4111-8111-111111111111';
const markerSource = source.slice(source.indexOf('  const cosMarker ='), source.indexOf('  // The durable claim'));
const markerPrelude = `const BOOT_MARKERS = { input: null, refresh: '${id}', catalog: null };\n${markerSource}`;
const tools = [{ name: 'read', description: 'Read current.', inputSchema: { type: 'object' } }];
function workflow(options: { unchanged?: boolean; deny?: boolean; navigateDuringClaim?: boolean;
  navigateHrefDuringClaim?: boolean; generateDuringClaim?: 'extension' | 'dom'; refreshAvailable?: boolean; href?: string } = {}) {
  let refreshed = false;
  let domGenerating = false;
  const click = vi.fn(() => { refreshed = true; });
  const href = options.href ?? `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic`;
  const context = vm.createContext({ URL, crypto: { randomUUID: () => attemptToken }, alive: true, generating: false, epoch: 1,
    location: { pathname: new URL(href).pathname, href },
    CLF_DOM: { generating: () => domGenerating, pluginManagementIdle: () => true,
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic', refresh: options.refreshAvailable === false ? null : { click }, tools: options.unchanged || refreshed ? tools : [{ ...tools[0], description: 'Old description.' }] }) }
  });
  const ask = vi.fn(async (message: { action: string }) => {
    if (message.action === 'claim' && options.navigateDuringClaim) context.epoch = 2;
    if (message.action === 'claim' && options.navigateHrefDuringClaim)
      context.location.href = `https://chatgpt.com/plugins/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`;
    if (message.action === 'claim' && options.generateDuringClaim === 'extension') context.generating = true;
    if (message.action === 'claim' && options.generateDuringClaim === 'dom') domGenerating = true;
    return { data: { ok: !(message.action === 'claim' && options.deny) } };
  });
  context.ask = ask;
  vm.runInContext(`${markerPrelude}\n${section}\nwaitPageView = async (read, current) => current() ? read() : null; globalThis.run = refreshManagedPlugin; globalThis.state = pluginRefreshState; globalThis.setRefreshBusy = value => { pluginRefreshBusy = value; };`, context);
  return { click, ask,
    run: () => (context.run as Function)({ id, appId: 'asdk_app_synthetic', connectorName: 'Chat On Steroids Core', tools }),
    state: () => (context.state as Function)(id),
    setBusy: (value: boolean) => (context.setRefreshBusy as Function)(value) };
}
it('claims before exactly one click and completes only a newly observed matching schema', async () => {
  const h = workflow();
  expect(await h.run()).toBe(true);
  expect(h.click).toHaveBeenCalledTimes(1);
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['claim', 'complete']);
  expect(h.ask.mock.invocationCallOrder[0]).toBeLessThan(h.click.mock.invocationCallOrder[0]!);
});
it.each(['success', 'timeout', 'navigation'] as const)(
  'bounds data-only refresh polling and releases its timer (%s)', async outcome => {
  vi.useFakeTimers();
  const dom = new JSDOM('<html><body></body></html>');
  let clickedAt: number | null = null;
  const click = vi.fn(() => { clickedAt = Date.now(); });
  const ask = vi.fn(async (_message: { action: string }) => ({ data: { ok: true } }));
  const checks = new Set();
  const context = vm.createContext({ URL, Date, crypto: { randomUUID: () => attemptToken },
    setTimeout, clearTimeout, setInterval, clearInterval, pageViewChecks: checks,
    MutationObserver: dom.window.MutationObserver, document: dom.window.document,
    alive: true, generating: false, epoch: 1, ask,
    t: (_key: string, fallback: string) => fallback,
    location: { pathname: '/', href: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic` },
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic', refresh: { click },
        tools: outcome === 'success' && clickedAt !== null && Date.now() - clickedAt >= 300
          ? tools : [{ ...tools[0], description: 'Old description.' }] }) }
  });
  try {
    vm.runInContext(`${markerPrelude}\n${section}\nglobalThis.run = refreshManagedPlugin;`, context);
    const pending = (context.run as Function)({ id, appId: 'asdk_app_synthetic', connectorName: 'Chat On Steroids Core', tools });
    if (outcome === 'navigation') {
      await vi.advanceTimersByTimeAsync(1);
      context.epoch = 2;
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toBe(outcome === 'success');
    expect(click).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls.filter(([message]) => message.action === 'claim')).toHaveLength(1);
    expect(ask.mock.calls.filter(([message]) => message.action === 'complete')).toHaveLength(outcome === 'success' ? 1 : 0);
    expect(checks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally { dom.window.close(); vi.useRealTimers(); }
});
it('reports immutable boot ownership separately from retirement safety after the URL marker is stripped', () => {
  const h = workflow({ href: 'https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic' });
  expect(h.state()).toMatchObject({ owned: true, safe: true });
  h.setBusy(true);
  expect(h.state()).toMatchObject({ owned: true, busy: true, safe: false });
});
it.each([false, true])('waits for readable tool schemas before claim (navigation=%s)', async navigate => {
  const dom = new JSDOM('<html><body></body></html>');
  let ready = false, refreshed = false;
  const click = vi.fn(() => { refreshed = true; });
  const ask = vi.fn(async () => ({ data: { ok: true } }));
  const context = vm.createContext({ URL, crypto: { randomUUID: () => attemptToken }, setTimeout, clearTimeout, setInterval, clearInterval, pageViewChecks: new Set(), MutationObserver: dom.window.MutationObserver,
    document: dom.window.document, alive: true, generating: false, epoch: 1, ask,
    location: { pathname: '/', href: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic` },
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic', refresh: { click },
        tools: ready ? (refreshed ? tools : [{ ...tools[0], description: 'Old' }]) : null }) }
  });
  vm.runInContext(`${markerPrelude}\n${section}\nglobalThis.run = refreshManagedPlugin;`, context);
  const pending = (context.run as Function)({ id, appId: null, connectorName: 'Chat On Steroids Core', tools });
  expect(ask).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled();
  ready = true;
  if (navigate) context.epoch = 2;
  dom.window.document.body.setAttribute('data-hydrated', 'true');
  expect(await pending).toBe(!navigate);
  expect(click).toHaveBeenCalledTimes(navigate ? 0 : 1);
  expect(context.pageViewChecks.size).toBe(0);
  expect(ask.mock.calls.length).toBe(navigate ? 0 : 2);
  dom.window.close();
});
it('keeps a loading settings index pending and restores custody after its installed button drops the marker', async () => {
  const replace = vi.fn(), ask = vi.fn();
  let buttons: Array<{ click: () => void }> | null = null;
  const location = { pathname: '/', href: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins`, replace };
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1, ask,
    location, history: { replaceState: replace },
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true, pluginInstalledButtons: () => buttons,
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic' }) }
  });
  vm.runInContext(`${markerPrelude}\n${section}\nwaitPageView = async (read, current) => current() ? read() : null; globalThis.run = refreshManagedPlugin;`, context);
  const run = () => (context.run as Function)({ id, appId: null, connectorName: 'Chat On Steroids Core', tools });
  expect(await run()).toBe(false);
  expect(ask).not.toHaveBeenCalled(); // no durable missing-plugin verdict while loading
  buttons = [{ click: () => { location.href = 'https://chatgpt.com/#settings/Plugins/plugin_asdk_app_synthetic'; } }];
  expect(await run()).toBe(true);
  expect(replace).toHaveBeenCalledExactlyOnceWith(undefined, '', `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic`);
  expect(ask).not.toHaveBeenCalled();
});
it('records an already current schema without clicking Refresh and invalidating old chats', async () => {
  const h = workflow({ unchanged: true });
  expect(await h.run()).toBe(true);
  expect(h.click).not.toHaveBeenCalled();
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['current']);
});
it('records an already current schema when the workspace exposes no Refresh control', async () => {
  const h = workflow({ unchanged: true, refreshAvailable: false });
  expect(await h.run()).toBe(true);
  expect(h.click).not.toHaveBeenCalled();
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['current']);
});
it('stops automatic retry when a changed schema has no Refresh control', async () => {
  const h = workflow({ refreshAvailable: false });
  expect(await h.run()).toBe(true);
  expect(h.click).not.toHaveBeenCalled();
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['manual']);
  expect(h.ask.mock.calls[0]?.[0]).toMatchObject({
    appId: 'asdk_app_synthetic',
    connectorName: 'Chat On Steroids Core',
    tools: [{ name: 'read', description: 'Old description.' }]
  });
});
it('opens an enrolled exact App Id directly in marked settings without name discovery', async () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const code = background.slice(background.indexOf('let pluginRefreshFlight = null;'), background.indexOf('async function catalogProbe('));
  const create = vi.fn(async () => ({ id: 9 }));
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    call: async () => ({ ok: true, data: { requests: [{ id, appId: 'asdk_app_synthetic', surface: 'core' }] } }), createChatTab: create,
    chrome: { storage: { session: { get: async () => ({}), set: async () => {} } }, tabs: { query: async () => [] } }
  });
  vm.runInContext(`${code}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await (context.run as Function)([{ surface: 'core' }], true);
  expect(create).toHaveBeenCalledExactlyOnceWith(`https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`, true);
});
it.each([
  `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`,
  `https://chatgpt.com/plugins/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`
])('refreshes on the path-routed page %s', async href => {
  const h = workflow({ href });
  expect(await h.run()).toBe(true);
  expect(h.click).toHaveBeenCalledTimes(1);
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['claim', 'complete']);
});
it('never refreshes a path-routed page whose route names another app', async () => {
  const h = workflow({ href: `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_other?cos-plugin-refresh=${id}` });
  expect(await h.run()).toBe(false);
  expect(h.click).not.toHaveBeenCalled();
});
it('continues from the installed list on the path-routed settings page', async () => {
  const listed = `https://chatgpt.com/settings/plugins-settings?cos-plugin-refresh=${id}`;
  const detail = `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`;
  const assign = vi.fn(), replace = vi.fn(), ask = vi.fn();
  const location = { pathname: '/settings/plugins-settings', href: listed, assign };
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1, ask, location, history: { replaceState: replace },
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
      pluginInstalledButtons: () => [{ click: () => { location.pathname = '/settings/plugins-settings/plugin_asdk_app_synthetic'; location.href = detail.replace(`?cos-plugin-refresh=${id}`, ''); } }],
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic' }) }
  });
  vm.runInContext(`${markerPrelude}\n${section}\nwaitPageView = async (read, current) => current() ? read() : null; globalThis.run = refreshManagedPlugin;`, context);
  expect(await (context.run as Function)({ id, appId: 'asdk_app_synthetic', connectorName: 'Chat On Steroids Core', tools })).toBe(true);
  expect(assign).toHaveBeenCalledExactlyOnceWith(detail);
  expect(await (context.run as Function)({ id, appId: null, connectorName: 'Chat On Steroids Core', tools })).toBe(true);
  expect(replace).toHaveBeenCalledExactlyOnceWith(undefined, '', detail);
  expect(ask).not.toHaveBeenCalled();
});
it('opens the installed list by its path when the App Id is not known yet', async () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const code = background.slice(background.indexOf('let pluginRefreshFlight = null;'), background.indexOf('async function catalogProbe('));
  const create = vi.fn(async () => ({ id: 9 }));
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    call: async () => ({ ok: true, data: { requests: [{ id, appId: null, surface: 'core' }] } }), createChatTab: create,
    chrome: { storage: { session: { get: async () => ({}), set: async () => {} } }, tabs: { query: async () => [] } }
  });
  vm.runInContext(`${code}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await (context.run as Function)([{ surface: 'core' }], true);
  expect(create).toHaveBeenCalledExactlyOnceWith(`https://chatgpt.com/settings/plugins-settings?cos-plugin-refresh=${id}`, true);
});
it.each([{ deny: true }, { navigateDuringClaim: true }, { generateDuringClaim: 'extension' as const },
  { generateDuringClaim: 'dom' as const }])('never clicks after denied claim, changed navigation, or generation: %j', async options => {
  const h = workflow(options);
  expect(await h.run()).toBe(false);
  expect(h.click).not.toHaveBeenCalled();
  const moved = 'navigateDuringClaim' in options;
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual('deny' in options || moved ? ['claim'] : ['claim', 'fail']);
  if (!('deny' in options) && !moved) expect(h.ask.mock.calls[1]?.[0]).toMatchObject({
    appId: 'asdk_app_synthetic', attemptToken, confirmedUnclicked: true
  });
});
it.each(['unpinned', 'pinned', 'pinned-during-proof'])('reuses management tabs and respects pinning (%s)', async mode => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const code = background.slice(background.indexOf('let pluginRefreshFlight = null;'), background.indexOf('async function catalogProbe('));
  let requests: object[] = [{ id }];
  const tabs = [{ id: 7, url: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins`, pinned: false }, { id: 8, url: 'https://chatgpt.com/c/user-conversation', pinned: false }];
  const create = vi.fn(async () => ({ id: 9 }));
  const remove = vi.fn();
  const sendMessage = vi.fn(async (_tabId?: number, _message?: object, _options?: object): Promise<object> => ({ ok: true }));
  const tabReply = vi.fn(async (tabId: number, message: object, options: object) =>
    sendMessage(tabId, message, options).catch(() => null));
  const retireAutomaticTab = vi.fn(async (tabId: number, current?: () => Promise<boolean>) => {
    if (current && !await current()) return false;
    await remove(tabId);
    return true;
  });
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    tabDocuments: { '7': 'refresh-document-7', '8': 'conversation-document-8' }, tabEpochs: { '7': 3, '8': 2 }, tabReply,
    call: async () => ({ ok: true, data: { requests } }), createChatTab: create,
    retireAutomaticTab,
    chrome: { storage: { session: { get: async () => ({}), set: async () => {} } }, tabs: { query: async () => tabs, get: async (id: number) => tabs.find(tab => tab.id === id), remove, sendMessage } }
  });
  vm.runInContext(`${code}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  const run = () => (context.run as Function)([{ surface: 'core' }], true);
  await Promise.all([run(), run()]);
  expect(create).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledWith(7, { type: 'clf-plugin-refresh', request: { id } }, { documentId: 'refresh-document-7' });
  requests = [{ id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' }];
  sendMessage.mockRejectedValueOnce(new Error('old document unavailable'));
  await run();
  expect(create).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  requests = [];
  tabs[0]!.pinned = mode === 'pinned';
  sendMessage.mockImplementation(async () => {
    if (mode === 'pinned-during-proof') tabs[0]!.pinned = true;
    return { safe: true };
  });
  await run();
  if (mode === 'unpinned') expect(remove).toHaveBeenCalledExactlyOnceWith(7);
  else expect(remove).not.toHaveBeenCalled();
  expect(tabReply.mock.calls.every(([tabId, , options]) =>
    tabId === 7 && (options as { documentId?: string }).documentId === 'refresh-document-7')).toBe(true);
});
it('does not click or blame a different settings URL in the same epoch after claim', async () => {
  const h = workflow({ navigateHrefDuringClaim: true });
  expect(await h.run()).toBe(false);
  expect(h.click).not.toHaveBeenCalled();
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['claim']);
});
const nativeFixtures: JSDOM[] = [];
afterEach(() => { for (const dom of nativeFixtures.splice(0)) dom.window.close(); });
const pathRouted = `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`;
function nativeInstalledWorkflow() {
  const listed = `https://chatgpt.com/settings/plugins-settings?cos-plugin-refresh=${id}`;
  const dom = new JSDOM('<main><a href="/settings/plugins-settings/plugin_asdk_app_synthetic"><span>Chat On Steroids Core</span></a></main>', { runScripts: 'outside-only', url: listed });
  nativeFixtures.push(dom);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  dom.window.eval(domSource);
  const link = dom.window.document.querySelector('a')!;
  const click = vi.spyOn(link, 'click').mockImplementation(() => {});
  const installed = vi.fn((dom.window as any).CLF_DOM.pluginInstalledButtons), view = vi.fn(() => null);
  const assign = vi.fn(), ask = vi.fn(), location = { pathname: '/settings/plugins-settings', href: listed, assign };
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1, ask, location,
    history: { replaceState: vi.fn() }, CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
      pluginInstalledButtons: installed, pluginRefreshView: view } });
  vm.runInContext(`${markerPrelude}\n${section}\nwaitPageView = async (read, current) => current() ? read() : null; globalThis.run = refreshManagedPlugin;`, context);
  return { dom, link, click, installed, view, assign, ask, location,
    run: () => (context.run as Function)({ id, appId: null, connectorName: 'Chat On Steroids Core', tools }) };
}
it('carries the sole native installed link custody before waiting for its unreadable card', async () => {
  const h = nativeInstalledWorkflow();
  expect(await h.run()).toBe(true);
  expect(h.installed).toHaveBeenCalledTimes(2);
  expect(h.assign).toHaveBeenCalledExactlyOnceWith(pathRouted);
  expect(h.click).not.toHaveBeenCalled();
  expect(h.view).not.toHaveBeenCalled();
  expect(h.ask).not.toHaveBeenCalled();
});
it.each(['external', 'catalog', 'hash', 'changed-target', 'ambiguous', 'detached', 'hidden', 'replaced'])(
  'refuses native link ownership changed during discovery (%s)', async mode => {
    const h = nativeInstalledWorkflow();
    const pending = h.run();
    if (mode === 'external') h.link.href = 'https://example.com/settings/plugins-settings/plugin_asdk_app_synthetic';
    if (mode === 'catalog') h.link.href = '/plugins/plugin_asdk_app_synthetic';
    if (mode === 'hash') h.link.href += '#unowned';
    if (mode === 'changed-target') h.link.href = '/settings/plugins-settings/plugin_asdk_app_other';
    if (mode === 'ambiguous') h.link.after(h.link.cloneNode(true));
    if (mode === 'detached') h.link.remove();
    if (mode === 'hidden') h.link.hidden = true;
    if (mode === 'replaced') h.link.replaceWith(h.link.cloneNode(true));
    expect(await pending).toBe(false);
    expect(h.assign).not.toHaveBeenCalled();
    expect(h.click).not.toHaveBeenCalled();
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.view).not.toHaveBeenCalled();
  }
);
it('does not adopt native list discovery on another marked settings URL in the same epoch', async () => {
  const h = nativeInstalledWorkflow();
  const pending = h.run();
  h.location.href = pathRouted;
  h.location.pathname = '/settings/plugins-settings/plugin_asdk_app_synthetic';
  expect(await pending).toBe(false);
  expect(h.assign).not.toHaveBeenCalled();
  expect(h.click).not.toHaveBeenCalled();
  expect(h.ask).not.toHaveBeenCalled();
  expect(h.view).not.toHaveBeenCalled();
});
it.each(['matching', 'unreadable'])('does not publish a management read from a moved URL (%s)', async outcome => {
  let release!: (value: object | null) => void;
  const reading = new Promise<object | null>(resolve => { release = resolve; });
  const click = vi.fn(), ask = vi.fn();
  const location = { pathname: '/settings/plugins-settings/plugin_asdk_app_synthetic', href: pathRouted };
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1, ask, location,
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true, pluginRefreshView: () => reading } });
  vm.runInContext(`${markerPrelude}\n${section}\nwaitPageView = async (read, current) => { const value = await read(); return current() ? value : null; }; globalThis.run = refreshManagedPlugin;`, context);
  const pending = (context.run as Function)({ id, appId: 'asdk_app_synthetic', connectorName: 'Chat On Steroids Core', tools });
  location.href = pathRouted.replace('/settings/plugins-settings/', '/plugins/');
  location.pathname = '/plugins/plugin_asdk_app_synthetic';
  release(outcome === 'matching' ? { appId: 'asdk_app_synthetic', tools, refresh: { click } } : null);
  expect(await pending).toBe(false);
  expect(click).not.toHaveBeenCalled();
  expect(ask).not.toHaveBeenCalled();
});
function registrationGatedWorkflow(action: 'current' | 'manual' | 'claim' | 'fail' | 'complete') {
  let release!: (value: { ok: boolean }) => void, entered!: () => void, refreshed = false;
  const gate = new Promise<{ ok: boolean }>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let registration = action === 'complete' ? Promise.resolve({ ok: true }) : gate;
  const click = vi.fn(() => { refreshed = true; });
  const sendToWorker = vi.fn(async (message: { action: string }) => {
    if (message.action === 'claim' && action === 'complete') registration = gate;
    return { data: { ok: true } };
  });
  const location = { pathname: '/settings/plugins-settings/plugin_asdk_app_synthetic', href: pathRouted };
  const context = vm.createContext({ URL, crypto: { randomUUID: () => attemptToken }, alive: true, generating: false, epoch: 1, location,
    sendToWorker, observed: {}, t: (_key: string, fallback: string) => fallback,
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic',
        tools: action === 'current' || refreshed ? tools : [{ ...tools[0], description: 'Old description.' }],
        refresh: action === 'manual' ? null : { click } }) } });
  Object.defineProperty(context, 'documentReady', { get() { if (registration === gate) entered(); return registration; },
    set(value) { registration = value; } });
  vm.runInContext(`${markerPrelude}\n${askSection}\n${section}\nwaitPageView = async (read, current) => current() ? read() : null; globalThis.run = refreshManagedPlugin;`, context);
  return { click, sendToWorker, location, waiting, release,
    run: () => (context.run as Function)({ id, appId: action === 'fail' ? 'asdk_app_foreign' : 'asdk_app_synthetic', connectorName: 'Chat On Steroids Core', tools }) };
}
it.each(['current', 'manual', 'claim', 'fail', 'complete'] as const)(
  'rechecks the %s publication owner after real document registration', async action => {
    for (const navigate of [false, true]) {
      const h = registrationGatedWorkflow(action);
      const pending = h.run();
      await h.waiting;
      if (navigate) {
        h.location.href = pathRouted.replace('/settings/plugins-settings/', '/plugins/');
        h.location.pathname = '/plugins/plugin_asdk_app_synthetic';
      }
      h.release({ ok: true });
      expect(await pending).toBe(!navigate && action !== 'fail');
      expect(h.sendToWorker.mock.calls.map(([message]) => message.action)).toEqual(navigate ? (action === 'complete' ? ['claim'] : []) :
        action === 'claim' || action === 'complete' ? ['claim', 'complete'] : [action]);
      expect(h.click).toHaveBeenCalledTimes(action === 'complete' || (!navigate && action === 'claim') ? 1 : 0);
    }
  }
);

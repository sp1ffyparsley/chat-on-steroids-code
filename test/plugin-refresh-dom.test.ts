import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';
const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiber = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
let dom: JSDOM;
afterEach(() => dom?.window.close());
const tool = { name: 'read', description: 'Read an exact file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
function page() {
  dom = new JSDOM('<section role="tabpanel" aria-labelledby="settings-trigger-Plugins"><h2>Chat On Steroids Core</h2><button id="schema">Schema kopieren</button><footer><button id="refresh">Aktualisieren</button></footer></section>', { runScripts: 'outside-only', url: 'https://chatgpt.com/#settings/Plugins/plugin_asdk_app_synthetic' });
  const win = dom.window;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const props = { connector: { id: 'asdk_app_synthetic', name: 'Chat On Steroids Core', app_metadata: { version_id: 'asdk_app_v_synthetic' }, owners: ['never-copy'] },
    actions: [{ name: tool.name, description: tool.description, description_model: null, params: tool.inputSchema }], isLoadingActions: false };
  (win.document.getElementById('schema') as any).__reactFiber$fixture = { memoizedProps: props };
  (win.document.getElementById('refresh') as any).__reactFiber$fixture = { memoizedProps: { details: [{ title: 'App-Kennung', value: props.connector.id }], reportEntity: { id: props.connector.id, entityType: 'connector' }, headerTrailingContent: {} } };
  win.eval(fiber); win.eval(source);
  return { api: (win as any).CLF_DOM, props };
}
it.each([34, 64])('observes expanded Core with %s tools without substituting expected declarations', async count => {
  const { api, props } = page();
  props.actions = Array.from({ length: count }, (_, i) => ({ ...props.actions[0]!, name: `core_tool_${i}` }));
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool]))?.tools).toHaveLength(count);
  props.actions.push({ ...props.actions[0]!, name: 'extra_tool' });
  if (count === 64) expect(await api.pluginRefreshView('Chat On Steroids Core')).toBeNull();
});
// A connector renamed in ChatGPT keeps its app id (2026-10-11). With the app's proven ids, refresh
// finds it by that id and its current name; a same-named app with another id stays foreign.
it('refreshes a renamed connector by its proven app id', async () => {
  const { api, props } = page(); props.connector.name = 'Renamed';
  api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', linkId: null, name: 'Renamed' }], desktop: [], plugins: [] });
  expect(await api.pluginRefreshView('Chat On Steroids Core', [tool])).toMatchObject({ appId: 'asdk_app_synthetic', connectorName: 'Renamed' });
});
it('refuses a same-named app once another app id is proven for that connector', async () => {
  const { api } = page();
  api.setConnectorApps({ core: [{ appId: 'asdk_app_other', linkId: null, name: 'Chat On Steroids Core' }], desktop: [], plugins: [] });
  expect(await api.pluginRefreshView('Chat On Steroids Core', [tool])).toBeNull();
});
it('finds a renamed connector\'s installed row by its proven current name', () => {
  const { api } = page(); const panel = dom.window.document.querySelector('section')!;
  panel.setAttribute('aria-labelledby', 'settings-trigger-Plugins');
  panel.innerHTML = '<a href="/plugins">Plugins durchsuchen</a><button><span data-testid="plugin-icon-wrapper"></span><div>Renamed</div></button>';
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toEqual([]);
  api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', linkId: null, name: 'Renamed' }], desktop: [], plugins: [] });
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toHaveLength(1);
  expect(api.pluginInstalledButtons('Chat On Steroids Desktop')).toEqual([]);
});
it('keeps the Plugins connector\'s larger catalog limit after a rename, by its proven app id', async () => {
  const { api, props } = page();
  props.connector.name = 'My external apps';
  props.actions = Array.from({ length: 118 }, (_, i) => ({ name: `plugin_tool_${i}`, description: `Plugin tool ${i}`, description_model: null,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
  api.setConnectorApps({ core: [], desktop: [], plugins: [{ appId: 'asdk_app_synthetic', linkId: null, name: 'My external apps' }] });
  expect((await api.pluginRefreshView('Chat On Steroids Plugins'))?.tools).toHaveLength(118);
});
it('reads localized installed declarations and the unique native refresh action from provider state', async () => {
  const { api } = page(); const view = await api.pluginRefreshView('Chat On Steroids Core', [tool]);
  expect(view).toMatchObject({ appId: 'asdk_app_synthetic', versionId: 'asdk_app_v_synthetic', tools: [tool] });
  expect(view.refresh.textContent).toBe('Aktualisieren'); expect(view).not.toHaveProperty('success');
});
it('does not substitute expected declarations for changed provider descriptions', async () => {
  const { api, props } = page(); props.actions[0]!.description = 'Changed declaration.';
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool])).tools[0].description).toBe('Changed declaration.');
  props.actions.push(props.actions[0]!);
  expect(await api.pluginRefreshView('Chat On Steroids Core')).toBeNull();
});
it('uses an enrolled App ID through renames, but refuses mismatched IDs and loading schemas', async () => {
  const { api, props } = page(); props.connector.name = 'Renamed';
  expect(await api.pluginRefreshView('Chat On Steroids Core')).toBeNull();
  expect(await api.pluginRefreshView('Chat On Steroids Core', [], 'asdk_app_synthetic')).not.toBeNull();
  expect(await api.pluginRefreshView('Chat On Steroids Core', [], 'asdk_app_other')).toBeNull();
  props.isLoadingActions = true;
  expect(await api.pluginRefreshView('Renamed')).toBeNull();
});
it('rejects oversized or cyclic schemas before projecting them to the isolated world', async () => {
  const { api, props } = page();
  const schema = { type: 'object', description: 'x'.repeat(300000) };
  props.actions[0]!.params = schema as any;
  expect(await api.pluginRefreshView('Chat On Steroids Core')).toBeNull();
  props.actions[0]!.params = { type: 'object', properties: {} } as any;
  (props.actions[0]!.params as any).properties.self = props.actions[0]!.params;
  expect(await api.pluginRefreshView('Chat On Steroids Core')).toBeNull();
});
it.each([118, 257])('accepts %s declarations for the Plugins connector including its optional code-mode tool', async (count) => {
  const { api, props } = page();
  props.connector.name = 'Chat On Steroids Plugins';
  props.actions = Array.from({ length: count }, (_, i) => ({ name: i === 256 ? 'exec' : `plugin_tool_${i}`, description: `Plugin tool ${i}`, description_model: null,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
  const view = await api.pluginRefreshView('Chat On Steroids Plugins');
  expect(view?.tools).toHaveLength(count);
});
it.each([0, 118, 257])('observes a new configured Plugins identity with %s tools before any app-ID proof', async count => {
  const { api, props } = page();
  const connector = 'Luna Forge X7 Clear Cove 123456789abc Gamma Windows Plugins';
  api.setConnectorNames({ core: 'New Core', desktop: 'New Desktop', plugins: connector });
  props.connector.name = connector;
  props.actions = Array.from({ length: count }, (_, i) => ({ name: `plugin_tool_${i}`, description: `Plugin tool ${i}`, description_model: null,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
  expect((await api.pluginRefreshView(connector))?.tools).toHaveLength(count);
  api.setConnectorApps({ core: [], desktop: [], plugins: [{ appId: 'asdk_app_other', linkId: null, name: connector }] });
  expect(await api.pluginRefreshView(connector)).toBeNull();
});
it('reads a Plugins catalog with long schemas that still fits the app publication budget', async () => {
  const { api, props } = page();
  props.connector.name = 'Chat On Steroids Plugins';
  props.actions = Array.from({ length: 82 }, (_, i) => ({
    name: `manage_tool_${i}`,
    description: `Tool ${i}. ${'Detailed usage notes. '.repeat(40)}`,
    description_model: null,
    params: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What to do. '.repeat(25) },
        target: { type: 'string' }
      },
      required: ['action']
    }
  })) as any;
  const serializedBytes = Buffer.byteLength(JSON.stringify(props.actions), 'utf8');
  expect(serializedBytes).toBeGreaterThan(100_000);
  expect(serializedBytes).toBeLessThan(250_000);

  const view = await api.pluginRefreshView('Chat On Steroids Plugins');
  expect(view?.tools).toHaveLength(82);
});
it.each(['Luna Forge X7 Plugins', 'Chat On Steroids Plugins'])('accepts the exact %s Plugins migration alias', async (connector) => {
  const { api, props } = page();
  props.connector.name = connector;
  expect(await api.pluginRefreshView(connector)).toMatchObject({ connectorName: connector });
});
it.each([['Chat On Steroids Plugins', 258], ['Chat On Steroids Core', 65]] as const)('retains the %s observation count guard', async (connector, count) => {
  const { api, props } = page();
  props.connector.name = connector;
  props.actions = Array.from({ length: count }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i}`, description_model: null,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
  expect(await api.pluginRefreshView(connector)).toBeNull();
});
it('refuses ambiguous native actions and never copies unrelated connector properties', async () => {
  const { api } = page(); const messages: unknown[] = [];
  dom.window.addEventListener('message', event => { if (event.data?.source === 'clf-plugin-reply') messages.push(event.data); });
  await api.pluginRefreshView('Chat On Steroids Core'); expect(JSON.stringify(messages)).not.toContain('never-copy');
  const button = dom.window.document.getElementById('refresh')!;
  const copy = button.cloneNode(true) as any; copy.__reactFiber$fixture = (button as any).__reactFiber$fixture; button.after(copy);
  expect(await api.pluginRefreshView('Chat On Steroids Core')).toBeNull();
});
it('discovers exact installed rows across languages and preserves ambiguity', () => {
  const { api } = page(); const panel = dom.window.document.querySelector('section')!;
  panel.innerHTML = '<a href="/plugins">Plugins durchsuchen</a>';
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toBeNull();
  panel.insertAdjacentHTML('beforeend', '<button><span data-testid="plugin-icon-wrapper"></span><div>Chat On Steroids Core</div><span>Alle zulassen</span></button>');
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toHaveLength(1);
  expect(api.pluginInstalledButtons('Chat On Steroids Desktop')).toEqual([]);
  panel.insertAdjacentHTML('beforeend', panel.querySelector('button')!.outerHTML);
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toHaveLength(2);
});

it('observes an exact installed card without a refresh action through the real Fiber bridge', async () => {
  const { api } = page();
  const refresh = dom.window.document.getElementById('refresh') as any;
  const card = { ...refresh.__reactFiber$fixture.memoizedProps, headerTrailingContent: null };
  (dom.window.document.getElementById('schema') as any).__reactFiber$fixture.return = { memoizedProps: card };
  refresh.remove();
  expect(await api.pluginRefreshView('Chat On Steroids Core', [tool])).toMatchObject({ appId: 'asdk_app_synthetic', tools: [tool], refresh: null });
  delete (dom.window.document.getElementById('schema') as any).__reactFiber$fixture.return;
  expect(await api.pluginRefreshView('Chat On Steroids Core', [tool])).toBeNull();
});

// ChatGPT's newer shell uses a full page at /settings/plugins-settings/plugin_<app>.
function settingsPage(path = '/settings/plugins-settings/plugin_asdk_app_synthetic') {
  dom = new JSDOM('<main><h1>Chat On Steroids Core</h1><button id="edit">Bearbeiten</button><button id="refresh">Tools aktualisieren</button><button id="delete">App löschen</button></main>', { runScripts: 'outside-only', url: `https://chatgpt.com${path}` });
  const win = dom.window;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const connector = { id: 'asdk_app_synthetic', name: 'Chat On Steroids Core', app_metadata: { version_id: 'asdk_app_v_synthetic' }, owners: ['never-copy'],
    actions: [{ name: tool.name, description: tool.description, description_model: '' as string | null, params: tool.inputSchema }] };
  const owner = { memoizedProps: { connector, link: {}, plugin: {} } };
  const chain = (wrapper: object) => ({ memoizedProps: { children: 'x' }, return: { memoizedProps: wrapper, return: { memoizedProps: { className: 'row' }, return: owner } } });
  const set = (id: string, wrapper: object) => { (win.document.getElementById(id) as any).__reactFiber$fixture = chain(wrapper); };
  set('edit', { color: 'secondary', onClick() {} });
  set('refresh', { color: 'secondary', loading: false, onClick() {} });
  set('delete', { color: 'danger', disabled: false, onClick() {} });
  win.eval(fiber); win.eval(source);
  return { api: (win as any).CLF_DOM, connector, set };
}
it.each([34, 64, 65])('bounds expanded full-page Core observations at %s tools', async count => {
  const { api, connector } = settingsPage();
  connector.actions = Array.from({ length: count }, (_, i) => ({ ...connector.actions[0]!, name: `core_tool_${i}` }));
  const view = await api.pluginRefreshView('Chat On Steroids Core', [tool]);
  if (count > 64) expect(view).toBeNull();
  else expect(view?.tools).toHaveLength(count);
});
it.each(['/settings/plugins-settings/plugin_asdk_app_synthetic', '/plugins/plugin_asdk_app_synthetic'])('reads the plugin page at %s and only its Refresh tools control', async path => {
  const { api } = settingsPage(path);
  const view = await api.pluginRefreshView('Chat On Steroids Core', [tool]);
  expect(view).toMatchObject({ appId: 'asdk_app_synthetic', versionId: 'asdk_app_v_synthetic', tools: [tool] });
  expect(view.refresh.id).toBe('refresh');
  expect(dom.window.document.querySelectorAll('[data-clf-plugin-refresh]')).toHaveLength(1);
});
it.each(['/settings/plugins-settings/plugin_asdk_app_synthetic', '/plugins/plugin_asdk_app_synthetic'])('reads the page description at %s when the model description is empty, and prefers a set one', async path => {
  const { api, connector } = settingsPage(path);
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool])).tools[0].description).toBe(tool.description);
  connector.actions[0]!.description_model = 'Model-facing declaration.';
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool])).tools[0].description).toBe('Model-facing declaration.');
  connector.actions[0]!.description_model = null;
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool])).tools[0].description).toBe(tool.description);
});
it('never offers a destructive control as the page refresh, and refuses an ambiguous one', async () => {
  const { api, set } = settingsPage();
  set('refresh', { color: 'secondary', onClick() {} }); set('delete', { color: 'danger', loading: false, onClick() {} });
  set('edit', { color: 'ghost', loading: false, 'aria-haspopup': 'menu' });
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool]))?.refresh).toBeNull();
  expect(dom.window.document.querySelector('[data-clf-plugin-refresh]')).toBeNull();
  set('refresh', { loading: false }); set('edit', { loading: false });
  expect(await api.pluginRefreshView('Chat On Steroids Core', [tool])).toBeNull();
});
it.each(['text', 'aria-label'])('recognizes the exact native Refresh tools %s without a loading prop', async kind => {
  const { api, set } = settingsPage();
  const refresh = dom.window.document.getElementById('refresh')!;
  set('refresh', { color: 'secondary', onClick() {} });
  if (kind === 'text') refresh.textContent = 'Refresh tools';
  else { refresh.textContent = ''; refresh.setAttribute('aria-label', 'Refresh tools'); }
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool]))?.refresh).toBe(refresh);
  refresh.hidden = true;
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool]))?.refresh).toBeNull();
});
it('keeps semantic refresh exact, connector-owned, non-destructive and unambiguous', async () => {
  const { api, set } = settingsPage();
  const refresh = dom.window.document.getElementById('refresh')!;
  set('refresh', { color: 'secondary' });
  refresh.textContent = 'Refresh tools';
  const exactView = () => api.pluginRefreshView('Chat On Steroids Core', [tool]);
  expect((await exactView())?.refresh).toBe(refresh);
  set('refresh', { color: 'danger' });
  expect((await exactView())?.refresh).toBeFalsy();
  set('refresh', { color: 'secondary' });
  refresh.setAttribute('aria-haspopup', 'menu');
  expect((await exactView())?.refresh).toBeFalsy();
  refresh.removeAttribute('aria-haspopup');
  refresh.setAttribute('aria-label', 'Uninstall');
  expect((await exactView())?.refresh).toBeFalsy();
  refresh.setAttribute('aria-label', 'Refresh tools');
  refresh.textContent = 'Delete app';
  expect((await exactView())?.refresh).toBeFalsy();
  refresh.removeAttribute('aria-label');
  refresh.textContent = 'Refresh tools and reconnect';
  expect((await exactView())?.refresh).toBeFalsy();
  refresh.textContent = 'Refresh tools';
  (refresh as any).__reactFiber$fixture.return.return.return = { memoizedProps: { connector: { id: 'asdk_app_other' } } };
  expect((await exactView())?.refresh).toBeFalsy();
  set('refresh', { color: 'secondary' });
  const duplicate = refresh.cloneNode(true) as any;
  duplicate.__reactFiber$fixture = (refresh as any).__reactFiber$fixture;
  refresh.after(duplicate);
  expect(await exactView()).toBeNull();
});
it('refuses a page whose route and connector identify different apps', async () => {
  const { api, connector } = settingsPage();
  connector.id = 'asdk_app_other';
  expect(await api.pluginRefreshView('Chat On Steroids Core', [tool])).toBeNull();
  dom.window.close(); settingsPage('/settings/plugins-settings/plugin_asdk_app_synthetic');
  dom.window.history.replaceState(null, '', '/settings/plugins-settings/plugin_asdk_app_synthetic#settings/Plugins');
  expect(await (dom.window as any).CLF_DOM.pluginRefreshView('Chat On Steroids Core', [tool])).toBeNull();
});
it('finds installed rows on the path-routed plugins settings page', () => {
  settingsPage('/settings/plugins-settings');
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = '<button><div><span>Chat On Steroids Core</span></div><span>Custom</span></button><button><span>Chat On Steroids Desktop</span></button>';
  const api = (dom.window as any).CLF_DOM;
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toHaveLength(1);
  expect(api.pluginInstalledButtons('Chat On Steroids')).toBeNull();
});
it.each(['/settings/plugins-settings/plugin_asdk_app_synthetic',
  'https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic'])('discovers the exact installed settings link %s', href => {
  settingsPage('/settings/plugins-settings');
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = `<a href="${href}"><span>Chat On Steroids Core</span><span>Custom</span></a>`;
  const api = (dom.window as any).CLF_DOM;
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toEqual([main.querySelector('a')]);
  expect(api.pluginInstalledButtons('Chat On Steroids')).toBeNull();
});
it.each([
  'https://example.com/settings/plugins-settings/plugin_asdk_app_synthetic',
  '/plugins/plugin_asdk_app_synthetic',
  '/#settings/Plugins/plugin_asdk_app_synthetic',
  '/settings/plugins-settings/plugin_not_an_app',
  '/settings/plugins-settings/plugin_asdk_app_synthetic/other',
  '/settings/plugins-settings/plugin_asdk_app_synthetic#settings/Plugins'
])('refuses a non-installed or foreign settings link %s', href => {
  settingsPage('/settings/plugins-settings');
  dom.window.document.querySelector('main')!.innerHTML = `<a href="${href}"><span>Chat On Steroids Core</span></a>`;
  expect((dom.window as any).CLF_DOM.pluginInstalledButtons('Chat On Steroids Core')).toBeNull();
});
it.each(['hidden', 'inert', 'aria-hidden="true"'])('refuses installed links inside a %s surface', attribute => {
  settingsPage('/settings/plugins-settings');
  dom.window.document.querySelector('main')!.innerHTML = `<div ${attribute}><a href="/settings/plugins-settings/plugin_asdk_app_synthetic"><span>Chat On Steroids Core</span></a></div>`;
  expect((dom.window as any).CLF_DOM.pluginInstalledButtons('Chat On Steroids Core')).toBeNull();
});
it('retains ambiguity between installed links and legacy settings buttons', () => {
  settingsPage('/settings/plugins-settings');
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = '<a href="/settings/plugins-settings/plugin_asdk_app_first"><span>Chat On Steroids Core</span></a><a href="/settings/plugins-settings/plugin_asdk_app_second"><span>Chat On Steroids Core</span></a>';
  const api = (dom.window as any).CLF_DOM;
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toHaveLength(2);
  main.innerHTML = '<button><span>Chat On Steroids Core</span></button><a href="/settings/plugins-settings/plugin_asdk_app_synthetic"><span>Chat On Steroids Core</span></a>';
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toHaveLength(2);
});
it.each(['/plugins', '/#settings/Plugins'])('does not adopt installed-looking links from the public or legacy route %s', route => {
  settingsPage(route);
  dom.window.document.querySelector('main')!.innerHTML = '<a href="/settings/plugins-settings/plugin_asdk_app_synthetic"><span>Chat On Steroids Core</span></a>';
  expect((dom.window as any).CLF_DOM.pluginInstalledButtons('Chat On Steroids Core')).toBeNull();
});
it('discovers a renamed native installed app by proven ID before its learned name catches up', () => {
  const { api } = settingsPage('/settings/plugins-settings');
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = '<a href="/settings/plugins-settings/plugin_asdk_app_synthetic"><span>New provider name 日本語</span></a>' +
    '<a href="/settings/plugins-settings/plugin_asdk_app_foreign"><span>Chat On Steroids Core</span></a>';
  api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', name: 'Chat On Steroids Core' }], desktop: [], plugins: [] });
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toEqual([main.querySelector('a')]);
});
it('refuses shared learned or configured names without borrowing another surface identity', async () => {
  const { api, props } = page(); props.connector.name = 'Renamed';
  api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', name: 'Renamed' }],
    desktop: [{ appId: 'asdk_app_desktop', name: 'Renamed' }], plugins: [] });
  expect(await api.pluginRefreshView('Renamed', [tool])).toBeNull();
  expect(api.pluginInstalledButtons('Renamed')).toBeNull();
  expect(await api.pluginRefreshView('Renamed', [tool], 'asdk_app_synthetic')).toMatchObject({ appId: 'asdk_app_synthetic' });
  api.setConnectorNames({ core: 'Configured', desktop: 'Configured', plugins: 'Plugins' });
  props.connector.name = 'Configured';
  expect(await api.pluginRefreshView('Configured', [tool])).toBeNull();
});
function renamedNativeList() {
  const { api } = settingsPage('/settings/plugins-settings');
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = '<a href="/settings/plugins-settings/plugin_asdk_app_synthetic"><span>New provider name 日本語</span></a>';
  api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', name: 'Chat On Steroids Core' }], desktop: [], plugins: [] });
  return { api, main, link: main.querySelector('a')! };
}
it.each(['external', 'catalog', 'hash', 'wrong-id', 'hidden', 'detached', 'replacement-foreign', 'outside', 'quoted', 'own-surface', 'css-hidden', 'aria-disabled', 'zero-rect'])(
  'keeps proven native link selection closed when the row is %s', mode => {
    const { api, main, link } = renamedNativeList();
    if (mode === 'external') link.href = 'https://example.com/settings/plugins-settings/plugin_asdk_app_synthetic';
    if (mode === 'catalog') link.href = '/plugins/plugin_asdk_app_synthetic';
    if (mode === 'hash') link.href += '#unowned';
    if (mode === 'wrong-id') { link.href = '/settings/plugins-settings/plugin_asdk_app_foreign'; link.querySelector('span')!.textContent = 'Chat On Steroids Core'; }
    if (mode === 'hidden') link.hidden = true;
    if (mode === 'detached') link.remove();
    if (mode === 'replacement-foreign') {
      const other = link.cloneNode(true) as HTMLAnchorElement;
      other.href = '/settings/plugins-settings/plugin_asdk_app_foreign'; other.querySelector('span')!.textContent = 'Chat On Steroids Core'; link.replaceWith(other);
    }
    if (mode === 'outside') dom.window.document.body.append(link);
    if (mode === 'quoted' || mode === 'own-surface') {
      const host = dom.window.document.createElement('section');
      if (mode === 'quoted') host.dataset.testid = 'conversation-turn-1'; else host.className = 'clf-stage';
      main.append(host); host.append(link);
    }
    if (mode === 'css-hidden') link.style.display = 'none';
    if (mode === 'aria-disabled') link.setAttribute('aria-disabled', 'true');
    if (mode === 'zero-rect') Object.defineProperty(link, 'getClientRects', { value: () => [] });
    expect(api.pluginInstalledButtons('Chat On Steroids Core')).toBeNull();
  }
);
it.each(['duplicate-id', 'multiple-core-ids'])('preserves ambiguity among proven native rows (%s)', mode => {
  const { api, main, link } = renamedNativeList();
  const other = link.cloneNode(true) as HTMLAnchorElement;
  if (mode === 'multiple-core-ids') {
    other.href = '/settings/plugins-settings/plugin_asdk_app_other'; other.textContent = 'Another renamed connector';
    api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', name: 'Chat On Steroids Core' },
      { appId: 'asdk_app_other', name: 'Older known name' }], desktop: [], plugins: [] });
  }
  main.append(other);
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toEqual([link, other]);
});
it('does not discover an unproven or unknown renamed app by an arbitrary request name', () => {
  const { api, link } = renamedNativeList();
  api.setConnectorApps({ core: [], desktop: [], plugins: [] });
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toBeNull();
  link.querySelector('span')!.textContent = 'Unknown connector';
  expect(api.pluginInstalledButtons('Unknown connector')).toBeNull();
});
it('retains separate Core and Plugins limits through conflicting learned aliases and exact IDs', async () => {
  const { api, connector } = settingsPage();
  connector.name = 'Chat On Steroids Core';
  connector.actions = Array.from({ length: 118 }, (_, i) => ({ name: `plugin_tool_${i}`, description: `Tool ${i}`,
    description_model: '', params: tool.inputSchema }));
  api.setConnectorApps({ core: [], desktop: [], plugins: [{ appId: connector.id, name: connector.name }] });
  expect(await api.pluginRefreshView(connector.name)).toBeNull();
  expect((await api.pluginRefreshView(connector.name, [], connector.id))?.tools).toHaveLength(118);
  api.setConnectorApps({ core: [{ appId: connector.id, name: 'Chat On Steroids Plugins' }], desktop: [], plugins: [] });
  expect(await api.pluginRefreshView('Chat On Steroids Plugins', [], connector.id)).toBeNull();
});

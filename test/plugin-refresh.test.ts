import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
const wake = vi.hoisted(() => vi.fn());
const census = vi.hoisted(() => vi.fn(async () => ({ blockers: [] as unknown[] })));
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: wake }));
vi.mock('../src/main/profile-work-state.js', () => ({ activeProfileWorkCensus: census }));
import { initDurableStore, resetDurableForTests, readDurable, writeDurableNow } from '../src/main/durable.js';
import { claimPluginRefresh, coreConnectorPresence, requireManualPluginRefresh, completePluginRefresh, failOperatorPluginRefreshOwner, failPluginRefresh, operatorPluginRefreshRearmRequests, pendingPluginRefreshes, pluginRefreshPublications, pluginSurfaceObservation, processOperatorPluginRefreshRearms, publishPluginSurface, rearmCorePluginRefreshByOperator, resetPluginRefreshForTests, unpublishPluginSurface } from '../src/main/plugin-refresh.js';
import { noteServedRequest, noteAppSightings, resetConnectorIdentityForTests } from '../src/main/connector-identity.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { buildServer } from '../src/main/mcp/tools.js';
import { defaultConfig } from '../src/main/config.js';
import { getLog } from '../src/main/logger.js';
import type { PluginToolSchema } from '../src/shared/plugin-refresh.js';
import * as refreshModule from '../src/main/plugin-refresh.js';
import * as durableModule from '../src/main/durable.js';
import * as configModule from '../src/main/config.js';
import { profileWorkAdmission } from '../src/main/work-admission.js';

it('refuses Core replacement during active work, unpaused automation or a changed old identity', async () => {
  const config = defaultConfig();
  const configured = vi.spyOn(configModule, 'getConfig').mockReturnValue(config);
  try {
    publish(); const request = (await pendingPluginRefreshes())[0]!;
    await claim(request); await completePluginRefresh({ ...request, appId, tools });
    const operation = { ...request, appId, replacementAppId: 'asdk_app_new', receipt: randomUUID() };
    expect(await rearmCorePluginRefreshByOperator(operation)).toBe(false);
    config.ui.automationPaused = true;
    census.mockResolvedValueOnce({ blockers: ['active-tool'] });
    expect(await rearmCorePluginRefreshByOperator(operation)).toBe(false);
    expect(profileWorkAdmission.snapshot().mode).toBe('open');
    expect(await rearmCorePluginRefreshByOperator({ ...operation, appId: 'asdk_app_wrong' })).toBe(false);
    expect(await rearmCorePluginRefreshByOperator({ ...operation, replacementAppId: appId })).toBe(false);
    expect(await rearmCorePluginRefreshByOperator({ ...operation, replacementAppId: 'invalid' })).toBe(false);
    expect(await coreConnectorPresence()).toEqual({ appId, connectorName: 'Chat On Steroids Core' });
    expect((await readDurable<any[]>('plugin-refresh'))![0].operatorRearms).toEqual([]);
  } finally { configured.mockRestore(); }
});

it('parses replacement only with the complete old identity fence and one new app', () => {
  const id = randomUUID(), receipt = randomUUID(), schemaId = 'a'.repeat(64);
  const args = [`--cos-rearm-plugin-refresh=${id}`, `--cos-rearm-plugin-refresh-schema=${schemaId}`,
    `--cos-rearm-plugin-refresh-app=${appId}`, `--cos-rearm-plugin-refresh-receipt=${receipt}`];
  const replacement = '--cos-rearm-plugin-refresh-replacement=asdk_app_new';
  expect(operatorPluginRefreshRearmRequests([...args, replacement])).toEqual([
    { id, receipt, schemaId, appId, replacementAppId: 'asdk_app_new' }
  ]);
  expect(() => operatorPluginRefreshRearmRequests([replacement])).toThrow();
  expect(() => operatorPluginRefreshRearmRequests([...args, replacement, replacement])).toThrow();
});

it('retires a replaced Core identity until exact new native schema proof survives restart', async () => {
  const configured = vi.spyOn(configModule, 'getConfig').mockReturnValue({
    ...defaultConfig(), ui: { ...defaultConfig().ui, automationPaused: true }
  });
  try {
    publish(); const request = (await pendingPluginRefreshes())[0]!;
    await claim(request);
    await completePluginRefresh({ ...request, appId, tools });
    const replacementAppId = 'asdk_app_replacement';
    const operation = { ...request, appId, replacementAppId, receipt: randomUUID() };
    expect(await rearmCorePluginRefreshByOperator(operation)).toBe(true);
    expect(await coreConnectorPresence()).toBeNull();
    expect(await completePluginRefresh({ ...request, appId, tools })).toBe(false);
    expect(await claimPluginRefresh({ ...request, appId: replacementAppId,
      connectorName: 'Secure Core', tools: [{ ...tools[0]!, description: 'stale' }], alreadyCurrent: true })).toBe(false);
    expect(await claimPluginRefresh({ ...request, appId: replacementAppId,
      connectorName: 'Secure Core', tools, alreadyCurrent: true })).toBe(true);
    expect(await coreConnectorPresence()).toEqual({ appId: replacementAppId, connectorName: 'Secure Core' });
    const stored = (await readDurable<any[]>('plugin-refresh'))![0];
    expect(stored.attemptCount).toBe(1);
    expect(stored.operatorRearms[0]).toMatchObject({ previousAppId: appId, appId: replacementAppId,
      receipt: operation.receipt });
    expect(await rearmCorePluginRefreshByOperator(operation)).toBe(false);
    resetPluginRefreshForTests(); resetConnectorIdentityForTests(); publish();
    expect(await coreConnectorPresence()).toEqual({ appId: replacementAppId, connectorName: 'Secure Core' });
  } finally { configured.mockRestore(); }
});
const appId = 'asdk_app_example';
const tools: PluginToolSchema[] = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
let directory = '';
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); wake.mockClear(); resetConnectorIdentityForTests(); resetPluginRefreshForTests(); resetDurableForTests(); directory = await makeTempDir(); initDurableStore(directory); });
afterEach(async () => { resetPluginRefreshForTests(); resetDurableForTests(); await removeTempDir(directory); vi.useRealTimers(); });
const publish = (version = '1', declarations = tools) => { publishPluginSurface('core', 'Chat On Steroids Core', version, 'Instructions', declarations); vi.advanceTimersByTime(20_000); };
const publishPlugins = (declarations: PluginToolSchema[]) => { publishPluginSurface('plugins', 'Chat On Steroids Plugins', '1', 'Instructions', declarations); vi.advanceTimersByTime(20_000); };
const claim = (request: { id: string }, declarations = [{ ...tools[0]!, description: 'Older declaration' }]) => claimPluginRefresh({
  ...request, appId, connectorName: 'Chat On Steroids Core', tools: declarations, attemptToken: randomUUID()
});
it('uses a learned Core name only for the exact schema-confirmed app ID', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  noteServedRequest('rename', 'core');
  noteAppSightings([{ requestId: 'rename', appId, linkId: 'link_own', appName: 'Renamed Core' }]);
  expect(await coreConnectorPresence()).toBeNull();
  await claim(request);
  await completePluginRefresh({ ...request, appId, tools });
  expect(await coreConnectorPresence()).toEqual({ connectorName: 'Renamed Core', appId });
  noteServedRequest('another-app', 'core');
  noteAppSightings([{ requestId: 'another-app', appId: 'asdk_app_other', linkId: 'link_other', appName: 'Foreign newest' }]);
  expect(await coreConnectorPresence()).toEqual({ connectorName: 'Renamed Core', appId });
});
it('projects only confirmed schemas synchronously without another durable read per state push', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const schemas = refreshModule.confirmedPluginSchemas;
  expect(schemas()).toEqual({});
  expect(await claim(request)).toBe(true);
  expect(schemas()).toEqual({});
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(true);
  const first = pluginRefreshPublications()[0]!.schemaId;
  expect(schemas()).toEqual({ core: first });
  const read = vi.spyOn(fs, 'readFile');
  try {
    const copy = schemas(); copy.core = 'changed-by-caller';
    for (let i = 0; i < 5; i++) expect(schemas()).toEqual({ core: first });
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
  publish('2', [{ ...tools[0]!, description: 'New contract' }]); await pendingPluginRefreshes();
  expect(schemas()).toEqual({ core: first });
  expect(pluginRefreshPublications()[0]!.schemaId).not.toBe(first);
});

it('does not publish schema confirmation until its exact durable write commits', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  await claim(request);
  const schemas = refreshModule.confirmedPluginSchemas;
  expect(schemas()).toEqual({});
  const originalWrite = durableModule.writeDurableNow;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const write = vi.spyOn(durableModule, 'writeDurableNow').mockImplementationOnce(async (name, value) => {
    entered(); await held; await originalWrite(name, value);
  });
  const completing = completePluginRefresh({ ...request, appId, tools });
  try {
    await started;
    expect(schemas()).toEqual({});
    release();
    expect(await completing).toBe(true);
    expect(schemas()).toEqual({ core: pluginRefreshPublications()[0]!.schemaId });
  } finally { release(); await completing; write.mockRestore(); }
});

it('keeps failed confirmation writes out of the presentation cache', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  await claim(request);
  const write = vi.spyOn(durableModule, 'writeDurableNow').mockRejectedValueOnce(new Error('fixture durable refusal'));
  try {
    await expect(completePluginRefresh({ ...request, appId, tools })).rejects.toThrow('fixture durable refusal');
    expect(refreshModule.confirmedPluginSchemas()).toEqual({});
    expect((await readDurable('plugin-refresh') as any[])[0].completedSchemaId).toBeNull();
  } finally { write.mockRestore(); }
});

it('loads confirmed schemas once after restore without blocking the synchronous projection', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools, alreadyCurrent: true })).toBe(true);
  const first = pluginRefreshPublications()[0]!.schemaId;
  resetPluginRefreshForTests();
  const read = vi.spyOn(fs, 'readFile');
  try {
    expect(refreshModule.confirmedPluginSchemas()).toEqual({});
    expect(refreshModule.confirmedPluginSchemas()).toEqual({});
    await vi.waitFor(() => expect(refreshModule.confirmedPluginSchemas()).toEqual({ core: first }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(refreshModule.confirmedPluginSchemas()).toEqual({ core: first });
    expect(read).toHaveBeenCalledTimes(1);
  } finally { read.mockRestore(); }
});
it.each(['malformed', 'null', 'invalid', 'duplicate', 'read-error'] as const)('keeps a %s refresh ledger fail-closed and unchanged', async kind => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request)).toBe(true);
  const file = `${directory}/state/plugin-refresh.json`;
  const saved = await fs.readFile(file, 'utf8');
  const broken = kind === 'malformed' ? '{"private-diagnostic":"fixture-only"' : kind === 'null' ? 'null'
    : kind === 'invalid' ? JSON.stringify([{ surface: 'private-invalid' }])
      : kind === 'duplicate' ? JSON.stringify([...JSON.parse(saved), ...JSON.parse(saved)]) : saved;
  if (kind !== 'read-error') await fs.writeFile(file, broken, 'utf8');
  resetPluginRefreshForTests();
  publishPluginSurface('core', 'Chat On Steroids Core', '1', 'Instructions', tools);
  wake.mockClear();
  const read = kind === 'read-error'
    ? vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('private fixture diagnostic'), { code: 'EACCES' }))
    : null;
  try {
    await expect(pendingPluginRefreshes()).rejects.toThrow(/^Could not read plugin-refresh state$/);
  } finally { read?.mockRestore(); }
  expect(wake).not.toHaveBeenCalled();
  expect(await fs.readFile(file, 'utf8')).toBe(kind === 'read-error' ? saved : broken);

  // Restoring the independently retained receipt proves the failed read did not mint a fresh row.
  if (kind !== 'read-error') await fs.writeFile(file, saved, 'utf8');
  resetPluginRefreshForTests();
  publishPluginSurface('core', 'Chat On Steroids Core', '1', 'Instructions', tools);
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect(await claim(request)).toBe(false);
});
it('keeps the synchronous confirmation projection read-only when its ledger is unreadable', async () => {
  publish(); await pendingPluginRefreshes();
  const file = `${directory}/state/plugin-refresh.json`;
  const broken = '{"private-diagnostic":"fixture-only"';
  await fs.writeFile(file, broken, 'utf8');
  resetPluginRefreshForTests();
  publishPluginSurface('core', 'Chat On Steroids Core', '1', 'Instructions', tools);
  wake.mockClear();
  const read = vi.spyOn(fs, 'readFile');
  const write = vi.spyOn(durableModule, 'writeDurableNow');
  try {
    expect(refreshModule.confirmedPluginSchemas()).toEqual({});
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(write).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  } finally { read.mockRestore(); write.mockRestore(); }
  expect(await fs.readFile(file, 'utf8')).toBe(broken);
});
it('debounces only changed declarations for twenty seconds and fences stale claims', async () => {
  publish(); const old = (await pendingPluginRefreshes())[0]!;
  const change = (description: string) => publishPluginSurface('core', 'Chat On Steroids Core', '1', 'Instructions', [{ ...tools[0]!, description }]);
  change('A');
  expect(await claim(old)).toBe(false);
  vi.advanceTimersByTime(19_000); expect(await pendingPluginRefreshes()).toEqual([]);
  change('B');
  vi.advanceTimersByTime(19_000); expect(await pendingPluginRefreshes()).toEqual([]);
  // An unchanged settings publication must not prolong the debounce.
  change('B');
  vi.advanceTimersByTime(1_000);
  expect((await pendingPluginRefreshes())[0]?.tools[0]?.description).toBe('B');
  expect(wake).toHaveBeenCalledTimes(2);
});
it('keeps Desktop independent and debounces shape changes across reconnects', async () => {
  publish();
  publishPluginSurface('desktop', 'Desktop', '1', '', tools);
  unpublishPluginSurface('core');
  publishPluginSurface('core', 'Chat On Steroids Core', '1', '', [{ ...tools[0]!, description: 'Reconnected shape' }]);
  expect((await pendingPluginRefreshes()).map(row => row.surface)).toEqual(['desktop']);
  vi.advanceTimersByTime(20_000);
  expect((await pendingPluginRefreshes()).map(row => row.surface).sort()).toEqual(['core', 'desktop']);
});
it('wakes a settled publication restored after its deadline elapsed while disconnected', async () => {
  publish();
  const changed = [{ ...tools[0]!, description: 'Changed declaration' }];
  publishPluginSurface('core', 'Chat On Steroids Core', '1', '', changed);
  unpublishPluginSurface('core');
  vi.advanceTimersByTime(20_000);
  expect(wake).toHaveBeenCalledTimes(1);
  publishPluginSurface('core', 'Chat On Steroids Core', '1', '', changed);
  expect(wake).toHaveBeenCalledTimes(2);
  expect((await pendingPluginRefreshes())[0]?.tools).toEqual(changed);
});
it('wakes existing browser transport once per changed publication, not unchanged settings', () => {
  publish(); expect(wake).toHaveBeenCalledTimes(1);
  publish(); publish(); expect(wake).toHaveBeenCalledTimes(1);
  publish('2'); expect(wake).toHaveBeenCalledTimes(1);
  publish('2', [{ ...tools[0]!, description: 'Changed declaration' }]); expect(wake).toHaveBeenCalledTimes(2);
});
it('deduplicates unchanged reconnects, durably acknowledges a matching generation and notices an update', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request)).toBe(true);
  expect(await completePluginRefresh({ ...request, appId, tools, versionId: 'unchanged-provider-version' })).toBe(true);
  resetPluginRefreshForTests(); publish();
  expect(await pendingPluginRefreshes()).toEqual([]);
  publish('2'); expect(await pendingPluginRefreshes()).toEqual([]);
  publish('2', [{ ...tools[0]!, description: 'New contract' }]); const updated = (await pendingPluginRefreshes())[0]!;
  expect(updated.id).not.toBe(request.id); expect(updated.appId).toBe(appId);
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(false);
});
it('requires a recognizable exact tool set for enrollment and refreshes stale definitions', async () => {
  publish(); const first = (await pendingPluginRefreshes())[0]!;
  expect(await claim(first, [])).toBe(false);
  expect(await claim(first, [{ ...tools[0]!, description: 'Older installed declaration' }])).toBe(true);
  const changed = [{ ...tools[0]!, description: 'New declaration' }]; publish('2', changed);
  const next = (await pendingPluginRefreshes())[0]!;
  expect(await claim(next, tools)).toBe(true);
  expect(await completePluginRefresh({ ...next, appId, tools })).toBe(false);
  expect(await completePluginRefresh({ ...next, appId, tools: changed })).toBe(true);
});
it.each([false, true])('invalidates an older confirmation after an unconfirmed intervening refresh (restart=%s)', async restart => {
  publish(); const first = (await pendingPluginRefreshes())[0]!;
  expect(await claim(first)).toBe(true);
  expect(await completePluginRefresh({ ...first, appId, tools })).toBe(true);
  const changed = [{ ...tools[0]!, description: 'Intervening contract' }];
  publish('2', changed); const intervening = (await pendingPluginRefreshes())[0]!;
  expect(await claim(intervening, tools)).toBe(true);
  const [claimed] = await readDurable('plugin-refresh') as any[];
  expect(claimed).toMatchObject({ appId, completedSchemaId: first.schemaId, attempted: true, attemptCount: 1 });
  if (restart) resetPluginRefreshForTests();

  // ChatGPT may now hold the intervening contract. Reverting the local publication cannot
  // borrow the older confirmation, even though the declarations have returned exactly to A.
  publish('3', tools);
  const pending = await pendingPluginRefreshes();
  expect(pending).toHaveLength(1);
  const restored = pending[0]!;
  expect(restored).toMatchObject({ appId, schemaId: first.schemaId });
  expect(restored.id).not.toBe(first.id);
  expect(restored.id).not.toBe(intervening.id);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({
    id: restored.id, appId, schemaId: first.schemaId, completedSchemaId: null,
    attempted: false, attemptCount: 0, retryNotBefore: null, attemptToken: null,
    operatorRearms: [], manual: false
  });
  expect(refreshModule.confirmedPluginSchemas()).toEqual({});
  expect(await completePluginRefresh({ ...intervening, appId, tools: changed })).toBe(false);
  expect(await claim(intervening, tools)).toBe(false);
  expect(await failPluginRefresh({ id: intervening.id, appId, attemptToken: claimed.attemptToken,
    error: 'Late intervening receipt' })).toBe(false);
  expect(await claimPluginRefresh({ ...restored, appId: 'asdk_app_other',
    connectorName: restored.connectorName, tools: changed, attemptToken: randomUUID() })).toBe(false);
  expect(await claim(restored, changed)).toBe(true);
  expect(await completePluginRefresh({ ...restored, appId, tools: changed })).toBe(false);
  expect(await completePluginRefresh({ ...restored, appId, tools })).toBe(true);
});
it('retains an older confirmation when an intervening publication never authorized a refresh', async () => {
  publish(); const first = (await pendingPluginRefreshes())[0]!;
  expect(await claim(first)).toBe(true);
  expect(await completePluginRefresh({ ...first, appId, tools })).toBe(true);
  publish('2', [{ ...tools[0]!, description: 'Unclaimed intermediate contract' }]);
  const intervening = (await pendingPluginRefreshes())[0]!;
  publish('3', tools);
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect(refreshModule.confirmedPluginSchemas()).toEqual({ core: first.schemaId });
  expect(await claim(intervening, tools)).toBe(false);
});
it('records passive exact connector/schema observations without creating a second refresh authority', async () => {
  publish();
  const request = (await pendingPluginRefreshes())[0]!;
  expect(pluginSurfaceObservation('core')).toBeNull();
  expect(await claim(request)).toBe(true);
  const observed = pluginSurfaceObservation('core');
  expect(observed).toMatchObject({
    surface: 'core',
    providerConnectorName: 'Chat On Steroids Core',
    expectedConnectorName: 'Chat On Steroids Core'
  });
  expect(observed?.providerSchemaId).not.toBe(observed?.expectedSchemaId);

  resetPluginRefreshForTests();
  publish();
  const foreign = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({
    ...foreign,
    appId: 'foreign-app',
    connectorName: 'Wrong Core',
    tools
  })).toBe(false);
  expect(pluginSurfaceObservation('core')).toBeNull();
});
it('logs a bounded exact-owner mismatch once per changed fingerprint without declaration contents', async () => {
  const catalog = Array.from({ length: 20 }, (_, i) => ({ ...tools[0]!, name: `tool_${i}`, description: 'private expected description' }));
  publishPlugins(catalog);
  const request = (await pendingPluginRefreshes())[0]!;
  const provider = catalog.map(tool => ({ ...tool, description: 'private provider description',
    inputSchema: { type: 'object', properties: { secret: { const: 'C:\\private\\token-value' } } } }));
  provider[0] = { ...provider[0]!, name: 'different_tool' };
  provider[1] = { ...provider[1]!, name: 'C:\\private\\unsafe-name' };
  const input = { ...request, appId, connectorName: 'Chat On Steroids Plugins', tools: provider, alreadyCurrent: true };
  const start = getLog().length;
  const mismatchLogs = () => getLog().slice(start).filter(entry => entry.message.startsWith('plugin refresh schema mismatch'));
  expect(await claimPluginRefresh({ ...input, connectorName: 'Other plugin' })).toBe(false);
  expect(mismatchLogs()).toHaveLength(0);
  expect(await claimPluginRefresh(input)).toBe(false);
  expect(await claimPluginRefresh(input)).toBe(false);
  const entries = mismatchLogs();
  expect(entries).toHaveLength(1);
  const message = entries[0]!.message;
  expect(message).toContain(`expectedSchema=${request.schemaId.slice(0, 12)}`);
  expect(message).toContain(`providerSchema=${pluginSurfaceObservation('plugins')!.providerSchemaId.slice(0, 12)}`);
  const detail = JSON.parse(message.slice(message.indexOf('{')));
  expect(detail).toMatchObject({ expectedCount: 20, providerCount: 20, omittedChanges: 6 });
  expect(detail.expectedNames).toHaveLength(16);
  expect(detail.providerNames).toHaveLength(16);
  expect(detail.changes).toHaveLength(16);
  expect(detail.changes).toContainEqual({ name: '[invalid-name]', fields: ['unexpected'] });
  expect(detail.changes).toContainEqual({ name: 'tool_0', fields: ['missing'] });
  expect(detail.changes).toContainEqual({ name: 'tool_10', fields: ['description', 'schema'] });
  expect(message).not.toMatch(/private|token-value|unsafe-name/);
  expect(message.length).toBeLessThan(5000);
  const stored = await readDurable('plugin-refresh') as any[];
  expect(stored[0]).toMatchObject({ attempted: false, attemptCount: 0, appId: null, completedSchemaId: null });
  provider[2] = { ...provider[2]!, description: 'a changed private declaration' };
  expect(await claimPluginRefresh(input)).toBe(false);
  expect(mismatchLogs()).toHaveLength(2);
  publishPlugins(catalog.map(tool => ({ ...tool, description: 'changed expected private declaration' })));
  const updated = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...input, id: updated.id })).toBe(false);
  expect(mismatchLogs()).toHaveLength(3);
});
it.each([{ count: 118, codeMode: false }, { count: 118, codeMode: true }, { count: 256, codeMode: true }])('enrolls legacy Plugins into $count tools with code mode $codeMode and requires the complete expanded catalog', async ({ count, codeMode }) => {
  const catalog: PluginToolSchema[] = Array.from({ length: count }, (_, i) => ({
    name: `plugin_tool_${i}`, description: `Plugin tool ${i}`, inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  }));
  const legacy = catalog.slice(0, 64);
  if (codeMode) {
    const exec = { name: 'exec', description: 'Compose tools', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } };
    legacy.push(exec); catalog.push(exec);
  }
  publishPlugins(catalog);
  const request = (await pendingPluginRefreshes())[0]!;
  expect(request.surface).toBe('plugins');
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Plugins', tools: legacy, attemptToken: randomUUID() })).toBe(true);
  expect(await completePluginRefresh({ ...request, appId, tools: legacy })).toBe(false);
  expect(await completePluginRefresh({ ...request, appId, tools: catalog })).toBe(true);
});
it('rejects a foreign declaration inside a legacy Plugins subset', async () => {
  const catalog: PluginToolSchema[] = Array.from({ length: 118 }, (_, i) => ({
    name: `plugin_tool_${i}`, description: `Plugin tool ${i}`, inputSchema: { type: 'object', properties: {} },
  }));
  const legacy = catalog.slice(0, 64).map(tool => ({ ...tool }));
  legacy[63] = { ...legacy[63]!, description: 'Changed foreign declaration' };
  publishPlugins(catalog);
  const request = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Plugins', tools: legacy })).toBe(false);
});
it('enrolls already-current tools without granting a refresh click, including after restart', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request, tools)).toBe(false);
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools, alreadyCurrent: true })).toBe(true);
  expect(await pendingPluginRefreshes()).toEqual([]);
  resetPluginRefreshForTests();
  publishPluginSurface('core', 'Chat On Steroids Core', 'a-new-app-version', 'Different runtime instructions', tools);
  expect(await pendingPluginRefreshes()).toEqual([]);
});
it('exposes only the exact settings-proven Core identity to the browser input owner', async () => {
  publish();
  expect(await coreConnectorPresence()).toBeNull();
  const request = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools, alreadyCurrent: true })).toBe(true);
  expect(await coreConnectorPresence()).toEqual({ connectorName: 'Chat On Steroids Core', appId });
  unpublishPluginSurface('core');
  expect(await coreConnectorPresence()).toBeNull();
});
it('does not return an old Core identity when its publication changes during the durable read', async () => {
  publish();
  const request = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools, alreadyCurrent: true })).toBe(true);

  const realReadFile = fs.readFile.bind(fs);
  let entered = (): void => {};
  let release = (): void => {};
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let hold = true;
  const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(
    (async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
      if (hold && String(target).endsWith('plugin-refresh.json')) {
        hold = false;
        entered();
        await gate;
      }
      return (realReadFile as (...callArgs: unknown[]) => ReturnType<typeof fs.readFile>)(target, ...args);
    }) as typeof fs.readFile
  );
  try {
    const presence = coreConnectorPresence();
    await reading;
    publishPluginSurface('core', 'Chat On Steroids Core', '2', 'Instructions', [
      { ...tools[0]!, description: 'Republished while the durable row was loading' }
    ]);
    release();
    expect(await presence).toBeNull();
  } finally {
    release();
    readSpy.mockRestore();
  }
});
it('withholds a retained Core app id until the current schema is enrolled and keeps one claimed row observable', async () => {
  publish();
  const first = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...first, appId, connectorName: 'Chat On Steroids Core', tools, alreadyCurrent: true })).toBe(true);
  expect(await coreConnectorPresence()).toEqual({ connectorName: 'Chat On Steroids Core', appId });

  const changed = [{ ...tools[0]!, description: 'Current changed declaration' }];
  publish('2', changed);
  expect(await coreConnectorPresence()).toBeNull();
  const request = (await pendingPluginRefreshes())[0]!;
  expect(request.appId).toBe(appId);
  expect(await claim(request, tools)).toBe(true);
  const claimed = (await readDurable('plugin-refresh') as any[])[0];
  expect(await failPluginRefresh({ id: request.id, appId, attemptToken: claimed.attemptToken,
    error: 'Refresh outcome unavailable' })).toBe(true);
  expect(await coreConnectorPresence()).toBeNull();
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect((await pendingPluginRefreshes({ includeClaimed: true }))[0]?.id).toBe(request.id);

  // The provider completed the original click after the first receipt window. Observing the
  // exact current schema settles that same row without granting another click.
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools: changed, alreadyCurrent: true })).toBe(true);
  expect(await coreConnectorPresence()).toEqual({ connectorName: 'Chat On Steroids Core', appId });
});
it('does not settle a changed contract as already current', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools: [{ ...tools[0]!, description: 'Old' }], alreadyCurrent: true })).toBe(false);
  expect(await claim(request)).toBe(true);
});
it('durably suppresses automatic retries when the provider requires manual recreation', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const installed = [{ ...tools[0]!, description: 'Older installed declaration' }];
  expect(await requireManualPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools: installed, error: 'Recreate the custom app manually.' })).toBe(true);
  expect(await pendingPluginRefreshes()).toEqual([]);
  const stored = (await readDurable('plugin-refresh') as any[])[0];
  expect(stored).toMatchObject({ appId, attempted: false, manual: true, error: 'Recreate the custom app manually.' });
  expect(stored.completedSchemaId).not.toBe(stored.schemaId);
  expect(await pendingPluginRefreshes({ includeClaimed: true })).toEqual([
    expect.objectContaining({ id: request.id, appId, observationOnly: true })
  ]);
  resetPluginRefreshForTests(); publish();
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect(await pendingPluginRefreshes({ includeClaimed: true })).toEqual([
    expect.objectContaining({ id: request.id, appId, observationOnly: true })
  ]);
  publish('2', [{ ...tools[0]!, description: 'Another local schema' }]);
  expect((await pendingPluginRefreshes())[0]).toMatchObject({ appId });
});
it('settles a manually repaired provider from an observation-only projection without authorizing a click', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const installed = [{ ...tools[0]!, description: 'Older installed declaration' }];
  expect(await requireManualPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: installed, error: 'Recreate the custom app manually.' })).toBe(true);
  const observation = (await pendingPluginRefreshes({ includeClaimed: true }))[0]!;
  expect(observation).toMatchObject({ id: request.id, appId, observationOnly: true });
  expect(await claimPluginRefresh({ ...observation, appId, connectorName: 'Chat On Steroids Core',
    tools: installed, attemptToken: randomUUID() })).toBe(false);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({
    attempted: false, attemptCount: 0, manual: true
  });
  expect(await claimPluginRefresh({ ...observation, appId, connectorName: 'Chat On Steroids Core',
    tools, alreadyCurrent: true })).toBe(true);
  expect(await coreConnectorPresence()).toEqual({ connectorName: 'Chat On Steroids Core', appId });
  expect(await pendingPluginRefreshes({ includeClaimed: true })).toEqual([]);
});
it('parses one complete operator refresh rearm command and refuses partial or duplicate identity fences', async () => {
  const request = {
    id: randomUUID(), schemaId: 'a'.repeat(64), appId, receipt: randomUUID()
  };
  const argv = [
    `--cos-rearm-plugin-refresh=${request.id}`,
    `--cos-rearm-plugin-refresh-schema=${request.schemaId}`,
    `--cos-rearm-plugin-refresh-app=${request.appId}`,
    `--cos-rearm-plugin-refresh-receipt=${request.receipt}`
  ];
  expect(operatorPluginRefreshRearmRequests(argv)).toEqual([request]);
  const rearm = vi.fn(async () => true);
  expect(await processOperatorPluginRefreshRearms(argv, rearm)).toEqual({ requested: 1, rearmed: 1, refused: [] });
  expect(rearm).toHaveBeenCalledWith(request);
  expect(() => operatorPluginRefreshRearmRequests(argv.slice(0, -1))).toThrow(/exactly one row UUID/);
  expect(() => operatorPluginRefreshRearmRequests([...argv,
    `--cos-rearm-plugin-refresh=${randomUUID()}`])).toThrow(/exactly one row UUID/);
});
it('durably grants one exact exhausted Core row one attempt without resetting automatic audit', async () => {
  publish();
  const request = (await pendingPluginRefreshes())[0]!;
  const installed = [{ ...tools[0]!, description: 'Older installed declaration' }];
  expect(await requireManualPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: installed, error: 'Automatic refresh is exhausted.' })).toBe(true);
  expect(await coreConnectorPresence()).toBeNull();

  const receipt = randomUUID();
  const exact = { id: request.id, schemaId: request.schemaId, appId, receipt };
  expect(await rearmCorePluginRefreshByOperator({ ...exact, id: randomUUID() })).toBe(false);
  expect(await rearmCorePluginRefreshByOperator({ ...exact, schemaId: 'b'.repeat(64) })).toBe(false);
  expect(await rearmCorePluginRefreshByOperator({ ...exact, appId: 'asdk_app_wrong' })).toBe(false);
  wake.mockClear();
  expect(await rearmCorePluginRefreshByOperator(exact)).toBe(true);
  expect(wake).toHaveBeenCalledTimes(1);
  expect(await rearmCorePluginRefreshByOperator({ ...exact, receipt: randomUUID() })).toBe(false);
  const granted = (await pendingPluginRefreshes())[0]!;
  expect(granted).toMatchObject({ id: request.id, appId,
    operatorRearmReceipt: receipt, operatorRearmGeneration: 1 });
  expect(granted.observationOnly).toBeUndefined();

  const token = randomUUID();
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: installed, attemptToken: token })).toBe(true);
  let stored = (await readDurable('plugin-refresh') as any[])[0];
  expect(stored).toMatchObject({ attempted: true, attemptCount: 0, attemptToken: token, manual: false });
  expect(stored.operatorRearms).toEqual([
    expect.objectContaining({ receipt, schemaId: request.schemaId, appId, attemptCount: 0,
      authorizedAt: expect.any(Number) })
  ]);
  expect(await failPluginRefresh({ id: request.id, error: 'Receipt missing its exact token.' })).toBe(false);
  expect(await failPluginRefresh({ id: request.id, appId, attemptToken: token,
    error: 'The operator attempt remained stale.' })).toBe(true);
  expect(await coreConnectorPresence()).toBeNull();

  // A second claim cannot mint another click. It stays closed during its bounded receipt window,
  // then returns the same row to manual state with all prior evidence intact.
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: installed, attemptToken: randomUUID() })).toBe(false);
  expect((await readDurable('plugin-refresh') as any[])[0].manual).toBe(false);
  vi.advanceTimersByTime(300_000);
  expect((await pendingPluginRefreshes())[0]).toMatchObject({ id: request.id, observationOnly: true });
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: installed, attemptToken: randomUUID() })).toBe(false);
  stored = (await readDurable('plugin-refresh') as any[])[0];
  expect(stored).toMatchObject({ attemptCount: 0, attemptToken: token, manual: true });
  expect(stored.operatorRearms).toHaveLength(1);

  // A later explicit request is another single durable grant, never an automatic loop/reset.
  const secondReceipt = randomUUID();
  expect(await rearmCorePluginRefreshByOperator({ ...exact, receipt: secondReceipt })).toBe(true);
  stored = (await readDurable('plugin-refresh') as any[])[0];
  expect(stored.attemptCount).toBe(0);
  expect(stored.operatorRearms.map((entry: any) => entry.receipt)).toEqual([receipt, secondReceipt]);
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools, alreadyCurrent: true })).toBe(true);
  expect(await rearmCorePluginRefreshByOperator({ ...exact, receipt: randomUUID() })).toBe(false);
  expect(await coreConnectorPresence()).toEqual({ connectorName: 'Chat On Steroids Core', appId });
});
it('fails an uncreated operator owner closed by exact receipt and permits a later explicit generation', async () => {
  publish();
  const request = (await pendingPluginRefreshes())[0]!;
  const installed = [{ ...tools[0]!, description: 'Older installed declaration' }];
  expect(await requireManualPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: installed, error: 'Automatic refresh is exhausted.' })).toBe(true);
  const receipt = randomUUID();
  const exact = { id: request.id, schemaId: request.schemaId, appId, receipt };
  expect(await rearmCorePluginRefreshByOperator(exact)).toBe(true);
  expect(await failOperatorPluginRefreshOwner({ id: request.id, receipt, generation: 2,
    error: 'Wrong generation.' })).toBe(false);
  expect(await failOperatorPluginRefreshOwner({ id: request.id, receipt, generation: 1,
    error: 'The replacement owner could not be created.' })).toBe(true);
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ manual: true,
    error: 'The replacement owner could not be created.' });
  expect(await rearmCorePluginRefreshByOperator({ ...exact, receipt: randomUUID() })).toBe(true);
  expect((await pendingPluginRefreshes())[0]).toMatchObject({ operatorRearmGeneration: 2 });
});
it('accepts an exact manual verdict after a claimed attempt without refunding its authorization', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const installed = [{ ...tools[0]!, description: 'Older installed declaration' }];
  const token = randomUUID();
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: installed, attemptToken: token })).toBe(true);
  const before = (await readDurable('plugin-refresh') as any[])[0];
  expect(await requireManualPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: installed, error: 'Refresh disappeared after the claimed attempt.' })).toBe(true);
  const stored = (await readDurable('plugin-refresh') as any[])[0];
  expect(stored).toMatchObject({ appId, attempted: true, attemptCount: 1, attemptToken: token,
    retryNotBefore: before.retryNotBefore, manual: true,
    error: 'Refresh disappeared after the claimed attempt.' });
  expect(await requireManualPluginRefresh({ ...request, appId: 'asdk_app_other',
    connectorName: 'Chat On Steroids Core', tools: installed, error: 'Wrong app.' })).toBe(false);
  expect(await pendingPluginRefreshes({ includeClaimed: true })).toEqual([
    expect.objectContaining({ id: request.id, appId, observationOnly: true })
  ]);
});
it('shows bounded exact tool differences when a confirmed Core app has stale schema and no native Refresh', async () => {
  publish();
  const first = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...first, appId, connectorName: 'Chat On Steroids Core',
    tools, alreadyCurrent: true })).toBe(true);
  const expected = [
    { ...tools[0]!, inputSchema: { type: 'object', properties: { path: { type: 'string' }, mode: { type: 'string' } } } },
    { name: 'settings_read', description: 'Read settings.', inputSchema: { type: 'object' } },
    { name: 'settings_update', description: 'Update settings.', inputSchema: { type: 'object' } },
    { name: 'update_plan', description: 'Current private instructions.', inputSchema: { type: 'object' } }
  ];
  publish('2', expected);
  const request = (await pendingPluginRefreshes())[0]!;
  const provider = [tools[0]!, { ...expected[3]!, description: 'Old private instructions.' }];
  expect(await requireManualPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: provider,
    error: 'Connector schema differs, but ChatGPT exposes no Refresh control. Recreate or republish this custom app to load the current tool schema.'
  })).toBe(true);
  const row = (await readDurable('plugin-refresh') as any[])[0];
  expect(row).toMatchObject({ id: request.id, appId, manual: true, attemptCount: 0 });
  expect(row.error).toContain('read:schema');
  expect(row.error).toContain('settings_read:missing');
  expect(row.error).toContain('settings_update:missing');
  expect(row.error).toContain('update_plan:description');
  expect(row.error).toContain('republish');
  expect(row.error.length).toBeLessThanOrEqual(200);
  expect(row.error).not.toMatch(/private instructions/i);
  expect(await coreConnectorPresence()).toBeNull();
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect((await pendingPluginRefreshes({ includeClaimed: true }))[0]).toMatchObject({
    id: request.id, observationOnly: true
  });
});
it('keeps an exact app mapping and refuses another installed same-name plugin', async () => {
  publish(); const a = (await pendingPluginRefreshes())[0]!;
  expect(await claim(a)).toBe(true);
  expect(await completePluginRefresh({ ...a, appId: 'asdk_app_other', tools })).toBe(false);
  publish('2', [{ ...tools[0]!, description: 'New contract' }]); const b = (await pendingPluginRefreshes())[0]!;
  expect(b.appId).toBe(appId);
  expect(await claimPluginRefresh({ ...b, appId: 'asdk_app_other', connectorName: 'Chat On Steroids Core', tools })).toBe(false);
});
it('enrolls an older Core subset only with two unchanged full declarations, then requires the enabled tool at completion', async () => {
  const session = { name: 'session', description: 'Read recorded history.', inputSchema: { type: 'object', properties: { action: { enum: ['search', 'read'] } } } };
  const finish = { name: 'finish', description: 'Finish the turn.', inputSchema: { type: 'object' } };
  const installed = [...tools, session];
  publish('2', [...installed, finish]);
  const request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request, tools)).toBe(false);
  expect(await claim(request, [tools[0]!, { ...session, description: 'Unrelated session tool' }])).toBe(false);
  expect(await claim(request, [...installed, { ...finish, name: 'foreign_tool' }])).toBe(false);
  expect(await claim(request, installed)).toBe(true);
  expect(await completePluginRefresh({ ...request, appId, tools: installed })).toBe(false);
  expect(await completePluginRefresh({ ...request, appId, tools: [...installed, finish] })).toBe(true);
});
it('keeps pre-claim errors observable and retries the same obligation after restart', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await failPluginRefresh({ id: request.id, error: 'Mapped plugin is not installed in this page' })).toBe(true);
  resetPluginRefreshForTests(); publish();
  expect((await pendingPluginRefreshes())[0]?.id).toBe(request.id);
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(false);
  expect((await readDurable('plugin-refresh') as any[])[0].attempted).toBe(false);
  expect(await claim(request)).toBe(true);
  expect((await readDurable('plugin-refresh') as any[])[0].error).toBeUndefined();
  expect(await pendingPluginRefreshes()).toEqual([]);
});
it('requires readable declarations before claiming even an enrolled exact app', async () => {
  publish(); const first = (await pendingPluginRefreshes())[0]!;
  await claim(first);
  publish('2', [{ ...tools[0]!, description: 'New schema' }]);
  const next = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...next, appId, connectorName: 'Chat On Steroids Core', tools: null })).toBe(false);
  expect((await readDurable('plugin-refresh') as any[])[0].attempted).toBe(false);
  expect(await claim(next)).toBe(true);
});
it('enrolls an older known Core superset when a user disabled a tool, never a foreign tool', async () => {
  const session = { name: 'session', description: 'Read recorded history.', inputSchema: { type: 'object' } };
  const remaining = [...tools, session];
  const removed = { name: 'keep_astra_on_forever', description: 'Previously enabled finish hold.', inputSchema: { type: 'object' } };
  publish('2', remaining);
  const request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request, [...remaining, { ...removed, name: 'foreign_tool' }])).toBe(false);
  expect(await claim(request, [...remaining, removed])).toBe(true);
  expect(await completePluginRefresh({ ...request, appId, tools: [...remaining, removed] })).toBe(false);
  expect(await completePluginRefresh({ ...request, appId, tools: remaining })).toBe(true);
});
it('repairs legacy impossible click receipts only when no concrete app was ever claimed', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const stored = await readDurable('plugin-refresh') as any[];
  stored[0].attempted = true; stored[0].error = 'Exact connector settings or Refresh control could not be verified';
  await writeDurableNow('plugin-refresh', stored);
  expect((await pendingPluginRefreshes())[0]?.id).toBe(request.id);
  await claim(request);
  expect(await pendingPluginRefreshes()).toEqual([]);
});
it('admits only one concurrent authorization and keeps completion observable during cooldown', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const firstToken = randomUUID(), secondToken = randomUUID();
  expect(await Promise.all([
    claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools: [{ ...tools[0]!, description: 'Older declaration' }], attemptToken: firstToken }),
    claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools: [{ ...tools[0]!, description: 'Older declaration' }], attemptToken: secondToken })
  ])).toEqual([true, false]);
  resetPluginRefreshForTests(); publish();
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect(await failPluginRefresh({ id: request.id, error: 'Refresh outcome unavailable' })).toBe(false);
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect((await pendingPluginRefreshes({ includeClaimed: true }))[0]?.id).toBe(request.id);
  expect(await claim(request)).toBe(false);
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(true);
});
it('consumes a confirmed-unclicked authorization and shortens only its bounded cooldown', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const firstToken = randomUUID();
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: [{ ...tools[0]!, description: 'Older declaration' }], attemptToken: firstToken })).toBe(true);
  expect(await failPluginRefresh({ id: request.id, appId, attemptToken: firstToken,
    confirmedUnclicked: true, error: 'Owner changed before click' })).toBe(true);
  expect(await pendingPluginRefreshes()).toEqual([]);
  let stored = (await readDurable('plugin-refresh') as any[])[0];
  expect(stored).toMatchObject({ id: request.id, appId, attempted: true, attemptCount: 1, attemptToken: firstToken });
  const shortenedDeadline = stored.retryNotBefore;
  vi.advanceTimersByTime(2_000);
  expect(await failPluginRefresh({ id: request.id, appId, attemptToken: firstToken,
    confirmedUnclicked: true, error: 'Duplicate owner-changed receipt' })).toBe(true);
  stored = (await readDurable('plugin-refresh') as any[])[0];
  expect(stored.retryNotBefore).toBe(shortenedDeadline);
  vi.advanceTimersByTime(3_000);
  expect((await pendingPluginRefreshes())[0]).toMatchObject({ id: request.id, appId });
  const secondToken = randomUUID();
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: [{ ...tools[0]!, description: 'Older declaration' }], attemptToken: secondToken })).toBe(true);
  expect(await failPluginRefresh({ id: request.id, appId, attemptToken: firstToken,
    confirmedUnclicked: true, error: 'Late stale receipt' })).toBe(false);
  stored = (await readDurable('plugin-refresh') as any[])[0];
  expect(stored).toMatchObject({ attempted: true, attemptCount: 2, attemptToken: secondToken });
});
it('migrates a persisted ambiguous authorization as attempt one without inferring from error text', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const [stored] = await readDurable('plugin-refresh') as any[];
  Object.assign(stored, { appId, attempted: true,
    error: 'Connector refresh claim or page ownership was not confirmed' });
  delete stored.attemptCount; delete stored.retryNotBefore; delete stored.attemptToken;
  await writeDurableNow('plugin-refresh', [stored]);
  resetPluginRefreshForTests(); publish();
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({
    id: request.id, appId, attempted: true, attemptCount: 1, attemptToken: null
  });
  vi.advanceTimersByTime(30_000);
  expect((await pendingPluginRefreshes())[0]).toMatchObject({ id: request.id, appId });
});
it('does not shorten an ambiguous post-click cooldown and exhausts after three bounded authorizations', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const first = randomUUID();
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: [{ ...tools[0]!, description: 'Older declaration' }], attemptToken: first })).toBe(true);
  expect(await failPluginRefresh({ id: request.id, appId, attemptToken: first,
    error: 'Refresh click outcome unavailable' })).toBe(true);
  vi.advanceTimersByTime(29_999);
  expect(await pendingPluginRefreshes()).toEqual([]);
  vi.advanceTimersByTime(1);
  const second = randomUUID();
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: [{ ...tools[0]!, description: 'Older declaration' }], attemptToken: second })).toBe(true);
  vi.advanceTimersByTime(120_000);
  const third = randomUUID();
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: [{ ...tools[0]!, description: 'Older declaration' }], attemptToken: third })).toBe(true);
  vi.advanceTimersByTime(300_000);
  wake.mockClear();
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools: [{ ...tools[0]!, description: 'Older declaration' }], attemptToken: randomUUID() })).toBe(false);
  expect(wake).toHaveBeenCalledTimes(1);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ attempted: true, attemptCount: 3, manual: true });
  const terminal = (await pendingPluginRefreshes({ includeClaimed: true }))[0]!;
  expect(terminal).toMatchObject({ id: request.id, appId, observationOnly: true });
  expect(await claimPluginRefresh({ ...terminal, appId, connectorName: 'Chat On Steroids Core',
    tools: [{ ...tools[0]!, description: 'Older declaration' }], attemptToken: randomUUID() })).toBe(false);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ attemptCount: 3, manual: true });
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core',
    tools, alreadyCurrent: true })).toBe(true);
  expect(await pendingPluginRefreshes()).toEqual([]);
});
it('does not let an unpublished connector accept a receipt', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!; await claim(request);
  unpublishPluginSurface('core');
  expect(pluginRefreshPublications()).toEqual([]);
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(false);
});
it('captures actual registered object schemas without executing handlers', async () => {
  const config = defaultConfig(); let observed: PluginToolSchema[] = [];
  const server = buildServer({ roots: [], caps: config.capabilities, readOnly: false }, 'core', (_name, _version, _instructions, definitions) => { observed = definitions; });
  expect(observed.some(tool => tool.name === 'read')).toBe(true);
  expect(observed.every(tool => tool.inputSchema.type === 'object')).toBe(true);
  expect(observed.some(tool => tool.name === 'computer')).toBe(false);
  await server.close();
});

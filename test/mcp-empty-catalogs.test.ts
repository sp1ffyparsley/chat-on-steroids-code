import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initConfigPath, loadConfig, getConfig, effectiveCapabilities } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, flushSessions } from '../src/main/session/store.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { publishedSurfaceIds, type SurfaceId } from '../src/main/mcp/surfaces.js';
import { pluginManager } from '../src/main/plugins/manager.js';
import { makeTempDir, removeTempDir } from './helpers.js';

// Adapted from Maximapple's upstream PR1576 (b1a77190), retaining this fork's
// platform-specific connector publication and real, isolated HTTP transport.
// Modern enrollment asks for resources; an unhandled empty catalog returns 404,
// which ChatGPT reports as connector enrollment failure rather than an empty list.
let directory: string;
let endpoint: McpEndpoint | undefined;
beforeAll(async () => {
  directory = await makeTempDir('clf-mcp-catalogs-');
  initConfigPath(directory);
  await loadConfig();
  initDurableStore(directory);
  initSessionStore(directory);
  await pluginManager.initialize(directory);
  endpoint = await startMcpServer(() => ({
    roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly
  }));
});
afterAll(async () => {
  try {
    await endpoint?.stop();
    await pluginManager.close();
    await flushSessions();
    await flushDurable();
  } finally {
    resetDurableForTests();
    if (directory) await removeTempDir(directory);
  }
});

const MODERN = '2026-07-28';
const meta = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'catalog-regression', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {}
};
let nextId = 1;
async function call(surface: SurfaceId, method: string, modern: boolean, args: Record<string, unknown> = {}) {
  if (!endpoint) throw new Error('Isolated catalog endpoint was not started');
  const headers: Record<string, string> = {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-protocol-version': modern ? MODERN : '2025-06-18'
  };
  if (modern) {
    headers['mcp-method'] = method;
    // Modern named methods must mirror their name/URI in the standard header,
    // otherwise a malformed-envelope rejection would not test the absent handler.
    const name = args.name ?? args.uri;
    if (typeof name === 'string') headers['mcp-name'] = name;
  }
  const params = modern ? { ...args, _meta: meta } : method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'catalog-regression', version: '1' } }
    : args;
  const response = await fetch(endpoint.urls[surface], {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  });
  const text = await response.text();
  const data = [...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? text;
  return { status: response.status, body: JSON.parse(data) };
}

const catalogs = [
  ['resources/list', 'resources'],
  ['resources/templates/list', 'resourceTemplates'],
  ['prompts/list', 'prompts']
] as const;
describe.each(publishedSurfaceIds())('empty enrollment catalogs on %s', surface => {
  it('advertises the supported empty catalogs without expanding tool permissions', async () => {
    const initialized = await call(surface, 'initialize', false);
    expect(initialized.status).toBe(200);
    expect(initialized.body.error).toBeUndefined();
    expect(initialized.body.result.capabilities.resources).toEqual({});
    expect(initialized.body.result.capabilities.prompts).toEqual({});
  });

  for (const modern of [true, false]) {
    it.each(catalogs)(`answers %s as empty, modern=${modern}`, async (method, key) => {
      const reply = await call(surface, method, modern);
      expect(reply.status).toBe(200);
      expect(reply.body.error).toBeUndefined();
      // Modern SDK responses also carry protocol-owned cache/server metadata.
      expect(reply.body.result[key]).toEqual([]);
      expect(reply.body.result.nextCursor).toBeUndefined();
    });
  }

  it('does not add resource reads or prompt execution', async () => {
    for (const [method, args] of [
      ['resources/read', { uri: 'file:///catalogs-must-not-grant-access' }],
      ['prompts/get', { name: 'catalogs-must-not-grant-execution' }]
    ] as const) {
      const reply = await call(surface, method, true, args);
      expect(reply.status).toBe(404);
      expect(reply.body.error?.code).toBe(-32601);
    }
  });

  it('retains the same surface tool list after catalog discovery', async () => {
    const before = await call(surface, 'tools/list', true);
    expect(before.status).toBe(200);
    expect(before.body.result.tools).toBeInstanceOf(Array);
    for (const [method] of catalogs) expect((await call(surface, method, true)).status).toBe(200);
    const after = await call(surface, 'tools/list', true);
    expect(after.status).toBe(200);
    expect(after.body.result.tools).toEqual(before.body.result.tools);
  });
});

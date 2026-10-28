/** Real HTTP coverage for the remote settings boundary; no MCP/config wiring is mocked. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { getConfig, initConfigPath, loadConfig, updateConfig } from '../src/main/config.js';
import { configureSettingsControl } from '../src/main/settings-control.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/tools.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore } from '../src/main/session/store.js';

let root: string, endpoint: McpEndpoint, ctx: ToolContext, saves = 0, nextId = 1;
const schema = z.object({
  ui: z.object({ theme: z.enum(['dark', 'light']), developerMode: z.boolean(),
    automationPaused: z.boolean().optional(), followOutput: z.boolean().optional() }),
  goal: z.object({ prompt: z.string() }), mcp: z.object({ instructions: z.string() }),
  capabilities: z.record(z.string(), z.boolean()), tunnel: z.object({ kind: z.enum(['openai', 'cloudflared', 'manual']) })
});
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(endpoint.urls.core, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream'
  }, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }) });
  expect(response.status).toBe(200);
  const text = (await response.text()).trim();
  const wire = JSON.parse(text.startsWith('{') ? text : [...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)![1]!);
  return { failed: !!wire.error || wire.result?.isError === true,
    text: (wire.result?.content ?? []).map((item: { text?: string }) => item.text ?? '').join('\n') };
}
async function inspected() {
  const result = await call('settings_read');
  expect(result.failed, result.text).toBe(false);
  return JSON.parse(result.text);
}
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-settings-http-'));
  initConfigPath(root); await loadConfig();
  initDurableStore(root); initSessionStore(root);
  await updateConfig(config => ({ ...config, ui: { ...config.ui, developerMode: true, automationPaused: true },
    goal: { ...config.goal, prompt: 'private goal prompt sentinel' },
    mcp: { ...config.mcp, instructions: 'private instructions sentinel' } }));
  configureSettingsControl({ schema, save: async ({ base, patch }) => {
    saves++;
    await updateConfig(config => {
      if (JSON.stringify(schema.parse(config)) !== JSON.stringify(base)) throw new Error('stale fixture save');
      const next = schema.parse(patch);
      return { ...config, ui: { ...config.ui, ...next.ui }, goal: { ...config.goal, ...next.goal },
        mcp: { ...config.mcp, ...next.mcp }, capabilities: next.capabilities as typeof config.capabilities,
        tunnel: { ...config.tunnel, ...next.tunnel } };
    });
  } });
  ctx = { roots: [], caps: { ...DEFAULT_CAPABILITIES }, readOnly: false, sessionTools: false, agentTools: false };
  endpoint = await startMcpServer(() => ctx);
});
beforeEach(() => {
  saves = 0;
  ctx.caps = Object.fromEntries(Object.keys(DEFAULT_CAPABILITIES).map(key => [key, false])) as typeof ctx.caps;
  ctx.caps.metadata = true; ctx.readOnly = false;
});
afterAll(async () => {
  await endpoint?.stop(); resetDurableForTests();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
it('metadata-only settings_read omits private prompts, trust, paths and local-only settings', async () => {
  const value = await inspected();
  const text = JSON.stringify(value);
  expect(value.settings.ui.theme).toBe(getConfig().ui.theme);
  expect(value.settings.goal).toBeUndefined(); expect(value.settings.mcp).toBeUndefined();
  expect(value.settings.capabilities).toBeUndefined(); expect(value.settings.tunnel).toBeUndefined();
  expect(value.settings.ui.developerMode).toBeUndefined(); expect(value.settings.ui.automationPaused).toBeUndefined();
  expect(value.paths).toBeUndefined(); expect(value.approvedFolders).toBeUndefined();
  expect(text).not.toContain('private goal prompt sentinel'); expect(text).not.toContain('private instructions sentinel');
  expect(text).not.toContain(root); expect(saves).toBe(0);
});
it('command permission cannot update local-only fields and refuses before Save', async () => {
  ctx.caps.command = true;
  const value = await inspected(), before = JSON.stringify(getConfig());
  const result = await call('settings_update', { instanceId: value.instanceId, revision: value.revision,
    patch: { ui: { developerMode: !getConfig().ui.developerMode } } });
  expect(result.failed).toBe(true); expect(result.text).toContain('local-only');
  expect(saves).toBe(0); expect(JSON.stringify(getConfig())).toBe(before);
});
it('writable command permission saves permitted theme through the real config owner', async () => {
  ctx.caps.command = true;
  const value = await inspected(), theme = getConfig().ui.theme === 'dark' ? 'light' : 'dark';
  const result = await call('settings_update', { instanceId: value.instanceId, revision: value.revision, patch: { ui: { theme } } });
  expect(result.failed).toBe(false); expect(JSON.parse(result.text).settings.ui.theme).toBe(theme);
  expect(saves).toBe(1); expect(getConfig().ui.theme).toBe(theme);
  expect(getConfig().goal.prompt).toBe('private goal prompt sentinel');
  expect(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')).ui.theme).toBe(theme);
});
it('read-only command context refuses updates before Save', async () => {
  ctx.caps.command = true; ctx.readOnly = true;
  const value = await inspected(), before = JSON.stringify(getConfig());
  const result = await call('settings_update', { instanceId: value.instanceId, revision: value.revision,
    patch: { ui: { theme: getConfig().ui.theme === 'dark' ? 'light' : 'dark' } } });
  expect(result.failed).toBe(true); expect(result.text).toContain('writable');
  expect(saves).toBe(0); expect(JSON.stringify(getConfig())).toBe(before);
});

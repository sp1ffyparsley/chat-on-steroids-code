/**
 * Builds the MCP server for one surface.
 *
 * There is no "the" tool list any more. Each connector is its own server with its own
 * `tools/list`, because that list is the unit ChatGPT discovers: a no-query discovery pull
 * returns everything one server advertises, so the only real way to bound what a
 * conversation can be handed is to publish less per server (`docs/tool-surface.md` §6.4).
 *
 * The invariant this file enforces is that the boundary is *real*. A server registers the
 * tools its surface names and nothing else, so a Core server has no handler for `computer`
 * and answers a call for it with an unknown-tool error from the protocol layer itself.
 * There is no hidden acceptance of names a server did not advertise, and there is no
 * merged list — those would both be ways of claiming a separation the product does not have.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { toolSchemaJson } from './tool-declarations.js';
import type { PluginToolSchema } from '../../shared/plugin-refresh.js';
import { createRegistrar, type ToolContext } from './kernel.js';
import { registerCoreTools } from './tools-core.js';
import { registerDesktopTools } from './tools-desktop.js';
import { registerPluginTools } from './tools-plugins.js';
import { registerCodeMode } from './code-mode-tool.js';
import { surfaceDeclaredTools, surfaceDefinition, type SurfaceId } from './surfaces.js';
import { serverInstructions } from './instructions.js';
import { APP_VERSION } from './../version.js';
import { toVirtualPath } from '../sandbox.js';
import { logWarn } from '../logger.js';
import { withSkillsRoot } from '../skill-context.js';
import { refreshSharedFolderAccess } from '../config.js';

/** Empty discovery catalogs are supported, not absent protocol methods (upstream PR1576).
 * Modern ChatGPT enrollment asks for these lists even on tool-only connectors. An
 * unhandled request becomes HTTP404/-32601 and can reject the entire enrollment.
 * Advertising empty catalogs grants no resource-read or prompt-execution handler.
 */
function answerEmptyCatalogs(server: McpServer): void {
  // Register on the low-level owner: the SDK's high-level constructor would also
  // install resources/read and prompts/get. This server offers lists only.
  server.server.registerCapabilities({ resources: {}, prompts: {} });
  server.server.setRequestHandler('resources/list', async () => ({ resources: [] }));
  server.server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [] }));
  server.server.setRequestHandler('prompts/list', async () => ({ prompts: [] }));
}

export function buildServer(ctx: ToolContext, surface: SurfaceId, observe?: (connectorName: string, version: string, instructions: string, tools: PluginToolSchema[]) => void, liveContext: () => ToolContext = () => ctx): McpServer {
  if (surface === 'core') ctx = withSkillsRoot(ctx);
  const definition = surfaceDefinition(surface);
  const instructions = serverInstructions(ctx, surface);
  const server = new McpServer(
    { name: definition.serverName, version: APP_VERSION },
    { capabilities: { tools: {} }, instructions }
  );
  answerEmptyCatalogs(server);

  const tools: PluginToolSchema[] = [];
  if (surface === 'plugins') {
    const declarations = registerPluginTools(server);
    observe?.(definition.connectorName, APP_VERSION, instructions, declarations);
    return server;
  }
  const registrar = createRegistrar(server, ctx, surface, observe ? (name, config) => {
    // Match the SDK's Standard Schema conversion target and object-root normalization.
    const schema = toolSchemaJson(config.inputSchema);
    tools.push({ name, description: config.description, inputSchema: { type: 'object', ...schema }, ...(config.annotations ? { annotations: { ...config.annotations } } : {}) });
  } : undefined);
  if (surface === 'core') {
    registerCoreTools(registrar);
    // Windows has one user-facing Core connector. Reuse the incumbent Desktop registrars so
    // screen/input/browser/clipboard permissions and execution owners remain independent even
    // though discovery/publication no longer asks the user to create a second connector.
    if (process.platform === 'win32') registerDesktopTools(registrar);
  } else registerDesktopTools(registrar);
  registerCodeMode(registrar, async (name, args, parent) => {
    // Reuse the same registration/validation/handler authority, refreshed for every child
    // so a permission or approved-root change during an awaited script takes effect.
    await refreshSharedFolderAccess();
    const live = liveContext();
    const nested = createRegistrar(null, surface === 'core' ? withSkillsRoot(live) : live, surface);
    if (surface === 'core') {
      registerCoreTools(nested);
      if (process.platform === 'win32') registerDesktopTools(nested);
    } else registerDesktopTools(nested);
    return nested.invokeNested(name, args, parent);
  }, { windowsDesktop: process.platform === 'win32' && (surface === 'core' || surface === 'desktop') });

  // Cheap self-check on a property the tests assert and the design depends on: a surface
  // may register fewer tools than it declares — permissions decide that — but it may never
  // register one it does not declare. Logged rather than thrown, because refusing to serve
  // would turn a naming slip into a dead connector for the user.
  const declared = new Set(surfaceDeclaredTools(surface));
  for (const name of registrar.registered()) {
    if (!declared.has(name)) {
      logWarn(`MCP surface ${surface} registered "${name}", which it does not declare — check surfaces.ts`);
    }
  }

  observe?.(definition.connectorName, APP_VERSION, instructions, tools);
  return server;
}

export { toVirtualPath };
export type { ToolContext };
export { chunkText, lastToolCallAt, resetToolClock, transportIdentityStatus } from './kernel.js';

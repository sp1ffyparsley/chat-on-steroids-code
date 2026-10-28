/**
 * The model-facing surfaces this app publishes, and what each one is for.
 *
 * ChatGPT connects to one MCP server per connector, and the *whole* of that server's
 * tool list is one discovery unit: `api_tool.list_resources(paths=["Name"])` with no
 * query returns every schema the server advertises. A query narrows it, but nothing
 * guarantees the harness will ask a narrow one, so the honest planning number for a
 * surface is its complete tools/list — not the subset a lucky query would return.
 *
 * That is the entire reason this file exists. Splitting into separate servers is the
 * only mechanism that actually bounds the worst case, because a separate server is a
 * separate discovery boundary that no query can cross.
 *
 * It is deliberately not a splitting free-for-all. Every extra surface is another
 * connector the user has to create, name, describe and keep connected, and on the
 * OpenAI tunnel it is another tunnel id as well (see `docs/tool-surface.md` §6.4).
 * A surface has to earn that. The test applied here is: a distinct capability boundary
 * the user already thinks in, plus enough schema weight that folding it into Core
 * would meaningfully raise Core's no-query cost.
 *
 * Two surfaces pass that test today.
 */

import type { Capabilities } from '../../shared/types.js';
import { instanceConnectorAccountAlias, instanceProfileSchema, type InstanceProfile } from '../../shared/instance-profile.js';
import { learnedConnectorName } from '../connector-identity.js';
import { desktopAutomationSupported } from '../platform.js';
import { WINDOWS_COMPUTER_METHODS, WINDOWS_COMPUTER_READ_METHODS, WINDOWS_COMPUTER_INPUT_METHODS } from '../../shared/windows-computer.js';
import { BROWSER_TOOLS, BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS } from '../../shared/browser-control.js';

export const SURFACE_IDS = ['core', 'desktop', 'plugins'] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

/**
 * Brand shown to the user and pasted into ChatGPT.
 *
 * One constant because it appears in the MCP server name, the suggested connector
 * name and the setup cards, and those three drifting apart is how a user ends up with
 * a connector whose name does not match the thing the instructions told them to type.
 */
export const CONNECTOR_BRAND = 'Chat On Steroids';

export interface SurfaceDefinition {
  id: SurfaceId;
  /** MCP server name. Stable; ChatGPT keys its cached metadata off it. */
  serverName: string;
  /**
   * Exactly what the user should type as the connector name in ChatGPT.
   *
   * Offered as copyable text rather than described, because the name is also the
   * retrieval handle: `paths=["…"]` is matched against it, and a user who invents
   * "my pc" gets a surface the model cannot address by name.
   */
  connectorName: string;
  /**
   * Exactly what the user should paste as the connector description.
   *
   * This is the single most load-bearing string in the whole design. Before any
   * discovery has happened the model holds the server name and this sentence and
   * nothing else, and it decides from them alone whether to pull this surface's
   * schemas at all. So it is written as vocabulary, not as prose: the words a person
   * would actually use for the work live in here, because a query that misses is
   * indistinguishable to the model from a capability that does not exist.
   */
  description: string;
  /** Short line for the setup card, in the app's own voice. */
  cardSummary: string;
  /**
   * Whether the app is usable without it. Core is required; Desktop is opt-in and
   * most sessions never want it.
   */
  required: boolean;
  /**
   * Every tool this surface can ever advertise, in listing order.
   *
   * The authority for tests, for the setup UI's "what you get" list, and for the
   * cross-surface leakage assertions. A tool that appears here and nowhere else is a
   * bug in one direction; a tool registered on a server that does not name it here is
   * a bug in the other.
   */
  tools: readonly string[];
}

/**
 * Instance profiles only project identity onto the existing three connector owners.
 * Tool declarations, descriptions and capability boundaries remain owned by this file.
 */
export type SurfaceIdentity = Record<SurfaceId, Pick<SurfaceDefinition, 'serverName' | 'connectorName'>>;

/**
 * Core — the coding loop.
 *
 * `session` and `agents` live here rather than on surfaces of their own, and that is a
 * decision with a concrete reason rather than a tidiness preference:
 *
 *  - `session` is how a chat discovers and reads local recordings of past or concurrently
 *    running work — including exact authored messages and the arguments/result of one call.
 *    That is part of the coding loop rather than an extra connector.
 *  - `agents` is one flat tool and is registered only while multi-agent mode is on.
 *    Fresh installs enable it; an existing config that keeps it off still pays nothing for
 *    it here. A dedicated connector for one conditional schema is pure setup overhead with
 *    no discovery benefit.
 *
 * Each surface also exposes JavaScript exec, restricted to that surface's own tools.
 * `find` and the exec pair are mutually exclusive — `find` exists only when command
 * execution is off — so not all declarations are exposed together.
 */
const CORE: SurfaceDefinition = {
  id: 'core',
  serverName: 'chat-on-steroids-core',
  connectorName: `${CONNECTOR_BRAND} Core`,
  description:
    'Read and edit code and text files on this computer, and run commands in a real terminal. ' +
    'Use for: opening and reading files, searching a repository, applying patches, creating, renaming and deleting files, ' +
    'running builds, tests, linters, git, npm and shell commands, continuing long-running or interactive terminal sessions, ' +
    'and saving images and files ChatGPT generates onto this computer. ' +
    'Also searches and reads local recordings of previous or concurrently running ChatGPT work, and — when the user has ' +
    'enabled it — spawns and coordinates worker agents, subagents or a parallel swarm across several ChatGPT conversations.',
  cardSummary: 'Files, patches and the terminal. Required — this is the coding connector.',
  required: true,
  tools: ['settings_read', 'settings_update', 'read', 'view_image', 'find', 'apply_patch', 'exec_command', 'write_stdin', 'download_artifact', 'session', 'session_route', 'update_plan', 'agents', 'session_finish', 'exec']
};

/**
 * Desktop — seeing and driving the native desktop.
 *
 * This remains the internal capability/permission family for browser/native Desktop tools.
 * macOS/Linux publish it as a separate connector; Windows publishes these incumbent handlers
 * through Core so there is one user-facing Windows identity and one transport owner.
 */
const DESKTOP: SurfaceDefinition = {
  id: 'desktop',
  serverName: 'chat-on-steroids-desktop',
  connectorName: `${CONNECTOR_BRAND} Desktop`,
  description:
    'Control browser tabs in the background and this computer desktop, including its clipboard. ' +
    'Attach existing Chrome/Edge/Brave tabs or open new tabs; inspect DOM refs, page screenshots, JavaScript, console errors and network requests; click, fill forms and navigate without foreground activation. ' +
    'Use for: listing and launching apps, taking background window screenshots, reading what is on screen, listing and finding windows, inspecting buttons, fields and other UI controls, ' +
    'clicking, typing, pressing keys, scrolling and dragging in native applications, ' +
    'and reading the clipboard or copying and pasting text between programs.',
  cardSummary:
    'Browser tabs, DOM, console, network and background screenshots; native apps, input and clipboard where supported.',
  required: false,
  tools: [...BROWSER_TOOLS, ...WINDOWS_COMPUTER_METHODS, 'read_clipboard', 'write_clipboard', 'observe', 'computer', 'exec']
};

const PLUGINS: SurfaceDefinition = {
  id: 'plugins', serverName: 'chat-on-steroids-plugins',
  connectorName: `${CONNECTOR_BRAND} Plugins`,
  description: 'Tools from external MCP integrations installed and enabled in Chat On Steroids Settings, including Blender and other connected applications and services.',
  cardSummary: 'One shared connector for your enabled external MCP plugins.',
  required: false,
  // Dynamic declarations are owned and bounded by the plugin manager.
  tools: ['exec']
};

export const SURFACES: Record<SurfaceId, SurfaceDefinition> = { core: CORE, desktop: DESKTOP, plugins: PLUGINS };

export const SURFACE_LIST: readonly SurfaceDefinition[] = [CORE, DESKTOP, PLUGINS];

const LEGACY_SURFACE_IDENTITY: SurfaceIdentity = {
  core: { serverName: CORE.serverName, connectorName: CORE.connectorName },
  desktop: { serverName: DESKTOP.serverName, connectorName: DESKTOP.connectorName },
  plugins: { serverName: PLUGINS.serverName, connectorName: PLUGINS.connectorName }
};
const LEGACY_SURFACE_DESCRIPTIONS: Record<SurfaceId, string> = Object.fromEntries(
  SURFACE_LIST.map(surface => [surface.id, surface.description])
) as Record<SurfaceId, string>;

type SurfaceAccount = Pick<InstanceProfile, 'id' | 'displayName' | 'platform' | 'connector'>;

export function accountSurfaceDescriptions(profile?: SurfaceAccount): Record<SurfaceId, string> {
  const alias = profile ? instanceConnectorAccountAlias(profile) : null;
  if (!profile || !alias) return { ...LEGACY_SURFACE_DESCRIPTIONS };
  // Validate all profile-supplied copy before publishing any new name/description. The alias is
  // display metadata only; permissions, endpoint routing and learned app IDs retain their owners.
  const id = instanceProfileSchema.shape.id.parse(profile.id);
  const brand = instanceProfileSchema.shape.connector.shape.displayBrand.parse(profile.connector.displayBrand)!;
  if (/[\x00-\x1f\x7f\u2028\u2029]/.test(brand)) throw new Error('Invalid account label for connector description.');
  const platform = instanceProfileSchema.shape.platform.parse(profile.platform);
  const host = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'Mac' : 'Linux';
  // The saved brand, UUID and host are immutable account identity. A nickname edit must not
  // silently change what the user previously pasted into the provider's setup description.
  const prefix = `Connector ${JSON.stringify(brand)} on ${host}, alias ${alias}, local profile ${id}. `;
  const permission = "File tools honor approved folders; shell commands use enabled permissions and this OS user's access. A name or description grants no access. ";
  const coreHost = platform === 'win32'
    ? 'On Windows, enabled browser and native desktop tools are also published through this Core connector. '
    : 'Browser and desktop tools use the separate Desktop connector when enabled. ';
  const desktopHost = platform === 'darwin'
    ? 'On Mac, native desktop control also requires macOS permission. '
    : platform === 'linux'
      ? 'On Linux, browser tools are supported; native desktop control is unavailable. '
      : 'On Windows, this is an internal capability family published through Core, not a separate connector to create. ';
  return {
    core: `${prefix}${LEGACY_SURFACE_DESCRIPTIONS.core} ${permission}${coreHost}`,
    desktop: `${prefix}${LEGACY_SURFACE_DESCRIPTIONS.desktop} ${permission}${desktopHost}`,
    plugins: `${prefix}${LEGACY_SURFACE_DESCRIPTIONS.plugins} Only installed and enabled integrations are available; this identity grants no new plugin permissions.`
  };
}

function validateSurfaceIdentity(identity: SurfaceIdentity): void {
  const serverNames = new Set<string>();
  const connectorNames = new Set<string>();
  for (const id of SURFACE_IDS) {
    const projected = identity[id];
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/.test(projected.serverName)) {
      throw new Error(`Invalid ${id} MCP server name for the active instance`);
    }
    if (!projected.connectorName.trim() || projected.connectorName.length > 100) {
      throw new Error(`Invalid ${id} connector name for the active instance`);
    }
    const serverKey = projected.serverName.toLowerCase();
    const connectorKey = projected.connectorName.toLowerCase();
    if (serverNames.has(serverKey)) throw new Error(`Duplicate MCP server name ${projected.serverName}`);
    if (connectorNames.has(connectorKey)) throw new Error(`Duplicate connector name ${projected.connectorName}`);
    serverNames.add(serverKey);
    connectorNames.add(connectorKey);
  }
}

/**
 * Selects the active instance's exact MCP/ChatGPT connector names before any server starts.
 * Mutating the canonical definitions keeps every existing setup, metadata and publication
 * reader on the same identity instead of introducing a second lookup path.
 */
export function configureSurfaceIdentity(identity: SurfaceIdentity, profile?: SurfaceAccount): void {
  validateSurfaceIdentity(identity);
  const descriptions = accountSurfaceDescriptions(profile);
  for (const id of SURFACE_IDS) Object.assign(SURFACES[id], identity[id], { description: descriptions[id] });
}

/** Restores the historical single-instance names between isolated tests. */
export function resetSurfaceIdentityForTests(): void {
  configureSurfaceIdentity(LEGACY_SURFACE_IDENTITY);
}

export function surfaceDefinition(id: SurfaceId): SurfaceDefinition {
  return { ...SURFACES[id], connectorName: liveConnectorName(id) };
}

/** Stable profile identity owns setup and protected-resource metadata. */
export function configuredConnectorName(id: SurfaceId): string { return SURFACES[id].connectorName; }
/** A name from this install's served-request proof, never an unverified page label. */
export function liveConnectorName(id: SurfaceId): string {
  return learnedConnectorName(id) ?? configuredConnectorName(id);
}

/**
 * Windows presents browser/native Desktop capability through the one Core connector.
 *
 * Desktop remains a real internal capability/permission family and remains a separate public
 * connector on macOS/Linux. On Windows it must not become a second MCP publication owner: the
 * same Core request boundary advertises and dispatches the enabled Desktop declarations.
 */
export function surfacePublishedSeparately(
  id: SurfaceId,
  platform: NodeJS.Platform = process.platform
): boolean {
  return id !== 'desktop' || platform !== 'win32';
}

/** Public MCP surfaces for this host. Internal permission families are intentionally broader. */
export function publishedSurfaceIds(platform: NodeJS.Platform = process.platform): SurfaceId[] {
  return SURFACE_IDS.filter(id => surfacePublishedSeparately(id, platform));
}

/**
 * Complete declaration authority for one public server on this host.
 *
 * This is a potential-schema list, not the enabled live list. Registrars still apply the same
 * capability guards at call time and `desktopToolNames()` still projects the enabled subset for
 * setup/status. Dedupe `exec`, which both historical public definitions name as their one code
 * mode tool even though the merged Windows Core registers it only once.
 */
export function surfaceDeclaredTools(
  id: SurfaceId,
  platform: NodeJS.Platform = process.platform
): readonly string[] {
  if (id !== 'core' || platform !== 'win32') return surfaceDefinition(id).tools;
  return [...new Set([...CORE.tools, ...DESKTOP.tools])];
}

/** Platform/capability projection used by setup; each registrar enforces the same split. */
export function desktopToolNames(caps: Capabilities, platform: NodeJS.Platform = process.platform): string[] {
  const browser = [...(caps.screen ? BROWSER_READ_TOOLS : []), ...(caps.control ? BROWSER_WRITE_TOOLS : [])];
  if (!desktopAutomationSupported(platform)) return browser;
  if (platform !== 'win32') return [...browser, ...(caps.screen ? ['observe'] : []), ...(caps.control || caps.clipboardRead || caps.clipboardWrite ? ['computer'] : [])];
  return [
    ...browser,
    ...(caps.screen ? WINDOWS_COMPUTER_READ_METHODS : []),
    ...(caps.control ? WINDOWS_COMPUTER_INPUT_METHODS : []),
    ...(caps.clipboardRead ? ['read_clipboard'] : []),
    ...(caps.clipboardWrite ? ['write_clipboard'] : [])
  ];
}

/**
 * Whether a surface has anything to offer under these capabilities.
 *
 * Desktop with neither screen, control nor clipboard access would advertise an empty tool list,
 * which is worse than not being offered: the user pays the whole setup cost for a
 * connector that can do nothing, and ChatGPT shows them a working connection. The
 * setup UI uses this to grey the card out and say why.
 *
 * Core remains the required surface even when its live tool list is temporarily empty. Keeping
 * that identity stable is what lets permissions be enabled again without changing connectors.
 */
export function surfaceIsUseful(
  id: SurfaceId,
  caps: Capabilities,
  platform: NodeJS.Platform = process.platform,
  release?: string
): boolean {
  // Clipboard counts: it is reached through `computer`, so granting only the clipboard
  // still gives this surface something real to advertise.
  if (id === 'desktop') {
    return (
      caps.screen || caps.control || (desktopAutomationSupported(platform, release) && (caps.clipboardRead || caps.clipboardWrite))
    );
  }
  return true;
}

/** Public surfaces worth connecting under these capabilities, in setup order. */
export function usefulSurfaces(
  caps: Capabilities,
  platform: NodeJS.Platform = process.platform
): SurfaceDefinition[] {
  return SURFACE_LIST.filter((surface) =>
    surfacePublishedSeparately(surface.id, platform) && surfaceIsUseful(surface.id, caps, platform)
  );
}

import path from 'node:path';
import { z } from 'zod';
import { MAX_MULTI_AGENT_WORKERS } from './types.js';

/**
 * Local instance/device profiles are configuration, not a second runtime.
 *
 * The registry names which existing config, state, bridge, connector, tunnel and browser
 * owners this process should use. It never contains credentials or browser/session data.
 */
export const INSTANCE_PROFILE_SCHEMA_VERSION = 1 as const;
export const INSTANCE_PLATFORMS = ['win32', 'darwin', 'linux'] as const;
export type InstancePlatform = (typeof INSTANCE_PLATFORMS)[number];

export const INSTANCE_PROFILE_ERROR_CODES = [
  'malformed_profile',
  'unsupported_profile_version',
  'missing_active_instance',
  'wrong_platform',
  'wrong_device',
  'path_platform_mismatch',
  'instance_id_collision',
  'state_root_collision',
  'endpoint_collision',
  'tunnel_collision',
  'connector_collision',
  'browser_profile_collision',
  'electron_partition_collision',
  'namespace_collision',
  'mapping_binding_required',
  'mapping_binding_invalid',
  'mapping_root_missing',
  'project_mapping_invalid'
] as const;
export type InstanceProfileErrorCode = (typeof INSTANCE_PROFILE_ERROR_CODES)[number];

export class InstanceProfileError extends Error {
  constructor(
    readonly code: InstanceProfileErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InstanceProfileError';
  }
}

const idSchema = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/);
const labelSchema = z.string().trim().min(1).max(120);
// Leaves room for the longest projected suffix (" Plugins") inside the existing MCP surface
// owner's 100-character connector-name contract. Invalid names fail at profile parse/preflight,
// not later after a partial connector startup.
const connectorIdentitySchema = z.string().trim().min(1).max(92);
const connectorAccountAliasSchema = z.string().regex(/^[A-Z][a-z]{2,4} [A-Z][a-z]{2,4} [a-f0-9]{12}$/);
const browserProfileDirectorySchema = z.string().trim().min(1).max(128)
  .regex(/^[^\\/:*?"<>|]+$/, 'Browser profile directory must be a Chrome/Chromium profile directory name, not a path');
/** Visible private-fork brand. Protocol/server identities intentionally remain historical. */
export const DEFAULT_CONNECTOR_DISPLAY_BRAND = 'Luna Forge X7';

const folderBindingSchema = z.object({
  platform: z.enum(INSTANCE_PLATFORMS),
  deviceId: z.string().uuid(),
  /** References Config.roots[].name. Absolute paths remain owned by Config.roots. */
  rootName: z.string().trim().min(1).max(64),
  /** Local-only canonical spelling used to preserve logical identity across root renames. */
  localPath: z.string().min(1).max(4096),
  /** False retains local mapping metadata after the root is deliberately unbound. */
  bound: z.boolean().optional()
}).strict();

const logicalFolderSchema = z.object({
  id: idSchema,
  label: labelSchema,
  role: z.string().trim().min(1).max(80).optional(),
  bindings: z.array(folderBindingSchema).max(16)
}).strict();

const logicalProjectSchema = z.object({
  id: idSchema,
  label: labelSchema,
  folderIds: z.array(idSchema).max(32)
}).strict();

export const instanceProfileSchema = z.object({
  schemaVersion: z.literal(INSTANCE_PROFILE_SCHEMA_VERSION),
  id: idSchema,
  displayName: labelSchema,
  platform: z.enum(INSTANCE_PLATFORMS),
  deviceId: z.string().uuid(),
  accountLabel: z.string().trim().max(120),
  /** Disabled profiles remain durable but cannot become active until explicitly re-enabled. */
  enabled: z.boolean().optional(),
  state: z.object({
    mode: z.enum(['legacy', 'isolated']),
    /** Platform-local absolute root. Explicitly excluded from portable export. */
    root: z.string().min(1).max(4096)
  }).strict(),
  bridge: z.object({
    host: z.literal('127.0.0.1'),
    port: z.number().int().min(1024).max(65535)
  }).strict(),
  connector: z.object({
    /** Stable namespace from which Core/Desktop/Plugins names are projected. */
    identity: connectorIdentitySchema,
    /** User-visible ChatGPT app name prefix; independent from the MCP server namespace. */
    displayBrand: connectorIdentitySchema.optional(),
    /** The migrated profile retains the exact pre-profile connector names. */
    legacyNames: z.boolean()
  }).strict(),
  /** Local tunnel namespace. Existing setup profiles remain the API-key/tunnel selector. */
  tunnelProfileRef: idSchema,
  browser: z.object({
    /** Logical local browser/account profile identity. It is never a credential or cookie jar. */
    profileId: idSchema,
    /**
     * Exact Chrome/Chromium profile directory (for example `Default` or `Profile 2`).
     * The migrated legacy profile deliberately omits this so upgrading cannot redirect the
     * browser account the current installation already uses. Every new isolated profile must
     * supply it before activation.
     */
    profileDirectory: browserProfileDirectorySchema.optional(),
    /** New isolated account profiles use the Chrome/Chromium adapter first. */
    family: z.literal('chrome').optional(),
    /** `default` preserves Electron's historical defaultSession for the migrated profile. */
    electronPartition: idSchema
  }).strict(),
  namespaces: z.object({
    sessions: idSchema,
    queue: idSchema,
    logs: idSchema,
    health: idSchema
  }).strict(),
  approvedFolders: z.array(logicalFolderSchema).max(64),
  projects: z.array(logicalProjectSchema).max(64)
}).strict();
export type InstanceProfile = z.infer<typeof instanceProfileSchema>;

/** Reusable preferences only: no account routes, models, grants, providers or run controls. */
export const sharedAccountPreferencesSchema = z.object({
  version: z.literal(1),
  ui: z.object({
    theme: z.enum(['light', 'dark']), developerMode: z.boolean().optional(),
    followOutput: z.boolean(), minimizeToTray: z.boolean(), backgroundChats: z.boolean(),
    keepAwake: z.boolean().optional(),
    tabsToKeepOpen: z.number().int().min(1).max(50).optional(), privacyScreenshots: z.boolean()
  }).strict(),
  sessions: z.object({
    advisoryTokens: z.number().int().min(10_000).max(4_000_000),
    limitTokens: z.number().int().min(10_000).max(4_000_000)
  }).strict(),
  compaction: z.object({ auto: z.boolean(), autoTokens: z.number().int().min(10_000).max(4_000_000) }).strict(),
  multiAgent: z.object({
    maxWorkers: z.number().int().min(1).max(MAX_MULTI_AGENT_WORKERS),
    limitAutomaticChats: z.boolean(), maxActiveChats: z.number().int().min(1).max(16),
    rotationBatchSize: z.number().int().min(1).max(16), rotationMinutes: z.number().int().min(5).max(1440),
    rotationForegroundSlots: z.number().int().min(0).max(3),
    sleepingRuntimeMinutes: z.number().int().min(1).max(1440)
  }).strict(),
  artifacts: z.object({ maxFileBytes: z.number().int().min(1).max(256 * 1024 * 1024) }).strict()
}).strict();
export type SharedAccountPreferences = z.infer<typeof sharedAccountPreferencesSchema>;

/** Optional Config extension: binding belongs to the existing canonical folder-policy revision. */
export const sharedAccountPreferencesEnvelopeSchema = z.object({
  version: z.literal(1), platform: z.enum(INSTANCE_PLATFORMS), deviceId: z.string().uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), preferences: sharedAccountPreferencesSchema
}).strict();
export type SharedAccountPreferencesEnvelope = z.infer<typeof sharedAccountPreferencesEnvelopeSchema>;

export const instanceProfileRegistrySchema = z.object({
  schemaVersion: z.literal(INSTANCE_PROFILE_SCHEMA_VERSION),
  activeInstanceId: idSchema,
  /** Explicit local-machine grant, absent on installations that retain isolated access. */
  sharedFolderAccess: z.object({
    enabled: z.boolean(),
    platform: z.enum(INSTANCE_PLATFORMS),
    deviceId: z.string().uuid(),
    /** Kept even after Off so old private snapshots cannot resurrect revoked grants. */
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    roots: z.array(z.object({
      name: z.string().min(1).max(32).regex(/^[a-z0-9][a-z0-9._-]*$/),
      path: z.string().min(1).max(4096)
    }).strict()).max(32)
  }).strict().optional(),
  /**
   * A deferred switch stays owned by the source profile until its work is verified idle.
   * Keeping this in the existing registry makes crash recovery deterministic without a second
   * account/config store.
   */
  pendingSwitch: z.object({
    version: z.literal(1).optional(),
    transitionId: z.string().trim().min(1).max(160).optional(),
    fromInstanceId: idSchema,
    toInstanceId: idSchema,
    phase: z.enum(['draining', 'ready']).optional(),
    requestedAt: z.number().int().nonnegative(),
    verifiedIdleAt: z.number().int().nonnegative().optional()
  }).strict().optional(),
  profiles: z.array(instanceProfileSchema).min(1).max(32)
}).strict();
export type InstanceProfileRegistry = z.infer<typeof instanceProfileRegistrySchema>;

export interface InstanceRuntimeIdentity {
  platform: InstancePlatform;
  deviceId: string;
  userDataRoot: string;
}

export interface ApprovedRootLike {
  name: string;
  path: string;
}

export interface ActiveInstanceRuntime {
  profile: InstanceProfile;
  stateRoot: string;
  electronPartition: string | null;
  approvedFolders: ReadonlyMap<string, ApprovedRootLike>;
}

export const portableInstanceProfileSchema = z.object({
  schemaVersion: z.literal(INSTANCE_PROFILE_SCHEMA_VERSION),
  displayName: labelSchema,
  accountLabel: z.string().trim().max(120),
  folders: z.array(z.object({
    id: idSchema,
    label: labelSchema,
    role: z.string().trim().min(1).max(80).optional()
  }).strict()).max(64),
  projects: z.array(logicalProjectSchema).max(64)
}).strict();
export type PortableInstanceProfile = z.infer<typeof portableInstanceProfileSchema>;

export interface DestinationInstanceBinding {
  id: string;
  displayName?: string;
  platform: InstancePlatform;
  deviceId: string;
  stateRoot: string;
  bridgePort: number;
  connectorIdentity: string;
  tunnelProfileRef: string;
  browserProfileId: string;
  browserProfileDirectory?: string;
  electronPartition: string;
  namespaces: InstanceProfile['namespaces'];
  folderBindings: ReadonlyArray<{ logicalId: string; rootName: string; localPath: string }>;
}

export interface InstanceProfileConflict {
  code: InstanceProfileErrorCode;
  message: string;
  profiles: [string, string];
  field: 'stateRoot' | 'bridgePort' | 'tunnelProfileRef' | 'connectorName' | 'browserProfile' | 'electronPartition' | 'namespace';
}

export interface LegacyInstanceMigrationOptions {
  /** Existing setup/tunnel profile identity. Callers migrating old Config should pass it explicitly. */
  tunnelProfileRef: string;
  /** Stable local instance identity; defaults to the historical singleton identity. */
  instanceId?: string;
}

export const INSTANCE_CONNECTOR_SURFACES = ['core', 'desktop', 'plugins'] as const;
export type InstanceConnectorSurface = (typeof INSTANCE_CONNECTOR_SURFACES)[number];

export interface ProjectedConnectorName {
  serverName: string;
  connectorName: string;
}

export type ProjectedConnectorNames = Record<InstanceConnectorSurface, ProjectedConnectorName>;

export interface InstanceOwnerPaths {
  stateRoot: string;
  /** Base directory passed to the existing session owner, which appends `sessions`. */
  sessionStoreRoot: string;
  /** Base directory passed to the existing durable owner, which appends `state`. */
  durableStoreRoot: string;
  logFile: string;
  /** Scratch/health namespace consumed by the existing connection and tunnel owners. */
  healthRoot: string;
  electronPartition: string | null;
}

function profileError(code: InstanceProfileErrorCode, message: string): never {
  throw new InstanceProfileError(code, message);
}

function platformName(platform: InstancePlatform): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'Mac';
  return 'Linux';
}

export function instancePlatform(value: NodeJS.Platform): InstancePlatform {
  if (value === 'win32' || value === 'darwin' || value === 'linux') return value;
  return profileError('wrong_platform', `Instance profiles do not support the ${value} platform.`);
}

function platformPath(platform: InstancePlatform): typeof path.win32 | typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Local WSL redirector aliases; only the Linux suffix is case-sensitive. */
const WSL_WINDOWS_PATH = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(.*)$/i;

function windowsAbsolute(value: string): boolean {
  if (!path.win32.isAbsolute(value)) return false;
  const root = path.win32.parse(value).root;
  return /^[a-z]:[\\/]$/i.test(root) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(root);
}

export function pathMatchesPlatform(value: string, platform: InstancePlatform): boolean {
  if (platform === 'win32') return windowsAbsolute(value);
  return path.posix.isAbsolute(value) && !windowsAbsolute(value);
}

function requirePlatformPath(value: string, platform: InstancePlatform, label: string): void {
  if (pathMatchesPlatform(value, platform)) return;
  profileError(
    'path_platform_mismatch',
    `${label} is not an absolute ${platformName(platform)} path. Rebind it on this device instead of copying a path from another platform.`
  );
}

function serverIdentity(identity: string): string {
  return safeId(identity, 'instance');
}

const CONNECTOR_ALIAS_WORDS = ['Calm', 'Clear', 'Deep', 'Fair', 'Keen', 'Kind', 'Mild', 'Pure', 'Soft', 'Warm', 'Wise', 'Bold', 'Cool', 'Fine', 'True', 'Vast'] as const;
const CONNECTOR_ALIAS_NOUNS = ['Ash', 'Cove', 'Dawn', 'Fern', 'Jade', 'Lark', 'Moss', 'Nova', 'Opal', 'Reef', 'Sage', 'Star', 'Wave', 'Wren', 'Yew', 'Pine'] as const;
const NEW_INSTANCE_CONNECTOR_ID = /^profile-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Derived once at explicit account creation, then stored. No rotation or mutable-name seed. */
export function newInstanceConnectorAlias(id: string): string {
  if (!NEW_INSTANCE_CONNECTOR_ID.test(id)) {
    throw new Error('A new connector alias requires its generated account UUID.');
  }
  const hex = id.slice('profile-'.length).replaceAll('-', '').toLowerCase();
  return `${CONNECTOR_ALIAS_WORDS[parseInt(hex.slice(0, 2), 16) % CONNECTOR_ALIAS_WORDS.length]} ${CONNECTOR_ALIAS_NOUNS[parseInt(hex.slice(2, 4), 16) % CONNECTOR_ALIAS_NOUNS.length]} ${hex.slice(-12)}`;
}

/** Leave room for all surface suffixes and the 64-character learned native app-name bound. */
export function newInstanceConnectorBrand(alias: string, nickname: string, platform: InstancePlatform): string {
  connectorAccountAliasSchema.parse(alias);
  const host = platformName(z.enum(INSTANCE_PLATFORMS).parse(platform));
  const prefix = `${DEFAULT_CONNECTOR_DISPLAY_BRAND} ${alias}`;
  const account = Array.from(nickname.trim());
  const accountBudget = 64 - ' Plugins'.length - prefix.length - host.length - 2;
  while (account.join('').length > accountBudget) account.pop();
  return `${prefix} ${account.join('')} ${host}`;
}

/** New accounts use their full immutable UUID in the existing identity field. Older saved
 * connectors keep their exact metadata; no new strict-schema field impairs rollback parsing. */
export function instanceConnectorAccountAlias(profile: Pick<InstanceProfile, 'id' | 'connector'>): string | null {
  if (profile.connector.legacyNames || !NEW_INSTANCE_CONNECTOR_ID.test(profile.id) ||
      profile.connector.identity !== `luna-forge-x7-${profile.id}`) return null;
  const alias = newInstanceConnectorAlias(profile.id);
  return profile.connector.displayBrand?.startsWith(`${DEFAULT_CONNECTOR_DISPLAY_BRAND} ${alias} `) ? alias : null;
}

export function projectConnectorNames(profile: Pick<InstanceProfile, 'connector'>): ProjectedConnectorNames {
  const displayBrand = profile.connector.displayBrand?.trim() ||
    (profile.connector.legacyNames ? DEFAULT_CONNECTOR_DISPLAY_BRAND : profile.connector.identity.trim());
  if (profile.connector.legacyNames) {
    return {
      core: { serverName: 'chat-on-steroids-core', connectorName: `${displayBrand} Core` },
      desktop: { serverName: 'chat-on-steroids-desktop', connectorName: `${displayBrand} Desktop` },
      plugins: { serverName: 'chat-on-steroids-plugins', connectorName: `${displayBrand} Plugins` }
    };
  }
  const identity = profile.connector.identity.trim();
  const server = serverIdentity(identity);
  return {
    core: { serverName: `${server}-core`, connectorName: `${displayBrand} Core` },
    desktop: { serverName: `${server}-desktop`, connectorName: `${displayBrand} Desktop` },
    plugins: { serverName: `${server}-plugins`, connectorName: `${displayBrand} Plugins` }
  };
}

function derivedElectronPartition(profile: Pick<InstanceProfile, 'browser' | 'state'>): string | null {
  const parsed = idSchema.safeParse(profile.browser.electronPartition);
  if (!parsed.success) profileError('malformed_profile', 'Electron partition identity must be a logical id, not a path or partition URI.');
  if (profile.state.mode === 'legacy' && parsed.data === 'default') return null;
  return `persist:${parsed.data}`;
}

export function normalizedLocalPath(value: string, platform: InstancePlatform, label = 'Local path'): string {
  requirePlatformPath(value, platform, label);
  const api = platformPath(platform);
  const normalized = api.normalize(value);
  const trimmed = normalized.length > api.parse(normalized).root.length
    ? normalized.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '')
    : normalized;
  if (platform !== 'win32') return trimmed;
  const wsl = WSL_WINDOWS_PATH.exec(trimmed);
  // Windows aliases the redirector host and distro, but Linux owns every later component.
  return wsl
    ? `\\\\wsl.localhost\\${wsl[1]!.toLowerCase()}${wsl[2]}`
    : trimmed.toLowerCase();
}

function comparablePath(value: string, platform: InstancePlatform): string {
  return normalizedLocalPath(value, platform);
}

function isStrictDescendant(base: string, candidate: string, platform: InstancePlatform): boolean {
  const api = platformPath(platform);
  const normalizedBase = normalizedLocalPath(base, platform, 'Application data root');
  const normalizedCandidate = normalizedLocalPath(candidate, platform, 'Instance state root');
  const relative = api.relative(normalizedBase, normalizedCandidate);
  return relative !== '' && !relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative);
}

function validateStateRootCollisions(profiles: readonly InstanceProfile[]): void {
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    const left = profiles[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const right = profiles[rightIndex]!;
      if (left.platform !== right.platform || left.deviceId !== right.deviceId) continue;
      const leftRoot = comparablePath(left.state.root, left.platform);
      const rightRoot = comparablePath(right.state.root, right.platform);
      // The migrated legacy owner intentionally contains the canonical `instances/` directory.
      // Only exact reuse is unsafe across modes; nested isolated roots would share state and are
      // always rejected.
      const nestedIsolated = left.state.mode === 'isolated' && right.state.mode === 'isolated' &&
        (isStrictDescendant(leftRoot, rightRoot, left.platform) ||
         isStrictDescendant(rightRoot, leftRoot, left.platform));
      if (leftRoot === rightRoot || nestedIsolated) {
        profileError(
          'state_root_collision',
          `State roots for ${left.id} and ${right.id} overlap. Give every local instance a disjoint root below the instances directory.`
        );
      }
    }
  }
}

function validateBindingPath(binding: z.infer<typeof folderBindingSchema>, label: string): void {
  normalizedLocalPath(binding.localPath, binding.platform, label);
}

function collision(
  profiles: readonly InstanceProfile[],
  code: InstanceProfileErrorCode,
  label: string,
  value: (profile: InstanceProfile) => string | number,
  normalize: (value: string | number, profile: InstanceProfile) => string = (item) => String(item).toLowerCase(),
  scope: (profile: InstanceProfile) => string = () => 'global'
): void {
  const seen = new Map<string, string>();
  for (const profile of profiles) {
    const key = `${scope(profile)}:${normalize(value(profile), profile)}`;
    const prior = seen.get(key);
    if (prior) profileError(code, `${label} "${String(value(profile))}" is assigned to both ${prior} and ${profile.id}. Choose an explicit unique value.`);
    seen.set(key, profile.id);
  }
}

function validateLogicalMappings(profile: InstanceProfile): void {
  const folders = new Set<string>();
  for (const folder of profile.approvedFolders) {
    if (folders.has(folder.id)) profileError('mapping_binding_invalid', `Instance ${profile.id} contains duplicate logical folder id ${folder.id}.`);
    folders.add(folder.id);
    const bindingKeys = new Set<string>();
    for (const binding of folder.bindings) {
      const key = `${binding.platform}:${binding.deviceId.toLowerCase()}`;
      if (bindingKeys.has(key)) profileError('mapping_binding_invalid', `Logical folder ${folder.id} has more than one binding for the same device.`);
      bindingKeys.add(key);
      validateBindingPath(binding, `Local binding for ${folder.id}`);
    }
  }
  const projects = new Set<string>();
  for (const project of profile.projects) {
    if (projects.has(project.id)) profileError('project_mapping_invalid', `Instance ${profile.id} contains duplicate logical project id ${project.id}.`);
    projects.add(project.id);
    if (new Set(project.folderIds).size !== project.folderIds.length) {
      profileError('project_mapping_invalid', `Project ${project.id} contains the same logical folder more than once.`);
    }
    for (const folderId of project.folderIds) {
      if (!folders.has(folderId)) profileError('project_mapping_invalid', `Project ${project.id} references unknown logical folder ${folderId}.`);
    }
  }
}

export function validateInstanceRegistry(registry: InstanceProfileRegistry): InstanceProfileRegistry {
  if (registry.sharedFolderAccess) {
    const policy = registry.sharedFolderAccess;
    const names = new Set<string>();
    const paths = new Set<string>();
    for (const root of policy.roots) {
      const normalized = normalizedLocalPath(root.path, policy.platform, `Shared approved root ${root.name}`);
      if (names.has(root.name) || paths.has(normalized)) {
        profileError('mapping_binding_invalid', 'Shared folder access contains duplicate approved names or native paths.');
      }
      names.add(root.name);
      paths.add(normalized);
    }
  }
  for (const profile of registry.profiles) {
    requirePlatformPath(profile.state.root, profile.platform, `State root for ${profile.id}`);
    validateLogicalMappings(profile);
  }
  collision(registry.profiles, 'instance_id_collision', 'Instance id', profile => profile.id);
  validateStateRootCollisions(registry.profiles);
  const deviceScope = (profile: InstanceProfile): string => profile.deviceId.toLowerCase();
  collision(registry.profiles, 'endpoint_collision', 'Bridge port', profile => profile.bridge.port,
    (item) => String(item).toLowerCase(), deviceScope);
  collision(registry.profiles, 'tunnel_collision', 'Tunnel profile reference', profile => profile.tunnelProfileRef);
  const connectorNames = new Map<string, string>();
  for (const profile of registry.profiles) {
    const projected = projectConnectorNames(profile);
    for (const surface of INSTANCE_CONNECTOR_SURFACES) {
      for (const [kind, value] of Object.entries(projected[surface]) as Array<[keyof ProjectedConnectorName, string]>) {
        const key = `${kind}:${value.toLowerCase()}`;
        const prior = connectorNames.get(key);
        if (prior) profileError('connector_collision', `${kind === 'serverName' ? 'Server' : 'Connector'} name "${value}" is assigned to both ${prior} and ${profile.id}. Choose an explicit unique connector identity.`);
        connectorNames.set(key, profile.id);
      }
    }
  }
  collision(registry.profiles, 'browser_profile_collision', 'Browser profile identity',
    profile => profile.browser.profileDirectory?.trim().toLowerCase() || profile.browser.profileId,
    (item) => String(item).toLowerCase(), deviceScope);
  collision(registry.profiles, 'electron_partition_collision', 'Electron partition',
    profile => derivedElectronPartition(profile) ?? 'default', (item) => String(item).toLowerCase(), deviceScope);
  for (const namespace of ['sessions', 'queue', 'logs', 'health'] as const) {
    collision(registry.profiles, 'namespace_collision', `${namespace} namespace`, profile => profile.namespaces[namespace],
      (item) => String(item).toLowerCase(), deviceScope);
  }
  const active = registry.profiles.find(profile => profile.id === registry.activeInstanceId);
  if (!active) {
    profileError('missing_active_instance', `Active instance ${registry.activeInstanceId} does not exist in the profile registry.`);
  }
  if (active.enabled === false) {
    profileError('missing_active_instance', `Active instance ${registry.activeInstanceId} is disabled. Re-enable it or select another local profile.`);
  }
  if (registry.pendingSwitch) {
    const { fromInstanceId, toInstanceId } = registry.pendingSwitch;
    if (fromInstanceId !== registry.activeInstanceId || fromInstanceId === toInstanceId) {
      profileError('malformed_profile', 'Deferred profile switch does not belong to the active source profile.');
    }
    const target = registry.profiles.find(profile => profile.id === toInstanceId);
    if (!target) profileError('missing_active_instance', `Deferred profile switch target ${toInstanceId} no longer exists.`);
    if (target.enabled === false) profileError('missing_active_instance', `Deferred profile switch target ${target.id} is disabled.`);
  }
  return registry;
}

export function parseInstanceRegistry(value: unknown): InstanceProfileRegistry {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    const version = row['schemaVersion'];
    if (Object.prototype.hasOwnProperty.call(row, 'schemaVersion') && version !== INSTANCE_PROFILE_SCHEMA_VERSION) {
      profileError('unsupported_profile_version', `Instance profile schema ${String(version)} is not supported by this build.`);
    }
    const profiles = row['profiles'];
    if (Array.isArray(profiles)) {
      for (const [index, profile] of profiles.entries()) {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
        const profileRow = profile as Record<string, unknown>;
        const nestedVersion = profileRow['schemaVersion'];
        if (Object.prototype.hasOwnProperty.call(profileRow, 'schemaVersion') && nestedVersion !== INSTANCE_PROFILE_SCHEMA_VERSION) {
          profileError('unsupported_profile_version', `Instance profile ${index + 1} schema ${String(nestedVersion)} is not supported by this build.`);
        }
      }
    }
  }
  const parsed = instanceProfileRegistrySchema.safeParse(value);
  if (!parsed.success) profileError('malformed_profile', `Instance profiles are malformed: ${parsed.error.issues[0]?.message ?? 'invalid data'}.`);
  return validateInstanceRegistry(parsed.data);
}

function safeId(value: string, fallback: string): string {
  const candidate = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 64).replace(/[._-]+$/g, '');
  return candidate && /^[a-z0-9]/.test(candidate) ? candidate : fallback;
}

function nextLogicalFolderId(rootName: string, used: Set<string>): string {
  const base = safeId(`root-${rootName}`, 'root');
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    const tail = `-${suffix++}`;
    id = `${base.slice(0, Math.max(1, 64 - tail.length))}${tail}`;
  }
  used.add(id);
  return id;
}

function localBinding(root: ApprovedRootLike, runtime: InstanceRuntimeIdentity, bound = true): z.infer<typeof folderBindingSchema> {
  return {
    platform: runtime.platform,
    deviceId: runtime.deviceId,
    rootName: root.name,
    localPath: normalizedLocalPath(root.path, runtime.platform, `Approved root ${root.name}`),
    ...(bound ? {} : { bound: false })
  };
}

function migratedFolders(roots: readonly ApprovedRootLike[], runtime: InstanceRuntimeIdentity): InstanceProfile['approvedFolders'] {
  const used = new Set<string>();
  return roots.map((root) => ({
    id: nextLogicalFolderId(root.name, used),
    label: root.name,
    role: 'approved-root',
    bindings: [localBinding(root, runtime)]
  }));
}

export function migrateLegacyInstanceRegistry(
  roots: readonly ApprovedRootLike[],
  runtime: InstanceRuntimeIdentity,
  options: LegacyInstanceMigrationOptions = { tunnelProfileRef: 'default' }
): InstanceProfileRegistry {
  if (!z.string().uuid().safeParse(runtime.deviceId).success) profileError('malformed_profile', 'The local device identity is not a valid UUID.');
  requirePlatformPath(runtime.userDataRoot, runtime.platform, 'Application data root');
  const idResult = idSchema.safeParse(options.instanceId ?? 'local-instance');
  if (!idResult.success) profileError('malformed_profile', `Legacy instance id is invalid: ${idResult.error.issues[0]?.message ?? 'invalid data'}.`);
  const tunnelResult = idSchema.safeParse(options.tunnelProfileRef);
  if (!tunnelResult.success) profileError('malformed_profile', `Tunnel profile reference is invalid: ${tunnelResult.error.issues[0]?.message ?? 'invalid data'}.`);
  const id = idResult.data;
  const tunnelProfileRef = tunnelResult.data;
  const profile: InstanceProfile = {
    schemaVersion: INSTANCE_PROFILE_SCHEMA_VERSION,
    id,
    displayName: `Local ${platformName(runtime.platform)}`,
    platform: runtime.platform,
    deviceId: runtime.deviceId,
    accountLabel: '',
    enabled: true,
    state: { mode: 'legacy', root: runtime.userDataRoot },
    bridge: { host: '127.0.0.1', port: 8765 },
    connector: { identity: 'chat-on-steroids', displayBrand: DEFAULT_CONNECTOR_DISPLAY_BRAND, legacyNames: true },
    tunnelProfileRef,
    // No explicit Chrome directory is invented during migration. Browser launch keeps the
    // historical current-profile behavior until the user explicitly binds one.
    browser: { profileId: 'default', electronPartition: 'default' },
    namespaces: { sessions: 'legacy', queue: 'legacy', logs: 'legacy', health: 'legacy' },
    approvedFolders: migratedFolders(roots, runtime),
    projects: []
  };
  return validateInstanceRegistry({
    schemaVersion: INSTANCE_PROFILE_SCHEMA_VERSION,
    activeInstanceId: profile.id,
    profiles: [profile]
  });
}

/** Keeps the migrated current profile's logical folder map in lock-step with Config.roots. */
export function reconcileActiveApprovedFolders(
  registry: InstanceProfileRegistry,
  roots: readonly ApprovedRootLike[],
  runtime: InstanceRuntimeIdentity
): InstanceProfileRegistry {
  const active = registry.profiles.find(profile => profile.id === registry.activeInstanceId);
  if (!active || active.platform !== runtime.platform || active.deviceId !== runtime.deviceId) return registry;
  return validateInstanceRegistry(instanceProfileRegistrySchema.parse({
    ...registry,
    profiles: registry.profiles.map(profile => profile.id === active.id
      ? reconcileProfileApprovedFolders(profile, roots, runtime)
      : profile)
  }));
}

/** One binding reconciler, shared by isolated and explicitly machine-shared access. */
function reconcileProfileApprovedFolders(
  active: InstanceProfile,
  roots: readonly ApprovedRootLike[],
  runtime: InstanceRuntimeIdentity
): InstanceProfile {
  validateLogicalMappings(active);
  const currentRoots = roots.map(root => ({ root, normalized: normalizedLocalPath(root.path, runtime.platform, `Approved root ${root.name}`) }));
  const pathOwners = new Set<string>();
  const nameOwners = new Set<string>();
  for (const entry of currentRoots) {
    if (pathOwners.has(entry.normalized)) profileError('mapping_binding_invalid', `More than one approved root resolves to ${entry.root.path}.`);
    if (nameOwners.has(entry.root.name)) profileError('mapping_binding_invalid', `More than one approved root is named ${entry.root.name}.`);
    pathOwners.add(entry.normalized);
    nameOwners.add(entry.root.name);
  }

  const usedIds = new Set(active.approvedFolders.map(folder => folder.id));
  const claimed = new Set<string>();
  const existingForRoot = (root: ApprovedRootLike, normalized: string): InstanceProfile['approvedFolders'][number] | undefined => {
    const candidates = active.approvedFolders.filter(folder => !claimed.has(folder.id));
    const byPath = candidates.filter(folder => folder.bindings.some(binding =>
      binding.platform === runtime.platform && binding.deviceId === runtime.deviceId &&
      normalizedLocalPath(binding.localPath, binding.platform, `Local binding for ${folder.id}`) === normalized
    ));
    if (byPath.length > 1) profileError('mapping_binding_invalid', `More than one logical folder maps to approved root ${root.path}.`);
    if (byPath.length === 1) return byPath[0];
    const byName = candidates.filter(folder => folder.bindings.some(binding =>
      binding.platform === runtime.platform && binding.deviceId === runtime.deviceId && binding.rootName === root.name
    ) || folder.label === root.name);
    if (byName.length > 1) profileError('mapping_binding_invalid', `More than one logical folder maps to approved root name ${root.name}.`);
    return byName[0];
  };

  const rebound: InstanceProfile['approvedFolders'] = [];
  for (const { root, normalized } of currentRoots) {
    const existing = existingForRoot(root, normalized);
    if (existing) {
      claimed.add(existing.id);
      const otherBindings = existing.bindings.filter(binding =>
        binding.platform !== runtime.platform || binding.deviceId !== runtime.deviceId
      );
      rebound.push({
        ...existing,
        label: root.name,
        bindings: [...otherBindings, localBinding(root, runtime)]
      });
    } else {
      rebound.push({
        id: nextLogicalFolderId(root.name, usedIds),
        label: root.name,
        role: 'approved-root',
        bindings: [localBinding(root, runtime)]
      });
    }
  }

  const unbound = active.approvedFolders
    .filter(folder => !claimed.has(folder.id))
    .map(folder => ({
      ...folder,
      bindings: folder.bindings.map(binding =>
        binding.platform === runtime.platform && binding.deviceId === runtime.deviceId
          ? { ...binding, bound: false as const }
          : binding
      )
    }));
  const nextFolders = [...rebound, ...unbound];
  return { ...active, approvedFolders: nextFolders };
}

/** Projects only the one canonical machine grant; never unions historical profile folders. */
export function reconcileSharedApprovedFolders(
  registry: InstanceProfileRegistry,
  runtime: InstanceRuntimeIdentity
): InstanceProfileRegistry {
  const policy = registry.sharedFolderAccess;
  if (!policy?.enabled || policy.platform !== runtime.platform || policy.deviceId !== runtime.deviceId) return registry;
  return validateInstanceRegistry(instanceProfileRegistrySchema.parse({
    ...registry,
    profiles: registry.profiles.map(profile => profile.platform === runtime.platform && profile.deviceId === runtime.deviceId
      ? reconcileProfileApprovedFolders(profile, policy.roots, runtime)
      : profile)
  }));
}

export function resolveActiveInstance(
  registryValue: unknown,
  runtime: InstanceRuntimeIdentity,
  roots: readonly ApprovedRootLike[]
): ActiveInstanceRuntime {
  const registry = parseInstanceRegistry(registryValue);
  const profile = registry.profiles.find(candidate => candidate.id === registry.activeInstanceId)!;
  if (profile.platform !== runtime.platform) {
    profileError('wrong_platform', `Instance ${profile.id} belongs to ${platformName(profile.platform)}, not ${platformName(runtime.platform)}. Select or import a profile for this platform.`);
  }
  if (profile.deviceId !== runtime.deviceId) {
    profileError('wrong_device', `Instance ${profile.id} is bound to another device. Import its logical settings and explicitly rebind local folders, browser state and pairing instead of copying local state.`);
  }
  requirePlatformPath(profile.state.root, runtime.platform, `State root for ${profile.id}`);
  if (profile.state.mode === 'isolated') {
    const instancesRoot = platformPath(runtime.platform).join(runtime.userDataRoot, 'instances');
    if (!isStrictDescendant(instancesRoot, profile.state.root, runtime.platform)) {
      profileError('path_platform_mismatch', `Isolated instance ${profile.id} must use a state root below the local instances directory.`);
    }
  } else if (comparablePath(profile.state.root, runtime.platform) !== comparablePath(runtime.userDataRoot, runtime.platform)) {
    profileError('path_platform_mismatch', `Legacy instance ${profile.id} must keep the existing application data root exactly.`);
  }

  const rootsByName = new Map<string, ApprovedRootLike>();
  const rootsByPath = new Map<string, ApprovedRootLike>();
  for (const root of roots) {
    const normalized = normalizedLocalPath(root.path, runtime.platform, `Approved root ${root.name}`);
    if (rootsByName.has(root.name)) profileError('mapping_binding_invalid', `Approved root name ${root.name} is duplicated.`);
    if (rootsByPath.has(normalized)) profileError('mapping_binding_invalid', `Approved root path ${root.path} is duplicated.`);
    rootsByName.set(root.name, root);
    rootsByPath.set(normalized, root);
  }
  const approved = new Map<string, ApprovedRootLike>();
  const claimedRootNames = new Set<string>();
  const claimedRootPaths = new Set<string>();
  for (const folder of profile.approvedFolders) {
    const wrongPlatform = folder.bindings.some(binding => binding.deviceId === runtime.deviceId && binding.platform !== runtime.platform && binding.bound !== false);
    if (wrongPlatform) profileError('mapping_binding_invalid', `Logical folder ${folder.id} is bound to this device under the wrong platform.`);
    const matching = folder.bindings.filter(binding =>
      binding.platform === runtime.platform && binding.deviceId === runtime.deviceId && binding.bound !== false
    );
    if (matching.length > 1) profileError('mapping_binding_invalid', `Logical folder ${folder.id} has more than one active binding for this device.`);
    if (matching.length === 0) continue;
    const binding = matching[0]!;
    const root = rootsByName.get(binding.rootName);
    if (!root) profileError('mapping_root_missing', `Logical folder ${folder.id} references missing approved root ${matching[0]!.rootName}. Rebind it explicitly.`);
    const boundPath = normalizedLocalPath(binding.localPath, runtime.platform, `Local binding for ${folder.id}`);
    const rootPath = normalizedLocalPath(root.path, runtime.platform, `Approved root ${root.name}`);
    if (boundPath !== rootPath) {
      profileError('mapping_binding_invalid', `Logical folder ${folder.id} points at stale local path ${binding.localPath}; approved root ${root.name} now resolves to ${root.path}.`);
    }
    if (claimedRootNames.has(root.name) || claimedRootPaths.has(rootPath)) {
      profileError('mapping_binding_invalid', `Approved root ${root.name} is bound to more than one logical folder.`);
    }
    claimedRootNames.add(root.name);
    claimedRootPaths.add(rootPath);
    approved.set(folder.id, root);
  }
  return {
    profile,
    stateRoot: profile.state.root,
    electronPartition: derivedElectronPartition(profile),
    approvedFolders: approved
  };
}

export function resolveLogicalFolder(runtime: ActiveInstanceRuntime, logicalId: string): ApprovedRootLike {
  const folder = runtime.profile.approvedFolders.find(candidate => candidate.id === logicalId);
  if (!folder) profileError('mapping_root_missing', `Logical folder ${logicalId} does not exist in instance ${runtime.profile.id}.`);
  const resolved = runtime.approvedFolders.get(logicalId);
  if (!resolved) profileError('mapping_binding_required', `Logical folder ${logicalId} is not bound on this device. Rebind it explicitly before use.`);
  return resolved;
}

/**
 * Device-local Config.roots projection for a profile. Absolute paths never enter portable
 * export; they come only from the binding for this exact physical device.
 */
export function localApprovedRoots(
  profile: Pick<InstanceProfile, 'id' | 'approvedFolders' | 'platform' | 'deviceId'>,
  runtime: Pick<InstanceRuntimeIdentity, 'platform' | 'deviceId'>
): ApprovedRootLike[] {
  if (profile.platform !== runtime.platform || profile.deviceId !== runtime.deviceId) {
    profileError('wrong_device', `Instance ${profile.id} does not belong to this device; its local folder paths cannot be activated here.`);
  }
  const roots: ApprovedRootLike[] = [];
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const folder of profile.approvedFolders) {
    const matches = folder.bindings.filter(binding => binding.platform === runtime.platform &&
      binding.deviceId === runtime.deviceId && binding.bound !== false);
    if (matches.length > 1) profileError('mapping_binding_invalid', `Logical folder ${folder.id} has more than one active binding for this device.`);
    if (!matches.length) continue;
    const binding = matches[0]!;
    const normalized = normalizedLocalPath(binding.localPath, runtime.platform, `Local binding for ${folder.id}`);
    if (names.has(binding.rootName) || paths.has(normalized)) {
      profileError('mapping_binding_invalid', `Local approved root ${binding.rootName} is assigned more than once in instance ${profile.id}.`);
    }
    names.add(binding.rootName);
    paths.add(normalized);
    roots.push({ name: binding.rootName, path: binding.localPath });
  }
  return roots;
}

export function deriveInstanceOwnerPaths(
  profile: Pick<InstanceProfile, 'state' | 'browser' | 'namespaces' | 'platform' | 'deviceId'>,
  runtime: Pick<InstanceRuntimeIdentity, 'platform' | 'deviceId' | 'userDataRoot'>
): InstanceOwnerPaths {
  if (profile.platform !== runtime.platform) {
    profileError('wrong_platform', `Instance owner paths belong to ${platformName(profile.platform)}, not ${platformName(runtime.platform)}.`);
  }
  if (profile.deviceId !== runtime.deviceId) {
    profileError('wrong_device', 'Instance owner paths belong to another device and cannot be derived locally.');
  }
  const api = platformPath(runtime.platform);
  for (const [owner, namespace] of Object.entries(profile.namespaces)) {
    if (!idSchema.safeParse(namespace).success) {
      profileError('malformed_profile', `${owner} namespace must be a logical id and cannot contain path traversal or separators.`);
    }
  }
  normalizedLocalPath(profile.state.root, runtime.platform, 'Instance state root');
  const normalizedStateRoot = api.normalize(profile.state.root);
  const rootPrefix = api.parse(normalizedStateRoot).root;
  const stateRoot = normalizedStateRoot.length > rootPrefix.length
    ? normalizedStateRoot.replace(runtime.platform === 'win32' ? /[\\/]+$/ : /\/+$/, '')
    : normalizedStateRoot;
  if (profile.state.mode === 'legacy') {
    if (normalizedLocalPath(stateRoot, runtime.platform) !== normalizedLocalPath(runtime.userDataRoot, runtime.platform, 'Application data root')) {
      profileError('path_platform_mismatch', 'Legacy instance state root must remain the existing application data root.');
    }
  } else {
    const instancesRoot = platformPath(runtime.platform).join(runtime.userDataRoot, 'instances');
    if (!isStrictDescendant(instancesRoot, stateRoot, runtime.platform)) {
      profileError('path_platform_mismatch', 'Isolated instance state root must stay below the local instances directory.');
    }
  }
  return {
    stateRoot,
    sessionStoreRoot: profile.state.mode === 'legacy'
      ? stateRoot
      : api.join(stateRoot, 'namespaces', 'sessions', profile.namespaces.sessions),
    durableStoreRoot: profile.state.mode === 'legacy'
      ? stateRoot
      : api.join(stateRoot, 'namespaces', 'queue', profile.namespaces.queue),
    logFile: profile.state.mode === 'legacy'
      ? api.join(stateRoot, 'app.log')
      : api.join(stateRoot, 'namespaces', 'logs', profile.namespaces.logs, 'app.log'),
    healthRoot: profile.state.mode === 'legacy'
      ? api.join(stateRoot, 'state')
      : api.join(stateRoot, 'namespaces', 'health', profile.namespaces.health),
    electronPartition: derivedElectronPartition(profile)
  };
}

function validatePortableLogicalFields(portable: PortableInstanceProfile): void {
  const fields: Array<[string, string]> = [
    ['Profile display name', portable.displayName],
    ['Account label', portable.accountLabel],
    ...portable.folders.flatMap(folder => [
      [`Folder ${folder.id} label`, folder.label] as [string, string],
      ...(folder.role ? [[`Folder ${folder.id} role`, folder.role] as [string, string]] : [])
    ]),
    ...portable.projects.map(project => [`Project ${project.id} label`, project.label] as [string, string])
  ];
  for (const [label, value] of fields) {
    if (windowsAbsolute(value) || path.posix.isAbsolute(value)) {
      profileError('path_platform_mismatch', `${label} contains an absolute local path. Replace it with a portable logical label before export or import.`);
    }
  }
}

/** Explicit portable export: only logical, non-secret settings survive. */
export function exportPortableInstanceProfile(profileValue: unknown): PortableInstanceProfile {
  if (profileValue && typeof profileValue === 'object' && !Array.isArray(profileValue)) {
    const row = profileValue as Record<string, unknown>;
    const version = row['schemaVersion'];
    if (Object.prototype.hasOwnProperty.call(row, 'schemaVersion') && version !== INSTANCE_PROFILE_SCHEMA_VERSION) {
      profileError('unsupported_profile_version', `Instance profile schema ${String(version)} is not supported by this build.`);
    }
  }
  const parsed = instanceProfileSchema.safeParse(profileValue);
  if (!parsed.success) profileError('malformed_profile', `Cannot export malformed instance profile: ${parsed.error.issues[0]?.message ?? 'invalid data'}.`);
  const profile = parsed.data;
  validateLogicalMappings(profile);
  const portable = portableInstanceProfileSchema.parse({
    schemaVersion: INSTANCE_PROFILE_SCHEMA_VERSION,
    displayName: profile.displayName,
    accountLabel: profile.accountLabel,
    folders: profile.approvedFolders.map(folder => ({
      id: folder.id,
      label: folder.label,
      ...(folder.role ? { role: folder.role } : {})
    })),
    projects: profile.projects.map(project => ({ ...project, folderIds: [...project.folderIds] }))
  });
  validatePortableLogicalFields(portable);
  return portable;
}

/**
 * A portable profile cannot become local accidentally. Every local identity/path/endpoint and
 * every folder binding is supplied by the destination device in this call.
 */
export function bindPortableInstanceProfile(
  portableValue: unknown,
  destination: DestinationInstanceBinding
): InstanceProfile {
  const portable = portableInstanceProfileSchema.safeParse(portableValue);
  if (!portable.success) profileError('malformed_profile', `Portable instance profile is malformed: ${portable.error.issues[0]?.message ?? 'invalid data'}.`);
  validatePortableLogicalFields(portable.data);
  const portableFolderIds = new Set(portable.data.folders.map(folder => folder.id));
  if (portableFolderIds.size !== portable.data.folders.length) profileError('mapping_binding_invalid', 'Portable profile contains duplicate logical folder ids.');
  const bindings = new Map<string, { rootName: string; localPath: string }>();
  const boundRootNames = new Set<string>();
  const boundRootPaths = new Set<string>();
  for (const binding of destination.folderBindings) {
    if (!portableFolderIds.has(binding.logicalId)) profileError('mapping_binding_invalid', `Destination binding names unknown logical folder ${binding.logicalId}.`);
    if (bindings.has(binding.logicalId)) profileError('mapping_binding_invalid', `Destination provides more than one binding for logical folder ${binding.logicalId}.`);
    const localPath = normalizedLocalPath(binding.localPath, destination.platform, `Destination binding for ${binding.logicalId}`);
    if (boundRootNames.has(binding.rootName) || boundRootPaths.has(localPath)) {
      profileError('mapping_binding_invalid', `Destination local root ${binding.rootName} is assigned to more than one logical folder.`);
    }
    boundRootNames.add(binding.rootName);
    boundRootPaths.add(localPath);
    bindings.set(binding.logicalId, { rootName: binding.rootName, localPath: binding.localPath });
  }
  for (const folder of portable.data.folders) {
    if (!bindings.get(folder.id)) profileError('mapping_binding_required', `Portable logical folder ${folder.id} must be rebound on the destination device.`);
  }
  if (bindings.size !== portable.data.folders.length) profileError('mapping_binding_invalid', 'Destination folder bindings contain excess entries.');
  const profile = instanceProfileSchema.safeParse({
    schemaVersion: INSTANCE_PROFILE_SCHEMA_VERSION,
    id: destination.id,
    displayName: destination.displayName ?? portable.data.displayName,
    platform: destination.platform,
    deviceId: destination.deviceId,
    accountLabel: portable.data.accountLabel,
    enabled: true,
    state: { mode: 'isolated', root: destination.stateRoot },
    bridge: { host: '127.0.0.1', port: destination.bridgePort },
    connector: { identity: destination.connectorIdentity, legacyNames: false },
    tunnelProfileRef: destination.tunnelProfileRef,
    browser: {
      profileId: destination.browserProfileId,
      ...(destination.browserProfileDirectory
        ? { profileDirectory: browserProfileDirectorySchema.parse(destination.browserProfileDirectory), family: 'chrome' as const }
        : {}),
      electronPartition: destination.electronPartition
    },
    namespaces: destination.namespaces,
    approvedFolders: portable.data.folders.map(folder => ({
      ...folder,
      bindings: [{
        platform: destination.platform,
        deviceId: destination.deviceId,
        rootName: bindings.get(folder.id)!.rootName,
        localPath: normalizedLocalPath(bindings.get(folder.id)!.localPath, destination.platform, `Destination binding for ${folder.id}`)
      }]
    })),
    projects: portable.data.projects
  });
  if (!profile.success) profileError('malformed_profile', `Destination instance binding is invalid: ${profile.error.issues[0]?.message ?? 'invalid data'}.`);
  validateLogicalMappings(profile.data);
  requirePlatformPath(profile.data.state.root, profile.data.platform, `State root for ${profile.data.id}`);
  return profile.data;
}

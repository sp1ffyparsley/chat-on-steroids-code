/** Agent settings use the renderer's validated Save owner, never another config writer. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { getActiveInstanceRuntime, getActiveInstanceOwnerPaths, getConfig } from './config.js';
import { getConnectionControlStatus } from './connection-control.js';
import { logInfo, logWarn } from './logger.js';

type Snapshot = Record<string, unknown>;
type SettingsOwner = {
  schema: z.ZodObject;
  save: (payload: { base: Snapshot; patch: Snapshot }, instanceId: string) => Promise<unknown>;
};
let owner: SettingsOwner | undefined;
let serial: Promise<unknown> = Promise.resolve();
export class SettingsControlError extends Error {}

export function configureSettingsControl(value: SettingsOwner): void {
  owner = value;
  logInfo('agent settings: existing Settings Save owner registered');
}

function snapshot(): Snapshot {
  if (!owner) throw new SettingsControlError('Settings control is not ready; wait for account startup to finish.');
  return owner.schema.parse(getConfig()) as Snapshot;
}
function revision(value: Snapshot): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function leafFields(value: Snapshot, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const field = prefix ? `${prefix}.${key}` : key;
    return child !== null && typeof child === 'object' && !Array.isArray(child)
      ? leafFields(child as Snapshot, field) : [field];
  });
}
function fieldValue(value: Snapshot, field: string): unknown {
  return field.split('.').reduce<unknown>((current, key) =>
    current !== null && typeof current === 'object' ? (current as Snapshot)[key] : undefined, value);
}
function sharedPreferencesOwner() {
  const config = getConfig(), runtime = getActiveInstanceRuntime();
  const policy = config.instances?.sharedFolderAccess;
  const primary = config.instances?.profiles.find(profile => profile.state.mode === 'legacy' &&
    profile.platform === runtime.profile.platform && profile.deviceId === runtime.profile.deviceId);
  const preferences = config.sharedAccountPreferences?.preferences;
  const enabled = policy?.enabled === true && policy.platform === runtime.profile.platform &&
    policy.deviceId === runtime.profile.deviceId && !!preferences;
  const platformPath = runtime.profile.platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value: string) => runtime.profile.platform === 'win32'
    ? platformPath.resolve(value).toLowerCase() : platformPath.resolve(value);
  const isOwner = !!primary && normalize(getActiveInstanceOwnerPaths().stateRoot) === normalize(primary.state.root);
  return { enabled, owner: primary ? { instanceId: primary.id, displayName: primary.displayName } : null,
    isOwner, fields: enabled ? leafFields(preferences as unknown as Snapshot).filter(field => field !== 'version') : [] };
}

export function readAgentSettings() {
  const settings = snapshot();
  const { profile } = getActiveInstanceRuntime();
  return { instanceId: profile.id, displayName: profile.displayName, revision: revision(settings), settings,
    schema: z.toJSONSchema(owner!.schema, { unrepresentable: 'any' }), connection: getConnectionControlStatus(),
    profile, paths: getActiveInstanceOwnerPaths(), approvedFolders: getConfig().roots,
    sharedPreferences: sharedPreferencesOwner() };
}

/** Strict partial objects; validate the completed result through the original full schema. */
function mergePatch(base: Snapshot, patch: Snapshot, prefix = '', schema = owner!.schema): Snapshot {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(schema.shape, key) || key === '__proto__' || key === 'constructor' || key === 'prototype')
      throw new SettingsControlError(`Unknown setting ${field}; inspect settings_read for supported fields.`);
    const old = base[key];
    let fieldSchema = schema.shape[key];
    while (fieldSchema instanceof z.ZodOptional) fieldSchema = fieldSchema.unwrap();
    if (fieldSchema instanceof z.ZodObject) {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new SettingsControlError(`Setting ${field} requires a partial object.`);
      result[key] = mergePatch((old ?? {}) as Snapshot, value as Snapshot, field, fieldSchema);
    } else result[key] = value;
  }
  return result;
}

export const agentSettingsUpdateSchema = z.object({
  instanceId: z.string().min(1).max(64),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  patch: z.record(z.string(), z.unknown())
}).strict();

export function updateAgentSettings(value: z.infer<typeof agentSettingsUpdateSchema>) {
  const request = agentSettingsUpdateSchema.parse(value);
  const run = serial.catch(() => undefined).then(async () => {
    const assertOwner = () => {
      if (getActiveInstanceRuntime().profile.id !== request.instanceId)
        throw new SettingsControlError('Settings target another account; inspect that account through its own connector.');
    };
    assertOwner();
    const base = snapshot();
    if (revision(base) !== request.revision)
      throw new SettingsControlError('Settings changed since inspection; call settings_read and apply your edit to the new revision.');
    const patch = owner!.schema.parse(mergePatch(base, request.patch)) as Snapshot;
    if (revision(patch) === request.revision) return readAgentSettings();
    const changedFields = leafFields(request.patch).filter(field =>
      JSON.stringify(fieldValue(base, field)) !== JSON.stringify(fieldValue(patch, field)));
    const expectedFields = changedFields.map(field => [field, JSON.stringify(fieldValue(patch, field))] as const);
    const sharing = sharedPreferencesOwner();
    if (sharing.enabled && !sharing.isOwner && changedFields.some(field => sharing.fields.includes(field))) {
      const guidance = sharing.owner
        ? `Use background settings controls with --profile ${sharing.owner.instanceId} (${sharing.owner.displayName}).`
        : 'Inspect the primary account registry before retrying.';
      throw new SettingsControlError(`Shared preferences must be edited by their primary account owner. ${guidance} No settings were saved.`);
    }
    // A tool cannot stop the transport carrying its own reply. Local background controls own
    // connection reconfiguration once the account is idle, including bootstrap before MCP exists.
    if (JSON.stringify(base.tunnel) !== JSON.stringify(patch.tunnel))
      throw new SettingsControlError('Connection settings require the exact-account background connection control; a live tool cannot reconnect its own transport.');
    assertOwner();
    logInfo(`agent settings: save started for ${request.instanceId}`);
    try {
      await owner!.save({ base, patch }, request.instanceId);
      assertOwner();
      const effective = snapshot();
      if (expectedFields.some(([field, expected]) => JSON.stringify(fieldValue(effective, field)) !== expected))
        throw new SettingsControlError('Settings Save completed, but effective settings differ from the requested edit due to shared ownership, a concurrent change, or a setting dependency. Call settings_read and inspect sharedPreferences and the new revision before retrying; this request was not fully applied.');
      logInfo(`agent settings: save completed for ${request.instanceId}`);
      return readAgentSettings();
    } catch (error) {
      logWarn(`agent settings: save failed for ${request.instanceId}; inspect account diagnostics and current revision before retrying`);
      throw error;
    }
  });
  serial = run;
  return run;
}

/** Remote preferences cannot grant permissions, resume work, change trust or expose private prompts. */
const remoteSettingsFields = {
  ui: ['theme', 'followOutput', 'minimizeToTray']
} as const;
function remoteSchema(partial = false) {
  if (!owner) throw new SettingsControlError('Settings control is not ready; wait for account startup to finish.');
  const shape: Record<string, z.ZodObject> = {};
  for (const [group, fields] of Object.entries(remoteSettingsFields)) {
    const original = owner.schema.shape[group];
    if (!(original instanceof z.ZodObject)) continue;
    const selected = z.object(Object.fromEntries(fields.filter(field => Object.hasOwn(original.shape, field))
      .map(field => [field, original.shape[field]]))).strict();
    shape[group] = partial ? selected.partial() : selected;
  }
  const schema = z.object(shape).strict();
  return partial ? schema.partial() : schema;
}
export function readRemoteAgentSettings() {
  const schema = remoteSchema();
  const full = readAgentSettings();
  const allowed = new Set(Object.entries(remoteSettingsFields).flatMap(([group, fields]) => fields.map(field => `${group}.${field}`)));
  return { instanceId: full.instanceId, displayName: full.displayName, revision: full.revision,
    settings: schema.parse(Object.fromEntries(Object.entries(schema.shape).map(([group, definition]) =>
      [group, Object.fromEntries(Object.keys(definition.shape).filter(field => Object.hasOwn(full.settings[group] as Snapshot, field))
        .map(field => [field, (full.settings[group] as Snapshot)[field]]))]))),
    schema: z.toJSONSchema(schema), connection: full.connection,
    sharedPreferences: { ...full.sharedPreferences, fields: full.sharedPreferences.fields.filter(field => allowed.has(field)) } };
}
export async function updateRemoteAgentSettings(value: z.infer<typeof agentSettingsUpdateSchema>) {
  const request = agentSettingsUpdateSchema.parse(value);
  try { remoteSchema(true).parse(request.patch); }
  catch { throw new SettingsControlError('This setting is local-only. Use the exact-account background controls for permissions, privacy, connection, automation holds, models and private prompts. No settings were saved.'); }
  await updateAgentSettings(request);
  return readRemoteAgentSettings();
}

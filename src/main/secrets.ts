/**
 * Secret storage backed by the OS.
 *
 * Electron safeStorage delegates to the host OS: DPAPI on Windows, Keychain on macOS,
 * and a desktop secret store such as libsecret/KWallet on Linux. The plaintext key exists
 * only inside the main process: it is never sent over IPC, never written to config.json,
 * and never logged. Linux's `basic_text` fallback is deliberately rejected below because
 * presenting obfuscation as credential encryption would weaken the app on the new port.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { INSTANCE_CONNECTOR_SURFACES, type InstanceConnectorSurface } from '../shared/instance-profile.js';
import { MCP_SURFACE_TOKEN_PATTERN } from '../shared/external-tunnel.js';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { SecureStorageInfo } from '../shared/types.js';
import { logError, logInfo, logWarn } from './logger.js';
import { replaceFileAtomically } from './atomic-file.js';
import { setupApiKeySlot } from '../shared/setup-profile.js';

const FILE_NAME = 'secrets.bin';
const CHROMIUM_LOCAL_STATE = 'Local State';
const LINUX_BASIC_TEXT_PREFIX = Buffer.from('v10', 'ascii');
const LINUX_STORAGE_PROBE = 'chat-on-steroids-safe-storage-probe';
export const INSTANCE_DEVICE_BINDING_SECRET = 'instanceDeviceBinding' as const;

let secretsPath = '';
let cache: Record<string, string> | null = null;
/** A successful decrypt asked us to reseal the blob with the current async key. */
let rotationPending = false;
/** Invalidates a decrypt that started before an explicit store reset/delete boundary. */
let loadGeneration = 0;
/**
 * Coalesces concurrent cache misses into one disk/keyring read.
 *
 * Async safeStorage makes a load genuinely long-lived: without a single-flight promise, a
 * read-only getSecret() and a queued setSecret() can both decrypt the old blob, the mutation
 * can commit a new blob, and then the slower read can publish its old snapshot back into cache.
 * The next mutation would then compose from stale credentials and could erase the just-written
 * value. One authoritative load shared by all callers closes that race at its source.
 */
let loadInFlight: Promise<Record<string, string>> | null = null;
/**
 * Every mutation is a read-modify-write of one small encrypted blob. Saving the OpenAI key
 * while the bridge token is being minted would otherwise have both calls clone the same
 * snapshot, and the later write would erase the other's key — as well as racing on
 * secrets.bin.tmp. Same shape as config.ts's queue, for the same reason.
 */
let mutationQueue: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(operation);
  mutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * `bridgeToken` is not a user credential: it is the bearer token the paired browser
 * extension presents. It lives here anyway so it is encrypted at rest and stays out of
 * config.json, the log and the renderer.
 */
/**
 * `bridgeToken` is not a user credential either way; `openRouterApiKey` and
 * `customProviderApiKey` are the two credentials a *model* can cause to be spent (Goal/Loop
 * drafts, one per active provider), so they live under the same OS-backed encrypted blob
 * as the rest and never leave the main process.
 */
export type SecretKey =
  | 'openaiApiKey'
  | 'bridgeToken'
  | 'bridgeExtensionOrigin'
  | 'studyHelperBridgeToken'
  | 'openRouterApiKey'
  | 'customProviderApiKey'
  | typeof INSTANCE_DEVICE_BINDING_SECRET
  | `plugin:${string}`
  | `setup:${string}`
  | `instance:${string}:${string}`;

export type ProfileSecretMode = 'legacy' | 'isolated';
export type ProviderSecretKey = 'openRouterApiKey' | 'customProviderApiKey';

export class SecretStoreUnavailableError extends Error {
  constructor(message = 'Secure OS credential storage is unavailable or stored credentials could not be decrypted.') {
    super(message);
    this.name = 'SecretStoreUnavailableError';
  }
}

const INSTANCE_SECRET_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const INSTANCE_LOCAL_SECRET = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const PLUGIN_SECRET_COMPONENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const PLUGIN_CREDENTIAL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,158}[A-Za-z0-9])?$/;

/** Deterministic slot for instance-local secrets that have no legacy/global equivalent. */
export function isolatedInstanceSecretSlot(instanceId: string, localKey: string): `instance:${string}:${string}` {
  if (!INSTANCE_SECRET_ID.test(instanceId)) throw new Error('Invalid isolated instance id for secret storage');
  if (!INSTANCE_LOCAL_SECRET.test(localKey)) throw new Error('Invalid isolated instance secret name');
  return `instance:${instanceId}:${localKey}`;
}

/**
 * Provider credentials predate account profiles. The migrated/default profile must keep those
 * exact historical keys; isolated profiles get a deterministic instance prefix and never fall
 * back to, copy, or rename the legacy value.
 */
export function profileProviderSecretSlot(
  mode: ProfileSecretMode,
  instanceId: string,
  key: ProviderSecretKey
): SecretKey {
  if (mode === 'legacy') return key;
  if (!INSTANCE_SECRET_ID.test(instanceId)) throw new Error('Invalid isolated instance id for provider secret storage');
  return `instance:${instanceId}:${key}`;
}

/**
 * Plugin installation identity stays unchanged across account profiles; only its encrypted
 * credential slot is scoped. Legacy/default retains `plugin:<id>:<key>` byte-for-byte.
 */
export function pluginCredentialSecretSlot(
  mode: ProfileSecretMode,
  instanceId: string,
  pluginId: string,
  credentialName: string
): SecretKey {
  if (!PLUGIN_SECRET_COMPONENT.test(pluginId)) throw new Error('Invalid plugin id for secret storage');
  if (!PLUGIN_CREDENTIAL_NAME.test(credentialName)) throw new Error('Invalid plugin credential name for secret storage');
  const legacy: `plugin:${string}` = `plugin:${pluginId}:${credentialName}`;
  if (mode === 'legacy') return legacy;
  if (!INSTANCE_SECRET_ID.test(instanceId)) throw new Error('Invalid isolated instance id for plugin secret storage');
  return `instance:${instanceId}:${legacy}`;
}

/** The migrated legacy profile must continue to use the exact historical bridgeToken slot. */
export function bridgeTokenSecretSlot(mode: 'legacy' | 'isolated', instanceId: string): SecretKey {
  return mode === 'legacy' ? 'bridgeToken' : isolatedInstanceSecretSlot(instanceId, 'bridgeToken');
}

/** Origin paired with the browser token, so another installed extension cannot rotate it. */
export function bridgeExtensionOriginSecretSlot(mode: 'legacy' | 'isolated', instanceId: string): SecretKey {
  return mode === 'legacy'
    ? 'bridgeExtensionOrigin'
    : isolatedInstanceSecretSlot(instanceId, 'bridgeExtensionOrigin');
}

export function initSecretsPath(userDataDir: string): void {
  secretsPath = path.join(userDataDir, FILE_NAME);
}

/**
 * Windows' async safeStorage key is DPAPI-wrapped in Electron's per-userData Local State.
 * A parent-encrypted seed cannot be opened by a fresh child userData with a newly generated
 * key. Provision the same *OS-protected key*, never plaintext credentials, before the child
 * launches. Values and browser sessions remain account-scoped; existing child keys are never
 * overwritten (they may already protect live account data or have rotated independently).
 */
async function provisionWindowsIsolatedStorageKey(runtimeRoot: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const sourceFile = path.join(path.dirname(secretsPath), CHROMIUM_LOCAL_STATE);
  const targetFile = path.join(runtimeRoot, CHROMIUM_LOCAL_STATE);
  const readKey = async (file: string): Promise<string | null> => {
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8')) as { os_crypt?: { encrypted_key?: unknown } };
      const key = state.os_crypt?.encrypted_key;
      if (typeof key !== 'string' || key.length === 0) throw new Error('Windows protected storage key is missing');
      const wrapped = Buffer.from(key, 'base64');
      if (!wrapped.subarray(0, 5).equals(Buffer.from('DPAPI', 'ascii'))) {
        throw new Error('Windows protected storage key is not DPAPI-wrapped');
      }
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const parentKey = await readKey(sourceFile);
  if (!parentKey) throw new SecretStoreUnavailableError('Primary Windows protected storage key is missing; account runtime was not seeded');
  const childKey = await readKey(targetFile);
  if (childKey) {
    if (childKey !== parentKey) {
      throw new SecretStoreUnavailableError('Account runtime has a different Windows protected storage key; existing account data was left untouched');
    }
    return;
  }
  await fs.mkdir(runtimeRoot, { recursive: true });
  const temporary = `${targetFile}.tmp-${process.pid}`;
  await fs.writeFile(temporary, JSON.stringify({ os_crypt: { encrypted_key: parentKey } }), { encoding: 'utf8', mode: 0o600 });
  try {
    // Never replace a Local State that appeared concurrently while this account was starting.
    await fs.link(temporary, targetFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const racedKey = await readKey(targetFile);
    if (racedKey !== parentKey) throw new SecretStoreUnavailableError('Account runtime storage key changed during startup; credentials were not seeded');
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Seeds one stopped account runtime without handing it sibling-account credentials. Existing
 * runtime-owned secrets (notably its browser pairing token) are never rewritten on a later
 * launch. A missing store is seeded once; subsequent key changes belong to that account's
 * own running Settings path rather than a cross-process writer.
 */
export function seedIsolatedInstanceSecrets(runtimeRoot: string, instanceId: string, setupProfileId: string): Promise<void> {
  if (!INSTANCE_SECRET_ID.test(instanceId) || !INSTANCE_SECRET_ID.test(setupProfileId)) {
    throw new Error('Invalid account or setup id for isolated runtime credentials');
  }
  return enqueue(async () => {
    const source = await readAll();
    if (cache === null || !(await isEncryptionAvailable())) throw new SecretStoreUnavailableError();
    const binding = source[INSTANCE_DEVICE_BINDING_SECRET];
    if (!binding) throw new Error('OS-protected device binding is missing; account runtime was not seeded');
    const setupSlot = setupApiKeySlot(setupProfileId);
    const selected: Record<string, string> = { [INSTANCE_DEVICE_BINDING_SECRET]: binding };
    if (source[setupSlot]) selected[setupSlot] = source[setupSlot];
    const prefix = `instance:${instanceId}:`;
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith(prefix)) selected[key] = value;
    }
    const target = path.join(runtimeRoot, FILE_NAME);
    let existing: Record<string, string> | null = null;
    try {
      const blob = await fs.readFile(target);
      if (!secureStorageCiphertextIsProtected(blob)) throw new SecretStoreUnavailableError('Existing account runtime credentials are not securely encrypted');
      try {
        existing = parseSecretStore((await safeStorage.decryptStringAsync(blob)).result);
      } catch {
        // A child may rotate its own OS key after first launch. The parent cannot prove that
        // ciphertext's contents, so it must neither overwrite it nor call it empty. The child
        // verifies device binding and account namespace before starting any runtime owner.
        logWarn('Existing account credentials could not be read by the primary; the account runtime will verify them on startup');
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing?.[INSTANCE_DEVICE_BINDING_SECRET] && existing[INSTANCE_DEVICE_BINDING_SECRET] !== binding) {
      throw new Error('Existing account runtime belongs to another device; credentials were not changed');
    }
    if (existing && Object.keys(existing).some(key => key !== INSTANCE_DEVICE_BINDING_SECRET && key !== setupSlot && !key.startsWith(prefix))) {
      throw new Error('Existing account runtime contains credentials outside its account namespace; credentials were not changed');
    }
    if (existing) return;
    await provisionWindowsIsolatedStorageKey(runtimeRoot);
    const encoded = await safeStorage.encryptStringAsync(JSON.stringify(selected));
    if (!secureStorageCiphertextIsProtected(encoded)) throw new SecretStoreUnavailableError();
    await fs.mkdir(runtimeRoot, { recursive: true });
    const temporary = `${target}.tmp-${process.pid}`;
    await fs.writeFile(temporary, encoded, { mode: 0o600 });
    try { await replaceFileAtomically(temporary, target, 'Isolated runtime secrets'); }
    catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error; }
  });
}

/** Refuse copied sibling credentials even when the child can decrypt its own store. */
export async function validateIsolatedInstanceSecrets(instanceId: string, setupProfileId: string): Promise<void> {
  if (!INSTANCE_SECRET_ID.test(instanceId) || !INSTANCE_SECRET_ID.test(setupProfileId)) {
    throw new Error('Invalid account or setup id for isolated runtime credentials');
  }
  const values = await readAll();
  if (cache === null) throw new SecretStoreUnavailableError();
  if (!values[INSTANCE_DEVICE_BINDING_SECRET]) throw new Error('Account runtime has no OS-protected device binding');
  const setupSlot = setupApiKeySlot(setupProfileId);
  const prefix = `instance:${instanceId}:`;
  if (Object.keys(values).some(key => key !== INSTANCE_DEVICE_BINDING_SECRET && key !== setupSlot && !key.startsWith(prefix))) {
    throw new Error('Account runtime contains credentials outside its own namespace; no runtime owner was started');
  }
}

/**
 * Electron 43's Linux async safeStorage stack always includes Chromium's PosixKeyProvider as
 * its last-resort provider. That provider is deliberately sync-compatible `v10` encryption and
 * uses Chromium's public hard-coded "peanuts" key. `getSelectedStorageBackend()` describes the
 * legacy/selected desktop backend, not which async provider actually supplied a key, so a GNOME
 * session whose Secret Service is down can still report `gnome_libsecret` while async encryption
 * silently falls back to `v10`. The bytes are the authority.
 */
export function secureStorageCiphertextIsProtected(
  encrypted: Buffer,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'linux' || !encrypted.subarray(0, LINUX_BASIC_TEXT_PREFIX.length).equals(LINUX_BASIC_TEXT_PREFIX);
}

export async function secureStorageStatus(platform: NodeJS.Platform = process.platform): Promise<SecureStorageInfo> {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      return {
        available: false,
        detail:
          platform === 'linux'
            ? 'Secure credential storage is unavailable. Start or unlock a Linux desktop keyring/Secret Service (for example GNOME Keyring or KWallet), then try again.'
            : platform === 'darwin'
              ? 'macOS Keychain credential storage is unavailable. Unlock the login keychain, then try again.'
              : 'Secure operating-system credential storage is unavailable on this machine.'
      };
    }
    if (platform === 'linux') {
      // Probe the provider Electron actually chose, not only the desktop/backend label above.
      // The probe contains no credential and is never persisted.
      const probe = await safeStorage.encryptStringAsync(LINUX_STORAGE_PROBE);
      if (!secureStorageCiphertextIsProtected(probe, platform)) {
        return {
          available: false,
          detail:
            'Linux secure storage fell back to Electron’s insecure hard-coded-key provider. Start or unlock a desktop keyring/Secret Service (for example GNOME Keyring or KWallet), then restart Chat On Steroids.'
        };
      }
    }
    return { available: true, detail: null };
  } catch {
    return { available: false, detail: 'Secure operating-system credential storage could not be initialized.' };
  }
}

export async function isEncryptionAvailable(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return (await secureStorageStatus(platform)).available;
}

/**
 * A decrypt succeeding proves only that the host key was usable, not that the plaintext is a
 * secret-store snapshot this version can safely rewrite. Treat malformed shapes/values like any
 * other non-authoritative read: callers may degrade to "no credential", but a later mutation
 * must not compose from `{}` and destroy ciphertext whose contents we did not understand.
 *
 * Unknown string-valued fields are deliberately preserved for forward compatibility. The store
 * is a tiny string map, so a future release can add a key without an older build deleting it.
 */
function parseSecretStore(json: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored credential payload is not an object');
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`Stored credential field ${key} is not a string`);
  }
  return parsed as Record<string, string>;
}

async function loadAll(): Promise<Record<string, string>> {
  const generation = loadGeneration;
  // Keychain / Secret Service availability can be transient on macOS/Linux (for example while
  // the login keychain is locked or no desktop keyring has been unlocked yet). Do not attempt
  // decryption in that state and, crucially, do not cache an empty object: once secure storage
  // becomes available later in the same process, the next read must retry the real encrypted
  // file. Caching `{}` here would make a later setSecret() overwrite the existing blob and erase
  // credentials that were merely temporarily inaccessible.
  if (!(await isEncryptionAvailable())) return {};
  try {
    const blob = await fs.readFile(secretsPath);
    if (!secureStorageCiphertextIsProtected(blob)) {
      // Do not turn a historical/insecure Linux v10 blob into authoritative plaintext merely
      // because a secure keyring became available later. Linux support first ships in 2.0.2, so
      // there is no supported secure Linux v10 format to migrate here.
      logWarn('Stored Linux credentials use Electron’s insecure hard-coded-key fallback; the file was left untouched');
      rotationPending = false;
      return {};
    }
    const decrypted = await safeStorage.decryptStringAsync(blob);
    const parsed = parseSecretStore(decrypted.result);
    // `deleteAllSecrets()` is allowed to race a Keychain decrypt without waiting for a prompt or
    // unavailable provider. Once deletion starts, plaintext from the older generation must never
    // republish credentials that have just been removed from disk.
    if (generation !== loadGeneration) return cache ?? {};
    cache = parsed;
    rotationPending = decrypted.shouldReEncrypt;
  } catch (err) {
    if (generation !== loadGeneration) return cache ?? {};
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      cache = {};
      rotationPending = false;
    } else {
      // Electron's async API can reject while a key provider is temporarily unavailable, but
      // Electron 43.4's TypeScript result shape does not expose the `isTemporarilyUnavailable`
      // marker mentioned by the docs. A copied/corrupt blob is indistinguishable here from a
      // transient key-provider failure. Treat *neither* as an empty authoritative store: leave
      // the ciphertext untouched, leave cache unresolved, and make every mutation fail closed.
      // Reads still degrade to "no credential" so startup/bridge/UI remain usable and a later
      // call can retry after Keychain/Secret Service becomes available again.
      const available = await isEncryptionAvailable();
      logWarn(
        available
          ? 'Stored credentials could not be decrypted; the encrypted file was left untouched'
          : 'Stored credentials are temporarily unavailable because secure storage could not decrypt them'
      );
      rotationPending = false;
      return {};
    }
  }
  return cache;
}

async function readAll(): Promise<Record<string, string>> {
  if (cache) return cache;
  if (loadInFlight) return loadInFlight;
  const load = loadAll();
  loadInFlight = load;
  try {
    return await load;
  } finally {
    if (loadInFlight === load) loadInFlight = null;
  }
}

async function writeAll(values: Record<string, string>): Promise<void> {
  if (!(await isEncryptionAvailable())) {
    throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
  }
  const blob = await safeStorage.encryptStringAsync(JSON.stringify(values));
  if (!secureStorageCiphertextIsProtected(blob)) {
    throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
  }
  const tmp = `${secretsPath}.tmp`;
  await fs.mkdir(path.dirname(secretsPath), { recursive: true });
  await fs.writeFile(tmp, blob, { mode: 0o600 });
  await replaceFileAtomically(tmp, secretsPath, 'Secrets');
  // Published only once the rename succeeded. A failed disk write must leave the
  // process believing the old state, not a credential it never actually saved.
  cache = values;
  rotationPending = false;
}

/**
 * Reseals a successfully decrypted blob when Electron reports key rotation.
 *
 * Decryption has already proved the plaintext and JSON are valid. Re-encryption is still
 * best-effort for reads: if the new key is temporarily unavailable, keep both the in-memory
 * plaintext and the old ciphertext intact and try again after the next process restart/read.
 * The mutation queue prevents a rotation rewrite from racing a user/API-key update through
 * the shared `secrets.bin.tmp` path.
 */
async function rotateIfNeeded(): Promise<void> {
  if (!rotationPending || cache === null) return;
  await enqueue(async () => {
    if (!rotationPending || cache === null) return;
    try {
      // Chromium sets `should_reencrypt` when this plaintext was successfully decrypted by a
      // provider other than the one now selected for encryption. Electron forwards that flag and
      // plaintext verbatim, so migration is encrypting the returned plaintext with the current
      // provider. Calling decrypt on the old ciphertext again cannot change which provider sealed
      // those bytes and would never perform the requested rotation.
      await writeAll({ ...cache });
    } catch (err) {
      logWarn(`Stored credentials could not be re-encrypted with the current secure-storage key: ${(err as Error).message}`);
    }
  });
}

/**
 * API keys never contain whitespace or invisible formatting characters, but copied keys can.
 * Clean only provider/setup API-key slots; bridge, device and plugin secrets retain exact bytes.
 * Reading through this path also heals the value in memory for callers with an older stored key.
 */
const INVISIBLE_IN_KEYS = /[\s\u0085\u00AD\u180E\u200B-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\uFEFF]/g;
function isApiKeySlot(key: SecretKey): boolean {
  return key === 'openaiApiKey' || key === 'openRouterApiKey' || key === 'customProviderApiKey' ||
    key.startsWith('setup:') || /^instance:[^:]+:(?:openRouterApiKey|customProviderApiKey)$/.test(key);
}
export function cleanApiKey(value: string): string {
  return value.replace(INVISIBLE_IN_KEYS, '');
}

export async function getSecret(key: SecretKey): Promise<string | null> {
  const all = await readAll();
  const stored = all[key];
  await rotateIfNeeded();
  const value = stored && isApiKeySlot(key) ? cleanApiKey(stored) : stored;
  return value && value.length > 0 ? value : null;
}

/**
 * Reads a secret only when the encrypted store itself was authoritatively loaded.
 *
 * Ordinary credential/status callers deliberately degrade an unavailable Keychain/Secret
 * Service or an undecryptable blob to "no credential" so the UI can still start. Device
 * identity verification cannot make that substitution: absence and inability to verify are
 * different security facts. This narrow strict path preserves the existing store owner/file and
 * lets profile startup fail closed without exposing the rest of the secret map.
 */
export async function getSecretStrict(key: SecretKey): Promise<string | null> {
  const all = await readAll();
  if (cache === null) throw new SecretStoreUnavailableError();
  const stored = all[key];
  await rotateIfNeeded();
  const value = stored && isApiKeySlot(key) ? cleanApiKey(stored) : stored;
  return value && value.length > 0 ? value : null;
}

export async function hasSecret(key: SecretKey): Promise<boolean> {
  return (await getSecret(key)) !== null;
}

export function setSecret(key: SecretKey, value: string): Promise<void> {
  return enqueue(async () => {
    if (!(await isEncryptionAvailable())) {
      throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
    }
    // Read inside the queue, so this composes from the latest committed state rather
    // than from a snapshot taken before the call ahead of it finished.
    const current = await readAll();
    // `readAll()` deliberately degrades to an empty *view* for startup/status callers while
    // Keychain/Secret Service is unavailable. A mutation must never compose from that view:
    // if the read did not establish an authoritative cache, writing it would replace real
    // encrypted credentials with a partial/empty blob after a transient unlock race.
    if (cache === null) {
      throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
    }
    const all = { ...current };
    const trimmed = isApiKeySlot(key) ? cleanApiKey(value) : value.trim();
    if (trimmed === '') {
      delete all[key];
    } else {
      all[key] = trimmed;
    }
    await writeAll(all);
  });
}

/** One atomic encrypted identity bundle; concurrent connects cannot mint different authorities. */
export function getOrCreateMcpEndpointTokens(instanceId: string, revision = 0): Promise<Record<InstanceConnectorSurface, string>> {
  if (!Number.isSafeInteger(revision) || revision < 0) return Promise.reject(new Error('Invalid persistent MCP identity revision.'));
  const key = isolatedInstanceSecretSlot(instanceId, 'mcpEndpointIdentity');
  return enqueue(async () => {
    const current = await readAll();
    if (cache === null) throw new SecretStoreUnavailableError();
    const stored = current[key];
    if (stored) {
      let bundle: { version?: unknown; instanceId?: unknown; revision?: unknown; tokens?: Record<string, unknown> };
      try { bundle = JSON.parse(stored); }
      catch { throw new Error('Stored persistent MCP identity is invalid; check this account’s encrypted credential store.'); }
      const storedRevision = bundle?.revision ?? 0;
      if (!bundle || bundle.version !== 1 || bundle.instanceId !== instanceId || !bundle.tokens ||
          typeof storedRevision !== 'number' || !Number.isSafeInteger(storedRevision) || storedRevision < 0 ||
          Object.keys(bundle.tokens).length !== INSTANCE_CONNECTOR_SURFACES.length ||
          INSTANCE_CONNECTOR_SURFACES.some(id => typeof bundle.tokens![id] !== 'string' || !MCP_SURFACE_TOKEN_PATTERN.test(bundle.tokens![id] as string)) ||
          new Set(Object.values(bundle.tokens)).size !== INSTANCE_CONNECTOR_SURFACES.length)
        throw new Error('Stored persistent MCP identity is invalid or belongs to another account; connection was not published.');
      if (revision < storedRevision) throw new Error('Stored persistent MCP identity revision is newer; stale route settings cannot resurrect retired access.');
      if (revision === storedRevision) {
        logInfo(`persistent MCP identity loaded for ${instanceId}, revision ${revision}`);
        return { ...bundle.tokens } as Record<InstanceConnectorSurface, string>;
      }
    }
    if (!(await isEncryptionAvailable())) throw new SecretStoreUnavailableError();
    const tokens = Object.fromEntries(INSTANCE_CONNECTOR_SURFACES.map(id => [id, randomBytes(32).toString('base64url')])) as Record<InstanceConnectorSurface, string>;
    await writeAll({ ...current, [key]: JSON.stringify({ version: 1, instanceId, revision, tokens }) });
    logInfo(`persistent MCP identity ${stored ? 'rotated' : 'saved'} for ${instanceId}, revision ${revision}`);
    return tokens;
  }).then(async tokens => {
    // Rotation has its own queued write; never await it from inside the mutation queue.
    await rotateIfNeeded();
    return tokens;
  });
}

export function clearSecret(key: SecretKey): Promise<void> {
  return setSecret(key, '');
}

export function deleteAllSecrets(): Promise<void> {
  return enqueue(async () => {
    // Invalidate first, before touching disk. A decrypt may already hold the old ciphertext in
    // memory and can complete after rm(); its generation check above then returns the new empty
    // view instead of resurrecting the deleted credentials into cache.
    loadGeneration += 1;
    rotationPending = false;
    cache = null;
    try {
      await fs.rm(secretsPath, { force: true });
      cache = {};
    } catch (err) {
      logError(`Could not remove stored credentials: ${(err as Error).message}`);
      throw err;
    }
  });
}

/** Test seam: forgets the decrypted blob so the next read comes from disk. */
export function resetSecretsCacheForTests(): void {
  loadGeneration += 1;
  cache = null;
  rotationPending = false;
  loadInFlight = null;
}

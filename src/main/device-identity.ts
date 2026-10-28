import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { replaceFileAtomically } from './atomic-file.js';
import { InstanceProfileError, instancePlatform, type InstancePlatform } from '../shared/instance-profile.js';
import { getSecretStrict, INSTANCE_DEVICE_BINDING_SECRET, setSecret } from './secrets.js';

export const DEVICE_IDENTITY_SCHEMA_VERSION = 1 as const;
export const DEVICE_IDENTITY_FILE = 'device-identity.json';

const deviceIdentitySchema = z.object({
  schemaVersion: z.literal(DEVICE_IDENTITY_SCHEMA_VERSION),
  id: z.string().uuid(),
  platform: z.enum(['win32', 'darwin', 'linux']),
  createdAt: z.string().datetime({ offset: true })
}).strict();

export type DeviceIdentity = z.infer<typeof deviceIdentitySchema>;

export interface DeviceIdentityOptions {
  /** Creation is an explicit migration/fresh-install decision. Omitted/false is load-only. */
  allowCreate?: boolean;
  idFactory?: () => string;
  now?: () => Date;
}

let identityQueue: Promise<void> = Promise.resolve();

function enqueueIdentity<T>(operation: () => Promise<T>): Promise<T> {
  const run = identityQueue.then(operation);
  identityQueue = run.then(() => undefined, () => undefined);
  return run;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new InstanceProfileError('malformed_profile', `${label} contains malformed JSON. Restore the original local profile data instead of replacing it.`);
  }
}

function parseIdentity(value: unknown, platform: InstancePlatform, label = 'Local device identity'): DeviceIdentity {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const version = (value as Record<string, unknown>)['schemaVersion'];
    if (version !== DEVICE_IDENTITY_SCHEMA_VERSION) {
      throw new InstanceProfileError('unsupported_profile_version', `${label} schema ${String(version)} is not supported by this build.`);
    }
  }
  const parsed = deviceIdentitySchema.safeParse(value);
  if (!parsed.success) throw new InstanceProfileError('malformed_profile', `${label} is malformed: ${parsed.error.issues[0]?.message ?? 'invalid data'}.`);
  if (parsed.data.platform !== platform) {
    throw new InstanceProfileError('wrong_platform', `${label} belongs to ${parsed.data.platform}, not ${platform}. Do not copy local profile state between platforms.`);
  }
  return parsed.data;
}

function sameIdentity(left: DeviceIdentity, right: DeviceIdentity): boolean {
  return left.schemaVersion === right.schemaVersion && left.id === right.id && left.platform === right.platform && left.createdAt === right.createdAt;
}

async function readIdentityFile(file: string, platform: InstancePlatform): Promise<DeviceIdentity | null> {
  try {
    return parseIdentity(parseJson(await fs.readFile(file, 'utf8'), 'Local device identity'), platform);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readProtectedBinding(platform: InstancePlatform): Promise<DeviceIdentity | null> {
  let raw: string | null;
  try {
    raw = await getSecretStrict(INSTANCE_DEVICE_BINDING_SECRET);
  } catch (error) {
    throw new InstanceProfileError(
      'wrong_device',
      `Local device identity cannot be verified because secure OS credential storage is unavailable or unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!raw) return null;
  return parseIdentity(parseJson(raw, 'OS-protected device binding'), platform, 'OS-protected device binding');
}

async function writeIdentityFile(file: string, identity: DeviceIdentity): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, JSON.stringify(identity, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    await replaceFileAtomically(temporary, file, 'Device identity');
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function bindIdentity(identity: DeviceIdentity): Promise<void> {
  try {
    await setSecret(INSTANCE_DEVICE_BINDING_SECRET, JSON.stringify(identity));
  } catch (error) {
    throw new InstanceProfileError(
      'wrong_device',
      `Local device identity could not be bound to secure OS credential storage: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function loadDeviceIdentity(
  userDataRoot: string,
  platformValue: NodeJS.Platform = process.platform
): Promise<DeviceIdentity> {
  return loadOrCreateDeviceIdentity(userDataRoot, platformValue, { allowCreate: false });
}

export async function loadOrCreateDeviceIdentity(
  userDataRoot: string,
  platformValue: NodeJS.Platform = process.platform,
  options: DeviceIdentityOptions = {}
): Promise<DeviceIdentity> {
  return enqueueIdentity(async () => {
    const platform = instancePlatform(platformValue);
    const file = path.join(userDataRoot, DEVICE_IDENTITY_FILE);
    const identity = await readIdentityFile(file, platform);

    // An existing profile registry must call the load-only path. Missing local proof is never
    // repaired implicitly from copied/configured portable data.
    if (!identity && options.allowCreate !== true) {
      throw new InstanceProfileError(
        'wrong_device',
        'Local device identity is missing. Existing instance profiles cannot recreate device ownership; use an explicit fresh/legacy migration or rebind on this device.'
      );
    }

    const binding = await readProtectedBinding(platform);
    if (identity) {
      if (!binding) {
        if (options.allowCreate !== true) {
          throw new InstanceProfileError(
            'wrong_device',
            'The local device identity has no OS-protected binding. Existing instance profiles cannot adopt an unverified plaintext identity.'
          );
        }
        await bindIdentity(identity);
        return identity;
      }
      if (!sameIdentity(identity, binding)) {
        throw new InstanceProfileError(
          'wrong_device',
          'The plaintext device identity does not match the OS-protected device binding. This profile data appears to belong to another device or installation.'
        );
      }
      return identity;
    }

    // `allowCreate` also makes an interrupted first migration idempotent: if the encrypted
    // binding committed before the plaintext file, restore exactly the bound identity rather than
    // minting a different UUID. Load-only callers above never take this repair path.
    if (binding) {
      await writeIdentityFile(file, binding);
      return binding;
    }

    const created = deviceIdentitySchema.parse({
      schemaVersion: DEVICE_IDENTITY_SCHEMA_VERSION,
      id: (options.idFactory ?? randomUUID)(),
      platform,
      createdAt: (options.now ?? (() => new Date()))().toISOString()
    });
    // Secret first: once this commits, any later plaintext-file failure is recoverable from the
    // same OS-bound identity on the next explicitly-authorized migration attempt.
    await bindIdentity(created);
    await writeIdentityFile(file, created);
    return created;
  });
}

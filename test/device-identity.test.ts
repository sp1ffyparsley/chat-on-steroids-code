import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  }
}));

const { safeStorage } = await import('electron');
const {
  DEVICE_IDENTITY_FILE,
  loadDeviceIdentity,
  loadOrCreateDeviceIdentity
} = await import('../src/main/device-identity.js');
const {
  getSecretStrict,
  initSecretsPath,
  INSTANCE_DEVICE_BINDING_SECRET,
  resetSecretsCacheForTests
} = await import('../src/main/secrets.js');
const { InstanceProfileError } = await import('../src/shared/instance-profile.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await makeTempDir('clf-device-identity-');
  initSecretsPath(dir);
  resetSecretsCacheForTests();
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  vi.mocked(safeStorage.encryptStringAsync).mockImplementation(async value => Buffer.from(value, 'utf8'));
  vi.mocked(safeStorage.decryptStringAsync).mockImplementation(async buffer => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }));
});

afterEach(async () => {
  await removeTempDir(dir);
});

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const CREATED = new Date('2026-09-15T12:00:00.000Z');

function expectProfileError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(InstanceProfileError);
  expect((error as InstanceType<typeof InstanceProfileError>).code).toBe(code);
}

describe('OS-bound device identity', () => {
  it('creates and binds a fresh identity only when explicitly allowed, then repeats idempotently', async () => {
    const first = await loadOrCreateDeviceIdentity(dir, 'win32', { allowCreate: true, idFactory: () => ID_A, now: () => CREATED });
    expect(first).toEqual({ schemaVersion: 1, id: ID_A, platform: 'win32', createdAt: CREATED.toISOString() });
    expect(JSON.parse(await fs.readFile(path.join(dir, DEVICE_IDENTITY_FILE), 'utf8'))).toEqual(first);
    expect(JSON.parse((await getSecretStrict(INSTANCE_DEVICE_BINDING_SECRET))!)).toEqual(first);

    const second = await loadOrCreateDeviceIdentity(dir, 'win32', {
      allowCreate: true,
      idFactory: () => ID_B,
      now: () => new Date('2030-01-01T00:00:00.000Z')
    });
    expect(second).toEqual(first);
    expect(JSON.parse((await getSecretStrict(INSTANCE_DEVICE_BINDING_SECRET))!)).toEqual(first);
  });

  it('is load-only by default and does not create missing device proof', async () => {
    await expect(loadDeviceIdentity(dir, 'win32')).rejects.toSatisfy((error: unknown) => {
      expectProfileError(error, 'wrong_device');
      expect(String((error as Error).message)).toMatch(/identity is missing/i);
      return true;
    });
    await expect(fs.access(path.join(dir, DEVICE_IDENTITY_FILE))).rejects.toBeDefined();
    await expect(fs.access(path.join(dir, 'secrets.bin'))).rejects.toBeDefined();
  });

  it('rejects a copied plaintext identity when this OS-protected store is bound to another identity', async () => {
    const originalDir = dir;
    const original = await loadOrCreateDeviceIdentity(originalDir, 'win32', { allowCreate: true, idFactory: () => ID_A, now: () => CREATED });
    const copied = await fs.readFile(path.join(originalDir, DEVICE_IDENTITY_FILE), 'utf8');

    const otherDir = await makeTempDir('clf-device-copy-');
    try {
      initSecretsPath(otherDir); resetSecretsCacheForTests();
      await loadOrCreateDeviceIdentity(otherDir, 'win32', { allowCreate: true, idFactory: () => ID_B, now: () => CREATED });
      await fs.writeFile(path.join(otherDir, DEVICE_IDENTITY_FILE), copied, 'utf8');
      resetSecretsCacheForTests();
      await expect(loadDeviceIdentity(otherDir, 'win32')).rejects.toSatisfy((error: unknown) => {
        expectProfileError(error, 'wrong_device');
        expect(String((error as Error).message)).toMatch(/does not match/i);
        return true;
      });
      expect(original.id).toBe(ID_A);
    } finally {
      await removeTempDir(otherDir);
      initSecretsPath(originalDir); resetSecretsCacheForTests();
    }
  });

  it('fails closed on wrong-platform, malformed JSON, and future identity schemas', async () => {
    const identity = await loadOrCreateDeviceIdentity(dir, 'win32', { allowCreate: true, idFactory: () => ID_A, now: () => CREATED });
    await expect(loadDeviceIdentity(dir, 'darwin')).rejects.toSatisfy((error: unknown) => {
      expectProfileError(error, 'wrong_platform'); return true;
    });

    await fs.writeFile(path.join(dir, DEVICE_IDENTITY_FILE), '{ definitely-not-json', 'utf8');
    await expect(loadDeviceIdentity(dir, 'win32')).rejects.toSatisfy((error: unknown) => {
      expectProfileError(error, 'malformed_profile');
      expect(error).not.toBeInstanceOf(SyntaxError);
      return true;
    });

    await fs.writeFile(path.join(dir, DEVICE_IDENTITY_FILE), JSON.stringify({ ...identity, schemaVersion: 2 }), 'utf8');
    await expect(loadDeviceIdentity(dir, 'win32')).rejects.toSatisfy((error: unknown) => {
      expectProfileError(error, 'unsupported_profile_version'); return true;
    });
  });

  it('requires the OS-protected binding in load-only mode', async () => {
    const identity = { schemaVersion: 1, id: ID_A, platform: 'win32', createdAt: CREATED.toISOString() };
    await fs.writeFile(path.join(dir, DEVICE_IDENTITY_FILE), JSON.stringify(identity), 'utf8');
    await expect(loadDeviceIdentity(dir, 'win32')).rejects.toSatisfy((error: unknown) => {
      expectProfileError(error, 'wrong_device');
      expect(String((error as Error).message)).toMatch(/no OS-protected binding/i);
      return true;
    });
  });

  it('fails closed when secure storage is unavailable or existing ciphertext cannot be decrypted', async () => {
    await loadOrCreateDeviceIdentity(dir, 'win32', { allowCreate: true, idFactory: () => ID_A, now: () => CREATED });
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);
    await expect(loadDeviceIdentity(dir, 'win32')).rejects.toSatisfy((error: unknown) => {
      expectProfileError(error, 'wrong_device');
      expect(String((error as Error).message)).toMatch(/cannot be verified|unavailable/i);
      return true;
    });

    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    vi.mocked(safeStorage.decryptStringAsync).mockRejectedValue(new Error('copied ciphertext cannot decrypt here'));
    resetSecretsCacheForTests();
    await expect(loadDeviceIdentity(dir, 'win32')).rejects.toSatisfy((error: unknown) => {
      expectProfileError(error, 'wrong_device');
      expect(String((error as Error).message)).toMatch(/cannot be verified|could not be decrypted/i);
      return true;
    });
  });

  it('recovers an interrupted explicitly-authorized migration from the exact protected binding', async () => {
    const identity = await loadOrCreateDeviceIdentity(dir, 'win32', { allowCreate: true, idFactory: () => ID_A, now: () => CREATED });
    await fs.rm(path.join(dir, DEVICE_IDENTITY_FILE));
    const recovered = await loadOrCreateDeviceIdentity(dir, 'win32', { allowCreate: true, idFactory: () => ID_B });
    expect(recovered).toEqual(identity);
    expect(JSON.parse(await fs.readFile(path.join(dir, DEVICE_IDENTITY_FILE), 'utf8'))).toEqual(identity);
  });
});

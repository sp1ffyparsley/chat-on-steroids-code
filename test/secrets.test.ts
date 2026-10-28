/**
 * OS-backed secret store semantics that matter for release safety.
 */

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

const {
  bridgeExtensionOriginSecretSlot,
  bridgeTokenSecretSlot,
  deleteAllSecrets,
  getSecret,
  getSecretStrict,
  getOrCreateMcpEndpointTokens,
  initSecretsPath,
  INSTANCE_DEVICE_BINDING_SECRET,
  isolatedInstanceSecretSlot,
  pluginCredentialSecretSlot,
  profileProviderSecretSlot,
  resetSecretsCacheForTests,
  seedIsolatedInstanceSecrets,
  secureStorageCiphertextIsProtected,
  secureStorageStatus,
  setSecret,
  validateIsolatedInstanceSecrets
} = await import('../src/main/secrets.js');
const { safeStorage } = await import('electron');
const { formatLogAsJson, getLog, logInfo } = await import('../src/main/logger.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await makeTempDir('clf-secrets-');
  initSecretsPath(dir);
  resetSecretsCacheForTests();
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('gnome_libsecret');
  vi.mocked(safeStorage.encryptStringAsync).mockImplementation(async (value) => Buffer.from(value, 'utf8'));
  vi.mocked(safeStorage.decryptStringAsync).mockImplementation(async (buffer) => ({
    result: buffer.toString('utf8'),
    shouldReEncrypt: false
  }));
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe('secret store', () => {
  it('seeds only one account and preserves that runtime’s existing pairing on reseed', async () => {
    const isolatedId = 'profile-Zeta';
    const siblingId = 'profile-Alpha';
    const runtimeRoot = path.join(dir, 'instances', isolatedId, 'runtime');
    const protectedKey = Buffer.concat([Buffer.from('DPAPI'), Buffer.alloc(32, 7)]).toString('base64');
    if (process.platform === 'win32') {
      await fs.writeFile(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: protectedKey } }));
    }
    await setSecret(INSTANCE_DEVICE_BINDING_SECRET, 'device-proof');
    await setSecret('setup:setup-Zeta', 'Zeta-key');
    await setSecret(isolatedInstanceSecretSlot(isolatedId, 'bridgeToken'), 'original-pairing');
    await setSecret(isolatedInstanceSecretSlot(siblingId, 'bridgeToken'), 'sibling-pairing');
    await seedIsolatedInstanceSecrets(runtimeRoot, isolatedId, 'setup-Zeta');

    if (process.platform === 'win32') {
      const state = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'Local State'), 'utf8')) as { os_crypt: { encrypted_key: string } };
      expect(state.os_crypt.encrypted_key).toBe(protectedKey);
    }

    initSecretsPath(runtimeRoot);
    resetSecretsCacheForTests();
    await expect(validateIsolatedInstanceSecrets(isolatedId, 'setup-Zeta')).resolves.toBeUndefined();
    expect(await getSecretStrict(INSTANCE_DEVICE_BINDING_SECRET)).toBe('device-proof');
    expect(await getSecretStrict('setup:setup-Zeta')).toBe('Zeta-key');
    expect(await getSecretStrict(isolatedInstanceSecretSlot(isolatedId, 'bridgeToken'))).toBe('original-pairing');
    expect(await getSecretStrict(isolatedInstanceSecretSlot(siblingId, 'bridgeToken'))).toBeNull();
    await setSecret(isolatedInstanceSecretSlot(isolatedId, 'bridgeToken'), 'runtime-pairing');

    initSecretsPath(dir);
    resetSecretsCacheForTests();
    await setSecret('setup:setup-Zeta', 'parent-later-change');
    await seedIsolatedInstanceSecrets(runtimeRoot, isolatedId, 'setup-Zeta');
    initSecretsPath(runtimeRoot);
    resetSecretsCacheForTests();
    expect(await getSecretStrict(isolatedInstanceSecretSlot(isolatedId, 'bridgeToken'))).toBe('runtime-pairing');
    expect(await getSecretStrict('setup:setup-Zeta')).toBe('Zeta-key');
    await setSecret(isolatedInstanceSecretSlot(siblingId, 'bridgeToken'), 'unexpected-sibling');
    await expect(validateIsolatedInstanceSecrets(isolatedId, 'setup-Zeta'))
      .rejects.toThrow(/outside its own namespace/);
    initSecretsPath(dir);
    resetSecretsCacheForTests();
    await expect(seedIsolatedInstanceSecrets(runtimeRoot, isolatedId, 'setup-Zeta'))
      .rejects.toThrow(/outside its account namespace/);
  });

  it.skipIf(process.platform !== 'win32')('refuses to overwrite an existing isolated Windows storage key', async () => {
    const runtimeRoot = path.join(dir, 'instances', 'profile-Zeta', 'runtime');
    const key = (byte: number) => Buffer.concat([Buffer.from('DPAPI'), Buffer.alloc(32, byte)]).toString('base64');
    await fs.writeFile(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: key(3) } }));
    await fs.mkdir(runtimeRoot, { recursive: true });
    await fs.writeFile(path.join(runtimeRoot, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: key(8) } }));
    await setSecret(INSTANCE_DEVICE_BINDING_SECRET, 'device-proof');
    await expect(seedIsolatedInstanceSecrets(runtimeRoot, 'profile-Zeta', 'setup-Zeta'))
      .rejects.toThrow(/different Windows protected storage key/);
    expect(JSON.parse(await fs.readFile(path.join(runtimeRoot, 'Local State'), 'utf8')).os_crypt.encrypted_key).toBe(key(8));
    await expect(fs.access(path.join(runtimeRoot, 'secrets.bin'))).rejects.toBeDefined();
  });

  it('leaves a child-owned encrypted store untouched when the parent key cannot decrypt it', async () => {
    const isolatedId = 'profile-Zeta';
    const runtimeRoot = path.join(dir, 'instances', isolatedId, 'runtime');
    if (process.platform === 'win32') {
      const protectedKey = Buffer.concat([Buffer.from('DPAPI'), Buffer.alloc(32, 7)]).toString('base64');
      await fs.writeFile(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: protectedKey } }));
    }
    await setSecret(INSTANCE_DEVICE_BINDING_SECRET, 'device-proof');
    await seedIsolatedInstanceSecrets(runtimeRoot, isolatedId, 'setup-Zeta');
    const target = path.join(runtimeRoot, 'secrets.bin');
    const before = await fs.readFile(target);
    vi.mocked(safeStorage.decryptStringAsync).mockRejectedValueOnce(new Error('different child key'));
    await expect(seedIsolatedInstanceSecrets(runtimeRoot, isolatedId, 'setup-Zeta')).resolves.toBeUndefined();
    expect(await fs.readFile(target)).toEqual(before);
  });

  it('refuses Linux v10 hard-coded-key ciphertext instead of trusting the legacy backend label', async () => {
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('basic_text');
    vi.mocked(safeStorage.encryptStringAsync).mockResolvedValueOnce(Buffer.from('v10fallback-ciphertext', 'ascii'));
    expect(await secureStorageStatus('linux')).toEqual({
      available: false,
      detail: expect.stringMatching(/hard-coded-key|fallback/i)
    });
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1);
  });

  it('accepts a secure async Linux provider even when the legacy backend label is basic_text', async () => {
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('basic_text');
    vi.mocked(safeStorage.encryptStringAsync).mockResolvedValueOnce(Buffer.from('v11protected-ciphertext', 'ascii'));

    expect(await secureStorageStatus('linux')).toEqual({ available: true, detail: null });
  });

  it('refuses the async Linux v10 fallback even when the selected backend label looks secure', async () => {
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('gnome_libsecret');
    vi.mocked(safeStorage.encryptStringAsync).mockResolvedValueOnce(Buffer.from('v10fallback-ciphertext', 'ascii'));

    expect(await secureStorageStatus('linux')).toEqual({
      available: false,
      detail: expect.stringMatching(/hard-coded-key|fallback/i)
    });
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1);
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith('chat-on-steroids-safe-storage-probe');
  });

  it('classifies only Linux v10 ciphertext as the insecure hard-coded-key provider', () => {
    const v10 = Buffer.from('v10ciphertext', 'ascii');
    const v11 = Buffer.from('v11ciphertext', 'ascii');
    expect(secureStorageCiphertextIsProtected(v10, 'linux')).toBe(false);
    expect(secureStorageCiphertextIsProtected(v11, 'linux')).toBe(true);
    // v10 is a platform-specific on-disk format distinction; do not reinterpret bytes from
    // DPAPI/Keychain hosts as Linux basic_text merely because their prefix happens to match.
    expect(secureStorageCiphertextIsProtected(v10, 'win32')).toBe(true);
    expect(secureStorageCiphertextIsProtected(v10, 'darwin')).toBe(true);
  });

  it('serializes concurrent writes so one credential cannot erase another', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-456'),
      setSecret('openaiApiKey', 'sk-openai-789')
    ]);

    expect(await getSecret('bridgeToken')).toBe('bridge-token-456');
    expect(await getSecret('openaiApiKey')).toBe('sk-openai-789');

    // Force a disk read, not the in-process cache.
    resetSecretsCacheForTests();
    expect(await getSecret('bridgeToken')).toBe('bridge-token-456');
    expect(await getSecret('openaiApiKey')).toBe('sk-openai-789');
    expect(await fs.stat(path.join(dir, 'secrets.bin'))).toBeTruthy();
  });

  it('removes pasted invisible characters only from every account-scoped API-key slot', async () => {
    const isolatedOpenRouter = profileProviderSecretSlot('isolated', 'profile-Alpha', 'openRouterApiKey');
    await setSecret('openRouterApiKey', '\u00ADsk-or-main\u0085 ');
    await setSecret('setup:profile-Zeta', '\u200Bsk-setup\uFEFF');
    await setSecret(isolatedOpenRouter, '\u202Fsk-or-isolated\u200D');
    await setSecret('bridgeToken', '\u00AD bridge token \u0085');

    expect(await getSecret('openRouterApiKey')).toBe('sk-or-main');
    expect(await getSecretStrict('setup:profile-Zeta')).toBe('sk-setup');
    expect(await getSecret(isolatedOpenRouter)).toBe('sk-or-isolated');
    expect(await getSecret('bridgeToken')).toBe('\u00AD bridge token \u0085');

    // A value written before this fix is healed on read without rewriting unrelated secrets.
    await fs.writeFile(path.join(dir, 'secrets.bin'), Buffer.from(JSON.stringify({
      openRouterApiKey: '\u00ADsk-or-legacy',
      bridgeToken: 'bridge-token'
    }), 'utf8'));
    resetSecretsCacheForTests();
    expect(await getSecret('openRouterApiKey')).toBe('sk-or-legacy');
    expect(await getSecret('bridgeToken')).toBe('bridge-token');
  });

  it('retries transient Windows sharing failures without publishing an unwritten secret', async () => {
    await setSecret('bridgeToken', 'old-token');
    const rename = fs.rename.bind(fs);
    let attempts = 0;
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      attempts += 1;
      if (attempts <= 2) {
        throw Object.assign(new Error('simulated Windows sharing violation'), {
          code: attempts === 1 ? 'EPERM' : 'EBUSY'
        });
      }
      return rename(...args);
    });
    try {
      await setSecret('bridgeToken', 'new-token');
      expect(attempts).toBe(3);
      resetSecretsCacheForTests();
      expect(await getSecret('bridgeToken')).toBe('new-token');
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('keeps legacy bridge-token ownership exact and separates deterministic isolated-profile slots', async () => {
    expect(bridgeTokenSecretSlot('legacy', 'ignored-legacy-id')).toBe('bridgeToken');
    expect(bridgeTokenSecretSlot('isolated', 'work-pc')).toBe('instance:work-pc:bridgeToken');
    expect(bridgeExtensionOriginSecretSlot('legacy', 'ignored-legacy-id')).toBe('bridgeExtensionOrigin');
    expect(bridgeExtensionOriginSecretSlot('isolated', 'work-pc')).toBe('instance:work-pc:bridgeExtensionOrigin');
    expect(isolatedInstanceSecretSlot('work-pc', 'future-local-key')).toBe('instance:work-pc:future-local-key');
    expect(isolatedInstanceSecretSlot('macbook', 'future-local-key')).toBe('instance:macbook:future-local-key');

    await setSecret(bridgeTokenSecretSlot('legacy', 'ignored-legacy-id'), 'legacy-token');
    await setSecret(bridgeTokenSecretSlot('isolated', 'work-pc'), 'isolated-token');
    expect(await getSecret('bridgeToken')).toBe('legacy-token');
    expect(await getSecret(bridgeTokenSecretSlot('isolated', 'work-pc'))).toBe('isolated-token');
  });

  it('keeps legacy provider/plugin slots exact and never falls back across isolated profiles', async () => {
    const legacyProvider = profileProviderSecretSlot('legacy', 'local-instance', 'openRouterApiKey');
    const providerA = profileProviderSecretSlot('isolated', 'profile-a', 'openRouterApiKey');
    const providerB = profileProviderSecretSlot('isolated', 'profile-b', 'openRouterApiKey');
    const legacyPlugin = pluginCredentialSecretSlot('legacy', 'local-instance', 'plugin-one', 'TEST_SECRET');
    const pluginA = pluginCredentialSecretSlot('isolated', 'profile-a', 'plugin-one', 'TEST_SECRET');
    const pluginB = pluginCredentialSecretSlot('isolated', 'profile-b', 'plugin-one', 'TEST_SECRET');

    expect(legacyProvider).toBe('openRouterApiKey');
    expect(legacyPlugin).toBe('plugin:plugin-one:TEST_SECRET');
    expect(providerA).toBe('instance:profile-a:openRouterApiKey');
    expect(pluginA).toBe('instance:profile-a:plugin:plugin-one:TEST_SECRET');

    await setSecret(legacyProvider, 'legacy-provider');
    await setSecret(legacyPlugin, 'legacy-plugin');
    expect(await getSecret(providerA)).toBeNull();
    expect(await getSecret(providerB)).toBeNull();
    expect(await getSecret(pluginA)).toBeNull();
    expect(await getSecret(pluginB)).toBeNull();

    await setSecret(providerA, 'provider-a');
    await setSecret(providerB, 'provider-b');
    await setSecret(pluginA, 'plugin-a');
    await setSecret(pluginB, 'plugin-b');
    expect(await getSecret(legacyProvider)).toBe('legacy-provider');
    expect(await getSecret(providerA)).toBe('provider-a');
    expect(await getSecret(providerB)).toBe('provider-b');
    expect(await getSecret(legacyPlugin)).toBe('legacy-plugin');
    expect(await getSecret(pluginA)).toBe('plugin-a');
    expect(await getSecret(pluginB)).toBe('plugin-b');
  });

  it('adds the device binding without renaming legacy keys or dropping unknown future fields', async () => {
    const file = path.join(dir, 'secrets.bin');
    await fs.writeFile(file, Buffer.from(JSON.stringify({
      bridgeToken: 'legacy-bridge',
      openaiApiKey: 'legacy-openai',
      futureSecretFromNewerBuild: 'keep-me'
    }), 'utf8'));
    resetSecretsCacheForTests();

    await setSecret(INSTANCE_DEVICE_BINDING_SECRET, '{"schemaVersion":1}');
    resetSecretsCacheForTests();
    expect(await getSecretStrict(INSTANCE_DEVICE_BINDING_SECRET)).toBe('{"schemaVersion":1}');
    expect(await getSecret('bridgeToken')).toBe('legacy-bridge');
    expect(await getSecret('openaiApiKey')).toBe('legacy-openai');

    const stored = JSON.parse((await fs.readFile(file)).toString('utf8')) as Record<string, string>;
    expect(stored.futureSecretFromNewerBuild).toBe('keep-me');
    expect(stored.bridgeToken).toBe('legacy-bridge');
    expect(stored.openaiApiKey).toBe('legacy-openai');
  });

  it('single-flights an async cache miss so a late read cannot publish stale credentials after a write', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-before-load-race'),
      setSecret('openaiApiKey', 'sk-before-load-race')
    ]);
    resetSecretsCacheForTests();

    let releaseDecrypt: () => void = () => {};
    let markDecryptStarted: () => void = () => {};
    const decryptStarted = new Promise<void>((resolve) => {
      markDecryptStarted = resolve;
    });
    const decryptGate = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async (buffer) => {
      markDecryptStarted();
      await decryptGate;
      return { result: buffer.toString('utf8'), shouldReEncrypt: false };
    });

    const read = getSecret('bridgeToken');
    await decryptStarted;
    const write = setSecret('openRouterApiKey', 'or-written-during-load');
    // Give the mutation a chance to reach readAll(). It must join the existing load instead of
    // starting a second decrypt of the same old ciphertext.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseDecrypt();

    expect(await read).toBe('bridge-before-load-race');
    await write;
    expect(safeStorage.decryptStringAsync).toHaveBeenCalledTimes(1);

    // A second mutation is the destructive edge of the old race: if the late read had replaced
    // cache with its stale snapshot, this write would silently drop openRouterApiKey.
    await setSecret('openaiApiKey', 'sk-after-load-race');
    resetSecretsCacheForTests();
    expect(await getSecret('bridgeToken')).toBe('bridge-before-load-race');
    expect(await getSecret('openaiApiKey')).toBe('sk-after-load-race');
    expect(await getSecret('openRouterApiKey')).toBe('or-written-during-load');
  });

  it('does not turn a transient unavailable keyring into an empty authoritative secret store', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-survives-keyring-lock'),
      setSecret('openaiApiKey', 'sk-survives-keyring-lock')
    ]);
    resetSecretsCacheForTests();

    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);
    vi.mocked(safeStorage.decryptStringAsync).mockClear();
    expect(await getSecret('bridgeToken')).toBeNull();
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
    await expect(setSecret('openRouterApiKey', 'must-not-overwrite')).rejects.toThrow(/credential storage is unavailable/i);

    // Unlocking the host store later in the same process must retry disk, not keep the
    // temporary empty view cached and risk overwriting the real encrypted blob on the next save.
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    expect(await getSecret('bridgeToken')).toBe('bridge-token-survives-keyring-lock');
    expect(await getSecret('openaiApiKey')).toBe('sk-survives-keyring-lock');
  });

  it('does not let an in-flight decrypt resurrect credentials after the encrypted store is deleted', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-before-delete-race'),
      setSecret('openaiApiKey', 'sk-before-delete-race')
    ]);
    resetSecretsCacheForTests();

    let releaseDecrypt: () => void = () => {};
    let markDecryptStarted: () => void = () => {};
    const decryptStarted = new Promise<void>((resolve) => {
      markDecryptStarted = resolve;
    });
    const decryptGate = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async (buffer) => {
      markDecryptStarted();
      await decryptGate;
      return { result: buffer.toString('utf8'), shouldReEncrypt: false };
    });

    const staleRead = getSecret('bridgeToken');
    await decryptStarted;
    await deleteAllSecrets();
    await expect(fs.access(path.join(dir, 'secrets.bin'))).rejects.toBeDefined();

    releaseDecrypt();
    expect(await staleRead).toBeNull();

    // The destructive edge: a later save must compose from the deleted empty store, not from
    // plaintext the old decrypt held before deletion, otherwise it silently recreates old keys.
    await setSecret('openRouterApiKey', 'or-after-delete-race');
    resetSecretsCacheForTests();
    expect(await getSecret('bridgeToken')).toBeNull();
    expect(await getSecret('openaiApiKey')).toBeNull();
    expect(await getSecret('openRouterApiKey')).toBe('or-after-delete-race');
  });

  it('does not overwrite secrets when storage disappears between availability check and decrypt', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-survives-decrypt-race'),
      setSecret('openaiApiKey', 'sk-survives-decrypt-race')
    ]);
    resetSecretsCacheForTests();

    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async () => {
      // Reproduce the host-only race: safeStorage was available when the read started,
      // then Keychain/Secret Service became unavailable before decryptString completed.
      vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);
      throw new Error('credential backend became unavailable');
    });
    await expect(setSecret('openRouterApiKey', 'must-not-replace-existing-blob')).rejects.toThrow(
      /credential storage is unavailable/i
    );

    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    expect(await getSecret('bridgeToken')).toBe('bridge-token-survives-decrypt-race');
    expect(await getSecret('openaiApiKey')).toBe('sk-survives-decrypt-race');
    expect(await getSecret('openRouterApiKey')).toBeNull();
  });

  it('treats any async decrypt rejection as non-authoritative even if availability still reports true', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-survives-ambiguous-decrypt-error'),
      setSecret('openaiApiKey', 'sk-survives-ambiguous-decrypt-error')
    ]);
    const file = path.join(dir, 'secrets.bin');
    const before = await fs.readFile(file);
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.decryptStringAsync).mockRejectedValue(new Error('provider temporarily unavailable'));

    // Electron 43.4 typings do not expose the docs' temporary-unavailability marker, so a
    // rejected decrypt must never be converted into an empty authoritative store solely because
    // isAsyncEncryptionAvailable() still says that the provider exists.
    expect(await getSecret('bridgeToken')).toBeNull();
    await expect(setSecret('openRouterApiKey', 'must-not-replace-ambiguous-blob')).rejects.toThrow(
      /credential storage is unavailable/i
    );
    expect(await fs.readFile(file)).toEqual(before);

    vi.mocked(safeStorage.decryptStringAsync).mockImplementation(async (buffer) => ({
      result: buffer.toString('utf8'),
      shouldReEncrypt: false
    }));
    expect(await getSecret('bridgeToken')).toBe('bridge-token-survives-ambiguous-decrypt-error');
    expect(await getSecret('openaiApiKey')).toBe('sk-survives-ambiguous-decrypt-error');
  });

  it('preserves ciphertext when decrypt succeeds but the stored secret map is malformed', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-before-malformed-store'),
      setSecret('openaiApiKey', 'sk-before-malformed-store')
    ]);
    const file = path.join(dir, 'secrets.bin');
    // The test safeStorage mock is identity encryption. This reproduces a decryptable payload
    // whose shape cannot be safely treated as a string secret map.
    await fs.writeFile(file, Buffer.from(JSON.stringify({ bridgeToken: 'still-there', openaiApiKey: 123 }), 'utf8'));
    resetSecretsCacheForTests();
    const before = await fs.readFile(file);

    expect(await getSecret('bridgeToken')).toBeNull();
    await expect(setSecret('openRouterApiKey', 'must-not-replace-malformed-blob')).rejects.toThrow(
      /credential storage is unavailable/i
    );
    expect(await fs.readFile(file)).toEqual(before);
  });

  it('re-encrypts a successfully decrypted blob when Electron reports key rotation', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-rotated'),
      setSecret('openaiApiKey', 'sk-rotated')
    ]);
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.encryptStringAsync).mockClear();
    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async (buffer) => ({
      result: buffer.toString('utf8'),
      shouldReEncrypt: true
    }));

    expect(await getSecret('bridgeToken')).toBe('bridge-token-rotated');
    // Linux proves the selected async provider is not Chromium's hard-coded-key fallback by
    // encrypting a harmless probe before each real write. Count the secret-blob reseal itself,
    // not platform-specific availability probes.
    const reseals = vi.mocked(safeStorage.encryptStringAsync).mock.calls
      .map(([value]) => value)
      .filter((value) => value !== 'chat-on-steroids-safe-storage-probe');
    expect(reseals).toHaveLength(1);
    expect(JSON.parse(reseals[0]!)).toEqual({
      bridgeToken: 'bridge-token-rotated',
      openaiApiKey: 'sk-rotated'
    });

    resetSecretsCacheForTests();
    expect(await getSecret('openaiApiKey')).toBe('sk-rotated');
  });

  it('keeps the old ciphertext and readable cache when key-rotation reseal is temporarily unavailable', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-before-failed-rotation'),
      setSecret('openaiApiKey', 'sk-before-failed-rotation')
    ]);
    const file = path.join(dir, 'secrets.bin');
    const before = await fs.readFile(file);
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.decryptStringAsync).mockImplementationOnce(async (buffer) => ({
      result: buffer.toString('utf8'),
      shouldReEncrypt: true
    }));
    let failNextSecretReseal = true;
    vi.mocked(safeStorage.encryptStringAsync).mockImplementation(async (value) => {
      // Linux performs this non-secret provider probe before the actual reseal. The failure
      // under test is the current key becoming unavailable for the credential blob itself.
      if (value === 'chat-on-steroids-safe-storage-probe') return Buffer.from(value, 'utf8');
      if (failNextSecretReseal) {
        failNextSecretReseal = false;
        throw new Error('new key temporarily unavailable');
      }
      return Buffer.from(value, 'utf8');
    });

    // The read already succeeded, so failed best-effort resealing must not hide the credential.
    expect(await getSecret('bridgeToken')).toBe('bridge-token-before-failed-rotation');
    expect(await fs.readFile(file)).toEqual(before);

    // A later read in the same process retries the pending rotation and keeps all fields.
    expect(await getSecret('openaiApiKey')).toBe('sk-before-failed-rotation');
    resetSecretsCacheForTests();
    expect(await getSecret('bridgeToken')).toBe('bridge-token-before-failed-rotation');
    expect(await getSecret('openaiApiKey')).toBe('sk-before-failed-rotation');
  });

  it('does not leak a credential through the diagnostics renderer/export path', () => {
    // There is no registry of live secrets to consult any more — an agent is the chat it
    // runs in, and nothing is minted for it — so the backstop is shape alone: a long opaque
    // run of token characters is masked wherever it appears.
    const secret = 'bridge-token-abcdefghijklmnopqrstuvwxyz012345';
    logInfo(`tunnel opened with ${secret} while bootstrapping`);

    const latest = getLog().at(-1)!;
    expect(latest.message).not.toContain(secret);
    expect(latest.message).toContain('***');
    expect(formatLogAsJson()).not.toContain(secret);
  });
});


describe('persistent exact-account MCP identity', () => {
  it('rotates only the exact account on a new route revision and rejects stale revision resurrection', async () => {
    await setSecret('openaiApiKey', 'existing-provider-key');
    const first = await getOrCreateMcpEndpointTokens('profile-business', 1);
    const other = await getOrCreateMcpEndpointTokens('profile-Epsilon', 1);
    expect(await getOrCreateMcpEndpointTokens('profile-business', 1)).toEqual(first);
    const replacement = await getOrCreateMcpEndpointTokens('profile-business', 2);
    expect(new Set([...Object.values(first), ...Object.values(replacement)]).size).toBe(6);
    await expect(getOrCreateMcpEndpointTokens('profile-business', 1)).rejects.toThrow(/stale/);
    resetSecretsCacheForTests();
    expect(await getOrCreateMcpEndpointTokens('profile-business', 2)).toEqual(replacement);
    expect(await getOrCreateMcpEndpointTokens('profile-Epsilon', 1)).toEqual(other);
    expect(await getSecretStrict('openaiApiKey')).toBe('existing-provider-key');
  });
  it('atomically coalesces concurrent minting, survives an encrypted store reload and keeps profiles/surfaces distinct', async () => {
    await setSecret('openaiApiKey', 'existing-provider-key');
    const first = await Promise.all(Array.from({ length: 12 }, () => getOrCreateMcpEndpointTokens('profile-business')));
    expect(first.every(tokens => JSON.stringify(tokens) === JSON.stringify(first[0]))).toBe(true);
    const second = await getOrCreateMcpEndpointTokens('profile-Epsilon');
    expect(new Set([...Object.values(first[0]!), ...Object.values(second)]).size).toBe(6);
    resetSecretsCacheForTests();
    expect(await getOrCreateMcpEndpointTokens('profile-business')).toEqual(first[0]);
    expect(await getOrCreateMcpEndpointTokens('profile-Epsilon')).toEqual(second);
    expect(await getSecretStrict('openaiApiKey')).toBe('existing-provider-key');
  });

  it('refuses corrupt or foreign stored identity without overwriting credentials or reminting paths', async () => {
    const key = isolatedInstanceSecretSlot('profile-business', 'mcpEndpointIdentity');
    for (const value of ['invalid-json', JSON.stringify({ version: 1, instanceId: 'profile-Epsilon', tokens: {} }),
      JSON.stringify({ version: 1, instanceId: 'profile-business', tokens: { core: 'a'.repeat(43), desktop: 'b'.repeat(43), plugins: 'a'.repeat(43) } })]) {
      await setSecret(key, value);
      const before = await fs.readFile(path.join(dir, 'secrets.bin'));
      await expect(getOrCreateMcpEndpointTokens('profile-business')).rejects.toThrow(/persistent MCP identity/);
      expect(await fs.readFile(path.join(dir, 'secrets.bin'))).toEqual(before);
    }
  });

  it('does not replace an unreadable existing credential store with a fresh MCP identity', async () => {
    await setSecret('openaiApiKey', 'existing-provider-key');
    const before = await fs.readFile(path.join(dir, 'secrets.bin'));
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.decryptStringAsync).mockRejectedValue(new Error('locked'));
    await expect(getOrCreateMcpEndpointTokens('profile-business')).rejects.toThrow(/credential storage/);
    expect(await fs.readFile(path.join(dir, 'secrets.bin'))).toEqual(before);
  });
});


it('reseals persistent MCP identity after an OS key rotation without deadlocking or changing its paths', async () => {
  const first = await getOrCreateMcpEndpointTokens('profile-business');
  resetSecretsCacheForTests();
  vi.mocked(safeStorage.decryptStringAsync).mockImplementation(async buffer => ({ result: buffer.toString('utf8'), shouldReEncrypt: true }));
  const encryptions = vi.mocked(safeStorage.encryptStringAsync).mock.calls.length;
  expect(await getOrCreateMcpEndpointTokens('profile-business')).toEqual(first);
  expect(vi.mocked(safeStorage.encryptStringAsync).mock.calls.length).toBe(encryptions + 1);
});

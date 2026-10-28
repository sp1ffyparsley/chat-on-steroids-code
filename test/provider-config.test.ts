import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig, initConfigPath, loadConfig, saveConfig } from '../src/main/config.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir = '';

beforeAll(async () => {
  dir = await makeTempDir('cos-provider-config-');
  initConfigPath(dir);
});

afterAll(async () => {
  await removeTempDir(dir);
});

describe('provider adapter feature gates', () => {
  it('ships Antigravity disabled and repairs legacy settings to the same dormant state', async () => {
    expect(defaultConfig().providerAdapters).toEqual({ antigravity: { enabled: false } });
    const legacy = defaultConfig();
    delete legacy.providerAdapters;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).providerAdapters).toEqual({ antigravity: { enabled: false } });
  });

  it('round-trips an explicit opt-in in an isolated config without starting any provider process', async () => {
    const config = defaultConfig();
    const saved = await saveConfig({
      ...config,
      providerAdapters: { antigravity: { enabled: true } }
    });
    expect(saved.providerAdapters).toEqual({ antigravity: { enabled: true } });
    expect((await loadConfig()).providerAdapters).toEqual({ antigravity: { enabled: true } });
  });
});

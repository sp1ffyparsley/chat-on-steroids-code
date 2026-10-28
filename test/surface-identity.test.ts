import { afterEach, describe, expect, it } from 'vitest';
import {
  configureSurfaceIdentity,
  resetSurfaceIdentityForTests,
  surfaceDefinition
} from '../src/main/mcp/surfaces.js';
import { newInstanceConnectorAlias, newInstanceConnectorBrand, projectConnectorNames } from '../src/shared/instance-profile.js';

afterEach(() => resetSurfaceIdentityForTests());

describe('instance connector identity', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('describes a new %s profile honestly without changing declarations or accumulating prefixes', platform => {
    const base = Object.fromEntries(['core', 'desktop', 'plugins'].map(id =>
      [id, { ...surfaceDefinition(id as 'core' | 'desktop' | 'plugins') }]));
    const id = 'profile-11111111-2222-4333-8444-555555555555';
    const alias = newInstanceConnectorAlias(id);
    const profile = { id, displayName: 'Gamma', platform, connector: {
      identity: `luna-forge-x7-${id}`, displayBrand: newInstanceConnectorBrand(alias, 'Gamma', platform),
      legacyNames: false
    } };
    const names = projectConnectorNames(profile);
    configureSurfaceIdentity(names, profile);
    const first = surfaceDefinition('core');
    expect(first.description).toContain(alias);
    expect(first.description).toContain('Gamma');
    expect(first.description).toContain(id);
    expect(first.description).toContain(platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'Mac' : 'Linux');
    expect(first.description).toContain(base.core!.description);
    expect(first.description).toContain('approved folders');
    for (const surface of ['core', 'desktop', 'plugins'] as const) {
      expect(surfaceDefinition(surface).serverName).toBe(names[surface].serverName);
      expect(surfaceDefinition(surface).tools).toEqual(base[surface]!.tools);
      expect(surfaceDefinition(surface).description).toContain(base[surface]!.description);
    }
    if (platform === 'win32') expect(first.description).toContain('browser and native desktop');
    else expect(first.description).toContain('separate Desktop connector');
    if (platform === 'darwin') expect(surfaceDefinition('desktop').description).toContain('macOS permission');
    if (platform === 'linux') expect(surfaceDefinition('desktop').description).toContain('native desktop control is unavailable');
    configureSurfaceIdentity(names, profile);
    expect(surfaceDefinition('core').description).toBe(first.description);
    // A human nickname edit is not a connector rename or a new provider description.
    configureSurfaceIdentity(names, { ...profile, displayName: 'A changed human nickname' });
    expect(surfaceDefinition('core').description).toBe(first.description);
    resetSurfaceIdentityForTests();
    for (const surface of ['core', 'desktop', 'plugins'] as const)
      expect(surfaceDefinition(surface).description).toBe(base[surface]!.description);
    // Existing non-alias accounts retain the original copy, not a newly invented prefix.
    configureSurfaceIdentity(names, { ...profile, connector: { identity: 'existing-saved-connector', legacyNames: false } });
    expect(surfaceDefinition('core').description).toBe(base.core!.description);
  });

  it('projects one validated identity through the existing surface definitions', () => {
    configureSurfaceIdentity({
      core: { serverName: 'chat-on-steroids-studio-core', connectorName: 'Chat On Steroids Studio Core' },
      desktop: { serverName: 'chat-on-steroids-studio-desktop', connectorName: 'Chat On Steroids Studio Desktop' },
      plugins: { serverName: 'chat-on-steroids-studio-plugins', connectorName: 'Chat On Steroids Studio Plugins' }
    });

    expect(surfaceDefinition('core')).toMatchObject({
      serverName: 'chat-on-steroids-studio-core',
      connectorName: 'Chat On Steroids Studio Core',
      required: true
    });
    expect(surfaceDefinition('desktop')).toMatchObject({
      serverName: 'chat-on-steroids-studio-desktop',
      connectorName: 'Chat On Steroids Studio Desktop',
      required: false
    });
    expect(surfaceDefinition('plugins')).toMatchObject({
      serverName: 'chat-on-steroids-studio-plugins',
      connectorName: 'Chat On Steroids Studio Plugins'
    });
  });

  it('rejects duplicate and malformed projected names without partially changing identity', () => {
    const before = { ...surfaceDefinition('core') };
    expect(() => configureSurfaceIdentity({
      core: { serverName: 'same', connectorName: 'Same' },
      desktop: { serverName: 'same', connectorName: 'Desktop' },
      plugins: { serverName: 'plugins', connectorName: 'Plugins' }
    })).toThrow(/duplicate MCP server name/i);
    expect(surfaceDefinition('core')).toMatchObject({
      serverName: before.serverName,
      connectorName: before.connectorName
    });

    expect(() => configureSurfaceIdentity({
      core: { serverName: 'not valid', connectorName: 'Core' },
      desktop: { serverName: 'desktop', connectorName: 'Desktop' },
      plugins: { serverName: 'plugins', connectorName: 'Plugins' }
    })).toThrow(/invalid core MCP server name/i);
  });
});

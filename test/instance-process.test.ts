import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertCanonicalAccountRouting, developmentBridgePortOverride, developmentUserDataOverride, isolatedProcessArgument, isolatedProcessSelection } from '../src/main/instance-process.js';
import type { InstanceProfile } from '../src/shared/instance-profile.js';

describe('isolated account process selection', () => {
  const root = path.resolve('account-runtime-fixture');

  it('selects only a validated account id and derives the path internally', () => {
    const argument = isolatedProcessArgument('profile-zeta');
    expect(isolatedProcessSelection(['app.exe', argument], root)).toEqual({
      instanceId: 'profile-zeta',
      canonicalRoot: root,
      runtimeRoot: path.join(root, 'instances', 'profile-zeta', 'runtime')
    });
  });

  it('refuses duplicate selectors and filesystem or legacy-account injection', () => {
    expect(isolatedProcessSelection(['app.exe'], root)).toBeNull();
    expect(() => isolatedProcessSelection(['app.exe', isolatedProcessArgument('profile-a'), isolatedProcessArgument('profile-b')], root))
      .toThrow(/Exactly one/);
    for (const id of ['local-instance', '../profile-zeta', 'profile-a\\..\\b', 'profile-']) {
      expect(() => isolatedProcessArgument(id)).toThrow(/Invalid/);
    }
    expect(() => isolatedProcessSelection(['app.exe', isolatedProcessArgument('profile-a')], 'relative-data'))
      .toThrow(/absolute/);
  });

  it('refuses a stale private Chrome binding or bridge port while allowing nickname changes', () => {
    const canonical = {
      id: 'profile-zeta', platform: 'win32', deviceId: 'device-a',
      state: { mode: 'isolated', root: 'C:\\account' }, bridge: { host: '127.0.0.1', port: 8768 },
      connector: { identity: 'Zeta-core' }, tunnelProfileRef: 'setup-Zeta',
      browser: { profileDirectory: 'Profile', family: 'chrome', electronPartition: 'Zeta' },
      namespaces: { sessions: 's', queue: 'q', logs: 'l', health: 'h' },
      accountLabel: 'Zeta'
    } as InstanceProfile;
    expect(() => assertCanonicalAccountRouting({ ...canonical, accountLabel: 'J' }, canonical)).not.toThrow();
    expect(() => assertCanonicalAccountRouting({ ...canonical, browser: { ...canonical.browser, profileDirectory: 'Profile 3' } }, canonical))
      .toThrow(/routing differs/);
    expect(() => assertCanonicalAccountRouting({ ...canonical, bridge: { ...canonical.bridge, port: 8765 } }, canonical))
      .toThrow(/routing differs/);
  });

  it('isolates unpackaged fast development without letting an environment variable redirect production', () => {
    const development = path.resolve('fast-development-runtime');
    expect(developmentUserDataOverride(false, development)).toBe(development);
    expect(developmentUserDataOverride(true, development)).toBeNull();
    expect(developmentUserDataOverride(false, undefined)).toBeNull();
    expect(() => developmentUserDataOverride(false, 'relative-development-runtime')).toThrow(/must be absolute/);
  });

  it('accepts one supported bridge port only for the same unpackaged isolated development runtime', () => {
    const development = path.resolve('fast-development-runtime');
    expect(developmentBridgePortOverride(false, development, '8796')).toBe(8796);
    expect(developmentBridgePortOverride(true, development, '8796')).toBeNull();
    expect(developmentBridgePortOverride(false, null, '8796')).toBeNull();
    expect(developmentBridgePortOverride(false, development, undefined)).toBeNull();
    expect(() => developmentBridgePortOverride(false, development, '8764')).toThrow(/supported bridge port/);
    expect(() => developmentBridgePortOverride(false, development, '8797')).toThrow(/supported bridge port/);
    expect(() => developmentBridgePortOverride(false, development, 'not-a-port')).toThrow(/supported bridge port/);
  });
});

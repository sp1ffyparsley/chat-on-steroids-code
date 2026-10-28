import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INSTANCE_PROFILE_SCHEMA_VERSION,
  InstanceProfileError,
  bindPortableInstanceProfile,
  deriveInstanceOwnerPaths,
  exportPortableInstanceProfile,
  localApprovedRoots,
  migrateLegacyInstanceRegistry,
  instanceConnectorAccountAlias,
  instanceProfileSchema,
  newInstanceConnectorAlias,
  newInstanceConnectorBrand,
  normalizedLocalPath,
  parseInstanceRegistry,
  pathMatchesPlatform,
  projectConnectorNames,
  reconcileActiveApprovedFolders,
  reconcileSharedApprovedFolders,
  resolveActiveInstance,
  resolveLogicalFolder,
  validateInstanceRegistry,
  type DestinationInstanceBinding,
  type InstanceProfile,
  type InstanceProfileErrorCode,
  type InstanceProfileRegistry,
  type InstanceRuntimeIdentity
} from '../src/shared/instance-profile.js';

const DEVICE_A = '11111111-2222-4333-8444-555555555555';
const DEVICE_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const winRuntime: InstanceRuntimeIdentity = {
  platform: 'win32',
  deviceId: DEVICE_A,
  userDataRoot: 'C:\\Users\\test\\AppData\\Roaming\\Chat On Steroids'
};

const macRuntime: InstanceRuntimeIdentity = {
  platform: 'darwin',
  deviceId: DEVICE_A,
  userDataRoot: '/Users/test/Library/Application Support/Chat On Steroids'
};

function expectCode(run: () => unknown, code: InstanceProfileErrorCode): void {
  try {
    run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(InstanceProfileError);
    expect((error as InstanceProfileError).code).toBe(code);
  }
}

function winProfile(id: string, suffix: string, overrides: Partial<InstanceProfile> = {}): InstanceProfile {
  const base: InstanceProfile = {
    schemaVersion: INSTANCE_PROFILE_SCHEMA_VERSION,
    id,
    displayName: `Profile ${suffix}`,
    platform: 'win32',
    deviceId: DEVICE_A,
    accountLabel: '',
    state: { mode: 'isolated', root: `C:\\Data\\instances\\${suffix}` },
    bridge: { host: '127.0.0.1', port: 9000 + suffix.charCodeAt(0) },
    connector: { identity: `CoS ${suffix}`, legacyNames: false },
    tunnelProfileRef: `tunnel-${suffix}`,
    browser: { profileId: `browser-${suffix}`, electronPartition: `partition-${suffix}` },
    namespaces: {
      sessions: `sessions-${suffix}`,
      queue: `queue-${suffix}`,
      logs: `logs-${suffix}`,
      health: `health-${suffix}`
    },
    approvedFolders: [],
    projects: []
  };
  return { ...base, ...overrides };
}

function registry(...profiles: InstanceProfile[]): InstanceProfileRegistry {
  return { schemaVersion: 1, activeInstanceId: profiles[0]!.id, profiles };
}

describe('legacy migration and reconciliation', () => {
  it('migrates Windows with exact legacy owner identities and an explicit tunnel profile reference', () => {
    const roots = [{ name: 'project', path: 'C:\\Work\\Project' }];
    const migrated = migrateLegacyInstanceRegistry(roots, winRuntime, { tunnelProfileRef: 'work-account' });
    const profile = migrated.profiles[0]!;

    expect(migrated.activeInstanceId).toBe('local-instance');
    expect(profile).toMatchObject({
      id: 'local-instance',
      displayName: 'Local Windows',
      platform: 'win32',
      deviceId: DEVICE_A,
      state: { mode: 'legacy', root: winRuntime.userDataRoot },
      bridge: { host: '127.0.0.1', port: 8765 },
      connector: { identity: 'chat-on-steroids', legacyNames: true },
      tunnelProfileRef: 'work-account',
      browser: { profileId: 'default', electronPartition: 'default' },
      namespaces: { sessions: 'legacy', queue: 'legacy', logs: 'legacy', health: 'legacy' }
    });
    expect(profile.id).not.toContain(DEVICE_A.slice(0, 8));
    expect(profile.approvedFolders).toEqual([{
      id: 'root-project',
      label: 'project',
      role: 'approved-root',
      bindings: [{
        platform: 'win32', deviceId: DEVICE_A, rootName: 'project',
        localPath: normalizedLocalPath(roots[0]!.path, 'win32')
      }]
    }]);
  });

  it('performs a pure macOS migration without using the Windows host path rules', () => {
    const roots = [{ name: 'project', path: '/Users/test/Projects/Alpha' }];
    const migrated = migrateLegacyInstanceRegistry(roots, macRuntime, { tunnelProfileRef: 'default' });
    expect(migrated.profiles[0]).toMatchObject({
      id: 'local-instance', displayName: 'Local Mac', platform: 'darwin',
      state: { mode: 'legacy', root: macRuntime.userDataRoot }
    });
    expect(migrated.profiles[0]!.approvedFolders[0]!.bindings[0]!.localPath).toBe('/Users/test/Projects/Alpha');
  });

  it('preserves logical IDs across rename/removal/re-add, retains projects, and gives new roots stable non-path IDs', () => {
    const originalRoots = [
      { name: 'project', path: 'C:\\Work\\Project' },
      { name: 'media', path: 'D:\\Media' }
    ];
    const migrated = migrateLegacyInstanceRegistry(originalRoots, winRuntime, { tunnelProfileRef: 'default' });
    const projectId = migrated.profiles[0]!.approvedFolders[0]!.id;
    const mediaId = migrated.profiles[0]!.approvedFolders[1]!.id;
    migrated.profiles[0]!.projects = [{ id: 'main-project', label: 'Main', folderIds: [projectId, mediaId] }];

    const currentRoots = [
      { name: 'repo', path: 'c:/work/project/' },
      { name: 'assets', path: 'E:\\Private\\Assets' }
    ];
    const reconciled = reconcileActiveApprovedFolders(migrated, currentRoots, winRuntime);
    const active = reconciled.profiles[0]!;
    const renamed = active.approvedFolders.find(folder => folder.id === projectId)!;
    const removed = active.approvedFolders.find(folder => folder.id === mediaId)!;
    const added = active.approvedFolders.find(folder => folder.label === 'assets')!;

    expect(renamed).toMatchObject({ id: projectId, label: 'repo' });
    expect(renamed.bindings[0]).toMatchObject({ rootName: 'repo' });
    expect(renamed.bindings[0]).not.toHaveProperty('bound');
    expect(removed.id).toBe(mediaId);
    expect(removed.bindings[0]).toMatchObject({ rootName: 'media', bound: false });
    expect(active.projects).toEqual([{ id: 'main-project', label: 'Main', folderIds: [projectId, mediaId] }]);
    expect(added.id).toBe('root-assets');
    expect(added.id).not.toMatch(/private|e:|assets\\/i);

    const repeated = reconcileActiveApprovedFolders(reconciled, currentRoots, winRuntime);
    expect(repeated).toEqual(reconciled);

    const rebound = reconcileActiveApprovedFolders(repeated, [
      ...currentRoots,
      { name: 'media-renamed', path: 'd:/media/' }
    ], winRuntime);
    expect(rebound.profiles[0]!.approvedFolders.find(folder => folder.id === mediaId)).toMatchObject({
      id: mediaId,
      label: 'media-renamed',
      bindings: [expect.objectContaining({ rootName: 'media-renamed' })]
    });
    expect(rebound.profiles[0]!.approvedFolders.find(folder => folder.id === mediaId)!.bindings[0]).not.toHaveProperty('bound');
  });

  it('falls back to root name after path identity changes without minting a new logical folder', () => {
    const migrated = migrateLegacyInstanceRegistry(
      [{ name: 'project', path: 'C:\\Work\\Old' }],
      winRuntime,
      { tunnelProfileRef: 'default' }
    );
    const id = migrated.profiles[0]!.approvedFolders[0]!.id;
    const moved = reconcileActiveApprovedFolders(
      migrated,
      [{ name: 'project', path: 'D:\\Work\\New' }],
      winRuntime
    );
    expect(moved.profiles[0]!.approvedFolders).toHaveLength(1);
    expect(moved.profiles[0]!.approvedFolders[0]).toMatchObject({ id, label: 'project' });
    expect(moved.profiles[0]!.approvedFolders[0]!.bindings[0]!.localPath).toBe('d:\\work\\new');
  });
});

describe('schema classification and platform safety', () => {
  it('classifies registry and nested profile future versions as unsupported, while malformed stays malformed', () => {
    const valid = migrateLegacyInstanceRegistry([], winRuntime, { tunnelProfileRef: 'default' });
    expectCode(() => parseInstanceRegistry({ ...valid, schemaVersion: 2 }), 'unsupported_profile_version');
    const nested = structuredClone(valid) as any;
    nested.profiles[0].schemaVersion = 2;
    expectCode(() => parseInstanceRegistry(nested), 'unsupported_profile_version');
    const missingRegistryVersion = structuredClone(valid) as any;
    delete missingRegistryVersion.schemaVersion;
    expectCode(() => parseInstanceRegistry(missingRegistryVersion), 'malformed_profile');
    const missingProfileVersion = structuredClone(valid) as any;
    delete missingProfileVersion.profiles[0].schemaVersion;
    expectCode(() => parseInstanceRegistry(missingProfileVersion), 'malformed_profile');
    const malformed = structuredClone(valid) as any;
    delete malformed.profiles[0].displayName;
    const before = JSON.stringify(malformed);
    expectCode(() => parseInstanceRegistry(malformed), 'malformed_profile');
    expect(JSON.stringify(malformed)).toBe(before);
  });

  it('rejects the wrong device and wrong platform without selecting another profile', () => {
    const migrated = migrateLegacyInstanceRegistry([], winRuntime, { tunnelProfileRef: 'default' });
    expectCode(() => resolveActiveInstance(migrated, { ...winRuntime, deviceId: DEVICE_B }, []), 'wrong_device');
    expectCode(() => resolveActiveInstance(migrated, { ...macRuntime, deviceId: DEVICE_A }, []), 'wrong_platform');
  });

  it('uses platform-native normalization and blocks isolated traversal outside instances', () => {
    expect(pathMatchesPlatform('C:\\Work\\Repo', 'win32')).toBe(true);
    expect(pathMatchesPlatform('/Users/test/Repo', 'win32')).toBe(false);
    expect(pathMatchesPlatform('/Users/test/Repo', 'darwin')).toBe(true);
    expect(pathMatchesPlatform('C:\\Work\\Repo', 'darwin')).toBe(false);
    expect(normalizedLocalPath('C:\\Work\\one\\..\\Repo\\', 'win32')).toBe('c:\\work\\repo');

    const escaped = winProfile('escape', 'escape', {
      state: { mode: 'isolated', root: 'C:\\Data\\instances\\escape\\..\\..\\outside' }
    });
    expectCode(() => resolveActiveInstance(registry(escaped), {
      ...winRuntime, userDataRoot: 'C:\\Data'
    }, []), 'path_platform_mismatch');

    const aliasedInside = winProfile('inside', 'inside', {
      state: { mode: 'isolated', root: 'C:\\Data\\instances\\temp\\..\\inside' }
    });
    expect(() => resolveActiveInstance(registry(aliasedInside), {
      ...winRuntime, userDataRoot: 'C:\\Data'
    }, [])).not.toThrow();
  });

  it('aliases the WSL redirector and distro without folding Linux suffix case', () => {
    const canonical = String.raw`\\wsl.localhost\ubuntu\home\You\Project`;
    expect(normalizedLocalPath(`${String.raw`\\WSL$\Ubuntu\home\You\Project`}\\`, 'win32')).toBe(canonical);
    expect(normalizedLocalPath(String.raw`\\wsl.localhost\uBuNtU\home\You\Project`, 'win32')).toBe(canonical);
    expect(normalizedLocalPath(String.raw`\\wsl.localhost\Ubuntu\home\You\project`, 'win32')).not.toBe(canonical);
    expect(normalizedLocalPath('C:\\Work\\Repo', 'win32')).toBe('c:\\work\\repo');
  });

  it('validates local binding paths using the binding platform', () => {
    const migrated = migrateLegacyInstanceRegistry([{ name: 'project', path: 'C:\\Work' }], winRuntime, { tunnelProfileRef: 'default' });
    const bad = structuredClone(migrated) as any;
    bad.profiles[0].approvedFolders[0].bindings[0].localPath = '/Users/test/Work';
    expectCode(() => parseInstanceRegistry(bad), 'path_platform_mismatch');
  });

  it('rejects duplicate logical folder/project identities and duplicate per-device bindings', () => {
    const base = migrateLegacyInstanceRegistry([{ name: 'project', path: 'C:\\Work' }], winRuntime, { tunnelProfileRef: 'default' });
    const duplicateFolder = structuredClone(base) as any;
    duplicateFolder.profiles[0].approvedFolders.push(structuredClone(duplicateFolder.profiles[0].approvedFolders[0]));
    expectCode(() => parseInstanceRegistry(duplicateFolder), 'mapping_binding_invalid');

    const duplicateBinding = structuredClone(base) as any;
    duplicateBinding.profiles[0].approvedFolders[0].bindings.push(structuredClone(duplicateBinding.profiles[0].approvedFolders[0].bindings[0]));
    expectCode(() => parseInstanceRegistry(duplicateBinding), 'mapping_binding_invalid');

    const duplicateProject = structuredClone(base) as any;
    duplicateProject.profiles[0].projects = [
      { id: 'project-one', label: 'One', folderIds: ['root-project'] },
      { id: 'project-one', label: 'Two', folderIds: ['root-project'] }
    ];
    expectCode(() => parseInstanceRegistry(duplicateProject), 'project_mapping_invalid');

    const duplicateProjectFolder = structuredClone(base) as any;
    duplicateProjectFolder.profiles[0].projects = [
      { id: 'project-one', label: 'One', folderIds: ['root-project', 'root-project'] }
    ];
    expectCode(() => parseInstanceRegistry(duplicateProjectFolder), 'project_mapping_invalid');
  });
});

describe('collision semantics and connector projections', () => {
  it('derives one harmless stable alias per new UUID and bounds account/platform names', () => {
    const firstId = 'profile-11111111-2222-4333-8444-555555555555';
    const secondId = 'profile-11111111-2222-4333-8444-666666666666';
    const alias = newInstanceConnectorAlias(firstId);
    expect(newInstanceConnectorAlias(firstId)).toBe(alias);
    expect(newInstanceConnectorAlias(secondId)).not.toBe(alias);
    expect(alias).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ [0-9a-f]{12}$/);
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const brand = newInstanceConnectorBrand(alias, 'x'.repeat(48), platform);
      const profile = { connector: { identity: `luna-forge-x7-${firstId}`, displayBrand: brand,
        legacyNames: false } };
      const names = projectConnectorNames(profile);
      const expectedPlatform = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'Mac' : 'Linux';
      expect(brand).toContain(alias);
      expect(brand.endsWith(expectedPlatform)).toBe(true);
      expect(new Set(Object.values(names).map(surface => surface.connectorName)).size).toBe(3);
      for (const surface of Object.values(names)) expect(surface.connectorName.length).toBeLessThanOrEqual(64);
      expect(instanceConnectorAccountAlias({ id: firstId, ...profile })).toBe(alias);
    }
    expect(() => newInstanceConnectorAlias('../not-a-profile')).toThrow();
    expect(() => newInstanceConnectorBrand('bad\nAlias', 'Gamma', 'darwin')).toThrow();
    expect(instanceConnectorAccountAlias({ id: 'old-profile', connector: { identity: 'luna-forge-x7-old-profile', legacyNames: false } })).toBeNull();
    expect(instanceConnectorAccountAlias({ id: firstId, connector: { identity: `luna-forge-x7-${firstId}`,
      displayBrand: 'Previously bound custom connector', legacyNames: false } })).toBeNull();
    const profile = winProfile(firstId, 'a', { connector: { identity: `luna-forge-x7-${firstId}`,
      displayBrand: newInstanceConnectorBrand(alias, 'Gamma', 'win32'), legacyNames: false } });
    expect(Object.keys(profile.connector).sort()).toEqual(['displayBrand', 'identity', 'legacyNames']);
    expect(instanceProfileSchema.shape.connector.parse(profile.connector)).toEqual(profile.connector);
    const portable = JSON.stringify(exportPortableInstanceProfile(profile));
    expect(portable).not.toContain(alias);
    expect(portable).not.toContain(profile.connector.identity);
    expect(portable).not.toContain(profile.connector.displayBrand);
  });

  it('changes only the visible legacy connector brand and preserves stable server names', () => {
    const legacy = migrateLegacyInstanceRegistry([], winRuntime, { tunnelProfileRef: 'default' }).profiles[0]!;
    expect(projectConnectorNames(legacy)).toEqual({
      core: { serverName: 'chat-on-steroids-core', connectorName: 'Luna Forge X7 Core' },
      desktop: { serverName: 'chat-on-steroids-desktop', connectorName: 'Luna Forge X7 Desktop' },
      plugins: { serverName: 'chat-on-steroids-plugins', connectorName: 'Luna Forge X7 Plugins' }
    });
    expect(projectConnectorNames(winProfile('work', 'w', { connector: { identity: 'Work Account', legacyNames: false } }))).toEqual({
      core: { serverName: 'work-account-core', connectorName: 'Work Account Core' },
      desktop: { serverName: 'work-account-desktop', connectorName: 'Work Account Desktop' },
      plugins: { serverName: 'work-account-plugins', connectorName: 'Work Account Plugins' }
    });
    expect(projectConnectorNames({ connector: { identity: 'chat-on-steroids', displayBrand: 'My Stable Label', legacyNames: true } })).toEqual({
      core: { serverName: 'chat-on-steroids-core', connectorName: 'My Stable Label Core' },
      desktop: { serverName: 'chat-on-steroids-desktop', connectorName: 'My Stable Label Desktop' },
      plugins: { serverName: 'chat-on-steroids-plugins', connectorName: 'My Stable Label Plugins' }
    });
  });

  it.each([
    ['instance_id_collision', (a: InstanceProfile, b: InstanceProfile) => { b.id = a.id; }],
    ['state_root_collision', (a: InstanceProfile, b: InstanceProfile) => { b.state.root = `${a.state.root}\\child\\..`; }],
    ['endpoint_collision', (a: InstanceProfile, b: InstanceProfile) => { b.bridge.port = a.bridge.port; }],
    ['tunnel_collision', (a: InstanceProfile, b: InstanceProfile) => { b.tunnelProfileRef = a.tunnelProfileRef; }],
    ['connector_collision', (a: InstanceProfile, b: InstanceProfile) => { b.connector.identity = a.connector.identity; }],
    ['browser_profile_collision', (a: InstanceProfile, b: InstanceProfile) => { b.browser.profileId = a.browser.profileId; }],
    ['electron_partition_collision', (a: InstanceProfile, b: InstanceProfile) => { b.browser.electronPartition = a.browser.electronPartition; }],
    ['namespace_collision', (a: InstanceProfile, b: InstanceProfile) => { b.namespaces.sessions = a.namespaces.sessions; }],
    ['namespace_collision', (a: InstanceProfile, b: InstanceProfile) => { b.namespaces.queue = a.namespaces.queue; }],
    ['namespace_collision', (a: InstanceProfile, b: InstanceProfile) => { b.namespaces.logs = a.namespaces.logs; }],
    ['namespace_collision', (a: InstanceProfile, b: InstanceProfile) => { b.namespaces.health = a.namespaces.health; }]
  ] as const)('rejects %s', (code, collide) => {
    const first = winProfile('first', 'a');
    const second = winProfile('second', 'b');
    collide(first, second);
    expectCode(() => validateInstanceRegistry(registry(first, second)), code);
  });

  it('rejects overlapping state roots, not only identical root strings', () => {
    const first = winProfile('first', 'a', { state: { mode: 'isolated', root: 'C:\\Data\\instances\\a' } });
    const second = winProfile('second', 'b', { state: { mode: 'isolated', root: 'C:\\Data\\instances\\a\\nested' } });
    expectCode(() => validateInstanceRegistry(registry(first, second)), 'state_root_collision');
  });

  it('scopes local owner collisions to one device while tunnel and connector identities remain global', () => {
    const first = winProfile('first', 'a', {
      state: { mode: 'isolated', root: 'C:\\Data\\instances\\shared' },
      bridge: { host: '127.0.0.1', port: 9100 },
      browser: { profileId: 'browser-a', profileDirectory: 'Profile 7', family: 'chrome', electronPartition: 'shared-partition' },
      namespaces: { sessions: 'shared-sessions', queue: 'shared-queue', logs: 'shared-logs', health: 'shared-health' }
    });
    const second = winProfile('second', 'b', {
      deviceId: DEVICE_B,
      state: { mode: 'isolated', root: 'C:\\Data\\instances\\shared' },
      bridge: { host: '127.0.0.1', port: 9100 },
      browser: { profileId: 'browser-b', profileDirectory: 'Profile 7', family: 'chrome', electronPartition: 'shared-partition' },
      namespaces: { sessions: 'shared-sessions', queue: 'shared-queue', logs: 'shared-logs', health: 'shared-health' }
    });

    expect(() => validateInstanceRegistry(registry(first, second))).not.toThrow();

    const sameDevice = structuredClone(second);
    sameDevice.deviceId = DEVICE_A;
    sameDevice.state.root = 'C:\\Data\\instances\\second';
    expectCode(() => validateInstanceRegistry(registry(first, sameDevice)), 'endpoint_collision');

    const sharedTunnel = structuredClone(second);
    sharedTunnel.tunnelProfileRef = first.tunnelProfileRef;
    expectCode(() => validateInstanceRegistry(registry(first, sharedTunnel)), 'tunnel_collision');

    const sharedConnector = structuredClone(second);
    sharedConnector.connector.identity = first.connector.identity;
    expectCode(() => validateInstanceRegistry(registry(first, sharedConnector)), 'connector_collision');
  });

  it('rejects path traversal in every runtime namespace and Electron partition identity', () => {
    const traversal = winProfile('traversal', 't') as any;
    traversal.namespaces.queue = '..\\outside';
    expectCode(() => parseInstanceRegistry(registry(traversal)), 'malformed_profile');

    const partition = winProfile('partition', 'p') as any;
    partition.browser.electronPartition = 'persist:outside';
    expectCode(() => parseInstanceRegistry(registry(partition)), 'malformed_profile');

    const direct = winProfile('direct', 'd') as any;
    direct.namespaces.logs = '../../outside';
    expectCode(() => deriveInstanceOwnerPaths(direct, {
      platform: 'win32', deviceId: DEVICE_A, userDataRoot: 'C:\\Data'
    }), 'malformed_profile');
  });

  it('detects projected legacy connector collisions even when raw identities differ', () => {
    const first = winProfile('first', 'a', { connector: { identity: 'first-raw', legacyNames: true } });
    const second = winProfile('second', 'b', { connector: { identity: 'second-raw', legacyNames: true } });
    expectCode(() => validateInstanceRegistry(registry(first, second)), 'connector_collision');
  });

  it('detects a non-legacy projection that collides with the legacy brand', () => {
    const first = winProfile('first', 'a', { connector: { identity: 'legacy-raw', legacyNames: true } });
    const second = winProfile('second', 'b', { connector: { identity: 'Chat On Steroids', legacyNames: false } });
    expectCode(() => validateInstanceRegistry(registry(first, second)), 'connector_collision');
  });
});

describe('portable export and destination binding', () => {
  function portableSource(): InstanceProfile {
    return {
      ...winProfile('private-instance', 'p', {
        state: { mode: 'isolated', root: 'C:\\PRIVATE\\instances\\p' },
        connector: { identity: 'private-connector', legacyNames: false },
        tunnelProfileRef: 'private-tunnel',
        browser: { profileId: 'private-browser', electronPartition: 'private-partition' },
        namespaces: { sessions: 'private-sessions', queue: 'private-queue', logs: 'private-logs', health: 'private-health' }
      }),
      approvedFolders: [{
        id: 'source', label: 'Source', role: 'code',
        bindings: [{ platform: 'win32', deviceId: DEVICE_A, rootName: 'source', localPath: 'C:\\PRIVATE\\Source' }]
      }],
      projects: [{ id: 'app', label: 'App', folderIds: ['source'] }]
    };
  }

  it('exports only logical allowlisted fields and leaks no local/device/runtime identity', () => {
    const source = portableSource();
    const exported = exportPortableInstanceProfile(source);
    expect(Object.keys(exported).sort()).toEqual(['accountLabel', 'displayName', 'folders', 'projects', 'schemaVersion']);
    expect(Object.keys(exported.folders[0]!).sort()).toEqual(['id', 'label', 'role']);
    expect(exported.projects).toEqual([{ id: 'app', label: 'App', folderIds: ['source'] }]);
    const serialized = JSON.stringify(exported);
    for (const forbidden of [
      source.id, DEVICE_A, 'C:\\PRIVATE', 'private-connector', 'private-tunnel', 'private-browser',
      'private-partition', 'private-sessions', 'private-queue', 'private-logs', 'private-health', 'rootName', 'localPath', 'deviceId'
    ]) expect(serialized, forbidden).not.toContain(forbidden);
    expect(exportPortableInstanceProfile(source)).toEqual(exported);
  });

  it('validates logical project semantics before export', () => {
    const source = portableSource();
    source.projects = [{ id: 'bad-project', label: 'Bad', folderIds: ['missing-folder'] }];
    expectCode(() => exportPortableInstanceProfile(source), 'project_mapping_invalid');
  });

  it('refuses absolute local paths disguised as portable logical labels', () => {
    const source = portableSource();
    source.approvedFolders[0]!.label = 'C:\\PRIVATE\\Source';
    expectCode(() => exportPortableInstanceProfile(source), 'path_platform_mismatch');

    const portable = exportPortableInstanceProfile(portableSource()) as any;
    portable.projects[0].label = '/Users/private/App';
    const destination: DestinationInstanceBinding = {
      id: 'destination', platform: 'win32', deviceId: DEVICE_B,
      stateRoot: 'D:\\CoS\\instances\\destination', bridgePort: 8877,
      connectorIdentity: 'Destination', tunnelProfileRef: 'destination-tunnel',
      browserProfileId: 'destination-browser', electronPartition: 'destination',
      namespaces: { sessions: 'd-sessions', queue: 'd-queue', logs: 'd-logs', health: 'd-health' },
      folderBindings: [{ logicalId: 'source', rootName: 'repo', localPath: 'D:\\Work\\Repo' }]
    };
    expectCode(() => bindPortableInstanceProfile(portable, destination), 'path_platform_mismatch');
  });

  it('requires exactly one explicit local binding per portable folder and carries validated localPath', () => {
    const portable = exportPortableInstanceProfile(portableSource());
    const destination: DestinationInstanceBinding = {
      id: 'destination',
      platform: 'win32', deviceId: DEVICE_B,
      stateRoot: 'D:\\CoS\\instances\\destination', bridgePort: 8877,
      connectorIdentity: 'Destination', tunnelProfileRef: 'destination-tunnel',
      browserProfileId: 'destination-browser', electronPartition: 'destination',
      namespaces: { sessions: 'd-sessions', queue: 'd-queue', logs: 'd-logs', health: 'd-health' },
      folderBindings: [{ logicalId: 'source', rootName: 'repo', localPath: 'D:\\Work\\Repo\\' }]
    };
    const bound = bindPortableInstanceProfile(portable, destination);
    // Portable binding explicitly supplies the destination identity. It is not native Add,
    // so it must not invent an alias or copy a source connector brand into that binding.
    expect(bound.connector).toEqual({ identity: destination.connectorIdentity, legacyNames: false });
    expect(instanceConnectorAccountAlias(bound)).toBeNull();
    expect(bound.id).toBe('destination');
    expect(bound.deviceId).toBe(DEVICE_B);
    expect(bound.approvedFolders[0]!.bindings).toEqual([{
      platform: 'win32', deviceId: DEVICE_B, rootName: 'repo', localPath: 'd:\\work\\repo'
    }]);

    expectCode(() => bindPortableInstanceProfile(portable, { ...destination, folderBindings: [] }), 'mapping_binding_required');
    expectCode(() => bindPortableInstanceProfile(portable, {
      ...destination,
      folderBindings: [...destination.folderBindings, ...destination.folderBindings]
    }), 'mapping_binding_invalid');
    expectCode(() => bindPortableInstanceProfile(portable, {
      ...destination,
      folderBindings: [...destination.folderBindings, { logicalId: 'unknown', rootName: 'x', localPath: 'D:\\X' }]
    }), 'mapping_binding_invalid');
    expectCode(() => bindPortableInstanceProfile(portable, {
      ...destination,
      folderBindings: [{ logicalId: 'source', rootName: 'repo', localPath: '/Users/test/Repo' }]
    }), 'path_platform_mismatch');
  });
});

describe('runtime logical mappings and owner paths', () => {
  it('shares only an explicitly enabled exact device-local root set, never a historical union', () => {
    const source = winProfile('alpha', 'a', { approvedFolders: [{
      id: 'source-code', label: 'Old alias', role: 'code',
      bindings: [{ platform: 'win32', deviceId: DEVICE_A, rootName: 'old', localPath: 'C:\\Work\\Code' }]
    }] });
    const peer = winProfile('beta', 'b', { approvedFolders: [{
      id: 'peer-removed', label: 'Removed',
      bindings: [{ platform: 'win32', deviceId: DEVICE_A, rootName: 'removed', localPath: 'D:\\Removed', bound: false }]
    }] });
    const isolated = registry(source, peer);
    expect(reconcileSharedApprovedFolders(isolated, winRuntime)).toEqual(isolated);
    const shared = reconcileSharedApprovedFolders({ ...isolated, sharedFolderAccess: {
      enabled: true, platform: 'win32', deviceId: DEVICE_A, revision: 1,
      roots: [{ name: 'code', path: 'c:/Work/Code/' }]
    } }, winRuntime);
    for (const profile of shared.profiles) {
      expect(localApprovedRoots(profile, winRuntime)).toEqual([{ name: 'code', path: 'c:\\work\\code' }]);
    }
    expect(shared.profiles[0]!.approvedFolders[0]!.id).toBe('source-code');
    expect(shared.profiles[1]!.approvedFolders.find(folder => folder.id === 'peer-removed')!.bindings[0]!.bound).toBe(false);
    const revoked = reconcileSharedApprovedFolders({ ...shared, sharedFolderAccess: {
      ...shared.sharedFolderAccess!, revision: 2, roots: []
    } }, winRuntime);
    expect(revoked.profiles.every(profile => localApprovedRoots(profile, winRuntime).length === 0)).toBe(true);
    expect(reconcileSharedApprovedFolders(revoked, winRuntime)).toEqual(revoked);
  });

  it('never projects Windows grants into another physical device or platform, and respects disabled sharing', () => {
    const local = winProfile('alpha', 'a');
    const foreign = winProfile('foreign', 'b', { deviceId: DEVICE_B });
    const input = { ...registry(local, foreign), sharedFolderAccess: {
      enabled: true, platform: 'win32' as const, deviceId: DEVICE_A, revision: 1,
      roots: [{ name: 'code', path: 'C:\\Work\\Code' }]
    } };
    const result = reconcileSharedApprovedFolders(input, winRuntime);
    expect(result.profiles[1]).toEqual(foreign);
    expect(reconcileSharedApprovedFolders(input, { ...winRuntime, deviceId: DEVICE_B })).toEqual(input);
    expect(reconcileSharedApprovedFolders(input, macRuntime)).toEqual(input);
    expect(reconcileSharedApprovedFolders({ ...input, sharedFolderAccess: { ...input.sharedFolderAccess, enabled: false } }, winRuntime).profiles).toEqual(input.profiles);
    expectCode(() => parseInstanceRegistry({ ...input, sharedFolderAccess: {
      ...input.sharedFolderAccess, roots: [{ name: 'bad', path: '/Users/test/Code' }]
    } }), 'path_platform_mismatch');
    expectCode(() => parseInstanceRegistry({ ...input, sharedFolderAccess: {
      ...input.sharedFolderAccess, roots: [{ name: 'a', path: 'C:\\Work' }, { name: 'b', path: 'c:/work/' }]
    } }), 'mapping_binding_invalid');
  });

  it('projects only the selected profile local roots and keeps sibling profile paths separate', () => {
    const alpha = winProfile('alpha', 'alpha', {
      approvedFolders: [{
        id: 'alpha-code', label: 'Alpha code', role: 'code',
        bindings: [{ platform: 'win32', deviceId: DEVICE_A, rootName: 'alpha', localPath: 'C:\\Work\\Alpha' }]
      }, {
        id: 'alpha-archive', label: 'Alpha archive', role: 'archive',
        bindings: [{ platform: 'win32', deviceId: DEVICE_A, rootName: 'archive', localPath: 'D:\\Archive\\Alpha', bound: false }]
      }]
    });
    const beta = winProfile('beta', 'beta', {
      approvedFolders: [{
        id: 'beta-code', label: 'Beta code', role: 'code',
        bindings: [{ platform: 'win32', deviceId: DEVICE_A, rootName: 'beta', localPath: 'C:\\Work\\Beta' }]
      }]
    });

    const alphaRoots = localApprovedRoots(alpha, { platform: 'win32', deviceId: DEVICE_A });
    const betaRoots = localApprovedRoots(beta, { platform: 'win32', deviceId: DEVICE_A });
    expect(alphaRoots).toEqual([{ name: 'alpha', path: 'C:\\Work\\Alpha' }]);
    expect(betaRoots).toEqual([{ name: 'beta', path: 'C:\\Work\\Beta' }]);
    expect(new Set([...alphaRoots, ...betaRoots].map(root => normalizedLocalPath(root.path, 'win32'))).size).toBe(2);
    expect(alphaRoots).not.toContainEqual(betaRoots[0]);
    expectCode(() => localApprovedRoots(alpha, { platform: 'win32', deviceId: DEVICE_B }), 'wrong_device');
  });

  it('permits intentionally unbound folders at startup but requires a binding when requested', () => {
    const migrated = migrateLegacyInstanceRegistry([
      { name: 'bound', path: 'C:\\Work\\Bound' },
      { name: 'optional', path: 'D:\\Optional' }
    ], winRuntime, { tunnelProfileRef: 'default' });
    const reconciled = reconcileActiveApprovedFolders(migrated, [{ name: 'bound', path: 'C:\\Work\\Bound' }], winRuntime);
    const runtime = resolveActiveInstance(reconciled, winRuntime, [{ name: 'bound', path: 'C:\\Work\\Bound' }]);
    const [bound, optional] = reconciled.profiles[0]!.approvedFolders;
    expect(resolveLogicalFolder(runtime, bound!.id)).toEqual({ name: 'bound', path: 'C:\\Work\\Bound' });
    expectCode(() => resolveLogicalFolder(runtime, optional!.id), 'mapping_binding_required');
  });

  it('fails stale, missing, duplicate, and platform-mismatched active bindings', () => {
    const migrated = migrateLegacyInstanceRegistry([{ name: 'project', path: 'C:\\Work\\Project' }], winRuntime, { tunnelProfileRef: 'default' });
    const stale = structuredClone(migrated);
    stale.profiles[0]!.approvedFolders[0]!.bindings[0]!.localPath = 'C:\\Other';
    expectCode(() => resolveActiveInstance(stale, winRuntime, [{ name: 'project', path: 'C:\\Work\\Project' }]), 'mapping_binding_invalid');

    expectCode(() => resolveActiveInstance(migrated, winRuntime, []), 'mapping_root_missing');
    expectCode(() => resolveActiveInstance(migrated, winRuntime, [
      { name: 'project', path: 'C:\\Work\\Project' },
      { name: 'project2', path: 'c:/work/project/' }
    ]), 'mapping_binding_invalid');

    const wrongPlatform = structuredClone(migrated) as any;
    wrongPlatform.profiles[0].approvedFolders[0].bindings[0].platform = 'darwin';
    wrongPlatform.profiles[0].approvedFolders[0].bindings[0].localPath = '/Users/test/Project';
    expectCode(() => resolveActiveInstance(wrongPlatform, winRuntime, [{ name: 'project', path: 'C:\\Work\\Project' }]), 'mapping_binding_invalid');

    const duplicateLogicalClaim = structuredClone(migrated) as any;
    duplicateLogicalClaim.profiles[0].approvedFolders.push({
      id: 'second-logical', label: 'Second', role: 'approved-root',
      bindings: [{ platform: 'win32', deviceId: DEVICE_A, rootName: 'project', localPath: 'C:\\Work\\Project' }]
    });
    expectCode(() => resolveActiveInstance(duplicateLogicalClaim, winRuntime, [{ name: 'project', path: 'C:\\Work\\Project' }]), 'mapping_binding_invalid');
  });

  it('derives legacy owners at existing paths and isolated owners below the selected state root', () => {
    const legacy = migrateLegacyInstanceRegistry([], winRuntime, { tunnelProfileRef: 'default' }).profiles[0]!;
    expect(deriveInstanceOwnerPaths(legacy, winRuntime)).toEqual({
      stateRoot: winRuntime.userDataRoot,
      sessionStoreRoot: winRuntime.userDataRoot,
      durableStoreRoot: winRuntime.userDataRoot,
      logFile: path.win32.join(winRuntime.userDataRoot, 'app.log'),
      healthRoot: path.win32.join(winRuntime.userDataRoot, 'state'),
      electronPartition: null
    });

    const isolated = winProfile('isolated', 'isolated', {
      state: { mode: 'isolated', root: 'C:\\Data\\instances\\isolated' },
      browser: { profileId: 'browser-isolated', electronPartition: 'isolated' }
    });
    expect(deriveInstanceOwnerPaths(isolated, { platform: 'win32', deviceId: DEVICE_A, userDataRoot: 'C:\\Data' })).toEqual({
      stateRoot: 'C:\\Data\\instances\\isolated',
      sessionStoreRoot: 'C:\\Data\\instances\\isolated\\namespaces\\sessions\\sessions-isolated',
      durableStoreRoot: 'C:\\Data\\instances\\isolated\\namespaces\\queue\\queue-isolated',
      logFile: 'C:\\Data\\instances\\isolated\\namespaces\\logs\\logs-isolated\\app.log',
      healthRoot: 'C:\\Data\\instances\\isolated\\namespaces\\health\\health-isolated',
      electronPartition: 'persist:isolated'
    });

    expectCode(() => deriveInstanceOwnerPaths(isolated, {
      platform: 'win32', deviceId: DEVICE_B, userDataRoot: 'C:\\Data'
    }), 'wrong_device');
    expectCode(() => deriveInstanceOwnerPaths(isolated, {
      platform: 'darwin', deviceId: DEVICE_A, userDataRoot: '/Users/test/Library/Application Support/Chat On Steroids'
    }), 'wrong_platform');
  });

  it('keeps two isolated profiles in disjoint owner trees with no cross-profile path or partition leakage', () => {
    const alpha = winProfile('alpha', 'alpha', {
      state: { mode: 'isolated', root: 'C:\\Data\\instances\\alpha' },
      browser: { profileId: 'browser-alpha', profileDirectory: 'Profile 2', family: 'chrome', electronPartition: 'partition-alpha' }
    });
    const beta = winProfile('beta', 'beta', {
      state: { mode: 'isolated', root: 'C:\\Data\\instances\\beta' },
      browser: { profileId: 'browser-beta', profileDirectory: 'Profile 3', family: 'chrome', electronPartition: 'partition-beta' }
    });
    expect(() => validateInstanceRegistry(registry(alpha, beta))).not.toThrow();

    const runtime = { platform: 'win32' as const, deviceId: DEVICE_A, userDataRoot: 'C:\\Data' };
    const alphaOwners = deriveInstanceOwnerPaths(alpha, runtime);
    const betaOwners = deriveInstanceOwnerPaths(beta, runtime);
    const pathKeys = ['stateRoot', 'sessionStoreRoot', 'durableStoreRoot', 'logFile', 'healthRoot'] as const;

    for (const key of pathKeys) {
      expect(alphaOwners[key].toLowerCase().startsWith(alpha.state.root.toLowerCase())).toBe(true);
      expect(betaOwners[key].toLowerCase().startsWith(beta.state.root.toLowerCase())).toBe(true);
      expect(alphaOwners[key].toLowerCase()).not.toContain(beta.state.root.toLowerCase());
      expect(betaOwners[key].toLowerCase()).not.toContain(alpha.state.root.toLowerCase());
      expect(alphaOwners[key]).not.toBe(betaOwners[key]);
    }
    expect(alphaOwners.electronPartition).toBe('persist:partition-alpha');
    expect(betaOwners.electronPartition).toBe('persist:partition-beta');
    expect(alphaOwners.electronPartition).not.toBe(betaOwners.electronPartition);
  });
});

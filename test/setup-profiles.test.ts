import { describe, expect, it } from 'vitest';
import { activateSetupProfile, addInactiveSetupProfile, setSetupCoreTunnel, switchSetupProfile } from '../src/main/setup-profiles.js';
import type { Config } from '../src/shared/types.js';
import type { InstanceProfile } from '../src/shared/instance-profile.js';

function profile(id: string, tunnelProfileRef: string): InstanceProfile {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    platform: 'win32',
    deviceId: '11111111-1111-4111-8111-111111111111',
    accountLabel: '',
    state: { mode: 'legacy', root: 'C:\\Users\\example\\AppData\\Roaming\\cos' },
    bridge: { host: '127.0.0.1', port: id === 'local' ? 8765 : 8766 },
    connector: { identity: id, legacyNames: id === 'local' },
    tunnelProfileRef,
    browser: { profileId: id, electronPartition: id === 'local' ? 'default' : id },
    namespaces: { sessions: `${id}-sessions`, queue: `${id}-queue`, logs: `${id}-logs`, health: `${id}-health` },
    approvedFolders: [],
    projects: []
  };
}

function fixture(): Config {
  return {
    roots: [], capabilities: {} as Config['capabilities'], readOnly: false,
    tunnel: { kind: 'openai', profileId: 'default', profileName: 'Default', profileEpoch: 0, tunnelId: 'core-a', desktopTunnelId: 'desktop-a', pluginsTunnelId: 'plugins-a', binaryPath: '' },
    setupProfiles: [{ id: 'work', name: 'Work', tunnelId: 'core-b', desktopTunnelId: 'desktop-b', pluginsTunnelId: 'plugins-b' }],
    ui: {} as Config['ui'], sessions: {} as Config['sessions'], compaction: {} as Config['compaction'],
    multiAgent: {} as Config['multiAgent'], artifacts: {} as Config['artifacts'], goal: {} as Config['goal'], mcp: {} as Config['mcp'],
    instances: { schemaVersion: 1, activeInstanceId: 'local', profiles: [profile('local', 'default'), profile('other', 'other')] }
  };
}

describe('setup profile instance binding', () => {
  it('edits an inactive account tunnel without switching the live account', () => {
    const before = fixture();
    const next = setSetupCoreTunnel(before, 'work', 'new-core-tunnel');
    expect(next.tunnel).toEqual(before.tunnel);
    expect(next.instances).toEqual(before.instances);
    expect(next.setupProfiles?.find(row => row.id === 'work')?.tunnelId).toBe('new-core-tunnel');
    expect(before.setupProfiles?.find(row => row.id === 'work')?.tunnelId).toBe('core-b');
  });

  it('edits the active account tunnel without moving sibling setup identities', () => {
    const before = fixture();
    const next = setSetupCoreTunnel(before, 'default', 'new-core-tunnel');
    expect(next.tunnel.tunnelId).toBe('new-core-tunnel');
    expect(next.tunnel.profileEpoch).toBe(1);
    expect(next.setupProfiles).toEqual(before.setupProfiles);
    expect(() => setSetupCoreTunnel(before, 'missing', 'tunnel')).toThrow('Setup profile not found');
  });
  it('adds an inactive setup namespace without changing the active tunnel or profile bindings', () => {
    const before = fixture();
    const added = addInactiveSetupProfile(before, 'Second account', 'second-setup');

    expect(added.tunnel).toEqual(before.tunnel);
    expect(added.instances).toEqual(before.instances);
    expect(added.setupProfiles).toEqual([
      ...before.setupProfiles!,
      { id: 'second-setup', name: 'Second account', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '' }
    ]);
  });

  it('can stage a target setup snapshot without rebinding either instance', () => {
    const staged = activateSetupProfile(fixture(), 'work');

    expect(staged.tunnel).toMatchObject({
      profileId: 'work', profileName: 'Work', profileEpoch: 1,
      tunnelId: 'core-b', desktopTunnelId: 'desktop-b', pluginsTunnelId: 'plugins-b'
    });
    expect(staged.instances?.profiles.find(row => row.id === 'local')?.tunnelProfileRef).toBe('default');
    expect(staged.instances?.profiles.find(row => row.id === 'other')?.tunnelProfileRef).toBe('other');
    expect(staged.setupProfiles).toContainEqual({
      id: 'default', name: 'Default', tunnelId: 'core-a', desktopTunnelId: 'desktop-a', pluginsTunnelId: 'plugins-a'
    });
    expect(staged.setupProfiles?.some(row => row.id === 'work')).toBe(false);
  });

  it('updates the active instance tunnel reference in the same switch commit', () => {
    const switched = switchSetupProfile(fixture(), 'work');
    expect(switched.tunnel).toMatchObject({ profileId: 'work', profileName: 'Work', tunnelId: 'core-b', profileEpoch: 1 });
    expect(switched.instances?.profiles.find(row => row.id === 'local')?.tunnelProfileRef).toBe('work');
    expect(switched.instances?.profiles.find(row => row.id === 'other')?.tunnelProfileRef).toBe('other');
  });

  it('repairs the active instance reference even when the requested setup is already selected', () => {
    const config = fixture();
    config.instances!.profiles[0]!.tunnelProfileRef = 'stale';
    const repaired = switchSetupProfile(config, 'default');
    expect(repaired.instances?.profiles[0]?.tunnelProfileRef).toBe('default');
  });
});

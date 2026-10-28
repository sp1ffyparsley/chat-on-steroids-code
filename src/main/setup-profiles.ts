import { randomUUID } from 'node:crypto';
import type { Config } from '../shared/types.js';

/** The active instance and the active tunnel/setup identity change in one config commit. */
function bindActiveInstanceToSetup(config: Config, setupId: string): Config {
  if (!config.instances) return config;
  return {
    ...config,
    instances: {
      ...config.instances,
      profiles: config.instances.profiles.map(profile => profile.id === config.instances!.activeInstanceId
        ? { ...profile, tunnelProfileRef: setupId }
        : profile)
    }
  };
}

/** Config commits the active identity and its IDs together; no copied active credential. */
export function activateSetupProfile(config: Config, id: string): Config {
  const currentId = config.tunnel.profileId ?? 'default';
  if (id === currentId) return config;
  const target = config.setupProfiles?.find(profile => profile.id === id);
  if (!target) throw new Error('Setup profile not found');
  const previous = {
    id: currentId, name: config.tunnel.profileName ?? 'Default',
    tunnelId: config.tunnel.tunnelId, desktopTunnelId: config.tunnel.desktopTunnelId,
    pluginsTunnelId: config.tunnel.pluginsTunnelId ?? ''
  };
  return {
    ...config,
    tunnel: { ...config.tunnel, profileId: target.id, profileName: target.name,
      profileEpoch: (config.tunnel.profileEpoch ?? 0) + 1,
      tunnelId: target.tunnelId, desktopTunnelId: target.desktopTunnelId, pluginsTunnelId: target.pluginsTunnelId },
    setupProfiles: [...(config.setupProfiles ?? []).filter(profile => profile.id !== id), previous]
  };
}

/** Config commits the active instance binding when the user changes only its setup identity. */
export function switchSetupProfile(config: Config, id: string): Config {
  return bindActiveInstanceToSetup(activateSetupProfile(config, id), id);
}

/** Creates a setup/tunnel namespace without changing the process' currently active identity. */
export function addInactiveSetupProfile(config: Config, name: string, id: string = randomUUID()): Config {
  if ((config.setupProfiles?.length ?? 0) >= 31) throw new Error('Setup profile limit reached');
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new Error('Enter a profile name (1–80 characters)');
  if ((config.tunnel.profileId ?? 'default') === id || config.setupProfiles?.some(profile => profile.id === id)) {
    throw new Error('Setup profile id is already in use');
  }
  return {
    ...config,
    setupProfiles: [...(config.setupProfiles ?? []),
      { id, name: trimmed, tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '' }]
  };
}

export function addSetupProfile(config: Config, name: string): Config {
  const id = randomUUID();
  return switchSetupProfile(addInactiveSetupProfile(config, name, id), id);
}

/** Edit one account's Core tunnel without activating that account or moving its credential. */
export function setSetupCoreTunnel(config: Config, id: string, tunnelId: string): Config {
  const activeId = config.tunnel.profileId ?? 'default';
  if (id === activeId) {
    return { ...config, tunnel: { ...config.tunnel, tunnelId,
      profileEpoch: (config.tunnel.profileEpoch ?? 0) + 1 } };
  }
  if (!config.setupProfiles?.some(profile => profile.id === id)) throw new Error('Setup profile not found');
  return { ...config, setupProfiles: config.setupProfiles.map(profile => profile.id === id
    ? { ...profile, tunnelId } : profile) };
}

/** Removing the active setup selects a surviving setup in the same config commit. */
export function removeSetupProfile(config: Config, id: string): Config {
  const currentId = config.tunnel.profileId ?? 'default';
  if (id !== currentId && !config.setupProfiles?.some(profile => profile.id === id)) {
    throw new Error('Setup profile not found');
  }
  if (!config.setupProfiles?.length) throw new Error('Keep at least one setup profile');
  const next = id === currentId ? switchSetupProfile(config, config.setupProfiles[0]!.id) : config;
  return { ...next, tunnel: { ...next.tunnel, profileEpoch: (config.tunnel.profileEpoch ?? 0) + 1 },
    setupProfiles: next.setupProfiles?.filter(profile => profile.id !== id) };
}

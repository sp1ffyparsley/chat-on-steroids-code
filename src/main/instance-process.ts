import path from 'node:path';
import type { InstanceProfile } from '../shared/instance-profile.js';

const ARG_PREFIX = '--cos-instance-runtime=';
const INSTANCE_ID = /^profile-[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const DEV_BRIDGE_PORT_MIN = 8765;
const DEV_BRIDGE_PORT_MAX = 8796;

export interface IsolatedProcessSelection {
  instanceId: string;
  canonicalRoot: string;
  runtimeRoot: string;
}

/**
 * Unpackaged development may use a stable, explicitly supplied app-data root.
 *
 * Electron's singleton lock and every local store are scoped to `userData`. Running the Vite
 * process against the installed app's ordinary root either exits immediately or, worse, shares
 * live account state. The fast development launcher supplies a private absolute directory; a
 * packaged binary ignores the variable so an inherited shell environment cannot redirect a
 * production account.
 */
export function developmentUserDataOverride(packaged: boolean, value: string | undefined): string | null {
  if (packaged || !value) return null;
  if (!path.isAbsolute(value)) throw new Error('Development application data root must be absolute.');
  return path.resolve(value);
}

/**
 * Fast development may choose one of the companion's already-supported loopback slots so it can
 * run beside installed accounts. The override is accepted only when this process already proved
 * it owns an unpackaged isolated development root; production never inherits this route change.
 */
export function developmentBridgePortOverride(
  packaged: boolean,
  developmentRoot: string | null,
  value: string | undefined
): number | null {
  if (packaged || !developmentRoot || value === undefined) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < DEV_BRIDGE_PORT_MIN || port > DEV_BRIDGE_PORT_MAX) {
    throw new Error(`Development bridge port must be a supported bridge port (${DEV_BRIDGE_PORT_MIN}–${DEV_BRIDGE_PORT_MAX}).`);
  }
  return port;
}

/** A process may own exactly one isolated account; argv never supplies filesystem paths. */
export function isolatedProcessSelection(argv: readonly string[], canonicalRoot: string): IsolatedProcessSelection | null {
  const requests = argv.filter(argument => argument.startsWith(ARG_PREFIX));
  if (requests.length === 0) return null;
  if (requests.length !== 1) throw new Error('Exactly one isolated account runtime may be selected.');
  const instanceId = requests[0]!.slice(ARG_PREFIX.length);
  if (!INSTANCE_ID.test(instanceId)) throw new Error('Invalid isolated account runtime id.');
  if (!path.isAbsolute(canonicalRoot)) throw new Error('Application data root must be absolute.');
  const root = path.resolve(canonicalRoot);
  return { instanceId, canonicalRoot: root, runtimeRoot: path.join(root, 'instances', instanceId, 'runtime') };
}

export function isolatedProcessArgument(instanceId: string): string {
  if (!INSTANCE_ID.test(instanceId)) throw new Error('Invalid isolated account runtime id.');
  return `${ARG_PREFIX}${instanceId}`;
}

/** A private config may retain account preferences, but cannot change its parent-owned route. */
export function assertCanonicalAccountRouting(actual: InstanceProfile, expected: InstanceProfile): void {
  const route = (profile: InstanceProfile): unknown[] => [
    profile.id, profile.platform, profile.deviceId,
    profile.state.mode, profile.state.root,
    profile.bridge.host, profile.bridge.port,
    profile.connector.identity, profile.tunnelProfileRef,
    profile.browser.profileDirectory, profile.browser.family, profile.browser.electronPartition,
    profile.namespaces.sessions, profile.namespaces.queue, profile.namespaces.logs, profile.namespaces.health
  ];
  if (JSON.stringify(route(actual)) !== JSON.stringify(route(expected))) {
    throw new Error('Isolated account routing differs from the primary profile registry; no account runtime was started.');
  }
}

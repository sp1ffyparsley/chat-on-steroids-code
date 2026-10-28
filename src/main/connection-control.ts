/** Exact active-account connection controls shared by local operators and agent settings. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { manualPublicOriginSchema, manualPortSchema, persistentMcpPort } from '../shared/external-tunnel.js';
import { assertActiveSecureTunnelIsolation, getActiveInstanceRuntime, getConfig, updateConfig } from './config.js';
import { applySettings, connect, disconnect, getStatus } from './connection.js';
import { profileWorkAdmission } from './work-admission.js';
import { logInfo, logWarn } from './logger.js';

export const connectionControlSchema = z.object({
  instanceId: z.string().min(1).max(64),
  action: z.enum(['status', 'setup', 'configure', 'connect', 'disconnect']),
  kind: z.enum(['openai', 'cloudflared', 'manual']).optional(),
  tunnelId: z.string().regex(/^tunnel_[0-9a-f]{32}$/).optional(),
  manualPublicOrigin: manualPublicOriginSchema.optional(),
  manualPort: manualPortSchema.optional()
}).strict().refine(request => request.action === 'configure' ? request.kind !== undefined : request.kind === undefined,
  'Only configure accepts and requires a connection kind')
  .refine(request => request.manualPublicOrigin === undefined && request.manualPort === undefined ||
    request.action === 'configure' && request.kind === 'manual', 'External route settings require manual configure')
  .refine(request => request.tunnelId === undefined || request.action === 'configure' && request.kind === 'openai',
    'Core tunnel identity requires Secure MCP configure');
export type ConnectionControlRequest = z.infer<typeof connectionControlSchema>;

function externalRouteStatus() {
  const settings = getConfig().tunnel;
  if (settings.kind !== 'manual' || !settings.manualPublicOrigin) return {};
  let localOrigin: string | null = null;
  try { localOrigin = getStatus().localUrl ? new URL(getStatus().localUrl!).origin : null; } catch { /* No current endpoint. */ }
  return { externalOrigin: settings.manualPublicOrigin, localOrigin, httpHostHeader: '127.0.0.1',
    endpointRevision: settings.manualEndpointRevision ?? 0, automationPaused: getConfig().ui.automationPaused === true };
}

/** URL fields contain secret path tokens; project only categorical health and presence. */
export function getConnectionControlStatus() {
  const { profile } = getActiveInstanceRuntime();
  const status = getStatus();
  return {
    instanceId: profile.id, kind: getConfig().tunnel.kind, state: status.state, ...externalRouteStatus(),
    handshakeAt: status.handshakeAt, lastRequestAt: status.lastRequestAt,
    lastToolCallAt: status.lastToolCallAt,
    surfaces: status.surfaces.map(surface => ({ id: surface.id, state: surface.state,
      setupAvailable: Boolean(surface.publicUrl) }))
  };
}

let serial: Promise<unknown> = Promise.resolve();
export function controlConnection(value: ConnectionControlRequest) {
  const request = connectionControlSchema.safeParse(value);
  if (!request.success) return Promise.reject(new Error('Connection control requires one exact account, action and supported kind; unknown fields are refused.'));
  const run = serial.catch(() => undefined).then(async () => {
    const assertOwner = () => {
      if (getActiveInstanceRuntime().profile.id !== request.data.instanceId)
        throw new Error('Connection control targets a different account; use its exact running account process.');
    };
    assertOwner();
    if (request.data.action === 'status') return getConnectionControlStatus();
    if (request.data.action === 'configure' && request.data.kind === 'manual' &&
        (request.data.manualPublicOrigin ?? getConfig().tunnel.manualPublicOrigin)) {
      try { persistentMcpPort(request.data.manualPort ?? getConfig().tunnel.manualPort ?? 0, getActiveInstanceRuntime().profile.bridge.port); }
      catch { throw new Error('Connection control requires a persistent MCP port distinct from this account’s browser bridge.'); }
    }
    // Local-only explicit setup disclosure. Ordinary status/settings projections remain redacted.
    if (request.data.action === 'setup') {
      const status = getStatus();
      assertOwner();
      return { instanceId: request.data.instanceId, kind: getConfig().tunnel.kind, ...externalRouteStatus(),
        surfaces: status.surfaces.map(surface => ({ id: surface.id, name: surface.connectorName,
          description: surface.description, url: surface.publicUrl })) };
    }
    const owner = `connection-control:${randomUUID()}`;
    if (profileWorkAdmission.snapshot().mode !== 'open')
      throw new Error('Connection control is unavailable during an existing lifecycle transition.');
    profileWorkAdmission.beginFinalization(owner, 'applying exact-account connection settings');
    try {
      const { activeProfileWorkCensus } = await import('./profile-work-state.js');
      const census = await activeProfileWorkCensus();
      assertOwner();
      if (census.profileId !== request.data.instanceId || census.blockers.length)
        throw new Error('Connection control requires this account to be idle; finish active tools, turns, sends and workers first.');
      logInfo(`connection control: ${request.data.action} started for ${request.data.instanceId}`);
      if (request.data.action === 'configure') {
        if (request.data.kind === 'openai') {
          await assertActiveSecureTunnelIsolation({ ...getConfig().tunnel, kind: 'openai',
            ...(request.data.tunnelId === undefined ? {} : { tunnelId: request.data.tunnelId }) });
          assertOwner();
        }
        await updateConfig(config => {
          assertOwner();
          return { ...config, tunnel: { ...config.tunnel, kind: request.data.kind!,
            ...(request.data.tunnelId === undefined ? {} : { tunnelId: request.data.tunnelId }),
            ...(request.data.manualPublicOrigin === undefined ? {} : { manualPublicOrigin: request.data.manualPublicOrigin }),
            ...(request.data.manualPort === undefined ? {} : { manualPort: request.data.manualPort }) } };
        });
        assertOwner();
        await applySettings();
      } else if (request.data.action === 'connect') await connect();
      else await disconnect();
      assertOwner();
      logInfo(`connection control: ${request.data.action} completed for ${request.data.instanceId}`);
      return getConnectionControlStatus();
    } catch (error) {
      logWarn(`connection control: ${request.data.action} failed for ${request.data.instanceId}; inspect connection diagnostics`);
      // Owners already log their redacted diagnostics. Never project arbitrary upstream error URLs.
      if (error instanceof Error && /^Connection control /.test(error.message)) throw error;
      throw new Error('Connection control failed; inspect this account’s connection diagnostics. Saved settings may already have committed; check status before retrying.');
    } finally { profileWorkAdmission.release(owner); }
  });
  serial = run;
  return run;
}

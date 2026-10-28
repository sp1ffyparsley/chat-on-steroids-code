/** Shared validation for an externally managed, persistent HTTPS MCP route. */
import { z } from 'zod';

export const EXTERNAL_TUNNEL_PROBE_HEADER = 'x-local-tunnel-probe';
export const EXTERNAL_TUNNEL_CHALLENGE_HEADER = 'x-local-tunnel-challenge';
export const EXTERNAL_TUNNEL_PROOF_HEADER = 'x-local-tunnel-proof';
/** Diagnostic-only hash of a fresh synthetic request ID observed at this endpoint. */
export const EXTERNAL_TUNNEL_REQUEST_ID_DIGEST_HEADER = 'x-local-tunnel-request-id-digest';
export const EXTERNAL_TUNNEL_PROOF_PATTERN = /^[a-f0-9]{64}$/;
/** The server retains its signing secret; adapters receive only this local verifier. */
export type ExternalRouteVerifier = (routePath: string, challenge: string, proof: string | null) => boolean;
export const MCP_SURFACE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HTTPS_ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::443)?\/?$/i;
export const manualPublicOriginSchema = z.string().trim().max(253)
  .refine(value => value === '' || HTTPS_ORIGIN.test(value), 'Expected an HTTPS hostname without credentials, port, path, query or fragment')
  .transform(value => value === '' ? '' : new URL(value).origin);
export const manualPortSchema = z.union([z.literal(0), z.number().int().min(1024).max(65535)]);

/** Auto stays deterministic for this exact device-local bridge; collisions never choose a new port. */
export function persistentMcpPort(configured: number, bridgePort: number): number {
  const port = configured || bridgePort + 1000;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === bridgePort)
    throw new Error('Persistent MCP port is invalid or equals this account’s browser bridge; choose a separate port from 1024 to 65535.');
  return port;
}

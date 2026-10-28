/**
 * The local MCP endpoint.
 *
 * Bound to 127.0.0.1, with a stable port only for explicit external publication, so nothing on the LAN can
 * reach it. Four independent checks run before any MCP handling:
 *   1. the request path must carry the per-session secret token
 *   2. the Host header must be loopback (DNS rebinding protection)
 *   3. a present Origin header must be loopback (a browser cannot drive this endpoint)
 *   4. the body must be within a sane size
 *
 * The MCP handler is built per request from live config, so toggling a permission in
 * the UI takes effect on the very next call without restarting anything.
 *
 * Two things here exist purely because of what talks to this server. tunnel-client
 * runs OAuth discovery (RFC 9728) against it on every start and decodes whatever
 * comes back as JSON without looking at the status code, so this server answers the
 * protected-resource metadata request properly and never emits a non-JSON body.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EXTERNAL_TUNNEL_CHALLENGE_HEADER, EXTERNAL_TUNNEL_PROBE_HEADER, EXTERNAL_TUNNEL_PROOF_HEADER, EXTERNAL_TUNNEL_PROOF_PATTERN, EXTERNAL_TUNNEL_REQUEST_ID_DIGEST_HEADER, MCP_SURFACE_TOKEN_PATTERN, type ExternalRouteVerifier } from '../../shared/external-tunnel.js';
import { INSTANCE_CONNECTOR_SURFACES } from '../../shared/instance-profile.js';
import { createInboundTiming, formatInboundTiming, inboundIdentityFromHeaders, withInboundRequestId, type IdentityHeaderShapes } from './inbound.js';
import http from 'node:http';
import type { Socket } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { getConfig, refreshSharedFolderAccess } from '../config.js';
import { logError, logInfo, logWarn, noteLocalIncident } from '../logger.js';
import { buildServer, resetToolClock, type ToolContext } from './tools.js';
import { publishedSurfaceIds, configuredConnectorName, type SurfaceId } from './surfaces.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface McpEndpoint {
  /** Reuses the endpoint's actual exposure projection; no tool handlers are executed. */
  publication?: (surface: SurfaceId, observe: Parameters<typeof buildServer>[2]) => void;
  /** Verifies current-server metadata round trips without disclosing the signing secret. */
  externalRouteProof?: ExternalRouteVerifier;
  port: number;
  /**
   * The Core surface's URL, including its secret path segment.
   *
   * Kept as a named field because Core is the connector the app cannot work without and
   * most callers mean exactly it.
   */
  url: string;
  /**
   * One URL per public surface, each with its own token.
   *
   * Separate paths rather than separate ports: one listener is simpler to start, stop and
   * firewall, and a public tunnel that publishes the origin publishes both surfaces with no
   * extra process. What matters for the design is not which socket a request arrived on but
   * which MCP server answers it, and each path is wired to exactly one (see `buildServer`).
   */
  /** Empty string means this historical surface is intentionally not public on this host. */
  urls: Record<SurfaceId, string>;
  /**
   * Stops accepting new requests and drains accepted ones.
   *
   * Ordinary disconnect/reconnect callers omit `forceAfterMs`: severing an active response
   * after its mutation committed creates an ambiguous retry boundary. Final process shutdown
   * may opt into a bounded force because the process is exiting either way.
   */
  stop: (options?: { forceAfterMs?: number }) => Promise<void>;
}

/** RFC 9728 §3.1: the metadata for a resource at /x lives at /.well-known/…/x. */
const PRM_PREFIX = '/.well-known/oauth-protected-resource';

/** Unmatched paths may still contain valid private tokens; never log their raw bytes. */
function unmatchedRequestShape(pathOnly: string): string {
  const metadata = pathOnly.toLowerCase().startsWith(PRM_PREFIX);
  const surface = /^\/(?:\.well-known\/oauth-protected-resource\/)?mcp\/(core|desktop|plugins)(?:\/|$)/i.exec(pathOnly)?.[1]?.toLowerCase();
  return `${metadata ? 'oauth-metadata' : surface ? 'mcp' : 'route'}${surface ? `/${surface}` : ''} (unmatched)`;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Everything that is not the MCP endpoint answers with JSON.
 *
 * The reason is not tidiness. tunnel-client's OAuth discovery decodes the body of
 * these probes as JSON whatever the status code is, so a plain-text "Not found"
 * surfaced as `invalid character 'N' looking for beginning of value` and left the
 * client's OAuth state permanently in a failed state.
 */
function jsonError(res: http.ServerResponse, status: number, error: string): void {
  const body = JSON.stringify({ error });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Buffers an HTTP body before adapter admission, irrespective of Content-Length.
 *
 * The MCP Node adapter otherwise concatenates a chunked/missing-length request to an
 * unbounded JS string before parsing it. Stop retaining bytes at the same 8 MiB limit the
 * header guard advertises, answer immediately, and drain the remaining socket bytes without
 * keeping them in memory.
 */
function readBoundedJsonBody(
  req: http.IncomingMessage
): Promise<{ body?: unknown; error?: 'payload_too_large' | 'invalid_json' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const finish = (value: { body?: unknown; error?: 'payload_too_large' | 'invalid_json' }): void => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_BODY_BYTES) {
        finish({ error: 'payload_too_large' });
        // Do not leave the unread request applying backpressure to this connection. Its
        // remaining bytes are discarded by Node rather than accumulated by us.
        req.resume();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      try {
        const text = Buffer.concat(chunks, total).toString('utf8');
        finish({ body: text.length === 0 ? null : JSON.parse(text) });
      } catch {
        finish({ error: 'invalid_json' });
      }
    };
    const onError = (): void => finish({ error: 'invalid_json' });

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * RFC 9728 protected resource metadata.
 *
 * This server is not protected by OAuth — the unguessable path token is what
 * authorises a caller — so the document names the resource and lists no
 * authorization server. That is the truthful "no OAuth here" answer, and it is what
 * stops a client from either failing discovery or trying to start an OAuth flow.
 *
 * It is served only at the token-qualified URL. Anyone who can form that URL already
 * knows the token, so the `resource` field gives nothing away; serving it at the bare
 * /.well-known root would hand the token to any local process that asked.
 */
function protectedResourceMetadata(resource: string, resourceName: string): string {
  return JSON.stringify({
    resource,
    resource_name: resourceName,
    authorization_servers: [],
    scopes_supported: []
  });
}

/**
 * When ChatGPT last actually reached this app, epoch ms.
 *
 * This is the only end-to-end proof that exists: the tunnel can be up and OpenAI
 * reachable while ChatGPT still refuses to call the connector, and only a request
 * landing here distinguishes those two.
 */
let requestSeenAt: number | null = null;
/**
 * The same clock per connector.
 *
 * With two connectors, "ChatGPT reached this app" no longer means "both connectors were
 * created and work". A user whose Core connector is healthy and who never added the
 * optional Desktop one would otherwise be shown a finished setup, so the setup screen
 * asks each surface for itself.
 */
const surfaceRequestAt = new Map<SurfaceId, number>();

/**
 * Bounded, argument-free ingress history for incident attribution.
 *
 * The setup clock above is deliberately surface-wide. It answers whether Core was ever reached,
 * not whether *one worker turn* reached it. Keep the exact request id and JSON-RPC method here so
 * diagnostics can later join through the existing request-correlation owner instead of treating
 * another chat's healthy Core traffic as evidence for the incident under review.
 */
export interface McpIngressEvidence {
  surface: SurfaceId;
  at: number;
  requestId: string | null;
  methods: string[];
  /** Diagnostic only: an envelope id is not a ChatGPT workflow/request attribution grant. */
  rpcIdentity?: McpRpcIdentity;
  /** Fixed ingress shapes, never header values or an alternative attribution source. */
  identityHeaders?: IdentityHeaderShapes;
}
interface McpRpcIdentity {
  kind: 'string' | 'number' | 'absent' | 'null' | 'invalid' | 'batch';
  sha256?: string;
}
export interface McpIngressWindow {
  records: McpIngressEvidence[];
  complete: boolean;
}
const MAX_INGRESS_EVIDENCE = 1024;
let ingressCoverageStartedAt = Date.now();
let ingressDroppedThrough = -Infinity;
const ingressEvidence: McpIngressEvidence[] = [];

function rpcMethods(body: unknown): string[] {
  const values = Array.isArray(body) ? body : [body];
  return [...new Set(values.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const method = (value as Record<string, unknown>)['method'];
    return typeof method === 'string' && method.length > 0 && method.length <= 100 ? [method] : [];
  }))].slice(0, 32);
}

function rpcEnvelopeIdentity(body: unknown): McpRpcIdentity | null {
  if (!rpcMethods(body).includes('tools/call')) return null;
  if (Array.isArray(body)) return { kind: 'batch' };
  const row = body as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(row, 'id')) return { kind: 'absent' };
  const id = row['id'];
  if (id === null) return { kind: 'null' };
  if (typeof id === 'string' && id.length > 0 && id.length <= 100 ||
      typeof id === 'number' && Number.isSafeInteger(id)) {
    const kind = typeof id as 'string' | 'number';
    return { kind, sha256: createHash('sha256').update(JSON.stringify([kind, id])).digest('hex') };
  }
  return { kind: 'invalid' };
}

function noteIngressEvidence(surface: SurfaceId, at: number, requestId: string | null, body: unknown,
  identityHeaders: IdentityHeaderShapes): McpRpcIdentity | null {
  const rpcIdentity = rpcEnvelopeIdentity(body);
  ingressEvidence.push({ surface, at, requestId, methods: rpcMethods(body),
    ...(rpcIdentity ? { rpcIdentity, identityHeaders: { ...identityHeaders } } : {}) });
  while (ingressEvidence.length > MAX_INGRESS_EVIDENCE) {
    const removed = ingressEvidence.shift();
    if (removed) ingressDroppedThrough = Math.max(ingressDroppedThrough, removed.at);
  }
  return rpcIdentity;
}

export function recentMcpIngress(surface: SurfaceId, since: number, until = Date.now()): McpIngressWindow {
  const start = Number.isFinite(since) ? since : until;
  const end = Number.isFinite(until) ? Math.max(start, until) : start;
  return {
    records: ingressEvidence
      .filter((entry) => entry.surface === surface && entry.at >= start && entry.at <= end)
      .map((entry) => ({ ...entry, methods: [...entry.methods],
        ...(entry.rpcIdentity ? { rpcIdentity: { ...entry.rpcIdentity } } : {}),
        ...(entry.identityHeaders ? { identityHeaders: { ...entry.identityHeaders } } : {}) })),
    complete: start >= ingressCoverageStartedAt && start > ingressDroppedThrough
  };
}

export function lastRequestAt(surface?: SurfaceId): number | null {
  if (surface === undefined) return requestSeenAt;
  return surfaceRequestAt.get(surface) ?? null;
}

/**
 * Lets the self-test call this server without being mistaken for ChatGPT.
 *
 * The self-test drives the loopback endpoint over real HTTP, so without this it would
 * set the clock above and turn the one honest end-to-end signal into a green light
 * this app switched on itself. The value is random per session and never leaves the
 * process, so nothing outside can claim to be the self-test.
 */
const SELF_TEST_HEADER = 'x-local-self-test';
const TUNNEL_PROBE_HEADER = EXTERNAL_TUNNEL_PROBE_HEADER;
let selfTestToken = randomBytes(16).toString('hex');
let tunnelProbeToken = randomBytes(16).toString('hex');

export function selfTestHeaders(): Record<string, string> {
  return { [SELF_TEST_HEADER]: selfTestToken };
}

/** Header injected only into tunnel-client's own discovery/startup probes. */
export function tunnelProbeHeaders(): Record<string, string> {
  return { [TUNNEL_PROBE_HEADER]: tunnelProbeToken };
}

/**
 * Starts the local MCP server.
 *
 * `getContext` is called on every request so that roots and capabilities are read
 * fresh; nothing about the permission state is captured at startup.
 */
interface SurfaceExposure {
  finishTool: boolean;
  caps: ToolContext['caps'] | null;
  sessionTools: boolean;
  agentTools: boolean;
  find: boolean | null;
}

/**
 * What each independently discoverable connector has already exposed.
 *
 * Core and Desktop share one loopback listener, but they are separate MCP servers to the
 * client. Keeping this as one global snapshot let a Desktop request freeze Core's mutually
 * exclusive `find`/exec choice before Core had ever been discovered, and it could similarly
 * preserve Core-only feature exposure solely because the other connector was queried first.
 * Monotonicity therefore has to be per surface, which is the same boundary ChatGPT caches.
 */
const surfaceExposure = new Map<SurfaceId, SurfaceExposure>();

function exposureFor(surface: SurfaceId): SurfaceExposure {
  let state = surfaceExposure.get(surface);
  if (!state) {
    state = { finishTool: false, caps: null, sessionTools: false, agentTools: false, find: null };
    surfaceExposure.set(surface, state);
  }
  return state;
}

/**
 * Forgets what this endpoint has ever exposed, so the next snapshot is built from the
 * settings as they stand now.
 *
 * The monotonic rule above is about not deleting a tool from under a *cached* snapshot, and
 * that is the right default — but it made switching multi-agent mode off a decision the app
 * could never carry out: the `agents` tool stayed registered for as long as the app kept
 * running, so a user who tried the feature once was stuck with it.
 *
 * So turning a feature off calls this, and the app tells the user to reconnect the connector
 * in ChatGPT. That reconnect is what makes it clean: ChatGPT re-reads the tool list, and what
 * it reads has no trace of the feature. The cost is the one thing the monotonic rule was
 * buying — a call from the stale snapshot in an already-open chat now fails as an unknown
 * tool rather than as a tidy refusal — which is why this is only ever called for a
 * deliberate settings change and never on its own.
 */
export function forgetExposedSurface(): void {
  surfaceExposure.clear();
}

export interface PersistentMcpEndpoint {
  port: number;
  surfaceTokens: Readonly<Record<string, string>>;
}

export async function startMcpServer(getContext: () => ToolContext, persistent?: PersistentMcpEndpoint): Promise<McpEndpoint> {
  // Only explicit external/manual publication uses an OS-encrypted persistent identity.
  // Ordinary OpenAI and quick tunnels keep their per-start paths and ephemeral listener.
  if (persistent && (!Number.isInteger(persistent.port) || persistent.port < 1024 || persistent.port > 65535 ||
      !persistent.surfaceTokens || Object.keys(persistent.surfaceTokens).some(id => !INSTANCE_CONNECTOR_SURFACES.includes(id as typeof INSTANCE_CONNECTOR_SURFACES[number])) ||
      publishedSurfaceIds().some(id => !MCP_SURFACE_TOKEN_PATTERN.test(persistent.surfaceTokens[id] ?? '')) ||
      Object.values(persistent.surfaceTokens).some(token => typeof token !== 'string' || !MCP_SURFACE_TOKEN_PATTERN.test(token)) ||
      new Set(Object.values(persistent.surfaceTokens)).size !== Object.keys(persistent.surfaceTokens).length))
    throw new Error('Invalid persistent endpoint port or surface authority; connection was not published.');
  requestSeenAt = null;
  surfaceRequestAt.clear();
  ingressEvidence.length = 0;
  ingressCoverageStartedAt = Date.now();
  ingressDroppedThrough = -Infinity;
  resetToolClock();
  selfTestToken = randomBytes(16).toString('hex');
  tunnelProbeToken = randomBytes(16).toString('hex');
  // One path per surface, each with its own token. Distinct tokens rather than one shared
  // secret because the two connectors are configured separately in ChatGPT and may be
  // shared, revoked or re-pasted at different times; a single token would make "give me
  // Desktop" and "give me everything" the same act.
  const surfacePaths = publishedSurfaceIds().map((id) => ({
    id,
    basePath: `/mcp/${id}/${persistent ? persistent.surfaceTokens[id] : randomBytes(32).toString('base64url')}`
  }));

  // ChatGPT can keep a cached tools/list snapshot for the lifetime of a connector
  // session. If a permission is disabled after that snapshot was loaded, removing the
  // tool immediately makes the old snapshot call an unknown tool and some clients
  // surface that as a transport-level UNKNOWN/TaskGroup failure. Keep the exposed
  // surface monotonic for this local endpoint instead: newly enabled tools appear,
  // previously exposed tools remain registered, and their handlers return the clear
  // TOOL_DISABLED result while the live capability is off. A fresh app/server start
  // resets the surface to the permissions that are enabled at that point.
  forgetExposedSurface();
  const stableContext = (surface: SurfaceId): ToolContext => {
    const live = getContext();
    const exposed = exposureFor(surface);
    if (exposed.find === null) exposed.find = !live.caps.command && live.caps.search;
    if (exposed.caps === null) {
      exposed.caps = { ...live.caps };
    } else {
      for (const key of Object.keys(live.caps) as Array<keyof ToolContext['caps']>) {
        if (live.caps[key]) exposed.caps[key] = true;
      }
    }
    const config = getConfig();
    const sessionTools = live.sessionTools ?? config.sessions.record;
    const agentTools = live.agentTools ?? config.multiAgent.enabled;
    exposed.finishTool = exposed.finishTool || config.ui.finishTool === true;
    exposed.sessionTools = exposed.sessionTools || sessionTools;
    exposed.agentTools = exposed.agentTools || agentTools;
    return {
      ...live,
      sessionTools,
      agentTools,
      exposedCaps: { ...exposed.caps },
      exposedSessionTools: exposed.sessionTools,
      exposedFinishTool: exposed.finishTool,
      exposedAgentTools: exposed.agentTools,
      exposedFind: exposed.find
    };
  };

  // One handler per surface, and the routing below is the only thing that decides which
  // one sees a request. This is what makes the discovery boundary real rather than
  // advertised: the Core handler has no `computer` registered at all, so a call for it
  // fails as an unknown tool inside the protocol layer, with nothing here to "helpfully"
  // forward it to the other surface.
  const routes = surfacePaths.map((surface) => ({
    ...surface,
    prmPath: `${PRM_PREFIX}${surface.basePath}`,
    url: '',
    handler: toNodeHandler(
      createMcpHandler(() => buildServer(stableContext(surface.id), surface.id, undefined, () => stableContext(surface.id))),
      { onerror: (error) => logError(`MCP handler error (${surface.id}): ${error.message}`) }
    )
  }));
  const checkHost = localhostHostValidation();
  const checkOrigin = localhostOriginValidation();
  // One first-cause incident per endpoint lifetime, not one filesystem scan per call.
  // This is diagnostic evidence of missing upstream headers, never inferred chat identity.
  let missingHeaderIncident: 'none' | 'writing' | 'attempted' = 'none';

  // A TCP connection or incomplete body is not an accepted MCP operation. Only
  // requests handed to the adapter own a response that must survive Disconnect.
  const sockets = new Map<Socket, Set<http.ServerResponse>>();
  let stopping: Promise<void> | null = null;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  let forceDeadline = Infinity;
  let stopped = false;
  // A different key for every listener lifetime, never sent in discovery headers.
  const externalRouteKey = randomBytes(32);
  const signExternalRoute = (metadataPath: string, challenge: string): Buffer =>
    createHmac('sha256', externalRouteKey).update(`cos-external-route-v1\n${metadataPath}\n${challenge}`).digest();
  const server = http.createServer((req, res) => {
    // Fixed diagnostic names only: alternative headers are observations, never joins.
    // rawHeaders retains duplicate fields that Node may otherwise merge after a '/' in
    // the workflow id. Such a merged value cannot authorize its first apparent owner.
    const identity = inboundIdentityFromHeaders(req.headers, req.rawHeaders);
    const requestHeaderShape = identity.headers['x-request-id'];
    const headerRequestId = identity.requestId;
    if (stopping) {
      res.setHeader('connection', 'close');
      jsonError(res, 503, 'server_stopping');
      return;
    }
    const timing = createInboundTiming();
    const url = req.url ?? '';
    const pathOnly = url.split('?')[0] ?? '';
    const selfTest = req.headers[SELF_TEST_HEADER] === selfTestToken;
    const tunnelProbe = req.headers[TUNNEL_PROBE_HEADER] === tunnelProbeToken;

    // Logged for every request, so the Activity tab shows what actually arrived and
    // what it was answered with. The path is reduced to a shape — it carries the
    // session token — and nothing from the body is logged.
    const route = routes.find((candidate) => safeEqual(pathOnly, candidate.basePath)) ?? null;
    const prmRoute = routes.find((candidate) => safeEqual(pathOnly, candidate.prmPath)) ?? null;

    const startedAt = Date.now();
    let rpcIdentity: McpRpcIdentity | null = null;
    const publication = { completedAt: null as number | null, failed: false };
    res.once('close', () => { if (publication.completedAt === null) publication.failed = true; });
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && !publication.failed) publication.completedAt = Date.now();
      else publication.failed = true;
      const shape = route
        ? `mcp/${route.id}`
        : prmRoute
          ? `oauth-metadata/${prmRoute.id}`
          : unmatchedRequestShape(pathOnly);
      const method = req.method ?? '?';
      const who = selfTest ? ' (self-test)' : tunnelProbe ? ' (tunnel probe)' : '';
      // A tool can succeed while its request identity was stripped by an external
      // proxy. Preserve the real outcome and append only this fixed shape; never log
      // the header value, path token, tool arguments or provider message content.
      const openaiHeaderShape = identity.headers['x-openai-request-id'];
      const legacyHeaderShape = identity.headers['openai-request-id'];
      const identityNote = timing.calls > 0 ? ` identity_header=${requestHeaderShape}` +
        ` identity_candidates=x-request-id:${requestHeaderShape},x-openai-request-id:${openaiHeaderShape},openai-request-id:${legacyHeaderShape}` +
        (rpcIdentity ? ` rpc_id_kind=${rpcIdentity.kind}` +
          // A full opaque 64-hex digest is correctly masked by the generic credential
          // redactor. Emit only a short hash prefix: useful for comparing identical typed
          // envelopes in app.log, too short to look like a secret, and NEVER caller identity.
          (rpcIdentity.sha256 ? ` rpc_id_fingerprint=${rpcIdentity.sha256.slice(0, 16)}` : '') : '') : '';
      const line = `${method} ${shape} → ${res.statusCode} in ${Date.now() - startedAt}ms${who}${formatInboundTiming(timing)}${identityNote}`;
      if (route && timing.calls > 0 && res.statusCode >= 200 && res.statusCode < 300 &&
          !selfTest && !tunnelProbe && missingHeaderIncident === 'none' &&
          requestHeaderShape === 'missing' && openaiHeaderShape === 'missing' &&
          legacyHeaderShape === 'missing') {
        missingHeaderIncident = 'writing';
        void noteLocalIncident({
          source: 'app', reason: 'mcp_missing_identity_headers', status: 'unresolved',
          fingerprint: createHash('sha256').update(`mcp-missing-headers:${route.id}:v1`).digest('hex'),
          // The incumbent logger already defaults to capture=not_requested; do not
          // provide an explicit unchanged capture, which bypasses its fingerprint
          // fast-deduplication and writes every repeated restart observation.
          // Constant, bounded cause only. Do not persist the opaque RPC id, arguments,
          // endpoint path token, result body, guessed session, or arbitrary provider text.
          detail: `MCP ${route.id} accepted a tool call without supported request identity headers`
        }).then(() => {
          // Even a full or unavailable diagnostics disk may not cause a retry for
          // every successful Core call. The incumbent logger exposes storageError;
          // a new app/endpoint lifetime can attempt its exact first cause again.
          missingHeaderIncident = 'attempted';
        }, () => { missingHeaderIncident = 'attempted'; });
      }
      // Streamable HTTP makes the server-opened SSE stream and session deletion
      // optional, and 405 is the prescribed answer for a server that offers
      // neither. ChatGPT probes for both on every connect, so treating those two
      // as failures would put a pair of red lines in the log on a healthy
      // connection and bury the errors that do matter.
      const optional =
        res.statusCode === 405 && route !== null && (method === 'GET' || method === 'DELETE');
      const expectedTunnelProbe = tunnelProbe && res.statusCode === 415 && route !== null && method === 'POST';
      if (optional) logInfo(`request ${line} (stream/session not offered — normal)`);
      else if (expectedTunnelProbe) logInfo(`request ${line} (probe compatibility check — normal)`);
      else if (res.statusCode >= 400) logWarn(`request ${line}`);
      else logInfo(`request ${line}`);
    });

    if (prmRoute) {
      if (!checkHost(req, res)) return;
      if (!checkOrigin(req, res)) return;
      const challenge = req.headers[EXTERNAL_TUNNEL_CHALLENGE_HEADER];
      if (req.method === 'GET' && typeof challenge === 'string' && EXTERNAL_TUNNEL_PROOF_PATTERN.test(challenge))
        res.setHeader(EXTERNAL_TUNNEL_PROOF_HEADER, signExternalRoute(prmRoute.prmPath, challenge).toString('hex'));
      const body = protectedResourceMetadata(prmRoute.url, configuredConnectorName(prmRoute.id));
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body)
      });
      res.end(body);
      return;
    }

    if (!route) {
      jsonError(res, 404, 'not_found');
      return;
    }
    if (!checkHost(req, res)) return;
    if (!checkOrigin(req, res)) return;

    // Prove the actual MCP prefix independently of OAuth metadata routing, including
    // method-selective POST header loss. Only an empty framed GET/POST can reach this
    // non-dispatching branch after exact bearer path and Host/Origin guards. It never
    // becomes native ChatGPT ingress, handshake or tool evidence.
    const challenge = req.headers[EXTERNAL_TUNNEL_CHALLENGE_HEADER];
    if (challenge !== undefined) {
      // HTTP framing defines zero bytes: reject even empty chunked framing rather than
      // read an unbounded stream or accidentally hand a body-bearing probe to MCP.
      const zeroBody = req.headers['transfer-encoding'] === undefined &&
        (req.headers['content-length'] === undefined || req.headers['content-length'] === '0');
      if ((req.method !== 'GET' && req.method !== 'POST') || url !== route.basePath || !zeroBody ||
          typeof challenge !== 'string' || !EXTERNAL_TUNNEL_PROOF_PATTERN.test(challenge)) {
        jsonError(res, 400, 'invalid_external_route_proof');
        return;
      }
      const proofHeaders: Record<string, string> = { 'cache-control': 'no-store',
        [EXTERNAL_TUNNEL_PROOF_HEADER]: signExternalRoute(route.basePath, challenge).toString('hex') };
      // A fresh probe ID has no chat authority; its hash shows whether this external
      // route preserved the HTTP header into the correct, HMAC-proven local endpoint.
      // This is separate from actual ChatGPT delivery and cannot attribute a tool.
      if (headerRequestId) proofHeaders[EXTERNAL_TUNNEL_REQUEST_ID_DIGEST_HEADER] =
        createHash('sha256').update(headerRequestId).digest('hex');
      res.writeHead(204, proofHeaders);
      res.end();
      return;
    }

    // Count only a validated request to the actual MCP endpoint. OAuth metadata,
    // 404s, our own self-test and tunnel-client's startup initialize probe are not
    // evidence that ChatGPT itself reached the connector.
    if (!selfTest && !tunnelProbe) {
      requestSeenAt = Date.now();
      surfaceRequestAt.set(route.id, requestSeenAt);
    }

    const declaredHeader = req.headers['content-length'];
    const declared = Number(declaredHeader ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      jsonError(res, 413, 'payload_too_large');
      return;
    }

    // The tool dispatch reads this back to join the call to the page request that issued
    // it; see inbound.ts for why it cannot be taken from the MCP call context.
    const requestId = headerRequestId;
    const dispatch = async (body?: unknown): Promise<void> => {
      try { await refreshSharedFolderAccess(); }
      catch (error) {
        logError(`Shared folder policy could not be verified before MCP admission: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.destroyed) jsonError(res, 503, 'shared_folder_policy_unavailable');
        return;
      }
      if (stopping || res.destroyed) {
        if (!res.destroyed) {
          res.setHeader('connection', 'close');
          jsonError(res, 503, 'server_stopping');
        }
        return;
      }
      const socket = req.socket;
      const responses = sockets.get(socket)!;
      responses.add(res);
      const release = (): void => {
        responses.delete(res);
        // Flush the completed response without waiting for the peer to close its
        // half of the connection. Immediate destroy() could lose buffered bytes.
        if (stopping && responses.size === 0) socket.destroySoon();
      };
      res.once('finish', release);
      res.once('close', release);
      if (!selfTest && !tunnelProbe) rpcIdentity = noteIngressEvidence(route.id, Date.now(), requestId, body, identity.headers);
      withInboundRequestId(requestId, () => void route.handler(req, res, body), timing, publication);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      void readBoundedJsonBody(req).then((parsed) => {
        if (res.destroyed) return;
        if (parsed.error === 'payload_too_large') {
          jsonError(res, 413, 'payload_too_large');
          return;
        }
        if (parsed.error === 'invalid_json') {
          jsonError(res, 400, 'invalid_json');
          return;
        }
        void dispatch(parsed.body);
      });
      return;
    }
    void dispatch();
  });
  server.on('connection', (socket) => {
    sockets.set(socket, new Set());
    socket.once('close', () => sockets.delete(socket));
    if (stopping) socket.destroy();
  });

  // Reject slow or oversized bodies rather than holding sockets open indefinitely.
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;
  server.maxRequestsPerSocket = 0;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => reject(error.code === 'EADDRINUSE' && persistent
      ? new Error(`Persistent MCP port ${persistent.port} is already in use; check the exact account mapping or choose a free manual port. No alternate port was selected.`) : error);
    server.once('error', onError);
    server.listen(persistent?.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not determine the local server port');
  }

  server.on('error', (err) => logError(`Local server error: ${err.message}`));
  logInfo(`server started on 127.0.0.1:${address.port}`);

  // Known only once the OS has handed us a port, and needed by each metadata document as
  // that surface's canonical resource identifier.
  for (const surface of routes) surface.url = `http://127.0.0.1:${address.port}${surface.basePath}`;
  const urls: Record<SurfaceId, string> = { core: '', desktop: '', plugins: '' };
  for (const surface of routes) urls[surface.id] = surface.url;

  return {
    port: address.port,
    url: urls.core,
    urls,
    externalRouteProof: (routePath, challenge, proof) => {
      if (stopping || stopped || !EXTERNAL_TUNNEL_PROOF_PATTERN.test(challenge) ||
          typeof proof !== 'string' || !EXTERNAL_TUNNEL_PROOF_PATTERN.test(proof) ||
          !routes.some(route => safeEqual(routePath, route.prmPath) || safeEqual(routePath, route.basePath))) return false;
      return timingSafeEqual(Buffer.from(proof, 'hex'), signExternalRoute(routePath, challenge));
    },
    publication: (surface, observe) => {
      if (!publishedSurfaceIds().includes(surface)) return;
      void buildServer(stableContext(surface), surface, observe).close();
    },
    stop: (options = {}) => {
      if (!stopping) {
        // Publish the admission fence before closing any sockets or receiving late bodies.
        let resolveStop!: () => void;
        stopping = new Promise<void>((resolve) => { resolveStop = resolve; });
        const accepted = [...sockets.values()].reduce((count, responses) => count + responses.size, 0);
        logInfo(`server stopping: draining ${accepted} accepted response(s)`);
        server.close(() => {
          stopped = true;
          if (forceTimer) clearTimeout(forceTimer);
          logInfo('server stopped');
          resolveStop();
        });
        for (const [socket, responses] of sockets) {
          if (responses.size === 0) socket.destroy();
        }
      }
      // Final shutdown can escalate an ordinary drain already in progress. Repeated
      // calls share custody and may shorten, but never extend, its force deadline.
      const forceAfterMs = options.forceAfterMs;
      if (!stopped && forceAfterMs !== undefined && Date.now() + forceAfterMs < forceDeadline) {
        if (forceTimer) clearTimeout(forceTimer);
        forceDeadline = Date.now() + Math.max(0, forceAfterMs);
        forceTimer = setTimeout(() => {
          server.closeAllConnections();
          logWarn(`server drain timed out after ${forceAfterMs}ms during final shutdown; forcing remaining connections closed`);
        }, Math.max(0, forceAfterMs));
        forceTimer.unref?.();
      }
      return stopping;
    }
  };
}

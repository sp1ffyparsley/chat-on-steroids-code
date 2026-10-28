/**
 * A self-test that answers "where exactly is this broken", one hop at a time.
 *
 * The chain from ChatGPT to a file on this PC has four links, and a failure in any of
 * them looks identical from the outside — ChatGPT just says it cannot use the
 * connector. So each link is checked separately, in order, and reported as its own
 * line: the local MCP server, the tunnel process, the tunnel's route to OpenAI, and
 * whether ChatGPT has ever actually arrived here.
 *
 * Everything is loopback-only. Nothing is sent to OpenAI, and the results contain no
 * secrets: the session token in the local URL is never included.
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getStatus, isServerRunning, tunnelHealthBase } from './connection.js';

import { effectiveCapabilities, getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import {
  lastRequestAt,
  recentMcpIngress,
  selfTestHeaders,
  type McpIngressWindow
} from './mcp/server.js';
import { lastToolCallAt } from './mcp/tools.js';
import { recentToolDispatches, type ToolDispatchWindow } from './mcp/kernel.js';
import {
  ago,
  POLL_FRESH_MS,
  readClientStatus,
  readPollHealth,
  type PollHealth
} from './tunnel/health.js';

import type { Capabilities, Check, ConnectionStatus, Diagnosis, MacOSDesktopAccessStatus, SurfaceStatus } from '../shared/types.js';
import { surfaceIsUseful } from './mcp/surfaces.js';
import { refreshMacOSDesktopAccess } from './computer/index.js';
import {
  coreBrowserEvidence,
  type CoreBrowserEvidenceSnapshot
} from './core-browser-evidence.js';
import {
  pluginSurfaceObservation,
  type PluginSurfaceObservation
} from './plugin-refresh.js';
import { requestCorrelation } from './session/correlation.js';
import { readDurableStrict, writeDurableNow } from './durable.js';
import { runningToolCalls } from './mcp/call-context.js';
export {
  classifyProviderRecoveryFailure,
  type ProviderRecoveryFailureEvidence,
  type ProviderRecoveryFailurePhase
} from './session/recovery-failure.js';

export type CoreToolSurfaceDiagnosticKind =
  | 'zero_core_ingress'
  | 'browser_shell_discovery_failure'
  | 'exact_identity_delay'
  | 'connector_name_or_schema_mismatch'
  | 'local_core_or_tunnel_failure'
  | 'insufficient_evidence';

/**
 * Bounded classification for native recovery failures.
 *
 * Recovery code already owns retry/reload decisions. This classifier only records the last
 * proven custody boundary so a failed Loop turn can distinguish a preparation failure from a
 * sent-but-unconfirmed input. It deliberately does not authorize another Send.
 */
type HealthEvidence = 'healthy' | 'failed' | 'unknown';
type PresenceEvidence = 'present' | 'absent' | 'unknown';
type MatchEvidence = 'match' | 'mismatch' | 'unknown';

/**
 * Exact facts from one suspected Core tool-surface incident.
 *
 * Queue length, selected tabs and historical DOM are intentionally absent. They are useful
 * scheduling/presentation facts, not evidence that ChatGPT exposed a connector to one model
 * turn. Browser observations only participate when their owner says they are fresh for the
 * current document/route.
 */
export interface CoreToolSurfaceEvidence {
  localServer: HealthEvidence;
  tunnel: HealthEvidence;
  route: HealthEvidence;
  coreIngress: PresenceEvidence;
  toolCall: PresenceEvidence;
  exactIdentity: 'resolved' | 'delayed' | 'unknown';
  /** Profile-scoped MCP facts, not evidence that those calls belong to this conversation. */
  headerlessIngressCalls?: number;
  headerlessDispatches?: number;
  browserShell: 'classic' | 'alternate' | 'unknown';
  shellDiscovery: 'compatible' | 'failed' | 'unknown';
  browserEvidenceFresh: boolean;
  connectorName: MatchEvidence;
  connectorSchema: MatchEvidence;
  connectorEvidenceFresh: boolean;
}

export interface CoreToolSurfaceDiagnostic {
  kind: CoreToolSurfaceDiagnosticKind;
  boundary: 'local' | 'connector' | 'browser' | 'ingress' | 'identity' | 'unknown';
  /** Human-readable boundary statement. It never assigns an unobserved provider-side cause. */
  detail: string;
}

/**
 * Browser/connector/current-transport observations are deliberately short-lived incident facts.
 * Request ownership itself is not: `session/correlation.ts` remains the permanent authority.
 */
export const CORE_TOOL_SURFACE_INCIDENT_FRESH_MS = 30_000;

export interface CoreToolSurfaceIncidentWindow {
  conversationId: string;
  startedAt: number;
  endedAt: number;
  now: number;
}

/**
 * The exact owners an incident projection reads. This is a test seam, not another registry.
 * Production passes the existing bounded MCP/tool histories, authenticated browser snapshot,
 * connector publication observation, connection owner and request-correlation lookup directly.
 */
export interface CoreToolSurfaceIncidentSources {
  ingress: McpIngressWindow;
  toolDispatches: ToolDispatchWindow;
  browser: CoreBrowserEvidenceSnapshot | null;
  connector: PluginSurfaceObservation | null;
  serverRunning: boolean;
  connection: Pick<ConnectionStatus, 'state' | 'handshakeAt'>;
  requestOwner: (requestId: string) => string | null;
}

export interface CoreToolSurfaceIncidentReport {
  window: CoreToolSurfaceIncidentWindow;
  evidence: CoreToolSurfaceEvidence;
  diagnostic: CoreToolSurfaceDiagnostic;
}

const conversationIdLooksReal = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f-]{8,64}$/i.test(value);

function emptyCoreToolSurfaceEvidence(): CoreToolSurfaceEvidence {
  return {
    localServer: 'unknown',
    tunnel: 'unknown',
    route: 'unknown',
    coreIngress: 'unknown',
    toolCall: 'unknown',
    exactIdentity: 'unknown',
    headerlessIngressCalls: 0,
    headerlessDispatches: 0,
    browserShell: 'unknown',
    shellDiscovery: 'unknown',
    browserEvidenceFresh: false,
    connectorName: 'unknown',
    connectorSchema: 'unknown',
    connectorEvidenceFresh: false
  };
}

function validIncidentWindow(window: CoreToolSurfaceIncidentWindow): boolean {
  return conversationIdLooksReal(window.conversationId) &&
    Number.isFinite(window.startedAt) && Number.isFinite(window.endedAt) && Number.isFinite(window.now) &&
    window.startedAt > 0 && window.endedAt >= window.startedAt && window.now >= window.endedAt;
}

function observationFreshForIncident(
  observedAt: number,
  window: CoreToolSurfaceIncidentWindow,
  allowBeforeMs = 0
): boolean {
  return Number.isFinite(observedAt) &&
    observedAt >= window.startedAt - allowBeforeMs &&
    observedAt <= window.endedAt + CORE_TOOL_SURFACE_INCIDENT_FRESH_MS &&
    observedAt <= window.now &&
    window.now - observedAt <= CORE_TOOL_SURFACE_INCIDENT_FRESH_MS;
}

function transportEvidence(
  window: CoreToolSurfaceIncidentWindow,
  sources: CoreToolSurfaceIncidentSources
): Pick<CoreToolSurfaceEvidence, 'localServer' | 'tunnel' | 'route'> {
  const fresh = window.now - window.endedAt <= CORE_TOOL_SURFACE_INCIDENT_FRESH_MS;
  const state = sources.connection.state;
  const currentTunnelFailure = fresh &&
    (state === 'disconnected' || state === 'disconnecting' || state === 'tunnel-unavailable');
  const currentRouteFailure = fresh &&
    (currentTunnelFailure || state === 'offline' || state === 'auth-failed');
  const currentServerFailure = fresh && !sources.serverRunning;

  // A non-self-test MCP request physically crossed the public Core route and reached this
  // process inside the incident window. That is stronger historical health evidence than the
  // connection card's current state or last handshake, and it is exactly the negative control
  // available when another chat succeeds during one chat's zero-ingress turn.
  const externalIngressInWindow = sources.ingress.records.some((record) =>
    record.at >= window.startedAt && record.at <= window.endedAt);

  return {
    localServer: currentServerFailure
      ? 'failed'
      : externalIngressInWindow || (fresh && sources.serverRunning && sources.ingress.complete) ? 'healthy' : 'unknown',
    tunnel: currentTunnelFailure
      ? 'failed'
      : externalIngressInWindow ? 'healthy'
        : fresh && (state === 'connected' || state === 'offline' || state === 'auth-failed') ? 'healthy' : 'unknown',
    // `connected`/a recent control-plane handshake alone is not proof that the Core route
    // carried traffic during this model turn. Without an actual external request, keep the
    // positive route state unknown; current explicit failures can still fail closed locally.
    route: currentRouteFailure ? 'failed' : externalIngressInWindow ? 'healthy' : 'unknown'
  };
}

interface IncidentPresence {
  presence: PresenceEvidence;
  resolved: boolean;
  delayed: boolean;
}

function exactIncidentPresence(
  records: ReadonlyArray<{ requestId: string | null }>,
  complete: boolean,
  conversationId: string,
  browserRequestIds: ReadonlySet<string>,
  requestOwner: CoreToolSurfaceIncidentSources['requestOwner']
): IncidentPresence {
  let resolved = false;
  let delayed = false;
  let ambiguous = false;
  for (const record of records) {
    const requestId = record.requestId;
    if (!requestId) {
      ambiguous = true;
      continue;
    }
    const owner = requestOwner(requestId);
    if (owner === conversationId) {
      resolved = true;
      continue;
    }
    if (owner !== null) continue; // Exact evidence owns this traffic to another chat.
    if (browserRequestIds.has(requestId)) delayed = true;
    else ambiguous = true;
  }
  return {
    presence: resolved || delayed ? 'present' : complete && !ambiguous ? 'absent' : 'unknown',
    resolved,
    delayed
  };
}

/**
 * Projects one exact incident window without reading global queue/model/tab state.
 *
 * Absence is intentionally expensive: the history must cover the whole interval and every
 * Core tool-call record inside it must be exactly owned by another conversation. An unowned
 * request stays unknown. A fresh browser request id can prove that an otherwise-unowned ingress
 * belongs to this chat, but a browser snapshot that contradicts the permanent request owner is
 * discarded rather than allowed to move that owner.
 */
export function projectCoreToolSurfaceIncidentEvidence(
  window: CoreToolSurfaceIncidentWindow,
  sources: CoreToolSurfaceIncidentSources
): CoreToolSurfaceEvidence {
  if (!validIncidentWindow(window)) return emptyCoreToolSurfaceEvidence();

  const evidence = { ...emptyCoreToolSurfaceEvidence(), ...transportEvidence(window, sources) };
  // A live external route may deliver a perfectly working tool request without
  // the HTTP key that correlates it to the page. Expose the *first lost phase*
  // with already-bounded native ingress/dispatch observations. These counts
  // describe this account's window, never the chosen conversation or a result.
  evidence.headerlessIngressCalls = Math.min(1024, sources.ingress.records.filter(row =>
    row.methods.includes('tools/call') && row.requestId === null).length);
  evidence.headerlessDispatches = Math.min(1024, sources.toolDispatches.records.filter(row =>
    row.requestId === null).length);
  let browserFresh = sources.browser !== null &&
    sources.browser.conversationId === window.conversationId &&
    observationFreshForIncident(sources.browser.observedAt, window);
  const candidateBrowserIds = new Set(browserFresh ? sources.browser!.requestIds : []);
  // First exact proof wins in the canonical correlation owner. A current page that claims one
  // of those request ids for a different conversation is not safe incident evidence.
  if (browserFresh && [...candidateBrowserIds].some((id) => {
    const owner = sources.requestOwner(id);
    return owner !== null && owner !== window.conversationId;
  })) browserFresh = false;
  const browserIds = browserFresh ? candidateBrowserIds : new Set<string>();

  if (browserFresh) {
    evidence.browserEvidenceFresh = true;
    evidence.browserShell = sources.browser!.shell;
    evidence.shellDiscovery = sources.browser!.shellDiscovery;
  }

  const connectorFresh = sources.connector !== null &&
    observationFreshForIncident(
      sources.connector.observedAt,
      window,
      CORE_TOOL_SURFACE_INCIDENT_FRESH_MS
    );
  if (connectorFresh) {
    evidence.connectorEvidenceFresh = true;
    evidence.connectorName = sources.connector!.providerConnectorName === sources.connector!.expectedConnectorName
      ? 'match' : 'mismatch';
    evidence.connectorSchema = sources.connector!.providerSchemaId === sources.connector!.expectedSchemaId
      ? 'match' : 'mismatch';
  }

  // initialize/tools-list traffic is connector discovery, not the worker/model tool request this
  // incident is classifying. Keep only actual tool-call ingress; the bounded window still proves
  // whether any such record was omitted by trimming/restart.
  const ingress = exactIncidentPresence(
    sources.ingress.records.filter((record) => record.methods.includes('tools/call')),
    sources.ingress.complete,
    window.conversationId,
    browserIds,
    sources.requestOwner
  );
  const calls = exactIncidentPresence(
    sources.toolDispatches.records,
    sources.toolDispatches.complete,
    window.conversationId,
    browserIds,
    sources.requestOwner
  );
  evidence.coreIngress = ingress.presence;
  evidence.toolCall = calls.presence;
  evidence.exactIdentity = ingress.delayed || calls.delayed
    ? 'delayed'
    : ingress.resolved || calls.resolved ? 'resolved' : 'unknown';
  return evidence;
}

/**
 * Read-only production collector for a freshly bounded incident.
 *
 * No connector refresh, browser wake, retry or health authority is created here. The caller must
 * supply the exact conversation and turn window; this function only asks existing owners what
 * they observed in that interval and feeds the already-pure classifier below.
 */
export function diagnoseCoreToolSurfaceIncident(input: {
  conversationId: string;
  startedAt: number;
  endedAt?: number;
  now?: number;
}): CoreToolSurfaceIncidentReport {
  const now = input.now ?? Date.now();
  const endedAt = input.endedAt ?? now;
  const window: CoreToolSurfaceIncidentWindow = {
    conversationId: input.conversationId,
    startedAt: input.startedAt,
    endedAt,
    now
  };
  if (!validIncidentWindow(window)) {
    const evidence = emptyCoreToolSurfaceEvidence();
    return { window, evidence, diagnostic: classifyCoreToolSurfaceFailure(evidence) };
  }
  const status = getStatus();
  const evidence = projectCoreToolSurfaceIncidentEvidence(window, {
    ingress: recentMcpIngress('core', window.startedAt, window.endedAt),
    toolDispatches: recentToolDispatches('core', window.startedAt, window.endedAt),
    browser: coreBrowserEvidence(window.conversationId),
    connector: pluginSurfaceObservation('core'),
    serverRunning: isServerRunning(),
    connection: { state: status.state, handshakeAt: status.handshakeAt },
    requestOwner: (requestId) => requestCorrelation(requestId)?.conversationId ?? null
  });
  return { window, evidence, diagnostic: classifyCoreToolSurfaceFailure(evidence) };
}

/**
 * Classifies the earliest proven failure boundary without guessing why ChatGPT behaved that way.
 *
 * Precedence matters. A broken local server/tunnel outranks downstream observations. Fresh exact
 * connector mismatch outranks model-turn symptoms. Once an MCP/tool request arrived, missing
 * ownership is an identity problem rather than zero ingress. Browser-shell failure requires a
 * current-document observation; stale DOM is ignored. Zero ingress means only that no Core
 * request reached this app for the exact incident while the local route was positively healthy.
 */
export function classifyCoreToolSurfaceFailure(evidence: CoreToolSurfaceEvidence): CoreToolSurfaceDiagnostic {
  const contradictoryIngress = evidence.coreIngress === 'absent' && evidence.toolCall === 'present';
  if (contradictoryIngress) {
    return {
      kind: 'insufficient_evidence',
      boundary: 'unknown',
      detail: 'Incident evidence contradicts itself: a Core tool call cannot be present while Core ingress is proven absent.'
    };
  }

  const failedLocal = [
    ['local MCP server', evidence.localServer],
    ['tunnel process', evidence.tunnel],
    ['tunnel route', evidence.route]
  ].filter(([, state]) => state === 'failed').map(([name]) => name);
  if (failedLocal.length > 0) {
    return {
      kind: 'local_core_or_tunnel_failure',
      boundary: 'local',
      detail: `Local Core transport is positively unhealthy at: ${failedLocal.join(', ')}. Browser/model evidence cannot move the failure boundary past that.`
    };
  }

  if (
    evidence.connectorEvidenceFresh &&
    (evidence.connectorName === 'mismatch' || evidence.connectorSchema === 'mismatch')
  ) {
    const mismatches = [
      evidence.connectorName === 'mismatch' ? 'connector identity/name' : null,
      evidence.connectorSchema === 'mismatch' ? 'tool schema' : null
    ].filter(Boolean).join(' and ');
    return {
      kind: 'connector_name_or_schema_mismatch',
      boundary: 'connector',
      detail: `Fresh ChatGPT connector-management evidence disagrees on ${mismatches}. This is a connector publication/cache boundary, not a queue or model-quality inference.`
    };
  }

  if (evidence.toolCall === 'present' && evidence.exactIdentity === 'delayed') {
    return {
      kind: 'exact_identity_delay',
      boundary: 'identity',
      detail: 'A Core request reached this app, but the exact request-id → conversation join was not available in the incident window.'
    };
  }
  if (evidence.exactIdentity !== 'resolved' && evidence.coreIngress !== 'present' &&
      ((evidence.headerlessIngressCalls ?? 0) > 0 || (evidence.headerlessDispatches ?? 0) > 0)) {
    const phase = (evidence.headerlessIngressCalls ?? 0) > 0 ? 'MCP HTTP ingress' : 'tool dispatch';
    return {
      kind: 'insufficient_evidence',
      boundary: 'ingress',
      detail: `One or more Core tool calls in this account's incident window lacked a usable x-request-id at ${phase}. ` +
        'They are not attributed to this conversation. Check the external route and actual HTTP request identity before ' +
        'attempting native Loop recovery; connected transport or a browser request mapping is not a tool completion receipt.'
    };
  }

  if (
    evidence.coreIngress === 'absent' &&
    evidence.browserEvidenceFresh &&
    evidence.browserShell !== 'unknown' &&
    evidence.shellDiscovery === 'failed'
  ) {
    return {
      kind: 'browser_shell_discovery_failure',
      boundary: 'browser',
      detail: `The current ${evidence.browserShell} ChatGPT document was positively identified, but the companion could not read its supported shell/model/tool surface. No provider-side cause is inferred.`
    };
  }

  if (
    evidence.coreIngress === 'absent' &&
    evidence.localServer === 'healthy' &&
    evidence.tunnel === 'healthy' &&
    evidence.route === 'healthy'
  ) {
    return {
      kind: 'zero_core_ingress',
      boundary: 'ingress',
      detail: 'No Core request reached this app for the exact incident while the local Core server, tunnel and route were positively healthy. This identifies the boundary only; it does not prove why ChatGPT exposed or omitted the tool surface.'
    };
  }

  return {
    kind: 'insufficient_evidence',
    boundary: 'unknown',
    detail: 'The available facts do not isolate one Core tool-surface boundary. Preserve the unknowns rather than inferring from queue state, model label, selected tab or stale DOM.'
  };
}

/**
 * Durable event-driven handoff for recovery incidents which exhausted their existing native owner.
 *
 * This module still does not open, send to, or run a diagnostic chat. It owns only the durable
 * admission/claim boundary that a recovery owner can call after it has positively exhausted its
 * own deterministic repair. That separation keeps native Retry/reload/Stop authoritative and
 * guarantees idle standby has no poll, timer, Loop or model request.
 */
export const DIAGNOSTIC_INCIDENT_BACKLOG_MAX = 16;
const DIAGNOSTIC_INCIDENT_STATE = 'diagnostic-incidents';
const conversationIdentity = z.string().regex(/^[0-9a-f-]{8,64}$/i);
const sessionIdentity = z.string().min(1).max(200);
const incidentKind = z.enum(['delivery', 'loop', 'worker']);
const inputCustody = z.enum(['none', 'confirmed-unsent', 'sent', 'ambiguous']);
const incidentStatus = z.enum(['pending', 'claimed', 'delivered', 'ambiguous', 'resolved', 'suppressed']);
const incidentDisposition = z.enum(['recovered', 'failed', 'user-action']);
const diagnosticChat = z.object({
  sessionId: sessionIdentity,
  conversationId: conversationIdentity
});
const diagnosticIncidentRow = z.object({
  id: z.string().uuid(),
  key: z.string().regex(/^[0-9a-f]{64}$/),
  kind: incidentKind,
  sourceSessionId: sessionIdentity,
  sourceConversationId: conversationIdentity,
  exhaustedAt: z.number().int().nonnegative(),
  firstObservedAt: z.number().int().nonnegative(),
  lastObservedAt: z.number().int().nonnegative(),
  repeatCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  inputCustody,
  /** Existing session-input UUID carrying the one diagnostic wake, never arbitrary prompt text. */
  wakeInputId: z.string().uuid().nullable().default(null),
  /** Exact native ChatGPT user-message receipt once that wake is proven delivered. */
  wakeMessageId: z.string().min(1).max(256).nullable().default(null),
  status: incidentStatus,
  claimId: z.string().uuid().nullable(),
  claimedAt: z.number().int().nonnegative().nullable(),
  settledAt: z.number().int().nonnegative().nullable(),
  disposition: incidentDisposition.nullable()
});
const diagnosticIncidentState = z.object({
  version: z.literal(1),
  ownerId: z.string().uuid(),
  chat: diagnosticChat.nullable(),
  overflowCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  incidents: z.array(diagnosticIncidentRow).max(DIAGNOSTIC_INCIDENT_BACKLOG_MAX)
});
type DiagnosticIncidentRow = z.infer<typeof diagnosticIncidentRow>;
type DiagnosticIncidentState = z.infer<typeof diagnosticIncidentState>;
export type DiagnosticIncidentKind = z.infer<typeof incidentKind>;
export type DiagnosticInputCustody = z.infer<typeof inputCustody>;
export type DiagnosticIncidentDisposition = z.infer<typeof incidentDisposition>;

export interface ExhaustedDiagnosticIncident {
  kind: DiagnosticIncidentKind;
  sourceSessionId: string;
  sourceConversationId: string;
  /**
   * Existing recovery owner's stable episode identity. It is hashed before persistence so a
   * caller cannot accidentally turn diagnostic state into a copy of arbitrary runtime text.
   */
  recoveryEpisodeId: string;
  exhaustedAt: number;
  appOwned: boolean;
  recoveryExhausted: boolean;
  inputCustody: DiagnosticInputCustody;
  /** Diagnostic-origin incidents are never allowed to recursively wake the diagnostic owner. */
  origin?: 'runtime' | 'diagnostic';
  /** Exact user Stop/Off evidence from the existing owner. */
  userStopped?: boolean;
}

export interface DiagnosticIncidentView {
  id: string;
  kind: DiagnosticIncidentKind;
  sourceSessionId: string;
  sourceConversationId: string;
  exhaustedAt: number;
  firstObservedAt: number;
  lastObservedAt: number;
  repeatCount: number;
  inputCustody: DiagnosticInputCustody;
  wakeInputId: string | null;
  wakeMessageId: string | null;
  status: z.infer<typeof incidentStatus>;
  claimId: string | null;
  claimedAt: number | null;
  settledAt: number | null;
  disposition: DiagnosticIncidentDisposition | null;
}

export interface DiagnosticIncidentSnapshot {
  ownerId: string | null;
  chat: { sessionId: string; conversationId: string } | null;
  overflowCount: number;
  incidents: DiagnosticIncidentView[];
}

export type DiagnosticIncidentAdmissionResult =
  | { accepted: true; coalesced: boolean; incident: DiagnosticIncidentView }
  | { accepted: false; reason: 'invalid-evidence' | 'native-recovery-not-exhausted' | 'recursive' | 'user-stopped' | 'local-tool-active' | 'already-settled' | 'backlog-full' };

export interface DiagnosticIncidentWakeOffer {
  claimId: string;
  ownerId: string;
  incidentId: string;
  target:
    | { kind: 'create'; ownerId: string }
    | { kind: 'reuse'; sessionId: string; conversationId: string };
  /**
   * Fixed, bounded text only. Authored prompts, tool arguments, recovery episode strings, paths,
   * URLs and arbitrary provider text are deliberately absent.
   */
  message: string;
}

let diagnosticChain: Promise<unknown> = Promise.resolve();

function serialDiagnostic<T>(work: () => Promise<T>): Promise<T> {
  const result = diagnosticChain.then(work, work);
  diagnosticChain = result.catch(() => undefined);
  return result;
}

function emptyDiagnosticState(): DiagnosticIncidentState {
  return {
    version: 1,
    ownerId: randomUUID(),
    chat: null,
    overflowCount: 0,
    incidents: []
  };
}

async function readDiagnosticOwnerState(): Promise<DiagnosticIncidentState | null> {
  const raw = await readDurableStrict<unknown>(DIAGNOSTIC_INCIDENT_STATE);
  return raw === null ? null : diagnosticIncidentState.parse(raw);
}

async function diagnosticOwnerState(): Promise<DiagnosticIncidentState> {
  return await readDiagnosticOwnerState() ?? emptyDiagnosticState();
}

function incidentView(row: DiagnosticIncidentRow): DiagnosticIncidentView {
  return {
    id: row.id,
    kind: row.kind,
    sourceSessionId: row.sourceSessionId,
    sourceConversationId: row.sourceConversationId,
    exhaustedAt: row.exhaustedAt,
    firstObservedAt: row.firstObservedAt,
    lastObservedAt: row.lastObservedAt,
    repeatCount: row.repeatCount,
    inputCustody: row.inputCustody,
    wakeInputId: row.wakeInputId,
    wakeMessageId: row.wakeMessageId,
    status: row.status,
    claimId: row.claimId,
    claimedAt: row.claimedAt,
    settledAt: row.settledAt,
    disposition: row.disposition
  };
}

function snapshotDiagnosticState(state: DiagnosticIncidentState): DiagnosticIncidentSnapshot {
  return {
    ownerId: state.ownerId,
    chat: state.chat ? { ...state.chat } : null,
    overflowCount: state.overflowCount,
    incidents: state.incidents.map(incidentView)
  };
}

function validIncidentInput(input: ExhaustedDiagnosticIncident): boolean {
  return incidentKind.safeParse(input.kind).success &&
    sessionIdentity.safeParse(input.sourceSessionId).success &&
    conversationIdentity.safeParse(input.sourceConversationId).success &&
    inputCustody.safeParse(input.inputCustody).success &&
    typeof input.recoveryEpisodeId === 'string' && input.recoveryEpisodeId.length >= 1 && input.recoveryEpisodeId.length <= 512 &&
    Number.isSafeInteger(input.exhaustedAt) && input.exhaustedAt >= 0;
}

type DiagnosticIncidentIdentity = Pick<
  ExhaustedDiagnosticIncident,
  'kind' | 'sourceSessionId' | 'sourceConversationId' | 'recoveryEpisodeId'
>;

function incidentKey(input: DiagnosticIncidentIdentity): string {
  return createHash('sha256')
    .update(input.kind).update('\0')
    .update(input.sourceSessionId).update('\0')
    .update(input.sourceConversationId).update('\0')
    .update(input.recoveryEpisodeId)
    .digest('hex');
}

export interface RecoveredDiagnosticIncidentInput extends DiagnosticIncidentIdentity {
  /** Exact diagnostic wake UUID only after its existing outbox owner proved that wake unsent. */
  confirmedUnsentWakeInputId?: string;
}

export interface RecoveredDiagnosticIncidentResult {
  resolved: boolean;
  incident: DiagnosticIncidentView;
}

const custodyRank: Record<DiagnosticInputCustody, number> = {
  none: 0,
  'confirmed-unsent': 1,
  sent: 2,
  ambiguous: 3
};

function stricterCustody(a: DiagnosticInputCustody, b: DiagnosticInputCustody): DiagnosticInputCustody {
  return custodyRank[b] > custodyRank[a] ? b : a;
}

function diagnosticSourceIsSelf(
  state: DiagnosticIncidentState,
  sourceSessionId: string,
  sourceConversationId: string
): boolean {
  return state.chat !== null &&
    (state.chat.sessionId === sourceSessionId || state.chat.conversationId === sourceConversationId);
}

function pruneTerminalIncident(state: DiagnosticIncidentState): boolean {
  const index = state.incidents.findIndex(row => row.status === 'resolved' || row.status === 'suppressed');
  if (index < 0) return false;
  state.incidents.splice(index, 1);
  return true;
}

async function persistDiagnosticState(state: DiagnosticIncidentState): Promise<void> {
  diagnosticIncidentState.parse(state);
  await writeDurableNow(DIAGNOSTIC_INCIDENT_STATE, state);
}

/**
 * Admits one exact already-exhausted recovery episode.
 *
 * The caller remains responsible for proving the exhaustion at its canonical owner. This boundary
 * independently refuses user Stop, recursive diagnostic work and live local tool custody, then
 * records only structured identifiers/status. No wake is created here.
 */
export async function noteExhaustedDiagnosticIncidentNow(
  input: ExhaustedDiagnosticIncident,
  now = Date.now()
): Promise<DiagnosticIncidentAdmissionResult> {
  return serialDiagnostic(async () => {
    if (!validIncidentInput(input)) return { accepted: false, reason: 'invalid-evidence' };
    if (!input.appOwned || !input.recoveryExhausted)
      return { accepted: false, reason: 'native-recovery-not-exhausted' };
    const state = await diagnosticOwnerState();
    if (input.origin === 'diagnostic' || diagnosticSourceIsSelf(state, input.sourceSessionId, input.sourceConversationId))
      return { accepted: false, reason: 'recursive' };
    if (input.userStopped) {
      let changed = false;
      for (const row of state.incidents) {
        if (row.sourceSessionId !== input.sourceSessionId && row.sourceConversationId !== input.sourceConversationId) continue;
        if (row.status === 'resolved' || row.status === 'suppressed') continue;
        row.status = 'suppressed';
        row.settledAt = now;
        row.disposition = 'user-action';
        changed = true;
      }
      if (changed) await persistDiagnosticState(state);
      return { accepted: false, reason: 'user-stopped' };
    }
    if (runningToolCalls(input.sourceConversationId) > 0) return { accepted: false, reason: 'local-tool-active' };

    const key = incidentKey(input);
    const existing = state.incidents.find(row => row.key === key);
    if (existing) {
      if (existing.status === 'resolved' || existing.status === 'suppressed')
        return { accepted: false, reason: 'already-settled' };
      existing.repeatCount = Math.min(Number.MAX_SAFE_INTEGER, existing.repeatCount + 1);
      existing.lastObservedAt = Math.max(existing.lastObservedAt, now);
      existing.inputCustody = stricterCustody(existing.inputCustody, input.inputCustody);
      await persistDiagnosticState(state);
      return { accepted: true, coalesced: true, incident: incidentView(existing) };
    }

    while (state.incidents.length >= DIAGNOSTIC_INCIDENT_BACKLOG_MAX && pruneTerminalIncident(state)) { /* bounded tombstone cleanup */ }
    if (state.incidents.length >= DIAGNOSTIC_INCIDENT_BACKLOG_MAX) {
      state.overflowCount = Math.min(Number.MAX_SAFE_INTEGER, state.overflowCount + 1);
      await persistDiagnosticState(state);
      return { accepted: false, reason: 'backlog-full' };
    }

    const row: DiagnosticIncidentRow = {
      id: randomUUID(),
      key,
      kind: input.kind,
      sourceSessionId: input.sourceSessionId,
      sourceConversationId: input.sourceConversationId,
      exhaustedAt: input.exhaustedAt,
      firstObservedAt: now,
      lastObservedAt: now,
      repeatCount: 1,
      inputCustody: input.inputCustody,
      wakeInputId: null,
      wakeMessageId: null,
      status: 'pending',
      claimId: null,
      claimedAt: null,
      settledAt: null,
      disposition: null
    };
    state.incidents.push(row);
    await persistDiagnosticState(state);
    return { accepted: true, coalesced: false, incident: incidentView(row) };
  });
}

function diagnosticMessage(row: DiagnosticIncidentRow): string {
  const kind = row.kind === 'delivery'
    ? 'app-owned delivery recovery exhausted'
    : row.kind === 'loop'
      ? 'app-owned Loop recovery exhausted'
      : 'app-owned worker recovery exhausted';
  const custody = row.inputCustody === 'ambiguous'
    ? 'ambiguous send evidence is preserved; do not resend or reconstruct the input'
    : row.inputCustody === 'sent'
      ? 'the input is already sent; do not resend it'
      : row.inputCustody === 'confirmed-unsent'
        ? 'the prior input is positively confirmed unsent; diagnose before proposing any new action'
        : 'no user-input replay is authorized';
  return [
    `DIAGNOSTIC INCIDENT ${row.id}`,
    `Failure: ${kind}.`,
    `Source session: ${row.sourceSessionId}`,
    `Source conversation: ${row.sourceConversationId}`,
    `Input custody: ${custody}.`,
    'Use existing redacted diagnostics and current ownership rules. Keep ordinary Loop off.',
    'Do not wake/create another diagnostic chat for this diagnostic chat, and do not act while the source owns a live local tool.',
    'Finish with exactly one result line: DIAGNOSTIC_RESULT: recovered, DIAGNOSTIC_RESULT: failed, or DIAGNOSTIC_RESULT: user-action.'
  ].join('\n');
}

/**
 * Claims the oldest pending incident through a durable barrier before a caller may create/send a
 * diagnostic wake. One claimed/delivered/ambiguous incident blocks every later wake, preventing a
 * chat storm. A caller must still recheck {@link diagnosticIncidentWakeClaimCurrent} immediately
 * before its external Send boundary.
 */
export async function claimDiagnosticIncidentWakeNow(now = Date.now()): Promise<DiagnosticIncidentWakeOffer | null> {
  return serialDiagnostic(async () => {
    const state = await diagnosticOwnerState();
    if (state.incidents.some(row => row.status === 'claimed' || row.status === 'delivered' || row.status === 'ambiguous'))
      return null;
    const row = state.incidents.find(item => item.status === 'pending');
    if (!row || runningToolCalls(row.sourceConversationId) > 0) return null;
    row.status = 'claimed';
    row.claimId = randomUUID();
    row.claimedAt = now;
    row.settledAt = null;
    await persistDiagnosticState(state);
    return {
      claimId: row.claimId,
      ownerId: state.ownerId,
      incidentId: row.id,
      target: state.chat
        ? { kind: 'reuse', sessionId: state.chat.sessionId, conversationId: state.chat.conversationId }
        : { kind: 'create', ownerId: state.ownerId },
      message: diagnosticMessage(row)
    };
  });
}

/** Restart-safe reconstruction of the one already-claimed bounded wake; never creates a claim. */
export async function diagnosticIncidentWakeOfferForClaim(claimId: string): Promise<DiagnosticIncidentWakeOffer | null> {
  return serialDiagnostic(async () => {
    const state = await diagnosticOwnerState();
    const row = state.incidents.find(item => item.claimId === claimId && item.status === 'claimed');
    if (!row) return null;
    return {
      claimId,
      ownerId: state.ownerId,
      incidentId: row.id,
      target: state.chat
        ? { kind: 'reuse', sessionId: state.chat.sessionId, conversationId: state.chat.conversationId }
        : { kind: 'create', ownerId: state.ownerId },
      message: diagnosticMessage(row)
    };
  });
}

/** Final pre-Send recheck for Stop/suppression and local tool custody. */
export async function diagnosticIncidentWakeClaimCurrent(claimId: string): Promise<boolean> {
  return serialDiagnostic(async () => {
    const state = await diagnosticOwnerState();
    const row = state.incidents.find(item => item.claimId === claimId && item.status === 'claimed');
    return !!row && runningToolCalls(row.sourceConversationId) === 0;
  });
}

/**
 * Binds the durable incident claim to the existing session-input owner before that UUID is
 * enqueued. A restart can therefore reconcile the one exact wake instead of minting a second
 * diagnostic message.
 */
export async function bindDiagnosticIncidentWakeInputNow(claimId: string, inputId: string): Promise<boolean> {
  return serialDiagnostic(async () => {
    if (!z.string().uuid().safeParse(inputId).success) return false;
    const state = await diagnosticOwnerState();
    const row = state.incidents.find(item => item.claimId === claimId && item.status === 'claimed');
    if (!row || (row.wakeInputId !== null && row.wakeInputId !== inputId)) return false;
    if (row.wakeInputId === inputId) return true;
    row.wakeInputId = inputId;
    await persistDiagnosticState(state);
    return true;
  });
}

export async function settleDiagnosticIncidentWakeNow(input: {
  claimId: string;
  outcome: 'delivered' | 'confirmed-unsent' | 'ambiguous';
  diagnosticSessionId?: string;
  diagnosticConversationId?: string;
  wakeInputId?: string;
  wakeMessageId?: string;
}, now = Date.now()): Promise<boolean> {
  return serialDiagnostic(async () => {
    const state = await diagnosticOwnerState();
    const row = state.incidents.find(item => item.claimId === input.claimId && item.status === 'claimed');
    if (!row) return false;
    if (input.wakeInputId !== undefined && row.wakeInputId !== input.wakeInputId) return false;
    if (input.outcome === 'confirmed-unsent') {
      row.status = 'pending';
      row.claimId = null;
      row.claimedAt = null;
      row.settledAt = now;
      row.wakeInputId = null;
      row.wakeMessageId = null;
      await persistDiagnosticState(state);
      return true;
    }
    if (input.outcome === 'ambiguous') {
      row.status = 'ambiguous';
      row.settledAt = now;
      row.wakeMessageId = typeof input.wakeMessageId === 'string' && input.wakeMessageId.length <= 256
        ? input.wakeMessageId : null;
      await persistDiagnosticState(state);
      return true;
    }

    if (!sessionIdentity.safeParse(input.diagnosticSessionId).success ||
        !conversationIdentity.safeParse(input.diagnosticConversationId).success) return false;
    const target = {
      sessionId: input.diagnosticSessionId as string,
      conversationId: input.diagnosticConversationId as string
    };
    if (target.sessionId === row.sourceSessionId || target.conversationId === row.sourceConversationId) return false;
    if (state.incidents.some(item =>
      item.id !== row.id && item.status !== 'resolved' && item.status !== 'suppressed' &&
      (item.sourceSessionId === target.sessionId || item.sourceConversationId === target.conversationId))) return false;
    if (state.chat && state.chat.sessionId !== target.sessionId) return false;
    state.chat = target;
    row.status = 'delivered';
    row.wakeMessageId = typeof input.wakeMessageId === 'string' && input.wakeMessageId.length <= 256
      ? input.wakeMessageId : null;
    row.settledAt = now;
    await persistDiagnosticState(state);
    return true;
  });
}

/**
 * Binds an already-existing dedicated diagnostic session. Provider conversation replacement is
 * allowed only inside that same durable local session, so Compact & Resume does not mint a second
 * diagnostic identity.
 */
export async function bindDiagnosticIncidentChatNow(
  sessionId: string,
  conversationId: string
): Promise<boolean> {
  return serialDiagnostic(async () => {
    if (!sessionIdentity.safeParse(sessionId).success || !conversationIdentity.safeParse(conversationId).success) return false;
    const state = await diagnosticOwnerState();
    if (state.chat && state.chat.sessionId !== sessionId) return false;
    if (state.incidents.some(row =>
      row.status !== 'resolved' && row.status !== 'suppressed' &&
      (row.sourceSessionId === sessionId || row.sourceConversationId === conversationId))) return false;
    state.chat = { sessionId, conversationId };
    await persistDiagnosticState(state);
    return true;
  });
}

/**
 * Retires only the exact reusable diagnostic-chat binding owned by one still-current wake claim.
 *
 * The caller must first prove the local session directory is absent through the session-store
 * owner. This mutation deliberately preserves the incident, claim and any already-bound wake UUID:
 * the same claim can then be re-offered as a create target without replaying sent/ambiguous work.
 * A delivered/ambiguous wake has no current claimed row, so it can never authorize this reset.
 */
export async function retireMissingDiagnosticIncidentChatNow(
  claimId: string,
  sessionId: string,
  conversationId: string
): Promise<boolean> {
  return serialDiagnostic(async () => {
    if (!z.string().uuid().safeParse(claimId).success ||
        !sessionIdentity.safeParse(sessionId).success ||
        !conversationIdentity.safeParse(conversationId).success) return false;
    const state = await diagnosticOwnerState();
    if (!state.chat || state.chat.sessionId !== sessionId || state.chat.conversationId !== conversationId) return false;
    if (!state.incidents.some(row => row.claimId === claimId && row.status === 'claimed')) return false;
    state.chat = null;
    await persistDiagnosticState(state);
    return true;
  });
}

/** Event-driven explicit Stop fence. It never sends or cancels anything itself. */
export async function suppressDiagnosticIncidentsForSourceNow(
  sourceSessionId: string,
  sourceConversationId: string,
  now = Date.now()
): Promise<number> {
  return serialDiagnostic(async () => {
    const state = await diagnosticOwnerState();
    let changed = 0;
    for (const row of state.incidents) {
      if (row.sourceSessionId !== sourceSessionId && row.sourceConversationId !== sourceConversationId) continue;
      if (row.status === 'resolved' || row.status === 'suppressed') continue;
      row.status = 'suppressed';
      row.settledAt = now;
      row.disposition = 'user-action';
      changed += 1;
    }
    if (changed) await persistDiagnosticState(state);
    return changed;
  });
}

/**
 * Retires one exact exhausted episode when its incumbent native owner later proves recovery.
 *
 * The recovery episode is hashed through the same identity used at admission, so an unrelated
 * success in the same chat cannot discharge this incident. A diagnostic wake that already has
 * durable outbox custody remains unresolved unless Bridge also supplies that exact wake UUID
 * after the ordinary input owner positively proved it never crossed native Send. Delivered or
 * ambiguous diagnostic wakes stay with the diagnostic chat/result owner instead.
 */
export async function resolveRecoveredDiagnosticIncidentNow(
  input: RecoveredDiagnosticIncidentInput,
  now = Date.now()
): Promise<RecoveredDiagnosticIncidentResult | null> {
  return serialDiagnostic(async () => {
    if (!incidentKind.safeParse(input.kind).success ||
        !sessionIdentity.safeParse(input.sourceSessionId).success ||
        !conversationIdentity.safeParse(input.sourceConversationId).success ||
        typeof input.recoveryEpisodeId !== 'string' || input.recoveryEpisodeId.length < 1 || input.recoveryEpisodeId.length > 512 ||
        (input.confirmedUnsentWakeInputId !== undefined &&
          !z.string().uuid().safeParse(input.confirmedUnsentWakeInputId).success)) return null;
    const state = await diagnosticOwnerState();
    const row = state.incidents.find(item => item.key === incidentKey(input));
    if (!row) return null;
    if (row.status === 'resolved') {
      return { resolved: row.disposition === 'recovered', incident: incidentView(row) };
    }
    if (row.status === 'suppressed' || row.status === 'delivered' || row.status === 'ambiguous') {
      return { resolved: false, incident: incidentView(row) };
    }
    if (row.wakeInputId !== null && row.wakeInputId !== input.confirmedUnsentWakeInputId) {
      return { resolved: false, incident: incidentView(row) };
    }
    row.status = 'resolved';
    row.settledAt = now;
    row.disposition = 'recovered';
    await persistDiagnosticState(state);
    return { resolved: true, incident: incidentView(row) };
  });
}

export async function resolveDiagnosticIncidentNow(
  incidentId: string,
  disposition: DiagnosticIncidentDisposition,
  now = Date.now()
): Promise<boolean> {
  return serialDiagnostic(async () => {
    if (!incidentDisposition.safeParse(disposition).success) return false;
    const state = await diagnosticOwnerState();
    const row = state.incidents.find(item => item.id === incidentId);
    if (!row || row.status === 'resolved' || row.status === 'suppressed') return false;
    row.status = 'resolved';
    row.settledAt = now;
    row.disposition = disposition;
    await persistDiagnosticState(state);
    return true;
  });
}

export async function diagnosticIncidentSnapshot(): Promise<DiagnosticIncidentSnapshot> {
  return serialDiagnostic(async () => {
    const state = await readDiagnosticOwnerState();
    return state
      ? snapshotDiagnosticState(state)
      : { ownerId: null, chat: null, overflowCount: 0, incidents: [] };
  });
}

/** Test seam only; durable bytes remain untouched so restart behavior can be exercised. */
export function resetDiagnosticIncidentOwnerForTests(): void {
  diagnosticChain = Promise.resolve();
}

async function fetchJson(
  url: string,
  body: unknown,
  timeoutMs = 5000
): Promise<{ status: number; json: unknown; text: string } | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        // Streamable HTTP servers may answer either way; accept both.
        accept: 'application/json, text/event-stream',
        // Identifies these as our own probes, so they are not counted as ChatGPT
        // having reached this app. Otherwise running the self-test would make the
        // one check that proves the connector works pass because of the self-test.
        ...selfTestHeaders()
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, json: parseRpc(text), text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Accepts a plain JSON body or an SSE stream carrying one JSON-RPC message. */
export function parseRpc(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const PROTOCOL_VERSION = '2025-06-18';

/**
 * Reports the client → OpenAI link without calling a tunnel that is still starting broken.
 *
 * The first control-plane poll is a long poll with a 30s timeout, so a client that came up
 * four seconds ago genuinely has no completed handshake yet. Reading that as "Not verified"
 * put a red problem on the self-test every single time the app started, for a connection
 * that was about to work — and it contradicted the tunnel supervisor, which already gives
 * the first poll exactly this grace before it will say a word about an outage.
 */
export function describeRoute(
  health: PollHealth | null,
  uptimeSeconds: number | null,
  nowMs = Date.now()
): Check {
  const name = 'Route to OpenAI';
  if (health === null) return { name, status: 'not-run', ok: null, detail: 'The tunnel did not report its metrics.' };

  const errors = `${health.errors ?? 0} poll error${health.errors === 1 ? '' : 's'} since start`;
  if (health.lastSuccessMs !== null && nowMs - health.lastSuccessMs <= POLL_FRESH_MS) {
    return {
      name,
      status: 'pass',
      ok: true,
      detail: `Verified — last completed handshake ${ago(health.lastSuccessMs, nowMs)}; ${errors}.`
    };
  }
  // Only a client that has *never* polled successfully gets the benefit of the doubt. One
  // that managed it once and then went quiet is a real outage, however young it is.
  if (health.lastSuccessMs === null && uptimeSeconds !== null && uptimeSeconds * 1000 < POLL_FRESH_MS) {
    return {
      name,
      status: 'not-run',
      ok: null,
      detail: `Still starting — the first poll of the control plane takes up to 30s; ${errors}.`
    };
  }
  return {
    name,
    status: 'fail',
    ok: false,
    detail: `Not verified — last completed handshake ${ago(health.lastSuccessMs, nowMs)}; ${errors}.`
  };
}

/** A fresh completed poll supersedes the client's sticky last-error field. */
export function metadataErrorIsCurrent(
  error: string | null,
  health: PollHealth | null,
  nowMs = Date.now()
): boolean {
  if (!error) return false;
  return (
    health?.lastSuccessMs === null ||
    health?.lastSuccessMs === undefined ||
    nowMs - health.lastSuccessMs > POLL_FRESH_MS
  );
}

/** Pure projection used by both the live self-test and targeted regressions. */
export function describeMacOSDesktopAccess(
  access: MacOSDesktopAccessStatus | null,
  caps: Pick<Capabilities, 'screen' | 'control'>
): Check[] {
  const checks: Check[] = [];
  if (!caps.screen && !caps.control) return checks;
  if (access === null) {
    return [{
      name: 'macOS Desktop permissions',
      status: 'not-run',
      ok: null,
      detail: 'The in-process native backend has not reported its Screen Recording or Accessibility state yet.'
    }];
  }

  const check = (
    name: string,
    state: MacOSDesktopAccessStatus['screen'],
    missing: string
  ): Check => ({
    name,
    status: state === 'granted' ? 'pass' : state === 'missing' ? 'fail' : 'not-run',
    ok: state === 'granted' ? true : state === 'missing' ? false : null,
    detail:
      state === 'granted'
        ? 'Granted to the in-process Desktop backend.'
        : state === 'missing'
          ? `${missing} Fully quit and reopen the app after changing the macOS permission.`
          : access.error ?? 'The in-process Desktop backend could not determine the live TCC decision.'
  });

  if (caps.screen) {
    checks.push(check(
      'macOS Screen Recording',
      access.screen,
      'macOS denied Screen Recording to the current Desktop process. Open Privacy & Security → Device Control and Data Access.'
    ));
  }
  if (caps.control) {
    checks.push(check(
      'macOS Accessibility',
      access.accessibility,
      'macOS denied AXUIElement access to the in-process Chat On Steroids.app backend. Open Privacy & Security → Accessibility (Device Control and Data Access on newer macOS).'
    ));
  }
  return checks;
}

/** Runs an initialize + tools/list against our own loopback endpoint. */
async function checkLocalServer(url: string): Promise<Check> {
  const init = await fetchJson(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'self-test', version: '1' }
    }
  });
  if (init === null) {
    return { name: 'Local server', status: 'fail', ok: false, detail: 'No answer on the loopback address.' };
  }
  const initObj = init.json as { error?: { message?: string } } | null;
  if (init.status >= 400 || initObj?.error) {
    return {
      name: 'Local server',
      status: 'fail',
      ok: false,
      detail: `initialize failed: HTTP ${init.status} ${initObj?.error?.message ?? init.text.slice(0, 120)}`
    };
  }

  const list = await fetchJson(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listObj = list?.json as
    | { result?: { tools?: Array<{ name?: string }> }; error?: { message?: string } }
    | null;
  const tools = listObj?.result?.tools;
  if (!Array.isArray(tools)) {
    return {
      name: 'Local server',
      status: 'fail',
      ok: false,
      detail: `tools/list failed: ${listObj?.error?.message ?? `HTTP ${list?.status ?? 0}`}`
    };
  }
  const names = tools.map((t) => t.name).filter(Boolean);
  return {
    name: 'Local server',
    status: 'pass',
    ok: true,
    detail: `Answers on loopback and offers ${names.length} tool${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
  };
}

async function probeText(url: string): Promise<{ status: number; body: string } | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3000);
  try {
    const res = await fetch(url, { signal: abort.signal });
    return { status: res.status, body: (await res.text()).trim().slice(0, 200) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tells apart "everything works" from the one failure that mimics it.
 *
 * When Developer mode is off in ChatGPT — and a ChatGPT update has been seen to switch
 * it off on its own — the connector still handshakes: this app is asked to initialize
 * and to list its tools, so every other check here goes green, while the model itself
 * is refused with FORBIDDEN and never calls a single tool. Requests arriving with no
 * tool call ever following is that exact fingerprint.
 *
 * It is not proof, because it also describes a connector nobody has used yet, so this
 * never reports a hard failure. It names the suspicion, which is the part that costs
 * an hour to work out from scratch.
 */
function developerMode(seen: number | null, called: number | null): Check {
  if (called !== null) {
    return {
      name: 'ChatGPT allowed to use the tools',
      status: 'pass',
      ok: true,
      detail: `Yes — ChatGPT last ran a tool ${ago(called)}, so Developer mode is on and the whole chain works.`
    };
  }
  if (seen === null) {
    return {
      name: 'ChatGPT allowed to use the tools',
      status: 'not-run',
      ok: null,
      detail: 'Unknown — ChatGPT has not reached this app at all yet, so there is nothing to judge.'
    };
  }
  return {
    name: 'ChatGPT allowed to use the tools',
    status: 'not-run',
    ok: null,
    detail:
      'Cannot tell — ChatGPT connected and read the tool list, but has never run a tool. ' +
      'That is normal if you have not asked it to do anything yet. If you have asked and it ' +
      'answered “does not support developer MCPs”, the cause is on ChatGPT’s side: turn ' +
      'Developer mode back on in ChatGPT → Settings → Apps & Connectors → Advanced. It can ' +
      'switch itself off after a ChatGPT update.'
  };
}

/**
 * Core-specific end-to-end clocks for the self-test.
 *
 * Desktop is an independently discoverable connector. Activity there proves neither that Core
 * was installed/discovered nor that a model could call it, so app-wide clocks would hide the
 * exact failure this screen is meant to diagnose.
 */
export function describeCoreArrival(seen: number | null, called: number | null): Check[] {
  return [
    {
      name: 'ChatGPT reaching Core',
      status: seen === null ? 'not-run' : 'pass',
      ok: seen === null ? null : true,
      detail:
        seen === null
          ? 'No Core request has arrived since the server started. Other connectors do not count as Core ingress.'
          : `Last Core request from ChatGPT ${ago(seen)}.`
    },
    developerMode(seen, called)
  ];
}

/** A healthy Core route cannot certify a different connector's failed tunnel (#1872). */
export function describeConnectorTunnels(
  surfaces: ReadonlyArray<Pick<SurfaceStatus, 'id' | 'state' | 'detail'>>
): Check[] {
  const labels = { core: 'Core', desktop: 'Desktop', plugins: 'Plugins' };
  return surfaces.filter(surface => surface.id !== 'core' && surface.state === 'error')
    .map(surface => ({ name: `${labels[surface.id]} tunnel`, status: 'fail', ok: false, detail: surface.detail }));
}

export async function runDiagnostics(): Promise<Diagnosis> {
  const checks: Check[] = [];
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  const status = getStatus();

  // 1. Is there anything to serve at all?
  const enabled = Object.entries(caps)
    .filter(([, on]) => on)
    .map(([name]) => name);
  checks.push({
    name: 'Permissions',
    status:
      enabled.length > 0 && (config.roots.length > 0 || surfaceIsUseful('desktop', caps)) ? 'pass' : 'fail',
    ok: enabled.length > 0 && (config.roots.length > 0 || surfaceIsUseful('desktop', caps)),
    detail:
      enabled.length === 0
        ? 'Nothing is switched on, so the connector would expose no tools.'
        : `${config.roots.length} folder${config.roots.length === 1 ? '' : 's'} shared; on: ${enabled.join(', ')}${config.readOnly ? ' (read-only)' : ''}`
  });

  // Ask the in-process backend that performs protected operations. A settings row or the
  // parent prompt API alone is not an authorization verdict.
  if (process.platform === 'darwin' && (caps.screen || caps.control)) {
    const access = await refreshMacOSDesktopAccess();
    checks.push(...describeMacOSDesktopAccess(access, caps));
  }

  // 2. Our own server, end to end, over the same URL the tunnel uses.
  if (!isServerRunning() || !status.localUrl) {
    checks.push({
      name: 'Local server',
      status: 'fail',
      ok: false,
      detail: 'Not running. Press Connect first.'
    });
  } else {
    checks.push(await checkLocalServer(status.localUrl));
  }

  // 3. The tunnel process itself.
  const base = tunnelHealthBase();
  if (config.tunnel.kind !== 'openai') {
    checks.push({
      name: 'Tunnel',
      status: 'skipped',
      ok: null,
      detail: `Using the ${config.tunnel.kind} path, which has no local health endpoint.`
    });
  } else if (!base) {
    checks.push({
      name: 'Tunnel',
      status: 'fail',
      ok: false,
      detail: 'The tunnel program is not running or has not reported a health address yet.'
    });
  } else {
    const ready = await probeText(`${base}/readyz`);
    checks.push({
      name: 'Tunnel',
      status: ready?.status === 200 ? 'pass' : 'fail',
      ok: ready?.status === 200,
      detail:
        ready === null
          ? 'The tunnel program is not answering on its local health address.'
          : ready.status === 200
            ? 'Running and ready.'
            : `Not ready: HTTP ${ready.status} ${ready.body}`
    });

    // 4. The link the outage actually breaks: client → OpenAI, and 5. what the tunnel
    //    thinks of us. Read together because the route check needs the client's uptime
    //    to tell "not working" apart from "has not finished starting".
    const [health, client] = await Promise.all([readPollHealth(base), readClientStatus(base)]);
    checks.push(describeRoute(health, client?.uptimeSeconds ?? null));

    if (client) {
      checks.push({
        name: 'Tunnel → this app',
        status: client.probe === null ? 'not-run' : client.probe === 'ok' ? 'pass' : 'fail',
        ok: client.probe === null ? null : client.probe === 'ok',
        detail:
          client.probe === null
            ? 'The tunnel did not report a probe result for the main channel.'
            : `Probe of the local MCP server: ${client.probe}.`
      });
      if (metadataErrorIsCurrent(client.metadataError, health)) {
        checks.push({
          name: 'Last tunnel error',
          status: 'fail',
          ok: false,
          detail: (client.metadataError ?? '').slice(0, 300)
        });
      }
    }
  }

  // 6–7. End-to-end proof is connector-specific. Desktop traffic cannot make Core green.
  checks.push(...describeConnectorTunnels(status.surfaces ?? []));
  checks.push(...describeCoreArrival(lastRequestAt('core'), lastToolCallAt('core')));

  const broken = checks.filter((c) => c.status === 'fail');
  const incomplete = checks.filter((c) => c.status === 'not-run');
  const summary =
    broken.length > 0
      ? `${broken.length} problem${broken.length === 1 ? '' : 's'}: ${broken.map((c) => c.name).join(', ')}.`
      : incomplete.length > 0
        ? `No failed checks · ${incomplete.length} not verified yet.`
        : 'Every required check passed.';

  logInfo(`self-test: ${summary}`);
  for (const check of checks) {
    const line = `self-test ${check.name}: ${check.detail}`;
    if (check.ok === false) logWarn(line);
    else logInfo(line);
  }

  return { checks, summary };
}

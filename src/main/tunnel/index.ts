/**
 * Connection adapters.
 *
 * The MCP server knows nothing about tunnels; it just serves a loopback URL. An
 * adapter's whole job is to make that URL reachable from ChatGPT and report state.
 * Adding another provider means adding one function here, not touching the tools.
 *
 * Two adapters ship:
 *  - openai: OpenAI's Secure MCP Tunnel. Outbound-only, nothing is published.
 *  - cloudflared: a generic HTTPS quick tunnel, for plans or accounts that cannot
 *    use the OpenAI tunnel. This one does create a public URL, so the secret path
 *    token in the URL is what keeps it private.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionState, TunnelHealth, TunnelSettings } from '../../shared/types.js';
import { childEnv, terminateProcessTree } from '../exec.js';
import { logError, logInfo, logWarn } from '../logger.js';
import { manualPublicOriginSchema, EXTERNAL_TUNNEL_CHALLENGE_HEADER, EXTERNAL_TUNNEL_PROOF_HEADER, EXTERNAL_TUNNEL_REQUEST_ID_DIGEST_HEADER, type ExternalRouteVerifier } from '../../shared/external-tunnel.js';
import { ago, POLL_FRESH_MS, readClientStatus, readPollHealth } from './health.js';
import { locateBinary } from './locate.js';
import { noteTunnelClientConnected } from './route-settle.js';

export interface TunnelReport {
  state: ConnectionState;
  detail: string;
  publicUrl?: string | null;
  /** Epoch ms of the last proven round trip to OpenAI, when the adapter knows one. */
  handshakeAt?: number | null;
  health?: TunnelHealth | null;
}

export interface TunnelStartOptions {
  /** Loopback MCP URL, including the secret path segment. */
  localUrl: string;
  settings: TunnelSettings;
  /** OpenAI control-plane API key, only for the openai adapter. */
  apiKey: string | null;
  /** Headers added only to tunnel-client's own MCP discovery/startup probes. */
  discoveryHeaders?: Record<string, string>;
  /** Local current-server verifier. Its private signing secret never leaves the server. */
  externalRouteProof?: ExternalRouteVerifier;
  /** Read-only local MCP tools/call evidence since this route began checking.
   * A synthetic forwarding probe alone never proves that actual provider calls
   * supplied request headers or that their results belong to a native chat. */
  actualToolIdentity?: (since: number) => {
    toolCalls: number;
    withoutRequestId: number;
    complete: boolean;
  };
  /** Active instance health namespace. Temporary tunnel health files stay inside it. */
  healthRoot?: string;
  /**
   * Which connector this tunnel carries, for the log. Two of them run at once, so
   * without it every line appeared twice with nothing to say which one it was about.
   */
  label?: string;
  report: (report: TunnelReport) => void;
}

export interface TunnelHandle {
  stop: () => Promise<void>;
  /** Loopback base URL of the client's own health/metrics server, when it has one. */
  healthBase?: () => string | null;
}

export class TunnelError extends Error {}

export const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

/** Terminates an owned tunnel tree and waits for the child handle to observe exit. */
/** A child that died by signal has a null exitCode and a signalCode; it is just as gone. */
const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

async function stopTree(child: ChildProcess | null, timeoutMs = 3_000): Promise<boolean> {
  if (!child || child.pid === undefined || exited(child)) return true;
  const closed = new Promise<boolean>((resolve) => {
    if (exited(child)) resolve(true);
    else child.once('close', () => resolve(true));
  });
  await terminateProcessTree(child.pid).catch(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  });
  return Promise.race([closed, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
}

function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let carry = '';
  return (chunk: Buffer) => {
    carry += chunk.toString('utf8');
    let at = carry.indexOf('\n');
    while (at !== -1) {
      const line = carry.slice(0, at).trimEnd();
      carry = carry.slice(at + 1);
      if (line) onLine(line);
      at = carry.indexOf('\n');
    }
    if (carry.length > 16_384) carry = '';
  };
}

const AUTH_FAILURE = /\b(401|403|unauthorized|invalid[_ ]api[_ ]key|invalid_request_error|forbidden)\b/i;

/**
 * Errors that mean "this PC cannot reach OpenAI right now", as opposed to "the tunnel
 * is broken".
 *
 * tunnel-client polls the control plane continuously and retries these itself with its
 * own backoff, so they must change what the user is told without provoking a restart.
 * They are also the *only* signal that the connection is down: the client's /readyz is
 * a local health check that stays green throughout an outage, because from its point
 * of view nothing local has failed.
 */
const CONTROL_PLANE_POLL = /\bpoll (?:failed|timed out(?:;\s*backing off)?)\b/i;
const UNREACHABLE_NETWORK =
  /no such host|dial tcp|i\/o timeout|timed out|context deadline exceeded|connection (was )?(aborted|refused|reset)|network is (unreachable|down)|no route to host|tls handshake timeout|temporary failure in name resolution|forcibly closed/i;

/** Turns a Go network error into something worth showing a person. */
export function describeNetworkError(raw: string): string {
  if (/no such host|name resolution/i.test(raw)) return 'no internet connection';
  if (/connection (was )?(aborted|reset)|forcibly closed/i.test(raw)) return 'the connection dropped';
  if (/refused/i.test(raw)) return 'the connection was refused';
  if (/timeout|timed out|context deadline exceeded/i.test(raw)) return 'the connection timed out';
  if (/network is (unreachable|down)|no route to host/i.test(raw)) return 'the network is unreachable';
  return 'a network error';
}

/** True when this machine can still resolve OpenAI's control plane. */
export function isUnreachableError(raw: string): boolean {
  const text = String(raw || '');
  // A bare Go timeout can come from the local MCP startup probe too. Only the tunnel
  // client's control-plane poll context is allowed to classify OpenAI as unreachable.
  return CONTROL_PLANE_POLL.test(text) && UNREACHABLE_NETWORK.test(text);
}

export async function startTunnel(opts: TunnelStartOptions): Promise<TunnelHandle> {
  switch (opts.settings.kind) {
    case 'openai':
      return startOpenAiTunnel(opts);
    case 'cloudflared':
      return startCloudflared(opts);
    case 'manual':
      if (opts.settings.manualPublicOrigin) return startExternalRoute(opts);
      opts.report({
        state: 'connected',
        detail: 'Local server running. Expose it with your own tunnel and use the URL below.',
        publicUrl: null
      });
      return { stop: async () => {} };
    default:
      throw new TunnelError('Unknown connection type');
  }
}

/** The connector is owned by the user/service; CoS owns only its publication and proof checks. */
async function startExternalRoute(opts: TunnelStartOptions): Promise<TunnelHandle> {
  const parsed = manualPublicOriginSchema.safeParse(opts.settings.manualPublicOrigin);
  const verifyProof = opts.externalRouteProof;
  if (!parsed.success || !parsed.data || typeof verifyProof !== 'function') throw new TunnelError('External route requires a valid HTTPS origin and the current local endpoint verifier.');
  const local = new URL(opts.localUrl);
  const publicUrl = `${parsed.data}${local.pathname}`;
  const metadataUrl = `${parsed.data}/.well-known/oauth-protected-resource${local.pathname}`;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let observed: string | undefined;
  const toolEvidenceSince = Date.now();
  const publish = (healthy: boolean, identityForwarded: boolean) => {
    const state = healthy ? 'connected' : 'tunnel-unavailable';
    // Only the incumbent MCP ingress owner can describe real tool requests.
    // Neither this route probe nor an SDK/JSON-RPC envelope id is a native
    // conversation or per-tool-message result receipt. When real calls lack a
    // usable identity, say so even if the diagnostic x-request-id was forwarded.
    let actual: ReturnType<NonNullable<TunnelStartOptions['actualToolIdentity']>> | null = null;
    if (healthy) {
      try { actual = opts.actualToolIdentity?.(toolEvidenceSince) ?? null; }
      catch { actual = null; } // diagnostic failure cannot disconnect a working route
    }
    const total = actual && Number.isSafeInteger(actual.toolCalls) && actual.toolCalls > 0
      ? actual.toolCalls : 0;
    const missing = total && actual && Number.isSafeInteger(actual.withoutRequestId)
      ? Math.max(0, Math.min(total, actual.withoutRequestId)) : 0;
    const missingClass = !opts.actualToolIdentity ? 'not-provided' :
      actual === null ? 'unavailable' :
        actual.complete !== true ? 'incomplete' :
          missing === 0 ? 'none' : missing === total ? 'all' : 'some';
    const observation = !healthy ? state :
      `${identityForwarded ? 'connected-identity-forwarded' : 'connected-identity-unverified'}:real-${missingClass}`;
    if (stopped || observed === observation) return;
    observed = observation;
    const actualLabel = opts.label === 'core' ? 'Core' :
      opts.label === 'plugins' ? 'Plugins' :
        opts.label === 'desktop' ? 'Desktop' : 'Core';
    (healthy && identityForwarded && (missingClass === 'none' || missingClass === 'not-provided') ? logInfo : logWarn)(
      `external route ${actualLabel}: ${!healthy ? 'check failed; verify service address and HTTP Host Header' :
        missing > 0 ? 'current endpoint verified but actual tool calls lack usable request identity' :
          missingClass === 'incomplete' ? 'current endpoint verified; real tool-call identity coverage incomplete' :
          missingClass === 'unavailable' ? 'current endpoint verified; real tool-call identity evidence unavailable' :
          identityForwarded ? 'current endpoint and diagnostic request header verified' :
            'current endpoint verified; x-request-id forwarding not verified'}`);
    const realIdentityWarning = missing > 0
      ? (missingClass === 'all' ? `Current real ${actualLabel} tool calls` :
          `Some real ${actualLabel} tool calls`) +
        ' lack a usable request identity. Those local results remain Unattributed without an independent exact join. ' +
        (identityForwarded
          ? 'Synthetic x-request-id forwarding passed, but it does not establish what the provider sent on actual calls.'
          : 'The external request-header forwarding path is also unverified.')
      : missingClass === 'incomplete'
        ? `Real ${actualLabel} tool-call identity history is incomplete; bounded older records may have been evicted. This cannot prove native tool-result attribution.`
        : missingClass === 'unavailable'
          ? `Real ${actualLabel} tool-call identity evidence is unavailable; the successful route check does not prove native tool-result attribution.`
          : null;
    opts.report({ state, publicUrl: healthy ? publicUrl : null,
      detail: healthy && realIdentityWarning ? realIdentityWarning : healthy && !identityForwarded
        ? 'Public route reaches this account’s MCP endpoint, but x-request-id forwarding was not verified. Check that the external HTTPS proxy preserves x-request-id; Core tool calls may remain Unattributed.'
        : healthy ? 'Public route verified against this account’s current MCP endpoint.'
        : 'External route check failed. Check the tunnel’s local service address and HTTP Host Header. The local MCP server is still running.' });
  };
  const check = async () => {
    if (stopped) return;
    const current = new AbortController();
    controller = current;
    const timeout = setTimeout(() => current.abort(), 5_000);
    timeout.unref?.();
    try {
      // Path- and method-selective proxies can route GET metadata correctly while
      // stripping identity from actual MCP POSTs. Prove an EMPTY, non-dispatching
      // POST at the exact MCP path; metadata retains its ordinary GET method.
      let healthy = true;
      let identityForwarded = false;
      for (const [url, expectedStatus] of [[publicUrl, 204], [metadataUrl, 200]] as const) {
        if (stopped || current.signal.aborted) { healthy = false; break; }
        const probeId = url === publicUrl ? `wfr_cos_probe_${randomBytes(16).toString('hex')}` : null;
        const probe = async (identity: string | null): Promise<{ verified: boolean; forwarded: boolean }> => {
          const challenge = randomBytes(32).toString('hex');
          try {
            const response = await fetch(url, { method: url === publicUrl ? 'POST' : 'GET', headers: {
              [EXTERNAL_TUNNEL_CHALLENGE_HEADER]: challenge,
              ...(identity ? { 'x-request-id': `${identity}/route-check` } : {})
            }, redirect: 'error', cache: 'no-store', signal: current.signal });
            const verified = response.status === expectedStatus &&
              verifyProof(new URL(url).pathname, challenge, response.headers.get(EXTERNAL_TUNNEL_PROOF_HEADER));
            const forwarded = Boolean(identity && verified && response.headers.get(EXTERNAL_TUNNEL_REQUEST_ID_DIGEST_HEADER) ===
              createHash('sha256').update(identity).digest('hex'));
            await response.body?.cancel();
            return { verified, forwarded };
          } catch { return { verified: false, forwarded: false }; }
        };
        let result = await probe(probeId);
        // Some user-owned reverse proxies reject unfamiliar request headers outright.
        // Confirm the current signed route once without the synthetic identity header
        // before reporting it offline. A valid fallback keeps Core usable but reports
        // that request attribution remains unverified; no Send/retry is triggered.
        if (!result.verified && probeId && !stopped && !current.signal.aborted)
          result = await probe(null);
        if (!result.verified || current.signal.aborted) { healthy = false; break; }
        if (probeId) identityForwarded = result.forwarded;
      }
      publish(healthy && !current.signal.aborted, identityForwarded);
    } catch { publish(false, false); }
    finally {
      clearTimeout(timeout);
      if (controller === current) controller = undefined;
      if (!stopped) { timer = setTimeout(() => void check(), 15_000); timer.unref?.(); }
    }
  };
  logInfo(`external route ${opts.label ?? 'core'}: proof checks starting`);
  opts.report({ state: 'connecting-tunnel', detail: 'Checking the configured external route…', publicUrl: null });
  void check();
  return { stop: async () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    logInfo(`external route ${opts.label ?? 'core'}: proof checks stopped; user-managed connector retained`);
  } };
}

// ------------------------------------------------------------------ OpenAI

/** How often /readyz is re-checked once the tunnel is up. */
const WATCH_INTERVAL_MS = 15_000;
/** How long a fresh tunnel-client gets to reach ready before we call it a failure. */
const READY_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
/** How often to look again while the control plane is unreachable. */
const OFFLINE_RECHECK_MS = 5_000;
/**
 * How long a run of "cannot reach OpenAI" complaints must go without a completed poll
 * before the user is told the connection is down.
 *
 * One failed poll is not an outage. The client long-polls with a 30s timeout and retries
 * on its own backoff, so a single dropped read — routine on home Wi-Fi — used to flip the
 * UI to offline and log an alarming pair of lines, with "tunnel connected" following six
 * seconds later. Nothing had been wrong. What proves an outage is not the complaint, it
 * is the last *completed* poll failing to advance while the complaints keep coming, so a
 * run has to outlive a full poll cycle before it counts.
 */
const UNREACHABLE_CONFIRM_MS = 35_000;

/**
 * How long /readyz has to keep failing before the client is killed and replaced.
 *
 * The same reasoning as UNREACHABLE_CONFIRM_MS above, applied to the far more expensive
 * action. That one governs a *caption*; this one governs terminating the process every live
 * tool call is travelling through. A single missed probe used to be enough: /readyz is asked
 * once, with a three-second timeout and no retry, and one `false` terminated the client. Any
 * request in flight died with it, the model went on waiting for an answer that could no longer
 * arrive, and the chat ended on ChatGPT's own "Message delivery timed out. Please try again."
 *
 * A probe can miss for reasons that are not a broken client — the client is mid-transfer, the
 * machine is briefly loaded, the readiness check's own downstream probe is slow. Requiring the
 * failure to survive into a second watch pass costs a genuinely dead client one extra interval
 * before it is replaced, and costs a healthy one nothing at all.
 */
const UNREADY_CONFIRM_MS = 15_000;

/** A run of unreachable complaints not yet contradicted by a completed poll. */
export interface UnreachableRun {
  /** When the run began, or 0 when there is no run in progress. */
  since: number;
  /** The last completed poll known when it began; null if there had never been one. */
  handshakeBefore: number | null;
}

export const NO_OUTAGE: UnreachableRun = { since: 0, handshakeBefore: null };

/** True once a run has gone unanswered long enough to be an outage, not a retry. */
export function outageConfirmed(run: UnreachableRun, nowMs: number): boolean {
  return run.since !== 0 && nowMs - run.since >= UNREACHABLE_CONFIRM_MS;
}

/**
 * True when a poll has completed since the run began, which ends it.
 *
 * A run that started before the client had ever polled successfully ends on the first
 * success of any age; otherwise the timestamp has to have actually moved.
 */
export function outageRecovered(run: UnreachableRun, lastHandshake: number | null): boolean {
  if (run.since === 0 || lastHandshake === null) return false;
  return run.handshakeBefore === null || lastHandshake > run.handshakeBefore;
}

export type RouteObservation = 'connected' | 'offline' | 'unknown';

/** Missing metrics prove neither recovery nor failure; a readable zero is a ready first poll. */
export function routeObservation(
  read: number | null,
  lastHandshake: number | null,
  run: UnreachableRun,
  nowMs: number
): RouteObservation {
  if (read === null) return 'unknown';
  if (outageConfirmed(run, nowMs)) return 'offline';
  if (lastHandshake === null) return 'connected';
  return nowMs - lastHandshake > POLL_FRESH_MS ? 'offline' : 'connected';
}

/**
 * Runs tunnel-client and keeps it running.
 *
 * The previous version reported "connected" once and then never looked again, so a
 * tunnel that died — or came up and later went unready — left the app claiming to be
 * connected while ChatGPT got nothing. Readiness is therefore re-checked on a timer
 * for as long as the connection is meant to be up, and a client that stops or goes
 * unready is restarted with backoff instead of being abandoned.
 */
async function startOpenAiTunnel(opts: TunnelStartOptions): Promise<TunnelHandle> {
  const binary = locateBinary('tunnel-client', opts.settings.binaryPath);
  if (!binary) {
    throw new TunnelError(
      'tunnel-client was not found. Install it from github.com/openai/tunnel-client, or point at it in Connection settings.'
    );
  }
  if (!TUNNEL_ID_PATTERN.test(opts.settings.tunnelId)) {
    throw new TunnelError('Enter a tunnel ID that looks like tunnel_ followed by 32 hex characters.');
  }
  if (!opts.apiKey) {
    throw new TunnelError('Add your OpenAI tunnel API key first.');
  }

  const healthRoot = opts.healthRoot ?? os.tmpdir();
  await fs.mkdir(healthRoot, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(healthRoot, 'tunnel-'));
  const healthFile = path.join(workDir, 'health.url');

  const args = [
    'run',
    '--control-plane.tunnel-id',
    opts.settings.tunnelId,
    '--health.listen-addr',
    '127.0.0.1:0',
    '--health.url-file',
    healthFile,
    '--log.format',
    'json',
    '--log.level',
    'info'
  ];

  interface ClientRun {
    proc: ChildProcess;
    lastError: string;
    unreachableReason: string;
    outage: UnreachableRun;
    lastHandshake: number | null;
    /** When /readyz first failed in the current run of failures; 0 when it is answering. */
    unreadySince: number;
    pollErrors: number;
    healthBase: string | null;
    health: TunnelHealth | null;
    shown: 'connected' | 'offline' | 'unknown' | null;
    /** First connection belongs to this exact process; health reconnects do not move its route. */
    routed: boolean;
  }

  let stopped = false;
  let current: ClientRun | null = null;
  let timer: NodeJS.Timeout | null = null;
  let retirement: Promise<void> = Promise.resolve();
  /** Consecutive failed attempts, which is what the backoff grows on. */
  let attempts = 0;
  /** Names this connector in the log, since core and desktop both run one of these. */
  const tag = opts.label ? `${opts.label} tunnel` : 'tunnel';

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const showConnected = (run: ClientRun): void => {
    if (stopped || current !== run) return;
    const first = run.shown !== 'connected';
    run.shown = 'connected';
    if (first) logInfo(`${tag} connected`);
    if (!run.routed) { run.routed = true; noteTunnelClientConnected(); }
    // Re-reported on every tick, so the UI can show how fresh the proof is.
    opts.report({
      state: 'connected',
      detail: run.lastHandshake
        ? `Connected. Last verified handshake with OpenAI ${ago(run.lastHandshake)}. Pick the tunnel in ChatGPT.`
        : 'Connected. Pick the tunnel in ChatGPT.',
      handshakeAt: run.lastHandshake,
      health: run.health
    });
  };

  const showOffline = (run: ClientRun): void => {
    if (stopped || current !== run) return;
    const first = run.shown !== 'offline';
    run.shown = 'offline';
    if (first) {
      logWarn(`${tag} offline: ${run.unreachableReason} (last verified handshake ${ago(run.lastHandshake)})`);
    }
    // The state may be unchanged while the health snapshot advances. Re-report it so the UI
    // never freezes on the first offline sample.
    opts.report({
      state: 'offline',
      detail: `This PC cannot reach OpenAI — ${run.unreachableReason}. Last verified handshake ${ago(run.lastHandshake)}. ChatGPT cannot use the connector until it is back; the tunnel keeps retrying on its own.`,
      handshakeAt: run.lastHandshake,
      health: run.health
    });
  };

  const showUnknown = (run: ClientRun): void => {
    if (stopped || current !== run) return;
    run.shown = 'unknown';
    opts.report({
      state: 'connecting-tunnel',
      detail: 'Tunnel client is locally ready, but its OpenAI poll metrics are temporarily unavailable.',
      handshakeAt: run.lastHandshake,
      health: run.health
    });
  };

  /**
   * Refreshes the snapshot the UI shows, from the two local endpoints the client
   * publishes. Called on the same tick that decides connected-vs-offline, so the
   * numbers on screen are never older than the state next to them.
   */
  const refreshHealth = async (run: ClientRun): Promise<number | null | undefined> => {
    const base = run.healthBase;
    if (!base) return null;
    const [poll, client] = await Promise.all([readPollHealth(base), readClientStatus(base)]);
    if (stopped || current !== run) return undefined;
    if (poll?.lastSuccessMs) run.lastHandshake = poll.lastSuccessMs;
    // A poll completing after the complaints began is proof the link came back, so the
    // run ends here and the blip is never shown to anyone.
    if (outageRecovered(run.outage, run.lastHandshake)) {
      run.outage = NO_OUTAGE;
      run.unreachableReason = '';
    }
    run.health = {
      pollErrors: poll?.errors ?? null,
      uptimeSeconds: client?.uptimeSeconds ?? null,
      route: client?.route ?? null,
      probe: client?.probe ?? null,
      clientVersion: client?.version ?? null
    };
    if (poll && poll.errors !== null && poll.errors > run.pollErrors) {
      // Rate-limited by definition: only a rising count says anything new. Info, not
      // warn: the client retries these itself, and `showOffline` covers the case where
      // the retries stop working.
      logInfo(
        `${tag}: ${poll.errors - run.pollErrors} more poll error(s) from the control plane (${poll.errors} total)`
      );
      run.pollErrors = poll.errors;
    }
    return poll === null ? null : (poll.lastSuccessMs ?? 0);
  };

  /**
   * Records a "cannot reach OpenAI" complaint from the client's own log.
   *
   * Deliberately does not change what the user sees. The client retries these itself and
   * usually wins within seconds; `watch` is what decides, once the run has outlived a poll
   * cycle with nothing completing. One line per run is logged so a genuine outage still
   * leaves a trail, without a paragraph of Go socket text per attempt.
   */
  const noteUnreachable = (run: ClientRun, raw: string): void => {
    if (stopped || current !== run) return;
    const complainedAt = Date.now();
    run.unreachableReason = describeNetworkError(raw);
    if (run.outage.since === 0) {
      run.outage = { since: complainedAt, handshakeBefore: run.lastHandshake };
      logInfo(`${tag}: ${run.unreachableReason}; the client is retrying`);
    }
  };

  /** The caller that wins this CAS is the only restart owner for the process. */
  const restart = (run: ClientRun, detail: string, terminate: boolean): void => {
    if (stopped || current !== run) return;
    current = null;
    clearTimer();
    attempts += 1;
    const wait = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (attempts - 1));
    opts.report({
      state: 'connecting-tunnel',
      detail: `${detail} Reconnecting in ${Math.round(wait / 1000)}s…`
    });
    retirement = (async () => {
      const retired = !terminate || (await stopTree(run.proc));
      if (stopped) return;
      if (!retired) {
        // Starting B without proof that A stopped would create two owned tunnel trees. Fail
        // closed and let an explicit reconnect create a fresh supervisor instead.
        opts.report({
          state: 'tunnel-unavailable',
          detail: 'The previous tunnel client could not be stopped safely. Disconnect and reconnect to try again.'
        });
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        void launch();
      }, wait);
      timer.unref?.();
    })();
  };

  /**
   * Watches the client for as long as it is meant to be up.
   *
   * Two different failures have to be told apart. A client that goes unready is broken
   * and gets restarted. A client that cannot reach OpenAI is fine and is already
   * retrying — restarting it would only slow the recovery down — so that one is
   * reported and waited out. /readyz cannot distinguish them, because it stays green
   * while the machine is offline.
   *
   * What can distinguish them is the client's own poll metric. A readable metric plus
   * /readyz is enough for startup readiness while the first long poll is open; its first
   * timestamp separately verifies the OpenAI link. After that, freshness is the proof
   * used to detect a lost route. The log lines only supply the wording for *why* it is down.
   */
  const watch = (run: ClientRun): void => {
    if (stopped || current !== run || !run.healthBase) return;
    clearTimer();
    timer = setTimeout(
      () => {
        void (async () => {
          if (stopped || current !== run || !run.healthBase) return;
          const ready = await probe(`${run.healthBase}/readyz`);
          if (stopped || current !== run) return;
          if (!ready.ok) {
            const now = Date.now();
            if (run.unreadySince === 0) {
              run.unreadySince = now;
              logWarn(`${tag} did not answer its readiness check: ${ready.detail || 'no detail'} — rechecking before replacing it`);
              watch(run);
              return;
            }
            if (now - run.unreadySince < UNREADY_CONFIRM_MS) {
              watch(run);
              return;
            }
            logWarn(`${tag} went unready: ${ready.detail}`);
            restart(run, ready.detail || 'The tunnel stopped responding.', true);
            return;
          }
          // Answered: whatever the earlier miss was, it was not this client being down.
          if (run.unreadySince !== 0) {
            logInfo(`${tag} answered its readiness check again; not replacing it`);
            run.unreadySince = 0;
          }

          const read = await refreshHealth(run);
          if (read === undefined || stopped || current !== run) return;

          const observation = routeObservation(read, run.lastHandshake, run.outage, Date.now());
          if (observation === 'offline') {
            if (!run.unreachableReason) run.unreachableReason = 'it stopped answering';
            showOffline(run);
          } else if (observation === 'connected') {
            showConnected(run);
          } else {
            showUnknown(run);
          }
          watch(run);
        })();
      },
      run.shown === 'offline' ? OFFLINE_RECHECK_MS : WATCH_INTERVAL_MS
    );
    timer.unref?.();
  };

  const launch = async (): Promise<void> => {
    if (stopped || current) return;
    clearTimer();
    // A stale URL from the previous run would otherwise be read as this run's.
    await fs.rm(healthFile, { force: true }).catch(() => {});
    if (stopped || current) return;

    opts.report({
      state: 'connecting-tunnel',
      detail: attempts === 0 ? 'Starting tunnel client…' : 'Reconnecting…'
    });

    // The API key goes in the child's environment, never on the command line, so it
    // cannot be read out of the process list by other software on the machine.
    const discoveryHeaders = Object.entries(opts.discoveryHeaders ?? {})
      .map(([name, value]) => `${name}: ${value}`)
      .join(', ');
    const proc = spawn(binary, args, {
      // Keep both credentials and the secret local MCP path out of argv/process listings.
      // tunnel-client officially supports these environment-backed configuration fields.
      env: childEnv({
        CONTROL_PLANE_API_KEY: opts.apiKey ?? '',
        MCP_SERVER_URL: `url=${opts.localUrl},channel=main`,
        ...(discoveryHeaders ? { MCP_DISCOVERY_EXTRA_HEADERS: discoveryHeaders } : {})
      }),
      windowsHide: true,
      // Own a POSIX process group so stopTree terminates any helpers the client starts.
      // Windows uses taskkill /T and keeps its existing launch semantics.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const run: ClientRun = {
      proc,
      lastError: '',
      unreachableReason: '',
      outage: NO_OUTAGE,
      lastHandshake: null,
      unreadySince: 0,
      pollErrors: 0,
      healthBase: null,
      health: null,
      shown: null,
      routed: false
    };
    current = run;

    const handleLine = (line: string): void => {
      if (stopped || current !== run) return;
      const authFailure = AUTH_FAILURE.exec(line)?.[1];
      if (authFailure) {
        // A bad key or tunnel ID will not fix itself, so this one is terminal.
        // Retain only the bounded matcher category, never client output: an error line
        // can contain the API key, bearer tokens or the secret local MCP URL. Saying
        // which matcher fired also avoids claiming the underlying provider cause is proven.
        const category = authFailure.toLowerCase().replace(/[_ ]/g, '-');
        stopped = true;
        current = null;
        clearTimer();
        retirement = stopTree(proc).then(() => undefined);
        logWarn(`${tag} auth-failed: client output matched ${category}; automatic reconnect disabled; retiring owned client. Check the API key and tunnel ID in Connection settings.`);
        opts.report({
          state: 'auth-failed',
          detail: `The tunnel client reported ${category}; automatic reconnect is disabled. Check the API key, tunnel ID and tunnel access in Connection settings.`
        });
        return;
      }

      // tunnel-client emits structured JSON. Do not treat the mere presence of an
      // `error` field as an ERROR-level event: some healthy startup WARN records carry
      // internal diagnostics there. In particular, loopback Harpoon auto-registration
      // warnings are followed by a healthy /readyz and are not actionable for users.
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const level = String(event['level'] ?? '').toUpperCase();
        const message = String(event['msg'] ?? 'tunnel-client event');
        if (
          level === 'WARN' &&
          message === 'harpoon host auto-registration failed' &&
          event['inclusion_reason'] === 'loopback'
        ) {
          return;
        }
        if (level === 'ERROR' || level === 'FATAL' || level === 'WARN') {
          const errText = event['error'] ? String(event['error']) : '';
          run.lastError = `${level} ${message}${errText ? `: ${errText}` : ''}`.slice(0, 400);
          if (isUnreachableError(`${message}: ${errText}`)) {
            // Retry chatter. noteUnreachable logs one plain line per run rather than a
            // socket dump per attempt, and the state it leads to is decided in `watch`.
            noteUnreachable(run, errText || message);
          } else {
            logWarn(`${tag}: ${run.lastError}`);
          }
        }
        return;
      } catch {
        // Older clients or crash paths may still print plain text.
      }
      if (/\b(error|fatal|warn)\b/i.test(line)) {
        run.lastError = line.slice(0, 400);
        if (isUnreachableError(line)) noteUnreachable(run, line);
        else logWarn(`${tag}: ${run.lastError}`);
      }
    };

    proc.stdout.on('data', lineReader(handleLine));
    proc.stderr.on('data', lineReader(handleLine));

    proc.on('exit', (code) => {
      if (stopped || current !== run) return;
      logWarn(`${tag} client exited with code ${code}`);
      restart(run, run.lastError || `Tunnel client stopped (exit ${code}).`, false);
    });

    proc.on('error', (err) => {
      if (stopped || current !== run) return;
      logError(`${tag} client failed to start: ${err.message}`);
      restart(run, `Could not start tunnel-client: ${err.message}`, true);
    });

    // /readyz on the client's own health server is the authoritative "it works"
    // signal; the process being alive proves nothing.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!stopped && current === run && Date.now() < deadline) {
      const base = await readHealthUrl(healthFile);
      if (stopped || current !== run) return;
      if (base) {
        const ready = await probe(`${base}/readyz`);
        if (stopped || current !== run) return;
        if (ready.ok) {
          attempts = 0;
          run.healthBase = base;
          const read = await refreshHealth(run);
          if (read === undefined || stopped || current !== run) return;
          const observation = routeObservation(read, run.lastHandshake, run.outage, Date.now());
          if (observation === 'offline') {
            if (!run.unreachableReason) run.unreachableReason = 'it stopped answering';
            showOffline(run);
          } else if (observation === 'connected') {
            showConnected(run);
          } else {
            showUnknown(run);
          }
          watch(run);
          return;
        }
        run.lastError = ready.detail || run.lastError;
      }
      await delay(1000);
    }
    if (!stopped && current === run) {
      restart(run, run.lastError || 'The tunnel did not become ready within 60 seconds.', true);
    }
  };

  void launch();

  return {
    healthBase: () => current?.healthBase ?? null,
    stop: async () => {
      stopped = true;
      clearTimer();
      const active = current;
      current = null;
      await Promise.all([retirement, stopTree(active?.proc ?? null)]);
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}


async function readHealthUrl(file: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(file, 'utf8')).trim();
    return text.startsWith('http') ? text.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

interface ProbeResult {
  ok: boolean;
  /** The body tunnel-client returned, which names the reason it is not ready. */
  detail: string;
}

async function probe(url: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    // /readyz answers 503 with the reason in the body — "oauth discovery failed: …",
    // "mcp probe failed: …" — which is far more useful than a generic message.
    const body = await res.text().catch(() => '');
    return { ok: res.ok, detail: body.trim().slice(0, 200) };
  } catch {
    return { ok: false, detail: '' };
  } finally {
    clearTimeout(timer);
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- cloudflared

async function startCloudflared(opts: TunnelStartOptions): Promise<TunnelHandle> {
  const binary = locateBinary('cloudflared', opts.settings.binaryPath);
  if (!binary) {
    throw new TunnelError(
      'cloudflared was not found. It ships alongside tunnel-client, or install it from Cloudflare, then point at it in Connection settings.'
    );
  }

  const local = new URL(opts.localUrl);
  const origin = `${local.protocol}//${local.host}`;

  const args = [
    'tunnel',
    '--no-autoupdate',
    '--url',
    origin,
    // Without this the origin would see the public trycloudflare hostname and our
    // loopback Host check would reject the request.
    '--http-host-header',
    local.host
  ];

  opts.report({ state: 'connecting-tunnel', detail: 'Starting cloudflared…' });

  const child = spawn(binary, args, {
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Tunnel providers need the ordinary OS environment, never credentials inherited
    // from a terminal that happened to launch Electron.
    env: childEnv()
  });

  let settled = false;
  let stopped = false;
  let lastError = '';

  const handleLine = (line: string): void => {
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line);
    if (match && !settled) {
      settled = true;
      const publicUrl = `${match[0]}${local.pathname}`;
      logInfo('quick tunnel connected');
      opts.report({
        state: 'connected',
        detail: 'Connected. Paste the URL below into ChatGPT as a custom connector.',
        publicUrl
      });
      return;
    }
    if (/\berr\b|\berror\b|\bfatal\b/i.test(line)) {
      lastError = line.slice(0, 400);
      logWarn(`cloudflared: ${lastError}`);
    }
  };

  child.stdout.on('data', lineReader(handleLine));
  child.stderr.on('data', lineReader(handleLine));

  child.on('exit', (code) => {
    if (stopped) return;
    settled = true;
    opts.report({
      state: 'tunnel-unavailable',
      detail: lastError || `cloudflared stopped (exit ${code}).`
    });
  });
  child.on('error', (err) => {
    settled = true;
    opts.report({ state: 'tunnel-unavailable', detail: `Could not start cloudflared: ${err.message}` });
  });

  const startupTimer = setTimeout(() => {
    if (!settled && !stopped) {
      opts.report({
        state: 'tunnel-unavailable',
        detail: lastError || 'cloudflared did not report a public URL within 45 seconds.'
      });
    }
  }, 45_000);
  startupTimer.unref?.();

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(startupTimer);
      await stopTree(child);
    }
  };
}

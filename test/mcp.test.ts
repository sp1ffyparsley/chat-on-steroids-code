/**
 * End-to-end test of the real MCP endpoint over real HTTP.
 *
 * Nothing here is mocked: it starts the same server the app starts, and speaks the
 * same wire protocol ChatGPT speaks. It covers both protocol eras the SDK serves —
 * the 2025-era requests ChatGPT sends today, and the 2026-07-28 envelope form — so
 * that a change in which era the client uses cannot silently break the connector.
 *
 * The other thing it exists to prove is the surface split. This app publishes two
 * independently discoverable MCP servers, Core and Desktop, and the whole point of that
 * design is that the boundary is *real*: a no-query tools/list against Core must not
 * reveal a single Desktop schema, and a Core tools/call for a Desktop tool must fail as
 * an unknown tool rather than being quietly forwarded. Those assertions live in
 * "surface boundaries" below and are the ones to look at first if this file goes red.
 */

import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectiveCapabilities, defaultConfig, getConfig } from '../src/main/config.js';
import { lastRequestAt, recentMcpIngress, selfTestHeaders, startMcpServer, tunnelProbeHeaders, type McpEndpoint } from '../src/main/mcp/server.js';
import { lastToolCallAt, type ToolContext } from '../src/main/mcp/tools.js';
import { dispatch, friendlyError, recentToolDispatches } from '../src/main/mcp/kernel.js';
import { publishedSurfaceIds, surfaceDeclaredTools, SURFACE_LIST, surfaceDefinition, type SurfaceId } from '../src/main/mcp/surfaces.js';
import {
  appendEvent,
  createSession,
  initSessionStore,
  rebindSession,
  readEvents,
  readSessionPlan,
  updateSessionPlan,
  upsertMessageEvent,
  writeOverflowText
} from '../src/main/session/store.js';
import { resetWorkspaces, setWorkspaceFor } from '../src/main/workspace.js';
import { DEFAULT_CAPABILITIES, type Capabilities, type Root } from '../src/shared/types.js';
import type { SessionEvent, ToolOutcome } from '../src/shared/session.js';
import { emptyEvidence, noteExec, noteOutcome, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { observeRequestCorrelation, requestCorrelation } from '../src/main/session/correlation.js';
import { moveGoalObjective, setGoalObjectiveNow } from '../src/main/goal.js';
import { prepareHandoff, resumeBootstrapText } from '../src/main/session/handoff.js';
import { WINDOWS_COMPUTER_METHODS, WINDOWS_COMPUTER_READ_METHODS } from '../src/shared/windows-computer.js';
import { BROWSER_TOOLS, BROWSER_READ_TOOLS } from '../src/shared/browser-control.js';
import { resetBlockedChatsForTests, setChatBlocked } from '../src/main/session/blocked-chats.js';
import {
  abortContinuation,
  attachSummary,
  dispatchContinuationSourceSendNow,
  beginContinuationSourceSendNow,
  openContinuationNow,
  resetContinuationsForTests
} from '../src/main/session/continuation.js';
import {
  backdateExecAttendanceForTests,
  backgroundExecObligations,
  execOwner,
  MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION,
  noteExecOwner,
  forgetExecOwner,
  resetExecOwnershipForTests,
  UNATTENDED_EXEC_NOTICE_MS
} from '../src/main/codex/ownership.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { locateRipgrep } from '../src/main/ripgrep.js';
import { IS_WINDOWS, makeTempDir, removeTempDir, writeTree } from './helpers.js';
import { initDurableStore, readDurableStrict, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { onLog, initLogFile, flushLogFile, flushLocalIncidents, listLocalIncidents, resetLoggerForTests } from '../src/main/logger.js';
import { startTunnel, type TunnelHandle } from '../src/main/tunnel/index.js';

// ---------------------------------------------------------------- transport

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function rawPost(
  urlStr: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function rawGet(urlStr: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Streamable HTTP may answer as JSON or as a one-shot SSE stream. Accept both. */
function decode(res: RawResponse): any {
  const text = res.text.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const datas = [...text.matchAll(/^data:\s*(.*)$/gm)].map((m) => m[1] ?? '');
  const last = datas.at(-1);
  if (last !== undefined) {
    try {
      return JSON.parse(last);
    } catch {
      return text;
    }
  }
  return text;
}

let nextId = 1;

/**
 * A 2025-era request to one surface: a plain JSON-RPC body with no _meta envelope.
 *
 * Every request names its surface, because "which server answered" is the property most
 * of this file is about. There is no default-surface helper on purpose.
 */
async function call(surface: SurfaceId, method: string, params: unknown = {}): Promise<any> {
  const res = await rawPost(
    endpoint.urls[surface],
    JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  );
  return { status: res.status, body: decode(res) };
}

const core = (method: string, params: unknown = {}): Promise<any> => call('core', method, params);
/**
 * Desktop capability is a public connector on non-Windows hosts. Windows now serves the same
 * incumbent handlers through Core; project only that subset for the capability-focused tests
 * below, while dedicated surface tests inspect the full merged Core list.
 */
const desktop = async (method: string, params: unknown = {}): Promise<any> => {
  if (!IS_WINDOWS) return call('desktop', method, params);
  const reply = await call('core', method, params);
  if (method !== 'tools/list' || !Array.isArray(reply.body?.result?.tools)) return reply;
  const names = new Set(surfaceDefinition('desktop').tools);
  const projected = reply.body.result.tools.filter((tool: any) => names.has(tool.name));
  if (projected.length === 1 && projected[0]?.name === 'exec') projected.length = 0;
  return {
    ...reply,
    body: { ...reply.body, result: { ...reply.body.result, tools: projected } }
  };
};

const { REASONING_EFFORTS } = await import('../src/shared/session.js');
const PROTOCOL_2026 = '2026-07-28';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

/**
 * A 2026-07-28 request: the per-request _meta envelope plus the SEP-2243 standard
 * headers the spec requires the client to mirror the body with.
 */
async function modern(
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {}
): Promise<any> {
  const body = {
    jsonrpc: '2.0',
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        [META_VERSION]: PROTOCOL_2026,
        [META_CAPABILITIES]: {}
      }
    }
  };
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': PROTOCOL_2026,
    'Mcp-Method': method,
    ...extraHeaders
  };
  if (method === 'tools/call' && typeof params['name'] === 'string' && !('Mcp-Name' in headers)) {
    headers['Mcp-Name'] = params['name'];
  }
  const res = await rawPost(endpoint.urls.core, JSON.stringify(body), headers);
  return { status: res.status, headers: res.headers, body: decode(res) };
}

const toolNames = (reply: any): string[] =>
  ((reply.body?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name).sort();

const toolList = (reply: any): Array<Record<string, any>> => (reply.body?.result?.tools ?? []) as Array<Record<string, any>>;

const textOf = (reply: any): string =>
  ((reply.body?.result?.content ?? []) as Array<{ type: string; text?: string }>)
    .filter(c => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

const failed = (reply: any): boolean => reply.body?.error !== undefined || reply.body?.result?.isError === true;

/** A patch that only adds one file, which is the cheapest way to prove apply_patch ran. */
const addPatch = (virtualPath: string, lines: string[]): string =>
  ['*** Begin Patch', `*** Add File: ${virtualPath}`, ...lines.map((line) => `+${line}`), '*** End Patch'].join('\n');

// ------------------------------------------------------------------ fixture

let base: string;
let approved: string;
let outside: string;
let endpoint: McpEndpoint;
let ctx: ToolContext;

function withCaps(overrides: Partial<Capabilities>): Capabilities {
  return { ...DEFAULT_CAPABILITIES, ...overrides };
}

/** Everything the user could possibly switch on, which is the worst case for discovery. */
function allCaps(): Capabilities {
  const caps = { ...DEFAULT_CAPABILITIES };
  for (const key of Object.keys(caps) as Array<keyof Capabilities>) caps[key] = true;
  return caps;
}

beforeAll(async () => {
  base = await makeTempDir('clf-mcp-');
  // This suite calls real tools, and calling a tool records it. Recording is on by
  // default now, so without a directory of its own the recorder wrote session folders
  // into the process's working directory — which for a test run is the repository.
  initDurableStore(base);
  initSessionStore(base);
  approved = path.join(base, 'workspace');
  outside = path.join(base, 'private');
  await writeTree(approved, {
    'notes.txt': Array.from({ length: 50 }, (_, i) => `note line ${i + 1}`).join('\n') + '\n',
    'src/app.ts': 'export const name = "app";\n',
    'src/lib/util.ts': 'export const helper = 1;\n',
    'node_modules/pkg/noise.js': 'generated dependency noise\n'
  });
  await writeTree(outside, { 'passwords.txt': 'hunter2' });
  await fs.writeFile(
    path.join(approved, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  );

  ctx = {
    roots: [{ name: 'workspace', path: approved }] as Root[],
    caps: withCaps({}),
    readOnly: true,
    // Stated rather than inherited from the saved config. These two are whole features
    // with their own defaults — recording now starts on — and a capability-gating test
    // that silently changes meaning when a product default moves is not testing gating.
    // The tools they add are covered by their own suites.
    sessionTools: false,
    agentTools: false
  };
});

afterAll(async () => {
  if (endpoint) await endpoint.stop();
  // Every live exec test uses UnifiedExecProcessManager. The old teardown still stopped the
  // retired connector-native process manager, which meant it looked like this suite protected
  // the fixture from leaked shells while production sessions were completely untouched.
  await unifiedExecManager.terminateAllProcesses();
  resetDurableForTests();
  await removeTempDir(base);
});

beforeEach(async () => {
  if (endpoint) await endpoint.stop();
  resetWorkspaces();
  ctx.caps = withCaps({});
  ctx.readOnly = true;
  ctx.roots = [{ name: 'workspace', path: approved }];
  ctx.sessionTools = false;
  ctx.agentTools = false;
  // A fresh endpoint gives every test a fresh ChatGPT tool-surface snapshot. Tests
  // that change permissions mid-flight still exercise the real live-config path.
  endpoint = await startMcpServer(() => ctx);
});

// ------------------------------------------------------------------- tests

describe('endpoint hardening', () => {
  it('does not expose native paths from uncommon filesystem errors', () => {
    const error = Object.assign(new Error(`ELOOP: too many symbolic links, realpath '${approved}\\loop\\file.txt'`), {
      code: 'ELOOP',
      path: path.join(approved, 'loop', 'file.txt'),
      syscall: 'realpath'
    });
    const text = friendlyError(error);
    expect(text).toBe('Filesystem error (ELOOP)');
    expect(text).not.toContain(approved);
  });

  it('binds to loopback only, and gives every surface its own path', () => {
    for (const id of publishedSurfaceIds()) {
      const url = endpoint.urls[id];
      expect(url.startsWith('http://127.0.0.1:'), id).toBe(true);
      expect(new URL(url).pathname.startsWith(`/mcp/${id}/`), id).toBe(true);
    }
    expect(endpoint.url).toBe(endpoint.urls.core);
    if (IS_WINDOWS) expect(endpoint.urls.desktop).toBe('');
    else expect(endpoint.urls.core).not.toBe(endpoint.urls.desktop);
  });

  it('gives each surface its own token, so handing out one does not hand out the other', async () => {
    const coreUrl = new URL(endpoint.urls.core);
    if (IS_WINDOWS) {
      expect(endpoint.urls.desktop).toBe('');
      const coreToken = coreUrl.pathname.split('/').pop() ?? '';
      coreUrl.pathname = `/mcp/desktop/${coreToken}`;
      expect((await rawPost(coreUrl.toString(), '{}')).status).toBe(404);
      return;
    }
    const desktopUrl = new URL(endpoint.urls.desktop);
    const coreToken = coreUrl.pathname.split('/').pop() ?? '';
    const desktopToken = desktopUrl.pathname.split('/').pop() ?? '';
    expect(coreToken).not.toBe(desktopToken);

    // Knowing Core's token must not be enough to reach Desktop. This is the property that
    // makes "share the Desktop connector" and "share everything" different acts.
    const swapped = new URL(endpoint.urls.desktop);
    swapped.pathname = `/mcp/desktop/${coreToken}`;
    const res = await rawPost(swapped.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('serves nothing at a path without the secret token', async () => {
    const wrong = new URL(endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/', '/mcp/core', '/mcp/core/', '/mcp/core/wrong-token', '/mcp/desktop/wrong']) {
      wrong.pathname = p;
      const res = await rawPost(wrong.toString(), '{}');
      expect(res.status, p).toBe(404);
    }
  });

  it('rejects a token of the right length but the wrong value', async () => {
    const url = new URL(endpoint.urls.core);
    const token = url.pathname.split('/').pop() ?? '';
    // Same length, so the comparison itself has to reject it.
    url.pathname = `/mcp/core/${'A'.repeat(token.length)}`;
    const res = await rawPost(url.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('rejects a non-loopback Host header on every surface', async () => {
    for (const id of publishedSurfaceIds()) {
      const res = await rawPost(
        endpoint.urls[id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { host: 'files.example.com' }
      );
      expect(res.status, id).toBeGreaterThanOrEqual(400);
      expect(res.status, id).toBeLessThan(500);
    }
  });

  it('rejects a cross-site Origin header on every surface', async () => {
    for (const id of publishedSurfaceIds()) {
      const res = await rawPost(
        endpoint.urls[id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { origin: 'https://evil.example.com' }
      );
      expect(res.status, id).toBeGreaterThanOrEqual(400);
      expect(res.status, id).toBeLessThan(500);
    }
  });

  it('never answers with a non-JSON body, whatever is asked for', async () => {
    // tunnel-client's OAuth discovery decodes these bodies as JSON regardless of the
    // status code. A plain-text "Not found" here is what broke discovery outright.
    const url = new URL(endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/core', '/favicon.ico', '/.well-known/oauth-protected-resource']) {
      url.pathname = p;
      const res = await rawGet(url.toString());
      expect(res.status, p).toBe(404);
      expect(res.headers['content-type'], p).toContain('application/json');
      expect(() => JSON.parse(res.text), p).not.toThrow();
    }
  });

  it('separates "ChatGPT arrived" from "ChatGPT was allowed to run a tool"', async () => {
    // The whole point of keeping two clocks: a connect that handshakes and lists
    // tools but never calls one is what Developer mode being off looks like here,
    // and it is indistinguishable from success on every other signal.
    expect(lastRequestAt()).toBeNull();
    expect(lastToolCallAt()).toBeNull();

    await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' }
    });
    await core('tools/list');
    expect(lastRequestAt()).not.toBeNull();
    expect(lastToolCallAt()).toBeNull();

    await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('counts a request to either surface as ChatGPT reaching this PC', async () => {
    expect(lastRequestAt()).toBeNull();
    await desktop('tools/list');
    expect(lastRequestAt()).not.toBeNull();
  });

  // Separate public connectors keep separate clocks. Windows Desktop calls intentionally land
  // on Core now, so the historical Desktop clock stays empty on that host.
  it('keeps a separate arrival and tool-call clock per surface', async () => {
    expect(lastRequestAt('core')).toBeNull();
    expect(lastRequestAt('desktop')).toBeNull();

    await core('tools/list');
    expect(lastRequestAt('core')).not.toBeNull();
    expect(lastRequestAt('desktop')).toBeNull();
    expect(lastToolCallAt('core')).toBeNull();

    await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(lastToolCallAt('core')).not.toBeNull();
    expect(lastToolCallAt('desktop')).toBeNull();

    ctx.caps = withCaps({ screen: true });
    await desktop('tools/list');
    if (IS_WINDOWS) {
      expect(lastRequestAt('core')).not.toBeNull();
      expect(lastRequestAt('desktop')).toBeNull();
    } else {
      expect(lastRequestAt('desktop')).not.toBeNull();
      expect(lastToolCallAt('desktop')).toBeNull();
    }
  });

  it('retains bounded request-id evidence for exact Core incident attribution', async () => {
    const requestId = 'wfr_incident_exact';
    // Ensure this requested window begins after the fresh endpoint's coverage boundary even
    // when startup and the test initially share one millisecond.
    const coverageBoundary = Date.now();
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(coverageBoundary), { timeout: 1000, interval: 1 });
    const since = Date.now();
    await modern(
      'tools/call',
      { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } },
      { 'x-request-id': `${requestId}/att1` }
    );

    const ingress = recentMcpIngress('core', since);
    const dispatches = recentToolDispatches('core', since);
    expect(ingress.complete).toBe(true);
    expect(ingress.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: 'core', requestId, methods: ['tools/call'] })
    ]));
    expect(dispatches.complete).toBe(true);
    expect(dispatches.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: 'core', requestId })
    ]));
    expect(recentMcpIngress('desktop', since).records).toEqual([]);
    expect(recentToolDispatches('desktop', since).records).toEqual([]);
  });

  it('retains typed envelope digests without granting missing-header attribution or retaining parameters', async () => {
    const since = Date.now();
    const observed: string[] = [];
    const unsubscribe = onLog(row => { if (row.message.includes('identity_header=')) observed.push(row.message); });
    try {
      for (const id of [1, '1', '61146aee-33b7-49d7-82fc-2535775c7626']) {
        await rawPost(endpoint.urls.core, JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
          params: { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] },
            _meta: { 'private-diagnostic-key': 'never-retain-this-secret' } } }));
      }
      const rows = recentMcpIngress('core', since).records.filter(row => row.methods.includes('tools/call'));
      expect(rows).toHaveLength(3);
      for (const [index, id] of [1, '1', '61146aee-33b7-49d7-82fc-2535775c7626'].entries()) {
        expect(rows[index]).toMatchObject({ requestId: null, rpcIdentity: {
          kind: typeof id,
          sha256: createHash('sha256').update(JSON.stringify([typeof id, id])).digest('hex')
        } });
      }
      expect(recentToolDispatches('core', since).records.every(row => row.requestId === null)).toBe(true);
      await vi.waitFor(() => expect(observed).toHaveLength(3), { timeout: 1000, interval: 10 });
      expect(observed.every(row => row.includes('rpc_id_kind=') &&
        row.includes('rpc_id_fingerprint=') && !row.includes('rpc_id_sha256='))).toBe(true);
      for (const [index, id] of [1, '1', '61146aee-33b7-49d7-82fc-2535775c7626'].entries()) {
        const prefix = createHash('sha256').update(JSON.stringify([typeof id, id])).digest('hex').slice(0, 16);
        expect(observed[index]).toContain(`rpc_id_fingerprint=${prefix}`);
      }
      const retained = JSON.stringify({ rows, observed });
      for (const secret of ['never-retain-this-secret', 'private-diagnostic-key', '/workspace/src/app.ts',
        '61146aee-33b7-49d7-82fc-2535775c7626']) expect(retained).not.toContain(secret);
    } finally { unsubscribe(); }
  });

  it('keeps real returned Core results with their exact original session epoch instead of acknowledging a stale same-conversation request as newer work', async () => {
    const { flushRecorder } = await import('../src/main/session/recorder.js');
    const conversationId = 'mcp-exact-native-session-epoch';
    const previous = await createSession({ conversationId });
    const originalId = 'wfr_mcp_real_original_epoch';
    const newerId = 'wfr_mcp_real_current_epoch';
    const prove = (requestId: string, sessionId: string, messageId: string) =>
      observeRequestCorrelation({ requestId, conversationId, sessionId,
        messageId, tool: 'read', observedAt: Date.now() });
    const send = (requestId: string) => modern('tools/call', {
      name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
    }, { 'x-request-id': `${requestId}/attempt1` });

    expect(prove(originalId, previous.id, 'native-original-read')).toBe('stored');
    const first = await send(originalId);
    expect(failed(first)).toBe(false);
    await flushRecorder();
    expect((await readEvents(previous.id, { kinds: ['tool_call'] }))
      .filter(row => row.kind === 'tool_call' && row.call.requestId === originalId)).toHaveLength(1);

    // This is a new local session for the same native conversation. An old tab
    // or duplicate callback cannot move a previously returned Core result into it.
    const newer = await createSession({ conversationId });
    expect(prove(originalId, newer.id, 'native-stale-read')).toBe('refused');
    expect(requestCorrelation(originalId)).toMatchObject({
      conversationId, sessionId: previous.id, messageId: 'native-original-read'
    });
    expect(prove(newerId, newer.id, 'native-new-read')).toBe('stored');
    const current = await send(newerId);
    expect(failed(current)).toBe(false);
    await flushRecorder();
    const freshEvents = await readEvents(newer.id, { kinds: ['tool_call'] });
    expect(freshEvents.filter(row => row.kind === 'tool_call' &&
      row.call.requestId === newerId &&
      row.call.conversationId === conversationId &&
      row.call.attributionMethod === 'request_id')).toHaveLength(1);
    expect(freshEvents.some(row => row.kind === 'tool_call' &&
      row.call.requestId === originalId)).toBe(false);
    expect((await readEvents(previous.id, { kinds: ['tool_call'] }))
      .filter(row => row.kind === 'tool_call' && row.call.requestId === originalId)).toHaveLength(1);
  });

  it('returns a durable structured Core receipt without inventing a materializable file attachment', async () => {
    // Exercise publication after the real durable append without making this
    // shape/authority test also benchmark H: against the separate 200ms settle
    // deadline. The explicit withheld-append test below proves that deadline
    // still returns no receipt, including after the late append completes.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const returned = await modern('tools/call', {
        name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
      });
      expect(returned.status).toBe(200);
      expect(failed(returned)).toBe(false);
      expect(textOf(returned)).toContain('note line 1');
      const witness = returned.body?.result?.structuredContent?.cosResultReceipt;
      expect(witness).toEqual({ version: 1, id: expect.stringMatching(/^[a-f0-9]{48}$/) });
      // Metadata is not a user-requested file. ChatGPT materializes embedded
      // resources behind approval cards and can re-run a call after approval.
      // Keep proof in the post-commit structured result; a host which drops it
      // remains unverified rather than gaining a fake attachment or text marker.
      expect(returned.body.result.content.filter((part: any) => part.type === 'resource')).toEqual([]);

      expect(textOf(returned)).not.toContain('COS_RESULT_RECEIPT_V1=');
    } finally { vi.useRealTimers(); }
  });

  it('strips echoed reserved receipt carriers before recording or post-commit publication, preserving ordinary resources', async () => {
    const { flushRecorder } = await import('../src/main/session/recorder.js');
    const { indexedSessions } = await import('../src/main/session/store.js');
    const oldId = 'ed'.repeat(24);
    const echoed = { type: 'resource' as const, resource: {
      uri: 'urn:cos:result-receipt:v1:' + oldId,
      mimeType: 'application/vnd.chat-on-steroids.result-receipt+json',
      text: JSON.stringify({ version: 1, id: oldId })
    } };
    const ordinary = { type: 'resource' as const, resource: {
      uri: 'file:///workspace/notes.txt', mimeType: 'text/plain', text: 'ordinary resource data'
    } };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const returned = await dispatch('read', {}, null, null, 'core', async () => ({
        content: [{ type: 'text', text: 'handler output' }, echoed,
          { ...echoed, resource: { ...echoed.resource, mimeType: 'text/plain' } },
          { ...echoed, resource: { ...echoed.resource, uri: 'file:///pretend-receipt' } }, ordinary],
        structuredContent: { cosResultReceipt: { version: 1, id: oldId }, useful: 'preserved' }
      }));
      const witness = (returned.structuredContent!.cosResultReceipt as { version: number; id: string });
      expect(witness).toEqual({ version: 1, id: expect.stringMatching(/^[a-f0-9]{48}$/) });
      expect(witness.id).not.toBe(oldId);
      expect(returned.structuredContent!.useful).toBe('preserved');
      expect(returned.content.filter(part => part.type === 'resource')).toEqual([ordinary]);
      await flushRecorder();
      const rows: SessionEvent[] = [];
      for (const session of await indexedSessions({ requireComplete: true }))
        rows.push(...await readEvents(session.id, { kinds: ['tool_call'], requireIntegrity: true }));
      const recorded = rows.filter(row => row.kind === 'tool_call' && row.call.resultReceiptId === witness.id);
      expect(recorded).toHaveLength(1);
      expect(JSON.stringify(recorded)).not.toContain(oldId);
      expect(JSON.stringify(recorded)).not.toContain('urn:cos:result-receipt:');
    } finally { vi.useRealTimers(); }
  });

  it('distinguishes one durably emitted headerless Core receipt from one failed recorder append at the real HTTP response boundary', async () => {
    const observed: string[] = [];
    const unsubscribe = onLog(row => {
      if (row.message.includes('identity_header=')) observed.push(row.message);
    });
    const store = await import('../src/main/session/store.js');
    try {
      const succeeded = await modern('tools/call', {
        name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
      });
      expect(succeeded.status).toBe(200);
      expect(failed(succeeded)).toBe(false);
      const receipt = succeeded.body?.result?.structuredContent?.cosResultReceipt?.id as string;
      expect(receipt).toMatch(/^[a-f0-9]{48}$/);
      await vi.waitFor(() => expect(observed).toHaveLength(1));
      expect(observed[0]).toContain('core_result_receipt=committed_structured');
      expect(observed[0]).toContain('identity_header=missing');
      expect(observed[0]).not.toContain(receipt);

      const failure = vi.spyOn(store, 'appendEvent').mockImplementationOnce(async () => {
        throw Object.assign(new Error('private fixture error and path'), { code: 'ENOSPC' });
      });
      let unrecorded: Awaited<ReturnType<typeof modern>>;
      try {
        unrecorded = await modern('tools/call', {
          name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
        });
      } finally { failure.mockRestore(); }
      expect(unrecorded!.status).toBe(200);
      expect(failed(unrecorded!)).toBe(false);
      expect(textOf(unrecorded!)).toContain('note line 1');
      expect(unrecorded!.body?.result?.structuredContent?.cosResultReceipt).toBeUndefined();
      expect(unrecorded!.body.result.content.some((part: any) => part.type === 'resource')).toBe(false);
      await vi.waitFor(() => expect(observed).toHaveLength(2));
      expect(observed[1]).toContain('core_result_receipt=recorder_unverified');
      expect(observed[1]).toContain('identity_header=missing');
      expect(observed.join('\n')).not.toContain('private fixture error and path');
      expect(observed.join('\n')).not.toContain('/workspace/notes.txt');

      // An exact native owner now receives the same per-execution durable
      // witness. Publishing it is still not a remote native-result ACK.
      const headeredRequestId = 'wfr_receipt_diagnostic_headered';
      await (await import('../src/main/session/recorder.js')).recordRequestEvidence(randomUUID(), [{
        kind: 'tool_evidence', time: Date.now(), calls: [{ messageId: randomUUID(),
          tool: 'read', requestId: headeredRequestId, answered: false, order: 0 }]
      }]);
      const headered = await modern('tools/call', {
        name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
      }, { 'x-request-id': headeredRequestId });
      expect(headered.status).toBe(200);
      expect(failed(headered)).toBe(false);
      expect(headered.body?.result?.structuredContent?.cosResultReceipt?.id)
        .toEqual(expect.stringMatching(/^[a-f0-9]{48}$/));
      await vi.waitFor(() => expect(observed).toHaveLength(3));
      expect(observed[2]).toContain('identity_header=valid');
      expect(observed[2]).toContain('core_result_receipt=committed_structured');
    } finally { unsubscribe(); }
  });

  it('never retroactively announces a headerless result witness after the HTTP recorder-settle deadline', async () => {
    const { flushRecorder } = await import('../src/main/session/recorder.js');
    const store = await import('../src/main/session/store.js');
    const prior = new Set<string>();
    for (const session of await store.indexedSessions({ requireComplete: true })) {
      if (session.title !== 'Unattributed activity' || session.conversationId !== null) continue;
      for (const row of await readEvents(session.id, { kinds: ['tool_call'], requireIntegrity: true }))
        if (row.kind === 'tool_call') prior.add(row.call.callId);
    }
    const observed: string[] = [];
    const unsubscribe = onLog(row => {
      if (row.message.includes('identity_header=')) observed.push(row.message);
    });
    let releaseAppend!: () => void;
    let enteredAppend!: () => void;
    const entered = new Promise<void>(resolve => { enteredAppend = resolve; });
    const withheld = new Promise<void>(resolve => { releaseAppend = resolve; });
    const actualAppend = store.appendEvent;
    const delayed = vi.spyOn(store, 'appendEvent').mockImplementationOnce(async (sessionId, event) => {
      enteredAppend();
      await withheld;
      return actualAppend(sessionId, event);
    });
    const admittedAfter = Date.now();
    try {
      const call = modern('tools/call', {
        name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
      });
      await entered;
      const returned = await call;
      expect(returned.status).toBe(200);
      expect(failed(returned)).toBe(false);
      expect(textOf(returned)).toContain('note line 1');
      expect(returned.body?.result?.structuredContent?.cosResultReceipt).toBeUndefined();
      expect(returned.body.result.content.some((part: any) => part.type === 'resource')).toBe(false);
      await vi.waitFor(() => expect(observed).toHaveLength(1));
      expect(observed[0]).toContain('identity_header=missing');
      expect(observed[0]).toContain('core_result_receipt=settle_timeout');
      // The original append is still pending, not a permission to replay
      // its successful operation or to claim an owned native message.
    } finally {
      releaseAppend();
      delayed.mockRestore();
      unsubscribe();
    }
    await flushRecorder();
    expect(observed.join('\n')).not.toContain('/workspace/notes.txt');
    const newlySaved = [];
    for (const session of await store.indexedSessions({ requireComplete: true })) {
      if (session.title !== 'Unattributed activity' || session.conversationId !== null) continue;
      for (const row of await readEvents(session.id, { kinds: ['tool_call'], requireIntegrity: true }))
        if (row.kind === 'tool_call' && !prior.has(row.call.callId) &&
            row.time >= admittedAfter) newlySaved.push(row);
    }
    // After the delayed append, the real execution survives as exactly one
    // Unattributed record, but the wire never announced its private witness.
    // Its post-timeout existence cannot retroactively authorize a native ACK.
    expect(newlySaved).toHaveLength(1);
    expect(newlySaved[0]).toMatchObject({ kind: 'tool_call', call: {
      tool: 'read', conversationId: null, requestId: null,
      attributionMethod: 'unattributed', resultReceiptId: expect.stringMatching(/^[a-f0-9]{48}$/)
    } });
    expect(observed.join('\n')).not.toContain(newlySaved[0]?.kind === 'tool_call'
      ? newlySaved[0].call.resultReceiptId : 'absent-witness');
  });

  it.each(['unmapped', 'foreign-owner', 'late-exact-owner'] as const)('retains an unmapped transport header while joining its real returned result to one native invocation (%s)', async ownership => {
    const { recordRequestEvidence, attachNativeCoreResultReceipt, flushRecorder } =
      await import('../src/main/session/recorder.js');
    const { indexedSessions, readReceiptWitnessOccurrences } = await import('../src/main/session/store.js');
    const conversationId = randomUUID(), nativeCallMessageId = randomUUID();
    const transportRequestId = 'wfr_unmapped_transport_' + randomBytes(8).toString('hex');
    const nativeRequestId = ownership === 'late-exact-owner' ? transportRequestId
      : 'wfr_exact_native_parent_' + randomBytes(8).toString('hex');
    const result = await modern('tools/call', {
      name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
    }, { 'x-request-id': transportRequestId });
    expect(result.status).toBe(200);
    expect(failed(result)).toBe(false);
    const receiptId = result.body?.result?.structuredContent?.cosResultReceipt?.id as string;
    expect(receiptId).toMatch(/^[a-f0-9]{48}$/);
    await flushRecorder();
    const originals: Array<{ sessionId: string; call: Extract<SessionEvent, { kind: 'tool_call' }>['call'] }> = [];
    for (const summary of await indexedSessions()) {
      for (const event of await readReceiptWitnessOccurrences(summary.id, receiptId))
        originals.push({ sessionId: summary.id, call: event.call });
    }
    expect(originals).toHaveLength(1);
    expect(originals[0]!.call).toMatchObject({ requestId: transportRequestId,
      conversationId: null, attributionMethod: 'unattributed', outcome: 'ok' });
    let foreignOwner: Awaited<ReturnType<typeof createSession>> | undefined;
    if (ownership === 'foreign-owner') {
      const foreignConversation = randomUUID(), foreignNative = randomUUID();
      const foreign = await createSession({ conversationId: foreignConversation });
      foreignOwner = foreign;
      expect(observeRequestCorrelation({ requestId: transportRequestId,
        conversationId: foreignConversation, sessionId: foreign.id, messageId: foreignNative,
        nativeCallMessageId: foreignNative, tool: 'read', observedAt: Date.now() })).toBe('stored');
      await (await import('../src/main/session/recorder.js')).repairDeterministicAttribution(new Set([transportRequestId]));
    }
    const sessionId = await recordRequestEvidence(conversationId, [{
      kind: 'tool_evidence', time: Date.now(), calls: [{ messageId: nativeCallMessageId,
        tool: 'read', requestId: nativeRequestId, answered: true, order: 0 }]
    }]);
    expect(sessionId).toBeTruthy();
    const attach = () => attachNativeCoreResultReceipt({ conversationId, sessionId: sessionId!,
      requestId: nativeRequestId, nativeCallMessageId, tool: 'read', resultReceiptId: receiptId });
    if (ownership === 'late-exact-owner') {
      // The original immutable header obtained its real native owner after HTTP.
      // Preserve the published witness through exact header placement, then
      // bind it in place without rewriting the transport or executing again.
      await (await import('../src/main/session/recorder.js')).repairDeterministicAttribution(new Set([transportRequestId]));
      expect(await attach()).toBe(true);
      const saved = (await readEvents(sessionId!, { kinds: ['tool_call'], requireIntegrity: true }))
        .filter(event => event.kind === 'tool_call' && event.call.callId === originals[0]!.call.callId);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ kind: 'tool_call', call: {
        requestId: transportRequestId, conversationId, attributionMethod: 'request_id'
      } });
      if (saved[0]?.kind === 'tool_call') {
        expect(saved[0].call.resultReceiptId).toBe(receiptId);
        expect(saved[0].call.nativeCallMessageId).toBe(nativeCallMessageId);
      }
      return;
    }
    if (ownership === 'foreign-owner') {
      expect(await attach()).toBe(false);
      // Ordinary header repair may win before the fallback is checked. Await
      // that real producer above instead of racing its old holding location.
      // The immutable transport owner gets the sole execution; this different
      // native invocation still cannot borrow its private result witness.
      const repaired = (await readEvents(foreignOwner!.id, { kinds: ['tool_call'], requireIntegrity: true }))
        .filter(event => event.kind === 'tool_call' && event.call.callId === originals[0]!.call.callId);
      expect(repaired).toHaveLength(1);
      expect(repaired[0]).toMatchObject({ kind: 'tool_call', call: {
        requestId: transportRequestId, conversationId: foreignOwner!.conversationId,
        attributionMethod: 'request_id', outcome: 'ok'
      } });
      if (repaired[0]?.kind === 'tool_call') {
        expect(repaired[0].call.resultReceiptId).toBe(receiptId);
        expect(repaired[0].call.nativeCallMessageId).toBeUndefined();
      }
      expect(await readReceiptWitnessOccurrences(originals[0]!.sessionId, receiptId)).toHaveLength(0);
      expect((await readEvents(sessionId!, { kinds: ['tool_call'], requireIntegrity: true })))
        .toHaveLength(0);
      return;
    }
    expect(await attach()).toBe(true);
    expect(await attach()).toBe(true);
    const saved = (await readEvents(sessionId!, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter(event => event.kind === 'tool_call' && event.call.resultReceiptId === receiptId);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: 'tool_call', call: {
      callId: originals[0]!.call.callId, requestId: transportRequestId,
      nativeCallMessageId, conversationId, attributionMethod: 'result_receipt'
    } });
    expect(await readReceiptWitnessOccurrences(originals[0]!.sessionId, receiptId)).toHaveLength(0);
  });

  it('joins one actual headerless Core HTTP execution to its exact native message through the durable Bridge recorder owner without rerunning the tool', async () => {
    const { recordRequestEvidence, attachNativeCoreResultReceipt, flushRecorder,
      receiptDurableOwnerUnique } =
      await import('../src/main/session/recorder.js');
    const { indexedSessions, readReceiptWitnessOccurrences } = await import('../src/main/session/store.js');
    const { recordedExecutionEvidence } = await import('../src/main/goal.js');
    const { nativeExecutionScopeForPreparedInput, recordedExecutionReferenceLines } = await import('../src/main/mcp/plan-tool.js');
    const { stampNativeExecutionScope } = await import('../src/shared/agent-plan.js');
    const { prepareOperatorPrompt } = await import('../src/shared/operator-prompt.mjs');
    const browserInput = await import('../src/main/session/input.js');
    const conversationId = randomUUID(), nativeCallMessageId = randomUUID();
    const requestId = 'wfr_real_headerless_core_' + randomBytes(8).toString('hex');
    const turnId = 'g-headerless-' + randomBytes(8).toString('hex');
    const requirement = 'Verify the native Windows Loop returned a useful Core result for the original request.';
    const objective = `Original acceptance IDs: task_fidelity.\ntask_fidelity: ${requirement}`;
    // The existing browser/recorder owner knows the exact intended native
    // request before the real headerless HTTP result. Native text/version is
    // frozen by Input's existing claim/ACK transaction, not fabricated in the
    // later plan writer or inferred from this tool's receipt ID.
    const targetSessionId = await recordRequestEvidence(conversationId, [{
      kind: 'tool_evidence', time: Date.now(), turnId, calls: [{
        messageId: nativeCallMessageId, tool: 'read', requestId, answered: true, order: 0
      }]
    }]);
    expect(targetSessionId).toBeTruthy();
    await setGoalObjectiveNow(conversationId, objective);
    const executionVersion = await nativeExecutionScopeForPreparedInput(targetSessionId!, conversationId);
    expect(executionVersion).toMatch(/^[a-f0-9]{64}$/);
    const authored = 'Read the requested Core document and preserve the original receipt.';
    const prepared = prepareOperatorPrompt(stampNativeExecutionScope(authored, executionVersion!), upper => upper - 1);
    const nativeQuestionId = randomUUID(), inputId = randomUUID(), owner = `headerless-owner-${inputId}`;
    browserInput.configureInputDelivery({ changed: () => {}, applyAutomation: async () => {},
      prepareText: async () => prepared });
    try {
      await browserInput.enqueueInput({ id: inputId, sessionId: targetSessionId!, text: authored,
        mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null });
      expect(await browserInput.claimBrowserInput(inputId, owner, conversationId, true)).not.toBeNull();
      expect(await browserInput.authorizeBrowserInput(inputId, owner, conversationId)).toBe(true);
      expect(await browserInput.acknowledgeBrowserInput(inputId, owner, conversationId, nativeQuestionId)).toBe(true);
    } finally {
      browserInput.resetInputDeliveryForTests();
    }
    // Record the real outbox ACK through its history owner before observing the
    // provider echo; adapter-supplied provenance labels cannot certify authorship.
    const deliveredInput = (await browserInput.listInputs()).find(row => row.id === inputId)!;
    expect(await (await import('../src/main/session/input-history.js')).recordDeliveredInput(deliveredInput)).toBe(true);
    await upsertMessageEvent(targetSessionId!, { source: 'extension', time: Date.now(), kind: 'user_message',
      messageId: nativeQuestionId, textOrigin: 'provider',
      message: { text: prepared, chars: prepared.length, truncated: false } });
    const result = await modern('tools/call', {
      name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
    }); // No workflow identity headers, one real SDK and HTTP execution.
    expect(result.status).toBe(200);
    expect(failed(result)).toBe(false);
    expect(textOf(result)).toContain('note line 1');
    const receiptId = result.body?.result?.structuredContent?.cosResultReceipt?.id as string;
    expect(receiptId).toMatch(/^[a-f0-9]{48}$/);
    await flushRecorder();
    const originalBuckets = (await indexedSessions())
      .filter(summary => summary.title === 'Unattributed activity' && summary.conversationId === null);
    const found: Array<{ id: string; callId: string }> = [];
    for (const summary of originalBuckets) {
      for (const event of await readReceiptWitnessOccurrences(summary.id, receiptId))
        found.push({ id: summary.id, callId: event.call.callId });
    }
    expect(found).toHaveLength(1);
    const attach = () => attachNativeCoreResultReceipt({
      conversationId, sessionId: targetSessionId!,
      requestId, nativeCallMessageId, tool: 'read', resultReceiptId: receiptId
    });
    expect(await attach()).toBe(true);
    const saved = (await readEvents(targetSessionId!, {
      kinds: ['tool_call'], requireIntegrity: true
    })).filter(row => row.kind === 'tool_call' && row.call.resultReceiptId === receiptId);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: 'tool_call', call: {
      callId: found[0]!.callId, nativeCallMessageId,
      attributionMethod: 'result_receipt', conversationId, requestId: null
    } });
    expect(saved[0]?.turnId).toBe(turnId);
    expect((await readReceiptWitnessOccurrences(found[0]!.id, receiptId))).toHaveLength(0);
    // The actual HTTP result/unique native receipt alone cannot claim that
    // the user's matching native output was completed or Skill applied.
    expect((await recordedExecutionEvidence(targetSessionId!, conversationId)).coreResults).toEqual([]);
    const outputMessageId = randomUUID();
    const nativeOutput = 'The requested Core read returned its contents. Original acceptance is not yet complete.';
    await appendEvent(targetSessionId!, { source: 'extension', time: Date.now(),
      kind: 'assistant_message', messageId: outputMessageId, inputReplyTo: nativeQuestionId,
      turnId, final: true, goalEligible: true,
      message: { text: nativeOutput, chars: nativeOutput.length, truncated: false } });
    const complete = await recordedExecutionEvidence(targetSessionId!, conversationId);
    expect(complete.coreResults).toMatchObject([{ sessionId: targetSessionId, conversationId,
      requestId: null, callId: found[0]!.callId, attributionMethod: 'result_receipt',
      resultReceiptId: receiptId, nativeCallMessageId, turnId, tool: 'read',
      executionScopeSha256: executionVersion, nativeOutputMessageId: outputMessageId,
      nativeOutputSha256: createHash('sha256').update(nativeOutput).digest('hex') }]);
    const { canonicalAcceptanceView } = await import('../src/shared/agent-plan.js');
    const { bindExecutionEvidenceToScope } = await import('../src/main/goal.js');
    const scoped = bindExecutionEvidenceToScope(complete, objective, objective, [], []);
    const core = complete.coreResults![0]!;
    const actualMetadata = recordedExecutionReferenceLines(scoped);
    expect(actualMetadata).toHaveLength(1);
    expect(actualMetadata[0]).toContain(`core-result-receipt=${receiptId}`);
    expect(actualMetadata[0]).toContain(`native-output-message-id=${outputMessageId}`);
    expect(actualMetadata[0]).toContain(`native-output-sha256=${core.nativeOutputSha256}`);
    expect(actualMetadata[0]).not.toContain('request-id=');
    const reference = `Live-verified native workflow: installed Windows automatic Loop passed on build abc123; Core tool result returned with terminal success; core-result-receipt=${receiptId} native-call-message-id=${nativeCallMessageId} task-version-sha256=${scoped.taskVersionSha256} session-id=${core.sessionId} conversation-id=${core.conversationId} call-id=${core.callId} turn-id=${core.turnId} tool=${core.tool} result-sha256=${core.resultSha256} result-chars=${core.resultChars} native-output-message-id=${core.nativeOutputMessageId} native-output-sha256=${core.nativeOutputSha256}.`;
    const plan = { updatedAt: 1, plan: [], checklist: [{ id: 'task_fidelity',
      requirement, acceptance: 'Observe the returned Core result in the native workflow.',
      source: 'Original human acceptance', status: 'verified' as const, evidence: [reference] }] };
    expect(canonicalAcceptanceView(objective, plan, objective, [], [], scoped).verified).toBe(1);
    const corrected = 'Current human correction: keep the exact original native Core attribution.';
    const changedScope = bindExecutionEvidenceToScope(complete, `${objective}\n${corrected}`, objective, [corrected], []);
    expect(changedScope.coreResults).toEqual([]);
    expect(canonicalAcceptanceView(`${objective}\n${corrected}`, plan, objective, [corrected], [], changedScope).verified).toBe(0);
    const wrongOutput = { ...plan, checklist: [{ ...plan.checklist[0]!,
      evidence: [reference.replace(`native-output-message-id=${outputMessageId}`,
        `native-output-message-id=${outputMessageId}-foreign`)] }] };
    expect(canonicalAcceptanceView(objective, wrongOutput, objective, [], [], scoped).verified).toBe(0);
    // Browser reconnection/duplicate ACK never executes another Core handler
    // or creates a second durable result for this exact invocation.
    expect(await attach()).toBe(true);
    expect((await readEvents(targetSessionId!, { kinds: ['tool_call'] }))
      .filter(row => row.kind === 'tool_call' && row.call.resultReceiptId === receiptId))
      .toHaveLength(1);
    // Compact & Resume changes only the live conversation binding. The one
    // acknowledged Core result belongs to the retained original session; it
    // must remain historical acceptance evidence, never a new Send receipt.
    const resumedConversationId = randomUUID();
    expect(await rebindSession(targetSessionId!, conversationId, resumedConversationId)).toBe(true);
    // Default native issuance/ACK custody must NEVER acquire historical A as
    // current B. Only read-only acceptance can inspect B's retained A lineage.
    expect(await receiptDurableOwnerUnique(receiptId, targetSessionId!, nativeCallMessageId,
      found[0]!.callId)).toBe(false);
    expect(await receiptDurableOwnerUnique(receiptId, targetSessionId!, nativeCallMessageId,
      found[0]!.callId, { historicalReadOnly: true })).toBe(true);
    expect(await attach()).toBe(false);
    expect((await recordedExecutionEvidence(targetSessionId!, resumedConversationId)).coreResults)
      .toEqual(complete.coreResults);
    const retained = bindExecutionEvidenceToScope(
      await recordedExecutionEvidence(targetSessionId!, resumedConversationId), objective, objective, [], []);
    expect(canonicalAcceptanceView(objective, plan, objective, [], [], retained).verified).toBe(1);
  });

  it.each([false, true])('does not change original Core custody when a foreign session owns its receipt (target copy already committed: %s)', async targetCopied => {
    const { recordRequestEvidence, attachNativeCoreResultReceipt, flushRecorder } =
      await import('../src/main/session/recorder.js');
    const { indexedSessions, readReceiptWitnessOccurrences, flushSessions, sessionsRoot } =
      await import('../src/main/session/store.js');
    const conversationId = randomUUID(), nativeCallMessageId = randomUUID();
    const requestId = 'wfr_recorder_foreign_receipt_' + randomBytes(8).toString('hex');
    const returned = await modern('tools/call', {
      name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
    });
    expect(returned.status).toBe(200);
    const receiptId = returned.body?.result?.structuredContent?.cosResultReceipt?.id as string;
    expect(receiptId).toMatch(/^[a-f0-9]{48}$/);
    await flushRecorder();
    let original: { id: string; call: Extract<SessionEvent, { kind: 'tool_call' }>['call'] } | null = null;
    for (const summary of await indexedSessions({ requireComplete: true })) {
      if (summary.conversationId !== null || summary.title !== 'Unattributed activity') continue;
      for (const event of await readReceiptWitnessOccurrences(summary.id, receiptId)) {
        if (original) throw new Error('Test setup duplicated the original Core execution');
        original = { id: summary.id, call: event.call };
      }
    }
    expect(original).not.toBeNull();
    const targetId = await recordRequestEvidence(conversationId, [{ kind: 'tool_evidence',
      time: Date.now(), calls: [{ messageId: nativeCallMessageId,
        tool: 'read', requestId, answered: true, order: 0 }] }]);
    expect(targetId).toBeTruthy();
    const foreignConversationId = randomUUID();
    const foreign = await createSession({ title: 'Independent original receipt owner',
      conversationId: foreignConversationId });
    if (targetCopied) {
      await appendEvent(targetId!, { time: Date.now(), source: 'mcp', kind: 'tool_call',
        call: { ...original!.call, conversationId, attribution: 'result_receipt',
          attributionMethod: 'result_receipt', nativeCallMessageId } });
    }
    await appendEvent(foreign.id, { time: Date.now(), source: 'mcp', kind: 'tool_call',
      call: { ...original!.call, conversationId: foreignConversationId,
        attribution: 'result_receipt', attributionMethod: 'result_receipt',
        nativeCallMessageId: 'foreign-tool-message' } });
    await flushSessions();
    const sourceFile = path.join(sessionsRoot(), original!.id, 'events.jsonl');
    const originalBytes = await fs.readFile(sourceFile);
    const targetBefore = await readEvents(targetId!, { kinds: ['tool_call'], requireIntegrity: true });
    expect(await attachNativeCoreResultReceipt({ conversationId, sessionId: targetId!,
      requestId, nativeCallMessageId, tool: 'read', resultReceiptId: receiptId })).toBe(false);
    // Losing the final uniqueness vote must NEVER authorize a preceding
    // destructive source rewrite, even after an interrupted target append.
    expect(await fs.readFile(sourceFile)).toEqual(originalBytes);
    expect((await readEvents(targetId!, { kinds: ['tool_call'], requireIntegrity: true })))
      .toEqual(targetBefore);
  });

  it('retains both exact custody copies when another owner appears after destination append but before original retirement', async () => {
    const { recordRequestEvidence, attachNativeCoreResultReceipt, flushRecorder,
      receiptDurableOwnerUnique } = await import('../src/main/session/recorder.js');
    const { indexedSessions, readReceiptWitnessOccurrences, flushSessions,
      sessionsRoot } = await import('../src/main/session/store.js');
    const conversationId = randomUUID(), requestId = 'wfr_racing_owner_' + randomBytes(8).toString('hex');
    const nativeCallMessageId = randomUUID();
    const executed = await modern('tools/call', { name: 'read',
      arguments: { paths: ['/workspace/notes.txt'] } });
    const witness = executed.body?.result?.structuredContent?.cosResultReceipt?.id as string;
    expect(witness).toMatch(/^[a-f0-9]{48}$/);
    await flushRecorder();
    const originals: Array<{ id: string; call: Extract<SessionEvent, { kind: 'tool_call' }>['call'] }> = [];
    for (const summary of await indexedSessions({ requireComplete: true })) {
      if (summary.conversationId !== null || summary.title !== 'Unattributed activity') continue;
      for (const event of await readReceiptWitnessOccurrences(summary.id, witness))
        originals.push({ id: summary.id, call: event.call });
    }
    expect(originals).toHaveLength(1);
    const targetId = await recordRequestEvidence(conversationId, [{ kind: 'tool_evidence',
      time: Date.now(), calls: [{ messageId: nativeCallMessageId,
        tool: 'read', requestId, answered: true, order: 0 }] }]);
    expect(targetId).toBeTruthy();
    const otherConversation = randomUUID();
    const foreign = await createSession({ title: 'Concurrent foreign custody', conversationId: otherConversation });
    await flushSessions();
    const originalFile = path.join(sessionsRoot(), originals[0]!.id, 'events.jsonl');
    const originalBytes = await fs.readFile(originalFile);
    const targetFile = path.join(sessionsRoot(), targetId!, 'events.jsonl');
    const readdir = fs.readdir.bind(fs);
    let inserted = false;
    const spy = vi.spyOn(fs, 'readdir').mockImplementation((async (dir, ...args) => {
      const result = await (readdir as (...values: any[]) => Promise<any>)(dir, ...args);
      if (!inserted && String(dir) === sessionsRoot()) {
        const target = await fs.readFile(targetFile, 'utf8');
        if (target.includes(witness)) {
          inserted = true;
          // Real competing append in the existing store, after destination
          // commit. The recorder's post-append custody check must catch it.
          await appendEvent(foreign.id, { time: Date.now(), source: 'mcp', kind: 'tool_call',
            call: { ...originals[0]!.call, conversationId: otherConversation,
              attribution: 'result_receipt', attributionMethod: 'result_receipt',
              nativeCallMessageId: 'independent-foreign-native-message' } });
        }
      }
      return result;
    }) as typeof fs.readdir);
    let accepted: boolean;
    try {
      accepted = await attachNativeCoreResultReceipt({ conversationId, sessionId: targetId!,
        requestId, nativeCallMessageId, tool: 'read', resultReceiptId: witness });
    } finally {
      spy.mockRestore();
    }
    expect(inserted).toBe(true);
    expect(accepted).toBe(false);
    expect(await fs.readFile(originalFile)).toEqual(originalBytes);
    expect((await readEvents(targetId!, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter(row => row.kind === 'tool_call' && row.call.resultReceiptId === witness)).toHaveLength(1);
    expect(await receiptDurableOwnerUnique(witness, targetId!, nativeCallMessageId,
      originals[0]!.call.callId)).toBe(false);
    // A repeated native observation preserves the same two-journal recovery
    // checkpoint instead of attempting to move custody again.
    expect(await attachNativeCoreResultReceipt({ conversationId, sessionId: targetId!,
      requestId, nativeCallMessageId, tool: 'read', resultReceiptId: witness })).toBe(false);
    expect(await fs.readFile(originalFile)).toEqual(originalBytes);
  });

  it.each(['target-sync', 'source-rename', 'source-meta'])(
    'recovers an interrupted Core receipt transfer after a cold session-store restart (%s)', async failure => {
      const { recordRequestEvidence, attachNativeCoreResultReceipt, flushRecorder } =
        await import('../src/main/session/recorder.js');
      const { indexedSessions, readReceiptWitnessOccurrences, sessionsRoot,
        resetSessionStoreForTests } = await import('../src/main/session/store.js');
      const conversationId = randomUUID(), nativeCallMessageId = randomUUID();
      const requestId = 'wfr_cold_receipt_' + randomBytes(8).toString('hex');
      const executed = await modern('tools/call', { name: 'read',
        arguments: { paths: ['/workspace/notes.txt'] } });
      expect(executed.status).toBe(200);
      const receipt = executed.body?.result?.structuredContent?.cosResultReceipt?.id as string;
      expect(receipt).toMatch(/^[a-f0-9]{48}$/);
      await flushRecorder();
      const holders: Array<{ id: string; callId: string }> = [];
      for (const summary of await indexedSessions({ requireComplete: true })) {
        if (summary.conversationId !== null || summary.title !== 'Unattributed activity') continue;
        for (const event of await readReceiptWitnessOccurrences(summary.id, receipt))
          holders.push({ id: summary.id, callId: event.call.callId });
      }
      expect(holders).toHaveLength(1);
      const targetId = await recordRequestEvidence(conversationId, [{ kind: 'tool_evidence',
        time: Date.now(), calls: [{ messageId: nativeCallMessageId,
          requestId, tool: 'read', answered: true, order: 0 }] }]);
      expect(targetId).toBeTruthy();
      const sourceJournal = path.join(sessionsRoot(), holders[0]!.id, 'events.jsonl');
      const sourceMeta = path.join(path.dirname(sourceJournal), 'meta.json');
      const targetJournal = path.join(sessionsRoot(), targetId!, 'events.jsonl');
      const sourceBefore = await fs.readFile(sourceJournal);
      let injectionHits = 0;
      const rename = fs.rename.bind(fs), open = fs.open.bind(fs);
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((async (src, dst) => {
        if (failure === 'source-rename' && String(src).startsWith(sourceJournal + '.repair-') &&
            String(dst) === sourceJournal && injectionHits++ === 0)
          throw Object.assign(new Error('injected interrupted source replacement'), { code: 'EACCES' });
        if (failure === 'source-meta' && String(dst) === sourceMeta &&
            !(await fs.readFile(sourceJournal, 'utf8')).includes(receipt) && injectionHits++ === 0)
          throw Object.assign(new Error('injected metadata checkpoint interruption'), { code: 'EIO' });
        return rename(src, dst);
      }) as typeof fs.rename);
      const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (file, flags, ...rest) => {
        if (failure === 'target-sync' && String(file) === targetJournal && flags === 'r+' &&
            injectionHits++ === 0)
          throw Object.assign(new Error('injected target durability failure'), { code: 'EIO' });
        return (open as (...args: unknown[]) => ReturnType<typeof fs.open>)(file, flags, ...rest);
      }) as typeof fs.open);
      const attach = () => attachNativeCoreResultReceipt({ conversationId, sessionId: targetId!,
        requestId, nativeCallMessageId, tool: 'read', resultReceiptId: receipt });
      try {
        expect(await attach()).toBe(false);
      } finally {
        renameSpy.mockRestore();
        openSpy.mockRestore();
      }
      expect(injectionHits).toBeGreaterThan(0);
      if (failure === 'source-meta') {
        // The authoritative rewrite committed, but its metadata projection did
        // not. The cold loader must recover the shorter journal without losing
        // ownership or granting a second Core execution.
        expect(await readReceiptWitnessOccurrences(holders[0]!.id, receipt)).toHaveLength(0);
      } else {
        expect(await fs.readFile(sourceJournal)).toEqual(sourceBefore);
      }
      const firstTarget = (await readEvents(targetId!, { kinds: ['tool_call'], requireIntegrity: true }))
        .filter(row => row.kind === 'tool_call' && row.call.resultReceiptId === receipt);
      expect(firstTarget).toHaveLength(1);
      // Failed ordinary rename must not leave an uncommitted temp; a real
      // terminated process can leave one, which stays forensic until recovered.
      expect((await fs.readdir(path.dirname(sourceJournal)))
        .filter(name => name.startsWith('events.jsonl.repair-'))).toEqual([]);
      resetSessionStoreForTests(); // Discard live summary/catalog/sequence caches, keep disk and correlation.
      expect(await attach()).toBe(true);
      const targetCalls = (await readEvents(targetId!, { kinds: ['tool_call'], requireIntegrity: true }))
        .filter(row => row.kind === 'tool_call' && row.call.resultReceiptId === receipt);
      expect(targetCalls).toHaveLength(1);
      expect(targetCalls[0]).toMatchObject({ kind: 'tool_call', call: {
        callId: holders[0]!.callId, nativeCallMessageId,
        conversationId, attributionMethod: 'result_receipt' } });
      const sourceRemaining = await readReceiptWitnessOccurrences(holders[0]!.id, receipt);
      expect(sourceRemaining).toHaveLength(0);
      expect(await attach()).toBe(true);
      expect((await readEvents(targetId!, { kinds: ['tool_call'] })).filter(row =>
        row.kind === 'tool_call' && row.call.resultReceiptId === receipt)).toHaveLength(1);
    }
  );

  it.each(['asset-sync', 'corrupt-existing'])(
    'does not retire an overflow Core result until its exact copied asset is durable (%s)', async failure => {
      const { recordRequestEvidence, attachNativeCoreResultReceipt, flushRecorder,
        receiptDurableOwnerUnique } =
        await import('../src/main/session/recorder.js');
      const { indexedSessions, readReceiptWitnessOccurrences, sessionsRoot, readAsset } =
        await import('../src/main/session/store.js');
      const largeName = `large-core-${randomBytes(6).toString('hex')}.txt`;
      const inputFile = path.join(approved, largeName);
      await fs.writeFile(inputFile, 'Original real Core overflow result\n' + 'Z'.repeat(14_000));
      const execution = await modern('tools/call', { name: 'read',
        arguments: { paths: [`/workspace/${largeName}`] } });
      expect(execution.status).toBe(200);
      expect(failed(execution)).toBe(false);
      const receipt = execution.body?.result?.structuredContent?.cosResultReceipt?.id as string;
      expect(receipt).toMatch(/^[a-f0-9]{48}$/);
      await flushRecorder();
      const found: Array<{ id: string; callId: string; assetId: string }> = [];
      for (const summary of await indexedSessions({ requireComplete: true })) {
        if (summary.conversationId !== null || summary.title !== 'Unattributed activity') continue;
        for (const row of await readReceiptWitnessOccurrences(summary.id, receipt)) {
          expect(row.call.result.assetId).toMatch(/^[a-f0-9]{32}\.txt$/);
          found.push({ id: summary.id, callId: row.call.callId, assetId: row.call.result.assetId! });
        }
      }
      expect(found).toHaveLength(1);
      const conversationId = randomUUID(), nativeCallMessageId = randomUUID();
      const requestId = 'wfr_overflow_custody_' + randomBytes(8).toString('hex');
      const targetId = await recordRequestEvidence(conversationId, [{ kind: 'tool_evidence',
        time: Date.now(), calls: [{ messageId: nativeCallMessageId,
          tool: 'read', requestId, answered: true, order: 0 }] }]);
      expect(targetId).toBeTruthy();
      const sourceJournal = path.join(sessionsRoot(), found[0]!.id, 'events.jsonl');
      const originalJournalBytes = await fs.readFile(sourceJournal);
      const originalAsset = await readAsset(found[0]!.id, found[0]!.assetId);
      expect(originalAsset).not.toBeNull();
      const targetAsset = path.join(sessionsRoot(), targetId!, 'assets', found[0]!.assetId);
      if (failure === 'corrupt-existing') {
        await fs.mkdir(path.dirname(targetAsset), { recursive: true });
        await fs.writeFile(targetAsset, 'Unrelated bytes must never impersonate a copied Core result');
      }
      const open = fs.open.bind(fs);
      let injected = 0;
      const spy = vi.spyOn(fs, 'open').mockImplementation((async (file, flags, ...rest) => {
        if (failure === 'asset-sync' && String(file) === targetAsset && flags === 'r+' && injected++ === 0)
          throw Object.assign(new Error('injected asset durability failure'), { code: 'EIO' });
        return (open as (...args: unknown[]) => ReturnType<typeof fs.open>)(file, flags, ...rest);
      }) as typeof fs.open);
      const attach = () => attachNativeCoreResultReceipt({ conversationId, sessionId: targetId!,
        requestId, nativeCallMessageId, tool: 'read', resultReceiptId: receipt });
      try {
        expect(await attach()).toBe(false);
      } finally {
        spy.mockRestore();
      }
      if (failure === 'asset-sync') expect(injected).toBeGreaterThan(0);
      expect(await fs.readFile(sourceJournal)).toEqual(originalJournalBytes);
      expect((await readEvents(targetId!, { kinds: ['tool_call'], requireIntegrity: true }))
        .filter(row => row.kind === 'tool_call' && row.call.resultReceiptId === receipt)).toHaveLength(0);
      if (failure === 'corrupt-existing') await fs.rm(targetAsset); // Only this test's known forged bytes.
      expect(await attach()).toBe(true);
      expect(await readAsset(targetId!, found[0]!.assetId)).toEqual(originalAsset);
      expect((await readEvents(targetId!, { kinds: ['tool_call'], requireIntegrity: true }))
        .filter(row => row.kind === 'tool_call' && row.call.resultReceiptId === receipt)).toHaveLength(1);
      expect(await readReceiptWitnessOccurrences(found[0]!.id, receipt)).toHaveLength(0);
      expect(await receiptDurableOwnerUnique(receipt, targetId!, nativeCallMessageId,
        found[0]!.callId)).toBe(true);
      // Native final may run after cold metadata recovery, not only during the
      // original recorder transfer. One missing overflow asset cannot become
      // a successful tool result merely because its witness row still exists.
      await fs.rm(targetAsset);
      expect(await receiptDurableOwnerUnique(receipt, targetId!, nativeCallMessageId,
        found[0]!.callId)).toBe(false);
      await fs.writeFile(targetAsset, originalAsset!);
      expect(await receiptDurableOwnerUnique(receipt, targetId!, nativeCallMessageId,
        found[0]!.callId)).toBe(true);
    }
  );

  it('retains a durable completion witness for a returned refusal without changing its failed outcome or executing it again', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ edit: true });
    const recorder = await import('../src/main/session/recorder.js');
    const conversationId = 'owned-returned-refusal-receipt';
    const session = await createSession({ conversationId });
    const requestId = 'wfr_owned_returned_refusal';
    const nativeCallMessageId = 'native-refused-apply-patch';
    observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
      messageId: nativeCallMessageId, nativeCallMessageId, tool: 'apply_patch', observedAt: Date.now() });
    const returned = await modern('tools/call', { name: 'apply_patch', arguments: {
      patch: '*** Begin Patch\n*** Update File: /workspace/receipt-no-such-original.txt\n@@\n-old\n+new\n*** End Patch'
    } }, { 'x-request-id': requestId + '/attempt1' });
    expect(returned.body?.error).toBeUndefined();
    expect(failed(returned)).toBe(true);
    expect(textOf(returned)).toContain('Not found');
    const resultReceiptId = returned.body?.result?.structuredContent?.cosResultReceipt?.id;
    expect(resultReceiptId).toMatch(/^[a-f0-9]{48}$/);
    expect(await recorder.attachNativeCoreResultReceipt({ conversationId, sessionId: session.id,
      requestId, nativeCallMessageId, tool: 'apply_patch', resultReceiptId })).toBe(true);
    const rows = (await readEvents(session.id, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter((row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.call).toMatchObject({ tool: 'apply_patch', outcome: 'tool_rejected',
      resultReceiptId, nativeCallMessageId });
    expect(rows[0]!.call.result.text).toContain('Not found');
    await expect(fs.access(path.join(approved, 'receipt-no-such-original.txt'))).rejects.toThrow();
  });

  it('keeps two owned executions under one workflow distinct through durable native receipt binding', async () => {
    const recorder = await import('../src/main/session/recorder.js');
    const store = await import('../src/main/session/store.js');
    const conversationId = 'owned-shared-receipt-workflow';
    const session = await createSession({ conversationId });
    const requestId = 'wfr_owned_shared_receipts';
    const natives = ['owned-native-call-one', 'owned-native-call-two'];
    const witnesses: string[] = [];
    for (const nativeCallMessageId of natives) {
      observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
        messageId: nativeCallMessageId, nativeCallMessageId, turnId: 'owned-shared-turn',
        tool: 'read', observedAt: Date.now() });
      const returned = await modern('tools/call', {
        name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
      }, { 'x-request-id': requestId + '/attempt1' });
      expect(failed(returned)).toBe(false);
      expect(textOf(returned)).toContain('note line 1');
      const witness = returned.body?.result?.structuredContent?.cosResultReceipt?.id;
      expect(witness).toEqual(expect.stringMatching(/^[a-f0-9]{48}$/));
      witnesses.push(witness);
    }
    expect(new Set(witnesses).size).toBe(2);
    expect(requestCorrelation(requestId)?.nativeCallAmbiguous).toBe(true);
    await recorder.flushRecorder();
    const before = (await readEvents(session.id, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter((row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call');
    expect(before).toHaveLength(2);
    const foreign = await createSession({ conversationId: 'foreign-owned-receipt' });
    const otherRequest = 'wfr_owned_other_workflow';
    observeRequestCorrelation({ requestId: otherRequest, conversationId, sessionId: session.id,
      messageId: natives[0]!, nativeCallMessageId: natives[0]!, tool: 'read', observedAt: Date.now() });
    for (const invalid of [
      { conversationId: foreign.conversationId!, sessionId: foreign.id, requestId,
        nativeCallMessageId: natives[0]!, tool: 'read', resultReceiptId: witnesses[0]! },
      { conversationId, sessionId: session.id, requestId,
        nativeCallMessageId: natives[0]!, tool: 'write', resultReceiptId: witnesses[0]! },
      { conversationId, sessionId: session.id, requestId: otherRequest,
        nativeCallMessageId: natives[0]!, tool: 'read', resultReceiptId: witnesses[0]! }
    ]) expect(await recorder.attachNativeCoreResultReceipt(invalid)).toBe(false);
    for (const [index, nativeCallMessageId] of natives.entries()) {
      const input = { conversationId, sessionId: session.id, requestId,
        nativeCallMessageId, tool: 'read', resultReceiptId: witnesses[index]! };
      expect(await recorder.attachNativeCoreResultReceipt(input)).toBe(true);
      expect(await recorder.attachNativeCoreResultReceipt(input)).toBe(true);
      expect(await recorder.receiptDurableOwnerUnique(witnesses[index]!, session.id,
        nativeCallMessageId, before[index]!.call.callId)).toBe(true);
      expect(await recorder.attachNativeCoreResultReceipt({ ...input,
        nativeCallMessageId: natives[1 - index]! })).toBe(false);
    }
    const after = (await readEvents(session.id, { kinds: ['tool_call'], requireIntegrity: true }))
      .filter((row): row is Extract<SessionEvent, { kind: 'tool_call' }> => row.kind === 'tool_call');
    expect(after).toHaveLength(2);
    for (const [index, event] of after.entries()) {
      expect(event.call).toEqual({ ...before[index]!.call, nativeCallMessageId: natives[index] });
      expect(event.origin ?? event.seq).toBe(before[index]!.origin ?? before[index]!.seq);
    }
    expect(requestCorrelation(requestId)?.nativeCallAmbiguous).toBe(true);
    // No replacement transport identity or second execution is manufactured.
    expect(after.map(row => row.call.requestId)).toEqual([requestId, requestId]);
    const summary = await store.getSession(session.id);
    expect(summary?.toolCalls).toBe(2);
    await appendEvent(foreign.id, { time: Date.now(), source: 'mcp', kind: 'tool_call',
      call: { ...before[0]!.call, callId: 'duplicate-owned-witness',
        conversationId: foreign.conversationId } });
    expect(await recorder.receiptDurableOwnerUnique(witnesses[0]!, session.id,
      natives[0]!, before[0]!.call.callId)).toBe(false);
    expect(await recorder.attachNativeCoreResultReceipt({ conversationId, sessionId: session.id,
      requestId, nativeCallMessageId: natives[0]!, tool: 'read', resultReceiptId: witnesses[0]! })).toBe(false);
  });

  it('returns one unpredictable headerless Core result witness only AFTER its exact durable Unattributed recorder commit', async () => {
    const { flushRecorder } = await import('../src/main/session/recorder.js');
    const { indexedSessions } = await import('../src/main/session/store.js');
    const returned = await modern('tools/call', {
      name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
    }); // No x-request-id, x-openai-request-id or openai-request-id.
    expect(returned.status).toBe(200);
    expect(failed(returned)).toBe(false);
    expect(textOf(returned)).toContain('note line 1');
    const witness = returned.body?.result?.structuredContent?.cosResultReceipt?.id;
    expect(witness).toEqual(expect.stringMatching(/^[a-f0-9]{48}$/));
    expect(textOf(returned)).not.toContain('COS_RESULT_RECEIPT_V1=');
    await flushRecorder();
    const owned: Array<{ session: string; callId: string; method: string; requestId: string | null }> = [];
    for (const session of await indexedSessions()) {
      if (session.title !== 'Unattributed activity' || session.conversationId !== null) continue;
      for (const event of await readEvents(session.id, { kinds: ['tool_call'], requireIntegrity: true })) {
        if (event.kind === 'tool_call' && event.call.resultReceiptId === witness)
          owned.push({ session: session.id, callId: event.call.callId,
            method: event.call.attributionMethod, requestId: event.call.requestId });
      }
    }
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ method: 'unattributed', requestId: null });
    expect(owned[0]!.callId).toBeTruthy();
  });

  it('withholds an owned witness when its journal fsync fails without losing the returned tool result', async () => {
    const store = await import('../src/main/session/store.js');
    const recorder = await import('../src/main/session/recorder.js');
    const conversationId = 'owned-receipt-sync-refused';
    const session = await createSession({ conversationId });
    const requestId = 'wfr_owned_receipt_sync_refused';
    observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
      nativeCallMessageId: 'owned-sync-native', messageId: 'owned-sync-native',
      tool: 'read', observedAt: Date.now() });
    const sync = vi.spyOn(store, 'syncSessionJournal').mockRejectedValueOnce(new Error('private sync path'));
    let returned: Awaited<ReturnType<typeof modern>>;
    try {
      returned = await modern('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } },
        { 'x-request-id': requestId + '/attempt1' });
    } finally { sync.mockRestore(); }
    expect(failed(returned!)).toBe(false);
    expect(textOf(returned!)).toContain('note line 1');
    expect(textOf(returned!)).toContain('Local recording unverified');
    expect(textOf(returned!)).toContain('Do not replay');
    expect(textOf(returned!)).not.toContain('private sync path');
    expect(returned!.body?.result?.structuredContent?.cosResultReceipt).toBeUndefined();
    await recorder.flushRecorder();
    expect(await readEvents(session.id, { kinds: ['tool_call'], requireIntegrity: true })).toHaveLength(1);
  });

  it('does not publish a result witness or invent durable ownership when a headerless Core recorder append fails', async () => {
    const store = await import('../src/main/session/store.js');
    const { flushRecorder } = await import('../src/main/session/recorder.js');
    const failing = vi.spyOn(store, 'appendEvent').mockImplementationOnce(async () => {
      throw Object.assign(new Error('private failed write path'), { code: 'ENOSPC' });
    });
    let returned: Awaited<ReturnType<typeof modern>>;
    try {
      returned = await modern('tools/call', {
        name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
      });
    } finally { failing.mockRestore(); }
    expect(returned!.status).toBe(200);
    expect(failed(returned!)).toBe(false);
    expect(textOf(returned!)).toContain('note line 1');
    expect(textOf(returned!)).not.toContain('COS_RESULT_RECEIPT_V1=');
    expect(returned!.body?.result?.structuredContent?.cosResultReceipt).toBeUndefined();
    expect(textOf(returned!)).not.toContain('private failed write path');
    await flushRecorder();
  });

  it('reports an exact owned Core result whose durable recorder append failed without replaying work or claiming a completion receipt', async () => {
    const store = await import('../src/main/session/store.js');
    const { flushRecorder } = await import('../src/main/session/recorder.js');
    const session = await createSession({ conversationId: 'mcp-owned-recorder-unavailable' });
    const requestId = 'wfr_mcp_owned_recording_refusal';
    expect(observeRequestCorrelation({ requestId, conversationId: 'mcp-owned-recorder-unavailable',
      sessionId: session.id, messageId: 'native-exact-core-read', tool: 'read',
      observedAt: Date.now() })).toBe('stored');
    const failing = vi.spyOn(store, 'appendEvent').mockImplementationOnce(async () => {
      throw Object.assign(new Error('private path must not leave this test'), { code: 'ENOSPC' });
    });
    let returned: Awaited<ReturnType<typeof modern>>;
    try {
      returned = await modern('tools/call', {
        name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
      }, { 'x-request-id': requestId + '/attempt1' });
    } finally { failing.mockRestore(); }
    expect(failed(returned!)).toBe(false);
    expect(textOf(returned!)).toContain('note line 1');
    expect(textOf(returned!)).toContain('Local recording unverified');
    expect(textOf(returned!)).toContain('Do not replay');
    expect(textOf(returned!)).not.toContain('private path');
    await flushRecorder();
    expect((await readEvents(session.id, { kinds: ['tool_call'] })).filter(
      e => e.kind === 'tool_call' && e.call.requestId === requestId
    )).toHaveLength(0);
    const recoveredId = 'wfr_mcp_owned_recording_recovered';
    expect(observeRequestCorrelation({ requestId: recoveredId,
      conversationId: 'mcp-owned-recorder-unavailable', sessionId: session.id,
      messageId: 'native-next-core-read', tool: 'read', observedAt: Date.now() })).toBe('stored');
    const recovered = await modern('tools/call', {
      name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
    }, { 'x-request-id': recoveredId + '/attempt1' });
    expect(failed(recovered)).toBe(false);
    expect(textOf(recovered)).not.toContain('Local recording unverified');
    await flushRecorder();
    expect((await readEvents(session.id, { kinds: ['tool_call'] })).filter(
      e => e.kind === 'tool_call' && e.call.requestId === recoveredId
    )).toHaveLength(1);
  });

  it('retains the exact-owned Core recording-warning when recording is disabled after its already-admitted append fails', async () => {
    const store = await import('../src/main/session/store.js');
    const { flushRecorder } = await import('../src/main/session/recorder.js');
    const conversationId = 'mcp-owned-recording-changed-while-running';
    const session = await createSession({ conversationId });
    const requestId = 'wfr_owned_midflight_recording_change';
    expect(observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
      messageId: 'original-native-read-midflight', tool: 'read',
      observedAt: Date.now() })).toBe('stored');
    const config = getConfig();
    const originalRecordingPreference = config.sessions.record;
    expect(originalRecordingPreference).toBe(true);
    let entered!: () => void;
    let release!: () => void;
    const enteredAppend = new Promise<void>(resolve => { entered = resolve; });
    const unblock = new Promise<void>(resolve => { release = resolve; });
    const failing = vi.spyOn(store, 'appendEvent').mockImplementationOnce(async () => {
      entered();
      await unblock;
      throw Object.assign(new Error('private write error'), { code: 'ENOSPC' });
    });
    let result: Awaited<ReturnType<typeof modern>>;
    try {
      const originalCall = modern('tools/call', {
        name: 'read', arguments: { paths: ['/workspace/notes.txt'] }
      }, { 'x-request-id': requestId + '/original' });
      await enteredAppend;
      // This is an isolated test-local preferences object, not a real account
      // setting change. The invocation already promised a durable recorder
      // commit when it began; disabling future recording must not conceal
      // THIS tool's failed append from its independently proved native caller.
      config.sessions.record = false;
      release();
      result = await originalCall;
    } finally {
      config.sessions.record = originalRecordingPreference;
      release();
      failing.mockRestore();
    }
    expect(result!.status).toBe(200);
    expect(failed(result!)).toBe(false);
    expect(textOf(result!)).toContain('note line 1');
    expect(textOf(result!)).toContain('Local recording unverified');
    expect(textOf(result!)).toContain('Do not replay');
    expect(textOf(result!)).not.toContain('private write error');
    expect(result!.body?.result?.structuredContent?.cosResultReceipt).toBeUndefined();
    await flushRecorder();
    expect((await readEvents(session.id, { kinds: ['tool_call'] })).filter(
      row => row.kind === 'tool_call' && row.call.requestId === requestId
    )).toHaveLength(0);
  });

  it('retains a privacy-safe, comparable missing-header fingerprint in actual app.log and one bounded first-cause incident', async () => {
    // Reproduce the native Delta profile's real ingress shape: a successful Core tool call
    // with all three request headers absent and a numeric JSON-RPC id. The full 64-hex
    // diagnostic digest currently gets redacted as a token in app.log.
    const logPath = path.join(base, 'rpc-attribution-first-cause', 'app.log');
    initLogFile(logPath);
    const observed: string[] = [];
    const stop = onLog(row => { if (row.message.includes('identity_header=')) observed.push(row.message); });
    const payload = (id: number | string) => JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] },
        _meta: { 'private-key': 'never-save-original-args' } }
    });
    try {
      for (const id of [1, 1, '1']) {
        const result = await rawPost(endpoint.urls.core, payload(id));
        expect(result.status).toBe(200);
      }
      await vi.waitFor(() => expect(observed).toHaveLength(3), { timeout: 1000, interval: 10 });
      const numeric = createHash('sha256').update(JSON.stringify(['number', 1])).digest('hex').slice(0, 16);
      const text = createHash('sha256').update(JSON.stringify(['string', '1'])).digest('hex').slice(0, 16);
      expect(numeric).not.toBe(text);
      expect(observed[0]).toContain(`rpc_id_fingerprint=${numeric}`);
      expect(observed[1]).toContain(`rpc_id_fingerprint=${numeric}`);
      expect(observed[2]).toContain(`rpc_id_fingerprint=${text}`);
      const ingress = recentMcpIngress('core', 0).records.filter(row =>
        row.methods.includes('tools/call') && row.rpcIdentity?.kind === 'number' ||
        row.methods.includes('tools/call') && row.rpcIdentity?.kind === 'string');
      expect(ingress).toHaveLength(3);
      // Identical typed envelope ids are normal across real independent MCP requests.
      // Nothing here creates unique/authenticated workflow-request ownership.
      expect(ingress.map(row => row.requestId)).toEqual([null, null, null]);
      expect(ingress[0]?.rpcIdentity?.sha256).toBe(ingress[1]?.rpcIdentity?.sha256);
      expect(ingress[2]?.rpcIdentity?.sha256).not.toBe(ingress[0]?.rpcIdentity?.sha256);
      expect(observed.every(line => line.includes('identity_header=missing') &&
        line.includes('openai-request-id:missing'))).toBe(true);

      await flushLogFile();
      const file = await fs.readFile(logPath, 'utf8');
      expect(file).toContain(`rpc_id_fingerprint=${numeric}`);
      for (const privateValue of ['never-save-original-args', 'private-key', '/workspace/src/app.ts'])
        expect(file).not.toContain(privateValue);
      await flushLocalIncidents();
      const incidents = (await listLocalIncidents()).incidents.filter(row =>
        row.reason === 'mcp_missing_identity_headers');
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        source: 'app', status: 'unresolved', requestId: null,
        sessionId: null, conversationId: null,
        occurrences: 1, capture: 'not_requested', sendEvidence: 'not_observed',
        sourceEvidence: 'runtime-log-only', loadedCompanionEvidence: 'unverified'
      });
      const saved = JSON.stringify(incidents);
      for (const privateValue of ['never-save-original-args', 'private-key', '/workspace/src/app.ts', numeric, text])
        expect(saved).not.toContain(privateValue);

      // A real endpoint restart must not allocate one unresolved incident per process.
      // The incumbent fixed-slot/index owner uses the same shape-only fingerprint.
      await endpoint.stop();
      endpoint = await startMcpServer(() => ctx);
      expect((await rawPost(endpoint.urls.core, payload(1))).status).toBe(200);
      await flushLocalIncidents();
      const restored = (await listLocalIncidents()).incidents.filter(row =>
        row.reason === 'mcp_missing_identity_headers');
      expect(restored).toHaveLength(1);
      expect(restored[0]?.id).toBe(incidents[0]?.id);
      expect(restored[0]?.occurrences).toBe(1);
    } finally {
      stop();
      await flushLogFile();
      await flushLocalIncidents();
      resetLoggerForTests();
    }
  });


  it('does not mistake an authenticated request header or a bare protocol probe for missing tool caller identity', async () => {
    const logPath = path.join(base, 'rpc-attribution-negative', 'app.log');
    initLogFile(logPath);
    try {
      const validId = 'wfr_ingress_verified';
      const call = (id: number, method: string) =>
        JSON.stringify({ jsonrpc: '2.0', id, method,
          params: method === 'tools/call' ? { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } } : {} });
      expect((await rawPost(endpoint.urls.core, call(1, 'tools/call'), {
        'x-request-id': `${validId}/att1`
      })).status).toBe(200);
      expect((await rawPost(endpoint.urls.core, call(2, 'tools/list'))).status).toBe(200);
      await flushLocalIncidents();
      expect((await listLocalIncidents()).incidents.filter(row =>
        row.reason === 'mcp_missing_identity_headers')).toEqual([]);
      expect(recentMcpIngress('core', 0).records.filter(row =>
        row.methods.includes('tools/call'))).toEqual([
          expect.objectContaining({ requestId: validId })
        ]);
      // The positive header-less tools/call is the first proven loss of per-call
      // attribution, and only then should this server lifetime report one incident.
      expect((await rawPost(endpoint.urls.core, call(3, 'tools/call'))).status).toBe(200);
      await flushLocalIncidents();
      expect((await listLocalIncidents()).incidents.filter(row =>
        row.reason === 'mcp_missing_identity_headers')).toHaveLength(1);
      await flushLogFile();
      expect(await fs.readFile(logPath, 'utf8')).not.toContain(validId);
    } finally {
      await flushLogFile();
      await flushLocalIncidents();
      resetLoggerForTests();
    }
  });

  it('bounds malformed envelope identity diagnostics and returns defensive copies', async () => {
    const since = Date.now();
    const tool = { jsonrpc: '2.0', method: 'tools/call',
      params: { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } } };
    const bodies: unknown[] = [tool, { ...tool, id: null }, { ...tool, id: 'x'.repeat(101) },
      { ...tool, id: { secret: 'must-not-retain' } }, [ { ...tool, id: 1 }, { ...tool, id: 2 } ]];
    for (const body of bodies) await rawPost(endpoint.urls.core, JSON.stringify(body));
    const rows = recentMcpIngress('core', since).records.filter(row => row.methods.includes('tools/call'));
    expect(rows.map(row => row.rpcIdentity)).toEqual([
      { kind: 'absent' }, { kind: 'null' }, { kind: 'invalid' }, { kind: 'invalid' }, { kind: 'batch' }
    ]);
    rows[0]!.rpcIdentity!.kind = 'invalid';
    expect(recentMcpIngress('core', since).records[0]?.rpcIdentity).toEqual({ kind: 'absent' });
    expect(JSON.stringify(rows)).not.toContain('must-not-retain');
    expect(JSON.stringify(rows)).not.toContain('x'.repeat(101));
  });

  it('labels real tool ingress with only the workflow header shape, including external-route loss', async () => {
    const observed: string[] = [];
    const unsubscribe = onLog(row => {
      if (row.message.includes('identity_header=')) observed.push(row.message);
    });
    try {
      const call = { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } };
      await modern('tools/call', call);
      await modern('tools/call', call, { 'x-request-id': 'invalid.workflow.header' });
      await modern('tools/call', call, { 'x-request-id': 'wfr_probe_evidence/att1' });
      await vi.waitFor(() => expect(observed).toHaveLength(3), { timeout: 1000, interval: 10 });
      expect(observed.some(line => line.includes('identity_header=missing'))).toBe(true);
      expect(observed.some(line => line.includes('identity_header=invalid'))).toBe(true);
      expect(observed.some(line => line.includes('identity_header=valid'))).toBe(true);
      expect(observed.join('\n')).not.toContain('invalid.workflow.header');
      expect(observed.join('\n')).not.toContain('wfr_probe_evidence');
      expect(observed.every(line => line.includes('mcp/core'))).toBe(true);
    } finally { unsubscribe(); }
  });

  it('diagnoses only fixed candidate-header shapes without treating alternatives or duplicates as identity', async () => {
    const observed: string[] = [];
    const unsubscribe = onLog(row => { if (row.message.includes('identity_header=')) observed.push(row.message); });
    try {
      const since = Date.now();
      const call = { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } };
      await modern('tools/call', call, { 'x-openai-request-id': 'wfr_candidate_secret/att1',
        'openai-request-id': 'invalid.candidate.secret', 'x-unrecognized-private-header': 'private-unknown-value' });
      await modern('tools/call', call, { 'x-request-id': 'wfr_first_secret/att1, wfr_second_secret/att2',
        'x-openai-request-id': 'wfr_other_secret/att1, wfr_duplicate_secret/att2' });
      await vi.waitFor(() => expect(observed).toHaveLength(2), { timeout: 1000, interval: 10 });
      expect(observed[0]).toContain('identity_header=missing identity_candidates=x-request-id:missing,x-openai-request-id:valid,openai-request-id:invalid');
      expect(observed[1]).toContain('identity_header=ambiguous identity_candidates=x-request-id:ambiguous,x-openai-request-id:ambiguous,openai-request-id:missing');
      const messages = observed.join('\n');
      for (const secret of ['candidate_secret', 'candidate.secret', 'first_secret', 'second_secret', 'other_secret', 'duplicate_secret',
        'x-unrecognized-private-header', 'private-unknown-value']) expect(messages).not.toContain(secret);
      expect(recentMcpIngress('core', since).records.every(record => record.requestId === null)).toBe(true);
      const records = recentMcpIngress('core', since).records.filter(record => record.methods.includes('tools/call'));
      expect(records.map(record => record.identityHeaders)).toEqual([
        { 'x-request-id': 'missing', 'x-openai-request-id': 'valid', 'openai-request-id': 'invalid' },
        { 'x-request-id': 'ambiguous', 'x-openai-request-id': 'ambiguous', 'openai-request-id': 'missing' }
      ]);
      records[0]!.identityHeaders!['x-request-id'] = 'valid';
      expect(recentMcpIngress('core', since).records.find(record => record.methods.includes('tools/call'))?.identityHeaders?.['x-request-id']).toBe('missing');
    } finally { unsubscribe(); }
  });

  it('counts a refused tool call, because the question is whether we were called', async () => {
    // A disabled tool still proves ChatGPT is allowed to reach the tool layer, which
    // is the only thing this clock is asked about.
    await core('tools/list');
    ctx.caps = withCaps({ read: false, browse: false, metadata: false });
    const res = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } });
    expect(JSON.stringify(res.body)).toContain('TOOL_DISABLED');
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('does not let the app’s own self-test count as ChatGPT reaching this PC', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(endpoint.urls.core, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), {
      ...selfTestHeaders()
    });
    expect(lastRequestAt()).toBeNull();

    // Anyone else claiming the header without the per-session value is just a caller.
    await rawPost(endpoint.urls.core, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), {
      'x-local-self-test': 'guessed'
    });
    expect(lastRequestAt()).not.toBeNull();
  });

  it('does not count tunnel-client discovery/startup probes as ChatGPT traffic', async () => {
    expect(lastRequestAt()).toBeNull();
    await rawPost(
      endpoint.urls.core,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }
      }),
      tunnelProbeHeaders()
    );
    expect(lastRequestAt()).toBeNull();
  });

  it('serves protected resource metadata per surface, naming that surface', async () => {
    for (const id of publishedSurfaceIds()) {
      const surface = surfaceDefinition(id);
      const url = new URL(endpoint.urls[id]);
      url.pathname = `/.well-known/oauth-protected-resource${url.pathname}`;
      const res = await rawGet(url.toString());

      expect(res.status, surface.id).toBe(200);
      expect(res.headers['content-type'], surface.id).toContain('application/json');

      const metadata = JSON.parse(res.text);
      // RFC 9728 requires `resource`; it must name this exact endpoint.
      expect(metadata.resource, surface.id).toBe(endpoint.urls[id]);
      expect(metadata.resource_name, surface.id).toBe(surface.connectorName);
      // No authorization server means "not OAuth protected", which is the truth here
      // and stops a client from starting a flow it can never complete.
      expect(metadata.authorization_servers, surface.id).toEqual([]);
    }
  });

  it('does not leak either secret token at the unauthenticated well-known root', async () => {
    const url = new URL(endpoint.urls.core);
    const tokens = publishedSurfaceIds().map((id) => new URL(endpoint.urls[id]).pathname.split('/').pop() ?? '');
    url.pathname = '/.well-known/oauth-protected-resource';
    const res = await rawGet(url.toString());
    expect(res.status).toBe(404);
    for (const token of tokens) expect(res.text).not.toContain(token);
  });

  it('rejects a body that declares an oversized content-length', async () => {
    const url = new URL(endpoint.urls.core);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(64 * 1024 * 1024)
          }
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        }
      );
      req.on('error', reject);
      // Deliberately never finished: the guard must answer on the headers alone.
      req.write('{"jsonrpc":"2.0"');
    });
    expect(status).toBe(413);
  });

  it('enforces the same body cap on chunked requests with no content-length', async () => {
    const url = new URL(endpoint.urls.core);
    const status = await new Promise<number>((resolve, reject) => {
      let answered = false;
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json' }
        },
        (res) => {
          answered = true;
          resolve(res.statusCode ?? 0);
          res.resume();
        }
      );
      req.on('error', (error) => {
        if (!answered) reject(error);
      });
      req.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","padding":"');
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      for (let index = 0; index < 129; index++) req.write(chunk);
      req.end('"}');
    });
    expect(status).toBe(413);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });

  it('survives a malformed body and keeps serving', async () => {
    const res = await rawPost(endpoint.urls.core, '{ this is not json');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });

  it('survives a JSON body that is not a JSON-RPC message', async () => {
    const res = await rawPost(endpoint.urls.core, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });
});

// ---------------------------------------------------------------------------
// The design this whole redesign exists for.
// ---------------------------------------------------------------------------

describe('surface boundaries', () => {
  /** Turns everything on, so each surface advertises the most it ever can. */
  const everything = (): void => {
    ctx.caps = allCaps();
    ctx.readOnly = false;
    ctx.sessionTools = true;
    ctx.agentTools = true;
  };

  it('advertises exactly Core’s tools on Core, with nothing from Desktop', async () => {
    everything();
    const names = toolNames(await core('tools/list'));
    // find is absent because exec_command is present — they are mutually exclusive.
    const coreOnly = ['agents', 'apply_patch', 'download_artifact', 'exec', 'exec_command', 'read', 'session', 'session_route', 'settings_read', 'settings_update', 'update_plan', 'view_image', 'write_stdin'];
    if (IS_WINDOWS) {
      const desktopNames = [...BROWSER_TOOLS, ...WINDOWS_COMPUTER_METHODS, 'read_clipboard', 'write_clipboard', 'exec'];
      expect(names).toEqual([...new Set([...coreOnly, ...desktopNames])].sort());
      expect(endpoint.urls.desktop).toBe('');
    } else {
      expect(names).toEqual(coreOnly);
      for (const name of surfaceDefinition('desktop').tools.filter(name => name !== 'exec')) expect(names, name).not.toContain(name);
    }
  });

  /**
   * The multi-agent field that no longer exists, everywhere it used to appear.
   *
   * Every tool once carried an optional `agent_key`, because a worker had to say who it was
   * on every call it made. A worker is now the chat it is in, so there is nothing for a model
   * to carry and nothing for one to invent — which is what this checks, since the prime
   * inventing a key for itself was a schema-reading failure, not a runtime one. The schema is
   * also the only thing ChatGPT caches per connector session, so a field absent here is a
   * field that cannot come back without a reconnect.
   */
  const keyFields = async (surface: 'core' | 'desktop'): Promise<string[]> => {
    return toolList(await (surface === 'desktop' ? desktop('tools/list') : core('tools/list')))
      .filter((tool) => {
        const properties = Object.keys(tool.inputSchema?.properties ?? {});
        return properties.some((name) => name === 'agent_key' || name.endsWith('_key')) && tool.name !== 'agents';
      })
      .map((tool) => tool.name as string);
  };

  it('offers no key field on any tool, with multi-agent fully on', async () => {
    everything();
    expect(await keyFields('core')).toEqual([]);
    expect(await keyFields('desktop')).toEqual([]);

    // Not even on `agents`, which used to keep one for recovery. An agent is the ChatGPT
    // conversation it runs in, and there is now no argument anywhere that says otherwise.
    const agentsTool = toolList(await core('tools/list')).find((tool) => tool.name === 'agents')!;
    for (const field of Object.keys(agentsTool.inputSchema.properties)) {
      expect(field, field).not.toMatch(/key|secret|token/i);
    }

    // And an ordinary read from a worker's chat carries nothing at all.
    const call1 = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(failed(call1)).toBe(false);
  });

  /**
   * The prime has to be able to say which model each worker gets — issue #67.
   *
   * The broker has accepted per-worker `model` and `reasoning_effort` for a while, validates
   * both before creating anything, and has tests for the rejection path. What it did not have
   * was any way for a caller to send them: the `workers` object is `.strict()`, so a spawn
   * naming a model was rejected outright rather than honoured. This asserts the surface, since
   * that gate is the one seam the broker's own tests cannot see.
   */
  it('lets a spawn choose a model and reasoning level per worker', async () => {
    everything();
    const agentsTool = toolList(await core('tools/list')).find((tool) => tool.name === 'agents')!;
    const worker = agentsTool.inputSchema.properties.workers.items;

    expect(Object.keys(worker.properties).sort()).toEqual(['label', 'model', 'reasoning_effort', 'task']);
    // Only `task` is required: omitting both keeps exactly the previous behaviour, which is
    // the account default, or whatever the user chose in settings.
    expect(worker.required).toEqual(['task']);
    expect(worker.additionalProperties).toBe(false);

    // Declared as an enum so the caller can discover the vocabulary instead of guessing at it
    // and having the spawn fail. `pro` belongs here: a worker is a real ChatGPT browser chat.
    expect(worker.properties.reasoning_effort.enum).toEqual([...REASONING_EFFORTS]);
    expect(worker.properties.model.type).toBe('string');

    // The task description used to tell the model the opposite — that model and reasoning were
    // fixed in app settings. A caller that believes that will never pass either field.
    expect(worker.properties.task.description).not.toMatch(/predefined by the user/i);
    for (const field of ['model', 'reasoning_effort']) {
      expect(worker.properties[field].description, field).toMatch(/app settings/i);
    }
  });

  it('removes the agents tool entirely once multi-agent is switched off', async () => {
    everything();
    expect(toolNames(await core('tools/list'))).toContain('agents');

    // The user switches the feature off and reconnects the connector, which is the one
    // reload the design is allowed to ask for. A fresh endpoint is what that reconnection
    // looks like from here.
    ctx.agentTools = false;
    await endpoint.stop();
    endpoint = await startMcpServer(() => ctx);

    expect(toolNames(await core('tools/list'))).not.toContain('agents');
    // And with it every word of the multi-agent vocabulary: nothing is left for a model to
    // aim a spawn or a handoff at.
    for (const surface of [toolList(await core('tools/list')), toolList(await desktop('tools/list'))]) {
      expect(JSON.stringify(surface)).not.toMatch(/prime|worker|swarm/i);
    }
  });

  it('advertises exactly Desktop’s tools on Desktop, with nothing from Core', async () => {
    everything();
    const names = toolNames(await desktop('tools/list'));
    const native = IS_WINDOWS
      ? [...WINDOWS_COMPUTER_METHODS, 'read_clipboard', 'write_clipboard']
      : process.platform === 'darwin' ? ['computer', 'observe'] : [];
    expect(names).toEqual([...BROWSER_TOOLS, ...native, 'exec'].sort());
    for (const name of surfaceDefinition('core').tools.filter(name => name !== 'exec')) expect(names, name).not.toContain(name);
  });

  it.skipIf(IS_WINDOWS)('does not let Desktop discovery freeze Core’s mutually-exclusive tool shape', async () => {
    // Core has not been queried yet. A Desktop request must not count as a cached Core
    // snapshot, because ChatGPT caches these two connectors independently.
    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, screen: true });
    const nativeRead = IS_WINDOWS ? WINDOWS_COMPUTER_READ_METHODS : process.platform === 'darwin' ? ['observe'] : [];
    expect(toolNames(await desktop('tools/list'))).toEqual([...BROWSER_READ_TOOLS, ...nativeRead, 'exec'].sort());

    // Before Core's first discovery the user enables command execution. Core should make
    // its one-time find-vs-exec choice from *this* state, not the state Desktop happened to
    // observe earlier.
    ctx.caps = withCaps({ search: true, command: true, screen: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).toContain('write_stdin');
    expect(names).not.toContain('find');
  });

  it('never advertises a tool its surface does not declare', async () => {
    everything();
    for (const id of publishedSurfaceIds()) {
      const declared = new Set(surfaceDeclaredTools(id));
      for (const name of toolNames(await call(id, 'tools/list'))) {
        expect(declared.has(name), `${id} advertised ${name}`).toBe(true);
      }
    }
  });

  it('leaks no Desktop schema text into a no-query Core discovery, and vice versa', async () => {
    everything();
    const coreBody = JSON.stringify((await core('tools/list')).body);
    if (IS_WINDOWS) {
      expect(coreBody).toMatch(/\bbrowser_tabs\b/);
      expect(coreBody).toMatch(/\bget_window_state\b/);
      expect(coreBody).toMatch(/\bread_clipboard\b/);
      expect(endpoint.urls.desktop).toBe('');
      return;
    }
    const desktopBody = JSON.stringify((await desktop('tools/list')).body);

    // Not just the names: the action vocabulary of the other surface must be absent too,
    // because a schema fragment is what a discovery pull actually costs. Match complete
    // vocabulary words: "account-observed" is not the Desktop action "observe".
    for (const marker of ['computer', 'observe', 'click_ref', 'captureAfter', 'write_clipboard']) {
      expect(coreBody, marker).not.toMatch(new RegExp(`\\b${marker}\\b`));
    }
    for (const marker of ['apply_patch', 'exec_command', 'write_stdin', 'save_handoff', 'Begin Patch']) {
      expect(desktopBody, marker).not.toContain(marker);
    }
  });

  it('fails a cross-surface tools/call as an unknown tool rather than forwarding it', async () => {
    everything();
    if (IS_WINDOWS) {
      expect(endpoint.urls.desktop).toBe('');
      expect(toolNames(await core('tools/list'))).toContain('get_window_state');
      return;
    }
    // Core has no `computer` handler registered at all, so this must die in the protocol
    // layer. If this ever starts succeeding, the split has become decoration.
    const onCore = await core('tools/call', { name: 'computer', arguments: { actions: [{ type: 'wait', ms: 0 }] } });
    expect(failed(onCore)).toBe(true);
    expect(JSON.stringify(onCore.body)).not.toContain('Done:');

    const onDesktop = await desktop('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(failed(onDesktop)).toBe(true);
    expect(textOf(onDesktop)).not.toContain('export const name');
    expect(JSON.stringify(onDesktop.body)).not.toContain('export const name');
  });

  it('has retired every tool name the old surface published', async () => {
    everything();
    const retired = [
      'list_roots',
      'read_file',
      'read_files',
      'list_directory',
      'search_files',
      'file_info',
      'create_file',
      'write_file',
      'write_binary_file',
      'edit_file',
      'edit_files',
      'move_path',
      'delete_file',
      'delete_directory',
      'run_command',
      'run_powershell',
      ...(!IS_WINDOWS ? ['launch_app', 'list_windows', 'read_clipboard', 'write_clipboard'] : ['observe', 'computer']),
      'open_url',
      'process',
      'screenshot',
      'wait_for_window',
      'find_ui',
      'resume_session',
      'session_history',
      'session_status',
      'save_handoff',
      'spawn_agents',
      'join_agent',
      'agent_message',
      'agent_status',
      'agent_inbox',
      'finish_agent'
    ];
    const advertised = new Set([...toolNames(await core('tools/list')), ...toolNames(await desktop('tools/list'))]);
    for (const name of retired) expect(advertised.has(name), name).toBe(false);

    // No aliases either. A retired name must be unknown to both servers, not silently
    // accepted by the one that used to own it.
    for (const name of ['read_file', 'edit_file', 'screenshot', 'join_agent']) {
      expect(failed(await core('tools/call', { name, arguments: {} })), name).toBe(true);
      expect(failed(await desktop('tools/call', { name, arguments: {} })), name).toBe(true);
    }
  });

  it('keeps the worst-case no-query discovery of each surface small', async () => {
    everything();
    const coreTools = toolList(await core('tools/list'));
    const desktopTools = toolList(await desktop('tools/list'));

    // Each populated surface includes code mode; find and the shell exec pair remain exclusive.
    expect(coreTools).toHaveLength(IS_WINDOWS ? 36 : 12);
    expect(desktopTools).toHaveLength(IS_WINDOWS ? 24 : process.platform === 'darwin' ? 11 : 9);

    // And the size, which is what a discovery pull actually costs the model on every
    // conversation that touches the connector. The ceilings sit just above what the
    // surface measures today rather than at a
    // round number well above it: a budget with room to spare is a budget that never
    // catches the regression it exists to catch.
    const coreBytes = Buffer.byteLength(JSON.stringify(coreTools), 'utf8');
    const desktopBytes = Buffer.byteLength(JSON.stringify(desktopTools), 'utf8');
    expect(coreBytes, `core tools/list is ${coreBytes} bytes`).toBeLessThan(IS_WINDOWS ? 40_750 : 21_250);
    expect(desktopBytes, `desktop tools/list is ${desktopBytes} bytes`).toBeLessThan(
      process.platform === 'linux' ? 10_000 : 19_000
    );

    // Per tool as well as per surface, so one schema cannot quietly eat the whole budget
    // while the total stays under it. `computer` is the largest by design: sixteen
    // discriminated action variants, each spelling out its own arguments, is what keeps
    // its validation errors small and its action set explicit. `exec_command` earns a narrow
    // exception for the `cmds` contract that removes whole connector round trips, including
    // the one-shell and per-command-exit semantics. `agents` is the other exception: its description is where the prime learns to write
    // shared context once instead of per worker, to batch messages into one call, and to
    // hand back RESULT/CHANGES/VALIDATION/BLOCKERS — bytes spent once at discovery to save
    // a great many in every run that follows.
    const browserSchemaBudgets: Readonly<Record<string, number>> = {
      browser_tabs: 1_250,
      browser_snapshot: 925,
      browser_screenshot: 750,
      browser_navigate: 925,
      browser_action: 1_825,
      browser_evaluate: 1_025,
      browser_console: 1_000,
      browser_network: 1_050
    };
    for (const tool of [...coreTools, ...desktopTools]) {
      const bytes = Buffer.byteLength(JSON.stringify(tool), 'utf8');
      const budget =
        browserSchemaBudgets[tool.name] ??
        (IS_WINDOWS && desktopTools.includes(tool)
          // Largest Window2 method is click at 882 bytes; composition is 1458 bytes.
          ? (tool.name === 'exec' ? 1_500 : 950)
          : tool.name === 'computer'
          // Retain the existing legacy schema allowance on macOS.
          ? 7_400
          : tool.name === 'apply_patch'
            ? 5_000
            : tool.name === 'agents'
              ? 3_400
              : tool.name === 'exec_command'
                // Windows carries `WINDOWS_SHELL_GUIDANCE` in the same description, and that text
                // is quoted verbatim from Codex's own shell spec — it is not ours to trim to fit a
                // budget. The non-Windows number is the one that says whether *our* additions have
                // grown, so both are asserted rather than one loose bound covering both.
                ? (process.platform === 'win32' ? 3_800 : 3_500)
                : 3_000);
      expect(bytes, `${tool.name} schema is ${bytes} bytes`).toBeLessThan(budget);
    }
  });

  it('describes terminal polling factually without prescribing automatic delivery or retry policy', async () => {
    everything();
    const poll = toolList(await core('tools/list')).find(tool => tool.name === 'write_stdin');
    expect(poll?.description).toBeTruthy();
    expect(poll!.description).not.toMatch(/automatic(ally)? deliver|follows automatically|never reruns|retry the same|rather than starting/i);
  });

  it('describes both surfaces well enough for a user to set them up and a model to find them', () => {
    for (const surface of SURFACE_LIST) {
      expect(surface.serverName, surface.id).toMatch(/^chat-on-steroids-/);
      expect(surface.connectorName, surface.id).toContain('Chat On Steroids');
      expect(surface.cardSummary.length, surface.id).toBeGreaterThan(20);
      // The description is the only thing the model has before discovery, so it has to
      // carry real vocabulary rather than a label.
      expect(surface.description.length, surface.id).toBeGreaterThan(120);
      // External plugins declare their bounded schemas dynamically after installation.
      if (surface.id === 'plugins') expect(surface.tools).toEqual(['exec']);
      else expect(surface.tools.length, surface.id).toBeGreaterThan(0);
    }
    expect(surfaceDefinition('core').required).toBe(true);
    expect(surfaceDefinition('desktop').required).toBe(false);
    // Distinct names, because the connector name is also the retrieval handle.
    expect(surfaceDefinition('core').connectorName).not.toBe(surfaceDefinition('desktop').connectorName);
  });

  it('gives each surface its own server identity and instructions', async () => {
    everything();
    for (const id of publishedSurfaceIds()) {
      const surface = surfaceDefinition(id);
      const reply = await call(id, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      });
      expect(reply.body.result.serverInfo.name, surface.id).toBe(surface.serverName);
      expect(reply.body.result.instructions, surface.id).toBeTruthy();
    }
  });
});

describe('2025-era clients', () => {
  it('answers the initialize handshake', async () => {
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(reply.status).toBe(200);
    expect(reply.body.result.serverInfo.name).toBe('chat-on-steroids-core');
    expect(reply.body.result.protocolVersion).toBeTruthy();
  });

  it('exposes the Core server instructions', async () => {
    ctx.caps = withCaps({ read: true, command: true, control: true });
    ctx.readOnly = false;
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).toContain('/workspace');
    expect(instructions).toContain('start_line/end_line applies to all returned files');
    if (IS_WINDOWS) {
      // The Windows glob gap, taught once here because it is what most shell retries were for.
      expect(instructions).toContain('PowerShell does not expand * or ? for native programs');
      expect(instructions).toContain('launch_app minimized:true');
      expect(instructions).toContain('Keep apps visible at usable size');
    } else {
      expect(instructions).toContain('normal POSIX shell');
      expect(instructions).not.toContain('PowerShell does not expand * or ? for native programs');
    }
    // Progress guidance lives once at server level rather than bloating every tool description.
    expect(instructions).toContain('more than 60 seconds during ongoing work');
    // The two round-trip levers the recorded sessions actually pay for. Both are instructions
    // rather than tool descriptions because they are about *how many calls to make*, which is a
    // decision taken before any one tool's schema is read.
    expect(instructions).toContain('exec_command cmds');
    if (process.platform === 'win32') expect(instructions).toContain('Windows safety rules:');
    expect(instructions).toContain('no new browser/profile/debug port per attempt');
    expect(instructions).toContain('Read whole files for orientation');
    expect(instructions).toContain('look for AGENTS.md');
    expect(instructions).not.toContain('/workspace/src/main.ts');
    expect(instructions).not.toMatch(/functions\.|SKILL\.md|request_user_input|approval auto-review/);
    // The requested upstream collaboration prose replaces the old minimal tool preamble.
    expect(instructions).toContain('User authorization and preferences persist across turns.');
    expect(instructions.length).toBeLessThan(18_000);
  });

  it('does not advertise native app launch when control capability is disabled', async () => {
    ctx.caps = withCaps({ read: true, command: true, control: false });
    ctx.readOnly = false;
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).not.toContain('launch_app minimized:true');
    expect(instructions).toContain('/workspace');
  });

  it('points at the other connector rather than pretending the capability does not exist', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    const coreReply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    if (IS_WINDOWS) {
      expect(coreReply.body.result.instructions).toContain('share Windows Core');
      expect(coreReply.body.result.instructions).not.toContain(surfaceDefinition('desktop').connectorName);
      expect(endpoint.urls.desktop).toBe('');
      return;
    } else if (process.platform === 'darwin') {
      expect(coreReply.body.result.instructions).toContain(surfaceDefinition('desktop').connectorName);
    } else {
      expect(coreReply.body.result.instructions).not.toContain(surfaceDefinition('desktop').connectorName);
    }

    const desktopReply = await desktop('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    expect(desktopReply.body.result.instructions).toContain(surfaceDefinition('core').connectorName);
    if (IS_WINDOWS) {
      expect(desktopReply.body.result.instructions).toContain('get_window_state');
      expect(desktopReply.body.result.instructions).toContain('sky');
    } else {
      expect(desktopReply.body.result.instructions).toContain('observe');
      expect(desktopReply.body.result.instructions).toContain('Do not poll with a batch that only waits');
      expect(desktopReply.body.result.instructions).toContain('verify');
    }
  });

  it('lists tools without an initialize handshake', async () => {
    const reply = await core('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('read');
  });

  it('calls a tool', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('exposes Codex view_image separately and returns native MCP image content', async () => {
    const tool = toolList(await core('tools/list')).find((entry) => entry.name === 'view_image');
    const schema = tool?.inputSchema;
    expect(Object.keys(schema?.properties ?? {})).toEqual(['path']);
    expect(schema?.required).toEqual(['path']);
    expect(schema?.additionalProperties).toBe(false);
    expect(tool?.outputSchema).toBeUndefined();

    const reply = await core('tools/call', {
      name: 'view_image',
      arguments: { path: '/workspace/pixel.png' }
    });
    expect(reply.status).toBe(200);
    const content = reply.body.result?.content as Array<Record<string, unknown>>;
    const image = content.find((item) => item.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(typeof image?.data).toBe('string');
    expect(Buffer.from(String(image?.data), 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(reply.body.result?.structuredContent).toEqual({
      cosResultReceipt: { version: 1, id: expect.stringMatching(/^[a-f0-9]{48}$/) }
    });
  });
});

describe('2026-07-28 clients', () => {
  it.each(['server/discover', 'tools/list'])('returns JSON for modern %s', async method => {
    const reply = await modern(method);
    expect(reply.status).toBe(200);
    expect(reply.body.error).toBeUndefined();
    expect(reply.headers['content-type']).toContain('application/json');
  });
  it('lists tools when the request carries the _meta envelope', async () => {
    const reply = await modern('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('read');
  });

  it('calls a tool', async () => {
    const reply = await modern('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('rejects a modern request whose headers disagree with its body', async () => {
    const reply = await modern('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } }, {
      'Mcp-Name': 'apply_patch'
    });
    expect(reply.status).toBe(400);
  });
});

describe('capability gating', () => {
  it.runIf(IS_WINDOWS)('keeps approved OS-critical files readable but refuses every structured patch effect before writes', async () => {
    const critical = path.join(approved, 'critical-system-fixture');
    const source = path.join(critical, 'keep.txt');
    const destination = path.join(approved, 'safe-source.txt');
    await fs.mkdir(critical, { recursive: true });
    await fs.writeFile(source, 'keep\n');
    await fs.writeFile(destination, 'safe\n');
    await fs.symlink(critical, path.join(approved, 'critical-system-alias'), 'junction');
    const previousSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = critical;
    try {
      ctx.readOnly = false;
      ctx.caps = withCaps({ read: true, create: true, edit: true, move: true, deleteFile: true });
      const read = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/critical-system-fixture/keep.txt'] } });
      expect(failed(read)).toBe(false);
      expect(textOf(read)).toContain('keep');
      const patches = [
        ['*** Add File: /workspace/guard-preflight.txt', '+not committed', '*** Add File: /workspace/critical-system-fixture/new.txt', '+forbidden'],
        ['*** Delete File: /workspace/critical-system-fixture/keep.txt'],
        ['*** Delete File: /workspace/critical-system-alias/keep.txt'],
        ['*** Update File: /workspace/critical-system-fixture/keep.txt', '*** Move to: /workspace/moved-system.txt', '@@', ' keep'],
        ['*** Update File: /workspace/safe-source.txt', '*** Move to: /workspace/critical-system-fixture/moved.txt', '@@', ' safe']
      ];
      for (const body of patches) {
        const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch: ['*** Begin Patch', ...body, '*** End Patch'].join('\n') } });
        expect(failed(reply)).toBe(true);
        expect(textOf(reply)).toContain('SYSTEM_PATH_PROTECTED');
      }
      expect(await fs.readFile(source, 'utf8')).toBe('keep\n');
      expect(await fs.readFile(destination, 'utf8')).toBe('safe\n');
      await expect(fs.stat(path.join(approved, 'guard-preflight.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
    }
  });

  it('refuses a hardlink overwrite through structured patch while preserving both files', async () => {
    const original = path.join(outside, 'hardlink-protected.txt');
    const alias = path.join(approved, 'hardlink-outside-alias.txt');
    await fs.writeFile(original, 'keep\n');
    await fs.link(original, alias);
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: true });
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch: addPatch('/workspace/hardlink-outside-alias.txt', ['forbidden']) } });
    expect(failed(reply)).toBe(true);
    expect(textOf(reply)).toContain('HARDLINK_WRITE_PROTECTED');
    expect(await fs.readFile(original, 'utf8')).toBe('keep\n');
    expect(await fs.readFile(alias, 'utf8')).toBe('keep\n');
  });
  it('hides every writing and running tool in read-only mode', async () => {
    // Everything on, but read-only, which is the state that must still be safe.
    const config = { ...defaultConfig(), capabilities: allCaps(), readOnly: true };
    ctx.caps = effectiveCapabilities(config);
    ctx.readOnly = true;

    expect(toolNames(await core('tools/list'))).toEqual(IS_WINDOWS
      ? [...BROWSER_READ_TOOLS, ...WINDOWS_COMPUTER_READ_METHODS, 'read_clipboard', 'exec', 'find', 'read', 'settings_read', 'view_image'].sort()
      : ['exec', 'find', 'read', 'settings_read', 'view_image']);
  });

  it('offers apply_patch only when a writing permission is on', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('apply_patch');
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
  });

  it('enforces the create/edit/move/delete split inside one apply_patch schema', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: false, move: false, deleteFile: false });

    const added = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/split.txt', ['one']) }
    });
    expect(added.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');

    const addOverExisting = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/split.txt', ['overwritten through add']) }
    });
    expect(addOverExisting.body.result?.isError).toBe(true);
    expect(textOf(addOverExisting)).toContain('Edit files is disabled');
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');

    const updated = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: ['*** Begin Patch', '*** Update File: /workspace/split.txt', '@@', '-one', '+two', '*** End Patch'].join('\n')
      }
    });
    expect(updated.body.result?.isError).toBe(true);
    expect(textOf(updated)).toContain('Edit files is disabled');
    // Refused before anything was written, which is the whole promise of apply_patch.
    expect(await fs.readFile(path.join(approved, 'split.txt'), 'utf8')).toBe('one\n');

    const deleted = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/split.txt', '*** End Patch'].join('\n') }
    });
    expect(deleted.body.result?.isError).toBe(true);
    expect(textOf(deleted)).toContain('Delete files is disabled');
  });

  it('keeps command execution off unless it is explicitly enabled', async () => {
    ctx.readOnly = false;
    expect(toolNames(await core('tools/list'))).not.toContain('exec_command');

    ctx.caps = withCaps({ command: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).toContain('write_stdin');
  });

  it('drops find when exec_command can do the same job better', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true, search: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('exec_command');
    expect(names).not.toContain('find');
  });

  it('offers find when there is no shell to search with', async () => {
    ctx.caps = withCaps({ search: true, command: false });
    expect(toolNames(await core('tools/list'))).toContain('find');

    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'helper', mode: 'content' }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).toContain('results_returned:');
  });

  it('offers session and agents only when those features are on', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('session');
    expect(toolNames(await core('tools/list'))).not.toContain('agents');

    ctx.sessionTools = true;
    ctx.agentTools = true;
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('session');
    expect(names).toContain('agents');
  });

  it('teaches primes to reuse sleeping workers before spawning replacements', async () => {
    ctx.agentTools = true;
    const initialized = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = initialized.body.result.instructions ?? '';
    expect(instructions).toContain('Reuse suitable sleeping workers; replace only terminal workers with exhausted context');
    expect(instructions).toContain('Reports arrive only with tool results; they do not restart an idle prime');
    expect(instructions).toContain('do not claim delegated verification is complete before reading its report');

    const tools = await core('tools/list');
    const agentsDescription = (tools.body.result.tools as Array<{ name: string; description?: string }>).find(
      (tool) => tool.name === 'agents'
    )?.description;
    expect(agentsDescription).toContain('Reuse a suitable sleeping worker with message before spawn');
    expect(agentsDescription).toContain('status once to collect pending reports before finalizing');
    expect(agentsDescription).toContain('state that review is pending');
  });

  it('rejects action-specific agent fields instead of silently ignoring them', async () => {
    ctx.agentTools = true;
    const reply = await core('tools/call', {
      name: 'agents',
      arguments: { action: 'status', result: 'this field belongs to finish' }
    });
    expect(failed(reply)).toBe(true);
  });

  it('discovers recent recordings and searches exact overflow text without caller identity', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'cross-chat discovery target', conversationId: null });
    const overflow = 'ordinary prefix followed by cross-session-deep-needle in the exact spilled result';
    const overflowId = await writeOverflowText(recorded.id, overflow);
    expect(overflowId).not.toBeNull();
    await appendEvent(recorded.id, {
      time: 2_000,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'internal-long-id-that-must-not-be-presented',
        tool: 'read',
        attribution: 'unattributed',
        requestId: null,
        conversationId: null,
        attributionMethod: 'unattributed',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ordinary prefix', truncated: true, chars: overflow.length, assetId: overflowId! },
        outcome: 'ok',
        durationMs: 7,
        summary: { kind: 'read', tone: 'neutral', title: 'Read hidden payload' }
      }
    });

    const listed = await core('tools/call', { name: 'session', arguments: { action: 'search' } });
    expect(failed(listed), textOf(listed)).toBe(false);
    expect(textOf(listed)).toContain('Recorded sessions — newest first');
    expect(textOf(listed)).toContain(recorded.id);
    expect(textOf(listed)).toContain('cross-chat discovery target');

    const searched = await core('tools/call', {
      name: 'session',
      arguments: { action: 'search', query: 'cross-session-deep-needle' }
    });
    const searchText = textOf(searched);
    expect(failed(searched), searchText).toBe(false);
    expect(searchText).toContain(recorded.id);
    expect(searchText).toContain('matches: tools 1');
    expect(searchText).toMatch(/read_cursor: [A-Za-z0-9_-]+/);
    expect(searchText.length).toBeLessThanOrEqual(12_000);
  });

  it('reads exact user and assistant prose, filters headlines, and expands a short session-local tool ref', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'exact transcript target', conversationId: null });
    const userTail = 'USER-TAIL-MUST-SURVIVE';
    const assistantTail = 'ASSISTANT-TAIL-MUST-SURVIVE';
    const userText = `${'u'.repeat(900)}${userTail}`;
    const assistantText = `${'a'.repeat(900)}${assistantTail}`;
    await appendEvent(recorded.id, {
      time: 3_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: userText, truncated: false, chars: userText.length }
    });
    await appendEvent(recorded.id, {
      time: 3_001,
      source: 'extension',
      kind: 'assistant_message',
      message: { text: assistantText, truncated: false, chars: assistantText.length },
      final: true,
      state: 'final'
    });
    const call = await appendEvent(recorded.id, {
      time: 3_002,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'opaque-internal-call-id',
        tool: 'exec_command',
        attribution: 'request_id',
        requestId: 'opaque-request-id',
        conversationId: null,
        attributionMethod: 'request_id',
        args: { text: '{"cmd":"npm test"}', truncated: false, chars: 18 },
        result: { text: 'all targeted tests passed', truncated: false, chars: 25 },
        outcome: 'ok',
        durationMs: 123,
        summary: { kind: 'run', tone: 'good', title: 'Ran targeted tests', metric: '14 passed' }
      }
    });
    const shortRef = `T${call.seq.toString(36).toUpperCase()}`;

    const read = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id }
    });
    const readText = textOf(read);
    expect(failed(read), readText).toBe(false);
    expect(readText).toContain(userText);
    expect(readText).toContain(assistantText);
    expect(readText).toContain(`${shortRef} exec_command OK`);
    expect(readText).not.toContain('opaque-internal-call-id');
    // Recorded attribution identity is now explicit read-only evidence, not tool-call authority.
    expect(readText).toContain('core-request=opaque-request-id');
    expect(readText).toMatch(/update_cursor: [A-Za-z0-9_-]+/);

    const toolsOnly = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, include: ['tools'] }
    });
    expect(textOf(toolsOnly)).toContain(`${shortRef} exec_command OK`);
    expect(textOf(toolsOnly)).not.toContain(userTail);
    expect(textOf(toolsOnly)).not.toContain(assistantTail);

    const detail = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, tool_call: shortRef }
    });
    const detailText = textOf(detail);
    expect(failed(detail), detailText).toBe(false);
    expect(detailText).toContain(`${shortRef} — exec_command`);
    expect(detailText).toContain('{"cmd":"npm test"}');
    expect(detailText).toContain('all targeted tests passed');
    expect(detailText).not.toContain('opaque-internal-call-id');
  });

  it('losslessly pages a message larger than the five-thousand-token read budget', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'large exact message', conversationId: null });
    const message = `MESSAGE-BEGIN-${'0123456789'.repeat(2_300)}-MESSAGE-END`;
    await appendEvent(recorded.id, {
      time: 4_000,
      source: 'extension',
      kind: 'assistant_message',
      message: { text: message, truncated: false, chars: message.length },
      final: true,
      state: 'final'
    });

    let reply = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, include: ['assistant'] }
    });
    let combined = textOf(reply);
    expect(combined).toContain('MESSAGE-BEGIN');
    expect(combined.length).toBeLessThanOrEqual(20_000);
    for (let page = 0; page < 5 && !combined.includes('MESSAGE-END'); page++) {
      const cursor = /continuation_cursor: ([A-Za-z0-9_-]+)/.exec(textOf(reply))?.[1];
      expect(cursor).toBeTruthy();
      reply = await core('tools/call', {
        name: 'session',
        arguments: { action: 'read', session_id: recorded.id, cursor }
      });
      expect(textOf(reply).length).toBeLessThanOrEqual(20_000);
      combined += textOf(reply);
    }
    expect(combined).toContain('MESSAGE-END');
    expect(combined).not.toContain('…');
  });

  it('uses update cursors to return only new concurrent work and only the suffix of an unfinished answer', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'concurrent worker knowledge', conversationId: null });
    const prefix = 'I inspected the worker ledger and found';
    await upsertMessageEvent(recorded.id, {
      time: 5_000,
      source: 'extension',
      kind: 'assistant_message',
      message: { text: prefix, truncated: false, chars: prefix.length },
      messageId: 'stable-worker-answer',
      state: 'streaming',
      final: false
    });
    const initial = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id }
    });
    const updateCursor = /update_cursor: ([A-Za-z0-9_-]+)/.exec(textOf(initial))?.[1];
    expect(updateCursor).toBeTruthy();

    const tool = await appendEvent(recorded.id, {
      time: 5_001,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'worker-new-call',
        tool: 'exec_command',
        attribution: 'agent',
        requestId: null,
        conversationId: null,
        attributionMethod: 'unattributed',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: '14 tests passed', truncated: false, chars: 15 },
        outcome: 'ok',
        durationMs: 80,
        summary: { kind: 'run', tone: 'good', title: 'Worker tests passed' }
      }
    });
    const suffix = ' that the commit happens too early.';
    await upsertMessageEvent(recorded.id, {
      time: 5_002,
      source: 'extension',
      kind: 'assistant_message',
      message: { text: prefix + suffix, truncated: false, chars: prefix.length + suffix.length },
      messageId: 'stable-worker-answer',
      state: 'final',
      final: true
    });

    const update = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, cursor: updateCursor }
    });
    const updateText = textOf(update);
    expect(failed(update), updateText).toBe(false);
    expect(updateText).toContain(`T${tool.seq.toString(36).toUpperCase()} exec_command OK`);
    expect(updateText).toContain('ASSISTANT CONTINUED [final]');
    expect(updateText).toContain(suffix);
    expect(updateText).not.toContain(prefix);
    const nextCursor = /update_cursor: ([A-Za-z0-9_-]+)/.exec(updateText)?.[1];
    expect(nextCursor).toBeTruthy();

    const unchanged = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, cursor: nextCursor }
    });
    expect(textOf(unchanged)).toContain('No new recorded activity');
  });

  it('returns an update checkpoint even when a concurrent recording has no selected activity yet', async () => {
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'worker before first result', conversationId: null });
    const empty = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, include: ['assistant', 'tools'] }
    });
    expect(failed(empty), textOf(empty)).toBe(false);
    expect(textOf(empty)).toContain('No recorded entries match');
    expect(textOf(empty)).toMatch(/update_cursor: [A-Za-z0-9_-]+/);
  });

  it('keeps cursors short and refuses a damaged copy as damaged rather than as stale history', async () => {
    // Every refused session read in the 50 most recent recorded sessions was a long base64
    // cursor the model had re-typed with a transposed letter or a doubled field. The token is
    // now short enough to copy, and a copy that does not verify says so instead of "invalid".
    ctx.sessionTools = true;
    const recorded = await createSession({ title: 'cursor copy fidelity', conversationId: null });
    const other = await createSession({ title: 'another recording', conversationId: null });
    for (let index = 0; index < 4; index++) {
      const text = `unfinished answer ${index} `.repeat(4);
      await upsertMessageEvent(recorded.id, {
        time: 6_000 + index,
        source: 'extension',
        kind: 'assistant_message',
        message: { text, truncated: false, chars: text.length },
        messageId: `open-message-${index}-${'x'.repeat(60)}`,
        state: 'streaming',
        final: false
      });
    }
    const initial = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id }
    });
    const cursor = /update_cursor: ([A-Za-z0-9_-]+)/.exec(textOf(initial))?.[1];
    expect(cursor).toBeTruthy();
    // Four open checkpoints used to cost almost a thousand characters.
    expect(cursor!.length).toBeLessThan(120);

    const damaged = cursor!.replace(/(\d)(\d)/, '$2$1').replace(/^u(\d)/, 'u$1$1');
    expect(damaged).not.toBe(cursor);
    const refused = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, cursor: damaged }
    });
    expect(failed(refused)).toBe(true);
    expect(textOf(refused)).toContain('damaged while being copied');
    expect(textOf(refused)).toContain('Copy the cursor exactly');
    expect(textOf(refused)).not.toContain('stale');

    const foreign = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: other.id, cursor }
    });
    expect(failed(foreign)).toBe(true);
    expect(textOf(foreign)).toContain(`does not verify for session ${other.id}`);

    // The ways a model re-types a token it was shown are tolerated.
    const decorated = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, cursor: `update_cursor: \`${cursor!.toUpperCase()}\`.` }
    });
    expect(failed(decorated), textOf(decorated)).toBe(false);
    expect(textOf(decorated)).toContain('No new recorded activity');

    const wrongAction = await core('tools/call', {
      name: 'session',
      arguments: { action: 'search', cursor }
    });
    expect(failed(wrongAction)).toBe(true);
    expect(textOf(wrongAction)).toContain('does not verify');
    const listed = await core('tools/call', { name: 'session', arguments: { action: 'search', query: 'unfinished answer 3' } });
    const readCursor = /read_cursor: ([A-Za-z0-9_-]+)/.exec(textOf(listed))?.[1];
    expect(readCursor).toBeTruthy();
    const readAsSearch = await core('tools/call', { name: 'session', arguments: { action: 'search', cursor: readCursor } });
    expect(failed(readAsSearch)).toBe(true);
    expect(textOf(readAsSearch)).toContain('does not verify');
    const fromSearch = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read', session_id: recorded.id, cursor: readCursor }
    });
    expect(failed(fromSearch), textOf(fromSearch)).toBe(false);
    expect(textOf(fromSearch)).toMatch(/recorded context/i);
  });

  it('rejects the removed history/status contract and ambiguous read fields', async () => {
    ctx.sessionTools = true;
    const advertised = toolList(await core('tools/list')).find((tool) => tool.name === 'session');
    expect(advertised?.inputSchema).toMatchObject({
      properties: { action: { enum: ['search', 'read', 'incidents'] } },
      required: ['action']
    });
    expect(advertised?.inputSchema?.properties).not.toHaveProperty('limit');
    expect(advertised?.inputSchema?.properties).not.toHaveProperty('call_id');
    expect(advertised?.inputSchema?.properties).not.toHaveProperty('part');

    const oldHistory = await core('tools/call', {
      name: 'session',
      arguments: { action: 'history' }
    });
    expect(failed(oldHistory)).toBe(true);

    const missingSession = await core('tools/call', {
      name: 'session',
      arguments: { action: 'read' }
    });
    expect(failed(missingSession)).toBe(true);

    const oldLimit = await core('tools/call', {
      name: 'session',
      arguments: { action: 'search', limit: 40 }
    });
    expect(failed(oldLimit)).toBe(true);
  });

  it('starts a fresh install with every capability effective', () => {
    // This assertion is about the product's fully-enabled fresh-install policy, not the
    // host running Vitest. Windows has no OS-version floor, so it is the deterministic
    // representative for a host with every declared capability.
    const config = defaultConfig('win32');
    expect(config.readOnly).toBe(false);
    expect(config.multiAgent.enabled).toBe(true);
    expect(Object.values(effectiveCapabilities(config, 'win32')).every(Boolean)).toBe(true);
  });

  it('refuses to call a tool that is not registered', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/notes.txt', '*** End Patch'].join('\n') }
    });
    // Either a JSON-RPC error or a tool error, but never a deletion.
    expect(failed(reply)).toBe(true);
    expect(await fs.readFile(path.join(approved, 'notes.txt'), 'utf8')).toContain('note line 1');
  });

  it('answers metadata-only permission with metadata rather than refusing the path', async () => {
    ctx.caps = withCaps({ read: false, browse: false, metadata: true });
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('/workspace/src/app.ts');
    expect(text).toContain('need the Read files permission');
    expect(text).not.toContain('export const name');
  });

  it('picks up a permission change on the very next request', async () => {
    expect(toolNames(await core('tools/list'))).not.toContain('apply_patch');
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');
  });

  it('keeps an already-exposed tool stable and returns TOOL_DISABLED after permission is revoked', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');

    ctx.caps = withCaps({ create: false });
    expect(toolNames(await core('tools/list'))).toContain('apply_patch');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/should-not-exist.txt', ['nope']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('TOOL_DISABLED');
    await expect(fs.stat(path.join(approved, 'should-not-exist.txt'))).rejects.toThrow();
  });

  // find and the exec pair are mutually exclusive: find exists so that a user who has
  // not granted command execution still gets a way to search. But `exposedCaps` only ever
  // widens, so deriving find's registration from the live "command is off" would DELETE a
  // tool from an already-cached ChatGPT snapshot the moment the user granted commands —
  // the exact stale-snapshot failure the monotonic rule exists to prevent.
  it('keeps find listed after command execution is switched on mid-run', async () => {
    ctx.caps = withCaps({ search: true, read: true, browse: true });
    expect(toolNames(await core('tools/list'))).toContain('find');

    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, read: true, browse: true, command: true });
    const names = toolNames(await core('tools/list'));
    expect(names).toContain('find');
    expect(names).toContain('exec_command');
  });

  it('does not add find to a surface that started with command execution on', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ search: true, read: true, command: true });
    expect(toolNames(await core('tools/list'))).not.toContain('find');

    ctx.caps = withCaps({ search: true, read: true, command: false });
    expect(toolNames(await core('tools/list'))).not.toContain('find');
  });

  it('always offers read, because that is what the app is for', async () => {
    ctx.caps = withCaps({ browse: false, search: false, read: false, metadata: false });
    // Nothing is registered when every reading permission is off — but the snapshot is
    // monotonic, so a surface that started with reading on keeps it and refuses instead.
    expect(toolNames(await core('tools/list'))).toEqual([]);
  });
});

describe('desktop capabilities', () => {
  it('advertises nothing until a desktop permission is turned on', async () => {
    ctx.readOnly = false;
    expect(toolNames(await desktop('tools/list'))).toEqual([]);
  });

  it('offers looking at the screen without offering control of it', async () => {
    ctx.caps = withCaps({ screen: true });
    const names = toolNames(await desktop('tools/list'));
    const nativeRead = IS_WINDOWS ? WINDOWS_COMPUTER_READ_METHODS : process.platform === 'darwin' ? ['observe'] : [];
    expect(names).toEqual([...BROWSER_READ_TOOLS, ...nativeRead, 'exec'].sort());
  });

  // Seeing the screen changes nothing, so it survives read-only mode; driving the
  // mouse and keyboard can do anything the user can, so it must not.
  it('keeps seeing but not touching in read-only mode', async () => {
    // Exercise the read-only capability split on a platform with a native Desktop backend rather
    // than making the result depend on the CI host.
    const config = { ...defaultConfig('win32'), capabilities: withCaps({ screen: true, control: true }) };

    ctx.readOnly = true;
    ctx.caps = effectiveCapabilities({ ...config, readOnly: true }, 'win32');
    expect(ctx.caps.screen).toBe(true);
    expect(ctx.caps.control).toBe(false);
    const nativeRead = IS_WINDOWS ? WINDOWS_COMPUTER_READ_METHODS : process.platform === 'darwin' ? ['observe'] : [];
    expect(toolNames(await desktop('tools/list'))).toEqual([...BROWSER_READ_TOOLS, ...nativeRead, 'exec'].sort());

    ctx.readOnly = false;
    ctx.caps = effectiveCapabilities({ ...config, readOnly: false }, 'win32');
    expect(toolNames(await desktop('tools/list'))).toContain(IS_WINDOWS ? 'click' : process.platform === 'darwin' ? 'computer' : 'browser_action');
  });

  it('offers clipboard access alone and refuses operations whose permission is revoked', async () => {
    ctx.readOnly = false;
    // Publish the schema once, then exercise live revocation on the same endpoint.
    ctx.caps = withCaps({ screen: true, control: true, clipboardRead: true, clipboardWrite: true });
    await desktop('tools/list');
    ctx.caps = withCaps({ control: false, clipboardRead: true, clipboardWrite: false });

    const clicked = await desktop('tools/call', {
      name: IS_WINDOWS ? 'click' : 'computer',
      arguments: IS_WINDOWS ? { window: { app: 'fixture.exe', id: 1 }, x: 5, y: 5 } : { actions: [{ type: 'click', x: 5, y: 5 }] }
    });
    expect(clicked.body.result?.isError).toBe(true);
    expect(textOf(clicked)).toContain(IS_WINDOWS ? 'TOOL_DISABLED' : 'mouse and keyboard control is disabled');

    const written = await desktop('tools/call', {
      name: IS_WINDOWS ? 'write_clipboard' : 'computer',
      arguments: IS_WINDOWS ? { text: 'nope' } : { actions: [{ type: 'write_clipboard', text: 'nope' }] }
    });
    expect(written.body.result?.isError).toBe(true);
    expect(textOf(written)).toContain(IS_WINDOWS ? 'TOOL_DISABLED' : 'Replace clipboard text permission');
  });

  it('publishes only the clipboard read tool and composition with clipboard-read permission alone', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ clipboardRead: true });
    expect(toolNames(await desktop('tools/list'))).toEqual(IS_WINDOWS ? ['exec', 'read_clipboard'] : ['computer', 'exec']);
  });

  it('marks observing read-only and control destructive', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    const tools = toolList(await desktop('tools/list'));
    const observe = tools.find((t) => t.name === (IS_WINDOWS ? 'get_window_state' : 'observe'));
    const computer = tools.find((t) => t.name === (IS_WINDOWS ? 'click' : 'computer'));
    expect(observe?.annotations?.readOnlyHint).toBe(true);
    expect(computer?.annotations?.readOnlyHint).toBe(false);
    expect(computer?.annotations?.destructiveHint).toBe(true);
  });

  it.skipIf(!IS_WINDOWS)('publishes Window2 schemas with exact window ownership and bounded wheel deltas', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ screen: true, control: true });
    const tools = toolList(await desktop('tools/list'));
    const click = tools.find(t => t.name === 'click')!.inputSchema;
    expect(click.properties.window.required).toEqual(['app', 'id']);
    expect(click.properties.element_index.type).toBe('integer');
    expect(click.properties.screenshotId.type).toBe('string');
    expect(click.properties.mouse_button.enum).toEqual(['left', 'right', 'middle', 'l', 'r', 'm']);
    const scroll = tools.find(t => t.name === 'scroll')!.inputSchema;
    expect(scroll.properties.scrollY.minimum).toBe(-1_200_000);
    expect(scroll.properties.scrollY.maximum).toBe(1_200_000);
    const integrated = toolNames(await core('tools/list'));
    for (const method of WINDOWS_COMPUTER_METHODS) expect(integrated, method).toContain(method);
    for (const name of ['observe', 'computer']) {
      expect(failed(await desktop('tools/call', { name, arguments: {} })), name).toBe(true);
    }
  });

  it.skipIf(!IS_WINDOWS)('rejects invalid Window2 input over HTTP before native observation or input', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ screen: true, control: true });
    const window = { app: 'fixture.exe', id: 1 };
    for (const [name, args] of [
      ['click', { window: { id: 1 }, x: 1, y: 1 }],
      ['click', { window, element_index: -1 }],
      ['click', { window, mouse_button: 'invalid', x: 1, y: 1 }],
      ['scroll', { window, x: 1, y: 1, scrollX: 0, scrollY: 1_200_001 }],
      ['get_window_state', { window, include_screenshot: false, include_text: false }]
    ] as const) {
      const reply = await desktop('tools/call', { name, arguments: args });
      expect(failed(reply), `${name}: ${textOf(reply)}`).toBe(true);
      expect(textOf(reply)).not.toContain('WINDOW_NOT_FOUND');
    }
    const paste = await desktop('tools/call', { name: 'type_text', arguments: { window, text: 'first\nsecond' } });
    expect(failed(paste)).toBe(true);
    expect(textOf(paste)).toContain('Replace clipboard text permission');
    ctx.caps = withCaps({ control: true });
    const revoked = await desktop('tools/call', { name: 'get_window_state', arguments: { window } });
    expect(failed(revoked)).toBe(true);
    expect(textOf(revoked)).toContain('TOOL_DISABLED');
  });

  it.skipIf(process.platform !== 'darwin')('carries the clipboard actions in the computer schema rather than as tools of their own', async () => {
    ctx.caps = withCaps({ screen: true, control: true, clipboardRead: true, clipboardWrite: true });
    ctx.readOnly = false;
    const schema = JSON.stringify(toolList(await desktop('tools/list')).find((t) => t.name === 'computer'));
    expect(schema).toContain('read_clipboard');
    expect(schema).toContain('write_clipboard');
    expect(schema).toContain('command+v on macOS');
    expect(schema).toContain('ctrl+v on Windows/Linux');
  });

  it.skipIf(process.platform !== 'darwin')('rejects a malformed action before it reaches the desktop', async () => {
    ctx.caps = withCaps({ screen: true, control: true });
    ctx.readOnly = false;
    // No coordinates, so there is nothing to click; this must fail as a tool error
    // rather than being passed on to the helper.
    const reply = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'click' }] }
    });
    expect(failed(reply)).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('rejects unknown fields inside a desktop action instead of silently dropping them', async () => {
    ctx.caps = withCaps({ control: true });
    ctx.readOnly = false;
    const reply = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'wait', ms: 0, typo_that_must_not_be_ignored: true }] }
    });
    expect(failed(reply)).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('rejects capture options that would otherwise be silently ignored', async () => {
    ctx.caps = withCaps({ control: true, screen: true });
    ctx.readOnly = false;
    const withoutCapture = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'wait', ms: 0 }], captureWindow: 123 }
    });
    expect(failed(withoutCapture)).toBe(true);

    const conflictingTargets = await desktop('tools/call', {
      name: 'computer',
      arguments: {
        actions: [{ type: 'wait', ms: 0 }],
        captureAfter: true,
        captureWindow: 123,
        captureFull: true
      }
    });
    expect(failed(conflictingTargets)).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('validates compact computer postconditions and keeps screen permission live', async () => {
    ctx.caps = withCaps({ control: true, screen: true });
    ctx.readOnly = false;
    const malformed = await desktop('tools/call', {
      name: 'computer',
      arguments: { actions: [{ type: 'wait', ms: 0 }], verify: { until: 'foreground' } }
    });
    expect(failed(malformed)).toBe(true);

    ctx.caps = withCaps({ control: true, screen: false });
    const disabled = await desktop('tools/call', {
      name: 'computer',
      arguments: {
        actions: [{ type: 'wait', ms: 0 }],
        verify: { until: 'foreground', window: 123, timeout_ms: 0 }
      }
    });
    expect(failed(disabled)).toBe(true);
    expect(textOf(disabled)).toContain('See the screen');
  });

  it.skipIf(process.platform !== 'darwin')('rejects observe options whose selected view would silently ignore them', async () => {
    ctx.caps = withCaps({ screen: true });
    const strayTimeout = await desktop('tools/call', {
      name: 'observe',
      arguments: { timeout_ms: 100 }
    });
    expect(failed(strayTimeout)).toBe(true);

    const unusedMatch = await desktop('tools/call', {
      name: 'observe',
      arguments: { what: 'active', match: 'Notepad' }
    });
    expect(failed(unusedMatch)).toBe(true);

    const impossibleShot = await desktop('tools/call', {
      name: 'observe',
      arguments: { what: 'ui', screenshot: true }
    });
    expect(failed(impossibleShot)).toBe(true);
  });
});

describe('tool annotations', () => {
  it('keeps connector annotations off copied Codex ToolSpecs', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ read: true, create: true, edit: true, move: true, deleteFile: true, command: true });
    const tools = toolList(await core('tools/list'));
    for (const name of ['view_image', 'apply_patch', 'exec_command', 'write_stdin']) {
      expect(tools.find((tool) => tool.name === name)?.annotations, name).toBeUndefined();
    }
  });

  it('retains annotations on connector-native tools', async () => {
    ctx.sessionTools = true;
    const read = toolList(await core('tools/list')).find((tool) => tool.name === 'read');
    const session = toolList(await core('tools/list')).find((tool) => tool.name === 'session');
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(read?.annotations?.destructiveHint).toBe(false);
    // Both session actions are inspection only. Marking this as a write tool makes clients
    // apply confirmation/write semantics to searching and reading local recordings.
    expect(session?.annotations?.readOnlyHint).toBe(true);
    expect(session?.annotations?.destructiveHint).toBe(false);
  });
});

describe('sandbox enforcement through the tool layer', () => {
  const escapes = [
    '/workspace/../private/passwords.txt',
    '/workspace/../../private/passwords.txt',
    '\\workspace\\..\\private\\passwords.txt',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '/private/passwords.txt',
    '/workspace/notes.txt:stream'
  ];

  it('refuses every escape attempt on read', async () => {
    for (const attempt of escapes) {
      const reply = await core('tools/call', { name: 'read', arguments: { paths: [attempt] } });
      const text = textOf(reply);
      // One bad path is a per-path failure rather than a failed call, so the assertion is
      // that the content never arrives — not that the call errored.
      expect(text, attempt).toContain('ERROR');
      expect(text, attempt).not.toContain('hunter2');
    }
  });

  it('accepts a native filesystem path when it is inside an approved root', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: [path.join(approved, 'notes.txt')] }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(textOf(reply)).toContain('note line 1');
    expect(textOf(reply)).toContain('/workspace/notes.txt');
    expect(textOf(reply)).not.toContain(approved);
  });

  it('accepts native filesystem globs through read', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: [path.join(approved, 'src', '**', '*.ts')] }
    });
    expect(reply.body.result?.isError, textOf(reply)).not.toBe(true);
    expect(textOf(reply)).toContain('/workspace/src/app.ts');
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).not.toContain(approved);
  });

  it('accepts a native filesystem search scope through find', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'helper', mode: 'content', path: path.join(approved, 'src') }
    });
    expect(reply.body.result?.isError, textOf(reply)).not.toBe(true);
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
    expect(textOf(reply)).not.toContain(approved);
  });

  it('accepts a native filesystem image path through view_image', async () => {
    ctx.caps = withCaps({ read: true });
    const reply = await core('tools/call', {
      name: 'view_image',
      arguments: { path: path.join(approved, 'pixel.png') }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    const content = reply.body.result?.content as Array<Record<string, unknown>>;
    expect(content.find((item) => item.type === 'image')?.mimeType).toBe('image/png');
  });

  it('refuses escape attempts on find', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'hunter2', mode: 'content', path: '/workspace/../private' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).not.toContain('hunter2\n');
  });

  it('refuses to write outside a root even with writes enabled', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/../private/planted.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('refuses a relative patch path that climbs out of its base', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    // apply_patch used to join the base onto the path and `posix.normalize` the result
    // before the sandbox ever saw it, which erased the `..` that checkSegment exists to
    // refuse: `/workspace/../private/planted.txt` became a clean `/private/planted.txt`
    // and arrived looking like a path that had always been absolute. Patch paths now get
    // the same treatment as a path handed to read or exec.
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('../private/planted.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('does not advertise the retired apply_patch cwd argument', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const tool = toolList(await core('tools/list')).find((entry) => entry.name === 'apply_patch')!;
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['patch']);
    expect(tool.inputSchema.required).toEqual(['patch']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it('does not let a retired cwd field silently rebase relative patch paths', async () => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    await fs.mkdir(path.join(approved, 'nested'), { recursive: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('../escaped.txt', ['x']), cwd: '/workspace/nested' }
    });
    expect(reply.body.result?.isError).toBe(true);
    await expect(fs.stat(path.join(approved, 'escaped.txt'))).rejects.toThrow();
  });

  it('still applies an ordinary relative patch path against its base', async () => {
    // The refusals above must not have been bought by breaking shorthand itself.
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true });
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('relative-landed.txt', ['x']) }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'relative-landed.txt'), 'utf8')).toContain('x');
  });

  it('never reveals a real Windows path', async () => {
    const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace'] } });
    const text = textOf(reply);
    expect(text).toContain('/workspace');
    expect(text).not.toContain(approved);
  });

  it('tells the model the approved roots and the current mode without spending a tool call', async () => {
    // list_roots is gone: the roots are one line of server instructions now, because a
    // round trip every conversation paid before it could do anything was pure overhead.
    const reply = await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    const instructions: string = reply.body.result.instructions ?? '';
    expect(instructions).toContain('/workspace');
    expect(instructions).toContain('local tools are read-only');
  });

  /**
   * Every worked example the model is shown must name a root that exists, and no error may send
   * it after a tool that does not. Both cost a refused call and a retry, and neither is visible
   * from inside the app.
   */
  it('names only live roots and live tools in what the model is shown', async () => {
    const read = toolList(await core('tools/list')).find((tool) => tool.name === 'read')!;
    const paths = String(read.inputSchema.properties.paths.description);
    expect(paths).toContain('/workspace');
    // `/project` is nobody's root; it was a hardcoded example the model could not act on.
    expect(paths).not.toContain('/project');

    // Nor may anything be invented *after* the root. `/workspace/src/main.ts` named a live
    // root and was still a worked example the model could not act on, and a worse one than
    // `/project`: a project-shaped suffix reads as a promise that the root is the project.
    // An approved root is routinely a parent holding several, and reading it the other way
    // is what produced `/<root>/AGENTS.md` for a file one folder deeper — the most repeated
    // read failure in the recorded corpus. What replaces it is the relationship, not another
    // path, so there is nothing left here that can go stale.
    expect(paths).not.toMatch(/\/workspace\/\S+\.\w+/);
    expect(paths).toContain('parent of the project');
    expect(paths).toContain('workdir');

    // list_roots is retired, so no refusal may tell the model to call it. A native path outside
    // every root is the refusal that used to, and it must still name the roots that do exist.
    const refusal = textOf(
      await core('tools/call', { name: 'read', arguments: { paths: [path.join(os.tmpdir(), 'nope.txt')] } })
    );
    expect(refusal).toContain('Approved roots');
    expect(refusal).not.toContain('list_roots');
  });
});

describe('bounded output', () => {
  it('expands a leading relative glob inside the proven chat workspace', async () => {
    const requestId = 'wfr_relative_glob';
    const conversationId = 'conv-relative-glob';
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId,
        sessionId: 'session-relative-glob',
        messageId: 'message-relative-glob',
        tool: 'read',
        observedAt: Date.now()
      })
    ).toBe('stored');
    setWorkspaceFor(`chat:${conversationId}`, {
      virtual: '/workspace/src',
      real: path.join(approved, 'src')
    });

    const reply = await modern(
      'tools/call',
      { name: 'read', arguments: { paths: ['**/*.ts'], start_line: 1, end_line: 1 } },
      { 'x-request-id': `${requestId}/att1` }
    );
    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('/workspace/src/app.ts');
    expect(textOf(reply)).toContain('/workspace/src/lib/util.ts');
  });

  it('returns only the requested line range', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], start_line: 3, end_line: 5 }
    });
    const text = textOf(reply);
    expect(text).toContain('note line 3');
    expect(text).toContain('note line 5');
    expect(text).not.toContain('note line 6');
    expect(text).toContain('lines 3-5');
    // The total is unknown after a ranged read, so the model gets a resume point
    // instead of a misleading "of ?".
    expect(text).not.toContain('of ?');
    expect(text).toContain('continue from line 6');
  });

  it('honours a line range across every file it read, and says that it did', async () => {
    // The advertised contract has to match the runtime one, or the model learns the rule
    // from a failed call instead of from the tool list.
    const readTool = toolList(await core('tools/list')).find((tool) => tool.name === 'read')!;
    expect(String(readTool.description)).toMatch(/apply to every file the call resolves to/i);
    expect(String(readTool.description)).toContain('path:12-40');
    expect(String(readTool.inputSchema.properties.start_line.description)).toMatch(/every file/i);
    expect(String(readTool.inputSchema.properties.end_line.description)).toMatch(/every file/i);

    // Refusing this was the single largest source of rejected calls in the recorded
    // sessions, and every one of them was a caller that had already said what it wanted.
    // The original objection was to dropping the range *silently* — so it is applied and
    // announced. What must never come back is a reply that looks like a whole-file read.
    const many = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt', '/workspace/src/app.ts'], start_line: 10, end_line: 12 }
    });
    expect(failed(many)).toBe(false);
    const text = textOf(many);
    expect(text).toContain('note line 10');
    expect(text).toContain('note line 12');
    expect(text).not.toContain('note line 9');
    expect(text).not.toContain('note line 13');
    // Announced in the body, and restated by the header of every section.
    expect(text).toMatch(/applied to each of the 2 files/i);
    expect(text).toMatch(/\/workspace\/notes\.txt — lines 10-12/);
    // The property the original refusal existed to protect: a file with nothing in that
    // range says so outright, so a short file can never read as a complete one.
    expect(text).toMatch(/\/workspace\/src\/app\.ts — no lines in that range/);

    // A glob is the usual way one path turns into several, so it must behave identically.
    const glob = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/**/*.ts'], start_line: 1, end_line: 1 }
    });
    expect(failed(glob)).toBe(false);
    expect(textOf(glob)).toMatch(/lines 1-1/);

    // One path is still one path: nothing is announced when there was nothing to spread.
    const single = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], start_line: 10, end_line: 12 }
    });
    expect(textOf(single)).not.toMatch(/applied to each/i);
    expect(textOf(single)).toContain('note line 10');
  });

  it('reports the total when the whole file was read', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('lines 1-1 of 1');
    expect(text).not.toContain('continue from line');
  });

  it('returns a whole small file when it fits inside the default read budget', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'] }
    });
    const text = textOf(reply);
    expect(text).toContain('lines 1-50 of 50');
    expect(text).toContain('note line 1');
    expect(text).toContain('note line 50');
    expect(text).not.toContain('truncated');
    expect(text).not.toContain('continue from line');
  });

  it('reads a typical 1,500-line source file whole by default and tells the model not to pre-paginate', async () => {
    const lines = Array.from({ length: 1_500 }, (_, index) =>
      `${String(index + 1).padStart(4, '0')} export const measuredDefaultReadLine = '${'x'.repeat(64)}';`
    );
    await fs.writeFile(path.join(approved, 'long-default-read.ts'), `${lines.join('\n')}\n`, 'utf8');

    const readTool = toolList(await core('tools/list')).find((tool) => tool.name === 'read')!;
    expect(String(readTool.description)).toMatch(/1,500-line source file/i);
    expect(String(readTool.description)).toMatch(/do not pre-paginate/i);

    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/long-default-read.ts'] }
    });
    const text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    expect(text).toContain('lines 1-1500 of 1500');
    expect(text).toContain('1500 export const measuredDefaultReadLine');
    expect(text).not.toContain('continue from line');
  });

  /*
   * The line count is the header's answer to "how long is this file", and a range is exactly when
   * that matters: 3 lines with no denominator cannot be told apart from a whole file. The read
   * counts on past the range to fill it in.
   */
  it('states the file total on a ranged read, so a slice cannot read as the whole file', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], start_line: 3, end_line: 5 }
    });
    const text = textOf(reply);
    expect(text).toContain('lines 3-5 of 50');
    expect(text).toContain('more lines follow — continue from line 6');
  });

  it('lists a folder one level deep, marking what each entry is', async () => {
    // A folder read is one level and nothing more. Dependency folders are shown here —
    // hiding a directory the user can see in Explorer would be a lie — but nothing
    // descends into them, which is where the cost would actually have been.
    const reply = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace'] } });
    const text = textOf(reply);
    expect(text).toContain('one level');
    expect(text).toContain('d src');
    expect(text).toContain('f notes.txt');
    expect(text).not.toContain('noise.js');
    expect(text).not.toContain('app.ts');
  });

  it('validates tool arguments instead of trusting them', async () => {
    const reply = await core('tools/call', { name: 'read', arguments: { paths: [12345] } });
    expect(failed(reply)).toBe(true);
  });

  it('honours max_bytes instead of rejecting or silently ignoring the advertised read budget', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/notes.txt'], max_bytes: 60 }
    });
    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('continue from line');
    expect(textOf(reply)).not.toContain('note line 50');
  });

  it('rejects a whitespace-only find query instead of walking the workspace for everything', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: '   ', mode: 'content' }
    });
    expect(failed(reply)).toBe(true);
  });

  it('fails an exact oversized content search instead of recording an unsearched file as a successful no-match', async () => {
    ctx.caps = withCaps({ search: true });
    const oversized = path.join(approved, 'oversized-search.log');
    const handle = await fs.open(oversized, 'w');
    try {
      await handle.truncate(2 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    try {
      const reply = await core('tools/call', {
        name: 'find',
        arguments: { query: 'needle', mode: 'content', path: '/workspace/oversized-search.log' }
      });
      expect(failed(reply)).toBe(true);
      expect(textOf(reply)).toContain('File was not searched');
      expect(textOf(reply)).not.toContain('No matches');
    } finally {
      await fs.rm(oversized, { force: true });
    }
  });

  it('rejects find options that the selected mode would silently ignore', async () => {
    ctx.caps = withCaps({ search: true });
    const reply = await core('tools/call', {
      name: 'find',
      arguments: { query: 'notes', mode: 'name', regex: true }
    });
    expect(failed(reply)).toBe(true);
  });

  it('reports a missing file plainly without losing the reads that worked', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts', '/workspace/nope.txt', '/workspace/src/lib/util.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('export const name = "app";');
    expect(text).toContain('/workspace/nope.txt — ERROR');
    expect(text).toMatch(/Not found/i);
    expect(text).toContain('export const helper = 1;');
  });

  it('lists the nearest folder that does exist under a missing path', async () => {
    // A file guessed one folder too high was the most repeated read failure in the recorded
    // sessions, and every one of them was followed by a listing call. The listing now rides
    // along with the refusal, from the deepest ancestor that resolved.
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/lib/nested/util.ts'] }
    });
    const text = textOf(reply);
    expect(failed(reply)).toBe(true);
    expect(text).toMatch(/Not found/i);
    expect(text).toContain('The nearest existing folder is /workspace/src/lib; it contains: f util.ts');
    const top = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/lib/util.ts'] } });
    expect(textOf(top)).toMatch(/The nearest existing folder is \/workspace; it contains: .*d src, .*f notes\.txt/);
  });

  it('reads a per-path line range spelled as path:start-end', async () => {
    // Four reads in the recorded sessions asked for several ranges of one file this way and
    // were refused for the colon; the spelling is now the range it was meant to be, and a
    // path without one keeps the call-wide start_line/end_line.
    const reply = await core('tools/call', {
      name: 'read',
      arguments: {
        paths: ['/workspace/notes.txt:3-4', '/workspace/notes.txt:48', '/workspace/src/app.ts'],
        start_line: 1,
        end_line: 1
      }
    });
    const text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    expect(text).toContain('lines 3-4');
    expect(text).toContain('note line 3');
    expect(text).toContain('note line 4');
    expect(text).not.toMatch(/^5	note line 5$/m);
    expect(text).toContain('note line 48');
    expect(text).toContain('note line 50');
    expect(text).not.toContain('note line 47');
    expect(text).toContain('export const name = "app";');
    expect(text).not.toContain('applied to each of');
    const backwards = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt:9-3'] } });
    expect(failed(backwards)).toBe(true);
  });

  it('fails when every explicit read target failed, while keeping partial multi-read useful', async () => {
    const allMissing = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/nope-a.txt', '/workspace/nope-b.txt'] }
    });
    expect(failed(allMissing)).toBe(true);
    expect(textOf(allMissing)).toContain('/workspace/nope-a.txt — ERROR');
    expect(textOf(allMissing)).toContain('/workspace/nope-b.txt — ERROR');

    const partial = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts', '/workspace/nope.txt'] }
    });
    expect(failed(partial)).toBe(false);
    expect(textOf(partial)).toContain('export const name = "app";');
    expect(textOf(partial)).toContain('/workspace/nope.txt — ERROR');
  });

  it('reads several files in one call', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts', '/workspace/src/lib/util.ts'] }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('export const name = "app";');
    expect(textOf(reply)).toContain('export const helper = 1;');
  });

  it('bounds line-number expansion inside the advertised read payload budget', async () => {
    const target = path.join(approved, 'many-empty-lines.txt');
    await fs.writeFile(target, '\n'.repeat(90_000));
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/many-empty-lines.txt'], max_bytes: 64 * 1024 }
    });
    const text = textOf(reply);
    expect(failed(reply)).toBe(false);
    // Raw bytes are cheap here; decimal line-number prefixes are not. The old path enforced
    // max_bytes before numbering and could turn a 64 KiB slice into hundreds of KiB on the wire.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(72 * 1024);
    expect(text).toContain('output cap reached');
  });

  it('renders an empty logical line instead of mistaking it for no line in the range', async () => {
    await fs.writeFile(path.join(approved, 'leading-empty-line.txt'), '\nsecond\n');
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/leading-empty-line.txt'], start_line: 1, end_line: 1 }
    });
    const text = textOf(reply);
    expect(failed(reply)).toBe(false);
    expect(text).toMatch(/\n1\t(?:\n|$)/);
    expect(text).toContain('lines 1-1 of 2');
  });

  it('reports an exhausted glob scan instead of claiming there were no matches', async () => {
    const broad = path.join(approved, 'glob-scan-cap');
    await fs.mkdir(broad, { recursive: true });
    try {
      // `walkFiles` is capped at 5,000 examined entries. Put the only matching file after that
      // boundary lexically so the old adapter dropped walk.truncated and lied with "no matches".
      for (let start = 0; start < 5_000; start += 200) {
        await Promise.all(
          Array.from({ length: Math.min(200, 5_000 - start) }, (_, offset) =>
            fs.writeFile(path.join(broad, `${String(start + offset).padStart(5, '0')}.txt`), '')
          )
        );
      }
      await fs.writeFile(path.join(broad, 'zzzzz.needle.ts'), 'export const needle = true;\n');

      const reply = await core('tools/call', {
        name: 'read',
        arguments: { paths: ['/workspace/glob-scan-cap/**/*.needle.ts'] }
      });
      const text = textOf(reply);
      expect(failed(reply)).toBe(false);
      expect(text).toContain('glob scan stopped after 5000 entries');
      expect(text).not.toContain(': no matches');
    } finally {
      await fs.rm(broad, { recursive: true, force: true });
    }
  });

  it('does not call an exactly-full glob result truncated until a 21st match actually exists', async () => {
    const folder = path.join(approved, 'exact-glob-cap');
    await fs.mkdir(folder, { recursive: true });
    for (let index = 0; index < 20; index++) {
      await fs.writeFile(path.join(folder, `match-${String(index).padStart(2, '0')}.ts`), `export const n = ${index};\n`);
    }

    const exact = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/exact-glob-cap/*.ts'] }
    });
    expect(failed(exact)).toBe(false);
    expect(textOf(exact)).not.toContain('more than 20 matches');

    await fs.writeFile(path.join(folder, 'match-20.ts'), 'export const n = 20;\n');
    const overflow = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/exact-glob-cap/*.ts'] }
    });
    expect(failed(overflow)).toBe(false);
    expect(textOf(overflow)).toContain('more than 20 matches');
  });

  it('expands a glob rather than making the model list the files itself', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/**/*.ts'] }
    });
    const text = textOf(reply);
    expect(text).toContain('export const name = "app";');
    expect(text).toContain('export const helper = 1;');
  });

  it('says so when a glob matches nothing instead of failing the call', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/**/*.nothing'] }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('no matches');
  });
});

describe('apply_patch', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ create: true, edit: true, move: true, deleteFile: true });
  });

  it('resolves later hunks against files created earlier in the same patch', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Add File: /workspace/fresh-sequential.ts',
          '+const fresh = 1;',
          '*** Update File: /workspace/fresh-sequential.ts',
          '@@',
          '-const fresh = 1;',
          '+const fresh = 2;',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'fresh-sequential.ts'), 'utf8')).toBe('const fresh = 2;\n');
  });

  it('adds, updates, moves and deletes through one tool', async () => {
    const added = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/scratch.txt', ['first', 'second']) }
    });
    expect(added.body.result?.isError).toBeFalsy();
    expect(textOf(added)).toContain('A /workspace/scratch.txt');

    const edited = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: ['*** Begin Patch', '*** Update File: /workspace/scratch.txt', '@@', '-second', '+SECOND', '*** End Patch'].join('\n')
      }
    });
    expect(edited.body.result?.isError).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'scratch.txt'), 'utf8')).toContain('SECOND');

    const moved = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/scratch.txt',
          '*** Move to: /workspace/moved.txt',
          '@@',
          ' SECOND',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(moved.body.result?.isError).toBeFalsy();
    await expect(fs.stat(path.join(approved, 'scratch.txt'))).rejects.toThrow();

    const deleted = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: ['*** Begin Patch', '*** Delete File: /workspace/moved.txt', '*** End Patch'].join('\n') }
    });
    expect(deleted.body.result?.isError).toBeFalsy();
    await expect(fs.stat(path.join(approved, 'moved.txt'))).rejects.toThrow();
  });

  // Current Codex rejects an entirely empty Update hunk, so a pure rename carries one
  // context-only line. That line changes no content and must not quietly require Edit.
  it('renames without Edit, and still refuses to rewrite content', async () => {
    const source = path.join(approved, 'rename-me.txt');
    const occupied = path.join(approved, 'rename-occupied.txt');
    // A move-only permission must preserve bytes. The default Codex update mode normalizes
    // CRLF to LF, so this catches an implementation that performs a text rewrite just to rename.
    await fs.writeFile(source, 'keep this\r\n', 'utf8');
    await fs.writeFile(occupied, `do not replace${String.fromCharCode(10)}`, 'utf8');
    ctx.caps = withCaps({ move: true, edit: false });

    const overwrite = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/rename-me.txt',
          '*** Move to: /workspace/rename-occupied.txt',
          '@@',
          ' keep this',
          '*** End Patch'
        ].join(String.fromCharCode(10))
      }
    });
    expect(overwrite.body.result?.isError).toBe(true);
    expect(textOf(overwrite)).toContain('Edit files is disabled');
    expect(await fs.readFile(source, 'utf8')).toContain('keep this');
    expect(await fs.readFile(occupied, 'utf8')).toContain('do not replace');

    const moved = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/rename-me.txt',
          '*** Move to: /workspace/renamed.txt',
          '@@',
          ' keep this',
          '*** End Patch'
        ].join(String.fromCharCode(10))
      }
    });
    expect(moved.body.result?.isError, textOf(moved)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'renamed.txt'), 'utf8')).toBe('keep this\r\n');

    const rewritten = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/renamed.txt',
          '*** Move to: /workspace/renamed-again.txt',
          '@@',
          '-keep this',
          '+changed',
          '*** End Patch'
        ].join(String.fromCharCode(10))
      }
    });
    expect(rewritten.body.result?.isError).toBe(true);
    expect(textOf(rewritten)).toContain('TOOL_DISABLED');
    expect(await fs.readFile(path.join(approved, 'renamed.txt'), 'utf8')).toBe('keep this\r\n');
  });

  it('rejects an empty move-only Update hunk, matching current Codex', async () => {
    const source = path.join(approved, 'empty-move-source.txt');
    const target = path.join(approved, 'empty-move-target.txt');
    await fs.writeFile(source, 'keep this\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/empty-move-source.txt',
          '*** Move to: /workspace/empty-move-target.txt',
          '*** End Patch'
        ].join('\n')
      }
    });

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain("Update file hunk for path '/workspace/empty-move-source.txt' is empty");
    expect(await fs.readFile(source, 'utf8')).toBe('keep this\n');
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('changes several files in one atomic patch', async () => {
    const a = path.join(approved, 'batch-a.txt');
    const b = path.join(approved, 'batch-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/batch-a.txt',
          '@@',
          '-alpha',
          '+ALPHA',
          '*** Update File: /workspace/batch-b.txt',
          '@@',
          '-beta',
          '+BETA',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(reply.body.result?.isError).toBeFalsy();
    expect(textOf(reply)).toContain('Success. Updated the following files:');
    expect(textOf(reply)).toContain('M /workspace/batch-a.txt');
    expect(textOf(reply)).toContain('M /workspace/batch-b.txt');
    expect(await fs.readFile(a, 'utf8')).toBe('ALPHA\n');
    expect(await fs.readFile(b, 'utf8')).toBe('BETA\n');
  });

  it.runIf(IS_WINDOWS)('rolls back earlier files when a later commit fails after verification', async () => {
    const a = path.join(approved, 'batch-runtime-fail-a.txt');
    const b = path.join(approved, 'batch-runtime-fail-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');
    // Read-only is ideal here: verification and patch matching can still read B, so the failure
    // occurs only at the second runtime write, after A has already committed in raw Codex.
    await fs.chmod(b, 0o444);
    try {
      const reply = await core('tools/call', {
        name: 'apply_patch',
        arguments: {
          patch: [
            '*** Begin Patch',
            '*** Update File: /workspace/batch-runtime-fail-a.txt',
            '@@',
            '-alpha',
            '+ALPHA',
            '*** Update File: /workspace/batch-runtime-fail-b.txt',
            '@@',
            '-beta',
            '+BETA',
            '*** End Patch'
          ].join('\n')
        }
      });
      expect(reply.body.result?.isError).toBe(true);
      expect(textOf(reply)).toContain('rolled back');
      expect(await fs.readFile(a, 'utf8')).toBe('alpha\n');
      expect(await fs.readFile(b, 'utf8')).toBe('beta\n');
    } finally {
      await fs.chmod(b, 0o666).catch(() => undefined);
    }
  });

  it('leaves every target untouched when one hunk in the patch does not apply', async () => {
    const a = path.join(approved, 'batch-fail-a.txt');
    const b = path.join(approved, 'batch-fail-b.txt');
    await fs.writeFile(a, 'alpha\n', 'utf8');
    await fs.writeFile(b, 'beta\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /workspace/batch-fail-a.txt',
          '@@',
          '-alpha',
          '+ALPHA',
          '*** Update File: /workspace/batch-fail-b.txt',
          '@@',
          '-missing',
          '+BETA',
          '*** End Patch'
        ].join('\n')
      }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(await fs.readFile(a, 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(b, 'utf8')).toBe('beta\n');
  });

  it('matches Codex Add File semantics and overwrites an existing file', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: addPatch('/workspace/notes.txt', ['clobbered']) }
    });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'notes.txt'), 'utf8')).toBe('clobbered\n');
  });

  it('names the problem when the patch itself is malformed', async () => {
    const reply = await core('tools/call', {
      name: 'apply_patch',
      arguments: { patch: 'just some text' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain("invalid patch: The first line of the patch must be '*** Begin Patch'");
  });

  it('rejects hidden environment selection in this single-environment adapter like Codex', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Environment ID: other',
      '*** Add File: env-selected.txt',
      '+should-not-land',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch } });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toBe('apply_patch environment selection is unavailable for this turn');
    await expect(fs.stat(path.join(approved, 'env-selected.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps Codex apply_patch output shape for a huge rewrite', async () => {
    const before = Array.from({ length: 1600 }, (_, index) => `old-${index}`);
    await fs.writeFile(path.join(approved, 'rewrite.txt'), `${before.join('\n')}\n`, 'utf8');
    const hunk = [
      '*** Begin Patch',
      '*** Update File: /workspace/rewrite.txt',
      '@@',
      ...before.map((line) => `-${line}`),
      ...before.map((_, index) => `+new-${index}`),
      '*** End Patch'
    ].join('\n');

    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch: hunk } });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(textOf(reply)).toContain('Exit code: 0');
    expect(textOf(reply)).toContain('Success. Updated the following files:');
    expect(textOf(reply)).toContain('M /workspace/rewrite.txt');
    expect(textOf(reply)).not.toContain('(~+');
  });

  it('returns a small image without applying the text-section byte default', async () => {
    const reply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/pixel.png'] }
    });
    expect(textOf(reply)).not.toContain('image is too large to return');
    const content = reply.body.result?.content as Array<Record<string, unknown>>;
    expect(content.some((item) => item.type === 'image')).toBe(true);
  });

  it('uses a separate bounded image budget so ordinary screenshots work through read', async () => {
    const target = path.join(approved, 'large-noise.png');
    await sharp(randomBytes(512 * 512 * 4), { raw: { width: 512, height: 512, channels: 4 } })
      .png({ compressionLevel: 0 })
      .toFile(target);

    const readReply = await core('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/large-noise.png'] }
    });
    expect(readReply.body.result?.isError, textOf(readReply)).not.toBe(true);

    const imageReply = await core('tools/call', {
      name: 'view_image',
      arguments: { path: '/workspace/large-noise.png' }
    });
    expect(imageReply.body.result?.isError, textOf(imageReply)).not.toBe(true);
    expect((imageReply.body.result?.content as Array<{ type: string }>).some((item) => item.type === 'image')).toBe(true);
    expect(readReply.body.result?.content.filter((item: any) => item.type === 'image'))
      .toEqual(imageReply.body.result?.content.filter((item: any) => item.type === 'image'));

    const batch = await core('tools/call', { name: 'read', arguments: {
      paths: [...Array(5).fill('/workspace/large-noise.png'), '/workspace/pixel.png']
    } });
    expect(batch.body.result?.content.filter((item: any) => item.type === 'image')).toHaveLength(4);
    expect(textOf(batch)).toContain('image output cap');

    await sharp(randomBytes(1500 * 1000 * 4), { raw: { width: 1500, height: 1000, channels: 4 } })
      .png({ compressionLevel: 0 }).toFile(path.join(approved, 'image-budget.png'));
    const bytes = await core('tools/call', { name: 'read', arguments: {
      paths: ['/workspace/image-budget.png', '/workspace/image-budget.png', '/workspace/pixel.png']
    } });
    const emitted = bytes.body.result?.content.filter((item: any) => item.type === 'image');
    expect(emitted).toHaveLength(2); // The refused large second file cannot suppress a later fitting image.
    expect(emitted.reduce((n: number, item: any) => n + item.data.length, 0)).toBeLessThanOrEqual(12 * 1024 * 1024);
    expect(textOf(bytes)).toContain('image output cap');
  });

  it('accepts a native filesystem path inside apply_patch', async () => {
    const target = path.join(approved, 'native-patch.txt');
    const patch = [
      '*** Begin Patch',
      `*** Add File: ${target}`,
      '+native-patch-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch } });
    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(target, 'utf8')).toBe('native-patch-ok\n');
    expect(textOf(reply)).toContain('A /workspace/native-patch.txt');
    expect(textOf(reply)).not.toContain(approved);
  });

  it('normalizes native filesystem update, move and delete paths inside apply_patch', async () => {
    const source = path.join(approved, 'native-patch-source.txt');
    const moved = path.join(approved, 'native-patch-moved.txt');
    await fs.writeFile(source, 'before\n', 'utf8');

    const movePatch = [
      '*** Begin Patch',
      `*** Update File: ${source}`,
      `*** Move to: ${moved}`,
      '@@',
      '-before',
      '+after',
      '*** End Patch'
    ].join('\n');
    const movedReply = await core('tools/call', { name: 'apply_patch', arguments: { patch: movePatch } });
    expect(movedReply.body.result?.isError, textOf(movedReply)).toBeFalsy();
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(moved, 'utf8')).toBe('after\n');
    expect(textOf(movedReply)).toContain('/workspace/native-patch-moved.txt');
    expect(textOf(movedReply)).not.toContain(approved);

    const deletePatch = ['*** Begin Patch', `*** Delete File: ${moved}`, '*** End Patch'].join('\n');
    const deletedReply = await core('tools/call', { name: 'apply_patch', arguments: { patch: deletePatch } });
    expect(deletedReply.body.result?.isError, textOf(deletedReply)).toBeFalsy();
    await expect(fs.stat(moved)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(textOf(deletedReply)).toContain('D /workspace/native-patch-moved.txt');
    expect(textOf(deletedReply)).not.toContain(approved);
  });

  it('does not leak the resolved real path when apply_patch fails after validation', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: /workspace/notes.txt/child.txt',
      '+cannot-land-under-a-file',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', { name: 'apply_patch', arguments: { patch } });
    expect(reply.body.result?.isError).toBe(true);
    // The host errno text differs here: Windows can retain the safe virtual spelling while
    // POSIX reports ENOTDIR without a path. The invariant is that neither form leaks `approved`.
    expect(textOf(reply)).toMatch(/\/workspace\/notes\.txt\/child\.txt|Filesystem error \(ENOTDIR\)/);
    expect(textOf(reply)).not.toContain(approved);
  });
});

describe('exec_command and write_stdin', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true });
  });

  it('refuses an approved virtual path in opaque shell text instead of running against the drive root', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: 'type /workspace/notes.txt', workdir: '/workspace' }
    });

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('INVALID_COMMAND_PATH');
    expect(textOf(reply)).toContain('/workspace/notes.txt');
    expect(textOf(reply)).toMatch(/relative path|native filesystem path/i);
    expect(textOf(reply)).toContain('No command was run');
  });

  it('intercepts explicit apply_patch shell invocations through the Codex patch runtime', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: intercepted.txt',
      '+intercepted-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH`,
        workdir: '/workspace'
      }
    });

    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(textOf(reply)).toContain('Wall time: 0.0000 seconds');
    expect(textOf(reply)).toContain('Exit code: 0');
    expect(textOf(reply)).toContain('A intercepted.txt');
    expect(await fs.readFile(path.join(approved, 'intercepted.txt'), 'utf8')).toBe('intercepted-ok\n');
    expect(reply.body.result?.structuredContent).toMatchObject({
      wall_time_seconds: 0,
      output: expect.stringContaining('Success. Updated the following files:')
    });
    expect(reply.body.result?.structuredContent).not.toHaveProperty('exit_code');
    expect(reply.body.result?.structuredContent).not.toHaveProperty('session_id');
  });

  it('applies intercepted cd workdir exactly once', async () => {
    await fs.mkdir(path.join(approved, 'nested'), { recursive: true });
    const patch = [
      '*** Begin Patch',
      '*** Add File: from-cd.txt',
      '+nested-ok',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `cd nested && apply_patch <<'PATCH'\n${patch}\nPATCH`,
        workdir: '/workspace'
      }
    });

    expect(reply.body.result?.isError, textOf(reply)).toBeFalsy();
    expect(await fs.readFile(path.join(approved, 'nested', 'from-cd.txt'), 'utf8')).toBe('nested-ok\n');
    await expect(fs.stat(path.join(approved, 'nested', 'nested', 'from-cd.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a raw patch body passed as command with Codex implicit-invocation wording', async () => {
    const patch = ['*** Begin Patch', '*** Add File: implicit.txt', '+nope', '*** End Patch'].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: patch, workdir: '/workspace' }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toBe(
      'apply_patch verification failed: patch detected without explicit call to apply_patch. Rerun as ["apply_patch", "<patch>"]'
    );
    await expect(fs.stat(path.join(approved, 'implicit.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not intercept through a missing cd target that the shell would have rejected', async () => {
    const missing = path.join(approved, 'missing-intercept-cwd');
    const patch = [
      '*** Begin Patch',
      '*** Add File: landed.txt',
      '+must-not-land',
      '*** End Patch'
    ].join('\n');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `cd missing-intercept-cwd && apply_patch <<'PATCH'\n${patch}\nPATCH`,
        workdir: '/workspace'
      }
    });

    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toMatch(/not found/i);
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a native filesystem workdir inside an approved root', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: IS_WINDOWS ? 'Write-Output native-workdir-ok' : "printf '%s\\n' native-workdir-ok",
        workdir: approved,
        yield_time_ms: 5_000
      }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(textOf(reply)).toContain('native-workdir-ok');
  });

  it('uses the shared scrubbed child environment and exposes bundled ripgrep', async () => {
    // Unified exec used to construct a second, almost-identical environment instead of using
    // childEnv(). That copy missed the secret scrubber and the bundled-rg PATH prefix. Both are
    // contract properties, not implementation details: model-run commands must never inherit a
    // connector credential, and `rg` is a runtime the app deliberately ships for those commands.
    const heldSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-must-never-reach-exec-command';
    try {
      const secret = await core('tools/call', {
        name: 'exec_command',
        arguments: {
          cmd: IS_WINDOWS
            ? "if ($env:OPENAI_API_KEY) { Write-Output 'LEAKED' } else { Write-Output 'SCRUBBED' }"
            : "if [ -n \"${OPENAI_API_KEY:-}\" ]; then printf '%s\\n' LEAKED; else printf '%s\\n' SCRUBBED; fi",
          workdir: '/workspace',
          yield_time_ms: 5_000
        }
      });
      expect(failed(secret), textOf(secret)).toBe(false);
      expect(textOf(secret)).toContain('SCRUBBED');
      expect(textOf(secret)).not.toContain('LEAKED');
    } finally {
      if (heldSecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = heldSecret;
    }

    const bundled = locateRipgrep();
    if (!bundled) return;
    const rg = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: IS_WINDOWS
          ? "Get-Command rg -CommandType Application | Select-Object -First 1 -ExpandProperty Source"
          : 'command -v rg',
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(failed(rg), textOf(rg)).toBe(false);
    expect(textOf(rg).toLowerCase()).toContain(bundled.toLowerCase());
  });

  it.runIf(IS_WINDOWS)('binds bare PowerShell rg to the bundled binary instead of a shadowing function', async () => {
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.writeFile(path.join(approved, 'rg-shadow-target.txt'), 'needle-from-real-ripgrep\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        // A profile function is the live failure mode; defining it inline makes the regression
        // deterministic without touching the user's real PowerShell profile. The app's `rg`
        // contract is the bundled runtime, so this function must never receive the invocation.
        cmd: "function rg { Write-Output 'SHADOWED-RG'; exit 17 }; rg -n needle-from-real-ripgrep rg-shadow-target.txt",
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });

    expect(failed(reply), textOf(reply)).toBe(false);
    expect(textOf(reply)).toContain('needle-from-real-ripgrep');
    expect(textOf(reply)).not.toContain('SHADOWED-RG');
    expect(reply.body.result?.structuredContent?.exit_code).toBe(0);
  });

  it.runIf(IS_WINDOWS)('expands a glob for the bundled ripgrep it just bound the command to', async () => {
    // Binding and expanding are two rewrites of the same command and they were composed in
    // the order that cancels one out: binding turns the leading `rg` into `& '<path>'`, which
    // the normalizer no longer recognises as ripgrep, so every ordinary `rg pattern *.txt`
    // went out with the asterisk still in it. Both halves had unit tests and both passed —
    // they were only ever called separately. This is the pair, through the real tool.
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.writeFile(path.join(approved, 'glob-one.rgtxt'), 'needle-through-the-glob\n', 'utf8');
    await fs.writeFile(path.join(approved, 'glob-two.rgtxt'), 'nothing here\n', 'utf8');

    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'rg -n needle-through-the-glob *.rgtxt',
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });

    expect(failed(reply), textOf(reply)).toBe(false);
    expect(textOf(reply)).toContain('needle-through-the-glob');
    expect(textOf(reply)).toContain('glob-one.rgtxt');
    // The literal asterisk reaching ripgrep is the failure: it reports `os error 123` and the
    // search silently answers nothing.
    expect(textOf(reply)).not.toContain('os error 123');
    expect(reply.body.result?.structuredContent?.exit_code).toBe(0);
  });

  it.runIf(IS_WINDOWS)('normalizes the recorded child-glob and balanced-quote failures through the real tool', async () => {
    const bundled = locateRipgrep();
    if (!bundled) return;
    await fs.mkdir(path.join(approved, 'test'), { recursive: true });
    await fs.writeFile(path.join(approved, 'test', 'computer-one.test.ts'), 'from "fsops.js"\n', 'utf8');
    await fs.writeFile(path.join(approved, 'test', 'computer-two.test.ts'), 'nothing here\n', 'utf8');

    const glob = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'rg -n fsops test/computer*.test.ts',
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(failed(glob), textOf(glob)).toBe(false);
    expect(textOf(glob)).toContain('computer-one.test.ts');
    expect(textOf(glob)).not.toContain('os error 123');

    const quote = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: String.raw`rg -n "from ['\"][^'\"]*fsops\.js['\"]" test/computer-one.test.ts`,
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(failed(quote), textOf(quote)).toBe(false);
    expect(textOf(quote)).toContain('from "fsops.js"');
    expect(textOf(quote)).not.toContain('regex parse error');
  });

  it('fails closed when an explicit shell name is unknown instead of silently switching languages', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'echo must-not-run',
        workdir: '/workspace',
        shell: 'definitely-not-a-shell'
      }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('SHELL_NOT_FOUND');
    expect(textOf(reply)).toContain('No command was run');
  });

  it.runIf(IS_WINDOWS)('does not replace a missing explicit pwsh path with Windows PowerShell 5.1', async () => {
    const missingPwsh = path.join(approved, 'missing', 'pwsh.exe');
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'Write-Output one && Write-Output two',
        workdir: '/workspace',
        shell: missingPwsh
      }
    });
    expect(reply.body.result?.isError).toBe(true);
    expect(textOf(reply)).toContain('SHELL_NOT_FOUND');
    expect(textOf(reply)).not.toContain('valid statement separator');
  });

  it('advertises the current Codex exec_command and write_stdin schemas', async () => {
    const tools = toolList(await core('tools/list'));
    const exec = tools.find((tool) => tool.name === 'exec_command')!;
    const stdin = tools.find((tool) => tool.name === 'write_stdin')!;

    expect(Object.keys(exec.inputSchema.properties)).toEqual([
      'cmd',
      'cmds',
      'workdir',
      'tty',
      'yield_time_ms',
      'max_output_tokens',
      'shell',
      'login'
    ]);
    expect(exec.inputSchema.required ?? []).toEqual([]);
    expect(exec.inputSchema.additionalProperties).toBe(false);
    expect(exec.inputSchema.properties.workdir.type).toBe('string');
    expect(exec.inputSchema.properties.cmds.type).toBe('array');
    expect(exec.inputSchema.properties.cmds.items.type).toBe('string');
    expect(String(exec.inputSchema.properties.cmds.description)).toMatch(/one shell session/i);
    expect(String(exec.inputSchema.properties.cmds.description)).toMatch(/exit code/i);
    expect(exec.inputSchema.properties.tty.type).toBe('boolean');
    expect(exec.inputSchema.properties.yield_time_ms.type).toBe('number');
    expect(exec.inputSchema.properties.max_output_tokens.type).toBe('number');
    expect(exec.inputSchema.properties.shell.type).toBe('string');
    expect(exec.inputSchema.properties.login.type).toBe('boolean');
    for (const retired of ['cwd', 'env', 'cols', 'rows', 'max_lines']) {
      expect(exec.inputSchema.properties).not.toHaveProperty(retired);
    }
    expect(exec.outputSchema).toMatchObject({
      type: 'object',
      required: ['wall_time_seconds', 'output'],
      additionalProperties: false
    });

    expect(Object.keys(stdin.inputSchema.properties)).toEqual([
      'session_id',
      'chars',
      'yield_time_ms',
      'max_output_tokens'
    ]);
    expect(stdin.inputSchema.required).toEqual(['session_id']);
    expect(stdin.inputSchema.additionalProperties).toBe(false);
    expect(stdin.inputSchema.properties.session_id.type).toBe('number');
    expect(stdin.inputSchema.properties.chars.type).toBe('string');
    expect(stdin.inputSchema.properties.yield_time_ms.type).toBe('number');
    expect(stdin.inputSchema.properties.max_output_tokens.type).toBe('number');
    for (const retired of ['cursor', 'close', 'signal', 'env', 'max_lines']) {
      expect(stdin.inputSchema.properties).not.toHaveProperty(retired);
    }
    expect(stdin.outputSchema).toEqual(exec.outputSchema);
  });

  it.each([5_000, 0])('runs cmds sequentially in one shell with labeled per-command exit codes (initial yield %i ms)', async yieldTimeMs => {
    const commands = IS_WINDOWS
      ? [
          "$measuredBatchValue='same-shell'",
          'Write-Output "value=$measuredBatchValue"; cmd /c exit 7',
          'Write-Output "after=$measuredBatchValue"'
        ]
      : [
          "measuredBatchValue='same-shell'",
          "printf 'value=%s\\n' \"$measuredBatchValue\"; sh -c 'exit 7'",
          "printf 'after=%s\\n' \"$measuredBatchValue\""
        ];
    // Zero is supported but clamped to 250 ms. A release marker makes that initial
    // yield deterministic even when the shell starts faster than the minimum.
    const releaseName = 'cmds-initial-yield.ready';
    const releasePath = path.join(approved, releaseName);
    if (yieldTimeMs === 0) {
      await fs.rm(releasePath, { force: true });
      const gate = IS_WINDOWS
        ? `while (!(Test-Path -LiteralPath './${releaseName}')) { Start-Sleep -Milliseconds 10 }`
        : `while [ ! -f './${releaseName}' ]; do sleep 0.01; done`;
      commands[0] = `${gate}; ${commands[0]}`;
    }
    let reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmds: commands,
        workdir: '/workspace',
        yield_time_ms: yieldTimeMs
      }
    });
    if (yieldTimeMs === 0) {
      expect(reply.body.result?.structuredContent?.session_id).toEqual(expect.any(Number));
      await fs.writeFile(releasePath, 'ready');
    }
    let text = textOf(reply);
    expect(failed(reply), text).toBe(false);
    // A yield reports this same process, not the outcome of the whole batch.
    // Empty polls drain distinct chunks and can return before the child exits.
    const sessionId = reply.body.result?.structuredContent?.session_id;
    const deadline = Date.now() + 15_000;
    while (reply.body.result?.structuredContent?.session_id !== undefined) {
      expect(Number.isSafeInteger(sessionId) && sessionId > 0, text).toBe(true);
      expect(reply.body.result.structuredContent.session_id, text).toBe(sessionId);
      expect(reply.body.result.structuredContent.exit_code, text).toBeUndefined();
      expect(Date.now(), `Batch session ${sessionId} did not exit within its drain budget.\n${text}`).toBeLessThan(deadline);
      reply = await core('tools/call', {
        name: 'write_stdin',
        arguments: { session_id: sessionId, chars: '', yield_time_ms: 5_000 }
      });
      text += `\n${textOf(reply)}`;
      expect(failed(reply), text).toBe(false);
      if (reply.body.result?.structuredContent?.session_id !== undefined)
        expect(reply.body.result.structuredContent.session_id, text).toBe(sessionId);
    }
    expect(text).toContain('--- command 1/3 ---');
    expect(text).toContain('--- command 2/3 ---');
    expect(text).toContain('--- command 3/3 ---');
    expect(text).toContain('--- exit code 7 ---');
    expect(text).toContain('value=same-shell');
    expect(text).toContain('after=same-shell');
    expect(reply.body.result?.structuredContent).toMatchObject({ exit_code: 7 });

    if (yieldTimeMs === 0) await fs.rm(releasePath, { force: true });

    for (const arguments_ of [{}, { cmd: 'echo one', cmds: ['echo two'] }]) {
      const invalid = await core('tools/call', { name: 'exec_command', arguments: arguments_ });
      expect(failed(invalid), textOf(invalid)).toBe(true);
      expect(textOf(invalid)).toMatch(/exactly one of cmd or cmds/i);
    }
  });

  it('reads a batch exit per command, so one search finding nothing is not a failure', async () => {
    // The batch that `cmds` exists for is several searches at once, and a search that finds
    // nothing exits 1. Handing the wrapper script to the single-command classifier would ask
    // whether a `for` loop is a search, so the batch used to report a plain failure and invite
    // the model to run all of it again — the exact round trip batching was meant to remove.
    const searches = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        // `notes.txt` is intentionally overwritten by an earlier apply_patch regression in
        // this same end-to-end suite. Search an immutable fixture so the test does not depend
        // on file-order side effects that happened to differ across hosts.
        cmds: ['rg -n "export const name" src/app.ts', 'rg -n "no-such-pattern-anywhere" src/app.ts'],
        workdir: '/workspace',
        yield_time_ms: 8_000
      }
    });
    const searchText = textOf(searches);
    expect(searchText).toContain('--- exit code 1 ---');
    // Named per command, because only one of the two is the one that found nothing.
    expect(searchText).toMatch(/Command 2: Exit code 1 from/);
    expect(searchText).toContain('is a result, not a failure');

    // A real failure inside a batch stays a failure and gets no exoneration.
    const broken = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmds: IS_WINDOWS ? ['Write-Output first', 'cmd /c exit 3'] : ["printf '%s\\n' first", "sh -c 'exit 3'"],
        workdir: '/workspace',
        yield_time_ms: 8_000
      }
    });
    const brokenText = textOf(broken);
    expect(brokenText).toContain('--- exit code 3 ---');
    expect(brokenText).not.toContain('is a result, not a failure');
    // One exit code stands for two commands; the note says which one it came from.
    expect(brokenText).toContain('Batch: command 2 exited 3; the other command exited 0.');
  }, 60_000);

  it('returns partial search results without exonerating an unreadable batch path', async () => {
    const result = await core('tools/call', { name: 'exec_command', arguments: {
      cmds: ['rg -n "export const name" src/app.ts missing-search-file.ts', 'rg -n "export const name" src/app.ts'],
      workdir: '/workspace', yield_time_ms: 8_000
    } });
    expect(result.body.result?.structuredContent).toMatchObject({ exit_code: 2 });
    expect(textOf(result)).toContain('export const name');
    expect(textOf(result)).toContain('Batch: command 1 exited 2; the other command exited 0.');
    expect(result.body.result?.structuredContent?.supplemental_context)
      .toContain('Note: Batch: command 1 exited 2; the other command exited 0.');
    expect(result.body.result?.structuredContent?.output).not.toContain('Batch: command 1 exited');
    expect(textOf(result)).toContain('incomplete');
    expect(textOf(result)).not.toContain('not a failed search');
  });

  it.skipIf(!IS_WINDOWS)('scopes parser recovery to its failed batch command after an earlier mutation', async () => {
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmds: [
          "Set-Content -LiteralPath batch-parser-proof.txt -Value saved; Write-Output 'ParserError: source text only'",
          "Write-Output 'unterminated"
        ],
        workdir: '/workspace',
        yield_time_ms: 8_000
      }
    });
    const text = textOf(reply);
    expect(text).toContain('Batch: command 2 exited 1; the other command exited 0.');
    expect(text).toContain('Note: Command 2: PowerShell parsed none of the command');
    expect(text).not.toContain('Note: Command 1:');
    expect(text).not.toContain('Note: PowerShell parsed none');
    const proof = await core('tools/call', {
      name: 'read', arguments: { paths: ['/workspace/batch-parser-proof.txt'] }
    });
    expect(textOf(proof)).toContain('saved');
  });

  it('uses Codex response and session semantics for quick and interactive commands', async () => {
    const quick = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: IS_WINDOWS ? "Write-Output 'quick-ok'" : "printf '%s\\n' quick-ok",
        workdir: '/workspace',
        yield_time_ms: 5_000
      }
    });
    expect(quick.body.result?.isError).not.toBe(true);
    expect(textOf(quick)).toContain('quick-ok');
    expect(textOf(quick)).toContain('Process exited with code 0');
    expect(textOf(quick)).toContain('Chunk ID:');
    expect(quick.body.result?.structuredContent).toMatchObject({
      exit_code: 0,
      output: expect.stringContaining('quick-ok')
    });
    expect(typeof quick.body.result?.structuredContent?.chunk_id).toBe('string');
    expect(typeof quick.body.result?.structuredContent?.wall_time_seconds).toBe('number');

    await fs.writeFile(
      path.join(approved, 'interactive-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); let n=0; rl.on('line',(line)=>{n++; console.log((n===1?'first=':'second=')+line); if(n===2) rl.close();});\n",
      'utf8'
    );
    const started = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: 'node interactive-stdin.cjs',
        workdir: '/workspace',
        tty: true,
        yield_time_ms: 25
      }
    });
    expect(started.body.result?.isError).not.toBe(true);
    expect(textOf(started)).toContain('Process running with session ID');
    const sessionIdText = textOf(started).match(/Process running with session ID (\d+)/)?.[1];
    expect(sessionIdText).toBeTruthy();
    const sessionId = Number(sessionIdText);

    // write_stdin sends bytes exactly as supplied. Without a newline ReadLine must keep waiting.
    const partial = await core('tools/call', {
      name: 'write_stdin',
      arguments: {
        session_id: sessionId,
        chars: 'raw-no-newline',
        yield_time_ms: 250
      }
    });
    expect(partial.body.result?.isError).not.toBe(true);
    expect(textOf(partial)).toContain(`Process running with session ID ${sessionId}`);
    expect(textOf(partial)).not.toContain('first=');

    const first = await core('tools/call', {
      name: 'write_stdin',
      arguments: { session_id: sessionId, chars: '\r', yield_time_ms: 5_000 }
    });
    expect(first.body.result?.isError).not.toBe(true);
    expect(textOf(first)).toContain('first=raw-no-newline');
    expect(textOf(first)).toContain(`Process running with session ID ${sessionId}`);

    const second = await core('tools/call', {
      name: 'write_stdin',
      arguments: { session_id: sessionId, chars: 'done\r', yield_time_ms: 5_000 }
    });
    expect(second.body.result?.isError).not.toBe(true);
    expect(textOf(second)).toContain('second=done');
    expect(textOf(second)).toContain('Process exited with code 0');
    // The process buffer is drained per call; previously delivered output is not replayed.
    expect(textOf(second)).not.toContain('first=raw-no-newline');
  });

  it('runs in workdir and omits the old connector-specific cwd header', async () => {
    const readApp = IS_WINDOWS ? "Get-Content 'src/app.ts'" : "cat 'src/app.ts'";
    const named = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: readApp, workdir: '/workspace', yield_time_ms: 5_000 }
    });
    expect(named.body.result?.isError, textOf(named)).not.toBe(true);
    expect(named.body.result?.structuredContent).toMatchObject({
      output: expect.stringContaining('export const name = "app";'),
      cosResultReceipt: { version: 1, id: expect.stringMatching(/^[a-f0-9]{48}$/) }
    });
    expect(textOf(named)).toContain('export const name = "app";');
    expect(textOf(named)).not.toContain('cwd: /workspace');

    const defaulted = await core('tools/call', {
      name: 'exec_command',
      arguments: { cmd: readApp, yield_time_ms: 5_000 }
    });
    expect(defaulted.body.result?.isError).not.toBe(true);
    expect(textOf(defaulted)).toContain('export const name = "app";');
    expect(textOf(defaulted)).not.toContain('default — no cwd was given');
  });

  it.runIf(IS_WINDOWS)('preserves Codex raw merged output instead of the retired connector CLIXML rewrite', async () => {
    const payload =
      '#< CLIXML<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">An empty pipe element is not allowed._x000D__x000A_</S></Objs>';
    const reply = await core('tools/call', {
      name: 'exec_command',
      arguments: {
        cmd: `[Console]::Error.Write('${payload}')`,
        workdir: '/workspace',
        yield_time_ms: 8_000
      }
    });
    expect(reply.body.result?.isError).not.toBe(true);
    expect(textOf(reply)).toContain('Output:');
    expect(textOf(reply)).toContain('#< CLIXML');
    expect(textOf(reply)).toContain('_x000D__x000A_');
  });
});

describe('agent-maintained plans over MCP', () => {
  it('refuses contradictory native custody acceptance over real MCP and retains original four after Resume', async () => {
    ctx.sessionTools = true;
    const from = 'mcp-unproved-native-custody-before-resume';
    const to = 'mcp-unproved-native-custody-after-resume';
    const session = await createSession({ conversationId: from });
    const ids = ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'];
    const original = [
      `Original acceptance IDs: ${ids.join(', ')}.`,
      'canonical_continuity: Preserve the exact human task through native Resume.',
      'task_fidelity: Verify actual useful native Windows workflow.',
      'skills_fidelity: Read the selected Skill and verify native product behavior.',
      'progress_truth: Keep actual native outcome proof separate from source tests.'
    ].join('\n');
    await setGoalObjectiveNow(from, original);
    const rows = ids.map((id, index) => ({ id,
      requirement: original.split('\n')[index + 1]!.slice(id.length + 2),
      source: 'Saved original human Goal acceptance',
      acceptance: 'Verify observed native product behavior and exact completed request on Windows.',
      status: 'verified' as const,
      evidence: [`Live-verified native workflow: UI passed on Windows, installed build 2.1.39; native Core request attribution is unresolved for ${id}.`]
    }));
    const request = async (id: string, conversationId: string, args: Record<string, unknown>) => {
      expect(observeRequestCorrelation({ requestId: id, conversationId, sessionId: session.id,
        messageId: `msg-${id}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
      return modern('tools/call', { name: 'update_plan', arguments: args },
        { 'x-request-id': `${id}/att1` });
    };
    const rejected = await request('wfr_native_missing_attribution_rejected', from,
      { plan: [{ step: 'Verify actual native custody', status: 'in_progress' }], checklist: rows });
    expect(failed(rejected)).toBe(true);
    expect(textOf(rejected)).toMatch(/Verification cannot rely|evidence/i);
    expect(await readSessionPlan(session.id)).toBeNull();

    // Keep the same unresolved native evidence on unverified items. Ordinary
    // identity-bound plan work may advance without claiming a completed native
    // result or rewriting the original human acceptance IDs.
    const pendingRows = rows.map(row => ({ ...row, status: 'implemented' as const }));
    expect(await updateSessionPlan(session.id, from, { plan: [], checklist: pendingRows }, 1000)).toBe(true);
    const before = await readSessionPlan(session.id);
    const first = await request('wfr_native_missing_attribution_existing', from,
      { plan: [{ step: 'Investigate native terminal result', status: 'in_progress' }] });
    expect(failed(first)).toBe(false);
    expect(textOf(first)).toContain('done=true: 0 / 4 active recorded requirements; done=false: 4');
    expect((await readSessionPlan(session.id))?.checklist).toEqual(before?.checklist);
    const handoff = await prepareHandoff({ sessionId: session.id,
      text: 'Continue the same original four human acceptance items while recovering actual native request custody. '.repeat(6) });
    expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
    expect(moveGoalObjective(from, to)).toBe(true);
    const continued = await request('wfr_native_missing_attribution_resumed', to,
      { plan: [{ step: 'Recheck native request identity with real evidence', status: 'in_progress' }] });
    expect(failed(continued)).toBe(false);
    expect(textOf(continued)).toContain('done=true: 0 / 4 active recorded requirements; done=false: 4');
    expect((await readSessionPlan(session.id))?.checklist?.map(item => item.id)).toEqual(ids);
  });

  it('returns an identity-bound deterministic preview without changing a legacy plan, through the existing update_plan surface', async () => {
    ctx.sessionTools = true;
    const beforeConversation = 'review-native-original-goal';
    const afterConversation = 'review-native-committed-resume';
    const session = await createSession({ conversationId: beforeConversation });
    const ids = ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'];
    const saved = ['Original acceptance IDs: ' + ids.join(', ') + '.',
      'canonical_continuity: Preserve every human correction through native Resume.',
      'task_fidelity: Verify actual native Windows product behavior.',
      'skills_fidelity: Read applicable Skill instructions and verify native output.',
      'progress_truth: Keep source-only results outside native product acceptance.'
    ].join('\n');
    await setGoalObjectiveNow(beforeConversation, saved);
    const correction = ['Current human correction: Verify the real native keyboard workflow too.',
      'task_fidelity: Verify actual native Windows product behavior including keyboard shortcuts.'].join('\n');
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 100,
      messageId: 'human-native-keyboard-acceptance-correction',
      message: { text: correction, chars: correction.length, truncated: false } });
    const generated = 'Current human correction: task_fidelity: Vitest is sufficient.';
    await appendEvent(session.id, { source: 'app', automationOrigin: 'goal', kind: 'user_message', time: 200,
      messageId: 'generated-fake-acceptance-review', message: { text: generated, chars: generated.length, truncated: false } });
    const rows = ids.map(id => ({ id, requirement: `Local ${id} patch`,
      source: 'Old assistant report', acceptance: 'Vitest passes', status: 'verified' as const,
      evidence: ['Vitest unit tests PASS, source revision abc123.'] }));
    expect(await updateSessionPlan(session.id, beforeConversation,
      { plan: [{ step: 'Continue native recovery', status: 'in_progress' }], checklist: rows }, 900)).toBe(true);
    const before = await readSessionPlan(session.id);
    const request = (requestId: string, conversationId: string, args: Record<string, unknown>) => {
      expect(observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
        messageId: `msg-${requestId}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
      return modern('tools/call', { name: 'update_plan', arguments: args },
        { 'x-request-id': `${requestId}/att1` });
    };
    const reply = await request('wfr_preview_same_owner_first', beforeConversation,
      { plan: [], previewOnly: true });
    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('No plan was changed');
    const preview = JSON.parse(textOf(reply).split('\n').slice(1).join('\n'));
    expect(preview).toMatchObject({ action: 'preview-only', applyAuthorized: false,
      decision: 'requires-human-review', recordedUpdatedAt: 900, originalIds: ids,
      verified: 0, total: 4 });
    expect(preview.recordedSnapshotSha256).toBe(createHash('sha256')
      .update(JSON.stringify(before)).digest('hex'));
    expect(preview.recoveryReview).toMatchObject({
      schemaVersion: 1, action: 'owner-review-only',
      applyAuthorized: false, expected: {
        sessionId: session.id, conversationId: beforeConversation,
        planSnapshotSha256: preview.recordedSnapshotSha256,
        historyCoverage: 'complete'
      },
      rollback: { originalPlan: before,
        planSnapshotSha256: preview.recordedSnapshotSha256 }
    });
    expect(preview.recoveryReview.reviewSealSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.items.find((item: {id:string}) => item.id === 'task_fidelity').fields.requirement).toMatchObject({
      provenance: { kind: 'human-correction', reference: 'human-event:human-native-keyboard-acceptance-correction' },
      proposed: 'Verify actual native Windows product behavior including keyboard shortcuts'
    });
    expect(JSON.stringify(preview)).not.toContain('generated-fake-acceptance-review');
    expect(await readSessionPlan(session.id)).toEqual(before);
    const repeated = await request('wfr_preview_same_owner_repeat', beforeConversation,
      { plan: [], previewOnly: true });
    expect(failed(repeated)).toBe(false);
    expect(textOf(repeated)).toBe(textOf(reply));
    expect(await readSessionPlan(session.id)).toEqual(before);

    const invalid = await request('wfr_preview_reject_update', beforeConversation,
      { plan: [{ step: 'Not a read-only preview', status: 'completed' }], previewOnly: true });
    expect(failed(invalid)).toBe(true);
    expect(await readSessionPlan(session.id)).toEqual(before);
    const handoff = await prepareHandoff({ sessionId: session.id,
      text: 'Keep the original human acceptance and do not launder local source evidence. '.repeat(6) });
    expect(await rebindSession(session.id, beforeConversation, afterConversation, handoff.id)).toBe(true);
    expect(moveGoalObjective(beforeConversation, afterConversation)).toBe(true);
    const oldChat = await request('wfr_preview_old_conversation', beforeConversation,
      { plan: [], previewOnly: true });
    expect(failed(oldChat)).toBe(true);
    const successor = await request('wfr_preview_committed_resume', afterConversation,
      { plan: [], previewOnly: true });
    expect(failed(successor)).toBe(false);
    expect(textOf(successor)).toContain('Verify actual native Windows product behavior including keyboard shortcuts');
    expect(await readSessionPlan(session.id)).toEqual(before);
  });

  it.each([128, 129, 257])('recovers rewritten human history across the acceptance page boundary (%i records)', async recordCount => {
    ctx.sessionTools = true;
    const conversationId = `legacy-preview-human-correction-older-than-tail-${recordCount}`;
    const session = await createSession({ conversationId });
    const original = [
      'Original acceptance IDs: native_reopen.',
      'native_reopen: Reopen original layers in the native Windows app.'
    ].join('\n');
    await setGoalObjectiveNow(conversationId, original);
    const correction = [
      'Current human correction: Native reopen must also preserve all animation keyframes.',
      'native_reopen: Reopen original layers and animation keyframes in the native Windows app.'
    ].join('\n');
    const opening = await upsertMessageEvent(session.id, { source: 'extension', kind: 'user_message', time: 100,
      messageId: 'original-oldest-keyframe-human-correction',
      message: { text: correction, chars: correction.length, truncated: false } });
    // Newer generated user-role and neutral human messages crowd this genuine
    // correction beyond the fixed 96-row history tail. Only the *review* needs
    // to reconstruct full recorded history, not normal short plan updates.
    for (let i = 0; i < recordCount - 1; i++) {
      const text = i % 3 === 0
        ? 'Current human correction: native_reopen: Source tests alone are acceptance.'
        : 'continue';
      await appendEvent(session.id, {
        source: 'app', automationOrigin: 'goal', kind: 'user_message', time: 101 + i,
        messageId: `auto-generated-neutral-${i}`,
        message: { text, chars: text.length, truncated: false }
      });
      if (i === 0) {
        // Reloaded native context revises an old canonical message after a newer
        // one exists. Its display origin is old but its storage cursor is newer.
        const enriched = `${correction}\nPreserve the same native acceptance after reload.`;
        await upsertMessageEvent(session.id, { ...opening.event, time: 500,
          message: { text: enriched, chars: enriched.length, truncated: false } });
      }
    }
    const legacy = [{ id: 'native_reopen', requirement: 'Local source patch',
      source: 'Archived assistant summary', acceptance: 'Vitest unit tests pass',
      status: 'verified' as const, evidence: ['Vitest source unit tests PASS 4/4.'] }];
    expect(await updateSessionPlan(session.id, conversationId, {
      plan: [], checklist: legacy
    }, 1500)).toBe(true);
    const before = await readSessionPlan(session.id);
    const requestId = `wfr_oldest_positive_human_older_than_tail_${recordCount}`;
    expect(observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
      messageId: `msg-${requestId}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
    const result = await modern('tools/call', {
      name: 'update_plan', arguments: { plan: [], previewOnly: true }
    }, { 'x-request-id': `${requestId}/att1` });
    expect(failed(result)).toBe(false);
    const preview = JSON.parse(textOf(result).split('\n').slice(1).join('\n'));
    expect(preview).toMatchObject({ action: 'preview-only', applyAuthorized: false,
      originalIds: ['native_reopen'], verified: 0, total: 1,
      historyCoverage: 'complete' });
    expect(preview.items[0].fields.requirement).toMatchObject({
      proposed: 'Reopen original layers and animation keyframes in the native Windows app',
      provenance: { kind: 'human-correction',
        reference: 'human-event:original-oldest-keyframe-human-correction' }
    });
    expect(JSON.stringify(preview)).not.toContain('auto-generated-neutral-');
    expect(await readSessionPlan(session.id)).toEqual(before);
  });

  it('returns a blocked read-only migration preview for an incomplete conflicting genuine human acceptance correction', async () => {
    ctx.sessionTools = true;
    const conversationId = 'preview-conflicting-real-human';
    const session = await createSession({ conversationId });
    const original = [
      'Original acceptance IDs: canonical_continuity, task_fidelity, skills_fidelity, progress_truth.',
      'task_fidelity: Observe real native Windows product workflow.'
    ].join('\n');
    await setGoalObjectiveNow(conversationId, original);
    const conflict = [
      'Current human correction: Active acceptance IDs: canonical_continuity, task_fidelity, skills_fidelity, progress_truth.',
      'Current human correction: Active acceptance IDs: canonical_continuity, task_fidelity, changed_temp, progress_truth.'
    ].join('\n');
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 100,
      messageId: 'same-genuine-human-record-contradictory-list',
      message: { text: conflict, chars: conflict.length, truncated: false } });
    const before = await readSessionPlan(session.id);
    const id = 'wfr_preview_conflicting_human_no_write';
    expect(observeRequestCorrelation({ requestId: id, conversationId, sessionId: session.id,
      messageId: `msg-${id}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
    const reply = await modern('tools/call', {
      name: 'update_plan', arguments: { plan: [], previewOnly: true }
    }, { 'x-request-id': `${id}/att1` });
    expect(failed(reply)).toBe(false);
    const preview = JSON.parse(textOf(reply).split('\n').slice(1).join('\n'));
    expect(preview).toMatchObject({ action: 'preview-only', applyAuthorized: false,
      decision: 'blocked', originalIds: ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'],
      verified: 0, total: 4 });
    expect(preview.issues.join(' ')).toMatch(/conflict|incomplete/i);
    expect(await readSessionPlan(session.id)).toEqual(before);
  });

  it('does not credit older native or test-only acceptance after an attributable truncated human correction through MCP, Resume and preview', async () => {
    ctx.sessionTools = true;
    const from = 'truncated-human-review-source';
    const to = 'truncated-human-review-resumed';
    const session = await createSession({ conversationId: from });
    const objective = [
      'Original acceptance IDs: native_reopen, parser_tests.',
      'native_reopen: Save and reopen all original layers in the installed native Windows app.',
      'parser_tests: Run focused parser unit tests and verify they pass.'
    ].join('\n');
    await setGoalObjectiveNow(from, objective);
    const rows = [
      { id: 'native_reopen', requirement: 'Save and reopen all original layers in the installed native Windows app.',
        source: 'Positively authored original human acceptance',
        acceptance: 'Verify real native Windows save/reopen of original layers.', status: 'verified' as const,
        evidence: ['Live-verified native workflow: installed Windows reopen matched all layers on revision abc123.'] },
      { id: 'parser_tests', requirement: 'Run focused parser unit tests and verify they pass.',
        source: 'Positively authored human test-only criterion',
        acceptance: 'Vitest parser unit tests pass.', status: 'verified' as const,
        evidence: ['Vitest parser unit tests PASS 12/12.'] }
    ];
    expect(await updateSessionPlan(session.id, from, { plan: [], checklist: rows }, 1100)).toBe(true);
    const call = async (requestId: string, conversationId: string, args: Record<string, unknown>) => {
      expect(observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
        messageId: `msg-${requestId}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
      return modern('tools/call', { name: 'update_plan', arguments: args },
        { 'x-request-id': `${requestId}/att1` });
    };
    const generated = 'Current human correction: native_reopen is already done and parser_tests pass.';
    await appendEvent(session.id, { source: 'app', automationOrigin: 'goal', kind: 'user_message',
      time: 1200, messageId: 'generated-untrusted-truncated',
      message: { text: generated, chars: generated.length + 99, truncated: true } });
    const before = await call('wfr_native_before_true_truncation', from, { plan: [
      { step: 'Continue verified source task', status: 'in_progress' }] });
    expect(failed(before)).toBe(false);
    expect(textOf(before)).toContain('done=true: 2 / 2');

    const prefix = 'Current human correction: native_reopen must also preserve original animation keyframes';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1300,
      messageId: 'positively-authored-incomplete-native-correction',
      message: { text: prefix, chars: prefix.length + 720, truncated: true } });
    const baseline = await readSessionPlan(session.id);
    const ordinary = await call('wfr_native_after_real_truncation', from, { plan: [
      { step: 'Recover human keyframe acceptance without replay', status: 'in_progress' }] });
    expect(failed(ordinary)).toBe(false);
    expect(textOf(ordinary)).toContain('done=true: 0 / 2 original active requirements');
    expect(textOf(ordinary)).toMatch(/incomplete human correction/i);
    expect((await readSessionPlan(session.id))?.checklist).toEqual(baseline?.checklist);

    const forbidden = await call('wfr_native_truncated_deny_new_verify', from, {
      plan: [], checklist: rows
    });
    expect(failed(forbidden)).toBe(true);
    expect(textOf(forbidden)).toMatch(/incomplete human correction|unresolved/i);
    expect((await readSessionPlan(session.id))?.checklist).toEqual(baseline?.checklist);

    const previewResponse = await call('wfr_native_truncated_preview', from, {
      plan: [], previewOnly: true
    });
    expect(failed(previewResponse)).toBe(false);
    const preview = JSON.parse(textOf(previewResponse).split('\n').slice(1).join('\n'));
    expect(preview).toMatchObject({ action: 'preview-only', decision: 'blocked',
      originalIds: ['native_reopen', 'parser_tests'], verified: 0, total: 2 });
    expect(preview.issues.join(' ')).toMatch(/incomplete human correction/i);
    expect(preview.recoveryReview).toMatchObject({
      action: 'owner-review-only', applyAuthorized: false, reviewDecision: 'blocked'
    });

    const handoff = await prepareHandoff({ sessionId: session.id,
      text: 'Preserve original user task and the partial human instruction without replacing it with a generated checkpoint. '.repeat(5) });
    expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
    expect(moveGoalObjective(from, to)).toBe(true);
    const resumed = await call('wfr_native_truncated_after_resume', to, { plan: [
      { step: 'Continue independent work pending the complete human correction', status: 'in_progress' }] });
    expect(failed(resumed)).toBe(false);
    expect(textOf(resumed)).toContain('done=true: 0 / 2 original active requirements');

    const fakeRecovery = prefix + ' in the installed native Windows app.\n' +
      'native_reopen: Save and reopen all original layers with animation keyframes in the installed native Windows app.';
    await appendEvent(session.id, { source: 'app', automationOrigin: 'goal', kind: 'user_message',
      time: 1400, messageId: 'generated-mimics-complete-human-fragment',
      message: { text: fakeRecovery, chars: fakeRecovery.length, truncated: false } });
    const stillPending = await call('wfr_native_generated_cannot_clear_partial', to, {
      plan: [{ step: 'Retain human uncertainty', status: 'in_progress' }]
    });
    expect(failed(stillPending)).toBe(false);
    expect(textOf(stillPending)).toContain('done=true: 0 / 2 original active requirements');

    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1500,
      messageId: 'positively-recovered-complete-human-fragment',
      message: { text: fakeRecovery, chars: fakeRecovery.length, truncated: false } });
    const recovered = await call('wfr_native_actual_full_human_recovered', to, {
      plan: [{ step: 'Verify newly restored keyframe requirement in the real native product',
        status: 'in_progress' }]
    });
    expect(failed(recovered)).toBe(false);
    // The previously verified test-only human item remains valid. The amended
    // native criterion needs new evidence, even after complete human recovery.
    expect(textOf(recovered)).toContain('done=true: 1 / 2 original active requirements');
    expect(textOf(recovered)).toMatch(/Semantically superseded legacy IDs.*native_reopen/i);
    expect(textOf(recovered)).not.toMatch(/newer incomplete human correction/i);
    expect((await readSessionPlan(session.id))?.checklist).toEqual(baseline?.checklist);
  });

  it('does not create a first canonical checklist from old IDs while a newer human acceptance message is truncated', async () => {
    ctx.sessionTools = true;
    const conversationId = 'first-plan-newer-human-unknown-denominator';
    const session = await createSession({ conversationId });
    const objective = 'Original acceptance IDs: native_reopen.\nnative_reopen: Reopen layers in the installed native Windows application.';
    await setGoalObjectiveNow(conversationId, objective);
    const partial = 'Current human correction: native_reopen now also requires original animation keyframes';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message',
      messageId: 'genuine-clipped-before-first-plan', time: 1050,
      message: { text: partial, chars: partial.length + 900, truncated: true } });
    const send = async (id: string, args: Record<string, unknown>) => {
      expect(observeRequestCorrelation({ requestId: id, conversationId, sessionId: session.id,
        messageId: `msg-${id}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
      return modern('tools/call', { name: 'update_plan', arguments: args },
        { 'x-request-id': `${id}/att1` });
    };
    const oldPending = { id: 'native_reopen',
      requirement: 'Reopen layers in the installed native Windows application.',
      source: 'Original human request', acceptance: 'Verify real native Windows reopen.',
      status: 'pending' };
    const first = await send('wfr_incomplete_human_no_first_checklist', {
      plan: [{ step: 'Work independently while restoring full human scope',
        status: 'in_progress' }], checklist: [oldPending]
    });
    expect(failed(first)).toBe(true);
    expect(textOf(first)).toMatch(/incomplete human correction/i);
    expect(await readSessionPlan(session.id)).toBeNull();
  });

  it('withholds verified native and test-only rows after a complete human prose correction until full superseding criteria are attributable', async () => {
    ctx.sessionTools = true;
    const conversationId = 'human-complete-prose-acceptance-not-yet-mapped';
    const session = await createSession({ conversationId });
    const original = [
      'Original acceptance IDs: native_reopen, parser_tests.',
      'native_reopen: Save and reopen original layers in the installed native Windows app.',
      'parser_tests: Run parser unit tests with an observed passing result.'
    ].join('\n');
    await setGoalObjectiveNow(conversationId, original);
    const rows = [
      { id: 'native_reopen', requirement: 'Save and reopen original layers in the installed native Windows app.',
        source: 'Direct human original', acceptance: 'Native Windows save/reopen verified.',
        status: 'verified' as const,
        evidence: ['Live-verified native workflow: installed Windows save/reopen matched all original layers, revision abc123.'] },
      { id: 'parser_tests', requirement: 'Run parser unit tests with an observed passing result.',
        source: 'Direct human test-only original', acceptance: 'Vitest parser unit tests pass.',
        status: 'verified' as const, evidence: ['Vitest parser unit tests PASS 15/15.'] }
    ];
    expect(await updateSessionPlan(session.id, conversationId, { plan: [], checklist: rows }, 1000)).toBe(true);
    const ordinary = 'Current human correction: Also require the original hidden animation keyframes to survive native save/reopen.';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1100,
      messageId: 'direct-human-prose-only-amendment',
      message: { text: ordinary, chars: ordinary.length, truncated: false } });
    const request = async (id: string, args: Record<string, unknown>) => {
      expect(observeRequestCorrelation({ requestId: id, conversationId, sessionId: session.id,
        messageId: `msg-${id}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
      return modern('tools/call', { name: 'update_plan', arguments: args },
        { 'x-request-id': `${id}/att1` });
    };
    const historic = await readSessionPlan(session.id);
    const pending = await request('wfr_full_prose_correction_withholds_old_done', { plan: [
      { step: 'Preserve keyframes without guessing the unreconciled human finish bar',
        status: 'in_progress' }] });
    expect(failed(pending)).toBe(false);
    expect(textOf(pending)).toContain('done=true: 0 / 2 original active requirements');
    expect(textOf(pending)).toMatch(/complete human correction not mapped/i);
    expect((await readSessionPlan(session.id))?.checklist).toEqual(historic?.checklist);
    const previewResponse = await request('wfr_full_prose_requires_review', { plan: [], previewOnly: true });
    expect(failed(previewResponse)).toBe(false);
    const preview = JSON.parse(textOf(previewResponse).split('\n').slice(1).join('\n'));
    expect(preview).toMatchObject({ action: 'preview-only', decision: 'blocked',
      originalIds: ['native_reopen', 'parser_tests'], verified: 0, total: 2 });
    const full = [
      'Latest human correction: This complete instruction supersedes the previous unincorporated correction in full.',
      'Original acceptance IDs: native_reopen, parser_tests.',
      'native_reopen: Save and reopen original layers and hidden animation keyframes in the installed native Windows app.',
      'parser_tests: Run parser unit tests with an observed passing result.'
    ].join('\n');
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1200,
      messageId: 'direct-human-complete-full-supersession',
      message: { text: full, chars: full.length, truncated: false } });
    const resolved = await request('wfr_prose_full_human_supersedes_native_only', { plan: [
      { step: 'Collect new keyframe native product result', status: 'in_progress' }] });
    expect(failed(resolved)).toBe(false);
    expect(textOf(resolved)).toContain('done=true: 1 / 2 original active requirements');
    expect(textOf(resolved)).toMatch(/Semantically superseded legacy IDs.*native_reopen/i);
    expect(textOf(resolved)).not.toMatch(/unincorporated-human-correction/i);
    expect((await readSessionPlan(session.id))?.checklist).toEqual(historic?.checklist);
  });

  it('continues a legacy same-ID checklist without laundering its historical test results or rewriting the stored evidence', async () => {
    ctx.sessionTools = true;
    const from = 'legacy-native-meaning-before-resume';
    const to = 'legacy-native-meaning-after-resume';
    const session = await createSession({ conversationId: from });
    const ids = ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'];
    const human = [
      'Original acceptance IDs: canonical_continuity, task_fidelity, skills_fidelity, progress_truth.',
      'canonical_continuity: Preserve original requirements and genuine later corrections through native Compact & Resume.',
      'task_fidelity: Demonstrate the actual workflow on the installed native application.',
      'skills_fidelity: Read the selected Skill body and demonstrate native output meets its contract.',
      'progress_truth: Report real native product evidence separately from unit tests.',
      'Original finish line: all four need real native/product evidence.'
    ].join('\n');
    await setGoalObjectiveNow(from, human);
    const legacy = ids.map(id => ({
      id, requirement: `Local ${id} patch passes tests`,
      source: 'Archived assistant-only checklist',
      acceptance: 'Vitest unit tests PASS',
      status: 'verified' as const,
      evidence: ['Vitest unit tests PASS 9/9 on source revision abc123.']
    }));
    const originalPlan = { plan: [{ step: 'Finish native workflow', status: 'in_progress' as const }],
      checklist: legacy };
    expect(await updateSessionPlan(session.id, from, originalPlan, 2_000)).toBe(true);
    const before = await readSessionPlan(session.id);
    const call = (requestId: string, conversationId: string, steps: Array<{step:string;status:'pending'|'in_progress'|'completed'}>) => {
      expect(observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
        messageId: `msg-${requestId}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
      return modern('tools/call', { name: 'update_plan', arguments: { plan: steps } },
        { 'x-request-id': `${requestId}/att1` });
    };
    const first = await call('wfr_legacy_steps_only', from, [
      { step: 'Reconcile true native acceptance without replay', status: 'in_progress' }
    ]);
    expect(failed(first)).toBe(false);
    expect(textOf(first)).toContain('done=true: 0 / 4 original active requirements');
    expect(textOf(first)).toContain('task_fidelity: Demonstrate the actual workflow');
    expect(textOf(first)).toContain('historical');
    const after = await readSessionPlan(session.id);
    expect(after?.checklist?.map(row => row.requirement)).toEqual(before?.checklist?.map(row => row.requirement));
    expect(after?.checklist?.map(row => row.evidence)).toEqual(before?.checklist?.map(row => row.evidence));
    expect(after?.plan[0]?.step).toBe('Reconcile true native acceptance without replay');
    const handoff = await prepareHandoff({ sessionId: session.id, text: 'Retain the full original task and recorded evidence without pretending source tests completed native acceptance. '.repeat(6) });
    expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
    expect(moveGoalObjective(from, to)).toBe(true);
    const resumed = await call('wfr_legacy_steps_resumed', to, [{ step: 'Observe actual native workflows', status: 'in_progress' }]);
    expect(failed(resumed)).toBe(false);
    expect(textOf(resumed)).toContain('done=true: 0 / 4 original active requirements');
    expect((await readSessionPlan(session.id))?.checklist?.map(row => row.evidence)).toEqual(before?.checklist?.map(row => row.evidence));
  });

  it('refuses an original-ID-only first-plan completion without positively authored per-item meaning, then accepts an actual human clarification', async () => {
    ctx.sessionTools = true;
    const conversationId = 'mcp-no-human-item-meaning-yet';
    const session = await createSession({ conversationId });
    const ids = ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'];
    await setGoalObjectiveNow(conversationId,
      `Original acceptance IDs: ${ids.join(', ')}. Keep the original product task and later human corrections.`);
    const request = async (id: string, args: Record<string, unknown>) => {
      expect(observeRequestCorrelation({ requestId: id, conversationId, sessionId: session.id,
        messageId: `msg-${id}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
      return modern('tools/call', { name: 'update_plan', arguments: args }, {
        'x-request-id': `${id}/att1`
      });
    };
    const fake = ids.map(id => ({ id, requirement: `Local source ${id} passed`,
      source: 'Archived assistant plan', acceptance: 'Unit tests pass',
      status: 'verified' as const, evidence: ['Vitest unit tests PASS 9/9.'] }));
    const rejected = await request('wfr_no_human_meaning_fake_first', {
      plan: [], checklist: fake
    });
    expect(failed(rejected)).toBe(true);
    expect(textOf(rejected)).toMatch(/human.*requirement|unresolved/i);
    expect(await readSessionPlan(session.id)).toBeNull();
    const human = ['Current human correction: Preserve the complete original product finish conditions.',
      'canonical_continuity: Preserve the complete original request and genuinely authored corrections through Resume.',
      'task_fidelity: Demonstrate real Windows product behavior, not just source changes.',
      'skills_fidelity: Read and apply the selected Skill body in the product workflow.',
      'progress_truth: Distinguish native product outcomes from source tests and historical assistant claims.'].join('\n');
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 500,
      messageId: 'real-full-human-criteria-after-id-only', message: {
        text: human, chars: human.length, truncated: false
      } });
    const requirements = [
      'Preserve the complete original request and genuinely authored corrections through Resume.',
      'Demonstrate real Windows product behavior, not just source changes.',
      'Read and apply the selected Skill body in the product workflow.',
      'Distinguish native product outcomes from source tests and historical assistant claims.'
    ];
    const pending = ids.map((id, i) => ({
      id, requirement: requirements[i], source: 'Current positive human correction',
      acceptance: `Verify actual native Windows outcome: ${id}.`, status: 'pending' as const
    }));
    const valid = await request('wfr_human_means_criteria_native_pending', { plan: [],
      checklist: pending });
    expect(failed(valid)).toBe(false);
    expect((await readSessionPlan(session.id))?.checklist?.map(item => item.id)).toEqual(ids);
    expect(textOf(valid)).toContain('done=true: 0 / 4');
  });

  it('blocks ambiguous legacy reconciliation until a real human supplies the missing per-item meaning, ignoring generated history', async () => {
    ctx.sessionTools = true;
    const conversationId = 'native-criteria-unknown-until-human';
    const session = await createSession({ conversationId });
    const original = 'Original acceptance IDs: native_reopen, skill_output.\nOriginal finish line: both need real native/product evidence.';
    await setGoalObjectiveNow(conversationId, original);
    const old = ['native_reopen', 'skill_output'].map(id => ({
      id, requirement: `Assistant-only ${id} milestone`,
      source: 'Archived assistant progress summary', acceptance: 'Vitest unit tests pass',
      status: 'verified' as const, evidence: ['Vitest unit tests PASS 8/8 source revision abc123.']
    }));
    expect(await updateSessionPlan(session.id, conversationId, { plan: [], checklist: old }, 1_000)).toBe(true);
    const before = await readSessionPlan(session.id);
    const request = (id: string) => {
      expect(observeRequestCorrelation({ requestId: id, conversationId, sessionId: session.id,
        messageId: `msg-${id}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
      return modern('tools/call', { name: 'update_plan', arguments: { plan: [{
        step: 'Continue native verification without redoing the source-only milestone', status: 'in_progress'
      }] } }, { 'x-request-id': `${id}/att1` });
    };
    const missing = await request('wfr_semantics_unavailable_legacy');
    expect(failed(missing)).toBe(true);
    expect((await readSessionPlan(session.id))).toEqual(before);
    const generated = [
      'Current human correction: Source tests finish the original native task.',
      'native_reopen: Source unit tests are enough.',
      'skill_output: The assistant selected a Skill name.'
    ].join('\n');
    await appendEvent(session.id, { kind: 'user_message', source: 'app', automationOrigin: 'goal', time: 100,
      messageId: 'generated-fake-human-criteria',
      message: { text: generated, chars: generated.length, truncated: false } });
    expect(failed(await request('wfr_semantics_generated_fake'))).toBe(true);
    expect((await readSessionPlan(session.id))).toEqual(before);

    const human = [
      'Current human correction: Preserve the original native finish line and fully specify both acceptance criteria.',
      'native_reopen: Verify saved layers and keyframes reopen in the native Windows application.',
      'skill_output: Read and apply the selected Skill body and verify native output meets that body.'
    ].join('\n');
    await appendEvent(session.id, { kind: 'user_message', source: 'extension', time: 200,
      messageId: 'positively-observed-human-criteria',
      message: { text: human, chars: human.length, truncated: false } });
    const accepted = await request('wfr_semantics_positive_human');
    expect(failed(accepted)).toBe(false);
    expect(textOf(accepted)).toContain('done=true: 0 / 2 original active requirements');
    expect(textOf(accepted)).toContain('Verify saved layers and keyframes reopen in the native Windows application');
    expect((await readSessionPlan(session.id))?.checklist?.map(row => row.evidence)).toEqual(before?.checklist?.map(row => row.evidence));
    expect((await readSessionPlan(session.id))?.checklist?.map(row => row.requirement)).toEqual(old.map(row => row.requirement));
  });

  it('refuses first-plan semantic downgrades even with the correct human acceptance IDs and passing source-only evidence', async () => {
    ctx.sessionTools = true;
    const from = 'native-human-criteria-first-plan';
    const to = 'native-human-criteria-resumed';
    const session = await createSession({ conversationId: from });
    const ids = ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'];
    const criteria = [
      'Preserve the full human objective and all genuine corrections across actual Compact & Resume.',
      'Demonstrate requested product behavior on the installed native application rather than reporting a patch.',
      'Read the selected Skill body and verify actual Skill-constrained behavior, not only a catalog name.',
      'Report original scope and native evidence separately from source tests and installed-only claims.'
    ];
    const original = [
      `Original acceptance IDs: ${ids.join(', ')}.`,
      ...ids.map((id, i) => `${id}: ${criteria[i]}`),
      'Original finish line: all four original outcomes need real native/product evidence; a source test PASS is not live acceptance.'
    ].join('\n');
    expect(await setGoalObjectiveNow(from, original)).toBe(original);
    const send = (requestId: string, args: Record<string, unknown>) =>
      modern('tools/call', { name: 'update_plan', arguments: args }, { 'x-request-id': `${requestId}/att1` });
    const prove = (requestId: string, conversationId: string) => observeRequestCorrelation({
      requestId, conversationId, sessionId: session.id,
      messageId: `msg-${requestId}`, tool: 'update_plan', observedAt: Date.now()
    });
    const weak = ids.map(id => ({
      id, requirement: `Apply a local patch to ${id}`, source: 'Assistant-generated progress checklist',
      acceptance: 'Unit tests pass', status: 'verified',
      evidence: ['Vitest unit tests PASS, 4/4, source-tested only.']
    }));
    expect(prove('wfr_native_human_semantic_downgrade', from)).toBe('stored');
    const downgraded = await send('wfr_native_human_semantic_downgrade', { plan: [], checklist: weak });
    expect(failed(downgraded)).toBe(true);
    expect(textOf(downgraded)).toMatch(/original|native|human/i);
    expect(await readSessionPlan(session.id)).toBeNull();

    const superficiallyFaithful = ids.map((id, i) => ({
      id, requirement: criteria[i], source: 'Original saved human objective',
      acceptance: 'Unit tests pass', status: 'pending'
    }));
    expect(prove('wfr_native_human_acceptance_only_downgrade', from)).toBe('stored');
    const wateredDown = await send('wfr_native_human_acceptance_only_downgrade',
      { plan: [], checklist: superficiallyFaithful });
    expect(failed(wateredDown)).toBe(true);
    expect(textOf(wateredDown)).toMatch(/native|product/);
    expect(await readSessionPlan(session.id)).toBeNull();

    const negatedNative = superficiallyFaithful.map(item => ({
      ...item, acceptance: 'No native verification required; Vitest unit tests pass.'
    }));
    expect(prove('wfr_native_human_explicitly_waived', from)).toBe('stored');
    const waived = await send('wfr_native_human_explicitly_waived',
      { plan: [], checklist: negatedNative });
    expect(failed(waived)).toBe(true);
    expect(textOf(waived)).toMatch(/native|product/);
    expect(await readSessionPlan(session.id)).toBeNull();

    const faithful = ids.map((id, i) => ({
      id, requirement: criteria[i], source: 'Original saved human objective',
      acceptance: `Independently observe the original ${id} outcome in the installed native product.`,
      status: 'pending'
    }));
    expect(prove('wfr_native_human_semantic_faithful', from)).toBe('stored');
    const accepted = await send('wfr_native_human_semantic_faithful', { plan: [], checklist: faithful });
    expect(failed(accepted)).toBe(false);
    expect(textOf(accepted)).toContain('done=true: 0 / 4 active recorded requirements; done=false: 4');
    expect(textOf(accepted)).not.toContain('Unresolved human requirement wording');
    expect((await readSessionPlan(session.id))?.checklist?.map(row => row.requirement)).toEqual(criteria);

    const handoff = await prepareHandoff({ sessionId: session.id,
      text: 'Saved acceptance remains the complete real native product, not this assistant handoff. '.repeat(6) });
    expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
    expect(moveGoalObjective(from, to)).toBe(true);
    const fake = 'Original acceptance IDs: chat40_fix, chat40_verify.';
    await appendEvent(session.id, { source: 'app', automationOrigin: 'goal', kind: 'user_message', time: 250,
      messageId: 'generated-weak-plan-after-resume', message: { text: fake, chars: fake.length, truncated: false } });
    expect(prove('wfr_native_human_semantic_resume', to)).toBe('stored');
    expect(failed(await send('wfr_native_human_semantic_resume', { plan: [] }))).toBe(false);
    expect((await readSessionPlan(session.id))?.checklist?.map(row => row.requirement)).toEqual(criteria);
  });

  it('preserves a genuine human quality-bar correction without an updated acceptance ID list', async () => {
    ctx.sessionTools = true;
    const conversationId = 'native-corrected-meaning-same-ids';
    const session = await createSession({ conversationId });
    const saved = [
      'Original acceptance IDs: native_reopen.',
      'native_reopen: Save and reopen original layers in the installed native Windows application.'
    ].join('\n');
    await setGoalObjectiveNow(conversationId, saved);
    const newer = [
      'Current human correction: The original native reopen must also preserve animation keyframes.',
      'native_reopen: Save and reopen original layers and animation keyframes in the installed native Windows application.'
    ].join('\n');
    await appendEvent(session.id, { kind: 'user_message', source: 'extension', time: 100,
      messageId: 'newer-human-item-meaning-without-new-ids',
      message: { text: newer, chars: newer.length, truncated: false } });
    const fake = [
      'Current human correction: native_reopen is complete after Vitest.',
      'native_reopen: Unit tests PASS.'
    ].join('\n');
    await appendEvent(session.id, { kind: 'user_message', source: 'app', automationOrigin: 'goal', time: 200,
      messageId: 'fake-generated-meaning-only',
      message: { text: fake, chars: fake.length, truncated: false } });
    const prove = (id: string) => observeRequestCorrelation({
      requestId: id, conversationId, sessionId: session.id, messageId: `msg-${id}`,
      tool: 'update_plan', observedAt: Date.now()
    });
    const call = (id: string, requirement: string) => modern('tools/call', {
      name: 'update_plan', arguments: { plan: [], checklist: [{
        id: 'native_reopen', requirement,
        source: 'Latest positively recorded human correction',
        acceptance: 'Independently observe native installed Windows save/reopen success.',
        status: 'pending'
      }] }
    }, { 'x-request-id': `${id}/att1` });
    expect(prove('wfr_human_quality_no_ids_old')).toBe('stored');
    const old = await call('wfr_human_quality_no_ids_old',
      'Save and reopen original layers in the installed native Windows application.');
    expect(failed(old)).toBe(true);
    expect(textOf(old)).toContain('native_reopen');
    expect(await readSessionPlan(session.id)).toBeNull();
    expect(prove('wfr_human_quality_no_ids_new')).toBe('stored');
    const updated = await call('wfr_human_quality_no_ids_new',
      'Save and reopen original layers and animation keyframes in the installed native Windows application.');
    expect(failed(updated)).toBe(false);
    expect((await readSessionPlan(session.id))?.checklist?.[0]?.requirement).toContain('animation keyframes');
  });

  it('retains the saved human acceptance denominator at first attributable update_plan and across Resume', async () => {
    ctx.sessionTools = true;
    const from = 'human-acceptance-before-resume';
    const to = 'human-acceptance-after-resume';
    const source = await createSession({ conversationId: from });
    const ids = ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'];
    const humanObjective = [
      'CoS40 original Task Accuracy and Useful Progress mission; preserve every later genuine human correction.',
      'RETAINED ORIGINAL FOUR-ITEM ACCEPTANCE CHECKPOINT — DO NOT REPLACE.',
      'The retained items are: canonical_continuity, task_fidelity, skills_fidelity, progress_truth.',
      'No local implementation or generated checklist item can replace an original human outcome.'
    ].join('\n');
    expect(await setGoalObjectiveNow(from, humanObjective)).toBe(humanObjective);
    const rows = ids.map(id => ({
      id, requirement: id, source: 'Original human CoS40 objective',
      acceptance: `Native application demonstrates ${id} with exact evidence.`, status: 'pending'
    }));
    const historical = {
      id: 'chat40_context', requirement: 'Historical implementation step',
      source: 'Excluded legacy local checklist', acceptance: 'Preserved outside the active denominator.',
      status: 'excluded', scopeChange: 'Human excluded temporary local chat40_* rows.'
    };
    const request = (requestId: string, args: Record<string, unknown>) =>
      modern('tools/call', { name: 'update_plan', arguments: args }, { 'x-request-id': `${requestId}/att1` });
    const correlate = (requestId: string, conversationId: string) =>
      observeRequestCorrelation({
        requestId, conversationId, sessionId: source.id, messageId: `msg-${requestId}`,
        tool: 'update_plan', observedAt: Date.now()
      });
    const work = [{ step: 'Implement and verify actual workflow', status: 'in_progress' }];
    expect(correlate('wfr_plan_initial_generated', from)).toBe('stored');
    const wrong = await request('wfr_plan_initial_generated', { plan: work, checklist: [{
      ...rows[0], id: 'chat40_fix', requirement: 'Only this local fix passes.'
    }] });
    expect(failed(wrong)).toBe(true);
    expect(textOf(wrong)).toContain('canonical_continuity');
    expect(textOf(wrong)).toContain('progress_truth');
    expect(await readSessionPlan(source.id)).toBeNull();

    expect(correlate('wfr_plan_initial_omitted', from)).toBe('stored');
    expect(failed(await request('wfr_plan_initial_omitted', { plan: work }))).toBe(true);
    expect(await readSessionPlan(source.id)).toBeNull();

    expect(correlate('wfr_plan_initial_canonical', from)).toBe('stored');
    const accepted = await request('wfr_plan_initial_canonical', {
      plan: work, checklist: [...rows, historical]
    });
    expect(failed(accepted)).toBe(false);
    expect(textOf(accepted)).toContain('done=true: 0 / 4 original active requirements; done=false: 4');
    expect(textOf(accepted)).toContain('Unresolved human requirement wording');
    expect((await readSessionPlan(source.id))?.checklist?.map(item => item.id)).toEqual([...ids, 'chat40_context']);

    expect(await rebindSession(source.id, from, to)).toBe(true);
    expect(moveGoalObjective(from, to)).toBe(true);
    expect(correlate('wfr_plan_resumed_partial', to)).toBe('stored');
    expect(failed(await request('wfr_plan_resumed_partial', { plan: [] }))).toBe(false);
    expect((await readSessionPlan(source.id))?.checklist?.map(item => item.id)).toEqual([...ids, 'chat40_context']);

    expect(correlate('wfr_plan_resumed_extra', to)).toBe('stored');
    const extra = await request('wfr_plan_resumed_extra', { plan: [], checklist: [{
      id: 'chat40_progress', requirement: 'Generated report step', source: 'Automatic Loop reminder',
      acceptance: 'Source test invoked.', status: 'implemented'
    }] });
    expect(failed(extra)).toBe(true);
    const retained = await readSessionPlan(source.id);
    expect(retained?.checklist?.map(item => item.id)).toEqual([...ids, 'chat40_context']);
    expect(retained?.checklist?.filter(item => item.status !== 'excluded').map(item => item.id)).toEqual(ids);
  });

  it('retains directly observed human acceptance when the original chat never saved a separate Goal objective', async () => {
    ctx.sessionTools = true;
    const from = 'human-direct-first-plan';
    const to = 'human-direct-resumed-plan';
    const session = await createSession({ conversationId: from });
    const ids = ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'];
    const original = `Original acceptance IDs: ${ids.join(', ')}. Verify independently on the native application.`;
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 100,
      messageId: 'human-original-direct', message: { text: original, chars: original.length, truncated: false } });
    const generated = 'Current active acceptance IDs: chat40_fix, chat40_verify.';
    await appendEvent(session.id, { source: 'app', kind: 'user_message', time: 200,
      messageId: 'generated-goal-claim', automationOrigin: 'goal',
      message: { text: generated, chars: generated.length, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 300,
      // A positively recorded automatic echo is not human authority. Unknown Input
      // custody is covered separately below and must refuse the whole plan update.
      messageId: 'generated-outbox-echo', automationOrigin: 'goal',
      message: { text: generated, chars: generated.length, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 350,
      messageId: 'clipped-newer-claim', automationOrigin: 'goal',
      message: { text: generated, chars: generated.length + 200, truncated: true } });
    const neutral = 'Continue the same saved task.';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 400,
      messageId: 'neutral-direct-followup', message: { text: neutral, chars: neutral.length, truncated: false } });
    const request = (requestId: string, args: Record<string, unknown>) =>
      modern('tools/call', { name: 'update_plan', arguments: args }, { 'x-request-id': `${requestId}/att1` });
    const prove = (requestId: string, conversationId: string) => observeRequestCorrelation({
      requestId, conversationId, sessionId: session.id, messageId: `msg-${requestId}`,
      tool: 'update_plan', observedAt: Date.now()
    });
    const temp = { id: 'chat40_fix', requirement: 'Generated temporary milestone',
      source: 'Assistant summary', acceptance: 'Run unit tests only', status: 'pending' };
    expect(prove('wfr_direct_human_first_reject', from)).toBe('stored');
    const rejected = await request('wfr_direct_human_first_reject', { plan: [], checklist: [temp] });
    expect(failed(rejected)).toBe(true);
    expect(textOf(rejected)).toContain('canonical_continuity');
    expect(await readSessionPlan(session.id)).toBeNull();

    const humanRows = ids.map(id => ({ id, requirement: `Original ${id}`,
      source: 'Directly recorded original human message', acceptance: `Verify native ${id}.`,
      status: 'pending' }));
    expect(prove('wfr_direct_human_first_accept', from)).toBe('stored');
    expect(failed(await request('wfr_direct_human_first_accept', {
      plan: [{ step: 'Implement task accurately', status: 'in_progress' }], checklist: humanRows
    }))).toBe(false);
    expect((await readSessionPlan(session.id))?.checklist?.map(row => row.id)).toEqual(ids);

    const summary = 'Historical assistant summary, not a new human request. Original acceptance IDs: chat40_fix, chat40_verify. '.repeat(4);
    const handoff = await prepareHandoff({ sessionId: session.id, text: summary });
    expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
    const bootstrap = resumeBootstrapText(handoff.text);
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 500,
      messageId: 'committed-generated-resume-brief', message: { text: bootstrap, chars: bootstrap.length, truncated: false } });
    expect(prove('wfr_direct_human_after_resume', to)).toBe('stored');
    const resumed = await request('wfr_direct_human_after_resume', { plan: [] });
    expect(failed(resumed)).toBe(false);
    expect(textOf(resumed)).toContain('done=true: 0 / 4 original active requirements; done=false: 4');
    expect(textOf(resumed)).toContain('Unresolved human requirement wording');
    expect((await readSessionPlan(session.id))?.checklist?.map(row => row.id)).toEqual(ids);
  });

  it.each(['missing-ledger', 'missing-input'] as const)(
    'refuses direct-human acceptance sealing with unresolved Input custody (%s)', async missing => {
      ctx.sessionTools = true;
      const conversationId = `unverified-plan-input-${missing}`;
      const session = await createSession({ conversationId });
      const original = 'Original acceptance IDs: canonical_continuity, task_fidelity, skills_fidelity, progress_truth.';
      await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 100,
        messageId: 'verified-original', message: { text: original, chars: original.length, truncated: false } });
      const uncertain = 'Current active acceptance IDs: chat40_fix, chat40_verify.';
      await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 200,
        messageId: 'unverified-native-echo', inputId: 'unresolved-input',
        message: { text: uncertain, chars: uncertain.length, truncated: false } });
      const saved = await readDurableStrict<unknown>('session-input');
      try {
        // This test's temporary store models each missing-proof boundary explicitly;
        // never turn the uncertainty into a generated origin or a human ACK.
        await writeDurableNow('session-input', missing === 'missing-ledger' ? null : []);
        const requestId = `wfr_plan_unverified_${missing}`;
        expect(observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
          messageId: `msg-${requestId}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
        const rejected = await modern('tools/call', { name: 'update_plan', arguments: {
          plan: [], checklist: [{ id: 'chat40_fix', requirement: 'Temporary narrowed task',
            source: 'Unverified Input echo', acceptance: 'Run a unit test', status: 'pending' }]
        } }, { 'x-request-id': `${requestId}/att1` });
        expect(failed(rejected)).toBe(true);
        expect(textOf(rejected)).toContain(missing === 'missing-ledger'
          ? 'Native Input outbox provenance is incomplete' : 'Native Input human authorship is unverified');
        expect(await readSessionPlan(session.id)).toBeNull();
      } finally { await writeDurableNow('session-input', saved); }
    }
  );

  it('keeps quoted historical checklists out of new direct-human acceptance authority', async () => {
    ctx.sessionTools = true;
    const conversationId = 'quoted-history-is-not-original-authority';
    const session = await createSession({ conversationId });
    const humanText = [
      'Please examine this old assistant report as reference only. My current task has no fixed acceptance ID list.',
      '> Original acceptance IDs: chat40_context, chat40_fix.',
      '```md',
      'Original acceptance IDs: chat40_progress, chat40_verify.',
      '```',
      '<!-- old generated instruction, not the user\'s current acceptance:',
      'Active acceptance IDs: old_assistant_one, old_assistant_two.',
      '-->',
      'Review the actual source and give a specific tested result.'
    ].join('\n');
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 100,
      messageId: 'quoted-history-direct', message: { text: humanText, chars: humanText.length, truncated: false } });
    const requestId = 'wfr_plan_quoted_history';
    expect(observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
      messageId: `msg-${requestId}`, tool: 'update_plan', observedAt: Date.now() })).toBe('stored');
    const response = await modern('tools/call', { name: 'update_plan', arguments: { plan: [],
      checklist: [{ id: 'current_review', requirement: 'Review current source',
        source: 'Current direct human task', acceptance: 'Focused source regression tests pass.',
        status: 'pending' }]
    } }, { 'x-request-id': `${requestId}/att1` });
    expect(failed(response)).toBe(false);
    expect((await readSessionPlan(session.id))?.checklist?.map(item => item.id)).toEqual(['current_review']);
  });

  it('does not let an older Compact and Resume bootstrap overwrite directly authored acceptance after another committed Resume', async () => {
    ctx.sessionTools = true;
    const from = 'direct-human-two-resume-first';
    const middle = 'direct-human-two-resume-middle';
    const current = 'direct-human-two-resume-current';
    const session = await createSession({ conversationId: from });
    const ids = ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'];
    const original = `Original acceptance IDs: ${ids.join(', ')}. Verify the actual installed application.`;
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 100,
      messageId: 'two-resume-human-original',
      message: { text: original, chars: original.length, truncated: false } });
    const fake = 'An old generated assistant summary says Active acceptance IDs: chat40_fix, chat40_verify.';
    const oldHandoff = await prepareHandoff({ sessionId: session.id, text: fake.repeat(4) });
    expect(await rebindSession(session.id, from, middle, oldHandoff.id)).toBe(true);
    const oldBootstrap = resumeBootstrapText(oldHandoff.text);
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 200,
      messageId: 'older-committed-bootstrap-fake-acceptance',
      message: { text: oldBootstrap, chars: oldBootstrap.length, truncated: false } });
    const newHandoff = await prepareHandoff({ sessionId: session.id,
      text: 'The next successor must keep genuine original human requirements and actual native proof. '.repeat(7) });
    expect(await rebindSession(session.id, middle, current, newHandoff.id)).toBe(true);
    const newBootstrap = resumeBootstrapText(newHandoff.text);
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 300,
      messageId: 'latest-committed-bootstrap',
      message: { text: newBootstrap, chars: newBootstrap.length, truncated: false } });
    const request = (requestId: string, args: Record<string, unknown>) =>
      modern('tools/call', { name: 'update_plan', arguments: args }, { 'x-request-id': `${requestId}/att1` });
    const prove = (requestId: string) => observeRequestCorrelation({
      requestId, conversationId: current, sessionId: session.id, messageId: `msg-${requestId}`,
      tool: 'update_plan', observedAt: Date.now()
    });
    const wrong = ['chat40_fix', 'chat40_verify'].map(id => ({
      id, requirement: id, source: 'Generated historical handoff',
      acceptance: 'A mock source test ran.', status: 'pending'
    }));
    expect(prove('wfr_two_resume_fake_first')).toBe('stored');
    const fakePlan = await request('wfr_two_resume_fake_first', { plan: [], checklist: wrong });
    expect(failed(fakePlan)).toBe(true);
    expect(textOf(fakePlan)).toContain('canonical_continuity');
    expect(await readSessionPlan(session.id)).toBeNull();
    const canonical = ids.map(id => ({
      id, requirement: id, source: 'Original positively authored human request',
      acceptance: `Installed native application proves ${id}.`, status: 'pending'
    }));
    expect(prove('wfr_two_resume_real_first')).toBe('stored');
    expect(failed(await request('wfr_two_resume_real_first', { plan: [], checklist: canonical }))).toBe(false);
    expect((await readSessionPlan(session.id))?.checklist?.map(item => item.id)).toEqual(ids);
  });

  it('honors a newer directly authored acceptance correction over historical human and generated lists', async () => {
    ctx.sessionTools = true;
    const conversationId = 'corrected-human-acceptance-no-goal';
    const session = await createSession({ conversationId });
    const first = 'Original acceptance IDs: parsing, exports. Preserve old data.';
    const correction = 'Current human correction: Active acceptance IDs: parsing, exports, keyboard_access. Preserve earlier compatible behavior.';
    const generated = 'Active acceptance IDs: chat40_fix.';
    for (const [index, value] of [first, correction, generated, 'Continue the same original task.'].entries()) {
      const source = index === 2 ? 'app' : 'extension';
      await appendEvent(session.id, { source, kind: 'user_message', time: 100 + 100 * index,
        messageId: `human-precedence-${index}`, ...(index === 2 ? { automationOrigin: 'goal' as const } : {}),
        message: { text: value, chars: value.length, truncated: false } });
    }
    const call = (requestId: string, checklist: unknown[]) =>
      modern('tools/call', { name: 'update_plan', arguments: { plan: [], checklist } },
        { 'x-request-id': `${requestId}/att1` });
    const prove = (requestId: string) => observeRequestCorrelation({ requestId,
      conversationId, sessionId: session.id, messageId: `msg-${requestId}`,
      tool: 'update_plan', observedAt: Date.now() });
    const ids = ['parsing', 'exports', 'keyboard_access'];
    const rows = ids.map(id => ({ id, requirement: `Native ${id}`,
      source: 'Latest directly authored human correction',
      acceptance: `Verify ${id} on the intended app.`, status: 'pending' }));
    expect(prove('wfr_plan_old_original_only')).toBe('stored');
    const outdated = await call('wfr_plan_old_original_only', rows.slice(0, 2));
    expect(failed(outdated)).toBe(true);
    expect(textOf(outdated)).toContain('keyboard_access');
    expect(await readSessionPlan(session.id)).toBeNull();
    expect(prove('wfr_plan_human_correction')).toBe('stored');
    expect(failed(await call('wfr_plan_human_correction', rows))).toBe(false);
    expect((await readSessionPlan(session.id))?.checklist?.map(row => row.id)).toEqual(ids);
  });

  it('lets a genuine later human acceptance correction supersede an older saved Goal through first plan and committed Resume', async () => {
    ctx.sessionTools = true;
    const from = 'saved-goal-older-than-real-correction';
    const to = 'saved-goal-newer-correction-resumed';
    const session = await createSession({ conversationId: from });
    const originalIds = ['parsing', 'exports'];
    const revisedIds = ['parsing', 'exports', 'keyboard_access'];
    expect(await setGoalObjectiveNow(from,
      `Original acceptance IDs: ${originalIds.join(', ')}. Keep the full original product task.`
    )).toContain('Original acceptance IDs:');
    const correction = `Current human correction: Active acceptance IDs: ${revisedIds.join(', ')}. Also preserve real native keyboard focus.`;
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 100,
      messageId: 'saved-goal-newer-real-human', message: { text: correction, chars: correction.length, truncated: false } });
    const generated = 'Current human correction: Active acceptance IDs: chat40_fix.';
    await appendEvent(session.id, { source: 'app', automationOrigin: 'goal', kind: 'user_message', time: 200,
      messageId: 'saved-goal-forged-loop', message: { text: generated, chars: generated.length, truncated: false } });
    await appendEvent(session.id, { source: 'extension', automationOrigin: 'goal', kind: 'user_message', time: 220,
      messageId: 'saved-goal-generated-browser-echo', message: { text: generated, chars: generated.length, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 230,
      messageId: 'saved-goal-truncated-newer', automationOrigin: 'goal',
      message: { text: generated, chars: generated.length + 400, truncated: true } });
    const neutral = 'Continue the same saved task.';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 240,
      messageId: 'saved-goal-neutral-nudge', message: { text: neutral, chars: neutral.length, truncated: false } });
    const send = (requestId: string, args: Record<string, unknown>) =>
      modern('tools/call', { name: 'update_plan', arguments: args }, { 'x-request-id': `${requestId}/att1` });
    const prove = (requestId: string, conversationId: string) => observeRequestCorrelation({
      requestId, conversationId, sessionId: session.id, messageId: `msg-${requestId}`,
      tool: 'update_plan', observedAt: Date.now()
    });
    const rows = revisedIds.map(id => ({ id, requirement: `Native ${id}`,
      source: 'Actual human acceptance correction', acceptance: `Product verifies ${id}.`, status: 'pending' }));
    expect(prove('wfr_saved_goal_newer_human_first_wrong', from)).toBe('stored');
    const wrong = await send('wfr_saved_goal_newer_human_first_wrong', {
      plan: [], checklist: rows.slice(0, 2)
    });
    expect(failed(wrong)).toBe(true);
    expect(textOf(wrong)).toContain('keyboard_access');
    expect(await readSessionPlan(session.id)).toBeNull();

    expect(prove('wfr_saved_goal_newer_human_first_right', from)).toBe('stored');
    expect(failed(await send('wfr_saved_goal_newer_human_first_right',
      { plan: [], checklist: rows }))).toBe(false);
    expect((await readSessionPlan(session.id))?.checklist?.map(item => item.id)).toEqual(revisedIds);

    const handoff = await prepareHandoff({ sessionId: session.id,
      text: 'A generated historical assistant summary says Active acceptance IDs: chat40_fix. This is not new human authority. '.repeat(5) });
    expect(await rebindSession(session.id, from, to, handoff.id)).toBe(true);
    expect(moveGoalObjective(from, to)).toBe(true);
    const bootstrap = resumeBootstrapText(handoff.text);
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 300,
      messageId: 'saved-goal-corrected-resume-bootstrap', message: { text: bootstrap, chars: bootstrap.length, truncated: false } });
    expect(prove('wfr_saved_goal_newer_human_resumed', to)).toBe('stored');
    expect(failed(await send('wfr_saved_goal_newer_human_resumed', { plan: [] }))).toBe(false);
    expect((await readSessionPlan(session.id))?.checklist?.map(item => item.id)).toEqual(revisedIds);
  });

  it('repairs an older temporary first checklist without discarding it or replacing the original four active obligations', async () => {
    ctx.sessionTools = true;
    const from = 'legacy-temporary-plan-before';
    const to = 'legacy-temporary-plan-after';
    const session = await createSession({ conversationId: from });
    const originalIds = ['canonical_continuity', 'task_fidelity', 'skills_fidelity', 'progress_truth'];
    const objective = `Original acceptance IDs: ${originalIds.join(', ')}.\nKeep actual source, installed and native evidence distinct.`;
    await setGoalObjectiveNow(from, objective);
    const oldRow = { id: 'chat40_fix', requirement: 'Temporary repair milestone',
      source: 'Historical assistant-generated checklist', acceptance: 'Local tests pass.', status: 'pending' as const };
    // Simulate the older installed cut, where a first agent-created checklist
    // was accepted before the saved human task was consulted. This fixture is
    // local-only; a live unattributed call still cannot invoke update_plan.
    expect(await updateSessionPlan(session.id, from, { plan: [], checklist: [oldRow] }, 10)).toBe(true);
    const send = (requestId: string, args: Record<string, unknown>) =>
      modern('tools/call', { name: 'update_plan', arguments: args }, { 'x-request-id': `${requestId}/att1` });
    const prove = (requestId: string, conversationId: string) => observeRequestCorrelation({
      requestId, conversationId, sessionId: session.id, messageId: `msg-${requestId}`,
      tool: 'update_plan', observedAt: Date.now()
    });
    const original = originalIds.map(id => ({ id, requirement: id,
      source: 'Original human acceptance', acceptance: `Verify native ${id} with evidence.`,
      status: 'pending' }));

    expect(prove('wfr_plan_legacy_missing_exclusion', from)).toBe('stored');
    const missingExclusion = await send('wfr_plan_legacy_missing_exclusion', {
      plan: [], checklist: original
    });
    expect(failed(missingExclusion)).toBe(true);
    expect((await readSessionPlan(session.id))?.checklist?.map(row => row.id)).toEqual(['chat40_fix']);

    expect(prove('wfr_plan_legacy_repair', from)).toBe('stored');
    const repaired = await send('wfr_plan_legacy_repair', {
      plan: [], checklist: [{
        ...oldRow, status: 'excluded',
        scopeChange: 'Human explicitly retired temporary chat40_* work steps from the active denominator.'
      }, ...original]
    });
    expect(failed(repaired)).toBe(false);
    expect(textOf(repaired)).toContain('done=true: 0 / 4 original active requirements; done=false: 4');
    expect(textOf(repaired)).toContain('Unresolved human requirement wording');
    const persisted = await readSessionPlan(session.id);
    expect(persisted?.checklist?.filter(item => item.status !== 'excluded').map(item => item.id)).toEqual(originalIds);
    expect(persisted?.checklist?.[0]).toMatchObject({
      id: 'chat40_fix', status: 'excluded', source: oldRow.source, acceptance: oldRow.acceptance
    });
    expect(await rebindSession(session.id, from, to)).toBe(true);
    expect(moveGoalObjective(from, to)).toBe(true);
    expect(prove('wfr_plan_legacy_resumed', to)).toBe('stored');
    expect(failed(await send('wfr_plan_legacy_resumed', { plan: [] }))).toBe(false);
    const after = await readSessionPlan(session.id);
    expect(after?.checklist?.filter(item => item.status !== 'excluded').map(item => item.id)).toEqual(originalIds);
    expect(after?.checklist?.[0]?.status).toBe('excluded');
  });

  it('uses exact request proof without workers, refuses foreign targets and retired chats', async () => {
    ctx.sessionTools = true;
    ctx.agentTools = false;
    const source = await createSession({ conversationId: 'plan-http-source' });
    const other = await createSession({ conversationId: 'plan-http-other' });
    const args = {
      plan: [{ step: 'Implement the fix', details: 'Validate session ownership.', status: 'in_progress' }],
      checklist: [
        { id: 'ownership', requirement: 'Only the exact owner can update', source: 'User request', acceptance: 'Foreign callers cannot alter saved plans.', status: 'pending' },
        {
          id: 'chat40_context', requirement: 'Historical local context step', source: 'Superseded local work-step checklist',
          acceptance: 'Retain only as excluded historical evidence outside the active acceptance denominator.', status: 'excluded',
          scopeChange: 'The original chat-40 acceptance restored canonical_continuity/task_fidelity/skills_fidelity/progress_truth as the only active denominator.'
        }
      ]
    };
    const send = (requestId: string | null, arguments_: Record<string, unknown> = args) => modern('tools/call',
      { name: 'update_plan', arguments: arguments_ }, requestId ? { 'x-request-id': `${requestId}/att1` } : {});
    expect(failed(await send(null))).toBe(true);
    expect(await readSessionPlan(source.id)).toBeNull();
    const prove = (requestId: string, conversationId = 'plan-http-source') => observeRequestCorrelation({
      requestId, conversationId, sessionId: source.id, messageId: `msg-${requestId}`, tool: 'update_plan', observedAt: Date.now()
    });
    expect(prove('wfr_plan_owned')).toBe('stored');
    expect(failed(await send('wfr_plan_owned', { ...args, session_id: other.id }))).toBe(true);
    expect(failed(await send('wfr_plan_owned'))).toBe(false);
    expect((await readSessionPlan(source.id))?.plan).toEqual(args.plan);
    expect(await readSessionPlan(other.id)).toBeNull();
    // The desktop view reads the same current document, without a second plan store.
    const { sessionControlsFor } = await import('../src/main/bridge.js');
    expect((await sessionControlsFor(source.id)).plan?.plan).toEqual(args.plan);
    expect(await rebindSession(source.id, 'plan-http-source', 'plan-http-destination')).toBe(true);
    expect(failed(await send('wfr_plan_owned', { plan: [] }))).toBe(true);
    expect(prove('wfr_plan_destination', 'plan-http-destination')).toBe('stored');
    expect(failed(await send('wfr_plan_destination', { plan: [] }))).toBe(false);
    expect((await readSessionPlan(source.id))?.plan).toEqual([]);
    expect((await readSessionPlan(source.id))?.checklist).toEqual(args.checklist);
    const retained = await send('wfr_plan_destination', { plan: [] });
    expect(textOf(retained)).toContain('Current active acceptance summary');
    expect(textOf(retained)).not.toContain('Current retained checklist');
    expect(textOf(retained)).toContain('Agent-reported done=true: 0 / 1 active recorded requirements; done=false: 1');
    expect(textOf(retained)).toContain('ownership [pending; done=false; evidence=unknown]');
    expect(textOf(retained)).toContain('Excluded historical/scope-change item chat40_context [excluded; done=false; evidence=user-excluded]');
    expect(textOf(retained)).toContain('1 excluded historical/scope-change item(s) retained separately, outside the active denominator');
    expect(textOf(retained)).toContain('not independently verified completion');

    expect(prove('wfr_plan_weak_verification', 'plan-http-destination')).toBe('stored');
    const weakVerification = await send('wfr_plan_weak_verification', { plan: [], checklist: [{
      ...args.checklist[0], status: 'verified', evidence: ['worker report says done after source tests passed']
    }] });
    expect(failed(weakVerification)).toBe(true);
    expect(textOf(weakVerification)).toContain('Verification cannot rely');

    expect(prove('wfr_plan_test_only_verification', 'plan-http-destination')).toBe('stored');
    const testOnlyVerification = await send('wfr_plan_test_only_verification', { plan: [], checklist: [{
      id: 'unit-tests', requirement: 'Unit tests pass', source: 'User test-only acceptance',
      acceptance: 'Vitest regression tests pass EXIT0.', status: 'verified',
      evidence: ['source tests passed: npm test EXIT0 on Windows.']
    }] });
    expect(failed(testOnlyVerification)).toBe(false);
    expect(textOf(testOnlyVerification)).toContain('Agent-reported done=true: 1 / 2 active recorded requirements; done=false: 1');
    expect(textOf(testOnlyVerification)).toContain('unit-tests [verified; done=true; evidence=source-tested]');
  });

  it('validates the Codex statuses and enforces recording disable after discovery', async () => {
    ctx.sessionTools = true;
    ctx.caps = withCaps({ read: true, command: true });
    const declaration = toolList(await core('tools/list')).find(tool => tool.name === 'update_plan');
    const description = String(declaration?.description ?? '');
    expect(description).toContain('Stores this chat');
    expect(description).toContain('does not execute tasks or change automation');
    expect(description).not.toMatch(/(?:requires exact live|Use implemented|not completion|classifier|safety rules)/i);
    const commandDescription = String(toolList(await core('tools/list')).find(tool => tool.name === 'exec_command')?.description ?? '');
    expect(commandDescription).toContain('read or modify local files and start processes');
    expect(commandDescription).not.toMatch(/Windows safety rules|do not spawn|classifier|approve|ignore.*safety/i);
    expect(declaration?.inputSchema.required).toEqual(['plan']);
    expect(declaration?.inputSchema.additionalProperties).toBe(false);
    expect(failed(await core('tools/call', { name: 'update_plan', arguments: { plan: [
      { step: 'One', status: 'in_progress' }, { step: 'Two', status: 'in_progress' }
    ] } }))).toBe(true);
    ctx.sessionTools = false;
    const disabled = await core('tools/call', { name: 'update_plan', arguments: { plan: [] } });
    expect(failed(disabled)).toBe(true);
    expect(textOf(disabled)).toContain('Session recording');
  });
});

describe('exec sessions belong to the chat that opened them', () => {
  beforeEach(() => {
    ctx.readOnly = false;
    ctx.caps = withCaps({ command: true });
    // `session status` lists the running commands, which is the other place one chat could
    // learn another's session ids.
    ctx.sessionTools = true;
    // Ownership is process-global with no natural lifetime boundary, and clearing it can only
    // make the guard more permissive — never the other way round.
    resetExecOwnershipForTests();
  });

  /** What the page reports once it has seen this connector request leave a given chat. */
  const prove = (
    requestId: string,
    conversationId: string,
    sessionId = `session-${conversationId}`
  ) =>
    observeRequestCorrelation({
      requestId,
      conversationId,
      sessionId,
      messageId: `msg-${requestId}`,
      tool: 'exec_command',
      observedAt: Date.now()
    });

  /** A tools/call carrying the `x-request-id` ChatGPT sends, so the caller is identifiable. */
  const asChat = (requestId: string | null, name: string, args: Record<string, unknown>) =>
    modern(
      'tools/call',
      { name, arguments: args },
      requestId ? { 'x-request-id': `${requestId}/att1` } : {}
    );

  it('refuses write_stdin from a chat that does not own the session, and keeps serving the one that does', async () => {
    expect(prove('wfr_execown_opener', 'conv-execown-opener')).toBe('stored');
    expect(prove('wfr_execown_stranger', 'conv-execown-stranger')).toBe('stored');

    await fs.writeFile(
      path.join(approved, 'owned-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on('line',(line)=>{ console.log('echo='+line); if(line==='bye') rl.close(); });\n",
      'utf8'
    );

    const started = await asChat('wfr_execown_opener', 'exec_command', {
      cmd: 'node owned-stdin.cjs',
      workdir: '/workspace',
      tty: true,
      yield_time_ms: 25
    });
    expect(started.body.result?.isError).not.toBe(true);
    const sessionId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(sessionId)).toBe(true);

    // The other chat can name that small integer just as easily as its owner can. Codex never
    // has to think about this because its manager hangs off one conversation's services.
    const stranger = await asChat('wfr_execown_stranger', 'write_stdin', {
      session_id: sessionId,
      chars: 'stolen\r',
      yield_time_ms: 250
    });
    expect(stranger.body.result?.isError).toBe(true);
    expect(textOf(stranger)).toContain(`write_stdin failed for session ${sessionId}`);
    expect(textOf(stranger)).not.toContain('echo=stolen');
    expect(textOf(stranger)).toContain('This refusal concerns this process id, not Read-only mode');
    expect(textOf(stranger)).toContain('EXEC_SESSION_OWNER_MISMATCH');
    expect(textOf(stranger)).not.toContain('may already have delivered');

    // Caller identity is the authorization boundary. An unattributed call must not inherit
    // the owner's authority merely because it can guess the small numeric session id.
    const unproven = await asChat(null, 'write_stdin', {
      session_id: sessionId,
      chars: 'anon\r',
      yield_time_ms: 1_000
    });
    expect(unproven.body.result?.isError).toBe(true);
    expect(textOf(unproven)).toContain('exact chat ownership of this call or its launching request is not yet proven');
    expect(textOf(unproven)).not.toContain('echo=anon');
    expect(textOf(unproven)).toContain('This refusal concerns this process id, not Read-only mode');
    expect(textOf(unproven)).toContain('EXEC_CALLER_UNIDENTIFIED');
    expect(textOf(unproven)).toContain('retry this same session_id once');

    // The replacement session contract exposes recordings only; the removed status action no
    // longer gives either owner or stranger a side channel into the process manager. Terminal
    // ownership remains entirely on write_stdin, where both refusals above exercised it.
    const recordings = await asChat('wfr_execown_stranger', 'session', { action: 'search' });
    expect(recordings.body.result?.isError).not.toBe(true);
    expect(textOf(recordings)).not.toMatch(new RegExp(`^\\s*${sessionId}\\s+pid `, 'm'));

    const owner = await asChat('wfr_execown_opener', 'write_stdin', {
      session_id: sessionId,
      chars: 'bye\r',
      yield_time_ms: 5_000
    });
    expect(owner.body.result?.isError).not.toBe(true);
    expect(textOf(owner)).toContain('echo=bye');
    expect(textOf(owner)).toContain('Process exited with code 0');
  });

  it('distinguishes anonymous launch custody from an unavailable terminal and reports identity recovery', async () => {
    const source = await createSession({ conversationId: 'exec-return-owner' });
    expect(prove('wfr_exec_return_owner', 'exec-return-owner', source.id)).toBe('stored');
    noteExecOwner(987001, source.id);
    noteExecOwner(987002, null);
    try {
      const unknown = await asChat('wfr_exec_return_late', 'write_stdin', { session_id: 987001, chars: '' });
      expect(textOf(unknown)).toContain('EXEC_CALLER_UNIDENTIFIED');
      expect(prove('wfr_exec_return_late', 'exec-return-owner', source.id)).toBe('stored');
      const recovered = await asChat('wfr_exec_return_owner', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(recovered)).toContain('Earlier write_stdin calls were refused');
      expect(textOf(await asChat('wfr_exec_return_owner', 'read', { paths: ['/workspace/src/app.ts'] })))
        .not.toContain('Identity recovered');
      const anonymous = await asChat('wfr_exec_return_owner', 'write_stdin', { session_id: 987002, chars: '' });
      expect(textOf(anonymous)).toContain('EXEC_SESSION_ANONYMOUS');
      expect(textOf(anonymous)).toContain('cannot adopt');
      expect(textOf(anonymous)).not.toContain('retry this same');
      const absent = await asChat('wfr_exec_return_owner', 'write_stdin', { session_id: 987003, chars: '' });
      expect(textOf(absent)).toContain('EXEC_SESSION_UNAVAILABLE');
      expect(textOf(absent)).not.toContain('retry this same');
      expect(textOf(await asChat('wfr_exec_return_owner', 'read', { paths: ['/workspace/src/app.ts'] })))
        .not.toContain('Identity recovered');
    } finally {
      forgetExecOwner(987001);
      forgetExecOwner(987002);
    }
  });

  it('recovers the original first terminal after its exact launch proof arrives beyond the evidence grace', async () => {
    await fs.writeFile(
      path.join(approved, 'late-owner-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on('line',(line)=>{ console.log('late='+line); if(line==='done') rl.close(); });\n",
      'utf8'
    );
    const started = await asChat('wfr_execown_late_first', 'exec_command', {
      cmd: 'node late-owner-stdin.cjs', workdir: '/workspace', tty: true, yield_time_ms: 25
    });
    expect(failed(started), textOf(started)).toBe(false);
    const processId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(processId), textOf(started)).toBe(true);
    expect(execOwner(processId)).toBeNull();

    expect(prove('wfr_execown_late_other', 'conv-execown-late-other')).toBe('stored');
    const stranger = await asChat('wfr_execown_late_other', 'write_stdin', {
      session_id: processId, chars: 'stolen\r', yield_time_ms: 250
    });
    expect(failed(stranger), textOf(stranger)).toBe(true);
    expect(textOf(stranger)).toContain('EXEC_CALLER_UNIDENTIFIED');
    expect(textOf(stranger)).not.toContain('late=stolen');

    expect(prove('wfr_execown_late_first', 'conv-execown-late-first')).toBe('stored');
    expect(execOwner(processId)).toBe('session-conv-execown-late-first');
    const recovered = await asChat('wfr_execown_late_first', 'write_stdin', {
      session_id: processId, chars: 'done\r', yield_time_ms: 5_000
    });
    expect(failed(recovered), textOf(recovered)).toBe(false);
    expect(textOf(recovered)).toContain('late=done');
    expect(textOf(recovered)).toContain('Process exited with code 0');
    expect(textOf(recovered)).not.toContain('late=stolen');
  });

  it('keeps a live process with the durable session across Compact & Resume and retires A', async () => {
    const chatA = 'f0f00005-1111-4111-8111-111111111111';
    const chatB = 'f0f00006-1111-4111-8111-111111111111';
    const summary = await createSession({ title: 'exec continuation owner', conversationId: chatA });
    expect(prove('wfr_exec_resume_a', chatA, summary.id)).toBe('stored');

    await fs.writeFile(
      path.join(approved, 'resume-stdin.cjs'),
      "const readline=require('node:readline'); const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on('line',(line)=>{ console.log('continued='+line); if(line==='done') rl.close(); });\n",
      'utf8'
    );
    const started = await asChat('wfr_exec_resume_a', 'exec_command', {
      cmd: 'node resume-stdin.cjs',
      workdir: '/workspace',
      tty: true,
      yield_time_ms: 25
    });
    const processId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(processId), textOf(started)).toBe(true);
    expect(execOwner(processId)).toBe(summary.id);

    expect(await rebindSession(summary.id, chatA, chatB)).toBe(true);
    expect(prove('wfr_exec_resume_b', chatB, summary.id)).toBe('stored');

    const continued = await asChat('wfr_exec_resume_b', 'write_stdin', {
      session_id: processId,
      chars: 'done\r',
      yield_time_ms: 5_000
    });
    expect(failed(continued), textOf(continued)).toBe(false);
    expect(textOf(continued)).toContain('continued=done');

    const stale = await asChat('wfr_exec_resume_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(stale)).toBe(true);
    expect(textOf(stale)).toContain('CONVERSATION_SUPERSEDED');
    expect(textOf(stale)).toContain('no local tool was run');
    expect(textOf(stale)).toContain(`https://chatgpt.com/c/${chatB}`);
    expect(textOf(stale)).toContain('exec continuation owner');
  });

  it('refuses every tool from a chat whose handoff brief has been asked for, until the move is over', async () => {
    resetContinuationsForTests();
    const chatA = 'f0f00007-1111-4111-8111-111111111111';
    const chatB = 'f0f00008-1111-4111-8111-111111111111';
    const summary = await createSession({ title: 'compacting owner', conversationId: chatA });
    expect(prove('wfr_compact_a', chatA, summary.id)).toBe('stored');

    // A filed ticket alone changes nothing: the page may still be stopping the turn.
    const opened = await openContinuationNow(summary.id, chatA, true);
    const beforePrompt = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(beforePrompt), textOf(beforePrompt)).toBe(false);

    // The marked prompt is submitted. From here on the chat's calls are refused — whether the
    // turn Stop was clicked on really ended or, as on 2026-09-01, went on calling tools.
    expect((await beginContinuationSourceSendNow(opened.token))?.allowed).toBe(true);
    expect(await dispatchContinuationSourceSendNow(opened.token)).toBe(true);
    const duringHandoff = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(duringHandoff)).toBe(true);
    expect(textOf(duringHandoff)).toContain('COMPACTION_IN_PROGRESS');
    expect(textOf(duringHandoff)).toMatch(/no local tool was run/i);
    expect(textOf(duringHandoff)).toMatch(/write that brief now/i);

    // Still refused once the brief is stored and the replacement chat is on its way.
    await attachSummary(opened.token, 'SUMMARY\n'.repeat(40));
    const afterBrief = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(afterBrief)).toContain('COMPACTION_IN_PROGRESS');

    // The commit hands the refusal over to the superseded attachment for good.
    expect(await rebindSession(summary.id, chatA, chatB)).toBe(true);
    expect(prove('wfr_compact_b', chatB, summary.id)).toBe('stored');
    abortContinuation(opened.token, 'the test moved the session by hand');
    const stale = await asChat('wfr_compact_a', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(stale)).toBe(true);
    expect(textOf(stale)).toContain('CONVERSATION_SUPERSEDED');
    const fresh = await asChat('wfr_compact_b', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(failed(fresh), textOf(fresh)).toBe(false);
  });

  it('does not let a stale owner inherit a recycled process id during the new exec yield', async () => {
    // Model the real lifetime split directly: the manager has released an exited process id,
    // but the separate ownership registry still carries the chat that used to own it. Force
    // the next allocator pick to reuse that number so the race is deterministic instead of a
    // 1-in-99k lottery.
    await unifiedExecManager.terminateAllProcesses();
    const recycledId = 1_000;
    noteExecOwner(recycledId, 'session-conv-execown-old');
    expect(execOwner(recycledId)).toBe('session-conv-execown-old');
    expect(prove('wfr_execown_old_recycled', 'conv-execown-old')).toBe('stored');
    expect(prove('wfr_execown_new_recycled', 'conv-execown-new')).toBe('stored');

    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      // Block in the shell process itself. Spawning a second cold `node` here made this
      // ownership regression depend on hosted-runner process startup rather than on the
      // authority window it is meant to test. The shell is already the exec process and can
      // wait for one line of input without another child at all.
      const holdOpen = IS_WINDOWS
        ? "$line = [Console]::In.ReadLine(); Write-Output ('got=' + $line)"
        : "IFS= read -r line; printf 'got=%s\\n' \"$line\"";

      // Do not await. The process is registered while exec_command spends its initial yield
      // collecting output, which is the exact old authority window.
      const starting = asChat('wfr_execown_new_recycled', 'exec_command', {
        cmd: holdOpen,
        workdir: '/workspace',
        tty: true,
        yield_time_ms: 1_000
      });
      await vi.waitFor(
        () => {
          expect(unifiedExecManager.listProcesses().some((entry) => entry.processId === recycledId)).toBe(true);
        },
        { timeout: 5_000, interval: 10 }
      );

      // Allocation must have removed the stale principal before the new process became
      // writable. The old chat knows this integer from its own previous session, but it no
      // longer has authority over what now happens to occupy that slot.
      expect(execOwner(recycledId)).toBeNull();
      const stolen = await asChat('wfr_execown_old_recycled', 'write_stdin', {
        session_id: recycledId,
        chars: 'stolen\r',
        yield_time_ms: 50
      });
      expect(stolen.body.result?.isError).toBe(true);
      expect(textOf(stolen)).toContain('EXEC_SESSION_UNAVAILABLE');

      const started = await starting;
      expect(started.body.result?.isError, textOf(started)).not.toBe(true);
      expect(Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1])).toBe(recycledId);
      expect(execOwner(recycledId)).toBe('session-conv-execown-new');
      expect(textOf(started)).not.toContain('got=');

      // Let the real owner release the shell normally. Besides proving the new principal did
      // receive authority, this keeps cleanup deterministic instead of spending the process
      // manager's kill grace period on an intentionally blocked test process.
      const owner = await asChat('wfr_execown_new_recycled', 'write_stdin', {
        session_id: recycledId,
        chars: 'owner\r',
        yield_time_ms: 5_000
      });
      expect(owner.body.result?.isError, textOf(owner)).not.toBe(true);
      expect(textOf(owner)).toContain('got=owner');
      expect(textOf(owner)).toContain('Process exited with code 0');
    } finally {
      random.mockRestore();
      await unifiedExecManager.terminateAllProcesses();
      resetExecOwnershipForTests();
    }
  });

  it('delivers completed output on an ordinary same-request call without leaking it', async () => {
    expect(prove('wfr_background_owner', 'conv-background-owner')).toBe('stored');
    expect(prove('wfr_background_other', 'conv-background-other')).toBe('stored');
    const started = await asChat('wfr_background_owner', 'exec_command', {
      cmd: IS_WINDOWS
        ? "Start-Sleep -Milliseconds 650; Write-Output 'background-e2e-once'; exit 7"
        : "sleep 0.65; printf '%s\\n' background-e2e-once; exit 7",
      workdir: '/workspace',
      yield_time_ms: 250
    });
    expect(failed(started), textOf(started)).toBe(false);
    const sessionId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(sessionId)).toBe(true);

    const owned = new Set([sessionId]);
    await vi.waitFor(() => expect(unifiedExecManager.exitedUnread(owned)).toHaveLength(1), {
      timeout: 5_000,
      interval: 20
    });
    const exitCode = unifiedExecManager.exitedUnread(owned)[0]!.exitCode;
    expect(exitCode).toBe(7);
    expect(unifiedExecManager.exitedUnread(new Set())).toEqual([]);

    const stranger = await asChat('wfr_background_other', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(stranger)).not.toContain(`Background session ${sessionId}`);

    const later = await asChat('wfr_background_owner', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(later)).toContain(`Background session ${sessionId} completed`);
    expect(textOf(later)).toContain(`Exit code: ${exitCode}`);
    expect(textOf(later)).toContain('background-e2e-once');
    expect(textOf(later)).not.toContain(`write_stdin(session_id=${sessionId}`);

    // Publication receipts require a strictly later timestamp; loopback calls can
    // otherwise share one millisecond even though this response was already read.
    const receivedAt = Date.now();
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(receivedAt), { timeout: 1000, interval: 1 });
    const after = await asChat('wfr_background_owner', 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(after)).not.toContain(`Background session ${sessionId}`);
    expect(unifiedExecManager.exitedUnread(owned)).toEqual([]);
  });

  it('reoffers completed output after the real HTTP connection closes before publication', async () => {
    const requestId = 'wfr_background_disconnect';
    expect(prove(requestId, 'conv-background-disconnect')).toBe('stored');
    const started = await asChat(requestId, 'exec_command', {
      cmd: IS_WINDOWS ? "Start-Sleep -Milliseconds 650; Write-Output 'transport-replay'" : "sleep 0.65; echo transport-replay",
      workdir: '/workspace', yield_time_ms: 250
    });
    expect(failed(started), textOf(started)).toBe(false);
    const id = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(id), textOf(started)).toBe(true);
    // Match the adjacent real-process test's deadline: PowerShell startup competes with
    // native compilation in the full suite and is not bounded by this command's 650 ms sleep.
    await vi.waitFor(() => expect(unifiedExecManager.exitedUnread(new Set([id]))).toHaveLength(1), {
      timeout: 5_000, interval: 20
    });
    const offer = unifiedExecManager.offerCompletedOutput.bind(unifiedExecManager);
    let publication: Parameters<typeof offer>[1] | undefined;
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const spy = vi.spyOn(unifiedExecManager, 'offerCompletedOutput').mockImplementation(async (...args) => {
      const result = await offer(...args);
      publication = args[1];
      await gate;
      return result;
    });
    const controller = new AbortController();
    const aborted = fetch(endpoint.url, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': requestId },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } } })
    }).catch(() => null);
    try {
      await vi.waitFor(() => expect(publication).toBeDefined());
      controller.abort();
      await aborted;
      await vi.waitFor(() => expect(publication?.failed).toBe(true));
    } finally { unblock(); spy.mockRestore(); }
    const replay = await asChat(requestId, 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(replay)).toContain('transport-replay');
    expect(unifiedExecManager.exitedUnread(new Set([id]))).toHaveLength(1);
    // Publication receipts require the same strictly-later timestamp as the adjacent
    // ordinary-publication case. Under full-suite load this follow-up can otherwise begin in
    // the exact millisecond that the replay response completed and correctly remain unread.
    const replayReceivedAt = Date.now();
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(replayReceivedAt), { timeout: 1000, interval: 1 });
    const receipt = await asChat(requestId, 'read', { paths: ['/workspace/src/app.ts'] });
    expect(textOf(receipt)).not.toContain('transport-replay');
    expect(unifiedExecManager.exitedUnread(new Set([id]))).toEqual([]);
  });

  it('refuses new commands at the unread-result bound, delivers a result, then admits after automatic receipt', async () => {
    const conversationId = 'conv-background-admission';
    const sessionIds: number[] = [];

    for (let index = 0; index < MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION; index++) {
      const requestId = `wfr_background_admission_${index}`;
      expect(prove(requestId, conversationId)).toBe('stored');
      const started = await asChat(requestId, 'exec_command', {
        cmd: IS_WINDOWS
          ? `while (!(Test-Path './delivery-release')) { Start-Sleep -Milliseconds 30 }; Write-Output 'owed-${index}'; exit ${index + 1}`
          : `while [ ! -f ./delivery-release ]; do sleep 0.03; done; printf '%s\\n' owed-${index}; exit ${index + 1}`,
        workdir: '/workspace',
        yield_time_ms: 100
      });
      const sessionId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
      expect(Number.isInteger(sessionId), textOf(started)).toBe(true);
      sessionIds.push(sessionId);
    }

    await fs.writeFile(path.join(approved, 'delivery-release'), 'ready');
    await vi.waitFor(
      () => expect(backgroundExecObligations(`session-${conversationId}`).exitedUnread.map((row) => row.processId)).toEqual(
        [...sessionIds].sort((left, right) => left - right)
      ),
      { timeout: 8_000, interval: 25 }
    );

    const blockedRequest = 'wfr_background_admission_blocked';
    expect(prove(blockedRequest, conversationId)).toBe('stored');
    const blocked = await asChat(blockedRequest, 'exec_command', {
      cmd: IS_WINDOWS ? "Write-Output 'must-not-run'" : "printf '%s\\n' must-not-run",
      workdir: '/workspace'
    });
    expect(failed(blocked)).toBe(true);
    expect(textOf(blocked)).toContain('EXEC_RESULTS_UNREAD');
    for (const sessionId of sessionIds) expect(textOf(blocked)).toContain(String(sessionId));

    expect(textOf(blocked)).toMatch(/Background session \d+ completed/);
    expect(textOf(blocked)).toContain('owed-');

    let admitted = await asChat(blockedRequest, 'exec_command', {
      cmd: IS_WINDOWS ? "Write-Output 'admitted-after-drain'" : "printf '%s\\n' admitted-after-drain",
      workdir: '/workspace',
      yield_time_ms: 5_000
    });
    expect(failed(admitted), textOf(admitted)).toBe(false);
    // Admission is the contract under test. A loaded Windows host can spend the whole initial
    // yield launching PowerShell, so collect the admitted session normally instead of treating
    // a valid running response as if the command had been refused.
    let admittedText = textOf(admitted);
    const admittedSessionId = Number(admittedText.match(/Process running with session ID (\d+)/)?.[1]);
    if (!admittedText.includes('admitted-after-drain') && Number.isInteger(admittedSessionId)) {
      const deadline = Date.now() + 15_000;
      while (!admittedText.includes('admitted-after-drain') && Date.now() < deadline) {
        admitted = await asChat(blockedRequest, 'write_stdin', { session_id: admittedSessionId, chars: '' });
        admittedText += `\n${textOf(admitted)}`;
        if (!textOf(admitted).includes(`Process running with session ID ${admittedSessionId}`)) break;
      }
    }
    expect(admittedText).toContain('admitted-after-drain');

    for (const sessionId of sessionIds.slice(1)) {
      await asChat(blockedRequest, 'write_stdin', { session_id: sessionId, chars: '' });
    }
    await fs.unlink(path.join(approved, 'delivery-release'));
  });

  it('pings a live session left unpolled once, without blocking work or reaching another chat', async () => {
    expect(prove('wfr_background_unattended', 'conv-background-unattended')).toBe('stored');
    expect(prove('wfr_background_stranger', 'conv-background-stranger')).toBe('stored');
    const started = await asChat('wfr_background_unattended', 'exec_command', {
      cmd: IS_WINDOWS ? 'Start-Sleep -Seconds 30' : 'sleep 30',
      workdir: '/workspace',
      yield_time_ms: 250
    });
    const sessionId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(sessionId), textOf(started)).toBe(true);

    try {
      // Inside the threshold a live session is just work in progress, and says nothing.
      const quiet = await asChat('wfr_background_unattended', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(quiet)).not.toContain(`Background session ${sessionId}`);

      backdateExecAttendanceForTests(sessionId, UNATTENDED_EXEC_NOTICE_MS + 60_000);

      const stranger = await asChat('wfr_background_stranger', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(stranger)).not.toContain(`Background session ${sessionId}`);

      const pinged = await asChat('wfr_background_unattended', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(pinged)).toContain(`Background session ${sessionId} has been running unpolled for 3m`);
      expect(textOf(pinged)).toContain(`write_stdin(session_id=${sessionId}, chars="")`);

      // A published reminder is suppressed until attendance starts a new idle span.
      expect(prove('wfr_background_unattended_next', 'conv-background-unattended')).toBe('stored');
      const again = await asChat('wfr_background_unattended_next', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(again)).not.toContain(`Background session ${sessionId}`);

      // A reminder is not admission pressure. The session it names may be the point of the turn,
      // so unlike a completed unread result it never spends the exec_command budget.
      const admitted = await asChat('wfr_background_unattended', 'exec_command', {
        cmd: IS_WINDOWS ? "Write-Output 'still-admitted'" : "printf '%s\n' still-admitted",
        workdir: '/workspace',
        yield_time_ms: 5_000
      });
      expect(failed(admitted), textOf(admitted)).toBe(false);
      expect(textOf(admitted)).toContain('still-admitted');
    } finally {
      await unifiedExecManager.terminateProcess(sessionId);
    }
  });

  it('restarts the unattended clock when the owner polls, rather than reminding it of what it just did', async () => {
    expect(prove('wfr_background_attended', 'conv-background-attended')).toBe('stored');
    const started = await asChat('wfr_background_attended', 'exec_command', {
      cmd: IS_WINDOWS
        ? "while ($true) { Write-Output 'tick'; Start-Sleep -Milliseconds 200 }"
        : "while true; do printf '%s\n' tick; sleep 0.2; done",
      workdir: '/workspace',
      yield_time_ms: 250
    });
    const sessionId = Number(textOf(started).match(/Process running with session ID (\d+)/)?.[1]);
    expect(Number.isInteger(sessionId), textOf(started)).toBe(true);

    try {
      backdateExecAttendanceForTests(sessionId, UNATTENDED_EXEC_NOTICE_MS + 60_000);
      const polled = await asChat('wfr_background_attended', 'write_stdin', {
        session_id: sessionId,
        chars: ''
      });
      expect(failed(polled), textOf(polled)).toBe(false);
      expect(textOf(polled)).toContain('tick');
      // The mark lands before the wait, so the poll cannot report the session it is attending.
      expect(textOf(polled)).not.toContain('has been running unpolled');

      const after = await asChat('wfr_background_attended', 'read', { paths: ['/workspace/src/app.ts'] });
      expect(textOf(after)).not.toContain(`Background session ${sessionId}`);
    } finally {
      await unifiedExecManager.terminateProcess(sessionId);
    }
  });
});

describe('the outcome a shell command is recorded with', () => {
  /** Runs `noteExec` the way a tool does, and reports what the recorder would store. */
  const outcomeOf = (
    result: { exitCode: number | null; timedOut?: boolean },
    preset: ToolOutcome | null = null
  ) => {
    const context: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: null, conversationId: null },
      outcome: preset,
      evidence: emptyEvidence()
    };
    runInCallContext(context, () => noteExec(result));
    // Nothing set means the dispatcher's fallback applies, and for a non-error tool result
    // that fallback is `ok` — which is exactly the bug this covers.
    return context.outcome ?? 'ok';
  };

  it('calls a completed non-zero exit the child’s own failure, not a success', () => {
    expect(outcomeOf({ exitCode: 1 })).toBe('process_exit_nonzero');
    expect(outcomeOf({ exitCode: 3 })).toBe('process_exit_nonzero');
  });

  it('leaves a clean exit and a still-running process alone', () => {
    expect(outcomeOf({ exitCode: 0 })).toBe('ok');
    // Still running: it has not failed yet, and saying it did would be a lie about a
    // dev server that is doing exactly what was asked of it.
    expect(outcomeOf({ exitCode: null })).toBe('ok');
  });

  it('blames this connector for a timeout, not the child', () => {
    expect(outcomeOf({ exitCode: null, timedOut: true })).toBe('tool_internal_error');
    expect(outcomeOf({ exitCode: 1, timedOut: true })).toBe('tool_internal_error');
  });

  it('never overwrites an outcome the tool layer set deliberately', () => {
    expect(outcomeOf({ exitCode: 1 }, 'tool_rejected')).toBe('tool_rejected');
  });

  it('does not let the guard downgrade a command error back to ok', () => {
    const context: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: null, conversationId: null },
      outcome: null,
      evidence: emptyEvidence()
    };
    runInCallContext(context, () => {
      noteExec({ exitCode: 7 });
      // This is what guard() does when the tool returns a normal ToolResult whose text says
      // the child exited non-zero. The more specific process outcome must survive it.
      noteOutcome('ok');
    });
    expect(context.outcome).toBe('process_exit_nonzero');
  });
});


/**
 * The user's own stop for a ChatGPT turn the page will not stop.
 *
 * The property under test is not "a flag is read" but the whole join: a block is stored against
 * a *conversation*, and the thing arriving over HTTP is a *request id*, so every assertion here
 * goes through the same exact ownership proof the connector uses in production. The two failure
 * directions matter equally — a block that does not reach the rogue chat is useless, and a block
 * that reaches anyone else is worse than useless.
 */
describe('blocked chats', () => {
  const ROGUE = 'conv-blocked-rogue';
  const BYSTANDER = 'conv-innocent-bystander';
  let proofSeq = 0;

  /** Proves one request id belongs to a chat, exactly as the page evidence path would. */
  const owned = (conversationId: string): string => {
    const requestId = `wfr_block_${++proofSeq}`;
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId,
        sessionId: 'session-blocked-chats',
        messageId: `message-block-${proofSeq}`,
        tool: 'read',
        observedAt: Date.now()
      })
    ).toBe('stored');
    return requestId;
  };

  /**
   * The same proof, deliberately late: the page reporting *after* the call has already landed.
   *
   * This is the ordinary order, not an exotic one. A turn's first call races its own evidence,
   * and the wedged page this feature exists for is the slowest reporter there is. The recorder
   * has always waited for exactly this and filed the call under the chat it proves, which is why
   * a blocked chat could be seen running tools in its own timeline.
   */
  const provenLate = (conversationId: string, afterMs: number): string => {
    const seq = ++proofSeq;
    const requestId = `wfr_block_late_${seq}`;
    setTimeout(() => {
      observeRequestCorrelation({
        requestId,
        conversationId,
        sessionId: 'session-blocked-chats',
        messageId: `message-block-${seq}`,
        tool: 'read',
        observedAt: Date.now()
      });
    }, afterMs).unref?.();
    return requestId;
  };

  const readAs = (requestId: string | null, virtualPath = '/workspace/notes.txt'): Promise<any> =>
    modern(
      'tools/call',
      { name: 'read', arguments: { paths: [virtualPath] } },
      requestId ? { 'x-request-id': `${requestId}/att1` } : {}
    );

  beforeEach(() => resetBlockedChatsForTests());
  afterAll(() => resetBlockedChatsForTests());

  it('refuses a blocked chat’s call and tells the model to stop instead of retrying', async () => {
    setChatBlocked(ROGUE, true);
    const reply = await readAs(owned(ROGUE));
    const text = textOf(reply);

    expect(failed(reply)).toBe(true);
    expect(text).toContain('CHAT_BLOCKED');
    // The refusal has to end the turn, so it must forbid the retry loop a bare error invites
    // and name the one action that finishes.
    expect(text).toMatch(/no further tool calls/i);
    expect(text).toMatch(/final answer/i);
    // And no work may have happened behind it: the refusal is the whole result.
    expect(text).not.toContain('/workspace/notes.txt');
  });

  it('blocks every tool the chat has, not only the one it was blocked during', async () => {
    ctx.caps = withCaps({ command: true, create: true, edit: true });
    ctx.readOnly = false;
    setChatBlocked(ROGUE, true);

    for (const call of [
      { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } },
      { name: 'exec_command', arguments: { cmd: 'echo rogue', workdir: '/workspace' } },
      { name: 'apply_patch', arguments: { patch: addPatch('/workspace/blocked.txt', ['nope']) } }
    ]) {
      const reply = await modern('tools/call', call, { 'x-request-id': `${owned(ROGUE)}/att1` });
      expect(textOf(reply), call.name).toContain('CHAT_BLOCKED');
    }
    // apply_patch was refused before it ran, not after it wrote.
    await expect(fs.access(path.join(approved, 'blocked.txt'))).rejects.toThrow();
  });

  it('never touches another chat, or a call it cannot place at all', async () => {
    setChatBlocked(ROGUE, true);

    const other = await readAs(owned(BYSTANDER));
    expect(failed(other)).toBe(false);
    expect(textOf(other)).toContain('/workspace/notes.txt');

    // No proof, no conversation, no block. Refusing here would punish an unrelated chat — or
    // a phone — for a turn this app cannot even show was theirs.
    const unproven = await readAs(null);
    expect(failed(unproven)).toBe(false);
    expect(textOf(unproven)).toContain('/workspace/notes.txt');
  });

  it('refuses the call whose page evidence proves the blocked chat only after it arrives', async () => {
    setChatBlocked(ROGUE, true);

    const reply = await readAs(provenLate(ROGUE, 40));

    expect(failed(reply)).toBe(true);
    expect(textOf(reply)).toContain('CHAT_BLOCKED');
    // The point of the whole gate: the file was never read, so there is nothing to file under
    // the blocked chat's timeline afterwards.
    expect(textOf(reply)).not.toContain('/workspace/notes.txt');
  });

  it('still lets a call through when the page never proves it at all', async () => {
    setChatBlocked(ROGUE, true);

    // The wait is bounded by the same window attribution uses, and it ends the same way:
    // unproven is unproven. A phone, or a chat with no extension behind it, is not the rogue
    // turn and is not refused for failing to prove it is not.
    const reply = await readAs('wfr_block_never_proven');

    expect(failed(reply)).toBe(false);
    expect(textOf(reply)).toContain('/workspace/notes.txt');
  });

  it('gives the chat its tools back the moment it is released, same request id and all', async () => {
    const requestId = owned(ROGUE);
    setChatBlocked(ROGUE, true);
    expect(textOf(await readAs(requestId))).toContain('CHAT_BLOCKED');

    setChatBlocked(ROGUE, false);
    const after = await readAs(requestId);
    expect(failed(after)).toBe(false);
    expect(textOf(after)).toContain('/workspace/notes.txt');
  });
});


describe('persistent external endpoint', () => {
  const context = () => ({ roots: [], caps: { ...DEFAULT_CAPABILITIES }, readOnly: true, privacyScreenshots: false });
  const tokens = () => Object.fromEntries(['core', 'desktop', 'plugins'].map(id => [id, randomBytes(32).toString('base64url')]));

  it('proves every exact MCP path without dispatch, native request clocks or ingress evidence', async () => {
    const a = await startMcpServer(context);
    const toolClock = lastToolCallAt();
    try {
      for (const id of publishedSurfaceIds()) {
        const url = new URL(a.urls[id]);
        const challenge = randomBytes(32).toString('hex');
        const headers = { 'x-local-tunnel-challenge': challenge, 'x-request-id': 'external-proof-' + id };
        const result = await rawGet(url.toString(), headers);
        expect(result.status).toBe(204);
        expect(result.headers['cache-control']).toBe('no-store');
        expect(a.externalRouteProof!(url.pathname, challenge, String(result.headers['x-local-tunnel-proof']))).toBe(true);
        expect(result.headers['x-local-tunnel-request-id-digest']).toBe(
          createHash('sha256').update('external-proof-' + id).digest('hex')
        );
        const noIdentity = await rawGet(url.toString(), { 'x-local-tunnel-challenge': challenge });
        expect(noIdentity.status).toBe(204);
        expect(noIdentity.headers['x-local-tunnel-request-id-digest']).toBeUndefined();
        expect(lastRequestAt()).toBeNull();
        expect(lastRequestAt(id)).toBeNull();
        expect(lastToolCallAt()).toBe(toolClock);
        expect(recentMcpIngress(id, 0).records).toEqual([]);
        for (const extra of [{ Host: 'foreign.example.com' }, { Origin: 'https://foreign.example.com' }] as Record<string, string>[]) {
          const rejected = await rawGet(url.toString(), { ...headers, ...extra });
          expect(rejected.status).toBeGreaterThanOrEqual(400);
          expect(rejected.headers['x-local-tunnel-proof']).toBeUndefined();
          expect(rejected.headers['x-local-tunnel-request-id-digest']).toBeUndefined();
        }
        const wrongPath = await rawGet(url + '/extra', headers);
        expect(wrongPath.status).toBe(404);
        expect(wrongPath.headers['x-local-tunnel-proof']).toBeUndefined();
        for (const value of ['', 'x'.repeat(64), challenge.toUpperCase(), `${challenge},${challenge}`]) {
          const malformed = await rawGet(url.toString(), { 'x-local-tunnel-challenge': value });
          expect(malformed.status).toBe(400);
          expect(malformed.headers['x-local-tunnel-proof']).toBeUndefined();
        }
        const post = await rawPost(url.toString(), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), headers);
        expect(post.status).toBe(400);
        expect(lastRequestAt()).toBeNull();
        expect(recentMcpIngress(id, 0).records).toEqual([]);
      }
    } finally { await a.stop(); }
  });

  it('proves empty exact MCP POST transport without dispatch and refuses body-bearing proof requests', async () => {
    const a = await startMcpServer(context);
    const toolClock = lastToolCallAt();
    try {
      for (const id of publishedSurfaceIds()) {
        const url = new URL(a.urls[id]);
        const challenge = randomBytes(32).toString('hex');
        const headers = { 'x-local-tunnel-challenge': challenge, 'x-request-id': 'external-post-proof-' + id };
        const result = await rawPost(url.toString(), '', headers);
        expect(result.status).toBe(204);
        expect(result.text).toBe('');
        expect(result.headers['cache-control']).toBe('no-store');
        expect(a.externalRouteProof!(url.pathname, challenge, String(result.headers['x-local-tunnel-proof']))).toBe(true);
        expect(result.headers['x-local-tunnel-request-id-digest']).toBe(createHash('sha256').update('external-post-proof-' + id).digest('hex'));
        const noIdentity = await rawPost(url.toString(), '', { 'x-local-tunnel-challenge': challenge });
        expect(noIdentity.status).toBe(204);
        expect(noIdentity.headers['x-local-tunnel-request-id-digest']).toBeUndefined();
        for (const body of [' ', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })]) {
          const rejected = await rawPost(url.toString(), body, headers);
          expect(rejected.status).toBe(400);
          expect(rejected.headers['x-local-tunnel-proof']).toBeUndefined();
          expect(rejected.headers['x-local-tunnel-request-id-digest']).toBeUndefined();
        }
        // Exercise actual chunked framing, including a zero-byte stream: neither is
        // an empty framed proof, and no JSON can fall through to the MCP adapter.
        for (const body of ['', 'x']) {
          const chunked = await new Promise<RawResponse>((resolve, reject) => {
            const request = http.request(url, { method: 'POST', headers: { ...headers, 'transfer-encoding': 'chunked' } }, response => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => chunks.push(chunk));
              response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString() }));
            });
            request.on('error', reject);
            request.end(body);
          });
          expect(chunked.status).toBe(400);
          expect(chunked.headers['x-local-tunnel-proof']).toBeUndefined();
          expect(chunked.headers['x-local-tunnel-request-id-digest']).toBeUndefined();
        }
        for (const extra of [{ Host: 'foreign.example.com' }, { Origin: 'https://foreign.example.com' }] as Record<string, string>[]) {
          const rejected = await rawPost(url.toString(), '', { ...headers, ...extra });
          expect(rejected.status).toBeGreaterThanOrEqual(400);
          expect(rejected.headers['x-local-tunnel-proof']).toBeUndefined();
        }
        for (const value of ['', 'x'.repeat(64), challenge.toUpperCase(), `${challenge},${challenge}`]) {
          const malformed = await rawPost(url.toString(), '', { ...headers, 'x-local-tunnel-challenge': value });
          expect(malformed.status).toBe(400);
          expect(malformed.headers['x-local-tunnel-proof']).toBeUndefined();
        }
        const query = await rawPost(url + '?diagnostic=1', '', headers);
        expect(query.status).toBe(400);
        expect(query.headers['x-local-tunnel-proof']).toBeUndefined();
        const wrongPath = await rawPost(url + '/extra', '', headers);
        expect(wrongPath.status).toBe(404);
        expect(wrongPath.headers['x-local-tunnel-proof']).toBeUndefined();
        expect(lastRequestAt()).toBeNull();
        expect(lastRequestAt(id)).toBeNull();
        expect(lastToolCallAt()).toBe(toolClock);
        expect(recentMcpIngress(id, 0).records).toEqual([]);
      }
    } finally { await a.stop(); }
  });

  it.each(['core', 'plugins'] as const)('withholds %s when metadata reaches this server but MCP reaches a foreign listener', async surface => {
    const authority = tokens();
    const initial = await startMcpServer(context); const port = initial.port; await initial.stop();
    const a = await startMcpServer(context, { port, surfaceTokens: authority });
    const peer = await startMcpServer(context); const peerPort = peer.port; await peer.stop();
    const b = await startMcpServer(context, { port: peerPort, surfaceTokens: authority });
    const nativeFetch = fetch;
    let tunnel: TunnelHandle | undefined;
    try {
      vi.stubGlobal('fetch', (url: string, options: RequestInit) => {
        const pathname = new URL(url).pathname;
        const destination = pathname.startsWith('/.well-known/') ? a : b;
        return nativeFetch(new URL(destination.url).origin + pathname, options);
      });
      let settle!: (report: unknown) => void;
      const result = new Promise(resolve => { settle = resolve; });
      tunnel = await startTunnel({ localUrl: a.urls[surface], settings: { ...defaultConfig().tunnel,
        kind: 'manual', manualPublicOrigin: 'https://Delta.example.com' }, apiKey: null, externalRouteProof: a.externalRouteProof,
        report: report => { if (report.state !== 'connecting-tunnel') settle(report); } });
      expect(await result).toMatchObject({ state: 'tunnel-unavailable', publicUrl: null });
      expect(lastRequestAt()).toBeNull(); expect(recentMcpIngress(surface, 0).records).toEqual([]);
    } finally { await tunnel?.stop(); vi.unstubAllGlobals(); await b.stop(); await a.stop(); }
  });

  it('verifies an actual forwarded current-server response and refuses another server at the same secret path', async () => {
    const authority = tokens();
    const first = await startMcpServer(context);
    const port = first.port; await first.stop();
    const a = await startMcpServer(context, { port, surfaceTokens: authority });
    const peer = await startMcpServer(context);
    const peerPort = peer.port; await peer.stop();
    const b = await startMcpServer(context, { port: peerPort, surfaceTokens: authority });
    const nativeFetch = fetch;
    let destination = a;
    let tunnel: TunnelHandle | undefined;
    try {
      vi.stubGlobal('fetch', (url: string, options: RequestInit) => nativeFetch(new URL(url).pathname.replace(/^/, new URL(destination.url).origin), options));
      const settings = { ...defaultConfig().tunnel, kind: 'manual' as const, manualPublicOrigin: 'https://Delta.example.com' };
      const inspect = async () => {
        let settle!: (state: string) => void;
        const finished = new Promise<string>(resolve => { settle = resolve; });
        tunnel = await startTunnel({ localUrl: a.url, settings, apiKey: null, externalRouteProof: a.externalRouteProof,
          report: report => { if (report.state !== 'connecting-tunnel') settle(report.state); } });
        const state = await finished;
        await tunnel.stop(); tunnel = undefined;
        return state;
      };
      expect(await inspect()).toBe('connected');
      destination = b;
      expect(await inspect()).toBe('tunnel-unavailable');
      expect(lastRequestAt()).toBeNull();
    } finally { await tunnel?.stop(); vi.unstubAllGlobals(); await b.stop(); await a.stop(); }
  });

  it('keeps the exact port and surface paths across a real stop/start and fails closed on port collision', async () => {
    const first = await startMcpServer(context);
    const port = first.port;
    await first.stop();
    const surfaceTokens = tokens();
    const a = await startMcpServer(context, { port, surfaceTokens });
    try {
      expect(a.port).toBe(port);
      for (const id of publishedSurfaceIds()) expect(new URL(a.urls[id]).pathname).toBe(`/mcp/${id}/${surfaceTokens[id]}`);
      await expect(startMcpServer(context, { port, surfaceTokens: tokens() })).rejects.toThrow(/already in use/);
      const saved = { ...a.urls };
      await a.stop();
      const b = await startMcpServer(context, { port, surfaceTokens });
      try { expect(b.urls).toEqual(saved); } finally { await b.stop(); }
    } finally { await a.stop(); }
  });

  it('proves only the current secret metadata path through validated Host/Origin and excludes probes from activity', async () => {
    const initial = await startMcpServer(context);
    const port = initial.port;
    await initial.stop();
    const surfaceTokens = tokens();
    const a = await startMcpServer(context, { port, surfaceTokens });
    try {
      const metadata = new URL(a.url);
      metadata.pathname = `/.well-known/oauth-protected-resource${metadata.pathname}`;
      const challenge = randomBytes(32).toString('hex');
      // This test deliberately replaces the listener on the same port; do not let the
      // test client's old keep-alive socket masquerade as the newly started listener.
      const headers: Record<string, string> = { 'x-local-tunnel-challenge': challenge, connection: 'close', ...tunnelProbeHeaders() };
      const response = await fetch(metadata, { headers });
      expect(response.status).toBe(200);
      const proof = response.headers.get('x-local-tunnel-proof');
      expect(proof).not.toBe(headers['x-local-tunnel-probe']);
      expect(proof).not.toBe(challenge);
      expect(proof).toMatch(/^[a-f0-9]{64}$/);
      expect(a.externalRouteProof!(metadata.pathname, challenge, proof)).toBe(true);
      expect(a.externalRouteProof!(metadata.pathname, randomBytes(32).toString('hex'), proof)).toBe(false);
      expect(a.externalRouteProof!(metadata.pathname.replace('/core/', '/desktop/'), challenge, proof)).toBe(false);
      for (const value of [null, '', proof!.toUpperCase(), `${proof},${proof}`, 'f'.repeat(65)])
        expect(a.externalRouteProof!(metadata.pathname, challenge, value)).toBe(false);
      expect(lastRequestAt()).toBeNull();
      await response.body?.cancel();
      const foreign = await rawGet(metadata.toString(), { ...headers, Host: 'other.example.com' });
      expect(foreign.status).toBeGreaterThanOrEqual(400);
      expect(foreign.headers['x-local-tunnel-proof']).toBeUndefined();
      const browser = await rawGet(metadata.toString(), { ...headers, Origin: 'https://other.example.com' });
      expect(browser.status).toBeGreaterThanOrEqual(400);
      expect(browser.headers['x-local-tunnel-proof']).toBeUndefined();
      for (const value of ['', 'x'.repeat(64), challenge.toUpperCase(), `${challenge},${challenge}`, 'a'.repeat(65)]) {
        const malformed = await rawGet(metadata.toString(), { 'x-local-tunnel-challenge': value });
        expect(malformed.headers['x-local-tunnel-proof']).toBeUndefined();
      }
      const wrongPath = await rawGet(`${metadata}/extra`, { 'x-local-tunnel-challenge': challenge });
      expect(wrongPath.status).toBe(404);
      expect(wrongPath.headers['x-local-tunnel-proof']).toBeUndefined();
      await a.stop();
      expect(a.externalRouteProof!(metadata.pathname, challenge, proof)).toBe(false);
      const b = await startMcpServer(context, { port, surfaceTokens });
      try {
        const stale = await fetch(metadata, { headers });
        const currentProof = stale.headers.get('x-local-tunnel-proof');
        expect(currentProof).not.toBe(proof);
        expect(b.externalRouteProof!(metadata.pathname, challenge, proof)).toBe(false);
        expect(b.externalRouteProof!(metadata.pathname, challenge, currentProof)).toBe(true);
        await stale.body?.cancel();
        const other = await startMcpServer(context);
        try {
          const otherMetadata = new URL(other.url);
          otherMetadata.pathname = `/.well-known/oauth-protected-resource${otherMetadata.pathname}`;
          const wrongAccount = await rawGet(otherMetadata.toString(), { 'x-local-tunnel-challenge': challenge });
          expect(b.externalRouteProof!(metadata.pathname, challenge, String(wrongAccount.headers['x-local-tunnel-proof']))).toBe(false);
        } finally { await other.stop(); }
      } finally { await b.stop(); }
    } finally { await a.stop(); }
  });

  it('never logs token fragments from malformed or unmatched MCP and metadata paths', async () => {
    const a = await startMcpServer(context);
    const observed: string[] = [];
    const unsubscribe = onLog(entry => { observed.push(entry.message); });
    try {
      const url = new URL(a.url);
      const token = url.pathname.split('/').at(-1)!;
      for (const requestPath of [url.pathname + '/', url.pathname + '/extra', url.pathname + '%2fextra',
        '/.well-known/oauth-protected-resource' + url.pathname + '/',
        '/.well-known/oauth-protected-resource' + url.pathname + '/extra',
        '/mcp%2fcore/' + token + '/extra', '/MCP/core/' + token + '/extra']) {
        const result = await rawGet(url.origin + requestPath);
        expect(result.status).toBe(404);
      }
      const messages = observed.join('\n');
      expect(messages).toContain('404');
      expect(messages).not.toContain(token.slice(0, 12));
    } finally { unsubscribe(); await a.stop(); }
  });

  it('refuses missing, invalid or duplicated persistent surface authority', async () => {
    const values = tokens();
    for (const surfaceTokens of [{}, { ...values, core: 'short' }, { ...values, plugins: values.core }]) {
      await expect(startMcpServer(context, { port: 9765, surfaceTokens })).rejects.toThrow(/persistent endpoint/);
    }
  });
});

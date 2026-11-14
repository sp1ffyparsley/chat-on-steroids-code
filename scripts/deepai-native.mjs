import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

// Paired local-client credentials only. Never read the upstream DeepAI account key.
const baseDir = process.env.COS_DEEPAI_HOME || path.join(homedir(), '.deepai-code');
const desktop = process.env.COS_DEEPAI_DESKTOP_EXE || path.join(homedir(), 'AppData', 'Local', 'Programs', 'deepai-code-desktop', 'DeepAI Code.exe');
const serverEntry = path.join(path.dirname(desktop), 'resources', 'server.asar', 'apps', 'server', 'dist', 'bin.mjs');
// Reviewed native releases only: a shared protocol number is not blanket permission
// to accept future server versions. Keep transport, custody and model checks unchanged.
const SERVER_VERSIONS = new Set(['0.3.36', '0.3.37']);
const PROTOCOL_VERSION = 2;
const SCOPES = ['orchestration:read', 'orchestration:operate'];
const MAX_BYTES = 8 * 1024 * 1024;
const READ_RPC = new Set(['server.probe', 'server.getConfig', 'orchestration.getThreadProjection',
  'orchestration.getArchivedShellSnapshot']);
const MESSAGES = {
  NATIVE_RUNTIME_UNAVAILABLE: 'Cannot read the installed DeepAI runtime descriptor.',
  NATIVE_LOOPBACK_REQUIRED: 'DeepAI requests must stay on the discovered HTTP 127.0.0.1 origin.',
  NATIVE_VERSION_UNSUPPORTED: 'DeepAI requires verified server version 0.3.36 or 0.3.37 and orchestration protocol 2.',
  NATIVE_AUTH_ISSUE_FAILED: 'Could not issue a scoped local DeepAI client credential.',
  NATIVE_AUTH_INVALID: 'The local credential response has invalid identity, scopes or expiration.',
  NATIVE_CREDENTIAL_EXPIRED: 'The local credential expired. Reconnect, then inspect existing work before resubmission.',
  NATIVE_CLIENT_CLOSED: 'The native client is closed. Inspect accepted work before resubmission.',
  NATIVE_REQUEST_INVALID: 'Invalid native request, headers or timeout. Nothing was dispatched.',
  NATIVE_HTTP_FAILED: 'The native HTTP request failed. Inspect existing work before resubmitting a mutation.',
  NATIVE_HTTP_STATUS: 'The native HTTP server returned an error status.',
  NATIVE_RESPONSE_INVALID: 'The native response was invalid or exceeded the bounded response size.',
  NATIVE_SOCKET_UNAVAILABLE: 'The native WebSocket is unavailable. Reconnect and inspect existing work.',
  NATIVE_SOCKET_OPEN_FAILED: 'The native WebSocket could not open within its connection deadline.',
  NATIVE_SOCKET_CLOSED: 'The native WebSocket closed. Inspect accepted work before resubmission.',
  NATIVE_SOCKET_ERROR: 'The native WebSocket failed. Inspect accepted work before resubmission.',
  NATIVE_RPC_TIMEOUT: 'The native request timed out. A submitted mutation may have completed; inspect it before retrying.',
  NATIVE_RPC_WRITE_FAILED: 'The native transport write failed. A submitted mutation may have completed; inspect it before retrying.',
  NATIVE_RPC_FAILED: 'The native server returned a failed request. Inspect its task status; no automatic retry was made.',
  NATIVE_PROTOCOL_ERROR: 'The native server returned an invalid protocol frame. Inspect submitted work before retrying.',
  FREE_MODEL_UNAVAILABLE: 'The enabled, installed DeepAI provider must be ready and expose the exact non-custom zero-Theos model with thinking=high. No fallback is allowed.'
};

export class NativeClientError extends Error {
  constructor(code, acceptance = 'not_sent', requestId = undefined, httpStatus = undefined) {
    super(MESSAGES[code] || 'The native client failed.');
    this.name = 'NativeClientError';
    this.code = code;
    this.acceptance = acceptance;
    this.ambiguous = acceptance === 'unknown';
    if (requestId) this.requestId = requestId;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

async function nativeCommand(args) {
  return new Promise((resolve, reject) => {
    const child = execFile(desktop, [serverEntry, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', T3CODE_HOME: baseDir },
      encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end();
  });
}

function parseOrigin(runtime) {
  let url;
  try { url = new URL(runtime?.origin); } catch { throw new NativeClientError('NATIVE_LOOPBACK_REQUIRED'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new NativeClientError('NATIVE_LOOPBACK_REQUIRED');
  return url.origin;
}

function requestUrl(route, origin) {
  let url;
  try { url = new URL(route, origin); } catch { throw new NativeClientError('NATIVE_LOOPBACK_REQUIRED'); }
  if (typeof route !== 'string' || route.includes('\\') || url.origin !== origin || url.username ||
      url.password || url.hash || !url.pathname.startsWith('/api/'))
    throw new NativeClientError('NATIVE_LOOPBACK_REQUIRED');
  return url;
}

function timeoutValue(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new NativeClientError('NATIVE_REQUEST_INVALID');
  return value;
}

function expiration(value) {
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value))
    return Date.parse(value);
  if (typeof value === 'string' && /^\d{10}(?:\.\d+)?$|^\d{13}$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value)
    ? (value < 100_000_000_000 ? value * 1000 : value) : NaN;
}

function redact(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets) value = value.split(secret).join('[redacted]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), redact(item, secrets)]));
  return value;
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new NativeClientError('NATIVE_RESPONSE_INVALID');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw new NativeClientError('NATIVE_RESPONSE_INVALID');
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Exact native catalog selection; free access never licenses a paid or substitute model. */
export function assertFreeModel(config, modelSlug = 'deepai/glm-5.3-flash') {
  const providers = Array.isArray(config?.providers) ? config.providers : Object.values(config?.providers || {});
  const matches = providers.filter(item => item?.instanceId === 'deepai');
  const provider = matches.length === 1 ? matches[0] : null;
  const models = Array.isArray(provider?.models) ? provider.models.filter(model => model?.slug === modelSlug) : [];
  const model = models.length === 1 ? models[0] : null;
  const descriptors = model?.capabilities?.optionDescriptors;
  const thinking = Array.isArray(descriptors) ? descriptors.filter(option => option?.id === 'thinking') : [];
  if (typeof modelSlug !== 'string' || !/^deepai\/[a-z0-9][a-z0-9.-]+$/.test(modelSlug) ||
      provider?.enabled !== true || provider.installed !== true || provider.status !== 'ready' ||
      !model || model.subProvider !== 'deepai' || model.isCustom !== false ||
      (model.theosPerRequest !== 0 && model.theosPerRequest !== '0') ||
      thinking.length !== 1 || thinking[0].type !== 'select' ||
      !Array.isArray(thinking[0].options) || !thinking[0].options.some(option => option?.id === 'high'))
    throw new NativeClientError('FREE_MODEL_UNAVAILABLE');
  return { instanceId: 'deepai', model: model.slug, options: { thinking: 'high' } };
}

/**
 * The second argument supplies IO for offline regression tests; defaults use the installed app.
 * No transport mutation is retried. RPC request IDs are correlation, not durable job identity.
 * The caller owns native command IDs, task receipts, reconnect and acceptance reconciliation.
 */
export async function connectNative({ websocket = false } = {}, dependencies = {}) {
  const fetchNative = dependencies.fetch ?? globalThis.fetch;
  const command = dependencies.nativeCommand ?? nativeCommand;
  const Socket = dependencies.WebSocket ?? WebSocket;
  const now = dependencies.now ?? Date.now;
  let runtime;
  try {
    runtime = await (dependencies.readRuntime ?? (() =>
      JSON.parse(readFileSync(path.join(baseDir, 'userdata', 'server-runtime.json'), 'utf8'))))();
  } catch { throw new NativeClientError('NATIVE_RUNTIME_UNAVAILABLE'); }
  const originText = parseOrigin(runtime);
  const secrets = new Set();
  const httpControllers = new Set();
  const pending = new Map();
  let token = '', sessionId, expiresAtMs = 0, socket, closed = false, socketFailed = false;
  let closePromise, openingReject, openingTimer, onSocketOpen;

  const settle = (id, error, value) => {
    const operation = pending.get(id);
    if (!operation) return;
    pending.delete(id);
    clearTimeout(operation.timer);
    if (error) operation.reject(new NativeClientError(error, operation.acceptance, id));
    else {
      try { operation.resolve(redact(value, secrets)); }
      catch { operation.reject(new NativeClientError('NATIVE_RESPONSE_INVALID', operation.acceptance, id)); }
    }
  };
  const stopSocket = code => {
    socketFailed = true;
    clearTimeout(openingTimer);
    if (openingReject) {
      const reject = openingReject; openingReject = undefined;
      reject(new NativeClientError(code, 'not_sent'));
    }
    for (const id of pending.keys()) settle(id, code);
  };
  const onSocketError = () => { if (!closed && !socketFailed) { stopSocket('NATIVE_SOCKET_ERROR'); retireSocket(); } };
  const onSocketClose = () => {
    stopSocket('NATIVE_SOCKET_CLOSED');
    socket?.off('message', onMessage);
    if (onSocketOpen) socket?.off('open', onSocketOpen);
    socket?.off('close', onSocketClose);
    // Retain the inert error guard: ws can emit a final error while terminating a handshake.
  };
  const retireSocket = () => {
    if (!socket) return;
    socket.off('message', onMessage);
    try { if (socket.readyState !== 3) socket.terminate(); } catch { /* Already retired. */ }
  };
  const onMessage = data => {
    if (closed || socketFailed) return;
    let decoded;
    try {
      if (Buffer.byteLength(data) > MAX_BYTES) throw new Error();
      decoded = JSON.parse(String(data));
    } catch { stopSocket('NATIVE_PROTOCOL_ERROR'); retireSocket(); return; }
    for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
      if (!frame || typeof frame !== 'object') continue;
      if (frame._tag === 'Ping') {
        try {
          if (socket.readyState === 1) socket.send(JSON.stringify({ _tag: 'Pong' }), error => {
            if (error && !closed && !socketFailed) { stopSocket('NATIVE_SOCKET_ERROR'); retireSocket(); }
          });
        } catch { stopSocket('NATIVE_SOCKET_ERROR'); retireSocket(); }
        continue;
      }
      if (frame._tag !== 'Exit' || typeof frame.requestId !== 'string' || !pending.has(frame.requestId)) continue;
      if (frame.exit?._tag === 'Success') settle(frame.requestId, null, frame.exit.value);
      else settle(frame.requestId, frame.exit?._tag === 'Failure' ? 'NATIVE_RPC_FAILED' : 'NATIVE_PROTOCOL_ERROR');
    }
  };

  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    stopSocket('NATIVE_CLIENT_CLOSED');
    retireSocket();
    for (const controller of httpControllers) controller.abort();
    closePromise = (async () => {
      if (!sessionId) return { credentialRevoked: false };
      try {
        await command(['auth', 'session', 'revoke', sessionId]);
        return { credentialRevoked: true };
      } catch { return { credentialRevoked: false }; } // The verified short TTL remains a hard bound.
    })();
    return closePromise;
  };
  const assertOpen = () => {
    if (closed) throw new NativeClientError('NATIVE_CLIENT_CLOSED');
    if (expiresAtMs && now() >= expiresAtMs) throw new NativeClientError('NATIVE_CREDENTIAL_EXPIRED');
  };
  const request = async (url, options = {}, authenticated = true) => {
    assertOpen();
    let headers, method;
    try {
      headers = new Headers(options.headers);
      method = String(options.method ?? 'GET').toUpperCase();
      if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(method) ||
          headers.has('authorization') || headers.has('x-t3-orchestration-protocol') ||
          headers.has('host') || headers.has('cookie')) throw new Error();
      if (authenticated) {
        headers.set('Authorization', 'Bearer ' + token);
        headers.set('x-t3-orchestration-protocol', String(PROTOCOL_VERSION));
      }
    } catch { throw new NativeClientError('NATIVE_REQUEST_INVALID'); }
    if (options.signal !== undefined && (!(options.signal instanceof AbortSignal) || options.signal.aborted))
      throw new NativeClientError('NATIVE_REQUEST_INVALID');
    const acceptance = method === 'GET' || method === 'HEAD' ? 'not_applicable' : 'unknown';
    const controller = new AbortController();
    httpControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), authenticated ? 20000 : 10000);
    let response;
    try {
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      response = await fetchNative(url, {
        method, headers, ...(options.body !== undefined ? { body: options.body } : {}),
        signal, redirect: 'error', credentials: 'omit'
      });
      if (!response.ok) throw new NativeClientError('NATIVE_HTTP_STATUS', acceptance, undefined, response.status);
      return redact(await readJson(response), secrets);
    } catch (error) {
      if (error instanceof NativeClientError)
        throw new NativeClientError(error.code, acceptance, undefined, error.httpStatus);
      throw new NativeClientError(response ? 'NATIVE_RESPONSE_INVALID' : 'NATIVE_HTTP_FAILED', acceptance);
    } finally {
      clearTimeout(timer);
      httpControllers.delete(controller);
      await response?.body?.cancel().catch(() => {});
    }
  };
  const http = async (route, options = {}) => request(requestUrl(route, originText), options);
  const descriptor = await request(new URL('/.well-known/t3/environment', originText), {}, false);
  if (!SERVER_VERSIONS.has(descriptor?.serverVersion) || descriptor.orchestrationProtocolVersion !== PROTOCOL_VERSION)
    throw new NativeClientError('NATIVE_VERSION_UNSUPPORTED');

  try {
    let issued;
    try {
      issued = JSON.parse(await command(['auth', 'session', 'issue', '--scope', SCOPES[0], '--scope', SCOPES[1],
        '--ttl', '1h', '--label', 'CoS DeepAI native integration', '--json']));
    } catch { throw new NativeClientError('NATIVE_AUTH_ISSUE_FAILED'); }
    // Keep a valid identity before validating other fields, so malformed issuance can still be revoked.
    if (typeof issued?.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{5,199}$/.test(issued.sessionId))
      sessionId = issued.sessionId;
    if (typeof issued?.token === 'string' && /^[^\s\u0000-\u001f\u007f]{16,4096}$/.test(issued.token)) {
      token = issued.token; secrets.add(token);
    }
    expiresAtMs = expiration(issued?.expiresAt);
    if (!sessionId || !token || !Number.isFinite(expiresAtMs) || expiresAtMs <= now() ||
        expiresAtMs > now() + 65 * 60 * 1000 || !Array.isArray(issued.scopes) ||
        issued.scopes.length !== SCOPES.length || !SCOPES.every(scope => issued.scopes.includes(scope)))
      throw new NativeClientError('NATIVE_AUTH_INVALID');
    const credentialMetadata = Object.freeze({
      hasSessionId: true, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs,
      scopes: Object.freeze([...SCOPES])
    });

    const rpc = (tag, payload, timeout = 20000) => {
      let id, encoded;
      try {
        assertOpen();
        timeoutValue(timeout);
        if (typeof tag !== 'string' || !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(tag))
          throw new NativeClientError('NATIVE_REQUEST_INVALID');
        if (!socket || socket.readyState !== 1 || socketFailed)
          throw new NativeClientError('NATIVE_SOCKET_UNAVAILABLE');
        id = randomUUID();
        encoded = JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] });
        if (Buffer.byteLength(encoded) > MAX_BYTES) throw new NativeClientError('NATIVE_REQUEST_INVALID');
      } catch (error) {
        return Promise.reject(error instanceof NativeClientError ? error : new NativeClientError('NATIVE_REQUEST_INVALID'));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(id, 'NATIVE_RPC_TIMEOUT'), timeout);
        pending.set(id, { resolve, reject, timer, acceptance: READ_RPC.has(tag) ? 'not_applicable' : 'unknown' });
        try {
          socket.send(encoded, error => { if (error) settle(id, 'NATIVE_RPC_WRITE_FAILED'); });
        } catch { settle(id, 'NATIVE_RPC_WRITE_FAILED'); }
      });
    };
    if (websocket) {
      const issuedTicket = await http('/api/auth/websocket-ticket', { method: 'POST' });
      if (typeof issuedTicket?.ticket !== 'string' || !issuedTicket.ticket || issuedTicket.ticket.length > 4096)
        throw new NativeClientError('NATIVE_AUTH_INVALID');
      secrets.add(issuedTicket.ticket);
      const websocketUrl = new URL('/ws', originText);
      websocketUrl.protocol = 'ws:';
      websocketUrl.searchParams.set('orchestrationProtocol', String(PROTOCOL_VERSION));
      websocketUrl.searchParams.set('wsTicket', issuedTicket.ticket);
      try { socket = new Socket(websocketUrl, { handshakeTimeout: 10000, maxPayload: MAX_BYTES, followRedirects: false }); }
      catch { throw new NativeClientError('NATIVE_SOCKET_OPEN_FAILED'); }
      socket.on('message', onMessage);
      socket.on('error', onSocketError);
      socket.on('close', onSocketClose);
      await new Promise((resolve, reject) => {
        openingReject = reject;
        onSocketOpen = () => {
          clearTimeout(openingTimer); openingReject = undefined;
          if (!closed && !socketFailed) resolve();
        };
        socket.once('open', onSocketOpen);
        openingTimer = setTimeout(() => {
          socket.off('open', onSocketOpen);
          stopSocket('NATIVE_SOCKET_OPEN_FAILED'); retireSocket();
        }, 10000);
      });
      return { http, rpc, descriptor, origin: new URL(originText), close, credentialMetadata };
    }
    return { http, descriptor, origin: new URL(originText), close, credentialMetadata };
  } catch (error) {
    await close();
    throw error instanceof NativeClientError ? error : new NativeClientError('NATIVE_AUTH_INVALID');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let connection;
  try {
    if (process.argv[2] && process.argv[2] !== 'ws') throw new NativeClientError('NATIVE_REQUEST_INVALID');
    connection = await connectNative({ websocket: process.argv[2] === 'ws' });
    if (connection.rpc) {
      await connection.rpc('server.probe', {});
      const modelSelection = assertFreeModel(await connection.rpc('server.getConfig', {}));
      console.log(JSON.stringify({ serverVersion: connection.descriptor.serverVersion,
        protocol: connection.descriptor.orchestrationProtocolVersion, credentialMetadata: connection.credentialMetadata,
        modelSelection }, null, 2));
    } else {
      const shell = await connection.http('/api/orchestration/shell');
      console.log(JSON.stringify({ serverVersion: connection.descriptor.serverVersion,
        protocol: connection.descriptor.orchestrationProtocolVersion, credentialMetadata: connection.credentialMetadata,
        projectCount: shell.projects?.length, threadCount: shell.threads?.length }, null, 2));
    }
  } catch (error) {
    console.error(error instanceof NativeClientError ? error.message : 'The native client failed.');
    process.exitCode = 1;
  } finally { if (connection) await connection.close(); }
}

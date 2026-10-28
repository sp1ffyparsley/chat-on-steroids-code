/**
 * Exact regression for the 2026-09-01 Prime recovery trace.
 *
 * One semantic turn reports a recoverable assistant transport error. Chrome confirms that
 * reload, so the turn-scoped repair becomes `done`. The same turn never emits turn_end, but
 * attributed connector calls keep it alive for several minutes. When those calls stop, the
 * chat-level silence deadline must still queue a silence repair; a completed turn-scoped repair
 * is not evidence that the conversation itself recovered.
 */
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'unknown'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  clipboard: {},
  shell: {}
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const {
  CHAT_SILENCE_MS,
  PRO_SILENCE_MS,
  resetBridgeForTests,
  shutdownBridge,
  startBridge,
  sweepStaleSwarm
} = await import('../src/main/bridge.js');
const { flushDurable, initDurableStore, readDurable, writeDurableSoon } = await import('../src/main/durable.js');
const {
  findSessionByConversation,
  initSessionStore,
  readEvents,
  resetSessionStoreForTests
} = await import('../src/main/session/store.js');
const { recordToolCall, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const CHAT = 'f0f00002-1111-4111-8111-111111111111';
const TURN = 'g-1cn09rgnc5jts-1-1';
const ERROR_TEXT = 'Connection interrupted. Waiting for the complete answer';
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

let dir: string;
let base: string;
let token: string | null = null;
let requestSerial = 0;

function request(
  method: string,
  path: string,
  options: { body?: unknown; auth?: string | null } = {}
): Promise<{ status: number; body: any }> {
  const url = new URL(path, base);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    origin: EXTENSION_ORIGIN,
    'x-extension-version': APP_VERSION,
    'x-extension-protocol': String(BRIDGE_PROTOCOL)
  };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  const auth = options.auth === undefined ? token : options.auth;
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function pair(): Promise<void> {
  const reply = await request('POST', '/pair', { auth: null });
  expect(reply.status).toBe(200);
  token = reply.body.token;
}

async function events(items: unknown[]): Promise<any> {
  const reply = await request('POST', '/events', { body: { conversationId: CHAT, events: items } });
  expect(reply.status).toBe(200);
  return reply.body;
}

async function maintenance(
  repaired?: string,
  action?: 'reloaded' | 'reopened' | 'retried' | 'compacted'
): Promise<{ conversationId: string; token: string; reason: string; action: 'reload' | 'retry' | 'compact' } | null> {
  const path = repaired
    ? `/status?repaired=${encodeURIComponent(repaired)}${action ? `&repairAction=${action}` : ''}`
    : '/status';
  const reply = await request('GET', path);
  expect(reply.status).toBe(200);
  const repairs = reply.body.repairs ?? [];
  expect(repairs.length).toBeLessThanOrEqual(1);
  return repairs[0] ?? null;
}

async function attributedCall(): Promise<void> {
  const requestId = `live_repair_trace_${++requestSerial}`;
  await events([
    {
      kind: 'tool_evidence',
      time: Date.now(),
      calls: [{ messageId: `m-${requestSerial}`, tool: 'read', order: 0, answered: false, requestId }]
    }
  ]);
  await recordToolCall({
    tool: 'read',
    args: { paths: ['/project/live-trace.ts'] },
    content: [{ type: 'text', text: 'ok' }],
    outcome: 'ok',
    durationMs: 1,
    startedAt: Date.now(),
    requestId
  });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-bridge-done-repair-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const config = defaultConfig();
  await saveConfig({
    ...config,
    sessions: { ...config.sessions, record: true },
    // A plain chat is recovered on silence only when the user turned that on.
    multiAgent: { ...config.multiAgent, enabled: true, recoverAgentTabs: true }
  });
  const port = await startBridge();
  expect(port).not.toBeNull();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await shutdownBridge();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetBridgeForTests();
  resetRecorderForTests();
  writeDurableSoon('bridge-commands', null);
  await flushDurable();
  await setSecret('bridgeToken', '');
  token = null;
  requestSerial = 0;
});

describe('silence after a confirmed assistant-error repair', () => {
  it('still queues the silence reload when the same turn never ends', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events([
        { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() },
        { kind: 'turn_start', time: Date.now(), turnId: TURN }
      ]);

      // Keep the turn alive up to the transport failure, as the live Prime did with connector work.
      await vi.advanceTimersByTimeAsync(60_000);
      await attributedCall();
      await vi.advanceTimersByTimeAsync(60_000);

      await events([
        { kind: 'chat_error', time: Date.now(), text: ERROR_TEXT, turnId: TURN, recoverable: true }
      ]);
      await vi.advanceTimersByTimeAsync(17_393);
      const assistantError = await maintenance();
      expect(assistantError).toMatchObject({ conversationId: CHAT, reason: 'assistant-error' });
      expect((await request('POST', '/repairs/claim', { body: { token: assistantError!.token } })).body.allowed).toBe(true);
      expect(await maintenance(assistantError!.token, 'reloaded')).toBeNull();

      // The page remains broken but the server-side model keeps issuing attributed calls. Never
      // emit turn_end. Each call refreshes the two-minute chat silence deadline while preserving
      // the turn-scoped assistant-error repair.
      for (let index = 0; index < 6; index += 1) {
        await vi.advanceTimersByTimeAsync(index === 0 ? 5_000 : 90_000);
        await attributedCall();
      }

      const session = await findSessionByConversation(CHAT);
      expect(session).not.toBeNull();
      const beforeSilence = await readEvents(session!.id);
      expect(beforeSilence.filter((event) => event.kind === 'turn_end')).toHaveLength(0);
      expect(beforeSilence.filter((event) => event.kind === 'tool_call').length).toBeGreaterThan(1);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
      expect(await maintenance()).toBeNull();
      await vi.advanceTimersByTimeAsync(2);
      await sweepStaleSwarm(Date.now());

      const silence = await maintenance();
      expect(silence).toMatchObject({ conversationId: CHAT, reason: 'silence' });
      // Once the chat-scoped silence action itself is confirmed, the old one-shot rule still
      // applies: without fresh activity there is no third reload.
      expect(await maintenance(silence!.token, 'reloaded')).toBeNull();
      expect(await maintenance()).toBeNull();

      // A confirmed one-shot reload that remains quiet becomes durable Needs Attention. It does
      // not mint a second reload on later status polls or maintenance passes.
      await vi.advanceTimersByTimeAsync(60_001);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
      const commands = await readDurable<any>('bridge-commands');
      expect(commands?.recoveryFences).toEqual(expect.arrayContaining([
        expect.objectContaining({ conversationId: CHAT, exhaustedAt: expect.any(Number) })
      ]));
      const afterExhaustion = await readEvents(session!.id);
      expect(afterExhaustion.filter(event => event.kind === 'progress' &&
        event.message.text.includes('one-shot recovery is exhausted'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates concurrent repair receipts and never inserts repair progress after a completed turn', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const began = Date.now();
      await events([
        { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: began },
        { kind: 'user_message', messageId: 'question-one', text: 'Do the work', time: began + 1 },
        { kind: 'turn_start', time: began + 2, turnId: TURN },
        { kind: 'chat_error', time: began + 3, text: ERROR_TEXT, turnId: TURN, recoverable: true, retryAvailable: true }
      ]);
      await vi.advanceTimersByTimeAsync(1);
      const offered = (await Promise.all(Array.from({ length: 12 }, () => maintenance())))
        .find(Boolean)!;
      expect(offered).toMatchObject({ conversationId: CHAT, reason: 'assistant-error' });
      expect((await request('POST', '/repairs/claim', { body: { token: offered.token } })).body.allowed).toBe(true);
      const receipt = offered.action === 'compact' ? 'compacted' : offered.action === 'retry' ? 'retried' : 'reloaded';
      await Promise.all(Array.from({ length: 12 }, () => maintenance(offered.token, receipt)));

      const session = await findSessionByConversation(CHAT);
      expect(session).not.toBeNull();
      const receiptText = offered.action === 'compact'
        ? 'Started Compact & Resume for the interrupted turn to recover an interrupted response.'
        : offered.action === 'retry'
          ? 'Retried the exact failed turn to recover an interrupted response.'
          : 'Reloaded chat to recover an interrupted response.';
      expect((await readEvents(session!.id)).filter(event => event.kind === 'progress' &&
        event.message.text === receiptText)).toHaveLength(1);

      resetBridgeForTests();
      resetRecorderForTests();
      await events([
        { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() },
        { kind: 'user_message', messageId: 'question-two', text: 'Do the next work', time: Date.now() + 1 },
        { kind: 'turn_start', time: Date.now() + 2, turnId: 'completed-turn' },
        { kind: 'chat_error', time: Date.now() + 3, text: ERROR_TEXT, turnId: 'completed-turn', recoverable: true, retryAvailable: true }
      ]);
      await events([
        { kind: 'assistant_message', messageId: 'completed-answer', turnId: 'completed-turn', text: 'Done', state: 'final', final: true, time: Date.now() + 4 },
        { kind: 'turn_end', turnId: 'completed-turn', outcome: 'completed', time: Date.now() + 5 }
      ]);
      expect(await maintenance()).toBeNull();
      const completedSession = await findSessionByConversation(CHAT);
      expect((await readEvents(completedSession!.id)).filter(event => event.kind === 'progress' &&
        event.progressId?.startsWith('browser-repair:') && event.turnId === 'completed-turn')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a confirmed Thinking failed silence repair alive for its exact five-minute listen window', async () => {
    vi.useFakeTimers();
    try {
      // The file intentionally keeps one durable conversation across cases. Use a fresh semantic
      // turn id so recorder idempotency cannot fold this regression into the earlier silence case.
      const thinkingTurn = `${TURN}-thinking-failed`;
      await pair();
      await events([
        { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: Date.now() },
        { kind: 'turn_start', time: Date.now(), turnId: thinkingTurn }
      ]);
      await attributedCall();
      await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS + 1);
      await sweepStaleSwarm(Date.now());
      const silence = await maintenance();
      expect(silence).toMatchObject({ conversationId: CHAT, reason: 'silence' });
      const confirmedAt = Date.now();
      expect(await maintenance(silence!.token, 'reloaded')).toBeNull();
      await events([{ kind: 'turn_end', turnId: thinkingTurn, outcome: 'failed', reason: 'thinking_failed', time: Date.now() + 1 }]);

      await vi.advanceTimersByTimeAsync(60_001);
      await sweepStaleSwarm(Date.now());
      await flushDurable();
      expect(((await readDurable<any>('bridge-commands'))?.recoveryFences ?? [])
        .some((row: any) => row.conversationId === CHAT)).toBe(false);

      await vi.advanceTimersByTimeAsync(5 * 60_000 - 60_001 - 1);
      await sweepStaleSwarm(Date.now());
      await flushDurable();
      expect(((await readDurable<any>('bridge-commands'))?.recoveryFences ?? [])
        .some((row: any) => row.conversationId === CHAT)).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await sweepStaleSwarm(Date.now());
      await flushDurable();
      expect((await readDurable<any>('bridge-commands'))?.recoveryFences).toEqual(expect.arrayContaining([
        expect.objectContaining({ conversationId: CHAT, exhaustedAt: expect.any(Number) })
      ]));
      const session = await findSessionByConversation(CHAT);
      expect((await readEvents(session!.id)).filter(event => event.kind === 'progress' &&
        event.turnId === thinkingTurn &&
        event.message.text.includes('one-shot recovery is exhausted'))).toHaveLength(1);
      expect(Date.now()).toBe(confirmedAt + 5 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

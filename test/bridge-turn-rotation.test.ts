/**
 * #1402 through the real bridge: an attributed tool result in a turn that has run past
 * `ui.rotateTurnMinutes` files exactly one automatic continue into that turn; a younger turn,
 * a Pro turn gets none; Goal/Loop preserve their mode while rotating long work.
 */
import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as execOwnership from '../src/main/codex/ownership.js';
import * as turnRotation from '../src/main/turn-rotation.js';

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
const { resetBridgeForTests, shutdownBridge, startBridge, sessionInputActivity } = await import('../src/main/bridge.js');
const { flushDurable, initDurableStore, writeDurableSoon } = await import('../src/main/durable.js');
const { findSessionByConversation, getSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { recordToolCall, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { listInputs, resetInputForTests } = await import('../src/main/session/input.js');
const { claimBrowserInput } = await import('../src/main/session/input.js');
const { enqueueInput } = await import('../src/main/session/input.js');
const { resetTurnRotationForTests } = await import('../src/main/turn-rotation.js');
const { setGoalSwitchNow, goalSwitchFor, resetGoalStateForTests } = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const MINUTE = 60_000;

let dir: string;
let base: string;
let token: string | null = null;
let requestSerial = 0;
let pendingRotations: Promise<boolean>[] = [];

function request(
  method: string,
  path: string,
  options: { body?: unknown; auth?: string | null; browser?: string } = {}
): Promise<{ status: number; body: any }> {
  const url = new URL(path, base);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    origin: EXTENSION_ORIGIN,
    'x-extension-version': APP_VERSION,
    'x-extension-protocol': String(BRIDGE_PROTOCOL)
  };
  if (options.browser) headers['x-extension-browser'] = options.browser;
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

async function events(chat: string, items: unknown[]): Promise<any> {
  const reply = await request('POST', '/events', { body: { conversationId: chat, events: items } });
  expect(reply.status).toBe(200);
  return reply.body;
}

async function attributedCall(chat: string, tool = 'read'): Promise<void> {
  const requestId = `rotation_trace_${++requestSerial}`;
  const session = await findSessionByConversation(chat);
  await events(chat, [{ kind: 'tool_evidence', time: Date.now(), turnId: session!.activeTurnId,
    calls: [{ messageId: `m-${requestSerial}`, tool, order: 0, answered: false, requestId }] }]);
  await recordToolCall({ tool, args: { paths: ['/project/a.ts'] }, content: [{ type: 'text', text: 'ok' }],
    outcome: 'ok', durationMs: 1, startedAt: Date.now(), requestId });
}

async function turnFor(chat: string, turnId: string, ageMinutes: number, model = 'GPT-6 Sol'): Promise<string> {
  await events(chat, [
    { kind: 'model_selection', model, reasoningEffort: 'high', time: Date.now() - ageMinutes * MINUTE },
    { kind: 'turn_start', time: Date.now() - ageMinutes * MINUTE, turnId }
  ]);
  const session = await findSessionByConversation(chat);
  expect(session?.activeTurnId).toBe(turnId);
  return session!.id;
}

/** Join the actual deferred rotation, including its durable outbox commit. A fixed
 * sleep can read an empty queue while the same legitimate filing still awaits disk. */
async function rotationsFor(sessionId: string): Promise<Array<{ turnId?: string; text: string }>> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await Promise.all(pendingRotations);
  return (await listInputs()).filter(row => row.sessionId === sessionId && row.purpose === 'rotation')
    .map(row => ({ turnId: row.queuedTurn?.turnId, text: row.text }));
}

beforeAll(async () => {
  dir = await makeTempDir('clf-bridge-rotation-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const config = defaultConfig();
  await saveConfig({ ...config, sessions: { ...config.sessions, record: true } });
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
  pendingRotations = [];
  const consider = turnRotation.considerTurnRotation;
  vi.spyOn(turnRotation, 'considerTurnRotation').mockImplementation((...args) => {
    const pending = consider(...args);
    pendingRotations.push(pending);
    return pending;
  });
  resetBridgeForTests();
  resetRecorderForTests();
  resetInputForTests();
  resetTurnRotationForTests();
  resetGoalStateForTests();
  writeDurableSoon('bridge-commands', null);
  writeDurableSoon('session-input', []);
  await flushDurable();
  await setSecret('bridgeToken', '');
  token = null;
  await pair();
});
afterEach(async () => {
  await new Promise<void>(resolve => setImmediate(resolve));
  await Promise.allSettled(pendingRotations);
  vi.restoreAllMocks();
});

describe('turn rotation (#1402)', () => {
  it('releases the ended rotation grant after the fresh turn has a recorded final', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000007';
    const sessionId = await turnFor(chat, 'g-rot-follow-0-1', 31);
    await attributedCall(chat);
    const at = Date.now();
    await events(chat, [
      { kind: 'turn_end', time: at, turnId: 'g-rot-follow-0-1', outcome: 'interrupted' },
      { kind: 'turn_start', time: at + 1, turnId: 'g-rot-follow-0-2' },
      { kind: 'user_message', time: at + 2, turnId: 'g-rot-follow-0-2', messageId: 'rot-follow-continue', text: 'Continue the task from where you are.' }
    ]);
    await events(chat, [{ kind: 'page_tool', time: at + 3, turnId: 'g-rot-follow-0-2', label: 'Read file', messageId: 'rot-follow-tool' }]);
    await events(chat, [{ kind: 'assistant_message', time: at + 4, turnId: 'g-rot-follow-0-2', messageId: 'rot-follow-final', text: 'All steps are done.', state: 'final', final: true }]);
    await events(chat, [{ kind: 'turn_end', time: at + 5, turnId: 'g-rot-follow-0-2', outcome: 'completed' }]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sessionInputActivity((await getSession(sessionId))!)).toMatchObject({ exact: false, possible: false });
  });
  it('keeps ordinary explicit input compatible without a fresh-turn capability', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000011';
    const sessionId = await turnFor(chat, 'g-ordinary-direct', 31);
    const row = await enqueueInput({ id: 'ffffffff-1111-4222-8333-444444444444', sessionId,
      text: 'My explicit correction', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
    expect(await claimBrowserInput(row.id, 'ordinary-page', chat, true)).not.toBeNull();
    expect((await request('POST', '/input/claim', { body: {
      id: row.id, owner: 'ordinary-page', conversationId: chat, authorize: true } })).body.ok).toBe(true);
  });
  it('withholds fresh turns from an old loaded content script, including final authorization', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000010';
    const sessionId = await turnFor(chat, 'g-rot-old-content', 31);
    await attributedCall(chat); await rotationsFor(sessionId);
    const row = (await listInputs()).find(input => input.sessionId === sessionId && input.purpose === 'rotation')!;
    const oldClaim = await request('POST', '/input/claim', { body: {
      id: row.id, owner: 'old-same-protocol-page', conversationId: chat, requiresAuthorization: true } });
    expect(oldClaim.body).toMatchObject({ input: null, deferred: 'fresh_turn_companion_required' });
    expect((await listInputs()).find(input => input.id === row.id)?.state).toBe('queued');
    expect(await claimBrowserInput(row.id, 'new-rotation-page', chat, true)).not.toBeNull();
    const oldAuthorize = await request('POST', '/input/claim', { body: {
      id: row.id, owner: 'new-rotation-page', conversationId: chat, authorize: true } });
    expect(oldAuthorize.body).toMatchObject({ ok: false, deferred: 'fresh_turn_companion_required' });
    expect((await listInputs()).find(input => input.id === row.id)?.sendAuthorizedAt).toBeUndefined();
    const newAuthorize = await request('POST', '/input/claim', { body: {
      id: row.id, owner: 'new-rotation-page', conversationId: chat, authorize: true, freshTurnProtocol: 1 } });
    expect(newAuthorize.body.ok).toBe(true);
  });
  it('files one automatic continue into a turn older than 30 minutes, after its tool result', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000001';
    const sessionId = await turnFor(chat, 'g-rot-old-1', 31);
    await attributedCall(chat);
    const rows = await rotationsFor(sessionId);
    expect(rows).toEqual([{ turnId: 'g-rot-old-1', text: expect.stringContaining('Continue the task from where you are.') }]);
    await attributedCall(chat);
    expect(await rotationsFor(sessionId)).toHaveLength(1);
  });

  it.each(['session_finish', 'keep_astra_on_forever'])('does not rotate a Loop hold-tool result (%s)', async tool => {
    const chat = 'f0f00003-1111-4111-8111-000000000019';
    const sessionId = await turnFor(chat, 'g-rot-hold', 31);
    await setGoalSwitchNow(chat, 'loop', true);
    await attributedCall(chat, tool);
    expect(await rotationsFor(sessionId)).toEqual([]);
    expect(goalSwitchFor(chat)).toMatchObject({ enabled: true, mode: 'loop' });
  });

  it('does not let an incapable same-protocol companion reserve fresh-turn opening custody from a current peer', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000012';
    const sessionId = await turnFor(chat, 'g-rot-opening-capability', 31);
    await attributedCall(chat); await rotationsFor(sessionId);
    const row = (await listInputs()).find(input => input.sessionId === sessionId && input.purpose === 'rotation')!;
    const oldBrowser = 'a'.repeat(32), currentBrowser = 'b'.repeat(32);
    // Both are authenticated Chrome companions with the same app version and wire protocol.
    // Neither currently has the source tab: its recorded server turn still owns the work.
    const oldOffer = await request('POST', '/status', { browser: oldBrowser,
      body: { openConversations: [], inventoryComplete: true } });
    const oldClaim = await request('POST', '/input/claim', { browser: oldBrowser, body: {
      id: row.id, owner: 'old-content-page', conversationId: chat, requiresAuthorization: true } });
    expect(oldClaim.body).toMatchObject({ input: null, deferred: 'fresh_turn_companion_required' });
    const currentOffer = await request('POST', '/status', { browser: currentBrowser,
      body: { openConversations: [], inventoryComplete: true, freshTurnProtocol: 1 } });
    expect(currentOffer.body.inputs, JSON.stringify({
      oldOffered: oldOffer.body.inputs?.some((input: { id: string }) => input.id === row.id),
      oldClaim: oldClaim.body, currentInputs: currentOffer.body.inputs
    })).toContainEqual(expect.objectContaining({ id: row.id, purpose: 'rotation' }));
    expect(oldOffer.body.inputs).not.toContainEqual(expect.objectContaining({ id: row.id }));
    expect((await listInputs()).filter(input => input.sessionId === sessionId && input.purpose === 'rotation'))
      .toHaveLength(1);
  });

  it('keeps ordinary explicit input with its native tab holder when that peer has no fresh-turn capability', async () => {
    vi.spyOn(await import('../src/main/plugin-refresh.js'), 'coreConnectorPresence')
      .mockResolvedValue({ connectorName: 'Status fixture Core', appId: 'asdk_app_status_fixture' });
    const chat = 'f0f00003-1111-4111-8111-000000000016';
    const sessionId = await turnFor(chat, 'g-ordinary-status-owner', 31);
    const row = await enqueueInput({ id: 'ffffffff-1111-4222-8333-444444444444', sessionId,
      text: 'A genuine explicit correction', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
    expect((await request('POST', '/status', { browser: 'a'.repeat(32),
      body: { openConversations: [chat], inventoryComplete: true } })).body.inputs)
      .toContainEqual(expect.objectContaining({ id: row.id }));
    expect((await request('POST', '/status', { browser: 'b'.repeat(32),
      body: { openConversations: [], inventoryComplete: true, freshTurnProtocol: 1 } })).body.inputs)
      .not.toContainEqual(expect.objectContaining({ id: row.id }));
  });

  it('leaves a younger turn alone', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000002';
    const sessionId = await turnFor(chat, 'g-rot-young-1', 10);
    await attributedCall(chat);
    expect(await rotationsFor(sessionId)).toEqual([]);
  });

  it.each([undefined, 0, 2, '1', true, { version: 1 }])('does not reserve fresh turns for malformed or absent status capability %j', async capability => {
    const chat = 'f0f00003-1111-4111-8111-000000000013';
    const sessionId = await turnFor(chat, 'g-rot-malformed-status', 31);
    await attributedCall(chat); await rotationsFor(sessionId);
    const row = (await listInputs()).find(input => input.sessionId === sessionId && input.purpose === 'rotation')!;
    const oldOffer = await request('POST', '/status', { browser: 'a'.repeat(32),
      body: { openConversations: [chat], inventoryComplete: true, freshTurnProtocol: capability } });
    expect(oldOffer.body.inputs).not.toContainEqual(expect.objectContaining({ id: row.id }));
    const newOffer = await request('POST', '/status', { browser: 'b'.repeat(32),
      body: { openConversations: [], inventoryComplete: true, freshTurnProtocol: 1 } });
    expect(newOffer.body.inputs).toContainEqual(expect.objectContaining({ id: row.id }));
    expect((await listInputs()).find(input => input.id === row.id)).toMatchObject({ state: 'queued', owner: null });
  });

  it('releases only an untouched fresh-turn opening after its capable holder reports a downgrade', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000014';
    const sessionId = await turnFor(chat, 'g-rot-holder-downgrade', 31);
    await attributedCall(chat); await rotationsFor(sessionId);
    const row = (await listInputs()).find(input => input.sessionId === sessionId && input.purpose === 'rotation')!;
    const owner = 'a'.repeat(32), other = 'b'.repeat(32);
    expect((await request('POST', '/status', { browser: owner,
      body: { openConversations: [chat], inventoryComplete: true, freshTurnProtocol: 1 } })).body.inputs)
      .toContainEqual(expect.objectContaining({ id: row.id }));
    expect((await request('POST', '/status', { browser: other,
      body: { openConversations: [], inventoryComplete: true, freshTurnProtocol: 1 } })).body.inputs)
      .not.toContainEqual(expect.objectContaining({ id: row.id }));
    await request('POST', '/status', { browser: owner, body: { openConversations: [chat], inventoryComplete: true } });
    expect((await request('POST', '/status', { browser: other,
      body: { openConversations: [], inventoryComplete: true, freshTurnProtocol: 1 } })).body.inputs)
      .toContainEqual(expect.objectContaining({ id: row.id }));
  });

  it.each([false, true])('preserves exact browser-owned rotation custody despite a capability downgrade (authorized=%s)', async authorized => {
    const chat = 'f0f00003-1111-4111-8111-000000000015';
    const sessionId = await turnFor(chat, 'g-rot-owned-downgrade', 31);
    await attributedCall(chat); await rotationsFor(sessionId);
    const row = (await listInputs()).find(input => input.sessionId === sessionId && input.purpose === 'rotation')!;
    const owner = 'a'.repeat(32), other = 'b'.repeat(32);
    await request('POST', '/status', { browser: owner,
      body: { openConversations: [], inventoryComplete: true, freshTurnProtocol: 1 } });
    expect(await claimBrowserInput(row.id, 'original-document', chat, true)).not.toBeNull();
    if (authorized) expect((await request('POST', '/input/claim', { browser: owner, body: {
      id: row.id, owner: 'original-document', conversationId: chat, authorize: true, freshTurnProtocol: 1 } })).body.ok).toBe(true);
    await request('POST', '/status', { browser: owner, body: { openConversations: [], inventoryComplete: true } });
    expect((await request('POST', '/status', { browser: other,
      body: { openConversations: [], inventoryComplete: true, freshTurnProtocol: 1 } })).body.inputs)
      .not.toContainEqual(expect.objectContaining({ id: row.id }));
    const stolen = await request('POST', '/input/claim', { browser: other, body: {
      id: row.id, owner: 'foreign-document', conversationId: chat, requiresAuthorization: true, freshTurnProtocol: 1 } });
    expect(stolen.body.input).toBeNull();
    expect((await listInputs()).find(input => input.id === row.id)).toMatchObject({ state: 'browser', owner: 'original-document' });
  });

  it('leaves Pro turns alone, which think long on purpose', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000003';
    const sessionId = await turnFor(chat, 'g-rot-pro-1', 45, 'GPT-6 Pro');
    await attributedCall(chat);
    expect(await rotationsFor(sessionId)).toEqual([]);
  });

  it.each(['goal', 'loop'] as const)('rotates a long running %s after an exact result without replacing its objective', async (which) => {
    const chat = `f0f00003-1111-4111-8111-00000000000${which === 'goal' ? 4 : 6}`;
    const sessionId = await turnFor(chat, `g-rot-${which}-1`, 31);
    await setGoalSwitchNow(chat, which, true);
    await attributedCall(chat);
    expect(await rotationsFor(sessionId)).toHaveLength(1);
    expect(goalSwitchFor(chat)).toMatchObject({ enabled: true, mode: which });
  });

  it('is off at 0 minutes', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: true }, ui: { ...config.ui, rotateTurnMinutes: 0 } });
    try {
      const chat = 'f0f00003-1111-4111-8111-000000000005';
      const sessionId = await turnFor(chat, 'g-rot-off-1', 90);
      await attributedCall(chat);
      expect(await rotationsFor(sessionId)).toEqual([]);
    } finally {
      await saveConfig({ ...config, sessions: { ...config.sessions, record: true } });
    }
  });

  it('does not stop an owned command that returned a live process session', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000007';
    const sessionId = await turnFor(chat, 'g-rot-live-process', 31);
    vi.spyOn(execOwnership, 'backgroundExecObligations').mockReturnValue({ running: [101], exitedUnread: [] });
    await attributedCall(chat);
    expect(await rotationsFor(sessionId)).toEqual([]);
  });

  it('refuses a provider-unattributed result even when this is the only old turn', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000008';
    const sessionId = await turnFor(chat, 'g-rot-unattributed', 31);
    await recordToolCall({ tool: 'read', args: { paths: ['/project/a.ts'] }, content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok', durationMs: 1, startedAt: Date.now(), requestId: null });
    expect(await rotationsFor(sessionId)).toEqual([]);
  });

  it('preserves profile pause after an exact terminal tool result', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: true }, ui: { ...config.ui, automationPaused: true } });
    try {
      const chat = 'f0f00003-1111-4111-8111-000000000009';
      const sessionId = await turnFor(chat, 'g-rot-paused', 31);
      await attributedCall(chat);
      expect(await rotationsFor(sessionId)).toEqual([]);
    } finally { await saveConfig({ ...config, sessions: { ...config.sessions, record: true } }); }
  });
});

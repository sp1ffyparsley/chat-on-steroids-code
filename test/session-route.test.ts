import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import type { SurfaceRegistrar, ToolResult } from '../src/main/mcp/kernel.js';
import { registerSessionTool } from '../src/main/mcp/session-tool.js';
import {
  appendEvent,
  createSession,
  flushSessions,
  initSessionStore,
  observeSessionModel,
  resetSessionStoreForTests,
  upsertMessageEvent
} from '../src/main/session/store.js';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';
import { resetGoalStateForTests, setGoalSwitchNow } from '../src/main/goal.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  initLogFile, noteLocalIncident, flushLocalIncidents, flushLogFile, resetLoggerForTests,
  offerBrowserDebugCapture, completeBrowserDebugCapture, setLogProfileContext
} from '../src/main/logger.js';

const routed = vi.hoisted(() => ({ send: vi.fn(), rows: [] as InputEntry[] }));
vi.mock('../src/main/session/input.js', async original => ({
  ...await original<typeof import('../src/main/session/input.js')>(),
  listInputs: async () => routed.rows.map(row => ({ ...row }))
}));
vi.mock('../src/main/session/start-input.js', () => ({ sendDesktopInput: routed.send }));

let directory: string;
let counter = 0;

beforeEach(async () => {
  directory = await makeTempDir('cos-session-route-');
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  resetGoalStateForTests();
  await saveConfig(defaultConfig());
  initLogFile(path.join(directory, 'app.log'));
  routed.rows = [];
  routed.send.mockReset().mockImplementation(async (input: InputArgs) => {
    const entry = {
      ...input,
      state: 'queued',
      owner: null,
      createdAt: Date.now(),
      conversationId: 'conversation-for-' + (input.sessionId ?? 'new')
    } satisfies InputEntry;
    routed.rows.push(entry);
    return entry;
  });
});

afterEach(async () => {
  await flushLogFile();
  await flushLocalIncidents();
  resetLoggerForTests();
  resetGoalStateForTests();
  await flushDurable();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

function textOf(result: ToolResult): string {
  return result.content.filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

it('exposes account-local bounded incident evidence through existing read-only Core session without Chrome input', async () => {
  const token = 'sk-NeverPublishThisPrivateToken';
  await noteLocalIncident({ source: 'browser-debug', reason: 'stream_gone', sessionId: 'cos24-live',
    conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', capture: 'hidden_tab', detail: token });
  const reg = registrar();
  const index = JSON.parse(textOf(await reg.call('session', { action: 'incidents' })));
  expect(index.folder).toBe(path.join(directory, 'local-incidents'));
  expect(index.incidents).toHaveLength(1);
  const item = index.incidents[0];
  expect(item).toMatchObject({ reason: 'stream_gone', capture: 'hidden_tab',
    sessionId: 'cos24-live', status: 'unresolved' });
  expect(JSON.stringify(index)).not.toContain(token);
  const exact = JSON.parse(textOf(await reg.call('session', { action: 'incidents', incident_id: item.id })));
  expect(exact.incidents[0]).toMatchObject({ id: item.id, source: 'browser-debug' });
  expect(() => reg.tools.get('session')!.schema.parse({ action: 'incidents', cursor: 'foreign' })).toThrow();
  expect(() => reg.tools.get('session')!.schema.parse({ action: 'incidents', include_image: true })).toThrow();
});

it('preserves the not_initialized Core incident image response before a logger is opened', async () => {
  resetLoggerForTests();
  const reg = registrar();
  const result = await reg.call('session', {
    action: 'incidents', incident_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', include_image: true
  });
  expect(JSON.parse(textOf(result))).toMatchObject({
    folder: null, logFile: null, status: 'not_initialized',
    incidents: [], freeSlots: 0, imageStatus: 'not_found'
  });
  expect(result.content.some(part => part.type === 'image')).toBe(false);
});

it('indexes only validated native-final completion gap counts through existing read-only Core incidents', async () => {
  await noteLocalIncident({ source: 'browser-debug', reason: 'native_terminal_open_call',
    sessionId: 'cos24-native-final', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    detail: 'PRIVATE_NATIVE_ERROR_BODY_DO_NOT_INDEX',
    nativeCompletion: { openCalls: 1, openCodeCalls: 0, traceRequestIds: 0, exactRequestJoins: 0 } });
  const reg = registrar();
  const index = JSON.parse(textOf(await reg.call('session', { action: 'incidents' })));
  expect(index.incidents).toHaveLength(1);
  const item = index.incidents[0];
  expect(item).toMatchObject({ reason: 'native_terminal_open_call', sessionId: 'cos24-native-final',
    nativeCompletion: { openCalls: 1, openCodeCalls: 0, traceRequestIds: 0, exactRequestJoins: 0 } });
  expect(item).not.toHaveProperty('requestId');
  expect(JSON.stringify(index)).not.toContain('PRIVATE_NATIVE_ERROR_BODY_DO_NOT_INDEX');
  const exact = JSON.parse(textOf(await reg.call('session', { action: 'incidents', incident_id: item.id })));
  expect(exact.incidents[0]).toMatchObject({ id: item.id, reason: 'native_terminal_open_call',
    requestId: null, nativeCompletion: item.nativeCompletion,
    sendEvidence: 'not_observed', loadedCompanionEvidence: 'unverified' });
});

it('returns actual hash-verified, permissioned captured pixels on an exact incident and refuses a replaced ring slot', async () => {
  const sharp = (await import('sharp')).default;
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  const offer = offerBrowserDebugCapture({
    sessionId: 'cos24-pixel-proof', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    reason: 'watchdog_stalled', errors: 1, runningTools: 0, automationPaused: true, screenEnabled: true
  })!;
  expect(offer).toBeTruthy();
  expect(await completeBrowserDebugCapture(offer.id, `data:image/jpeg;base64,${jpeg.toString('base64')}`, 'captured')).toBe(true);
  const reg = registrar();
  const index = JSON.parse(textOf(await reg.call('session', { action: 'incidents' })));
  expect(index.incidents[0]).toMatchObject({ capture: 'saved', screenshot: 'hash-verified' });
  const id = index.incidents[0].id;
  const captured = await reg.call('session', { action: 'incidents', incident_id: id, include_image: true });
  const pixels = captured.content.find(item => item.type === 'image');
  expect(pixels?.mimeType).toBe('image/jpeg');
  expect(pixels && Buffer.from(pixels.data, 'base64').length).toBeGreaterThan(0);
  expect(JSON.parse(textOf(captured)).imageStatus).toBe('saved');

  await fs.writeFile(path.join(directory, 'browser-debug', 'viewport-0.jpg'), 'not the captured jpeg');
  const stale = await reg.call('session', { action: 'incidents', incident_id: id, include_image: true });
  expect(stale.content.some(item => item.type === 'image')).toBe(false);
  expect(JSON.parse(textOf(stale)).imageStatus).toBe('expired');
});

it.each(['switch', 'roundtrip'])(
  'never publishes an earlier account incident index from a multi-await Core JPEG response after %s', async transition => {
    const first = 'profile-f481290d-e54c-42a6-be5d-c8a19b35f0aa';
    setLogProfileContext(first);
    initLogFile(path.join(directory, 'app.log'));
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const offer = offerBrowserDebugCapture({
      sessionId: 'cos24-combined-read', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      reason: 'watchdog_stalled', errors: 1, runningTools: 0, automationPaused: true, screenEnabled: true
    })!;
    expect(await completeBrowserDebugCapture(offer.id, `data:image/jpeg;base64,${jpeg.toString('base64')}`, 'captured')).toBe(true);
    await flushLocalIncidents();
    const reg = registrar();
    const id = JSON.parse(textOf(await reg.call('session', { action: 'incidents' }))).incidents[0].id;
    const originalRead = fs.readFile.bind(fs);
    let jpegReads = 0, started!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.jpg') && ++jpegReads === 2) { started(); await gate; }
      return originalRead(...args);
    });
    const pending = reg.call('session', { action: 'incidents', incident_id: id, include_image: true });
    await entered;
    try {
      setLogProfileContext('profile-8bc4db29-9172-4c9a-876d-6d52d81866a7');
      if (transition === 'roundtrip') setLogProfileContext(first);
      resume();
      const result = await pending;
      expect(result.content.some(item => item.type === 'image')).toBe(false);
      expect(JSON.parse(textOf(result))).toMatchObject({
        folder: null, logFile: null, status: 'storage_unavailable',
        storageError: 'incident_profile_unverified', freeSlots: 0,
        incidents: [], imageStatus: 'not_found'
      });
    } finally {
      spy.mockRestore();
      setLogProfileContext(first);
    }
    const recovered = await reg.call('session', { action: 'incidents', incident_id: id, include_image: true });
    expect(JSON.parse(textOf(recovered)).imageStatus).toBe('saved');
    expect(recovered.content.some(item => item.type === 'image')).toBe(true);
  }
);

function registrar() {
  const tools = new Map<string, {
    schema: z.ZodType;
    annotations?: Record<string, unknown>;
    handler: (input: unknown) => Promise<ToolResult>;
  }>();
  registerSessionTool({
    sessionToolsLive: true,
    sessionToolsExposed: true,
    register: (name: string, definition: { inputSchema: z.ZodType; annotations?: Record<string, unknown> }, handler: (input: unknown) => Promise<ToolResult>) => {
      tools.set(name, { schema: definition.inputSchema, annotations: definition.annotations, handler });
    },
    featureDisabled: () => ({ isError: true, content: [{ type: 'text', text: 'FEATURE_DISABLED' }] })
  } as unknown as SurfaceRegistrar);
  return {
    tools,
    call: (name: string, input: unknown): Promise<ToolResult> => {
      const tool = tools.get(name);
      if (!tool) throw new Error('Missing tool ' + name);
      return tool.handler(tool.schema.parse(input));
    }
  };
}

async function addUser(sessionId: string, wireText: string, authoredText?: string): Promise<void> {
  const messageId = 'route-message-' + ++counter;
  await upsertMessageEvent(sessionId, {
    kind: 'user_message',
    source: 'app',
    time: Date.now(),
    messageId,
    ...(authoredText === undefined ? {} : { authoredText }),
    message: { text: wireText, chars: wireText.length, truncated: false }
  });
  await flushSessions();
}

function caller(source: { id: string; conversationId: string | null }, requestId = 'route-request-a'): CallContext {
  if (!source.conversationId) throw new Error('Test source needs a conversation');
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    outcome: null,
    caller: {
      transportKey: null,
      requestId,
      conversationId: source.conversationId,
      sessionId: source.id
    },
    evidence: emptyEvidence()
  };
}

it('keeps discovery on authored user text instead of hidden transport framing', async () => {
  const target = await createSession({ conversationId: 'route-target-authored', title: 'Parser workstream' });
  await addUser(
    target.id,
    '[[COS_CONTEXT:10]]\nSECRETPROTOCOLWORD instructions\n[[/COS_CONTEXT]]\n\nRefactor the parser',
    'Refactor the parser'
  );
  const reg = registrar();

  const authored = textOf(await reg.call('session', { action: 'search', query: 'refactor the parser' }));
  const hidden = textOf(await reg.call('session', { action: 'search', query: 'SECRETPROTOCOLWORD' }));
  const read = textOf(await reg.call('session', { action: 'read', session_id: target.id, include: ['user'] }));

  expect(authored).toContain(target.id);
  expect(hidden).not.toContain(target.id);
  expect(read).toContain('Refactor the parser');
  expect(read).not.toContain('SECRETPROTOCOLWORD');
});

it('routes only from a caught-up target read and reuses one deterministic durable input identity', async () => {
  const source = await createSession({ conversationId: 'route-source-main', title: 'Mixed request owner' });
  const target = await createSession({ conversationId: 'route-target-main', title: 'Existing target workstream' });
  await addUser(target.id, 'Existing target context');
  const reg = registrar();
  const read = textOf(await reg.call('session', { action: 'read', session_id: target.id }));
  const updateCursor = /update_cursor:\s*(\S+)/.exec(read)?.[1];
  expect(updateCursor).toBeTruthy();

  const route = () => runInCallContext(caller(source), () =>
    reg.call('session_route', { session_id: target.id, update_cursor: updateCursor!, text: 'Handle only the target-owned clause.' }));
  expect((await route()).isError).not.toBe(true);
  await addUser(target.id, 'Handle only the target-owned clause.');
  expect((await route()).isError).not.toBe(true);

  expect(routed.send).toHaveBeenCalledTimes(1);
  const first = routed.send.mock.calls[0]![0] as InputArgs;
  expect(first).toMatchObject({
    sessionId: target.id,
    text: 'Handle only the target-owned clause.',
    mode: 'auto',
    dueAt: 0,
    model: null,
    reasoningEffort: null
  });
  expect(routed.rows).toHaveLength(1);
  expect(reg.tools.get('session')?.annotations?.readOnlyHint).toBe(true);
  expect(reg.tools.get('session_route')?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
});

it('refuses a stale target checkpoint before any routed input can be queued', async () => {
  const source = await createSession({ conversationId: 'route-source-stale', title: 'Source' });
  const target = await createSession({ conversationId: 'route-target-stale', title: 'Target' });
  await addUser(target.id, 'First target state');
  const reg = registrar();
  const read = textOf(await reg.call('session', { action: 'read', session_id: target.id }));
  const updateCursor = /update_cursor:\s*(\S+)/.exec(read)?.[1];
  expect(updateCursor).toBeTruthy();
  await addUser(target.id, 'New target work arrived');

  const result = await runInCallContext(caller(source), () =>
    reg.call('session_route', { session_id: target.id, update_cursor: updateCursor!, text: 'Do stale work' }));

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('target changed after the supplied checkpoint');
  expect(routed.send).not.toHaveBeenCalled();
});

it.each(['chat-Off', 'account-paused'] as const)('does not let a model route revive a %s target with a valid read cursor', async hold => {
  const source = await createSession({ conversationId: 'route-source-held', title: 'Fresh work owner' });
  const target = await createSession({ conversationId: 'route-target-held', title: 'Retired workstream' });
  await addUser(target.id, 'Preserved historical work');
  if (hold === 'chat-Off') await setGoalSwitchNow(target.conversationId!, 'goal', false);
  else { const config = defaultConfig(); config.ui.automationPaused = true; await saveConfig(config); }
  const reg = registrar();
  const read = textOf(await reg.call('session', { action: 'read', session_id: target.id }));
  const updateCursor = /update_cursor:\s*(\S+)/.exec(read)?.[1];
  expect(updateCursor).toBeTruthy();

  const result = await runInCallContext(caller(source), () => reg.call('session_route', {
    session_id: target.id, update_cursor: updateCursor!, text: 'Do not revive this paused historical owner.'
  }));

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('paused');
  expect(routed.send).not.toHaveBeenCalled();
  expect(routed.rows).toHaveLength(0);
});

it('shows exact message-level native delivery, model and turn evidence without upgrading unknown fields', async () => {
  const target = await createSession({ conversationId: 'receipt-target', title: 'Receipt evidence' });
  await observeSessionModel(target.id, 'receipt-target', 'gpt-6-thinking', Date.now(), 'high');
  await upsertMessageEvent(target.id, {
    kind: 'user_message', source: 'app', time: Date.now(), messageId: 'provider-user-1',
    inputId: 'outbox-1', inputDelivery: 'confirmed', model: 'gpt-6-thinking', reasoningEffort: 'high',
    turnId: 'turn-1', message: { text: 'Sent work', chars: 9, truncated: false }
  });
  await upsertMessageEvent(target.id, {
    kind: 'user_message', source: 'app', time: Date.now() + 1, messageId: 'provider-user-2',
    automationOrigin: 'goal', message: { text: 'Automatic work', chars: 14, truncated: false }
  });
  await upsertMessageEvent(target.id, {
    kind: 'user_message', source: 'extension', time: Date.now() + 2, messageId: 'provider-user-3',
    message: { text: 'Unowned work', chars: 12, truncated: false }
  });
  await upsertMessageEvent(target.id, {
    kind: 'assistant_message', source: 'extension', time: Date.now() + 3, messageId: 'assistant-1',
    turnId: 'turn-1', final: true, state: 'final',
    message: { text: 'Finished', chars: 8, truncated: false }
  });
  await appendEvent(target.id, {
    kind: 'tool_call', source: 'mcp', time: Date.now() + 4, turnId: 'turn-1',
    call: {
      callId: 'recorded-tool-1', tool: 'read', attribution: 'request_id',
      requestId: 'wfr-recorded-request-1', conversationId: 'receipt-target',
      attributionMethod: 'request_id',
      args: { text: '{}', chars: 2, truncated: false },
      result: { text: 'ok', chars: 2, truncated: false },
      outcome: 'ok', durationMs: 9, summary: { kind: 'read', tone: 'good', title: 'Read workspace' }
    }
  });
  const read = textOf(await registrar().call('session', { action: 'read', session_id: target.id }));
  expect(read).toContain('input=outbox-1');
  expect(read).toContain('send=confirmed');
  expect(read).toContain('model=gpt-6-thinking/high');
  expect(read).toContain('origin=goal');
  expect(read).toContain('native_send=observed');
  expect(read).toContain('send=unverified');
  expect(read).toContain('model=unverified');
  expect(read).toContain('assistant=final');
  expect(read).toContain('turn=turn-1');
  expect(read).toContain('core-request=wfr-recorded-request-1');
  expect(read).toContain('Last observed native picker: gpt-6-thinking/high');
  expect(read).toContain('(not Send proof)');
});

it('shows three helper attempt phases from the incumbent outbox without authorizing a replay', async () => {
  const source = await createSession({ conversationId: 'helper-source', title: 'Helper phases' });
  const base = {
    sessionId: null, text: 'Private helper draft must not leak', mode: 'after-turn' as const, dueAt: 0,
    model: 'gpt-6-thinking', reasoningEffort: 'high' as const, images: [],
    decisionSourceSessionId: source.id, purpose: 'decision' as const,
    state: 'cancelled' as const, owner: null, createdAt: 100,
    conversationId: null
  };
  routed.rows = [
    { ...base, id: '00000000-0000-4000-8000-000000000001', error: 'request_failed', createdAt: 100 },
    { ...base, id: '00000000-0000-4000-8000-000000000002', owner: 'browser-one', offeredAt: 110, error: 'request_failed', createdAt: 200 },
    { ...base, id: '00000000-0000-4000-8000-000000000003', offeredAt: 210, sendAuthorizedAt: 211, error: 'request_failed', createdAt: 300 }
  ];
  const read = textOf(await registrar().call('session', { action: 'read', session_id: source.id }));
  expect(read).toContain('phase=queued-unclaimed');
  expect(read).toContain('phase=browser-preparing');
  expect(read).toContain('phase=send-outcome-unconfirmed');
  expect(read).toContain('model=requested:gpt-6-thinking/high');
  expect(read).toContain('result=request-failed');
  expect(read).toContain('native-send=ambiguous-no-retry');
  expect(read).toContain('proof=ambiguous-send-boundary');
  expect(read).toContain('action=inspect-receipt');
  expect(read).toContain('action=wait-or-recover-same-helper');
  expect(read).toContain('action=eligible-for-new-claim');
  expect(read).toContain('observe=need-native-receipt-resolution');
  expect(read).toContain('observe=need-browser-custody-result');
  expect(read).toContain('transition=await-receipt-resolution');
  expect(read).toContain('transition=await-custody-resolution');
  expect(read).toContain('gap=authorization-without-custody-owner');
  expect(read).not.toContain('native-send=confirmed');
  expect(read).not.toContain('Private helper draft');
  expect(routed.send).not.toHaveBeenCalled();
  expect(routed.rows.every(row => row.state === 'cancelled')).toBe(true);
});

it('separates timed-out and retired helper custody from malformed answer evidence', async () => {
  const source = await createSession({ conversationId: 'helper-retired', title: 'Helper retire statuses' });
  const base = {
    sessionId: null, text: 'Do not expose the private helper body', mode: 'after-turn' as const, dueAt: 0,
    model: 'gpt-6-thinking', reasoningEffort: 'high' as const,
    decisionSourceSessionId: source.id, purpose: 'decision' as const,
    state: 'failed' as const, owner: null, createdAt: 100, conversationId: null
  };
  routed.rows = [
    { ...base, id: '00000000-0000-4000-8000-000000000004', error: 'Timed-out helper confirmed unsent before browser claim', createdAt: 100 },
    { ...base, id: '00000000-0000-4000-8000-000000000005', error: 'Timed-out helper retired for automatic retry', createdAt: 200 },
    { ...base, id: '00000000-0000-4000-8000-000000000006', error: 'invalid_goal_decision_json', createdAt: 300 }
  ];
  const read = textOf(await registrar().call('session', { action: 'read', session_id: source.id }));
  expect(read).toContain('result=timeout-confirmed-unsent');
  expect(read).toContain('result=timeout-retired');
  expect(read).toContain('result=malformed-output');
  expect(read).toContain('proof=confirmed-unsent-no-delivery');
  expect(read).toContain('proof=retired-before-terminal-delivery');
  expect(read).toContain('capture=delivery-evidence');
  expect(read).toContain('expected=delivery-evidence');
  expect(read).toContain('observed=none');
  expect(read).toContain('request=00000000-0000-4000-8000-000000000004');
  expect(read).toContain('source-session=' + source.id);
  expect(read).not.toContain('Do not expose the private helper body');
  expect(routed.send).not.toHaveBeenCalled();
});

it('exposes contradictory terminal evidence without resolving ownership by guess', async () => {
  const source = await createSession({ conversationId: 'helper-conflict', title: 'Helper conflict states' });
  routed.rows = [{
    id: '00000000-0000-4000-8000-000000000007',
    sessionId: null,
    text: 'private',
    mode: 'after-turn',
    dueAt: 0,
    model: 'gpt-6-thinking',
    reasoningEffort: 'high',
    decisionSourceSessionId: source.id,
    purpose: 'decision',
    state: 'failed',
    owner: null,
    createdAt: 400,
    conversationId: null,
    messageId: 'message-after-failure',
    deliveredAt: 401,
  } as InputEntry];

  const read = textOf(await registrar().call('session', { action: 'read', session_id: source.id }));
  expect(read).toContain('conflict=failed-state-with-delivery-evidence');
  expect(read).toContain('conflicting-fields=state,message-delivery');
  expect(read).toContain('evidence-set=state:failed,messageId,deliveredAt');
  expect(read).toContain('expected-owner=receipt-observer');
  expect(read).toContain('unresolved=terminal-classification');
  expect(read).toContain('next-observation=receipt-resolution-safe-to-observe');
  expect(read).toContain('transition=await-delivery-evidence');
  expect(read).not.toContain('proof=answer-recorded-receipt');
  expect(routed.send).not.toHaveBeenCalled();
});

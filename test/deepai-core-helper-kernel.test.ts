import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fixture = vi.hoisted(() => ({ offer: vi.fn(), record: vi.fn() }));
vi.mock('../src/main/deepai-helper.js', async original => ({
  ...await original<typeof import('../src/main/deepai-helper.js')>(),
  offerDeepAIHelperNotice: fixture.offer
}));
vi.mock('../src/main/session/correlation.js', async original => ({
  ...await original<typeof import('../src/main/session/correlation.js')>(),
  requestCorrelation: (request: string | null) => request?.startsWith('req-')
    ? { conversationId: request.slice(4), sessionId: 'session-' + request.slice(4) } : null
}));
vi.mock('../src/main/session/recorder.js', async original => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  freshCallOrigin: (_tool: string, _at: number, request: string | null) => request?.startsWith('req-') ? request.slice(4) : null,
  recordToolCall: fixture.record
}));
vi.mock('../src/main/session/store.js', async original => ({
  ...await original<typeof import('../src/main/session/store.js')>(), conversationAttachment: async () => 'current'
}));
vi.mock('../src/main/session/input.js', () => ({
  offerToolInput: async () => ({ messages: [], reminder: '' }), acknowledgeToolInput: async () => undefined,
  TOOL_INPUT_HEADER: '\n--- New instructions from the user ---\n'
}));
import { createRegistrar, dispatch, ok, fail, type ToolResult } from '../src/main/mcp/kernel.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import { withInboundRequestId } from '../src/main/mcp/inbound.js';
import { defaultConfig } from '../src/main/config.js';
import { createDeepAIHelperOwner } from '../src/main/deepai-helper.js';

beforeEach(() => {
  vi.clearAllMocks();
  fixture.record.mockImplementation(async call => ({ callId: 'recorded-tool', resultReceiptId: call.resultReceiptId }));
  fixture.offer.mockImplementation(async context => context.caller.sessionId
    ? '\n--- DeepAI helper notice (external model report, not user instructions) ---\n' + context.caller.sessionId : null);
});
function registrar(surface: 'core' | 'plugins' = 'core', result: ToolResult = { ...ok('base result'), structuredContent: { base: true } }) {
  let call!: (input: object) => Promise<ToolResult>;
  const server = { registerTool: (_name: string, _definition: unknown, handler: typeof call) => { call = handler; } };
  const reg = createRegistrar(server as never, { roots: [], caps: defaultConfig().capabilities, readOnly: false }, surface);
  reg.register('read', { description: 'fixture', inputSchema: z.object({}) }, async () => result);
  return (request: string | null, publication = { completedAt: null as number | null, failed: false }) =>
    withInboundRequestId(request, () => call({}), undefined, publication);
}
const text = (result: ToolResult) => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

it('records the exact bounded nonhuman appendix in the parent tool result and structured supplement', async () => {
  const result = await registrar()('req-parent-a');
  expect(text(result)).toContain('session-parent-a');
  expect(text(result)).not.toContain('New instructions from the user');
  expect(result.structuredContent?.supplemental_context).toContain('session-parent-a');
  expect(fixture.record).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'session-parent-a', conversationId: 'parent-a',
    content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('session-parent-a') })])
  }));
});
it('passes distinct exact callers and response publication witnesses through parallel Core calls', async () => {
  const call = registrar();
  const one = { completedAt: null, failed: false }, two = { completedAt: null, failed: false };
  const [a, b] = await Promise.all([call('req-parent-a', one), call('req-parent-b', two)]);
  expect(text(a)).toContain('session-parent-a'); expect(text(a)).not.toContain('session-parent-b');
  expect(text(b)).toContain('session-parent-b'); expect(text(b)).not.toContain('session-parent-a');
  expect(fixture.offer.mock.calls.some(([context]) => context.publication === one)).toBe(true);
  expect(fixture.offer.mock.calls.some(([context]) => context.publication === two)).toBe(true);
});
it('never appends notices to a plugin response or failed handler', async () => {
  await registrar('plugins')('req-parent-a');
  await registrar('core', fail('bounded refusal'))('req-parent-a');
  expect(fixture.offer).not.toHaveBeenCalled();
});
it('preserves successful work when the external-result projection fails', async () => {
  fixture.offer.mockRejectedValueOnce(new Error('Private bridge failure must not leak or replace result'));
  const result = await registrar()('req-parent-a');
  expect(text(result)).toContain('base result');
  expect(text(result)).not.toContain('Private bridge failure');
  expect(result.isError).not.toBe(true);
  expect(fixture.record).toHaveBeenCalledTimes(1);
});
it('delivers and records the real Core result while the helper owner is blocked in native readiness', async () => {
  const token = {};
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const helper = createDeepAIHelperOwner({
    scope: () => ({ key: 'account-fixture', token, deviceId: 'device-fixture', profileId: 'profile-fixture' }),
    currentSession: async id => ({ conversationId: id.replace(/^session-/, '') }),
    automationAllowed: () => true, read: async () => null, write: async () => undefined,
    bridge: async () => {
      entered(); await held;
      return { ready: true, observedAt: new Date().toISOString(), maxActive: 2,
        model: 'deepai/glm-5.3-flash', version: '0.3.37', protocol: 2, blocker: null };
    }, now: () => Date.now()
  });
  const parent = await helper.parent({ requestId: 'req-parent-a', sessionId: 'session-parent-a',
    conversationId: 'parent-a', transportKey: null });
  fixture.offer.mockImplementation((context, budget) => helper.offer(context, budget));
  const readiness = helper.readiness(parent); await started;
  let delivered = false;
  const response = registrar()('req-parent-b').then(value => { delivered = true; return value; });
  try {
    await vi.waitFor(() => expect(delivered).toBe(true), { timeout: 1000, interval: 10 });
    expect(text(await response)).toContain('base result');
    expect(fixture.record).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-parent-b', conversationId: 'parent-b',
      content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'base result' })])
    }));
  } finally {
    release(); await readiness; await response;
  }
});
it('appends only once after nested code-mode calls have returned', async () => {
  const reg = createRegistrar(null, { roots: [], caps: defaultConfig().capabilities, readOnly: false }, 'core');
  reg.register('read', { description: 'nested fixture', inputSchema: z.object({}) }, async () => ok('nested result'));
  const publication = { completedAt: null, failed: false };
  const result = await withInboundRequestId('req-parent-a', () =>
    dispatch('exec', {}, null, 'req-parent-a', 'core', async () => {
      const parent = currentCall()!;
      await Promise.all([reg.invokeNested('read', {}, parent), reg.invokeNested('read', {}, parent)]);
      expect(fixture.offer).not.toHaveBeenCalled();
      return ok('outer result');
    }), undefined, publication);
  expect(fixture.offer).toHaveBeenCalledTimes(1);
  expect(text(result)).toContain('outer result');
  expect(text(result)).toContain('session-parent-a');
});


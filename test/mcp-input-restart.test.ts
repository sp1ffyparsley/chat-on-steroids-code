import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer } from '../src/main/mcp/server.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { enqueueInput, listInputs, resetInputForTests } from '../src/main/session/input.js';
import { flushRecorder, resetRecorderForTests } from '../src/main/session/recorder.js';
import {
  appendEvent,
  createSession,
  flushSessions,
  initSessionStore,
  observeSessionModel,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

type Endpoint = Awaited<ReturnType<typeof startMcpServer>>;

describe('MCP tool-result input recovery across Main reconstruction', () => {
  let directory = '';
  let endpoint: Endpoint | null = null;

  afterEach(async () => {
    if (endpoint) await endpoint.stop();
    endpoint = null;
    await flushDurable().catch(() => undefined);
    await flushSessions().catch(() => undefined);
    await flushRecorder().catch(() => undefined);
    resetInputForTests();
    resetRecorderForTests();
    resetCorrelationRegistryForTests();
    resetSessionStoreForTests();
    resetDurableForTests();
    if (directory) await removeTempDir(directory);
    directory = '';
  });

  async function boot() {
    initDurableStore(directory);
    initSessionStore(directory);
    initConfigPath(directory);
    const config = defaultConfig();
    await saveConfig(config);
    endpoint = await startMcpServer(() => ({
      roots: [{ name: 'workspace', path: directory }],
      caps: config.capabilities,
      readOnly: true,
      sessionTools: false,
      agentTools: false
    }));
    return config;
  }

  async function reconstruct() {
    if (endpoint) await endpoint.stop();
    endpoint = null;
    await flushRecorder();
    await flushSessions();
    await flushDurable();
    resetInputForTests();
    resetRecorderForTests();
    resetCorrelationRegistryForTests();
    resetSessionStoreForTests();
    resetDurableForTests();
    await boot();
  }

  async function call(
    requestId: string,
    conversationId: string,
    sessionId: string,
    messageId: string
  ) {
    if (!endpoint) throw new Error('MCP endpoint is not running');
    expect(observeRequestCorrelation({
      requestId,
      conversationId,
      sessionId,
      messageId,
      tool: 'read',
      observedAt: Date.now()
    })).toBe('stored');
    const response = await fetch(endpoint.urls.core, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-request-id': `${requestId}/attempt`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: { name: 'read', arguments: { paths: ['/workspace/example.txt'] } }
      })
    });
    const raw = await response.text();
    const json = JSON.parse(raw.startsWith('event:') || raw.startsWith('data:')
      ? raw.split('\n').find(line => line.startsWith('data:'))!.slice(5)
      : raw);
    const text = json.result.content
      .filter((row: { type: string }) => row.type === 'text')
      .map((row: { text: string }) => row.text)
      .join('\n');
    return { json, text };
  }

  async function setupCase(text: string) {
    directory = await makeTempDir('clf-mcp-input-restart-');
    await boot();
    await fs.writeFile(path.join(directory, 'example.txt'), 'restart delivery fixture');
    const conversationId = randomUUID();
    const session = await createSession({ conversationId, title: 'MCP restart delivery' });
    // Pro retains tool-result injection. Non-Pro steering now owns native delivery.
    await observeSessionModel(session.id, conversationId, 'gpt-6-pro', Date.now(), 'pro');
    await appendEvent(session.id, {
      kind: 'turn_start',
      source: 'extension',
      turnId: 'restart-delivery-turn',
      time: Date.now()
    });
    const input = await enqueueInput({
      id: randomUUID(),
      sessionId: session.id,
      text,
      mode: 'auto',
      dueAt: 0,
      model: null,
      reasoningEffort: null
    });
    return { conversationId, sessionId: session.id, input };
  }

  it('does not inject the same model-visible instruction again after it reached ChatGPT before Main reconstruction', async () => {
    const authored = 'Do the restart-sensitive instruction exactly once';
    const { conversationId, sessionId, input } = await setupCase(authored);

    const first = await call('wfr_tool_input_before_restart', conversationId, sessionId, 'tool-call-before-restart');
    expect(first.text).toContain(authored);
    expect(first.text.match(/--- New instructions from the user ---/g)).toHaveLength(1);
    expect((await listInputs()).find(row => row.id === input.id)).toMatchObject({ state: 'tool' });

    // Reconstruct all process-local owners that participate in this path. The durable outbox and
    // session/history files are the only delivery state allowed to survive this boundary.
    await reconstruct();

    const second = await call('wfr_tool_input_after_restart', conversationId, sessionId, 'tool-call-after-restart');
    expect(second.text).not.toContain(authored);
    expect(second.text).not.toContain('--- New instructions from the user ---');
    expect((await listInputs()).find(row => row.id === input.id)).toMatchObject({
      state: 'tool',
      toolReceiptUncertain: true,
      error: expect.stringContaining('automatic replay is blocked')
    });
  });

  it('still delivers a queued instruction that was never offered before Main reconstruction', async () => {
    const authored = 'This instruction is still definitely owed';
    const { conversationId, sessionId, input } = await setupCase(authored);
    expect((await listInputs()).find(row => row.id === input.id)).toMatchObject({ state: 'queued' });

    await reconstruct();

    const delivered = await call('wfr_known_unsent_after_restart', conversationId, sessionId, 'known-unsent-call');
    expect(delivered.text).toContain(authored);
    expect(delivered.text.match(/--- New instructions from the user ---/g)).toHaveLength(1);
  });

  it('keeps a durably acknowledged tool instruction sent across another Main reconstruction', async () => {
    const authored = 'Do not return after the durable receipt';
    const { conversationId, sessionId, input } = await setupCase(authored);
    const first = await call('wfr_known_delivered_first', conversationId, sessionId, 'known-delivered-first');
    expect(first.text).toContain(authored);
    const receipt = await call('wfr_known_delivered_receipt', conversationId, sessionId, 'known-delivered-receipt');
    expect(receipt.text).not.toContain(authored);
    expect((await listInputs()).find(row => row.id === input.id)).toMatchObject({ state: 'sent' });

    await reconstruct();

    const after = await call('wfr_known_delivered_after_restart', conversationId, sessionId, 'known-delivered-after-restart');
    expect(after.text).not.toContain(authored);
  });
});

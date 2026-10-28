import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  AntigravityCliProcess,
  AntigravityProcessError,
  type AntigravityChildProcess,
  type AntigravitySpawn
} from '../src/main/providers/antigravity-process.js';
import { AntigravityProtocolError } from '../src/main/providers/antigravity-stream.js';
import type { ProviderProgressEvent } from '../src/shared/provider-adapter.js';

class FakeChild extends EventEmitter implements AntigravityChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.exitCode !== null) return false;
    this.signals.push(signal);
    this.finish(1, typeof signal === 'string' ? signal : null);
    return true;
  }

  finish(code: number, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    queueMicrotask(() => this.emit('close', code, signal));
  }

  event(value: unknown, newline = true): void {
    this.stdout.write(`${JSON.stringify(value)}${newline ? '\n' : ''}`);
  }
}

class StuckChild extends FakeChild {
  override kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return false;
  }
}

class DelayedKillChild extends FakeChild {
  constructor(private readonly delayMs: number) {
    super();
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    if (this.exitCode !== null) return false;
    this.signals.push(signal);
    setTimeout(() => this.finish(1, typeof signal === 'string' ? signal : null), this.delayMs);
    return true;
  }
}

function init(conversationId = 'conv-1', model = 'gemini-3-pro'): unknown {
  return {
    event: 'init',
    conversation_id: conversationId,
    init: { cwd: 'C:\\project', tools: ['read_file', 'shell'], model }
  };
}

function step(
  stepIndex: number,
  stepType: 'user_input' | 'agent_response' | 'tool' | 'checkpoint',
  state: 'ACTIVE' | 'DONE',
  extra: Record<string, unknown> = {}
): unknown {
  return {
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-1',
      step_index: stepIndex,
      state,
      step_type: stepType,
      ...extra
    }
  };
}

function result(response: string, numTurns: number, extra: Record<string, unknown> = {}): unknown {
  return {
    event: 'result',
    result: {
      conversation_id: 'conv-1',
      status: 'SUCCESS',
      response,
      num_turns: numTurns,
      ...extra
    }
  };
}

function fixture(options: {
  nativeConversationId?: string | null;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
  onConversation?: (nativeConversationId: string) => void | Promise<void>;
  child?: FakeChild;
} = {}): {
  child: FakeChild;
  process: AntigravityCliProcess;
  spawnCalls: Array<{ executable: string; args: readonly string[] }>;
  writes: string[];
} {
  const child = options.child ?? new FakeChild();
  const spawnCalls: Array<{ executable: string; args: readonly string[] }> = [];
  const writes: string[] = [];
  child.stdin.on('data', chunk => writes.push(String(chunk)));
  const spawnProcess: AntigravitySpawn = (executable, args) => {
    spawnCalls.push({ executable, args: [...args] });
    return child;
  };
  const process = new AntigravityCliProcess({
    cwd: 'C:\\project',
    selectedModel: 'gemini-3-pro',
    nativeConversationId: options.nativeConversationId,
    startupTimeoutMs: options.startupTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    onConversation: options.onConversation,
    spawnProcess,
    now: () => 1234
  });
  return { child, process, spawnCalls, writes };
}

async function waitForWrite(writes: string[], count: number): Promise<void> {
  await vi.waitFor(() => expect(writes.join('').trim().split(/\n+/).filter(Boolean)).toHaveLength(count));
}

describe('persistent Antigravity CLI process boundary', () => {
  it('uses one warmed process for sequential turns and emits typed progress from provider activity', async () => {
    const { child, process, spawnCalls, writes } = fixture();
    const progress: ProviderProgressEvent[] = [];
    const beforeWrite = vi.fn();
    const accepted = vi.fn();
    const terminal = vi.fn();
    const first = process.sendTurn('turn-1', 'first prompt', {
      beforeWrite,
      onAccepted: accepted,
      onTerminal: terminal,
      progress: event => { progress.push(event); }
    });
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    expect(spawnCalls[0]?.args).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', 'gemini-3-pro'
    ]);
    expect(spawnCalls[0]?.args).not.toContain('--dangerously-skip-permissions');

    child.event(init());
    await waitForWrite(writes, 1);
    child.event(step(0, 'user_input', 'DONE'));
    child.event(step(1, 'agent_response', 'ACTIVE', { text_delta: 'hel' }));
    child.event(step(2, 'tool', 'DONE', {
      tool_name: 'read_file',
      tool_info: { name: 'read_file', parameters: { path: 'a.txt' }, output: 'ok' },
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }
    }));
    child.event(result('hello', 1, { usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } }));

    await expect(first).resolves.toMatchObject({
      outcome: 'completed',
      nativeConversationId: 'conv-1',
      response: 'hello',
      usage: { totalTokens: 10, scope: 'session' }
    });
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'opening provider' }),
      expect.objectContaining({ state: 'accepted' }),
      expect.objectContaining({ state: 'model working', textDelta: 'hel', nativeEvent: { type: 'agent_response', index: 1, state: 'ACTIVE' } }),
      expect.objectContaining({
        state: 'tool working',
        toolName: 'read_file',
        tool: { name: 'read_file' },
        usage: expect.objectContaining({ totalTokens: 4, scope: 'step' })
      }),
      expect.objectContaining({ state: 'completed' })
    ]));
    const toolProgress = progress.find(event => event.toolName === 'read_file');
    expect(toolProgress?.tool).not.toHaveProperty('input');
    expect(toolProgress?.tool).not.toHaveProperty('output');

    const firstTerminal = result('hello', 1, { usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } });
    const second = process.sendTurn('turn-2', 'second prompt', {
      beforeWrite: vi.fn(),
      progress: event => { progress.push(event); }
    });
    await waitForWrite(writes, 2);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    child.event(firstTerminal);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    child.event(step(3, 'user_input', 'DONE'));
    child.event(result('second done', 2));
    await expect(second).resolves.toMatchObject({ response: 'second done', outcome: 'completed' });
    expect(spawnCalls).toHaveLength(1);

    const sent = writes.join('').trim().split(/\n+/).map(line => JSON.parse(line));
    expect(sent).toEqual([
      { event: 'user', message: { content: 'first prompt' } },
      { event: 'user', message: { content: 'second prompt' } }
    ]);
  });

  it('reserves same-process turn ownership before startup so concurrent sends cannot both write', async () => {
    const { child, process, spawnCalls, writes } = fixture();
    const first = process.sendTurn('turn-one-owner', 'first only', { beforeWrite: vi.fn() });
    const second = process.sendTurn('turn-overlap', 'must never write', { beforeWrite: vi.fn() });

    await expect(second).rejects.toThrow('already has active turn turn-one-owner');
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    child.event(init());
    await waitForWrite(writes, 1);
    child.event(result('first done', 1));
    await expect(first).resolves.toMatchObject({ response: 'first done' });
    expect(writes.join('')).toContain('first only');
    expect(writes.join('')).not.toContain('must never write');
  });

  it('pins the requested model and native conversation on a resumed process launch', async () => {
    const { child, process, spawnCalls, writes } = fixture({ nativeConversationId: 'conv-1' });
    const turn = process.sendTurn('turn-resume', 'resume prompt', { beforeWrite: vi.fn() });
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    expect(spawnCalls[0]?.args).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', 'gemini-3-pro',
      '--conversation', 'conv-1'
    ]);
    child.event(init('conv-1'));
    await waitForWrite(writes, 1);
    child.event(result('resumed', 3));
    await expect(turn).resolves.toMatchObject({ response: 'resumed' });
  });

  it('refuses a provider model substitution before any prompt is written', async () => {
    const { child, process, writes } = fixture();
    const turn = process.sendTurn('turn-wrong-model', 'must not send', { beforeWrite: vi.fn() });
    child.event(init('conv-1', 'gemini-something-else'));
    await expect(turn).rejects.toBeInstanceOf(AntigravityProtocolError);
    expect(writes).toEqual([]);
    expect(child.signals).toHaveLength(1);
  });

  it('classifies an official pre-init model error without crossing the durable submission barrier', async () => {
    const { child, process, spawnCalls, writes } = fixture();
    const beforeWrite = vi.fn();
    const turn = process.sendTurn('turn-pre-init-error', 'must not send', { beforeWrite });
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    child.event({
      event: 'result',
      result: {
        conversation_id: '',
        status: 'ERROR',
        response: '',
        error: 'invalid model selection: unknown model gemini-imaginary'
      }
    });

    await expect(turn).rejects.toSatisfy((error: unknown) =>
      error instanceof AntigravityProcessError &&
      error.failure.kind === 'unknown_model' &&
      error.failure.advice.retryable === false
    );
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('fails closed on malformed stream output after submission and never writes the prompt twice', async () => {
    const { child, process, writes } = fixture();
    const turn = process.sendTurn('turn-bad-json', 'only once', { beforeWrite: vi.fn() });
    child.event(init());
    await waitForWrite(writes, 1);
    child.stdout.write('{not-json}\n');
    await expect(turn).rejects.toBeInstanceOf(AntigravityProtocolError);
    expect(writes.join('').match(/only once/g)).toHaveLength(1);
    expect(child.signals).toHaveLength(1);
  });

  it('does not spawn a replacement until a protocol-failed child reaches its real close event', async () => {
    const children = [new DelayedKillChild(30), new FakeChild()];
    const writes: string[][] = [[], []];
    children.forEach((child, index) => child.stdin.on('data', chunk => writes[index]!.push(String(chunk))));
    let spawnCount = 0;
    const process = new AntigravityCliProcess({
      cwd: 'C:\\project',
      selectedModel: 'gemini-3-pro',
      closeTimeoutMs: 100,
      spawnProcess: () => children[spawnCount++]!
    });

    const first = process.sendTurn('turn-retire-first', 'first once', { beforeWrite: vi.fn() });
    children[0]!.event(init());
    await waitForWrite(writes[0]!, 1);
    children[0]!.stdout.write('{malformed}\n');
    await expect(first).rejects.toBeInstanceOf(AntigravityProtocolError);

    const second = process.sendTurn('turn-retire-second', 'second once', { beforeWrite: vi.fn() });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(spawnCount).toBe(1);
    await vi.waitFor(() => expect(spawnCount).toBe(2));
    children[1]!.event(init());
    await waitForWrite(writes[1]!, 1);
    children[1]!.event(result('second done', 1));
    await expect(second).resolves.toMatchObject({ response: 'second done' });
    expect(writes[0]!.join('').match(/first once/g)).toHaveLength(1);
    expect(writes[1]!.join('').match(/second once/g)).toHaveLength(1);
  });

  it('keeps replacement startup blocked when a retired child cannot be proven closed', async () => {
    const stuck = new StuckChild();
    const writes: string[] = [];
    stuck.stdin.on('data', chunk => writes.push(String(chunk)));
    let spawnCount = 0;
    const process = new AntigravityCliProcess({
      cwd: 'C:\\project',
      selectedModel: 'gemini-3-pro',
      closeTimeoutMs: 10,
      spawnProcess: () => {
        spawnCount += 1;
        return stuck;
      }
    });

    const first = process.sendTurn('turn-stuck-retire', 'first once', { beforeWrite: vi.fn() });
    stuck.event(init());
    await waitForWrite(writes, 1);
    stuck.stdout.write('{malformed}\n');
    await expect(first).rejects.toBeInstanceOf(AntigravityProtocolError);

    const second = process.sendTurn('turn-after-stuck-retire', 'must never spawn', { beforeWrite: vi.fn() });
    await expect(second).rejects.toMatchObject({
      name: 'AntigravityProcessError',
      failure: { kind: 'unavailable', advice: { retryable: false } }
    });
    expect(spawnCount).toBe(1);
    expect(writes.join('')).not.toContain('must never spawn');

    // Retire the synthetic process object after the assertion so the fixture owns no open handles.
    stuck.exitCode = 1;
    stuck.emit('close', 1, null);
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it('rejects a post-init SUCCESS result that loses the pinned conversation id', async () => {
    const { child, process, writes } = fixture();
    const turn = process.sendTurn('turn-empty-id', 'one prompt', { beforeWrite: vi.fn() });
    child.event(init());
    await waitForWrite(writes, 1);
    child.event({
      event: 'result',
      result: { conversation_id: '', status: 'SUCCESS', response: 'invalid success' }
    });
    await expect(turn).rejects.toThrow('lost its initialized conversation id');
    expect(writes.join('').match(/one prompt/g)).toHaveLength(1);
  });

  it('does not let delayed untagged stderr from a prior turn classify the next terminal result', async () => {
    const { child, process, writes } = fixture();
    const first = process.sendTurn('turn-stderr-one', 'first', { beforeWrite: vi.fn() });
    child.event(init());
    await waitForWrite(writes, 1);
    child.event(result('first done', 1));
    await expect(first).resolves.toMatchObject({ outcome: 'completed' });

    const second = process.sendTurn('turn-stderr-two', 'second', { beforeWrite: vi.fn() });
    await waitForWrite(writes, 2);
    // stdout/stderr are independent pipes. This line is intentionally delivered after turn two
    // starts even though it represents a late notice from turn one.
    child.stderr.write('permission denied: headless tool soft-denied\n');
    child.event({
      event: 'result',
      result: {
        conversation_id: 'conv-1',
        status: 'ERROR',
        response: '',
        error: 'HTTP 503 service unavailable'
      }
    });
    await expect(second).resolves.toMatchObject({
      outcome: 'failed',
      failure: { kind: 'transient', advice: { retryable: true } }
    });
  });

  it.each(['before acceptance', 'after acceptance'] as const)(
    'treats a provider crash %s as non-retryable at the process boundary',
    async phase => {
      const { child, process, writes } = fixture();
      const accepted = vi.fn();
      const turn = process.sendTurn(`turn-crash-${phase}`, 'ambiguous send', {
        beforeWrite: vi.fn(),
        onAccepted: accepted
      });
      child.event(init());
      await waitForWrite(writes, 1);
      if (phase === 'after acceptance') {
        child.event(step(0, 'user_input', 'DONE'));
        await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
      }
      child.finish(1);
      await expect(turn).rejects.toMatchObject({
        name: 'AntigravityProcessError',
        failure: { advice: { retryable: false } }
      });
      expect(writes.join('').match(/ambiguous send/g)).toHaveLength(1);
    }
  );

  it('consumes one complete terminal event even when the process closes without a final newline', async () => {
    const { child, process, writes } = fixture();
    const turn = process.sendTurn('turn-tail', 'tail prompt', { beforeWrite: vi.fn() });
    child.event(init());
    await waitForWrite(writes, 1);
    child.event(result('tail result', 1), false);
    child.finish(0);
    await expect(turn).resolves.toMatchObject({ response: 'tail result', outcome: 'completed' });
  });

  it('times out startup before the durable submission hook or stdin write', async () => {
    const { child, process, writes } = fixture({ startupTimeoutMs: 10 });
    const beforeWrite = vi.fn();
    await expect(process.sendTurn('turn-timeout', 'never written', { beforeWrite })).rejects.toMatchObject({
      name: 'AntigravityProcessError',
      failure: { kind: 'startup_timeout', advice: { retryable: true } }
    });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(child.signals).toHaveLength(1);
  });

  it('does not let a late durable init hook resurrect a process after startup timeout', async () => {
    const children = [new FakeChild(), new FakeChild()];
    const writes: string[][] = [[], []];
    children.forEach((child, index) => child.stdin.on('data', chunk => writes[index]!.push(String(chunk))));
    let spawnCount = 0;
    let conversationCalls = 0;
    let releaseFirst!: () => void;
    const firstConversation = new Promise<void>(resolve => { releaseFirst = resolve; });
    const process = new AntigravityCliProcess({
      cwd: 'C:\\project',
      selectedModel: 'gemini-3-pro',
      startupTimeoutMs: 100,
      spawnProcess: () => children[spawnCount++]!,
      onConversation: async () => {
        conversationCalls += 1;
        if (conversationCalls === 1) await firstConversation;
      }
    });

    const first = process.sendTurn('turn-late-init', 'never written', { beforeWrite: vi.fn() });
    await vi.waitFor(() => expect(spawnCount).toBe(1));
    children[0]!.event(init());
    await expect(first).rejects.toMatchObject({
      name: 'AntigravityProcessError',
      failure: { kind: 'startup_timeout' }
    });
    releaseFirst();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(process.inspect()).toMatchObject({ ready: false, running: false, busy: false });

    const second = process.sendTurn('turn-after-late-init', 'resume safely', { beforeWrite: vi.fn() });
    await vi.waitFor(() => expect(spawnCount).toBe(2));
    children[1]!.event(init());
    await waitForWrite(writes[1]!, 1);
    children[1]!.event(result('recovered', 1));
    await expect(second).resolves.toMatchObject({ response: 'recovered' });
    expect(writes[0]).toEqual([]);
  });

  it('ignores provider identity first delivered by an already-retired startup process', async () => {
    const onConversation = vi.fn();
    const { child, process, writes } = fixture({ startupTimeoutMs: 10, onConversation });
    const turn = process.sendTurn('turn-retired-init', 'never written', { beforeWrite: vi.fn() });
    await expect(turn).rejects.toMatchObject({
      name: 'AntigravityProcessError',
      failure: { kind: 'startup_timeout' }
    });

    child.event(init('late-retired-conversation'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(process.inspect()).toMatchObject({
      ready: false,
      running: false,
      nativeConversationId: null,
      availableTools: []
    });
    expect(onConversation).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('cancels by interrupting only its own provider process without synthesizing a safe replay', async () => {
    const { child, process, writes } = fixture();
    const turn = process.sendTurn('turn-cancel', 'cancel me once', { beforeWrite: vi.fn() });
    child.event(init());
    await waitForWrite(writes, 1);
    await process.cancelCurrent();
    await expect(turn).rejects.toSatisfy((error: unknown) =>
      error instanceof AntigravityProcessError && error.failure.advice.retryable === false
    );
    expect(child.signals).toContain('SIGINT');
    expect(writes.join('').match(/cancel me once/g)).toHaveLength(1);
  });

  it('keeps independent provider processes isolated so one busy turn does not block another', async () => {
    const a = fixture();
    const b = fixture();
    const turnA = a.process.sendTurn('turn-a', 'A', { beforeWrite: vi.fn() });
    const turnB = b.process.sendTurn('turn-b', 'B', { beforeWrite: vi.fn() });
    a.child.event(init());
    b.child.event(init());
    await Promise.all([waitForWrite(a.writes, 1), waitForWrite(b.writes, 1)]);
    b.child.event(result('B done', 1));
    await expect(turnB).resolves.toMatchObject({ response: 'B done' });
    let aSettled = false;
    void turnA.then(() => { aSettled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(aSettled).toBe(false);
    a.child.event(result('A done', 1));
    await expect(turnA).resolves.toMatchObject({ response: 'A done' });
  });

  it('waits for the owned child to exit after graceful stdin close', async () => {
    const { child, process, writes } = fixture({ closeTimeoutMs: 20 });
    const turn = process.sendTurn('turn-before-close', 'finish first', { beforeWrite: vi.fn() });
    child.event(init());
    await waitForWrite(writes, 1);
    child.event(result('done', 1));
    await expect(turn).resolves.toMatchObject({ outcome: 'completed' });
    child.stdin.once('finish', () => child.finish(0));

    await process.close();
    expect(child.exitCode).toBe(0);
    expect(child.signals).toEqual([]);
    expect(process.inspect()).toMatchObject({ running: false, ready: false });
  });

  it('forces only its owned child down after bounded graceful-close timeout', async () => {
    const { child, process, writes } = fixture({ closeTimeoutMs: 10 });
    const turn = process.sendTurn('turn-before-forced-close', 'finish first', { beforeWrite: vi.fn() });
    child.event(init());
    await waitForWrite(writes, 1);
    child.event(result('done', 1));
    await expect(turn).resolves.toMatchObject({ outcome: 'completed' });

    await process.close();
    expect(child.exitCode).toBe(1);
    expect(child.signals).toEqual([undefined]);
    expect(process.inspect()).toMatchObject({ running: false, ready: false });
  });

  it('waits for the actual close event when exitCode appears first', async () => {
    const { child, process, writes } = fixture({ closeTimeoutMs: 100 });
    const turn = process.sendTurn('turn-exit-before-close', 'finish first', { beforeWrite: vi.fn() });
    child.event(init());
    await waitForWrite(writes, 1);
    child.event(result('done', 1));
    await expect(turn).resolves.toMatchObject({ outcome: 'completed' });

    child.exitCode = 0;
    let settled = false;
    const closing = process.close().then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    child.emit('close', 0, null);
    await closing;
    expect(process.inspect()).toMatchObject({ running: false, ready: false });
  });

  it('fails loudly when its owned child ignores both graceful close and forced shutdown', async () => {
    const child = new StuckChild();
    const { process, writes } = fixture({ child, closeTimeoutMs: 10 });
    const turn = process.sendTurn('turn-stuck-close', 'finish first', { beforeWrite: vi.fn() });
    child.event(init());
    await waitForWrite(writes, 1);
    child.event(result('done', 1));
    await expect(turn).resolves.toMatchObject({ outcome: 'completed' });

    await expect(process.close()).rejects.toMatchObject({
      name: 'AntigravityProcessError',
      failure: { kind: 'unavailable', advice: { retryable: false } }
    });
    expect(child.signals).toEqual([undefined]);

    // Retire the synthetic child so the test leaves no dangling lifecycle listeners.
    child.exitCode = 1;
    child.emit('close', 1, null);
    await new Promise<void>(resolve => setImmediate(resolve));
  });
});

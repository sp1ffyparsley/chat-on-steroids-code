import { describe, expect, it } from 'vitest';

import {
  AntigravityNdjsonParser,
  AntigravityProtocolError,
  MAX_ANTIGRAVITY_STREAM_LINE_BYTES,
  antigravityStepWorkState,
  classifyAntigravityFailure,
  normalizeAntigravityResult,
  parseAntigravityStreamLine
} from '../src/main/providers/antigravity-stream.js';

const initEvent = {
  event: 'init',
  conversation_id: 'conv-1',
  init: {
    cwd: 'C:\\project',
    tools: ['shell', 'read_file'],
    permission_mode: 'auto',
    model: 'gemini-3-pro'
  }
};

const acceptedEvent = {
  event: 'step_update',
  step_update: {
    conversation_id: 'conv-1',
    step_index: 0,
    state: 'DONE',
    step_type: 'user_input'
  }
};

const resultEvent = {
  event: 'result',
  result: {
    conversation_id: 'conv-1',
    status: 'SUCCESS',
    response: 'done',
    num_turns: 1,
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      thinking_tokens: 2,
      cache_read_tokens: 4,
      total_tokens: 19
    }
  }
};

describe('Antigravity stream-json parser', () => {
  it('reassembles chunked NDJSON and keeps one stable native conversation', () => {
    const parser = new AntigravityNdjsonParser();
    const wire = [initEvent, acceptedEvent, resultEvent].map(event => JSON.stringify(event)).join('\n') + '\n';
    const split = Math.floor(wire.length / 2);

    const first = parser.push(wire.slice(0, split));
    const second = parser.push(wire.slice(split));
    const events = [...first, ...second, ...parser.finish()];

    expect(events).toHaveLength(3);
    expect(events.map(event => event.event)).toEqual(['init', 'step_update', 'result']);
    expect(events[0]).toMatchObject({ event: 'init', conversation_id: 'conv-1' });
    expect(events[1]).toMatchObject({
      event: 'step_update',
      step_update: { conversation_id: 'conv-1', step_index: 0, state: 'DONE', step_type: 'user_input' }
    });
    expect(events[2]).toMatchObject({
      event: 'result',
      result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'done' }
    });
  });

  it('accepts a final complete JSON event without a newline when the stream closes', () => {
    const parser = new AntigravityNdjsonParser();
    expect(parser.push(JSON.stringify(initEvent))).toEqual([]);
    expect(parser.finish()).toMatchObject([{ event: 'init', conversation_id: 'conv-1' }]);
  });

  it('preserves future event names without mistaking malformed known events for extensions', () => {
    expect(parseAntigravityStreamLine(JSON.stringify({ event: 'future_status', value: 1 }))).toMatchObject({
      event: 'unknown',
      eventName: 'future_status'
    });
    expect(() => parseAntigravityStreamLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } })))
      .toThrow(AntigravityProtocolError);
    expect(() => parseAntigravityStreamLine('{ definitely not json'))
      .toThrow('malformed JSON');
  });

  it('preserves a future step category inside the documented step_update envelope', () => {
    const parsed = parseAntigravityStreamLine(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-1',
        step_index: 8,
        state: 'ACTIVE',
        step_type: 'future_agent_phase'
      }
    }));
    expect(parsed).toMatchObject({
      event: 'step_update',
      step_update: { step_type: 'future_agent_phase', step_index: 8 }
    });
    if (parsed.event !== 'step_update') throw new Error('fixture did not parse as a step');
    expect(antigravityStepWorkState(parsed.step_update)).toBeNull();
  });

  it('requires a documented response string even when an error response is empty', () => {
    expect(() => parseAntigravityStreamLine(JSON.stringify({
      event: 'result',
      result: { conversation_id: '', status: 'ERROR', error: 'unknown model' }
    }))).toThrow('result.response');
  });

  it('bounds a single unterminated provider event before it can grow without limit', () => {
    const parser = new AntigravityNdjsonParser();
    const oversized = 'x'.repeat(MAX_ANTIGRAVITY_STREAM_LINE_BYTES + 1);
    expect(() => parser.push(oversized)).toThrow('exceeded');
    expect(parser.finish()).toEqual([]);
  });

  it('normalizes cumulative terminal usage without losing provider status', () => {
    const parsed = parseAntigravityStreamLine(JSON.stringify(resultEvent));
    if (parsed.event !== 'result') throw new Error('fixture did not parse as a result');
    const normalized = normalizeAntigravityResult(parsed);
    expect(normalized).toMatchObject({
      providerId: 'antigravity',
      nativeConversationId: 'conv-1',
      outcome: 'completed',
      providerStatus: 'SUCCESS',
      response: 'done',
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        thinkingTokens: 2,
        cacheReadTokens: 4,
        totalTokens: 19,
        scope: 'session'
      },
      failure: null
    });
  });

  it('never invents an interactive approval wait for headless CLI tool activity', () => {
    const parsed = parseAntigravityStreamLine(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-1',
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'ask_permission'
      }
    }));
    if (parsed.event !== 'step_update') throw new Error('fixture did not parse as a step');
    expect(antigravityStepWorkState(parsed.step_update)).toBe('tool working');
  });
});

describe('Antigravity failure classification', () => {
  it.each([
    ['429 rate limit; Retry-After: 12 s', 'rate_limited', true, 12_000],
    ['HTTP 503 service unavailable', 'transient', true, null],
    ['authentication required: credentials expired', 'authentication', false, null],
    ['invalid model selection: model is not recognized as a known model', 'unknown_model', false, null],
    ['permission denied by policy', 'permission', false, null],
    ['MCP startup timed out after 10 seconds', 'startup_timeout', true, null],
    ['invalid input: unsupported message block', 'malformed_input', false, null]
  ] as const)('classifies %s', (text, kind, retryable, retryAfterMs) => {
    expect(classifyAntigravityFailure(text)).toMatchObject({
      kind,
      advice: { retryable, retryAfterMs }
    });
  });

  it('does not silently reinterpret an unavailable model as a transient fallback', () => {
    const parsed = parseAntigravityStreamLine(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: '',
        status: 'ERROR',
        response: '',
        error: 'invalid model selection: unknown model gemini-imaginary'
      }
    }));
    if (parsed.event !== 'result') throw new Error('fixture did not parse as a result');
    expect(normalizeAntigravityResult(parsed)).toMatchObject({
      nativeConversationId: null,
      outcome: 'failed',
      failure: { kind: 'unknown_model', advice: { retryable: false } }
    });
  });

  it('keeps correlated provider error evidence ahead of untagged stderr', () => {
    expect(classifyAntigravityFailure(
      'HTTP 503 service unavailable',
      'permission denied: late stderr from another lifecycle event'
    )).toMatchObject({
      kind: 'transient',
      advice: { retryable: true }
    });
    expect(classifyAntigravityFailure(
      'unclassified provider failure',
      '429 rate limit; Retry-After: 3 s'
    )).toMatchObject({
      kind: 'rate_limited',
      advice: { retryable: true, retryAfterMs: 3_000 }
    });
  });
});

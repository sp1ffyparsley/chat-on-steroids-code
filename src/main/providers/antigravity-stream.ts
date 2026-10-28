/**
 * Pure parser and normalization for Antigravity CLI's documented stream-json protocol.
 *
 * No authentication, CLI discovery or process execution lives here. Keeping the wire parser pure
 * makes malformed output, duplicate events and terminal error classification reproducible with
 * recorded/synthetic fixtures and avoids ever needing the user's live provider account in tests.
 */

import type {
  ProviderFailure,
  ProviderTerminalResult,
  ProviderUsage,
  ProviderWorkState
} from '../../shared/provider-adapter.js';

export const ANTIGRAVITY_TERMINAL_STATUSES = [
  'SUCCESS',
  'ERROR',
  'CANCELED',
  'INTERRUPTED',
  'INVALID',
  'WAITING',
  'RUNNING'
] as const;
export type AntigravityTerminalStatus = (typeof ANTIGRAVITY_TERMINAL_STATUSES)[number];

export const ANTIGRAVITY_STEP_STATES = ['ACTIVE', 'DONE'] as const;
export type AntigravityStepState = (typeof ANTIGRAVITY_STEP_STATES)[number];

export const ANTIGRAVITY_STEP_TYPES = ['user_input', 'agent_response', 'tool', 'checkpoint'] as const;
/**
 * The docs describe these as observed categories, not a permanently closed enum. Preserve future
 * categories instead of turning a provider extension into stream corruption.
 */
export type AntigravityStepType = string;

/** One provider event may carry tool output, so bound one NDJSON record independently of chunks. */
export const MAX_ANTIGRAVITY_STREAM_LINE_BYTES = 2 * 1024 * 1024;

export interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AntigravityInitEvent {
  event: 'init';
  conversation_id: string;
  init: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
    model?: string;
    agent?: string;
    [key: string]: unknown;
  };
}

export interface AntigravityStepUpdateEvent {
  event: 'step_update';
  step_update: {
    conversation_id: string;
    step_index: number;
    state: AntigravityStepState;
    step_type: AntigravityStepType;
    text_delta?: string;
    duration_seconds?: number;
    usage?: AntigravityUsage;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: unknown;
      output?: unknown;
      error?: { type?: string; message?: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    subagent_info?: unknown;
    [key: string]: unknown;
  };
}

export interface AntigravityResultEvent {
  event: 'result';
  result: {
    conversation_id: string;
    status: AntigravityTerminalStatus;
    response: string;
    error?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: AntigravityUsage;
    structured_output?: unknown;
    json_schema?: unknown;
    [key: string]: unknown;
  };
}

export interface AntigravityUnknownEvent {
  event: 'unknown';
  eventName: string;
  raw: Record<string, unknown>;
}

export type AntigravityStreamEvent =
  | AntigravityInitEvent
  | AntigravityStepUpdateEvent
  | AntigravityResultEvent
  | AntigravityUnknownEvent;

export class AntigravityProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AntigravityProtocolError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AntigravityProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new AntigravityProtocolError(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AntigravityProtocolError(`${label} must be a string when present`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AntigravityProtocolError(`${label} must be a finite number when present`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new AntigravityProtocolError(`${label} must be a string array when present`);
  }
  return [...value];
}

function usage(value: unknown, label: string): AntigravityUsage | undefined {
  if (value === undefined) return undefined;
  const raw = record(value, label);
  const parsed: AntigravityUsage = {};
  for (const key of ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'] as const) {
    const count = optionalNumber(raw[key], `${label}.${key}`);
    if (count !== undefined) {
      if (count < 0) throw new AntigravityProtocolError(`${label}.${key} must not be negative`);
      parsed[key] = count;
    }
  }
  return parsed;
}

function parseInit(raw: Record<string, unknown>): AntigravityInitEvent {
  const payload = record(raw['init'], 'init');
  return {
    event: 'init',
    conversation_id: requiredString(raw['conversation_id'], 'conversation_id'),
    init: {
      ...payload,
      ...('cwd' in payload ? { cwd: optionalString(payload['cwd'], 'init.cwd') } : {}),
      ...('tools' in payload ? { tools: stringArray(payload['tools'], 'init.tools') } : {}),
      ...('permission_mode' in payload
        ? { permission_mode: optionalString(payload['permission_mode'], 'init.permission_mode') }
        : {}),
      ...('model' in payload ? { model: optionalString(payload['model'], 'init.model') } : {}),
      ...('agent' in payload ? { agent: optionalString(payload['agent'], 'init.agent') } : {})
    }
  };
}

function parseToolInfo(value: unknown): AntigravityStepUpdateEvent['step_update']['tool_info'] {
  if (value === undefined) return undefined;
  const raw = record(value, 'step_update.tool_info');
  const errorValue = raw['error'];
  let error: { type?: string; message?: string; [key: string]: unknown } | undefined;
  if (errorValue !== undefined) {
    const errorRaw = record(errorValue, 'step_update.tool_info.error');
    error = {
      ...errorRaw,
      ...('type' in errorRaw ? { type: optionalString(errorRaw['type'], 'step_update.tool_info.error.type') } : {}),
      ...('message' in errorRaw ? { message: optionalString(errorRaw['message'], 'step_update.tool_info.error.message') } : {})
    };
  }
  return {
    ...raw,
    ...('name' in raw ? { name: optionalString(raw['name'], 'step_update.tool_info.name') } : {}),
    ...('parameters' in raw ? { parameters: raw['parameters'] } : {}),
    ...('output' in raw ? { output: raw['output'] } : {}),
    ...(error ? { error } : {})
  };
}

function parseStep(raw: Record<string, unknown>): AntigravityStepUpdateEvent {
  const payload = record(raw['step_update'], 'step_update');
  const state = requiredString(payload['state'], 'step_update.state');
  if (!(ANTIGRAVITY_STEP_STATES as readonly string[]).includes(state)) {
    throw new AntigravityProtocolError(`unknown Antigravity step state: ${state}`);
  }
  const stepType = requiredString(payload['step_type'], 'step_update.step_type');
  const stepIndex = optionalNumber(payload['step_index'], 'step_update.step_index');
  if (stepIndex === undefined || !Number.isInteger(stepIndex) || stepIndex < 0) {
    throw new AntigravityProtocolError('step_update.step_index must be a non-negative integer');
  }
  return {
    event: 'step_update',
    step_update: {
      ...payload,
      conversation_id: requiredString(payload['conversation_id'], 'step_update.conversation_id'),
      step_index: stepIndex,
      state: state as AntigravityStepState,
      step_type: stepType as AntigravityStepType,
      ...('text_delta' in payload ? { text_delta: optionalString(payload['text_delta'], 'step_update.text_delta') } : {}),
      ...('duration_seconds' in payload
        ? { duration_seconds: optionalNumber(payload['duration_seconds'], 'step_update.duration_seconds') }
        : {}),
      ...('usage' in payload ? { usage: usage(payload['usage'], 'step_update.usage') } : {}),
      ...('tool_name' in payload ? { tool_name: optionalString(payload['tool_name'], 'step_update.tool_name') } : {}),
      ...('tool_info' in payload ? { tool_info: parseToolInfo(payload['tool_info']) } : {}),
      ...('subagent_info' in payload ? { subagent_info: payload['subagent_info'] } : {})
    }
  };
}

function parseResult(raw: Record<string, unknown>): AntigravityResultEvent {
  const payload = record(raw['result'], 'result');
  const status = requiredString(payload['status'], 'result.status');
  if (!(ANTIGRAVITY_TERMINAL_STATUSES as readonly string[]).includes(status)) {
    throw new AntigravityProtocolError(`unknown Antigravity terminal status: ${status}`);
  }
  return {
    event: 'result',
    result: {
      ...payload,
      // Official unknown-model failures can report an empty conversation id before one exists.
      conversation_id: requiredString(payload['conversation_id'], 'result.conversation_id', true),
      status: status as AntigravityTerminalStatus,
      response: requiredString(payload['response'], 'result.response', true),
      ...('error' in payload ? { error: optionalString(payload['error'], 'result.error') } : {}),
      ...('duration_seconds' in payload
        ? { duration_seconds: optionalNumber(payload['duration_seconds'], 'result.duration_seconds') }
        : {}),
      ...('num_turns' in payload ? { num_turns: optionalNumber(payload['num_turns'], 'result.num_turns') } : {}),
      ...('usage' in payload ? { usage: usage(payload['usage'], 'result.usage') } : {}),
      ...('structured_output' in payload ? { structured_output: payload['structured_output'] } : {}),
      ...('json_schema' in payload ? { json_schema: payload['json_schema'] } : {})
    }
  };
}

export function parseAntigravityStreamLine(line: string): AntigravityStreamEvent {
  if (Buffer.byteLength(line, 'utf8') > MAX_ANTIGRAVITY_STREAM_LINE_BYTES) {
    throw new AntigravityProtocolError(
      `Antigravity stream event exceeded ${MAX_ANTIGRAVITY_STREAM_LINE_BYTES} bytes`
    );
  }
  const text = line.trim();
  if (!text) throw new AntigravityProtocolError('Antigravity stream line was empty');
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new AntigravityProtocolError('Antigravity stream returned malformed JSON');
  }
  const raw = record(decoded, 'stream event');
  const eventName = requiredString(raw['event'], 'event');
  if (eventName === 'init') return parseInit(raw);
  if (eventName === 'step_update') return parseStep(raw);
  if (eventName === 'result') return parseResult(raw);
  // Forward-compatible output: the documented protocol has three event kinds today. Ignore a
  // future kind while preserving its name for diagnostics instead of crashing an otherwise valid
  // session. Malformed known event kinds above still fail closed.
  return { event: 'unknown', eventName, raw };
}

export class AntigravityNdjsonParser {
  private buffered = '';

  push(chunk: string): AntigravityStreamEvent[] {
    this.buffered += chunk;
    const events: AntigravityStreamEvent[] = [];
    for (;;) {
      const newline = this.buffered.indexOf('\n');
      if (newline === -1) break;
      const line = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      if (line) events.push(parseAntigravityStreamLine(line));
    }
    if (Buffer.byteLength(this.buffered, 'utf8') > MAX_ANTIGRAVITY_STREAM_LINE_BYTES) {
      this.buffered = '';
      throw new AntigravityProtocolError(
        `Antigravity stream event exceeded ${MAX_ANTIGRAVITY_STREAM_LINE_BYTES} bytes before newline`
      );
    }
    return events;
  }

  finish(): AntigravityStreamEvent[] {
    const tail = this.buffered.trim();
    this.buffered = '';
    return tail ? [parseAntigravityStreamLine(tail)] : [];
  }
}

export function normalizeAntigravityUsage(
  value?: AntigravityUsage,
  scope: ProviderUsage['scope'] = 'session'
): ProviderUsage | null {
  if (!value) return null;
  return {
    inputTokens: value.input_tokens ?? 0,
    outputTokens: value.output_tokens ?? 0,
    thinkingTokens: value.thinking_tokens ?? 0,
    cacheReadTokens: value.cache_read_tokens ?? 0,
    totalTokens: value.total_tokens ?? 0,
    scope
  };
}

function retryAfterMs(text: string): number | null {
  const match = text.match(/retry[- ]after\s*(?::|=)?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?)?/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = (match[2] ?? 's').toLowerCase();
  const multiplier = unit.startsWith('ms') || unit.startsWith('millisecond') ? 1
    : unit === 'm' || unit.startsWith('min') ? 60_000
      : 1_000;
  return Math.round(value * multiplier);
}

function failure(
  kind: ProviderFailure['kind'],
  message: string,
  retryable: boolean,
  retryAfter: number | null = null
): ProviderFailure {
  return {
    kind,
    message,
    advice: {
      retryable,
      retryAfterMs: retryAfter,
      reason: retryable
        ? retryAfter === null
          ? 'The provider reported a transient failure; any retry still requires an unambiguous local submission state.'
          : `The provider reported retry guidance of ${retryAfter}ms; any retry still requires an unambiguous local submission state.`
        : 'This failure requires user action or provider/session inspection before another submission.'
    }
  };
}

function classifyKnownAntigravityFailure(text: string): ProviderFailure | null {
  const clean = text.trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();
  const guidance = retryAfterMs(clean);
  if (/\b429\b|rate[ -]?limit|resource[_ -]?exhausted|too many requests/.test(lower)) {
    return failure('rate_limited', 'Antigravity is throttling this request.', true, guidance);
  }
  if (/invalid model selection|not recognized as a known model|unknown model|model.+unavailable/.test(lower)) {
    return failure('unknown_model', 'The selected Antigravity model is unknown or unavailable.', false);
  }
  if (/authentication required|unauthenticated|credentials? (?:expired|invalid)|sign[ -]?in required|login required/.test(lower)) {
    return failure('authentication', 'Antigravity authentication is required or expired.', false);
  }
  if (/permission denied|permission.+(?:denied|refused)|soft-denied|requires approval|not allowed by policy/.test(lower)) {
    return failure('permission', 'Antigravity denied a requested permission.', false);
  }
  if (/mcp[^\n]{0,80}(?:startup|start|initializ)[^\n]{0,80}(?:timeout|timed out)|(?:timeout|timed out)[^\n]{0,80}mcp/.test(lower)) {
    return failure('startup_timeout', 'An Antigravity MCP dependency did not start in time.', true, guidance);
  }
  if (/\bhttp[_ /-]?5\d\d\b|\b5\d\d\b[^\n]{0,30}(?:server|service|gateway)|network (?:error|timeout)|timed out|timeout/.test(lower)) {
    return failure('transient', 'Antigravity reported a transient service or network failure.', true, guidance);
  }
  if (/malformed|invalid json|invalid input|unsupported message/.test(lower)) {
    return failure('malformed_input', 'Antigravity rejected malformed or unsupported input.', false);
  }
  return null;
}

/** Conservative provider-specific error classification; it never authorizes a transport replay. */
export function classifyAntigravityFailure(errorText: string, stderrText = ''): ProviderFailure {
  // Provider-correlated result/error text is authoritative. stderr is an untagged process stream
  // and may arrive late, so it can enrich only an otherwise unclassified failure.
  const primary = classifyKnownAntigravityFailure(errorText);
  if (primary) return primary;
  const secondary = classifyKnownAntigravityFailure(stderrText);
  if (secondary) return secondary;
  const combined = `${errorText}\n${stderrText}`.trim();
  return failure(
    'provider',
    combined ? combined.slice(0, 300) : 'Antigravity ended the turn without a usable response.',
    false
  );
}

export function antigravityStepWorkState(step: AntigravityStepUpdateEvent['step_update']): ProviderWorkState | null {
  if (step.step_type === 'user_input' && step.state === 'DONE') return 'accepted';
  if (step.step_type === 'agent_response' || step.step_type === 'checkpoint') return 'model working';
  // Headless CLI cannot pause for an interactive approval. Ask-mode tools are soft-denied and
  // reported diagnostically, so an `ask_permission`-named tool is still provider tool activity,
  // never a fabricated waiting-for-user state.
  if (step.step_type === 'tool') return 'tool working';
  return null;
}

export function normalizeAntigravityResult(
  event: AntigravityResultEvent,
  stderrText = ''
): ProviderTerminalResult {
  const result = event.result;
  const nativeConversationId = result.conversation_id || null;
  const base = {
    providerId: 'antigravity' as const,
    nativeConversationId,
    providerStatus: result.status,
    response: result.response,
    // Antigravity documents terminal result usage as cumulative across the persistent session.
    usage: normalizeAntigravityUsage(result.usage, 'session')
  };
  if (result.status === 'SUCCESS') return { ...base, outcome: 'completed', failure: null };
  if (result.status === 'CANCELED' || result.status === 'INTERRUPTED') {
    return {
      ...base,
      outcome: 'cancelled',
      failure: failure('cancelled', 'The Antigravity turn was cancelled or interrupted.', false)
    };
  }
  if (result.status === 'WAITING' || result.status === 'RUNNING') {
    return {
      ...base,
      outcome: 'blocked',
      failure: failure(
        'provider',
        `Antigravity returned terminal envelope status ${result.status}; inspect the native conversation before continuing.`,
        false
      )
    };
  }
  return {
    ...base,
    outcome: 'failed',
    failure: classifyAntigravityFailure(result.error ?? '', stderrText)
  };
}

export function antigravityTerminalWorkState(result: ProviderTerminalResult): ProviderWorkState {
  if (result.outcome === 'completed') return 'completed';
  if (result.outcome === 'blocked') return 'blocked';
  if (result.outcome === 'cancelled') return 'cancelled';
  if (result.failure?.kind === 'rate_limited') return 'throttled';
  return 'failed';
}

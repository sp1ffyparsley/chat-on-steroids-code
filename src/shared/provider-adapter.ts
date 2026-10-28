/**
 * Provider-neutral agent boundary.
 *
 * This is intentionally a contract, not a scheduler. Existing ChatGPT browser ownership stays
 * where it is; future native/CLI providers can implement this surface without teaching those
 * owners provider-specific conditions or sharing their queues/circuit breakers.
 */

export const PROVIDER_IDS = ['chatgpt', 'antigravity', 'gemini-api'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_WORK_STATES = [
  'queued',
  'opening provider',
  'accepted',
  'model working',
  'tool working',
  'waiting for approval',
  'throttled',
  'recovering',
  'completed',
  'blocked',
  'failed',
  'cancelled'
] as const;
export type ProviderWorkState = (typeof PROVIDER_WORK_STATES)[number];

export type ProviderHealthState =
  | 'unknown'
  | 'ready'
  | 'authentication required'
  | 'throttled'
  | 'cooldown'
  | 'blocked'
  | 'unavailable';

export type ProviderAuthenticationState = 'unknown' | 'ready' | 'required' | 'expired' | 'denied';

export interface ProviderQuotaStatus {
  state: 'unknown' | 'available' | 'limited' | 'exhausted';
  /** Provider-reported remaining units when it exposes a meaningful counter. */
  remaining: number | null;
  /** Absolute provider reset time when known; do not synthesize one from a generic timeout. */
  resetAt: number | null;
  detail: string | null;
}

export type ProviderFailureKind =
  | 'rate_limited'
  | 'transient'
  | 'authentication'
  | 'permission'
  | 'unknown_model'
  | 'malformed_input'
  | 'protocol'
  | 'startup_timeout'
  | 'cancelled'
  | 'unavailable'
  | 'provider';

export interface ProviderRetryAdvice {
  /** True only when retrying cannot duplicate an ambiguously accepted turn. */
  retryable: boolean;
  /** Provider guidance, if it was actually present. This is guidance, not a sleep instruction. */
  retryAfterMs: number | null;
  reason: string;
}

export interface ProviderFailure {
  kind: ProviderFailureKind;
  message: string;
  advice: ProviderRetryAdvice;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  /** Whether the provider reports these counters for one turn or the whole native session. */
  scope: 'step' | 'turn' | 'session';
}

export interface ProviderCapabilities {
  providerId: ProviderId;
  persistentSession: boolean;
  nativeResume: boolean;
  /** `process` interruption may require native-session resume; `turn` preserves the live session. */
  cancellation: 'none' | 'process' | 'turn';
  modelDiscovery: boolean;
  mcp: boolean;
  tools: boolean;
}

export interface ProviderModel {
  /** Exact provider-native slug. Adapters must never silently replace this value. */
  id: string;
  label: string;
  available: boolean;
}

export interface ProviderHealth {
  providerId: ProviderId;
  state: ProviderHealthState;
  authentication: ProviderAuthenticationState;
  quota: ProviderQuotaStatus | null;
  checkedAt: number;
  detail: string | null;
  retryAfterMs: number | null;
  cooldownUntil: number | null;
}

export interface ProviderSessionHandle {
  providerId: ProviderId;
  localSessionId: string;
  nativeConversationId: string | null;
  /** Exact requested model; no adapter may mutate this as a fallback. */
  selectedModel: string;
}

export interface ProviderCreateSessionInput {
  localSessionId: string;
  selectedModel: string;
  cwd: string;
}

export interface ProviderResumeSessionInput extends ProviderCreateSessionInput {
  nativeConversationId: string;
}

export interface ProviderSendInput {
  session: ProviderSessionHandle;
  /** Stable local turn identity used for durable idempotency. */
  turnId: string;
  /** Stable identity of the authored message in the canonical session owner. */
  messageId: string;
  content: string;
}

export interface ProviderProgressEvent {
  providerId: ProviderId;
  state: ProviderWorkState;
  time: number;
  nativeConversationId: string | null;
  textDelta?: string;
  toolName?: string;
  /** Stable provider event identity when its protocol exposes one. */
  nativeEvent?: {
    type: string;
    index?: number;
    state?: string;
  };
  tool?: {
    name: string;
    input?: unknown;
    output?: unknown;
    error?: string;
  };
  /** Provider-native subagent references, retained without flattening them into app workers. */
  subagents?: readonly {
    nativeConversationId?: string;
    role?: string;
    type?: string;
  }[];
  detail?: string;
  usage?: ProviderUsage;
}

export type ProviderTerminalOutcome = 'completed' | 'blocked' | 'failed' | 'cancelled';

export interface ProviderTerminalResult {
  providerId: ProviderId;
  nativeConversationId: string | null;
  outcome: ProviderTerminalOutcome;
  /** Provider-native terminal status retained for diagnostics. */
  providerStatus: string;
  response: string;
  usage: ProviderUsage | null;
  failure: ProviderFailure | null;
}

export interface ProviderInspection {
  session: ProviderSessionHandle;
  state: ProviderWorkState;
  availableTools: readonly string[];
  detail: string | null;
}

export type ProviderProgressSink = (event: ProviderProgressEvent) => void | Promise<void>;

/**
 * The only surface higher-level orchestration should need from a non-browser provider.
 *
 * Queueing, rate-limit ownership and circuit breaking deliberately remain outside this interface:
 * those are provider-scoped orchestration concerns, while an adapter owns one provider's native
 * lifecycle and protocol semantics.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  discoverModels(signal?: AbortSignal): Promise<readonly ProviderModel[]>;
  health(signal?: AbortSignal): Promise<ProviderHealth>;
  createSession(input: ProviderCreateSessionInput, signal?: AbortSignal): Promise<ProviderSessionHandle>;
  resumeSession(input: ProviderResumeSessionInput, signal?: AbortSignal): Promise<ProviderSessionHandle>;
  send(input: ProviderSendInput, progress: ProviderProgressSink, signal?: AbortSignal): Promise<ProviderTerminalResult>;
  cancel(session: ProviderSessionHandle): Promise<void>;
  inspect(session: ProviderSessionHandle): Promise<ProviderInspection>;
  close(): Promise<void>;
}

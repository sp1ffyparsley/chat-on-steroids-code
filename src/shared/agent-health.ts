import type {
  AgentBrowserEvidence,
  AgentHealthProjection,
  AgentIdentityEvidence,
  AgentInfo
} from './session.js';

export interface AgentHealthEvidence {
  observedAt: number;
  identity: AgentIdentityEvidence;
  browser: AgentBrowserEvidence;
  runningToolCalls: number;
  generating: boolean;
  activeTurn: boolean;
  waitMs: number;
  blocker: boolean;
}

const START_STALLED_MS = 60_000;
const WORK_STALLED_MS = 60_000;

/**
 * Deterministic read-only health projection from facts already owned by the broker/bridge.
 * It creates no timer, retries no work, and never changes agent authority.
 */
export function evaluateAgentHealth(
  agent: Pick<AgentInfo, 'role' | 'state' | 'result'>,
  evidence: AgentHealthEvidence
): AgentHealthProjection {
  const normalized: AgentHealthProjection['evidence'] = {
    identity: evidence.identity,
    browser: evidence.browser,
    runningToolCalls: Math.max(0, Math.floor(evidence.runningToolCalls)),
    generating: evidence.generating,
    activeTurn: evidence.activeTurn,
    waitMs: Math.max(0, Math.floor(evidence.waitMs)),
    blocker: evidence.blocker
  };
  const finish = (
    activity: AgentHealthProjection['activity'],
    health: AgentHealthProjection['health'],
    action: AgentHealthProjection['action'],
    reason: string
  ): AgentHealthProjection => ({ observedAt: evidence.observedAt, activity, health, action, reason, evidence: normalized });

  // Explicit terminal/block facts outrank every inferred liveness signal.
  if (agent.state === 'failed') {
    return finish('done', 'blocked', 'user_attention', agent.result || 'The worker failed and needs review.');
  }
  if (normalized.blocker) {
    return finish('waiting', 'blocked', 'user_attention', 'ChatGPT blocked this conversation.');
  }
  if (agent.state === 'finished') {
    return finish('done', 'healthy', 'none', 'The worker finished.');
  }
  if (agent.state === 'sleeping') {
    return finish('sleeping', 'healthy', 'none', 'The reusable worker is sleeping.');
  }

  // Live tool execution is first-hand activity even when its browser tab is unavailable.
  if (normalized.runningToolCalls > 0) {
    return finish('tool_call', 'healthy', 'none', `${normalized.runningToolCalls} tool call(s) are running.`);
  }
  if (normalized.generating || normalized.activeTurn) {
    return finish('working', 'healthy', 'none', 'ChatGPT is working on the current turn.');
  }

  if (agent.state === 'invited' || agent.state === 'waking') {
    if (normalized.waitMs >= START_STALLED_MS) {
      return finish('starting', 'stalled', 'retry_delivery', 'The worker has not completed browser delivery.');
    }
    return finish('starting', 'degraded', 'observe', 'The worker is waiting for its ChatGPT page.');
  }

  if (normalized.identity === 'missing') {
    return finish('waiting', 'unknown', 'observe', 'The app cannot prove this agent’s conversation identity.');
  }
  if (agent.state === 'detached' || normalized.browser === 'missing') {
    if (normalized.waitMs >= WORK_STALLED_MS) {
      return finish('waiting', 'stalled', 'retry_delivery', 'The worker has no browser page or recent work evidence.');
    }
    return finish('waiting', 'degraded', 'observe', 'The worker is active but its browser page is unavailable.');
  }
  if (agent.state === 'active' && normalized.waitMs >= WORK_STALLED_MS) {
    return finish('waiting', 'stalled', 'retry_delivery', 'The worker has no recent turn or tool activity.');
  }
  if (normalized.browser === 'unknown') {
    return finish('waiting', 'unknown', 'observe', 'The worker is waiting; browser liveness is not yet known.');
  }
  return finish('waiting', 'healthy', 'none', 'The worker is ready and waiting.');
}

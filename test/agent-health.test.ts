import { describe, expect, it } from 'vitest';
import { evaluateAgentHealth, type AgentHealthEvidence } from '../src/shared/agent-health.js';
import type { AgentInfo } from '../src/shared/session.js';

const agent = (state: AgentInfo['state'], result: string | null = null) => ({ role: 'worker' as const, state, result });
const evidence = (overrides: Partial<AgentHealthEvidence> = {}): AgentHealthEvidence => ({
  observedAt: 1_000_000,
  identity: 'exact',
  browser: 'present',
  runningToolCalls: 0,
  generating: false,
  activeTurn: false,
  waitMs: 1_000,
  blocker: false,
  ...overrides
});

describe('agent health projection', () => {
  it('lets explicit blocking outrank apparent browser activity', () => {
    expect(evaluateAgentHealth(agent('active'), evidence({ blocker: true, generating: true }))).toMatchObject({
      activity: 'waiting', health: 'blocked', action: 'user_attention'
    });
  });

  it('treats running tools as healthy first-hand work even without a tab', () => {
    expect(evaluateAgentHealth(agent('detached'), evidence({ browser: 'missing', runningToolCalls: 2 }))).toMatchObject({
      activity: 'tool_call', health: 'healthy', action: 'none'
    });
  });

  it('classifies a delivery wait deterministically from the supplied observation time', () => {
    const projection = evaluateAgentHealth(agent('waking'), evidence({ browser: 'unknown', waitMs: 120_000 }));
    expect(projection).toMatchObject({
      observedAt: 1_000_000,
      activity: 'starting',
      health: 'stalled',
      action: 'retry_delivery'
    });
  });

  it('reports missing identity as unknown instead of inventing liveness', () => {
    expect(evaluateAgentHealth(agent('active'), evidence({ identity: 'missing', browser: 'missing' }))).toMatchObject({
      health: 'unknown', action: 'observe'
    });
  });
});

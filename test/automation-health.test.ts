import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_STALE_MS,
  evaluateAutomationHealth,
  type AutomationHealthEvidence
} from '../src/shared/session-activity.js';

const NOW = 2_000_000;

function evidence(overrides: Partial<AutomationHealthEvidence> = {}): AutomationHealthEvidence {
  return {
    observedAt: NOW,
    mode: 'loop',
    lastWorkedAt: NOW - 1_000,
    paused: false,
    blockedReason: null,
    exactMainWork: false,
    recentActivity: false,
    activeWorkers: 0,
    recovery: null,
    ...overrides
  };
}

describe('automation health projection', () => {
  it('keeps explicit blocks highest and lets an already-started main turn visibly finish while paused', () => {
    expect(evaluateAutomationHealth(evidence({
      paused: true,
      blockedReason: 'Needs attention.',
      exactMainWork: true
    }))).toMatchObject({ state: 'blocked', spinning: false });
    expect(evaluateAutomationHealth(evidence({ paused: true, exactMainWork: true }))).toMatchObject({
      state: 'working',
      reason: expect.stringContaining('already-started ChatGPT turn is finishing'),
      nextAction: expect.stringContaining('use Resume'),
      spinning: true
    });
  });

  it('projects Paused as soon as exact main work ends and ignores non-exact activity while paused', () => {
    for (const pausedEvidence of [
      { recentActivity: true },
      { activeWorkers: 3 },
      { recovery: { stage: 'queued' as const, reason: 'Reload queued.', nextAction: 'Wait.', nextRetryAt: NOW + 30_000 } }
    ]) {
      expect(evaluateAutomationHealth(evidence({ paused: true, ...pausedEvidence }))).toMatchObject({
        state: 'paused',
        reason: 'All new app-authored ChatGPT work is paused.',
        spinning: false
      });
    }
  });

  it('reserves Working and its spinner for exact main execution', () => {
    expect(evaluateAutomationHealth(evidence({ exactMainWork: true, recentActivity: true }))).toMatchObject({
      state: 'working',
      spinning: true,
      recoveryStage: null
    });
    expect(evaluateAutomationHealth(evidence({ recentActivity: true }))).toMatchObject({
      state: 'waiting-main',
      spinning: false,
      recoveryStage: null
    });
  });

  it('shows an active browser recovery instead of claiming a broken chat is still Working', () => {
    expect(evaluateAutomationHealth(evidence({
      exactMainWork: true,
      recentActivity: true,
      recovery: { stage: 'browser-action', reason: 'Native Retry is in flight.', nextAction: 'Verify the exact chat.', nextRetryAt: null }
    }))).toMatchObject({
      state: 'recovering',
      recoveryStage: 'browser-action',
      spinning: false,
      reason: 'Native Retry is in flight.'
    });
  });

  it('separates worker waits and gives recovery custody priority over recent activity', () => {
    expect(evaluateAutomationHealth(evidence({ activeWorkers: 3, recentActivity: true }))).toMatchObject({
      state: 'waiting-workers',
      spinning: false
    });
    const recovering = evaluateAutomationHealth(evidence({
      recentActivity: true,
      recovery: { stage: 'queued', reason: 'Reload queued.', nextAction: 'Wait.', nextRetryAt: NOW + 30_000 }
    }));
    expect(recovering).toMatchObject({
      state: 'recovering',
      nextRetryAt: NOW + 30_000,
      recoverable: false,
      spinning: false,
      recoveryStage: 'queued'
    });
  });

  it.each([
    'core',
    'queued',
    'browser-action',
    'checking-activity',
    'handoff',
    'draft',
    'pending-reply',
    'cooldown'
  ] as const)('keeps %s recovery visible and non-spinning', stage => {
    expect(evaluateAutomationHealth(evidence({
      recovery: { stage, reason: 'Recovery owns this chat.', nextAction: 'Wait.', nextRetryAt: null }
    }))).toMatchObject({
      state: 'recovering',
      recoveryStage: stage,
      spinning: false,
      recoverable: stage === 'cooldown'
    });
  });

  it('recovers only a stale Loop, never an equally quiet one-shot Goal', () => {
    const lastWorkedAt = NOW - AUTOMATION_STALE_MS;
    expect(evaluateAutomationHealth(evidence({ lastWorkedAt }))).toMatchObject({ state: 'stalled', recoverable: true });
    expect(evaluateAutomationHealth(evidence({ mode: 'goal', lastWorkedAt }))).toMatchObject({
      state: 'waiting-main',
      recoverable: false
    });
  });
});

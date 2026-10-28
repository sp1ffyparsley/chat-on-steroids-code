import { describe, expect, it } from 'vitest';
import type { AutomationChatProjection, AutomationSupervisorSnapshot } from '../src/main/bridge.js';
import {
  MAJORITY_ALARM_INCIDENT_COOLDOWN_MS,
  MAJORITY_ALARM_OBSERVATION_GAP_MS,
  MAJORITY_ALARM_STALE_MS,
  MAJORITY_ALARM_WARNING_GRACE_MS,
  emptyMajorityAlarmState,
  observeMajorityAlarm,
  suppressMajorityAlarm
} from '../src/renderer/majority-alarm.js';

const NOW = 10_000_000;
function chat(id: string, state: AutomationChatProjection['state'], workedAt = NOW - MAJORITY_ALARM_STALE_MS - 1): AutomationChatProjection {
  return {
    sessionId: `session-${id}`,
    conversationId: id,
    title: id,
    mode: 'loop',
    lastWorkedAt: workedAt,
    activeWorkers: 0,
    failedWorkers: 0,
    state,
    reason: state,
    nextAction: '',
    nextRetryAt: null,
    recoverable: state === 'stalled',
    spinning: false,
    recoveryStage: null
  };
}
function snapshot(chats: AutomationChatProjection[]): AutomationSupervisorSnapshot {
  const counts = { working: 0, 'waiting-workers': 0, 'waiting-main': 0, recovering: 0, stalled: 0, paused: 0, blocked: 0 };
  for (const row of chats) counts[row.state] += 1;
  return { observedAt: NOW, targetLanes: 3, chats, counts };
}

describe('majority-stalled audible incident admission', () => {
  it('warns after two observations, then requires the full warning grace before ringing', () => {
    let state = emptyMajorityAlarmState();
    const view = snapshot([chat('a', 'stalled'), chat('b', 'stalled'), chat('c', 'working')]);
    let result = observeMajorityAlarm(view, state, NOW);
    expect(result.incident).toBeNull(); state = result.state;
    result = observeMajorityAlarm(view, state, NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS - 1);
    expect(result.incident).toBeNull(); state = result.state;
    result = observeMajorityAlarm(view, state, NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS);
    expect(result.warning).toMatchObject({ stalled: 2, enabled: 3, titles: ['a', 'b'] });
    expect(result.control).toMatchObject({ key: 'a|b', stalled: 2, enabled: 3 });
    expect(result.incident).toBeNull(); state = result.state;
    result = observeMajorityAlarm(view, state,
      NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS + MAJORITY_ALARM_WARNING_GRACE_MS - 1);
    expect(result.incident).toBeNull(); state = result.state;
    expect(result.control).toMatchObject({ key: 'a|b' });
    result = observeMajorityAlarm(view, state,
      NOW + 2 * MAJORITY_ALARM_OBSERVATION_GAP_MS + MAJORITY_ALARM_WARNING_GRACE_MS);
    expect(result.incident).toMatchObject({ stalled: 2, enabled: 3, titles: ['a', 'b'] });
  });

  it('does not count paused, blocked, recently-active, or merely waiting chats as dead', () => {
    const view = snapshot([
      chat('stale', 'stalled'),
      chat('recent', 'stalled', NOW - MAJORITY_ALARM_STALE_MS + 1),
      chat('waiting', 'waiting-main'),
      chat('paused', 'paused'),
      chat('blocked', 'blocked')
    ]);
    const first = observeMajorityAlarm(view, emptyMajorityAlarmState(), NOW);
    const second = observeMajorityAlarm(view, first.state, NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS);
    expect(second.incident).toBeNull();
  });

  it('rings once for one unchanged incident and cools down a changed majority', () => {
    const firstView = snapshot([chat('a', 'stalled'), chat('b', 'stalled')]);
    let state = observeMajorityAlarm(firstView, emptyMajorityAlarmState(), NOW).state;
    let result = observeMajorityAlarm(firstView, state, NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS);
    expect(result.warning).not.toBeNull(); state = result.state;
    result = observeMajorityAlarm(firstView, state,
      NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS + MAJORITY_ALARM_WARNING_GRACE_MS);
    expect(result.incident).not.toBeNull(); state = result.state;
    expect(observeMajorityAlarm(firstView, state,
      NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS + MAJORITY_ALARM_WARNING_GRACE_MS + MAJORITY_ALARM_OBSERVATION_GAP_MS).incident).toBeNull();

    const changed = snapshot([chat('a', 'stalled'), chat('c', 'stalled')]);
    state = observeMajorityAlarm(changed, state, NOW + 3 * MAJORITY_ALARM_OBSERVATION_GAP_MS).state;
    result = observeMajorityAlarm(changed, state, NOW + 4 * MAJORITY_ALARM_OBSERVATION_GAP_MS);
    expect(result.incident).toBeNull();
    expect(result.warning).not.toBeNull();
    result = observeMajorityAlarm(changed, result.state, NOW + MAJORITY_ALARM_INCIDENT_COOLDOWN_MS +
      MAJORITY_ALARM_WARNING_GRACE_MS + 4 * MAJORITY_ALARM_OBSERVATION_GAP_MS);
    expect(result.incident).toMatchObject({ stalled: 2, enabled: 2 });
  });

  it('lets the warning suppress the current incident without muting a later recovered incident', () => {
    const failed = snapshot([chat('a', 'stalled'), chat('b', 'stalled')]);
    let state = observeMajorityAlarm(failed, emptyMajorityAlarmState(), NOW).state;
    const warned = observeMajorityAlarm(failed, state, NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS);
    expect(warned.warning).not.toBeNull();
    state = suppressMajorityAlarm(warned.state, warned.warning!.key);
    expect(observeMajorityAlarm(failed, state,
      NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS + MAJORITY_ALARM_WARNING_GRACE_MS).incident).toBeNull();

    state = observeMajorityAlarm(snapshot([chat('a', 'working'), chat('b', 'working')]), state,
      NOW + MAJORITY_ALARM_WARNING_GRACE_MS * 2).state;
    expect(state.suppressedKey).toBeNull();
  });

  it('restores the persistent warning control from saved incident state until it is suppressed', () => {
    const failed = snapshot([chat('a', 'stalled'), chat('b', 'stalled')]);
    let state = observeMajorityAlarm(failed, emptyMajorityAlarmState(), NOW).state;
    const warned = observeMajorityAlarm(failed, state, NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS);
    state = warned.state;

    const restored = observeMajorityAlarm(failed, structuredClone(state),
      NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS + 1);
    expect(restored.warning).toBeNull();
    expect(restored.control).toMatchObject({ key: 'a|b', stalled: 2, enabled: 2 });

    const suppressed = suppressMajorityAlarm(restored.state, restored.control!.key);
    const quiet = observeMajorityAlarm(failed, suppressed,
      NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS + MAJORITY_ALARM_WARNING_GRACE_MS);
    expect(quiet.control).toBeNull();
    expect(quiet.incident).toBeNull();
  });

  it('re-arms the same affected set only after the majority genuinely clears', () => {
    const failed = snapshot([chat('a', 'stalled'), chat('b', 'stalled')]);
    let state = observeMajorityAlarm(failed, emptyMajorityAlarmState(), NOW).state;
    state = observeMajorityAlarm(failed, state, NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS).state;
    state = observeMajorityAlarm(failed, state,
      NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS + MAJORITY_ALARM_WARNING_GRACE_MS).state;
    const healthy = observeMajorityAlarm(snapshot([chat('a', 'working'), chat('b', 'working')]), state,
      NOW + MAJORITY_ALARM_WARNING_GRACE_MS + 2 * MAJORITY_ALARM_OBSERVATION_GAP_MS);
    expect(healthy.state.activeIncidentKey).toBeNull();
    const again = observeMajorityAlarm(failed, healthy.state,
      NOW + MAJORITY_ALARM_INCIDENT_COOLDOWN_MS + 3 * MAJORITY_ALARM_OBSERVATION_GAP_MS);
    const confirmed = observeMajorityAlarm(failed, again.state,
      NOW + MAJORITY_ALARM_INCIDENT_COOLDOWN_MS + 4 * MAJORITY_ALARM_OBSERVATION_GAP_MS);
    expect(confirmed.warning).not.toBeNull();
    const rung = observeMajorityAlarm(failed, confirmed.state,
      NOW + MAJORITY_ALARM_INCIDENT_COOLDOWN_MS + MAJORITY_ALARM_WARNING_GRACE_MS + 4 * MAJORITY_ALARM_OBSERVATION_GAP_MS);
    expect(rung.incident).not.toBeNull();
  });
});

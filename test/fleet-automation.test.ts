import { describe, expect, it } from 'vitest';
import {
  FLEET_AUTOMATION_OFFLINE_MS,
  FLEET_AUTOMATION_STARTUP_GRACE_MS,
  aggregateFleetAutomationAlarmView,
  aggregateFleetAutomationPublications,
  parseFleetAutomationPublication,
  type FleetAutomationProfile,
  type FleetAutomationPublication
} from '../src/main/fleet-automation.js';
import { emptyMajorityAlarmState, observeMajorityAlarm, MAJORITY_ALARM_OBSERVATION_GAP_MS } from '../src/renderer/majority-alarm.js';

const NOW = 20_000_000;
const profiles: FleetAutomationProfile[] = [
  { id: 'primary', label: 'Primary', mode: 'legacy', enabled: true },
  { id: 'foot', label: 'Alpha', mode: 'isolated', enabled: true },
  { id: 'Zeta', label: 'Zeta', mode: 'isolated', enabled: true }
];

function publication(instanceId: string, states: FleetAutomationPublication['chats'][number]['state'][], publishedAt = NOW): FleetAutomationPublication {
  return {
    schemaVersion: 1,
    instanceId,
    publishedAt,
    runtimeState: 'active',
    automation: { admission: 'enabled', holdReason: null, providerVerification: 'unknown' },
    targetLanes: 2,
    chats: states.map((state, index) => ({
      sessionId: `session-${index}`,
      conversationId: `conversation-${index}`,
      title: `Chat ${index}`,
      mode: 'loop',
      state,
      lastWorkedAt: NOW - FLEET_AUTOMATION_OFFLINE_MS - 1,
      recoverable: state === 'stalled',
      spinning: state === 'working',
      activeWorkers: 0
    }))
  };
}

describe('fleet automation alarm aggregation', () => {
  it('does not mistake one account-local majority for a machine-wide majority', () => {
    const view = aggregateFleetAutomationPublications(profiles[0]!, profiles, [
      publication('primary', ['stalled', 'stalled', 'working']),
      publication('foot', ['working', 'working', 'working']),
      publication('Zeta', ['working', 'working', 'working'])
    ], NOW)!;
    expect(view.counts.stalled).toBe(2);
    expect(view.chats).toHaveLength(9);
    const first = observeMajorityAlarm(view, emptyMajorityAlarmState(), NOW);
    const second = observeMajorityAlarm(view, first.state, NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS);
    expect(second.warning).toBeNull();
  });

  it('admits a strict majority only after the aggregate fleet itself is mostly stalled', () => {
    const view = aggregateFleetAutomationPublications(profiles[0]!, profiles, [
      publication('primary', ['stalled', 'stalled', 'working']),
      publication('foot', ['stalled', 'stalled', 'working']),
      publication('Zeta', ['stalled', 'working', 'working'])
    ], NOW)!;
    const first = observeMajorityAlarm(view, emptyMajorityAlarmState(), NOW);
    const second = observeMajorityAlarm(view, first.state, NOW + MAJORITY_ALARM_OBSERVATION_GAP_MS);
    expect(second.warning).toMatchObject({ stalled: 5, enabled: 9 });
  });

  it('namespaces duplicate session and conversation ids by account', () => {
    const view = aggregateFleetAutomationPublications(profiles[0]!, profiles, [
      publication('primary', ['working']),
      publication('foot', ['working']),
      publication('Zeta', ['working'])
    ], NOW)!;
    expect(new Set(view.chats.map(chat => chat.sessionId)).size).toBe(3);
    expect(new Set(view.chats.map(chat => chat.conversationId)).size).toBe(3);
  });

  it('grants no alarm projection to an isolated account process', () => {
    expect(aggregateFleetAutomationPublications(profiles[1]!, profiles, [publication('foot', ['stalled'])], NOW)).toBeNull();
  });

  it('refuses to infer a fleet majority while any enabled account publication is missing', () => {
    expect(aggregateFleetAutomationPublications(profiles[0]!, profiles, [
      publication('primary', ['stalled', 'stalled']),
      publication('foot', ['stalled'])
    ], NOW)).toBeNull();
  });

  it('surfaces incomplete profile coverage after startup grace without synthesizing alarm rows', () => {
    const available = [publication('primary', ['stalled']), publication('foot', ['stalled'])];
    const starting = aggregateFleetAutomationAlarmView(profiles[0]!, profiles, available, NOW, NOW)!;
    expect(starting).toEqual({
      snapshot: null,
      automation: {
        state: 'unknown',
        enabledProfiles: 2,
        pausedProfiles: 0,
        inactiveProfiles: 0,
        unknownProfiles: 1,
        holds: [],
        providerVerification: 'unknown'
      },
      coverage: {
        state: 'starting',
        expectedProfiles: 3,
        reportingProfiles: 2,
        missingProfiles: ['Zeta'],
        graceEndsAt: NOW + FLEET_AUTOMATION_STARTUP_GRACE_MS
      }
    });

    const visible = aggregateFleetAutomationAlarmView(
      profiles[0]!, profiles, available,
      NOW + FLEET_AUTOMATION_STARTUP_GRACE_MS,
      NOW
    )!;
    expect(visible.coverage.state).toBe('incomplete');
    expect(visible.snapshot).toBeNull();
    expect(visible.coverage.missingProfiles).toEqual(['Zeta']);
  });

  it('treats an explicit supported runtime stop as complete inactive evidence', () => {
    const inactive = { ...publication('Zeta', []), runtimeState: 'inactive' as const, targetLanes: 0 };
    const view = aggregateFleetAutomationPublications(profiles[0]!, profiles, [
      publication('primary', ['working']),
      publication('foot', ['working']),
      inactive
    ], NOW)!;
    expect(view.chats).toHaveLength(2);
    expect(view.targetLanes).toBe(4);
  });

  it('reports a process-active global pause distinctly from configured lane capacity', () => {
    const paused = {
      ...publication('foot', ['paused', 'paused']),
      automation: {
        admission: 'paused',
        holdReason: 'global-pause',
        providerVerification: 'unknown'
      }
    };
    expect(parseFleetAutomationPublication(paused)).toMatchObject({
      runtimeState: 'active',
      targetLanes: 2,
      automation: {
        admission: 'paused',
        holdReason: 'global-pause',
        providerVerification: 'unknown'
      }
    });
    const pausedPublication = (instanceId: string, states: FleetAutomationPublication['chats'][number]['state'][]) => ({
      ...publication(instanceId, states),
      automation: {
        admission: 'paused' as const,
        holdReason: 'global-pause' as const,
        providerVerification: 'unknown' as const
      }
    });
    expect(aggregateFleetAutomationAlarmView(profiles[0]!, profiles, [
      pausedPublication('primary', ['paused']),
      paused as FleetAutomationPublication,
      pausedPublication('Zeta', ['paused'])
    ], NOW, 0)).toMatchObject({
      automation: {
        state: 'paused',
        enabledProfiles: 0,
        pausedProfiles: 3,
        inactiveProfiles: 0,
        unknownProfiles: 0,
        holds: [
          { profile: 'Primary', reason: 'global-pause' },
          { profile: 'Alpha', reason: 'global-pause' },
          { profile: 'Zeta', reason: 'global-pause' }
        ],
        providerVerification: 'unknown'
      }
    });
  });

  it('keeps legacy publications readable but does not infer their automation admission', () => {
    const { automation: _automation, ...legacy } = publication('foot', ['paused']);
    expect(parseFleetAutomationPublication(legacy)).toMatchObject({ runtimeState: 'active' });
    expect(aggregateFleetAutomationAlarmView(profiles[0]!, profiles, [
      { ...publication('primary', []), automation: {
        admission: 'enabled', holdReason: null, providerVerification: 'unknown'
      } } as FleetAutomationPublication,
      legacy,
      { ...publication('Zeta', []), automation: {
        admission: 'inactive', holdReason: 'runtime-inactive', providerVerification: 'unknown'
      }, runtimeState: 'inactive', targetLanes: 0 } as FleetAutomationPublication
    ], NOW, 0)).toMatchObject({
      automation: {
        state: 'unknown',
        enabledProfiles: 1,
        pausedProfiles: 0,
        inactiveProfiles: 1,
        unknownProfiles: 1,
        holds: [{ profile: 'Zeta', reason: 'runtime-inactive' }],
        providerVerification: 'unknown'
      }
    });
  });

  it('rejects contradictory or unbounded automation hold metadata', () => {
    expect(parseFleetAutomationPublication({ ...publication('foot', []), automation: {
      admission: 'enabled', holdReason: 'global-pause', providerVerification: 'unknown'
    } })).toBeNull();
    expect(parseFleetAutomationPublication({ ...publication('foot', []), automation: {
      admission: 'paused', holdReason: 'global-pause', providerVerification: 'verified'
    } })).toBeNull();
    expect(parseFleetAutomationPublication({ ...publication('foot', []), runtimeState: 'inactive', automation: {
      admission: 'paused', holdReason: 'global-pause', providerVerification: 'unknown'
    } })).toBeNull();
  });

  it('treats a ten-minute-dead publisher as offline but safely rejects malformed or future data', () => {
    const stale = publication('foot', ['working'], NOW - FLEET_AUTOMATION_OFFLINE_MS - 1);
    const view = aggregateFleetAutomationPublications(profiles[0]!, profiles, [
      publication('primary', []), stale, publication('Zeta', [])
    ], NOW)!;
    expect(view.chats[0]).toMatchObject({ state: 'stalled', recoverable: false, spinning: false });
    expect(parseFleetAutomationPublication({ schemaVersion: 1, instanceId: '../escape', chats: [] })).toBeNull();
    const future = publication('Zeta', ['stalled'], NOW + 60_001);
    expect(aggregateFleetAutomationPublications(profiles[0]!, profiles, [
      publication('primary', []), publication('foot', []), future
    ], NOW)).toBeNull();
  });
});

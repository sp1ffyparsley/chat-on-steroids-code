import type { AutomationSupervisorSnapshot } from '../main/bridge.js';

export const MAJORITY_ALARM_STALE_MS = 10 * 60_000;
export const MAJORITY_ALARM_OBSERVATION_GAP_MS = 15_000;
export const MAJORITY_ALARM_WARNING_GRACE_MS = 2 * 60_000;
export const MAJORITY_ALARM_INCIDENT_COOLDOWN_MS = 60 * 60_000;

export interface MajorityAlarmState {
  candidateKey: string | null;
  candidateObservations: number;
  lastObservedAt: number | null;
  activeIncidentKey: string | null;
  warningKey: string | null;
  warningAt: number | null;
  suppressedKey: string | null;
  lastAlertedKey: string | null;
  lastAlertedAt: number | null;
}

export interface MajorityAlarmIncident {
  key: string;
  stalled: number;
  enabled: number;
  titles: string[];
}

export type MajorityAlarmWarning = MajorityAlarmIncident;

export interface MajorityAlarmObservation {
  state: MajorityAlarmState;
  /** Emitted once so desktop notification/logging does not repeat. */
  warning: MajorityAlarmWarning | null;
  /** Present for every observation while the incident's persistent Do-not-ring control is owed. */
  control: MajorityAlarmWarning | null;
  incident: MajorityAlarmIncident | null;
}

export const emptyMajorityAlarmState = (): MajorityAlarmState => ({
  candidateKey: null,
  candidateObservations: 0,
  lastObservedAt: null,
  activeIncidentKey: null,
  warningKey: null,
  warningAt: null,
  suppressedKey: null,
  lastAlertedKey: null,
  lastAlertedAt: null
});

/** The warning action suppresses only the currently proven incident; recovery re-arms a later one. */
export function suppressMajorityAlarm(state: MajorityAlarmState, key: string): MajorityAlarmState {
  return state.activeIncidentKey === key ? { ...state, suppressedKey: key } : state;
}

/**
 * One pure projection over the existing supervisor snapshot. It starts no timer and never decides
 * that a vague waiting/repair label is failure. The bridge already owns the exact recovery fences;
 * this module only turns a proven majority of its terminal `stalled` rows into one audible incident.
 */
export function observeMajorityAlarm(
  snapshot: AutomationSupervisorSnapshot,
  previous: MajorityAlarmState,
  now = Date.now()
): MajorityAlarmObservation {
  // Paused work is intentionally not enabled. A blocked row represents a user/policy gate rather
  // than a chat that died, so it cannot inflate either side of the majority calculation.
  const enabled = snapshot.chats.filter(chat => chat.state !== 'paused' && chat.state !== 'blocked');
  const stalled = enabled.filter(chat =>
    chat.state === 'stalled' && now - chat.lastWorkedAt >= MAJORITY_ALARM_STALE_MS
  );
  if (enabled.length === 0 || stalled.length <= enabled.length / 2) {
    return {
      state: {
        ...previous,
        candidateKey: null,
        candidateObservations: 0,
        lastObservedAt: null,
        activeIncidentKey: null,
        warningKey: null,
        warningAt: null,
        suppressedKey: null,
        lastAlertedKey: null
      },
      warning: null,
      control: null,
      incident: null
    };
  }

  const key = stalled.map(chat => chat.conversationId).sort().join('|');
  const notice = (): MajorityAlarmIncident => ({
    key,
    stalled: stalled.length,
    enabled: enabled.length,
    titles: stalled.map(chat => chat.title || chat.conversationId)
  });
  if (previous.candidateKey !== key) {
    return {
      state: {
        ...previous,
        candidateKey: key,
        candidateObservations: 1,
        lastObservedAt: now,
        activeIncidentKey: key,
        warningKey: null,
        warningAt: null,
        suppressedKey: null
      },
      warning: null,
      control: null,
      incident: null
    };
  }
  const persistentControl = (): MajorityAlarmWarning | null =>
    previous.warningKey === key && previous.warningAt !== null &&
      previous.suppressedKey !== key && previous.lastAlertedKey !== key
      ? notice()
      : null;
  if (previous.lastObservedAt !== null && now - previous.lastObservedAt < MAJORITY_ALARM_OBSERVATION_GAP_MS) {
    return { state: previous, warning: null, control: persistentControl(), incident: null };
  }

  const observations = previous.candidateObservations + 1;
  const state: MajorityAlarmState = {
    ...previous,
    candidateObservations: observations,
    lastObservedAt: now,
    activeIncidentKey: key
  };
  if (observations < 2) return { state, warning: null, control: null, incident: null };
  if (previous.warningKey !== key || previous.warningAt === null) {
    state.warningKey = key;
    state.warningAt = now;
    const warning = notice();
    return { state, warning, control: warning, incident: null };
  }
  if (previous.suppressedKey === key || now - previous.warningAt < MAJORITY_ALARM_WARNING_GRACE_MS ||
      previous.lastAlertedKey === key ||
      (previous.lastAlertedAt !== null && now - previous.lastAlertedAt < MAJORITY_ALARM_INCIDENT_COOLDOWN_MS)) {
    return { state, warning: null, control: persistentControl(), incident: null };
  }

  state.lastAlertedKey = key;
  state.lastAlertedAt = now;
  return {
    state,
    warning: null,
    control: null,
    incident: notice()
  };
}

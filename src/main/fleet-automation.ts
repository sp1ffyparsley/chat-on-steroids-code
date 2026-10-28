/**
 * Machine-wide automation-alarm projection.
 *
 * Every account process owns and atomically publishes only its redacted local supervisor rows.
 * The one legacy/primary process reads those per-account publications and builds the only snapshot
 * that may drive an audible alarm. This keeps account processes independent while preventing
 * three local "majorities" (and three alarms) from pretending to be one fleet-wide incident.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AutomationChatProjection, AutomationSupervisorSnapshot } from './bridge.js';
import type { AutomationChatState } from '../shared/session-activity.js';
import { getActiveInstanceRuntime, getConfig, getInstanceRegistry, getLocalInstanceOwnerPaths } from './config.js';
import { replaceFileAtomically } from './atomic-file.js';
import { logWarn } from './logger.js';

const FLEET_AUTOMATION_FILE = 'automation-alarm-v1.json';
const FLEET_AUTOMATION_VERSION = 1 as const;
const MAX_FLEET_CHATS_PER_ACCOUNT = 64;
const FUTURE_CLOCK_TOLERANCE_MS = 60_000;
/** A process that has not published for ten minutes is independently actionably offline. */
export const FLEET_AUTOMATION_OFFLINE_MS = 10 * 60_000;
/** Let enabled sibling account processes publish once before missing coverage becomes actionable. */
export const FLEET_AUTOMATION_STARTUP_GRACE_MS = 2 * 60_000;
const fleetAutomationStartedAt = Date.now();

const stateSchema = z.enum([
  'working', 'waiting-workers', 'waiting-main', 'recovering', 'stalled', 'paused', 'blocked'
]);
const chatSchema = z.object({
  sessionId: z.string().min(1).max(512),
  conversationId: z.string().min(1).max(512),
  title: z.string().max(512),
  mode: z.enum(['goal', 'loop']),
  state: stateSchema,
  lastWorkedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  recoverable: z.boolean(),
  spinning: z.boolean(),
  activeWorkers: z.number().int().min(0).max(256),
  failedWorkers: z.number().int().min(0).max(256).optional()
});
const automationPublicationSchema = z.discriminatedUnion('admission', [
  z.object({
    admission: z.literal('enabled'),
    holdReason: z.null(),
    /** This projection has no provider-access owner and therefore never manufactures proof. */
    providerVerification: z.literal('unknown')
  }).strict(),
  z.object({
    admission: z.literal('paused'),
    holdReason: z.literal('global-pause'),
    providerVerification: z.literal('unknown')
  }).strict(),
  z.object({
    admission: z.literal('inactive'),
    holdReason: z.literal('runtime-inactive'),
    providerVerification: z.literal('unknown')
  }).strict()
]);
const publicationSchema = z.object({
  schemaVersion: z.literal(FLEET_AUTOMATION_VERSION),
  instanceId: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/i),
  publishedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  runtimeState: z.enum(['active', 'inactive']).optional().default('active'),
  /** Optional only so an older version-1 publisher remains readable without being guessed active. */
  automation: automationPublicationSchema.optional(),
  targetLanes: z.number().int().min(0).max(256),
  chats: z.array(chatSchema).max(MAX_FLEET_CHATS_PER_ACCOUNT)
}).superRefine((publication, context) => {
  if (!publication.automation) return;
  const inactive = publication.runtimeState === 'inactive';
  if (inactive !== (publication.automation.admission === 'inactive')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['automation', 'admission'],
      message: 'automation admission contradicts runtime state'
    });
  }
});

export type FleetAutomationPublication = z.infer<typeof publicationSchema>;
export interface FleetAutomationProfile {
  id: string;
  label: string;
  mode: 'legacy' | 'isolated';
  enabled: boolean;
}

export interface FleetAutomationCoverage {
  state: 'starting' | 'complete' | 'incomplete';
  expectedProfiles: number;
  reportingProfiles: number;
  /** User-facing account labels only; no owner paths or runtime identities cross IPC. */
  missingProfiles: string[];
  graceEndsAt: number | null;
}

export interface FleetAutomationAdmissionView {
  /** Admission is not activity: enabled means scheduling is permitted, not that a model is working. */
  state: 'enabled' | 'paused' | 'inactive' | 'mixed' | 'unknown';
  enabledProfiles: number;
  pausedProfiles: number;
  inactiveProfiles: number;
  unknownProfiles: number;
  /** User-facing labels and fixed public reasons only. */
  holds: Array<{ profile: string; reason: 'global-pause' | 'runtime-inactive' }>;
  /** Provider entitlement is owned elsewhere and is deliberately never inferred here. */
  providerVerification: 'unknown';
}

/** Renderer-safe machine-wide alarm input. A null snapshot always means sound is disarmed. */
export interface FleetAutomationAlarmView {
  snapshot: AutomationSupervisorSnapshot | null;
  coverage: FleetAutomationCoverage;
  /** Optional for compatibility with an older renderer fixture; current aggregation always emits it. */
  automation?: FleetAutomationAdmissionView;
}

const readWarnings = new Map<string, string>();
let runtimeActive = false;
let localPublicationWrites: Promise<void> = Promise.resolve();

/**
 * Authoritative process-local lifecycle fence for alarm publication.
 *
 * A renderer list request is observational and must never turn an intentionally stopped account
 * back into an active publisher. Bridge startup/stop are the only owners allowed to move this
 * fence; every later snapshot consults it when the write is actually queued.
 */
export function setFleetAutomationRuntimeActive(active: boolean): void {
  runtimeActive = active;
}

export function parseFleetAutomationPublication(value: unknown): FleetAutomationPublication | null {
  const parsed = publicationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function publicationPath(healthRoot: string): string {
  return path.join(healthRoot, FLEET_AUTOMATION_FILE);
}

function localPublication(
  snapshot: AutomationSupervisorSnapshot,
  now: number,
  runtimeState: FleetAutomationPublication['runtimeState'] = 'active'
): FleetAutomationPublication {
  if (snapshot.chats.length > MAX_FLEET_CHATS_PER_ACCOUNT) {
    throw new Error(`Automation alarm publication has ${snapshot.chats.length} chats; limit is ${MAX_FLEET_CHATS_PER_ACCOUNT}.`);
  }
  const automation = runtimeState === 'inactive'
    ? { admission: 'inactive' as const, holdReason: 'runtime-inactive' as const, providerVerification: 'unknown' as const }
    : getConfig().ui.automationPaused === true
      ? { admission: 'paused' as const, holdReason: 'global-pause' as const, providerVerification: 'unknown' as const }
      : { admission: 'enabled' as const, holdReason: null, providerVerification: 'unknown' as const };
  return publicationSchema.parse({
    schemaVersion: FLEET_AUTOMATION_VERSION,
    instanceId: getActiveInstanceRuntime().profile.id,
    publishedAt: now,
    runtimeState,
    automation,
    targetLanes: snapshot.targetLanes,
    chats: snapshot.chats.map(chat => ({
      sessionId: chat.sessionId,
      conversationId: chat.conversationId,
      title: chat.title,
      mode: chat.mode,
      state: chat.state,
      lastWorkedAt: chat.lastWorkedAt,
      recoverable: chat.recoverable,
      spinning: chat.spinning,
      activeWorkers: chat.activeWorkers,
      ...(chat.failedWorkers === undefined ? {} : { failedWorkers: chat.failedWorkers })
    }))
  });
}

function automationAdmissionView(
  profiles: readonly FleetAutomationProfile[],
  publications: ReadonlyMap<string, FleetAutomationPublication>
): FleetAutomationAdmissionView {
  let enabledProfiles = 0;
  let pausedProfiles = 0;
  let inactiveProfiles = 0;
  let unknownProfiles = 0;
  const holds: FleetAutomationAdmissionView['holds'] = [];
  for (const profile of profiles) {
    const publication = publications.get(profile.id);
    // Missing enabled profiles remain unknown during coverage grace. A legacy explicit inactive
    // marker is still authoritative, but an active v1 row without the new field is never guessed.
    const admission = publication?.automation?.admission ??
      (publication?.runtimeState === 'inactive' ? 'inactive' : 'unknown');
    if (admission === 'enabled') enabledProfiles += 1;
    else if (admission === 'paused') {
      pausedProfiles += 1;
      holds.push({ profile: profile.label, reason: 'global-pause' });
    } else if (admission === 'inactive') {
      inactiveProfiles += 1;
      holds.push({ profile: profile.label, reason: 'runtime-inactive' });
    } else unknownProfiles += 1;
  }
  const populated = [enabledProfiles, pausedProfiles, inactiveProfiles].filter(count => count > 0).length;
  const state: FleetAutomationAdmissionView['state'] = unknownProfiles > 0 || populated === 0
    ? 'unknown'
    : populated > 1
      ? 'mixed'
      : enabledProfiles > 0
        ? 'enabled'
        : pausedProfiles > 0
          ? 'paused'
          : 'inactive';
  return {
    state,
    enabledProfiles,
    pausedProfiles,
    inactiveProfiles,
    unknownProfiles,
    holds,
    providerVerification: 'unknown'
  };
}

/** Publish this process's complete redacted supervisor view under its canonical health owner. */
async function writeLocalPublicationNow(publication: FleetAutomationPublication): Promise<void> {
  const owners = getLocalInstanceOwnerPaths(getActiveInstanceRuntime().profile.id);
  if (!owners) throw new Error('Active account does not have a local automation-alarm state owner.');
  const target = publicationPath(owners.healthRoot);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await fs.mkdir(owners.healthRoot, { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(publication), { encoding: 'utf8', mode: 0o600 });
  try {
    await replaceFileAtomically(temporary, target, 'Fleet automation alarm snapshot');
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Serialize the one per-profile file so an older active rename cannot land after shutdown. */
function writeLocalPublication(publication: FleetAutomationPublication): Promise<void> {
  const write = localPublicationWrites.catch(() => undefined).then(() => writeLocalPublicationNow(publication));
  localPublicationWrites = write.catch(() => undefined);
  return write;
}

function inactivePublication(now: number): FleetAutomationPublication {
  return localPublication({
    observedAt: now,
    targetLanes: 0,
    chats: [],
    counts: {
      working: 0,
      'waiting-workers': 0,
      'waiting-main': 0,
      recovering: 0,
      stalled: 0,
      paused: 0,
      blocked: 0
    }
  }, now, 'inactive');
}

export async function publishFleetAutomationSnapshot(
  snapshot: AutomationSupervisorSnapshot,
  now = Date.now()
): Promise<void> {
  await writeLocalPublication(runtimeActive ? localPublication(snapshot, now) : inactivePublication(now));
}

/** A supported bridge stop is intentional, so its old active rows must never age into failures. */
export async function publishFleetAutomationInactiveSnapshot(now = Date.now()): Promise<void> {
  await writeLocalPublication(inactivePublication(now));
}

async function readPublication(profileId: string): Promise<FleetAutomationPublication | null> {
  const owners = getLocalInstanceOwnerPaths(profileId);
  if (!owners) return null;
  const file = publicationPath(owners.healthRoot);
  try {
    const value = parseFleetAutomationPublication(JSON.parse(await fs.readFile(file, 'utf8')));
    if (!value) throw new Error('publication schema is invalid');
    if (value.instanceId !== profileId) throw new Error('publication identity does not match its canonical owner');
    readWarnings.delete(file);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const message = error instanceof Error ? error.message : String(error);
    if (readWarnings.get(file) !== message) {
      readWarnings.set(file, message);
      logWarn(`fleet automation alarm: ignored ${file}: ${message}`);
    }
    return null;
  }
}

function fleetChat(
  profile: FleetAutomationProfile,
  publication: FleetAutomationPublication,
  chat: FleetAutomationPublication['chats'][number],
  now: number
): AutomationChatProjection {
  const runtimeOffline = now - publication.publishedAt >= FLEET_AUTOMATION_OFFLINE_MS;
  const actionablyOffline = runtimeOffline && now - chat.lastWorkedAt >= FLEET_AUTOMATION_OFFLINE_MS &&
    chat.state !== 'paused' && chat.state !== 'blocked';
  const state: AutomationChatState = actionablyOffline ? 'stalled' : chat.state;
  const prefix = `${profile.id}:`;
  return {
    sessionId: prefix + chat.sessionId,
    conversationId: prefix + chat.conversationId,
    title: `${profile.label}: ${chat.title || chat.conversationId}`,
    mode: chat.mode,
    state,
    reason: actionablyOffline ? 'This account runtime stopped publishing automation health.' : state,
    nextAction: actionablyOffline ? `Open ${profile.label} and inspect its exact saved chats.` : '',
    nextRetryAt: null,
    lastWorkedAt: chat.lastWorkedAt,
    activeWorkers: chat.activeWorkers,
    ...(chat.failedWorkers === undefined ? {} : { failedWorkers: chat.failedWorkers }),
    recoverable: actionablyOffline ? false : chat.recoverable,
    spinning: actionablyOffline ? false : chat.spinning,
    recoveryStage: null
  };
}

/**
 * Pure fleet fold used by the primary process and focused tests.
 *
 * Missing evidence remains distinct from an empty fleet: it is silent during one bounded startup
 * grace, then becomes visible as incomplete coverage while the nullable snapshot keeps audio
 * fail-closed. No unknown account or chat is synthesized into the majority denominator.
 */
export function aggregateFleetAutomationAlarmView(
  active: FleetAutomationProfile,
  profiles: readonly FleetAutomationProfile[],
  publications: readonly FleetAutomationPublication[],
  now = Date.now(),
  startupAt = fleetAutomationStartedAt
): FleetAutomationAlarmView | null {
  if (active.mode !== 'legacy') return null;
  const newest = new Map<string, FleetAutomationPublication>();
  for (const publication of publications) {
    if (publication.publishedAt > now + FUTURE_CLOCK_TOLERANCE_MS) continue;
    const previous = newest.get(publication.instanceId);
    if (!previous || previous.publishedAt < publication.publishedAt) newest.set(publication.instanceId, publication);
  }
  const chats: AutomationChatProjection[] = [];
  let targetLanes = 0;
  const enabledProfiles = profiles.filter(profile => profile.enabled);
  const automation = automationAdmissionView(enabledProfiles, newest);
  const missingProfiles = enabledProfiles.filter(profile => !newest.has(profile.id));
  if (missingProfiles.length > 0) {
    const graceEndsAt = startupAt + FLEET_AUTOMATION_STARTUP_GRACE_MS;
    return {
      snapshot: null,
      automation,
      coverage: {
        state: now < graceEndsAt ? 'starting' : 'incomplete',
        expectedProfiles: enabledProfiles.length,
        reportingProfiles: enabledProfiles.length - missingProfiles.length,
        missingProfiles: missingProfiles.map(profile => profile.label),
        graceEndsAt
      }
    };
  }
  for (const profile of enabledProfiles) {
    const publication = newest.get(profile.id);
    // The complete-coverage pass above proves this row exists without manufacturing a fallback.
    if (!publication) throw new Error(`Fleet automation coverage lost profile ${profile.id} during aggregation.`);
    if (publication.runtimeState === 'inactive') continue;
    targetLanes += publication.targetLanes;
    for (const chat of publication.chats) chats.push(fleetChat(profile, publication, chat, now));
  }
  const counts: Record<AutomationChatState, number> = {
    working: 0,
    'waiting-workers': 0,
    'waiting-main': 0,
    recovering: 0,
    stalled: 0,
    paused: 0,
    blocked: 0
  };
  for (const chat of chats) counts[chat.state] += 1;
  return {
    snapshot: { observedAt: now, targetLanes, chats, counts },
    automation,
    coverage: {
      state: 'complete',
      expectedProfiles: enabledProfiles.length,
      reportingProfiles: enabledProfiles.length,
      missingProfiles: [],
      graceEndsAt: null
    }
  };
}

/** Compatibility helper for callers that need only the alarm-eligible snapshot. */
export function aggregateFleetAutomationPublications(
  active: FleetAutomationProfile,
  profiles: readonly FleetAutomationProfile[],
  publications: readonly FleetAutomationPublication[],
  now = Date.now()
): AutomationSupervisorSnapshot | null {
  return aggregateFleetAutomationAlarmView(active, profiles, publications, now, 0)?.snapshot ?? null;
}

/** Publish local truth, then return a fleet projection only to the one legacy/primary owner. */
export async function fleetAlarmAutomationSnapshot(
  local: AutomationSupervisorSnapshot,
  now = Date.now()
): Promise<FleetAutomationAlarmView | null> {
  await publishFleetAutomationSnapshot(local, now);
  const activeProfile = getActiveInstanceRuntime().profile;
  if (activeProfile.state.mode !== 'legacy') return null;
  const localProfiles = getInstanceRegistry().profiles.filter(profile => {
    try { return getLocalInstanceOwnerPaths(profile.id) !== null; } catch { return false; }
  });
  const publications = (await Promise.all(localProfiles.map(profile => readPublication(profile.id))))
    .filter((value): value is FleetAutomationPublication => value !== null);
  return aggregateFleetAutomationAlarmView(
    { id: activeProfile.id, label: activeProfile.displayName, mode: activeProfile.state.mode, enabled: activeProfile.enabled !== false },
    localProfiles.map(profile => ({
      id: profile.id,
      label: profile.displayName,
      mode: profile.state.mode,
      enabled: profile.enabled !== false
    })),
    publications,
    now,
    fleetAutomationStartedAt
  );
}

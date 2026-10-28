/**
 * Account-scoped native input admitted by a second launch of the installed app.
 *
 * The command line carries only an opaque UUID. The authored payload must already live in this
 * account runtime's private state directory, so a second instance cannot make the primary read
 * an arbitrary path. `sendDesktopInput` remains the sole delivery owner after admission.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { InputArgs, InputEntry } from './session/input.js';
import { connectionControlSchema, type ConnectionControlRequest } from './connection-control.js';
import { logInfo, logWarn } from './logger.js';
import type { SharedAccountSettingsRequest } from './config.js';
import { instanceProfileSchema } from '../shared/instance-profile.js';
import type { SessionControlsView } from './bridge.js';
import { CORE_NATIVE_IDENTITY_REFUSAL_KEYS, CORE_SHELL_CALL_REJECTION_KEYS, type NativeRequestIdentityDiagnostic,
  type NativeCompletionDiagnostic } from './core-browser-evidence.js';

const ARG_PREFIX = '--cos-enqueue-input=';
const CANCEL_ARG_PREFIX = '--cos-cancel-queued-input=';
const RETRY_ARG_PREFIX = '--cos-retry-queued-input=';
const RETRY_RECEIPT_ARG_PREFIX = '--cos-retry-queued-input-receipt=';
const CREATE_PROFILE_ARG = '--cos-create-profile';
const SET_PROFILE_BROWSER_ARG = '--cos-set-profile-browser';
const PROFILE_BROWSER_ARG = '--cos-profile-browser';
const RENAME_PROFILE_ARG = '--cos-rename-profile';
const PROFILE_NICKNAME_ARG = '--cos-profile-nickname';
const SHARED_ACCOUNTS_ARG = '--cos-shared-accounts';
const SHARE_DRIVE_ARG = '--cos-share-drive';
const SHARED_DRY_RUN_ARG = '--cos-shared-accounts-dry-run';
const sharedAccountsTransportSchema = z.object({ cosSharedAccounts: z.object({
  version: z.literal(1),
  request: z.object({ action: z.enum(['enable', 'disable', 'inspect']),
    drives: z.array(z.string().regex(/^(?:[a-z]:\\|\/)$/i)).max(32), dryRun: z.boolean() }).strict(),
  background: z.boolean()
}).strict() }).strict();
const CANONICAL_PROFILE_ID = /^profile-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const connectionTransportSchema = z.object({ cosConnectionControl: z.object({
  version: z.literal(1), request: connectionControlSchema,
  receipt: z.string().uuid(), isolated: z.boolean(), background: z.boolean()
}).strict() }).strict();
export const CONNECTION_RECEIPTS_STATE = 'connection-control';
type OperatorControl = 'settings' | 'connection' | 'sessions';
export function operatorControlResponsePath(userData: string, receipt: string, control: OperatorControl): string {
  if (!REQUEST_ID.test(receipt)) throw new Error('Operator response requires an exact UUID.');
  return path.join(operatorInputDirectory(userData), `${receipt}.${control}.response.json`);
}
async function writeControlResponse(userData: string, receipt: string, control: OperatorControl, result: unknown) {
  const bytes = JSON.stringify(result);
  if (Buffer.byteLength(bytes) > 2_000_000) throw new Error('Operator response exceeds the bounded local response limit.');
  await fs.mkdir(operatorInputDirectory(userData), { recursive: true });
  await fs.writeFile(operatorControlResponsePath(userData, receipt, control), bytes, { flag: 'wx', mode: 0o600 });
}
async function pruneControlResponses(userData: string, retired: readonly { receipt: string }[], control: OperatorControl) {
  for (const row of retired) await fs.rm(operatorControlResponsePath(userData, row.receipt, control), { force: true });
}
/** Startup/request cleanup shares the private inbox owner; it never touches authored inputs. */
export async function pruneOperatorControlResponses(userData: string): Promise<void> {
  const directory = operatorInputDirectory(userData);
  try {
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const cutoff = Date.now() - 5 * 60_000;
    let removed = 0;
    for (const entry of entries) {
      const match = /^([0-9a-f-]+)\.(settings|connection|sessions)\.response\.json$/i.exec(entry.name);
      if (!match || !REQUEST_ID.test(match[1]!) || !entry.isFile() || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      try {
        const stat = await fs.lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2_000_000 && stat.mtimeMs < cutoff) {
          await fs.unlink(file);
          removed++;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          logWarn('operator control: expired private response cleanup failed; inspect account inbox permissions');
      }
    }
    if (removed) logInfo(`operator control: expired private responses removed (${removed})`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      logWarn('operator control: private response cleanup unavailable; inspect account inbox permissions');
  }
}
const settingsOperationSchema = z.object({ instanceId: z.string().min(1).max(64),
  action: z.enum(['read', 'update']), receipt: z.string().uuid(), isolated: z.boolean() }).strict();
const settingsTransportSchema = z.object({ cosSettingsControl: z.object({ version: z.literal(1),
  request: settingsOperationSchema, background: z.boolean() }).strict() }).strict();
function settingsControlAttempted(argv: readonly string[]) {
  return argv.some(argument => argument.startsWith('--cos-settings-'));
}
export function operatorSettingsControlRequest(argv: readonly string[]) {
  if (!settingsControlAttempted(argv)) return null;
  // Share the exact launcher-prefix and option/cardinality validation with connection control.
  const translated = argv.map(argument => argument.startsWith('--cos-settings-')
    ? argument.replace('--cos-settings-', '--cos-connection-') : argument);
  const action = argv.filter(argument => argument.startsWith('--cos-settings-action='));
  if (action.length !== 1 || !['read', 'update'].includes(action[0]!.slice('--cos-settings-action='.length)))
    throw new Error('Settings control requires one exclusive read or update action.');
  if (argv.some(argument => argument.startsWith('--cos-connection-') || argument.startsWith('--cos-settings-kind')))
    throw new Error('Settings and connection controls cannot share a launch.');
  const parsed = operatorConnectionControlRequest(translated.map(argument => argument.startsWith('--cos-connection-action=')
    ? '--cos-connection-action=status' : argument))!;
  return settingsOperationSchema.parse({ instanceId: parsed.request.instanceId,
    action: action[0]!.slice('--cos-settings-action='.length), receipt: parsed.receipt, isolated: parsed.isolated });
}

export async function processOperatorSettingsControl(argv: readonly string[], userData: string) {
  const request = operatorSettingsControlRequest(argv);
  if (!request) return null;
  const { getActiveInstanceRuntime } = await import('./config.js');
  if (getActiveInstanceRuntime().profile.id !== request.instanceId)
    throw new Error('Settings control targets another account; no settings operation was admitted.');
  await pruneOperatorControlResponses(userData);
  logInfo(`operator settings: ${request.action} requested for ${request.instanceId}; receipt ${request.receipt}`);
  const { readDurableStrict, writeDurableNow } = await import('./durable.js');
  const receiptSchema = z.object({ receipt: z.string().uuid(), instanceId: z.string(),
    action: z.enum(['read', 'update']), state: z.enum(['started', 'completed', 'failed']),
    diagnostic: z.string().max(256).optional(), snapshot: z.unknown().optional() }).strict();
  const parsedHistory = z.array(receiptSchema).max(16).safeParse(await readDurableStrict('settings-control') ?? []);
  if (!parsedHistory.success) throw new Error('Settings receipt history is malformed; inspect the account before retrying.');
  const history = parsedHistory.data.map(({ snapshot: _snapshot, diagnostic: _diagnostic, ...row }) => row);
  // Older versions persisted snapshots. Remove them even when this receipt is a replay.
  await writeDurableNow('settings-control', history);
  const previous = history.find(row => row.receipt === request.receipt);
  if (previous) {
    if (previous.instanceId !== request.instanceId || previous.action !== request.action)
      throw new Error('Settings receipt belongs to another operation.');
    return previous;
  }
  const { readAgentSettings, updateAgentSettings, agentSettingsUpdateSchema, SettingsControlError } = await import('./settings-control.js');
  let update: z.infer<typeof agentSettingsUpdateSchema> | undefined;
  if (request.action === 'update') {
    const file = path.join(operatorInputDirectory(userData), `${request.receipt}.settings.json`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
      throw new Error('Settings update must be a bounded regular private request file.');
    try {
      const raw = await fs.readFile(file, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > 128_000) throw new Error('oversized');
      update = agentSettingsUpdateSchema.parse(JSON.parse(raw));
    } catch { throw new Error('Settings update bundle is malformed; inspect its revision and supported patch fields.'); }
    if (update.instanceId !== request.instanceId) throw new Error('Settings update bundle belongs to another account.');
  }
  const receipt: z.infer<typeof receiptSchema> = { receipt: request.receipt, instanceId: request.instanceId,
    action: request.action, state: 'started' };
  const rows = [...history.slice(-15), receipt];
  await pruneControlResponses(userData, history.slice(0, Math.max(0, history.length - 15)), 'settings');
  await writeDurableNow('settings-control', rows);
  logInfo(`operator settings: ${request.action} started for ${request.instanceId}; receipt ${request.receipt}`);
  try {
    const snapshot = update ? await updateAgentSettings(update) : readAgentSettings();
    await writeControlResponse(userData, request.receipt, 'settings', { ...receipt, state: 'completed', snapshot });
    receipt.state = 'completed';
  } catch (error) {
    receipt.state = 'failed';
    receipt.diagnostic = 'Settings action failed or was refused. Read this account’s current revision, validate the supported patch fields, and inspect its diagnostic log before retrying.';
    await writeControlResponse(userData, request.receipt, 'settings', { ...receipt,
      diagnostic: error instanceof SettingsControlError ? error.message.slice(0, 1024) : receipt.diagnostic });
    logWarn(`operator settings: ${request.action} failed for ${request.instanceId}; receipt ${request.receipt}; inspect revision, patch and account diagnostics`);
  }
  await writeDurableNow('settings-control', rows);
  if (receipt.state === 'completed') logInfo(`operator settings: ${request.action} completed for ${request.instanceId}; receipt ${request.receipt}`);
  if (request.action === 'update') await fs.rm(path.join(operatorInputDirectory(userData), `${request.receipt}.settings.json`), { force: true });
  return receipt;
}
const sessionInspectionFields = {
  instanceId: instanceProfileSchema.shape.id, action: z.enum(['list', 'controls']), receipt: z.string().uuid(),
  limit: z.number().int().min(1).max(60).optional(),
  sessionId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i).optional()
};
const validSessionInspection = (request: { action: string; limit?: number; sessionId?: string }) =>
  request.action === 'list' ? request.limit !== undefined && request.sessionId === undefined
    : request.sessionId !== undefined && request.limit === undefined;
const sessionInspectionOperationSchema = z.object({ ...sessionInspectionFields, isolated: z.boolean() }).strict()
  .refine(validSessionInspection);
const sessionInspectionTransportSchema = z.object({ cosSessionInspection: z.object({ version: z.literal(1),
  request: sessionInspectionOperationSchema, background: z.boolean() }).strict() }).strict();
const sessionInspectionReceiptSchema = z.object({ ...sessionInspectionFields,
  state: z.enum(['started', 'completed', 'failed']) }).strict().refine(validSessionInspection);
export const SESSION_INSPECTION_RECEIPTS_STATE = 'sessions-control';
function sessionInspectionAttempted(argv: readonly string[]) {
  return argv.some(argument => argument.startsWith('--cos-sessions-'));
}

/** Reuse the installed operator's exclusive launcher-prefix and exact-account validation. */
export function operatorSessionInspectionRequest(argv: readonly string[]) {
  if (!sessionInspectionAttempted(argv)) return null;
  const values = (name: string) => argv.filter(argument => argument === name || argument.startsWith(`${name}=`))
    .map(argument => argument === name ? '' : argument.slice(name.length + 1));
  const action = values('--cos-sessions-action'), limit = values('--cos-sessions-limit'), session = values('--cos-sessions-session');
  if (action.length !== 1 || !['list', 'controls'].includes(action[0]!) || limit.length > 1 || session.length > 1 ||
      action[0] === 'list' && (session.length !== 0 || limit.length === 1 && !/^[1-9][0-9]?$/.test(limit[0]!)) ||
      action[0] === 'controls' && (limit.length !== 0 || session.length !== 1) ||
      argv.some(argument => argument.startsWith('--cos-connection-')))
    throw new Error('Session inspection requires one exclusive list (limit 1–60) or controls action with an exact session id.');
  const translated = argv.filter(argument => !argument.startsWith('--cos-sessions-limit=') && !argument.startsWith('--cos-sessions-session='))
    .map(argument => argument.startsWith('--cos-sessions-') ? argument.replace('--cos-sessions-', '--cos-connection-') : argument)
    .map(argument => argument.startsWith('--cos-connection-action=') ? '--cos-connection-action=status' : argument);
  const parsed = operatorConnectionControlRequest(translated)!;
  const request = sessionInspectionOperationSchema.safeParse({ instanceId: parsed.request.instanceId, receipt: parsed.receipt,
    isolated: parsed.isolated, action: action[0], ...(action[0] === 'list' ? { limit: Number(limit[0] ?? 20) } : { sessionId: session[0] }) });
  if (!request.success) throw new Error('Session inspection requires an exact profile, UUID receipt, and a bounded list or valid session id.');
  return request.data;
}

/** Optional debug fields never evaluate accessors or turn a malformed report into a failed inspection. */
function completionRefusalCounts(raw: unknown, maxCalls: number): NativeRequestIdentityDiagnostic['failureReasons'] {
  try {
    if (!Array.isArray(raw) || raw.length > CORE_NATIVE_IDENTITY_REFUSAL_KEYS.length) return null;
    const result: NonNullable<NativeRequestIdentityDiagnostic['failureReasons']> = [];
    for (let index = 0; index < raw.length; index++) {
      const item = Object.getOwnPropertyDescriptor(raw, String(index))?.value;
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const code = Object.getOwnPropertyDescriptor(item, 'code')?.value;
      const calls = Object.getOwnPropertyDescriptor(item, 'calls')?.value;
      if (!CORE_NATIVE_IDENTITY_REFUSAL_KEYS.includes(code) || !Number.isInteger(calls) ||
          calls <= 0 || calls > maxCalls || result.some(prior => prior.code === code)) return null;
      result.push({ code, calls });
    }
    return result;
  } catch { return null; }
}
function completionObservation(raw: unknown): NativeCompletionDiagnostic['observation'] {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const observedAt = Object.getOwnPropertyDescriptor(raw, 'observedAt')?.value;
    const ageMs = Object.getOwnPropertyDescriptor(raw, 'ageMs')?.value;
    const freshness = Object.getOwnPropertyDescriptor(raw, 'freshness')?.value;
    if (!Number.isFinite(observedAt) || observedAt <= 0 ||
        !(ageMs === null || Number.isFinite(ageMs) && ageMs >= 0) ||
        !['fresh', 'stale', 'future', 'unverified'].includes(freshness)) return undefined;
    return { observedAt, ageMs, freshness };
  } catch { return undefined; }
}
/** Reuse Main's page-reader diagnostics without publishing native IDs, text or accessors. */
function inspectedProviderUI(raw: unknown) {
  try {
    const own = (object: unknown, key: string): unknown => object && typeof object === 'object' && !Array.isArray(object)
      ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
    const count = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 400;
    const observedAt = own(raw, 'observedAt'), shell = own(raw, 'shell'), discovery = own(raw, 'discovery');
    const currentTurnMatched = own(raw, 'currentTurnMatched');
    const selectorMatches = own(raw, 'selectorMatches'), mapped = own(raw, 'mapped');
    if (typeof observedAt !== 'number' || !Number.isFinite(observedAt) || observedAt <= 0 ||
        !['classic', 'alternate', 'unknown'].includes(shell as string) ||
        !['compatible', 'failed', 'unknown'].includes(discovery as string) || typeof currentTurnMatched !== 'boolean' ||
        !(selectorMatches === null || count(selectorMatches)) || !(mapped === null || count(mapped))) return null;
    const source = own(raw, 'rejects');
    const rejects: Record<string, number> | null = source && typeof source === 'object' && !Array.isArray(source) ? {} : null;
    if (rejects) for (const key of ['fiberMissing', 'ownerMissing', 'stableKeyMismatch', 'itemsOverLimit', ...CORE_SHELL_CALL_REJECTION_KEYS]) {
      const value = own(source, key);
      if (count(value)) rejects[key] = value; // Preserve a real zero; malformed/missing is never invented as zero.
    }
    const summary = own(raw, 'identityRefusalSummary'), calls = own(summary, 'calls');
    const reasons = count(calls) && calls <= 200 ? completionRefusalCounts(own(summary, 'reasons'), calls) : null;
    const identityRefusalSummary = reasons ? { calls, reasons } : null;
    return { observedAt, shell, discovery, currentTurnMatched, selectorMatches, mapped, rejects, identityRefusalSummary };
  } catch { return null; }
}
/** Project only fixed owner fields. Text, helper answers, tokens and arbitrary errors never enter this lane. */
function inspectedSessionControls(view: SessionControlsView, automationPaused: boolean) {
  const draft = (value: SessionControlsView['goalDraft']) => value ? { stage: value.stage, stageStartedAt: value.stageStartedAt,
    textChars: value.text?.length ?? 0, errorChars: value.error?.length ?? 0, messageChars: value.message?.length ?? 0 } : null;
  const job = view.job;
  const account = view.nativeEvidence?.accountActivity, completion = view.nativeEvidence?.completion;
  const completionDurable = completion?.durable;
  const identityDiagnostic = completion?.requestIdentity as NativeRequestIdentityDiagnostic | undefined;
  const failureReasons = identityDiagnostic ? Object.getOwnPropertyDescriptor(identityDiagnostic, 'failureReasons')?.value : undefined;
  const observation = completion ? completionObservation(Object.getOwnPropertyDescriptor(completion, 'observation')?.value) : undefined;
  return { sessionId: view.sessionId, conversationId: view.conversationId, automation: view.automation, automationPaused,
    objectiveChars: view.objective.length, activeTurnId: view.activeTurnId, blocked: view.blocked,
    loopAfterTurn: view.loopAfterTurn, proLoopDelivery: view.proLoopDelivery,
    finishHeld: view.finishHeld, finishWaiting: view.finishWaiting, queueAtFinish: view.queueAtFinish,
    canInject: view.canInject, canSendDirectly: view.canSendDirectly, stopPending: view.stopPending,
    goalDraft: draft(view.goalDraft), finishGoalDraft: draft(view.finishGoalDraft),
    goalWait: view.goalWait ? { reason: view.goalWait.reason, until: view.goalWait.until, active: view.goalWait.active, limit: view.goalWait.limit } : null,
    nativeEvidence: view.nativeEvidence ? {
      reason: view.nativeEvidence.reason,
      fresh: view.nativeEvidence.fresh, sourceObserved: view.nativeEvidence.sourceObserved,
      finalObserved: view.nativeEvidence.finalObserved, openCalls: view.nativeEvidence.openCalls,
      openCodeCalls: view.nativeEvidence.openCodeCalls, settledCandidate: view.nativeEvidence.settledCandidate,
      ...(typeof view.nativeEvidence.inventoryIncomplete === 'boolean'
        ? { inventoryIncomplete: view.nativeEvidence.inventoryIncomplete } : {}),
      ...(typeof view.nativeEvidence.inventoryCurrentTurnMatched === 'boolean'
        ? { inventoryCurrentTurnMatched: view.nativeEvidence.inventoryCurrentTurnMatched } : {}),
      providerUI: inspectedProviderUI(Object.getOwnPropertyDescriptor(view.nativeEvidence, 'providerUI')?.value),
      physicalIdle: view.nativeEvidence.physicalIdle, physicalHold: view.nativeEvidence.physicalHold, observerBusy: view.nativeEvidence.observerBusy,
      accountActivity: account ? { runningTools: account.runningTools, settlingTools: account.settlingTools,
        managedProcesses: account.managedProcesses, mcpRequests: account.mcpRequests, recordingWrites: account.recordingWrites } : undefined,
      completion: completion && completionDurable ? { reason: completion.reason, retainedCalls: completion.retainedCalls,
        retainedCodeCalls: completion.retainedCodeCalls, missingOriginalNativeIds: completion.missingOriginalNativeIds,
        missingOriginalRequestIds: completion.missingOriginalRequestIds,
        requestIdentity: { status: completion.requestIdentity.status,
          selectedFieldsPresent: completion.requestIdentity.selectedFieldsPresent,
          selectedFieldsMissing: completion.requestIdentity.selectedFieldsMissing,
          selectedIdentitiesWithheld: completion.requestIdentity.selectedIdentitiesWithheld,
          scopeRefusals: completion.requestIdentity.scopeRefusals,
          ...(failureReasons === undefined ? {} : { failureReasons: completionRefusalCounts(failureReasons, completion.retainedCalls) }) },
        ...(observation ? { observation } : {}),
        durable: { reason: completionDurable.reason, checkedCalls: completionDurable.checkedCalls,
          missingCorrelations: completionDurable.missingCorrelations, conflictingCorrelations: completionDurable.conflictingCorrelations,
          missingTerminalResults: completionDurable.missingTerminalResults, ambiguousTerminalResults: completionDurable.ambiguousTerminalResults,
          pendingRecordedProcesses: completionDurable.pendingRecordedProcesses } } : undefined
    } : null,
    recovery: view.recovery?.slice(0, 20).map(row => ({ kind: row.kind, deadline: row.deadline, staleSince: row.staleSince,
      visibleAt: row.visibleAt, next: row.next })),
    plan: view.plan ? { updatedAt: view.plan.updatedAt, steps: view.plan.plan.slice(0, 12).map(row => ({ status: row.status,
      stepChars: row.step.length, detailChars: row.details?.length ?? 0 })),
      checklist: view.plan.checklist?.slice(0, 24).map(row => ({ id: row.id, status: row.status })) } : null,
    activeWork: { primeSessionId: view.activeWork.primeSessionId, sessionIds: view.activeWork.sessionIds.slice(0, 60),
      sessionCount: view.activeWork.sessionIds.length, activeWorkMs: view.activeWork.activeWorkMs,
      activeWorkMeasurement: view.activeWork.activeWorkMeasurement,
      report: view.activeWork.report ? { pending: Boolean(view.activeWork.report.pending), delivered: Boolean(view.activeWork.report.delivered) } : null },
    diagnosticIncidents: view.diagnosticIncidents.slice(0, 20).map(row => ({ id: row.id, kind: row.kind,
      sourceSessionId: row.sourceSessionId, sourceConversationId: row.sourceConversationId, status: row.status,
      inputCustody: row.inputCustody, disposition: row.disposition })),
    diagnosticChat: view.diagnosticChat ? { sessionId: view.diagnosticChat.sessionId, conversationId: view.diagnosticChat.conversationId } : null,
    job: job ? { sessionId: job.sessionId, stage: job.stage, startedAt: job.startedAt, automatic: job.automatic,
      busy: job.busy, cancellable: job.cancellable, handoffId: job.handoffId, sourceSend: { state: job.sourceSend.state, messageId: job.sourceSend.messageId },
      destinationSend: { state: job.destinationSend.state, conversationId: job.destinationSend.conversationId, messageId: job.destinationSend.messageId },
      waitReasonChars: job.waitReason?.length ?? 0, errorChars: job.error?.length ?? 0 } : null };
}

let sessionInspectionSerial: Promise<unknown> = Promise.resolve();
/** The session owners are already restored by Main before this native operator path runs. */
export async function processOperatorSessionInspection(argv: readonly string[], userData: string) {
  const request = operatorSessionInspectionRequest(argv);
  if (!request) return null;
  const run = sessionInspectionSerial.catch(() => undefined).then(async () => {
    const { getActiveInstanceRuntime, getConfig } = await import('./config.js');
    const assertOwner = () => {
      const { profile } = getActiveInstanceRuntime();
      if (profile.id !== request.instanceId) throw new Error('Session inspection targets another account; no session read was admitted.');
      if ((profile.state.mode === 'isolated') !== request.isolated)
        throw new Error('Session inspection routing must match this exact account’s isolated selector.');
      const expected = profile.state.mode === 'legacy' ? profile.state.root : path.join(profile.state.root, 'runtime');
      if (!path.isAbsolute(userData) || path.resolve(userData) !== path.resolve(expected))
        throw new Error('Session inspection response runtime does not belong to this exact account.');
    };
    assertOwner();
    const { readDurableStrict, writeDurableNow } = await import('./durable.js');
    const stored = z.array(sessionInspectionReceiptSchema).max(16).safeParse(await readDurableStrict(SESSION_INSPECTION_RECEIPTS_STATE) ?? []);
    if (!stored.success || new Set(stored.data.map(row => row.receipt)).size !== stored.data.length ||
        stored.data.some(row => row.instanceId !== request.instanceId))
      throw new Error('Session inspection receipt history is malformed; inspect this account’s diagnostic log.');
    const { isolated: _isolated, ...identity } = request;
    const previous = stored.data.find(row => row.receipt === request.receipt);
    if (previous) {
      if (previous.instanceId !== request.instanceId || previous.action !== request.action ||
          previous.sessionId !== request.sessionId || previous.limit !== request.limit)
        throw new Error('Session inspection receipt belongs to another operation.');
      return previous;
    }
    await pruneOperatorControlResponses(userData);
    const receipt = { ...identity, state: 'started' as 'started' | 'completed' | 'failed' };
    const rows = [...stored.data.slice(-15), receipt];
    await pruneControlResponses(userData, stored.data.slice(0, Math.max(0, stored.data.length - 15)), 'sessions');
    await writeDurableNow(SESSION_INSPECTION_RECEIPTS_STATE, rows);
    logInfo(`operator sessions: ${request.action} started for ${request.instanceId}; receipt ${request.receipt}`);
    let response: Record<string, unknown>;
    try {
      assertOwner();
      const { listSessionPage, getSession } = await import('./session/store.js');
      let snapshot: unknown;
      if (request.action === 'list') {
        const page = await listSessionPage({ limit: request.limit! });
        snapshot = { total: page.total, hasMore: page.nextCursor !== null, sessions: page.sessions.slice(0, request.limit!).map(row => ({
          sessionId: row.id, conversationId: row.conversationId, titleChars: row.title.length, origin: row.origin?.kind ?? null,
          updatedAt: row.updatedAt, endedAt: row.endedAt, recordedActiveTurnId: row.activeTurnId,
          events: row.events, userMessages: row.userMessages, toolCalls: row.toolCalls, lastTurnOutcome: row.lastTurnOutcome })) };
      } else {
        const before = await getSession(request.sessionId!);
        if (!before) throw new Error('session_not_recorded');
        const controls = await (await import('./bridge.js')).sessionControlsFor(request.sessionId!);
        const after = await getSession(request.sessionId!);
        if (controls.sessionId !== request.sessionId || !after || controls.conversationId !== before.conversationId ||
            after.conversationId !== controls.conversationId) throw new Error('conversation_changed');
        snapshot = inspectedSessionControls(controls, getConfig().ui.automationPaused === true);
      }
      assertOwner();
      response = { ...receipt, state: 'completed', observedAt: Date.now(), snapshot };
      if (Buffer.byteLength(JSON.stringify(response)) > 128_000) throw new Error('projection_exceeds_bound');
    } catch {
      response = { ...receipt, state: 'failed', observedAt: Date.now(),
        diagnostic: 'Session inspection was refused or failed. Check the exact session, current account binding and account diagnostic log. This response grants no dispatch or retry authority.' };
      logWarn(`operator sessions: ${request.action} failed for ${request.instanceId}; receipt ${request.receipt}; inspect account and session ownership`);
    }
    assertOwner();
    await writeControlResponse(userData, request.receipt, 'sessions', response);
    receipt.state = response.state as typeof receipt.state;
    await writeDurableNow(SESSION_INSPECTION_RECEIPTS_STATE, rows);
    logInfo(`operator sessions: ${request.action} ${receipt.state} for ${request.instanceId}; receipt ${request.receipt}`);
    return receipt;
  });
  sessionInspectionSerial = run;
  return run;
}

function connectionControlAttempted(argv: readonly string[]): boolean {
  return argv.some(argument => argument.startsWith('--cos-connection-'));
}

/** The target identity is explicit even for the primary account; selectors never imply it. */
export function operatorConnectionControlRequest(argv: readonly string[]) {
  if (!connectionControlAttempted(argv)) return null;
  const values = (name: string) => argv.filter(argument => argument === name || argument.startsWith(`${name}=`))
    .map(argument => argument === name ? '' : argument.slice(name.length + 1));
  const action = values('--cos-connection-action'), instanceId = values('--cos-connection-profile');
  const kind = values('--cos-connection-kind'), receipt = values('--cos-connection-receipt');
  const origin = values('--cos-connection-origin'), port = values('--cos-connection-port');
  const tunnel = values('--cos-connection-tunnel-id');
  const selectors = values('--cos-instance-runtime');
  const firstOption = argv.findIndex(argument => argument.startsWith('--'));
  const appRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const devEntry = firstOption === 2 ? path.resolve(argv[1]!) : null;
  const allowed = ['--cos-connection-action=', '--cos-connection-profile=', '--cos-connection-kind=',
    '--cos-connection-receipt=', '--cos-instance-runtime=', '--cos-connection-origin=', '--cos-connection-port=', '--cos-connection-tunnel-id='];
  if (firstOption > 2 || devEntry !== null && devEntry !== appRoot && devEntry !== path.join(appRoot, 'out', 'main', 'index.js') ||
      argv.slice(firstOption).some(argument => !argument.startsWith('--')) ||
      argv.some(argument => argument.startsWith('--') && argument !== '--background' && !allowed.some(prefix => argument.startsWith(prefix))) ||
      argv.filter(argument => argument === '--background').length > 1 ||
      action.length !== 1 || instanceId.length !== 1 || receipt.length !== 1 || kind.length > 1 || selectors.length > 1 ||
      origin.length > 1 || port.length > 1 || tunnel.length > 1 || port.length === 1 && !/^(0|[1-9][0-9]{0,4})$/.test(port[0]!) ||
      !REQUEST_ID.test(receipt[0]!) ||
      selectors.length === 1 && (selectors[0] !== instanceId[0] || !CANONICAL_PROFILE_ID.test(selectors[0]!)))
    throw new Error('Connection control requires one exclusive exact-profile action and UUID receipt; mixed or malformed arguments are refused.');
  const request = connectionControlSchema.safeParse({ instanceId: instanceId[0], action: action[0], ...(kind.length ? { kind: kind[0] } : {}),
    ...(tunnel.length ? { tunnelId: tunnel[0] } : {}),
    ...(origin.length ? { manualPublicOrigin: origin[0] } : {}), ...(port.length ? { manualPort: Number(port[0]) } : {}) });
  if (!request.success) throw new Error('Connection control requires status, setup, configure with a supported kind, connect or disconnect.');
  return { request: request.data, receipt: receipt[0]!, isolated: selectors.length === 1 };
}

/** Bounded receipts acknowledge a single local action; never retry an interrupted mutation. */
export async function processOperatorConnectionControl(argv: readonly string[],
  controller?: (request: ConnectionControlRequest) => Promise<unknown>, userData?: string) {
  const operation = operatorConnectionControlRequest(argv);
  if (!operation) return null;
  if (!userData) {
    const { profile } = (await import('./config.js')).getActiveInstanceRuntime();
    userData = profile.state.mode === 'legacy' ? profile.state.root : path.join(profile.state.root, 'runtime');
  }
  await pruneOperatorControlResponses(userData);
  const { readDurableStrict, writeDurableNow } = await import('./durable.js');
  type Receipt = { receipt: string; instanceId: string; action: string; kind?: string; tunnelId?: string; manualPublicOrigin?: string; manualPort?: number; state: 'started' | 'completed' | 'failed'; diagnostic?: string; status?: unknown };
  const stored = await readDurableStrict<Receipt[]>(CONNECTION_RECEIPTS_STATE) ?? [];
  if (!Array.isArray(stored) || stored.length > 64 || stored.some(row => !row || !REQUEST_ID.test(row.receipt) ||
    typeof row.instanceId !== 'string' || row.instanceId.length > 64 ||
    !['status', 'setup', 'configure', 'connect', 'disconnect'].includes(row.action) ||
    !['started', 'completed', 'failed'].includes(row.state) || row.kind !== undefined && !['openai', 'cloudflared', 'manual'].includes(row.kind) ||
    !connectionControlSchema.safeParse({ instanceId: row.instanceId, action: row.action, ...(row.kind === undefined ? {} : { kind: row.kind }),
      ...(row.tunnelId === undefined ? {} : { tunnelId: row.tunnelId }),
      ...(row.manualPublicOrigin === undefined ? {} : { manualPublicOrigin: row.manualPublicOrigin }),
      ...(row.manualPort === undefined ? {} : { manualPort: row.manualPort }) }).success))
    throw new Error('Connection control receipt history is invalid; inspect account state before retrying.');
  const history = stored.map(row => ({ receipt: row.receipt, instanceId: row.instanceId, action: row.action,
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.tunnelId === undefined ? {} : { tunnelId: row.tunnelId }),
    ...(row.manualPublicOrigin === undefined ? {} : { manualPublicOrigin: row.manualPublicOrigin }),
    ...(row.manualPort === undefined ? {} : { manualPort: row.manualPort }), state: row.state }));
  await writeDurableNow(CONNECTION_RECEIPTS_STATE, history);
  const previous = history.find(row => row.receipt === operation.receipt);
  if (previous) {
    if (previous.instanceId !== operation.request.instanceId || previous.action !== operation.request.action || previous.kind !== operation.request.kind ||
        previous.tunnelId !== operation.request.tunnelId || previous.manualPublicOrigin !== operation.request.manualPublicOrigin || previous.manualPort !== operation.request.manualPort)
      throw new Error('Connection control receipt belongs to another operation.');
    return previous;
  }
  const receipt: Receipt = { receipt: operation.receipt, instanceId: operation.request.instanceId,
    action: operation.request.action, ...(operation.request.kind ? { kind: operation.request.kind } : {}),
    ...(operation.request.tunnelId === undefined ? {} : { tunnelId: operation.request.tunnelId }),
    ...(operation.request.manualPublicOrigin === undefined ? {} : { manualPublicOrigin: operation.request.manualPublicOrigin }),
    ...(operation.request.manualPort === undefined ? {} : { manualPort: operation.request.manualPort }), state: 'started' };
  const rows = [...history.slice(-63), receipt];
  await pruneControlResponses(userData, history.slice(0, Math.max(0, history.length - 63)), 'connection');
  await writeDurableNow(CONNECTION_RECEIPTS_STATE, rows);
  try {
    const status = await (controller ?? (await import('./connection-control.js')).controlConnection)(operation.request);
    await writeControlResponse(userData, operation.receipt, 'connection', { ...receipt, state: 'completed', status });
    receipt.state = 'completed';
  } catch {
    receipt.state = 'failed';
    receipt.diagnostic = 'Connection action failed or was refused. Check exact account identity, current connection status, active work and this account’s diagnostic log before retrying.';
  }
  await writeDurableNow(CONNECTION_RECEIPTS_STATE, rows);
  return receipt;
}
const retryEvidenceSchema = z.array(z.string().uuid()).max(50)
  .refine(ids => new Set(ids).size === ids.length, 'Operator retry evidence contains duplicate ids');
const bundleSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  retryOf: retryEvidenceSchema.optional(),
  input: z.unknown()
}).strict();

const operatorTargetSchema = z.union([
  z.object({ sessionId: z.string().min(8).max(64) }).strict(),
  z.object({ conversationId: z.string().min(8).max(256) }).strict(),
  z.object({ title: z.string().trim().min(1).max(300) }).strict()
]);
const targetedBundleSchema = z.object({
  version: z.literal(2),
  id: z.string().uuid(),
  target: operatorTargetSchema,
  retryOf: retryEvidenceSchema.optional(),
  input: z.unknown()
}).strict();
// Older installations reject version 3 before admission instead of silently stripping
// prerequisite metadata and dispatching an ungated recipe.
const workflowBundleSchema = z.object({ version: z.literal(3), id: z.string().uuid(),
  target: operatorTargetSchema.optional(), input: z.unknown() }).strict();
const anyBundleSchema = z.discriminatedUnion('version', [bundleSchema, targetedBundleSchema, workflowBundleSchema]);
export type OperatorInputTarget = z.infer<typeof operatorTargetSchema>;

type Sender = (input: InputArgs) => Promise<InputEntry>;
type TargetResolver = (target: OperatorInputTarget) => Promise<string>;
type Canceller = (id: string) => Promise<boolean>;
type BrowserRetrier = (id: string, requireAttentionFence: boolean, operatorReceipt: string) => Promise<InputEntry | null>;
type BrowserRetryRequest = { id: string; receipt: string };
type PreparedOperatorInput = {
  id: string;
  pending: string;
  claimed: string;
  input: InputArgs;
};

export type OperatorProfileCreationRequest = { nickname: string; browserProfileDirectory: string };
export type OperatorProfileBrowserBindingRequest = { id: string; browserProfileDirectory: string };
export type OperatorProfileRenameRequest = { id: string; nickname: string };
const profileCreationTransportSchema = z.object({ cosProfileCreation: z.object({
  version: z.literal(1),
  request: z.object({ nickname: z.string().min(1).max(48), browserProfileDirectory: z.string().min(1).max(128) }).strict(),
  background: z.boolean()
}).strict() }).strict();
const profileBrowserBindingTransportSchema = z.object({ cosProfileBrowserBinding: z.object({
  version: z.literal(1),
  request: z.object({ id: z.string().regex(CANONICAL_PROFILE_ID), browserProfileDirectory: z.string().min(1).max(128) }).strict(),
  background: z.boolean()
}).strict() }).strict();
const profileRenameTransportSchema = z.object({ cosProfileRename: z.object({
  version: z.literal(1),
  request: z.object({ id: z.string().regex(CANONICAL_PROFILE_ID), nickname: z.string().min(1).max(48) }).strict(),
  background: z.boolean()
}).strict() }).strict();
type ProfileSetupRequest = { kind: 'create'; request: OperatorProfileCreationRequest } |
  { kind: 'set-browser'; request: OperatorProfileBrowserBindingRequest } |
  { kind: 'rename'; request: OperatorProfileRenameRequest };

function profileSetupAttempted(argv: readonly string[]): boolean {
  return argv.some(argument => argument.startsWith('--cos-create-') || argument.startsWith('--cos-profile-') ||
    argument.startsWith('--cos-set-profile-') || argument.startsWith('--cos-rename-'));
}

function sharedAccountsAttempted(argv: readonly string[]): boolean {
  return argv.some(argument => argument.startsWith('--cos-shared-') || argument.startsWith('--cos-share-'));
}

/** Exact local-primary control. No inferred paths, secrets, account selectors or mixed actions. */
export function operatorSharedAccountSettingsRequest(argv: readonly string[]): SharedAccountSettingsRequest | null {
  if (!sharedAccountsAttempted(argv)) return null;
  const firstOption = argv.findIndex(argument => argument.startsWith('--'));
  const appRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const devEntry = firstOption === 2 ? path.resolve(argv[1]!) : null;
  if (firstOption > 2 || devEntry !== null && devEntry !== appRoot && devEntry !== path.join(appRoot, 'out', 'main', 'index.js') ||
      argv.slice(firstOption).some(argument => !argument.startsWith('--')))
    throw new Error('Shared account settings do not accept positional arguments. Quote each complete drive option.');
  const actions = argv.filter(argument => argument === SHARED_ACCOUNTS_ARG || argument.startsWith(`${SHARED_ACCOUNTS_ARG}=`));
  const drives = argv.filter(argument => argument === SHARE_DRIVE_ARG || argument.startsWith(`${SHARE_DRIVE_ARG}=`))
    .map(argument => argument === SHARE_DRIVE_ARG ? '' : argument.slice(SHARE_DRIVE_ARG.length + 1));
  const selectors = argv.filter(argument => argument.startsWith('--cos-instance-runtime='));
  if (actions.length !== 1 || argv.filter(argument => argument === SHARED_DRY_RUN_ARG).length > 1 ||
      argv.filter(argument => argument === '--background').length > 1 ||
      argv.some(argument => argument.startsWith('--') && argument !== '--background' && argument !== SHARED_DRY_RUN_ARG &&
        !argument.startsWith(`${SHARED_ACCOUNTS_ARG}=`) && !argument.startsWith(`${SHARE_DRIVE_ARG}=`) &&
        !argument.startsWith('--cos-instance-runtime=')))
    throw new Error('Shared account settings require one exclusive action with optional explicit drives, dry-run and background flags.');
  const parsed = sharedAccountsTransportSchema.shape.cosSharedAccounts.shape.request.safeParse({
    action: actions[0]!.slice(SHARED_ACCOUNTS_ARG.length + 1), drives, dryRun: argv.includes(SHARED_DRY_RUN_ARG)
  });
  if (!parsed.success || new Set(drives.map(drive => drive.toLowerCase())).size !== drives.length ||
      parsed.data.action !== 'enable' && drives.length > 0 || selectors.length > 1 ||
      selectors.length === 1 && (parsed.data.action !== 'inspect' ||
        !CANONICAL_PROFILE_ID.test(selectors[0]!.slice('--cos-instance-runtime='.length))))
    throw new Error('Shared account settings accept enable, disable or inspect and distinct exact filesystem roots only.');
  return parsed.data;
}

/** Non-secret profile controls only. Reuse the native account owner, not the delivery bundle path.
 * Reject mixed controls before any dispatcher can perform their independent side effects. */
function profileSetupRequest(argv: readonly string[]): ProfileSetupRequest | null {
  if (!profileSetupAttempted(argv)) return null;
  // argv may include the executable and an Electron app-path prefix. Once options start,
  // every argument must be an explicit supported option: Start-Process otherwise splits a
  // directory such as "Profile 8" into an accepted "Profile" plus an ignored positional "8".
  const firstOption = argv.findIndex(argument => argument.startsWith('--'));
  const appRoot = fileURLToPath(new URL('../..', import.meta.url));
  const devEntry = firstOption === 2 ? path.resolve(argv[1]!) : null;
  if (firstOption > 2 || devEntry !== null && devEntry !== path.resolve(appRoot) &&
      devEntry !== path.join(appRoot, 'out', 'main', 'index.js') ||
      argv.slice(firstOption).some(argument => !argument.startsWith('--'))) {
    throw new Error('Account setup does not accept positional arguments after its launcher prefix. Quote the complete browser-directory option.');
  }
  const values = (name: string): string[] => argv.filter(argument => argument === name || argument.startsWith(`${name}=`))
    .map(argument => argument === name ? '' : argument.slice(name.length + 1));
  const names = values(CREATE_PROFILE_ARG), ids = values(SET_PROFILE_BROWSER_ARG), directories = values(PROFILE_BROWSER_ARG);
  const renameIds = values(RENAME_PROFILE_ARG), nicknames = values(PROFILE_NICKNAME_ARG);
  if (renameIds.length || nicknames.length) {
    if (renameIds.length !== 1 || nicknames.length !== 1 || names.length || ids.length || directories.length ||
        argv.filter(argument => argument === '--background').length > 1 ||
        argv.some(argument => argument.startsWith('--') && argument !== '--background' &&
          !argument.startsWith(`${RENAME_PROFILE_ARG}=`) && !argument.startsWith(`${PROFILE_NICKNAME_ARG}=`))) {
      throw new Error('Account nickname rename requires one exclusive exact profile id and one nickname, plus optional --background.');
    }
    if (!CANONICAL_PROFILE_ID.test(renameIds[0]!)) throw new Error('Account nickname rename requires the exact canonical v4 profile id.');
    const nickname = nicknames[0]!.trim();
    if (!nickname || nickname.length > 48 || /[/\\\x00-\x1f\x7f\u2028\u2029]/.test(nicknames[0]!)) {
      throw new Error('Account nickname rename requires 1–48 characters without path separators or control characters.');
    }
    return { kind: 'rename', request: { id: renameIds[0]!, nickname } };
  }
  if (directories.length !== 1 || !((names.length === 1 && ids.length === 0) || (ids.length === 1 && names.length === 0))) {
    throw new Error('Account setup requires exactly one create-profile nickname or set-profile-browser id, paired with one --cos-profile-browser=<directory>.');
  }
  if (argv.some(argument => argument.startsWith('--') && argument !== '--background' &&
      !argument.startsWith(`${CREATE_PROFILE_ARG}=`) && !argument.startsWith(`${SET_PROFILE_BROWSER_ARG}=`) &&
      !argument.startsWith(`${PROFILE_BROWSER_ARG}=`)) || argv.filter(argument => argument === '--background').length > 1) {
    throw new Error('Account setup cannot share a launch with other controls. Use only one profile operation and its browser-directory option (plus optional --background).');
  }
  const browserProfileDirectory = directories[0]!.trim();
  if (!browserProfileDirectory || browserProfileDirectory.length > 128 ||
      /[/\\:*?"<>|\x00-\x1f\x7f]/.test(directories[0]!) || browserProfileDirectory === '.' || browserProfileDirectory === '..') {
    throw new Error('Account setup requires a Chrome/Chromium profile directory name, not a path.');
  }
  if (ids.length === 1) {
    if (!CANONICAL_PROFILE_ID.test(ids[0]!)) throw new Error('Browser rebinding requires the exact canonical v4 profile id.');
    return { kind: 'set-browser', request: { id: ids[0]!, browserProfileDirectory } };
  }
  const nickname = names[0]!.trim();
  if (!nickname || nickname.length > 48 || /[/\\\x00-\x1f\x7f\u2028\u2029]/.test(names[0]!)) {
    throw new Error('Account creation requires a nickname of 1–48 characters without path separators or control characters.');
  }
  return { kind: 'create', request: { nickname, browserProfileDirectory } };
}

export function operatorProfileCreationRequest(argv: readonly string[]): OperatorProfileCreationRequest | null {
  const setup = profileSetupRequest(argv);
  return setup?.kind === 'create' ? setup.request : null;
}

export function operatorProfileBrowserBindingRequest(argv: readonly string[]): OperatorProfileBrowserBindingRequest | null {
  const setup = profileSetupRequest(argv);
  return setup?.kind === 'set-browser' ? setup.request : null;
}

export function operatorProfileRenameRequest(argv: readonly string[]): OperatorProfileRenameRequest | null {
  const setup = profileSetupRequest(argv);
  return setup?.kind === 'rename' ? setup.request : null;
}

/** Electron may reorder argv and inject Chromium switches in second-instance. Send only the
 * preflighted non-secret account setup request through its documented additionalData channel.
 * Retain the creation envelope for compatibility; browser binding and nickname use strict shapes. */
export function operatorProfileCreationAdditionalData(argv: readonly string[]):
  z.infer<typeof profileCreationTransportSchema> | z.infer<typeof profileBrowserBindingTransportSchema> | z.infer<typeof profileRenameTransportSchema> |
  z.infer<typeof connectionTransportSchema> | z.infer<typeof settingsTransportSchema> | z.infer<typeof sessionInspectionTransportSchema> | z.infer<typeof sharedAccountsTransportSchema> | undefined {
  const inspection = operatorSessionInspectionRequest(argv);
  if (inspection) return { cosSessionInspection: { version: 1, request: inspection, background: argv.includes('--background') } };
  const settings = operatorSettingsControlRequest(argv);
  if (settings) return { cosSettingsControl: { version: 1, request: settings, background: argv.includes('--background') } };
  const connection = operatorConnectionControlRequest(argv);
  if (connection) return { cosConnectionControl: { version: 1, ...connection, background: argv.includes('--background') } };
  const shared = operatorSharedAccountSettingsRequest(argv);
  if (shared) return { cosSharedAccounts: { version: 1, request: shared, background: argv.includes('--background') } };
  const setup = profileSetupRequest(argv);
  if (!setup) return undefined;
  const background = argv.includes('--background');
  if (setup.kind === 'rename') return { cosProfileRename: { version: 1, request: setup.request, background } };
  return setup.kind === 'create'
    ? { cosProfileCreation: { version: 1, request: setup.request, background } }
    : { cosProfileBrowserBinding: { version: 1, request: setup.request, background } };
}

/** Structured registration is exclusive: never reinterpret its mutated argv as another control.
 * Missing/invalid payload for any attempted registration is consumed fail-closed by the caller. */
export function operatorProfileCreationSecondInstanceArgs(argv: readonly string[], additionalData: unknown): string[] | null {
  const object = additionalData && typeof additionalData === 'object' && !Array.isArray(additionalData)
    ? additionalData as Record<string, unknown> : null;
  if (object && Object.prototype.hasOwnProperty.call(object, 'cosSessionInspection')) {
    const parsed = sessionInspectionTransportSchema.safeParse(additionalData);
    if (!parsed.success) throw new Error('Session inspection transport is malformed; no control was admitted.');
    const { request, background } = parsed.data.cosSessionInspection;
    const canonical = [`--cos-sessions-action=${request.action}`, `--cos-sessions-profile=${request.instanceId}`,
      `--cos-sessions-receipt=${request.receipt}`, ...(request.action === 'list' ? [`--cos-sessions-limit=${request.limit}`]
        : [`--cos-sessions-session=${request.sessionId}`]), ...(request.isolated ? [`--cos-instance-runtime=${request.instanceId}`] : []),
      ...(background ? ['--background'] : [])];
    operatorSessionInspectionRequest(canonical);
    return canonical;
  }
  if (object && Object.prototype.hasOwnProperty.call(object, 'cosSettingsControl')) {
    const parsed = settingsTransportSchema.safeParse(additionalData);
    if (!parsed.success) throw new Error('Settings control transport is malformed; no control was admitted.');
    const { request, background } = parsed.data.cosSettingsControl;
    const canonical = [`--cos-settings-action=${request.action}`, `--cos-settings-profile=${request.instanceId}`,
      `--cos-settings-receipt=${request.receipt}`, ...(request.isolated ? [`--cos-instance-runtime=${request.instanceId}`] : []),
      ...(background ? ['--background'] : [])];
    operatorSettingsControlRequest(canonical);
    return canonical;
  }
  if (object && Object.prototype.hasOwnProperty.call(object, 'cosConnectionControl')) {
    const parsed = connectionTransportSchema.safeParse(additionalData);
    if (!parsed.success) throw new Error('Connection control transport is malformed; no control was admitted.');
    const { request, receipt, isolated, background } = parsed.data.cosConnectionControl;
    const canonical = [`--cos-connection-action=${request.action}`, `--cos-connection-profile=${request.instanceId}`,
      `--cos-connection-receipt=${receipt}`, ...(request.kind ? [`--cos-connection-kind=${request.kind}`] : []),
      ...(request.tunnelId === undefined ? [] : [`--cos-connection-tunnel-id=${request.tunnelId}`]),
      ...(request.manualPublicOrigin === undefined ? [] : [`--cos-connection-origin=${request.manualPublicOrigin}`]),
      ...(request.manualPort === undefined ? [] : [`--cos-connection-port=${request.manualPort}`]),
      ...(isolated ? [`--cos-instance-runtime=${request.instanceId}`] : []), ...(background ? ['--background'] : [])];
    operatorConnectionControlRequest(canonical);
    return canonical;
  }
  if (object && Object.prototype.hasOwnProperty.call(object, 'cosSharedAccounts')) {
    const parsed = sharedAccountsTransportSchema.safeParse(additionalData);
    if (!parsed.success) throw new Error('Shared account settings transport is malformed or contains unsupported fields; no control was admitted.');
    const { request, background } = parsed.data.cosSharedAccounts;
    const canonical = [`${SHARED_ACCOUNTS_ARG}=${request.action}`, ...request.drives.map(drive => `${SHARE_DRIVE_ARG}=${drive}`),
      ...(request.dryRun ? [SHARED_DRY_RUN_ARG] : []), ...(background ? ['--background'] : [])];
    operatorSharedAccountSettingsRequest(canonical);
    return canonical;
  }
  if (object && Object.prototype.hasOwnProperty.call(object, 'cosProfileBrowserBinding')) {
    const parsed = profileBrowserBindingTransportSchema.safeParse(additionalData);
    if (!parsed.success) throw new Error('Account browser-binding transport is malformed or contains unsupported fields; no control was admitted.');
    const { request, background } = parsed.data.cosProfileBrowserBinding;
    const canonical = [`${SET_PROFILE_BROWSER_ARG}=${request.id}`, `${PROFILE_BROWSER_ARG}=${request.browserProfileDirectory}`,
      ...(background ? ['--background'] : [])];
    operatorProfileBrowserBindingRequest(canonical);
    return canonical;
  }
  if (object && Object.prototype.hasOwnProperty.call(object, 'cosProfileRename')) {
    const parsed = profileRenameTransportSchema.safeParse(additionalData);
    if (!parsed.success) throw new Error('Account nickname transport is malformed or contains unsupported fields; no control was admitted.');
    const { request, background } = parsed.data.cosProfileRename;
    const canonical = [`${RENAME_PROFILE_ARG}=${request.id}`, `${PROFILE_NICKNAME_ARG}=${request.nickname}`,
      ...(background ? ['--background'] : [])];
    operatorProfileRenameRequest(canonical);
    return canonical;
  }
  if (!object || !Object.prototype.hasOwnProperty.call(object, 'cosProfileCreation')) {
    const attempted = profileSetupAttempted(argv) || sharedAccountsAttempted(argv) || connectionControlAttempted(argv) || settingsControlAttempted(argv) || sessionInspectionAttempted(argv);
    if (attempted || additionalData != null && (!object || Object.keys(object).length !== 0))
      throw new Error('Account creation transport is missing or invalid; no control was admitted.');
    return null;
  }
  const parsed = profileCreationTransportSchema.safeParse(additionalData);
  if (!parsed.success) throw new Error('Account creation transport is malformed or contains unsupported fields; no control was admitted.');
  const { request, background } = parsed.data.cosProfileCreation;
  const canonical = [`${CREATE_PROFILE_ARG}=${request.nickname}`, `${PROFILE_BROWSER_ARG}=${request.browserProfileDirectory}`,
    ...(background ? ['--background'] : [])];
  operatorProfileCreationRequest(canonical);
  return canonical;
}

export async function processOperatorProfileCreation(
  argv: readonly string[],
  creator: (nickname: string, browserProfileDirectory: string) => Promise<{ createdProfileId: string }>
): Promise<string | null> {
  const request = operatorProfileCreationRequest(argv);
  if (!request) return null;
  return (await creator(request.nickname, request.browserProfileDirectory)).createdProfileId;
}

export async function processOperatorProfileBrowserBinding(
  argv: readonly string[],
  setter: (id: string, browserProfileDirectory: string) => Promise<unknown>
): Promise<string | null> {
  const request = operatorProfileBrowserBindingRequest(argv);
  if (!request) return null;
  await setter(request.id, request.browserProfileDirectory);
  return request.id;
}

export async function processOperatorProfileRename(
  argv: readonly string[],
  renamer: (id: string, nickname: string) => Promise<unknown>
): Promise<string | null> {
  const request = operatorProfileRenameRequest(argv);
  if (!request) return null;
  await renamer(request.id, request.nickname);
  return request.id;
}

export class OperatorInputPreflightError extends Error {
  readonly code = 'OPERATOR_INPUT_BATCH_PREFLIGHT_FAILED';
  readonly stage = 'preflight';
  constructor(
    message: string,
    readonly inputId: string,
    readonly requested: number,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'OperatorInputPreflightError';
  }
}

export function operatorInputRequestIds(argv: readonly string[]): string[] {
  return [...new Set(argv
    .filter(argument => argument.startsWith(ARG_PREFIX))
    .map(argument => argument.slice(ARG_PREFIX.length))
    .filter(id => REQUEST_ID.test(id)))]
    .slice(0, 32);
}

export function operatorInputCancellationIds(argv: readonly string[]): string[] {
  return [...new Set(argv
    .filter(argument => argument.startsWith(CANCEL_ARG_PREFIX))
    .map(argument => argument.slice(CANCEL_ARG_PREFIX.length))
    .filter(id => REQUEST_ID.test(id)))]
    .slice(0, 32);
}

/** Unlike old enqueue/cancel compatibility parsing, a headless browser retry is strict. Electron
 * may reorder or interleave native argv, so accept one target and one caller receipt by identity,
 * independent of position. Refusing every other cardinality ensures that another retry consuming
 * the same fence cannot be mistaken for this launch's acknowledgement. */
function operatorInputRetryRequests(argv: readonly string[]): BrowserRetryRequest[] {
  const retryArguments = argv.filter(argument =>
    argument === '--cos-retry-queued-input' || argument.startsWith(RETRY_ARG_PREFIX));
  const receiptArguments = argv.filter(argument =>
    argument === '--cos-retry-queued-input-receipt' || argument.startsWith(RETRY_RECEIPT_ARG_PREFIX));
  if (retryArguments.length === 0 && receiptArguments.length === 0) return [];
  if (retryArguments.length !== 1 || receiptArguments.length !== 1) {
    throw new Error('--cos-retry-queued-input accepts exactly one UUID and one operation receipt per launch');
  }
  const retryArgument = retryArguments[0]!;
  const id = retryArgument === '--cos-retry-queued-input' ? '' : retryArgument.slice(RETRY_ARG_PREFIX.length);
  if (!REQUEST_ID.test(id)) throw new Error('--cos-retry-queued-input requires one valid UUID per launch');
  const receiptArgument = receiptArguments[0]!;
  const receipt = receiptArgument === '--cos-retry-queued-input-receipt'
    ? ''
    : receiptArgument.slice(RETRY_RECEIPT_ARG_PREFIX.length);
  if (!REQUEST_ID.test(receipt)) {
    throw new Error('--cos-retry-queued-input-receipt requires one valid UUID per launch');
  }
  return [{ id, receipt }];
}

export function operatorInputRetryIds(argv: readonly string[]): string[] {
  return operatorInputRetryRequests(argv).map(operation => operation.id);
}

export function operatorInputDirectory(userData: string): string {
  if (!path.isAbsolute(userData)) throw new Error('Operator input requires an absolute account runtime.');
  return path.join(userData, 'state', 'operator-inputs');
}

async function resolveOperatorTarget(target: OperatorInputTarget): Promise<string> {
  const { conversationWasSuperseded, findSessionByConversation, getSession, listUsageSessions } =
    await import('./session/store.js');
  let session = 'sessionId' in target
    ? await getSession(target.sessionId)
    : 'conversationId' in target
      ? await findSessionByConversation(target.conversationId, { requireUnique: true })
      : null;
  if ('title' in target) {
    const wanted = target.title.trim().toLocaleLowerCase('en-US');
    const matches = (await listUsageSessions()).filter(candidate =>
      candidate.title.trim().toLocaleLowerCase('en-US') === wanted);
    if (matches.length !== 1) {
      throw new Error(`Operator input expected one main chat titled "${target.title}"; found ${matches.length}. Use its session or conversation id instead.`);
    }
    session = matches[0]!;
  }
  if (!session) throw new Error('Operator input target was not found in this account runtime.');
  if (!session.conversationId) throw new Error('Operator input target has no current ChatGPT conversation.');
  if (session.origin?.kind === 'worker' || session.origin?.kind === 'helper') {
    throw new Error('Operator input may target only a main chat, not a worker or helper chat.');
  }
  if (await conversationWasSuperseded(session.conversationId)) {
    throw new Error('Operator input target is a superseded ChatGPT conversation. Select its current main chat.');
  }
  return session.id;
}

async function prepareOne(
  id: string,
  userData: string,
  targetResolver?: TargetResolver
): Promise<PreparedOperatorInput | null> {
  const directory = operatorInputDirectory(userData);
  const pending = path.join(directory, `${id}.json`);
  const claimed = path.join(directory, `${id}.processing`);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.lstat(path.join(directory, `${id}.admitted`));
    throw new Error('Recipe request already has an admission receipt. Inspect its original Input; never replay it after history pruning.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    await fs.rename(pending, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A crash after the rename but before durable enqueue leaves the same idempotent claim.
    try { await fs.lstat(claimed); }
    catch (claimError) {
      if ((claimError as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw claimError;
    }
  }
  try {
    const stat = await fs.lstat(claimed);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000)
      throw new Error('Operator input bundle is not a safe regular file.');
    const bundle = anyBundleSchema.parse(JSON.parse(await fs.readFile(claimed, 'utf8')));
    if (bundle.id !== id) throw new Error('Operator input id does not match its bundle.');
    const { inputArgs, operatorInputSemanticKey } = await import('./session/input.js');
    let input = inputArgs.parse(bundle.input);
    if (bundle.version === 3 && !input.workflow) throw new Error('Recipe bundle requires workflow metadata; update the app before dispatch.');
    if (bundle.version !== 3 && input.workflow) throw new Error('Recipe input requires protocol version 3.');
    if (input.id !== id || input.sessionId !== null)
      throw new Error('Operator input must enter with the same durable id and no preselected session.');
    if (bundle.version !== 1 && bundle.target) {
      const sessionId = await (targetResolver ?? resolveOperatorTarget)(bundle.target);
      input = inputArgs.parse({ ...input, sessionId });
      if (bundle.version === 3) {
        const session = await (await import('./session/store.js')).getSession(sessionId);
        if (!session?.conversationId || (await import('./goal.js')).goalArmedFor(session.conversationId))
          throw new Error('Recipe targets must be finite chats with Goal/Loop Off; use a new chat for a separate recipe task.');
      }
    }
    input = inputArgs.parse({
      ...input,
      operatorRequestKey: operatorInputSemanticKey(input),
      ...('retryOf' in bundle && bundle.retryOf?.length ? { operatorRetryOf: bundle.retryOf } : {})
    });
    return { id, pending, claimed, input };
  } catch (error) {
    // Preserve the exact authored bundle when this member cannot pass preflight.
    await fs.rename(claimed, pending).catch(() => undefined);
    throw error;
  }
}

async function restorePrepared(inputs: readonly PreparedOperatorInput[]): Promise<void> {
  for (const prepared of [...inputs].reverse()) {
    await fs.rename(prepared.claimed, prepared.pending).catch(() => undefined);
  }
}

export async function processOperatorInputRequests(
  argv: readonly string[],
  userData: string,
  sender?: Sender,
  targetResolver?: TargetResolver
): Promise<{ requested: number; accepted: number }> {
  const ids = operatorInputRequestIds(argv);
  const prepared: PreparedOperatorInput[] = [];
  for (const id of ids) {
    try {
      const input = await prepareOne(id, userData, targetResolver);
      if (!input) {
        if (ids.length === 1) return { requested: 1, accepted: 0 };
        throw new OperatorInputPreflightError(
          `Operator input batch preflight could not claim request ${id}.`, id, ids.length
        );
      }
      prepared.push(input);
    } catch (error) {
      await restorePrepared(prepared);
      if (error instanceof OperatorInputPreflightError) throw error;
      throw new OperatorInputPreflightError(
        `Operator input batch preflight failed for request ${id}: ${error instanceof Error ? error.message : String(error)}`,
        id,
        ids.length,
        error
      );
    }
  }

  const deliver = sender ?? (await import('./session/start-input.js')).sendDesktopInput;
  let accepted = 0;
  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index]!;
    try {
      await deliver(item.input);
      // Keep the exact recipe request as a replay fence even after bounded outbox history
      // is pruned. This is the same operator claim, not another queue or result authority.
      if (item.input.workflow) await fs.rename(item.claimed, path.join(path.dirname(item.claimed), `${item.id}.admitted`));
      else await fs.rm(item.claimed, { force: true });
      accepted += 1;
    } catch (error) {
      await restorePrepared(prepared.slice(index));
      throw error;
    }
  }
  return { requested: ids.length, accepted };
}

export async function processOperatorInputCancellations(
  argv: readonly string[],
  canceller?: Canceller
): Promise<{ requested: number; cancelled: number }> {
  const ids = operatorInputCancellationIds(argv);
  const cancel = canceller ?? (await import('./session/input.js')).cancelQueuedInputByOperator;
  let cancelled = 0;
  for (const id of ids) if (await cancel(id)) cancelled += 1;
  return { requested: ids.length, cancelled };
}

/**
 * Route exact stale-browser retries through the same owner used by the Retry browser UI.
 * `requireAttentionFence` makes that owner atomically consume the still-present pre-Send fence;
 * a stale CLI preflight, concurrent Retry, browser claim, or later delivery evidence is refused.
 */
export async function processOperatorInputRetries(
  argv: readonly string[],
  retrier?: BrowserRetrier
): Promise<{ requested: number; rearmed: number; refused: string[] }> {
  const requests = operatorInputRetryRequests(argv);
  const retry = retrier ?? (await import('./session/start-input.js')).retryQueuedInputBrowser;
  let rearmed = 0;
  const refused: string[] = [];
  for (const { id, receipt } of requests) {
    if (await retry(id, true, receipt)) rearmed += 1;
    else refused.push(id);
  }
  return { requested: requests.length, rearmed, refused };
}

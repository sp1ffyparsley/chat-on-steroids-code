/**
 * Parent-bound DeepAI helpers. The bridge owns native jobs and its two-slot queue;
 * this owner keeps only CoS caller custody and bounded result notifications.
 * No timers, browser Sends, input authorship, or replacement task dispatch live here.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { effectiveCapabilities, getActiveInstanceOwnerPaths, getActiveInstanceRuntime, getConfig } from './config.js';
import { durableStoreReady, readDurableStrict, writeDurableNow } from './durable.js';
import { childEnv } from './exec.js';
import { pathEntries } from './env.js';
import { ensureDevToolchain } from './toolchain.js';
import { goalSwitchFor } from './goal.js';
import { getSession } from './session/store.js';
import type { CallContext, CallCaller } from './mcp/call-context.js';
import type { OutputPublication } from './codex/unified-exec.js';

const STATE = 'deepai-helper-bindings';
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 4000;
const MAX_PENDING_PER_PARENT = 50;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked', 'incomplete']);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const samePath = (a: string, b: string): boolean => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

export class DeepAIHelperError extends Error {
  constructor(readonly code: string, message: string) { super(code + ': ' + message); this.name = 'DeepAIHelperError'; }
}
function refuse(code: string, message: string): never { throw new DeepAIHelperError(code, message); }

export interface HelperScope { key: string; token: unknown; deviceId: string; profileId: string;
  control?: { configRoot: string; durableRoot: string } }
export interface HelperParent { scope: HelperScope; sessionId: string; conversationId: string; requestId: string; owner: string }
export interface BridgeRequest {
  action: 'submit' | 'continue' | 'status' | 'result' | 'inbox' | 'ack' | 'cancel' | 'readiness';
  owner: string; job?: string; request?: Record<string, unknown>; offset?: number; limit?: number; passive?: boolean;
}
export type BridgeCall = (request: BridgeRequest) => Promise<unknown>;

const attentionSchema = z.object({
  available: z.boolean(), pendingCount: z.number().int().nonnegative(),
  fingerprint: z.string().max(200).optional(),
  reason: z.string().max(512).nullable().optional(),
  requests: z.array(z.object({
    id: z.string().max(256).nullable().optional(), requestId: z.string().max(256).nullable().optional(),
    itemId: z.string().max(256).nullable().optional(), type: z.enum(['approval', 'question', 'authentication', 'secret']),
    kind: z.string().max(160).optional(), status: z.literal('pending').optional(),
    source: z.string().max(160).optional(), title: z.string().max(500).optional(),
    reason: z.string().max(512).nullable().optional(), userOnly: z.boolean().optional(),
    questionCount: z.number().int().nonnegative().optional()
  })).max(32).optional(), truncated: z.boolean().optional(), observedAt: z.string().max(100).optional()
});
const publicJobSchema = z.object({
  id: z.string().uuid(), owner: z.string().min(1).max(200), requestKey: z.string().min(1).max(200),
  status: z.enum(['queued', 'submitting', 'active', 'waiting', 'stopping', 'completed', 'failed', 'cancelled', 'blocked', 'incomplete']),
  workspace: z.string().min(1).max(4096), model: z.string().min(1).max(200),
  threadId: z.string().max(256).optional(), messageId: z.string().max(256).optional(),
  commandId: z.string().max(256).optional(), resultSavedAt: z.string().max(100).nullable().optional(),
  runId: z.string().max(256).nullable().optional(),
  nativeStatus: z.string().max(100).nullable().optional(), waitingFor: z.string().max(100).nullable().optional(),
  createdAt: z.string().max(100).optional(), completedAt: z.string().max(100).nullable().optional(),
  cancelRequested: z.boolean().optional(), lastError: z.string().max(1000).nullable().optional(),
  resultDirectory: z.string().max(4096).optional(), resultSaved: z.boolean().optional(),
  attention: attentionSchema.nullable().optional(), attentionUnavailableReason: z.string().max(500).nullable().optional(),
  acknowledged: z.boolean().optional(), reused: z.boolean().optional(),
  blocker: z.object({ code: z.string().max(100), action: z.string().max(1000) }).nullable().optional(),
  workerStatus: z.enum(['running', 'unavailable', 'stale']).optional(), recovery: z.string().max(1000).optional(),
  assistantText: z.string().max(16000).optional(), offset: z.number().int().nonnegative().optional(),
  totalCharacters: z.number().int().nonnegative().optional(), nextOffset: z.number().int().nonnegative().nullable().optional(),
  verification: z.string().max(200).optional(), resultSaveError: z.string().max(1000).nullable().optional()
});
type PublicJob = z.infer<typeof publicJobSchema>;
const needsAttention = (job: PublicJob): boolean => (job.attention?.pendingCount ?? 0) > 0;
const needsRecovery = (job: PublicJob): boolean => (!TERMINAL.has(job.status) || job.status === 'completed' && !job.resultSaved) &&
  (job.workerStatus === 'unavailable' || job.workerStatus === 'stale' ||
    ['native_unavailable', 'parent_control_unverified', 'parent_command_disabled'].includes(job.waitingFor ?? '') || !!job.resultSaveError);
/** The bridge retains full reports; parent custody stores only their bounded metadata. */
const summary = (job: PublicJob): PublicJob => {
  const { assistantText: _text, offset: _offset, totalCharacters: _total, nextOffset: _next, ...metadata } = job;
  return metadata;
};
const rowSchema = z.object({
  key: z.string().length(64), sessionId: z.string().min(8).max(64), sourceConversationId: z.string().max(256),
  sourceRequestId: z.string().max(256), owner: z.string().max(200), requestKey: z.string().max(200),
  requestHash: z.string().length(64), workspace: z.string().max(4096), model: z.string().max(200),
  jobId: z.string().uuid().nullable(), previousJobId: z.string().uuid().optional(), createdAt: z.number(),
  latest: publicJobSchema.optional(), noticeAcknowledged: z.string().max(200).optional(),
  noticePublishedAt: z.number().optional(), acknowledgedAt: z.number().optional()
});
type Binding = z.infer<typeof rowSchema>;
const ledgerSchema = z.object({ version: z.literal(1), accountKey: z.string(), rows: z.array(rowSchema).max(MAX_ROWS) }).strict();
type Ledger = z.infer<typeof ledgerSchema>;
export interface HelperOwnerDependencies {
  scope(): HelperScope;
  currentSession(id: string): Promise<{ conversationId: string | null } | null>;
  automationAllowed(conversationId: string): boolean;
  read(): Promise<unknown>;
  write(ledger: Ledger): Promise<void>;
  bridge: BridgeCall;
  now(): number;
}
export interface HelperSubmission {
  requestKey: string; workspace?: string; prompt: string; title?: string; model?: string; maxRunMinutes?: number; job?: string;
}

/** Pure resolution seam; packaged builds never fall back to a mutable source checkout. */
export function resolveDeepAIHelperRuntime(input: {
  packaged: boolean; appPath: string; resourcesPath?: string; env: NodeJS.ProcessEnv; exists?: (file: string) => boolean
}): { script: string; node: string } {
  const exists = input.exists ?? existsSync;
  const base = input.packaged
    ? input.resourcesPath ? path.join(input.resourcesPath, 'deepai-helper') : ''
    : path.join(input.appPath, 'scripts');
  const script = base && path.join(base, 'deepai-helper.mjs');
  if (!script || !exists(script) || !exists(path.join(base, 'deepai-helper-state.mjs')) ||
      !exists(path.join(base, 'deepai-native.mjs')) || !exists(path.join(base, 'deepai-attention.mjs')))
    refuse('DEEPAI_BRIDGE_NOT_PACKAGED', 'The matching helper scripts are unavailable in this application build.');
  const filename = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = pathEntries(input.env).filter(directory => path.isAbsolute(directory))
    .map(directory => path.join(directory, filename));
  const node = candidates.find(candidate => exists(candidate));
  if (!node) refuse('DEEPAI_NODE_UNAVAILABLE', 'Install Node.js 22.13 or later and restart this app so it can discover Node on PATH.');
  return { script, node };
}

export function supportsDeepAIHelperNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(version);
  return !!match && (Number(match[1]) > 22 || Number(match[1]) === 22 && Number(match[2]) >= 13);
}

function childOutput(executable: string, args: string[], env: NodeJS.ProcessEnv, input?: string, timeout = 12_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { env, windowsHide: true, timeout, maxBuffer: 256 * 1024, encoding: 'utf8' },
      (error, stdout) => error
        ? reject(new DeepAIHelperError('DEEPAI_BRIDGE_UNAVAILABLE', 'The local helper command did not return a confirmed response. Preserve its requestKey; inspect or retry that same request before creating new work.'))
        : resolve(stdout));
    child.stdin?.on('error', () => { /* execFile owns process/timeout outcome; never log private stdin. */ });
    child.stdin?.end(input);
  });
}
let verifiedNode: { executable: string; promise: Promise<void> } | undefined;
export const runDeepAIHelperCLI: BridgeCall = async request => {
  const { app } = await import('electron');
  const env = childEnv();
  ensureDevToolchain(env);
  const runtime = resolveDeepAIHelperRuntime({
    packaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, env
  });
  if (verifiedNode?.executable !== runtime.node) {
    const promise = childOutput(runtime.node, ['--version'], env, undefined, 5000).then(version => {
      if (!supportsDeepAIHelperNode(version)) refuse('DEEPAI_NODE_UNSUPPORTED', 'Node.js 22.13 or later is required by the local helper queue.');
    });
    verifiedNode = { executable: runtime.node, promise };
    void promise.catch(() => { if (verifiedNode?.promise === promise) verifiedNode = undefined; });
  }
  await verifiedNode!.promise;
  const args = [runtime.script, request.action, '--owner', request.owner];
  if (request.job) args.push('--job', request.job);
  if (request.request) args.push('--request', '-');
  if (request.offset !== undefined) args.push('--offset', String(request.offset));
  if (request.limit !== undefined) args.push('--limit', String(request.limit));
  if (request.passive) args.push('--no-worker');
  const raw = await childOutput(runtime.node, args, env, request.request ? JSON.stringify(request.request) : undefined, request.action === 'readiness' ? 45_000 : request.passive ? 5000 : 12_000);
  try { return JSON.parse(raw) as unknown; }
  catch { return refuse('DEEPAI_BRIDGE_INVALID_RESPONSE', 'The helper returned an invalid response; the original request identity is retained.'); }
};

export function createDeepAIHelperOwner(deps: HelperOwnerDependencies) {
  let serial = Promise.resolve<unknown>(undefined);
  const offers = new Map<string, { fingerprint: string; publication: OutputPublication; scopeToken: unknown; offeredAt: number }>();
  const polledAt = new Map<string, number>();
  const locked = <T>(work: () => Promise<T>): Promise<T> => {
    const run = serial.then(work);
    serial = run.catch(() => undefined);
    return run;
  };
  const assertScope = (scope: HelperScope): void => {
    const current = deps.scope();
    if (current.key !== scope.key || current.token !== scope.token)
      refuse('DEEPAI_PARENT_CHANGED', 'The account changed during this operation. The existing helper registration is retained.');
  };
  const assertParent = async (parent: HelperParent, automation = false): Promise<void> => {
    assertScope(parent.scope);
    const session = await deps.currentSession(parent.sessionId);
    assertScope(parent.scope);
    if (!session || session.conversationId !== parent.conversationId)
      refuse('DEEPAI_PARENT_CHANGED', 'The exact parent chat is no longer current. Nothing was redirected to another chat.');
    if (automation && !deps.automationAllowed(parent.conversationId))
      refuse('DEEPAI_PARENT_PAUSED', 'The account or parent automation is paused/Off. Existing helper results remain pending.');
  };
  const load = async (scope: HelperScope): Promise<Ledger> => {
    assertScope(scope);
    const raw = await deps.read();
    assertScope(scope);
    if (raw === null) return { version: 1, accountKey: scope.key, rows: [] };
    const parsed = ledgerSchema.safeParse(raw);
    if (!parsed.success || parsed.data.accountKey !== scope.key)
      refuse('DEEPAI_BINDING_STATE_UNVERIFIED', 'Parent-helper custody could not be read safely; no new helper was dispatched.');
    return parsed.data;
  };
  const save = async (scope: HelperScope, ledger: Ledger): Promise<void> => {
    assertScope(scope);
    if (Buffer.byteLength(JSON.stringify(ledger)) > MAX_LEDGER_BYTES)
      refuse('DEEPAI_BINDING_CAPACITY', 'The retained helper registration ledger is full; preserve it before maintenance.');
    await deps.write(ledger);
    assertScope(scope);
    // Keep publication witnesses retryable until their custody is durably retained.
    for (const row of ledger.rows) {
      const offered = offers.get(row.key);
      if (offered && offered.scopeToken === scope.token && (row.acknowledgedAt !== undefined ||
          row.noticeAcknowledged === offered.fingerprint && row.noticePublishedAt === offered.publication.completedAt))
        offers.delete(row.key);
    }
  };
  const ownRow = (ledger: Ledger, parent: HelperParent, job: string): Binding => {
    const row = ledger.rows.find(row => row.jobId === job && row.sessionId === parent.sessionId && row.owner === parent.owner);
    if (!row) refuse('DEEPAI_JOB_NOT_OWNED', 'This exact parent has no registration for that helper job.');
    return row;
  };
  const checked = (raw: unknown, row: Binding): PublicJob => {
    const parsed = publicJobSchema.safeParse(raw);
    if (!parsed.success) return refuse('DEEPAI_BRIDGE_INVALID_RESPONSE', 'The helper response has an invalid bounded shape.');
    const job = parsed.data;
    if (job.owner !== row.owner || job.requestKey !== row.requestKey || row.jobId && row.jobId !== job.id ||
        !samePath(job.workspace, row.workspace) || job.model !== row.model ||
        job.resultDirectory && !samePath(job.resultDirectory, path.join(row.workspace, '.cos-deepai', 'results', job.id)))
      refuse('DEEPAI_JOB_MISMATCH', 'The helper response does not match the retained parent, workspace, model and job identity.');
    return job;
  };
  const view = (job: PublicJob, row?: Binding): Record<string, unknown> => {
    const { owner: _owner, requestKey: _requestKey, ...safe } = job;
    return { ...safe, ...(row ? { receipt: { parentSessionId: row.sessionId, parentConversationId: row.sourceConversationId,
      sourceRequestId: row.sourceRequestId, requestKeyHash: row.key, jobId: job.id, previousJobId: row.previousJobId ?? null,
      nativeThreadId: job.threadId ?? null, nativeRunId: job.runId ?? null, nativeCommandId: job.commandId ?? null, reportSavedAt: job.resultSavedAt ?? null,
      reportPath: job.resultSaved ? path.join(row.workspace, '.cos-deepai', 'results', job.id, 'report.md') : null,
      reportSaved: job.resultSaved === true, noticePublishedAt: row.noticePublishedAt ?? null,
      noticeFingerprint: row.noticeAcknowledged ?? null, acknowledgedAt: row.acknowledgedAt ?? null } } : {}),
      source: 'deepai-model-report', verification: 'independent-verification-required',
      ...(needsAttention(job) ? { attentionAction: 'Review this pending request in DeepAI Code. This integration cannot approve, reject, answer, authenticate, or supply secrets.' } : {}) };
  };
  const parent = async (caller: CallCaller): Promise<HelperParent> => {
    if (!caller.requestId || !caller.sessionId || !caller.conversationId)
      refuse('CALLER_IDENTITY_REQUIRED', 'DeepAI helpers require exact Core request, local session and browser conversation proof.');
    const scope = deps.scope();
    const value: HelperParent = { scope, sessionId: caller.sessionId, conversationId: caller.conversationId, requestId: caller.requestId,
      owner: 'cos-core:' + digest([scope.key, caller.sessionId]) };
    await assertParent(value);
    return value;
  };

  const submit = (principal: HelperParent, input: HelperSubmission): Promise<Record<string, unknown>> => locked(async () => {
    await assertParent(principal, true);
    const ledger = await load(principal.scope);
    const prior = input.job ? ownRow(ledger, principal, input.job) : undefined;
    const workspace = prior?.workspace ?? input.workspace;
    if (!workspace) refuse('DEEPAI_WORKSPACE_REQUIRED', 'An approved existing workspace is required.');
    const request = { owner: principal.owner, requestKey: 'core:' + digest([principal.owner, input.requestKey]),
      workspace, prompt: input.prompt.trim(), title: input.title ?? 'CoS DeepAI helper',
      model: prior?.model ?? input.model ?? 'deepai/glm-5.3-flash', maxRunMinutes: input.maxRunMinutes ?? 20,
      ...(principal.scope.control ? { control: { ...principal.scope.control, accountKey: principal.scope.key,
        sessionId: principal.sessionId, conversationId: principal.conversationId } } : {}) };
    const requestHash = digest([request, prior?.jobId ?? null]);
    const key = digest([principal.owner, input.requestKey]);
    let row = ledger.rows.find(item => item.key === key);
    if (row && (row.requestHash !== requestHash || row.sessionId !== principal.sessionId || row.owner !== principal.owner))
      refuse('DEEPAI_REQUEST_KEY_CONFLICT', 'That requestKey already identifies different work; keep it for retries and use a new key only for a new task.');
    if (!row) {
      if (ledger.rows.length >= MAX_ROWS || ledger.rows.filter(item => item.owner === principal.owner && !item.acknowledgedAt).length >= MAX_PENDING_PER_PARENT)
        refuse('DEEPAI_BINDING_CAPACITY', 'Acknowledge handled helper outcomes before submitting additional work for this parent.');
      row = { key, sessionId: principal.sessionId, sourceConversationId: principal.conversationId, sourceRequestId: principal.requestId,
        owner: principal.owner, requestKey: request.requestKey, requestHash, workspace, model: request.model,
        jobId: null, ...(prior?.jobId ? { previousJobId: prior.jobId } : {}), createdAt: deps.now() };
      ledger.rows.push(row);
      await save(principal.scope, ledger); // intent must survive a lost CLI response
    }
    await assertParent(principal, true);
    if (row.jobId) {
      const job = checked(await deps.bridge({ action: 'status', owner: row.owner, job: row.jobId, passive: true }), row);
      await assertParent(principal);
      row.latest = summary(job); await save(principal.scope, ledger);
      return { ...view(job, row), reused: true };
    }
    const job = checked(await deps.bridge({ action: prior ? 'continue' : 'submit', owner: principal.owner,
      ...(prior?.jobId ? { job: prior.jobId } : {}), request }), row);
    await assertParent(principal);
    row.jobId = job.id; row.latest = summary(job);
    await save(principal.scope, ledger);
    polledAt.delete(principal.owner);
    return view(job, row);
  });

  const retainPublishedNotice = (row: Binding, principal: HelperParent): boolean => {
    const offered = offers.get(row.key);
    const publishedAt = offered?.publication.completedAt;
    if (!offered || offered.scopeToken !== principal.scope.token || offered.publication.failed ||
        publishedAt === null || publishedAt === undefined || !Number.isFinite(publishedAt) || publishedAt > deps.now()) return false;
    row.noticeAcknowledged = offered.fingerprint; row.noticePublishedAt = publishedAt;
    return true;
  };

  const inspect = (principal: HelperParent, action: 'status' | 'result' | 'ack' | 'cancel' | 'recover', jobId: string,
    pagination: { offset?: number; limit?: number } = {}): Promise<Record<string, unknown>> => locked(async () => {
    await assertParent(principal);
    const ledger = await load(principal.scope);
    const row = ownRow(ledger, principal, jobId);
    // Recover uses the CLI's incumbent worker-start check. It does not replace
    // jobs, change control state, answer native requests or steal live leases.
    const job = checked(await deps.bridge({ action: action === 'recover' ? 'status' : action, owner: row.owner,
      job: jobId, ...pagination, passive: action !== 'cancel' && action !== 'recover' }), row);
    await assertParent(principal);
    row.latest = summary(job);
    retainPublishedNotice(row, principal);
    if (action === 'ack') {
      if (!TERMINAL.has(job.status)) refuse('DEEPAI_OUTCOME_NOT_TERMINAL', 'Only a terminal helper outcome can be acknowledged.');
      if (job.status === 'completed' && !job.resultSaved) refuse('DEEPAI_REPORT_NOT_SAVED', 'Save the completed report before acknowledging this outcome.');
      row.acknowledgedAt = deps.now();
    }
    await save(principal.scope, ledger);
    return { ...view(job, row), ...(action === 'recover' ? { recoveryRequested: true } : {}) };
  });

  async function refresh(principal: HelperParent, ledger: Ledger): Promise<void> {
    polledAt.set(principal.owner, deps.now()); // failed passive reads also receive bounded backoff
    const raw = await deps.bridge({ action: 'inbox', owner: principal.owner, passive: true });
    await assertParent(principal);
    const parsed = z.object({ jobs: z.array(z.unknown()).max(50) }).safeParse(raw);
    if (!parsed.success) refuse('DEEPAI_BRIDGE_INVALID_RESPONSE', 'The helper inbox has an invalid bounded shape.');
    let changed = false;
    for (const candidate of parsed.data.jobs) {
      const shape = publicJobSchema.safeParse(candidate);
      if (!shape.success) refuse('DEEPAI_BRIDGE_INVALID_RESPONSE', 'The helper inbox contains an invalid job.');
      const row = ledger.rows.find(item => item.owner === principal.owner && item.sessionId === principal.sessionId &&
        item.requestKey === shape.data.requestKey);
      if (!row) continue; // manual CLI labels do not register a Core parent
      const job = checked(candidate, row);
      row.jobId = job.id; row.latest = summary(job); changed = true;
    }
    if (changed) await save(principal.scope, ledger);
    polledAt.set(principal.owner, deps.now());
  }

  const inbox = (principal: HelperParent): Promise<Record<string, unknown>> => locked(async () => {
    await assertParent(principal);
    const ledger = await load(principal.scope);
    let publicationChanged = false;
    for (const row of ledger.rows) if (row.owner === principal.owner && retainPublishedNotice(row, principal)) publicationChanged = true;
    if (publicationChanged) await save(principal.scope, ledger);
    if (ledger.rows.some(row => row.owner === principal.owner && !row.acknowledgedAt)) await refresh(principal, ledger);
    return { source: 'deepai-model-report', jobs: ledger.rows.filter(row => row.owner === principal.owner && !row.acknowledgedAt)
      .map(row => row.latest ? view(row.latest, row) : { requestPending: true, requestKeyHash: row.key, status: 'submission-unconfirmed',
        instruction: 'Retry the original submission with the same requestKey and body; do not create replacement work.' }) };
  });

  const offer = (context: CallContext, budget: number): Promise<string | null> => locked(async () => {
    if (!context.publication || budget < 1024 || !context.caller.requestId || !context.caller.sessionId || !context.caller.conversationId) return null;
    const principal = await parent(context.caller);
    if (!deps.automationAllowed(principal.conversationId)) return null;
    const ledger = await load(principal.scope);
    const rows = ledger.rows.filter(row => row.owner === principal.owner && !row.acknowledgedAt);
    if (!rows.length) return null;
    let changed = false;
    for (const row of rows) {
      const prior = offers.get(row.key);
      if (!prior) continue;
      if (prior.scopeToken !== principal.scope.token || prior.publication.failed) { offers.delete(row.key); continue; }
      // A lost local response can remain ambiguous forever. Only the passive notice may be
      // reoffered at a later exact caller boundary; no native job or outcome ACK is replayed.
      if (prior.publication.completedAt === null && deps.now() - prior.offeredAt >= 30_000) {
        offers.delete(row.key); continue;
      }
      if (prior.publication.completedAt !== null && prior.publication.completedAt < context.startedAt) {
        row.noticeAcknowledged = prior.fingerprint; row.noticePublishedAt = prior.publication.completedAt; changed = true;
      }
    }
    if (changed) await save(principal.scope, ledger);
    if (rows.some(row => !row.latest || !TERMINAL.has(row.latest.status) || !row.latest.resultSaved) &&
        deps.now() - (polledAt.get(principal.owner) ?? -Infinity) >= 5000) await refresh(principal, ledger);
    await assertParent(principal, true);
    for (const row of rows) {
      const job = row.latest;
      if (!job || !TERMINAL.has(job.status) && !needsAttention(job) && !needsRecovery(job)) continue;
      // Completion is publishable only after the report is durably saved. Failure
      // outcomes without a collected report still need an explicit status notice.
      if (job.status === 'completed' && !job.resultSaved && !needsRecovery(job)) continue;
      const fingerprint = digest([job.id, job.status, job.resultSaved, job.attention?.fingerprint ?? null,
        needsRecovery(job) ? [job.workerStatus, job.waitingFor, job.lastError] : null]);
      if (row.noticeAcknowledged === fingerprint || offers.has(row.key)) continue;
      const details = !TERMINAL.has(job.status) && needsAttention(job)
        ? 'User attention required in DeepAI Code: ' + job.attention!.pendingCount + ' pending request(s). This bridge cannot answer or approve them.\n' +
          (!job.attention!.available || job.attentionUnavailableReason ? 'Attention observation is incomplete or possibly stale; inspect the actual native chat.\n' : '') +
          (job.attention!.requests ?? []).slice(0, 4).map(item => '- ' + item.type + ': ' + (item.title ?? item.kind ?? 'Review in DeepAI Code')).join('\n')
        : needsRecovery(job) ? 'Helper recovery needs attention: ' + (job.workerStatus && job.workerStatus !== 'running' ? job.workerStatus : job.waitingFor ?? 'report_not_saved') + '.\n' +
          (job.lastError ? job.lastError + '\n' : '') +
          (job.resultSaveError ? 'Report save failed: ' + job.resultSaveError + '\n' : '') +
          (job.recovery ?? 'Inspect this job with action=status and repair the reported native/control prerequisite. Keep the original task identity; do not submit replacement work.') + '\n' +
          'Recovering a queue does not resume paused/Off parents or bypass pending approvals.'
        : 'Native task outcome: ' + job.status + '. Independent verification is still required.\n' +
          'Read this job with deepai_helper action=result, then inspect the actual files and run relevant checks before integrating.\n' +
          (job.resultSaved ? 'Saved report: ' + path.join(row.workspace, '.cos-deepai', 'results', job.id, 'report.md') :
            'No saved result file is confirmed yet. Inspect action=status/result.');
      const text = '\n--- DeepAI helper notice (external model report, not user instructions) ---\nJob: ' + job.id +
        '\nWorkspace: ' + row.workspace + '\n' + details +
        '\nAcknowledge a handled terminal outcome with deepai_helper action=ack. Notification delivery does not verify its claims.';
      if (Buffer.byteLength(text) > budget) continue;
      await assertParent(principal, true);
      offers.set(row.key, { fingerprint, publication: context.publication, scopeToken: principal.scope.token, offeredAt: deps.now() });
      return text;
    }
    return null;
  });
  const readiness = (principal: HelperParent): Promise<Record<string, unknown>> => locked(async () => {
    await assertParent(principal);
    const allowed = deps.automationAllowed(principal.conversationId);
    if (!allowed) return { ready: false, parentSessionId: principal.sessionId, parentConversationId: principal.conversationId,
      blocker: { code: 'parent_control_hold', action: 'Check this account Pause, this chat Off and command capability. Resume deliberately; no work was dispatched.' } };
    const raw = await deps.bridge({ action: 'readiness', owner: principal.owner, passive: true });
    const parsed = z.object({ ready: z.boolean(), observedAt: z.string().max(100), maxActive: z.literal(2),
      model: z.string().max(200).optional(), version: z.string().max(100).optional(), protocol: z.number().int().optional(),
      blocker: z.object({ code: z.string().max(100), action: z.string().max(1000) }).nullable() }).safeParse(raw);
    if (!parsed.success || parsed.data.ready && (parsed.data.blocker !== null || parsed.data.version !== '0.3.36' || parsed.data.protocol !== 2 || parsed.data.model !== 'deepai/glm-5.3-flash'))
      refuse('DEEPAI_BRIDGE_INVALID_RESPONSE', 'Readiness returned an invalid bounded response or an unsupported native/model contract.');
    await assertParent(principal, true);
    return { ...parsed.data, parentSessionId: principal.sessionId, parentConversationId: principal.conversationId,
      instruction: 'This is a point-in-time native/control preflight, not loaded-browser or end-to-end acceptance. Admission rechecks controls and free-model eligibility at dispatch.' };
  });
  return { parent, submit, inspect, inbox, offer, readiness };
}

function currentScope(): HelperScope {
  const runtime = getActiveInstanceRuntime();
  const paths = getActiveInstanceOwnerPaths();
  return { key: digest([runtime.profile.deviceId, runtime.profile.id, runtime.stateRoot]), token: runtime,
    deviceId: runtime.profile.deviceId, profileId: runtime.profile.id,
    control: { configRoot: runtime.profile.state.mode === 'isolated' ? path.join(paths.stateRoot, 'runtime') : paths.stateRoot,
      durableRoot: paths.durableStoreRoot } };
}
const owner = createDeepAIHelperOwner({
  scope: currentScope, currentSession: getSession,
  automationAllowed: conversationId => {
    const own = goalSwitchFor(conversationId);
    const config = getConfig();
    return effectiveCapabilities(config).command && config.ui.automationPaused !== true && (!own.own || own.enabled);
  },
  read: async () => {
    if (!durableStoreReady()) refuse('DEEPAI_BINDING_STATE_UNAVAILABLE', 'The account durable store is not initialized.');
    return readDurableStrict(STATE, MAX_LEDGER_BYTES);
  },
  write: ledger => writeDurableNow(STATE, ledger), bridge: runDeepAIHelperCLI, now: Date.now
});
export const deepAIHelperOwner = owner;
export const offerDeepAIHelperNotice = owner.offer;

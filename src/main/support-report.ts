import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logEvent } from './logger.js';
import {
  SUPPORT_BLOCKERS, SUPPORT_PROBES, SUPPORT_REPORT_SCHEMA_VERSION,
  supportRuntimeSchema, supportConnectionSchema, supportCompanionSchema, supportAutomationSchema,
  supportLifecycleSchema, supportQueueSchema, supportActivitySchema, supportEventsSchema,
  type SupportFailure, type SupportProbe, type SupportReport
} from '../shared/support-report.js';

const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE_ROWS = 5_000;
const MAX_EVENT_ROWS = 500;
const PROBE_TIMEOUT_MS = 3_000;
type Probe = () => unknown | Promise<unknown>;
export type SupportReportProbes = Record<SupportProbe, Probe>;

class SupportProbeError extends Error {
  constructor(readonly reason: SupportFailure) { super(`Support probe unavailable (${reason})`); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SupportProbeError('invalid-data');
  return value as Record<string, unknown>;
}
function observed(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SupportProbeError('invalid-data');
  return parsed.data;
}
function failure(error: unknown): SupportFailure {
  if (error instanceof SupportProbeError) return error.reason;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'EIO' || code === 'ENOSPC' || code === 'EROFS' || code === 'EMFILE') return 'storage';
  return 'unavailable';
}

/** Read only this active owner's existing queue. Never call listInputs(), which can materialize stages. */
async function persistedQueue(): Promise<unknown> {
  const { getActiveInstanceOwnerPaths } = await import('./config.js');
  const file = path.join(getActiveInstanceOwnerPaths().durableStoreRoot, 'state', 'session-input.json');
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new SupportProbeError('invalid-data');
    if (stat.size > MAX_QUEUE_BYTES) throw new SupportProbeError('oversized');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_QUEUE_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new SupportProbeError('unavailable');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { throw new SupportProbeError('invalid-data'); }
  } finally { await handle.close(); }
}

const defaults: SupportReportProbes = {
  runtime: async () => {
    const [{ app }, { runtimeSourceIdentity }] = await Promise.all([import('electron'), import('./runtime-source.js')]);
    return {
      appVersion: app.getVersion(), packaged: app.isPackaged,
      platform: ['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'other',
      arch: ['x64', 'arm64'].includes(process.arch) ? process.arch : 'other',
      nodeVersion: process.versions.node ?? null, electronVersion: process.versions.electron ?? null,
      source: await runtimeSourceIdentity()
    };
  },
  connection: async () => (await import('./connection.js')).getStatus(),
  companion: async () => (await import('./bridge.js')).bridgeStatus(),
  automation: async () => {
    const [{ getConfig }, { profileWorkAdmission }] = await Promise.all([import('./config.js'), import('./work-admission.js')]);
    return { paused: getConfig().ui.automationPaused === true, admission: profileWorkAdmission.snapshot().mode };
  },
  // The running IPC owner supplies its existing coordinator's getStatus(), not another lifecycle owner.
  lifecycle: () => null,
  queue: persistedQueue,
  activity: async () => {
    const [calls, { pendingCommands }, { unifiedExecManager }] = await Promise.all([
      import('./mcp/call-context.js'), import('./bridge.js'), import('./codex/manager.js')
    ]);
    return { runningTools: calls.runningToolCalls(), settlingTools: calls.settlingToolCalls(), mcpRequests: calls.inFlightMcpRequests(),
      managedProcesses: unifiedExecManager.listProcesses().length, browserCommands: pendingCommands().length };
  },
  events: async () => (await import('./logger.js')).getLog()
};

function connection(value: unknown) {
  const row = object(value);
  if (!Array.isArray(row.surfaces) || row.surfaces.length > 3) throw new SupportProbeError('invalid-data');
  if (new Set(row.surfaces.map(item => object(item).id)).size !== row.surfaces.length) throw new SupportProbeError('invalid-data');
  return validate(supportConnectionSchema, {
    state: row.state, handshakeObserved: observed(row.handshakeAt), requestObserved: observed(row.lastRequestAt), toolCallObserved: observed(row.lastToolCallAt),
    surfaces: row.surfaces.map(item => { const surface = object(item); return { id: surface.id, state: surface.state, available: surface.available,
      requestObserved: observed(surface.lastRequestAt), toolCallObserved: observed(surface.lastToolCallAt) }; })
  });
}
function lifecycle(value: unknown) {
  if (value === null || value === undefined) throw new SupportProbeError('not-ready');
  const row = object(value);
  const gate = object(row.admission);
  if (!Array.isArray(row.blockers) || row.blockers.length > 500) throw new SupportProbeError('invalid-data');
  const categories = new Map<string, number>();
  for (const raw of row.blockers) {
    const item = object(raw);
    if (typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count < 0) throw new SupportProbeError('invalid-data');
    const category = typeof item.category === 'string' && (SUPPORT_BLOCKERS as readonly string[]).includes(item.category) ? item.category : 'other';
    categories.set(category, (categories.get(category) ?? 0) + item.count);
  }
  return validate(supportLifecycleSchema, { phase: row.phase, admission: gate.mode, blockers: [...categories].map(([category, count]) => ({ category, count })) });
}
function queue(value: unknown) {
  if (!Array.isArray(value)) throw new SupportProbeError('invalid-data');
  const states = { queued: 0, browser: 0, tool: 0, sent: 0, cancelled: 0, failed: 0, decision: 0, unknown: 0 };
  const recovery = { pre_send_preparation: 0, native_send_ambiguous: 0, receipt_missing: 0, provider_recovery_unknown: 0 };
  let attention = 0, ambiguous = 0;
  const inspected = Math.min(value.length, MAX_QUEUE_ROWS);
  for (const raw of value.slice(0, inspected)) {
    const row = object(raw);
    const state = typeof row.state === 'string' && Object.hasOwn(states, row.state) ? row.state as keyof typeof states : 'unknown';
    states[state]++;
    const classification = row.recoveryFailure && typeof row.recoveryFailure === 'object' ? object(row.recoveryFailure) : null;
    const transitions = Array.isArray(row.recoveryTransitions) ? row.recoveryTransitions : [];
    const lastTransition = transitions.at(-1);
    const phase = lastTransition && typeof lastTransition === 'object' ? object(lastTransition).phase : classification?.phase;
    if (typeof phase === 'string' && Object.hasOwn(recovery, phase)) recovery[phase as keyof typeof recovery]++;
    const hasMessage = typeof row.messageId === 'string' && row.messageId.trim().length > 0;
    const partialReceipt = observed(row.deliveredAt) !== hasMessage;
    const uncertain = phase === 'native_send_ambiguous' || phase === 'receipt_missing' || phase === 'provider_recovery_unknown' ||
      row.toolReceiptUncertain === true || partialReceipt ||
      (row.sendAuthorizedAt !== undefined && !observed(row.deliveredAt) && !hasMessage) ||
      (state === 'tool') || (state === 'sent' && !observed(row.deliveredAt) && !hasMessage);
    if (uncertain) ambiguous++;
    // Authorization-required is normal for an unclaimed browser offer, not an attention fence.
    if (uncertain || row.deliveryAttentionAt !== undefined || state === 'failed' || state === 'unknown') attention++;
  }
  return validate(supportQueueSchema, { basis: 'persisted', total: value.length, inspected, truncated: value.length > inspected, states, attention, ambiguous, recovery });
}
function events(value: unknown) {
  if (!Array.isArray(value)) throw new SupportProbeError('invalid-data');
  const counts = new Map<string, { warnings: number; errors: number }>();
  const known = new Set(['runtime', 'connection', 'bridge', 'input', 'goal', 'worker', 'process', 'storage', 'profile']);
  let warnings = 0, errors = 0;
  const rows = value.slice(-MAX_EVENT_ROWS);
  for (const raw of rows) {
    const row = object(raw);
    if (row.level !== 'warn' && row.level !== 'error') continue;
    const prefix = typeof row.event === 'string' ? row.event.split('.', 1)[0] : null;
    const category = prefix && known.has(prefix) ? prefix : 'other';
    const item = counts.get(category) ?? { warnings: 0, errors: 0 };
    if (row.level === 'error') { errors++; item.errors++; } else { warnings++; item.warnings++; }
    counts.set(category, item);
  }
  return validate(supportEventsSchema, { total: value.length, inspected: rows.length, truncated: value.length > rows.length,
    warnings, errors, categories: [...counts].map(([category, item]) => ({ category, ...item })) });
}

const projections: Record<SupportProbe, (value: unknown) => unknown> = {
  runtime: value => validate(supportRuntimeSchema, value), connection,
  companion: value => validate(supportCompanionSchema, value), automation: value => validate(supportAutomationSchema, value),
  lifecycle, queue, activity: value => validate(supportActivitySchema, value), events
};

/** Independent bounded probes provide a useful partial report even during one subsystem's failure. */
export async function collectSupportReport(overrides: Partial<SupportReportProbes> = {}, options: { timeoutMs?: number; now?: () => number } = {}): Promise<SupportReport> {
  const startedAt = (options.now ?? Date.now)();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000 || !Number.isSafeInteger(startedAt) || startedAt < 0)
    throw new Error('Support report requires a valid collection clock and a 1–10000ms probe deadline');
  logEvent('support.report.started', 'Collecting bounded support diagnostics');
  const sections = await Promise.all(SUPPORT_PROBES.map(async name => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(() => (overrides[name] ?? defaults[name])()).then(value => projections[name](value));
    try {
      const value = await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SupportProbeError('timeout')), timeoutMs);
      })]);
      return [name, { state: 'available' as const, value }] as const;
    } catch (error) {
      const reason = failure(error);
      logEvent('support.report.probe_unavailable', `Support report ${name} unavailable (${reason})`, 'warn');
      return [name, { state: 'unavailable' as const, reason }] as const;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }));
  const unavailable = sections.filter(([, result]) => result.state === 'unavailable').length;
  logEvent('support.report.completed', `Support report collected probes=${sections.length} unavailable=${unavailable}`);
  return { schemaVersion: SUPPORT_REPORT_SCHEMA_VERSION, collectedAt: startedAt, scope: 'active-profile',
    collection: unavailable ? 'partial' : 'complete', ...Object.fromEntries(sections) } as SupportReport;
}

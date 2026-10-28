import { z } from 'zod';

/** A diagnostic projection only. No section grants Send, Retry, Resume or completion authority. */
export const SUPPORT_REPORT_SCHEMA_VERSION = 1 as const;
export const MAX_SUPPORT_REPORT_BYTES = 32 * 1024;
export const SUPPORT_PROBES = ['runtime', 'connection', 'companion', 'automation', 'lifecycle', 'queue', 'activity', 'events'] as const;
export const SUPPORT_FAILURES = ['timeout', 'not-ready', 'permission', 'storage', 'oversized', 'invalid-data', 'unavailable'] as const;
export type SupportProbe = (typeof SUPPORT_PROBES)[number];
export type SupportFailure = (typeof SUPPORT_FAILURES)[number];

const count = z.number().int().min(0).max(1_000_000_000);
const version = z.string().max(64).regex(/^[0-9][0-9A-Za-z.+-]*$/).nullable();
const sourceId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const admission = z.enum(['open', 'draining', 'finalizing']);
const category = z.enum(['runtime', 'connection', 'bridge', 'input', 'goal', 'worker', 'process', 'storage', 'profile', 'other']);
export const SUPPORT_BLOCKERS = ['mcp-request', 'browser-helper', 'ambiguous-send', 'pending-send', 'local-process', 'active-turn',
  'continuation', 'worker', 'worker-bootstrap', 'browser-command', 'other'] as const;

export const supportRuntimeSchema = z.object({
  appVersion: version,
  packaged: z.boolean(),
  platform: z.enum(['win32', 'darwin', 'linux', 'other']),
  arch: z.enum(['x64', 'arm64', 'other']),
  nodeVersion: version,
  electronVersion: version,
  source: z.object({ commit: sourceId, tree: sourceId, dirty: z.boolean() }).nullable()
});
export const supportConnectionSchema = z.object({
  state: z.enum(['disconnected', 'disconnecting', 'starting-server', 'connecting-tunnel', 'connected', 'offline', 'auth-failed', 'tunnel-unavailable']),
  handshakeObserved: z.boolean(),
  requestObserved: z.boolean(),
  toolCallObserved: z.boolean(),
  surfaces: z.array(z.object({
    id: z.enum(['core', 'desktop', 'plugins']), state: z.enum(['off', 'starting', 'live', 'error']),
    available: z.boolean(), requestObserved: z.boolean(), toolCallObserved: z.boolean()
  })).max(3)
});
export const supportCompanionSchema = z.object({
  running: z.boolean(), paired: z.boolean(), present: z.boolean(),
  authState: z.enum(['signed-in', 'signed-out', 'unknown']), extensionVersion: version
});
export const supportAutomationSchema = z.object({ paused: z.boolean(), admission: admission });
export const supportLifecycleSchema = z.object({
  phase: z.enum(['idle', 'draining', 'drain-ready', 'draining-switch', 'switch-ready', 'draining-update', 'update-applied', 'draining-shutdown', 'shutdown-applied']),
  admission: admission,
  blockers: z.array(z.object({ category: z.enum(SUPPORT_BLOCKERS), count })).max(SUPPORT_BLOCKERS.length)
});
export const supportQueueSchema = z.object({
  basis: z.literal('persisted'), total: count, inspected: count, truncated: z.boolean(),
  states: z.object({ queued: count, browser: count, tool: count, sent: count, cancelled: count, failed: count, decision: count, unknown: count }),
  attention: count,
  /** Ambiguous custody is an attention count, never a retry recommendation. */
  ambiguous: count,
  recovery: z.object({ pre_send_preparation: count, native_send_ambiguous: count, receipt_missing: count, provider_recovery_unknown: count })
});
export const supportActivitySchema = z.object({ runningTools: count, settlingTools: count, mcpRequests: count, managedProcesses: count, browserCommands: count });
export const supportEventsSchema = z.object({
  total: count, inspected: count, truncated: z.boolean(), warnings: count, errors: count,
  categories: z.array(z.object({ category, warnings: count, errors: count })).max(10)
});

const section = <T extends z.ZodType>(value: T) => z.discriminatedUnion('state', [
  z.object({ state: z.literal('available'), value }),
  z.object({ state: z.literal('unavailable'), reason: z.enum(SUPPORT_FAILURES) })
]);

/** Whitelist serialization prevents future owner fields from silently entering an export. */
export const supportReportSchema = z.object({
  schemaVersion: z.literal(SUPPORT_REPORT_SCHEMA_VERSION),
  collectedAt: z.number().int().nonnegative(),
  scope: z.literal('active-profile'),
  collection: z.enum(['complete', 'partial']),
  runtime: section(supportRuntimeSchema), connection: section(supportConnectionSchema), companion: section(supportCompanionSchema),
  automation: section(supportAutomationSchema), lifecycle: section(supportLifecycleSchema), queue: section(supportQueueSchema),
  activity: section(supportActivitySchema), events: section(supportEventsSchema)
});
export type SupportReport = z.infer<typeof supportReportSchema>;

/** Copy/save use the same bounded, allowlisted data; free-text logs and authored contents are absent. */
export function formatSupportReport(report: SupportReport, format: 'text' | 'json' = 'text'): string {
  const parsed = supportReportSchema.safeParse(report);
  if (!parsed.success) throw new Error('Invalid support report; collect a fresh report before exporting');
  const safe = parsed.data;
  let output: string;
  if (format === 'json') output = JSON.stringify(safe, null, 2);
  else {
    const lines = [
      'Workspace support report',
      `Collected: ${new Date(safe.collectedAt).toISOString()}`,
      `Scope: ${safe.scope}; collection: ${safe.collection}`,
      'Diagnostic observations only; collection success does not certify delivery, completion or recovery.',
      'Prompt, draft, tool-result contents, native IDs, credentials and free-text log messages are excluded.'
    ];
    for (const name of SUPPORT_PROBES) {
      const result = safe[name];
      lines.push('', `${name}: ${result.state === 'unavailable' ? `unavailable (${result.reason})` : 'observed'}`);
      if (result.state === 'available') lines.push(JSON.stringify(result.value, null, 2));
    }
    output = lines.join('\n');
  }
  if (new TextEncoder().encode(output).byteLength > MAX_SUPPORT_REPORT_BYTES)
    throw new Error('Support report exceeded its export limit; collect a fresh report');
  return output;
}

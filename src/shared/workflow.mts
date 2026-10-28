import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const fileCheck = z.object({
  kind: z.literal('file'), path: z.string().min(1).max(32768),
  minBytes: z.number().int().nonnegative().default(1), sha256: sha.optional(),
  fresh: z.boolean().default(true)
}).strict();
export const workflowCheckSchema = z.discriminatedUnion('kind', [fileCheck,
  fileCheck.omit({ kind: true }).extend({
    kind: z.literal('media'), ffprobe: z.string().min(1).max(32768),
    width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
    codec: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
    minDuration: z.number().finite().nonnegative().optional(),
    maxDuration: z.number().finite().positive().optional()
  }).strict(),
  z.object({ kind: z.literal('acceptance') }).strict(),
  // Reuse real exec receipts. A log line or an agent's claim cannot pass this check.
  z.object({ kind: z.literal('command'), command: z.string().min(1).max(16000),
    cwd: z.string().min(1).max(32768) }).strict()
]);
export const workflowStepSchema = z.object({
  runId: z.string().uuid(), recipeSha256: sha, step: id,
  order: z.number().int().min(0).max(63), total: z.number().int().min(1).max(64),
  maxParallel: z.number().int().min(1).max(8),
  dependsOn: z.array(z.string().uuid()).max(63),
  checks: z.array(workflowCheckSchema).min(1).max(24)
}).strict().refine(row => new Set(row.dependsOn).size === row.dependsOn.length, 'Duplicate dependencies');
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowCheck = z.infer<typeof workflowCheckSchema>;
export const workflowReceiptSchema = z.object({
  version: z.literal(1), replyId: z.string().uuid(), checkedAt: z.number().finite().nonnegative(),
  status: z.enum(['verified', 'failed']),
  checks: z.array(z.object({ kind: z.enum(['file', 'media', 'acceptance', 'command']),
    ok: z.boolean(), detail: z.string().max(500), path: z.string().max(32768).optional(),
    sha256: sha.optional(), bytes: z.number().nonnegative().optional() }).strict()).min(1).max(24)
}).strict();
export type WorkflowReceipt = z.infer<typeof workflowReceiptSchema>;
export interface WorkflowRow {
  id: string; state: string; createdAt: number; workflow?: WorkflowStep;
  workflowReceipt?: WorkflowReceipt; deliveredAt?: number; offeredAt?: number;
  sendAuthorizedAt?: number; acceptedNativeFinal?: { replyId: string; acceptedAt: number };
}
const verified = (row: WorkflowRow) => row.workflowReceipt?.status === 'verified' &&
  row.workflowReceipt.replyId === row.acceptedNativeFinal?.replyId;

/** Pure projection of the one durable Input queue. Missing/partial batches stay held. */
export function workflowBlocker(row: WorkflowRow, rows: readonly WorkflowRow[]): string | null {
  const spec = row.workflow;
  if (!spec) return null;
  const run = rows.filter(other => other.workflow?.runId === spec.runId);
  if (run.length !== spec.total || run.some(other => other.workflow!.recipeSha256 !== spec.recipeSha256 ||
      other.workflow!.total !== spec.total || other.workflow!.maxParallel !== spec.maxParallel) ||
      new Set(run.map(other => other.workflow!.step)).size !== spec.total ||
      new Set(run.map(other => other.workflow!.order)).size !== spec.total)
    return 'Batch admission incomplete or conflicting; inspect the exact run before resuming.';
  const dependenciesReady = (item: WorkflowRow) => item.workflow!.dependsOn.every(dep =>
    run.some(other => other.id === dep && verified(other)));
  for (const dependency of spec.dependsOn) {
    const previous = run.find(other => other.id === dependency);
    if (!previous) return 'A prerequisite is missing from this account run.';
    if (!verified(previous)) return `Waiting for verified prerequisite ${previous.workflow!.step}.`;
  }
  // Claimed/sent work retains its slot until validated or terminal failure. Reservation is
  // recalculated inside Input's serialized claim, so concurrent consumers cannot oversubscribe.
  if (row.state !== 'queued') return null;
  const active = run.filter(other => other.state !== 'queued' && !['failed', 'cancelled'].includes(other.state) &&
    !verified(other) && other.workflowReceipt?.status !== 'failed').length;
  const ready = run.filter(other => other.state === 'queued' && dependenciesReady(other))
    .sort((a, b) => a.workflow!.order - b.workflow!.order);
  const position = ready.findIndex(other => other.id === row.id);
  return position >= 0 && position < Math.max(0, spec.maxParallel - active) ? null : 'Waiting for a recipe execution slot.';
}

/** Known timestamps only. A Send receipt is deliberately separate from verified completion. */
export function workflowMetrics(row: WorkflowRow, now = Date.now()) {
  const delivery = row.deliveredAt;
  const final = row.acceptedNativeFinal?.acceptedAt;
  const checked = row.workflowReceipt?.checkedAt;
  const elapsed = (end: number | undefined, start: number | undefined) =>
    end !== undefined && start !== undefined && end >= start ? end - start : null;
  return { queueMs: elapsed(delivery, row.createdAt), executionMs: elapsed(final, delivery),
    validationMs: elapsed(checked, final), totalMs: elapsed(checked, row.createdAt),
    waitingMs: checked === undefined ? elapsed(now, row.createdAt) : null };
}

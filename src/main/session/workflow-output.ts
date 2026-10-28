/** Explicit, read-only output actions. The durable Input owner remains authoritative. */
import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Root } from '../../shared/types.js';
import { workflowReceiptSchema, workflowStepSchema, type WorkflowRow } from '../../shared/workflow.mjs';
import { nativePathIdentity, resolvePath } from '../sandbox.js';

export const workflowOutputRequestSchema = z.object({ id: z.string().uuid(),
  index: z.number().int().min(0).max(23), action: z.enum(['open', 'reveal']) }).strict();
export type WorkflowOutputAction = z.infer<typeof workflowOutputRequestSchema>['action'];
export interface WorkflowOutputDependencies {
  roots: () => readonly Root[];
  listInputs: () => Promise<readonly WorkflowRow[]>;
  /** Electron shell.openPath returns an empty string on successful dispatch. */
  openPath: (real: string) => Promise<string>;
  showItemInFolder: (real: string) => void | Promise<void>;
  /** Both arguments are fixed categories/codes; never paths, shell errors or authored text. */
  log?: (category: 'workflow.output.start' | 'workflow.output.complete' | 'workflow.output.refused', code: string) => void;
}

const sourceSchema = z.object({
  id: z.string().uuid(), state: z.literal('sent'), createdAt: z.number().finite().nonnegative(),
  deliveredAt: z.number().finite().nonnegative(), sendAuthorizedAt: z.number().finite().nonnegative().optional(),
  // Mirror Input's nullable associations: a new-chat request retains sessionId:null
  // while deliveredSessionId identifies its eventual chat. Null is part of the fingerprint.
  owner: z.string().nullable().optional(), sessionId: z.string().min(8).max(64).nullable().optional(),
  deliveredSessionId: z.string().min(8).max(64).nullable().optional(), conversationId: z.string().nullable().optional(),
  messageId: z.string().min(1).max(256).optional(),
  workflow: workflowStepSchema, workflowReceipt: workflowReceiptSchema,
  acceptedNativeFinal: z.object({ replyId: z.string().uuid(), acceptedAt: z.number().finite().nonnegative() }).strict()
});

// Default application dispatch is deliberately limited to data/media and established native
// project formats. Scripts, executables, shortcuts, HTML and unknown extensions remain reveal-only.
const OPEN_EXTENSIONS = new Set(('.txt .log .md .markdown .csv .tsv .json .pdf ' +
  '.png .jpg .jpeg .webp .gif .bmp .tif .tiff .avif .heic .exr .hdr .dpx .cin ' +
  '.mp4 .mov .mkv .webm .avi .m4v .mpg .mpeg .mxf .mts .m2ts ' +
  '.wav .flac .mp3 .aac .m4a .ogg .opus .aiff .aif ' +
  '.psd .psb .ai .aep .aepx .prproj .drp .blend .c4d .max .hip .hipnc .sesx').split(/\s+/));
const sameFile = (a: Stats, b: Stats) => a.isFile() && b.isFile() &&
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
class WorkflowOutputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function refuse(code: string, message: string): never { throw new WorkflowOutputError(code, message); }

async function currentSource(id: string, deps: WorkflowOutputDependencies) {
  const rows = (await deps.listInputs()).filter(row => row.id === id);
  if (rows.length !== 1) refuse('row_missing', 'The exact recipe input is missing or conflicting. Refresh its receipt.');
  const parsed = sourceSchema.safeParse(rows[0]);
  if (!parsed.success) refuse('row_unavailable', 'This recipe input is no longer a sent step with a complete final receipt.');
  const source = parsed.data;
  if (source.workflowReceipt.status !== 'verified' || source.workflowReceipt.replyId !== source.acceptedNativeFinal.replyId ||
      source.workflowReceipt.checks.length !== source.workflow.checks.length ||
      source.workflowReceipt.checks.some((check, index) => !check.ok || check.kind !== source.workflow.checks[index]!.kind))
    refuse('receipt_unverified', 'The recipe receipt does not verify the exact current native final and original checks.');
  return source;
}

/**
 * Re-read one verified deliverable before an explicit Open/Reveal action. Reads through a held
 * descriptor with bounded memory and a 60-second streaming deadline, then rechecks approved roots,
 * path identity, metadata and the exact original queue evidence. This does not rerun a validator,
 * issue a tool call, grant completion, resume automation or change the queue/receipt.
 *
 * A successful result means the OS accepted dispatch; it is not native open/reopen evidence.
 */
export async function openVerifiedWorkflowOutput(id: unknown, index: unknown, action: unknown,
  deps: WorkflowOutputDependencies): Promise<{ action: WorkflowOutputAction; status: 'opened' | 'revealed' }> {
  const log = (category: Parameters<NonNullable<WorkflowOutputDependencies['log']>>[0], code: string) => {
    try { deps.log?.(category, code); } catch { /* Diagnostic failure cannot add shell authority. */ }
  };
  try {
    const request = workflowOutputRequestSchema.safeParse({ id, index, action });
    if (!request.success) refuse('invalid_request', 'Choose one recipe input, a valid output check, and Open or Reveal.');
    const wanted = request.data;
    log('workflow.output.start', wanted.action);
    const source = await currentSource(wanted.id, deps);
    const fingerprint = JSON.stringify(source);
    const check = source.workflow.checks[wanted.index];
    const receipt = source.workflowReceipt.checks[wanted.index];
    if (!check || !receipt || (check.kind !== 'file' && check.kind !== 'media') ||
        !receipt.path || !path.isAbsolute(check.path) || !path.isAbsolute(receipt.path) ||
        !receipt.sha256 || !Number.isSafeInteger(receipt.bytes) || receipt.bytes! < check.minBytes)
      refuse('output_unavailable', 'This check has no verified file/media path, SHA-256 and byte count.');
    if (check.sha256 && check.sha256 !== receipt.sha256)
      refuse('receipt_unverified', 'The receipt hash does not match the original required output hash. Recheck the deliverable.');
    const resolved = await resolvePath(deps.roots(), check.path);
    if (nativePathIdentity(resolved.real) !== nativePathIdentity(receipt.path))
      refuse('path_changed', 'The original output path no longer resolves to its verified file. Recheck the deliverable.');
    if (wanted.action === 'open' && (!OPEN_EXTENSIONS.has(path.extname(check.path).toLowerCase()) ||
        !OPEN_EXTENSIONS.has(path.extname(resolved.real).toLowerCase())))
      refuse('reveal_only', 'This file type can only be revealed in its folder. Choose Reveal and inspect it there.');
    const expected = await fs.stat(resolved.real);
    if (!expected.isFile()) refuse('not_file', 'The verified output is no longer a regular file.');
    const handle = await fs.open(resolved.real, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK));
    try {
      const before = await handle.stat();
      if (!sameFile(expected, before)) refuse('file_changed', 'The output changed while opening its readback. Recheck the deliverable.');
      if (before.size !== receipt.bytes) refuse('bytes_changed', 'The output byte count differs from its verified receipt. Recheck the deliverable.');
      const hash = createHash('sha256');
      let bytes = 0;
      const abort = new AbortController();
      const deadline = setTimeout(() => abort.abort(), 60_000);
      deadline.unref();
      try {
        for await (const chunk of handle.createReadStream({ autoClose: false, signal: abort.signal })) {
          bytes += chunk.length;
          hash.update(chunk);
        }
      } catch (error) {
        if (abort.signal.aborted) refuse('read_timeout', 'Output readback exceeded 60 seconds. Reveal it after checking storage availability.');
        throw error;
      } finally { clearTimeout(deadline); }
      if (bytes !== receipt.bytes || hash.digest('hex') !== receipt.sha256)
        refuse('hash_changed', 'The output contents differ from the verified receipt. Recheck the deliverable.');
      // Resolve against the CURRENT roots, not the snapshot used to issue the original receipt.
      const rebound = await resolvePath(deps.roots(), check.path);
      if (nativePathIdentity(rebound.real) !== nativePathIdentity(resolved.real) ||
          !sameFile(before, await handle.stat()) || !sameFile(before, await fs.stat(rebound.real)))
        refuse('file_changed', 'The output changed during readback. Recheck it after the writer finishes.');
      if (JSON.stringify(await currentSource(wanted.id, deps)) !== fingerprint)
        refuse('receipt_changed', 'The recipe input or receipt changed during readback. Refresh the task before opening its output.');
      // A queue read can yield to a file writer or a roots change. Reprove both before dispatch.
      const finalRoots = deps.roots().map(root => ({ ...root }));
      const final = await resolvePath(finalRoots, check.path);
      if (nativePathIdentity(final.real) !== nativePathIdentity(resolved.real) ||
          !sameFile(before, await handle.stat()) || !sameFile(before, await fs.stat(final.real)))
        refuse('file_changed', 'The output changed before dispatch. Recheck the deliverable.');
      if (JSON.stringify(await currentSource(wanted.id, deps)) !== fingerprint)
        refuse('receipt_changed', 'The recipe input or receipt changed before dispatch. Refresh its output receipt.');
      if (!sameFile(before, await handle.stat()) || !sameFile(before, await fs.stat(final.real)))
        refuse('file_changed', 'The output changed before dispatch. Recheck the deliverable.');
      if (JSON.stringify(deps.roots()) !== JSON.stringify(finalRoots))
        refuse('roots_changed', 'Approved folders changed before dispatch. Refresh the task and check its output location.');
      try {
        if (wanted.action === 'open') {
          if (await deps.openPath(final.real) !== '') throw new Error('open_failed');
        } else await deps.showItemInFolder(final.real);
      } catch { refuse('shell_failed', 'The operating system could not open or reveal this output. Check its application and file manager.'); }
    } finally { await handle.close(); }
    log('workflow.output.complete', wanted.action);
    return { action: wanted.action, status: wanted.action === 'open' ? 'opened' : 'revealed' };
  } catch (error) {
    const failure = error instanceof WorkflowOutputError ? error
      : new WorkflowOutputError('read_failed', 'Output access failed. Check file availability and the currently approved folders.');
    log('workflow.output.refused', failure.code);
    throw failure;
  }
}

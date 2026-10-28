/** Read-only deliverable checks. Input remains the only admission/delivery/receipt owner. */
import { promises as fs, constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { acceptanceCheckpoint } from '../../shared/agent-plan.js';
import type { WorkflowCheck, WorkflowReceipt } from '../../shared/workflow.mjs';
import { getConfig } from '../config.js';
import { resolvePath, nativePathIdentity } from '../sandbox.js';
import { coreBrowserEvidence, nativeFinalEvidenceWait, settledNativeTurnCandidate } from '../core-browser-evidence.js';
import { logInfo, logWarn } from '../logger.js';
import { noticeChatStopped } from '../user-notice.js';
import { readEvents, readSessionPlan, getSession } from './store.js';
import { listInputs, publishWorkflowReceipt, type InputEntry } from './input.js';

const probe = promisify(execFile);
class WorkflowCheckFailure extends Error {}
const sameFile = (a: import('node:fs').Stats, b: import('node:fs').Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** The exact native final and original result census must still be current; no timer grants success. */
export async function workflowNativeFinalCurrent(row: InputEntry): Promise<boolean> {
  const sessionId = row.sessionId ?? row.deliveredSessionId;
  if (!row.workflow || row.state !== 'sent' || !row.acceptedNativeFinal || !sessionId || !row.conversationId ||
      !row.messageId || getConfig().ui.automationPaused === true) return false;
  const candidate = settledNativeTurnCandidate(row.conversationId);
  const evidence = coreBrowserEvidence(row.conversationId);
  if (!candidate || candidate.sourceUserMessageId !== row.messageId ||
      candidate.finalMessageId !== row.acceptedNativeFinal.replyId ||
      evidence?.ordinaryFinal?.reason !== 'associated' ||
      evidence.ordinaryFinal.openCalls !== 0 || evidence.ordinaryFinal.openCodeCalls !== 0 ||
      nativeFinalEvidenceWait(evidence) !== null) return false;
  const session = await getSession(sessionId);
  return session?.conversationId === row.conversationId && !session.activeTurnId;
}

async function checkFile(check: Extract<WorkflowCheck, { kind: 'file' | 'media' }>, row: InputEntry) {
  if (!path.isAbsolute(check.path)) throw new WorkflowCheckFailure('Deliverable path must be absolute.');
  const roots = getConfig().roots;
  const resolved = await resolvePath(roots, check.path);
  const expected = await fs.stat(resolved.real);
  if (!expected.isFile()) throw new WorkflowCheckFailure('Deliverable is not a regular file.');
  const handle = await fs.open(resolved.real, fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : fsConstants.O_NONBLOCK));
  try {
    const before = await handle.stat();
    if (!sameFile(expected, before)) throw new WorkflowCheckFailure('Deliverable changed while opening its readback.');
    if (!before.isFile() || before.size < check.minBytes) throw new WorkflowCheckFailure('Deliverable is missing, empty, or below its minimum size.');
    if (check.fresh && (row.deliveredAt === undefined || before.mtimeMs < row.deliveredAt))
      throw new WorkflowCheckFailure('Deliverable predates this exact native Send.');
    const hash = createHash('sha256');
    // Bound memory regardless of video size. The held descriptor and final path/metadata
    // reproof reject replacement, partial writes and path escapes during validation.
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    const digest = hash.digest('hex');
    if (check.sha256 && check.sha256 !== digest) throw new WorkflowCheckFailure('Deliverable SHA-256 differs from the required output.');
    if (check.kind === 'media') {
      if (!path.isAbsolute(check.ffprobe)) throw new WorkflowCheckFailure('Choose an absolute ffprobe executable path.');
      const executable = await resolvePath(getConfig().roots, check.ffprobe);
      const { stdout } = await probe(executable.real, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', resolved.real],
        { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      const media = JSON.parse(stdout);
      const videos: Array<{ width?: number; height?: number; codec_name?: string; disposition?: { attached_pic?: number } }> =
        Array.isArray(media.streams) ? media.streams.filter((stream: { codec_type?: string; disposition?: { attached_pic?: number } }) =>
          stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1) : [];
      const duration = Number(media.format?.duration);
      if (!videos.some(stream => (check.width === undefined || stream.width === check.width) &&
          (check.height === undefined || stream.height === check.height) &&
          (check.codec === undefined || stream.codec_name === check.codec))) throw new WorkflowCheckFailure('No video stream matches the requested dimensions/codec.');
      if ((check.minDuration !== undefined || check.maxDuration !== undefined) && (!Number.isFinite(duration) ||
          check.minDuration !== undefined && duration < check.minDuration || check.maxDuration !== undefined && duration > check.maxDuration))
        throw new WorkflowCheckFailure('Media duration is unknown or outside the required range.');
    }
    const after = await handle.stat();
    const rebound = await resolvePath(getConfig().roots, check.path);
    if (nativePathIdentity(rebound.real) !== nativePathIdentity(resolved.real) ||
        !sameFile(before, after) || !sameFile(before, await fs.stat(rebound.real)))
      throw new WorkflowCheckFailure('Deliverable changed while it was being verified; retain the result and inspect the writer.');
    return { kind: check.kind, ok: true, detail: 'Read back and verified.', path: resolved.real, sha256: digest, bytes: before.size };
  } finally { await handle.close(); }
}

/** Runs no authored shell commands. Test/build validation consumes the original recorded process result. */
export async function verifyWorkflowChecks(row: InputEntry): Promise<WorkflowReceipt> {
  if (!row.workflow || !row.acceptedNativeFinal || row.deliveredAt === undefined) throw new WorkflowCheckFailure('Workflow has no exact final receipt.');
  const sessionId = row.sessionId ?? row.deliveredSessionId;
  if (!sessionId) throw new WorkflowCheckFailure('Workflow has no recorded session owner.');
  const checks: WorkflowReceipt['checks'] = [];
  for (const check of row.workflow.checks) {
    try {
      if (check.kind === 'file' || check.kind === 'media') { checks.push(await checkFile(check, row)); continue; }
      if (check.kind === 'acceptance') {
        const plan = await readSessionPlan(sessionId);
        const checkpoint = acceptanceCheckpoint(plan);
        if (!plan || plan.updatedAt < row.deliveredAt || plan.updatedAt > row.acceptedNativeFinal.acceptedAt ||
            !checkpoint || checkpoint.total === 0 || checkpoint.verified !== checkpoint.total || checkpoint.next)
          throw new WorkflowCheckFailure('The original acceptance checklist still has unverified requirements. Native/editor requirements need actual native evidence.');
        checks.push({ kind: check.kind, ok: true, detail: `${checkpoint.verified} original acceptance requirements verified.` });
        continue;
      }
      if (!path.isAbsolute(check.cwd)) throw new WorkflowCheckFailure('Command check cwd must be an absolute path.');
      const events = await readEvents(sessionId, { kinds: ['tool_call'], requireIntegrity: true });
      const parents = row.conversationId ? settledNativeTurnCandidate(row.conversationId)?.coreCallMessageIds : null;
      const matches = events.filter(event => {
        if (event.kind !== 'tool_call' || event.time < row.deliveredAt! || event.time > row.acceptedNativeFinal!.acceptedAt) return false;
        const call = event.call;
        if (call.tool !== 'exec_command' || call.args.truncated || call.conversationId !== row.conversationId ||
            !call.nativeCallMessageId || !parents?.includes(call.nativeCallMessageId) || !call.resultReceiptId || call.outcome !== 'ok' ||
            call.process?.exitCode !== 0 || call.process.completedAt === undefined ||
            call.process.completedAt > row.acceptedNativeFinal!.acceptedAt) return false;
        try {
          const args = JSON.parse(call.args.text);
          return args.cmd === check.command && typeof args.workdir === 'string' &&
            nativePathIdentity(args.workdir) === nativePathIdentity(check.cwd);
        } catch { return false; }
      });
      if (matches.length === 0) throw new WorkflowCheckFailure('No original returned native exec receipt proves this exact command/cwd exited 0. Run and collect the check in the task.');
      checks.push({ kind: check.kind, ok: true, detail: 'Exact original command returned with process exit 0.' });
    } catch (error) {
      // ffprobe stderr and filesystem errors can include private paths/content. Publish fixed,
      // actionable boundary errors only; full authored command output stays in session history.
      const detail = error instanceof WorkflowCheckFailure ? error.message.slice(0, 500)
        : `Cannot verify ${check.kind}: check approved paths, file availability and validator installation.`;
      checks.push({ kind: check.kind, ok: false, detail });
    }
  }
  return { version: 1, replyId: row.acceptedNativeFinal.replyId, checkedAt: Date.now(),
    status: checks.every(check => check.ok) ? 'verified' : 'failed', checks };
}

/** Called by the existing coalesced Input/session wake owner, including after restart. */
export async function reconcileWorkflowInputs(stillCurrent: () => boolean): Promise<void> {
  const rows = await listInputs();
  for (const row of rows) {
    if (!stillCurrent()) return;
    if (!row.workflow || row.workflowReceipt || !row.acceptedNativeFinal || !await workflowNativeFinalCurrent(row)) continue;
    logInfo(`workflow: validation start run=${row.workflow.runId} step=${row.workflow.step} input=${row.id} checks=${row.workflow.checks.length}`);
    const receipt = await verifyWorkflowChecks(row);
    if (!stillCurrent() || !await workflowNativeFinalCurrent(row)) continue;
    if (await publishWorkflowReceipt(row, receipt)) {
      const log = receipt.status === 'verified' ? logInfo : logWarn;
      log(`workflow: validation ${receipt.status} run=${row.workflow.runId} step=${row.workflow.step} input=${row.id}`);
      const sessionId = row.sessionId ?? row.deliveredSessionId;
      if (sessionId) noticeChatStopped(receipt.status === 'verified' ? 'Recipe step verified' : 'Recipe needs attention',
        `${row.workflow.step}: ${receipt.checks.filter(check => check.ok).length}/${receipt.checks.length} deliverable checks passed. Open the task for its receipt.`, sessionId);
    }
  }
}

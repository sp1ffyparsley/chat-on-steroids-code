import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { WorkflowRow } from '../src/shared/workflow.mjs';
import { workflowStepSchema } from '../src/shared/workflow.mjs';
import type { Root } from '../src/shared/types.js';
import type { InputEntry } from '../src/main/session/input.js';
import { openVerifiedWorkflowOutput, workflowOutputRequestSchema, type WorkflowOutputDependencies } from '../src/main/session/workflow-output.js';

let directory: string, output: string, row: WorkflowRow, roots: Root[];
let deps: WorkflowOutputDependencies & {
  openPath: Mock<WorkflowOutputDependencies['openPath']>;
  showItemInFolder: Mock<WorkflowOutputDependencies['showItemInFolder']>;
  log: Mock<NonNullable<WorkflowOutputDependencies['log']>>;
};
const content = 'Actual verified deliverable bytes.';
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-output-action-'));
  output = path.join(directory, 'result.txt');
  await fs.writeFile(output, content);
  roots = [{ name: 'outputs', path: directory }];
  const replyId = randomUUID();
  row = { id: randomUUID(), state: 'sent', createdAt: 1, deliveredAt: 2,
    acceptedNativeFinal: { replyId, acceptedAt: 3 },
    workflow: workflowStepSchema.parse({ runId: randomUUID(), recipeSha256: 'a'.repeat(64),
      step: 'deliver', order: 0, total: 1, maxParallel: 1, dependsOn: [],
      checks: [{ kind: 'file', path: output }] }),
    workflowReceipt: { version: 1, replyId, checkedAt: 4, status: 'verified', checks: [
      { kind: 'file', ok: true, detail: 'Read back and verified.', path: await fs.realpath(output),
        sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) }
    ] }
  };
  deps = { roots: () => roots, listInputs: async () => [row], openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn<WorkflowOutputDependencies['showItemInFolder']>(),
    log: vi.fn<NonNullable<WorkflowOutputDependencies['log']>>() };
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
const run = (action = 'open', index = 0) => openVerifiedWorkflowOutput(row.id, index, action, deps);
const noShell = () => { expect(deps.openPath).not.toHaveBeenCalled(); expect(deps.showItemInFolder).not.toHaveBeenCalled(); };

describe('explicit verified workflow output actions', () => {
  it.each([null, 'native-created-conversation'])('accepts a real new-chat sent row with nullable original associations: %s', async conversationId => {
    const input: InputEntry = { ...row, state: 'sent', sessionId: null, deliveredSessionId: 'session-created-by-send',
      owner: null, conversationId, text: 'Create the deliverable.', mode: 'auto', model: null,
      reasoningEffort: null, dueAt: 0 };
    deps.listInputs = async () => [input];
    expect(await run()).toEqual({ action: 'open', status: 'opened' });
    expect(deps.openPath).toHaveBeenCalledWith(await fs.realpath(output));
  });

  it.each(['open', 'reveal'] as const)('rechecks real bytes and original evidence for %s without modifying receipts', async action => {
    const original = JSON.stringify(row);
    const listInputs = vi.fn(deps.listInputs);
    deps.listInputs = listInputs;
    expect(await run(action)).toEqual({ action, status: action === 'open' ? 'opened' : 'revealed' });
    expect(action === 'open' ? deps.openPath : deps.showItemInFolder).toHaveBeenCalledWith(await fs.realpath(output));
    expect(listInputs).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(row)).toBe(original);
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain(directory);
  });

  it.each([-1, 24, 0.5, NaN])('rejects invalid check index %s before queue or shell access', async index => {
    const list = vi.fn(deps.listInputs); deps.listInputs = list;
    await expect(run('open', index)).rejects.toThrow(/valid output check/);
    expect(list).not.toHaveBeenCalled(); noShell();
  });

  it('shares a strict bounded request schema for IPC and rejects forged IDs/actions', async () => {
    expect(workflowOutputRequestSchema.safeParse({ id: row.id, index: 0, action: 'open', path: output }).success).toBe(false);
    await expect(openVerifiedWorkflowOutput('not-an-id', 0, 'open', deps)).rejects.toThrow(/valid output check/);
    await expect(run('execute')).rejects.toThrow(/Open or Reveal/); noShell();
  });

  it.each(['cancelled', 'queued', 'browser', 'failed'])('refuses an input that is currently %s', async state => {
    row.state = state;
    await expect(run()).rejects.toThrow(/no longer a sent step/); noShell();
  });

  it('rejects missing or conflicting rows rather than choosing an arbitrary match', async () => {
    deps.listInputs = async () => [];
    await expect(run()).rejects.toThrow(/missing or conflicting/);
    deps.listInputs = async () => [row, structuredClone(row)];
    await expect(run()).rejects.toThrow(/missing or conflicting/); noShell();
  });

  it.each(['failed', 'native-mismatch', 'failed-check', 'partial', 'kind-mismatch'] as const)
    ('refuses an unverified or inconsistent receipt: %s', async defect => {
      if (defect === 'failed') row.workflowReceipt!.status = 'failed';
      if (defect === 'native-mismatch') row.acceptedNativeFinal!.replyId = randomUUID();
      if (defect === 'failed-check') row.workflowReceipt!.checks[0]!.ok = false;
      if (defect === 'partial') row.workflow!.checks.push({ kind: 'acceptance' });
      if (defect === 'kind-mismatch') row.workflowReceipt!.checks[0]!.kind = 'media';
      await expect(run()).rejects.toThrow(/exact current native final/); noShell();
    });

  it.each(['sha256', 'bytes', 'path'] as const)('requires receipt %s evidence', async field => {
    delete row.workflowReceipt!.checks[0]![field];
    await expect(run()).rejects.toThrow(/verified file\/media/); noShell();
  });

  it('does not open acceptance or command checks as files', async () => {
    row.workflow!.checks[0] = { kind: 'acceptance' };
    row.workflowReceipt!.checks[0] = { kind: 'acceptance', ok: true, detail: 'Verified original acceptance.' };
    await expect(run()).rejects.toThrow(/verified file\/media/); noShell();
  });

  it('refuses a different original spec path even if both files contain matching bytes', async () => {
    const other = path.join(directory, 'other.txt'); await fs.writeFile(other, content);
    row.workflow!.checks[0] = { ...row.workflow!.checks[0]!, kind: 'file', path: other, minBytes: 1, fresh: true };
    await expect(run()).rejects.toThrow(/no longer resolves/); noShell();
  });

  it('requires the receipt to match an original explicit SHA-256 requirement', async () => {
    const check = row.workflow!.checks[0]!;
    if (check.kind === 'file') check.sha256 = 'b'.repeat(64);
    await expect(run()).rejects.toThrow(/original required output hash/); noShell();
  });

  it.each(['missing', 'directory', 'bytes', 'contents'] as const)('rejects a %s output instead of trusting the stored receipt', async failure => {
    if (failure === 'missing') await fs.unlink(output);
    if (failure === 'directory') { await fs.unlink(output); await fs.mkdir(output); }
    if (failure === 'bytes') await fs.appendFile(output, '!');
    if (failure === 'contents') await fs.writeFile(output, content.replace('Actual', 'Edited'));
    await expect(run()).rejects.toThrow(); noShell();
  });

  it.each(['cancelled', 'rechecked', 'replaced', 'file-written'] as const)('refuses a stale action when the queue read observes %s', async change => {
    let reads = 0;
    deps.listInputs = async () => {
      if (++reads === 2) {
        if (change === 'cancelled') row.state = 'cancelled';
        if (change === 'rechecked') row.workflowReceipt!.checkedAt++;
        if (change === 'replaced') row.workflow!.runId = randomUUID();
        if (change === 'file-written') await fs.writeFile(output, content.replace('Actual', 'Edited'));
      }
      return [row];
    };
    await expect(run()).rejects.toThrow(); noShell();
  });

  it('rechecks cancellation immediately before shell dispatch', async () => {
    let reads = 0;
    deps.listInputs = async () => { if (++reads === 3) row.state = 'cancelled'; return [row]; };
    await expect(run()).rejects.toThrow(/no longer a sent step/); noShell();
  });

  it('rejects a file modified during the final queue read', async () => {
    let reads = 0;
    deps.listInputs = async () => {
      if (++reads === 3) await fs.writeFile(output, content.replace('Actual', 'Edited'));
      return [row];
    };
    await expect(run()).rejects.toThrow(/changed before dispatch/); noShell();
  });

  it('refuses a pathname replacement attempt while the original descriptor is held', async () => {
    let reads = 0;
    deps.listInputs = async () => {
      if (++reads === 2) {
        const replacement = path.join(directory, 'replacement.txt');
        await fs.writeFile(replacement, content);
        await fs.rename(replacement, output);
      }
      return [row];
    };
    // Windows can reject replacement of the held file itself; that refusal must also
    // stop dispatch rather than falling back to a raw path or ignoring the failed read.
    await expect(run()).rejects.toThrow(/changed before dispatch|Output access failed/); noShell();
  });

  it('rechecks root approvals after streaming and after the final queue read', async () => {
    let reads = 0;
    deps.listInputs = async () => { if (++reads === 3) roots = []; return [row]; };
    await expect(run()).rejects.toThrow(/Approved folders changed/); noShell();
    deps.listInputs = async () => [row];
    await expect(run()).rejects.toThrow(/approved folders/); noShell();
  });

  it.each(['exe', 'cmd', 'ps1', 'sh', 'js', 'lnk', 'url', 'html', 'unknown'])('makes .%s reveal-only', async extension => {
    const renamed = path.join(directory, `result.${extension}`);
    await fs.rename(output, renamed); output = renamed;
    row.workflow!.checks[0] = { kind: 'file', path: output, minBytes: 1, fresh: true };
    row.workflowReceipt!.checks[0]!.path = await fs.realpath(output);
    await expect(run('open')).rejects.toThrow(/only be revealed/); noShell();
    expect(await run('reveal')).toEqual({ action: 'reveal', status: 'revealed' });
    expect(deps.showItemInFolder).toHaveBeenCalledWith(await fs.realpath(output));
  });

  it('refuses symlink escapes through the existing approved-folder resolver', async context => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-output-external-'));
    try {
      const outside = path.join(external, 'outside.txt'); await fs.writeFile(outside, content);
      const link = path.join(directory, 'linked.txt');
      try { await fs.symlink(outside, link, 'file'); }
      catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) context.skip(); else throw error; }
      row.workflow!.checks[0] = { kind: 'file', path: link, minBytes: 1, fresh: true };
      row.workflowReceipt!.checks[0]!.path = await fs.realpath(outside);
      await expect(run()).rejects.toThrow(/approved folders/); noShell();
    } finally { await fs.rm(external, { recursive: true, force: true }); }
  });

  it.each(['reported', 'thrown', 'reveal'] as const)('contains a %s shell failure without exposing private errors', async failure => {
    deps.openPath.mockImplementation(async () => { if (failure === 'thrown') throw new Error('SECRET_FILE_PATH'); return 'SECRET_FILE_PATH'; });
    deps.showItemInFolder.mockImplementation(() => { throw new Error('SECRET_FILE_PATH'); });
    await expect(run(failure === 'reveal' ? 'reveal' : 'open')).rejects.toThrow(/operating system could not/);
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain('SECRET');
    expect(deps.log).toHaveBeenCalledWith('workflow.output.refused', 'shell_failed');
  });

  it('does not let diagnostic failures add authority or prevent a verified explicit action', async () => {
    deps.log.mockImplementation(() => { throw new Error('private diagnostic failure'); });
    expect(await run()).toEqual({ action: 'open', status: 'opened' });
    expect(deps.openPath).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled read at the fixed streaming deadline without dispatching the shell', async () => {
    const probe = await fs.open(output);
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    await probe.close();
    const stalled = new PassThrough();
    vi.spyOn(prototype, 'createReadStream').mockImplementation(options => {
      options?.signal?.addEventListener('abort', () => { stalled.destroy(new Error('private read timeout')); });
      return stalled as unknown as ReturnType<typeof prototype.createReadStream>;
    });
    // Shorten only the production 60-second deadline; the held descriptor/path are real.
    const nativeSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
      nativeSetTimeout(callback, delay === 60_000 ? 0 : delay, ...args));
    await expect(run()).rejects.toThrow(/exceeded 60 seconds/); noShell();
    expect(deps.log).toHaveBeenCalledWith('workflow.output.refused', 'read_timeout');
  });
});

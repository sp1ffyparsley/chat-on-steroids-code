import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workflowStepSchema } from '../src/shared/workflow.mjs';
import type { InputEntry } from '../src/main/session/input.js';
const ports = vi.hoisted(() => ({ roots: [] as Array<{ name: string; path: string }>, paused: false,
  session: { conversationId: 'conversation-workflow', activeTurnId: null as string | null },
  candidate: null as null | { sourceUserMessageId: string; finalMessageId: string; coreCallMessageIds: string[] },
  evidence: { ordinaryFinal: { reason: 'associated', openCalls: 0, openCodeCalls: 0 } }, held: false,
  events: [] as unknown[], plan: null as unknown, rows: [] as InputEntry[], publish: vi.fn(), notice: vi.fn() }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ roots: ports.roots, ui: { automationPaused: ports.paused } }) }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/user-notice.js', () => ({ noticeChatStopped: ports.notice }));
vi.mock('../src/main/session/store.js', () => ({ getSession: async () => ports.session,
  readEvents: async () => ports.events, readSessionPlan: async () => ports.plan }));
vi.mock('../src/main/session/input.js', () => ({ listInputs: async () => ports.rows, publishWorkflowReceipt: ports.publish }));
vi.mock('../src/main/core-browser-evidence.js', () => ({ coreBrowserEvidence: () => ports.evidence,
  settledNativeTurnCandidate: () => ports.candidate, nativeFinalEvidenceWait: () => ports.held ? { reason: 'native_completion_unverified' } : null }));
import { verifyWorkflowChecks, workflowNativeFinalCurrent, reconcileWorkflowInputs } from '../src/main/session/workflow.js';

let directory: string, input: InputEntry;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-deliverable-'));
  ports.roots = [{ name: 'project', path: directory }]; ports.paused = false; ports.held = false;
  ports.session = { conversationId: 'conversation-workflow', activeTurnId: null };
  input = { id: randomUUID(), sessionId: 'session-workflow', conversationId: ports.session.conversationId,
    text: 'Complete the real task.', mode: 'auto', model: null, reasoningEffort: null, dueAt: 0,
    state: 'sent', owner: 'native-page', createdAt: 1, deliveredAt: Date.now() - 10000, messageId: randomUUID(),
    acceptedNativeFinal: { replyId: randomUUID(), acceptedAt: Date.now() + 10000 },
    workflow: workflowStepSchema.parse({ runId: randomUUID(), recipeSha256: 'a'.repeat(64), step: 'render', order: 0,
      total: 1, maxParallel: 1, dependsOn: [], checks: [{ kind: 'file', path: path.join(directory, 'result.txt') }] }) };
  ports.candidate = { sourceUserMessageId: input.messageId!, finalMessageId: input.acceptedNativeFinal!.replyId, coreCallMessageIds: ['original-native-parent'] };
  ports.events = []; ports.plan = null; ports.rows = [input]; ports.publish.mockReset(); ports.notice.mockReset();
  ports.publish.mockImplementation(async (_row, receipt) => { input.workflowReceipt = receipt; return true; });
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

it('reads the real output bytes and publishes hashes only after the same native final', async () => {
  await fs.writeFile(path.join(directory, 'result.txt'), 'Real deliverable bytes.');
  const receipt = await verifyWorkflowChecks(input);
  expect(receipt.status).toBe('verified');
  expect(receipt.checks[0]).toMatchObject({ bytes: 23, sha256: createHash('sha256').update('Real deliverable bytes.').digest('hex') });
  await reconcileWorkflowInputs(() => true);
  expect(ports.publish).toHaveBeenCalledTimes(1);
  expect(ports.notice).toHaveBeenCalledTimes(1);
  await reconcileWorkflowInputs(() => true);
  expect(ports.notice).toHaveBeenCalledTimes(1);
});

it('retains missing, stale, wrong-hash, denied and empty outputs as failed checks', async () => {
  expect((await verifyWorkflowChecks(input)).status).toBe('failed');
  const output = path.join(directory, 'result.txt');
  await fs.writeFile(output, 'old');
  await fs.utimes(output, 1, 1);
  expect((await verifyWorkflowChecks(input)).checks[0]!.detail).toMatch(/predates/);
  input.workflow!.checks[0] = { kind: 'file', path: output, minBytes: 1, fresh: false, sha256: 'b'.repeat(64) };
  expect((await verifyWorkflowChecks(input)).checks[0]!.detail).toMatch(/SHA-256/);
  ports.roots = [];
  expect((await verifyWorkflowChecks(input)).status).toBe('failed');
});

it('checks all outputs independently and never equates partial validation with success', async () => {
  await fs.writeFile(path.join(directory, 'result.txt'), 'one output');
  input.workflow!.checks.push({ kind: 'file', path: path.join(directory, 'missing.txt'), minBytes: 1, fresh: true });
  const receipt = await verifyWorkflowChecks(input);
  expect(receipt.checks.map(check => check.ok)).toEqual([true, false]);
  expect(receipt.status).toBe('failed');
});

it('does not publish after pause, changed source, missing original result or shutdown', async () => {
  expect(await workflowNativeFinalCurrent(input)).toBe(true);
  ports.held = true;
  await reconcileWorkflowInputs(() => true); expect(ports.publish).not.toHaveBeenCalled();
  ports.held = false; ports.paused = true;
  expect(await workflowNativeFinalCurrent(input)).toBe(false);
  ports.paused = false; ports.candidate!.finalMessageId = randomUUID();
  expect(await workflowNativeFinalCurrent(input)).toBe(false);
  ports.candidate!.finalMessageId = input.acceptedNativeFinal!.replyId;
  await reconcileWorkflowInputs(() => false); expect(ports.publish).not.toHaveBeenCalled();
});

it('consumes the exact original returned native command exit, refusing fabricated/log-only/foreign results', async () => {
  input.workflow!.checks = [{ kind: 'command', command: 'npm test', cwd: directory }];
  const call = { kind: 'tool_call', time: input.deliveredAt! + 1, call: {
    tool: 'exec_command', nativeCallMessageId: 'original-native-parent', resultReceiptId: randomUUID(),
    conversationId: input.conversationId, outcome: 'ok', args: { text: JSON.stringify({ cmd: 'npm test', workdir: directory }), truncated: false },
    process: { exitCode: 0, completedAt: input.deliveredAt! + 2 } } };
  ports.events = [call];
  expect((await verifyWorkflowChecks(input)).status).toBe('verified');
  call.call.process.exitCode = 1;
  expect((await verifyWorkflowChecks(input)).status).toBe('failed');
  call.call.process.exitCode = 0; call.call.nativeCallMessageId = 'foreign-parent';
  expect((await verifyWorkflowChecks(input)).status).toBe('failed');
  call.call.nativeCallMessageId = 'original-native-parent'; call.call.args.truncated = true;
  expect((await verifyWorkflowChecks(input)).status).toBe('failed');
});

it('does not reuse a previous task checklist or claim native/editor acceptance from file existence', async () => {
  input.workflow!.checks = [{ kind: 'acceptance' }];
  ports.plan = { updatedAt: input.deliveredAt! - 1, plan: [], checklist: [] };
  expect((await verifyWorkflowChecks(input)).status).toBe('failed');
  ports.plan = { updatedAt: input.deliveredAt! + 1, plan: [], checklist: [{
    id: 'native-edit', requirement: 'Edit in the real native application', acceptance: 'Open, edit, save, reopen and compare layers.',
    source: 'Original task', status: 'implemented', evidence: 'File exists.' }] };
  expect((await verifyWorkflowChecks(input)).status).toBe('failed');
});

it.skipIf(!process.env.COS_WORKFLOW_FFMPEG || !process.env.COS_WORKFLOW_FFPROBE)('verifies real ffprobe dimensions, codec, duration and bytes', async () => {
  const ffmpeg = process.env.COS_WORKFLOW_FFMPEG!, ffprobe = process.env.COS_WORKFLOW_FFPROBE!;
  const file = path.join(directory, 'render.mp4');
  await promisify(execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=12:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { windowsHide: true, timeout: 30000 });
  ports.roots.push({ name: 'media-tools', path: path.dirname(ffprobe) });
  input.workflow!.checks = [{ kind: 'media', path: file, minBytes: 1, fresh: true, ffprobe,
    width: 640, height: 360, codec: 'h264', minDuration: 0.8, maxDuration: 1.5 }];
  expect((await verifyWorkflowChecks(input)).status).toBe('verified');
  const media = input.workflow!.checks[0]!;
  if (media.kind !== 'media') throw new Error('Expected the media check fixture.');
  media.width = 1920;
  expect((await verifyWorkflowChecks(input)).status).toBe('failed');
});

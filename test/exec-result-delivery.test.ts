import { afterEach, expect, it } from 'vitest';
import { UnifiedExecProcessManager, applyUnifiedExecEnv, type OutputPublication } from '../src/main/codex/unified-exec.js';

const managers: UnifiedExecProcessManager[] = [];
const policy = { kind: 'tokens' as const, tokens: 10_000 };
const publication = (): OutputPublication => ({ completedAt: null, failed: false });
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.terminateAllProcesses())); });

async function child(output: string, exitCode = 7) {
  const manager = new UnifiedExecProcessManager(60_000);
  managers.push(manager);
  const id = manager.allocateProcessId();
  const initial = await manager.execCommand({
    command: [process.execPath, '-e', `setTimeout(() => { process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${exitCode}; }, 650)`],
    shellType: process.platform === 'win32' ? 'powershell' : 'bash', hookCommand: 'delivery fixture', processId: id,
    yieldTimeMs: 250, maxOutputTokens: undefined, truncationPolicy: policy, cwd: process.cwd(), displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env), tty: false
  });
  expect(initial.processId).toBe(id);
  const owned = new Set([id]);
  expect(await manager.offerCompletedOutput(owned, publication(), 100)).toBeNull();
  await expect.poll(() => manager.backgroundState(owned).exitedUnread, { timeout: 5_000 }).toHaveLength(1);
  return { manager, id, owned };
}

it('retains a failed publication, rejects concurrent receipts, and retires only after a later successful receipt', async () => {
  const { manager, owned, id } = await child('complete-result');
  expect(await manager.offerCompletedOutput(new Set([id + 1]), publication(), 100)).toBeNull();
  const failed = publication();
  const first = await manager.offerCompletedOutput(owned, failed, 100);
  expect(first).toMatchObject({ processId: id, output: 'complete-result', exitCode: 7 });
  expect(await manager.acknowledgeCompletedOutput(owned, Date.now() + 100)).toEqual([]);
  expect(await manager.offerCompletedOutput(owned, publication(), 100)).toBeNull();
  failed.failed = true;
  failed.completedAt = 100;
  expect(await manager.acknowledgeCompletedOutput(owned, 101)).toEqual([]);
  const success = publication();
  expect(await manager.offerCompletedOutput(owned, success, 100)).toEqual(first);
  success.completedAt = 200;
  expect(await manager.acknowledgeCompletedOutput(owned, 200)).toEqual([]);
  expect(await manager.acknowledgeCompletedOutput(new Set(), 201)).toEqual([]);
  expect(await manager.acknowledgeCompletedOutput(owned, 201)).toEqual([id]);
  expect(manager.backgroundState(owned).exitedUnread).toEqual([]);
});

it('reports finished unread capacity separately from live work and frees it only after collection', async () => {
  const { manager, id } = await child('finished-but-retained', 0);
  expect(manager.terminalCapacity()).toEqual({ limit: 64, retained: 1, running: 0, exitedRetained: 1, starting: 0 });
  const output = await manager.writeStdin({ processId: id, input: '', yieldTimeMs: 1,
    maxOutputTokens: undefined, truncationPolicy: policy });
  expect(output.rawOutput.toString('utf8')).toBe('finished-but-retained');
  expect(output.exitCode).toBe(0);
  expect(manager.terminalCapacity()).toEqual({ limit: 64, retained: 0, running: 0, exitedRetained: 0, starting: 0 });
});

it('rechecks revoked custody under the output lock without consuming any finished output', async () => {
  const { manager, id } = await child('retained-after-revocation', 0);
  const entry = (manager as any).processes.get(id);
  const release = await entry.process.interactionLock.lock();
  let current = true;
  const denied = manager.writeStdin({ processId: id, input: '', yieldTimeMs: 1,
    maxOutputTokens: undefined, truncationPolicy: policy, current: () => current });
  const expectation = expect(denied).rejects.toThrow('EXEC_SESSION_OWNER_CHANGED');
  current = false;
  release();
  await expectation;
  expect(manager.terminalCapacity().exitedRetained).toBe(1);
  const output = await manager.writeStdin({ processId: id, input: '', yieldTimeMs: 1,
    maxOutputTokens: undefined, truncationPolicy: policy, current: () => true });
  expect(output.rawOutput.toString('utf8')).toBe('retained-after-revocation');
});

it('pages large Unicode results without loss and gives an explicit poll only the unacknowledged suffix', async () => {
  const output = '😀ä漢字\n'.repeat(2_000);
  const { manager, owned, id } = await child(output);
  const firstResponse = publication();
  const first = (await manager.offerCompletedOutput(owned, firstResponse, 301))!;
  expect(Buffer.byteLength(first.output)).toBeLessThanOrEqual(301);
  expect(first.output).not.toContain('\ufffd');
  firstResponse.completedAt = 100;
  expect(await manager.acknowledgeCompletedOutput(owned, 101)).toEqual([]);
  const next = (await manager.offerCompletedOutput(owned, publication(), 301))!;
  expect(next.start).toBe(first.end);
  const polled = await manager.writeStdin({ processId: id, input: '', yieldTimeMs: 1, maxOutputTokens: undefined, truncationPolicy: policy });
  expect(first.output + polled.rawOutput.toString('utf8')).toBe(output);
  expect(polled.exitCode).toBe(7);
  expect(polled.processId).toBeNull();
  expect(await manager.offerCompletedOutput(owned, publication(), 100)).toBeNull();
});

it('delivers every bounded page and an empty successful result before retirement', async () => {
  for (const output of ['🙂'.repeat(2_000), '']) {
    const { manager, owned, id } = await child(output, 0);
    let received = '';
    let retired: number[] = [];
    while (!retired.length) {
      const response = publication();
      const page = (await manager.offerCompletedOutput(owned, response, 503))!;
      expect(page).not.toBeNull();
      expect(page.exitCode).toBe(0);
      expect(Buffer.byteLength(page.output)).toBeLessThanOrEqual(503);
      received += page.output;
      response.completedAt = 100;
      retired = await manager.acknowledgeCompletedOutput(owned, 101);
    }
    expect(retired).toEqual([id]);
    expect(received).toBe(output);
  }
});

it('does not let an early poll steal output from the initial command response', async () => {
  const manager = new UnifiedExecProcessManager(60_000);
  managers.push(manager);
  const id = manager.allocateProcessId();
  const starting = manager.execCommand({
    command: [process.execPath, '-e', "process.stdout.write('initial-result'); setTimeout(() => process.exit(0), 1500)"],
    shellType: process.platform === 'win32' ? 'powershell' : 'bash', hookCommand: 'initial delivery guard', processId: id,
    yieldTimeMs: 1000, maxOutputTokens: undefined, truncationPolicy: policy, cwd: process.cwd(), displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env), tty: false
  });
  await expect.poll(() => manager.listProcesses().some(entry => entry.processId === id), { timeout: 3000 }).toBe(true);
  const early = manager.writeStdin({ processId: id, input: '', yieldTimeMs: 1,
    maxOutputTokens: undefined, truncationPolicy: policy });
  const check = expect(early).rejects.toThrow('EXEC_SESSION_STARTING');
  const initial = await starting;
  await check;
  expect(initial.rawOutput.toString('utf8')).toBe('initial-result');
  if (initial.processId !== null) {
    const finished = await manager.writeStdin({ processId: id, input: '', yieldTimeMs: 5000,
      maxOutputTokens: undefined, truncationPolicy: policy });
    expect(finished.exitCode).toBe(0);
  }
});

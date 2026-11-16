import { expect, it } from 'vitest';
import { UnifiedExecProcessManager, applyUnifiedExecEnv } from '../src/main/codex/unified-exec.js';
import {
  DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS,
  MAX_UNIFIED_EXEC_PROCESSES
} from '../src/main/codex/unified-exec-constants.js';

const truncationPolicy = { kind: 'tokens' as const, tokens: 10_000 };

it('releases only an idle process that still passes the final ownership check', async () => {
  const manager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
  const processId = manager.allocateProcessId();
  const result = await manager.execCommand({
    command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    shellType: process.platform === 'win32' ? 'powershell' : 'bash',
    hookCommand: 'sleeping worker cleanup probe',
    processId,
    yieldTimeMs: 100,
    maxOutputTokens: undefined,
    truncationPolicy,
    cwd: process.cwd(),
    displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env),
    tty: false
  });
  expect(result.processId).toBe(processId);
  try {
    expect(await manager.terminateIdleProcesses(new Set([processId]), () => false)).toEqual([]);
    expect(manager.listProcesses().map(row => row.processId)).toContain(processId);
    expect(await manager.terminateIdleProcesses(new Set([processId]), () => true)).toEqual([processId]);
    expect(manager.listProcesses().map(row => row.processId)).not.toContain(processId);
  } finally {
    await manager.terminateAllProcesses();
  }
});

it('does not let a lock attempt barge ahead of an already queued waiter', async () => {
  const manager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
  const processId = manager.allocateProcessId();
  const initial = manager.execCommand({
    command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    shellType: process.platform === 'win32' ? 'powershell' : 'bash',
    hookCommand: 'mutex handoff probe',
    processId,
    yieldTimeMs: 30_000,
    maxOutputTokens: undefined,
    truncationPolicy,
    cwd: process.cwd(),
    displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env),
    tty: false
  });

  try {
    const deadline = Date.now() + 2_000;
    while (!manager.listProcesses().some((entry) => entry.processId === processId)) {
      if (Date.now() >= deadline) throw new Error('process was not stored as live');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const entry = (manager as any).processes.get(processId);
    const mutex = entry.process.interactionLock as {
      lock(): Promise<() => void>;
      tryLock(): (() => void) | null;
    };

    const releaseFirst = await mutex.lock();
    const queuedSecond = mutex.lock();
    releaseFirst();

    // No await here on purpose: this is the exact handoff gap where a queued waiter already
    // exists but its continuation has not run yet. Tokio's try_lock cannot barge ahead of it.
    const stolen = mutex.tryLock();
    stolen?.();
    expect(stolen).toBeNull();

    const releaseSecond = await queuedSecond;
    releaseSecond();
  } finally {
    await manager.terminateProcess(processId);
    await initial.catch(() => undefined);
    await manager.terminateAllProcesses();
  }
});

it('refuses new capacity without evicting a completed unread result', async () => {
  const manager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
  const unreadId = manager.allocateProcessId();
  const request = (processId: number, command: string, yieldTimeMs: number) => ({
    command: [process.execPath, '-e', command],
    shellType: process.platform === 'win32' ? ('powershell' as const) : ('bash' as const),
    hookCommand: 'capacity obligation probe',
    processId,
    yieldTimeMs,
    maxOutputTokens: undefined,
    truncationPolicy,
    cwd: process.cwd(),
    displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env),
    tty: false
  });
  const fillerIds: number[] = [];

  try {
    const started = await manager.execCommand(
      request(unreadId, "setTimeout(() => { console.log('owed-output'); process.exit(7); }, 500)", 100)
    );
    expect(started.processId).toBe(unreadId);
    // Allow real Node startup under full-suite load; output custody, not speed, is asserted.
    await expect.poll(() => manager.backgroundState(new Set([unreadId])).exitedUnread, { timeout: 10_000 }).toEqual([
      { processId: unreadId, exitCode: 7 }
    ]);

    expect(manager.terminalCapacity().activeUsed).toBe(0);
    while (fillerIds.length < MAX_UNIFIED_EXEC_PROCESSES) fillerIds.push(manager.allocateProcessId());
    expect(() => manager.allocateProcessId()).toThrow(`too many active terminal sessions (limit ${MAX_UNIFIED_EXEC_PROCESSES})`);

    expect(manager.backgroundState(new Set([unreadId])).exitedUnread).toEqual([
      { processId: unreadId, exitCode: 7 }
    ]);
    const drained = await manager.writeStdin({
      processId: unreadId,
      input: '',
      yieldTimeMs: 250,
      maxOutputTokens: undefined,
      truncationPolicy
    });
    expect(drained.rawOutput.toString('utf8')).toContain('owed-output');
    expect(drained.exitCode).toBe(7);
  } finally {
    for (const processId of fillerIds) manager.releaseProcessId(processId);
    await manager.terminateAllProcesses();
  }
});

it('bounds completed manager output after 200 concurrent short commands without consuming active capacity', async () => {
  const manager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
  const retained = new Set<number>();
  try {
    for (let batch = 0; batch < 20; batch++) {
      const ids = Array.from({ length: 10 }, () => manager.allocateProcessId());
      const results = await Promise.all(ids.map((processId) => manager.execCommand({
        command: [process.execPath, '-e', `setTimeout(() => { console.log('batch-${batch}'); process.exit(0); }, 800)`],
        shellType: process.platform === 'win32' ? 'powershell' : 'bash',
        hookCommand: `shared agent ${batch % 5} command ${batch}`,
        processId,
        yieldTimeMs: 250,
        maxOutputTokens: undefined,
        truncationPolicy,
        cwd: process.cwd(),
        displayCwd: process.cwd(),
        env: applyUnifiedExecEnv(process.env),
        tty: false
      })));
      for (let i = 0; i < results.length; i++) {
        if (results[i]?.processId !== null) retained.add(ids[i]!);
      }
      await expect.poll(() => manager.backgroundState(retained).running.length, { timeout: 15_000 }).toBe(0);
      const snap = manager.capacitySnapshot();
      expect(snap.running).toBe(0);
      expect(snap.admissionUsed).toBe(0);
      expect(snap.admissionAvailable).toBe(MAX_UNIFIED_EXEC_PROCESSES);
    }
    expect(retained.size).toBeGreaterThan(MAX_UNIFIED_EXEC_PROCESSES);
    expect(manager.backgroundState(retained).exitedUnread).toHaveLength(128);
    expect(manager.terminalCapacity().evictedCompleted).toBeGreaterThan(0);

    // Pressure expiration is bounded and observable; it never consumes a live process slot.
    const oldest = retained.values().next().value as number;
    await expect(manager.writeStdin({processId:oldest,input:'',yieldTimeMs:250,maxOutputTokens:undefined,truncationPolicy})).rejects.toThrow('Unknown process id');
  } finally {
    await manager.terminateAllProcesses();
  }
}, 120_000);

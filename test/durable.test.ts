import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  flushDurable,
  initDurableStore,
  readDurable,
  readDurableStrict,
  resetDurableForTests,
  writeDurableNow,
  writeDurableSoon,
  writeDurableSnapshotSoon
} from '../src/main/durable.js';
import { getLog } from '../src/main/logger.js';

const cleanup: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetDurableForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempStore(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-durable-'));
  cleanup.push(dir);
  initDurableStore(dir);
  return dir;
}

describe('durable state commit boundary', () => {
  it('allows only a missing strict ledger and keeps corrupt contents private', async () => {
    const dir = await tempStore();
    await fs.mkdir(path.join(dir, 'state'), { recursive: true });
    const file = path.join(dir, 'state', 'strict-ledger.json');
    const logStart = getLog().length;

    await expect(readDurableStrict('not-created')).resolves.toBeNull();
    await writeDurableNow('strict-ledger', { committed: true });
    await expect(readDurableStrict('strict-ledger')).resolves.toEqual({ committed: true });

    for (const broken of ['{"private-diagnostic":"fixture-only"', 'null']) {
      await fs.writeFile(file, broken, 'utf8');
      await expect(readDurableStrict('strict-ledger')).rejects.toThrow(/^Could not read strict-ledger state$/);
      await expect(readDurable('strict-ledger')).resolves.toBeNull();
      expect(await fs.readFile(file, 'utf8')).toBe(broken);
    }
    expect(getLog().slice(logStart).every(entry => !entry.message.includes('fixture-only'))).toBe(true);
  });

  it('rejects a strict I/O failure without exposing its diagnostic as missing authority', async () => {
    await tempStore();
    const logStart = getLog().length;
    const read = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('private fixture diagnostic'), { code: 'EACCES' })
    );
    await expect(readDurableStrict('strict-ledger')).rejects.toThrow(/^Could not read strict-ledger state$/);
    expect(getLog().slice(logStart).every(entry => !entry.message.includes('private fixture diagnostic'))).toBe(true);
    read.mockRestore();
  });

  it('does not publish or acknowledge a durable generation before its file sync completes', async () => {
    await tempStore();
    await writeDurableNow('sync-boundary', { version: 1 });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const syncing = new Promise<void>(resolve => { entered = resolve; });
    const realOpen = fs.open.bind(fs);
    let closed = false;
    const open = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args), realSync = handle.sync.bind(handle), realClose = handle.close.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementationOnce(async () => { entered(); await gate; return realSync(); });
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => { closed = true; return realClose(); });
      return handle;
    });
    const rename = vi.spyOn(fs, 'rename');
    let committed = false;
    const writing = writeDurableNow('sync-boundary', { version: 2 }).then(() => { committed = true; });
    try {
      await Promise.race([syncing, writing]);
      expect(open).toHaveBeenCalledTimes(1);
      expect(rename).not.toHaveBeenCalled();
      expect(committed).toBe(false);
      await expect(readDurableStrict('sync-boundary')).resolves.toEqual({ version: 1 });
      release(); await writing;
      expect(closed).toBe(true);
      expect(rename).toHaveBeenCalledTimes(1);
      await expect(readDurableStrict('sync-boundary')).resolves.toEqual({ version: 2 });
    } finally { release(); await writing; }
  });

  it('retains the prior durable ledger and retries the same generation after file sync fails', async () => {
    const dir = await tempStore();
    await writeDurableNow('sync-failure', { id: 'same-uuid', delivered: false });
    const realOpen = fs.open.bind(fs);
    let closed = false;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args), realClose = handle.close.bind(handle);
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('fixture sync failure'), { code: 'EIO' }));
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => { closed = true; return realClose(); });
      return handle;
    });
    const rename = vi.spyOn(fs, 'rename');
    await expect(writeDurableNow('sync-failure', { id: 'same-uuid', delivered: true })).rejects.toMatchObject({ code: 'EIO' });
    expect(closed).toBe(true);
    expect(rename).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(dir, 'state', 'sync-failure.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readDurableStrict('sync-failure')).resolves.toEqual({ id: 'same-uuid', delivered: false });
    await flushDurable();
    await expect(readDurableStrict('sync-failure')).resolves.toEqual({ id: 'same-uuid', delivered: true });
  });

  it('discards an incomplete ENOSPC temp without losing the prior ledger or pending generation', async () => {
    const dir = await tempStore();
    await writeDurableNow('space-failure', { id: 'same-uuid', delivered: false });
    const tmp = path.join(dir, 'state', 'space-failure.json.tmp');
    const realWrite = fs.writeFile.bind(fs);
    const full = Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    const write = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await realWrite(args[0], '{"partial":', 'utf8');
      throw full;
    });
    const rename = vi.spyOn(fs, 'rename');

    await expect(writeDurableNow('space-failure', { id: 'same-uuid', delivered: true })).rejects.toBe(full);
    expect(rename).not.toHaveBeenCalled();
    await expect(fs.stat(tmp)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readDurableStrict('space-failure')).resolves.toEqual({ id: 'same-uuid', delivered: false });
    await flushDurable();
    expect(write).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenCalledTimes(1);
    await expect(readDurableStrict('space-failure')).resolves.toEqual({ id: 'same-uuid', delivered: true });
  });

  it('keeps the original write failure and pending generation when incomplete-temp cleanup is locked', async () => {
    const dir = await tempStore();
    await writeDurableNow('space-locked', { id: 'same-uuid', delivered: false });
    const tmp = path.join(dir, 'state', 'space-locked.json.tmp');
    const realWrite = fs.writeFile.bind(fs), realRm = fs.rm.bind(fs);
    const full = Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await realWrite(args[0], '{"partial":', 'utf8');
      throw full;
    });
    const rm = vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
      if (args[0] === tmp) throw Object.assign(new Error('private lock diagnostic'), { code: 'EBUSY' });
      return realRm(...args);
    });
    const logStart = getLog().length;
    await expect(writeDurableNow('space-locked', { id: 'same-uuid', delivered: true })).rejects.toBe(full);
    expect(rm).toHaveBeenCalledWith(tmp, { force: true });
    await expect(readDurableStrict('space-locked')).resolves.toEqual({ id: 'same-uuid', delivered: false });
    expect(await fs.readFile(tmp, 'utf8')).toBe('{"partial":');
    const logs = getLog().slice(logStart);
    expect(logs.some(entry => entry.message.includes('incomplete space-locked state temporary file'))).toBe(true);
    expect(logs.every(entry => !entry.message.includes('private lock diagnostic'))).toBe(true);
    rm.mockRestore();
    await flushDurable();
    await expect(readDurableStrict('space-locked')).resolves.toEqual({ id: 'same-uuid', delivered: true });
    await expect(fs.stat(tmp)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('starts independent pending files during flush without duplicating an active immediate write', async () => {
    await tempStore();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return realRename(...args);
    });
    const first = writeDurableNow('first', { version: 1 });
    await blocked;
    writeDurableSoon('independent', { ready: true });
    const flushing = flushDurable();
    try {
      await vi.waitFor(async () => expect(await readDurable('independent')).toEqual({ ready: true }));
    } finally { release(); }
    await Promise.all([first, flushing]);
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('lets an independent file commit while preserving the blocked file FIFO', async () => {
    await tempStore();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return realRename(...args);
    });
    const first = writeDurableNow('first', { version: 1 });
    await blocked;
    const second = writeDurableNow('first', { version: 2 });
    try {
      await writeDurableNow('independent', { ready: true });
      await expect(readDurable('independent')).resolves.toEqual({ ready: true });
      await expect(readDurable('first')).resolves.toBeNull();
    } finally { release(); }
    await Promise.all([first, second]);
    await expect(readDurable('first')).resolves.toEqual({ version: 2 });
  });

  it('coalesces lazy allocations and retains a captured snapshot after a failed write', async () => {
    await tempStore();
    let version = 1;
    const snapshot = vi.fn(() => ({ version }));
    for (let i = 0; i < 50; i++) writeDurableSnapshotSoon('projection', snapshot);
    expect(snapshot).not.toHaveBeenCalled();
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('busy'));
    await expect(flushDurable()).rejects.toThrow('busy');
    expect(snapshot).toHaveBeenCalledTimes(1);
    version = 2;
    rename.mockRestore();
    await flushDurable();
    expect(snapshot).toHaveBeenCalledTimes(1);
    await expect(readDurable('projection')).resolves.toEqual({ version: 1 });
  });

  it('never substitutes a later lazy projection for an immediate commit generation', async () => {
    await tempStore();
    const writes: unknown[] = [];
    const realWrite = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      writes.push(JSON.parse(String(args[1])));
      return realWrite(...args);
    });
    const immediate = writeDurableNow('projection', { version: 1 });
    writeDurableSnapshotSoon('projection', () => ({ version: 2 }));
    await immediate;
    await flushDurable();
    expect(writes).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('rejects a failed immediate atomic rename and preserves the snapshot for retry', async () => {
    const dir = await tempStore();
    const busy = Object.assign(new Error('injected rename contention'), { code: 'EBUSY' });
    // Nine failed attempts exhaust the eight bounded sharing-lock retries. The higher-level
    // durable queue must still retain this exact generation for its ordinary later retry.
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(busy);

    await expect(writeDurableNow('probe', { generation: 1 })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(rename).toHaveBeenCalledTimes(9);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'state', 'probe.json.tmp'), 'utf8'))).toEqual({ generation: 1 });

    rename.mockRestore();
    await flushDurable();
    await expect(readDurable('probe')).resolves.toEqual({ generation: 1 });
  });

  it('absorbs a multi-second Windows sharing lock inside the atomic publish boundary', async () => {
    await tempStore();
    const busy = Object.assign(new Error('injected scanner lock'), { code: 'EPERM' });
    const realRename = fs.rename.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      attempts += 1;
      if (attempts <= 6) throw busy;
      return realRename(...args);
    });

    await writeDurableNow('probe', { generation: 1 });

    expect(attempts).toBe(7);
    await expect(readDurable('probe')).resolves.toEqual({ generation: 1 });
  });

  it('retries a real filesystem sharing lock while the recovery clock is frozen', async () => {
    await tempStore();
    const realDelay = (await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises')).setTimeout;
    const realRename = fs.rename.bind(fs);
    let attempts = 0;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (++attempts === 1) throw Object.assign(new Error('scanner hold'), { code: 'EPERM' });
      return realRename(...args);
    });
    vi.useFakeTimers();
    let done = false;
    const pending = writeDurableNow('frozen-clock', { generation: 1 }).then(() => { done = true; });
    try {
      await realDelay(250);
      expect(done).toBe(true);
      expect(attempts).toBe(2);
    } finally {
      await vi.advanceTimersByTimeAsync(500);
      vi.useRealTimers();
      await pending;
      rename.mockRestore();
    }
  });

  it('never lets an older in-flight generation erase a newer pending value', async () => {
    await tempStore();
    let releaseRename!: () => void;
    const renameEntered = new Promise<void>((resolve) => {
      vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
        resolve();
        await new Promise<void>((release) => {
          releaseRename = release;
        });
        return vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then((real) =>
          real.rename(args[0] as string, args[1] as string)
        );
      });
    });

    const first = writeDurableNow('probe', { generation: 1 });
    await renameEntered;
    writeDurableSoon('probe', { generation: 2 });
    releaseRename();
    await first;
    await flushDurable();

    await expect(readDurable('probe')).resolves.toEqual({ generation: 2 });
  });

  it('flushes pending state even when its debounce timer is no longer the authority', async () => {
    await tempStore();
    writeDurableSoon('probe', { generation: 3 });
    await flushDurable();
    await expect(readDurable('probe')).resolves.toEqual({ generation: 3 });
  });

  it('attempts every pending state file even when one shutdown flush fails', async () => {
    await tempStore();
    const failed = Object.assign(new Error('injected swarm rename failure'), { code: 'EBUSY' });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${path.sep}swarm.json`)) throw failed;
      return realRename(from, to);
    });

    // Keep the failing entry first: the regression is that flushDurable used to throw here
    // and never even try the unrelated continuation snapshot queued behind it.
    writeDurableSoon('swarm', { run: 1 });
    writeDurableSoon('continuations', { token: 'safe' });

    await expect(flushDurable()).rejects.toMatchObject({ code: 'EBUSY' });
    await expect(readDurable('continuations')).resolves.toEqual({ token: 'safe' });
  });
});

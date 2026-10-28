/**
 * Small durable JSON files in the app's user-data folder.
 *
 * Two things outlive a restart but are not session history: the multi-agent run's
 * state, and the queue of commands waiting for the Chrome extension. Both are tiny,
 * both are rewritten whole, and losing either one silently is the failure that matters
 * — a pending worker→prime message or a "resume in a new chat" command that evaporates
 * because the app was reopened is exactly the class of loss this app exists to prevent.
 *
 * So: write to a temp file, rename over the target (atomic on NTFS), and coalesce
 * bursts on a short timer so a chatty broker does not rewrite the file per message.
 * Tolerant reads return null on corruption so optional projections cannot block startup.
 * Authority ledgers use the strict reader instead: unreadable state must never become
 * an apparently absent ledger with fresh authority.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { replaceFileAtomically } from './atomic-file.js';
import { logWarn } from './logger.js';

const WRITE_DELAY_MS = 300;
const RETRY_MAX_MS = 5_000;

let root = '';
interface PendingWrite {
  generation: number;
  value: unknown;
  snapshot?: () => unknown;
  background?: boolean;
  work?: Promise<void>;
}

const pending = new Map<string, PendingWrite>();
const timers = new Map<string, NodeJS.Timeout>();
const retryAttempts = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();
let nextGeneration = 1;

export function initDurableStore(userDataDir: string): void {
  root = path.join(userDataDir, 'state');
}

export function durableStoreReady(): boolean {
  return root !== '';
}

function fileFor(name: string): string {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error(`Invalid durable state name: ${name}`);
  return path.join(root, `${name}.json`);
}

export async function readDurable<T>(name: string): Promise<T | null> {
  if (!root) return null;
  try {
    const raw = await fs.readFile(fileFor(name), 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') {
      logWarn(`could not read ${name} state: ${(err as Error).message}`);
    }
    return null;
  }
}

/**
 * Reads durable state without treating corruption as absence.
 *
 * Most projections can safely rebuild from an empty value, so `readDurable` deliberately returns
 * null on parse/read failures. Transaction ledgers that prevent duplicate external side effects
 * need the opposite contract: ENOENT means "not created yet", while any other read/parse failure
 * must stop recovery so lost evidence can never be mistaken for a fresh state.
 */
export async function readDurableStrict<T>(name: string, maxBytes?: number): Promise<T | null> {
  if (!root) return null;
  try {
    let raw: string;
    if (maxBytes === undefined) raw = await fs.readFile(fileFor(name), 'utf8');
    else {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid durable read limit');
      const handle = await fs.open(fileFor(name), 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) throw new Error('Durable state exceeds read limit');
        // Bound actual reads too: a writer can grow the file after stat. The extra
        // byte distinguishes a complete snapshot from a silently truncated one.
        const buffer = Buffer.alloc(Math.min(maxBytes + 1, 64 * 1024));
        const chunks: Buffer[] = [];
        let length = 0;
        while (length <= maxBytes) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - length), null);
          if (!bytesRead) break;
          length += bytesRead;
          if (length > maxBytes) throw new Error('Durable state exceeds read limit');
          chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || length !== stat.size)
          throw new Error('Durable state changed while reading');
        raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
      } finally { await handle.close(); }
    }
    const value = JSON.parse(raw) as T;
    // writeDurableNow(null) removes the file. A literal null on disk is therefore
    // corruption, not the durable receipt for an intentionally absent ledger.
    if (value === null) throw new Error('Invalid null state');
    return value;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // JSON and filesystem diagnostics can contain persisted private content or paths.
    // Authority owners need only the bounded fact that their ledger was unreadable.
    logWarn(`could not strictly read ${name} state`);
    throw new Error(`Could not read ${name} state`);
  }
}

function nextWrite(value: unknown): PendingWrite {
  return { generation: nextGeneration++, value };
}

function enqueue(name: string, write: () => Promise<void>): Promise<void> {
  const queued = (inFlight.get(name) ?? Promise.resolve()).then(write);
  // Only generations of the same file share a temp path and require serialization.
  // Cross-file transaction boundaries belong to the caller's explicit await.
  const tracked = queued.catch(() => undefined).then(() => {
    if (inFlight.get(name) === tracked) inFlight.delete(name);
  });
  inFlight.set(name, tracked);
  return queued;
}

function enqueueSlot(name: string, slot: PendingWrite): Promise<void> {
  if (slot.work) return slot.work;
  const work = enqueue(name, () => flushOne(name, slot));
  slot.work = work;
  const settled = (): void => { delete slot.work; };
  void work.then(settled, settled);
  return work;
}

function schedule(name: string, delay: number): void {
  if (timers.has(name) || !pending.has(name)) return;
  const timer = setTimeout(() => {
    timers.delete(name);
    const slot = pending.get(name);
    if (!slot) return;
    void enqueueSlot(name, slot).catch(() => scheduleRetry(name));
  }, delay);
  timer.unref?.();
  timers.set(name, timer);
}

function scheduleRetry(name: string): void {
  if (!pending.has(name) || timers.has(name)) return;
  const attempt = (retryAttempts.get(name) ?? 0) + 1;
  retryAttempts.set(name, attempt);
  const delay = Math.min(RETRY_MAX_MS, WRITE_DELAY_MS * 2 ** Math.min(attempt, 4));
  schedule(name, delay);
}

async function flushOne(name: string, slot: PendingWrite): Promise<void> {
  if (slot.background && pending.get(name) !== slot) return;
  const target = fileFor(name);
  const tmp = `${target}.tmp`;
  let incompleteTemp = false;
  try {
    // Capture once, synchronously at the write boundary. A failed disk write retries this
    // exact value; later live mutations must not silently alter its generation.
    if (slot.snapshot) {
      slot.value = slot.snapshot();
      delete slot.snapshot;
    }
    await fs.mkdir(root, { recursive: true });
    if (slot.value === null) {
      await fs.rm(target, { force: true });
    } else {
      const encoded = JSON.stringify(slot.value);
      incompleteTemp = true;
      await fs.writeFile(tmp, encoded, 'utf8');
      // Rename makes publication atomic, not durable against a machine crash.
      // The same per-file serial owner flushes this exact completed temp generation
      // before publication/ACK; a flush failure retains the previous good ledger and
      // leaves this generation pending for the existing retry owner.
      const file = await fs.open(tmp, 'r+');
      try { await file.sync(); } finally { await file.close(); }
      incompleteTemp = false;
      await replaceFileAtomically(tmp, target, `${name} state`);
    }
  } catch (err) {
    if (incompleteTemp) {
      // Only this serialized writer's incomplete temporary is disposable. Keep a fully
      // synced temp on publication failure, the previous ledger, and the pending generation.
      try { await fs.rm(tmp, { force: true }); } catch {
        logWarn(`could not discard incomplete ${name} state temporary file; pending generation retained`);
      }
    }
    logWarn(`could not save ${name} state: ${(err as Error).message}`);
    throw err;
  }

  // A newer generation may have arrived while this one was on disk. Completing the older
  // write is still useful, but it must never erase the newer pending snapshot.
  if (pending.get(name)?.generation === slot.generation) {
    pending.delete(name);
    retryAttempts.delete(name);
  }
}

/** Queues a write. Repeated calls before the timer fires collapse into one. */
export function writeDurableSoon(name: string, value: unknown): void {
  if (!root) return;
  pending.set(name, { ...nextWrite(value), background: true });
  if (timers.has(name)) return;
  schedule(name, WRITE_DELAY_MS);
}

/** Coalesces background projections before allocating a snapshot. Never use for a commit barrier. */
export function writeDurableSnapshotSoon(name: string, snapshot: () => unknown): void {
  if (!root) return;
  pending.set(name, { ...nextWrite(undefined), snapshot, background: true });
  schedule(name, WRITE_DELAY_MS);
}

/**
 * Atomically writes one named state before returning.
 *
 * Used for transaction intent immediately before another durable commit: a debounced
 * snapshot is correct for ordinary progress, but cannot close a crash window between two
 * files when recovery needs to know which side of the boundary the process reached.
 */
export async function writeDurableNow(name: string, value: unknown): Promise<void> {
  if (!root) return;
  const timer = timers.get(name);
  if (timer) {
    clearTimeout(timer);
    timers.delete(name);
  }
  const slot = nextWrite(value);
  pending.set(name, slot);
  try {
    // Flush this exact generation even if a newer debounced value arrives while it waits in
    // the serialization queue. Transactional callers need proof that *their* boundary landed,
    // not merely that some later state happened to be written instead.
    await enqueueSlot(name, slot);
  } catch (err) {
    // Keep the newest pending generation recoverable. Callers which deliberately roll a
    // failed staged transition back can supersede it by queueing their safe snapshot.
    scheduleRetry(name);
    throw err;
  }
}

/** Writes everything queued right now. Called before the app quits, and by tests. */
export async function flushDurable(): Promise<void> {
  for (const [name, timer] of timers) {
    clearTimeout(timer);
    timers.delete(name);
  }
  // A failed background write deliberately survives without a timer until retry scheduling,
  // so shutdown must look at pending state itself rather than treating `timers` as authority.
  for (;;) {
    const entries = [...pending.entries()];
    const active = [...inFlight.values()];
    if (entries.length === 0 && active.length === 0) return;
    // Start pending independent files before waiting for a busy file. Reuse an admitted
    // generation's promise so shutdown cannot write an immediate commit twice.
    const results = await Promise.allSettled([...active, ...entries.map(([name, slot]) => enqueueSlot(name, slot))]);
    // Every independent file gets its shutdown attempt, even when another fails.
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

/** Test seam: drops queued writes without touching disk. */
export function resetDurableForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
  retryAttempts.clear();
  root = '';
  nextGeneration = 1;
  inFlight.clear();
}

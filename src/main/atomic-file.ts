/**
 * Atomically publishes a completed temp file without sacrificing the previous good target.
 *
 * Windows antivirus and indexers can briefly hold either pathname after the writer has
 * closed it. Retrying only the sharing-related error codes preserves atomic replacement;
 * deleting the target first would turn a harmless short lock into a settings/state-loss
 * window. Callers still receive the original filesystem error after a tightly bounded wait.
 */

import { promises as fs } from 'node:fs';
import { setTimeout as nativeDelay } from 'node:timers/promises';
import { log } from './logger.js';

// File sharing locks are real OS time, not the logical recovery clock. Capture this before
// clock-driven tests install fake timers so a real rename retry cannot deadlock their HTTP call.
const waitForSharingLock = nativeDelay;

// Real Windows Defender/indexer holds observed in production can outlive the former 185 ms
// envelope. Keep the same atomic rename and retry only sharing violations, but cover one bounded
// scanner burst before handing the unchanged generation back to durable.ts' later retry owner.
// The total wait is 3.935 seconds, which remains inside the shutdown durable-flush budget.
const ATOMIC_REPLACE_RETRY_DELAYS_MS = [10, 25, 50, 100, 250, 500, 1_000, 2_000] as const;
const TRANSIENT_REPLACE_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function replaceFileAtomically(tempPath: string, targetPath: string, label: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tempPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delayMs = ATOMIC_REPLACE_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !code || !TRANSIENT_REPLACE_ERRORS.has(code)) throw error;
      log('warn', `${label} atomic publish was temporarily blocked (${code}); retry ${attempt + 1}/${ATOMIC_REPLACE_RETRY_DELAYS_MS.length} in ${delayMs}ms`);
      await waitForSharingLock(delayMs);
    }
  }
}

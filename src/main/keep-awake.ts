import type { SessionSummary } from '../shared/session.js';
import { sessionWorkingAt } from '../shared/session-activity.js';
import { logInfo, logWarn } from './logger.js';

const REFRESH_MS = 60_000;
const READ_DEADLINE_MS = 10_000;

/** Reuse the existing working verdict; Loop enabled, connectivity and stale spinners are not work. */
export function keepAwakeState(sessions: readonly SessionSummary[], now: number): { awake: boolean; nextAt: number | null } {
  let nextAt: number | null = null;
  for (const session of sessions) {
    if (!sessionWorkingAt(session, now)) continue;
    const expiry = session.activityExpiresAt;
    const until = typeof expiry === 'number' && Number.isFinite(expiry) ? expiry : now + REFRESH_MS;
    nextAt = nextAt === null ? until : Math.min(nextAt, until);
  }
  return { awake: nextAt !== null, nextAt };
}

export interface SleepBlocker { start(): number; stop(id: number): void }

/** One process-local OS hold. Never persist the numeric id or change a system power plan. */
export function createKeepAwake(options: {
  sessions: () => Promise<readonly SessionSummary[]>;
  enabled: () => boolean;
  blocker: SleepBlocker;
}) {
  let hold: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let readTimer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let disposed = false;
  const clearDeadline = () => { if (timer) clearTimeout(timer); timer = null; };
  const release = (reason: string) => {
    if (hold === null) return;
    try {
      options.blocker.stop(hold);
      hold = null;
      logInfo(`keep awake: released system sleep hold (${reason}); screen sleep remains allowed`);
    } catch {
      // Retain the exact id for a later release attempt; never replace it with a second hold.
      logWarn('keep awake: could not release the OS sleep hold; check Electron power-blocker logs');
    }
  };
  const once = async (): Promise<void> => {
    if (!options.enabled()) { clearDeadline(); release('setting Off'); return; }
    let expired = false;
    readTimer = setTimeout(() => {
      readTimer = null;
      expired = true;
      clearDeadline(); release('activity read deadline');
      // A read with no cancellation owner stays single-flight until it settles; fail closed,
      // rather than piling up replacement catalog reads or keeping the computer awake forever.
      logWarn('keep awake: activity read deadline reached; no sleep hold was renewed. Check session catalog/recorder logs');
    }, READ_DEADLINE_MS);
    readTimer.unref?.();
    try {
      const sessions = await options.sessions();
      if (disposed || expired) return;
      if (!options.enabled()) { clearDeadline(); release('setting Off'); return; }
      const { awake, nextAt } = keepAwakeState(sessions, Date.now());
      clearDeadline();
      if (!awake || nextAt === null) { release('no current working chat'); return; }
      if (hold === null) {
        hold = options.blocker.start();
        logInfo('keep awake: acquired system sleep hold for current chat activity; screen sleep remains allowed');
      }
      // A new read must renew the lease. An outstanding/hung read cannot extend an old hold.
      const deadline = Math.min(nextAt, Date.now() + REFRESH_MS);
      timer = setTimeout(() => {
        timer = null;
        release('activity deadline');
        void refresh();
      }, Math.max(1_000, deadline - Date.now() + 100));
      timer.unref?.();
    } catch {
      if (disposed) return;
      clearDeadline(); release('activity read failure');
      logWarn('keep awake: session activity read failed; no sleep hold was renewed. Check session catalog/recorder or Electron power-blocker logs');
    } finally {
      if (readTimer) clearTimeout(readTimer);
      readTimer = null;
    }
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    // Settings publication must release immediately, even when the current read is pending.
    if (!options.enabled()) {
      clearDeadline(); release('setting Off');
      if (!running) return Promise.resolve();
    }
    if (running) { again = true; return running; }
    running = once().finally(() => {
      running = null;
      if (again && !disposed) { again = false; void refresh(); }
    });
    return running;
  };
  const periodic = setInterval(() => { void refresh(); }, REFRESH_MS);
  periodic.unref?.();
  logInfo(`keep awake: process-local controller started (setting ${options.enabled() ? 'On' : 'Off'})`);
  return {
    refresh,
    dispose(): void {
      disposed = true;
      again = false;
      clearInterval(periodic);
      clearDeadline();
      if (readTimer) clearTimeout(readTimer);
      readTimer = null;
      release('shutdown');
    }
  };
}

let installed: ReturnType<typeof createKeepAwake> | null = null;
export function installKeepAwake(instance: ReturnType<typeof createKeepAwake>): () => void {
  if (installed && installed !== instance) installed.dispose();
  installed = instance;
  return () => {
    instance.dispose();
    if (installed === instance) installed = null;
  };
}
/** Invoked synchronously at ordered settings publication; no independent settings authority. */
export function refreshKeepAwake(): void { void installed?.refresh(); }

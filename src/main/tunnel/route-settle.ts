/**
 * A new tunnel-client briefly takes over existing chats' routes (upstream #1250 / #1220).
 * Calls sent immediately can reach the previous process and wait for its lease, about 128 s.
 * Upstream's Windows measurements found the transition complete after 9–10 s, so known-unsent
 * messages for existing chats wait 12 s after each new process first connects. Fresh chats and
 * already-claimed delivery custody are unchanged. This is a wake hint, never a Send receipt.
 */
import { wakeBrowserWork } from '../browser-wake.js';
import { logInfo } from '../logger.js';

export const ROUTE_SETTLE_MS = 12_000;

let settledAt = 0;
let timer: NodeJS.Timeout | null = null;

/** A new tunnel-client process connected for the first time. */
export function noteTunnelClientConnected(now = Date.now()): void {
  const until = now + ROUTE_SETTLE_MS;
  if (until <= settledAt) return;
  settledAt = until;
  if (timer) clearTimeout(timer);
  logInfo(`tunnel: existing-chat route takeover holds queued delivery for ${ROUTE_SETTLE_MS} ms`);
  timer = setTimeout(() => {
    timer = null;
    logInfo('tunnel: existing-chat route takeover hold ended; queued delivery may be claimed');
    wakeBrowserWork();
  }, ROUTE_SETTLE_MS);
  timer.unref?.();
}

export function tunnelRouteSettling(now = Date.now()): boolean {
  return now < settledAt;
}

/** Exact end of the current hold for connection/input presentation, not delivery proof. */
export function tunnelRouteSettlingUntil(now = Date.now()): number | null {
  return now < settledAt ? settledAt : null;
}

export function resetRouteSettleForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  settledAt = 0;
}

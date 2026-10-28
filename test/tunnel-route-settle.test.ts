import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wake = vi.hoisted(() => vi.fn());
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: wake }));

const { ROUTE_SETTLE_MS, noteTunnelClientConnected, resetRouteSettleForTests, tunnelRouteSettling, tunnelRouteSettlingUntil } =
  await import('../src/main/tunnel/route-settle.js');

beforeEach(() => { vi.useFakeTimers(); wake.mockClear(); resetRouteSettleForTests(); });
afterEach(() => { resetRouteSettleForTests(); vi.useRealTimers(); });

describe('new tunnel-client route takeover (#1250)', () => {
  it('ends the bounded hold and wakes existing queued work once, without claiming delivery', async () => {
    expect(tunnelRouteSettling()).toBe(false);
    expect(tunnelRouteSettlingUntil()).toBeNull();
    noteTunnelClientConnected();
    expect(tunnelRouteSettlingUntil()).toBe(Date.now() + ROUTE_SETTLE_MS);
    await vi.advanceTimersByTimeAsync(ROUTE_SETTLE_MS - 1);
    expect(tunnelRouteSettling()).toBe(true);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tunnelRouteSettling()).toBe(false);
    expect(tunnelRouteSettlingUntil()).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('uses the later first connection when independent connector clients start at different times', async () => {
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(5_000);
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(ROUTE_SETTLE_MS - 1);
    expect(tunnelRouteSettling()).toBe(true);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tunnelRouteSettling()).toBe(false);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('does not shorten a current hold with an older connection observation', async () => {
    noteTunnelClientConnected();
    const original = tunnelRouteSettlingUntil();
    noteTunnelClientConnected(Date.now() - 5_000);
    expect(tunnelRouteSettlingUntil()).toBe(original);
    await vi.advanceTimersByTimeAsync(ROUTE_SETTLE_MS);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

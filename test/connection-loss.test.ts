import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_LOSS_GRACE_MS,
  connectionLossReporterForTests,
  setConnectionLossNotifier
} from '../src/main/connection.js';

describe('unexpected connection loss notice budget', () => {
  const notices: string[] = [];
  beforeEach(() => {
    notices.length = 0;
    vi.useFakeTimers();
    setConnectionLossNotifier(surface => { notices.push(surface); });
  });
  afterEach(() => {
    setConnectionLossNotifier(null);
    vi.useRealTimers();
  });

  it('notices one sustained outage only after a connection was proven live', () => {
    const reporter = connectionLossReporterForTests('core');
    reporter.report('offline');
    vi.advanceTimersByTime(CONNECTION_LOSS_GRACE_MS + 1);
    expect(notices).toEqual([]);
    reporter.report('connected');
    reporter.report('offline');
    vi.advanceTimersByTime(CONNECTION_LOSS_GRACE_MS - 1);
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(notices).toEqual(['core']);
    reporter.report('offline');
    vi.advanceTimersByTime(CONNECTION_LOSS_GRACE_MS + 1);
    expect(notices).toEqual(['core']);
    reporter.retire();
  });

  it('cancels a transient outage and a retired lifetime never notices', () => {
    const reporter = connectionLossReporterForTests('desktop');
    reporter.report('connected');
    reporter.report('offline');
    vi.advanceTimersByTime(CONNECTION_LOSS_GRACE_MS / 2);
    reporter.report('connected');
    vi.advanceTimersByTime(CONNECTION_LOSS_GRACE_MS);
    expect(notices).toEqual([]);
    reporter.report('offline');
    reporter.retire();
    vi.advanceTimersByTime(CONNECTION_LOSS_GRACE_MS + 1);
    expect(notices).toEqual([]);
  });
});

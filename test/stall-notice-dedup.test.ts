import { describe, expect, it, vi } from 'vitest';
import { noticeStalledAutomationChats, setUserNoticeNotifier } from '../src/main/user-notice.js';

const base = Date.now();
let counter = 0;

function chat(sessionId: string, lastWorkedAt = base - 3_600_000, state = 'stalled') {
  return {
    sessionId, conversationId: `conv-${sessionId}`, mode: 'loop' as const, state,
    pause: false, reason: 'evidence wait', activeWorkers: 0, nextRetryAt: null,
    lastWorkedAt, rotation: { state: 'idle' }, title: 'Test chat',
    nextAction: 'test', recoverable: false, spinning: false, recoveryStage: null
  } as any;
}

describe('stall notification fires once per continuous episode', () => {
  it('notifies once for a continuous stall and stays silent on later passes', () => {
    const notify = vi.fn(() => true);
    setUserNoticeNotifier(notify);
    try {
      const sid = `dedup-a${++counter}`;
      noticeStalledAutomationChats([chat(sid)], base);
      expect(notify).toHaveBeenCalledTimes(1);
      for (let minute = 1; minute <= 30; minute++) {
        noticeStalledAutomationChats([chat(sid, base - 3_600_000 + minute)], base + minute * 60_000);
      }
      expect(notify).toHaveBeenCalledTimes(1);
    } finally { setUserNoticeNotifier(null); }
  });

  it('re-arms after recovery, then notifies again on the next stall episode', () => {
    const notify = vi.fn(() => true);
    setUserNoticeNotifier(notify);
    try {
      const sid = `dedup-b${++counter}`;
      noticeStalledAutomationChats([chat(sid)], base);
      expect(notify).toHaveBeenCalledTimes(1);
      noticeStalledAutomationChats([chat(sid)], base + 60_000);
      expect(notify).toHaveBeenCalledTimes(1);
      // Chat recovers → episode clears.
      noticeStalledAutomationChats([chat(sid, base + 120_000, 'idle')], base + 120_000);
      expect(notify).toHaveBeenCalledTimes(1);
      // New stall begins but is under the threshold.
      noticeStalledAutomationChats([chat(sid, base + 120_000)], base + 120_000);
      expect(notify).toHaveBeenCalledTimes(1);
      // One hour later: fires again.
      noticeStalledAutomationChats([chat(sid, base + 120_000)], base + 120_000 + 3_600_000);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally { setUserNoticeNotifier(null); }
  });

  it('silences when paused', () => {
    const notify = vi.fn(() => true);
    setUserNoticeNotifier(notify);
    try {
      const sid = `dedup-c${++counter}`;
      noticeStalledAutomationChats([chat(sid)], base, true);
      expect(notify).not.toHaveBeenCalled();
      noticeStalledAutomationChats([chat(sid)], base, false);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally { setUserNoticeNotifier(null); }
  });
});

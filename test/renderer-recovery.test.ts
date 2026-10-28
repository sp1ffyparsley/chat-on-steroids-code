import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderRecoveryCountdowns } from '../src/renderer/recovery.js';

let dom: JSDOM, host: HTMLElement;
beforeEach(() => {
  dom = new JSDOM('<div id="recovery" hidden></div>');
  vi.stubGlobal('document', dom.window.document);
  host = document.getElementById('recovery')!;
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

it('ticks the actual deadline without rebuilding the row or claiming an action at zero', () => {
  const countdowns = [{ kind: 'thinking-failed' as const, deadline: 300_000 }];
  expect(renderRecoveryCountdowns(host, countdowns, 0)).toBe(true);
  expect(host.textContent).toContain('Next recovery check in 5:00');
  const row = host.firstElementChild;
  renderRecoveryCountdowns(host, countdowns, 1_001);
  expect(host.textContent).toContain('Next recovery check in 4:59');
  expect(host.firstElementChild).toBe(row);
  renderRecoveryCountdowns(host, countdowns, 305_000);
  expect(host.textContent).toContain('Recovery check due · no Send receipt implied');
  expect(host.textContent).not.toContain('message sent');
  expect(host.querySelector('[role="timer"]')?.getAttribute('aria-live')).toBe('off');
  renderRecoveryCountdowns(host, [{ kind: 'native-busy', deadline: 605_000 }], 305_000);
  expect(host.textContent).toContain('Next recovery check in 5:00');
});

it('can show concurrent attribution and listening waits and relinquishes the host when cancelled', () => {
  renderRecoveryCountdowns(host, [{ kind: 'unattributed', deadline: 15_000 }, { kind: 'thinking-failed', deadline: 300_000 }], 0);
  expect(host.querySelectorAll('.recovery-notice')).toHaveLength(2);
  expect(host.textContent).toContain('Next recovery check in 0:15');
  renderRecoveryCountdowns(host, [{ kind: 'unattributed', deadline: 15_000 }], 16_000);
  expect(host.textContent).toContain('Recovery check due · no Send receipt implied');
  expect(host.querySelectorAll('.recovery-notice')).toHaveLength(1);
  expect(renderRecoveryCountdowns(host, [], 16_000)).toBe(false);
  expect(host.dataset.countdowns).toBeUndefined();
});

it('shows the remaining five-minute attribution window without promising another reload', () => {
  renderRecoveryCountdowns(host, [{ kind: 'unattributed-wait', deadline: 300_000 }], 60_000);
  expect(host.textContent).toContain('Unattributed activity · awaiting attribution');
  expect(host.textContent).toContain('Next recovery check in 4:00');
  expect(host.textContent).not.toContain('Reload in');
  renderRecoveryCountdowns(host, [{ kind: 'unattributed-wait', deadline: 300_000 }], 299_001);
  expect(host.textContent).toContain('Next recovery check in 0:01');
});

it('reveals Pro silence at five minutes using the UI clock and hides again when activity renews it', () => {
  const countdown = { kind: 'silence' as const, deadline: 600_000, visibleAt: 300_000, staleSince: 150_000 };
  expect(renderRecoveryCountdowns(host, [countdown], 299_999)).toBe(true);
  expect(host.hidden).toBe(true);
  renderRecoveryCountdowns(host, [countdown], 300_000);
  expect(host.hidden).toBe(false);
  expect(host.textContent).toContain('Last observed event 2m 30s ago');
  expect(host.textContent).toContain('Next recovery check in 5:00');
  renderRecoveryCountdowns(host, [{ ...countdown, visibleAt: 600_000, deadline: 900_000 }], 300_000);
  expect(host.hidden).toBe(true);
  renderRecoveryCountdowns(host, [countdown, { kind: 'post-reload', deadline: 359_999 }], 299_999);
  expect(host.hidden).toBe(false);
  expect((host.firstElementChild as HTMLElement).hidden).toBe(true);
  expect(host.lastElementChild?.textContent).toContain('Next recovery check in 1:00');
});

it('ticks stale age beside the incumbent recovery clock without rebuilding the row', () => {
  const countdowns = [{ kind: 'post-reload' as const, deadline: 300_000, staleSince: 10_000 }];
  renderRecoveryCountdowns(host, countdowns, 70_500);
  const row = host.firstElementChild;
  expect(host.textContent).toContain('Last observed event 1m 00s ago');
  renderRecoveryCountdowns(host, countdowns, 71_500);
  expect(host.firstElementChild).toBe(row);
  expect(host.textContent).toContain('Last observed event 1m 01s ago');
});

it.each(['queue', 'goal', 'loop'] as const)('names %s as the next step without claiming it was sent', next => {
  renderRecoveryCountdowns(host, [{ kind: 'post-reload', next, deadline: 60_000 }], 0);
  expect(host.textContent).toContain(`Reloaded · next: ${next === 'queue' ? 'Queued message' : next === 'goal' ? 'Goal' : 'Loop'}`);
  expect(host.textContent).toContain('Next recovery check in 1:00');
});

it('shows the owner action visibly without inventing Continue authority from stale evidence', () => {
  const countdown = { kind: 'post-reload' as const, deadline: 300_000, staleSince: 10_000,
    reason: 'Waiting for exact final/tool evidence',
    nextAction: 'Keep the saved reply; do not send another message.' };
  renderRecoveryCountdowns(host, [countdown], 70_500);
  const row = host.firstElementChild;
  expect(host.textContent).toContain(countdown.nextAction);
  expect(host.textContent).toContain('Last observed event 1m 00s ago');
  expect(host.textContent).not.toContain('type Continue');
  renderRecoveryCountdowns(host, [countdown], 305_000);
  expect(host.firstElementChild).toBe(row);
  expect(host.textContent).toContain(countdown.nextAction);
  expect(host.textContent).toContain('Recovery check due · no Send receipt implied');
  expect(host.textContent).not.toContain('type Continue');
  expect(host.querySelector('[role="timer"]')?.getAttribute('aria-live')).toBe('off');
});

it('does not manufacture a manual action when the owner supplied only a stale timestamp', () => {
  renderRecoveryCountdowns(host, [{ kind: 'post-reload', deadline: 300_000, staleSince: 10_000 }], 70_500);
  expect(host.textContent).toContain('Last observed event 1m 00s ago');
  expect(host.textContent).not.toContain('Continue');
  expect(host.querySelector('.recovery-next-action')).toBeNull();
});

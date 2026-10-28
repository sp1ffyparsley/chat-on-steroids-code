import { afterEach, describe, expect, it } from 'vitest';

import {
  automationRotationAdmits,
  automationRotationPosition,
  grantAutomationRotationForeground,
  rearmAutomationRotationForExplicitResume,
  reconcileAutomationRotation,
  resetAutomationRotationForTests,
  setAutomationRotationMembership
} from '../src/main/automation-rotation.js';

afterEach(() => resetAutomationRotationForTests());

const options = { enabled: true, batchSize: 5, cycleMs: 60 * 60_000, foregroundSlots: 2 };
const candidates = (count: number, start = 1) => Array.from({ length: count }, (_, index) => ({
  conversationId: `chat-${start + index}`,
  priorityAt: start + index
}));

describe('automatic Goal/Loop rotation', () => {
  it('admits five chats, exposes queue positions, and rotates only after the busy turn settles', () => {
    const start = 1_000_000;
    let view = reconcileAutomationRotation(candidates(8), new Set(), options, start);
    expect(view.active).toEqual(['chat-8', 'chat-7', 'chat-6', 'chat-5', 'chat-4']);
    expect(view.queue).toEqual(['chat-3', 'chat-2', 'chat-1']);
    expect(automationRotationPosition('chat-3')).toEqual({ state: 'queued', position: 1 });
    expect(automationRotationAdmits('chat-8')).toBe(true);
    expect(automationRotationAdmits('chat-3')).toBe(false);

    const drainAt = start + options.cycleMs;
    view = reconcileAutomationRotation(
      candidates(8).map(row => ({ ...row, progressAt: drainAt })),
      new Set(['chat-8']),
      options,
      drainAt
    );
    expect(view.draining).toBe(true);
    expect(view.drainingAt).toBe(start + options.cycleMs);
    expect(view.nextRotationAt).toBeNull();
    expect(view.busyActive).toEqual(['chat-8']);
    expect(view.active).toEqual(['chat-8', 'chat-7', 'chat-6', 'chat-5', 'chat-4']);
    expect(automationRotationPosition('chat-8')).toEqual({ state: 'draining', position: 1 });
    expect(automationRotationAdmits('chat-8')).toBe(false);

    const settledAt = start + options.cycleMs + 30_000;
    view = reconcileAutomationRotation(
      candidates(8).map(row => ({ ...row, progressAt: settledAt })),
      new Set(),
      options,
      settledAt
    );
    expect(view.draining).toBe(false);
    expect(view.previous).toEqual(['chat-8', 'chat-7', 'chat-6', 'chat-5', 'chat-4']);
    expect(view.rotatedAt).toBe(start + options.cycleMs + 30_000);
    expect(view.active).toEqual(['chat-3', 'chat-2', 'chat-1', 'chat-8', 'chat-7']);
    expect(view.queue).toEqual(['chat-6', 'chat-5', 'chat-4']);
  });

  it('adopts chats already doing exact work into the first numbered batch before idle restored candidates', () => {
    const start = 1_500_000;
    const view = reconcileAutomationRotation(candidates(8), new Set(['chat-1', 'chat-2']), options, start);
    expect(view.active.slice(0, 2)).toEqual(['chat-2', 'chat-1']);
    expect(automationRotationPosition('chat-2')).toEqual({ state: 'active', position: 1 });
    expect(automationRotationPosition('chat-1')).toEqual({ state: 'active', position: 2 });
    expect(view.busyActive).toEqual(['chat-2', 'chat-1']);
  });

  it('puts newly enabled chats at the front of the next batch without preempting active work', () => {
    const start = 2_000_000;
    let view = reconcileAutomationRotation(candidates(7), new Set(), options, start);
    expect(view.active).toHaveLength(5);
    expect(view.queue).toEqual(['chat-2', 'chat-1']);

    expect(setAutomationRotationMembership(['brand-new'], true)).toBe(1);
    view = reconcileAutomationRotation([...candidates(7), { conversationId: 'brand-new', priorityAt: 99 }], new Set(), options, start + 10_000);
    expect(view.active).not.toContain('brand-new');
    expect(view.queue[0]).toBe('brand-new');
    expect(automationRotationPosition('brand-new')).toEqual({ state: 'queued', position: 1 });
  });

  it('gives two new user chats temporary foreground slots, then returns each settled chat to the queue front', () => {
    const start = 2_500_000;
    reconcileAutomationRotation(candidates(7), new Set(), options, start);

    expect(grantAutomationRotationForeground('new-one', start + 1)).toBe(true);
    expect(grantAutomationRotationForeground('new-two', start + 2)).toBe(true);
    expect(grantAutomationRotationForeground('new-three', start + 3)).toBe(false);
    const all = [...candidates(7),
      { conversationId: 'new-one', priorityAt: 100 },
      { conversationId: 'new-two', priorityAt: 101 },
      { conversationId: 'new-three', priorityAt: 102 }];
    let view = reconcileAutomationRotation(all, new Set(['new-one', 'new-two']), options, start + 4);
    expect(view.foreground).toEqual(['new-one', 'new-two']);
    expect(view.queue[0]).toBe('new-three');
    expect(automationRotationAdmits('new-one')).toBe(true);

    view = reconcileAutomationRotation(all, new Set(['new-two']), options, start + 5);
    expect(view.foreground).toEqual(['new-two']);
    expect(view.queue.slice(0, 2)).toEqual(['new-one', 'new-three']);
  });

  it('keeps automation metadata but removes the scheduler fence when a chat leaves the batch', () => {
    const start = 2_750_000;
    reconcileAutomationRotation(candidates(7), new Set(), options, start);
    expect(setAutomationRotationMembership(['chat-1'], false)).toBe(1);
    const view = reconcileAutomationRotation(candidates(7), new Set(), options, start + 1);
    expect(view.enrolled).not.toContain('chat-1');
    expect(automationRotationPosition('chat-1')).toBeNull();
    expect(automationRotationAdmits('chat-1')).toBe(true);
  });

  it('yields only a slot with no durable progress for 15 minutes and lets an explicit retry revisit it', () => {
    const start = 2_800_000;
    const compact = { ...options, batchSize: 3 };
    const initial = candidates(4).map(row => ({ ...row, progressAt: start }));
    reconcileAutomationRotation(initial, new Set(), compact, start);

    const checkedAt = start + 15 * 60_000 + 1;
    const later = initial.map(row => ({
      ...row,
      progressAt: row.conversationId === 'chat-4' ? start : checkedAt
    }));
    let view = reconcileAutomationRotation(later, new Set(), compact, checkedAt);
    expect(view.attention).toEqual(['chat-4']);
    expect(view.active).toEqual(['chat-3', 'chat-2', 'chat-1']);
    expect(automationRotationPosition('chat-4')).toEqual({ state: 'attention', position: 1 });
    expect(automationRotationAdmits('chat-4')).toBe(false);

    expect(grantAutomationRotationForeground('chat-4', checkedAt + 1)).toBe(true);
    view = reconcileAutomationRotation(later, new Set(['chat-4']), compact, checkedAt + 2);
    expect(view.attention).toEqual([]);
    expect(view.foreground).toContain('chat-4');
    expect(automationRotationAdmits('chat-4')).toBe(true);
  });

  it('returns every enrolled Needs attention row to the fair queue on explicit Resume all', () => {
    const start = 2_850_000;
    const compact = { ...options, batchSize: 3 };
    const initial = candidates(5).map(row => ({ ...row, progressAt: start }));
    reconcileAutomationRotation(initial, new Set(), compact, start);

    const checkedAt = start + 15 * 60_000 + 1;
    const later = initial.map(row => ({
      ...row,
      progressAt: row.conversationId === 'chat-5' ? start : checkedAt
    }));
    let view = reconcileAutomationRotation(later, new Set(), compact, checkedAt);
    expect(view.attention).toEqual(['chat-5']);
    expect(view.active).toEqual(['chat-4', 'chat-3', 'chat-2']);

    expect(rearmAutomationRotationForExplicitResume(initial.map(row => row.conversationId), checkedAt + 1)).toBe(1);
    view = reconcileAutomationRotation(later, new Set(), compact, checkedAt + 2);
    expect(view.attention).toEqual([]);
    expect(view.active).toEqual(['chat-4', 'chat-3', 'chat-2']);
    expect(view.queue).toEqual(['chat-5', 'chat-1']);
    expect(automationRotationPosition('chat-5')).toEqual({ state: 'queued', position: 1 });
    expect(view.draining).toBe(false);
    expect(view.nextRotationAt).toBe(checkedAt + 1 + compact.cycleMs);
  });

  it('lets one stale slot yield even when a restored batch is already finishing', () => {
    const start = 2_900_000;
    const compact = { ...options, batchSize: 3 };
    const initial = candidates(4).map(row => ({ ...row, progressAt: start }));
    reconcileAutomationRotation(initial, new Set(), compact, start);

    const drainAt = start + compact.cycleMs;
    const atDrain = initial.map(row => ({ ...row, progressAt: drainAt }));
    let view = reconcileAutomationRotation(atDrain, new Set(['chat-4']), compact, drainAt);
    expect(view.draining).toBe(true);

    const checkedAt = drainAt + 15 * 60_000 + 1;
    const later = atDrain.map(row => ({
      ...row,
      progressAt: row.conversationId === 'chat-4' ? drainAt : checkedAt
    }));
    view = reconcileAutomationRotation(later, new Set(['chat-4']), compact, checkedAt);
    expect(view.draining).toBe(false);
    expect(view.attention).toEqual(['chat-4']);
    expect(view.active).toEqual(['chat-3', 'chat-2', 'chat-1']);
    expect(view.nextRotationAt).toBeNull();
    expect(automationRotationAdmits('chat-1')).toBe(true);
  });

  it('clears a pre-restart finishing latch after current busy chats are revalidated', () => {
    const start = 3_000_000;
    const compact = { ...options, batchSize: 3 };
    const initial = candidates(4).map(row => ({ ...row, progressAt: start }));
    reconcileAutomationRotation(initial, new Set(), compact, start);
    const drainAt = start + compact.cycleMs;
    const current = initial.map(row => ({ ...row, progressAt: drainAt }));
    let view = reconcileAutomationRotation(current, new Set(['chat-4']), compact, drainAt);
    expect(view.draining).toBe(true);

    reconcileAutomationRotation(current, new Set(['chat-4']), { ...compact, enabled: false }, drainAt + 1);
    view = reconcileAutomationRotation(current, new Set(['chat-4']), compact, drainAt + 2);
    expect(view.draining).toBe(false);
    expect(view.active[0]).toBe('chat-4');
    expect(automationRotationAdmits('chat-4')).toBe(true);
  });

  it('fills a vacated active slot immediately and disables every fence outside Rotation mode', () => {
    const start = 3_100_000;
    reconcileAutomationRotation(candidates(6), new Set(), options, start);
    const remaining = candidates(6).filter(row => row.conversationId !== 'chat-6');
    const view = reconcileAutomationRotation(remaining, new Set(), options, start + 1);
    expect(view.active).toHaveLength(5);
    expect(view.active).toContain('chat-1');

    reconcileAutomationRotation(remaining, new Set(), { ...options, enabled: false }, start + 2);
    expect(automationRotationAdmits('not-in-any-queue')).toBe(true);
    expect(automationRotationPosition('chat-1')).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  ProfileLifecycleCoordinator,
  type ActiveWorkBlocker,
  type DeferredProfileSwitch
} from '../src/main/profile-lifecycle.js';
import { NEW_WORK_KINDS, WorkAdmissionGate } from '../src/main/work-admission.js';

function fixture(initialBlockers: ActiveWorkBlocker[] = []) {
  const profileId = 'source';
  const admission = new WorkAdmissionGate();
  let blockers = initialBlockers;
  let durable: DeferredProfileSwitch | null = null;
  let now = 1_000;
  let nextId = 0;
  const ready = vi.fn(async (_state: Readonly<DeferredProfileSwitch>) => undefined);
  const update = vi.fn(async () => undefined);
  const shutdown = vi.fn(async () => undefined);
  const census = vi.fn(async () => ({ profileId, blockers }));
  const writes: Array<DeferredProfileSwitch | null> = [];
  const writeAdmissionModes: string[] = [];
  let nextWriteError: Error | null = null;
  let nextUpdateError: Error | null = null;
  update.mockImplementation(async () => {
    if (!nextUpdateError) return;
    const error = nextUpdateError;
    nextUpdateError = null;
    throw error;
  });
  const coordinator = new ProfileLifecycleCoordinator({
    profileId,
    admission,
    census,
    readDeferredSwitch: async () => durable,
    writeDeferredSwitch: async (state) => {
      writeAdmissionModes.push(admission.snapshot().mode);
      if (nextWriteError) {
        const error = nextWriteError;
        nextWriteError = null;
        throw error;
      }
      durable = state ? structuredClone(state) : null;
      writes.push(durable ? structuredClone(durable) : null);
    },
    onSwitchReady: ready,
    applyUpdate: update,
    applyShutdown: shutdown,
    now: () => now,
    idFactory: () => `transition-${++nextId}`
  });
  return {
    profileId,
    admission,
    coordinator,
    ready,
    update,
    shutdown,
    census,
    writes,
    writeAdmissionModes,
    setBlockers: (next: ActiveWorkBlocker[]) => { blockers = next; },
    setDurable: (next: DeferredProfileSwitch | null) => { durable = next ? structuredClone(next) : null; },
    durable: () => durable ? structuredClone(durable) : null,
    failNextWrite: (error: Error) => { nextWriteError = error; },
    failNextUpdate: (error: Error) => { nextUpdateError = error; },
    tick: (amount = 1) => { now += amount; }
  };
}

describe('profile lifecycle switching', () => {
  it('completes an idle immediate switch without entering Drain', async () => {
    const f = fixture();
    const result = await f.coordinator.requestSwitch('target', false);

    expect(result.outcome).toBe('ready');
    expect(result.status).toMatchObject({
      profileId: 'source',
      phase: 'switch-ready',
      targetProfileId: 'target',
      blockerCount: 0,
      admission: { mode: 'finalizing' }
    });
    expect(f.writes).toHaveLength(1);
    expect(f.durable()).toMatchObject({
      sourceProfileId: 'source', targetProfileId: 'target', phase: 'ready', verifiedIdleAt: 1_000
    });
    expect(f.ready).toHaveBeenCalledTimes(1);
  });

  it('reports active blockers without draining, then explicitly defers and settles once idle', async () => {
    const f = fixture([{ category: 'worker', count: 2, detail: 'two workers still active' }]);

    const blocked = await f.coordinator.requestSwitch('target', false);
    expect(blocked.outcome).toBe('blocked');
    expect(blocked.status).toMatchObject({ phase: 'idle', blockerCount: 2, admission: { mode: 'open' } });
    expect(f.writes).toEqual([]);

    const deferred = await f.coordinator.requestSwitch('target', true);
    expect(deferred.outcome).toBe('draining');
    expect(deferred.status).toMatchObject({ phase: 'draining-switch', blockerCount: 2, admission: { mode: 'draining' } });
    expect(f.durable()).toMatchObject({ sourceProfileId: 'source', targetProfileId: 'target', phase: 'draining' });
    expect(f.ready).not.toHaveBeenCalled();

    f.tick();
    f.setBlockers([]);
    await Promise.all([f.coordinator.notifyWorkChanged(), f.coordinator.poll(), f.coordinator.notifyWorkChanged()]);
    expect(f.coordinator.getStatus()).toMatchObject({ phase: 'switch-ready', blockerCount: 0, admission: { mode: 'finalizing' } });
    expect(f.durable()).toMatchObject({ phase: 'ready', verifiedIdleAt: 1_001 });
    expect(f.ready).toHaveBeenCalledTimes(1);
    expect(f.writes.filter((row) => row?.phase === 'ready')).toHaveLength(1);
  });

  it('restores a crash-persisted Drain on the source profile without activating the target', async () => {
    const f = fixture([{ category: 'mcp', count: 1 }]);
    f.setDurable({
      version: 1,
      transitionId: 'persisted-transition',
      sourceProfileId: 'source',
      targetProfileId: 'target',
      phase: 'draining',
      requestedAt: 900
    });

    const restored = await f.coordinator.restore();
    expect(restored).toMatchObject({
      profileId: 'source', phase: 'draining-switch', targetProfileId: 'target', blockerCount: 1,
      admission: { mode: 'draining', owner: 'persisted-transition' }
    });
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.durable()).toMatchObject({ phase: 'draining', targetProfileId: 'target' });

    f.setBlockers([]);
    await f.coordinator.notifyWorkChanged();
    expect(f.coordinator.getStatus().profileId).toBe('source');
    expect(f.durable()).toMatchObject({ phase: 'ready', targetProfileId: 'target' });
    expect(f.ready).toHaveBeenCalledTimes(1);
  });

  it('fails closed if bootstrap activates a target before the persisted Drain reached ready', async () => {
    const admission = new WorkAdmissionGate();
    const state: DeferredProfileSwitch = {
      version: 1,
      transitionId: 'premature-transition',
      sourceProfileId: 'source',
      targetProfileId: 'target',
      phase: 'draining',
      requestedAt: 900
    };
    const coordinator = new ProfileLifecycleCoordinator({
      profileId: 'target',
      admission,
      census: async () => ({ profileId: 'target', blockers: [] }),
      readDeferredSwitch: async () => state,
      writeDeferredSwitch: vi.fn(async () => undefined),
      onSwitchReady: vi.fn(),
      applyUpdate: vi.fn(),
      applyShutdown: vi.fn()
    });

    await expect(coordinator.restore()).rejects.toThrow('before idle verification');
    expect(admission.snapshot().mode).toBe('open');
  });
});

describe('Drain admission', () => {
  it('gates every new root-work kind while leaving release explicit', () => {
    const gate = new WorkAdmissionGate();
    for (const kind of NEW_WORK_KINDS) expect(gate.decideNew(kind).allowed).toBe(true);

    gate.beginDrain('transition', 'test drain');
    for (const kind of NEW_WORK_KINDS) {
      expect(gate.decideNew(kind)).toMatchObject({ kind, allowed: false, mode: 'draining', owner: 'transition' });
    }

    expect(gate.release('someone-else')).toBe(false);
    expect(gate.release('transition')).toBe(true);
    for (const kind of NEW_WORK_KINDS) expect(gate.decideNew(kind).allowed).toBe(true);
  });
});

describe('standalone Drain', () => {
  it('fences an already-idle runtime and stays in drain-ready without invoking another action', async () => {
    const f = fixture();

    const result = await f.coordinator.requestDrain();

    expect(result.outcome).toBe('ready');
    expect(result.status).toMatchObject({
      phase: 'drain-ready', blockerCount: 0,
      admission: { mode: 'draining', owner: 'transition-1', reason: 'standalone Drain verified idle' }
    });
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it('reports blockers while busy, then transitions to verified idle exactly once', async () => {
    const f = fixture([{ category: 'worker', count: 2 }]);

    const result = await f.coordinator.requestDrain();
    expect(result.outcome).toBe('draining');
    expect(result.status).toMatchObject({
      phase: 'draining', blockerCount: 2, admission: { mode: 'draining', owner: 'transition-1' }
    });

    f.tick();
    f.setBlockers([]);
    await Promise.all([f.coordinator.poll(), f.coordinator.notifyWorkChanged(), f.coordinator.poll()]);
    const ready = f.coordinator.getStatus();
    expect(ready).toMatchObject({ phase: 'drain-ready', blockerCount: 0, admission: { mode: 'draining' } });
    expect(ready.admission.generation).toBe(2);
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  it('can be cancelled after idle verification and restores admission exactly', async () => {
    const f = fixture();
    await f.coordinator.requestDrain();
    expect(f.coordinator.getStatus().phase).toBe('drain-ready');

    const cancelled = await f.coordinator.cancelDrain();

    expect(cancelled).toMatchObject({
      cancelled: true,
      kind: 'drain',
      status: {
        phase: 'idle', targetProfileId: null, transitionId: null, blockers: [], blockerCount: 0,
        admission: { mode: 'open', owner: null, reason: null }
      }
    });
  });

  it('converts a verified standalone Drain into a switch using the same fence without another census', async () => {
    const f = fixture();
    await f.coordinator.requestDrain();
    const ready = f.coordinator.getStatus();
    const callsAtReady = f.census.mock.calls.length;

    const switched = await f.coordinator.requestSwitch('target', false);

    expect(switched.outcome).toBe('ready');
    expect(switched.status).toMatchObject({
      phase: 'switch-ready', transitionId: ready.transitionId, targetProfileId: 'target',
      admission: { mode: 'finalizing', owner: ready.transitionId }
    });
    expect(f.census).toHaveBeenCalledTimes(callsAtReady);
    expect(f.durable()).toMatchObject({
      transitionId: ready.transitionId, sourceProfileId: 'source', targetProfileId: 'target',
      phase: 'ready', requestedAt: 1_000, verifiedIdleAt: 1_000
    });
    expect(f.ready).toHaveBeenCalledTimes(1);
  });

  it('converts a verified standalone Drain into an update using the same fence without another census', async () => {
    const f = fixture();
    await f.coordinator.requestDrain();
    const ready = f.coordinator.getStatus();
    const callsAtReady = f.census.mock.calls.length;

    const updated = await f.coordinator.requestUpdate();

    expect(updated.outcome).toBe('applied');
    expect(updated.status).toMatchObject({
      phase: 'update-applied', transitionId: ready.transitionId,
      admission: { mode: 'finalizing', owner: ready.transitionId }
    });
    expect(f.census).toHaveBeenCalledTimes(callsAtReady);
    expect(f.update).toHaveBeenCalledTimes(1);
  });

  it('converts a verified standalone Drain into a safe maintenance shutdown using the same fence', async () => {
    const f = fixture();
    await f.coordinator.requestDrain();
    const ready = f.coordinator.getStatus();
    const callsAtReady = f.census.mock.calls.length;

    const closed = await f.coordinator.requestShutdown();

    expect(closed.outcome).toBe('applied');
    expect(closed.status).toMatchObject({
      phase: 'shutdown-applied', transitionId: ready.transitionId,
      admission: { mode: 'finalizing', owner: ready.transitionId }
    });
    expect(f.census).toHaveBeenCalledTimes(callsAtReady);
    expect(f.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('Drain cancellation', () => {
  it('rejects an observed transition that was replaced before serialized cancellation', async () => {
    const f = fixture([{ category: 'provider-turn', count: 1 }]);
    await f.coordinator.requestDrain();
    const observed = f.coordinator.getStatus().transitionId!;
    await f.coordinator.cancelDrain();
    const replacement = f.coordinator.requestShutdown();
    const stale = f.coordinator.cancelDrain(observed);
    await replacement;
    await expect(stale).rejects.toThrow('different lifecycle transition');
    expect(f.coordinator.getStatus()).toMatchObject({ phase: 'draining-shutdown', admission: { mode: 'draining' } });
    expect(f.coordinator.getStatus().transitionId).not.toBe(observed);
    expect(f.shutdown).not.toHaveBeenCalled();
  });

  it('durably clears a deferred switch before reopening admission and restores idle state exactly', async () => {
    const f = fixture([{ category: 'worker', count: 1 }]);
    await f.coordinator.requestSwitch('target', true);
    expect(f.durable()).toMatchObject({ phase: 'draining', targetProfileId: 'target' });
    expect(f.admission.snapshot().mode).toBe('draining');

    const cancelled = await f.coordinator.cancelDrain();

    expect(cancelled).toMatchObject({
      cancelled: true,
      kind: 'switch',
      status: {
        profileId: 'source',
        phase: 'idle',
        targetProfileId: null,
        transitionId: null,
        blockerCount: 0,
        blockers: [],
        admission: { mode: 'open', owner: null, reason: null }
      }
    });
    expect(f.durable()).toBeNull();
    expect(f.writes.at(-1)).toBeNull();
    expect(f.writeAdmissionModes.at(-1)).toBe('draining');
    expect(f.ready).not.toHaveBeenCalled();
  });

  it('reopens admission for a draining update and refuses cancellation after finalization', async () => {
    const f = fixture([{ category: 'provider-turn', count: 1 }]);
    await f.coordinator.requestUpdate();

    const cancelled = await f.coordinator.cancelDrain();
    expect(cancelled).toMatchObject({ cancelled: true, kind: 'update' });
    expect(f.coordinator.getStatus()).toMatchObject({
      phase: 'idle', targetProfileId: null, transitionId: null, blockers: [], blockerCount: 0,
      admission: { mode: 'open', owner: null, reason: null }
    });
    expect(f.update).not.toHaveBeenCalled();

    f.setBlockers([]);
    await f.coordinator.requestUpdate();
    expect(f.coordinator.getStatus()).toMatchObject({ phase: 'update-applied', admission: { mode: 'finalizing' } });
    await expect(f.coordinator.cancelDrain()).rejects.toThrow('can no longer be cancelled');
    expect(f.update).toHaveBeenCalledTimes(1);

    const switchReady = fixture();
    await switchReady.coordinator.requestSwitch('target', true);
    expect(switchReady.coordinator.getStatus()).toMatchObject({ phase: 'switch-ready', admission: { mode: 'finalizing' } });
    await expect(switchReady.coordinator.cancelDrain()).rejects.toThrow('can no longer be cancelled');
    expect(switchReady.ready).toHaveBeenCalledTimes(1);
  });

  it('keeps switch Drain fenced when durable cancellation cannot be saved', async () => {
    const f = fixture([{ category: 'worker', count: 1 }]);
    await f.coordinator.requestSwitch('target', true);
    const original = f.durable();
    f.failNextWrite(new Error('disk unavailable'));

    await expect(f.coordinator.cancelDrain()).rejects.toThrow('disk unavailable');
    expect(f.durable()).toEqual(original);
    expect(f.coordinator.getStatus()).toMatchObject({ phase: 'draining-switch', admission: { mode: 'draining' } });
  });
});

describe('Drain and apply update', () => {
  it('waits for categorized active work and invokes the update callback exactly once', async () => {
    const f = fixture([
      { category: 'provider-turn', count: 1 },
      { category: 'input-delivery', count: 2 }
    ]);
    const requested = await f.coordinator.requestUpdate();
    expect(requested.outcome).toBe('draining');
    expect(requested.status).toMatchObject({ phase: 'draining-update', blockerCount: 3, admission: { mode: 'draining' } });
    expect(f.update).not.toHaveBeenCalled();

    f.setBlockers([]);
    await Promise.all([f.coordinator.poll(), f.coordinator.notifyWorkChanged(), f.coordinator.poll()]);
    expect(f.coordinator.getStatus()).toMatchObject({ phase: 'update-applied', blockerCount: 0, admission: { mode: 'finalizing' } });
    expect(f.update).toHaveBeenCalledTimes(1);

    await f.coordinator.poll();
    expect(f.update).toHaveBeenCalledTimes(1);
  });

  it('reopens admission after a deferred update handoff fails and allows an explicit retry', async () => {
    const f = fixture([{ category: 'worker', count: 1 }]);
    const requested = await f.coordinator.requestUpdate();
    expect(requested.outcome).toBe('draining');
    expect(f.coordinator.getStatus()).toMatchObject({ phase: 'draining-update', admission: { mode: 'draining' } });

    f.failNextUpdate(new Error('staged update was revoked'));
    f.setBlockers([]);
    await expect(f.coordinator.poll()).rejects.toThrow('staged update was revoked');
    expect(f.coordinator.getStatus()).toMatchObject({
      phase: 'idle',
      transitionId: null,
      admission: { mode: 'open', owner: null }
    });
    expect(f.update).toHaveBeenCalledTimes(1);

    const retried = await f.coordinator.requestUpdate();
    expect(retried.outcome).toBe('applied');
    expect(f.coordinator.getStatus()).toMatchObject({ phase: 'update-applied', admission: { mode: 'finalizing' } });
    expect(f.update).toHaveBeenCalledTimes(2);
  });
});

describe('safe maintenance shutdown', () => {
  it('pauses new work, waits for admitted work, and closes exactly once', async () => {
    const f = fixture([{ category: 'provider-turn', count: 1 }]);

    const requested = await f.coordinator.requestShutdown();
    expect(requested.outcome).toBe('draining');
    expect(requested.status).toMatchObject({
      phase: 'draining-shutdown', blockerCount: 1,
      admission: { mode: 'draining', reason: 'maintenance shutdown is draining existing work' }
    });
    expect(f.shutdown).not.toHaveBeenCalled();

    f.setBlockers([]);
    await Promise.all([f.coordinator.poll(), f.coordinator.notifyWorkChanged(), f.coordinator.poll()]);
    expect(f.coordinator.getStatus()).toMatchObject({
      phase: 'shutdown-applied', blockerCount: 0,
      admission: { mode: 'finalizing', reason: 'maintenance shutdown is ready to apply' }
    });
    expect(f.shutdown).toHaveBeenCalledTimes(1);

    await f.coordinator.poll();
    expect(f.shutdown).toHaveBeenCalledTimes(1);
  });
});

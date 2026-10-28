import { WorkAdmissionGate, type WorkAdmissionSnapshot } from './work-admission.js';

export const PROFILE_LIFECYCLE_STATE_VERSION = 1 as const;

export interface ActiveWorkBlocker {
  category: string;
  count: number;
  detail?: string;
}

export interface ActiveWorkCensus {
  profileId: string;
  blockers: readonly ActiveWorkBlocker[];
}

export type DeferredSwitchPhase = 'draining' | 'ready';

/** Bootstrap-global state supplied by the config owner; it contains no runtime-owned state. */
export interface DeferredProfileSwitch {
  version: typeof PROFILE_LIFECYCLE_STATE_VERSION;
  transitionId: string;
  sourceProfileId: string;
  targetProfileId: string;
  phase: DeferredSwitchPhase;
  requestedAt: number;
  verifiedIdleAt?: number;
}

export type ProfileLifecyclePhase =
  | 'idle'
  | 'draining'
  | 'drain-ready'
  | 'draining-switch'
  | 'switch-ready'
  | 'draining-update'
  | 'update-applied'
  | 'draining-shutdown'
  | 'shutdown-applied';

export interface ProfileLifecycleStatus {
  profileId: string;
  phase: ProfileLifecyclePhase;
  targetProfileId: string | null;
  transitionId: string | null;
  blockers: ActiveWorkBlocker[];
  blockerCount: number;
  admission: WorkAdmissionSnapshot;
}

export interface ProfileLifecycleDependencies {
  /** Immutable profile that owns the already-initialized runtime stores in this process. */
  profileId: string;
  admission: WorkAdmissionGate;
  census: () => Promise<ActiveWorkCensus>;
  readDeferredSwitch: () => Promise<unknown>;
  writeDeferredSwitch: (state: DeferredProfileSwitch | null) => Promise<void>;
  /** Schedules the restart/bootstrap handoff. It must never hot-activate target state in this process. */
  onSwitchReady: (state: Readonly<DeferredProfileSwitch>) => void | Promise<void>;
  /** Existing update owner callback. The lifecycle coordinator only decides when it may run. */
  applyUpdate: () => void | Promise<void>;
  /** Closes for external maintenance only after all admitted work has settled and stores are flushed. */
  applyShutdown: () => void | Promise<void>;
  now?: () => number;
  idFactory?: () => string;
  onStatusChange?: (status: ProfileLifecycleStatus) => void;
}

export type SwitchRequestResult =
  | { outcome: 'already-active'; status: ProfileLifecycleStatus }
  | { outcome: 'blocked'; status: ProfileLifecycleStatus }
  | { outcome: 'draining'; status: ProfileLifecycleStatus }
  | { outcome: 'ready'; status: ProfileLifecycleStatus };

export type UpdateRequestResult =
  | { outcome: 'draining'; status: ProfileLifecycleStatus }
  | { outcome: 'applied'; status: ProfileLifecycleStatus };

export type ShutdownRequestResult =
  | { outcome: 'draining'; status: ProfileLifecycleStatus }
  | { outcome: 'applied'; status: ProfileLifecycleStatus };

export type DrainRequestResult =
  | { outcome: 'draining'; status: ProfileLifecycleStatus }
  | { outcome: 'ready'; status: ProfileLifecycleStatus };

export interface CancelDrainResult {
  cancelled: true;
  kind: 'drain' | 'switch' | 'update' | 'shutdown';
  status: ProfileLifecycleStatus;
}

type DrainOperation = {
  kind: 'drain';
  transitionId: string;
  requestedAt: number;
  verifiedIdleAt: number | null;
};

type SwitchOperation = {
  kind: 'switch';
  state: DeferredProfileSwitch;
  callbackStarted: boolean;
};

type UpdateOperation = {
  kind: 'update';
  transitionId: string;
  callbackStarted: boolean;
};

type ShutdownOperation = {
  kind: 'shutdown';
  transitionId: string;
  callbackStarted: boolean;
};

type LifecycleOperation = DrainOperation | SwitchOperation | UpdateOperation | ShutdownOperation;

const PROFILE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export class ProfileLifecycleCoordinator {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private operation: LifecycleOperation | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private status: ProfileLifecycleStatus;
  private fallbackId = 0;

  constructor(private readonly deps: ProfileLifecycleDependencies) {
    if (!PROFILE_ID.test(deps.profileId)) throw new Error('Profile lifecycle requires a valid active profile id');
    this.now = deps.now ?? Date.now;
    this.idFactory = deps.idFactory ?? (() => `profile-lifecycle-${this.now()}-${++this.fallbackId}`);
    this.status = this.makeStatus('idle', null, null, []);
  }

  getStatus(): ProfileLifecycleStatus {
    return cloneStatus(this.status);
  }

  /**
   * Restores a deferred switch after a crash without changing the active runtime profile.
   * A ready switch merely replays the restart handoff callback with its stable transition id.
   */
  restore(): Promise<ProfileLifecycleStatus> {
    return this.enqueue(async () => {
      if (this.operation) return this.getStatus();
      const raw = await this.deps.readDeferredSwitch();
      if (raw == null) return this.getStatus();
      const state = parseDeferredSwitch(raw);

      // Bootstrap may consume only an idle-verified transition. Seeing the target active while a
      // durable record still says `draining` is evidence of premature activation, not completion.
      if (state.targetProfileId === this.deps.profileId) {
        if (state.phase !== 'ready') {
          throw new Error(
            `Deferred profile switch ${state.transitionId} activated ${state.targetProfileId} before idle verification`
          );
        }
        await this.deps.writeDeferredSwitch(null);
        this.publish('idle', null, null, []);
        return this.getStatus();
      }
      if (state.sourceProfileId !== this.deps.profileId) {
        throw new Error(
          `Deferred profile switch ${state.transitionId} belongs to ${state.sourceProfileId}, not active profile ${this.deps.profileId}`
        );
      }

      this.operation = { kind: 'switch', state, callbackStarted: false };
      if (state.phase === 'ready') {
        this.deps.admission.beginFinalization(state.transitionId, 'profile switch is ready for restart');
        this.publish('switch-ready', state.targetProfileId, state.transitionId, []);
        await this.dispatchSwitchReady(this.operation);
        return this.getStatus();
      }

      this.deps.admission.beginDrain(state.transitionId, 'deferred profile switch is draining existing work');
      this.publish('draining-switch', state.targetProfileId, state.transitionId, []);
      await this.evaluateCurrent();
      return this.getStatus();
    });
  }

  /**
   * Requests a restart-bound profile switch.
   *
   * With `whenIdle=false`, active work is reported and no Drain begins. With `whenIdle=true`,
   * the durable switch is filed and new root work is gated until existing work settles.
   */
  requestSwitch(targetProfileId: string, whenIdle: boolean): Promise<SwitchRequestResult> {
    return this.enqueue(async () => {
      const target = normalizeProfileId(targetProfileId);
      if (this.operation) {
        if (this.operation.kind === 'drain') {
          if (this.operation.verifiedIdleAt === null || this.status.phase !== 'drain-ready') {
            throw new Error('Standalone Drain is still settling existing work; wait for drain-ready or cancel it before requesting a profile switch');
          }
          if (target === this.deps.profileId) {
            return { outcome: 'already-active', status: this.getStatus() };
          }
          return this.convertReadyDrainToSwitch(this.operation, target);
        }
        if (this.operation.kind === 'switch' && this.operation.state.targetProfileId === target) {
          return { outcome: this.operation.state.phase === 'ready' ? 'ready' : 'draining', status: this.getStatus() };
        }
        throw new Error('Another profile lifecycle transition is already active');
      }
      if (target === this.deps.profileId) {
        const census = await this.readCensus();
        this.publish('idle', null, null, census.blockers);
        return { outcome: 'already-active', status: this.getStatus() };
      }

      const initial = await this.readCensus();
      if (initial.blockerCount > 0 && !whenIdle) {
        this.publish('idle', target, null, initial.blockers);
        return { outcome: 'blocked', status: this.getStatus() };
      }

      const transitionId = this.nextId();
      if (!whenIdle) {
        // This is a short race-closing fence, not Drain: if anything became active since the first
        // census, release it and report the new blockers instead of waiting in the background.
        this.deps.admission.beginFinalization(transitionId, 'verifying an immediate profile switch');
        const verified = await this.readCensus();
        if (verified.blockerCount > 0) {
          this.deps.admission.release(transitionId);
          this.publish('idle', target, null, verified.blockers);
          return { outcome: 'blocked', status: this.getStatus() };
        }
        const ready = this.newSwitchState(transitionId, target, 'ready', this.now());
        try {
          await this.deps.writeDeferredSwitch(ready);
        } catch (error) {
          this.deps.admission.release(transitionId);
          this.publish('idle', target, null, []);
          throw error;
        }
        this.operation = { kind: 'switch', state: ready, callbackStarted: false };
        this.publish('switch-ready', target, transitionId, []);
        await this.dispatchSwitchReady(this.operation);
        return { outcome: 'ready', status: this.getStatus() };
      }

      const draining = this.newSwitchState(transitionId, target, 'draining');
      this.deps.admission.beginDrain(transitionId, 'deferred profile switch is draining existing work');
      try {
        await this.deps.writeDeferredSwitch(draining);
      } catch (error) {
        this.deps.admission.release(transitionId);
        throw error;
      }
      this.operation = { kind: 'switch', state: draining, callbackStarted: false };
      this.publish('draining-switch', target, transitionId, initial.blockers);
      await this.evaluateCurrent();
      return {
        outcome: this.operation.state.phase === 'ready' ? 'ready' : 'draining',
        status: this.getStatus()
      };
    });
  }

  /** Drain existing work, then hand control to the existing update owner exactly once. */
  requestUpdate(): Promise<UpdateRequestResult> {
    return this.enqueue(async () => {
      if (this.operation) {
        if (this.operation.kind === 'drain') {
          if (this.operation.verifiedIdleAt === null || this.status.phase !== 'drain-ready') {
            throw new Error('Standalone Drain is still settling existing work; wait for drain-ready or cancel it before requesting an update');
          }
          return this.convertReadyDrainToUpdate(this.operation);
        }
        if (this.operation.kind === 'update') {
          return {
            outcome: this.status.phase === 'update-applied' ? 'applied' : 'draining',
            status: this.getStatus()
          };
        }
        throw new Error('A deferred profile switch is already active');
      }

      const transitionId = this.nextId();
      this.deps.admission.beginDrain(transitionId, 'update is draining existing work');
      this.operation = { kind: 'update', transitionId, callbackStarted: false };
      this.publish('draining-update', null, transitionId, []);
      try {
        await this.evaluateCurrent();
      } catch (error) {
        // Update intent is not a bootstrap identity record. A failed handoff reopens admission and
        // requires an explicit retry rather than silently invoking an uncertain callback again.
        if (this.operation?.kind === 'update' && this.operation.transitionId === transitionId) {
          this.operation = null;
          this.deps.admission.release(transitionId);
          this.publish('idle', null, null, []);
        }
        throw error;
      }
      return {
        outcome: this.status.phase === 'update-applied' ? 'applied' : 'draining',
        status: this.getStatus()
      };
    });
  }

  /** Drain existing work, then close once so an external installer can safely replace the app. */
  requestShutdown(): Promise<ShutdownRequestResult> {
    return this.enqueue(async () => {
      if (this.operation) {
        if (this.operation.kind === 'drain') {
          if (this.operation.verifiedIdleAt === null || this.status.phase !== 'drain-ready') {
            throw new Error('Standalone Drain is still settling existing work; wait for drain-ready or cancel it before requesting maintenance shutdown');
          }
          return this.convertReadyDrainToShutdown(this.operation);
        }
        if (this.operation.kind === 'shutdown') {
          return {
            outcome: this.status.phase === 'shutdown-applied' ? 'applied' : 'draining',
            status: this.getStatus()
          };
        }
        throw new Error('Another profile lifecycle transition is already active');
      }

      const transitionId = this.nextId();
      this.deps.admission.beginDrain(transitionId, 'maintenance shutdown is draining existing work');
      this.operation = { kind: 'shutdown', transitionId, callbackStarted: false };
      this.publish('draining-shutdown', null, transitionId, []);
      try {
        await this.evaluateCurrent();
      } catch (error) {
        if (this.operation?.kind === 'shutdown' && this.operation.transitionId === transitionId) {
          this.operation = null;
          this.deps.admission.release(transitionId);
          this.publish('idle', null, null, []);
        }
        throw error;
      }
      return {
        outcome: this.status.phase === 'shutdown-applied' ? 'applied' : 'draining',
        status: this.getStatus()
      };
    });
  }

  /**
   * Starts a standalone process-wide Drain without selecting a follow-up action.
   *
   * Once idle is verified, admission remains fenced in `drain-ready` until the caller cancels
   * Drain or converts that same verified-idle fence into a switch/update request.
   */
  requestDrain(): Promise<DrainRequestResult> {
    return this.enqueue(async () => {
      if (this.operation) {
        if (this.operation.kind !== 'drain') {
          throw new Error('Another profile lifecycle transition is already active');
        }
        return {
          outcome: this.operation.verifiedIdleAt === null ? 'draining' : 'ready',
          status: this.getStatus()
        };
      }

      const transitionId = this.nextId();
      const operation: DrainOperation = {
        kind: 'drain',
        transitionId,
        requestedAt: this.now(),
        verifiedIdleAt: null
      };
      this.deps.admission.beginDrain(transitionId, 'standalone Drain is waiting for existing work to settle');
      this.operation = operation;
      this.publish('draining', null, transitionId, []);
      await this.evaluateCurrent();
      return {
        outcome: operation.verifiedIdleAt === null ? 'draining' : 'ready',
        status: this.getStatus()
      };
    });
  }

  /**
   * Cancels only a transition that is still waiting for existing work to settle.
   *
   * A switch clears its bootstrap-global intent before admission reopens. Once idle verification
   * has promoted either operation to finalization, its callback owns the handoff and cancellation
   * is refused rather than racing a restart/update that may already be under way.
   */
  cancelDrain(expectedTransitionId?: string): Promise<CancelDrainResult> {
    return this.enqueue(async () => {
      const operation = this.operation;
      if (!operation) throw new Error('No profile lifecycle Drain is active');

      const transitionId = operation.kind === 'switch' ? operation.state.transitionId : operation.transitionId;
      // External operators cancel an observed transition, never whichever replacement happens
      // to own admission when this serialized operation finally runs. IPC keeps its current API.
      if (expectedTransitionId !== undefined && transitionId !== expectedTransitionId) {
        throw new Error('Cancel Drain targets a different lifecycle transition; inspect the current owner before retrying');
      }
      const stillDraining = operation.kind === 'drain'
        ? (this.status.phase === 'draining' || this.status.phase === 'drain-ready')
        : operation.kind === 'switch'
          ? operation.state.phase === 'draining' && !operation.callbackStarted
          : operation.kind === 'update'
            ? !operation.callbackStarted && this.status.phase === 'draining-update'
            : !operation.callbackStarted && this.status.phase === 'draining-shutdown';
      const admission = this.deps.admission.snapshot();
      if (!stillDraining || admission.mode !== 'draining' || admission.owner !== transitionId) {
        throw new Error('Profile lifecycle Drain can no longer be cancelled after finalization starts');
      }

      if (operation.kind === 'switch') {
        // Durable state first. If this write fails, keep both the operation and admission fence so
        // restart recovery still sees the same source-owned Drain and no new work slips through.
        await this.deps.writeDeferredSwitch(null);
      }

      const kind = operation.kind;
      if (!this.deps.admission.release(transitionId)) {
        // This should be unreachable because ownership was verified above. Fail closed instead of
        // publishing an idle status while some other lifecycle owner still fences admission.
        throw new Error('Profile lifecycle Drain lost its work-admission ownership');
      }
      this.operation = null;
      this.publish('idle', null, null, []);
      return { cancelled: true, kind, status: this.getStatus() };
    });
  }

  /** Poll hook for timers or lifecycle owners that do not emit change notifications. */
  poll(): Promise<ProfileLifecycleStatus> {
    return this.enqueue(async () => {
      if (!this.operation) {
        const census = await this.readCensus();
        this.publish('idle', null, null, census.blockers);
        return this.getStatus();
      }
      await this.evaluateCurrent();
      return this.getStatus();
    });
  }

  /** Change-notification hook; serialized with polling so an idle transition can win only once. */
  notifyWorkChanged(): Promise<ProfileLifecycleStatus> {
    return this.poll();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work, work);
    this.serial = run.then(() => undefined, () => undefined);
    return run;
  }

  private async evaluateCurrent(): Promise<void> {
    const operation = this.operation;
    if (!operation) return;

    if (operation.kind === 'drain' && operation.verifiedIdleAt !== null) return;
    if (operation.kind === 'switch' && operation.state.phase === 'ready') {
      await this.dispatchSwitchReady(operation);
      return;
    }
    if ((operation.kind === 'update' || operation.kind === 'shutdown') && operation.callbackStarted) return;

    const census = await this.readCensus();
    if (census.blockerCount > 0) {
      this.publish(
        operation.kind === 'drain'
          ? 'draining'
          : operation.kind === 'switch'
            ? 'draining-switch'
            : operation.kind === 'update'
              ? 'draining-update'
              : 'draining-shutdown',
        operation.kind === 'switch' ? operation.state.targetProfileId : null,
        operation.kind === 'switch' ? operation.state.transitionId : operation.transitionId,
        census.blockers
      );
      return;
    }

    if (operation.kind === 'drain') {
      operation.verifiedIdleAt = this.now();
      this.deps.admission.beginDrain(operation.transitionId, 'standalone Drain verified idle');
      this.publish('drain-ready', null, operation.transitionId, []);
      return;
    }

    if (operation.kind === 'switch') {
      const ready: DeferredProfileSwitch = {
        ...operation.state,
        phase: 'ready',
        verifiedIdleAt: this.now()
      };
      await this.deps.writeDeferredSwitch(ready);
      operation.state = ready;
      this.deps.admission.promoteToFinalization(ready.transitionId, 'profile switch is ready for restart');
      this.publish('switch-ready', ready.targetProfileId, ready.transitionId, []);
      await this.dispatchSwitchReady(operation);
      return;
    }

    operation.callbackStarted = true;
    if (operation.kind === 'update') {
      this.deps.admission.promoteToFinalization(operation.transitionId, 'update is ready to apply');
      this.publish('draining-update', null, operation.transitionId, []);
      await this.applyUpdateOperation(operation);
      return;
    }
    this.deps.admission.promoteToFinalization(operation.transitionId, 'maintenance shutdown is ready to apply');
    this.publish('draining-shutdown', null, operation.transitionId, []);
    await this.applyShutdownOperation(operation);
  }

  private async convertReadyDrainToSwitch(
    drain: DrainOperation,
    targetProfileId: string
  ): Promise<Extract<SwitchRequestResult, { outcome: 'ready' }>> {
    if (drain.verifiedIdleAt === null) throw new Error('Standalone Drain is not yet verified idle');
    const ready: DeferredProfileSwitch = {
      version: PROFILE_LIFECYCLE_STATE_VERSION,
      transitionId: drain.transitionId,
      sourceProfileId: this.deps.profileId,
      targetProfileId,
      phase: 'ready',
      requestedAt: drain.requestedAt,
      verifiedIdleAt: drain.verifiedIdleAt
    };
    // Persist the restart-bound target while the standalone fence still owns admission. A failed
    // write leaves Drain ready and cancellable, with no partially published switch operation.
    await this.deps.writeDeferredSwitch(ready);
    const operation: SwitchOperation = { kind: 'switch', state: ready, callbackStarted: false };
    this.operation = operation;
    this.deps.admission.promoteToFinalization(ready.transitionId, 'profile switch is ready for restart');
    this.publish('switch-ready', targetProfileId, ready.transitionId, []);
    await this.dispatchSwitchReady(operation);
    return { outcome: 'ready', status: this.getStatus() };
  }

  private async convertReadyDrainToUpdate(
    drain: DrainOperation
  ): Promise<Extract<UpdateRequestResult, { outcome: 'applied' }>> {
    if (drain.verifiedIdleAt === null) throw new Error('Standalone Drain is not yet verified idle');
    const operation: UpdateOperation = {
      kind: 'update',
      transitionId: drain.transitionId,
      callbackStarted: true
    };
    this.operation = operation;
    this.deps.admission.promoteToFinalization(operation.transitionId, 'update is ready to apply');
    this.publish('draining-update', null, operation.transitionId, []);
    await this.applyUpdateOperation(operation);
    return { outcome: 'applied', status: this.getStatus() };
  }

  private async convertReadyDrainToShutdown(
    drain: DrainOperation
  ): Promise<Extract<ShutdownRequestResult, { outcome: 'applied' }>> {
    if (drain.verifiedIdleAt === null) throw new Error('Standalone Drain is not yet verified idle');
    const operation: ShutdownOperation = {
      kind: 'shutdown',
      transitionId: drain.transitionId,
      callbackStarted: true
    };
    this.operation = operation;
    this.deps.admission.promoteToFinalization(operation.transitionId, 'maintenance shutdown is ready to apply');
    this.publish('draining-shutdown', null, operation.transitionId, []);
    await this.applyShutdownOperation(operation);
    return { outcome: 'applied', status: this.getStatus() };
  }

  private async applyUpdateOperation(operation: UpdateOperation): Promise<void> {
    try {
      await this.deps.applyUpdate();
    } catch (error) {
      // Update intent is process-local and retryable. If the staged updater authority vanished
      // while a deferred Drain was settling (for example CUSTOM_BUILD was restored), do not leave
      // admission permanently finalizing with a callback that can never run again.
      if (this.operation === operation) {
        this.operation = null;
        this.deps.admission.release(operation.transitionId);
        this.publish('idle', null, null, []);
      }
      throw error;
    }
    this.publish('update-applied', null, operation.transitionId, []);
  }

  private async applyShutdownOperation(operation: ShutdownOperation): Promise<void> {
    try {
      await this.deps.applyShutdown();
    } catch (error) {
      if (this.operation === operation) {
        this.operation = null;
        this.deps.admission.release(operation.transitionId);
        this.publish('idle', null, null, []);
      }
      throw error;
    }
    this.publish('shutdown-applied', null, operation.transitionId, []);
  }

  private async dispatchSwitchReady(operation: SwitchOperation): Promise<void> {
    if (operation.callbackStarted) return;
    operation.callbackStarted = true;
    await this.deps.onSwitchReady(operation.state);
  }

  private async readCensus(): Promise<{ blockers: ActiveWorkBlocker[]; blockerCount: number }> {
    const census = await this.deps.census();
    if (census.profileId !== this.deps.profileId) {
      throw new Error(
        `Active-work census belongs to ${census.profileId}, not active profile ${this.deps.profileId}`
      );
    }
    const blockers = census.blockers.map((blocker) => normalizeBlocker(blocker)).filter((blocker) => blocker.count > 0);
    return { blockers, blockerCount: blockers.reduce((sum, blocker) => sum + blocker.count, 0) };
  }

  private newSwitchState(
    transitionId: string,
    targetProfileId: string,
    phase: DeferredSwitchPhase,
    verifiedIdleAt?: number
  ): DeferredProfileSwitch {
    return {
      version: PROFILE_LIFECYCLE_STATE_VERSION,
      transitionId,
      sourceProfileId: this.deps.profileId,
      targetProfileId,
      phase,
      requestedAt: this.now(),
      ...(verifiedIdleAt === undefined ? {} : { verifiedIdleAt })
    };
  }

  private nextId(): string {
    const id = this.idFactory().trim();
    if (!id || id.length > 160) throw new Error('Profile lifecycle transition id must be 1–160 characters');
    return id;
  }

  private makeStatus(
    phase: ProfileLifecyclePhase,
    targetProfileId: string | null,
    transitionId: string | null,
    blockers: readonly ActiveWorkBlocker[]
  ): ProfileLifecycleStatus {
    const copied = blockers.map((blocker) => ({ ...blocker }));
    return {
      profileId: this.deps.profileId,
      phase,
      targetProfileId,
      transitionId,
      blockers: copied,
      blockerCount: copied.reduce((sum, blocker) => sum + blocker.count, 0),
      admission: this.deps.admission.snapshot()
    };
  }

  private publish(
    phase: ProfileLifecyclePhase,
    targetProfileId: string | null,
    transitionId: string | null,
    blockers: readonly ActiveWorkBlocker[]
  ): void {
    this.status = this.makeStatus(phase, targetProfileId, transitionId, blockers);
    this.deps.onStatusChange?.(this.getStatus());
  }
}

function normalizeProfileId(value: string): string {
  const id = value.trim();
  if (!PROFILE_ID.test(id)) throw new Error('Target profile id is invalid');
  return id;
}

function normalizeBlocker(blocker: ActiveWorkBlocker): ActiveWorkBlocker {
  const category = blocker.category.trim();
  if (!category) throw new Error('Active-work blocker category is required');
  if (!Number.isSafeInteger(blocker.count) || blocker.count < 0) {
    throw new Error(`Active-work blocker ${category} has an invalid count`);
  }
  return {
    category,
    count: blocker.count,
    ...(blocker.detail === undefined ? {} : { detail: blocker.detail })
  };
}

function parseDeferredSwitch(value: unknown): DeferredProfileSwitch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Deferred profile switch state is malformed');
  }
  const row = value as Record<string, unknown>;
  const phase = row['phase'];
  const verifiedIdleAt = row['verifiedIdleAt'];
  if (
    row['version'] !== PROFILE_LIFECYCLE_STATE_VERSION ||
    typeof row['transitionId'] !== 'string' || !row['transitionId'] || row['transitionId'].length > 160 ||
    typeof row['sourceProfileId'] !== 'string' || !PROFILE_ID.test(row['sourceProfileId']) ||
    typeof row['targetProfileId'] !== 'string' || !PROFILE_ID.test(row['targetProfileId']) ||
    (phase !== 'draining' && phase !== 'ready') ||
    typeof row['requestedAt'] !== 'number' || !Number.isFinite(row['requestedAt']) || row['requestedAt'] < 0 ||
    (verifiedIdleAt !== undefined && (typeof verifiedIdleAt !== 'number' || !Number.isFinite(verifiedIdleAt) || verifiedIdleAt < 0)) ||
    (phase === 'ready' && typeof verifiedIdleAt !== 'number')
  ) {
    throw new Error('Deferred profile switch state is malformed');
  }
  return {
    version: PROFILE_LIFECYCLE_STATE_VERSION,
    transitionId: row['transitionId'],
    sourceProfileId: row['sourceProfileId'],
    targetProfileId: row['targetProfileId'],
    phase,
    requestedAt: row['requestedAt'],
    ...(verifiedIdleAt === undefined ? {} : { verifiedIdleAt })
  };
}

function cloneStatus(status: ProfileLifecycleStatus): ProfileLifecycleStatus {
  return {
    ...status,
    blockers: status.blockers.map((blocker) => ({ ...blocker })),
    admission: { ...status.admission }
  };
}

/**
 * Process-local admission fence for profile lifecycle transitions.
 *
 * The gate answers one narrow question: may a caller create a new root piece of work? Existing
 * durable/claimed work deliberately does not pass through this API, so it can continue settling
 * while a Drain is active.
 */

export const NEW_WORK_KINDS = ['message', 'worker', 'continuation', 'handoff'] as const;
export type NewWorkKind = (typeof NEW_WORK_KINDS)[number];
export type WorkAdmissionMode = 'open' | 'draining' | 'finalizing';

export interface WorkAdmissionSnapshot {
  mode: WorkAdmissionMode;
  owner: string | null;
  reason: string | null;
  generation: number;
}

export interface WorkAdmissionDecision extends WorkAdmissionSnapshot {
  kind: NewWorkKind;
  allowed: boolean;
}

export class WorkAdmissionGate {
  private mode: WorkAdmissionMode = 'open';
  private owner: string | null = null;
  private reason: string | null = null;
  private generation = 0;

  snapshot(): WorkAdmissionSnapshot {
    return {
      mode: this.mode,
      owner: this.owner,
      reason: this.reason,
      generation: this.generation
    };
  }

  decideNew(kind: NewWorkKind): WorkAdmissionDecision {
    return {
      ...this.snapshot(),
      kind,
      allowed: this.mode === 'open'
    };
  }

  beginDrain(owner: string, reason = 'waiting for existing work to settle'): WorkAdmissionSnapshot {
    return this.claim(owner, 'draining', reason);
  }

  /** A short final handoff fence used once work is already verified idle. */
  beginFinalization(owner: string, reason = 'finalizing a lifecycle transition'): WorkAdmissionSnapshot {
    return this.claim(owner, 'finalizing', reason);
  }

  promoteToFinalization(owner: string, reason = 'finalizing a lifecycle transition'): WorkAdmissionSnapshot {
    if (this.owner !== owner || this.mode === 'open') {
      throw new Error('Work admission finalization must be owned by the active lifecycle transition');
    }
    if (this.mode !== 'finalizing' || this.reason !== reason) {
      this.mode = 'finalizing';
      this.reason = reason;
      this.generation += 1;
    }
    return this.snapshot();
  }

  release(owner: string): boolean {
    if (this.owner !== owner) return false;
    this.mode = 'open';
    this.owner = null;
    this.reason = null;
    this.generation += 1;
    return true;
  }

  private claim(owner: string, mode: Exclude<WorkAdmissionMode, 'open'>, reason: string): WorkAdmissionSnapshot {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) throw new Error('Work admission owner is required');
    if (this.owner && this.owner !== normalizedOwner) {
      throw new Error(`Work admission is already owned by ${this.owner}`);
    }
    if (this.mode !== mode || this.owner !== normalizedOwner || this.reason !== reason) {
      this.mode = mode;
      this.owner = normalizedOwner;
      this.reason = reason;
      this.generation += 1;
    }
    return this.snapshot();
  }
}

/** One process-lifetime gate shared by all root-work owners. */
export const profileWorkAdmission = new WorkAdmissionGate();

export function assertNewWorkAllowed(kind: NewWorkKind): void {
  const decision = profileWorkAdmission.decideNew(kind);
  if (decision.allowed) return;
  const reason = decision.reason ? ` (${decision.reason})` : '';
  throw new Error(`Luna Forge X7 is ${decision.mode}; new ${kind} work is paused${reason}. Existing work is still finishing.`);
}

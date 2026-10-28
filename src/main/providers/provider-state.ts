/**
 * Durable provider/session identity and submission receipts.
 *
 * The critical boundary is `beginProviderSubmission`: it commits intent before a provider
 * transport may write the prompt. If the process dies before acceptance, that durable row is
 * ambiguous by design and is never eligible for automatic replay. Liveness can be recovered by
 * inspecting/resuming the native conversation later; duplicate submission cannot be recovered.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PROVIDER_IDS,
  type ProviderFailureKind,
  type ProviderId,
  type ProviderTerminalResult,
  type ProviderWorkState
} from '../../shared/provider-adapter.js';
import { readDurableStrict, writeDurableNow } from '../durable.js';
import { logInfo, logWarn } from '../logger.js';

export const PROVIDER_SESSIONS_STATE = 'provider-sessions';
const SCHEMA_VERSION = 1 as const;

export type ProviderResumableState = 'new' | 'resumable' | 'recovery required' | 'blocked';
export type ProviderSubmissionPhase = 'submitting' | 'accepted';

export interface ProviderMessageReceipt {
  messageId: string;
  /** SHA-256 of canonical content; the durable provider ledger does not duplicate authored text. */
  fingerprint: string;
  acceptedAt: number;
}

export interface ProviderPendingTurn {
  turnId: string;
  messageId: string;
  fingerprint: string;
  phase: ProviderSubmissionPhase;
  submittedAt: number;
  acceptedAt: number | null;
}

export interface ProviderTerminalReceipt {
  turnId: string;
  recordedAt: number;
  providerStatus: string;
  outcome: ProviderTerminalResult['outcome'];
  responseFingerprint: string;
  failureKind: ProviderFailureKind | null;
  retryable: boolean;
  retryAfterMs: number | null;
}

export interface DurableProviderSession {
  localSessionId: string;
  providerId: ProviderId;
  nativeConversationId: string | null;
  selectedModel: string;
  lastAcceptedMessage: ProviderMessageReceipt | null;
  lastTerminalEvent: ProviderTerminalReceipt | null;
  /** Every terminal turn id remains fenced for this session; turnId is the durable idempotency key. */
  terminalTurns: Record<string, ProviderTerminalReceipt>;
  resumableState: ProviderResumableState;
  pendingTurn: ProviderPendingTurn | null;
  updatedAt: number;
}

interface ProviderSessionsSnapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  sessions: Record<string, DurableProviderSession>;
}

export interface ProviderRecoveryDisposition {
  state: Extract<ProviderWorkState, 'recovering' | 'blocked' | 'completed'>;
  autoResubmit: false;
  reason: string;
}

export class ProviderRecoveryRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRecoveryRequiredError';
  }
}

const messageReceiptSchema = z.object({
  messageId: z.string().min(1).max(512),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  acceptedAt: z.number().int().nonnegative()
});

const pendingTurnSchema = z.object({
  turnId: z.string().min(1).max(512),
  messageId: z.string().min(1).max(512),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['submitting', 'accepted']),
  submittedAt: z.number().int().nonnegative(),
  acceptedAt: z.number().int().nonnegative().nullable()
});

const terminalReceiptSchema = z.object({
  turnId: z.string().min(1).max(512),
  recordedAt: z.number().int().nonnegative(),
  providerStatus: z.string().max(160),
  outcome: z.enum(['completed', 'blocked', 'failed', 'cancelled']),
  responseFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  failureKind: z.enum([
    'rate_limited',
    'transient',
    'authentication',
    'permission',
    'unknown_model',
    'malformed_input',
    'protocol',
    'startup_timeout',
    'cancelled',
    'unavailable',
    'provider'
  ]).nullable(),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().nullable()
});

const sessionSchema = z.object({
  localSessionId: z.string().min(1).max(512),
  providerId: z.enum(PROVIDER_IDS),
  nativeConversationId: z.string().min(1).max(1024).nullable(),
  selectedModel: z.string().min(1).max(512),
  lastAcceptedMessage: messageReceiptSchema.nullable(),
  lastTerminalEvent: terminalReceiptSchema.nullable(),
  terminalTurns: z.record(z.string(), terminalReceiptSchema).optional().default({}),
  resumableState: z.enum(['new', 'resumable', 'recovery required', 'blocked']),
  pendingTurn: pendingTurnSchema.nullable(),
  updatedAt: z.number().int().nonnegative()
});

const snapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sessions: z.record(z.string(), sessionSchema)
});

let snapshot: ProviderSessionsSnapshot = { schemaVersion: SCHEMA_VERSION, sessions: {} };
let restored = false;
let mutationQueue: Promise<void> = Promise.resolve();

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cloneSession(session: DurableProviderSession): DurableProviderSession {
  return structuredClone(session);
}

function cleanSnapshot(raw: unknown): ProviderSessionsSnapshot {
  if (raw === null || raw === undefined) {
    return { schemaVersion: SCHEMA_VERSION, sessions: {} };
  }
  const parsed = snapshotSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logWarn('provider session state was malformed; refusing restore to preserve idempotency evidence');
  throw new Error('Provider session state is malformed; restore refused to preserve idempotency evidence');
}

function requireRestored(): void {
  if (!restored) throw new Error('Provider session state has not been restored');
}

function validateIdentity(value: string, label: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 512) throw new Error(`${label} must be between 1 and 512 characters`);
  return clean;
}

function requireSession(localSessionId: string): DurableProviderSession {
  requireRestored();
  const session = snapshot.sessions[localSessionId];
  if (!session) throw new Error(`Provider session ${localSessionId} is not registered`);
  return session;
}

async function mutate(
  update: (current: ProviderSessionsSnapshot) => ProviderSessionsSnapshot
): Promise<void> {
  requireRestored();
  const operation = mutationQueue.then(async () => {
    const next = update(snapshot);
    if (next === snapshot) return;
    await writeDurableNow(PROVIDER_SESSIONS_STATE, next);
    snapshot = next;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function restoreProviderSessions(): Promise<void> {
  const raw = await readDurableStrict<unknown>(PROVIDER_SESSIONS_STATE);
  snapshot = cleanSnapshot(raw);
  restored = true;
  const interrupted = Object.values(snapshot.sessions).filter(session => session.pendingTurn !== null).length;
  logInfo(`provider state restored (${Object.keys(snapshot.sessions).length} session(s), ${interrupted} recovery-required turn(s))`);
}

export function getProviderSession(localSessionId: string): DurableProviderSession | null {
  requireRestored();
  const session = snapshot.sessions[localSessionId];
  return session ? cloneSession(session) : null;
}

export function snapshotProviderSessions(): ProviderSessionsSnapshot {
  requireRestored();
  return structuredClone(snapshot);
}

export async function registerProviderSession(input: {
  localSessionId: string;
  providerId: ProviderId;
  selectedModel: string;
  nativeConversationId?: string | null;
  now?: number;
}): Promise<DurableProviderSession> {
  const localSessionId = validateIdentity(input.localSessionId, 'localSessionId');
  const selectedModel = validateIdentity(input.selectedModel, 'selectedModel');
  const nativeConversationId = input.nativeConversationId?.trim() || null;
  const now = input.now ?? Date.now();
  await mutate(current => {
    const existing = current.sessions[localSessionId];
    if (existing) {
      if (existing.providerId !== input.providerId || existing.selectedModel !== selectedModel) {
        throw new Error(
          `Provider session ${localSessionId} is already pinned to ${existing.providerId}/${existing.selectedModel}`
        );
      }
      if (nativeConversationId && existing.nativeConversationId && nativeConversationId !== existing.nativeConversationId) {
        throw new Error(`Provider session ${localSessionId} is already bound to another native conversation`);
      }
      if (!nativeConversationId || existing.nativeConversationId === nativeConversationId) return current;
      return {
        ...current,
        sessions: {
          ...current.sessions,
          [localSessionId]: { ...existing, nativeConversationId, resumableState: 'resumable', updatedAt: now }
        }
      };
    }
    const created: DurableProviderSession = {
      localSessionId,
      providerId: input.providerId,
      nativeConversationId,
      selectedModel,
      lastAcceptedMessage: null,
      lastTerminalEvent: null,
      terminalTurns: {},
      resumableState: nativeConversationId ? 'resumable' : 'new',
      pendingTurn: null,
      updatedAt: now
    };
    return { ...current, sessions: { ...current.sessions, [localSessionId]: created } };
  });
  return cloneSession(requireSession(localSessionId));
}

export async function recordProviderConversationId(
  localSessionId: string,
  nativeConversationId: string,
  now = Date.now()
): Promise<void> {
  const id = validateIdentity(nativeConversationId, 'nativeConversationId');
  await mutate(current => {
    const session = current.sessions[localSessionId];
    if (!session) throw new Error(`Provider session ${localSessionId} is not registered`);
    if (session.nativeConversationId === id) return current;
    if (session.nativeConversationId) {
      throw new Error(`Provider session ${localSessionId} changed native conversation identity`);
    }
    return {
      ...current,
      sessions: {
        ...current.sessions,
        [localSessionId]: {
          ...session,
          nativeConversationId: id,
          resumableState: session.resumableState === 'new' ? 'resumable' : session.resumableState,
          updatedAt: now
        }
      }
    };
  });
}

/**
 * Durable submission barrier. The caller may write to provider stdin only after this resolves.
 */
export async function beginProviderSubmission(input: {
  localSessionId: string;
  turnId: string;
  messageId: string;
  content: string;
  now?: number;
}): Promise<ProviderPendingTurn> {
  const turnId = validateIdentity(input.turnId, 'turnId');
  const messageId = validateIdentity(input.messageId, 'messageId');
  const contentFingerprint = fingerprint(input.content);
  const now = input.now ?? Date.now();
  await mutate(current => {
    const session = current.sessions[input.localSessionId];
    if (!session) throw new Error(`Provider session ${input.localSessionId} is not registered`);
    if (session.resumableState === 'blocked' || session.lastTerminalEvent?.outcome === 'blocked') {
      throw new ProviderRecoveryRequiredError(
        session.lastTerminalEvent
          ? `Provider session ${input.localSessionId} is blocked by turn ${session.lastTerminalEvent.turnId} (${session.lastTerminalEvent.providerStatus}); inspect or reconcile it before submitting another turn`
          : `Provider session ${input.localSessionId} is blocked and must be reconciled before submitting another turn`
      );
    }
    const pending = session.pendingTurn;
    if (pending) {
      if (
        pending.turnId === turnId &&
        pending.messageId === messageId &&
        pending.fingerprint === contentFingerprint
      ) {
        throw new ProviderRecoveryRequiredError(
          `Provider turn ${turnId} already crossed the durable submission barrier; inspect or resume it instead of submitting again`
        );
      }
      throw new ProviderRecoveryRequiredError(
        `Provider session ${input.localSessionId} already has recovery-required turn ${pending.turnId}`
      );
    }
    if (session.terminalTurns[turnId] || session.lastTerminalEvent?.turnId === turnId) {
      throw new ProviderRecoveryRequiredError(
        `Provider turn ${turnId} already has a durable terminal receipt and cannot be submitted again`
      );
    }
    const nextPending: ProviderPendingTurn = {
      turnId,
      messageId,
      fingerprint: contentFingerprint,
      phase: 'submitting',
      submittedAt: now,
      acceptedAt: null
    };
    return {
      ...current,
      sessions: {
        ...current.sessions,
        [input.localSessionId]: {
          ...session,
          pendingTurn: nextPending,
          resumableState: 'recovery required',
          updatedAt: now
        }
      }
    };
  });
  return cloneSession(requireSession(input.localSessionId)).pendingTurn!;
}

export async function markProviderTurnAccepted(
  localSessionId: string,
  turnId: string,
  now = Date.now()
): Promise<void> {
  await mutate(current => {
    const session = current.sessions[localSessionId];
    if (!session) throw new Error(`Provider session ${localSessionId} is not registered`);
    const pending = session.pendingTurn;
    if (!pending || pending.turnId !== turnId) {
      if (session.lastTerminalEvent?.turnId === turnId) return current;
      throw new Error(`Provider turn ${turnId} is not the pending turn for ${localSessionId}`);
    }
    if (pending.phase === 'accepted') return current;
    const accepted: ProviderMessageReceipt = {
      messageId: pending.messageId,
      fingerprint: pending.fingerprint,
      acceptedAt: now
    };
    return {
      ...current,
      sessions: {
        ...current.sessions,
        [localSessionId]: {
          ...session,
          lastAcceptedMessage: accepted,
          pendingTurn: { ...pending, phase: 'accepted', acceptedAt: now },
          resumableState: 'recovery required',
          updatedAt: now
        }
      }
    };
  });
}

function terminalReceipt(turnId: string, result: ProviderTerminalResult, now: number): ProviderTerminalReceipt {
  return {
    turnId,
    recordedAt: now,
    providerStatus: result.providerStatus,
    outcome: result.outcome,
    responseFingerprint: fingerprint(result.response),
    failureKind: result.failure?.kind ?? null,
    retryable: result.failure?.advice.retryable ?? false,
    retryAfterMs: result.failure?.advice.retryAfterMs ?? null
  };
}

function sameTerminal(a: ProviderTerminalReceipt, b: ProviderTerminalReceipt): boolean {
  return a.turnId === b.turnId &&
    a.providerStatus === b.providerStatus &&
    a.outcome === b.outcome &&
    a.responseFingerprint === b.responseFingerprint &&
    a.failureKind === b.failureKind;
}

export async function markProviderTurnTerminal(
  localSessionId: string,
  turnId: string,
  result: ProviderTerminalResult,
  options: { accepted?: boolean; now?: number } = {}
): Promise<void> {
  const now = options.now ?? Date.now();
  await mutate(current => {
    const session = current.sessions[localSessionId];
    if (!session) throw new Error(`Provider session ${localSessionId} is not registered`);
    if (result.providerId !== session.providerId) {
      throw new Error(
        `Provider result ${turnId} belongs to ${result.providerId}, not pinned provider ${session.providerId}`
      );
    }
    if (
      result.nativeConversationId &&
      session.nativeConversationId &&
      result.nativeConversationId !== session.nativeConversationId
    ) {
      throw new Error(`Provider result ${turnId} changed native conversation identity`);
    }
    const receipt = terminalReceipt(turnId, result, now);
    if (!session.pendingTurn) {
      const priorReceipt = session.terminalTurns[turnId] ??
        (session.lastTerminalEvent?.turnId === turnId ? session.lastTerminalEvent : null);
      if (priorReceipt && sameTerminal(priorReceipt, receipt)) return current;
      throw new Error(`Provider turn ${turnId} has no pending submission for ${localSessionId}`);
    }
    if (session.pendingTurn.turnId !== turnId) {
      throw new Error(`Provider result ${turnId} conflicts with pending turn ${session.pendingTurn.turnId}`);
    }
    const accepted = options.accepted === true || session.pendingTurn.phase === 'accepted';
    const lastAcceptedMessage = accepted
      ? session.lastAcceptedMessage?.messageId === session.pendingTurn.messageId
        ? session.lastAcceptedMessage
        : {
            messageId: session.pendingTurn.messageId,
            fingerprint: session.pendingTurn.fingerprint,
            acceptedAt: session.pendingTurn.acceptedAt ?? now
          }
      : session.lastAcceptedMessage;
    const nativeConversationId = result.nativeConversationId ?? session.nativeConversationId;
    const resumableState: ProviderResumableState = result.outcome === 'blocked'
      ? 'blocked'
      : nativeConversationId
        ? 'resumable'
        : 'blocked';
    return {
      ...current,
      sessions: {
        ...current.sessions,
        [localSessionId]: {
          ...session,
          nativeConversationId,
          lastAcceptedMessage,
          lastTerminalEvent: receipt,
          terminalTurns: { ...session.terminalTurns, [turnId]: receipt },
          pendingTurn: null,
          resumableState,
          updatedAt: now
        }
      }
    };
  });
}

/**
 * Restart policy for the provider ledger. A pending turn is always ambiguous because the durable
 * intent is intentionally written before transport I/O; no caller may convert it into a retry.
 */
export function providerRecoveryDisposition(localSessionId: string): ProviderRecoveryDisposition {
  const session = requireSession(localSessionId);
  if (session.pendingTurn) {
    const accepted = session.pendingTurn.phase === 'accepted';
    return {
      state: 'blocked',
      autoResubmit: false,
      reason: accepted
        ? `Turn ${session.pendingTurn.turnId} was accepted but has no durable terminal result; resume/inspect the native conversation`
        : `Turn ${session.pendingTurn.turnId} crossed the submission barrier without durable acceptance; delivery is ambiguous`
    };
  }
  if (session.lastTerminalEvent?.outcome === 'blocked' || session.resumableState === 'blocked') {
    return {
      state: 'blocked',
      autoResubmit: false,
      reason: session.lastTerminalEvent
        ? `Turn ${session.lastTerminalEvent.turnId} ended ${session.lastTerminalEvent.providerStatus}; inspect or reconcile the provider session before continuing`
        : 'The provider session is blocked and requires inspection before continuing'
    };
  }
  if (session.nativeConversationId) {
    return {
      state: 'completed',
      autoResubmit: false,
      reason: 'No turn is pending and the native conversation can be resumed for a new turn'
    };
  }
  return {
    state: 'recovering',
    autoResubmit: false,
    reason: 'No native conversation has been established yet'
  };
}

/** Test seam only. Durable bytes are owned/reset by durable.ts separately. */
export function resetProviderSessionsForTests(): void {
  snapshot = { schemaVersion: SCHEMA_VERSION, sessions: {} };
  restored = false;
  mutationQueue = Promise.resolve();
}

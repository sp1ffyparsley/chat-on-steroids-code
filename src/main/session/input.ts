import { operatorPromptBody, prepareOperatorPrompt, assertOperatorPromptEnvelope, operatorPromptOverhead } from '../../shared/operator-prompt.mjs';
import { workflowStepSchema, workflowReceiptSchema, workflowBlocker, type WorkflowReceipt } from '../../shared/workflow.mjs';
import { REASONING_EFFORTS, workSequence } from '../../shared/session.js';
/** User-authored input has one durable owner across browser and MCP delivery.
 * A claimed browser send is never automatically retried: losing the ACK is ambiguous.
 * A live tool offer may be acknowledged by a later exact call; after Main reconstruction the
 * offer itself is ambiguous and is retained as attention instead of being injected a second time.
 */
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { browserInputModel, MAX_BROWSER_DECISION_RESPONSE_CHARS, type InputImage } from '../../shared/input.js';
import type { SessionSummary, SessionEvent } from '../../shared/session.js';
import { getConfig } from '../config.js';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { userTitle } from './title.js';
import { durableStoreReady, readDurableStrict, writeDurableNow, writeDurableSoon } from '../durable.js';
import { getSession, findSessionByConversation, createSession, conversationWasSuperseded, readRecentEvents, readLatestUserMessage, listUsageSessions, turnHasMcpCall, sessionDirectoryMissing } from './store.js';
import { assignSessionProject, getProject, projectWorkspace, getSessionProject } from '../projects.js';
import { isChatBlocked } from './blocked-chats.js';
import { wakeBrowserWork } from '../browser-wake.js';
import { logInfo, logWarn } from '../logger.js';
import { noteChatOrigin } from './recorder.js';
import { isAstraModel, isProModel } from '../../shared/chat-models.js';
import { inFlightToolCalls } from '../mcp/call-context.js';
import { automaticFinishEnabled, confirmDeliveredGoalReplyNow, consumeGoalReplyForInputNow, deliberateStoppedLoopResumeFor, goalArmedFor, goalSwitchFor, goalObjectiveFor, goalPendingReplyFor, goalDraftBusy, goalBrowserHelperRunActive, snapshotGoalReplies, snapshotGoalSwitches } from '../goal.js';
import { classifyProviderRecoveryFailure } from './recovery-failure.js';
import { continuationForSession, committedResumeNativeReceipt } from './continuation.js';
import { finishInstruction } from '../../shared/finish.js';
import { CONVERSATION_DELETED, NATIVE_PROMPT_ENVELOPE_REFUSAL } from '../../shared/goal-errors.js';
import { attachmentSchema, validateInputAttachments, normalizeInputAttachments } from './input-attachments.js';
import { validateInputImages } from './input-images.js';
import { MAX_CHATGPT_MESSAGE_CHARS } from '../../shared/user-prompt.js';
import type { PromptLimits } from './prompt.js';
import { assertNewWorkAllowed, profileWorkAdmission } from '../work-admission.js';
import { backgroundExecObligations } from '../codex/ownership.js';
import { rotationMessage } from '../../shared/recovery.js';
import { automationRotationAdmits } from '../automation-rotation.js';
import { MAX_AUTOMATION_OBJECTIVE_CHARS } from '../../shared/goal.js';

const browserDecisionProtocolError = z.enum(['invalid_goal_decision_json', 'invalid_goal_decision_schema',
  'empty_reply', 'control_tokens_only', 'unsafe_control_tokens', 'reply_too_long', 'goal_content_reference_unresolved',
  'goal_canonical_scope_changed', 'goal_human_history_changed', 'goal_plan_changed',
  'goal_original_acceptance_unverified', 'native_completion_unverified', 'loop_stop_refused']);

export const inputArgs = z.object({
  /** Authored recipe metadata; scheduling and delivery remain in this serialized owner. */
  workflow: workflowStepSchema.optional(),
  /** Local label for a newly created main chat; provider titles remain secondary metadata. */
  nickname: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/u).optional(),
  projectId: z.string().uuid().nullable().optional(),
  automation: z.enum(['off', 'goal', 'loop']).optional(),
  /** Explicit finite app-opened chat. Only the operator one-off path may mint this marker. */
  finiteOneOff: z.literal(true).optional(),
  loopAfterTurn: z.boolean().optional(),
  objective: z.string().trim().max(MAX_AUTOMATION_OBJECTIVE_CHARS).optional(),
  stages: z.array(z.string().trim().min(1).max(16000)).max(11).optional(),
  images: z.array(z.object({ name: z.string().min(1).max(110), dataUrl: z.string().max(512100).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/) })).max(4).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  attachmentDelivery: z.literal('tool').optional(),
  id: z.string().uuid(),
  sessionId: z.string().min(8).max(64).nullable(),
  text: z.string().trim().min(1).max(MAX_CHATGPT_MESSAGE_CHARS),
  mode: z.enum(['auto', 'after-turn', 'finish']),
  afterTurn: z.boolean().optional(),
  dueAt: z.number().int().nonnegative(),
  model: z.string().max(80).nullable(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable(),
  /** Model-driven routing cannot borrow the human composer's permission to wake an Off chat. */
  route: z.object({ sourceSessionId: z.string().min(8).max(64), targetConversationId: z.string().min(8).max(256) }).optional(),
  /** App-derived identity for one account-scoped operator request. UUID and schedule are not identity. */
  operatorRequestKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Exact terminal rows that authorize one deliberate confirmed-pre-Send replacement. */
  operatorRetryOf: z.array(z.string().uuid()).max(50)
    .refine(ids => new Set(ids).size === ids.length, 'Operator retry evidence contains duplicate ids')
    .optional()
});
export type InputArgs = z.infer<typeof inputArgs>;
type OperatorSemanticInput = Pick<InputArgs,
  'sessionId' | 'projectId' | 'text' | 'objective' | 'automation' | 'finiteOneOff' | 'loopAfterTurn' |
  'mode' | 'afterTurn' | 'model' | 'reasoningEffort' | 'stages' | 'images' | 'attachments' |
  'attachmentDelivery'> & { requestedMode?: InputArgs['mode']; workflow?: InputArgs['workflow'] };

/** Ordinary human messages remain usable with Goal Off. Cross-chat model routes do not. */
export function sessionRouteTargetAllowed(conversationId: string): boolean {
  const target = goalSwitchFor(conversationId);
  return getConfig().ui.automationPaused !== true && (!target.own || target.enabled);
}
function routedInputAllowed(entry: Pick<InputArgs, 'route'> & { conversationId?: string | null }): boolean {
  return !entry.route || ((!entry.conversationId || entry.conversationId === entry.route.targetConversationId) &&
    sessionRouteTargetAllowed(entry.route.targetConversationId));
}


/**
 * Stable semantic identity for native operator admission.
 *
 * The transient UUID, nickname and due time deliberately do not participate: reminting an id,
 * changing presentation metadata or asking for the same work at another time must not bypass the
 * app-owned duplicate fence. Existing-chat selectors have already resolved to the durable local
 * session before this key is computed.
 */
export function operatorInputSemanticKey(input: OperatorSemanticInput): string {
  const semantic = {
    version: 2,
    ...(input.workflow ? { workflow: input.workflow } : {}),
    sessionId: input.sessionId,
    projectId: input.projectId ?? null,
    text: operatorPromptBody(input.text).trim(),
    objective: input.objective ?? null,
    automation: input.automation ?? null,
    finiteOneOff: input.finiteOneOff === true,
    loopAfterTurn: input.loopAfterTurn ?? null,
    mode: input.requestedMode ?? input.mode,
    afterTurn: input.afterTurn ?? null,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    stages: input.stages ?? null,
    images: input.images ?? null,
    attachments: input.attachments ?? null,
    attachmentDelivery: input.attachmentDelivery ?? null
  };
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}
const entrySchema = inputArgs.extend({
  workflowReceipt: workflowReceiptSchema.optional(),
  workflowValidationHistory: z.array(workflowReceiptSchema).max(8).optional(),
  /** Frozen transport diagnostics, not another context-selection authority. */
  preparedContext: z.object({ authoredChars: z.number().int().nonnegative(),
    deliveredChars: z.number().int().nonnegative(),
    skillBodySha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(64) }).optional(),
  /** Frozen image projection; authored attachment IDs remain the replay identity. */
  toolImages: inputArgs.shape.images,
  /** One after-turn pickup earned by confirmed silence or settled Thinking failed. */
  silenceBoundary: z.object({ turnId: z.string().min(1).max(256), conversationId: z.string().min(1).max(256), workSeq: z.number().int().nonnegative(), acceptedAt: z.number().nonnegative().optional(), listenUntil: z.number().nonnegative().optional(), nativeBusy: z.boolean().optional() }).optional(),
  /** Shared unfinished-response fallback belongs to this exact native question. */
  recovery: z.object({ questionId: z.string(), episode: z.string().max(200).optional(), pro: z.boolean(), busyUntil: z.number(), phase: z.enum(['ready', 'stopping', 'reloading', 'resumed']), reloadOwner: z.string().optional() }).optional(),
  /** Exact tool-free turn this explicit browser correction may interrupt. */
  directTurn: z.object({ id: z.string().min(1).max(256), startedAt: z.number() }).optional(),
  finishOwner: z.object({ turnId: z.string().min(1).max(256), periodic: z.boolean(), userRequested: z.boolean().optional() }).optional(),
  requestedMode: z.enum(['auto', 'after-turn', 'finish']).optional(),
  transportIntent: z.enum(['tool', 'browser']).optional(),
  text: z.string().min(1).max(240000),
  deliveryText: z.string().min(1).max(240000).optional(),
  /** One checkpoint shares this browser send and its receipt with the user's correction. */
  companionInputId: z.string().uuid().optional(),
  purpose: z.enum(['user', 'decision', 'rotation']).optional(),
  /** Original fresh-turn boundary; never retarget a restored automatic continuation. */
  queuedTurn: z.object({ conversationId: z.string().min(1).max(256), turnId: z.string().min(1).max(256) }).optional(),
  /** Release fresh-turn attempt custody only after positive source-boundary retirement. */
  rotationRetiredAt: z.number().nonnegative().optional(),
  lifetime: z.literal('temporary-planner').optional(),
  decisionSourceSessionId: z.string().min(8).max(64).optional(),
  /** Exact source turn requiring this helper decision; survives private answer redaction. */
  decisionSourceTurnId: z.string().min(1).max(256).optional(),
  /** One Goal continuation committed atomically beside its accepted helper; never the helper's private answer. */
  sourceHelperId: z.string().uuid().optional(),
  /** Exact Goal pickup accepted beside this outgoing row, not reconstructed from an older helper. */
  sourceHelperAcceptedAt: z.number().int().positive().optional(),
  /** Stable identity for the continuation handoff after Goal acceptance. Same owner as this row. */
  continuationId: z.string().uuid().optional(),
  /** An accepted Goal stop is an exact private-answer-free terminal receipt, even without a native final. */
  goalStopDisposition: z.object({
    sessionId: z.string().min(8).max(64),
    conversationId: z.string().min(8).max(256),
    sourceTurnId: z.string().min(1).max(256),
    /** Retire only the exact original pickup episode, not a later human On. */
    sourceAcceptedAt: z.number().int().positive()
  }).optional(),
  /** Main's protocol owner rejected this exact completed decision; browser failure text cannot mint it. */
  goalDecisionRejection: browserDecisionProtocolError.optional(),
  /** Input proved the source obsolete while retaining this helper's confirmed native Send receipt. */
  goalSourceSuperseded: z.literal(true).optional(),
  response: z.string().max(MAX_BROWSER_DECISION_RESPONSE_CHARS).optional(),
  /** Local output archive receipt only; never a native Send or execution receipt. */
  decisionOutput: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() }).optional(),
  state: z.enum(['queued', 'browser', 'tool', 'sent', 'cancelled', 'failed', 'decision']),
  /** Main restarted after this exact tool-result offer but before a later-call receipt proved delivery. */
  toolReceiptUncertain: z.boolean().optional(),
  offeredAt: z.number().optional(),
  sendAuthorizedAt: z.number().optional(),
  requiresAuthorization: z.boolean().optional(),
  /** Positive pre-Send releases of this exact UUID. Bounded retries never mint a new message. */
  preSendReoffers: z.number().int().nonnegative().optional(),
  /** First failed recovery custody boundary. Diagnostic evidence only; it never grants retry authority. */
  recoveryFailure: z.object({
    phase: z.enum(['pre_send_preparation', 'native_send_ambiguous', 'receipt_missing', 'provider_recovery_unknown'] as const),
    retrySafe: z.boolean(),
    detail: z.string().max(300)
  }).optional(),
  /**
   * One bounded custody chain for this outbox UUID. This is an audit trail on the existing
   * input owner, not a second recovery state store. It records transitions already decided by
   * input.ts so recovery consumers do not infer phases from a final row shape.
   */
  recoveryChainId: z.string().uuid().optional(),
  recoveryTransitions: z.array(z.object({
    at: z.number().nonnegative(),
    from: z.string().max(80),
    to: z.string().max(80),
    phase: z.enum(['pre_send_preparation', 'native_send_ambiguous', 'receipt_missing', 'provider_recovery_unknown'] as const),
    reason: z.string().max(200)
  })).max(32).optional(),
  /** First exact pre-Send withdrawal in the current automatic recovery episode. */
  recoveryWithdrawnSince: z.number().nonnegative().optional(),
  /** Bounded pre-Send withdrawals in that same exact recovery episode. */
  recoveryWithdrawAttempts: z.number().int().nonnegative().optional(),
  error: z.string().max(200).optional(),
  owner: z.string().nullable(),
  createdAt: z.number(),
  conversationId: z.string().nullable(),
  deliveredSessionId: z.string().min(8).max(64).nullable().optional(),
  messageId: z.string().min(1).max(256).optional(),
  deliveredAt: z.number().optional(),
  stagesApplied: z.boolean().optional(),
  historyRecorded: z.boolean().optional(),
  /** Canonical history already carries authoredText for this outbox projection. */
  historyProjectionVersion: z.literal(1).optional(),
  /** Projection bookkeeping only; canonical native provenance remains the authority. */
  historyProvenanceRecorded: z.literal(true).optional(),
  historyProvenancePending: z.literal(true).optional(),
  /** Consume-once association of this exact Sent question with its settled native answer. */
  acceptedNativeFinal: z.object({ replyId: z.string().uuid(), acceptedAt: z.number().nonnegative() }).optional(),
  completedTurnId: z.string().max(256).optional(),
  /** Explicit Send admitted behind this chat's existing browser-owned delivery. */
  queuedBehindDelivery: z.boolean().optional(),
  /** Explicit Send admitted behind a different chat's current browser composer owner. */
  queuedBehindBrowser: z.boolean().optional(),
  /** This unclaimed global browser head yielded so other chats could proceed. */
  deliveryAttentionAt: z.number().optional(),
  /** When this row most recently became the global browser head. */
  browserEligibleAt: z.number().optional(),
  /** Durable proof that the strict operator cancellation won before every delivery owner. */
  operatorCancelledAt: z.number().nonnegative().optional(),
  /** Exact headless Retry invocation that atomically consumed the browser-attention fence. */
  operatorRetryReceipt: z.string().uuid().optional(),
  queueOrder: z.number().int().nonnegative().optional()
});
export type InputEntry = z.infer<typeof entrySchema>;

/** Account-local, read-only custody for the source chat's private Temporary Chat decisions.
 * No planner prompt, response, route, browser owner, or arbitrary provider error is published. */
export interface SessionDecisionHelperCustody {
  sessionId: string;
  conversationId: string;
  pendingOriginalReply: { replyId: string; sourceTurnId: string; acceptedAt: number } | null;
  retainedTotal: number;
  truncated: boolean;
  helpers: Array<{
    id: string;
    sourceTurnId: string | null;
    createdAt: number;
    state: InputEntry['state'];
    phase: 'awaiting-native-send' | 'native-send-unresolved' | 'awaiting-answer' | 'answer-accepted' |
      'answer-rejected' | 'cancelled-before-native-send' | 'failed-before-native-send' | 'cancelled-after-native-delivery' |
      'failed-after-native-delivery' | 'unresolved-cancellation';
    nativeSend: 'not-confirmed' | 'unresolved' | 'confirmed';
    nativeMessageId: string | null;
    sendAuthorizedAt: number | null;
    deliveredAt: number | null;
    answer: 'not-recorded' | 'accepted' | 'rejected';
    rejection: InputEntry['goalDecisionRejection'] | null;
    sourceSuperseded: boolean;
    continuation: {
      id: string;
      state: InputEntry['state'];
      nativeSend: 'not-confirmed' | 'unresolved' | 'confirmed';
      nativeMessageId: string | null;
      deliveredAt: number | null;
    } | null;
  }>;
}
const STATE = 'session-input';

/** Used by every consumer, including the final browser authorization boundary. */
export function workflowInputReady(row: InputEntry, rows: readonly InputEntry[]): boolean {
  return !row.workflow || (getConfig().ui.automationPaused !== true && workflowBlocker(row, rows) === null);
}

/** Immutable completion receipt on the existing serialized outbox, never a Send/result substitute. */
export function publishWorkflowReceipt(source: InputEntry, raw: WorkflowReceipt): Promise<boolean> {
  return serial(async () => {
    const receipt = workflowReceiptSchema.parse(raw);
    const current = await load();
    const row = current.find(item => item.id === source.id);
    if (!row?.workflow || row.workflowReceipt || row.state !== 'sent' || getConfig().ui.automationPaused === true ||
        row.acceptedNativeFinal?.replyId !== receipt.replyId ||
        JSON.stringify(row.workflow) !== JSON.stringify(source.workflow) ||
        JSON.stringify(row.acceptedNativeFinal) !== JSON.stringify(source.acceptedNativeFinal) ||
        receipt.checks.length !== row.workflow.checks.length ||
        receipt.checks.some((check, index) => check.kind !== row.workflow!.checks[index]!.kind) ||
        (receipt.status === 'verified') !== receipt.checks.every(check => check.ok)) return false;
    await commit(current.map(item => item === row ? { ...item, workflowReceipt: receipt } : item));
    return true;
  });
}

/** Explicit read-only revalidation never changes the original Send/final receipt or reexecutes tools. */
export function recheckWorkflowInput(source: InputEntry): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(item => item.id === source.id);
    if (!row?.workflow || row.state !== 'sent' || row.workflowReceipt?.status !== 'failed' ||
        getConfig().ui.automationPaused === true ||
        JSON.stringify(row.workflowReceipt) !== JSON.stringify(source.workflowReceipt) ||
        row.acceptedNativeFinal?.replyId !== source.acceptedNativeFinal?.replyId) return false;
    await commit(current.map(item => item === row ? { ...row, workflowReceipt: undefined,
      workflowValidationHistory: [...row.workflowValidationHistory ?? [], row.workflowReceipt!].slice(-8) } : item));
    logInfo(`workflow: explicit output recheck input=${row.id}; original delivery retained`);
    return true;
  });
}
const TOOL_INPUT_TEXT_BYTES = 128000;
/** A native Send never retries. This only bounds how long an ambiguous receipt blocks new input. */
export const BROWSER_RECEIPT_WAIT_MS = 120_000;
/** An ownerless browser row this old was never picked up. A newer explicit message in the same
 * chat may replace it without risking a duplicate send. Fresh rows retain normal queue order. */
const UNCLAIMED_BROWSER_REPLACEMENT_MS = 120_000;
/** One unclaimed chat may yield its global composer slot without losing its durable message. */
export const UNCLAIMED_BROWSER_ATTENTION_MS = 15 * 60_000;
/**
 * Browser decision helpers are real Temporary Chats, but one global slot made unrelated Loop
 * chats fail into synchronized 15/30/60-second retries behind a single slow helper. Keep the
 * upstream bounded parallelism: enough for the normal four-chat work cycle, still far below the
 * worker/chat limits and still covered by the shared provider-throttle fence below.
 */
const MAX_ACTIVE_BROWSER_HELPERS = 4;
/** Brief shared advisory backoff; the page's exact Goal claim retries after this expires. */
export const CHATGPT_HELPER_THROTTLE_MS = 12_000;
/** A browser that positively proves it never attempted native Send may re-offer this same UUID.
 * Two reoffers absorb ordinary picker/Core/editor remounts without turning a broken composer
 * into an unbounded claim/fail loop. The third positive failure is retained for attention. */
const MAX_PRE_SEND_REOFFERS = 2;
const PRE_SEND_REOFFER_DELAYS_MS = [1_500, 5_000] as const;
/**
 * Keep one positively pre-Send Goal continuation and its accepted helper through a deliberate
 * per-chat Off long enough for the user to resume it without minting another helper or UUID.
 *
 * This is custody only, never delivery authority. The ordinary source/session/turn, current
 * question, tool, Goal and explicit-activation checks still run before the row can be rearmed.
 * The bound mirrors the durable Goal-reply horizon so an abandoned Off cannot pin private helper
 * history indefinitely inside the active outbox.
 */
const SOURCE_HELPER_RETRY_CUSTODY_MS = 12 * 60 * 60_000;
const LEGACY_EXHAUSTED_PRE_SEND_ERROR = /^Needs attention: browser preparation failed \d+ times before native Send\. The exact message is saved and was not sent\.$/;
let browserHelperBackoffUntil = 0;
/** Projection of Bridge's positive native auth evidence, never a timer-based login guess. */
let browserDecisionSignedOut = false;
/** Process-local positive login witness; never infer sign-in from a restart or absence of evidence. */
let browserDecisionSignedInObserved = false;

type RecoveryTransitionPhase = 'pre_send_preparation' | 'native_send_ambiguous' | 'receipt_missing' | 'provider_recovery_unknown';

function addRecoveryTransition<T extends Pick<InputEntry, 'id' | 'state'>>(row: T, phase: RecoveryTransitionPhase, reason: string, to: string): Partial<InputEntry> {
  const previous = row.state;
  const current = (row as Partial<InputEntry>).recoveryTransitions ?? [];
  return {
    recoveryChainId: (row as Partial<InputEntry>).recoveryChainId ?? randomUUID(),
    recoveryTransitions: [
      ...current,
      {
        at: Date.now(),
        from: previous,
        to,
        phase,
        reason: reason.slice(0, 200)
      }
    ].slice(-32)
  };
}

/**
 * Continuation admission reads the same custody chain that produced the recovery decision.
 * A confirmed-unsent recovery may continue. A Send boundary without a receipt stays fenced.
 * This is an observation of the existing outbox, not a new recovery owner.
 */
export function recoveryContinuationEligibility(row: Readonly<InputEntry>): {
  allowed: boolean;
  reason: 'confirmed_unsent' | 'confirmed_receipt' | 'ambiguous_send' | 'missing_receipt' | 'no_recovery';
  recoveryChainId?: string;
  phase?: RecoveryTransitionPhase;
} {
  const phase = row.recoveryTransitions?.at(-1)?.phase ?? row.recoveryFailure?.phase;
  if (!phase) return { allowed: true, reason: 'no_recovery' };
  // This exact helper can recover before Send and later receive the native ACK.
  // Historical diagnostic phases must not veto a newer receipt from its current
  // owner. completeBrowserDecision still verifies the waiter and source boundary.
  if (row.purpose === 'decision' && row.owner && row.deliveredAt !== undefined &&
      (row.state === 'decision' || row.state === 'sent')) {
    return { allowed: true, reason: 'confirmed_receipt', recoveryChainId: row.recoveryChainId, phase };
  }
  if (phase === 'pre_send_preparation' && row.sendAuthorizedAt === undefined &&
      row.messageId === undefined && row.deliveredAt === undefined) {
    return { allowed: true, reason: 'confirmed_unsent', recoveryChainId: row.recoveryChainId, phase };
  }
  if (phase === 'native_send_ambiguous') {
    return { allowed: false, reason: 'ambiguous_send', recoveryChainId: row.recoveryChainId, phase };
  }
  return { allowed: false, reason: 'missing_receipt', recoveryChainId: row.recoveryChainId, phase };
}

/**
 * Bounded continuation custody evidence. This is deliberately derived from the existing
 * outbox row instead of creating another continuation/recovery ledger. It lets the handoff
 * boundary explain admission without exposing authored text or private helper output.
 */
export function continuationCustodyDiagnostics(row: Readonly<InputEntry>): {
  inputId: string;
  recoveryChainId?: string;
  ownershipPhase: string;
  receiptState: 'confirmed' | 'ambiguous' | 'missing';
} {
  return {
    inputId: row.id,
    recoveryChainId: row.recoveryChainId,
    ownershipPhase: row.sendAuthorizedAt !== undefined ? 'send-authorized'
      : row.offeredAt !== undefined || row.owner !== null ? 'browser-claimed'
        : 'queued',
    receiptState: row.messageId !== undefined || row.deliveredAt !== undefined ? 'confirmed'
      : row.sendAuthorizedAt !== undefined ? 'ambiguous' : 'missing'
  };
}

/**
 * Runtime observation point for the continuation boundary. This is intentionally a projection
 * of the existing outbox row: admission, browser ownership and native receipt remain owned by
 * input/bridge. It does not create a continuation state machine or persist a second ledger.
 */
export function continuationLifecycleDiagnostics(row: Readonly<InputEntry>): {
  inputId: string;
  continuationId?: string;
  recoveryChainId?: string;
  continuationState: 'admitted_waiting_claim' | 'claimed_waiting_native_proof' |
    'native_send_unresolved' | 'completed_with_receipt';
  owner: string | null;
  ownerProven: boolean;
  receiptState: 'confirmed' | 'ambiguous' | 'missing';
} {
  const receiptState = row.messageId !== undefined || row.deliveredAt !== undefined
    ? 'confirmed' as const
    : row.sendAuthorizedAt !== undefined
      ? 'ambiguous' as const
      : 'missing' as const;
  return {
    inputId: row.id,
    continuationId: row.continuationId,
    recoveryChainId: row.recoveryChainId,
    continuationState: receiptState === 'confirmed'
      ? 'completed_with_receipt'
      : row.sendAuthorizedAt !== undefined
        ? 'native_send_unresolved'
        : row.owner !== null || row.state === 'browser'
          ? 'claimed_waiting_native_proof'
          : 'admitted_waiting_claim',
    owner: row.owner,
    // A phase claiming browser ownership must carry the same durable owner field used by the
    // existing claim path. This keeps diagnostics from presenting a claimed phase based only on
    // a browser-shaped row state after restart reconstruction.
    ownerProven: row.owner !== null && row.owner !== undefined,
    receiptState
  };
}

/**
 * Bridge-safe projection of the continuation handoff. The browser already owns the Send
 * operation; this projection lets the existing claim/ack boundary expose whether the durable
 * row still carries enough evidence to reconstruct the handoff without exposing message text.
 */
export function continuationTransportDiagnostics(row: Readonly<InputEntry>): {
  inputId: string;
  continuationId?: string;
  recoveryChainId?: string;
  ownerIdentity: string | null;
  ownerProven: boolean;
  sendAuthorized: boolean;
  receiptState: 'confirmed' | 'ambiguous' | 'missing';
} {
  const lifecycle = continuationLifecycleDiagnostics(row);
  return {
    inputId: lifecycle.inputId,
    continuationId: lifecycle.continuationId,
    recoveryChainId: lifecycle.recoveryChainId,
    ownerIdentity: lifecycle.owner,
    ownerProven: lifecycle.ownerProven,
    sendAuthorized: row.sendAuthorizedAt !== undefined,
    receiptState: lifecycle.receiptState
  };
}

export const TOOL_INPUT_HEADER = '\n--- New instructions from the user ---\n';
export interface ToolInputBatch {
  messages: Array<{ text: string; images: InputImage[] }>;
  /** One transport instruction after the complete batch, including its images. */
  reminder: string;
}
export interface InputActivity { possible: boolean; exact: boolean; model?: 'pro' | 'other' | 'unknown'; turnId?: string }
type InputDeliveryHooks = {
  /** Optional opt-in Loop forward proof, evaluated INSIDE this owner's transaction.
   * null preserves strict/unrelated delivery; false defers; the closure rechecks physical/source
   * custody after later awaits, without recursively entering this Input owner. Never a
   * tool-completion or replay receipt. */
  settledTurnForwardReadiness?: (entry: Readonly<InputEntry>, rows: readonly InputEntry[], phase?: 'collect') => Promise<(() => boolean | Promise<boolean>) | false | null>;
  /** Shared bridge decision for whether running calls still hold automatic recovery. */
  callsHoldRecovery?: (conversationId: string) => boolean;
  activity?: (session: SessionSummary) => InputActivity;
  wakeDecision?: (entry: Readonly<InputEntry>, signal: AbortSignal) => Promise<void>;
  bindHelper?: (conversationId: string, sourceSessionId: string | null) => Promise<void>;
  recordDelivered?: (entry: Readonly<InputEntry>) => Promise<boolean>;
  prepareText?: (entry: Readonly<InputEntry>, limits: PromptLimits, authored?: Readonly<Pick<InputEntry, 'text' | 'objective'>>,
    inputOwnerRows?: readonly InputEntry[]) => string | Promise<string>;
  /** CoS40 read-only task-version fence INSIDE the incumbent serialized Input
   * owner, before native Send authorization. No retry, receipt or new sender. */
  beforeAuthorizeNativeScope?: (entry: Readonly<InputEntry>, inputOwnerRows: readonly InputEntry[]) => Promise<boolean>;
  applyAutomation: (conversationId: string, automation: NonNullable<InputArgs['automation']>, phase: 'before-send' | 'after-send', objective?: string, loopAfterTurn?: boolean, foreground?: boolean) => Promise<void>;
  changed: () => void;
};
let deliveryHooks: InputDeliveryHooks | null = null;
/** Installed once by IPC before bridge/MCP startup; avoids a Goal/input import cycle. */
export function configureInputDelivery(hooks: InputDeliveryHooks): void { deliveryHooks = hooks; }
/** Test seam: production installs the IPC hooks once for the process lifetime. */
export function resetInputDeliveryForTests(): void { deliveryHooks = null; }
function callsHoldRecovery(conversationId: string): boolean {
  return deliveryHooks?.callsHoldRecovery ? deliveryHooks.callsHoldRecovery(conversationId) : inFlightToolCalls(conversationId) > 0;
}
/** One delivery policy for composer presentation, admission and the final send fence. */
export async function sessionInputPolicy(sessionId: string, observedActivity?: InputActivity): Promise<{ queueAtFinish: boolean; canInject: boolean; injectionTurnId: string | null; directTurn: InputEntry['directTurn'] | null; browserAllowed: boolean; manualBrowserProbe?: boolean; stoppedIdle?: boolean; settled: boolean }> {
  const [end] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  const session = await getSession(sessionId);
  if (!session?.conversationId || isChatBlocked(session.conversationId)) return { queueAtFinish: false, canInject: false, injectionTurnId: null, directTurn: null, browserAllowed: false, settled: false };
  const activity = observedActivity ?? deliveryHooks?.activity?.(session) ?? { possible: !!session.activeTurnId, exact: !!session.activeTurnId };
  const stopped = session.finishTurn?.released === true;
  const selection = session.selectedModel?.conversationId === session.conversationId ? session.selectedModel : null;
  // For a proven non-Pro turn, ChatGPT accepts native steering even while its
  // command runs (#1231/#1235). Retain the exact outbox claim and native receipt;
  // Pro, unproven models and explicit image injection keep their tool ownership.
  const directTurn = !stopped && activity.exact && end?.kind === 'turn_start' &&
    !!end.turnId && end.turnId === session.activeTurnId && !!selection?.model &&
    activity.model !== 'pro' && activity.model !== 'unknown' &&
    !isProModel(selection.model, selection.reasoningEffort)
    ? { id: end.turnId, startedAt: end.time } : null;
  const canInject = !stopped && activity.exact && !directTurn;
  // The bridge's retained exact MCP grant can outlive a native UI end. Project
  // that same turn for image custody, never invent an active recorder turn.
  const injectionTurnId = canInject ? session.activeTurnId ?? (activity.turnId === end?.turnId ? activity.turnId ?? null : null) : null;
  const astra = session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
    session.selectedModel?.conversationId === session.conversationId && isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort);
  const terminal = end?.kind === 'turn_end' && !!end.turnId && end.outcome !== 'unknown';
  const settled = terminal && ((end.outcome === 'completed' && !activity.possible && !activity.exact) ||
    (end.outcome === 'failed' && end.reason === 'thinking_failed'));
  const executing = inFlightToolCalls(session.conversationId) > 0;
  // An abandoned recorder identity is not a running MCP consumer. This grants only
  // an idle-only browser inspection for a new, explicit plain-text instruction;
  // it is NOT a terminal event, automatic continuation or permission to interrupt.
  const manualProbeCandidate = !stopped && !!session.activeTurnId &&
    !activity.exact && !executing && !!selection?.model &&
    !isProModel(selection.model, selection.reasoningEffort) &&
    end?.kind === 'turn_start' && end.turnId === session.activeTurnId &&
    (session.lastToolCallAt ?? 0) < end.time;
  // A recorded terminal boundary can coexist with a stale possible-only observer. A fresh
  // ordinary human message may ask the SAME native idle inspection in this case; it gains
  // no direct-turn/Stop authority and unresolved call/process custody remains a veto below.
  const endedManualProbe = !stopped && !session.activeTurnId && !activity.exact && !executing &&
    activity.possible && activity.model !== 'pro' && !!selection?.model &&
    !isProModel(selection.model, selection.reasoningEffort) && end?.kind === 'turn_end' &&
    ['completed', 'stalled', 'failed'].includes(end.outcome) && !!end.turnId &&
    Number.isFinite(end.time) && end.time <= Date.now() && (session.lastToolCallAt ?? 0) <= end.time;
  let manualBrowserProbe = endedManualProbe || manualProbeCandidate && !activity.possible;
  if (manualProbeCandidate && activity.possible && activity.model !== 'pro') {
    // A possible-only heartbeat can survive the exact turn's watchdog failure.
    // It must not strand an untouched HUMAN instruction on a dead MCP route.
    // This is permission to inspect the native idle state, never a turn end,
    // tool completion, steering grant, or automatic Goal/Loop continuation.
    const [fault] = await readRecentEvents(sessionId, 1, { kinds: ['chat_error'] });
    manualBrowserProbe = fault?.kind === 'chat_error' && fault.reason === 'watchdog_stalled' &&
      fault.turnId === session.activeTurnId && Number.isFinite(fault.time) &&
      fault.time >= (end?.time ?? Infinity) && fault.time <= Date.now();
  }
  return { canInject, injectionTurnId, directTurn, queueAtFinish: astra && canInject && getConfig().ui.finishTool === true,
    browserAllowed: !session.activeTurnId && !activity.possible && !activity.exact && !executing && (!astra || terminal),
    // Upstream d3856ca6: a genuine instruction typed after a confirmed Stop does
    // not wait for the old possible-only activity window. Generated work keeps
    // its original source/result/authorization gates below.
    stoppedIdle: !session.activeTurnId && terminal && end.outcome === 'stopped' && !activity.exact && !executing,
    ...(manualBrowserProbe ? { manualBrowserProbe: true } : {}),
    settled: settled && !executing && (session.lastToolCallAt ?? 0) <= end.time };
}
async function manualIdleBrowserProbeAllowed(entry: InputEntry,
  policy: Awaited<ReturnType<typeof sessionInputPolicy>>): Promise<boolean> {
  if (!policy.manualBrowserProbe || !manualInput(entry) || entry.mode !== 'auto' ||
      !entry.sessionId || !entry.conversationId || entry.sourceHelperId || entry.finishOwner ||
      entry.afterTurn || entry.queuedBehindDelivery || entry.queuedTurn || entry.stages?.length ||
      entry.images?.length || entry.toolImages?.length || entry.attachments?.length ||
      entry.sendAuthorizedAt !== undefined || entry.deliveredAt !== undefined || entry.messageId !== undefined ||
      entry.deliveryAttentionAt !== undefined || entry.error !== undefined || entry.recoveryFailure !== undefined ||
      entry.recoveryTransitions?.length || entry.toolReceiptUncertain || entry.companionInputId ||
      entry.completedTurnId || entry.directTurn || entry.silenceBoundary || entry.recovery ||
      (entry.state !== 'queued' && entry.state !== 'browser') ||
      (entry.state === 'queued' && (entry.owner !== null || entry.offeredAt !== undefined || entry.requiresAuthorization !== undefined)) ||
      (entry.state === 'browser' && (entry.transportIntent === 'tool' || !entry.owner || entry.requiresAuthorization !== true)) ||
      callsHoldRecovery(entry.conversationId)) return false;
  const session = await getSession(entry.sessionId);
  if (!session || session.conversationId !== entry.conversationId) return false;
  if (session.activeTurnId) {
    if (await turnHasMcpCall(session.id, entry.conversationId, session.activeTurnId)) return false;
  } else {
    const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    if (end?.kind !== 'turn_end' || !end.turnId || !['completed', 'stalled', 'failed'].includes(end.outcome) ||
        !Number.isFinite(end.time) || end.time > entry.createdAt || (session.lastToolCallAt ?? 0) > end.time) return false;
  }
  if (!(await sessionInputPolicy(entry.sessionId)).manualBrowserProbe) return false;
  const fresh = await getSession(entry.sessionId);
  return fresh?.conversationId === entry.conversationId && fresh.activeTurnId === session.activeTurnId &&
    fresh.selectedModel?.conversationId === session.selectedModel?.conversationId &&
    fresh.selectedModel?.model === session.selectedModel?.model &&
    fresh.selectedModel?.reasoningEffort === session.selectedModel?.reasoningEffort &&
    (fresh.lastToolCallAt ?? 0) === (session.lastToolCallAt ?? 0) &&
    !callsHoldRecovery(entry.conversationId);
}
/**
 * A user-authored plain-text correction can be queued for the current MCP grant and then lose
 * that route when the owning provider turn durably ends as `stalled`. Release only that exact,
 * never-offered row to the native composer after every live-work and delivery-receipt fence is
 * clear. Generated/staged work and any prior browser or tool custody keep their original owner.
 */
async function stalledManualToolFallbackAllowed(
  entry: InputEntry,
  policy: Awaited<ReturnType<typeof sessionInputPolicy>>
): Promise<boolean> {
  if (!policy.browserAllowed || entry.transportIntent !== 'tool' || entry.mode !== 'auto' ||
      !manualInput(entry) || !entry.sessionId || !entry.conversationId || entry.sourceHelperId ||
      entry.stages?.length || entry.images?.length || entry.toolImages?.length || entry.attachments?.length ||
      entry.state !== 'queued' || entry.owner !== null || entry.offeredAt !== undefined ||
      entry.sendAuthorizedAt !== undefined || entry.deliveredAt !== undefined || entry.messageId !== undefined ||
      entry.requiresAuthorization !== undefined || entry.deliveryAttentionAt !== undefined || entry.error !== undefined ||
      entry.recoveryFailure !== undefined || entry.recoveryTransitions?.length || entry.toolReceiptUncertain === true ||
      entry.companionInputId !== undefined || entry.completedTurnId !== undefined || entry.directTurn !== undefined ||
      entry.silenceBoundary !== undefined || entry.recovery !== undefined) return false;
  const session = await getSession(entry.sessionId);
  if (!session || session.conversationId !== entry.conversationId || session.activeTurnId ||
      callsHoldRecovery(entry.conversationId)) return false;
  const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  return end?.kind === 'turn_end' && end.outcome === 'stalled' && !!end.turnId &&
    Number.isFinite(end.time) && end.time >= entry.createdAt &&
    (session.lastToolCallAt ?? 0) <= end.time;
}
async function browserInputAllowed(entry: InputEntry): Promise<boolean> {
  if (entry.workflow && entry.sessionId) {
    const session = await getSession(entry.sessionId);
    if (session?.conversationId && goalArmedFor(session.conversationId)) return false;
  }
  if (!routedInputAllowed(entry)) return false;
  if (browserDecisionSignedOut) return false;
  if (entry.purpose === 'decision' && getConfig().ui.automationPaused) return false;
  if (entry.purpose === 'rotation' && (!entry.sessionId || !entry.conversationId || !entry.directTurn ||
      !await rotationSourceCurrent(entry.sessionId, entry.conversationId, entry.directTurn.id,
        entry.state === 'browser' ? entry.offeredAt : undefined))) return false;
  if (entry.attachmentDelivery === 'tool') return false;
  // A generated Goal continuation may have been saved just before the user
  // disabled that mode. Its durable existence is not fresh Send permission.
  if (entry.sourceHelperId && (!entry.conversationId || !goalArmedFor(entry.conversationId))) {
    noteInputContinuationHold(entry, 'automation_not_armed'); return false;
  }
  if (entry.recovery?.episode?.startsWith('interruption:')) return interruptedInputCurrent(entry);
  if (!manualInput(entry)) {
    const rotationConversation = entry.conversationId ?? (entry.sessionId ? (await getSession(entry.sessionId))?.conversationId : null);
    if (rotationConversation && !automationRotationAdmits(rotationConversation)) return false;
  }
  if (entry.mode === 'finish' && entry.sessionId && entry.afterTurn !== true) {
    const session = await getSession(entry.sessionId);
    const selection = session?.selectedModel;
    if (selection?.conversationId === session?.conversationId && isAstraModel(selection?.model, selection?.reasoningEffort)) return false;
  }
  if (!entry.sessionId) return entry.transportIntent !== 'tool';
  // Silence can leave the recorder's original turn open. Its durable ticket
  // proves the exact unchanged work; the native page must still be idle for Send.
  if (entry.silenceBoundary) return await eligibleStageEnd(entry) === entry.silenceBoundary.turnId;
  const policy = await sessionInputPolicy(entry.sessionId);
  if (await manualIdleBrowserProbeAllowed(entry, policy)) return true;
  if (entry.completedTurnId && (entry.sourceHelperId
    ? await sourceHelperContinuationTurn(entry)
    : await eligibleStageEnd(entry)) !== entry.completedTurnId) return false;
  if (entry.directTurn) {
    const session = await getSession(entry.sessionId);
    if (!session || session.conversationId !== entry.conversationId) return false;
    if (session.activeTurnId) return policy.directTurn?.id === entry.directTurn.id;
    const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    return (policy.browserAllowed || typedAfterStop(entry, policy)) && end?.kind === 'turn_end' && end.turnId === entry.directTurn.id;
  }
  // Only a never-offered ordinary input may change routes after positive terminal evidence.
  // A tool handout or ambiguous browser claim retains its original exclusive custody.
  if (entry.sourceHelperId && !policy.browserAllowed) {
    const session = await getSession(entry.sessionId);
    const activity = session ? deliveryHooks?.activity?.(session) : undefined;
    const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    noteInputContinuationHold(entry, `browser_policy active=${Boolean(session?.activeTurnId)} possible=${activity?.possible === true} exact=${activity?.exact === true} executing=${inFlightToolCalls(entry.conversationId ?? '') > 0} terminal=${end?.kind === 'turn_end' && end.outcome !== 'unknown'}`);
  }
  return (policy.browserAllowed || typedAfterStop(entry, policy)) && (entry.transportIntent !== 'tool' ||
    (entry.mode === 'auto' && !entry.finishOwner && entry.purpose !== 'decision' && entry.state === 'queued' &&
      entry.owner === null && entry.offeredAt === undefined &&
      (policy.settled || await stalledManualToolFallbackAllowed(entry, policy))));
}
/** The native page still proves idle and Send; this is never a helper/recovery grant. */
function typedAfterStop(entry: InputEntry, policy: { stoppedIdle?: boolean }): boolean {
  return policy.stoppedIdle === true && manualInput(entry) && !entry.sourceHelperId && !entry.recovery;
}
const inputListeners = new Set<() => void>();
/** Last recovery-release reason logged per exact ticket; repeated page offers stay visible, not noisy. */
const recoveryReleaseTold = new Map<string, string>();
/** Shape-only diagnosis in the existing bounded ticket log; never changes eligibility. */
export function noteInputContinuationHold(entry: Readonly<Pick<InputEntry, 'id' | 'sourceHelperId' | 'purpose'>>, reason: string): void {
  if (!entry.sourceHelperId && entry.purpose !== 'decision') return;
  // The outer source-boundary fallback must not reset the precise refusal on every poll.
  // Keep both channels in the same bounded diagnostics cache; neither grants delivery.
  const key = `continuation:${entry.id}:${reason === 'source_boundary' ? 'boundary' : 'reason'}`;
  if (recoveryReleaseTold.get(key) === reason) return;
  recoveryReleaseTold.set(key, reason);
  if (recoveryReleaseTold.size > 200)
    for (const old of [...recoveryReleaseTold.keys()].slice(0, 50)) recoveryReleaseTold.delete(old);
  logInfo(`input ${entry.id}: continuation held ${reason}; saved receipt retained, no Send authorized`);
}
export function onInputChange(listener: () => void): () => void {
  inputListeners.add(listener);
  return () => { inputListeners.delete(listener); };
}
/** Observation only: the kernel remains the sole tool-input consumer. */
export function hasEligibleToolInput(sessionId: string, finishBoundary = false): Promise<boolean> {
  return serial(async () => {
    const current = ordered(await load());
    if (current.some(row => row.sessionId === sessionId && row.state === 'browser')) return false;
    const head = current.find(row => !row.workflow && row.sessionId === sessionId && queuedFollowup(row) && ['queued', 'tool'].includes(row.state));
    for (const row of current) {
      if (row.workflow || row.sessionId !== sessionId || row.dueAt > Date.now() || !workflowInputReady(row, current)) continue;
      if (row.attachments?.length && row.attachmentDelivery !== 'tool') continue;
      if (row.mode === 'after-turn' || (row.mode === 'finish' && !finishBoundary)) continue;
      if (row.mode === 'finish' && row !== head) continue;
      if (row.state === 'tool') return true;
      if (row.state === 'queued') return row.mode === 'auto' || (finishBoundary && row.mode === 'finish');
    }
    return false;
  });
}
let entries: InputEntry[] | null = null;
let chain: Promise<unknown> = Promise.resolve();
const inputSerialContext = new AsyncLocalStorage<{ live: boolean }>();
let inputSerialOwner: { live: boolean } | null = null;
// A timestamp written before the claim commit cannot prove that its response was
// available. Restart discards this evidence and repeats the stable message id.
const offered = new Map<string, { at: number; requestId: string; startedAt: number; returnedText: string;
  nativeFinal?: { turnId: string; messageId: string; observedAt: number } }>();
const terminal = (row: InputEntry): boolean => ['sent', 'cancelled', 'failed'].includes(row.state);
const confirmedPreSendOperatorRetry = (row: InputEntry): boolean => row.state === 'failed' &&
  row.requiresAuthorization === true && row.sendAuthorizedAt === undefined &&
  row.deliveredAt === undefined && row.messageId === undefined;
const unofferedSourceHelperQueued = (row: InputEntry): boolean => row.state === 'queued' && row.owner === null &&
  row.offeredAt === undefined && row.sendAuthorizedAt === undefined && row.deliveredAt === undefined && row.messageId === undefined;
const pristineSourceHelperQueued = (row: InputEntry): boolean => unofferedSourceHelperQueued(row) &&
  row.preSendReoffers === undefined && row.recoveryWithdrawAttempts === undefined &&
  row.recoveryWithdrawnSince === undefined && row.requiresAuthorization === undefined;
/** The existing withdrawal owner positively reported no native click before exhausting its
 * bounded retries. Older builds cleared requiresAuthorization on that terminal path; retain
 * only its structured exhaustion receipt, never a generic error or an authorized outcome. */
function retainedSourceHelperPreSendRetry(row: InputEntry): boolean {
  if (row.state !== 'failed' || row.owner !== null || row.offeredAt !== undefined ||
      row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined || row.messageId !== undefined) return false;
  if (confirmedPreSendOperatorRetry(row) && (row.preSendReoffers ?? 0) > MAX_PRE_SEND_REOFFERS) return true;
  // Preparation failed before this child was ever offered to a document. Keep
  // its sole helper/UUID for the existing explicit Resume transaction; absence
  // of offer/authorization/ACK above is mandatory and never an automatic retry.
  if (row.sourceHelperId && /^(?:Native Input human authorship is unverified;|Native execution scope is incomplete;)/.test(row.error ?? ''))
    return true;
  const attempts = row.recoveryWithdrawAttempts ?? 0;
  const since = row.recoveryWithdrawnSince;
  const now = Date.now();
  return !!row.sourceHelperId && attempts > 0 && since !== undefined && since >= row.createdAt && since <= now &&
    (attempts > RECOVERY_WITHDRAW_REOFFER_DELAYS_MS.length || now - since >= RECOVERY_WITHDRAW_LIMIT_MS) &&
    /^Automatic Continue was not sent: (?:[a-z-]{1,40}|withdrawn before Send)$/.test(row.error ?? '');
}
function retainedSourceHelperFor(rows: InputEntry[], row: InputEntry): InputEntry | null {
  if (!row.sourceHelperId || row.sourceHelperAcceptedAt === undefined || !row.sessionId || !row.conversationId ||
      (!unofferedSourceHelperQueued(row) && !retainedSourceHelperPreSendRetry(row))) return null;
  const helper = rows.find(candidate => candidate.id === row.sourceHelperId);
  return helper?.purpose === 'decision' && helper.lifetime === 'temporary-planner' && helper.state === 'sent' &&
    helper.decisionSourceSessionId === row.sessionId && !!helper.decisionSourceTurnId ? helper : null;
}
/** Exact current pickup is already bounded by Goal's TTL. Crossing to a newer pickup epoch is
 * deliberate recovery custody. Previously attempted rows retain the bounded horizon; an untouched
 * queued row keeps its original instruction, subject to the same exact current-source proof. */
function sourceHelperRetryEpochEligible(previous: number, current: number, now = Date.now(), pristine = false): boolean {
  return previous === current || (previous < current && previous <= now + 5_000 &&
    (pristine || now - previous < SOURCE_HELPER_RETRY_CUSTODY_MS));
}
function sourceHelperCustodyIds(rows: InputEntry[], now = Date.now()): Set<string> {
  const replies = new Map(snapshotGoalReplies().replies.map(reply => [reply.conversationId, reply]));
  return new Set(rows.filter(row => {
    const helper = retainedSourceHelperFor(rows, row);
    if (!helper) return false;
    const owed = goalPendingReplyFor(row.conversationId!);
    const armed = goalArmedFor(row.conversationId!);
    const exactPending = armed && owed?.sessionId === row.sessionId &&
      owed.turnId === helper.decisionSourceTurnId && owed.acceptedAt === row.sourceHelperAcceptedAt;
    // A deliberate activation advances acceptedAt before the exact outbox row is rebound. Keep
    // that already-confirmed-unsent row storage-pinned across the small cross-ledger window (and
    // across a failed durable rebind), but do not make it executable: claim/start still require
    // exact epoch equality through sourceHelperContinuationTurn().
    const boundedReactivation = armed && owed?.sessionId === row.sessionId &&
      owed.turnId === helper.decisionSourceTurnId && row.sourceHelperAcceptedAt! < owed.acceptedAt &&
      sourceHelperRetryEpochEligible(row.sourceHelperAcceptedAt!, owed.acceptedAt, now, pristineSourceHelperQueued(row));
    // Off intentionally handles the Goal reply before its switch write returns. Keep the exact
    // already-confirmed-unsent pair only for the bounded reply horizon; a later Resume still has
    // to re-prove the unchanged source before this row can leave `failed`.
    const handled = !armed ? replies.get(row.conversationId!) : undefined;
    const boundedOff = handled?.state === 'handled' && handled.sessionId === row.sessionId &&
      handled.turnId === helper.decisionSourceTurnId && handled.acceptedAt === row.sourceHelperAcceptedAt &&
      row.sourceHelperAcceptedAt! <= now + 5_000 &&
      now - row.sourceHelperAcceptedAt! < SOURCE_HELPER_RETRY_CUSTODY_MS;
    return exactPending || boundedReactivation || boundedOff;
  }).map(row => row.id));
}
const preparable = (row: InputEntry): boolean => row.state === 'queued' ||
  (row.state === 'browser' && row.requiresAuthorization === true && row.sendAuthorizedAt === undefined);
const needsHistory = (row: InputEntry): boolean => row.purpose !== 'decision' &&
  (!row.historyRecorded || row.historyProvenancePending === true) &&
  ((row.state === 'tool' && Number.isFinite(row.offeredAt)) || ((row.state === 'sent' || row.state === 'cancelled') &&
    (!!row.messageId || (Number.isFinite(row.deliveredAt) && Date.now() - row.deliveredAt! < BROWSER_RECEIPT_WAIT_MS))));
const pendingStages = (row: InputEntry): boolean => row.state === 'sent' && !!row.stages?.length && !row.stagesApplied;
const ordered = (rows: InputEntry[]): InputEntry[] => [...rows].sort((a, b) =>
  (a.queueOrder ?? a.dueAt) - (b.queueOrder ?? b.dueAt) || a.createdAt - b.createdAt);
const SIMPLE_LOOP_WAKE = /^(?:continue|resume|go|keep going)[.!]*$/i;
// Native files convert Auto to after-turn for transport, but retain the user's
// immediate correction intent. They remain browser-only, never tool attachments.
const manualInput = (row: Pick<InputEntry, 'requestedMode' | 'mode' | 'finishOwner' | 'purpose' | 'attachmentDelivery'>): boolean => (row.requestedMode ?? row.mode) === 'auto' && !row.finishOwner && row.purpose !== 'decision' && row.purpose !== 'rotation' && row.attachmentDelivery !== 'tool';
/** Explicit composer messages remain deliverable while Goal/Loop automation is paused. */
export const userRequestedInput = (row: InputEntry): boolean => manualInput(row);
/** Ordinary non-Pro text stays native even when a retained MCP grant outlives turn_end (#1318). */
function composerOnlyText(entry: Pick<InputEntry, 'images' | 'attachments' | 'attachmentDelivery' | 'toolImages' | 'stages'> & Parameters<typeof manualInput>[0],
  session: SessionSummary | null | undefined): boolean {
  const selection = session?.selectedModel;
  if (!manualInput(entry) || entry.stages?.length || entry.images?.length || entry.attachments?.length || entry.toolImages?.length ||
      !session?.conversationId || selection?.conversationId !== session.conversationId || !selection.model ||
      isProModel(selection.model, selection.reasoningEffort)) return false;
  // A picker change cannot change the model owning an already-running generation.
  const activity = deliveryHooks?.activity?.(session);
  return activity?.model !== 'pro' && activity?.model !== 'unknown';
}
/** One global native-composer lane. Tool injection and per-chat after-turn work do not occupy it.
 * Once Chrome has claimed a direct message, that browser owner remains the head until it settles;
 * an older yielded row that the user revisits cannot preempt already-issued browser custody.
 */
const directBrowserHead = (rows: InputEntry[]): InputEntry | undefined => {
  const eligible = ordered(rows).filter(row => manualInput(row) && !queuedFollowup(row) &&
    workflowInputReady(row, rows) &&
    row.transportIntent !== 'tool' && row.deliveryAttentionAt === undefined &&
    ['queued', 'browser'].includes(row.state));
  return eligible.find(row => row.state === 'browser') ?? eligible[0];
};
const companionOf = (rows: InputEntry[], row: InputEntry): InputEntry | undefined => rows.find(root => root.companionInputId === row.id);
const sameDelivery = (root: InputEntry, row: InputEntry): boolean => row.id === root.id || row.id === root.companionInputId;

/**
 * A second explicit Send in the same chat waits for the first native turn by carrying
 * `queuedBehindDelivery`. If that first delivery is positively proven unsent, there will be no
 * turn boundary to release the follower. Promote only the oldest exact-session follower back to
 * its authored Auto semantics; ambiguous/post-Send outcomes keep the normal after-turn fence.
 */
function releaseSameChatFollowerAfterConfirmedUnsent(rows: InputEntry[], prior: InputEntry): { rows: InputEntry[]; releasedId: string | null } {
  if (!prior.sessionId || !manualInput(prior)) return { rows, releasedId: null };
  // Cancelling a parked follower must not jump over an earlier delivery that still owns this
  // session. Claimed/queued direct input and tool custody remain the release boundary; other
  // parked followers are only future work and do not block the oldest eligible promotion.
  if (rows.some(row => row.id !== prior.id && row.sessionId === prior.sessionId && manualInput(row) &&
      !terminal(row) && row.queuedBehindDelivery !== true)) return { rows, releasedId: null };
  const follower = ordered(rows).find(row => row.sessionId === prior.sessionId && row.state === 'queued' && row.owner === null &&
    row.queuedBehindDelivery === true && manualInput(row));
  if (!follower) return { rows, releasedId: null };
  // queueOrder is meaningful only inside the per-session after-turn FIFO. Carrying a small local
  // ordinal into the global browser FIFO would let this row jump older messages from other chats.
  let promoted: InputEntry = { ...follower, mode: follower.requestedMode ?? follower.mode,
    queuedBehindDelivery: undefined, queueOrder: undefined };
  let next = rows.map(row => row.id === follower.id ? promoted : row);
  const browserHead = directBrowserHead(next);
  promoted = { ...promoted, queuedBehindBrowser: browserHead?.id === promoted.id ? undefined : true };
  next = next.map(row => row.id === follower.id ? promoted : row);
  return { rows: next, releasedId: follower.id };
}
function combinedInput(root: InputEntry, companion?: InputEntry): InputEntry {
  if (!companion) return root;
  const images = inputArgs.shape.images.parse([...root.images ?? [], ...companion.images ?? []]);
  const attachments = inputArgs.shape.attachments.parse([...root.attachments ?? [], ...companion.attachments ?? []]);
  return { ...root, text: `${root.text}\n\nNext queued instruction:\n${companion.text}`,
    ...(images?.length ? { images } : {}), ...(attachments?.length ? { attachments } : {}) };
}

function serial<T>(work: () => Promise<T>): Promise<T> {
  const owned = () => {
    const owner = { live: true };
    return inputSerialContext.run(owner, async () => {
      inputSerialOwner = owner;
      try { return await work(); }
      finally { owner.live = false; if (inputSerialOwner === owner) inputSerialOwner = null; }
    });
  };
  const result = chain.then(owned, owned);
  chain = result.catch(() => undefined);
  return result;
}
async function load(): Promise<InputEntry[]> {
  // The input module is imported while Main is still selecting the account-specific runtime.
  // Refuse a premature read instead of treating the missing durable root as an empty outbox and
  // caching that false absence for the rest of the process.
  if (!durableStoreReady()) throw new Error('The durable message outbox is not initialized');
  if (entries) return expireQueued(entries);
  // This ledger prevents duplicate external sends, so transient read/parse failures are not
  // equivalent to an absent file. Only ENOENT may initialize an empty outbox.
  const raw = await readDurableStrict<unknown>(STATE);
  const parsed = z.array(entrySchema).safeParse(raw ?? []);
  if (!parsed.success) throw new Error('The message outbox could not be read safely');
  // Older append() versions could retain the same accepted STOP receipt both as
  // active Goal custody and in the last-50 history. Restore that *exact* UUID
  // once, before any claim/expiry/history side effect. Two distinct receipts
  // sharing an id are contradictory Send evidence: never choose one on behalf
  // of the browser or fabricate a confirmed-unsent retry.
  const unique = new Map<string, InputEntry>();
  for (const row of parsed.data) {
    const original = unique.get(row.id);
    if (original && JSON.stringify(original) !== JSON.stringify(row))
      throw new Error('The message outbox contains conflicting duplicate message identity');
    if (!original) unique.set(row.id, row);
  }
  if (unique.size !== parsed.data.length) {
    const restored = [...unique.values()];
    // Recovery is durable before the de-duplicated ledger becomes available
    // to claimants. Preserve the existing temporary-planner privacy boundary.
    await writeDurableNow(STATE, restored.map(row => row.lifetime === 'temporary-planner'
      ? { ...row, text: '[Temporary planner]', deliveryText: undefined, response: undefined }
      : row));
    entries = restored;
    logInfo(`input: recovered ${parsed.data.length - unique.size} byte-identical duplicate receipt(s) under their original UUIDs`);
  } else entries = parsed.data;
  try { await retireRemovedSessionReceipts(entries); }
  catch (error) { entries = null; throw error; }
  // Old receipts are recovery evidence, not a reason to replay every already-stamped
  // transcript before the sidebar appears. The existing catalog proves an origin is
  // durable; only missing/ambiguous rows need the normal origin repair path below.
  const stamped = new Set<string>();
  const seen = new Set<string>();
  if (entries.some(row => row.conversationId && (row.purpose === 'decision' || (!row.sessionId && row.deliveredAt !== undefined)))) {
    for (const summary of await listUsageSessions()) {
      if (!summary.conversationId) continue;
      if (seen.has(summary.conversationId)) stamped.delete(summary.conversationId);
      else if (summary.origin) stamped.add(summary.conversationId);
      seen.add(summary.conversationId);
    }
  }
  // Durable decision receipts recover helper provenance even when recording/ACK raced
  // or this version first opens a helper recorded before origins were stamped.
  for (const row of entries) {
    // Re-project wrapped receipts once when loading the outbox, so recordings made
    // before authoredText existed recover their original visible text too. This
    // is canonical history only; it never reopens transport or resends an input.
    if (row.historyRecorded && row.historyProjectionVersion !== 1 && row.deliveryText && row.deliveryText !== row.text)
      row.historyRecorded = false;
    // Older projections can retain full authored text without the origin/ACK
    // snapshot needed after bounded outbox trimming. Upgrade only a positively
    // owned native receipt; failed writes keep this row unprunable via needsHistory.
    if (row.historyRecorded && row.historyProvenanceRecorded !== true && row.purpose !== 'decision' &&
        ['sent', 'cancelled'].includes(row.state) && row.owner && row.conversationId &&
        (row.sessionId || row.deliveredSessionId) && row.messageId && !row.messageId.startsWith('input:') &&
        Number.isFinite(row.deliveredAt)) row.historyProvenancePending = true;
    if (!row.sessionId && row.purpose !== 'decision' && row.conversationId && row.deliveredAt !== undefined && !stamped.has(row.conversationId)) {
      await noteChatOrigin(row.conversationId, { kind: 'desktop', fromSessionId: null, agentId: null, task: '', nickname: row.nickname });
    }
    // A Temporary Chat is intentionally short-lived in Chrome, but ChatGPT can still assign
    // it a concrete /c/<id> route before the exact answer/close receipt lands. The recorder may
    // observe that route in the same window and create its durable history first. Stamp the
    // proven helper role for every decision receipt that has a conversation id; otherwise those
    // temporary planner records masquerade as top-level user chats until cleanup, making the
    // sidebar appear to add a new task on every Goal/Loop pass. An id-less temporary receipt
    // remains private and creates/stamps nothing.
    if (row.purpose === 'decision' && row.conversationId && !stamped.has(row.conversationId))
      await deliveryHooks?.bindHelper?.(row.conversationId, row.decisionSourceSessionId ?? null);
  }
  let restoredUnclaimed = 0;
  let restoredExhaustedPreSend = 0;
  let ambiguousToolOffers = 0;
  const recovered = entries.map((row): InputEntry => {
    // The preparation owner rejected these exact errors before its first
    // handout. Preserve the terminal row; only the existing deliberate
    // confirmed-pre-Send operator retry may reuse this known-unsent request.
    if (row.state === 'failed' && row.owner === null && userRequestedInput(row) &&
        row.requiresAuthorization === undefined && row.offeredAt === undefined &&
        row.sendAuthorizedAt === undefined && row.deliveredAt === undefined && row.messageId === undefined &&
        /^(?:Native Input human authorship is unverified;|Native execution scope is incomplete;)/.test(row.error ?? '')) {
      logInfo('input: retained known pre-offer scope refusal for explicit confirmed-pre-Send recovery; no automatic retry');
      return { ...row, requiresAuthorization: true };
    }
    // Builds before this recovery kept a one-minute pickup timer. Its exact terminal text is
    // positive evidence that no browser document ever claimed the row, so upgrading may safely
    // restore the same UUID instead of asking the user to copy/paste the task again.
    if (row.state === 'failed' && row.error === 'Not sent: the browser did not pick up this message within 60 seconds.' &&
        row.owner === null && row.offeredAt === undefined && row.sendAuthorizedAt === undefined && userRequestedInput(row)) {
      restoredUnclaimed += 1;
      return { ...row, state: 'queued', error: undefined };
    }
    // Older builds terminally parked the third positively pre-Send preparation failure as a
    // cancelled row and cleared its authorization marker. That exact generated error, bounded
    // retry counter, released owner and complete absence of Send/delivery evidence together are
    // durable proof that native Send was never attempted. Migrate only that narrow shape into
    // the existing confirmed-pre-Send retry lifecycle; every other cancellation keeps its late-
    // ACK/ambiguity semantics and remains ineligible for reminting.
    if (row.state === 'cancelled' && row.purpose !== 'decision' && row.owner === null &&
        (row.preSendReoffers ?? 0) > MAX_PRE_SEND_REOFFERS &&
        row.sendAuthorizedAt === undefined && row.deliveredAt === undefined && row.messageId === undefined &&
        LEGACY_EXHAUSTED_PRE_SEND_ERROR.test(row.error ?? '')) {
      restoredExhaustedPreSend += 1;
      return { ...row, state: 'failed', requiresAuthorization: true };
    }
    // `state:tool` proves that Main durably attached this exact UUID/text to a tool result, but
    // the only later-call receipt lives in the process-local `offered` map. After a process
    // restart we cannot distinguish "the HTTP result reached ChatGPT" from "Main died after the
    // durable offer commit but before remote receipt". Replaying would duplicate the first case;
    // claiming sent would invent the second. Preserve the existing nonterminal tool custody so
    // later stages/Goal cannot overtake it, but mark it visibly ambiguous and never manufacture
    // resend authority.
    if (row.state === 'tool') {
      ambiguousToolOffers += 1;
      return {
        ...row,
        toolReceiptUncertain: true,
        error: 'Delivery is unconfirmed after the app restarted. This instruction may already have reached ChatGPT; automatic replay is blocked.'
      };
    }
    return row.purpose === 'decision' && !terminal(row) && !decisionWaiters.has(row.id)
      ? { ...row, state: 'cancelled' } : row;
  });
  if (recovered.some((row, i) => row !== entries![i])) {
    try { await commit(recovered); }
    catch (error) { entries = null; throw error; }
  }
  if (restoredUnclaimed > 0)
    logInfo(`input: restored ${restoredUnclaimed} positively unclaimed browser message(s) from the retired 60-second timeout`);
  if (restoredExhaustedPreSend > 0)
    logInfo(`input: migrated ${restoredExhaustedPreSend} exhausted positive pre-Send browser failure(s) into explicit confirmed-pre-Send retry eligibility`);
  if (ambiguousToolOffers > 0)
    logInfo(`input: retained ${ambiguousToolOffers} reconstructed tool-result delivery offer(s) as ambiguous instead of replaying user instructions`);
  return expireQueued(entries);
}
/** The outbox retains delivery proof until its exact history owner is removed.
 * Run under its existing serial queue, before origin repair or checkpoint publication.
 * Unconfirmed sends and missing/corrupt metadata never establish removal. */
async function retireRemovedSessionReceipts(current: InputEntry[], pendingOnly = false): Promise<InputEntry[]> {
  const missing = new Map<string, boolean>();
  const removed = new Set<string>();
  for (const row of current) {
    const sessionId = row.sessionId ?? row.deliveredSessionId;
    if (!sessionId || row.purpose === 'decision' || !['sent', 'cancelled'].includes(row.state) ||
        !Number.isFinite(row.deliveredAt) ||
        (pendingOnly && !needsHistory(row) && !pendingStages(row))) continue;
    if (!missing.has(sessionId)) missing.set(sessionId, await sessionDirectoryMissing(sessionId));
    if (missing.get(sessionId)) removed.add(row.id);
  }
  // A combined delivery keeps both originals until both can be retired together.
  for (const row of current) {
    if (row.companionInputId && removed.has(row.id) !== removed.has(row.companionInputId)) {
      removed.delete(row.id); removed.delete(row.companionInputId);
    }
  }
  if (!removed.size) return current;
  const next = current.filter(row => !removed.has(row.id));
  await commit(next);
  return next;
}
/**
 * A one-word Loop wake can lose its purpose while waiting for browser custody: the Loop
 * supervisor may recover the chat first. The newer turn is positive evidence that the wake
 * succeeded by another owned path. Retire only an untouched, attachment-free wake so it does
 * not block the global composer or arrive later as a duplicate.
 */
async function queuedLoopWakeWasSatisfied(row: InputEntry): Promise<boolean> {
  if (row.state !== 'queued' || row.owner !== null || row.offeredAt !== undefined ||
      row.mode !== 'auto' || row.automation !== 'loop' || !row.sessionId || !row.conversationId ||
      row.images?.length || row.attachments?.length || row.stages?.length ||
      !SIMPLE_LOOP_WAKE.test(row.text.trim())) return false;
  const session = await getSession(row.sessionId);
  if (!session || session.conversationId !== row.conversationId) return false;
  const [start] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start'] });
  return start?.kind === 'turn_start' && start.time > row.createdAt;
}
async function expireQueued(current: InputEntry[]): Promise<InputEntry[]> {
  const browserHead = directBrowserHead(current);
  let next = await Promise.all(current.map(async (row): Promise<InputEntry> => {
    // Dependency/parallel waits spend no native delivery timeout or browser attention budget.
    if (row.state === 'queued' && !workflowInputReady(row, current)) return row;
    if (companionOf(current, row)) return row;
    if (row.route && row.state === 'queued' && row.owner === null && row.offeredAt === undefined &&
        row.sendAuthorizedAt === undefined && row.deliveredAt === undefined && row.messageId === undefined &&
        (!routedInputAllowed(row) || !row.sessionId ||
          (await getSession(row.sessionId))?.conversationId !== row.route.targetConversationId))
      return { ...row, state: 'cancelled', error: 'Not sent: the routed target is paused or changed.' };
    if (row.purpose === 'rotation' && row.queuedTurn && row.sessionId && row.rotationRetiredAt === undefined) {
      const session = await getSession(row.sessionId);
      const [boundary] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
      if (session && (session.conversationId !== row.queuedTurn.conversationId ||
          (!!session.activeTurnId && session.activeTurnId !== row.queuedTurn.turnId) ||
          (!session.activeTurnId && boundary?.kind === 'turn_end' && boundary.turnId === row.queuedTurn.turnId &&
            boundary.outcome !== 'unknown' && boundary.time >= row.createdAt))) row = { ...row, rotationRetiredAt: Date.now() };
    }
    if (row.finishOwner && !terminal(row) && !(await finishInputCurrent(row)))
      return { ...row, state: 'cancelled', error: 'Automatic follow-up cancelled because its active turn or setting changed.' };
    if (row.purpose === 'decision') return row;
    if (row.purpose === 'rotation' && row.state === 'queued' && row.owner === null && row.offeredAt === undefined &&
        row.sendAuthorizedAt === undefined && (Date.now() - row.createdAt >= 60_000 || !row.sessionId ||
          !row.conversationId || !row.directTurn || !await rotationSourceCurrent(row.sessionId, row.conversationId, row.directTurn.id)))
      return { ...row, state: 'cancelled', error: 'Not sent: this fresh-turn attempt expired or its original turn changed.' };
    if (await queuedLoopWakeWasSatisfied(row))
      return { ...row, state: 'cancelled', error: 'Not sent: this Loop started a newer turn before Chrome claimed the wake-up message.' };
    // A never-claimed direct message is provably pre-Send. After 15 minutes, retain it for the
    // user under Needs attention but let the next chat become the one global composer head. The
    // wait starts when this row actually reaches the head, not while it sits behind another chat.
    if (row.id === browserHead?.id && row.state === 'queued' && row.owner === null && manualInput(row) &&
        !queuedFollowup(row) && row.transportIntent !== 'tool' && row.queuedBehindBrowser !== true &&
        row.deliveryAttentionAt === undefined &&
        Date.now() - (row.browserEligibleAt ?? row.createdAt) >= UNCLAIMED_BROWSER_ATTENTION_MS) {
      return { ...row, deliveryAttentionAt: Date.now(),
        error: 'Needs attention: Chrome did not claim this message for 15 minutes. Other chats may continue; Retry browser revisits this exact saved message.' };
    }
    // An unclaimed browser message is positive pre-Send state. Chrome can take longer than a
    // minute to hydrate after a cold start, provider throttle, extension reload or tab restore.
    // Keep this exact durable row queued until Chrome claims it or the user cancels it.
    // Preparation can expire before Send. After Send authorization the browser still owns an
    // ambiguous, never-retried outcome, but it must not block the composer forever. Retiring that
    // wait is presentation/admission only: a later exact native receipt can still confirm this
    // cancelled row through acknowledgeBrowserInput().
    const companion = current.find(other => other.id === row.companionInputId);
    if (row.state === 'browser' && row.sendAuthorizedAt === undefined && row.requiresAuthorization === true &&
        Date.now() - (row.offeredAt ?? row.createdAt) >= (row.attachments?.length || companion?.attachments?.length ? 720_000 : row.images?.length || companion?.images?.length ? 120_000 : 60_000)) {
      // A manual correction could not reach its frozen running turn before preparation
      // expired. No Send was authorized: retain the SAME authored input for after the turn,
      // without reusing its old interruption/claim authority or releasing later followers.
      // Generated continuations, opening messages, bundles and native receipts keep custody.
      if (row.directTurn && row.sessionId && row.conversationId && manualInput(row) &&
          !row.sourceHelperId && !row.recovery && !row.companionInputId &&
          row.messageId === undefined && row.deliveredAt === undefined) {
        const { directTurn: _turn, owner: _owner, offeredAt: _offered, requiresAuthorization: _authorization, ...rest } = row;
        return { ...rest, state: 'queued', mode: 'after-turn', owner: null,
          error: 'Kept for after the running answer: ChatGPT could not take it into the answer.' };
      }
      return { ...row, state: 'cancelled', error: row.requiresAuthorization && row.sendAuthorizedAt === undefined
        ? 'Not sent: browser preparation timed out. This attempt was cancelled.'
        : 'Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.' };
    }
    if (row.state === 'browser' && row.sendAuthorizedAt !== undefined &&
        Date.now() - row.sendAuthorizedAt >= BROWSER_RECEIPT_WAIT_MS)
      return { ...row, state: 'cancelled', error: 'Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.' };
    return row;
  }));
  const releasedFollowers: Array<{ id: string; priorId: string }> = [];
  for (const row of current) {
    const after = next.find(candidate => candidate.id === row.id);
    if (row.state !== 'browser' || row.requiresAuthorization !== true || row.sendAuthorizedAt !== undefined ||
        after?.state !== 'cancelled' || !after.error?.startsWith('Not sent: browser preparation timed out.')) continue;
    const released = releaseSameChatFollowerAfterConfirmedUnsent(next, row);
    next = released.rows;
    if (released.releasedId) releasedFollowers.push({ id: released.releasedId, priorId: row.id });
  }
  for (let i = 0; i < next.length; i++) {
    const root = companionOf(next, next[i]!);
    if (root && root.state !== next[i]!.state) next[i] = { ...next[i]!, state: root.state, error: root.error };
  }
  if (next.some((row, index) => row !== current[index])) await commit(next);
  for (const released of releasedFollowers)
    logInfo(`input ${released.id}: released same-chat explicit follower after ${released.priorId} timed out before native Send authorization`);
  return entries!;
}
async function commit(next: InputEntry[]): Promise<void> {
  // A temporary planner keeps only ownership metadata across restart, never its task or answer.
  const durableRows = (rows: InputEntry[]) => rows.map(row => row.lifetime === 'temporary-planner'
    ? { ...row, text: '[Temporary planner]', deliveryText: undefined, response: undefined } : row);
  try { await writeDurableNow(STATE, durableRows(next)); }
  catch (error) {
    // durable.ts retries failed generations. Never let a rejected send claim or
    // enqueue become live later behind the caller's back.
    writeDurableSoon(STATE, durableRows(entries ?? []));
    throw error;
  }
  entries = next;
  wakeBrowserWork();
  for (const listener of inputListeners) { try { listener(); } catch { /* observer only */ } }
  try { deliveryHooks?.changed(); } catch { /* a detached renderer does not undo a durable commit */ }
}
/** Reserve the attempt durably before crossing into Goal's control ledger. The failed
 * row is the crash tombstone: an ambiguous settings write is never replayed after a
 * later user Off. Only this live operation may replace it with the successful delivery.
 */
async function transition(current: InputEntry[], next: InputEntry[], automated: InputEntry[], phase: 'before-send' | 'after-send'): Promise<void> {
  if (automated.length) {
    if (!deliveryHooks) throw new Error('Input delivery is not ready');
    const reserved = new Map(automated.flatMap(entry => next.filter(row => sameDelivery(entry, row)).map(row => [row.id, row] as const)));
    await commit(current.map((entry): InputEntry => {
      const claimed = reserved.get(entry.id);
      return claimed ? { ...claimed, state: 'failed', error: phase === 'after-send'
        ? 'Message sent, but automation was not confirmed. Check its chat settings.'
        : 'Automation was not confirmed; this message was not sent. Send again to retry.' } : entry;
    }));
    try {
      for (const entry of automated) await deliveryHooks.applyAutomation(
        entry.conversationId!, entry.automation!, phase, entry.objective, entry.loopAfterTurn,
        !entry.sessionId && phase === 'after-send'
      );
    } catch (error) {
      if (phase === 'before-send') {
        let failedRows = await load();
        const released: Array<{ id: string; priorId: string }> = [];
        for (const entry of automated) {
          const result = releaseSameChatFollowerAfterConfirmedUnsent(failedRows, entry);
          failedRows = result.rows;
          if (result.releasedId) released.push({ id: result.releasedId, priorId: entry.id });
        }
        if (released.length) {
          await commit(failedRows);
          for (const item of released)
            logInfo(`input ${item.id}: released same-chat explicit follower after ${item.priorId} failed automation setup before native Send`);
        }
      }
      throw error;
    }
  }
  await commit(next);
}
/** Freeze the exact transport bytes with its durable claim, never the authored enqueue payload. */
async function prepare(entry: InputEntry, suffix = '', inputOwnerRows?: readonly InputEntry[]): Promise<InputEntry> {
  if (entry.purpose === 'decision') {
    const deliveryText = entry.deliveryText ?? prepareOperatorPrompt(entry.text, randomInt);
    assertOperatorPromptEnvelope(deliveryText);
    if (deliveryText.length > MAX_CHATGPT_MESSAGE_CHARS) throw new Error('Prepared message exceeds the delivery limit; shorten the helper request');
    if (!entry.deliveryText) logInfo(`input ${entry.id}: validated helper prompt envelope (${deliveryText.length} characters)`);
    return { ...entry, deliveryText };
  }
  // Generated openings and plans cannot replace the user's complete request.
  // Keep the authored text intact; freeze the complete objective in the same
  // delivery claim so retries cannot reconstruct a different opening message.
  const authored = operatorPromptBody(entry.text);
  const text = entry.stages !== undefined && entry.mode !== 'finish'
    ? `Original user request:\n${entry.objective || authored}\n\nComplete workflow:\n${[authored, ...entry.stages].map((stage, index) => `${index + 1}. ${stage}`).join('\n\n')}\n\nBegin the complete implementation now. Later queued messages are verification checkpoints; do not wait for them to learn or implement requirements. Carry out and verify each received checkpoint before asking for the next one with session_finish; never call it repeatedly just to collect the queue.`
    : entry.objective && !entry.sessionId
      ? `Original user request:\n${entry.objective}\n\nOpening instruction:\n${authored}\n\nFollow the complete original request, including all constraints, throughout this task.`
      : authored;
  const mandatoryOverhead = `${TOOL_INPUT_HEADER}\n\n${finishInstruction(getConfig().ui.finishLeadMinutes)}`;
  const prerequisites = entry.workflow?.dependsOn.length ? `\n\nVerified recipe prerequisites (read-only receipts; verify these hashes before consuming outputs):\n${JSON.stringify(entry.workflow.dependsOn.map(id => {
    const parent = inputOwnerRows?.find(row => row.id === id);
    if (!parent?.workflowReceipt || parent.workflowReceipt.status !== 'verified') throw new Error('Recipe prerequisite receipt changed before preparation.');
    return { inputId: parent.id, sessionId: parent.sessionId ?? parent.deliveredSessionId, conversationId: parent.conversationId, step: parent.workflow!.step, receipt: parent.workflowReceipt };
  }))}` : '';
  const overhead = operatorPromptOverhead();
  const deliveryText = entry.deliveryText ?? prepareOperatorPrompt(await deliveryHooks?.prepareText?.({ ...entry, text: text + prerequisites + suffix }, {
    maxChars: MAX_CHATGPT_MESSAGE_CHARS - overhead.chars,
    maxBytes: TOOL_INPUT_TEXT_BYTES - Buffer.byteLength(mandatoryOverhead) - overhead.bytes
  }, { text: authored, objective: entry.objective }, inputOwnerRows) ?? text + prerequisites + suffix, randomInt);
  assertOperatorPromptEnvelope(deliveryText);
  if (!entry.deliveryText) logInfo(`input ${entry.id}: validated prompt envelope (${deliveryText.length} characters, ${Buffer.byteLength(deliveryText)} UTF-8 bytes)`);
  // A single input must fit the tool envelope by itself. Aggregate batching below
  // may defer a second input, but cannot silently defer an individually impossible one.
  const envelope = `${TOOL_INPUT_HEADER}${deliveryText}\n\n${finishInstruction(getConfig().ui.finishLeadMinutes)}`;
  if (!deliveryText || deliveryText.length > MAX_CHATGPT_MESSAGE_CHARS || Buffer.byteLength(envelope) > TOOL_INPUT_TEXT_BYTES)
    throw new Error('Prepared message exceeds the delivery limit; shorten the request or plan');
  const preparedContext = entry.workflow ? { authoredChars: entry.text.length,
    deliveredChars: deliveryText.length,
    skillBodySha256: [...deliveryText.matchAll(/<!-- cos-skill-body-sha256:([a-f0-9]{64}) -->/g)].map(match => match[1]!).slice(0, 64) } : undefined;
  if (preparedContext && !entry.deliveryText) logInfo(`workflow: context frozen input=${entry.id} authoredChars=${preparedContext.authoredChars} deliveredChars=${preparedContext.deliveredChars} skillBodies=${preparedContext.skillBodySha256.length}`);
  return { ...entry, deliveryText, ...(preparedContext ? { preparedContext } : {}) };

}
/** Explicit follow-ups spend one verified completed turn; each transport elects its eligible FIFO. */
const queuedFollowup = (row: InputEntry): boolean => row.queuedBehindDelivery === true ||
  (!manualInput(row) && (row.mode === 'finish' || (row.mode === 'after-turn' && !!row.sessionId && row.purpose !== 'decision')));
function append(current: InputEntry[], entry: InputEntry, stackDirect = false): InputEntry[] {
  if (queuedFollowup(entry)) {
    const positioned = current.filter(row => row.sessionId === entry.sessionId && queuedFollowup(row) && !terminal(row) && row.queueOrder !== undefined);
    if (positioned.length) entry = { ...entry, queueOrder: Math.max(...positioned.map(row => row.queueOrder!)) + 1 };
  }
  // Only ordinary browser sends occupy the global composer slot. Durable tool
  // intent can queue independently; actual handout still fences browser claims.
  if (!entry.workflow && !stackDirect && entry.queuedBehindBrowser !== true && entry.purpose !== 'decision' && !queuedFollowup(entry) && current.some(row => (row.transportIntent !== 'tool' || row.sessionId === entry.sessionId) && (row.sessionId === entry.sessionId || (!row.finishOwner && !entry.finishOwner)) && row.purpose !== 'decision' &&
      !(!entry.finishOwner && row.finishOwner && row.state === 'tool') &&
      (!queuedFollowup(row) || row.state === 'browser') && ['queued', 'browser', 'tool'].includes(row.state))) {
    throw new Error('One message is already awaiting delivery. Open Delivery queue to inspect or cancel it before sending another.');
  }
  // A positively pre-Send failed continuation still owns its saved instruction and
  // accepted helper while the EXACT Goal pickup remains pending. Keep both under
  // the active queue's existing byte caps; revoked/departed debt and ambiguous or
  // cancelled sends retain only ordinary bounded history. Older rows without a
  // frozen pickup timestamp cannot borrow a later episode's retention authority.
  const pendingContinuations = sourceHelperCustodyIds(current);
  const heldHelperIds = new Set(current.filter(row => row.sourceHelperId &&
    (!terminal(row) || needsHistory(row) || pendingContinuations.has(row.id))).map(row => row.sourceHelperId!));
  const activeWorkflowRuns = new Set(current.filter(row => row.workflow &&
    (!terminal(row) || row.state === 'sent' && !row.workflowReceipt)).map(row => row.workflow!.runId));
  const active = current.filter(row => !terminal(row) || needsHistory(row) ||
    (row.workflow && activeWorkflowRuns.has(row.workflow.runId)) ||
    pendingStages(row) || heldHelperIds.has(row.id) || pendingContinuations.has(row.id) ||
    (row.purpose === 'rotation' && row.queuedTurn && row.rotationRetiredAt === undefined) ||
    (row.goalStopDisposition &&
      goalPendingReplyFor(row.goalStopDisposition.conversationId)?.turnId === row.goalStopDisposition.sourceTurnId &&
      goalPendingReplyFor(row.goalStopDisposition.conversationId)?.acceptedAt === row.goalStopDisposition.sourceAcceptedAt));
  const reserved = (row: InputEntry) => row.stagesApplied ? [] : row.stages ?? [];
  if ([...active, entry].reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify({ ...row, images: undefined, toolImages: undefined, stages: reserved(row) })), 0) > 1024000) {
    throw new Error('The message queue is full');
  }
  const imageBytes = (row: InputEntry): number => [...row.images ?? [], ...row.toolImages ?? []].reduce((sum, image) => sum + image.dataUrl.length, 0) +
    (row.attachments ?? []).reduce((sum, file) => sum + (file.preview?.length ?? 0), 0);
  if ([...active, entry].reduce((sum, row) => sum + imageBytes(row), 0) > 4 * 1024 * 1024) throw new Error('The image queue is full');
  // A terminal STOP receipt can still be *active* custody until the exact Goal
  // ledger reconciles it. The ordinary last-50 history projection must not
  // serialize that same UUID a second time when another input is appended.
  const activeIds = new Set(active.map(row => row.id));
  const history = current.filter((row) => !activeIds.has(row.id) && terminal(row) &&
    !needsHistory(row) && !pendingStages(row)).slice(-50);
  const bytes = (row: InputEntry): number => Buffer.byteLength(row.text) + Buffer.byteLength(row.deliveryText ?? '') + Buffer.byteLength(row.response ?? '') + Buffer.byteLength(JSON.stringify(row.stages ?? [])) + imageBytes(row);
  let retainedBytes = [...history, ...active, entry].reduce((sum, row) => sum + bytes(row), 0);
  while (history.length && retainedBytes > 2048000) retainedBytes -= bytes(history.shift()!);
  // A frozen delivery needs both originals for restart/history until both can be
  // discarded together. Never retain a dangling companion id after trimming.
  const retained = new Set([...history, ...active, entry].map(row => row.id));
  return [...history.filter(row => {
    const root = companionOf(current, row);
    return (!row.companionInputId || retained.has(row.companionInputId)) && (!root || retained.has(root.id));
  }), ...active, ...current.filter(row => !retained.has(row.id) && active.some(root => sameDelivery(root, row) || root.id === row.companionInputId)), entry];
}
async function target(entry: InputEntry): Promise<string | null> {
  if (entry.purpose === 'decision') {
    if (entry.conversationId && isChatBlocked(entry.conversationId)) throw new Error('Unblock this helper conversation before sending');
    return entry.conversationId;
  }
  if (!entry.sessionId) return null;
  const session = await getSession(entry.sessionId);
  if (!session?.conversationId) throw new Error('This recording has no ChatGPT conversation');
  if (entry.route && (entry.route.targetConversationId !== session.conversationId || !routedInputAllowed(entry)))
    throw new Error('The routed target is paused or changed. No message was sent; use the current authorized workstream.');
  if (isChatBlocked(session.conversationId)) throw new Error('Unblock this conversation before sending');
  return session.conversationId;
}
async function finishInputCurrent(entry: InputEntry): Promise<boolean> {
  // Periodic generation was retired; persisted rows cannot regain delivery authority.
  if (!entry.finishOwner || entry.finishOwner.periodic || !entry.sessionId) return false;
  const session = await getSession(entry.sessionId), config = getConfig();
  return !!session?.conversationId && session.conversationId === entry.conversationId &&
    session.activeTurnId === entry.finishOwner.turnId && session.finishTurn?.turnId === entry.finishOwner.turnId &&
    !session.finishTurn.released && config.ui.finishTool === true && !isChatBlocked(session.conversationId) &&
    session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
    (entry.finishOwner.userRequested === true || automaticFinishEnabled(session.conversationId));
}
export function enqueueInput(raw: InputArgs, finishOwner?: InputEntry['finishOwner']): Promise<InputEntry> {
  return serial(async () => {
    const input = inputArgs.parse(raw);
    if (input.workflow && (input.mode !== 'auto' || input.stages || input.route || input.images || input.attachments ||
        input.automation === 'goal' || input.automation === 'loop' ||
        !input.sessionId && (input.automation !== 'off' || input.finiteOneOff !== true)))
      throw new Error('Recipes require finite native text tasks; use the existing Goal/Loop and attachment owners separately.');
    if (input.workflow && (input.workflow.dependsOn.includes(input.id) || input.workflow.order >= input.workflow.total))
      throw new Error('Recipe step has a self-dependency or invalid order');
    if (input.route && (!input.sessionId || input.route.sourceSessionId === input.sessionId))
      throw new Error('A model route requires different exact source and target sessions');
    if (input.operatorRequestKey && input.operatorRequestKey !== operatorInputSemanticKey(input))
      throw new Error('Operator request key does not match the normalized input');
    if (input.operatorRetryOf && !input.operatorRequestKey)
      throw new Error('Operator retry evidence requires an app-derived request key');
    if (input.nickname && input.sessionId) throw new Error('A chat nickname may be assigned only while creating a new main chat');
    if (input.stages !== undefined && JSON.stringify([input.text, ...input.stages]).length > 12000)
      throw new Error('Keep the complete plan below 12,000 characters');
    const current = await load();
    const prior = current.find((entry) => entry.id === input.id);
    if (prior) {
      if (JSON.stringify(inputArgs.parse({ ...prior, mode: prior.requestedMode ?? prior.mode })) !== JSON.stringify(input)) throw new Error('Message id already belongs to different input');
      return { ...prior };
    }
    if (input.operatorRequestKey) {
      const matching = current.filter(row => row.operatorRequestKey === input.operatorRequestKey ||
        // Old frozen keys included generated headers. Derive comparison from the
        // retained authored fields without rewriting their key or any Send receipt.
        operatorInputSemanticKey(row) === input.operatorRequestKey);
      const evidence = new Set(input.operatorRetryOf ?? []);
      const matchingIds = new Set(matching.map(row => row.id));
      const exactRetry = matching.length > 0 && evidence.size === matchingIds.size &&
        [...matchingIds].every(id => evidence.has(id)) && matching.every(confirmedPreSendOperatorRetry);
      if (matching.length > 0 && !exactRetry) {
        const summary = matching.map(row => `${row.id}:${row.state}`).join(', ');
        throw new Error(`Matching operator request already exists (${summary})`);
      }
      if (matching.length === 0 && evidence.size > 0)
        throw new Error('Operator retry evidence no longer matches a durable input');
    }
    assertNewWorkAllowed('message');
    const requestedMode = input.mode;
    let policy = input.sessionId ? await sessionInputPolicy(input.sessionId) : null;
    if (input.workflow && policy) policy = { ...policy, canInject: false, directTurn: null };
    if (!finishOwner && input.sessionId &&
        composerOnlyText(input, await getSession(input.sessionId)) && policy?.canInject) {
      policy = { ...policy, canInject: false };
    }
    let queuedBehindDelivery = false;
    let queuedBehindBrowser = false;
    // Send is allowed to be pressed again while this same chat already owns one durable
    // delivery. The second instruction is not another competing composer owner: promote it to
    // the existing per-session FIFO and release it after the current native turn settles.
    // Browser/tool claims remain one-at-a-time below, so this improves admission without ever
    // replaying an ambiguous first Send. Brand-new and cross-chat sends use the global composer
    // FIFO below instead of rejecting the user's message.
    if (input.sessionId && input.mode === 'auto' && !finishOwner && policy?.canInject !== true && current.some(row =>
      row.sessionId === input.sessionId && row.purpose !== 'decision' &&
      !(row.purpose === 'rotation' && row.state === 'queued' && row.owner === null && row.offeredAt === undefined) && !row.finishOwner &&
      (row.state === 'browser' || row.state === 'tool' ||
        (!queuedFollowup(row) && row.state === 'queued' && Date.now() - row.createdAt < UNCLAIMED_BROWSER_REPLACEMENT_MS)))) {
      input.mode = 'after-turn';
      queuedBehindDelivery = true;
    }
    // Another chat's browser send is a scheduling condition, not a reason to reject this user's
    // message or lock the composer. Preserve Auto semantics and put the exact durable row behind
    // the current native-composer owner. Tool injection remains independent, while the browser
    // projection below releases only the global FIFO head.
    if (input.mode === 'auto' && !finishOwner && policy?.canInject !== true && current.some(row =>
      row.purpose !== 'decision' &&
      !(row.purpose === 'rotation' && row.state === 'queued' && row.owner === null && row.offeredAt === undefined) && !row.finishOwner && !queuedFollowup(row) &&
      row.transportIntent !== 'tool' && ['queued', 'browser'].includes(row.state))) {
      queuedBehindBrowser = true;
    }
    let toolImages: InputImage[] | undefined;
    let imageOwner: { conversationId: string; turnId: string } | undefined;
    if (input.attachmentDelivery === 'tool') {
      if (!input.sessionId || input.mode !== 'auto' || finishOwner || input.stages?.length || (!policy?.canInject && !policy?.directTurn) ||
          (input.images?.length ?? 0) + (input.attachments?.length ?? 0) > 4)
        throw new Error('Inject up to four images into an active chat; otherwise use Send or After this turn');
      const owner = await getSession(input.sessionId);
      const imageTurnId = policy.directTurn?.id ?? policy.injectionTurnId;
      if (!imageTurnId || !owner?.conversationId) throw new Error('Inject images into an active chat');
      imageOwner = { conversationId: owner.conversationId, turnId: imageTurnId };
      toolImages = await normalizeInputAttachments(input.attachments ?? []);
    } else if (input.attachments?.length) {
      await validateInputAttachments(input.attachments);
      // Native files belong to the next browser message, never a tool-result injection.
      if (finishOwner) throw new Error('Automatic finish messages cannot attach files');
      if (input.mode === 'finish' || (input.mode === 'auto' && (policy?.canInject || policy?.directTurn))) input.mode = 'after-turn';
    } else if (!input.workflow && input.mode === 'after-turn' && policy?.queueAtFinish) input.mode = 'finish';
    if (input.mode === 'finish' || input.stages?.length) {
      const session = input.sessionId ? await getSession(input.sessionId) : null;
      if ((input.mode === 'finish' && !session?.conversationId) || session?.origin?.kind === 'worker') throw new Error('Queue staged tasks in a normal chat');
    }
    // Unattributed work can fence browser Send without making this chat a tool recipient.
    // Leave that input neutral until the existing serialized claim selects a safe transport.
    const transportIntent = input.attachmentDelivery === 'tool' ? 'tool' as const : input.attachments?.length ? 'browser' as const : input.mode === 'auto' && !finishOwner
      ? policy?.canInject ? 'tool' as const : !policy || policy.browserAllowed || policy.directTurn ? 'browser' as const : undefined : undefined;
    const directTurn = !input.workflow && input.mode === 'auto' && !finishOwner && !imageOwner && input.dueAt <= Date.now() ? policy?.directTurn : null;
    const entry: InputEntry = { ...input, ...(toolImages ? { toolImages } : {}), ...(directTurn ? { directTurn } : {}), ...(transportIntent ? { transportIntent } : {}), ...(requestedMode !== input.mode ? { requestedMode } : {}), ...(queuedBehindDelivery ? { queuedBehindDelivery: true } : {}), ...(queuedBehindBrowser ? { queuedBehindBrowser: true } : {}), ...(finishOwner ? { finishOwner } : {}), state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    if (input.projectId) {
      await projectWorkspace(input.projectId);
      if (input.sessionId) {
        const session = await getSession(input.sessionId);
        if (session?.projectId !== input.projectId) throw new Error('Message project does not match the session');
        await getSessionProject(input.sessionId);
      }
    }
    entry.conversationId = await target(entry);
    if (finishOwner && !(await finishInputCurrent(entry))) throw new Error('The automatic follow-up no longer belongs to an active turn');
    if (imageOwner) {
      policy = await sessionInputPolicy(input.sessionId!);
      const owner = await getSession(input.sessionId!);
      if ((policy.directTurn?.id ?? policy.injectionTurnId) !== imageOwner.turnId || owner?.conversationId !== imageOwner.conversationId || entry.conversationId !== imageOwner.conversationId)
        throw new Error('The active chat changed while preparing images; send again');
    }
    // A newer explicit message supersedes unfinished automatic work and a stale direct browser
    // message that Chrome never claimed. Fresh queued rows still preserve rapid batching/order;
    // tool input and claimed browser input retain their exact receipt fences.
    let retiredDirectInputs = 0;
    const prioritized = !finishOwner ? current.map(row => {
      if (row.sessionId === entry.sessionId && row.purpose === 'rotation' && row.state === 'queued' &&
          row.owner === null && row.offeredAt === undefined && row.sendAuthorizedAt === undefined)
        return { ...row, state: 'cancelled' as const, error: 'Not sent: replaced by your new instruction.' };
      if (row.sessionId === entry.sessionId && row.finishOwner && row.state === 'queued')
        return { ...row, state: 'cancelled' as const, error: 'Replaced by your new instruction before delivery.' };
      if (!row.workflow && entry.sessionId && row.id !== entry.id && row.sessionId === entry.sessionId && manualInput(row) &&
          row.transportIntent === 'browser' && row.state === 'queued' && row.owner === null &&
          Date.now() - row.createdAt >= UNCLAIMED_BROWSER_REPLACEMENT_MS) {
        retiredDirectInputs += 1;
        return { ...row, state: 'cancelled' as const,
          error: 'Replaced by a newer message before Chrome claimed this delivery.' };
      }
      return row;
    }) : current;
    let next = append(prioritized, entry, input.mode === 'auto' && !finishOwner && policy?.canInject === true);
    // A finish plan belongs to an existing session now. Publish every editable
    // checkpoint atomically; no composer text or first-send receipt owns its life.
    if (entry.mode === 'finish') next = materializeStages(next, entry);
    if (!routedInputAllowed(entry)) throw new Error('The routed target is paused. No message was queued.');
    await commit(next);
    // The switch can change during fsync. Keep a durable, positively unsent tombstone;
    // retained route custody also fences delivery if Main restarts before this recheck.
    if (!routedInputAllowed(entry)) {
      next = next.map(row => row.id === entry.id ? { ...row, state: 'cancelled' as const,
        error: 'Not sent: the routed target was paused while the message was being saved.' } : row);
      await commit(next);
    }
    if (retiredDirectInputs > 0)
      logInfo(`input ${entry.id}: retired ${retiredDirectInputs} older unclaimed direct message(s) for session ${entry.sessionId}`);
    return { ...next.find(row => row.id === entry.id)! };
  });
}

/** The existing outbox owns Stop -> Continue, including restart/ACK ambiguity. */
async function rotationSourceCurrent(sessionId: string, conversationId: string, turnId: string, claimedAt?: number): Promise<boolean> {
  const allowed = () => !browserDecisionSignedOut && getConfig().ui.automationPaused !== true &&
    (getConfig().ui.rotateTurnMinutes ?? 30) > 0 && profileWorkAdmission.decideNew('message').allowed &&
    !isChatBlocked(conversationId) && !goalDraftBusy(conversationId) && !goalPendingReplyFor(conversationId) &&
    !continuationForSession(sessionId) && !callsHoldRecovery(conversationId) &&
    backgroundExecObligations(sessionId).running.length === 0;
  if (!allowed()) return false;
  const session = await getSession(sessionId);
  const selection = session?.selectedModel;
  const [end] = claimedAt !== undefined && !session?.activeTurnId
    ? await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] }) : [];
  const originalTurn = session?.activeTurnId === turnId || (claimedAt !== undefined &&
    end?.kind === 'turn_end' && end.turnId === turnId && end.outcome === 'stopped' && end.time >= claimedAt);
  return Boolean(session?.conversationId === conversationId && originalTurn &&
    session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' && !session.finishTurn?.released &&
    selection?.conversationId === conversationId && selection.model && !isProModel(selection.model, selection.reasoningEffort) &&
    !(await conversationWasSuperseded(conversationId)) && allowed());
}

/** Maximapple/#1402: reuse the durable outbox, never a timer that blindly presses Continue. */
export function fileRotationInput(sessionId: string, turnId: string, stillCurrent: () => boolean = () => true): Promise<InputEntry | null> {
  return serial(async () => {
    const current = await load();
    const prior = current.filter(row => row.sessionId === sessionId && row.purpose === 'rotation' && row.queuedTurn?.turnId === turnId);
    // The two-filing ceiling and ambiguous native custody survive Main reconstruction. A
    // timed-out Send is not positive evidence that Continue failed to reach ChatGPT.
    if (prior.length >= 2 || prior.some(row => row.sendAuthorizedAt !== undefined ||
        row.deliveredAt !== undefined || row.messageId !== undefined)) return null;
    if (!stillCurrent() || current.some(row => (row.sessionId === sessionId || row.decisionSourceSessionId === sessionId) && !terminal(row))) return null;
    const session = await getSession(sessionId);
    const conversationId = session?.conversationId;
    if (!conversationId || !await rotationSourceCurrent(sessionId, conversationId, turnId)) return null;
    const policy = await sessionInputPolicy(sessionId, { possible: true, exact: true, model: 'other', turnId });
    if (policy.directTurn?.id !== turnId || !stillCurrent() || !await rotationSourceCurrent(sessionId, conversationId, turnId)) return null;
    const now = Date.now();
    const entry: InputEntry = { id: randomUUID(), sessionId, conversationId, text: rotationMessage(),
      mode: 'auto', dueAt: now, createdAt: now, model: session!.selectedModel!.model,
      reasoningEffort: session!.selectedModel!.reasoningEffort ?? null,
      purpose: 'rotation', directTurn: policy.directTurn, transportIntent: 'browser',
      queuedTurn: { conversationId, turnId }, state: 'queued', owner: null };
    await commit(append(current, entry));
    wakeBrowserWork();
    return { ...entry };
  });
}

/** The existing outbox owns Stop -> Continue, including restart/ACK ambiguity. */
async function interruptedInputCurrent(entry: InputEntry): Promise<boolean> {
  const id = entry.conversationId;
  if (!id || !entry.sessionId || !entry.recovery || getConfig().ui.automationPaused === true ||
      isChatBlocked(id) || !goalArmedFor(id) || goalPendingReplyFor(id) || goalDraftBusy(id) ||
      continuationForSession(entry.sessionId)) return false;
  const session = await getSession(entry.sessionId);
  const question = await readLatestUserMessage(entry.sessionId);
  const superseded = await conversationWasSuperseded(id);
  const [failure] = session?.lastTurnOutcome === 'failed'
    ? await readRecentEvents(entry.sessionId, 1, { kinds: ['chat_error'] }) : [];
  const failedInterruption = failure?.kind === 'chat_error' && failure.recoverable === true && !failure.message.truncated &&
    failure.turnId === session?.finishTurn?.turnId &&
    /^(?:connection interrupted\.? (?:waiting|please wait) for the complete answer\.?(?: retry)?|message delivery timed out\.? please try again\.?)$/i.test(
      failure.message.text.replace(/\s+/g, ' ').trim());
  const current = await getSession(entry.sessionId);
  // Stop -> Continue is a terminal transition, not permission derived from
  // an interrupted-stream banner or a browser action offer. The recorder must
  // have committed Stop or the exact provider interruption's failed end before
  // this sender can reserve or deliver Continue. An unrelated failure is not proof.
  // A newer native turn revokes this recovery instead of receiving a duplicate.
  return current?.conversationId === id && !current.activeTurnId &&
    (current.lastTurnOutcome === 'stopped' || current.lastTurnOutcome === 'failed' && failedInterruption) &&
    current.events === session?.events && current.updatedAt === session?.updatedAt &&
    question?.messageId === entry.recovery.questionId &&
    !superseded && !callsHoldRecovery(id) && getConfig().ui.automationPaused !== true &&
    !isChatBlocked(id) && goalArmedFor(id) && !goalPendingReplyFor(id) && !goalDraftBusy(id) &&
    !continuationForSession(entry.sessionId);
}

export function enqueueInterruptedContinue(sessionId: string, conversationId: string, questionId: string): Promise<InputEntry | null> {
  return serial(async () => {
    const current = await load();
    const episode = `interruption:${questionId}`;
    const prior = current.find(row => row.sessionId === sessionId && row.recovery?.episode === episode);
    if (prior) return { ...prior }; // Sent, ambiguous, failed and cancelled rows never become a new Send.
    if (current.some(row => (row.sessionId === sessionId || row.decisionSourceSessionId === sessionId) &&
        ['queued', 'browser', 'tool', 'decision'].includes(row.state))) return null;
    const session = await getSession(sessionId);
    const selection = session?.selectedModel?.conversationId === conversationId ? session.selectedModel : null;
    const row: InputEntry = {
      id: randomUUID(), sessionId, conversationId, text: 'continue', mode: 'auto',
      model: selection?.model ?? null, reasoningEffort: selection?.reasoningEffort ?? null,
      dueAt: Date.now(), createdAt: Date.now(), state: 'queued', owner: null, transportIntent: 'browser',
      recovery: { questionId, episode, pro: false, busyUntil: 0, phase: 'ready' }
    };
    if (!await interruptedInputCurrent(row)) return null;
    assertNewWorkAllowed('message');
    await commit([...current, row]);
    logInfo(`input ${row.id}: interrupted native turn stopped; one Continue saved for exact question`);
    wakeBrowserWork();
    return { ...row };
  });
}
function materializeStages(current: InputEntry[], entry: InputEntry): InputEntry[] {
  const sessionId = entry.sessionId ?? entry.deliveredSessionId;
  if (!sessionId || entry.stages === undefined || entry.stagesApplied) return current;
  let next = current.map(row => row.id === entry.id ? { ...row, stagesApplied: true } : row);
  // Checkpoints inherit the current chat model, including later user selections.
  for (const [index, text] of entry.stages.entries()) next = append(next, {
    id: randomUUID(), sessionId, projectId: entry.projectId, text, mode: 'finish', dueAt: entry.createdAt + index,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: entry.createdAt + index, conversationId: entry.conversationId
  });
  return next;
}
export function listInputs(): Promise<InputEntry[]> {
  return serial(async () => {
    const current = await retireRemovedSessionReceipts(await load(), true);
    let next: InputEntry[] = [];
    for (const entry of current) {
      if (entry.purpose !== 'decision' && (entry.state === 'sent' || (entry.state === 'cancelled' && entry.deliveredAt !== undefined)) && !entry.sessionId && entry.conversationId && !entry.deliveredSessionId) {
        const session = await findSessionByConversation(entry.conversationId, { requireUnique: true });
        next.push(session ? { ...entry, deliveredSessionId: session.id } : entry);
      } else next.push(entry);
    }
    for (const entry of [...next]) {
      if (entry.state === 'sent') next = materializeStages(next, entry);
    }
    if (next.length !== current.length || next.some((entry, index) => entry !== current[index])) await commit(next);
    await publishHistory();
    return ordered(await load()).map((entry) => ({ ...entry }));
  });
}
/**
 * Read-only retention fence for the existing durable outbox. Unlike listInputs/load,
 * this must not retire receipts, publish history, claim a Send or repair the queue:
 * expiration is checking whether it may remove the source evidence, not executing
 * any of the messages it finds. Corrupt/ambiguous input custody refuses pruning.
 */
export async function retentionHeldInputSessions(sessions: readonly Pick<SessionSummary,
  'id' | 'conversationId' | 'chatIds'>[]): Promise<ReadonlySet<string>> {
  if (!durableStoreReady()) throw new Error('Message outbox custody is not initialized');
  const snapshot = await readDurableStrict<unknown>(STATE);
  const validated = z.array(entrySchema).safeParse(snapshot ?? []);
  if (!validated.success) throw new Error('Message outbox custody unverified for session retention');
  const known = new Map<string, string>();
  const held = new Set<string>();
  const workflowRuns = new Set(validated.data.filter(row => row.workflow &&
    (!terminal(row) || row.state === 'sent' && !row.workflowReceipt)).map(row => row.workflow!.runId));
  for (const row of validated.data) {
    const serialized = JSON.stringify(row);
    const previous = known.get(row.id);
    if (previous !== undefined && previous !== serialized)
      throw new Error('Conflicting outbox message identity blocks session retention');
    known.set(row.id, serialized);
    // A completed, positively delivered receipt need not hold its old transcript
    // forever. Pending/uncertain work still depends on its original session.
    const unresolved = ['queued', 'browser', 'tool', 'decision'].includes(row.state) ||
      (row.workflow !== undefined && workflowRuns.has(row.workflow.runId)) ||
      row.toolReceiptUncertain === true ||
      (row.recoveryFailure !== undefined && !row.recoveryFailure.retrySafe &&
        row.recoveryFailure.phase !== 'pre_send_preparation') ||
      (row.state === 'sent' && row.stages !== undefined && !row.stagesApplied);
    if (!unresolved) continue;
    for (const id of [row.sessionId, row.deliveredSessionId, row.decisionSourceSessionId])
      if (id) held.add(id);
    // Browser-first inputs can name an exact conversation before its durable
    // session id is attached. Protect every real recorded owner of that chat,
    // including a predecessor still carrying an uncertain result after Resume.
    // No guessed tab/session identity and no new send authority is created.
    if (!row.sessionId && !row.deliveredSessionId && !row.decisionSourceSessionId && row.conversationId)
      for (const summary of sessions)
        if (summary.conversationId === row.conversationId || summary.chatIds.includes(row.conversationId))
          held.add(summary.id);
  }
  return held;
}
/** Goal activation shares the native input serializer through its whole durable write.
 * The awaited after-send settings hook already owns this lease; only that exact live context
 * may reenter. Detached callbacks after release/failure enqueue normally, never borrow it. */
export function withGoalReplyActivationInput(conversationId: string, work: () => Promise<boolean>): Promise<boolean> {
  const activate = async () => {
    const rows = await load();
    if (rows.some(row => row.conversationId === conversationId && row.purpose !== 'decision' && row.sourceHelperId &&
      ((row.state === 'browser' && !!row.owner) || row.state === 'tool' ||
        (row.sendAuthorizedAt !== undefined && (!row.messageId || !Number.isFinite(row.deliveredAt)))))) return false;
    return work();
  };
  const owner = inputSerialContext.getStore();
  return owner?.live && inputSerialOwner === owner ? activate() : serial(activate);
}
/** A sent receipt survives a recorder failure. Existing outbox reads retry publication,
 * never transport; the stable canonical key makes a lost recording ACK idempotent. */
async function publishHistory(): Promise<void> {
  const current = await load();
  const recorded = new Set<string>();
  for (const row of current) {
    if (!needsHistory(row) || companionOf(current, row)) continue;
    try { if (deliveryHooks?.recordDelivered && await deliveryHooks.recordDelivered(combinedInput(row, current.find(other => other.id === row.companionInputId)))) {
      recorded.add(row.id);
      if (row.companionInputId) recorded.add(row.companionInputId);
    } }
    catch { /* delivered, retained, and still visible until canonical recording succeeds */ }
  }
  if (recorded.size) {
    try { await commit(current.map(row => recorded.has(row.id)
      ? { ...row, historyRecorded: true, historyProjectionVersion: 1 as const,
        historyProvenanceRecorded: true as const, historyProvenancePending: undefined } : row)); }
    catch { /* the durable delivery receipt remains; canonical retry is idempotent */ }
  }
}
export function cancelInput(id: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const selected = current.find((entry) => entry.id === id);
    const found = selected && (companionOf(current, selected) ?? selected);
    if (!found || !['queued', 'browser'].includes(found.state)) return false;
    let next = current.map((entry) => sameDelivery(found, entry) ? { ...entry, state: 'cancelled' as const,
      error: found.state === 'browser' ? found.requiresAuthorization && found.sendAuthorizedAt === undefined
        ? 'Not sent: this delivery was cancelled before Send was authorized.'
        : 'Cancelled locally. Delivery to ChatGPT is unconfirmed; the message may already have been sent.' : undefined } : entry);
    const confirmedUnsent = found.state === 'queued' ||
      (found.state === 'browser' && found.requiresAuthorization === true && found.sendAuthorizedAt === undefined);
    const released = confirmedUnsent ? releaseSameChatFollowerAfterConfirmedUnsent(next, found) : { rows: next, releasedId: null };
    next = released.rows;
    await commit(next);
    if (released.releasedId)
      logInfo(`input ${released.releasedId}: released same-chat explicit follower after ${found.id} was cancelled before native Send authorization`);
    decisionWaiters.get(id)?.reject(new Error('goal_browser_cancelled'));
    decisionWaiters.delete(id);
    return true;
  });
}

/**
 * Operator cancellation is deliberately narrower than the interactive Cancel control.
 *
 * The row must still be ownerless queued input with no browser/tool offer, Send authorization,
 * delivery receipt, or native message receipt. This check runs inside the outbox serializer, so a
 * racing browser claim either loses completely or wins completely. The cancelled row is retained
 * as durable audit evidence instead of being removed from the ledger.
 */
export function cancelQueuedInputByOperator(id: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const selected = current.find(row => row.id === id);
    const root = selected && (companionOf(current, selected) ?? selected);
    if (!root) return false;
    const delivery = current.filter(row => sameDelivery(root, row));
    if (!delivery.length || delivery.some(row => row.state !== 'queued' || row.owner !== null ||
        row.offeredAt !== undefined || row.sendAuthorizedAt !== undefined ||
        row.deliveredAt !== undefined || row.messageId !== undefined)) return false;
    const cancelledAt = Date.now();
    let next = current.map(row => sameDelivery(root, row) ? {
      ...row,
      state: 'cancelled' as const,
      operatorCancelledAt: cancelledAt,
      error: 'Not sent: cancelled by the operator before any delivery owner claimed this input.'
    } : row);
    const released = releaseSameChatFollowerAfterConfirmedUnsent(next, root);
    next = released.rows;
    await commit(next);
    if (released.releasedId)
      logInfo(`input ${released.releasedId}: released same-chat explicit follower after operator cancellation of ${root.id}`);
    decisionWaiters.get(id)?.reject(new Error('goal_browser_cancelled'));
    decisionWaiters.delete(id);
    logInfo(`input ${root.id}: strict operator cancellation committed before browser offer`);
    return true;
  });
}

/**
 * Revokes every unfinished delivery owned by one session, including its browser planner.
 *
 * Deleting a sidebar row used to leave these durable outbox entries alive. A queued row could
 * later open Chrome, a tool row could be offered again, and a decision helper could finish on
 * behalf of a session that no longer existed. Companion rows are one delivery, so the closure
 * below always cancels both halves together. A browser send already past Send authorization is
 * intentionally labelled ambiguous; it is never retried, while the native Stop request handles
 * the exact currently generating turn separately.
 */
export function cancelSessionInputs(sessionId: string): Promise<number> {
  return serial(async () => {
    const current = await load();
    const owned = new Set(
      current
        .filter((row) => row.sessionId === sessionId || row.decisionSourceSessionId === sessionId)
        .map((row) => row.id)
    );
    // Either side of a combined input names the other. Close transitively so corrupt/legacy
    // directionality can never leave one half deliverable.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const row of current) {
        if (!owned.has(row.id) && row.companionInputId && owned.has(row.companionInputId)) {
          owned.add(row.id); expanded = true;
        } else if (owned.has(row.id) && row.companionInputId && !owned.has(row.companionInputId)) {
          owned.add(row.companionInputId); expanded = true;
        }
      }
    }
    let cancelled = 0;
    const next = current.map((row): InputEntry => {
      if (!owned.has(row.id)) return row;
      if (pendingStages(row)) {
        cancelled += 1;
        return { ...row, stagesApplied: true, error: 'Remaining staged work cancelled because its conversation was deleted.' };
      }
      if (terminal(row)) return row;
      cancelled += 1;
      const uncertain = row.state === 'tool' || row.state === 'decision' ||
        (row.state === 'browser' && row.sendAuthorizedAt !== undefined);
      return {
        ...row,
        state: 'cancelled',
        response: undefined,
        error: uncertain
          ? 'Cancelled because its conversation was deleted. Delivery already in progress may have reached ChatGPT; it will not be retried.'
          : 'Not sent: cancelled because its conversation was deleted.'
      };
    });
    if (cancelled > 0) await commit(next);
    for (const row of current) {
      if (!owned.has(row.id)) continue;
      decisionWaiters.get(row.id)?.reject(new Error('goal_browser_cancelled: source conversation deleted'));
      decisionWaiters.delete(row.id);
    }
    return cancelled;
  });
}

/**
 * Adapted from upstream #1311 (Haz4rdovisk): an exact positive provider deletion ends only
 * deliveries still proven unsent. Send-authorized, legacy browser, tool, decision and native
 * receipts retain their original custody, so a late ACK or Temporary Chat enrichment survives.
 * Companion halves are one transaction; a single uncertain half protects the entire delivery.
 */
export function failInputsForDeletedConversation(conversationId: string): Promise<number> {
  return serial(async () => {
    const current = await load();
    const ended = new Set<string>(), inspected = new Set<string>();
    const destinations = new Map<string, string | null>();
    for (const row of current) {
      let destination = row.conversationId;
      if (row.sessionId) {
        const session = await getSession(row.sessionId);
        if (!session || (destination && session.conversationId !== destination)) destination = null;
        else destination = session.conversationId;
      }
      destinations.set(row.id, destination);
    }
    for (const row of current) {
      if (inspected.has(row.id) || destinations.get(row.id) !== conversationId) continue;
      const group = new Set([row.id]);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const value of current) {
          if (group.has(value.id) && value.companionInputId && !group.has(value.companionInputId)) {
            group.add(value.companionInputId); expanded = true;
          } else if (value.companionInputId && group.has(value.companionInputId) && !group.has(value.id)) {
            group.add(value.id); expanded = true;
          }
        }
      }
      for (const id of group) inspected.add(id);
      const delivery = current.filter(value => group.has(value.id));
      if (delivery.length !== group.size || delivery.some(value => destinations.get(value.id) !== conversationId ||
          value.sendAuthorizedAt !== undefined || value.deliveredAt !== undefined || value.messageId !== undefined ||
          value.toolReceiptUncertain === true || !((value.state === 'queued' && value.owner === null && value.offeredAt === undefined) ||
            (value.state === 'browser' && value.requiresAuthorization === true)))) continue;
      for (const id of group) ended.add(id);
    }
    if (ended.size) await commit(current.map(row => ended.has(row.id) ? {
      ...row, state: 'failed' as const, owner: null, error: CONVERSATION_DELETED
    } : row));
    for (const id of ended) {
      decisionWaiters.get(id)?.reject(new Error(`goal_browser_send_failed: ${CONVERSATION_DELETED}`));
      decisionWaiters.delete(id);
    }
    const retained = current.filter(row => destinations.get(row.id) === conversationId && !ended.has(row.id)).length;
    logWarn(`input: ChatGPT positively deleted exact conversation ${conversationId}; retired ${ended.size} confirmed-unsent delivery row(s), retained ${retained} row(s) under existing uncertain/native custody`);
    return ended.size;
  });
}

/** Editing is possible only before handout; claimed text is immutable. */
export function reorderQueuedInputs(sessionId: string, ids: string[]): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const queue = current.filter(row => row.sessionId === sessionId && queuedFollowup(row) && row.state === 'queued');
    // A stale snapshot must not move claimed input or omit newly queued work.
    if (!ids.length || ids.length !== queue.length || new Set(ids).size !== ids.length ||
        queue.some(row => !ids.includes(row.id))) return false;
    const positions = new Map(ids.map((id, index) => [id, index]));
    const ticket = queue.find(row => row.silenceBoundary)?.silenceBoundary;
    await commit(current.map(row => positions.has(row.id) ? { ...row, queueOrder: positions.get(row.id)!,
      ...(ticket ? { silenceBoundary: row.id === ids[0] ? ticket : undefined } : {}) } : row));
    return true;
  });
}

/** Called inside the existing serialized settings transaction after publishing Off
 * and before re-enabling On (also recovering a failed earlier retirement).
 * A later On cannot revive these durable cancellations, even across restart. */
export function cancelFinishInputs(periodicOnly: boolean): Promise<void> {
  return serial(async () => {
    const current = await load();
    const next = current.map(row => row.finishOwner && (!periodicOnly || row.finishOwner.periodic) && !terminal(row)
      ? { ...row, state: 'cancelled' as const, error: 'Automatic follow-up cancelled by settings. Already offered input may have reached ChatGPT.' } : row);
    if (next.some((row, index) => row !== current[index])) await commit(next);
  });
}

export function editQueuedInput(id: string, text: string, afterTurn?: boolean): Promise<boolean> {
  return serial(async () => {
    const value = inputArgs.shape.text.parse(text);
    const current = await load();
    // The global Delivery queue is the user's durable outbox, not just the later-stage task
    // list. Any ordinary message that Chrome has not claimed yet is safe to edit in place.
    // Decision helpers remain internal, and browser/tool custody stays immutable.
    const row = current.find(entry => entry.id === id && entry.state === 'queued' &&
      entry.owner === null && entry.purpose !== 'decision' && !entry.workflow);
    if (!row) return false;
    if (current.filter(entry => !terminal(entry)).reduce((sum, entry) => sum + Buffer.byteLength(entry === row ? value : entry.text), 0) > 1024000) throw new Error('Queued messages exceed the text limit');
    await commit(current.map(entry => entry === row ? { ...row, text: value, ...(afterTurn === undefined ? {} : { afterTurn }), deliveryText: undefined } : entry));
    return true;
  });
}

/** Explicitly revisit one pre-Send message that yielded the global browser lane.
 *
 * Operator retries use the stricter form so their read-only CLI preflight cannot race a browser
 * claim, Send authorization, or another Retry. The serializer grants that command only when this
 * invocation actually consumes the still-present attention fence. Interactive callers retain the
 * current stale-state projection so their UI can reconcile an already-changed row.
 */
export function rearmQueuedBrowserInput(
  id: string,
  requireAttentionFence = false,
  operatorReceipt?: string
): Promise<InputEntry | null> {
  return serial(async () => {
    if (requireAttentionFence !== (operatorReceipt !== undefined)) {
      throw new Error('A strict queued-input Retry requires exactly one operation receipt');
    }
    const receipt = operatorReceipt === undefined
      ? undefined
      : entrySchema.shape.operatorRetryReceipt.parse(operatorReceipt);
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'queued' && entry.owner === null &&
      manualInput(entry) && entry.deliveryAttentionAt !== undefined &&
      (!requireAttentionFence || (entry.transportIntent !== 'tool' && entry.offeredAt === undefined &&
        entry.sendAuthorizedAt === undefined && entry.deliveredAt === undefined && entry.messageId === undefined)));
    if (!row) return requireAttentionFence ? null : current.find(entry => entry.id === id) ?? null;
    const browserHead = directBrowserHead(current);
    const next: InputEntry = { ...row, deliveryAttentionAt: undefined, browserEligibleAt: Date.now(),
      operatorRetryReceipt: receipt,
      queuedBehindBrowser: browserHead && browserHead.id !== row.id ? true : undefined, error: undefined };
    await commit(current.map(entry => entry.id === id ? next : entry));
    logInfo(`input ${id}: explicitly revisiting the exact message after it yielded a stale browser slot`);
    return { ...next };
  });
}

/** Revalidate the same durable claim immediately before sending; never hand out text again. */
export function authorizeBrowserInput(id: string, owner: string, conversationId: string | null): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(row => row.id === id && row.owner === owner && row.state === 'browser' && row.conversationId === conversationId);
    if (!row || row.sendAuthorizedAt !== undefined || companionOf(current, row) || !workflowInputReady(row, current)) return false;
    // Preparation and authorization independently enforce the exact same frozen bytes.
    // Legacy/uncertain claims are held, never rewritten or replayed to add a missing wrapper.
    assertOperatorPromptEnvelope(row.deliveryText ?? row.text);
    const forward = await deliveryHooks?.settledTurnForwardReadiness?.(row, current);
    if (forward === false) return false;
    const idleProbe = !!row.sessionId && await manualIdleBrowserProbeAllowed(row, await sessionInputPolicy(row.sessionId));
    // Native ingestion does not share Input's serializer. Retain the idle-only admission
    // across awaited scope/history checks; a new native turn must not become steering
    // authority for this already-claimed probe.
    const idleProbeCurrent = async (): Promise<boolean> => !idleProbe ||
      (!!row.sessionId && await manualIdleBrowserProbeAllowed(row, await sessionInputPolicy(row.sessionId)));
    if (!(await browserInputAllowed(row)) || await target(row) !== conversationId) return false;
    if (row.companionInputId) {
      const companion = current.find(other => other.id === row.companionInputId && other.state === 'browser' && other.owner === owner && other.sessionId === row.sessionId);
      const session = row.sessionId ? await getSession(row.sessionId) : null;
      if (!companion || !session || !queuedAfterTurn({ ...companion, state: 'queued' }, session)) return false;
    }
    if (row.purpose === 'decision' && browserDecisionHoldError()) return false;
    if (forward && !await forward()) return false;
    const scopeCurrent = async (): Promise<boolean> => {
      try { return (await deliveryHooks?.beforeAuthorizeNativeScope?.(row, current)) !== false; }
      catch { logWarn('native Input task-version authorization held: human task custody is unverified'); return false; }
    };
    if (!await scopeCurrent() || !await idleProbeCurrent() ||
        !current.filter(entry => sameDelivery(row, entry)).every(routedInputAllowed) ||
        (row.purpose === 'decision' && browserDecisionHoldError())) return false;
    await commit(current.map(entry => sameDelivery(row, entry) ? { ...entry, sendAuthorizedAt: Date.now() } : entry));
    if ((forward && !await forward()) || !await scopeCurrent() || !await idleProbeCurrent() ||
        !current.filter(entry => sameDelivery(row, entry)).every(routedInputAllowed) ||
        (row.purpose === 'decision' && browserDecisionHoldError())) {
      // This response has not left Main: this exact newly-created authorization is known
      // unsent. Restore only its pre-authorization row, retaining its exclusive browser owner.
      await commit(current);
      return false;
    }
    if (!row.sourceHelperId && row.completedTurnId && row.sessionId && conversationId)
      await consumeGoalReplyForInputNow(conversationId, row.sessionId, row.completedTurnId);
    return true;
  });
}
/** The same outbox serialization owns mode changes and browser ACK. A late ACK
 * must observe Off; an ACK that won first is followed by the exact bound-chat Off. */
export function setInputAutomation(id: string, automation: NonNullable<InputArgs['automation']>, loopAfterTurn?: boolean): Promise<boolean> {
  return serial(async () => {
    const mode = z.enum(['off', 'goal', 'loop']).parse(automation);
    const delivery = z.boolean().optional().parse(loopAfterTurn);
    const current = await load();
    const entry = current.find(row => row.id === id && row.purpose !== 'decision' && ['queued', 'browser', 'sent', 'tool'].includes(row.state));
    if (!entry || (entry.workflow && mode !== 'off')) return false;
    const conversationId = entry.conversationId;
    if (conversationId && await conversationWasSuperseded(conversationId)) return false;
    const sessionId = entry.sessionId ?? entry.deliveredSessionId;
    if (sessionId && (await getSession(sessionId))?.conversationId !== conversationId) return false;
    await commit(current.map(row => row === entry ? { ...row, automation: mode,
      ...(delivery === undefined ? {} : { loopAfterTurn: delivery }) } : row));
    if (conversationId && (mode === 'off' || entry.state !== 'queued')) {
      if (!deliveryHooks) throw new Error('Input delivery is not ready');
      // Mode changes preserve the chat's current objective. Only the delivery
      // transition transfers the opening text; an old outbox row must not overwrite
      // an objective the user edited after this message was delivered.
      await deliveryHooks.applyAutomation(conversationId, mode, entry.state === 'sent' ? 'after-send' : 'before-send', undefined, delivery);
    }
    return true;
  });
}
export function noteInputStartupError(id: string, error: string | null): Promise<InputEntry | null> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id);
    if (!row) return null;
    if (row.state !== 'queued') return { ...row };
    const next = { ...row, error: error ? error.slice(0, 200) : undefined };
    await commit(current.map(entry => entry === row ? next : entry));
    return { ...next };
  });
}
/** The same exact source boundary must still apply at claim and final Send authorization. */
async function eligibleStageEnd(entry: InputEntry): Promise<string | null> {
  if (!entry.sessionId) return null;
  const session = await getSession(entry.sessionId);
  if (!session || session.origin?.kind === 'worker') return null;
  const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  // A later native final cannot erase an actual busy rejection. Keep this
  // existing delay for the exact source turn until its native retry is due.
  if (entry.silenceBoundary?.nativeBusy && (entry.silenceBoundary.listenUntil ?? 0) > Date.now()) return null;
  // Explicit corrections bypass only the failed-view wait. Ordinary silence still
  // needs its confirmed refresh, and fresh work/in-flight custody always veto Send.
  if (manualInput(entry) && !session.activeTurnId && end?.kind === 'turn_end' && end.turnId &&
      end.outcome === 'failed' && end.reason === 'thinking_failed' &&
      (session.lastToolCallAt ?? 0) <= end.time && session.conversationId &&
      !isChatBlocked(session.conversationId) && inFlightToolCalls(session.conversationId) === 0) return end.turnId;
  if (entry.silenceBoundary) {
    const boundary = entry.silenceBoundary;
    if (session.conversationId !== boundary.conversationId || isChatBlocked(boundary.conversationId) ||
        (session.activeTurnId && session.activeTurnId !== boundary.turnId) || callsHoldRecovery(boundary.conversationId)) return null;
    if (end?.turnId !== boundary.turnId) return null;
    if (!(end.kind === 'turn_end' && end.outcome === 'completed') &&
        !await turnHasMcpCall(entry.sessionId, boundary.conversationId, boundary.turnId)) return null;
    if (end.kind !== 'turn_end' || end.outcome !== 'completed') {
      if ((boundary.listenUntil ?? 0) > Date.now() ||
          (end.kind === 'turn_end' && (session.lastToolCallAt ?? 0) > end.time)) return null;
      const [work] = await readRecentEvents(entry.sessionId, 1, { kinds: INPUT_WORK_KINDS });
      return work && workSequence(work) === boundary.workSeq ? boundary.turnId : null;
    }
    // A real final supersedes the silence assumption and spends the same source turn.
  }
  if (session.activeTurnId) return null;
  // A failure releases manual input immediately. Automatic follow-ups require
  // the confirmed refresh ticket above; only a real completion bypasses it.
  if (end?.kind !== 'turn_end' || end.outcome !== 'completed' || !end.turnId) return null;
  // Upstream56b912fc: a validated silence ticket names the exact turn already checked
  // above. Its completion may precede queue admission; another turn keeps the time fence.
  const completedSilenceSource = entry.silenceBoundary?.conversationId === session.conversationId &&
    entry.silenceBoundary.turnId === end.turnId;
  if (!completedSilenceSource && end.time < entry.createdAt) return null;
  if (!(await sessionInputPolicy(entry.sessionId)).settled) return null;
  return end.turnId;
}
const INPUT_WORK_KINDS: import('../../shared/session.js').SessionEvent['kind'][] =
  ['user_message', 'assistant_message', 'tool_call', 'page_tool', 'turn_start', 'turn_end'];

function queuedAfterTurn(row: InputEntry, session: SessionSummary): boolean {
  const astra = session.selectedModel?.conversationId === session.conversationId &&
    isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort);
  return row.sessionId === session.id && (queuedFollowup(row) || (manualInput(row) && row.offeredAt === undefined)) && row.state === 'queued' && row.dueAt <= Date.now() &&
    (row.mode !== 'finish' || row.afterTurn === true || !astra);
}
export async function hasQueuedAfterTurnInput(sessionId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  return !!session && (await load()).some(row => queuedAfterTurn(row, session));
}

/** Read the same visible head as claims, including its still-running listening window.
 * Historical restored tickets without an acceptance timestamp never arm browser recovery. */
export function pendingQueuedPickups(): Promise<Array<{ conversationId: string; sessionId: string; sourceTurnId: string; acceptedAt: number; listenUntil: number; pro: boolean }>> {
  return serial(async () => {
    const rows = await load();
    const result: Array<{ conversationId: string; sessionId: string; sourceTurnId: string; acceptedAt: number; listenUntil: number; pro: boolean }> = [];
    const pending = ordered(rows).filter(row => row.sessionId && row.purpose !== 'decision' && ['queued', 'browser', 'tool'].includes(row.state));
    for (const sessionId of new Set(pending.map(row => row.sessionId))) {
      const candidates = pending.filter(row => row.sessionId === sessionId);
      const row = candidates.find(row => manualInput(row) && row.silenceBoundary) ?? candidates[0]!;
      if (!row.sessionId) continue;
      if (row.state !== 'queued' || (!queuedFollowup(row) && !manualInput(row)) || row.dueAt > Date.now()) continue;
      const session = await getSession(row.sessionId);
      if (!session?.conversationId || !queuedAfterTurn(row, session)) continue;
      const probe = row.silenceBoundary ? { ...row, silenceBoundary: { ...row.silenceBoundary, listenUntil: undefined } } : row;
      const sourceTurnId = await eligibleStageEnd(probe);
      if (!sourceTurnId || rows.some(other => other.sessionId === row.sessionId &&
          (other.completedTurnId === sourceTurnId || other.state === 'browser' || other.state === 'tool'))) continue;
      const [end] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
      const completed = end?.kind === 'turn_end' && end.outcome === 'completed';
      const acceptedAt = row.silenceBoundary?.acceptedAt ?? (!row.silenceBoundary && completed ? end.time : undefined);
      if (acceptedAt === undefined) continue;
      const selection = session.selectedModel;
      result.push({ conversationId: session.conversationId, sessionId: row.sessionId, sourceTurnId, acceptedAt,
        listenUntil: completed && !row.silenceBoundary?.nativeBusy ? 0 : row.silenceBoundary?.listenUntil ?? 0,
        pro: selection?.conversationId === session.conversationId && isProModel(selection.model, selection.reasoningEffort) });
    }
    return result;
  });
}

/** The visible outbox precedes automatic Goal work, including an ineligible head.
 * A spent completion also belongs to its user input after that row leaves the queue. */
export function inputBeforeGoal(sessionId: string, sourceTurnId?: string): Promise<'queued' | 'consumed' | null> {
  return serial(async () => {
    const rows = await load();
    if (rows.some(row => row.sessionId === sessionId && row.purpose !== 'decision' &&
      ['queued', 'browser', 'tool'].includes(row.state))) return 'queued';
    return sourceTurnId && rows.some(row => row.sessionId === sessionId && row.completedTurnId === sourceTurnId &&
      (row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined || row.requiresAuthorization === false)) ? 'consumed' : null;
  });
}

/** A native-only queue head needs the held answer to finish before it can send. */
export function finishNeedsBrowserInput(sessionId: string): Promise<boolean> {
  return serial(async () => {
    const head = ordered(await load()).find(row => row.sessionId === sessionId && row.purpose !== 'decision' &&
      ['queued', 'browser', 'tool'].includes(row.state));
    if (!head || head.state !== 'queued' || head.dueAt > Date.now() ||
      !(head.mode === 'after-turn' || (head.attachments?.length && head.attachmentDelivery !== 'tool'))) return false;
    const session = await getSession(sessionId);
    return !!session && queuedAfterTurn(head, session);
  });
}

/** File on the existing outbox row, never in a parallel retry/ticket ledger. */
export function fileSilenceInput(sessionId: string, conversationId: string, turnId: string, currentOwner: () => boolean, listenUntil?: number): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const session = await getSession(sessionId);
    if (!currentOwner() || !session || session.conversationId !== conversationId || isChatBlocked(conversationId) ||
        session.origin?.kind === 'worker' || session.origin?.kind === 'helper' || callsHoldRecovery(conversationId)) return false;
    const [boundary] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    // The producer's exact MCP grant and elapsed silence window own this pickup;
    // a provider-authored end may already have closed the recorder's projection.
    if (!boundary || boundary.turnId !== turnId || (boundary.kind !== 'turn_start' && boundary.kind !== 'turn_end')) return false;
    if (!await turnHasMcpCall(sessionId, conversationId, turnId) || !currentOwner()) return false;
    if (current.some(row => row.sessionId === sessionId &&
      (row.completedTurnId === turnId || (row.silenceBoundary?.turnId === turnId && row.state === 'browser')))) return true;
    if (current.some(row => row.sessionId === sessionId && (row.state === 'browser' || row.state === 'tool'))) return false;
    const candidates = ordered(current).filter(row => row.sessionId === sessionId && row.state === 'queued');
    const row = candidates.find(row => manualInput(row) && row.offeredAt === undefined && row.dueAt <= Date.now()) ?? candidates.find(queuedFollowup);
    if (!row || !queuedAfterTurn(row, session)) return false;
    const [work] = await readRecentEvents(sessionId, 1, { kinds: INPUT_WORK_KINDS });
    if (!work || !currentOwner()) return false;
    const previous = current.find(entry => entry.sessionId === sessionId && entry.silenceBoundary?.turnId === turnId)?.silenceBoundary;
    const listening = Math.max(listenUntil ?? 0, previous?.listenUntil ?? 0);
    if (row.silenceBoundary?.turnId === turnId && row.silenceBoundary.workSeq === workSequence(work) &&
        (row.silenceBoundary.listenUntil ?? 0) === listening) return true;
    await commit(current.map(entry => entry === row ? { ...entry,
      recoveryWithdrawnSince: entry.silenceBoundary?.turnId === turnId ? entry.recoveryWithdrawnSince : undefined,
      recoveryWithdrawAttempts: entry.silenceBoundary?.turnId === turnId ? entry.recoveryWithdrawAttempts : undefined,
      silenceBoundary: { turnId, conversationId, workSeq: workSequence(work), acceptedAt: previous ? previous.acceptedAt : Date.now(), ...(listening ? { listenUntil: listening } : {}), ...(previous?.nativeBusy ? { nativeBusy: true } : {}) } }
      : entry.sessionId === sessionId && entry.state === 'queued' && entry.silenceBoundary?.turnId === turnId ? { ...entry, silenceBoundary: undefined } : entry));
    return true;
  });
}

/** Native Stop after refresh or settled failure extends listening, never Send authority. */
export function deferSilenceInput(id: string, conversationId: string, turnId: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'queued' && entry.offeredAt === undefined);
    if (!row?.sessionId || (await getSession(row.sessionId))?.conversationId !== conversationId || await eligibleStageEnd(row) !== turnId) return false;
    let boundary = row.silenceBoundary;
    if (!boundary) {
      // A manual failed-view send can be offered before automatic refresh. Its
      // first real busy rejection owns the same per-input delay, without MCP debt.
      const [end] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
      if (!manualInput(row) || end?.kind !== 'turn_end' || end.turnId !== turnId || end.outcome !== 'failed' || end.reason !== 'thinking_failed') return false;
      const [work] = await readRecentEvents(row.sessionId, 1, { kinds: INPUT_WORK_KINDS });
      if (!work) return false;
      boundary = { conversationId, turnId, workSeq: workSequence(work), acceptedAt: Date.now() };
    }
    if (boundary.conversationId !== conversationId || boundary.turnId !== turnId) return false;
    await commit(current.map(entry => entry === row ? { ...row,
      silenceBoundary: { ...boundary!, listenUntil: Date.now() + 5 * 60_000, nativeBusy: true } } : entry));
    return true;
  });
}

function withoutSilenceClaim(row: InputEntry, preserveBoundary = false): InputEntry {
  return { ...row, state: 'queued', owner: null, silenceBoundary: preserveBoundary ? row.silenceBoundary : undefined, completedTurnId: undefined,
    recoveryWithdrawnSince: preserveBoundary ? row.recoveryWithdrawnSince : undefined,
    recoveryWithdrawAttempts: preserveBoundary ? row.recoveryWithdrawAttempts : undefined,
    ...(manualInput(row) ? { transportIntent: 'tool' } : {}),
    companionInputId: undefined, offeredAt: undefined, sendAuthorizedAt: undefined, requiresAuthorization: undefined, deliveryText: undefined, error: undefined };
}
/** New work revokes an unspent ticket. Authorized sends retain custody until their exact receipt/failure. */
export function revokeSilenceInputs(sessionId: string): Promise<void> {
  return serial(async () => {
    const current = await load();
    const next = current.map(row => row.sessionId === sessionId && (row.silenceBoundary || row.completedTurnId) &&
      (row.state === 'queued' || (row.state === 'browser' && row.sendAuthorizedAt === undefined)) ? withoutSilenceClaim(row) : row);
    if (next.some((row, index) => row !== current[index])) await commit(next);
  });
}

/** Exact local observer boundary, never a verdict that native tools completed.
 * A completed observer may precede the later unaliased provider final (for example
 * after an older visible final claimed the short-lived local generation). Callers
 * still require the same fresh native question/final pair and confirmed Sent owner. */
export function ordinaryInputWatchdogBoundary(events: readonly SessionEvent[], user: SessionEvent, final: SessionEvent): {
  start: Extract<SessionEvent, { kind: 'turn_start' }>;
  end: Extract<SessionEvent, { kind: 'turn_end' }>;
  warning: Extract<SessionEvent, { kind: 'chat_error' }> | undefined;
  afterFinal?: true;
} | null {
  if (user.kind !== 'user_message' || final.kind !== 'assistant_message' || !user.messageId ||
      (final.inputReplyTo && final.inputReplyTo !== user.messageId)) return null;
  const later = events.filter(event => workSequence(event) > (user.origin ?? user.seq));
  const lifecycle = later.filter(event => ['turn_start', 'turn_end', 'handoff'].includes(event.kind));
  const errors = later.filter(event => event.kind === 'chat_error');
  const [start, end] = lifecycle, warning = errors[0];
  const finalPosition = final.finalContentSeq ?? final.origin ?? final.seq;
  if (lifecycle.length !== 2 || start?.kind !== 'turn_start' || end?.kind !== 'turn_end' ||
      start.turnId !== end.turnId) return null;
  // A late Resume question can make the page observer start AFTER its real final.
  // Preserve that exact stalled observer; callers still need immutable Resume
  // custody before using this exception to the ordinary source-origin ordering.
  if (!final.turnId && workSequence(start) > finalPosition && end.outcome === 'stalled' && errors.length === 0 &&
      end.detail === 'no visible output and no progress for five minutes' &&
      !later.some(event => event !== final &&
        (event.kind === 'user_message' ? event.origin ?? event.seq : workSequence(event)) > finalPosition &&
        !['turn_start', 'turn_end', 'progress'].includes(event.kind)))
    return { start, end, warning: undefined, afterFinal: true };
  if (workSequence(start) >= finalPosition) return null;
  if (end.outcome === 'completed' && errors.length === 0 && !final.turnId &&
      workSequence(end) < finalPosition) return { start, end, warning: undefined };
  return end.outcome === 'stalled' && errors.length === 1 &&
    warning?.kind === 'chat_error' && warning.reason === 'watchdog_stalled' && warning.turnId === start.turnId &&
    workSequence(start) < workSequence(warning) && workSequence(warning) < workSequence(end)
    ? { start, end, warning } : null;
}

/** Same ordering as Resume: canonical answer -> Goal cursor -> consume-once Sent receipt.
 * No conversation observation lock may be held while entering the Input owner. */
export function rememberOrdinaryInputFinalNow(sessionId: string, conversationId: string, replyId: string): Promise<void> {
  return serial(async () => {
    const current = await load();
    const user = await readLatestUserMessage(sessionId);
    const final = (await readRecentEvents(sessionId, 256, { kinds: ['assistant_message'] }))
      .findLast(event => event.kind === 'assistant_message' && event.messageId === replyId);
    const cursor = snapshotGoalReplies().replies.find(row => row.sessionId === sessionId && row.conversationId === conversationId);
    if (user?.kind !== 'user_message' || !user.messageId || user.message.truncated || user.inputDelivery !== 'confirmed' ||
        final?.kind !== 'assistant_message' || final.messageId !== replyId || final.providerMessageId !== replyId ||
        final.inputReplyTo !== user.messageId || final.goalEligible !== true || !final.final || final.state !== 'final' ||
        cursor?.replyId !== replyId || cursor.turnId !== 'reply:' + replyId ||
        (await getSession(sessionId))?.conversationId !== conversationId) return;
    const rows = current.filter(row => row.id === user.inputId && row.state === 'sent' && row.purpose !== 'decision' &&
      row.conversationId === conversationId && (row.sessionId ?? row.deliveredSessionId) === sessionId &&
      row.messageId === user.messageId && row.owner && Number.isFinite(row.deliveredAt) &&
      row.historyRecorded === true && row.historyProjectionVersion === 1);
    if (rows.length !== 1) return;
    const receipt = rows[0]!;
    if (receipt.acceptedNativeFinal) {
      if (receipt.acceptedNativeFinal.replyId !== replyId) throw new Error('ordinary_final_receipt_conflict');
      return;
    }
    await commit(current.map(row => row === receipt ? { ...row,
      acceptedNativeFinal: { replyId, acceptedAt: cursor.acceptedAt } } : row));
  });
}

/** A native final may lack its document-local generation alias. Only the exact Sent/native
 * question/final proof may retain its reply cursor or matching watchdog owner. Neither an
 * arbitrary cursor nor this forward permission certifies missing tool completion. */
async function ordinaryInputTerminalTurn(sessionId: string, conversationId: string, turnId: string,
  rows: readonly InputEntry[], ignoredIds: readonly string[],
  settledNativeSource?: Readonly<{ sourceUserMessageId: string; finalMessageId: string }>,
  retainedHelperCreatedAt?: number): Promise<string | null> {
  const match = /^reply:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(turnId);
  if ((!match && !settledNativeSource && retainedHelperCreatedAt === undefined) || continuationForSession(sessionId) ||
      (retainedHelperCreatedAt === undefined && callsHoldRecovery(conversationId)) ||
      await conversationWasSuperseded(conversationId)) return null;
  const session = await getSession(sessionId);
  if (session?.conversationId !== conversationId || session.activeTurnId ||
      session.origin?.kind === 'worker' || session.origin?.kind === 'helper') return null;
  const events = await readRecentEvents(sessionId, 256, { kinds: [
    'user_message', 'assistant_message', 'turn_start', 'turn_end', 'page_tool', 'tool_call', 'handoff', 'chat_error'
  ] });
  const expectedNativeFinal = match?.[1] ?? settledNativeSource?.finalMessageId;
  const final = events.findLast(event => event.kind === 'assistant_message' &&
    (!expectedNativeFinal || event.messageId === expectedNativeFinal));
  const user = events.findLast(event => event.kind === 'user_message') ?? await readLatestUserMessage(sessionId);
  // Only the exact accepted helper's positively-unsent withdrawal may retain
  // canonical source identity while its own preparation temporarily hides the
  // native idle marker. Claim/Send never receives this exception. Semantic edits
  // after that helper was created revoke retention; metadata enrichment does not.
  const retaining = retainedHelperCreatedAt !== undefined;
  if (retaining && (!Number.isFinite(retainedHelperCreatedAt) || retainedHelperCreatedAt <= 0 ||
      final?.kind !== 'assistant_message' || user?.kind !== 'user_message' ||
      (final.semanticUpdatedAt ?? final.time) > retainedHelperCreatedAt ||
      (user.semanticUpdatedAt ?? user.time) > retainedHelperCreatedAt)) return null;
  const settledSource = settledNativeSource ?? (retaining && final?.kind === 'assistant_message' &&
    user?.kind === 'user_message' && user.messageId
    ? { sourceUserMessageId: user.messageId, finalMessageId: final.messageId } : undefined);
  // A watchdog ends local observation, not the provider's answer. A later exact
  // native final may lack inputReplyTo. The settled-forward owner supplies its
  // native pair; accepted-helper retention can preserve only that canonical source.
  const boundary = user && final ? ordinaryInputWatchdogBoundary(events, user, final) : null;
  const start = boundary?.start, end = boundary?.end, watchdog = boundary?.warning;
  const settledWatchdog = Boolean(boundary && settledSource && user?.kind === 'user_message' &&
    final?.kind === 'assistant_message' && settledSource.sourceUserMessageId === user.messageId &&
    settledSource.finalMessageId === final.messageId && (match !== null || start?.turnId === turnId));
  const expectedFinalId = match?.[1] ?? settledSource?.finalMessageId;
  const resumeReceipt = user?.kind === 'user_message' && user.messageId && !user.message.truncated
    ? await committedResumeNativeReceipt(sessionId, conversationId, user.messageId, user.message.text) : null;
  const postFinalResume = Boolean(resumeReceipt && boundary?.afterFinal);
  if ((!match && !settledWatchdog) || final?.kind !== 'assistant_message' || user?.kind !== 'user_message' ||
      final.messageId !== expectedFinalId || final.providerMessageId !== expectedFinalId || final.turnId || !final.final || final.state !== 'final' ||
      final.goalEligible !== true || (!settledWatchdog && (!final.inputReplyTo || final.inputReplyTo !== user.messageId)) ||
      !final.message.text.trim() || final.message.truncated ||
      user.message.truncated || (postFinalResume ? final.finalContentSeq ?? final.origin ?? final.seq : final.origin ?? final.seq) <=
        (user.origin ?? user.seq)) return null;
  const receipts = rows.filter(row => row.purpose !== 'decision' && row.id === user.inputId && row.state === 'sent' &&
    row.conversationId === conversationId && (row.sessionId ?? row.deliveredSessionId) === sessionId &&
    row.messageId === user.messageId && !!row.owner && Number.isFinite(row.deliveredAt) &&
    row.historyRecorded === true && row.historyProjectionVersion === 1);
  if (resumeReceipt?.acceptedDestinationFinal && resumeReceipt.acceptedDestinationFinal !== final.messageId) return null;
  const resumeEpochCurrent = (proof: NonNullable<typeof resumeReceipt>): boolean => {
    if (!proof.acceptedDestinationFinalEpochRevoked) return true;
    const pickup = goalPendingReplyFor(conversationId);
    return pickup?.sessionId === sessionId && pickup.turnId === turnId &&
      pickup.acceptedAt > proof.acceptedDestinationFinalAt!;
  };
  if (resumeReceipt && !resumeEpochCurrent(resumeReceipt)) return null;
  if (resumeReceipt) {
    const [latestBoundary] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end', 'handoff'] });
    if (latestBoundary && workSequence(latestBoundary) > (user.origin ?? user.seq) &&
        (!postFinalResume || latestBoundary.seq !== boundary!.end.seq)) return null;
  }
  if ((!resumeReceipt && (user.inputDelivery !== 'confirmed' || !user.inputId || receipts.length !== 1)) ||
      (resumeReceipt && (receipts.length > 0 || getConfig().ui.automationPaused === true || browserDecisionSignedOut))) return null;
  const receipt = receipts[0];
  if (receipt?.acceptedNativeFinal && receipt.acceptedNativeFinal.replyId !== final.messageId) return null;
  const deliveredAt = resumeReceipt?.openedAt ?? receipt!.deliveredAt!;
  const policy = snapshotGoalSwitches().switches.find(row => row.conversationId === conversationId);
  // A deliberate current On can owe the exact already-Sent reply again. Finite Goal
  // renewal requires its canonical reply UUID; Loop also retains its explicit failure
  // checkpoint. Bind both to the current durable pickup, never an old activation bit.
  const activation = policy && policy.at > deliveredAt
    ? snapshotGoalReplies().replies.find(row => row.conversationId === conversationId) : undefined;
  const renewedPolicy = Boolean(settledWatchdog &&
    (policy?.mode === 'loop' || (policy?.mode === 'goal' && match !== null)) &&
    activation?.state === 'pending' && activation.explicitActivation === true &&
    activation.sessionId === sessionId && activation.turnId === turnId && activation.acceptedAt >= policy.at &&
    activation.replyId === (match ? final.messageId : ('activation:' + turnId).slice(0, 200)) &&
    activation.eventSeq === (match ? final.finalContentSeq ?? final.origin ?? final.seq : end?.seq));
  if (!policy?.enabled || (policy.at > deliveredAt && !renewedPolicy) ||
      deliveredAt > Date.now() + 60_000 ||
      rows.some(row => !ignoredIds.includes(row.id) &&
        (row.sessionId === sessionId || row.deliveredSessionId === sessionId || row.decisionSourceSessionId === sessionId) &&
        (['queued', 'browser', 'tool', 'decision'].includes(row.state) ||
          (row.purpose !== 'decision' && row.id !== receipt?.id &&
            (row.deliveredAt ?? row.sendAuthorizedAt ?? 0) > deliveredAt)))) return null;
  const finalPosition = final.finalContentSeq ?? final.origin ?? final.seq;
  if (events.some(event => {
    const position = event.kind === 'assistant_message' ? event.finalContentSeq ?? event.origin ?? event.seq
      : event.kind === 'user_message' ? event.origin ?? event.seq : workSequence(event);
    return (position > (user.origin ?? user.seq) && ['turn_start', 'turn_end', 'handoff'].includes(event.kind) &&
        !(settledWatchdog && (event === start || event === end))) ||
      (position > finalPosition && event !== final && !(settledWatchdog &&
        (event === watchdog || event === end || (postFinalResume && event === start))));
  })) return null;
  // Last await closes the observation race; current policy and live custody are checked after it.
  const latest = await getSession(sessionId);
  if (resumeReceipt) {
    const currentResume = await committedResumeNativeReceipt(sessionId, conversationId, user.messageId!, user.message.text);
    if (getConfig().ui.automationPaused === true || browserDecisionSignedOut || !currentResume ||
        !resumeEpochCurrent(currentResume)) return null;
  }
  const currentPolicy = snapshotGoalSwitches().switches.find(row => row.conversationId === conversationId);
  const currentActivation = renewedPolicy ? goalPendingReplyFor(conversationId) : null;
  return (!renewedPolicy || (currentActivation?.sessionId === sessionId && currentActivation.turnId === turnId &&
    currentActivation.replyId === activation!.replyId && currentActivation.eventSeq === activation!.eventSeq &&
    currentActivation.acceptedAt === activation!.acceptedAt)) && latest?.conversationId === conversationId && latest.events === session.events && !latest.activeTurnId &&
    !continuationForSession(sessionId) && (retaining || !callsHoldRecovery(conversationId)) && !isChatBlocked(conversationId) &&
    JSON.stringify(currentPolicy) === JSON.stringify(policy) ? turnId : null;
}

/** Goal's existing atomic handoff reservation uses the same read-only source proof as Send. */
export async function ordinaryInputTerminalReply(sessionId: string, conversationId: string, turnId: string,
  options: { inputRows?: readonly InputEntry[]; ignoreInputIds?: readonly string[];
    settledNativeSource?: Readonly<{ sourceUserMessageId: string; finalMessageId: string }> } = {}): Promise<boolean> {
  return await ordinaryInputTerminalTurn(sessionId, conversationId, turnId,
    options.inputRows ?? await load(), options.ignoreInputIds ?? [], options.settledNativeSource) === turnId;
}

/** The source final predates an answer-generated instruction. Reuse the exact
 * source/UUID proof for handout AND irreversible native Send authorization. */
async function sourceHelperContinuationTurn(entry: InputEntry, rows?: InputEntry[],
  options: { retainDuringActivity?: boolean } = {}): Promise<string | null> {
  if (!entry.sourceHelperId || !entry.sessionId || !entry.conversationId) return null;
  const current = rows ?? await load();
  const helper = current.find(row => row.id === entry.sourceHelperId);
  if (helper?.state !== 'sent' || helper.purpose !== 'decision' ||
      helper.lifetime !== 'temporary-planner' ||
      helper.decisionSourceSessionId !== entry.sessionId ||
      !helper.decisionSourceTurnId) return null;
  // Supersession may yield while a new human instruction or source owner arrives.
  // Read the current source and full debt identity after that await, rather than
  // borrowing an earlier session/turn snapshot merely because its epoch matches.
  if (await conversationWasSuperseded(entry.conversationId)) return null;
  const session = await getSession(entry.sessionId);
  const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['user_message', 'turn_start', 'turn_end'] });
  const owed = goalPendingReplyFor(entry.conversationId);
  let fallbackReceipt: Awaited<ReturnType<typeof committedResumeNativeReceipt>> = null;
  const evictedCursorStillCurrent = (receipt: NonNullable<typeof fallbackReceipt>): boolean => {
    if (receipt.acceptedDestinationFinalEpochRevoked || goalPendingReplyFor(entry.conversationId!)) return false;
    const savedCursor = snapshotGoalReplies().replies.find(row => row.conversationId === entry.conversationId);
    return !savedCursor || (savedCursor.state === 'handled' && savedCursor.explicitActivation !== true && savedCursor.sessionId === entry.sessionId &&
      savedCursor.replyId === receipt.acceptedDestinationFinal && savedCursor.turnId === helper.decisionSourceTurnId &&
      savedCursor.acceptedAt > receipt.acceptedDestinationFinalAt!);
  };
  if (session?.conversationId !== entry.conversationId || session.activeTurnId ||
      !goalArmedFor(entry.conversationId) || isChatBlocked(entry.conversationId) ||
      (!options.retainDuringActivity && callsHoldRecovery(entry.conversationId))) return null;
  if (entry.sourceHelperAcceptedAt !== undefined && (owed?.sessionId !== entry.sessionId ||
      owed.turnId !== helper.decisionSourceTurnId || owed.acceptedAt !== entry.sourceHelperAcceptedAt)) {
    // Only an already-created visible continuation can survive eviction of its bounded Goal
    // cursor. The WAL supplies the original UUID/epoch, not a fresh decision or private body.
    if (owed || !helper.decisionSourceTurnId.startsWith('reply:') || !['queued', 'browser'].includes(entry.state) ||
        entry.sendAuthorizedAt !== undefined || entry.messageId !== undefined || entry.deliveredAt !== undefined ||
        (entry.state === 'queued' ? entry.owner !== null : !entry.owner || entry.requiresAuthorization !== true) ||
        current.filter(row => row.sourceHelperId === helper.id).length !== 1) return null;
    const user = await readLatestUserMessage(entry.sessionId);
    if (user?.kind !== 'user_message' || !user.messageId || user.message.truncated) return null;
    const receipt = await committedResumeNativeReceipt(entry.sessionId, entry.conversationId, user.messageId, user.message.text);
    if (!receipt || helper.decisionSourceTurnId !== `reply:${receipt.acceptedDestinationFinal}` ||
        receipt.acceptedDestinationFinalAt !== entry.sourceHelperAcceptedAt) return null;
    // A post-eviction same-final replay can retain a handled-only cursor. It is not a new epoch
    // for the outgoing; a real prior handled/pending/re-activated cursor remains authoritative.
    if (!evictedCursorStillCurrent(receipt)) return null;
    fallbackReceipt = receipt;
  }
  if (helper.decisionSourceTurnId.startsWith('reply:')) {
    if (entry.sourceHelperAcceptedAt === undefined || !helper.owner || !helper.messageId ||
        !Number.isFinite(helper.deliveredAt) || !recoveryContinuationEligibility(helper).allowed) return null;
    let terminal = await ordinaryInputTerminalTurn(entry.sessionId, entry.conversationId, helper.decisionSourceTurnId,
      current, [entry.id, helper.id], undefined, options.retainDuringActivity ? helper.createdAt : undefined);
    if (!terminal && !options.retainDuringActivity) {
      const forward = await deliveryHooks?.settledTurnForwardReadiness?.(entry, current);
      if (forward && await forward()) terminal = helper.decisionSourceTurnId;
    }
    const latestOwed = goalPendingReplyFor(entry.conversationId);
    const epochCurrent = fallbackReceipt ? evictedCursorStillCurrent(fallbackReceipt)
      : latestOwed?.sessionId === entry.sessionId && latestOwed.turnId === helper.decisionSourceTurnId &&
        latestOwed.acceptedAt === entry.sourceHelperAcceptedAt;
    return epochCurrent && goalArmedFor(entry.conversationId) ? terminal : null;
  }
  if (end?.kind === 'turn_end' && end.outcome === 'stopped' && end.turnId === helper.decisionSourceTurnId &&
      helperNativeSendConfirmed(helper) && deliberateStoppedLoopResumeFor(entry.sessionId, entry.conversationId, end.turnId)) {
    const forward = await deliveryHooks?.settledTurnForwardReadiness?.(entry, current);
    return forward && await forward() ? end.turnId : null;
  }
  if (end?.kind === 'turn_end' && end.outcome === 'stalled' && end.turnId === helper.decisionSourceTurnId &&
      entry.sourceHelperAcceptedAt !== undefined && helperNativeSendConfirmed(helper)) {
    if (options.retainDuringActivity) {
      const terminal = await ordinaryInputTerminalTurn(entry.sessionId, entry.conversationId,
        helper.decisionSourceTurnId, current, [entry.id, helper.id], undefined, helper.createdAt);
      const latestOwed = goalPendingReplyFor(entry.conversationId);
      return latestOwed?.sessionId === entry.sessionId && latestOwed.turnId === helper.decisionSourceTurnId &&
        latestOwed.acceptedAt === entry.sourceHelperAcceptedAt && goalArmedFor(entry.conversationId) ? terminal : null;
    }
    const forward = await deliveryHooks?.settledTurnForwardReadiness?.(entry, current);
    return forward && await forward() ? end.turnId : null;
  }
  return end?.kind === 'turn_end' && end.outcome === 'completed' && end.turnId === helper.decisionSourceTurnId
    ? end.turnId : null;
}

export interface RetainedSourceHelperContinuation {
  inputId: string;
  sourceAcceptedAt: number;
}

// A real per-chat Resume can delegate execution of ONE positively never-offered
// legacy reply. This process-local lease is not a helper ACK, native result or
// human-acceptance receipt. Durable explicitActivation alone cannot recreate it.
const retainedExecutionResumes = new Map<string, {
  sessionId: string; conversationId: string; textSha256: string; helper: string;
  acceptedAt: number; replyId: string; eventSeq: number; turnId: string;
  source: string; policy: string; objectiveSha256: string;
}>();
const retainedExecutionTextHash = (text: string) => createHash('sha256').update(text).digest('hex');
function retainedHelperIdentity(helper: Readonly<InputEntry>): string {
  return JSON.stringify([helper.id, helper.state, helper.owner, helper.createdAt, helper.offeredAt,
    helper.sendAuthorizedAt, helper.messageId, helper.deliveredAt, helper.decisionSourceSessionId, helper.decisionSourceTurnId]);
}
function retainedExecutionPolicy(conversationId: string): string {
  return JSON.stringify([snapshotGoalSwitches().switches.find(row => row.conversationId === conversationId), getConfig().goal]);
}
async function retainedExecutionSource(entry: InputEntry, rows: InputEntry[]): Promise<string | null> {
  if (getConfig().ui.automationPaused || browserDecisionSignedOut ||
      !await sourceHelperContinuationTurn(entry, rows)) return null;
  const before = await getSession(entry.sessionId!);
  const source = await readRecentEvents(entry.sessionId!, 1024, { kinds: [
    'user_message', 'assistant_message', 'turn_start', 'turn_end', 'tool_call', 'page_tool', 'handoff', 'chat_error'
  ] });
  const after = await getSession(entry.sessionId!);
  const pending = goalPendingReplyFor(entry.conversationId!);
  const user = source.findLast(event => event.kind === 'user_message');
  if (!before || !after || before.events !== after.events || after.activeTurnId ||
      after.conversationId !== entry.conversationId || !pending ||
      !user || user.kind !== 'user_message' || !user.messageId || user.message.truncated ||
      !source.some(event => event.kind === 'assistant_message' && event.messageId === pending.replyId &&
        event.source === 'extension' && event.final === true && event.state === 'final' && !event.message.truncated)) return null;
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}
/** Non-acceptance scope only; Input's normal claim/authorization/ACK owners remain binding.
 * Pickup may inspect the original failed, never-offered body before Goal rearms it.
 * It requires this same process-local Resume lease, never a durable flag alone. */
export async function retainedInputExecutionResumeFor(
  sessionId: string, conversationId: string, rows: readonly InputEntry[], entry: Readonly<InputEntry>,
  phase: 'execution' | 'pickup' = 'execution'
): Promise<boolean> {
  const lease = retainedExecutionResumes.get(entry.id);
  if (!lease) return false;
  const helper = rows.filter(row => row.id === entry.sourceHelperId);
  const current = () => {
    const pending = goalPendingReplyFor(conversationId);
    const policy = snapshotGoalSwitches().switches.find(row => row.conversationId === conversationId);
    return retainedExecutionResumes.get(entry.id) === lease && lease.sessionId === sessionId && lease.conversationId === conversationId &&
    entry.sessionId === sessionId && entry.conversationId === conversationId && retainedExecutionTextHash(entry.text) === lease.textSha256 &&
    (phase === 'pickup' ? retainedSourceHelperPreSendRetry(entry as InputEntry)
      : ['queued', 'browser'].includes(entry.state)) && entry.sendAuthorizedAt === undefined &&
    entry.messageId === undefined && entry.deliveredAt === undefined &&
    entry.sourceHelperAcceptedAt === lease.acceptedAt && helper.length === 1 &&
    retainedHelperIdentity(helper[0]!) === lease.helper && rows.filter(row => row.sourceHelperId === entry.sourceHelperId).length === 1 &&
    pending?.sessionId === sessionId && pending.acceptedAt === lease.acceptedAt &&
    pending.replyId === lease.replyId && pending.eventSeq === lease.eventSeq && pending.turnId === lease.turnId &&
    policy?.enabled === true && policy.mode === 'loop' &&
    retainedExecutionPolicy(conversationId) === lease.policy &&
    retainedExecutionTextHash(goalObjectiveFor(conversationId)) === lease.objectiveSha256;
  };
  if (!current() || await retainedExecutionSource(entry as InputEntry, rows as InputEntry[]) !== lease.source || !current()) return false;
  return true;
}

/**
 * Read-only eligibility for the browser's deliberate per-chat Resume action.
 *
 * It exposes no helper text. The row must be the sole exact positively pre-Send continuation,
 * and the incumbent source proof must still name the same completed turn. A newer pending
 * acceptance timestamp is allowed only as evidence of a previous deliberate activation of this
 * same stable turn; execution still requires a fresh explicit activation and the rebind below.
 */
export function retainedSourceHelperContinuationFor(options: {
  sessionId: string;
  conversationId: string;
  sourceTurnId: string;
  sourceAcceptedAt: number;
}): Promise<RetainedSourceHelperContinuation | null> {
  return serial(async () => {
    const rows = await load();
    const candidates = rows.filter(row => {
      const helper = retainedSourceHelperFor(rows, row);
      return !!helper && row.sessionId === options.sessionId && row.conversationId === options.conversationId &&
        helper.decisionSourceTurnId === options.sourceTurnId &&
        sourceHelperRetryEpochEligible(row.sourceHelperAcceptedAt!, options.sourceAcceptedAt, Date.now(), pristineSourceHelperQueued(row));
    });
    if (candidates.length !== 1) return null;
    const entry = candidates[0]!;
    if (await sourceHelperContinuationTurn({ ...entry, sourceHelperAcceptedAt: options.sourceAcceptedAt }, rows) !== options.sourceTurnId)
      return null;
    if (rows.some(row => row !== entry && row.sessionId === options.sessionId && row.purpose !== 'decision' &&
        ['queued', 'browser', 'tool'].includes(row.state))) return null;
    return { inputId: entry.id, sourceAcceptedAt: entry.sourceHelperAcceptedAt! };
  });
}

/**
 * Moves only the retained row's pickup epoch after the same stable Goal reply is deliberately
 * reactivated. The UUID, helper receipt and authored continuation remain unchanged. Failure is
 * non-destructive: the old exact row stays in attention for another deliberate attempt.
 */
export function rebindRetainedSourceHelperContinuation(options: {
  inputId: string;
  sessionId: string;
  conversationId: string;
  sourceTurnId: string;
  previousAcceptedAt: number;
  sourceAcceptedAt: number;
  /** Set only by the incumbent fresh operator Resume transaction, never background backfill. */
  deliberateResume?: boolean;
}): Promise<boolean> {
  return serial(async () => {
    const rows = await load();
    const entry = rows.find(row => row.id === options.inputId);
    if (!entry || entry.sessionId !== options.sessionId || entry.conversationId !== options.conversationId ||
        ![options.previousAcceptedAt, options.sourceAcceptedAt].includes(entry.sourceHelperAcceptedAt!) || !retainedSourceHelperFor(rows, entry)) return false;
    const pending = goalPendingReplyFor(options.conversationId);
    if (!goalArmedFor(options.conversationId) || pending?.sessionId !== options.sessionId ||
        pending.turnId !== options.sourceTurnId || pending.acceptedAt !== options.sourceAcceptedAt ||
        !sourceHelperRetryEpochEligible(options.previousAcceptedAt, options.sourceAcceptedAt, Date.now(), pristineSourceHelperQueued(entry)) ||
        await sourceHelperContinuationTurn({ ...entry, sourceHelperAcceptedAt: options.sourceAcceptedAt }, rows) !== options.sourceTurnId ||
        rows.some(row => row !== entry && row.sessionId === options.sessionId && row.purpose !== 'decision' &&
          ['queued', 'browser', 'tool'].includes(row.state))) return false;
    if (entry.sourceHelperAcceptedAt === options.sourceAcceptedAt) return true;
    const rebound = { ...entry, sourceHelperAcceptedAt: options.sourceAcceptedAt };
    const next = rows.map(row => row === entry ? rebound : row);
    await commit(next);
    const helper = retainedSourceHelperFor(rows, entry);
    const priorLease = retainedExecutionResumes.get(entry.id);
    const inherited = entry.state === 'queued' && priorLease?.acceptedAt === options.previousAcceptedAt &&
      priorLease.sessionId === options.sessionId && priorLease.conversationId === options.conversationId &&
      priorLease.textSha256 === retainedExecutionTextHash(entry.text) && helper && retainedHelperIdentity(helper) === priorLease.helper &&
      priorLease.policy === retainedExecutionPolicy(options.conversationId) &&
      priorLease.objectiveSha256 === retainedExecutionTextHash(goalObjectiveFor(options.conversationId));
    // Missing native helper receipts remain unknown. Only this newly advanced,
    // operator-owned pickup may prepare its exact already-saved, never-offered
    // message under an explicitly non-acceptance scope.
    if (options.deliberateResume === true && options.previousAcceptedAt < options.sourceAcceptedAt &&
        entry.owner === null && entry.offeredAt === undefined &&
        entry.sendAuthorizedAt === undefined && entry.deliveredAt === undefined && entry.messageId === undefined &&
        ((entry.state === 'failed' && /^(?:Native Input human authorship is unverified;|Native execution scope is incomplete;)/.test(entry.error ?? '')) || inherited) && helper?.owner) {
      const source = await retainedExecutionSource(rebound, next);
      const pending = goalPendingReplyFor(options.conversationId);
      if (source && (!inherited || source === priorLease!.source) &&
          pending?.acceptedAt === options.sourceAcceptedAt && pending.turnId === options.sourceTurnId) {
        for (const [id, lease] of retainedExecutionResumes)
          if (lease.conversationId === options.conversationId) retainedExecutionResumes.delete(id);
        if (retainedExecutionResumes.size >= 64) retainedExecutionResumes.delete(retainedExecutionResumes.keys().next().value!);
        retainedExecutionResumes.set(entry.id, { sessionId: options.sessionId, conversationId: options.conversationId,
          textSha256: retainedExecutionTextHash(entry.text), helper: retainedHelperIdentity(helper), acceptedAt: pending.acceptedAt,
          replyId: pending.replyId, eventSeq: pending.eventSeq, turnId: pending.turnId, source,
          policy: retainedExecutionPolicy(options.conversationId), objectiveSha256: retainedExecutionTextHash(goalObjectiveFor(options.conversationId)) });
        logInfo('input: exact never-offered legacy reply delegated by fresh Resume; helper ACK and human acceptance remain unverified');
      }
    }
    logInfo(`input ${entry.id}: rebound retained unsent continuation to the deliberately reactivated Goal pickup`);
    return true;
  });
}

/** Only this outgoing native receipt may discharge its exact Goal pickup. Claim,
 * authorization and browser Goal-draft ACK are preparation, not a sent instruction. */
async function reconcileSourceHelperDelivery(entry: InputEntry, rows: InputEntry[]): Promise<boolean> {
  if (!entry.sourceHelperId || entry.sourceHelperAcceptedAt === undefined || !entry.sessionId || !entry.conversationId ||
      entry.state !== 'sent' || !entry.owner || !entry.messageId || !Number.isFinite(entry.deliveredAt)) return false;
  const helper = rows.find(row => row.id === entry.sourceHelperId);
  if (helper?.state !== 'sent' || helper.purpose !== 'decision' || helper.lifetime !== 'temporary-planner' ||
      helper.decisionSourceSessionId !== entry.sessionId || !helper.decisionSourceTurnId ||
      (await getSession(entry.sessionId))?.conversationId !== entry.conversationId) return false;
  return confirmDeliveredGoalReplyNow(entry.conversationId, entry.sessionId, helper.decisionSourceTurnId,
    entry.messageId, entry.sourceHelperAcceptedAt, entry.id);
}

/** The accepted helper's visible continuation already has an outbox owner. Never ask another
 * helper to reconstruct private text or mint another delivery for this same source turn. */
export function retainSourceHelperContinuation(options: {
  sessionId: string; conversationId: string; sourceTurnId: string; sourceAcceptedAt: number;
  current(): boolean;
  /** Goal consumes its existing explicit activation durably BEFORE the same UUID is rearmed. */
  authorizeRetry?: () => Promise<boolean>;
}): Promise<'none' | 'held' | 'delivered' | 'attention'> {
  return serial(async () => {
    const rows = await load();
    const helperIds = new Set(rows.filter(row => row.purpose === 'decision' && row.lifetime === 'temporary-planner' &&
      row.state === 'sent' && row.decisionSourceSessionId === options.sessionId &&
      row.decisionSourceTurnId === options.sourceTurnId).map(row => row.id));
    const owned = rows.filter(row => row.sourceHelperId && helperIds.has(row.sourceHelperId) &&
      row.sessionId === options.sessionId && row.conversationId === options.conversationId);
    if (!owned.length) return 'none';
    if (owned.length !== 1) return 'attention'; // Conflicting saved answers are not a choice.
    const entry = owned[0]!;
    if (['queued', 'browser', 'tool', 'sent'].includes(entry.state)) {
      if (entry.sourceHelperAcceptedAt !== undefined && entry.sourceHelperAcceptedAt !== options.sourceAcceptedAt)
        return 'attention';
      if (entry.state === 'sent' && entry.messageId && Number.isFinite(entry.deliveredAt))
        return options.current() && await reconcileSourceHelperDelivery(entry, rows) ? 'delivered' : 'attention';
      return 'held';
    }
    const currentSource = async (): Promise<boolean> => {
      if (!options.current() || !goalArmedFor(options.conversationId) ||
          goalPendingReplyFor(options.conversationId)?.acceptedAt !== options.sourceAcceptedAt ||
          goalPendingReplyFor(options.conversationId)?.turnId !== options.sourceTurnId ||
          await sourceHelperContinuationTurn({ ...entry, sourceHelperAcceptedAt: options.sourceAcceptedAt }, rows) !== options.sourceTurnId) return false;
      // A new human message can precede its turn_start. It already revokes this older answer.
      const alias = options.sourceTurnId.startsWith('reply:');
      const [latest] = alias ? [] : await readRecentEvents(options.sessionId, 1, { kinds: ['user_message', 'turn_start', 'turn_end'] });
      const terminalCurrent = alias ? await sourceHelperContinuationTurn({ ...entry,
        sourceHelperAcceptedAt: options.sourceAcceptedAt }, rows) === options.sourceTurnId
        : latest?.kind === 'turn_end' && latest.outcome === 'completed' && latest.turnId === options.sourceTurnId;
      return terminalCurrent &&
        options.current() && goalArmedFor(options.conversationId) && !isChatBlocked(options.conversationId) &&
        !callsHoldRecovery(options.conversationId) &&
        goalPendingReplyFor(options.conversationId)?.acceptedAt === options.sourceAcceptedAt &&
        goalPendingReplyFor(options.conversationId)?.turnId === options.sourceTurnId &&
        !rows.some(row => row !== entry && row.sessionId === options.sessionId && row.purpose !== 'decision' &&
          ['queued', 'browser', 'tool'].includes(row.state));
    };
    if (!retainedSourceHelperPreSendRetry(entry) || !options.authorizeRetry ||
        !await currentSource() || !await options.authorizeRetry() || !await currentSource()) return 'attention';
    await commit(rows.map(row => row === entry ? { ...entry, state: 'queued' as const,
      sourceHelperAcceptedAt: options.sourceAcceptedAt,
      preSendReoffers: 0, requiresAuthorization: undefined, deliveryAttentionAt: undefined,
      recoveryWithdrawAttempts: undefined, recoveryWithdrawnSince: undefined,
      completedTurnId: undefined, deliveryText: undefined, error: undefined,
      dueAt: Date.now(), browserEligibleAt: Date.now() } : row));
    logInfo(`input ${entry.id}: explicit Goal activation rearmed the same confirmed-pre-Send continuation from helper ${entry.sourceHelperId}`);
    return 'held';
  });
}
/** Metadata only. Text is disclosed to one document only after an exclusive durable claim. */
async function completedStageBoundary(entry: InputEntry, current: InputEntry[]): Promise<string | null> {
  if (!entry.sessionId || !queuedFollowup(entry)) return null;
  // Match the displayed order. A finish-only/file/delayed head cannot be silently
  // skipped by a later after-turn row just because that transport is ready first.
  const first = ordered(current).find(row => row.sessionId === entry.sessionId && queuedFollowup(row) && row.state === 'queued' && workflowInputReady(row, current));
  if (first?.id !== entry.id || first.dueAt > Date.now() || !await browserInputAllowed(first)) return null;
  // A generated reply is authored AFTER its source final, so the ordinary rule
  // end.time >= input.createdAt cannot apply. The exact accepted helper + unchanged
  // source turn are the one exception; new work and a foreign/cancelled helper veto it.
  const turnId = entry.sourceHelperId
    ? await sourceHelperContinuationTurn(entry, current)
    : await eligibleStageEnd(entry);
  if (!turnId) { noteInputContinuationHold(entry, 'source_boundary'); return null; }
  // A deferred ticket still owns this boundary. Later queue rows cannot overtake it.
  if (current.some(row => row !== entry && row.sessionId === entry.sessionId && row.state === 'queued' &&
      row.silenceBoundary?.turnId === turnId)) return null;
  if (current.some(row => row.sessionId === entry.sessionId && (row.completedTurnId === turnId || row.state === 'tool' || row.state === 'browser'))) return null;
  if (current.some(row => row.sessionId === entry.sessionId && !queuedFollowup(row) && row.purpose !== 'decision' &&
      row.dueAt <= Date.now() && ['queued', 'browser', 'tool'].includes(row.state) && workflowInputReady(row, current))) return null;
  return turnId;
}
/** Read-only authority from the existing live request, not a queued-row or absence-of-ACK guess. */
function temporaryDecisionPreclaimProof(row: InputEntry): { expiresAt: number } | null {
  const waiter = decisionWaiters.get(row.id);
  const expiresAt = waiter?.preparationExpiresAt;
  return row.purpose === 'decision' && row.lifetime === 'temporary-planner' && row.conversationId === null &&
    pristineSourceHelperQueued(row) && row.deliveryText === undefined && row.dueAt <= Date.now() &&
    !!waiter && !waiter.signal.aborted && Number.isSafeInteger(expiresAt) && expiresAt! > Date.now() &&
    !browserDecisionHoldError() ? { expiresAt: expiresAt! } : null;
}
export function browserDecisionPreclaimRecovery(id: string): Promise<{ expiresAt: number } | null> {
  return serial(async () => {
    const row = (await load()).find(entry => entry.id === id);
    if (!row || !temporaryDecisionPreclaimProof(row) || !await browserInputAllowed(row)) return null;
    // Policy/source reads yield; abort or expiry during that await wins.
    return temporaryDecisionPreclaimProof(row);
  });
}

export function pendingBrowserInputs(): Promise<Array<{ id: string; conversationId: string | null; purpose?: 'rotation'; silenceTurnId?: string; directTurn?: InputEntry['directTurn']; supersededConversationId?: string; lifetime?: 'temporary-planner'; project?: string; preclaimRecovery?: { expiresAt: number } }>> {
  return serial(async () => {
    const result: Array<{ id: string; conversationId: string | null; purpose?: 'rotation'; silenceTurnId?: string; directTurn?: InputEntry['directTurn']; supersededConversationId?: string; lifetime?: 'temporary-planner'; project?: string; preclaimRecovery?: { expiresAt: number } }> = [];
    let current = await load();
    // An accepted helper can leave its visible continuation untouched in the queue while a
    // newer ordinary question is sent separately. The old source check correctly refuses
    // that continuation, but retaining its executable FIFO custody blocks the newer final
    // forever. Retire only the positively superseded, never-offered child here, under the
    // existing Input serializer. Keep its text and helper receipt as audit evidence. Any
    // offer, owner, authorization or native receipt stays with its incumbent recovery owner.
    for (const row of current) {
      if (!pristineSourceHelperQueued(row) || row.companionInputId || companionOf(current, row)) continue;
      const helper = retainedSourceHelperFor(current, row);
      if (!helper || !helperNativeSendConfirmed(helper) || !goalArmedFor(row.conversationId!) ||
          !await browserDecisionSourceAdvanced(row.sessionId!, row.conversationId!, helper.decisionSourceTurnId!)) continue;
      current = current.map(entry => entry === row ? { ...entry, state: 'cancelled' as const,
        error: 'Not sent: a newer recorded question superseded this unoffered helper continuation.' } : entry);
      await commit(current);
      logInfo(`input ${row.id}: superseded unoffered helper continuation retired; saved text and original helper receipt retained`);
    }
    // Only untouched, positively unsent recovery text may yield to a later sender. Retaining
    // it at the FIFO head would otherwise block the handoff/Loop reply that superseded it.
    for (const row of current) {
      if (row.state !== 'queued' || row.owner || row.offeredAt !== undefined ||
          row.sendAuthorizedAt !== undefined || !row.sessionId || !row.conversationId ||
          !row.recovery?.episode?.startsWith('interruption:')) continue;
      const session = await getSession(row.sessionId);
      const question = await readLatestUserMessage(row.sessionId);
      if (session?.conversationId === row.conversationId && question?.messageId === row.recovery.questionId &&
          goalArmedFor(row.conversationId) && !continuationForSession(row.sessionId) &&
          !goalPendingReplyFor(row.conversationId) && !goalDraftBusy(row.conversationId)) continue;
      current = current.map(entry => entry.id === row.id ? { ...entry, state: 'cancelled' as const,
        error: 'Not sent: a newer question or existing continuation superseded automatic Continue.' } : entry);
      await commit(current);
    }
    let browserHead = directBrowserHead(current);
    // `queuedBehindBrowser` is explanatory custody, not a permanent transport mode. As soon as
    // this row becomes the global head, clear the marker in the same serialized read that exposes
    // it. The UI can now offer Retry for the true head and the ordinary status wake immediately
    // publishes it without waiting for another user action.
    if (browserHead?.queuedBehindBrowser === true) {
      current = current.map(row => row.id === browserHead!.id
        ? { ...row, queuedBehindBrowser: undefined, browserEligibleAt: Date.now() }
        : row);
      await commit(current);
      browserHead = directBrowserHead(current);
    }
    for (const entry of ordered(current)) {
      if (companionOf(current, entry)) continue;
      if (!preparable(entry) || entry.dueAt > Date.now() || !workflowInputReady(entry, current)) continue;
      if (manualInput(entry) && !queuedFollowup(entry) && entry.transportIntent !== 'tool' && browserHead?.id !== entry.id) continue;
      if (queuedFollowup(entry) && !(entry.state === 'browser' && entry.completedTurnId) && !(await completedStageBoundary(entry, current))) continue;
      if (!(await browserInputAllowed(entry))) continue;
      try {
        const conversationId = await target(entry);
        // A new chat linked to a native ChatGPT Project is offered only after that Project has
        // a verified provider id. Existing chats, decisions, and short-lived helpers keep their
        // incumbent routes and never inherit provider-Project authority from a local folder.
        const chatgptProject = !conversationId && entry.projectId && entry.purpose !== 'decision' && !entry.lifetime
          ? (await getProject(entry.projectId))?.chatgpt : undefined;
        if (chatgptProject && chatgptProject.state !== 'linked') continue;
        const [end] = !entry.silenceBoundary && manualInput(entry) && entry.sessionId
          ? await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] }) : [];
        const silenceTurnId = entry.silenceBoundary?.turnId ?? (end?.kind === 'turn_end' && end.outcome === 'failed' &&
          end.reason === 'thinking_failed' && end.turnId && await eligibleStageEnd(entry) === end.turnId ? end.turnId : undefined);
        const preclaimRecovery = temporaryDecisionPreclaimProof(entry);
        result.push({ id: entry.id, conversationId,
          ...(preclaimRecovery ? { preclaimRecovery } : {}),
          ...(entry.purpose === 'rotation' ? { purpose: 'rotation' as const } : {}),
          ...(silenceTurnId ? { silenceTurnId } : {}),
          ...(entry.directTurn ? { directTurn: entry.directTurn } : {}),
          ...(entry.state === 'queued' && entry.purpose !== 'decision' && entry.sessionId && entry.conversationId && entry.conversationId !== conversationId
            ? { supersededConversationId: entry.conversationId } : {}),
          ...(entry.lifetime ? { lifetime: entry.lifetime } : {}),
          ...(chatgptProject?.state === 'linked' ? { project: chatgptProject.id } : {}) });
      } catch { /* blocked/deleted stays user-visible */ }
    }
    return result;
  });
}
export function claimBrowserInput(id: string, owner: string, conversationId: string | null, requiresAuthorization = false,
  expectedProject?: string): Promise<InputEntry | null> {
  return serial(async () => {
    const current = await load();
    const entry = current.find((row) => row.id === id);
    if (!entry || !preparable(entry) || (entry.state === 'browser' && !requiresAuthorization) || entry.dueAt > Date.now() || !owner || !workflowInputReady(entry, current)) return null;
    const forward = await deliveryHooks?.settledTurnForwardReadiness?.(entry, current);
    if (forward === false) return null;
    if (forward) requiresAuthorization = true;
    if (companionOf(current, entry)) return null;
    if (manualInput(entry) && !queuedFollowup(entry) && entry.transportIntent !== 'tool' && directBrowserHead(current)?.id !== entry.id) return null;
    const completedTurnId = entry.state === 'browser' ? entry.completedTurnId : queuedFollowup(entry)
      ? await completedStageBoundary(entry, current) : manualInput(entry) ? await eligibleStageEnd(entry) : undefined;
    if (queuedFollowup(entry) && !completedTurnId) return null;
    if (await target(entry) !== conversationId) return null;
    const chatgptProject = !conversationId && entry.projectId && entry.purpose !== 'decision' && !entry.lifetime
      ? (await getProject(entry.projectId))?.chatgpt : undefined;
    if (chatgptProject && (chatgptProject.state !== 'linked' || expectedProject !== chatgptProject.id)) return null;
    if (!(await browserInputAllowed(entry))) return null;
    if (entry.purpose === 'decision' && !decisionWaiters.has(id)) return null;
    if (entry.projectId) await projectWorkspace(entry.projectId);
    if (entry.sessionId) {
      if (current.some((row) => !sameDelivery(entry, row) && row.sessionId === entry.sessionId && ['browser', 'tool'].includes(row.state))) return null;
      const first = ordered(current).find((row) => row.sessionId === entry.sessionId && row.state === 'queued' && queuedFollowup(row) === queuedFollowup(entry) && row.dueAt <= Date.now() && workflowInputReady(row, current));
      // Follow-ups were already elected by completedStageBoundary with live
      // transport eligibility. Direct messages retain their separate FIFO.
      if (entry.state === 'queued' && !queuedFollowup(entry) && first !== entry) return null;
    }
    // The completion appendix is mandatory text too: budget it before optional AGENTS.md,
    // then freeze the complete message once. A repeated claim keeps those exact bytes.
    const session = entry.sessionId ? await getSession(entry.sessionId) : null;
    // Freeze at most the visible next checkpoint into the same exclusive browser
    // claim. Both authored rows remain intact and share one acceptance receipt.
    const queueHead = session && manualInput(entry) && entry.silenceBoundary && (entry.silenceBoundary.listenUntil ?? 0) <= Date.now() && entry.state === 'queued' &&
      await turnHasMcpCall(session.id, entry.silenceBoundary.conversationId, entry.silenceBoundary.turnId)
      ? ordered(current).find(row => row.sessionId === entry.sessionId && queuedFollowup(row) && row.state === 'queued') : undefined;
    let companion = entry.companionInputId ? current.find(row => row.id === entry.companionInputId)
      : queueHead && session && queuedAfterTurn(queueHead, session) && !queueHead.finishOwner && queueHead.purpose !== 'decision' && queueHead.attachmentDelivery !== 'tool' ? queueHead : undefined;
    if (entry.companionInputId && (!companion || companion.state !== 'browser' || companion.owner !== entry.owner || companion.sessionId !== entry.sessionId)) return null;
    // An optional checkpoint cannot make an otherwise deliverable correction too
    // large. Leave that exact head queued; never skip it to collect a later one.
    if (companion && !entry.companionInputId &&
        (!inputArgs.shape.images.safeParse([...entry.images ?? [], ...companion.images ?? []]).success ||
         !inputArgs.shape.attachments.safeParse([...entry.attachments ?? [], ...companion.attachments ?? []]).success)) companion = undefined;
    const observed = session?.selectedModel?.conversationId === conversationId ? session?.selectedModel : null;
    const selection = browserInputModel(entry);
    const settings = getConfig().ui;
    const instruction = settings.finishTool && entry.purpose !== 'decision' && session?.origin?.kind !== 'worker' && session?.origin?.kind !== 'helper' &&
      isAstraModel(selection.model ?? observed?.model, selection.model ? selection.reasoningEffort ?? undefined : observed?.reasoningEffort)
      ? finishInstruction(settings.finishLeadMinutes) : '';
    const suffix = instruction && !entry.text.includes(instruction) ? '\n\n' + instruction : '';
    let claimed: InputEntry;
    const prepareClaim = (checkpoint?: InputEntry) => prepare({ ...combinedInput(entry, checkpoint), ...(checkpoint ? { companionInputId: checkpoint.id } : {}), ...(completedTurnId ? { completedTurnId } : {}),
      ...(entry.transportIntent === 'tool' ? { transportIntent: 'browser' } : {}),
      state: 'browser', owner, conversationId, offeredAt: entry.offeredAt ?? Date.now(), requiresAuthorization }, suffix, current);
    try {
      try { claimed = await prepareClaim(companion); }
      catch (error) {
        if (!companion || entry.companionInputId || !(error instanceof Error) || !error.message.includes('Prepared message exceeds the delivery limit')) throw error;
        companion = undefined;
        claimed = await prepareClaim();
      }
      claimed = { ...claimed, text: entry.text, images: entry.images, attachments: entry.attachments };
    }
    catch (error) {
      // A never-handed-out oversized legacy row needs a visible terminal result,
      // not an endless series of browser claims. Existing claims keep their receipt.
      if (entry.state === 'queued') await commit(current.map(row => row === entry
        ? { ...entry, state: 'failed',
          ...(entry.owner === null && entry.offeredAt === undefined && entry.sendAuthorizedAt === undefined &&
              entry.deliveredAt === undefined && entry.messageId === undefined ? { requiresAuthorization: true } : {}),
          error: (error as Error).message.slice(0, 200) } : row));
      throw error;
    }
    if (entry.purpose === 'decision' && browserDecisionHoldError()) return null;
    if (!routedInputAllowed(entry) || (companion && !routedInputAllowed(companion))) return null;
    if (forward && !await forward()) return null;
    await transition(current, current.map((row) => row === entry ? claimed : row === companion ? { ...row,
      state: 'browser', owner, conversationId, offeredAt: claimed.offeredAt, requiresAuthorization, completedTurnId: claimed.completedTurnId } : row),
      entry.state === 'queued' && entry.automation && conversationId && entry.purpose !== 'decision' ? [claimed] : [], 'before-send');
    if (!entry.sourceHelperId && !requiresAuthorization && completedTurnId && entry.sessionId && conversationId)
      await consumeGoalReplyForInputNow(conversationId, entry.sessionId, completedTurnId);
    logInfo(`input ${id}: browser claimed after ${Math.max(0, Date.now() - entry.createdAt)} ms`);
    if (manualInput(entry) && entry.transportIntent === 'tool' && claimed.transportIntent === 'browser')
      logInfo(`input ${id}: never-offered manual tool route transferred to browser custody; native idle/model/draft/approval checks still required`);
    if (forward && !await forward()) return null; // claim retained, but no text/Send authority handed out
    if (!routedInputAllowed(entry) || (companion && !routedInputAllowed(companion))) return null;
    return { ...combinedInput(claimed, companion), ...selection, text: claimed.deliveryText ?? claimed.text };
  });
}
/** Commit exact project ownership before the document publishes any request-id evidence. */
export function bindBrowserInputProject(id: string, owner: string, conversationId: string): Promise<boolean> {
  return serial(async () => {
    if (!owner || !/^[0-9a-z-]{8,256}$/i.test(conversationId)) return false;
    const current = await load();
    const entry = current.find(row => row.id === id && row.owner === owner);
    if (!entry || !['browser', 'sent'].includes(entry.state) || !entry.projectId || entry.purpose === 'decision') return false;
    if (entry.conversationId && entry.conversationId !== conversationId) return false;
    if (await conversationWasSuperseded(conversationId)) return false;
    // Fence this claim to one conversation durably before creating its session.
    const bound = { ...entry, conversationId };
    if (!entry.conversationId) await commit(current.map(row => row === entry ? bound : row));
    const heldSessionId = entry.sessionId ?? entry.deliveredSessionId;
    const session = heldSessionId ? await getSession(heldSessionId) :
      await findSessionByConversation(conversationId, { requireUnique: true }) ?? await createSession({ conversationId, title: userTitle(entry.text, entry.text), titleSource: 'fallback' });
    if (!session || session.conversationId !== conversationId) return false;
    await assignSessionProject(session.id, entry.projectId);
    const latest = await load();
    await commit(latest.map(row => row.id === id ? { ...row, deliveredSessionId: session.id } : row));
    return true;
  });
}
export function acknowledgeBrowserInput(id: string, owner: string, conversationId?: string | null, messageId?: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const entry = current.find((row) => row.id === id && row.owner === owner);
    if (entry && companionOf(current, entry)) return false;
    // A claimed browser row whose Main Send authorization was REFUSED cannot
    // obtain a confirmed delivery merely by providing a page-side native id.
    // Keep that exact original claim unsent/ambiguous without minting an ACK or
    // retry. This does not affect a late ACK after real authorization or a
    // confirmed delivery, including post-restart cancelled helper receipts.
    if (entry?.state === 'browser' && entry.requiresAuthorization === true &&
        entry.sendAuthorizedAt === undefined) return false;
    // Losing the Temporary Chat answer waiter never retracts an already-authorized native
    // Send. Its original page may deliver the ACK after the deadline or a Main restart.
    // Reconcile that exact receipt without rearming the cancelled helper or its waiter.
    const expiredTemporaryReceipt = entry?.state === 'cancelled' && entry.purpose === 'decision' &&
      entry.lifetime === 'temporary-planner' &&
      (entry.sendAuthorizedAt !== undefined || entry.deliveredAt !== undefined || entry.messageId !== undefined);
    const rejectedDecision = entry && rejectedBrowserDecision(entry) && entry.sendAuthorizedAt !== undefined;
    // The original page can retain its UUID/owner after an expired PRE-Send claim.
    // A later request from that page is not evidence of native Send, even if it
    // supplies a messageId. Only an already-authorized or already-receipted
    // cancellation can be enriched after timeout/restart. Keep the original
    // confirmed-unsent receipt intact and let a newer explicit input proceed.
    const cancelledBeforeNativeSend = entry?.state === 'cancelled' && entry.requiresAuthorization === true &&
      entry.sendAuthorizedAt === undefined && entry.deliveredAt === undefined && entry.messageId === undefined;
    if (!owner || !entry || (!['browser', 'sent', 'decision', 'cancelled'].includes(entry.state) && !rejectedDecision) ||
      cancelledBeforeNativeSend ||
      (entry.state === 'cancelled' && entry.purpose === 'decision' && !expiredTemporaryReceipt)) return false;
    if (conversationId !== undefined && !(entry.lifetime === 'temporary-planner' && conversationId === null) && (!conversationId || !/^[0-9a-z-]{8,256}$/i.test(conversationId))) return false;
    if (conversationId && entry.conversationId && entry.conversationId !== conversationId) return false;
    // A fresh user send is not complete until ChatGPT assigns its exact conversation.
    // Keep the authored sessionId unchanged so retrying the original enqueue is idempotent.
    if (!entry.sessionId && entry.purpose !== 'decision' && !conversationId && !entry.conversationId) return false;
    if (messageId !== undefined && (!messageId || messageId.length > 256)) return false;
    const alreadyAcknowledged = entry.deliveredAt !== undefined &&
      (['sent', 'decision', 'cancelled'].includes(entry.state) || rejectedDecision);
    if (alreadyAcknowledged) {
      // The companion can receive an ACK response failure after Main already committed the
      // owner/conversation receipt without a native user id. If that exact page later observes
      // the stable ChatGPT message id, enrich the same durable delivery instead of discarding the
      // stronger receipt. A different id is contradictory evidence and must not rewrite history.
      const delivery = current.filter(row => sameDelivery(entry, row));
      if (messageId && delivery.some(row => row.messageId && row.messageId !== messageId)) return false;
      // Temporary Chat may acknowledge its native user ID before the provider exposes a
      // conversation route. A second ACK from the SAME claimed page can now attach that route
      // to the original receipt, never minting a new delivery or reviving an expired waiter.
      const learnedHelperRoute = entry.purpose === 'decision' && entry.lifetime === 'temporary-planner' &&
        !entry.conversationId && !!conversationId && !!messageId;
      let deliveredSessionId = entry.deliveredSessionId;
      if (learnedHelperRoute) {
        const session = await findSessionByConversation(conversationId, { requireUnique: true });
        if (entry.deliveredSessionId && session && entry.deliveredSessionId !== session.id) return false;
        deliveredSessionId = session?.id ?? entry.deliveredSessionId;
        await deliveryHooks?.bindHelper?.(conversationId, entry.decisionSourceSessionId ?? null);
      }
      if (learnedHelperRoute || (messageId && delivery.some(row => !row.messageId))) {
        await commit(current.map(row => sameDelivery(entry, row) ? {
          ...row,
          ...(messageId && !row.messageId ? { messageId } : {}),
          ...(learnedHelperRoute ? { conversationId, deliveredSessionId } : {})
        } : row));
        logInfo(`input ${id}: enriched acknowledged browser receipt with exact late native metadata`);
      }
      if (entry.sourceHelperId)
        await reconcileSourceHelperDelivery({ ...entry, ...(messageId ? { messageId } : {}) }, await load());
      await publishHistory();
      return true;
    }
    // A fast provider final can reach /input/answer before the native Send ACK returns.
    // completeBrowserDecision has already settled the same helper UUID as `sent`, but has
    // no authority to supply ChatGPT's user message ID or delivery timestamp. Temporary
    // planner answers are intentionally removed from durable storage on restart, so the
    // exact decision `sent` phase—not the private response text—is the surviving proof.
    // Reconcile that *same* owner/receipt, never authorize another Send.
    const answeredBeforeAck = (entry.state === 'sent' || rejectedDecision) && entry.purpose === 'decision' &&
      entry.deliveredAt === undefined;
    if (answeredBeforeAck && messageId && current.some(row => sameDelivery(entry, row) &&
        row.messageId && row.messageId !== messageId)) return false;
    if (entry.state !== 'browser' && entry.state !== 'cancelled' && !answeredBeforeAck) {
      await publishHistory(); return true;
    }
    const deliveredConversation = conversationId ?? entry.conversationId;
    if (!entry.sessionId && entry.purpose !== 'decision' && deliveredConversation) {
      await noteChatOrigin(deliveredConversation, { kind: 'desktop', fromSessionId: null, agentId: null, task: '', nickname: entry.nickname });
    }
    const delivered = entry.sessionId ? await getSession(entry.sessionId) : deliveredConversation
      ? await findSessionByConversation(deliveredConversation, { requireUnique: true }) : null;
    if (entry.purpose === 'decision' && deliveredConversation)
      await deliveryHooks?.bindHelper?.(deliveredConversation, entry.decisionSourceSessionId ?? null);
    const acknowledged: InputEntry = { ...entry, conversationId: deliveredConversation,
      deliveredSessionId: delivered?.id ?? null, state: rejectedDecision ? 'failed' : entry.state === 'cancelled' ? 'cancelled' :
        entry.purpose === 'decision' && !answeredBeforeAck ? 'decision' : 'sent',
      ...(entry.state === 'cancelled' ? { error: 'Cancelled locally; delivery was later confirmed in ChatGPT.' } : {}),
      ...(messageId ? { messageId } : {}), deliveredAt: Date.now() };
    const timedOutAfterSend = entry.state === 'cancelled' && entry.sendAuthorizedAt !== undefined &&
      entry.error?.startsWith('Stopped waiting for delivery confirmation.') === true;
    await transition(current, current.map((row) => row === entry ? acknowledged : row.id === entry.companionInputId ? { ...row,
      state: acknowledged.state, error: acknowledged.error, deliveredSessionId: acknowledged.deliveredSessionId,
      messageId: acknowledged.messageId, deliveredAt: acknowledged.deliveredAt } : row),
      (entry.state !== 'cancelled' || timedOutAfterSend) && !entry.sessionId && entry.automation && deliveredConversation && entry.purpose !== 'decision' ? [acknowledged] : [], 'after-send');
    if (entry.sourceHelperId) await reconcileSourceHelperDelivery(acknowledged, await load());
    else if (entry.completedTurnId && entry.sessionId && deliveredConversation)
      await consumeGoalReplyForInputNow(deliveredConversation, entry.sessionId, entry.completedTurnId);
    logInfo(`input ${id}: browser acknowledged after ${Math.max(0, Date.now() - entry.createdAt)} ms`);
    await publishHistory();
    return true;
  });
}
/** A later exact call proves receipt of an earlier tool response, never of a queued task. */
function toolInputReceipt(entry: InputEntry, sessionId: string, conversationId: string, startedAt: number): InputEntry {
  const deliveredAt = offered.get(entry.id)?.at;
  return entry.sessionId === sessionId && entry.conversationId === conversationId && entry.state === 'tool' &&
    deliveredAt !== undefined && startedAt > deliveredAt
    ? { ...entry, state: 'sent', messageId: `input:${entry.id}`, deliveredAt, historyRecorded: false,
        toolReceiptUncertain: undefined, error: undefined } : entry;
}
/** Commit incoming receipt evidence before a handler decides whether user work remains. */
export function acknowledgeToolInput(sessionId: string | null | undefined, conversationId: string | null | undefined,
  requestId: string | null | undefined, startedAt: number,
  nativeCompletion?: { turnId: string; messageId: string; nativeConversationId?: string | null }): Promise<void> {
  return serial(async () => {
    if (!sessionId || !conversationId || (!requestId && !nativeCompletion) || isChatBlocked(conversationId)) return;
    if ((await getSession(sessionId))?.conversationId !== conversationId) return;
    const current = await load();
    const completed = nativeCompletion
      ? await completedToolInputReceipts(sessionId, conversationId, current, nativeCompletion) : null;
    const next = current.map(entry => nativeCompletion
      ? completed?.has(entry.id) ? { ...entry, state: 'sent' as const, messageId: `input:${entry.id}`,
        deliveredAt: offered.get(entry.id)!.at, historyRecorded: false, toolReceiptUncertain: undefined, error: undefined } : entry
      : toolInputReceipt(entry, sessionId, conversationId, startedAt));
    if (!next.some((entry, index) => entry !== current[index])) return;
    await commit(next);
    if (nativeCompletion) for (const entry of next) if (completed?.has(entry.id))
      logInfo(`input ${entry.id}: exact native completion confirmed its returned tool receipt turn=${nativeCompletion.turnId} request=${entry.owner}`);
    for (const entry of next) if (terminal(entry)) offered.delete(entry.id);
    await publishHistory();
  });
}

/** A current paired native completion can acknowledge the last returned instruction without
 * requiring another Core call. Durable history alone cannot mint this receipt: the exact live
 * offer, returned call, native final and Main's completed request set must all still agree. */
async function completedToolInputReceipts(sessionId: string, conversationId: string, rows: InputEntry[],
  proof: { turnId: string; messageId: string; nativeConversationId?: string | null }): Promise<Set<string>> {
  const accepted = new Set<string>();
  const candidates = rows.filter(row => row.sessionId === sessionId && row.conversationId === conversationId &&
    row.state === 'tool' && row.purpose !== 'decision' && row.toolReceiptUncertain !== true &&
    !row.images?.length && !row.toolImages?.length && !!row.owner && offered.has(row.id));
  // Only the actual paired final callback can retain native context. An end-only journal
  // retry has no such field and cannot reconstruct it from a historical message on disk.
  if (proof.nativeConversationId !== undefined)
    for (const row of candidates) delete offered.get(row.id)!.nativeFinal;
  if (!candidates.length || callsHoldRecovery(conversationId) || continuationForSession(sessionId) ||
      await conversationWasSuperseded(conversationId)) return accepted;
  const session = await getSession(sessionId);
  if (session?.conversationId !== conversationId || (session.activeTurnId &&
      (proof.nativeConversationId !== conversationId || session.activeTurnId !== proof.turnId))) return accepted;
  const events = await readRecentEvents(sessionId, 256, { kinds: [
    'user_message', 'assistant_message', 'turn_start', 'turn_end', 'tool_call', 'handoff', 'chat_error'
  ] });
  const final = events.findLast(event => event.kind === 'assistant_message');
  const boundary = events.filter(event => event.kind === 'turn_start' || event.kind === 'turn_end')
    .sort((a, b) => workSequence(a) - workSequence(b)).at(-1);
  if (final?.kind !== 'assistant_message' || final.source !== 'extension' || final.turnId !== proof.turnId ||
      final.messageId !== proof.messageId || final.providerMessageId !== proof.messageId ||
      final.final !== true || final.state !== 'final' || final.goalEligible !== true ||
      final.message.truncated || !final.message.text.trim()) return accepted;
  if (proof.nativeConversationId === conversationId)
    for (const row of candidates) offered.get(row.id)!.nativeFinal = {
      turnId: proof.turnId, messageId: proof.messageId, observedAt: Date.now()
    };
  if (session.activeTurnId || boundary?.kind !== 'turn_end' ||
      boundary.source !== 'extension' || boundary.turnId !== proof.turnId || boundary.outcome !== 'completed' ||
      !boundary.completionEvidence || boundary.completionEvidence.startedAt === null ||
      boundary.completionEvidence.observedAt > Date.now() + 5_000) return accepted;
  const start = events.findLast(event => event.kind === 'turn_start' && event.turnId === proof.turnId);
  if (!start || start.time !== boundary.completionEvidence.startedAt ||
      events.some(event => (event.kind === 'user_message' && workSequence(event) > workSequence(start) &&
        !candidates.some(row => event.inputId === row.id || event.messageId === `input:${row.id}`)) ||
        (workSequence(event) > workSequence(start) && (event.kind === 'handoff' || event.kind === 'chat_error')) ||
        (event.kind === 'tool_call' && workSequence(event) > workSequence(boundary)))) return accepted;
  for (const row of candidates) {
    const offer = offered.get(row.id)!;
    if (offer.requestId !== row.owner || !Number.isFinite(offer.at) || !Number.isFinite(offer.startedAt) ||
        offer.nativeFinal?.turnId !== proof.turnId || offer.nativeFinal.messageId !== proof.messageId ||
        offer.nativeFinal.observedAt < offer.at || boundary.completionEvidence.observedAt < offer.at ||
        !boundary.completionEvidence.requestIds.includes(offer.requestId)) continue;
    const returned = events.findLast(event => event.kind === 'tool_call' && event.turnId === proof.turnId &&
      event.time === offer.startedAt && event.call.requestId === offer.requestId &&
      event.call.attribution === 'request_id' && event.call.conversationId === conversationId);
    if (returned?.kind !== 'tool_call' || returned.call.result.truncated ||
        !Number.isFinite(returned.call.durationMs) || returned.call.durationMs < 0 ||
        returned.time + returned.call.durationMs < offer.at ||
        returned.time + returned.call.durationMs > boundary.completionEvidence.observedAt ||
        returned.time + returned.call.durationMs > offer.nativeFinal.observedAt ||
        workSequence(returned) >= workSequence(boundary) ||
        !exactReturnedToolAppendix(returned.call.result.text, offer.returnedText)) continue;
    accepted.add(row.id);
  }
  // Session rebind, a new question/tool, or native interruption during the read cannot inherit
  // this completion. The serialized outbox plus the live offer map retain the original epoch.
  const superseded = await conversationWasSuperseded(conversationId);
  const latest = await getSession(sessionId);
  if (latest?.conversationId !== conversationId || latest.events !== session.events || latest.activeTurnId ||
      callsHoldRecovery(conversationId) || continuationForSession(sessionId) || isChatBlocked(conversationId) ||
      superseded) accepted.clear();
  return accepted;
}

function exactReturnedToolAppendix(result: string, frozen: string): boolean {
  const start = result.indexOf(TOOL_INPUT_HEADER);
  const end = start + frozen.length;
  return start >= 0 && (start === 0 || result[start - 1] === '\n') &&
    result.indexOf(TOOL_INPUT_HEADER, start + TOOL_INPUT_HEADER.length) === -1 &&
    result.slice(start, end) === frozen && (end === result.length || result[end] === '\n');
}

export function offerToolInput(sessionId: string | null | undefined, conversationId: string | null | undefined, requestId: string | null | undefined, startedAt: number, finishBoundary = false): Promise<ToolInputBatch> {
  return serial(async () => {
    const batch: ToolInputBatch = { messages: [], reminder: '' };
    if (!sessionId || !conversationId || !requestId || isChatBlocked(conversationId)) return batch;
    const session = await getSession(sessionId);
    if (session?.conversationId !== conversationId) return batch;
    const finishSettings = getConfig().ui;
    finishBoundary = finishBoundary && finishSettings.finishTool === true && session.origin?.kind !== 'worker';
    const finishReminder = finishSettings.finishTool === true && !session.finishTurn?.released &&
      session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
      session.selectedModel?.conversationId === conversationId && isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort)
      ? finishInstruction(finishSettings.finishLeadMinutes) : '';
    const current = await load();
    // A claimed browser send owns this session until its send outcome is known.
    if (current.some((entry) => entry.sessionId === sessionId && entry.state === 'browser')) return batch;
    const head = ordered(current).find(row => !row.workflow && row.sessionId === sessionId && queuedFollowup(row) &&
      ['queued', 'tool'].includes(row.state) && !terminal(toolInputReceipt(row, sessionId, conversationId, startedAt)));
    const delivered: string[] = [];
    let inputTaken = false;
    let payloadBytes = Buffer.byteLength(TOOL_INPUT_HEADER);
    let payloadImages = 0;
    let payloadFull = false;
    const prepareEntry = async (entry: InputEntry): Promise<InputEntry> => {
      if (entry.workflow || entry.sessionId !== sessionId || entry.dueAt > Date.now() || !workflowInputReady(entry, current)) return entry;
      if (!manualInput(entry) && !automationRotationAdmits(conversationId)) return entry;
      if (entry.attachments?.length && entry.attachmentDelivery !== 'tool') return entry;
      // Native steering must not also be copied into a tool result. Explicit
      // image injection has no directTurn and retains its existing receipt path.
      if (entry.directTurn && entry.state === 'queued') return entry;
      if (entry.state === 'queued' && composerOnlyText(entry, session)) return entry;
      // ChatGPT may reuse one request id for the whole server turn. Receipt follows
      // the actual invocation start, never a change in that grouping id.
      const received = toolInputReceipt(entry, sessionId, conversationId, startedAt);
      if (received !== entry) return received;
      // A cold-restored tool offer is neither safely retryable nor safely claimable as sent.
      // Keep its existing nonterminal custody so later stages/Goal cannot overtake it, but never
      // attach the same user instruction to another MCP result without a positive unsent proof.
      if (entry.state === 'tool' && entry.toolReceiptUncertain === true) return entry;
      if (payloadFull || (inputTaken && (entry.mode === 'finish' || entry.finishOwner)) || (entry.finishOwner && entry.createdAt >= startedAt)) return entry;
      if (entry.mode === 'finish' && !finishBoundary) return entry;
      if (entry.mode === 'finish' && entry !== head) return entry;
      // After-turn tasks own a future browser turn; they cannot block an explicit
      // Inject now message from the current tool response. Their own FIFO is unchanged.
      if ((entry.state === 'queued' && (entry.mode === 'finish' || entry.mode === 'auto')) || entry.state === 'tool') {
        let prepared: InputEntry;
        try { prepared = await prepare({ ...entry, conversationId }, '', current); }
        catch (error) { return { ...entry, state: 'failed', error: (error as Error).message.slice(0, 200) }; }
        if (!routedInputAllowed(prepared)) return entry;
        const message = prepared.deliveryText ?? prepared.text;
        const reminder = finishReminder || batch.reminder || (entry.mode === 'finish' ? 'Work on this user task now.' : '');
        const messageBytes = Buffer.byteLength(message) + (inputTaken ? 2 : 0);
        const reminderBytes = reminder ? Buffer.byteLength(reminder) + 2 : 0;
        const images = [...entry.images ?? [], ...entry.toolImages ?? []];
        if (payloadBytes + messageBytes + reminderBytes > TOOL_INPUT_TEXT_BYTES || payloadImages + images.length > 4) { payloadFull = true; return entry; }
        payloadBytes += messageBytes;
        payloadImages += images.length;
        inputTaken = true;
        batch.messages.push({ text: message, images });
        batch.reminder = reminder;
        delivered.push(entry.id);
        return { ...prepared, state: 'tool', offeredAt: entry.offeredAt ?? Date.now(), owner: entry.state === 'tool' ? entry.owner : requestId,
          conversationId, toolReceiptUncertain: undefined, error: undefined };
      }
      return entry;
    };
    const next: InputEntry[] = [];
    for (const entry of ordered(current).sort((a, b) => Number(a.mode === 'finish' || !!a.finishOwner) - Number(b.mode === 'finish' || !!b.finishOwner))) next.push(await prepareEntry(entry));
    if (next.some(row => delivered.includes(row.id) && !routedInputAllowed(row)))
      return { messages: [], reminder: '' };
    if (next.some((entry, index) => entry !== current[index])) {
      const automated = next.filter((entry) => entry.state === 'tool' && entry.automation && current.some((row) => row.id === entry.id && row.state === 'queued'));
      await transition(current, next, automated, 'before-send');
    }
    // Recorder joins the kernel's separate text blocks with one newline. Freeze that exact
    // complete append once for this live batch; a partial/quoted row cannot acknowledge it.
    const receipt = { at: Date.now(), requestId, startedAt,
      returnedText: batch.messages.map((message, index) => (index === 0 ? TOOL_INPUT_HEADER : '\n\n') + message.text).join('\n') };
    for (const id of delivered) if (!offered.has(id)) offered.set(id, receipt);
    for (const entry of next) if (terminal(entry)) offered.delete(entry.id);
    await publishHistory();
    if (next.some(row => delivered.includes(row.id) && !routedInputAllowed(row))) {
      // Nothing in this batch has crossed the tool-result boundary. Restore its exact
      // prior queue/offer custody; never withdraw an older offer from another response.
      await commit(current);
      for (const id of delivered) if (offered.get(id) === receipt) offered.delete(id);
      return { messages: [], reminder: '' };
    }
    return batch;
  });
}

export function resetInputForTests(): void {
  if (inputSerialOwner) inputSerialOwner.live = false;
  inputSerialOwner = null;
  retainedExecutionResumes.clear();
  entries = null; chain = Promise.resolve(); offered.clear(); decisionWaiters.clear(); recoveryReleaseTold.clear(); browserHelperBackoffUntil = 0; browserDecisionSignedOut = false; browserDecisionSignedInObserved = false;
}

export async function pausedBrowserHelpers(): Promise<Array<{ id: string; sourceSessionId: string }>> {
  // A temporary helper may gain its native /c/ route before the answer waiter expires.
  // That route is receipt evidence, not permission to hide the saved recovery control.
  return (await listInputs()).filter(row => row.purpose === 'decision' && row.state === 'cancelled' &&
    !(row.goalSourceSuperseded && helperNativeSendConfirmed(row)) && row.decisionSourceSessionId)
    .map(row => ({ id: row.id, sourceSessionId: row.decisionSourceSessionId! }));
}

/** Positive durable proof that this decision helper never crossed native Send. */
function helperConfirmedUnsent(row: InputEntry): boolean {
  return row.purpose === 'decision' && row.sendAuthorizedAt === undefined &&
    row.deliveredAt === undefined && row.messageId === undefined && row.deliveredSessionId === undefined &&
    row.response === undefined && (row.requiresAuthorization === true ||
      (row.owner === null && row.offeredAt === undefined && row.requiresAuthorization === undefined &&
        row.deliveryText === undefined));
}

function helperNativeSendConfirmed(row: InputEntry): boolean {
  return helperNativeSendReceipt(row) && row.deliveredAt! <= Date.now();
}

/** Receipt chronology survives a clock rollback; this alone grants no collection or Send. */
function helperNativeSendReceipt(row: Readonly<InputEntry>): boolean {
  return row.purpose === 'decision' && row.lifetime === 'temporary-planner' && Boolean(row.owner) &&
    row.requiresAuthorization === true && Boolean(row.messageId?.trim()) &&
    row.sendAuthorizedAt !== undefined && row.deliveredAt !== undefined &&
    row.createdAt <= row.sendAuthorizedAt && row.sendAuthorizedAt <= row.deliveredAt;
}

/** Exact cancelled native-sent helpers may archive an answer, never revive their decision. */
export function supersededBrowserDecisionArchiveEligible(
  row: Readonly<InputEntry>, owner: string, conversationId?: string | null,
): boolean {
  const superseded = row.goalSourceSuperseded === true && row.error === 'goal_browser_source_superseded';
  const expired = row.goalSourceSuperseded !== true && row.error === 'goal_browser_answer_expired';
  // A Temporary Chat can remain route-less after its exact Send ACK. That permits
  // only null-to-null collection; a later provider route must first bind through
  // the incumbent ACK owner, never borrow an arbitrary conversation here.
  const routeMatches = Boolean(row.conversationId?.trim()) && row.conversationId === conversationId ||
    (superseded || expired) && row.conversationId === null && conversationId == null;
  return row.owner === owner && row.purpose === 'decision' && row.lifetime === 'temporary-planner' &&
    row.state === 'cancelled' && (superseded || expired) && helperNativeSendConfirmed(row as InputEntry) &&
    Boolean(row.decisionSourceSessionId?.trim()) && Boolean(row.decisionSourceTurnId?.trim()) && routeMatches;
}

/** Existing live acceptance owner only: a receipt never resurrects a cold/retired waiter. */
export function liveDeliveredBrowserDecision(row: Readonly<InputEntry>): boolean {
  return row.state === 'decision' && helperNativeSendConfirmed(row as InputEntry) &&
    typeof decisionWaiters.get(row.id)?.onAccepted === 'function';
}

/** Read-only lifecycle census; no prompt, private answer, token, or new request is published. */
export async function activeBrowserDecisionWork(rows: readonly InputEntry[]): Promise<{ collecting: number; accepting: number }> {
  const result = { collecting: 0, accepting: 0 };
  for (const row of rows) {
    // Lifecycle cannot infer absence from clock order: an actual live owner plus its native
    // receipt stays in custody even when the wall clock changed between authorize and ACK.
    // Send/answer collection still use helperNativeSendConfirmed's strict chronology.
    const delivered = row.purpose === 'decision' && row.lifetime === 'temporary-planner' &&
      Boolean(row.owner) && row.requiresAuthorization === true && Boolean(row.messageId?.trim()) &&
      Number.isFinite(row.sendAuthorizedAt) && Number.isFinite(row.deliveredAt);
    if (!row.decisionSourceSessionId || !row.decisionSourceTurnId || !delivered ||
        !['decision', 'sent'].includes(row.state)) continue;
    const activeRun = () => goalBrowserHelperRunActive(row.id, row.decisionSourceSessionId!, row.decisionSourceTurnId!);
    const collecting = () => row.state === 'decision' && typeof decisionWaiters.get(row.id)?.onAccepted === 'function';
    if (!collecting() && !activeRun()) continue;
    const source = await getSession(row.decisionSourceSessionId);
    if (!source?.conversationId || source.origin?.kind === 'helper' || source.origin?.kind === 'worker') continue;
    const owed = goalPendingReplyFor(source.conversationId);
    if (row.state === 'decision' && (!goalArmedFor(source.conversationId) || source.activeTurnId ||
        owed?.sessionId !== source.id || owed.turnId !== row.decisionSourceTurnId)) continue;
    if (row.state === 'decision' && collecting()) result.collecting++;
    else if (activeRun()) result.accepting++;
  }
  return result;
}

/** Read the original source's retained helper and Goal-reply receipts without waking Goal,
 * reopening a helper, authorizing Send, or exposing redacted decision text to the renderer.
 * Absence of an older, pruned outbox row is not evidence that the helper was unsent. */
export async function sessionDecisionHelperCustody(
  sessionId: string,
  conversationId: string
): Promise<SessionDecisionHelperCustody | null> {
  const session = await getSession(sessionId);
  if (!session || session.conversationId !== conversationId) return null;
  const rows = await serial(async () => {
    // Inspection is not startup/recovery. Never cancel a helper, expire a receipt,
    // materialize a stage or wake delivery merely because its Work view was opened.
    if (!durableStoreReady()) throw new Error('Message outbox custody is not initialized');
    const parsed = z.array(entrySchema).safeParse((entries ?? await readDurableStrict<unknown>(STATE)) ?? []);
    if (!parsed.success) throw new Error('Message outbox custody could not be read safely');
    const unique = new Map<string, InputEntry>();
    for (const row of parsed.data) {
      const previous = unique.get(row.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row))
        throw new Error('Message outbox custody contains conflicting message identity');
      if (!previous) unique.set(row.id, row);
    }
    return [...unique.values()]; // Schema parsing detaches every returned row.
  });
  // The selected session can be rebound while the durable store is being read. Never
  // publish another conversation's old helper receipts under the replacement session.
  if ((await getSession(sessionId))?.conversationId !== conversationId) return null;
  const owed = goalPendingReplyFor(conversationId);
  const pendingOriginalReply = owed?.sessionId === sessionId
    ? { replyId: owed.replyId, sourceTurnId: owed.turnId, acceptedAt: owed.acceptedAt } : null;
  const helpers = rows.filter(row => row.purpose === 'decision' && row.lifetime === 'temporary-planner' &&
    row.decisionSourceSessionId === sessionId);
  helpers.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));

  return {
    sessionId, conversationId, pendingOriginalReply,
    retainedTotal: helpers.length, truncated: helpers.length > 40,
    helpers: helpers.slice(0, 40).map(row => {
      const confirmed = helperNativeSendConfirmed(row);
      const unresolvedSend = !confirmed && (row.sendAuthorizedAt !== undefined ||
        row.deliveredAt !== undefined || row.messageId !== undefined);
      const nativeSend = confirmed ? 'confirmed' as const : unresolvedSend ? 'unresolved' as const : 'not-confirmed' as const;
      const answer = row.state === 'sent' ? 'accepted' as const : row.goalDecisionRejection
        ? 'rejected' as const : 'not-recorded' as const;
      const phase: SessionDecisionHelperCustody['helpers'][number]['phase'] =
        row.state === 'sent' ? 'answer-accepted' : row.goalDecisionRejection ? 'answer-rejected' :
        row.state === 'cancelled' && confirmed ? 'cancelled-after-native-delivery' :
        row.state === 'failed' && confirmed ? 'failed-after-native-delivery' :
        row.state === 'cancelled' && helperConfirmedUnsent(row) ? 'cancelled-before-native-send' :
        row.state === 'failed' && helperConfirmedUnsent(row) ? 'failed-before-native-send' :
        row.state === 'cancelled' || row.state === 'failed' ? 'unresolved-cancellation' :
        confirmed ? 'awaiting-answer' : unresolvedSend ? 'native-send-unresolved' : 'awaiting-native-send';
      const related = rows.filter(input => input.purpose !== 'decision' && input.sourceHelperId === row.id &&
        input.sessionId === sessionId && input.conversationId === conversationId &&
        input.sourceHelperAcceptedAt !== undefined);
      const outgoing = related.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
      const outgoingNative = outgoing && outgoing.state === 'sent' && outgoing.owner && outgoing.messageId &&
        outgoing.deliveredAt !== undefined;
      return {
        id: row.id, sourceTurnId: row.decisionSourceTurnId ?? null, createdAt: row.createdAt,
        state: row.state, phase, nativeSend, nativeMessageId: row.messageId ?? null,
        sendAuthorizedAt: row.sendAuthorizedAt ?? null, deliveredAt: row.deliveredAt ?? null,
        answer, rejection: row.goalDecisionRejection ?? null, sourceSuperseded: row.goalSourceSuperseded === true,
        continuation: outgoing ? {
          id: outgoing.id, state: outgoing.state,
          nativeSend: outgoingNative ? 'confirmed' as const : outgoing.sendAuthorizedAt !== undefined ||
            outgoing.deliveredAt !== undefined || outgoing.messageId !== undefined ? 'unresolved' as const : 'not-confirmed' as const,
          nativeMessageId: outgoing.messageId ?? null, deliveredAt: outgoing.deliveredAt ?? null
        } : null
      };
    })
  };
}

/** Stronger subset: no browser document ever claimed or prepared this helper. */
function helperNeverClaimed(row: InputEntry): boolean {
  return helperConfirmedUnsent(row) && row.owner === null && row.offeredAt === undefined &&
    row.requiresAuthorization === undefined && row.deliveryText === undefined;
}

function browserDecisionHoldError(): string | null {
  return browserDecisionSignedOut ? 'goal_browser_signed_out'
    : getConfig().ui.automationPaused ? 'goal_browser_automation_paused' : null;
}

/** A cold Main has no auth observation yet. A durable, positively unsent sign-out
 * cancellation is enough to withhold NEW helper admission until the incumbent
 * browser status owner positively observes signed-in again. It cannot retire or
 * reinterpret authorized/native Send receipts and creates no separate hold store. */
function restoredBrowserSignOutHold(rows: readonly InputEntry[]): boolean {
  return !browserDecisionSignedInObserved && rows.some(row => row.state === 'cancelled' &&
    row.error === 'goal_browser_signed_out' && helperConfirmedUnsent(row));
}

/** Only positively unsent waits lose admission. Native-authorized or delivered work keeps
 * its waiter and receipts, so pausing dispatch never means cancelling provider generation. */
function suspendUnsentBrowserDecisionWaits(error: string, held: () => boolean, reason: string): Promise<void> {
  return serial(async () => {
    if (!held()) return;
    const current = await load();
    if (!held()) return;
    const unsent = current.filter(row => !terminal(row) && helperConfirmedUnsent(row) && decisionWaiters.has(row.id));
    if (!unsent.length) return;
    const ids = new Set(unsent.map(row => row.id));
    await commit(current.map(row => ids.has(row.id)
      ? { ...row, state: 'cancelled' as const, error } : row));
    for (const row of unsent) {
      const waiter = decisionWaiters.get(row.id);
      decisionWaiters.delete(row.id);
      waiter?.reject(new Error(error));
    }
    logInfo(`browser helpers: ${reason}; suspended ${unsent.length} confirmed-unsent decision wait(s), native Send receipts preserved`);
  });
}

/** Stop positively unsent decision waits at the existing auth boundary. */
export function setBrowserDecisionAuthentication(state: 'signed-in' | 'signed-out' | 'unknown'): Promise<void> {
  if (state === 'unknown') return Promise.resolve(); // Missing page evidence cannot clear logout.
  browserDecisionSignedOut = state === 'signed-out';
  browserDecisionSignedInObserved = state === 'signed-in';
  return suspendUnsentBrowserDecisionWaits('goal_browser_signed_out', () => browserDecisionSignedOut, 'sign-in required');
}

/** The durable account pause is the sole authority; no independent hold or retry budget. */
export function suspendPausedBrowserDecisionWaits(): Promise<void> {
  return suspendUnsentBrowserDecisionWaits('goal_browser_automation_paused',
    () => Boolean(getConfig().ui.automationPaused), 'account automation paused');
}

/** A deliberate user action withdraws one source chat's ambiguous helper fences.
 * Every old owner remains terminal forever; this authorizes one replacement helper rather
 * than one replacement per duplicate warning left by older builds. */
export function authorizeBrowserHelperRetry(id: string, sourceSessionId: string, sourceTurnId?: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.decisionSourceSessionId === sourceSessionId
      && entry.purpose === 'decision' && (
        entry.state === 'cancelled' ||
        // This helper answered before Main saved the generated Goal continuation. After
        // restart its private answer is redacted, but sent retains the accepted receipt.
        // Only an explicit Restart targeting this exact source turn may authorize a NEW
        // decision without pretending that the original native Send was unsent.
        (entry.state === 'sent' && entry.lifetime === 'temporary-planner' &&
          !!sourceTurnId && entry.decisionSourceTurnId === sourceTurnId) ||
        // Explicit recovery of a repaired deterministic envelope may replace
        // this exact positively unsent helper; ordinary polling cannot grant it.
        (entry.state === 'failed' && entry.lifetime === 'temporary-planner' &&
          (entry.error === 'goal_browser_prompt_envelope_invalid' || entry.error === NATIVE_PROMPT_ENVELOPE_REFUSAL) &&
          entry.requiresAuthorization === true && entry.sendAuthorizedAt === undefined &&
          entry.messageId === undefined && entry.deliveredAt === undefined &&
          entry.deliveredSessionId === undefined && entry.response === undefined &&
          entry.toolReceiptUncertain !== true && !!sourceTurnId && entry.decisionSourceTurnId === sourceTurnId)
      ));
    if (!row || current.some(entry => entry.decisionSourceSessionId === sourceSessionId && !terminal(entry))) return false;
    if (row.state === 'sent' || row.state === 'failed') return true;
    let retired = 0;
    await commit(current.map(entry => {
      if (entry.decisionSourceSessionId !== sourceSessionId || entry.purpose !== 'decision' ||
          entry.state !== 'cancelled') return entry;
      retired += 1;
      return { ...entry, state: 'failed', error: 'User authorized a new helper' };
    }));
    logInfo(`browser helper source ${sourceSessionId}: retired ${retired} unconfirmed owner(s) before one user-authorized replacement`);
    return true;
  });
}

/** Fixed custody phases for the exact helper whose local answer deadline elapsed. */
export type BrowserHelperTimeoutDisposition =
  | 'automation-paused'
  | 'signed-out'
  | 'queued-unclaimed'
  | 'browser-preparing'
  | 'send-outcome-unconfirmed'
  | 'awaiting-answer'
  | 'ambiguous'
  | 'none';

/** Classify and settle the exact helper that ended at the caller's local request deadline.
 *
 * queued-unclaimed is the one phase that proves no browser claim ever existed. A claimed helper
 * can still prove native Send was never authorized; retire that exact pre-Send owner as
 * browser-preparing, but keep it in Goal's bounded helper-failure accounting. Authorized sends
 * without a receipt stay ambiguous. A native-delivered helper with no collected answer
 * remains under the same cancelled receipt fence: timeout cannot prove that ChatGPT stopped.
 */
export function settleTimedOutBrowserHelper(sourceSessionId: string): Promise<BrowserHelperTimeoutDisposition> {
  return serial(async () => {
    const current = await load();
    if (current.some(entry => entry.decisionSourceSessionId === sourceSessionId && !terminal(entry))) return 'ambiguous';
    const latest = [...current].reverse().find(entry => entry.decisionSourceSessionId === sourceSessionId &&
      entry.purpose === 'decision');
    // A native account warning may first commit an exact pre-Send failure, then pause
    // dispatch before releasing its waiter. Keep its provider diagnostics unchanged;
    // only current durable pause plus positive unsent proof grants this hold classification.
    const failedHold = latest?.state === 'failed' && helperConfirmedUnsent(latest) ? browserDecisionHoldError() : null;
    if (failedHold) {
      logInfo(`browser helper ${latest!.id}: exact pre-Send failure retained under account hold; source retry budget preserved`);
      return failedHold === 'goal_browser_signed_out' ? 'signed-out' : 'automation-paused';
    }
    // A prior attempt's cancellation cannot classify this latest request. In particular,
    // an older unsent row must never hide the current helper's authorized/native failure.
    const row = latest?.state === 'cancelled' ? latest : null;
    if (!row) return 'none';
    if (helperConfirmedUnsent(row)) {
      // Pause can race its suspension hook or the deadline. The original semantic error
      // remains authoritative after Resume; it must not spend this turn's failure budget.
      const hold = row.error === 'goal_browser_automation_paused' || row.error === 'goal_browser_signed_out'
        ? row.error : browserDecisionHoldError();
      if (hold) {
        if (row.error !== hold) await commit(current.map(entry => entry === row ? { ...entry, error: hold } : entry));
        logInfo(`browser helper ${row.id}: confirmed-unsent admission held; native receipts and source retry budget preserved`);
        return hold === 'goal_browser_signed_out' ? 'signed-out' : 'automation-paused';
      }
    }
    if (helperNeverClaimed(row)) {
      await commit(current.map(entry => entry === row
        ? { ...entry, state: 'failed', error: 'Timed-out helper confirmed unsent before browser claim' }
        : entry));
      logInfo(`browser helper ${row.id}: timed out phase=queued-unclaimed; confirmed unsent`);
      return 'queued-unclaimed';
    }
    if (helperConfirmedUnsent(row)) {
      await commit(current.map(entry => entry === row
        ? { ...entry, state: 'failed', error: 'Timed-out helper confirmed unsent during browser preparation' }
        : entry));
      logInfo(`browser helper ${row.id}: timed out phase=browser-preparing; confirmed unsent`);
      return 'browser-preparing';
    }
    if (row.sendAuthorizedAt !== undefined && row.deliveredAt === undefined && row.messageId === undefined)
      return 'send-outcome-unconfirmed';
    if (row.deliveredAt === undefined) return 'ambiguous';
    // Expiration of the local answer waiter says nothing about whether the exact native
    // request is still generating or may publish late. Replacing it automatically can
    // duplicate a provider-accepted request. Keep its durable Send/message receipt, even
    // after restart and repeated timeout classifications, for explicit reconciliation.
    logInfo(`browser helper ${row.id}: phase=awaiting-answer source=${sourceSessionId} native receipt retained after collection deadline; automatic replacement fenced`);
    return 'awaiting-answer';
  });
}

/** Only a pre-send failure can be declared failed. An ambiguous click stays claimed.
 * `confirmedUnsent` is stronger: the exact owning page reached the native Send callback but
 * positively did not cross its click-attempt boundary. Re-arm that same durable UUID rather
 * than converting a lost authorization response into a permanently ambiguous delivery. */
export const RECOVERY_WITHDRAW_LIMIT_MS = 3 * 60_000;
export const RECOVERY_WITHDRAW_REOFFER_DELAYS_MS = [1_500, 5_000, 15_000] as const;

/** Re-prove both the existing source-turn owner and the exact authored recovery question. */
async function recoverySourceStillCurrent(entry: InputEntry): Promise<boolean> {
  if (!entry.sessionId) return false;
  // Stop -> Continue owns the exact interrupted question, not a completed
  // answer. It deliberately has no completedTurnId. Requiring that unrelated
  // boundary permanently failed every positively unsent withdrawal, including
  // a temporary native composer refusal. Reuse its existing claim/Send fences;
  // never revive an already-failed historical row or infer a new source turn.
  if (entry.recovery?.episode?.startsWith('interruption:')) {
    return entry.recovery.episode === `interruption:${entry.recovery.questionId}` &&
      await interruptedInputCurrent(entry);
  }
  // A helper authors its continuation after the source final. Withdrawal must
  // re-prove the same accepted-helper boundary as claim/Send, not the ordinary
  // enqueue-time cutoff. Its exact helper may also recover an uncached turn ID.
  // A transient physical activity hold revokes Send, not the identity of an
  // unchanged completed source. Retain this positively unsent row under the
  // existing bounded backoff; ordinary claim and final authorization still
  // require idle activity. Never apply this exception to a native receipt.
  const currentSource = () => entry.sourceHelperId
    ? sourceHelperContinuationTurn(entry, undefined, { retainDuringActivity: true }) : eligibleStageEnd(entry);
  const currentTurnId = await currentSource();
  const sourceTurnId = entry.silenceBoundary?.turnId ?? entry.completedTurnId ??
    (entry.sourceHelperId ? currentTurnId : null);
  if (!sourceTurnId || currentTurnId !== sourceTurnId) return false;
  if (!entry.recovery) return true;
  const question = await readLatestUserMessage(entry.sessionId);
  if (question?.messageId !== entry.recovery.questionId) return false;
  // The event journal can advance while the question is read. Recheck the same current-source
  // owner before allowing that old recovery text to return to the browser queue.
  return await currentSource() === sourceTurnId;
}

export async function failBrowserInput(id: string, owner: string, error: string,
  options: { confirmedUnsent?: boolean; conversationId?: string | null; detail?: string;
    /** Publish the incumbent account hold after this exact failure is durable, before
     * releasing its waiter. Never called for rejected ownership or a refused failure. */
    onAcceptedFailure?: () => Promise<void> } = {}): Promise<boolean> {
  let releaseAfterPublication: (() => void) | undefined;
  const rejectDecision = (message: string) => {
    const waiter = decisionWaiters.get(id);
    const release = () => {
      if (decisionWaiters.get(id) === waiter) decisionWaiters.delete(id);
      waiter?.reject(new Error(message));
    };
    if (options.onAcceptedFailure) releaseAfterPublication = release;
    else release();
  };
  const accepted = await serial(async () => {
    const current = await load();
    const entry = current.find((row) => row.id === id && row.owner === owner &&
      (row.state === 'browser' || row.state === 'decision' && row.purpose === 'decision' && decisionWaiters.has(id)));
    if (!entry || companionOf(current, entry)) return false;
    if (error === CONVERSATION_DELETED) {
      const delivery = current.filter(row => sameDelivery(entry, row));
      // A provider deletion is neither retryable preparation nor proof that an authorized
      // native click did not happen. Preserve the original owner for its possible late ACK.
      if (delivery.some(row => row.state !== 'browser' || row.requiresAuthorization !== true ||
          row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined || row.messageId !== undefined ||
          row.toolReceiptUncertain === true)) return false;
      await commit(current.map(row => sameDelivery(entry, row) ? {
        ...row, state: 'failed' as const, owner: null, error: CONVERSATION_DELETED
      } : row));
      rejectDecision(`goal_browser_send_failed: ${CONVERSATION_DELETED}`);
      logWarn(`input ${entry.id}: positive provider deletion retired ${delivery.length} confirmed-unsent row(s); no automatic reoffer`);
      return true;
    }
    const exactPreSendRelease = entry.requiresAuthorization === true &&
      (entry.sendAuthorizedAt === undefined || options.confirmedUnsent === true);
    if (options.confirmedUnsent === true &&
        (!exactPreSendRelease ||
         (options.conversationId !== undefined && entry.conversationId !== options.conversationId))) return false;
    // This deterministic adapter refusal cannot improve by opening another helper.
    // Classify only while this exact delivery owner still positively precedes every
    // native Send/receipt boundary. Authorized or uncertain outcomes keep their
    // existing ambiguous handling even if they report the same presentation text.
    if (entry.purpose === 'decision' && error === NATIVE_PROMPT_ENVELOPE_REFUSAL && entry.requiresAuthorization === true &&
        entry.sendAuthorizedAt === undefined && entry.messageId === undefined &&
        entry.deliveredAt === undefined && entry.deliveredSessionId === undefined &&
        entry.response === undefined && entry.toolReceiptUncertain !== true) {
      const code = 'goal_browser_prompt_envelope_invalid';
      const failure = classifyProviderRecoveryFailure({ confirmedUnsent: true, state: 'browser',
        sendAuthorized: false, messageIdPresent: false, deliveredAtPresent: false, error: code });
      await commit(current.map(row => sameDelivery(entry, row) ? {
        ...row, state: 'failed' as const, error: code, recoveryFailure: failure,
        ...addRecoveryTransition(row, failure.phase, failure.detail, 'failed')
      } : row));
      logWarn(`input ${id}: ${code}; pre-Send obligation retained, automatic helper replacement requires repair`);
      rejectDecision(code);
      return true;
    }
    if (entry.purpose === 'decision' && /\btoo many requests\b/i.test(error)) {
      browserHelperBackoffUntil = Math.max(browserHelperBackoffUntil, Date.now() + CHATGPT_HELPER_THROTTLE_MS);
      logInfo(`browser helper rate-limited; retrying new helpers after ${CHATGPT_HELPER_THROTTLE_MS / 1_000} seconds`);
    }
    const detail = typeof options.detail === 'string' && /^[a-z-]{1,40}$/.test(options.detail)
      ? options.detail : undefined;
    const recoveryWithdrawal = exactPreSendRelease &&
      error === 'After-turn pickup was withdrawn before Send.' &&
      Boolean(entry.recovery || entry.silenceBoundary || entry.completedTurnId || entry.sourceHelperId);
    if (recoveryWithdrawal) {
      // Custom recovery tickets are exact completed-turn/silence rows rather than upstream's
      // page-only recovery object. Re-offer only while that same source boundary is still the
      // latest eligible end; newer work retires this owner instead of receiving an old Continue.
      const sourceStillCurrent = await recoverySourceStillCurrent(entry);
      if (!sourceStillCurrent) {
        await commit(current.map(row => sameDelivery(entry, row) ? {
          ...row,
          state: 'failed' as const,
          owner: null,
          silenceBoundary: undefined,
          completedTurnId: undefined,
          companionInputId: undefined,
          offeredAt: undefined,
          sendAuthorizedAt: undefined,
          requiresAuthorization: undefined,
          deliveryText: undefined,
          error: 'Needs attention: the after-turn recovery source changed before native Send. The exact message is saved and was not sent.'
        } : row));
        return true;
      }
      const told = detail ? `${error} (${detail})` : error;
      if (recoveryReleaseTold.get(entry.id) !== told) {
        recoveryReleaseTold.set(entry.id, told);
        if (recoveryReleaseTold.size > 200)
          for (const old of [...recoveryReleaseTold.keys()].slice(0, 50)) recoveryReleaseTold.delete(old);
        logWarn(`input ${entry.id}: the browser could not send this recovery message — ${told.slice(0, 200)}`);
      }
      const now = Date.now();
      const since = entry.recoveryWithdrawnSince ?? now;
      const attempt = (entry.recoveryWithdrawAttempts ?? 0) + 1;
      const retry = attempt <= RECOVERY_WITHDRAW_REOFFER_DELAYS_MS.length &&
        now - since < RECOVERY_WITHDRAW_LIMIT_MS;
      if (!retry) {
        const terminalError = `Automatic Continue was not sent: ${detail ?? 'withdrawn before Send'}`.slice(0, 200);
        logWarn(`input ${entry.id}: automatic Continue ended after ${attempt} pre-Send withdrawals over ${Math.round((now - since) / 60_000)} minutes (last: ${told.slice(0, 160)})`);
        await commit(current.map(row => sameDelivery(entry, row) ? {
          ...row,
          state: 'failed' as const,
          owner: null,
          silenceBoundary: undefined,
          completedTurnId: undefined,
          companionInputId: undefined,
          offeredAt: undefined,
          sendAuthorizedAt: undefined,
          requiresAuthorization: undefined,
          deliveryText: undefined,
          recoveryWithdrawnSince: since,
          recoveryWithdrawAttempts: attempt,
          error: terminalError
        } : row));
        rejectDecision('goal_browser_send_failed: ' + terminalError);
        return true;
      }
      await commit(current.map(row => sameDelivery(entry, row) ? {
        ...withoutSilenceClaim(row, row === entry),
        ...(row === entry ? {
          recoveryWithdrawnSince: since,
          recoveryWithdrawAttempts: attempt,
          // Retry delay must not let a later checkpoint overtake this exact source-bound row.
          queueOrder: row.queueOrder ?? row.dueAt,
          dueAt: Math.max(row.dueAt, now + RECOVERY_WITHDRAW_REOFFER_DELAYS_MS[attempt - 1]!)
        } : {})
      } : row));
      return true;
    }
    // The document reports this only while its native Send has never been attempted.
    // A final can arrive after authorization and veto that click. Retain the spent
    // claim, but do not let an unsent Continue consume the final's Goal/Loop decision.
    if (entry.recovery && entry.requiresAuthorization === true && error === 'After-turn pickup was withdrawn before Send.') {
      await commit(current.map(row => row === entry
        ? { ...row, state: 'failed', completedTurnId: undefined, error } : row));
      return true;
    }
    // A generic transport failure supplies no proof that native Send was skipped.
    if (entry.recovery && entry.sendAuthorizedAt !== undefined) return false;
    // `requiresAuthorization` is granted only to the CoS input path whose native Send callback
    // must ask Main immediately before a click. Before that callback, both sides positively know
    // the external boundary was not crossed. Core identity/picker, model picker, editor insertion,
    // attachment transfer/upload and receipt-proof failures all arrive in this state. Preserve the
    // authored bytes and UUID, release browser custody, and make a bounded reoffer; never infer the
    // same fact after authorization, where a missing response is ambiguous and must not replay.
    if (exactPreSendRelease &&
        (options.confirmedUnsent === true || entry.purpose !== 'decision')) {
      const attempt = (entry.preSendReoffers ?? 0) + 1;
      const retry = attempt <= MAX_PRE_SEND_REOFFERS;
      const eligibleAt = Date.now();
      const exactFailure = error.slice(0, 200) || 'Unable to prepare ChatGPT';
      const recoveryFailure = classifyProviderRecoveryFailure({
        confirmedUnsent: true,
        state: entry.state === 'decision' ? 'sent' : 'browser',
        sendAuthorized: entry.sendAuthorizedAt !== undefined,
        messageIdPresent: entry.messageId !== undefined,
        deliveredAtPresent: entry.deliveredAt !== undefined,
        error: exactFailure
      });
      let next = current.map(row => sameDelivery(entry, row) ? {
        ...row,
        state: retry ? 'queued' as const : 'failed' as const,
        owner: null,
        offeredAt: undefined,
        sendAuthorizedAt: undefined,
        // A terminal failed row retaining this marker, with no Send/delivery/message receipt,
        // is the existing queue:chat confirmed-pre-Send retry contract. Never place an
        // authorized or otherwise ambiguous outcome in that lifecycle.
        requiresAuthorization: retry ? undefined : true,
        // The exact prepared envelope may already be sitting in the native composer.
        // Rebuilding context on a same-UUID retry makes that owned draft look foreign.
        // Combined deliveries split here, so their merged envelope must be rebuilt.
        deliveryText: row.id === entry.id && !entry.companionInputId ? row.deliveryText : undefined,
        companionInputId: undefined,
        completedTurnId: undefined,
        deliveryAttentionAt: undefined,
        preSendReoffers: attempt,
        recoveryFailure,
        ...addRecoveryTransition(row, recoveryFailure.phase, recoveryFailure.detail,
          retry ? 'queued' : 'failed'),
        ...(retry ? {
          dueAt: Math.max(row.dueAt, eligibleAt + (options.confirmedUnsent === true
            ? 0 : PRE_SEND_REOFFER_DELAYS_MS[attempt - 1]!)),
          ...(manualInput(row) && !queuedFollowup(row) ? { browserEligibleAt: eligibleAt } : {}),
          error: undefined
        } : {
          // Keep the actual picker/Core/editor/upload failure as the durable operator evidence.
          // The state/marker/counter already explain that it is terminal and proven pre-Send.
          error: exactFailure
        })
      } : row);
      if (!retry) next = releaseSameChatFollowerAfterConfirmedUnsent(next, entry).rows;
      await commit(next);
      if (!retry) {
        rejectDecision('goal_browser_send_failed: ' + error.slice(0, 200));
      }
      logInfo(retry
        ? `input ${id}: re-armed exact browser delivery after confirmed pre-Send release (${attempt}/${MAX_PRE_SEND_REOFFERS})`
        : `input ${id}: retained for attention after ${attempt} confirmed pre-Send preparation failures; native Send was never attempted`);
      return true;
    }
    const recoveryFailure = classifyProviderRecoveryFailure({
      confirmedUnsent: entry.requiresAuthorization === true && entry.sendAuthorizedAt === undefined,
      state: entry.state === 'decision' ? 'sent' : 'browser',
      sendAuthorized: entry.sendAuthorizedAt !== undefined,
      messageIdPresent: entry.messageId !== undefined,
      deliveredAtPresent: entry.deliveredAt !== undefined,
      error
    });
    let next = current.map((row) => sameDelivery(entry, row)
      ? {
        ...row,
        state: entry.companionInputId ? 'cancelled' as const : 'failed' as const,
        error: error.slice(0, 200),
        goalDecisionRejection: undefined,
        recoveryFailure,
        ...addRecoveryTransition(row, recoveryFailure.phase, recoveryFailure.detail,
          entry.companionInputId ? 'cancelled' : 'failed')
      }
      : row);
    const confirmedUnsent = entry.requiresAuthorization === true && entry.sendAuthorizedAt === undefined;
    const released = confirmedUnsent ? releaseSameChatFollowerAfterConfirmedUnsent(next, entry) : { rows: next, releasedId: null };
    next = released.rows;
    await commit(next);
    logWarn(`input ${entry.id}: browser_send_failure phase=${recoveryFailure.phase} detail=${detail === 'model-unconfirmed' ? detail : 'unspecified'} disposition=${entry.companionInputId ? 'cancelled-with-companion' : 'failed'}`);
    if (released.releasedId)
      logInfo(`input ${released.releasedId}: released same-chat explicit follower after ${entry.id} failed before native Send authorization`);
    rejectDecision('goal_browser_send_failed: ' + error.slice(0, 200));
    return true;
  });
  if (!accepted) return false;
  // Settings saves may own config.mutationQueue while awaiting this Input serializer.
  // Publish an accepted account hold OUTSIDE Input.serial, but retain this exact waiter
  // until publication finishes. This keeps commit → hold → release without queue inversion.
  await options.onAcceptedFailure?.();
  releaseAfterPublication?.();
  return true;
}

// The browser is an alternative decision transport, using this same exclusive outbox.
// A timeout cancels authority; late answers cannot become messages in the source chat.
const decisionWaiters = new Map<string, {
  resolve: (text: string) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  preparationExpiresAt?: number;
  publish?: (text: string) => void;
  onConversation?: (conversationId: string) => void;
  onAccepted?: (response: string, inputs: readonly InputEntry[]) => BrowserDecisionHandoff | null | Promise<BrowserDecisionHandoff | null>;
}>();
/** User-visible continuation only, not private helper output. The incumbent input outbox
 * carries native Send custody and rollback alongside the exact accepted helper UUID. */
export type BrowserDecisionHandoff =
  | { kind?: 'continue'; sessionId: string; conversationId: string; sourceTurnId: string; text: string; sourceAcceptedAt?: number }
  | { kind: 'stop'; sessionId: string; conversationId: string; sourceTurnId: string; sourceAcceptedAt?: number };
/** Goal requests exact source revocation; Input independently proves it before classifying custody. */
export class BrowserDecisionSourceSuperseded extends Error {
  constructor(readonly sessionId: string, readonly conversationId: string, readonly sourceTurnId: string) {
    super('goal_browser_source_superseded');
    this.name = 'BrowserDecisionSourceSuperseded';
  }
}

async function browserDecisionSourceSuperseded(row: InputEntry, reason: unknown, cancelled = false): Promise<boolean> {
  if (!(reason instanceof BrowserDecisionSourceSuperseded) || row.purpose !== 'decision' ||
      row.lifetime !== 'temporary-planner' || row.state !== (cancelled ? 'cancelled' : 'decision') ||
      (cancelled && decisionWaiters.has(row.id)) || !helperNativeSendConfirmed(row) ||
      row.decisionSourceSessionId !== reason.sessionId || row.decisionSourceTurnId !== reason.sourceTurnId ||
      !reason.conversationId) return false;
  return browserDecisionSourceAdvanced(reason.sessionId, reason.conversationId, reason.sourceTurnId);
}

/** Positive canonical supersession only; a missing old source or unreadable history is no proof. */
async function browserDecisionSourceAdvanced(sessionId: string, conversationId: string, sourceTurnId: string): Promise<boolean> {
  const oldFinal = (await readRecentEvents(sessionId, 256, { kinds: ['assistant_message'] })).find(event =>
    event.kind === 'assistant_message' && event.final &&
      (sourceTurnId.startsWith('reply:') ? event.messageId === sourceTurnId.slice(6) : event.turnId === sourceTurnId));
  if (oldFinal?.kind !== 'assistant_message') return false;
  const sourcePosition = oldFinal.origin ?? oldFinal.seq;
  const [boundary] = await readRecentEvents(sessionId, 1, { kinds: ['user_message', 'turn_start'] });
  const position = boundary?.kind === 'user_message' ? boundary.origin ?? boundary.seq : boundary?.seq ?? 0;
  if (position <= sourcePosition) return false;
  const [latestTurn] = boundary?.kind === 'turn_start'
    ? await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] }) : [];
  const question = !oldFinal.turnId ? await readLatestUserMessage(sessionId) : undefined;
  const owner = await findSessionByConversation(conversationId, { requireUnique: true });
  const session = await getSession(sessionId);
  if (owner?.id !== sessionId || session?.conversationId !== conversationId) return false;
  return boundary?.kind === 'user_message' || Boolean(boundary?.kind === 'turn_start' &&
    boundary.turnId !== oldFinal.turnId && (oldFinal.turnId || (question && (question.origin ?? question.seq) > sourcePosition)) &&
    (session.activeTurnId === boundary.turnId || (session.activeTurnId === null && latestTurn?.kind === 'turn_end' &&
      latestTurn.turnId === boundary.turnId && latestTurn.outcome === 'completed')));
}
/** A cold/expired waiter cannot observe later source revocation. Reuse that exact proof,
 * but only for a different completed source still owed by this session's current Goal owner.
 * This classifies the old receipt; it neither collects its answer nor releases its Send. */
async function cancelledBrowserDecisionSourceSuperseded(row: InputEntry, sourceSessionId: string, sourceTurnId: string): Promise<{
  conversationId: string; events: number; pending: NonNullable<ReturnType<typeof goalPendingReplyFor>>;
} | null> {
  if (row.goalSourceSuperseded || !row.decisionSourceTurnId || row.decisionSourceTurnId === sourceTurnId ||
      decisionWaiters.has(row.id) || !helperNativeSendConfirmed(row)) return null;
  const session = await getSession(sourceSessionId);
  const conversationId = session?.conversationId;
  const pending = conversationId ? goalPendingReplyFor(conversationId) : null;
  if (!conversationId || session.activeTurnId || session.origin?.kind === 'helper' || session.origin?.kind === 'worker' ||
      pending?.sessionId !== sourceSessionId || pending.turnId !== sourceTurnId || pending.eventSeq <= 0 ||
      !Number.isFinite(pending.acceptedAt) || pending.acceptedAt > Date.now() ||
      !goalArmedFor(conversationId) || browserDecisionHoldError() || isChatBlocked(conversationId) ||
      callsHoldRecovery(conversationId) || !automationRotationAdmits(conversationId) || continuationForSession(sourceSessionId)) return null;
  if (!await browserDecisionSourceSuperseded(row,
    new BrowserDecisionSourceSuperseded(sourceSessionId, conversationId, row.decisionSourceTurnId), true)) return null;
  const [end] = await readRecentEvents(sourceSessionId, 1, { kinds: ['user_message', 'turn_start', 'turn_end', 'handoff'] });
  const [final] = await readRecentEvents(sourceSessionId, 1, { kinds: ['assistant_message'] });
  const superseded = await conversationWasSuperseded(conversationId);
  const owner = await findSessionByConversation(conversationId, { requireUnique: true });
  const current = await getSession(sourceSessionId);
  const owed = goalPendingReplyFor(conversationId);
  // Last await closes source/binding rotation; policy, exact debt and live custody cannot
  // be borrowed from the earlier read while the existing serialized Input owner publishes.
  return !superseded && owner?.id === sourceSessionId && current?.conversationId === conversationId &&
    current.events === session.events && !current.activeTurnId &&
    end?.kind === 'turn_end' && end.outcome === 'completed' && end.turnId === sourceTurnId &&
    final?.kind === 'assistant_message' && final.final && final.turnId === sourceTurnId && final.messageId === pending.replyId &&
    (final.origin ?? final.seq) === pending.eventSeq &&
    owed?.sessionId === pending.sessionId && owed.turnId === pending.turnId && owed.replyId === pending.replyId &&
    owed.eventSeq === pending.eventSeq && owed.acceptedAt === pending.acceptedAt &&
    goalArmedFor(conversationId) && !browserDecisionHoldError() && !isChatBlocked(conversationId) &&
    !callsHoldRecovery(conversationId) && automationRotationAdmits(conversationId) &&
    !continuationForSession(sourceSessionId) && !decisionWaiters.has(row.id)
    ? { conversationId, events: current.events, pending } : null;
}
/** The Goal protocol owner rejected a completed answer, not its native prompt delivery.
 * This signal carries no private answer and grants no retry or continuation authority. */
export class BrowserDecisionProtocolRejection extends Error {
  readonly code: z.infer<typeof browserDecisionProtocolError>;
  constructor(code: string) {
    const parsed = browserDecisionProtocolError.safeParse(code);
    if (!parsed.success) throw new Error('Invalid browser decision rejection code');
    super(parsed.data);
    this.code = parsed.data;
    this.name = 'BrowserDecisionProtocolRejection';
  }
}
export function rejectedBrowserDecision(entry: InputEntry): boolean {
  return entry.purpose === 'decision' && entry.lifetime === 'temporary-planner' &&
    entry.state === 'failed' && entry.goalDecisionRejection !== undefined && entry.error === entry.goalDecisionRejection;
}
/** Presentation only, fenced by the same exact decision claim as its eventual answer. */
export async function publishBrowserDecision(id: string, owner: string, conversationId: string | null, text: string): Promise<boolean> {
  if (text.length > 8000) return false;
  const entry = (await load()).find(row => row.id === id && row.owner === owner && row.purpose === 'decision' &&
    row.conversationId === conversationId && ['browser', 'decision'].includes(row.state));
  const waiter = decisionWaiters.get(id);
  if (!entry || !waiter) return false;
  waiter.publish?.(text); return true;
}
export async function requestBrowserDecision(text: string, signal: AbortSignal, options: {
  lifetime?: 'temporary-planner';
  sourceSessionId?: string; sourceTurnId?: string; conversationId?: string | null; model?: string | null;
  /** Optional rendered references uploaded through the same native ChatGPT image path as authored input. */
  images?: InputImage[];
  /** A fresh user activation may retire an ambiguous old helper before creating another. */
  allowAmbiguousRetry?: boolean;
  reasoningEffort?: InputArgs['reasoningEffort'] | null;
  publish?: (text: string) => void;
  /** Receives the exact helper conversation once the browser has bound the decision there. */
  onConversation?: (conversationId: string) => void;
  onAccepted?: (response: string, inputs: readonly InputEntry[]) => BrowserDecisionHandoff | null | Promise<BrowserDecisionHandoff | null>;
  /** Original caller deadline, never inferred from queue publication time. */
  preparationExpiresAt?: number;
  /** Same-process Goal run identity only; never a browser-supplied dispatch hook. */
  onQueued?: (id: string) => void;
} = {}): Promise<string> {
  if (!text.trim() || text.length > MAX_CHATGPT_MESSAGE_CHARS) throw new Error('goal_context_too_large');
  signal.throwIfAborted();
  const images = options.images ?? [];
  if (images.length > 0) {
    try {
      await validateInputImages(images);
    } catch {
      throw new Error('Invalid image attachment');
    }
    signal.throwIfAborted();
  }
  const id = randomUUID();
  let resolveAnswer!: (text: string) => void;
  let rejectAnswer!: (reason: unknown) => void;
  const answer = new Promise<string>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
  void answer.catch(() => undefined);
  decisionWaiters.set(id, {
    resolve: resolveAnswer,
    reject: rejectAnswer,
    signal,
    preparationExpiresAt: options.preparationExpiresAt,
    publish: options.publish,
    onConversation: options.onConversation,
    onAccepted: options.onAccepted
  });
  const cancel = () => {
    decisionWaiters.delete(id);
    rejectAnswer(new Error('goal_browser_cancelled'));
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const queued = await serial(async () => {
      signal.throwIfAborted();
      const admissionHold = browserDecisionHoldError();
      if (admissionHold) throw new Error(admissionHold);
      const current = await load();
      const loadedHold = browserDecisionHoldError();
      if (loadedHold) throw new Error(loadedHold);
      if (restoredBrowserSignOutHold(current)) throw new Error('goal_browser_signed_out');
      if (Date.now() < browserHelperBackoffUntil) throw new Error('goal_browser_rate_limited');
      // An answer can be accepted into the original helper ledger immediately before Main
      // crashes, with Goal's corresponding continuation not yet saved. Privacy-safe durable
      // rows omit its text; `sent` still proves the answer existed. Never automatically ask
      // a SECOND helper for the very same source turn after a cold restore. Later turns have
      // different exact IDs and are unaffected. Only explicit per-source Restart/On
      // authority may create ONE fresh decision after human reconciliation. A Goal reply's
      // explicitActivation flag can outlive that replacement, so it cannot authorize a
      // third/fourth helper when the source remains pending after another cold restart.
      // The original accepted Send/UUID and private-answer redaction remain untouched.
      if (options.sourceSessionId && options.sourceTurnId) {
        const sameTurn = current.filter(row =>
          row.purpose === 'decision' && row.lifetime === 'temporary-planner' &&
          row.decisionSourceSessionId === options.sourceSessionId &&
          row.decisionSourceTurnId === options.sourceTurnId);
        if (sameTurn.some(row => row.goalSourceSuperseded)) throw new Error('goal_browser_source_superseded');
        if (sameTurn.some(row => row.state === 'sent') &&
            (!options.allowAmbiguousRetry || sameTurn.length !== 1)) {
          throw new Error('goal_browser_answer_custody_unconfirmed');
        }
      }
      if (current.filter((row) => row.purpose === 'decision' && ['queued', 'browser', 'decision'].includes(row.state)).length >= MAX_ACTIVE_BROWSER_HELPERS) throw new Error('goal_browser_busy');
      if (options.sourceSessionId && current.some(row => row.decisionSourceSessionId === options.sourceSessionId && !terminal(row))) throw new Error('goal_browser_busy');
      // A bound /c/ route makes the receipt stronger, never weaker. A replacement targeting
      // that same helper (or a different route) still needs explicit user authority when its
      // earlier Send was delivered or ambiguous.
      const cancelled = options.sourceSessionId
        ? current.filter(row => row.purpose === 'decision' && row.decisionSourceSessionId === options.sourceSessionId && row.state === 'cancelled')
        : [];
      // A browser claim that still required authorization and never crossed sendAuthorizedAt
      // is positive pre-Send evidence, not an ambiguous delivery. Retire those stale owners
      // automatically (including after an app restart) so a preparation timeout cannot leave
      // the source Loop permanently blocked. Unknown cancellations keep the strict explicit-retry
      // fence because replaying them could duplicate a real ChatGPT message.
      // Cancellation can also win before claimBrowserInput ever hands anything to a page.
      // Both normal cancellation and cold reconstruction retain the claim fields. Their
      // complete absence proves that no browser owned this helper; it must not poison all
      // subsequent Loop decisions with goal_browser_send_unconfirmed. Check every receipt,
      // not just owner (legacy or inconsistent rows with delivery evidence stay fenced).
      const safelyUnsent = cancelled.filter(helperConfirmedUnsent);
      const newlySuperseded = new Map<InputEntry, NonNullable<Awaited<ReturnType<typeof cancelledBrowserDecisionSourceSuperseded>>>>();
      if (options.lifetime === 'temporary-planner' && options.sourceSessionId && options.sourceTurnId) {
        for (const row of cancelled) {
          const proof = await cancelledBrowserDecisionSourceSuperseded(row, options.sourceSessionId, options.sourceTurnId);
          if (proof) newlySuperseded.set(row, proof);
        }
      }
      if (newlySuperseded.size > 0) {
        const proof = newlySuperseded.values().next().value!;
        const owner = await findSessionByConversation(proof.conversationId, { requireUnique: true });
        const source = await getSession(options.sourceSessionId!);
        const owed = goalPendingReplyFor(proof.conversationId);
        signal.throwIfAborted();
        const publicationHold = browserDecisionHoldError();
        if (publicationHold) throw new Error(publicationHold);
        // Proof resolution itself yields. Recheck every captured source episode at the
        // serialized publication boundary, including multiple retained old helpers.
        if (owner?.id !== options.sourceSessionId || source?.activeTurnId ||
            !goalArmedFor(proof.conversationId) || isChatBlocked(proof.conversationId) ||
            callsHoldRecovery(proof.conversationId) || !automationRotationAdmits(proof.conversationId) ||
            continuationForSession(options.sourceSessionId!) || [...newlySuperseded].some(([row, captured]) =>
              decisionWaiters.has(row.id) || source?.conversationId !== captured.conversationId || source.events !== captured.events ||
              owed?.sessionId !== captured.pending.sessionId || owed.turnId !== captured.pending.turnId ||
              owed.replyId !== captured.pending.replyId || owed.eventSeq !== captured.pending.eventSeq ||
              owed.acceptedAt !== captured.pending.acceptedAt)) newlySuperseded.clear();
      }
      // Proven obsolescence permits a decision for a DIFFERENT source, never replay of the
      // old helper. Keep its original cancelled UUID and native receipts across restart.
      const superseded = options.lifetime === 'temporary-planner' && options.sourceTurnId
        ? cancelled.filter(row => (row.goalSourceSuperseded || newlySuperseded.has(row)) && helperNativeSendConfirmed(row) && row.decisionSourceTurnId &&
          row.decisionSourceTurnId !== options.sourceTurnId) : [];
      // A Temporary Chat helper can confirm its exact native delivery without ever acquiring a
      // conversation id, but delivery alone does not explain why its answer waiter was cancelled.
      // Settings changes, explicit retirement and the local answer deadline all share this signal.
      // Even a witnessed answer-collection deadline cannot prove a sent helper was abandoned
      // by ChatGPT. Preserve every post-Send owner until explicit source reactivation.
      const ambiguous = cancelled.filter(row => !safelyUnsent.includes(row) && !superseded.includes(row));
      if (ambiguous.length > 0 && !options.allowAmbiguousRetry) {
        // Cancellation leaves answer custody unresolved even when native Send is proven.
        // Report that existing receipt truth without granting a replacement or retry.
        const delivered = ambiguous.every(helperNativeSendConfirmed);
        throw new Error(delivered && ambiguous.every(row => row.error === 'goal_browser_answer_expired')
          ? 'goal_browser_answer_expired' : delivered
            ? 'goal_browser_delivered_helper_unresolved' : 'goal_browser_send_unconfirmed');
      }
      const retired = new Set([...safelyUnsent, ...(options.allowAmbiguousRetry ? ambiguous : [])]);
      const available = retired.size > 0 || newlySuperseded.size > 0
        ? current.map(row => newlySuperseded.has(row) ? { ...row, goalSourceSuperseded: true as const,
          error: 'goal_browser_source_superseded' } : retired.has(row) ? { ...row, state: 'failed' as const,
          error: safelyUnsent.includes(row) ? 'Confirmed unsent helper retired for automatic retry'
            : 'User reactivated this chat and authorized a new helper' } : row)
        : current;
      const entry = entrySchema.parse({ id, sessionId: null, text, mode: 'after-turn', dueAt: Date.now(),
        // null means ChatGPT's current selection; only omission gets the unattended default.
        model: options.model === undefined ? 'gpt-6-thinking' : options.model,
        reasoningEffort: options.reasoningEffort === undefined ? 'high' : options.reasoningEffort,
        images: images.length > 0 ? images : undefined,
        decisionSourceSessionId: options.sourceSessionId, decisionSourceTurnId: options.sourceTurnId,
        lifetime: options.lifetime, purpose: 'decision', state: 'queued', owner: null,
        createdAt: Date.now(), conversationId: options.conversationId ?? null });
      await commit(append(available, entry));
      options.onQueued?.(id);
      if (safelyUnsent.length > 0)
        logInfo(`browser helper source ${options.sourceSessionId}: retired ${safelyUnsent.length} confirmed-unsent helper(s); replacement ${id} awaits its own browser claim`);
      if (newlySuperseded.size > 0)
        logInfo(`browser helper source ${options.sourceSessionId}: retained ${newlySuperseded.size} cancelled native receipt(s) after exact completed-source supersession; replacement ${id} awaits its own browser claim`);
      return entry;
    });
    signal.throwIfAborted();
    // A browser launch/reuse can be stuck even after the request's 180-second owner aborts.
    const wakeHold = browserDecisionHoldError();
    if (wakeHold) throw new Error(wakeHold);
    // The existing answer waiter already rejects on that exact abort. Race wake against it
    // so cancellation always reaches finally, durably retires this UUID, and lets Goal
    // classify a genuinely unclaimed helper. A late wake cannot return Send authority.
    await Promise.race([
      deliveryHooks?.wakeDecision?.(queued, signal) ?? Promise.resolve(),
      answer.then(() => undefined)
    ]);
    signal.throwIfAborted();
    return await answer;
  } finally {
    decisionWaiters.delete(id);
    signal.removeEventListener('abort', cancel);
    // Catch an abort that raced enqueue before the answer was awaited.
    void answer.catch(() => undefined);
    await serial(async () => {
      const current = await load();
      const ending = current.find(row => row.id === id && !terminal(row));
      if (ending) {
        const phase = ending.deliveredAt !== undefined || ending.messageId !== undefined ? 'awaiting-answer'
          : ending.sendAuthorizedAt !== undefined ? 'send-outcome-unconfirmed'
          : ending.offeredAt !== undefined || ending.owner !== null ? 'browser-preparing' : 'queued-unclaimed';
        logInfo(`browser helper ${id}: request ended phase=${phase} aborted=${signal.aborted}; preserving delivery receipts`);
      }
      if (current.some((row) => row.id === id && !terminal(row))) {
        const hold = browserDecisionHoldError();
        let superseded = false;
        try {
          superseded = Boolean(ending && signal.aborted && options.sourceSessionId === ending.decisionSourceSessionId &&
            options.sourceTurnId === ending.decisionSourceTurnId && await browserDecisionSourceSuperseded(ending, signal.reason));
        } catch {
          logWarn(`browser helper ${id}: source supersession proof unavailable; retaining the original cancellation fence and native receipts`);
        }
        // Only this request's typed local deadline, with a positively confirmed
        // native Send, may retain archive-only late-answer eligibility. Generic
        // cancellation, unknown Send and historical unmarked rows stay fenced.
        const answerExpired = Boolean(!superseded && ending && ending.goalSourceSuperseded !== true &&
          ending.error === undefined && signal.aborted && signal.reason instanceof DOMException &&
          signal.reason.name === 'TimeoutError' && signal.reason.message === 'goal_browser_answer_expired' &&
          options.lifetime === 'temporary-planner' && helperNativeSendConfirmed(ending) &&
          ending.decisionSourceSessionId && ending.decisionSourceTurnId &&
          options.sourceSessionId === ending.decisionSourceSessionId && options.sourceTurnId === ending.decisionSourceTurnId);
        await commit(current.map((row) => row.id === id && !terminal(row) ? { ...row, state: 'cancelled',
          ...(superseded ? { goalSourceSuperseded: true as const, error: 'goal_browser_source_superseded' } : {}),
          ...(answerExpired ? { error: 'goal_browser_answer_expired' } : {}),
          ...(hold && helperConfirmedUnsent(row) ? { error: hold } : {}) } : row));
        if (superseded) logInfo(`browser helper ${id}: exact native receipt retained after canonical source supersession; only a different source may earn a new decision`);
        if (answerExpired) logInfo(`browser helper ${id}: exact answer deadline retained for archive-only late output; no waiter or continuation restored`);
      }
    });
  }
}
function decisionOutputFile(id: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid helper output identity');
  return path.join(os.tmpdir(), 'CoS-helper-outputs', `${id}.json`);
}

/** POSIX rename durability needs the containing directory flushed as well as the file. */
async function syncDecisionOutputDirectory(folder: string): Promise<void> {
  // Windows rejects opening directories for fsync; the incumbent atomic replace owns its sharing retries.
  if (process.platform === 'win32') return;
  const handle = await fs.open(folder, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function saveDecisionOutput(row: InputEntry, response: string, _conversationId?: string | null): Promise<InputEntry['decisionOutput']> {
  if (row.lifetime !== 'temporary-planner') return undefined;
  const receipt = { sha256: createHash('sha256').update(response).digest('hex'), bytes: Buffer.byteLength(response) };
  if (row.decisionOutput && (row.decisionOutput.sha256 !== receipt.sha256 || row.decisionOutput.bytes !== receipt.bytes))
    throw new Error('Helper output differs from its accepted receipt');
  const file = decisionOutputFile(row.id);
  const folder = path.dirname(file);
  try {
    await fs.mkdir(folder, { recursive: true });
    if ((await fs.lstat(folder)).isSymbolicLink()) throw new Error('Helper output folder is a symbolic link');
    // A prior failed parent flush may have left this directory present; reprove it on retry.
    await syncDecisionOutputDirectory(path.dirname(folder));
  } catch (error) {
    logWarn(`browser helper ${row.id}: output folder unavailable at ${folder}; keep its tab and check storage permissions/free space`);
    throw error;
  }
  const record = { version: 1, inputId: row.id, owner: row.owner,
    sourceSessionId: row.decisionSourceSessionId ?? null, sourceTurnId: row.decisionSourceTurnId ?? null,
    ...receipt, response };
  const serialized = JSON.stringify(record, null, 2) + '\n';
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Helper output file is a symbolic link');
    const existing = await fs.readFile(file, 'utf8');
    if (existing !== serialized) throw new Error('Helper output archive conflicts with the accepted answer');
    await syncDecisionOutputDirectory(folder);
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await replaceFileAtomically(temp, file, 'helper output');
    await syncDecisionOutputDirectory(folder);
    if (await fs.readFile(file, 'utf8') !== serialized) throw new Error('Helper output archive readback failed');
    logInfo(`browser helper ${row.id}: output saved bytes=${receipt.bytes} sha256=${receipt.sha256} file=${file}`);
    return receipt;
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    logWarn(`browser helper ${row.id}: output archive failed; keep its tab and retry the same answer`);
    throw error;
  }
}

/** Fresh local readback immediately before browser closure. No Send/retry authority. */
export async function browserDecisionOutputSaved(id: string, owner: string, conversationId?: string | null): Promise<boolean> {
  const row = (await listInputs()).find(entry => entry.id === id && entry.owner === owner && entry.purpose === 'decision' && entry.lifetime === 'temporary-planner');
  if (!row || (row.conversationId && row.conversationId !== conversationId) || !['sent', 'failed', 'cancelled'].includes(row.state)) return false;
  if (!row.decisionOutput) return row.state !== 'sent' && helperConfirmedUnsent(row);
  try {
    const file = decisionOutputFile(id);
    if ((await fs.lstat(file)).isSymbolicLink() || (await fs.stat(file)).size > 150_000) return false;
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    return record.version === 1 && record.inputId === id && record.owner === owner &&
      record.sourceSessionId === (row.decisionSourceSessionId ?? null) &&
      record.sourceTurnId === (row.decisionSourceTurnId ?? null) &&
      typeof record.response === 'string' && record.sha256 === row.decisionOutput.sha256 &&
      record.bytes === row.decisionOutput.bytes && Buffer.byteLength(record.response) === row.decisionOutput.bytes &&
      createHash('sha256').update(record.response).digest('hex') === row.decisionOutput.sha256;
  } catch {
    logWarn(`browser helper ${id}: output readback unavailable; keeping its tab`);
    return false;
  }
}

export function completeBrowserDecision(id: string, owner: string, response: string, conversationId?: string | null,
  allowMissingWaiter = false): Promise<boolean> {
  return serial(async () => {
    if (!response.trim() || response.length > MAX_BROWSER_DECISION_RESPONSE_CHARS) return false;
    const current = await load();
    // A superseded or exactly expired decision can never instruct an executor again,
    // but its native-sent helper still owns an answer worth preserving before retirement.
    // Archive-only collection retains cancellation, original receipts and source identity.
    const superseded = current.find(entry => entry.id === id &&
      supersededBrowserDecisionArchiveEligible(entry, owner, conversationId));
    if (superseded) {
      const decisionOutput = await saveDecisionOutput(superseded, response, conversationId);
      if (decisionOutput && !superseded.decisionOutput)
        await commit(current.map(entry => entry === superseded ? { ...entry, decisionOutput } : entry));
      logInfo(`browser helper ${id}: obsolete output archived; source remains cancelled, no continuation authorized`);
      return true;
    }
    const rejected = current.find(entry => entry.id === id && entry.owner === owner && rejectedBrowserDecision(entry));
    if (rejected) {
      // A lost answer ACK may close the same owned helper after rejection, including a
      // cold restore. It must not reinterpret that response, resolve another waiter,
      // restore its private body or authorize another Send.
      if (conversationId && rejected.conversationId !== conversationId) return false;
      if (rejected.decisionOutput) {
        if (createHash('sha256').update(response).digest('hex') !== rejected.decisionOutput.sha256) return false;
        await saveDecisionOutput(rejected, response, conversationId); return true;
      }
      return rejected.response !== undefined ? rejected.response === response : true;
    }
    const settled = current.find(entry => entry.id === id && entry.owner === owner &&
      entry.purpose === 'decision' && entry.state === 'sent');
    if (settled) {
      // A lost /input/answer response can be republished after a cold Main restart.
      // Temporary Chat deliberately redacts the previously ACCEPTED answer from disk,
      // but the exact sent UUID/owner remains durable. Acknowledge that original result
      // without restoring private text, resolving a new waiter or granting another Send.
      // A newly claimed provider route is not interchangeable with the original one:
      // the native /input/ack owner must bind it first.
      if (conversationId && settled.conversationId !== conversationId) return false;
      if (settled.response !== undefined && settled.response !== response) return false;
      if (settled.decisionOutput && createHash('sha256').update(response).digest('hex') !== settled.decisionOutput.sha256) return false;
      if (settled.decisionOutput || settled.response !== undefined) {
        const decisionOutput = await saveDecisionOutput(settled, response, conversationId);
        if (decisionOutput && !settled.decisionOutput) await commit(current.map(entry => entry === settled ? { ...entry, decisionOutput } : entry));
        return true;
      }
      return settled.lifetime === 'temporary-planner';
    }
    if (!decisionWaiters.has(id) && !allowMissingWaiter) return false;
    const row = current.find((entry) => entry.id === id && entry.owner === owner && entry.purpose === 'decision' && ['browser', 'decision'].includes(entry.state));
    if (!row) return false;
    if (conversationId && row.conversationId && conversationId !== row.conversationId) return false;
    const waiter = decisionWaiters.get(id);
    const forward = await deliveryHooks?.settledTurnForwardReadiness?.(row, current,
      liveDeliveredBrowserDecision(row) ? 'collect' : undefined);
    if (forward === false) return false;
    let acceptedHandoff: BrowserDecisionHandoff | null;
    try {
      // The Goal owner may need to re-read its approved archived original and
      // recorded human history before this serial transaction commits a STOP
      // or queues an ordinary continuation. No second Send owner is created.
      acceptedHandoff = await waiter?.onAccepted?.(response, current) ?? null;
    } catch (error) {
      if (!(error instanceof BrowserDecisionProtocolRejection) || !waiter ||
          row.lifetime !== 'temporary-planner') throw error;
      // Failed decision != failed prompt Send. Preserve its exact native receipt and
      // return the raw answer only to the original live Goal owner, which already owns
      // protocol parsing and the three-attempt budget. Durable planner bodies stay redacted.
      const decisionOutput = await saveDecisionOutput(row, response, conversationId);
      await commit(current.map(entry => entry === row ? { ...entry, decisionOutput,
        conversationId: conversationId ?? row.conversationId, state: 'failed',
        error: error.code, goalDecisionRejection: error.code, response
      } : entry));
      if (decisionWaiters.get(id) !== waiter) return false;
      const resolvedConversation = conversationId ?? row.conversationId;
      if (resolvedConversation) waiter.onConversation?.(resolvedConversation);
      // An authority revision is not malformed helper JSON and cannot be
      // interpreted as an accepted STOP or executable Continue downstream.
      // Reject only the original waiting Goal request; its native helper Send
      // and the failed answer receipt remain durable, with no replacement Send.
      if (error.code === 'goal_canonical_scope_changed' ||
          error.code === 'goal_human_history_changed' || error.code === 'goal_plan_changed')
        waiter.reject(error);
      else waiter.resolve(response);
      return true;
    }
    const handoff = acceptedHandoff;
    let next = current.map((entry) => entry === row ? {
      ...entry, conversationId: conversationId ?? row.conversationId, state: 'sent' as const, response
    } : entry);
    if (handoff) {
      const isStop = handoff.kind === 'stop';
      if (row.lifetime !== 'temporary-planner' ||
          row.decisionSourceSessionId !== handoff.sessionId ||
          row.decisionSourceTurnId !== handoff.sourceTurnId ||
          (!isStop && !handoff.text.trim()) || isChatBlocked(handoff.conversationId))
        return false;
      const session = await getSession(handoff.sessionId);
      const owed = goalPendingReplyFor(handoff.conversationId);
      const [sourceEnd] = await readRecentEvents(handoff.sessionId, 1, {
        kinds: ['turn_start', 'turn_end']
      });
      const ordinaryTerminal = !isStop && (handoff.sourceTurnId.startsWith('reply:') ||
        (sourceEnd?.kind === 'turn_end' && sourceEnd.outcome === 'stalled' && sourceEnd.turnId === handoff.sourceTurnId))
        ? handoff.sourceAcceptedAt !== undefined && owed?.acceptedAt === handoff.sourceAcceptedAt &&
          !!row.owner && !!row.messageId && Number.isFinite(row.deliveredAt) &&
          (await ordinaryInputTerminalTurn(handoff.sessionId, handoff.conversationId, handoff.sourceTurnId, current, [row.id]) ||
            forward && await forward()) : null;
      const stoppedCheckpoint = !isStop && forward && helperNativeSendConfirmed(row) && sourceEnd?.kind === 'turn_end' &&
        sourceEnd.outcome === 'stopped' && sourceEnd.turnId === handoff.sourceTurnId &&
        deliberateStoppedLoopResumeFor(handoff.sessionId, handoff.conversationId, handoff.sourceTurnId) !== null;
      if (session?.conversationId !== handoff.conversationId ||
          session.activeTurnId ||
          (isStop
            ? (sourceEnd?.kind === 'turn_start' ||
              (sourceEnd?.turnId !== undefined && sourceEnd.turnId !== handoff.sourceTurnId &&
                sourceEnd.turnId !== owed?.silenceSourceTurnId))
            : (!ordinaryTerminal && !stoppedCheckpoint && (sourceEnd?.kind !== 'turn_end' || sourceEnd.outcome !== 'completed' ||
              sourceEnd.turnId !== handoff.sourceTurnId))) ||
          owed?.turnId !== handoff.sourceTurnId ||
          (handoff.sourceAcceptedAt !== undefined && owed?.acceptedAt !== handoff.sourceAcceptedAt) ||
          !goalArmedFor(handoff.conversationId) ||
          decisionWaiters.get(id) !== waiter) return false;
      if (isStop) {
        // A stop sends no message. Save its final disposition in the SAME durable
        // accepted-answer row; Goal's existing ledger reconciles this on completion
        // or at its existing startup recovery boundary, never on a timer.
        next = next.map(entry => entry.id === id ? {
          ...entry, goalStopDisposition: {
            sessionId: handoff.sessionId, conversationId: handoff.conversationId,
            sourceTurnId: handoff.sourceTurnId, sourceAcceptedAt: owed!.acceptedAt
          }
        } : entry);
      } else {
        // This existing outbox is the sole native Send owner for a continuation.
        const custody = recoveryContinuationEligibility(row);
        if (!custody.allowed) {
          logWarn(`browser continuation blocked source=${id.slice(0, 8)} recovery=${custody.recoveryChainId?.slice(0, 8) ?? 'none'} reason=${custody.reason} phase=${custody.phase ?? 'none'}`);
          return false;
        }
        const custodyEvidence = continuationCustodyDiagnostics(row);
        logInfo(`browser continuation admitted source=${custodyEvidence.inputId.slice(0, 8)} recovery=${custodyEvidence.recoveryChainId?.slice(0, 8) ?? 'none'} phase=${custodyEvidence.ownershipPhase} receipt=${custodyEvidence.receiptState}`);
        // The decision helper's model is independent of this account's executor policy.
        // Preserve the existing configured pair in the sole durable Send owner so an old
        // native picker cannot substitute another model when the preferred one is locked.
        const executionModel = getConfig().multiAgent;
        const outgoing = entrySchema.parse({
          id: randomUUID(), sessionId: handoff.sessionId, conversationId: handoff.conversationId,
          continuationId: randomUUID(),
          sourceHelperId: id, sourceHelperAcceptedAt: owed!.acceptedAt,
          ...(custody.recoveryChainId ? {
            recoveryChainId: custody.recoveryChainId,
            recoveryTransitions: row.recoveryTransitions
          } : {}),
          text: handoff.text, mode: 'after-turn', dueAt: Date.now(),
          model: executionModel?.defaultModel || null,
          reasoningEffort: executionModel?.defaultReasoning || null,
          state: 'queued', owner: null, createdAt: Date.now()
        });
        next = append(next, outgoing);
        const lifecycle = continuationLifecycleDiagnostics(outgoing);
        logInfo(`browser continuation lifecycle input=${lifecycle.inputId.slice(0, 8)} recovery=${lifecycle.recoveryChainId?.slice(0, 8) ?? 'none'} state=${lifecycle.continuationState} receipt=${lifecycle.receiptState}`);
      }
    }
    if (forward && !await forward()) return false;
    const decisionOutput = await saveDecisionOutput(row, response, conversationId);
    if (decisionOutput) next = next.map(entry => entry.id === row.id ? { ...entry, decisionOutput } : entry);
    if ((!waiter || decisionWaiters.get(id) !== waiter) && !allowMissingWaiter) return false;
    if (forward && !await forward()) return false;
    await commit(next);
    // The active request may abort during the durable rename itself. A successful
    // write is not permission to resolve its now-retired waiter or leave an
    // undelivered follow-up eligible in this process. Keep the original Send
    // receipt, but close both answer and unclaimed outgoing authority together.
    if ((!waiter || decisionWaiters.get(id) !== waiter) && !allowMissingWaiter) {
      await commit((await load()).map(entry => entry.id === id
        ? entry.goalStopDisposition ? { ...entry, response: undefined }
          : { ...entry, state: 'cancelled', response: undefined }
        : entry.sourceHelperId === id && entry.state === 'queued'
          ? { ...entry, state: 'cancelled', error: 'Goal source was cancelled before helper acceptance returned.' }
          : entry));
      return false;
    }
    const resolvedConversation = conversationId ?? row.conversationId;
    if (waiter && resolvedConversation) waiter.onConversation?.(resolvedConversation);
    waiter?.resolve(response);
    return true;
  });
}

/** The outbox's exact native-send receipt survives losing the helper document.
 * Collect through the existing completion transaction when the recorder carries that
 * user's final answer. This grants no new browser claim and never resubmits a prompt.
 */
export async function collectRecordedBrowserDecision(conversationId: string): Promise<void> {
  const pending = (await listInputs()).filter(row => row.purpose === 'decision' && row.state === 'decision' &&
    row.conversationId === conversationId && row.messageId && row.owner);
  if (pending.length !== 1 || isChatBlocked(conversationId) || await conversationWasSuperseded(conversationId)) return;
  const row = pending[0]!;
  const session = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!session || (row.deliveredSessionId && session.id !== row.deliveredSessionId)) return;
  const events = await readRecentEvents(session.id, 32, { kinds: ['user_message', 'assistant_message'], maxBytes: 1_048_576 });
  const user = events.findLastIndex(event => event.kind === 'user_message');
  const prompt = events[user];
  const final = events.at(-1);
  if (user < 0 || prompt?.kind !== 'user_message' || prompt.messageId !== row.messageId ||
      final?.kind !== 'assistant_message' || !final.final || final.state !== 'final' || !final.messageId ||
      final.message.truncated || final.message.text.length > MAX_BROWSER_DECISION_RESPONSE_CHARS) return;
  const completed = await completeBrowserDecision(row.id, row.owner!, final.message.text, conversationId, true);
  if (completed && final.messageId && final.turnId) {
    await confirmDeliveredGoalReplyNow(conversationId, session.id, final.turnId, final.messageId);
  }
}

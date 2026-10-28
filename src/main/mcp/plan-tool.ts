import { createHash } from 'node:crypto';
import { readDurableStrict } from '../durable.js';
import { logInfo } from '../logger.js';
import type { InputEntry } from '../session/input.js';
import { retainedInputExecutionResumeFor } from '../session/input.js';
import { currentCaller, currentCall } from './call-context.js';
import { fail, failIdentity, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
import { getSession, readHandoff, readRecentEvents, readSessionPlan, updateSessionPlan } from '../session/store.js';
import { canonicalAcceptanceSummary, canonicalAcceptanceView, agentPlanUpdateSchema, explicitlyCorrectsHumanAcceptance, previewAcceptanceMigration, requireRetainedAcceptance, retainedAcceptanceIdsFromObjective, unresolvedHumanCorrectionFragments, visibleAcceptanceDeclarations, type HumanCorrectionFragment, type RecordedExecutionEvidence } from '../../shared/agent-plan.js';
import { acceptanceScopeSha256, bindExecutionEvidenceToScope, executionEvidenceForPlan, goalObjectiveFor, goalSwitchFor, isGeneratedResumeBootstrapText, isNeutralHumanContinuation } from '../goal.js';
import { resumeBootstrapMatches } from '../session/handoff.js';
import { userPromptText } from '../../shared/user-prompt.js';
import { prepareAcceptanceRecoveryReview, validateAcceptanceRecoveryReview } from './acceptance-recovery.js';
import { canonicalInputProvenanceMatches } from '../session/input-history.js';

const ACCEPTANCE_HISTORY_PAGE = 128;
const ACCEPTANCE_HISTORY_MAX_PAGES = 16;

/** Acceptance is different from a UI history tail: the oldest genuine human
 * correction can still control this plan after hundreds of generated Loop
 * messages. Read by durable seq in bounded pages. A cap, gap or concurrent
 * user-message change is UNRESOLVED authority, never implicit permission to
 * migrate or claim the latest reconstructed checklist is complete. */
async function readAcceptanceHistory(sessionId: string): Promise<{
  events: Awaited<ReturnType<typeof readRecentEvents>>;
  coverage: 'complete' | 'partial';
  issue: string | null;
  recordedUserMessages: number | null;
}> {
  const begin = await getSession(sessionId);
  if (!begin) return { events: [], coverage: 'partial',
    issue: 'Original session could not be found before human-history reconciliation.',
    recordedUserMessages: null };
  let before = Number.POSITIVE_INFINITY;
  let reachedBeginning = false;
  let anomaly = false;
  const events: Awaited<ReturnType<typeof readRecentEvents>> = [];
  const seen = new Set<number>();
  for (let pageNumber = 0; pageNumber < ACCEPTANCE_HISTORY_MAX_PAGES; pageNumber++) {
    const page = await readRecentEvents(sessionId, ACCEPTANCE_HISTORY_PAGE, {
      kinds: ['user_message'], before, orderBySequence: true
    });
    if (page.length === 0) { reachedBeginning = true; break; }
    let oldest = before;
    for (const item of page) {
      if (!Number.isSafeInteger(item.seq) || item.seq < 1 ||
          item.seq >= before || seen.has(item.seq)) {
        anomaly = true;
        break;
      }
      seen.add(item.seq);
      oldest = Math.min(oldest, item.seq);
      events.push(item);
    }
    if (anomaly || oldest >= before) { anomaly = true; break; }
    before = oldest;
    if (page.length < ACCEPTANCE_HISTORY_PAGE) { reachedBeginning = true; break; }
  }
  const end = await getSession(sessionId);
  const stable = Boolean(end && end.conversationId === begin.conversationId &&
    end.userMessages === begin.userMessages && end.chatIds.join('\0') === begin.chatIds.join('\0'));
  const counted = events.length === begin.userMessages;
  const complete = reachedBeginning && !anomaly && stable && counted;
  return {
    events: events.sort((left, right) => left.seq - right.seq),
    coverage: complete ? 'complete' : 'partial',
    issue: complete ? null :
      `Acceptance human-history custody is incomplete or changed during review (observed ${events.length}/${begin.userMessages} user records, page limit ${ACCEPTANCE_HISTORY_MAX_PAGES * ACCEPTANCE_HISTORY_PAGE}); recover the full authoritative history before acceptance updates or durable migration.`,
    recordedUserMessages: begin.userMessages
  };
}

/** The native Input preparer uses the SAME complete authoritative human-scope
 * reader as update_plan. There is no second ledger or inferred correction. The
 * returned digest is sealed into the existing durable deliveryText BEFORE the
 * native Send; it cannot be created later from an agent-authored plan. */
export async function nativeExecutionScopeForPreparedInput(
  sessionId: string, conversationId: string,
  inputOwnerRows?: readonly InputEntry[], nativeInput?: Readonly<InputEntry>
): Promise<string | null> {
  if (!goalObjectiveFor(conversationId)) return null;
  const control = goalSwitchFor(conversationId);
  const held = nativeInput && inputOwnerRows?.filter(row => row.id === nativeInput.id);
  const registered = held?.length === 1 ? held[0] : null;
  const helpers = nativeInput?.sourceHelperId
    ? inputOwnerRows?.filter(row => row.id === nativeInput.sourceHelperId) : undefined;
  const helper = helpers && helpers.length === 1 ? helpers[0] : null;
  // Input still owns source/currentness, native admission and exactly-once Send.
  // These exceptions grant only a non-acceptance execution snapshot. Historical
  // unknown authorship must still refuse finite Goal/plan acceptance updates.
  const exactLoopChild = Boolean(control.own && control.enabled && control.mode === 'loop' && control.afterTurn &&
    nativeInput && registered && registered.sessionId === sessionId && registered.conversationId === conversationId &&
    registered.text === nativeInput.text &&
    registered.sourceHelperId === nativeInput.sourceHelperId &&
    registered.sourceHelperAcceptedAt === nativeInput.sourceHelperAcceptedAt &&
    nativeInput.sessionId === sessionId && nativeInput.conversationId === conversationId &&
    !nativeInput.purpose && !nativeInput.finishOwner && !nativeInput.recovery &&
    Number.isFinite(nativeInput.sourceHelperAcceptedAt) && nativeInput.sourceHelperAcceptedAt! > 0 &&
    helper?.state === 'sent' && helper.purpose === 'decision' && helper.lifetime === 'temporary-planner' &&
    helper.owner &&
    helper.decisionSourceSessionId === sessionId && helper.decisionSourceTurnId);
  const confirmedHelper = Boolean(helper?.messageId && Number.isFinite(helper.deliveredAt));
  // A fresh operator Resume may delegate this exact never-offered legacy child
  // while retaining its helper's missing ACK as unknown. The ephemeral Input
  // lease is independently current-source checked; it grants no acceptance.
  // A fresh ordinary instruction is itself explicit authority to continue the
  // current Loop. Bounded pruning of OLD confirmed rows must not permanently
  // prevent that instruction from entering its existing native Send owner.
  // Require the exact serialized current row at preparation AND authorization;
  // an arbitrary caller, old sent row or combined checkpoint cannot use this.
  const exactOperatorInput = Boolean(control.own && control.enabled && control.mode === 'loop' && control.afterTurn &&
    nativeInput && registered && registered.sessionId === sessionId && registered.conversationId === conversationId &&
    registered.text === nativeInput.text && nativeInput.sessionId === sessionId && nativeInput.conversationId === conversationId &&
    [registered, nativeInput].every(row => row.mode === 'auto' && ['queued', 'browser'].includes(row.state) &&
      humanAuthoredInput(row) && !row.purpose && !row.sourceHelperId && !row.companionInputId &&
      row.deliveredAt === undefined && row.messageId === undefined));
  const continuationOnly = exactOperatorInput || (exactLoopChild && (confirmedHelper || Boolean(nativeInput && inputOwnerRows &&
    await retainedInputExecutionResumeFor(sessionId, conversationId, inputOwnerRows, nativeInput))));
  const human = await retainedHumanPlanObjective(sessionId, conversationId, continuationOnly,
    inputOwnerRows, nativeInput);
  if (continuationOnly && human.unverifiedLoopScopeSha256 && human.scope && !human.incompleteHumanCorrections.length) {
    logInfo(`native Input: ${exactOperatorInput ? 'operator' : 'generated'} Loop scope fenced with unverified historical launch custody for ${sessionId}; acceptance remains unverified`);
    return human.unverifiedLoopScopeSha256;
  }
  if (human.historyCoverage !== 'complete' || !human.scope || human.incompleteHumanCorrections.length) {
    logInfo(`native Input: execution scope incomplete for ${sessionId}; history=${human.historyCoverage} inspected=${human.historyInspected} incompleteCorrections=${human.incompleteHumanCorrections.length} hasScope=${Boolean(human.scope)} issue=${human.historyIssue ?? 'none'}`);
    throw new Error('Native execution scope is incomplete; recover human acceptance and corrections before claiming this Input.');
  }
  return acceptanceScopeSha256(human.scope, human.original,
    human.corrections, human.incompleteHumanCorrections);
}

/** References printed by the real plan tool must contain EVERY field consumed
 * by its acceptance checker. The output remains a provenance hint, not proof
 * that the agent applied a Skill or that the installed workflow succeeded. */
export function recordedExecutionReferenceLines(evidence: RecordedExecutionEvidence): string[] {
  const taskVersion = evidence.taskVersionSha256;
  if (!taskVersion) return [];
  return [
    ...(evidence.coreResults ?? []).filter(item => item.executionScopeSha256 === taskVersion)
      .slice(-8).map(item => item.attributionMethod === 'request_id'
        ? `Core execution reference: core-execution-record attribution=request_id task-version-sha256=${taskVersion} session-id=${item.sessionId} conversation-id=${item.conversationId} request-id=${item.requestId} call-id=${item.callId} turn-id=${item.turnId} tool=${item.tool} result-sha256=${item.resultSha256} result-chars=${item.resultChars} native-output-message-id=${item.nativeOutputMessageId} native-output-sha256=${item.nativeOutputSha256}${item.resultReceiptId && item.nativeCallMessageId ? ` core-result-receipt=${item.resultReceiptId} native-call-message-id=${item.nativeCallMessageId}` : ''}`
        : `Core execution reference: core-result-receipt=${item.resultReceiptId} task-version-sha256=${taskVersion} session-id=${item.sessionId} conversation-id=${item.conversationId} native-call-message-id=${item.nativeCallMessageId} call-id=${item.callId} turn-id=${item.turnId} tool=${item.tool} result-sha256=${item.resultSha256} result-chars=${item.resultChars} native-output-message-id=${item.nativeOutputMessageId} native-output-sha256=${item.nativeOutputSha256}`),
    ...(evidence.skillApplications ?? []).filter(item => item.executionScopeSha256 === taskVersion)
      .slice(-8).map(item => `Native Skill delivery/final reference (application requires separate observed proof): native-skill-application skill-id=${item.skillId} task-version-sha256=${taskVersion} skill-body-sha256=${item.bodySha256} session-id=${item.sessionId} conversation-id=${item.conversationId} native-input-message-id=${item.inputMessageId} native-output-message-id=${item.outputMessageId} native-output-sha256=${item.outputSha256} native-turn-id=${item.turnId}`)
  ];
}

/**
 * First-plan acceptance authority may have arrived directly through Chrome,
 * without a separately saved Goal. Use only positively recorded human
 * user messages for that fallback; a user-role label, app-owned outbox echo,
 * generated Loop text or Resume bootstrap is not human authorship.
 */
/** Outbox origin, not a user-role label, distinguishes human-originated Input
 * from generated Goal/Loop/rotation/recovery work. These exact saved fields
 * already own native Send; they are not a second author/receipt database. */
function humanAuthoredInput(row: Readonly<InputEntry>): boolean {
  return !row.sourceHelperId && !row.finishOwner && !row.recovery &&
    row.purpose !== 'decision' && row.purpose !== 'rotation' &&
    row.lifetime !== 'temporary-planner';
}


async function retainedHumanPlanObjective(
  sessionId: string, conversationId: string, previewOnly = false,
  inputOwnerRows?: readonly InputEntry[], nativeInput?: Readonly<InputEntry>
): Promise<{
  scope: string;
  original: string;
  corrections: string[];
  originalReference: string;
  objectiveReference: string;
  correctionRecords: Array<{ text: string; reference: string }>;
  incompleteHumanCorrections: HumanCorrectionFragment[];
  savedGoalAtRead: string;
  historyCoverage: 'complete' | 'partial';
  historyIssue: string | null;
  historyInspected: number;
  unverifiedLoopScopeSha256: string | null;
}> {
  const saved = goalObjectiveFor(conversationId);
  let savedIds: string[] | null = null;
  try {
    savedIds = retainedAcceptanceIdsFromObjective(saved);
  } catch (error) {
    if (!previewOnly) throw error;
    // A preview is required to *describe* contradictory human source, not
    // treat it as a valid authority for a durable acceptance update.
  }
  const savedReference = `saved-goal:${conversationId}`;
  const session = await getSession(sessionId);
  if (!session || session.conversationId !== conversationId)
    return { scope: saved, original: saved, corrections: [],
      originalReference: savedReference, objectiveReference: savedReference, correctionRecords: [],
      incompleteHumanCorrections: [],
      savedGoalAtRead: saved,
      historyCoverage: 'partial', historyIssue: 'Exact caller session is not bound to the requested conversation.',
      historyInspected: 0, unverifiedLoopScopeSha256: null };
  const handoff = session.lastCommittedResumeHandoffId
    ? await readHandoff(sessionId, session.lastCommittedResumeHandoffId) : null;
  const history = await readAcceptanceHistory(sessionId);
  if (history.coverage === 'partial' && !previewOnly) {
    throw new Error(`Original human acceptance history could not be proven complete. ${history.issue} No plan was saved.`);
  }
  const events = history.events;
  const humanRecords: Array<{ text: string; reference: string }> = [];
  const humanDeliveries: Array<HumanCorrectionFragment & { incomplete: boolean }> = [];
  // Input's serializer passes its authoritative in-memory transaction while
  // preparing/authorizing a Send. An external plan read instead consults the
  // exact persisted outbox, never an arbitrary caller-supplied result list.
  const hasOutboxEvents = events.some(event => event.kind === 'user_message' && !!event.inputId);
  const rawInputs: unknown = inputOwnerRows ?? (hasOutboxEvents
    ? await readDurableStrict<unknown>('session-input') : []);
  if (!Array.isArray(rawInputs) || rawInputs.some(row => !row || typeof row !== 'object' ||
      typeof (row as Record<string, unknown>).id !== 'string')) {
    throw new Error('Native Input outbox provenance is incomplete; no human acceptance may be inferred.');
  }
  const inputRows = rawInputs as InputEntry[];
  const inputCounts = new Map<string, number>();
  const inputEventCounts = new Map<string, number>();
  for (const input of inputRows) inputCounts.set(input.id, (inputCounts.get(input.id) ?? 0) + 1);
  for (const event of events) if (event.kind === 'user_message' && event.inputId)
    inputEventCounts.set(event.inputId, (inputEventCounts.get(event.inputId) ?? 0) + 1);
  let unresolvedInputAuthorship = false;
  let onlyPrunedConfirmedInputs = true;
  // Domain separation prevents this transport/currentness fence from ever
  // matching a proven human acceptance scope. Hash all retained unknown text;
  // a real correction or changed/pruned custody invalidates a prepared Send.
  const loopScope = createHash('sha256').update(JSON.stringify([
    'unverified-loop-execution-only/v1', sessionId, conversationId, saved
  ]));
  for (const event of events) {
    if (event.kind !== 'user_message' || event.automationOrigin) continue;
    const authored = event.authoredText ?? userPromptText(event.message.text) ?? event.message.text;
    if (!authored || isGeneratedResumeBootstrapText(authored) ||
        (handoff && resumeBootstrapMatches(authored, handoff.text))) continue;
    if (event.unverifiedAuthorshipClaim) {
      // A native echo that asserted app ownership before Main's real receipt
      // is not an ordinary human message after the writer strips those labels.
      unresolvedInputAuthorship = true;
      onlyPrunedConfirmedInputs = false;
      loopScope.update(JSON.stringify(['unverified-native-owner', event.messageId, authored]));
      continue;
    }
    const retainedInput = event.inputId ? inputRows.find(row => row.id === event.inputId) : null;
    const canonicalReceipt = canonicalInputProvenanceMatches(event, sessionId, session.chatIds);
    if (canonicalReceipt && event.inputProvenance!.authorship === 'automation') continue;
    if (retainedInput && !humanAuthoredInput(retainedInput)) continue;
    loopScope.update(JSON.stringify([event.messageId, event.inputId ?? null,
      event.inputDelivery ?? null, authored, event.message.truncated && !event.authoredText,
      retainedInput ? [retainedInput.messageId, retainedInput.deliveredAt, retainedInput.text] : null,
      event.inputProvenance ?? null]));
    if (event.inputId) {
      if (!retainedInput && canonicalReceipt && event.inputProvenance!.authorship === 'human' &&
          !inputCounts.has(event.inputId) && inputEventCounts.get(event.inputId) === 1) {
        const reference = `human-input:${event.inputId}:native-message:${event.messageId}`;
        humanDeliveries.push({ text: event.authoredText!, reference, incomplete: false });
        humanRecords.push({ text: event.authoredText!, reference });
        continue;
      }
      // A real native/HTTP Input has an app-owned delivery record and exact
      // provider message id. Its native echo may change source=app to
      // source=extension without changing human authorship. Losing the receipt
      // is *unknown*, not proof a generated outbox message was a correction.
      const input = retainedInput;
      if (!input || inputCounts.get(event.inputId) !== 1 ||
          inputEventCounts.get(event.inputId) !== 1 ||
          !['app', 'extension'].includes(event.source) ||
          // A committed Resume replaces the native chat, not its historical
          // human instructions. Require the same durable session and an exact
          // recorded native lineage member; unrelated chats remain foreign.
          (input.conversationId !== conversationId && !session.chatIds.includes(input.conversationId ?? '')) ||
          (input.sessionId !== sessionId && input.deliveredSessionId !== sessionId) ||
          !['sent', 'cancelled'].includes(input.state) ||
          input.messageId !== event.messageId || !Number.isFinite(input.deliveredAt) ||
          event.inputDelivery !== 'confirmed' ||
          (event.authoredText !== undefined && event.authoredText !== input.text)) {
        // Neutral old rows cannot revise an original; substantive missing
        // custody cannot be silently ignored when sealing a new task version.
        if (!isNeutralHumanContinuation(authored)) {
          unresolvedInputAuthorship = true;
          // Only missing bounded outbox rows with a full canonical confirmed
          // projection qualify. Conflicts, duplicate/foreign rows, offered or
          // truncated inputs retain the ordinary fail-closed authority hold.
          if (input || inputEventCounts.get(event.inputId) !== 1 ||
              !['app', 'extension'].includes(event.source) || event.inputDelivery !== 'confirmed' ||
              !event.authoredText || !event.messageId || event.messageId.startsWith('input:')) onlyPrunedConfirmedInputs = false;
        }
        continue;
      }
      const reference = `human-input:${input.id}:native-message:${event.messageId}`;
      const incomplete = event.message.truncated && !event.authoredText;
      humanDeliveries.push({ text: input.text, reference, incomplete });
      if (!incomplete) humanRecords.push({ text: input.text, reference });
      continue;
    }
    if (event.source !== 'extension') continue;
    const reference = `human-event:${event.messageId}`;
    const incomplete = event.message.truncated && !event.authoredText;
    humanDeliveries.push({ text: authored, reference, incomplete });
    if (!incomplete) humanRecords.push({ text: authored, reference });
  }
  // The *currently claimed* genuine human Input is itself the next authored
  // correction. It has not yet received its native ACK, so it cannot be read
  // back from the recorder. Only Input's serialized current row authorizes
  // this provisional preparation/authorization version; acceptance after Send
  // independently requires the confirmed durable outbox+native message join.
  if (nativeInput && inputOwnerRows &&
      inputCounts.get(nativeInput.id) === 1 &&
      inputRows.some(row => row.id === nativeInput.id && row.text === nativeInput.text &&
        row.sessionId === nativeInput.sessionId && row.conversationId === nativeInput.conversationId) &&
      nativeInput.sessionId === sessionId && nativeInput.conversationId === conversationId &&
      humanAuthoredInput(nativeInput) && !inputEventCounts.has(nativeInput.id)) {
    const reference = `pending-native-human-input:${nativeInput.id}`;
    loopScope.update(JSON.stringify([reference, nativeInput.text]));
    humanRecords.push({ text: nativeInput.text, reference });
    humanDeliveries.push({ text: nativeInput.text, reference, incomplete: false });
  }
  if (unresolvedInputAuthorship && !previewOnly) throw new Error(
    'Native Input human authorship is unverified; reconcile the exact original outbox/native ACK before task-version authorization.');
  const incompleteHumanCorrections = unresolvedHumanCorrectionFragments(humanDeliveries);
  // A saved human objective is authoritative until a positively recorded
  // *explicit* correction changes its ID list. Retain the original per-item
  // quality bar when a newer correction only lists IDs or amends one item.
  const enumerations = humanRecords.filter(record => {
    try { return Boolean(retainedAcceptanceIdsFromObjective(record.text)); }
    catch (error) {
      if (!previewOnly) throw error;
      return explicitlyCorrectsHumanAcceptance(record.text);
    }
  });
  const latestHumanIds = savedIds
    ? enumerations.filter(record => explicitlyCorrectsHumanAcceptance(record.text)).at(-1)
    : enumerations.at(-1);
  const originalHuman = savedIds ? null : enumerations[0];
  // The genuine human may strengthen a native task without using the words
  // "Current correction". In that case the original acceptance IDs and wording
  // remain controlling, but the execution-version digest MUST change. A newly
  // recorded automatic Goal user-role continuation is never in humanRecords;
  // a neutral actual human "Continue" is not a new task requirement. The first
  // generic original recorded human opening is not automatically a correction
  // to a separate saved Goal. An unmistakable first "Also ..." is.
  const correctionRecords = humanRecords.filter((record, index) => {
    if (explicitlyCorrectsHumanAcceptance(record.text)) return true;
    const visible = visibleAcceptanceDeclarations(record.text).trim();
    if (!visible || isNeutralHumanContinuation(visible) || record.text === saved ||
        record.text === originalHuman?.text) return false;
    return index > 0 || /^(?:also|additionally)\s+(?:preserve|keep|require|ensure|verify|include|support|implement|retain|restore|fix|check|handle)\b/i.test(visible);
  });
  return {
    scope: latestHumanIds?.text ?? saved,
    original: savedIds ? saved : originalHuman?.text ?? saved,
    corrections: correctionRecords.map(record => record.text),
    originalReference: originalHuman?.reference ?? savedReference,
    objectiveReference: latestHumanIds?.reference ?? savedReference,
    correctionRecords,
    incompleteHumanCorrections,
    savedGoalAtRead: saved,
    historyCoverage: unresolvedInputAuthorship ? 'partial' : history.coverage,
    historyIssue: unresolvedInputAuthorship
      ? 'Native Input row has unverified human authorship, incomplete Send receipt or foreign/duplicate outbox custody.'
      : history.issue,
    historyInspected: history.events.length,
    unverifiedLoopScopeSha256: unresolvedInputAuthorship && onlyPrunedConfirmedInputs && history.coverage === 'complete'
      ? loopScope.digest('hex') : null
  };
}

/**
 * Adapted from OpenAI Codex's update_plan (Apache-2.0), revision
 * 1a4096e273e80da30947e57fdfa45be92858ca91. CoS adds bounded step details and
 * stores the plan under the proven durable session instead of an outer Codex turn.
 */
export function registerPlanTool(reg: SurfaceRegistrar): void {
  reg.register('update_plan', toolDeclaration('update_plan', () => ({
    title: 'Update plan',
    description: 'Stores this chat\'s plan; does not execute tasks or change automation. Omitted checklist items keep immutable recorded identity and evidence; genuine later human corrections preserve their original IDs and criteria. For a deterministic read-only legacy acceptance migration review with field-level human provenance, pass previewOnly:true, plan:[] and no checklist. That branch never changes the stored plan or authorizes migration. Ordinary updates retain the current exact caller/session proof and original human acceptance.',
    inputSchema: agentPlanUpdateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), update => guard('update_plan', async () => {
    if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings → Chat');
    const caller = currentCaller();
    if (!caller.sessionId || !caller.conversationId) {
      return failIdentity('Exact chat identity is required to update its plan. No plan was changed; retry after the companion reconnects.');
    }
    // A saved human objective is durable task authority. Generated user-role
    // Loop/Resume messages and current tool arguments are not. Existing plan
    // retention below still runs inside the session owner's queued write.
    const [humanScope, previous] = await Promise.all([
      retainedHumanPlanObjective(caller.sessionId, caller.conversationId, update.previewOnly === true),
      readSessionPlan(caller.sessionId)
    ]);
    if (update.previewOnly) {
      const bound = await getSession(caller.sessionId);
      if (!bound || bound.conversationId !== caller.conversationId) {
        return failIdentity('The recorded session is no longer bound to this caller. No preview or plan write was performed.');
      }
      const previewEvidence = bindExecutionEvidenceToScope(
        await executionEvidenceForPlan(caller.sessionId, caller.conversationId, previous),
        humanScope.scope, humanScope.original, humanScope.corrections, humanScope.incompleteHumanCorrections);
      const preview = previewAcceptanceMigration({
        objective: humanScope.scope,
        originalObjective: humanScope.original,
        originalReference: humanScope.originalReference,
        objectiveReference: humanScope.objectiveReference,
        recorded: previous,
        historyCoverage: humanScope.historyCoverage,
        historyIssue: humanScope.historyIssue,
        historyInspected: humanScope.historyInspected,
        recordedSnapshotSha256: previous
          ? createHash('sha256').update(JSON.stringify(previous)).digest('hex')
          : undefined,
        corrections: humanScope.correctionRecords,
        incompleteHumanCorrections: humanScope.incompleteHumanCorrections,
        executionEvidence: previewEvidence
      });
      const recoveryReview = prepareAcceptanceRecoveryReview({
        sessionId: caller.sessionId, conversationId: caller.conversationId,
        objective: humanScope.scope, originalObjective: humanScope.original,
        originalReference: humanScope.originalReference,
        objectiveReference: humanScope.objectiveReference,
        corrections: humanScope.correctionRecords,
        incompleteHumanCorrections: humanScope.incompleteHumanCorrections,
        recorded: previous, preview
      });
      // Reads above are intentionally outside the write owner's queue. Re-read
      // the exact saved plan/session/Goal just before publishing the review;
      // concurrent edits must not yield a stale packet called 'current'.
      const [freshPlan, freshSession] = await Promise.all([
        readSessionPlan(caller.sessionId), getSession(caller.sessionId)
      ]);
      if (!freshSession || freshSession.conversationId !== caller.conversationId) {
        return failIdentity('Session/Resume ownership changed during migration review; no plan changed. Recreate a new scoped preview.');
      }
      if (goalObjectiveFor(caller.conversationId) !== humanScope.savedGoalAtRead ||
          (humanScope.historyCoverage === 'complete' &&
           freshSession.userMessages !== humanScope.historyInspected)) {
        return fail('Human acceptance history or Goal changed during read-only preview. Do not reuse this review; regenerate it. No plan changed.');
      }
      const verifiedReview = validateAcceptanceRecoveryReview(recoveryReview, {
        sessionId: caller.sessionId, conversationId: caller.conversationId,
        objective: humanScope.scope, originalObjective: humanScope.original,
        originalReference: humanScope.originalReference,
        objectiveReference: humanScope.objectiveReference,
        corrections: humanScope.correctionRecords,
        incompleteHumanCorrections: humanScope.incompleteHumanCorrections,
        recorded: freshPlan, preview
      });
      if (verifiedReview.problems.some(problem =>
        /persisted plan changed|Session\/conversation binding changed|review seal mismatch|Historical rollback/.test(problem))) {
        return fail('Stored plan or recovery packet changed during preview. Recompute human history and a fresh rollback snapshot; no plan changed.');
      }
      return ok(`No plan was changed. Human acceptance migration REVIEW ONLY; applyAuthorized=false.\n${JSON.stringify({
        ...preview, recoveryReview
      })}`);
    }
    const executionEvidence = bindExecutionEvidenceToScope(
      await executionEvidenceForPlan(caller.sessionId, caller.conversationId, previous, update.checklist ?? []),
      humanScope.scope, humanScope.original, humanScope.corrections, humanScope.incompleteHumanCorrections);
    const view = canonicalAcceptanceView(humanScope.scope, previous, humanScope.original,
      humanScope.corrections, humanScope.incompleteHumanCorrections, executionEvidence);
    // A legacy source-only checklist with correct human IDs can otherwise
    // permanently block even an unrelated working plan update. Allow *only*
    // omitted-checklist step updates on that existing identity-bound session;
    // stored acceptance wording/evidence remain immutable, while every report
    // uses the reversible canonical human view. Missing/extra/contradictory
    // IDs, ambiguous source and explicit checklist rewrites still fail closed.
    const safeLegacyStepsOnly = Boolean(previous && view.ids &&
      view.staleIds.length > 0 && view.missingIds.length === 0 &&
      view.extraIds.length === 0 && view.unresolvedIds.length === 0 &&
      view.issues.every(issue => view.staleIds.some(id => issue.startsWith(`${id}:`))) &&
      !update.checklist?.length);
    if (!safeLegacyStepsOnly) {
      requireRetainedAcceptance(humanScope.scope, previous, update, humanScope.original,
        humanScope.corrections, humanScope.incompleteHumanCorrections, executionEvidence);
    }
    const accepted = await updateSessionPlan(caller.sessionId, caller.conversationId, update, currentCall()!.startedAt);
    if (!accepted) return fail('This plan update is stale or its chat was replaced. The current plan was preserved.');
    const checklist = canonicalAcceptanceSummary(humanScope.scope, await readSessionPlan(caller.sessionId),
      humanScope.original, humanScope.corrections, humanScope.incompleteHumanCorrections, executionEvidence);
    // Expose only exact receipt metadata so a later evidence row can cite a
    // real execution. Tool arguments/results and Skill body text stay in their
    // existing private journals; metadata alone is not product acceptance.
    const receiptLines = recordedExecutionReferenceLines(executionEvidence);
    const summary = checklist ? `Plan updated. Current active acceptance summary:\n${checklist}` : 'Plan updated';
    return ok(receiptLines.length
      ? `${summary}\n\nRecorded execution references (metadata only; associate them with an original requirement only when the actual output supports it):\n${receiptLines.join('\n')}`
      : summary);
  }));
}

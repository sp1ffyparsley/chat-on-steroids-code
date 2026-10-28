import { workflowStepSchema } from '../src/shared/workflow.mjs';
import { assertOperatorPromptEnvelope, operatorPromptBody, prepareOperatorPrompt, OPERATOR_PROMPT_FOOTER } from '../src/shared/operator-prompt.mjs';
import { prependUserPrompt, userPromptText } from '../src/shared/user-prompt.js';
import { publishWorkflowReceipt, recheckWorkflowInput } from '../src/main/session/input.js';
import { REASONING_EFFORTS } from '../src/shared/session.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { getLog } from '../src/main/logger.js';
import { flushDurable, initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import {
  fileRotationInput, userRequestedInput, fileSilenceInput, deferSilenceInput, revokeSilenceInputs, pendingQueuedPickups, inputBeforeGoal, inputArgs, acknowledgeBrowserInput, cancelInput, cancelQueuedInputByOperator, cancelSessionInputs, claimBrowserInput, completeBrowserDecision, browserDecisionOutputSaved, BrowserDecisionProtocolRejection, enqueueInput,
  failBrowserInput, failInputsForDeletedConversation, listInputs, offerToolInput as offerToolInputBatch, acknowledgeToolInput, pendingBrowserInputs, requestBrowserDecision, setBrowserDecisionAuthentication, suspendPausedBrowserDecisionWaits, resetInputForTests, configureInputDelivery, withGoalReplyActivationInput,
  authorizeBrowserHelperRetry, settleTimedOutBrowserHelper, pausedBrowserHelpers, hasEligibleToolInput, editQueuedInput, reorderQueuedInputs, rearmQueuedBrowserInput, setInputAutomation, authorizeBrowserInput, sessionInputPolicy, operatorInputSemanticKey, BROWSER_RECEIPT_WAIT_MS, UNCLAIMED_BROWSER_ATTENTION_MS, continuationLifecycleDiagnostics, noteInputContinuationHold, recoveryContinuationEligibility, retainedSourceHelperContinuationFor, rebindRetainedSourceHelperContinuation, sessionDecisionHelperCustody, activeBrowserDecisionWork, liveDeliveredBrowserDecision
} from '../src/main/session/input.js';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';
import { retainSourceHelperContinuation, BrowserDecisionSourceSuperseded, ordinaryInputWatchdogBoundary } from '../src/main/session/input.js';
import * as goalCustody from '../src/main/goal.js';
import * as resumeCustody from '../src/main/session/continuation.js';
import * as rotationCustody from '../src/main/automation-rotation.js';
import { noteChatOrigin } from '../src/main/session/recorder.js';
import { stageInputAttachment } from '../src/main/session/input-attachments.js';
import { listUsageSessions, turnHasMcpCall, readRecentEvents, conversationWasSuperseded } from '../src/main/session/store.js';
import { trackInFlight, emptyEvidence, type CallContext } from '../src/main/mcp/call-context.js';
// Ownership tests inspect messages; batch-specific assertions use the complete delivery below.
// These ownership tests compare authored instructions. Verify the mandatory wire wrapper
// before extracting semantics; batch-specific tests below also inspect complete wire bytes.
const semanticMessages = (messages: Awaited<ReturnType<typeof offerToolInputBatch>>['messages']) => messages.map(message => {
  assertOperatorPromptEnvelope(message.text);
  return { ...message, text: operatorPromptBody(message.text) };
});
const offerToolInput = async (...args: Parameters<typeof offerToolInputBatch>) => semanticMessages((await offerToolInputBatch(...args)).messages);
vi.mock('../src/main/session/recorder.js', () => ({ noteChatOrigin: vi.fn(async () => undefined) }));

const binding = vi.hoisted(() => ({ origin: 'desktop', conversationId: 'conversation-a', blocked: false, recorded: true, activeTurnId: null as string | null, lastToolCallAt: null as number | null, finishEnabled: true, finishReleased: false, automationPaused: false, model: 'gpt-6-astra', leadMinutes: 5, impulseMinutes: 0, end: null as null | { kind: string; outcome: string; reason?: string; turnId: string; time: number; seq?: number } }));
vi.mock('../src/main/session/store.js', () => ({
  sessionsRoot: () => path.join(directory, 'sessions'),
  listUsageSessions: vi.fn(async () => []),
  sessionDirectoryMissing: vi.fn(async () => false),
  conversationWasSuperseded: vi.fn(async () => false),
  readRecentEvents: vi.fn(async () => binding.end ? [binding.end] : []),
  turnHasMcpCall: vi.fn(async () => true),
  getSession: vi.fn(async (id: string) => ({ id, conversationId: id === 'session-two' ? 'conversation-b' : binding.conversationId, activeTurnId: binding.activeTurnId,
    origin: { kind: binding.origin }, lastToolCallAt: binding.lastToolCallAt,
    finishTurn: { turnId: binding.activeTurnId, released: binding.finishReleased },
    selectedModel: { conversationId: id === 'session-two' ? 'conversation-b' : binding.conversationId, model: binding.model } })),
  findSessionByConversation: vi.fn(async (id: string) => binding.recorded && id === binding.conversationId ? { id: 'session-one', conversationId: id } : null)
}));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { finishTool: binding.finishEnabled, finishAction: 'goal', finishLeadMinutes: binding.leadMinutes, automationPaused: binding.automationPaused }, goal: { impulseMinutes: binding.impulseMinutes } }) }));
vi.mock('../src/main/session/blocked-chats.js', () => ({ isChatBlocked: () => binding.blocked }));
let directory: string;
let now: number;
const automate = vi.fn(async (_conversationId: string, _automation: string, _phase: string) => undefined);
const changed = vi.fn();
const sessionId = 'session-one';
function input(overrides: Partial<InputArgs> = {}): InputArgs {
  return { id: randomUUID(), sessionId, text: 'Please inspect this', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null,
    ...(overrides.workflow && overrides.sessionId === null ? { automation: 'off' as const, finiteOneOff: true as const } : {}), ...overrides };
}

describe('mandatory native prompt envelope', () => {
  it.each([null, 'session-one'])('wraps a normal composer delivery once and freezes it across claims (%s)', async target => {
    const row = await enqueueInput(input({ sessionId: target, text: 'Inspect the actual project.', ...(target ? {} : { nickname: 'My exact nickname' }) }));
    const conversation = target ? binding.conversationId : null;
    const first = await claimBrowserInput(row.id, 'envelope-page', conversation, true);
    expect(first).not.toBeNull();
    expect(operatorPromptBody(first!.text)).not.toBe(first!.text);
    expect(first!.text.split('\n')[0]!.match(/\?/g)).toHaveLength(1);
    expect(first!.text.split('\n').at(-1)).toBe(OPERATOR_PROMPT_FOOTER);
    expect(operatorPromptBody(first!.text)).toContain(row.text);
    const second = await claimBrowserInput(row.id, 'envelope-page', conversation, true);
    expect(second!.text).toBe(first!.text);
    expect((await listInputs()).find(item => item.id === row.id)).toMatchObject({ text: row.text, ...(target ? {} : { nickname: 'My exact nickname' }) });
  });

  it('moves a CLI envelope outside the complete app context without nesting or renaming', async () => {
    configureInputDelivery({ applyAutomation: automate, changed,
      prepareText: async entry => prependUserPrompt(entry.text, 'Complete Core and project context.') });
    const authored = 'Continue the SAME Scene Pack task.';
    const row = await enqueueInput(input({ sessionId: null, text: prepareOperatorPrompt(authored, upper => upper - 1), nickname: 'Scene Pack' }));
    const claim = await claimBrowserInput(row.id, 'context-page', null, true);
    const framed = operatorPromptBody(claim!.text);
    expect(framed.startsWith('[[COS_CONTEXT:')).toBe(true);
    expect(userPromptText(claim!.text)).toBe(authored);
    expect(claim!.text.split('\n').filter(line => (line.match(/\?/g) ?? []).length === 1)).toHaveLength(1);
    expect(claim!.text.split('\n').at(-1)).toBe(OPERATOR_PROMPT_FOOTER);
    expect((await listInputs()).find(item => item.id === row.id)?.nickname).toBe('Scene Pack');
  });

  it('refuses Send authorization for a retained legacy payload missing the mandatory envelope', async () => {
    const row = { ...input(), state: 'browser', owner: 'old-page', conversationId: binding.conversationId,
      createdAt: 1, offeredAt: 2, requiresAuthorization: true, deliveryText: 'An older unwrapped prepared payload.' };
    await writeDurableNow('session-input', [row]);
    await expect(authorizeBrowserInput(row.id, 'old-page', binding.conversationId)).rejects.toThrow(/prompt.*envelope/i);
    expect((await listInputs()).find(item => item.id === row.id)?.sendAuthorizedAt).toBeUndefined();
  });
});

describe('recipe steps share durable Input delivery and restart custody', () => {
  const workflow = (runId: string, step: string, order: number, dependsOn: string[] = []) => workflowStepSchema.parse({
    runId, recipeSha256: 'a'.repeat(64), step, order, total: 2, maxParallel: 1,
    dependsOn, checks: [{ kind: 'acceptance' }]
  });
  it('holds a partial batch, then elects its root, withholds its dependent across both transports and restart', async () => {
    const runId = randomUUID();
    const first = await enqueueInput(input({ sessionId: null, workflow: workflow(runId, 'first', 0) }));
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(first.id, 'native-page', null)).toBeNull();
    const second = await enqueueInput(input({ sessionId: null, workflow: workflow(runId, 'second', 1, [first.id]) }));
    expect((await pendingBrowserInputs()).map(row => row.id)).toEqual([first.id]);
    expect(await claimBrowserInput(second.id, 'native-page', null)).toBeNull();
    resetInputForTests(); configureInputDelivery({ applyAutomation: automate, changed });
    expect((await pendingBrowserInputs()).map(row => row.id)).toEqual([first.id]);
    expect((await listInputs()).find(row => row.id === second.id)?.workflow?.dependsOn).toEqual([first.id]);
  });
  it('keeps Pause authoritative at the final native authorization boundary', async () => {
    const runId = randomUUID();
    const first = await enqueueInput(input({ sessionId: null, workflow: workflow(runId, 'first', 0) }));
    await enqueueInput(input({ sessionId: null, workflow: workflow(runId, 'second', 1, [first.id]) }));
    expect(await claimBrowserInput(first.id, 'native-page', null, true)).not.toBeNull();
    binding.automationPaused = true;
    expect(await authorizeBrowserInput(first.id, 'native-page', null)).toBe(false);
    expect((await listInputs()).find(row => row.id === first.id)?.sendAuthorizedAt).toBeUndefined();
  });
  it('releases a verified dependent and freezes the original prerequisite receipt into its native message', async () => {
    const runId = randomUUID(), replyId = randomUUID();
    const first = await enqueueInput(input({ sessionId: null, workflow: workflow(runId, 'first', 0) }));
    const next = await enqueueInput(input({ sessionId: null, workflow: workflow(runId, 'next', 1, [first.id]) }));
    const sent: InputEntry = { ...first, state: 'sent', conversationId: binding.conversationId,
      deliveredSessionId: sessionId, deliveredAt: now - 200, messageId: randomUUID(), owner: 'native-page',
      historyRecorded: true, historyProjectionVersion: 1, acceptedNativeFinal: { replyId, acceptedAt: now - 100 } };
    await writeDurableNow('session-input', [sent, next]); resetInputForTests();
    expect(await publishWorkflowReceipt(sent, { version: 1, replyId, checkedAt: now, status: 'verified',
      checks: [{ kind: 'acceptance', ok: true, detail: 'Original checklist verified.' }] })).toBe(true);
    expect((await pendingBrowserInputs()).map(row => row.id)).toEqual([next.id]);
    const claimed = await claimBrowserInput(next.id, 'next-native-page', null);
    expect(claimed?.deliveryText).toContain('Verified recipe prerequisites');
    expect(claimed?.deliveryText).toContain(replyId);
    expect(claimed?.preparedContext?.deliveredChars).toBe(claimed?.deliveryText?.length);
  });

  it('holds recipe Input at Core handout even when the current model can inject ordinary user text', async () => {
    const runId = randomUUID();
    await enqueueInput(input({ workflow: workflow(runId, 'first', 0, [randomUUID()]) }));
    expect(await hasEligibleToolInput(sessionId)).toBe(false);
    expect(await offerToolInput(sessionId, binding.conversationId, 'recipe-native-call', now)).toEqual([]);
  });
  it('commits verified completion separately from Send and retains failed-check history on explicit recheck', async () => {
    const runId = randomUUID(), replyId = randomUUID();
    const first: InputEntry = { ...input({ workflow: workflow(runId, 'first', 0) }), state: 'sent', owner: 'native-page',
      createdAt: now - 500, conversationId: binding.conversationId, deliveredAt: now - 300,
      messageId: randomUUID(), historyRecorded: true, historyProjectionVersion: 1,
      acceptedNativeFinal: { replyId, acceptedAt: now - 100 } };
    await writeDurableNow('session-input', [first]); resetInputForTests();
    const failed = { version: 1 as const, replyId, checkedAt: now, status: 'failed' as const,
      checks: [{ kind: 'acceptance' as const, ok: false, detail: 'Native verification required.' }] };
    expect(await publishWorkflowReceipt(first, failed)).toBe(true);
    const saved = (await listInputs())[0]!;
    expect(saved.state).toBe('sent'); expect(saved.workflowReceipt?.status).toBe('failed');
    expect(await recheckWorkflowInput(saved)).toBe(true);
    expect((await listInputs())[0]!.workflowValidationHistory).toEqual([failed]);
    expect((await listInputs())[0]!.workflowReceipt).toBeUndefined();
    expect(automate).not.toHaveBeenCalled();
  });
});


describe('model route pause custody', () => {
  const route = () => ({ sourceSessionId: 'source-session', targetConversationId: binding.conversationId });
  const switchState = () => {
    const state = { enabled: true };
    vi.spyOn(goalCustody, 'goalSwitchFor').mockImplementation(() => ({
      enabled: state.enabled, own: true, mode: 'goal', afterTurn: false
    }));
    return state;
  };

  it('refuses a model route to an Off target while preserving ordinary human Send', async () => {
    const state = switchState(); state.enabled = false;
    await expect(enqueueInput(input({ route: route() }))).rejects.toThrow('paused');
    expect(await listInputs()).toHaveLength(0);
    expect(await enqueueInput(input({ text: 'A real human may steer this Off chat.' }))).toMatchObject({ state: 'queued' });
  });

  it('retires only a pristine unsent model route after Off across cold restore, so it cannot block another chat', async () => {
    const state = switchState();
    const row = await enqueueInput(input({ route: route() }));
    state.enabled = false;
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'cancelled', owner: null, text: row.text, route: row.route
    });
    const next = await enqueueInput(input({ sessionId: 'session-two', text: 'Useful work in the other chat.' }));
    expect(await claimBrowserInput(next.id, 'other-page', 'conversation-b', true)).toMatchObject({ id: next.id });
  });

  it.each(['browser', 'tool'] as const)('withholds a routed %s handout when Off wins during awaited prompt preparation', async transport => {
    const state = switchState();
    const row = await enqueueInput(input({ route: route() }));
    configureInputDelivery({ applyAutomation: automate, changed, prepareText: async entry => {
      state.enabled = false; return entry.text;
    } });
    if (transport === 'browser') expect(await claimBrowserInput(row.id, 'route-page', binding.conversationId, true)).toBeNull();
    else expect(await offerToolInput(sessionId, binding.conversationId, 'exact-route-request', now)).toEqual([]);
    const retained = (await listInputs()).find(entry => entry.id === row.id)!;
    expect(retained.owner).toBeNull();
    expect(retained.offeredAt).toBeUndefined();
    expect(retained.sendAuthorizedAt).toBeUndefined();
    expect(retained.messageId).toBeUndefined();
  });

  it('withdraws only its own unsent native authorization when Off wins at the durable publication boundary', async () => {
    const state = switchState();
    const row = await enqueueInput(input({ route: route() }));
    expect(await claimBrowserInput(row.id, 'route-page', binding.conversationId, true)).not.toBeNull();
    configureInputDelivery({ applyAutomation: automate, changed: () => { state.enabled = false; } });
    expect(await authorizeBrowserInput(row.id, 'route-page', binding.conversationId)).toBe(false);
    const retained = (await listInputs()).find(entry => entry.id === row.id)!;
    expect(retained).toMatchObject({ state: 'browser', owner: 'route-page', route: row.route });
    expect(retained.sendAuthorizedAt).toBeUndefined();
    expect(retained.messageId).toBeUndefined();
  });

  it('never retires an authorized ambiguous model route merely because its target went Off', async () => {
    const state = switchState();
    const row = await enqueueInput(input({ route: route() }));
    await claimBrowserInput(row.id, 'route-page', binding.conversationId, true);
    expect(await authorizeBrowserInput(row.id, 'route-page', binding.conversationId)).toBe(true);
    state.enabled = false;
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'browser', owner: 'route-page', sendAuthorizedAt: now, route: row.route
    });
  });

  it('does not retarget a never-offered model route across a provider conversation replacement', async () => {
    switchState();
    const row = await enqueueInput(input({ route: route() }));
    binding.conversationId = 'replacement-chat';
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'cancelled', owner: null, conversationId: 'conversation-a', route: row.route
    });
    expect(await claimBrowserInput(row.id, 'replacement-page', binding.conversationId, true)).toBeNull();
  });

  it('restores the exact prior tool queue when Off wins while its never-returned handout is committed', async () => {
    const state = switchState();
    const row = await enqueueInput(input({ route: route() }));
    configureInputDelivery({ applyAutomation: automate, changed: () => { state.enabled = false; } });
    expect(await offerToolInput(sessionId, binding.conversationId, 'withheld-route-request', now)).toEqual([]);
    const retained = (await listInputs()).find(entry => entry.id === row.id)!;
    expect(retained.owner).toBeNull();
    expect(retained.offeredAt).toBeUndefined();
    expect(retained.sendAuthorizedAt).toBeUndefined();
    expect(retained.route).toEqual(row.route);
  });
});

describe('session-scoped private helper custody readback', () => {
  it('keeps a cancelled native-delivered helper and its original answer uncertainty visible after cold restore without exposing planner text', async () => {
    const at = Date.now();
    const helperId = randomUUID();
    const source = { ...input({ id: helperId, sessionId: null, text: 'PRIVATE planning prompt' }),
      purpose: 'decision' as const, lifetime: 'temporary-planner' as const, decisionSourceSessionId: sessionId,
      decisionSourceTurnId: 'goal-source-1', state: 'cancelled' as const, owner: 'exact-page',
      requiresAuthorization: true, createdAt: at - 1000, sendAuthorizedAt: at - 800,
      deliveredAt: at - 500, messageId: 'native-helper-message', conversationId: 'helper-provider-route',
      error: 'PRIVATE source failure', response: 'PRIVATE helper answer' };
    const outgoing = { ...input({ id: randomUUID(), sessionId, text: 'PRIVATE Goal reply' }),
      purpose: 'user' as const, state: 'queued' as const, owner: null, createdAt: at,
      conversationId: 'conversation-a', sourceHelperId: helperId, sourceHelperAcceptedAt: at - 600 };
    const foreign = { ...source, id: randomUUID(), decisionSourceSessionId: 'session-two',
      decisionSourceTurnId: 'foreign-source', text: 'FOREIGN SECRET' };
    await writeDurableNow('session-input', [source, outgoing, foreign]);
    resetInputForTests();
    const first = await sessionDecisionHelperCustody(sessionId, 'conversation-a');
    expect(first).toMatchObject({ sessionId, conversationId: 'conversation-a',
      retainedTotal: 1, pendingOriginalReply: null, helpers: [{ id: helperId, sourceTurnId: 'goal-source-1',
        state: 'cancelled', nativeSend: 'confirmed', answer: 'not-recorded', phase: 'cancelled-after-native-delivery',
        nativeMessageId: 'native-helper-message', continuation: { id: outgoing.id, state: 'queued', nativeSend: 'not-confirmed' } }] });
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|FOREIGN|helper-provider-route|exact-page|response|deliveryText|source failure/i);
    resetInputForTests();
    expect(await sessionDecisionHelperCustody(sessionId, 'conversation-a')).toEqual(first);
    expect(await sessionDecisionHelperCustody(sessionId, 'conversation-b')).toBeNull();

    const previous = goalCustody.snapshotGoalReplies();
    try {
      goalCustody.restoreGoalReplies({ version: 1, savedAt: at, replies: [{ conversationId: 'conversation-a',
        sessionId, replyId: 'actual-final-message', turnId: 'goal-source-1', eventSeq: 12,
        acceptedAt: at - 750, state: 'pending' }] });
      const pending = await sessionDecisionHelperCustody(sessionId, 'conversation-a');
      expect(pending?.pendingOriginalReply).toEqual({ replyId: 'actual-final-message',
        sourceTurnId: 'goal-source-1', acceptedAt: at - 750 });
      expect(pending?.helpers[0]?.answer).toBe('not-recorded');
    } finally {
      goalCustody.restoreGoalReplies(previous);
    }
  });

  it('distinguishes pre-Send cancellation, ambiguous Send, accepted answer and delivered continuation', async () => {
    const at = Date.now();
    const make = (state: InputEntry['state'], overrides: Partial<InputEntry> = {}): InputEntry => ({
      ...input({ id: randomUUID(), sessionId: null, text: 'SECRET helper' }),
      purpose: 'decision', lifetime: 'temporary-planner', decisionSourceSessionId: sessionId,
      decisionSourceTurnId: 'turn-1', state, owner: null, createdAt: at, conversationId: null, ...overrides
    });
    const unsent = make('cancelled', { requiresAuthorization: true });
    const failedBeforeSend = make('failed', { owner: 'browser-owner', requiresAuthorization: true });
    const ambiguous = make('browser', { owner: 'browser-owner', requiresAuthorization: true, sendAuthorizedAt: at });
    const accepted = make('sent', { owner: 'browser-owner', requiresAuthorization: true, createdAt: at - 400,
      sendAuthorizedAt: at - 300, deliveredAt: at - 200, messageId: 'native-confirmed' });
    const continuation: InputEntry = { ...input({ id: randomUUID(), text: 'SECRET continuation' }),
      state: 'sent', owner: 'source-browser', createdAt: at + 1, conversationId: 'conversation-a',
      sourceHelperId: accepted.id, sourceHelperAcceptedAt: at - 100, deliveredAt: at + 2,
      messageId: 'native-continuation' };
    await writeDurableNow('session-input', [unsent, failedBeforeSend, ambiguous, accepted, continuation]);
    resetInputForTests();
    const snapshot = await sessionDecisionHelperCustody(sessionId, 'conversation-a');
    const byId = new Map(snapshot!.helpers.map(row => [row.id, row]));
    expect(byId.get(unsent.id)).toMatchObject({ phase: 'cancelled-before-native-send', nativeSend: 'not-confirmed', answer: 'not-recorded' });
    expect(byId.get(failedBeforeSend.id)).toMatchObject({ phase: 'failed-before-native-send', nativeSend: 'not-confirmed', answer: 'not-recorded' });
    // The existing recovery owner can cancel an old claimed row at load; its
    // Send authorization still prevents a false confirmed-unsent classification.
    expect(byId.get(ambiguous.id)).toMatchObject({ phase: 'unresolved-cancellation', nativeSend: 'unresolved', answer: 'not-recorded' });
    expect(byId.get(accepted.id)).toMatchObject({ phase: 'answer-accepted', nativeSend: 'confirmed', answer: 'accepted',
      continuation: { id: continuation.id, nativeSend: 'confirmed', state: 'sent', nativeMessageId: 'native-continuation' } });
    expect(snapshot?.retainedTotal).toBe(4);
    expect(JSON.stringify(snapshot)).not.toContain('SECRET');
  });
});

describe('continuation lifecycle custody diagnostics', () => {
  it.each([false, true])('requires the current native receipt to resolve a historical ambiguous helper phase (receipt=%s)', receipt => {
    const row: InputEntry = { ...input(), conversationId: null, purpose: 'decision', state: 'decision',
      owner: 'exact-helper-page', createdAt: 1, sendAuthorizedAt: 2,
      recoveryFailure: { phase: 'native_send_ambiguous', retrySafe: false, detail: 'Unconfirmed Send' },
      ...(receipt ? { deliveredAt: 3, messageId: 'native-helper-question' } : {}) };
    expect(recoveryContinuationEligibility(row)).toMatchObject({ allowed: receipt,
      reason: receipt ? 'confirmed_receipt' : 'ambiguous_send' });
    if (receipt) expect(recoveryContinuationEligibility({ ...row, owner: null }).allowed).toBe(false);
  });

  it('separates admitted, claimed, unresolved, and completed continuation ownership evidence', () => {
    const base: InputEntry = {
      ...input(), state: 'queued', owner: null, createdAt: 1, conversationId: 'conversation-a', recoveryChainId: 'chain-a', continuationId: randomUUID()
    };
    expect(continuationLifecycleDiagnostics(base)).toMatchObject({
      continuationState: 'admitted_waiting_claim', ownerProven: false, continuationId: base.continuationId
    });
    expect(continuationLifecycleDiagnostics({ ...base, state: 'browser', owner: 'page-a' })).toMatchObject({
      continuationState: 'claimed_waiting_native_proof', ownerProven: true
    });
    expect(continuationLifecycleDiagnostics({ ...base, state: 'browser', owner: 'page-a', sendAuthorizedAt: 2 })).toMatchObject({
      continuationState: 'native_send_unresolved', receiptState: 'ambiguous'
    });
    expect(continuationLifecycleDiagnostics({ ...base, state: 'sent', owner: 'page-a', messageId: 'message-a', deliveredAt: 3 })).toMatchObject({
      continuationState: 'completed_with_receipt', receiptState: 'confirmed'
    });
  });
});
/** Previously persisted queues remain readable even though new direct admission is one at a time. */
async function seedLegacyInput(args: InputArgs): Promise<InputEntry> {
  const row: InputEntry = { ...args, state: 'queued', owner: null, createdAt: now, conversationId: args.sessionId ? binding.conversationId : null };
  await writeDurableNow('session-input', [...await listInputs(), row]);
  resetInputForTests();
  return row;
}
it('reports a retained generated continuation hold once without exposing text or changing delivery custody', async () => {
  const switches = goalCustody.snapshotGoalSwitches();
  try {
    goalCustody.restoreGoalSwitches({ version: 1, savedAt: now, switches: [{ conversationId: binding.conversationId,
      enabled: true, mode: 'loop', at: now }] });
    configureInputDelivery({ applyAutomation: automate, changed, activity: () => ({ possible: true, exact: false }) });
    const base = await seedLegacyInput(input({ text: 'PRIVATE retained continuation', mode: 'after-turn' }));
    const row: InputEntry = { ...base, sourceHelperId: randomUUID(), sourceHelperAcceptedAt: now - 1 };
    await writeDurableNow('session-input', [row]); resetInputForTests();
    const before = await listInputs();
    await pendingBrowserInputs(); await pendingBrowserInputs();
    const notes = getLog().filter(entry => entry.message.includes(`input ${row.id}: continuation held`));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain('browser_policy active=false possible=true exact=false executing=false terminal=true');
    expect(notes[0]!.message).not.toContain('PRIVATE');
    expect(await listInputs()).toEqual(before);
    expect(automate).not.toHaveBeenCalled();
  } finally { goalCustody.restoreGoalSwitches(switches); }
});

it('coalesces the same precise continuation refusal across repeated outer source-boundary reports', async () => {
  const base = await seedLegacyInput(input({ text: 'PRIVATE retained continuation', mode: 'after-turn' }));
  const row: InputEntry = { ...base, sourceHelperId: randomUUID(), sourceHelperAcceptedAt: now - 1 };
  const before = await listInputs();
  for (let pass = 0; pass < 8; pass++) {
    noteInputContinuationHold(row, 'source_revision_changed');
    noteInputContinuationHold(row, 'source_boundary');
  }
  noteInputContinuationHold(row, 'input_custody');
  noteInputContinuationHold(row, 'source_boundary');
  noteInputContinuationHold(row, 'source_revision_changed');
  noteInputContinuationHold(row, 'source_boundary');
  const notes = getLog().filter(entry => entry.message.includes(`input ${row.id}: continuation held`));
  expect(notes.map(entry => entry.message.match(/continuation held ([^;]+)/)?.[1]))
    .toEqual(['source_revision_changed', 'source_boundary', 'input_custody', 'source_revision_changed']);
  expect(notes.every(entry => !entry.message.includes('PRIVATE'))).toBe(true);
  expect(await listInputs()).toEqual(before);
  expect(automate).not.toHaveBeenCalled();
});

beforeEach(async () => {
  vi.mocked(noteChatOrigin).mockClear();
  resetInputForTests();
  automate.mockReset();
  changed.mockReset();
  configureInputDelivery({ applyAutomation: automate, changed });
  resetDurableForTests();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-input-'));
  vi.spyOn(os, 'tmpdir').mockReturnValue(directory);
  initDurableStore(directory);
  binding.conversationId = 'conversation-a';
  binding.blocked = false;
  binding.origin = 'desktop';
  binding.recorded = true;
  binding.activeTurnId = null;
  binding.lastToolCallAt = null;
  binding.automationPaused = false;
  binding.finishEnabled = true; binding.finishReleased = false; binding.model = 'gpt-6-astra'; binding.leadMinutes = 5; binding.impulseMinutes = 0;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'previous-turn', time: 0 };
  vi.mocked(readRecentEvents).mockReset().mockImplementation(async () => binding.end ? [binding.end as never] : []);
  vi.mocked(conversationWasSuperseded).mockReset().mockResolvedValue(false);
  now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetInputForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('completed local observer boundary with a later native final', () => {
  const fixture = () => {
    const user: any = { kind: 'user_message', messageId: 'exact-user', seq: 10, origin: 10 };
    const start: any = { kind: 'turn_start', turnId: 'observer-only', seq: 11 };
    const end: any = { kind: 'turn_end', turnId: 'observer-only', outcome: 'completed', seq: 12 };
    const final: any = { kind: 'assistant_message', messageId: 'native-final', seq: 20, finalContentSeq: 20 };
    return { user, start, end, final, events: [user, start, end, final] };
  };
  it('recognizes only the exact ended observer without certifying tool completion', () => {
    const f = fixture();
    expect(ordinaryInputWatchdogBoundary(f.events, f.user, f.final)).toEqual({ start: f.start, end: f.end, warning: undefined });
    expect(f.end.outcome).toBe('completed');
    expect(f.final).not.toHaveProperty('goalEligible');
  });
  it.each(['stopped', 'failed', 'stalled', 'mismatched-owner', 'later-end', 'owned-final', 'extra-generation', 'handoff', 'chat-error', 'foreign-question'])(
    'refuses a completed-observer association for %s', shape => {
      const f = fixture();
      if (['stopped', 'failed', 'stalled'].includes(shape)) f.end.outcome = shape;
      if (shape === 'mismatched-owner') f.end.turnId = 'foreign-observer';
      if (shape === 'later-end') f.end.seq = 21;
      if (shape === 'owned-final') f.final.turnId = 'another-turn';
      if (shape === 'extra-generation') f.events.push({ kind: 'turn_start', turnId: 'newer-turn', seq: 15 } as any);
      if (shape === 'handoff') f.events.push({ kind: 'handoff', seq: 15 } as any);
      if (shape === 'chat-error') f.events.push({ kind: 'chat_error', reason: 'unknown', seq: 15 } as any);
      if (shape === 'foreign-question') f.final.inputReplyTo = 'different-user';
      expect(ordinaryInputWatchdogBoundary(f.events, f.user, f.final)).toBeNull();
    });
});

describe('settled-turn Input boundary revalidation', () => {
  it.each(['live', 'clock-rollback', 'clock-before-ACK', 'unsent', 'foreign-source', 'stale-source', 'Off', 'cancelled', 'cold', 'collected'] as const)(
    'projects only original live delivered helper custody for %s', async state => {
      const replies = goalCustody.snapshotGoalReplies(), switches = goalCustody.snapshotGoalSwitches();
      const controller = new AbortController();
      const pending = requestBrowserDecision('Original bounded private request', controller.signal, {
        sourceSessionId: sessionId, sourceTurnId: 'current-source', lifetime: 'temporary-planner',
        onAccepted: () => null
      });
      const outcome = pending.catch(() => undefined);
      try {
        goalCustody.restoreGoalSwitches({ version: 1, savedAt: now, switches: [{ conversationId: binding.conversationId,
          enabled: state !== 'Off', mode: 'loop', at: now }] });
        goalCustody.restoreGoalReplies({ version: 1, savedAt: now, replies: [{ conversationId: binding.conversationId,
          sessionId: state === 'foreign-source' ? 'session-two' : sessionId,
          turnId: state === 'stale-source' ? 'newer-source' : 'current-source', replyId: 'current-final',
          eventSeq: 12, acceptedAt: now - 1, state: 'pending' }] });
        const row = (await listInputs()).find(entry => entry.purpose === 'decision')!;
        await claimBrowserInput(row.id, 'original-live-owner', null, true);
        if (state !== 'unsent') {
          await authorizeBrowserInput(row.id, 'original-live-owner', null);
          if (state === 'clock-before-ACK') now -= 1;
          expect(await acknowledgeBrowserInput(row.id, 'original-live-owner', null, 'exact-native-user')).toBe(true);
          if (state === 'clock-before-ACK') {
            const retained = (await listInputs()).find(entry => entry.id === row.id)!;
            expect(retained.deliveredAt).toBeLessThan(retained.sendAuthorizedAt!);
            expect(liveDeliveredBrowserDecision(retained)).toBe(false);
          }
        }
        if (state === 'cancelled') { controller.abort(); await outcome; }
        if (state === 'collected') {
          expect(await completeBrowserDecision(row.id, 'original-live-owner', '{"action":"continue","reply":"Retained work"}', null)).toBe(true);
          await outcome;
        }
        if (state === 'cold') resetInputForTests();
        if (state === 'clock-rollback') now -= 1;
        expect(await activeBrowserDecisionWork(await listInputs())).toEqual({ collecting: ['live', 'clock-rollback', 'clock-before-ACK'].includes(state) ? 1 : 0, accepting: 0 });
      } finally {
        controller.abort(); await outcome;
        goalCustody.restoreGoalReplies(replies); goalCustody.restoreGoalSwitches(switches);
      }
    });

  it('defers a queued row without taking ownership when the shared readiness hook refuses', async () => {
    const row = await enqueueInput(input());
    const readiness = vi.fn(async () => false as const);
    configureInputDelivery({ applyAutomation: automate, changed, settledTurnForwardReadiness: readiness });
    expect(await claimBrowserInput(row.id, 'settled-page', binding.conversationId, true)).toBeNull();
    expect(readiness).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }), expect.arrayContaining([expect.objectContaining({ id: row.id })]));
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'queued', owner: null });
    expect(automate).not.toHaveBeenCalled();
  });

  it('rechecks the same proof after async message preparation instead of handing out stale text', async () => {
    const row = await enqueueInput(input());
    let ready = true;
    configureInputDelivery({ applyAutomation: automate, changed,
      settledTurnForwardReadiness: async () => () => ready,
      prepareText: entry => { ready = false; return entry.text; } });
    expect(await claimBrowserInput(row.id, 'settled-page', binding.conversationId, true)).toBeNull();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'queued', owner: null });
  });

  it('retains its claim but retracts an unreturned Send authorization when physical work arrives during the durable write', async () => {
    const row = await enqueueInput(input());
    let ready = true;
    configureInputDelivery({ applyAutomation: automate, changed, settledTurnForwardReadiness: async () => () => ready });
    expect(await claimBrowserInput(row.id, 'settled-page', binding.conversationId, true)).toMatchObject({ id: row.id, requiresAuthorization: true });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => { ready = false; await rename(from, to); });
    expect(await authorizeBrowserInput(row.id, 'settled-page', binding.conversationId)).toBe(false);
    const retained = (await listInputs()).find(entry => entry.id === row.id)!;
    expect(retained).toMatchObject({ state: 'browser', owner: 'settled-page' });
    expect(retained.sendAuthorizedAt).toBeUndefined();
    expect(retained.messageId).toBeUndefined();
    expect(retained.deliveredAt).toBeUndefined();
  });

  it('keeps an already delivered helper answer unaccepted when its exact forward proof is revoked', async () => {
    let ready = true;
    const accepted = vi.fn(() => { ready = false; return null; });
    configureInputDelivery({ applyAutomation: automate, changed, settledTurnForwardReadiness: async () => () => ready });
    const controller = new AbortController();
    const decision = requestBrowserDecision('Keep the existing helper custody', controller.signal,
      { lifetime: 'temporary-planner', onAccepted: accepted });
    const [row] = await listInputs();
    expect(await claimBrowserInput(row!.id, 'settled-helper', null, true)).not.toBeNull();
    expect(await authorizeBrowserInput(row!.id, 'settled-helper', null)).toBe(true);
    expect(await acknowledgeBrowserInput(row!.id, 'settled-helper', null, 'native-delivered-helper')).toBe(true);
    expect(await completeBrowserDecision(row!.id, 'settled-helper', 'Exact native answer', null)).toBe(false);
    expect((await listInputs()).find(entry => entry.id === row!.id)).toMatchObject({ state: 'decision', owner: 'settled-helper',
      messageId: 'native-delivered-helper' });
    expect((await listInputs()).some(entry => entry.sourceHelperId === row!.id)).toBe(false);
    const cancellation = expect(decision).rejects.toThrow('goal_browser_cancelled');
    controller.abort(); await cancellation;
  });

  it('preserves the incumbent unrelated/strict path when the hook returns null', async () => {
    const row = await enqueueInput(input());
    configureInputDelivery({ applyAutomation: automate, changed, settledTurnForwardReadiness: async () => null });
    expect(await claimBrowserInput(row.id, 'strict-page', binding.conversationId, true)).toMatchObject({ id: row.id });
    expect(await authorizeBrowserInput(row.id, 'strict-page', binding.conversationId)).toBe(true);
  });
});

describe('Goal activation input lease', () => {
  it.each(['released', 'rejected', 'reset'] as const)('queues a detached child after its exact serial owner is %s', async state => {
    let detach!: () => void, block!: () => void, entered!: () => void;
    const detachGate = new Promise<void>(resolve => { detach = resolve; });
    const blockerGate = new Promise<void>(resolve => { block = resolve; });
    const blockerEntered = new Promise<void>(resolve => { entered = resolve; });
    let detached!: Promise<boolean>, childEntered = false;
    const first = withGoalReplyActivationInput(binding.conversationId, async () => {
      detached = (async () => {
        await detachGate;
        return withGoalReplyActivationInput(binding.conversationId, async () => { childEntered = true; return true; });
      })();
      if (state === 'reset') resetInputForTests();
      if (state === 'rejected') throw new Error('Rejected activation owner');
      return true;
    });
    if (state === 'rejected') await expect(first).rejects.toThrow('Rejected activation owner');
    else expect(await first).toBe(true);
    const blocker = withGoalReplyActivationInput(binding.conversationId, async () => {
      entered(); await blockerGate; return false;
    });
    await blockerEntered;
    detach();
    expect(await Promise.race([detached.then(() => 'entered'), new Promise<string>(resolve => setTimeout(() => resolve('queued'), 25))])).toBe('queued');
    expect(childEntered).toBe(false);
    block();
    expect(await blocker).toBe(false);
    expect(await detached).toBe(true);
    expect(childEntered).toBe(true);
  });
});

describe('ordinary native terminal helper source custody', () => {
  const userId = 'aa120101-1111-4111-8111-000000000101';
  const finalId = 'aa120102-1111-4111-8111-000000000102';
  async function retained(resumed = false) {
    binding.model = 'gpt-6-thinking';
    const sourceId = randomUUID(), helperId = randomUUID(), outgoingId = randomUUID();
    const turnId = `reply:${finalId}`;
    const acceptedAt = now;
    const user = { kind: 'user_message', source: 'app', seq: 2, origin: 2, time: now - 100,
      messageId: userId, inputId: sourceId, inputDelivery: 'confirmed', message: { text: 'Exact objective.', chars: 16, truncated: false } };
    const final = { kind: 'assistant_message', source: 'extension', seq: 3, origin: 3, finalContentSeq: 3, time: now,
      messageId: finalId, providerMessageId: finalId, inputReplyTo: userId, goalEligible: true,
      state: 'final', final: true, message: { text: 'Exact result.', chars: 13, truncated: false } };
    const events: Record<string, unknown>[] = [user, final];
    vi.mocked(readRecentEvents).mockImplementation(async () => events as never);
    vi.spyOn(goalCustody, 'goalArmedFor').mockReturnValue(true);
    const pending = { sessionId, replyId: finalId, turnId, eventSeq: 3, acceptedAt };
    vi.spyOn(goalCustody, 'goalPendingReplyFor').mockReturnValue(pending);
    const policy = { conversationId: binding.conversationId, enabled: true, mode: 'loop' as const, at: now - 200 };
    const switches = vi.spyOn(goalCustody, 'snapshotGoalSwitches')
      .mockReturnValue({ version: 1, savedAt: now, switches: [policy] });
    const rows: InputEntry[] = [
      { ...input({ id: sourceId }), conversationId: binding.conversationId, createdAt: now - 200, state: 'sent',
        owner: 'native-source-owner', messageId: userId, deliveredAt: now - 100, historyRecorded: true, historyProjectionVersion: 1 },
      { ...input({ id: helperId, sessionId: null }), conversationId: null, createdAt: now, state: 'sent', purpose: 'decision',
        lifetime: 'temporary-planner', owner: 'native-helper-owner', messageId: 'native-helper-question', deliveredAt: now,
        decisionSourceSessionId: sessionId, decisionSourceTurnId: turnId },
      { ...input({ id: outgoingId, mode: 'after-turn' }), conversationId: binding.conversationId, createdAt: now + 1, state: 'queued',
        owner: null, sourceHelperId: helperId, sourceHelperAcceptedAt: acceptedAt }
    ];
    if (resumed) {
      delete (user as Partial<typeof user>).inputId;
      delete (user as Partial<typeof user>).inputDelivery;
      rows.splice(0, 1);
      vi.spyOn(resumeCustody, 'committedResumeNativeReceipt').mockImplementation(async (source, conversation, message) =>
        source === sessionId && conversation === binding.conversationId && message === userId
          ? { token: 'exact-retained-resume-token', openedAt: now - 150, handoffId: 'exact-current-resume', sourceClosed: true } : null);
    }
    await writeDurableNow('session-input', rows);
    resetInputForTests();
    now += 100;
    return { user, final, events, pending, policy, switches, rows, outgoingId, sourceId, helperId };
  }

  it('reuses the exact receipt-backed alias after restart for claim and authorization without a turn_end', async () => {
    const { outgoingId } = await retained();
    expect(await claimBrowserInput(outgoingId, 'source-page', binding.conversationId, true))
      .toMatchObject({ id: outgoingId, completedTurnId: `reply:${finalId}` });
    resetInputForTests();
    expect(await authorizeBrowserInput(outgoingId, 'source-page', binding.conversationId)).toBe(true);
    expect((await listInputs()).filter(row => row.sourceHelperId)).toHaveLength(1);
  });

  it.each(['exact', 'missing-current-resume', 'newer-question', 'pause', 'provider-block', 'live-tool'] as const)(
    're-proves retained Resume custody at outgoing claim and irreversible authorization (%s)', async state => {
      const { outgoingId, user, events } = await retained(true);
      if (state === 'missing-current-resume') vi.mocked(resumeCustody.committedResumeNativeReceipt).mockResolvedValue(null);
      if (state === 'newer-question') events.push({ ...user, seq: 4, origin: 4, messageId: 'later-human-question' });
      if (state === 'pause') binding.automationPaused = true;
      if (state === 'provider-block') binding.blocked = true;
      if (state === 'live-tool') configureInputDelivery({ applyAutomation: automate, changed, callsHoldRecovery: () => true });
      const claimed = await claimBrowserInput(outgoingId, 'resume-source-page', binding.conversationId, true);
      if (state !== 'exact') expect(claimed).toBeNull();
      else {
        expect(claimed).toMatchObject({ completedTurnId: `reply:${finalId}` });
        resetInputForTests();
        expect(await authorizeBrowserInput(outgoingId, 'resume-source-page', binding.conversationId)).toBe(true);
      }
    }
  );

  it.each(['exact', 'offered', 'authorized', 'delivered', 'other-error', 'no-grant'] as const)(
    'retains a scope-preparation failure for one explicit same-input Loop retry: %s', async state => {
      const { rows, outgoingId, pending } = await retained();
      const outgoing = rows.find(row => row.id === outgoingId)!;
      Object.assign(outgoing, { state: 'failed', error:
        'Native Input human authorship is unverified; reconcile the exact original outbox/native ACK before task-version authorization.' });
      if (state === 'offered') outgoing.offeredAt = now;
      if (state === 'authorized') outgoing.sendAuthorizedAt = now;
      if (state === 'delivered') outgoing.deliveredAt = now;
      if (state === 'other-error') outgoing.error = 'An unrelated failure is not a preparation receipt.';
      await writeDurableNow('session-input', rows); resetInputForTests();
      const source = { sessionId, conversationId: binding.conversationId,
        sourceTurnId: pending.turnId, sourceAcceptedAt: pending.acceptedAt };
      const eligible = state === 'exact' || state === 'no-grant';
      expect(await retainedSourceHelperContinuationFor(source)).toEqual(eligible
        ? { inputId: outgoingId, sourceAcceptedAt: outgoing.sourceHelperAcceptedAt } : null);
      const grant = vi.fn(async () => true);
      expect(await retainSourceHelperContinuation({ ...source, current: () => true,
        ...(state === 'no-grant' ? {} : { authorizeRetry: grant }) }))
        .toBe(state === 'exact' ? 'held' : 'attention');
      expect(grant).toHaveBeenCalledTimes(state === 'exact' ? 1 : 0);
      expect((await listInputs()).find(row => row.id === outgoingId))
        .toMatchObject({ state: state === 'exact' ? 'queued' : 'failed', text: outgoing.text });
      expect((await listInputs()).filter(row => row.sourceHelperId)).toHaveLength(1);
    });

  it.each(['exact', 'new-human-after-grant', 'changed-policy-after-grant', 'changed-debt-after-grant',
    'live-tool-after-grant', 'revoked-after-grant', 'no-grant'] as const)(
    'rearms the same ordinary terminal continuation only under current explicit custody: %s', async state => {
      const { user, events, pending, policy, switches, rows, outgoingId } = await retained();
      const outgoing = rows.find(row => row.id === outgoingId)!;
      Object.assign(outgoing, { state: 'failed', requiresAuthorization: true, preSendReoffers: 3 });
      await writeDurableNow('session-input', rows);
      resetInputForTests();
      const previousAcceptedAt = outgoing.sourceHelperAcceptedAt!;
      pending.acceptedAt = now;
      expect(await retainedSourceHelperContinuationFor({ sessionId, conversationId: binding.conversationId,
        sourceTurnId: pending.turnId, sourceAcceptedAt: pending.acceptedAt }))
        .toEqual({ inputId: outgoingId, sourceAcceptedAt: previousAcceptedAt });
      expect(await rebindRetainedSourceHelperContinuation({ inputId: outgoingId, sessionId,
        conversationId: binding.conversationId, sourceTurnId: pending.turnId, previousAcceptedAt,
        sourceAcceptedAt: pending.acceptedAt })).toBe(true);
      let authority = true, tools = false;
      configureInputDelivery({ applyAutomation: automate, changed, callsHoldRecovery: () => tools });
      const grant = vi.fn(async () => {
        if (state === 'new-human-after-grant') events.push({ ...user, seq: 4, origin: 4, messageId: 'newer-native-question' });
        if (state === 'changed-policy-after-grant') switches.mockReturnValue({ version: 1, savedAt: now,
          switches: [{ ...policy, at: now + 1 }] });
        if (state === 'changed-debt-after-grant') pending.acceptedAt++;
        if (state === 'live-tool-after-grant') tools = true;
        if (state === 'revoked-after-grant') authority = false;
        return true;
      });
      const options = { sessionId, conversationId: binding.conversationId, sourceTurnId: pending.turnId,
        sourceAcceptedAt: pending.acceptedAt, current: () => authority,
        ...(state === 'no-grant' ? {} : { authorizeRetry: grant }) };
      expect(await retainSourceHelperContinuation(options)).toBe(state === 'exact' ? 'held' : 'attention');
      expect(grant).toHaveBeenCalledTimes(state === 'no-grant' ? 0 : 1);
      expect((await listInputs()).find(row => row.id === outgoingId))
        .toMatchObject({ state: state === 'exact' ? 'queued' : 'failed', sourceHelperId: outgoing.sourceHelperId });
      if (state === 'exact') {
        expect(await retainSourceHelperContinuation(options)).toBe('held');
        expect(grant).toHaveBeenCalledTimes(1);
        resetInputForTests();
        expect(await claimBrowserInput(outgoingId, 'rearmed-source-page', binding.conversationId, true))
          .toMatchObject({ id: outgoingId, completedTurnId: pending.turnId });
        expect(await authorizeBrowserInput(outgoingId, 'rearmed-source-page', binding.conversationId)).toBe(true);
      }
      expect((await listInputs()).filter(row => row.purpose === 'decision')).toHaveLength(1);
      expect((await listInputs()).filter(row => row.sourceHelperId)).toHaveLength(1);
    });

  it.each(['untouched', 'offered', 'owner', 'authorized', 'delivered', 'message', 'failed-old', 'helper-not-sent',
    'new-question', 'off', 'active-turn', 'other-input', 'future-source', 'retried-queued', 'withdrawn-queued',
    'rearmed-queued', 'authorization-required', 'authorization-released', 'recent-retried', 'recent-withdrawn', 'recent-rearmed'] as const)(
    'rebinds an old queued helper continuation only under exact unoffered custody: %s', async state => {
    const { rows, outgoingId, pending, helperId, events, user } = await retained();
    const outgoing = rows.find(row => row.id === outgoingId)!;
    const previousAcceptedAt = outgoing.sourceHelperAcceptedAt!;
    now += (state.startsWith('recent-') ? 1 : 13) * 60 * 60_000;
    pending.acceptedAt = now;
    if (state === 'offered') outgoing.offeredAt = now - 100;
    if (state === 'owner') outgoing.owner = 'old-possible-page';
    if (state === 'authorized') outgoing.sendAuthorizedAt = now - 100;
    if (state === 'delivered') outgoing.deliveredAt = now - 100;
    if (state === 'message') outgoing.messageId = 'old-native-message';
    if (state === 'failed-old') Object.assign(outgoing, { state: 'failed', requiresAuthorization: true, preSendReoffers: 3 });
    if (state === 'helper-not-sent') rows.find(row => row.id === helperId)!.state = 'cancelled';
    if (state === 'new-question') events.push({ ...user, seq: 4, origin: 4, messageId: 'newer-human-question' });
    if (state === 'off') vi.spyOn(goalCustody, 'goalArmedFor').mockReturnValue(false);
    if (state === 'active-turn') binding.activeTurnId = 'new-active-turn';
    if (state === 'other-input') rows.push({ ...outgoing, id: randomUUID(), sourceHelperId: undefined,
      sourceHelperAcceptedAt: undefined, text: 'A newer human instruction.' });
    if (state === 'future-source') outgoing.sourceHelperAcceptedAt = now + 1000;
    if (state === 'retried-queued' || state === 'recent-retried') outgoing.preSendReoffers = 1;
    if (state === 'withdrawn-queued' || state === 'recent-withdrawn') Object.assign(outgoing,
      { recoveryWithdrawAttempts: 1, recoveryWithdrawnSince: previousAcceptedAt + 1 });
    if (state === 'rearmed-queued' || state === 'recent-rearmed') outgoing.preSendReoffers = 0;
    if (state === 'authorization-required') outgoing.requiresAuthorization = true;
    if (state === 'authorization-released') outgoing.requiresAuthorization = false;
    const allowed = state === 'untouched' || state.startsWith('recent-');
    await writeDurableNow('session-input', rows); resetInputForTests();
    const options = { inputId: outgoingId, sessionId, conversationId: binding.conversationId,
      sourceTurnId: pending.turnId, previousAcceptedAt, sourceAcceptedAt: pending.acceptedAt };
    expect(await retainedSourceHelperContinuationFor(options)).toEqual(allowed
      ? { inputId: outgoingId, sourceAcceptedAt: previousAcceptedAt } : null);
    expect(await rebindRetainedSourceHelperContinuation(options)).toBe(allowed);
    const saved = (await listInputs()).find(row => row.id === outgoingId)!;
    expect(saved).toMatchObject({ id: outgoingId, sourceHelperId: helperId, text: outgoing.text,
      sourceHelperAcceptedAt: allowed ? pending.acceptedAt : outgoing.sourceHelperAcceptedAt });
    if (allowed) {
      expect(await rebindRetainedSourceHelperContinuation(options)).toBe(true);
      expect((await listInputs()).filter(row => row.sourceHelperId)).toHaveLength(1);
      expect(await claimBrowserInput(outgoingId, 'exact-resumed-source', binding.conversationId, true)).not.toBeNull();
    }
  });

  it.each([false, true])('retains exact custody beyond 12 hours, but refuses a newer question (superseded=%s)', async superseded => {
    const { user, events, policy, switches, rows, sourceId, outgoingId } = await retained();
    const oldSend = now - 13 * 60 * 60_000;
    user.time = oldSend;
    Object.assign(rows.find(row => row.id === sourceId)!, { createdAt: oldSend - 1, deliveredAt: oldSend });
    switches.mockReturnValue({ version: 1, savedAt: now, switches: [{ ...policy, at: oldSend - 1 }] });
    if (superseded) events.push({ ...user, seq: 4, origin: 4, messageId: 'newer-native-question' });
    await writeDurableNow('session-input', rows);
    resetInputForTests();
    const claimed = await claimBrowserInput(outgoingId, 'source-page', binding.conversationId, true);
    if (superseded) expect(claimed).toBeNull();
    else {
      expect(claimed).toMatchObject({ id: outgoingId, completedTurnId: `reply:${finalId}` });
      expect(await authorizeBrowserInput(outgoingId, 'source-page', binding.conversationId)).toBe(true);
    }
  });

  it.each(['missing-proof', 'wrong-question', 'wrong-final', 'not-final', 'ineligible', 'older-final', 'newer-question',
    'newer-final', 'newer-tool', 'newer-turn', 'active-turn', 'wrong-session', 'changed-policy', 'off', 'implicit-policy',
    'pending-input', 'ambiguous-input', 'missing-receipt', 'missing-helper-receipt', 'changed-debt', 'missing-epoch', 'live-tool', 'future-receipt'])(
    'refuses an ordinary terminal alias under %s', async state => {
      const { user, final, events, pending, policy, switches, rows, outgoingId, sourceId, helperId } = await retained();
      if (state === 'missing-proof') delete (final as Partial<typeof final>).inputReplyTo;
      if (state === 'wrong-question') final.inputReplyTo = 'different-native-question';
      if (state === 'wrong-final') final.providerMessageId = 'different-native-final';
      if (state === 'not-final') { final.final = false; final.state = 'streaming'; }
      if (state === 'ineligible') final.goalEligible = false;
      if (state === 'older-final') { final.origin = 1; final.seq = 1; final.finalContentSeq = 1; }
      if (state === 'newer-question') events.push({ ...user, seq: 4, origin: 4, messageId: 'newer-native-question' });
      if (state === 'newer-final') events.push({ ...final, seq: 4, origin: 4, finalContentSeq: 4, messageId: 'newer-native-final' });
      if (state === 'newer-tool') events.push({ kind: 'tool_call', seq: 4, origin: 4 });
      if (state === 'newer-turn') events.push({ kind: 'turn_start', seq: 4, turnId: 'newer-native-turn' });
      if (state === 'active-turn') binding.activeTurnId = 'active-native-turn';
      if (state === 'wrong-session') binding.conversationId = 'different-conversation';
      if (state === 'changed-policy') switches.mockReturnValue({ version: 1, savedAt: now, switches: [{ ...policy, at: now }] });
      if (state === 'off') switches.mockReturnValue({ version: 1, savedAt: now, switches: [{ ...policy, enabled: false }] });
      if (state === 'implicit-policy') switches.mockReturnValue({ version: 1, savedAt: now, switches: [] });
      if (state === 'pending-input' || state === 'ambiguous-input') rows.push({ ...input(), conversationId: binding.conversationId,
        createdAt: now, state: state === 'pending-input' ? 'queued' : 'browser', owner: state === 'pending-input' ? null : 'other-page',
        ...(state === 'ambiguous-input' ? { sendAuthorizedAt: now } : {}) });
      if (state === 'missing-receipt') rows.find(row => row.id === sourceId)!.state = 'browser';
      if (state === 'future-receipt') rows.find(row => row.id === sourceId)!.deliveredAt = now + 61_000;
      if (state === 'missing-helper-receipt') rows.find(row => row.id === helperId)!.messageId = undefined;
      if (state === 'changed-debt') pending.acceptedAt++;
      if (state === 'missing-epoch') rows.find(row => row.id === outgoingId)!.sourceHelperAcceptedAt = undefined;
      if (state === 'live-tool') configureInputDelivery({ applyAutomation: automate, changed, callsHoldRecovery: () => true });
      await writeDurableNow('session-input', rows);
      resetInputForTests();
      expect(await claimBrowserInput(outgoingId, 'source-page', binding.conversationId, true)).toBeNull();
      expect((await listInputs()).find(row => row.id === outgoingId)?.sendAuthorizedAt).toBeUndefined();
    });
});

describe('accepted helper continuation withdrawal', () => {
  async function acceptedContinuation(recoveredBeforeSend = false) {
    const sourceTurnId = 'completed-helper-source';
    const conversationId = binding.conversationId;
    const acceptedAt = now;
    binding.model = 'gpt-6-thinking';
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: sourceTurnId, time: now };
    const armed = vi.spyOn(goalCustody, 'goalArmedFor').mockReturnValue(true);
    const pending = { sessionId, replyId: 'completed-helper-final', turnId: sourceTurnId,
      eventSeq: 1, acceptedAt };
    const pendingView = vi.spyOn(goalCustody, 'goalPendingReplyFor').mockReturnValue(pending);
    const delivered = vi.spyOn(goalCustody, 'confirmDeliveredGoalReplyNow').mockResolvedValue(true);
    let running = false;
    configureInputDelivery({ applyAutomation: automate, changed, callsHoldRecovery: () => running });
    now += 100;
    const decision = requestBrowserDecision('Decide the same exact source', new AbortController().signal, {
      lifetime: 'temporary-planner', sourceSessionId: sessionId, sourceTurnId,
      onAccepted: () => ({ sessionId, conversationId, sourceTurnId, sourceAcceptedAt: acceptedAt,
        text: 'Continue the exact verified objective' })
    });
    const helper = (await listInputs())[0]!;
    expect(await claimBrowserInput(helper.id, 'helper-page', null, true)).not.toBeNull();
    if (recoveredBeforeSend) {
      expect(await failBrowserInput(helper.id, 'helper-page', 'Unable to prepare ChatGPT', {
        confirmedUnsent: true
      })).toBe(true);
      expect((await listInputs()).find(row => row.id === helper.id)?.recoveryFailure?.phase)
        .toBe('pre_send_preparation');
      expect(await claimBrowserInput(helper.id, 'helper-page', null, true)).not.toBeNull();
    }
    expect(await authorizeBrowserInput(helper.id, 'helper-page', null)).toBe(true);
    expect(await acknowledgeBrowserInput(helper.id, 'helper-page', null, 'native-helper-question')).toBe(true);
    now += 900; // A generated continuation is necessarily newer than its source final.
    expect(await completeBrowserDecision(helper.id, 'helper-page', 'Accepted exact decision')).toBe(true);
    await expect(decision).resolves.toBe('Accepted exact decision');
    const outgoing = (await listInputs()).find(row => row.sourceHelperId === helper.id)!;
    expect(outgoing.createdAt).toBeGreaterThan(binding.end!.time);
    expect(await claimBrowserInput(outgoing.id, 'source-page', conversationId, true))
      .toMatchObject({ id: outgoing.id, completedTurnId: sourceTurnId });
    return { helper, outgoing, sourceTurnId, conversationId, armed, pending, pendingView, delivered,
      setRunning: (value: boolean) => { running = value; } };
  }

  it('accepts the original helper answer after its confirmed-unsent preparation was recovered and natively delivered', async () => {
    const { helper, outgoing } = await acceptedContinuation(true);
    expect(outgoing.sourceHelperId).toBe(helper.id);
    expect((await listInputs()).filter(row => row.purpose === 'decision')).toHaveLength(1);
  });

  it.each([false, true])('reoffers the SAME accepted-helper continuation after confirmed pre-Send withdrawal (authorized=%s)', async authorized => {
    const { helper, outgoing, sourceTurnId, conversationId, delivered } = await acceptedContinuation();
    if (authorized) expect(await authorizeBrowserInput(outgoing.id, 'source-page', conversationId)).toBe(true);
    expect(delivered).not.toHaveBeenCalled();
    expect(await failBrowserInput(outgoing.id, 'source-page', 'After-turn pickup was withdrawn before Send.', {
      confirmedUnsent: true, conversationId, detail: 'app-refused'
    })).toBe(true);
    const retry = (await listInputs()).find(row => row.id === outgoing.id)!;
    expect(retry).toMatchObject({ id: outgoing.id, state: 'queued', owner: null,
      sourceHelperId: helper.id, sourceHelperAcceptedAt: 1000, text: outgoing.text,
      recoveryWithdrawAttempts: 1, dueAt: now + 1500 });
    expect(retry.sendAuthorizedAt).toBeUndefined();
    expect(retry.completedTurnId).toBeUndefined();
    expect(retry.error).toBeUndefined();
    resetInputForTests();
    expect(await claimBrowserInput(outgoing.id, 'replacement-page', conversationId, true)).toBeNull();
    now += 1500;
    expect(await claimBrowserInput(outgoing.id, 'replacement-page', conversationId, true))
      .toMatchObject({ id: outgoing.id, completedTurnId: sourceTurnId });
    expect(await authorizeBrowserInput(outgoing.id, 'replacement-page', conversationId)).toBe(true);
    expect(delivered).not.toHaveBeenCalled();
    expect(await acknowledgeBrowserInput(outgoing.id, 'replacement-page', conversationId, 'native-continuation')).toBe(true);
    expect(delivered).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledWith(conversationId, sessionId, sourceTurnId, 'native-continuation', 1000, outgoing.id);
    expect((await listInputs()).find(row => row.id === helper.id))
      .toMatchObject({ state: 'sent', messageId: 'native-helper-question' });
    expect((await listInputs()).filter(row => row.sourceHelperId === helper.id)).toHaveLength(1);
    expect(await failBrowserInput(outgoing.id, 'replacement-page', 'After-turn pickup was withdrawn before Send.', {
      confirmedUnsent: true, conversationId
    })).toBe(false);
    expect((await listInputs()).find(row => row.id === outgoing.id))
      .toMatchObject({ state: 'sent', messageId: 'native-continuation' });
  });

  it('re-proves the exact accepted helper when a restored pre-Send claim has no cached completedTurnId', async () => {
    const { helper, outgoing, conversationId } = await acceptedContinuation();
    await writeDurableNow('session-input', (await listInputs()).map(row => row.id === outgoing.id
      ? { ...row, completedTurnId: undefined } : row));
    resetInputForTests();
    expect(await failBrowserInput(outgoing.id, 'source-page', 'After-turn pickup was withdrawn before Send.', {
      confirmedUnsent: true, conversationId
    })).toBe(true);
    expect((await listInputs()).find(row => row.id === outgoing.id)).toMatchObject({
      id: outgoing.id, sourceHelperId: helper.id, state: 'queued', owner: null,
      recoveryWithdrawAttempts: 1, dueAt: now + 1500
    });
    expect((await listInputs()).filter(row => row.purpose === 'decision')).toHaveLength(1);
  });

  it.each(['new-turn', 'new-human', 'changed-epoch', 'changed-debt-owner', 'rebound', 'superseded',
    'goal-off', 'failed-source', 'cancelled-helper', 'wrong-cached-turn'] as const)(
    'does not reoffer a withdrawn accepted-helper continuation after %s', async state => {
      const { helper, outgoing, conversationId, armed, pending, pendingView, delivered } = await acceptedContinuation();
      if (state === 'new-turn') binding.end = { kind: 'turn_start', outcome: '', turnId: 'newer-turn', time: now };
      if (state === 'new-human') vi.mocked(readRecentEvents).mockImplementation(async (_id, _limit, query) =>
        query?.kinds?.includes('user_message') ? [{ kind: 'user_message', time: now, seq: 2, source: 'extension',
          messageId: 'new-human-question', message: { text: 'New human instruction', chars: 21, truncated: false } }]
          : [binding.end as never]);
      if (state === 'changed-epoch') pendingView.mockReturnValue({ ...pending, acceptedAt: now });
      if (state === 'changed-debt-owner') pendingView.mockReturnValue({ ...pending, sessionId: 'new-owner-session' });
      if (state === 'rebound') binding.conversationId = 'compacted-successor';
      if (state === 'superseded') vi.mocked(conversationWasSuperseded).mockResolvedValue(true);
      if (state === 'goal-off') armed.mockReturnValue(false);
      if (state === 'failed-source') binding.end!.outcome = 'failed';
      if (state === 'cancelled-helper' || state === 'wrong-cached-turn') {
        await writeDurableNow('session-input', (await listInputs()).map(row =>
          state === 'cancelled-helper' && row.id === helper.id ? { ...row, state: 'cancelled' }
          : state === 'wrong-cached-turn' && row.id === outgoing.id ? { ...row, completedTurnId: 'foreign-source-turn' } : row));
        resetInputForTests();
      }
      expect(await failBrowserInput(outgoing.id, 'source-page', 'After-turn pickup was withdrawn before Send.', {
        confirmedUnsent: true, conversationId
      })).toBe(true);
      const failed = (await listInputs()).find(row => row.id === outgoing.id)!;
      expect(failed).toMatchObject({ id: outgoing.id, state: 'failed', owner: null, text: outgoing.text,
        error: expect.stringContaining('source changed before native Send') });
      expect(failed.sendAuthorizedAt).toBeUndefined();
      expect(failed.deliveredAt).toBeUndefined();
      expect(failed.messageId).toBeUndefined();
      expect(delivered).not.toHaveBeenCalled();
      expect(await pendingBrowserInputs()).toEqual([]);
      expect((await listInputs()).filter(row => row.purpose === 'decision')).toHaveLength(1);
    });

  it('retains one confirmed-unsent helper continuation through a transient tool hold without authorizing Send', async () => {
    const { helper, outgoing, conversationId, setRunning, delivered } = await acceptedContinuation();
    setRunning(true);
    expect(await failBrowserInput(outgoing.id, 'source-page', 'After-turn pickup was withdrawn before Send.', {
      confirmedUnsent: true, conversationId, detail: 'app-refused'
    })).toBe(true);
    expect((await listInputs()).find(row => row.id === outgoing.id)).toMatchObject({
      id: outgoing.id, state: 'queued', owner: null, sourceHelperId: helper.id, recoveryWithdrawAttempts: 1
    });
    now += 1500;
    expect(await claimBrowserInput(outgoing.id, 'next-page', conversationId, true)).toBeNull();
    expect(await authorizeBrowserInput(outgoing.id, 'next-page', conversationId)).toBe(false);
    expect(delivered).not.toHaveBeenCalled();
    setRunning(false);
    expect(await claimBrowserInput(outgoing.id, 'next-page', conversationId, true)).toMatchObject({ id: outgoing.id });
    expect(await authorizeBrowserInput(outgoing.id, 'next-page', conversationId)).toBe(true);
    expect(await acknowledgeBrowserInput(outgoing.id, 'next-page', conversationId, 'native-after-tool-hold')).toBe(true);
    expect(delivered).toHaveBeenCalledOnce();
    expect((await listInputs()).filter(row => row.sourceHelperId === helper.id)).toHaveLength(1);
  });

  it.each(['foreign-page', 'foreign-route', 'native-receipt'] as const)(
    'preserves exact existing custody against a withdrawal reported by %s', async state => {
      const { outgoing, conversationId } = await acceptedContinuation();
      if (state === 'native-receipt') {
        expect(await authorizeBrowserInput(outgoing.id, 'source-page', conversationId)).toBe(true);
        expect(await acknowledgeBrowserInput(outgoing.id, 'source-page', conversationId, 'already-sent')).toBe(true);
      }
      const before = JSON.stringify(await listInputs());
      expect(await failBrowserInput(outgoing.id, state === 'foreign-page' ? 'foreign-page' : 'source-page',
        'After-turn pickup was withdrawn before Send.', {
          confirmedUnsent: true, conversationId: state === 'foreign-route' ? 'foreign-route' : conversationId
        })).toBe(false);
      expect(JSON.stringify(await listInputs())).toBe(before);
    });

  it.each(['new-human', 'changed-epoch', 'rebound'] as const)(
    'rechecks accepted-helper withdrawal after asynchronous supersession lookup: %s', async state => {
      const { outgoing, conversationId, pending, pendingView } = await acceptedContinuation();
      let release!: (superseded: boolean) => void;
      const paused = new Promise<boolean>(resolve => { release = resolve; });
      let inspecting!: () => void;
      const inspected = new Promise<void>(resolve => { inspecting = resolve; });
      vi.mocked(conversationWasSuperseded).mockImplementationOnce(async () => { inspecting(); return paused; });
      const withdrawal = failBrowserInput(outgoing.id, 'source-page', 'After-turn pickup was withdrawn before Send.', {
        confirmedUnsent: true, conversationId
      });
      await inspected;
      if (state === 'new-human') vi.mocked(readRecentEvents).mockResolvedValue([{ kind: 'user_message',
        time: now, seq: 2, source: 'extension', messageId: 'human-during-lookup',
        message: { text: 'New human correction', chars: 20, truncated: false } }]);
      if (state === 'changed-epoch') pendingView.mockReturnValue({ ...pending, acceptedAt: now });
      if (state === 'rebound') binding.conversationId = 'compacted-during-lookup';
      release(false);
      expect(await withdrawal).toBe(true);
      expect((await listInputs()).find(row => row.id === outgoing.id)).toMatchObject({
        state: 'failed', owner: null, error: expect.stringContaining('source changed before native Send')
      });
      expect(await pendingBrowserInputs()).toEqual([]);
    });

  it.each(['explicit', 'no-grant', 'new-human', 'authorized', 'missing-attempts', 'missing-since', 'foreign-error', 'expired',
    'short-attempts', 'future-since', 'human-after-grant', 'epoch-after-grant', 'time-budget', 'default-reason'] as const)(
    'recovers an exhausted source-helper withdrawal only under exact explicit custody: %s', async state => {
      const { outgoing, conversationId, pending, sourceTurnId, helper } = await acceptedContinuation();
      const attempts = state === 'time-budget' ? 2 : 4;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const owner = attempt === 0 ? 'source-page' : `withdraw-page-${attempt}`;
        if (attempt > 0) expect(await claimBrowserInput(outgoing.id, owner, conversationId, true)).not.toBeNull();
        expect(await failBrowserInput(outgoing.id, owner, 'After-turn pickup was withdrawn before Send.', {
          confirmedUnsent: true, conversationId, ...(state === 'default-reason' ? {} : { detail: 'app-refused' })
        })).toBe(true);
        if (attempt < attempts - 1) now += state === 'time-budget' ? 3 * 60_000 + 1 : [1500, 5000, 15000][attempt]!;
      }
      expect(await pendingBrowserInputs()).toEqual([]);
      const rows = await listInputs();
      const failed = rows.find(row => row.id === outgoing.id)!;
      if (state === 'authorized') failed.sendAuthorizedAt = now;
      if (state === 'missing-attempts') delete failed.recoveryWithdrawAttempts;
      if (state === 'missing-since') delete failed.recoveryWithdrawnSince;
      if (state === 'short-attempts') failed.recoveryWithdrawAttempts = 1;
      if (state === 'future-since') failed.recoveryWithdrawnSince = now + 1000;
      if (state === 'foreign-error') failed.error = 'Uncertain transport failure';
      if (state === 'expired') now += 13 * 60 * 60_000;
      await writeDurableNow('session-input', rows); resetInputForTests();
      const previousAcceptedAt = pending.acceptedAt;
      pending.acceptedAt = now;
      if (state === 'new-human') vi.mocked(readRecentEvents).mockResolvedValue([{ kind: 'user_message',
        time: now, seq: 2, source: 'extension', messageId: 'newer-human-withdrawal',
        message: { text: 'A new human correction.', chars: 23, truncated: false } }] as never);
      const eligible = ['explicit', 'no-grant', 'human-after-grant', 'epoch-after-grant', 'time-budget', 'default-reason'].includes(state);
      const rearmed = ['explicit', 'time-budget', 'default-reason'].includes(state);
      const source = { sessionId, conversationId, sourceTurnId, sourceAcceptedAt: pending.acceptedAt };
      expect(await retainedSourceHelperContinuationFor(source)).toEqual(eligible
        ? { inputId: outgoing.id, sourceAcceptedAt: previousAcceptedAt } : null);
      if (!eligible) return;
      expect(await rebindRetainedSourceHelperContinuation({ ...source, inputId: outgoing.id, previousAcceptedAt })).toBe(true);
      const grant = vi.fn(async () => {
        if (state === 'human-after-grant') vi.mocked(readRecentEvents).mockResolvedValue([{ kind: 'user_message',
          time: now, seq: 2, source: 'extension', messageId: 'human-during-withdrawal-grant',
          message: { text: 'Intervening correction.', chars: 23, truncated: false } }] as never);
        if (state === 'epoch-after-grant') pending.acceptedAt++;
        return true;
      });
      expect(await retainSourceHelperContinuation({ ...source, current: () => true,
        ...(state !== 'no-grant' ? { authorizeRetry: grant } : {}) })).toBe(rearmed ? 'held' : 'attention');
      const saved = (await listInputs()).find(row => row.id === outgoing.id)!;
      expect(saved).toMatchObject({ id: outgoing.id, text: outgoing.text, sourceHelperId: helper.id,
        state: rearmed ? 'queued' : 'failed' });
      expect(saved.sendAuthorizedAt).toBeUndefined();
      expect((await listInputs()).filter(row => row.sourceHelperId === helper.id)).toHaveLength(1);
      if (rearmed) {
        expect(saved.recoveryWithdrawAttempts).toBeUndefined();
        expect(await claimBrowserInput(outgoing.id, 'explicit-recovered-page', conversationId, true)).not.toBeNull();
        expect(await failBrowserInput(outgoing.id, 'explicit-recovered-page', 'After-turn pickup was withdrawn before Send.', {
          confirmedUnsent: true, conversationId, detail: 'app-refused'
        })).toBe(true);
        expect((await listInputs()).find(row => row.id === outgoing.id)).toMatchObject({ state: 'queued', recoveryWithdrawAttempts: 1 });
      }
    });

  it('bounds accepted-helper pre-Send withdrawals without creating another helper or continuation', async () => {
    const { helper, outgoing, conversationId } = await acceptedContinuation();
    const delays = [1500, 5000, 15000];
    for (let attempt = 0; attempt < 4; attempt++) {
      const owner = attempt === 0 ? 'source-page' : `retry-page-${attempt}`;
      if (attempt > 0) expect(await claimBrowserInput(outgoing.id, owner, conversationId, true)).not.toBeNull();
      expect(await failBrowserInput(outgoing.id, owner, 'After-turn pickup was withdrawn before Send.', {
        confirmedUnsent: true, conversationId, detail: 'send-not-ready'
      })).toBe(true);
      const saved = (await listInputs()).find(row => row.id === outgoing.id)!;
      expect(saved).toMatchObject({ id: outgoing.id, state: attempt < 3 ? 'queued' : 'failed',
        owner: null, recoveryWithdrawAttempts: attempt + 1 });
      expect(saved.messageId).toBeUndefined();
      resetInputForTests();
      if (attempt < 3) now += delays[attempt]!;
    }
    expect(await pendingBrowserInputs()).toEqual([]);
    expect((await listInputs()).filter(row => row.purpose === 'decision')).toHaveLength(1);
    expect((await listInputs()).filter(row => row.sourceHelperId === helper.id)).toHaveLength(1);
    expect((await listInputs()).find(row => row.id === helper.id)).toMatchObject({
      state: 'sent', messageId: 'native-helper-question'
    });
  });
});

describe('durable user input ownership', () => {
  it.each(['untouched', 'offered', 'authorized', 'owned', 'delivered', 'missing-helper-ack',
    'same-question', 'old-question-edit', 'reoffered', 'missing-old-final', 'foreign-conversation'] as const)(
    'retires only a positively superseded untouched helper continuation (%s)', async state => {
      const helperId = randomUUID(), outgoingId = randomUUID();
      const oldTurn = 'superseded-helper-turn';
      const rows: InputEntry[] = [
        { ...input({ id: helperId, sessionId: null, text: '[Temporary planner]' }), purpose: 'decision', lifetime: 'temporary-planner',
          state: 'sent', owner: 'helper-page', createdAt: now - 200, conversationId: 'helper-conversation',
          decisionSourceSessionId: sessionId, decisionSourceTurnId: oldTurn,
          requiresAuthorization: true, sendAuthorizedAt: now - 150,
          deliveredAt: now - 100, messageId: 'exact-helper-question' },
        { ...input({ id: outgoingId, mode: 'after-turn', text: 'PRIVATE obsolete continuation' }),
          state: 'queued', owner: null, createdAt: now, conversationId: binding.conversationId,
          sourceHelperId: helperId, sourceHelperAcceptedAt: now - 150 }
      ];
      const outgoing = rows[1]!;
      if (state === 'offered') outgoing.offeredAt = now;
      if (state === 'authorized') outgoing.sendAuthorizedAt = now;
      if (state === 'owned') outgoing.owner = 'previous-page';
      if (state === 'delivered') outgoing.messageId = 'possible-native-message';
      if (state === 'reoffered') outgoing.preSendReoffers = 1;
      if (state === 'missing-helper-ack') delete rows[0]!.messageId;
      vi.spyOn(goalCustody, 'goalArmedFor').mockReturnValue(true);
      const oldFinal = { kind: 'assistant_message', seq: 10, origin: 10, turnId: oldTurn,
        messageId: 'old-helper-source-final', final: true };
      const question = { kind: 'user_message', seq: state === 'same-question' ? 9 : 11,
        ...(state === 'old-question-edit' ? { origin: 9 } : {}), messageId: 'new-human-question' };
      vi.mocked(readRecentEvents).mockImplementation(async (_id, _limit, options) => {
        const kinds = options?.kinds ?? [];
        return (kinds.includes('assistant_message') ? state === 'missing-old-final' ? [] : [oldFinal]
          : kinds.includes('user_message') ? [question] : []) as never;
      });
      if (state === 'foreign-conversation') binding.recorded = false;
      await writeDurableNow('session-input', rows); resetInputForTests();
      await pendingBrowserInputs();
      const after = (await listInputs()).find(row => row.id === outgoingId)!;
      expect(after.state).toBe(state === 'untouched' ? 'cancelled' : 'queued');
      expect(after.text).toBe(outgoing.text);
      expect(after.sourceHelperId).toBe(helperId);
      expect(after.deliveredAt).toBeUndefined();
      expect(after.operatorCancelledAt).toBeUndefined();
      if (state === 'untouched') {
        expect(after.error).toBe('Not sent: a newer recorded question superseded this unoffered helper continuation.');
        expect(getLog().filter(row => row.message.includes(`input ${outgoingId}: superseded unoffered helper continuation retired`))).toHaveLength(1);
        await pendingBrowserInputs(); resetInputForTests();
        expect((await listInputs()).find(row => row.id === outgoingId)).toEqual(after);
        expect((await listInputs()).find(row => row.id === helperId)).toEqual(rows[0]);
      }
    });

  it.each(['explicit', 'no-grant', 'revoked-after-grant', 'blocked-after-grant', 'new-turn-after-grant',
    'new-human-after-grant', 'mcp-after-grant', 'ambiguous', 'cancelled', 'multiple'] as const)(
    'rearms the original saved continuation only under atomic explicit pre-Send custody: %s', async state => {
      const helperId = randomUUID();
      const outgoingId = randomUUID();
      const sourceTurnId = 'exact-saved-source';
      const acceptedAt = now;
      binding.end = { kind: 'turn_end', outcome: 'completed', turnId: sourceTurnId, time: now };
      vi.spyOn(goalCustody, 'goalArmedFor').mockReturnValue(true);
      vi.spyOn(goalCustody, 'goalPendingReplyFor').mockReturnValue({ sessionId, replyId: 'source-final', turnId: sourceTurnId,
        eventSeq: 1, acceptedAt });
      const helper = { ...input({ id: helperId, sessionId: null, text: '[Temporary planner]' }),
        purpose: 'decision', lifetime: 'temporary-planner', state: 'sent', owner: 'original-helper',
        decisionSourceSessionId: sessionId, decisionSourceTurnId: sourceTurnId, createdAt: now,
        conversationId: null, messageId: 'exact-native-helper-send', deliveredAt: now };
      const outgoing = { ...input({ id: outgoingId, mode: 'after-turn', text: 'Exact retained continuation' }),
        sourceHelperId: helperId, state: state === 'cancelled' ? 'cancelled' : 'failed', owner: null,
        createdAt: now, conversationId: binding.conversationId, requiresAuthorization: true, preSendReoffers: 3,
        ...(state === 'ambiguous' ? { sendAuthorizedAt: now } : {}) };
      await writeDurableNow('session-input', [helper, outgoing,
        ...(state === 'multiple' ? [{ ...outgoing, id: randomUUID() }] : [])]);
      resetInputForTests();
      let authority = true;
      let tools = false;
      configureInputDelivery({ applyAutomation: automate, changed, callsHoldRecovery: () => tools });
      const grant = vi.fn(async () => {
        if (state === 'revoked-after-grant') authority = false;
        if (state === 'blocked-after-grant') binding.blocked = true;
        if (state === 'new-turn-after-grant') binding.end = { kind: 'turn_start', outcome: '', turnId: 'newer-source', time: now };
        if (state === 'new-human-after-grant') vi.mocked((await import('../src/main/session/store.js')).readRecentEvents)
          .mockResolvedValueOnce([{ kind: 'user_message', time: now, source: 'extension', seq: 2,
            message: { text: 'New human correction', chars: 20, truncated: false } }]);
        if (state === 'mcp-after-grant') tools = true;
        return true;
      });
      expect(await retainSourceHelperContinuation({ sessionId, conversationId: binding.conversationId,
        sourceTurnId, sourceAcceptedAt: acceptedAt, current: () => authority,
        ...(state === 'no-grant' ? {} : { authorizeRetry: grant }) })).toBe(state === 'explicit' ? 'held' : 'attention');
      const rows = await listInputs();
      expect(rows.find(row => row.id === outgoingId)).toMatchObject({ id: outgoingId, sourceHelperId: helperId,
        text: outgoing.text, state: state === 'explicit' ? 'queued' : outgoing.state });
      expect(rows.filter(row => row.purpose === 'decision')).toHaveLength(1);
      expect(rows.find(row => row.id === helperId)?.response).toBeUndefined();
      expect(grant).toHaveBeenCalledTimes(['no-grant', 'ambiguous', 'cancelled', 'multiple'].includes(state) ? 0 : 1);
    });
  it.each(['claim', 'authorize'] as const)('rechecks source-helper %s custody after asynchronous source inspection', async transport => {
    const store = await import('../src/main/session/store.js');
    const sourceTurnId = 'source-helper-authorization';
    const helperId = randomUUID(), outgoingId = randomUUID();
    const conversationId = binding.conversationId;
    const pending = { sessionId, replyId: 'source-helper-final', turnId: sourceTurnId, eventSeq: 1, acceptedAt: now };
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: sourceTurnId, time: now };
    vi.spyOn(goalCustody, 'goalArmedFor').mockReturnValue(true);
    const pendingView = vi.spyOn(goalCustody, 'goalPendingReplyFor').mockReturnValue(pending);
    await writeDurableNow('session-input', [
      { ...input({ id: helperId, sessionId: null, text: '[Temporary planner]' }),
        purpose: 'decision', lifetime: 'temporary-planner', state: 'sent', owner: 'original-helper',
        createdAt: now, conversationId: null, decisionSourceSessionId: sessionId,
        decisionSourceTurnId: sourceTurnId, deliveredAt: now, messageId: 'native-helper-send' },
      { ...input({ id: outgoingId, mode: 'after-turn', text: 'Exact saved continuation' }),
        sourceHelperId: helperId, sourceHelperAcceptedAt: now, state: 'queued', owner: null,
        createdAt: now, conversationId }
    ]);
    resetInputForTests();
    if (transport === 'authorize') expect(await claimBrowserInput(outgoingId, 'original-page', conversationId, true)).not.toBeNull();
    vi.spyOn(store, 'conversationWasSuperseded').mockImplementationOnce(async () => {
      // The epoch is deliberately unchanged: checking only acceptedAt misses a changed source owner.
      pendingView.mockReturnValue({ ...pending, sessionId: 'new-owner-session', turnId: 'new-source-turn' });
      return false;
    });
    if (transport === 'claim') expect(await claimBrowserInput(outgoingId, 'original-page', conversationId, true)).toBeNull();
    else expect(await authorizeBrowserInput(outgoingId, 'original-page', conversationId)).toBe(false);
    expect((await listInputs()).find(row => row.id === outgoingId)?.sendAuthorizedAt).toBeUndefined();
    expect((await listInputs()).filter(row => row.purpose === 'decision')).toHaveLength(1);
  });

  it.each(['claim', 'authorize'] as const)('revokes source-helper %s when a newer human message precedes turn_start', async transport => {
    const store = await import('../src/main/session/store.js');
    const sourceTurnId = 'source-helper-new-human';
    const helperId = randomUUID(), outgoingId = randomUUID();
    const conversationId = binding.conversationId;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: sourceTurnId, time: now };
    vi.spyOn(goalCustody, 'goalArmedFor').mockReturnValue(true);
    vi.spyOn(goalCustody, 'goalPendingReplyFor').mockReturnValue({ sessionId, replyId: 'source-final', turnId: sourceTurnId,
      eventSeq: 1, acceptedAt: now });
    await writeDurableNow('session-input', [
      { ...input({ id: helperId, sessionId: null, text: '[Temporary planner]' }),
        purpose: 'decision', lifetime: 'temporary-planner', state: 'sent', owner: 'original-helper',
        createdAt: now, conversationId: null, decisionSourceSessionId: sessionId,
        decisionSourceTurnId: sourceTurnId, deliveredAt: now, messageId: 'native-helper-send' },
      { ...input({ id: outgoingId, mode: 'after-turn', text: 'Exact saved continuation' }),
        sourceHelperId: helperId, sourceHelperAcceptedAt: now, state: 'queued', owner: null,
        createdAt: now, conversationId }
    ]);
    resetInputForTests();
    if (transport === 'authorize') expect(await claimBrowserInput(outgoingId, 'original-page', conversationId, true)).not.toBeNull();
    vi.spyOn(store, 'readRecentEvents').mockImplementation(async (_id, _limit, query) =>
      query?.kinds?.includes('user_message') ? [{ kind: 'user_message', time: now + 1, seq: 2, source: 'extension',
        messageId: 'new-human-instruction', message: { text: 'New human correction', chars: 20, truncated: false } }]
        : [binding.end as never]);
    if (transport === 'claim') expect(await claimBrowserInput(outgoingId, 'original-page', conversationId, true)).toBeNull();
    else expect(await authorizeBrowserInput(outgoingId, 'original-page', conversationId)).toBe(false);
    expect((await listInputs()).find(row => row.id === outgoingId)?.sendAuthorizedAt).toBeUndefined();
  });

  it.each(['exact-pending', 'no-debt', 'different-debt', 'changed-epoch', 'wrong-debt-session',
    'wrong-helper-session', 'wrong-helper-turn', 'wrong-conversation', 'foreign-helper', 'cancelled',
    'ambiguous', 'legacy-epoch', 'goal-off', 'native-accepted'] as const)(
    'bounds terminal source-helper history to exact unfinished Goal custody: %s', async state => {
      const sourceTurnId = 'retained-goal-source';
      const helperId = randomUUID();
      const outgoingId = randomUUID();
      vi.spyOn(goalCustody, 'goalArmedFor').mockReturnValue(state !== 'goal-off');
      vi.spyOn(goalCustody, 'goalPendingReplyFor').mockImplementation(conversationId =>
        conversationId !== binding.conversationId || state === 'no-debt' ? null : {
          sessionId: state === 'wrong-debt-session' ? 'different-source-session' : sessionId,
          replyId: 'exact-goal-final', turnId: state === 'different-debt' ? 'different-goal-source' : sourceTurnId,
          eventSeq: 1, acceptedAt: state === 'changed-epoch' ? now + 1 : now
        });
      const helper = { ...input({ id: helperId, sessionId: null, text: '[Temporary planner]' }),
        purpose: 'decision', ...(state === 'foreign-helper' ? {} : { lifetime: 'temporary-planner' }),
        state: 'sent', owner: 'original-helper', createdAt: now, conversationId: null,
        decisionSourceSessionId: state === 'wrong-helper-session' ? 'different-source-session' : sessionId,
        decisionSourceTurnId: state === 'wrong-helper-turn' ? 'different-helper-turn' : sourceTurnId,
        deliveredAt: now, messageId: 'original-native-helper' };
      const outgoing = { ...input({ id: outgoingId, mode: 'after-turn', text: 'Saved exact continuation' }),
        sourceHelperId: helperId, ...(state === 'legacy-epoch' ? {} : { sourceHelperAcceptedAt: now }),
        state: state === 'cancelled' ? 'cancelled' : state === 'native-accepted' ? 'sent' : 'failed', owner: null,
        createdAt: now, conversationId: state === 'wrong-conversation' ? 'another-conversation' : binding.conversationId,
        requiresAuthorization: true, preSendReoffers: 3,
        ...(state === 'ambiguous' ? { sendAuthorizedAt: now } : {}),
        ...(state === 'native-accepted' ? { deliveredAt: now, messageId: 'native-outgoing-send', historyRecorded: true } : {}) };
      const history = Array.from({ length: 62 }, (_, index) => ({
        ...input({ sessionId: null, text: '[Temporary planner]' }), purpose: 'decision', lifetime: 'temporary-planner',
        state: 'sent', owner: `independent-${index}`, createdAt: now + index + 1, conversationId: null,
        deliveredAt: now + index + 1, messageId: `unrelated-native-${index}`
      }));
      await writeDurableNow('session-input', [helper, outgoing, ...history]);
      resetInputForTests();
      const controller = new AbortController();
      const answer = requestBrowserDecision('Independent future decision', controller.signal, { lifetime: 'temporary-planner' });
      const active = await listInputs();
      // A newly advanced pickup epoch is storage custody only: rebind may still be committing
      // (or may have failed durably). Claim/authorize remains exact-epoch fenced in the adjacent
      // changed-epoch regression, so retaining this pair cannot execute it under the new epoch.
      const retained = state === 'exact-pending' || state === 'changed-epoch';
      expect(active.some(row => row.id === helperId)).toBe(retained);
      expect(active.some(row => row.id === outgoingId)).toBe(retained);
      expect(active.length).toBeLessThanOrEqual(retained ? 53 : 51);
      resetInputForTests();
      const cold = await listInputs();
      expect(cold.some(row => row.id === outgoingId)).toBe(retained);
      expect(cold.find(row => row.id === helperId)?.response).toBeUndefined();
      controller.abort();
      await expect(answer).rejects.toThrow('goal_browser_cancelled');
    });

  it.each([
    ['fresh handled Off transition', 1_000, true],
    ['expired handled Off transition', 12 * 60 * 60_000 + 1_001, false]
  ] as const)('bounds retained pre-Send continuation custody across an actual %s', async (_label, currentTime, retained) => {
    goalCustody.resetGoalStateForTests();
    now = currentTime;
    const acceptedAt = 1_000;
    const sourceTurnId = 'off-retained-source-turn';
    const helperId = randomUUID();
    const outgoingId = randomUUID();
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: sourceTurnId, time: acceptedAt };

    await goalCustody.setGoalSwitchNow(binding.conversationId, 'loop', true);
    goalCustody.restoreGoalReplies({ version: 1, savedAt: now, replies: [{
      conversationId: binding.conversationId,
      sessionId,
      replyId: 'off-retained-final',
      turnId: sourceTurnId,
      eventSeq: 1,
      acceptedAt,
      state: 'pending'
    }] });
    await goalCustody.setGoalSwitchNow(binding.conversationId, 'loop', false);
    expect(await goalCustody.setGoalReplyActiveNow(binding.conversationId, false)).toBe(true);
    expect(goalCustody.goalArmedFor(binding.conversationId)).toBe(false);
    expect(goalCustody.goalPendingReplyFor(binding.conversationId)).toBeNull();

    const helper = {
      ...input({ id: helperId, sessionId: null, text: '[Temporary planner]' }),
      purpose: 'decision' as const,
      lifetime: 'temporary-planner' as const,
      state: 'sent' as const,
      owner: 'original-helper',
      createdAt: acceptedAt,
      conversationId: null,
      decisionSourceSessionId: sessionId,
      decisionSourceTurnId: sourceTurnId,
      deliveredAt: acceptedAt,
      messageId: 'off-retained-native-helper'
    };
    const outgoing = {
      ...input({ id: outgoingId, mode: 'after-turn', text: 'Exact continuation retained across Off' }),
      sourceHelperId: helperId,
      sourceHelperAcceptedAt: acceptedAt,
      state: 'failed' as const,
      owner: null,
      createdAt: acceptedAt,
      conversationId: binding.conversationId,
      requiresAuthorization: true,
      preSendReoffers: 3
    };
    const churn = Array.from({ length: 62 }, (_, index) => ({
      ...input({ sessionId: null, text: '[Temporary planner]' }),
      purpose: 'decision' as const,
      lifetime: 'temporary-planner' as const,
      state: 'sent' as const,
      owner: `concurrent-${index}`,
      createdAt: acceptedAt + index + 1,
      conversationId: null,
      deliveredAt: acceptedAt + index + 1,
      messageId: `concurrent-native-${index}`
    }));
    await writeDurableNow('session-input', [helper, outgoing, ...churn]);
    resetInputForTests();

    const controller = new AbortController();
    const appendDuringOff = requestBrowserDecision('Concurrent decision while the source is Off', controller.signal, {
      lifetime: 'temporary-planner'
    });
    const rows = await listInputs();
    expect(rows.some(row => row.id === helperId)).toBe(retained);
    expect(rows.some(row => row.id === outgoingId)).toBe(retained);
    if (retained) {
      expect(rows.find(row => row.id === outgoingId)).toMatchObject({
        state: 'failed',
        owner: null,
        sourceHelperId: helperId,
        sourceHelperAcceptedAt: acceptedAt,
        preSendReoffers: 3
      });
    }
    resetInputForTests();
    const cold = await listInputs();
    expect(cold.some(row => row.id === helperId)).toBe(retained);
    expect(cold.some(row => row.id === outgoingId)).toBe(retained);
    controller.abort();
    await expect(appendDuringOff).rejects.toThrow('goal_browser_cancelled');
    goalCustody.resetGoalStateForTests();
  });

  it('does not rebind a cold retained continuation after the handled-Off custody horizon without an intervening append', async () => {
    goalCustody.resetGoalStateForTests();
    const acceptedAt = 1_000;
    const sourceTurnId = 'expired-off-direct-resume-turn';
    const helperId = randomUUID();
    const outgoingId = randomUUID();
    now = acceptedAt;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: sourceTurnId, time: acceptedAt };
    await goalCustody.setGoalSwitchNow(binding.conversationId, 'loop', true);
    goalCustody.restoreGoalReplies({ version: 1, savedAt: now, replies: [{
      conversationId: binding.conversationId,
      sessionId,
      replyId: 'expired-off-direct-final',
      turnId: sourceTurnId,
      eventSeq: 1,
      acceptedAt,
      state: 'pending'
    }] });
    await goalCustody.setGoalSwitchNow(binding.conversationId, 'loop', false);
    expect(await goalCustody.setGoalReplyActiveNow(binding.conversationId, false)).toBe(true);
    await writeDurableNow('session-input', [
      {
        ...input({ id: helperId, sessionId: null, text: '[Temporary planner]' }),
        purpose: 'decision', lifetime: 'temporary-planner', state: 'sent', owner: 'expired-helper-page',
        createdAt: acceptedAt, conversationId: null, decisionSourceSessionId: sessionId,
        decisionSourceTurnId: sourceTurnId, deliveredAt: acceptedAt, messageId: 'expired-helper-native-send'
      },
      {
        ...input({ id: outgoingId, mode: 'after-turn', text: 'Expired exact saved continuation' }),
        sourceHelperId: helperId, sourceHelperAcceptedAt: acceptedAt, state: 'failed', owner: null,
        createdAt: acceptedAt, conversationId: binding.conversationId, requiresAuthorization: true,
        preSendReoffers: 3
      }
    ]);
    resetInputForTests();

    // No append/prune happens between Off and this direct On. Eligibility itself must enforce
    // the custody horizon rather than relying on unrelated future queue traffic to delete it.
    now = acceptedAt + 12 * 60 * 60_000 + 1;
    await goalCustody.setGoalSwitchNow(binding.conversationId, 'loop', true);
    expect(await goalCustody.setGoalReplyActiveNow(binding.conversationId, true)).toBe(true);
    const pending = goalCustody.goalPendingReplyFor(binding.conversationId)!;
    expect(pending.acceptedAt).toBeGreaterThan(acceptedAt);
    expect(await retainedSourceHelperContinuationFor({
      sessionId,
      conversationId: binding.conversationId,
      sourceTurnId,
      sourceAcceptedAt: pending.acceptedAt
    })).toBeNull();
    expect(await rebindRetainedSourceHelperContinuation({
      inputId: outgoingId,
      sessionId,
      conversationId: binding.conversationId,
      sourceTurnId,
      previousAcceptedAt: acceptedAt,
      sourceAcceptedAt: pending.acceptedAt
    })).toBe(false);
    expect((await listInputs()).find(row => row.id === outgoingId)).toMatchObject({
      state: 'failed', owner: null, sourceHelperAcceptedAt: acceptedAt
    });
    goalCustody.resetGoalStateForTests();
  });

  it('cold-recovers an earlier duplicate accepted STOP UUID without inventing a second helper or dropping unrelated input', async () => {
    const helper: InputEntry = {
      ...input({ sessionId: null, text: '[Temporary planner]' }),
      purpose: 'decision', lifetime: 'temporary-planner', decisionSourceSessionId: sessionId,
      decisionSourceTurnId: 'accepted-source-turn', state: 'sent', owner: 'held-helper-document',
      createdAt: now, conversationId: null, deliveredAt: now, messageId: 'native-original-send',
      goalStopDisposition: { sessionId, conversationId: binding.conversationId,
        sourceTurnId: 'accepted-source-turn', sourceAcceptedAt: now }
    };
    const unrelated: InputEntry = { ...input({ sessionId: null, text: 'Independent authored work' }),
      state: 'queued', owner: null, createdAt: now + 1, conversationId: null };
    // Previous append() wrote the same already-accepted receipt into active AND history.
    // Reconstruct those exact persisted bytes, not a duplicate Send or second helper.
    await writeDurableNow('session-input', [helper, { ...helper }, unrelated]);
    resetInputForTests();
    expect((await listInputs()).map(row => row.id)).toEqual([helper.id, unrelated.id]);
    expect((await readDurable<InputEntry[]>('session-input'))?.map(row => row.id))
      .toEqual([helper.id, unrelated.id]);
    resetInputForTests();
    expect((await listInputs()).filter(row => row.id === helper.id)).toHaveLength(1);
    const later = await enqueueInput(input({ sessionId: null, text: 'Later unrelated request' }));
    const after = await listInputs();
    expect(after.filter(row => row.id === helper.id)).toHaveLength(1);
    expect(after.filter(row => row.id === unrelated.id)).toHaveLength(1);
    expect(after.filter(row => row.id === later.id)).toHaveLength(1);
    expect(after.find(row => row.id === helper.id)).toMatchObject({
      state: 'sent', messageId: 'native-original-send', goalStopDisposition: helper.goalStopDisposition
    });
  });

  it('refuses conflicting persisted versions of one UUID instead of choosing a Send receipt', async () => {
    const original: InputEntry = { ...input({ sessionId: null, text: '[Temporary planner]' }),
      purpose: 'decision', lifetime: 'temporary-planner', decisionSourceSessionId: sessionId,
      decisionSourceTurnId: 'conflicting-source-turn', state: 'sent', owner: 'original-page',
      createdAt: now, conversationId: null, deliveredAt: now, messageId: 'native-message-one' };
    const contradictory = { ...original, messageId: 'native-message-two' };
    await writeDurableNow('session-input', [original, contradictory]);
    resetInputForTests();
    await expect(listInputs()).rejects.toThrow('duplicate message identity');
    expect((await readDurable<InputEntry[]>('session-input'))).toEqual([original, contradictory]);
    await writeDurableNow('session-input', [original]);
    expect((await listInputs()).map(row => row.id)).toEqual([original.id]);
  });

  it('does not publish recovered duplicate custody when its repair cannot reach durable storage', async () => {
    const original: InputEntry = { ...input({ sessionId: null, text: '[Temporary planner]' }),
      purpose: 'decision', lifetime: 'temporary-planner', decisionSourceSessionId: sessionId,
      decisionSourceTurnId: 'write-failure-source', state: 'sent', owner: 'existing-document',
      createdAt: now, conversationId: null, deliveredAt: now, messageId: 'proven-native-message' };
    await writeDurableNow('session-input', [original, { ...original }]);
    resetInputForTests();
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected repair rename failure'));
    await expect(listInputs()).rejects.toThrow('injected repair rename failure');
    expect((await readDurable<InputEntry[]>('session-input'))?.map(row => row.id))
      .toEqual([original.id, original.id]);
    expect((await listInputs()).map(row => row.id)).toEqual([original.id]);
    expect((await readDurable<InputEntry[]>('session-input'))?.map(row => row.id))
      .toEqual([original.id]);
  });

  it('refuses pre-init loading without caching an empty outbox, then loads and cancels after init', async () => {
    const row: InputEntry = {
      ...input({ text: 'Persisted before bootstrap completes' }),
      state: 'queued', owner: null, createdAt: now, conversationId: binding.conversationId
    };
    const stateDirectory = path.join(directory, 'state');
    await fs.mkdir(stateDirectory, { recursive: true });
    await fs.writeFile(path.join(stateDirectory, 'session-input.json'), JSON.stringify([row]), 'utf8');

    resetInputForTests();
    resetDurableForTests();
    await expect(listInputs()).rejects.toThrow('durable message outbox is not initialized');

    initDurableStore(directory);
    expect(await cancelQueuedInputByOperator(row.id)).toBe(true);
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'cancelled', operatorCancelledAt: now
    });
  });

  it('does not cache or overwrite a corrupt durable outbox as empty', async () => {
    const row: InputEntry = {
      ...input({ text: 'Survives a transient corrupt read' }),
      state: 'queued', owner: null, createdAt: now, conversationId: binding.conversationId
    };
    const stateFile = path.join(directory, 'state', 'session-input.json');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, '{not-json', 'utf8');
    resetInputForTests();

    await expect(listInputs()).rejects.toThrow();

    await fs.writeFile(stateFile, JSON.stringify([row]), 'utf8');
    expect(await cancelQueuedInputByOperator(row.id)).toBe(true);
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'cancelled', operatorCancelledAt: now
    });
  });

  it('serializes semantic operator admission across different UUIDs', async () => {
    const authored = input({ text: 'One stable operator request', dueAt: 100 });
    const operatorRequestKey = operatorInputSemanticKey(authored);
    const attempts = await Promise.allSettled([
      enqueueInput({ ...authored, operatorRequestKey }),
      enqueueInput({ ...authored, id: randomUUID(), dueAt: 200, operatorRequestKey })
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected' });
    if (rejected?.status === 'rejected') expect(String(rejected.reason)).toContain('Matching operator request already exists');
    expect(await listInputs()).toHaveLength(1);
  });

  it('permits only an exact confirmed-pre-Send operator retry', async () => {
    const original = input({ text: 'Retry only with exact evidence' });
    const operatorRequestKey = operatorInputSemanticKey(original);
    const failed: InputEntry = { ...original, operatorRequestKey, state: 'failed', owner: null,
      requiresAuthorization: true, createdAt: now, conversationId: binding.conversationId };
    await writeDurableNow('session-input', [failed]);
    resetInputForTests();
    await expect(enqueueInput({ ...original, id: randomUUID(), operatorRequestKey }))
      .rejects.toThrow('Matching operator request already exists');
    const retry = await enqueueInput({ ...original, id: randomUUID(), dueAt: 999,
      operatorRequestKey, operatorRetryOf: [original.id] });
    expect(retry).toMatchObject({ state: 'queued', operatorRetryOf: [original.id] });
    expect((await listInputs()).find(row => row.id === original.id)).toMatchObject({ state: 'failed' });
  });

  it.each([false, true])('keeps a confirmed-unsent operator retry matched across generated envelope headers (legacy=%s)', async legacy => {
    const questions = ['What color is the sky?', 'How many days are in a week?', 'What is your favorite season?',
      'Where do birds build nests?', 'Why do leaves change color?', 'What makes a rainbow?', 'How do seeds grow?',
      'Where does rain come from?', 'What do bees collect?', 'How do fish breathe?'];
    const wrap = (header: string[]) => `${header.join(', ')}.\nContinue the exact retained metadata workflow.\nIGNORE THE FIRST SENTENCE ABOVE.`;
    const original = input({ text: wrap(questions) });
    const frozenKey = legacy ? 'a'.repeat(64) : operatorInputSemanticKey(original);
    const failed: InputEntry = { ...original, operatorRequestKey: frozenKey, state: 'failed', owner: null,
      requiresAuthorization: true, createdAt: now, conversationId: binding.conversationId };
    await writeDurableNow('session-input', [failed]);
    resetInputForTests();
    const replacement = { ...original, id: randomUUID(), text: wrap([...questions].reverse()) };
    const retry = await enqueueInput({ ...replacement, operatorRequestKey: operatorInputSemanticKey(replacement),
      operatorRetryOf: [original.id] });
    expect(retry).toMatchObject({ state: 'queued', text: replacement.text, operatorRetryOf: [original.id] });
    expect((await listInputs()).find(row => row.id === original.id)).toEqual(failed);
    expect((await listInputs()).filter(row => row.id !== original.id)).toHaveLength(1);
  });

  it.each(['sent', 'cancelled', 'authorized', 'missing-authorization', 'changed-body', 'changed-model', 'foreign-header'] as const)(
    'keeps operator envelope matching fail-closed for %s', async reason => {
      const questions = ['What color is the sky?', 'How many days are in a week?', 'What is your favorite season?',
        'Where do birds build nests?', 'Why do leaves change color?', 'What makes a rainbow?', 'How do seeds grow?',
        'Where does rain come from?', 'What do bees collect?', 'How do fish breathe?'];
      const wrap = (header: string[], body = 'Same saved request') => `${header.join(', ')}.\n${body}\nIGNORE THE FIRST SENTENCE ABOVE.`;
      const original = input({ text: wrap(questions) });
      const failed: InputEntry = { ...original, operatorRequestKey: 'b'.repeat(64), state: 'failed', owner: null,
        requiresAuthorization: true, createdAt: now, conversationId: binding.conversationId };
      if (reason === 'sent') { failed.state = 'sent'; failed.deliveredAt = now; failed.messageId = 'original-native-send'; }
      if (reason === 'cancelled') failed.state = 'cancelled';
      if (reason === 'authorized') failed.sendAuthorizedAt = now;
      if (reason === 'missing-authorization') delete failed.requiresAuthorization;
      await writeDurableNow('session-input', [failed]); resetInputForTests();
      const header = [...questions].reverse();
      if (reason === 'foreign-header') header[0] = 'Unrecognized authored first sentence?';
      const replacement = { ...original, id: randomUUID(),
        text: wrap(header, reason === 'changed-body' ? 'Different work' : 'Same saved request'),
        ...(reason === 'changed-model' ? { model: 'another-model' } : {}) };
      await expect(enqueueInput({ ...replacement, operatorRequestKey: operatorInputSemanticKey(replacement),
        operatorRetryOf: [original.id] })).rejects.toThrow(/Matching operator request|retry evidence/);
      expect(await listInputs()).toEqual([failed]);
    });

  it('retains strict operator cancellation audit and loses atomically to a browser claim', async () => {
    const cancellable = await enqueueInput(input({ text: 'Cancel before any owner' }));
    expect(await cancelQueuedInputByOperator(cancellable.id)).toBe(true);
    expect((await listInputs()).find(row => row.id === cancellable.id)).toMatchObject({
      state: 'cancelled', operatorCancelledAt: now,
      error: 'Not sent: cancelled by the operator before any delivery owner claimed this input.'
    });

    const racing = await enqueueInput(input({ text: 'Browser wins the serialized race' }));
    const [claim, cancelled] = await Promise.all([
      claimBrowserInput(racing.id, 'native-page', binding.conversationId, true),
      cancelQueuedInputByOperator(racing.id)
    ]);
    expect(claim).toMatchObject({ state: 'browser', owner: 'native-page' });
    expect(cancelled).toBe(false);
    expect((await listInputs()).find(row => row.id === racing.id)).toMatchObject({
      state: 'browser', owner: 'native-page', offeredAt: now
    });
  });

  it.each([
    ['owner', { owner: 'browser-owner' }],
    ['offer receipt', { offeredAt: 1 }],
    ['Send authorization', { sendAuthorizedAt: 1 }],
    ['delivery receipt', { deliveredAt: 1 }],
    ['message receipt', { messageId: 'native-message' }]
  ])('refuses strict operator cancellation after %s', async (_label, evidence) => {
    const args = input({ text: `Preserve ${_label}` });
    const row: InputEntry = { ...args, state: 'queued', owner: null, createdAt: now,
      conversationId: binding.conversationId, ...evidence };
    await writeDurableNow('session-input', [row]);
    resetInputForTests();
    expect(await cancelQueuedInputByOperator(row.id)).toBe(false);
    expect((await listInputs())[0]).toMatchObject({ state: 'queued', ...evidence });
  });

  it('retires only positively unsent exact destinations when ChatGPT proves deletion', async () => {
    const rows: InputEntry[] = [
      { ...input(), state: 'queued', owner: null, createdAt: now, conversationId: binding.conversationId },
      { ...input(), state: 'browser', owner: 'pre-send-page', requiresAuthorization: true, createdAt: now, conversationId: binding.conversationId },
      ...(['tool', 'decision', 'sent'] as const).map(state => ({ ...input(), state, owner: 'live-owner', createdAt: now, conversationId: binding.conversationId })),
      { ...input(), state: 'browser', owner: 'legacy-page', createdAt: now, conversationId: binding.conversationId },
      { ...input(), state: 'browser', owner: 'authorized-page', requiresAuthorization: true, sendAuthorizedAt: now, createdAt: now, conversationId: binding.conversationId },
      { ...input(), state: 'queued', owner: null, offeredAt: now, createdAt: now, conversationId: binding.conversationId },
      { ...input({ sessionId: 'session-two' }), state: 'queued', owner: null, createdAt: now, conversationId: 'conversation-b' }
    ];
    await writeDurableNow('session-input', rows); resetInputForTests();
    expect(await failInputsForDeletedConversation(binding.conversationId)).toBe(2);
    const next = await listInputs();
    for (const row of rows.slice(0, 2)) expect(next.find(value => value.id === row.id)).toMatchObject({ state: 'failed', owner: null, error: 'This chat was deleted in ChatGPT. Start a new chat to continue.' });
    for (const row of rows.slice(2)) expect(next.find(value => value.id === row.id)).toMatchObject({ state: row.state, owner: row.owner });
    expect(await failInputsForDeletedConversation(binding.conversationId)).toBe(0);
  });

  it('keeps authorized Send custody through deletion and accepts its original late ACK', async () => {
    binding.finishEnabled = false;
    const row = await enqueueInput(input());
    await claimBrowserInput(row.id, 'original-page', binding.conversationId, true);
    expect(await authorizeBrowserInput(row.id, 'original-page', binding.conversationId)).toBe(true);
    expect(await failInputsForDeletedConversation(binding.conversationId)).toBe(0);
    expect(await acknowledgeBrowserInput(row.id, 'other-page', binding.conversationId, 'native-message')).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'original-page', binding.conversationId, 'native-message')).toBe(true);
    expect((await listInputs()).find(value => value.id === row.id)).toMatchObject({ state: 'sent', messageId: 'native-message', owner: 'original-page' });
  });

  it.each([false, true])('never reoffers a positive deleted pre-Send failure or retracts an authorized receipt (%s)', async authorized => {
    binding.finishEnabled = false;
    const row = await enqueueInput(input());
    await claimBrowserInput(row.id, 'original-page', binding.conversationId, true);
    if (authorized) expect(await authorizeBrowserInput(row.id, 'original-page', binding.conversationId)).toBe(true);
    expect(await failBrowserInput(row.id, 'original-page', 'This chat was deleted in ChatGPT. Start a new chat to continue.')).toBe(!authorized);
    expect((await listInputs()).find(value => value.id === row.id)?.state).toBe(authorized ? 'browser' : 'failed');
    if (authorized) expect(await acknowledgeBrowserInput(row.id, 'original-page', binding.conversationId, 'late-native-message')).toBe(true);
    else expect(await pendingBrowserInputs()).toEqual([]);
  });

  it('preserves delivered Temporary Chat metadata enrichment after a deletion observation', async () => {
    const id = randomUUID();
    const row: InputEntry = { ...input({ id, sessionId: null }), purpose: 'decision', lifetime: 'temporary-planner', state: 'decision', owner: 'original-helper', createdAt: now, conversationId: null, sendAuthorizedAt: now, deliveredAt: now, messageId: 'native-temporary-user' };
    await writeDurableNow('session-input', [row]); resetInputForTests();
    expect(await failInputsForDeletedConversation(binding.conversationId)).toBe(0);
    // A cold-restored helper is already cancelled by its incumbent owner; deletion must not
    // retract its receipt or revive the private answer waiter while enriching native metadata.
    const retainedState = (await listInputs())[0]!.state;
    expect(await acknowledgeBrowserInput(id, 'original-helper', binding.conversationId, 'native-temporary-user')).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ state: retainedState, conversationId: binding.conversationId, messageId: 'native-temporary-user', deliveredAt: now });
  });

  it.each([false, true])('treats companions as one exact deletion retirement (authorized=%s)', async authorized => {
    const companion: InputEntry = { ...input(), state: 'browser', owner: 'page', requiresAuthorization: true, createdAt: now, conversationId: binding.conversationId,
      ...(authorized ? { sendAuthorizedAt: now } : {}) };
    const root: InputEntry = { ...input(), state: 'browser', owner: 'page', requiresAuthorization: true, createdAt: now, conversationId: binding.conversationId, companionInputId: companion.id };
    await writeDurableNow('session-input', [root, companion]); resetInputForTests();
    expect(await failInputsForDeletedConversation(binding.conversationId)).toBe(authorized ? 0 : 2);
    for (const row of await listInputs()) expect(row.state).toBe(authorized ? 'browser' : 'failed');
  });

  it('does not retire an old destination after its session moved to a successor', async () => {
    const row: InputEntry = { ...input(), state: 'queued', owner: null, createdAt: now, conversationId: 'old-conversation' };
    await writeDurableNow('session-input', [row]); resetInputForTests();
    expect(await failInputsForDeletedConversation('old-conversation')).toBe(0);
    expect((await listInputs())[0]).toMatchObject({ state: 'queued' });
  });

  it('cancels every unfinished delivery and helper owned by a deleted session without touching another session', async () => {
    const queued = await enqueueInput(input({ mode: 'finish', text: 'queued work' }));
    const other = await enqueueInput(input({ sessionId: 'session-two', mode: 'finish', text: 'keep this' }));
    const decision = requestBrowserDecision('planner work', new AbortController().signal, { sourceSessionId: sessionId });
    await vi.waitFor(async () => {
      expect((await listInputs()).some(row => row.purpose === 'decision' && row.decisionSourceSessionId === sessionId)).toBe(true);
    });

    expect(await cancelSessionInputs(sessionId)).toBe(2);
    await expect(decision).rejects.toThrow(/deleted/);
    const rows = await listInputs();
    expect(rows.find(row => row.id === queued.id)?.state).toBe('cancelled');
    expect(rows.find(row => row.purpose === 'decision' && row.decisionSourceSessionId === sessionId)?.state).toBe('cancelled');
    expect(rows.find(row => row.id === other.id)?.state).toBe('queued');
  });

  it('preserves messages beyond the former composer limit through admission, restart and browser claim', async () => {
    binding.finishEnabled = false;
    const text = 'Long user request. '.repeat(2000);
    const row = await enqueueInput(input({ text }));
    resetInputForTests();
    expect((await listInputs())[0]?.text).toBe(text.trim());
    const claim = await claimBrowserInput(row.id, 'page', binding.conversationId);
    assertOperatorPromptEnvelope(claim!.text);
    expect(claim!.deliveryText).toBe(claim!.text);
    expect(operatorPromptBody(claim!.text)).toBe(text.trim());
  });
  it('allows a nickname only on a newly created main chat', async () => {
    await expect(enqueueInput(input({ sessionId: null, nickname: 'Named new chat' })))
      .resolves.toMatchObject({ nickname: 'Named new chat' });
    await expect(enqueueInput(input({ sessionId, nickname: 'Do not rename an existing chat' })))
      .rejects.toThrow('only while creating a new main chat');
  });
  it('edits queued text beyond 16000 characters while retaining the message transport ceiling', async () => {
    const row = await enqueueInput(input({ mode: 'after-turn' }));
    const text = 'x'.repeat(32_000);
    expect(await editQueuedInput(row.id, text)).toBe(true);
    expect((await listInputs())[0]?.text).toBe(text);
    await expect(editQueuedInput(row.id, 'x'.repeat(96_001))).rejects.toThrow();
    expect((await listInputs())[0]?.text).toBe(text);
    expect(inputArgs.safeParse(input({ text: 'x'.repeat(96_001) })).success).toBe(false);
  });
  it('edits an ordinary durable browser message before Chrome claims it', async () => {
    const row = await enqueueInput(input({ mode: 'auto', text: 'Original request' }));
    expect(row).toMatchObject({ state: 'queued', owner: null });
    expect(await editQueuedInput(row.id, 'Revised request')).toBe(true);
    expect((await listInputs()).find(entry => entry.id === row.id)?.text).toBe('Revised request');
  });
  it('keeps fresh-turn input automatic and sends once after Stop, never replacing an ambiguous receipt', async () => {
    binding.model = 'gpt-6-sol'; binding.activeTurnId = 'rotation-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'rotation-turn', time: 900 };
    const row = await fileRotationInput(sessionId, 'rotation-turn');
    expect(row).toMatchObject({ purpose: 'rotation', directTurn: { id: 'rotation-turn' },
      queuedTurn: { conversationId: binding.conversationId, turnId: 'rotation-turn' } });
    expect(userRequestedInput(row!)).toBe(false);
    const claim = await claimBrowserInput(row!.id, 'rotation-page', binding.conversationId, true);
    expect(claim).not.toBeNull();
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'stopped', turnId: 'rotation-turn', time: now + 1 };
    expect(await authorizeBrowserInput(row!.id, 'rotation-page', binding.conversationId)).toBe(true);
    now += BROWSER_RECEIPT_WAIT_MS + 1;
    await listInputs();
    resetInputForTests();
    binding.activeTurnId = 'rotation-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'rotation-turn', time: 900 };
    expect(await fileRotationInput(sessionId, 'rotation-turn')).toBeNull();
  });

  it('bounds fresh-turn filings across restart and preserves a newer explicit instruction', async () => {
    binding.model = 'gpt-6-sol'; binding.activeTurnId = 'rotation-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'rotation-turn', time: 900 };
    const row = await fileRotationInput(sessionId, 'rotation-turn');
    expect(row).not.toBeNull();
    const human = await enqueueInput(input({ text: 'My real new instruction' }));
    expect(human.mode).toBe('auto');
    expect((await listInputs()).find(input => input.id === row!.id)?.state).toBe('cancelled');
    await cancelInput(human.id);
    now += 1;
    const second = await fileRotationInput(sessionId, 'rotation-turn');
    expect(second).not.toBeNull();
    await cancelInput(second!.id);
    resetInputForTests();
    expect(await fileRotationInput(sessionId, 'rotation-turn')).toBeNull();
  });

  it('retains the fresh-turn ceiling when unrelated last-50 history is pruned', async () => {
    binding.model = 'gpt-6-sol'; binding.activeTurnId = 'rotation-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'rotation-turn', time: 900 };
    const first = await fileRotationInput(sessionId, 'rotation-turn');
    await cancelInput(first!.id);
    const second = await fileRotationInput(sessionId, 'rotation-turn');
    await cancelInput(second!.id);
    const attempts = await listInputs();
    await writeDurableNow('session-input', [...attempts, ...Array.from({ length: 60 }, () => ({
      ...input({ sessionId: 'session-two' }), state: 'failed' as const, owner: null,
      createdAt: now, conversationId: 'conversation-b', error: 'Older unrelated diagnostic failure.' }))]);
    resetInputForTests();
    const unrelated = await enqueueInput(input({ sessionId: 'session-two', text: 'A new independent instruction' }));
    const retained = await listInputs();
    expect(retained.map(row => row.id)).toEqual(expect.arrayContaining([first!.id, second!.id]));
    await cancelInput(unrelated.id);
    resetInputForTests();
    expect(await fileRotationInput(sessionId, 'rotation-turn')).toBeNull();
  });

  it.each(['paused', 'blocked', 'signed-out', 'worker', 'helper', 'wrong-turn', 'process-active'] as const)(
    'refuses fresh-turn automation while %s', async hold => {
    binding.model = 'gpt-6-sol'; binding.activeTurnId = 'rotation-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'rotation-turn', time: 900 };
    if (hold === 'paused') binding.automationPaused = true;
    if (hold === 'blocked') binding.blocked = true;
    if (hold === 'signed-out') setBrowserDecisionAuthentication('signed-out');
    if (hold === 'worker' || hold === 'helper') binding.origin = hold;
    if (hold === 'process-active') configureInputDelivery({ applyAutomation: automate, changed, callsHoldRecovery: () => true });
    expect(await fileRotationInput(sessionId, hold === 'wrong-turn' ? 'foreign-turn' : 'rotation-turn')).toBeNull();
  });

  it('sends a tool-free non-Pro correction through one durable browser claim and native receipt', async () => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    binding.lastToolCallAt = 800; // Earlier turns do not change this turn's menu.
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: false, directTurn: { id: 'plain-turn', startedAt: 900 } });
    const direct = await enqueueInput(input());
    expect(direct).toMatchObject({ transportIntent: 'browser', directTurn: { id: 'plain-turn' } });
    expect(await pendingBrowserInputs()).toEqual([expect.objectContaining({ id: direct.id, directTurn: direct.directTurn })]);
    const claim = await claimBrowserInput(direct.id, 'native-page', binding.conversationId, true);
    expect(claim?.directTurn).toEqual(direct.directTurn);
    expect(await offerToolInput(sessionId, binding.conversationId, 'racing-tool', now)).toEqual([]);
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'stopped', turnId: 'plain-turn', time: 1001 };
    expect(await authorizeBrowserInput(direct.id, 'native-page', binding.conversationId)).toBe(true);
    expect(await authorizeBrowserInput(direct.id, 'native-page', binding.conversationId)).toBe(false);
    expect(await acknowledgeBrowserInput(direct.id, 'native-page', binding.conversationId, 'native-message')).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', messageId: 'native-message' });
  });

  it.each(['typed', 'native-busy'] as const)(
    'does not wait out possible-only activity after a confirmed Stop except for an exact live or automatic owner (%s)', async kind => {
      binding.activeTurnId = null;
      binding.end = { kind: 'turn_end', outcome: 'stopped', turnId: 'stopped-turn', time: 950 };
      configureInputDelivery({ applyAutomation: automate, changed,
        activity: () => ({ possible: true, exact: kind === 'native-busy', model: 'other' }) });
      const policy = await sessionInputPolicy(sessionId);
      if (kind === 'native-busy') {
        expect(policy.stoppedIdle).not.toBe(true);
        return;
      }
      if (kind === 'typed') {
        expect(policy.stoppedIdle).toBe(true);
        const row = await enqueueInput(input({ text: 'My instruction after Stop' }));
        expect(await pendingBrowserInputs()).toContainEqual({ id: row.id, conversationId: binding.conversationId });
      }
    });

  it('offers one idle-only browser probe for a never-offered manual correction behind an abandoned tool-free recorder turn', async () => {
    binding.model = 'gpt-6-thinking'; binding.activeTurnId = 'abandoned-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'abandoned-turn', time: 900 };
    let active = true;
    configureInputDelivery({ applyAutomation: automate, changed,
      activity: () => ({ possible: active, exact: active, model: 'unknown' }), callsHoldRecovery: () => false });
    const correction = await enqueueInput(input({ text: 'Reconcile saved effects, then continue useful work.' }));
    expect(correction).toMatchObject({ state: 'queued', owner: null, transportIntent: 'tool' });
    const store = await import('../src/main/session/store.js');
    vi.mocked(store.turnHasMcpCall).mockResolvedValue(false);
    try {
      active = false;
      expect(await pendingBrowserInputs()).toEqual([{ id: correction.id, conversationId: binding.conversationId }]);
      const claimed = await claimBrowserInput(correction.id, 'idle-native-page', binding.conversationId, true);
      expect(claimed).toMatchObject({ id: correction.id, state: 'browser', transportIntent: 'browser' });
      expect(claimed?.directTurn).toBeUndefined(); // Native busy/Stop checks MUST remain mandatory.
      expect(await authorizeBrowserInput(correction.id, 'idle-native-page', binding.conversationId)).toBe(true);
      expect(await authorizeBrowserInput(correction.id, 'idle-native-page', binding.conversationId)).toBe(false);
      expect(binding.activeTurnId).toBe('abandoned-turn'); // No invented terminal receipt.
    } finally { vi.mocked(store.turnHasMcpCall).mockResolvedValue(true); }
  });

  it.each(['completed', 'stalled', 'unknown', 'future-end', 'no-end', 'native-live', 'call-hold', 'pro-model', 'helper'] as const)(
    'offers only an idle inspection for a fresh manual instruction after a proved ended turn (%s)', async condition => {
      binding.model = condition === 'pro-model' ? 'gpt-6-pro' : 'gpt-6-thinking';
      binding.activeTurnId = null;
      binding.end = condition === 'no-end' ? null : { kind: 'turn_end',
        outcome: condition === 'completed' ? 'completed' : condition === 'unknown' ? 'unknown' : 'stalled',
        turnId: 'ended-manual-source', time: condition === 'future-end' ? now + 1 : now - 100 };
      configureInputDelivery({ applyAutomation: automate, changed,
        activity: () => ({ possible: true, exact: condition === 'native-live', model: 'other' }),
        callsHoldRecovery: () => condition === 'call-hold' });
      const row = await enqueueInput(input({ text: 'Inspect the retained original work and continue it.' }));
      if (condition === 'helper') {
        // Generated provenance is broker-owned; ordinary input arguments cannot forge it.
        await writeDurableNow('session-input', [{ ...row, sourceHelperId: randomUUID(), sourceHelperAcceptedAt: now }]);
        resetInputForTests();
      }
      const eligible = condition === 'completed' || condition === 'stalled';
      expect(await pendingBrowserInputs()).toEqual(eligible
        ? [{ id: row.id, conversationId: binding.conversationId }] : []);
      if (!eligible) return;
      const claim = await claimBrowserInput(row.id, 'idle-page', binding.conversationId, true);
      expect(claim).toMatchObject({ id: row.id, requiresAuthorization: true });
      expect(claim?.directTurn).toBeUndefined();
      expect(claim?.sendAuthorizedAt).toBeUndefined();
      expect(await authorizeBrowserInput(row.id, 'idle-page', binding.conversationId)).toBe(true);
      expect(await authorizeBrowserInput(row.id, 'idle-page', binding.conversationId)).toBe(false);
      expect(await acknowledgeBrowserInput(row.id, 'idle-page', binding.conversationId, 'new-native-user')).toBe(true);
      expect(binding.activeTurnId).toBeNull();
      expect(binding.end?.turnId).toBe('ended-manual-source');
    }
  );

  it.each([1, 2] as const)(
    'rechecks an ended manual idle probe after async native scope verification %s', async scopePass => {
      binding.model = 'gpt-6-thinking'; binding.activeTurnId = null;
      binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'original-ended-source', time: now - 100 };
      let nativeLive = false;
      const activity = () => ({ possible: true, exact: nativeLive, model: 'other' as const });
      configureInputDelivery({ applyAutomation: automate, changed, activity, callsHoldRecovery: () => false });
      const row = await enqueueInput(input({ text: 'Inspect the retained original work and continue it.' }));
      expect(await claimBrowserInput(row.id, 'idle-probe-page', binding.conversationId, true))
        .toMatchObject({ id: row.id, requiresAuthorization: true, state: 'browser' });

      let entered!: () => void;
      let release!: () => void;
      const verifying = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      let passes = 0;
      configureInputDelivery({ applyAutomation: automate, changed, activity, callsHoldRecovery: () => false,
        beforeAuthorizeNativeScope: async () => {
          if (++passes === scopePass) { entered(); await gate; }
          return true;
        } });
      const authorization = authorizeBrowserInput(row.id, 'idle-probe-page', binding.conversationId);
      await verifying;
      // Provider ingestion is independent of Input's serializer. A fresh native turn can
      // arrive while task-version verification awaits history; the original page is busy.
      now += 1;
      binding.activeTurnId = 'new-native-turn';
      binding.end = { kind: 'turn_start', outcome: '', turnId: 'new-native-turn', time: now };
      nativeLive = true;
      release();
      expect(await authorization).toBe(false);
      const retained = (await listInputs()).find(entry => entry.id === row.id)!;
      expect(retained).toMatchObject({ state: 'browser', owner: 'idle-probe-page' });
      expect(retained.sendAuthorizedAt).toBeUndefined();
      expect(retained.messageId).toBeUndefined();
      expect(await offerToolInput(sessionId, binding.conversationId, 'new-native-call', now)).toEqual([]);
    }
  );

  it.each(['matching-watchdog', 'missing-fault', 'wrong-turn', 'future-fault', 'live-native', 'pro-generation'] as const)(
    'requires exact watchdog custody before probing an old possible-activity grant (%s)', async condition => {
      binding.model = 'gpt-6-thinking'; binding.activeTurnId = 'abandoned-turn';
      binding.end = { kind: 'turn_start', outcome: '', turnId: 'abandoned-turn', time: 900 };
      let possibleOnly = false;
      configureInputDelivery({ applyAutomation: automate, changed,
        activity: () => ({ possible: true, exact: !possibleOnly,
          model: possibleOnly && condition === 'pro-generation' ? 'pro' : 'unknown' }),
        callsHoldRecovery: () => false });
      const correction = await enqueueInput(input({ text: 'Reconcile the interrupted work before continuing.' }));
      expect(correction.transportIntent).toBe('tool');
      possibleOnly = condition !== 'live-native';
      vi.mocked(readRecentEvents).mockImplementation(async (_id, _limit, query) =>
        query?.kinds?.includes('chat_error')
          ? condition === 'missing-fault' ? [] : [{ kind: 'chat_error', reason: 'watchdog_stalled',
            turnId: condition === 'wrong-turn' ? 'foreign-turn' : 'abandoned-turn',
            time: condition === 'future-fault' ? now + 1 : 950 } as never]
          : binding.end ? [binding.end as never] : []);
      vi.mocked(turnHasMcpCall).mockResolvedValue(false);
      try {
        const pending = await pendingBrowserInputs();
        expect(pending).toEqual(condition === 'matching-watchdog'
          ? [{ id: correction.id, conversationId: binding.conversationId }] : []);
        if (condition === 'matching-watchdog') {
          const claim = await claimBrowserInput(correction.id, 'idle-inspection', binding.conversationId, true);
          expect(claim).toMatchObject({ id: correction.id, requiresAuthorization: true });
          expect(claim?.directTurn).toBeUndefined();
          expect(claim?.sendAuthorizedAt).toBeUndefined();
          expect(binding.activeTurnId).toBe('abandoned-turn');
        }
      } finally { vi.mocked(turnHasMcpCall).mockResolvedValue(true); }
    });

  it.each(['mcp-history', 'live-work', 'live-call', 'pro-model', 'offered', 'authorized', 'attention', 'stages', 'turn-changed'] as const)(
    'keeps abandoned-turn manual browser probing fenced for %s', async condition => {
      binding.model = 'gpt-6-thinking'; binding.activeTurnId = 'abandoned-turn';
      binding.end = { kind: 'turn_start', outcome: '', turnId: 'abandoned-turn', time: 900 };
      let active = true;
      configureInputDelivery({ applyAutomation: automate, changed,
        activity: () => ({ possible: active, exact: active, model: 'unknown' }),
        callsHoldRecovery: () => condition === 'live-call' });
      const correction = await enqueueInput(input({ ...(condition === 'stages' ? { stages: ['Later stage'] } : {}) }));
      const saved = condition === 'offered' ? { ...correction, offeredAt: now }
        : condition === 'authorized' ? { ...correction, sendAuthorizedAt: now }
        : condition === 'attention' ? { ...correction, deliveryAttentionAt: now } : correction;
      if (saved !== correction) { await writeDurableNow('session-input', [saved]); resetInputForTests(); }
      active = condition === 'live-work';
      if (condition === 'pro-model') binding.model = 'gpt-6-pro';
      const store = await import('../src/main/session/store.js');
      vi.mocked(store.turnHasMcpCall).mockImplementation(async () => {
        if (condition === 'turn-changed') binding.activeTurnId = 'new-turn';
        return condition === 'mcp-history';
      });
      try {
        expect(await pendingBrowserInputs()).toEqual([]);
        expect(await claimBrowserInput(correction.id, 'idle-native-page', binding.conversationId, true)).toBeNull();
      } finally { vi.mocked(store.turnHasMcpCall).mockResolvedValue(true); }
    });

  it.each(['gpt-5-pro', 'gpt-5.6-pro', 'gpt-6-astra', 'gpt-6-pro'])('keeps %s on MCP injection before its first call', async model => {
    binding.model = model; binding.activeTurnId = 'pro-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'pro-turn', time: 900 };
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: true, directTurn: null });
    expect(await enqueueInput(input())).toMatchObject({ transportIntent: 'tool' });
    expect(await pendingBrowserInputs()).toEqual([]);
  });

  it('releases an untouched manual tool-intent row after its exact source turn durably stalls idle', async () => {
    binding.model = 'gpt-6-pro'; binding.activeTurnId = 'stalled-pro-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'stalled-pro-turn', time: 900 };
    let active = true;
    configureInputDelivery({ applyAutomation: automate, changed,
      activity: () => ({ possible: active, exact: active, turnId: 'stalled-pro-turn', model: 'pro' }) });
    const correction = await enqueueInput(input({ text: 'Continue the exact cleanup after this failed turn', automation: 'goal' }));
    expect(correction).toMatchObject({ state: 'queued', owner: null, transportIntent: 'tool' });
    expect(await pendingBrowserInputs()).toEqual([]);

    binding.activeTurnId = null;
    binding.lastToolCallAt = now;
    active = false;
    now += 10;
    binding.end = { kind: 'turn_end', outcome: 'stalled', turnId: 'stalled-pro-turn', time: now, seq: 12 };
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ browserAllowed: true, settled: false });
    expect(await pendingBrowserInputs()).toEqual([{ id: correction.id, conversationId: binding.conversationId }]);
    expect(await claimBrowserInput(correction.id, 'recovered-page', binding.conversationId, true))
      .toMatchObject({ id: correction.id, state: 'browser', owner: 'recovered-page', transportIntent: 'browser' });
  });

  it.each(['live-tool', 'post-send-ambiguous', 'attention', 'staged', 'older-stall'] as const)(
    'keeps stalled tool fallback fenced for %s evidence', async state => {
      binding.model = 'gpt-6-pro'; binding.activeTurnId = 'stalled-pro-turn';
      binding.end = { kind: 'turn_start', outcome: '', turnId: 'stalled-pro-turn', time: 900 };
      let activity = true;
      configureInputDelivery({ applyAutomation: automate, changed,
        activity: () => ({ possible: activity, exact: activity, turnId: 'stalled-pro-turn', model: 'pro' }),
        callsHoldRecovery: () => state === 'live-tool' });
      const correction = await enqueueInput(input({ text: 'Preserve this exact correction',
        ...(state === 'staged' ? { stages: ['A later authored stage'] } : {}) }));
      const saved = state === 'post-send-ambiguous'
        ? { ...correction, sendAuthorizedAt: now, requiresAuthorization: true }
        : state === 'attention'
          ? { ...correction, deliveryAttentionAt: now, error: 'Needs attention: exact delivery state is unresolved.' }
          : correction;
      if (saved !== correction) {
        await writeDurableNow('session-input', [saved]);
        resetInputForTests();
      }
      binding.activeTurnId = null;
      binding.lastToolCallAt = now;
      activity = false;
      now += 10;
      binding.end = { kind: 'turn_end', outcome: 'stalled', turnId: 'stalled-pro-turn',
        time: state === 'older-stall' ? correction.createdAt - 1 : now, seq: 12 };
      expect(await pendingBrowserInputs()).toEqual([]);
      expect(await claimBrowserInput(correction.id, 'wrong-page', binding.conversationId, true)).toBeNull();
    });

  it.each(['pro', 'unknown'] as const)('does not interrupt %s turn ownership after the picker changes to Sol', async model => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'original-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'original-turn', time: 900 };
    expect(await sessionInputPolicy(sessionId, { exact: true, possible: true, model })).toMatchObject({ canInject: true, directTurn: null });
  });

  it.each([false, true])('keeps non-Pro text native after an early turn_end with retained exact MCP activity (recorder active=%s)', async recorderActive => {
    binding.model = 'gpt-6-thinking'; binding.finishEnabled = false;
    binding.activeTurnId = recorderActive ? 'retained-native-turn' : null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'retained-native-turn', time: 900 };
    let active = true;
    configureInputDelivery({ applyAutomation: automate, changed,
      activity: () => ({ possible: active, exact: active, turnId: 'retained-native-turn', model: 'other' }) });
    const context: CallContext = { startedAt: 950, transportKey: null, agent: null, outcome: null,
      caller: { conversationId: binding.conversationId, requestId: 'retained-native-call', transportKey: null }, evidence: emptyEvidence() };
    let correction!: InputEntry;
    await trackInFlight(context, async () => {
      correction = await enqueueInput(input({ text: 'Preserve this exact human correction for native Send' }));
      expect(await offerToolInput(sessionId, binding.conversationId, 'retained-native-call', now)).toEqual([]);
      expect(correction.transportIntent).not.toBe('tool');
      expect(correction.directTurn).toBeUndefined();
      expect(await pendingBrowserInputs()).toEqual([]);
      expect((await listInputs()).find(row => row.id === correction.id)).toMatchObject({
        state: 'queued', owner: null, text: correction.text
      });
      expect((await listInputs()).find(row => row.id === correction.id)?.offeredAt).toBeUndefined();
    });
    binding.activeTurnId = null; active = false;
    expect(await pendingBrowserInputs()).toEqual([{ id: correction.id, conversationId: binding.conversationId }]);
    const claim = await claimBrowserInput(correction.id, 'same-native-page', binding.conversationId, true);
    expect(claim).toMatchObject({ id: correction.id });
    expect(operatorPromptBody(claim!.text)).toBe(correction.text);
    expect(await authorizeBrowserInput(correction.id, 'same-native-page', binding.conversationId)).toBe(true);
    expect(await acknowledgeBrowserInput(correction.id, 'same-native-page', binding.conversationId, 'native-human-correction')).toBe(true);
    expect(await offerToolInput(sessionId, binding.conversationId, 'later-native-call', now + 1)).toEqual([]);
    expect(await listInputs()).toEqual([expect.objectContaining({ id: correction.id, state: 'sent',
      messageId: 'native-human-correction', deliveredAt: now })]);
  });

  it('keeps an Auto staged workflow on its intended tool route after non-Pro turn_end', async () => {
    binding.model = 'gpt-6-thinking'; binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'retained-workflow-turn', time: 900 };
    configureInputDelivery({ applyAutomation: automate, changed,
      activity: () => ({ possible: true, exact: true, turnId: 'retained-workflow-turn', model: 'other' }) });
    const stages = ['Exercise the complete workflow', 'Verify final acceptance'];
    const workflow = await enqueueInput(input({ text: 'Implement the full requested workflow', stages }));
    expect(workflow).toMatchObject({ state: 'queued', transportIntent: 'tool', stages });
    expect(await pendingBrowserInputs()).toEqual([]);
    const offered = await offerToolInput(sessionId, binding.conversationId, 'workflow-tool-owner', 950);
    expect(offered).toHaveLength(1);
    for (const text of [workflow.text, ...stages]) expect(offered[0]?.text).toContain(text);
    expect((await listInputs()).find(row => row.id === workflow.id)).toMatchObject({ state: 'tool',
      owner: 'workflow-tool-owner', offeredAt: now, stages });
    expect(await offerToolInput(sessionId, binding.conversationId, 'workflow-tool-owner', 950)).toEqual(offered);
    expect(await claimBrowserInput(workflow.id, 'competing-workflow-page', binding.conversationId, true)).toBeNull();
    now += 1;
    await acknowledgeToolInput(sessionId, binding.conversationId, 'workflow-later-call', now);
    const completed = await listInputs();
    expect(completed.find(row => row.id === workflow.id)).toMatchObject({ state: 'sent', stagesApplied: true,
      owner: 'workflow-tool-owner', messageId: `input:${workflow.id}` });
    const checkpoints = completed.filter(row => row.id !== workflow.id);
    expect(checkpoints.map(row => row.text)).toEqual(stages);
    expect(checkpoints.every(row => row.state === 'queued' && row.mode === 'finish')).toBe(true);
    await acknowledgeToolInput(sessionId, binding.conversationId, 'workflow-another-call', now + 1);
    expect((await listInputs()).map(row => row.id)).toEqual(completed.map(row => row.id));
  });

  it.each(['pro', 'unknown'] as const)('keeps the original %s MCP owner after early turn_end and a non-Pro picker change', async model => {
    binding.model = 'gpt-6-thinking'; binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'original-mcp-turn', time: 900 };
    configureInputDelivery({ applyAutomation: automate, changed,
      activity: () => ({ possible: true, exact: true, turnId: 'original-mcp-turn', model }) });
    const correction = await enqueueInput(input({ text: 'Keep the original generation tool custody' }));
    expect(correction.transportIntent).toBe('tool');
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'original-mcp-call', now)).toEqual([
      { text: correction.text, images: [] }
    ]);
    expect((await listInputs()).find(row => row.id === correction.id)).toMatchObject({ state: 'tool', owner: 'original-mcp-call' });
  });

  it('preserves an already-offered tool correction when the picker later becomes non-Pro', async () => {
    binding.model = 'gpt-6-pro'; binding.activeTurnId = 'offered-pro-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'offered-pro-turn', time: 900 };
    const correction = await enqueueInput(input({ text: 'Retain the existing tool offer and receipt' }));
    const offered = await offerToolInput(sessionId, binding.conversationId, 'original-offer', 950);
    expect(offered).toEqual([{ text: correction.text, images: [] }]);
    binding.model = 'gpt-6-thinking'; binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'offered-pro-turn', time: now };
    configureInputDelivery({ applyAutomation: automate, changed,
      activity: () => ({ possible: true, exact: true, turnId: 'offered-pro-turn', model: 'other' }) });
    expect(await offerToolInput(sessionId, binding.conversationId, 'original-offer', 950)).toEqual(offered);
    expect(await claimBrowserInput(correction.id, 'competing-native-page', binding.conversationId, true)).toBeNull();
    now += 1;
    expect(await offerToolInput(sessionId, binding.conversationId, 'later-tool-receipt', now)).toEqual([]);
    expect((await listInputs()).find(row => row.id === correction.id)).toMatchObject({ state: 'sent',
      owner: 'original-offer', messageId: `input:${correction.id}`, text: correction.text });
  });

  it.each(['turn', 'rebind', 'blocked'])('revokes an unsubmitted direct correction after %s changes', async change => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    const direct = await enqueueInput(input());
    await claimBrowserInput(direct.id, 'native-page', binding.conversationId, true);
    if (change === 'turn') { binding.activeTurnId = 'new-turn'; binding.end = { ...binding.end, turnId: 'new-turn', time: 1001 }; }
    if (change === 'rebind') binding.conversationId = 'conversation-b';
    if (change === 'blocked') binding.blocked = true;
    expect(await authorizeBrowserInput(direct.id, 'native-page', 'conversation-a')).toBe(false);
  });

  it('keeps non-Pro corrections native through running and completed MCP calls without duplicate tool injection', async () => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    const context: CallContext = { startedAt: 950, transportKey: null, agent: null, outcome: null,
      caller: { conversationId: binding.conversationId, requestId: 'first-call', transportKey: null }, evidence: emptyEvidence() };
    await trackInFlight(context, async () => {
      expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: false, directTurn: { id: 'plain-turn' } });
      binding.lastToolCallAt = 950;
      const direct = await enqueueInput(input());
      expect(direct).toMatchObject({ transportIntent: 'browser', directTurn: { id: 'plain-turn' } });
      expect(await offerToolInput(sessionId, binding.conversationId, 'first-call', now)).toEqual([]);
      const claim = await claimBrowserInput(direct.id, 'native-page', binding.conversationId, true);
      expect(claim?.directTurn?.id).toBe('plain-turn');
      expect(await authorizeBrowserInput(direct.id, 'native-page', binding.conversationId)).toBe(true);
      expect(await acknowledgeBrowserInput(direct.id, 'native-page', binding.conversationId, 'native-message')).toBe(true);
    });
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: false, directTurn: { id: 'plain-turn' } });
    binding.activeTurnId = 'next-turn'; binding.end = { ...binding.end, turnId: 'next-turn', time: 1001 };
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: false, directTurn: { id: 'next-turn' } });
    const after = await enqueueInput(input({ mode: 'after-turn' }));
    expect(after.directTurn).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'later-tool', now)).toEqual([]);
  });

  it('acknowledges prior tool delivery at call ingress without consuming the next queued stage', async () => {
    const previous = await enqueueInput(input({ text: 'Already delivered' }));
    await offerToolInput(sessionId, binding.conversationId, 'same-server-request', now);
    const nextStage = await enqueueInput(input({ text: 'Still queued', mode: 'finish' }));
    await acknowledgeToolInput(sessionId, binding.conversationId, 'same-server-request', now);
    expect((await listInputs()).find(row => row.id === previous.id)?.state).toBe('tool');
    now += 1;
    await acknowledgeToolInput(sessionId, 'different-conversation', 'same-server-request', now);
    expect((await listInputs()).find(row => row.id === previous.id)?.state).toBe('tool');
    await acknowledgeToolInput(sessionId, binding.conversationId, 'same-server-request', now);
    const rows = await listInputs();
    expect(rows.find(row => row.id === previous.id)).toMatchObject({ state: 'sent', messageId: `input:${previous.id}` });
    expect(rows.find(row => row.id === nextStage.id)?.state).toBe('queued');
    expect(await hasEligibleToolInput(sessionId)).toBe(false);
    expect(await hasEligibleToolInput(sessionId, true)).toBe(true);
  });

  it.each([3, 5])('adds the configured %s-minute reminder once per delivery, preserving each authored message and staged boundary', async lead => {
    binding.leadMinutes = lead;
    const direct = await enqueueInput(input({ text: 'Check the new requirement' }));
    const stage = await enqueueInput(input({ text: 'Verify the next stage', mode: 'finish' }));
    const first = await offerToolInputBatch(sessionId, binding.conversationId, 'ordinary-tool', now, true);
    expect(semanticMessages(first.messages)).toEqual([{ text: direct.text, images: [] }]);
    expect(first.reminder).toContain(`about ${lead} minutes of final verification remain`);
    expect(first.reminder).toContain('only when the requested implementation is complete');
    expect(first.reminder).toContain('New instructions extend the work; they do not require another finish call');
    now += 1;
    const second = await offerToolInputBatch(sessionId, binding.conversationId, 'finish-tool', now, true);
    expect(semanticMessages(second.messages)).toEqual([{ text: stage.text, images: [] }]);
    expect(second.reminder).toContain(`about ${lead} minutes of final verification remain`);
    expect(second.reminder.match(/Use session_finish/g)).toHaveLength(1);
    const rows = await listInputs();
    expect(rows.find(row => row.id === direct.id)?.text).toBe('Check the new requirement');
    expect(rows.find(row => row.id === stage.id)?.text).toBe('Verify the next stage');
    expect(operatorPromptBody(rows.find(row => row.id === stage.id)!.deliveryText!)).toBe('Verify the next stage');
  });
  it.each(['other-model', 'disabled', 'released', 'helper', 'worker'])('does not add an Astra finish reminder when %s', async condition => {
    if (condition === 'other-model') binding.model = 'gpt-5.6-sol';
    if (condition === 'disabled') binding.finishEnabled = false;
    if (condition === 'released') binding.finishReleased = true;
    if (condition === 'helper' || condition === 'worker') binding.origin = condition;
    const row = await enqueueInput(input());
    const result = await offerToolInputBatch(sessionId, binding.conversationId, 'ordinary-tool', now, true);
    if (condition === 'other-model') {
      expect(result.messages).toEqual([]);
      expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'queued', owner: null });
      expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: binding.conversationId }]);
      expect(await claimBrowserInput(row.id, 'ordinary-native-page', binding.conversationId, true)).toMatchObject({ id: row.id });
      expect(await authorizeBrowserInput(row.id, 'ordinary-native-page', binding.conversationId)).toBe(true);
      expect(await acknowledgeBrowserInput(row.id, 'ordinary-native-page', binding.conversationId, 'ordinary-native-receipt')).toBe(true);
      expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', messageId: 'ordinary-native-receipt' });
    } else expect(result.messages).toHaveLength(1);
    expect(result.reminder).toBe('');
  });

  it('supersedes only the receiving session Goal and preserves another session queued Goal across restart', async () => {
    binding.activeTurnId = 'turn-one';
    const otherGoal = await enqueueInput(input({ text: 'Goal A' }), { turnId: 'turn-one', periodic: false });
    const ownGoal = await enqueueInput(input({ sessionId: 'session-two', text: 'Goal B' }), { turnId: 'turn-one', periodic: false });
    const ownInput = await enqueueInput(input({ sessionId: 'session-two', text: 'Correction for B' }));
    resetInputForTests();
    const rows = await listInputs();
    expect(rows.find(row => row.id === otherGoal.id)).toMatchObject({ state: 'queued', sessionId, conversationId: 'conversation-a' });
    expect(rows.find(row => row.id === ownGoal.id)?.state).toBe('cancelled');
    expect(rows.find(row => row.id === ownInput.id)).toMatchObject({ state: 'queued', sessionId: 'session-two', conversationId: 'conversation-b' });
    expect(await enqueueInput(input({ sessionId: 'session-two', text: 'Another direct instruction' }))).toMatchObject({ state: 'queued' });
  });
  it.each([[sessionId, 60000], ['session-two', 60000], ['session-two', 0]] as const)('does not let unrelated or future input in %s at +%s ms block a completed plan stage', async (scheduledSession, delay) => {
    const stage = await enqueueInput(input({ mode: 'finish', text: 'Next stage A', afterTurn: true }));
    await enqueueInput(input({ sessionId: scheduledSession, dueAt: now + delay, text: 'Later input' }));
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'completed-a', time: now + 1 };
    expect(await pendingBrowserInputs()).toContainEqual({ id: stage.id, conversationId: 'conversation-a' });
  });
  it('keeps due direct input ahead of the same session completed plan stage', async () => {
    const stage = await enqueueInput(input({ mode: 'finish' }));
    const direct = await enqueueInput(input({ text: 'Do this first' }));
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'completed-a', time: now + 1 };
    const pending = await pendingBrowserInputs();
    expect(pending.some(row => row.id === stage.id)).toBe(false);
    expect(pending.some(row => row.id === direct.id)).toBe(true);
  });

  it('delivers one manual input before staged work and preserves the next stage for a later poll', async () => {
    const stage = await enqueueInput(input({ text: 'Stage one', mode: 'finish' }));
    await enqueueInput(input({ text: 'Stage two', mode: 'finish' }));
    await enqueueInput(input({ text: 'Manual correction' }));
    expect((await offerToolInput(sessionId, binding.conversationId, 'poll', now, true))[0]?.text).toContain('Manual correction');
    now += 1;
    const next = await offerToolInput(sessionId, binding.conversationId, 'poll', now, true);
    expect(next).toHaveLength(1);
    expect(next[0]?.text).toBe(stage.text);
    now += 1;
    const last = await offerToolInput(sessionId, binding.conversationId, 'poll', now, true);
    expect(last).toHaveLength(1);
    expect(last[0]?.text).toContain('Stage two');
  });
  it('keeps an automatic Goal for a call started after its enqueue', async () => {
    binding.activeTurnId = 'turn-one';
    await enqueueInput(input(), { turnId: 'turn-one', periodic: false });
    expect(await offerToolInput(sessionId, binding.conversationId, 'running-call', now, true)).toEqual([]);
    now += 1;
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-call', now, true)).toHaveLength(1);
  });

  it.each([false, true])('prioritizes new user input while preserving generated post-wire receipts: offered=%s', async offered => {
    binding.activeTurnId = 'turn-one'; binding.impulseMinutes = 3;
    const generated = await enqueueInput(input({ text: 'Generated instruction' }), { turnId: 'turn-one', periodic: false });
    if (offered) now += 1;
    if (offered) await offerToolInput(sessionId, binding.conversationId, 'first-request', now);
    const user = await enqueueInput(input({ text: 'My newer instruction' }));
    const rows = await listInputs();
    expect(rows.find(row => row.id === generated.id)?.state).toBe(offered ? 'tool' : 'cancelled');
    expect(rows.find(row => row.id === user.id)?.state).toBe('queued');
    now += 100;
    const result = await offerToolInput(sessionId, binding.conversationId, 'next-request', now);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toContain('My newer instruction');
    expect(result[0]!.text).not.toContain('Generated instruction');
  });
  it.each(['queued', 'tool'] as const)('cancels persisted obsolete periodic %s rows even with the old setting enabled', async state => {
    binding.activeTurnId = 'turn-one'; binding.impulseMinutes = 3;
    const row: InputEntry = { ...input(), state, owner: state === 'tool' ? 'old-request' : null,
      createdAt: now, conversationId: binding.conversationId,
      ...(state === 'tool' ? { offeredAt: now } : {}), finishOwner: { turnId: 'turn-one', periodic: true } };
    await writeDurableNow('session-input', [row]); resetInputForTests();
    expect(await offerToolInput(sessionId, binding.conversationId, 'later-request', now + 1, true)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input(), { turnId: 'turn-one', periodic: true })).rejects.toThrow('no longer belongs');
  });
  it.each(['end', 'next-turn', 'hold-off'] as const)('does not deliver a queued finish instruction after %s, including restart', async change => {
    binding.activeTurnId = 'turn-one';
    const row = await enqueueInput(input({ text: 'Check the remaining issue' }), { turnId: 'turn-one', periodic: false });
    if (change === 'end') binding.finishReleased = true;
    if (change === 'next-turn') binding.activeTurnId = 'turn-two';
    if (change === 'hold-off') binding.finishEnabled = false;
    resetInputForTests();
    expect(await offerToolInput(sessionId, binding.conversationId, 'new-request', now + 1)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    expect(await pendingBrowserInputs()).toEqual([]);
  });  it('delivers a generated finish instruction through the existing exact tool receipt once', async () => {
    binding.activeTurnId = 'turn-one';
    const row = await enqueueInput(input({ text: 'Finish the validation' }), { turnId: 'turn-one', periodic: false });
    expect(await offerToolInput(sessionId, binding.conversationId, 'first-request', now + 1, true)).toHaveLength(1);
    now += 100;
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-request', now, true)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('sent');
  });
  it('offers and claims an ordinary follow-up after the recorded turn already completed', async () => {
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'completed-greeting', time: now };
    now += 69000;
    const row = await enqueueInput(input({ text: 'Read one file', dueAt: now }));
    // offeredAt is claim metadata, not proof that /status has published the offer.
    expect(row.offeredAt).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: binding.conversationId }]);
    const claim = await claimBrowserInput(row.id, 'exact-browser-document', binding.conversationId, true);
    expect(claim).toMatchObject({ state: 'browser', owner: 'exact-browser-document', offeredAt: now });
  });

  it('keeps an explicit after-turn ticket waiting on old history while Auto can resume the idle chat', async () => {
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'old-completion', time: now - 69000 };
    // No current activity is not a new completion receipt. The same app policy
    // chooses Auto's safe route without minting an after-turn queue ticket.
    configureInputDelivery({ applyAutomation: automate, changed,
      activity: () => ({ possible: false, exact: false }) });
    const after = await enqueueInput(input({ mode: 'after-turn' }));
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(after.id, 'idle-page', binding.conversationId, true)).toBeNull();
    expect((await listInputs()).find(row => row.id === after.id)).toMatchObject({ state: 'queued', owner: null });
    await cancelInput(after.id);
    const ordinary = await enqueueInput(input());
    expect(await pendingBrowserInputs()).toEqual([{ id: ordinary.id, conversationId: binding.conversationId }]);
    expect(await claimBrowserInput(ordinary.id, 'idle-page', binding.conversationId, true)).toMatchObject({ id: ordinary.id });
    // New native work between claim and irreversible authorization still wins.
    binding.activeTurnId = 'new-work';
    binding.end = { kind: 'turn_start', outcome: 'unknown', turnId: 'new-work', time: now + 1 };
    expect(await authorizeBrowserInput(ordinary.id, 'idle-page', binding.conversationId)).toBe(false);
    expect((await listInputs()).find(row => row.id === ordinary.id)?.sendAuthorizedAt).toBeUndefined();
  });

  it('persists reordered finish tasks and uses that order at the tool boundary', async () => {
    const a = await enqueueInput(input({ mode: 'finish', text: 'A' }));
    const b = await enqueueInput(input({ mode: 'finish', text: 'B' }));
    expect(await reorderQueuedInputs(sessionId, [b.id, a.id])).toBe(true);
    resetInputForTests();
    expect((await listInputs()).map(row => row.text)).toEqual(['B', 'A']);
    await enqueueInput(input({ mode: 'finish', text: 'C' }));
    expect((await listInputs()).map(row => row.text)).toEqual(['B', 'A', 'C']);
    const delivered = await offerToolInput(sessionId, binding.conversationId, 'request', now, true);
    expect(delivered.map(row => row.text).join(' ')).toContain('B');
    expect(delivered.map(row => row.text).join(' ')).not.toContain('A');
    expect(await reorderQueuedInputs(sessionId, [a.id, b.id])).toBe(false);
  });
  it('rejects stale, duplicate and cross-session reorder snapshots without altering the queue', async () => {
    const a = await enqueueInput(input({ mode: 'finish', text: 'A' }));
    const b = await enqueueInput(input({ mode: 'finish', text: 'B' }));
    expect(await reorderQueuedInputs(sessionId, [a.id])).toBe(false);
    expect(await reorderQueuedInputs(sessionId, [a.id, a.id])).toBe(false);
    expect(await reorderQueuedInputs('other-session', [b.id, a.id])).toBe(false);
    expect((await listInputs()).map(row => row.id)).toEqual([a.id, b.id]);
  });
  it('stamps only proven desktop-created chats and restores that origin from the retained receipt', async () => {
    const row = await enqueueInput(input({ sessionId: null, nickname: 'MMA Cage Removal' }));
    await claimBrowserInput(row.id, 'page', null);
    expect(noteChatOrigin).not.toHaveBeenCalled();
    await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-user');
    expect(noteChatOrigin).toHaveBeenCalledWith(binding.conversationId, {
      kind: 'desktop', fromSessionId: null, agentId: null, task: '', nickname: 'MMA Cage Removal'
    });
    vi.mocked(noteChatOrigin).mockClear();
    resetInputForTests(); await listInputs();
    expect(noteChatOrigin).toHaveBeenCalledWith(binding.conversationId, expect.objectContaining({
      kind: 'desktop', nickname: 'MMA Cage Removal'
    }));
    vi.mocked(noteChatOrigin).mockClear();
    const existing = await enqueueInput(input());
    await claimBrowserInput(existing.id, 'existing', binding.conversationId);
    await acknowledgeBrowserInput(existing.id, 'existing', binding.conversationId, 'followup');
    expect(noteChatOrigin).not.toHaveBeenCalled();
  });
  it('retries preparation through existing offers but grants native Send only once to the current owner', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'lost-response-page', null, true);
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: null }]);
    expect(await claimBrowserInput(row.id, 'replacement-page', null, true)).toMatchObject({ id: row.id, owner: 'replacement-page' });
    expect(await authorizeBrowserInput(row.id, 'lost-response-page', null)).toBe(false);
    expect(await authorizeBrowserInput(row.id, 'replacement-page', null)).toBe(true);
    expect(await authorizeBrowserInput(row.id, 'replacement-page', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'late-page', null, true)).toBeNull();
    now += 45000;
    // An authorized Send retains exact custody while native identity is still pending.
    expect((await listInputs())[0]).toMatchObject({ state: 'browser', owner: 'replacement-page' });
    expect(await claimBrowserInput(row.id, 'late-page', null, true)).toBeNull();
    const queued = await enqueueInput(input());
    expect(queued).toMatchObject({ state: 'queued', queuedBehindBrowser: true });
    expect(await acknowledgeBrowserInput(row.id, 'replacement-page', binding.conversationId, 'late-native')).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', messageId: 'late-native' });
    await expect(enqueueInput(input())).resolves.toMatchObject({ state: 'queued' });
  });
  it('does not replay a retained transcript just to restore an origin already present in the catalog', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'page', null);
    await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-user');
    vi.mocked(noteChatOrigin).mockClear();
    vi.mocked(listUsageSessions).mockResolvedValueOnce([{ id: sessionId, conversationId: binding.conversationId, origin: { kind: 'desktop' } }] as never);
    resetInputForTests(); await listInputs();
    expect(noteChatOrigin).not.toHaveBeenCalled();
    // Two current records are not one proven stamped origin; preserve ordinary repair.
    vi.mocked(listUsageSessions).mockResolvedValueOnce([{ id: sessionId, conversationId: binding.conversationId, origin: { kind: 'desktop' } }, { id: 'session-two', conversationId: binding.conversationId, origin: null }] as never);
    resetInputForTests(); await listInputs();
    expect(noteChatOrigin).toHaveBeenCalledWith(binding.conversationId, expect.objectContaining({ kind: 'desktop' }));
  });
  it('expires pre-send preparation without images within one minute and revokes a late document', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'page', null, true);
    now += 60000;
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', error: expect.stringContaining('Not sent') });
    expect(await authorizeBrowserInput(row.id, 'page', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input())).resolves.toMatchObject({ state: 'queued' });
  });
  it('does not turn a cancelled pre-Send browser preparation into delivered custody through a late same-owner ACK after restart', async () => {
    const row = await enqueueInput(input({ sessionId: null, automation: 'loop', objective: 'Preserve the original Loop.' }));
    expect(await claimBrowserInput(row.id, 'original-page', null, true)).not.toBeNull();
    now += 60_001;
    const expired = (await listInputs()).find(entry => entry.id === row.id)!;
    expect(expired).toMatchObject({ state: 'cancelled', owner: 'original-page',
      error: expect.stringContaining('Not sent: browser preparation timed out') });
    expect(expired.sendAuthorizedAt).toBeUndefined();
    expect(expired.deliveredAt).toBeUndefined();

    // A stale/reconnected page still knows the right UUID and owner, but those
    // fields identify a PRE-Send claim, not native Send permission or evidence.
    expect(await acknowledgeBrowserInput(row.id, 'original-page', binding.conversationId, 'stale-native-id')).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'original-page', binding.conversationId)).toBe(false);
    expect((await listInputs()).find(entry => entry.id === row.id))
      .toMatchObject({ state: 'cancelled', owner: 'original-page' });
    expect((await listInputs()).find(entry => entry.id === row.id)?.deliveredAt).toBeUndefined();
    expect(automate).not.toHaveBeenCalled();

    resetInputForTests();
    expect(await acknowledgeBrowserInput(row.id, 'original-page', binding.conversationId, 'stale-after-restart')).toBe(false);
    const retained = (await listInputs()).find(entry => entry.id === row.id)!;
    expect(retained.deliveredAt).toBeUndefined();
    expect(retained.messageId).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input({ sessionId: null, text: 'New separately authorized work' })))
      .resolves.toMatchObject({ state: 'queued' });
  });
  it('retains a timed-out pre-Send manual correction for after the broken running turn without releasing its follower', async () => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'broken-direct-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: binding.activeTurnId, time: now };
    const row = await enqueueInput(input({ text: 'Keep my exact manual correction' }));
    expect(row.directTurn?.id).toBe('broken-direct-turn');
    const follower = await enqueueInput(input({ text: 'Later explicit correction' }));
    expect(await claimBrowserInput(row.id, 'broken-turn-page', binding.conversationId, true))
      .toMatchObject({ id: row.id, directTurn: row.directTurn, owner: 'broken-turn-page' });
    now += 60_001;
    const kept = (await listInputs()).find(entry => entry.id === row.id)!;
    expect(kept).toMatchObject({ id: row.id, sessionId, conversationId: binding.conversationId,
      text: row.text, createdAt: row.createdAt, mode: 'after-turn', state: 'queued', owner: null,
      transportIntent: 'browser', error: expect.stringContaining('after the running answer') });
    for (const field of ['directTurn', 'offeredAt', 'requiresAuthorization', 'sendAuthorizedAt', 'messageId', 'deliveredAt'])
      expect(kept).not.toHaveProperty(field);
    expect((await listInputs()).find(entry => entry.id === follower.id))
      .toMatchObject({ mode: 'after-turn', queuedBehindDelivery: true, state: 'queued', owner: null });
    expect(await authorizeBrowserInput(row.id, 'broken-turn-page', binding.conversationId)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ mode: 'after-turn', state: 'queued', owner: null });
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'broken-direct-turn', time: now };
    expect((await pendingBrowserInputs()).map(entry => entry.id)).toEqual([row.id]);
    const claim = await claimBrowserInput(row.id, 'settled-turn-page', binding.conversationId, true);
    expect(claim).toMatchObject({ id: row.id });
    expect(operatorPromptBody(claim!.text)).toBe(row.text);
    expect(await authorizeBrowserInput(row.id, 'settled-turn-page', binding.conversationId)).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'settled-turn-page', binding.conversationId, 'exact-manual-native-user')).toBe(true);
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', messageId: 'exact-manual-native-user' });
  });
  it('keeps a late receipt on a legacy claimed row without the newer authorization flag', async () => {
    const row = await enqueueInput(input({ sessionId: null, automation: 'loop' }));
    expect(await claimBrowserInput(row.id, 'older-page', null)).not.toBeNull();
    expect(await cancelInput(row.id)).toBe(true);
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)?.requiresAuthorization).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'foreign-page', binding.conversationId, 'old-native')).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'older-page', binding.conversationId, 'old-native')).toBe(true);
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'cancelled', messageId: 'old-native', deliveredAt: expect.any(Number)
    });
    expect(automate).not.toHaveBeenCalled();
    resetInputForTests();
    expect(await acknowledgeBrowserInput(row.id, 'older-page', binding.conversationId, 'different-native')).toBe(false);
  });
  it.each(['images', 'attachments'] as const)('retains the exact %s and its longer preparation budget on a pre-Send direct correction', async kind => {
    const payload = kind === 'images'
      ? { images: [{ name: 'reference.webp', dataUrl: 'data:image/webp;base64,AAAA' }] }
      : { attachments: [{ id: randomUUID(), name: 'reference.txt', mimeType: 'text/plain', size: 42 }] };
    const row: InputEntry = { ...input(), ...payload, state: 'browser', owner: 'old-direct-page',
      conversationId: binding.conversationId, createdAt: now, offeredAt: now, requiresAuthorization: true,
      directTurn: { id: 'retained-direct-turn', startedAt: now }, transportIntent: 'browser' };
    await writeDurableNow('session-input', [row]); resetInputForTests();
    const budget = kind === 'images' ? 120_000 : 720_000;
    now += budget - 1;
    expect((await listInputs())[0]).toMatchObject({ state: 'browser', owner: row.owner, ...payload });
    now += 2;
    expect((await listInputs())[0]).toMatchObject({ id: row.id, text: row.text, mode: 'after-turn', state: 'queued', owner: null, ...payload });
    expect((await listInputs())[0]).not.toHaveProperty('directTurn');
    expect(await authorizeBrowserInput(row.id, row.owner!, binding.conversationId)).toBe(false);
  });
  it.each(['authorized', 'automatic', 'helper', 'source-helper', 'opening', 'companion', 'native-receipt', 'unproven-authorization'] as const)
  ('does not requeue a %s direct-looking input as a manual pre-Send correction', async kind => {
    const row: InputEntry = { ...input(), state: 'browser', owner: 'retained-owner', conversationId: binding.conversationId,
      createdAt: now, offeredAt: now, requiresAuthorization: true, directTurn: { id: 'older-direct-turn', startedAt: now },
      ...(kind === 'authorized' ? { sendAuthorizedAt: now } : {}),
      ...(kind === 'automatic' ? { mode: 'after-turn' as const, requestedMode: 'after-turn' as const } : {}),
      ...(kind === 'helper' ? { purpose: 'decision' as const, decisionSourceSessionId: sessionId } : {}),
      ...(kind === 'source-helper' ? { sourceHelperId: randomUUID() } : {}),
      ...(kind === 'opening' ? { sessionId: null, conversationId: null } : {}),
      ...(kind === 'companion' ? { companionInputId: randomUUID() } : {}),
      ...(kind === 'native-receipt' ? { messageId: 'retained-native-user', deliveredAt: now } : {}),
      ...(kind === 'unproven-authorization' ? { requiresAuthorization: false } : {}) };
    const companion = kind === 'companion' ? { ...row, id: row.companionInputId!, companionInputId: undefined } : undefined;
    await writeDurableNow('session-input', companion ? [row, companion] : [row]); resetInputForTests();
    now += BROWSER_RECEIPT_WAIT_MS + 1;
    const settled = (await listInputs()).find(entry => entry.id === row.id)!;
    expect(settled.state).toBe(kind === 'unproven-authorization' ? 'browser' : 'cancelled');
    expect(settled).toMatchObject({ id: row.id, owner: row.owner, text: row.text, directTurn: row.directTurn });
    expect(settled.error ?? '').not.toContain('Kept for after');
    if (kind === 'authorized') {
      expect(settled.sendAuthorizedAt).toBe(row.sendAuthorizedAt);
      expect(await claimBrowserInput(row.id, 'replacement-page', binding.conversationId, true)).toBeNull();
      expect(await acknowledgeBrowserInput(row.id, row.owner!, binding.conversationId, 'late-authorized-native-user')).toBe(true);
      expect((await listInputs()).find(entry => entry.id === row.id))
        .toMatchObject({ state: 'cancelled', messageId: 'late-authorized-native-user', deliveredAt: now });
    }
    if (companion) expect((await listInputs()).find(entry => entry.id === companion.id)?.state).toBe('cancelled');
  });
  it.each(['eligible', 'no-deadline', 'expired', 'claimed', 'authorized', 'released', 'aborted', 'paused', 'restart', 'ordinary'] as const)(
    'proves only the original live pristine Temporary helper for preclaim reload (%s)', async mode => {
      const controller = new AbortController();
      const expiresAt = now + 90_000;
      const answer = requestBrowserDecision('Private bounded helper', controller.signal, {
        ...(mode === 'ordinary' ? {} : { lifetime: 'temporary-planner' as const }),
        ...(mode === 'no-deadline' ? {} : { preparationExpiresAt: expiresAt })
      });
      void answer.catch(() => undefined);
      await vi.waitFor(async () => expect(await listInputs()).toHaveLength(1));
      const row = (await listInputs())[0]!;
      if (['claimed', 'authorized', 'released'].includes(mode)) {
        expect(await claimBrowserInput(row.id, 'exact-helper-page', null, true)).not.toBeNull();
        if (mode === 'authorized') expect(await authorizeBrowserInput(row.id, 'exact-helper-page', null)).toBe(true);
        if (mode === 'released') expect(await failBrowserInput(row.id, 'exact-helper-page', 'Native Send was not attempted.',
          { confirmedUnsent: true, conversationId: null })).toBe(true);
      }
      if (mode === 'expired') now = expiresAt;
      if (mode === 'paused') binding.automationPaused = true;
      if (mode === 'aborted') { controller.abort(); await answer.catch(() => undefined); }
      if (mode === 'restart') resetInputForTests();
      const projected = (await pendingBrowserInputs()).find(entry => entry.id === row.id) as any;
      if (mode === 'eligible') {
        expect(projected?.preclaimRecovery).toEqual({ expiresAt });
        expect((await listInputs())[0]).toMatchObject({ state: 'queued', owner: null, createdAt: row.createdAt });
        expect((await listInputs())[0]!.offeredAt).toBeUndefined();
      } else expect(projected?.preclaimRecovery).toBeUndefined();
      controller.abort(); await answer.catch(() => undefined);
    });

  it('keeps temporary planner text and answer out of durable storage and accepts an exact id-less receipt', async () => {
    const controller = new AbortController();
    const wake = vi.fn(async () => undefined);
    configureInputDelivery({ applyAutomation: automate, changed, wakeDecision: wake });
    const answer = requestBrowserDecision('PRIVATE PLANNER TASK', controller.signal, { lifetime: 'temporary-planner' });
    await vi.waitFor(async () => expect(await pendingBrowserInputs()).toHaveLength(1));
    const row = (await listInputs())[0]!;
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, lifetime: 'temporary-planner', conversationId: null }), controller.signal));
    const claim = await claimBrowserInput(row.id, 'temporary-page', null);
    expect(claim).toMatchObject({ lifetime: 'temporary-planner' });
    expect(operatorPromptBody(claim!.text)).toBe('PRIVATE PLANNER TASK');
    expect(await acknowledgeBrowserInput(row.id, 'temporary-page', null)).toBe(true);
    expect(await completeBrowserDecision(row.id, 'wrong-page', 'PRIVATE RESPONSE', null)).toBe(false);
    expect(await completeBrowserDecision(row.id, 'temporary-page', 'PRIVATE RESPONSE', null)).toBe(true);
    expect(await answer).toBe('PRIVATE RESPONSE');
    const durable = JSON.stringify(await readDurable('session-input'));
    expect(durable).not.toContain('PRIVATE');
    expect(durable).toContain('temporary-planner');
  });
  it('retains the opening Loop delivery preference across restart, Off and the exact send receipt', async () => {
    const entry = await enqueueInput(input({ sessionId: null, automation: 'loop', loopAfterTurn: true }));
    resetInputForTests();
    expect((await listInputs()).find(row => row.id === entry.id)?.loopAfterTurn).toBe(true);
    await claimBrowserInput(entry.id, 'browser-owner', null);
    await setInputAutomation(entry.id, 'off');
    await acknowledgeBrowserInput(entry.id, 'browser-owner', binding.conversationId);
    expect(automate).toHaveBeenLastCalledWith(binding.conversationId, 'off', 'after-send', undefined, true, true);
    await setInputAutomation(entry.id, 'loop', false);
    expect(automate).toHaveBeenLastCalledWith(binding.conversationId, 'loop', 'after-send', undefined, false);
    resetInputForTests();
    expect((await listInputs()).find(row => row.id === entry.id)).toMatchObject({ automation: 'loop', loopAfterTurn: false });
    automate.mockClear();
    await acknowledgeBrowserInput(entry.id, 'browser-owner', binding.conversationId);
    expect(automate).not.toHaveBeenCalled();
  });
  it('persists fresh-chat Off before ACK and applies Off after ACK without resending', async () => {
    const entry = await enqueueInput(input({ sessionId: null, automation: 'goal', objective: 'Keep objective' }));
    await claimBrowserInput(entry.id, 'browser-owner', null);
    expect(await setInputAutomation(entry.id, 'off')).toBe(true);
    expect(await acknowledgeBrowserInput(entry.id, 'browser-owner', binding.conversationId)).toBe(true);
    expect(automate.mock.calls.map(call => call[1])).toEqual(['off']);
    expect((await listInputs()).find(row => row.id === entry.id)).toMatchObject({ state: 'sent', automation: 'off', objective: 'Keep objective' });
    await acknowledgeBrowserInput(entry.id, 'browser-owner', binding.conversationId);
    expect(automate).toHaveBeenCalledTimes(1);
    const second = await enqueueInput(input({ sessionId: null, automation: 'goal' }));
    await claimBrowserInput(second.id, 'second-owner', null);
    await acknowledgeBrowserInput(second.id, 'second-owner', binding.conversationId);
    expect(await setInputAutomation(second.id, 'off')).toBe(true);
    expect(automate.mock.calls.at(-1)?.[1]).toBe('off');
    await acknowledgeBrowserInput(second.id, 'second-owner', binding.conversationId);
    expect(automate.mock.calls.at(-1)?.[1]).toBe('off');
  });
  it('retains both a legacy initial browser attempt and an intentional after-turn wait', async () => {
    const stale = await seedLegacyInput(input({ sessionId: null }));
    const after = await seedLegacyInput(input({ mode: 'after-turn' }));
    now += 600001;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'fresh-end', time: now };
    expect(await pendingBrowserInputs()).toContainEqual({ id: after.id, conversationId: binding.conversationId });
    expect((await listInputs()).find(row => row.id === stale.id)).toMatchObject({ state: 'queued' });
    resetInputForTests();
    expect(await claimBrowserInput(stale.id, 'after-restart', null)).toMatchObject({ id: stale.id, state: 'browser' });
  });
  it('restores the retired 60-second failure only when it is positively unclaimed', async () => {
    const row = await seedLegacyInput(input({ sessionId: null }));
    await writeDurableNow('session-input', [{ ...row, state: 'failed', owner: null,
      error: 'Not sent: the browser did not pick up this message within 60 seconds.' }]);
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'queued', owner: null, error: undefined
    });
    expect(await pendingBrowserInputs()).toContainEqual({ id: row.id, conversationId: null });
  });
  it('waits indefinitely for tool injection after restart', async () => {
    binding.activeTurnId = 'active';
    const row = await enqueueInput(input());
    binding.activeTurnId = null;
    now += 365 * 24 * 60 * 60 * 1000;
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'queued' });
    expect((await offerToolInput(sessionId, binding.conversationId, 'late-tool', now))[0]?.text).toContain(row.text);
  });
  it('lets the user cancel indefinitely queued input after restart', async () => {
    binding.activeTurnId = 'active';
    const row = await enqueueInput(input());
    now += 365 * 24 * 60 * 60 * 1000;
    resetInputForTests();
    expect(await cancelInput(row.id)).toBe(true);
    resetInputForTests();
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-tool', now + 1)).toEqual([]);
  });
  it('serializes pending user messages across chats while allowing an exact UUID retry', async () => {
    const first = input({ sessionId: null });
    const admitted = await enqueueInput(first);
    expect(await enqueueInput(first)).toMatchObject({ id: first.id });
    const queued = await enqueueInput(input({ sessionId: null }));
    expect(queued).toMatchObject({ state: 'queued', queuedBehindBrowser: true });
    expect(await pendingBrowserInputs()).toEqual([{ id: admitted.id, conversationId: null }]);
    expect(await cancelInput(first.id)).toBe(true);
    expect(await pendingBrowserInputs()).toEqual([{ id: queued.id, conversationId: null }]);
    expect((await listInputs()).find(row => row.id === queued.id)?.queuedBehindBrowser).toBeUndefined();
  });
  it('parks only a 15-minute unclaimed browser head, advances the next chat, and preserves an exact revisit', async () => {
    const first = await enqueueInput(input({ sessionId: null, text: 'First chat' }));
    const second = await enqueueInput(input({ sessionId: 'session-two', text: 'Second chat' }));
    expect(second).toMatchObject({ queuedBehindBrowser: true });
    expect(await pendingBrowserInputs()).toEqual([{ id: first.id, conversationId: null }]);

    now += UNCLAIMED_BROWSER_ATTENTION_MS + 1;
    expect((await listInputs()).find(row => row.id === first.id)).toMatchObject({
      state: 'queued', deliveryAttentionAt: now, error: expect.stringContaining('Needs attention')
    });
    expect(await pendingBrowserInputs()).toEqual([{ id: second.id, conversationId: 'conversation-b' }]);
    expect((await listInputs()).find(row => row.id === second.id)).toMatchObject({
      queuedBehindBrowser: undefined, browserEligibleAt: now
    });

    expect(await rearmQueuedBrowserInput(first.id)).toMatchObject({
      id: first.id, deliveryAttentionAt: undefined, error: undefined
    });
    expect(await pendingBrowserInputs()).toEqual([{ id: first.id, conversationId: null }]);
  });
  it('does not let Retry browser preempt a different chat that already owns the global composer', async () => {
    const first = await enqueueInput(input({ sessionId: null, text: 'First chat' }));
    const second = await enqueueInput(input({ sessionId: 'session-two', text: 'Second chat' }));
    now += UNCLAIMED_BROWSER_ATTENTION_MS + 1;
    await listInputs();
    expect(await pendingBrowserInputs()).toEqual([{ id: second.id, conversationId: 'conversation-b' }]);
    expect(await claimBrowserInput(second.id, 'page-b', 'conversation-b', true)).not.toBeNull();

    expect(await rearmQueuedBrowserInput(first.id)).toMatchObject({
      id: first.id, deliveryAttentionAt: undefined, queuedBehindBrowser: true, error: undefined
    });
    expect(await pendingBrowserInputs()).toEqual([{ id: second.id, conversationId: 'conversation-b' }]);
    expect(await claimBrowserInput(first.id, 'page-a', null, true)).toBeNull();

    expect(await cancelInput(second.id)).toBe(true);
    expect(await pendingBrowserInputs()).toEqual([{ id: first.id, conversationId: null }]);
    expect((await listInputs()).find(row => row.id === first.id)?.queuedBehindBrowser).toBeUndefined();
  });
  it('atomically consumes an operator Retry attention fence once and retains its receipt through browser claim', async () => {
    const receipt = randomUUID();
    const row = await enqueueInput(input({ sessionId: null, text: 'Strict headless retry' }));
    now += UNCLAIMED_BROWSER_ATTENTION_MS + 1;
    await listInputs();
    expect(await rearmQueuedBrowserInput(row.id, true, receipt)).toMatchObject({
      id: row.id, state: 'queued', deliveryAttentionAt: undefined,
      operatorRetryReceipt: receipt
    });
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      operatorRetryReceipt: receipt
    });
    expect(await claimBrowserInput(row.id, 'operator-retry-page', null)).toMatchObject({
      state: 'browser', owner: 'operator-retry-page', operatorRetryReceipt: receipt
    });
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'browser', owner: 'operator-retry-page', operatorRetryReceipt: receipt
    });
    expect(await rearmQueuedBrowserInput(row.id, true, randomUUID())).toBeNull();
    expect((await listInputs()).find(entry => entry.id === row.id)?.operatorRetryReceipt).toBe(receipt);
  });
  it('releases the next same-chat explicit message when the earlier browser delivery is cancelled before claim', async () => {
    binding.model = 'gpt-5.6-sol';
    const first = await enqueueInput(input({ text: 'First instruction' }));
    const second = await enqueueInput(input({ text: 'Second instruction' }));
    expect(second).toMatchObject({ mode: 'after-turn', requestedMode: 'auto', queuedBehindDelivery: true, state: 'queued' });
    expect(await pendingBrowserInputs()).toEqual([{ id: first.id, conversationId: binding.conversationId }]);

    expect(await cancelInput(first.id)).toBe(true);
    resetInputForTests();

    expect((await listInputs()).find(row => row.id === second.id)).toMatchObject({
      mode: 'auto', requestedMode: 'auto', state: 'queued', owner: null
    });
    expect((await listInputs()).find(row => row.id === second.id)?.queuedBehindDelivery).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([{ id: second.id, conversationId: binding.conversationId }]);
  });
  it('keeps global browser FIFO order when a same-chat follower leaves the after-turn queue', async () => {
    binding.model = 'gpt-5.6-sol';
    const first = await enqueueInput(input({ text: 'First A instruction' }));
    const otherChat = await enqueueInput(input({ sessionId: 'session-two', text: 'Older B instruction' }));
    const follower = await enqueueInput(input({ text: 'Later A instruction' }));
    expect(follower).toMatchObject({ queuedBehindDelivery: true, state: 'queued' });
    expect(await reorderQueuedInputs(sessionId, [follower.id])).toBe(true);
    expect((await listInputs()).find(row => row.id === follower.id)?.queueOrder).toBe(0);

    expect(await cancelInput(first.id)).toBe(true);
    expect((await listInputs()).find(row => row.id === follower.id)).toMatchObject({
      mode: 'auto', queuedBehindDelivery: undefined, queuedBehindBrowser: true, queueOrder: undefined
    });
    expect(await pendingBrowserInputs()).toEqual([{ id: otherChat.id, conversationId: 'conversation-b' }]);

    expect(await cancelInput(otherChat.id)).toBe(true);
    expect(await pendingBrowserInputs()).toEqual([{ id: follower.id, conversationId: binding.conversationId }]);
  });
  it('does not skip a live same-chat owner when cancelling a parked follower, but chained followers advance after a claimed follower is proven unsent', async () => {
    binding.model = 'gpt-5.6-sol';
    const first = await enqueueInput(input({ text: 'First instruction' }));
    const second = await enqueueInput(input({ text: 'Second instruction' }));
    const third = await enqueueInput(input({ text: 'Third instruction' }));

    expect(await cancelInput(second.id)).toBe(true);
    expect((await listInputs()).find(row => row.id === third.id)).toMatchObject({ queuedBehindDelivery: true, mode: 'after-turn' });
    expect(await pendingBrowserInputs()).toEqual([{ id: first.id, conversationId: binding.conversationId }]);

    expect(await acknowledgeBrowserInput(first.id, 'missing-owner', binding.conversationId, 'native-first')).toBe(false);
    expect(await claimBrowserInput(first.id, 'page-one', binding.conversationId, true)).not.toBeNull();
    expect(await authorizeBrowserInput(first.id, 'page-one', binding.conversationId)).toBe(true);
    expect(await acknowledgeBrowserInput(first.id, 'page-one', binding.conversationId, 'native-first')).toBe(true);
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'first-complete', time: ++now };

    expect(await claimBrowserInput(third.id, 'page-two', binding.conversationId, true)).not.toBeNull();
    const fourth = await enqueueInput(input({ text: 'Fourth instruction' }));
    expect(fourth).toMatchObject({ queuedBehindDelivery: true, state: 'queued' });
    expect(await failBrowserInput(third.id, 'page-two', 'Composer rejected the prepared text')).toBe(true);

    expect((await listInputs()).find(row => row.id === third.id)).toMatchObject({
      state: 'queued', owner: null, preSendReoffers: 1
    });
    expect((await listInputs()).find(row => row.id === fourth.id)).toMatchObject({
      mode: 'after-turn', queuedBehindDelivery: true, state: 'queued'
    });
  });
  it('releases a same-chat follower after a claimed delivery is cancelled before Send authorization but not after authorization', async () => {
    binding.model = 'gpt-5.6-sol';
    const first = await enqueueInput(input({ text: 'First instruction' }));
    const second = await enqueueInput(input({ text: 'Second instruction' }));
    expect(await claimBrowserInput(first.id, 'page-one', binding.conversationId, true)).not.toBeNull();
    expect(await cancelInput(first.id)).toBe(true);
    expect(await pendingBrowserInputs()).toEqual([{ id: second.id, conversationId: binding.conversationId }]);

    expect(await claimBrowserInput(second.id, 'page-two', binding.conversationId, true)).not.toBeNull();
    const third = await enqueueInput(input({ text: 'Third instruction' }));
    expect(third).toMatchObject({ queuedBehindDelivery: true, state: 'queued' });
    expect(await authorizeBrowserInput(second.id, 'page-two', binding.conversationId)).toBe(true);
    expect(await cancelInput(second.id)).toBe(true);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect((await listInputs()).find(row => row.id === third.id)).toMatchObject({ queuedBehindDelivery: true, state: 'queued' });
  });
  it('keeps a same-chat follower behind the exact UUID while a confirmed pre-Send failure is reoffered', async () => {
    binding.model = 'gpt-5.6-sol';
    const first = await enqueueInput(input({ text: 'First instruction' }));
    const second = await enqueueInput(input({ text: 'Second instruction' }));
    expect(await claimBrowserInput(first.id, 'page-one', binding.conversationId, true)).not.toBeNull();
    expect(await failBrowserInput(first.id, 'page-one', 'Composer rejected the prepared text')).toBe(true);

    expect((await listInputs()).find(row => row.id === first.id)).toMatchObject({
      id: first.id, state: 'queued', owner: null, preSendReoffers: 1
    });
    expect((await listInputs()).find(row => row.id === second.id)).toMatchObject({
      state: 'queued', queuedBehindDelivery: true
    });
  });
  it('releases a same-chat follower after a claimed pre-Send preparation timeout', async () => {
    binding.model = 'gpt-5.6-sol';
    const first = await enqueueInput(input({ text: 'First instruction' }));
    const second = await enqueueInput(input({ text: 'Second instruction' }));
    expect(await claimBrowserInput(first.id, 'page-one', binding.conversationId, true)).not.toBeNull();
    now += 60_001;
    await listInputs();

    expect((await listInputs()).find(row => row.id === second.id)).toMatchObject({
      mode: 'auto', requestedMode: 'auto', state: 'queued', owner: null
    });
    expect(await pendingBrowserInputs()).toEqual([{ id: second.id, conversationId: binding.conversationId }]);
  });
  it('releases a same-chat follower when pre-Send automation setup fails durably', async () => {
    binding.model = 'gpt-5.6-sol';
    const first = await enqueueInput(input({ text: 'First instruction', automation: 'goal' }));
    const second = await enqueueInput(input({ text: 'Second instruction' }));
    automate.mockRejectedValueOnce(new Error('automation persistence failed'));

    await expect(claimBrowserInput(first.id, 'page-one', binding.conversationId, true)).rejects.toThrow('automation persistence failed');
    expect((await listInputs()).find(row => row.id === first.id)).toMatchObject({
      state: 'failed', error: 'Automation was not confirmed; this message was not sent. Send again to retry.'
    });
    expect(await pendingBrowserInputs()).toEqual([{ id: second.id, conversationId: binding.conversationId }]);
  });
  it('lets a newer explicit message replace a stale same-chat browser message Chrome never claimed', async () => {
    binding.model = 'gpt-5.6-sol';
    const first = await enqueueInput(input({ text: 'Old continue' }));
    expect(first).toMatchObject({ state: 'queued', owner: null, transportIntent: 'browser' });
    now += 120_000;
    const second = await enqueueInput(input({ text: 'Use this newer instruction' }));
    expect(second).toMatchObject({ state: 'queued', owner: null, transportIntent: 'browser' });
    const rows = await listInputs();
    expect(rows.find(row => row.id === first.id)).toMatchObject({
      state: 'cancelled',
      error: 'Replaced by a newer message before Chrome claimed this delivery.'
    });
    expect(rows.find(row => row.id === second.id)?.state).toBe('queued');
  });
  it.each(['tool', 'browser'] as const)('retains the %s delivery receipt when recording fails and never resends it', async (transport) => {
    const record = vi.fn(async () => { throw new Error('recorder unavailable'); return true; });
    configureInputDelivery({ applyAutomation: automate, changed, recordDelivered: record });
    const row = await enqueueInput(input());
    if (transport === 'tool') {
      expect(await offerToolInput(sessionId, binding.conversationId, 'same-request', 0)).toHaveLength(1);
      now++;
      expect(await offerToolInput(sessionId, binding.conversationId, 'same-request', now)).toEqual([]);
    } else {
      expect(await claimBrowserInput(row.id, 'page', binding.conversationId)).not.toBeNull();
      expect(await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-message')).toBe(true);
    }
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', messageId: transport === 'tool' ? `input:${row.id}` : 'native-message' });
    expect((await listInputs())[0]?.historyRecorded).not.toBe(true);
    resetInputForTests(); // receipt persists across restart, unlike in-flight timing proof
    expect(await offerToolInput(sessionId, binding.conversationId, 'next', ++now)).toEqual([]);
    expect(await claimBrowserInput(row.id, 'another-page', binding.conversationId)).toBeNull();
    record.mockResolvedValue(true);
    expect((await listInputs())[0]).toMatchObject({
      state: 'sent', historyRecorded: true, historyProjectionVersion: 1
    });
    const calls = record.mock.calls.length;
    await listInputs();
    expect(record).toHaveBeenCalledTimes(calls);
  });
  it.each([
    { label: 'inside', age: BROWSER_RECEIPT_WAIT_MS - 1, retained: true },
    { label: 'after', age: BROWSER_RECEIPT_WAIT_MS + 1, retained: false }
  ])('$label the late native-id window, terminal pruning retains the ID-less ACK only while enrichment is still possible', async ({ age, retained }) => {
    const row = await enqueueInput(input());
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
    expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'page', binding.conversationId)).toBe(true);
    const receipt = (await listInputs()).find(entry => entry.id === row.id)!;
    expect(receipt).toMatchObject({ state: 'sent', deliveredAt: expect.any(Number) });
    expect(receipt.messageId).toBeUndefined();

    const terminalHistory: InputEntry[] = Array.from({ length: 50 }, (_, index) => ({
      ...receipt,
      id: randomUUID(),
      text: `Recorded terminal ${index}`,
      deliveryText: undefined,
      messageId: `native-terminal-${index}`,
      deliveredAt: now - index,
      historyRecorded: true,
      historyProvenanceRecorded: true
    }));
    await writeDurableNow('session-input', [
      { ...receipt, deliveredAt: now - age },
      ...terminalHistory
    ]);
    resetInputForTests();

    await enqueueInput(input({ text: 'Next durable message' }));
    expect((await listInputs()).some(entry => entry.id === row.id)).toBe(retained);
  });
  it.each([true, false])('upgrades native provenance before trimming without reopening Send (recorded=%s)', async succeeds => {
    const record = vi.fn(async (_entry: InputEntry) => succeeds);
    configureInputDelivery({ applyAutomation: automate, changed, recordDelivered: record });
    const original: InputEntry = { ...input({ text: 'Original human acceptance remains binding.' }),
      state: 'sent', owner: 'original-owned-page', createdAt: now - 100,
      conversationId: binding.conversationId, deliveredAt: now - 90,
      messageId: 'original-native-user', historyRecorded: true, historyProjectionVersion: 1 };
    await writeDurableNow('session-input', [original, ...Array.from({ length: 51 }, (_, n) => ({
      ...original, id: randomUUID(), createdAt: now - 80 + n, messageId: 'later-native-' + n,
      text: 'Unrelated completed history ' + n, historyProvenanceRecorded: true as const
    }))]);
    resetInputForTests();
    await enqueueInput(input({ text: 'Next after-turn correction.', mode: 'after-turn' }));
    const retained = (await listInputs()).find(row => row.id === original.id)!;
    expect(retained).toMatchObject({ state: 'sent', messageId: original.messageId, owner: original.owner,
      historyRecorded: true });
    expect(retained.historyProvenanceRecorded).toBe(succeeds ? true : undefined);
    expect(retained.historyProvenancePending).toBe(succeeds ? undefined : true);
    expect(record.mock.calls.some(([entry]) => entry.id === original.id)).toBe(true);
    expect(await claimBrowserInput(original.id, 'another-page', binding.conversationId)).toBeNull();
  });

  it('reprojects a wrapped recorded receipt after restart without reopening delivery', async () => {
    const record = vi.fn(async (_entry: InputEntry) => true);
    configureInputDelivery({ applyAutomation: automate, changed, recordDelivered: record });
    const args = input({ text: 'hello' });
    const receipt: InputEntry = { ...args, state: 'sent', owner: null, createdAt: now,
      conversationId: binding.conversationId, deliveryText: 'hello\n\nInternal instructions',
      deliveredAt: now, messageId: 'native-message', historyRecorded: true };
    await writeDurableNow('session-input', [receipt]);
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({
      state: 'sent', historyRecorded: true, historyProjectionVersion: 1, deliveryText: receipt.deliveryText
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ text: 'hello', deliveryText: receipt.deliveryText, messageId: 'native-message' });
    expect(await claimBrowserInput(receipt.id, 'another-page', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'next', ++now)).toEqual([]);
    await listInputs();
    expect(record).toHaveBeenCalledTimes(1);
    resetInputForTests();
    await listInputs();
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('legacy queue: offers images in the held turn, bounds each offer to four, and preserves the receipt boundary', async () => {
    binding.activeTurnId = 'held-turn';
    const images = Array.from({ length: 4 }, (_, index) => ({ name: `${index}.webp`, dataUrl: 'data:image/webp;base64,YQ==' }));
    const first = await seedLegacyInput(input({ images }));
    await seedLegacyInput(input({ images: images.slice(0, 1) }));
    expect(await hasEligibleToolInput(sessionId)).toBe(true);
    expect(await claimBrowserInput(first.id, 'page', binding.conversationId)).toBeNull();
    const offered = await offerToolInput(sessionId, binding.conversationId, 'turn-id', 0);
    expect(offered).toHaveLength(1);
    expect(offered[0]?.images).toEqual(images);
    expect(await offerToolInput(sessionId, binding.conversationId, 'turn-id', 0)).toEqual(offered);
    now += 1;
    const next = await offerToolInput(sessionId, binding.conversationId, 'turn-id', now);
    expect(next).toHaveLength(1);
    expect(next[0]?.images).toHaveLength(1);
    expect((await listInputs()).find(row => row.id === first.id)?.state).toBe('sent');
  });
  it('keeps input in tool delivery during a proven active turn even when the browser looks idle', async () => {
    binding.activeTurnId = 'real-turn';
    const row = await enqueueInput(input());
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'idle-looking-document', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-tool', 0)).toHaveLength(1);
    await offerToolInput(sessionId, binding.conversationId, 'ack-tool', now + 1);
    const after = await enqueueInput(input({ mode: 'after-turn', afterTurn: true }));
    expect(await claimBrowserInput(after.id, 'idle-looking-document', binding.conversationId)).toBeNull();
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'real-turn', time: now + 1 };
    await offerToolInput(sessionId, binding.conversationId, 'ack', now + 1);
    expect((await pendingBrowserInputs()).some(entry => entry.id === after.id)).toBe(true);
  });
  it('applies scheduled automation only at handout and never replays it on ACK', async () => {
    const row = await enqueueInput(input({ automation: 'loop', dueAt: 2000 }));
    expect(automate).not.toHaveBeenCalled();
    expect(await claimBrowserInput(row.id, 'owner', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'early', 0)).toEqual([]);
    expect(automate).not.toHaveBeenCalled();
    now = 2000;
    await claimBrowserInput(row.id, 'owner', binding.conversationId);
    expect(automate).toHaveBeenCalledExactlyOnceWith(binding.conversationId, 'loop', 'before-send', undefined, undefined, false);
    await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId);
    await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId);
    expect(automate).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalled();
  });
  it('applies tool input automation before disclosure and never repeats on overlapping offers', async () => {
    await enqueueInput(input({ automation: 'off' }));
    expect(await offerToolInput(sessionId, binding.conversationId, 'first', 0)).toHaveLength(1);
    expect(automate).toHaveBeenCalledExactlyOnceWith(binding.conversationId, 'off', 'before-send', undefined, undefined, false);
    expect(await offerToolInput(sessionId, binding.conversationId, 'overlapping', 0)).toHaveLength(1);
    expect(automate).toHaveBeenCalledTimes(1);
  });
  it('does not retry an interrupted automation attempt after restart or late ACK', async () => {
    const row = await enqueueInput(input({ automation: 'goal' }));
    automate.mockRejectedValueOnce(new Error('settings persistence failed'));
    await expect(claimBrowserInput(row.id, 'owner', binding.conversationId)).rejects.toThrow('settings persistence failed');
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('not sent') });
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'owner', binding.conversationId)).toBeNull();
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(false);
    expect(await offerToolInput(sessionId, binding.conversationId, 'later', 2001)).toEqual([]);
    expect(automate).toHaveBeenCalledTimes(1);
  });
  it('keeps a spent automation attempt inert if the final delivery commit fails', async () => {
    const row = await enqueueInput(input({ automation: 'goal' }));
    automate.mockImplementationOnce(async () => {
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('final commit failed'));
    });
    await expect(claimBrowserInput(row.id, 'owner', binding.conversationId)).rejects.toThrow('final commit failed');
    await flushDurable();
    resetInputForTests();
    expect((await listInputs())[0]?.state).toBe('failed');
    expect(await claimBrowserInput(row.id, 'owner', binding.conversationId)).toBeNull();
    expect(automate).toHaveBeenCalledTimes(1);
  });
  it('binds a fresh send to its exact conversation and recording without changing authored identity', async () => {
    const args = input({ sessionId: null, automation: 'goal', objective: 'Build the requested project and test it' });
    const row = await enqueueInput(args);
    expect(await claimBrowserInput(row.id, 'owner', null)).toMatchObject({ automation: 'goal' });
    expect(await acknowledgeBrowserInput(row.id, 'owner')).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'other', binding.conversationId)).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(true);
    expect(automate).toHaveBeenCalledExactlyOnceWith(binding.conversationId, 'goal', 'after-send', 'Build the requested project and test it', undefined, true);
    expect((await listInputs())[0]).toMatchObject({ sessionId: null, deliveredSessionId: sessionId, conversationId: binding.conversationId, state: 'sent' });
    expect(await enqueueInput(args)).toMatchObject({ state: 'sent', automation: 'goal' });
    expect(await acknowledgeBrowserInput(row.id, 'owner', 'conversation-other')).toBe(false);
    expect(automate).toHaveBeenCalledTimes(1);
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ deliveredSessionId: sessionId, objective: 'Build the requested project and test it' });
  });
  it('waits for exact recording evidence when a new send ACK precedes recorder creation', async () => {
    binding.recorded = false;
    const row = await enqueueInput(input({ sessionId: null, automation: 'loop' }));
    await claimBrowserInput(row.id, 'owner', null);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(true);
    expect((await listInputs())[0]?.deliveredSessionId).toBeNull();
    binding.recorded = true;
  binding.activeTurnId = null;
    expect((await listInputs())[0]?.deliveredSessionId).toBe(sessionId);
    binding.conversationId = 'conversation-resumed';
    expect((await listInputs())[0]?.deliveredSessionId).toBe(sessionId);
  });
  it('deduplicates exact ids, rejects changed input, and returns detached rows', async () => {
    const args = input();
    const row = await enqueueInput(args);
    row.text = 'mutated';
    expect((await enqueueInput(args)).text).toBe(args.text);
    await expect(enqueueInput({ ...args, text: 'changed' })).rejects.toThrow('different input');
    expect(await listInputs()).toHaveLength(1);
  });
  it('uses the durable session current binding after resume and refuses retired callers', async () => {
    const row = await enqueueInput(input());
    binding.conversationId = 'conversation-b';
    expect(await offerToolInput(sessionId, 'conversation-a', 'old', 0)).toEqual([]);
    expect(await claimBrowserInput(row.id, 'page-a', 'conversation-a')).toBeNull();
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: 'conversation-b', supersededConversationId: 'conversation-a' }]);
    expect(await claimBrowserInput(row.id, 'page-b', 'conversation-b')).toMatchObject({ state: 'browser' });
  });
  it('legacy queue: elects one browser owner and excludes tools for that session', async () => {
    const row = await seedLegacyInput(input());
    const claims = await Promise.all(['one', 'two'].map(owner => claimBrowserInput(row.id, owner, binding.conversationId)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await seedLegacyInput(input());
    expect(await offerToolInput(sessionId, binding.conversationId, 'request', 0)).toEqual([]);
    expect(await acknowledgeBrowserInput(row.id, 'two')).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'one')).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'one')).toBe(true);
  });
  it('legacy queue: serializes independent new-chat inputs through one composer lane', async () => {
    const a = await seedLegacyInput(input({ sessionId: null }));
    const b = await seedLegacyInput(input({ sessionId: null }));
    expect(await claimBrowserInput(a.id, 'a', null)).not.toBeNull();
    expect(await claimBrowserInput(b.id, 'b', null)).toBeNull();
    expect(await acknowledgeBrowserInput(a.id, 'a', binding.conversationId, 'native-a')).toBe(true);
    expect(await claimBrowserInput(b.id, 'b', null)).not.toBeNull();
  });
  it('legacy queue: preserves insertion order for messages sharing the same scheduled millisecond', async () => {
    const a = await seedLegacyInput(input());
    const b = await seedLegacyInput(input());
    expect(await claimBrowserInput(b.id, 'page', binding.conversationId)).toBeNull();
    expect(await claimBrowserInput(a.id, 'page', binding.conversationId)).not.toBeNull();
    await acknowledgeBrowserInput(a.id, 'page');
    expect(await claimBrowserInput(b.id, 'page', binding.conversationId)).not.toBeNull();
  });
  it('does not acknowledge a message from an overlapping request, including slow commit', async () => {
    const row = await enqueueInput(input());
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      now = 2000;
      await realRename(from, to);
    });
    expect(await offerToolInput(sessionId, binding.conversationId, 'first', 500)).toHaveLength(1);
    expect(await offerToolInput(sessionId, binding.conversationId, 'parallel', 1500)).toHaveLength(1);
    expect((await listInputs())[0]?.state).toBe('tool');
    expect(await claimBrowserInput(row.id, 'browser', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'later', 2001)).toEqual([]);
    expect((await listInputs())[0]?.state).toBe('sent');
  });
  it('legacy queue: acknowledges a later invocation with the same server-turn request id and unblocks after-turn input', async () => {
    const row = await seedLegacyInput(input());
    const after = await seedLegacyInput(input({ mode: 'after-turn' }));
    const first = await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', 500);
    expect(first[0]?.text).toBe(row.text);
    expect(await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', 500)).toEqual(first);
    expect(await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', now)).toEqual(first);
    now += 1;
    expect(await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', now)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('sent');
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'fresh-end', time: now };
    expect(await claimBrowserInput(after.id, 'after-turn-page', binding.conversationId)).toMatchObject({ id: after.id });
  });
  it('retains an in-flight tool offer as ambiguous after restart instead of injecting it again', async () => {
    const row = await enqueueInput(input());
    await offerToolInput(sessionId, binding.conversationId, 'first', 0);
    resetInputForTests();
    now = 5000;
    expect(await offerToolInput(sessionId, binding.conversationId, 'after-restart', 4000)).toEqual([]);
    expect((await listInputs())[0]).toMatchObject({
      id: row.id,
      state: 'tool',
      toolReceiptUncertain: true,
      error: expect.stringContaining('may already have reached ChatGPT')
    });
  });
  it('still offers a definitely queued tool instruction after restart', async () => {
    const row = await enqueueInput(input());
    resetInputForTests();
    now = 5000;
    expect((await offerToolInput(sessionId, binding.conversationId, 'after-restart', 4000))[0]?.text).toBe(row.text);
    expect((await listInputs())[0]).toMatchObject({ id: row.id, state: 'tool' });
  });
  it('honors due times without letting an after-turn wait block immediate tool input', async () => {
    const later = await seedLegacyInput(input({ dueAt: 2000 }));
    const after = await seedLegacyInput(input({ mode: 'after-turn', dueAt: 500 }));
    const auto = await seedLegacyInput(input({ dueAt: 600 }));
    expect((await pendingBrowserInputs()).map(row => row.id)).toEqual([auto.id]);
    expect(await hasEligibleToolInput(sessionId)).toBe(true);
    expect((await offerToolInput(sessionId, binding.conversationId, 'request', 0)).map(row => row.text)).toEqual([auto.text]);
    expect(await pendingBrowserInputs()).not.toContainEqual({ id: after.id, conversationId: binding.conversationId });
    expect(await claimBrowserInput(later.id, 'page', binding.conversationId)).toBeNull();
    expect((await listInputs()).find(row => row.id === after.id)?.state).toBe('queued');
    expect((await listInputs()).find(row => row.id === later.id)?.state).toBe('queued');
  });
  it('injects explicit tool messages behind an after-turn task and retains that task across restart', async () => {
    binding.model = 'gpt-5-6-pro'; binding.activeTurnId = 'active-pro-turn';
    const after = await enqueueInput(input({ mode: 'after-turn', text: 'After the answer' }));
    const first = await enqueueInput(input({ mode: 'auto', text: 'Immediate first' }));
    const second = await enqueueInput(input({ mode: 'auto', text: 'Immediate second' }));
    expect(first.transportIntent).toBe('tool'); expect(second.transportIntent).toBe('tool');
    resetInputForTests();
    expect(await hasEligibleToolInput(sessionId)).toBe(true);
    expect(await offerToolInput(sessionId, 'wrong-conversation', 'request', now)).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'request', now)).toEqual([
      { text: first.text, images: [] }, { text: second.text, images: [] }
    ]);
    now += 1;
    await acknowledgeToolInput(sessionId, binding.conversationId, 'request', now);
    expect(await hasEligibleToolInput(sessionId)).toBe(false);
    expect((await listInputs()).map(row => ({ id: row.id, state: row.state }))).toEqual([
      { id: after.id, state: 'queued' }, { id: first.id, state: 'sent' }, { id: second.id, state: 'sent' }
    ]);
  });
  it('keeps claimed browser input inert across restart and bounds failure text', async () => {
    const row = await enqueueInput(input());
    await claimBrowserInput(row.id, 'owner', binding.conversationId);
    resetInputForTests();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await failBrowserInput(row.id, 'other', 'failure')).toBe(false);
    expect(await failBrowserInput(row.id, 'owner', 'x'.repeat(500))).toBe(true);
    expect((await listInputs())[0]?.error).toHaveLength(200);
  });
  it('legacy queue: releases all three orphan browser claims on explicit cancellation without replay after restart', async () => {
    const rows = [];
    for (let index = 0; index < 3; index++) {
      const row = await seedLegacyInput(input({ sessionId: null }));
      await claimBrowserInput(row.id, `old-page-${index}`, null);
      rows.push(row);
    }
    resetInputForTests();
    const queued = await enqueueInput(input({ sessionId: null }));
    expect(queued).toMatchObject({ state: 'queued', queuedBehindBrowser: true });
    for (const row of rows) expect(await cancelInput(row.id)).toBe(true);
    resetInputForTests();
    expect(await pendingBrowserInputs()).toEqual([{ id: queued.id, conversationId: null }]);
  });
  it('reports confirmed non-delivery when cancelled before the browser receives Send authority', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'owner', null, true);
    expect(await cancelInput(row.id)).toBe(true);
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', error: expect.stringContaining('Not sent:') });
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input({ sessionId: null }))).resolves.toMatchObject({ state: 'queued' });
  });
  it('preserves prepared context across an exact pre-Send retry and cold restore', async () => {
    let revision = 1;
    const prepareText = vi.fn(async (entry: InputEntry) => `[[COS_CONTEXT]]revision=${revision}[[/COS_CONTEXT]]\n${entry.text}`);
    configureInputDelivery({ applyAutomation: automate, changed, prepareText });
    const row = await enqueueInput(input({ model: 'gpt-6-thinking', reasoningEffort: 'xhigh' }));
    const first = await claimBrowserInput(row.id, 'first-owner', binding.conversationId, true);
    expect(first?.text).toContain('revision=1');
    expect(await failBrowserInput(row.id, 'first-owner', 'Requested model or reasoning could not be confirmed')).toBe(true);
    revision = 2;
    now += 60_000;
    resetInputForTests();
    configureInputDelivery({ applyAutomation: automate, changed, prepareText });
    const retried = await claimBrowserInput(row.id, 'retry-owner', binding.conversationId, true);
    // The actual native draft may still contain this exact prepared envelope.
    expect(retried?.text).toBe(first?.text);
    expect(prepareText).toHaveBeenCalledTimes(1);
    expect(retried?.model).toBe(first?.model);
    expect(retried?.reasoningEffort).toBe(first?.reasoningEffort);
    expect(await authorizeBrowserInput(row.id, 'first-owner', binding.conversationId)).toBe(false);
    expect((await listInputs())[0]?.sendAuthorizedAt).toBeUndefined();
  });

  it('invalidates a retained pre-Send envelope only after an explicit queued text edit', async () => {
    let revision = 1;
    const prepareText = vi.fn(async (entry: InputEntry) => `context=${revision}\n${entry.text}`);
    configureInputDelivery({ applyAutomation: automate, changed, prepareText });
    const row = await enqueueInput(input());
    await claimBrowserInput(row.id, 'first-owner', binding.conversationId, true);
    expect(await failBrowserInput(row.id, 'first-owner', 'Requested model or reasoning could not be confirmed')).toBe(true);
    expect(await editQueuedInput(row.id, 'The revised human instruction')).toBe(true);
    revision = 2;
    now += 60_000;
    const retried = await claimBrowserInput(row.id, 'retry-owner', binding.conversationId, true);
    expect(retried?.text).toContain('context=2\nThe revised human instruction');
    expect(prepareText).toHaveBeenCalledTimes(2);
    expect(await authorizeBrowserInput(row.id, 'first-owner', binding.conversationId)).toBe(false);
    expect((await listInputs())[0]?.sendAuthorizedAt).toBeUndefined();
  });

  it('rearms the same exact UUID only from a positive pre-Send browser release after authorization', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    expect(await claimBrowserInput(row.id, 'owner', null, true)).toMatchObject({ id: row.id, owner: 'owner' });
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(true);
    expect((await listInputs())[0]).toMatchObject({
      id: row.id,
      state: 'browser',
      owner: 'owner',
      sendAuthorizedAt: expect.any(Number)
    });

    expect(await failBrowserInput(row.id, 'owner', 'Native Send was not attempted.', {
      confirmedUnsent: true,
      conversationId: null
    })).toBe(true);
    resetInputForTests();

    expect((await listInputs())[0]).toMatchObject({
      id: row.id,
      state: 'queued',
      owner: null,
      text: row.text
    });
    expect((await listInputs())[0]?.sendAuthorizedAt).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: null }]);
  });
  it.each([
    'The Core connector identity is unavailable. Refresh or recreate Core in ChatGPT before sending.',
    'Requested model or reasoning could not be confirmed',
    'ChatGPT did not accept the text (editor_replaced)',
    'Attachment upload was not confirmed. Check the unsent draft and any file error in ChatGPT before trying again.'
  ])('bounded-reoffers the same UUID after an exact pre-Send preparation failure: %s', async error => {
    const row = await enqueueInput(input({ sessionId: null }));
    expect(await claimBrowserInput(row.id, 'page-one', null, true)).not.toBeNull();
    expect(await failBrowserInput(row.id, 'page-one', error)).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ id: row.id, state: 'queued', owner: null, preSendReoffers: 1 });

    now += 1_501;
    expect(await claimBrowserInput(row.id, 'page-two', null, true)).not.toBeNull();
    expect(await failBrowserInput(row.id, 'page-two', error)).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ id: row.id, state: 'queued', owner: null, preSendReoffers: 2 });

    now += 5_001;
    expect(await claimBrowserInput(row.id, 'page-three', null, true)).not.toBeNull();
    expect(await failBrowserInput(row.id, 'page-three', error)).toBe(true);
    resetInputForTests();
    const exhausted = (await listInputs())[0];
    expect(exhausted).toMatchObject({
      id: row.id,
      state: 'failed',
      owner: null,
      preSendReoffers: 3,
      requiresAuthorization: true,
      error
    });
    expect(exhausted).not.toHaveProperty('sendAuthorizedAt');
    expect(exhausted).not.toHaveProperty('deliveredAt');
    expect(exhausted).not.toHaveProperty('messageId');
    expect(await pendingBrowserInputs()).toEqual([]);
  });
  it('migrates only the legacy exhausted positive pre-Send cancellation into explicit retry eligibility', async () => {
    const legacyError = 'Needs attention: browser preparation failed 3 times before native Send. The exact message is saved and was not sent.';
    const eligible = {
      ...input({ sessionId: null, text: 'Eligible legacy task' }),
      state: 'cancelled' as const,
      owner: null,
      createdAt: now,
      conversationId: null,
      preSendReoffers: 3,
      error: legacyError
    };
    const ambiguous = {
      ...input({ sessionId: null, text: 'Ambiguous legacy task' }),
      state: 'cancelled' as const,
      owner: null,
      createdAt: now + 1,
      conversationId: null,
      preSendReoffers: 3,
      sendAuthorizedAt: now,
      error: legacyError
    };
    await writeDurableNow('session-input', [eligible, ambiguous]);
    resetInputForTests();

    const rows = await listInputs();
    expect(rows.find(row => row.id === eligible.id)).toMatchObject({
      state: 'failed', owner: null, requiresAuthorization: true, error: legacyError
    });
    expect(rows.find(row => row.id === ambiguous.id)).toMatchObject({
      state: 'cancelled', owner: null, sendAuthorizedAt: now, error: legacyError
    });
  });
  it('keeps the same-chat follower behind the exact UUID rearmed by positive pre-Send proof', async () => {
    binding.model = 'gpt-5.6-sol';
    const first = await enqueueInput(input({ text: 'First instruction' }));
    const follower = await enqueueInput(input({ text: 'Second instruction' }));
    expect(follower).toMatchObject({ state: 'queued', queuedBehindDelivery: true });
    expect(await claimBrowserInput(first.id, 'page-one', binding.conversationId, true)).not.toBeNull();
    expect(await authorizeBrowserInput(first.id, 'page-one', binding.conversationId)).toBe(true);

    expect(await failBrowserInput(first.id, 'page-one', 'Native Send was not attempted.', {
      confirmedUnsent: true,
      conversationId: binding.conversationId
    })).toBe(true);
    resetInputForTests();

    expect((await listInputs()).find(row => row.id === first.id)).toMatchObject({
      id: first.id,
      sessionId,
      conversationId: binding.conversationId,
      state: 'queued',
      owner: null
    });
    expect((await listInputs()).find(row => row.id === follower.id)).toMatchObject({
      id: follower.id,
      state: 'queued',
      queuedBehindDelivery: true
    });
    expect(await pendingBrowserInputs()).toEqual([{ id: first.id, conversationId: binding.conversationId }]);
  });
  it('never reopens an authorized browser delivery without positive pre-Send proof', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    expect(await claimBrowserInput(row.id, 'owner', null, true)).not.toBeNull();
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(true);

    expect(await failBrowserInput(row.id, 'owner', 'Authorization response was unavailable.')).toBe(true);
    resetInputForTests();

    expect((await listInputs())[0]).toMatchObject({ id: row.id, state: 'failed' });
    expect(await pendingBrowserInputs()).toEqual([]);
  });
  it('never lets a pre-Send release reopen an already acknowledged native delivery', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    expect(await claimBrowserInput(row.id, 'owner', null, true)).not.toBeNull();
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId, 'native-user')).toBe(true);
    expect(await failBrowserInput(row.id, 'owner', 'Native Send was not attempted.', {
      confirmedUnsent: true,
      conversationId: null
    })).toBe(false);
    resetInputForTests();

    expect((await listInputs())[0]).toMatchObject({
      id: row.id,
      state: 'sent',
      messageId: 'native-user',
      conversationId: binding.conversationId
    });
    expect(await pendingBrowserInputs()).toEqual([]);
  });
  it('cancels an ambiguous browser claim across restart and retains a late receipt without automation or stages', async () => {
    const row = await enqueueInput(input({ sessionId: null, automation: 'goal', stages: ['Later task'] }));
    await claimBrowserInput(row.id, 'owner', null);
    expect(await authorizeBrowserInput(row.id, 'other', null)).toBe(false);
    expect(await authorizeBrowserInput(row.id, 'owner', 'wrong-conversation')).toBe(false);
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(true);
    resetInputForTests();
    expect(await cancelInput(row.id)).toBe(true);
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'owner', null)).toBeNull();
    expect(await acknowledgeBrowserInput(row.id, 'other', binding.conversationId, 'native-id')).toBe(false);
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', error: expect.stringContaining('may already') });
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId, 'native-id')).toBe(true);
    expect(automate).not.toHaveBeenCalled();
    resetInputForTests();
    const rows = await listInputs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'cancelled', messageId: 'native-id', error: expect.stringContaining('later confirmed') });
    expect(await enqueueInput(input({ ...row }))).toMatchObject({ state: 'cancelled' });
    expect(await cancelInput(row.id)).toBe(false);
  });
  it('persists a late native message id when an ID-less cancelled ACK is retried after restart', async () => {
    const row = await enqueueInput(input());
    expect(await claimBrowserInput(row.id, 'owner', binding.conversationId, true)).not.toBeNull();
    expect(await authorizeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(true);
    expect(await cancelInput(row.id)).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(true);
    expect((await listInputs())[0]).toMatchObject({
      state: 'cancelled', deliveredAt: expect.any(Number), error: expect.stringContaining('later confirmed')
    });
    expect((await listInputs())[0]?.messageId).toBeUndefined();

    resetInputForTests();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId, 'native-after-restart')).toBe(true);
    resetInputForTests();

    expect((await listInputs())[0]).toMatchObject({
      state: 'cancelled', messageId: 'native-after-restart', deliveredAt: expect.any(Number),
      error: expect.stringContaining('later confirmed')
    });
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId, 'conflicting-native-id')).toBe(false);
    expect((await listInputs())[0]?.messageId).toBe('native-after-restart');
  });
  it('persists a late native message id when an ID-less sent ACK is retried after restart', async () => {
    const row = await enqueueInput(input());
    expect(await claimBrowserInput(row.id, 'owner', binding.conversationId, true)).not.toBeNull();
    expect(await authorizeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', deliveredAt: expect.any(Number) });
    expect((await listInputs())[0]?.messageId).toBeUndefined();

    resetInputForTests();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId, 'native-sent-after-restart')).toBe(true);
    resetInputForTests();

    expect((await listInputs())[0]).toMatchObject({
      state: 'sent', messageId: 'native-sent-after-restart', deliveredAt: expect.any(Number)
    });
    expect(await pendingBrowserInputs()).toEqual([]);
  });
  it('attaches a newly observed exact route to an already delivered temporary helper after restart', async () => {
    const bindHelper = vi.fn(async () => undefined);
    configureInputDelivery({ applyAutomation: automate, changed, bindHelper });
    const controller = new AbortController();
    const answer = requestBrowserDecision('Keep the accepted answer owned', controller.signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner', conversationId: null
    });
    const rejected = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    expect(await claimBrowserInput(row.id, 'exact-helper-document', null, true)).toMatchObject({ id: row.id });
    expect(await authorizeBrowserInput(row.id, 'exact-helper-document', null)).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'exact-helper-document', null, 'native-helper-user')).toBe(true);
    controller.abort(); await rejected;
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', conversationId: null,
      messageId: 'native-helper-user', deliveredAt: expect.any(Number) });

    // The original page learns its route only after the first ACK and a cold outbox read.
    expect(await acknowledgeBrowserInput(row.id, 'foreign-document', binding.conversationId, 'native-helper-user')).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'exact-helper-document', binding.conversationId, 'native-helper-user')).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', conversationId: binding.conversationId,
      deliveredSessionId: sessionId, messageId: 'native-helper-user' });
    expect(bindHelper).toHaveBeenCalledOnce();
    expect(bindHelper).toHaveBeenCalledWith(binding.conversationId, sessionId);
    expect(await acknowledgeBrowserInput(row.id, 'exact-helper-document', 'contradictory-route', 'native-helper-user')).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
  });
  it('requires native message identity before attaching a newly surfaced temporary-helper route', async () => {
    const bindHelper = vi.fn(async () => undefined);
    configureInputDelivery({ applyAutomation: automate, changed, bindHelper });
    const controller = new AbortController();
    const answer = requestBrowserDecision('Bind only receipt-proven helper', controller.signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner', conversationId: null
    });
    const rejected = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    expect(await claimBrowserInput(row.id, 'original-page', null, true)).not.toBeNull();
    expect(await authorizeBrowserInput(row.id, 'original-page', null)).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'original-page', null)).toBe(true);
    controller.abort(); await rejected;
    resetInputForTests();

    expect(await acknowledgeBrowserInput(row.id, 'original-page', binding.conversationId)).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ conversationId: null });
    expect((await listInputs())[0]?.messageId).toBeUndefined();
    expect(bindHelper).not.toHaveBeenCalled();
    expect(await acknowledgeBrowserInput(row.id, 'original-page', binding.conversationId, 'later-native-id')).toBe(true);
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', conversationId: binding.conversationId,
      messageId: 'later-native-id', deliveredSessionId: sessionId });
    // Source ACK binds once; the cold outbox owner restamps the same role on restore.
    expect(bindHelper).toHaveBeenCalledTimes(2);
    expect(bindHelper).toHaveBeenNthCalledWith(1, binding.conversationId, sessionId);
    expect(bindHelper).toHaveBeenNthCalledWith(2, binding.conversationId, sessionId);
    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('awaiting-answer');
  });
  it('releases an authorized ambiguous browser delivery after the bounded receipt wait and still accepts its late exact receipt', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const row = await enqueueInput(input({ sessionId: null }));
      await claimBrowserInput(row.id, 'owner', null, true);
      expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(true);
      const authorized = (await listInputs())[0]!;
      expect(authorized).toMatchObject({ state: 'browser', sendAuthorizedAt: now });

      clock.mockReturnValue(now + BROWSER_RECEIPT_WAIT_MS + 1);
      expect((await listInputs())[0]).toMatchObject({
        state: 'cancelled',
        error: expect.stringContaining('may already have been sent')
      });
      expect(await pendingBrowserInputs()).toEqual([]);
      expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId, 'late-native-user')).toBe(true);
      expect((await listInputs())[0]).toMatchObject({
        state: 'cancelled',
        messageId: 'late-native-user',
        error: expect.stringContaining('later confirmed')
      });
    } finally { clock.mockRestore(); }
  });
  it('enables a requested Loop when a timed-out Send later receives its exact native receipt', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const row = await enqueueInput(input({ sessionId: null, automation: 'loop', objective: 'Keep improving this workspace.' }));
      await claimBrowserInput(row.id, 'owner', null, true);
      expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(true);
      clock.mockReturnValue(now + BROWSER_RECEIPT_WAIT_MS + 1);
      expect((await listInputs())[0]).toMatchObject({ state: 'cancelled' });

      expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId, 'late-loop-user')).toBe(true);
      expect(automate).toHaveBeenCalledWith(
        binding.conversationId, 'loop', 'after-send', 'Keep improving this workspace.', undefined, true
      );
      expect((await listInputs())[0]).toMatchObject({
        state: 'cancelled', messageId: 'late-loop-user', error: expect.stringContaining('later confirmed')
      });
    } finally { clock.mockRestore(); }
  });
  it('does not publish a rejected enqueue through a background durable retry', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk busy'));
    await expect(enqueueInput(input())).rejects.toThrow('disk busy');
    await flushDurable();
    expect(await readDurable('session-input')).toEqual([]);
    expect(await listInputs()).toEqual([]);
  });
  it('does not disclose input when durable claim fails and leaves it claimable', async () => {
    const row = await enqueueInput(input());
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk busy'));
    await expect(claimBrowserInput(row.id, 'first', binding.conversationId)).rejects.toThrow('disk busy');
    await flushDurable();
    resetInputForTests();
    expect(await claimBrowserInput(row.id, 'second', binding.conversationId)).toMatchObject({ owner: 'second' });
  });
  it('legacy queue: refuses blocked or unidentified callers and caps aggregate tool output', async () => {
    configureInputDelivery({ applyAutomation: automate, changed, prepareText: entry => entry.text.repeat(2) });
    for (let i = 0; i < 3; i++) await seedLegacyInput(input({ text: 'é'.repeat(16000) }));
    const queued = await enqueueInput(input());
    expect(queued).toMatchObject({ mode: 'after-turn', requestedMode: 'auto', queuedBehindDelivery: true, state: 'queued' });
    expect(await offerToolInput(null, binding.conversationId, 'request', 0)).toEqual([]);
    binding.blocked = true;
    expect(await offerToolInput(sessionId, binding.conversationId, 'request', 0)).toEqual([]);
    binding.blocked = false;
    const result = await offerToolInput(sessionId, binding.conversationId, 'request', 0);
    expect(result.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.map(row => row.text).join(''))).toBeLessThanOrEqual(128000);
    expect((await listInputs()).some(row => row.state === 'queued')).toBe(true);
  });
});

describe('browser decision lifetime', () => {
  it('uses durable pause for helper admission without waking Chrome or creating another hold owner', async () => {
    const wakeDecision = vi.fn(async () => undefined);
    configureInputDelivery({ applyAutomation: automate, changed, wakeDecision });
    binding.automationPaused = true;
    await expect(requestBrowserDecision('Held by the account owner', new AbortController().signal))
      .rejects.toThrow('goal_browser_automation_paused');
    await setBrowserDecisionAuthentication('signed-in');
    await expect(requestBrowserDecision('Auth cannot clear durable pause', new AbortController().signal))
      .rejects.toThrow('goal_browser_automation_paused');
    expect(await listInputs()).toEqual([]);
    expect(wakeDecision).not.toHaveBeenCalled();
    binding.automationPaused = false;
    const pending = requestBrowserDecision('Legitimate Resume', new AbortController().signal);
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'resumed-page', null, true);
    await authorizeBrowserInput(row.id, 'resumed-page', null);
    await completeBrowserDecision(row.id, 'resumed-page', 'Resume answer');
    await expect(pending).resolves.toBe('Resume answer');
  });
  it.each([false, true])('suspends only confirmed-unsent helpers on durable pause and allows one new owner after Resume (claimed=%s)', async claimed => {
    const ordinary = await enqueueInput(input());
    let releaseWake!: () => void;
    configureInputDelivery({ applyAutomation: automate, changed,
      wakeDecision: () => new Promise<void>(resolve => { releaseWake = resolve; }) });
    const pending = requestBrowserDecision('Preserve this source', new AbortController().signal, {
      sourceSessionId: sessionId, sourceTurnId: 'same-exact-turn', lifetime: 'temporary-planner'
    });
    const row = (await listInputs()).find(entry => entry.purpose === 'decision')!;
    await vi.waitFor(() => expect(releaseWake).toBeTypeOf('function'));
    if (claimed) await claimBrowserInput(row.id, 'preparing-page', null, true);
    binding.automationPaused = true;
    // Authorization independently observes durable config before the asynchronous suspension.
    expect(await authorizeBrowserInput(row.id, 'preparing-page', null)).toBe(false);
    expect(await claimBrowserInput(row.id, 'late-page', null, true)).toBeNull();
    await suspendPausedBrowserDecisionWaits();
    await expect(pending).rejects.toThrow('goal_browser_automation_paused');
    releaseWake();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'cancelled', error: 'goal_browser_automation_paused', owner: claimed ? 'preparing-page' : null
    });
    expect((await listInputs()).find(entry => entry.id === ordinary.id)).toMatchObject({ state: 'queued' });
    binding.automationPaused = false;
    // A delayed timeout classifier retains the original hold, even after Resume.
    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('automation-paused');
    const replacement = requestBrowserDecision('Resume the exact source', new AbortController().signal, {
      sourceSessionId: sessionId, sourceTurnId: 'same-exact-turn', lifetime: 'temporary-planner'
    });
    const next = (await listInputs()).find(entry => entry.purpose === 'decision' && entry.state === 'queued')!;
    expect(next.id).not.toBe(row.id);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('failed');
    configureInputDelivery({ applyAutomation: automate, changed });
    releaseWake();
    await claimBrowserInput(next.id, 'resumed-page', null, true);
    await authorizeBrowserInput(next.id, 'resumed-page', null);
    await completeBrowserDecision(next.id, 'resumed-page', 'Resume answer');
    await expect(replacement).resolves.toBe('Resume answer');
    expect((await listInputs()).filter(entry => entry.purpose === 'decision')).toHaveLength(2);
    expect(await claimBrowserInput(row.id, 'obsolete-page', null, true)).toBeNull();
  });
  it.each(['authorized', 'delivered', 'legacy-ambiguous'] as const)(
    'keeps the existing %s helper waiter and native ownership across durable pause', async phase => {
      const pending = requestBrowserDecision('Keep native custody', new AbortController().signal, {
        sourceSessionId: sessionId, lifetime: 'temporary-planner'
      });
      const row = (await listInputs())[0]!;
      await claimBrowserInput(row.id, 'native-owner', null, phase !== 'legacy-ambiguous');
      if (phase !== 'legacy-ambiguous') await authorizeBrowserInput(row.id, 'native-owner', null);
      if (phase === 'delivered') await acknowledgeBrowserInput(row.id, 'native-owner', null, 'native-message');
      const before = (await listInputs()).find(entry => entry.id === row.id)!;
      binding.automationPaused = true;
      await suspendPausedBrowserDecisionWaits();
      expect((await listInputs()).find(entry => entry.id === row.id)).toEqual(before);
      expect(await completeBrowserDecision(row.id, 'native-owner', 'Already running answer')).toBe(true);
      await expect(pending).resolves.toBe('Already running answer');
    });
  it('ignores a delayed suspension hook after the durable account owner resumed', async () => {
    const pending = requestBrowserDecision('Keep exact active request', new AbortController().signal);
    const row = (await listInputs())[0]!;
    binding.automationPaused = true;
    const suspension = suspendPausedBrowserDecisionWaits();
    binding.automationPaused = false;
    await suspension;
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('queued');
    await claimBrowserInput(row.id, 'resumed-page', null, true);
    await authorizeBrowserInput(row.id, 'resumed-page', null);
    await completeBrowserDecision(row.id, 'resumed-page', 'Exact active answer');
    await expect(pending).resolves.toBe('Exact active answer');
  });
  it.each(['claim', 'authorize'] as const)('rechecks durable pause at the final %s authority boundary', async phase => {
    const pending = requestBrowserDecision('Pause raced preparation', new AbortController().signal);
    const row = (await listInputs())[0]!;
    if (phase === 'authorize') await claimBrowserInput(row.id, 'racing-page', null, true);
    const config = await import('../src/main/config.js');
    const original = config.getConfig;
    let reads = 0;
    const spy = vi.spyOn(config, 'getConfig').mockImplementation(() => {
      const snapshot = original();
      reads += 1;
      // Claim has a second config read while assembling the already-prepared body;
      // authorization awaits its exact target after the first admission read.
      if (reads === (phase === 'claim' ? 2 : 1)) binding.automationPaused = true;
      return snapshot;
    });
    try {
      if (phase === 'claim') expect(await claimBrowserInput(row.id, 'racing-page', null, true)).toBeNull();
      else expect(await authorizeBrowserInput(row.id, 'racing-page', null)).toBe(false);
    } finally { spy.mockRestore(); }
    expect((await listInputs()).find(entry => entry.id === row.id)?.sendAuthorizedAt).toBeUndefined();
    await suspendPausedBrowserDecisionWaits();
    await expect(pending).rejects.toThrow('goal_browser_automation_paused');
  });
  it('invokes the accepted-failure callback only after exact durable ownership and preserves its diagnostics', async () => {
    const pending = requestBrowserDecision('Exact warning request', new AbortController().signal);
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'exact-warning-page', null, true);
    const onAcceptedFailure = vi.fn(async () => {
      const saved = await readDurable<InputEntry[]>('session-input');
      expect(saved?.find(entry => entry.id === row.id)).toMatchObject({ state: 'failed', error: 'Provider quick-check required' });
      binding.automationPaused = true;
      // Real Bridge enqueues this hook without awaiting it inside the Input serializer.
      void suspendPausedBrowserDecisionWaits();
    });
    const rejected = expect(pending).rejects.toThrow('goal_browser_send_failed');
    expect(await failBrowserInput(row.id, 'foreign-page', 'Provider quick-check required', { onAcceptedFailure })).toBe(false);
    expect(onAcceptedFailure).not.toHaveBeenCalled();
    expect(binding.automationPaused).toBe(false);
    expect(await failBrowserInput(row.id, 'exact-warning-page', 'Provider quick-check required', { onAcceptedFailure })).toBe(true);
    await rejected;
    expect(onAcceptedFailure).toHaveBeenCalledTimes(1);
    expect(await failBrowserInput(row.id, 'exact-warning-page', 'Provider quick-check required', { onAcceptedFailure })).toBe(false);
    expect(onAcceptedFailure).toHaveBeenCalledTimes(1);
  });
  it.each(['unsent', 'authorized', 'delivered', 'legacy-ambiguous'] as const)(
    'does not misclassify a %s provider warning as a spent hold or unsent replay', async phase => {
      const pending = requestBrowserDecision('Exact provider-warning helper', new AbortController().signal, {
        sourceSessionId: sessionId, lifetime: 'temporary-planner'
      });
      const row = (await listInputs())[0]!;
      await claimBrowserInput(row.id, 'warning-page', null, phase !== 'legacy-ambiguous');
      if (phase === 'authorized' || phase === 'delivered') await authorizeBrowserInput(row.id, 'warning-page', null);
      if (phase === 'delivered') await acknowledgeBrowserInput(row.id, 'warning-page', null, 'native-message');
      const rejected = expect(pending).rejects.toThrow('goal_browser_send_failed');
      expect(await failBrowserInput(row.id, 'warning-page', 'Provider account quick-check required')).toBe(true);
      await rejected;
      binding.automationPaused = true;
      expect(await settleTimedOutBrowserHelper(sessionId)).toBe(phase === 'unsent' ? 'automation-paused' : 'none');
      expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
        state: 'failed', error: 'Provider account quick-check required', owner: 'warning-page'
      });
    });
  it('never borrows an older unsent cancellation to mask a later authorized warning failure', async () => {
    const pending = requestBrowserDecision('Current authorized request', new AbortController().signal, {
      sourceSessionId: sessionId, sourceTurnId: 'current-turn', lifetime: 'temporary-planner'
    });
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'current-native-owner', null, true);
    await authorizeBrowserInput(row.id, 'current-native-owner', null);
    const rejected = expect(pending).rejects.toThrow('goal_browser_send_failed');
    await failBrowserInput(row.id, 'current-native-owner', 'Provider quick-check required');
    await rejected;
    // Cold legacy history may retain unrelated cancelled attempts. It is not proof
    // that the latest exact failed request stayed before its native Send boundary.
    const older: InputEntry = { ...input({ sessionId: null }), purpose: 'decision', lifetime: 'temporary-planner',
      decisionSourceSessionId: sessionId, decisionSourceTurnId: 'older-turn', state: 'cancelled',
      owner: null, createdAt: now - 1, conversationId: null };
    await writeDurableNow('session-input', [older, ...await listInputs()]);
    resetInputForTests();
    binding.automationPaused = true;
    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('none');
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'failed', sendAuthorizedAt: expect.any(Number), error: 'Provider quick-check required'
    });
  });
  it('does not enqueue or wake a helper under positive sign-out, and unknown cannot clear the hold', async () => {
    const wakeDecision = vi.fn(async () => undefined);
    configureInputDelivery({ applyAutomation: automate, changed, wakeDecision });
    await setBrowserDecisionAuthentication('signed-out');
    await expect(requestBrowserDecision('Do not open another tab', new AbortController().signal))
      .rejects.toThrow('goal_browser_signed_out');
    await setBrowserDecisionAuthentication('unknown');
    await expect(requestBrowserDecision('Still held', new AbortController().signal))
      .rejects.toThrow('goal_browser_signed_out');
    expect(await listInputs()).toEqual([]);
    expect(wakeDecision).not.toHaveBeenCalled();
    await setBrowserDecisionAuthentication('signed-in');
    const answer = requestBrowserDecision('Now legitimately available', new AbortController().signal);
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'signed-in-page', null);
    expect(await completeBrowserDecision(row.id, 'signed-in-page', 'Native answer')).toBe(true);
    await expect(answer).resolves.toBe('Native answer');
  });
  it.each([false, true])('interrupts a confirmed-unsent helper immediately on sign-out while preserving ordinary queued work (claimed=%s)', async claimed => {
    const ordinary = await enqueueInput(input());
    let releaseWake!: () => void;
    configureInputDelivery({ applyAutomation: automate, changed,
      wakeDecision: () => new Promise<void>(resolve => { releaseWake = resolve; }) });
    const pending = requestBrowserDecision('Exact unsent helper', new AbortController().signal, { sourceSessionId: sessionId });
    const row = (await listInputs()).find(entry => entry.purpose === 'decision')!;
    await vi.waitFor(() => expect(releaseWake).toBeTypeOf('function'));
    if (claimed) expect(await claimBrowserInput(row.id, 'preparation-owner', null, true)).not.toBeNull();
    await setBrowserDecisionAuthentication('signed-out');
    await expect(pending).rejects.toThrow('goal_browser_signed_out');
    releaseWake();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'cancelled', error: 'goal_browser_signed_out', owner: claimed ? 'preparation-owner' : null });
    expect((await listInputs()).find(entry => entry.id === ordinary.id)).toMatchObject({ state: 'queued' });
    expect(await claimBrowserInput(ordinary.id, 'stale-signed-out-page', binding.conversationId)).toBeNull();
    expect(await claimBrowserInput(row.id, 'late-helper-page', null)).toBeNull();
    expect(await authorizeBrowserInput(row.id, 'preparation-owner', null)).toBe(false);
  });
  it('does not remint a signed-out source helper after Main restart before fresh positive sign-in', async () => {
    const wakeDecision = vi.fn(async () => undefined);
    configureInputDelivery({ applyAutomation: automate, changed, wakeDecision });
    const exact = { sourceSessionId: sessionId, sourceTurnId: 'signed-out-restart-source', lifetime: 'temporary-planner' as const };
    const first = requestBrowserDecision('Retain signed-out source', new AbortController().signal, exact);
    const original = (await listInputs())[0]!;
    await setBrowserDecisionAuthentication('signed-out');
    await expect(first).rejects.toThrow('goal_browser_signed_out');
    expect((await listInputs()).find(row => row.id === original.id)).toMatchObject({
      state: 'cancelled', error: 'goal_browser_signed_out', owner: null
    });
    resetInputForTests(); // The durable cancelled row survives while process-local auth evidence does not.
    const abort = new AbortController();
    const unexpected = requestBrowserDecision('No requeue without a fresh signed-in observation', abort.signal, exact);
    const observed = unexpected.then(() => 'resolved', error => String(error));
    try {
      expect((await listInputs()).filter(row => row.purpose === 'decision')).toHaveLength(1);
      expect(await observed).toContain('goal_browser_signed_out');
      expect(wakeDecision).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await observed;
    }
    await setBrowserDecisionAuthentication('signed-in');
    const resumed = requestBrowserDecision('Fresh positive sign-in permits the exact source', new AbortController().signal, exact);
    const next = (await listInputs()).find(row => row.purpose === 'decision' && row.state === 'queued')!;
    expect(next.id).not.toBe(original.id);
    await claimBrowserInput(next.id, 'newly-signed-in-page', null, true);
    await authorizeBrowserInput(next.id, 'newly-signed-in-page', null);
    expect(await completeBrowserDecision(next.id, 'newly-signed-in-page', 'Current native answer')).toBe(true);
    await expect(resumed).resolves.toBe('Current native answer');
  });
  it.each([false, true])('preserves an authorized helper waiter and receipt across sign-out (delivered=%s)', async delivered => {
    const pending = requestBrowserDecision('Preserve native custody', new AbortController().signal, { sourceSessionId: sessionId, lifetime: 'temporary-planner' });
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'native-helper-page', null, true);
    expect(await authorizeBrowserInput(row.id, 'native-helper-page', null)).toBe(true);
    if (delivered) expect(await acknowledgeBrowserInput(row.id, 'native-helper-page', null, 'native-message')).toBe(true);
    await setBrowserDecisionAuthentication('signed-out');
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ owner: 'native-helper-page', sendAuthorizedAt: expect.any(Number) });
    expect(await completeBrowserDecision(row.id, 'native-helper-page', 'Already running answer')).toBe(true);
    await expect(pending).resolves.toBe('Already running answer');
  });
  it('settles an unclaimed helper when its 180-second owner aborts during a stuck browser wake', async () => {
    let releaseWake!: () => void;
    const wakeDecision = vi.fn(() => new Promise<void>(resolve => { releaseWake = resolve; }));
    configureInputDelivery({ applyAutomation: automate, changed, wakeDecision });
    const controller = new AbortController();
    const first = requestBrowserDecision('Choose', controller.signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    });
    const row = (await listInputs())[0]!;
    await vi.waitFor(() => expect(wakeDecision).toHaveBeenCalledTimes(1));

    // Goal's 180-second timer fires while the bridge is still waking Chrome. A wake that
    // ignores cancellation cannot hold the exact outbox owner or Goal draft indefinitely.
    controller.abort();
    const result = await Promise.race([
      first.then(() => 'resolved', error => String(error)),
      new Promise<string>(resolve => setTimeout(() => resolve('stuck waking browser'), 500))
    ]);
    releaseWake();
    expect(result).toContain('goal_browser_cancelled');
    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('queued-unclaimed');
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'failed', owner: null, error: 'Timed-out helper confirmed unsent before browser claim'
    });
    expect(await claimBrowserInput(row.id, 'late-wake-document', null)).toBeNull();
    expect(await completeBrowserDecision(row.id, 'late-wake-document', 'Late answer')).toBe(false);

    const next = requestBrowserDecision('Choose again', new AbortController().signal, { sourceSessionId: sessionId });
    const replacement = (await listInputs()).find(entry => entry.state === 'queued')!;
    expect(replacement.id).not.toBe(row.id);
    await claimBrowserInput(replacement.id, 'replacement-document', null);
    expect(await completeBrowserDecision(replacement.id, 'replacement-document', 'Fresh answer')).toBe(true);
    await expect(next).resolves.toBe('Fresh answer');
  });
  it('preserves an ambiguous Send fence when the wake hangs after native authorization', async () => {
    let releaseWake!: () => void;
    configureInputDelivery({ applyAutomation: automate, changed,
      wakeDecision: () => new Promise<void>(resolve => { releaseWake = resolve; }) });
    const controller = new AbortController();
    const first = requestBrowserDecision('Choose', controller.signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    });
    const row = (await listInputs())[0]!;
    expect(await claimBrowserInput(row.id, 'send-owner', null, true)).not.toBeNull();
    expect(await authorizeBrowserInput(row.id, 'send-owner', null)).toBe(true);
    controller.abort();
    await expect(first).rejects.toThrow('goal_browser_cancelled');
    releaseWake();

    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('send-outcome-unconfirmed');
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'cancelled', owner: 'send-owner', sendAuthorizedAt: expect.any(Number)
    });
    await expect(requestBrowserDecision('Choose again', new AbortController().signal, { sourceSessionId: sessionId }))
      .rejects.toThrow('goal_browser_send_unconfirmed');
    expect(await completeBrowserDecision(row.id, 'send-owner', 'Late answer')).toBe(false);
    expect(await listInputs()).toHaveLength(1);
  });
  it('does not redeem a fresh scheduled marker before its due time', async () => {
    const entry = await enqueueInput(input({ sessionId: null, dueAt: now + 60000 }));
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(entry.id, 'fresh-marker-document', null)).toBeNull();
    now += 60000;
    expect(await pendingBrowserInputs()).toEqual([{ id: entry.id, conversationId: null }]);
    expect(await claimBrowserInput(entry.id, 'fresh-marker-document', null)).toMatchObject({ id: entry.id, state: 'browser' });
  });
  it('requires a deliberate exact-source retry and never revives the previous owner', async () => {
    const controller = new AbortController();
    const first = requestBrowserDecision('Choose', controller.signal, { sourceSessionId: sessionId });
    const rejected = expect(first).rejects.toThrow('cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'old-document', null);
    controller.abort(); await rejected;
    expect(await pausedBrowserHelpers()).toEqual([{ id: row.id, sourceSessionId: sessionId }]);
    expect(await authorizeBrowserHelperRetry(row.id, 'wrong-source')).toBe(false);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk busy'));
    await expect(authorizeBrowserHelperRetry(row.id, sessionId)).rejects.toThrow('disk busy');
    await flushDurable();
    expect(await pausedBrowserHelpers()).toHaveLength(1);
    expect(await authorizeBrowserHelperRetry(row.id, sessionId)).toBe(true);
    expect(await authorizeBrowserHelperRetry(row.id, sessionId)).toBe(false);
    expect(await completeBrowserDecision(row.id, 'old-document', 'late')).toBe(false);
    expect(await pausedBrowserHelpers()).toEqual([]);
    const second = requestBrowserDecision('Choose again', new AbortController().signal, { sourceSessionId: sessionId });
    const next = (await listInputs()).find(entry => entry.state === 'queued')!;
    expect(next.id).not.toBe(row.id);
    await claimBrowserInput(next.id, 'new-document', null);
    expect(await completeBrowserDecision(next.id, 'new-document', 'accepted', 'helper-new-chat')).toBe(true);
    await expect(second).resolves.toBe('accepted');
  });
  it('retires duplicate unconfirmed warnings for one source while authorizing only one replacement', async () => {
    const ids: string[] = [randomUUID(), randomUUID()];
    const rows: InputEntry[] = ids.map((id, attempt) => ({
      ...input({ id, sessionId: null, text: `Choose ${attempt}` }),
      purpose: 'decision', lifetime: 'temporary-planner', decisionSourceSessionId: sessionId,
      state: 'cancelled', owner: `old-document-${attempt}`, createdAt: now + attempt,
      conversationId: null, error: 'Browser helper delivery was not confirmed'
    }));
    await writeDurableNow('session-input', rows);
    resetInputForTests();
    expect(await pausedBrowserHelpers()).toEqual(ids.map(id => ({ id, sourceSessionId: sessionId })));
    expect(await authorizeBrowserHelperRetry(ids[1]!, sessionId)).toBe(true);
    expect(await pausedBrowserHelpers()).toEqual([]);
    expect((await listInputs()).filter(row => ids.includes(row.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ids[0], state: 'failed', error: 'User authorized a new helper' }),
      expect.objectContaining({ id: ids[1], state: 'failed', error: 'User authorized a new helper' })
    ]));
    expect(await authorizeBrowserHelperRetry(ids[0]!, sessionId)).toBe(false);
  });
  it('keeps an exact delivered helper fenced when its answer waiter expires', async () => {
    const controller = new AbortController();
    const first = requestBrowserDecision('Choose', controller.signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    });
    const rejected = expect(first).rejects.toThrow('cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'timed-out-document', null);
    expect(await acknowledgeBrowserInput(row.id, 'timed-out-document', null, 'timed-out-user-message')).toBe(true);
    controller.abort(); await rejected;
    expect(await settleTimedOutBrowserHelper('wrong-source')).toBe('none');
    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('awaiting-answer');
    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('awaiting-answer');
    expect(await completeBrowserDecision(row.id, 'timed-out-document', 'late')).toBe(false);
    await expect(requestBrowserDecision('Choose again', new AbortController().signal, { sourceSessionId: sessionId }))
      .rejects.toThrow('goal_browser_send_unconfirmed');
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'cancelled', messageId: 'timed-out-user-message'
    });
  });
  it('classifies a timed-out helper with no browser claim as confirmed pre-delivery', async () => {
    const controller = new AbortController();
    const first = requestBrowserDecision('Choose', controller.signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    });
    const rejected = expect(first).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    controller.abort();
    await rejected;

    const cancelled = (await listInputs()).find(entry => entry.id === row.id)!;
    expect(cancelled).toMatchObject({ state: 'cancelled', owner: null });
    expect(cancelled).not.toHaveProperty('offeredAt');
    expect(cancelled).not.toHaveProperty('sendAuthorizedAt');
    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('queued-unclaimed');
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'failed', error: 'Timed-out helper confirmed unsent before browser claim'
    });
  });
  it('keeps a claimed but pre-Send timeout in the browser-preparing phase', async () => {
    const controller = new AbortController();
    const first = requestBrowserDecision('Choose', controller.signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    });
    const rejected = expect(first).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    expect(await claimBrowserInput(row.id, 'preparing-document', null, true)).not.toBeNull();
    controller.abort();
    await rejected;

    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('browser-preparing');
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'failed', owner: 'preparing-document', requiresAuthorization: true,
      error: 'Timed-out helper confirmed unsent during browser preparation'
    });
  });
  it('classifies a timed-out helper with an exact native receipt as delivered, not pre-delivery', async () => {
    const controller = new AbortController();
    const first = requestBrowserDecision('Choose', controller.signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    });
    const rejected = expect(first).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'delivered-document', null, true);
    expect(await authorizeBrowserInput(row.id, 'delivered-document', null)).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'delivered-document', null, 'delivered-user-message')).toBe(true);
    controller.abort();
    await rejected;

    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('awaiting-answer');
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'cancelled', deliveredAt: expect.any(Number), messageId: 'delivered-user-message'
    });
  });
  it('preserves a delivered temporary helper after answer expiry across a cold restore without automatic replay', async () => {
    const abort = new AbortController();
    const pending = requestBrowserDecision('Original decision', abort.signal, { sourceSessionId: sessionId, lifetime: 'temporary-planner' });
    const rejected = expect(pending).rejects.toThrow('goal_browser_cancelled');
    const original = (await listInputs())[0]!;
    expect(await claimBrowserInput(original.id, 'original-claim', null, true)).not.toBeNull();
    expect(await authorizeBrowserInput(original.id, 'original-claim', null)).toBe(true);
    expect(await acknowledgeBrowserInput(original.id, 'original-claim', null, 'original-native-send')).toBe(true);
    abort.abort(); await rejected;

    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('awaiting-answer');
    expect((await listInputs()).find(row => row.id === original.id)).toMatchObject({
      state: 'cancelled', owner: 'original-claim', messageId: 'original-native-send', deliveredAt: expect.any(Number)
    });
    resetInputForTests(); // Simulate Main's in-memory waiter being lost at restart.
    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('awaiting-answer');
    await expect(requestBrowserDecision('Automatic duplicate', new AbortController().signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    })).rejects.toThrow('goal_browser_delivered_helper_unresolved');
    expect((await listInputs()).map(row => row.id)).toEqual([original.id]);
  });
  it.each(['delivered', 'authorized'] as const)(
    'fences a timed-out %s helper whose exact temporary conversation became known, including restart and explicit recovery',
    async phase => {
      const controller = new AbortController();
      const pending = requestBrowserDecision('Exact helper', controller.signal, {
        sourceSessionId: sessionId, lifetime: 'temporary-planner'
      });
      const rejected = expect(pending).rejects.toThrow('goal_browser_cancelled');
      const original = (await listInputs())[0]!;
      const helperConversation = 'helper-bound-20261009';
      expect(await claimBrowserInput(original.id, 'bound-helper-page', null, true)).toMatchObject({ id: original.id });
      expect(await authorizeBrowserInput(original.id, 'bound-helper-page', null)).toBe(true);
      if (phase === 'delivered') {
        expect(await acknowledgeBrowserInput(original.id, 'bound-helper-page', helperConversation, 'native-bound-helper')).toBe(true);
      } else {
        // A page may reveal its route after native Send authority, without proving Send.
        expect(await acknowledgeBrowserInput(original.id, 'bound-helper-page', helperConversation)).toBe(true);
        // A native delivery with no user-message ID remains a delivered/ambiguous fence.
      }
      controller.abort();
      await rejected;
      resetInputForTests();

      expect(await settleTimedOutBrowserHelper(sessionId)).toBe('awaiting-answer');
      expect((await listInputs())[0]).toMatchObject({ id: original.id, state: 'cancelled',
        conversationId: helperConversation, deliveredAt: expect.any(Number),
        ...(phase === 'delivered' ? { messageId: 'native-bound-helper' } : {}) });
      await expect(requestBrowserDecision('Forbidden automatic replacement', new AbortController().signal, {
        sourceSessionId: sessionId, lifetime: 'temporary-planner'
      })).rejects.toThrow(phase === 'delivered' ? 'goal_browser_delivered_helper_unresolved' : 'goal_browser_send_unconfirmed');
      expect((await listInputs()).map(row => row.id)).toEqual([original.id]);
      expect(await pausedBrowserHelpers()).toContainEqual({ id: original.id, sourceSessionId: sessionId });

      // Only deliberate source activation can retire the old helper. Its original receipt
      // remains archived and never becomes a second Send for the same UUID.
      expect(await authorizeBrowserHelperRetry(original.id, 'wrong-source')).toBe(false);
      expect(await authorizeBrowserHelperRetry(original.id, sessionId)).toBe(true);
      expect((await listInputs())[0]).toMatchObject({ id: original.id, state: 'failed',
        deliveredAt: expect.any(Number), conversationId: helperConversation });
      const next = requestBrowserDecision('Deliberately reactivated', new AbortController().signal, {
        sourceSessionId: sessionId, lifetime: 'temporary-planner'
      });
      const nextRow = (await listInputs()).find(row => row.state === 'queued')!;
      expect(nextRow.id).not.toBe(original.id);
      expect(await claimBrowserInput(nextRow.id, 'reactivated-page', null)).toMatchObject({ id: nextRow.id });
      expect(await completeBrowserDecision(nextRow.id, 'reactivated-page', 'fresh-result')).toBe(true);
      await expect(next).resolves.toBe('fresh-result');
    }
  );
  it('blocks automatic reissue of a bound helper with native Send outcome still unknown, irrespective of replacement route', async () => {
    const route = 'already-bound-temporary';
    const abort = new AbortController();
    const originalAnswer = requestBrowserDecision('Original', abort.signal, {
      sourceSessionId: sessionId, conversationId: route, lifetime: 'temporary-planner'
    });
    const rejected = expect(originalAnswer).rejects.toThrow('goal_browser_cancelled');
    const original = (await listInputs())[0]!;
    expect(await claimBrowserInput(original.id, 'bound-document', route, true)).toMatchObject({ id: original.id });
    expect(await authorizeBrowserInput(original.id, 'bound-document', route)).toBe(true);
    abort.abort(); await rejected;
    resetInputForTests();

    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('send-outcome-unconfirmed');
    for (const nextRoute of [route, 'different-temporary-route']) {
      await expect(requestBrowserDecision('Automatic replacement forbidden', new AbortController().signal, {
        sourceSessionId: sessionId, conversationId: nextRoute, lifetime: 'temporary-planner'
      })).rejects.toThrow('goal_browser_send_unconfirmed');
    }
    expect((await listInputs()).map(row => row.id)).toEqual([original.id]);
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled',
      conversationId: route, sendAuthorizedAt: expect.any(Number) });
  });
  it.each(['new-turn', 'new-final', 'new-user', 'no-reason', 'plain-error', 'foreign-session', 'foreign-turn',
    'foreign-conversation', 'ambiguous-session', 'same-turn', 'metadata-only', 'send-unconfirmed', 'timeout',
    'settings', 'read-failure'] as const)(
    'permits only a different source after exact native helper supersession (%s)', async proof => {
    const oldTurn = 'old-canonical-source', nextTurn = 'successor-source-turn';
    const turn = { sourceSessionId: sessionId, sourceTurnId: oldTurn, lifetime: 'temporary-planner' as const };
    const controller = new AbortController();
    const answer = requestBrowserDecision('Decide the original source.', controller.signal, turn);
    const rejected = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const original = (await listInputs())[0]!;
    expect(await claimBrowserInput(original.id, 'original-helper-page', null, true)).not.toBeNull();
    now += 200;
    expect(await authorizeBrowserInput(original.id, 'original-helper-page', null)).toBe(true);
    if (proof !== 'send-unconfirmed')
      expect(await acknowledgeBrowserInput(original.id, 'original-helper-page', null, 'original-native-message')).toBe(true);
    const native = (await listInputs())[0]!;
    const oldFinal = { kind: 'assistant_message', turnId: oldTurn, messageId: 'old-native-final', seq: 2, origin: 2, time: 900,
      final: true, source: 'extension', message: { text: 'The original checkpoint.', chars: 24, truncated: false } };
    const boundary = proof === 'new-user'
      ? { kind: 'user_message', seq: 3, origin: 3, time: 1100, messageId: 'new-human-correction', source: 'extension' }
      : { kind: 'turn_start', seq: proof === 'metadata-only' ? 1 : 3,
        turnId: proof === 'same-turn' || proof === 'metadata-only' ? oldTurn : nextTurn, time: 1100, source: 'extension' };
    binding.activeTurnId = proof === 'new-final' ? null : boundary.kind === 'turn_start' ? boundary.turnId! : null;
    vi.mocked(readRecentEvents).mockImplementation(async (_id, _limit, query) => {
      if (proof === 'read-failure') throw new Error('Source proof read unavailable');
      if (query?.kinds?.includes('assistant_message')) return [oldFinal] as never;
      if (query?.kinds?.includes('user_message')) return [boundary] as never;
      return [proof === 'new-final' ? { kind: 'turn_end', seq: 5, turnId: nextTurn, outcome: 'completed' } : boundary] as never;
    });
    if (proof === 'ambiguous-session') vi.spyOn(await import('../src/main/session/store.js'), 'findSessionByConversation').mockResolvedValueOnce(null);
    const reason = proof === 'no-reason' ? undefined : proof === 'plain-error' ? new Error('goal_browser_source_superseded')
      : proof === 'timeout' ? new DOMException('Expired helper', 'TimeoutError') : proof === 'settings' ? new Error('settings_changed')
        : new BrowserDecisionSourceSuperseded(proof === 'foreign-session' ? 'foreign-source-session' : sessionId,
          proof === 'foreign-conversation' ? 'foreign-conversation' : binding.conversationId,
          proof === 'foreign-turn' ? 'foreign-source-turn' : oldTurn);
    controller.abort(reason);
    await rejected;
    resetInputForTests();
    const retired = (await listInputs())[0]!;
    const superseded = ['new-turn', 'new-final', 'new-user'].includes(proof);
    expect(retired).toMatchObject({ id: original.id, state: 'cancelled', owner: native.owner,
      sendAuthorizedAt: native.sendAuthorizedAt, ...(native.deliveredAt !== undefined
        ? { deliveredAt: native.deliveredAt, messageId: native.messageId } : {}) });
    expect(retired.goalSourceSuperseded).toBe(superseded ? true : undefined);
    expect(await completeBrowserDecision(original.id, 'original-helper-page', 'Late obsolete result', null, true)).toBe(false);
    if (!superseded) {
      expect(await pausedBrowserHelpers()).toContainEqual({ id: original.id, sourceSessionId: sessionId });
      await expect(requestBrowserDecision('A different source still cannot borrow ambiguous custody.', new AbortController().signal,
        { ...turn, sourceTurnId: nextTurn })).rejects.toThrow(proof === 'send-unconfirmed'
          ? 'goal_browser_send_unconfirmed' : 'goal_browser_delivered_helper_unresolved');
      return;
    }
    expect(await pausedBrowserHelpers()).toEqual([]);
    await expect(requestBrowserDecision('The obsolete source must never be reminted.', new AbortController().signal,
      { ...turn, allowAmbiguousRetry: true })).rejects.toThrow('goal_browser_source_superseded');
    const successor = requestBrowserDecision('Decide the legitimate different source.', new AbortController().signal,
      { ...turn, sourceTurnId: nextTurn });
    const next = (await listInputs()).find(row => row.id !== original.id)!;
    expect(next).toMatchObject({ state: 'queued', decisionSourceTurnId: nextTurn, owner: null });
    expect(await claimBrowserInput(next.id, 'successor-helper-page', null)).not.toBeNull();
    expect(await completeBrowserDecision(next.id, 'successor-helper-page', 'Current decision', null)).toBe(true);
    await expect(successor).resolves.toBe('Current decision');
    expect((await listInputs()).find(row => row.id === original.id)).toMatchObject({
      state: 'cancelled', goalSourceSuperseded: true, messageId: 'original-native-message'
    });
  });
  async function cancelledHelperWithCompletedSuccessor(cold: boolean, live?: 'browser' | 'decision') {
    const oldTurn = 'cancelled-source-a', nextTurn = 'completed-source-b';
    const originalController = new AbortController();
    const originalAnswer = requestBrowserDecision('Decide the original source.', originalController.signal, {
      sourceSessionId: sessionId, sourceTurnId: oldTurn, lifetime: 'temporary-planner'
    });
    const original = (await listInputs())[0]!;
    expect(await claimBrowserInput(original.id, 'cancelled-helper-document', null, true)).not.toBeNull();
    now += 100;
    expect(await authorizeBrowserInput(original.id, 'cancelled-helper-document', null)).toBe(true);
    if (live !== 'browser')
      expect(await acknowledgeBrowserInput(original.id, 'cancelled-helper-document', null, 'retained-native-helper-a')).toBe(true);
    if (!live) {
      const rejected = expect(originalAnswer).rejects.toThrow('goal_browser_cancelled');
      originalController.abort(new DOMException('Original answer window expired', 'TimeoutError'));
      await rejected;
    }
    if (cold) resetInputForTests();
    const retained = (await listInputs())[0]!;
    expect(retained.state).toBe(live ?? 'cancelled');
    expect(retained.goalSourceSuperseded).toBeUndefined();
    now += 100;
    const oldFinal = { kind: 'assistant_message', source: 'extension', seq: 2, origin: 2, time: 900,
      turnId: oldTurn, messageId: 'retained-source-final-a', final: true,
      message: { text: 'Original source result.', chars: 23, truncated: false } };
    const question = { kind: 'user_message', source: 'extension', seq: 3, origin: 3, time: 1100,
      messageId: 'successor-native-question-b' };
    const start = { kind: 'turn_start', source: 'extension', seq: 4, time: 1100, turnId: nextTurn };
    const final = { kind: 'assistant_message', source: 'extension', seq: 5, origin: 5, time: 1150,
      turnId: nextTurn, messageId: 'successor-native-final-b', final: true, goalEligible: true,
      message: { text: 'Completed successor result.', chars: 27, truncated: false } };
    const end = { kind: 'turn_end', source: 'extension', seq: 6, time: 1151, turnId: nextTurn, outcome: 'completed' };
    const events = [oldFinal, question, start, final, end];
    vi.mocked(readRecentEvents).mockImplementation(async (_id, limit, query) => events
      .filter(event => !query?.kinds || query.kinds.includes(event.kind as never)).slice(-limit).reverse() as never);
    const pending = { sessionId, replyId: final.messageId, turnId: nextTurn, eventSeq: final.seq, acceptedAt: now };
    const conversationId = binding.conversationId;
    const pendingOwner = vi.spyOn(goalCustody, 'goalPendingReplyFor')
      .mockImplementation(conversation => conversation === conversationId ? { ...pending } : null);
    const armed = vi.spyOn(goalCustody, 'goalArmedFor').mockImplementation(conversation => conversation === conversationId);
    return { oldTurn, nextTurn, retained, events, oldFinal, question, start, final, end, pending, pendingOwner, armed,
      originalController, originalAnswer };
  }

  it.each([false, true])('reconciles a cancelled receipted helper only for its exact completed successor (cold=%s)', async cold => {
    const { retained, oldTurn, nextTurn } = await cancelledHelperWithCompletedSuccessor(cold);
    const controller = new AbortController();
    const successor = requestBrowserDecision('Decide the current completed source.', controller.signal, {
      sourceSessionId: sessionId, sourceTurnId: nextTurn, lifetime: 'temporary-planner'
    });
    void successor.catch(() => undefined);
    try {
      const rows = await listInputs();
      const replacement = rows.find(row => row.id !== retained.id);
      expect(replacement).toMatchObject({ state: 'queued', owner: null, decisionSourceTurnId: nextTurn });
      expect(rows.find(row => row.id === retained.id)).toEqual({ ...retained,
        goalSourceSuperseded: true, error: 'goal_browser_source_superseded' });
      expect(await completeBrowserDecision(retained.id, 'cancelled-helper-document', 'Late original answer', null, true)).toBe(false);
      await expect(requestBrowserDecision('The old source must not be replayed.', new AbortController().signal, {
        sourceSessionId: sessionId, sourceTurnId: oldTurn, lifetime: 'temporary-planner', allowAmbiguousRetry: true
      })).rejects.toThrow('goal_browser_source_superseded');
      expect(await claimBrowserInput(replacement!.id, 'successor-helper-document', null)).not.toBeNull();
      expect(await completeBrowserDecision(replacement!.id, 'successor-helper-document', 'Current decision', null)).toBe(true);
      await expect(successor).resolves.toBe('Current decision');
      resetInputForTests();
      expect((await listInputs()).find(row => row.id === retained.id)).toMatchObject({
        state: 'cancelled', goalSourceSuperseded: true, owner: retained.owner,
        sendAuthorizedAt: retained.sendAuthorizedAt, deliveredAt: retained.deliveredAt, messageId: retained.messageId
      });
      await expect(requestBrowserDecision('Cold restore still cannot replay the obsolete source.', new AbortController().signal, {
        sourceSessionId: sessionId, sourceTurnId: oldTurn, lifetime: 'temporary-planner', allowAmbiguousRetry: true
      })).rejects.toThrow('goal_browser_source_superseded');
    } finally {
      controller.abort();
      await successor.catch(() => undefined);
    }
  });

  it.each(['same-source', 'unknown-old-turn', 'unknown-new-turn', 'old-source-current', 'old-live-claim',
    'old-live-preparation', 'active-old-source', 'active-new-source', 'missing-native-receipt', 'future-native-receipt',
    'no-old-final', 'no-new-final', 'wrong-new-final', 'later-human', 'failed-new-turn', 'foreign-source-owner',
    'foreign-pending-session', 'foreign-pending-turn', 'foreign-binding', 'no-pending', 'invalid-pending-position', 'wrong-pending-position',
    'future-pending-epoch', 'goal-off', 'paused',
    'signed-out', 'blocked', 'live-tool', 'open-handoff', 'rotation', 'read-failure'] as const)(
    'preserves cancelled native helper ambiguity without exact successor authority (%s)', async state => {
      const live = state === 'old-live-claim' ? 'decision' : state === 'old-live-preparation' ? 'browser' : undefined;
      const fixture = await cancelledHelperWithCompletedSuccessor(!live, live);
      const { retained, oldTurn, nextTurn, events, oldFinal, final, end, pending, pendingOwner, armed } = fixture;
      const options = { sourceSessionId: sessionId, sourceTurnId: nextTurn as string | undefined,
        lifetime: 'temporary-planner' as const };
      if (state === 'same-source') options.sourceTurnId = oldTurn;
      if (state === 'unknown-old-turn') delete retained.decisionSourceTurnId;
      if (state === 'unknown-new-turn') options.sourceTurnId = undefined;
      if (state === 'old-source-current') { end.turnId = oldTurn; pending.turnId = oldTurn; }
      if (state === 'active-old-source') binding.activeTurnId = oldTurn;
      if (state === 'active-new-source') binding.activeTurnId = nextTurn;
      if (state === 'missing-native-receipt') delete retained.messageId;
      if (state === 'future-native-receipt') retained.deliveredAt = now + 1;
      if (state === 'no-old-final') events.splice(events.indexOf(oldFinal), 1);
      if (state === 'no-new-final') events.splice(events.indexOf(final), 1);
      if (state === 'wrong-new-final') final.messageId = 'foreign-final';
      if (state === 'later-human') events.push({ ...fixture.question, seq: 7, origin: 7 });
      if (state === 'failed-new-turn') end.outcome = 'failed';
      if (state === 'foreign-source-owner') vi.spyOn(await import('../src/main/session/store.js'), 'findSessionByConversation')
        .mockResolvedValueOnce({ id: 'foreign-session', conversationId: binding.conversationId } as never);
      if (state === 'foreign-pending-session') pending.sessionId = 'foreign-session';
      if (state === 'foreign-pending-turn') pending.turnId = 'foreign-turn';
      if (state === 'foreign-binding') binding.conversationId = 'foreign-provider-route';
      if (state === 'no-pending') pendingOwner.mockReturnValue(null);
      if (state === 'invalid-pending-position') pending.eventSeq = 0;
      if (state === 'wrong-pending-position') pending.eventSeq = final.seq + 1;
      if (state === 'future-pending-epoch') pending.acceptedAt = now + 1;
      if (state === 'goal-off') armed.mockReturnValue(false);
      if (state === 'paused') binding.automationPaused = true;
      if (state === 'signed-out') setBrowserDecisionAuthentication('signed-out');
      if (state === 'blocked') binding.blocked = true;
      if (state === 'live-tool') configureInputDelivery({ applyAutomation: automate, changed, callsHoldRecovery: () => true });
      if (state === 'open-handoff') vi.spyOn(resumeCustody, 'continuationForSession').mockReturnValue({ state: 'claimed' } as never);
      if (state === 'rotation') vi.spyOn(rotationCustody, 'automationRotationAdmits').mockReturnValue(false);
      if (state === 'read-failure') vi.mocked(readRecentEvents).mockRejectedValue(new Error('Source proof unavailable'));
      if (!live) {
        await writeDurableNow('session-input', [retained]);
        resetInputForTests();
      }
      if (state === 'signed-out') setBrowserDecisionAuthentication('signed-out');
      const before = await listInputs();
      const controller = new AbortController();
      const attempt = requestBrowserDecision('No authority to replace this helper.', controller.signal, options);
      void attempt.catch(() => undefined);
      try {
        expect(await listInputs()).toEqual(before);
        await expect(attempt).rejects.toThrow();
        expect((await listInputs())[0]!.goalSourceSuperseded).toBeUndefined();
      } finally {
        controller.abort(); await attempt.catch(() => undefined);
        fixture.originalController.abort(); await fixture.originalAnswer.catch(() => undefined);
      }
    }
  );

  it.each(['pending-epoch', 'pending-owner', 'binding', 'source-revision', 'active-source', 'goal-off', 'pause',
    'rotation', 'blocked', 'live-tool', 'superseded-route'] as const)(
    'rechecks cancelled-helper successor custody after an awaited source read (%s)', async race => {
      const { retained, nextTurn, pending, armed } = await cancelledHelperWithCompletedSuccessor(true);
      const read = vi.mocked(readRecentEvents).getMockImplementation()!;
      let rotated = false, revision = 1, tools = false;
      const sourceStore = await import('../src/main/session/store.js');
      const get = vi.mocked(sourceStore.getSession).getMockImplementation()!;
      vi.spyOn(sourceStore, 'getSession').mockImplementation(async (...args) => ({ ...await get(...args), events: revision } as never));
      const rotation = vi.spyOn(rotationCustody, 'automationRotationAdmits').mockReturnValue(true);
      configureInputDelivery({ applyAutomation: automate, changed, callsHoldRecovery: () => tools });
      vi.mocked(readRecentEvents).mockImplementation(async (...args) => {
        const result = await read(...args);
        if (!rotated && args[1] === 1 && args[2]?.kinds?.includes('assistant_message')) {
          rotated = true;
          if (race === 'pending-epoch') pending.acceptedAt++;
          if (race === 'pending-owner') pending.replyId = 'replacement-pending-final';
          if (race === 'binding') binding.conversationId = 'replacement-route';
          if (race === 'source-revision') revision++;
          if (race === 'active-source') binding.activeTurnId = 'new-active-turn';
          if (race === 'goal-off') armed.mockReturnValue(false);
          if (race === 'pause') binding.automationPaused = true;
          if (race === 'rotation') rotation.mockReturnValue(false);
          if (race === 'blocked') binding.blocked = true;
          if (race === 'live-tool') tools = true;
          if (race === 'superseded-route') vi.mocked(conversationWasSuperseded).mockResolvedValue(true);
        }
        return result;
      });
      const controller = new AbortController();
      const attempt = requestBrowserDecision('Old proof must not survive the await.', controller.signal, {
        sourceSessionId: sessionId, sourceTurnId: nextTurn, lifetime: 'temporary-planner'
      });
      void attempt.catch(() => undefined);
      try {
        expect(await listInputs()).toEqual([retained]);
        await expect(attempt).rejects.toThrow();
        expect(rotated).toBe(true);
      } finally {
        controller.abort(); await attempt.catch(() => undefined);
        vi.mocked(sourceStore.getSession).mockImplementation(get);
      }
    }
  );

  it.each(['pause', 'pending-epoch', 'binding', 'rotation', 'active-source', 'goal-off', 'abort', 'signed-out'] as const)(
    'does not publish cancelled-helper supersession when authority changes as the proof promise resolves (%s)', async race => {
    const { retained, nextTurn, pending, armed } = await cancelledHelperWithCompletedSuccessor(true);
    const controller = new AbortController();
    let admissions = 0, rotationAdmits = true;
    vi.spyOn(rotationCustody, 'automationRotationAdmits').mockImplementation(() => {
      if (++admissions === 2) queueMicrotask(() => {
        if (race === 'pause') binding.automationPaused = true;
        if (race === 'pending-epoch') pending.acceptedAt++;
        if (race === 'binding') binding.conversationId = 'replacement-source-route';
        if (race === 'rotation') rotationAdmits = false;
        if (race === 'active-source') binding.activeTurnId = 'late-source-turn';
        if (race === 'goal-off') armed.mockReturnValue(false);
        if (race === 'abort') controller.abort();
        if (race === 'signed-out') setBrowserDecisionAuthentication('signed-out');
      });
      return rotationAdmits;
    });
    const attempt = requestBrowserDecision('Publication must still own admission.', controller.signal, {
      sourceSessionId: sessionId, sourceTurnId: nextTurn, lifetime: 'temporary-planner'
    });
    void attempt.catch(() => undefined);
    try {
      expect(await listInputs()).toEqual([retained]);
      await expect(attempt).rejects.toThrow();
      expect(admissions).toBeGreaterThanOrEqual(2);
    } finally { controller.abort(); await attempt.catch(() => undefined); }
  });

  it('keeps cancelled native receipts unclassified when atomic successor admission cannot be saved', async () => {
    const { retained, nextTurn } = await cancelledHelperWithCompletedSuccessor(true);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Successor receipt disposition write failed'));
    await expect(requestBrowserDecision('No publication after failed storage.', new AbortController().signal, {
      sourceSessionId: sessionId, sourceTurnId: nextTurn, lifetime: 'temporary-planner'
    })).rejects.toThrow('Successor receipt disposition write failed');
    expect(await listInputs()).toEqual([retained]);
    await flushDurable();
    resetInputForTests();
    expect(await listInputs()).toEqual([retained]);
  });

  it.each([null, 'known-helper-temporary'] as const)(
    'reconciles a delayed native ACK after an authorized temporary helper waiter expired (conversation=%s)',
    async route => {
      const controller = new AbortController();
      const answer = requestBrowserDecision('Await provider result', controller.signal, {
        sourceSessionId: sessionId, lifetime: 'temporary-planner', conversationId: route
      });
      const rejected = expect(answer).rejects.toThrow('goal_browser_cancelled');
      const row = (await listInputs())[0]!;
      expect(await claimBrowserInput(row.id, 'old-exact-document', route, true)).toMatchObject({ id: row.id });
      expect(await authorizeBrowserInput(row.id, 'old-exact-document', route)).toBe(true);
      controller.abort(); await rejected;
      resetInputForTests();
      expect(await settleTimedOutBrowserHelper(sessionId)).toBe('send-outcome-unconfirmed');
      expect((await listInputs())[0]).toMatchObject({ state: 'cancelled',
        sendAuthorizedAt: expect.any(Number) });

      // Native provider Send succeeded, but its /input/ack response was delayed across the
      // local answer deadline and Main restart. This receipt MUST repair metadata only.
      expect(await acknowledgeBrowserInput(row.id, 'old-exact-document', route, 'late-native-message')).toBe(true);
      expect((await listInputs())[0]).toMatchObject({ state: 'cancelled',
        messageId: 'late-native-message', deliveredAt: expect.any(Number) });
      expect(await settleTimedOutBrowserHelper(sessionId)).toBe('awaiting-answer');
      expect(await acknowledgeBrowserInput(row.id, 'old-exact-document', route, 'late-native-message')).toBe(true);
      expect(await acknowledgeBrowserInput(row.id, 'old-exact-document', route, 'contradictory-message')).toBe(false);
      expect(await acknowledgeBrowserInput(row.id, 'foreign-document', route, 'late-native-message')).toBe(false);
      await expect(requestBrowserDecision('No duplicate after late receipt', new AbortController().signal, {
        sourceSessionId: sessionId, lifetime: 'temporary-planner'
      })).rejects.toThrow('goal_browser_delivered_helper_unresolved');
      expect((await listInputs()).map(row => row.id)).toEqual([row.id]);
      expect(await completeBrowserDecision(row.id, 'old-exact-document', 'too-late')).toBe(false);
    }
  );
  it('retires only proven unsent browser preparation even when a temporary helper route was already chosen', async () => {
    const route = 'reused-temporary-route';
    const abort = new AbortController();
    const originalAnswer = requestBrowserDecision('Original', abort.signal, {
      sourceSessionId: sessionId, conversationId: route, lifetime: 'temporary-planner'
    });
    const rejected = expect(originalAnswer).rejects.toThrow('goal_browser_cancelled');
    const original = (await listInputs())[0]!;
    expect(await claimBrowserInput(original.id, 'preparing-document', route, true)).toMatchObject({ id: original.id });
    // The explicit per-message Send authorization was never granted.
    abort.abort(); await rejected;
    resetInputForTests();
    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('browser-preparing');
    expect((await listInputs())[0]).toMatchObject({ id: original.id, state: 'failed',
      conversationId: route, error: 'Timed-out helper confirmed unsent during browser preparation' });
    const second = requestBrowserDecision('Safe replacement', new AbortController().signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    });
    const fresh = (await listInputs()).find(row => row.state === 'queued')!;
    expect(fresh.id).not.toBe(original.id);
    expect(await claimBrowserInput(fresh.id, 'new-document', null)).toMatchObject({ id: fresh.id });
    expect(await completeBrowserDecision(fresh.id, 'new-document', 'result')).toBe(true);
    await expect(second).resolves.toBe('result');
  });
  it('reuses the exact helper target and keeps source input out of its queue', async () => {
    binding.activeTurnId = 'source-still-running';
    const controller = new AbortController();
    const answer = requestBrowserDecision('New source response', controller.signal, {
      sourceSessionId: sessionId, conversationId: 'helper-conversation', model: 'gpt-5.6-sol', reasoningEffort: 'high'
    });
    const row = (await listInputs())[0]!;
    expect(row).toMatchObject({ sessionId: null, decisionSourceSessionId: sessionId, model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: 'helper-conversation' }]);
    expect(await claimBrowserInput(row.id, 'wrong', binding.conversationId)).toBeNull();
    expect(await claimBrowserInput(row.id, 'helper', 'helper-conversation')).not.toBeNull();
    expect(await completeBrowserDecision(row.id, 'helper', 'reply', binding.conversationId)).toBe(false);
    expect(await completeBrowserDecision(row.id, 'helper', 'reply', 'helper-conversation')).toBe(true);
    await expect(answer).resolves.toBe('reply');
  });
  it('blocks duplicate source helpers and new tabs after an ambiguous fresh cancellation', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose', controller.signal, { sourceSessionId: sessionId });
    const rejected = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await expect(requestBrowserDecision('Again', new AbortController().signal, { sourceSessionId: sessionId })).rejects.toThrow('goal_browser_busy');
    await claimBrowserInput(row.id, 'document', null);
    controller.abort();
    await rejected;
    await expect(requestBrowserDecision('Retry', new AbortController().signal, { sourceSessionId: sessionId })).rejects.toThrow('goal_browser_send_unconfirmed');
    expect(await listInputs()).toHaveLength(1);
  });
  it('keeps a confirmed temporary helper fenced when a non-timeout cancellation aborts its waiter', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose', controller.signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    });
    const rejected = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const old = (await listInputs())[0]!;
    expect(await claimBrowserInput(old.id, 'temporary-document', null)).not.toBeNull();
    expect(await acknowledgeBrowserInput(old.id, 'temporary-document', null, 'helper-user-message')).toBe(true);
    controller.abort();
    await rejected;

    await expect(requestBrowserDecision('Retry', new AbortController().signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    })).rejects.toThrow('goal_browser_send_unconfirmed');
    expect((await listInputs()).find(entry => entry.id === old.id)).toMatchObject({
      state: 'cancelled', deliveredAt: expect.any(Number), conversationId: null
    });
    expect(await listInputs()).toHaveLength(1);
  });
  it('does not replace a native-delivered temporary helper after its local deadline', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose', controller.signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    });
    const rejected = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const old = (await listInputs())[0]!;
    expect(await claimBrowserInput(old.id, 'temporary-document', null)).not.toBeNull();
    expect(await acknowledgeBrowserInput(old.id, 'temporary-document', null, 'helper-user-message')).toBe(true);
    controller.abort();
    await rejected;

    expect(await settleTimedOutBrowserHelper(sessionId)).toBe('awaiting-answer');
    await expect(requestBrowserDecision('Retry', new AbortController().signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    })).rejects.toThrow('goal_browser_send_unconfirmed');
    expect((await listInputs()).find(entry => entry.id === old.id)).toMatchObject({
      state: 'cancelled', deliveredAt: expect.any(Number), messageId: 'helper-user-message', conversationId: null
    });
    expect(await listInputs()).toHaveLength(1);
  });
  it('automatically replaces a helper cancelled before any browser claim', async () => {
    const controller = new AbortController();
    const first = requestBrowserDecision('Choose', controller.signal, { sourceSessionId: sessionId });
    const rejected = expect(first).rejects.toThrow('goal_browser_cancelled');
    const old = (await listInputs())[0]!;
    controller.abort();
    await rejected;
    expect((await listInputs()).find(row => row.id === old.id)).toMatchObject({ state: 'cancelled', owner: null });

    const retry = requestBrowserDecision('Choose again', new AbortController().signal, { sourceSessionId: sessionId });
    void retry.catch(() => undefined);
    const rows = await listInputs();
    expect(rows.find(row => row.id === old.id)).toMatchObject({
      state: 'failed', error: 'Confirmed unsent helper retired for automatic retry'
    });
    expect(await claimBrowserInput(old.id, 'late-old-document', null, true)).toBeNull();
    const fresh = rows.find(row => row.id !== old.id)!;
    await claimBrowserInput(fresh.id, 'new-document', null);
    expect(await completeBrowserDecision(fresh.id, 'new-document', 'accepted', null)).toBe(true);
    await expect(retry).resolves.toBe('accepted');
  });
  it.each(['queued', 'cancelled'] as const)('replaces an unclaimed %s helper after reconstruction', async state => {
    const old: InputEntry = { ...input({ sessionId: null }), purpose: 'decision', lifetime: 'temporary-planner',
      decisionSourceSessionId: sessionId, state, owner: null, createdAt: now, conversationId: null };
    await writeDurableNow('session-input', [old]);
    resetInputForTests();
    const retry = requestBrowserDecision('Choose again', new AbortController().signal, { sourceSessionId: sessionId });
    void retry.catch(() => undefined);
    const rows = await listInputs();
    expect(rows.find(row => row.id === old.id)).toMatchObject({ state: 'failed' });
    const fresh = rows.find(row => row.id !== old.id)!;
    await claimBrowserInput(fresh.id, 'fresh-document', null);
    expect(await completeBrowserDecision(fresh.id, 'fresh-document', 'accepted', null)).toBe(true);
    await expect(retry).resolves.toBe('accepted');
  });
  it.each([
    { owner: 'claimed-document' }, { offeredAt: 1 }, { sendAuthorizedAt: 1 },
    { deliveredAt: 1 }, { messageId: 'native-message' }, { deliveredSessionId: 'helper-session' },
    { response: 'already answered' }, { requiresAuthorization: false }, { deliveryText: 'prepared by an old owner' },
    { requiresAuthorization: true, deliveredAt: 1 }, { requiresAuthorization: true, messageId: 'native-message' }
  ] satisfies Array<Partial<InputEntry>>)('does not infer an unclaimed helper from absent owner alone: %j', async evidence => {
    const old: InputEntry = { ...input({ sessionId: null }), purpose: 'decision', lifetime: 'temporary-planner',
      decisionSourceSessionId: sessionId, state: 'cancelled', owner: null, createdAt: now, conversationId: null,
      ...evidence };
    await writeDurableNow('session-input', [old]);
    resetInputForTests();
    await expect(requestBrowserDecision('Choose again', new AbortController().signal, { sourceSessionId: sessionId }))
      .rejects.toThrow('goal_browser_send_unconfirmed');
    expect(await listInputs()).toEqual([old]);
  });
  it('keeps unclaimed helper retirement and its single replacement atomic when persistence fails', async () => {
    const old: InputEntry = { ...input({ sessionId: null }), purpose: 'decision', lifetime: 'temporary-planner',
      decisionSourceSessionId: sessionId, state: 'cancelled', owner: null, createdAt: now, conversationId: null };
    await writeDurableNow('session-input', [old]);
    resetInputForTests();
    await listInputs();
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk busy'));
    await expect(requestBrowserDecision('Choose again', new AbortController().signal, { sourceSessionId: sessionId }))
      .rejects.toThrow('disk busy');
    expect(await listInputs()).toEqual([old]);
    await flushDurable();
    resetInputForTests();
    // The incumbent durable projection redacts terminal planner text, but retains custody.
    expect(await listInputs()).toEqual([{ ...old, text: '[Temporary planner]' }]);
  });
  it('automatically replaces a cancelled helper that has positive pre-send proof', async () => {
    const controller = new AbortController();
    const first = requestBrowserDecision('Choose', controller.signal, { sourceSessionId: sessionId });
    const rejected = expect(first).rejects.toThrow('goal_browser_cancelled');
    const old = (await listInputs())[0]!;
    await claimBrowserInput(old.id, 'old-document', null, true);
    controller.abort();
    await rejected;

    const retry = requestBrowserDecision('Choose again', new AbortController().signal, { sourceSessionId: sessionId });
    const rows = await listInputs();
    expect(rows.find(row => row.id === old.id)).toMatchObject({
      state: 'failed', error: 'Confirmed unsent helper retired for automatic retry'
    });
    const fresh = rows.find(row => row.id !== old.id)!;
    expect(fresh).toMatchObject({ state: 'queued', decisionSourceSessionId: sessionId });
    await claimBrowserInput(fresh.id, 'new-document', null);
    expect(await completeBrowserDecision(fresh.id, 'new-document', 'accepted', 'new-helper-chat')).toBe(true);
    await expect(retry).resolves.toBe('accepted');
  });
  it('lets an explicit chat reactivation retire only its ambiguous helper and create a fresh one', async () => {
    const controller = new AbortController();
    const first = requestBrowserDecision('Choose', controller.signal, { sourceSessionId: sessionId });
    const rejected = expect(first).rejects.toThrow('goal_browser_cancelled');
    const old = (await listInputs())[0]!;
    await claimBrowserInput(old.id, 'old-document', null);
    controller.abort();
    await rejected;

    const retry = requestBrowserDecision('Choose again', new AbortController().signal, {
      sourceSessionId: sessionId, allowAmbiguousRetry: true
    });
    const rows = await listInputs();
    expect(rows.find(row => row.id === old.id)).toMatchObject({
      state: 'failed', error: 'User reactivated this chat and authorized a new helper'
    });
    const fresh = rows.find(row => row.id !== old.id)!;
    expect(fresh).toMatchObject({ state: 'queued', decisionSourceSessionId: sessionId });
    await claimBrowserInput(fresh.id, 'new-document', null);
    expect(await completeBrowserDecision(fresh.id, 'new-document', 'accepted', 'new-helper-chat')).toBe(true);
    await expect(retry).resolves.toBe('accepted');
  });
  it.each(['continue', 'legacy-stop'] as const)('does not remint the same Goal turn helper after its acknowledged %s answer was redacted by restart', async disposition => {
    const turnOne = { sourceSessionId: sessionId, sourceTurnId: 'source-final-turn-one', lifetime: 'temporary-planner' as const };
    const first = requestBrowserDecision('Decide the current turn', new AbortController().signal, turnOne);
    const firstRow = (await listInputs())[0]!;
    expect(await claimBrowserInput(firstRow.id, 'original-helper-page', null, true)).not.toBeNull();
    expect(await authorizeBrowserInput(firstRow.id, 'original-helper-page', null)).toBe(true);
    expect(await acknowledgeBrowserInput(firstRow.id, 'original-helper-page', null, 'native-answer-before-crash')).toBe(true);
    const response = disposition === 'continue' ? '{"action":"continue","reply":"Continue existing work"}' : '{"action":"stop","reply":""}';
    expect(await completeBrowserDecision(firstRow.id, 'original-helper-page', response, null)).toBe(true);
    await expect(first).resolves.toBe(response);
    resetInputForTests();
    const restored = (await listInputs())[0]!;
    expect(restored).toMatchObject({ id: firstRow.id, state: 'sent', messageId: 'native-answer-before-crash' });
    expect(restored.response).toBeUndefined(); // Privacy-safe durable redaction is intentional.

    const retryAbort = new AbortController();
    const retry = requestBrowserDecision('Restarted Goal still owes the same turn', retryAbort.signal, turnOne);
    void retry.catch(() => undefined);
    try {
      expect((await listInputs()).map(row => row.id)).toEqual([firstRow.id]);
      await expect(retry).rejects.toThrow('goal_browser_answer_custody_unconfirmed');
    } finally {
      retryAbort.abort(); await retry.catch(() => undefined);
    }
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', messageId: 'native-answer-before-crash' });

    // A later, different source turn is not blocked by the already answered prior one.
    const later = requestBrowserDecision('New assistant turn', new AbortController().signal, {
      ...turnOne, sourceTurnId: 'source-final-turn-two'
    });
    const next = (await listInputs()).find(row => row.id !== firstRow.id)!;
    expect(next).toMatchObject({ state: 'queued', decisionSourceSessionId: sessionId });
    expect(await claimBrowserInput(next.id, 'later-helper-page', null)).not.toBeNull();
    expect(await completeBrowserDecision(next.id, 'later-helper-page', 'new turn decision', null)).toBe(true);
    await expect(later).resolves.toBe('new turn decision');
  });
  it('requires explicit source reactivation before replacing a cold accepted-answer helper', async () => {
    const turn = { sourceSessionId: sessionId, sourceTurnId: 'answer-before-goal-durable', lifetime: 'temporary-planner' as const };
    const original = requestBrowserDecision('First accepted answer', new AbortController().signal, turn);
    const old = (await listInputs())[0]!;
    expect(await claimBrowserInput(old.id, 'first-accepted-document', null)).not.toBeNull();
    expect(await acknowledgeBrowserInput(old.id, 'first-accepted-document', null, 'first-native-user-id')).toBe(true);
    expect(await completeBrowserDecision(old.id, 'first-accepted-document', '{"action":"continue","reply":"Original answer"}')).toBe(true);
    await expect(original).resolves.toContain('Original answer');
    resetInputForTests();
    const rows = await listInputs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: old.id, state: 'sent', messageId: 'first-native-user-id' });
    expect(rows[0]?.response).toBeUndefined();

    await expect(requestBrowserDecision('No unattended replay', new AbortController().signal, turn))
      .rejects.toThrow('goal_browser_answer_custody_unconfirmed');
    expect(await listInputs()).toHaveLength(1);
    // An explicit user Restart helper is the existing authority for one genuinely NEW
    // decision. It may not delete, rewrite or claim that the earlier accepted Send was unsent.
    const approved = requestBrowserDecision('Deliberate restart after inspecting custody', new AbortController().signal, {
      ...turn, allowAmbiguousRetry: true
    });
    void approved.catch(() => undefined);
    const after = await listInputs();
    expect(after).toHaveLength(2);
    expect(after.find(row => row.id === old.id)).toMatchObject({
      state: 'sent', messageId: 'first-native-user-id', decisionSourceTurnId: turn.sourceTurnId
    });
    const fresh = after.find(row => row.id !== old.id)!;
    expect(fresh).toMatchObject({ state: 'queued', decisionSourceTurnId: turn.sourceTurnId });
    expect(await claimBrowserInput(fresh.id, 'second-approved-document', null)).not.toBeNull();
    expect(await completeBrowserDecision(fresh.id, 'second-approved-document', 'explicit approved result')).toBe(true);
    await expect(approved).resolves.toBe('explicit approved result');
    // A durable explicitActivation flag may remain true until the source replies. It
    // authorizes ONE new decision, not a third/fourth automatic Send after the replacement
    // has already answered or Main restarts again.
    resetInputForTests();
    const staleActivation = new AbortController();
    const extra = requestBrowserDecision('No extra helper under a stale explicit grant', staleActivation.signal, {
      ...turn, allowAmbiguousRetry: true
    });
    void extra.catch(() => undefined);
    try {
      expect(await listInputs()).toHaveLength(2);
      await expect(extra).rejects.toThrow('goal_browser_answer_custody_unconfirmed');
    } finally {
      staleActivation.abort();
      await extra.catch(() => undefined);
    }
  });
  it('authorizes the exact same-turn cold accepted-answer row through the original user Restart helper owner', async () => {
    const turn = { sourceSessionId: sessionId, sourceTurnId: 'restart-action-accepted-answer',
      lifetime: 'temporary-planner' as const };
    const first = requestBrowserDecision('Accepted response before app interruption', new AbortController().signal, turn);
    const original = (await listInputs())[0]!;
    expect(await claimBrowserInput(original.id, 'restart-page', null)).not.toBeNull();
    expect(await acknowledgeBrowserInput(original.id, 'restart-page', null, 'native-restart-case')).toBe(true);
    expect(await completeBrowserDecision(original.id, 'restart-page', 'Accepted helper answer')).toBe(true);
    await expect(first).resolves.toBe('Accepted helper answer');
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({
      id: original.id, state: 'sent', decisionSourceTurnId: turn.sourceTurnId, messageId: 'native-restart-case'
    });
    expect(await authorizeBrowserHelperRetry(original.id, 'unrelated-source-session', turn.sourceTurnId)).toBe(false);
    expect(await authorizeBrowserHelperRetry(original.id, sessionId, 'different-source-turn')).toBe(false);
    expect(await authorizeBrowserHelperRetry(original.id, sessionId, turn.sourceTurnId)).toBe(true);
    expect((await listInputs())[0]).toMatchObject({
      id: original.id, state: 'sent', messageId: 'native-restart-case'
    });
    expect((await listInputs())[0]?.response).toBeUndefined();
  });
  it('reconciles answer-first late native ACK after cold Main reconstruction without duplicating the source turn', async () => {
    const turn = { sourceSessionId: sessionId, sourceTurnId: 'exact-turn-answer-before-ack', lifetime: 'temporary-planner' as const };
    const original = requestBrowserDecision('Browser answer before ACK', new AbortController().signal, turn);
    const row = (await listInputs())[0]!;
    expect(await claimBrowserInput(row.id, 'exact-browser-document', null, true)).not.toBeNull();
    expect(await authorizeBrowserInput(row.id, 'exact-browser-document', null)).toBe(true);
    expect(await completeBrowserDecision(row.id, 'exact-browser-document', '{"action":"continue","reply":"Proceed with one Loop"}')).toBe(true);
    await expect(original).resolves.toContain('Proceed with one Loop');
    expect((await listInputs())[0]).toMatchObject({ id: row.id, state: 'sent' });
    expect((await listInputs())[0]?.messageId).toBeUndefined();
    expect((await listInputs())[0]?.deliveredAt).toBeUndefined();

    resetInputForTests(); // Browser page remains; Main's answer waiter is gone.
    const cold = (await listInputs())[0]!;
    expect(cold).toMatchObject({ id: row.id, state: 'sent', decisionSourceTurnId: turn.sourceTurnId });
    expect(cold.response).toBeUndefined();
    expect(await acknowledgeBrowserInput(row.id, 'foreign-document', null, 'native-exact-message')).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'exact-browser-document', null, 'native-exact-message')).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'exact-browser-document', null, 'native-exact-message')).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'exact-browser-document', null, 'contradictory-message')).toBe(false);
    resetInputForTests(); // ACK identity and receipt survive a second restart.
    expect((await listInputs())[0]).toMatchObject({
      id: row.id, state: 'sent', messageId: 'native-exact-message', deliveredAt: expect.any(Number),
      decisionSourceTurnId: turn.sourceTurnId
    });
    expect((await listInputs())[0]?.response).toBeUndefined();
    await expect(requestBrowserDecision('Automatic replay prohibited', new AbortController().signal, turn))
      .rejects.toThrow('goal_browser_answer_custody_unconfirmed');
    expect(await listInputs()).toHaveLength(1);

    const later = requestBrowserDecision('A genuinely later source turn', new AbortController().signal, {
      ...turn, sourceTurnId: 'another-source-final'
    });
    const newer = (await listInputs()).find(candidate => candidate.id !== row.id)!;
    expect(newer).toMatchObject({ state: 'queued', decisionSourceTurnId: 'another-source-final' });
    expect(await claimBrowserInput(newer.id, 'newer-document', null)).not.toBeNull();
    expect(await completeBrowserDecision(newer.id, 'newer-document', 'Allowed new source turn')).toBe(true);
    await expect(later).resolves.toBe('Allowed new source turn');
  });
  it('does not confuse a browser transport failure with a Goal-owned protocol rejection', async () => {
    const decision = requestBrowserDecision('Keep transport and decision provenance separate', new AbortController().signal,
      { lifetime: 'temporary-planner' });
    const failure = expect(decision).rejects.toThrow('goal_browser_send_failed: invalid_goal_decision_json');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'transport-failure-owner', null, true);
    await authorizeBrowserInput(row.id, 'transport-failure-owner', null);
    await acknowledgeBrowserInput(row.id, 'transport-failure-owner', null, 'native-before-transport-failure');
    expect(await failBrowserInput(row.id, 'transport-failure-owner', 'invalid_goal_decision_json')).toBe(true);
    await failure;
    expect(await completeBrowserDecision(row.id, 'transport-failure-owner', 'Unknown transport answer', null)).toBe(false);
    resetInputForTests();
    expect(await completeBrowserDecision(row.id, 'transport-failure-owner', 'Any cold body', null)).toBe(false);
    expect((await listInputs())[0]).toMatchObject({ state: 'failed', error: 'invalid_goal_decision_json',
      messageId: 'native-before-transport-failure' });
    expect((await listInputs())[0]?.goalDecisionRejection).toBeUndefined();
    expect((await listInputs())[0]?.response).toBeUndefined();
  });
  it.each(['ack-before-answer', 'ack-after-answer', 'ack-after-cold-restore'] as const)(
    'keeps a rejected helper decision terminal while reconciling only its exact native receipt (%s)', async sequence => {
      const owner = 'invalid-protocol-owner';
      const raw = '{"action":"continue","reply":"incomplete"';
      const turn = { sourceSessionId: sessionId, sourceTurnId: 'invalid-protocol-native-receipt',
        lifetime: 'temporary-planner' as const,
        onAccepted: () => { throw new BrowserDecisionProtocolRejection('invalid_goal_decision_json'); } };
      const decision = requestBrowserDecision('Decide for the existing source only', new AbortController().signal, turn);
      const row = (await listInputs())[0]!;
      expect(await claimBrowserInput(row.id, owner, null, true)).not.toBeNull();
      expect(await authorizeBrowserInput(row.id, owner, null)).toBe(true);
      if (sequence === 'ack-before-answer')
        expect(await acknowledgeBrowserInput(row.id, owner, null, 'exact-native-helper-user')).toBe(true);
      expect(await completeBrowserDecision(row.id, 'foreign-owner', raw, null)).toBe(false);
      expect(await completeBrowserDecision(row.id, owner, raw, null)).toBe(true);
      await expect(decision).resolves.toBe(raw);
      expect(await completeBrowserDecision(row.id, owner, raw, null)).toBe(true);
      expect(await completeBrowserDecision(row.id, owner, 'different answer', null)).toBe(false);
      if (sequence === 'ack-after-cold-restore') resetInputForTests();
      expect(await authorizeBrowserInput(row.id, owner, null)).toBe(false);
      expect(await acknowledgeBrowserInput(row.id, 'foreign-owner', null, 'exact-native-helper-user')).toBe(false);
      expect(await acknowledgeBrowserInput(row.id, owner, null, 'exact-native-helper-user')).toBe(true);
      expect(await acknowledgeBrowserInput(row.id, owner, null, 'exact-native-helper-user')).toBe(true);
      expect(await acknowledgeBrowserInput(row.id, owner, null, 'contradictory-native-user')).toBe(false);
      // A late route is learned only from this native ACK, not from a different answer route.
      expect(await completeBrowserDecision(row.id, owner, raw, 'late-helper-route')).toBe(false);
      expect(await acknowledgeBrowserInput(row.id, owner, 'late-helper-route', 'exact-native-helper-user')).toBe(true);
      expect(await completeBrowserDecision(row.id, owner, raw, 'late-helper-route')).toBe(true);
      expect(await completeBrowserDecision(row.id, owner, raw, 'foreign-helper-route')).toBe(false);
      const rejected = (await listInputs())[0]!;
      expect(rejected).toMatchObject({ id: row.id, owner, state: 'failed', error: 'invalid_goal_decision_json',
        goalDecisionRejection: 'invalid_goal_decision_json',
        conversationId: 'late-helper-route', messageId: 'exact-native-helper-user', sendAuthorizedAt: now, deliveredAt: now });
      expect(await pendingBrowserInputs()).toEqual([]);
      expect((await listInputs()).filter(entry => entry.sourceHelperId === row.id)).toHaveLength(0);
      const durable = await readDurable<InputEntry[]>('session-input');
      expect(durable?.[0]).toMatchObject({ state: 'failed', text: '[Temporary planner]', messageId: 'exact-native-helper-user',
        goalDecisionRejection: 'invalid_goal_decision_json' });
      expect(durable?.[0]?.response).toBeUndefined();
      resetInputForTests();
      expect((await listInputs())[0]?.response).toBeUndefined();
      expect(await completeBrowserDecision(row.id, owner, raw, 'late-helper-route')).toBe(true);
      expect((await listInputs())[0]).toMatchObject({ state: 'failed', error: 'invalid_goal_decision_json' });
      expect((await listInputs())[0]?.response).toBeUndefined();
    });
  it('does not release a rejected protocol answer when its failure receipt cannot be saved', async () => {
    const raw = 'Malformed protocol fixture';
    const decision = requestBrowserDecision('Keep this exact native delivery', new AbortController().signal, {
      lifetime: 'temporary-planner', onAccepted: () => { throw new BrowserDecisionProtocolRejection('invalid_goal_decision_json'); }
    });
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'invalid-write-owner', null, true);
    await authorizeBrowserInput(row.id, 'invalid-write-owner', null);
    await acknowledgeBrowserInput(row.id, 'invalid-write-owner', null, 'native-before-invalid-write');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('cannot save rejected decision'));
    await expect(completeBrowserDecision(row.id, 'invalid-write-owner', raw, null)).rejects.toThrow('cannot save rejected decision');
    expect((await listInputs())[0]).toMatchObject({ state: 'decision', messageId: 'native-before-invalid-write' });
    expect((await listInputs())[0]?.response).toBeUndefined();
    expect(await completeBrowserDecision(row.id, 'invalid-write-owner', raw, null)).toBe(true);
    await expect(decision).resolves.toBe(raw);
    expect((await listInputs())[0]).toMatchObject({ state: 'failed', messageId: 'native-before-invalid-write' });
  });
  it('does not resurrect a cancelled waiter when invalid-answer rejection commits during its abort', async () => {
    const controller = new AbortController();
    const decision = requestBrowserDecision('Keep the delivered but cancelled owner', controller.signal, {
      lifetime: 'temporary-planner', onAccepted: () => { throw new BrowserDecisionProtocolRejection('invalid_goal_decision_json'); }
    });
    const cancelled = expect(decision).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'invalid-abort-owner', null, true);
    await authorizeBrowserInput(row.id, 'invalid-abort-owner', null);
    await acknowledgeBrowserInput(row.id, 'invalid-abort-owner', null, 'native-before-invalid-abort');
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      controller.abort();
      await rename(from, to);
    });
    expect(await completeBrowserDecision(row.id, 'invalid-abort-owner', 'Invalid complete answer', null)).toBe(false);
    await cancelled;
    expect((await listInputs())[0]).toMatchObject({ state: 'failed', error: 'invalid_goal_decision_json',
      messageId: 'native-before-invalid-abort' });
    expect((await listInputs()).filter(entry => entry.sourceHelperId === row.id)).toHaveLength(0);
    expect(await authorizeBrowserInput(row.id, 'invalid-abort-owner', null)).toBe(false);
  });
  it('retains confirmed native delivery without replacement when cancellation wins before protocol rejection', async () => {
    const controller = new AbortController();
    const onAccepted = vi.fn(() => { throw new BrowserDecisionProtocolRejection('invalid_goal_decision_json'); });
    const decision = requestBrowserDecision('Do not reinterpret a cancelled delivery', controller.signal, {
      lifetime: 'temporary-planner', sourceSessionId: sessionId, onAccepted
    });
    const cancelled = expect(decision).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'cancelled-protocol-owner', null, true);
    await authorizeBrowserInput(row.id, 'cancelled-protocol-owner', null);
    await acknowledgeBrowserInput(row.id, 'cancelled-protocol-owner', null, 'native-cancelled-before-answer');
    controller.abort();
    await cancelled;
    expect(await completeBrowserDecision(row.id, 'cancelled-protocol-owner', 'Unknown late answer', null)).toBe(false);
    expect(onAccepted).not.toHaveBeenCalled();
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', messageId: 'native-cancelled-before-answer' });
    await expect(requestBrowserDecision('No implicit replacement', new AbortController().signal,
      { lifetime: 'temporary-planner', sourceSessionId: sessionId })).rejects.toThrow('goal_browser_delivered_helper_unresolved');
    expect(await listInputs()).toHaveLength(1);
  });
  it('does not reinterpret a null protocol-owner callback as a rejected decision', async () => {
    const decision = requestBrowserDecision('Ordinary non-atomic decision', new AbortController().signal, {
      lifetime: 'temporary-planner', onAccepted: () => null
    });
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'null-handoff-owner', null);
    expect(await completeBrowserDecision(row.id, 'null-handoff-owner', 'Valid non-atomic answer', null)).toBe(true);
    await expect(decision).resolves.toBe('Valid non-atomic answer');
    expect((await listInputs())[0]).toMatchObject({ state: 'sent' });
    expect((await listInputs())[0]?.error).toBeUndefined();
  });
  it('keeps original native Send custody when accepting the helper answer cannot reach durable storage', async () => {
    const turn = { sourceSessionId: sessionId, sourceTurnId: 'answer-write-failure', lifetime: 'temporary-planner' as const };
    const decision = requestBrowserDecision('Same UUID must survive a failed answer commit', new AbortController().signal, turn);
    const row = (await listInputs())[0]!;
    expect(await claimBrowserInput(row.id, 'answer-durable-page', null)).not.toBeNull();
    expect(await acknowledgeBrowserInput(row.id, 'answer-durable-page', null, 'native-user-before-write-failure')).toBe(true);

    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk unavailable while accepting helper answer'));
    await expect(completeBrowserDecision(row.id, 'answer-durable-page', 'Exact bounded helper answer'))
      .rejects.toThrow('disk unavailable while accepting helper answer');
    expect((await listInputs())[0]).toMatchObject({
      id: row.id, state: 'decision', messageId: 'native-user-before-write-failure'
    });
    expect((await listInputs())[0]?.response).toBeUndefined();
    // The same exact page/UUID may retry its answer without any second Send.
    expect(await completeBrowserDecision(row.id, 'answer-durable-page', 'Exact bounded helper answer')).toBe(true);
    await expect(decision).resolves.toBe('Exact bounded helper answer');
    expect((await listInputs())[0]).toMatchObject({
      id: row.id, state: 'sent', messageId: 'native-user-before-write-failure'
    });
    resetInputForTests();
    expect((await listInputs())[0]?.response).toBeUndefined();
    await expect(requestBrowserDecision('Unattended repeat is prohibited', new AbortController().signal, turn))
      .rejects.toThrow('goal_browser_answer_custody_unconfirmed');
    expect(await listInputs()).toHaveLength(1);
  });
  it('bounds helpers at four and applies a shared cooldown after ChatGPT throttles one', async () => {
    const first = requestBrowserDecision('Choose', new AbortController().signal, { sourceSessionId: sessionId });
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'rate-limited-document', null);
    const queuedControllers = [new AbortController(), new AbortController(), new AbortController()];
    const queued = queuedControllers.map((controller, index) =>
      requestBrowserDecision(`Concurrent ${index}`, controller.signal, { sourceSessionId: `session-${index + 2}-helper` }));
    const queuedSettled = queued.map(request => request.catch(error => error));
    await vi.waitFor(async () => expect((await listInputs()).filter(entry =>
      entry.purpose === 'decision' && ['queued', 'browser', 'decision'].includes(entry.state))).toHaveLength(4));
    await expect(requestBrowserDecision('Over capacity', new AbortController().signal, { sourceSessionId: 'session-five-helper' }))
      .rejects.toThrow('goal_browser_busy');
    expect(await failBrowserInput(row.id, 'rate-limited-document', 'Too many requests. Please wait a few minutes.')).toBe(true);
    await expect(first).rejects.toThrow('goal_browser_send_failed');
    await expect(requestBrowserDecision('Retry too soon', new AbortController().signal, { sourceSessionId: sessionId }))
      .rejects.toThrow('goal_browser_rate_limited');
    now += 12_000;
    const retry = requestBrowserDecision('Retry later', new AbortController().signal, { sourceSessionId: sessionId });
    const fresh = (await listInputs()).find(entry =>
      entry.state === 'queued' && entry.decisionSourceSessionId === sessionId)!;
    await claimBrowserInput(fresh.id, 'fresh-document', null);
    expect(await completeBrowserDecision(fresh.id, 'fresh-document', 'accepted', 'fresh-helper')).toBe(true);
    await expect(retry).resolves.toBe('accepted');
    for (const controller of queuedControllers) controller.abort();
    const queuedErrors = await Promise.all(queuedSettled);
    expect(queuedErrors).toHaveLength(3);
    for (const error of queuedErrors) expect(error).toMatchObject({ message: 'goal_browser_cancelled' });
  });
  it('accepts only its exact claimant answer, with idempotent send ACK', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const row = (await listInputs())[0]!;
    // Absent caller preferences use the current GPT-6 High account default. Explicit
    // options supplied by a study/helper owner still remain authoritative.
    expect(row).toMatchObject({ model: 'gpt-6-thinking', reasoningEffort: 'high' });
    await claimBrowserInput(row.id, 'document', null);
    expect(await acknowledgeBrowserInput(row.id, 'document')).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'document')).toBe(true);
    expect(await completeBrowserDecision(row.id, 'other', 'wrong')).toBe(false);
    expect(await completeBrowserDecision(row.id, 'document', 'accepted')).toBe(true);
    await expect(answer).resolves.toBe('accepted');
    expect(await completeBrowserDecision(row.id, 'document', 'accepted')).toBe(true);
    // Matching private text cannot let an unrelated provider route borrow the accepted
    // helper receipt, even when the original answer remains in process memory.
    expect(await completeBrowserDecision(row.id, 'document', 'accepted', 'other-provider-route')).toBe(false);
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
  });
  it('preserves the accepted helper UUID required by an unclaimed Goal follow-up across a long unrelated receipt backlog', async () => {
    const acceptedId = randomUUID();
    const helper: InputEntry = { ...input({ sessionId: null, text: '[Temporary planner]' }),
      id: acceptedId, purpose: 'decision', lifetime: 'temporary-planner',
      decisionSourceSessionId: sessionId, decisionSourceTurnId: 'saved-native-source-turn',
      state: 'sent', owner: 'original-helper-document', createdAt: now,
      conversationId: null, deliveredAt: now, messageId: 'native-helper-sent' };
    const child: InputEntry = { ...input({ text: 'One earned Goal follow-up', mode: 'after-turn' }),
      sourceHelperId: acceptedId, state: 'queued', owner: null, conversationId: binding.conversationId,
      createdAt: now + 1 };
    const old = Array.from({ length: 62 }, (_, index): InputEntry => ({
      ...input({ sessionId: null, text: `Older unrelated receipt ${index}` }),
      state: 'sent', owner: 'other-document', createdAt: now + index + 2,
      conversationId: 'unrelated-provider-chat', historyRecorded: true,
      deliveredAt: now + index + 2, messageId: `other-native-${index}`
    }));
    await writeDurableNow('session-input', [helper, ...old, child]);
    resetInputForTests();
    const controller = new AbortController();
    const another = requestBrowserDecision('New source after a long backlog', controller.signal, {
      sourceSessionId: 'independent-source-session'
    });
    const all = await listInputs();
    expect(all.find(row => row.id === acceptedId)).toMatchObject({
      state: 'sent', messageId: 'native-helper-sent', decisionSourceTurnId: 'saved-native-source-turn'
    });
    expect(all.find(row => row.id === child.id)).toMatchObject({
      state: 'queued', sourceHelperId: acceptedId
    });
    expect(all.filter(row => row.id === acceptedId)).toHaveLength(1);
    controller.abort();
    await expect(another).rejects.toThrow('goal_browser_cancelled');
  });
  it('carries validated WebP screenshots through a helper decision and reports its bound conversation', async () => {
    const bytes = await sharp({
      create: { width: 24, height: 24, channels: 3, background: { r: 240, g: 240, b: 240 } }
    }).webp({ quality: 80 }).toBuffer();
    const image = { name: 'pearson-question.webp', dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` };
    const onConversation = vi.fn();
    const answer = requestBrowserDecision('Read the rendered question', new AbortController().signal, {
      images: [image],
      onConversation
    });
    await vi.waitFor(async () => expect(await listInputs()).toHaveLength(1));
    const row = (await listInputs())[0]!;
    expect(row.images).toEqual([image]);
    expect(await claimBrowserInput(row.id, 'pearson-helper', null)).toMatchObject({ images: [image] });
    expect(await completeBrowserDecision(row.id, 'pearson-helper', 'ANSWER: 42', 'pearson-chat')).toBe(true);
    await expect(answer).resolves.toBe('ANSWER: 42');
    expect(onConversation).toHaveBeenCalledOnce();
    expect(onConversation).toHaveBeenCalledWith('pearson-chat');
  });
  it.each([false, true])('idempotently acknowledges a previously accepted Temporary Chat answer after Main cold restore (nativeAckBeforeAnswer=%s)', async nativeAckBeforeAnswer => {
    const turn = { sourceSessionId: sessionId, sourceTurnId: 'cold-answer-republication',
      lifetime: 'temporary-planner' as const };
    const original = requestBrowserDecision('One helper, one answer', new AbortController().signal, turn);
    const row = (await listInputs())[0]!;
    expect(await claimBrowserInput(row.id, 'cold-result-document', null, true)).not.toBeNull();
    expect(await authorizeBrowserInput(row.id, 'cold-result-document', null)).toBe(true);
    if (nativeAckBeforeAnswer)
      expect(await acknowledgeBrowserInput(row.id, 'cold-result-document', null, 'native-cold-result')).toBe(true);
    const acceptedAnswer = '{"action":"continue","reply":"Proceed with verified work"}';
    expect(await completeBrowserDecision(row.id, 'cold-result-document', acceptedAnswer, null)).toBe(true);
    await expect(original).resolves.toBe(acceptedAnswer);

    // Browser received a transport failure instead of Main's successful /input/answer.
    // Main has already persisted state=sent, then its process exits. No answer text is
    // retained on disk, yet re-ACKing that SAME result must not become an apparent failure.
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ id: row.id, state: 'sent',
      decisionSourceTurnId: turn.sourceTurnId, owner: 'cold-result-document' });
    expect((await listInputs())[0]?.response).toBeUndefined();
    const before = JSON.stringify(await listInputs());
    expect(await completeBrowserDecision(row.id, 'another-document', acceptedAnswer, null)).toBe(false);
    expect(await completeBrowserDecision(row.id, 'cold-result-document', '', null)).toBe(false);
    expect(await completeBrowserDecision(row.id, 'cold-result-document', acceptedAnswer, 'wrong-provider-route')).toBe(false);
    expect(await completeBrowserDecision(row.id, 'cold-result-document', acceptedAnswer, null)).toBe(true);
    expect(JSON.stringify(await listInputs())).toBe(before);
    expect((await listInputs()).filter(candidate => candidate.id === row.id)).toHaveLength(1);
    if (!nativeAckBeforeAnswer)
      expect(await acknowledgeBrowserInput(row.id, 'cold-result-document', null, 'native-cold-result')).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ id: row.id, state: 'sent', messageId: 'native-cold-result' });
    await expect(requestBrowserDecision('Unattended same-turn repeat', new AbortController().signal, turn))
      .rejects.toThrow('goal_browser_answer_custody_unconfirmed');
    expect(await listInputs()).toHaveLength(1);
  });
  it.each([false, true])('retains the late exact native Send receipt when a helper answer arrives before its ACK (restart=%s)', async restart => {
    const answer = requestBrowserDecision('Choose one', new AbortController().signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner'
    });
    const row = (await listInputs())[0]!;
    expect(await claimBrowserInput(row.id, 'fast-answer-document', null, true)).toMatchObject({ id: row.id });
    expect(await authorizeBrowserInput(row.id, 'fast-answer-document', null)).toBe(true);

    // The provider final is already visible, but /input/ack is still in transit. The
    // response owns the original UUID; completing it must not discard later native proof.
    expect(await completeBrowserDecision(row.id, 'fast-answer-document', 'accepted-first')).toBe(true);
    await expect(answer).resolves.toBe('accepted-first');
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', response: 'accepted-first',
      sendAuthorizedAt: expect.any(Number) });
    // The late /input/ack may arrive after Main reloads the already-settled outbox.
    if (restart) resetInputForTests();
    // Temporary helpers deliberately persist identity, not task/answer content.
    expect((await listInputs())[0]).toMatchObject({ state: 'sent' });
    expect((await listInputs())[0]?.response).toBe(restart ? undefined : 'accepted-first');
    expect(await acknowledgeBrowserInput(row.id, 'fast-answer-document', null, 'native-after-answer')).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'sent',
      messageId: 'native-after-answer', deliveredAt: expect.any(Number) });
    expect(await acknowledgeBrowserInput(row.id, 'fast-answer-document', null, 'native-after-answer')).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'fast-answer-document', null, 'other-native-id')).toBe(false);
    expect((await listInputs())[0]).toMatchObject({ messageId: 'native-after-answer' });
    expect((await listInputs())[0]?.response).toBe(restart ? undefined : 'accepted-first');
    // The prior answer is settled; restart does not recreate a helper waiter or a Send.
    // After private-answer redaction the already accepted UUID must still acknowledge its
    // exact original result, without changing any receipt or delivering a new answer.
    expect(await completeBrowserDecision(row.id, 'fast-answer-document', 'accepted-first')).toBe(true);
    expect(await listInputs()).toHaveLength(1);
  });
  it('rejects malformed helper screenshots before creating an outbox row', async () => {
    await expect(requestBrowserDecision('Read this', new AbortController().signal, {
      images: [{ name: 'bad.webp', dataUrl: 'data:image/webp;base64,AAAA' }]
    })).rejects.toThrow('Invalid image attachment');
    expect(await listInputs()).toEqual([]);
  });
  it('rejects a late answer immediately after cancellation', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const rejection = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    controller.abort();
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
    await rejection;
    expect((await listInputs())[0]?.state).toBe('cancelled');
  });
  it('rejects a pre-send failure without waiting for timeout', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const rejection = expect(answer).rejects.toThrow('goal_browser_send_failed: composer missing');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    await failBrowserInput(row.id, 'document', 'composer missing');
    await rejection;
    expect((await listInputs())[0]?.state).toBe('failed');
  });

  it.each([false, true])('holds an exact deterministic envelope refusal only before native authorization (authorized: %s)', async authorized => {
    const refusal = 'Required prompt header/footer validation failed before Send. Check the companion status and repair the prepared input before retrying.';
    const answer = requestBrowserDecision('Private original task must remain retained', new AbortController().signal);
    const expected = authorized ? 'goal_browser_send_failed: ' + refusal : 'goal_browser_prompt_envelope_invalid';
    const rejected = expect(answer).rejects.toThrow(expected);
    const row = (await listInputs())[0]!;
    const prepared = await claimBrowserInput(row.id, 'envelope-failure-owner', null, true);
    expect(prepared).not.toBeNull();
    if (authorized) expect(await authorizeBrowserInput(row.id, 'envelope-failure-owner', null)).toBe(true);
    expect(await failBrowserInput(row.id, 'foreign-owner', refusal)).toBe(false);
    expect(await failBrowserInput(row.id, 'envelope-failure-owner', refusal)).toBe(true);
    await rejected;
    const retained = (await listInputs()).find(item => item.id === row.id)!;
    expect(retained).toMatchObject({ id: row.id, state: 'failed' });
    expect(retained.sendAuthorizedAt !== undefined).toBe(authorized);
    expect(retained.messageId).toBeUndefined();
    expect(retained.deliveredAt).toBeUndefined();
    if (!authorized) {
      expect(retained.error).toBe('goal_browser_prompt_envelope_invalid');
      expect(retained.recoveryFailure?.phase).toBe('pre_send_preparation');
      expect((await readDurable<any[]>('session-input'))?.find(item => item.id === row.id)?.deliveryText).toBe(prepared!.text);
      expect(retained.error).not.toContain('Private original task');
    }
  });

  it.each(['deliveredSessionId', 'response'] as const)('does not call a contradictory %s helper positively unsent or grant its explicit retry', async field => {
    const refusal = 'Required prompt header/footer validation failed before Send. Check the companion status and repair the prepared input before retrying.';
    const answer = requestBrowserDecision('Retain anomalous helper custody', new AbortController().signal,
      { sourceSessionId: sessionId, sourceTurnId: 'exact-anomalous-turn' });
    const rejected = expect(answer).rejects.toThrow('goal_browser_send_failed: ' + refusal);
    const row = (await listInputs())[0]!;
    const durable = await import('../src/main/durable.js');
    const write = durable.writeDurableNow;
    const injected = vi.spyOn(durable, 'writeDurableNow').mockImplementation(async (name, value) => {
      if (name === 'session-input' && Array.isArray(value)) {
        const selected = value.find(entry => entry.id === row.id && entry.owner === 'anomalous-envelope-owner');
        if (selected) selected[field] = field === 'response' ? 'Retained private answered content' : 'existing-delivered-session';
      }
      return write(name, value);
    });
    try { expect(await claimBrowserInput(row.id, 'anomalous-envelope-owner', null, true)).not.toBeNull(); }
    finally { injected.mockRestore(); }
    expect(await failBrowserInput(row.id, 'anomalous-envelope-owner', refusal)).toBe(true);
    await rejected;
    const failed = (await readDurable<any[]>('session-input'))!.find(entry => entry.id === row.id)!;
    expect(failed.error).toBe(refusal);
    await writeDurableNow('session-input', [{ ...failed, error: 'goal_browser_prompt_envelope_invalid' }]);
    resetInputForTests();
    expect(await authorizeBrowserHelperRetry(row.id, sessionId, 'exact-anomalous-turn')).toBe(false);
  });

  it('permits one deliberate source-bound retry of the retained legacy exact envelope refusal without rewriting that failed row', async () => {
    const refusal = 'Required prompt header/footer validation failed before Send. Check the companion status and repair the prepared input before retrying.';
    const answer = requestBrowserDecision('Legacy retained helper payload', new AbortController().signal,
      { sourceSessionId: sessionId, sourceTurnId: 'legacy-envelope-turn', lifetime: 'temporary-planner' });
    const rejected = expect(answer).rejects.toThrow('goal_browser_prompt_envelope_invalid');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'legacy-envelope-owner', null, true);
    await failBrowserInput(row.id, 'legacy-envelope-owner', refusal);
    await rejected;
    const retained = (await readDurable<any[]>('session-input'))!.find(entry => entry.id === row.id)!;
    const legacy = { ...retained, error: refusal };
    await writeDurableNow('session-input', [legacy]); resetInputForTests();
    expect(await authorizeBrowserHelperRetry(row.id, sessionId, 'wrong-source-turn')).toBe(false);
    expect(await authorizeBrowserHelperRetry(row.id, 'wrong-source-session', 'legacy-envelope-turn')).toBe(false);
    expect(await authorizeBrowserHelperRetry(row.id, sessionId, 'legacy-envelope-turn')).toBe(true);
    expect(await readDurable('session-input')).toEqual([legacy]);
    for (const patch of [{ sendAuthorizedAt: Date.now() }, { messageId: 'native-existing' },
      { deliveredAt: Date.now() }, { deliveredSessionId: 'native-delivered' }, { response: 'saved answer' },
      { toolReceiptUncertain: true }, { lifetime: undefined }, { purpose: 'user' },
      { error: refusal + ' altered' }]) {
      await writeDurableNow('session-input', [{ ...legacy, ...patch }]); resetInputForTests();
      expect(await authorizeBrowserHelperRetry(row.id, sessionId, 'legacy-envelope-turn')).toBe(false);
    }
  });
  it('rejects cancellation that races a persisted answer', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const rejection = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      controller.abort();
      await realRename(from, to);
    });
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
    await rejection;
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', response: undefined });
  });
  it('handles cancellation during slow enqueue without leaking an unhandled rejection', async () => {
    const controller = new AbortController();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      controller.abort();
      await realRename(from, to);
    });
    await expect(requestBrowserDecision('Choose one', controller.signal)).rejects.toThrow();
    expect((await listInputs())[0]?.state).toBe('cancelled');
    expect(await pendingBrowserInputs()).toEqual([]);
  });
  it('cancels orphan decisions on restart before advertising them', async () => {
    const row: InputEntry = { ...input({ sessionId: null }), purpose: 'decision', state: 'queued', owner: null, createdAt: 1, conversationId: null };
    await writeDurableNow('session-input', [row]);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect((await listInputs())[0]?.state).toBe('cancelled');
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
  });
});

it('delivers one finish task per boundary, keeps normal inputs unblocked, and permits edits only before handout', async () => {
  const first = await enqueueInput(input({ mode: 'finish', text: 'Stage one' }));
  const second = await enqueueInput(input({ mode: 'finish', text: 'Stage two' }));
  expect(await editQueuedInput(second.id, 'Stage two revised')).toBe(true);
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(first.id, 'browser', binding.conversationId)).toBeNull();
  expect(await offerToolInput(sessionId, binding.conversationId, 'ordinary', 0)).toEqual([]);
  expect(await hasEligibleToolInput(sessionId)).toBe(false);
  expect(await hasEligibleToolInput(sessionId, true)).toBe(true);
  const one = await offerToolInput(sessionId, binding.conversationId, 'finish', 0, true);
  expect(one).toHaveLength(1); expect(one[0]?.text).toContain('Stage one');
  expect(await editQueuedInput(first.id, 'Too late')).toBe(false);
  expect(await offerToolInput(sessionId, binding.conversationId, 'overlap', 0, true)).toEqual(one);
  expect((await listInputs()).find(row => row.id === second.id)?.state).toBe('queued');
  const two = await offerToolInput(sessionId, binding.conversationId, 'next-finish', now + 1, true);
  expect(two).toHaveLength(1); expect(two[0]?.text).toContain('Stage two revised');
  expect((await listInputs()).find(row => row.id === first.id)?.state).toBe('sent');
});

it('a queued finish task does not prevent a normal browser message from being claimed', async () => {
  await enqueueInput(input({ mode: 'finish' }));
  const ordinary = await enqueueInput(input());
  expect(await claimBrowserInput(ordinary.id, 'browser', binding.conversationId)).toMatchObject({ id: ordinary.id });
});

it.each(['finish', 'after-turn'] as const)('sends only one queued %s after each exact completed turn, including across restart', async mode => {
  binding.model = 'gpt-5.6-sol';
  binding.finishEnabled = false;
  const first = await enqueueInput(input({ mode, text: 'Second stage' }));
  const second = await enqueueInput(input({ mode, text: 'Third stage' }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'turn-one', time: now + 1 };
  expect(await pendingBrowserInputs()).toEqual([{ id: first.id, conversationId: binding.conversationId }]);
  await claimBrowserInput(first.id, 'page', binding.conversationId, true);
  const explicitFollower = await enqueueInput(input({ text: 'Queued explicit message' }));
  expect(explicitFollower).toMatchObject({ state: 'queued', mode: 'after-turn', queuedBehindDelivery: true });
  await authorizeBrowserInput(first.id, 'page', binding.conversationId);
  expect(await pendingBrowserInputs()).toEqual([]);
  await acknowledgeBrowserInput(first.id, 'page', binding.conversationId, 'stage-user-one');
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(second.id, 'page', binding.conversationId, true)).toBeNull();
  binding.activeTurnId = 'turn-two';
  expect(await pendingBrowserInputs()).toEqual([]);
  binding.activeTurnId = null;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'turn-two', time: now + 2 };
  expect(await pendingBrowserInputs()).toEqual([{ id: second.id, conversationId: binding.conversationId }]);
});

it.each(['finish', 'after-turn'] as const)('does not advance %s on interruption, unknown outcome, error, or stale completion', async mode => {
  binding.model = 'gpt-5.6-sol';
  const row = await enqueueInput(input({ mode }));
  for (const outcome of ['interrupted', 'unknown', 'error', 'failed', 'stopped', 'stalled']) {
    binding.end = { kind: 'turn_end', outcome, turnId: 'turn-one', time: now + 1 };
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).toBeNull();
  }
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'old-turn', time: now - 1 };
  expect(await pendingBrowserInputs()).toEqual([]);
});

it.each(['finish', 'after-turn'] as const)('spends a settled Thinking failed once for ten queued %s messages across restart', async mode => {
  const rows = [];
  for (let n = 0; n < 10; n++) rows.push(await enqueueInput(input({ mode, afterTurn: true, text: `Checkpoint ${n}` })));
  binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-pro-turn', time: now + 1, seq: 12 };
  expect(await pendingBrowserInputs()).toEqual([]);
  await fileSilenceInput(sessionId, binding.conversationId, binding.end.turnId, () => true);
  expect(await pendingBrowserInputs()).toEqual([{ id: rows[0]!.id, conversationId: binding.conversationId, silenceTurnId: binding.end.turnId }]);
  expect(await claimBrowserInput(rows[1]!.id, 'page', binding.conversationId, true)).toBeNull();
  expect(await claimBrowserInput(rows[0]!.id, 'page', binding.conversationId, true)).not.toBeNull();
  expect(await authorizeBrowserInput(rows[0]!.id, 'page', binding.conversationId)).toBe(true);
  expect(await acknowledgeBrowserInput(rows[0]!.id, 'page', binding.conversationId, 'next-native-user')).toBe(true);
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect((await listInputs()).filter(row => row.state === 'queued')).toHaveLength(9);
  binding.end = { ...binding.end, turnId: 'next-failed-pro-turn', time: now + 2 };
  await fileSilenceInput(sessionId, binding.conversationId, binding.end.turnId, () => true);
  expect(await pendingBrowserInputs()).toEqual([{ id: rows[1]!.id, conversationId: binding.conversationId, silenceTurnId: binding.end.turnId }]);
});

it.each(['late-tool', 'running-tool', 'new-turn', 'different-end', 'blocked'])('revokes a Thinking failed claim before Send after %s', async change => {
  const row = await enqueueInput(input({ mode: 'after-turn', afterTurn: true }));
  binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-pro-turn', time: now + 1, seq: 12 };
  await fileSilenceInput(sessionId, binding.conversationId, binding.end.turnId, () => true);
  expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
  if (change === 'late-tool') binding.lastToolCallAt = now + 2;
  if (change === 'new-turn') binding.activeTurnId = 'resumed-turn';
  if (change === 'different-end') binding.end = { ...binding.end, turnId: 'other-turn' };
  if (change === 'blocked') binding.blocked = true;
  if (change === 'running-tool') {
    await trackInFlight({ startedAt: now + 2, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
      caller: { requestId: 'resumed-work', conversationId: binding.conversationId, transportKey: null } }, async () => {
      expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
    });
  } else expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
});

it('keeps Astra finish-only tasks queued after Thinking failed without explicit after-turn opt-in', async () => {
  await enqueueInput(input({ mode: 'finish' }));
  binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-pro-turn', time: now + 1, seq: 12 };
  expect(await pendingBrowserInputs()).toEqual([]);
});

it('does not drain another stage while a finish-tool receipt is outstanding', async () => {
  await enqueueInput(input({ mode: 'finish' }));
  await enqueueInput(input({ mode: 'finish' }));
  await offerToolInput(sessionId, binding.conversationId, 'finish', 0, true);
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'turn-one', time: now + 1 };
  expect(await pendingBrowserInputs()).toEqual([]);
});
it('preserves more than 100 finish tasks through restart without consuming the one direct slot', async () => {
  const ids = [];
  for (let index = 0; index < 110; index++) ids.push((await enqueueInput(input({ mode: 'finish', text: `Stage ${index}` }))).id);
  resetInputForTests();
  expect((await listInputs()).filter(row => row.mode === 'finish').map(row => row.id)).toEqual(ids);
  const direct = await enqueueInput(input());
  const queued = await enqueueInput(input());
  expect(queued).toMatchObject({ mode: 'after-turn', requestedMode: 'auto', queuedBehindDelivery: true, state: 'queued' });
  await cancelInput(direct.id);
  resetInputForTests();
  expect((await listInputs()).filter(row => row.mode === 'finish')).toHaveLength(110);
});

it('keeps an unacknowledged finish task ambiguous after restart without draining the next stage', async () => {
  const first = await enqueueInput(input({ mode: 'finish', text: 'First stage' }));
  const second = await enqueueInput(input({ mode: 'finish', text: 'Second stage' }));
  expect(await offerToolInput(sessionId, binding.conversationId, 'finish', 0, true)).toEqual([{ text: first.text, images: [] }]);
  resetInputForTests();
  const replay = await offerToolInput(sessionId, binding.conversationId, 'restart', now + 10, true);
  expect(replay).toEqual([]);
  expect((await listInputs()).find(row => row.id === first.id)).toMatchObject({ state: 'tool', toolReceiptUncertain: true });
  expect((await listInputs()).find(row => row.id === second.id)?.state).toBe('queued');
  expect(await editQueuedInput(first.id, 'Cannot change claimed text')).toBe(false);
});

it('keeps future finish tasks after the normal send expiry', async () => {
  const row = await enqueueInput(input({ mode: 'finish' }));
  now += 60 * 60000;
  expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('queued');
});

it('rejects an oversized full plan before admission instead of silently starving tool delivery', async () => {
  const args = input({ text: '界'.repeat(16000), objective: 'Complete task', stages: Array.from({ length: 11 }, () => '界'.repeat(16000)) });
  await expect(enqueueInput(args)).rejects.toThrow('12,000');
  expect(await listInputs()).toEqual([]);
});
it('reports oversized legacy prepared tool input as failed without blocking later instructions', async () => {
  await seedLegacyInput(input({ text: '界'.repeat(16000), objective: 'Complete task', stages: Array.from({ length: 11 }, () => '界'.repeat(16000)) }));
  const next = await seedLegacyInput(input({ text: 'A deliverable instruction' }));
  const offered = await offerToolInput(sessionId, binding.conversationId, 'request', now);
  expect(offered).toHaveLength(1);
  expect(offered[0]?.text).toContain(next.text);
  expect((await listInputs())[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('delivery limit') });
});
it('accepts a full 16k original request and a workflow within the UI 12k limit', async () => {
  const row = await enqueueInput(input({ sessionId: null, objective: '界'.repeat(16000), text: '界'.repeat(5000), stages: ['界'.repeat(6900)] }));
  const claimed = await claimBrowserInput(row.id, 'page', null, true);
  expect(claimed?.deliveryText).toContain(row.objective);
  expect(Buffer.byteLength(claimed!.deliveryText!)).toBeLessThan(128000);
});
it.each(['exact', 'offered', 'authorized', 'delivered', 'owned', 'other-error'] as const)(
  'retains explicit pre-Send retry custody for a cold scope-preparation failure: %s', async variant => {
  const row = { ...input(), createdAt: now - 100, conversationId: binding.conversationId,
    state: 'failed' as const, owner: null,
    error: 'Native Input human authorship is unverified; reconcile the exact original outbox/native ACK before task-version authorization.' } as InputEntry;
  if (variant === 'offered') row.offeredAt = now;
  if (variant === 'authorized') row.sendAuthorizedAt = now;
  if (variant === 'delivered') row.messageId = 'native-message';
  if (variant === 'owned') row.owner = 'native-owner';
  if (variant === 'other-error') row.error = 'An unknown outcome is not a preparation receipt.';
  await writeDurableNow('session-input', [row]);
  resetInputForTests();
  const restored = (await listInputs())[0]!;
  expect(restored.state).toBe('failed');
  expect(restored.requiresAuthorization === true).toBe(variant === 'exact');
  expect(await pendingBrowserInputs()).toEqual([]);
});

it('records a preparation refusal before the first offer as confirmed pre-Send without retrying automatically', async () => {
  configureInputDelivery({ applyAutomation: automate, changed,
    prepareText: async () => { throw new Error('Native execution scope is incomplete; recover human acceptance and corrections before claiming this Input.'); } });
  const row = await enqueueInput(input());
  await expect(claimBrowserInput(row.id, 'page', binding.conversationId, true)).rejects.toThrow(/scope is incomplete/);
  expect((await listInputs()).find(entry => entry.id === row.id))
    .toMatchObject({ state: 'failed', owner: null, requiresAuthorization: true });
  expect(await pendingBrowserInputs()).toEqual([]);
});

it('rejects an oversized restored plan before browser handout and leaves a visible failure', async () => {
  const row = await seedLegacyInput(input({ sessionId: null, text: '界'.repeat(16000), stages: Array.from({ length: 11 }, () => '界'.repeat(16000)) }));
  await expect(claimBrowserInput(row.id, 'page', null, true)).rejects.toThrow('delivery limit');
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'failed', owner: null, error: expect.stringContaining('delivery limit') });
  expect(await pendingBrowserInputs()).toEqual([]);
});
it.each(['goal', 'loop'] as const)('delivers the complete saved %s objective even when its generated opening omits constraints', async automation => {
  configureInputDelivery({ applyAutomation: automate, changed, prepareText: entry => entry.text + '\nHarness reminder' });
  const first = await enqueueInput(input({ sessionId: null, automation, objective: 'Report numbered arithmetic replies. Use no tools, files or workers.', text: 'LOOP_CEDAR_1' }));
  const claimed = await claimBrowserInput(first.id, 'page', null, true);
  expect(claimed?.deliveryText).toContain(first.objective);
  expect(claimed?.deliveryText).toContain(first.text);
  expect(claimed?.deliveryText).toContain('Harness reminder');
  expect((await listInputs()).find(row => row.id === first.id)?.text).toBe(first.text);
  resetInputForTests();
  expect((await listInputs()).find(row => row.id === first.id)?.deliveryText).toBe(claimed?.deliveryText);
});
it('delivers the original objective and complete workflow in the first plan message', async () => {
  configureInputDelivery({ applyAutomation: automate, changed, prepareText: entry => entry.text + '\nHarness reminder' });
  const first = await enqueueInput(input({ sessionId: null, objective: 'Build the whole requested application with two subagents.', text: 'Implement all requirements; delegate immediately.', stages: ['Exercise the app with computer use and fix failures.', 'Independent code review and final acceptance.'] }));
  const claimed = await claimBrowserInput(first.id, 'page', null, true);
  expect(claimed?.deliveryText).toContain(first.objective);
  for (const stage of [first.text, ...first.stages!]) expect(claimed?.deliveryText).toContain(stage);
  expect(claimed?.deliveryText).toContain('Harness reminder');
  expect((await listInputs()).find(row => row.id === first.id)?.text).toBe(first.text);
  resetInputForTests();
  expect((await listInputs()).find(row => row.id === first.id)?.deliveryText).toBe(claimed?.deliveryText);
});
it('durably queues all finish-plan stages immediately and keeps manual deletion and edits independent', async () => {
  const args = input({ mode: 'finish', text: 'First checkpoint', stages: ['Delete this checkpoint', 'Last checkpoint'] });
  const first = await enqueueInput(args);
  expect(first.stagesApplied).toBe(true);
  const initial = await listInputs();
  expect(initial.map(row => row.text)).toEqual([args.text, ...args.stages!]);
  expect(initial.every(row => row.state === 'queued' && row.mode === 'finish')).toBe(true);
  expect(await pendingBrowserInputs()).toEqual([]);
  resetInputForTests();
  await enqueueInput(args); // An admission retry must not duplicate the children.
  expect((await listInputs()).map(row => row.id)).toEqual(initial.map(row => row.id));
  await cancelInput(initial[1]!.id);
  await editQueuedInput(initial[2]!.id, 'Edited last checkpoint');
  const offered = await offerToolInput(sessionId, binding.conversationId, 'finish-first', now, true);
  expect(offered).toHaveLength(1);
  expect(offered[0]!.text).toBe('First checkpoint');
  now++;
  await acknowledgeToolInput(sessionId, binding.conversationId, 'next-request', now);
  resetInputForTests();
  const remaining = (await listInputs()).filter(row => row.state === 'queued');
  expect(remaining.map(row => row.text)).toEqual(['Edited last checkpoint']);
  expect((await listInputs()).filter(row => row.text === 'Delete this checkpoint')).toHaveLength(1);
});

it('materializes remaining plan stages once after exact delivery, across restart', async () => {
  const first = input({ sessionId: null, model: 'gpt-5.6-sol', reasoningEffort: 'high', stages: ['Implement remaining work', 'Verify acceptance'] });
  await enqueueInput(first);
  expect((await listInputs()).filter(row => row.mode === 'finish')).toHaveLength(0);
  await claimBrowserInput(first.id, 'plan-tab', null);
  await acknowledgeBrowserInput(first.id, 'plan-tab', binding.conversationId);
  resetInputForTests();
  const initial = (await listInputs()).filter(row => row.mode === 'finish');
  expect(initial.map(row => row.text)).toEqual(first.stages);
  expect(initial.every(row => row.sessionId === 'session-one')).toBe(true);
  expect(initial.every(row => row.model === null && row.reasoningEffort === null)).toBe(true);
  resetInputForTests();
  expect((await listInputs()).filter(row => row.mode === 'finish').map(row => row.id)).toEqual(initial.map(row => row.id));
  expect(await pendingBrowserInputs()).toEqual([]);
});

it('publishes browser decision partials only to the current exact waiter without completing it', async () => {
  const { publishBrowserDecision } = await import('../src/main/session/input.js');
  const abort = new AbortController(), publish = vi.fn();
  const answer = requestBrowserDecision('Exact helper question', abort.signal, { publish });
  await vi.waitFor(async () => expect(await listInputs()).toHaveLength(1));
  const entry = (await listInputs())[0]!;
  const claimed = await claimBrowserInput(entry.id, 'helper-owner', null);
  expect(claimed).not.toBeNull();
  await acknowledgeBrowserInput(entry.id, 'helper-owner', 'helper-conversation');
  expect(await publishBrowserDecision(entry.id, 'wrong-owner', 'helper-conversation', 'partial')).toBe(false);
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'other-conversation', 'partial')).toBe(false);
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'helper-conversation', 'x'.repeat(8001))).toBe(false);
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'helper-conversation', 'Actual partial')).toBe(true);
  expect(publish).toHaveBeenCalledExactlyOnceWith('Actual partial');
  abort.abort(); await expect(answer).rejects.toThrow('goal_browser_cancelled');
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'helper-conversation', 'late')).toBe(false);
});


it.each(REASONING_EFFORTS)('preserves canonical effort %s through validation and durable browser pickup', async reasoningEffort => {
  const args = inputArgs.parse(input({ model: 'observed-model', reasoningEffort }));
  const entry = await enqueueInput(args);
  await flushDurable();
  resetInputForTests();
  expect(await claimBrowserInput(entry.id, 'page', binding.conversationId)).toMatchObject({ model: 'observed-model', reasoningEffort });
});

it.each(['default', 'instant', 'High', 'invented', 1, {}])('rejects noncanonical wire effort %j', reasoningEffort => {
  expect(inputArgs.safeParse({ ...input(), reasoningEffort }).success).toBe(false);
});


it('binds decision helper provenance from exact ACK and restores it from the durable receipt', async () => {
  const bindHelper = vi.fn(async () => undefined);
  configureInputDelivery({ applyAutomation: automate, changed, bindHelper });
  const controller = new AbortController();
  const answer = requestBrowserDecision('Plan this', controller.signal, { sourceSessionId: sessionId });
  await vi.waitFor(async () => expect(await listInputs()).toHaveLength(1));
  const [row] = await listInputs();
  await claimBrowserInput(row!.id, 'helper-page', null);
  expect(await acknowledgeBrowserInput(row!.id, 'helper-page', 'exact-helper-chat')).toBe(true);
  expect(bindHelper).toHaveBeenCalledWith('exact-helper-chat', sessionId);
  controller.abort(); await expect(answer).rejects.toThrow('goal_browser_cancelled');
  await flushDurable(); resetInputForTests();
  bindHelper.mockClear(); configureInputDelivery({ applyAutomation: automate, changed, bindHelper });
  await listInputs();
  expect(bindHelper).toHaveBeenCalledWith('exact-helper-chat', sessionId);
});

it.each(['saved', 'deleted', 'tampered', 'wrong-owner', 'restart', 'late-native-receipt'])('saves the exact helper output before acceptance and refuses unsafe closure (%s)', async mode => {
  const answer = requestBrowserDecision('Private temporary plan', new AbortController().signal, {
    sourceSessionId: sessionId, lifetime: 'temporary-planner'
  });
  const row = (await listInputs())[0]!;
  expect(await claimBrowserInput(row.id, 'archive-page', null)).not.toBeNull();
  const response = 'Continue the actual work. 中文 日本語 한국어';
  expect(await completeBrowserDecision(row.id, 'archive-page', response)).toBe(true);
  expect(await answer).toBe(response);
  const file = path.join(directory, 'CoS-helper-outputs', `${row.id}.json`);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(saved).toMatchObject({ inputId: row.id, owner: 'archive-page', response, bytes: Buffer.byteLength(response) });
  expect(JSON.stringify(await readDurable('session-input'))).not.toContain(response);
  if (mode === 'deleted') await fs.unlink(file);
  if (mode === 'tampered') { saved.response = 'Something else'; await fs.writeFile(file, JSON.stringify(saved)); }
  if (mode === 'restart') resetInputForTests();
  if (mode === 'late-native-receipt') {
    expect(await acknowledgeBrowserInput(row.id, 'archive-page', 'helper-provider-route', 'late-native')).toBe(true);
    expect(await completeBrowserDecision(row.id, 'archive-page', response, 'helper-provider-route')).toBe(true);
  }
  expect(await browserDecisionOutputSaved(row.id, mode === 'wrong-owner' ? 'foreign-page' : 'archive-page',
    mode === 'late-native-receipt' ? 'helper-provider-route' : null)).toBe(!['deleted', 'tampered', 'wrong-owner'].includes(mode));
  expect(await listInputs()).toHaveLength(1);
});


it.each(['sent', 'sent-cold', 'expired', 'authorized-unknown'] as const)(
  'preserves exact helper custody while classifying retained delivery (%s)', async mode => {
    const controller = new AbortController();
    const options = { sourceSessionId: sessionId, sourceTurnId: 'retained-delivery-turn',
      lifetime: 'temporary-planner' as const };
    const pending = requestBrowserDecision('Original exact decision', controller.signal, options);
    const rejected = expect(pending).rejects.toThrow('goal_browser_cancelled');
    const original = (await listInputs())[0]!;
    expect(await claimBrowserInput(original.id, 'retained-helper-page', null, true)).not.toBeNull();
    expect(await authorizeBrowserInput(original.id, 'retained-helper-page', null)).toBe(true);
    if (mode !== 'authorized-unknown')
      expect(await acknowledgeBrowserInput(original.id, 'retained-helper-page', null, 'retained-native-question')).toBe(true);
    controller.abort(mode === 'expired' ? new DOMException('goal_browser_answer_expired', 'TimeoutError') : undefined);
    await rejected;
    const retained = (await listInputs())[0]!;
    const durable = await readDurable('session-input');
    if (mode === 'sent-cold') resetInputForTests();
    await expect(requestBrowserDecision('No duplicate replacement', new AbortController().signal, options))
      .rejects.toThrow(mode === 'authorized-unknown' ? 'goal_browser_send_unconfirmed' :
        mode === 'expired' ? 'goal_browser_answer_expired' : 'goal_browser_delivered_helper_unresolved');
    const after = await listInputs();
    expect(after).toHaveLength(1);
    for (const key of ['id', 'state', 'owner', 'sendAuthorizedAt', 'deliveredAt', 'messageId',
      'decisionSourceSessionId', 'decisionSourceTurnId'] as const) expect(after[0]?.[key]).toEqual(retained[key]);
    expect(await readDurable('session-input')).toEqual(durable);
    expect(await claimBrowserInput(original.id, 'foreign-page', null, true)).toBeNull();
    expect(await authorizeBrowserInput(original.id, 'retained-helper-page', null)).toBe(false);
  }
);

it.each(['mixed-unknown', 'mixed-generic', 'future-delivery', 'created-after-authorization', 'authorized-after-delivery'] as const)(
  'classifies every retained helper receipt without replacement (%s)', async mode => {
    const known: InputEntry = { ...input({ sessionId: null, text: 'Retained helper' }),
      purpose: 'decision', lifetime: 'temporary-planner', state: 'cancelled', owner: 'retained-owner', conversationId: null,
      requiresAuthorization: true, decisionSourceSessionId: sessionId, decisionSourceTurnId: 'retained-original-turn',
      createdAt: now - 300, sendAuthorizedAt: now - 200, deliveredAt: now - 100,
      messageId: 'retained-native-question', error: 'goal_browser_answer_expired' };
    const other: InputEntry = { ...known, id: randomUUID(), messageId: 'second-native-question' };
    if (mode === 'mixed-unknown') delete other.messageId;
    if (mode === 'mixed-generic') delete other.error;
    if (mode === 'future-delivery') other.deliveredAt = now + 1;
    if (mode === 'created-after-authorization') other.createdAt = now - 150;
    if (mode === 'authorized-after-delivery') other.sendAuthorizedAt = now - 50;
    await writeDurableNow('session-input', [known, other]);
    const before = await listInputs();
    const durable = await readDurable('session-input');
    await expect(requestBrowserDecision('No replacement for these originals', new AbortController().signal, {
      sourceSessionId: sessionId, sourceTurnId: 'retained-original-turn', lifetime: 'temporary-planner'
    })).rejects.toThrow(mode === 'mixed-generic' ? 'goal_browser_delivered_helper_unresolved' : 'goal_browser_send_unconfirmed');
    expect(await listInputs()).toEqual(before);
    expect(await readDurable('session-input')).toEqual(durable);
  }
);

it.each(['bound', 'temporary-null', 'cold'] as const)(
  'archives a future exact answer-expired helper without restoring its waiter (%s)', async mode => {
    const controller = new AbortController();
    const onAccepted = vi.fn(async () => null);
    const pending = requestBrowserDecision('One exact original decision', controller.signal, {
      sourceSessionId: sessionId, sourceTurnId: 'expired-original-turn',
      lifetime: 'temporary-planner', onAccepted
    });
    const rejected = expect(pending).rejects.toThrow('goal_browser_cancelled');
    const original = (await listInputs())[0]!;
    const route = mode === 'bound' ? 'exact-expired-helper-route' : null;
    expect(await claimBrowserInput(original.id, 'expired-helper-page', null, true)).not.toBeNull();
    expect(await authorizeBrowserInput(original.id, 'expired-helper-page', null)).toBe(true);
    expect(await acknowledgeBrowserInput(original.id, 'expired-helper-page', route, 'expired-native-question')).toBe(true);
    const delivered = (await listInputs())[0]!;
    controller.abort(new DOMException('goal_browser_answer_expired', 'TimeoutError'));
    await rejected;
    expect((await listInputs())[0]).toMatchObject({ id: original.id, state: 'cancelled',
      error: 'goal_browser_answer_expired', owner: delivered.owner, conversationId: route,
      sendAuthorizedAt: delivered.sendAuthorizedAt, deliveredAt: delivered.deliveredAt,
      messageId: delivered.messageId, decisionSourceSessionId: sessionId,
      decisionSourceTurnId: 'expired-original-turn' });
    if (mode === 'cold') resetInputForTests();
    const response = 'Late original output is retained only. 日本語 한국어';
    expect(await completeBrowserDecision(original.id, 'expired-helper-page', response, route)).toBe(true);
    expect(await completeBrowserDecision(original.id, 'expired-helper-page', response, route)).toBe(true);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(await browserDecisionOutputSaved(original.id, 'expired-helper-page', route)).toBe(true);
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'CoS-helper-outputs', `${original.id}.json`), 'utf8'));
    expect(saved).toMatchObject({ inputId: original.id, owner: delivered.owner,
      sourceSessionId: sessionId, sourceTurnId: 'expired-original-turn', response });
    expect(JSON.stringify(await readDurable('session-input'))).not.toContain(response);
    expect(await claimBrowserInput(original.id, 'another-page', route, true)).toBeNull();
    expect(await authorizeBrowserInput(original.id, 'expired-helper-page', route)).toBe(false);
    await expect(requestBrowserDecision('No automatic replacement', new AbortController().signal, {
      sourceSessionId: sessionId, sourceTurnId: 'expired-original-turn', lifetime: 'temporary-planner'
    })).rejects.toThrow('goal_browser_answer_expired');
    expect(await listInputs()).toHaveLength(1);
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', error: 'goal_browser_answer_expired' });
  }
);

it.each(['ordinary-abort', 'plain-error', 'other-timeout', 'unknown-send', 'missing-native-id', 'missing-source-turn'] as const)(
  'does not mark a cancellation as exact native answer expiry (%s)', async mode => {
    const controller = new AbortController();
    const pending = requestBrowserDecision('Retain this exact custody', controller.signal, {
      sourceSessionId: sessionId, ...(mode === 'missing-source-turn' ? {} : { sourceTurnId: 'original-expiry-turn' }),
      lifetime: 'temporary-planner'
    });
    const rejected = expect(pending).rejects.toThrow('goal_browser_cancelled');
    const original = (await listInputs())[0]!;
    await claimBrowserInput(original.id, 'exact-expiry-page', null, true);
    expect(await authorizeBrowserInput(original.id, 'exact-expiry-page', null)).toBe(true);
    if (mode !== 'unknown-send')
      expect(await acknowledgeBrowserInput(original.id, 'exact-expiry-page', null,
        mode === 'missing-native-id' ? undefined : 'exact-native-question')).toBe(true);
    controller.abort(mode === 'ordinary-abort' ? undefined : mode === 'plain-error'
      ? new Error('goal_browser_answer_expired') : new DOMException(
        mode === 'other-timeout' ? 'Another request expired' : 'goal_browser_answer_expired', 'TimeoutError'));
    await rejected;
    expect((await listInputs())[0]?.error).toBeUndefined();
    expect(await settleTimedOutBrowserHelper(sessionId)).toBe(mode === 'unknown-send' ? 'send-outcome-unconfirmed' : 'awaiting-answer');
    expect(await completeBrowserDecision(original.id, 'exact-expiry-page', 'Unproven late output', null, true)).toBe(false);
    expect((await listInputs())[0]?.decisionOutput).toBeUndefined();
  }
);

it.each(['wrong-owner', 'wrong-route', 'unmarked-history', 'generic-cancel', 'unknown-send',
  'missing-source', 'conflicting-supersession', 'foreign-route-from-null', 'archive-unavailable', 'different-answer'] as const)(
  'preserves exact expired helper custody on archive refusal (%s)', async mode => {
    const helper = { ...input({ sessionId: null, text: 'Original private expired request' }),
      purpose: 'decision' as const, lifetime: 'temporary-planner' as const,
      decisionSourceSessionId: sessionId, decisionSourceTurnId: 'original-expired-turn',
      state: 'cancelled' as const, owner: 'exact-expired-page', requiresAuthorization: true,
      createdAt: now - 500, sendAuthorizedAt: now - 400, deliveredAt: now - 300,
      messageId: 'exact-expired-native-question', conversationId: 'exact-expired-route' as string | null,
      error: 'goal_browser_answer_expired' };
    if (mode === 'unmarked-history') delete (helper as Partial<InputEntry>).error;
    if (mode === 'generic-cancel') helper.error = 'goal_browser_cancelled';
    if (mode === 'unknown-send') delete (helper as Partial<InputEntry>).messageId;
    if (mode === 'missing-source') delete (helper as Partial<InputEntry>).decisionSourceTurnId;
    if (mode === 'conflicting-supersession') (helper as Partial<InputEntry>).goalSourceSuperseded = true;
    if (mode === 'foreign-route-from-null') helper.conversationId = null;
    await writeDurableNow('session-input', [helper]);
    const response = 'Exact late output only; never resume this source.';
    const file = path.join(directory, 'CoS-helper-outputs', `${helper.id}.json`);
    if (mode === 'archive-unavailable') await fs.writeFile(path.dirname(file), 'Not a directory');
    const collect = () => completeBrowserDecision(helper.id, mode === 'wrong-owner' ? 'foreign-page' : helper.owner,
      response, ['wrong-route', 'foreign-route-from-null'].includes(mode) ? 'foreign-route' : helper.conversationId, true);
    if (mode === 'archive-unavailable') {
      await expect(collect()).rejects.toThrow();
      expect(await browserDecisionOutputSaved(helper.id, helper.owner, helper.conversationId)).toBe(false);
      await fs.unlink(path.dirname(file));
      expect(await collect()).toBe(true);
    } else if (mode === 'different-answer') {
      expect(await collect()).toBe(true);
      await expect(completeBrowserDecision(helper.id, helper.owner, response + ' changed', helper.conversationId, true)).rejects.toThrow();
      expect(await browserDecisionOutputSaved(helper.id, helper.owner, helper.conversationId)).toBe(true);
    } else {
      expect(await collect()).toBe(false);
      expect((await listInputs())[0]?.decisionOutput).toBeUndefined();
    }
    expect(await listInputs()).toHaveLength(1);
    expect((await listInputs())[0]).toMatchObject({ id: helper.id, state: 'cancelled', owner: helper.owner,
      sendAuthorizedAt: helper.sendAuthorizedAt, deliveredAt: helper.deliveredAt,
      decisionSourceSessionId: helper.decisionSourceSessionId });
  }
);

it.each(['saved', 'cold', 'wrong-owner', 'wrong-route', 'unknown-send', 'ordinary-cancel',
  'tampered-source-session', 'tampered-source-turn', 'different-answer', 'archive-unavailable'] as const)(
  'archives a superseded native-sent helper without reviving its decision (%s)', async mode => {
    const helper = { ...input({ sessionId: null, text: 'Private obsolete planner prompt' }),
      purpose: 'decision' as const, lifetime: 'temporary-planner' as const,
      decisionSourceSessionId: sessionId, decisionSourceTurnId: 'superseded-original-turn',
      state: 'cancelled' as const, owner: 'retired-helper-page', requiresAuthorization: true,
      createdAt: now - 500, sendAuthorizedAt: now - 400, deliveredAt: now - 300,
      messageId: 'exact-native-helper-question', conversationId: 'exact-helper-route',
      goalSourceSuperseded: true as const, error: 'goal_browser_source_superseded' };
    if (mode === 'unknown-send') {
      delete (helper as Partial<InputEntry>).deliveredAt;
      delete (helper as Partial<InputEntry>).messageId;
    }
    if (mode === 'ordinary-cancel') delete (helper as Partial<InputEntry>).goalSourceSuperseded;
    await writeDurableNow('session-input', [helper]);
    await listInputs();
    if (mode === 'cold') resetInputForTests();
    const response = 'Obsolete output stays preserved; it is never a new instruction. 日本語 한국어';
    const file = path.join(directory, 'CoS-helper-outputs', helper.id + '.json');
    if (mode === 'archive-unavailable') await fs.writeFile(path.dirname(file), 'Not a directory');
    const collect = () => completeBrowserDecision(helper.id,
      mode === 'wrong-owner' ? 'foreign-page' : helper.owner, response,
      mode === 'wrong-route' ? 'foreign-route' : helper.conversationId, true);
    const eligible = !['wrong-owner', 'wrong-route', 'unknown-send', 'ordinary-cancel'].includes(mode);
    if (mode === 'archive-unavailable') await expect(collect()).rejects.toThrow();
    else expect(await collect()).toBe(eligible);
    const rows = await listInputs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: helper.id, state: 'cancelled', owner: helper.owner,
      decisionSourceTurnId: helper.decisionSourceTurnId, sendAuthorizedAt: helper.sendAuthorizedAt });
    expect(rows[0]?.sourceHelperId).toBeUndefined();
    if (!eligible || mode === 'archive-unavailable') {
      expect(rows[0]?.decisionOutput).toBeUndefined();
      expect(await browserDecisionOutputSaved(helper.id, helper.owner, helper.conversationId)).toBe(false);
      return;
    }
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved).toMatchObject({ inputId: helper.id, owner: helper.owner,
      sourceSessionId: sessionId, sourceTurnId: helper.decisionSourceTurnId, response });
    expect(JSON.stringify(await readDurable('session-input'))).not.toContain(response);
    if (mode === 'tampered-source-session' || mode === 'tampered-source-turn') {
      saved[mode === 'tampered-source-session' ? 'sourceSessionId' : 'sourceTurnId'] = 'foreign-source';
      await fs.writeFile(file, JSON.stringify(saved));
    }
    if (mode === 'different-answer')
      await expect(completeBrowserDecision(helper.id, helper.owner, response + ' changed',
        helper.conversationId, true)).rejects.toThrow();
    resetInputForTests();
    expect(await browserDecisionOutputSaved(helper.id, helper.owner, helper.conversationId))
      .toBe(!mode.startsWith('tampered-'));
    expect(await listInputs()).toHaveLength(1);
    expect((await listInputs())[0]?.state).toBe('cancelled');
  }
);

it.runIf(process.platform !== 'win32').each(['parent', 'archive'] as const)(
  'holds helper acceptance when the %s directory cannot sync, then retries the same bytes', async (failureAt) => {
    const answer = requestBrowserDecision('Private temporary plan', new AbortController().signal,
      { sourceSessionId: sessionId, lifetime: 'temporary-planner' });
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'archive-page', null);
    const folder = path.join(directory, 'CoS-helper-outputs');
    const refusedFolder = failureAt === 'parent' ? directory : folder;
    const failures = failureAt === 'parent' ? 2 : 1;
    const open = fs.open.bind(fs);
    let refused = 0;
    const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (refused < failures && String(args[0]) === refusedFolder) {
        refused++;
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('Directory flush failed'));
      }
      return handle;
    });
    const response = 'Keep these exact output bytes across the publication retry.';
    for (let attempt = 0; attempt < failures; attempt++) {
      await expect(completeBrowserDecision(row.id, 'archive-page', response)).rejects.toThrow('Directory flush failed');
      expect((await listInputs())[0]?.state).toBe('browser');
      expect(await browserDecisionOutputSaved(row.id, 'archive-page')).toBe(false);
    }
    expect(refused).toBe(failures);
    opening.mockRestore();
    expect(await completeBrowserDecision(row.id, 'archive-page', response)).toBe(true);
    await expect(answer).resolves.toBe(response);
    expect(await browserDecisionOutputSaved(row.id, 'archive-page')).toBe(true);
  });

it('keeps the same helper pending when its output archive cannot be saved', async () => {
  const controller = new AbortController();
  const answer = requestBrowserDecision('Private temporary plan', controller.signal, { sourceSessionId: sessionId, lifetime: 'temporary-planner' });
  const row = (await listInputs())[0]!;
  await claimBrowserInput(row.id, 'archive-page', null);
  await fs.writeFile(path.join(directory, 'CoS-helper-outputs'), 'folder is unavailable');
  await expect(completeBrowserDecision(row.id, 'archive-page', 'Do real work')).rejects.toThrow();
  expect((await listInputs())[0]?.state).toBe('browser');
  expect(await browserDecisionOutputSaved(row.id, 'archive-page')).toBe(false);
  controller.abort(); await expect(answer).rejects.toThrow();
});

it('binds a temporary planner with an exact ChatGPT conversation as helper history', async () => {
  const bindHelper = vi.fn(async () => undefined);
  configureInputDelivery({ applyAutomation: automate, changed, bindHelper });
  const controller = new AbortController();
  const answer = requestBrowserDecision('Private temporary plan', controller.signal, {
    sourceSessionId: sessionId,
    lifetime: 'temporary-planner'
  });
  await vi.waitFor(async () => expect(await listInputs()).toHaveLength(1));
  const [row] = await listInputs();
  await claimBrowserInput(row!.id, 'temporary-helper-page', null);
  expect(await acknowledgeBrowserInput(
    row!.id,
    'temporary-helper-page',
    'temporary-helper-chat'
  )).toBe(true);
  expect(bindHelper).toHaveBeenCalledWith('temporary-helper-chat', sessionId);

  controller.abort();
  await expect(answer).rejects.toThrow('goal_browser_cancelled');
  await flushDurable();
  resetInputForTests();
  bindHelper.mockClear();
  configureInputDelivery({ applyAutomation: automate, changed, bindHelper });
  await listInputs();
  expect(bindHelper).toHaveBeenCalledWith('temporary-helper-chat', sessionId);
});

describe('Astra delivery boundaries and stacked direct input', () => {
  it('maps active Astra after-turn to finish durably and preserves original retry identity', async () => {
    binding.activeTurnId = 'active-astra';
    const args = input({ mode: 'after-turn' });
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ queueAtFinish: true, canInject: true, browserAllowed: false });
    expect(await enqueueInput(args)).toMatchObject({ mode: 'finish', requestedMode: 'after-turn' });
    binding.activeTurnId = null;
    resetInputForTests();
    expect(await enqueueInput(args)).toMatchObject({ mode: 'finish', requestedMode: 'after-turn' });
    expect(await offerToolInput(sessionId, binding.conversationId, 'ordinary', now)).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'finish', now, true)).toHaveLength(1);
  });
  it.each(['disabled', 'worker', 'helper', 'non-astra'])('does not map after-turn for %s', async condition => {
    binding.activeTurnId = 'active';
    if (condition === 'disabled') binding.finishEnabled = false;
    if (condition === 'worker' || condition === 'helper') binding.origin = condition;
    if (condition === 'non-astra') binding.model = 'gpt-5.6-pro';
    expect((await sessionInputPolicy(sessionId)).queueAtFinish).toBe(false);
    expect((await enqueueInput(input({ mode: 'after-turn' }))).mode).toBe('after-turn');
  });
  it('rechecks newer bridge activity at the final browser authorization boundary', async () => {
    let active = false;
    configureInputDelivery({ applyAutomation: automate, changed, activity: () => ({ possible: active, exact: active }) });
    const row = await enqueueInput(input());
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
    active = true;
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ queueAtFinish: true, canInject: true, browserAllowed: false });
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
    active = false;
    expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(true);
  });
  it.each([null, { kind: 'turn_end', outcome: 'unknown', turnId: 'unknown', time: 1000 }])('requires confirmed terminal evidence for an existing Astra chat (%j)', async end => {
    binding.end = end;
    const row = await enqueueInput(input());
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId)).toBeNull();
    expect(await pendingBrowserInputs()).toEqual([]);
    await cancelInput(row.id);
    const initial = await enqueueInput(input({ sessionId: null, model: 'gpt-6-astra' }));
    expect(await claimBrowserInput(initial.id, 'fresh', null)).not.toBeNull();
  });
  it('retains non-Astra browser behavior with unknown terminal evidence', async () => {
    binding.model = 'gpt-5.6-sol'; binding.end = null;
    const row = await enqueueInput(input());
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId)).not.toBeNull();
  });
  it('batches all direct instructions in order while leaving finish stages for a separate boundary', async () => {
    binding.activeTurnId = 'active';
    const stage = await enqueueInput(input({ mode: 'finish', text: 'Stage' }));
    const rows: InputEntry[] = [];
    for (let n = 0; n < 66; n++) rows.push(await enqueueInput(input({ text: `Instruction ${n}` })));
    const offered = await offerToolInputBatch(sessionId, binding.conversationId, 'poll', now, true);
    expect(offered.messages).toHaveLength(66);
    expect(semanticMessages(offered.messages).map(row => row.text)).toEqual(rows.map(row => row.text));
    expect(JSON.stringify(offered).match(/Use session_finish/g)).toHaveLength(1);
    for (const row of rows) expect(JSON.stringify(offered)).not.toContain(row.id);
    expect((await listInputs()).find(row => row.id === stage.id)?.state).toBe('queued');
    expect(await offerToolInputBatch(sessionId, binding.conversationId, 'same', now, true)).toEqual(offered);
    now++;
    await acknowledgeToolInput(sessionId, binding.conversationId, 'same', now);
    expect((await listInputs()).filter(row => row.state === 'sent')).toHaveLength(66);
    expect(await offerToolInput(sessionId, binding.conversationId, 'same', now, true)).toHaveLength(1);
  });
  it('keeps the one pending normal browser send limit when no turn is active', async () => {
    const first = await enqueueInput(input({ text: 'First browser message' }));
    expect((await listInputs())[0]).toMatchObject({ id: first.id, mode: 'auto', state: 'queued', createdAt: now });
    const second = await enqueueInput(input({ text: 'Second browser message' }));
    expect(first).toMatchObject({ mode: 'auto', state: 'queued' });
    expect(second).toMatchObject({ mode: 'after-turn', requestedMode: 'auto', state: 'queued' });
    expect((await pendingBrowserInputs()).map(row => row.id)).toEqual([first.id]);
  });
  it('bounds a multibyte batch with one reminder and delivers the remaining input on the next invocation', async () => {
    binding.activeTurnId = 'active';
    const rows: InputEntry[] = [];
    for (let index = 0; index < 3; index++) rows.push(await enqueueInput(input({ text: `${index}:` + '界'.repeat(15998) })));
    const first = await offerToolInputBatch(sessionId, binding.conversationId, 'request', now);
    expect(semanticMessages(first.messages).map(row => row.text)).toEqual(rows.slice(0, 2).map(row => row.text));
    const envelope = '\n--- New instructions from the user ---\n' + first.messages.map(row => row.text).join('\n\n') + '\n\n' + first.reminder;
    expect(Buffer.byteLength(envelope)).toBeLessThanOrEqual(128000);
    expect((await listInputs()).find(row => row.id === rows[2]!.id)?.state).toBe('queued');
    const second = await offerToolInputBatch(sessionId, binding.conversationId, 'request', ++now);
    expect(semanticMessages(second.messages).map(row => row.text)).toEqual([rows[2]!.text]);
    expect(second.reminder).toBe(first.reminder);
    expect((await listInputs()).filter(row => row.state === 'sent')).toHaveLength(2);
  });
});

it('admits active direct injections independently across chats and preserves all of them', async () => {
  binding.activeTurnId = 'active';
  const a = await enqueueInput(input({ sessionId, text: 'A' }));
  const b = await enqueueInput(input({ sessionId: 'session-two', text: 'B' }));
  const again = await enqueueInput(input({ sessionId, text: 'A2' }));
  expect([a, b, again].every(row => row.transportIntent === 'tool')).toBe(true);
  now += 60001;
  binding.activeTurnId = null;
  resetInputForTests();
  expect((await listInputs()).filter(row => row.state === 'queued')).toHaveLength(3);
  expect(await offerToolInput(sessionId, 'conversation-a', 'tool-a', now)).toHaveLength(2);
  expect(await offerToolInput('session-two', 'conversation-b', 'tool-b', now)).toHaveLength(1);
});
it('keeps an unclaimed ordinary initial browser attempt durable under attention until the user revisits it', async () => {
  const row = await enqueueInput(input({ sessionId: null, dueAt: now + 120000 }));
  expect(row.transportIntent).toBe('browser');
  now += 24 * 60 * 60 * 1000;
  resetInputForTests();
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'queued', deliveryAttentionAt: now });
  expect(await claimBrowserInput(row.id, 'late', null)).toBeNull();
  expect(await rearmQueuedBrowserInput(row.id)).toMatchObject({ id: row.id, deliveryAttentionAt: undefined });
  expect(await claimBrowserInput(row.id, 'late', null)).toMatchObject({ id: row.id, state: 'browser' });
});
it('never times out an intentional after-turn wait or a finish stage', async () => {
  binding.activeTurnId = 'active';
  binding.finishEnabled = false;
  const after = await enqueueInput(input({ mode: 'after-turn', afterTurn: true }));
  const stage = await enqueueInput(input({ mode: 'finish' }));
  now += 86400000;
  resetInputForTests();
  expect((await listInputs()).filter(row => [after.id, stage.id].includes(row.id)).every(row => row.state === 'queued')).toBe(true);
});
it('allows one browser send alongside other-chat tool input but prevents same-chat competing browser sends', async () => {
  binding.activeTurnId = 'active';
  const tool = await enqueueInput(input());
  binding.activeTurnId = null;
  // No terminal proof for the previously active turn: the tool route is still held.
  binding.end = null;
  const browser = await enqueueInput(input({ sessionId: null }));
  expect(browser.transportIntent).toBe('browser');
  expect(await pendingBrowserInputs()).toEqual([{ id: browser.id, conversationId: null }]);
  const nextOpening = await enqueueInput(input({ sessionId: null }));
  expect(nextOpening).toMatchObject({ state: 'queued', queuedBehindBrowser: true });
  await cancelInput(browser.id);
  expect(await pendingBrowserInputs()).toEqual([{ id: nextOpening.id, conversationId: null }]);
  const queued = await enqueueInput(input());
  expect(queued).toMatchObject({ mode: 'after-turn', requestedMode: 'auto', queuedBehindDelivery: true, state: 'queued' });
  expect((await listInputs()).find(row => row.id === tool.id)?.state).toBe('queued');
});

it('recovers only an unoffered tool intent after the target is positively settled', async () => {
  binding.activeTurnId = 'old-active';
  const row = await enqueueInput(input());
  expect(row.transportIntent).toBe('tool');
  binding.activeTurnId = null;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'old-active', time: now + 1 };
  const claimed = await claimBrowserInput(row.id, 'recovery-page', binding.conversationId, true);
  expect(claimed).toMatchObject({ state: 'browser', transportIntent: 'browser' });
  expect(await offerToolInput(sessionId, binding.conversationId, 'competing-tool', now + 2)).toEqual([]);
  expect(await authorizeBrowserInput(row.id, 'recovery-page', binding.conversationId)).toBe(true);
});

it('never redirects a tool input whose offer may already have reached the model', async () => {
  binding.activeTurnId = 'active-tool-turn';
  const row = await enqueueInput(input());
  expect(await offerToolInput(sessionId, binding.conversationId, 'offered-request', now)).toHaveLength(1);
  binding.activeTurnId = null;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'active-tool-turn', time: now + 1 };
  expect(await claimBrowserInput(row.id, 'other-page', binding.conversationId, true)).toBeNull();
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'tool', offeredAt: now });
});

it('keeps Astra finish-only tasks off browser transport across restart and permits explicit per-task opt-in', async () => {
  const row = await enqueueInput(input({ mode: 'finish' }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'astra-ended', time: now + 1 };
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).toBeNull();
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await editQueuedInput(row.id, row.text, true)).toBe(true);
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: binding.conversationId }]);
  expect(await editQueuedInput(row.id, row.text, false)).toBe(true);
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await offerToolInput(sessionId, binding.conversationId, 'finish-only-test', now, true)).toHaveLength(1);
});
it('keeps a finish-only head ahead of opted-in browser tasks until explicitly reordered', async () => {
  const blocked = await enqueueInput(input({ mode: 'finish', text: 'Finish-only implementation' }));
  const after = await enqueueInput(input({ mode: 'finish', text: 'Inspect the current result', afterTurn: true }));
  const later = await enqueueInput(input({ mode: 'finish', text: 'Inspect again', afterTurn: true }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'astra-ended', time: now + 1 };
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(blocked.id, 'page', binding.conversationId, true)).toBeNull();
  expect(await claimBrowserInput(later.id, 'page', binding.conversationId, true)).toBeNull();
  expect(await claimBrowserInput(after.id, 'page', binding.conversationId, true)).toBeNull();
  expect(await reorderQueuedInputs(sessionId, [after.id, blocked.id, later.id])).toBe(true);
  expect(await pendingBrowserInputs()).toEqual([{ id: after.id, conversationId: binding.conversationId }]);
  expect(await claimBrowserInput(after.id, 'page', binding.conversationId, true)).not.toBeNull();
  expect(await authorizeBrowserInput(after.id, 'page', binding.conversationId)).toBe(true);
  expect(await acknowledgeBrowserInput(after.id, 'page', binding.conversationId, 'message-after')).toBe(true);
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect((await listInputs()).find(row => row.id === blocked.id)?.state).toBe('queued');
});

describe('visible input priority before Goal', () => {
  it('keeps an ineligible future finish-only head ahead of Goal without affecting another session', async () => {
    const row = await enqueueInput(input({ mode: 'finish', dueAt: now + 60_000 }));
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await inputBeforeGoal(sessionId, 'previous-turn')).toBe('queued');
    expect(await inputBeforeGoal('session-two', 'previous-turn')).toBeNull();
    expect(await cancelInput(row.id)).toBe(true);
    expect(await inputBeforeGoal(sessionId, 'previous-turn')).toBeNull();
  });

  it.each(['browser', 'tool'] as const)('keeps unresolved %s custody ahead of Goal across input restore', async transport => {
    const row = await enqueueInput(input());
    if (transport === 'browser') expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
    else expect(await offerToolInput(sessionId, binding.conversationId, 'offer', now)).toHaveLength(1);
    resetInputForTests();
    expect(await inputBeforeGoal(sessionId, 'previous-turn')).toBe('queued');
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe(transport);
  });

  it('keeps a consumed completion ahead of Goal after its last user card is sent and restored', async () => {
    const row = await enqueueInput(input({ mode: 'after-turn' }));
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'source-final', time: now + 1 };
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
    expect(await inputBeforeGoal(sessionId, 'source-final')).toBe('queued');
    expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'accepted-question')).toBe(true);
    resetInputForTests();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await inputBeforeGoal(sessionId, 'source-final')).toBe('consumed');
    expect(await inputBeforeGoal(sessionId, 'different-final')).toBeNull();
    expect(await inputBeforeGoal('session-two', 'source-final')).toBeNull();
  });

  it('does not let a tool-only finish checkpoint overtake an after-turn head', async () => {
    const head = await enqueueInput(input({ mode: 'after-turn', text: 'First via browser' }));
    await enqueueInput(input({ mode: 'finish', text: 'Later checkpoint' }));
    expect(await hasEligibleToolInput(sessionId, true)).toBe(false);
    expect(await offerToolInput(sessionId, binding.conversationId, 'finish', now, true)).toEqual([]);
    expect((await listInputs()).every(row => row.state === 'queued')).toBe(true);
    expect(await cancelInput(head.id)).toBe(true);
    expect(await hasEligibleToolInput(sessionId, true)).toBe(true);
    expect((await offerToolInput(sessionId, binding.conversationId, 'next-finish', now + 1, true))[0]?.text).toContain('Later checkpoint');
  });

  it('moves an unclaimed silence boundary to the newly elected visible head without resetting its wait', async () => {
    const a = await enqueueInput(input({ mode: 'after-turn', text: 'A' }));
    const b = await enqueueInput(input({ mode: 'after-turn', text: 'B' }));
    binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-source', time: now, seq: 12 };
    const listenUntil = now + 300_000;
    expect(await fileSilenceInput(sessionId, binding.conversationId, binding.end.turnId, () => true, listenUntil)).toBe(true);
    expect(await reorderQueuedInputs(sessionId, [b.id, a.id])).toBe(true);
    resetInputForTests();
    const reordered = await listInputs();
    expect(reordered.find(row => row.id === a.id)?.silenceBoundary).toBeUndefined();
    expect(reordered.find(row => row.id === b.id)?.silenceBoundary).toMatchObject({ turnId: 'failed-source', listenUntil });
    expect(await pendingBrowserInputs()).toEqual([]);
    now = listenUntil;
    expect(await pendingBrowserInputs()).toEqual([{ id: b.id, conversationId: binding.conversationId, silenceTurnId: 'failed-source' }]);
    expect(await claimBrowserInput(a.id, 'page', binding.conversationId, true)).toBeNull();
    expect(await claimBrowserInput(b.id, 'page', binding.conversationId, true)).not.toBeNull();
  });

  it('uses the shared recovery hold when filing a silent after-turn input', async () => {
    binding.activeTurnId = 'silent-unknown-call';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'silent-unknown-call', time: now, seq: 12 };
    const row = await seedLegacyInput(input({ mode: 'after-turn', text: 'Continue after the recovered turn' }));
    configureInputDelivery({ applyAutomation: automate, changed, callsHoldRecovery: () => false });
    await trackInFlight({ startedAt: now, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
      caller: { requestId: 'unknown-call', conversationId: null, transportKey: null } }, async () => {
      expect(await fileSilenceInput(sessionId, binding.conversationId, 'silent-unknown-call', () => true, now + 60_000)).toBe(true);
    });
    expect((await listInputs()).find(entry => entry.id === row.id)?.silenceBoundary).toMatchObject({ turnId: 'silent-unknown-call' });
  });
});
it('does not infer continuation ownership from restored browser-shaped state without an owner token', () => {
  const restored = {
    id: randomUUID(),
    sessionId,
    conversationId: binding.conversationId,
    text: 'continue',
    mode: 'after-turn',
    dueAt: 0,
    model: null,
    reasoningEffort: null,
    state: 'browser' as const,
    owner: null,
    createdAt: now,
    recoveryChainId: randomUUID()
  } as InputEntry;

  expect(continuationLifecycleDiagnostics(restored)).toMatchObject({
    continuationState: 'claimed_waiting_native_proof',
    owner: null,
    ownerProven: false,
    receiptState: 'missing'
  });
});

it('rechecks Astra finish-only policy at final browser authorization after a model change', async () => {
  binding.model = 'gpt-5.6-pro';
  const row = await enqueueInput(input({ mode: 'finish' }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'ordinary-ended', time: now + 1 };
  expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
  binding.model = 'gpt-6-astra';
  expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
});

it('delivers a legacy finish checkpoint after an ordinary turn without restoring its old Pro selection', async () => {
  const args = input({ mode: 'finish', model: '6', reasoningEffort: 'pro', text: 'Final checkpoint' });
  const row = await enqueueInput(args);
  resetInputForTests();
  binding.model = 'gpt-5.6-sol';
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'ordinary-completed', time: now + 1 };
  expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: binding.conversationId }]);
  const claimed = await claimBrowserInput(row.id, 'page', binding.conversationId, true);
  expect(claimed).toMatchObject({ model: null, reasoningEffort: null });
  expect(operatorPromptBody(claimed!.text)).toBe('Final checkpoint');
  expect(claimed?.deliveryText).not.toContain('session_finish');
  expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(true);
  // Authored identity remains valid even though browser delivery inherits selection.
  expect(await enqueueInput(args)).toMatchObject({ id: row.id, model: '6', reasoningEffort: 'pro' });
  await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-checkpoint');
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
});

describe('one silence delivery for a correction and its next checkpoint', () => {
  async function stagedImage() {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#888888' } }).png().toBuffer();
    return stageInputAttachment({ name: 'shape.png', bytes }, new Set());
  }
  it('keeps explicit image injection on the same active non-Pro tool owner while text steering stays native', async () => {
    binding.model = 'gpt-6-thinking'; binding.activeTurnId = 'image-and-text-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: binding.activeTurnId, time: 900 };
    const image = await stagedImage();
    const correction = await enqueueInput(input({ attachments: [image], attachmentDelivery: 'tool' }));
    expect(correction).toMatchObject({ transportIntent: 'tool', attachmentDelivery: 'tool' });
    expect(correction.directTurn).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'image-exact-call', now)).toEqual([
      expect.objectContaining({ text: correction.text, images: [expect.objectContaining({ dataUrl: expect.stringMatching(/^data:image\/webp;base64,/) })] })
    ]);
  });
  it.each(['text', 'image'] as const)('keeps %s injection on the exact MCP grant after a native completed event', async kind => {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'retained-mcp-turn', time: now, seq: 12 };
    configureInputDelivery({ applyAutomation: automate, changed,
      activity: () => ({ possible: true, exact: true, turnId: 'retained-mcp-turn', model: 'pro' }) });
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: true, injectionTurnId: 'retained-mcp-turn', settled: false, browserAllowed: false });
    const image = kind === 'image' ? await stagedImage() : null;
    const correction = await enqueueInput(input({ ...(image ? { attachments: [image], attachmentDelivery: 'tool' } : {}) }));
    expect(correction.transportIntent).toBe('tool');
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'continued-exact-call', now)).toEqual([
      expect.objectContaining({ text: correction.text, images: image ? [expect.objectContaining({ dataUrl: expect.stringMatching(/^data:image\/webp;base64,/) })] : [] })
    ]);
  });

  it('rejects an image preparation whose retained exact turn changed during normalization', async () => {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'retained-mcp-turn', time: now, seq: 12 };
    let observations = 0;
    configureInputDelivery({ applyAutomation: automate, changed,
      activity: () => ({ possible: true, exact: true, turnId: ++observations === 1 ? 'retained-mcp-turn' : 'replacement-turn', model: 'pro' }) });
    const image = await stagedImage();
    await expect(enqueueInput(input({ attachments: [image], attachmentDelivery: 'tool' })))
      .rejects.toThrow('active chat changed while preparing images');
    expect(await listInputs()).toEqual([]);
  });

  async function bundle(manual: Partial<InputArgs> = {}, checkpoint: Partial<InputArgs> = {}) {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = 'silent-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'silent-turn', time: now, seq: 12 };
    const head = await seedLegacyInput(input({ mode: 'after-turn', text: 'Check geometry', ...checkpoint }));
    const later = await enqueueInput(input({ mode: 'after-turn', text: 'Later checkpoint' }));
    const correction = await enqueueInput(input({ text: 'Use real 3D shapes', ...manual }));
    const listenUntil = now + 600_000;
    expect(await fileSilenceInput(sessionId, binding.conversationId, 'silent-turn', () => true, listenUntil)).toBe(true);
    expect(await pendingBrowserInputs()).toEqual([]);
    // Recovery follows the correction's ticket even though the checkpoint came first.
    expect(await pendingQueuedPickups()).toEqual([expect.objectContaining({ sourceTurnId: 'silent-turn', listenUntil })]);
    now = listenUntil;
    return { head, later, correction };
  }

  it.each(['preparation', 'authorization'] as const)('does not smuggle an Off model route inside a human correction during %s', async phase => {
    let enabled = true;
    vi.spyOn(goalCustody, 'goalSwitchFor').mockImplementation(() => ({ enabled, own: true, mode: 'goal', afterTurn: false }));
    const { head, correction } = await bundle({}, { route: {
      sourceSessionId: 'other-source-session', targetConversationId: binding.conversationId
    } });
    if (phase === 'preparation') configureInputDelivery({ applyAutomation: automate, changed,
      prepareText: async entry => { enabled = false; return entry.text; } });
    const claim = await claimBrowserInput(correction.id, 'human-page', binding.conversationId, true);
    if (phase === 'preparation') expect(claim).toBeNull();
    else {
      expect(claim?.companionInputId).toBe(head.id);
      enabled = false;
      expect(await authorizeBrowserInput(correction.id, 'human-page', binding.conversationId)).toBe(false);
    }
    for (const id of [head.id, correction.id]) {
      const row = (await listInputs()).find(entry => entry.id === id)!;
      expect(row.sendAuthorizedAt).toBeUndefined();
      expect(row.deliveredAt).toBeUndefined();
      expect(row.messageId).toBeUndefined();
    }
  });

  it('claims only the next checkpoint, restores exact bytes, and records one combined native receipt', async () => {
    const { head, later, correction } = await bundle();
    const history = vi.fn(async (_row: Readonly<InputEntry>) => true);
    configureInputDelivery({ applyAutomation: automate, changed, recordDelivered: history });
    const claim = await claimBrowserInput(correction.id, 'first-page', binding.conversationId, true);
    expect(operatorPromptBody(claim!.text)).toBe('Use real 3D shapes\n\nNext queued instruction:\nCheck geometry');
    expect(await claimBrowserInput(head.id, 'other-page', binding.conversationId, true)).toBeNull();
    expect(await editQueuedInput(head.id, 'Racing edit')).toBe(false);
    resetInputForTests();
    const reclaimed = await claimBrowserInput(correction.id, 'replacement-page', binding.conversationId, true);
    expect(reclaimed?.text).toBe(claim?.text);
    expect(await authorizeBrowserInput(correction.id, 'first-page', binding.conversationId)).toBe(false);
    expect(await authorizeBrowserInput(correction.id, 'replacement-page', binding.conversationId)).toBe(true);
    expect(await acknowledgeBrowserInput(head.id, 'replacement-page', binding.conversationId, 'native-id')).toBe(false);
    expect(await acknowledgeBrowserInput(correction.id, 'replacement-page', binding.conversationId, 'native-id')).toBe(true);
    expect(history).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: correction.id, text: operatorPromptBody(claim!.text), deliveryText: claim!.text, messageId: 'native-id' }));
    const rows = await listInputs();
    for (const id of [head.id, correction.id]) expect(rows.find(row => row.id === id)).toMatchObject({ state: 'sent', messageId: 'native-id', historyRecorded: true });
    expect(rows.find(row => row.id === later.id)).toMatchObject({ state: 'queued' });
    expect(await enqueueInput(input({ ...correction }))).toMatchObject({ text: 'Use real 3D shapes' });
  });

  it('releases both unsubmitted claims when real work resumes and injects only the correction', async () => {
    const { head, correction } = await bundle();
    await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    await revokeSilenceInputs(sessionId);
    now += 61_000;
    const rows = await listInputs();
    for (const id of [head.id, correction.id]) expect(rows.find(row => row.id === id)).toMatchObject({ state: 'queued', owner: null });
    expect(rows.find(row => row.id === correction.id)?.companionInputId).toBeUndefined();
    expect(await authorizeBrowserInput(correction.id, 'page', binding.conversationId)).toBe(false);
    expect(await offerToolInput(sessionId, binding.conversationId, 'resumed-call', now)).toEqual([expect.objectContaining({ text: 'Use real 3D shapes' })]);
  });

  it.each(['cancel', 'failure', 'delay'] as const)('keeps both originals under one late receipt after %s', async outcome => {
    const { head, correction } = await bundle();
    await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    await authorizeBrowserInput(correction.id, 'page', binding.conversationId);
    if (outcome === 'cancel') expect(await cancelInput(head.id)).toBe(true);
    if (outcome === 'failure') expect(await failBrowserInput(correction.id, 'page', 'Lost response after Send')).toBe(true);
    if (outcome === 'delay') now += 45_001;
    resetInputForTests();
    for (const id of [head.id, correction.id]) expect((await listInputs()).find(row => row.id === id)).toMatchObject({ state: outcome === 'delay' ? 'browser' : 'cancelled' });
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(correction.id, 'replacement-page', binding.conversationId, true)).toBeNull();
    expect(await acknowledgeBrowserInput(correction.id, 'page', binding.conversationId, 'late-native-id')).toBe(true);
    for (const id of [head.id, correction.id]) expect((await listInputs()).find(row => row.id === id)).toMatchObject({ state: outcome === 'delay' ? 'sent' : 'cancelled', messageId: 'late-native-id' });
  });

  it('preserves authorized bundle custody against a fresh-work revocation and false safe-withdrawal report', async () => {
    const { head, correction } = await bundle();
    await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    await authorizeBrowserInput(correction.id, 'page', binding.conversationId);
    await revokeSilenceInputs(sessionId);
    expect((await listInputs()).filter(row => row.state === 'browser')).toHaveLength(2);
    await failBrowserInput(correction.id, 'page', 'After-turn pickup was withdrawn before Send.');
    expect((await listInputs()).find(row => row.id === head.id)?.state).toBe('cancelled');
    expect(await offerToolInput(sessionId, binding.conversationId, 'resumed', now)).toEqual([]);
  });

  it('reserves both rows before a failing automation transition can publish either claim', async () => {
    const { head, correction } = await bundle({ automation: 'off' });
    automate.mockRejectedValueOnce(new Error('Control persistence failed'));
    await expect(claimBrowserInput(correction.id, 'page', binding.conversationId, true)).rejects.toThrow('Control persistence failed');
    resetInputForTests();
    for (const id of [head.id, correction.id]) expect((await listInputs()).find(row => row.id === id)?.state).toBe('failed');
    expect(await pendingBrowserInputs()).toEqual([]);
  });

  it('preserves the file preparation timeout when only the checkpoint has a native attachment', async () => {
    const file = { id: randomUUID(), name: 'shape.stl', mimeType: 'application/octet-stream', size: 42 };
    const { head, correction } = await bundle({}, { attachments: [file] });
    const claim = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    expect(claim?.attachments).toEqual([file]);
    now += 120_001;
    resetInputForTests();
    for (const id of [head.id, correction.id]) expect((await listInputs()).find(row => row.id === id)?.state).toBe('browser');
    now += 600_000;
    for (const id of [head.id, correction.id]) expect((await listInputs()).find(row => row.id === id)?.state).toBe('cancelled');
  });

  it.each(['text', 'images'] as const)('sends the correction alone if the optional checkpoint would exceed the %s bound', async kind => {
    const image = { name: 'shape.webp', dataUrl: 'data:image/webp;base64,AAAA' };
    const { head, correction } = kind === 'text'
      ? await bundle({ text: 'x'.repeat(90_000) }, { text: 'y'.repeat(10_000) })
      : await bundle({ images: [image, image, image, image] }, { images: [image] });
    const claim = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    expect(operatorPromptBody(claim!.text)).toBe(correction.text);
    expect(claim?.companionInputId).toBeUndefined();
    expect((await listInputs()).find(row => row.id === head.id)?.state).toBe('queued');
  });

  it('lets failed-turn correction bypass the initial five-minute wait while retaining a native-busy five-minute deferral', async () => {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = 'failed-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'failed-turn', time: now, seq: 12 };
    const checkpoint = await enqueueInput(input({ mode: 'after-turn', text: 'Wait for automatic pickup' }));
    const correction = await enqueueInput(input());
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-turn', time: now, seq: 13 };
    await fileSilenceInput(sessionId, binding.conversationId, 'failed-turn', () => true, now + 300_000);
    expect(await pendingBrowserInputs()).toHaveLength(1);
    const immediate = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    expect(operatorPromptBody(immediate!.text)).toBe(correction.text);
    expect(immediate?.companionInputId).toBeUndefined();
    expect((await listInputs()).find(row => row.id === checkpoint.id)?.state).toBe('queued');
    await failBrowserInput(correction.id, 'page', 'After-turn pickup was withdrawn before Send.');
    expect(await deferSilenceInput(correction.id, binding.conversationId, 'failed-turn')).toBe(true);
    expect(await pendingBrowserInputs()).toEqual([]);
    now += 299_999;
    expect(await pendingBrowserInputs()).toEqual([]);
    now += 1;
    expect(await pendingBrowserInputs()).toHaveLength(1);
  });

  it('retains immediate user intent for native files converted from Auto without injecting or advancing a checkpoint', async () => {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = 'failed-files';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'failed-files', time: now, seq: 12 };
    const file = await stageInputAttachment({ text: 'Native file correction' }, new Set());
    const checkpoint = await enqueueInput(input({ mode: 'after-turn', text: 'Automatic checkpoint' }));
    const correction = await enqueueInput(input({ text: 'Read this correction', attachments: [file] }));
    expect(correction).toMatchObject({ mode: 'after-turn', requestedMode: 'auto', transportIntent: 'browser' });
    expect(await offerToolInput(sessionId, binding.conversationId, 'running-call', now)).toEqual([]);
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-files', time: now, seq: 13 };
    await fileSilenceInput(sessionId, binding.conversationId, 'failed-files', () => true, now + 300_000);
    const claim = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    expect(claim).toMatchObject({ attachments: [file] });
    expect(operatorPromptBody(claim!.text)).toBe('Read this correction');
    expect(claim?.companionInputId).toBeUndefined();
    expect(await authorizeBrowserInput(correction.id, 'page', binding.conversationId)).toBe(true);
    expect((await listInputs()).find(row => row.id === checkpoint.id)?.state).toBe('queued');
  });

  it('retains native-busy waiting and its companion when a completed event arrives during the delay', async () => {
    const { correction, head } = await bundle();
    expect(await deferSilenceInput(correction.id, binding.conversationId, 'silent-turn')).toBe(true);
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'silent-turn', time: now, seq: 13 };
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await pendingQueuedPickups()).toEqual([expect.objectContaining({ listenUntil: now + 300_000 })]);
    now += 299_999;
    expect(await claimBrowserInput(correction.id, 'page', binding.conversationId, true)).toBeNull();
    now += 1;
    const claim = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
    expect(claim?.companionInputId).toBe(head.id);
    expect(claim?.text).toContain(head.text);
  });

  it('defers the first failed-view manual send before refresh without MCP proof or an automatic checkpoint', async () => {
    binding.model = 'gpt-6-pro'; binding.finishEnabled = false;
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-before-refresh', time: now, seq: 12 };
    vi.mocked(turnHasMcpCall).mockResolvedValue(false);
    try {
      const checkpoint = await enqueueInput(input({ mode: 'after-turn', text: 'Automatic checkpoint' }));
      const correction = await enqueueInput(input({ text: 'Immediate correction' }));
      expect(correction.transportIntent).toBe('browser');
      expect(correction.silenceBoundary).toBeUndefined();
      expect(await pendingBrowserInputs()).toEqual([expect.objectContaining({ id: correction.id, silenceTurnId: 'failed-before-refresh' })]);
      expect(await deferSilenceInput(correction.id, binding.conversationId, 'wrong-turn')).toBe(false);
      expect(await deferSilenceInput(correction.id, 'wrong-conversation', 'failed-before-refresh')).toBe(false);
      expect(await deferSilenceInput(correction.id, binding.conversationId, 'failed-before-refresh')).toBe(true);
      now += 60_001;
      resetInputForTests();
      expect((await listInputs()).find(row => row.id === correction.id)?.state).toBe('queued');
      expect(await pendingBrowserInputs()).toEqual([]);
      now += 239_999;
      const claim = await claimBrowserInput(correction.id, 'page', binding.conversationId, true);
      expect(operatorPromptBody(claim!.text)).toBe(correction.text);
      expect(claim?.companionInputId).toBeUndefined();
      expect((await listInputs()).find(row => row.id === checkpoint.id)?.state).toBe('queued');
    } finally { vi.mocked(turnHasMcpCall).mockResolvedValue(true); }
  });
});

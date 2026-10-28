import { z } from 'zod';
import { operatorPromptBody, replaceOperatorPromptBody } from './operator-prompt.mjs';

type AcceptanceEvidenceItem = { requirement?: string; acceptance?: string; evidence?: readonly string[]; blocker?: string; nextExperiment?: string; status: string };

/** Derived only from the existing durable session journal and native Input
 * receipts. These are a read-only projection, never a second execution ledger. */
export type RecordedCoreResultEvidence = {
  sessionId: string; conversationId: string; requestId: string | null; callId: string;
  turnId: string; tool: string; attributionMethod: 'request_id' | 'result_receipt';
  resultSha256: string; resultChars: number; resultReceiptId?: string; nativeCallMessageId?: string;
  /** The one complete recorded native final for this exact execution turn. */
  nativeOutputMessageId: string; nativeOutputSha256: string;
  /** Frozen by native Input preparation, not added by a later plan writer. */
  executionScopeSha256?: string;
};
export type RecordedSkillApplicationEvidence = {
  sessionId: string; conversationId: string; skillId: string; bodySha256: string;
  inputMessageId: string; outputMessageId: string; outputSha256: string; turnId: string;
  executionScopeSha256?: string;
};
export type RecordedExecutionEvidence = {
  /** SHA-256 of the exact canonical task version and its genuine correction set. */
  taskVersionSha256?: string;
  coreResults?: readonly RecordedCoreResultEvidence[];
  skillApplications?: readonly RecordedSkillApplicationEvidence[];
};

const EXECUTION_SCOPE_MARKER = 'cos-execution-scope-sha256';
const EXECUTION_SCOPE_SEAL = /<!-- cos-execution-scope-sha256:([a-f0-9]{64}) -->/g;

/** Persist the existing human-scope digest in Input's already-frozen deliveryText;
 * the marker is task metadata, NOT a tool result, permission or human correction. */
export function stampNativeExecutionScope(prompt: string, scopeSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(scopeSha256) || prompt.includes(EXECUTION_SCOPE_MARKER))
    throw new Error('Native execution scope marker is missing, invalid or already present in authored text');
  const body = operatorPromptBody(prompt);
  const stamped = `${body}\n\n<!-- ${EXECUTION_SCOPE_MARKER}:${scopeSha256} -->`;
  return body === prompt ? stamped : replaceOperatorPromptBody(prompt, stamped);
}

/** Only the saved, confirmed Input delivery may supply this source version.
 * Never accept one from the user's authored input or an assistant/plan claim. */
export function executionScopeFromNativeDelivery(
  deliveryText: string | undefined, authoredText: string
): string | null {
  if (!deliveryText || authoredText.includes(EXECUTION_SCOPE_MARKER)) return null;
  const body = operatorPromptBody(deliveryText);
  const matches = [...body.matchAll(EXECUTION_SCOPE_SEAL)];
  if (matches.length !== 1 || !body.trimEnd().endsWith(matches[0]![0])) return null;
  return matches[0]![1]!;
}

const SOURCE_TEST_EVIDENCE = /\b(?:source[- ]?tested|source tests?|unit tests?|focused tests?|regression tests?|unit tests?|vitest|npm test|typecheck|tsc|diff --check|build\s+pass(?:ed)?|lint\s+pass(?:ed)?|tests?\s+(?:pass(?:ed)?|green|exit0))\b/i;
// A test tool being named, scheduled or invoked says nothing about its exit
// status. Keep the positive result adjacent to the relevant check rather than
// borrowing an unrelated success from a different operation in the same note.
const PASSED_SOURCE_TEST_EVIDENCE = /\b(?:source[- ]?tests?|unit tests?|focused tests?|regression tests?|vitest|npm test|typecheck|tsc|diff --check|build|lint|tests?)\b(?:[^.!?;\r\n]|\.(?!\s)){0,130}\b(?:pass(?:ed|es)?|green|succeeded|successful(?:ly)?|exit\s*(?:code\s*)?0|exit0|0\s+failures?)\b|\b(?:pass(?:ed|es)?|green|succeeded|successful(?:ly)?|exit\s*(?:code\s*)?0|exit0)\b(?:[^.!?;\r\n]|\.(?!\s)){0,90}\b(?:source[- ]?tests?|unit tests?|focused tests?|regression tests?|vitest|npm test|typecheck|tsc|diff --check|build|lint|tests?)\b/i;
const UNFINISHED_SOURCE_TEST_EVIDENCE = /\b(?:source[- ]?tests?|unit tests?|focused tests?|regression tests?|vitest|npm test|typecheck|tsc|diff --check|build|lint|tests?)\b[^.!?;\r\n]{0,140}\b(?:scheduled|queued|planned|pending|awaiting|not run|not executed|not yet|still running|in progress|no results?|no exit|unknown outcome|unverified)\b/i;
const CONDITIONAL_SOURCE_TEST_EVIDENCE = /\b(?:if|once|when|assuming|provided(?:\s+that)?)\b[^.!?;\r\n]{0,110}\b(?:source[- ]?tests?|unit tests?|focused tests?|regression tests?|vitest|npm test|typecheck|tsc|tests?)\b(?:[^.!?;\r\n]|\.(?!\s)){0,130}\b(?:pass(?:ed|es)?|green|succeed|exit\s*(?:code\s*)?0|exit0)\b|\b(?:source[- ]?tests?|unit tests?|focused tests?|regression tests?|vitest|npm test|typecheck|tsc|tests?)\b[^.!?;\r\n]{0,95}\b(?:will|should|might|must|expected to)\b[^.!?;\r\n]{0,30}\b(?:pass|succeed|be green|exit0)\b/i;
const INSTALLED_EVIDENCE = /\b(?:installed|installer|release activation|asar|exe|package hash|installed runtime)\b/i;
const LIVE_VERIFIED_EVIDENCE = /\b(?:live[- ]?verified|native workflow verified|real app workflow verified|browser observed|user observed|manual verification (?:was )?(?:passed|successful|succeeded|completed)|observed before\/after|before\/after evidence|installed runtime verified|production app verified)\b/i;
// A label such as "live-verified" is only a claim. The same native observation
// must name its actual passing result, identified build and physical platform.
// Keeping these in one clause prevents a later source-test PASS from completing
// an earlier unlabeled or untested native step.
// An observed comparison or a recovered log records an action, not its outcome.
// Require a passing or matching result from the installed product in that clause.
const LIVE_OBSERVED_RESULT = /\b(?:pass(?:ed|es)?|succeed(?:ed)?|successful(?:ly)?|match(?:ed|es))\b/i;
const NEGATED_MATCH_RESULT = /\b(?:did\s+not|does\s+not|was\s+not|were\s+not|not|never|no)\s+(?:actually\s+)?match(?:ed|es)?\b/i;
// A source check and the native verification label can appear in the same
// evidence sentence. Mask its own positive verb before looking for a *native*
// result: the tool check's PASS never establishes browser/app behavior. Keep
// the surrounding text so a separate fixture/screenshot outcome still counts.
const SOURCE_CHECK_RESULT_IN_LIVE_CLAUSE = /\b(?:source[- ]?(?:tests?|regressions?)|unit tests?|focused tests?|regression tests?|vitest|npm test|npm run build|build checks?|build(?=\s+(?:passed|succeeded|successful))|typecheck|tsc|lint|ci tests?|static analysis|compiler checks?)\b(?:[^.!?;\r\n]|\.(?!\s)){0,105}?\b(?:pass(?:ed|es)?|succeed(?:ed)?|successful(?:ly)?|match(?:ed|es)?|compared|recovered|exit\s*(?:code\s*)?0|exit0)\b/gi;
const LIVE_BUILD_ID = /\b(?:rev(?:ision)?|build|commit|version|sha(?:-256)?|app\.asar)\s*[:=#]?\s*(?:[a-f0-9]{6,64}|v?\d+(?:\.\d+){1,3})\b/i;
const LIVE_PLATFORM = /\b(?:windows|macos|mac\s*os|linux|darwin|win32)\b/i;
const NEGATED_LIVE_VERIFIED_EVIDENCE = /\b(?:not|no|without|never)\s+(?:independently\s+)?(?:live[- ]?verified|native workflow verified|real app workflow verified|browser observed|user observed|manual verification|observed before\/after|before\/after evidence|installed runtime verified|production app verified)\b|\bno\s+native\s+workflow\s+verified\b/i;
// A model's future-tense verification promise can contain the same positive
// words as a completed product observation. Do not count it as acceptance,
// including when a weak claim survives in a legacy persisted checklist.
const OUTSTANDING_LIVE_EVIDENCE = /\b(?:pending|awaiting|planned|scheduled|expected|future|not yet|to be|will be)\b[^.!?;\r\n]{0,90}\b(?:live[- ]?verified|native workflow verified|real app workflow verified|browser observed|user observed|manual verification|observed before\/after|installed runtime verified|production app verified)\b|\b(?:live[- ]?verified|native workflow verified|real app workflow verified|browser observed|user observed|manual verification|observed before\/after|installed runtime verified|production app verified)\b[^.!?;\r\n]{0,90}\b(?:pending|awaiting|planned|scheduled|expected|future|not yet|not run|unperformed|incomplete|still needed|still required)\b/i;
// The same completed-looking phrase can be a conditional acceptance instruction,
// even without "pending" or another explicit future-tense word.
const CONDITIONAL_LIVE_EVIDENCE = /\b(?:if|once|when|assuming|provided(?:\s+that)?)\b[^.!?;\r\n]{0,100}\b(?:live[- ]?verified|native workflow verified|real app workflow verified|browser observed|user observed|manual verification|observed before\/after|installed runtime verified|production app verified)\b/i;
const WORKER_REPORT_EVIDENCE = /\b(?:(?:worker|agent|subagent|helper) (?:report|summary)|assistant reported|agent-reported only)\b/i;
// An answer-recorded helper/outbox receipt establishes its own delivery
// custody, not that the ORIGINAL Main's native Core tool returned. An unrelated
// UI PASS cannot make such a secondhand receipt into direct tool evidence.
const HELPER_CUSTODY_EVIDENCE = /\bhelper\s+(?:(?:answer|response|reply)[- ]recorded|(?:answer|response|reply|delivery|collection|outbox)\s+(?:receipt|recorded|confirmed|collected|delivered))\b|\bhelper\s*=\s*[a-f0-9-]{8,}[^.!?;\r\n]{0,120}\banswer[- ]recorded\b/i;
const LAUNCH_QUEUE_EVIDENCE = /\b(?:launch queue|queued input|queue accepted|durable input|goal ack|loop flag|first send|input queued)\b/i;
const TOOL_COUNT_EVIDENCE = /\b(?:tool[- ]?call count|\d+\s+tool calls?|tools?\s+ran|call count|read count|exec count)\b/i;
const ARCHIVED_OUTPUT_EVIDENCE = /\b(?:archived assistant output|old assistant output|historical assistant (?:claim|summary|response)|(?:old|earlier|prior|archived) assistant (?:claim|summary|response)|assistant (?:summary|claim|response) (?:reports?|claims?|says?|asserts?)|retained transcript claim|archived claim)\b/i;
const AMBIGUOUS_SEND_EVIDENCE = /\b(?:ambiguous send|send ambiguous|delivery ambiguous|ambiguous delivery|unconfirmed send|receipt missing|message id missing)\b/i;
const PROVIDER_RESTRICTED_EVIDENCE = /\b(?:provider[- ]?restricted|provider restriction|usage limit|quota[- ]?held|sign[- ]?in hold|unusual activity|account hold|external provider)\b/i;
const UNKNOWN_EVIDENCE = /\b(?:unverified|not verified|missing denominator|denominator (?:is )?unknown|unknown denominator|no denominator|acceptance count (?:is )?unknown|original acceptance count has not been reconstructed)\b/i;
// A positive UI observation does not prove an original native tool/Send result
// when its own evidence admits that request or result custody is missing.
// Explicitly human-defined test-only outcomes do not require unrelated native calls.
const UNRESOLVED_NATIVE_CUSTODY_EVIDENCE = /\b(?:native|core|code[- ]mode|mcp)\b[^.!?;\r\n]{0,110}\b(?:request|attribution|identity|caller|terminal|result|send|ack|receipt|header)\b[^.!?;\r\n]{0,110}\b(?:missing|absent|unknown|unresolved|unverified|unconfirmed|unattributed|not (?:observed|proved|proven|verified|recorded|confirmed))\b|\b(?:missing|absent|unknown|unresolved|unverified|unconfirmed|unattributed|not (?:observed|proved|proven|verified|recorded|confirmed))\b[^.!?;\r\n]{0,90}\b(?:native|core|code[- ]mode|mcp)\b[^.!?;\r\n]{0,110}\b(?:request|attribution|identity|caller|terminal|result|send|ack|receipt|header)\b/i;
// A UI PASS or native Send ACK can coexist with an explicit admission that
// the useful original Core tool result never arrived. These forms lack the
// older 'missing/unknown/not recorded' tokens but equally cannot verify Loop.
const UNRETURNED_CORE_RESULT_EVIDENCE = /\b(?:no|without)\s+(?:(?:native|actual|recorded|attributable)\s+){0,2}(?:core|code[- ]mode|mcp)\s+(?:tool\s+)?(?:request\s+)?(?:result|reply|response|receipt)\s+(?:was\s+)?(?:returned|received|recorded|arrived|available)\b|\b(?:core|code[- ]mode|mcp)\s+(?:tool\s+)?(?:request\s+)?(?:result|reply|response|receipt)\s+(?:has\s+|had\s+|was\s+|were\s+)?(?:not|never)\s+(?:yet\s+)?(?:returned|received|recorded|arrived|observed|confirmed)\b|\b(?:core|code[- ]mode|mcp)\s+(?:tool\s+)?(?:request\s+)?(?:result|reply|response|receipt)\s+(?:still\s+|is\s+|was\s+)?(?:pending|awaiting)\b|\b(?:core|code[- ]mode|mcp)\s+(?:tool\s+)?request\s+(?:had\s+|has\s+)?no\s+(?:response|result|reply|receipt)\b/i;
// Only a human acceptance that actually requires a returned Core/MCP result
// gets this extra bar. A passing UI screenshot, Send ACK, source test or
// secondhand helper report cannot prove the original tool result arrived.
const CORE_RETURN_REQUIREMENT = /\b(?:core|code[- ]mode|mcp)\s+(?:(?:tool|request|call)\s+){0,2}(?:result|reply|response|receipt)s?\b|\breturned\s+(?:core|code[- ]mode|mcp)\b/i;
const POSITIVE_RETURNED_CORE_RESULT_EVIDENCE = /\b(?:core|code[- ]mode|mcp)\s+(?:(?:tool|request|call)\s+){0,2}(?:result|reply|response|receipt)s?\s+(?:was\s+|has\s+been\s+)?(?:returned|received|recorded|arrived)\b|\b(?:returned|received|recorded)\s+(?:the\s+|an?\s+)?(?:core|code[- ]mode|mcp)\s+(?:(?:tool|request|call)\s+){0,2}(?:result|reply|response|receipt)s?\b/i;
// The native acceptance and the completed Core receipt must refer to the
// same original execution. An independent UI screenshot plus a free-floating
// Core result, even one from another legitimate session, is not an attributable
// original task result. This is still agent-reported evidence, not proof of
// independent installed-product acceptance.
const ORIGINAL_CORE_REQUEST_EVIDENCE = /\b(?:original|same|attributed)\s+(?:(?:native|core|tool)\s+){0,3}request(?:\s*(?:id|#))?\s*[:=#]?\s*[a-z0-9][a-z0-9_-]{5,}\b/i;
const FOREIGN_CORE_REQUEST_EVIDENCE = /\b(?:foreign|different|other|unrelated|wrong|another)\s+(?:(?:native|core|tool|session|conversation)\s+){0,3}(?:request|session|conversation|chat)\b/i;
const TERMINAL_CORE_SUCCESS_EVIDENCE = /\b(?:terminal\s+(?:success|succeeded|passed)|(?:result|request|call)\s+(?:passed|succeeded)|(?:exit|status)\s*[:=#]?\s*(?:0|success))\b/i;
// A positive-looking native/test label can accompany a failed or mismatched
// result. Keep the explicit observed failure authoritative until the agent
// records a new passing result instead of accepting a keyword as completion.
const FAILED_CHECK_EVIDENCE = /\b(?:live[- ]?verified|native workflow|native interaction|real app workflow|browser observed|user observed|production app verified|installed runtime verified|manual verification|focused tests?|regression tests?|unit tests?|vitest|npm test|source tests?)\b[^.!?\r\n]{0,140}\b(?:failed|failing|unsuccessful|mismatch(?:ed)?|did not pass|exit\s*1|exit\s*code\s*[1-9]\d*)\b|\b(?:failed|failing|unsuccessful|mismatch(?:ed)?)\b[^.!?\r\n]{0,100}\b(?:native workflow|native interaction|real app workflow|production app|browser observed|regression tests?|source tests?)\b/i;
// A passing mock, simulator or reused screenshot is valuable source evidence,
// but those words do not mean a real native application executed this acceptance.
// Check individual evidence references; another separate, directly observed
// native result may still qualify without being contaminated by older history.
const NON_NATIVE_PROOF_EVIDENCE = /\b(?:mock(?:ed|ing|s)?|simulat(?:ed|ion|or)|emulat(?:ed|ion|or)|synthetic|source[- ]only|replayed\s+(?:screen(?:shot)?|browser|trace|recording)|archived\s+screen(?:shot)?|recorded\s+screen(?:shot)?|fixture[- ]only|test\s+harness)\b/i;
const NEGATED_NON_NATIVE_CONTEXT = /\b(?:not|no|never|without)\s+(?:a\s+|an\s+|the\s+)?(?:mock(?:ed|ing|s)?|simulat(?:ed|ion|or)|emulat(?:ed|ion|or)|synthetic|source[- ]only|replayed\s+(?:screen(?:shot)?|browser|trace|recording)|archived\s+screen(?:shot)?|recorded\s+screen(?:shot)?|fixture[- ]only|test\s+harness)\b/gi;

function nonNativeResult(clause: string): boolean {
  // "not simulated" says the opposite of "simulated PASS". A separate
  // source-only clause in one reference also cannot veto an observed native
  // result in its own complete, revision/platform-bound clause.
  return NON_NATIVE_PROOF_EVIDENCE.test(clause.replace(NEGATED_NON_NATIVE_CONTEXT, ''));
}

function evidenceText(item: AcceptanceEvidenceItem): string {
  return [...(item.evidence ?? []), item.blocker ?? '', item.nextExperiment ?? ''].join('\n');
}

function evidenceReferences(item: AcceptanceEvidenceItem): string {
  return (item.evidence ?? []).join('\n');
}

function hasLiveVerifiedEvidence(text: string): boolean {
  return LIVE_VERIFIED_EVIDENCE.test(text) && !NEGATED_LIVE_VERIFIED_EVIDENCE.test(text) &&
    !OUTSTANDING_LIVE_EVIDENCE.test(text) && !CONDITIONAL_LIVE_EVIDENCE.test(text);
}

function isSecondhandEvidence(reference: string): boolean {
  return WORKER_REPORT_EVIDENCE.test(reference) || ARCHIVED_OUTPUT_EVIDENCE.test(reference) ||
    LAUNCH_QUEUE_EVIDENCE.test(reference) || TOOL_COUNT_EVIDENCE.test(reference) ||
    HELPER_CUSTODY_EVIDENCE.test(reference);
}

function requiresReturnedCoreResult(item: AcceptanceEvidenceItem): boolean {
  return CORE_RETURN_REQUIREMENT.test(`${item.requirement ?? ''}\n${item.acceptance ?? ''}`);
}

function hasDirectReturnedCoreResult(item: AcceptanceEvidenceItem): boolean {
  return (item.evidence ?? []).some(reference =>
    !isSecondhandEvidence(reference) && POSITIVE_RETURNED_CORE_RESULT_EVIDENCE.test(reference) &&
    !UNRETURNED_CORE_RESULT_EVIDENCE.test(reference) &&
    ((ORIGINAL_CORE_REQUEST_EVIDENCE.test(reference) && !FOREIGN_CORE_REQUEST_EVIDENCE.test(reference)) ||
      (/\bcore-result-receipt=[a-f0-9]{48}\b/.test(reference) &&
       /\bnative-call-message-id=[A-Za-z0-9_.:-]{1,200}\b/.test(reference))) &&
    TERMINAL_CORE_SUCCESS_EVIDENCE.test(reference) &&
    // Never borrow a passing UI result from a *different* evidence reference
    // to complete this Core request. A native result and its Core receipt
    // belong to one report of the same execution.
    hasDirectLiveEvidence({ ...item, evidence: [reference] }));
}

/** A reported observation remains secondhand when its only reference is a
 * worker/helper, old answer, queue or tool-count claim. A separate directly
 * observed native result can support verification without discarding history. */
function hasDirectLiveEvidence(item: AcceptanceEvidenceItem): boolean {
  return (item.evidence ?? []).some(reference => !isSecondhandEvidence(reference) &&
    hasLiveVerifiedEvidence(reference) &&
    reference.split(/;\s*|[.!?](?=\s|$)|\r?\n/).some(clause =>
      LIVE_VERIFIED_EVIDENCE.test(clause) && !nonNativeResult(clause) &&
      LIVE_OBSERVED_RESULT.test(clause.replace(SOURCE_CHECK_RESULT_IN_LIVE_CLAUSE, '')) &&
      LIVE_BUILD_ID.test(clause) && LIVE_PLATFORM.test(clause)));
}

/** Reading or loading a Skill is a preparation fact. Its use is an execution
 * fact. Do not join a prepared Skill assertion to an unrelated native UI PASS
 * and thereby count a real Skill contract as fulfilled. The single recorded
 * native observation must describe the selected body's effect on the output.
 * This remains agent-reported evidence, never installed-product certification. */
function hasNativeSkillApplicationEvidence(item: AcceptanceEvidenceItem): boolean {
  return (item.evidence ?? []).some(reference =>
    !isSecondhandEvidence(reference) && !NEGATED_SKILL_BODY_EVIDENCE.test(reference) &&
    SKILL_BODY_READ_EVIDENCE.test(reference) && SKILL_BODY_APPLIED_EVIDENCE.test(reference) &&
    /\b(?:output|workflow|artifact|screen|ui)\b[^.!?;\r\n]{0,125}\b(?:match(?:ed|es)?|follow(?:ed|s)?|implement(?:ed|s)?|reflect(?:ed|s)?)\b[^.!?;\r\n]{0,95}\b(?:skill\s+(?:body|instructions?|constraints?|contract)|design\s+contract)\b/i.test(reference) &&
    hasDirectLiveEvidence({ ...item, evidence: [reference] }));
}

/** The plan's prose is never the receipt owner. When it cites a recorded
 * execution, each identity must be one complete field inside ONE witness
 * segment, not a prefix of a different call/turn/output or a token borrowed
 * from unrelated commentary. The recorder supplies the expected values. */
function exactExecutionWitness(
  reference: string, marker: string, fields: ReadonlyArray<readonly [string, string | number]>
): boolean {
  const start = reference.indexOf(marker);
  if (start < 0 || reference.indexOf(marker, start + marker.length) >= 0) return false;
  const witness = reference.slice(start);
  return fields.every(([key, expected]) => {
    const tokens = [...witness.matchAll(new RegExp(`(?:^|[\\s;])${key}=([^\\s;]+)`, 'g'))];
    if (tokens.length !== 1) return false;
    const value = tokens[0]![1];
    return value === String(expected) || value === `${expected}.`;
  });
}

function hasRecordedCoreResultReference(
  item: AcceptanceEvidenceItem, execution: RecordedExecutionEvidence
): boolean {
  if (!hasDirectReturnedCoreResult(item) || !execution.taskVersionSha256) return false;
  return (item.evidence ?? []).some(reference => (execution.coreResults ?? []).some(result => {
    const common: Array<readonly [string, string | number]> = [
      ['task-version-sha256', execution.taskVersionSha256!],
      ['session-id', result.sessionId], ['conversation-id', result.conversationId],
      ['call-id', result.callId], ['turn-id', result.turnId], ['tool', result.tool],
      ['result-sha256', result.resultSha256], ['result-chars', result.resultChars],
      ['native-output-message-id', result.nativeOutputMessageId],
      ['native-output-sha256', result.nativeOutputSha256]
    ];
    if (result.attributionMethod === 'request_id') return Boolean(result.requestId) &&
      exactExecutionWitness(reference, 'core-execution-record ', [
        ['attribution', 'request_id'], ...common, ['request-id', result.requestId!],
        ...(result.resultReceiptId || result.nativeCallMessageId ? [
          ['core-result-receipt', result.resultReceiptId ?? ''],
          ['native-call-message-id', result.nativeCallMessageId ?? '']
        ] as Array<readonly [string, string]> : [])
      ]);
    return Boolean(result.resultReceiptId && result.nativeCallMessageId) &&
      exactExecutionWitness(reference, 'core-result-receipt=', [
        ...common, ['core-result-receipt', result.resultReceiptId!],
        ['native-call-message-id', result.nativeCallMessageId!]
      ]);
  }));
}

function hasRecordedSkillApplicationReference(
  item: AcceptanceEvidenceItem, execution: RecordedExecutionEvidence
): boolean {
  if (!hasNativeSkillApplicationEvidence(item) || !execution.taskVersionSha256) return false;
  return (item.evidence ?? []).some(reference => (execution.skillApplications ?? []).some(skill =>
    exactExecutionWitness(reference, 'native-skill-application ', [
      ['skill-id', skill.skillId], ['task-version-sha256', execution.taskVersionSha256!],
      ['skill-body-sha256', skill.bodySha256], ['session-id', skill.sessionId],
      ['conversation-id', skill.conversationId], ['native-input-message-id', skill.inputMessageId],
      ['native-output-message-id', skill.outputMessageId],
      ['native-output-sha256', skill.outputSha256], ['native-turn-id', skill.turnId]
    ])));
}

function hasDirectSourceTestEvidence(item: AcceptanceEvidenceItem): boolean {
  return (item.evidence ?? []).some(reference => PASSED_SOURCE_TEST_EVIDENCE.test(reference) &&
    !UNFINISHED_SOURCE_TEST_EVIDENCE.test(reference) && !CONDITIONAL_SOURCE_TEST_EVIDENCE.test(reference) &&
    !isSecondhandEvidence(reference));
}

function acceptanceIsTestOnly(item: AcceptanceEvidenceItem): boolean {
  // A real human may expressly waive native verification for a test-only
  // outcome. The negated phrase itself cannot make that unit-test criterion
  // a live workflow; the positively observed PASS must still be present.
  const text = `${item.requirement ?? ''}\n${item.acceptance ?? ''}`
    .replace(WAIVES_NATIVE_OUTCOME, '');
  if (/\b(?:live|native|installed|runtime|browser|user observed|manual verification|before\/after|production|reopen|opened|compare|workflow)\b/i.test(text)) return false;
  return /\b(?:unit|source|focused|regression|vitest|npm test|typecheck|tsc|lint|diff --check|tests?)\b[^.\n]{0,120}\b(?:pass(?:ed|es)?|green|exit0|verified|validated)\b/i.test(text) ||
    /\b(?:pass(?:ed|es)?|green|exit0|verified|validated)\b[^.\n]{0,120}\b(?:unit|source|focused|regression|vitest|npm test|typecheck|tsc|lint|diff --check|tests?)\b/i.test(text);
}

function sourceTestEvidenceCanVerify(item: AcceptanceEvidenceItem): boolean {
  return hasDirectSourceTestEvidence(item) && acceptanceIsTestOnly(item);
}

function evidenceDisqualifiesDone(item: AcceptanceEvidenceItem): boolean {
  const text = evidenceText(item);
  return PROVIDER_RESTRICTED_EVIDENCE.test(text) || AMBIGUOUS_SEND_EVIDENCE.test(text) ||
    UNKNOWN_EVIDENCE.test(text) || NEGATED_LIVE_VERIFIED_EVIDENCE.test(text) ||
    OUTSTANDING_LIVE_EVIDENCE.test(text) || CONDITIONAL_LIVE_EVIDENCE.test(text) ||
    FAILED_CHECK_EVIDENCE.test(text) || CONDITIONAL_SOURCE_TEST_EVIDENCE.test(text) ||
    UNFINISHED_SOURCE_TEST_EVIDENCE.test(text) ||
    // A passing negative-path unit test may require that invalid input does not match.
    // It still needs positive test evidence; this exception never verifies native outcomes.
    (!acceptanceIsTestOnly(item) && (UNRESOLVED_NATIVE_CUSTODY_EVIDENCE.test(text) ||
      UNRETURNED_CORE_RESULT_EVIDENCE.test(text) || NEGATED_MATCH_RESULT.test(text) ||
      (requiresReturnedCoreResult(item) && !hasDirectReturnedCoreResult(item)) ||
      (REQUIRES_SKILL_BODY_USE.test(`${item.requirement ?? ''}\n${item.acceptance ?? ''}`) &&
        !hasNativeSkillApplicationEvidence(item))));
}

function doneTrue(item: AcceptanceEvidenceItem): boolean {
  return item.status === 'verified' && !evidenceDisqualifiesDone(item) &&
    (hasDirectLiveEvidence(item) || sourceTestEvidenceCanVerify(item));
}

function evidenceClass(item: AcceptanceEvidenceItem): string {
  if (item.status === 'excluded') return 'user-excluded';
  const context = evidenceText(item);
  const evidence = evidenceReferences(item);
  if (PROVIDER_RESTRICTED_EVIDENCE.test(context)) return 'provider-restricted';
  if (AMBIGUOUS_SEND_EVIDENCE.test(context)) return 'ambiguous-send';
  if (item.status === 'blocked') return 'blocked';
  if (item.status === 'pending') return 'unknown';
  if (UNKNOWN_EVIDENCE.test(evidence) || CONDITIONAL_LIVE_EVIDENCE.test(evidence) ||
      CONDITIONAL_SOURCE_TEST_EVIDENCE.test(evidence) || UNFINISHED_SOURCE_TEST_EVIDENCE.test(evidence) ||
      FAILED_CHECK_EVIDENCE.test(evidence) ||
      (!acceptanceIsTestOnly(item) && (UNRESOLVED_NATIVE_CUSTODY_EVIDENCE.test(evidence) ||
        UNRETURNED_CORE_RESULT_EVIDENCE.test(evidence) || NEGATED_MATCH_RESULT.test(evidence) ||
        (requiresReturnedCoreResult(item) && !hasDirectReturnedCoreResult(item))))) return 'unknown';
  if (hasDirectLiveEvidence(item)) return 'live-verified';
  if (hasDirectSourceTestEvidence(item)) return 'source-tested';
  if (evidence.split(/;\s*|[.!?](?=\s|$)|\r?\n/).some(nonNativeResult)) return 'non-native-only';
  if (WORKER_REPORT_EVIDENCE.test(evidence)) return 'worker-report';
  if (LAUNCH_QUEUE_EVIDENCE.test(evidence)) return 'launch-queue';
  if (TOOL_COUNT_EVIDENCE.test(evidence)) return 'tool-call-count';
  if (ARCHIVED_OUTPUT_EVIDENCE.test(evidence)) return 'archived-assistant-output';
  if (INSTALLED_EVIDENCE.test(evidence)) return 'installed';
  return item.status === 'verified' || SOURCE_TEST_EVIDENCE.test(evidence) ? 'unknown' : 'implemented';
}

function verifiedEvidenceIsOnlyWeakClaim(item: AcceptanceEvidenceItem): boolean {
  if (evidenceDisqualifiesDone(item)) return true;
  // A bare 'I finished it' or a test invocation used to slip through the schema
  // as status=verified even though the compact/Loop projection said done=false.
  // Require a qualifying result for the original acceptance, as doneTrue does.
  return !(hasDirectLiveEvidence(item) || sourceTestEvidenceCanVerify(item));
}

/** Agent-reported acceptance evidence, not an execution or verification authority. */
const acceptanceItemBaseSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/),
  requirement: z.string().trim().min(1).max(500),
  source: z.string().trim().min(1).max(300).describe('Original user request reference, not a generated reminder.'),
  acceptance: z.string().trim().min(1).max(700).describe('Observable outcome.'),
  status: z.enum(['pending', 'implemented', 'verified', 'blocked', 'excluded']),
  // A complete Core witness has task/result/native-output SHA-256s and four
  // real native/session/call identities. The former 600-character entry limit
  // made truthful output-bound verification impossible for normal UUIDs.
  // Keep entries bounded; MAX_AGENT_PLAN_BYTES still caps the entire plan.
  evidence: z.array(z.string().trim().min(1).max(1200)).max(4).optional()
    .describe('Evidence: result, revision/build, platform; not independently verified.'),
  blocker: z.string().trim().min(1).max(500).optional(),
  nextExperiment: z.string().trim().min(1).max(500).optional()
    .describe('Changed experiment/route or external resume condition.'),
  scopeChange: z.string().trim().min(1).max(500).optional().describe('User scope-change reference and exclusion reason.')
}).strict();

const acceptanceItemSchema = acceptanceItemBaseSchema.superRefine((item, ctx) => {
  if (item.status === 'verified' && !item.evidence?.length) ctx.addIssue({ code: 'custom', message: 'Reported verification requires evidence references.', path: ['evidence'] });
  if (item.status === 'verified' && verifiedEvidenceIsOnlyWeakClaim(item)) ctx.addIssue({
    code: 'custom',
    message: 'Verification cannot rely on source tests for non-test acceptance, install receipts, worker claims, queues, tool-call counts, archived assistant output, ambiguous sends, provider restrictions or unknown denominators. Use implemented or blocked status until evidence matches the original acceptance.',
    path: ['evidence']
  });
  if (item.status === 'blocked' && (!item.blocker || !item.nextExperiment)) ctx.addIssue({ code: 'custom', message: 'Blocked acceptance needs a cause and next experiment or resume condition.', path: ['blocker'] });
  if (item.status === 'excluded' && !item.scopeChange) ctx.addIssue({ code: 'custom', message: 'Exclusion requires an explicit user scope-change reference.', path: ['scopeChange'] });
});

const persistedAcceptanceItemSchema = acceptanceItemBaseSchema.superRefine((item, ctx) => {
  if (item.status === 'verified' && !item.evidence?.length) ctx.addIssue({ code: 'custom', message: 'Reported verification requires evidence references.', path: ['evidence'] });
  if (item.status === 'blocked' && (!item.blocker || !item.nextExperiment)) ctx.addIssue({ code: 'custom', message: 'Blocked acceptance needs a cause and next experiment or resume condition.', path: ['blocker'] });
  if (item.status === 'excluded' && !item.scopeChange) ctx.addIssue({ code: 'custom', message: 'Exclusion requires an explicit user scope-change reference.', path: ['scopeChange'] });
});

/** Codex's update_plan contract, with optional per-step detail for the desktop view. */
const checklistSchema = (itemSchema: typeof acceptanceItemSchema | typeof persistedAcceptanceItemSchema) => z.array(itemSchema).max(24)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Checklist IDs must be unique.')
  .refine(items => JSON.stringify(items).length <= 20000, 'Keep the acceptance checklist below 20,000 characters.')
  .optional().describe('Stable IDs; requirement/source/acceptance immutable. Omitted items retained. Changed scope: exclude old item, add new ID.');

const planSchema = z.array(z.object({
  step: z.string().trim().min(1).max(160).describe('Short headline shown to the user.'),
  status: z.enum(['pending', 'in_progress', 'completed']),
  details: z.string().trim().max(2000).optional().describe('Concrete approach, checks or remaining work beneath this headline. Keep useful detail when updating status.')
}).strict()).max(12)
  .refine(steps => steps.filter(step => step.status === 'in_progress').length <= 1, 'At most one step may be in_progress.')
  .refine(steps => steps.reduce((size, step) => size + step.step.length + (step.details?.length ?? 0), 0) <= 12000, 'Keep the complete plan below 12,000 characters.')
  .describe('The complete updated plan. Send an empty array to clear it.');

export const agentPlanUpdateSchema = z.object({
  explanation: z.string().trim().max(1000).optional().describe('Brief explanation of a changed plan.'),
  checklist: checklistSchema(acceptanceItemSchema),
  previewOnly: z.literal(true).optional()
    .describe('Read-only legacy acceptance migration review. Requires an empty plan and no checklist. No plan write or migration authorization.'),
  plan: planSchema
}).strict().superRefine((update, ctx) => {
  if (update.previewOnly && (update.plan.length !== 0 || update.checklist !== undefined)) ctx.addIssue({
    code: 'custom', path: ['previewOnly'],
    message: 'A read-only preview requires plan: [] and no checklist; it never applies updates or acceptance migration.'
  });
});

export const agentPlanSchema = z.object({
  explanation: z.string().trim().max(1000).optional().describe('Brief explanation of a changed plan.'),
  checklist: checklistSchema(persistedAcceptanceItemSchema),
  plan: planSchema,
  updatedAt: z.number().finite().nonnegative()
}).strict();
export type AgentPlanUpdate = z.infer<typeof agentPlanUpdateSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;

/** A later directly authored message may replace a separately saved original
 * acceptance declaration only when it explicitly identifies itself as a human
 * correction. A bare list in copied/older history is not a correction. */
export function explicitlyCorrectsHumanAcceptance(text: string): boolean {
  // Header detection and requirement extraction must share the same authority
  // text. A quoted research/example header cannot suspend the actual human task
  // merely because its ignored body contains no mapped acceptance requirements.
  return /(?:^|\n)\s*(?:current|latest|later|newer)\s+(?:(?:human|user)\s+)?(?:correction|update|follow[- ]?up|instruction)\s*[:\-—]/i
    .test(visibleAcceptanceDeclarations(text));
}

/** Read acceptance only from instruction-bearing prose. Human-authored text
 * can quote an earlier assistant, generated prompt or canonical HTML metadata;
 * that citation is reference material, not permission to replace acceptance.
 * Apply this once for every consumer, including Goal reminders and MCP plans. */
export function visibleAcceptanceDeclarations(text: string): string {
  const withoutComments = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  let fence: string | null = null;
  return withoutComments.split(/\r?\n/).map(line => {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      return '';
    }
    return fence || /^\s*>/.test(line) ? '' : line;
  }).join('\n');
}

/**
 * Some human Goal objectives explicitly enumerate the original acceptance
 * denominator. Read that declaration, not a generated reminder, assistant
 * checkpoint or proposed checklist. Ordinary objectives without a complete
 * declaration keep the standard flexible plan contract.
 */
export function retainedAcceptanceIdsFromObjective(objective: string): string[] | null {
  const visible = visibleAcceptanceDeclarations(objective);
  const declarations: Array<{ pattern: RegExp; contextual: boolean }> = [
    { pattern: /\bthe\s+retained\s+(?:original\s+)?(?:acceptance\s+)?items\s+are\s*:\s*([^\r\n]{1,1800})/gi, contextual: true },
    { pattern: /\b(?:original|retained|active|exact)\s+(?:(?:four|4)[- ]item\s+)?(?:human\s+)?acceptance\s+(?:ids|items|denominator)\s*:\s*([^\r\n]{1,1800})/gi, contextual: false },
    { pattern: /\b(?:retain|preserve|keep)\s+exactly\s+([A-Za-z0-9_`-]+(?:[ \t]*,[ \t]*[A-Za-z0-9_`-]+)*(?:[ \t]+and[ \t]+[A-Za-z0-9_`-]+)?)\s+as\s+(?:the\s+)?(?:only\s+)?(?:active\s+)?acceptance\s+(?:ids|items|denominator)\b/gi, contextual: false },
  ];
  let retained: string[] | null = null;
  for (const { pattern, contextual } of declarations) {
    for (const match of visible.matchAll(pattern)) {
      // "retained items" may describe files, workers or other saved material.
      // Require an acceptance/list context before treating it as authority.
      const context = visible.slice(Math.max(0, match.index - 280), match.index);
      if (contextual && !/\b(?:acceptance|checklist|denominator)\b/i.test(context)) continue;
      const list = (match[1] ?? '').split(/[.!?]/, 1)[0]!.trim()
        .replace(/\s+and\s+/gi, ', ');
      const items = list.split(',').map(item => item.trim().replace(/^\x60|\x60$/g, ''));
      const exactFour = /\b(?:four|4)[- ]item\b/i.test(context.slice(-100)) ||
        /\b(?:four|4)[- ]item\b/i.test(match[0].split(':')[0] ?? '');
      if (items.length === 0 || items.length > 24 ||
          (exactFour && items.length !== 4) ||
          items.some(id => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(id)) ||
          new Set(items).size !== items.length) {
        throw new Error('Saved Goal objective has an incomplete or ambiguous retained acceptance declaration; recover the complete original human request before updating its checklist.');
      }
      if (retained && (retained.length !== items.length || items.some(id => !retained!.includes(id)))) {
        throw new Error('Saved Goal objective has conflicting retained acceptance declarations; reconcile genuine human corrections before changing the checklist.');
      }
      retained = items;
    }
  }
  return retained;
}

/** The original ID is only an address, not the user's finish condition.
 * Where a human objective spells out `id: requirement`, retain that exact
 * substantive requirement as the immutable checklist anchor. Do not try to
 * derive an acceptance contract from free-form assistant summaries, inferred
 * Skill selections or a generated working plan. */
function explicitHumanAcceptanceRequirements(
  objective: string, ids: readonly string[]
): Map<string, string> {
  const requirements = new Map<string, string>();
  if (!ids.length) return requirements;
  const visible = visibleAcceptanceDeclarations(objective);
  // Canonical human prompts also state their original four descriptions in
  // one paragraph: "... canonical_continuity: ... . task_fidelity: ... ."
  // Recognize both those and line-initial Markdown entries, never an arbitrary
  // unbounded prose occurrence or a quoted/generated command.
  const choices = ids.join('|');
  const marker = new RegExp(`(?:^|[.!?]\\s+|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*|\\x60)?(${choices})(?:\\*\\*|\\x60)?\\s*:\\s*`, 'gm');
  const matches = [...visible.matchAll(marker)];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const id = match[1]!;
    const start = match.index! + match[0].length;
    const lineEnd = visible.indexOf('\n', start);
    const end = Math.min(lineEnd < 0 ? visible.length : lineEnd, matches[index + 1]?.index ?? visible.length);
    const description = visible.slice(start, end).trim().replace(/[.!?]\s*$/, '');
    if (!description) continue;
    if (requirements.has(id) && requirements.get(id) !== description)
      throw new Error(`Original human acceptance ${id} has conflicting descriptions; reconcile genuine human corrections before saving its checklist.`);
    requirements.set(id, description);
  }
  return requirements;
}

function normalizedHumanCriterion(value: string): string {
  return value.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/g, '').toLowerCase();
}

/** The caller must first prove that these are genuine human deliveries. A
 * truncated user message is not an authored *complete* requirement, nor proof
 * that previously verified criteria were unchanged. Keep its provenance for
 * review, never promote its text into a new instruction or checklist row. */
export type HumanCorrectionFragment = { text: string; reference: string };

export function unresolvedHumanCorrectionFragments(
  deliveries: readonly (HumanCorrectionFragment & { incomplete: boolean })[]
): HumanCorrectionFragment[] {
  const unresolved = new Map<string, HumanCorrectionFragment>();
  for (const delivery of deliveries) {
    const text = delivery.text.trim();
    if (!text) continue;
    if (delivery.incomplete) {
      unresolved.set(delivery.reference, { text, reference: delivery.reference });
      continue;
    }
    // A later full, positively authored restatement of the same prefix can
    // supersede the fragment. A separately authored complete correction can
    // also do so *explicitly*, but only by enumerating ALL current acceptance
    // IDs and supplying their full per-item meanings. Similar topic words,
    // a new generated reminder, or a bare later 'continue' cannot discharge it.
    let fullySupersedes = false;
    if (explicitlyCorrectsHumanAcceptance(text) &&
        /\b(?:supersedes?|replaces?)\b[^.!?\r\n]{0,90}\b(?:prior|previous|earlier)\b[^.!?\r\n]{0,90}\b(?:incomplete|truncated|partial)\b/i.test(text)) {
      try {
        const ids = retainedAcceptanceIdsFromObjective(text);
        fullySupersedes = Boolean(ids?.length &&
          explicitHumanAcceptanceRequirements(text, ids).size === ids.length);
      } catch { /* Contradictory human lists cannot settle uncertain authority. */ }
    }
    for (const [reference, fragment] of unresolved) {
      if (fullySupersedes ||
          (fragment.text.length >= 32 && text.length > fragment.text.length &&
           text.startsWith(fragment.text))) unresolved.delete(reference);
    }
  }
  return [...unresolved.values()];
}

const REQUIRES_NATIVE_OUTCOME = /\b(?:native|live[- ]?product|installed|real[- ]?app(?:lication)?|real product|production app|user[- ]observed|browser[- ]observed)\b/i;
// A word-match on 'native' is insufficient: an agent can write 'no native
// verification required' and silently waive the actual human finish line.
// Keep the negation specific so 'do not skip native verification' remains a
// positive requirement rather than being mistaken for a waiver.
const WAIVES_NATIVE_OUTCOME = /\b(?:no|without|waiv(?:e|ed|ing))\s+(?:(?:independent|actual|real)\s+)?(?:native|live[- ]?product|installed|real[- ]?app(?:lication)?)\s+(?:verification|validation|evidence|tests?|proof|checks?)\b|\b(?:native|live[- ]?product|installed|real[- ]?app(?:lication)?)\s+(?:verification|validation|evidence|tests?|proof|checks?)\s+(?:is\s+)?(?:not|no longer)\s+(?:required|needed|necessary)\b/i;
// A native screenshot/build result can be genuine without proving the user-
// required Skill was ever opened, understood or applied. Keep this narrow:
// only an *explicit* human requirement to read/use a Skill body triggers the
// additional evidence reference check. No Skill is inferred for other tasks.
const REQUIRES_SKILL_BODY_USE = /\b(?:skill\s+(?:body|instructions?|contract)|selected\s+skill\s+body|applicable\s+skill\s+body)\b/i;
/** Avoid scanning a full session journal for ordinary plans that cannot use
 * execution receipts. The durable evidence reader is needed only when a row's
 * actual acceptance meaning explicitly depends on Core or Skill execution. */
export function acceptanceNeedsRecordedExecutionEvidence(
  items: readonly Pick<AcceptanceEvidenceItem, 'requirement' | 'acceptance'>[] | null | undefined
): boolean {
  return (items ?? []).some(item => {
    const row: AcceptanceEvidenceItem = { ...item, status: 'pending' };
    return (!acceptanceIsTestOnly(row) && requiresReturnedCoreResult(row)) ||
      REQUIRES_SKILL_BODY_USE.test(`${row.requirement ?? ''}\n${row.acceptance ?? ''}`);
  });
}
const SKILL_BODY_READ_EVIDENCE = /\b(?:read|loaded|opened|retrieved)\b[^.!?;\r\n]{0,160}\b(?:skill\s+(?:body|instructions?|file|contract)|skill\.md|skills:\/\/)\b/i;
// A checksum/path comparison can verify the downloaded Skill file without
// demonstrating that its requirements shaped the output. Preserve the
// separate read + application bar even if another native workflow passed.
const SKILL_BODY_APPLIED_EVIDENCE = /\b(?:applied|followed|used)\b[^.!?;\r\n]{0,160}\b(?:skill\s+(?:body|instructions?|constraints?|contract)|design\s+contract)\b/i;
const NEGATED_SKILL_BODY_EVIDENCE = /\b(?:not|never|without|didn't|did not)\b[^.!?;\r\n]{0,35}\b(?:read|loaded|opened|retrieved|applied|followed|used)\b[^.!?;\r\n]{0,65}\bskill\b/i;

/** Explicitly user-authored per-item quality bars, not semantic guesses.
 * A later human correction can revise one description while other original
 * requirements survive. The user's original and corrected source remain
 * available outside the shorter checklist; do not silently truncate an
 * original clause just to fit the agent's free-text field. */
export function acceptanceMeaningConflicts(
  objective: string,
  checklist: readonly NonNullable<AgentPlan['checklist']>[number][],
  originalObjective = objective,
  humanCorrections: readonly string[] = []
): string[] {
  const ids = retainedAcceptanceIdsFromObjective(objective);
  if (!ids) return [];
  const original = explicitHumanAcceptanceRequirements(originalObjective, ids);
  const revised = explicitHumanAcceptanceRequirements(objective, ids);
  for (const [id, meaning] of revised) original.set(id, meaning);
  const explicitlyWaivedNative = new Set<string>();
  // Human additions can amend an existing outcome without restating the
  // original ID list. Apply only explicitly identified real corrections, in
  // recorded order; caller proves authorship before supplying this array.
  for (const correction of humanCorrections) {
    if (!explicitlyCorrectsHumanAcceptance(correction)) continue;
    for (const [id, meaning] of explicitHumanAcceptanceRequirements(correction, ids)) {
      original.set(id, meaning);
      if (WAIVES_NATIVE_OUTCOME.test(correction)) explicitlyWaivedNative.add(id);
      else if (REQUIRES_NATIVE_OUTCOME.test(meaning)) explicitlyWaivedNative.delete(id);
    }
  }
  const problems: string[] = [];
  const originalNativeBar = /\b(?:original finish line|done when|acceptance requires)\b[^\r\n]{0,220}\b(?:real native|native\/product|installed native|live product)\b/i.test(originalObjective);
  const latestNativeBar = [objective, ...humanCorrections].some(message =>
    /\b(?:original finish line|done when|acceptance requires)\b[^\r\n]{0,220}\b(?:real native|native\/product|installed native|live product)\b/i.test(message));
  for (const id of ids) {
    const row = checklist.find(item => item.id === id && item.status !== 'excluded');
    if (!row) continue; // missing and extra IDs are checked separately
    const meaning = original.get(id);
    if (meaning && !normalizedHumanCriterion(row.requirement).includes(normalizedHumanCriterion(meaning))) {
      problems.push(`${id}: restore the explicit original human requirement, not a local milestone`);
      continue;
    }
    // Check the actual observable acceptance text, not just a keyword hidden
    // in the requirement/source or the result of a local unit test.
    if (!explicitlyWaivedNative.has(id) &&
        (REQUIRES_NATIVE_OUTCOME.test(meaning ?? '') || originalNativeBar || latestNativeBar) &&
        (!REQUIRES_NATIVE_OUTCOME.test(row.acceptance) || WAIVES_NATIVE_OUTCOME.test(row.acceptance))) {
      problems.push(`${id}: retain the human native/product acceptance bar; source tests alone cannot replace it`);
    }
    if (row.status === 'verified' && REQUIRES_SKILL_BODY_USE.test(meaning ?? '') &&
        !hasNativeSkillApplicationEvidence(row)) {
      problems.push(`${id}: an installed/native outcome alone is not evidence the selected Skill body was read and its instructions applied; retain actual Skill-body and output evidence`);
    }
  }
  return problems;
}

/** A reversible, read-only view of legacy durable checklists against
 * positively authored human acceptance. The recorded plan remains the audit
 * source; a projected pending item is never a storage migration or evidence
 * that a previously claimed outcome was reverified.
 *
 * Only explicit id:requirement prose is copied. Unavailable/contradictory
 * human meaning stays unresolved rather than being guessed from the agent's
 * weaker historic row. The original denominator always comes from human IDs.
 */
export function canonicalAcceptanceView(
  objective: string, recorded: AgentPlan | null,
  originalObjective = objective, humanCorrections: readonly string[] = [],
  incompleteHumanCorrections: readonly HumanCorrectionFragment[] = [],
  executionEvidence: RecordedExecutionEvidence = {}
): {
  plan: AgentPlan | null;
  ids: string[] | null;
  staleIds: string[];
  missingIds: string[];
  extraIds: string[];
  unresolvedIds: string[];
  issues: string[];
  verified: number;
  total: number | null;
} {
  let ids: string[] | null;
  try {
    ids = retainedAcceptanceIdsFromObjective(objective);
  } catch {
    return { plan: null, ids: null, staleIds: [], missingIds: [], extraIds: [],
      unresolvedIds: [], issues: ['Human acceptance declarations conflict or are incomplete; recover the canonical human task before projecting completion.'],
      verified: 0, total: null };
  }
  if (!ids) {
    if (incompleteHumanCorrections.some(correction => correction.text.trim())) {
      return {
        plan: null, ids: null, staleIds: [], missingIds: [], extraIds: [],
        unresolvedIds: [],
        issues: ['A newer incomplete human correction is not known in full and no authoritative acceptance denominator was recovered; historical checklist evidence cannot establish done=true.'],
        verified: 0, total: null
      };
    }
    return { plan: recorded, ids: null, staleIds: [], missingIds: [], extraIds: [],
      unresolvedIds: [], issues: [], verified: acceptanceCheckpoint(recorded)?.verified ?? 0,
      total: acceptanceCheckpoint(recorded)?.total ?? null };
  }
  const active = (recorded?.checklist ?? []).filter(item => item.status !== 'excluded');
  const byId = new Map(active.map(item => [item.id, item]));
  const meaning = new Map<string, string>();
  try {
    for (const [id, requirement] of explicitHumanAcceptanceRequirements(originalObjective, ids)) meaning.set(id, requirement);
    for (const [id, requirement] of explicitHumanAcceptanceRequirements(objective, ids)) meaning.set(id, requirement);
    for (const correction of humanCorrections) {
      if (!explicitlyCorrectsHumanAcceptance(correction)) continue;
      for (const [id, requirement] of explicitHumanAcceptanceRequirements(correction, ids)) meaning.set(id, requirement);
    }
  } catch {
    return { plan: null, ids, staleIds: [], missingIds: [], extraIds: [],
      unresolvedIds: [...ids], issues: ['Conflicting positively authored item definitions; no acceptance is credited until the human scope is reconciled.'],
      verified: 0, total: ids.length };
  }
  // A positively authored correction can strengthen the original work in
  // ordinary prose without restating an id: requirement field. The absence
  // of a mapped field is NOT evidence that old verification already met the
  // newest human request. Recover full attributable human criteria.
  const unmatchedHumanCorrections: string[] = [];
  for (const correction of humanCorrections) {
    if (!explicitlyCorrectsHumanAcceptance(correction)) continue;
    if (/^\s*(?:current|latest|later|newer)\s+(?:(?:human|user)\s+)?(?:correction|update|follow[- ]?up|instruction)\s*[:\-—]\s*(?:the\s+)?(?:original\s+)?acceptance\s+(?:criteria|requirements|quality\s+bar)\s+(?:remain|stay|are)\s+unchanged\.?\s*$/i.test(correction)) continue;
    let mapped = 0;
    try { mapped = explicitHumanAcceptanceRequirements(correction, ids).size; }
    catch { unmatchedHumanCorrections.push(correction); continue; }
    const explicitSupersession = /\b(?:supersedes?|replaces?)\b[^.!?\r\n]{0,90}\b(?:prior|previous|earlier)\b[^.!?\r\n]{0,90}\b(?:incomplete|truncated|partial|unmapped|unincorporated)\b/i.test(correction);
    if (mapped === ids.length && explicitSupersession) unmatchedHumanCorrections.length = 0;
    else if (mapped === 0) unmatchedHumanCorrections.push(correction);
  }
  let conflicts: string[];
  try {
    conflicts = acceptanceMeaningConflicts(objective, active, originalObjective, humanCorrections);
  } catch {
    return { plan: null, ids, staleIds: [], missingIds: [], extraIds: [],
      unresolvedIds: [...ids], issues: ['Conflicting human requirement or evidence bars; the original denominator remains open.'],
      verified: 0, total: ids.length };
  }
  // A persisted legacy row can still say status=verified after its own
  // references admit no returned native Core result. Keep that original row
  // as audit evidence but do not display its unsupported status as canonical.
  const unsupportedVerificationIds = ids.filter(id => {
    const row = byId.get(id);
    if (row?.status !== 'verified') return false;
    return !doneTrue(row) ||
      (!acceptanceIsTestOnly(row) && requiresReturnedCoreResult(row) &&
        !hasRecordedCoreResultReference(row, executionEvidence)) ||
      (REQUIRES_SKILL_BODY_USE.test(`${row.requirement ?? ''}\n${row.acceptance ?? ''}`) &&
        !hasRecordedSkillApplicationReference(row, executionEvidence));
  });
  // A missing native result invalidates the claimed status, NOT faithful
  // human requirement wording. Legacy migration must not propose rewriting
  // the user's original requirement or acceptance text for an evidence defect.
  const stale = new Set(conflicts.map(issue => issue.slice(0, issue.indexOf(':'))));
  const unsupportedStatuses = new Set(unsupportedVerificationIds);
  const staleIds = ids.filter(id => stale.has(id));
  const missingIds = ids.filter(id => !byId.has(id));
  const extraIds = active.filter(item => !ids!.includes(item.id)).map(item => item.id);
  const unresolvedIds: string[] = [];
  const uncertainty = [
    ...incompleteHumanCorrections.filter(correction => correction.text.trim()),
    ...unmatchedHumanCorrections.map((text, index) => ({
      text, reference: `unincorporated-human-correction:${index + 1}`
    }))
  ];
  const projected: NonNullable<AgentPlan['checklist']> = [];
  for (const id of ids) {
    const row = byId.get(id);
    const exactHuman = meaning.get(id);
    // The durable checklist is agent-authored evidence, not the missing
    // original user's definition. Matching IDs and even a plausible
    // 'verified' native/source row cannot supply an absent human criterion.
    // Keep the historic row in recorded, but never project its status or
    // acceptance wording as canonical when positive human meaning is absent.
    if (!exactHuman || exactHuman.length > 500) {
      unresolvedIds.push(id);
      continue;
    }
    if (uncertainty.length) {
      // Missing tail may add IDs, revoke a waiver, strengthen any item or
      // restore a previously omitted quality bar. Keep fully known old human
      // meaning visible as provisional, but never recycle its verified status.
      unresolvedIds.push(id);
      projected.push({
        id, requirement: exactHuman, acceptance: exactHuman,
        source: 'Prior complete human scope (newer partial correction unresolved; read-only projection)',
        status: 'pending'
      });
      continue;
    }
    if (row && !stale.has(id)) {
      projected.push(unsupportedStatuses.has(id) ? { ...row, status: 'pending' } : { ...row });
      continue;
    }
    // Project human wording as both the requirement and its observable finish
    // condition, instead of inventing unrecorded criteria. A new native result
    // must be observed for the new criterion. Old evidence is kept only in
    // recorded, never copied into this pending projected row.
    projected.push({
      id, requirement: exactHuman, acceptance: exactHuman,
      source: 'Human-authored original/correction (read-only projection; recorded history retained)',
      status: 'pending'
    });
  }
  // Excluded historical records are retained for reference, never revived;
  // previously active *extra* IDs are not silently turned into exclusions.
  projected.push(...(recorded?.checklist ?? []).filter(item => item.status === 'excluded'));
  const view = recorded
    ? { ...recorded, checklist: projected }
    : { plan: [], checklist: projected, updatedAt: 0 };
  return {
    plan: view, ids, staleIds, missingIds, extraIds, unresolvedIds,
    issues: [
      ...conflicts,
      ...unsupportedVerificationIds.filter(id => !conflicts.some(issue => issue.startsWith(`${id}:`)))
        .map(id => `${id}: historical verified label lacks qualifying completed evidence; retain the original result as history, but project this requirement pending`),
      ...(uncertainty.length ? [
        `A newer incomplete human correction or complete human correction not mapped to original per-item criteria remains unresolved (${uncertainty.map(item => item.reference).join(', ')}); retain original acceptance IDs and historical evidence but withhold done=true until actual human scope is recovered.`
      ] : [])
    ],
    verified: projected.filter(item => item.status !== 'excluded' && doneTrue(item)).length,
    total: ids.length
  };
}

/** Human-authoritative progress projection, never a change to durable history.
 * Source-only/installed evidence on a superseded row cannot become done=true
 * by reusing an old ID. Unknown human meaning stays explicitly unresolved. */
export function canonicalAcceptanceSummary(
  objective: string, recorded: AgentPlan | null,
  originalObjective = objective, humanCorrections: readonly string[] = [],
  incompleteHumanCorrections: readonly HumanCorrectionFragment[] = [],
  executionEvidence: RecordedExecutionEvidence = {}
): string | null {
  const view = canonicalAcceptanceView(objective, recorded, originalObjective, humanCorrections,
    incompleteHumanCorrections, executionEvidence);
  if (!view.ids) return view.issues.length ? view.issues.join(' ') : acceptanceSummary(recorded);
  // Preserve the familiar detailed answer and exact MCP contract for already
  // faithful plans. Reconciliation is for *drifted or incomplete* historical
  // records; do not change the legitimate normal workflow's output format.
  if (recorded && !view.staleIds.length && !view.missingIds.length &&
      !view.extraIds.length && !view.unresolvedIds.length && !view.issues.length)
    return acceptanceSummary(recorded);
  const header = `Agent-reported done=true: ${view.verified} / ${view.total} original active requirements; done=false: ${view.total! - view.verified}. Read-only human-acceptance reconciliation; not independently verified product completion.`;
  const issues = [
    ...(view.staleIds.length ? [`Semantically superseded legacy IDs (old evidence is historical, not verification of newer criteria): ${view.staleIds.join(', ')}.`] : []),
    ...(view.missingIds.length ? [`Original IDs absent from recorded checklist: ${view.missingIds.join(', ')}.`] : []),
    ...(view.extraIds.length ? [`Additional recorded active IDs outside original human denominator: ${view.extraIds.join(', ')}.`] : []),
    ...(view.unresolvedIds.length ? [`Unresolved human requirement wording: ${view.unresolvedIds.join(', ')}. Recover direct human scope, do not infer requirements from assistant history.`] : []),
    ...view.issues
  ];
  const rows = view.plan?.checklist?.filter(item => item.status !== 'excluded').map(item =>
    `${item.id}: ${item.requirement} [${item.status}; ${doneTrue(item) ? 'agent-reported verified' : 'done=false'}]`) ?? [];
  return [header, ...issues, ...rows,
    'The stored checklist and all historical evidence remain untouched. A working plan-step update does not approve or persist any projected replacement requirement.'].join('\n');
}

/** An owner-readable recovery proposal, NOT a command, saved schema or grant of
 * migration authority. The caller supplies positively verified human record
 * references. Never trust references embedded in a generated prompt itself.
 *
 * Every historic field is retained in `recorded`. Only the exact human
 * requirement can be proposed automatically for *review*, not as an approved
 * replacement. Source, acceptance wording and fresh verification cannot be
 * reconstructed safely from an assistant checklist, so remain unresolved.
 * No file writes, clocks, generated IDs, network, or stateful caches. */
export type AcceptancePreviewProvenance = {
  kind: 'saved-human-goal' | 'human-correction' | 'effective-human-scope' | 'recorded-plan' | 'reconciliation-rule' | 'unknown';
  reference?: string;
};
export type AcceptancePreviewField<T> = {
  before: T | null;
  proposed: T | null;
  provenance: AcceptancePreviewProvenance;
  decision: 'retain' | 'requires-review' | 'unresolved';
};
export type AcceptanceMigrationPreview = {
  schemaVersion: 1;
  action: 'preview-only';
  applyAuthorized: false;
  decision: 'no-change' | 'requires-human-review' | 'blocked';
  recordedUpdatedAt: number | null;
  /** SHA-256 of JSON.stringify(the parsed stored plan), not disk-file bytes.
   * An authorized future writer must reread/recompare the same plan and prove
   * its own durable transaction authority; this digest authorizes nothing. */
  recordedSnapshotSha256: string | null;
  historyCoverage: 'complete' | 'partial' | 'not-audited';
  historyInspected: number | null;
  originalIds: string[] | null;
  verified: number;
  total: number | null;
  issues: string[];
  items: Array<{
    id: string;
    disposition: 'retain' | 'requires-human-review' | 'blocked';
    recorded: NonNullable<AgentPlan['checklist']>[number] | null;
    fields: {
      requirement: AcceptancePreviewField<string>;
      source: AcceptancePreviewField<string>;
      acceptance: AcceptancePreviewField<string>;
      status: AcceptancePreviewField<NonNullable<AgentPlan['checklist']>[number]['status']>;
      evidence: AcceptancePreviewField<string[]> & { disposition: 'unchanged' | 'historical-only' };
    };
  }>;
  historicalExcluded: NonNullable<AgentPlan['checklist']>;
  extraRecordedIds: string[];
};

export function previewAcceptanceMigration(input: {
  objective: string;
  originalObjective: string;
  originalReference: string;
  recorded: AgentPlan | null;
  corrections: readonly { text: string; reference: string }[];
  objectiveReference?: string;
  recordedSnapshotSha256?: string;
  historyCoverage?: 'complete' | 'partial';
  historyIssue?: string | null;
  historyInspected?: number;
  incompleteHumanCorrections?: readonly HumanCorrectionFragment[];
  executionEvidence?: RecordedExecutionEvidence;
}): AcceptanceMigrationPreview {
  const { objective, originalObjective, originalReference, recorded, corrections } = input;
  const originalText = originalObjective || objective;
  const originalSource: AcceptancePreviewProvenance = {
    kind: 'saved-human-goal', reference: originalReference
  };
  const fromPlan: AcceptancePreviewProvenance = { kind: 'recorded-plan',
    ...(recorded ? { reference: `updatedAt:${recorded.updatedAt}` } : {}) };
  const unknown: AcceptancePreviewProvenance = { kind: 'unknown' };
  const rule: AcceptancePreviewProvenance = { kind: 'reconciliation-rule', reference: 'new-observation-required' };
  const issues: string[] = [];
  if (input.historyCoverage === 'partial') issues.push(
    input.historyIssue ?? 'The complete human history is unavailable; no migration may be approved.');
  let ids: string[] | null = null;
  let contradictsHumanIds = false;
  try {
    ids = retainedAcceptanceIdsFromObjective(objective);
  } catch {
    contradictsHumanIds = true;
    issues.push('Current human acceptance IDs conflict or are incomplete; preserve the original as provisional and obtain a human correction.');
    try { ids = retainedAcceptanceIdsFromObjective(originalText); } catch { /* no trustworthy denominator */ }
  }
  if (!ids) {
    try { ids = retainedAcceptanceIdsFromObjective(originalText); } catch {
      issues.push('Original acceptance IDs are contradictory; no migration can be proposed.');
    }
  }
  const historicalExcluded = (recorded?.checklist ?? [])
    .filter(row => row.status === 'excluded').map(row => ({
      ...row, ...(row.evidence ? { evidence: [...row.evidence] } : {})
    }));
  const active = (recorded?.checklist ?? []).filter(row => row.status !== 'excluded');
  const byId = new Map(active.map(row => [row.id, row]));
  const extraRecordedIds = active.filter(row => !ids?.includes(row.id)).map(row => row.id);
  if (extraRecordedIds.length) issues.push(`Extra recorded active IDs outside human denominator: ${extraRecordedIds.join(', ')}.`);
  const definitions = new Map<string, { value: string; provenance: AcceptancePreviewProvenance }>();
  const inconsistent = new Set<string>();
  const sourceCandidates = [
    { text: originalText, provenance: originalSource },
    ...(objective !== originalText ? [{
      text: objective, provenance: { kind: 'effective-human-scope' as const,
        reference: input.objectiveReference ?? originalReference }
    }] : []),
    ...corrections.filter(correction => explicitlyCorrectsHumanAcceptance(correction.text))
      .map(correction => ({
        text: correction.text, provenance: {
          kind: 'human-correction' as const, reference: correction.reference
        }
      }))
  ];
  for (const source of sourceCandidates) {
    if (!ids?.length) break;
    try {
      for (const [id, value] of explicitHumanAcceptanceRequirements(source.text, ids)) {
        definitions.set(id, { value, provenance: source.provenance });
      }
    } catch (error) {
      const id = /Original human acceptance ([A-Za-z0-9_-]+)/.exec(String(error))?.[1];
      if (id) inconsistent.add(id);
      else ids.forEach(value => inconsistent.add(value));
      issues.push(`Conflicting per-item human descriptions in ${source.provenance.reference ?? source.provenance.kind}; recover the complete authoritative requirement.`);
    }
  }
  const correctedTexts = corrections.filter(c => explicitlyCorrectsHumanAcceptance(c.text)).map(c => c.text);
  const projection = canonicalAcceptanceView(objective, recorded, originalText, correctedTexts,
    input.incompleteHumanCorrections, input.executionEvidence);
  const stale = new Set(projection.staleIds);
  if (projection.issues.length) issues.push(...projection.issues);
  const items: AcceptanceMigrationPreview['items'] = [];
  let verified = 0;
  for (const id of ids ?? []) {
    const old = byId.get(id);
    const recordedRow = old ? { ...old, ...(old.evidence ? { evidence: [...old.evidence] } : {}) } : null;
    const exact = definitions.get(id);
    const blocked = contradictsHumanIds || inconsistent.has(id) || !exact ||
      exact.value.length > 500 || projection.unresolvedIds.includes(id);
    const semanticDrift = !blocked && (!old || stale.has(id) ||
      !normalizedHumanCriterion(old.requirement).includes(normalizedHumanCriterion(exact.value)));
    // A faithful legacy description with status=verified may still rely only
    // on a source test. It is not a 'no-change' migration just because the
    // reporting layer already computes done=false; review the unsupported
    // status and preserve the old evidence as historical-only.
    const unsupportedVerification = !blocked && old?.status === 'verified' && !doneTrue(old);
    const drifted = semanticDrift || unsupportedVerification;
    const disposition: AcceptanceMigrationPreview['items'][number]['disposition'] =
      blocked ? 'blocked' : drifted ? 'requires-human-review' : 'retain';
    if (blocked) issues.push(`${id}: exact original/revised human requirement unavailable or contradictory; no migration proposal.`);
    if (unsupportedVerification) issues.push(`${id}: historical verified label lacks qualifying evidence for the human acceptance; review status as pending and keep original evidence historical-only.`);
    if (!drifted && !blocked && old && doneTrue(old)) verified++;
    const retainedField = <T>(before: T | null, provenance = fromPlan): AcceptancePreviewField<T> => ({
      before, proposed: before, provenance, decision: 'retain'
    });
    items.push({
      id, disposition, recorded: recordedRow,
      fields: {
        requirement: blocked ? { before: old?.requirement ?? null, proposed: null,
          provenance: unknown, decision: 'unresolved' }
          : semanticDrift ? { before: old?.requirement ?? null, proposed: exact.value,
            provenance: exact.provenance, decision: 'requires-review' }
            : retainedField(old!.requirement, exact.provenance),
        source: blocked || semanticDrift ? { before: old?.source ?? null, proposed: null,
          provenance: blocked ? unknown : exact!.provenance, decision: 'unresolved' }
          : retainedField(old!.source),
        acceptance: blocked || semanticDrift ? { before: old?.acceptance ?? null, proposed: null,
          provenance: blocked ? unknown : exact!.provenance, decision: 'requires-review' }
          : retainedField(old!.acceptance),
        status: blocked ? { before: old?.status ?? null, proposed: null,
          provenance: unknown, decision: 'unresolved' }
          : drifted ? { before: old?.status ?? null, proposed: 'pending',
            provenance: rule, decision: 'requires-review' }
            : retainedField(old!.status),
        evidence: blocked || drifted ? {
          before: old?.evidence ? [...old.evidence] : [], proposed: [], provenance: rule,
          decision: 'requires-review', disposition: 'historical-only'
        } : { ...retainedField(old?.evidence ? [...old.evidence] : []),
          disposition: 'unchanged' }
      }
    });
  }
  if (!ids) issues.push('Human acceptance denominator unavailable; recover an attributable original before review.');
  const decision: AcceptanceMigrationPreview['decision'] =
    input.historyCoverage === 'partial' || contradictsHumanIds || !ids ||
      inconsistent.size > 0 || items.some(item => item.disposition === 'blocked') ||
      extraRecordedIds.length ? 'blocked'
      : items.some(item => item.disposition === 'requires-human-review') ? 'requires-human-review' : 'no-change';
  return {
    schemaVersion: 1, action: 'preview-only', applyAuthorized: false,
    decision, recordedUpdatedAt: recorded?.updatedAt ?? null,
    recordedSnapshotSha256: input.recordedSnapshotSha256 ?? null,
    historyCoverage: input.historyCoverage ?? 'not-audited',
    historyInspected: input.historyInspected ?? null,
    originalIds: ids ? [...ids] : null, verified: decision === 'blocked' ? 0 : verified,
    total: ids?.length ?? null, issues, items, historicalExcluded, extraRecordedIds
  };
}

/** Keep explicit original human acceptance before *the first* agent checklist
 * as well as after saved plans and Compact & Resume. A plan step is not a
 * substitute for any retained ID. Preserve excluded historical rows separately.
 * This must run for each proven MCP update, not merely on the initial read. */
export function requireRetainedAcceptance(
  savedObjective: string, previous: AgentPlan | null, update: AgentPlanUpdate,
  originalObjective = savedObjective, humanCorrections: readonly string[] = [],
  incompleteHumanCorrections: readonly HumanCorrectionFragment[] = [],
  executionEvidence: RecordedExecutionEvidence = {}
): void {
  const ids = retainedAcceptanceIdsFromObjective(savedObjective);
  if (!ids) {
    if (incompleteHumanCorrections.some(correction => correction.text.trim()) &&
        update.checklist?.length) {
      throw new Error('Incomplete human correction and missing original acceptance denominator: recover attributable full human scope before changing checklist or claiming verified acceptance. No plan was saved.');
    }
    return;
  }
  const proposed = preserveAcceptance(previous, update);
  const active = (proposed.checklist ?? []).filter(item => item.status !== 'excluded').map(item => item.id);
  const missing = ids.filter(id => !active.includes(id));
  const extra = active.filter(id => !ids.includes(id));
  if (missing.length || extra.length) {
    throw new Error(`Saved human Goal objective retains exactly these active acceptance IDs: ${ids.join(', ')}. Missing: ${missing.join(', ') || 'none'}; additional: ${extra.join(', ') || 'none'}. Keep local work steps in plan, historical removed items excluded, and genuine later human scope changes in the authoritative objective. No plan was saved.`);
  }
  const weaker = acceptanceMeaningConflicts(savedObjective, proposed.checklist ?? [], originalObjective, humanCorrections);
  if (weaker.length) {
    throw new Error(`Original human acceptance requirements and evidence threshold cannot be weakened with unchanged IDs: ${weaker.join('; ')}. Copy the complete human requirements into checklist requirement and retain native/product acceptance where requested. Working implementation milestones belong in plan steps. No plan was saved.`);
  }
  // While a positively authored message is only a fragment, even a pending
  // *first* checklist would silently presume that the old ID list and finish
  // bar survived its missing tail. Existing acceptance rows remain immutable
  // and ordinary checklist-omitted working-step updates may continue.
  if (!previous?.checklist?.length && incompleteHumanCorrections.some(item => item.text.trim())) {
    throw new Error('A newer incomplete human correction may change the original acceptance denominator or quality bar. Recover the full human instruction before creating the first checklist. No plan was saved.');
  }
  // A genuine human may explicitly require *only* passing source tests.
  // Preserve that case. But an agent cannot create a first verified test-only
  // checklist by copying the original ID list while inventing every missing
  // per-item human requirement and finish line. Omitted checklist rows on a
  // later plan-step update are still retained as historical records; its
  // read-only progress summary must report the unknown original meaning.
  if (update.checklist?.some(item => item.status === 'verified')) {
    const view = canonicalAcceptanceView(savedObjective, {
      plan: proposed.plan, checklist: proposed.checklist, updatedAt: 0
    }, originalObjective, humanCorrections, incompleteHumanCorrections, executionEvidence);
    const invented = update.checklist.filter(item =>
      item.status === 'verified' && view.unresolvedIds.includes(item.id));
    if (invented.length) {
      throw new Error(`Exact human requirement/acceptance wording is unresolved for ${invented.map(item => item.id).join(', ')}. A matching checklist ID or agent-reported source test is not authorization to mark original acceptance verified. Recover the genuine human criteria before claiming done=true. No plan was saved.`);
    }
    const unprovedExecution = update.checklist.filter(item => item.status === 'verified' &&
      ((!acceptanceIsTestOnly(item) && requiresReturnedCoreResult(item) &&
        !hasRecordedCoreResultReference(item, executionEvidence)) ||
       (REQUIRES_SKILL_BODY_USE.test(`${item.requirement ?? ''}\n${item.acceptance ?? ''}`) &&
        !hasRecordedSkillApplicationReference(item, executionEvidence))));
    if (unprovedExecution.length) {
      throw new Error(`Verified acceptance requires an exact recorded execution receipt bound to this task version: ${unprovedExecution.map(item => item.id).join(', ')}. Match the real Core call/result or confirmed Skill-bearing native input and its linked final output; text-only receipts are not proof. No plan was saved.`);
    }
  }
}

function retainedAcceptanceItem(item: NonNullable<AgentPlan['checklist']>[number]): NonNullable<AgentPlanUpdate['checklist']>[number] {
  if (item.status === 'verified' && !doneTrue(item)) return { ...item, status: 'implemented' };
  return item;
}

/** Retain original requirements even when a helper sends only a new working plan. */
export function preserveAcceptance(previous: AgentPlan | null, update: AgentPlanUpdate): AgentPlanUpdate {
  if (!previous?.checklist?.length) return update;
  const incoming = new Map((update.checklist ?? []).map(item => [item.id, item]));
  const checklist = previous.checklist.map(old => {
    const next = incoming.get(old.id);
    incoming.delete(old.id);
    if (!next) return retainedAcceptanceItem(old);
    if (next.requirement !== old.requirement || next.source !== old.source || next.acceptance !== old.acceptance) {
      throw new Error(`Checklist ${old.id}: preserve its original requirement, source and acceptance; record a user-authorized scope change as an exclusion and a new item.`);
    }
    // Excluded rows are historical human scope-change evidence, outside the
    // active denominator. A generated continuation must not revive a local
    // milestone by reusing its ID or silently rewrite why it was excluded.
    // A genuinely renewed human requirement gets a separate new ID/source;
    // the old exclusion remains auditable across Resume and later plans.
    if (old.status === 'excluded' && (next.status !== 'excluded' || next.scopeChange !== old.scopeChange)) {
      throw new Error(`Checklist ${old.id}: preserve the excluded historical scope-change record; a newly authorized requirement needs a new ID and human source.`);
    }
    return next;
  });
  checklist.push(...incoming.values());
  return agentPlanUpdateSchema.parse({ ...update, checklist });
}

function evidenceClassCounts(items: ReadonlyArray<AcceptanceEvidenceItem>): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = evidenceClass(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${key}=${count}`).join(', ');
}

function activeAcceptanceItems<T extends AcceptanceEvidenceItem>(items: readonly T[]): T[] {
  return items.filter(item => item.status !== 'excluded');
}

function excludedAcceptanceItems<T extends AcceptanceEvidenceItem>(items: readonly T[]): T[] {
  return items.filter(item => item.status === 'excluded');
}

export function acceptanceCheckpoint(plan: AgentPlan | null): { verified: number; total: number; next: NonNullable<AgentPlan['checklist']>[number] | null; excluded: number } | null {
  const items = plan?.checklist;
  if (!items?.length) return null;
  const active = activeAcceptanceItems(items);
  // Old saved plans may have status=verified with weak, failed or label-only
  // evidence. The count already excludes them; keep one actionable in Loop too.
  const next = active.find(item => item.status === 'implemented') ?? active.find(item => item.status === 'pending') ??
    active.find(item => item.status === 'verified' && !doneTrue(item)) ?? active.find(item => item.status === 'blocked') ?? null;
  return {
    verified: active.filter(doneTrue).length,
    total: active.length,
    next: next?.status === 'verified' && !doneTrue(next) ? { ...next, status: 'implemented' } : next,
    excluded: excludedAcceptanceItems(items).length,
  };
}

/** Compact status projection for renderer/status surfaces. It must not imply completion from plan steps alone. */
export function acceptanceStatusSummary(plan: AgentPlan | null): string | null {
  const items = plan?.checklist;
  if (!items?.length) return null;
  const active = activeAcceptanceItems(items);
  const excluded = excludedAcceptanceItems(items);
  const verified = active.filter(doneTrue).length;
  const doneFalse = active.length - verified;
  return `Agent-reported done=true: ${verified} / ${active.length} active recorded requirements; done=false: ${doneFalse}; evidence classes: ${evidenceClassCounts(active)}. ${excluded.length} excluded historical/scope-change item(s) retained separately, outside the active denominator. Source tests, install receipts, worker reports, queues, ambiguous sends, provider restrictions and unknown denominators are not completion proof.`;
}

/** Shared text projection for Progress and Loop. No invented percentage or executable links. */
export function acceptanceSummary(plan: AgentPlan | null): string | null {
  const items = plan?.checklist;
  if (!items?.length) return null;
  const active = activeAcceptanceItems(items);
  const excluded = excludedAcceptanceItems(items);
  const verified = active.filter(doneTrue).length;
  const doneFalse = active.length - verified;
  return [
    `Agent-reported done=true: ${verified} / ${active.length} active recorded requirements; done=false: ${doneFalse}. ${excluded.length} excluded historical/scope-change item(s) retained separately, outside the active denominator. This is not independently verified completion or proof that every user request was captured.`,
    ...active.map(item => [
      `${item.id} [${item.status}; done=${doneTrue(item) ? 'true' : 'false'}; evidence=${evidenceClass(item)}]: ${item.requirement}`,
      `Source: ${item.source}`,
      `Acceptance: ${item.acceptance}`,
      ...(item.evidence ?? []).map(ref => `Evidence: ${ref}`),
      ...(item.status === 'blocked' ? [`Blocker: ${item.blocker}`, `Next experiment / resume condition: ${item.nextExperiment}`] : [])
    ].join('\n')),
    ...excluded.map(item => [
      `Excluded historical/scope-change item ${item.id} [excluded; done=false; evidence=user-excluded]: ${item.requirement}`,
      `Source: ${item.source}`,
      `Acceptance: ${item.acceptance}`,
      `Scope change: ${item.scopeChange}`
    ].join('\n'))
  ].join('\n\n');
}

/** UTF-8, including JSON escapes and the server timestamp; also the bounded disk-read size. */
export const MAX_AGENT_PLAN_BYTES = 96 * 1024;

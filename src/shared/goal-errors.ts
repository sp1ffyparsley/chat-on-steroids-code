/** Fixed diagnostic vocabulary only: never persist provider prose, draft text or URLs here. */
/** Positive provider `conversation_deleted` evidence only; generic load errors are recoverable. */
export const CONVERSATION_DELETED = 'This chat was deleted in ChatGPT. Start a new chat to continue.';
/** Exact incumbent browser refusal; never match authored prompt text or generic errors. */
export const NATIVE_PROMPT_ENVELOPE_REFUSAL = 'Required prompt header/footer validation failed before Send. Check the companion status and repair the prepared input before retrying.';


/** Existing two-field helper envelope: this value is a hold, never executor text or STOP. */
export const GOAL_EXTERNAL_HOLD_REPLY = '[[COS_EXTERNAL_HOLD]]';
type AutomaticDecisionHoldCode = 'goal_external_hold' | 'goal_generated_authority_claim';
export function isAutomaticDecisionHoldCode(value: unknown): value is AutomaticDecisionHoldCode {
  return value === 'goal_external_hold' || value === 'goal_generated_authority_claim';
}
/** Exact control value and bounded opening claims only; this is not a permission grant detector. */
export function automaticDecisionHold(reply: string): AutomaticDecisionHoldCode | null {
  if (reply.startsWith(GOAL_EXTERNAL_HOLD_REPLY)) return 'goal_external_hold';
  const opening = reply.replace(/^(?:#{1,6}\s+)?(?:\*\*|__)?/u, '');
  return /^(?:I|we)\s+(?:hereby\s+)?(?:authori[sz]e|approve|grant|consent|give permission)\b/iu.test(opening)
    ? 'goal_generated_authority_claim' : null;
}

const helperFailureExplanations = {
  transport_unclaimed: 'The browser did not claim the queued helper before its delivery deadline. This is a companion delivery failure, not an empty model answer; no Send was authorized for that attempt.',
  model_reasoning_unconfirmed: 'The requested helper model or reasoning could not be confirmed before Send. Check this account\'s Goal, Loop and Plan model/reasoning settings; changing the root chat picker does not change the helper preference.',
  core_attachment_unconfirmed: 'The required Core app could not be confirmed before Send. Check the exact Core connection in the helper chat.',
  send_failed: 'The helper prompt failed before confirmed delivery. Check its saved delivery diagnostics and native composer.',
  unusable_response: 'The helper response was empty or could not be parsed as a continuation.',
  loop_stop_refused: 'The helper returned a stopping decision while this chat requires a Loop continuation. Its prompt was delivered; no continuation was invented.',
  unresolved_content_reference: 'ChatGPT returned an internal content reference instead of readable helper instructions. This is an answer-reading failure, not a shortage of helper tabs.',
  ledger_unsaved: 'CoS could not save its continuation record. Check free disk space and app diagnostics; the saved task and delivery records remain the source of truth.',
  request_failed: 'The helper request failed; consult the existing delivery and provider diagnostics for the cause.'
} as const;

export type GoalHelperFailureCause = keyof typeof helperFailureExplanations;

export function isGoalHelperFailureCause(value: unknown): value is GoalHelperFailureCause {
  return typeof value === 'string' && Object.hasOwn(helperFailureExplanations, value);
}

export function goalHelperFailureCause(error: string): GoalHelperFailureCause {
  let raw = error.trim();
  for (let depth = 0; depth < 4 && raw.startsWith('request_failed:'); depth += 1) {
    raw = raw.slice('request_failed:'.length).trim();
  }
  if (raw.startsWith('goal_browser_send_failed:')) {
    const reason = raw.slice('goal_browser_send_failed:'.length).trim();
    if (/^Requested model or reasoning could not be confirmed(?:$|\.)/.test(reason)) return 'model_reasoning_unconfirmed';
    if (reason.startsWith('ChatGPT did not expose the installed Core app.')) return 'core_attachment_unconfirmed';
    return 'send_failed';
  }
  if (raw === 'goal_browser_send_failed') return 'send_failed';
  if (/^goal_browser_queued_unclaimed_(?:timeout|transport)$/.test(raw)) return 'transport_unclaimed';
  if (raw === 'goal_content_reference_unresolved') return 'unresolved_content_reference';
  if (raw === 'loop_stop_refused') return 'loop_stop_refused';
  if (/^(?:invalid_goal_decision_(?:json|schema)|malformed_(?:completion_response|stream_record)|empty_reply|control_tokens_only|unsafe_control_tokens)(?:$|:)/.test(raw)) return 'unusable_response';
  if (/^goal_[a-z0-9_]*not_durable$/.test(raw)) return 'ledger_unsaved';
  return 'request_failed';
}

/** Presentation only. Keep machine errors and retry/ownership decisions unchanged. */
const explanations: Readonly<Record<string, string>> = {
  goal_external_hold: 'Automatic continuation is waiting for an external approval or retention decision. The task remains open; no new message was sent and no permission was granted. Review the saved final and resume only after the prerequisite is resolved.',
  goal_generated_authority_claim: 'An automatic helper claimed to authorize or approve an action. Helper text cannot grant human permission. Its answer and delivery receipt are saved; no continuation was sent and the original task remains open.',
  goal_browser_prompt_envelope_invalid: 'The companion refused the required helper prompt header/footer before Send was authorized. The exact prepared input and saved reply remain retained. Verify or reload the current companion and repair its envelope contract, then deliberately retry this same obligation; automatic replacement helpers are paused.',
  goal_human_history_incomplete: 'Part of the original request or later human changes is missing, incomplete or unverified. The saved task is retained. Recover the original request and changes before resuming this Goal; completion cannot be judged from a summary alone.',
  goal_native_delivery_scope_mismatch: 'A confirmed native message differs from its retained prepared payload or authored request. Scope verification stopped before a helper was requested; its retry budget was not spent. Keep the native message and prepared evidence for reconciliation.',
  goal_canonical_scope_unverified: 'The retained original task could not be verified against its canonical source. Scope verification stopped before a helper was requested; its retry budget was not spent. Restore the exact source evidence before resuming.',
  goal_content_reference_unresolved: 'ChatGPT returned an internal content reference that could not be resolved into a public helper answer. The saved task is retained; a Goal cannot infer completion from this response.',
  loop_mcp_call_missing: 'No MCP tool call was recorded in the last response, so the app cannot tell whether the tool connection was lost. Loop remains enabled; the app will check Core again in one minute and continue this exact turn only after the connector is healthy.',
  loop_mcp_recovery_needs_attention: 'Core did not recover during the bounded automatic retry window. The exact Loop reply is still saved. Verify or reconnect Core, then use Resume all to continue this same chat without creating another worker or resending the old prompt.',
  goal_reply_not_pending: 'There is no pending continuation for this answer. It may already have been handled or replaced by newer work. Check the latest chat activity before trying again.',
  goal_context_too_large: 'The assembled Goal/Loop helper context exceeds its available size budget. The saved task is retained. Check the component sizes in app diagnostics to identify oversized instructions or reference context before retrying; this does not mean the original task must be shortened.',
  reply_too_long: 'The helper wrote a continuation that is too long to send. Ask for shorter continuation instructions or choose another helper model in Settings.',
  stream_record_too_long: 'The provider returned an oversized response. Choose another continuation model or ask for shorter replies.',
  response_body_too_large: 'The provider response exceeded the size limit. Choose another continuation model or ask for shorter replies.',
  no_api_key: 'No API key is configured for the continuation provider. Add one in Settings, or select the ChatGPT continuation source.',
  auth_rejected: 'The continuation provider rejected the API credentials. Check its API key and access permissions in Settings.',
  out_of_credit: 'The continuation provider account has no credit available. Add credit or choose another continuation source in Settings.',
  unknown_model: 'The continuation provider could not find the selected model. Refresh its model list and choose an available model in Settings.',
  invalid_provider: 'The custom continuation endpoint is invalid. Check its URL in Settings; use HTTPS or a local HTTP endpoint.',
  rate_limited: 'The continuation provider is rate-limiting requests. Wait for the displayed retry, or choose another continuation model.',
  timeout_or_cancelled: 'The continuation request timed out or was cancelled. Check the helper chat or provider status before trying again.',
  request_failed: 'The continuation request failed. Check the selected helper or API endpoint and the app diagnostics before trying again.',
  goal_browser_busy: 'A helper request is already pending. Let it finish or cancel that request before starting another.',
  goal_readiness_changed: 'Loop readiness changed while preparing the continuation. The saved reply is retained; no new helper was sent. It will retry after current work and delivery holds clear.',
  goal_browser_rate_limited: 'ChatGPT temporarily limited helper requests. The app is waiting before it creates another helper.',
  goal_browser_cancelled: 'The helper request was cancelled. Start it again when you want to continue.',
  goal_browser_signed_out: 'ChatGPT is signed out. Unsent helper preparation is paused without spending retry attempts. Exact replies and existing native Send receipts are retained. Sign back into this account, then resume its saved work.',
  goal_browser_automation_paused: 'Automation is paused for this account. Confirmed-unsent helper preparation is held without spending retry attempts. The exact reply and native Send receipts remain saved. Resolve the account hold, then resume its saved work.',
  goal_browser_queued_unclaimed_timeout: 'The helper request timed out while still queued and unclaimed. Its durable input is confirmed unsent before browser delivery, so retrying this exact turn does not risk duplicating a ChatGPT message.',
  goal_browser_send_failed: 'The helper prompt could not be delivered to ChatGPT. Open the helper chat and check its composer or visible error before trying again.',
  goal_browser_send_unconfirmed: 'The app could not confirm whether ChatGPT received the helper prompt. Check the helper chat before retrying to avoid sending it twice.',
  goal_browser_delivered_helper_unresolved: 'Native delivery of the retained helper is confirmed, but its answer collection was cancelled before its result or continuation was reconciled. The original receipt and saved work remain retained. Automatic replacement is paused; inspect that exact helper and source turn before authorizing another decision.',
  goal_browser_answer_expired: 'ChatGPT accepted the helper prompt, but its answer was not collected before the bounded deadline. The original native delivery receipt remains saved. Check that exact helper result before explicitly restarting; automatic replacement is paused to prevent duplicate work.',
  goal_browser_answer_custody_unconfirmed: 'The original helper answer was recorded for this exact Goal/Loop turn, but its continuation is not confirmed. Its native receipt remains saved; private helper text is not recovered from disk. Automatic replacement is paused; inspect the source turn and any saved continuation delivery before explicitly authorizing another decision.',
  goal_browser_continuation_delivery_attention: 'The saved continuation already has its own saved delivery record, but delivery needs attention. A confirmed failure before Send retains the same delivery and text; check its recorded preparation error, then explicitly Resume this chat for one bounded retry. Cancelled, ambiguous or conflicting deliveries remain paused for review.',
  goal_browser_helper_exhausted: 'Three helper attempts failed for this exact turn. A failure may occur before Send (for example, an unavailable model or reasoning choice), or while reading the answer. Automatic helper creation is paused to prevent repeated tabs. Check the latest helper delivery error and the account\'s Goal, Loop and Plan model/reasoning settings, then use Restart helper or Resume this chat for one fresh bounded attempt.',
  goal_owned_elsewhere: 'Another browser tab is handling this continuation. Check that tab for progress.',
  goal_final_not_confirmed: 'The app has not confirmed a final answer eligible for automatic continuation. Check the source chat for ongoing work or an error.',
  native_completion_unverified: 'CoS cannot yet match every native tool call to its completed result. The saved continuation has not been sent. Missing exact completion evidence must be reconciled before automatic continuation; a retry countdown is not proof of progress.',
  astra_finish_only: 'This chat continues through the finish tool. A final browser answer does not trigger another message with the current setting.',
  goal_disabled: 'Goal/Loop is off for this chat. Turn it on to allow continuation.',
  goal_worker_chat: 'Workers cannot run their own Goal/Loop. Enable continuation in the parent chat instead.',
  conversation_superseded: 'This chat was replaced by Compact & Resume. Continue in its successor chat.',
  chat_blocked: 'This chat is blocked in the app. Unblock it there before enabling continuation.',
  session_not_recorded: 'The app has no recorded history for this chat. Enable recording and send a message before using automatic continuation.',
  no_conversation: 'No recorded conversation is available to continue. Send a task first.',
  no_objective: 'No task was provided. Enter a task before starting Goal/Loop.',
  nothing_to_open_with: 'The helper did not produce an opening message. Make the task more specific and try again.',
  loop_stop_refused: 'The helper returned a stopping decision instead of a Loop continuation. Its native prompt receipt is retained. CoS will retry through the existing bounded helper-attempt budget; no continuation was invented.',
  goal_marker_missing: 'The answer is missing the completion marker required by offline Goal templates. Check the template instructions or choose another continuation source.',
  goal_reply_not_durable: 'The app could not save the pending continuation. Check free disk space and the app diagnostics.',
  goal_ack_not_durable: 'The app could not save the delivery confirmation. Check free disk space; check the chat before manually resending.',
  goal_switch_not_durable: 'The app could not save the Goal/Loop setting. Check free disk space and try saving it again.',
  goal_objective_not_durable: 'The app could not save the task. Check free disk space and try saving it again.',
  goal_stop_disposition_not_durable: 'CoS could not save the helper decision to the Goal ledger. Check free disk space and app diagnostics; retain the exact task, reply and delivery evidence while storage is repaired.',
  goal_source_changed: 'The source evidence changed while the continuation was being prepared. Automatic continuation is held; the saved task remains retained for reconciliation.',
  goal_original_acceptance_unverified: 'The helper proposed stopping, but the original task acceptance could not be verified. The saved task remains open until its original requirements have supporting evidence.',
  goal_canonical_scope_changed: 'The canonical source of the retained task changed. Scope verification held automatic continuation; verify the original request and current canonical source before resuming.',
  goal_human_history_changed: 'Recorded human changes arrived while this decision was being prepared. The saved task is retained; reconcile the latest instructions before authorizing a continuation.'
};

export function goalErrorMessage(error: string, helperFailureCause?: GoalHelperFailureCause): string {
  let raw = error.trim();
  let wrapped = false;
  // Opening, finish and planner requests wrap transport failures. Unwrap only
  // that known envelope, with a bound; machine codes and retry policy stay intact.
  for (let depth = 0; depth < 4 && raw.startsWith('request_failed:'); depth += 1) {
    raw = raw.slice('request_failed:'.length).trim();
    wrapped = true;
  }
  const code = raw.split(':', 1)[0]!;
  if (code === 'goal_browser_helper_exhausted' && isGoalHelperFailureCause(helperFailureCause)) {
    return `Three helper attempts failed for this exact turn. ${helperFailureExplanations[helperFailureCause]} The exact Loop reply remains saved. Automatic helper creation is paused to prevent repeated tabs. After resolving the cause, use Restart helper or Resume this chat for one fresh bounded attempt.`;
  }
  if (code === 'goal_browser_send_failed' && raw.includes(':')) {
    return `The helper prompt could not be delivered. ${raw.slice(raw.indexOf(':') + 1).trim().slice(0, 200)}`;
  }
  if (Object.hasOwn(explanations, code)) return explanations[code]!;
  if (/^(?:invalid_goal_decision_(?:json|schema)|malformed_(?:completion_response|stream_record)|empty_reply|control_tokens_only|unsafe_control_tokens)$/.test(code)) {
    return 'The helper returned an unusable continuation. Nothing was sent. Review the continuation instructions or choose another helper model.';
  }
  if (/^provider_(?:completion|stream)_error$/.test(code)) return 'The provider reported an error while generating the continuation. Check its status or choose another model.';
  if (/^http_\d{3}$/.test(code)) return `The continuation provider rejected the request (HTTP ${code.slice(5)}). Check its status and the configured model or endpoint.`;
  if (wrapped) return explanations.request_failed!;
  if (/^[a-z][a-z0-9_]+$/.test(raw)) return `The continuation could not proceed. Check the app diagnostics for details (${raw}).`;
  return raw;
}

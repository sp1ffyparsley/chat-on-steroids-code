/** Stable transcript text for ChatGPT's provider-owned tool approval card. */
export const APPROVAL_PROGRESS_PREFIX = 'approval-wait:';
export const APPROVAL_WAITING_TEXT =
  'ChatGPT shows a pending native tool approval in this chat. Continuation waits until the card clears; inspect it in ChatGPT if it remains pending.';
// Card disappearance proves neither which action was chosen nor a successful tool result.
export const APPROVAL_ANSWERED_TEXT = 'The native tool approval card in this chat is no longer pending.';

/** Exact legacy strings keep already-recorded progress rows visible after this update. */
export function approvalTextState(text: string): 'waiting' | 'answered' | null {
  if (text === APPROVAL_WAITING_TEXT || text ===
      'ChatGPT is waiting for you to allow or deny a tool call in this chat. Nothing continues until you answer it there.') return 'waiting';
  if (text === APPROVAL_ANSWERED_TEXT || text === 'The tool approval ChatGPT asked for in this chat was answered.') return 'answered';
  return null;
}


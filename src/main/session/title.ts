import { isGenericAutomaticSessionTitle, type SessionEvent, type SessionSummary } from '../../shared/session.js';
import { providerSerializedUserPromptText, userPromptText } from '../../shared/user-prompt.js';
import { operatorPromptBody } from '../../shared/operator-prompt.mjs';

const continuationPrefix = /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\s*/;
const contextPrefix = /^\s*(?:\[\[CLF-(?:HANDOFF|RESUME)(?:\\)?:[A-Za-z0-9_-]{16,64}\]\]\s*)?\[\[COS(?:_|\\_)CONTEXT:\d{1,6}\]\]/;
/** Upstream word-boundary preview, applied after this fork's task-label extraction. */
function boundedNickname(title: string): string {
  const characters = [...title];
  if (characters.length <= 80) return title;
  const cut = characters.slice(0, 79).join('');
  const space = cut.lastIndexOf(' ');
  const words = space >= cut.length / 2 ? cut.slice(0, space) : cut;
  return words.replace(/[\s,;:.–—-]+$/u, '') + '…';
}

function compactNickname(value: string): string {
  let title = value.replace(/\s+/g, ' ').trim();
  if (!title) return '';

  // Long-running coding prompts commonly state the durable task before words such as
  // "workstream" or "objective". Keep that identity and discard the transport wording.
  const namedWork = title.match(
    /^(?:okay[,;:]?\s*)?(?:please\s+)?(?:continue|resume)\s+(?:the\s+)?(?:same\s+|existing\s+|current\s+|canonical\s+)?(.{3,86}?)\s+(?:workstream|objective|task|project)\b/i
  )?.[1]?.trim();
  if (namedWork && !isGenericAutomaticSessionTitle(namedWork)) return boundedNickname(namedWork);

  title = title
    .replace(/^(?:okay[,;:]?\s*)?(?:please\s+)?(?:can you\s+)?(?:go ahead and\s+)?/i, '')
    .replace(/^(?:i\s+(?:really\s+)?want\s+you\s+to|i(?:'d| would)\s+like\s+you\s+to)\s+/i, '')
    .replace(/^(?:continue|resume)(?:\s+working)?(?:\s+on)?\s+(?:the\s+)?(?:same\s+|existing\s+|current\s+|previous\s+|canonical\s+)?/i, '')
    .replace(/\s+(?:from|using)\s+(?:the\s+)?(?:current|exact|sealed|saved|latest)\b.*$/i, '')
    .replace(/\s+in:\s*$/i, '')
    .replace(/[.?!,:;\-–—\s]+$/u, '')
    .trim();

  if (!title || isGenericAutomaticSessionTitle(title)) return '';
  return boundedNickname(title);
}

/** Presentation only: never reinterpret a damaged frame as delivery/receipt evidence. */
export function userTitle(text: string, authoredText?: string): string {
  const unwrapped = operatorPromptBody(text);
  const authored = authoredText ?? userPromptText(unwrapped) ?? providerSerializedUserPromptText(unwrapped);
  if (authored === null && contextPrefix.test(unwrapped)) return '';
  // Transport filler is never a task name; retain ordinary prose and explicit nickname owners.
  const visible = operatorPromptBody((authored ?? unwrapped).replace(continuationPrefix, '')).replace(continuationPrefix, '');
  const firstLine = visible.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  // Workspace prompts commonly lead with a useful short area name and then put the full
  // production request in parentheses. Keep the useful label instead of 80 characters of
  // "I want you to…" boilerplate.
  const labelled = firstLine.match(/^(.{3,60}?)\s+\((?=[A-Za-z])/u)?.[1]?.trim();
  return compactNickname(labelled || firstLine);
}

export function legacyContextTitle(summary: SessionSummary): boolean {
  return summary.titleSource !== 'manual' && contextPrefix.test(summary.title) && (!summary.origin || summary.origin.kind === 'desktop');
}

export function firstTitleMessage(events: Iterable<SessionEvent>): Extract<SessionEvent, { kind: 'user_message' }> | undefined {
  let first: Extract<SessionEvent, { kind: 'user_message' }> | undefined;
  for (const event of events) if (event.kind === 'user_message' &&
      (!first || (event.origin ?? event.seq) < (first.origin ?? first.seq))) first = event;
  return first;
}

/** Earliest authored user row that can actually name the work, skipping transport boilerplate. */
function firstUsefulTitleMessage(events: Iterable<SessionEvent>): Extract<SessionEvent, { kind: 'user_message' }> | undefined {
  let first: Extract<SessionEvent, { kind: 'user_message' }> | undefined;
  for (const event of events) {
    if (event.kind !== 'user_message' || !userTitle(event.message.text, event.authoredText)) continue;
    if (!first || (event.origin ?? event.seq) < (first.origin ?? first.seq)) first = event;
  }
  return first;
}

/** Old builds used both 80 and 120 characters, before or after trimming. */
export function automaticTitle(summary: SessionSummary, first?: Extract<SessionEvent, { kind: 'user_message' }>): boolean {
  if (summary.origin && summary.origin.kind !== 'desktop') return false;
  if (summary.titleSource) return summary.titleSource !== 'manual';
  if (summary.title === 'ChatGPT session' || legacyContextTitle(summary)) return true;
  if (!first) return false;
  return [first.authoredText, userPromptText(first.message.text), providerSerializedUserPromptText(first.message.text), first.message.text].some(text =>
    text != null && (userTitle(text, text) === summary.title || [80, 120].some(length => [text.slice(0, length).trim(), text.trim().slice(0, length), text.trim().slice(0, length).trim()].includes(summary.title))));
}

/** Rebuild only a preview. Provider/manual/origin titles keep their authority. */
export function refreshUserTitle(summary: SessionSummary, events: Iterable<SessionEvent>): boolean {
  // Callers commonly pass Map.values(), which is a one-shot iterator. Both title decisions
  // must inspect the same bounded canonical message set rather than letting the first scan
  // exhaust the second one.
  const messages = [...events];
  const first = firstTitleMessage(messages);
  if (!first && !legacyContextTitle(summary)) return false;
  // A transport-only opening such as "Resume ChatGPT session" is intentionally not a task
  // name. Once the same durable chat contains a real authored instruction, promote the earliest
  // useful one automatically so a pile of resumed sessions does not stay indistinguishable.
  const useful = firstUsefulTitleMessage(messages);
  const title = useful ? userTitle(useful.message.text, useful.authoredText) : 'ChatGPT session';
  // The local task description is the useful sidebar name. Keep ChatGPT's generated label as
  // secondary provenance instead of letting generic names such as "Coding Agent Guidance"
  // replace the task the user can actually recognise.
  if (summary.titleSource === 'provider') {
    if (!title || title === summary.title) return false;
    summary.originalTitle = summary.title;
    summary.title = title;
    summary.titleSource = 'fallback';
    return true;
  }
  if (summary.titleSource === 'manual') {
    if (summary.originalTitle || !title || title === summary.title) return false;
    summary.originalTitle = title;
    return true;
  }
  if (!automaticTitle(summary, first)) return false;
  const changed = summary.title !== title || summary.titleSource !== 'fallback';
  summary.title = title;
  summary.titleSource = 'fallback';
  return changed;
}

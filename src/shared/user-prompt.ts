/** Transport framing, not a second prompt source. Length keeps marker-like user text literal. */
import { operatorPromptBody } from './operator-prompt.mjs';
export { MAX_CHATGPT_MESSAGE_CHARS } from './prompt-limits.mjs';
const continuation = (text: string): string => /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/.exec(text)?.[0] ?? '';
export function userPromptText(text: string): string | null {
  text = operatorPromptBody(text.replace(/\r\n?/g, '\n'));
  const identity = continuation(text);
  const header = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(text.slice(identity.length));
  if (!header) return null;
  const end = identity.length + header[0].length + Number(header[1]);
  const boundary = '\n[[/COS_CONTEXT]]\n\n';
  return text.startsWith(boundary, end) ? identity + text.slice(end + boundary.length) : null;
}

/**
 * Presentation-only recovery for ChatGPT's provider-side Markdown serialization.
 * This decoder is not native-scope proof; nativePreparedInputMatches compares the
 * complete retained payload instead. The provider can escape
 * Markdown punctuation and turn a bare URL into `[url](url)` after accepting a native
 * send; decode only that single reversible pass and require the length-delimited frame.
 */
export function providerSerializedUserPromptText(text: string): string | null {
  let normalized = text.replace(/\r\n?/g, '\n');
  normalized = normalized.replace(/\\([\\`*_{}\[\]()#+\-.!<>&:])/g, '$1');
  normalized = normalized.replace(/\[(https?:\/\/[^\]\s]{1,4096})\]\((https?:\/\/[^)\s]{1,4096})\)/g,
    (whole, label: string, destination: string) => label === destination ? label : whole);
  return userPromptText(normalized);
}

export function prependUserPrompt(text: string, instructions: string): string {
  text = text.replace(/\r\n?/g, '\n');
  instructions = instructions.replace(/\r\n?/g, '\n');
  const authored = userPromptText(text) ?? text;
  const identity = continuation(authored);
  return `${identity}[[COS_CONTEXT:${instructions.length}]]\n${instructions}\n[[/COS_CONTEXT]]\n\n${authored.slice(identity.length)}`;
}

/**
 * Compare a confirmed native body with its frozen prepared payload. This proves
 * spelling equivalence only, never delivery, Core identity, completion or access.
 * Transformed spellings require a complete retained length-delimited frame.
 */
export function nativePreparedInputMatches(recorded: string, prepared: string): boolean {
  if (recorded === prepared) return true;
  if (userPromptText(prepared) === null) return false;
  return providerSerializedPayloadMatches(withoutNativeCoreMention(recorded), prepared);
}

function withoutNativeCoreMention(recorded: string): string {
  // ONE bounded native Core attachment, anchored before the complete retained payload.
  const attachment = /^\[\$[a-z][a-z0-9-]{0,80}-windows-core\]\(app:\/\/asdk_app_[a-f0-9]{32}\)/.exec(recorded);
  return attachment ? recorded.slice(attachment[0].length) : recorded;
}

/** Legacy spelling proof only. The caller must independently prove a confirmed Input's
 * exact native UUID, frozen prepared hash and original authored text. Never use this for
 * direct Goal ACKs, incomplete snapshots, malformed frames, delivery or tool completion. */
export function retainedLegacyInputPayloadMatches(recorded: string, prepared: string): boolean {
  if (!prepared || prepared.includes('[[COS_CONTEXT:')) return false;
  return providerSerializedPayloadMatches(withoutNativeCoreMention(recorded), prepared);
}

/** Linear expected-to-provider comparison, with no lossy normalization of authored content. */
export function providerSerializedPayloadMatches(recorded: string, expected: string): boolean {
  const escaped = (char: string | undefined): boolean => !!char && /[\\`*_{}\[\]()#+\-.!<>&:|=~]/.test(char);
  let at = 0;
  for (let index = 0; index < expected.length; index++) {
    const char = expected[index]!;
    if (char === '\\') {
      let authoredSlashes = 1, observedSlashes = 0;
      while (expected[index + authoredSlashes] === '\\') authoredSlashes++;
      while (recorded[at + observedSlashes] === '\\') observedSlashes++;
      const next = expected[index + authoredSlashes];
      // Literal authored slash runs must survive, raw or escaped once. A following escaped
      // punctuation/hard break may add exactly one more slash, never erase an authored one.
      const extra = (escaped(next) || next === '\n') &&
        (observedSlashes === authoredSlashes + 1 || observedSlashes === authoredSlashes * 2 + 1);
      // Before an ordinary character, Markdown may escape each preceding slash
      // pair and leave its last slash literal: two authored slashes become three.
      // Compare against the entire retained body; never delete a path separator.
      const finalLiteral = authoredSlashes > 1 && !!next && !escaped(next) && next !== '\n' &&
        observedSlashes === authoredSlashes * 2 - 1;
      if (observedSlashes !== authoredSlashes && observedSlashes !== authoredSlashes * 2 && !extra && !finalLiteral) return false;
      index += authoredSlashes - 1;
      at += observedSlashes;
    } else if (recorded[at] === char) {
      at++;
    } else if (char === '\n' && recorded.startsWith(' \\\n', at)) {
      at += 3;
    } else if (char === ' ' && recorded.startsWith('&#x20;', at)) {
      at += 6;
    } else if ((escaped(char) || char === '\n') && recorded[at] === '\\' && recorded[at + 1] === char) {
      at += 2;
    } else {
      return false;
    }
  }
  return at === recorded.length;
}

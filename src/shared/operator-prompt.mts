/** Legacy readback vocabulary only. Never generate new trivia-question headers. */
export const OPERATOR_PROMPT_QUESTIONS = Object.freeze([
  'What color is the sky?', 'How many days are in a week?', 'What is your favorite season?',
  'Where do birds build nests?', 'Why do leaves change color?', 'What makes a rainbow?',
  'How do seeds grow?', 'Where does rain come from?', 'What do bees collect?',
  'How do fish breathe?', 'Why does ice float?', 'What causes ocean waves?',
  'How do clocks measure time?', 'Where do stars appear at night?', 'What shapes can clouds form?'
]);
export const OPERATOR_PROMPT_HEADER_PREFIX = '[[COS_OPERATOR_QUESTIONS:';
export const OPERATOR_PROMPT_MAX_QUESTIONS = 2;
export const OPERATOR_PROMPT_HEADER_QUESTIONS = Object.freeze([
  'What is the most useful next step for this task given the verified context, and what evidence will show that it worked?',
  'Which existing implementation and verified results should be reused to avoid duplicate work while preserving the full task requirements?'
]);
export const OPERATOR_PROMPT_FOOTER = 'IGNORE THE FIRST SENTENCE ABOVE.';

function operatorPromptHeader(questionCount = 1): string {
  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > OPERATOR_PROMPT_MAX_QUESTIONS)
    throw new Error('Operator prompt header must contain one or two task questions');
  return `${OPERATOR_PROMPT_HEADER_PREFIX}${questionCount}]] ${OPERATOR_PROMPT_HEADER_QUESTIONS.slice(0, questionCount).join(' ')}`;
}

/** Recognize a reserved marked header or an intact historical ten-question line. */
function envelopeStart(value: string) {
  const trimmed = value.trim();
  const firstBreak = trimmed.indexOf('\n');
  const newline = firstBreak >= 0 && trimmed[firstBreak - 1] === '\r' ? '\r\n' : '\n';
  const header = firstBreak < 0 ? trimmed : trimmed.slice(0, firstBreak - (newline.length - 1));
  if (header === operatorPromptHeader(1) || header === operatorPromptHeader(2))
    return { trimmed, newline, bodyStart: firstBreak < 0 ? trimmed.length + 1 : firstBreak + 1 };
  const questions = header.endsWith('.') ? header.slice(0, -1).split(', ') : [];
  if (questions.length !== 10 || new Set(questions).size !== 10 ||
      questions.some(question => !OPERATOR_PROMPT_QUESTIONS.includes(question))) return null;
  return { trimmed, newline, bodyStart: firstBreak < 0 ? trimmed.length + 1 : firstBreak + 1 };
}

/** Semantic comparison only; malformed lookalikes and authored footer text stay literal. */
export function operatorPromptBody(value: string): string {
  if (typeof value !== 'string') return value;
  const start = envelopeStart(value);
  if (!start) return value;
  const suffix = start.newline + OPERATOR_PROMPT_FOOTER;
  if (!start.trimmed.endsWith(suffix) || start.trimmed.length < start.bodyStart + suffix.length) return value;
  return start.trimmed.slice(start.bodyStart, -suffix.length);
}

/**
 * History/identity comparison only: remove the known provider spelling of the
 * wrapper, preserving every body byte for the caller's complete retained-body match.
 * Never use this compatibility reader to authorize or prepare a native Send.
 */
export function recordedOperatorPromptBody(value: string): string {
  const raw = operatorPromptBody(value);
  if (raw !== value) return raw;
  const firstBreak = value.indexOf('\n');
  if (firstBreak < 0) return value;
  const first = value.slice(0, firstBreak).replace(/ ?\\$/, '').replace(/\\\.$/, '.').replace(/\\([_\[\]])/g, '$1');
  if (!envelopeStart(first)) return value;
  for (const footer of [OPERATOR_PROMPT_FOOTER, OPERATOR_PROMPT_FOOTER.slice(0, -1) + '\\.']) {
    for (const separator of [' \\\n', '\\\n', '\n']) {
      const suffix = separator + footer;
      if (value.endsWith(suffix) && value.length >= firstBreak + 1 + suffix.length)
        return value.slice(firstBreak + 1, -suffix.length);
    }
  }
  return value;
}

/** Validate before queue admission without changing authored content or frozen old envelopes. */
export function validateOperatorPrompt(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Operator prompt body must not be empty');
  if (OPERATOR_PROMPT_HEADER_QUESTIONS.length !== OPERATOR_PROMPT_MAX_QUESTIONS ||
      OPERATOR_PROMPT_HEADER_QUESTIONS.some(question => !question.endsWith('?') || /[\r\n]/u.test(question)))
    throw new Error('Operator prompt task-question vocabulary is invalid');
  const start = envelopeStart(value);
  if (!start && value.trimStart().startsWith(OPERATOR_PROMPT_HEADER_PREFIX))
    throw new Error('Operator prompt header must contain one or two exact reserved task questions');
  if (start) {
    const body = operatorPromptBody(value);
    if (body === value) throw new Error(`Operator prompt footer must be the final line: ${OPERATOR_PROMPT_FOOTER}`);
    if (!body.trim()) throw new Error('Operator prompt body must not be empty');
    if (envelopeStart(body)) throw new Error('Operator prompt envelope is duplicated; keep one header and final footer');
    return start.trimmed;
  }
  return value;
}

/** Fail closed at authorization: normalization must never conceal a damaged final payload. */
export function assertOperatorPromptEnvelope(value: string): void {
  const valid = validateOperatorPrompt(value);
  if (valid !== value || !envelopeStart(value) || operatorPromptBody(value) === value)
    throw new Error('Required prompt envelope is missing or malformed. Native Send was not authorized; reconcile this delivery before retrying.');
  if (envelopeStart(operatorPromptBody(value)))
    throw new Error('Required prompt envelope is duplicated. Native Send was not authorized.');
}

/** Reserve mandatory wrapper bytes before optional project context is fitted. */
export function operatorPromptOverhead(): { chars: number; bytes: number } {
  validateOperatorPrompt('Validate task questions');
  const fixed = 2 * 9 + 1 + 2 + OPERATOR_PROMPT_FOOTER.length;
  // Existing frozen legacy requests may still append context inside their footer.
  // Reserve the larger complete envelope; never rewrite them to fit a new header.
  const longest = (size: (text: string) => number) => Math.max(
    size(operatorPromptHeader(2)) + 2 + size(OPERATOR_PROMPT_FOOTER),
    OPERATOR_PROMPT_QUESTIONS.map(size).sort((a, b) => b - a).slice(0, 10)
      .reduce((sum, count) => sum + count, fixed));
  return { chars: longest(text => text.length), bytes: longest(text => new TextEncoder().encode(text).length) };
}

/** Preserve the frozen header while appending owned context inside its final footer. */
export function replaceOperatorPromptBody(envelope: string, body: string): string {
  assertOperatorPromptEnvelope(envelope);
  if (!body.trim()) throw new Error('Operator prompt body must not be empty');
  const start = envelopeStart(envelope)!;
  return envelope.slice(0, start.bodyStart) + body + start.newline + OPERATOR_PROMPT_FOOTER;
}

/**
 * Prepare one transport envelope only for a new request, after duplicate inspection.
 * Preserve authored whitespace and literal footer occurrences. Valid envelopes are
 * reused unchanged; only whitespace outside their footer/header is removed.
 * The optional old RNG argument is retained for callers but is never invoked.
 * Naming metadata and automation objectives never pass through this helper.
 */
export function prepareOperatorPrompt(value: string, _randomIndex?: (upper: number) => number, questionCount = 1): string {
  value = validateOperatorPrompt(value);
  if (envelopeStart(value)) return value;
  const prepared = `${operatorPromptHeader(questionCount)}\n${value}\n${OPERATOR_PROMPT_FOOTER}`;
  if (operatorPromptBody(prepared) !== value) throw new Error('Operator prompt injection failed its body round-trip validation');
  return prepared;
}

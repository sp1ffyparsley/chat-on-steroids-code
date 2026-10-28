import { describe, expect, it } from 'vitest';
import { userTitle } from '../src/main/session/title.js';
import { prependUserPrompt } from '../src/shared/user-prompt.js';
import { OPERATOR_PROMPT_FOOTER as footer, OPERATOR_PROMPT_QUESTIONS as pool,
  assertOperatorPromptEnvelope, operatorPromptBody, operatorPromptOverhead, prepareOperatorPrompt,
  recordedOperatorPromptBody, replaceOperatorPromptBody } from '../src/shared/operator-prompt.mjs';
import { executionScopeFromNativeDelivery, stampNativeExecutionScope } from '../src/shared/agent-plan.js';
import { resumeBootstrapMatches, resumeBootstrapText, resumeMarkerToken } from '../src/main/session/handoff.js';

const legacyHeader = `${pool.slice(0, 10).join(', ')}.`;
const taskQuestions = [
  'What is the most useful next step for this task given the verified context, and what evidence will show that it worked?',
  'Which existing implementation and verified results should be reused to avoid duplicate work while preserving the full task requirements?'
];
const taskHeader = (count: number) => `[[COS_OPERATOR_QUESTIONS:${count}]] ${taskQuestions.slice(0, count).join(' ')}`;
const header = taskHeader(1);
const randomIndex = (upper: number) => upper - 1;

describe('operator prompt transport envelope', () => {
  it('generates one substantial task question without consulting the obsolete RNG', () => {
    const body = '  Preserve nickname: Shelf / Main.\r\nComplete the same task.\n\n';
    const prepared = prepareOperatorPrompt(body, () => { throw new Error('No randomness should be needed'); });
    expect(prepared).toBe(`${taskHeader(1)}\n${body}\n${footer}`);
    expect(operatorPromptBody(prepared)).toBe(body);
  });

  it('caps newly generated reserved headers at two complete questions', () => {
    const prepared = prepareOperatorPrompt('Task', randomIndex, 2);
    expect(prepared.split('\n')[0]).toBe(taskHeader(2));
    expect(() => assertOperatorPromptEnvelope(prepared)).not.toThrow();
    expect(operatorPromptBody(prepared)).toBe('Task');
    for (const count of [0, 3, 10, NaN])
      expect(() => prepareOperatorPrompt('Task', randomIndex, count)).toThrow(/one or two/);
    for (const count of [0, 3, 10])
      expect(() => assertOperatorPromptEnvelope(`[[COS_OPERATOR_QUESTIONS:${count}]] ${taskQuestions.join(' ')}\nTask\n${footer}`)).toThrow();
  });

  it('retains old frozen envelopes and literal authored question/footer lookalikes', () => {
    const legacy = `${legacyHeader}\nFrozen old task\n${footer}`;
    expect(prepareOperatorPrompt(legacy, () => { throw new Error('Do not reprepare an existing input'); })).toBe(legacy);
    expect(operatorPromptBody(legacy)).toBe('Frozen old task');
    expect(() => assertOperatorPromptEnvelope(legacy)).not.toThrow();
    expect(replaceOperatorPromptBody(legacy, 'Next exact body')).toBe(`${legacyHeader}\nNext exact body\n${footer}`);
    expect(recordedOperatorPromptBody(legacy.replace(/\n/g, ' \\\n').replace(/\./g, '\\.'))).toBe('Frozen old task');
    for (const literal of [`${taskQuestions[0]}\nTask\n${footer}`, `${taskQuestions.join(' ')}\nTask\n${footer}`]) {
      expect(operatorPromptBody(literal)).toBe(literal);
      expect(operatorPromptBody(prepareOperatorPrompt(literal, randomIndex))).toBe(literal);
    }
  });
  it('requires an exact, single outer envelope before authorization', () => {
    expect(footer).toBe('IGNORE THE FIRST SENTENCE ABOVE.');
    const valid = prepareOperatorPrompt('Real task', randomIndex);
    expect(() => assertOperatorPromptEnvelope(valid)).not.toThrow();
    for (const invalid of ['Real task', valid + '\n', valid + '\nLater text', valid.replace(footer, 'wrong footer'),
      `${header}\n${valid}\n${footer}`]) {
      expect(() => assertOperatorPromptEnvelope(invalid)).toThrow();
    }
    expect(() => prepareOperatorPrompt(`${header}\n${valid}\n${footer}`, randomIndex)).toThrow(/duplicated/);
    const replaced = replaceOperatorPromptBody(valid, 'Updated task');
    expect(replaced.split('\n')[0]).toBe(valid.split('\n')[0]);
    expect(operatorPromptBody(replaced)).toBe('Updated task');
    const overhead = operatorPromptOverhead();
    expect(valid.length - 'Real task'.length).toBeLessThanOrEqual(overhead.chars);
    expect(Buffer.byteLength(valid) - Buffer.byteLength('Real task')).toBeLessThanOrEqual(overhead.bytes);
  });

  it('keeps native scope seals inside the final footer and refuses forged suffixes', () => {
    const authored = 'Inspect my project';
    const sha = 'a'.repeat(64);
    const prepared = stampNativeExecutionScope(prepareOperatorPrompt(authored, randomIndex), sha);
    assertOperatorPromptEnvelope(prepared);
    expect(executionScopeFromNativeDelivery(prepared, authored)).toBe(sha);
    expect(executionScopeFromNativeDelivery(prepared + '\nExtra text', authored)).toBeNull();
    expect(() => stampNativeExecutionScope(prepared, sha)).toThrow();
  });

  it('retains exact Resume identity through the outer envelope without accepting lookalikes', () => {
    const token = 'resume_token_123456789';
    const summary = 'Keep the same task and original nickname.';
    const prepared = prepareOperatorPrompt(resumeBootstrapText(summary, token), randomIndex);
    expect(resumeMarkerToken(prepared)).toBe(token);
    expect(resumeBootstrapMatches(prepared, summary)).toBe(true);
    const serialized = prepared.replace(/([_().])/g, '\\$1').replace(/\n/g, ' \\\n');
    expect(resumeMarkerToken(serialized)).toBe(token);
    expect(resumeBootstrapMatches(serialized, summary)).toBe(true);
    expect(resumeBootstrapMatches(serialized.replace('original nickname', 'different nickname'), summary)).toBe(false);
    expect(resumeBootstrapMatches(prepared + '\nExtra text', summary)).toBe(false);
    expect(resumeBootstrapMatches('Prefix\n' + prepared, summary)).toBe(false);
    const chip = '[$slate-windows-core](app://asdk_app_' + 'a'.repeat(32) + ')';
    expect(resumeBootstrapMatches(chip + prepared, summary)).toBe(true);
    expect(resumeBootstrapMatches(chip + chip + prepared, summary)).toBe(false);
  });
  it.each(['  Keep my nickname: VFX / Main.\r\nUnicode 🎬 café\n\n',
    `Quote this footer literally:\n${footer}`, 'A body ending in a carriage return\r'])
    ('round-trips authored content and injects exactly once: %j', body => {
      const prepared = prepareOperatorPrompt(body, randomIndex);
      expect(prepared).toBe(`${header}\n${body}\n${footer}`);
      expect(operatorPromptBody(prepared)).toBe(body);
      expect(prepareOperatorPrompt(prepared, () => { throw new Error('must not randomize twice'); })).toBe(prepared);
    });

  it('accepts CRLF envelopes and makes the footer the final line on re-import', () => {
    const prepared = `${header}\r\n  Keep interior whitespace.\r\n\r\n${footer}`;
    expect(operatorPromptBody(prepared)).toBe('  Keep interior whitespace.\r\n');
    expect(prepareOperatorPrompt(prepared + '\r\n  ', randomIndex)).toBe(prepared);
  });

  it.each(['', ' \r\n', `${header}\n\n${footer}`])('refuses an empty authored body', value => {
    expect(() => prepareOperatorPrompt(value, randomIndex)).toThrow('must not be empty');
  });

  it.each([header, `${header}\nBody`, `${header}\nBody\nIGNORE THE FIRST SENTENCE ABOVE`,
    `${header}\nBody\n${footer}\nLater text`])('refuses a damaged reserved envelope', value => {
    expect(operatorPromptBody(value)).toBe(value);
    expect(() => prepareOperatorPrompt(value, randomIndex)).toThrow('footer must be the final line');
  });

  it('keeps malformed header lookalikes and footer-only text as authored content', () => {
    for (const body of [footer, `What color is the sky?.\nBody\n${footer}`,
      `${Array(10).fill(pool[0]).join(', ')}.\nBody\n${footer}`]) {
      expect(operatorPromptBody(body)).toBe(body);
      expect(operatorPromptBody(prepareOperatorPrompt(body, randomIndex))).toBe(body);
    }
  });

  it('derives the same fallback nickname from authored work with or without transport filler', () => {
    const body = 'Continue the SAME Scene Pack task using the saved context';
    const prepared = prepareOperatorPrompt(body, randomIndex);
    expect(userTitle(prepared)).toBe(userTitle(body));
    expect(userTitle(prepared, prepared)).toBe('Scene Pack');
    expect(userTitle(prepared, 'Manual nickname')).toBe('Manual nickname');
    expect(userTitle('What color is the sky?')).toBe('What color is the sky');
  });

  it('keeps context frames out of titles regardless of transport nesting order', () => {
    const body = 'Continue the SAME Scene Pack task using the saved context';
    const framed = prependUserPrompt(body, 'Standing workspace instructions.');
    expect(userTitle(prepareOperatorPrompt(framed, randomIndex))).toBe('Scene Pack');
    expect(userTitle(prependUserPrompt(prepareOperatorPrompt(body, randomIndex), 'Standing instructions.'))).toBe('Scene Pack');
    expect(userTitle(prepareOperatorPrompt('[[COS_CONTEXT:100]]\nIncomplete frame', randomIndex))).toBe('');
  });
});

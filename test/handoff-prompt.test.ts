import { expect, it } from 'vitest';
import { nativeHandoffPrompt } from '../src/main/session/handoff-prompt.js';

it.each([true, false])('preserves real human authority and original acceptance in a native compaction handoff (tool details %s)', includeToolCalls => {
  const prompt = nativeHandoffPrompt('0123456789abcdef0123456789abcdef', includeToolCalls);
  expect(prompt).toContain('[[CLF-HANDOFF:0123456789abcdef0123456789abcdef]]');
  expect(prompt).toContain('Goal/Loop-generated user-role messages');
  expect(prompt).toContain('not later human corrections');
  expect(prompt).toContain('original human request and every verified human correction');
  expect(prompt).toContain('original active acceptance IDs and denominator');
  expect(prompt).toContain('excluded historical items outside the active denominator');
  expect(prompt).toContain('update_plan identity refusal');
  expect(prompt).toContain('no plan saved');
  expect(prompt).toContain('source tests, installation and native product verification distinct');
  expect(prompt).toContain('A successful tool result proves only that specific operation');
  expect(prompt).toContain('not overall task acceptance or installed/live behavior');
  expect(prompt).toContain('USER SPECIFICATION');
  expect(prompt).toContain('VERIFICATION');
  expect(prompt).toContain('Your reply to this message must be the brief itself');
});

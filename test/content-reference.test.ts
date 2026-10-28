import { expect, it } from 'vitest';
import { hasContentReference, hasProviderDirective, modelFacingText, plainTextOfHtml, resolvedCapture, withoutProviderDirectives } from '../src/shared/content-reference.js';

const pointer = '::chatgpt-content-reference{index="0" source_message_id="d2b82e00-509e-4a87-aa93-00bcde251680"}';

it('reads a pointer-only reply from the page capture that resolved it', () => {
  const capture = { text: '<p>Hi! How can I <strong>help</strong> you today?</p><ul><li>Plan &amp; build</li><li>Fix a bug</li></ul>', truncated: false };
  expect(hasContentReference(pointer)).toBe(true);
  expect(modelFacingText(pointer, capture)).toBe('Hi! How can I help you today?\nPlan & build\nFix a bug');
});

it('handles later provider directives without one fix per directive name', () => {
  const leaf = 'Here you go:\n::chatgpt-entity{type="place" id="42"}\nDone.';
  expect(hasProviderDirective(leaf)).toBe(true);
  expect(modelFacingText(leaf, { text: '<p>Here you go:</p><p>Berlin</p><p>Done.</p>' })).toBe('Here you go:\nBerlin\nDone.');
  expect(withoutProviderDirectives(leaf)).toBe('Here you go:\n\nDone.');
  expect(modelFacingText(':::canvas{title="Plan"}\nStep one\nStep two\n:::')).toBe('Step one\nStep two');
  expect(resolvedCapture({ text: '<p>::chatgpt-entity{id="1"}</p>' })).toBe(false);
  expect(hasProviderDirective(':::writing{title="x"}\nText\n:::')).toBe(false);
  expect(hasProviderDirective(`Use \`${pointer}\` in docs`)).toBe(false);
  expect(plainTextOfHtml('<p>a&#39;b &#x41; &nbsp;c</p><script>x()</script>')).toBe("a'b A  c");
});

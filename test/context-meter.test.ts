import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { initContextMeter, paintContextMeter } from '../src/renderer/context-meter.js';
import type { Config } from '../src/shared/types.js';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });
function setup(model: string, reasoningEffort: 'high' | 'pro' = 'high', options: { auto?: boolean; autoTokens?: number; used?: number } = {}) {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('Node', dom.window.Node);
  const session = { conversationId: 'chat', contextTokens: options.used ?? 100000,
    selectedModel: { conversationId: 'chat', model, reasoningEffort } } as SessionSummary;
  const config = { sessions: { limitTokens: 200000 }, compaction: { auto: options.auto ?? true, autoTokens: options.autoTokens ?? 150000 } } as Config;
  paintContextMeter(session, config);
  return dom.window.document;
}
it('uses the configured compaction threshold for Pro', () => {
  const doc = setup('gpt-6', 'pro');
  expect(doc.getElementById('contextMeterArc')?.getAttribute('stroke-dasharray')).toBe('25.259 37.7');
  expect(doc.getElementById('contextMeterInfo')?.textContent).toContain('Auto-compaction at 150,000 tokens');
  expect(doc.getElementById('contextMeterInfo')?.textContent).toContain('67% of the compaction point');
  expect(doc.getElementById('contextMeterInfo')?.textContent).toContain('estimated');
});
it('fills toward the positive compaction point and supports click and Escape', () => {
  const doc = setup('gpt-5.6-sol-high');
  expect(doc.getElementById('contextMeterInfo')?.textContent).toContain('100,000 / 150,000 tokens · 67% of the compaction point');
  expect(doc.getElementById('contextMeterButton')?.getAttribute('aria-label')).toContain('67% of the compaction point');
  initContextMeter();
  const button = doc.getElementById('contextMeterButton')!;
  button.click();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  button.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape' }));
  expect(button.getAttribute('aria-expanded')).toBe('false');
});
it.each([
  { name: 'automatic compaction is disabled', auto: false, autoTokens: 150000 },
  { name: 'the compaction threshold is zero', auto: true, autoTokens: 0 },
])('fills toward the large-chat warning when $name', ({ auto, autoTokens }) => {
  const doc = setup('gpt-5.6-sol-high', 'high', { auto, autoTokens });
  expect(doc.getElementById('contextMeterInfo')?.textContent).toContain('100,000 / 200,000 tokens · 50% of the large-chat warning');
  expect(doc.getElementById('contextMeterArc')?.getAttribute('stroke-dasharray')).toBe('18.85 37.7');
  if (!auto) expect(doc.getElementById('contextMeterInfo')?.textContent).toContain('Auto-compaction off');
});
it.each([
  { name: 'above the compaction point', auto: true, used: 180000, ceiling: '150,000', description: 'compaction point' },
  { name: 'above the warning size', auto: false, used: 240000, ceiling: '200,000', description: 'large-chat warning' },
])('clamps the ring at 100% $name without hiding the token estimate', ({ auto, used, ceiling, description }) => {
  const doc = setup('gpt-5.6-sol-high', 'high', { auto, used });
  expect(doc.getElementById('contextMeterInfo')?.textContent).toContain(used.toLocaleString('en') + ' / ' + ceiling + ' tokens · 100% of the ' + description);
  expect(doc.getElementById('contextMeterArc')?.getAttribute('stroke-dasharray')).toBe('37.7 37.7');
});

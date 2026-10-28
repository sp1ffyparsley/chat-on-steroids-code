import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentPanel } from '../src/renderer/agent-panel.js';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());
it('keeps Prime selection independent and rejects late results after parent navigation', async () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!;
  const toggle = document.querySelector('button')!;
  let resolve!: (value: { events: [] }) => void;
  const load = vi.fn(() => new Promise<{ events: [] }>(done => { resolve = done; }));
  const render = vi.fn(() => [document.createElement('article')]);
  const openMain = vi.fn();
  const panel = createAgentPanel({ host, toggle, load, render, openMain, working: () => false });
  const worker = { id: 'worker-session', title: 'Worker', updatedAt: 1 } as SessionSummary;
  panel.update('prime-session', [worker]); toggle.click();
  expect(host.textContent).toContain('History · 1');
  const opening = panel.open(worker.id);
  expect(openMain).not.toHaveBeenCalled();
  panel.update('another-prime', []);
  resolve({ events: [] }); await opening;
  expect(render).not.toHaveBeenCalled();
  expect(host.querySelector('aside')!.hidden).toBe(true);
  await panel.open(worker.id);
  expect(load).toHaveBeenCalledTimes(1);
});

it('renders a selected worker and offers an explicit full-chat navigation', async () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const openMain = vi.fn();
  const panel = createAgentPanel({ host, toggle, load: async () => ({ events: [] }),
    render: () => { const p = document.createElement('p'); p.textContent = 'Recorded response'; return [p]; }, openMain, working: () => true });
  panel.update('prime', [{ id: 'worker', title: 'Worker', updatedAt: 1 } as SessionSummary]);
  await panel.open('worker');
  expect(host.textContent).toContain('Recorded response');
  expect(openMain).not.toHaveBeenCalled();
  [...host.querySelectorAll('button')].find(button => button.textContent === 'Open full chat')!.click();
  expect(openMain).toHaveBeenCalledWith('worker');
  expect(host.querySelector('aside')!.hidden).toBe(true);
});

it('preserves a readers scroll position during refresh and Escape returns focus', async () => {
  dom = new JSDOM('<main></main><button></button>', { pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  let resolve!: (value: { events: [] }) => void;
  const load = vi.fn().mockResolvedValueOnce({ events: [] }).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const panel = createAgentPanel({ host, toggle, load, render: () => [document.createElement('article')], openMain: vi.fn(), working: () => false });
  const worker = { id: 'worker', title: 'Worker', updatedAt: 1 } as SessionSummary;
  panel.update('prime', [worker]); await panel.open(worker.id);
  const body = host.querySelector<HTMLElement>('.agent-panel-body')!;
  Object.defineProperties(body, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  body.scrollTop = 250;
  const article = body.querySelector('article');
  panel.update('prime', [{ ...worker, updatedAt: 2 }]);
  expect(body.querySelector('article')).toBe(article);
  resolve({ events: [] }); await Promise.resolve(); await Promise.resolve();
  expect(body.scrollTop).toBe(250);
  body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(host.querySelector('aside')!.hidden).toBe(true);
  expect(document.activeElement).toBe(toggle);
});

it('uses exact broker state instead of flickering recent-activity guesses', () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const states = new Map([['active-worker', 'active'], ['finished-worker', 'sleeping']]);
  const panel = createAgentPanel({
    host,
    toggle,
    load: async () => ({ events: [] }),
    render: () => [],
    openMain: vi.fn(),
    // Deliberately wrong timestamp projection: broker state must win for both workers.
    working: worker => worker.id === 'finished-session',
    agent: worker => ({ state: states.get(worker.origin?.agentId || '') as any, task: worker.title })
  });
  panel.update('prime', [
    { id: 'active-session', title: 'Active worker', updatedAt: 1, origin: { agentId: 'active-worker' } } as SessionSummary,
    { id: 'finished-session', title: 'Finished worker', updatedAt: 2, origin: { agentId: 'finished-worker' } } as SessionSummary
  ]);
  toggle.click();

  expect(host.textContent).toContain('Active · 1');
  expect(host.textContent).toContain('History · 1');
});

it('keeps a missing exact broker match unknown despite recent historical work', () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  let state: 'active' | 'sleeping' | 'finished' | null = null;
  const panel = createAgentPanel({ host, toggle, load: async () => ({ events: [] }), render: () => [],
    openMain: vi.fn(), working: () => true,
    agent: () => state ? { state, task: 'Current bounded assignment' } : null });
  const worker = { id: 'worker-unknown', title: 'Worker', updatedAt: 10 } as SessionSummary;
  panel.update('prime', [worker]); toggle.click();
  expect(host.textContent).toContain('Unknown · 1');
  expect(host.textContent).not.toContain('Active · 1');
  expect(host.querySelector('.agent-panel-row')?.getAttribute('type')).toBe('button');
  state = 'active'; panel.update('prime', [worker]);
  expect(host.textContent).toContain('Active · 1');
  expect(host.textContent).not.toContain('Unknown · 1');
  for (const settled of ['sleeping', 'finished'] as const) {
    state = settled; panel.update('prime', [worker]);
    expect(host.textContent).toContain('History · 1');
    expect(host.textContent).not.toContain('Active · 1');
  }
});

it('shows a recoverable unknown state after an initial worker history read rejects', async () => {
  dom = new JSDOM('<main></main><button></button>', { pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const openMain = vi.fn();
  const load = vi.fn().mockRejectedValueOnce(new Error('transient worker history read'))
    .mockResolvedValueOnce({ events: [] });
  const panel = createAgentPanel({ host, toggle, load, openMain, working: () => false,
    render: () => { const result = document.createElement('p'); result.textContent = 'Saved worker result'; return [result]; } });
  panel.update('prime', [{ id: 'worker-1', title: 'Worker one', updatedAt: 1 } as SessionSummary]);
  await expect(panel.open('worker-1')).resolves.toBeUndefined();
  const notice = host.querySelector<HTMLElement>('.agent-panel-read-notice')!;
  expect(notice.textContent).toContain('unavailable');
  expect(notice.textContent).toContain('unknown');
  expect(host.textContent).not.toContain('Saved worker result');
  const retry = notice.querySelector<HTMLButtonElement>('button')!;
  expect(retry.textContent).toContain('Retry');
  retry.focus();
  retry.click();
  await vi.waitFor(() => expect(host.textContent).toContain('Saved worker result'));
  expect(host.querySelector('.agent-panel-read-notice')).toBeNull();
  expect(document.activeElement?.textContent).toContain('Open full chat');
  expect(openMain).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(2);
});

it('retains a focused saved worker result when a later exact history read is unavailable', async () => {
  dom = new JSDOM('<main></main><button></button>', { pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const original: SessionEvent = { kind: 'assistant_message', source: 'extension',
    seq: 1, time: 1, messageId: 'saved-answer', final: true,
    message: { text: 'Previous verified worker result', chars: 31, truncated: false } };
  const updated: SessionEvent = { ...original, message: {
    text: 'Newly recovered worker result', chars: 29, truncated: false } };
  const load = vi.fn().mockResolvedValueOnce({ events: [original] }).mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ events: [updated] });
  const render = vi.fn((events: SessionEvent[]) => {
    const details = document.createElement('details');
    details.append(document.createElement('summary'), document.createElement('p'));
    details.querySelector('summary')!.textContent = 'Read saved result';
    details.querySelector('p')!.textContent =
      (events[0] as Extract<SessionEvent, { kind: 'assistant_message' }>).message.text;
    return [details];
  });
  const panel = createAgentPanel({ host, toggle, load, render, working: () => false, openMain: vi.fn() });
  const worker = { id: 'worker-1', title: 'Worker one', updatedAt: 1 } as SessionSummary;
  panel.update('prime', [worker]);
  await panel.open(worker.id);
  const body = host.querySelector<HTMLElement>('.agent-panel-body')!;
  const retained = body.querySelector<HTMLDetailsElement>('details')!;
  retained.open = true;
  retained.querySelector('summary')!.focus();
  body.scrollTop = 170;

  panel.update('prime', [{ ...worker, updatedAt: 2 }]);
  await vi.waitFor(() => expect(body.querySelector('.agent-panel-read-notice')).not.toBeNull());
  expect(body.querySelector('details')).toBe(retained);
  expect(retained.open).toBe(true);
  expect(document.activeElement).toBe(retained.querySelector('summary'));
  expect(body.scrollTop).toBe(170);
  expect(body.textContent).toContain('Previous verified worker result');
  expect(body.textContent).toContain('last confirmed');
  expect(body.textContent).toContain('newer');
  expect(render).toHaveBeenCalledTimes(1);

  body.querySelector<HTMLButtonElement>('.agent-panel-read-notice button')!.click();
  await vi.waitFor(() => expect(body.textContent).toContain('Newly recovered worker result'));
  expect(body.querySelector('.agent-panel-read-notice')).toBeNull();
  expect(render).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(3);
});

it('does not apply a late rejected read from a previous Prime to another worker', async () => {
  dom = new JSDOM('<main></main><button></button>', { pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  let rejectOld!: (reason: Error) => void;
  const oldRefresh = new Promise<{ events: [] }>((_resolve, reject) => { rejectOld = reject; });
  let olderReads = 0;
  const load = vi.fn((id: string) => id === 'worker-a' && ++olderReads === 2
    ? oldRefresh : Promise.resolve({ events: [] }));
  const panel = createAgentPanel({ host, toggle, load, openMain: vi.fn(), working: () => false,
    render: (_events, id) => {
      const result = document.createElement('p');
      result.textContent = id === 'worker-a' ? 'Retained result for first Prime' : 'Result for successor Prime';
      return [result];
    } });
  const first = { id: 'worker-a', title: 'First worker', updatedAt: 1 } as SessionSummary;
  const successor = { id: 'worker-b', title: 'Successor worker', updatedAt: 1 } as SessionSummary;
  panel.update('prime-a', [first]);
  await panel.open(first.id);
  panel.update('prime-a', [{ ...first, updatedAt: 2 }]);
  expect(load).toHaveBeenCalledTimes(2);
  panel.update('prime-b', [successor]);
  await panel.open(successor.id);
  rejectOld(new Error('Previous Prime history failed late'));
  await Promise.resolve();
  await Promise.resolve();
  const body = host.querySelector<HTMLElement>('.agent-panel-body')!;
  expect(body.textContent).toContain('Result for successor Prime');
  expect(body.textContent).not.toContain('Retained result for first Prime');
  expect(body.querySelector('.agent-panel-read-notice')).toBeNull();
});

it('keeps an opened and focused saved report mounted through a successful unchanged worker-history refresh', async () => {
  dom = new JSDOM('<main></main><button></button>', { pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const report: SessionEvent = { kind: 'agent_message', source: 'app', seq: 7, time: 700,
    messageId: 'saved-report-7', from: 'worker-1', to: 'prime', delivery: 'sent',
    message: { text: '[worker-1 reported] RESULT: Original worker result', chars: 50, truncated: false } };
  let events: SessionEvent[] = [report];
  const load = vi.fn(async () => ({ events: structuredClone(events) }));
  let renders = 0;
  const render = vi.fn((source: SessionEvent[]) => {
    renders++;
    const details = document.createElement('details');
    details.dataset.timelineKey = 'event:7';
    details.append(document.createElement('summary'), document.createElement('p'));
    details.querySelector('summary')!.textContent = 'Read worker report';
    details.querySelector('p')!.textContent =
      (source[0] as Extract<SessionEvent, { kind: 'agent_message' }>).message.text;
    return [details];
  });
  const panel = createAgentPanel({ host, toggle, load, render, working: () => false, openMain: vi.fn() });
  const worker = { id: 'worker-1', title: 'Worker one', updatedAt: 1 } as SessionSummary;
  panel.update('prime', [worker]);
  await panel.open(worker.id);
  const body = host.querySelector<HTMLElement>('.agent-panel-body')!;
  const original = body.querySelector<HTMLDetailsElement>('details')!;
  original.open = true;
  original.querySelector('summary')!.focus();
  body.scrollTop = 145;
  panel.update('prime', [{ ...worker, updatedAt: 2 }]);
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  expect(renders).toBe(1);
  expect(body.querySelector('details')).toBe(original);
  expect(original.open).toBe(true);
  expect(document.activeElement).toBe(original.querySelector('summary'));
  expect(body.scrollTop).toBe(145);

  // A same-sequence revised report is new semantic evidence, so it must repaint.
  events = [{ ...report, message: { text: '[worker-1 reported] RESULT: Revised verified output',
    chars: 52, truncated: false } }];
  panel.update('prime', [{ ...worker, updatedAt: 3 }]);
  await vi.waitFor(() => expect(body.textContent).toContain('Revised verified output'));
  expect(renders).toBe(2);
  expect(body.querySelector<HTMLDetailsElement>('details')?.open).toBe(true);
  expect(document.activeElement).toBe(body.querySelector('details > summary'));
  expect(body.textContent).not.toContain('Original worker result');
  expect(load).toHaveBeenCalledTimes(3);
});

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_FRESH_MS,
  APPROVAL_NOTICE_GRACE_MS,
  approvalCardWaiting,
  noteApprovalCard,
  resetApprovalWaits,
  type ApprovalWaitDeps
} from '../src/main/approval-wait.js';
import { APPROVAL_ANSWERED_TEXT, APPROVAL_WAITING_TEXT, approvalTextState } from '../src/shared/approval-wait.js';

describe('approval card episodes', () => {
  let deps: ApprovalWaitDeps & { rows: Array<[string, string, string, unknown]>; notices: string[] };

  beforeEach(() => {
    resetApprovalWaits();
    const rows: Array<[string, string, string, unknown]> = [];
    const notices: string[] = [];
    deps = {
      rows,
      notices,
      record: async (sessionId, progressId, text, anchor) => {
        rows.push([sessionId, progressId, text, anchor]);
        return anchor ?? { seq: 7, time: 1 };
      },
      notify: sessionId => { notices.push(sessionId); },
      log: () => undefined
    };
  });

  it('writes once, notices once after the grace, and rewrites the same row when answered', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000);
    expect(approvalCardWaiting('chat', 1_000)).toBe(true);
    expect(deps.rows).toEqual([['session', expect.stringMatching(/^approval-wait:chat:/), APPROVAL_WAITING_TEXT, undefined]]);
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS);
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS + 10_000);
    expect(deps.notices).toEqual(['session']);
    await noteApprovalCard('chat', false, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS + 20_000);
    expect(deps.rows[1]).toEqual(['session', deps.rows[0]![1], APPROVAL_ANSWERED_TEXT, { seq: 7, time: 1 }]);
  });

  it('stale page evidence stops holding recovery without claiming the approval was answered', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000);
    expect(approvalCardWaiting('chat', 1_000 + APPROVAL_FRESH_MS - 1)).toBe(true);
    expect(approvalCardWaiting('chat', 1_000 + APPROVAL_FRESH_MS)).toBe(false);
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_FRESH_MS + 5_000);
    expect(deps.rows.map(row => row[2])).toEqual([APPROVAL_WAITING_TEXT, APPROVAL_WAITING_TEXT]);
  });

  it('keeps a new episode while an older row is still being written', async () => {
    let finish!: (anchor: { seq: number; time: number }) => void;
    const pending = new Promise<{ seq: number; time: number }>(resolve => { finish = resolve; });
    const record = deps.record;
    deps.record = vi.fn().mockImplementationOnce(() => pending).mockImplementation(record);
    await noteApprovalCard('chat', true, 'session', deps, 1000);
    const clearing = noteApprovalCard('chat', false, 'session', deps, 1001);
    await noteApprovalCard('chat', true, 'session', deps, 1001);
    finish({ seq: 3, time: 1000 });
    await clearing;
    expect(approvalCardWaiting('chat', 1002)).toBe(true);
    expect(deps.record).toHaveBeenCalledTimes(3);
    const ids = vi.mocked(deps.record).mock.calls.map(call => call[1]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe(ids[0]);
  });

  it('does not clear fresher evidence or hold it across a backwards clock', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 2000);
    await noteApprovalCard('chat', false, 'session', deps, 1999);
    expect(approvalCardWaiting('chat', 2001)).toBe(true);
    expect(approvalCardWaiting('chat', 1999)).toBe(false);
    expect(deps.rows).toHaveLength(1);
  });

  it.each(['throw', 'reject', 'null'] as const)('retains the wait when recording returns %s', async mode => {
    deps.record = vi.fn(() => {
      if (mode === 'throw') throw new Error('private storage path');
      return mode === 'reject' ? Promise.reject(new Error('private storage path')) : Promise.resolve(null);
    });
    deps.log = vi.fn();
    await expect(noteApprovalCard('chat', true, 'session', deps, 1000)).resolves.toBeUndefined();
    await Promise.resolve();
    expect(approvalCardWaiting('chat', 1001)).toBe(true);
    await expect(noteApprovalCard('chat', false, 'session', deps, 1002)).resolves.toBeUndefined();
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toContain('private storage path');
  });

  it('does not publish an answered row after a reset during a pending write', async () => {
    let finish!: (anchor: { seq: number; time: number }) => void;
    deps.record = vi.fn(() => new Promise<{ seq: number; time: number }>(resolve => { finish = resolve; }));
    await noteApprovalCard('chat', true, 'session', deps, 1000);
    const clearing = noteApprovalCard('chat', false, 'session', deps, 1001);
    resetApprovalWaits();
    finish({ seq: 1, time: 1000 });
    await clearing;
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(approvalCardWaiting('chat', 1002)).toBe(false);
  });

  it('isolates conversations, attaches a late session, and tolerates failed notifications/logging', async () => {
    deps.notify = vi.fn(() => { throw new Error('notification failed'); });
    deps.log = () => { throw new Error('log failed'); };
    await noteApprovalCard('a', true, null, deps, 1000);
    await noteApprovalCard('b', true, 'b-session', deps, 1000);
    await noteApprovalCard('a', true, 'a-session', deps, 1000 + APPROVAL_NOTICE_GRACE_MS);
    await noteApprovalCard('a', false, 'a-session', deps, 1001 + APPROVAL_NOTICE_GRACE_MS);
    expect(approvalCardWaiting('a', 1002 + APPROVAL_NOTICE_GRACE_MS)).toBe(false);
    expect(approvalCardWaiting('b', 1002 + APPROVAL_NOTICE_GRACE_MS)).toBe(true);
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });
});

it('recognizes retained approval history without rewriting its original text', () => {
  expect(approvalTextState(APPROVAL_WAITING_TEXT)).toBe('waiting');
  expect(approvalTextState(APPROVAL_ANSWERED_TEXT)).toBe('answered');
  expect(approvalTextState('ChatGPT is waiting for you to allow or deny a tool call in this chat. Nothing continues until you answer it there.')).toBe('waiting');
  expect(approvalTextState('The tool approval ChatGPT asked for in this chat was answered.')).toBe('answered');
  expect(approvalTextState('Arbitrary approval prose')).toBeNull();
});

describe('approval page detector', () => {
  const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
  let dom: JSDOM;
  let api: {
    approvalWaiting(): boolean;
    autoApproveIfNeeded(current?: () => boolean): number;
    approvalMutationRelevant(node: Node): boolean;
  };
  const current = () => true;
  const cardHtml = (buttons = '<button>Deny</button><button>Allow once</button>') =>
    `<div data-codex-approval-surface="true">${buttons}</div>`;
  const mount = (html: string) => { dom.window.document.querySelector('main')!.innerHTML = html; };

  beforeEach(() => {
    dom = new JSDOM('<main></main>', { url: 'https://chatgpt.com/c/chat', runScripts: 'outside-only', pretendToBeVisual: true });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
      value(this: HTMLElement) { return this.closest('[hidden]') ? [] : [{ width: 10, height: 10 }]; }
    });
    dom.window.eval(source);
    api = (dom.window as unknown as { CLF_DOM: typeof api }).CLF_DOM;
    vi.spyOn(dom.window.console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => { dom.window.close(); vi.restoreAllMocks(); });

  it('recognizes the provider approval surface without depending on its language', () => {
    expect(api.approvalWaiting()).toBe(false);
    dom.window.document.querySelector('main')!.innerHTML =
      '<div data-codex-approval-surface="true"><p>Werkzeug erlauben?</p><button>Ablehnen</button><button>Einmal zulassen</button></div>';
    expect(api.approvalWaiting()).toBe(true);
  });

  it('holds disabled/loading approval surfaces and ignores hidden ones', () => {
    const main = dom.window.document.querySelector('main')!;
    main.innerHTML = '<div data-codex-approval-surface="true"><button disabled>Deny</button><button disabled>Allow once</button></div>';
    expect(api.approvalWaiting()).toBe(true);
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    main.innerHTML = '<div hidden><div data-codex-approval-surface="true"><button>Allow</button></div></div>';
    expect(api.approvalWaiting()).toBe(false);
  });

  it('keeps status reads passive and requires an elected caller to click', () => {
    mount(cardHtml());
    const click = vi.spyOn(dom.window.document.querySelectorAll('button')[1]!, 'click');
    expect(api.approvalWaiting()).toBe(true);
    expect(api.autoApproveIfNeeded()).toBe(0);
    expect(api.autoApproveIfNeeded(() => false)).toBe(0);
    expect(click).not.toHaveBeenCalled();
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    expect(click).toHaveBeenCalledTimes(1);
    // Dispatch alone cannot release a continuation hold.
    expect(api.approvalWaiting()).toBe(true);
  });

  it.each(['Einmal zulassen', 'Autoriser une fois', 'Permitir una vez', 'Permitir uma vez',
    'Consenti una volta', '一度だけ許可', '允许一次', '한 번 허용'])('selects the exact localized action: %s', label => {
    mount(cardHtml(`<button>Deny</button><button>${label}</button>`));
    const buttons = dom.window.document.querySelectorAll('button');
    const deny = vi.spyOn(buttons[0]!, 'click');
    const allow = vi.spyOn(buttons[1]!, 'click');
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    expect(allow).toHaveBeenCalledTimes(1);
    expect(deny).not.toHaveBeenCalled();
  });

  it.each(['<kbd>↵</kbd>', '<span aria-hidden="true">↵</span>', '<span hidden>Loading</span>'])(
    'recognizes the native once action with a separate keyboard/hidden hint: %s', hint => {
      mount(cardHtml(`<button>Deny<kbd>Esc</kbd></button><button>Allow once${hint}</button>`));
      const buttons = dom.window.document.querySelectorAll('button');
      const deny = vi.spyOn(buttons[0]!, 'click');
      const allow = vi.spyOn(buttons[1]!, 'click');
      const original = buttons[1]!.innerHTML;
      expect(api.autoApproveIfNeeded(current)).toBe(1);
      expect(allow).toHaveBeenCalledTimes(1);
      expect(deny).not.toHaveBeenCalled();
      expect(buttons[1]!.innerHTML).toBe(original);
    }
  );

  it('uses accessible label text without its separate keyboard hint', () => {
    mount('<span id="once-label">Allow once<kbd aria-hidden="true">Enter</kbd></span>' +
      cardHtml('<button aria-labelledby="once-label">Continue</button>'));
    const allow = vi.spyOn(dom.window.document.querySelector('button')!, 'click');
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    expect(allow).toHaveBeenCalledTimes(1);
  });

  it.each(['<button>Always allow</button>', '<button>Do not allow</button>', '<button>Allow for this conversation</button>',
    '<button data-action="allow-once">Allow Core for this conversation</button>',
    '<button>Disallow</button>', '<button>Deny</button>', '<button>Unknown translation</button>',
    '<button>Allow</button><button>Allow once</button>', '<button data-action="deny">Allow once</button>'])
  ('leaves ambiguous, persistent or unknown actions pending: %s', buttons => {
    mount(cardHtml(buttons));
    const click = vi.spyOn(dom.window.HTMLElement.prototype, 'click');
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    expect(click).not.toHaveBeenCalled();
    expect(api.approvalWaiting()).toBe(true);
  });

  it.each(['data-approval-action="allow-once"', 'data-action="approve-once"', 'data-testid="allow-once-button"'])
  ('accepts an explicit one-time machine action in any language: %s', attribute => {
    mount(`<div data-testid="mcp-approval-card"><span role="button" ${attribute}>موافقة</span></div>`);
    expect(api.autoApproveIfNeeded(current)).toBe(1);
  });

  it.each(['hidden', 'inert', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"',
    'style="opacity:0"', 'class="clf-stage"', 'class="markdown"', 'contenteditable="true"',
    'data-message-author-role="user"', 'data-content-search-unit-key="0:user"'])
  ('ignores non-native or hidden ancestors: %s', attribute => {
    mount(`<div ${attribute}>${cardHtml()}</div>`);
    expect(api.approvalWaiting()).toBe(false);
    expect(api.autoApproveIfNeeded(current)).toBe(0);
  });

  it('does not treat arbitrary Allow buttons or generic dialogs as native cards', () => {
    mount('<div role="dialog"><button>Allow</button></div>');
    expect(api.approvalWaiting()).toBe(false);
    expect(api.autoApproveIfNeeded(current)).toBe(0);
  });

  it('processes multiple cards and isolates inspection/click failures', () => {
    mount(cardHtml() + cardHtml() + cardHtml());
    const cards = dom.window.document.querySelectorAll('[data-codex-approval-surface]');
    vi.spyOn(cards[0]!, 'querySelectorAll').mockImplementation(() => { throw new Error('private query'); });
    const buttons = dom.window.document.querySelectorAll('button');
    vi.spyOn(buttons[3]!, 'click').mockImplementation(() => { throw new Error('private click'); });
    const last = vi.spyOn(buttons[5]!, 'click');
    expect(api.autoApproveIfNeeded(current)).toBe(2);
    expect(last).toHaveBeenCalledTimes(1);
    expect(api.approvalWaiting()).toBe(true);
    expect(JSON.stringify(vi.mocked(dom.window.console.warn).mock.calls)).not.toContain('private');
  });

  it('waits for controls to mount and become enabled without spending attempts', () => {
    mount(cardHtml(''));
    expect(api.approvalWaiting()).toBe(true);
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    const card = dom.window.document.querySelector('[data-codex-approval-surface]')!;
    card.innerHTML = '<button aria-disabled="true">Allow once</button>';
    const button = card.querySelector('button')!;
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    expect(api.approvalMutationRelevant(button)).toBe(true);
    button.removeAttribute('aria-disabled');
    button.addEventListener('click', () => card.remove());
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    expect(api.approvalWaiting()).toBe(false);
  });

  it.each(['<fieldset disabled><button>Allow once</button></fieldset>',
    '<div aria-disabled="true"><button>Allow once</button></div>',
    '<span role="button" disabled>Allow once</span>', '<div aria-busy="true"><button>Allow once</button></div>'])
  ('holds inherited disabled/busy controls: %s', buttons => {
    mount(cardHtml(buttons));
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    expect(api.approvalWaiting()).toBe(true);
  });

  it('replenishes the same card only after an explicit provider resolution', () => {
    mount(cardHtml());
    const card = dom.window.document.querySelector('[data-codex-approval-surface]')!;
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    card.setAttribute('data-state', 'resolved');
    expect(api.approvalWaiting()).toBe(false);
    card.setAttribute('data-state', 'pending');
    expect(api.autoApproveIfNeeded(current)).toBe(1);
  });

  it('bounds retries for intercepted clicks, including across adapter reinjection and re-entry', () => {
    let now = 1000;
    vi.spyOn(dom.window.Date, 'now').mockImplementation(() => now);
    mount(cardHtml());
    const button = dom.window.document.querySelectorAll('button')[1]!;
    const click = vi.spyOn(button, 'click').mockImplementation(() => {
      expect(api.autoApproveIfNeeded(current)).toBe(0);
    });
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    now += 1500;
    dom.window.eval(source);
    api = (dom.window as unknown as { CLF_DOM: typeof api }).CLF_DOM;
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    now += 2999;
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    now++;
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    now += 60_000;
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    expect(click).toHaveBeenCalledTimes(3);
    expect(api.approvalWaiting()).toBe(true);
  });

  it('does not click through an overlay, then allows the same control when unobstructed', () => {
    mount(cardHtml() + '<div id="overlay"></div>');
    const button = dom.window.document.querySelectorAll('button')[1]!;
    const hit = vi.fn(() => dom.window.document.getElementById('overlay'));
    Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, value: hit });
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    hit.mockReturnValue(button);
    expect(api.autoApproveIfNeeded(current)).toBe(1);
  });

  it('keeps a logical native request budget across React card replacement', () => {
    let now = 1000;
    vi.spyOn(dom.window.Date, 'now').mockImplementation(() => now);
    for (let attempt = 0; attempt < 4; attempt++) {
      mount('<div data-codex-approval-surface="true" data-request-id="same-native-request"><button>Allow once</button></div>');
      expect(api.autoApproveIfNeeded(current)).toBe(attempt < 3 ? 1 : 0);
      now += 10_000;
    }
    expect(api.approvalWaiting()).toBe(true);
    expect(dom.window.console.warn).toHaveBeenCalledWith(expect.stringContaining('retry limit reached'));
  });

  it('does not click conflicting machine actions', () => {
    mount(cardHtml('<button data-approval-action="allow-once" data-action="deny">Allow once</button>'));
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    mount(cardHtml('<button data-testid="allow-once-button" aria-label="Always allow">Allow once</button>'));
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    mount(cardHtml('<button data-testid="deny-button">Allow once</button>'));
    expect(api.autoApproveIfNeeded(current)).toBe(0);
  });

  it('bounds anonymous remount storms without losing subsequent cards', () => {
    let now = 1000;
    vi.spyOn(dom.window.Date, 'now').mockImplementation(() => now);
    for (let index = 0; index < 16; index++) {
      mount(cardHtml());
      expect(api.autoApproveIfNeeded(current)).toBe(1);
    }
    mount(cardHtml());
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    expect(api.approvalWaiting()).toBe(true);
    now += 1000;
    expect(api.autoApproveIfNeeded(current)).toBe(1);
  });

  it('does not revive a resolved request identity through a stale remount', () => {
    mount('<div data-codex-approval-surface="true" data-request-id="resolved-request"><button>Allow once</button></div>');
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    dom.window.document.querySelector('[data-request-id]')!.setAttribute('data-state', 'resolved');
    expect(api.approvalWaiting()).toBe(false);
    mount('<div data-codex-approval-surface="true" data-request-id="resolved-request"><button>Allow once</button></div>');
    expect(api.autoApproveIfNeeded(current)).toBe(0);
  });

  it('uses aria-labelledby before visible text and rejects broken accessible names', () => {
    mount(cardHtml('<span id="decision">Always allow</span><button aria-labelledby="decision">Allow once</button>'));
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    dom.window.document.getElementById('decision')!.textContent = 'Allow once';
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    mount(cardHtml('<button aria-labelledby="missing">Allow once</button>'));
    expect(api.autoApproveIfNeeded(current)).toBe(0);
  });

  it('continues healthy cards while preserving an unknown sibling wait', () => {
    mount(cardHtml() + cardHtml());
    const cards = dom.window.document.querySelectorAll('[data-codex-approval-surface]');
    vi.spyOn(cards[0]!, 'getClientRects').mockImplementation(() => { throw new Error('private layout error'); });
    const button = cards[1]!.querySelectorAll('button')[1]!;
    button.addEventListener('click', () => cards[1]!.remove());
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    expect(api.approvalWaiting()).toBe(true);
  });

  it('rechecks ownership and navigation between cards', () => {
    mount(cardHtml() + cardHtml());
    const buttons = dom.window.document.querySelectorAll('button');
    buttons[1]!.addEventListener('click', () => dom.window.history.pushState(null, '', '/c/other'));
    const next = vi.spyOn(buttons[3]!, 'click');
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    expect(next).not.toHaveBeenCalled();
    // A subsequent observer tick on the new route cannot approve the retained old card.
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    expect(next).not.toHaveBeenCalled();
  });

  it('binds a loading card to its original route before its button is available', () => {
    mount(cardHtml('<button disabled>Allow once</button>'));
    expect(api.approvalWaiting()).toBe(true);
    dom.window.history.pushState(null, '', '/c/other');
    dom.window.document.querySelector('button')!.disabled = false;
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    expect(api.approvalWaiting()).toBe(true);
  });

  it('skips a second card removed during the first dispatch', () => {
    mount(cardHtml() + cardHtml());
    const buttons = dom.window.document.querySelectorAll('button');
    buttons[1]!.addEventListener('click', () => buttons[3]!.parentElement!.remove());
    const next = vi.spyOn(buttons[3]!, 'click');
    expect(api.autoApproveIfNeeded(current)).toBe(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('logs scan failures once and preserves an unknown wait instead of crashing', () => {
    vi.spyOn(dom.window.document, 'querySelectorAll').mockImplementation(() => { throw new Error('private content'); });
    expect(api.approvalWaiting()).toBe(true);
    expect(api.approvalWaiting()).toBe(true);
    expect(api.autoApproveIfNeeded(current)).toBe(0);
    expect(dom.window.console.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(dom.window.console.warn).mock.calls)).not.toContain('private content');
  });
});

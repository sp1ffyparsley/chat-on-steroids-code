import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_PROMPT_QUESTIONS, OPERATOR_PROMPT_FOOTER, prepareOperatorPrompt } from '../src/shared/operator-prompt.mjs';

const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
// Real transport fixtures exercise the mandatory envelope, including generic click/receipt tests.
const preparedPrompt = (text: string) => prepareOperatorPrompt(text, upper => upper - 1);
interface DomApi {
  promptEnvelopeReady(): boolean;
  promptEnvelopeProtocol(): number;
  operatorPromptBody(value: string): string;
  promptEnvelopeValid(value: string): boolean;
  preparePromptEnvelope(value: string): string;
  conversationLoadRetryControl(): HTMLButtonElement | null;
  composer(): HTMLElement | null;
  composerText(box?: Element | null): string;
  composerDiagnostics(): { host: string; writable: boolean; draft: boolean; attachments: boolean; send: string };
  authenticationState(): 'signed-in' | 'signed-out' | 'unknown';
  emptyComposerForClose(deletedConversationId?: string | null): boolean;
  insertPrompt(text: string, mode?: boolean | 'append', failure?: (reason: string) => void): boolean;
  setTabStatus(mode: string | null, activity?: string): void;
  conversationTitle(): string;
  enterProject(entry: { id: string; sourceConversationId: string }, current?: () => boolean): Promise<boolean>;
  composerActions(): { host: HTMLElement; before: HTMLElement | null } | null;
  messages(): Array<{ text: string }>;
  generating(): boolean;
  noteStopClick(target: Node): boolean;
  clearStoppedTurn(): void;
  retryLatestTransportFailure(current?: () => boolean, beforeRetry?: () => boolean): { status: string; reason?: string };
  sendButton(): HTMLButtonElement | null;
  temporaryChatReady(): boolean;
  confirmTemporaryChatIntroduction(): void;
  workModeInterstitial(): HTMLElement | null;
  errors(): Array<{ text: string; recoverable: boolean; blocking?: boolean; reason?: string; node: HTMLElement; retry?: HTMLButtonElement }>;
  accessNoticeSince(since: number): string;
  captureComposerDraft(text: string, current?: () => boolean, withdrawalCurrent?: () => boolean): { current(): boolean; clear(): Promise<boolean>; rebind(): boolean; withdraw(): boolean; dispose(): void; attachments(nodes: Element[]): void };
  visibleModelSelection(): { model: string; reasoningEffort?: string } | null;
  hasComposerAttachments(): boolean;
  connectorMentionIdentity(connectorName: string): { appId: string } | null;
  nativeConnectorMentionIdentity(): { appId: string; connectorName: string } | null;
  connectorMentionSelected(connectorName: string, appId: string): boolean;
  composerAuthoredText(connectorName: string, appId: string): string | null;
  insertPromptWithConnector(text: string, connectorName: string, appId: string, failure?: (reason: string) => void): boolean;
  connectorMenuOption(connectorName: string): HTMLButtonElement | null;
  connectorMenuOptionReader(connectorName: string): () => HTMLButtonElement | null;
  selectConnectorMenuOption(option: HTMLButtonElement, connectorName: string, appId: string):
    { read(): { appId: string; connectorName: string } | null; dispose(): void } | null;
  openConnectorMenu(connectorName: string): boolean;
  stopGeneration(current: () => boolean): boolean;
  inspectModelSettings(current?: () => boolean, failure?: (reason: string) => void): Promise<Array<{id: string; label: string; efforts: string[]}> | null>;
  send(options?: { acceptanceTimeoutMs?: number; stillCurrent?: () => boolean; beforeSend?: () => Promise<boolean>;
    onNativeClickAttempt?: () => void;
    submittedText?: string; readDraftText?: () => string; matchesDraft?: (actual: string, expected: string) => boolean;
    explain?: (reason: string) => void }): Promise<boolean>;
  selectModelSettings(model: string | null, effort: string | null, current?: () => boolean): Promise<boolean>;
  nextCooldownSelection(selection: { model: string; reasoningEffort: string }, models: Array<{ id: string; label: string; efforts: string[]; aliases?: string[] }>): { model: string; effort: string } | null;
  ensurePreferredAutomationModel(current?: () => boolean, requested?: { model: string; reasoningEffort: string }): Promise<{ status: string; reason?: string; model?: string; effort?: string; changed?: boolean }>;
  recoverModelCooldown(error: ReturnType<DomApi['errors']>[number], current?: () => boolean): Promise<{ status: string; reason?: string; model?: string; fromModel?: string; from?: string; to?: string }>;
  resubmitExactResumeMessage(options: { messageId: string; token: string; expectedText: string; stillCurrent?: () => boolean; beforeResubmit?: () => boolean }): Promise<{ status: string; reason?: string }>;
  uploadImages(images: Array<{ name: string; dataUrl: string }>, current?: () => boolean, draft?: ReturnType<DomApi['captureComposerDraft']>, files?: File[]): Promise<boolean>;
}
let dom: JSDOM;
let document: Document;
let api: DomApi;
let box: HTMLElement;
let button: HTMLButtonElement;
beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<form><div id="prompt-textarea" contenteditable="true">Exact app prompt</div><div data-testid="composer-trailing-actions"><button type="button" aria-haspopup="menu">Medium</button><button type="button" data-testid="send-button">Send</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  document = dom.window.document;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{ width: 10, height: 10 }]; } });
  dom.window.eval(source);
  api = (dom.window as unknown as { CLF_DOM: DomApi }).CLF_DOM;
  box = document.getElementById('prompt-textarea')!;
  button = document.querySelector('[data-testid="send-button"]')!;
});
afterEach(() => { dom.window.close(); vi.useRealTimers(); });
function user(text: string) {
  const section = document.createElement('section');
  section.setAttribute('data-testid', 'conversation-turn-1');
  section.setAttribute('data-turn', 'user');
  section.setAttribute('data-turn-id', 'turn-one');
  const message = document.createElement('div');
  message.setAttribute('data-message-id', 'message-one');
  message.setAttribute('data-message-author-role', 'user');
  message.textContent = text;
  section.append(message); document.body.append(section);
}

describe('mandatory CoS envelope at the native click boundary', () => {
  it.each([1, 2])('accepts a reserved %i-question wrapper only with its unchanged actual native draft', async count => {
    const questions = [
      'What is the most useful next step for this task given the verified context, and what evidence will show that it worked?',
      'Which existing implementation and verified results should be reused to avoid duplicate work while preserving the full task requirements?'
    ];
    const valid = `[[COS_OPERATOR_QUESTIONS:${count}]] ${questions.slice(0, count).join(' ')}\nExact task\n${OPERATOR_PROMPT_FOOTER}`;
    box.textContent = valid;
    const click = vi.fn(() => user(valid)); button.addEventListener('click', click);
    expect(api.operatorPromptBody(valid)).toBe('Exact task');
    expect(await api.send({ submittedText: valid })).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    box.textContent = valid;
    expect(await api.send({ submittedText: valid,
      beforeSend: async () => { box.textContent = valid.replace(`QUESTIONS:${count}`, 'QUESTIONS:3'); return true; } })).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('generates one task-relevant voice question without randomness and preserves legacy frozen text', () => {
    const random = vi.spyOn(dom.window.crypto, 'getRandomValues');
    const generated = api.preparePromptEnvelope('Exact voice task');
    expect(generated.split('\n')[0]).toBe('[[COS_OPERATOR_QUESTIONS:1]] What is the most useful next step for this task given the verified context, and what evidence will show that it worked?');
    expect(random).not.toHaveBeenCalled();
    const legacy = `${OPERATOR_PROMPT_QUESTIONS.slice(0, 10).join(', ')}.\nExact old voice task\n${OPERATOR_PROMPT_FOOTER}`;
    expect(api.preparePromptEnvelope(legacy)).toBe(legacy);
  });

  it('sends a frozen legacy envelope unchanged and refuses replacing its header at the native boundary', async () => {
    const legacy = `${OPERATOR_PROMPT_QUESTIONS.slice(0, 10).join(', ')}.\nRetained exact task\n${OPERATOR_PROMPT_FOOTER}`;
    box.textContent = legacy;
    const click = vi.fn(() => user(legacy)); button.addEventListener('click', click);
    expect(await api.send({ submittedText: legacy })).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    box.textContent = legacy;
    expect(await api.send({ submittedText: legacy,
      beforeSend: async () => { box.textContent = preparedPrompt('Retained exact task'); return true; } })).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
  });
  it('cannot disable the envelope through a legacy caller option', async () => {
    box.textContent = 'Task';
    const click = vi.fn(() => user('Task')); button.addEventListener('click', click);
    const authorize = vi.fn(async () => true);
    const legacyCaller = { requirePromptEnvelope: false, beforeSend: authorize };
    expect(await api.send(legacyCaller)).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('checks the wrapper contract without generating randomness or sending', () => {
    const random = vi.spyOn(dom.window.crypto, 'getRandomValues');
    const click = vi.fn(); button.addEventListener('click', click);
    expect(api.promptEnvelopeReady()).toBe(true);
    expect(api.promptEnvelopeProtocol()).toBe(2);
    expect(random).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(box.textContent).toBe('Exact app prompt');
  });

  it('freezes local voice text once without changing authored content', () => {
    const body = 'Preserve my nickname and this exact transcription.';
    const prepared = api.preparePromptEnvelope(body);
    expect(api.promptEnvelopeValid(prepared)).toBe(true);
    expect(api.operatorPromptBody(prepared)).toBe(body);
    expect(api.preparePromptEnvelope(prepared)).toBe(prepared);
    expect(() => api.preparePromptEnvelope('   ')).toThrow(/empty/);
  });
  it('keeps the standalone browser vocabulary synchronized with Main', () => {
    for (let offset = 0; offset < OPERATOR_PROMPT_QUESTIONS.length; offset++) {
      const pool = [...OPERATOR_PROMPT_QUESTIONS.slice(offset), ...OPERATOR_PROMPT_QUESTIONS.slice(0, offset)];
      const prepared = `${pool.slice(0, 10).join(', ')}.\nTask\n${OPERATOR_PROMPT_FOOTER}`;
      expect(api.operatorPromptBody(prepared)).toBe('Task');
      expect(api.promptEnvelopeValid(prepared)).toBe(true);
    }
  });

  it('blocks missing, damaged and nested envelopes before authorization or click', async () => {
    const valid = prepareOperatorPrompt('Task', upper => upper - 1);
    const authorize = vi.fn(async () => true);
    const click = vi.fn(); button.addEventListener('click', click);
    for (const invalid of ['Task', valid + '\nExtra text', valid.replace(OPERATOR_PROMPT_FOOTER, 'wrong footer'),
      valid.replace('\nTask\n', `\n${valid}\n`),
      valid.replace('\nTask\n', `\n${valid.split('\n')[0]}\nTask\n`)]) {
      box.textContent = invalid;
      const explain = vi.fn();
      expect(await api.send({ beforeSend: authorize, explain })).toBe(false);
      expect(explain).toHaveBeenCalledWith('prompt-envelope-missing');
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('sends the complete validated bytes once and refuses an async draft replacement', async () => {
    const valid = prepareOperatorPrompt('Task', upper => upper - 1);
    box.textContent = valid;
    const click = vi.fn(() => user(valid)); button.addEventListener('click', click);
    expect(await api.send({ submittedText: valid })).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    box.textContent = valid;
    expect(await api.send({ submittedText: valid,
      beforeSend: async () => { box.textContent = 'Task'; return true; } })).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('cannot waive a damaged actual envelope through a caller draft comparator', async () => {
    const valid = prepareOperatorPrompt('Task', upper => upper - 1);
    const authorize = vi.fn(async () => true);
    const click = vi.fn(); button.addEventListener('click', click);
    box.textContent = 'Task';
    expect(await api.send({ submittedText: valid,
      matchesDraft: () => true, beforeSend: authorize })).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
});

function keptPage(shown = false) {
  const page = document.createElement('div');
  page.setAttribute('data-app-shell-page-surface', 'true');
  if (!shown) page.style.display = 'none';
  document.body.prepend(page);
  return page;
}


/**
 * #1792: ChatGPT turns a pasted URL into a rich-link preview and puts the preview's own <style> inside
 * the editor. Its CSS is part of `textContent` but not of the prompt, so an untouched prompt read as
 * changed: Compact & Resume never sent its handoff ("ChatGPT replaced the composer while inserting the
 * bootstrap"), and a lease on any prompt with a link was lost.
 */
describe('a rich-link preview inside the editor (#1792)', () => {
  const css = '@supports (display:grid){.link-card{display:grid}}@media (min-width:600px){.link-card{gap:8px}}';
  const enrich = () => {
    const card = document.createElement('span');
    card.className = 'link-card';
    const style = document.createElement('style');
    style.textContent = css;
    card.append(style);
    box.append(card);
  };

  it('reads the prompt without the preview stylesheet', () => {
    enrich();
    expect(box.textContent).toContain('@supports');
    expect(api.composerText()).toBe('Exact app prompt');
    expect(api.composerText(box)).toBe('Exact app prompt');
  });

  it('reads nothing from a stylesheet that is itself a direct child of the editor', () => {
    const style = document.createElement('style');
    style.textContent = css;
    box.append(style);
    expect(api.composerText(style)).toBe('');
    expect(api.composerText()).toBe('Exact app prompt');
  });

  it('keeps the lease on an untouched prompt when ChatGPT adds a preview', () => {
    const draft = api.captureComposerDraft('Exact app prompt');
    enrich();
    expect(draft.current()).toBe(true);
  });

  it('still notices a real edit next to a preview', () => {
    const draft = api.captureComposerDraft('Exact app prompt');
    enrich();
    box.append(document.createTextNode(' and more'));
    expect(draft.current()).toBe(false);
  });

  it('keeps literal style text that the prompt itself contains', () => {
    box.textContent = 'Explain <style> tags';
    expect(api.composerText()).toBe('Explain <style> tags');
  });

  it('sends a prompt whose link became a preview while Send waited', async () => {
    box.textContent = preparedPrompt('Exact app prompt');
    const sends = vi.fn(() => { box.textContent = ''; });
    button.addEventListener('click', sends);
    const sent = api.send({ acceptanceTimeoutMs: 1000, beforeSend: async () => { enrich(); return true; } });
    await vi.advanceTimersByTimeAsync(50);
    expect(await sent).toBe(true);
    expect(sends).toHaveBeenCalledTimes(1);
  });
});

describe('pending conversation load recovery', () => {
  it.each(['empty', 'draft', 'ordinary', 'ambiguous'] as const)('recognizes only the exact idle failed-load shell: %s', state => {
    dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    document.body.innerHTML = '<aside>Unable to load history<button>Retry</button></aside><main><form><textarea id="pending-conversation-input"></textarea><button disabled>Add files and more</button><button disabled>Send</button></form><div><p>Could not load this ChatGPT conversation</p><button id="retry">Retry</button></div></main>';
    const pending = document.querySelector('textarea')!;
    if (state === 'draft') pending.value = 'Saved handoff';
    if (state === 'ordinary') pending.id = 'ordinary-editor';
    if (state === 'ambiguous') document.querySelector('main')!.append(document.createElement('button'));
    expect(api.conversationLoadRetryControl()).toBe(state === 'empty' ? document.getElementById('retry') : null);
    if (state === 'empty' || state === 'draft') {
      const clicked = vi.fn();
      document.getElementById('retry')!.addEventListener('click', clicked);
      const result = api.retryLatestTransportFailure();
      expect(result.status).toBe(state === 'empty' ? 'retried' : 'stopped');
      expect(clicked).toHaveBeenCalledTimes(state === 'empty' ? 1 : 0);
    }
  });
});

describe('native tab status projection', () => {
  it('repairs provider head icon replacement and disconnects on cleanup', async () => {
    document.title = 'Live task';
    api.setTabStatus('loop', 'waiting');
    document.head.querySelector('link[rel="icon"]')!.remove();
    const replacement = document.createElement('link');
    replacement.rel = 'icon'; replacement.href = '/provider.png';
    document.head.append(replacement);
    await Promise.resolve();
    expect(replacement.getAttribute('href')).toMatch(/^data:image\/svg\+xml,/);
    replacement.href = '/provider-new.png';
    await Promise.resolve();
    expect(replacement.getAttribute('href')).toMatch(/^data:image\/svg\+xml,/);
    api.setTabStatus(null);
    await Promise.resolve();
    expect(replacement.getAttribute('href')).toBe('/provider-new.png');
    expect(document.title).toBe('Live task');
  });
  it.each([['goal', 'Goal'], ['loop', 'Loop'], ['worker', 'Worker'], ['chat', 'Chat'], ['one-off', 'One-off'], ['error', 'Attention']])('projects %s without changing the recorded title', (mode, label) => {
    document.title = 'Creative work';
    const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = '/native.png'; icon.type = 'image/png'; document.head.append(icon);
    api.setTabStatus(mode);
    expect(document.title).toBe(`CoS ${label} · Creative work`);
    expect(api.conversationTitle()).toBe('Creative work');
    expect(icon.href).toContain('data:image/svg+xml,');
    api.setTabStatus(mode);
    expect(document.title).toBe(`CoS ${label} · Creative work`);
    api.setTabStatus(null);
    expect(document.title).toBe('Creative work');
    expect(icon.getAttribute('href')).toBe('/native.png');
    expect(icon.type).toBe('image/png');
  });
  it('distinguishes active automation from an enabled chat waiting for its next useful turn', () => {
    document.title = 'Long repair';
    api.setTabStatus('loop', 'working');
    expect(document.title).toBe('CoS Loop · Working · Long repair');
    const workingIcon = document.head.querySelector('link[rel="icon"]')!.getAttribute('href');
    api.setTabStatus('loop', 'waiting');
    expect(document.title).toBe('CoS Loop · Waiting · Long repair');
    const waitingIcon = document.head.querySelector('link[rel="icon"]')!.getAttribute('href');
    expect(waitingIcon).not.toBe(workingIcon);
    api.setTabStatus(null);
    expect(document.title).toBe('Long repair');
  });
  it('preserves provider changes and removes its fallback icon on cleanup', () => {
    document.title = 'First'; api.setTabStatus('loop');
    expect(document.head.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
    document.title = 'Renamed by ChatGPT'; api.setTabStatus('goal');
    expect(api.conversationTitle()).toBe('Renamed by ChatGPT');
    api.setTabStatus(null);
    expect(document.title).toBe('Renamed by ChatGPT');
    expect(document.head.querySelectorAll('link[rel="icon"]')).toHaveLength(0);
  });
  it('retires the previous projection before adapter reinjection and old recorder cleanup', () => {
    document.title = 'Creative work';
    const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = '/native.png'; document.head.append(icon);
    api.setTabStatus('loop');
    dom.window.eval(source);
    const fresh = (dom.window as unknown as { CLF_DOM: DomApi }).CLF_DOM;
    fresh.setTabStatus(null); // Old recorder cleanup resolves the newly assigned global adapter.
    fresh.setTabStatus('goal');
    expect(document.title).toBe('CoS Goal · Creative work');
    expect(fresh.conversationTitle()).toBe('Creative work');
    fresh.setTabStatus(null);
    expect(document.title).toBe('Creative work');
    expect(icon.getAttribute('href')).toBe('/native.png');
    expect(icon.hasAttribute('type')).toBe(false);
  });
});

describe('provider authentication state', () => {
  const rendered = (node: HTMLElement): HTMLElement => {
    node.setAttribute('data-clf-test-rendered', '1');
    Object.defineProperty(node, 'getClientRects', { value: () => [{ width: 40, height: 24 }] });
    return node;
  };

  it('requires positive provider-owned controls and ignores authored sign-in prose', () => {
    expect(api.authenticationState()).toBe('unknown');
    const prose = rendered(document.createElement('button'));
    prose.textContent = 'Sign in';
    prose.setAttribute('aria-label', 'Sign in');
    const turn = document.createElement('section');
    turn.setAttribute('data-testid', 'conversation-turn-9');
    turn.append(prose);
    document.body.append(turn);
    expect(api.authenticationState()).toBe('unknown');

    const login = rendered(document.createElement('button'));
    login.dataset.testid = 'login-button';
    document.body.append(login);
    expect(api.authenticationState()).toBe('signed-out');

    const profile = rendered(document.createElement('button'));
    profile.dataset.testid = 'accounts-profile-button';
    document.body.append(profile);
    expect(api.authenticationState()).toBe('signed-out');
    login.remove();
    expect(api.authenticationState()).toBe('signed-in');
  });

  it('recognizes only trusted provider login links and otherwise stays unknown', () => {
    const unrelated = rendered(document.createElement('a'));
    unrelated.setAttribute('href', 'https://example.test/login');
    document.body.append(unrelated);
    expect(api.authenticationState()).toBe('unknown');
    unrelated.setAttribute('href', 'https://chatgpt.com/auth/login');
    expect(api.authenticationState()).toBe('signed-out');
  });

  it('recognizes the native sidebar plain Log in button without test ids or aria labels', () => {
    const sidebar = document.createElement('aside');
    sidebar.textContent = 'Get responses tailored to you';
    const login = rendered(document.createElement('button'));
    login.textContent = 'Log in';
    sidebar.append(login);
    document.body.append(sidebar);
    expect(api.authenticationState()).toBe('signed-out');
  });

  it('does not treat quoted sidebar markup or arbitrary Login prose as authentication', () => {
    const turn = document.createElement('section');
    turn.setAttribute('data-message-author-role', 'assistant');
    turn.innerHTML = '<aside>Get responses tailored to you<button>Log in</button></aside>';
    document.body.append(turn);
    const arbitrary = rendered(document.createElement('button'));
    arbitrary.textContent = 'Log in';
    document.body.append(arbitrary);
    expect(api.authenticationState()).toBe('unknown');
  });

  it('recognizes a div-based native sidebar login even with stale profile chrome', () => {
    const sidebar = document.createElement('div');
    sidebar.id = 'stage-slideover-sidebar';
    const login = rendered(document.createElement('button'));
    login.textContent = 'Log in';
    sidebar.append(login);
    const profile = rendered(document.createElement('button'));
    profile.dataset.testid = 'accounts-profile-button';
    document.body.append(sidebar, profile);
    expect(api.authenticationState()).toBe('signed-out');
    sidebar.remove();
    expect(api.authenticationState()).toBe('signed-in');
  });
});

describe('native unusual-activity restriction', () => {
  const warning = 'Our systems have detected unusual activity coming from your system. Please try again later.';
  it('preserves the draft and never clicks Send while the account is restricted', async () => {
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert'); alert.textContent = warning;
    document.body.append(alert);
    const clicked = vi.fn(); button.addEventListener('click', clicked);
    expect(await api.send()).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    expect(box.textContent).toBe('Exact app prompt');
  });
  it('reports the native alert as blocking without granting Retry authority', () => {
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert'); alert.append(warning);
    const retry = document.createElement('button'); retry.textContent = 'Retry'; alert.append(retry);
    document.body.append(alert);
    expect(api.errors()).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: warning, reason: 'account_restricted', blocking: true, recoverable: false })
    ]));
    expect(api.errors().find(error => error.blocking)?.retry).toBeUndefined();
  });
  it.each(['.markdown', '[data-message-author-role]', '[contenteditable]', '.clf-stream'])('ignores quoted warning in %s', selector => {
    const owner = document.createElement('div');
    if (selector.startsWith('.')) owner.className = selector.slice(1);
    else owner.setAttribute(selector.slice(1, -1), 'true');
    owner.innerHTML = `<div role="alert">${warning}</div>`;
    document.body.append(owner);
    expect(api.errors()).toEqual([]);
  });
});

describe('native hourly message limit', () => {
  const warning = "You've reached our limit of messages per hour. Please try again later.";
  it('blocks Send and never grants the adjacent Retry authority', async () => {
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.append(warning);
    const retry = document.createElement('button');
    retry.textContent = 'Retry'; alert.append(retry);
    document.body.append(alert);
    const clicked = vi.fn(); button.addEventListener('click', clicked);
    expect(api.errors()).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'account_restricted', blocking: true, recoverable: false })
    ]));
    expect(api.errors().find(error => error.blocking)?.retry).toBeUndefined();
    expect(await api.send()).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    expect(box.textContent).toBe('Exact app prompt');
  });
  it.each(['.markdown', '[data-message-author-role]', '[contenteditable]', '.clf-stream'])('ignores quoted hourly limits in %s', selector => {
    const owner = document.createElement('div');
    if (selector.startsWith('.')) owner.className = selector.slice(1);
    else owner.setAttribute(selector.slice(1, -1), 'true');
    owner.innerHTML = `<div role="alert">${warning}</div>`;
    document.body.append(owner);
    expect(api.errors()).toEqual([]);
  });
});

describe('native short usage limit', () => {
  const warning = "You've hit your limit. Please try again later.";
  it('blocks Send without treating the quota notice as a retryable transport error', async () => {
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert'); alert.textContent = warning;
    const retry = document.createElement('button'); retry.textContent = 'Retry'; alert.append(retry);
    document.body.append(alert);
    const clicked = vi.fn(); button.addEventListener('click', clicked);
    expect(api.errors()).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'account_restricted', text: warning, blocking: true, recoverable: false })
    ]));
    expect(api.errors().find(error => error.blocking)?.retry).toBeUndefined();
    expect(await api.send()).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    expect(box.textContent).toBe('Exact app prompt');
  });
  it.each(['.markdown', '[data-message-author-role]', '[contenteditable]', '.clf-stream', '[hidden]'])('ignores quoted or hidden usage limits in %s', selector => {
    const owner = document.createElement('div');
    if (selector.startsWith('.')) owner.className = selector.slice(1);
    else owner.setAttribute(selector.slice(1, -1), 'true');
    owner.innerHTML = `<div role="alert">${warning}</div>`;
    document.body.append(owner);
    expect(api.errors()).toEqual([]);
  });
});

describe('native model not found diagnostic', () => {
  function notice(parent: Element = document.body, role = 'alert', value = 'Model not found') {
    const card = document.createElement('div');
    const alert = document.createElement('p'); alert.setAttribute('role', role); alert.textContent = value;
    const retry = document.createElement('button'); retry.textContent = 'Retry';
    card.append(alert, retry); parent.append(card);
    return { card, alert, retry };
  }

  it.each(['adjacent', 'inside'] as const)('reports the exact native alert with %s Retry without action authority', placement => {
    const { alert, retry } = notice();
    if (placement === 'inside') alert.append(retry);
    const clicked = vi.fn(); retry.addEventListener('click', clicked);
    expect(api.errors()).toEqual([expect.objectContaining({ text: 'Model not found', node: alert, recoverable: false, diagnosticOnly: true })]);
    expect(api.errors()[0]).not.toHaveProperty('retry');
    expect(api.errors()[0]).not.toHaveProperty('blocking');
    expect(api.errors()[0]).not.toHaveProperty('reason');
    box.textContent = '';
    const authorize = vi.fn(() => true);
    expect(api.retryLatestTransportFailure(() => true, authorize).status).toBe('stopped');
    expect(authorize).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });

  it.each([
    ['class', 'markdown'], ['data-message-author-role', 'user'], ['data-message-author-role', 'assistant'],
    ['data-markdown-text-style', 'true'], ['data-content-search-unit-key', 'quoted'], ['contenteditable', 'true'],
    ['class', 'clf-stream'], ['class', 'clf-stage'], ['data-clf-user-text', 'true'],
    ['hidden', ''], ['aria-hidden', 'true'], ['inert', ''], ['class', 'sr-only'], ['style', 'display:none'],
    ['style', 'visibility:hidden']
  ])('ignores authored, own or hidden alert in %s=%s', (attribute, value) => {
    const owner = document.createElement('div'); owner.setAttribute(attribute, value); document.body.append(owner);
    const { retry } = notice(owner); const clicked = vi.fn(); retry.addEventListener('click', clicked);
    expect(api.errors()).toEqual([]);
    expect(clicked).not.toHaveBeenCalled();
  });

  it.each(['blockquote', 'pre', 'code', 'span class="markdown"', 'span data-message-author-role="user"',
    'span data-message-author-role="assistant"', 'span data-clf-user-text'])
  ('ignores authored wording inside a native-looking alert (%s)', tag => {
    const { alert, retry } = notice();
    alert.innerHTML = `<${tag}>Model not found</${tag.split(' ')[0]}>`;
    expect(api.errors()).toEqual([]);
    const clicked = vi.fn(); retry.addEventListener('click', clicked);
    box.textContent = '';
    expect(api.retryLatestTransportFailure(() => true, () => true).status).toBe('stopped');
    expect(clicked).not.toHaveBeenCalled();
  });

  it.each(['Model not found', 'Model not found.'])('ignores an ordinary status announcing %s', value => {
    const main = document.createElement('main'); document.body.append(main); notice(main, 'status', value);
    expect(api.errors()).toEqual([]);
  });

  it.each(['The provider said: Model not found', '“Model not found”', 'Model not found; using another model',
    'Model not found resolved', 'Model found', 'Actions refreshed.'])('ignores inexact or successful alert: %s', value => {
    notice(document.body, 'alert', value);
    expect(api.errors()).toEqual([]);
  });
});

describe('native quick reliability check', () => {
  const warning = 'We’re doing a quick check to keep ChatGPT reliable. Try again in 27 minutes.';
  it.each([['alert', false], ['alert', true], ['status', false], ['status', true]] as const)(
    'holds a signed-in account without sending or retrying (role=%s, Send disabled=%s)', async (role, disabled) => {
    const main = document.createElement('main');
    const alert = document.createElement('div');
    alert.setAttribute('role', role); alert.textContent = warning;
    const retry = document.createElement('button'); retry.textContent = 'Retry';
    const retried = vi.fn(); retry.addEventListener('click', retried); alert.append(retry);
    main.append(alert); document.body.append(main);
    const profile = document.createElement('button');
    profile.setAttribute('data-testid', 'accounts-profile-button'); document.body.append(profile);
    button.disabled = disabled;
    const clicked = vi.fn(); button.addEventListener('click', clicked);
    expect(api.authenticationState()).toBe('signed-in');
    expect(api.errors()).toEqual([expect.objectContaining({
      reason: 'account_restricted', text: warning, blocking: true, recoverable: false
    })]);
    expect(api.errors()[0]?.retry).toBeUndefined();
    expect(await api.send()).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    expect(retried).not.toHaveBeenCalled();
    expect(box.textContent).toBe('Exact app prompt');
  });
  it.each([
    ['data-message-author-role', 'user'], ['data-message-author-role', 'assistant'],
    ['class', 'markdown'], ['contenteditable', 'true'], ['class', 'clf-stream'],
    ['data-clf-user-text', 'true'], ['data-testid', 'conversation-turn-quoted'],
    ['data-markdown-text-style', 'true'], ['data-content-search-unit-key', 'quoted'],
    ['hidden', ''], ['aria-hidden', 'true'], ['inert', '']
  ])('ignores an authored, own, or hidden warning in %s=%s', (attribute, value) => {
    const owner = document.createElement('div'); owner.setAttribute(attribute, value);
    owner.innerHTML = `<div role="alert">${warning}</div>`;
    document.body.append(owner);
    expect(api.errors()).toEqual([]);
  });
  it.each(['div', 'p'])('does not grant a hold to unanchored %s text', tag => {
    const node = document.createElement(tag); node.textContent = warning;
    document.body.append(node);
    expect(api.errors()).toEqual([]);
  });
  it('does not admit a status outside native main context or a quoted/inexact banner', () => {
    const status = document.createElement('div'); status.setAttribute('role', 'status'); status.textContent = warning;
    document.body.append(status);
    expect(api.errors()).toEqual([]);
    status.remove();
    for (const text of [`The provider said: ${warning}`, `“${warning}”`, warning.replace('27 minutes', 'some time')]) {
      const alert = document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = text;
      document.body.append(alert);
      expect(api.errors()).toEqual([]);
      alert.remove();
    }
  });
});

describe('privacy-safe composer diagnostics', () => {
  it('reports state without retaining authored text, HTML, URLs or button labels', () => {
    box.textContent = 'PRIVATE draft https://example.test/?token=secret';
    button.setAttribute('aria-label', 'PRIVATE button');
    expect(api.composerDiagnostics()).toEqual({ host: 'native', writable: true, draft: true, attachments: false, send: 'enabled' });
    button.disabled = true;
    expect(api.composerDiagnostics().send).toBe('disabled');
    button.remove();
    expect(api.composerDiagnostics().send).toBe('missing');
    box.setAttribute('contenteditable', 'false');
    expect(api.composerDiagnostics().writable).toBe(false);
  });

  it('identifies the observed pending-home textbox without authorizing it for Send', () => {
    document.body.innerHTML = '<main><textarea id="pending-home-input" data-pending-input-initialized="true" data-has-text="false"></textarea></main>';
    const pending = document.querySelector('textarea')!;
    expect(api.composerDiagnostics()).toEqual({ host: 'pending-home', writable: false, draft: false, attachments: false, send: 'missing' });
    expect(api.composer()).toBeNull();
    pending.value = 'PRIVATE manually entered draft';
    expect(pending.textContent).toBe('');
    expect(api.composerDiagnostics().draft).toBe(true);
    expect(JSON.stringify(api.composerDiagnostics())).not.toContain('PRIVATE');
    pending.value = '';
    pending.dataset.hasText = 'true';
    expect(api.composerDiagnostics().draft).toBe(true);
    pending.hidden = true;
    expect(api.composerDiagnostics().host).toBe('missing');
  });
});

describe('abandoned loading-home close proof', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><textarea id="pending-home-input" data-pending-input-initialized="true" data-has-text="false"></textarea></main>';
  });
  it('recognizes the exact empty pending home without making it a Send composer', () => {
    expect(api.emptyComposerForClose()).toBe(true);
    expect(api.composer()).toBeNull();
    const pending = document.querySelector('textarea')!;
    pending.value = 'Keep my draft';
    expect(api.emptyComposerForClose()).toBe(false);
    pending.value = '';
    pending.dataset.hasText = 'true';
    expect(api.emptyComposerForClose()).toBe(false);
  });
  it.each(['hidden', 'ambiguous', 'uninitialized', 'conversation', 'turn', 'attachment', 'upload', 'selected-file', 'mixed-editor'])('retains a %s pending page', kind => {
    const pending = document.querySelector('textarea')!;
    if (kind === 'hidden') pending.hidden = true;
    if (kind === 'ambiguous') pending.after(pending.cloneNode(true));
    if (kind === 'uninitialized') pending.removeAttribute('data-pending-input-initialized');
    if (kind === 'conversation') dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    if (kind === 'turn') user('Existing user message');
    if (kind === 'attachment') pending.insertAdjacentHTML('afterend', '<button aria-label="Remove file: original.png"></button>');
    if (kind === 'upload') pending.insertAdjacentHTML('afterend', '<div data-inline-file-uploading></div>');
    if (kind === 'selected-file') {
      pending.insertAdjacentHTML('afterend', '<input type="file">');
      Object.defineProperty(document.querySelector('input'), 'files', { value: [new dom.window.File(['private'], 'original.png')] });
    }
    if (kind === 'mixed-editor') {
      pending.value = 'Preserve text while the page hydrates';
      pending.insertAdjacentHTML('afterend', '<div id="prompt-textarea" contenteditable="true"></div>');
    }
    expect(api.emptyComposerForClose()).toBe(false);
  });
});

describe('exact deleted conversation load-error close proof', () => {
  const deleted = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  beforeEach(() => {
    dom.reconfigure({ url: `https://chatgpt.com/c/${deleted}` });
    document.body.innerHTML = '<main><div><p>Unable to load conversation</p><button>Retry</button></div></main>';
  });
  it.each(['bare', 'pending'] as const)('permits only the explicitly deleted hard-load-error shell: %s', shell => {
    if (shell === 'pending') document.querySelector('main')!.insertAdjacentHTML('afterbegin',
      '<form><textarea id="pending-conversation-input"></textarea><button disabled>Send</button></form>');
    expect(api.emptyComposerForClose()).toBe(false);
    expect(api.emptyComposerForClose('bbbbbbbb-cccc-dddd-eeee-ffffffffffff')).toBe(false);
    expect(api.emptyComposerForClose(deleted)).toBe(true);
  });
  it.each(['unknown', 'generic-error', 'auth', 'draft', 'hidden-editor', 'hidden-empty-editor', 'ambiguous-editor',
    'pending-draft', 'pending-hidden', 'pending-ambiguous', 'attachment', 'hidden-attachment', 'upload',
    'selected-file', 'native-turn', 'hidden-message', 'authored-error', 'stop', 'hidden-error', 'wrong-route',
    'foreign-origin', 'route-suffix', 'hash'] as const)('retains a deleted page with %s', state => {
    const main = document.querySelector('main')!;
    if (state === 'unknown') main.replaceChildren();
    if (state === 'generic-error') main.querySelector('p')!.textContent = 'Something went wrong';
    if (state === 'auth') document.body.insertAdjacentHTML('afterbegin', '<nav><button data-testid="login-button">Log in</button></nav>');
    if (state === 'draft') document.body.insertAdjacentHTML('beforeend', '<textarea>Keep this draft</textarea>');
    if (state === 'hidden-editor' || state === 'hidden-empty-editor') document.body.insertAdjacentHTML('beforeend',
      `<aside hidden><div contenteditable="true">${state === 'hidden-editor' ? 'Keep this draft' : ''}</div></aside>`);
    if (state === 'ambiguous-editor') main.insertAdjacentHTML('beforeend', '<div role="textbox"></div>');
    if (state.startsWith('pending-')) {
      main.insertAdjacentHTML('afterbegin', '<textarea id="pending-conversation-input"></textarea>');
      const pending = main.querySelector('textarea')!;
      if (state === 'pending-draft') pending.value = 'Keep pending draft';
      if (state === 'pending-hidden') pending.hidden = true;
      if (state === 'pending-ambiguous') pending.after(pending.cloneNode());
    }
    if (state === 'attachment' || state === 'hidden-attachment') document.body.insertAdjacentHTML('beforeend',
      `<aside${state === 'hidden-attachment' ? ' hidden' : ''}><button aria-label="Remove file: original.png"></button></aside>`);
    if (state === 'upload') main.insertAdjacentHTML('beforeend', '<div data-inline-file-uploading></div>');
    if (state === 'selected-file') {
      main.insertAdjacentHTML('beforeend', '<input type="file">');
      Object.defineProperty(main.querySelector('input'), 'files', { value: [new dom.window.File(['private'], 'original.png')] });
    }
    if (state === 'native-turn') user('Retain recorded native work');
    if (state === 'hidden-message') document.body.insertAdjacentHTML('beforeend', '<div hidden data-message-author-role="assistant">Retain final</div>');
    if (state === 'authored-error') main.className = 'markdown';
    if (state === 'stop') main.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>');
    if (state === 'hidden-error') main.hidden = true;
    if (state === 'wrong-route') dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff' });
    if (state === 'foreign-origin') dom.reconfigure({ url: `https://example.com/c/${deleted}` });
    if (state === 'route-suffix') dom.reconfigure({ url: `https://chatgpt.com/c/${deleted}/unrelated` });
    if (state === 'hash') dom.reconfigure({ url: `https://chatgpt.com/c/${deleted}#settings` });
    expect(api.emptyComposerForClose(deleted)).toBe(false);
  });
});

describe('one native HTML edit for prepared text', () => {
  beforeEach(() => {
    document.execCommand = (command, _ui, value) => {
      const selection = document.getSelection();
      if (command !== 'insertHTML' || document.activeElement !== box || !selection?.rangeCount) return false;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const template = document.createElement('template');
      template.innerHTML = value || '';
      range.insertNode(template.content);
      return true;
    };
  });
  it('hands a 96000-character multiline frame to the editor once without native per-line editing', () => {
    const value = ('Literal <abc> & "quoted" instructions.\n\n').repeat(2600).slice(0, 96000);
    const nativeEdit = vi.spyOn(document, 'execCommand');
    const events = vi.spyOn(document, 'dispatchEvent');
    const pasted = vi.fn(); box.addEventListener('paste', pasted);
    expect(api.insertPrompt(value, true)).toBe(true);
    expect(nativeEdit).toHaveBeenCalledOnce();
    expect(nativeEdit).toHaveBeenCalledWith('insertHTML', false, expect.any(String));
    expect(events).not.toHaveBeenCalled();
    expect(pasted).not.toHaveBeenCalled();
    expect(box.querySelectorAll('p')).toHaveLength(0);
    expect(box.querySelector('abc')).toBeNull();
    expect(box.innerHTML.replaceAll('<br>', '\n')).toContain('&lt;abc&gt;');
    expect(box.textContent!.replace(/\s/g, '')).toBe(value.replace(/\s/g, ''));
  });
  it('preserves an existing draft when native editing refuses it without falling back', () => {
    const nativeEdit = vi.fn(() => false); document.execCommand = nativeEdit;
    expect(api.insertPrompt('replacement', true)).toBe(false);
    expect(box.textContent).toBe('Exact app prompt');
    expect(nativeEdit).toHaveBeenCalledOnce();
  });
  it.each(['replace', 'append', 'empty'] as const)('uses the browser range for one %s edit even when a cold custom paste handler drops text', mode => {
    const original = mode === 'empty' ? '' : 'Original draft';
    box.textContent = original;
    const pasted = vi.fn((event: Event) => event.preventDefault());
    box.addEventListener('paste', pasted);
    const nativeEdit = vi.spyOn(document, 'execCommand');
    expect(api.insertPrompt('Replacement', mode === 'append' ? 'append' : true)).toBe(true);
    expect(nativeEdit).toHaveBeenCalledOnce();
    expect(pasted).not.toHaveBeenCalled();
    expect(box.textContent).toBe(mode === 'append' ? original + 'Replacement' : 'Replacement');
  });
  it('does not edit a host replaced while it takes focus', () => {
    const nativeEdit = vi.spyOn(document, 'execCommand');
    box.focus = () => box.replaceWith(box.cloneNode(true));
    expect(api.insertPrompt('Replacement', true)).toBe(false);
    expect(nativeEdit).not.toHaveBeenCalled();
    expect(document.getElementById('prompt-textarea')!.textContent).toBe('Exact app prompt');
  });
  it.each(['refused', 'modified', 'replaced', 'exception'])('reports only bounded predicate metadata for %s insertion', kind => {
    const secret = 'PRIVATE authored prompt';
    document.execCommand = () => {
      if (kind === 'refused') return false;
      if (kind === 'modified') box.textContent = 'Other text';
      if (kind === 'replaced') box.replaceWith(box.cloneNode(true));
      if (kind === 'exception') throw new Error(secret);
      return true;
    };
    const failure = vi.fn();
    expect(api.insertPrompt(secret, true, failure)).toBe(false);
    expect(failure).toHaveBeenCalledOnce();
    const reason = failure.mock.calls[0]![0];
    expect(reason).toBe({ refused: 'native_edit_rejected', modified: 'text_mismatch', replaced: 'editor_replaced', exception: 'insertion_exception' }[kind]);
    expect(reason).not.toContain(secret);
    expect(reason).not.toContain('Other text');
  });
  it('restores an originally empty draft through one native inline edit', () => {
    const nativeEdit = vi.spyOn(document, 'execCommand');
    expect(api.insertPrompt('', true)).toBe(true);
    expect(box.textContent).toBe('');
    expect(nativeEdit).toHaveBeenCalledOnce();
    expect(nativeEdit).toHaveBeenCalledWith('insertHTML', false, '<br>');
  });
  it('refuses another draft before native editing', () => {
    box.textContent = 'A fully authored draft must survive';
    const nativeEdit = vi.spyOn(document, 'execCommand');
    expect(api.insertPrompt('replacement')).toBe(false);
    expect(nativeEdit).not.toHaveBeenCalled();
  });
  it.each(['D', 'hello', 'word', '123', 'abc def', 'abc def ghi', 'three stray words'])('replaces authorized short residue without appending it (%s)', text => {
    box.textContent = text;
    expect(api.insertPrompt('Exact saved task')).toBe(true);
    expect(box.textContent).toBe('Exact saved task');
  });
  it.each(['Saved handoff', '[[CLF-RESUME:abc]]', 'stop', 'continue', 'please stop now', 'no more changes', 'resume this task', 'https://example.com', 'a'.repeat(25), 'one two three four', 'abc\ndef', 'abc, def'])('preserves substantive or control drafts (%s)', text => {
    box.textContent = text;
    expect(api.insertPrompt('Exact saved task')).toBe(false);
    expect(box.textContent).toBe(text);
  });
  it('preserves even a short draft with an attachment', () => {
    box.textContent = 'D';
    const attachment = document.createElement('button');
    attachment.setAttribute('aria-label', 'Remove file: personal.webp');
    box.closest('form')!.append(attachment);
    expect(api.insertPrompt('Exact saved task')).toBe(false);
    expect(box.textContent).toBe('D');
  });
  it('retains the exact editor lease through paragraph normalization but rejects changed content and remounts', () => {
    box.textContent = 'First line\nSecond line';
    const draft = api.captureComposerDraft(box.textContent);
    box.innerHTML = '<p>First line</p><p>Second line</p>';
    expect(draft.current()).toBe(true);
    box.lastElementChild!.textContent = 'Different line';
    expect(draft.current()).toBe(false);
    box.innerHTML = '<p>First line</p><p>Second line</p>';
    box.replaceWith(box.cloneNode(true));
    expect(draft.current()).toBe(false);
    draft.dispose();
  });
});

describe('native Core attachment', () => {
  const connectorName = 'Luna Forge X7 — Primary Core';
  const appId = 'asdk_app_Primary';
  const coreMenu = () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    box.closest('form')!.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span><span>Custom app</span>`;
    option.getBoundingClientRect = () => ({ top: 20, bottom: 60, height: 40,
      left: 0, right: 200, width: 200, x: 0, y: 20, toJSON() {} });
    section.append(option); scrollArea.append(section); document.body.append(scrollArea);
    Object.defineProperties(scrollArea, { clientHeight: { value: 100 }, scrollHeight: { value: 100 } });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100,
      left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    return { add, scrollArea, section, option };
  };
  const coreMention = (id = appId, name = connectorName) => {
    const mention = document.createElement('span');
    mention.setAttribute('app-mention-display-name', name);
    mention.setAttribute('app-mention-path', `app://${id}`);
    mention.setAttribute('contenteditable', 'false');
    mention.textContent = name;
    return mention;
  };
  it('selects only one exact visible native app row and preserves authored text', () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    box.closest('form')!.prepend(add);
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span>`;
    document.body.append(option);
    expect(api.openConnectorMenu(connectorName)).toBe(true);
    expect(api.connectorMenuOption(connectorName)).toBe(option);
    const mention = document.createElement('span');
    mention.setAttribute('app-mention-display-name', connectorName);
    mention.setAttribute('app-mention-path', `app://${appId}`);
    mention.setAttribute('contenteditable', 'false');
    mention.textContent = connectorName;
    box.append(mention);
    expect(api.connectorMentionSelected(connectorName, appId)).toBe(true);
    expect(api.connectorMentionIdentity(connectorName)).toEqual({ appId });
    expect(api.nativeConnectorMentionIdentity()).toEqual({ appId, connectorName });
    expect(api.composerAuthoredText(connectorName, appId)).toBe('Exact app prompt');
  });
  it('never uses a document-wide Add control when the composer has no form owner', () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    const clicked = vi.fn();
    add.addEventListener('click', clicked);
    document.body.append(add);
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span>`;
    document.body.append(option);
    box.closest('form')!.after(box);

    expect(api.openConnectorMenu(connectorName)).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    expect(api.connectorMenuOptionReader(connectorName)()).toBeNull();
  });
  it.each([
    { name: 'integer down', fraction: 0, start: 0, expected: 120 },
    { name: 'fractional down', fraction: 0.4609375, start: 0, expected: 121 },
    { name: 'fractional up', fraction: 0.75, start: 200, expected: 180 }
  ])('reveals the exact app row only inside the current Add menu plugins viewport ($name)', ({ fraction, start, expected }) => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    add.setAttribute('aria-expanded', 'true');
    box.closest('form')!.prepend(add);
    const unrelated = document.createElement('div');
    unrelated.dataset.mentionListScrollArea = 'true';
    unrelated.scrollTop = 17;
    document.body.append(unrelated);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span><span>Custom app</span>`;
    section.append(option);
    scrollArea.append(section);
    document.body.append(scrollArea);
    const readOption = api.connectorMenuOptionReader(connectorName);
    expect(readOption()).toBeNull();
    Object.defineProperties(scrollArea, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 300 }
    });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    section.getBoundingClientRect = () => ({ top: 140 - scrollArea.scrollTop, bottom: 240 - scrollArea.scrollTop, height: 100, left: 0, right: 200, width: 200, x: 0, y: 140 - scrollArea.scrollTop, toJSON() {} });
    scrollArea.scrollTop = start;
    option.getBoundingClientRect = () => ({ top: 180 + fraction - scrollArea.scrollTop, bottom: 220 + fraction - scrollArea.scrollTop, height: 40, left: 0, right: 200, width: 200, x: 0, y: 180 + fraction - scrollArea.scrollTop, toJSON() {} });

    expect(readOption()).toBe(option);
    expect(scrollArea.scrollTop).toBe(expected);
    expect(unrelated.scrollTop).toBe(17);
    expect(api.connectorMenuOption(connectorName)).toBe(option);
  });
  describe('quantized native Core menu reveal', () => {
    const quantizedMenu = (direction: 'down' | 'up', mode: 'quantized' | 'unresponsive' | 'boundary' = 'quantized') => {
      // Public structure/geometry: Gary c38e35b8, retained tab1030114873, 2026-10-13.
      // The prior JS scroll request was not recorded. Model its measured 1.5-CSS-pixel
      // rendering quantum explicitly; upward/boundary cases are neighboring synthetic guards.
      const name = 'Cove Windows Core';
      const add = document.createElement('button');
      add.type = 'button'; add.dataset.composerNavigationTarget = 'add-context';
      add.setAttribute('aria-expanded', 'true'); box.closest('form')!.prepend(add);
      const scrollArea = document.createElement('div');
      scrollArea.dataset.mentionListScrollArea = 'true';
      const section = document.createElement('div'); section.dataset.mentionSectionId = 'plugins';
      const option = document.createElement('button'); option.type = 'button'; option.dataset.listNavigationItem = 'true';
      option.innerHTML = `<div data-menu-row-content="true"><span></span><span class="flex-1 min-w-0 truncate"><span class="flex min-w-0 items-center gap-menu-row-content"><span class="min-w-0 truncate shrink-0">${name}</span><span class="min-w-0 flex-1 truncate text-sm text-codex-description">Custom app</span></span></span></div>`;
      section.append(option); scrollArea.append(section); document.body.append(scrollArea);
      const top = 323.109375, bottom = 591.4921875, height = 268.3828125, width = 734.015625;
      const maxTop = mode === 'boundary' ? 1 : 230;
      Object.defineProperties(scrollArea, { clientHeight: { value: 268 }, scrollHeight: { value: 268 + maxTop } });
      let offset = direction === 'down' ? 0 : mode === 'boundary' ? 1 : 42;
      const origin = offset, gap = 19.6171875;
      const rowTop = direction === 'down' ? 575.109375 : top + origin - gap;
      const requests: number[] = [];
      Object.defineProperty(scrollArea, 'scrollTop', { get: () => offset, set: (requested: number) => {
        requests.push(requested);
        if (mode !== 'unresponsive') offset = Math.max(0, Math.min(maxTop, Math.round(requested / 1.5) * 1.5));
      } });
      scrollArea.getBoundingClientRect = () => ({ top, bottom, height, left: 0, right: width, width, x: 0, y: top, toJSON() {} });
      option.getBoundingClientRect = () => ({ top: rowTop - offset, bottom: rowTop + 36 - offset,
        height: 36, left: 0, right: width, width, x: 0, y: rowTop - offset, toJSON() {} });
      const clicks = vi.fn(); option.addEventListener('click', clicks);
      return { name, add, scrollArea, section, option, requests, clicks, read: api.connectorMenuOptionReader(name) };
    };
    it.each(['down', 'up'] as const)('reveals the exact row after one positively measured quantized shortfall (%s)', direction => {
      const menu = quantizedMenu(direction);
      expect(menu.read()).toBeNull();
      expect(menu.requests).toEqual([direction === 'down' ? 20 : 22]);
      expect(menu.scrollArea.scrollTop).toBe(direction === 'down' ? 19.5 : 22.5);
      expect(menu.read()).toBe(menu.option);
      expect(menu.requests).toEqual([direction === 'down' ? 20 : 22, 21]);
      const row = menu.option.getBoundingClientRect(), viewport = menu.scrollArea.getBoundingClientRect();
      expect(row.top).toBeGreaterThanOrEqual(viewport.top);
      expect(row.bottom).toBeLessThanOrEqual(viewport.bottom);
      for (let check = 0; check < 5; check++) expect(menu.read()).toBe(menu.option);
      expect(menu.requests).toHaveLength(2);
      expect(menu.clicks).not.toHaveBeenCalled();
    });
    it.each([
      ['down', 'unresponsive'], ['up', 'unresponsive'], ['down', 'boundary'], ['up', 'boundary']
    ] as const)('keeps an incompletely visible %s row fenced at %s without a third scroll', (direction, mode) => {
      const menu = quantizedMenu(direction, mode);
      for (let check = 0; check < 10; check++) expect(menu.read()).toBeNull();
      expect(menu.requests.length).toBeLessThanOrEqual(2);
      expect(menu.requests.length).toBeGreaterThan(0);
      const row = menu.option.getBoundingClientRect(), viewport = menu.scrollArea.getBoundingClientRect();
      expect(row.top < viewport.top || row.bottom > viewport.bottom).toBe(true);
      expect(menu.clicks).not.toHaveBeenCalled();
    });
    it.each(['composer', 'control', 'competing-menu'] as const)('does not borrow a quantized shortfall after %s authority changes', authority => {
      const menu = quantizedMenu('down');
      expect(menu.read()).toBeNull();
      if (authority === 'composer') box.closest('form')!.replaceWith(box.closest('form')!.cloneNode(true));
      if (authority === 'control') menu.add.replaceWith(menu.add.cloneNode(true));
      if (authority === 'competing-menu') document.body.append(menu.scrollArea.cloneNode(true));
      for (let check = 0; check < 5; check++) expect(menu.read()).toBeNull();
      expect(menu.requests).toEqual([20]);
      expect(menu.clicks).not.toHaveBeenCalled();
    });
  });
  it('rebinds once when its own menu-local scroll remounts the unique exact app row and viewport', () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    add.setAttribute('aria-expanded', 'true');
    box.closest('form')!.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span><span>Custom app</span>`;
    section.append(option); scrollArea.append(section); document.body.append(scrollArea);
    Object.defineProperties(scrollArea, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 300 }
    });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100,
      left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    option.getBoundingClientRect = () => ({ top: 180 - scrollArea.scrollTop,
      bottom: 220 - scrollArea.scrollTop, height: 40, left: 0, right: 200,
      width: 200, x: 0, y: 180 - scrollArea.scrollTop, toJSON() {} });
    let replacementOption: HTMLButtonElement | null = null;
    scrollArea.addEventListener('scroll', () => {
      const replacement = document.createElement('div');
      replacement.dataset.mentionListScrollArea = 'true';
      const replacementSection = document.createElement('div');
      replacementSection.dataset.mentionSectionId = 'plugins';
      replacementOption = option.cloneNode(true) as HTMLButtonElement;
      replacementSection.append(replacementOption); replacement.append(replacementSection);
      Object.defineProperties(replacement, {
        clientHeight: { value: 100 },
        scrollHeight: { value: 300 }
      });
      replacement.scrollTop = scrollArea.scrollTop;
      replacement.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100,
        left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
      replacementOption.getBoundingClientRect = () => ({ top: 180 - replacement.scrollTop,
        bottom: 220 - replacement.scrollTop, height: 40, left: 0, right: 200,
        width: 200, x: 0, y: 180 - replacement.scrollTop, toJSON() {} });
      scrollArea.replaceWith(replacement);
    }, { once: true });

    const readOption = api.connectorMenuOptionReader(connectorName);
    expect(readOption()).toBe(replacementOption);
    expect(scrollArea.isConnected).toBe(false);
    expect(api.connectorMenuOption(connectorName)).toBe(replacementOption);
  });
  it('does not adopt an unrelated exact menu remount before one of its own bounded actions', () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    add.setAttribute('aria-expanded', 'true');
    box.closest('form')!.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span><span>Custom app</span>`;
    section.append(option); scrollArea.append(section); document.body.append(scrollArea);
    Object.defineProperties(scrollArea, { clientHeight: { value: 100 }, scrollHeight: { value: 100 } });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100,
      left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    option.getBoundingClientRect = () => ({ top: 20, bottom: 60, height: 40,
      left: 0, right: 200, width: 200, x: 0, y: 20, toJSON() {} });
    const readOption = api.connectorMenuOptionReader(connectorName);

    const replacement = scrollArea.cloneNode(true) as HTMLElement;
    Object.defineProperties(replacement, { clientHeight: { value: 100 }, scrollHeight: { value: 100 } });
    replacement.getBoundingClientRect = scrollArea.getBoundingClientRect;
    const replacementOption = replacement.querySelector('button')!;
    replacementOption.getBoundingClientRect = option.getBoundingClientRect;
    scrollArea.replaceWith(replacement);

    expect(readOption()).toBeNull();
    expect(api.connectorMenuOption(connectorName)).toBe(replacementOption);
  });
  it('does not let a later exact remount spend the scroll receipt pinned to an earlier rowless replacement', () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    add.setAttribute('aria-expanded', 'true');
    box.closest('form')!.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span><span>Custom app</span>`;
    section.append(option); scrollArea.append(section); document.body.append(scrollArea);
    Object.defineProperties(scrollArea, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100,
      left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    option.getBoundingClientRect = () => ({ top: 180 - scrollArea.scrollTop,
      bottom: 220 - scrollArea.scrollTop, height: 40, left: 0, right: 200,
      width: 200, x: 0, y: 180 - scrollArea.scrollTop, toJSON() {} });
    let firstReplacement: HTMLElement | null = null;
    scrollArea.addEventListener('scroll', () => {
      firstReplacement = document.createElement('div');
      firstReplacement.dataset.mentionListScrollArea = 'true';
      const firstSection = document.createElement('div');
      firstSection.dataset.mentionSectionId = 'plugins';
      firstReplacement.append(firstSection);
      Object.defineProperties(firstReplacement, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
      firstReplacement.scrollTop = scrollArea.scrollTop;
      firstReplacement.getBoundingClientRect = scrollArea.getBoundingClientRect;
      scrollArea.replaceWith(firstReplacement);
    }, { once: true });

    const readOption = api.connectorMenuOptionReader(connectorName);
    expect(readOption()).toBeNull();
    const laterReplacement = document.createElement('div');
    laterReplacement.dataset.mentionListScrollArea = 'true';
    const laterSection = document.createElement('div');
    laterSection.dataset.mentionSectionId = 'plugins';
    const laterOption = option.cloneNode(true) as HTMLButtonElement;
    laterSection.append(laterOption); laterReplacement.append(laterSection);
    Object.defineProperties(laterReplacement, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
    laterReplacement.scrollTop = firstReplacement!.scrollTop;
    laterReplacement.getBoundingClientRect = scrollArea.getBoundingClientRect;
    laterOption.getBoundingClientRect = () => ({ top: 180 - laterReplacement.scrollTop,
      bottom: 220 - laterReplacement.scrollTop, height: 40, left: 0, right: 200,
      width: 200, x: 0, y: 180 - laterReplacement.scrollTop, toJSON() {} });
    firstReplacement!.replaceWith(laterReplacement);

    expect(readOption()).toBeNull();
    expect(api.connectorMenuOption(connectorName)).toBe(laterOption);
  });
  it.each(['competing menu', 'composer', 'control'] as const)(
  'does not let an owned scroll authorize a remount after a %s authority change', authority => {
    const form = box.closest('form')!;
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    add.setAttribute('aria-expanded', 'true');
    form.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span><span>Custom app</span>`;
    section.append(option); scrollArea.append(section); document.body.append(scrollArea);
    Object.defineProperties(scrollArea, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100,
      left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    option.getBoundingClientRect = () => ({ top: 180 - scrollArea.scrollTop,
      bottom: 220 - scrollArea.scrollTop, height: 40, left: 0, right: 200,
      width: 200, x: 0, y: 180 - scrollArea.scrollTop, toJSON() {} });
    scrollArea.addEventListener('scroll', () => {
      const replacement = scrollArea.cloneNode(true) as HTMLElement;
      Object.defineProperties(replacement, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
      replacement.scrollTop = scrollArea.scrollTop;
      replacement.getBoundingClientRect = scrollArea.getBoundingClientRect;
      const replacementOption = replacement.querySelector('button')!;
      replacementOption.getBoundingClientRect = () => ({ top: 180 - replacement.scrollTop,
        bottom: 220 - replacement.scrollTop, height: 40, left: 0, right: 200,
        width: 200, x: 0, y: 180 - replacement.scrollTop, toJSON() {} });
      scrollArea.replaceWith(replacement);
      if (authority === 'competing menu') {
        const competitor = document.createElement('div');
        competitor.dataset.mentionListScrollArea = 'true';
        const competitorSection = document.createElement('div');
        competitorSection.dataset.mentionSectionId = 'plugins';
        competitor.append(competitorSection); document.body.append(competitor);
      }
      if (authority === 'composer') form.replaceWith(form.cloneNode(true));
      if (authority === 'control') add.replaceWith(add.cloneNode(true));
    }, { once: true });

    const readOption = api.connectorMenuOptionReader(connectorName);
    expect(readOption()).toBeNull();
    expect(readOption()).toBeNull();
  });
  it('matches only the primary app-name slot, never an exact secondary subtitle', () => {
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>Different app</span><span>${connectorName}</span>`;
    document.body.append(option);
    expect(api.connectorMenuOption(connectorName)).toBeNull();
    option.innerHTML = `<span>${connectorName}</span><span>${connectorName}</span>`;
    expect(api.connectorMenuOption(connectorName)).toBe(option);
  });
  it('uses the current composer control open state for a pre-open virtual menu without aria-controls', () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    add.setAttribute('aria-expanded', 'true');
    box.closest('form')!.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    scrollArea.append(section);
    document.body.append(scrollArea);
    Object.defineProperties(scrollArea, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 400 }
    });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    section.getBoundingClientRect = () => ({ top: 160 - scrollArea.scrollTop, bottom: 360 - scrollArea.scrollTop,
      height: 200, left: 0, right: 200, width: 200, x: 0, y: 160 - scrollArea.scrollTop, toJSON() {} });
    scrollArea.addEventListener('scroll', () => {
      if (section.querySelector('button')) return;
      const option = document.createElement('button');
      option.type = 'button';
      option.dataset.listNavigationItem = 'true';
      option.innerHTML = `<span>${connectorName}</span><span>Custom app</span>`;
      option.getBoundingClientRect = () => ({ top: 180 - scrollArea.scrollTop, bottom: 220 - scrollArea.scrollTop,
        height: 40, left: 0, right: 200, width: 200, x: 0, y: 180 - scrollArea.scrollTop, toJSON() {} });
      section.append(option);
    });
    const clicked = vi.fn();
    add.addEventListener('click', clicked);
    const readOption = api.connectorMenuOptionReader(connectorName);
    expect(api.openConnectorMenu(connectorName)).toBe(true);
    const option = readOption();
    expect(option).toBe(section.querySelector('button'));
    expect(clicked).not.toHaveBeenCalled();
    expect(scrollArea.scrollTop).toBeGreaterThan(0);
  });
  it('closes and reopens the same composer control before adopting a pre-open virtual menu with no ownership attributes', () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    box.closest('form')!.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    scrollArea.append(section);
    document.body.append(scrollArea);
    Object.defineProperties(scrollArea, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 400 }
    });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100,
      left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    section.getBoundingClientRect = () => ({ top: 160 - scrollArea.scrollTop,
      bottom: 360 - scrollArea.scrollTop, height: 200, left: 0, right: 200,
      width: 200, x: 0, y: 160 - scrollArea.scrollTop, toJSON() {} });
    scrollArea.addEventListener('scroll', () => {
      if (section.querySelector('button')) return;
      const option = document.createElement('button');
      option.type = 'button';
      option.dataset.listNavigationItem = 'true';
      option.innerHTML = `<span>${connectorName}</span><span>Custom app</span>`;
      option.getBoundingClientRect = () => ({ top: 180 - scrollArea.scrollTop,
        bottom: 220 - scrollArea.scrollTop, height: 40, left: 0, right: 200,
        width: 200, x: 0, y: 180 - scrollArea.scrollTop, toJSON() {} });
      section.append(option);
    });
    const clicked = vi.fn(() => {
      if (scrollArea.isConnected) scrollArea.remove();
      else document.body.append(scrollArea);
    });
    add.addEventListener('click', clicked);

    const readOption = api.connectorMenuOptionReader(connectorName);
    expect(api.openConnectorMenu(connectorName)).toBe(true);
    expect(readOption()).toBeNull(); // closes only through the captured composer control
    expect(scrollArea.isConnected).toBe(false);
    expect(readOption()).toBeNull(); // reopens through that same control
    expect(scrollArea.isConnected).toBe(true);
    const option = readOption();
    expect(option).toBe(section.querySelector('button'));
    expect(clicked).toHaveBeenCalledTimes(2);
    expect(scrollArea.scrollTop).toBeGreaterThan(0);
  });
  it('causally accepts only a new structured token coupled to retirement of the exact clicked row', async () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    box.closest('form')!.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span><span>Custom app</span>`;
    option.getBoundingClientRect = () => ({ top: 20, bottom: 60, height: 40, left: 0, right: 200, width: 200, x: 0, y: 20, toJSON() {} });
    section.append(option); scrollArea.append(section); document.body.append(scrollArea);
    Object.defineProperties(scrollArea, { clientHeight: { value: 100 }, scrollHeight: { value: 100 } });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    const normalized = { appId: 'asdk_app_recreated_normalized', connectorName: 'Luna Forge X7 Core' };
    option.addEventListener('click', () => {
      option.remove();
      const mention = document.createElement('span');
      mention.setAttribute('app-mention-display-name', normalized.connectorName);
      mention.setAttribute('app-mention-path', `app://${normalized.appId}`);
      mention.setAttribute('contenteditable', 'false');
      mention.textContent = normalized.connectorName;
      box.append(mention);
    });
    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    expect(selection.read()).toEqual(normalized);
    selection.dispose();
  });
  it('collects the native menu token without spending a throttled page timer (#1514 custom owner)', async () => {
    // This fork uses the native Add-context transaction, not upstream's inline mention timer.
    // Keep its exact clicked-row/token proof and prove it needs only MutationObserver delivery.
    const { option } = coreMenu();
    option.addEventListener('click', () => {
      option.remove();
      box.append(coreMention());
    });
    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve(); // No fake page timer advances.
    expect(selection.read()).toEqual({ appId, connectorName });
    selection.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects even the expected token when it appears before the exact clicked row retires', async () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    box.closest('form')!.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    const option = document.createElement('button');
    option.type = 'button'; option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span>`;
    option.getBoundingClientRect = () => ({ top: 20, bottom: 60, height: 40, left: 0, right: 200, width: 200, x: 0, y: 20, toJSON() {} });
    section.append(option); scrollArea.append(section); document.body.append(scrollArea);
    Object.defineProperties(scrollArea, { clientHeight: { value: 100 }, scrollHeight: { value: 100 } });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    option.addEventListener('click', () => {
      const premature = document.createElement('span');
      premature.setAttribute('app-mention-display-name', connectorName);
      premature.setAttribute('app-mention-path', `app://${appId}`);
      premature.setAttribute('contenteditable', 'false');
      box.append(premature);
    });
    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    expect(selection.read()).toBeNull();
    expect(option.isConnected).toBe(true);
    selection.dispose();
  });
  it.each([
    { tokenAppId: appId, tokenName: connectorName, accepted: true },
    { tokenAppId: 'asdk_app_premature_normalized', tokenName: 'Luna Forge X7 Core', accepted: false }
  ])('requires pinned identity for a $tokenAppId token committed before menu retirement', async token => {
    const { option } = coreMenu();
    option.addEventListener('click', () => {
      box.append(coreMention(token.tokenAppId, token.tokenName));
      option.remove();
    });

    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    expect(api.nativeConnectorMentionIdentity()).toEqual({
      appId: token.tokenAppId, connectorName: token.tokenName
    });
    expect(selection.read()).toEqual(token.accepted
      ? { appId: token.tokenAppId, connectorName: token.tokenName } : null);
    selection.dispose();
  });
  it.each(['before retirement', 'after retirement'] as const)(
  'rejects a foreign post-click token inserted %s of the exact row', async order => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    box.closest('form')!.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    const option = document.createElement('button');
    option.type = 'button'; option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span>`;
    option.getBoundingClientRect = () => ({ top: 20, bottom: 60, height: 40,
      left: 0, right: 200, width: 200, x: 0, y: 20, toJSON() {} });
    section.append(option); scrollArea.append(section); document.body.append(scrollArea);
    Object.defineProperties(scrollArea, { clientHeight: { value: 100 }, scrollHeight: { value: 100 } });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100,
      left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    option.addEventListener('click', () => {
      const appendForeign = () => {
        const foreign = document.createElement('span');
        foreign.setAttribute('app-mention-display-name', 'Foreign Core');
        foreign.setAttribute('app-mention-path', 'app://asdk_app_foreign');
        foreign.setAttribute('contenteditable', 'false');
        box.append(foreign);
      };
      if (order === 'before retirement') { appendForeign(); option.remove(); }
      else { option.remove(); appendForeign(); }
    });

    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    expect(selection.read()).toBeNull();
    expect(option.isConnected).toBe(false);
    expect(api.nativeConnectorMentionIdentity()).toEqual({
      appId: 'asdk_app_foreign', connectorName: 'Foreign Core'
    });
    selection.dispose();
  });
  it('rejects a transient foreign token even when it is removed before observer delivery', async () => {
    const { option } = coreMenu();
    option.addEventListener('click', () => {
      const foreign = coreMention('asdk_app_transient_foreign', 'Foreign Core');
      box.append(foreign);
      foreign.remove();
      option.remove();
      box.append(coreMention());
    });

    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    expect(api.nativeConnectorMentionIdentity()).toEqual({ appId, connectorName });
    expect(selection.read()).toBeNull();
    selection.dispose();
  });
  it('keeps a transient token contaminating after the exact composer is remounted in the captured form', async () => {
    const { option } = coreMenu();
    option.addEventListener('click', () => {
      const foreign = coreMention('asdk_app_remount_foreign', 'Foreign Core');
      box.append(foreign);
      foreign.remove();
      const remounted = box.cloneNode(false) as HTMLElement;
      box.replaceWith(remounted);
      option.remove();
      remounted.append(coreMention());
    });

    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    expect(api.nativeConnectorMentionIdentity()).toEqual({ appId, connectorName });
    expect(selection.read()).toBeNull();
    selection.dispose();
  });
  it('rejects a transient second exact row instead of treating ambiguity as retirement', async () => {
    const { section, option } = coreMenu();
    option.addEventListener('click', () => {
      const duplicate = option.cloneNode(true) as HTMLButtonElement;
      section.append(duplicate);
      duplicate.remove();
      option.remove();
      box.append(coreMention());
    });

    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    expect(api.nativeConnectorMentionIdentity()).toEqual({ appId, connectorName });
    expect(selection.read()).toBeNull();
    selection.dispose();
  });
  it('rejects a token when the removed exact row is remounted before observer delivery', async () => {
    const { section, option } = coreMenu();
    option.addEventListener('click', () => {
      option.remove();
      box.append(coreMention());
      section.append(option);
    });

    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    expect(option.isConnected).toBe(true);
    expect(api.nativeConnectorMentionIdentity()).toEqual({ appId, connectorName });
    expect(selection.read()).toBeNull();
    selection.dispose();
  });
  it('rejects a same-label app-id migration that arrives in a later observer batch', async () => {
    const { option } = coreMenu();
    option.addEventListener('click', () => option.remove());
    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    box.append(coreMention('asdk_app_unrelated_later'));
    await Promise.resolve();

    expect(api.nativeConnectorMentionIdentity()).toEqual({
      appId: 'asdk_app_unrelated_later', connectorName
    });
    expect(selection.read()).toBeNull();
    selection.dispose();
  });
  it.each(['route', 'form', 'control'] as const)(
  'revokes an exact post-click receipt when its captured %s authority changes', async authority => {
    const { add, option } = coreMenu();
    option.addEventListener('click', () => {
      option.remove();
      box.append(coreMention());
      if (authority === 'route') dom.reconfigure({ url: 'https://chatgpt.com/c/foreign-route' });
      if (authority === 'form') {
        const form = box.closest('form')!;
        form.replaceWith(form.cloneNode(true));
      }
      if (authority === 'control') add.replaceWith(add.cloneNode(true));
    });

    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    expect(selection.read()).toBeNull();
    selection.dispose();
  });
  it('accepts a normalized token after the captured exact row retires semantically while staying mounted', async () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    box.closest('form')!.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    const option = document.createElement('button');
    option.type = 'button'; option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span>`;
    option.getBoundingClientRect = () => ({ top: 20, bottom: 60, height: 40,
      left: 0, right: 200, width: 200, x: 0, y: 20, toJSON() {} });
    section.append(option); scrollArea.append(section); document.body.append(scrollArea);
    Object.defineProperties(scrollArea, { clientHeight: { value: 100 }, scrollHeight: { value: 100 } });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100,
      left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    const normalized = { appId: 'asdk_app_semantic_recreated', connectorName: 'Luna Forge X7 Core' };
    option.addEventListener('click', () => {
      option.setAttribute('aria-hidden', 'true');
      const mention = document.createElement('span');
      mention.setAttribute('app-mention-display-name', normalized.connectorName);
      mention.setAttribute('app-mention-path', `app://${normalized.appId}`);
      mention.setAttribute('contenteditable', 'false');
      box.append(mention);
    });

    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    expect(option.isConnected).toBe(true);
    expect(selection.read()).toEqual(normalized);
    selection.dispose();
  });
  it.each(['viewport', 'portal wrapper'] as const)(
  'accepts the exact token after its captured menu %s retires semantically', async owner => {
    const { scrollArea, option } = coreMenu();
    let hideTarget = scrollArea;
    if (owner === 'portal wrapper') {
      const wrapper = document.createElement('div');
      scrollArea.replaceWith(wrapper);
      wrapper.append(scrollArea);
      hideTarget = wrapper;
    }
    option.addEventListener('click', () => {
      hideTarget.setAttribute('aria-hidden', 'true');
      box.append(coreMention());
    });

    const selection = api.selectConnectorMenuOption(option, connectorName, appId)!;
    await Promise.resolve();
    expect(option.isConnected).toBe(true);
    expect(selection.read()).toEqual({ appId, connectorName });
    selection.dispose();
  });
  it('refuses duplicate, out-of-section, and ambiguous exact app authorities', () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    box.closest('form')!.prepend(add);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    scrollArea.append(section);
    document.body.append(scrollArea);
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.listNavigationItem = 'true';
    option.innerHTML = `<span>${connectorName}</span>`;
    document.body.append(option);
    expect(api.connectorMenuOption(connectorName)).toBe(option);
    expect(api.connectorMenuOptionReader(connectorName)()).toBeNull();

    section.append(option);
    const duplicate = option.cloneNode(true) as HTMLButtonElement;
    section.append(duplicate);
    expect(api.connectorMenuOption(connectorName)).toBeNull();
    duplicate.remove();
    const ambiguousSection = section.cloneNode(false) as HTMLElement;
    scrollArea.append(ambiguousSection);
    expect(api.connectorMenuOptionReader(connectorName)()).toBeNull();
  });
  it('keeps the exact button/span identity fail closed and bounds hydration scrolls', () => {
    const add = document.createElement('button');
    add.type = 'button';
    add.dataset.composerNavigationTarget = 'add-context';
    box.closest('form')!.prepend(add);
    const readOption = api.connectorMenuOptionReader(connectorName);
    const scrollArea = document.createElement('div');
    scrollArea.dataset.mentionListScrollArea = 'true';
    const section = document.createElement('div');
    section.dataset.mentionSectionId = 'plugins';
    scrollArea.append(section);
    document.body.append(scrollArea);
    Object.defineProperties(scrollArea, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 500 }
    });
    scrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
    section.getBoundingClientRect = () => ({ top: 150 - scrollArea.scrollTop, bottom: 450 - scrollArea.scrollTop, height: 300, left: 0, right: 200, width: 200, x: 0, y: 150 - scrollArea.scrollTop, toJSON() {} });
    const scrolled = vi.fn();
    scrollArea.addEventListener('scroll', scrolled);

    const roleOnly = document.createElement('div');
    roleOnly.setAttribute('role', 'menuitem');
    roleOnly.dataset.listNavigationItem = 'true';
    roleOnly.innerHTML = `<span>${connectorName}</span>`;
    document.body.append(roleOnly);
    const divOnly = document.createElement('button');
    divOnly.dataset.listNavigationItem = 'true';
    divOnly.innerHTML = `<div>${connectorName}</div>`;
    document.body.append(divOnly);
    expect(api.connectorMenuOption(connectorName)).toBeNull();

    expect(readOption()).toBeNull();
    expect(scrollArea.scrollTop).toBe(150);
    expect(scrolled).toHaveBeenCalledOnce();
    expect(readOption()).toBeNull();
    expect(scrollArea.scrollTop).toBe(230);
    expect(scrolled).toHaveBeenCalledTimes(2);
    expect(readOption()).toBeNull();
    expect(scrollArea.scrollTop).toBe(230);
    expect(scrolled).toHaveBeenCalledTimes(2);
  });
  it('accepts the exact native app token beside the editor in the same composer form', () => {
    const mention = document.createElement('span');
    mention.setAttribute('app-mention-display-name', connectorName);
    mention.setAttribute('app-mention-path', `app://${appId}`);
    mention.setAttribute('contenteditable', 'false');
    mention.textContent = connectorName;
    box.before(mention);
    expect(api.connectorMentionSelected(connectorName, appId)).toBe(true);
    expect(api.connectorMentionIdentity(connectorName)).toEqual({ appId });
    expect(api.composerAuthoredText(connectorName, appId)).toBe('Exact app prompt');
  });
  it('normalizes the current label but keeps a frozen old label selection-strict and readable', () => {
    const mention = document.createElement('span');
    mention.setAttribute('app-mention-display-name', connectorName.toLowerCase().replace(/\s+/g, '-'));
    mention.setAttribute('app-mention-path', `app://${appId}`);
    mention.setAttribute('contenteditable', 'false');
    mention.textContent = mention.getAttribute('app-mention-display-name');
    box.textContent = '';
    box.append(mention);
    expect(api.connectorMentionSelected(connectorName, appId)).toBe(true);
    expect(api.composerAuthoredText(connectorName, appId)).toBe('');
    expect(api.connectorMentionSelected(connectorName, 'asdk_app_foreign')).toBe(false);
    expect(api.connectorMentionSelected('Renamed Account Core', appId)).toBe(false);
    expect(api.connectorMentionIdentity('Renamed Account Core')).toBeNull();
    mention.setAttribute('app-mention-display-name', 'Luna Forge Foot');
    mention.textContent = 'Luna Forge Foot';
    expect(api.connectorMentionSelected(connectorName, appId)).toBe(false);
    box.append('saved draft');
    expect(api.composerAuthoredText(connectorName, appId)).toBe('saved draft');
  });
  it('exposes a recreated exact-name identity but refuses foreign names, duplicates, and authored text', () => {
    expect(api.connectorMentionSelected(connectorName, appId)).toBe(false);
    const mention = document.createElement('span');
    mention.setAttribute('app-mention-display-name', connectorName);
    mention.setAttribute('app-mention-path', 'app://asdk_app_foreign');
    mention.setAttribute('contenteditable', 'false');
    mention.textContent = connectorName;
    box.append(mention);
    expect(api.connectorMentionSelected(connectorName, appId)).toBe(false);
    expect(api.connectorMentionIdentity(connectorName)).toEqual({ appId: 'asdk_app_foreign' });
    mention.setAttribute('app-mention-display-name', 'Foreign Core');
    expect(api.connectorMentionIdentity(connectorName)).toBe(null);
    expect(api.nativeConnectorMentionIdentity()).toEqual({ appId: 'asdk_app_foreign', connectorName: 'Foreign Core' });
    mention.setAttribute('app-mention-display-name', connectorName);
    mention.setAttribute('app-mention-path', `app://${appId}`);
    box.append(mention.cloneNode(true));
    expect(api.connectorMentionSelected(connectorName, appId)).toBe(false);
  });
  it('removes only provider-owned zero-width mention boundaries from the authored draft', () => {
    const mention = document.createElement('span');
    mention.setAttribute('app-mention-display-name', connectorName);
    mention.setAttribute('app-mention-path', `app://${appId}`);
    mention.setAttribute('contenteditable', 'false');
    mention.textContent = connectorName;
    box.textContent = `\u200BExact app prompt\u2060`;
    box.append(mention);
    expect(api.composerAuthoredText(connectorName, appId)).toBe('Exact app prompt');
  });
  it('does not trust empty innerText from a detached Chromium editor clone', () => {
    const descriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'innerText');
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get: () => ''
    });
    try {
      const mention = document.createElement('span');
      mention.setAttribute('app-mention-display-name', connectorName);
      mention.setAttribute('app-mention-path', `app://${appId}`);
      mention.setAttribute('contenteditable', 'false');
      mention.textContent = connectorName;
      box.innerHTML = '';
      const paragraph = document.createElement('p');
      paragraph.append(mention, 'Exact app prompt');
      box.append(paragraph);
      expect(api.composerAuthoredText(connectorName, appId)).toBe('Exact app prompt');
    } finally {
      if (descriptor) Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', descriptor);
      else delete (dom.window.HTMLElement.prototype as unknown as Record<string, unknown>).innerText;
    }
  });
  it('preserves inline line breaks inside the provider single-paragraph editor shape', () => {
    const mention = document.createElement('span');
    mention.setAttribute('app-mention-display-name', connectorName);
    mention.setAttribute('app-mention-path', `app://${appId}`);
    mention.setAttribute('contenteditable', 'false');
    mention.textContent = connectorName;
    const first = document.createElement('span');
    first.textContent = 'First authored line';
    const last = document.createElement('span');
    last.textContent = 'Third authored line';
    const paragraph = document.createElement('p');
    paragraph.append(mention, first, document.createElement('br'), document.createElement('br'), last);
    box.replaceChildren(paragraph);

    expect(api.composerAuthoredText(connectorName, appId)).toBe('First authored line\n\nThird authored line');
    mention.setAttribute('app-mention-display-name', 'Luna Forge Foot');
    expect(api.connectorMentionSelected(connectorName, appId)).toBe(false);
    expect(api.composerAuthoredText(connectorName, appId)).toBe('First authored line\n\nThird authored line');
    expect(api.composerAuthoredText(connectorName, 'asdk_app_foreign')).toBeNull();
  });
  it('preserves a blank authored paragraph between separate provider blocks', () => {
    const mention = document.createElement('span');
    mention.setAttribute('app-mention-display-name', connectorName);
    mention.setAttribute('app-mention-path', `app://${appId}`);
    mention.setAttribute('contenteditable', 'false');
    mention.textContent = connectorName;
    const first = document.createElement('p');
    first.append(mention, 'First paragraph');
    const blank = document.createElement('p');
    const last = document.createElement('p');
    last.textContent = 'Third paragraph';
    box.replaceChildren(first, blank, last);

    expect(api.composerAuthoredText(connectorName, appId)).toBe('First paragraph\n\nThird paragraph');
  });
  it('inserts exact authored text after an editor-owned Core token without deleting the token', () => {
    const mention = document.createElement('span');
    mention.setAttribute('app-mention-display-name', connectorName);
    mention.setAttribute('app-mention-path', `app://${appId}`);
    mention.setAttribute('contenteditable', 'false');
    mention.textContent = connectorName;
    box.replaceChildren(mention);
    document.execCommand = (command, _ui, value) => {
      const selection = document.getSelection();
      if (command !== 'insertHTML' || document.activeElement !== box || !selection?.rangeCount) return false;
      const range = selection.getRangeAt(0);
      const template = document.createElement('template');
      template.innerHTML = value || '';
      range.insertNode(template.content);
      return true;
    };
    expect(api.insertPromptWithConnector('Exact app prompt', connectorName, appId)).toBe(true);
    expect(mention.isConnected).toBe(true);
    expect(api.connectorMentionSelected(connectorName, appId)).toBe(true);
    expect(api.composerAuthoredText(connectorName, appId)).toBe('Exact app prompt');
  });
});

describe('a workspace page kept mounted behind the current one', () => {
  it.each([
    ['display', 'none'],
    ['visibility', 'hidden'],
    ['visibility', 'collapse']
  ] as const)('ignores a model-transition editor hidden only by computed %s', (property, value) => {
    const stale = document.createElement('div');
    stale.style[property] = value;
    stale.innerHTML = '<form><div id="prompt-textarea" contenteditable="true">Old transition editor</div></form>';
    document.body.prepend(stale);
    expect(api.composer()).toBe(box);
  });
  it('elects the current classic composer while an older page is undisplayed', () => {
    const page = keptPage();
    page.innerHTML = '<form><div id="prompt-textarea" contenteditable="true">Old page</div></form>';

    expect(api.composer()).toBe(box);
  });

  it('fails closed when two classic composers are displayed', () => {
    const page = keptPage(true);
    page.innerHTML = '<form><div id="prompt-textarea" contenteditable="true">Other page</div></form>';

    expect(api.composer()).toBeNull();
  });

  it("reads only this page's turns, not those of an earlier page kept undisplayed", () => {
    const page = keptPage();
    page.innerHTML = '<section data-testid="conversation-turn-1" data-turn="user" data-turn-id="old-turn"><div data-message-id="old-message" data-message-author-role="user">Source chat question</div></section>';
    user('Resumed chat question');

    expect(api.messages().map(message => message.text)).toEqual(['Resumed chat question']);
  });

  it('ignores generation retained on an earlier undisplayed page', () => {
    const page = keptPage();
    const shell = document.createElement('main');
    shell.setAttribute('data-app-shell-main-surface', 'true');
    shell.innerHTML = `<div data-thread-find-target="conversation"><section data-turn-key="old-turn" data-clf-shell-running="${dom.window.location.pathname}"></section></div>`;
    page.append(shell);

    expect(api.generating()).toBe(false);
    document.body.append(shell);
    expect(api.generating()).toBe(true);
  });

  it('lets a witnessed Stop ignore only the cached shell hint, not native controls', async () => {
    box.textContent = preparedPrompt('Exact app prompt');
    const shell = document.createElement('main');
    shell.setAttribute('data-app-shell-main-surface', 'true');
    shell.innerHTML = `<div data-thread-find-target="conversation"><section data-turn-key="stopped-turn" data-clf-shell-running="${dom.window.location.pathname}"><div data-chatgpt-agent-turn-start="true"></div></section></div>`;
    document.body.append(shell);
    expect(api.generating()).toBe(true);
    expect(api.noteStopClick(button)).toBe(false);

    const stop = document.createElement('button');
    stop.type = 'button';
    stop.dataset.testid = 'stop-button';
    box.closest('form')!.append(stop);
    expect(api.noteStopClick(stop)).toBe(true);
    expect(api.generating()).toBe(true);
    stop.remove();
    expect(api.generating()).toBe(false);
    const nativeSend = vi.fn(() => { box.textContent = ''; });
    button.addEventListener('click', nativeSend);
    expect(await api.send()).toBe(true);
    expect(nativeSend).toHaveBeenCalledOnce();
    expect(shell.querySelector('[data-turn-key]')!.getAttribute('data-clf-shell-running')).toBe(dom.window.location.pathname);
    // A later real control wins, even if it is disabled or ambiguous.
    stop.disabled = true;
    box.closest('form')!.append(stop);
    expect(api.generating()).toBe(true);
    // Ambiguous native controls also remain busy, not mistaken for no Stop.
    stop.after(stop.cloneNode(true));
    expect(api.generating()).toBe(true);
  });

  it.each(['same-question-rescan', 'new-question', 'new-turn', 'replacement-shell', 'later-user', 'route', 'new-stop', 'reset'] as const)(
    'keeps witnessed Stop scoped to its exact exchange (%s)', change => {
      const shell = document.createElement('main');
      shell.setAttribute('data-app-shell-main-surface', 'true');
      shell.innerHTML = `<div data-thread-find-target="conversation"><section data-turn-key="stopped-turn" data-clf-shell-running="${dom.window.location.pathname}" data-clf-fiber-turn="scan-a:0" data-clf-fiber-user="scan-a:0:question-a"><div data-chatgpt-agent-turn-start="true"></div></section></div>`;
      document.body.append(shell);
      const turn = shell.querySelector('[data-turn-key]')!;
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.dataset.testid = 'stop-button';
      box.closest('form')!.append(stop);
      expect(api.noteStopClick(stop)).toBe(true);
      stop.remove();
      expect(api.generating()).toBe(false);

      if (change === 'same-question-rescan' || change === 'new-question') {
        // MAIN scan tokens are ephemeral: unchanged native question identity must survive.
        turn.setAttribute('data-clf-fiber-turn', 'scan-b:0');
        turn.setAttribute('data-clf-fiber-user', `scan-b:0:${change === 'new-question' ? 'question-b' : 'question-a'}`);
      } else if (change === 'new-turn') turn.setAttribute('data-turn-key', 'later-turn');
      else if (change === 'replacement-shell') turn.replaceWith(turn.cloneNode(true));
      else if (change === 'later-user') user('A new instruction');
      else if (change === 'route') {
        dom.reconfigure({ url: 'https://chatgpt.com/c/other' });
        turn.setAttribute('data-clf-shell-running', '/c/other');
        expect(api.generating()).toBe(true);
        dom.reconfigure({ url: 'https://chatgpt.com/' });
        turn.setAttribute('data-clf-shell-running', '/');
      } else if (change === 'new-stop') {
        box.closest('form')!.append(stop);
        expect(api.generating()).toBe(true);
        stop.remove();
      } else api.clearStoppedTurn();
      expect(api.generating()).toBe(change !== 'same-question-rescan');
    }
  );

  it.each(['disabled', 'ambiguous', 'foreign'] as const)('does not witness an ineligible Stop (%s)', change => {
    const shell = document.createElement('main');
    shell.setAttribute('data-app-shell-main-surface', 'true');
    shell.innerHTML = `<div data-thread-find-target="conversation"><section data-turn-key="unstopped-turn" data-clf-shell-running="${dom.window.location.pathname}"><div data-chatgpt-agent-turn-start="true"></div></section></div>`;
    document.body.append(shell);
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.dataset.testid = 'stop-button';
    box.closest('form')!.append(stop);
    if (change === 'disabled') stop.disabled = true;
    if (change === 'ambiguous') stop.after(stop.cloneNode(true));
    expect(api.noteStopClick(change === 'foreign' ? button : stop)).toBe(false);
    for (const control of document.querySelectorAll('[data-testid="stop-button"]')) control.remove();
    expect(api.generating()).toBe(true);
  });

  it.each([
    'Resume stream unavailable',
    'A network error occurred. Please check your connection and try again.',
    'Message delivery timed out. Please try again.',
    'Message delivery timed out. Please try again later.',
    'Connection interrupted. Please wait for the complete answer.',
    'Stream cache expired',
    'Failed to fetch',
    'Error in message stream',
    'Error in input stream',
    'eRrOr In InPuT StReAm.'
  ])('does not let a stale shell running hint hide the current native failure: %s', (failure) => {
    const shell = document.createElement('main');
    shell.setAttribute('data-app-shell-main-surface', 'true');
    shell.innerHTML = `<div data-thread-find-target="conversation"><div data-turn-key="failed-turn" data-clf-shell-running="${dom.window.location.pathname}"><aside role="alert"><div>${failure} </div><button>Retry</button></aside></div></div>`;
    document.body.append(shell);
    const turn = shell.querySelector('[data-turn-key]')!;
    const notice = turn.querySelector('aside')!;
    expect(api.generating()).toBe(false);
    // Authored error quotations and hidden notices cannot cancel a running hint.
    notice.classList.add('markdown');
    expect(api.generating()).toBe(true);
    notice.classList.remove('markdown');
    notice.setAttribute('hidden', '');
    expect(api.generating()).toBe(true);
    notice.removeAttribute('hidden');
    // A real Stop still wins; failure copy alone must never stop a live response.
    const stop = document.createElement('button');
    stop.setAttribute('data-testid', 'stop-button');
    box.closest('form')!.append(stop);
    expect(api.generating()).toBe(true);
    stop.remove();
    // Exercise the same native Retry action, not just the idle-state predicate.
    box.textContent = '';
    const answer = document.createElement('div');
    answer.setAttribute('data-chatgpt-agent-turn-start', 'true');
    turn.prepend(answer);
    const retry = notice.querySelector('button')!;
    const clicked = vi.fn(); retry.addEventListener('click', clicked);
    const authorize = vi.fn(() => true);
    expect(api.retryLatestTransportFailure(() => true, authorize)).toEqual({ status: 'retried' });
    expect(authorize).toHaveBeenCalledOnce();
    expect(clicked).toHaveBeenCalledOnce();
    expect(api.retryLatestTransportFailure(() => true, authorize).status).toBe('stopped');
    expect(clicked).toHaveBeenCalledOnce();
    const newer = document.createElement('div');
    newer.setAttribute('data-turn-key', 'newer-turn');
    newer.setAttribute('data-clf-shell-running', dom.window.location.pathname);
    turn.after(newer);
    expect(api.generating()).toBe(true);
  });

  it('records native input-stream failure without inventing a missing Retry or Stop action', () => {
    box.textContent = '';
    const shell = document.createElement('main');
    shell.setAttribute('data-app-shell-main-surface', 'true');
    shell.innerHTML = '<div data-thread-find-target="conversation"><div data-turn-key="failed-input-turn"><div data-chatgpt-agent-turn-start="true"></div><aside role="alert">Error in input stream</aside></div></div>';
    document.body.append(shell);
    const notice = shell.querySelector('aside')!;
    expect(api.errors()).toEqual([expect.objectContaining({ text: 'Error in input stream', node: notice, recoverable: true })]);
    expect(api.errors()[0]).not.toHaveProperty('retry');
    const authorize = vi.fn(() => true);
    expect(api.retryLatestTransportFailure(() => true, authorize)).toEqual({ status: 'stopped', reason: 'retry_not_ready' });
    expect(authorize).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="stop-button"]')).toBeNull();
    expect(box.textContent).toBe('');
  });

  it.each(['plain user text', 'user Markdown', 'user code', 'assistant discussion'])
  ('does not promote quoted input-stream error in %s', shape => {
    if (shape === 'assistant discussion') {
      const section = document.createElement('section');
      section.dataset.testid = 'conversation-turn-discussion'; section.dataset.turn = 'assistant';
      section.innerHTML = '<div class="markdown">The text "Error in input stream" describes a provider failure, not this discussion.<button>Retry</button></div>';
      document.body.append(section);
    } else {
      user('Error in input stream');
      const message = document.querySelector('[data-message-author-role="user"]')!;
      if (shape === 'user Markdown') message.innerHTML = '<div class="markdown">Error in input stream<button>Retry</button></div>';
      if (shape === 'user code') message.innerHTML = '<div class="markdown"><pre><code>Error in input stream</code></pre><button>Retry</button></div>';
    }
    expect(api.errors()).toEqual([]);
    box.textContent = '';
    const authorize = vi.fn(() => true);
    expect(api.retryLatestTransportFailure(() => true, authorize).status).toBe('stopped');
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each(['Markdown', 'blockquote', 'code', 'alert in Markdown'])
  ('retains exact authored input-stream quotation in assistant %s without recovery authority', shape => {
    const section = document.createElement('section');
    section.dataset.testid = 'conversation-turn-exact-quote'; section.dataset.turn = 'assistant';
    section.dataset.turnId = 'exact-quote';
    const phrase = 'Error in input stream';
    const markup = shape === 'blockquote' ? `<blockquote>${phrase}</blockquote>`
      : shape === 'code' ? `<pre><code>${phrase}</code></pre>`
      : shape === 'alert in Markdown' ? `<div role="alert">${phrase}</div>` : phrase;
    section.innerHTML = `<div class="markdown">${markup}</div>`;
    document.body.append(section);
    expect(api.errors()).toEqual([]);
    expect(api.messages()).toEqual([expect.objectContaining({ text: phrase })]);
    box.textContent = '';
    const authorize = vi.fn(() => true);
    expect(api.retryLatestTransportFailure(() => true, authorize).status).toBe('stopped');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('does not grant recovery for an exact input-stream alert quoted by a user', () => {
    user('Error in input stream');
    document.querySelector('[data-message-author-role="user"]')!.innerHTML =
      '<blockquote><div role="alert">Error in input stream</div><button>Retry</button></blockquote>';
    expect(api.errors()).toEqual([]);
    expect(api.messages()).toEqual([expect.objectContaining({ text: 'Error in input stream' })]);
  });

  it('keeps legacy exact message-stream fallback behavior unchanged', () => {
    const section = document.createElement('section');
    section.dataset.testid = 'conversation-turn-legacy-message-error'; section.dataset.turn = 'assistant';
    section.innerHTML = '<div class="markdown">Error in message stream</div>';
    document.body.append(section);
    expect(api.errors()).toEqual([expect.objectContaining({ text: 'Error in message stream', recoverable: true })]);
    expect(api.messages()).toEqual([]);
  });
});

describe('native Project entry readiness', () => {
  const entry = { id: 'g-p-11111111222233334444555555555555', sourceConversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
  const projectUrl = `https://chatgpt.com/g/${entry.id}-example/project`;
  function sourceLink(markup = `<a href="${projectUrl}"><span data-testid="project-folder-icon"></span>Project</a>`) {
    dom.reconfigure({ url: `https://chatgpt.com/c/${entry.sourceConversationId}` });
    const header = document.createElement('header');
    header.innerHTML = markup;
    document.body.prepend(header);
    return header.querySelector('a')!;
  }

  it('waits for the mounted source editor before spending its one native click', async () => {
    const link = sourceLink();
    box.textContent = '';
    box.remove();
    const clicks = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', clicks);
    const entered = api.enterProject(entry);
    // The native header can mount before its source chat. A premature click can be
    // swallowed while the provider is hydrating, leaving the one-click attempt spent.
    await Promise.resolve();
    expect(clicks).not.toHaveBeenCalled();
    link.addEventListener('click', () => {
      dom.reconfigure({ url: projectUrl });
      box.replaceWith(box.cloneNode(true));
    });
    document.querySelector('form')!.prepend(box);
    expect(await entered).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('enters through the current Project header link without the retired folder-icon test id', async () => {
    const link = sourceLink(`<a href="/g/${entry.id}/project" data-discover="true"><span><svg></svg></span><span>Project</span></a>`);
    box.textContent = '';
    link.addEventListener('click', event => {
      event.preventDefault();
      dom.reconfigure({ url: projectUrl });
      box.replaceWith(box.cloneNode(true));
    });

    expect(await api.enterProject(entry)).toBe(true);
  });

  it('accepts the exact Project home when ChatGPT keeps the same editor element', async () => {
    const link = sourceLink(`<a href="/g/${entry.id}/project"><span>Project</span></a>`);
    box.textContent = '';
    user('Earlier source turn');
    const turn = document.querySelector('section[data-testid^="conversation-turn"]')!;
    const originalEditor = box;
    link.addEventListener('click', event => {
      event.preventDefault();
      dom.reconfigure({ url: projectUrl });
      dom.window.setTimeout(() => turn.remove(), 300);
    });

    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(200);
    let settled = false;
    void entered.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);

    expect(await entered).toBe(true);
    expect(document.getElementById('prompt-textarea')).toBe(originalEditor);
  });

  it('enters the unique provider Project link after it moves outside the retired header shell', async () => {
    const link = sourceLink(`<a href="/g/${entry.id}/project">Project</a>`);
    document.body.prepend(link);
    box.textContent = '';
    const clicks = vi.fn((event: Event) => {
      event.preventDefault();
      dom.reconfigure({ url: projectUrl });
      box.replaceWith(box.cloneNode(true));
    });
    link.addEventListener('click', clicks);
    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(57_000);
    expect(await entered).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('does not navigate a quoted Project link outside the provider header', async () => {
    dom.reconfigure({ url: `https://chatgpt.com/c/${entry.sourceConversationId}` });
    box.textContent = '';
    user('A quoted link is not a native Project navigation control');
    const quoted = document.createElement('a');
    quoted.href = projectUrl;
    quoted.textContent = 'Project';
    document.querySelector('[data-message-author-role="user"]')!.append(quoted);
    const clicks = vi.fn((event: Event) => event.preventDefault());
    quoted.addEventListener('click', clicks);
    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(57_000);
    expect(await entered).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
  });

  it('ignores source turns retained in an undisplayed page surface', async () => {
    const link = sourceLink(`<a href="/g/${entry.id}/project"><span>Project</span></a>`);
    box.textContent = '';
    user('Earlier source turn');
    const turn = document.querySelector('section[data-testid^="conversation-turn"]')!;
    link.addEventListener('click', event => {
      event.preventDefault();
      dom.reconfigure({ url: projectUrl });
      const page = keptPage();
      page.append(turn);
    });

    expect(await api.enterProject(entry)).toBe(true);
    expect(turn.isConnected).toBe(true);
  });

  it('ignores a duplicate Project link retained in an undisplayed page surface', async () => {
    sourceLink(`<div data-app-shell-page-surface="true" style="display:none"><a href="/g/${entry.id}/project">Old Project</a></div><a href="/g/${entry.id}/project">Current Project</a>`);
    box.textContent = '';
    const shown = document.querySelectorAll('header a')[1]!;
    const clicks = vi.fn((event: Event) => {
      event.preventDefault();
      dom.reconfigure({ url: projectUrl });
    });
    shown.addEventListener('click', clicks);

    expect(await api.enterProject(entry)).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('refuses multiple header links to the same Project instead of guessing', async () => {
    sourceLink(`<a href="/g/${entry.id}/project"><span>A</span></a><a href="/g/${entry.id}/project"><span>B</span></a>`);
    box.textContent = '';
    const clicks = vi.fn((event: Event) => event.preventDefault());
    document.querySelectorAll('header a').forEach(node => node.addEventListener('click', clicks));

    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(57_000);

    expect(await entered).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
  });

  it('gives the native transition its own deadline after source loading', async () => {
    const link = sourceLink();
    box.textContent = '';
    box.remove();
    let clicks = 0;
    link.addEventListener('click', event => {
      event.preventDefault(); clicks++;
      dom.window.setTimeout(() => {
        dom.reconfigure({ url: projectUrl });
        box.replaceWith(box.cloneNode(true));
      }, 2_000);
    });
    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(clicks).toBe(0);
    document.querySelector('form')!.prepend(box);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await entered).toBe(true);
    expect(clicks).toBe(1);
  });

  it('retries the exact native Project link when the first hydrated click is swallowed', async () => {
    const link = sourceLink();
    box.textContent = '';
    let clicks = 0;
    link.addEventListener('click', event => {
      event.preventDefault(); clicks++;
      if (clicks === 2) {
        dom.reconfigure({ url: projectUrl });
        box.replaceWith(box.cloneNode(true));
      }
    });
    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await entered).toBe(true);
    expect(clicks).toBe(2);
  });

  it('tries a swallowed native Project link no more than three times and fails closed', async () => {
    const link = sourceLink();
    box.textContent = '';
    const clicks = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', clicks);
    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await entered).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(3);
    expect(dom.window.location.pathname).toBe(`/c/${entry.sourceConversationId}`);
  });

  it.each(['missing', 'draft', 'cancelled', 'foreign-route'])('never clicks an unready or retired source: %s', async reason => {
    const link = sourceLink();
    box.textContent = reason === 'draft' ? 'Keep my draft' : '';
    box.remove();
    let current = true;
    const clicks = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', clicks);
    const entered = api.enterProject(entry, () => current);
    if (reason === 'cancelled') current = false;
    if (reason === 'foreign-route') dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-1111-4222-8333-444444444444' });
    if (reason !== 'missing') document.querySelector('form')!.prepend(box);
    await vi.advanceTimersByTimeAsync(57_000);
    expect(await entered).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    if (reason === 'draft') expect(box.textContent).toBe('Keep my draft');
  });
});

describe('one native Send and bounded acceptance observation', () => {
  beforeEach(() => { box.textContent = preparedPrompt('Exact app prompt'); });
  function modernStop(label = 'Stop') {
    box.removeAttribute('id');
    box.setAttribute('data-composer-markdown', '');
    box.setAttribute('role', 'textbox');
    box.closest('form')!.setAttribute('data-chatgpt-composer', '');
    button.removeAttribute('data-testid');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.textContent = label;
  }

  it.each(['hidden', 'inert'] as const)('uses the unique remounted rich composer while a stale candidate is %s', state => {
    box.removeAttribute('id');
    box.setAttribute('data-composer-markdown', '');
    box.setAttribute('role', 'textbox');
    const form = box.closest('form')!;
    expect(form.hasAttribute('data-chatgpt-composer')).toBe(false);
    const stale = box.cloneNode(true) as HTMLElement;
    if (state === 'hidden') stale.hidden = true;
    else stale.setAttribute('inert', '');
    form.append(stale);

    expect(api.composer()).toBe(box);
  });

  it('fails closed when multiple remounted rich composers are visible', () => {
    box.removeAttribute('id');
    box.setAttribute('data-composer-markdown', '');
    box.setAttribute('role', 'textbox');
    box.closest('form')!.append(box.cloneNode(true));

    expect(api.composer()).toBeNull();
  });

  it('recognizes the modern plain Stop only inside the elected native composer', () => {
    modernStop();
    const clicked = vi.fn(); button.addEventListener('click', clicked);
    expect(api.generating()).toBe(true);
    expect(api.stopGeneration(() => true)).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();
    document.body.prepend(button);
    expect(api.generating()).toBe(false);
  });

  it('recognizes a translated modern Stop by its unique square icon but not a voice control', () => {
    modernStop('Durdur');
    button.className = 'size-token-button-composer bg-composer-primary';
    button.innerHTML = '<svg><path d="M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5"></path></svg>';
    expect(api.generating()).toBe(true);
    button.setAttribute('data-state', 'closed');
    button.innerHTML = '<svg><path d="M10 2.5v6"></path><path d="M6 6v2"></path></svg>';
    expect(api.generating()).toBe(false);
  });

  it.each([false, true])('retires only the unchanged accepted composer text (new draft: %s)', async edited => {
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      user(preparedPrompt('Exact app prompt'));
      if (edited) box.textContent = 'My next unsent draft';
    });
    expect(await api.send()).toBe(true);
    expect(box.textContent).toBe(edited ? 'My next unsent draft' : '');
  });
  it('recognizes the live Stop answering composer-submit control without treating Start Voice as Stop', () => {
    button.dataset.testid = 'composer-submit-button'; button.setAttribute('aria-label', 'Stop answering');
    const clicked = vi.fn(); button.addEventListener('click', clicked);
    expect(api.stopGeneration(() => true)).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    button.setAttribute('aria-label', 'Start Voice');
    expect(api.stopGeneration(() => true)).toBe(false);
  });
  it.each(['Remove file:', 'Remove file 1:'])('recognizes %s attachment-only drafts before helper cleanup', (label) => {
    box.textContent = '';
    expect(api.hasComposerAttachments()).toBe(false);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', `${label} user.webp`);
    document.querySelector('form')!.append(tile);
    expect(api.hasComposerAttachments()).toBe(true);
    tile.remove();
    const upload = document.createElement('span'); upload.setAttribute('data-inline-file-uploading', '');
    document.querySelector('form')!.append(upload);
    expect(api.hasComposerAttachments()).toBe(true);
  });
  it('stops only a visible enabled native control while exact ownership remains current', () => {
    button.dataset.testid = 'stop-button';
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    expect(api.stopGeneration(() => false)).toBe(false);
    button.disabled = true;
    expect(api.stopGeneration(() => true)).toBe(false);
    button.disabled = false; button.hidden = true;
    expect(api.stopGeneration(() => true)).toBe(false);
    button.hidden = false;
    let checks = 0;
    expect(api.stopGeneration(() => ++checks === 1)).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(api.stopGeneration(() => true)).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });
  it('accepts a composer clear after the old 3-second deadline without sending twice', async () => {
    const clicks = vi.fn(() => dom.window.setTimeout(() => { box.textContent = ''; }, 3200));
    button.addEventListener('click', clicks);
    const result = api.send();
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(3100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('times out once after 30 seconds and never clicks a Send that stays disabled', async () => {
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    const result = api.send({ acceptanceTimeoutMs: Infinity });
    await vi.advanceTimersByTimeAsync(30000);
    expect(await result).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
    button.disabled = true;
    const disabled = api.send();
    await vi.advanceTimersByTimeAsync(30000);
    expect(await disabled).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('acknowledges the exact access-throttle notice and then sends the unchanged worker draft once', async () => {
    button.disabled = true;
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `<h2>Too many requests</h2><p>You're making requests too quickly. We've temporarily limited access to your conversations to protect your data. Please wait a few minutes before trying again.</p><button type="button">Got it</button>`;
    document.body.append(dialog);
    const gotIt = dialog.querySelector('button') as HTMLButtonElement;
    const acknowledgement = vi.fn(() => {
      dialog.remove();
      button.disabled = false;
    });
    gotIt.addEventListener('click', acknowledgement);
    const nativeSend = vi.fn(() => { box.textContent = ''; });
    button.addEventListener('click', nativeSend);

    const result = api.send();
    await Promise.resolve();

    expect(await result).toBe(true);
    expect(acknowledgement).toHaveBeenCalledTimes(1);
    expect(nativeSend).toHaveBeenCalledTimes(1);
  });

  it('allows fresh conversation assignment only with a new exact user message', async () => {
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      user(preparedPrompt('Exact app prompt'));
    });
    expect(await api.send()).toBe(true);
  });

  it('does not accept navigation to an unrelated conversation with an empty composer', async () => {
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      box.textContent = ''; user('An unrelated user message');
    });
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });

  it('fails closed when target ownership is revoked before late acceptance', async () => {
    let current = true;
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    const result = api.send({ stillCurrent: () => current });
    current = false; box.textContent = '';
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('does not retarget an existing conversation even when the new page contains matching text', async () => {
    dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff' });
      user(preparedPrompt('Exact app prompt'));
    });
    expect(await api.send()).toBe(false);
  });

  it('does not confuse missing word boundaries with exact submitted text', async () => {
    box.textContent = preparedPrompt('a b');
    button.addEventListener('click', () => user(preparedPrompt('ab')));
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });

  it('preserves adjacent rich-editor paragraphs when matching the submitted message', async () => {
    box.replaceChildren(...preparedPrompt('first line\nsecond line').split('\n').map(line => {
      const paragraph = document.createElement('p'); paragraph.textContent = line; return paragraph;
    }));
    button.addEventListener('click', () => user(preparedPrompt('first line\nsecond line')));
    expect(await api.send()).toBe(true);
  });

  it('uses a caller-scoped draft comparator before authorization and the one native Send', async () => {
    box.textContent = preparedPrompt('first linesecond line');
    const authorize = vi.fn(async () => true);
    const clicks = vi.fn(() => { box.textContent = ''; });
    button.addEventListener('click', clicks);
    expect(await api.send({
      submittedText: preparedPrompt('first line\nsecond line'),
      readDraftText: () => box.textContent || '',
      matchesDraft: (actual: string, expected: string) => actual.replace(/\s+/g, '') === expected.replace(/\s+/g, ''),
      beforeSend: authorize
    })).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('reports the first fixed refusal reason without changing Send behavior', async () => {
    const explain = vi.fn();
    const nativeClickAttempt = vi.fn();
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    expect(await api.send({ beforeSend: async () => false, onNativeClickAttempt: nativeClickAttempt, explain })).toBe(false);
    expect(explain).toHaveBeenCalledExactlyOnceWith('not-authorized');
    expect(nativeClickAttempt).not.toHaveBeenCalled();
    expect(clicks).not.toHaveBeenCalled();
  });

  it('never publishes a native click attempt from an early Send guard', async () => {
    const nativeClickAttempt = vi.fn();
    box.remove();
    expect(await api.send({ onNativeClickAttempt: nativeClickAttempt })).toBe(false);
    expect(nativeClickAttempt).not.toHaveBeenCalled();
  });

  it('does not mistake a remounted historical message for the newly submitted prompt', async () => {
    user(preparedPrompt('Exact app prompt'));
    button.addEventListener('click', () => {
      document.querySelector('section')!.remove();
      user(preparedPrompt('Exact app prompt'));
    });
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });
});

describe('composer-owned controls and Send readiness', () => {
  beforeEach(() => { box.textContent = preparedPrompt('Exact app prompt'); });
  it.each(['allowed', 'revoked', 'replaced', 'deadline'])('authorizes only a ready Send and rechecks after authorization (%s)', async state => {
    button.disabled = true;
    let release!: (allowed: boolean) => void;
    const authorize = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const nativeClickAttempt = vi.fn();
    const clicks = vi.fn(() => {
      expect(nativeClickAttempt).toHaveBeenCalledTimes(1);
      box.textContent = '';
    });
    button.addEventListener('click', clicks);
    const sending = api.send({ beforeSend: authorize, onNativeClickAttempt: nativeClickAttempt, acceptanceTimeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(500);
    expect(authorize).not.toHaveBeenCalled();
    button.disabled = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    button.setAttribute('aria-label', 'Send prompt');
    if (state === 'replaced') button.replaceWith(button.cloneNode(true));
    if (state === 'deadline') await vi.advanceTimersByTimeAsync(2000);
    release(state !== 'revoked');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await sending).toBe(state === 'allowed');
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(clicks).toHaveBeenCalledTimes(state === 'allowed' ? 1 : 0);
    expect(nativeClickAttempt).toHaveBeenCalledTimes(state === 'allowed' ? 1 : 0);
  });

  it.each(['disabled', 'aria-disabled', 'unmounted'])('waits for the same draft and its %s Send control without synthetic Enter', async state => {
    const trailing = button.parentElement!;
    if (state === 'disabled') button.disabled = true;
    if (state === 'aria-disabled') button.setAttribute('aria-disabled', 'true');
    if (state === 'unmounted') button.remove();
    const clicks = vi.fn(() => { box.textContent = ''; });
    const keys = vi.fn();
    button.addEventListener('click', clicks); box.addEventListener('keydown', keys);
    const result = api.send({ acceptanceTimeoutMs: 2000 });
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(900);
    expect(settled).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
    button.disabled = false; button.removeAttribute('aria-disabled'); trailing.append(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(keys).not.toHaveBeenCalled();
  });

  it.each(['draft', 'editor', 'route', 'authority', 'other-generation'])('revokes a waiting Send when its %s changes', async reason => {
    button.remove();
    const keys = vi.fn(); box.addEventListener('keydown', keys);
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    let current = true;
    const result = api.send({ acceptanceTimeoutMs: 2000, stillCurrent: () => current });
    await vi.advanceTimersByTimeAsync(50);
    if (reason === 'draft') box.textContent = 'A newer user draft';
    if (reason === 'editor') box.replaceWith(box.cloneNode(true));
    if (reason === 'route') dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    if (reason === 'authority') current = false;
    if (reason === 'other-generation') {
      const stop = document.createElement('button'); stop.dataset.testid = 'stop-button';
      document.querySelector('form')!.append(stop);
    }
    document.querySelector('form')!.append(button);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
  });

  it.each(['hidden', 'inert', 'transcript', 'other-form'])('does not let a %s Stop control block this composer', async place => {
    const stale = document.createElement('button'); stale.dataset.testid = 'stop-button';
    const host = document.createElement(place === 'other-form' ? 'form' : 'section');
    if (place === 'hidden') host.hidden = true;
    if (place === 'inert') host.setAttribute('inert', '');
    if (place === 'transcript') host.dataset.testid = 'conversation-turn-100';
    host.append(stale);
    if (place === 'hidden' || place === 'inert') document.querySelector('form')!.prepend(host);
    else document.body.prepend(host);
    expect(api.generating()).toBe(false);
    button.addEventListener('click', () => { box.textContent = ''; });
    expect(await api.send()).toBe(true);
  });

  it('uses only the visible Send in the current form and never a quoted or hidden control', async () => {
    const stale = button.cloneNode(true) as HTMLButtonElement;
    stale.hidden = true; button.parentElement!.prepend(stale);
    const quote = document.createElement('section'); quote.dataset.testid = 'conversation-turn-100';
    const quotedSend = button.cloneNode(true); quote.append(quotedSend); document.body.prepend(quote);
    const wrong = vi.fn(); stale.addEventListener('click', wrong); quotedSend.addEventListener('click', wrong);
    const clicks = vi.fn(() => { box.textContent = ''; }); button.addEventListener('click', clicks);
    expect(api.sendButton()).toBe(button);
    expect(await api.send()).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(wrong).not.toHaveBeenCalled();
  });

  it('does not guess between two visible Send controls while the composer is remounting', async () => {
    const duplicate = button.cloneNode(true) as HTMLButtonElement;
    button.parentElement!.append(duplicate);
    const wrong = vi.fn(); duplicate.addEventListener('click', wrong);
    const clicks = vi.fn(() => { box.textContent = ''; }); button.addEventListener('click', clicks);
    expect(api.sendButton()).toBeNull();
    const result = api.send({ acceptanceTimeoutMs: 2000 });
    expect(clicks).not.toHaveBeenCalled();
    duplicate.remove(); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(wrong).not.toHaveBeenCalled();
  });
});

function upload() {
  const input = document.createElement('input');
  input.id = 'upload-photos'; input.type = 'file'; input.accept = 'image/*';
  Object.defineProperty(input, 'files', { writable: true, value: [] });
  document.querySelector('form')!.append(input);
  class Transfer {
    files: File[] = [];
    items = { add: (file: File) => { this.files.push(file); } };
  }
  Object.defineProperty(dom.window, 'DataTransfer', { value: Transfer });
  return input;
}
describe('transport failures in Portuguese', () => {
  it('recognises the delivery timeout alert with its localized Retry', () => {
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.innerHTML = '<p>A entrega da mensagem atingiu o tempo limite. Tente novamente.</p><button>Tentar novamente</button>';
    document.body.append(alert);
    expect(api.errors()).toEqual([expect.objectContaining({ recoverable: true })]);
    alert.remove();
  });
  it('recognises the interrupted-connection card by its Retry control', () => {
    const card = document.createElement('div');
    card.innerHTML = '<p>Conexão interrompida. Aguardando a resposta completa </p><button>Tentar novamente</button>';
    document.body.append(card);
    expect(api.errors()).toEqual([
      expect.objectContaining({ text: 'Conexão interrompida. Aguardando a resposta completa', recoverable: true })
    ]);
    card.remove();
  });
  it('still ignores other Portuguese announcements', () => {
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = 'Configurações salvas';
    document.body.append(alert);
    expect(api.errors()).toEqual([]);
    alert.remove();
  });
});

describe('native image readiness', () => {
  it.each(['rename', 'replacement', 'extra file', 'cancel'])('retains exact image upload nodes across %s while processing', async change => {
    const input = upload();
    const tile = document.createElement('button');
    tile.setAttribute('aria-label', 'Remove file 1: app.webp');
    let current = true;
    input.addEventListener('change', () => {
      document.querySelector('form')!.append(tile);
      button.setAttribute('aria-disabled', 'true');
    });
    const uploaded = api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => current);
    await vi.advanceTimersByTimeAsync(0);
    if (change === 'rename') tile.setAttribute('aria-label', 'Remove file 1: app(1).webp');
    if (change === 'replacement') tile.replaceWith(tile.cloneNode(true));
    if (change === 'extra file') tile.after(tile.cloneNode(true));
    if (change === 'cancel') current = false;
    button.setAttribute('aria-disabled', 'false');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await uploaded).toBe(change === 'rename');
  });
  it('waits for ARIA-only Send readiness after an attachment tile appears', async () => {
    const input = upload();
    input.addEventListener('change', () => {
      const tile = document.createElement('button');
      tile.setAttribute('aria-label', 'Remove file 1: app.webp');
      document.querySelector('form')!.append(tile);
      button.setAttribute('aria-disabled', 'true');
    });
    const uploaded = api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }]);
    let ready = false; void uploaded.then(value => { ready = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(false);
    expect(ready).toBe(false);
    button.setAttribute('aria-disabled', 'false');
    await vi.advanceTimersByTimeAsync(0);
    expect(await uploaded).toBe(true);
  });
  it('uploads original Markdown bytes and recognizes localized native file actions without duplicate tiles', async () => {
    const input = upload(); input.id = 'upload-files'; input.accept = '';
    const draft = api.captureComposerDraft('Exact app prompt');
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    input.addEventListener('change', () => {
      const tile = document.createElement('div'); tile.setAttribute('role', 'group'); tile.setAttribute('aria-label', 'Notes.md');
      tile.innerHTML = '<div data-default-action="true"><button aria-label="Notes.md"></button></div><button aria-label="删除文件 1: Notes.md"></button>';
      tile.lastElementChild!.addEventListener('click', () => tile.remove());
      document.querySelector('form')!.append(tile);
    });
    const file = new dom.window.File(['# exact markdown'], 'Notes.md', { type: 'text/markdown' });
    expect(await api.uploadImages([], () => true, draft, [file])).toBe(true);
    expect(input.files?.[0]).toBe(file);
    expect(api.hasComposerAttachments()).toBe(true);
    expect(await draft.clear()).toBe(true);
    expect(api.hasComposerAttachments()).toBe(false); draft.dispose();
  });
  it('withdraws only the exact prepared app text and ready attachment nodes before Send', async () => {
    const input = upload();
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    const draft = api.captureComposerDraft('Exact app prompt');
    const tile = document.createElement('button'); tile.type = 'button'; tile.setAttribute('aria-label', 'Remove file 1: app.webp');
    tile.addEventListener('click', () => tile.remove());
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => true, draft)).toBe(true);
    expect(await draft.clear()).toBe(true);
    expect(tile.isConnected).toBe(false); expect(box.textContent).toBe(''); draft.dispose();
  });
  it.each(['edited text', 'extra attachment', 'replacement attachment', 'navigation'])('preserves the entire draft after %s breaks exact ownership', async reason => {
    const input = upload();
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    let current = true;
    const draft = api.captureComposerDraft('Exact app prompt', () => current);
    const tile = document.createElement('button'); tile.type = 'button'; tile.setAttribute('aria-label', 'Remove file 1: app.webp');
    const removed = vi.fn(); tile.addEventListener('click', removed);
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => current, draft)).toBe(true);
    if (reason === 'edited text') box.textContent += ' user change';
    if (reason === 'extra attachment') tile.after(tile.cloneNode(true));
    if (reason === 'replacement attachment') tile.replaceWith(tile.cloneNode(true));
    if (reason === 'navigation') current = false;
    expect(await draft.clear()).toBe(false);
    expect(removed).not.toHaveBeenCalled(); expect(box.textContent).not.toBe(''); draft.dispose();
  });
  it('withdraws exact app text across one remount while the route and source remain current', () => {
    document.execCommand = command => { if (command === 'delete') api.composer()?.replaceChildren(); return true; };
    const draft = api.captureComposerDraft('Exact app prompt', () => true);
    const replacement = box.cloneNode(true) as HTMLElement;
    box.replaceWith(replacement);
    box = replacement;
    expect(draft.current()).toBe(false);
    expect(draft.withdraw()).toBe(true);
    expect(box.textContent).toBe('');
    draft.dispose();
  });
  it('preserves equal remounted text after navigation revokes its route and source', () => {
    document.execCommand = command => { if (command === 'delete') api.composer()?.replaceChildren(); return true; };
    let current = true;
    const draft = api.captureComposerDraft('Exact app prompt', () => current);
    current = false;
    const replacement = box.cloneNode(true) as HTMLElement;
    box.replaceWith(replacement);
    box = replacement;
    expect(draft.withdraw()).toBe(false);
    expect(box.textContent).toBe('Exact app prompt');
    draft.dispose();
  });
  it('allows a live cleanup-only lease without reviving the revoked Send lease', async () => {
    document.execCommand = command => {
      if (command === 'selectAll') document.getSelection()!.selectAllChildren(box);
      if (command === 'delete') document.getSelection()!.getRangeAt(0).deleteContents();
      return true;
    };
    let sourceCurrent = true;
    const draft = api.captureComposerDraft('Exact app prompt', () => sourceCurrent, () => true);
    sourceCurrent = false;
    expect(draft.current()).toBe(false);
    expect(await draft.clear()).toBe(false);
    expect(draft.rebind()).toBe(false);
    expect(draft.withdraw()).toBe(true);
    expect(box.textContent).toBe('');
    draft.dispose();
  });
  it.each(['route', 'trusted edit', 'text', 'attachment', 'editor', 'Core identity', 'Core node',
    'focus mutation', 'second focus mutation', 'selection mutation'] as const)(
    'preserves an opt-in cleanup draft after %s changes', async change => {
      document.execCommand = command => {
        if (command === 'selectAll') document.getSelection()!.selectAllChildren(api.composer()!);
        if (command === 'delete') document.getSelection()!.getRangeAt(0).deleteContents();
        return true;
      };
      const core = document.createElement('span');
      core.setAttribute('contenteditable', 'false');
      core.setAttribute('app-mention-path', 'app://asdk_app_exact_core');
      core.setAttribute('app-mention-display-name', 'Exact Core');
      core.textContent = 'Exact Core'; box.prepend(core);
      const value = box.textContent!;
      const host = document.querySelector('form')!;
      let trustedInput!: EventListener;
      const add = host.addEventListener.bind(host);
      vi.spyOn(host, 'addEventListener').mockImplementation((type, listener, options) => {
        if (type === 'input' && options === true) trustedInput = listener as EventListener;
        add(type, listener, options);
      });
      let cleanupCurrent = true;
      const draft = api.captureComposerDraft(value, () => false, () => cleanupCurrent);
      if (change === 'route') cleanupCurrent = false;
      if (change === 'trusted edit') trustedInput({ isTrusted: true } as Event);
      if (change === 'text') box.append(' personal');
      if (change === 'attachment') {
        const attachment = document.createElement('button'); attachment.setAttribute('aria-label', 'Remove file: personal.webp');
        host.append(attachment);
      }
      if (change === 'editor') { const replacement = box.cloneNode(true) as HTMLElement; box.replaceWith(replacement); box = replacement; }
      if (change === 'Core identity') core.setAttribute('app-mention-path', 'app://asdk_app_foreign_core');
      if (change === 'Core node') core.replaceWith(core.cloneNode(true));
      if (change === 'focus mutation') box.addEventListener('focus', () => core.setAttribute('app-mention-path', 'app://asdk_app_foreign_core'));
      if (change === 'second focus mutation') {
        const focus = box.focus.bind(box); let focuses = 0;
        vi.spyOn(box, 'focus').mockImplementation(() => {
          focus(); if (++focuses === 2) core.setAttribute('app-mention-path', 'app://asdk_app_foreign_core');
        });
      }
      if (change === 'selection mutation') document.execCommand = command => {
        if (command === 'selectAll') cleanupCurrent = false;
        if (command === 'delete') box.replaceChildren();
        return true;
      };
      expect(draft.withdraw()).toBe(false);
      expect(box.textContent).not.toBe('');
      draft.dispose();
    });
  it('does not let strict clear bypass a scoped Core-identity conflict', async () => {
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    const core = document.createElement('span'); core.setAttribute('contenteditable', 'false');
    core.setAttribute('app-mention-path', 'app://asdk_app_exact_core');
    core.setAttribute('app-mention-display-name', 'Exact Core'); core.textContent = 'Exact Core'; box.prepend(core);
    const draft = api.captureComposerDraft(box.textContent!, () => true, () => true);
    core.setAttribute('app-mention-path', 'app://asdk_app_foreign_core');
    expect(await draft.clear()).toBe(false);
    expect(draft.withdraw()).toBe(false);
    expect(box.textContent).toContain('Exact app prompt');
    draft.dispose();
  });
  it('preserves both editors when native selectAll redirects scoped withdrawal to a foreign editable', () => {
    const foreign = document.createElement('div'); foreign.contentEditable = 'true';
    foreign.setAttribute('contenteditable', 'true'); foreign.textContent = 'Private independent draft';
    document.body.append(foreign);
    document.execCommand = command => {
      const selection = document.getSelection()!;
      if (command === 'selectAll') { foreign.focus(); selection.selectAllChildren(foreign); }
      if (command === 'delete') selection.getRangeAt(0).deleteContents();
      return true;
    };
    const draft = api.captureComposerDraft('Exact app prompt', () => false, () => true);
    expect(draft.withdraw()).toBe(false);
    expect(box.textContent).toBe('Exact app prompt');
    expect(foreign.textContent).toBe('Private independent draft');
    draft.dispose();
  });
  it('preserves replacement authored text when native selectAll changes the scoped editor', () => {
    document.execCommand = command => {
      const selection = document.getSelection()!;
      if (command === 'selectAll') { box.textContent = 'Independent replacement draft'; selection.selectAllChildren(box); }
      if (command === 'delete') selection.getRangeAt(0).deleteContents();
      return true;
    };
    const draft = api.captureComposerDraft('Exact app prompt', () => false, () => true);
    expect(draft.withdraw()).toBe(false);
    expect(box.textContent).toBe('Independent replacement draft');
    draft.dispose();
  });
  it('shares one total remount budget between rebind and withdrawal', () => {
    document.execCommand = command => { if (command === 'delete') api.composer()?.replaceChildren(); return true; };
    const draft = api.captureComposerDraft('Exact app prompt', () => true);
    let replacement = box.cloneNode(true) as HTMLElement;
    box.replaceWith(replacement);
    box = replacement;
    expect(draft.rebind()).toBe(true);
    replacement = box.cloneNode(true) as HTMLElement;
    box.replaceWith(replacement);
    box = replacement;
    expect(draft.withdraw()).toBe(false);
    expect(box.textContent).toBe('Exact app prompt');
    draft.dispose();
  });
  it('does not withdraw changed remounted text', () => {
    document.execCommand = command => { if (command === 'delete') api.composer()?.replaceChildren(); return true; };
    const draft = api.captureComposerDraft('Exact app prompt', () => true);
    const replacement = box.cloneNode(true) as HTMLElement;
    replacement.textContent = 'User-authored replacement';
    box.replaceWith(replacement);
    box = replacement;
    expect(draft.withdraw()).toBe(false);
    expect(box.textContent).toBe('User-authored replacement');
    draft.dispose();
  });
  it.each(['Remove file:', 'Remove file 1:'])('waits for matching %s attachment and upload completion before Send', async (label) => {
    const input = upload();
    const tile = document.createElement('button'); tile.type = 'button';
    tile.setAttribute('aria-label', `${label} example.webp`); tile.setAttribute('aria-busy', 'true');
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    const result = api.uploadImages([{ name: 'example.webp', dataUrl: 'data:image/webp;base64,YQ==' }]);
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    tile.removeAttribute('aria-busy');
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
  });

  it('rejects invalid attachments before changing the native file input', async () => {
    const input = upload(); const changed = vi.fn(); input.addEventListener('change', changed);
    expect(await api.uploadImages([{ name: 'bad.webp', dataUrl: 'data:image/png;base64,YQ==' }])).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not add app images to an existing attachment-only draft', async () => {
    const input = upload(); const changed = vi.fn(); input.addEventListener('change', changed);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', 'Remove file: personal.webp');
    document.querySelector('form')!.append(tile);
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }])).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(tile.isConnected).toBe(true);
  });

  it('refuses extra attachments added while the requested upload is completing', async () => {
    const input = upload();
    input.addEventListener('change', () => {
      for (const name of ['app.webp', 'personal.webp']) {
        const tile = document.createElement('button'); tile.setAttribute('aria-label', `Remove file: ${name}`);
        document.querySelector('form')!.append(tile);
      }
    });
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }])).toBe(false);
    expect(document.querySelectorAll('[aria-label^="Remove file:"]')).toHaveLength(2);
  });

  it('requires distinct new tiles with exact filenames rather than substring matches', async () => {
    const input = upload();
    const form = document.querySelector('form')!;
    const old = document.createElement('button'); old.setAttribute('aria-label', 'Other action'); form.append(old);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', 'Remove file: data.webp');
    input.addEventListener('change', () => form.append(tile));
    const result = api.uploadImages(Array.from({ length: 2 }, () => ({ name: 'a.webp', dataUrl: 'data:image/webp;base64,YQ==' })));
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    tile.setAttribute('aria-label', 'Remove file: a.webp');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    const second = document.createElement('button'); second.setAttribute('aria-label', 'Remove file: a.webp'); form.append(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
  });
});

describe('localized roleless transport cards', () => {
  function card(label = 'Reintentar', message = 'Resume stream unavailable', parent: Element = document.body) {
    const node = document.createElement('div');
    const copy = document.createElement('p'); copy.textContent = message;
    const retry = document.createElement('button'); retry.textContent = label;
    node.append(copy, retry); parent.append(node);
    return { node, copy, retry };
  }

  it('reports a bounded localized transport card without granting click authority', () => {
    const { node, retry } = card();
    const clicked = vi.fn(); retry.addEventListener('click', clicked);

    const failure = api.errors().find(error => error.node === node);
    expect(failure).toEqual(expect.objectContaining({
      text: 'Resume stream unavailable', recoverable: true, node
    }));
    expect(failure).not.toHaveProperty('retry');
    expect(clicked).not.toHaveBeenCalled();
  });

  it('admits the exact native input-stream Retry card only through current one-shot authorization', () => {
    box.textContent = '';
    const { node, retry } = card('Retry', 'Error in input stream');
    const clicked = vi.fn(); retry.addEventListener('click', clicked);
    const failure = api.errors().find(error => error.node === node);
    expect(failure).toMatchObject({ text: 'Error in input stream', recoverable: true, retry });
    expect(api.retryLatestTransportFailure(() => false, () => true).status).toBe('stopped');
    expect(api.retryLatestTransportFailure(() => true, () => false))
      .toEqual({ status: 'stopped', reason: 'retry_not_authorized' });
    expect(clicked).not.toHaveBeenCalled();
    expect(api.retryLatestTransportFailure(() => true, () => true)).toEqual({ status: 'retried' });
    expect(clicked).toHaveBeenCalledOnce();
    expect(api.retryLatestTransportFailure(() => true, () => true).status).toBe('stopped');
    expect(clicked).toHaveBeenCalledOnce();
    expect(box.textContent).toBe('');
  });

  it.each(['Markdown', 'blockquote', 'pre', 'code'])
  ('does not promote an input-stream quotation inside %s when Retry sits outside the authored child', shape => {
    box.textContent = '';
    const { copy, retry } = card('Retry', 'Error in input stream');
    const phrase = 'Error in input stream';
    copy.innerHTML = shape === 'Markdown' ? `<span class="markdown">${phrase}</span>` : `<${shape}>${phrase}</${shape}>`;
    const clicked = vi.fn(); retry.addEventListener('click', clicked);
    expect(api.errors()).toEqual([]);
    const authorize = vi.fn(() => true);
    expect(api.retryLatestTransportFailure(() => true, authorize).status).toBe('stopped');
    expect(authorize).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });

  it('does not promote a standalone input-stream blockquote by walking above its quoted Retry', () => {
    box.textContent = '';
    const section = document.createElement('section');
    section.innerHTML = '<blockquote>Error in input stream<button>Retry</button></blockquote>';
    document.body.append(section);
    const clicked = vi.fn(); section.querySelector('button')!.addEventListener('click', clicked);
    expect(api.errors()).toEqual([]);
    const authorize = vi.fn(() => true);
    expect(api.retryLatestTransportFailure(() => true, authorize).status).toBe('stopped');
    expect(authorize).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });

  it.each([
    ['nav', '<nav></nav>'],
    ['aside', '<aside></aside>'],
    ['header', '<header></header>'],
    ['form', '<form></form>'],
    ['navigation role', '<div role="navigation"></div>'],
    ['menu role', '<div role="menu"></div>']
  ])('rejects localized controls inside %s before rendered-text reads', (_name, markup) => {
    const template = document.createElement('template'); template.innerHTML = markup;
    const host = template.content.firstElementChild!; document.body.append(host);
    const { node, retry } = card('Reintentar', 'Resume stream unavailable', host);
    const hostRead = vi.fn(() => host.textContent || '');
    const nodeRead = vi.fn(() => node.textContent || '');
    const buttonRead = vi.fn(() => retry.textContent || '');
    Object.defineProperty(host, 'innerText', { configurable: true, get: hostRead });
    Object.defineProperty(node, 'innerText', { configurable: true, get: nodeRead });
    Object.defineProperty(retry, 'innerText', { configurable: true, get: buttonRead });

    expect(api.errors().some(error => error.node === node)).toBe(false);
    expect(hostRead).not.toHaveBeenCalled();
    expect(nodeRead).not.toHaveBeenCalled();
    expect(buttonRead).not.toHaveBeenCalled();
  });

  it('skips a button-heavy localized sidebar before layout reads while finding the real card', () => {
    const sidebar = document.createElement('nav');
    const reads = vi.fn(() => sidebar.textContent || '');
    Object.defineProperty(sidebar, 'innerText', { configurable: true, get: reads });
    for (let index = 0; index < 300; index++) {
      const row = document.createElement('div');
      const control = document.createElement('button'); control.textContent = `Acción ${index}`;
      const rowRead = vi.fn(() => row.textContent || '');
      const controlRead = vi.fn(() => control.textContent || '');
      Object.defineProperty(row, 'innerText', { configurable: true, get: rowRead });
      Object.defineProperty(control, 'innerText', { configurable: true, get: controlRead });
      row.append(control); sidebar.append(row);
    }
    document.body.append(sidebar);
    const { node } = card();

    for (let scan = 0; scan < 3; scan++) {
      const failure = api.errors().find(error => error.node === node);
      expect(failure).toEqual(expect.objectContaining({ text: 'Resume stream unavailable' }));
      expect(failure).not.toHaveProperty('retry');
    }
    expect(reads).not.toHaveBeenCalled();
    for (const element of sidebar.querySelectorAll<HTMLElement>('div,button')) {
      const descriptor = Object.getOwnPropertyDescriptor(element, 'innerText');
      expect(descriptor?.get).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['Retry', 'form'],
    ['Try again', 'header']
  ])('preserves exact English %s reach inside %s', (label, hostName) => {
    const host = document.createElement(hostName);
    document.body.append(host);
    const { node, retry } = card(label, 'A network error occurred.', host);
    const clicked = vi.fn(); retry.addEventListener('click', clicked);

    const failure = api.errors().find(error => error.node === node);
    expect(failure).toEqual(expect.objectContaining({ retry, recoverable: true }));
    expect(clicked).not.toHaveBeenCalled();
  });

  it('retains exact-English model-cooldown ownership', () => {
    const { node, retry } = card('Retry', 'This model is currently on cooldown');
    const failure = api.errors().find(error => error.node === node);
    expect(failure).toEqual(expect.objectContaining({ reason: 'model_cooldown', retry }));
  });

  it('requires one visible button and the complete card to end in its localized label', () => {
    const multiple = card();
    const other = document.createElement('button'); other.textContent = 'Detalles'; multiple.node.append(other);
    const trailing = card();
    const after = document.createElement('span'); after.textContent = 'more'; trailing.node.append(after);
    const unrelated = card('Reintentar', 'This is an ordinary settings card');

    const failures = api.errors();
    expect(failures.some(error => error.node === multiple.node)).toBe(false);
    expect(failures.some(error => error.node === trailing.node)).toBe(false);
    expect(failures.some(error => error.node === unrelated.node)).toBe(false);
  });

  it.each([
    ['assistant authored prose', '<div data-message-author-role="assistant"></div>'],
    ['user authored prose', '<div data-message-author-role="user"></div>'],
    ['Markdown prose', '<div class="markdown"></div>'],
    ['hidden provider copy', '<div hidden></div>'],
    ['inert provider copy', '<div inert></div>']
  ])('does not promote %s', (_name, markup) => {
    const template = document.createElement('template'); template.innerHTML = markup;
    const host = template.content.firstElementChild!; document.body.append(host);
    const { node } = card('Reintentar', 'Resume stream unavailable', host);
    expect(api.errors().some(error => error.node === node)).toBe(false);
  });

  it('rejects a 500-character card before reading its rendered text', () => {
    const { node, copy, retry } = card();
    copy.textContent = 'x'.repeat(500 - retry.textContent!.length);
    expect(node.textContent).toHaveLength(500);
    const renderedRead = vi.fn(() => node.textContent || '');
    Object.defineProperty(node, 'innerText', { configurable: true, get: renderedRead });

    expect(api.errors().some(error => error.node === node)).toBe(false);
    expect(renderedRead).not.toHaveBeenCalled();
  });
});


describe('provider limit notice', () => {
  it('records and acknowledges the exact Korean access notice once without accepting other dialogs', () => {
    const notice = document.createElement('div'); notice.setAttribute('role', 'dialog');
    notice.innerHTML = '<h2>요청이 너무 많습니다</h2><p>요청을 너무 빠르게 보내고 있습니다. 데이터를 보호하기 위해 대화에 대한 액세스가 일시적으로 제한되었습니다. 몇 분 후 다시 시도해 주세요.</p><button>알겠습니다</button>';
    document.body.append(notice);
    const selectingAt = Date.now();
    const click = vi.fn(); notice.querySelector('button')!.addEventListener('click', click);
    expect(api.errors()).toEqual([expect.objectContaining({ blocking: true, recoverable: false })]);
    expect(click).toHaveBeenCalledTimes(1);
    expect(api.accessNoticeSince(selectingAt)).toContain('요청이 너무 많습니다');
    expect(api.accessNoticeSince(Date.now() + 1000)).toBe('');
    expect(api.accessNoticeSince(Number.NaN)).toBe('');
    dom.reconfigure({ url: 'https://chatgpt.com/c/other-native-conversation' });
    expect(api.accessNoticeSince(selectingAt)).toBe('');
    dom.reconfigure({ url: 'https://chatgpt.com/' });
    api.errors(); expect(click).toHaveBeenCalledTimes(1);
    const unrelated = notice.cloneNode(true) as HTMLElement;
    unrelated.querySelector('h2')!.textContent = 'Permission required';
    const accept = vi.fn(); unrelated.querySelector('button')!.addEventListener('click', accept);
    document.body.append(unrelated); api.errors(); expect(accept).not.toHaveBeenCalled();
    const hidden = notice.cloneNode(true) as HTMLElement; hidden.setAttribute('aria-hidden', 'true');
    hidden.querySelector('button')!.addEventListener('click', accept); document.body.append(hidden);
    api.errors(); expect(accept).not.toHaveBeenCalled();
  });
  it('recognizes only the visible provider access-limit dialog as a blocking nontransport error', () => {
    const notice = document.createElement('div');
    notice.innerHTML = '<h2>Too many requests</h2><p>We have temporarily limited access to conversations to protect your data. Please wait a few minutes.</p>';
    document.body.append(notice);
    expect(api.errors()).toEqual([]);
    notice.setAttribute('role', 'dialog');
    expect(api.errors()).toEqual([expect.objectContaining({ blocking: true, recoverable: false, text: expect.stringContaining('Too many requests') })]);
    notice.querySelector('p')!.setAttribute('role', 'alert');
    expect(api.errors()).toHaveLength(1);
    notice.setAttribute('aria-hidden', 'true'); expect(api.errors()).toEqual([]);
    notice.querySelector('p')!.removeAttribute('role');
    notice.removeAttribute('aria-hidden'); notice.querySelector('p')!.textContent = 'An article about rate limits';
    expect(api.errors()).toEqual([]);
  });
});

describe('ChatGPT Work interstitial', () => {
  const copy = 'This is a substantial production workspace task. Work mode is the better fit for carrying that through end to end. Continue in ChatGPT Work.';

  it('keeps the normal turn busy without clicking the Work migration action', () => {
    document.querySelector('[data-testid="send-button"]')?.remove();
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `<p>${copy}</p><button>Continue in ChatGPT Work</button>`;
    document.body.append(dialog);
    const work = dialog.querySelector('button')!; const click = vi.fn(); work.addEventListener('click', click);

    expect(api.workModeInterstitial()).toBe(dialog);
    expect(api.generating()).toBe(true);
    expect(api.generating()).toBe(true);
    expect(click).not.toHaveBeenCalled();

    dialog.remove();
    expect(api.workModeInterstitial()).toBeNull();
    expect(api.generating()).toBe(false);
  });

  it('does not treat authored or hidden copies as a provider interstitial', () => {
    const authored = document.createElement('section'); authored.dataset.testid = 'conversation-turn-work-quote';
    authored.dataset.turn = 'assistant'; authored.innerHTML = `<div class="markdown">${copy}</div>`;
    document.body.append(authored);
    const hidden = document.createElement('div'); hidden.setAttribute('role', 'dialog'); hidden.hidden = true;
    hidden.textContent = copy; document.body.append(hidden);

    expect(api.workModeInterstitial()).toBeNull();
  });
});

describe('conversation length limit', () => {
  const message = "You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.";

  it('classifies the visible provider alert as one terminal blocking conversation failure', () => {
    const notice = document.createElement('div');
    notice.setAttribute('role', 'alert');
    notice.textContent = message;
    document.body.append(notice);
    expect(api.errors()).toEqual([
      expect.objectContaining({ text: message, reason: 'conversation_limit', recoverable: false, blocking: true })
    ]);
  });

  it('recognizes a non-alert provider card from its exact New Chat control', () => {
    const card = document.createElement('div');
    card.innerHTML = `<p>This chat has reached its limit. Please create a new chat to continue.</p><button>Create a new chat</button>`;
    document.body.append(card);
    expect(api.errors()).toEqual([
      expect.objectContaining({ reason: 'conversation_limit', recoverable: false, blocking: true, node: card })
    ]);
  });

  it('never treats authored user or assistant prose about the same limit as provider chrome', () => {
    user(message);
    const quote = document.createElement('section');
    quote.dataset.testid = 'conversation-turn-limit-quote';
    quote.dataset.turn = 'assistant';
    quote.innerHTML = `<div class="markdown">${message}</div><div class="markdown"><button>Create a new chat</button></div>`;
    document.body.append(quote);
    expect(api.errors()).toEqual([]);
  });
});

describe('Resume stream unavailable without native Retry', () => {
  const token = '0123456789abcdef0123456789abcdef';
  const prompt = prepareOperatorPrompt(`[[CLF-RESUME:${token}]]\n\nContinue the exact saved work.`, upper => upper - 1);

  function failedResume(editorText = prompt) {
    dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    box.textContent = '';
    user(prompt);
    const turn = document.querySelector<HTMLElement>('[data-turn="user"]')!;
    const edit = document.createElement('button'); edit.textContent = 'Edit message';
    turn.append(edit);
    const send = document.createElement('button'); send.textContent = 'Send';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    const sent = vi.fn(); send.addEventListener('click', sent);
    edit.addEventListener('click', () => {
      const editor = document.createElement('div'); editor.setAttribute('contenteditable', 'true');
      editor.setAttribute('role', 'textbox'); editor.textContent = editorText;
      turn.append(editor, send, cancel);
    });
    const failure = document.createElement('div'); failure.setAttribute('role', 'alert');
    failure.textContent = 'Resume stream unavailable'; document.body.append(failure);
    return { edit, send, cancel, sent };
  }

  it('edits and re-submits the exact newest Resume once after persisting caller authority', async () => {
    const { edit, sent } = failedResume();
    const edited = vi.spyOn(edit, 'click');
    let committed = false;
    const result = await api.resubmitExactResumeMessage({
      messageId: 'message-one', token, expectedText: prompt,
      beforeResubmit: () => { committed = true; return true; }
    });
    expect(result).toEqual({ status: 'resubmitted' });
    expect(edited).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledOnce();
    expect(committed).toBe(true);
    expect(await api.resubmitExactResumeMessage({ messageId: 'message-one', token, expectedText: prompt }))
      .toEqual({ status: 'stopped', reason: 'resume_identity_missing' });
  });

  it('cancels the native editor without sending if its exact text changed', async () => {
    const { cancel, sent } = failedResume(`${prompt}\nuser change`);
    const cancelled = vi.spyOn(cancel, 'click');
    expect(await api.resubmitExactResumeMessage({ messageId: 'message-one', token, expectedText: prompt }))
      .toEqual({ status: 'stopped', reason: 'resume_text_changed' });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(sent).not.toHaveBeenCalled();
  });

  it('rechecks the exact envelope after the retry authorizer returns', async () => {
    const { sent } = failedResume();
    expect(await api.resubmitExactResumeMessage({ messageId: 'message-one', token, expectedText: prompt,
      beforeResubmit: () => { document.querySelector('[role="textbox"]')!.textContent = 'Missing wrapper'; return true; }
    })).toEqual({ status: 'stopped', reason: 'resume_text_changed' });
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('model cooldown fallback', () => {
  function cooldown(effort: string) {
    box.textContent = '';
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    trigger.setAttribute('data-clf-selected-route', dom.window.location.pathname);
    trigger.setAttribute('data-clf-selected-model', 'gpt-5-6-thinking');
    trigger.setAttribute('data-clf-selected-effort', effort);
    const section = document.createElement('section');
    section.dataset.testid = 'conversation-turn-cooldown';
    section.dataset.turn = 'assistant';
    section.dataset.turnId = 'cooldown-turn';
    const heading = document.createElement('button');
    heading.setAttribute('aria-expanded', 'false');
    heading.textContent = 'This model is currently on cooldown';
    const retry = document.createElement('button'); retry.textContent = 'Retry';
    section.append(heading, retry); document.body.append(section);
    return { error: api.errors()[0]!, retry };
  }

  it('never changes models to work around a provider cooldown', () => {
    const models = [
      { id: '6', label: 'GPT-6 Astra', efforts: ['pro', 'xhigh'], aliases: ['gpt-6-pro', 'gpt-6-thinking'] },
      { id: '5.6', label: 'GPT-5.6 Sol', efforts: ['pro', 'xhigh', 'none'], aliases: ['gpt-5-6-pro', 'gpt-5-6-thinking'] }
    ];
    expect(api.nextCooldownSelection({ model: 'gpt-6-pro', reasoningEffort: 'pro' }, models))
      .toBeNull();
    expect(api.nextCooldownSelection({ model: 'gpt-5-6-pro', reasoningEffort: 'pro' }, models))
      .toBeNull();
    expect(api.nextCooldownSelection({ model: 'gpt-6-thinking', reasoningEffort: 'xhigh' }, models))
      .toBeNull();
    expect(api.nextCooldownSelection({ model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh' }, models))
      .toBeNull();
    expect(api.nextCooldownSelection({ model: 'auto', reasoningEffort: 'none' }, models))
      .toBeNull();
  });

  it('does not invent unavailable preferred models or cross the quality floor into GPT-5.5 Instant', () => {
    expect(api.nextCooldownSelection({ model: 'gpt-5-5-thinking', reasoningEffort: 'high' }, [
      { id: '5.5', label: 'GPT-5.5', efforts: ['none', 'medium', 'high', 'xhigh'], aliases: ['gpt-5-5-thinking'] }
    ])).toBeNull();
  });

  it.each(['high', 'xhigh'])('preserves the observed GPT-6 %s selection', async effort => {
    const models = [
      { id: '5.6', label: 'GPT-5.6 Sol', efforts: ['high'], aliases: ['gpt-5-6-thinking'] },
      { id: '5.5', label: 'GPT-5.5', efforts: ['none'], aliases: ['gpt-5-5-instant'] }
    ];
    expect(api.nextCooldownSelection({ model: 'gpt-5-6-thinking', reasoningEffort: 'high' }, models)).toBeNull();
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    trigger.setAttribute('data-clf-selected-route', dom.window.location.pathname);
    trigger.setAttribute('data-clf-selected-model', 'gpt-6-thinking');
    trigger.setAttribute('data-clf-selected-effort', effort);
    expect(await api.ensurePreferredAutomationModel()).toEqual({
      status: 'ready', model: 'gpt-6-thinking', effort, changed: false
    });
  });

  it('does not certify legacy 5.6 High as the configured production model', async () => {
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    trigger.setAttribute('data-clf-selected-route', dom.window.location.pathname);
    trigger.setAttribute('data-clf-selected-model', 'gpt-5-6-thinking');
    trigger.setAttribute('data-clf-selected-effort', 'high');
    vi.useFakeTimers();
    try {
      const check = api.ensurePreferredAutomationModel();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await check).toMatchObject({ status: 'waiting' });
    } finally { vi.useRealTimers(); }
  });

  it.each(['high', 'xhigh'])('does not accept a different native effort for an explicit %s account requirement', async effort => {
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    trigger.setAttribute('data-clf-selected-route', dom.window.location.pathname);
    trigger.setAttribute('data-clf-selected-model', 'gpt-6-thinking');
    trigger.setAttribute('data-clf-selected-effort', effort === 'xhigh' ? 'high' : 'pro');
    vi.useFakeTimers();
    try {
      const check = api.ensurePreferredAutomationModel(() => true, { model: 'gpt-6-thinking', reasoningEffort: effort });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await check).toMatchObject({ status: 'waiting', reason: 'selection_failed' });
    } finally { vi.useRealTimers(); }
  });

  it('classifies the exact native failed-answer chrome without treating authored prose as a cooldown', () => {
    const { error } = cooldown('pro');
    expect(error).toMatchObject({ reason: 'model_cooldown', recoverable: false, text: expect.stringContaining('cooldown') });
    const quote = document.createElement('section');
    quote.dataset.testid = 'conversation-turn-quote'; quote.dataset.turn = 'assistant';
    quote.innerHTML = '<div class="markdown">This model is currently on cooldown</div>';
    document.body.append(quote);
    expect(api.errors().filter(entry => entry.node === quote || quote.contains(entry.node))).toEqual([]);
  });

  it('waits safely on Instant when the preferred picker is unavailable and never presses Retry', async () => {
    const { error, retry } = cooldown('none');
    const click = vi.fn(); retry.addEventListener('click', click);
    vi.useFakeTimers();
    try {
      const recovery = api.recoverModelCooldown(error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await recovery).toEqual({ status: 'waiting', reason: 'catalog_unavailable' });
      expect(click).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('rendered temporary-chat state independent of language', () => {
  it('waits for the informational introduction even when temporary mode is already active', () => {
    currentAppShell();
    expect(api.temporaryChatReady()).toBe(true);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<h2>Temporary chat</h2><p>This chat won’t appear in history. You can choose whether ChatGPT uses memory, files, plugins, and custom instructions to personalize replies.</p><button>Continue</button>';
    document.body.append(dialog);
    dialog.querySelector('button')!.addEventListener('click', () => dialog.remove());
    expect(api.temporaryChatReady()).toBe(false);
    api.confirmTemporaryChatIntroduction();
    expect(dialog.isConnected).toBe(false);
    expect(api.temporaryChatReady()).toBe(true);
  });

  it('never confirms a tool-approval card that mentions temporary chat', () => {
    currentAppShell();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<h2>Allow ChatGPT to use Core?</h2><p>Temporary chat won’t appear in history.</p><button>Continue</button>';
    document.body.append(dialog);
    const click = vi.spyOn(dialog.querySelector('button')!, 'click');
    api.confirmTemporaryChatIntroduction();
    expect(click).not.toHaveBeenCalled();
  });

  it('confirms the current lowercase Temporary chat introduction wording', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<h2>Temporary chat</h2><p>This chat won\'t appear in history.</p><button>Continue</button>';
    document.body.append(dialog);
    const click = vi.spyOn(dialog.querySelector('button')!, 'click');
    api.confirmTemporaryChatIntroduction();
    expect(click).toHaveBeenCalledOnce();
  });

  function toggle(label: string, checked: boolean) {
    const control = document.createElement('button');
    control.setAttribute('aria-label', label);
    control.innerHTML = `<svg style="opacity:${checked ? 0 : 1}"><use href="/cdn/assets/sprites-shell-anyhash.svg#chat-temp"></use></svg><svg aria-hidden="true" style="opacity:${checked ? 1 : 0}"><use href="/cdn/assets/sprites-shell-anyhash.svg#chat-temp-checked"></use></svg>`;
    document.body.append(control);
    return control;
  }
  function currentShell() {
    dom.reconfigure({ url: 'https://chatgpt.com/?temporary-chat=true' });
    const header = document.createElement('header');
    header.dataset.testid = 'page-header';
    const save = document.createElement('button'); save.setAttribute('aria-label', 'Save chat');
    header.append(save); document.body.prepend(header);
    const marker = document.createElement('span'); marker.textContent = 'Temporary chat';
    document.querySelector('form')!.append(marker);
    return { header, save, marker };
  }
  function currentAppShell() {
    dom.reconfigure({ url: 'https://chatgpt.com/?temporary-chat=true' });
    const header = document.createElement('div');
    header.dataset.testid = 'app-shell-header-context-menu-surface';
    const toggle = document.createElement('button');
    toggle.setAttribute('aria-label', 'Turn off temporary chat');
    header.append(toggle); document.body.prepend(header);
    return { header, toggle };
  }
  it.each(['Temporären Chat ausschalten', '一時チャットをオフにする', 'Turn off temporary chat', ''])('reads the checked glyph with arbitrary label %s', label => {
    toggle(label, true);
    expect(api.temporaryChatReady()).toBe(true);
  });
  it('does not mistake a hidden checked glyph, English wording or URL intent for active mode', () => {
    dom.reconfigure({ url: 'https://chatgpt.com/?temporary-chat=true' });
    toggle('Turn off temporary chat', false);
    expect(api.temporaryChatReady()).toBe(false);
  });
  it('accepts the current provider shell only from its paired header and composer receipts', () => {
    const { save, marker } = currentShell();
    expect(api.temporaryChatReady()).toBe(true);
    save.remove();
    expect(api.temporaryChatReady()).toBe(false);
    document.querySelector('header')!.append(save);
    marker.remove();
    expect(api.temporaryChatReady()).toBe(false);
  });
  it('keeps current app-shell temporary proof after the helper markers are stripped', () => {
    const { toggle } = currentAppShell();
    expect(api.temporaryChatReady()).toBe(true);
    dom.reconfigure({ url: 'https://chatgpt.com/' });
    expect(api.temporaryChatReady()).toBe(true);
    toggle.setAttribute('aria-label', 'Turn on temporary chat');
    expect(api.temporaryChatReady()).toBe(false);
    dom.reconfigure({ url: 'https://chatgpt.com/?temporary-chat=true' });
    expect(api.temporaryChatReady()).toBe(false);
  });
  it.each(['https://chatgpt.com/c/other', 'https://chatgpt.com/?temporary-chat=false', 'https://chatgpt.com/#other'])('does not lend a stripped helper proof to another route (%s)', url => {
    currentAppShell();
    dom.reconfigure({ url });
    expect(api.temporaryChatReady()).toBe(false);
  });
  it('requires the stripped helper native header, empty transcript and live composer together', () => {
    const { header } = currentAppShell();
    dom.reconfigure({ url: 'https://chatgpt.com/' });
    header.hidden = true;
    expect(api.temporaryChatReady()).toBe(false);
    header.hidden = false;
    const authored = document.createElement('div'); authored.className = 'markdown';
    document.body.append(authored); authored.append(header);
    expect(api.temporaryChatReady()).toBe(false);
    document.body.prepend(header); authored.remove();
    const turn = document.createElement('section'); turn.dataset.testid = 'conversation-turn-0';
    document.body.append(turn);
    expect(api.temporaryChatReady()).toBe(false);
    turn.remove();
    document.querySelector('form')!.remove();
    expect(api.temporaryChatReady()).toBe(false);
  });
  it('does not accept an app-shell toggle quoted inside authored transcript content', () => {
    dom.reconfigure({ url: 'https://chatgpt.com/?temporary-chat=true' });
    const authored = document.createElement('section');
    authored.setAttribute('data-message-author-role', 'assistant');
    authored.innerHTML = '<div data-testid="app-shell-header-context-menu-surface"><button aria-label="Turn off temporary chat"></button></div>';
    document.body.append(authored);
    expect(api.temporaryChatReady()).toBe(false);
  });
  it('does not accept current-shell wording from authored transcript content', () => {
    dom.reconfigure({ url: 'https://chatgpt.com/?temporary-chat=true' });
    const authored = document.createElement('section');
    authored.setAttribute('data-message-author-role', 'assistant');
    authored.innerHTML = '<header data-testid="page-header"><button aria-label="Save chat">Save chat</button></header><p>Temporary chat</p>';
    document.body.append(authored);
    expect(api.temporaryChatReady()).toBe(false);
  });
  it('rejects a hidden toolbar or a glyph quoted in assistant content', () => {
    const control = toggle('arbitrary', true);
    control.hidden = true;
    expect(api.temporaryChatReady()).toBe(false);
    control.hidden = false;
    const authored = document.createElement('div'); authored.setAttribute('data-message-author-role', 'assistant');
    document.body.append(authored); authored.append(control);
    expect(api.temporaryChatReady()).toBe(false);
  });
});


describe('locale-independent provider composer evidence', () => {
  it.each([['ja', '送信', '回答を停止'], ['ar', 'إرسال', 'إيقاف الإجابة']])('uses provider Send and Stop identities in %s', (language, sendLabel, stopLabel) => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    button.setAttribute('aria-label', sendLabel);
    button.textContent = sendLabel;
    expect(api.sendButton()).toBe(button);
    expect(api.generating()).toBe(false);
    button.dataset.testid = 'stop-button';
    button.id = 'composer-submit-button';
    button.setAttribute('aria-label', stopLabel);
    expect(api.sendButton()).toBeNull();
    expect(api.generating()).toBe(true);
    expect(api.stopGeneration(() => true)).toBe(true);
  });

  it.each([['ja', '音声入力'], ['ar', 'إملاء']])('anchors to the provider microphone glyph in %s', (language, label) => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    button.removeAttribute('data-testid'); button.setAttribute('aria-label', label);
    button.id = 'composer-submit-button';
    button.innerHTML = '<svg><use href="#microphone-regular-24"></use></svg>';
    const trailing = button.parentElement!;
    // The observed grid area survives even when no test id names its action row.
    trailing.removeAttribute('data-testid'); trailing.className = '[grid-area:trailing]';
    expect(api.composerActions()).toEqual({ host: trailing, before: button });
    expect(api.sendButton()).toBeNull();
    expect(api.generating()).toBe(false);
    expect(api.stopGeneration(() => true)).toBe(false);
  });

  it('anchors to the provider microphone without action-row markers', () => {
    document.documentElement.lang = 'de-DE';
    document.querySelector('form')!.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<div class="flex justify-end"><div><div><span><button type="button" aria-label="ChatGPT-Modell auswählen">5.6</button></span></div></div>' +
      '<div id="row"><div id="mic-wrap"><div><span><button type="button" aria-label="Diktieren"><svg><use href="/cdn/sprites.svg#microphone-light-20"></use></svg></button></span></div></div>' +
      '<div><button type="button" aria-label="Sprachchat starten"><svg><use href="/cdn/sprites.svg#voice-regular-20"></use></svg></button></div></div></div>';
    expect(api.sendButton()).toBeNull();
    expect(api.composerActions()).toEqual({ host: document.getElementById('row'), before: document.getElementById('mic-wrap') });
  });

  it('does not anchor to a microphone glyph in prose or outside the composer', () => {
    button.parentElement!.removeAttribute('data-testid');
    button.removeAttribute('data-testid'); button.removeAttribute('aria-label');
    button.innerHTML = '<svg><use href="#plus-regular-24"></use></svg>';
    const quote = document.createElement('section'); quote.setAttribute('data-testid', 'conversation-turn-1');
    quote.innerHTML = '<button><svg><use href="#microphone-regular-24"></use></svg></button>';
    document.body.prepend(quote);
    const outside = document.createElement('div');
    outside.innerHTML = '<button><svg><use href="#microphone-light-20"></use></svg></button>';
    document.body.append(outside);
    expect(api.composerActions()).toBeNull();
    expect(api.sendButton()).toBeNull();
    expect(api.generating()).toBe(false);
  });

  it.each(['画像.webp', 'صورة.webp'])('recognizes the provider attachment group independently of translated removal labels (%s)', name => {
    const group = document.createElement('div'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', name);
    group.innerHTML = '<div data-default-action="true"><button type="button">開く</button></div><button aria-label="削除" type="button">×</button>';
    document.querySelector('form')!.append(group);
    expect(api.hasComposerAttachments()).toBe(true);
    group.querySelector('[data-default-action]')!.removeAttribute('data-default-action');
    expect(api.hasComposerAttachments()).toBe(false);
    group.firstElementChild!.setAttribute('data-default-action', 'true');
    group.append(group.lastElementChild!.cloneNode(true));
    expect(api.hasComposerAttachments()).toBe(false);
  });
});

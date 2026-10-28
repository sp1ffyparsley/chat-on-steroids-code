import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const contentMarkerSource = contentSource.slice(
  contentSource.indexOf('  const cosMarker ='),
  contentSource.indexOf('  // The durable claim')
);
let page: JSDOM;
afterEach(() => { page?.window.close(); });
it('reveals the native New Chat control through the compact sidebar before reuse', async () => {
  page = new JSDOM('<button data-testid="open-sidebar-button" aria-expanded="false" aria-controls="stage-popover-sidebar">Menu</button>', { url: 'https://chatgpt.com/c/existing', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  page.window.eval(domSource);
  const button = page.window.document.querySelector('button')!;
  const click = vi.fn(() => {
    button.setAttribute('aria-expanded', 'true');
    const sidebar = page.window.document.createElement('aside'); sidebar.id = 'stage-popover-sidebar';
    sidebar.innerHTML = '<a data-testid="create-new-chat-button" data-sidebar-item="true" href="/">New Chat</a>';
    page.window.document.body.append(sidebar);
  });
  button.addEventListener('click', click);
  const api = (page.window as any).CLF_DOM;
  expect(await api.newChatControl(() => false)).toBeNull(); expect(click).not.toHaveBeenCalled();
  const control = await api.newChatControl();
  expect(control?.getAttribute('data-testid')).toBe('create-new-chat-button');
  expect(click).toHaveBeenCalledTimes(1);
});
it('switches the observed Work surface to Chat once without relying on translated labels', async () => {
  page = new JSDOM('<button role="radio" data-tpp-toggle-value="chatgpt" aria-checked="false">Unterhaltung</button><button role="radio" data-tpp-toggle-value="work" aria-checked="true">Arbeit</button>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  page.window.eval(domSource);
  const chat = page.window.document.querySelector('[data-tpp-toggle-value="chatgpt"]')!;
  const click = vi.fn(() => {
    chat.setAttribute('aria-checked', 'true');
    page.window.document.querySelector('[data-tpp-toggle-value="work"]')!.setAttribute('aria-checked', 'false');
  });
  chat.addEventListener('click', click);
  const api = (page.window as any).CLF_DOM;
  expect(await api.prepareChatModelSurface(() => false)).toBe(false); expect(click).not.toHaveBeenCalled();
  expect(await api.prepareChatModelSurface()).toBe(true); expect(click).toHaveBeenCalledTimes(1);
  expect(await api.prepareChatModelSurface()).toBe(true); expect(click).toHaveBeenCalledTimes(1);
});
function fixture(closeDelay: number | null = 0, inlineVersions = false) {
  page = new JSDOM('<form><div id="prompt-textarea" contenteditable="true"></div><div data-testid="composer-trailing-actions"><button type="button" aria-haspopup="menu">Denkaufwand</button><button data-testid="send-button">Senden</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const choice = (bucket: number, modelSlug: string, thinkingEffort: string, available = true) => ({ bucket, modelSlug, thinkingEffort,
    availability: { status: available ? 'available' : 'upgrade_required' },
    category: { modelLane: modelSlug.endsWith('pro') ? 'pro' : 'thinking', shortLabel: modelSlug.startsWith('future') ? 'Neues Modell' : modelSlug.endsWith('pro') ? '6 Pro' : '5.6 Sol' } });
  const versions = [{ id: 'latest', displayTextForIntelligence: 'Aktuell', enabled: true }, { id: 'future', displayTextForIntelligence: 'Neues Modell', enabled: true }];
  const selections = [[choice(1, 'gpt-5-6-thinking', 'standard'), choice(2, 'gpt-5-6-thinking', 'extended'), choice(3, 'gpt-6-pro', 'standard', false)],
    [choice(10, 'future-model', 'low'), choice(11, 'future-model', 'ultra')]];
  const state = { bucketSelections: selections[0]!, currentBucket: 2, selectedVersionEntry: versions[0]!, currentSelection: selections[0]![1]! };
  const props = { modelsData: { versions }, composerIntelligencePickerState: state, modelSwitcherDenialsBySlug: {}, conversation: { privateSecret: 'must-never-cross' } };
  const trigger = doc.querySelector('button')!;
  (trigger as any).__reactFiber$test = { memoizedProps: props, return: null };
  const actions = vi.fn();
  let frozen = false;
  let decorateVersionRow: ((row: HTMLElement, version: typeof versions[number]) => void) | undefined;
  const render = () => {
    let panel = doc.querySelector('[data-testid="composer-intelligence-picker-content"]') as HTMLElement;
    if (!panel) { panel = doc.createElement('div'); panel.dataset.testid = 'composer-intelligence-picker-content'; doc.body.append(panel); }
    (panel as any).__reactFiber$test = { memoizedProps: props, return: null };
    if (inlineVersions) panel.setAttribute('data-model-picker-view', 'advanced');
    panel.innerHTML = '<div role="menuitem" aria-expanded="false">Modell auswählen</div><div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight" aria-label="Leistung"></div>';
    const renderVersions = () => {
      for (const version of versions) {
        const row = doc.createElement('div'); row.setAttribute('role', 'menuitemradio'); row.textContent = version.displayTextForIntelligence;
        row.setAttribute('aria-checked', String(version === state.selectedVersionEntry));
        decorateVersionRow?.(row, version);
        row.addEventListener('keydown', event => { if (event.key !== 'Enter') return; actions('version'); if (frozen) return;
          state.selectedVersionEntry = version; state.bucketSelections = selections[versions.indexOf(version)]!;
          state.currentBucket = state.bucketSelections[0]!.bucket; state.currentSelection = state.bucketSelections[0]!; render(); }); panel.append(row);
      }
    };
    panel.querySelector('[aria-expanded]')!.addEventListener('click', () => {
      panel.innerHTML = '';
      renderVersions();
    });
    panel.querySelector('[aria-keyshortcuts]')!.addEventListener('keydown', (event: any) => {
      actions('effort'); if (frozen) return;
      const at = state.bucketSelections.findIndex(c => c.bucket === state.currentBucket) + (event.key === 'ArrowRight' ? 1 : -1);
      if (!state.bucketSelections[at]) return;
      state.currentBucket = state.bucketSelections[at]!.bucket; state.currentSelection = state.bucketSelections[at]!; render();
    });
    if (inlineVersions) renderVersions();
  };
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Enter') render();
  });
  // Native Escape is handled by the picker's focus scope, so it bubbles from the
  // active panel rather than requiring the outside trigger to own focus.
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || closeDelay === null) return;
    const close = () => doc.querySelector('[data-testid="composer-intelligence-picker-content"]')?.remove();
    if (closeDelay) win.setTimeout(close, closeDelay); else close();
  });
  win.eval(fiberSource); win.eval(domSource);
  return { api: (win as any).CLF_DOM, state, props, selections, actions, freeze: () => { frozen = true; },
    decorateVersionRows: (decorate: NonNullable<typeof decorateVersionRow>) => { decorateVersionRow = decorate; } };
}

/** Current alternate ChatGPT shell: editor and reasoning trigger are separate native owners. */
function shellFixture() {
  page = new JSDOM(
    '<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox"></div><button type="submit">Send</button></form>' +
    '<button role="button" data-codex-intelligence-trigger data-composer-navigation-target="reasoning" data-selected-reasoning-effort="pro">Reasoning</button>',
    { url: 'https://chatgpt.com/', runScripts: 'outside-only' }
  );
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', {
    data, source: win as unknown as Window, origin: win.location.origin
  })));
  const choices = [
    { powerSettingIndex: 1, model: 'gpt-5-6-thinking', modelLabel: 'GPT-5.6 Sol', reasoningEffort: 'xhigh', availability: { status: 'available' } },
    { powerSettingIndex: 2, model: 'gpt-5-6-pro', modelLabel: 'GPT-5.6 Pro', reasoningEffort: 'pro', availability: { status: 'available' } }
  ];
  const props: any = {
    powerSelections: choices,
    selectedPowerSelection: choices[1],
    modelListConfig: { options: [{ id: '5.6', label: 'GPT-5.6 Sol', selected: true }] },
    modelSelectionDisabled: false,
    modelSwitcherDenialsBySlug: {}
  };
  const trigger = doc.querySelector('[data-codex-intelligence-trigger]') as HTMLElement;
  const editor = doc.querySelector('[data-composer-markdown]') as HTMLElement;
  (trigger as any).__reactFiber$test = { memoizedProps: props, return: null };
  const actions = vi.fn();
  let afterPowerChange: () => void = () => {};
  const render = () => {
    let panel = doc.querySelector('[data-model-picker-view]') as HTMLElement | null;
    if (!panel) {
      panel = doc.createElement('div');
      panel.setAttribute('data-model-picker-view', '');
      panel.setAttribute('role', 'menu');
      doc.body.append(panel);
    }
    (panel as any).__reactFiber$test = { memoizedProps: props, return: null };
    panel.innerHTML = '<div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight" aria-label="Power"></div>';
    panel.querySelector('[aria-keyshortcuts]')!.addEventListener('keydown', (event: any) => {
      const at = choices.indexOf(props.selectedPowerSelection) + (event.key === 'ArrowRight' ? 1 : -1);
      if (!choices[at]) return;
      actions('effort');
      props.selectedPowerSelection = choices[at];
      trigger.setAttribute('data-selected-reasoning-effort', choices[at]!.reasoningEffort);
      afterPowerChange();
      render();
    });
  };
  trigger.addEventListener('keydown', event => { if (event.key === 'Enter') render(); });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape') doc.querySelector('[data-model-picker-view]')?.remove();
  });
  let insertedHtml = '';
  (doc as any).execCommand = vi.fn((command: string, _showUi?: boolean, value?: string) => {
    if (command !== 'insertHTML') return true;
    insertedHtml = String(value ?? '');
    editor.innerHTML = insertedHtml;
    return true;
  });
  win.eval(fiberSource); win.eval(domSource);
  return {
    api: (win as any).CLF_DOM, props, choices, trigger, editor, actions,
    insertedHtml: () => insertedHtml,
    afterPowerChange: (callback: () => void) => { afterPowerChange = callback; }
  };
}

it('groups native GPT-6 lanes without losing exact High and Extra High selections', async () => {
  const f = shellFixture();
  f.choices.splice(0, f.choices.length, ...[
    ['gpt-6', 'none'], ['gpt-6-thinking', 'medium'], ['gpt-6-thinking', 'high'], ['gpt-6-thinking', 'xhigh']
  ].map(([model, reasoningEffort], index) => ({
    powerSettingIndex: index, model: model!, modelLabel: '6', reasoningEffort: reasoningEffort!, availability: { status: 'available' }
  })));
  f.props.selectedPowerSelection = f.choices[2];
  f.props.modelListConfig.options = [{ id: '6', label: 'GPT-6', selected: true }];
  await syncPicker();
  const observed = await f.api.inspectModelCatalogEvidence();
  expect(observed.models).toEqual([{ id: 'gpt-6', label: 'GPT-6', efforts: ['none', 'medium', 'high', 'xhigh'], aliases: ['gpt-6', 'gpt-6-thinking'] }]);
  expect(await f.api.selectModelSettings('gpt-6-thinking', 'xhigh')).toBe(true);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-6-thinking', reasoningEffort: 'xhigh' });
});

it('normalizes alternate-shell implementation power values to the visible Extra High and Pro contract', async () => {
  const f = shellFixture();
  f.choices[0]!.reasoningEffort = 'max';
  (f.choices[0] as any).labels = { effort: 'Extra High' };
  f.choices[1]!.reasoningEffort = 'medium';
  (f.choices[1] as any).labels = { effort: 'Pro' };
  f.trigger.setAttribute('data-selected-reasoning-effort', 'medium');

  await syncPicker();

  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-pro', reasoningEffort: 'pro' });
  const observed = await f.api.inspectModelCatalogEvidence();
  expect(observed.models).toEqual([
    { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['xhigh'], aliases: ['gpt-5-6-thinking'] },
    { id: 'gpt-5-6-pro', label: 'GPT-5.6 Pro', efforts: ['pro'], aliases: ['gpt-5-6-pro'] }
  ]);
});

it('binds a bare Pro power lane to the selected 5.6 family without reopening or changing the picker', async () => {
  const f = shellFixture(), doc = page.window.document;
  const instant = { powerSettingIndex: 0, model: 'gpt-5-6-thinking', modelLabel: 'GPT-5.6 Sol', reasoningEffort: 'none',
    labels: { effort: 'Instant' }, availability: { status: 'available' } };
  const xhigh = { powerSettingIndex: 1, model: 'gpt-5-6-thinking', modelLabel: 'GPT-5.6 Sol', reasoningEffort: 'max',
    labels: { effort: 'Extra High' }, availability: { status: 'available' } };
  const pro = { powerSettingIndex: 2, model: 'pro', modelLabel: 'Pro', reasoningEffort: 'medium',
    labels: { effort: 'Pro' }, availability: { status: 'available' } };
  f.choices.splice(0, f.choices.length, instant, xhigh, pro);
  Object.assign(f.props, { currentModelId: 'pro', selectedPowerSelection: pro });
  f.trigger.setAttribute('data-selected-reasoning-effort', 'medium');

  await syncPicker();

  expect(f.api.visibleModelSelection()).toEqual({ model: '5.6', reasoningEffort: 'pro' });
  expect(f.props.selectedPowerSelection).toBe(pro);
  expect(f.actions).not.toHaveBeenCalled();
  expect(doc.querySelector('[data-model-picker-view]')).toBeNull();

  const observed = await f.api.inspectModelCatalogEvidence();
  expect(observed.models).toEqual([
    { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['none', 'xhigh'], aliases: ['gpt-5-6-thinking'] },
    { id: '5.6', label: 'GPT-5.6 Sol', efforts: ['pro'], aliases: ['5.6'] }
  ]);

  // The live three-stop control can call its selected top stop "High" even while the shell
  // transport continues to expose the bare `pro` lane and machine `medium`. That exact surface
  // is still a proven production rung, not a reason to loop forever on the 15-second wait.
  pro.labels.effort = 'High';
  await syncPicker();
  expect(f.api.visibleModelSelection()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  expect(await f.api.ensurePreferredAutomationModel()).toEqual({
    status: 'waiting', reason: 'preferred_unavailable'
  });
  expect(f.actions).not.toHaveBeenCalled();

  pro.labels.effort = 'Pro';
  await syncPicker();

  delete f.props.powerSelections;
  await syncPicker();
  expect(f.api.visibleModelSelection()).toEqual({ model: '5.6', reasoningEffort: 'pro' });
});

it('fails closed when a bare Pro lane has no unique selected native family', async () => {
  const ambiguousFamilies = [
    [],
    [
      { id: '5.6', label: 'GPT-5.6 Sol', selected: true },
      { id: '5.5', label: 'GPT-5.5', selected: true }
    ]
  ];
  for (const options of ambiguousFamilies) {
    const f = shellFixture();
    const pro = { powerSettingIndex: 2, model: 'pro', modelLabel: 'Pro', reasoningEffort: 'medium',
      labels: { effort: 'Pro' }, availability: { status: 'available' } };
    f.choices.splice(0, f.choices.length, pro);
    Object.assign(f.props, {
      currentModelId: 'pro',
      selectedPowerSelection: pro,
      modelListConfig: { options }
    });
    f.trigger.setAttribute('data-selected-reasoning-effort', 'medium');

    await syncPicker();

    expect(f.api.visibleModelSelection()).toBeNull();
    expect(f.props.selectedPowerSelection).toBe(pro);
    expect(f.actions).not.toHaveBeenCalled();
  }
});
async function syncPicker(): Promise<void> {
  await new Promise<void>(resolve => {
    const receive = (event: MessageEvent) => {
      if (event.data?.source !== 'clf-picker-reply') return;
      page.window.removeEventListener('message', receive as any);
      resolve();
    };
    page.window.addEventListener('message', receive as any);
    page.window.postMessage({ source: 'clf-picker-ask', nonce: 'automation-model' }, page.window.location.origin);
  });
}
it('reads localized nested models and future efforts from account state, excludes locked choices, and restores selection', async () => {
  const f = fixture();
  expect(await f.api.inspectModelSettings()).toEqual([
    { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5-6-thinking'] },
    { id: 'future-model', label: 'Neues Modell', efforts: ['low', 'ultra'], aliases: ['future-model'] }
  ]);
  expect(f.state.selectedVersionEntry.id).toBe('latest'); expect(f.state.currentBucket).toBe(2);
  // Only restore the original High once; discovery never sweeps every power level.
  expect(f.actions.mock.calls.filter(([action]) => action === 'effort')).toHaveLength(1);
});

it('supports the alternate shell composer and exact GPT-5.6 Pro/Extra High power picker', async () => {
  const f = shellFixture(), doc = page.window.document;
  await syncPicker();
  expect(f.api.composer()).toBe(f.editor);
  expect(f.api.composerWritable()).toBe(true);
  expect(f.api.sendButton()).toBe(doc.querySelector('form[data-chatgpt-composer] button[type="submit"]'));
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-pro', reasoningEffort: 'pro' });

  const observed = await f.api.inspectModelCatalogEvidence();
  expect(observed.models).toEqual([
    { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['xhigh'], aliases: ['gpt-5-6-thinking'] },
    { id: 'gpt-5-6-pro', label: 'GPT-5.6 Pro', efforts: ['pro'], aliases: ['gpt-5-6-pro'] }
  ]);
  expect(observed.availability).toEqual([
    { model: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', effort: 'xhigh', status: 'available' },
    { model: 'gpt-5-6-pro', label: 'GPT-5.6 Pro', effort: 'pro', status: 'available' }
  ]);
  expect(doc.querySelector('[data-model-picker-view]')).toBeNull();
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-pro', reasoningEffort: 'pro' });

  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'xhigh')).toBe(true);
  expect(f.props.selectedPowerSelection).toBe(f.choices[0]);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh' });
  expect(f.actions).toHaveBeenCalledWith('effort');

  f.editor.setAttribute('contenteditable', 'false');
  expect(f.api.composerWritable()).toBe(false);
  f.editor.setAttribute('contenteditable', 'true');
  expect(f.api.insertPrompt('line one\n*literal markdown*', true)).toBe(true);
  expect(f.insertedHtml()).toContain('data-prompt-literal-paste');
  expect(f.editor.textContent).toContain('*literal markdown*');
});

it('does not let a quoted alternate reasoning anchor become picker authority', async () => {
  const f = shellFixture(), doc = page.window.document;
  const markdown = doc.createElement('div');
  markdown.className = 'markdown';
  const fake = doc.createElement('button');
  fake.setAttribute('role', 'button');
  fake.setAttribute('data-codex-intelligence-trigger', '');
  fake.setAttribute('data-composer-navigation-target', 'reasoning');
  fake.setAttribute('data-selected-reasoning-effort', 'pro');
  fake.textContent = 'quoted fake Pro control';
  (fake as any).__reactFiber$test = { memoizedProps: {
    powerSelections: f.choices,
    selectedPowerSelection: f.choices[1],
    modelListConfig: { options: [{ id: '5.6', label: 'GPT-5.6 Sol', selected: true }] }
  }, return: null };
  markdown.append(fake); doc.body.append(markdown);

  await syncPicker();
  expect(fake.getAttribute('data-clf-picker-route')).toBeNull();
  expect(f.trigger.getAttribute('data-clf-picker-route')).toBe('/');
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-pro', reasoningEffort: 'pro' });
});

it('waits for the replacement shell editor after an Extra High to Pro model transition', async () => {
  const f = shellFixture(), doc = page.window.document;
  f.props.selectedPowerSelection = f.choices[0];
  f.trigger.setAttribute('data-selected-reasoning-effort', 'xhigh');
  await syncPicker();
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh' });

  let replacement: HTMLElement | null = null;
  f.afterPowerChange(() => {
    f.editor.setAttribute('contenteditable', 'false');
    page.window.setTimeout(() => {
      replacement = doc.createElement('div');
      replacement.setAttribute('data-composer-markdown', '');
      replacement.setAttribute('contenteditable', 'true');
      replacement.setAttribute('role', 'textbox');
      f.editor.replaceWith(replacement);
    }, 10);
  });

  expect(await f.api.selectModelSettings('gpt-5-6-pro', 'pro')).toBe(true);
  expect(replacement).not.toBeNull();
  expect(f.api.composer()).toBe(replacement);
  expect(f.api.composerWritable()).toBe(true);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-pro', reasoningEffort: 'pro' });
});

it('does not claim model-transition readiness while the shell editor stays non-writable', async () => {
  const f = shellFixture();
  f.editor.setAttribute('contenteditable', 'false');
  expect(await f.api.waitComposerWritable(() => true, 20)).toBe(false);
});
it.each(['trigger_missing', 'snapshot_missing'] as const)('classifies one bounded native picker observation failure (%s)', async reason => {
  const f = fixture(), win = page.window;
  const nativeTimer = win.setTimeout.bind(win);
  win.setTimeout = ((callback: TimerHandler, ms?: number) => nativeTimer(callback, Math.min(ms ?? 0, ms === 1500 ? 1 : 20))) as typeof win.setTimeout;
  if (reason === 'trigger_missing') page.window.document.querySelector('button')!.remove();
  else {
    const post = win.postMessage;
    win.postMessage = ((data: { source?: string }) => { if (data?.source !== 'clf-picker-ask') post(data, win.location.origin); }) as typeof win.postMessage;
  }
  const failure = vi.fn();
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'high', () => true,
    { failure, deadline: win.Date.now() + 100, observationMs: 10, exact: true })).toBe(false);
  expect(failure).toHaveBeenCalledExactlyOnceWith(reason);
});
it.each(['disabled', 'denied', 'unavailable', 'owner_changed', 'expired'] as const)(
  'does not classify explicit refusal or lost ownership as transient (%s)', async cause => {
    const f = fixture(), failure = vi.fn(), doc = page.window.document;
    if (cause === 'disabled') doc.querySelector('button')!.setAttribute('aria-disabled', 'true');
    if (cause === 'denied') (f.props.modelSwitcherDenialsBySlug as any)['gpt-5-6-thinking'] = { reason: 'workspace_policy' };
    const effort = cause === 'unavailable' ? 'xhigh' : 'high';
    expect(await f.api.selectModelSettings('gpt-5-6-thinking', effort, () => cause !== 'owner_changed',
      { failure, deadline: page.window.Date.now() + (cause === 'expired' ? -1 : 2000), exact: true })).toBe(false);
    expect(failure).toHaveBeenCalledExactlyOnceWith(cause === 'owner_changed' ? 'owner_changed'
      : cause === 'expired' ? 'preparation_expired' : 'choice_unavailable');
    if (['disabled', 'owner_changed', 'expired'].includes(cause)) expect(f.actions).not.toHaveBeenCalled();
    expect(JSON.stringify(failure.mock.calls)).not.toContain('workspace_policy');
  });
it.each(['trigger_missing', 'snapshot_missing'] as const)('reobserves the actual selector after same-page hydration within one deadline (%s)', async reason => {
  const f = fixture(), win = page.window, doc = win.document, trigger = doc.querySelector('button')!;
  const nativeTimer = win.setTimeout.bind(win), post = win.postMessage;
  win.setTimeout = ((callback: TimerHandler, ms?: number) => nativeTimer(callback, Math.min(ms ?? 0, ms === 1500 ? 1 : 20))) as typeof win.setTimeout;
  let missing = true;
  if (reason === 'trigger_missing') trigger.remove();
  win.postMessage = ((data: { source?: string; nonce?: string }) => {
    if (reason === 'snapshot_missing' && missing && data?.source === 'clf-picker-ask' && doc.querySelector('[data-testid="composer-intelligence-picker-content"]')) {
      queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { source: win as unknown as Window,
        origin: win.location.origin, data: { source: 'clf-picker-reply', v: 1, nonce: data.nonce, picker: null } })));
    } else post(data, win.location.origin);
  }) as typeof win.postMessage;
  const failure = vi.fn(), deadline = win.Date.now() + 1000;
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'high', () => true,
    { failure, deadline, observationMs: 10, exact: true })).toBe(false);
  expect(failure).toHaveBeenCalledExactlyOnceWith(reason);
  missing = false;
  if (!trigger.isConnected) doc.querySelector('[data-testid="composer-trailing-actions"]')!.prepend(trigger);
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'high', () => true,
    { failure, deadline, exact: true })).toBe(true);
  expect(failure).toHaveBeenCalledTimes(1);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'high' });
});
it('reports an unclosed native picker as terminal even when its first snapshot was missing', async () => {
  const f = fixture(null), win = page.window, nativeTimer = win.setTimeout.bind(win), post = win.postMessage;
  win.setTimeout = ((callback: TimerHandler, ms?: number) => nativeTimer(callback, Math.min(ms ?? 0, ms === 1500 ? 1 : 20))) as typeof win.setTimeout;
  win.postMessage = ((data: { source?: string; nonce?: string }) => {
    if (data?.source === 'clf-picker-ask' && win.document.querySelector('[data-testid="composer-intelligence-picker-content"]')) {
      queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { source: win as unknown as Window,
        origin: win.location.origin, data: { source: 'clf-picker-reply', v: 1, nonce: data.nonce, picker: null } })));
    } else post(data, win.location.origin);
  }) as typeof win.postMessage;
  const failure = vi.fn();
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'high', () => true,
    { failure, deadline: win.Date.now() + 1000, exact: true })).toBe(false);
  expect(failure).toHaveBeenCalledExactlyOnceWith('picker_not_closed');
});
it('retains exact native denial before inspecting an unrelated unavailable version', async () => {
  const f = fixture(), failure = vi.fn();
  (f.props.modelSwitcherDenialsBySlug as any)['gpt-5-6-thinking'] = { reason: 'workspace_policy' };
  f.decorateVersionRows((row, version) => { if (version.id === 'future') row.setAttribute('aria-disabled', 'true'); });
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'high', () => true,
    { failure, deadline: page.window.Date.now() + 1000, exact: true })).toBe(false);
  expect(failure).toHaveBeenCalledExactlyOnceWith('choice_unavailable');
  expect(f.actions).not.toHaveBeenCalled();
});
it('records unavailable and rate-limited native choices as evidence without adding them to selectable models', async () => {
  const f = fixture();
  const retryAt = Date.now() + 90_000;
  f.selections[0]![2]!.availability = { status: 'rate_limited', resetAt: retryAt } as any;
  const observed = await f.api.inspectModelCatalogEvidence();
  expect(observed.models).toEqual([
    { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5-6-thinking'] },
    { id: 'future-model', label: 'Neues Modell', efforts: ['low', 'ultra'], aliases: ['future-model'] }
  ]);
  expect(observed.availability).toEqual([
    { model: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', effort: 'medium', status: 'available' },
    { model: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', effort: 'high', status: 'available' },
    { model: 'gpt-6-pro', label: 'GPT-6 Pro', effort: 'pro', status: 'unavailable', retryAt },
    { model: 'future-model', label: 'Neues Modell', effort: 'low', status: 'available' },
    { model: 'future-model', label: 'Neues Modell', effort: 'ultra', status: 'available' }
  ]);
  expect(observed.models.some((model: any) => model.id === 'gpt-6-pro')).toBe(false);
});
it.each([true, false])('discovers 5.6 Pro outside Latest through the content workflow only when available (%s)', async available => {
  const f = fixture();
  f.props.modelsData.versions[1]!.id = '5.6';
  f.props.modelsData.versions[1]!.displayTextForIntelligence = 'GPT-5.6 Sol';
  const latest = f.selections[0]!;
  latest[2]!.availability.status = 'available';
  for (const choice of latest.slice(0, 2)) (choice.category as any).modelVersion = '5.6';
  f.selections[1] = [...latest.slice(0, 2), { ...latest[2]!, modelSlug: 'gpt-5-6-pro',
    availability: { status: available ? 'available' : 'upgrade_required' },
    category: { ...latest[2]!.category, shortLabel: '5.6 Pro', modelVersion: '5.6' } as any }];
  const ask = vi.fn(async () => ({ ok: true }));
  const section = contentSource.slice(contentSource.indexOf('  function catalogPageReady('), contentSource.indexOf('  /** Popup commands target this tab'));
  const run = page.window.Function('ask', `
    const alive = true, epoch = 1, conversationId = null;
    let desktopInputBusy = false, modelCatalogBusy = false, generating = false;
    const BOOT_MARKERS = { input: null, refresh: null, catalog: null };
    ${contentMarkerSource}
    ${section}
    return inspectAppModelCatalog({ nonce: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', expiresAt: Date.now() + 10000 });
  `);
  expect(await run(ask)).toBe(true);
  expect(ask).toHaveBeenCalledTimes(1);
  const body = (ask.mock.calls[0] as any)[0], models = body.models;
  expect(models).toContainEqual({ id: '5.6', label: 'GPT-5.6 Sol', efforts: available ? ['medium', 'high', 'pro'] : ['medium', 'high'],
    aliases: available ? ['gpt-5-6-thinking', 'gpt-5-6-pro'] : ['gpt-5-6-thinking'] });
  expect(models).toContainEqual({ id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'], aliases: ['gpt-6-pro'] });
  expect(body.availability).toContainEqual({ model: 'gpt-5-6-pro', label: 'GPT-5.6 Pro', effort: 'pro',
    status: available ? 'available' : 'unavailable' });
  expect(f.state.selectedVersionEntry.id).toBe('latest');
  expect(f.state.currentBucket).toBe(2);
  expect(page.window.document.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
});
it.each([false, true])('releases native hidden-window Presence and reopens a retained closed menu (retained=%s)', async retained => {
  const f = fixture(null), win = page.window, doc = win.document;
  const nativeStyle = doc.createElement('style');
  nativeStyle.textContent = '[role="menu"] { animation: picker-exit 320ms; }';
  doc.head.append(nativeStyle);
  const trigger = doc.querySelector('button')!;
  const opens = vi.fn();
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    opens();
    const panel = doc.querySelector('[data-testid="composer-intelligence-picker-content"]')!;
    let menu = panel.closest('[role="menu"]');
    if (!menu) { menu = doc.createElement('div'); menu.setAttribute('role', 'menu'); doc.body.append(menu); menu.append(panel); }
    menu.setAttribute('data-state', 'open');
  });
  if (retained) {
    trigger.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter' }));
    doc.querySelector('[role="menu"]')!.setAttribute('data-state', 'closed');
    opens.mockClear();
  }
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menu = doc.querySelector('[role="menu"]')!;
    menu.setAttribute('data-state', 'closed');
    // Native Presence unmounts immediately without an animation; a hidden page
    // cannot supply the animationend which otherwise releases its focus scope.
    if (win.getComputedStyle(menu).animation === 'none') menu.remove();
  });
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'high')).toBe(true);
  expect(opens).toHaveBeenCalledTimes(1);
  expect(doc.querySelector('[role="menu"]')).toBeNull();
  expect([...doc.querySelectorAll('style')]).toEqual([nativeStyle]);
});
it('refuses selection success when the picker retains its focus trap', async () => {
  const f = fixture(null);
  expect(await f.api.selectModelSettings('future-model', 'ultra')).toBe(false);
  expect(page.window.document.querySelector('[data-testid="composer-intelligence-picker-content"]')).not.toBeNull();
});
it('does not publish a discovered catalog before the picker closes', async () => {
  const f = fixture(null), failure = vi.fn();
  expect(await f.api.inspectModelSettings(() => true, failure)).toBeNull();
  expect(failure).toHaveBeenCalledWith('picker_close_failed');
});
it('sends Escape inside the picker dialog and waits for its delayed focus-trap removal', async () => {
  const f = fixture(10), doc = page.window.document;
  doc.querySelector('button')!.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter' }));
  const panel = doc.querySelector('[data-testid="composer-intelligence-picker-content"]')!;
  const dialog = doc.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.tabIndex = -1;
  doc.body.append(dialog); dialog.append(panel); dialog.focus();
  const escaped = vi.fn();
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    escaped(); page.window.setTimeout(() => dialog.remove(), 40);
  });
  expect(await f.api.selectModelSettings('future-model', 'ultra')).toBe(true);
  expect(escaped).toHaveBeenCalledTimes(1);
  expect(dialog.isConnected).toBe(false);
});
it('withdraws a confirmed selection if navigation invalidates its picker-close wait', async () => {
  const f = fixture(30), doc = page.window.document;
  let current = true;
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') current = false; });
  expect(await f.api.selectModelSettings('future-model', 'ultra', () => current)).toBe(false);
});
it('rejects a mounted composer hidden by Settings while recognizing the visible High picker', async () => {
  const f = fixture(), doc = page.window.document;
  doc.querySelector('button')!.textContent = 'High';
  expect(f.api.composerVisible()).toBe(true);
  const editor = doc.querySelector('#prompt-textarea')!;
  editor.setAttribute('aria-hidden', 'true');
  expect(f.api.composerVisible()).toBe(false);
  editor.removeAttribute('aria-hidden');
  doc.querySelector('form')!.setAttribute('inert', '');
  expect(f.api.composerVisible()).toBe(false);
  doc.querySelector('form')!.removeAttribute('inert');
  expect(f.api.composerVisible()).toBe(true);
  expect(await f.api.inspectModelSettings()).toHaveLength(2);
  expect(f.state.currentBucket).toBe(2);
});
it('confirms the exact model and effort and refuses visible upgrade-only entries', async () => {
  const f = fixture();
  expect(await f.api.selectModelSettings('future-model', 'ultra')).toBe(true);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'future-model', thinkingEffort: 'ultra' });
  expect(await f.api.selectModelSettings('gpt-6-pro', 'pro')).toBe(false);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'future-model', thinkingEffort: 'ultra' });
});
it('closes an already-selected exact model without traversing unrelated versions', async () => {
  const f = fixture();
  // Current fixture selection normalizes provider `extended` to High. Freeze every picker
  // mutation: a correct implementation needs only to open, prove and close this exact pair.
  f.freeze();
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'high')).toBe(true);
  expect(f.actions).not.toHaveBeenCalled();
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'extended' });
});
it('does not treat an unavailable current model as an already-selected proof', async () => {
  const f = fixture();
  f.selections[0]![1]!.availability.status = 'upgrade_required';
  f.freeze();
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'high')).toBe(false);
});
function workSurfaceFixture(cold: boolean) {
  const f = fixture(), doc = page.window.document;
  const versions = f.props.modelsData.versions;
  // Work has a different account picker. The Chat reader must not treat it as
  // an unavailable Chat model, including while the home editor hydrates first.
  f.props.modelsData.versions = [];
  doc.body.insertAdjacentHTML('afterbegin', '<button role="radio" data-tpp-toggle-value="chatgpt" aria-checked="false">Chat</button><button role="radio" data-tpp-toggle-value="work" aria-checked="true">Work</button>');
  const chat = doc.querySelector('[data-tpp-toggle-value="chatgpt"]')!;
  const switchChat = vi.fn(() => {
    chat.setAttribute('aria-checked', 'true');
    doc.querySelector('[data-tpp-toggle-value="work"]')!.setAttribute('aria-checked', 'false');
    doc.querySelector('#prompt-textarea')!.replaceWith(doc.querySelector('#prompt-textarea')!.cloneNode(true));
    f.props.modelsData.versions = versions;
  });
  chat.addEventListener('click', switchChat);
  if (cold) {
    const trigger = doc.querySelector('form button')!, parent = trigger.parentElement!;
    trigger.remove();
    queueMicrotask(() => parent.prepend(trigger));
  }
  return { ...f, chat, switchChat };
}
it.each([false, true])('selects a worker model from the native Work surface after picker hydration (cold=%s)', async cold => {
  const f = workSurfaceFixture(cold);
  expect(await f.api.selectModelSettings('future-model', 'ultra')).toBe(true);
  expect(f.switchChat).toHaveBeenCalledTimes(1);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'future-model', thinkingEffort: 'ultra' });
  expect(page.window.document.querySelector('#prompt-textarea')!.textContent).toBe('');
  expect(await f.api.selectModelSettings('future-model', 'ultra')).toBe(true);
  expect(f.switchChat).toHaveBeenCalledTimes(1);
});
it('refuses model selection when the owned page changes during the Work to Chat transition', async () => {
  const f = workSurfaceFixture(false);
  let current = true;
  f.chat.addEventListener('click', () => { current = false; });
  expect(await f.api.selectModelSettings('future-model', 'ultra', () => current)).toBe(false);
  expect(f.switchChat).toHaveBeenCalledTimes(1);
  expect(f.actions).not.toHaveBeenCalled();
});
it('groups provider family lanes and selects Pro through the same family instead of a separate execution slug', async () => {
  const f = fixture();
  const version = f.props.modelsData.versions[0]!;
  version.id = '5.6'; version.displayTextForIntelligence = 'GPT-5.6 Sol';
  for (const selection of f.selections[0]!) (selection.category as any).modelVersion = '5.6';
  const pro = f.selections[0]![2]!;
  pro.modelSlug = 'gpt-5-6-pro'; pro.availability.status = 'available'; pro.category.shortLabel = '5.6 Pro';
  expect(await f.api.inspectModelSettings()).toContainEqual({ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['medium', 'high', 'pro'], aliases: ['gpt-5-6-thinking', 'gpt-5-6-pro'] });
  expect(await f.api.selectModelSettings('5.6', 'pro')).toBe(true);
  expect(f.state.currentSelection.modelSlug).toBe('gpt-5-6-pro');
  // Existing stored family display slugs retain their requested Pro effort too.
  expect(await f.api.selectModelSettings('gpt-5.6-sol', 'pro')).toBe(true);
});
it('reads an already-open version submenu and restores its original exact power', async () => {
  const f = fixture();
  page.window.document.querySelector('button')!.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  (page.window.document.querySelector('[aria-expanded]') as HTMLElement).click();
  expect(page.window.document.querySelectorAll('[role=menuitemradio]')).toHaveLength(2);
  expect(await f.api.inspectModelSettings()).toHaveLength(2);
  expect(f.state.selectedVersionEntry.id).toBe('latest');
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'extended' });
});
it('invalidates mounted selection proof when provider state becomes unrecognized', async () => {
  const f = fixture();
  page.window.document.querySelector('button')!.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const read = async () => {
    await new Promise<void>(resolve => {
      const receive = (event: MessageEvent) => { if (event.data?.source === 'clf-picker-reply') { page.window.removeEventListener('message', receive as any); resolve(); } };
      page.window.addEventListener('message', receive as any);
      page.window.postMessage({ source: 'clf-picker-ask', nonce: 'fixture' }, page.window.location.origin);
    });
    return f.api.visibleModelSelection();
  };
  expect(await read()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'high' });
  f.state.currentSelection.thinkingEffort = 'unknown-provider-value';
  expect(await read()).toBeNull();
});
it('keeps a native 5.6 High lane High when its transport value is standard', async () => {
  const f = fixture();
  const high = f.selections[0]![1] as any;
  high.thinkingEffort = 'standard';
  high.labels = { effort: 'High' };
  f.state.currentBucket = high.bucket;
  f.state.currentSelection = high;
  await new Promise<void>(resolve => {
    const receive = (event: MessageEvent) => {
      if (event.data?.source !== 'clf-picker-reply') return;
      page.window.removeEventListener('message', receive as any);
      resolve();
    };
    page.window.addEventListener('message', receive as any);
    page.window.postMessage({ source: 'clf-picker-ask', nonce: 'high-transport-standard' }, page.window.location.origin);
  });
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'high' });
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'high')).toBe(true);
  expect(f.state.currentSelection).toBe(high);
});
it('observes direct Chrome selection with the picker closed and invalidates another route', async () => {
  const f = fixture();
  page.window.document.querySelector('[data-testid="composer-trailing-actions"]')!.removeAttribute('data-testid');
  const plus = page.window.document.createElement('button');
  plus.id = 'composer-plus-btn'; plus.setAttribute('aria-haspopup', 'menu');
  page.window.document.querySelector('form')!.append(plus);
  const trigger = page.window.document.querySelector('button')!;
  trigger.textContent = 'Extra High';
  (trigger as any).__reactFiber$test = { memoizedProps: {}, return: { memoizedProps: { currentModelId: 'gpt-5-6-thinking' }, return: null } };
  const scan = () => new Promise<void>(resolve => {
    const receive = (event: MessageEvent) => { if (event.data?.source === 'clf-fiber-reply') { page.window.removeEventListener('message', receive as any); resolve(); } };
    page.window.addEventListener('message', receive as any);
    page.window.postMessage({ source: 'clf-fiber-ask', nonce: 'passive-test' }, page.window.location.origin);
  });
  await scan();
  expect(page.window.document.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
  expect(f.actions).not.toHaveBeenCalled();
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh' });
  const owner = (trigger as any).__reactFiber$test.return;
  owner.return = { memoizedProps: { currentModelId: 'different-model' }, return: null };
  await scan();
  expect(f.api.visibleModelSelection()).toBeNull();
  owner.return = null;
  await scan();
  page.window.history.pushState({}, '', '/c/other');
  expect(f.api.visibleModelSelection()).toBeNull();
  trigger.textContent = 'Unrecognized effort';
  await scan();
  page.window.history.pushState({}, '', '/');
  expect(f.api.visibleModelSelection()).toBeNull();
});
it('keeps an explicit model denial unavailable even when the preset is visible', async () => {
  const f = fixture(); (f.props.modelSwitcherDenialsBySlug as any)['future-model'] = { reason: 'workspace_policy' };
  expect(await f.api.inspectModelSettings()).toEqual([{ id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5-6-thinking'] }]);
});
it('observes the September closed 6 Pro selection without opening or changing a working composer', async () => {
  const f = fixture(), doc = page.window.document, trigger = doc.querySelector('button')!;
  const pro = f.selections[0]![2]!;
  pro.availability.status = 'available';
  f.state.currentBucket = pro.bucket; f.state.currentSelection = pro;
  trigger.innerHTML = '<span>6</span><span>Pro</span>';
  (trigger as any).__reactFiber$test = { memoizedProps: { dropdownContent: { props: f.props } }, return: null };
  doc.querySelector('#prompt-textarea')!.textContent = 'Unsent user draft';
  doc.querySelector('[data-testid="send-button"]')!.setAttribute('data-testid', 'stop-button');
  const observe = () => new Promise<void>(resolve => {
    const receive = (event: MessageEvent) => { if (event.data?.source === 'clf-picker-reply') { page.window.removeEventListener('message', receive as any); resolve(); } };
    page.window.addEventListener('message', receive as any);
    page.window.postMessage({ source: 'clf-picker-ask', nonce: 'closed-selection' }, page.window.location.origin);
  });
  await observe();
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'pro' });
  expect(doc.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
  expect(f.actions).not.toHaveBeenCalled();
  expect(doc.querySelector('#prompt-textarea')!.textContent).toBe('Unsent user draft');
  (f.props.modelSwitcherDenialsBySlug as any)['gpt-6-pro'] = { reason: 'workspace_policy' };
  await observe();
  expect(f.api.visibleModelSelection()).toBeNull();
});
it('recognizes the provider min effort as Low without invalidating the account catalog', async () => {
  const f = fixture(); f.selections[0]![0]!.thinkingEffort = 'min';
  expect(await f.api.inspectModelSettings()).toContainEqual({ id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['low', 'high'], aliases: ['gpt-5-6-thinking'] });
});
it('does not mutate the picker after navigation ownership is lost', async () => {
  const f = fixture(); expect(await f.api.selectModelSettings('future-model', 'ultra', () => false)).toBe(false);
  expect(f.actions).not.toHaveBeenCalled();
});
it('projects an allowlist rather than leaking conversation props through the bridge', async () => {
  const f = fixture(); const replies: unknown[] = [];
  page.window.addEventListener('message', event => { if (event.data?.source === 'clf-picker-reply') replies.push(event.data); });
  await f.api.inspectModelSettings();
  expect(replies.length).toBeGreaterThan(0);
  expect(JSON.stringify(replies)).not.toMatch(/privateSecret|must-never-cross|conversation|modelsData/);
});

it('observes Work grouping ids without changing exact execution ids or merging max with xhigh', async () => {
  const f = fixture(), trigger = page.window.document.querySelector('button')!;
  const version = { id: '6 Astra', displayTextForIntelligence: 'GPT-6 Astra', enabled: true };
  f.props.modelsData.versions.splice(0, f.props.modelsData.versions.length, version);
  const choices = ['min', 'standard', 'extended', 'xhigh', 'max', 'ultra'].map((thinkingEffort, bucket) => ({
    bucket, modelSlug: 'gpt-6-astra-wm', thinkingEffort, availability: { status: 'available' },
    category: { modelLane: 'thinking_plus_plus', modelVersion: '6 Astra', shortLabel: '6 Astra' },
    modelConfig: { title: 'GPT-6 Astra', isWorkModeModel: true }
  }));
  Object.assign(f.state, { bucketSelections: choices, currentBucket: 3, currentSelection: choices[3], selectedVersionEntry: version });
  trigger.innerHTML = '<span>GPT-6 Astra</span><span>Extra High</span>';
  (trigger as any).__reactFiber$test = { memoizedProps: { dropdownContent: { props: f.props } }, return: null };
  const read = () => new Promise<any>(resolve => {
    const receive = (event: MessageEvent) => { if (event.data?.source === 'clf-picker-reply') { page.window.removeEventListener('message', receive as any); resolve(event.data.picker); } };
    page.window.addEventListener('message', receive as any);
    page.window.postMessage({ source: 'clf-picker-ask', nonce: 'work-shape' }, page.window.location.origin);
  });
  const state = await read();
  expect(state?.version).toBe('6 Astra');
  expect(await f.api.selectModelSettings('gpt-6-astra-wm', 'xhigh')).toBe(true);
  expect(state?.choices.map((choice: any) => choice.effort)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-6-astra-wm', reasoningEffort: 'xhigh' });
  Object.assign(f.state, { currentBucket: 4, currentSelection: choices[4] });
  await read();
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-6-astra-wm', reasoningEffort: 'max' });
  (f.state as any).currentSelection = { ...choices[4], modelSlug: 'foreign-model' };
  expect(await read()).toBeNull();
  expect(f.api.visibleModelSelection()).toBeNull();
  Object.assign(f.state, { currentSelection: choices[4] });
  await read();
  page.window.history.pushState({}, '', '/c/other');
  expect(f.api.visibleModelSelection()).toBeNull();
  choices[4]!.modelSlug = 'invalid execution id';
  expect(await read()).toBeNull();
  page.window.history.pushState({}, '', '/');
  expect(f.api.visibleModelSelection()).toBeNull();
  expect(f.actions).not.toHaveBeenCalled();
});
it.each(['high', 'xhigh'])('never silently lowers a requested %s effort to a lower available rung', async effort => {
  const f = fixture();
  if (effort === 'high') f.selections[0]![1]!.availability.status = 'upgrade_required';
  Object.assign(f.state, { currentBucket: 1, currentSelection: f.selections[0]![0]! });
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', effort)).toBe(false);
  expect(f.state.selectedVersionEntry.id).toBe('latest');
  expect(f.state.currentBucket).toBe(1);
  expect(page.window.document.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
});
it('allows an upward same-model effort migration and preserves an explicit Medium request', async () => {
  const f = fixture();
  f.selections[0]![1]!.thinkingEffort = 'max';
  Object.assign(f.state, { currentBucket: 1, currentSelection: f.selections[0]![0]! });
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'high')).toBe(true);
  expect(f.state.currentSelection.thinkingEffort).toBe('max');
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'medium')).toBe(true);
  expect(f.state.currentSelection.thinkingEffort).toBe('standard');
});
it('retains the Chat max-to-xhigh mapping without a Work owner flag', async () => {
  const f = fixture();
  f.state.currentSelection.thinkingEffort = 'max';
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'xhigh')).toBe(true);
  expect(f.state.currentSelection.thinkingEffort).toBe('max');
});
it('does not spend GPT-6 as an automatic fallback when no lower observed rung is available', async () => {
  const f = fixture(), doc = page.window.document, trigger = doc.querySelector('button')!;
  const version = { id: '6 Astra', displayTextForIntelligence: 'GPT-6 Astra', enabled: true };
  f.props.modelsData.versions.splice(0, f.props.modelsData.versions.length, version);
  const choices = ['standard', 'xhigh'].map((thinkingEffort, bucket) => ({
    bucket, modelSlug: bucket ? 'gpt-6-astra-wm' : 'gpt-6-astra-pro', thinkingEffort, availability: { status: 'available' },
    category: { modelLane: bucket ? 'thinking_plus_plus' : 'pro', modelVersion: '6 Astra', shortLabel: '6 Astra' },
    modelConfig: { title: 'GPT-6 Astra', isWorkModeModel: true }
  }));
  Object.assign(f.state, { bucketSelections: choices, currentBucket: 0, currentSelection: choices[0], selectedVersionEntry: version });
  trigger.innerHTML = '<span>GPT-6 Astra</span><span>Pro</span>';
  (trigger as any).__reactFiber$test = { memoizedProps: { dropdownContent: { props: f.props } }, return: null };
  const read = () => new Promise<void>(resolve => {
    const receive = (event: MessageEvent) => { if (event.data?.source === 'clf-picker-reply') { page.window.removeEventListener('message', receive as any); resolve(); } };
    page.window.addEventListener('message', receive as any);
    page.window.postMessage({ source: 'clf-picker-ask', nonce: 'cooldown-state' }, page.window.location.origin);
  });
  await read();
  const section = doc.createElement('section');
  section.dataset.testid = 'conversation-turn-cooldown'; section.dataset.turn = 'assistant'; section.dataset.turnId = 'cooldown-turn';
  const heading = doc.createElement('button'); heading.setAttribute('aria-expanded', 'false'); heading.textContent = 'This model is on cooldown';
  const retry = doc.createElement('button'); retry.textContent = 'Retry';
  const click = vi.fn(); retry.addEventListener('click', click);
  section.append(heading, retry); doc.body.append(section);
  const [error] = f.api.errors();
  expect(error).toMatchObject({ reason: 'model_cooldown', retry });
  expect(await f.api.recoverModelCooldown(error)).toMatchObject({ status: 'waiting', reason: 'preferred_unavailable' });
  expect(f.state.currentSelection.thinkingEffort).toBe('standard');
  expect(click).not.toHaveBeenCalled();
});

it('preserves a provider cooldown without automatic model-family fallback', () => {
  const f = fixture();
  const models = [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['pro'], aliases: ['gpt-6-astra-pro'] },
    { id: '5.6', label: 'GPT-5.6 Sol', efforts: ['xhigh', 'pro'], aliases: ['gpt-5-6-thinking', 'gpt-5-6-pro'] },
    { id: '5.5', label: 'GPT-5.5', efforts: ['pro', 'none'], aliases: ['gpt-5-5-pro', 'gpt-5-5-instant'] }
  ];
  expect(f.api.nextCooldownSelection({ model: 'gpt-6-astra-pro', reasoningEffort: 'pro' }, models))
    .toBeNull();
  expect(f.api.nextCooldownSelection({ model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh' }, models))
    .toBeNull();
  expect(f.api.nextCooldownSelection({ model: 'gpt-5-6-pro', reasoningEffort: 'pro' }, models))
    .toBeNull();
  expect(f.api.nextCooldownSelection({ model: 'gpt-5-5-pro', reasoningEffort: 'pro' }, models)).toBeNull();
  // Model reconciliation is a separate owner, not permission to evade a cooldown.
  expect(f.api.nextCooldownSelection({ model: 'gpt-5-5-instant', reasoningEffort: 'none' }, models))
    .toBeNull();
});

it('holds an Instant automation draft until a preferred model reset instead of selecting Instant', async () => {
  const f = fixture(), trigger = page.window.document.querySelector('button')!;
  const retryAt = Date.now() + 90_000;
  const version = { id: '6 Astra', displayTextForIntelligence: 'GPT-6 Astra', enabled: true };
  const instant = { bucket: 0, modelSlug: 'auto', thinkingEffort: 'instant', availability: { status: 'available' },
    category: { modelLane: 'auto', modelVersion: 'auto', shortLabel: 'Instant' } };
  const pro = { bucket: 1, modelSlug: 'gpt-6-astra-pro', thinkingEffort: 'standard', availability: { status: 'rate_limited', resetAt: retryAt },
    category: { modelLane: 'pro', modelVersion: '6 Astra', shortLabel: '6 Astra' }, modelConfig: { title: 'GPT-6 Astra', isWorkModeModel: true } };
  const xhigh = { ...pro, bucket: 2, modelSlug: 'gpt-6-astra-wm', thinkingEffort: 'xhigh',
    availability: { status: 'rate_limited', resetAt: retryAt + 30_000 }, category: { ...pro.category, modelLane: 'thinking_plus_plus' } };
  f.props.modelsData.versions.splice(0, f.props.modelsData.versions.length, version);
  Object.assign(f.state, { bucketSelections: [instant, pro, xhigh], currentBucket: 0, currentSelection: instant, selectedVersionEntry: version });
  trigger.innerHTML = '<span>Instant</span>';
  (trigger as any).__reactFiber$test = { memoizedProps: { dropdownContent: { props: f.props } }, return: null };
  await syncPicker();
  expect(f.api.visibleModelSelection()).toEqual({ model: 'auto', reasoningEffort: 'none' });
  expect(await f.api.ensurePreferredAutomationModel()).toEqual({ status: 'waiting', reason: 'preferred_unavailable', retryAt });
  expect(f.state.currentSelection).toBe(instant);
});

it('opens the native picker when a fresh chat has no closed-trigger selection yet', async () => {
  const f = fixture();
  const version = f.props.modelsData.versions[0]!;
  version.id = '6'; version.displayTextForIntelligence = 'GPT-6 Astra';
  for (const choice of f.selections[0]!) {
    choice.modelSlug = 'gpt-6-thinking';
    choice.category.shortLabel = '6 Astra';
    (choice.category as any).modelVersion = '6';
  }
  const xhigh = f.selections[0]![1]!;
  xhigh.thinkingEffort = 'xhigh';
  (xhigh.category as any).modelVersion = '6';
  expect(f.api.visibleModelSelection()).toBeNull();

  expect(await f.api.ensurePreferredAutomationModel()).toMatchObject({
    status: 'ready', model: '6', effort: 'xhigh', changed: true
  });
  expect(f.state.currentSelection).toBe(xhigh);
});

it.each([
  ['Pro', 'pro'],
  ['Extra High', 'xhigh']
])('keeps the user-selected GPT-6 %s pair when other preferred rungs are available', async (label, effort) => {
  const f = fixture(), trigger = page.window.document.querySelector('button')!;
  const version = { id: '6', displayTextForIntelligence: 'GPT-6 Astra', enabled: true };
  const pro = { bucket: 0, modelSlug: 'gpt-6-pro', thinkingEffort: 'standard', availability: { status: 'available' },
    category: { modelLane: 'pro', modelVersion: '6', shortLabel: '6' }, modelConfig: { title: 'GPT-6 Astra', isWorkModeModel: true } };
  const xhigh = { ...pro, bucket: 1, modelSlug: 'gpt-6-thinking', thinkingEffort: 'xhigh',
    category: { ...pro.category, modelLane: 'thinking_plus_plus' } };
  const selected = effort === 'pro' ? pro : xhigh;
  f.props.modelsData.versions.splice(0, f.props.modelsData.versions.length, version);
  Object.assign(f.state, { bucketSelections: [pro, xhigh], currentBucket: selected.bucket,
    currentSelection: selected, selectedVersionEntry: version });
  trigger.innerHTML = `<span>GPT-6 Astra</span><span>${label}</span>`;
  (trigger as any).__reactFiber$test = { memoizedProps: { dropdownContent: { props: f.props } }, return: null };
  await syncPicker();
  expect(await f.api.ensurePreferredAutomationModel()).toEqual({
    status: 'ready', model: selected.modelSlug, effort, changed: false
  });
  expect(f.state.currentSelection).toBe(selected);
});

it.each(['high', 'xhigh'])('accepts a proven Astra %s loop without opening a frozen picker', async (effort) => {
  vi.useFakeTimers();
  try {
    const f = fixture(), trigger = page.window.document.querySelector('button')!;
    const version = { id: '6 Astra', displayTextForIntelligence: 'GPT-6 Astra', enabled: true };
    const pro = { bucket: 0, modelSlug: 'gpt-6-astra-pro', thinkingEffort: 'standard', availability: { status: 'available' },
      category: { modelLane: 'pro', modelVersion: '6 Astra', shortLabel: '6 Astra' }, modelConfig: { title: 'GPT-6 Astra', isWorkModeModel: true } };
    const xhigh = { ...pro, bucket: 1, modelSlug: 'gpt-6-astra-wm', thinkingEffort: effort,
      category: { ...pro.category, modelLane: 'thinking_plus_plus' } };
    f.props.modelsData.versions.splice(0, f.props.modelsData.versions.length, version);
    Object.assign(f.state, { bucketSelections: [pro, xhigh], currentBucket: 1, currentSelection: xhigh, selectedVersionEntry: version });
    trigger.innerHTML = `<span>GPT-6 Astra</span><span>${effort === 'high' ? 'High' : 'Extra High'}</span>`;
    (trigger as any).__reactFiber$test = { memoizedProps: { dropdownContent: { props: f.props } }, return: null };
    await syncPicker();
    f.freeze();

    const resolved = await f.api.ensurePreferredAutomationModel();
    expect(resolved).toEqual({ status: 'ready', model: 'gpt-6-astra-wm', effort, changed: false });
    expect(f.actions).not.toHaveBeenCalled();
    expect(f.state.currentSelection).toBe(xhigh);
  } finally {
    vi.useRealTimers();
  }
});

function observePicker() {
  const win = page.window;
  const nonce = win.crypto.randomUUID();
  return new Promise<void>(resolve => {
    const receive = (event: MessageEvent) => {
      if (event.data?.source !== 'clf-picker-reply' || event.data.nonce !== nonce) return;
      win.removeEventListener('message', receive as any); resolve();
    };
    win.addEventListener('message', receive as any);
    win.postMessage({ source: 'clf-picker-ask', nonce }, win.location.origin);
  });
}

it('hotfix: discovers and selects a native version with a retirement caption', async () => {
  const f = fixture(), doc = page.window.document;
  f.decorateVersionRows((row, version) => {
    if (version.id !== 'future') return;
    row.textContent = '';
    const primary = doc.createElement('span'); primary.textContent = version.displayTextForIntelligence;
    const caption = doc.createElement('span'); caption.textContent = 'Leaving on October 14';
    const check = doc.createElement('span'); check.setAttribute('aria-hidden', 'true'); check.textContent = '✓';
    const labels = doc.createElement('div'); labels.append(primary, caption); row.append(check, labels);
  });
  expect(await f.api.inspectModelSettings()).toHaveLength(2);
  expect(f.state.selectedVersionEntry.id).toBe('latest'); expect(f.state.currentBucket).toBe(2);
  expect(doc.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
  expect(await f.api.selectModelSettings('future-model', 'ultra')).toBe(true);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'future-model', thinkingEffort: 'ultra' });
});

it('selects an exact current-version effort without traversing an unrelated broken version', async () => {
  const f = fixture();
  f.decorateVersionRows((row, version) => {
    if (version.id === 'future') row.setAttribute('aria-disabled', 'true');
  });
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'medium')).toBe(true);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'standard' });
  expect(f.actions.mock.calls.filter(call => call[0] === 'version')).toHaveLength(0);
});

it('current-version effort selection preserves provider denial', async () => {
  const f = fixture();
  (f.props.modelSwitcherDenialsBySlug as any)['gpt-5-6-thinking'] = { reason: 'workspace_policy' };
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'medium')).toBe(false);
  expect(f.state.currentSelection.thinkingEffort).toBe('extended');
});

it('selects current-version effort with persistent native advanced version rows', async () => {
  const f = fixture(0, true);
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'medium')).toBe(true);
  expect(f.state.currentSelection.thinkingEffort).toBe('standard');
  expect(f.actions.mock.calls.filter(call => call[0] === 'version')).toHaveLength(0);
  expect(page.window.document.querySelector('[data-model-picker-view]')).toBeNull();
});

it('selects and confirms another version while native advanced version rows remain visible', async () => {
  const f = fixture(0, true);
  expect(await f.api.selectModelSettings('future-model', 'ultra')).toBe(true);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'future-model', thinkingEffort: 'ultra' });
  expect(page.window.document.querySelector('[data-model-picker-view]')).toBeNull();
});

it('persistent native advanced version rows do not bypass a denied effort', async () => {
  const f = fixture(0, true);
  (f.props.modelSwitcherDenialsBySlug as any)['gpt-5-6-thinking'] = { reason: 'workspace_policy' };
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'medium')).toBe(false);
  expect(f.state.currentSelection.thinkingEffort).toBe('extended');
  expect(page.window.document.querySelector('[data-model-picker-view]')).toBeNull();
});

it('does not infer an inline effort view from version rows without native advanced identity', async () => {
  const f = fixture(0, true);
  f.decorateVersionRows(() => page.window.document.querySelector('[data-model-picker-view]')?.removeAttribute('data-model-picker-view'));
  expect(await f.api.selectModelSettings('future-model', 'ultra')).toBe(false);
});

it('hotfix: never treats a model name mentioned only in a row caption as its primary label', async () => {
  const f = fixture(), doc = page.window.document, failure = vi.fn();
  f.decorateVersionRows((row, version) => {
    if (version.id !== 'future') return;
    row.textContent = '';
    const primary = doc.createElement('span'); primary.textContent = 'A different model';
    const caption = doc.createElement('span'); caption.textContent = version.displayTextForIntelligence;
    row.append(primary, caption);
  });
  expect(await f.api.inspectModelSettings(() => true, failure)).toBeNull();
  expect(failure).toHaveBeenCalledWith('model_unconfirmed');
  expect(f.state.selectedVersionEntry.id).toBe('latest'); expect(f.state.currentBucket).toBe(2);
});

it.each(['', 'Medium', 'High', 'Extra High', undefined])('hotfix: missing or effort-only family labels do not invalidate account choices (%s)', async shortLabel => {
  const f = fixture();
  for (const choice of f.selections[0]!.slice(0, 2)) {
    Object.assign(choice.category, { shortLabel, modelVersion: '5.6' });
    (choice as any).modelConfig = { title: 'GPT-5.6 Sol' };
  }
  expect(await f.api.inspectModelSettings()).toContainEqual({ id: '5.6', label: 'GPT-5.6 Sol',
    efforts: ['medium', 'high'], aliases: ['gpt-5-6-thinking'] });
  expect(f.state.currentBucket).toBe(2);
  expect(await f.api.selectModelSettings('gpt-5.6-sol', 'high')).toBe(true);
  expect(await f.api.selectModelSettings('High', 'high')).toBe(false);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'extended' });
});

it('hotfix: absent display titles fall back to the observed slug, never to an invented model or entitlement', async () => {
  const f = fixture();
  for (const choice of f.selections[0]!) delete (choice.category as any).shortLabel;
  const models = await f.api.inspectModelSettings();
  expect(models).toContainEqual({ id: 'gpt-5-6-thinking', label: 'gpt-5-6-thinking',
    efforts: ['medium', 'high'], aliases: ['gpt-5-6-thinking'] });
  expect(models.some((model: any) => model.id === 'gpt-6-pro')).toBe(false);
  expect(await f.api.selectModelSettings('gpt-6-pro', 'pro')).toBe(false);
  f.state.currentSelection.modelSlug = 'invalid execution id';
  expect(await f.api.inspectModelSettings()).toBeNull();
});

it.each([
  ['6 Pro', 'gpt-6-pro', 'pro'], ['6Pro', 'gpt-6-pro', 'pro'],
  ['5.6 High', 'gpt-5-6-thinking', 'high'], ['5.6High', 'gpt-5-6-thinking', 'high'],
  ['Medium', 'gpt-5-6-thinking', 'medium'], ['High', 'gpt-5-6-thinking', 'high'],
  ['Extra High', 'gpt-5-6-thinking', 'xhigh']
])('hotfix: passively observes the closed %s label without opening a menu', async (label, model, reasoningEffort) => {
  const f = fixture(), doc = page.window.document, trigger = doc.querySelector('button')!;
  (trigger as any).__reactFiber$test = { memoizedProps: { currentModelId: model }, return: null };
  trigger.textContent = label;
  doc.querySelector('#prompt-textarea')!.textContent = 'Keep this unsent draft';
  await observePicker();
  expect(f.api.visibleModelSelection()).toEqual({ model, reasoningEffort });
  expect(f.actions).not.toHaveBeenCalled();
  expect(doc.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
  expect(doc.querySelector('#prompt-textarea')!.textContent).toBe('Keep this unsent draft');
  page.window.history.pushState({}, '', '/c/another');
  expect(f.api.visibleModelSelection()).toBeNull();
});

it.each(['Pro', '6 Pro'])('hotfix: a known unavailable %s selection cannot fall through to closed-trigger proof', async label => {
  const f = fixture(), trigger = page.window.document.querySelector('button')!, pro = f.selections[0]![2]!;
  Object.assign(f.state, { currentBucket: pro.bucket, currentSelection: pro });
  trigger.textContent = label;
  (trigger as any).__reactFiber$test = { memoizedProps: {
    currentModelId: 'gpt-6-pro', dropdownContent: { props: f.props }
  }, return: null };
  await observePicker(); expect(f.api.visibleModelSelection()).toBeNull();
  pro.availability.status = 'available';
  await observePicker(); expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'pro' });
  (f.props.modelSwitcherDenialsBySlug as any)['gpt-6-pro'] = { reason: 'workspace_policy' };
  await observePicker(); expect(f.api.visibleModelSelection()).toBeNull();
  expect(f.actions).not.toHaveBeenCalled();
});

it.each([
  ['6 Pro', 'gpt-5-6-pro'], ['6 Pro', 'gpt-6-astra-wm'],
  ['5.6 High', 'gpt-6-thinking'], ['5.6 High', 'gpt-5-6-pro']
])('hotfix: a visible %s label cannot invent or contradict execution identity %s', async (label, model) => {
  const f = fixture(), trigger = page.window.document.querySelector('button')!;
  trigger.textContent = label;
  (trigger as any).__reactFiber$test = { memoizedProps: { currentModelId: model }, return: null };
  await observePicker();
  expect(f.api.visibleModelSelection()).toBeNull(); expect(f.actions).not.toHaveBeenCalled();
});

it('hotfix: duplicate version primary labels remain ambiguous even with different captions', async () => {
  const f = fixture(), doc = page.window.document, failure = vi.fn();
  f.decorateVersionRows((row, version) => {
    if (version.id !== 'future') return;
    const duplicate = row.cloneNode(true) as HTMLElement;
    doc.querySelector('[data-testid="composer-intelligence-picker-content"]')!.append(duplicate);
  });
  expect(await f.api.inspectModelSettings(() => true, failure)).toBeNull();
  expect(failure).toHaveBeenCalledWith('model_unconfirmed');
  expect(f.state.selectedVersionEntry.id).toBe('latest'); expect(f.state.currentBucket).toBe(2);
});

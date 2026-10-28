import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
});
afterEach(() => dom.window.close());

describe('Chinese app interface', () => {
  it('exposes flagged setup choices and keeps them synchronized with settings and reloads', async () => {
    window.localStorage.setItem('cos.ui.language', 'zh-CN');
    const { initLanguage } = await import('../src/renderer/i18n.js');
    initLanguage();
    const english = document.querySelector<HTMLButtonElement>('[data-language="en"]')!;
    const chinese = document.querySelector<HTMLButtonElement>('[data-language="zh-CN"]')!;
    const select = document.getElementById('uiLanguage') as HTMLSelectElement;
    expect(chinese.closest('[data-panel="setup"]')).not.toBeNull();
    expect(chinese.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(english.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(chinese.getAttribute('aria-pressed')).toBe('true');
    expect(select.value).toBe('zh-CN');
    english.click();
    expect(select.value).toBe('en');
    expect(english.getAttribute('aria-pressed')).toBe('true');
    expect(chinese.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.setup-heading h1')!.textContent).toBe('Setup');
    chinese.click();
    expect(select.value).toBe('zh-CN');
    expect(document.querySelector('.setup-heading h1')!.textContent).toBe('连接设置');
    expect(window.localStorage.getItem('cos.ui.language')).toBe('zh-CN');
    select.value = 'en';
    select.dispatchEvent(new dom.window.Event('change'));
    expect(english.getAttribute('aria-pressed')).toBe('true');
    expect(chinese.getAttribute('aria-pressed')).toBe('false');
  });

  it('switches both ways without replacing controls, icons, emphasis, drafts or authored content', async () => {
    const { initLanguage, ui, t } = await import('../src/renderer/i18n.js');
    const { el } = await import('../src/renderer/dom.js');
    initLanguage();
    const input = document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Save\n用户草稿 <script>not markup</script> 🙂';
    input.setSelectionRange(2, 7);
    const automation = document.getElementById('chatAutomation') as HTMLSelectElement;
    automation.value = 'loop';
    const icons = [...document.querySelectorAll('svg')];
    const strong = document.querySelector('.plugin-refresh-guide strong');
    const savedHTML = strong!.outerHTML;
    const authored = el('div', 'msg', 'Save');
    document.body.append(authored);
    const action = el('button', '', () => t('Remove {0}', ['Save <img src=x>']));
    ui(action, 'aria-label', () => t('Remove {0}', ['Save <img src=x>']));
    document.body.append(action);
    const snapshots = new Map<string, string>();
    for (const locale of ['zh-CN', 'en', 'zh-CN', 'en', 'zh-CN'] as const) {
      const language = document.getElementById('uiLanguage') as HTMLSelectElement;
      language.value = locale;
      language.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      expect(document.documentElement.lang).toBe(locale);
      expect(document.getElementById('chatInput')).toBe(input);
      expect(input.value).toBe('Save\n用户草稿 <script>not markup</script> 🙂');
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
      expect(automation.value).toBe('loop');
      expect(authored.textContent).toBe('Save');
      expect(action.querySelector('img')).toBeNull();
      expect(action.textContent).toBe(locale === 'zh-CN' ? '移除 Save <img src=x>' : 'Remove Save <img src=x>');
      expect(action.getAttribute('aria-label')).toBe(action.textContent);
      expect([...document.querySelectorAll('svg')]).toEqual(icons);
      expect(strong!.outerHTML).toBe(savedHTML);
      const text = document.getElementById('newChat')!.textContent!.trim();
      expect(text).toBe(locale === 'zh-CN' ? '新建聊天' : 'New chat');
      const shell = document.querySelector('.plugin-refresh-guide')!.textContent!;
      if (snapshots.has(locale)) expect(shell).toBe(snapshots.get(locale));
      else snapshots.set(locale, shell);
    }
    expect(window.localStorage.getItem('cos.ui.language')).toBe('zh-CN');
  });

  it('retains a newer authored value and persists the explicit language across renderer reloads', async () => {
    const first = await import('../src/renderer/i18n.js');
    first.initLanguage();
    const node = document.createElement('div');
    document.body.append(node);
    first.ui(node, 'textContent', () => first.t('New chat'));
    node.textContent = 'User title — 保留原文';
    first.setLanguage('zh-CN');
    expect(node.textContent).toBe('User title — 保留原文');
    vi.resetModules();
    const next = await import('../src/renderer/i18n.js');
    expect(next.currentLanguage()).toBe('zh-CN');
    expect(next.t('Settings')).toBe('设置');
    expect(next.t('not in the catalog')).toBe('not in the catalog');
    expect(next.t('__proto__')).toBe('__proto__');
    expect(next.t('toString')).toBe('toString');
  });

  it('only refreshes mounted bindings after repeated row replacement, including hidden labels and text nodes', async () => {
    const { ui, uiText, t, setLanguage } = await import('../src/renderer/i18n.js');
    const pane = document.createElement('div');
    pane.hidden = true;
    document.body.append(pane);
    const retiredReads = vi.fn(() => t('Settings'));
    const retired: Node[] = [];
    for (let i = 0; i < 1024; i++) {
      const label = ui(document.createElement('span'), 'textContent', retiredReads);
      pane.replaceChildren(label);
      retired.push(label);
    }
    const live = ui(document.createElement('button'), 'title', () => t('Settings'));
    const text = uiText(() => t('Copy'));
    live.append(text);
    pane.replaceChildren(live);
    retiredReads.mockClear();
    for (const locale of ['zh-CN', 'en', 'zh-CN'] as const) {
      setLanguage(locale);
      expect(live.title).toBe(locale === 'zh-CN' ? '设置' : 'Settings');
      expect(text.textContent).toBe(locale === 'zh-CN' ? '复制' : 'Copy');
      expect(live.firstChild).toBe(text);
    }
    expect(retiredReads).not.toHaveBeenCalled();
    expect(retired).toHaveLength(1024);
    const fresh = ui(document.createElement('span'), 'textContent', () => t('Settings'));
    pane.append(fresh);
    expect(fresh.textContent).toBe('设置');
  });

  it('translates plan chrome while preserving model-authored headlines and details', async () => {
    const { setLanguage } = await import('../src/renderer/i18n.js');
    const { renderAgentPlan } = await import('../src/renderer/agent-plan.js');
    const host = document.createElement('div'); document.body.append(host);
    renderAgentPlan(host, 'session-one', { plan: [{ step: 'Plan', status: 'in_progress', details: 'Keep "Save" exactly as written.' }], explanation: 'Save', updatedAt: 1 } as any);
    const headline = host.querySelector('.agent-plan-step-title');
    setLanguage('zh-CN');
    expect(host.querySelector('.agent-plan-title')!.textContent).toBe('计划');
    expect(host.querySelector('.agent-plan-marker')!.getAttribute('aria-label')).toBe('进行中');
    expect(host.querySelector('.agent-plan-step-title')).toBe(headline);
    expect(headline!.textContent).toBe('Plan');
    expect(host.querySelector('.agent-plan-details')!.textContent).toBe('Keep "Save" exactly as written.');
    expect(host.querySelector('.agent-plan-explanation')!.textContent).toBe('Save');
  });

  it('keeps provider model/effort identities and recorded worker markers unchanged in Chinese', async () => {
    const { setLanguage } = await import('../src/renderer/i18n.js');
    setLanguage('zh-CN');
    let onModels: (value: any) => void = () => {};
    (window as any).api = { onChatModelsChanged: (callback: typeof onModels) => { onModels = callback; return () => {}; } };
    const { initChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
    initChatModels();
    onModels({ state: 'ready', requestedAt: 1, observedAt: 2, models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['high', 'max'], aliases: [] }] });
    const slider = document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
    slider.value = '0'; slider.dispatchEvent(new window.Event('input'));
    const effort = document.getElementById('composerReasoning') as HTMLSelectElement;
    const model = document.getElementById('composerModel') as HTMLSelectElement;
    expect([...effort.options].map(option => option.value)).toEqual(['high', 'max']);
    expect([...effort.options].map(option => option.textContent)).toEqual(['高', '最高']);
    expect(model.value).toBe('gpt-6-astra');
    expect(confirmedComposerModel()).toEqual({ model: 'gpt-6-astra', reasoningEffort: 'high' });
    const { communicationTitle } = await import('../src/renderer/agent-communication.js');
    expect(communicationTitle({ from: 'worker-1', to: 'prime', message: { text: '[worker-1 is awake again] Save' } } as any)).toBe('worker-1 已恢复工作');
    const option = effort.options[0];
    setLanguage('en');
    expect(effort.options[0]).toBe(option);
    expect(option!.textContent).toBe('High');
    expect(confirmedComposerModel()).toEqual({ model: 'gpt-6-astra', reasoningEffort: 'high' });
  });

  it('translates account/profile chrome, lifecycle copy, errors and interpolation without translating profile identities', async () => {
    window.localStorage.setItem('cos.ui.language', 'zh-CN');
    const { initLanguage, setLanguage, t, ui } = await import('../src/renderer/i18n.js');
    initLanguage();

    expect(document.getElementById('instanceSwitcherMeta')!.textContent).toBe('正在加载账户…');
    expect(document.getElementById('instanceManageProfiles')!.textContent).toBe('管理账户和设备…');
    expect(document.getElementById('instanceDrainApply')!.textContent).toBe('排空并应用更新');
    expect(document.getElementById('instanceCreateDialogTitle')!.textContent).toBe('添加账户或设备');
    expect(document.getElementById('instanceConnectorSetup')!.querySelector('summary')!.textContent).toBe('连接器设置');
    expect(document.getElementById('instanceReconnectConnector')!.textContent!.trim()).toBe('验证 / 重新连接');
    expect(document.getElementById('instanceCreateBrowser')!.getAttribute('placeholder')).toBe('例如：Profile 2');

    expect(t('{0} active · {1} queued', [2, 3])).toBe('2 个活跃 · 3 个排队');
    expect(t('Type “{0}” to confirm removal. This removes the local profile only.', ['Work']))
      .toBe('输入“Work”确认移除。此操作仅移除本地配置。');
    expect(t('worker(s) are active, detached, or waking')).toBe('子智能体仍处于活跃、无标签页或唤醒状态');
    expect(t('This profile still has a connector API key. Clear its connector setup before removing it.'))
      .toBe('此配置仍有连接器 API 密钥。请先清除连接器设置再移除。');

    const nickname = document.createElement('strong');
    nickname.textContent = 'Work';
    document.body.append(nickname);
    const dynamic = ui(document.createElement('span'), 'textContent', () => t('Profile switch queued after current work.'));
    document.body.append(dynamic);
    expect(dynamic.textContent).toBe('已安排在当前工作完成后切换配置。');
    setLanguage('en');
    expect(dynamic.textContent).toBe('Profile switch queued after current work.');
    expect(nickname.textContent).toBe('Work');
    setLanguage('zh-CN');
    expect(dynamic.textContent).toBe('已安排在当前工作完成后切换配置。');
    expect(nickname.textContent).toBe('Work');
  });

  it('translates sign-out emergency controls and wake copy without changing the checkbox or account identity', async () => {
    const { initLanguage, setLanguage, t } = await import('../src/renderer/i18n.js');
    initLanguage();
    const input = document.getElementById('signOutEmergencyAlerts') as HTMLInputElement;
    const row = document.getElementById('signOutEmergencyAlertsSetting')!;
    input.checked = true;
    setLanguage('zh-CN');

    expect(row.querySelector('b')!.textContent).toBe('ChatGPT 退出登录紧急提醒');
    expect(row.querySelector('em')!.textContent).toBe('当配套扩展明确检测到此账户已退出登录时，暂停浏览器任务派发，并通过 DPAPI 凭据发送一次 Pushover 紧急提醒。当地时间晚上 10 点至早上 8 点，还会播放一次有时限的电脑唤醒提示音。仅支持 Windows。');
    const account = 'Account <raw> — 保留';
    const wake = 'ChatGPT signed out for {0}. Browser dispatch is paused. A bounded wake-up alert is playing.';
    expect(t(wake, [account])).toBe(`账户 ${account} 的 ChatGPT 已退出登录。浏览器任务派发已暂停。正在播放有时限的唤醒提示音。`);
    expect(document.getElementById('signOutEmergencyAlerts')).toBe(input);
    expect(input.checked).toBe(true);

    setLanguage('en');
    expect(row.querySelector('b')!.textContent).toBe('ChatGPT sign-out emergency');
    expect(t(wake, [account])).toBe(`ChatGPT signed out for ${account}. Browser dispatch is paused. A bounded wake-up alert is playing.`);
    expect(input.checked).toBe(true);
  });

  it('covers every static app label and keeps interpolated content in translated messages', async () => {
    const { catalog } = await import('../src/renderer/i18n.js');
    const walker = document.createTreeWalker(document.body, 4);
    const missing: string[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
      const text = node.textContent!.replace(/\s+/g, ' ').trim();
      if (/[a-zA-Z]{2}/.test(text) && !catalog[text]) missing.push(text);
    }
    for (const node of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
      for (const attr of ['title', 'placeholder', 'aria-label']) {
        const text = node.getAttribute(attr);
        if (text && /[a-zA-Z]{2}/.test(text) && !catalog[text]) missing.push(text);
      }
    }
    expect(missing).toEqual([]);
    for (const [key, translation] of Object.entries(catalog)) {
      expect(translation.trim(), key).not.toBe('');
      expect([...translation.matchAll(/\{\d+\}/g)].map(match => match[0]).sort(), key)
        .toEqual([...key.matchAll(/\{\d+\}/g)].map(match => match[0]).sort());
    }
  });
});

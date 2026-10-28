import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_GOAL_MODEL, DEFAULT_GOAL_SYSTEM_PROMPT } from '../src/shared/goal.js';
import { BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS } from '../src/shared/browser-control.js';

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

it('exposes a labelled fresh-turn interval control with Off and an accurate scope description', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/' });
  const select = dom.window.document.querySelector<HTMLSelectElement>('#rotateTurnMinutes')!;
  expect(select.closest('label')?.textContent).toContain('Fresh turns for long work');
  expect([...select.options].map(option => option.value)).toEqual(['0', '20', '30', '45', '60']);
  expect(select.closest('label')?.textContent).toContain('Pro, Goal, Loop and worker chats');
  const source = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'main.ts'), 'utf8');
  expect(source).toContain("rotateTurnMinutes: Number($<HTMLSelectElement>('rotateTurnMinutes').value)");
  expect(source).toContain("String(config.ui.rotateTurnMinutes ?? 30)");
  expect(source).toContain('rotationInterval.add(new Option(');
});

it('keeps the delete-all control inside the protected Settings danger zone', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/' });
  const button = dom.window.document.querySelector<HTMLButtonElement>('#purgeAllSessions');
  expect(button).not.toBeNull();
  expect(button?.closest('.danger-zone')).not.toBeNull();
  expect(button?.closest('[data-view="settings"]')).not.toBeNull();
  expect(button?.textContent).toContain('Delete everything');
});

it('exposes the default-off per-account sign-out emergency control with the bounded night window', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/' });
  const input = dom.window.document.querySelector<HTMLInputElement>('#signOutEmergencyAlerts');
  const row = dom.window.document.querySelector<HTMLElement>('#signOutEmergencyAlertsSetting');
  expect(input).not.toBeNull();
  expect(input?.checked).toBe(false);
  expect(row?.textContent).toMatch(/DPAPI-backed Pushover emergency/i);
  expect(row?.textContent).toMatch(/10 PM–8 AM local/i);
});

it('keeps sign-out audio owned across majority disarm and stale async completions without playing sound', async () => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node
  });
  vi.spyOn(w, 'setTimeout').mockImplementation((() => 1) as typeof w.setTimeout);

  type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
  const deferred = (): Deferred => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const resumes: Deferred[] = [];
  const oscillators: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    private readonly resumeGate = deferred();
    constructor() { resumes.push(this.resumeGate); }
    createOscillator() {
      const oscillator = {
        type: 'sine',
        connect: vi.fn(),
        frequency: { setValueAtTime: vi.fn() },
        start: vi.fn(),
        stop: vi.fn()
      };
      oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      return {
        connect: vi.fn(),
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn()
        }
      };
    }
    resume() { return this.resumeGate.promise; }
    close() { return Promise.resolve(); }
  }
  Object.defineProperty(w, 'AudioContext', { value: FakeAudioContext, configurable: true });

  const chat = await import('../src/renderer/chat.js');
  const first = chat.playSignOutEmergencyAlarm('profile-a', 'A');
  chat.disarmMajorityAlarmAudioForTests();
  expect(oscillators[0]?.stop).toHaveBeenCalledTimes(1);

  const second = chat.playSignOutEmergencyAlarm('profile-b', 'B');
  expect(oscillators[0]?.stop).toHaveBeenCalledTimes(2);
  resumes[0]!.resolve();
  await first;
  expect(oscillators[1]?.stop).toHaveBeenCalledTimes(1);
  expect(w.document.querySelector('.toast')).toBeNull();

  const third = chat.playSignOutEmergencyAlarm('profile-c', 'C');
  expect(oscillators[1]?.stop).toHaveBeenCalledTimes(2);
  resumes[1]!.reject(new Error('stale resume failure'));
  await second;
  expect(oscillators[2]?.stop).toHaveBeenCalledTimes(1);

  chat.silenceSignOutEmergencyAlarm('profile-b');
  expect(oscillators[2]?.stop).toHaveBeenCalledTimes(1);
  chat.silenceSignOutEmergencyAlarm('profile-c');
  expect(oscillators[2]?.stop).toHaveBeenCalledTimes(2);
  resumes[2]!.reject(new Error('cleanup'));
  await third;
});

it('selects and copies only a clicked notification message', async () => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node
  });
  const { toastAction } = await import('../src/renderer/dom.js');
  toastAction('Session recording failed at the browser bridge.', 'Retry', () => undefined);
  const notice = w.document.querySelector<HTMLElement>('.toast')!;
  const message = w.document.querySelector<HTMLElement>('.toast-message')!;

  message.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(w.document.activeElement).toBe(notice);
  expect(w.getSelection()?.toString()).toBe('Session recording failed at the browser bridge.');

  const setData = vi.fn();
  const copy = new w.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(copy, 'clipboardData', { value: { setData } });
  message.dispatchEvent(copy);
  expect(setData).toHaveBeenCalledWith('text/plain', 'Session recording failed at the browser bridge.');
  expect(copy.defaultPrevented).toBe(true);
  expect(w.getSelection()?.toString()).not.toContain('Retry');
});

it('does not overwrite a focused dirty settings field on an unsolicited state push', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  let stateListener: (state: any) => void = () => undefined;
  const baseConfig = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: true,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: false, edit: false, move: false, deleteFile: false, command: false,
      screen: false, control: false, clipboardRead: false, clipboardWrite: false
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT
    }
  };
  const state = {
    config: baseConfig,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  };
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const logTime = Date.UTC(2026, 9, 2, 15, 4, 5);
  const api: any = new Proxy({
    getState: () => ok(state),
    getLog: () => ok([{ time: logTime, level: 'info', message: 'usage overview sessions=1 rebuilt=1' }]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onStateChanged: (fn: any) => { stateListener = fn; return () => undefined; },
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const field = w.document.getElementById('tunnelId') as HTMLInputElement;
  expect(field.value).toBe(baseConfig.tunnel.tunnelId);
  field.focus();
  field.value = 'tunnel_USER_IS_STILL_TYPING';

  stateListener(structuredClone(state));

  expect(w.document.activeElement).toBe(field);
  expect(field.value).toBe('tunnel_USER_IS_STILL_TYPING');

  const clock = () => w.document.querySelector('#fullFeed time')!.textContent!;
  expect(clock()).toBe(new Date(logTime).toLocaleTimeString('en'));
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('zh-CN');
  expect(clock()).toBe(new Date(logTime).toLocaleTimeString('zh-CN'));
  setLanguage('en');

  const multiAgent = w.document.getElementById('homeMaEnabled') as HTMLInputElement;
  multiAgent.focus();
  multiAgent.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(multiAgent);
  expect(multiAgent.checked).toBe(true);

  const allowUnattributed = w.document.getElementById('allowUnattributedCalls') as HTMLInputElement;
  allowUnattributed.focus();
  allowUnattributed.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(allowUnattributed);
  expect(allowUnattributed.checked).toBe(true);

  // The settings sheet used to bypass the dirty-field guard used by Home. An unrelated
  // status push therefore erased this value while the user was still typing it.
  const compactionThreshold = w.document.getElementById('autoCompactTokens') as HTMLInputElement;
  compactionThreshold.focus();
  compactionThreshold.value = '355000';
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(compactionThreshold);
  expect(compactionThreshold.value).toBe('355000');

  compactionThreshold.blur();
  const updatedThreshold = structuredClone(state) as any;
  updatedThreshold.config.compaction.autoTokens = 320000;
  stateListener(updatedThreshold);
  expect(compactionThreshold.value).toBe('320000');

  const goalPrompt = w.document.getElementById('goalPrompt') as HTMLTextAreaElement;
  goalPrompt.focus();
  goalPrompt.value = 'USER IS STILL EDITING THIS PROMPT';
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(goalPrompt);
  expect(goalPrompt.value).toBe('USER IS STILL EDITING THIS PROMPT');

  // The health card reports the live surface projection rather than a hand-maintained
  // denominator. Tool consolidation/additions should never leave the UI saying "of 9"
  // when nine is no longer the product's actual maximum.
  const withTools = structuredClone(state) as any;
  withTools.status.surfaces = [
    {
      id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
      available: true, localUrl: null, publicUrl: null, tools: ['read', 'apply_patch'],
      state: 'off', detail: '', lastRequestAt: null, lastToolCallAt: null
    },
    {
      id: 'desktop', connectorName: 'Desktop', description: '', cardSummary: '', optional: true,
      available: true, localUrl: null, publicUrl: null, tools: ['observe'],
      state: 'off', detail: '', lastRequestAt: null, lastToolCallAt: null
    }
  ];
  stateListener(withTools);
  expect(w.document.getElementById('facts')!.textContent).toContain('Tools across Core + Desktop3 total');
  expect(w.document.getElementById('facts')!.textContent).not.toContain('of 9');

  const withMissingMacAccess = structuredClone(withTools) as any;
  withMissingMacAccess.platform = { family: 'macos', name: 'macOS', desktopAutomation: true };
  withMissingMacAccess.config.readOnly = false;
  withMissingMacAccess.config.capabilities.screen = true;
  withMissingMacAccess.config.capabilities.control = true;
  withMissingMacAccess.desktopAccess = {
    screen: 'granted',
    accessibility: 'missing',
    checkedAt: 1,
    error: null
  };
  stateListener(withMissingMacAccess);
  const accessWarning = w.document.getElementById('desktopAccess')!;
  expect(accessWarning.hidden).toBe(false);
  expect(accessWarning.textContent).toContain('Accessibility: missing');
  expect(accessWarning.textContent).toContain('live verdicts from the native backend');
  expect((w.document.getElementById('openDesktopScreen') as HTMLButtonElement).hidden).toBe(true);
  expect((w.document.getElementById('openDesktopAccessibility') as HTMLButtonElement).hidden).toBe(false);

  const withReadOnlyMacAccess = structuredClone(withMissingMacAccess) as any;
  withReadOnlyMacAccess.config.readOnly = true;
  stateListener(withReadOnlyMacAccess);
  expect(accessWarning.hidden).toBe(true);
});

it('serializes settings intent so rapid toggles and later UI changes cannot undo each other', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const baseConfig = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as 'light' | 'dark' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT
    }
  };
  const appState = (config: typeof baseConfig) => ({
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  });
  let current = appState(baseConfig);
  const calls: any[] = [];
  const pending: Array<(reply: any) => void> = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const saveSettings = (patch: any) => {
    calls.push(structuredClone(patch));
    return new Promise<any>((resolve) => pending.push(resolve));
  };
  const api: any = new Proxy({
    getState: () => ok(current),
    getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    saveSettings,
    onStateChanged: () => () => undefined,
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  // First save toggles a value that has no form control of its own. Keep the IPC unresolved,
  // matching a real save that is waiting for bridge/tunnel lifecycle work in the main process.
  (w.document.getElementById('readOnlyBtn') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].readOnly).toBe(true);

  // A second click before the first acknowledgement means "back off". The old handler derived
  // both clicks from state.config.readOnly=false, so both snapshots requested true and the two
  // clicks behaved like one.
  (w.document.getElementById('readOnlyBtn') as HTMLButtonElement).click();

  // While both are queued, change an unrelated checkbox. It must inherit the latest requested
  // read-only intent rather than the stale acknowledged state.
  const auto = w.document.getElementById('autoConnect') as HTMLInputElement;
  auto.checked = true;
  auto.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toHaveLength(1);

  current = appState({ ...baseConfig, readOnly: true });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1].readOnly).toBe(false);
  expect(calls[1].ui.autoConnect).toBe(false);

  current = appState({ ...baseConfig, readOnly: false });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2].readOnly).toBe(false);
  expect(calls[2].ui.autoConnect).toBe(true);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Theme has the same no-form-control shape. Two rapid clicks must request dark then light,
  // even though the first dark save has not answered yet.
  const theme = w.document.getElementById('themeBtn') as HTMLButtonElement;
  theme.click();
  await vi.waitFor(() => expect(calls).toHaveLength(4));
  expect(calls[3].ui.theme).toBe('dark');
  theme.click();
  expect(calls).toHaveLength(4);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true, theme: 'dark' } });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(5));
  expect(calls[4].ui.theme).toBe('light');

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true, theme: 'light' } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/**
 * The goal loop's settings panel.
 *
 * Three things are worth pinning here and the rest is layout: the key never travels with the
 * settings, the catalogue is only fetched when somebody asks for it, and an install with no
 * key says so in the words the extension says it in.
 */

interface GoalMount {
  window: JSDOM['window'];
  calls: any[];
  keys: Array<{ method: string; value: string }>;
  modelPages: any[];
  push(state: any): void;
  state: any;
}

async function mountChat(
  overrides: Record<string, unknown> = {},
  models: any[] = [],
  apiOverrides: Record<string, (...args: any[]) => any> = {},
  initialGoal: Record<string, unknown> = {}
): Promise<GoalMount> {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, { Event: w.Event });
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const config = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as const },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT,
      ...initialGoal
    }
  };
  const state: any = {
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null },
    ...overrides
  };
  let listener: (next: any) => void = () => undefined;
  const calls: any[] = [];
  const keys: Array<{ method: string; value: string }> = [];
  const modelPages: any[] = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getLog: () => ok([]),
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onStateChanged: (fn: any) => {
        listener = fn;
        return () => undefined;
      },
      onLogEntry: () => () => undefined,
      onSwarmChanged: () => () => undefined,
      onSessionChanged: () => () => undefined,
      listSessions: () => ok({ sessions: [], activeId: null, pressure: [] }),
      // Answers with the config it just stored, the way the real handler does. The panel
      // paints from the app's answer rather than from what it just clicked, so a fake that
      // replied with the old config would be testing a revert.
      saveSettings: (patch: any) => {
        calls.push(structuredClone(patch));
        state.config = { ...state.config, ...structuredClone(patch) };
        return ok(state);
      },
      setGoalKey: (value: string) => {
        keys.push({ method: 'setGoalKey', value });
        return ok({ ...state, hasGoalKey: value !== '' });
      },
      setApiKey: (value: string) => {
        keys.push({ method: 'setApiKey', value });
        return ok(state);
      },
      listGoalModels: (offset: number) => {
        const page = { models: models.slice(offset, offset + 20), total: models.length, offset };
        modelPages.push(page);
        return ok(page);
      },
      ...apiOverrides
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return (..._args: any[]) => ok(null);
      }
    }
  );
  Object.defineProperty(w, 'api', { value: api, configurable: true });
  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { window: w, calls, keys, modelPages, state, push: (next) => listener(next) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('defers hidden Activity feed layout until shown and preserves a reader scrolled away from the newest line', async () => {
  let append: (entry: any) => void = () => undefined;
  const mounted = await mountChat({}, [], { onLogEntry: (listener) => { append = listener; return () => undefined; } });
  const doc = mounted.window.document, feed = doc.getElementById('fullFeed')!;
  const panel = feed.closest('.panel')!;
  panel.classList.remove('is-active');
  let reads = 0;
  Object.defineProperty(feed, 'scrollHeight', { configurable: true, get: () => { reads++; return 1000; } });
  Object.defineProperty(feed, 'clientHeight', { configurable: true, value: 200 });
  append({ time: Date.now(), level: 'info', message: 'bounded hidden Activity update' });
  expect(reads).toBe(0);
  expect(feed.children.length).toBeGreaterThan(0);
  const tab = doc.querySelector<HTMLButtonElement>('nav button[data-tab="activity"]')!;
  expect(tab).not.toBeNull();
  tab.click();
  expect(panel.classList.contains('is-active')).toBe(true);
  expect(reads).toBe(1);
  expect(feed.scrollTop).toBe(1000);
  feed.scrollTop = 100;
  feed.dispatchEvent(new mounted.window.Event('scroll'));
  reads = 0;
  append({ time: Date.now(), level: 'info', message: 'preserve the reader position' });
  expect(reads).toBe(0);
  expect(feed.scrollTop).toBe(100);
});

it('keeps the computer awake by default and saves the explicit per-account Off choice', async () => {
  const mounted = await mountChat();
  const checkbox = mounted.window.document.querySelector<HTMLInputElement>('#keepAwake');
  expect(checkbox).not.toBeNull();
  expect(checkbox!.checked).toBe(true);
  expect(checkbox!.getAttribute('aria-describedby')).toBe('keepAwakeHint');
  expect(mounted.window.document.getElementById('keepAwakeHint')?.textContent).toContain('The screen can still turn off.');
  checkbox!.checked = false;
  checkbox!.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.ui.keepAwake).toBe(false);
});

it('retains an existing per-account keep-awake Off setting on render', async () => {
  const mounted = await mountChat();
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, keepAwake: false } } });
  const checkbox = mounted.window.document.querySelector<HTMLInputElement>('#keepAwake');
  expect(checkbox).not.toBeNull();
  expect(checkbox!.checked).toBe(false);
});

it('renders Disconnect as a single disabled transition while accepted requests drain', async () => {
  const connect = vi.fn();
  const disconnect = vi.fn();
  const mounted = await mountChat({}, [], { connect, disconnect });
  const draining = structuredClone(mounted.state) as any;
  draining.status.state = 'disconnecting';
  draining.status.detail = 'Disconnecting; waiting for accepted requests to finish…';
  mounted.push(draining);

  const doc = mounted.window.document;
  const connectButton = doc.getElementById('connectBtn') as HTMLButtonElement;
  const wizardButton = doc.getElementById('wizConnect') as HTMLButtonElement;
  expect(doc.getElementById('liveState')!.textContent).toBe('Disconnecting');
  expect(doc.getElementById('live')!.classList.contains('is-busy')).toBe(true);
  expect(doc.getElementById('connectLabel')!.textContent).toBe('Disconnecting…');
  expect(connectButton.disabled).toBe(true);
  expect(connectButton.title).toBe('');
  expect(wizardButton.textContent).toBe('Disconnecting…');
  expect(wizardButton.disabled).toBe(true);
  expect(doc.getElementById('wizStatus')!.textContent).toContain('waiting for accepted requests');

  // Programmatic/replayed clicks must not turn the transitional state into a Connect.
  connectButton.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
  wizardButton.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
  await settle();
  expect(connect).not.toHaveBeenCalled();
  expect(disconnect).not.toHaveBeenCalled();
});

it.each(['connectBtn', 'wizConnect'])(
  'persists valid Setup drafts before %s starts the tunnel',
  async (buttonId) => {
    let live: any;
    const order: string[] = [];
    const connect = vi.fn(() => {
      order.push('connect');
      expect(live.config.tunnel.tunnelId).toBe(`tunnel_${'b'.repeat(32)}`);
      expect(live.hasApiKey).toBe(true);
      live.status.state = 'connected';
      return Promise.resolve({ ok: true as const, data: structuredClone(live) });
    });
    const mounted = await mountChat({}, [], {
      saveSettings: (patch: any) => {
        order.push('settings');
        live.config = { ...live.config, ...structuredClone(patch) };
        return Promise.resolve({ ok: true as const, data: structuredClone(live) });
      },
      setApiKey: () => {
        order.push('key');
        live.hasApiKey = true;
        return Promise.resolve({ ok: true as const, data: structuredClone(live) });
      },
      connect
    });
    live = mounted.state;
    live.config.tunnel.tunnelId = '';
    live.hasApiKey = false;
    mounted.push(structuredClone(live));

    const doc = mounted.window.document;
    const tunnel = doc.getElementById('tunnelId') as HTMLInputElement;
    const key = doc.getElementById('apiKey') as HTMLInputElement;
    expect((doc.getElementById('wizConnect') as HTMLButtonElement).disabled).toBe(true);
    tunnel.value = `tunnel_${'b'.repeat(32)}`;
    tunnel.dispatchEvent(new mounted.window.Event('input'));
    key.value = 'sk-valid-setup-draft';
    key.dispatchEvent(new mounted.window.Event('input'));

    expect((doc.getElementById(buttonId) as HTMLButtonElement).disabled).toBe(false);
    (doc.getElementById(buttonId) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(order).toEqual(['settings', 'key', 'connect']);
  }
);

it('projects Core connection recovery as Recovering / Waiting for Core / Needs attention and clears stale states', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const core = {
    id: 'core', connectorName: 'Luna Forge X7 Core', description: 'Core tools', cardSummary: 'Core', optional: false,
    available: true, localUrl: 'http://127.0.0.1:8765/mcp', publicUrl: null, tools: ['read'],
    state: 'starting', detail: 'Reconnecting in 2s…', lastRequestAt: null, lastToolCallAt: null
  };

  const recovering = structuredClone(mounted.state) as any;
  recovering.status.state = 'connecting-tunnel';
  recovering.status.detail = 'Reconnecting in 2s…';
  recovering.status.surfaces = [core];
  mounted.push(recovering);
  expect(doc.getElementById('liveState')!.textContent).toBe('Recovering');
  expect(doc.getElementById('live')!.classList.contains('is-busy')).toBe(true);
  expect(doc.getElementById('connectLabel')!.textContent).toBe('Disconnect');

  const waiting = structuredClone(recovering) as any;
  waiting.status.state = 'offline';
  waiting.status.detail = 'This PC cannot reach OpenAI; the tunnel keeps retrying on its own.';
  waiting.status.surfaces = [{ ...core, state: 'error', detail: waiting.status.detail }];
  mounted.push(waiting);
  expect(doc.getElementById('liveState')!.textContent).toBe('Waiting for Core');
  expect(doc.getElementById('live')!.classList.contains('is-offline')).toBe(true);
  expect(doc.getElementById('live')!.classList.contains('is-error')).toBe(false);
  expect(doc.getElementById('connectLabel')!.textContent).toBe('Disconnect');
  expect(doc.getElementById('connectorCards')!.textContent).toContain('Waiting for Core');

  const attention = structuredClone(waiting) as any;
  attention.status.state = 'auth-failed';
  attention.status.detail = 'The tunnel rejected the API key.';
  attention.status.surfaces = [{ ...core, state: 'error', detail: attention.status.detail }];
  mounted.push(attention);
  expect(doc.getElementById('liveState')!.textContent).toBe('Needs attention');
  expect(doc.getElementById('live')!.classList.contains('is-error')).toBe(true);
  expect(doc.getElementById('connectLabel')!.textContent).toBe('Connect');

  const connected = structuredClone(attention) as any;
  connected.status.state = 'connected';
  connected.status.detail = 'Connected.';
  connected.status.handshakeAt = Date.now();
  connected.status.surfaces = [{ ...core, state: 'live', detail: 'Connected.' }];
  mounted.push(connected);
  expect(doc.getElementById('liveState')!.textContent).toBe('Connected');
  expect(doc.getElementById('live')!.classList.contains('is-connected')).toBe(true);
  expect(doc.getElementById('live')!.classList.contains('is-error')).toBe(false);
  expect(doc.getElementById('live')!.classList.contains('is-offline')).toBe(false);
  expect(doc.getElementById('connectorCards')!.textContent).not.toContain('Waiting for Core');
});

it('always offers setup collapse and preserves the choice across incomplete status updates', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const button = doc.getElementById('wizExpand') as HTMLButtonElement;
  expect(button.hidden).toBe(false);
  button.click();
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(true);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  mounted.push({ ...mounted.state, hasApiKey: true });
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(true);
  button.click();
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(false);
});

it('adds and selects setup profiles and rejects an older profile status response', async () => {
  const add = vi.fn(); const select = vi.fn();
  const mounted = await mountChat({}, [], { addSetupProfile: add, selectSetupProfile: select });
  const doc = mounted.window.document;
  // jsdom does not implement native dialogs/popovers; Chromium acceptance covers their UI.
  const dialog = doc.getElementById('setupProfileDialog') as HTMLDialogElement;
  dialog.showModal = vi.fn(); dialog.close = vi.fn();
  doc.getElementById('setupProfileMenu')!.hidePopover = vi.fn();
  const initial = structuredClone(mounted.state);
  const next = { ...initial, config: { ...initial.config, tunnel: { ...initial.config.tunnel,
    profileId: 'second', profileName: 'Work', profileEpoch: 1, tunnelId: '' },
    setupProfiles: [{ id: 'default', name: 'Default', tunnelId: initial.config.tunnel.tunnelId, desktopTunnelId: '', pluginsTunnelId: '' }] } };
  add.mockResolvedValue({ ok: true, data: next });
  (doc.getElementById('setupProfileAdd') as HTMLButtonElement).click();
  expect(dialog.showModal).toHaveBeenCalled();
  (doc.getElementById('setupProfileName') as HTMLInputElement).value = 'Work';
  doc.getElementById('setupProfileForm')!.dispatchEvent(new mounted.window.Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(doc.getElementById('setupProfileCurrent')!.textContent).toBe('Work'));
  expect(add).toHaveBeenCalledWith('Work');
  expect((doc.getElementById('tunnelId') as HTMLInputElement).value).toBe('');
  mounted.push(initial);
  expect(doc.querySelector('[data-profile-id="second"]')!.getAttribute('aria-pressed')).toBe('true');
  select.mockResolvedValue({ ok: true, data: { ...initial, config: { ...initial.config, tunnel: {
    ...initial.config.tunnel, profileId: 'default', profileEpoch: 2 }, setupProfiles: [] } } });
  (doc.querySelector('[data-profile-id="default"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(select).toHaveBeenCalledWith('default'));
  await vi.waitFor(() => expect((doc.getElementById('tunnelId') as HTMLInputElement).value).toBe(initial.config.tunnel.tunnelId));
});

function instanceProfileFixture(id: string, overrides: Record<string, unknown> = {}): any {
  const now = Date.now();
  return {
    id,
    nickname: id === 'personal' ? 'Personal' : 'Work',
    platform: id === 'personal' ? 'win32' : 'darwin',
    enabled: true,
    active: id === 'personal',
    browserProfileDirectory: id === 'personal' ? 'Default' : 'Profile 2',
    browserAuth: id === 'personal' ? 'signed-in' : null,
    connection: {
      state: id === 'personal' ? 'connected' : 'offline',
      detail: id === 'personal' ? 'Connected' : 'Browser profile is offline',
      core: {
        state: id === 'personal' ? 'live' : 'error',
        detail: id === 'personal' ? 'Core is live' : 'Core connector needs attention',
        lastSuccessfulRequestAt: id === 'personal' ? now - 5_000 : null,
        error: id === 'personal' ? null : 'Connector has not reached ChatGPT.'
      }
    },
    activeWorkers: id === 'personal' ? 2 : 0,
    queuedWorkers: id === 'personal' ? 1 : 3,
    pendingOperations: id === 'personal' ? [] : [{ kind: 'worker', label: 'Worker handoff', status: 'queued' }],
    connector: {
      displayName: id === 'personal' ? 'Luna Forge X7 Personal Core' : 'Luna Forge X7 Work Core',
      description: id === 'personal' ? 'Exact Personal Core description.' : 'Exact Work Core description.',
      mcpUrl: id === 'personal' ? 'https://personal.example/mcp' : 'https://work.example/mcp',
      status: id === 'personal' ? 'live' : 'error',
      lastSuccessfulRequestAt: id === 'personal' ? now - 5_000 : null,
      error: id === 'personal' ? null : 'Connector has not reached ChatGPT.'
    },
    ...overrides
  };
}

function mockDialog(w: JSDOM['window'], id: string): HTMLDialogElement {
  const dialog = w.document.getElementById(id) as HTMLDialogElement;
  dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
  dialog.close = vi.fn(() => {
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new w.Event('close'));
  });
  return dialog;
}

it('renders the top-left account switcher with truthful health and queues a busy switch after work', async () => {
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const personal = instanceProfileFixture('personal');
  const work = instanceProfileFixture('work');
  const snapshot = { activeProfileId: 'personal', profiles: [personal, work], drain: null };
  let changed: (next: any) => void = () => undefined;
  const switchProfile = vi.fn(async (_id: string, mode: 'check' | 'after-work') => ok({
    snapshot: mode === 'after-work'
      ? { ...snapshot, drain: { state: 'draining', pendingOperations: 1, detail: 'Waiting for one active worker.' } }
      : snapshot,
    outcome: mode === 'check' ? 'needs-drain' : 'queued',
    message: mode === 'check' ? 'One worker is still active.' : 'Switch queued after current work.'
  }));
  const mounted = await mountChat({}, [], {
    getInstanceProfiles: () => ok(snapshot),
    switchInstanceProfile: switchProfile,
    onInstanceProfilesChanged: (listener: (next: any) => void) => { changed = listener; return () => undefined; }
  });
  const w = mounted.window;
  const switchDialog = mockDialog(w, 'instanceSwitchDialog');
  const manager = mockDialog(w, 'instanceProfilesDialog');
  await vi.waitFor(() => expect(w.document.getElementById('instanceSwitcherName')!.textContent).toBe('Personal'));
  expect(w.document.getElementById('instanceSwitcherMeta')!.textContent).toContain('Windows · Connected');
  expect(w.document.getElementById('instanceSwitcherHealth')!.classList.contains('is-live')).toBe(true);

  const switcher = w.document.getElementById('instanceSwitcher') as HTMLButtonElement;
  switcher.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
  const menu = w.document.getElementById('instanceSwitcherMenu')!;
  expect(menu.hidden).toBe(false);
  expect(switcher.getAttribute('aria-expanded')).toBe('true');
  expect(w.document.activeElement?.getAttribute('role')).toBe('menuitem');
  (w.document.activeElement as HTMLElement).dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(menu.hidden).toBe(true);
  expect(w.document.activeElement).toBe(switcher);

  switcher.click();
  const workRow = w.document.querySelector<HTMLButtonElement>('[data-instance-id="work"].instance-switcher-option')!;
  expect(workRow.textContent).toContain('Mac');
  expect(workRow.textContent).toContain('0 active · 3 queued');
  (w.document.getElementById('instanceManageProfiles') as HTMLButtonElement).click();
  expect(manager.open).toBe(true);
  (w.document.querySelector<HTMLButtonElement>('#instanceProfilesList [data-instance-id="work"]')!).click();
  (w.document.getElementById('instanceProfileSwitch') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(switchProfile).toHaveBeenCalledWith('work', 'check'));
  await vi.waitFor(() => expect(switchDialog.open).toBe(true));
  expect(w.document.getElementById('instanceSwitchMessage')!.textContent).toContain('One worker is still active.');
  (w.document.getElementById('instanceSwitchAfterWork') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(switchProfile).toHaveBeenCalledWith('work', 'after-work'));
  await vi.waitFor(() => expect(switchDialog.open).toBe(false));

  const pushed = { ...snapshot, profiles: [{ ...personal, activeWorkers: 1 }, work] };
  changed(pushed);
  expect(w.document.querySelector('[data-instance-id="personal"].instance-switcher-option')?.textContent).toContain('1 active');
});

it('opens an account chat window from the top-left picker without opening settings or replacing the active account', async () => {
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const snapshot = { activeProfileId: 'personal', profiles: [instanceProfileFixture('personal'), instanceProfileFixture('work')], drain: null };
  const launch = vi.fn(async (_id: string) => ok(snapshot));
  const switchProfile = vi.fn();
  const mounted = await mountChat({}, [], {
    getInstanceProfiles: () => ok(snapshot),
    launchInstanceRuntime: launch,
    switchInstanceProfile: switchProfile
  });
  const w = mounted.window;
  const manager = mockDialog(w, 'instanceProfilesDialog');
  await vi.waitFor(() => expect(w.document.getElementById('instanceSwitcherName')!.textContent).toBe('Personal'));
  (w.document.getElementById('instanceSwitcher') as HTMLButtonElement).click();
  (w.document.querySelector<HTMLButtonElement>('[data-instance-id="work"].instance-switcher-option')!).click();
  await vi.waitFor(() => expect(launch).toHaveBeenCalledWith('work'));
  expect(manager.open).toBe(false);
  expect(w.document.getElementById('instanceSwitcherMenu')!.hidden).toBe(true);
  expect(w.document.getElementById('instanceSwitcherName')!.textContent).toBe('Personal');
  expect(switchProfile).not.toHaveBeenCalled();
});

it('labels a running secondary account as needing browser pairing until its own bridge is paired', async () => {
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const personal = instanceProfileFixture('personal');
  const work = instanceProfileFixture('work', { runtimeRunning: true, browserPaired: false });
  const snapshot = { activeProfileId: 'personal', profiles: [personal, work], drain: null };
  let changed: (next: any) => void = () => undefined;
  const mounted = await mountChat({}, [], {
    getInstanceProfiles: () => ok(snapshot),
    onInstanceProfilesChanged: (listener: (next: any) => void) => { changed = listener; return () => undefined; }
  });
  const w = mounted.window;
  await vi.waitFor(() => expect(w.document.getElementById('instanceSwitcherName')!.textContent).toBe('Personal'));
  (w.document.getElementById('instanceSwitcher') as HTMLButtonElement).click();
  const row = () => w.document.querySelector<HTMLElement>('[data-instance-id="work"].instance-switcher-option')!;
  expect(row().textContent).toContain('Running · pair browser');
  expect(row().querySelector('.instance-health-dot')?.classList.contains('is-bad')).toBe(true);

  changed({ ...snapshot, profiles: [personal, { ...work, browserPaired: true }] });
  expect(row().textContent).toContain('Running in another window');
  expect(row().textContent).not.toContain('pair browser');
});

it('shows one account-scoped sign-in notice and opens only that profile without dropping queued state', async () => {
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const personal = instanceProfileFixture('personal', { browserAuth: 'signed-out' });
  const work = instanceProfileFixture('work');
  const snapshot = { activeProfileId: 'personal', profiles: [personal, work], drain: null };
  let changed: (next: any) => void = () => undefined;
  const openBrowser = vi.fn(async () => ok(true));
  const mounted = await mountChat({}, [], {
    getInstanceProfiles: () => ok(snapshot),
    openInstanceProfileBrowser: openBrowser,
    onInstanceProfilesChanged: (listener: (next: any) => void) => { changed = listener; return () => undefined; }
  });
  const w = mounted.window;
  await vi.waitFor(() => expect(w.document.getElementById('instanceSwitcherMeta')!.textContent).toContain('Sign in to Personal'));
  const notice = w.document.getElementById('instanceSignInNotice')!;
  expect(notice.hidden).toBe(false);
  expect(notice.textContent).toContain('Queued browser work is preserved');
  const button = w.document.getElementById('instanceSignInNoticeButton') as HTMLButtonElement;
  expect(button.textContent).toBe('Sign in to Personal');
  button.click();
  await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledExactlyOnceWith('personal'));

  changed({ ...snapshot, profiles: [{ ...personal, browserAuth: 'signed-in' }, work] });
  expect(w.document.getElementById('instanceSignInNotice')!.hidden).toBe(true);
  expect(w.document.getElementById('instanceSwitcherMeta')!.textContent).not.toContain('Sign in');
});

it('shows the same Chrome tab badge legend described by the browser projection', async () => {
  const mounted = await mountChat();
  const legend = mounted.window.document.getElementById('chromeTabStatusLegend')!;
  expect(legend.getAttribute('aria-label')).toBe('Chrome tab badge legend');
  expect([...legend.querySelectorAll('[data-status]')].map(node => [node.getAttribute('data-status'), node.textContent])).toEqual([
    ['goal', 'GGoal'],
    ['loop', 'LLoop'],
    ['worker', 'WWorker'],
    ['one-off', '1One-off'],
    ['attention', '!Attention']
  ]);
});

it('manages account profiles and exposes exact connector setup without touching the old setup-profile control', async () => {
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  let snapshot: any = { activeProfileId: 'personal', profiles: [instanceProfileFixture('personal'), instanceProfileFixture('work')], drain: null };
  const rename = vi.fn(async (id: string, nickname: string) => {
    snapshot = { ...snapshot, profiles: snapshot.profiles.map((profile: any) => profile.id === id ? { ...profile, nickname } : profile) };
    return ok(snapshot);
  });
  const enabled = vi.fn(async (id: string, value: boolean) => {
    snapshot = { ...snapshot, profiles: snapshot.profiles.map((profile: any) => profile.id === id ? { ...profile, enabled: value } : profile) };
    return ok(snapshot);
  });
  const create = vi.fn(async (nickname: string, browserProfileDirectory: string) => {
    snapshot = { ...snapshot, profiles: [...snapshot.profiles, instanceProfileFixture('studio', { nickname, browserProfileDirectory, platform: 'win32', active: false })] };
    return ok(snapshot);
  });
  const remove = vi.fn(async (id: string) => {
    snapshot = { ...snapshot, profiles: snapshot.profiles.filter((profile: any) => profile.id !== id) };
    return ok(snapshot);
  });
  const openBrowser = vi.fn(async () => ok(true));
  const copySetup = vi.fn(async () => ok(true));
  const refreshConnector = vi.fn(async () => ok(snapshot));
  const selectOldSetup = vi.fn();
  const mounted = await mountChat({}, [], {
    getInstanceProfiles: () => ok(snapshot),
    listInstanceBrowserProfiles: () => ok(['Profile 4', 'Profile 7']),
    renameInstanceProfile: rename,
    setInstanceProfileEnabled: enabled,
    createInstanceProfile: create,
    removeInstanceProfile: remove,
    openInstanceProfileBrowser: openBrowser,
    copyInstanceConnectorSetup: copySetup,
    refreshInstanceConnector: refreshConnector,
    selectSetupProfile: selectOldSetup,
    onInstanceProfilesChanged: () => () => undefined
  });
  const w = mounted.window;
  const manager = mockDialog(w, 'instanceProfilesDialog');
  const createDialog = mockDialog(w, 'instanceCreateDialog');
  const removeDialog = mockDialog(w, 'instanceRemoveDialog');
  mockDialog(w, 'instanceSwitchDialog');
  await vi.waitFor(() => expect(w.document.getElementById('instanceSwitcherName')!.textContent).toBe('Personal'));

  (w.document.getElementById('instanceSwitcher') as HTMLButtonElement).click();
  (w.document.getElementById('instanceManageProfiles') as HTMLButtonElement).click();
  expect(manager.open).toBe(true);
  expect(w.document.getElementById('instanceConnectorName')!.textContent).toBe('Luna Forge X7 Personal Core');
  expect(w.document.getElementById('instanceConnectorDescription')!.textContent).toBe('Exact Personal Core description.');
  expect(w.document.getElementById('instanceConnectorUrl')!.textContent).toBe('https://personal.example/mcp');
  expect(w.document.getElementById('instanceConnectorStatus')!.textContent).toBe('Connected');
  expect(w.document.getElementById('instanceConnectorLastRequest')!.textContent).not.toBe('never');
  expect(w.document.getElementById('instanceActiveWorkers')!.textContent).toBe('2');
  expect(w.document.getElementById('instanceQueuedWorkers')!.textContent).toBe('1');
  expect((w.document.getElementById('instanceProfileBrowser') as HTMLInputElement).value).toBe('Default');

  (w.document.querySelector('[data-instance-id="work"].instance-profile-row') as HTMLButtonElement).click();
  expect(w.document.getElementById('instanceConnectorDescription')!.textContent).toBe('Exact Work Core description.');
  expect(w.document.getElementById('instancePendingOperations')!.textContent).toContain('Worker handoff');
  expect(w.document.getElementById('instanceProfileConnection')!.textContent).toBe('Waiting for Core');
  expect(w.document.getElementById('instanceConnectorStatus')!.textContent).toBe('Waiting for Core');
  expect(w.document.getElementById('instanceConnectorError')!.hidden).toBe(true);
  const nickname = w.document.getElementById('instanceProfileNickname') as HTMLInputElement;
  nickname.value = 'Client work'; nickname.dispatchEvent(new w.Event('input', { bubbles: true }));
  (w.document.getElementById('instanceProfileRename') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(rename).toHaveBeenCalledWith('work', 'Client work'));
  await vi.waitFor(() => expect(w.document.getElementById('instanceProfileDetailTitle')!.textContent).toBe('Client work'));

  (w.document.getElementById('instanceProfileEnabled') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(enabled).toHaveBeenCalledWith('work', false));
  await vi.waitFor(() => expect(w.document.getElementById('instanceProfileEnabled')!.textContent).toBe('Enable profile'));

  // Opening and setup copy are main-owned actions; the renderer sends only the stable profile id.
  (w.document.getElementById('instanceProfileOpenBrowser') as HTMLButtonElement).disabled = false;
  (w.document.getElementById('instanceProfileOpenBrowser') as HTMLButtonElement).click();
  (w.document.getElementById('instanceCopyConnectorSetup') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledWith('work'));
  expect(copySetup).toHaveBeenCalledWith('work');

  // Reconnect applies only to the active profile and uses its dedicated connector action.
  (w.document.querySelector('[data-instance-id="personal"].instance-profile-row') as HTMLButtonElement).click();
  (w.document.getElementById('instanceReconnectConnector') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(refreshConnector).toHaveBeenCalledOnce());

  const managerAdd = w.document.getElementById('instanceManagerAdd') as HTMLButtonElement;
  await vi.waitFor(() => expect(managerAdd.disabled).toBe(false));
  managerAdd.click();
  expect(createDialog.open).toBe(true);
  await vi.waitFor(() => expect([...w.document.querySelectorAll<HTMLOptionElement>('#instanceCreateBrowserProfiles option')].map(option => option.value)).toEqual(['Profile 4', 'Profile 7']));
  (w.document.getElementById('instanceCreateNickname') as HTMLInputElement).value = 'Studio';
  (w.document.getElementById('instanceCreateBrowser') as HTMLInputElement).value = 'Profile 4';
  w.document.getElementById('instanceCreateForm')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledWith('Studio', 'Profile 4'));
  await vi.waitFor(() => expect(createDialog.open).toBe(false));
  await vi.waitFor(() => expect(w.document.getElementById('instanceProfilesList')!.textContent).toContain('Studio'));

  (w.document.querySelector('[data-instance-id="work"].instance-profile-row') as HTMLButtonElement).click();
  (w.document.getElementById('instanceProfileRemove') as HTMLButtonElement).click();
  expect(removeDialog.open).toBe(true);
  (w.document.getElementById('instanceRemoveConfirmation') as HTMLInputElement).value = 'Client work';
  w.document.getElementById('instanceRemoveForm')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('work', 'Client work'));
  await vi.waitFor(() => expect(removeDialog.open).toBe(false));
  await vi.waitFor(() => expect(w.document.querySelector('[data-instance-id="work"].instance-profile-row')).toBeNull());
  expect(selectOldSetup).not.toHaveBeenCalled();
  expect(w.document.getElementById('setupProfile')).not.toBeNull();
});

it('enables saving an unbound legacy Chrome profile as soon as its directory is typed', async () => {
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  let snapshot: any = {
    activeProfileId: 'personal',
    profiles: [instanceProfileFixture('personal', {
      browserProfileDirectory: 'Current Chrome profile (legacy)'
    })],
    drain: null
  };
  const save = vi.fn(async (_id: string, directory: string) => {
    snapshot = { ...snapshot, profiles: snapshot.profiles.map((profile: any) => ({
      ...profile, browserProfileDirectory: directory
    })) };
    return ok(snapshot);
  });
  const mounted = await mountChat({}, [], {
    getInstanceProfiles: () => ok(snapshot),
    listInstanceBrowserProfiles: () => ok(['Profile 3']),
    setInstanceBrowserProfile: save,
    onInstanceProfilesChanged: () => () => undefined
  });
  const w = mounted.window;
  mockDialog(w, 'instanceProfilesDialog');
  await vi.waitFor(() => expect(w.document.getElementById('instanceSwitcherName')!.textContent).toBe('Personal'));
  (w.document.getElementById('instanceSwitcher') as HTMLButtonElement).click();
  (w.document.getElementById('instanceManageProfiles') as HTMLButtonElement).click();

  const input = w.document.getElementById('instanceProfileBrowser') as HTMLInputElement;
  const button = w.document.getElementById('instanceProfileBrowserSave') as HTMLButtonElement;
  expect(input.disabled).toBe(false);
  expect(button.disabled).toBe(true);
  input.value = 'Profile 3';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect(button.disabled).toBe(false);
  button.click();
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith('personal', 'Profile 3'));
  await vi.waitFor(() => expect(snapshot.profiles[0].browserProfileDirectory).toBe('Profile 3'));
});

it('labels a prepared sibling tunnel as private instead of displaying an empty bootstrap value as current', async () => {
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const snapshot = {
    activeProfileId: 'personal',
    profiles: [
      instanceProfileFixture('personal'),
      instanceProfileFixture('work', {
        active: false,
        runtimeMode: 'isolated',
        runtimePrepared: true,
        runtimeRunning: false,
        coreTunnelId: null,
        hasRuntimeApiKey: null
      })
    ],
    drain: null
  };
  const mounted = await mountChat({}, [], {
    getInstanceProfiles: () => ok(snapshot),
    onInstanceProfilesChanged: () => () => undefined
  });
  const w = mounted.window;
  mockDialog(w, 'instanceProfilesDialog');
  await vi.waitFor(() => expect(w.document.getElementById('instanceSwitcherName')!.textContent).toBe('Personal'));
  (w.document.getElementById('instanceSwitcher') as HTMLButtonElement).click();
  (w.document.getElementById('instanceManageProfiles') as HTMLButtonElement).click();
  (w.document.querySelector('[data-instance-id="work"].instance-profile-row') as HTMLButtonElement).click();

  const tunnel = w.document.getElementById('instanceCoreTunnel') as HTMLInputElement;
  expect(tunnel.disabled).toBe(true);
  expect(tunnel.value).toBe('');
  expect(tunnel.placeholder).toBe('Check this account window');
  expect(tunnel.title).toContain('owns private connector settings');
  expect(w.document.getElementById('instanceCoreApiKeyStatus')!.textContent).toBe('Check this account window');
});

it('attaches pasted screenshot files with previews while preserving ordinary text paste', async () => {
  const dropFiles = vi.fn(async () => ({ ok: true, data: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'screenshot.png', size: 4, mimeType: 'image/png', preview: 'data:image/webp;base64,AAAA' }] }));
  const mounted = await mountChat({}, [], { dropFiles });
  const w = mounted.window, input = w.document.getElementById('chatInput')!;
  const file = new w.File(['image'], 'screenshot.png', { type: 'image/png' });
  const paste = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
  input.dispatchEvent(paste);
  await vi.waitFor(() => expect(dropFiles).toHaveBeenCalledWith([file]));
  expect(paste.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(w.document.querySelector('img[src="data:image/webp;base64,AAAA"]')).not.toBeNull());
  const text = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(text, 'clipboardData', { value: { files: [] } });
  input.dispatchEvent(text);
  expect(text.defaultPrevented).toBe(false);
  const overflow = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(overflow, 'clipboardData', { value: { files: Array(20).fill(file) } });
  input.dispatchEvent(overflow);
  expect(overflow.defaultPrevented).toBe(true);
  expect(dropFiles).toHaveBeenCalledTimes(1);
});

it('preserves the selected OpenRouter model through an unchanged custom-provider round trip', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const original = 'z-ai/glm-5.3-flash';
  mounted.state.config.goal = { ...mounted.state.config.goal, model: original, provider: { kind: 'openrouter', baseUrl: '' } };
  mounted.push(mounted.state);
  const provider = w.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'custom'; provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  // Repainting custom settings must not replace the hidden OpenRouter picker's model.
  mounted.push({ ...mounted.state, hasCustomProviderKey: false });
  provider.value = 'openrouter'; provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].goal).toMatchObject({ provider: { kind: 'openrouter' }, model: original });
  expect(w.document.getElementById('goalModelName')!.textContent).toBe(original);
});

it('uses the OpenRouter default when opened directly on an unrelated custom deployment', async () => {
  const mounted = await mountChat({}, [], {}, { model: 'llama3.1', provider: { kind: 'custom', baseUrl: 'http://localhost:8000/v1' } });
  const provider = mounted.window.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'openrouter';
  provider.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].goal).toMatchObject({ provider: { kind: 'openrouter' }, model: DEFAULT_GOAL_MODEL });
});

it('saves a custom deployment id and returns to the known OpenRouter model', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const provider = w.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'custom';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].goal.provider.kind).toBe('custom');
  expect(w.document.getElementById('goalCustomPanel')?.hidden).toBe(false);
  const model = w.document.getElementById('goalCustomModel') as HTMLInputElement;
  model.value = 'llama3.1';
  model.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].goal.model).toBe('llama3.1');
  provider.value = 'openrouter';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(3));
  expect(mounted.calls[2].goal).toMatchObject({ provider: { kind: 'openrouter' }, model: 'deepseek/deepseek-v4-flash' });
});

it('saves the ChatGPT browser choice from its settings control and restores it on state push', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const browser = w.document.getElementById('chatBrowser') as HTMLSelectElement;
  expect(browser.value).toBe('chrome'); // older config has no field
  browser.value = 'edge';
  browser.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].ui.chatBrowser).toBe('edge');
  expect(browser.value).toBe('edge');
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, chatBrowser: 'chrome' } } });
  expect(browser.value).toBe('chrome');
});

it('shows the current host Desktop tools without rebuilding permission controls on state pushes', async () => {
  const mounted = await mountChat({
    platform: { family: 'windows', name: 'Windows', desktopAutomation: true }
  });
  const doc = mounted.window.document;
  const names = () => Array.from(doc.querySelectorAll('[data-group="desktop"] .tool-names code'), node => node.textContent);
  const control = doc.querySelector<HTMLInputElement>('[data-cap="control"]')!;
  const windowsNames = [...BROWSER_READ_TOOLS, 'list_windows', 'get_window', 'list_apps', 'get_window_state', ...BROWSER_WRITE_TOOLS,
    'launch_app', 'click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag',
    'perform_secondary_action', 'activate_window', 'read_clipboard', 'write_clipboard', 'exec'];
  expect(names()).toEqual(windowsNames);
  mounted.push({ ...mounted.state, platform: { family: 'macos', name: 'macOS', desktopAutomation: true } });
  expect(names()).toEqual([...BROWSER_READ_TOOLS, 'observe', ...BROWSER_WRITE_TOOLS, 'computer', 'exec']);
  expect(doc.querySelector('[data-cap="control"]')).toBe(control);
  mounted.push(mounted.state);
  expect(names()).toEqual(windowsNames);
  expect(mounted.calls).toHaveLength(0);
});

it('preserves native Desktop permissions when saving unrelated settings on Linux', async () => {
  const mounted = await mountChat({
    platform: { family: 'linux', name: 'Linux', desktopAutomation: false }
  });
  const w = mounted.window;

  const desktopGroup = w.document.querySelector<HTMLElement>('[data-group="desktop"]')!;
  expect(desktopGroup.hidden).toBe(false);
  expect(w.document.querySelector<HTMLInputElement>('[data-cap="control"]')!.disabled).toBe(false);
  expect(w.document.querySelector<HTMLInputElement>('[data-cap="clipboardWrite"]')!.disabled).toBe(true);

  const autoConnect = w.document.getElementById('autoConnect') as HTMLInputElement;
  autoConnect.checked = true;
  autoConnect.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();

  expect(mounted.calls).toHaveLength(1);
  expect(mounted.calls[0].ui.autoConnect).toBe(true);
  expect(mounted.calls[0].capabilities).toMatchObject({
    screen: true,
    control: true,
    clipboardRead: true,
    clipboardWrite: true
  });
});

it('uses native menu-bar/Dock wording on macOS instead of Windows tray copy', async () => {
  const mounted = await mountChat({
    platform: { family: 'macos', name: 'macOS', desktopAutomation: true }
  });
  const doc = mounted.window.document;

  expect(doc.getElementById('backgroundRunningCopy')!.textContent).toContain('menu bar and Dock');
  expect(doc.getElementById('backgroundRunningCopy')!.textContent).not.toContain('tray');
  expect(doc.getElementById('minimizeToTrayCopy')!.textContent).toBe('Hide the window to the menu bar when closed');
});

it('surfaces the existing root rename API in the folder row', async () => {
  const renames: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], {
    renameRoot: (name: string, newName: string) => {
      renames.push([name, newName]);
      return Promise.resolve({ ok: false, error: 'test stops before mutation' });
    }
  });
  const doc = mounted.window.document;
  const button = doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]');
  expect(button).not.toBeNull();

  button!.click();
  const input = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  input.value = 'New-Repo';
  input.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();

  expect(renames).toEqual([['repo', 'new-repo']]);
});

it('preserves an in-progress root rename across unrelated state pushes and cancels it if the root disappears', async () => {
  const renames: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], {
    renameRoot: (name: string, newName: string) => {
      renames.push([name, newName]);
      return Promise.resolve({ ok: false, error: 'rename failed for retry test' });
    }
  });
  const doc = mounted.window.document;
  doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]')!.click();

  const original = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  original.value = 'new-name';
  original.setSelectionRange(3, 7);

  const unrelated = structuredClone(mounted.state) as any;
  unrelated.status.detail = 'unrelated live status push';
  mounted.push(unrelated);

  const preserved = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  expect(preserved).not.toBeNull();
  expect(doc.activeElement).toBe(preserved);
  expect(preserved.value).toBe('new-name');
  expect(preserved.selectionStart).toBe(3);
  expect(preserved.selectionEnd).toBe(7);

  preserved.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(renames).toEqual([['repo', 'new-name']]);
  const retry = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  expect(retry.value).toBe('new-name');
  retry.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(renames).toEqual([['repo', 'new-name'], ['repo', 'new-name']]);

  const escape = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  escape.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(doc.querySelector('.root-rename')).toBeNull();

  doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]')!.click();
  expect(doc.querySelector('.root-rename')).not.toBeNull();

  const removed = structuredClone(unrelated) as any;
  removed.config.roots = [];
  mounted.push(removed);
  expect(doc.querySelector('.root-rename')).toBeNull();
  expect(doc.querySelector('.root')).toBeNull();
});

/** Fake OpenRouter catalogue, already in the order the app is expected to keep. */
const catalogue = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `vendor${index}/model-${index}`,
    name: `Model ${index}`,
    created: 1_800_000_000 - index * 86_400,
    contextLength: 128_000
  }));

it('guides rootless setup from the capabilities that actually need a filesystem root', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const mixed = structuredClone(mounted.state) as any;
  mixed.hasApiKey = true;
  mixed.config.roots = [];
  mixed.config.readOnly = false;
  for (const capability of Object.keys(mixed.config.capabilities)) mixed.config.capabilities[capability] = false;
  mixed.config.capabilities.browse = true;
  mixed.config.capabilities.screen = true;
  mixed.status.surfaces = [
    {
      id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
      available: true, localUrl: null, publicUrl: null, tools: ['read'], state: 'off', detail: '',
      lastRequestAt: null, lastToolCallAt: null
    },
    {
      id: 'desktop', connectorName: 'Desktop', description: '', cardSummary: '', optional: true,
      available: true, localUrl: null, publicUrl: null, tools: ['observe'], state: 'off', detail: '',
      lastRequestAt: null, lastToolCallAt: null
    }
  ];

  mounted.push(mixed);
  const connect = mounted.window.document.getElementById('connectBtn') as HTMLButtonElement;
  expect(connect.disabled).toBe(true);
  expect(connect.title).toContain('Choose a folder');
  expect(mounted.window.document.querySelector('[data-step="folder"]')?.classList.contains('is-current')).toBe(true);

  const commandAndDesktop = structuredClone(mixed) as any;
  commandAndDesktop.config.capabilities.browse = false;
  commandAndDesktop.config.capabilities.command = true;
  mounted.push(commandAndDesktop);
  expect(connect.disabled).toBe(true);
  expect(connect.title).toContain('Choose a folder');

  const desktopOnly = structuredClone(mixed) as any;
  desktopOnly.config.capabilities.browse = false;
  mounted.push(desktopOnly);
  expect(connect.disabled).toBe(false);
  expect(connect.title).toBe('');

  const clipboardOnly = structuredClone(desktopOnly) as any;
  clipboardOnly.config.capabilities.screen = false;
  clipboardOnly.config.capabilities.clipboardRead = true;
  clipboardOnly.status.surfaces[1].tools = ['computer'];
  mounted.push(clipboardOnly);
  expect(connect.disabled).toBe(false);
});

it('preserves optional Desktop disclosures and inline screenshots across status pushes', async () => {
  const mounted = await mountChat();
  const state = structuredClone(mounted.state) as any;
  state.status.surfaces = [{
    id: 'desktop', connectorName: 'Desktop', description: 'Desktop control', cardSummary: '', optional: true,
    available: true, localUrl: null, publicUrl: null, tools: ['observe'], state: 'off', detail: '',
    lastRequestAt: null, lastToolCallAt: null
  }];
  mounted.push(state);
  const doc = mounted.window.document;
  const field = doc.getElementById('desktopTunnelField') as HTMLDetailsElement;
  const card = () => doc.querySelector<HTMLDetailsElement>('#connectorCards details')!;
  expect(field.hidden).toBe(false);
  expect(field.open).toBe(false);
  expect(card().open).toBe(false);
  field.querySelector('summary')!.click(); card().querySelector('summary')!.click();
  const guide = doc.querySelector('[data-setup-guide="tunnel"]')!;
  expect(guide.querySelectorAll('img')).toHaveLength(1);
  expect(doc.querySelectorAll('[data-setup-guide="developer"] img')).toHaveLength(1);
  expect(doc.querySelectorAll('[data-setup-guide="plugin"] img')).toHaveLength(2);
  const image = guide.querySelector('img')!;
  mounted.push(structuredClone(state));
  expect(field.open).toBe(true);
  expect(card().open).toBe(true);
  expect(guide.querySelector('img')).toBe(image);
  expect(image.src).toContain('workspace.png');
  expect(mounted.calls).toEqual([]);
  card().querySelector('summary')!.click();
  mounted.push(structuredClone(state));
  expect(card().open).toBe(false);
  expect(field.open).toBe(true);
});

it('shows one Windows Core connector when Desktop capabilities are integrated into Core', async () => {
  const mounted = await mountChat({
    platform: { family: 'windows', name: 'Windows', desktopAutomation: true }
  });
  const state = structuredClone(mounted.state) as any;
  state.config.tunnel.kind = 'openai';
  state.config.tunnel.desktopTunnelId = 'legacy-desktop-id';
  state.status.surfaces = [{
    id: 'core',
    connectorName: 'Chat On Steroids Core',
    description: 'Core plus enabled Windows browser and native desktop tools.',
    cardSummary: 'Files, terminal, browser and Windows desktop tools.',
    optional: false,
    available: true,
    localUrl: 'http://127.0.0.1:45678/mcp/core/token',
    publicUrl: null,
    tools: ['read', 'exec_command', 'browser_tabs', 'list_apps', 'get_window_state', 'read_clipboard'],
    state: 'live',
    detail: 'Connected.',
    lastRequestAt: null,
    lastToolCallAt: null
  }];
  mounted.push(state);

  const doc = mounted.window.document;
  expect((doc.getElementById('desktopTunnelField') as HTMLDetailsElement).hidden).toBe(true);
  const cards = [...doc.querySelectorAll<HTMLElement>('#connectorCards > .connector')];
  expect(cards).toHaveLength(1);
  expect(cards[0]!.textContent).toContain('Chat On Steroids Core');
  expect(cards[0]!.textContent).not.toContain('Chat On Steroids Desktop');
  expect(doc.getElementById('connectorCards')!.textContent).not.toContain('Pick this connector’s own tunnel');
});

it('highlights missing required setup fields while respecting drafts and a stored API key', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const tunnel = doc.getElementById('tunnelId') as HTMLInputElement;
  const key = doc.getElementById('apiKey') as HTMLInputElement;
  expect(tunnel.classList.contains('is-empty')).toBe(false);
  expect(key.classList.contains('is-empty')).toBe(true);
  expect(doc.getElementById('desktopTunnelId')!.classList.contains('setup-required')).toBe(false);

  tunnel.focus();
  tunnel.value = '  ';
  tunnel.dispatchEvent(new mounted.window.Event('input'));
  expect(tunnel.classList.contains('is-empty')).toBe(true);
  mounted.push(structuredClone(mounted.state));
  expect(tunnel.value).toBe('  ');
  expect(tunnel.classList.contains('is-empty')).toBe(true);
  tunnel.value = 'tunnel_draft';
  tunnel.dispatchEvent(new mounted.window.Event('input'));
  expect(tunnel.classList.contains('is-empty')).toBe(false);

  key.value = 'example-draft';
  key.dispatchEvent(new mounted.window.Event('input'));
  expect(key.classList.contains('is-empty')).toBe(false);
  key.value = '';
  key.dispatchEvent(new mounted.window.Event('input'));
  expect(key.classList.contains('is-empty')).toBe(true);
  mounted.push({ ...structuredClone(mounted.state), hasApiKey: true });
  expect(key.classList.contains('is-empty')).toBe(false);
  expect(key.getAttribute('aria-required')).toBe('false');
  mounted.push({ ...structuredClone(mounted.state), hasApiKey: false });
  expect(key.classList.contains('is-empty')).toBe(true);
  expect(mounted.keys).toEqual([]);
  expect(mounted.calls).toEqual([]);
});

it('keeps folder access discoverable after setup and navigates without granting access', async () => {
  const addRoot = vi.fn();
  const mounted = await mountChat({ hasApiKey: true }, [], { addRoot });
  const connected = structuredClone(mounted.state);
  connected.status.state = 'connected';
  connected.status.lastRequestAt = Date.now();
  connected.bridge.present = true;
  mounted.push(connected);
  const doc = mounted.window.document;
  const styles = doc.createElement('style');
  styles.textContent = await fs.readFile(path.join(process.cwd(), 'src/renderer/styles.css'), 'utf8');
  doc.head.append(styles);
  doc.querySelector<HTMLButtonElement>('[data-tab="setup"]')!.click();

  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(true);
  const manage = doc.getElementById('wizManageFolders')!;
  expect(mounted.window.getComputedStyle(manage.parentElement!).display).not.toBe('none');
  expect(doc.getElementById('wizFolders')!.textContent).toBe('/repo');
  manage.click();

  expect(doc.querySelector('.panel.is-active')?.getAttribute('data-panel')).toBe('home');
  expect(doc.activeElement).toBe(doc.getElementById('addFolder'));
  expect(doc.getElementById('rootList')!.textContent).toContain('/repo');
  expect(addRoot).not.toHaveBeenCalled();
  expect(mounted.calls).toEqual([]);
});

it('offers one explicit main-owned action for a confirmed multi-folder workspace plan', async () => {
  let returnedState: any;
  const addWorkspaceFolders = vi.fn(async () => ({ ok: true as const, data: returnedState }));
  const mounted = await mountChat({}, [], { addWorkspaceFolders });
  returnedState = mounted.state;
  const doc = mounted.window.document;
  const button = doc.getElementById('addWorkspaceFolders') as HTMLButtonElement;

  expect(button.textContent).toContain('Add several');
  const hint = doc.getElementById('workspaceFoldersHint')!;
  expect(hint.classList.contains('empty')).toBe(false);
  expect(hint.textContent).toMatch(/creative subfolders.*D:\/Projects.*H:\/ScenePacks.*whole drive.*operating-system.*terminal commands/s);
  button.click();
  await settle();

  expect(addWorkspaceFolders).toHaveBeenCalledTimes(1);
  expect(addWorkspaceFolders).toHaveBeenCalledWith();
});

it('refreshes the canonical account menu on open and ignores an older reply after a current push', async () => {
  const personal = instanceProfileFixture('personal');
  const work = instanceProfileFixture('work');
  const gary = { ...work, id: 'gary', nickname: 'Gary' };
  const original = { activeProfileId: 'personal', profiles: [personal, work], drain: null };
  const updated = { ...original, profiles: [personal, work, gary] };
  let pushed: (snapshot: any) => void = () => undefined;
  let resolveRefresh: (value: any) => void = () => undefined;
  const getInstanceProfiles = vi.fn()
    .mockResolvedValueOnce({ ok: true, data: original })
    .mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
  const mounted = await mountChat({}, [], {
    getInstanceProfiles,
    onInstanceProfilesChanged: (listener: (next: any) => void) => { pushed = listener; return () => undefined; }
  });
  await vi.waitFor(() => expect(mounted.window.document.getElementById('instanceSwitcherName')!.textContent).toBe('Personal'));
  mounted.window.document.getElementById('instanceSwitcher')!.click();
  expect(getInstanceProfiles).toHaveBeenCalledTimes(2);
  pushed(updated);
  resolveRefresh({ ok: true, data: original });
  await settle();
  expect(mounted.window.document.getElementById('instanceSwitcherProfiles')!.textContent).toContain('Gary');
  expect(mounted.window.document.getElementById('instanceSwitcherName')!.textContent).toBe('Personal');
});

it('does not opt into shared folders until the user presses its main-owned approval control', async () => {
  const setSharedFolderAccess = vi.fn(async () => ({ ok: false as const, error: 'Approval cancelled' }));
  const mounted = await mountChat({}, [], { setSharedFolderAccess });
  expect(setSharedFolderAccess).not.toHaveBeenCalled();
  const button = mounted.window.document.getElementById('shareAccountFolders')!;
  expect(button.textContent).toContain('Share folders across accounts');
  button.click();
  await settle();
  expect(setSharedFolderAccess).toHaveBeenCalledOnce();
  expect(setSharedFolderAccess).toHaveBeenCalledWith(true);
  expect(button.getAttribute('aria-pressed')).toBe('false');
});

it('requires a live browser only when a browser-backed feature is actually enabled', async () => {
  const mounted = await mountChat({
    hasApiKey: true,
    status: {
      state: 'connected',
      detail: 'Connected.',
      publicUrl: null,
      localUrl: 'http://127.0.0.1:1234',
      handshakeAt: Date.now(),
      lastRequestAt: Date.now(),
      lastToolCallAt: Date.now(),
      health: null,
      surfaces: [
        {
          id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
          available: true, localUrl: 'http://127.0.0.1:1234', publicUrl: null, tools: ['read', 'session'],
          state: 'live', detail: '', lastRequestAt: Date.now(), lastToolCallAt: Date.now()
        }
      ]
    },
    // The token survived, but this process has not heard from the extension. This is the
    // disabled/uninstalled-extension-after-app-restart repro.
    bridge: { running: true, port: 8765, paired: true, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  });
  const doc = mounted.window.document;
  const browserStep = doc.querySelector<HTMLElement>('[data-step="browser"]')!;

  expect(browserStep.classList.contains('is-done')).toBe(false);
  expect(browserStep.classList.contains('is-current')).toBe(true);
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(false);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('Authorized');
  expect(doc.getElementById('bridgeState')!.textContent).not.toContain('Connected.');

  const live = structuredClone(mounted.state) as any;
  live.hasApiKey = true;
  live.status = (mounted.state as any).status;
  live.bridge = { running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now() };
  mounted.push(live);
  expect(browserStep.classList.contains('is-done')).toBe(true);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('Connected.');

  // Recording and multi-agent are the two independently viable bridge features. Goal is
  // browser-driven too, but it requires a recorded session and cannot run by itself when
  // recording is off, so goal.enabled alone must not keep setup blocked on an inert bridge.
  const browserFree = structuredClone(live) as any;
  browserFree.config.sessions.record = false;
  browserFree.config.multiAgent.enabled = false;
  browserFree.config.goal.enabled = true;
  browserFree.bridge = { running: false, port: null, paired: true, present: false, lastSeenAt: Date.now() };
  mounted.push(browserFree);
  expect(browserStep.hidden).toBe(true);
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(true);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('not needed');
  expect((doc.getElementById('chatAutomation') as HTMLSelectElement).disabled).toBe(true);
  expect(doc.getElementById('chatAutomation')!.title).toMatch(/recording/i);
});

it('projects running commit, tree and dirty state in the existing Activity footer only', async () => {
  const mounted = await mountChat({
    runtimeSource: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false },
    bundledTunnelVersion: '2026.10.7'
  });
  const doc = mounted.window.document;
  const versionLine = doc.getElementById('versionLine')!;
  const updateLine = doc.getElementById('updateLine')!;

  expect(versionLine.textContent).toContain('Running source · commit aaaaaaaaaaaa · tree bbbbbbbbbbbb · clean');
  expect(versionLine.textContent).toContain('Bundled tunnel-client 2026.10.7.');
  expect(versionLine.textContent).not.toContain('C:\\');
  expect(updateLine.hidden).toBe(true);

  const dirty = structuredClone(mounted.state) as any;
  dirty.runtimeSource = { commit: 'c'.repeat(40), tree: 'd'.repeat(40), dirty: true };
  mounted.push(dirty);
  expect(versionLine.textContent).toContain('commit cccccccccccc · tree dddddddddddd · dirty');
  expect(updateLine.hidden).toBe(true);

  const unavailable = structuredClone(dirty) as any;
  unavailable.runtimeSource = null;
  mounted.push(unavailable);
  expect(versionLine.textContent).toContain('Running source · unavailable');
  expect(versionLine.textContent).not.toContain('cccccccccccc');
});

/**
 * "Up to date" is a claim, and a claim needs somebody to have checked.
 *
 * Before GitHub answers, `{latest: null, stage: 'idle'}` means only that nothing has been
 * established - the same record a check that never ran would leave - so the Activity line stays
 * empty and no notification is shown. The timestamp is what turns that silence into an answer.
 */
it('says nothing about being current until the check has actually answered', async () => {
  const mounted = await mountChat({
    bridge: { running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.2' }
  });
  const doc = mounted.window.document;
  const line = doc.getElementById('updateLine')!;
  expect(line.hidden).toBe(true);
  expect(doc.querySelector('.toast')).toBeNull();

  const checked = structuredClone(mounted.state) as any;
  checked.update.checkedAt = Date.now();
  mounted.push(checked);

  // Green, both versions, and the same sentence as the one notification this window shows.
  expect(line.hidden).toBe(false);
  expect(line.className).toBe('upline is-ok');
  expect(line.textContent).toBe('Up to date! Chat On Steroids 2.0.2 · extension 2.0.2');
  expect(doc.querySelector('.toast')!.textContent).toBe(line.textContent);
  // Nothing to act on, so the header bar stays out of the way.
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);

  // The news is told once. A later push of the same fact repaints the line and nothing else.
  doc.querySelector('.toast')!.remove();
  mounted.push(structuredClone(checked) as any);
  expect(doc.querySelector('.toast')).toBeNull();
  expect(line.textContent).toBe('Up to date! Chat On Steroids 2.0.2 · extension 2.0.2');
});

/**
 * A staged update is not "up to date", and it is not a failure either.
 */
it('reports a staged update in the Activity line and the header bar', async () => {
  const mounted = await mountChat();
  const staged = structuredClone(mounted.state) as any;
  staged.update = { current: '2.0.2', latest: '2.0.3', stage: 'ready', error: null, checkedAt: Date.now() };
  mounted.push(staged);

  const doc = mounted.window.document;
  const line = doc.getElementById('updateLine')!;
  expect(line.className).toBe('upline');
  expect(line.textContent).toContain('2.0.3 is downloaded and ready');
  expect(doc.getElementById('updateNotice')!.hidden).toBe(false);
  // There is nothing to fetch by hand once it is on disk.
  expect((doc.getElementById('updateGet') as HTMLButtonElement).hidden).toBe(true);
  // ...and this is the one state in which there is something to install. Both buttons show,
  // because a tray app closed to the tray may not see the header for days.
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(false);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(false);

  const checking = structuredClone(staged) as any;
  checking.update.stage = 'checking';
  mounted.push(checking);
  expect(line.textContent).toContain('Checking for the latest update');
  expect(line.textContent).not.toContain('by hand');
  expect((doc.getElementById('updateGet') as HTMLButtonElement).hidden).toBe(true);
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(true);
  // Still downloading is not yet installable: there is no verified file to hand over.
  const downloading = structuredClone(staged) as any;
  downloading.update = { ...downloading.update, stage: 'downloading' };
  mounted.push(downloading);
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(true);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(true);

  const broken = structuredClone(staged) as any;
  broken.update = { current: '2.0.2', latest: null, stage: 'failed', error: 'latest answered 503', checkedAt: null };
  mounted.push(broken);
  expect(line.className).toBe('upline is-bad');
  expect(line.textContent).toContain('503');
  // A check that could not reach GitHub is a diagnostic, not something the user can act on.
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(true);
});

it('shows queued-update drain progress globally and lets the user cancel before finalization', async () => {
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const personal = instanceProfileFixture('personal');
  const idle = {
    activeProfileId: 'personal',
    profiles: [personal],
    drain: { kind: 'none', phase: 'idle', state: 'idle', detail: null, pendingOperations: 0 }
  };
  const draining = {
    ...idle,
    drain: {
      kind: 'update', phase: 'draining-update', state: 'draining',
      detail: '2 active turns · 1 active worker', pendingOperations: 3
    }
  };
  const install = vi.fn(async () => ok(draining));
  const cancel = vi.fn(async (action: string) => {
    expect(action).toBe('cancel');
    return ok(idle);
  });
  const mounted = await mountChat({}, [], {
    getInstanceProfiles: () => ok(idle),
    installUpdate: install,
    drainInstanceProfile: cancel
  });
  const staged = structuredClone(mounted.state) as any;
  staged.update = { current: '2.0.2', latest: '2.0.3', stage: 'ready', error: null, checkedAt: Date.now() };
  mounted.push(staged);

  const doc = mounted.window.document;
  (doc.getElementById('updateInstall') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(doc.getElementById('updateQueueNotice')!.hidden).toBe(false));
  expect(doc.getElementById('updateQueueTitle')!.textContent).toContain('finishing current work');
  expect(doc.getElementById('updateQueueDetail')!.textContent).toContain('2 active turns');
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).disabled).toBe(true);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).disabled).toBe(true);
  expect(doc.querySelector('#installUpdate svg')).not.toBeNull();

  (doc.getElementById('updateQueueCancel') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('cancel'));
  await vi.waitFor(() => expect(doc.getElementById('updateQueueNotice')!.hidden).toBe(true));
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).disabled).toBe(false);
});

/**
 * The version difference has a direction, and only one of them is the user's to act on.
 *
 * An extension newer than the app is the ordinary state while an app update is downloading, and
 * the bundled folder is then the older copy: "load the extension folder again" would talk that
 * user into downgrading a working extension. The app-update line already owns being behind.
 */
it('asks for an extension reload only when the extension is older than this app', async () => {
  const mounted = await mountChat({
    bridge: {
      running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.1'
    }
  });
  const doc = mounted.window.document;
  const notice = doc.getElementById('updateNotice')!;
  expect(notice.hidden).toBe(false);
  expect(doc.getElementById('updateText')!.textContent).toContain('2.0.1');
  const action = doc.getElementById('updateExtension') as HTMLButtonElement;
  expect(action.hidden).toBe(false);
  action.click();
  expect(doc.querySelector('[data-panel="setup"]')!.classList.contains('is-active')).toBe(true);
  const rejected = structuredClone(mounted.state) as any;
  rejected.bridge.present = false;
  mounted.push(rejected);
  expect(notice.hidden, 'an old companion rejected by the protocol gate still needs an update').toBe(false);

  const ahead = structuredClone(mounted.state) as any;
  ahead.bridge.extensionVersion = '2.0.3';
  mounted.push(ahead);
  expect(notice.hidden, 'a newer extension is not a downgrade prompt').toBe(true);
  expect(action.hidden).toBe(true);
});

it('shows a missing-extension reminder while connected and clears it after the companion reports in', async () => {
  const mounted = await mountChat();
  const connected = structuredClone(mounted.state) as any;
  connected.status.state = 'connected'; connected.bridge.running = true; connected.bridge.present = false;
  mounted.push(connected);
  const doc = mounted.window.document;
  expect(doc.getElementById('updateText')!.textContent).toContain('Browser extension not connected');
  expect(doc.getElementById('updateExtension')!.hidden).toBe(false);
  connected.bridge.present = true; connected.bridge.extensionVersion = connected.update.current;
  mounted.push(connected);
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);
});

it('keeps plugin connection controls out of general Setup and preserves its tunnel during unrelated saves', async () => {
  const mounted = await mountChat(); const doc = mounted.window.document;
  const next = structuredClone(mounted.state); next.config.tunnel.pluginsTunnelId = 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  mounted.push(next);
  expect(doc.querySelector('[data-panel="setup"] #pluginsTunnelId')).toBeNull();
  const input = doc.getElementById('tunnelId') as HTMLInputElement;
  input.value = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  input.dispatchEvent(new mounted.window.Event('change')); await settle();
  expect(mounted.calls.at(-1).tunnel.pluginsTunnelId).toBe(next.config.tunnel.pluginsTunnelId);
  expect(doc.querySelector('[data-panel="setup"] [data-link="https://chatgpt.com/plugins"]')).not.toBeNull();
});

/**
 * The exact sentence, because it is the same sentence the composer's settings sheet shows
 * and the two are meant to be recognisably one message rather than two paraphrases.
 */
it('reports stored API credentials without exposing app-wide Goal switches', async () => {
  const mounted = await mountChat();
  expect(mounted.window.document.getElementById('goalEnabled')).toBeNull();
  expect((mounted.window.document.getElementById('goalKeyRemove') as HTMLButtonElement).disabled).toBe(true);

  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();
  expect(mounted.window.document.getElementById('goalKeyState')!.textContent).toContain('A key is stored');
  expect((mounted.window.document.getElementById('goalKeyRemove') as HTMLButtonElement).disabled).toBe(false);
});

/**
 * The key goes to the one channel that encrypts it and never to the settings file. This is
 * the whole reason the goal request is made by the app and not by the extension, so it is
 * worth an assertion rather than a comment.
 */
it('sends the key to the secret store and never into the settings patch', async () => {
  const mounted = await mountChat();
  const field = mounted.window.document.getElementById('goalKey') as HTMLInputElement;
  field.value = 'sk-or-v1-not-a-real-key';
  field.dispatchEvent(new mounted.window.Event('blur'));
  await settle();

  expect(mounted.keys).toEqual([{ method: 'setGoalKey', value: 'sk-or-v1-not-a-real-key' }]);
  // Cleared from the input as well: a stored key has no reason to stay on screen.
  expect(field.value).toBe('');
  expect(JSON.stringify(mounted.calls)).not.toContain('sk-or-v1');
});

it('keeps secret-key input on secure-storage failure', async () => {
  const failed = await mountChat({}, [], {
    setGoalKey: () => Promise.resolve({ ok: false, error: 'safeStorage unavailable' }),
    setApiKey: () => Promise.resolve({ ok: false, error: 'safeStorage unavailable' })
  });
  const goalFailed = failed.window.document.getElementById('goalKey') as HTMLInputElement;
  goalFailed.value = 'sk-or-v1-retry-me';
  goalFailed.dispatchEvent(new failed.window.Event('blur'));
  const apiFailed = failed.window.document.getElementById('apiKey') as HTMLInputElement;
  apiFailed.value = 'sk-retry-me';
  apiFailed.dispatchEvent(new failed.window.Event('blur'));
  await settle();
  expect(goalFailed.value).toBe('sk-or-v1-retry-me');
  expect(apiFailed.value).toBe('sk-retry-me');
});

it('never lets an older secret save erase a newer value typed while IPC is in flight', async () => {
  let releaseGoal!: (value: any) => void;
  let releaseApi!: (value: any) => void;
  const deferred = await mountChat({}, [], {
    setGoalKey: () => new Promise((resolve) => (releaseGoal = resolve)),
    setApiKey: () => new Promise((resolve) => (releaseApi = resolve))
  });
  const goal = deferred.window.document.getElementById('goalKey') as HTMLInputElement;
  goal.value = 'sk-or-v1-old';
  goal.dispatchEvent(new deferred.window.Event('blur'));
  goal.value = 'sk-or-v1-new';
  const api = deferred.window.document.getElementById('apiKey') as HTMLInputElement;
  api.value = 'sk-old';
  api.dispatchEvent(new deferred.window.Event('blur'));
  api.value = 'sk-new';

  releaseGoal({ ok: true, data: { ...deferred.state, hasGoalKey: true } });
  releaseApi({ ok: true, data: { ...deferred.state, hasApiKey: true } });
  await settle();
  await settle();
  expect(goal.value).toBe('sk-or-v1-new');
  expect(api.value).toBe('sk-new');
});

it('does not turn whitespace in the OpenRouter key field into a remove-key request', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const field = mounted.window.document.getElementById('goalKey') as HTMLInputElement;
  field.value = '   ';
  field.dispatchEvent(new mounted.window.Event('blur'));
  await settle();
  expect(mounted.keys).toEqual([]);
  expect(field.value).toBe('   ');
});

it('opens, saves and restores the editable goal prompt', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const doc = mounted.window.document;
  const panel = doc.getElementById('goalPromptPanel')!;
  const edit = doc.getElementById('goalPromptEdit') as HTMLButtonElement;
  const prompt = doc.getElementById('goalPrompt') as HTMLTextAreaElement;

  expect(panel.hidden).toBe(true);
  edit.click();
  expect(panel.hidden).toBe(false);
  expect(prompt.value).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);

  prompt.value = 'custom gate: continue only explicit missing work. otherwise NO_REPLY.';
  prompt.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.goal.prompt).toBe(prompt.value);

  (doc.getElementById('goalPromptReset') as HTMLButtonElement).click();
  await settle();
  await settle();
  expect(prompt.value).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);
  expect(mounted.calls.at(-1)?.goal.prompt).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);
});

/**
 * The catalogue is a network request to somebody else's service, so it happens when a person
 * asks for it and not when the settings tab is opened.
 */
it('loads the model catalogue only when the picker is opened, twenty at a time', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  expect(mounted.modelPages).toEqual([]);

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
  // Newest first, which is the whole point of the ordering.
  expect((doc.querySelector('.goal-model .goal-model-name') as HTMLElement).textContent).toBe('Model 0');
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('45');

  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  // Nothing left to page, so the control stops offering.
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);
});

/**
 * "Load 20 more" is the deliberate way to ask for the next page. Scrolling to the bottom of
 * the list is the way people actually ask, and it did nothing at all: the list simply ended
 * at twenty with four hundred still to come and no sign that there was a button below it.
 *
 * The repaint is the other half. The list is rebuilt whole on every page, and emptying an
 * element scrolls it back to the top — so even once it paged, the reader was thrown back to
 * the newest model, which is the one they had just scrolled away from.
 */
it('pages the catalogue in as the list is scrolled, without losing the reader\'s place', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // jsdom does no layout, so the box has to be described: a 260px window onto a list whose
  // height follows the number of rows actually in it, the way the real one does.
  const list = doc.getElementById('goalModelList')!;
  Object.defineProperty(list, 'clientHeight', { value: 260, configurable: true });
  Object.defineProperty(list, 'scrollHeight', {
    get: () => list.querySelectorAll('.goal-model').length * 50,
    configurable: true
  });
  Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true });
  const scroll = (top: number): void => {
    (list as unknown as { scrollTop: number }).scrollTop = top;
    list.dispatchEvent(new mounted.window.Event('scroll'));
  };

  // Halfway down twenty rows: nothing is asked for.
  scroll(300);
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // At the end of them: the next twenty arrive without the button being touched.
  scroll(740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  // And the list is still where it was left, not back at the newest model.
  expect(list.scrollTop).toBe(740);

  // Forty rows is 2000px now, so arriving at the end again pages in the last five.
  scroll(1740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);

  // Nothing left to page: scrolling on does not ask OpenRouter again.
  const spent = mounted.modelPages.length;
  scroll(2200);
  await settle();
  expect(mounted.modelPages).toHaveLength(spent);
});

/**
 * A closed picker measures zero in every direction, which reads as "scrolled to the end".
 * Left unguarded, every repaint of the settings sheet would page the whole catalogue in
 * behind a panel nobody has open — hundreds of models, on somebody else's service.
 */
it('never pages the catalogue while the picker is closed', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);

  // Close it again, then push a fresh state through: applyGoal repaints the list.
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  expect(doc.getElementById('goalModels')!.hidden).toBe(true);
  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();

  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
});

/** Choosing one stores it verbatim: the id is what OpenRouter wants, not a display name. */
it('saves the chosen model id', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(3));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  (doc.querySelectorAll('.goal-model')[1] as HTMLButtonElement).click();
  await settle();

  expect(doc.getElementById('goalModelName')!.textContent).toBe('vendor1/model-1');
  expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: 'vendor1/model-1' });
});

it('saves GLM High and Max from catalogue-specific options and drops unsupported levels on model selection', async () => {
  const glm = { id: 'z-ai/glm-5.3', name: 'GLM 5.3', created: 100, contextLength: 200000,
    reasoning: { supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'max', mandatory: true } };
  const plain = { id: 'plain/model', name: 'Plain', created: 1, contextLength: 1000 };
  const mounted = await mountChat({ hasGoalKey: true }, [glm, plain]);
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  (doc.querySelector('[data-model="z-ai/glm-5.3"]') as HTMLButtonElement).click();
  await settle();
  const select = doc.getElementById('goalReasoning') as HTMLSelectElement;
  expect([...select.options].filter(option => !option.disabled).map(option => option.value)).toEqual(['default', 'max', 'high', 'low']);
  for (const reasoning of ['high', 'max']) {
    select.value = reasoning;
    select.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
    await settle();
    expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: glm.id, reasoning });
  }
  (doc.querySelector('[data-model="plain/model"]') as HTMLButtonElement).click();
  await settle();
  expect([...select.options].map(option => option.value)).toEqual(['default']);
  expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: plain.id, reasoning: 'default' });
});

it('loads supported levels for the saved model without paging to its catalogue row', async () => {
  const selectedModel = { id: 'saved/model', name: 'Saved', created: 1, contextLength: 200000,
    reasoning: { supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'max', mandatory: true } };
  const mounted = await mountChat({}, [], {
    listGoalModels: async () => ({ ok: true, data: { models: [], total: 500, selectedModel } })
  }, { model: selectedModel.id, reasoning: 'high' });
  const select = mounted.window.document.getElementById('goalReasoning') as HTMLSelectElement;
  select.focus();
  await settle();
  expect(select.value).toBe('high');
  expect(select.selectedOptions[0]?.disabled).toBe(false);
  expect([...select.options].map(option => option.value)).toEqual(['default', 'max', 'high', 'low']);
  expect(mounted.calls).toHaveLength(0);
});

/** A provider that cannot be reached says so and changes nothing about what is in use. */
it('keeps the model in use when OpenRouter cannot be reached', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(2));
  const doc = mounted.window.document;
  (mounted.window as any).api.listGoalModels = () => Promise.resolve({ ok: false, error: 'offline' });

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('unchanged');
  expect(doc.getElementById('goalModelName')!.textContent).toBe('deepseek/deepseek-v4-flash');
});

it('edits a fresh Goal before first send and clears it on an independent New Chat', async () => {
  const sendInput = vi.fn(async () => ({ ok: false, error: 'test delivery stopped' }));
  const mounted = await mountChat({}, [], { sendInput,
    getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['none', 'high', 'xhigh'] }] } }),
    draftGoalOpening: async () => ({ ok: true, data: { reply: 'Generated opening', model: 'fixture' } })
  });
  const w = mounted.window, doc = w.document;
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  expect(doc.getElementById('sessionControls')!.hidden).toBe(false);
  (doc.querySelector('[data-mode="goal"]') as HTMLButtonElement).click();
  const objective = doc.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Build and verify the requested feature';
  objective.dispatchEvent(new w.Event('input', { bubbles: true }));
  (doc.getElementById('saveSessionObjective') as HTMLButtonElement).click();
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({ text: 'Generated opening', sessionId: null, automation: 'goal', objective: 'Build and verify the requested feature' }));
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Start with the existing code';
  doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null, automation: 'goal', objective: 'Build and verify the requested feature' }));
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  expect(objective.value).toBe('');
});

it('keeps a switch changed while its save is pending after focus moves and an older state arrives', async () => {
  let release!: () => void; const calls: any[] = [];
  const mounted = await mountChat({}, [], { saveSettings: (patch: any) => {
    calls.push(structuredClone(patch));
    const answer = { ok: true, data: { ...mounted.state, config: { ...mounted.state.config, ...structuredClone(patch) } } };
    if (calls.length === 1) return new Promise(resolve => { release = () => resolve(answer); });
    return Promise.resolve(answer);
  } });
  const w = mounted.window;
  const developer = w.document.getElementById('developerMode') as HTMLInputElement;
  const background = w.document.getElementById('backgroundChats') as HTMLInputElement;
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, developerMode: false } } });
  developer.focus(); developer.checked = true; developer.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  developer.blur(); background.focus();
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, developerMode: false } } });
  expect(developer.checked).toBe(true);
  background.checked = true; background.dispatchEvent(new w.Event('change', { bubbles: true }));
  release();
  await vi.waitFor(() => expect(calls).toHaveLength(2)); await settle();
  expect(calls[1].ui.developerMode).toBe(true);
  expect(developer.checked).toBe(true);
});
